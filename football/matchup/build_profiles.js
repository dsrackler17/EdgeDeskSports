#!/usr/bin/env node
/* ============================================================================
   Build football/matchup/profiles_<season>.json from the play feed.

   Same download the starter build uses (and the same cache entry, so one run
   of both costs one fetch). Writes one profile per team with an all-plays
   view and a garbage-time-excluded view, every rate carrying its own n.

     node football/matchup/build_profiles.js [--season 2026] [--offline] [--quiet]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const P = require(path.join(HERE, 'profiles.js'));
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));

const CFB = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || String(v).startsWith('--')) ? true : v;
}
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }

const COLS = ['game_id', 'season', 'week', 'team', 'conference', 'opponent', 'team_score', 'opponent_score',
  'drive_id', 'play_id', 'period', 'yards_to_goal', 'down', 'distance',
  'reception_player_id', 'reception_yds', 'completion_player_id', 'rush_player_id', 'rush_yds',
  'incompletion_player_id', 'sack_taken_player_id', 'sack_player_id',
  'interception_player_id', 'interception_thrown_player_id',
  'touchdown_player_id', 'fumble_player_id', 'fumble_forced_player_id', 'pass_breakup_player_id'];

async function build(sess, season, opts) {
  opts = opts || {};
  const src = await sess.cached(`${CFB}/player_stats/csv/player_stats_${season}.csv`,
    `pstats_${season}.csv`, { season, min_bytes: 5000, timeout_ms: 180000, retries: opts.offline ? 0 : 2 });
  if (!src.ok) return { ok: false, why: `player_stats_${season}.csv could not be read (${src.error || src.status})`, source: src };
  const rows = R.parseCsv(src.text, { columns: COLS });
  const profiles = P.build(rows);
  const gates = profiles.__gates; const teamGames = profiles.__team_games; const gateBasis = profiles.__gate_basis;
  delete profiles.__gates; delete profiles.__team_games; delete profiles.__gate_basis;
  return {
    ok: true, season, teams: profiles, team_count: Object.keys(profiles).length,
    gates, team_games: teamGames, gate_basis: gateBasis,
    rows: rows.length,
    source: { url: src.url, from: src.from, retrieved_at: src.retrieved_at, status: src.status }
  };
}

async function main() {
  const season = +(arg('season', defaultSeason()));
  const quiet = !!arg('quiet', false);
  const log = (...a) => { if (!quiet) console.error(...a); };
  const sess = R.session();
  const out = await build(sess, season, { offline: !!arg('offline', false) });
  if (!out.ok) { console.error('[profiles] ' + out.why); return 1; }
  const body = {
    schema: P.SCHEMA + '_set', version: P.VERSION, season,
    generated_at: new Date().toISOString(),
    source: out.source, rows_read: out.rows, team_count: out.team_count,
    team_games: out.team_games,
    column_gates: out.gates, column_gate_basis: out.gate_basis,
    garbage_time_basis: P.GARBAGE_BASIS,
    limits: P.LIMITS,
    note: 'Every rate here is a count from this season’s plays and is NOT opponent-adjusted. '
      + 'A team that has played weaker opponents reads better than it is, and the packet that uses these '
      + 'says so beside every pairing.',
    teams: out.teams
  };
  fs.writeFileSync(path.join(HERE, `profiles_${season}.json`), JSON.stringify(body, null, 1) + '\n');
  log(`[profiles] ${season}: ${out.team_count} teams from ${out.rows} plays (${out.source.from})`);
  return 0;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('[profiles] ' + ((e && e.stack) || e)); process.exit(2); });
}
module.exports = { build, COLS };
