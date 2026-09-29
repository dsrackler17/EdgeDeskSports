/* ===========================================================================
   PLAYER PROPS ENGINE — the Monte Carlo that turns a game into distributions.
   docs/player-props/MODEL.md

     GAME ENVIRONMENT   margin and total shocks around EdgeDesk's own game
                        model (one draw per simulation, shared by both teams)
       → TEAM OPPORTUNITY    plays, pass rate moved by the realised script,
                        dropbacks, sacks, scrambles, attempts, designed runs
       → PLAYER OPPORTUNITY  targets and carries by a Dirichlet-multinomial on
                        each player's share — whose own value is first drawn
                        from its posterior (epistemic uncertainty) before the
                        game's randomness is applied (aleatoric)
       → PLAYER EFFICIENCY   per-target catch probability (posterior draw) and
                        per-play gains drawn from EMPIRICAL league pools,
                        re-scaled to the player's shrunk efficiency, times a
                        game-level efficiency shock shared by the offence
       → OUTCOMES            completions = the catches the QB threw; passing
                        yards = the receiving yards; touchdowns scale with the
                        simulated offence; longest plays are the maxima of the
                        simulated plays (order statistics, never a Normal)

   Because every player of a game is drawn from the SAME simulated game, the
   stored correlations (QB yards with his WR1, an RB's carries with the
   opposing QB's attempts) are properties of the simulation, not assumptions.

   Availability is a scenario inside each simulation: a questionable player
   is active with probability p_active; when inactive his share is handed out
   by the redistribution plan (football/props/model.js). His OWN props are
   recorded only in the simulations where he plays — a book voids a prop on a
   DNP, so the price must be conditional on playing.

   Deterministic: a seeded PRNG, the seed derived from the game id and the
   model version, so a projection can be reproduced exactly.
   =========================================================================== */
'use strict';

const STATS = ['pass_att', 'pass_cmp', 'pass_yds', 'pass_tds', 'pass_int', 'rush_att', 'rush_yds', 'targets', 'receptions', 'rec_yds', 'rush_rec_yds', 'pass_rush_yds', 'anytime_td', 'longest_rec', 'longest_rush', 'longest_cmp'];

/* ------------------------------------------------------------------ RNG */
function mulberry32(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function seedOf(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function Sampler(seed) {
  const u = mulberry32(seed);
  let spare = null;
  const S = {
    u,
    normal() { if (spare !== null) { const v = spare; spare = null; return v; } let x, y, r2; do { x = 2 * u() - 1; y = 2 * u() - 1; r2 = x * x + y * y; } while (r2 >= 1 || r2 === 0); const f = Math.sqrt(-2 * Math.log(r2) / r2); spare = y * f; return x * f; },
    gamma(k) {
      if (k <= 0) return 0;
      if (k < 1) { const g = S.gamma(k + 1); return g * Math.pow(u(), 1 / k); }
      const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
      for (;;) { let x, v; do { x = S.normal(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const uu = u(); if (uu < 1 - 0.0331 * x * x * x * x) return d * v; if (Math.log(uu) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
    },
    beta(m, sd) {
      /* a Beta with this mean and sd (method of moments), clamped sane */
      if (!(sd > 0)) return m;
      const v = Math.min(sd * sd, m * (1 - m) * 0.95);
      const k = m * (1 - m) / v - 1;
      if (!(k > 0)) return m;
      const a = S.gamma(m * k), b = S.gamma((1 - m) * k);
      return a + b > 0 ? a / (a + b) : m;
    },
    binom(n, p) { if (n <= 0 || p <= 0) return 0; if (p >= 1) return n; let k = 0; for (let i = 0; i < n; i++) if (u() < p) k++; return k; },
    poisson(l) { if (!(l > 0)) return 0; if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * S.normal())); const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k - 1; },
    lognormalFactor(sd) { if (!(sd > 0)) return 1; return Math.exp(sd * S.normal() - sd * sd / 2); }
  };
  return S;
}

/* ------------------------------------------------------------ gain pools
   An empirical per-play pool as an integer histogram {lo, counts[]},
   sampled by inverse CDF; rescaled so its mean equals the player's own
   shrunk efficiency: positive gains are multiplied by f (losses kept), with
   f solved so the pool's mean becomes the target exactly. */
function buildPool(values, lo, hi) {
  lo = lo == null ? -20 : lo; hi = hi == null ? 99 : hi;
  const counts = new Array(hi - lo + 1).fill(0);
  let n = 0;
  values.forEach((v) => { if (!isFinite(v)) return; const x = Math.max(lo, Math.min(hi, Math.round(v))); counts[x - lo]++; n++; });
  return poolFromCounts({ lo, counts, n });
}
function poolFromCounts(p) {
  const cum = new Float64Array(p.counts.length);
  let acc = 0, pos = 0, neg = 0, n = 0;
  for (let i = 0; i < p.counts.length; i++) { acc += p.counts[i]; cum[i] = acc; const x = p.lo + i; n += p.counts[i]; if (x > 0) pos += x * p.counts[i]; else neg += x * p.counts[i]; }
  return { lo: p.lo, counts: p.counts, n, cum, mean: n ? (pos + neg) / n : 0, mean_pos: n ? pos / n : 0, mean_neg: n ? neg / n : 0 };
}
function poolDraw(pool, u) {
  const t = u * pool.n, c = pool.cum;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] > t) hi = mid; else lo = mid + 1; }
  return pool.lo + lo;
}
function scaleFor(pool, targetMean) {
  if (!(pool.mean_pos > 0) || !isFinite(targetMean)) return 1;
  return Math.max(0.35, Math.min(2.5, (targetMean - pool.mean_neg) / pool.mean_pos));
}
function scaled(y, f) { return y > 0 ? Math.min(99, Math.round(y * f)) : y; }

/* ------------------------------------------------------ the simulation */
function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
/* shares for one simulation: posterior draw per player, then renormalise
   against the fixed "other" bucket so the team total is conserved */
function drawShares(S, list, otherShare, activeMask) {
  const w = new Float64Array(list.length + 1);
  let tot = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!activeMask[i]) { w[i] = 0; continue; }
    const m = p._share_s;
    w[i] = m > 0 ? S.beta(Math.min(0.95, m), p.share.sd || 0) : 0;
    tot += w[i];
  }
  w[list.length] = Math.max(0.005, otherShare);
  tot += w[list.length];
  for (let i = 0; i <= list.length; i++) w[i] /= tot;
  return w;
}
/* Dirichlet(alpha · w) then multinomial(n): the game's own share noise */
function allocate(S, n, w, alpha) {
  const k = w.length, g = new Float64Array(k);
  let tot = 0;
  for (let i = 0; i < k; i++) { g[i] = w[i] > 0 ? S.gamma(alpha * w[i]) : 0; tot += g[i]; }
  const out = new Int32Array(k);
  if (!(tot > 0) || n <= 0) return out;
  const cum = new Float64Array(k);
  let acc = 0;
  for (let i = 0; i < k; i++) { acc += g[i] / tot; cum[i] = acc; }
  for (let j = 0; j < n; j++) { const x = S.u(); let i = 0; while (i < k - 1 && cum[i] < x) i++; out[i]++; }
  return out;
}

/* apply a redistribution plan: inactive player's share goes to named
   recipients by fraction; whatever the plan does not place stays in
   "other" (not every vacated target finds a new receiver) */
function sharesWithAbsences(list, otherShare, active) {
  const s = list.map((p) => p.share.mean);
  let other = otherShare;
  list.forEach((p, i) => {
    if (active[i] || !(s[i] > 0)) return;
    const give = s[i];
    s[i] = 0;
    let placed = 0;
    (p.redistribute || []).forEach((r) => {
      const j = r[0];
      if (j >= 0 && j < list.length && active[j]) { s[j] += give * r[1]; placed += give * r[1]; }
    });
    other += give - placed;
  });
  return { shares: s, other };
}

/* one game. g: see football/props/model.js gameInput() */
function simulate(g, pools, opts) {
  opts = opts || {};
  const N = opts.sims || g.sims || 10000;
  const S = Sampler(seedOf(String(g.seed || g.game_id)));
  const P = {};
  Object.keys(pools || {}).forEach((k) => { P[k] = pools[k].cum ? pools[k] : poolFromCounts(pools[k]); });
  const out = {};
  const sides = ['home', 'away'];
  sides.forEach((side) => {
    const T = g.teams[side];
    T._rec = (T.receivers || []).map((p) => Object.assign({}, p));
    T._rush = (T.rushers || []).map((p) => Object.assign({}, p));
    const reg = (id) => { if (!out[id]) { out[id] = { team: T.team }; STATS.forEach((st) => { out[id][st] = new Float32Array(N).fill(NaN); }); } return out[id]; };
    T._rec.forEach((p) => { p._o = reg(p.id); p._pool = P[p.pool] || P.WR; p._f = scaleFor(p._pool, p.ypr.mean); });
    T._rush.forEach((p) => { p._o = reg(p.id); p._pool = P[p.pool] || P.rush_rb; p._f = scaleFor(p._pool, p.ypc.mean); });
    if (T.qb && T.qb.id) { T._qbo = reg(T.qb.id); T._scr = P.scramble; T._scrF = scaleFor(P.scramble, T.qb.scramble_ypc || P.scramble.mean); }
    T._otherPool = P.WR; T._otherF = scaleFor(P.WR, T.other.ypr || P.WR.mean);
  });
  const sm = g.margin.sd, st = g.total.sd;
  for (let s = 0; s < N; s++) {
    const zm = S.normal(), zt = S.normal();
    for (let si = 0; si < 2; si++) {
      const side = sides[si], T = g.teams[side], sign = side === 'home' ? 1 : -1;
      const devM = sign * sm * zm, devT = st * zt;
      /* TEAM OPPORTUNITY */
      const plays = Math.round(clamp(T.plays.mean + T.plays.script * devM + T.plays.total * devT + T.plays.sd * S.normal(), 38, 95));
      const pr = clamp(T.pass_rate.mean + T.pass_rate.script * devM + T.pass_rate.sd * S.normal(), 0.25, 0.85);
      const db = S.binom(plays, pr);
      const sacks = S.binom(db, T.sack_rate);
      const scr = S.binom(db - sacks, T.qb ? T.qb.scramble_rate : 0);
      const att = db - sacks - scr;
      const designed = plays - db;
      const tgtTeam = S.binom(att, 1 - T.untargeted_rate);
      const effP = T.eff.pass * S.lognormalFactor(T.eff.pass_sd), effR = T.eff.rush * S.lognormalFactor(T.eff.rush_sd);
      /* AVAILABILITY scenario */
      const recAct = T._rec.map((p) => !(p.p_active < 1) || S.u() < p.p_active);
      const rushAct = T._rush.map((p) => !(p.p_active < 1) || S.u() < p.p_active);
      /* the same person may sit in both lists (an RB): one draw decides both */
      T._rush.forEach((p, i) => { const j = T._rec.findIndex((q) => q.id === p.id); if (j >= 0) rushAct[i] = recAct[j]; });
      const ra = sharesWithAbsences(T._rec, T.other.tgt_share, recAct);
      T._rec.forEach((p, i) => { p._share_s = ra.shares[i]; });
      const wT = drawShares(S, T._rec, ra.other, recAct);
      const tgts = allocate(S, tgtTeam, wT, T.alpha.tgt);
      const rr = sharesWithAbsences(T._rush, T.other.car_share, rushAct);
      T._rush.forEach((p, i) => { p._share_s = rr.shares[i]; });
      const wR = drawShares(S, T._rush, rr.other, rushAct);
      const cars = allocate(S, designed, wR, T.alpha.car);
      /* RECEIVING */
      let cmp = 0, passYds = 0, longCmp = 0, teamYds = 0;
      const catches = new Int32Array(T._rec.length + 1);
      for (let i = 0; i < T._rec.length; i++) {
        const p = T._rec[i], o = p._o;
        const t = tgts[i];
        const c = clamp(S.beta(p.catch.mean, p.catch.sd || 0) * T.eff.catch, 0.2, 0.97);
        const k = S.binom(t, c);
        const f = p._f * effP * S.lognormalFactor(p.ypr.sd || 0);
        let y = 0, lg = 0;
        for (let j = 0; j < k; j++) { const d = scaled(poolDraw(p._pool, S.u()), f); y += d; if (j === 0 || d > lg) lg = d; }
        catches[i] = k; cmp += k; passYds += y; if (k && lg > longCmp) longCmp = lg; teamYds += y;
        if (recAct[i]) { o.targets[s] = t; o.receptions[s] = k; o.rec_yds[s] = y; o.longest_rec[s] = k ? lg : 0; }
      }
      /* the "other" bucket (depth players, untracked) still throws completions */
      const to = tgts[T._rec.length];
      const ko = S.binom(to, T.other.catch);
      let yo = 0;
      for (let j = 0; j < ko; j++) { const d = scaled(poolDraw(T._otherPool, S.u()), T._otherF * effP); yo += d; if (d > longCmp) longCmp = d; }
      cmp += ko; passYds += yo; teamYds += yo; catches[T._rec.length] = ko;
      /* RUSHING */
      let rushTeam = 0;
      for (let i = 0; i < T._rush.length; i++) {
        const p = T._rush[i], o = p._o;
        const c = cars[i];
        const f = p._f * effR * S.lognormalFactor(p.ypc.sd || 0);
        let y = 0, lg = 0;
        for (let j = 0; j < c; j++) { const d = scaled(poolDraw(p._pool, S.u()), f); y += d; if (j === 0 || d > lg) lg = d; }
        p._c = c; p._y = y; p._lg = c ? lg : 0; rushTeam += y;
      }
      const oc = cars[T._rush.length];
      for (let j = 0; j < oc; j++) rushTeam += scaled(poolDraw(P.rush_rb, S.u()), effR);
      /* QB scrambles are rushes too */
      let scrY = 0, scrL = 0;
      for (let j = 0; j < scr; j++) { const d = scaled(poolDraw(T._scr, S.u()), T._scrF * effR); scrY += d; if (j === 0 || d > scrL) scrL = d; }
      rushTeam += scrY;
      teamYds += rushTeam;
      /* TOUCHDOWNS scale with the simulated offence (yards vs expectation) */
      const lam = Math.max(0.05, T.td.per_game * Math.pow(Math.max(0.2, teamYds / T.td.yards_mean), T.td.elasticity));
      const tds = S.poisson(lam);
      const passTd = S.binom(tds, clamp(T.td.pass_share + T.td.pass_share_script * (pr - T.pass_rate.mean), 0.2, 0.9));
      const rushTd = tds - passTd;
      const recTd = new Int32Array(T._rec.length), rushTdP = new Int32Array(T._rush.length);
      let qbRushTd = 0;
      for (let k = 0; k < passTd; k++) {
        let tot = 0;
        const w = T._rec.map((p, i) => { const v = catches[i] > 0 ? p.rz_share * Math.sqrt(catches[i]) : 0; tot += v; return v; });
        const wo = catches[T._rec.length] > 0 ? T.other.rz_tgt_share * Math.sqrt(catches[T._rec.length]) : 0;
        tot += wo;
        if (!(tot > 0)) break;
        let x = S.u() * tot, i = 0;
        for (; i < w.length; i++) { x -= w[i]; if (x <= 0) break; }
        if (i < w.length) recTd[i]++;
      }
      for (let k = 0; k < rushTd; k++) {
        let tot = 0;
        const w = T._rush.map((p) => { const v = p._c > 0 ? p.rz_share : 0; tot += v; return v; });
        const wq = T.qb && scr > 0 ? (T.qb.rz_scramble_share || 0.02) : 0;
        const wo = oc > 0 ? T.other.rz_car_share : 0;
        tot += wq + wo;
        if (!(tot > 0)) break;
        let x = S.u() * tot, i = 0;
        for (; i < w.length; i++) { x -= w[i]; if (x <= 0) break; }
        if (i < w.length) rushTdP[i]++;
        else if (x - wq <= 0 && wq > 0) qbRushTd++;
      }
      /* write the rushers (a QB's designed runs + scrambles are one line) */
      for (let i = 0; i < T._rush.length; i++) {
        const p = T._rush[i], o = p._o;
        if (!rushAct[i]) continue;
        let c = p._c, y = p._y, lg = p._lg, rtd = rushTdP[i];
        if (T.qb && p.id === T.qb.id) { c += scr; y += scrY; lg = Math.max(lg, scr ? scrL : 0); rtd += qbRushTd; }
        o.rush_att[s] = c; o.rush_yds[s] = y; o.longest_rush[s] = c ? lg : 0;
        o.anytime_td[s] = (isNaN(o.anytime_td[s]) ? 0 : o.anytime_td[s]) + rtd;
      }
      T._rec.forEach((p, i) => { if (!recAct[i]) return; const o = p._o; o.anytime_td[s] = (isNaN(o.anytime_td[s]) ? 0 : o.anytime_td[s]) + recTd[i]; });
      /* the quarterback's own line */
      if (T._qboAct !== false && T._qbo) {
        const o = T._qbo;
        o.pass_att[s] = att; o.pass_cmp[s] = cmp; o.pass_yds[s] = passYds; o.pass_tds[s] = passTd;
        o.pass_int[s] = S.binom(att, T.qb.int_rate);
        o.longest_cmp[s] = cmp ? longCmp : 0;
        if (isNaN(o.rush_att[s])) { o.rush_att[s] = scr; o.rush_yds[s] = scrY; o.longest_rush[s] = scr ? scrL : 0; o.anytime_td[s] = qbRushTd; }
      }
    }
  }
  /* composites, from the same simulations */
  Object.keys(out).forEach((id) => {
    const o = out[id];
    for (let s = 0; s < N; s++) {
      const ry = o.rush_yds[s], cy = o.rec_yds[s], py = o.pass_yds[s];
      if (!isNaN(ry) || !isNaN(cy)) o.rush_rec_yds[s] = (isNaN(ry) ? 0 : ry) + (isNaN(cy) ? 0 : cy);
      if (!isNaN(py)) o.pass_rush_yds[s] = py + (isNaN(ry) ? 0 : ry);
      if (!isNaN(o.rush_yds[s]) && isNaN(o.targets[s]) && isNaN(o.pass_att[s])) { /* pure rusher: receiving is 0 by definition only if listed as receiver; leave NaN */ }
    }
  });
  return { sims: N, players: out, seed: seedOf(String(g.seed || g.game_id)) };
}

/* Spearman rank correlation between two simulated stats (NaN-aware) */
function spearman(a, b) {
  const idx = [];
  for (let i = 0; i < a.length; i++) if (!isNaN(a[i]) && !isNaN(b[i])) idx.push(i);
  if (idx.length < 200) return null;
  const rank = (arr) => { const o = idx.map((i) => [arr[i], i]).sort((x, y) => x[0] - y[0]); const rk = new Map(); let j = 0; while (j < o.length) { let k = j; while (k + 1 < o.length && o[k + 1][0] === o[j][0]) k++; const rr = (j + k) / 2; for (let t = j; t <= k; t++) rk.set(o[t][1], rr); j = k + 1; } return rk; };
  const ra = rank(a), rb = rank(b);
  let ma = 0, mb = 0; idx.forEach((i) => { ma += ra.get(i); mb += rb.get(i); }); ma /= idx.length; mb /= idx.length;
  let sab = 0, saa = 0, sbb = 0;
  idx.forEach((i) => { const x = ra.get(i) - ma, y = rb.get(i) - mb; sab += x * y; saa += x * x; sbb += y * y; });
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

module.exports = { STATS, simulate, spearman, buildPool, poolFromCounts, poolDraw, scaleFor, Sampler, seedOf, mulberry32 };
