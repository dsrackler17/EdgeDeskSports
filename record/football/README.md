# The football model record

The research tool's own record, NFL and college (FBS). It grades the **number
the football model publishes** — the fair spread, total and win probability on
`football/nfl/slate.json` and `football/fbs/slate.json`, the same engine run the
Football board prints — against the closing line and the final score.

It is **not** the edges record. The Record tab's edges record grades prices the
capture flagged (`signals`, price CLV). Nothing here reads or writes `signals`,
and the app shows the two as separate records (Records → *Advanced Analytics* → *Football model record*).

| File | What |
|---|---|
| `nfl_<season>.json` | one entry per NFL game: first number, last pregame number (the pick), the entry (first model + market pair), close, final, grade |
| `cfb_<season>.json` | the same for every FBS game on the slate, with conference, group and matchup type |
| `summary.json` | per-sport totals the app reads: ATS / totals / straight-up records, CLV, margin error, Brier, by week, by CFB group |

Written by `tools/record/football_record.js` from
`.github/workflows/football-model-record.yml` (hourly in season, and right after
either slate is rebuilt). Nobody edits these by hand.

## The rules

- **Pregame only.** A number is recorded only if it was published before
  kickoff (the slate's `generated_at`; when replayed from git history, the
  commit time too). A later number is refused, never stored.
- **The pick is the last pregame number.** The first number is kept beside it.
- **Against the spread / total:** the model's side is its pick against the
  **closing** line, graded on the final margin (or total).
- **CLV, in points:** how far the market moved toward the side the model
  leaned, from the **entry** — the first moment the record held both the
  model's number and a market number, before kickoff — to the close. Measured
  only when the entry quote and the close come from the same source.
- **Nothing is estimated.** No close, no final, no total: that part waits. A
  final is set once; two feeds that disagree settle nothing.

## A record, not P&L — and the closing prices it keeps

No entry price was ever captured with the model's number, so this record is
**wins and losses**. The Records page shows it that way, by market, under
*Historical model results*, labelled *record only*. The Records page's P&L is
only ever EdgeDesk's BET recommendations at the entry price it recorded
(`record/pnl/`); this record is never turned into units there.

What the record does keep, as auditable data:

- **Closing prices** (`close.prices`: `home`, `away`, `over`, `under`,
  `home_ml`, `away_ml`), captured with the closing line from the same source.
  A price is taken only for the exact line and book the close holds, and a
  held price is never replaced. NFL prices come with the nflverse row; a
  graded college game without one is asked for it through ESPN's summary,
  newest first, at most three times (`close_price_asks`).
- **`grade.pnl`**: a side at its captured closing price, 1 unit, by
  `lib/edgedesk_pnl.js`. No captured price, no units — the record never
  assumes −110. These are closing-price figures, not the Records page's P&L,
  and nothing on the page shows them.

## Sources (public, keyless)

| | Market at entry | Close | Final |
|---|---|---|---|
| NFL | nflverse consensus — the slate's own reference line from the same build | nflverse consensus once the result is posted | nflverse |
| CFB | ESPN scoreboard line (the book ESPN names) | ESPN's line frozen at kickoff; where ESPN keeps none for a finished game, the last ESPN line this record captured before kickoff (`close.basis: "last pregame capture"`) | ESPN and cfbfastR, which must agree |

## Commands

```
npm run record:football:dry        # what a run would record, writes nothing
npm run record:football            # record, close, settle, grade, write
npm run record:football:backfill   # replay the slates' committed history first (needs full history)
npm run record:football:test
```
