'use strict';
/* ===========================================================================
   EdgeDesk MLB — a point-in-time run model with starting pitchers.

     log E[home runs] = μ + γ + o_home − d_away − s_awaySP + k_park
     log E[away runs] = μ + o_away − d_home − s_homeSP + k_park

   o / d: team offence and run prevention excluding the starter's own effect;
   s: the starting pitcher's runs-prevention effect (above his team's); k: the
   home park's run factor (keyed by the home franchise, decayed, so a new
   ballpark re-learns). Fitted every game date on the previous `window_days`
   of games with exponentially decaying weights by coordinate Newton steps on
   the weighted Poisson likelihood, each block pulled by a ridge toward 0:
   teams by `prior_games`, pitchers by `prior_starts` (a pitcher with three
   starts is barely moved off average), parks by `prior_park_games`. A
   season start carries every rating at `carry`.

   Runs are overdispersed, so probabilities come from a negative binomial
   with the mean above and a size r fitted on earlier seasons (walkforward.js).
   A game level after the distribution's nine-inning-equivalent score goes
   to the home side with the extra-inning home rate of earlier seasons.

   A game with an unknown starter (all of 2024; see ingest.js) uses s = 0 for
   that side: the team average, stated, not imputed.
   =========================================================================== */

const DEFAULTS = { half_life_days: 365, window_days: 800, prior_games: 20, prior_starts: 8, prior_park_games: 120, carry: 0.7, sweeps: 3 };

class RunsModel {
  constructor(params, use) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.use = Object.assign({ park: true, sp: true }, use || {});
    this.mu = Math.log(4.4); this.home = 0.02;
    this.o = new Map(); this.d = new Map(); this.s = new Map(); this.k = new Map();
    this.hist = []; this.season = null;
  }
  startSeason(season) {
    if (this.season === season) return;
    if (this.season != null) for (const m of [this.o, this.d, this.s, this.k]) for (const [id, v] of m) m.set(id, v * this.p.carry);
    this.season = season;
  }
  g(m, id) { return id && m.has(id) ? m.get(id) : 0; }
  lambdas(h, a, spH, spA, park) {
    const kp = this.use.park ? this.g(this.k, park) : 0;
    const sh = this.use.sp ? this.g(this.s, spH) : 0, sa = this.use.sp ? this.g(this.s, spA) : 0;
    return { lh: Math.exp(this.mu + this.home + this.g(this.o, h) - this.g(this.d, a) - sa + kp), la: Math.exp(this.mu + this.g(this.o, a) - this.g(this.d, h) - sh + kp) };
  }
  absorb(day, games) { for (const x of games) this.hist.push({ day, h: x.home, a: x.away, hs: x.hs, as: x.as, spH: x.sp_home || null, spA: x.sp_away || null, park: x.home }); }
  fit(day) {
    const P = this.p; const lam = Math.LN2 / P.half_life_days;
    this.hist = this.hist.filter((x) => day - x.day <= P.window_days);
    const H = this.hist; if (H.length < 100) return;
    const w = H.map((x) => Math.exp(-lam * (day - x.day)));
    const L = H.map(() => [0, 0]);
    const recompute = () => { for (let i = 0; i < H.length; i++) { const x = H[i]; const l = this.lambdas(x.h, x.a, x.spH, x.spA, x.park); L[i][0] = l.lh; L[i][1] = l.la; } };
    /* index the blocks once */
    const idx = { o: new Map(), s: new Map(), k: new Map() };
    const push = (m, id, i) => { if (!id) return; if (!m.has(id)) m.set(id, []); m.get(id).push(i); };
    H.forEach((x, i) => { push(idx.o, x.h, i); push(idx.o, x.a, i); push(idx.s, x.spH, i); push(idx.s, x.spA, i); push(idx.k, x.park, i); });
    for (let sweep = 0; sweep < P.sweeps; sweep++) {
      recompute();
      let g = 0, hs = 0, gh = 0, hh = 0;
      for (let i = 0; i < H.length; i++) { const x = H[i]; g += w[i] * (x.hs - L[i][0] + x.as - L[i][1]); hs += w[i] * (L[i][0] + L[i][1]); gh += w[i] * (x.hs - L[i][0]); hh += w[i] * L[i][0]; }
      this.mu += g / hs; this.home += gh / hh;
      recompute();
      for (const [team, list] of idx.o) {
        let go = 0, ho = 0, gd = 0, hd = 0;
        for (const i of list) { const x = H[i]; if (x.h === team) { go += w[i] * (x.hs - L[i][0]); ho += w[i] * L[i][0]; gd -= w[i] * (x.as - L[i][1]); hd += w[i] * L[i][1]; } else { go += w[i] * (x.as - L[i][1]); ho += w[i] * L[i][1]; gd -= w[i] * (x.hs - L[i][0]); hd += w[i] * L[i][0]; } }
        const o0 = this.g(this.o, team), d0 = this.g(this.d, team);
        this.o.set(team, o0 + (go - P.prior_games * o0) / (ho + P.prior_games));
        this.d.set(team, d0 + (gd - P.prior_games * d0) / (hd + P.prior_games));
      }
      if (this.use.sp) {
        recompute();
        for (const [sp, list] of idx.s) {
          let gs = 0, hsp = 0;
          for (const i of list) { const x = H[i]; if (x.spH === sp) { gs -= w[i] * (x.as - L[i][1]); hsp += w[i] * L[i][1]; } else { gs -= w[i] * (x.hs - L[i][0]); hsp += w[i] * L[i][0]; } }
          const s0 = this.g(this.s, sp);
          this.s.set(sp, s0 + (gs - P.prior_starts * s0) / (hsp + P.prior_starts));
        }
      }
      if (this.use.park) {
        recompute();
        for (const [pk, list] of idx.k) {
          let gk = 0, hk = 0;
          for (const i of list) { gk += w[i] * (H[i].hs - L[i][0] + H[i].as - L[i][1]); hk += w[i] * (L[i][0] + L[i][1]); }
          const k0 = this.g(this.k, pk);
          this.k.set(pk, k0 + (gk - P.prior_park_games * k0) / (hk + P.prior_park_games));
        }
      }
    }
  }
  dump() {
    const o = {}; for (const t of this.o.keys()) o[t] = { o: +this.g(this.o, t).toFixed(4), d: +this.g(this.d, t).toFixed(4), park: +this.g(this.k, t).toFixed(4) };
    const s = {}; for (const [id, v] of this.s) if (Math.abs(v) > 1e-4) s[id] = +v.toFixed(4);
    return { mu: +this.mu.toFixed(4), home: +this.home.toFixed(4), teams: o, pitchers: s, season: this.season, use: this.use };
  }
}

/* negative binomial pmf with mean m and size r (r -> infinity is Poisson) */
function nbPmf(m, r, max) {
  const p = new Float64Array(max + 1);
  const q = r / (r + m);
  p[0] = Math.pow(q, r);
  for (let k = 1; k <= max; k++) p[k] = p[k - 1] * ((k - 1 + r) / k) * (1 - q);
  return p;
}

/** win / run line / totals from the two means; ties go to the home side at xi */
function game(lh, la, r, xi, max) {
  const M = max || 25; const ph = nbPmf(lh, r, M), pa = nbPmf(la, r, M);
  let hw = 0, tie = 0, hl15 = 0, al15 = 0; const tot = new Float64Array(2 * M + 1);
  for (let x = 0; x <= M; x++) for (let y = 0; y <= M; y++) {
    const p = ph[x] * pa[y];
    if (x > y) hw += p; else if (x === y) tie += p;
    if (x - y >= 2) hl15 += p; if (y - x >= 2) al15 += p;
    tot[x + y] += p;
  }
  const s = hw + tie + (1 - hw - tie);
  return { p_home: (hw + tie * xi) / s, p_tie9: tie, home_rl: hl15, away_rl: al15, totals: tot, exp_total: lh + la };
}
function over(tot, line) { let p = 0; for (let k = 0; k < tot.length; k++) if (k > line) p += tot[k]; return p; }

module.exports = { RunsModel, nbPmf, game, over, DEFAULTS };
