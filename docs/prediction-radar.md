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

## H-RADAR-02: the owner's methodology change (DRAFT, not registered)

**Status:** this branch carries H-RADAR-02. It is a methodology change: the
owner reviews it, and its rules are frozen in a registration before its
prospective test starts. Until H-RADAR-02 is registered, its SQL must not be
applied: every reader door stays shut until the live hypothesis is registered
(below). The sections after this one describe H-RADAR-01's rules (version 1),
which stay registered and whose result stands.

- **Design record and evidence:** `research/radar/H-RADAR-02/DESIGN.md`. That
  covers the owner's decisions and what Polymarket's data supports, from probe
  runs 40975470572, 40975893030, 40977654862 and 40982170115.
- **Draft registration:** `research/radar/registration_h_radar_02.json`.

### What changes (rules version 2, `radar_rules()`)

| | H-RADAR-01 (version 1) | H-RADAR-02 (version 2) |
|---|---|---|
| Candidates | the all-time sports board by volume, top 200 | Polymarket's 30-day sports board (`MONTH`), read to rank 1,000. It ranks candidates only, and qualifies nobody |
| History | oldest first, at most 30 pages; more is truncated (172 of 200) | each candidate's **complete last 90 days**, newest first, 10 pages a run, resumed with its cursor; more than 30 pages is **insufficient history — ungraded** |
| High-frequency | not screened | 1,000 actions in under 3 days **flags** a wallet (nothing more). Three 24-hour samples (now, 30 and 60 days ago) mark it **high-frequency — not followable** only if all three are known and above 100 position changes a day. A sample that cannot be read is unknown, never low. Counted in position changes, not fills |
| Pool | the 200 candidates | the 200 fully evaluated wallets with the most **dollars on covered-league game markets** in the 90 days, each with at least 20 covered pregame bets. Discovery continues past every exclusion |
| Follow price (grades) | the price-history midpoint | the midpoint **plus 1 cent** (Polymarket keeps no ask history), plus the market's taker fee from its own schedule |
| Featured | top 25 Directional, any score | Directional, ranked, complete history, not high-frequency, **a Radar Score above 0**, **at most 10**, fewer when fewer qualify |
| Record price | the recorded price (the midpoint) | the **best ask in the order book** when the card is published, plus the market's taker fee at it, with the depth and the midpoint |

### The pipeline (version 2)

- `pool`: reads the 30-day board as candidates (board rank and shares). It
  writes no pool membership.
- `wallets`: refreshes the pool's wallets first, then takes candidates in
  board order while fewer than 200 are eligible. Each candidate goes through:
  - screening on the first page;
  - the samples, if flagged;
  - the complete 90-day read;
  - its window's covered dollars and bets, and the grade of its newest bets
    in the window. A version-1 grade moves to version 2 from its stored
    midpoints, with no new read.

  Then the pool is chosen again. A read that fails part way keeps the cursor
  it started from.
- `grade`: grades the pool from its version-2 bets in the window. It writes
  the run's **discovery counts**: screened, flagged, sampled, high-frequency,
  insufficient history, fully evaluated, eligible and pool.
- `tonight`: reads each card's best ask from the order book (`/book`).
  `radar_publish_cards(p_quotes)` publishes a card only at that ask, with its
  market's taker fee at it, and only when that fee can be read.

### What a subscriber sees

- **Smart Money Tonight**, from the featured bettors, saying how many qualify
  today.
- **Observed Activity**, its own section, labelled *Observed, not a signal*.
  It shows what the other evaluated bettors hold, counted and summed by
  side. No bettor is named, and high-frequency wallets and market makers are
  left out.
- **How discovery stands**, in one line.
- **The record**, priced at the best ask, with H-RADAR-01's cards counted
  apart.

Access is unchanged: the subscriber doors are subscribers only
(`has_active_sub()`).

### Registered before shown

`radar_registered()` requires the live rules' hypothesis
(`radar_hypothesis()`): H-RADAR-02 for version 2. H-RADAR-01's registration
alone no longer opens the doors. `radar_current_run()` takes the latest
grading run made under the live rules' version, so an H-RADAR-01 run is never
shown as H-RADAR-02's featured bettors.

### Change-over order

1. **Deploy the function first.** It serves version 1 exactly as before:
   the version-1 sync suite passes 67/0 against it.
2. **Register H-RADAR-02.** After the owner approves:
   - freeze `registration_h_radar_02.json`, with its status, version,
     `registered_at` and the window's start date;
   - extend `tools/radar/build_registry_sql.js` to write it into the
     research registry and `registry_ref:H-RADAR-02`;
   - apply `supabase/radar_registry.sql`.
3. **Apply `supabase/radar.sql`, then `supabase/radar_record.sql`.** This
   has been checked over a version-1 database with data: the `poly_bets` key
   becomes `(wallet, token_id, grading_version)`, the version-1 rows stay,
   and the report reads ok.
4. **Run `run_now`.** Discovery, evaluation and the first version-2 grade.

### Fees (confirmed from Polymarket's documentation, 2026-10-30)

- **The formula.** The taker fee in USDC is shares × `feeSchedule.rate` ×
  (p × (1 − p)) raised to `exponent`, at the trade price p. Takers only;
  each market's own schedule decides (`docs.polymarket.com`, `trading/fees`
  and `market-data/market-details`).
- **Where it applies.** Grades and cards pay it on top of the price:
  - a grade's ROI is settlement ÷ (price + fee) − 1;
  - a card stores `fee_per_share` and is graded the same way.
- **Unknown schedules.** A market whose schedule cannot be read is never
  guessed: its follow or card is not graded.
- **Today.** Polymarket lists 0.05 for Sports; the covered markets probed
  charge 0.

### Open before registration

- The prospective window's start date.
- The registry builder for H-RADAR-02.

## Contents

| Piece | File |
|---|---|
| The grading core | `lib/edgedesk_radar.js` (`window.EDRadar`) |
| The Polymarket gateway (the only Radar client) | `lib/edgedesk_poly_gateway.js` |
| The tables, the rules, the guards and the reader doors | `supabase/radar.sql` (mirror: `supabase/migrations/20261029120000_radar.sql`) |
| The Radar record | `supabase/radar_record.sql` (mirror: `supabase/migrations/20261029130000_radar_record.sql`) |
| The scheduled job | `supabase/functions/polymarket_sync` (carries both libraries verbatim: `tools/radar/inline_core.js`) |
| The schedules | `supabase/polymarket_sync_cron.sql` |
| The H-RADAR-01 registration | `research/radar/registration_h_radar_01.json`, generated into `supabase/radar_registry.sql` |
| The H-RADAR-01 runner and report | `research/radar/run_validation.js`, `research/radar/one_look.js`, `research/radar/H-RADAR-01/`, run by `.github/workflows/radar-validation.yml` |
| What a reader sees | `lib/edgedesk_radar_ui.js` (`window.EDRadarUI`): Smart Money Tonight on the Overview (`lib/edgedesk_overview.js`), the trader sheet, and the public page `radar/index.html` |
| Tests (offline) | `tools/radar/*.test.js`, with recorded responses in `tools/radar/fixtures/`, run by `.github/workflows/radar-tests.yml` |
| Tests (browser) | `tools/radar/radar_ui.e2e.js` (Chromium, 390 px and 1280 px) |
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

## Where it shows

All of it is drawn by `lib/edgedesk_radar_ui.js`. The module fetches nothing
and decides no access: each page draws what a database door already decided.

- **Smart Money Tonight is at the top of the Overview tab**, the first thing a
  subscriber sees. It is read through `radar_tonight()` under the reader's own
  token (`EDShell.rpc`). Each card leads with one plain sentence, "7 top
  bettors, $84K, on Chiefs -3", with the numbers under it:
  - their average entry, the Polymarket price now, and EdgeDesk's fair;
  - whether the price has moved since they entered;
  - "Smart money agrees with the sharp fair price" or "Smart money disagrees
    with the sharp fair price", or the reason there is no comparison;
  - the High-conviction chip;
  - the other side's count;
  - each bettor. Tap one to open the trader page.

  When Radar is off, not registered or not deployed, the section draws nothing
  at all.
- **Trader pages.** In the terminal a trader page opens in a sheet over the
  Overview (Escape closes it). Publicly it is at `/radar/#trader/<wallet>`.
  Each page shows:
  - the public name, or the shortened address;
  - the record, ROI, CLV, follow ROI at 5 and 15 minutes, style and sample;
  - the Radar Score with its parts;
  - open positions, for a subscriber only;
  - every graded bet, each transaction linked to Polygonscan. A wallet's graded
    bets are its newest 150 resolved bets when Radar first read it, and every
    one since.

  It never shows a bio or anything beyond public trading data.
- **`/radar/` is free, with no login.** It shows:
  - the graded leaderboard;
  - the trader pages;
  - a teaser of the first Smart Money card: the game, the count and the
    dollars. It never shows the side, a price or a wallet; that is
    `radar_teaser()`'s rule, not the page's;
  - what H-RADAR-01 found;
  - the Known limitations.

  The page calls anonymous doors only (`lib/edgedesk_plans.js` DOORS, held by
  `tools/site/free_access.test.js`). It stays `noindex` until Radar is live;
  then it is switched to `index,follow` and added to the sitemap.
- **Labels are words.** Experimental, Small sample and High conviction are text
  chips, never colour alone.
- **Copy.** `tools/radar/radar_ui.test.js` fails on "bet now", "copy trade", an
  affiliate link, "guaranteed", "lock", or any promise, anywhere Radar draws.

## The Radar record: how following has done

This section answers "can this make me money" with Radar's own unedited
results, never with a claim.

- **Every card is recorded.** Each Smart Money Tonight card is snapshotted
  into `radar_cards` (append-only) the first time it is published: the
  game, the side, the number of top-graded bettors, their dollars and
  average entry, EdgeDesk's fair, and **the Polymarket price at that moment**,
  which is the price a follower could have taken.
  - `radar_publish_cards()` builds the cards with the same function that
    draws Smart Money Tonight, so the record holds exactly what subscribers
    saw.
  - There is one entry per game and side. A card is published only with a
    price, and only before its game starts.
- **Every card is graded once, automatically**, after its game, the way the
  public record grades a signal (`radar_grade_cards()`, `radar_card_results`,
  append-only):
  - **The close:** the last recorded price at or before the start, at most
    60 minutes before it. Otherwise there is no close; the card is counted
    and its result still graded.
  - **Beat the close:** the close is above the published price.
  - **CLV%:** close ÷ published price − 1.
  - **The result** comes from the market's own resolution: win, loss, or push
    (a 50-50 resolution).
  - **ROI:** one unit at the published price, held to settlement: settlement ÷
    published price − 1.
  - A market that has not resolved a week after its start is **void**: counted,
    never graded.
  - The guards refuse a grade whose arithmetic is not the database's own, and
    a grade made before the start.
- **What the subscriber sees.** Under Smart Money Tonight, "How following has
  done" shows (through `radar_record()`, subscribers only):
  - the record, the ROI per card and the beat-close rate;
  - the counts of pending, void and no-close cards;
  - the latest cards;
  - **exactly what H-RADAR-01 found**, passed or not, with its numbers and
    intervals.

  It is labelled **Experimental** until H-RADAR-01 has passed its registered
  criteria, and a **small sample** until 200 cards are graded. Both labels
  are words.
- **The job.** The 10-minute `tonight` run publishes and grades after it has
  stored the holders, the prices and the resolutions. While
  `radar_record.sql` is not applied, the run warns `record_not_installed` and
  goes on.

## Pipeline

`supabase/functions/polymarket_sync` runs on the schedule in
`supabase/polymarket_sync_cron.sql`. All times are UTC.

| Job | When | What |
|---|---|---|
| `tonight` | every 10 minutes | Reads the covered leagues' open game events starting within the next 60 hours (5 a page, at most 16 pages a series) and upserts their markets, matching each once. For the matched markets of games within 36 hours **at the board's own lines**, it stores who holds each side (pool wallets only) and each outcome's price. An alternate line is matched but not read for holders: it has no EdgeDesk fair to compare with. It also stores the resolution of matched markets whose game started in the last two days. |
| `pool` | 06:07 | Puts the sports leaderboard's top 200 by volume in the pool. Every other wallet leaves it. |
| `wallets` | every 5 minutes, 06:10 to 09:55 | Takes three pool wallets a run: first every wallet whose history is not truncated (only those can be top-graded), then the least recently read. It reads their activity since the cursor, the markets they traded, and their covered trades with hashes. Once a wallet's activity is read up to the present, each newly resolved bet among its newest 150 (`max_bets_per_wallet`, what the grade reads) is graded once: its close, CLV and the 5- and 15-minute follow. An older bet is not graded. |
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

### What it found

> H-RADAR-01 FAILED on its registered holdout: 41 followed bets over 37 games;
> beat-close rate 24.4% (95% CI 10.3% to 39.0%); follow ROI -1.7% (95% CI
> -33.4% to 30.5%).

- **Run.** [40823328433](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40823328433),
  2026-10-29. The report is `research/radar/H-RADAR-01/report.json`, sha256
  `8f9d8a4f…0ab1`, committed as printed.
- **None of the three criteria is met.** C1 has 41 followed bets, not 200.
  C2's lower bound is 10.3%, not above 50%. C3's lower bound is −33.4%, not
  above zero.
- **Why the sample is small.** 172 of the 200 pool wallets had more than 30
  pages of activity, so the registered rule excluded them. That left 13
  qualifying wallets, and only 3 of them bet on covered games in the holdout.
- **What follows.** The test does not support the hypothesis, and with 41 bets
  it cannot rule it out. Radar stays **Experimental**. A second look needs a
  new registered version.

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

**Deploy Prediction Radar** (`.github/workflows/deploy-radar.yml`, run by hand)
does every step below in this order with the repository's Supabase secrets:
`apply_sql`, `deploy_function`, `set_cron_secret` (the function's and Vault's
halves made one value, never printed), `data_enabled` (`on` needs
`enable_note`: who read the terms, when, the clause) and `apply_cron`. The
Radar suites run first, and a report row that says CHECK THIS fails the run.
`run_now` does the overnight work at once: the pool, the wallets (3 a call)
until none is due, then the grade, one call at a time, each answer awaited
before the next. It stops the wallet calls while fewer than
`run_now_reserve` (8,000) of the day's 40,000 Polymarket requests remain, so
the 10-minute tonight runs keep theirs; the 06:10 UTC schedule takes the rest.
Every wallets run answers within Supabase's 150 s request limit: after 75 s
it starts no new wallet, activity page or graded bet, and a wallet it did not
finish stays due with its place kept (the 30-page cap counts across runs).
A run also holds at most 10 activity pages, and grades a bet from only the
two stretches of its price history the grade reads (`R.gradeWindows`: the
follows' and the close's), so a bet placed days early is two short reads.
It grades only the bets the grade reads (a wallet's newest 150), and only once
the wallet's activity is read up to the present, and it reads every wallet that
can still be top-graded before a truncated one.
Each wallet is marked before its work and the mark cleared after, so a wallet
whose run dies (out of compute) is set aside for 15 minutes, and after three
such runs read once a day: it never blocks the pool behind it.
`run_now` also grades after every 25 good wallet calls (a grade asks
Polymarket nothing), so the site shows what is synced so far, and it stops the
wallet calls after 5 hours, so the last grade runs inside GitHub's 6-hour job
limit.
By hand instead, in order. Each SQL file ends in a report whose rows should
read `ok`.

1. Apply `supabase/radar.sql`. Row 6 reads `pending: off` and row 7 `pending`
   until steps 2 and 6.
2. Apply `supabase/radar_registry.sql`. This registers H-RADAR-01 and records
   what it found.
3. Deploy the function: `supabase functions deploy polymarket_sync --no-verify-jwt`.
   Set its secrets `POLYMARKET_SYNC_SECRET` (any long random value) and
   `POLYMARKET_DATA_ENABLED=on`.
4. Store the same secret in Vault:
   `select vault.create_secret('<the secret>', 'polymarket_sync_cron_secret');`
5. Apply `supabase/radar_record.sql` (the Radar record), then
   `supabase/polymarket_sync_cron.sql`.
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
- `tools/radar/radar_ui.test.js` — what a reader sees, and which door each page
  may call.
- `tools/radar/radar_ui.e2e.js` — the Overview, the trader sheet and `/radar/`
  in Chromium at a phone and a desktop width. It fails on a page error or a
  sideways scroll.
- `.github/workflows/radar-tests.yml` runs them all; it is in
  `tools/ci/checks.json` (Research and signals).
- `tools/radar/validation.test.js` — the H-RADAR-01 runner end to end against
  a scripted Polymarket, and the one-look guard.
- `.github/workflows/radar-sources.yml` is the live check (Integration), never
  replaced by a mock. `.github/workflows/radar-validation.yml` is the
  H-RADAR-01 run (Integration).
