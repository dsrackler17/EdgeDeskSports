# CFB external providers: policy, retries, circuit breakers, schema contracts

Assume every provider fails. `football/cfb_lab/providers.js` holds one register and one behaviour for all of
them. `supabase/functions/capture/index.ts` applies the same rules to the Odds API calls it makes, because the
edge function imports nothing.

## 1. The register (`providers.POLICIES`)

| provider | importance | timeout | retries | rate limit | expected latency | fallback | stale threshold | breaker |
|---|---|---|---|---|---|---|---|---|
| ESPN scoreboard (lab: schedule, one book's lines, results) | CRITICAL | 30 s | 2 | unpublished; ≤ 12 calls/h | 1.5 s | results: cfbfastR, then the record file; odds: CFBD + Odds API | odds 6 h (≤ 48 h to kickoff) / 36 h; schedule 26 h | 3 failures → 60 min |
| cfbfastR schedule CSV (second result source) | HIGH_VALUE | 60 s | 2 | GitHub raw, 1 call/h | 3 s | ESPN alone; nothing settles on a disagreement | results 48 h | 3 → 120 min |
| The Odds API (via capture) | CRITICAL | 20 s | 0 in capture (a retry is a second billed call; the next run is the retry), 2 in the lab | paid quota, `x-requests-remaining` logged | 1.2 s | ESPN + CFBD; with neither the market is MARKET_STALE and no BET is possible | 6 h / 36 h; 3 h for a BET | 3 → 30 min |
| Supabase PostgREST (mirror, Odds API pull) | HIGH_VALUE | 30 s | 3 | ≤ 500 rows/request | 0.8 s | the repository ledger is complete on its own | as Odds API | 3 → 30 min |
| CollegeFootballData API (V2 weekly, Python) | CRITICAL | 60 s | 3 | API-key tier, batched by week | 2.5 s | hold the weekly update; never advance on missing PBP | PBP 8 days | 3 → 60 min |
| Availability reports (football/availability) | HIGH_VALUE | 30 s | 1 | per site, daily | 3 s | last known status, marked stale; never assumed healthy | QB / injury 72 h | 3 → 240 min |
| Weather (football/venues) | OPTIONAL | 20 s | 1 | free tier, daily | 1 s | omit; never blocks | 12 h | 5 → 240 min |

Required fields are listed per provider in `POLICIES[p].required` and enforced by the validators in §4.

**Ownership.** The CFBD API and availability rows document the policies of fetchers owned elsewhere: the
weekly Python pipeline and `football/availability/`. Their code applies them there. The lab and the capture
function implement the other rows.

## 2. Bounded retries (`classify`, `withRetry`)

| class | retried | examples | shared taxonomy code (`football/cfb_production/taxonomy.js`) |
|---|---|---|---|
| TIMEOUT | yes | AbortError, "timed out" | PROVIDER_TRANSIENT |
| NETWORK | yes | ECONNRESET, ECONNREFUSED, "fetch failed" | PROVIDER_TRANSIENT |
| TRANSIENT | yes | 408, 425, 5xx | PROVIDER_TRANSIENT |
| RATE_LIMIT | yes, honouring `Retry-After` up to the policy cap | 429 | PROVIDER_RATE_LIMIT |
| AUTH | never | 401, 403 | AUTH |
| PERMANENT | never | 400, 404, 422 (malformed request) | PROVIDER_REJECTED |
| SCHEMA | never | not JSON, required field missing | PROVIDER_SCHEMA |
| UNKNOWN | never | anything else | UNKNOWN |

**Backoff.** Attempt *i* waits `min(max, base × 2^i)`, jittered into [50%, 100%]. Each provider's
`[base, max]` is at most `[2 s, 30 s]` and retries are at most 3. The error that finally surfaces carries its
class, the attempt count and every attempt's class and wait. Each class is logged distinctly: provider
incidents carry `error_class` and `error_code`.

## 3. Circuit breakers (`Breaker`, `guarded`)

- **CLOSED → OPEN** after N consecutive failures of any class (a repeated 401 opens it too).
- **OPEN**: the provider is not called at all. The call reports `CIRCUIT_OPEN` and the last error.
- **HALF_OPEN** after the cooldown: one trial call.
  - A success closes the breaker.
  - A failure re-opens it with a doubled cooldown, capped at 24 h.
- **State** is a plain object persisted by the lab in
  `football/cfb_lab/reports/<season>/provider_health.json`. It is written by `run.js` when not offline, so a
  failing provider is not hammered hour after hour.
- **Last known valid data** is the stored ledger. It is kept and simply ages: the market becomes
  MARKET_STALE (MARKET_INTEGRITY.md §8), results wait, and nothing is ever filled in.
- **The capture function** has no persisted breaker. It runs statelessly on pg_cron:
  - it gives every provider call a 20 s deadline (`ODDS_TIMEOUT_MS`);
  - it reports 401 / 422 / 429 distinctly, as before;
  - it lets the next scheduled run be the retry.

  A database-backed breaker for capture is a recommended follow-up. The quota is the cost of not having one.

**Where the guard is used in the lab:**
- `market.fetchEspn`: every date, with the breaker shared across dates. A 5xx storm stops after 3 dates
  (tested).
- `settle.run`: the cfbfastR schedule, and ESPN for results.

## 4. Schema validation (never read a missing field as zero)

| provider | validator | an element is rejected when | what happens |
|---|---|---|---|
| ESPN scoreboard | `validateEspnScoreboard(json, {use})` | quotes: no id, no state, not exactly one home and one away, no team abbreviation with odds (the line cannot be oriented). Results: no completed flag or status name, or a FINAL without both scores | the event is dropped; the problems are logged in `last_run.json` (`market.log.espn.schema`, `settle.espn_schema`); the other events still count; a payload without `events[]` is rejected whole; an HTML error page is a SCHEMA failure, never retried |
| The Odds API | `validateOddsApiEvents`; capture's `cfbLabQuotes` + `strictNum` | no id / commence_time / teams; home = away; an outcome without a name; a price that is not a decimal > 1; a spread or total outcome without a numeric `point` | the event or market is skipped and counted (`cfb_lab.skipped`). A `null` point is skipped as "spread point missing (schema: never read as 0)". Before this change `Number(null) === 0` turned a dropped point into a pick'em spread or a total of 0 |
| Capture main board (all sports) | `priceEvent` | a spreads/totals market whose outcomes do not all carry a numeric point | counted as malformed (previously a handicap market with all points null was priced as a two-way market without a line) |
| CFBD line ledger | `validateCfbdLineRow` | no game_id, no observed_at, a line that is not a number, no line at all | the row is skipped; the count and problems are logged (`market.log.cfbd`) |
| cfbfastR schedule | `validateCfbfastrHeader` | a required column is missing (renamed feed) | the source is not read this run (`settle.cfbfastr_error: SCHEMA ...`); ESPN alone can settle only games cfbfastR does not carry |

**Contract tests.** Representative fixture payloads live in `football/cfb_lab/fixtures/providers/`:
- ESPN: pregame (home favourite, road favourite, pick'em, neutral site, in-progress), results (final,
  double-overtime final, postponed, canceled 0-0, suspended-but-completed), schema drift, and an HTML error
  page;
- The Odds API: clean, schema drift and impossible values;
- the CFBD ledger and the cfbfastR CSV, each clean and drifted.

`football/cfb_lab/providers.test.js` (69 checks) runs them through the validators and the real parsers. It
also checks that the capture function's copy of the quote rules reproduces the shared integrity cases.

## 5. Chaos behaviour (tested)

| failure | behaviour |
|---|---|
| provider timeout | aborted at the policy timeout, retried within the bound, then reported `TIMEOUT`; the breaker records it |
| ESPN down | bounded retries per date, then the breaker opens; stored quotes age into MARKET_STALE; no BET |
| schema drift | the element is rejected and logged; nothing is zero-filled |
| 429 with Retry-After: 120 | waits at most the policy cap (8 s), never 120 s inside an hourly job |
| repeated 401 | not retried; the breaker opens; logged as AUTH |
