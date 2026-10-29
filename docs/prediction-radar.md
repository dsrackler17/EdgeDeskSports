# Prediction Radar (Experimental)

**Status:** EXPERIMENTAL. Prediction Radar shows where the best-graded
Polymarket sports bettors are putting real money on the games EdgeDesk covers,
and how following them has actually performed. It is **not a pick service** and
it never promises profit. Every number on it comes from public trading data that
anyone can verify on Polygon.

**Off by default.** Nothing is fetched and nothing is shown until the owner
turns `POLYMARKET_DATA_ENABLED` on (see [Open items](#open-items)).

It answers three questions:

1. **Who are the best sports bettors on Polymarket?** They are graded on skill:
   the closing-line value of their entries and what a follower would have made.
   Profit alone is not the grade.
2. **What are they on tonight?** The side, the size and the entry price, for
   the games EdgeDesk covers (Smart Money Tonight, inside the terminal).
3. **Would following them have made money?** This is measured at a price a
   follower could really get, in a record nobody can edit (H-RADAR-01, and the
   Radar record).

## Contents

| Piece | File |
|---|---|
| The grading core | `lib/edgedesk_radar.js` (`window.EDRadar`) |
| The Polymarket gateway (the only Radar client) | `lib/edgedesk_poly_gateway.js` |
| The tables, the rules, the guards and the reader doors | `supabase/radar.sql` (mirror: `supabase/migrations/20261029120000_radar.sql`) |
| The scheduled job | `supabase/functions/polymarket_sync` (carries both libraries verbatim: `tools/radar/inline_core.js`) |
| The schedules | `supabase/polymarket_sync_cron.sql` |
| The H-RADAR-01 registration | `research/radar/registration_h_radar_01.json`, generated into `supabase/radar_registry.sql` |
| The H-RADAR-01 runner and report | `research/radar/run_validation.js`, `research/radar/one_look.js`, `research/radar/H-RADAR-01/`, run by `.github/workflows/radar-validation.yml` |
| Tests (offline) | `tools/radar/*.test.js`, with recorded responses in `tools/radar/fixtures/`, run by `.github/workflows/radar-tests.yml` |
| The live source check | `tools/radar/fetch_sources.js`, run by `.github/workflows/radar-sources.yml` |

## Data sources

All of them are Polymarket's public APIs. None needs a key.

| Source | Used for |
|---|---|
| Data API `https://data-api.polymarket.com` `/v1/leaderboard` | The candidate pool: category `SPORTS`, all time, ordered by volume. |
| Data API `/v2/activity` | Each wallet's trades, redemptions, splits and merges. This is the history Radar grades. |
| Data API `/v2/holders?condition=…&include_pnl=true&limit=100` | Who holds each side of one market, with their average entry. One condition per call, at most 100 holders a side (Polymarket refuses more with `include_pnl`). |
| Gamma API `https://gamma-api.polymarket.com` `/sports`, `/events`, `/markets` | The leagues and their series, the game events, and each market's metadata: outcomes, tokens, start time and resolution. Gamma is how a Polymarket market is matched to an EdgeDesk game (`signals.event_id`). |
| CLOB `https://clob.polymarket.com` `/prices-history` | One outcome's price over time, at 1-minute fidelity. It gives the follow price and the close. |
| RTDS `wss://ws-live-data.polymarket.com` | **Not used in v1.** It is the public trade stream, kept for real-time alerts later. |

- **P&L is computed from trades.** Radar never reads Polymarket's separate P&L
  or rankings hosts, which carry no stability guarantee.
  `tools/radar/no_bypass.test.js` fails if a Radar file names them.
- **Every trade keeps its transaction hash** (`poly_trades.tx_hash`, required).
  Every graded bet on a trader page links each of its trades to
  `https://polygonscan.com/tx/<hash>`.
- **One gateway** (`lib/edgedesk_poly_gateway.js`). It follows the pattern of
  `odds_gateway`, for a source that costs nothing but is rate limited:
  - **The switch.** `POLYMARKET_DATA_ENABLED` must be on, both in
    `public.radar_config` (one SQL statement, no deploy) and in the function's
    environment.
  - **The budget.** Every attempt takes one request from the run's grant, which
    `poly_api_acquire()` decides under one row lock. There is a per-run cap of
    3,000 and a daily ceiling of 40,000. When the budget is empty the request
    is refused, never queued. `poly_api_settle()` returns what the run did not
    use.
  - **The pace.** Requests to one host start at least 80 to 120 ms apart.
  - **The backoff.** No answer, a timeout, a 429 or a 5xx is retried at most 3
    times. The wait starts at 1 s and doubles, ±20%, capped at 16 s. A 429's
    `Retry-After` is honoured up to 60 s. Any other 4xx is not retried.
  - **The breaker.** Six 429s or 5xx in a row open it. The run stops, and the
    gateway refuses runs for 15 minutes.
  - **No other path.** `tools/radar/no_bypass.test.js` fails if any other file
    names a Polymarket host. The one exception is listed by name: the
    Portfolio's connector, which reads a reader's own wallet and predates
    Radar (see [Open items](#open-items)).
- **Response shapes.** Polymarket cannot be reached from the build environment.
  `.github/workflows/radar-sources.yml` asks each endpoint once from GitHub's
  runner, prints what came back and fails if a parser cannot read it. It also
  asks the exact request forms of the H-RADAR-01 runner (`run_validation.js`
  `REQ`) and of `polymarket_sync`. `tools/radar/fixtures/` holds eleven
  responses recorded from run
  [40812412377](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40812412377),
  read by `tools/radar/fixtures.test.js`.
- **What the live probe taught** (each is fixed and has a regression test):
  - Gamma's `/markets?condition_ids=…` answers a **resolved** market only when
    asked with `closed=true`, and an open one only without it. Without this
    the H-RADAR-01 run would have read no market and spent its one look on an
    empty report, and the job would never have recorded a settlement.
  - `/v2/holders` refuses `limit` above 100 with `include_pnl` (HTTP 400).
  - One unwindowed page of 100 open NFL events was 48 MB (15,400 markets,
    player props included). The job asks events in a window on their end date
    (a game event's end date is its start), 5 a page.
  - A Gamma market's `spread` is its order book's bid-ask spread, not a
    point. The line is read from `line` only.

## The rules: one constant

`public.radar_rules()` in `supabase/radar.sql` is the only place a threshold is
written. It works like `bet_checker_rules()`:
- the scheduled job reads it at the start of every run, and the grading core
  (`lib/edgedesk_radar.js`) takes it as an argument and has no defaults;
- the H-RADAR-01 registration carries a frozen copy, which
  `tools/radar/radar_sql.test.js` holds equal to it, key by key.

| Rule | Value | Meaning |
|---|---|---|
| `min_graded` | 50 | Graded bets a wallet needs to be ranked. Fewer is a **small sample**, with no rank and no Radar Score. |
| `top_wallets` | 25 | The top-graded wallets: the best ranked Directional wallets by Radar Score. |
| `pool_size`, `pool_period`, `pool_order` | 200, ALL, VOL | The candidate pool. It is ordered by volume, not profit, so the pool is not chosen on results. |
| `max_bets_per_wallet` | 150 | A grade reads the wallet's most recent graded bets. |
| `wallet_max_pages` | 30 | Activity pages per wallet. A longer history is **truncated** and the wallet is never top-graded. |
| `follow_lag_min`, `follow_lag_alt_min` | 5, 15 | The follow: the market price this long after the wallet's first buy. |
| `follow_max_gap_min` | 10 | A follow price is no older than this. |
| `close_max_gap_min` | 60 | The close: the last price at or before the start, no older than this. |
| `conviction_high_x` | 3 | A position this many times the wallet's median stake is flagged. |
| `mm_two_sided_share`, `mm_median_trades`, `mm_max_net_ratio`, `hedger_two_sided_share` | 0.5, 6, 0.3, 0.2 | The style rule (below). |
| `score_weight_*`, `score_shrink_n` | 0.5 / 0.3 / 0.2, 50 | The Radar Score (below). |
| `leagues`, `market_types` | NFL, college football, NBA, NHL, MLB; moneyline, spreads, totals | What is graded and shown. |
| `upcoming_hours`, `holders_fresh_min`, `moved_min`, `fair_max_age_min`, `kickoff_tolerance_min` | 36, 30, 0.01, 90, 360 | Smart Money Tonight. |
| `daily_request_ceiling`, `run_request_cap`, `breaker_minutes` | 40,000, 3,000, 15 | The gateway. |

## How a bettor is graded

Only sports markets are graded: the game markets (moneyline, spreads, totals) of
the leagues above. Everything is computed from the wallet's own trades.

- **A bet** is a position in one outcome whose **first buy came before the game
  started**. Its entry time is that first buy. Its entry price is the
  volume-weighted price of its buys before the start. Its stake is what those
  buys cost.
- A bet is not graded when:
  - it was entered in play;
  - its market has had a split or a merge, so the cost cannot be attributed;
  - its trades sell more than they buy, which means history is missing.

  Each case is counted.
- **Record, profit, ROI.** Wins, losses and pushes (a 50-50 resolution). Profit
  is sell proceeds plus the settlement of the shares still held, minus every
  buy, in play included: the money the wallet actually made. ROI is profit
  divided by buy cost.
- **CLV.** The close minus the entry price, in points. CLV% is close ÷ entry −
  1. That is the house formula, `close/index.ts`: entry decimal × closing fair
  − 1.
- **Follow ROI.** What a follower would have made by entering the same side at
  the market price **5 minutes after** the wallet's first buy, held to
  settlement: settlement ÷ follow price − 1, one unit per bet. The 15-minute
  version is also stored. This is the number that matters most, because a
  follower never gets the wallet's own price. There is no follow price when:
  - the game started first;
  - no price was recorded within 10 minutes.
- **Conviction.** A position's size against the wallet's median stake. 3× or
  more is flagged.
- **Style.** Market makers are never top-graded and never counted in Smart
  Money Tonight.
  - **Market Maker:** at least half of its markets are two-sided (both outcomes
    bought, or a split or merge), with a median of 6 or more trades a market
    and a median |shares A − shares B| ÷ (A + B) of 0.3 or less.
  - **Hedger:** not a market maker, with at least 20% of its markets two-sided.
  - **Directional:** everything else.
- **Sample.** Below 50 graded bets the wallet is a **small sample**: listed, but
  with no rank and no Radar Score.
- **Radar Score (Experimental composite).** For ranked wallets only:
  - 100 × (0.5 × follow ROI + 0.3 × CLV% + 0.2 × ROI);
  - each part is shrunk by n ÷ (n + 50), where n is the number of bets it is
    measured on.

  The score follows the repository's composite rules: it ships with a registered
  validation report (H-RADAR-01), it stays labelled Experimental, and its
  components are always returned and shown next to it.
- **Versioned.** Each nightly grading is one run in `poly_grade_runs`. Its grades
  go into `poly_wallet_grades`, which is append-only. `radar_put_grades()`
  refuses a run that:
  - graded with any rules but `radar_rules()`;
  - ranks out of score order;
  - marks more than 25 wallets top-graded;
  - marks a market maker or a truncated history top-graded;
  - calls a wallet with fewer than 50 bets ranked.

## Matching a Polymarket market to an EdgeDesk game

Each market is matched once to **exactly one** EdgeDesk game
(`signals.event_id`). The rules:
- the same league;
- a start within 6 hours of the board's;
- both outcomes resolving one-to-one to the game's two teams (a club's nickname,
  "Chiefs", or its school, "Alabama").

Each side then carries the board's fair at **that** line (`sig_key`), or none.
It never takes another line's fair. Anything else stays pending with its
reason (`no_event`, `team_unresolved`, `ambiguous_event`, …), and a market
starting within 12 hours that stays unmatched raises a warning. A match is
written once and never moved (`poly_markets_guard`).

## Smart Money Tonight (the data)

`public.radar_tonight()` gives one card per upcoming EdgeDesk game (within 36
hours) that has a matched market held by top-graded wallets. It is for
subscribers only (`has_active_sub()`). Each card has:
- the side most of those wallets are on (then the most dollars);
- how many wallets are on it, the dollars they put in, and their dollar-weighted
  average entry;
- the current Polymarket price, and whether it has moved by a cent or more since
  their entry;
- EdgeDesk's fair for the same side, and whether smart money **agrees**
  (fair ≥ price) or **disagrees** with it. This is shown only when the fair is
  under 90 minutes old;
- the conviction flags;
- the count of top-graded wallets on the other side;
- each wallet with its rank and its public name or shortened address.

The rules:
- a holders snapshot older than 30 minutes is not shown;
- a game with no top-graded wallet gets **no card**: nothing is guessed;
- cards are sorted by the number of wallets, then by dollars.

## Pipeline

`supabase/functions/polymarket_sync` runs on the schedule in
`supabase/polymarket_sync_cron.sql`. All times are UTC.

| Job | When | What |
|---|---|---|
| `tonight` | every 10 minutes | Reads the covered leagues' open game events starting within the next 60 hours (5 a page, at most 16 pages a series) and upserts their markets, matching each once. For the matched markets of games within 36 hours **at the board's own lines**, it stores who holds each side (pool wallets only) and each outcome's price. An alternate line is matched but not read for holders: it has no EdgeDesk fair to compare with. It also stores the resolution of matched markets whose game started in the last two days. |
| `pool` | 06:07 | Puts the sports leaderboard's top 200 by volume in the pool. Every other wallet leaves it. |
| `wallets` | every 5 minutes, 06:10 to 09:55 | Takes three pool wallets a run, least recently read first. It reads their activity since the cursor, the markets they traded, and their covered trades with hashes. Each newly resolved bet is graded once: its close, CLV and the 5- and 15-minute follow. |
| `grade` | 10:17 | Regrades every pool wallet as one versioned run. |

| Table | Kind |
|---|---|
| `poly_markets` | A market and its one EdgeDesk game, written once. The resolution is final. |
| `poly_wallets` | The pool, and each wallet's name if it made it public. **No bio or profile is stored.** |
| `poly_trades` | Append-only, with transaction hashes. |
| `poly_bets` | Append-only, written once when the market resolved. |
| `poly_grade_runs`, `poly_wallet_grades` | Append-only, versioned per grading run. |
| `poly_holder_snapshots`, `poly_price_snapshots` | Append-only, every 10 minutes. |
| `poly_api_days`, `poly_api_grants`, `poly_api_settlements` | The gateway's ledger. Grants and settlements are append-only. |
| `poly_sync_runs`, `poly_alerts`, `radar_config_log` | Append-only. |

### Who reads what

The database decides. No existing policy is changed.

| Reader | Gets |
|---|---|
| Anyone | `radar_status()`: whether Radar is on and registered, and what H-RADAR-01 found. Once Radar is on **and** H-RADAR-01 is registered: the graded leaderboard (`radar_leaderboard()`, and `poly_wallet_grades` by RLS) and each trader's grade and graded history with transaction hashes (`radar_trader()`). |
| Subscribers (`has_active_sub()`) | Smart Money Tonight (`radar_tonight()`) and a trader's open positions on upcoming games. |
| Nobody else | Trades, holders, prices, the pool and the budget. |

The `security definer` doors return only what a page needs.

## H-RADAR-01: the registered test

> Positions that top-graded directional wallets enter on EdgeDesk-covered games,
> followed at the price 5 minutes later, beat the closing price more than 50% of
> the time and have positive follow ROI.

- **Registered first.** The registration was committed before any Polymarket
  data was read: `research/radar/registration_h_radar_01.json`, at
  2026-10-29T01:18:53Z, sha256 `56ca979a…`.
  - It fixes the protocol, the windows, the three criteria and the
    forking-paths disclosure.
  - `run_validation.js` refuses to run if the file changed.
  - `supabase/radar_registry.sql` writes it into the research registry, and
    every Radar reader door stays shut until it is there.
- **Windows.** Wallets are graded on games from 2025-09-01 to 2026-09-01. The
  holdout is the bets entered on games from 2026-09-01 to 2026-10-26. It is
  looked at once.
- **Selection.** The 25 highest Radar-Score Directional wallets with at least
  50 graded training bets and a complete history.
- **Criteria.** All three are required:
  - **C1:** at least 200 followed bets;
  - **C2:** the beat-close rate's 95% lower bound is above 50%;
  - **C3:** the follow ROI's 95% lower bound is above zero.

  The intervals come from a bootstrap that resamples whole games: 2,000
  resamples, seed 20261029.
- **What passing means.** Radar becomes **eligible** to drop its Experimental
  label. A person decides that, through a validation report. No code promotes
  it.
- **Where it ran.** On a GitHub runner (`.github/workflows/radar-validation.yml`),
  because the build environment cannot reach Polymarket. Everything it read is
  that run's artifact, gzipped, and its sha256 is in the report.
- **One look, enforced twice.**
  - The runner fetches nothing while a completed report is committed.
  - GitHub starts the workflow on every push to the pull request. So before
    the runner, `research/radar/one_look.js` reads the workflow's earlier runs
    with the job's own token. While no report is committed, it stops the job
    if any earlier run or attempt finished its live step, and names that run:
    its report is the one to commit.
- **Checked before the look.** Every request form the runner makes was first
  asked once by the live probe, on data outside the holdout. That is how the
  `closed=true` bug above was found before it could spend the look.
- **The result** is in `research/radar/H-RADAR-01/RESULTS.md` and is written
  into the registry. The Radar record section quotes it verbatim, good or bad.

## Compliance rules (built in)

- **The same for everyone.** Everything Radar shows is the same for every
  subscriber. Nothing is tailored to a reader's own positions or bets. Every
  reader door takes no input but a wallet address. Nothing trades for anyone.
- **No calls to action.** There are no "bet now" or "copy trade" buttons and no
  affiliate links. Radar shows information; the reader decides.
- **No promises.** Copy never says "guaranteed" or "lock" and never promises
  profit. Performance claims come only from the graded record and the
  registered test.
- **Public data only.** A wallet's name is shown only when its owner made it
  public (`display_username_public`). Otherwise the shortened address is shown.
  No bio, image or profile is stored or shown.

## Known limitations

- Polymarket's public data comes from its **international** platform. A US
  reader may not be able to trade the same markets.
- A follower never gets the wallet's entry price. The recorded price is not the
  ask, and fees are not modelled.
- Past results do not predict future results.
- Some large traders may have information others do not.
- The pool is drawn from today's leaderboard, so it can favour wallets that
  survived or grew.
- The holders list is Polymarket's top 100 holders of each side of a market.
  A top-graded wallet with a small position may not appear.
- Smart Money Tonight reads holders only at the board's own lines. Money on an
  alternate spread or total is not counted.
- Matching covers moneylines, spreads and totals of NFL, college football,
  NBA, NHL and MLB games that are on EdgeDesk's board. MMA is not matched in v1.

## Open items

- **Polymarket's terms of use.** Before launch the owner reads them for
  commercial display of this data. Until then `POLYMARKET_DATA_ENABLED` stays
  **off**. To turn it on, after the terms are read and permit it:

  ```sql
  update public.radar_config set value = 'on', note = 'terms read by <who> on <date>: <clause>' where key = 'POLYMARKET_DATA_ENABLED';
  ```

  Then set `POLYMARKET_DATA_ENABLED=on` on the function. To turn it off at
  once, with no deploy: the same statement with `'off'`.
- **The Portfolio's connector** (`lib/edgedesk_portfolio_connect_core.js`) still
  calls Polymarket directly for a reader's own wallet. Moving it behind this
  gateway is its own change.
- **Real-time alerts** from RTDS: only after the Radar record proves the signal.
- **Kalshi data:** needs Kalshi's written permission.
- **Polymarket US coverage:** first confirm whether its trades are public.
- **MMA:** matching fighters to the board's fights.

## Operator runbook

In order. Each SQL file ends in a report whose rows should read `ok`.

1. Apply `supabase/radar.sql`. Row 6 reads `pending: off` and row 7 `pending`
   until steps 2 and 6.
2. Apply `supabase/radar_registry.sql`. This registers H-RADAR-01 and records
   what it found.
3. Deploy the function: `supabase functions deploy polymarket_sync --no-verify-jwt`.
   Set its secrets `POLYMARKET_SYNC_SECRET` (any long random value) and
   `POLYMARKET_DATA_ENABLED=on`.
4. Store the same secret in Vault:
   `select vault.create_secret('<the secret>', 'polymarket_sync_cron_secret');`
5. Apply `supabase/polymarket_sync_cron.sql`.
6. After reading Polymarket's terms, turn the switch on (above). The first
   night fills the pool and starts the wallets; ranks appear once wallets have
   50 graded bets.

## Tests

- `tools/radar/core.test.js` — the grading core on worked examples: CLV, the
  follow, conviction, the market-maker rule, the score, the bootstrap, the
  H-RADAR-01 verdict and matching.
- `tools/radar/fixtures.test.js` — the parsers against responses recorded from
  the live probe (`tools/radar/fixtures/`).
- `tools/radar/gateway.test.js` — the switch, the budget, the backoff, the
  breaker and the endpoints.
- `tools/radar/no_bypass.test.js` — every Polymarket request goes through the
  gateway.
- `tools/radar/radar_sql.test.js` — the SQL on a real PostgreSQL, run as four
  readers: anon, a signed-in reader, a subscriber and the service role.
- `tools/radar/sync_fn.test.js` — the shipped function against that SQL.
- `.github/workflows/radar-tests.yml` runs them all; it is in
  `tools/ci/checks.json` (Research and signals).
- `tools/radar/validation.test.js` — the H-RADAR-01 runner end to end against
  a scripted Polymarket, and the one-look guard.
- `.github/workflows/radar-sources.yml` is the live check (Integration), never
  replaced by a mock. `.github/workflows/radar-validation.yml` is the
  H-RADAR-01 run (Integration).
