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

   D1 FIX (`d1_fix`, men's and women's college only; docs/model-loop/
   audit_report.md, CBB items 5-6). The college schedules include every game a
   Division I team plays, so a non-D1 visitor appears once or twice a season
   and was rated like an ordinary team shrunk toward the D1 average. Its
   40-point losses then did two things: they inflated the D1 teams that beat it,
   and, because nearly all of them are home games, they pumped the fitted home
   advantage h to 7-9 points every November. With the fix:
     - a team counts as D1 in season S if it played >= d1_prev_min games in
       S-1 or has played >= d1_cur_min games so far in S (a non-D1 visitor
       never gets there); both are point-in-time;
     - h and mu are fitted on D1-vs-D1 games only;
     - a team that is not (yet) D1 starts from the learned non-D1 rating,
       pulled with nd1_prior_games of weight instead of prior_games. Only the
       NET strength is learned (the average o + d of last season's non-D1
       teams) and it is split evenly, o = d = net / 2: one or two games a
       season cannot tell a non-D1 team's scoring level from its defence, and
       learning both let the pair walk without limit. The first season's
       seed is 15 points below average at both ends (d is points prevented,
       so a weak defence is negative);
     - at each season start the D1 ratings are re-centred (mean o = mean d
       = 0 over last season's D1 teams, the shift moved into mu), because the
       learned non-D1 prior is otherwise free to walk the whole scale: mu
       and the o/d levels are only identified by the priors.
   Off by default: the NBA and WNBA compute exactly what they did.
   =========================================================================== */

const DEFAULTS = { half_life_days: 60, prior_games: 4, carry: 0.6, sweeps: 3, k_mu: 40, k_h: 150,
  d1_fix: false, d1_prev_min: 10, d1_cur_min: 6, nd1_prior_games: 6, nd1_init: { o: -15, d: -15 } };

function dayNum(date) { return Math.floor(Date.parse(date + 'T12:00:00Z') / 864e5); }

class PointsRatings {
  constructor(params) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.team = new Map();     /* id -> { o, d, po, pd, idx: [game indexes this season] } */
    this.games = [];           /* this season: { day, h, a, yh, ya, n } */
    this.mu = null; this.h = 3; this.muPrior = null; this.hPrior = 3;
    this.season = null;
    this.nd1 = Object.assign({}, this.p.nd1_init);   /* the learned non-D1 rating (d1_fix) */
  }
  T(id) {
    let t = this.team.get(id);
    if (!t) {
      t = { o: 0, d: 0, po: 0, pd: 0, idx: [], prevN: 0 };
      if (this.p.d1_fix) { t.po = this.nd1.o; t.pd = this.nd1.d; t.o = t.po; t.d = t.pd; }
      this.team.set(id, t);
    }
    return t;
  }
  /** D1 at this moment: enough games last season, or enough so far this season */
  isD1(t) { return t.prevN >= this.p.d1_prev_min || t.idx.length >= this.p.d1_cur_min; }
  startSeason(season) {
    if (this.season === season) return;
    if (this.p.d1_fix && this.season != null) {
      /* re-centre on last season's D1 teams: ph = mu + o_h - d_a is unchanged
         when every o drops by co and mu rises by co, or every d drops by cd and
         mu drops by cd */
      let co = 0, cd = 0, m = 0;
      for (const t of this.team.values()) if (t.idx.length && this.isD1(t)) { co += t.o; cd += t.d; m++; }
      if (m) {
        co /= m; cd /= m;
        for (const t of this.team.values()) { t.o -= co; t.d -= cd; }
        if (this.mu != null) this.mu += co - cd;
      }
      /* last season's non-D1 teams' average net strength becomes this season's non-D1 prior */
      let sn = 0, n = 0;
      for (const t of this.team.values()) if (t.idx.length && !this.isD1(t)) { sn += t.o + t.d; n++; }
      if (n >= 10) this.nd1 = { o: sn / n / 2, d: sn / n / 2 };
      (this.trace || (this.trace = [])).push({ season: this.season, mu: +this.mu.toFixed(3), h: +this.h.toFixed(3), d1_shift: { o: +co.toFixed(3), d: +cd.toFixed(3) }, nd1: { o: +this.nd1.o.toFixed(3), d: +this.nd1.d.toFixed(3) }, non_d1_teams: n });
    }
    for (const t of this.team.values()) {
      t.prevN = t.idx.length;
      if (this.p.d1_fix && t.prevN < this.p.d1_prev_min) { t.po = this.nd1.o; t.pd = this.nd1.d; }
      else { t.po = t.o * this.p.carry; t.pd = t.d * this.p.carry; }
      t.o = t.po; t.d = t.pd; t.idx = [];
    }
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
        const k = P.d1_fix && !this.isD1(t) ? P.nd1_prior_games : P.prior_games;
        t.o = (so + k * t.po) / (sw + k);
        t.d = (sd + k * t.pd) / (sw + k);
      }
      /* mu and h, each pulled toward last season's value */
      let sm = 0, smw = 0, shh = 0, shw = 0;
      for (let i = 0; i < G.length; i++) {
        const g = G[i]; const H = this.team.get(g.h), A = this.team.get(g.a);
        if (P.d1_fix && !(this.isD1(H) && this.isD1(A))) continue;
        const base = (H.o - A.d + A.o - H.d);
        sm += w[i] * ((g.yh + g.ya - base) / 2); smw += w[i];
        if (!g.n) { shh += w[i] * ((g.yh - g.ya) - (H.o - A.d - A.o + H.d)); shw += w[i]; }
      }
      if (smw > 0) this.mu = muP == null ? sm / smw : (sm + P.k_mu * muP) / (smw + P.k_mu);
      this.h = (shh + P.k_h * this.hPrior) / (shw + P.k_h);
    }
  }
  /** the ratings as a plain object (the slate's input) */
  dump() {
    const t = {};
    for (const [id, v] of this.team) {
      t[id] = { o: +v.o.toFixed(3), d: +v.d.toFixed(3), games: v.idx.length };
      if (this.p.d1_fix) { t[id].d1 = this.isD1(v); t[id].prev_games = v.prevN; }
    }
    const out = { mu: +this.mu.toFixed(3), h: +this.h.toFixed(3), season: this.season, teams: t };
    if (this.p.d1_fix) out.nd1 = { o: +this.nd1.o.toFixed(3), d: +this.nd1.d.toFixed(3) };
    return out;
  }
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
