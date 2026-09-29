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
2. **Set the repository variable `PROPS_CAPTURE` to `on`.** Anything else
   means the capture step does not run and spends nothing.
3. Optionally, **tune the budget** with the repository variables below.
4. Run **Actions → Player props → Run workflow** once, or wait for the hourly
   schedule (minute 23, August–January).

The page's status strip then changes from *not captured yet* to *prices
captured N min ago*.

| Variable | Default | What it does |
|---|---|---|
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
| `npm run props:sync` | Insert-only copy to Supabase. |
| `npm run props:test` | Kernel and pipeline suites (offline). |
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
workflow.

## Reading what the page says

| The page shows | Meaning | What to do |
|---|---|---|
| **Waiting for sportsbook prices** | No capture has run. | Turn prices on (above). |
| **STALE** in the status strip; **Stale prices** notice after 3 h | The last capture is over 90 minutes old. | Check the capture step's log and `capture_state.json` for `stopped` (budget, floor, 401/429). |
| `STALE_QUOTE` on a prop | That book's price is older than 90 minutes, so it decides nothing. | Nothing: it clears on the next capture. |
| `PRICE_ANOMALY` (WATCH) | EV ≥ 15% or edge ≥ 12 pp with no second book within 12 cents. | Check the book by hand. This is usually a stale or mistyped line. |
| **UNMAPPED** row | A book's player name did not resolve to exactly one player on the two rosters. | See `board.unmapped[]` for the reason. The resolver (`build_board.js` `resolveName`) already handles suffixes, punctuation and initials; an ambiguous name stays unmapped by design. |
| `board.quotes.unjoined_events` | A priced event did not join a scheduled game. | Usually a team-name or kickoff mismatch. The NFL joins by team name within 18 h; CFB joins through `_intelligence.js`. |
| Probability source **MODEL-ESTIMATED** | Fewer than 200 settled props exist. | Nothing: units are capped at 0.25U until the ledger earns more. |

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

- **Stop spending:** set `PROPS_CAPTURE` to anything but `on`. The board keeps
  building from the free feeds. The last prices age into STALE and then
  decide nothing.
- **Stop the job:** disable the Player props workflow. The last committed
  board stays published.
- **Remove the tab:** delete the Props nav button and `#v-pprops` in
  `app.html`. No other page reads the props files.
