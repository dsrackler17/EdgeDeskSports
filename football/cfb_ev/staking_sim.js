#!/usr/bin/env node
/* ============================================================================
   EdgeDesk EV — the STAKING STRESS TEST (docs/edgedesk-ev/DESIGN.md §§50-52).

   Staking is downstream of VALIDATED EV, and no EV is validated: the policy's
   staking block is disabled and no Kelly stake is ever shown. This study says
   what WOULD happen to candidate stake rules if EdgeDesk's stated edge were
   overstated, so that nobody later reads Kelly as a confidence badge.

   Each simulated season: 12 weeks × 8 positions at −110. The TRUE cover
   probability is 0.5 + true_edge; EdgeDesk STATES 0.5 + stated_edge, where the
   stated edge carries an overstatement factor and per-bet estimation noise.
   Positions in one week share a correlated shock (ρ, one-factor Gaussian
   copula), because same-slate errors are not independent (pack E19, E33).
   Rules: flat 1% of bankroll, quarter Kelly, half Kelly, full Kelly, and robust
   Kelly (quarter Kelly at the stated probability's 10th percentile), each
   capped at 5%. 4,000 seasons per scenario, seeded.

     node football/cfb_ev/staking_sim.js     -> football/cfb_ev/reports/staking_sim_v1.json
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global.window || global;
const EV = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_ev.js'));

const SEASONS = 4000, WEEKS = 12, PER_WEEK = 8, DEC = 1 + 100 / 110, SEED = 20260928;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { const u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function Phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
const RULES = {
  flat_1pct: () => 0.01,
  kelly_quarter: (p) => 0.25 * EV.kellyFraction(p, 0, DEC),
  kelly_half: (p) => 0.5 * EV.kellyFraction(p, 0, DEC),
  kelly_full: (p) => EV.kellyFraction(p, 0, DEC),
  kelly_robust_quarter: (p, sd) => 0.25 * EV.kellyFraction(Math.max(0.0001, p - 1.2816 * sd), 0, DEC)
};
const CAP = 0.05;
function scenario(name, trueEdge, statedEdge, noiseSd, rho, seed) {
  const r = rng(seed), out = {};
  Object.keys(RULES).forEach((k) => { out[k] = { final: [], dd: [], ruin50: 0 }; });
  for (let s = 0; s < SEASONS; s++) {
    const bank = {}, peak = {}, dd = {};
    Object.keys(RULES).forEach((k) => { bank[k] = 1; peak[k] = 1; dd[k] = 0; });
    for (let w = 0; w < WEEKS; w++) {
      const common = gauss(r);
      const legs = [];
      for (let i = 0; i < PER_WEEK; i++) {
        const pTrue = 0.5 + trueEdge, pStated = Math.min(0.99, Math.max(0.01, 0.5 + statedEdge + noiseSd * gauss(r)));
        /* one-factor Gaussian copula: correlated outcomes within the week */
        const z = Math.sqrt(rho) * common + Math.sqrt(1 - rho) * gauss(r);
        legs.push({ pStated: pStated, win: Phi(z) < pTrue });
      }
      Object.keys(RULES).forEach((k) => {
        const b0 = bank[k];
        let pnl = 0;
        legs.forEach((l) => { const f = Math.min(CAP, Math.max(0, RULES[k](l.pStated, noiseSd))); pnl += b0 * f * (l.win ? DEC - 1 : -1); });
        bank[k] = Math.max(0, b0 + pnl); peak[k] = Math.max(peak[k], bank[k]); dd[k] = Math.max(dd[k], 1 - bank[k] / peak[k]);
      });
    }
    Object.keys(RULES).forEach((k) => { out[k].final.push(bank[k]); out[k].dd.push(dd[k]); if (bank[k] <= 0.5) out[k].ruin50++; });
  }
  const q = (a, p) => { const x = a.slice().sort((m, n) => m - n); return x[Math.floor(p * (x.length - 1))]; };
  const res = { scenario: name, true_edge: trueEdge, stated_edge: statedEdge, estimation_noise_sd: noiseSd, weekly_correlation: rho, rules: {} };
  Object.keys(RULES).forEach((k) => { const o = out[k]; res.rules[k] = { median_bankroll: +q(o.final, 0.5).toFixed(4), p05_bankroll: +q(o.final, 0.05).toFixed(4), median_max_drawdown: +q(o.dd, 0.5).toFixed(4), p95_max_drawdown: +q(o.dd, 0.95).toFixed(4), p_lose_half: +(o.ruin50 / SEASONS).toFixed(4) }; });
  return res;
}
function main() {
  const S = [
    scenario('stated edge is real (+3 pp), no noise, independent', 0.03, 0.03, 0.0, 0.0, SEED + 1),
    scenario('stated +3 pp, true +1 pp (overstated ×3), noise 2 pp, ρ 0.05', 0.01, 0.03, 0.02, 0.05, SEED + 2),
    scenario('stated +3 pp, true 0 (no edge), noise 2 pp, ρ 0.05', 0.0, 0.03, 0.02, 0.05, SEED + 3),
    scenario('stated +6 pp, true −1 pp (EdgeDesk raw EV today), noise 3 pp, ρ 0.10', -0.01, 0.06, 0.03, 0.10, SEED + 4)
  ];
  const out = { schema: 'edgedesk_ev_staking_sim_v1', built_at: new Date().toISOString(), seed: SEED, seasons: SEASONS, weeks: WEEKS, positions_per_week: PER_WEEK, price: -110, cap: CAP,
    status: 'STAKING DISABLED: no EV is validated; this study exists so no stake rule is read as a confidence badge',
    scenarios: S,
    reading: 'Full Kelly on an overstated edge is the fastest way to lose half a bankroll; robust (lower-quantile) quarter Kelly and flat staking degrade gracefully. The fourth scenario is the champion’s raw EV at the close today (stated +6 pp, true about −1 pp, pack E21/K20): every Kelly variant stakes into a negative edge.' };
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'reports', 'staking_sim_v1.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(S.map((x) => [x.scenario, Object.fromEntries(Object.entries(x.rules).map(([k, v]) => [k, v.p_lose_half + ' / ' + v.p95_max_drawdown]))]), null, 1));
}
if (require.main === module) main();
