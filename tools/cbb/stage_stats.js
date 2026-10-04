#!/usr/bin/env node
/* ===========================================================================
   STAGING THE PLAYER LINES, AND HANDING THE DECISION TO THE GATE.

   Same contract as stage.js: this writes only cbb.stg_player_games and then
   calls cbb.promote_cbb_stats. It has no opinion about whether the import is
   good — that judgement lives in the database, in one transaction, where a
   caller in a hurry cannot skip it.
   =========================================================================== */
'use strict';

const DB = require('./db.js');

const LINE_COLS = ['game_id', 'athlete_id', 'line_type', 'season', 'game_date',
  'team_id', 'team_name', 'opponent_team_id', 'athlete_name', 'position', 'jersey',
  'starter', 'ab', 'runs', 'hits', 'rbi', 'hr', 'bb', 'so', 'pitches_seen',
  'stolen_bases', 'outs', 'p_hits', 'p_runs', 'earned_runs', 'p_bb', 'p_so',
  'p_hr', 'pitch_count', 'strikes', 'season_avg_at_game', 'season_obp_at_game',
  'season_slg_at_game', 'season_era_at_game', 'source'];

async function stageAndPromoteStats(rawDb, importId, opts) {
  const db = DB.wrap(rawDb);
  const { lines, season } = opts;
  const log = opts.log || (() => {});
  const allowShrink = opts.allowShrink === true;

  await db.startRun({
    import_id: importId, dataset: 'stats', status: 'staging',
    first_season: season, last_season: season, seasons: [season],
    source: 'ESPN college baseball game summaries (box scores)',
    source_note: opts.sourceNote || null,
  });

  try {
    const n = await db.stageRows('stg_player_games', LINE_COLS, lines, importId);
    log(`staged ${n} player lines`);
  } catch (e) {
    await db.abandon(importId, 'staging failed: ' + e.message);
    throw e;
  }

  /* The season is handed over explicitly. The gate must judge the import
     against the season it SET OUT to cover, not the one it managed to return:
     an import throttled down to a handful of games compares a handful with a
     handful over its own span and passes the shrink check every time, which is
     precisely the failure that check exists to catch. */
  const verdict = await db.gate('promote_cbb_stats',
    ['p_import_id', 'p_allow_shrink', 'p_season'],
    { p_import_id: importId, p_allow_shrink: allowShrink, p_season: season });

  if (!verdict || verdict.ok !== true) {
    console.log('REFUSED | cbb stats | the gate declined this import and kept the previous archive:');
    for (const r of (verdict && verdict.refusals) || []) {
      console.log(`  - ${r.refusal}: ${r.detail}`);
    }
    process.exitCode = 1;
    return verdict || { ok: false, refusals: [] };
  }
  log('promoted: ' + JSON.stringify(verdict));
  return verdict;
}

module.exports = { stageAndPromoteStats, LINE_COLS };
