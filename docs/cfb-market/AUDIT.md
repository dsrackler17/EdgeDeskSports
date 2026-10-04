# CFB odds infrastructure — audit and the canonical market format

What EdgeDesk already has for college-football market data, what each source carries by season, and the one
format every quote normalises into. Nothing here was rewritten: the Model Lab's capture, ledger, openers and
closes, and the integrity layer (`football/cfb_lab/integrity.js`, docs/cfb-production/MARKET_INTEGRITY.md) are the
infrastructure; the market-intelligence layer reads them.

- Methods: [`METHODS.md`](METHODS.md) · results: [`BACKTEST.md`](BACKTEST.md) · deliverable map: [`DELIVERABLE.md`](DELIVERABLE.md)
- Audited 2026-09-27 against the repository at that date (the ledger counts are as of 16:07 UTC).

## 1. Verdict

- **Historical:** rich in lines, thin in prices and time. The cfbfastR multi-book archive has per-book CLOSING
  lines for 2006-2025 and closing PRICES for 2006-2019 (about 20 offshore books incl. Pinnacle, 2016-2019). It has
  an OPENER for only one book per era, with no opener timestamp, and nothing between the opener and the close.
- **Live:** real timestamps, one sportsbook. The Model Lab ledger holds 846 quotes for 2026 (604 `record` + 186
  `espn` quotes of DraftKings, 56 CFBD provider-mean quotes); 116 carry a price (ESPN's DraftKings rows since
  2026-09-27). No second sportsbook has reached the ledger yet: the Odds API path is built and fail-soft.
- **Consequence:** everything that needs several books, several timestamps or prices at once (intraday velocity,
  steam, stale-book detection, provider conflicts, multi-book line shopping, bet-now-vs-wait at 6/12/24 h) is
  implemented and tested on synthetic and live data, but can only be validated historically where the archive
  allows (opener vs close; 2016-2019 closes at real prices) or prospectively as the Lab accumulates quotes.

## 2. Sources

| source | what | books | markets | prices | timestamps | refresh | where |
|---|---|---|---|---|---|---|---|
| ESPN scoreboard | the line ESPN carries for its book; the declared opener; the line frozen at kickoff (declared close) | DraftKings | spread, total, moneyline | yes (since the Lab parses them) | `observed_at` = fetch time; no provider update time | hourly (Lab job, :07 with :37 backup) | `football/cfb_lab/market.js` `quotesFromEspn` |
| CFBD line ledger | provider-mean line + declared opener | `consensus` (a provider average, never a book) | spread, total | no | fetch time | daily (V2 shadow) | `football/cfb_v2/shadow/<season>/lines.jsonl` -> `quotesFromCfbd` |
| The Odds API | per-sportsbook quotes with the book's own `last_update` | every book the key returns (regions `us,eu` by default) | h2h, spreads, totals | yes (decimal -> American, half away from zero) | `observed_at`, `provider_updated_at` | capture cron: every 10 min near kickoff, :04/:34 day, every 4 h board | `supabase/functions/capture/index.ts` `cfbLabQuotes` -> `cfb_lab_ingest_quotes()` -> `sync_supabase.js` pull |
| football record | the record file's lines | DraftKings | spread, total | no | reconstruction time | on record builds | `source = 'record'` rows |
| cfbfastR archive | per-book open/close lines and prices | 20+ (2016-2019), 1-7 (2020-2025) | spread, total, moneyline | closes 2006-2019; the one opener book 2012-2019 | none (game date only) | static | `data/betting/cfb_line_odds.csv.gz`; copies in `football/pricing/lines_cfb.json`, `openers_cfb.json` |
| stage-2 market file | consensus open/close per game, book count, closing SD, Pinnacle close | derived | spread, total | no | none | pipeline | `out_h/stage2/market.parquet` |
| CFBD game lines | provider-mean spread, opening spread and total | derived | spread, total | no | none | pipeline | `data/mline/ml_<season>.parquet` |
| public betting (tickets / money) | — | — | — | — | — | — | **does not exist anywhere in the repository** |

### Archive coverage by era (spreads; FBS and FCS games)

| seasons | books with closes | closing prices | books with openers | opener prices | notes |
|---|---|---|---|---|---|
| 2006-2011 | 6-15 | yes | 0 (a handful of rows) | — | pre-DEV |
| 2012-2015 | 14-17 | yes | 1 (5Dimes) | yes | 2014-2015: burn-in |
| 2016-2019 (DEV) | 20-22 incl. Pinnacle | yes (98.4% of quotes) | 1 (5Dimes) | yes | the only seasons with real prices |
| 2020 (DEV) | 3-4 (Bovada, Caesars, SugarHouse) | no | 0 | — | no openers at all |
| 2021-2023 (DEV) | 5-7 (Bovada, DraftKings, ESPN Bet, William Hill/Caesars + provider averages) | no | 1-2 | no | 2023: Bovada + DraftKings openers |
| 2024-2025 (holdout) | 3-4 | no | 1-3 | no | |

Raw rows: 1,183,529; 998,701 distinct after V1's de-duplication; 352,825 canonical game x book x kind x market
rows after side resolution (`out_h/market_intel/archive_qa.json`: 395 closing spread pairs whose two sides
disagree about the number and 221 multi-row conflicts were dropped, never averaged).

## 3. Capabilities (brief §1)

| capability | exists | where / notes |
|---|---|---|
| odds providers | ESPN, CFBD, The Odds API, the record file, cfbfastR (historical) | §2 |
| supported books | live: DraftKings (+ CFBD provider mean); Odds API: whatever the key returns | one real book in the ledger today |
| refresh frequency | Lab hourly; capture 10 min / 30 min / 4 h; CFBD daily | `supabase/cfb_lab_cron.sql`, `supabase/capture_cron.sql` |
| spreads / totals / moneylines | yes / yes / yes | Lab quotes carry all three |
| alternate spreads / totals | capture reads them inside a market; the Lab keeps main lines only; `engine.js consensus()` and `decision.js decideGame` drop `alternate` | alternates are priced by `market_intel.altLinePrices`, never enter a consensus |
| timestamps | `observed_at`, `provider_updated_at` (Odds API only), `retrieved_at`, `kickoff_ts` | the TRUE age is the older of observed and provider update (`integrity.quoteAgeH`) |
| opening lines | Lab: per book the earliest ordinary quote; consensus of books opening within 24 h; provider-declared fallback (`lab_core.openerFrom`, write-once) | archive: one book, no timestamp |
| historical odds | cfbfastR archive, stage-2 file, CFBD lines | §2 |
| stale quote handling | Lab `marketAt` (36 h window, stale flag 6 h / 36 h); `integrity.assessMarket` (true age, stale share, 3 h for a BET); decision `stale_minutes` 180 | the market layer reuses integrity's limits |
| consensus | Lab median over each (source, book)'s latest quote, provider averages dropped when a real book quotes; `integrity.assessMarket` isolates MAD outliers and grades the consensus | |
| price / juice | Lab `medianPrice` in decimal space; decision `devig` (proportional), `breakEven`, EV with push; capture: Shin de-vig for multi-way markets | |
| market joins / game mapping | Odds API events joined by `joinSignalsToGames` (both teams in this orientation, kickoff within 36 h) into `cfb_lab_event_map`; refused and counted otherwise | |
| team mapping | `football/cfb_lab/identity.js` (the identity master over `fbs.js`), no substring joins | |
| CLV | Lab `clvPoints` / `clvPrice` against the derived consensus close; decision results | |
| reverse line movement | **none** (and the AI research layer forbids attributing any move to sharp or public money) | `market_intel.reverseLineMovement` is inert by design |
| public betting data | **none** | table `cfb_market_public_betting` exists, pinned to `decision_use = false` |

## 4. The canonical market format (brief §2)

**The Lab quote row is canonical** (`cfb_lab_market_quotes`, docs/cfb-lab/SCHEMA.md §2): one row per observed
change of one (source, book, game, market), both sides in one row, append-only. The brief's side-level fields are
derived from it, never stored twice: `market_intel.canonicalQuote(q)` in JavaScript, the view
`cfb_market_quotes_canonical` in Postgres (created by `supabase/cfb_market.sql` when the Lab table exists).

| brief field | canonical (Lab) column | rule |
|---|---|---|
| game_id | `game_id` | ESPN event id; Odds API events resolved through `cfb_lab_event_map` |
| sportsbook | `book` | lower-case key (`draftkings`); `consensus` = a provider average, never a sportsbook |
| market_type | `market_type` | `spread` / `total` / `moneyline` |
| side | derived | spread & moneyline: `HOME`, `AWAY`; total: `OVER`, `UNDER` |
| line | `home_line` (spread), `total_points` | the side's own number: HOME = `home_line`, AWAY = `-home_line` |
| **home_market_margin** | `-home_line` | THE internal convention: `Texas Tech -4.5` at home = **+4.5**, and `Baylor +4.5` is the same market state (+4.5). One conversion, `bookToMargin` |
| american_odds | `price_home` / `price_away` / `price_over` / `price_under` | null when not captured; **never assumed** |
| decimal_odds | derived | 1 + payout |
| implied_probability_raw | derived | 1 / decimal (with the vig; `decision.devig` removes it) |
| quote_timestamp | `observed_at` | when EdgeDesk saw it |
| provider_timestamp | `provider_updated_at` | the book's own `last_update` (Odds API) |
| received_timestamp | `retrieved_at` | when the fetch returned |

Sign-convention tests: `football/cfb_market/tests.js` (canonical: HOME -4.5 and AWAY +4.5 both +4.5; a home
underdog +3 is -3; a pick is 0, never -0; the live ledger's every quote maps exactly as `lab_core.conv`
converts it), `football/cfb_market/sql.test.js` (the Postgres view), `football/cfb_v2/research/v2/market_intel/tests_market.py`
(the research side), beside the repository-wide `football/cfb_lab/sign_suite.test.js`.

### Mapping from every source

| source | side resolution | home_market_margin |
|---|---|---|
| ESPN | the record's orientation-checked reader (`SRC.espnLine`) | `-home_line` |
| CFBD ledger | the ledger stores `current_home_line` / `open_home_line` | `-home_line` |
| The Odds API | outcomes matched to the event's home and away names; both sides must agree about the number or the market is skipped | `-home_line` |
| record | the record's own home line | `-home_line` |
| cfbfastR archive | `abbr` -> team id by intersection over every game (V1 `build_market.resolve_abbr_sides`, never string matching); both sides must negate each other | `-home_line` (`v2.market_intel.data.archive`) |
| stage-2 market file | already internal (`spread_open`, `spread_close` are home margins) | as stored |
| CFBD game lines (`data/mline`) | `spread` is a home line | `-spread` |

## 5. Immutability (brief §3)

Already in place and reused: `cfb_lab_market_quotes` is append-only (update / delete / truncate raise, service role
included); a quote is written only when its values change (plus 6 h and close-zone heartbeats, `lab_core.dedupeDecision`);
yesterday's -3 is never overwritten by today's -4.5. Impossible quotes are REJECTED and outliers QUARANTINED into
`quarantine.jsonl` / `cfb_market_quote_quarantine` (kept, never deleted). Openers and closes are write-once
(`cfb_lab_market_lines`), corrections are separate rows (`cfb_market_line_corrections`). The market layer adds
append-only tables of its own (`supabase/cfb_market.sql`) and never writes into the Lab's.

## 6. What the audit changed

Nothing in the existing infrastructure. Additions only: the market-intelligence functions
(`football/cfb_market/market_intel.js`), the runner over the Lab ledger (`run.js`), the research package
(`football/cfb_v2/research/v2/market_intel/`), the Postgres contract (`supabase/cfb_market.sql`) and these documents.
