# Profit & loss of every flagged edge

**The question:** if you had put 1 unit on every edge EdgeDesk flagged, at the
price on the screen when it was flagged, how many units would you be up or down?

This is the P&L of the **edges record**: `public.signals`, the rows the
`capture` function flags, `close` scores for CLV and `settle` grades. It lives
in the database beside them and is written by the database. The public record
reads it the same way it reads CLV: straight from the database, with no edit
step.

It sits beside the other P&L layer. That one is `model_pnl`
(`docs/pnl/DESIGN.md`), which covers the player-prop and game-decision
recommendations kept in the committed ledgers. The two cover different
recommendations and are never summed together.

It is a deterministic transform: arithmetic on data EdgeDesk already owns. It
is for display and accountability only. It reads `signals` and writes nothing
back to it. Nothing about qualification, ranking, thresholds, flags or models
changes.

## Pieces

| Piece | What | Where |
|---|---|---|
| Table, math, writer | `pnl_grades` (one row per flag), `pnl_grade_history` (append-only), `pnl_grade_compute()` (one signal → one row, pure), `pnl_grade_write()` (the one writer), RLS | `supabase/signal_pnl.sql` |
| Rollup | `pnl_summary` (all-time, month, week and day × sport × tier × market), the brief's formulas `pnl_units_american()`, `pnl_handcheck()` | `supabase/signal_pnl_summary.sql` |
| Hook, checks, backfill | the trigger on `signals`, `pnl_sync_errors`, `pnl_reconciliation()`, `pnl_verify()`, `pnl_backfill()` | `supabase/signal_pnl_sync.sql` |
| Backfill dry run | `select * from public.pnl_backfill();` | `supabase/signal_pnl_backfill.sql` |
| Kernel | the same arithmetic in the browser and Node, the folds the page draws from | `lib/edgedesk_edge_pnl.js` (`window.EDEdgePnl`) |
| Public section | `record.html#edge-pnl`, directly under closing-line value | `lib/edgedesk_edge_pnl_ui.js`, `lib/edgedesk_edge_pnl.css` |
| Records tab | a **P&L** column on every graded row, P&L on the receipt, P&L in the exports, and a **P&L sync** row in **Pipeline health** | `app.html` |
| Tests | the math, a real PostgreSQL, a real browser | `tools/record/signal_pnl*.test.js`, `.github/workflows/record-pnl-tests.yml` |

## The rules

1. **One flag, one row.**
   - The key is `signals.sig_key`, as primary key and foreign key, so a flag can never grade twice.
   - A row exists once the flag has **closed** (`close` stamped `closed_at`) or **settled** (`settle` wrote `result`).
   - A flag is `flagged_at IS NOT NULL`, the same definition capture uses.
2. **The price is the one frozen when the edge was flagged** (`signals.flagged_best_dec`).
   - It is never the closing price and never a later price.
   - Capture's `preserve_anchor_entry()` trigger already makes that price permanent.
3. **The arithmetic, 1 unit flat:**
   - A win at +odds pays odds/100.
   - A win at −odds pays 100/|odds|.
   - A loss is −1. A push is 0.
   - Capture stores the decimal price, and a win pays d − 1, which is exactly those formulas with no rounding in between. A provider decimal of 1.91 is −109.89, shown as −110, and pays 0.91.
   - The database keeps full precision. The page rounds to 2 decimals.
4. **Void / cancelled / postponed / no action** is not a bet. It has no P&L and no stake, and it is counted on its own.
5. **No valid flag price** means `ungraded_missing_price`, with the reason `no_flag_price` or `invalid_flag_price`.
   - Nothing is estimated or interpolated, and the closing price is never borrowed. The table's own constraint refuses it.
   - These rows are counted publicly.
6. **Closed but not settled** means `ungraded_unsettled` (`awaiting_result`).
   - A result word nobody can read is `unrecognized_result`. It is never guessed.
7. **`pnl_units_at_close`** is the same bet at the closing book price (`signals.closing_dec`, a price a book actually offered).
   - It is for comparison only, and only on graded rows.
   - `closing_sharp_fair` is not used: it is a no-vig probability, not a price anyone could bet.
8. **Which flags are "the record".**
   - The flags with an edge between 0.5% and 10% when flagged, the same rows as the closing-line-value record on `record.html`.
   - The rest are kept (`record_scope = 'outside_edge_band'`) and counted, never mixed in.
9. **Tiers, not BET/LEAN.**
   - The edges record has no BET/LEAN verdict. Each flag carries the tier capture froze when it flagged it (`flagged_tier`).
   - **Tier A**: Pinnacle quoted this exact bet, and the price beat its fair number.
   - **Tier B**: Pinnacle did not quote it. The price had to beat the other books' consensus, on two separate scans.
   - **Older flags**: flags from before tiers existed (pre-v9).
   - The page splits by tier in those words. Nothing re-classifies a flag.
10. **ROI = units won ÷ units risked × 100.**
    - A push returns its stake, so it is not counted as risked. This is the convention of every P&L on the site.
    - Win rate = W ÷ (W + L).
11. **`calc_version` on every row** (`pnl-v1`).
    - If the math ever changes, the version changes with it.
    - The backfill then rewrites every row and appends the old version to `pnl_grade_history`, with exactly what changed. Nothing is silently rewritten.

## Schema

`pnl_grades` has these columns:

| Group | Columns |
|---|---|
| Key | `sig_key` |
| Copied from the signal | `sport_key`, `sport_title`, `event_id`, `home_team`, `away_team`, `commence_time`, `game_date` (America/New_York), `market`, `market_type`, `selection`, `point`, `book`, `tier`, `flagged_policy`, `flagged_at`, `flagged_edge`, `record_scope`, `settled_at`, `closed_at` |
| Prices | `price_at_flag` (American, full precision), `price_at_flag_dec`, `price_at_close`, `price_at_close_dec`, `close_book` |
| Result | `result` (`win` / `loss` / `push` / `void`), `result_raw` (settle's own word) |
| P&L | `stake_units` (1 or 0), `pnl_units`, `pnl_units_at_close` |
| Status | `pnl_status` (`graded` / `ungraded_missing_price` / `ungraded_unsettled` / `void`), `ungraded_reason` |
| Versioning | `calc_version`, `revision`, `created_at`, `computed_at` |

Constraints:

- **Enums** on `tier`, `record_scope`, `result`, `pnl_status` and `stake_units`.
- **`pnl_grades_math`**:
  - a graded row's P&L *is* `pnl_units_decimal(price_at_flag_dec, result)` (and the same at the close);
  - a non-graded row carries no P&L and no stake;
  - a void row is a void result.
- **`pnl_grades_signal_fk`**: references `signals (sig_key)` `on delete restrict`. A graded flag cannot be deleted out from under its P&L.

Other protections:

- **Triggers** refuse `delete` and `truncate` on `pnl_grades`, and any edit or delete on `pnl_grade_history`.
- **RLS**:
  - Anyone (anon included) reads a row once its game has started: `result_raw is not null or commence_time <= now()`.
  - `close` stamps a row about 35 minutes **before** kickoff, and the live board stays behind the paywall until then.
  - Only the service role writes, and the writer is `SECURITY DEFINER` and granted to nobody else.
  - `pnl_sync_errors` is private.

`pnl_summary` (a security-invoker view, so a reader sees what RLS allows them):

- `grain`: `all`, `month`, `week` or `day`. `period_start` is the period's first day.
- `breakdown`: `total`, or any combination of `sport` / `tier` / `market`.
- Counts: `flags`, `graded`, `wins`, `losses`, `pushes`, `voids`, `ungraded_missing_price`, `ungraded_unsettled`, `outside_edge_band`.
- Units: `units_won`, `units_risked`, `roi_pct`, `win_pct`.
- Closing comparison: `close_compared`, `units_won_at_close` and `roi_at_close_pct`, beside `units_won_flag_compared` and `roi_flag_compared_pct` on the same rows.
- Dates: `first_game_date`, `last_game_date`, `last_computed_at`.
- Every count and sum is additive, so the page can fold any set of rows (one sport, or every current sport without a retired one) and derive the rates again.

## Ongoing sync: the hook

`signals.result` is written by the `settle` edge function, which is deployed
but not in this repository. `closed_at` / `closing_dec` are written by `close`.
Instead of a new cron, or editing a function no checkout can review, an `AFTER
UPDATE` trigger on `signals` (`pnl_signals_settle_trg`, plus an `AFTER INSERT`
twin) writes the P&L row **in the same transaction as the settlement**,
whichever function made it.

- **Scope.** It fires only when a column that can change the P&L is written (`flagged_*`, `result`, `graded_at`, `closed_at`, `closing_dec`, `closing_book`), and only on a flagged row that has closed or settled.
  - Capture's routine refresh writes none of those columns, so it never fires on a capture pass.
  - It is cheap: a flag whose P&L would not change is left alone.
- **It never fails a settlement.**
  - Any error inside it is caught and written to `pnl_sync_errors`, and the settlement commits.
  - `pnl_reconciliation()` then shows the settled flag with no row, and `pnl_backfill(true)` repairs it.
  - A settlement that rolls back takes its P&L row with it.
- **Corrections.** A result that changes after it settled (a stat correction, a late void) rewrites the row.
  - The previous version is appended to `pnl_grade_history`, with the fields that changed.
  - Unsettled → settled is the normal life of a row, not a correction, and is not logged.

**Reconciliation.** `pnl_reconciliation()` returns jsonb. Anon and signed-in readers may call it; it returns counts only.

| Key | What it counts | Should be |
|---|---|---|
| `settled_without_pnl` | settled flags with no P&L row | 0 |
| `closed_without_pnl` | closed flags with no row | 0 |
| `out_of_sync` | rows whose signal moved without a rewrite | 0 |
| `sync_errors_24h` | hook errors in the last 24 hours | 0 |

It also returns:

- `last_error`, `rows`, `graded` and `last_write_at`;
- `overdue_unsettled`: flags with no result 36 hours after kickoff. That is the settle job, not P&L.

The signed-in Records tab shows it as the **P&L sync** row of **Pipeline health**, beside capture / close / flagging / grading. It is green at 0 missing.

## Deploy

1. Paste the three migration files into the Supabase SQL editor, in order:
   - `supabase/signal_pnl.sql`
   - `supabase/signal_pnl_summary.sql`
   - `supabase/signal_pnl_sync.sql`

   Each is under the editor's 18 KB paste limit, idempotent and additive, and ends in a report. Every row should read `ok`. The sync file's last row says how many historical flags still need the backfill.
   - From this point every new close and settlement writes its P&L row.
2. **Dry run.** Paste `supabase/signal_pnl_backfill.sql` (`select * from public.pnl_backfill();`). It writes nothing, and returns one table:

   | Section | What it shows |
   |---|---|
   | `mode` | that it is a dry run, and the statement that writes it |
   | `counts` | flags reached, would insert / update / already correct, graded / void / no flag price / waiting on a result / outside the edge band |
   | `sample` | 20 rows: game, pick, price at flag, result, P&L. A few of each ungraded kind come first, then graded bets; it is the same 20 every run. |
   | `totals` | per sport and all sports: graded, W-L-P, units, ROI, and every row not counted, with its reason |
   | `check` | the odds math |
3. **Commit:** `select * from public.pnl_backfill(true);`
   - It ends with all 12 checks, which must all read `ok`. These include `pnl_summary` = the raw SQL sum, settled flags with no P&L row = 0, and rows out of sync = 0.
   - Running it again writes nothing.
4. Any time afterwards:
   - `select * from public.pnl_handcheck(10);` shows 10 random rows beside the raw signal, recomputed through raw decimal → American → the brief's formula, which never reads the stored row.
   - `select * from public.pnl_verify();` runs every check.
5. Deploy the site: `record.html`, `app.html` and the three `lib/edgedesk_edge_pnl*` files.
   - Until step 1 has run, the public section says P&L is being switched on and shows no number.
   - Until then, the Records tab's P&L column and P&L sync row say it is not on.

## Verification

| Suite | Proves |
|---|---|
| `node tools/record/signal_pnl.test.js` | +150 win = 1.50, −110 win = 0.909, loss = −1, push = 0, void = not a bet; the decimal path equals the American path at every price; not-odds and unreadable results give no P&L; the grade of one signal; folding, the cumulative series, formatting |
| `node tools/record/signal_pnl_sql.test.js` | Against a real PostgreSQL built with the repository's own capture v9 and close v7 migrations, seeded with a realistic TEST history (`signal_pnl_fixture.js`), proves the items listed below the table. |
| `node tools/record/signal_pnl_ui.test.js` | The page fed exactly what the database returns to an anonymous reader. `record.html#edge-pnl` at 375–1440 px: the hero, KPIs, tiers, chart (hover and keyboard), sport filter, not-counted counts and method note against SQL; no sideways scroll; archive, not-deployed and empty states. The app's Records tab: every row's P&L against the database; P&L sync reads 0 missing. |

`signal_pnl_sql.test.js` proves:

- the files' order guards, idempotency and reports;
- the dry run writes nothing;
- the commit writes one row per closed or settled flag, and a second commit writes nothing;
- every row equals the JS kernel;
- `pnl_summary` equals the raw SQL sum and an independent JS sum at every grain;
- the hand-check, three ways;
- the hook writes in the settlement's transaction and rolls back with it;
- corrections are logged, and capture's refresh fires nothing;
- the frozen price holds;
- a sabotaged hook does not fail the settlement, goes red in the reconciliation, and is repaired by the backfill;
- no delete, no invented figure, and a `calc_version` change is logged;
- anon never sees an unstarted game and never writes.

## What the investigation found (2026-10-01)

- **Two P&L systems, different recommendations.**
  - `model_pnl` (committed JSON → Supabase) covers props and game decisions.
  - `signals` (the edges record) had no stored P&L until this. It had only the Records tab's client-side "Sim P/L".
- **Mixed odds formats.** `signals` stores decimal prices; `model_pnl` and its sources store American. This layer computes from the stored decimal and shows American.
- **The Records tab's "Sim P/L" falls back to the first-seen price** when no flag price was stored (marked †), and counts a void as 0.
  - It is left as it was, labelled **Sim P/L**.
  - The new **P&L** column beside it is the recorded figure and never substitutes a price.
- **Not in this repository:** the `settle` function (it writes `signals.result`), the `public_record` view behind `record.html`'s CLV section, and the `close` / `settle` schedules. The trigger is the hook precisely because it does not depend on reading them.
- **Alternate lines.** Several flags on one side of one game (−3.5, −4, −4.5) are separate flags at separate prices.
  - Like the CLV record, each counts.
  - The sample size printed beside every figure is the number of flags, not of games.
- Production counts could not be read from the development environment (the database host is outside its network policy). The dry run in step 2 is how they are read.
