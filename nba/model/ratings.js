'use strict';
/* ===========================================================================
   EdgeDesk NBA — point-in-time team strength, four ways.

   Every class reads only what it has been given: `absorb` adds a finished game
   once the walk-forward says its result is available, `expect` reads the
   current state. Nothing here knows a date in the future.

   MODEL A — Elo (FiveThirtyEight's NBA form; fte_nba): K, home court, the
   season-to-season reversion and the margin-of-victory multiplier
   ((MOV + 3)^0.8 / (7.5 + 0.006·winner's Elo edge)) tuned on the selection
   window only.

   MODEL A' — Glicko (Glickman 1999): each rating carries a deviation RD that
   grows with idle days (c² per day) and over the summer, and shrinks as games
   are played; the update is scaled by RD, so a team returning from a long
   break, or a new season, moves faster. The margin-of-victory multiplier is
   the Elo one. c, the summer inflation and K-equivalent scale are tuned on
   selection.

   MODEL B — Adjusted (opponent-adjusted ratings, the family of Kubatko et al.
   2007 and Pomeroy's adjusted efficiency): for a per-game measure y of team T
   against O, y = L + H·home + a_T + b_O, fitted by exponentially-decayed
   weighted least squares with a ridge pull of k games toward each team's prior
   (last season's value × carry), solved by Gauss-Seidel sweeps warm-started
   from the previous day. Used for offensive and defensive efficiency (points
   per 100 possessions), pace (possessions per 48, a sum model) and the four
   factors (eFG%, turnover rate, offensive rebound rate, free-throw rate), plus
   three-point and rim attempt rates.

   MODEL F — Kalman (a Bayesian dynamic linear model; Glickman & Stern 1998):
   each team's offence and defence (points per 100 possessions against an
   average opponent) is a random walk with daily process variance q; the league
   level and home court are slow states. Each game observes both teams'
   efficiencies with noise variance R·100/possessions. The full 62-state
   covariance is carried, so the predictive variance of a margin includes how
   uncertain the two teams' strengths still are — explicit early-season and
   new-roster uncertainty. Each summer the means revert by `carry` and the
   variances grow by `summer` (both tuned on selection).
   =========================================================================== */

/* ---------------------------------------------------------------- Elo */
class Elo {
  constructor(p) { this.p = Object.assign({ k: 20, hfa: 100, revert: 0.75, mov: 1 }, p || {}); this.r = new Map(); this.season = null; }
  get(id) { return this.r.has(id) ? this.r.get(id) : 1505; }
  startSeason(s) { if (this.season === s) return; if (this.season != null) for (const [id, v] of this.r) this.r.set(id, 1505 * (1 - this.p.revert) + v * this.p.revert); this.season = s; }
  diff(h, a, neutral) { return this.get(h) - this.get(a) + (neutral ? 0 : this.p.hfa); }
  prob(h, a, neutral) { return 1 / (1 + Math.pow(10, -this.diff(h, a, neutral) / 400)); }
  absorb(g) {
    const p = this.prob(g.home_id, g.away_id, g.neutral); const hw = g.hs > g.as ? 1 : 0; const mov = Math.abs(g.hs - g.as);
    const d = this.diff(g.home_id, g.away_id, g.neutral) * (hw ? 1 : -1);
    const mult = this.p.mov ? Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * d) : 1;
    const delta = this.p.k * mult * (hw - p);
    this.r.set(g.home_id, this.get(g.home_id) + delta); this.r.set(g.away_id, this.get(g.away_id) - delta);
  }
}

/* ---------------------------------------------------------------- Glicko */
const Q = Math.LN10 / 400;
class Glicko {
  constructor(p) { this.p = Object.assign({ c: 6, rd0: 200, rdMin: 40, summer: 120, revert: 0.75, hfa: 100, scale: 1 }, p || {}); this.t = new Map(); this.season = null; }
  T(id) { let x = this.t.get(id); if (!x) { x = { r: 1505, rd: this.p.rd0, last: null }; this.t.set(id, x); } return x; }
  startSeason(s) {
    if (this.season === s) return;
    if (this.season != null) for (const x of this.t.values()) { x.r = 1505 * (1 - this.p.revert) + x.r * this.p.revert; x.rd = Math.min(this.p.rd0, Math.sqrt(x.rd * x.rd + this.p.summer * this.p.summer)); x.last = null; }
    this.season = s;
  }
  rdAt(x, day) { if (x.last == null) return x.rd; return Math.min(this.p.rd0, Math.sqrt(x.rd * x.rd + this.p.c * this.p.c * Math.max(0, day - x.last))); }
  static g(rd) { return 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / (Math.PI * Math.PI)); }
  prob(h, a, neutral, day) {
    const H = this.T(h), A = this.T(a); const rd = Math.sqrt(Math.pow(this.rdAt(H, day), 2) + Math.pow(this.rdAt(A, day), 2));
    return 1 / (1 + Math.pow(10, -Glicko.g(rd) * (H.r - A.r + (neutral ? 0 : this.p.hfa)) / 400));
  }
  uncertainty(h, a, day) { return Math.sqrt(Math.pow(this.rdAt(this.T(h), day), 2) + Math.pow(this.rdAt(this.T(a), day), 2)); }
  absorb(g, day) {
    const H = this.T(g.home_id), A = this.T(g.away_id);
    const rdH = this.rdAt(H, day), rdA = this.rdAt(A, day);
    const hw = g.hs > g.as ? 1 : 0; const mov = Math.abs(g.hs - g.as);
    const edge = (H.r - A.r + (g.neutral ? 0 : this.p.hfa)) * (hw ? 1 : -1);
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * edge);
    const upd = (X, rdX, rdO, rO, s, hfaSign) => {
      const gO = Glicko.g(rdO); const E = 1 / (1 + Math.pow(10, -gO * (X.r - rO + hfaSign * (g.neutral ? 0 : this.p.hfa)) / 400));
      const d2 = 1 / (Q * Q * gO * gO * E * (1 - E));
      const denom = 1 / (rdX * rdX) + 1 / d2;
      return { r: X.r + this.p.scale * mult * (Q / denom) * gO * (s - E), rd: Math.max(this.p.rdMin, Math.sqrt(1 / denom)) };
    };
    const nh = upd(H, rdH, rdA, A.r, hw, 1), na = upd(A, rdA, rdH, H.r, 1 - hw, -1);
    H.r = nh.r; H.rd = nh.rd; H.last = day; A.r = na.r; A.rd = na.rd; A.last = day;
  }
}

/* ---------------------------------------------------------------- Adjusted (GS-WLS) */
class Adjusted {
  /**
   * mode 'offdef': y_TO = L + H·home + a_T + b_O   (a = own effect, b = what O allows)
   * mode 'sum':    y_TO = L + a_T + a_O            (pace: both teams push the same number)
   */
  constructor(name, mode, p) {
    this.name = name; this.mode = mode;
    this.p = Object.assign({ half_life_days: 45, prior_games: 6, carry: 0.6, sweeps: 2, k_l: 30, home: mode === 'offdef' }, p || {});
    this.team = new Map(); this.obs = []; this.L = null; this.Lprior = null; this.H = 0; this.Hprior = 0; this.season = null;
  }
  T(id) { let t = this.team.get(id); if (!t) { t = { a: 0, b: 0, pa: 0, pb: 0, ia: [], ib: [] }; this.team.set(id, t); } return t; }
  startSeason(s) {
    if (this.season === s) return;
    for (const t of this.team.values()) { t.pa = t.a * this.p.carry; t.pb = t.b * this.p.carry; t.a = t.pa; t.b = t.pb; t.ia = []; t.ib = []; }
    this.obs = []; if (this.L != null) this.Lprior = this.L; this.Hprior = this.H; this.season = s;
  }
  /** add observations: [{ t: teamId, o: oppId, y, w, home: +1/-1/0 }] at fractional day `day` */
  add(day, rows) {
    for (const r of rows) {
      if (r.y == null || !isFinite(r.y)) continue;
      const i = this.obs.length; this.obs.push({ day, t: r.t, o: r.o, y: r.y, w: r.w == null ? 1 : r.w, home: r.home || 0 });
      this.T(r.t).ia.push(i); this.T(r.o).ib.push(i);
      if (this.L == null) this.L = r.y;
    }
  }
  refit(day) {
    const P = this.p, O = this.obs; if (!O.length) return;
    const lam = Math.LN2 / P.half_life_days; const w = new Float64Array(O.length);
    for (let i = 0; i < O.length; i++) w[i] = O[i].w * Math.exp(-lam * Math.max(0, day - O[i].day));
    const Lp = this.Lprior == null ? this.L : this.Lprior;
    for (let s = 0; s < P.sweeps; s++) {
      for (const t of this.team.values()) {
        if (this.mode === 'offdef') {
          if (t.ia.length) { let sy = 0, sw = 0; for (const i of t.ia) { const x = O[i]; sy += w[i] * (x.y - this.L - this.H * x.home - this.T(x.o).b); sw += w[i]; } t.a = (sy + P.prior_games * t.pa) / (sw + P.prior_games); }
          if (t.ib.length) { let sy = 0, sw = 0; for (const i of t.ib) { const x = O[i]; sy += w[i] * (x.y - this.L - this.H * x.home - this.T(x.t).a); sw += w[i]; } t.b = (sy + P.prior_games * t.pb) / (sw + P.prior_games); }
        } else {
          const idx = t.ia.concat(t.ib); if (!idx.length) continue;
          let sy = 0, sw = 0; for (const i of t.ia) { const x = O[i]; sy += w[i] * (x.y - this.L - this.T(x.o).a); sw += w[i]; }
          for (const i of t.ib) { const x = O[i]; sy += w[i] * (x.y - this.L - this.T(x.t).a); sw += w[i]; }
          t.a = (sy + P.prior_games * t.pa) / (sw + P.prior_games);
        }
      }
      let sl = 0, slw = 0, sh = 0, shw = 0;
      for (let i = 0; i < O.length; i++) {
        const x = O[i];
        const fit = this.mode === 'offdef' ? this.T(x.t).a + this.T(x.o).b : this.T(x.t).a + this.T(x.o).a;
        sl += w[i] * (x.y - fit - this.H * x.home); slw += w[i];
        if (this.p.home && x.home) { sh += w[i] * x.home * (x.y - fit - this.L); shw += w[i]; }
      }
      this.L = Lp == null ? sl / slw : (sl + P.k_l * Lp) / (slw + P.k_l);
      if (this.p.home) this.H = (sh + 200 * this.Hprior) / (shw + 200);
    }
  }
  /** expected y for team t against o (home: +1 at home, -1 away, 0 neutral) */
  expect(t, o, home) {
    const L = this.L == null ? 0 : this.L;
    if (this.mode === 'offdef') return L + this.H * (home || 0) + this.T(t).a + this.T(o).b;
    return L + this.T(t).a + this.T(o).a;
  }
  games(t) { const x = this.team.get(t); return x ? x.ia.length : 0; }
}

/* ---------------------------------------------------------------- Kalman (Bayesian DLM) */
class Kalman {
  constructor(p) {
    this.p = Object.assign({ q: 0.08, R: 14000, carry: 0.6, summer: 6, v0: 16, qL: 0.002, vL0: 4, vH0: 1 }, p || {});
    this.idx = new Map(); this.n = 2; /* 0 = league level offset, 1 = home court */
    this.m = [0, 1.5]; this.P = [[this.p.vL0, 0], [0, this.p.vH0]]; this.last = null; this.season = null; this.base = null;
  }
  ensure(id) {
    if (this.idx.has(id)) return this.idx.get(id);
    const i = this.n; this.idx.set(id, i); this.n += 2;
    for (const row of this.P) row.push(0, 0);
    this.P.push(new Array(this.n).fill(0), new Array(this.n).fill(0));
    this.P[i][i] = this.p.v0; this.P[i + 1][i + 1] = this.p.v0; this.m.push(0, 0);
    return i;
  }
  advance(day) {
    if (this.last == null) { this.last = day; return; }
    const dt = Math.max(0, day - this.last); if (!dt) return;
    for (let i = 2; i < this.n; i++) this.P[i][i] += this.p.q * dt;
    this.P[0][0] += this.p.qL * dt;
    this.last = day;
  }
  startSeason(s) {
    if (this.season === s) return;
    if (this.season != null) {
      const c = this.p.carry;
      for (let i = 2; i < this.n; i++) { this.m[i] *= c; for (let j = 0; j < this.n; j++) { this.P[i][j] *= (j >= 2 ? c : Math.sqrt(c)); this.P[j][i] = this.P[i][j]; } }
      for (let i = 2; i < this.n; i++) this.P[i][i] += this.p.summer;
      this.P[0][0] += 1;
    }
    this.season = s;
  }
  /* y = base + m0 + hsign·m1 + o_T + b_O ; offence o at i, defence-allowed b at i+1 */
  H(t, o, home) { const it = this.ensure(t), io = this.ensure(o); const h = new Map([[0, 1], [it, 1], [io + 1, 1]]); if (home) h.set(1, 0.5 * home); return h; }
  predictY(t, o, home) { const h = this.H(t, o, home); let s = this.base == null ? 0 : this.base; for (const [k, v] of h) s += v * this.m[k]; return s; }
  /** Var(a'm) for a sparse coefficient map */
  quadVar(a) { let s = 0; for (const [i, vi] of a) for (const [j, vj] of a) s += vi * vj * this.P[i][j]; return s; }
  update(t, o, home, y, poss) {
    if (this.base == null) this.base = y;
    const h = this.H(t, o, home);
    const yhat = this.predictY(t, o, home);
    const R = this.p.R / Math.max(60, poss);
    const Ph = new Array(this.n).fill(0);
    for (let i = 0; i < this.n; i++) { let s = 0; for (const [k, v] of h) s += this.P[i][k] * v; Ph[i] = s; }
    let S = R; for (const [k, v] of h) S += v * Ph[k];
    const e = y - yhat;
    for (let i = 0; i < this.n; i++) this.m[i] += Ph[i] * e / S;
    for (let i = 0; i < this.n; i++) { const a = Ph[i] / S; if (!a) continue; const row = this.P[i]; for (let j = 0; j < this.n; j++) row[j] -= a * Ph[j]; }
  }
  /** expected efficiency gap (home − away, per 100) with its state variance */
  expectGap(h, a, neutral) {
    const sgn = neutral ? 0 : 1;
    const hh = this.H(h, a, sgn), aa = this.H(a, h, -sgn);
    const diff = new Map();
    for (const [k, v] of hh) diff.set(k, (diff.get(k) || 0) + v);
    for (const [k, v] of aa) diff.set(k, (diff.get(k) || 0) - v);
    let mu = 0; for (const [k, v] of diff) mu += v * this.m[k];
    const sum = new Map(); for (const [k, v] of hh) sum.set(k, (sum.get(k) || 0) + v); for (const [k, v] of aa) sum.set(k, (sum.get(k) || 0) + v);
    let ms = 2 * (this.base || 0); for (const [k, v] of sum) ms += v * this.m[k];
    return { gap: mu, var_gap: this.quadVar(diff), sum: ms, var_sum: this.quadVar(sum) };
  }
}

module.exports = { Elo, Glicko, Adjusted, Kalman };
