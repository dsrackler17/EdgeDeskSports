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

/* the client speaks sql(text) and rows(text); literals are ours to quote */
function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function chunk(rows, n) {
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

async function stageAndPromote(db, importId, opts) {
  const { season, from, through, games, teams } = opts;
  const log = opts.log || (() => {});
  const allowShrink = opts.allowShrink === true;

  db.sql(`insert into cbb.import_runs (import_id, dataset, status, first_season, last_season,
             seasons, source, source_note)
           values (${lit(importId)}, 'games', 'staging', ${season}, ${season},
                   array[${season}]::int[],
                   'ESPN college baseball scoreboard and team schedules',
                   ${lit(`union of the day scoreboard and the ${teams.length}-team schedule walk, `
                     + `${from}..${through}`)})`);

  try {
    /* staged in chunks: one statement per game would be thousands of round
       trips, and one statement for all of them would be a megabyte of SQL */
    let n = 0;
    for (const part of chunk(games, 400)) {
      db.sql(`insert into cbb.stg_games (import_id, ${GAME_COLS.join(', ')}) values `
        + part.map((g) => '(' + lit(importId) + ', ' + GAME_COLS.map((c) => {
          const v = g[c];
          if (c === 'seen_by') return 'array[' + (v || []).map((s) => lit(s)).join(',') + ']::text[]';
          return lit(v === undefined ? null : v);
        }).join(', ') + ')').join(', '));
      n += part.length;
    }
    log(`staged ${n} games`);

    let t = 0;
    for (const part of chunk(teams, 400)) {
      db.sql(`insert into cbb.stg_teams (import_id, ${TEAM_COLS.join(', ')}) values `
        + part.map((x) => '(' + lit(importId) + ', '
          + TEAM_COLS.map((c) => lit(x[c] === undefined ? null : x[c])).join(', ') + ')').join(', '));
      t += part.length;
    }
    log(`staged ${t} teams`);
  } catch (e) {
    db.sql(`select cbb.abandon_cbb_import(${lit(importId)}, ${lit('staging failed: ' + e.message)})`);
    throw e;
  }

  /* the window is handed over explicitly: the gate must judge the import
     against what it set out to fetch, not against what it managed to */
  const res = db.rows(`select cbb.promote_cbb_import(${lit(importId)}, ${allowShrink}, `
    + `${lit(from)}::date, ${lit(through)}::date) as v`)[0];
  const verdict = typeof res.v === 'string' ? JSON.parse(res.v) : res.v;

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
