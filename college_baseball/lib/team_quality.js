'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the team quality engine (Models 1 and 3).

   RUNS, OPPONENT-ADJUSTED, PARTIALLY POOLED.
     log E[runs scored by B against P] = mu
        + off(B)  - def(P)                      team strength, split in two
        + hb*[B at home] - hp*[P at home]       home advantage, non-neutral only
        + park(game)                            the venue, shrunk to 0
   with each team's offence and defence decomposed hierarchically
        off(B) = offDiv(d) + offConf(c) + offTeam(B)
   and Gaussian priors at every level:
        offTeam ~ N(carried mean, sigma_team^2)     carried from last season, regressed
        offConf ~ N(carried mean, sigma_conf^2)
        offDiv  ~ N(carried mean, sigma_div^2)      D-I fixed at 0 (the reference)
        park    ~ N(carried park, sigma_park^2)
   The fit is the MAP (block-coordinate Newton on a quasi-Poisson likelihood
   with dispersion phi and optional recency weights), warm-started from the
   previous date, so a daily refit costs a few passes over one season's games.
   `hier: false` drops the conference and division levels (Model 1, flat).

   WHY THE HIERARCHY. A team that piles up runs against a weak conference
   should not look like one that does it against an elite one. Conference
   strength is identified only by non-conference games; the hierarchy makes a
   team's rating "its conference's strength + its standing inside it", and the
   uncertainty of each part is tracked separately.

   SIGNS. off raises the runs a team scores; def LOWERS the runs it allows, so
   a team's net strength is off + def (log runs, vs an average opponent).

   UNCERTAINTY (Laplace, connectivity-aware). For each team the posterior
   variance of its net strength (off + def, log scale) is approximated as
        var(team deviation)  = 1 / (Fisher information from its games + prior precision)
      + var(conference net)  = 1 / (information from the conference's NON-conference games + prior precision)
   so a team in a conference with few out-of-conference games is uncertain
   even after forty games. Within a conference game the conference term
   cancels, exactly as it should.

   REALIGNMENT. A program's prior at a season boundary is its total strength
   last season, regressed toward the mean of the conference it is in NOW.
   =========================================================================== */
const DEFAULTS = {
  sigma_team: 0.18, sigma_conf: 0.10, sigma_div: 0.30, sigma_park: 0.08,
  carry_team: 0.60, carry_conf: 0.85, carry_div: 0.95, carry_park: 1.0,
  phi: 1.8, halflife_days: 0, max_sweeps: 30, tol: 2e-4, hier: true, parks: true,
  cont_k: 0,                          // roster continuity: 0 = off (see startSeason)
  sp_k: 0,                            // projected starters: 0 = off (see predict)
  pl_k: 0,                            // platoon, the projected starter's hand against the opposing nine: 0 = off
};

class Index {
  constructor() { this.map = new Map(); this.keys = []; }
  get(k) { let i = this.map.get(k); if (i === undefined) { i = this.keys.length; this.map.set(k, i); this.keys.push(k); } return i; }
  has(k) { return this.map.has(k); }
  find(k) { const i = this.map.get(k); return i === undefined ? -1 : i; }
  get size() { return this.keys.length; }
}
function grow(arr, n, fill) { while (arr.length < n) arr.push(fill || 0); return arr; }

class TeamQuality {
  constructor(opts, meta) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.meta = meta;                 // {conf(season,id), div(season,id)}
    this.season = null;
    this.T = new Index(); this.Cf = new Index(); this.Dv = new Index(); this.Pk = new Index();
    this.mu = Math.log(6); this.hb = 0.04; this.hp = 0.04;
    this.oT = []; this.dT = []; this.oC = []; this.dC = []; this.oD = []; this.dD = []; this.pk = [];
    this.pr = null;
    this.teamConf = []; this.teamDiv = [];
    this.obs = { B: [], P: [], y: [], hb: [], hp: [], pk: [], day: [], same: [] };
    this.info = null;
    this.Dv.get('D1');   // index 0: the reference, fixed at 0
  }

  groupOf(season, id) {
    const div = this.meta.div(season, id); const conf = this.meta.conf(season, id);
    const d = div === 1 || div === 2 || div === 3 ? 'D' + div : 'DX';
    return { d, c: conf ? 'C:' + conf : 'C:none_' + d };
  }
  team(id) {
    const i = this.T.get(id);
    grow(this.oT, i + 1); grow(this.dT, i + 1);
    if (this.pr) { grow(this.pr.oT, i + 1); grow(this.pr.dT, i + 1); }
    if (this.teamConf[i] === undefined) {
      const g = this.groupOf(this.season, id);
      this.teamConf[i] = this.Cf.get(g.c); this.teamDiv[i] = this.Dv.get(g.d);
      grow(this.oC, this.Cf.size); grow(this.dC, this.Cf.size); grow(this.oD, this.Dv.size); grow(this.dD, this.Dv.size);
      if (this.pr) { grow(this.pr.oC, this.Cf.size); grow(this.pr.dC, this.Cf.size); grow(this.pr.oD, this.Dv.size); grow(this.pr.dD, this.Dv.size); }
    }
    return i;
  }
  park(key) {
    if (!this.o.parks || !key) return -1;
    const i = this.Pk.get(key); grow(this.pk, i + 1); if (this.pr) grow(this.pr.pk, i + 1);
    return i;
  }
  offOf(i) { return this.oD[this.teamDiv[i]] + this.oC[this.teamConf[i]] + this.oT[i]; }
  defOf(i) { return this.dD[this.teamDiv[i]] + this.dC[this.teamConf[i]] + this.dT[i]; }

  /* ------------------------------------------------------------ season boundary */
  startSeason(season) {
    const o = this.o; const prevSeason = this.season;
    /* last season's totals, by team, before memberships change */
    const prevTotals = [];
    if (prevSeason != null) for (let i = 0; i < this.T.size; i++) prevTotals[i] = [this.offOf(i), this.defOf(i)];
    this.season = season;
    const pr = {
      mu: this.mu, hb: this.hb, hp: this.hp,
      oD: this.oD.map((v) => v * o.carry_div), dD: this.dD.map((v) => v * o.carry_div),
      oC: this.oC.map((v) => v * o.carry_conf), dC: this.dC.map((v) => v * o.carry_conf),
      pk: this.pk.map((v) => v * o.carry_park), oT: [], dT: [],
    };
    this.pr = pr;
    /* memberships for the new season */
    this.teamConf = []; this.teamDiv = [];
    for (let i = 0; i < this.T.size; i++) {
      const g = this.groupOf(season, this.T.keys[i]);
      this.teamConf[i] = this.Cf.get(g.c); this.teamDiv[i] = this.Dv.get(g.d);
    }
    grow(pr.oC, this.Cf.size); grow(pr.dC, this.Cf.size); grow(pr.oD, this.Dv.size); grow(pr.dD, this.Dv.size);
    /* ROSTER CONTINUITY (cont_k > 0): a team that kept more of last season's roster than is usual carries more
       of last season's strength, one that turned over more carries less. meta.continuity gives the share
       returning, centred on the usual share (college_baseball/lib/continuity.js); a team-season without
       rosters is carried as before. */
    const cont = o.cont_k && this.meta && this.meta.continuity ? this.meta.continuity : null;
    for (let i = 0; i < this.T.size; i++) {
      const base = [pr.oD[this.teamDiv[i]] + pr.oC[this.teamConf[i]], pr.dD[this.teamDiv[i]] + pr.dC[this.teamConf[i]]];
      const t = prevTotals[i];
      let carry = o.carry_team;
      if (cont && t) { const c = cont(season, this.T.keys[i]); if (c != null) carry = Math.max(0, Math.min(1.5, o.carry_team * (1 + o.cont_k * c))); }
      pr.oT[i] = t ? carry * (t[0] - base[0]) : 0;
      pr.dT[i] = t ? carry * (t[1] - base[1]) : 0;
    }
    /* parameters start at their priors */
    this.oT = pr.oT.slice(); this.dT = pr.dT.slice(); this.oC = pr.oC.slice(); this.dC = pr.dC.slice(); this.oD = pr.oD.slice(); this.dD = pr.dD.slice(); this.pk = pr.pk.slice();
    this.oD[0] = 0; this.dD[0] = 0;
    this.mu = pr.mu; this.hb = pr.hb; this.hp = pr.hp;
    this.obs = { B: [], P: [], y: [], hb: [], hp: [], pk: [], day: [], same: [] };
    this.info = null;
  }

  /* ------------------------------------------------------------ data */
  addGames(games) {
    const O = this.obs;
    for (const g of games) {
      const day = Date.parse(g.date + 'T00:00:00Z') / 864e5;
      const h = this.team(g.home_id); const a = this.team(g.away_id);
      const nh = g.neutral ? 0 : 1; const pk = this.park(g.park_key);
      const same = this.teamConf[h] === this.teamConf[a] ? 1 : 0;
      O.B.push(h, a); O.P.push(a, h); O.y.push(g.home_runs, g.away_runs); O.hb.push(nh, 0); O.hp.push(0, nh); O.pk.push(pk, pk); O.day.push(day, day); O.same.push(same, same);
    }
  }

  /* ------------------------------------------------------------ fit */
  fit(asOfDay) {
    const o = this.o; const O = this.obs; const pr = this.pr; const n = O.y.length;
    if (!n) return { sweeps: 0 };
    const w = new Float64Array(n); const lam = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = (o.halflife_days > 0 ? Math.pow(0.5, (asOfDay - O.day[i]) / o.halflife_days) : 1) / o.phi;
    const tc = this.teamConf; const td = this.teamDiv;
    const refresh = () => {
      for (let i = 0; i < n; i++) {
        const b = O.B[i]; const p = O.P[i];
        lam[i] = Math.exp(this.mu + this.oD[td[b]] + this.oC[tc[b]] + this.oT[b] - this.dD[td[p]] - this.dC[tc[p]] - this.dT[p]
          + this.hb * O.hb[i] - this.hp * O.hp[i] + (O.pk[i] >= 0 ? this.pk[O.pk[i]] : 0));
      }
    };
    const G = new Float64Array(Math.max(this.T.size, this.Cf.size, this.Dv.size, this.Pk.size) + 1);
    const H = new Float64Array(G.length);
    /* one Newton step for every entity of a block */
    const block = (vec, prior, sigma, idxOf, sign, size, fixed0) => {
      G.fill(0, 0, size); H.fill(0, 0, size);
      for (let i = 0; i < n; i++) { const k = idxOf(i); if (k < 0) continue; G[k] += w[i] * (O.y[i] - lam[i]) * sign; H[k] += w[i] * lam[i]; }
      const prec = 1 / (sigma * sigma); let m = 0;
      for (let k = fixed0 ? 1 : 0; k < size; k++) {
        if (H[k] === 0 && vec[k] === (prior[k] || 0)) continue;
        const d = Math.max(-0.5, Math.min(0.5, (G[k] - (vec[k] - (prior[k] || 0)) * prec) / (H[k] + prec)));
        vec[k] += d; if (Math.abs(d) > m) m = Math.abs(d);
      }
      refresh(); return m;
    };
    const scalar = (name, xOf, priorMean, sigma) => {
      let g = 0; let h = 0;
      for (let i = 0; i < n; i++) { const x = xOf(i); if (!x) continue; g += w[i] * (O.y[i] - lam[i]) * x; h += w[i] * lam[i] * x * x; }
      const prec = 1 / (sigma * sigma);
      const d = Math.max(-0.5, Math.min(0.5, (g - (this[name] - priorMean) * prec) / (h + prec)));
      this[name] += d; refresh(); return Math.abs(d);
    };
    refresh();
    let sweeps = 0;
    for (; sweeps < o.max_sweeps; sweeps++) {
      let m = 0;
      m = Math.max(m, scalar('mu', () => 1, pr.mu, 0.3));
      m = Math.max(m, scalar('hb', (i) => O.hb[i], pr.hb, 0.05));
      m = Math.max(m, scalar('hp', (i) => -O.hp[i], pr.hp, 0.05));
      m = Math.max(m, block(this.oT, pr.oT, o.sigma_team, (i) => O.B[i], 1, this.T.size));
      m = Math.max(m, block(this.dT, pr.dT, o.sigma_team, (i) => O.P[i], -1, this.T.size));
      if (o.hier) {
        m = Math.max(m, block(this.oC, pr.oC, o.sigma_conf, (i) => tc[O.B[i]], 1, this.Cf.size));
        m = Math.max(m, block(this.dC, pr.dC, o.sigma_conf, (i) => tc[O.P[i]], -1, this.Cf.size));
        m = Math.max(m, block(this.oD, pr.oD, o.sigma_div, (i) => td[O.B[i]], 1, this.Dv.size, true));
        m = Math.max(m, block(this.dD, pr.dD, o.sigma_div, (i) => td[O.P[i]], -1, this.Dv.size, true));
      }
      if (o.parks) m = Math.max(m, block(this.pk, pr.pk, o.sigma_park, (i) => O.pk[i], 1, this.Pk.size));
      if (m < o.tol) { sweeps++; break; }
    }
    /* connectivity-aware information */
    const team = new Float64Array(this.T.size); const confNC = new Float64Array(this.Cf.size);
    for (let i = 0; i < n; i += 2) {
      const info = w[i] * (lam[i] * lam[i + 1]) / (lam[i] + lam[i + 1]);
      team[O.B[i]] += info; team[O.B[i + 1]] += info;
      if (!O.same[i]) { confNC[tc[O.B[i]]] += info; confNC[tc[O.B[i + 1]]] += info; }
    }
    this.info = { team, confNC };
    return { sweeps };
  }

  netVar(i) {
    const o = this.o;
    const it = this.info && i < this.info.team.length ? this.info.team[i] : 0;
    const c = this.teamConf[i];
    const ic = this.info && c < this.info.confNC.length ? this.info.confNC[c] : 0;
    return { team: 1 / (it + 1 / (2 * o.sigma_team * o.sigma_team)), conf: o.hier ? 1 / (ic + 1 / (2 * o.sigma_conf * o.sigma_conf)) : 0, c };
  }

  /* ------------------------------------------------------------ predict */
  predict(g) {
    const h = this.team(g.home_id); const a = this.team(g.away_id);
    const nh = g.neutral ? 0 : 1;
    const pki = this.o.parks && g.park_key && this.Pk.has(g.park_key) ? this.Pk.find(g.park_key) : -1;
    const pk = pki >= 0 ? this.pk[pki] || 0 : 0;
    let lh = Math.exp(this.mu + this.offOf(h) - this.defOf(a) + this.hb * nh + pk);
    let la = Math.exp(this.mu + this.offOf(a) - this.defOf(h) - this.hp * nh + pk);
    /* PROJECTED STARTERS (sp_k > 0): a staff whose projected starter is better than the arms it usually pitches with
       allows fewer runs today. meta.starter gives q, the log of today's run value per batter against the staff's
       season run value, from box scores dated before the game (college_baseball/lib/starters.js); a side
       without one (its recent games not boxed) is priced exactly as before */
    const sp = this.o.sp_k && this.meta && this.meta.starter ? this.meta.starter(g) : null;
    if (sp) { if (sp.a != null) lh *= Math.exp(this.o.sp_k * sp.a); if (sp.h != null) la *= Math.exp(this.o.sp_k * sp.h); }
    /* PLATOON (pl_k > 0): a nine with more of its bats on the advantaged side of the projected starter's hand than
       is usual scores more; meta.platoon gives that share against the league's, from earlier games' lineups */
    const pl = this.o.pl_k && this.meta && this.meta.platoon ? this.meta.platoon(g) : null;
    if (pl) { if (pl.a != null) lh *= Math.exp(this.o.pl_k * pl.a); if (pl.h != null) la *= Math.exp(this.o.pl_k * pl.h); }
    const vh = this.netVar(h); const va = this.netVar(a);
    const same = vh.c === va.c;
    return {
      lh, la, sd_delta: Math.sqrt(vh.team + va.team + (same ? 0 : vh.conf + va.conf)), park: pk, home_adv: nh ? this.hb + this.hp : 0,
      net_home: this.offOf(h) + this.defOf(h), net_away: this.offOf(a) + this.defOf(a),
      sd_home: Math.sqrt(vh.team + vh.conf), sd_away: Math.sqrt(va.team + va.conf), same_conf: same,
      info_home: this.info ? this.info.team[h] || 0 : 0, info_away: this.info ? this.info.team[a] || 0 : 0,
    };
  }

  rating(id) {
    const i = this.team(id); const v = this.netVar(i);
    return { team_id: id, conf: this.Cf.keys[this.teamConf[i]].slice(2), div: this.Dv.keys[this.teamDiv[i]],
      off: this.offOf(i), def: this.defOf(i), net: this.offOf(i) + this.defOf(i),
      conf_net: this.oC[this.teamConf[i]] + this.dC[this.teamConf[i]], sd_team: Math.sqrt(v.team), sd_conf: Math.sqrt(v.conf), sd_net: Math.sqrt(v.team + v.conf),
      info: this.info ? this.info.team[i] || 0 : 0 };
  }
  parkFactor(key) { const i = this.Pk.find(key); return i >= 0 ? this.pk[i] || 0 : 0; }
}

/** Gauss-Hermite (3-point) integration of a probability over the rating uncertainty */
function integrate(lh, la, sd, probFn) {
  if (!(sd > 0)) return probFn(lh, la);
  const s3 = Math.sqrt(3) * sd;
  return (2 / 3) * probFn(lh, la) + (1 / 6) * probFn(lh * Math.exp(s3 / 2), la * Math.exp(-s3 / 2)) + (1 / 6) * probFn(lh * Math.exp(-s3 / 2), la * Math.exp(s3 / 2));
}

module.exports = { TeamQuality, DEFAULTS, integrate };
