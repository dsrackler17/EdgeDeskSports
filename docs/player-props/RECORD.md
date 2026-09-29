# Player Props — the record

## Freeze (pregame, `node football/props/record.js freeze`)

For every prop with a fresh, priced market and a decision, `EDProps.freeze`
writes an **immutable prediction**. It carries:

- the player, prop, side, line, American price, book and quote capture time;
- the model probability and cover, the market probability, fair odds and fair
  line, and the projection mean and median;
- edge, EV, and the risk-adjusted probability and EV;
- the decision, reason code and units (after the card's exposure caps);
- reliability, confidence tier, stage, **model version**, projection id and
  frozen-at time.

The **prediction id is a hash of its content**.

A prediction is written:

- when the prop is first priced (**FIRST**);
- when its decision class changes (**DECISION_CHANGE**);
- inside the last three hours (**PREGAME_FINAL**), once, and again only if the
  price or decision moved.

Nothing is frozen at or after kickoff, and nothing is frozen from a stale price.
A later price is a **new** row; no row is ever updated.

The ledger is `football/props/ledger/<league>/<season>/predictions.jsonl`.
`record.js verify --base HEAD` fails the hourly job unless three things hold:

- the committed ledger is a prefix of the new one;
- every line's id matches its content;
- every line was frozen before its kickoff.

`tools/props/props_record.test.js` proves that an edited price, a removed row
and a late freeze are all caught.

## Grade (postgame, `record.js grade`)

Grading uses the same box score the model reads (nflverse / cfbfastR).

| Result | When |
|---|---|
| **WIN / LOSS** | by side against the line; Yes/No props grade on one or more |
| **PUSH** | a whole line landed exactly |
| **VOID** | the player did not play (books void a DNP), the game was not played, or the result is unavailable |

- **Units** are paid at the price taken. A flat 1U is also kept for every row.
- **CLV** is measured against EdgeDesk's **last capture before kickoff**:
  - price CLV: the no-vig probability at the *same* line, times the decimal price
    taken, minus one;
  - line CLV: in points.

  Line and price are never mixed.

The published record is `record/props/<league>_<season>.json`. Each prop counts
once in the headline, via its last pregame row, and **every decision class is
graded** (PASS included). It carries scorecards overall and by:

- prop type, position, tier and stage;
- confidence tier, book and decision;
- **model version**;
- week, edge bucket (0–2 / 2–4 / 4–7 / 7+ pp);

plus a calibration table with Wilson intervals, Brier against the market,
log-loss, CLV with a bootstrap interval, and the sample state (TOO EARLY /
EARLY SIGNAL / DEVELOPING / MEANINGFUL).

Model versions are frozen into each row: a V1.1 never rewrites V1.0's record.
