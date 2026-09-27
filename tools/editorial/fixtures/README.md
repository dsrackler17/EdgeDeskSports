# Editorial fixtures

**Everything in this folder is SYNTHETIC and is labelled as such.** None of it
is a real box score, a real final or a real EdgeDesk projection, and nothing
here is ever read by the pipeline — only by
`tools/editorial/editorial.test.js`.

That separation matters more here than in most test folders. The whole
editorial system exists to publish only what EdgeDesk can actually verify, so
a fixture that leaked into the committed store would be the precise failure the
product is built to prevent. The store the pipeline reads is
`articles/data/editorial/`; this folder is not on that path, and the suite
never writes to it.

## What each file is for

| file | what it is |
| --- | --- |
| `espn_summary.json` | a realistic ESPN `summary` payload — the shape `results.normalizeSummary()` parses. Team statistics, drives, scoring plays, win probability, leaders. Synthetic numbers, real shape. |
| `espn_summary_thin.json` | the same game as the provider publishes it four minutes after the whistle: two scores, no box score. The readiness gate must refuse it. |
| `scenarios.js` | the four result/process quadrants the product brief names, plus a push, a dramatic market move, a turnover-driven game and one whose spread result flips on the last score. Each is a pregame research payload plus a final, and the suite asserts what the grader must say about each. |

## Why the shape is copied rather than invented

`normalizeSummary()` reads ESPN's own field names — `totalYards`,
`thirdDownEff`, `completionAttempts`, `possessionTime`, `sacksYardsLost` — and
several of them arrive as one string that has to be split (`"5-13"`,
`"22-35"`, `"31:12"`). A fixture written in a tidier shape would test a parser
nobody has, so these keep the provider's spelling, its `displayValue`/`value`
pairing and its away-first team order.
