# Fixtures

## `fbs_schedule_sample.csv`

The **real** `cfbfastR-data` 2026 schedule feed, with only the columns the
board, the FBS universe and the engine actually read — 888 rows, 20 of the
feed's 32 columns. Nothing is invented, reordered or filtered: every game the
feed carries is here, so the universe built from it is the real 138-program,
eleven-conference universe rather than a fixture shaped to pass.

It exists so `fbs_board_ui.test.js` and `fbs_board.e2e.js` have a slate on a
runner with no network and no warm cache. Without it both suites skipped in
CI — steps that ran, reported success and proved nothing, which is worse than
no step at all.

Regenerate after a season rolls over:

```sh
npm run cfb:fbs                     # caches the current feed
node -e "
const fs=require('fs');
const KEEP=['game_id','season','week','season_type','start_date','completed',
 'neutral_site','conference_game','venue_id','venue','home_id','home_team',
 'home_division','home_conference','home_points','away_id','away_team',
 'away_division','away_conference','away_points'];
/* … see the git history of this file for the trimming script … */
"
```

The suites read this only when `football/fbs/.cache/` is absent, so a local
run after `npm run cfb:fbs` still exercises the live feed.

## `game_context_2026_wk07.json.gz`

The **real** inputs `tools/football/build_game_research.js` read on
2026-10-22 (commit `0743e51f`), trimmed to the games
`game_context.test.js` asserts on: the NFL's Thursday game, NE at CHI (its
referee, its trip and its consensus line), and two FBS games that between
them carry every edge signal the test looks for (Colorado State v San Diego
State, Michigan v Indiana). A game is kept or left out whole; nothing in a
kept game is edited.

It exists because the test used to build from the live slates, which roll
forward every week. Once NE at CHI was played it left
`football/nfl/slate.json` and the suite failed on every pull request.

Regenerate it, or move it to another week by changing the revision and the
game lists at the top of the script:

```sh
node tools/football/game_context_fixture.js --rev 0743e51f
```

The script reads the files with `git show`, so the revision must be in your
clone (`git fetch --unshallow` in a shallow one).
