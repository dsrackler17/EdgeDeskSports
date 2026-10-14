'use strict';
/* ===========================================================================
   What makes a team effective: opponent-adjusted style and skill profiles.

   Every factor is a rate on one side of one game (an offense against a
   defense) with its natural denominator as the weight, fitted with the same
   additive opponent adjustment as the efficiency ratings (lib/additive.js):

     shooting     eFG%, 2P%, 3P%, FT%, rim / mid-range / three share and
                  accuracy (rim and mid-range from the publisher's NCAA
                  classification, used only where its totals agree with the
                  ESPN box)
     possessions  turnover %, steal %, offensive rebound %, free-throw rate
                  (FTA/FGA: generation on offense, foul exposure on defense),
                  assisted share of makes, block %
     tempo        seconds per possession on offense and conceded on defense
                  (publisher parse), fast-break points per 100 (ESPN)
     2026 only    transition share of possessions, points per possession in
                  transition and in the half court (publisher possession
                  classification)

   OBSERVED vs SUSTAINABLE. For each factor the split-half reliability across
   team-seasons (odd vs even games, Spearman-Brown to a full season) gives
   the weight k at which a team's observed rate is half signal: k = n * (1 -
   rho) / rho. The "sustainable" estimate is the opponent-adjusted rate
   shrunk with that k; "observed" is the plain season rate. Three-point
   percentage allowed, for example, comes out mostly noise (a large k), so a
   defense's hot or cold opponent shooting is not credited as skill.

   Classifications here are box-score and parser categories, not tracking:
   nothing in this file says anything about coverage schemes, spacing or shot
   quality, which the data cannot establish.
   =========================================================================== */
const C = require('./config');
const U = require('./lib/util');
const { Additive } = require('./lib/additive');

const pct = (a, b) => (b > 0 ? a / b : NaN);
const posOf = (r, c) => r.fga - r.orb + r.tov + c * r.fta;

/* each factor: y and w from (offense row r, defense row o = r.o, coefficient c) */
const FACTORS = [
  { key: 'efg', label: 'Effective FG%', group: 'shooting', y: (r) => pct(r.fgm + 0.5 * r.tpm, r.fga), w: (r) => r.fga, good: 'high' },
  { key: 'two_pct', label: '2-point FG%', group: 'shooting', y: (r) => pct(r.fgm - r.tpm, r.fga - r.tpa), w: (r) => r.fga - r.tpa, good: 'high' },
  { key: 'three_pct', label: '3-point FG%', group: 'shooting', y: (r) => pct(r.tpm, r.tpa), w: (r) => r.tpa, good: 'high' },
  { key: 'ft_pct', label: 'Free-throw %', group: 'shooting', y: (r) => pct(r.ftm, r.fta), w: (r) => r.fta, good: 'high', offense_only: true },
  { key: 'three_rate', label: '3-point attempt share', group: 'shot_mix', y: (r) => pct(r.tpa, r.fga), w: (r) => r.fga, good: null },
  { key: 'rim_rate', label: 'Rim attempt share', group: 'shot_mix', src: 'ncaa', y: (r) => pct(r.ncaa.rima, r.fga), w: (r) => r.fga, good: null },
  { key: 'mid_rate', label: 'Mid-range attempt share', group: 'shot_mix', src: 'ncaa', y: (r) => pct(r.ncaa.mida, r.fga), w: (r) => r.fga, good: null },
  { key: 'rim_pct', label: 'Rim FG%', group: 'shooting', src: 'ncaa', y: (r) => pct(r.ncaa.rimm, r.ncaa.rima), w: (r) => r.ncaa.rima, good: 'high' },
  { key: 'mid_pct', label: 'Mid-range FG%', group: 'shooting', src: 'ncaa', y: (r) => r.ncaa.mid_pct, w: (r) => r.ncaa.mida, good: 'high' },
  { key: 'tov_pct', label: 'Turnover %', group: 'ball_security', y: (r, o, c) => pct(r.tov, posOf(r, c)), w: (r, o, c) => posOf(r, c), good: 'low' },
  { key: 'stl_pct', label: 'Steal % (opponent steals per possession)', group: 'ball_security', y: (r, o, c) => pct(o.stl, posOf(r, c)), w: (r, o, c) => posOf(r, c), good: 'low' },
  { key: 'orb_pct', label: 'Offensive rebound %', group: 'rebounding', y: (r, o) => pct(r.orb, r.orb + o.drb), w: (r, o) => r.orb + o.drb, good: 'high' },
  { key: 'ftr', label: 'Free-throw rate (FTA/FGA)', group: 'free_throws', y: (r) => pct(r.fta, r.fga), w: (r) => r.fga, good: 'high' },
  { key: 'ast_share', label: 'Assisted share of made FG', group: 'creation', y: (r) => pct(r.ast, r.fgm), w: (r) => r.fgm, good: null },
  { key: 'blk_pct', label: 'Block % (2PA blocked)', group: 'shooting', y: (r, o) => pct(o.blk, r.fga - r.tpa), w: (r) => r.fga - r.tpa, good: 'low' },
  { key: 'fast_break_100', label: 'Fast-break points per 100 possessions (ESPN)', group: 'transition', y: (r, o, c) => (r.fb_pts == null ? NaN : (100 * r.fb_pts) / posOf(r, c)), w: () => 1, good: 'high' },
  { key: 'sec_per_poss', label: 'Seconds per possession', group: 'tempo', src: 'ncaa', y: (r) => r.ncaa.sec_per_poss, w: () => 1, good: null },
];
const POSS_FACTORS = [
  { key: 'transition_share', label: 'Transition share of possessions', group: 'transition', good: null },
  { key: 'transition_ppp', label: 'Points per transition possession', group: 'transition', good: 'high' },
  { key: 'halfcourt_ppp', label: 'Points per half-court possession', group: 'transition', good: 'high' },
];

function usableSide(r, f) {
  if (!r.o || r.flags.length) return false;
  if (f.src === 'ncaa' && (!r.ncaa || r.ncaa.quarantined)) return false;
  return true;
}

/** team-game sides of D1-v-D1 games of `season`, completed before `beforeMs` */
function sides(TG, gamesById, season, beforeMs) {
  const out = [];
  for (const r of TG.rows) {
    if (r.season !== season || !r.o) continue;
    const g = gamesById.get(r.game_id); if (!g || g.regime !== 'D1_D1' || g.status !== 'FINAL') continue;
    if (beforeMs != null && g.start_ms + C.AVAILABLE_AFTER_MS >= beforeMs) continue;
    out.push({ r, g });
  }
  return out;
}

/* split-half reliability of the raw team rate (offense and defense), pooled over the given seasons */
function reliability(TG, gamesById, seasons, f, c) {
  const res = {};
  for (const role of ['offense', 'defense']) {
    if (role === 'defense' && f.offense_only) continue;
    const halves = new Map(); // teamSeason -> [{yw, w}, {yw, w}]
    for (const s of seasons) {
      const ss = sides(TG, gamesById, s, null).sort((a, b) => a.g.start_ms - b.g.start_ms);
      const count = new Map();
      for (const { r, g } of ss) {
        if (!usableSide(r, f)) continue;
        const y = f.y(r, r.o, c); const w = f.w(r, r.o, c); if (!Number.isFinite(y) || !(w > 0)) continue;
        const team = role === 'offense' ? r.team : r.opp; const key = s + ':' + team;
        const k = count.get(key) || 0; count.set(key, k + 1);
        if (!halves.has(key)) halves.set(key, [{ yw: 0, w: 0 }, { yw: 0, w: 0 }]);
        const h = halves.get(key)[k % 2]; h.yw += y * w; h.w += w;
      }
    }
    const a = []; const b = []; const tw = [];
    for (const [, h] of halves) if (h[0].w > 0 && h[1].w > 0) { a.push(h[0].yw / h[0].w); b.push(h[1].yw / h[1].w); tw.push(h[0].w + h[1].w); }
    const rho = U.corr(a, b);
    const full = rho > 0 ? (2 * rho) / (1 + rho) : 0;
    const nbar = U.mean(tw);
    res[role] = { team_seasons: a.length, split_half_r: U.r(rho, 3), full_season_reliability: U.r(full, 3), mean_weight: U.r(nbar, 1), k: full > 0.01 ? U.r((nbar * (1 - full)) / full, 1) : null };
  }
  return res;
}

/* opponent-adjusted fit of one factor for one season as of `beforeMs` */
function fitFactor(TG, gamesById, season, beforeMs, f, c, lambdaOff, lambdaAllow) {
  const A = new Additive({ lambdaOff, lambdaAllow, kMu: 1e-6, kEta: 1e-6, sweeps: 40, center: true });
  const raw = new Map();
  for (const { r, g } of sides(TG, gamesById, season, beforeMs)) {
    if (!usableSide(r, f)) continue;
    const y = f.y(r, r.o, c); const w = f.w(r, r.o, c);
    if (!Number.isFinite(y) || !(w > 0)) continue;
    const v = g.neutral ? 0 : r.side === 'home' ? 1 : -1;
    A.add(r.team, r.opp, y, w, v, g.start_ms / 864e5);
    for (const [team, role] of [[r.team, 'off'], [r.opp, 'def']]) {
      if (!raw.has(team)) raw.set(team, { off: { yw: 0, w: 0, n: 0 }, def: { yw: 0, w: 0, n: 0 } });
      const x = raw.get(team)[role]; x.yw += y * w; x.w += w; x.n++;
    }
  }
  A.fit(Infinity, null);
  return { A, raw };
}

/** every factor for one season: raw, adjusted (light shrinkage) and sustainable (reliability shrinkage), with ranks */
function seasonProfiles(TG, G, season, beforeMs, c, rel) {
  const gamesById = G.byId; const out = { factors: {}, league: {} };
  for (const f of FACTORS) {
    const R = rel[f.key];
    const kOff = R && R.offense && R.offense.k != null ? R.offense.k : 1;
    const kDef = f.offense_only ? 1e9 : R && R.defense && R.defense.k != null ? R.defense.k : 1;
    const light = fitFactor(TG, gamesById, season, beforeMs, f, c, Math.max(1e-3, kOff / 50), f.offense_only ? 1e9 : Math.max(1e-3, kDef / 50));
    const sus = fitFactor(TG, gamesById, season, beforeMs, f, c, kOff, kDef);
    const teams = {};
    for (const [team, x] of light.raw) {
      const la = light.A.rating(team); const sa = sus.A.rating(team); if (!la || !sa) continue;
      const vs = sus.A.variance(team);
      teams[team] = {
        off: { observed: x.off.w ? x.off.yw / x.off.w : null, adjusted: light.A.mu + la.off, sustainable: sus.A.mu + sa.off, sd: Math.sqrt(vs.off), weight: x.off.w, games: x.off.n },
        def: f.offense_only ? null : { observed: x.def.w ? x.def.yw / x.def.w : null, adjusted: light.A.mu + la.allow, sustainable: sus.A.mu + sa.allow, sd: Math.sqrt(vs.allow), weight: x.def.w, games: x.def.n },
      };
    }
    for (const role of ['off', 'def']) {
      if (role === 'def' && f.offense_only) continue;
      const list = Object.entries(teams).filter(([, t]) => t[role] && Number.isFinite(t[role].adjusted)).sort((a, b) => b[1][role].adjusted - a[1][role].adjusted);
      list.forEach(([, t], i) => { t[role].rank = i + 1; t[role].of = list.length; });
    }
    out.factors[f.key] = teams; out.league[f.key] = light.A.mu;
  }
  return out;
}

/* ---------------------------------------------------------------- 2026 possession classification */
function possessionProfiles(P, PQ, G, beforeMs) {
  const tg = new Map(); // game:team -> counts
  for (let i = 0; i < P.n; i++) {
    if (P.off_home[i] < 0 || P.pts[i] < 0) continue;
    const g = G.byId.get(P.game[i]); if (!g || g.regime !== 'D1_D1') continue;
    if (beforeMs != null && g.start_ms + C.AVAILABLE_AFTER_MS >= beforeMs) continue;
    const q = PQ.byGame.get(P.game[i]); if (!q || q.status === 'LARGER' || q.status === 'NO_OFFICIAL_BOX') continue;
    const off = P.off_home[i] === 1 ? P.home[i] : P.away[i]; const def = P.off_home[i] === 1 ? P.away[i] : P.home[i];
    const k = P.game[i] + ':' + off;
    if (!tg.has(k)) tg.set(k, { off, def, g, n: 0, tn: 0, tp: 0, hn: 0, hp: 0 });
    const x = tg.get(k); x.n++;
    if (P.transition[i]) { x.tn++; x.tp += P.pts[i]; } else { x.hn++; x.hp += P.pts[i]; }
  }
  const fits = {};
  const defs = { transition_share: (x) => [x.tn / x.n, x.n], transition_ppp: (x) => [x.tp / x.tn, x.tn], halfcourt_ppp: (x) => [x.hp / x.hn, x.hn] };
  for (const [key, fn] of Object.entries(defs)) {
    const lam = key === 'transition_share' ? 120 : key === 'transition_ppp' ? 150 : 400;
    const A = new Additive({ lambdaOff: lam, lambdaAllow: lam, kMu: 1e-6, kEta: 1e-6, sweeps: 40, center: true }); const raw = new Map();
    for (const x of tg.values()) {
      const [y, w] = fn(x); if (!Number.isFinite(y) || !(w > 0)) continue;
      const v = x.g.neutral ? 0 : x.off === x.g.home ? 1 : -1;
      A.add(x.off, x.def, y, w, v, x.g.start_ms / 864e5);
      for (const [team, role] of [[x.off, 'off'], [x.def, 'def']]) { if (!raw.has(team)) raw.set(team, { off: { yw: 0, w: 0 }, def: { yw: 0, w: 0 } }); const r = raw.get(team)[role]; r.yw += y * w; r.w += w; }
    }
    A.fit(Infinity, null);
    const teams = {};
    for (const [team, r] of raw) { const a = A.rating(team); const v = A.variance(team); teams[team] = { off: { observed: r.off.w ? r.off.yw / r.off.w : null, sustainable: A.mu + a.off, sd: Math.sqrt(v.off), weight: r.off.w }, def: { observed: r.def.w ? r.def.yw / r.def.w : null, sustainable: A.mu + a.allow, sd: Math.sqrt(v.allow), weight: r.def.w } }; }
    for (const role of ['off', 'def']) {
      const list = Object.entries(teams).sort((a, b) => b[1][role].sustainable - a[1][role].sustainable); list.forEach(([, t], i) => { t[role].rank = i + 1; t[role].of = list.length; });
    }
    fits[key] = { teams, league: A.mu, shrinkage_weight: lam };
  }
  return fits;
}

/* ---------------------------------------------------------------- four-factor decomposition */
/** offensive points per 100 on eFG, TOV%, ORB%, FTR (team-game sides of training seasons): the weights that turn a factor edge into points */
function fourFactorWeights(TG, G, seasons, c) {
  const X = []; const Y = [];
  for (const s of seasons) for (const { r } of sides(TG, G.byId, s, null)) {
    if (!usableSide(r, FACTORS[0])) continue;
    const poss = posOf(r, c); const o = r.o;
    const x = [1, pct(r.fgm + 0.5 * r.tpm, r.fga), pct(r.tov, poss), pct(r.orb, r.orb + o.drb), pct(r.fta, r.fga)];
    if (x.some((v) => !Number.isFinite(v))) continue; X.push(x); Y.push((100 * r.pts) / poss);
  }
  const k = 5; const XtX = new Float64Array(k * k); const Xty = new Float64Array(k);
  for (let i = 0; i < X.length; i++) for (let a = 0; a < k; a++) { Xty[a] += X[i][a] * Y[i]; for (let b = 0; b < k; b++) XtX[a * k + b] += X[i][a] * X[i][b]; }
  const beta = U.cholSolve(U.cholesky(XtX, k), k, Xty);
  let ss = 0; let st = 0; const my = U.mean(Y);
  for (let i = 0; i < X.length; i++) { let p = 0; for (let a = 0; a < k; a++) p += beta[a] * X[i][a]; ss += (Y[i] - p) ** 2; st += (Y[i] - my) ** 2; }
  return { n: X.length, intercept: beta[0], efg: beta[1], tov_pct: beta[2], orb_pct: beta[3], ftr: beta[4], r2: 1 - ss / st, unit: 'points per 100 possessions per 1.00 change in the rate' };
}

module.exports = { FACTORS, POSS_FACTORS, reliability, seasonProfiles, possessionProfiles, fourFactorWeights, sides };
