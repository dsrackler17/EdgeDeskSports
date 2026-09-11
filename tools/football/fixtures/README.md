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
