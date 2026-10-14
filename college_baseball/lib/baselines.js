'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the baselines every model must beat.

     HomeRate   P(home) = the home win rate of the fitting window; neutral = 0.5
     Elo        results only; K, home advantage and between-season regression tuned
     Pythag     season-to-date runs for/against (Pythagenpat exponent from the
                college run environment), log5, home shift; last season regressed
                in as pseudo-games
     Massey     ridge least squares on run margin with home advantage and
                carried priors; P = Phi(margin / residual sd)
     BT         Bradley-Terry: logistic on results with carried priors

   Same interface as the run models: startSeason(s), predict(g) -> {p},
   addGames(games), fit(day). A date's games are predicted before any of them
   is added, so no game informs another on the same date.
   =========================================================================== */
const S = require('../../engine/stats');

function Phi(z) { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y); }

class HomeRate {
  constructor(o) { this.rate = (o && o.rate) || 0.56; this.name = 'home_rate'; }
  startSeason() {} addGames() {} fit() {}
  predict(g) { return { p: g.neutral ? 0.5 : this.rate }; }
}

class Elo {
  constructor(o, meta) {
    this.o = Object.assign({ k: 24, home: 35, carry: 0.7, init: { D1: 1500, D2: 1350, D3: 1250, DX: 1200 } }, o || {});
    this.meta = meta; this.r = new Map(); this.season = null; this.name = 'elo';
  }
  init(id) { const d = this.meta.div(this.season, id); const k = d === 1 || d === 2 || d === 3 ? 'D' + d : 'DX'; return this.o.init[k]; }
  get(id) { if (!this.r.has(id)) this.r.set(id, this.init(id)); return this.r.get(id); }
  startSeason(s) {
    this.season = s;
    /* regress toward the mean of the team's current division */
    for (const [id, v] of this.r) this.r.set(id, this.init(id) + this.o.carry * (v - this.init(id)));
  }
  pr(g) { return 1 / (1 + Math.pow(10, -(this.get(g.home_id) - this.get(g.away_id) + (g.neutral ? 0 : this.o.home)) / 400)); }
  predict(g) { return { p: this.pr(g) }; }
  addGames(games) {
    const upd = games.map((g) => { const p = this.pr(g); const y = g.home_runs > g.away_runs ? 1 : 0; return [g, this.o.k * (y - p)]; });
    for (const [g, d] of upd) { this.r.set(g.home_id, this.get(g.home_id) + d); this.r.set(g.away_id, this.get(g.away_id) - d); }
  }
  fit() {}
}

class Pythag {
  constructor(o, meta) { this.o = Object.assign({ prior_games: 12, carry: 0.6, home_logit: 0.20 }, o || {}); this.meta = meta; this.t = new Map(); this.prev = new Map(); this.lg = 6; this.name = 'pythag'; }
  startSeason(s) {
    this.season = s;
    this.prev = new Map(); for (const [id, v] of this.t) if (v.g > 0) this.prev.set(id, { rs: v.rs / v.g, ra: v.ra / v.g });
    this.t = new Map();
  }
  rec(id) { if (!this.t.has(id)) this.t.set(id, { rs: 0, ra: 0, g: 0 }); return this.t.get(id); }
  wp(id) {
    const v = this.rec(id); const pv = this.prev.get(id); const k = this.o.prior_games; const lg = this.lg;
    /* last season's per-game rates, regressed toward the league, as k pseudo-games */
    const prs = pv ? lg + this.o.carry * (pv.rs - lg) : lg; const pra = pv ? lg + this.o.carry * (pv.ra - lg) : lg;
    const rs = v.rs + k * prs; const ra = v.ra + k * pra; const g = v.g + k;
    const x = Math.pow((rs + ra) / g, 0.287);
    return Math.pow(rs, x) / (Math.pow(rs, x) + Math.pow(ra, x));
  }
  predict(g) {
    const a = this.wp(g.home_id); const b = this.wp(g.away_id);
    const p = a * (1 - b) / (a * (1 - b) + b * (1 - a));
    return { p: S.sigmoid(S.logit(p) + (g.neutral ? 0 : this.o.home_logit)) };
  }
  addGames(games) {
    let rs = 0; let n = 0;
    for (const g of games) {
      const h = this.rec(g.home_id); const a = this.rec(g.away_id);
      h.rs += g.home_runs; h.ra += g.away_runs; h.g++; a.rs += g.away_runs; a.ra += g.home_runs; a.g++;
      rs += g.home_runs + g.away_runs; n += 2;
    }
    if (n) this.lg = 0.98 * this.lg + 0.02 * (rs / n);
  }
  fit() {}
}

/* ridge rating models with carried priors, fitted by coordinate descent */
class Ridge {
  constructor(kind, o, meta) {
    this.kind = kind; this.name = kind;
    this.o = Object.assign({ sigma: kind === 'massey' ? 2.0 : 0.6, carry: 0.6, home: kind === 'massey' ? 0.6 : 0.2, sweeps: 15 }, o || {});
    this.meta = meta; this.r = new Map(); this.prior = new Map(); this.games = []; this.home = this.o.home; this.resid = 5.5;
  }
  startSeason(s) { this.season = s; this.prior = new Map(); for (const [id, v] of this.r) this.prior.set(id, v * this.o.carry); this.r = new Map(this.prior); this.games = []; }
  get(id) { return this.r.get(id) || 0; }
  predict(g) {
    const d = this.get(g.home_id) - this.get(g.away_id) + (g.neutral ? 0 : this.home);
    return { p: this.kind === 'massey' ? Phi(d / this.resid) : S.sigmoid(d), margin: this.kind === 'massey' ? d : null };
  }
  addGames(games) { for (const g of games) this.games.push(g); }
  fit() {
    const o = this.o; const G = this.games; if (!G.length) return;
    const prec = 1 / (o.sigma * o.sigma);
    for (let sw = 0; sw < o.sweeps; sw++) {
      const gr = new Map(); const hs = new Map(); let gh = 0; let hh = 0;
      for (const g of G) {
        const d = this.get(g.home_id) - this.get(g.away_id) + (g.neutral ? 0 : this.home);
        let res; let w;
        if (this.kind === 'massey') { res = (g.home_runs - g.away_runs) - d; w = 1; }
        else { const p = S.sigmoid(d); res = (g.home_runs > g.away_runs ? 1 : 0) - p; w = p * (1 - p); }
        gr.set(g.home_id, (gr.get(g.home_id) || 0) + res); hs.set(g.home_id, (hs.get(g.home_id) || 0) + w);
        gr.set(g.away_id, (gr.get(g.away_id) || 0) - res); hs.set(g.away_id, (hs.get(g.away_id) || 0) + w);
        if (!g.neutral) { gh += res; hh += w; }
      }
      const scale = this.kind === 'massey' ? 1 / (this.resid * this.resid) : 1;
      for (const [id, gg] of gr) {
        const cur = this.get(id); const m = this.prior.get(id) || 0;
        this.r.set(id, cur + (gg * scale - (cur - m) * prec) / (hs.get(id) * scale + prec));
      }
      if (hh > 0) this.home += (gh * scale - (this.home - this.o.home) * 25) / (hh * scale + 25);
    }
    if (this.kind === 'massey') {
      let ss = 0; for (const g of G) { const d = this.get(g.home_id) - this.get(g.away_id) + (g.neutral ? 0 : this.home); ss += Math.pow(g.home_runs - g.away_runs - d, 2); }
      this.resid = Math.sqrt((ss + 20 * 30) / (G.length + 20));   // shrunk toward a 5.5-run residual sd early in a season
    }
  }
}

module.exports = { HomeRate, Elo, Pythag, Ridge, Phi };
