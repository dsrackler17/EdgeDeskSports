/* ===========================================================================
   EdgeDesk player props — THE POINT-IN-TIME FEATURE ENGINE (Phase D).

   Every feature of every row uses ONLY information that existed before that
   row's as-of time. The guarantee is structural, not a convention:

     1. Games are replayed in kickoff order. A game's box score enters the
        engine's state only when it is FINAL — kickoff + FINAL_LAG (4 h) — and
        only once the replay clock has passed that instant. A 1 pm game can
        never feed a 4:25 pm game on the same day.
     2. A row's features are computed from that state BEFORE the row's own
        game is added. The current game cannot enter its own last-3, last-5,
        last-8 or season average: rolling windows are "shifted before rolling"
        by construction.
     3. Every row carries source_max_timestamp = the latest availability time
        of anything it read. assertPit() refuses (quarantines, rule Q008) any
        row where source_max_timestamp > asof_at, and football/props/leakage.test.js
        recomputes rows by hand and proves a future game cannot move a feature.

   HISTORICAL AS-OF. A training row is as of kickoff: the final injury report
   and inactive list, the starting quarterback, the closing spread and total —
   all known before the snap. A live row is as of the scoring time, with
   whatever is known then; the live scorer widens the distribution for what
   is not yet known (questionable tags, an unannounced starter).

   SMALL SAMPLES ARE SHRUNK. Every efficiency rate is (sum + K·league rate) /
   (volume + K); every per-game volume has an empirical-Bayes composite that
   leans on last season, then the position baseline, until the player has
   earned his own average. A two-game heater is two games.
   =========================================================================== */
'use strict';
const REG = require('./config/feature_registry.json');

const FEATURE_VERSION = 'pf1';
const FINAL_LAG_MS = 4 * 3600e3;          /* a box score is final four hours after kickoff */
const DAY = 86400e3;

/* ------------------------------------------------------------ stats */
/* per-game stats tracked for every player (registry names map onto them) */
const STATS = ['attempts', 'completions', 'passing_yards', 'passing_tds', 'interceptions', 'carries', 'rushing_yards', 'rushing_tds', 'targets', 'receptions',
  'receiving_yards', 'receiving_tds', 'air_yards', 'yac', 'red_zone_touches', 'goal_line_touches', 'dropbacks', 'scrambles', 'designed_rushes',
  'longest_completion', 'longest_rush', 'longest_reception', 'tds', 'pass_rush_yards', 'rush_rec_yards', 'pass_rush_rec_yards', 'receptions_rush_attempts',
  'snap_share', 'passing_epa', 'passing_cpoe', 'explosive_rec', 'explosive_rush', 'sacks_taken', 'fumbles_lost'];
/* registry name prefix → tracked stat */
const REG_STAT = { pass_attempts: 'attempts', pass_completions: 'completions', passing_yards: 'passing_yards', passing_tds: 'passing_tds', interceptions: 'interceptions',
  carries: 'carries', rushing_yards: 'rushing_yards', rushing_tds: 'rushing_tds', targets: 'targets', receptions: 'receptions', receiving_yards: 'receiving_yards',
  receiving_tds: 'receiving_tds', air_yards: 'air_yards', yac: 'yac', red_zone_touches: 'red_zone_touches' };
/* stats a market settles on (the model targets) */
const TARGET_OF = {
  pass_yards: (r) => r.passing_yards, pass_tds: (r) => r.passing_tds, pass_completions: (r) => r.completions, pass_attempts: (r) => r.attempts,
  pass_interceptions: (r) => r.interceptions, pass_longest_completion: (r) => r.longest_completion, rush_yards: (r) => r.rushing_yards, rush_attempts: (r) => r.carries,
  rush_tds: (r) => r.rushing_tds, longest_rush: (r) => r.longest_rush, receiving_yards: (r) => r.receiving_yards, receptions: (r) => r.receptions, targets: (r) => r.targets,
  receiving_tds: (r) => r.receiving_tds, longest_reception: (r) => r.longest_reception, anytime_td: (r) => sumN(r.rushing_tds, r.receiving_tds),
  pass_rush_yards: (r) => sumN(r.passing_yards, r.rushing_yards), rush_rec_yards: (r) => sumN(r.rushing_yards, r.receiving_yards),
  pass_rush_rec_yards: (r) => sumN(r.passing_yards, r.rushing_yards, r.receiving_yards), receptions_rush_attempts: (r) => sumN(r.receptions, r.carries)
};
function sumN() { let s = 0; for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v == null || !isFinite(v)) return null; s += v; } return s; }
function isNum(x) { return typeof x === 'number' && isFinite(x); }
function statOf(r, k) {
  switch (k) {
    case 'tds': return sumN(r.rushing_tds, r.receiving_tds);
    case 'pass_rush_yards': return sumN(r.passing_yards, r.rushing_yards);
    case 'rush_rec_yards': return sumN(r.rushing_yards, r.receiving_yards);
    case 'pass_rush_rec_yards': return sumN(r.passing_yards, r.rushing_yards, r.receiving_yards);
    case 'receptions_rush_attempts': return sumN(r.receptions, r.carries);
    default: { const v = r[k]; return isNum(v) ? v : null; }
  }
}

/* ------------------------------------------------------------ names */
/* The feature vector: registry features first (in registry order, filtered to
   what this engine computes), then the engine's own extras. */
const WINDOWS = [['l3', 3], ['l5', 5], ['l8', 8]];
function featureNames() {
  const names = [];
  const add = (n) => { if (names.indexOf(n) < 0) names.push(n); };
  REG.features.forEach((f) => add(f.feature));
  STATS.forEach((s) => { WINDOWS.forEach((w) => add(s + '_avg_' + w[0])); add(s + '_season_avg'); add(s + '_prev_season_avg'); add(s + '_eb'); });
  ['games_l8', 'games_season', 'games_career', 'games_prev_season', 'target_share_l5', 'rush_share_l5', 'air_yard_share_l5', 'target_share_season', 'rush_share_season',
    'reception_share_l5', 'rec_yards_share_l5', 'snap_share_l5', 'qb_change', 'qb_starts_with_team', 'team_plays_l5', 'team_pass_rate_l5', 'team_points_l5', 'team_pass_attempts_l5',
    'team_rushes_l5', 'team_dropbacks_l5', 'opp_epa_per_dropback_allowed_l8', 'opp_sack_rate_l8', 'opp_rush_epa_allowed_l8', 'opp_explosive_rush_rate_allowed_l8',
    'opp_rec_yards_allowed_te_l8', 'opp_rec_yards_allowed_rb_l8', 'opp_points_allowed_l8', 'opp_plays_allowed_l8', 'opp_pass_attempts_allowed_l8', 'opp_rushes_allowed_l8',
    'opp_completion_rate_allowed_l8', 'teammate_air_yards_vacated_share', 'teammate_rz_vacated_share', 'cfb_career_reception_share', 'cfb_career_rec_ypg',
    'cfb_final_rec_yards_share', 'cfb_career_rush_ypg', 'cfb_final_pass_ypg', 'cfb_seasons', 'market_context_is_model', 'is_starter_qb', 'week_of_season', 'kickoff_hour_local_proxy'].forEach(add);
  return names;
}
const NAMES = featureNames();
const IDX = new Map(NAMES.map((n, i) => [n, i]));
/* features this engine never computes, and why (the registry keeps them so the
   UI and the docs say so instead of pretending) */
const UNAVAILABLE = {
  route_participation_l3: 'no public route data for either league', yards_per_route_l8: 'no public route data for either league',
  ol_starter_continuity: 'no reliable public OL starter feed', player_class_year: null, weather_precip_prob: 'historical games carry no precipitation forecast',
  prop_consensus_line: 'market input: used by the calibration layer, never by the outcome model', prop_best_over_price: 'market input', prop_best_under_price: 'market input',
  prop_line_dispersion: 'market input', prop_price_dispersion: 'market input', prop_open_to_now_move: 'market input', prop_minutes_since_move: 'market input', book_count: 'market input',
  cfb_career_target_share: 'CFB box scores carry no targets: cfb_career_reception_share is the stated substitute'
};

/* ------------------------------------------------------------ helpers */
function mean(a) { let s = 0, n = 0; for (const v of a) if (isNum(v)) { s += v; n++; } return n ? s / n : null; }
function lastN(arr, n) { return arr.length <= n ? arr : arr.slice(arr.length - n); }
function avgStat(entries, k) { return mean(entries.map((e) => e.s[k])); }
function ratio(num, den, k, prior) {
  if (!isNum(num) || !isNum(den)) return null;
  if (!isNum(prior)) return den > 0 ? num / den : null;
  return (num + k * prior) / (den + k);
}
function sumOf(entries, k) { let s = 0, n = 0; for (const e of entries) { const v = e.s ? e.s[k] : e[k]; if (isNum(v)) { s += v; n++; } } return n ? s : null; }

/* ------------------------------------------------------------ the engine */
function createEngine(league, opts) {
  opts = opts || {};
  const P = new Map(), T = new Map(), D = new Map();       /* player, team offence, team defence histories */
  const pending = [];                                      /* results waiting for their final time */
  const baseline = new Map();                              /* season -> {pos -> per-game means}, league rates */
  const seasonAcc = new Map();                             /* season -> accumulators for next season's priors */
  const qbStarts = new Map();                              /* team -> [{kickoff, qb}] */
  const cfbHistory = opts.cfbHistory || null;              /* player_id -> CFB career (for NFL transition) */
  let clock = -Infinity;

  function acc(season) {
    let a = seasonAcc.get(season);
    if (!a) { a = { pos: {}, rates: { pass_att: 0, pass_yds: 0, cmp: 0, rush: 0, rush_yds: 0, tgt: 0, rec: 0, rec_yds: 0, exp_rec: 0, exp_rush: 0, dropbacks: 0, epa_db: 0, sacks: 0, hits: 0,
      exp_pass: 0, rush_epa: 0, tg: 0, tgt_rb: 0, tgt_te: 0, recyds_wr: 0, recyds_te: 0, recyds_rb: 0, pts: 0, plays: 0 } }; seasonAcc.set(season, a); }
    return a;
  }
  /* priors for a season: last season's league rates (or this season's so far
     when there is no last season in the window) */
  function priorsFor(season) {
    const prev = seasonAcc.get(season - 1), cur = seasonAcc.get(season);
    const src = prev && prev.rates.tg > 50 ? prev : cur;
    const R = src ? src.rates : null;
    const tg = R && R.tg ? R.tg : 1;
    return {
      ypa: R && R.pass_att ? R.pass_yds / R.pass_att : (league === 'NFL' ? 7.0 : 7.4), ypc: R && R.rush ? R.rush_yds / R.rush : (league === 'NFL' ? 4.3 : 4.6),
      ypt: R && R.tgt ? R.rec_yds / R.tgt : 7.8, catch: R && R.tgt ? R.rec / R.tgt : 0.64, cmp: R && R.pass_att ? R.cmp / R.pass_att : 0.62,
      exp_rec: R && R.tgt ? R.exp_rec / R.tgt : 0.09, exp_rush: R && R.rush ? R.exp_rush / R.rush : 0.05,
      epa_db: R && R.dropbacks ? R.epa_db / R.dropbacks : 0.05, sack: R && R.dropbacks ? R.sacks / R.dropbacks : 0.065,
      pressure: R && R.dropbacks ? (R.sacks + R.hits) / R.dropbacks : 0.22, exp_pass: R && R.pass_att ? R.exp_pass / R.pass_att : 0.08,
      rush_epa: R && R.rush ? R.rush_epa / R.rush : -0.1, tgt_rb_rate: R && R.pass_att ? R.tgt_rb / R.pass_att : 0.18, tgt_te_rate: R && R.pass_att ? R.tgt_te / R.pass_att : 0.2,
      recyds_wr_pg: R ? R.recyds_wr / tg : 150, recyds_te_pg: R ? R.recyds_te / tg : 50, recyds_rb_pg: R ? R.recyds_rb / tg : 40, pts_pg: R ? R.pts / tg : 23, plays_pg: R ? R.plays / tg : 63
    };
  }
  function posBaseline(season, pg, stat) {
    const a = seasonAcc.get(season - 1) || seasonAcc.get(season);
    const b = a && a.pos[pg];
    return b && b.n ? (b.sum[stat] || 0) / (b.cnt[stat] || b.n) : null;
  }

  /* results become visible at kickoff + FINAL_LAG */
  function addGame(game, playerRows, teamRows) {
    const at = Date.parse(game.kickoff_utc) + FINAL_LAG_MS;
    pending.push({ at, game, playerRows, teamRows });
    pending.sort((a, b) => a.at - b.at);
  }
  function advance(toMs) {
    while (pending.length && pending[0].at <= toMs) {
      const it = pending.shift();
      commit(it);
    }
    clock = Math.max(clock, toMs);
  }
  function commit(it) {
    const g = it.game, at = it.at, kick = Date.parse(g.kickoff_utc);
    const teamBy = new Map(it.teamRows.map((t) => [t.team_id, t]));
    it.teamRows.forEach((t) => {
      const e = { kickoff: kick, at, season: g.season, plays: t.plays, dropbacks: t.dropbacks, pass_attempts: t.pass_attempts, rushes: t.rushes, points: t.points,
        spp: t.seconds_per_play, npr: t.neutral_pass_rate, proe: t.proe, rz_plays: t.rz_plays, gl_plays: t.gl_plays, air_yards: t.air_yards, completions: t.completions,
        pass_yards: t.pass_yards, rush_yards: t.rush_yards };
      push(T, t.team_id, e);
      /* the same row, seen from the defence that faced it */
      const d = { kickoff: kick, at, season: g.season, pass_attempts: t.pass_attempts, completions: t.completions, pass_yards: t.pass_yards, rushes: t.rushes, rush_yards: t.rush_yards,
        dropbacks: t.dropbacks, sacks: t.sacks, qb_hits: t.qb_hits, explosive_pass: t.explosive_pass, explosive_rush: t.explosive_rush,
        pass_epa: t.pass_epa_sum, rush_epa: t.rush_epa_sum, tgt_rb: t.tgt_rb, tgt_te: t.tgt_te, tgt_wr: t.tgt_wr, recyds_wr: t.recyds_wr, recyds_te: t.recyds_te, recyds_rb: t.recyds_rb,
        points: t.points, plays: t.plays };
      push(D, t.opponent_id, d);
      const a = acc(g.season).rates;
      addR(a, 'pass_att', t.pass_attempts); addR(a, 'pass_yds', t.pass_yards); addR(a, 'cmp', t.completions); addR(a, 'rush', t.rushes); addR(a, 'rush_yds', t.rush_yards);
      addR(a, 'dropbacks', t.dropbacks); addR(a, 'epa_db', t.pass_epa_sum); addR(a, 'sacks', t.sacks); addR(a, 'hits', t.qb_hits); addR(a, 'exp_pass', t.explosive_pass);
      addR(a, 'rush_epa', t.rush_epa_sum); addR(a, 'tgt_rb', t.tgt_rb); addR(a, 'tgt_te', t.tgt_te); addR(a, 'recyds_wr', t.recyds_wr); addR(a, 'recyds_te', t.recyds_te);
      addR(a, 'recyds_rb', t.recyds_rb); addR(a, 'pts', t.points); addR(a, 'plays', t.plays); a.tg++;
    });
    it.playerRows.forEach((r) => {
      if (!r.player_id) return;
      const t = teamBy.get(r.team_id) || {};
      const s = {};
      STATS.forEach((k) => { s[k] = statOf(r, k); });
      const sh = {
        target_share: isNum(r.target_share) ? r.target_share : (isNum(r.targets) && t.pass_attempts > 0 ? r.targets / t.pass_attempts : null),
        air_yard_share: isNum(r.air_yard_share) ? r.air_yard_share : (isNum(r.air_yards) && t.air_yards > 0 ? r.air_yards / t.air_yards : null),
        rush_share: isNum(r.carries) && t.rushes > 0 ? r.carries / t.rushes : null,
        reception_share: isNum(r.receptions) && t.completions > 0 ? r.receptions / t.completions : null,
        rec_yards_share: isNum(r.receiving_yards) && t.pass_yards > 0 ? r.receiving_yards / t.pass_yards : null,
        rz_share: isNum(r.red_zone_touches) && t.rz_plays > 0 ? r.red_zone_touches / t.rz_plays : null,
        gl_share: isNum(r.goal_line_touches) && t.gl_plays > 0 ? r.goal_line_touches / t.gl_plays : null,
        designed_rate: isNum(r.designed_rushes) && r.dropbacks > 0 ? r.designed_rushes / r.dropbacks : null,
        scramble_rate: isNum(r.scrambles) && r.dropbacks > 0 ? r.scrambles / r.dropbacks : null
      };
      push(P, r.player_id, { kickoff: kick, at, season: g.season, team_id: r.team_id, pg: r.position_group, s, sh, game_id: g.game_id });
      const pa = acc(g.season);
      const pb = pa.pos[r.position_group] || (pa.pos[r.position_group] = { n: 0, sum: {}, cnt: {} });
      pb.n++;
      STATS.forEach((k) => { if (isNum(s[k])) { pb.sum[k] = (pb.sum[k] || 0) + s[k]; pb.cnt[k] = (pb.cnt[k] || 0) + 1; } });
      const a = pa.rates;
      if (isNum(r.targets)) { addR(a, 'tgt', r.targets); addR(a, 'rec', r.receptions); addR(a, 'rec_yds', r.receiving_yards); addR(a, 'exp_rec', r.explosive_rec); }
      if (isNum(r.explosive_rush)) addR(a, 'exp_rush', r.explosive_rush);
    });
    /* the starting quarterback of record (NFL: the schedule's starter; CFB: the
       team's leading passer — used only for the NEXT game's qb_change) */
    [['home', g.home_team_id], ['away', g.away_team_id]].forEach(([side, team]) => {
      let qb = g[side + '_qb_player_id'] || null;
      if (!qb) {
        const qbs = it.playerRows.filter((r) => r.team_id === team && r.player_id && isNum(r.attempts)).sort((a, b) => b.attempts - a.attempts);
        qb = qbs.length && qbs[0].attempts >= 5 ? qbs[0].player_id : null;
      }
      if (qb) push(qbStarts, team, { kickoff: kick, qb });
    });
  }
  function addR(a, k, v) { if (isNum(v)) a[k] += v; }
  function push(map, k, e) { let arr = map.get(k); if (!arr) { arr = []; map.set(k, arr); } arr.push(e); }

  /* ---------------------------------------------------- one feature row
     ctx = {game, player_id, team_id, opponent_id, position_group, asof,
            absences:[{player_id, team_id}], starting_qb, market, weather} */
  function row(ctx) {
    const asof = ctx.asof;
    if (asof < clock - 1) throw new Error('feature engine: as-of ' + new Date(asof).toISOString() + ' is behind the replay clock');
    advance(asof);
    const f = new Float64Array(NAMES.length).fill(NaN);
    const set = (n, v) => { const i = IDX.get(n); if (i !== undefined && isNum(v)) f[i] = v; };
    let srcMax = null;
    const seen = (e) => { if (e && isNum(e.at) && (srcMax === null || e.at > srcMax)) srcMax = e.at; };
    const g = ctx.game, season = g.season, kick = Date.parse(g.kickoff_utc);
    const pr = priorsFor(season);
    const hist = P.get(ctx.player_id) || [];
    /* the player's games strictly before this as-of (the engine's state holds nothing later) */
    const l8 = lastN(hist, 8), l5 = lastN(hist, 5), l3 = lastN(hist, 3);
    const seasonGames = hist.filter((e) => e.season === season);
    const prevGames = hist.filter((e) => e.season === season - 1);
    l8.forEach(seen); seasonGames.forEach(seen);
    set('games_l8', l8.length); set('games_season', seasonGames.length); set('games_career', hist.length); set('games_prev_season', prevGames.length);
    STATS.forEach((k) => {
      set(k + '_avg_l3', avgStat(l3, k)); set(k + '_avg_l5', avgStat(l5, k)); set(k + '_avg_l8', avgStat(l8, k));
      set(k + '_season_avg', avgStat(seasonGames, k)); set(k + '_prev_season_avg', avgStat(prevGames, k));
      /* the empirical-Bayes composite: decayed recent games + a prior worth 2.5 games */
      let num = 0, den = 0;
      for (let i = l8.length - 1, w = 1; i >= 0; i--, w *= 0.85) { const v = l8[i].s[k]; if (isNum(v)) { num += w * v; den += w; } }
      const prevAvg = prevGames.length >= 4 ? avgStat(prevGames, k) : null;
      const base = prevAvg != null ? prevAvg : posBaseline(season, ctx.position_group, k);
      if (den > 0 || isNum(base)) set(k + '_eb', (num + 2.5 * (isNum(base) ? base : num / Math.max(den, 1e-9))) / (den + 2.5));
    });
    /* registry aliases of the rolling stats */
    Object.keys(REG_STAT).forEach((alias) => {
      const k = REG_STAT[alias];
      WINDOWS.forEach((w) => set(alias + '_avg_' + w[0], f[IDX.get(k + '_avg_' + w[0])]));
      set(alias + '_season_avg', f[IDX.get(k + '_season_avg')]);
    });
    /* usage */
    const shareAvg = (arr, k) => mean(arr.map((e) => e.sh[k]));
    set('snap_share_l3', avgStat(l3, 'snap_share')); set('snap_share_l5', avgStat(l5, 'snap_share'));
    set('target_share_l3', shareAvg(l3, 'target_share')); set('target_share_l5', shareAvg(l5, 'target_share')); set('target_share_season', shareAvg(seasonGames, 'target_share'));
    set('air_yard_share_l3', shareAvg(l3, 'air_yard_share')); set('air_yard_share_l5', shareAvg(l5, 'air_yard_share'));
    set('rush_share_l3', shareAvg(l3, 'rush_share')); set('rush_share_l5', shareAvg(l5, 'rush_share')); set('rush_share_season', shareAvg(seasonGames, 'rush_share'));
    set('reception_share_l5', shareAvg(l5, 'reception_share')); set('rec_yards_share_l5', shareAvg(l5, 'rec_yards_share'));
    set('rz_opportunity_share_l5', shareAvg(l5, 'rz_share')); set('goal_line_opportunity_share_l5', shareAvg(l5, 'gl_share'));
    set('designed_qb_rush_rate_l5', shareAvg(l5, 'designed_rate')); set('scramble_rate_l5', shareAvg(l5, 'scramble_rate'));
    /* efficiency, shrunk to the league */
    const S = (k) => sumOf(l8, k);
    set('epa_per_dropback_l8', ratio(S('passing_epa'), S('dropbacks'), 80, pr.epa_db));
    const cp = l8.filter((e) => isNum(e.s.passing_cpoe) && isNum(e.s.attempts)); const cw = cp.reduce((a, e) => a + e.s.attempts, 0);
    if (cw > 0) set('cpoe_l8', cp.reduce((a, e) => a + e.s.passing_cpoe * e.s.attempts, 0) / (cw + 100));
    set('yards_per_attempt_l8', ratio(S('passing_yards'), S('attempts'), 60, pr.ypa));
    set('yards_per_carry_l8', ratio(S('rushing_yards'), S('carries'), 40, pr.ypc));
    set('yards_per_target_l8', ratio(S('receiving_yards'), S('targets'), 25, pr.ypt));
    set('catch_rate_l8', ratio(S('receptions'), S('targets'), 25, pr.catch));
    set('explosive_rec_rate_l8', ratio(S('explosive_rec'), S('targets'), 30, pr.exp_rec));
    set('explosive_rush_rate_l8', ratio(S('explosive_rush'), S('carries'), 30, pr.exp_rush));
    /* team context: the player's CURRENT team's last five games */
    const th = T.get(ctx.team_id) || [], t5 = lastN(th, 5);
    t5.forEach(seen);
    const tAvg = (k) => mean(t5.map((e) => e[k]));
    set('pace_seconds_per_play_l5', tAvg('spp')); set('neutral_pass_rate_l5', tAvg('npr')); set('proe_l5', tAvg('proe'));
    set('team_plays_l5', tAvg('plays')); set('team_points_l5', tAvg('points')); set('team_pass_attempts_l5', tAvg('pass_attempts')); set('team_rushes_l5', tAvg('rushes'));
    set('team_dropbacks_l5', tAvg('dropbacks'));
    const tp = sumOf(t5, 'plays'), td = sumOf(t5, 'dropbacks');
    set('team_pass_rate_l5', isNum(tp) && tp > 0 && isNum(td) ? td / tp : null);
    /* opponent: what the defence allowed in its last eight, shrunk */
    const dh = D.get(ctx.opponent_id) || [], d8 = lastN(dh, 8);
    d8.forEach(seen);
    const dS = (k) => sumOf(d8, k), dn = d8.length;
    set('opp_pass_yards_allowed_per_att_l8', ratio(dS('pass_yards'), dS('pass_attempts'), 150, pr.ypa));
    set('opp_completion_rate_allowed_l8', ratio(dS('completions'), dS('pass_attempts'), 150, pr.cmp));
    set('opp_pressure_rate_l8', ratio(sumN(dS('sacks'), dS('qb_hits')), dS('dropbacks'), 120, pr.pressure));
    set('opp_sack_rate_l8', ratio(dS('sacks'), dS('dropbacks'), 150, pr.sack));
    set('opp_explosive_pass_rate_allowed_l8', ratio(dS('explosive_pass'), dS('pass_attempts'), 150, pr.exp_pass));
    set('opp_epa_per_dropback_allowed_l8', ratio(dS('pass_epa'), dS('dropbacks'), 150, pr.epa_db));
    set('opp_rush_yards_allowed_per_carry_l8', ratio(dS('rush_yards'), dS('rushes'), 100, pr.ypc));
    set('opp_rush_epa_allowed_l8', ratio(dS('rush_epa'), dS('rushes'), 120, pr.rush_epa));
    set('opp_explosive_rush_rate_allowed_l8', ratio(dS('explosive_rush'), dS('rushes'), 120, pr.exp_rush));
    set('opp_target_rate_allowed_rb_l8', ratio(dS('tgt_rb'), dS('pass_attempts'), 150, pr.tgt_rb_rate));
    set('opp_target_rate_allowed_te_l8', ratio(dS('tgt_te'), dS('pass_attempts'), 150, pr.tgt_te_rate));
    if (dn) {
      set('opp_rec_yards_allowed_wr_l8', ratio(dS('recyds_wr'), dn, 3, pr.recyds_wr_pg)); set('opp_rec_yards_allowed_te_l8', ratio(dS('recyds_te'), dn, 3, pr.recyds_te_pg));
      set('opp_rec_yards_allowed_rb_l8', ratio(dS('recyds_rb'), dn, 3, pr.recyds_rb_pg)); set('opp_points_allowed_l8', ratio(dS('points'), dn, 3, pr.pts_pg));
      set('opp_plays_allowed_l8', ratio(dS('plays'), dn, 3, pr.plays_pg)); set('opp_pass_attempts_allowed_l8', dS('pass_attempts') != null ? dS('pass_attempts') / dn : null);
      set('opp_rushes_allowed_l8', dS('rushes') != null ? dS('rushes') / dn : null);
    }
    /* game */
    const home = ctx.team_id === g.home_team_id;
    set('home_flag', g.neutral_site ? 0.5 : (home ? 1 : 0)); set('neutral_site_flag', g.neutral_site ? 1 : 0);
    const prevTeamGame = th.length ? th[th.length - 1] : null;
    if (prevTeamGame) set('rest_days', Math.min(21, (kick - prevTeamGame.kickoff) / DAY));
    const closed = g.roof === 'closed' || g.roof === 'dome';
    set('roof_closed_flag', g.roof ? (closed ? 1 : 0) : null);
    const wx = ctx.weather || { temp_f: g.weather_temp_f, wind_mph: g.weather_wind_mph, precip_prob: null };
    if (closed) { set('weather_wind_mph', 0); set('weather_temp_f', 70); }        /* indoors: no outdoor weather */
    else { set('weather_wind_mph', wx.wind_mph); set('weather_temp_f', wx.temp_f); set('weather_precip_prob', wx.precip_prob); }
    set('week_of_season', g.week);
    /* market context, from the player's team's side */
    const m = ctx.market || g.market;
    if (m && (isNum(m.home_line) || isNum(m.total))) {
      const spread = isNum(m.home_line) ? (home ? m.home_line : -m.home_line) : null;
      set('team_spread', spread); set('game_total', m.total);
      if (isNum(m.total) && isNum(spread)) set('team_implied_points', m.total / 2 - spread / 2);
      set('market_context_is_model', m.basis === 'model' ? 1 : 0);
    }
    /* availability: quarterback continuity and vacated opportunity */
    const qs = qbStarts.get(ctx.team_id) || [];
    const lastQb = qs.length ? qs[qs.length - 1].qb : null;
    if (ctx.starting_qb && lastQb) set('qb_change', ctx.starting_qb === lastQb ? 0 : 1);
    if (ctx.starting_qb) set('qb_starts_with_team', qs.filter((x) => x.qb === ctx.starting_qb).length);
    if (ctx.position_group === 'QB') set('is_starter_qb', ctx.starting_qb ? (ctx.starting_qb === ctx.player_id ? 1 : 0) : null);
    if (Array.isArray(ctx.absences)) {
      let vt = 0, vr = 0, va = 0, vz = 0, any = false;
      ctx.absences.forEach((a) => {
        if (!a.player_id || a.player_id === ctx.player_id || a.team_id !== ctx.team_id) return;
        const ah = lastN(P.get(a.player_id) || [], 5).filter((e) => e.team_id === ctx.team_id);
        if (ah.length < 2) return;                          /* only regular contributors vacate anything */
        any = true;
        vt += mean(ah.map((e) => e.sh.target_share)) || 0; vr += mean(ah.map((e) => e.sh.rush_share)) || 0;
        va += mean(ah.map((e) => e.sh.air_yard_share)) || 0; vz += mean(ah.map((e) => e.sh.rz_share)) || 0;
        ah.forEach(seen);
      });
      set('teammate_target_vacated_share', vt); set('teammate_rush_vacated_share', vr); set('teammate_air_yards_vacated_share', va); set('teammate_rz_vacated_share', vz);
      void any;
    }
    /* identity / transition (NFL) */
    if (league === 'NFL' && ctx.player) {
      const p = ctx.player;
      const exp = isNum(p.nfl_first_season) ? season - p.nfl_first_season : null;
      set('years_experience', exp); set('rookie_flag', exp === 0 ? 1 : (exp == null ? null : 0));
      const pick = isNum(p.draft_pick) ? p.draft_pick : (p.draft_year == null && isNum(p.nfl_first_season) ? 300 : null);
      set('draft_capital_log', isNum(pick) ? Math.log(pick) : null);
      const ch = cfbHistory && cfbHistory.get(ctx.player_id);
      if (ch && (exp == null || exp <= 3)) {
        /* college production strictly BEFORE the NFL debut (non-negotiable rule 3) */
        set('cfb_career_reception_share', ch.reception_share); set('cfb_career_rec_ypg', ch.rec_ypg); set('cfb_final_rec_yards_share', ch.final_rec_yards_share);
        set('cfb_career_rush_share', ch.rush_share); set('cfb_career_rush_ypg', ch.rush_ypg); set('cfb_final_pass_ypg', ch.final_pass_ypg);
        set('cfb_best_season_yprr_proxy', ch.best_rec_yds_per_team_att); set('cfb_breakout_season_index', ch.breakout_index);
        set('cfb_power_conference_flag', ch.power ? 1 : 0); set('cfb_seasons', ch.seasons);
      }
    }
    if (ctx.position_group) set('player_position', { QB: 1, RB: 2, WR: 3, TE: 4 }[ctx.position_group] || null);
    /* market + weather context is known at the as-of instant; nothing later */
    const src = srcMax == null ? null : srcMax;
    return { f, source_max_ms: src, asof_ms: asof };
  }
  function assertPit(r) { return !(r.source_max_ms != null && r.source_max_ms > r.asof_ms); }
  function history(pid) { return P.get(pid) || []; }
  function teamHistory(tid) { return T.get(tid) || []; }
  return { addGame, advance, row, assertPit, history, teamHistory, priorsFor, get clock() { return clock; } };
}

/* ------------------------------------------------------------ CFB careers
   For an NFL player bridged to a college record: production strictly before
   the NFL debut, from the CFB player-game facts. */
function cfbCareers(cfbLeague, bridgePlayers) {
  if (!cfbLeague) return new Map();
  const teamSeason = new Map();
  cfbLeague.teamGames.forEach((t) => {
    const k = t.team_id + '|' + t.season;
    const x = teamSeason.get(k) || { completions: 0, pass_yards: 0, rushes: 0, pass_attempts: 0 };
    x.completions += t.completions || 0; x.pass_yards += t.pass_yards || 0; x.rushes += t.rushes || 0; x.pass_attempts += t.pass_attempts || 0;
    teamSeason.set(k, x);
  });
  const byPlayer = new Map();
  cfbLeague.playerGames.forEach((r) => { if (!r.player_id) return; let a = byPlayer.get(r.player_id); if (!a) { a = []; byPlayer.set(r.player_id, a); } a.push(r); });
  const out = new Map();
  (bridgePlayers || []).forEach((p) => {
    const rows = byPlayer.get(p.player_id);
    if (!rows || !p.nfl_first_season) return;
    const pre = rows.filter((r) => r.season < p.nfl_first_season);
    if (!pre.length) return;
    const seasons = Array.from(new Set(pre.map((r) => r.season))).sort();
    let rec = 0, recY = 0, car = 0, rushY = 0, teamCmp = 0, teamRush = 0, bestYpa = null, breakout = null;
    const bySeason = new Map();
    pre.forEach((r) => { const k = r.season; const x = bySeason.get(k) || { rec: 0, recY: 0, car: 0, rushY: 0, passY: 0, g: 0, team: r.team_id }; x.rec += r.receptions || 0; x.recY += r.receiving_yards || 0; x.car += r.carries || 0; x.rushY += r.rushing_yards || 0; x.passY += r.passing_yards || 0; x.g++; x.team = r.team_id; bySeason.set(k, x); });
    seasons.forEach((s, i) => {
      const x = bySeason.get(s), ts = teamSeason.get(x.team + '|' + s) || {};
      rec += x.rec; recY += x.recY; car += x.car; rushY += x.rushY; teamCmp += ts.completions || 0; teamRush += ts.rushes || 0;
      const ypa = ts.pass_attempts > 0 ? x.recY / ts.pass_attempts : null;
      if (ypa != null && (bestYpa == null || ypa > bestYpa)) bestYpa = ypa;
      if (breakout == null && ts.pass_yards > 0 && x.recY / ts.pass_yards >= 0.2) breakout = i + 1;
    });
    const last = bySeason.get(seasons[seasons.length - 1]), lts = teamSeason.get(last.team + '|' + seasons[seasons.length - 1]) || {};
    const games = pre.length;
    out.set(p.player_id, { seasons: seasons.length, reception_share: teamCmp > 0 ? rec / teamCmp : null, rec_ypg: recY / games, rush_share: teamRush > 0 ? car / teamRush : null,
      rush_ypg: rushY / games, final_rec_yards_share: lts.pass_yards > 0 ? last.recY / lts.pass_yards : null, final_pass_ypg: last.g ? last.passY / last.g : null,
      best_rec_yds_per_team_att: bestYpa, breakout_index: breakout, power: false, last_team: last.team, last_season: seasons[seasons.length - 1] });
  });
  return out;
}

/* ------------------------------------------------------------ training rows
   Replays one league's warehouse and returns a feature row for every
   modelable player-game (skill positions), each with its targets. */
function buildHistorical(wh, league, opts) {
  opts = opts || {};
  const L = wh.leagues[league];
  const players = new Map(wh.identity.players.map((p) => [p.player_id, p]));
  const cfbHistory = league === 'NFL' ? cfbCareers(wh.leagues.CFB, wh.identity.players.filter((p) => p.identity_status === 'bridged')) : null;
  const eng = createEngine(league, { cfbHistory });
  const games = L.games.filter((g) => g.status === 'final').slice().sort((a, b) => Date.parse(a.kickoff_utc) - Date.parse(b.kickoff_utc) || (a.game_id < b.game_id ? -1 : 1));
  const byGame = new Map(), teamByGame = new Map(), absByGame = new Map();
  L.playerGames.forEach((r) => { let a = byGame.get(r.game_id); if (!a) { a = []; byGame.set(r.game_id, a); } a.push(r); });
  L.teamGames.forEach((t) => { let a = teamByGame.get(t.game_id); if (!a) { a = []; teamByGame.set(t.game_id, a); } a.push(t); });
  (L.absences || []).forEach((x) => { let a = absByGame.get(x.game_id); if (!a) { a = []; absByGame.set(x.game_id, a); } a.push(x); });
  const nflQb = league === 'NFL' ? new Map(wh.identity.idMap.filter((m) => m.source === 'nfl_gsis').map((m) => [m.source_id, m.player_id])) : null;
  const fbsOnly = league === 'CFB';
  const rows = [], quarantined = [];
  const minSeason = opts.minSeason || 0;
  for (const g of games) {
    if (nflQb) { g.home_qb_player_id = g.home_qb_id ? nflQb.get(g.home_qb_id) || null : null; g.away_qb_player_id = g.away_qb_id ? nflQb.get(g.away_qb_id) || null : null; }
    const pr = byGame.get(g.game_id) || [];
    const asof = Date.parse(g.kickoff_utc);
    /* the replay clock moves with the schedule, whether or not this game yields a row */
    eng.advance(asof);
    if (g.season >= minSeason) {
      for (const r of pr) {
        if (!r.player_id || !(r.position_group === 'QB' || r.position_group === 'RB' || r.position_group === 'WR' || r.position_group === 'TE')) continue;
        if (fbsOnly && (g.home_team_id === r.team_id ? g.home_division : g.away_division) !== 'fbs') continue;
        const startQb = league === 'NFL' ? (r.team_id === g.home_team_id ? g.home_qb_player_id : g.away_qb_player_id) : null;
        const hist = eng.history(r.player_id);
        if (r.position_group === 'QB') {
          if (league === 'NFL' && startQb !== r.player_id) continue;              /* starting quarterbacks only */
          if (league === 'CFB') {
            /* the incumbent: led the team in attempts in its previous game */
            const last = hist.length ? hist[hist.length - 1] : null;
            if (!last || last.team_id !== r.team_id || !(last.s.attempts >= 10)) continue;
          }
        }
        if (!hist.length && !(league === 'NFL' && cfbHistory.has(r.player_id))) continue;   /* nothing known before the game */
        const out = eng.row({ game: g, player_id: r.player_id, team_id: r.team_id, opponent_id: r.opponent_id, position_group: r.position_group, asof,
          absences: league === 'NFL' ? (absByGame.get(g.game_id) || []) : null, starting_qb: startQb, player: players.get(r.player_id) });
        const rec = { game_id: g.game_id, player_id: r.player_id, league, season: g.season, week: g.week, kickoff_utc: g.kickoff_utc, asof_at: new Date(asof).toISOString(),
          position_group: r.position_group, team_id: r.team_id, opponent_id: r.opponent_id, player_name: r.player_name, f: out.f,
          source_max_ms: out.source_max_ms, targets: targetsOf(r), identity_confidence: (players.get(r.player_id) || {}).identity_confidence, source_quality: r.source_quality };
        if (!eng.assertPit(out)) { quarantined.push({ rule_id: 'Q008', key: g.game_id + '|' + r.player_id, reason: 'source_max_timestamp after asof_at' }); continue; }
        rows.push(rec);
      }
    }
    eng.addGame(g, pr, teamByGame.get(g.game_id) || []);
  }
  return { rows, quarantined, names: NAMES, engine: eng };
}
function targetsOf(r) { const t = {}; Object.keys(TARGET_OF).forEach((m) => { const v = TARGET_OF[m](r); t[m] = isNum(v) ? v : null; }); return t; }

module.exports = { FEATURE_VERSION, FINAL_LAG_MS, NAMES, IDX, STATS, TARGET_OF, UNAVAILABLE, createEngine, buildHistorical, cfbCareers, targetsOf, statOf };
