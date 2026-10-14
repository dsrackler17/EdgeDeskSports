'use strict';
/* ===========================================================================
   One opponent-adjusted fitter for every team rating.

   Each observation is one side of one game: an offense facing a defense,

     y = mu + off[o] + allow[d] + eta * v        v = +1 home, -1 away, 0 neutral

   with weight w (possessions for efficiency, attempts for a shooting rate,
   chances for a rebound rate), so a 90-possession game counts more than a
   55-possession one and a 3-of-4 night counts for little. `allow` is what a
   defense concedes against an average offense (positive = concedes more), so
   the adjusted offense is mu + off and the adjusted defense mu + allow, on
   the scale of y. This is the additive, opponent-adjusted least-squares
   family (Massey; the additive form KenPom describes moving to; Torvik's and
   KenPom's published ratings are multiplicative variants), not either of
   their private formulas.

   Fitted by weighted ridge least squares toward per-team priors (strength
   lambda, in weight units: lambda = 600 possessions means a prior worth about
   nine average games), with recency weights and Gauss-Seidel sweeps that are
   warm-started, so refitting every game day of a season is cheap.

   Posterior variance: var(off) ~= s2 / (sum of the team's weights + lambda),
   the diagonal of the ridge posterior with the residual variance s2 per unit
   weight. It ignores the covariance with opponents' estimates, so it is a
   lower bound early in a season; game-level uncertainty is recalibrated on
   out-of-sample residuals before any probability is published.

   center: re-centre off and allow to mean zero after each sweep (used when
   the priors carry no information and lambda is small, so mu is identified).
   =========================================================================== */

class Additive {
  /** o: { lambdaOff, lambdaAllow, kMu, kEta, eta0, sweeps } */
  constructor(o) {
    this.o = Object.assign({ lambdaOff: 600, lambdaAllow: 600, kMu: 2000, kEta: 4000, eta0: 0, sweeps: 6, etaFixed: false, center: false }, o || {});
    this.idx = new Map(); this.ids = [];
    this.off = []; this.allow = []; this.pOff = []; this.pAllow = []; this.byTeamOff = []; this.byTeamDef = [];
    this.wOffSum = []; this.wDefSum = [];
    this.obs = { o: [], d: [], y: [], w: [], v: [], day: [] };
    this.mu = null; this.muPrior = null; this.eta = this.o.eta0; this.etaPrior = this.o.eta0; this.s2 = null;
  }
  team(id) {
    let i = this.idx.get(id);
    if (i == null) { i = this.ids.length; this.idx.set(id, i); this.ids.push(id); this.off.push(0); this.allow.push(0); this.pOff.push(0); this.pAllow.push(0); this.byTeamOff.push([]); this.byTeamDef.push([]); this.wOffSum.push(0); this.wDefSum.push(0); }
    return i;
  }
  setPrior(id, pOff, pAllow) { const i = this.team(id); this.pOff[i] = pOff; this.pAllow[i] = pAllow; if (!this.byTeamOff[i].length) { this.off[i] = pOff; this.allow[i] = pAllow; } }
  setMuPrior(mu) { this.muPrior = mu; if (this.mu == null) this.mu = mu; }
  setEtaPrior(eta) { this.etaPrior = eta; this.eta = eta; }
  add(offId, defId, y, w, v, day) {
    if (!Number.isFinite(y) || !(w > 0)) return;
    const o = this.team(offId); const d = this.team(defId); const k = this.obs.y.length;
    this.obs.o.push(o); this.obs.d.push(d); this.obs.y.push(y); this.obs.w.push(w); this.obs.v.push(v); this.obs.day.push(day);
    this.byTeamOff[o].push(k); this.byTeamDef[d].push(k);
    if (this.mu == null) this.mu = y;
  }
  /** weights: w * recency(day - obs.day); recency(age) = 2^(-age/halfLife), or 1 */
  fit(day, halfLife, sweeps) {
    const O = this.obs; const n = O.y.length; if (!n) return;
    const lam = halfLife && Number.isFinite(halfLife) ? Math.LN2 / halfLife : 0;
    const W = new Float64Array(n);
    for (let k = 0; k < n; k++) W[k] = O.w[k] * (lam ? Math.exp(-lam * Math.max(0, day - O.day[k])) : 1);
    const { lambdaOff, lambdaAllow, kMu, kEta } = this.o;
    const S = sweeps || this.o.sweeps;
    for (let s = 0; s < S; s++) {
      for (let t = 0; t < this.ids.length; t++) {
        let num = lambdaOff * this.pOff[t]; let den = lambdaOff;
        for (const k of this.byTeamOff[t]) { num += W[k] * (O.y[k] - this.mu - this.allow[O.d[k]] - this.eta * O.v[k]); den += W[k]; }
        this.off[t] = num / den; this.wOffSum[t] = den - lambdaOff;
        num = lambdaAllow * this.pAllow[t]; den = lambdaAllow;
        for (const k of this.byTeamDef[t]) { num += W[k] * (O.y[k] - this.mu - this.off[O.o[k]] - this.eta * O.v[k]); den += W[k]; }
        this.allow[t] = num / den; this.wDefSum[t] = den - lambdaAllow;
      }
      if (this.o.center) { // identify mu: off and allow average zero over teams with data
        let so = 0; let sa = 0; let no = 0; let na = 0;
        for (let t = 0; t < this.ids.length; t++) { if (this.byTeamOff[t].length) { so += this.off[t]; no++; } if (this.byTeamDef[t].length) { sa += this.allow[t]; na++; } }
        const mo = no ? so / no : 0; const ma = na ? sa / na : 0;
        for (let t = 0; t < this.ids.length; t++) { this.off[t] -= mo; this.allow[t] -= ma; }
        this.mu += mo + ma;
      }
      let sm = 0; let sw = 0; let se = 0; let sev = 0;
      for (let k = 0; k < n; k++) {
        const base = O.y[k] - this.off[O.o[k]] - this.allow[O.d[k]];
        sm += W[k] * (base - this.eta * O.v[k]); sw += W[k];
        if (O.v[k]) { se += W[k] * O.v[k] * (base - this.mu); sev += W[k] * O.v[k] * O.v[k]; }
      }
      this.mu = this.muPrior == null ? sm / sw : (sm + kMu * this.muPrior) / (sw + kMu);
      if (!this.o.etaFixed) this.eta = (se + kEta * this.etaPrior) / (sev + kEta);
    }
    let rss = 0;
    for (let k = 0; k < n; k++) { const e = O.y[k] - this.predictIdx(O.o[k], O.d[k], O.v[k]); rss += O.w[k] * e * e; }
    this.s2 = rss / Math.max(1, n - this.ids.length);
  }
  predictIdx(o, d, v) { return this.mu + this.off[o] + this.allow[d] + this.eta * v; }
  predict(offId, defId, v) {
    const o = this.idx.get(offId); const d = this.idx.get(defId);
    const off = o == null ? 0 : this.off[o]; const al = d == null ? 0 : this.allow[d];
    return (this.mu == null ? NaN : this.mu) + off + al + this.eta * v;
  }
  /** the posterior-variance approximation for a team's off and allow */
  variance(id) {
    const i = this.idx.get(id); const s2 = this.s2 == null ? NaN : this.s2;
    if (i == null) return { off: s2 / this.o.lambdaOff, allow: s2 / this.o.lambdaAllow, n_off: 0, n_def: 0 };
    return { off: s2 / (this.wOffSum[i] + this.o.lambdaOff), allow: s2 / (this.wDefSum[i] + this.o.lambdaAllow), n_off: this.byTeamOff[i].length, n_def: this.byTeamDef[i].length };
  }
  rating(id) { const i = this.idx.get(id); return i == null ? null : { off: this.off[i], allow: this.allow[i] }; }
}

module.exports = { Additive };
