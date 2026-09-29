# Player Props — price freshness, recovery and health

This is the contract between the sportsbook price pipeline and every number
the Props page shows. It exists because on 2026-09-29 the page sat on
"Sportsbook prices: STALE" for hours, with every row reading *no executable
price*, and nothing said why.

## What went wrong on 2026-09-29

The page was accurate. The pipeline behind it could not keep a price current:

1. **The scheduler did not fire.** The hourly Player props workflow
   (`23 * * 8-12,1 *`) ran on schedule twice in eight hours: at 08:42 and at
   15:59 UTC. Two manual runs came in between. GitHub's scheduler has skipped
   hours in this repository since 2026-09-13; see
   `supabase/functions/editorial_cron`, which moved the editorial system off
   it for the same reason. The props pipeline had no other scheduler.
2. **The capture cadence could not meet the decision limit.** Each game was
   re-polled at most every 8 h beyond 36 h of kickoff and every 3 h inside it.
   The kernel refused any quote older than 90 minutes. So even a perfectly
   fired hourly job left most prices undecidable most of the time. The 15:59
   run logged `no event due … last polled 13:25` for both leagues, then
   rebuilt the board and correctly judged all 3,350 props `STALE_QUOTE`.
3. **Refresh did not refresh.** The button re-fetched the same `board.json`.
4. **Freshness was decided in four places.** These were the kernel, the page
   (a hard-coded `age > 90`, three times), the opportunity layer and the AI
   desk. The opportunity layer's check read only `STALE` and would have kept
   a newer `EXPIRED` quote as a BET.
5. **Nothing recorded why.** The state file said what the last capture did,
   not whether the scheduler, the provider, a game or a book was the cause.
6. **Injury age was shown and never judged.** The report was week 3, the games
   were week 4, and the page said nothing.

## The one rule

`lib/edgedesk_props.js` → `FRESHNESS`, `quoteFreshness`, `isExecutableQuote`.
Every EV, edge, decision, stake and best-price selection asks
`isExecutableQuote()`. That covers the build, the page, the AI desk
(`football/props/desk.js`, inlined into `edgedesk_ai`) and the opportunity
layer. No other file keeps an age limit, and `tools/props/props_freshness.test.js`
enforces that.

A quote's **age** is measured from EdgeDesk's capture time, when the provider
was asked and answered. The provider's `last_update` only says when the book
last changed the price, so it is not used for age.

| State | Age (default) | Executable |
|---|---|---|
| FRESH | ≤ 15 min | yes |
| AGING | ≤ 30 min | yes |
| STALE | ≤ 90 min | no (reference only) |
| EXPIRED | > 90 min | no (reference, history) |
| FUTURE / UNKNOWN | clock fault / no time | no |

`isExecutableQuote(q, ctx)` returns `executable: false` with a reason for any of:

- `INVALID_PRICE` or `INVALID_LINE`;
- `CLOCK_FAULT` or `UNKNOWN_TIME`;
- `GAME_CANCELLED` or `GAME_STARTED`;
- `MARKET_CLOSED` or `BOOK_SUSPENDED`;
- `STALE` or `EXPIRED`.

A *later* failed poll does not invalidate a quote still inside the window,
because the quote was a real, observed price. The age limit is what bounds it.

The thresholds are configurable: `PROPS_FRESH_MIN`, `PROPS_AGING_MIN`,
`PROPS_STALE_MIN` and `PROPS_EXEC_MAX_MIN`. The build writes the effective
values onto the board as `board.freshness`, so the page and the desk judge by
the build's numbers. `supabase/player_props_pipeline.sql` mirrors the window
(`player_props_executable_max_minutes()`), and a test pins the two equal.

## Model opinion vs. the current market

A prop with no executable price keeps its research. Only the price-dependent
numbers wait.

| Stays | Waits |
|---|---|
| projection (raw; not blended with an expired market) | best executable price |
| fair line, fair odds at the last line (`at_reference`) | no-vig probability |
| confidence, sample, role, matchup, history, validation | EV, edge |
| the last prices seen, with book and age (`last_seen`) | stake, BET / LEAN / WATCH |

The decision stays `NO_DECISION`, so every consumer treats it as
non-actionable. It carries a code saying what it waits for, and a label:

| Code | Label | Meaning |
|---|---|---|
| `STALE_QUOTE` | WAIT FOR PRICE | quotes exist, none inside the window |
| `NO_CURRENT_QUOTE` | WAIT FOR PRICE | the game has not been price-checked yet |
| `PROVIDER_FAILURE` | WAIT FOR PRICE | the last check of this game failed, nothing current |
| `NO_MARKET` | NO MARKET | a successful check found no book offering it |
| `MARKET_CLOSED` | MARKET CLOSED | a book dealt it and has pulled it |
| `GAME_STARTED` | GAME STARTED | kickoff has passed |

`priceStatus()` also reports `ONE_SIDED` (only the Over, or only the Under).
Such a prop is priced but capped at LEAN, because there is no no-vig anchor.

Historical best prices are kept for CLV and history in `lines.json`,
`closes.jsonl`, the Supabase ledger and `player_prop_best_quotes`. They are
never executable. `player_prop_executable_quotes` is the current one.

## Cadence: who is polled, and how often

Each game keeps its own clock, set by `FRESHNESS.cadence` (`PROPS_CADENCE`
overrides it):

| Hours to kickoff | Re-poll every |
|---|---|
| ≤ 1.5 h | 15 min |
| ≤ 6 h | 30 min |
| ≤ 24 h | 60 min |
| ≤ 48 h | 2 h |
| beyond | 6 h |
| started | never (pregame only) |
| final | archived to `closes.jsonl` |

Games far from kickoff are checked less often by design, to save credits.
Between checks their last prices are reference only. The page says this once,
and **Refresh prices** captures current ones on demand.

Credit pacing: below `PROPS_LOW_CREDITS` (5,000), games more than 6 h out are
polled half as often. Below `PROPS_CRITICAL_CREDITS` (1,500), only games
inside 6 h are polled. The hard floor and the per-run cap are unchanged.

## Recovery

`football/props/capture.js`:

- **Isolation.** Each game is its own request, its own failure and its own
  record (`events_state`). A failed game never stops the others, and every
  successful game is committed.
- **Retry inside the run.** A timeout, network error, malformed body or 5xx is
  retried once after 1.5 s ± jitter. A 4xx is an answer and is not retried.
- **Back-off.** A failed game is next due at 5, 10, 20, 40, then 60 min, ± 20 %
  jitter. That is sooner than its cadence, and honoured exactly. A success
  resets it.
- **429.** The run stops, and nothing is asked again until `Retry-After` has
  passed (or 15 min without one). That includes manual refreshes, which are
  told until when.
- **Partial answers.** A book missing from an answer keeps its last quotes at
  their own capture time. They age out of the window and drop from the
  current listing past the stale band. The books that answered are current.
- **Market closed.** A (player, market) that the answering books stopped
  dealing is recorded with when it disappeared.
- **Suspect empty answers.** An empty answer where the last poll had prices is
  not believed at once. The listing is kept and the game is retried. A second
  empty answer is believed.
- **Idempotency.** Workflow runs are serialized (`concurrency: player-props`).
  A listing is never replaced by an older one. The dispatcher debounces.
  Refresh admission is atomic (`player_props_refresh_admit`, advisory lock).
- **Data quality.** The capture refuses and counts, never repairs:
  - impossible odds, and out-of-range or non-half lines;
  - team or defense entities in player markets;
  - conflicting duplicate outcomes (both refused);
  - reversed ladders;
  - provider stamps in the future;
  - answers for the wrong event id.
- **Archival.** A game 4 h past kickoff moves its movement series to the
  append-only `closes.jsonl`, even on a run that polls nothing.

## Who wakes it

1. **Primary:** pg_cron runs every 5 min (`supabase/player_props_cron.sql`) →
   `supabase/functions/props_cron`. It reads `player_props_pipeline_health` and
   dispatches `player-props.yml` only when:
   - a game is due (`next_due_at`);
   - a reader's refresh is waiting; or
   - the health record has been quiet for `PROPS_FALLBACK_MIN` (60).

   It debounces 240 s against its last dispatch.
2. **Backup:** the workflow's own cron, every 15 min in season. A run with
   nothing due spends nothing, and rebuilds only if the board is more than
   50 min old.
3. **A reader:** **Refresh prices** → `props_cron {action: 'refresh'}` (see
   below).

## Refresh prices

1. POST `props_cron {action: 'refresh', league}` with the reader's session.
   It is verified by Supabase Auth and admitted atomically. The cool-downs are
   one per reader per 5 min and one for everybody per 2 min. A second click
   joins the refresh in flight.
2. The workflow is dispatched with `force_capture`, `refresh_request` and the
   leagues. A forced capture re-asks every game not captured in the last
   10 min.
3. The page shows *Refreshing prices…* with the button disabled. It polls
   `{action: 'status'}`, then reloads `board.json?t=…` past the CDN cache
   until the board carries the new capture.
4. It then says what happened:
   - *Fresh prices captured (N quotes)*;
   - nothing to re-buy;
   - *rate-limiting until …*;
   - *Try again in N min*;
   - *Sign in*; or
   - why the refresh failed.

## Health

`EDProps.systemHealth()` is computed by the capture after each run and by the
page at view time:

| State | When |
|---|---|
| HEALTHY | ≥ 95 % of active games were checked inside their cadence target (+15 min), with no failures |
| DEGRADED | some games or books failed, or 50–95 % on target. Current prices are still shown where they exist |
| DELAYED | fewer than 50 % on target |
| OUTAGE | fewer than 50 % on target **and** one of: the provider is refusing (401 / 429), the capture is failing, or no check has run for 60 min past when one was due. Capture switched off or no key is always OUTAGE |

The page also counts the prices that are executable right now. When the
pipeline is on schedule but fewer than half the rows are executable, because
games are far out and between checks, the strip reads *between scheduled
checks* and one calm note explains it.

## What an operator reads

- `football/props/<league>/capture_state.json` (schema v3) holds:
  - `status`, `reason`, `why`;
  - `events_state` (each game's last success, attempt, failures and next due);
  - `provider` (last HTTP, `rate_limited_until`, consecutive failures, credits);
  - `health`, `next_due_at`, `pacing`, `refused`, `requests`.
- `player_props_pipeline_runs` has one row per run and league:
  - games requested, succeeded and failed;
  - markets, quotes received and usable, refused counts;
  - provider HTTP, rate limit, credits, duration, consecutive failures;
  - health, error and next due.
- `player_props_pipeline_health` holds the latest verdict per league, when
  the next capture is due, and the scheduler's last tick and dispatch.
- The Player props run's step summary is a table with the same fields.

```sql
select league, health, health_reason, last_success_at, next_due_at, rate_limited_until, last_error, scheduler_action, scheduler_tick_at
  from player_props_pipeline_health;
select started_at, league, trigger, status, reason, events_requested, events_failed, quotes_usable, provider_http, duration_ms, error_message
  from player_props_pipeline_runs order by started_at desc limit 20;
```

## Injury freshness

`EDProps.injuryFreshness()` classifies the report's age:

| State | Age | Confidence factor |
|---|---|---|
| CURRENT | ≤ 8 h | × 1.0 |
| AGING | ≤ 24 h | × 0.9 |
| STALE | older | × 0.7 |

A STALE report is also flagged `INJURY_DATA_STALE`. It counts as open
uncertainty, which caps any stake. The strip shows the report's week, age and
state. When the report predates the games' week, it says the availability is
unconfirmed.
