/* ============================================================================
   EdgeDesk NFL — raw efficiency-development evidence.

   Evidence only. No coaching score, reliability curve or NFL line adjustment.

   Game efficiency:
     offense EPA/play =
       (passing_epa + rushing_epa) /
       (attempts + sacks_suffered + carries)

     net EPA/play =
       team offense EPA/play - opponent offense EPA/play in the same game

   Development:
     mean(latest 3 net EPA/play) - mean(first 3 net EPA/play)

   Six distinct regular-season team-games are required so the early and recent
   windows do not overlap. This is NOT opponent-strength adjusted. That
   limitation is published rather than silently pretending otherwise.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_nfl_coaching_staff_efficiency_development_v1';

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function r4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

function offenseEpaPerPlay(row) {
  if (!row) return null;
  const pass = num(row.passing_epa);
  const rush = num(row.rushing_epa);
  const attempts = num(row.attempts);
  const sacks = num(row.sacks_suffered);
  const carries = num(row.carries);
  if (pass == null || rush == null || attempts == null || sacks == null || carries == null) return null;
  const plays = attempts + sacks + carries;
  return plays > 0 ? (pass + rush) / plays : null;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function build(rows, opts) {
  opts = opts || {};
  const season = Number(opts.season);
  const windowGames = opts.windowGames == null ? 3 : Math.max(2, Number(opts.windowGames) || 3);
  const minGames = windowGames * 2;
  const requested = Array.isArray(opts.teamKeys) ? opts.teamKeys.map(String) : [];
  const teams = {};

  function blank(team) {
    return {
      team,
      available: false,
      value: null,
      observations: 0,
      games_available: 0,
      window_games: windowGames,
      early_mean_net_epa_per_play: null,
      recent_mean_net_epa_per_play: null,
      early_game_ids: [],
      recent_game_ids: [],
      source: 'nflverse stats_team_week weekly team stats',
      opponent_strength_adjusted: false,
      reason: 'requires at least ' + minGames + ' regular-season team-games with complete EPA/play inputs'
    };
  }

  requested.forEach((team) => { teams[team] = blank(team); });

  if (!Number.isFinite(season)) {
    return { schema: SCHEMA, input: 'efficiency_development', season: null, window_games: windowGames, teams, error: 'season is required' };
  }

  const usable = (rows || []).filter((r) =>
    r && Number(r.season) === season &&
    String(r.season_type || 'REG').toUpperCase() === 'REG' &&
    r.team && r.opponent_team && r.game_id
  );

  const byGameTeam = {};
  usable.forEach((r) => {
    byGameTeam[String(r.game_id) + '|' + String(r.team)] = r;
  });

  const byTeam = {};
  usable.forEach((r) => {
    const team = String(r.team);
    if (requested.length && !requested.includes(team)) return;
    const opp = byGameTeam[String(r.game_id) + '|' + String(r.opponent_team)];
    const off = offenseEpaPerPlay(r);
    const oppOff = offenseEpaPerPlay(opp);
    const week = num(r.week);
    if (off == null || oppOff == null || week == null) return;
    (byTeam[team] = byTeam[team] || []).push({
      game_id: String(r.game_id),
      week,
      net_epa_per_play: off - oppOff
    });
  });

  requested.forEach((team) => {
    const row = teams[team];
    const games = (byTeam[team] || []).sort((a, b) => a.week - b.week || a.game_id.localeCompare(b.game_id));
    row.games_available = games.length;
    if (games.length < minGames) return;

    const early = games.slice(0, windowGames);
    const recent = games.slice(-windowGames);
    const earlyMean = mean(early.map((g) => g.net_epa_per_play));
    const recentMean = mean(recent.map((g) => g.net_epa_per_play));
    if (!Number.isFinite(earlyMean) || !Number.isFinite(recentMean)) return;

    row.observations = early.length + recent.length;
    row.early_mean_net_epa_per_play = r4(earlyMean);
    row.recent_mean_net_epa_per_play = r4(recentMean);
    row.early_game_ids = early.map((g) => g.game_id);
    row.recent_game_ids = recent.map((g) => g.game_id);
    row.value = r4(recentMean - earlyMean);
    row.available = true;
    row.reason = null;
  });

  return {
    schema: SCHEMA,
    input: 'efficiency_development',
    season,
    window_games: windowGames,
    min_games: minGames,
    formula: 'mean(latest window net EPA/play) - mean(first window net EPA/play)',
    denominator: 'attempts + sacks_suffered + carries; passing_epa includes sacks in nflverse',
    opponent_strength_adjusted: false,
    teams
  };
}

module.exports = { SCHEMA, offenseEpaPerPlay, build };
