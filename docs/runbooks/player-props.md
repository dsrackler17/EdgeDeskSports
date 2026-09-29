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
| Hourly job | `.github/workflows/player-props.yml` |
| PR suites | `.github/workflows/player-props-tests.yml` |

The design and its formulas are in `docs/player-props/DESIGN.md`. The audit
behind them is in `docs/player-props/AUDIT.md`.

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
4. Run **Actions → Player props → Run workflow** once, or wait for the hourly
   schedule (minute 23, August–January). GitHub's scheduler skips hours on
   this repository (see `capture.yml`), so after changing the variable or the
   secret, run it by hand rather than waiting.

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
| `PROPS_MIN_INTERVAL_H` | 3 | How often an event within 36 h of kickoff is re-polled. |
| `PROPS_FAR_INTERVAL_H` | 8 | How often an event more than 36 h out is re-polled. |

Inside six hours of its kickoff, an event is re-polled on every run, which is
hourly. The capture also stops in three cases:

- the provider reports fewer than 200 credits left;
- a run would pass `PROPS_MAX_CREDITS`;
- the provider returns a 401 or 429.

### Two captures, one key

There are now two ways to buy prop prices. Both spend the same `ODDS_API_KEY`,
so run one of them, not both.

1. **The Supabase capture function, from build `capture-v11-player-props-r1`.**
   - It captures every player quote for NFL and NCAAF events on its DAY and
     NEAR tiers into `player_prop_quotes`, with change-only history in
     `player_prop_quote_ticks`.
   - It is budgeted per run and per event, and stops at a quota floor.
   - Its setup and arithmetic are in `supabase/functions/capture/README.md`;
     its tables are in `supabase/capture_v11_player_props.sql`.
   - This is the capture to run.
2. **The GitHub Actions capture here (`PROPS_CAPTURE=on`).**
   - It writes `football/props/<league>/quotes.json` for the static board.
   - Leave it off while the Supabase capture runs.

**Gap to close:** the board build still reads `quotes.json`. Pointing
`build_board.js` at `player_prop_quotes` would make the Supabase capture the
page's only source.

### The credit arithmetic

Player markets exist only on The Odds API's per-event endpoint, at one request
per event. The capture budgets each request as markets × regions. The
provider's `x-requests-last` header reports the real cost, and the run counts
that figure.

With the default windows, one game is polled about 24 times before kickoff:

| Time before kickoff | Re-poll interval | Polls |
|---|---|---|
| 96 h to 36 h | every 8 h | about 8 |
| 36 h to 6 h | every 3 h | about 10 |
| Last 6 h | hourly | about 6 |

| Setup | Credits per poll | Per game | Per week |
|---|---|---|---|
| NFL, `core,long,alt` (20 markets) | ≤ 20 | ≤ 480 | 16 games → ≤ ~7,700 |
| NFL, `core` (11) | ≤ 11 | ≤ 264 | ≤ ~4,200 |
| CFB, `core,alt` (17) | ≤ 17 | ≤ 408 | 60 listed games → ≤ ~24,500 |
| CFB, `core` (11) | ≤ 11 | ≤ 264 | ≤ ~15,800 |

These are ceilings. A book that posts no props for a small college game
returns fewer markets. The per-run cap (`max_events` 16, nearest kickoff
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
| **STALE** in the status strip; **Stale prices** notice after 3 h | The last capture that wrote prices is over 90 minutes old. | Check the capture step's log and `capture_state.json` for `status`, `stopped` (budget, floor, 401/429) and `error_message`. |
| `STALE_QUOTE` on a prop | That book's price is older than 90 minutes, so it decides nothing. | Nothing: it clears on the next capture. |
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
  building from the free feeds. The last prices age into STALE and then
  decide nothing.
- **Stop the job:** disable the Player props workflow. The last committed
  board stays published.
- **Remove the tab:** delete the Props nav button and `#v-pprops` in
  `app.html`. No other page reads the props files.
