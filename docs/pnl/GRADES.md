# Edge P&L — profit and loss of every flagged edge

**The question:** if a reader had bet 1 unit on every edge EdgeDesk flagged, at the price it flagged, would they be up or down — overall, on the BETs, on the LEANs, per sport, per month?

This is a T2 deterministic transform: arithmetic on data EdgeDesk already owns (`signals`). It is display and accountability only. Nothing in capture, close, settle, the board, any ranking, threshold or research model changes.

It sits beside the recommendation ledger in [`DESIGN.md`](DESIGN.md) (`model_pnl`: player props and game decisions, built from committed JSON). That ledger deliberately left `signals` out; this one is `signals`, and it is DB-native, so the public page reads it with no edit step, the same way it reads CLV.

## Pieces

| Piece | What | Where |
|---|---|---|
| Table, arithmetic, RLS | `pnl_grades` (one row per flag), `pnl_grades_history` (append-only), `pnl_grades_errors`, the odds math | `supabase/pnl_grades.sql` |
| Verdict, derivation, hook, backfill | `pnl_verdict_at_flag()`, `pnl_grades_compute()`, the triggers on `signals`, `pnl_grades_backfill()` | `supabase/pnl_grades_sync.sql` |
| Rollup, reconciliation | `pnl_summary` view, `pnl_reconciliation()` | `supabase/pnl_grades_analytics.sql` |
| Production audit (read-only) | 10-row hand check, summary vs raw sum, reconciliation | `supabase/audits/pnl_grades_check.sql` |
| Public page | `record.html#edge-pnl`, rendered by `lib/edgedesk_edge_pnl.js` + `.css` | |
| Records tab | each graded record's P&L and the board's BET/LEAN at the flag; the reconciliation in Pipeline health | `app.html` |
| Tests | database (real PostgreSQL), pages (Chromium fed by that database) | `tools/record/pnl_grades_sql.test.js`, `tools/record/edge_pnl_ui.test.js`, fixture `tools/record/pnl_grades_fixture.js` |

## Where the data comes from

| Need | Column on `signals` | Notes |
|---|---|---|
| The flag | `flagged_at IS NOT NULL` | capture's only definition of a signal (`supabase/functions/capture/README.md`) |
| Sport, game, market, side | `sport_key`, `sport_title`, `event_id`, `away_team`/`home_team`, `market`, `selection`, `point`, `participant` (v11, optional) | |
| Price at flag | `flagged_best_dec` (decimal) | frozen by `preserve_anchor_entry()`; the only price used |
| Closing price | `closing_dec` | written by `close`; P&L at close is comparison only |
| Result | `result` (`win`/`loss`/`push`/`void`), `graded_at` | written by the deployed `settle` function |
| Verdict inputs | `flagged_tier`, `flagged_edge`, `flagged_best_book`, `flagged_fresh_books`, `flagged_reference_type` | frozen with the flag (capture v9) |

## BET and LEAN: the mapping, and why it is this one

`signals` carries capture's **tier** (A = sharp-anchored fair price, B = consensus of books). A reader never sees "Tier A". What a reader sees on the board is **BET / LEAN / WAIT / PASS**, produced by the board's deterministic verdict in `app.html` (`/* ---- verdict (consistent with the app's edgeVerdict philosophy) ---- */`):

- capture did not qualify it → PASS (or WAIT while awaiting a confirmation);
- edge under the 0.5% floor → PASS; offshore best price with fewer than 4 books → PASS;
- **tier B → LEAN, always** ("a tier-B row is a LEAN however good the local inputs look");
- **tier A → BET** only with edge ≥ 3%, a US-regulated book, 5+ books and a sharp reference; otherwise LEAN.

A P&L split by BET and LEAN must use the label the reader saw **at the moment of the flag** — not today's label, which moves with the price. So `pnl_verdict_at_flag()` runs that same rule on the inputs capture froze at the flag. Every input is frozen; nothing is looked up later:

| Board input | At the flag |
|---|---|
| capture qualified it | true by definition (it was flagged) |
| current edge | `flagged_edge` |
| trusted (US-regulated) book | `flagged_best_book`, matched against app.html `TRUSTED` (same list, same substring match) |
| books behind the fair line | `flagged_fresh_books` — the only count frozen at the flag. It is never larger than the total, so it can only make a BET harder to reach, never easier |
| sharp reference | `flagged_reference_type = 'sharp'` |
| stale | never, at the moment of the flag |

What the reader is told: **BET** is EdgeDesk's strongest call (sharp-confirmed, 3%+ edge at a US-regulated book with 5+ books). **LEAN** is a qualified edge with a caveat (consensus-only price, under 3%, offshore best price, or a thinner market). Each row also stores the one-line reason (`verdict_reason`), shown on the receipt.

Two honest edges of the mapping:
- A flag from before capture froze a tier (pre-v9) is **UNLABELLED**. It is graded and counted in *All flagged bets*, and in neither BET nor LEAN — it is not given a label after the fact.
- A flag the board would have shown as **PASS** at that moment (offshore and thin, or under the floor) is `not_a_bet`: counted, never in units.

`tools/record/pnl_grades_sql.test.js` reads app.html and fails if the board's constants (the 3% / 5 books / sharp BET rule, tier B → LEAN, offshore < 4 books → PASS, the 0.5% floor, the TRUSTED list) stop matching the SQL. A change there is a new `calc_version`.

## The rules

- **1 unit flat** on every BET, LEAN and UNLABELLED flag. PASS risks nothing.
- **The price is `flagged_best_dec`.** Never the closing price, never a later price, never `first_best_dec`.
- **Arithmetic** (`pnl_profit_american`, `pnl_profit_decimal`): win at +odds = odds/100; win at −odds = 100/|odds|; loss = −1; push = 0; void = no P&L. On the decimal price capture stores, a win is price − 1, which is the same number. Full precision is stored; pages round to 2 decimals.
- **ROI = units won ÷ units risked × 100.** A push is 1u risked and returned (it counts in units risked). A void is not risked.
- **No price, no P&L.** A settled flag without a valid flag price is `ungraded_missing_price` with reason `no_flag_price` / `invalid_flag_price`. It is never estimated, interpolated, or filled from the close. A constraint (`pnl_grades_no_invented_pnl`) and a trigger (`pnl_grades_guard`, which re-derives `pnl_units` from the row's own price and result on every write) enforce it.
- **The close** (`price_at_close`, `pnl_units_at_close`) is stored beside it for comparison only.

| `pnl_status` | Meaning | In units? |
|---|---|---|
| `graded` | a bet, a flag price, a win/loss/push | yes |
| `void` | no action | no — counted |
| `ungraded_missing_price` | settled, no price frozen at the flag | no — counted |
| `ungraded_unsettled` | no result yet (`awaiting_result`, `result_pending`) | no — counted once the game has started |
| `ungraded_unsupported` | tennis spreads/totals: the results feed settles sets, the line is games | no — counted |
| `not_a_bet` | the board showed PASS at the flag | no — counted |

**A caveat about prices, stated once.** Capture requests decimal odds from the provider, which rounds them: a −110 line at a US book arrives as 1.91 (−109.89), so a win books +0.91, not +0.909. That 1.91 is the number capture froze, so it is the number graded; nothing adjusts it.

## The table

`pnl_grades`, one row per flag:

- `sig_key` is the **primary key** and a **foreign key to `signals(sig_key)`**, so a flag can never be graded twice and a graded signal cannot be deleted from under its P&L row.
- The columns you asked for: `stake_units`, `price_at_flag`, `price_at_close`, `result`, `pnl_units`, `pnl_units_at_close`, `pnl_status`, `calc_version`, `computed_at`.
- Beside them:
  - `pnl_reason`, `verdict` and `verdict_reason`;
  - the American prices (unrounded);
  - the identity of the game and the frozen flag inputs, so the public page never needs `signals`, which is paywalled.
- `calc_version` (`pnl-v1`) names the arithmetic and the verdict rule. If either changes, the version changes, the backfill recalculates, and every row's before/after goes into `pnl_grades_history` (append-only) as `recalculated`. A settlement that moves (win → loss) is logged as `result_changed`. Nothing is rewritten silently, and nothing is deleted (delete and truncate are refused).
- **RLS:**
  - anyone (anon included) may read a row whose game has started or settled;
  - a flag whose game has not started is the live board, and it stays private, in the table and in the view alike;
  - no client role can write;
  - writes come only from the trigger and the backfill (SECURITY DEFINER);
  - the backfill is executable by `service_role` only.

## The rollup

`pnl_summary`:

- **Measures:** flags, graded, W-L-P, units risked and won, ROI, the same at the close, and the void / missing-price / unsettled / unsupported / not-a-bet counts.
- **Dimensions:** sport × verdict × market type (moneyline, spread, total, player_prop).
- **Periods:** all time, and per month, week and day (America/Chicago, dated by kickoff).
- A dimension reads `ALL` where it is rolled up.
- It is owner-run, like `public_record`: it exposes counts and units, never a live flag.

## Keeping it in sync

- **The settlement hook is a trigger, not a cron.** `pnl_grades_on_signal_upd_trg` (after update) and `_ins_trg` (after insert) on `signals` fire only when:
  - a row becomes flagged, or
  - a flagged row's price, result, `graded_at`, close, kickoff or tier changes.

  They write that flag's P&L row in the same transaction. That covers capture's flag write, close's close and settle's result. None of those functions changes, and `settle` (deployed, not in this repository) needed no hook point. A capture pass that only re-prices does not fire it.
- **It can never break settlement.** The trigger catches any error, logs it to `pnl_grades_errors` and lets the `signals` write succeed.
- **Reconciliation** — `pnl_reconciliation()` (anyone may call it; counts only):
  - settled flags with no P&L row (**must be 0**);
  - P&L rows out of step with their signal;
  - flags with no row yet;
  - grading errors not yet repaired (last 7 days);
  - rows on an older `calc_version`.

  It is shown in the app's Records tab under **Pipeline health**, beside capture / close / flagging / grading. Any non-zero row says to run the backfill, which repairs it.

## Deploy (paste into the SQL editor, in order)

1. `supabase/pnl_grades.sql` — every report row `ok`. It refuses to run, and names the file, if `capture_v9_qualification.sql` or `close_v7_parity.sql` has not run, or if `signals.sig_key` has no unique index.
2. `supabase/pnl_grades_sync.sql` — every row `ok`. From here on, every new flag and settlement gets its row.
3. `supabase/pnl_grades_analytics.sql` — every row `ok`.
4. **Dry run:** `select * from public.pnl_grades_backfill(false);`
   - It writes nothing.
   - It prints rows would-insert / update / unchanged, then status × reason counts, totals per verdict and per sport (W-L-P, ROI, units), the grand total, and a 20-row sample (game · verdict · side @ price → result, pnl).
5. **Commit:** `select * from public.pnl_grades_backfill(true);`
   - Run it as often as you like; a second run inserts and updates nothing.
6. **Check:** paste `supabase/audits/pnl_grades_check.sql`.
   - It is read-only.
   - It hand-checks 10 random rows against the raw signal with American math worked in plain SQL, compares pnl_summary with a raw `SUM` per sport × verdict, and runs the reconciliation.
   - Every row should say `ok`.
7. Merge. `record.html#edge-pnl` and the Records tab read the new tables. Before step 3 they say "not deployed" and show nothing made up.

## Verify locally

```
npm run record:edge-pnl:sql     # the database: 110 checks against a real PostgreSQL
npm run record:edge-pnl:show    # the same, printing the dry run, the 10-row hand check and summary vs raw sums
npm run record:edge-pnl:ui      # the pages in Chromium, fed by that database (375 / 768 / 1440 px)
```
