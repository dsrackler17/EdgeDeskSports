# Runbook — Player Props

## What it is

The **Props** tab (`#playerprops`) is a player-prop research terminal for the
NFL and college football. For each prop it shows:

- a projection, a full distribution and fair odds;
- the no-vig market and price shopping across books and alternate lines;
- EV at the exact price, and BET / LEAN / WATCH / PASS / NO DECISION with a
  conservative unit size.

Every number the page shows comes from one kernel, `lib/edgedesk_props.js`
(`EDProps`). The build and the browser run that same `evaluate`.

| Piece | File |
|---|---|
| Kernel: odds, distributions, EV, decisions, units, grading | `lib/edgedesk_props.js` |
| Page | `lib/edgedesk_props_ui.js`, `lib/edgedesk_props.css` |
| Data (NFL: nflverse; CFB: sportsdataverse ESPN box + cfbfastR) | `football/props/sources/nfl.js`, `cfb.js` |
| Projection engine | `football/props/model.js` |
| Price capture (The Odds API) | `football/props/capture.js` |
| Board build | `football/props/build_board.js` |
| Distribution backtest | `football/props/backtest.js` |
| Grading and performance | `football/props/grade.js` |
| Supabase ledger copy | `football/props/sync_supabase.js`, `supabase/player_props.sql` |
| Reader watchlist | `supabase/player_props_watchlist.sql` |
| Freshness, executability, health (the one rule) | `lib/edgedesk_props.js` `FRESHNESS` · `docs/player-props/FRESHNESS.md` |
| The job (capture → board → grade → commit) | `.github/workflows/player-props.yml` |
| Its primary scheduler and "Refresh prices" | `supabase/functions/props_cron`, `supabase/player_props_cron.sql` |
| Health record, run log, refresh requests | `supabase/player_props_pipeline.sql`, `football/props/health_sync.js` |
| Deploying the scheduler and its SQL | `.github/workflows/deploy-props-pipeline.yml` |
| PR suites | `.github/workflows/player-props-tests.yml` |

The design and its formulas are in `docs/player-props/DESIGN.md`. The audit
behind them is in `docs/player-props/AUDIT.md`. Freshness, recovery and
health are in `docs/player-props/FRESHNESS.md`.

## Turn prices on

Without prices the board is honest but incomplete. It shows EdgeDesk
projections and fair lines, every prop reads **NO MARKET**, and nothing gets
an EV or a decision. To capture prices:

1. **Add the repository secret `ODDS_API_KEY`** (Settings → Secrets and
   variables → Actions). This is the same key the CFB alternates capture uses
   (`READ_ALT_CAPTURE`), so both draw on one credit balance.
2. **Set the repository variable `PROPS_CAPTURE` to `on`.** `on`, `true`,
   `1` and `yes` in any case all count. Anything else, unset included, means
   the capture spends nothing and records `NOT_RUN`. The workflow maps both
   into the capture step's environment explicitly (repository variables and
   secrets are not shell variables on their own), and the step always runs:
   its log opens with `ODDS_API_KEY present: true|false`,
   `PROPS_CAPTURE raw: "…"` and `PROPS_CAPTURE parsed enabled: true|false`.
   The key itself is never printed.
3. Optionally, **tune the budget** with the repository variables below.
4. Run **Actions → Player props → Run workflow** once. GitHub's scheduler
   skips hours on this repository (it fired the old hourly schedule twice in
   eight hours on 2026-09-29), so it is only the backup. Set up the primary
   scheduler (below).
5. **Set up the primary scheduler**, once:
   - `supabase secrets set PROPS_GH_TOKEN=<token with actions:write on this repository>`.
     `EDITORIAL_GH_TOKEN` is used if it is unset.
   - Run **Actions → Deploy player props pipeline** (deploy `props_cron`, apply
     `supabase/player_props_pipeline.sql`). Or deploy by hand with
     `supabase functions deploy props_cron`, and paste the SQL.
   - Paste `supabase/player_props_cron.sql` into the SQL editor. It needs
     pg_cron and pg_net, plus the two `edgedesk.*` database settings that
     `supabase/editorial_cron.sql` documents.

   Its report says `ok`. From then on, pg_cron pokes `props_cron` every five
   minutes, and it runs this workflow only when a game is due for a price
   check or a reader presses **Refresh prices**.

The page's status strip then changes from *not captured yet* to
*Sportsbook prices: LIVE · captured N min ago*, or to whichever status the
run actually ended in (below).

### What the capture records

Every run writes `football/props/<league>/capture_state.json`, whatever
happens, and the board and page read its `status`:

| Status | Meaning |
|---|---|
| `NOT_RUN` | The capture did not execute: `PROPS_CAPTURE` is off, or no state file has been published. |
| `RUNNING` | A run started and did not finish (it crashed). Never read as success. |
| `SUCCESS` | Every event request answered and prices were written. |
| `PARTIAL` | Prices were written, but a request failed or the run stopped early (budget, credit floor, 401/429). |
| `NO_MARKETS` | The provider answered, but no book has posted a requested player market (`MARKETS_NOT_RELEASED`), or no event kicks off inside the window (`NO_EVENTS_IN_WINDOW`). |
| `ERROR` | Nothing was written: no key, the event index failed, every request failed, a 401/429, or the credit floor. `error_message` has the provider's own answer. |

The state also records, per run: events discovered / in the window / due /
queried, the event ids, each request's HTTP status, books, markets, outcomes,
normalized quotes, cost and remaining credits, the books and markets that
came back, quotes written, credits spent and `x-requests-remaining`. The
step's log prints the same per event, and the run's summary page shows a
table. The board build then logs how many captured quotes were joined to a
game and matched to a player, with examples of unmatched names. Raw quotes
are kept in `quotes.json` before any name is matched.

| Variable | Default | What it does |
|---|---|---|
| `PROPS_WINDOW_H` | 96 | Only events kicking off inside this many hours are asked for. A manual run can override it (`window_h` input). |
| `PROPS_LEAGUES` | `nfl,cfb` | Which leagues to capture. Set `nfl` to leave college unpriced. |
| `PROPS_MARKET_GROUPS` | NFL `core,long,alt`, CFB `core,alt` | Groups from `football/props/config.js`: `core` (11), `long` (3), `td` (4), `alt` (6), `kick` (2), `defense` (3). |
| `PROPS_BOOKMAKERS` | 10 books: eight US books, Pinnacle and BetOnline (`football/props/config.js`) | Up to ten books count as one region. Eleven or more count as two. |
| `PROPS_MAX_CREDITS` | 800 | The most one run may spend, per league. |
| `PROPS_MAX_EVENTS` | 64 | Games per run per league, nearest kickoff first. A manual refresh re-prices a full college Saturday in one run. |
| `PROPS_CADENCE` | `1.5:15,6:30,24:60,48:120,*:360` | Each game's re-poll clock: hours to kickoff : minutes between polls. |
| `PROPS_FRESH_MIN` / `PROPS_AGING_MIN` / `PROPS_STALE_MIN` | 15 / 30 / 90 | Quote age states (FRESH / AGING / STALE; EXPIRED beyond). |
| `PROPS_EXEC_MAX_MIN` | 30 | The oldest a quote may be and still price a RECORDED decision (the ledger, the desk, the opportunity layer). |
| `PROPS_LATEST_MAX_MIN` | 1440 | The Props page decides every prop on its game's newest capture up to this old, and shows each price's age. |
| `PROPS_LOW_CREDITS` / `PROPS_CRITICAL_CREDITS` | 5000 / 1500 | Credit pacing: games more than 6 h out are polled half as often below the first; only games inside 6 h are polled below the second. |

`PROPS_MIN_INTERVAL_H` and `PROPS_FAR_INTERVAL_H` are gone; `PROPS_CADENCE`
replaces both. The capture stops at once on a 401 or 429, when the provider
reports fewer than 200 credits left, and before a run would pass
`PROPS_MAX_CREDITS`. After a 429 nothing is asked, a manual refresh included,
until its `Retry-After` has passed. A failed game is retried on its own
back-off (5, 10, 20, 40, 60 min, ± jitter), sooner than its cadence. The
other games are never held up by it.

### Two captures, one key

There are now two ways to buy prop prices. Both spend the same `ODDS_API_KEY`,
so run one of them, not both.

1. **The Supabase capture function, from build `capture-v11-player-props-r1`
   (`-r2` isolates a game whose answer cannot be priced, instead of losing the
   whole prop pass).**
   - It captures every player quote for NFL and NCAAF events on its DAY and
     NEAR tiers into `player_prop_quotes`, with change-only history in
     `player_prop_quote_ticks`.
   - It is budgeted per run and per event, and stops at a quota floor.
   - Its setup and arithmetic are in `supabase/functions/capture/README.md`;
     its tables are in `supabase/capture_v11_player_props.sql`.
   - `player_prop_executable_quotes` (`supabase/player_props_pipeline.sql`)
     is its best CURRENT price per selection. `player_prop_best_quotes` keeps
     every price, which is history, not an executable price.
2. **The GitHub Actions capture here (`PROPS_CAPTURE=on`).**
   - It writes `football/props/<league>/quotes.json`. The Props page and the
     AI desk read only this path (through `board.json`).
   - It is the capture with the recovery, health record and manual refresh
     in `docs/player-props/FRESHNESS.md`.

**While both run, the key pays twice for NFL and NCAAF props inside 30 hours.**
The page does not read the Supabase capture's prop tables. If the credit
balance matters more than that queryable copy, set `CAPTURE_PLAYER_PROPS=false`
on the capture function; its game lines are unaffected.

### The credit arithmetic

Player markets exist only on The Odds API's per-event endpoint, at one request
per event. The capture budgets each request as markets × regions. The
provider's `x-requests-last` header reports the real cost, and the run counts
that figure.

With the default cadence (`PROPS_CADENCE`), one game is polled about 53 times
from 96 h out to kickoff. Manual refreshes come on top of that, and credit
pacing takes some away:

| Time before kickoff | Re-poll interval | Polls |
|---|---|---|
| 96 h to 48 h | every 6 h | about 8 |
| 48 h to 24 h | every 2 h | about 12 |
| 24 h to 6 h | every 60 min | about 18 |
| 6 h to 90 min | every 30 min | about 9 |
| Last 90 min | every 15 min | about 6 |

| Setup | Credits per poll | Per game | Per week |
|---|---|---|---|
| NFL, `core,long,alt` (20 markets) | ≤ 20 | ≤ 1,060 | 16 games → ≤ ~17,000 |
| NFL, `core` (11) | ≤ 11 | ≤ 580 | ≤ ~9,300 |
| CFB, `core,alt` (17) | ≤ 17 | ≤ 900 | capped by `PROPS_MAX_EVENTS` and credit pacing |
| CFB, `core` (11) | ≤ 11 | ≤ 580 | capped the same way |

A college game with few markets posted costs far less than its ceiling (the
provider bills markets returned). To spend less, lengthen the far tiers, for
example `PROPS_CADENCE=1.5:15,6:30,24:90,*:480`. The Props page decides every
prop on its game's latest capture (up to `PROPS_LATEST_MAX_MIN`) and shows the
price's age, so a slower clock means older prices on the board, not a dark one.
The recorded decisions still use the 30-minute execution window.

These are ceilings. A book that posts no props for a small college game
returns fewer markets. The per-run cap (`max_events` 64, nearest kickoff
first) also limits a crowded Saturday.

- **Small plan:** NFL `core` only (`PROPS_LEAGUES=nfl`,
  `PROPS_MARKET_GROUPS=core`) fits in about 20K credits a month.
- **Both leagues with alternates:** plan for about 130K a month.

`football/props/<league>/capture_state.json` records what each run spent and
what remains.

## Apply the SQL (optional)

The page reads the committed JSON. Supabase is a durable, queryable copy of
the ledger and stores the reader's watchlist.

1. Paste `supabase/player_props.sql` into the Supabase SQL editor.
2. Then paste `supabase/player_props_watchlist.sql`. It stops with a message if
   the first file is missing.

Both files are idempotent and end in a report whose rows say `ok`. The job
copies the ledger when the `SB_URL` and `SB_SERVICE_ROLE` secrets exist, the
same secrets the other jobs use. Without them the copy logs and exits 0.

Without the watchlist table, a reader's stars still work in that browser
through localStorage.

## Commands

| Command | What it does |
|---|---|
| `npm run props:board` | Rebuild the NFL board (`--offline` uses only the cache). |
| `npm run props:board:cfb` | Rebuild the college board (parquet needs `pip install pyarrow`). |
| `npm run props:capture` | Capture prices (needs `ODDS_API_KEY` in the environment; budgeted as above). |
| `npm run props:grade` | Grade finished games and write `performance.json`. |
| `npm run props:backtest` | Walk-forward distribution backtest, writes `football/props/nfl/calibration.json`. |
| `npm run props:correlation` | Same-game correlation from the game logs, writes `football/props/nfl/correlation.json`. |
| `node football/props/verify_ledger.js --league all --base HEAD` | Proves the ledgers only grew since the last commit (the hourly job runs it before publishing). |
| `npm run props:sync` | Insert-only copy to Supabase. |
| `npm run props:test` | Kernel, pipeline and AI-desk suites (offline). |
| `npm run props:sql` | Both SQL files against a throwaway PostgreSQL. |
| `npm run props:e2e` | The page in Chromium, desktop and a 390 px phone. |

`node football/props/build_board.js --now 2026-10-04T15:00:00Z` rebuilds as
of a past moment. `node football/props/capture.js --fixture <file>` parses a
saved Odds API response without spending anything.

## The distribution backtest

`backtest.js` walks a completed season week by week. It projects every player
with data strictly before the week and scores the realised stat against the
distribution: coverage, PIT, ECE, log score and bias.

A per-market variance and mean correction is adopted only if it improves the
held-out log score. The rest keep the raw model, and the Performance tab
prints which were adopted.

This measures whether the distributions are honest about outcomes. It says
nothing about beating a price: no historical prop prices exist in this repo.
Re-run it after each season with the `backtest` input of the Player props
workflow. That input also re-runs `correlation.js`.

The backtest also scores a naive baseline, the player's own last eight games,
on the same rows. Its out-of-sample half decides each market's **validation
stage** (DESIGN.md §8):

- A market that passes every gate is TRACKING.
- Anything else is EXPERIMENTAL: capped at LEAN, with no units.
- The live record in `performance.json` decides RESEARCH GRADE and
  PRODUCTION, automatically.
- Research → Lab → **Player props validation** lists every market's gates.

Nothing is promoted by hand. To see why a market is held, open that view, or
the drawer's *Validation stage* section.

## Reading what the page says

| The page shows | Meaning | What to do |
|---|---|---|
| **Sportsbook prices: not captured yet** / **Waiting for sportsbook prices** | `NOT_RUN`: no capture has run, or `PROPS_CAPTURE` is off. | Turn prices on (above) and run the workflow by hand. |
| **Sportsbook prices: markets not released yet** | `NO_MARKETS`: The Odds API answered (HTTP 200) and no requested book has posted a player market for the events asked. | Nothing: books post props through the week. The notice quotes the provider's answer. |
| **no game inside the capture window** | `NO_MARKETS` / `NO_EVENTS_IN_WINDOW`: no event kicks off inside `PROPS_WINDOW_H`. | Nothing, or widen the window. |
| **Sportsbook prices: capture error** | `ERROR`: the notice shows `error_message` (the HTTP status and the provider's body). | Fix what it names: a 401 is the key, a 422 a market or book key, a 429 the quota. |
| **PARTIAL** beside the prices | Some requests failed or the run stopped early. | Read `error_message` in `capture_state.json`. |
| **Sportsbook prices: current** (no notice) | HEALTHY: every game was checked on its clock and prices are executable. | Nothing. |
| **Sportsbook prices: on schedule** · next check 7:45 PM · last 5.4 h ago, grey dot, no notice | HEALTHY, but most games are far out and between their 1–6 h checks, so their last prices are reference only. The ⓘ beside it explains the price clock. | Nothing, or press **Refresh prices**. |
| **Injury report week N not out yet** | The latest official report is for an earlier week (Monday–Tuesday, before the first practice report). Confidence still carries the missing report. | Nothing. |
| **prices partially delayed**, "8/10 books current · 2 providers delayed" | DEGRADED: some books or games failed their last check. Current prices elsewhere are unaffected. | "What happened" in the notice names the games, errors and retry times. |
| **prices delayed**, "Current sportsbook pricing temporarily unavailable … Automatic recovery is running" | DELAYED: most games are past their check target. | `select * from player_props_pipeline_health;` shows `scheduler_action` (is props_cron dispatching?) and `last_error`. See also the Player props run log. |
| **price feed unavailable**, "…is unavailable" | OUTAGE: the provider is refusing (401/429, with the time), the capture is failing, or no check has run for 60 min past when one was due. | A 401 is the key; a 429 clears itself at the time shown; "overdue" means the scheduler: check `player_props_dispatch` in `cron.job`, `props_cron`'s `PROPS_GH_TOKEN`, and the workflow's recent runs. |
| **WAIT FOR PRICE** on a prop, "O 212.5 +105 MGM" in grey italics ("last seen 3.3 h ago" too, when its age differs from the strip's) | Research stands; no quote is inside the 30-minute execution window (`STALE_QUOTE`), the game was not checked yet (`NO_CURRENT_QUOTE`), or its last check failed (`PROVIDER_FAILURE`). | Nothing: it decides again as soon as a current price arrives. |
| **MARKET CLOSED** | A book dealt it and pulled it. | Nothing. |
| **Refresh prices** says "Try again in N min" / "rate-limiting until …" / "Sign in" | The refresh cool-down, a provider 429, or a signed-out reader. | Nothing; the text says what to do. |
| `PRICE_ANOMALY` (WATCH) | EV ≥ 15% or edge ≥ 12 pp with no second book within 12 cents. | Check the book by hand. This is usually a stale or mistyped line. |
| **UNMAPPED** row | A book's player name did not resolve to exactly one player on the two rosters. | See `board.unmapped[]` for the reason. The resolver (`build_board.js` `resolveName`) already handles suffixes, punctuation and initials; an ambiguous name stays unmapped by design. |
| `board.quotes.unjoined_events` | A priced event did not join a scheduled game. | Usually a team-name or kickoff mismatch. The NFL joins by team name within 18 h; CFB joins through `_intelligence.js`. |
| Probability source **MODEL-ESTIMATED** | Fewer than 200 settled props exist. | Nothing: units are capped at 0.25U until the ledger earns more. |
| `STAGE_EXPERIMENTAL` (LEAN, no units) | The market has not passed its walk-forward gates. | Nothing. It is promoted automatically when the evidence passes (Lab → Player props validation). |
| `PLAYER_EXPOSURE` / `CORRELATED_EXPOSURE` | The stake was cut because the player already carries 1U, or the game's correlated stake reached 2U. A cut to zero is a LEAN. | Nothing. It is the cap working (DESIGN.md §13). |
| The hourly job fails at "The ledgers only grew" | A committed ledger row was edited, removed or reordered, or a row fails its id, kickoff or grade check. | Read the listed lines. Never edit a published ledger. Restore it with `git checkout <file>` and rebuild. |

The probability source is promoted by `grade.js`, never by hand:

| State | Settled final rows | ECE | Other |
|---|---|---|---|
| EARLY | ≥ 200 | — | — |
| PARTIAL | ≥ 500 | ≤ 0.03 | — |
| CALIBRATED | ≥ 1000 | ≤ 0.02 | positive CLV |

## What a provider still has to supply

| Needed for | Field | Until then |
|---|---|---|
| Prop prices | The Odds API per-event `bookmakers[].markets[player_*].outcomes[{name, description, price, point}]`, `last_update` | No EV, no decision (see **Turn prices on**) |
| Routes, route participation, YPRR | per player-game `routes_run` | "not in feed"; snap share is used and labelled |
| College injuries and depth | an official availability feed | "no official report"; confidence lowered |
| College targets and snaps | per player-game `targets`, `offense_snaps` | reception share and touches, labelled |
| Coverage tendencies | man/zone rates per defence | not shown |

Each would enter through its source module (`football/props/sources/*.js`) as
a new column on the player logs. The model reads it only where
`ds.caps.<name>` says it exists.

## Turning it off

- **Stop spending:** set `PROPS_CAPTURE` to anything but `on` / `true` / `1` / `yes`. The board keeps
  building from the free feeds. The last prices age out of the execution
  window and decide nothing, and the page says the capture is off.
- **Stop the scheduler:** `select cron.unschedule('player_props_dispatch');`.
  The workflow's own backup schedule keeps running.
- **Stop the job:** disable the Player props workflow. The last committed
  board stays published.
- **Remove the tab:** delete the Props nav button and `#v-pprops` in
  `app.html`. No other page reads the props files.
