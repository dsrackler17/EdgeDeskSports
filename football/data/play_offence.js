/* ===========================================================================
   WHICH SIDE HAD THE BALL on a cfbfastR player_stats row.

   Every reader of player_stats_<season>.csv takes the `team` column as the
   offence. On a completion, a run, an interception or a sack it still is. On
   an INCOMPLETE PASS it stopped being so in the 2026-10-24 19:19 UTC rebuild
   of player_stats_2026.csv: about one incompletion in five is now filed under
   the DEFENCE (4,397 of 20,158 through week 8, against 7 of 18,333 in the
   2026-10-19 file), most of them the passes a defender broke up. Read as the
   feed has it, the offence loses those attempts and the defence gains
   attempts it never threw: every pass rate on the board moved, ETSR moved by
   1.8 points on average for teams that had not played, and the rankings
   build refused to publish (football-weekly-build, 2026-10-25).

   THE PASSER SETTLES IT. A quarterback's completions and runs in the same
   game are filed under his own team (34,802 of 34,841 completions agree with
   their drive), so an incompletion belongs to the team its passer completed
   or ran for in that game; failing that, to the team of the drive's
   completions and runs; failing that, it stays as the feed has it. The answer
   is only ever `team` or `opponent`, never a third team. On the 2026-10-19
   file and every earlier season this changes nothing.

   Usage: one pass over the rows calling `observe`, then `offence` for each
   incompletion row.
   =========================================================================== */
'use strict';

function create() {
  const passer = new Map();   /* game_id|athlete_id -> Map(team -> rows) */
  const drive = new Map();    /* drive_id -> Map(team -> rows) */
  function bump(m, k, team) {
    let c = m.get(k);
    if (!c) m.set(k, (c = new Map()));
    c.set(team, (c.get(team) || 0) + 1);
  }
  function top(c) {
    let best = null, n = -1;
    for (const [t, v] of c) if (v > n) { best = t; n = v; }
    return best;
  }
  return {
    /* a row whose `team` is the offence: a completion (its passer) or a run (its rusher) */
    observe(gameId, driveId, team, completionId, rushId) {
      if (!team) return;
      if (completionId) bump(passer, gameId + '|' + completionId, team);
      if (rushId) bump(passer, gameId + '|' + rushId, team);
      if (driveId && (completionId || rushId)) bump(drive, driveId, team);
    },
    /* the offence of an incompletion row: `team` or `opponent` */
    offence(gameId, driveId, team, opponent, incompletionId) {
      const c = (incompletionId && passer.get(gameId + '|' + incompletionId)) || (driveId && drive.get(driveId)) || null;
      const t = c ? top(c) : null;
      return t === opponent ? opponent : team;
    }
  };
}

module.exports = { create };
