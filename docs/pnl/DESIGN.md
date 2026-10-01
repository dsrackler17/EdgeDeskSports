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
| Committed artifacts | `ledger_<season>.json` (the audit ledger), `rows_<season>.json` (the page's columnar copy), `summary.json` (every figure precomputed) | `record/pnl/` |
| Database | `model_pnl` plus the append-only `model_pnl_corrections`, a trigger-derived P&L and **record state**, the build's pending reasons, the canonical record view, a public view, SQL rollups / drawdown / a daily materialised series, and a reader's own dollars | `supabase/model_pnl.sql`, `supabase/model_pnl_states.sql`, `supabase/model_pnl_analytics.sql` |
| Sync | Sends the committed ledger through `model_pnl_upsert()`, then the pending reasons through `model_pnl_reasons()`. Soft-fails without secrets. | `tools/record/pnl_sync.js` |
| UI | The Records page's profit and loss: the view (tabs, period, stake, leans), the verified P&L summary, its chart, the graded record directly under it, *How P&L works* and *Advanced Analytics* (both collapsed), and the ledger | `lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`. It is the top of the app's Records page (the detailed edges and football model records sit inside its Advanced Analytics) and `#pnl` on the public `record.html`. |
| Job | The only writer of `record/pnl/`. Runs after Player props, CFB Model Lab and Football model record, plus an hourly sweep. | `.github/workflows/record-pnl.yml` |
| Tests | Kernel, ledger, real PostgreSQL, real browser | `tools/record/pnl*.test.js`, `.github/workflows/record-pnl-tests.yml` |

## Sources, and what each can honestly give

| Source | Recommendation | Entry price | Settled by | P&L |
|---|---|---|---|---|
| Player props, NFL + CFB: `football/props/<lg>/<season>/evaluations.jsonl` (kind `qualified`: BET, LEAN) | frozen pregame, write-once | **yes**: American, book, (new rows) quote capture time | `football/props/grade.js` → `results.jsonl` | **verified** |
| Game decisions: `football/cfb_terminal/decisions/<season>/snapshots.jsonl`, first snapshot per class per game (BET / LEAN / WATCH / PASS), and any other league's decision ledger added to `DECISION_LEDGERS` | frozen pregame, write-once | **yes**: `bet_price` or `reference_quote` | `EDDecisionTrack.gradeEvaluation` (CFB Model Lab job) → `evaluations.jsonl` | **verified** |
| Football model record: `record/football/<sport>_<season>.json` | the published fair number, graded at the close | **never captured** | `tools/record/football_record_core.js` | none. The row is a **record-only** result marked `NO_ENTRY_PRICE` |

Every source above records the recommendation **when it is made, before kickoff**, with everything P&L needs: the selection, market, line, American price, book, stake (BET), timestamp, model version, model probability, edge and game id. The props ledger refuses a row evaluated after kickoff (`football/props/verify_ledger.js`), the decision ledger refuses a post-kickoff snapshot, and the P&L ledger marks any recommendation stamped after its game started `INVALID`. Nothing is ever reconstructed after the fact. The model record is the exception by design: its market numbers are nflverse / ESPN reference lines, *"not a price, no book, no capture time"* (`football/nfl/slate.json` `reference_market`), so its rows stay record-only.

## One state per recommendation

Every row resolves to exactly one `record_state` (`lib/edgedesk_pnl.js` `stateOf`, mirrored by the `model_pnl_state_trg` trigger):

| State | Meaning | Counts in |
|---|---|---|
| `PENDING` | not settled yet; `pending_reason` says why | nothing until it settles |
| `VERIFIED` | settled W / L / P at a captured entry price | the record **and** P&L |
| `RECORD_ONLY` | settled, but no usable entry price (never captured, assumed, or malformed) | the record (W-L-P) only — *Historical P&L unavailable* |
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

It answers **how has the model performed?** before **can we calculate exact P&L?** — the page always leads with the best *real* figure in the view.

1. **The headline.**
   - **MODEL P&L** once settled BET recommendations with a captured entry price exist: net units (the largest number on the page), PROFIT / LOSS / EVEN, ROI, W-L-P, win rate, the number of verified bets, the period — and its one chart (cumulative units and the running peak; current, peak and max drawdown).
   - **MODEL PERFORMANCE** while none has settled: the graded record — W-L-P, win %, graded decisions — and each market's record (spread, totals, moneyline, player props), marked *record only — no units*. The player props tile also shows the leans tracked beside the bets (every college prop is a LEAN while that model is EXPERIMENTAL), and their W-L once settled, marked leans; they enter the record and P&L only when the reader includes leans. With nothing graded in the view either, it says what is tracked. Never a 0.00u, and never "0 settled verified bets" as the headline.
2. **Verified P&L status**, small, only while nothing priced has settled: *Waiting for first priced settlements*, the pending priced bets and the first game (or *No priced bets in this view yet*).
3. **Historical model results**: under MODEL P&L, the graded record by market (every graded model pick and BET, and LEAN when included); under MODEL PERFORMANCE, what the headline does not already say — the split by sport, the count marked ***Historical P&L unavailable*** (a result whose entry odds were never captured), and how many recommendations are pending and why. Never units, never the same numbers twice.
4. **Filters**: tabs ALL / CFB / NFL / PLAYER PROPS — each carrying its verified net, else its graded record (W-L-P), else *Pending* — a period (Season — the default — / 30 days / 7 days / All time), a stake choice (flat 1u or EdgeDesk stakes) and *Include leans* (off by default).
5. **The ledger**, three views: ***Verified P&L*** (the settled priced bets: date, sport, bet, odds, result, units — its total is the headline's net), ***Historical graded*** (every graded pick, priced or not: date, sport, bet, result, record status *Verified* / *Record only* — its count is the record's), ***Pending***. It opens on Verified P&L once there is some, else on the graded history. A row opens to its audit (model number, entry and closing lines, CLV, edge, book, model version, timestamps, state, why pending, corrections).
6. ***How P&L works*** and ***Advanced Analytics***, collapsed. Advanced holds: the record by sport, market, model version, week and grade; the verified P&L tables — more numbers, drawdown, game markets vs props, every breakdown, calibration, CLV vs P&L — or, with nothing settled, one *Waiting for settlement* line instead of tables of zeros; player prop performance (W-L-P only once a prop settled); every row's state, *why pending* by reason, and the agreement checks; in the app, the detailed edges and football model records.

**Empty is not zero.** `0.00u` only when the arithmetic ran and gave zero; `—` when it cannot be computed (the kernel's `summarize` returns `null`, not `0`, with no settled bet); *Waiting for settlement* when the bets exist and have not finished; *Historical P&L unavailable* when a result exists but its entry price was never captured.

**One dataset, checked.** The page filters the ledger rows once — scope, period, BET (and LEAN only when included), flat or staked — and the summary, the record, the tabs, the chart, the advanced figures and the ledger are all computed from that set by the kernel. `EDPnl.integrity()` proves it on every render: the hero's bet count is the ledger's qualifying rows, its net is their sum, the chart ends there, the breakdowns by sport and market add up to it, the record equals the sum of its markets and of its sports, every row is in exactly one state, every verified row is priced, no record-only row carries units. A failure is shown as an *internal check failed* banner (and fails the ledger job, `pnl_ledger.js` exits 2) — never two quietly different numbers. `tools/record/pnl_ui.test.js` checks the page against the kernel under every scope, period, stake and the leans switch.

**Live.** The ledger job writes `record/pnl/stamp.json` (its rows' digest; it changes only when they do). The open page polls it every 5 minutes (and when it becomes visible again) and re-reads the ledger after a settlement run — new finals → graded → P&L → summary, record, chart and breakdowns, with no one editing anything.

## The rules

1. **The strategy is BET.** The headline, the chart and most breakdowns cover every recommendation EdgeDesk classified BET.
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

## Where the data stands today (2026-10-01)

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
npm run record:pnl:test       # kernel + ledger
npm run record:pnl:sql        # both migrations against a real PostgreSQL
npm run record:pnl:e2e        # the section in Chromium at 375 / 390 / 430 / 768 / 1440 px
```

## Deploy

1. Paste `supabase/model_pnl.sql`, then `supabase/model_pnl_states.sql`, then `supabase/model_pnl_analytics.sql`, into the SQL editor. Every report row should read `ok`. (`model_pnl_states.sql` is additive: on a database that already holds rows, it derives every row's state in place.)
2. Merge. `record-pnl.yml` rebuilds `record/pnl/` after each settlement job and syncs it to Supabase when the secrets are set.
3. Backfill: the first `record-pnl` run after the merge rebuilds `record/pnl/` with every row's state, the pending reasons, the graded record and `stamp.json` (the same idempotent build; a page open at the time reloads when the stamp first appears), then upserts the full committed ledger. This is historical NFL and CFB records without prices (marked, never priced), plus every priced recommendation.
