#!/usr/bin/env node
'use strict';

/* ============================================================================
   CFB TEAM-GAME EFFICIENCY -> PRICING ENGINE CONTRACT

   This is an adapter, not another model. It converts the exact per-team-game
   aggregates already used by the national rankings pipeline into the subset of
   football/cfb_p4/engine.js efficiency inputs that the public play feed can
   actually measure.

   EPA fields are intentionally absent. The rankings contract documents why:
   the public play table does not carry a reproducible expected-points surface.
   Missing fields stay missing and widen uncertainty rather than becoming fake 0s.
   ========================================================================== */

const PERF = require('./performance.js');

const SCHEMA = 'edgedesk_cfb_engine_efficiency_v1';
const MEASURED = [
  'success_rate',
  'early_down_success',
  'yards_per_play',
  'sack_rate_allowed',
  'stuff_rate',
  'third_down_rate',
  'red_zone_success',
  'pass_rate',
  'plays_per_game'
];
const UNAVAILABLE = [
  'epa_per_play','epa_pass','epa_rush','passing_down_success','expl_epa_rate',
  'front_disruption_rate','points_per_drive','start_field_position'
];

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function ratio(n, d) {
  n = +n; d = +d;
  return isFinite(n) && isFinite(d) && d > 0 ? n / d : null;
}
function put(o, k, v) { if (isNum(v)) o[k] = v; }

function offense(agg) {
  if (!agg) return null;
  const plays = PERF.field(agg, 'plays_all');
  if (!(plays > 0)) return null;

  const out = {};
  put(out, 'success_rate', ratio(PERF.field(agg, 'success_all'), plays));
  put(out, 'early_down_success',
    ratio(PERF.field(agg, 'early_down_success'), PERF.field(agg, 'early_down_plays')));
  put(out, 'yards_per_play',
    ratio((PERF.field(agg, 'rush_yds') || 0) + (PERF.field(agg, 'pass_yds') || 0), plays));
  put(out, 'sack_rate_allowed',
    ratio(PERF.field(agg, 'sacks_taken'), PERF.field(agg, 'dropbacks')));
  put(out, 'stuff_rate',
    ratio(PERF.field(agg, 'rush_stuffed'), PERF.field(agg, 'rush_att')));
  put(out, 'third_down_rate',
    ratio(PERF.field(agg, 'third_success'), PERF.field(agg, 'third_plays')));
  put(out, 'red_zone_success',
    ratio(PERF.field(agg, 'rz_success'), PERF.field(agg, 'rz_plays')));
  put(out, 'pass_rate',
    ratio(PERF.field(agg, 'dropbacks'), plays));
  put(out, 'plays_per_game', plays);
  return out;
}

function withDefense(ownAgg, oppAgg) {
  const out = offense(ownAgg) || {};
  const opp = offense(oppAgg);
  if (!opp) return out;
  for (const k of MEASURED) {
    if (isNum(opp[k])) out['def_' + k] = opp[k];
  }
  return out;
}

function build(teamGames, opts) {
  opts = opts || {};
  const rowsResult = PERF.gameRows(teamGames, { fbs: opts.fbs || {}, competitive: true });
  const grouped = {};

  for (const r of rowsResult.rows) {
    if (!r || r.game_id == null) continue;
    const gid = String(r.game_id);
    (grouped[gid] = grouped[gid] || []).push(r);
  }

  const games = {};
  let teamGameRows = 0, gamesWithStats = 0;
  for (const gid of Object.keys(grouped)) {
    const rows = grouped[gid];
    const teams = {};
    for (const r of rows) {
      if (!r || !r.team || r.play_evidence === false) continue;
      const opp = rows.find(x => x !== r && x && x.team === r.opp)
        || rows.find(x => x !== r && x);
      const stats = withDefense(r.agg, opp && opp.agg);
      if (!stats || !Object.keys(stats).length) continue;
      teams[r.team] = stats;
      teamGameRows++;
    }
    if (Object.keys(teams).length) {
      games[gid] = { teams };
      gamesWithStats++;
    }
  }

  return {
    schema: SCHEMA,
    version: 1,
    season: opts.season == null ? null : +opts.season,
    generated_at: opts.generated_at || new Date().toISOString(),
    source: 'national rankings team-game aggregates from the public cfbfastR play table',
    garbage_time: 'competitive plays at full weight plus the declared rankings garbage-time residual weight',
    measured_features: MEASURED.slice(),
    unavailable_features: UNAVAILABLE.slice(),
    games_with_stats: gamesWithStats,
    team_game_rows: teamGameRows,
    duplicate_team_games: rowsResult.duplicate_team_games || [],
    games
  };
}

module.exports = { SCHEMA, MEASURED, UNAVAILABLE, offense, withDefense, build };
