# football/cfb_terminal — the research terminal's cached research objects

`build.js` composes EdgeDesk's CFB production outputs into one research object
per game (`lib/cfb_terminal.js`) and writes what `research/cfb/` reads. It runs
hourly inside the Model Lab job (`.github/workflows/cfb-lab.yml`), right after
the Lab appends its snapshots. No page runs a model.

| File | What | Written |
|---|---|---|
| `board.json` | the queue: one compact row per game, counts, filters, the record headline, the scorecard | every build |
| `games.json` | the full research object per game (sections A–H, ask context) | every build |
| `record.json` | graded rows, calibration, benchmark, versions, postgame cards | every build |
| `brief.json` | the weekly research brief | every build |
| `history/<season>/snapshots.jsonl` | **append-only**: the champion's number, its additive terms and the QB state, one row per change (hash id) | when something changed |

```
npm run cfb:terminal            # build and write
npm run cfb:terminal:check      # build, verify, write nothing
npm run cfb:terminal:test       # rules + 20-game answerability audit + analytics SQL
npm run cfb:terminal:usertest   # the audit as a markdown table
node football/cfb_terminal/build.js --out /tmp/demo   # write elsewhere (no history)
```

The build refuses to write if a fair line differs from the champion slate, a
stale market would show an actionable status, or a BET appears while the policy
has betting off. Design, terminology and the audit: `docs/cfb-terminal/`.
