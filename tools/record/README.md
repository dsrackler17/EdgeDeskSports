# EdgeDesk brief record — close the loop

Every published brief is graded against the closing line and the final, and
the result travels with the card, the share page and a public page.

| Piece | What | Where |
|---|---|---|
| Grader | reads public briefs, matches each published price to its closing fair line and result, grades deterministically | `tools/record/grade_briefs.js` |
| Schedule | hourly at :20, commits `record/grades.json` to `main` | `.github/workflows/grade-briefs.yml` |
| Close view | the owner-run door to post-kickoff signal rows (never a live price) | `supabase/brief_record.sql` |
| Card receipt | **Result** line on the decision card: `Closed -125. Beat the close by 15 cents. Won.` | `EDPRES.outcomeOf` → `cardHTML`, from the engine's own `clv / beat_close / closing_sharp_fair / result` |
| Share page | **How it graded** under the published call | `brief.html` reads `record/grades.json` |
| Public record | every published brief, filterable by preset (Game, TNF, SNF, MNF, College Football, Slate) | `record.html#briefs` |
| Calibration | how often BET / LEAN / WAIT beat the close, by sport and by preset. Internal. | app → Publisher desk → **Verdict calibration** |

## The rules

- The price graded is the **published** price, from the snapshot. Live odds
  never change a grade.
- The close is the engine's closing fair line (`signals.closing_sharp_fair`),
  the same close the CLV record on `record.html` grades against. CLV is the
  engine's own `fair × decimal − 1`. Cents are the gap on the sportsbook
  scale (-110 → -125 is 15 cents).
- A result comes from the close pipeline (`signals.result`) or, for football,
  from a final that ESPN / nflverse / cfbfastR agree on. Two sources that
  disagree grade **nothing** (`contested`).
- No closing row → the pick waits and says so (`no_signal_row`, or
  `no_close_source` until the view is deployed). Nothing is estimated.
- A graded pick is **never re-graded**. A withdrawn share link keeps its grade.
- A slate with **NO QUALIFYING BETS** is listed and counted as discipline.
- No AI anywhere in the grading path.

## Deploy

1. Run `supabase/brief_record.sql` in the SQL editor (creates
   `public_brief_closes`). Until then the grader reports `no_close_source`
   and every pick waits.
2. Merge. The `Grade published briefs` workflow needs no secret: it reads
   with the site's anon key and commits `record/grades.json` with
   `GITHUB_TOKEN`. Run it once by hand from the Actions tab to seed the file.
3. `record.html`, `brief.html` and `app.html` read `record/grades.json`
   beside themselves on GitHub Pages.

## Run it locally

    node tools/record/grade_briefs.js                 # dry run, prints the report
    node tools/record/grade_briefs.js --out record/grades.json
    node tools/record/grade_briefs.js --now 2026-09-08T12:00:00Z --json

## Tests

    node tools/record/grade_briefs.test.js
    node tools/record/record_page.test.js
    node tools/presentation/presentation.test.js      # receipt on the card, gradeable snapshots
    node tools/presentation/app_presentation.test.js  # strip + receipt + calibration overlay
