'use strict';
/* ===========================================================================
   EdgeDesk basketball — point-in-time points ratings, and the Elo baseline.

   POINTS RATINGS (the brain). Each team has an offence rating o and a defence
   rating d, in points per game against the league average:

     home points = mu + h/2 + o_home - d_away      (h = 0 at a neutral site)
     away points = mu - h/2 + o_away - d_home

   fitted to every game of the season so far by weighted least squares with
   exponentially decaying weights (half-life H days) and a ridge pull of
   strength k games toward each team's prior (its rating at the end of last
   season times the carry r; 0 for a new team). This is Massey's least-squares
   rating split into offence and defence (Massey 1997; the adjusted-efficiency
   family of Pomeroy and Kubatko et al. 2007), solved by Gauss-Seidel sweeps
   warm-started from the previous day, so a whole season costs a few sweeps per
   game date. mu and h are fitted with the teams, each pulled toward last
   season's value.

   Margin = home points - away points; total = their sum. Win, cover and total
   probabilities come from walkforward.js's calibration, fitted only on earlier
   seasons' out-of-sample predictions.

   ELO (baseline): FiveThirtyEight's NBA form — K, home advantage and the
   season-to-season reversion tuned on the selection window; margin-of-victory
   multiplier ((MOV + 3)^0.8) / (7.5 + 0.006 · Elo difference of the winner).

   Point in time: expect() reads the state; absorbDay(day, games) adds games
   whose results are available and refits with weights aged to `day` (a
   fractional day number). The walk-forward decides what is available when.
   =========================================================================== */

const DEFAULTS = { half_life_days: 60, prior_games: 4, carry: 0.6, sweeps: 3, k_mu: 40, k_h: 150 };

function dayNum(date) { return Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5); }

class PointsRatings {
  constructor(params) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.team = new Map();     /* id -> { o, d, po, pd, idx: [game indexes this season] } */
    this.games = [];           /* this season: { day, h, a, yh, ya, n } */
    this.mu = null; this.h = 3; this.muPrior = null; this.hPrior = 3;
    this.season = null;
  }
  T(id) {
    let t = this.team.get(id);
    if (!t) { t = { o: 0, d: 0, po: 0, pd: 0, idx: [] }; this.team.set(id, t); }
    return t;
  }
  startSeason(season) {
    if (this.season === season) return;
    for (const t of this.team.values()) { t.po = t.o * this.p.carry; t.pd = t.d * this.p.carry; t.o = t.po; t.d = t.pd; t.idx = []; }
    this.games = [];
    if (this.mu != null) this.muPrior = this.mu;
    this.hPrior = this.h;
    this.season = season;
  }
  /** expected points of both sides; neutral = 1 removes home advantage */
  expect(h, a, neutral) {
    const H = this.T(h), A = this.T(a);
    const mu = this.mu == null ? 100 : this.mu, hh = neutral ? 0 : this.h / 2;
    const ph = mu + hh + H.o - A.d, pa = mu - hh + A.o - H.d;
    return { ph, pa, margin: ph - pa, total: ph + pa, games_h: H.idx.length, games_a: A.idx.length };
  }
  absorbDay(day, games) {
    for (const g of games) {
      const i = this.games.length;
      this.games.push({ day, h: g.home_id, a: g.away_id, yh: g.hs, ya: g.as, n: g.neutral ? 1 : 0 });
      this.T(g.home_id).idx.push(i); this.T(g.away_id).idx.push(i);
      if (this.mu == null) this.mu = (g.hs + g.as) / 2;
    }
    this.refit(day);
  }
  refit(day) {
    const P = this.p, G = this.games;
    const lam = Math.LN2 / P.half_life_days;
    const w = new Float64Array(G.length);
    for (let i = 0; i < G.length; i++) w[i] = Math.exp(-lam * (day - G[i].day));
    const muP = this.muPrior == null ? this.mu : this.muPrior;
    for (let s = 0; s < P.sweeps; s++) {
      for (const [id, t] of this.team) {
        if (!t.idx.length) continue;
        let so = 0, sd = 0, sw = 0;
        for (const i of t.idx) {
          const g = G[i]; const wi = w[i]; const hh = g.n ? 0 : this.h / 2;
          if (g.h === id) { const A = this.team.get(g.a); so += wi * (g.yh - this.mu - hh + A.d); sd += wi * (this.mu - hh + A.o - g.ya); }
          else { const H = this.team.get(g.h); so += wi * (g.ya - this.mu + hh + H.d); sd += wi * (this.mu + hh + H.o - g.yh); }
          sw += wi;
        }
        t.o = (so + P.prior_games * t.po) / (sw + P.prior_games);
        t.d = (sd + P.prior_games * t.pd) / (sw + P.prior_games);
      }
      /* mu and h, each pulled toward last season's value */
      let sm = 0, smw = 0, shh = 0, shw = 0;
      for (let i = 0; i < G.length; i++) {
        const g = G[i]; const H = this.team.get(g.h), A = this.team.get(g.a);
        const base = (H.o - A.d + A.o - H.d);
        sm += w[i] * ((g.yh + g.ya - base) / 2); smw += w[i];
        if (!g.n) { shh += w[i] * ((g.yh - g.ya) - (H.o - A.d - A.o + H.d)); shw += w[i]; }
      }
      this.mu = muP == null ? sm / smw : (sm + P.k_mu * muP) / (smw + P.k_mu);
      this.h = (shh + P.k_h * this.hPrior) / (shw + P.k_h);
    }
  }
  /** the ratings as a plain object (the slate's input) */
  dump() { const t = {}; for (const [id, v] of this.team) t[id] = { o: +v.o.toFixed(3), d: +v.d.toFixed(3), games: v.idx.length }; return { mu: +this.mu.toFixed(3), h: +this.h.toFixed(3), season: this.season, teams: t }; }
}

class Elo {
  constructor(p) { this.p = Object.assign({ k: 20, hfa: 100, revert: 0.75 }, p || {}); this.r = new Map(); this.season = null; }
  get(id) { return this.r.has(id) ? this.r.get(id) : 1500; }
  startSeason(season) { if (this.season === season) return; if (this.season != null) for (const [id, v] of this.r) this.r.set(id, 1505 * (1 - this.p.revert) + v * this.p.revert); this.season = season; }
  prob(h, a, neutral) { const d = this.get(h) - this.get(a) + (neutral ? 0 : this.p.hfa); return 1 / (1 + Math.pow(10, -d / 400)); }
  absorb(g) {
    const p = this.prob(g.home_id, g.away_id, g.neutral);
    const hw = g.hs > g.as ? 1 : 0; const mov = Math.abs(g.hs - g.as);
    const diff = (this.get(g.home_id) - this.get(g.away_id) + (g.neutral ? 0 : this.p.hfa)) * (hw ? 1 : -1);
    const mult = Math.pow(mov + 3, 0.8) / (7.5 + 0.006 * diff);
    const delta = this.p.k * mult * (hw - p);
    this.r.set(g.home_id, this.get(g.home_id) + delta); this.r.set(g.away_id, this.get(g.away_id) - delta);
  }
}

module.exports = { PointsRatings, Elo, DEFAULTS, dayNum };
