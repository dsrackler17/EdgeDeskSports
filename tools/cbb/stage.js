#!/usr/bin/env node
/* ===========================================================================
   STAGING, AND HANDING THE DECISION TO THE GATE.

   This writes only cbb.stg_games and cbb.stg_teams, then calls
   cbb.promote_cbb_import and reports what it said. It has no opinion about
   whether the import is good: that judgement lives in the database, in one
   transaction, where it cannot be skipped by a caller in a hurry.

   The one thing it does decide is what to do with a refusal, and the answer
   is nothing — a refused import leaves the previous card exactly where it
   was, which is the entire point of staging.
   =========================================================================== */
'use strict';

const GAME_COLS = ['game_id', 'season', 'game_date', 'start_time', 'start_time_tbd',
  'away_team_id', 'home_team_id', 'away_name', 'home_name', 'away_abbr', 'home_abbr',
  'venue', 'venue_city', 'venue_state', 'neutral_site', 'conference_game',
  'status_state', 'status_detail', 'completed', 'away_score', 'home_score', 'innings',
  'away_rank', 'home_rank', 'notes', 'seen_by'];

const TEAM_COLS = ['team_id', 'name', 'short_name', 'abbreviation', 'slug',
  'conference_id', 'conference_name', 'logo', 'color', 'first_seen_season', 'last_seen_season'];

/* Both backends behind one interface. THIS USED TO EMIT SQL TEXT DIRECTLY,
   which meant it worked against the psql test harness and could never have
   worked against Supabase, where there is nothing to execute SQL text. See
   the note at the top of tools/cbb/db.js. */
const DB = require('./db.js');
const { lit, chunk } = DB;

async function stageAndPromote(rawDb, importId, opts) {
  const db = DB.wrap(rawDb);
  const { season, from, through, games, teams } = opts;
  const log = opts.log || (() => {});
  const allowShrink = opts.allowShrink === true;

  await db.startRun({
    import_id: importId, dataset: 'games', status: 'staging',
    first_season: season, last_season: season, seasons: [season],
    source: 'ESPN college baseball scoreboard and team schedules',
    source_note: `union of the day scoreboard and the ${teams.length}-team schedule walk, `
      + `${from}..${through}`,
  });

  try {
    /* staged in chunks: one round trip per game would be thousands of them,
       and one for all of them would be a megabyte of request body */
    const n = await db.stageRows('stg_games', GAME_COLS, games, importId);
    log(`staged ${n} games`);
    const t = await db.stageRows('stg_teams', TEAM_COLS, teams, importId);
    log(`staged ${t} teams`);
  } catch (e) {
    await db.abandon(importId, 'staging failed: ' + e.message);
    throw e;
  }

  /* the window is handed over explicitly: the gate must judge the import
     against what it set out to fetch, not against what it managed to */
  const verdict = await db.gate('promote_cbb_import',
    ['p_import_id', 'p_allow_shrink', 'p_from', 'p_through'],
    { p_import_id: importId, p_allow_shrink: allowShrink, p_from: from, p_through: through });

  if (!verdict || verdict.ok !== true) {
    console.log('REFUSED | cbb import | the gate declined this import and kept the previous card:');
    for (const r of (verdict && verdict.refusals) || []) console.log(`  - ${r.code}: ${r.detail}`);
    process.exitCode = 1;
    return verdict;
  }
  log('promoted: ' + JSON.stringify(verdict.rows));
  console.log(`PASS | cbb import | promoted ${verdict.rows.games} games, `
    + `${verdict.rows.teams} teams, ${verdict.rows.team_seasons} team-seasons`);
  return verdict;
}

module.exports = { stageAndPromote, GAME_COLS, TEAM_COLS, chunk, lit };
