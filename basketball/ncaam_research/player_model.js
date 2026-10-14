'use strict';
/* ===========================================================================
   Player impact: who changes how a team performs, per possession.

   UNITS. Every 2026 possession with ten identified players (NCAA ids) in a
   D1-v-D1 game becomes one row:

     100 * points = mu + sum O[offense five] - sum D[defense five] + eta * v

   (v = +1 home offense, -1 away offense, 0 neutral). Identical rows are
   collapsed into units with a count n and a points sum. O is offensive
   impact and D defensive impact in points per 100 possessions against an
   average D1 player, with teammates and opponents held fixed: regularized
   adjusted plus-minus (Rosenbaum 2004; ridge and out-of-sample penalty
   choice as in Sill 2010).

   PRIOR. Each coefficient is shrunk toward a prior mean, not toward zero:

     O_p ~ Normal(b_O . x_p, s2 / lambda),  D_p ~ Normal(b_D . x_p, s2 / lambda)

   where x_p are the player's box-score rates per 100 possessions on the
   floor (NCAA player box, same id space) and, when the publisher id chain
   links him, last season's publisher RAPM (a full-season fit of an EARLIER
   season: allowed as a prior, never a same-season feature). b is fitted by
   weighted least squares of the zero-prior RAPM on x, inside the training
   window only. This is the box-score-prior idea behind BPM-style and
   EvanMiya-style ratings, implemented here from public descriptions; their
   exact formulas are not public and are not reproduced.

   SOLVER. Ridge normal equations by Jacobi-preconditioned conjugate
   gradients, matrix-free over the units (typed arrays).

   UNCERTAINTY. Posterior covariance blocks per team: the precision of a
   team's own players' O and D (the cross-team terms are dropped), inverted
   exactly. It gives each estimate's SD and the posterior correlation between
   teammates: two players who are almost always on the floor together have a
   strongly negative correlation, which is reported as "not separable"
   rather than hidden.
   =========================================================================== */
const U = require('./lib/util');

/* ---------------------------------------------------------------- units */
/**
 * P: possessions (ingest.loadPossessions); keep(i) -> bool; gamesById for venue.
 * returns { players: [ncaa ids], index: Map, units: {n, ids Int32Array(n*10), sign: off first 5, cnt, pts, ss, v, game} }
 */
function buildUnits(P, keep, gamesById) {
  const index = new Map(); const players = [];
  const pidx = (id) => { let i = index.get(id); if (i == null) { i = players.length; index.set(id, i); players.push(id); } return i; };
  const map = new Map(); // key -> unit index
  let cap = 1 << 16; let n = 0;
  let ids = new Int32Array(cap * 10); let cnt = new Float64Array(cap); let pts = new Float64Array(cap); let ss = new Float64Array(cap); let v = new Int8Array(cap); let game = new Float64Array(cap);
  let offTeam = new Float64Array(cap); let defTeam = new Float64Array(cap); let garbage = new Float64Array(cap);
  const off = new Array(5); const def = new Array(5);
  for (let i = 0; i < P.n; i++) {
    if (!keep(i)) continue;
    const g = gamesById.get(P.game[i]);
    const homeOff = P.off_home[i] === 1;
    for (let k = 0; k < 5; k++) { off[k] = P.ids[i * 10 + (homeOff ? k : 5 + k)]; def[k] = P.ids[i * 10 + (homeOff ? 5 + k : k)]; }
    off.sort((a, b) => a - b); def.sort((a, b) => a - b);
    const vv = g && g.neutral ? 0 : homeOff ? 1 : -1;
    const gb = P.garbage[i] ? 1 : 0;
    const key = off.join(',') + '|' + def.join(',') + '|' + vv + '|' + P.game[i] + '|' + gb;
    let u = map.get(key);
    if (u == null) {
      if (n === cap) {
        cap *= 2;
        const grow = (a, T, m) => { const b = new T(cap * (m || 1)); b.set(a); return b; };
        ids = grow(ids, Int32Array, 10); cnt = grow(cnt, Float64Array); pts = grow(pts, Float64Array); ss = grow(ss, Float64Array); v = grow(v, Int8Array); game = grow(game, Float64Array);
        offTeam = grow(offTeam, Float64Array); defTeam = grow(defTeam, Float64Array); garbage = grow(garbage, Float64Array);
      }
      u = n++; map.set(key, u);
      for (let k = 0; k < 5; k++) { ids[u * 10 + k] = pidx(off[k]); ids[u * 10 + 5 + k] = pidx(def[k]); }
      v[u] = vv; game[u] = P.game[i]; garbage[u] = gb;
      offTeam[u] = homeOff ? P.home[i] : P.away[i]; defTeam[u] = homeOff ? P.away[i] : P.home[i];
    }
    const y = 100 * P.pts[i];
    cnt[u] += 1; pts[u] += y; ss[u] += y * y;
  }
  return { players, index, units: { n, ids: ids.subarray(0, n * 10), cnt: cnt.subarray(0, n), pts: pts.subarray(0, n), ss: ss.subarray(0, n), v: v.subarray(0, n), game: game.subarray(0, n), offTeam: offTeam.subarray(0, n), defTeam: defTeam.subarray(0, n), garbage: garbage.subarray(0, n) } };
}

/** the same players and index, only the units passing keep(u) */
function subset(B, keep) {
  const Ut = B.units; const sel = [];
  for (let u = 0; u < Ut.n; u++) if (keep(u)) sel.push(u);
  const n = sel.length; const o = { n, ids: new Int32Array(n * 10), cnt: new Float64Array(n), pts: new Float64Array(n), ss: new Float64Array(n), v: new Int8Array(n), game: new Float64Array(n), offTeam: new Float64Array(n), defTeam: new Float64Array(n), garbage: new Float64Array(n) };
  sel.forEach((u, j) => {
    o.ids.set(Ut.ids.subarray(u * 10, u * 10 + 10), j * 10);
    for (const k of ['cnt', 'pts', 'ss', 'v', 'game', 'offTeam', 'defTeam', 'garbage']) o[k][j] = Ut[k][u];
  });
  return { players: B.players, index: B.index, units: o };
}

/** each player's team: the offense side of his units (players who changed teams mid-season take the team of most possessions) */
function playerTeams(B) {
  const P = B.players.length; const Ut = B.units; const votes = new Array(P);
  for (let u = 0; u < Ut.n; u++) for (let k = 0; k < 10; k++) {
    const i = Ut.ids[u * 10 + k]; const t = k < 5 ? Ut.offTeam[u] : Ut.defTeam[u];
    const m = votes[i] || (votes[i] = new Map()); m.set(t, (m.get(t) || 0) + Ut.cnt[u]);
  }
  return votes.map((m) => (m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null));
}

/* parameter layout: [O_0..O_{P-1}, D_0..D_{P-1}, mu, eta] ; design row: +O(off five) -D(def five) + mu + eta*v */
function matvecAtWA(U_, P, x, out) {
  out.fill(0);
  const { n, ids, cnt, v } = U_; const MU = 2 * P; const ETA = 2 * P + 1;
  for (let u = 0; u < n; u++) {
    const b = u * 10; let s = x[MU] + x[ETA] * v[u];
    for (let k = 0; k < 5; k++) s += x[ids[b + k]];
    for (let k = 5; k < 10; k++) s -= x[P + ids[b + k]];
    s *= cnt[u];
    for (let k = 0; k < 5; k++) out[ids[b + k]] += s;
    for (let k = 5; k < 10; k++) out[P + ids[b + k]] -= s;
    out[MU] += s; out[ETA] += s * v[u];
  }
}

/**
 * Ridge fit: minimise sum n (ybar - x b)^2 + lambda * sum (b_j - m_j)^2 over player coefficients
 * (mu, eta unpenalised apart from a tiny ridge). prior: Float64Array(2P) or null (zero).
 */
function fitRidge(B, lambda, prior, o) {
  const P = B.players.length; const N = 2 * P + 2; const Ut = B.units;
  const rhs = new Float64Array(N); const diag = new Float64Array(N);
  const MU = 2 * P; const ETA = MU + 1;
  for (let u = 0; u < Ut.n; u++) {
    const b = u * 10; const y = Ut.pts[u]; const c = Ut.cnt[u];
    for (let k = 0; k < 5; k++) { rhs[Ut.ids[b + k]] += y; diag[Ut.ids[b + k]] += c; }
    for (let k = 5; k < 10; k++) { rhs[P + Ut.ids[b + k]] -= y; diag[P + Ut.ids[b + k]] += c; }
    rhs[MU] += y; diag[MU] += c; rhs[ETA] += y * Ut.v[u]; diag[ETA] += c * Ut.v[u] * Ut.v[u];
  }
  const lam = new Float64Array(N); for (let j = 0; j < 2 * P; j++) lam[j] = lambda; lam[MU] = 1e-3; lam[ETA] = 1e-3;
  if (prior) for (let j = 0; j < 2 * P; j++) rhs[j] += lambda * prior[j];
  for (let j = 0; j < N; j++) diag[j] += lam[j];
  // PCG
  const x = new Float64Array(N); if (o && o.x0) x.set(o.x0); else if (prior) x.set(prior.subarray(0, 2 * P));
  const Ax = new Float64Array(N); const r = new Float64Array(N); const z = new Float64Array(N); const p = new Float64Array(N); const Ap = new Float64Array(N);
  const mult = (src, dst) => { matvecAtWA(Ut, P, src, dst); for (let j = 0; j < N; j++) dst[j] += lam[j] * src[j]; };
  mult(x, Ax);
  let rz = 0; for (let j = 0; j < N; j++) { r[j] = rhs[j] - Ax[j]; z[j] = r[j] / diag[j]; p[j] = z[j]; rz += r[j] * z[j]; }
  const tol = (o && o.tol) || 1e-8; let bnorm = 0; for (let j = 0; j < N; j++) bnorm += rhs[j] * rhs[j]; bnorm = Math.sqrt(bnorm);
  let it = 0; const maxIt = (o && o.maxIt) || 800;
  for (; it < maxIt; it++) {
    mult(p, Ap);
    let pAp = 0; for (let j = 0; j < N; j++) pAp += p[j] * Ap[j];
    const a = rz / pAp; let rn = 0;
    for (let j = 0; j < N; j++) { x[j] += a * p[j]; r[j] -= a * Ap[j]; rn += r[j] * r[j]; }
    if (Math.sqrt(rn) < tol * bnorm) break;
    let rz2 = 0; for (let j = 0; j < N; j++) { z[j] = r[j] / diag[j]; rz2 += r[j] * z[j]; }
    const beta = rz2 / rz; rz = rz2;
    for (let j = 0; j < N; j++) p[j] = z[j] + beta * p[j];
  }
  // residual variance per possession
  let sse = 0; let np = 0;
  for (let u = 0; u < Ut.n; u++) {
    const pred = predictUnit(Ut, u, x, P);
    sse += Ut.ss[u] - 2 * pred * Ut.pts[u] + Ut.cnt[u] * pred * pred; np += Ut.cnt[u];
  }
  return { x, P, iterations: it, s2: sse / np, possessions: np, lambda, mu: x[MU], eta: x[ETA] };
}

function predictUnit(Ut, u, x, P) {
  const b = u * 10; let s = x[2 * P] + x[2 * P + 1] * Ut.v[u];
  for (let k = 0; k < 5; k++) s += x[Ut.ids[b + k]];
  for (let k = 5; k < 10; k++) s -= x[P + Ut.ids[b + k]];
  return s;
}

/* ---------------------------------------------------------------- exposure, teammates, raw on/off */
function exposure(B, teamOf) {
  const P = B.players.length; const Ut = B.units;
  const offPoss = new Float64Array(P); const defPoss = new Float64Array(P); const offPts = new Float64Array(P); const defPts = new Float64Array(P);
  const pair = new Map(); // "a,b" (same side) -> shared possessions
  for (let u = 0; u < Ut.n; u++) {
    const b = u * 10; const c = Ut.cnt[u]; const y = Ut.pts[u];
    for (let k = 0; k < 5; k++) { offPoss[Ut.ids[b + k]] += c; offPts[Ut.ids[b + k]] += y; }
    for (let k = 5; k < 10; k++) { defPoss[Ut.ids[b + k]] += c; defPts[Ut.ids[b + k]] += y; }
    for (const s of [0, 5]) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
      const a = Ut.ids[b + s + i]; const d = Ut.ids[b + s + j]; const key = a < d ? a * 100000 + d : d * 100000 + a;
      pair.set(key, (pair.get(key) || 0) + c);
    }
  }
  return { offPoss, defPoss, offPts, defPts, pair };
}

/* ---------------------------------------------------------------- box-score prior */
const BOX_FEATURES = ['pts', 'ts_gap', 'three_a', 'fta', 'ast', 'tov', 'orb', 'drb', 'stl', 'blk', 'pf', 'usage', 'unast', 'rim_a', 'min_share'];

/** per-player box rates per 100 possessions on the floor, from NCAA player-game rows with start before beforeMs */
function boxRates(NP, beforeMs, keepGame) {
  const acc = new Map();
  for (const r of NP.rows) {
    if (beforeMs != null && !(r.start_ms + 4 * 3600e3 < beforeMs)) continue;
    if (keepGame && !keepGame(r.game_id)) continue;
    if (!(r.mins > 0) || !(r.o_poss > 0)) continue;
    let a = acc.get(r.pid);
    if (!a) { a = { pid: r.pid, team: r.team, poss: 0, mins: 0, games: 0, pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, fta: 0, ftm: 0, ast: 0, tov: 0, orb: 0, drb: 0, stl: 0, blk: 0, pf: 0, rima: 0, rimm: 0, mida: 0, midm: 0, fgm_unast: 0, fgm_ast: 0, fga_trans: 0, pbacka: 0, teams: new Set() }; acc.set(r.pid, a); }
    a.teams.add(r.team); a.team = r.team; a.poss += r.o_poss; a.mins += r.mins; a.games++;
    for (const k of ['pts', 'fga', 'fgm', 'tpa', 'tpm', 'fta', 'ftm', 'ast', 'tov', 'orb', 'drb', 'stl', 'blk', 'pf', 'rima', 'rimm', 'mida', 'midm', 'fgm_unast', 'fgm_ast', 'fga_trans', 'pbacka']) a[k] += r[k] || 0;
  }
  const teamMins = new Map(); for (const a of acc.values()) teamMins.set(a.team, (teamMins.get(a.team) || 0) + a.mins);
  for (const a of acc.values()) {
    const per = 100 / a.poss; const tsa = a.fga + 0.44 * a.fta;
    a.rates = {
      pts: a.pts * per, ts_gap: tsa > 0 ? (a.pts / (2 * tsa) - 0.54) * (tsa * per) : 0, three_a: a.tpa * per, fta: a.fta * per, ast: a.ast * per, tov: a.tov * per,
      orb: a.orb * per, drb: a.drb * per, stl: a.stl * per, blk: a.blk * per, pf: a.pf * per, usage: (a.fga + 0.44 * a.fta + a.tov) * per,
      unast: a.fgm_unast * per, rim_a: a.rima * per, min_share: (5 * a.mins) / (teamMins.get(a.team) || a.mins),
    };
  }
  return acc;
}

/** weighted least squares of zero-prior RAPM (O and D separately) on box rates (+ previous-season RAPM when present) */
function fitBoxPrior(fit0, B, box, prev, o) {
  const P = B.players.length; const feats = BOX_FEATURES.slice(); const usePrev = !!prev;
  if (usePrev) feats.push('prev_o', 'prev_d', 'prev_missing');
  const k = feats.length + 1; const rows = []; const minPoss = (o && o.min_poss) || 150;
  const ex = exposure(B);
  for (let i = 0; i < P; i++) {
    const b = box.get(B.players[i]); if (!b || ex.offPoss[i] < minPoss) continue;
    rows.push({ i, x: featureRow(b, prev && prev.get(B.players[i]), usePrev), w: ex.offPoss[i] + ex.defPoss[i] });
  }
  const solve = (target) => {
    const A = new Float64Array(k * k); const r = new Float64Array(k); const ridge = (o && o.ridge) || 50;
    for (const row of rows) { const y = target(row.i); for (let a = 0; a < k; a++) { r[a] += row.w * row.x[a] * y; for (let c = 0; c < k; c++) A[a * k + c] += row.w * row.x[a] * row.x[c]; } }
    for (let a = 1; a < k; a++) A[a * k + a] += ridge * rows.length; // light ridge on slopes (features are on natural scales)
    return U.cholSolve(U.cholesky(A, k), k, r);
  };
  const bO = solve((i) => fit0.x[i]); const bD = solve((i) => fit0.x[P + i]);
  const r2 = (beta, off) => { const y = rows.map((row) => fit0.x[off + row.i]); const p = rows.map((row) => row.x.reduce((s, v, a) => s + v * beta[a], 0)); return U.r(U.corr(y, p) ** 2, 3); };
  return { features: ['intercept', ...feats], bO: Array.from(bO), bD: Array.from(bD), n: rows.length, r2_o: r2(bO, 0), r2_d: r2(bD, P), use_prev: usePrev };
}

function featureRow(b, prev, usePrev) {
  const x = [1]; for (const f of BOX_FEATURES) x.push(b.rates[f]);
  if (usePrev) { if (prev) x.push(prev.o, prev.d, 0); else x.push(0, 0, 1); }
  return x;
}

/** prior means for every player in B from a fitted box prior; players without box rows get the intercept-only prior */
function priorMeans(B, box, prev, bp) {
  const P = B.players.length; const m = new Float64Array(2 * P);
  for (let i = 0; i < P; i++) {
    const b = box.get(B.players[i]);
    if (!b) { m[i] = bp.bO[0]; m[P + i] = bp.bD[0]; continue; }
    const x = featureRow(b, prev && prev.get(B.players[i]), bp.use_prev);
    let so = 0; let sd = 0; for (let a = 0; a < x.length; a++) { so += x[a] * bp.bO[a]; sd += x[a] * bp.bD[a]; }
    m[i] = so; m[P + i] = sd;
  }
  return m;
}

/* ---------------------------------------------------------------- posterior blocks per team */
function teamBlocks(B, fit, teamOf) {
  const P = B.players.length; const Ut = B.units; const lam = fit.lambda;
  const byTeam = new Map();
  for (let i = 0; i < P; i++) { const t = teamOf(B.players[i]); if (t == null) continue; if (!byTeam.has(t)) byTeam.set(t, []); byTeam.get(t).push(i); }
  const local = new Int32Array(P).fill(-1); const teamOfIdx = new Array(P);
  for (const [t, list] of byTeam) list.forEach((i, j) => { local[i] = j; teamOfIdx[i] = t; });
  const prec = new Map(); for (const [t, list] of byTeam) { const m = 2 * list.length; prec.set(t, { list, m, A: new Float64Array(m * m) }); }
  for (let u = 0; u < Ut.n; u++) {
    const b = u * 10; const c = Ut.cnt[u];
    for (const [s, sign] of [[0, 1], [5, -1]]) {
      const t = teamOfIdx[Ut.ids[b + s]]; const blk = prec.get(t); if (!blk) continue;
      const half = blk.m / 2; const loc = [];
      for (let k = 0; k < 5; k++) { const i = Ut.ids[b + s + k]; if (teamOfIdx[i] === t) loc.push(sign > 0 ? local[i] : half + local[i]); }
      for (const a of loc) for (const d of loc) blk.A[a * blk.m + d] += c;
    }
  }
  const out = new Map();
  for (const [t, blk] of prec) {
    for (let a = 0; a < blk.m; a++) blk.A[a * blk.m + a] += lam;
    const inv = U.cholInverse(U.cholesky(blk.A, blk.m), blk.m);
    const half = blk.m / 2;
    blk.list.forEach((i, j) => {
      const vo = fit.s2 * inv[j * blk.m + j]; const vd = fit.s2 * inv[(half + j) * blk.m + half + j]; const cod = fit.s2 * inv[j * blk.m + half + j];
      // net = O + D; teammates' covariance of net estimates (for separability)
      out.set(i, { sd_o: Math.sqrt(vo), sd_d: Math.sqrt(vd), sd_net: Math.sqrt(vo + vd + 2 * cod), team: t, block: blk, j });
    });
    blk.inv = inv;
  }
  return out;
}

/** posterior correlation of two teammates' net estimates */
function netCorrelation(post, i, k, s2) {
  const a = post.get(i); const b = post.get(k); if (!a || !b || a.team !== b.team) return null;
  const { inv, m } = a.block; const half = m / 2; const ja = a.j; const jb = b.j;
  const cov = s2 * (inv[ja * m + jb] + inv[(half + ja) * m + half + jb] + inv[ja * m + half + jb] + inv[(half + ja) * m + jb]);
  return cov / (a.sd_net * b.sd_net);
}

/* ---------------------------------------------------------------- held-out scoring */
/** per-possession squared error of predictions for the units of a held-out set */
function scoreUnits(B, predict) {
  const Ut = B.units; let sse = 0; let n = 0; const byGame = new Map();
  for (let u = 0; u < Ut.n; u++) {
    const p = predict(u); const e = Ut.ss[u] - 2 * p * Ut.pts[u] + Ut.cnt[u] * p * p;
    sse += e; n += Ut.cnt[u];
    const g = Ut.game[u]; const cur = byGame.get(g) || { e: 0, n: 0 }; cur.e += e; cur.n += Ut.cnt[u]; byGame.set(g, cur);
  }
  return { mse: sse / n, possessions: n, byGame };
}

module.exports = { buildUnits, subset, playerTeams, fitRidge, predictUnit, exposure, boxRates, fitBoxPrior, priorMeans, teamBlocks, netCorrelation, scoreUnits, BOX_FEATURES };
