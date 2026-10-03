# Verified P&L — audit against the real EdgeDesk data (2026-10-03)

This audit asks one question: can every number on the Verified P&L card be followed back to a price that really existed when EdgeDesk made the decision? It traces one decision in each market through every step: decision, stored quote, locked price, settlement, profit, database, page. Every row, file line and commit below can be checked.

## Verdict

- **The chain holds**, in code and on the real data. Each traced price is a stored row that was committed before its decision. It was locked once and settled from the final score. Its units follow from stake × odds. The database aggregate equals the page.
- **The database step was broken in production, and nothing said so.** `model_pnl` was never deployed, and every sync failed silently with a green check. This is fixed in code (see *Production*). Applying the schema is one manual workflow run, which needs approval.
- **Most old model decisions cannot be priced.** No price was stored before they were published, so they stay record only and say why.
  - Of 762 graded decisions, **31 are verified**: 7 CFB model numbers and 24 player-prop BETs.
  - **731 are record only**: 723 `before_capture` and 8 `line_moved`.
- **From now on every model game gets a stored price.** Each hourly record run keeps every priced pregame quote of every NFL and CFB game the model prices (the quote ledger).

## The end-to-end trace: a spread

**Delaware +7** (Liberty @ Delaware, CFB week 5, ESPN 401871050), `mr:cfb:401871050:spread`.

| Step | What | Evidence |
|---|---|---|
| 1. Model decision | The fair line Delaware +3.88, published 2026-09-28T17:50:57.810Z. The record's pick is that number; the next slate (19:33:42Z) repeated it unchanged. | `football/fbs/slate.json` `generated_at`, committed in `3e51e7d8` at 17:51:26Z. `record/football/cfb_2026.json` `games["401871050"].pick.at`. The game's first number is from `617055ff` (2026-09-23). |
| 2. Stored odds snapshot | DraftKings spread, Delaware +7 at **−108** (Liberty −112), read 2026-09-28T17:07:22Z, 43 min before the decision. | `football/cfb_lab/ledger/2026/quotes/week_05.jsonl` line 1519, `quote_id` **`cfbq_ba1a2f2efe89a7b5e328391c`**. Committed in `79f99b94` at 17:07:31Z. Production database row: `public.cfb_lab_market_quotes` with that `quote_id` (run 37125096929 sent all 6,278 committed lab quotes there, insert-or-ignore, with no error). |
| 3. Locked price | `pick.price_lock.spread`: status locked, source `cfb_lab_quotes`, that `quote_id`, DraftKings, home line +7, home −108, `decided_at` 17:50:57.810Z. This is the latest DraftKings quote at or before the decision, and 43 min old (the limit is 6 h). | `tools/record/football_record_core.js` `lockPrice` → `price_lock.js` `lockPick`. A lock is written once and never rewritten. |
| 4. Settlement | Close +7 (ESPN / DraftKings). Final Liberty 30, Delaware 14 (ESPN, 2026-10-03T05:28:40Z). The model's side is Delaware at the closing +7: 21 vs 30, **loss**. | The record's `close`, `final` and `grade.spread`. The graded number (+7) equals the stored quote's number, so the lock prices it. |
| 5. Profit | 1.00u risked (`stake_source: default`, the model recorded none) at −108, loss = **−1.000000u**. | Ledger row `mr:cfb:401871050:spread`: `price_source: snapshot`, `price_ref.quote_id` = the quote above, `pnl_status: VERIFIED`. |
| 6. Database aggregate | `model_pnl` holds the row, and `model_pnl_quotes` holds `cfbq_ba1a2f2e…` (same game, number, time and price). `verified_pnl_breakdown('market_type')` shows spread 1 verified, −1.00u. `verified_pnl_summary('staked')` gives 762 graded / 31 verified / 731 record only, +0.42u on 13.00u, ROI 3.21%, equal to the page. Every integrity check reads 0. | Proven by replaying this ledger through the six migrations and `pnl_sync.js` on a throwaway PostgreSQL. Production has no `model_pnl` yet (see *Production*). |
| 7. Records page | History row: `Delaware +7 · Loss · −108 · 1.00u risked default · −1.00u`. Card: Spreads −1.00u, 1 priced, 268 record only. | `lib/edgedesk_pnl_ui.js` `priceCell`. The card draws first from `summary.json` `verified.views`. |

**The same game's total shows the rule working.** At the decision DraftKings stood at Over **49.5** (`cfbq_d2b213c7a7fbec1bab134552`). The model is graded on Over **51.5**, the close. That was a different bet, so the row is record only: `line_moved`. It is never priced at a number it was not graded on.

## Four traces: which row supplied the price

| | Spread | Total | Moneyline | Player prop |
|---|---|---|---|---|
| Decision | `mr:cfb:401871050:spread` Delaware +7 | `mr:cfb:401871049:total` Under 55.5 (WKU @ NMSU) | `mr:cfb:401871049:moneyline` New Mexico State ML | `pp:ppe_2a55d67b` Pat Freiermuth Under 31.5 receiving yards (PIT @ CLE, NFL wk 4), BET 0.25u |
| Decided at | 2026-09-28T17:50:57.810Z (slate commit `3e51e7d8`, 17:51:26Z) | same | same | 2026-09-30T08:45:48.616Z |
| **Price row** | `football/cfb_lab/ledger/2026/quotes/week_05.jsonl:1519`, `cfbq_ba1a2f2efe89a7b5e328391c` | `week_05.jsonl:1506`, `cfbq_13fe8b9cfa4e067cccbbf609` | `week_05.jsonl:1389`, `cfbq_c0c3e29dadaa9806c85d8c8e` (a heartbeat row: the price had not changed) | `football/props/nfl/2026/evaluations.jsonl:60` (`american −115`, `book betmgm`, `quote_captured_at 08:45:47.571Z`). It was copied from `football/props/nfl/quotes.json` @ `bae401c6`, event `d55cb69fed50a09170560b5b75d8de86`, quote #1932 `[betmgm, rec_yds, Pat Freiermuth, u, 31.5, −115]` |
| Price | DraftKings −108 | DraftKings −115 | DraftKings −130 | BetMGM −115 |
| Read at | 17:07:22Z | 17:07:22Z | 14:07:28Z | 08:45:47.571Z |
| Committed | `79f99b94`, 17:07:31Z | `79f99b94`, 17:07:31Z | `5fde0a19`, 14:07:39Z | `bae401c6`, 08:46:21Z (with the decision) |
| Database row | prod `cfb_lab_market_quotes`; after the deploy, `model_pnl_quotes` | same | same | `model_pnl` (`price_source: decision`: the price is part of the decision). Its own mirror is `player_prop_evaluations` (see *Production*). |
| Settlement | close +7; 14–30; loss | close 55.5; 34–13 = 47; win | 34–13; win | 17 yds (graded 0 at 04:40Z, corrected to 17 at 04:55Z: WIN → WIN, logged) |
| Profit | −1.000000u | +0.869565u | +0.769231u | +0.217391u (flat +0.869565u) |

Moneyline −130 is 3 h 43 min old at the decision. The lab writes a quote on every change and at least every 6 h, so the price stood unchanged for that whole stretch.

## Why old decisions cannot be priced

- **The model record never stored a price with its numbers.** Its `entry.market` and `market_pick` quotes carry lines without prices, and are read after the number (for example, `market_pick` at 17:52:03Z for a 17:50:57Z decision). `close.prices` is the close, never an entry. `grade.pnl` (units at the closing price) is audit data only: no P&L code reads it and no page shows it.
- **The only stored, timestamped, pre-decision prices are the CFB Model Lab's.** They start 2026-09-27T15:07:15Z and cover the 71 games the lab tracks.
- **Nothing stored a timestamped NFL game price.** The nflverse consensus line has no book and no capture time.
- **The result:**
  - 625 CFB decisions have no quote at or before them;
  - 98 NFL decisions have none;
  - 8 had a quote for another number than the one graded.

  Each is record only with its reason. A price stored later, today's odds and −110 are never substituted.

## The earliest point from which Verified P&L is legitimate

| Decisions | From | Why |
|---|---|---|
| Player props, BETs | their first decision (props ledger: 2026-09-30) | the price is captured with the decision, write-once |
| CFB games the lab tracks | **2026-09-27T15:07:15Z** | the lab's first stored quote |
| **Every CFB and NFL game the model prices** | **the first *Football model record* run after this change merges** | `record/football/quotes/<sport>_<season>.jsonl` starts then. `summary.json` `verified.price_sources.every_game_from` records the exact moment, and *How P&L works* prints it. |

## Production, as found and as fixed

These come from GitHub Actions logs; this environment cannot reach the production database.

| Found | Evidence | Fix |
|---|---|---|
| **`model_pnl` does not exist in production.** The sync fails with `PGRST202`. The old `pnl_sync.js` caught it and exited 0, so even the step's `\|\| echo ::warning::` never fired: a green run with no warning. | *Record P&L* run 37125530509 (13:15Z) | `pnl_sync.js` exits 3 on a missing schema and 4 when the database disagrees with the page, each with an `::error::` and a run-summary line. After every sync it compares `verified_pnl_summary()` with the kernel's card over the same ledger, and checks `verified_pnl_integrity()` at 0. **Deploy Record P&L schema** applies the six files in order. |
| **A locked price had no database row to point to.** The lab mirror covered lab quotes only. | — | `model_pnl_quotes` (append-only) receives every cited quote before the rows that cite it. Integrity checks compare every lock with it, and with the lab mirror where present. |
| **The BET decisions' mirror refuses WATCH / LEAN.** It fails with 23514 on `bettor_decision_snapshots_decision_check`, row `bds_0b368e37`, and the log said "skipped (apply …)". | *CFB Model Lab* run 37125096929 | Reproduced: the 2026-09-28 18:28 `bettor_decisions.sql` refuses that exact row, and the current file accepts all 706. Re-apply it with the deploy's `apply_bettor_decisions`. The warning now says what 23514 means. |
| The props mirror aborted ("This operation was aborted") for NFL, CFB and the health record. | *Player props* run 37090253433 (02:47–02:52Z) | Not changed here. Verified P&L does not read it: prop P&L comes from the committed ledger. |
| `cfb_market_*` tables are missing (`PGRST205`). | run 37125096929 | Not a P&L table; noted. |
| The live Records page runs the code from before this branch: 762 graded, 24 verified, all props. | run 37125530509 log | After the merge and one *Football model record* run, the 7 locks attach and the card reads 31 verified. |

## How this was checked

- **The lock.** `football_record.js --write --offline` over the committed data locked exactly these 7 model decisions; the generated file was then restored, because `record/` is bot-owned.
- **The database.** The ledger was replayed through all six migrations and `pnl_sync.js` on a throwaway PostgreSQL:
  - 3,288 rows and 7 cited quotes inserted;
  - parity ok in both stake modes;
  - every integrity check 0.
- **Tests:**
  - `quote_ledger.test.js` 19;
  - `verified_pnl.test.js` 76;
  - `pnl_sql.test.js` 200;
  - `pnl.test.js` 172;
  - `pnl_ledger.test.js` 97;
  - `football_record.test.js` 81;
  - `pnl_ui.test.js` 457.

## What needs a person

1. Run **Deploy Record P&L schema** (Actions → manual), with `apply_bettor_decisions` checked. It needs the `SB_DB_URL` secret, which the other deploy workflows already use.
2. Merge. The next *Football model record* run locks the 7 historical prices and starts the quote ledger. *Record P&L* follows and syncs, and its database step goes red if anything disagrees.
