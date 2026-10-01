# The football model record

The research tool's own record, NFL and college (FBS). It grades the **number
the football model publishes** — the fair spread, total and win probability on
`football/nfl/slate.json` and `football/fbs/slate.json`, the same engine run the
Football board prints — against the closing line and the final score.

It is **not** the edges record. The Record tab's edges record grades prices the
capture flagged (`signals`, price CLV). Nothing here reads or writes `signals`,
and the app shows the two as separate books (Record → *Football record & P&L*).

| File | What |
|---|---|
| `nfl_<season>.json` | one entry per NFL game: first number, last pregame number (the pick), the entry (first model + market pair), close, final, grade |
| `cfb_<season>.json` | the same for every FBS game on the slate, with conference, group and matchup type |
| `summary.json` | per-sport totals the app reads: ATS / totals / straight-up records and their units, the moneyline, net units, CLV, margin error, Brier, by week (with a running total), by CFB group, by points off the close, favourite/underdog, home/away, over/under |

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

## Profit and loss

Every graded pick is also priced, so the record reads in units as well as
wins (`grade.pnl` on each game; units on every record in `summary.json`).

- **1 unit, flat,** on the spread side, the total side and the straight-up
  pick (the model's favourite, on the moneyline).
- **At the closing price of that side,** captured with the closing line from
  the same source (`close.prices`: `home`, `away`, `over`, `under`,
  `home_ml`, `away_ml`). A price is taken only for the exact line and book the
  close holds, and a held price is never replaced.
- **No captured price:** a spread or total is priced at the standard −110
  (the same −110 the 52.4% break-even assumes) and marked
  `basis: "standard"`; a moneyline has no standard price, so it counts in the
  straight-up record and carries no P&L.
- **ROI = units ÷ units risked.** A push returns the stake and risks nothing.
  The arithmetic is `lib/edgedesk_pnl.js`, the same kernel as `record/pnl/`.
- **Backfill:** NFL closing prices come with the nflverse row on the next run.
  A graded college game without one is asked for it through ESPN's summary,
  newest first, at most three times (`close_price_asks`).

The app shows all of it in Record → *Football record & P&L*. EdgeDesk's BET
recommendations (props and game decisions, `record/pnl/`) are the last part
of that page, with the model-record rows left out so no pick counts twice.

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
