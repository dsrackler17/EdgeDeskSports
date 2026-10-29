/* ============================================================================
   FSIE — point-in-time situational tendencies.

   For every team-game, the features are what was knowable BEFORE its kickoff:
   games are processed in kickoff order and a slot's features are read before
   any game in that slot is absorbed. Nothing from the game itself, or from any
   later game, can reach its own features (tests/features.test.js proves it).

   Method (frozen in config/features_v1.json):
     - every team-game becomes an additive stat vector (counts, situational
       cells, pace pairs, observed formation counts);
     - a team's state is an exponentially decayed sum of its vectors
       (half-life in games), seeded with last season's per-game average scaled
       to `prior_games` pseudo-games — halved when the head coach changed,
       because last season's identity does not carry over unchanged;
     - rates are shrunk toward the league with a beta-binomial pseudo-count k,
       per-game volumes and pace with a normal-normal k; both k's are measured
       by the method of moments on the TRAINING seasons only;
     - the defensive side of a team is the same machinery over the vectors of
       the offences it faced ("faced", inferred from results) — distinct from
       the OBSERVED defensive looks (box count, blitz, coverage), which come
       only from charting and stay null where no charting exists;
     - opponent adjustment: a team's rate minus the average faced-deviation of
       the defences it has played (and vice versa), each read as of the same
       moment.
   Every metric ships with its sample (weighted and raw plays/games), its
   window, recency and a standard error.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const A = require(path.join(__dirname, 'aggregate.js'));
const CFG = require(path.join(__dirname, '..', 'config', 'features_v1.json'));

/* --------------------------------------------------------------- vectors */
function vec(r) {
  if (!r || !r.quality || !r.quality.volume_ok) return null;
  const c = r.counts; const v = {
    games: 1, plays: c.plays, pass_att: c.pass_att, rush_att: c.rush_att, sacks: c.sacks, scrambles: c.scrambles, kneels: c.kneels,
    dropbacks: c.dropbacks, designed_rush: c.designed_rush, drives: c.drives, points: c.points == null ? 0 : c.points
  };
  if (r.quality.situation_ok) {
    v.sit_games = 1;
    for (const k of A.SIT_KEYS) { v['s_' + k + '_n'] = r.sit[k].n; v['s_' + k + '_db'] = r.sit[k].db; }
    for (const k of A.SCRIPTS) { v['x_' + k + '_n'] = r.script[k].n; v['x_' + k + '_db'] = r.script[k].db; }
    v.pace_n_sec = r.pace.neutral_sec; v.pace_n_pairs = r.pace.neutral_pairs; v.pace_a_sec = r.pace.all_sec; v.pace_a_pairs = r.pace.all_pairs;
  }
  const f = r.form;
  if (f.charted) { v.f_charted = f.charted; v.f_shotgun = f.shotgun; v.f_nohuddle = f.no_huddle; }
  if (f.ftn && f.ftn.n) {
    v.ftn_n = f.ftn.n; v.ftn_motion = f.ftn.motion; v.ftn_pa = f.ftn.play_action; v.ftn_rpo = f.ftn.rpo; v.ftn_screen = f.ftn.screen;
    v.ftn_box_sum = f.ftn.box_sum; v.ftn_box_n = f.ftn.box_n; v.ftn_box8 = f.ftn.box8_rush; v.ftn_rush_n = f.ftn.rush_n;
    v.ftn_blitz_sum = f.ftn.blitz_sum; v.ftn_blitz_n = f.ftn.blitz_n;
  }
  if (f.part && f.part.n) {
    v.pt_n = f.part.n;
    Object.keys(f.part.personnel).forEach((p) => { v['pt_pers_' + p] = f.part.personnel[p]; });
    v.pt_box_sum = f.part.box_sum; v.pt_box_n = f.part.box_n;
    Object.keys(f.part.man_zone).forEach((m) => { v['pt_cov_' + m.toLowerCase()] = f.part.man_zone[m]; v.pt_cov_n = (v.pt_cov_n || 0) + f.part.man_zone[m]; });
  }
  return v;
}
function addInto(acc, v, w) { for (const k in v) acc[k] = (acc[k] || 0) + w * v[k]; }
function scale(acc, w) { const o = {}; for (const k in acc) o[k] = acc[k] * w; return o; }
function decayInPlace(acc, lam) { for (const k in acc) acc[k] *= lam; }

/* ------------------------------------------------------------- metrics */
const RATE = {
  /* name: [numerator, denominator] over the decayed vector */
  pr_all: ['_db_all', '_n_all'],
  pr_neutral: ['s_neutral_db', 's_neutral_n'], pr_early: ['s_early_down_db', 's_early_down_n'],
  pr_passing_down: ['s_passing_down_db', 's_passing_down_n'], pr_third: ['s_third_down_db', 's_third_down_n'],
  pr_short_yardage: ['s_short_yardage_db', 's_short_yardage_n'], pr_red_zone: ['s_red_zone_db', 's_red_zone_n'],
  pr_goal_line: ['s_goal_line_db', 's_goal_line_n'], pr_trailing: ['s_trailing_db', 's_trailing_n'],
  pr_leading: ['s_leading_db', 's_leading_n'], pr_first_half: ['s_first_half_db', 's_first_half_n'],
  pr_second_half: ['s_second_half_db', 's_second_half_n'], pr_two_minute: ['s_two_minute_db', 's_two_minute_n'],
  pr_x_competitive: ['x_competitive_db', 'x_competitive_n'], pr_x_leading: ['x_leading_db', 'x_leading_n'],
  pr_x_trailing: ['x_trailing_db', 'x_trailing_n'], pr_x_garbage: ['x_garbage_db', 'x_garbage_n'], pr_x_two_minute: ['x_two_minute_db', 'x_two_minute_n'],
  sack_rate: ['sacks', 'dropbacks'], scramble_rate: ['scrambles', 'dropbacks'],
  shotgun_rate: ['f_shotgun', 'f_charted'], no_huddle_rate: ['f_nohuddle', 'f_charted'],
  motion_rate: ['ftn_motion', 'ftn_n'], play_action_rate: ['ftn_pa', 'ftn_n'], rpo_rate: ['ftn_rpo', 'ftn_n'], screen_rate: ['ftn_screen', 'ftn_n'],
  box8_rush_rate: ['ftn_box8', 'ftn_rush_n'], pers_11: ['pt_pers_11', 'pt_n'], pers_12: ['pt_pers_12', 'pt_n'], pers_21: ['pt_pers_21', 'pt_n'],
  cov_man: ['pt_cov_man', 'pt_cov_n']
};
const PER_GAME = { plays_pg: 'plays', drives_pg: 'drives', pass_att_pg: 'pass_att', rush_att_pg: 'rush_att', dropbacks_pg: 'dropbacks', kneels_pg: 'kneels', points_pg: 'points' };
const PER_UNIT = {
  /* name: [numerator, denominator, k-unit] */
  ppd: ['plays', 'drives'], spp_neutral: ['pace_n_sec', 'pace_n_pairs'], spp_all: ['pace_a_sec', 'pace_a_pairs'],
  box_avg: ['ftn_box_sum', 'ftn_box_n'], blitz_avg: ['ftn_blitz_sum', 'ftn_blitz_n'], pt_box_avg: ['pt_box_sum', 'pt_box_n']
};
/* scripts shares of situationally valid plays */
const SHARES = ['competitive', 'leading', 'trailing', 'garbage', 'two_minute'];
const OBSERVED = { shotgun_rate: 1, no_huddle_rate: 1, motion_rate: 1, play_action_rate: 1, rpo_rate: 1, screen_rate: 1, box8_rush_rate: 1, pers_11: 1, pers_12: 1, pers_21: 1, cov_man: 1, box_avg: 1, blitz_avg: 1, pt_box_avg: 1 };

function withAll(v) {
  const o = Object.assign({}, v); let n = 0, db = 0;
  for (const s of SHARES) { n += v['x_' + s + '_n'] || 0; db += v['x_' + s + '_db'] || 0; }
  o._n_all = n; o._db_all = db; return o;
}

/* league reference from a set of (unweighted) vectors */
function leagueOf(acc) {
  const a = withAll(acc); const lg = {};
  for (const m in RATE) { const [x, n] = RATE[m]; lg[m] = a[n] > 0 ? a[x] / a[n] : null; }
  for (const m in PER_GAME) { const g = PER_GAME[m] === 'points' ? a.games : a.games; lg[m] = g > 0 ? a[PER_GAME[m]] / g : null; }
  for (const m in PER_UNIT) { const [x, n] = PER_UNIT[m]; lg[m] = a[n] > 0 ? a[x] / a[n] : null; }
  return lg;
}

/* Method-of-moments shrinkage constants from full-season team totals.
   rates: beta-binomial pseudo-count k = p(1-p)/tau^2.
   per-game: k (games) = sigma_within^2 / tau^2.  per-unit: k in units. */
function estimateK(seasonTeamRows) {
  const K = {};
  const teams = Object.values(seasonTeamRows);           /* [{acc, games:[vec...]}] */
  for (const m in RATE) {
    const [x, n] = RATE[m];
    const ps = [], ns = []; let X = 0, N = 0;
    teams.forEach((t) => { const a = withAll(t.acc); if (a[n] >= 20) { ps.push(a[x] / a[n]); ns.push(a[n]); X += a[x]; N += a[n]; } });
    if (ps.length < 8 || !N) { K[m] = null; continue; }
    const p = X / N; const obs = U.variance(ps); const samp = U.mean(ns.map((nn) => p * (1 - p) / nn));
    const tau2 = Math.max(obs - samp, 1e-5);
    K[m] = U.round(U.clamp(p * (1 - p) / tau2, 5, 5000), 1);
  }
  const perGame = Object.assign({}, PER_GAME);
  for (const m in perGame) {
    const key = perGame[m]; const means = [], gs = []; let wss = 0, wdf = 0;
    teams.forEach((t) => { const xs = t.games.map((g) => g[key] || 0); if (xs.length >= 3) { const mu = U.mean(xs); means.push(mu); gs.push(xs.length); wss += xs.reduce((s, x) => s + (x - mu) * (x - mu), 0); wdf += xs.length - 1; } });
    if (means.length < 8 || !wdf) { K[m] = null; continue; }
    const sw2 = wss / wdf; const tau2 = Math.max(U.variance(means) - U.mean(gs.map((g) => sw2 / g)), 1e-6);
    K[m] = U.round(U.clamp(sw2 / tau2, 0.5, 200), 2);
  }
  for (const m in PER_UNIT) {
    const [x, n] = PER_UNIT[m]; const rs = [], ns = []; let X = 0, N = 0, wss = 0, wdf = 0;
    teams.forEach((t) => {
      if (!(t.acc[n] > 0)) return;
      const r = t.acc[x] / t.acc[n]; rs.push(r); ns.push(t.acc[n]); X += t.acc[x]; N += t.acc[n];
      /* within: per-game ratios weighted by units */
      t.games.forEach((g) => { if (g[n] > 0) { const d = g[x] / g[n] - r; wss += g[n] * d * d; wdf += 1; } });
    });
    if (rs.length < 8 || !wdf) { K[m] = null; continue; }
    const sw2 = wss / wdf;   /* per-unit variance (unit-weighted) */
    const tau2 = Math.max(U.variance(rs) - U.mean(ns.map((nn) => sw2 / nn)), 1e-6);
    K[m] = U.round(U.clamp(sw2 / tau2, 1, 5000), 1);
  }
  return K;
}

function metricsFrom(acc, lg, K, rawGames) {
  const a = withAll(acc); const out = {};
  for (const m in RATE) {
    const [x, n] = RATE[m];
    const N = a[n] || 0;
    if (OBSERVED[m] && !(N > 0)) { out[m] = null; continue; }
    if (lg[m] == null) { out[m] = null; continue; }
    const k = K[m] == null ? 50 : K[m];
    const v = ((a[x] || 0) + k * lg[m]) / (N + k);
    out[m] = { v: U.round(v, 4), raw: N > 0 ? U.round(a[x] / N, 4) : null, n: U.round(N, 1), se: U.round(Math.sqrt(v * (1 - v) / (N + k)), 4), prior: U.round(lg[m], 4), k };
  }
  for (const m in PER_GAME) {
    const key = PER_GAME[m]; const G = a.games || 0;
    if (lg[m] == null) { out[m] = null; continue; }
    const k = K[m] == null ? 3 : K[m];
    const v = ((a[key] || 0) + k * lg[m]) / (G + k);
    out[m] = { v: U.round(v, 3), raw: G > 0 ? U.round(a[key] / G, 3) : null, n: U.round(G, 2), prior: U.round(lg[m], 3), k };
  }
  for (const m in PER_UNIT) {
    const [x, n] = PER_UNIT[m]; const N = a[n] || 0;
    if (OBSERVED[m] && !(N > 0)) { out[m] = null; continue; }
    if (lg[m] == null) { out[m] = null; continue; }
    const k = K[m] == null ? 20 : K[m];
    const v = ((a[x] || 0) + k * lg[m]) / (N + k);
    out[m] = { v: U.round(v, 3), raw: N > 0 ? U.round(a[x] / N, 3) : null, n: U.round(N, 1), prior: U.round(lg[m], 3), k };
  }
  const tot = SHARES.reduce((s, k) => s + (a['x_' + k + '_n'] || 0), 0);
  out.script_share = tot > 0 ? SHARES.reduce((o, k) => { o[k] = U.round((a['x_' + k + '_n'] || 0) / tot, 4); return o; }, {}) : null;
  out.sample = { games_weighted: U.round(a.games || 0, 2), games_raw: rawGames, plays_weighted: U.round(a.plays || 0, 1) };
  return out;
}

/* ------------------------------------------------------- the season walk */
/* seasonData: derived season (core/ingest), prev: derived previous season or null.
   opts.K: shrinkage constants (from training seasons); opts.coaches: {team:{new_hc}}
   -> { byTeamGame: Map(gid|team -> {off, def, opp_adj, meta}), final: {team: {...}}, league } */
function walkSeason(sport, seasonData, prev, opts) {
  opts = opts || {};
  const sc = CFG.sports[sport];
  const lam = Math.pow(0.5, 1 / sc.half_life_games);
  const K = opts.K || {};
  const rows = seasonData.team_games.filter((r) => r.season_type === 'REG' || sc.include_postseason);
  /* prior season seeds */
  const prevTot = {}; const prevDef = {}; const lgAcc = {};
  let lgTeams = 0;
  if (prev) {
    const opp = {};
    prev.team_games.forEach((r) => { opp[r.game_id + '|' + r.team] = r; });
    prev.team_games.forEach((r) => {
      const v = vec(r); if (!v) return;
      const t = prevTot[r.team] || (prevTot[r.team] = {}); addInto(t, v, 1);
      const d = prevDef[r.opp] || (prevDef[r.opp] = {}); addInto(d, v, 1);
      addInto(lgAcc, v, 1);
    });
    lgTeams = Object.keys(prevTot).length;
  }
  const off = {}, def = {}, offRaw = {}, defRaw = {}, last = {}, first = {}, oppsOf = {}, defOppsOf = {};
  const seed = (store, tot, team) => {
    if (store[team]) return store[team];
    const t = tot[team]; const coach = opts.coaches && opts.coaches[team];
    const w = sc.prior_games * (coach && coach.new_hc ? sc.new_coach_prior_factor : 1);
    store[team] = t && t.games ? scale(t, w / t.games) : {};
    return store[team];
  };
  /* league reference: previous season scaled to prior_games per team + current season so far */
  const lgCur = {};
  const byTeamGame = new Map();
  const slots = new Map();
  rows.forEach((r) => { const k = r.kickoff_at || ('w' + String(r.week).padStart(2, '0')); if (!slots.has(k)) slots.set(k, []); slots.get(k).push(r); });
  const slotKeys = Array.from(slots.keys()).sort();
  const lgPrevScaled = lgTeams ? scale(lgAcc, 1) : {};
  function league() {
    const a = {}; addInto(a, lgPrevScaled, lgTeams ? sc.league_prior_weight : 0); addInto(a, lgCur, 1);
    return leagueOf(a);
  }
  function snapshot(team, lg) {
    const o = seed(off, prevTot, team), d = seed(def, prevDef, team);
    return {
      off: metricsFrom(o, lg, K, offRaw[team] || 0), def: metricsFrom(d, lg, K, defRaw[team] || 0),
      meta: { games_off: offRaw[team] || 0, games_def: defRaw[team] || 0, first_game_at: first[team] || null, last_game_at: last[team] || null,
        prior_games: (opts.coaches && opts.coaches[team] && opts.coaches[team].new_hc ? sc.new_coach_prior_factor : 1) * (prevTot[team] ? sc.prior_games : 0),
        new_hc: opts.coaches && opts.coaches[team] ? opts.coaches[team].new_hc : null, had_prior_season: !!prevTot[team] }
    };
  }
  const ADJ = ['pr_all', 'pr_neutral', 'pr_early', 'pr_passing_down', 'plays_pg', 'ppd', 'spp_neutral'];
  function oppAdjust(team, snaps, lg) {
    /* offence adjusted for the defences faced, defence for the offences faced */
    const out = { off: {}, def: {} };
    const list = oppsOf[team] || []; const dlist = defOppsOf[team] || [];
    for (const m of ADJ) {
      let s = 0, w = 0;
      list.forEach((o) => { const sn = snaps(o.opp); const x = sn.def[m]; if (x && lg[m] != null) { s += o.w * (x.v - lg[m]); w += o.w; } });
      out.off[m] = w > 0 ? U.round(s / w, 4) : 0;
      s = 0; w = 0;
      dlist.forEach((o) => { const sn = snaps(o.opp); const x = sn.off[m]; if (x && lg[m] != null) { s += o.w * (x.v - lg[m]); w += o.w; } });
      out.def[m] = w > 0 ? U.round(s / w, 4) : 0;
    }
    return out;
  }
  for (const sk of slotKeys) {
    const slot = slots.get(sk);
    const lg = league();
    const cache = new Map();
    const snaps = (t) => { if (!cache.has(t)) cache.set(t, snapshot(t, lg)); return cache.get(t); };
    for (const r of slot) {
      const sn = snaps(r.team);
      byTeamGame.set(r.game_id + '|' + r.team, Object.assign({ opp_adj: oppAdjust(r.team, snaps, lg), league: lg }, sn));
    }
    /* absorb the slot */
    for (const r of slot) {
      const v = vec(r);
      const o = seed(off, prevTot, r.team); const d = seed(def, prevDef, r.opp);
      if (!v) continue;
      decayInPlace(o, lam); addInto(o, v, 1); offRaw[r.team] = (offRaw[r.team] || 0) + 1;
      decayInPlace(d, lam); addInto(d, v, 1); defRaw[r.opp] = (defRaw[r.opp] || 0) + 1;
      addInto(lgCur, v, 1);
      last[r.team] = r.kickoff_at || last[r.team]; first[r.team] = first[r.team] || r.kickoff_at;
      (oppsOf[r.team] = oppsOf[r.team] || []).forEach((x) => { x.w *= lam; }); oppsOf[r.team].push({ opp: r.opp, w: 1 });
      (defOppsOf[r.opp] = defOppsOf[r.opp] || []).forEach((x) => { x.w *= lam; }); defOppsOf[r.opp].push({ opp: r.team, w: 1 });
    }
  }
  /* the state after every completed game: what a card shows today */
  const lgNow = league();
  const finalCache = new Map();
  const snapsNow = (t) => { if (!finalCache.has(t)) finalCache.set(t, snapshot(t, lgNow)); return finalCache.get(t); };
  const teams = new Set(); rows.forEach((r) => { teams.add(r.team); teams.add(r.opp); });
  Object.keys(prevTot).forEach((t) => teams.add(t));
  const final = {};
  teams.forEach((t) => { final[t] = Object.assign({ opp_adj: oppAdjust(t, snapsNow, lgNow) }, snapsNow(t)); });
  return { byTeamGame, final, league: lgNow, K, config_version: CFG.version };
}

/* per-team full-season totals for estimateK */
function seasonTeamTotals(seasonData) {
  const out = {};
  seasonData.team_games.forEach((r) => { const v = vec(r); if (!v) return; const t = out[r.team] || (out[r.team] = { acc: {}, games: [] }); addInto(t.acc, v, 1); t.games.push(v); });
  return out;
}

module.exports = { vec, walkSeason, estimateK, seasonTeamTotals, metricsFrom, leagueOf, RATE, PER_GAME, PER_UNIT, OBSERVED, CFG };
