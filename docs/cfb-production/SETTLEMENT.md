# CFB settlement, schedule changes and the bet ledger

A wager is graded once, from a final game state and a valid score. It is graded against the number frozen
when the decision was made, and never against anything learned later. Code: `football/cfb_lab/settle.js`,
`checkpoint.js`, `market.js`, `integrity.js`; the database layer is `supabase/cfb_lab.sql` plus
`supabase/cfb_market_integrity.sql`.

## 1. A result needs a final state and a valid score

A FINAL reading (`integrity.finalProblem`) needs:
- both scores, as integers from 0 to 150;
- not a tie: college football has had no ties since 1996, so a 0-0 "final" is a placeholder or a feed
  fault;
- a status that is not suspended, delayed, in progress, halftime or scheduled, even if the feed sets
  `completed = true`.

An invalid FINAL from any source is refused and logged (`settle.results_refused`,
`result_disagreements[].invalid_final`), and the game waits.

The existing rule still applies: a FINAL is written only when every source that carries the game agrees
(ESPN and cfbfastR). Postgres enforces the same on insert (`cfb_market_results_safety_trg`): a tied, negative,
above-150 or scoreless FINAL is refused whoever writes it.

## 2. Overtime

The prediction target is the **final result including overtime**, the standard book rule for sides and
totals:
- `final_margin` and `final_total` are the full-game numbers;
- ATS and totals grade on them;
- `overtime` is recorded from ESPN's period count (> 4), or null when no source says.

**Example.** A 45-38 double-overtime final grades home −7 as a PUSH, a projected total of 50 as an error of
+33, and a projected +3 margin as an error of +4. These are tested in `chaos.test.js` and
`sign_suite.test.js`.

## 3. Postponed, canceled, no contest: never a loss

POSTPONED, CANCELED and NO_CONTEST results grade every snapshot VOID:
- no win, no loss, no push;
- no units and no error;
- excluded from every denominator.

A canceled game that ESPN marks `completed` with a 0-0 score is CANCELED, not a FINAL.

## 4. Kickoff changes, postponement and rescheduling

**Snapshots.** ESPN's own schedule, read each hour, is the kickoff authority (`checkpoint.run` with
`market.espnSchedule`). The rules for each game ESPN reports:

| ESPN reports | what happens |
|---|---|
| postponed, canceled or suspended | not snapshotted: the pending job is canceled (`skipped_schedule`) |
| in progress or finished before the model's kickoff (an early start) | never given a "pregame" snapshot |
| a moved kickoff | new snapshots use the new kickoff and recompute `hours_to_kickoff` and the checkpoint window; old snapshots keep the kickoff they were taken against (`inputs_ref.kickoff_basis` records both) |

A game whose current result is POSTPONED or CANCELED is not snapshotted until it has a new kickoff.

**Rescheduled by more than 36 h.**
- The old snapshots predicted a game that did not happen at their time, so they are graded **VOID**
  (evaluated as POSTPONED).
- The new date gets new snapshots as **ADHOC** rows, with `inputs_ref.reschedule.window` naming the window
  they stand for.

  **Known limitation.** One game id holds one row per checkpoint, so a rescheduled game has no second
  OFFICIAL snapshot. It is counted as missing in official coverage, which is safer than an official number
  taken for the wrong date. Changing that requires a governed ledger and schema change: a new slot key
  including the scheduled date, and a new Postgres unique index.

**Closes** anchor to the real kickoff and wait for a settled state (MARKET_INTEGRITY.md §7).

## 5. Idempotent; never graded twice

- Result, line and evaluation ids are deterministic hashes. Running settlement a second or third time
  writes nothing: the files are byte-identical (`chaos.test.js`).
- One evaluation per (snapshot, eval version, result, close line). Postgres enforces it with the unique
  index `cfb_lab_evaluations_graded_once`, created only when the history has no duplicate.
- A corrected score writes a new result with `supersedes` and re-grades as new rows. Nothing is edited.

## 6. The bet ledger is immutable

Once a snapshot, which carries the decision, is frozen, later market information cannot alter its entry
line (`recommended_line`), entry price (`recommended_price`) or decision (`decision_class`, `status`,
`stake_units`). This is enforced three ways:
- **Repository:** `ledger.js verify` refuses any rewritten line, checks every `row_hash`, and allows one row
  per checkpoint.
- **Postgres:** append-only triggers refuse UPDATE, DELETE and TRUNCATE for every role, and the service role
  has no UPDATE grant. This is tested in `integrity_sql.test.js`.
- **Settlement** attaches outcomes in separate tables (`results`, `evaluations`, `miss_reviews`).

A BET that the fail-closed gate turned into PASS (MARKET_INTEGRITY.md §8) is frozen as PASS with its reason;
the engine's own word is kept in `status`.

## 7. Financial math (exact, tested)

`football/cfb_lab/sign_suite.test.js` §3-5 checks, with exact known answers:

| topic | known answers |
|---|---|
| American ↔ decimal | −110 ↔ 1.909091, +150 ↔ 2.5, ±100 ↔ 2.0, and round trips at book prices |
| break-even | −110 = 52.381%, +150 = 40%, −200 = 66.667% |
| devig | −110/−110 = 50/50 with a 4.762% overround |
| EV | 55% at −110 = +0.05; with a 5% push = +0.0475; at break-even exactly 0 |
| units | WIN at −110 = +0.9091, LOSS −1, PUSH 0, VOID none |
| CLV (points) | the METRICS examples and the road-favourite mirror |
| CLV (price) | −110 → −120 at the same line = +2.165 pp |
| fractional Kelly | 55% at −110 = 0.055 of bankroll, never more than quarter Kelly, 0 below break-even |

**Known quirk.** `lab_core.payout` / `toDecimal` accept a "price" of −50 (as 3.0 decimal). The SQL parity
copy does the same. Such prices cannot reach them, because every ingestion path refuses
`PRICE_NOT_AMERICAN`. Changing the shared function is a governed rule change (it feeds the opener/close
price medians), so it was not changed; the decision engine already refuses them.
