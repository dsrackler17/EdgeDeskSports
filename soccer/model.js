'use strict';
/* ===========================================================================
   EdgeDesk soccer — Dixon-Coles, point in time.

   Goals (Maher 1982; Dixon & Coles 1997):
     log λ_home = μ + γ + a_home − d_away        log λ_away = μ + a_away − d_home
   with the Dixon-Coles correction τ(x, y; λ, ν, ρ) on the four low scores
   (0-0, 1-0, 0-1, 1-1), where draws and one-goal games are under- or
   over-represented by independent Poisson counts.

   Fitted on every match day from the matches of the previous `window_days`,
   each weighted exp(−ln2 · age / half_life) (Dixon & Coles's time decay), by
   coordinate Newton steps on the weighted Poisson likelihood with a ridge
   pull of `prior_matches` toward each club's prior; ρ by a grid on the
   weighted likelihood of the τ terms. The prior is 0 (league average) for a
   club with league history; a newly promoted club starts at the mean rating
   of the clubs relegated the season before (they swapped divisions), which
   is learned from the data, not typed in.

   score(h, a) gives the full score matrix (0-10 goals each, renormalised), and
   every market — 1X2, totals, both teams to score, Asian handicaps (quarter
   lines as two half stakes) — is read from it.
   =========================================================================== */

const DEFAULTS = { half_life_days: 240, prior_matches: 4, window_days: 900, sweeps: 4, max_goals: 10 };

function poisPmf(lam, max) { const p = new Float64Array(max + 1); p[0] = Math.exp(-lam); for (let k = 1; k <= max; k++) p[k] = p[k - 1] * lam / k; return p; }
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

class DixonColes {
  constructor(params) {
    this.p = Object.assign({}, DEFAULTS, params || {});
    this.mu = 0.3; this.home = 0.25; this.rho = 0;
    this.att = new Map(); this.def = new Map(); this.prior = new Map();
    this.history = [];   /* { day, h, a, hg, ag, season } */
    this.season = null; this.lastSeasonClubs = new Set(); this.thisSeasonClubs = new Set();
  }
  /** a new season: clubs absent last season start at the mean of last season's relegated clubs */
  startSeason(season, clubs) {
    if (this.season === season) return;
    const relegated = [...this.thisSeasonClubs].filter((c) => clubs.indexOf(c) < 0);
    const promoted = clubs.filter((c) => !this.thisSeasonClubs.has(c));
    let pa = 0, pd = 0;
    if (relegated.length) { for (const c of relegated) { pa += this.att.get(c) || 0; pd += this.def.get(c) || 0; } pa /= relegated.length; pd /= relegated.length; }
    for (const c of promoted) { this.prior.set(c, { a: pa, d: pd }); if (!this.att.has(c) || !this.history.some((m) => m.h === c || m.a === c)) { this.att.set(c, pa); this.def.set(c, pd); } }
    this.lastSeasonClubs = this.thisSeasonClubs; this.thisSeasonClubs = new Set(clubs);
    this.promotedPrior = { a: pa, d: pd, relegated, promoted };
    this.season = season;
  }
  lambdas(h, a) {
    const ah = this.att.get(h) || 0, dh = this.def.get(h) || 0, aa = this.att.get(a) || 0, da = this.def.get(a) || 0;
    return { lh: Math.exp(this.mu + this.home + ah - da), la: Math.exp(this.mu + aa - dh) };
  }
  absorb(day, matches) { for (const m of matches) this.history.push({ day, h: m.home, a: m.away, hg: m.hg, ag: m.ag }); }
  fit(day) {
    const P = this.p; const lam = Math.LN2 / P.half_life_days;
    const H = this.history.filter((m) => day - m.day <= P.window_days);
    if (H.length < 30) return;
    const w = H.map((m) => Math.exp(-lam * (day - m.day)));
    const clubs = new Set(); for (const m of H) { clubs.add(m.h); clubs.add(m.a); }
    for (const c of clubs) { if (!this.att.has(c)) this.att.set(c, 0); if (!this.def.has(c)) this.def.set(c, 0); }
    const idx = new Map(); for (const c of clubs) idx.set(c, []);
    H.forEach((m, i) => { idx.get(m.h).push(i); idx.get(m.a).push(i); });
    const pr = (c) => this.prior.get(c) || { a: 0, d: 0 };
    for (let s = 0; s < P.sweeps; s++) {
      /* μ and γ */
      let g = 0, hss = 0, gh = 0, hh = 0;
      for (let i = 0; i < H.length; i++) {
        const m = H[i]; const L = this.lambdas(m.h, m.a);
        g += w[i] * ((m.hg - L.lh) + (m.ag - L.la)); hss += w[i] * (L.lh + L.la);
        gh += w[i] * (m.hg - L.lh); hh += w[i] * L.lh;
      }
      this.mu += g / hss; this.home += gh / (hh + 1e-9);
      for (const c of clubs) {
        let ga = 0, ha = 0, gd = 0, hd = 0;
        for (const i of idx.get(c)) {
          const m = H[i]; const L = this.lambdas(m.h, m.a);
          if (m.h === c) { ga += w[i] * (m.hg - L.lh); ha += w[i] * L.lh; gd += -w[i] * (m.ag - L.la); hd += w[i] * L.la; }
          else { ga += w[i] * (m.ag - L.la); ha += w[i] * L.la; gd += -w[i] * (m.hg - L.lh); hd += w[i] * L.lh; }
        }
        const p0 = pr(c), k = P.prior_matches;
        const a0 = this.att.get(c), d0 = this.def.get(c);
        this.att.set(c, a0 + (ga - k * (a0 - p0.a)) / (ha + k));
        this.def.set(c, d0 + (gd - k * (d0 - p0.d)) / (hd + k));
      }
    }
    /* ρ on the weighted τ likelihood */
    let best = { rho: 0, ll: -Infinity };
    for (let r = -0.2; r <= 0.1001; r += 0.01) {
      let ll = 0;
      for (let i = 0; i < H.length; i++) { const m = H[i]; if (m.hg > 1 || m.ag > 1) continue; const L = this.lambdas(m.h, m.a); const t = tau(m.hg, m.ag, L.lh, L.la, r); if (t <= 0) { ll = -Infinity; break; } ll += w[i] * Math.log(t); }
      if (ll > best.ll) best = { rho: +r.toFixed(2), ll };
    }
    this.rho = best.rho;
  }
  /** the score matrix; rho = 0 gives independent Poisson */
  score(h, a, rho) {
    const { lh, la } = this.lambdas(h, a); const M = this.p.max_goals;
    const r = rho == null ? this.rho : rho;
    const ph = poisPmf(lh, M), pa = poisPmf(la, M);
    const mat = []; let s = 0;
    for (let x = 0; x <= M; x++) { const row = new Float64Array(M + 1); for (let y = 0; y <= M; y++) { const v = Math.max(0, ph[x] * pa[y] * tau(x, y, lh, la, r)); row[y] = v; s += v; } mat.push(row); }
    for (const row of mat) for (let y = 0; y <= M; y++) row[y] /= s;
    return { lh, la, rho: r, mat };
  }
  dump() {
    const o = {}; for (const c of this.att.keys()) o[c] = { att: +this.att.get(c).toFixed(4), def: +this.def.get(c).toFixed(4) };
    return { mu: +this.mu.toFixed(4), home: +this.home.toFixed(4), rho: this.rho, clubs: o, promoted_prior: this.promotedPrior || null, season: this.season };
  }
}

/** markets read from a score matrix */
function markets(S) {
  const M = S.mat; let hw = 0, d = 0, aw = 0, o25 = 0, btts = 0, h2 = 0, a2 = 0; const diff = {};
  for (let x = 0; x < M.length; x++) for (let y = 0; y < M[x].length; y++) {
    const p = M[x][y];
    if (x > y) hw += p; else if (x === y) d += p; else aw += p;
    if (x + y > 2.5) o25 += p; if (x > 0 && y > 0) btts += p;
    if (x - y >= 2) h2 += p; if (y - x >= 2) a2 += p;
    diff[x - y] = (diff[x - y] || 0) + p;
  }
  return { home: hw, draw: d, away: aw, over_2_5: o25, btts, home_by_2: h2, away_by_2: a2, diff, exp_total: S.lh + S.la };
}

/** settlement probabilities of a home Asian handicap line (quarter lines split into two half stakes) */
function asian(diff, line) {
  const half = (L) => { /* single line L for the home side: win if diff + L > 0, push if = 0 */
    let win = 0, push = 0, lose = 0;
    for (const [k, p] of Object.entries(diff)) { const v = Number(k) + L; if (v > 1e-9) win += p; else if (Math.abs(v) <= 1e-9) push += p; else lose += p; }
    return { win, push, lose };
  };
  const q = Math.round(line * 4) / 4;
  if (Math.abs(q * 2 - Math.round(q * 2)) < 1e-9) { const r = half(q); return { full_win: r.win, half_win: 0, push: r.push, half_loss: 0, full_loss: r.lose, split: false }; }
  /* quarter line: half the stake on q - 0.25, half on q + 0.25, settled per score difference */
  const out = { full_win: 0, half_win: 0, push: 0, half_loss: 0, full_loss: 0, split: true };
  for (const [k, p] of Object.entries(diff)) {
    const a = Number(k) + q - 0.25, b = Number(k) + q + 0.25;
    const ra = a > 1e-9 ? 1 : Math.abs(a) <= 1e-9 ? 0 : -1, rb = b > 1e-9 ? 1 : Math.abs(b) <= 1e-9 ? 0 : -1;
    const sum = ra + rb;
    if (sum === 2) out.full_win += p; else if (sum === 1) out.half_win += p; else if (sum === 0) out.push += p; else if (sum === -1) out.half_loss += p; else out.full_loss += p;
  }
  return out;
}

class EloSoccer {
  constructor(p) { this.p = Object.assign({ k: 20, hfa: 70, revert: 0.8 }, p || {}); this.r = new Map(); this.season = null; }
  get(c) { return this.r.has(c) ? this.r.get(c) : 1500; }
  startSeason(s) { if (this.season === s) return; if (this.season != null) for (const [c, v] of this.r) this.r.set(c, 1500 + (v - 1500) * this.p.revert); this.season = s; }
  expect(h, a) { return 1 / (1 + Math.pow(10, -(this.get(h) - this.get(a) + this.p.hfa) / 400)); }
  absorb(m) { const e = this.expect(m.home, m.away); const s = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0; const gd = Math.abs(m.hg - m.ag); const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8; const d = this.p.k * mult * (s - e); this.r.set(m.home, this.get(m.home) + d); this.r.set(m.away, this.get(m.away) - d); }
}

module.exports = { DixonColes, EloSoccer, markets, asian, tau, poisPmf, DEFAULTS };
