# Profit & Loss — the Record's economic layer

**The question:** if a reader had followed every EdgeDesk recommendation, at the
price EdgeDesk recorded when it made it, how many units would they be up or down?

The P&L layer sits **on top of** the ledgers the pipelines already keep. It
predicts nothing, prices nothing and grades nothing itself. It copies each
recommendation as it was made and each settlement as the settling job wrote it,
then does the arithmetic. It adds an analytical layer to the existing Record and
replaces none of it. The ATS / totals / straight-up record, CLV, week by week and
the game ledger (Records → *Football model record*) are untouched, and so is the
edges record.

## Pieces

| Piece | What | Where |
|---|---|---|
| Kernel | American-odds profit, flat vs staked, ROI, drawdown, streaks, CLV, calibration, breakdowns, sample labels. Browser + Node, one implementation. | `lib/edgedesk_pnl.js` (`window.EDPnl`) |
| Ledger builder | Reads the source ledgers and writes one row per recommendation. Idempotent, logs corrections, never deletes. | `tools/record/pnl_core.js`, `tools/record/pnl_ledger.js` |
| Price lock | The quote EdgeDesk stored at or before a model number was published, frozen on the pick; the historical backfill is the same lookup. Config: the default stake and the freshness limits. | `tools/record/price_lock.js`, `tools/record/pnl_config.json`, `football_record_core.js` `lockPrice` |
| Quote ledger | Every priced pregame ESPN reading of every NFL and college game the model publishes a number on, kept append-only (written on a change and on a heartbeat, never after kickoff): the stored price a model decision can be locked to. NFL games are matched through nflverse's own ESPN id. | `tools/record/quote_ledger.js`, written by `tools/record/football_record.js` to `record/football/quotes/<sport>_<season>.jsonl` |
| Committed artifacts | `ledger_<season>.json` (the audit ledger), `rows_<season>.json` (the page's columnar copy), `summary.json` (every figure precomputed) | `record/pnl/` |
| Database | `model_pnl` plus the append-only `model_pnl_corrections`, a trigger-derived P&L and **record state**, the build's pending reasons, the canonical record view, a public view, SQL rollups / drawdown / a daily materialised series, and a reader's own dollars; **Verified P&L**: `pnl_verified` / `pnl_exclusion_reason` / `stake_source` / the one-time price lock by trigger, `model_pnl_quotes` (the stored quote every locked price cites, append-only), and `verified_pnl_decisions` / `_summary` / `_breakdown` / `_series` / `_integrity` | `supabase/model_pnl.sql`, `supabase/model_pnl_states.sql`, `supabase/model_pnl_analytics.sql`, `supabase/model_pnl_verified.sql`, `supabase/model_pnl_quotes.sql`, `supabase/model_pnl_verified_views.sql` (in that order), `supabase/verified_pnl_report.sql` (read only) |
| Sync | Sends every stored quote a locked price cites through `model_pnl_quotes_put()`, the committed ledger through `model_pnl_upsert()`, then the pending reasons through `model_pnl_reasons()`. Then it proves the database says what the page says: `verified_pnl_summary()` against the kernel's card over the same ledger (both strategies) and `verified_pnl_integrity()` at 0. Without secrets it logs and exits 0. With them it never fails quietly: a missing schema exits 3, a disagreement exits 4, each with an error annotation and a run-summary line. | `tools/record/pnl_sync.js` |
| Schema deploy | Manual: the SQL suite on a throwaway PostgreSQL, then the six files in order with `ON_ERROR_STOP`, then the sync and the A–I report. Opt-in: re-apply `bettor_decisions.sql`. | `.github/workflows/deploy-record-pnl.yml` |
| UI | The Records page's profit and loss: the view (tabs, period, stake, leans), the verified P&L summary, its chart, the graded record directly under it, *How P&L works* and *Advanced Analytics* (both collapsed), and the ledger | `lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`. It is the top of the app's Records page (the detailed edges and football model records sit inside its Advanced Analytics) and `#pnl` on the public `record.html`. |
| Job | The only writer of `record/pnl/`. Runs after Player props, CFB Model Lab and Football model record, plus an hourly sweep. | `.github/workflows/record-pnl.yml` |
| Tests | Kernel, ledger, Verified P&L (price lock, backfill, audit), real PostgreSQL, real browser | `tools/record/pnl*.test.js`, `tools/record/verified_pnl.test.js`, `.github/workflows/record-pnl-tests.yml` |

## Sources, and what each can honestly give

| Source | Recommendation | Entry price | Settled by | P&L |
|---|---|---|---|---|
| Player props, NFL + CFB: `football/props/<lg>/<season>/evaluations.jsonl` (kind `qualified`: BET, LEAN) | frozen pregame, write-once | **yes**: American, book, (new rows) quote capture time | `football/props/grade.js` → `results.jsonl` | **verified** |
| Game decisions: `football/cfb_terminal/decisions/<season>/snapshots.jsonl`, first snapshot per class per game (BET / LEAN / WATCH / PASS), and any other league's decision ledger added to `DECISION_LEDGERS` | frozen pregame, write-once | **yes**: `bet_price` or `reference_quote` | `EDDecisionTrack.gradeEvaluation` (CFB Model Lab job) → `evaluations.jsonl` | **verified** |
| Football model record: `record/football/<sport>_<season>.json` | the published fair number, graded at the close | **only through the price lock**: the quote EdgeDesk *stored* at or before the number was published, for the exact number graded (`pick.price_lock`, `tools/record/price_lock.js`) | `tools/record/football_record_core.js` | **verified** when locked (at the default stake); otherwise a **record-only** result with its reason |

Every source above records the recommendation **when it is made, before kickoff**, with everything P&L needs: the selection, market, line, American price, book, stake (BET), timestamp, model version, model probability, edge and game id. The props ledger refuses a row evaluated after kickoff (`football/props/verify_ledger.js`), the decision ledger refuses a post-kickoff snapshot, and the P&L ledger marks any recommendation stamped after its game started `INVALID`. Nothing is ever reconstructed after the fact. The model record is the exception by design: its market numbers are nflverse / ESPN reference lines, *"not a price, no book, no capture time"* (`football/nfl/slate.json` `reference_market`), so its rows stay record-only.

## One state per recommendation

Every row resolves to exactly one `record_state` (`lib/edgedesk_pnl.js` `stateOf`, mirrored by the `model_pnl_state_trg` trigger):

| State | Meaning | Counts in |
|---|---|---|
| `PENDING` | not settled yet; `pending_reason` says why | nothing until it settles |
| `VERIFIED` | settled W / L / P at a captured entry price | the record **and** P&L |
| `RECORD_ONLY` | settled, but no usable entry price (never captured, assumed, or malformed) | the record (W-L-P) only — *Record only · Price unavailable*, with its `pnl_exclusion_reason` |
| `VOID` | cancelled / did not play: stake returned | neither |
| `INVALID` | cannot be graded as recorded: a settlement that is not a result, a recommendation stamped after kickoff, a row with no game or no side — with `state_reason` | neither, and it is shown |

**Why pending.** `tools/record/pnl_core.js` `pendingReason` places every pending row, as of the build:

| Reason | When |
|---|---|
| Upcoming game | before kickoff |
| Game in progress | within 5 h of kickoff |
| Game finished, awaiting the settlement run | the settling job has not run since kickoff (props, first 11 h), or a final is held and the decision grader's 40 h window is still open |
| Game finished, awaiting the stat feed | the props grader says the box score is not published, within 48 h |
| Missing final | the game is known but no final is held 5 h after kickoff |
| Missing player stat | the box score is still not published 48 h after kickoff |
| Settlement job failed | the props grader could not load its dataset, has not run for hours since kickoff, or ran and neither settled the prop nor said why; or a held final has gone unsettled past the decision grader's window |
| Missing mapping | the game is not in the schedule feed (props) or not known to EdgeDesk at all |

The props grader writes its own reasons to `football/props/<lg>/settlement.json` (`pendingStatus`) instead of dropping them, and the CFB decision grader no longer waits forever for a closing line: a final with no close grades after 36 h, with no CLV (`football/cfb_terminal/decisions.js` `gradeable`).

**The canonical record.** The ledger rows are the one normalized dataset; in the database they are `model_record_canonical`: `id`, `sport`, `league`, `game_id`, `event_time`, `market_type`, `player`, `selection`, `model_value`, `entry_line`, `entry_odds`, `closing_line`, `closing_odds`, `recommendation_grade`, `stake_units`, `final_result`, `settlement_result`, `pnl_units` (staked) / `flat_pnl_units`, `clv`, `model_version`, `pnl_status`, `record_state`, `pending_reason`, `settled_at`. Every widget on the page reads the same rows (`record/pnl/rows_<season>.json`).

Left out on purpose, and counted on the page with the reason:

- **CFB Model Lab** research positions graded at an **assumed −110** (`price_assumed`). These are simulated. They are never verified P&L and never mixed with it.
- **Lab replays** (`origin: REPLAY`). These are backtests, not recommendations that existed at the time.
- **The shadow CFB decision engine** (`football/cfb_decision/`). Its calls are not published recommendations.

Also left out:

- `signals`, the edges record. Its own recorded P&L lives in the database beside it (`pnl_grades`, `docs/pnl/EDGE_PNL.md`), and is shown as its own section on the public record. The two layers are never summed.
- The per-reader AI-desk tables (`stake_recommendations`, `recommendation_ledger`). Those are one reader's own answers, not the public model's recommendations.

## The page

The Records page answers, on the first screen: how many recommendations EdgeDesk has graded and its W-L-P; whether verified priced bets are profitable (net units, ROI); how many are pending; how much history can never carry exact P&L; and where the record comes from.

It answers **how has the model performed?** and **would the priced decisions have made money?** as two sections that are never mixed:

1. **Model performance** (the headline): the graded record — W-L-P, win %, graded decisions — and each market's record (spread, totals, moneyline, player props). Never units. The player props tile also shows the leans tracked beside the bets; they enter the record and P&L only when the reader includes leans. With nothing graded in the view, it says what is tracked.
2. **Verified P&L**, directly under it, with its chart (§ Verified P&L): net units, ROI, the priced decisions, *N of M graded decisions included · K record-only excluded*, units risked, and each market's own figures.
3. **Historical model results**: what the two cards do not already say. That is the split by sport; how many graded decisions are **record only** and why (no stored quote, the line had moved, no source for the league); and how many recommendations are pending and why. Never units, never the same numbers twice.
4. **Filters**:
   - tabs ALL / CFB / NFL / PLAYER PROPS, each carrying its P&L at the graded price over its graded record, else its graded record, else *Pending*. CFB and NFL are game markets only; every prop is under PLAYER PROPS, so ALL = CFB + NFL + PLAYER PROPS;
   - **Share** (`lib/edgedesk_record_card.js`): the view on screen as an image (X 1600×900, square, story) and a post under 280 characters, with the link `record.html?view=<tab>#pnl` back to it. The card computes nothing, says how its units were priced, prints Verified P&L beside closing-price units, and carries the sample and "21+";
   - **P&L at the graded price** (`EDPnl.gradedPnl`): every graded pick in units at the price of the line it was graded at, so units and record describe the same picks. The model's game picks are graded at the close, so they are priced at the closing price the model record keeps with the closing line (`closing_odds`: nflverse consensus for the NFL, the ESPN book for college). Player props keep their captured price. A pick with no closing price is unpriced, never assumed. Shown above Verified P&L where any pick is priced at the close, and never counted as Verified P&L;
   - a market (All / Spread / Totals / Moneyline / Player props);
   - a period (Season, the default; 30 days; 7 days; All time);
   - a stake choice (Recorded stakes, the default, or Flat 1u);
   - *Include leans*, off by default.
5. **The ledger**, three views:
   - ***Verified P&L***: the settled priced decisions (date, sport, bet, odds, result, units). Its total is the card's net.
   - ***Historical graded***: every graded decision, with its price, stake and units, or *Record only · Price unavailable*. Its count is the record's.
   - ***Pending***.

   A row opens to its audit: model number, lines, CLV, edge, price and where it came from, book, model version, decision and price times, stake and whether it was defaulted, whether it is in Verified P&L and why not, state, why pending, and corrections.
6. ***How P&L works*** and ***Advanced Analytics***, collapsed. Advanced holds:
   - the record by sport, market, model version, week and grade;
   - the verified P&L tables (more numbers, drawdown, game markets vs props, every breakdown by month and price source too, calibration, CLV vs P&L), or with nothing settled, one *Waiting for settlement* line instead of tables of zeros;
   - player prop performance;
   - every row's state, *why pending* and the agreement checks;
   - in the app, the detailed edges and football model records.

**Empty is not zero.** `0.00u` only when the arithmetic ran and gave zero; `—` when it cannot be computed (the kernel's `summarize` returns `null`, not `0`, with no settled bet); *Waiting for settlement* when the bets exist and have not finished; *Record only · Price unavailable* when a result exists but no verified price does.

**One dataset, checked.** The page filters the ledger rows once — scope, market, period, the graded decisions (model picks and BETs; LEAN only when included), recorded stakes or flat — and the summary, the record, the tabs, the chart, the advanced figures and the ledger are all computed from that set by the kernel. `EDPnl.integrity()` proves it on every render: the hero's bet count is the ledger's qualifying rows, its net is their sum, the chart ends there, the breakdowns by sport and market add up to it, the record equals the sum of its markets and of its sports, every row is in exactly one state, every verified row is priced, no record-only row carries units. A failure is shown as an *internal check failed* banner (and fails the ledger job, `pnl_ledger.js` exits 2) — never two quietly different numbers. `tools/record/pnl_ui.test.js` checks the page against the kernel under every scope, period, stake and the leans switch.

**Live.** The ledger job writes `record/pnl/stamp.json` (its rows' digest; it changes only when they do). The open page polls it every 5 minutes (and when it becomes visible again) and re-reads the ledger after a settlement run — new finals → graded → P&L → summary, record, chart and breakdowns, with no one editing anything.

## The rules

1. **The strategy is the graded record.** Verified P&L, its chart and most breakdowns cover every graded decision — the model's published number on a game and every BET (LEAN when the reader counts leans) — that settled at a verified price. The record and the P&L describe one set: graded = verified + record only (§ Verified P&L).
   - LEAN, WATCH and PASS are graded at a flat 1u **at their own recorded price**, only in *By recommendation grade*. That is how to tell whether the gating adds value.
2. **Two strategies, never mixed.**
   - **Flat 1u** risks exactly 1.00u on every bet.
   - **EdgeDesk staking** risks the units recommended at the time (0.25 / 0.50 / 0.75 / 1.00u).
   - They are separate columns (`flat_profit_units`, `profit_units`) and separate views.
3. **Never invent a price.**
   - No captured entry price means no P&L: `NO_ENTRY_PRICE`, "P&L unavailable — entry price not captured".
   - The result still counts, in a record-only W-L that is shown **by market** (a straight-up record and a record against the spread are not the same thing).
   - `0`, `null`, `undefined`, `NaN`, non-numeric strings and anything between −100 and +100 are not American odds.
   - A negative stake is refused.
4. **Arithmetic.**
   - A win pays `stake × odds/100` at positive odds and `stake × 100/|odds|` at negative odds.
   - A loss costs the stake. A push and a void are 0.
   - **ROI = net profit ÷ total risked × 100.**
   - A push or a void returns the stake, so it adds nothing to *risked*. This is the player-prop record's own convention, so the two never disagree about the same bet.
   - Win rate = W ÷ (W + L).
   - Average odds is the stake-weighted mean **decimal** price shown as American. Break-even = 1 ÷ that price.
   - Profit factor = gross units won ÷ gross units lost.
   - Drawdown is measured from the running peak of cumulative units, which starts at 0.
5. **Historical means historical.** Every price, line, stake, probability, edge and model version is the one recorded when the recommendation was made. Nothing is re-priced with today's odds or re-predicted with today's model.
6. **Samples.** Every figure carries its n and a label: n < 20 *very small*, 20–49 *small*, 50–99 *developing*, 100+ *more meaningful*.
   - Calibration judges a bucket only past 50 bets, and only when the gap exceeds the bucket's own binomial noise (±1.96 SE).
   - A player's line is never read as proof that the player is profitable to bet.

## Verified P&L

**The rule: NO PRICE = NO VERIFIED P&L.** Two questions, kept apart:

- **Model performance** is how often the model was right: every graded decision as W-L-P, priced or not.
- **Verified P&L** is whether the priced decisions would have made or lost units. It counts only decisions with a real historical price.

A win/loss record is never turned into a profit.

### The verification rule

A decision is `pnl_verified` only when all of these hold:

- it has a valid settled result (W / L / P);
- it has a valid American price (|odds| ≥ 100);
- it has a stake;
- it has an identifiable market and selection;
- its price existed **at or before** the decision (`odds_captured_at ≤ recommended_at`).

Anything else carries exactly one `pnl_exclusion_reason` (`lib/edgedesk_pnl.js` `EXCLUSION`, mirrored by the `model_pnl_verify` trigger). Nothing is silently dropped.

| Reason | When |
|---|---|
| `missing_settlement` | not settled (or an unreadable settlement) |
| `missing_price` | the source never captured a price with the decision |
| `historical_price_unavailable` | a model number with no stored quote for that exact selection at or before it; `price_lookup.why` says which case: `before_capture` (published before EdgeDesk stored every game's quotes for that league), `no_snapshot`, `stale`, `line_moved`, `no_side_price` or `no_snapshot_source` (a league with no stored-quote source) |
| `price_after_decision` | the only price was captured after the decision |
| `invalid_odds` / `simulated_price` / `missing_stake` | a malformed price, an assumed price, an invalid stake |
| `missing_selection` / `recommended_after_start` | an invalid row |
| `void` | cancelled; nothing risked |

### Stakes

The stake is **risked**, not "to win".

- **Explicit.** A decision that recorded a stake risks it (a BET's 0.25–1.00u). `stake_source = 'explicit'`.
- **Default.** A graded pick that recorded none (the model's number) risks the default **once a real price is locked to it**, frozen with the price. `stake_source = 'default'`. The default is 1.00u, set in `tools/record/pnl_config.json` `default_stake_units`. A lean the reader counts does the same on the page.
- **Never invented after the fact.** No variable confidence stake is applied retroactively.
- **Two views.** *Recorded stakes* is the default view; *Flat 1u* is the other, and the two are never mixed.

### Arithmetic

- **A win** pays `stake × odds / 100` at plus odds and `stake × 100 / |odds|` at minus odds.
- **A loss** costs `−stake`; a push and a void pay 0.
- **Storage.** Units are stored to 6 places (a −110 win is +0.909091u), in `numeric` in Postgres. Pages round to 2 places.
- **ROI** = net ÷ units risked × 100, where *risked* counts wins and losses only.

### The price lock, and the historical backfill

The model record publishes a number and is graded against the close. Nothing captured a price with that number, and the record's own market quotes were captured *after* it. The **only** honest price for such a decision is one EdgeDesk itself **stored at or before** the number was published.

| Step | Rule |
|---|---|
| Source | Stored, timestamped, per-side sportsbook quotes, configured in `tools/record/pnl_config.json` `price_snapshots.sources`: the CFB Model Lab's `football/cfb_lab/ledger/<season>/quotes/` (ESPN / DraftKings, hourly, append-only, the lab's games only, from 2026-09-27T15:07Z), and the record's own `record/football/quotes/<sport>_<season>.jsonl` (every game the model prices, NFL and CFB, from its first run after this change). A source says what it `covers`: `every_model_game` sets the earliest point from which every decision of a league can be verified. |
| As of | Per book, the latest ordinary pregame quote observed at or before the decision. The lab writes on change plus a heartbeat, so that row *is* the price then, while it is younger than 6 h (90 min inside 3 h of kickoff, the decision engine's limit). Older: `stale`. |
| Never | A quote after the decision, the close, today's odds, an assumed −110, a provider average ("consensus"), or the best price across books (line shopping after the fact). |
| Which book | The book of the decision's own market (the record's ESPN book). Otherwise the most recent quote, with ties going to the lower payout. |
| Which number | The model's decision is graded on one exact selection (its side at the closing number). A lock prices it **only when the stored quote was for that number**; a moneyline has none. If the market stood at another number, it was a different bet: `line_moved`. Nothing is moved, interpolated or re-graded. |
| Where it lives | `pick.price_lock` in `record/football/<sport>_<season>.json`, written by `tools/record/football_record.js` on every run (online or offline). |
| Immutable | A locked market is never rewritten. A revised number is a new pick with its own lock. A miss is looked up again, because a quote committed late can still have been observed before the decision. |
| The backfill | The same lookup, over picks recorded before the lock existed. It reads only quotes observed at or before the decision, so it gives today exactly the answer it would have given then. Running it twice changes nothing. |
| Into the ledger | `pnl_core.modelRecordRows` prices the graded selection from the lock: `price_source = 'snapshot'`, `price_ref` = the quote's id, game, number, book and times. The merge lets a row with **no** price receive one **once** (`LOCK` fields, `price_locked_at`); after that it is frozen like the rest of the recommendation. A later re-pricing is refused and reported as an integrity alert. In the database the `model_pnl_derive` trigger enforces the same one-time transition. |

**What the sample is.** The model's numbers are usually published days before kickoff and graded at the close. So a model number is verified only when the market still stood at the graded number when the number was published. That set is smaller than the record. It is a set of bets that really existed at those prices, never a re-graded one.

### Price locking for new decisions

- **Props and BETs** carry their price from the moment they are made (write-once ledgers). Nothing changes for them.
- **Model numbers.** Every hourly *Football model record* run first keeps every priced pregame ESPN reading of every game ahead (the quote ledger), then locks each new or revised pick against the quotes stored at or before its publication. Because the job runs hourly and a heartbeat is written at least every 6 h (every 50 min inside 3 h of kickoff), a number published between two runs finds the previous run's reading. The record-pnl job then picks the lock up on its next run.
- **Before capture.** A model number published before its league's every-game quote ledger began, with nothing stored for its game, is record only with `price_lookup.why = before_capture`. `summary.json` `verified.price_sources` gives the first stored quote per league, and *How P&L works* prints it.
- **Live odds** keep refreshing everywhere else. The P&L price attached to a decision never moves.

### Integrity

These are checked by `EDPnl.auditRows` (the ledger build fails on any), `verified_pnl_integrity()` (the database) and the page's agreement checks:

- a verified WIN with null odds;
- a verified LOSS with no stake;
- one decision twice;
- odds of 0 or between −100 and +100;
- a price later than its decision;
- a verified row with no result;
- a stored-quote price for another game or another number;
- a verified prop with no player or market;
- units that do not match stake × odds × result;
- a row outside Verified P&L with no reason;
- graded ≠ verified + record only.

In the database, every locked price is also checked against the stored quote it cites in `model_pnl_quotes`: same game, market, number, time and price, and never after the decision (`snapshot_quote_mismatch`, `snapshot_quote_missing`). Where the CFB Model Lab's own mirror `cfb_lab_market_quotes` is deployed (production), lab-sourced locks are checked against that independent copy too (`lab_mirror_mismatch`).

### The page

| Section | What it shows |
|---|---|
| **Model performance** (the hero) | W-L-P, win %, graded decisions, each market's record. Never units. |
| **Verified P&L** (the card under it) | Net units first, the largest number; ROI second; the priced decisions and their W-L-P with a sample tag. Then *"N of M graded decisions included · K record-only decisions excluded"*, the details (net, ROI, units risked, priced, record only) and Spreads / Totals / Moneylines / Player Props each with its units, ROI and priced count. A market with nothing settled at a verified price shows `—`, never `0.00u` or `0%`. The info button reads: *"Verified P&L includes only settled decisions with a historical market price captured by EdgeDesk. Record-only decisions without a verified price are excluded."* |
| **The chart** | Cumulative verified units only. |
| **Historical model results** | A priced decision reads `−108 · 1.00u risked · +0.93u` (with *default* when the stake was defaulted). A record-only one reads `Record only · Price unavailable`, and its audit says why. |
| **Filters** | Sport tabs, market, period and leans move the record and the Verified P&L together. |

Before the 1.7 MB rows file arrives, the card is drawn from the build's precomputed `summary.json` `verified.views`, so the first paint answers "is it up or down?".

### Data model

There is no new table: `model_pnl` already held the immutable financial snapshot. The spec's names are exposed by the view `verified_pnl_decisions`:

| Spec name | Column |
|---|---|
| `decision_id` | `recommendation_id` |
| `american_odds` | `entry_odds` |
| `book` | `entry_book` |
| `price_timestamp` | `odds_captured_at` |
| `decision_timestamp` | `recommended_at` |
| `line` | `closing_line` for a model number, else `entry_line` |
| `prop_type` / `prop_line` / `over_under` | `prop_market` / `entry_line` / `side` |
| `stake_units`, `stake_source`, `result`, `profit_units`, `settled_at`, `pnl_verified`, `pnl_exclusion_reason` | as named |

## Idempotency and corrections

- A row's key is its **recommendation id**: `pp:<evaluation_id>`, `bd:<snapshot_id>`, or `mr:<sport>:<game_id>:<market>`.
- Rebuilding from the same inputs changes nothing: `--check` proves it, and the only clock on a row is when it first appeared or was corrected.
- A duplicated source row or a duplicated settlement is one row.
- **Frozen:** the recommendation half of a row (side, selection, lines, price, book, stake, grade, model version, times). A source that tries to change it is refused, and the refusal is reported as an integrity alert.
- **Corrections:** a settlement that changes after it was settled updates the **same** row and is appended to its `corrections` (from, to, when, why). Nothing is deleted. A row whose source line vanished is kept and flagged `source_missing`.
- **Player stats:** `football/props/grade.js` now re-reads the official statistic behind every settled grade for 14 days after kickoff.
  - Where the statistic changed, it **appends** a correction row (`correction: true`, `corrects: <graded_at>`, the reason).
  - It never voids a graded bet because a feed dropped a line.
  - The latest row per evaluation is the settlement. `verify_ledger.js` accepts a correction only if it names the grade it corrects and comes after it.
- **In the database:** `model_pnl_upsert()` inserts, updates a moved settlement, or leaves the row alone.
  - A trigger derives the P&L from the stored price, so no client can store an invented figure.
  - The trigger refuses any change to the recommendation half, and appends every correction to `model_pnl_corrections` (append-only).
  - Delete and truncate are refused.

## Security

- `model_pnl` has RLS on and no client policy; only `service_role` writes, and only through `model_pnl_upsert()`.
- Readers (anon included) get `model_pnl_public`, which carries public fields only, plus the rollups and the daily series.
- Dollars never live in the table. `model_pnl_my_dollars()` is SECURITY INVOKER and reads the caller's own `bankroll_settings` row under its RLS.
- The app's dollar toggle uses the reader's own unit: device settings, or their server row when signed in. There is no default dollar amount anywhere.
- The public page shows units only and needs no login.

## Where the data stands (2026-10-03, after the backfill)

- **762 graded decisions** (452-306-4): **31 verified**, **731 record only**, and they reconcile.
- **Verified P&L: +0.42u on 13.00u risked, ROI +3.21%**, 14-17, recorded stakes.
- **Verified by market:**

  | Market | Verified | Units | ROI | Record only |
  |---|---|---|---|---|
  | Spreads | 1 | −1.00u | — | 268 |
  | Totals | 1 | +0.87u | — | 199 |
  | Moneylines | 5 | +2.34u | +46.8% | 264 |
  | Player props | 24 | −1.79u | −29.8% | 0 (155 priced, pending) |
- **The backfill locked 7 CFB model decisions** (5 moneylines, 1 spread, 1 total) from the lab's stored quotes. The quotes start 2026-09-27, and only 5 graded games fall inside them.
- **Why the rest stay record only:**
  - 723 were published before EdgeDesk stored every game's quotes for their league (`before_capture`): 625 CFB with no lab quote, 98 NFL, where nothing stored a timestamped game price until the quote ledger;
  - 8 had a stored quote at the decision for another number than the one graded (`line_moved`).
- **Where stored prices begin** (the earliest point from which Verified P&L can be calculated):

  | Decisions | From |
  |---|---|
  | Player props, BETs | their first decision: the price is captured with it (the props ledger began 2026-09-30) |
  | CFB games the lab tracks | 2026-09-27T15:07:15Z, the lab's first stored quote |
  | Every CFB and NFL game the model prices | the quote ledger's first run after this change merges; `summary.json` `verified.price_sources.every_game_from` records the moment |

- **The audit.** `docs/pnl/AUDIT.md` traces a spread, a total, a moneyline and a player prop from the decision to the page, row by row, and lists what production was missing.
- **Every lab-covered game that settles from here is priced automatically**, about 66 more games across weeks 5–6.
- **0 integrity errors.**
- **Checked and not usable:**
  - the record's own `market_pick` / `entry` quotes: captured after the pick, no prices;
  - `close.prices`: the close, never an entry;
  - the nflverse reference line: "not a price, no book, no capture time";
  - `articles/data/market/*`: never within 6 h before a decision.
  - `signals` / `book_quote_ticks` exist only in the database. They key games by Odds API ids and carry no ESPN id, so they are not matched here.

## Where the data stood (2026-10-01)

- 2,052 rows, each in one state: **1,332 pending** (every one an upcoming game: props on Oct 2–5, CFB decisions on Oct 2–10), **720 record only**, 0 verified, 0 void, 0 invalid.
- **The graded record: 432-284-4 (60.3%) over 720 decisions**, Sep 11 – Sep 29 — spread 123-136-4 (263), totals 99-95 (194), moneyline 210-53 (263); NFL 56-37-2, CFB 376-247-2. Every one of them is *Historical P&L unavailable*: the model record never captured an entry price.
- **0 verified P&L bets — waiting.** 133 priced player-prop BETs are pending; the first settles after PIT @ CLE on 2026-10-02. No prop has finished yet (the props ledger began on 2026-10-01), so every player's W-L-P is honestly *—*, not 0-0-0.
- The record starts at NFL and CFB week 2: the model's first pregame number was published on 2026-09-16, so week 1 has nothing to recover (a number published after kickoff is refused).
- **No NFL game-decision ledger exists yet.** The NFL game markets are record-only until one does; the builder already reads any league's decision ledger, and the tests prove NFL spread, total and moneyline P&L.

## Commands

```
npm run record:pnl            # rebuild record/pnl/ from the settled ledgers
npm run record:pnl:dry        # what would change
npm run record:pnl:check      # exit 1 if record/pnl/ is stale
npm run record:pnl:sync       # the idempotent copy into Supabase (needs SB_URL / SB_SERVICE_ROLE)
npm run record:pnl:test       # kernel + ledger + Verified P&L + the quote ledger
npm run record:pnl:verified   # Verified P&L: the arithmetic, the price lock, the backfill, the audit
npm run record:pnl:backfill   # lock historical prices from the stored quotes, then rebuild record/pnl/ (offline)
npm run record:pnl:sql        # both migrations against a real PostgreSQL
npm run record:pnl:e2e        # the section in Chromium at 375 / 390 / 430 / 768 / 1440 px
```

## Deploy

1. Run **Deploy Record P&L schema** (`.github/workflows/deploy-record-pnl.yml`, manual). It tests the SQL on a throwaway PostgreSQL, applies `supabase/model_pnl.sql`, `model_pnl_states.sql`, `model_pnl_analytics.sql`, **`model_pnl_verified.sql`**, **`model_pnl_quotes.sql`** and **`model_pnl_verified_views.sql`** in that order (each in one transaction, stopping at the first error or `CHECK THIS`), syncs, and prints the A–I report. It needs `SB_DB_URL`. Without it, paste the six files into the SQL editor in that order; every report row should read `ok`.
   - `model_pnl_states.sql` and `model_pnl_verified.sql` are additive: on a database that already holds rows, they derive every row's state, stake source and verification in place.
   - `model_pnl_verified.sql` supersedes the derive trigger and the upsert, so re-apply it whenever `model_pnl.sql` is re-applied.
1a. **The Verified P&L backfill.** This needs no database and no network: the quote ledgers are committed.
   - Run *Football model record* once from the Actions tab. It writes `pick.price_lock` for every pick, the historical ones included.
   - *Record P&L* follows it automatically (`workflow_run`). It rebuilds `record/pnl/`, where the locked rows become verified exactly once, and syncs them to Supabase (`[pnl sync] … prices locked N`).
   - To run it locally: `npm run record:pnl:backfill`.
   - To read the result: paste `supabase/verified_pnl_report.sql`.
2. Merge. `record-pnl.yml` rebuilds `record/pnl/` after each settlement job and syncs it to Supabase when the secrets are set.
3. Backfill: the first `record-pnl` run after the merge rebuilds `record/pnl/` with every row's state, the pending reasons, the graded record and `stamp.json` (the same idempotent build; a page open at the time reloads when the stamp first appears), then upserts the full committed ledger. This is historical NFL and CFB records without prices (marked, never priced), plus every priced recommendation.
