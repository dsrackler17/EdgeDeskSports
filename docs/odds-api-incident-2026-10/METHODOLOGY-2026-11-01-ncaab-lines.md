# Methodology change — men's college basketball (NCAAB) known to the odds gateway (2026-11-01)

**Type:** a change to the odds gateway's sports allowlist (AGENTS.md §3: the
gateway's budget and bypass guards are integrity-protected). It is its own
pull request and needs explicit review before it merges. **Nothing it adds can
spend.** The sport is registered **disabled**. The owner turns it on after the
merge (step 2 below).

## Why

Two men's college basketball research models price games with no sportsbook
price at all:

- NCAAM-FORECAST (`basketball/ncaam_forecast`, on `main`);
- the early-season model NCAAM-EARLY being built in `basketball/ncaam_early`.

Neither can be graded against the market, show a market comparison, or ever
claim value until NCAAB prices are captured from the first game of the season
onward. Today `basketball_ncaab` has no row in `public.odds_api_sports`, so
`odds_api_acquire` answers `denied_sport` (`CBB_MODEL_NOTES.md` §2: "no NCAAM
market is captured"). The season opens 2026-11-02. A close that was not
captured cannot be recovered later.

On 2026-11-01 the owner approved buying NCAAB main markets at about 2,000
credits a month, capturing DraftKings, Pinnacle (if the plan returns it) and
the other books already in the default list.

## What changes

**New `supabase/ncaab_odds_sport.sql`**, idempotent and pasteable, with a
byte-identical migration mirror,
`supabase/migrations/20261101120000_ncaab_odds_sport_row.sql`:

1. It registers `basketball_ncaab` in group `ncaab`, **disabled**, at priority
   4, the same as the NBA and the NHL. A row that exists, enabled or not, is
   left exactly as it is.
2. **It adds no cadence row.** The group has none of its own, so the gateway's
   `'*'` bands apply, the same as football's:

   | Hours to the league's next start | Minutes between purchases |
   |---|---|
   | ≤ 3 | 60 |
   | ≤ 24 | 60 |
   | ≤ 72 | 120 |
   | beyond | 360 |

   The NBA and the NHL use 120 minutes inside 24 h
   (`METHODOLOGY-2026-10-29-nba-nhl-lines.md`). Hourly is the gateway's default,
   and it fits the approved budget. NCAAB tips go off through the whole day,
   so the board is bought about hourly on a game day either way. The close
   graded against is then at most 60 minutes old, not 120. The early-season
   model's evaluation is CLV.
3. The report: the row, its priority, no own cadence rows, and the band for
   each category at 1, 10, 48 and 200 hours.

**`tools/odds/ncaab_odds_sport_sql.test.js`** (new, 22 checks, real PostgreSQL):

- the file is pasteable and never turns anything on;
- the mirror is a byte copy;
- while disabled, nothing is bought;
- once enabled, capture's `featured` and close's `close` share one fingerprint,
  so there is one board;
- a board 30 minutes old is a cache hit; one 65 minutes old is bought;
- props are never bought;
- under pressure the sport is shed with the NBA;
- an operator's enable is kept on re-apply.

**`tools/odds/no_bypass.test.js`:** one new check, that the NCAAB row is
created disabled, as for the NHL and college baseball. No other check changed.

**`.github/workflows/odds-gateway-tests.yml`** runs the new suite.
**`.github/workflows/deploy-odds-gateway.yml`** gets a new input,
`apply_ncaab_sport` (default on), which applies the file after the NBA/NHL
lines. The new suite joins the suites that must pass before anything ships.

**Not changed:**

- the breaker, the budget, the reserve and the daily allowance;
- every category, its daily cap and the shedding levels;
- every cadence row, and the hourly floor;
- capture, close, the gateway function and their code;
- schedules and jobs;
- the qualification rules and edge floors.

## What one purchase is

- **One board per purchase.** Capture asks the gateway for category
  `featured`, and the gateway's grant names the endpoint, markets and books.
  For NCAAB it is `/odds` with h2h, spreads and totals and the default 10-book
  list (pinnacle, betonlineag, draftkings, fanduel, betmgm, williamhill_us,
  betrivers, bovada, espnbet, hardrockbet). That bills as 3 markets × 1 region
  ≈ **3 credits, whatever the number of games**.
- **Not bought for NCAAB:**
  - Alternates and player props are football-only in capture
    (`supabase/functions/capture/index.ts`, the alternate-ladder and props
    passes check for the `nfl` or `ncaaf` group).
  - The `props` category has no band for any group but `nfl` and `ncaaf`.
- **Pinnacle is not verified.** It is in the list the grant names, but whether
  the plan returns Pinnacle prices for NCAAB is only known from the first
  stored board. Check `odds_api_snapshots` after step 2.

## Budget effect

- **Ceiling:** at most 24 purchases a day × 3 credits = 72 a day. That is
  about **2,160 credits a month** in season, the approved ~2,000.
- **On a day with no games**, the board is empty and the provider bills
  nothing.
- **The season** runs from 2026-11-02 to early April, about 5 months: at most
  about 11,000 credits in all.

Against the November budget (INCIDENT.md §8, and the NBA/NHL note's table):

| | Credits a month |
|---|---|
| Existing paths, expected | 30,000–42,000 |
| Research pipeline ceiling (the 2026-10-26 category caps) | ≤ 5,580 |
| NBA and NHL lines (2026-10-29) | ≤ 2,160 |
| **This change** | **≤ 2,160** |
| Worst case together | ≤ 51,900 |

That is inside the 57,000 breaker latch and the 60,000 operational ceiling.
The 40,000 reserve is untouched.

## What else changes once it is on

**Shedding.** At priority 4, NCAAB is shed first, with the NBA and the NHL.
Past 60% of a day's allowance a stale NCAAB board is not re-bought that day.
Stored prices keep serving, labelled with their age.

**Signals on the board and record.** Once capture prices NCAAB, its lines
qualify under capture's generic edge floors, the ones MMA, MLB, the NBA and
the NHL use. **NCAAB flags would then appear on the terminal's board and
record, from a slate of hundreds of games a week.** This is the gateway's
existing behaviour for every captured sport. It is stated here so the owner
decides with it in view. If NCAAB should be captured for research and close
grading only, that needs a capture change, made in its own pull request.

**Close.** `close` prices whatever sports have pending signals, one gateway
`close` call per sport. That call shares the `featured` fingerprint, so it
usually costs nothing. Its pending-row limit is 5,000, and nothing in it
depends on how many games there are.

**Kalshi** (`KXNCAAMBGAME`, `KXNCAAMBSPREAD`, `KXNCAAMBTOTAL` exist) is not
part of this change. `kalshi_sync` accepts only NFL and CFB, enforced by a
database check constraint. Adding NCAAB touches market contract matching and
is its own pull request.

## Operator steps (after merge)

1. **Apply the file.** Run Actions → Deploy odds gateway. It applies the file
   by default; untick the other inputs if nothing else should ship. Or paste
   `supabase/ncaab_odds_sport.sql` into the SQL editor. Every report row
   should read `ok`.
2. **Turn the sport on.** This is the spend switch:

   ```sql
   select public.odds_api_set_sport('basketball_ncaab', true);
   ```

   `{"ok": false, "reason": "unknown sport"}` means step 1 has not run.
3. **Make capture ask for it.** Capture asks only for the sports in its
   `CAPTURE_SPORTS` secret (Supabase → Edge Functions → Secrets), which this
   repository does not hold. Add `basketball_ncaab` there, keeping every key
   already in it. The next capture run prints `sports_list`, which should
   include it.
4. **Watch the first game day** on `admin/odds-usage/`:
   - about 24 purchases and 72 credits for NCAAB;
   - capture's `per_sport` should price NCAAB games;
   - the stored board shows which books answered, including whether
     Pinnacle did.

**To withdraw:** `select public.odds_api_set_sport('basketball_ncaab', false);`.
Nothing more is bought, and stored rows stay.
