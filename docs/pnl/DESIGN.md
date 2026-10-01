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
| Database | `model_pnl` plus the append-only `model_pnl_corrections`, a trigger-derived P&L, a public view, SQL rollups / drawdown / a daily materialised series, and a reader's own dollars | `supabase/model_pnl.sql`, `supabase/model_pnl_analytics.sql` |
| Sync | Sends the committed ledger through `model_pnl_upsert()`. Soft-fails without secrets. | `tools/record/pnl_sync.js` |
| UI | The Record's Profit & Loss section | `lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`. It appears as a third book in the app (Records → *Profit & Loss*) and as `#pnl` on the public `record.html`. |
| Job | The only writer of `record/pnl/`. Runs after Player props, CFB Model Lab and Football model record, plus an hourly sweep. | `.github/workflows/record-pnl.yml` |
| Tests | Kernel, ledger, real PostgreSQL, real browser | `tools/record/pnl*.test.js`, `.github/workflows/record-pnl-tests.yml` |

## Sources, and what each can honestly give

| Source | Recommendation | Entry price | Settled by | P&L |
|---|---|---|---|---|
| Player props, NFL + CFB: `football/props/<lg>/<season>/evaluations.jsonl` (kind `qualified`: BET, LEAN) | frozen pregame, write-once | **yes**: American, book, (new rows) quote capture time | `football/props/grade.js` → `results.jsonl` | **verified** |
| Game decisions: `football/cfb_terminal/decisions/<season>/snapshots.jsonl`, first snapshot per class per game (BET / LEAN / WATCH / PASS), and any other league's decision ledger added to `DECISION_LEDGERS` | frozen pregame, write-once | **yes**: `bet_price` or `reference_quote` | `EDDecisionTrack.gradeEvaluation` (CFB Model Lab job) → `evaluations.jsonl` | **verified** |
| Football model record: `record/football/<sport>_<season>.json` | the published fair number, graded at the close | **never captured** | `tools/record/football_record_core.js` | none. The row is a **record-only** result marked `NO_ENTRY_PRICE` |

Left out on purpose, and counted on the page with the reason:

- **CFB Model Lab** research positions graded at an **assumed −110** (`price_assumed`). These are simulated. They are never verified P&L and never mixed with it.
- **Lab replays** (`origin: REPLAY`). These are backtests, not recommendations that existed at the time.
- **The shadow CFB decision engine** (`football/cfb_decision/`). Its calls are not published recommendations.

Also left out: `signals`, the edges record — its P&L is its own DB-native ledger, `pnl_grades` ([`GRADES.md`](GRADES.md)), 1u at the flag price with the board's BET/LEAN at the flag — and the per-reader AI-desk tables (`stake_recommendations`, `recommendation_ledger`). Those are one reader's own answers, not the public model's recommendations.

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

## Where the data stands today (2026-09-30)

- 908 rows:
  - 720 record-only model-record results (NFL 32 games, CFB 231 games; no price);
  - 147 frozen player props (14 NFL BETs at 0.25u, the rest LEANs), all with real prices;
  - 41 CFB game decisions (PASS / WATCH), priced.
- **0 verified P&L bets.** The first props settle after PIT @ CLE on 2026-10-02.
- **No NFL game-decision ledger exists yet.** The NFL game markets are record-only until one does; the builder already reads any league's decision ledger, and the tests prove NFL spread, total and moneyline P&L.
- The page says all of this, rather than drawing a guess.

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

1. Paste `supabase/model_pnl.sql`, then `supabase/model_pnl_analytics.sql`, into the SQL editor. Every report row should read `ok`.
2. Merge. `record-pnl.yml` rebuilds `record/pnl/` after each settlement job and syncs it to Supabase when the secrets are set.
3. Backfill: the first `record-pnl` run upserts the full committed ledger. This is historical NFL and CFB records without prices (marked, never priced), plus every priced recommendation.
