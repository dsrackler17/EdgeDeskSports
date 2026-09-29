/* ===========================================================================
   PLAYER PROPS MODEL — from a dataset and a timestamp to the engine's input.
   docs/player-props/MODEL.md

   League-agnostic: the NFL and CFB adapters produce the same dataset shape
   (players, games, playerGames, teamGames, depth, injuries, pools) and this
   file reads only that shape.

   THE AS-OF RULE. Every function takes `asOfMs` and reads ONLY rows whose
   kickoff is strictly earlier, depth-chart snapshots published strictly
   earlier, and the pregame injury report for the game's own week. The
   walk-forward backtest calls these same functions with each historical
   kickoff, which is what makes it a real out-of-sample test (V001/V002).

   LAYERS (Feature_Library ids in brackets)
     league priors     position/role means and dispersions [F100, M004]
     team volume       plays, neutral pass rate, sack/scramble rates [F010-F013]
     opponent          yards per target / carry allowed, catch rate allowed,
                       sack and interception rates made [F064-F071]
     player usage      snap, target, carry, red-zone and third-down shares,
                       recency-weighted, shrunk to the role prior [F017-F034]
     player skill      catch rate, yards per catch, yards per carry, sack,
                       scramble and interception rates, empirical Bayes [F035-F063]
     availability      official status → probability active (the league's
                       own historical play-through rate by status) [F073-F075]
     redistribution    vacated shares to named teammates: the team's own
                       games without the player when they exist, a
                       structural plan otherwise, confidence stated [M045]
     environment       EdgeDesk's game model (margin, total, sigma) [F007-F009]

   Every constant below is a labelled prior or a structural default; the
   ones the data can speak to (role shares, dispersion, status play rates,
   the weather factor, touchdowns per point, the volume regression) are
   FITTED here from games before asOf.
   =========================================================================== */
'use strict';
const E = require('./engine.js');

const CFG = {
  version: 'props_model_config_v1',
  halflife: { share: 5, eff: 9, team: 6 },
  prev_season_decay: 0.65,
  prior_strength: { share_games: 2.0, snap_games: 2.0, catch_tgt: 60, ypr_catch: 30, ypc_car: 90, int_att: 300, sack_db: 180, scr_db: 180, rz: 10, baseline_games: 3, team_games: 4, def_tgt: 120, def_car: 160, def_db: 250 },
  redistribution: { next_up: 0.35, spread: 0.50, leak: 0.15, car_next_up: 0.55, car_spread: 0.30, car_leak: 0.15, affinity: { same: 1.0, WR_TE: 0.55, TE_WR: 0.55, RB_any: 0.35, any_RB: 0.35 } },
  min_share: { tgt: 0.005, car: 0.01 },
  sims: 10000
};

const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const r = (x, k) => (isNum(x) ? Math.round(x * Math.pow(10, k == null ? 3 : k)) / Math.pow(10, k == null ? 3 : k) : null);
const ms = (t) => (t == null ? null : (typeof t === 'number' ? t : Date.parse(t)));
function wmean(xs, ws) { let s = 0, w = 0; for (let i = 0; i < xs.length; i++) if (isNum(xs[i]) && isNum(ws[i])) { s += xs[i] * ws[i]; w += ws[i]; } return w > 0 ? s / w : null; }
function median(a) { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return null; const m = (s.length - 1) / 2; return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2; }
function sd(a) { const s = a.filter(isNum); if (s.length < 2) return null; const m = s.reduce((t, v) => t + v, 0) / s.length; return Math.sqrt(s.reduce((t, v) => t + (v - m) * (v - m), 0) / (s.length - 1)); }

/* ------------------------------------------------------------- indexes */
function index(data) {
  if (data._ix) return data._ix;
  const byPlayer = new Map(), byTeam = new Map(), tgByTeam = new Map(), pgByGame = new Map();
  data.playerGames.forEach((r0) => {
    if (!byPlayer.has(r0.gsis)) byPlayer.set(r0.gsis, []);
    byPlayer.get(r0.gsis).push(r0);
    const k = r0.team;
    if (!byTeam.has(k)) byTeam.set(k, []);
    byTeam.get(k).push(r0);
    if (!pgByGame.has(r0.game_id)) pgByGame.set(r0.game_id, []);
    pgByGame.get(r0.game_id).push(r0);
  });
  for (const t of data.teamGames.values()) { if (!tgByTeam.has(t.team)) tgByTeam.set(t.team, []); tgByTeam.get(t.team).push(t); }
  const sortDesc = (a, b) => (ms(b.kickoff) || 0) - (ms(a.kickoff) || 0);
  for (const v of byPlayer.values()) v.sort(sortDesc);
  for (const v of byTeam.values()) v.sort(sortDesc);
  for (const v of tgByTeam.values()) v.sort(sortDesc);
  data._ix = { byPlayer, byTeam, tgByTeam, pgByGame };
  return data._ix;
}
function before(list, asOfMs) { return (list || []).filter((x) => { const t = ms(x.kickoff); return t != null && t < asOfMs; }); }
function tgKey(game, team) { return game + '|' + team; }

/* recency weights over a desc-sorted list; games from an earlier season decay */
function weights(list, H, curSeason) {
  return list.map((x, i) => Math.pow(0.5, i / H) * (x.season < curSeason ? CFG.prev_season_decay : 1));
}

/* league-level prior constants from the PREVIOUS season (leak-free for the
   current one): offensive plays, neutral pass rate, points per team-game */
function leagueConst(data, season) {
  data._lc = data._lc || {};
  if (data._lc[season]) return data._lc[season];
  const prev = [...data.teamGames.values()].filter((t) => t.season === season - 1 && t.plays > 0);
  const dflt = data.league === 'CFB' ? { plays: 70, npr: 0.52, pts: 28 } : { plays: 63, npr: 0.56, pts: 22 };
  const c = prev.length >= 100 ? { plays: prev.reduce((t, x) => t + x.plays, 0) / prev.length, npr: prev.reduce((t, x) => t + x.neutral_db, 0) / Math.max(1, prev.reduce((t, x) => t + x.neutral_plays, 0)),
    pts: prev.filter((x) => isNum(x.pts_final)).reduce((t, x) => t + x.pts_final, 0) / Math.max(1, prev.filter((x) => isNum(x.pts_final)).length) } : dflt;
  c.basis = prev.length >= 100 ? 'season ' + (season - 1) + ' league averages (' + prev.length + ' team-games)' : 'default (no prior-season team-games loaded)';
  data._lc[season] = c;
  return c;
}

/* ======================================================= LEAGUE PRIORS */
function leaguePriors(data, asOfMs, season) {
  const ix = index(data);
  const tgs = [];
  for (const v of ix.tgByTeam.values()) before(v, asOfMs).forEach((t) => { if (t.season >= season - 1) tgs.push(t); });
  const pgs = data.playerGames.filter((x) => { const t = ms(x.kickoff); return t != null && t < asOfMs && x.season >= season - 1; });
  const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
  const plays = median(tgs.map((t) => t.plays)) || 63;
  const pr = sum(tgs, (t) => t.dropbacks) / Math.max(1, sum(tgs, (t) => t.plays));
  const nPr = sum(tgs, (t) => t.neutral_db) / Math.max(1, sum(tgs, (t) => t.neutral_plays));
  const sack = sum(tgs, (t) => t.sacks) / Math.max(1, sum(tgs, (t) => t.dropbacks));
  const scr = sum(tgs, (t) => t.scrambles) / Math.max(1, sum(tgs, (t) => t.dropbacks));
  const untargeted = 1 - sum(tgs, (t) => t.targets) / Math.max(1, sum(tgs, (t) => t.att));
  const intRate = sum(tgs, (t) => t.int) / Math.max(1, sum(tgs, (t) => t.att));
  const pts = tgs.filter((t) => isNum(t.pts_final));
  const ptsMean = pts.length ? sum(pts, (t) => t.pts_final) / pts.length : 22;
  const tds = sum(tgs, (t) => t.pass_td + t.rush_td);
  const tdPerPt = tds / Math.max(1, sum(pts, (t) => t.pts_final));
  const passTdShare = sum(tgs, (t) => t.pass_td) / Math.max(1, tds);
  const yds = sum(tgs, (t) => t.pass_yds + t.rush_yds) / Math.max(1, tgs.length);
  /* per position group efficiency */
  const pos = {};
  ['WR', 'TE', 'RB', 'QB'].forEach((p) => {
    const rows = pgs.filter((x) => x.pos === p);
    const tgt = sum(rows, (x) => x.tgt), rec = sum(rows, (x) => x.rec), ry = sum(rows, (x) => x.rec_yds), car = sum(rows, (x) => x.des != null ? x.des : x.car), cy = sum(rows, (x) => x.des_yds != null ? x.des_yds : x.rush_yds);
    pos[p] = { catch_rate: tgt ? rec / tgt : null, ypr: rec ? ry / rec : null, ypc: car ? cy / car : null, adot: tgt ? sum(rows, (x) => x.rec_air) / tgt : null, n_tgt: tgt, n_car: car };
  });
  const qbRows = pgs.filter((x) => x.pos === 'QB' && x.att > 0);
  const scrYpc = sum(qbRows, (x) => x.scr_yds) / Math.max(1, sum(qbRows, (x) => x.scr));
  /* role priors: shares by position rank inside each team-game (rank by snaps, then targets+carries) */
  const role = roleShares(data, pgs, ix);
  /* Dirichlet concentration by method of moments on weekly shares */
  const alpha = { tgt: dispersion(pgs, data, 'tgt', 'targets'), car: dispersion(pgs, data, 'car', 'designed') };
  /* how often a listed player plays, by status (the league's own record) */
  const statusPlay = statusPlayRates(data, asOfMs, season);
  const carryForward = carryForwardRates(data, asOfMs, season);
  const missedReturn = data.league === 'CFB' ? missedReturnRate(data, asOfMs, season) : null;
  /* wind: passing yards per attempt in windy outdoor games vs the rest */
  const wind = windFactor(data, tgs);
  /* scale of outcomes around a pregame expectation (the leak-free environment) */
  const env = envResiduals(data, asOfMs, season);
  const volume = fitVolume(data, asOfMs, season);
  return { season, as_of: new Date(asOfMs).toISOString(), n_team_games: tgs.length, n_player_games: pgs.length,
    plays, pass_rate: pr, neutral_pass_rate: nPr, sack_rate: sack, scramble_rate: scr, untargeted_rate: clamp(untargeted, 0.01, 0.12), int_rate: intRate,
    pts_mean: ptsMean, td_per_point: tdPerPt, pass_td_share: passTdShare, yards_per_game: yds, pos, scramble_ypc: scrYpc, role, alpha, status_play: statusPlay, carry_forward: carryForward, missed_return: missedReturn, league_const: leagueConst(data, season), wind, env, volume, hfa: env.hfa };
}
function roleShares(data, pgs, ix) {
  const byGameTeam = new Map();
  pgs.forEach((x) => { const k = x.game_id + '|' + x.team; if (!byGameTeam.has(k)) byGameTeam.set(k, []); byGameTeam.get(k).push(x); });
  const acc = {};
  for (const [k, rows] of byGameTeam) {
    const tg = data.teamGames.get(k);
    if (!tg || !tg.targets || !tg.designed) continue;
    ['WR', 'TE', 'RB', 'QB'].forEach((p) => {
      const list = rows.filter((x) => x.pos === p).sort((a, b) => ((b.snaps || 0) - (a.snaps || 0)) || ((b.tgt + b.car) - (a.tgt + a.car)));
      list.forEach((x, i) => {
        const key = p + (i + 1);
        if (i > 3) return;
        const a = acc[key] || (acc[key] = { tgt: [], car: [], snap: [], rz_tgt: [], rz_car: [] });
        a.tgt.push(x.tgt / tg.targets);
        a.car.push((x.des != null ? x.des : x.car) / tg.designed);
        if (isNum(x.snap_pct)) a.snap.push(x.snap_pct);
        if (tg.rz_targets) a.rz_tgt.push((x.rz_tgt || 0) / tg.rz_targets);
      });
    });
  }
  const out = {};
  Object.keys(acc).forEach((k) => {
    const a = acc[k], m = (v) => v.length ? v.reduce((t, y) => t + y, 0) / v.length : null;
    out[k] = { tgt: r(m(a.tgt), 4), car: r(m(a.car), 4), snap: r(m(a.snap), 3), n: a.tgt.length };
  });
  return out;
}
function dispersion(pgs, data, stat, denom) {
  /* var(observed share) = s(1-s)/n + s(1-s)/(alpha+1) → alpha */
  let num = 0, den = 0, cnt = 0;
  const byP = new Map();
  pgs.forEach((x) => { if (!byP.has(x.gsis)) byP.set(x.gsis, []); byP.get(x.gsis).push(x); });
  for (const rows of byP.values()) {
    const obs = rows.map((x) => { const tg = data.teamGames.get(x.game_id + '|' + x.team); const n = tg ? tg[denom] : 0; const k = stat === 'car' ? (x.des != null ? x.des : x.car) : x.tgt; return n > 5 ? [k / n, n] : null; }).filter(Boolean);
    if (obs.length < 4) continue;
    const s = obs.reduce((t, o) => t + o[0], 0) / obs.length;
    if (s < 0.05 || s > 0.8) continue;
    const v = obs.reduce((t, o) => t + (o[0] - s) * (o[0] - s), 0) / (obs.length - 1);
    const samp = obs.reduce((t, o) => t + s * (1 - s) / o[1], 0) / obs.length;
    num += Math.max(0, v - samp); den += s * (1 - s); cnt++;
  }
  if (!cnt || !(num > 0)) return 25;
  const ratio = num / den;
  return clamp(1 / ratio - 1, 6, 80);
}
function statusPlayRates(data, asOfMs, season) {
  const played = new Set();
  data.playerGames.forEach((x) => { if (ms(x.kickoff) < asOfMs) played.add(x.season + '|' + x.week + '|' + x.gsis); });
  const cnt = {};
  for (const [k, m] of data.injuries) {
    const [se, wk] = k.split('|').map(Number);
    if (se < season - 1) continue;
    /* only weeks fully in the past */
    const anyGame = [...data.games.values()].find((g) => g.season === se && g.week === wk);
    if (!anyGame || ms(anyGame.kickoff) >= asOfMs - 7 * 864e5) continue;
    for (const [g, v] of m) {
      const st = v.status;
      if (!st || !/questionable|doubtful/i.test(st)) continue;
      const pos = data.positions.get(g);
      if (!pos || !/^(QB|RB|WR|TE)$/.test(pos)) continue;
      const key = /doubt/i.test(st) ? 'Doubtful' : 'Questionable';
      const c = cnt[key] || (cnt[key] = { n: 0, played: 0 });
      c.n++; if (played.has(se + '|' + wk + '|' + g)) c.played++;
    }
  }
  const out = {};
  Object.keys(cnt).forEach((k) => { out[k] = { n: cnt[k].n, rate: cnt[k].n >= 30 ? r(cnt[k].played / cnt[k].n, 3) : null }; });
  return out;
}
/* a designation carried into the next week: of the players listed Out /
   Doubtful / Questionable in week W (who then did / did not play in W), what
   share played in W+1 — measured on weeks fully in the past */
function carryForwardRates(data, asOfMs, season) {
  const played = new Set();
  data.playerGames.forEach((x) => { if (ms(x.kickoff) < asOfMs) played.add(x.season + '|' + x.week + '|' + x.gsis); });
  const weekDone = (se, wk) => { const g = [...data.games.values()].find((x) => x.season === se && x.week === wk); return g && ms(g.kickoff) < asOfMs - 7 * 864e5; };
  const cnt = {};
  for (const [k, m] of data.injuries) {
    const [se, wk] = k.split('|').map(Number);
    if (se < season - 1 || !weekDone(se, wk + 1)) continue;
    for (const [g, v] of m) {
      if (!v.status || !/out|doubt|question/i.test(v.status)) continue;
      const pos = data.positions.get(g);
      if (!pos || !/^(QB|RB|WR|TE)$/.test(pos)) continue;
      const key = (/out/i.test(v.status) ? 'Out' : (/doubt/i.test(v.status) ? 'Doubtful' : 'Questionable')) + (played.has(se + '|' + wk + '|' + g) ? '|played' : '|missed');
      const c = cnt[key] || (cnt[key] = { n: 0, played: 0 });
      c.n++; if (played.has(se + '|' + (wk + 1) + '|' + g)) c.played++;
    }
  }
  const out = {};
  Object.keys(cnt).forEach((k) => { out[k] = { n: cnt[k].n, rate: cnt[k].n >= 25 ? r(cnt[k].played / cnt[k].n, 3) : null }; });
  return out;
}
/* CFB has no complete report: a regular (2+ of the team's previous 4 games)
   who MISSED the team's latest game — how often does he play the next one? */
function missedReturnRate(data, asOfMs, season) {
  const ix = index(data);
  let n0 = 0, back = 0;
  for (const [team, list] of ix.tgByTeam) {
    const tgs = before(list, asOfMs).filter((t) => t.season >= season - 1).slice().reverse();
    for (let i = 4; i < tgs.length - 1; i++) {
      const prev4 = tgs.slice(i - 4, i).map((t) => t.game_id), cur = tgs[i].game_id, nxt = tgs[i + 1].game_id;
      const inG = (g) => new Set((ix.pgByGame.get(g) || []).filter((x) => x.team === team && (x.tgt + x.car + x.att) > 0).map((x) => x.gsis));
      const cnt = new Map(); prev4.forEach((g) => inG(g).forEach((id) => cnt.set(id, (cnt.get(id) || 0) + 1)));
      const c = inG(cur), nx = inG(nxt);
      for (const [id, k] of cnt) if (k >= 2 && !c.has(id)) { n0++; if (nx.has(id)) back++; }
    }
  }
  return { n: n0, rate: n0 >= 40 ? r(back / n0, 3) : null };
}
function windFactor(data, tgs) {
  let wY = 0, wA = 0, oY = 0, oA = 0;
  tgs.forEach((t) => { const g = data.games.get(t.game_id); if (!g || !t.att) return; if (g.roof === 'outdoors' && isNum(g.wind) && g.wind >= 15) { wY += t.pass_yds; wA += t.att; } else { oY += t.pass_yds; oA += t.att; } });
  if (!oA) return { factor: 1, n_att: 0 };
  const lg = oY / oA, k = 800;
  const shrunk = (wY + k * lg) / (wA + k);
  return { factor: r(shrunk / lg, 4), n_att: wA };
}
/* the leak-free pregame expectation: recency-weighted points for / against,
   shrunk to the league mean; home field from the same history */
function teamPointsPrior(data, team, asOfMs, season) {
  const ix = index(data);
  const list = before(ix.tgByTeam.get(team) || [], asOfMs).filter((t) => t.season >= season - 1 && isNum(t.pts_final)).slice(0, 16);
  const w = weights(list, CFG.halflife.team, season);
  const k = CFG.prior_strength.team_games;
  const lgPts = leagueConst(data, season).pts;
  const f = list.reduce((t, x, i) => t + w[i] * x.pts_final, 0), a = list.reduce((t, x, i) => t + w[i] * x.opp_pts_final, 0), W = w.reduce((t, x) => t + x, 0);
  return { off: (f + k * lgPts) / (W + k), def: (a + k * lgPts) / (W + k), n: list.length };
}
function leakFreeEnv(data, game, asOfMs, season, hfa) {
  const h = teamPointsPrior(data, game.home, asOfMs, season), a = teamPointsPrior(data, game.away, asOfMs, season);
  const hp = (h.off + a.def) / 2 + (game.neutral ? 0 : hfa / 2), ap = (a.off + h.def) / 2 - (game.neutral ? 0 : hfa / 2);
  return { home_points: hp, away_points: ap, margin: hp - ap, total: hp + ap, n: Math.min(h.n, a.n) };
}
function envResiduals(data, asOfMs, season) {
  const games = [...data.games.values()].filter((g) => g.season >= season - 1 && isNum(g.home_score) && ms(g.kickoff) < asOfMs).sort((a, b) => ms(a.kickoff) - ms(b.kickoff));
  const margins = games.map((g) => g.home_score - g.away_score);
  const hfa = margins.length ? clamp(margins.reduce((t, x) => t + x, 0) / margins.length, 0, 3.5) : 1.5;
  const mres = [], tres = [];
  games.forEach((g) => {
    const e = leakFreeEnv(data, g, ms(g.kickoff), season, hfa);
    if (e.n < 3) return;
    mres.push(g.home_score - g.away_score - e.margin); tres.push(g.home_score + g.away_score - e.total);
  });
  return { hfa: r(hfa, 2), margin_sd: r(sd(mres) || 13.5, 2), total_sd: r(sd(tres) || 13.5, 2), n: mres.length };
}
/* ordinary least squares with a tiny ridge (normal equations, Gauss-Jordan) */
function ols(X, y, ridge) {
  const p = X[0].length, A = [], b = new Array(p).fill(0);
  for (let i = 0; i < p; i++) A.push(new Array(p).fill(0));
  X.forEach((row, n) => { for (let i = 0; i < p; i++) { b[i] += row[i] * y[n]; for (let j = 0; j < p; j++) A[i][j] += row[i] * row[j]; } });
  for (let i = 1; i < p; i++) A[i][i] += ridge || 1e-6;
  for (let i = 0; i < p; i++) {
    let piv = i; for (let k = i + 1; k < p; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
    [A[i], A[piv]] = [A[piv], A[i]]; [b[i], b[piv]] = [b[piv], b[i]];
    const d = A[i][i]; if (Math.abs(d) < 1e-12) return null;
    for (let j = 0; j < p; j++) A[i][j] /= d; b[i] /= d;
    for (let k = 0; k < p; k++) if (k !== i) { const f = A[k][i]; if (!f) continue; for (let j = 0; j < p; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
  }
  const pred = X.map((row) => row.reduce((t, x, i) => t + x * b[i], 0));
  const res = y.map((v, i) => v - pred[i]);
  return { coef: b, resid_sd: sd(res), n: y.length };
}
/* plays and pass rate against leak-free pregame features, fitted on games
   strictly before asOf (the structural relationship: how volume moves with
   expected scoring and expected margin, and how the realised script moves
   the pass rate) */
function fitVolume(data, asOfMs, season) {
  const ix = index(data);
  const games = [...data.games.values()].filter((g) => g.season >= season - 1 && isNum(g.home_score) && ms(g.kickoff) < asOfMs);
  const Xp = [], yp = [], Xr = [], yr = [];
  const hfa = 1.6;
  games.forEach((g) => {
    const t0 = ms(g.kickoff);
    const e = leakFreeEnv(data, g, t0, season, hfa);
    if (e.n < 3) return;
    ['home', 'away'].forEach((side) => {
      const team = g[side], opp = side === 'home' ? g.away : g.home;
      const tg = data.teamGames.get(tgKey(g.game_id, team));
      if (!tg || !tg.plays) return;
      const off = teamVolumePrior(data, team, t0, season), dfn = defensePlaysPrior(data, opp, t0, season);
      if (!off || !dfn) return;
      const expM = side === 'home' ? e.margin : -e.margin;
      const realM = side === 'home' ? g.home_score - g.away_score : g.away_score - g.home_score;
      Xp.push([1, off.plays, dfn.plays_allowed, e.total, expM]); yp.push(tg.plays);
      Xr.push([1, off.neutral_pass_rate, expM, realM - expM]); yr.push(tg.dropbacks / tg.plays);
    });
  });
  const fp = Xp.length >= 60 ? ols(Xp, yp, 1e-3) : null, fr = Xr.length >= 60 ? ols(Xr, yr, 1e-3) : null;
  return {
    plays: fp ? { coef: fp.coef.map((x) => r(x, 5)), resid_sd: r(fp.resid_sd, 3), n: fp.n, terms: ['intercept', 'team_plays_prior', 'opp_plays_allowed_prior', 'expected_total', 'expected_margin'] } : null,
    pass_rate: fr ? { coef: fr.coef.map((x) => r(x, 6)), resid_sd: r(fr.resid_sd, 4), n: fr.n, terms: ['intercept', 'neutral_pass_rate_prior', 'expected_margin', 'realised_minus_expected_margin'] } : null
  };
}
function teamVolumePrior(data, team, asOfMs, season) {
  const ix = index(data);
  const list = before(ix.tgByTeam.get(team) || [], asOfMs).filter((t) => t.season >= season - 1).slice(0, 16);
  if (list.length < 2) return null;
  const w = weights(list, CFG.halflife.team, season), k = CFG.prior_strength.team_games;
  const W = w.reduce((t, x) => t + x, 0);
  const LC = leagueConst(data, season);
  const plays = (list.reduce((t, x, i) => t + w[i] * x.plays, 0) + k * LC.plays) / (W + k);
  const nPlays = list.reduce((t, x, i) => t + w[i] * x.neutral_plays, 0), nDb = list.reduce((t, x, i) => t + w[i] * x.neutral_db, 0);
  const npr = (nDb + 120 * LC.npr) / (nPlays + 120);
  const db = list.reduce((t, x, i) => t + w[i] * x.dropbacks, 0), sk = list.reduce((t, x, i) => t + w[i] * x.sacks, 0);
  const tds = list.reduce((t, x, i) => t + w[i] * (x.pass_td + x.rush_td), 0), ptd = list.reduce((t, x, i) => t + w[i] * x.pass_td, 0);
  const tgt = list.reduce((t, x, i) => t + w[i] * x.targets, 0), att = list.reduce((t, x, i) => t + w[i] * x.att, 0);
  return { plays, neutral_pass_rate: npr, dropbacks: db, sacks: sk, sack_rate_raw: db ? sk / db : null, pass_td_share_raw: tds ? ptd / tds : null, tds_w: tds, n: list.length, untargeted_raw: att ? 1 - tgt / att : null, att_w: att };
}
function defensePlaysPrior(data, team, asOfMs, season) {
  const ix = index(data);
  const own = before(ix.tgByTeam.get(team) || [], asOfMs).filter((t) => t.season >= season - 1).slice(0, 16);
  if (own.length < 2) return null;
  const opp = own.map((t) => data.teamGames.get(tgKey(t.game_id, t.opp))).filter(Boolean);
  if (opp.length < 2) return null;
  const w = weights(opp, CFG.halflife.team, season), k = CFG.prior_strength.team_games, W = w.reduce((t, x) => t + x, 0);
  return { plays_allowed: (opp.reduce((t, x, i) => t + w[i] * x.plays, 0) + k * leagueConst(data, season).plays) / (W + k), n: opp.length };
}

/* =========================================================== OPPONENT */
function defenseFactors(data, team, asOfMs, season, lg) {
  const ix = index(data);
  const own = before(ix.tgByTeam.get(team) || [], asOfMs).filter((t) => t.season >= season - 1).slice(0, 16);
  const games = own.map((t) => t.game_id);
  const w = weights(own, CFG.halflife.team, season);
  const wOf = new Map(games.map((g, i) => [g, w[i]]));
  const acc = { WR: [0, 0, 0, 0], TE: [0, 0, 0, 0], RB: [0, 0, 0, 0], car: [0, 0], db: [0, 0, 0] };
  games.forEach((g) => {
    const wt = wOf.get(g);
    (ix.pgByGame.get(g) || []).forEach((x) => {
      if (x.team === team) return;
      if (acc[x.pos] && x.pos !== 'QB') { const a = acc[x.pos]; a[0] += wt * x.tgt; a[1] += wt * x.rec; a[2] += wt * x.rec_yds; a[3] += wt * 1; }
      if (x.pos === 'RB') { acc.car[0] += wt * (x.des != null ? x.des : x.car); acc.car[1] += wt * (x.des_yds != null ? x.des_yds : x.rush_yds); }
    });
    /* the opposing offence's line in that game: what this defence did to it */
    const mine = own.find((t) => t.game_id === g);
    const oppTg = mine ? data.teamGames.get(tgKey(g, mine.opp)) : null;
    if (oppTg) { acc.db[0] += wt * oppTg.dropbacks; acc.db[1] += wt * oppTg.sacks; acc.db[2] += wt * oppTg.int; }
  });
  const K = CFG.prior_strength;
  const out = { team, n_games: own.length, pos: {} };
  ['WR', 'TE', 'RB'].forEach((p) => {
    const a = acc[p], L = lg.pos[p] || {};
    const lgYpt = L.catch_rate && L.ypr ? L.catch_rate * L.ypr : null;
    const ypt = lgYpt ? (a[2] + K.def_tgt * lgYpt) / (a[0] + K.def_tgt) : null;
    const cr = L.catch_rate ? (a[1] + K.def_tgt * L.catch_rate) / (a[0] + K.def_tgt) : null;
    out.pos[p] = { ypt_factor: lgYpt ? r(ypt / lgYpt, 4) : 1, catch_factor: L.catch_rate ? r(cr / L.catch_rate, 4) : 1, ypt_allowed: lgYpt && a[0] ? r(a[2] / a[0], 2) : null, lg_ypt: r(lgYpt, 2), n_tgt: r(a[0], 1) };
  });
  const lgYpc = lg.pos.RB && lg.pos.RB.ypc;
  out.rush = { ypc_factor: lgYpc ? r(((acc.car[1] + K.def_car * lgYpc) / (acc.car[0] + K.def_car)) / lgYpc, 4) : 1, ypc_allowed: acc.car[0] ? r(acc.car[1] / acc.car[0], 2) : null, lg_ypc: r(lgYpc, 2), n_car: r(acc.car[0], 1) };
  out.sack_factor = r(((acc.db[1] + K.def_db * lg.sack_rate) / (acc.db[0] + K.def_db)) / lg.sack_rate, 4);
  out.int_factor = r(((acc.db[2] + K.def_db * lg.int_rate) / (acc.db[0] + K.def_db)) / lg.int_rate, 4);
  return out;
}

/* ============================================================ PLAYERS */
/* a player's games with THIS team (role is team-specific) and all of his
   games (talent travels with him), both strictly before asOf */
function playerHistory(data, gsis, team, asOfMs, season) {
  const ix = index(data);
  const all = before(ix.byPlayer.get(gsis) || [], asOfMs).filter((x) => x.season >= season - 1);
  return { all, team: all.filter((x) => x.team === team) };
}
/* share of a team quantity, recency-weighted, shrunk toward a role prior */
function shrinkShare(games, data, stat, denom, priorShare, season, kGames) {
  const w = weights(games, CFG.halflife.share, season);
  let num = 0, den = 0, W = 0; const weekly = [];
  games.forEach((x, i) => {
    const tg = data.teamGames.get(tgKey(x.game_id, x.team));
    const n = tg ? tg[denom] : null;
    if (!isNum(n) || n <= 0) return;
    const k = stat(x);
    num += w[i] * k; den += w[i] * n; W += w[i];
    weekly.push(k / n);
  });
  const perGame = W > 0 ? den / W : null;
  const k = (kGames || CFG.prior_strength.share_games) * (perGame || 30);
  const prior = isNum(priorShare) ? priorShare : 0.02;
  const m = (num + k * prior) / (den + k);
  const nEff = den;
  const sdv = Math.sqrt(m * (1 - m) / (nEff + k + 1));
  const cv = weekly.length >= 3 ? (sd(weekly) || 0) / Math.max(0.02, weekly.reduce((t, x) => t + x, 0) / weekly.length) : null;
  const raw = den > 0 ? num / den : null;
  const season_rows = games.filter((x) => x.season === season);
  const sRaw = (() => { let a = 0, b = 0; season_rows.forEach((x) => { const tg = data.teamGames.get(tgKey(x.game_id, x.team)); if (tg && tg[denom] > 0) { a += stat(x); b += tg[denom]; } }); return b > 0 ? a / b : null; })();
  const l3 = (() => { let a = 0, b = 0; games.slice(0, 3).forEach((x) => { const tg = data.teamGames.get(tgKey(x.game_id, x.team)); if (tg && tg[denom] > 0) { a += stat(x); b += tg[denom]; } }); return b > 0 ? a / b : null; })();
  return { mean: m, sd: sdv * (1 + Math.min(1, cv || 0) * 0.5), raw, season: sRaw, last3: l3, prior, n_eff: nEff, cv, weekly };
}
/* efficiency: a rate k/n shrunk toward the position prior (beta-binomial) */
function shrinkRate(games, num, den, prior, strength, season) {
  const w = weights(games, CFG.halflife.eff, season);
  let a = 0, b = 0;
  games.forEach((x, i) => { a += w[i] * num(x); b += w[i] * den(x); });
  const m = (a + strength * prior) / (b + strength);
  return { mean: m, sd: Math.sqrt(Math.max(1e-6, m * (1 - m)) / (b + strength + 1)), raw: b > 0 ? a / b : null, n: b };
}
/* a per-event mean (yards per catch / carry) shrunk toward the prior mean */
function shrinkMean(games, tot, cnt, prior, strength, season, cv) {
  const w = weights(games, CFG.halflife.eff, season);
  let a = 0, b = 0;
  games.forEach((x, i) => { a += w[i] * tot(x); b += w[i] * cnt(x); });
  const m = (a + strength * prior) / (b + strength);
  return { mean: m, sd: (cv || 1.1) / Math.sqrt(b + strength), raw: b > 0 ? a / b : null, n: b };
}
/* the Marcel-style baseline for one stat: recency-weighted per-game mean
   shrunk toward the role mean — the benchmark every model must beat (V003) */
function baseline(games, stat, priorMean, season) {
  const w = weights(games, 4, season);
  let a = 0, W = 0;
  games.forEach((x, i) => { const v = stat(x); if (isNum(v)) { a += w[i] * v; W += w[i]; } });
  const k = CFG.prior_strength.baseline_games;
  return (a + k * priorMean) / (W + k);
}

/* the depth order used for role priors: the provider's timestamped chart
   when one exists before asOf, else snap order in the team's recent games */
function roleOrder(data, team, asOfMs, season, candidates) {
  const D = require('./nfl_data.js');
  const snap = data.depth ? D.depthAsOf(data.depth, team, asOfMs) : null;
  const order = {};
  if (snap) ['QB', 'RB', 'WR', 'TE'].forEach((p) => { snap.ranks[p].forEach((e, i) => { if (order[e.g] == null) order[e.g] = { pos: p, rank: i + 1, source: 'depth_chart', dt: new Date(snap.dt).toISOString() }; }); });
  const byPos = {};
  candidates.forEach((c) => { (byPos[c.pos] = byPos[c.pos] || []).push(c); });
  Object.keys(byPos).forEach((p) => {
    byPos[p].sort((a, b) => (b.recent_snaps - a.recent_snaps) || (b.recent_touches - a.recent_touches));
    byPos[p].forEach((c, i) => { if (!order[c.gsis]) order[c.gsis] = { pos: p, rank: i + 1, source: 'usage' }; });
  });
  return { order, snapshot_at: snap ? new Date(snap.dt).toISOString() : null };
}

/* availability from the official report for this week (pregame), the
   weekly roster's reserve list from the PREVIOUS week, and the league's
   own play-through rate by designation */
function availability(data, season, week, team, gsis, lg, asOfMs) {
  if (data.league === 'CFB') return cfbAvailability(data, season, week, team, gsis, lg, asOfMs);
  const rep = data.injuries.get(season + '|' + week + '|' + team);
  const e = rep ? rep.get(gsis) : null;
  const st = e && e.status ? e.status : null;
  let status = 'ACTIVE', p = 1, basis = rep ? 'official injury report (week ' + week + '): not listed' : 'no injury report on file for this week';
  if (st) {
    if (/^out$/i.test(st)) { status = 'OUT'; p = 0; }
    else if (/doubt/i.test(st)) { status = 'DOUBTFUL'; p = (lg.status_play.Doubtful && lg.status_play.Doubtful.rate) || null; }
    else if (/question/i.test(st)) { status = 'QUESTIONABLE'; p = (lg.status_play.Questionable && lg.status_play.Questionable.rate) || null; }
    basis = 'official injury report (week ' + week + '): ' + st + (e.injury ? ' (' + e.injury + ')' : '') + (e.practice ? ' · ' + e.practice : '');
    if (p == null) { basis += ' · no measured play-through rate yet'; p = status === 'DOUBTFUL' ? 0.25 : 0.75; }
  }
  /* THIS WEEK'S REPORT IS NOT OUT YET (a Tuesday build): the previous
     week's designation carries forward, priced at the league's measured
     rate of playing the following week — never read as healthy */
  if (!rep) {
    const prev = data.injuries.get(season + '|' + (week - 1) + '|' + team);
    const pe = prev ? prev.get(gsis) : null;
    if (pe && pe.status && /out|doubt|question/i.test(pe.status)) {
      const playedPrev = (index(data).byPlayer.get(gsis) || []).some((x) => x.season === season && x.week === week - 1);
      const key = (/out/i.test(pe.status) ? 'Out' : (/doubt/i.test(pe.status) ? 'Doubtful' : 'Questionable')) + (playedPrev ? '|played' : '|missed');
      const cf = lg.carry_forward && lg.carry_forward[key];
      status = 'UNRESOLVED';
      p = cf && isNum(cf.rate) ? cf.rate : (playedPrev ? 0.85 : 0.5);
      basis = 'week ' + week + ' report not yet published; listed ' + pe.status + (pe.injury ? ' (' + pe.injury + ')' : '') + ' in week ' + (week - 1) + ' and ' + (playedPrev ? 'played' : 'did not play') +
        (cf && isNum(cf.rate) ? ' · ' + Math.round(cf.rate * 100) + '% of such players played the next week (n=' + cf.n + ')' : ' · no measured carry-forward rate yet');
      return { status, p_active: p, basis, injury: pe.injury || null, practice: pe.practice || null, carried_forward: true };
    }
  }
  /* reserve lists (IR / PUP) from the most recent weekly roster before this week */
  if (status === 'ACTIVE' && data.roster) {
    for (let wk = week - 1; wk >= Math.max(1, week - 3); wk--) {
      const list = data.roster.get(season + '|' + wk + '|' + team);
      if (!list) continue;
      const rr = list.find((x) => x.gsis === gsis);
      if (rr && /^(RES|RSN|RSR|PUP|NON)$/i.test(rr.status || '')) { status = 'OUT'; p = 0; basis = 'weekly roster week ' + wk + ': ' + rr.status + ' (reserve list)'; }
      break;
    }
  }
  return { status, p_active: p, basis, injury: e ? e.injury : null, practice: e ? e.practice : null };
}

/* CFB: an official conference report when one exists (published before
   the cutoff); otherwise a regular who missed the team's latest game is
   UNRESOLVED at the measured return rate; otherwise UNKNOWN — never
   "healthy" by silence */
function cfbAvailability(data, season, week, team, gsis, lg, asOfMs) {
  const rep = data.injuries.get(season + '|' + week + '|' + team);
  const e = rep ? rep.get(gsis) : null;
  if (e && (!asOfMs || !e.published_at || Date.parse(e.published_at) < asOfMs)) {
    if (e.status && /^out$/i.test(e.status)) return { status: 'OUT', p_active: 0, basis: 'official availability report: Out', source_url: e.source_url || null };
    if (e.status && /question|doubt/i.test(e.status)) {
      const p = (lg.status_play.Questionable && lg.status_play.Questionable.rate) || null;
      return { status: 'QUESTIONABLE', p_active: p != null ? p : 0.6, basis: 'official availability report: ' + e.status + (p == null ? ' · no measured CFB play-through rate yet' : ''), source_url: e.source_url || null };
    }
  }
  if (rep && !e) return { status: 'ACTIVE', p_active: 1, basis: 'not on the official availability report for this game' };
  const ix = index(data);
  const tgs = before(ix.tgByTeam.get(team) || [], asOfMs || Date.now()).filter((t) => t.season === season).slice(0, 5);
  if (tgs.length >= 3) {
    const played = (g) => (ix.pgByGame.get(g) || []).some((x) => x.gsis === gsis && x.team === team && (x.tgt + x.car + x.att) > 0);
    const regular = tgs.slice(1, 5).filter((t) => played(t.game_id)).length >= 2;
    if (regular && !played(tgs[0].game_id)) {
      const mr = lg.missed_return;
      const p = mr && isNum(mr.rate) ? mr.rate : 0.5;
      return { status: 'UNRESOLVED', p_active: p, basis: 'no official report; a regular who did not record a touch in the team’s latest game' + (mr && isNum(mr.rate) ? ' · ' + Math.round(p * 100) + '% of such players played the next game (n=' + mr.n + ')' : ' · no measured return rate yet') };
    }
  }
  return { status: 'UNKNOWN', p_active: 1, basis: 'no official availability report for this game (college reporting is incomplete); the player is assumed to play' };
}

/* ======================================================= REDISTRIBUTION */
function affinity(from, to) {
  const A = CFG.redistribution.affinity;
  if (from === to) return A.same;
  if (to === 'RB') return A.any_RB;
  if (from === 'RB') return A.RB_any;
  return A.WR_TE;
}
/* a plan for one absent player: [[recipient index, fraction], ...] + confidence */
function redistributionPlan(list, i, kind, empirical) {
  const X = list[i], R0 = CFG.redistribution;
  const nextUp = kind === 'car' ? R0.car_next_up : R0.next_up, spread = kind === 'car' ? R0.car_spread : R0.spread;
  const others = list.map((p, j) => ({ p, j })).filter((o) => o.j !== i);
  const same = others.filter((o) => o.p.pos === X.pos).sort((a, b) => (a.p.rank || 9) - (b.p.rank || 9));
  const next = same.find((o) => (o.p.rank || 9) > (X.rank || 0)) || same[0] || null;
  const plan = new Map();
  if (next) plan.set(next.j, nextUp);
  let tot = 0;
  const w = others.map((o) => { const v = Math.pow(Math.max(0.005, o.p.share.mean), 0.8) * affinity(X.pos, o.p.pos); tot += v; return v; });
  others.forEach((o, k) => { plan.set(o.j, (plan.get(o.j) || 0) + (tot > 0 ? spread * w[k] / tot : 0) + (next ? 0 : nextUp * w[k] / (tot || 1))); });
  let structural = [...plan.entries()].map(([j, f]) => [j, f]);
  let confidence = 'LOW', basis = 'structural plan (no games on file without this player)';
  if (empirical && empirical.games >= 1) {
    const wE = empirical.games / (empirical.games + 3);
    const emp = new Map(empirical.fractions.map(([id, f]) => [list.findIndex((p) => p.id === id), f]).filter(([j]) => j >= 0));
    const merged = new Map();
    structural.forEach(([j, f]) => merged.set(j, (1 - wE) * f));
    emp.forEach((f, j) => merged.set(j, (merged.get(j) || 0) + wE * f));
    structural = [...merged.entries()];
    confidence = empirical.games >= 3 ? 'HIGH' : 'MEDIUM';
    basis = empirical.games + ' team game' + (empirical.games === 1 ? '' : 's') + ' without him on file, blended with the structural plan';
  }
  const total = structural.reduce((t, [, f]) => t + f, 0);
  if (total > 0.95) structural = structural.map(([j, f]) => [j, f * 0.95 / total]);
  return { plan: structural.filter(([, f]) => f > 0.001), confidence, basis };
}
/* the team's own games without a player (who was on the roster before and
   after), and what each teammate's share did in them */
function empiricalWithout(data, team, absentId, list, asOfMs, season, stat, denom) {
  const ix = index(data);
  const tgs = before(ix.tgByTeam.get(team) || [], asOfMs).filter((t) => t.season >= season - 1).slice(0, 20);
  const his = new Set(before(ix.byPlayer.get(absentId) || [], asOfMs).filter((x) => x.team === team).map((x) => x.game_id));
  if (!his.size) return null;
  const hisTimes = [...his].map((g) => ms((data.games.get(g) || {}).kickoff)).filter(isNum);
  const first = Math.min.apply(null, hisTimes);
  const without = tgs.filter((t) => !his.has(t.game_id) && ms(t.kickoff) > first);
  const withG = tgs.filter((t) => his.has(t.game_id));
  if (!without.length || withG.length < 2) return { games: 0, fractions: [] };
  const shareIn = (games, id) => { let a = 0, b = 0; games.forEach((t) => { const row = (ix.pgByGame.get(t.game_id) || []).find((x) => x.gsis === id && x.team === team); b += t[denom] || 0; if (row) a += stat(row); }); return b > 0 ? a / b : 0; };
  const hisShare = shareIn(withG, absentId);
  if (!(hisShare > 0.01)) return { games: 0, fractions: [] };
  const fr = [];
  list.forEach((p) => { if (p.id === absentId) return; const d = shareIn(without, p.id) - shareIn(withG, p.id); if (d > 0) fr.push([p.id, clamp(d / hisShare, 0, 0.9)]); });
  const tot = fr.reduce((t, x) => t + x[1], 0);
  return { games: without.length, fractions: tot > 0.95 ? fr.map(([id, f]) => [id, f * 0.95 / tot]) : fr };
}

module.exports = {
  CFG, index, before, weights, leaguePriors, teamPointsPrior, leakFreeEnv, envResiduals, fitVolume, ols, teamVolumePrior, defensePlaysPrior, defenseFactors,
  playerHistory, shrinkShare, shrinkRate, shrinkMean, baseline, roleOrder, availability, leagueConst, redistributionPlan, empiricalWithout, tgKey, wmean, median, sd, clamp, r, ms, isNum
};
