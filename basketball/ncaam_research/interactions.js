#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Matchup interactions: model-supported, or an untested basketball idea?

     node basketball/ncaam_research/interactions.js     writes published/validation_interactions.json

   The efficiency model is additive: an offense's expected points per 100 are
   its rating plus the defense's, whatever their styles. A style interaction
   says more: a heavy three-point offense against a defense that concedes
   threes, an offensive-rebounding team against a weak defensive-rebounding
   one, a turnover-prone offense against a turnover-forcing defense, a
   free-throw-hunting offense against a foul-prone defense, a fast team against
   a slow one.

   Test: point-in-time style profiles (refitted weekly from games available
   before each week), each game side's efficiency residual against the frozen
   team model, regressed on the products (offense deviation x defense
   deviation, in league standard deviations) of five style pairs. Fitted on
   2025, scored on 2026 (squared error of the residual, bootstrap by day). An
   interaction is MODEL-SUPPORTED only if its 2025 coefficient is
   distinguishable from zero AND adding the terms improves 2026. Otherwise
   matchup pages present it as a hypothesis, with no points added.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');
const U = require('./lib/util');
const WF = require('./walkforward');
const S = require('./style');

const PAIRS = [
  { key: 'three_rate', label: '3-point attempt share (offense) x 3PA share allowed (defense)' },
  { key: 'orb_pct', label: 'offensive rebounding x offensive rebounds allowed' },
  { key: 'tov_pct', label: 'turnover rate x turnovers forced' },
  { key: 'ftr', label: 'free-throw rate x free throws allowed' },
  { key: 'rim_rate', label: 'rim attempt share x rim attempts allowed' },
];

function weeklyProfiles(D, season, rel, c) {
  const games = D.games.holdout.filter((g) => g.season === season);
  const start = Math.min(...games.map((g) => g.start_ms)); const end = Math.max(...games.map((g) => g.start_ms));
  const out = [];
  for (let t = start + 14 * 864e5; t <= end + 7 * 864e5; t += 7 * 864e5) {
    const prof = S.seasonProfiles(D.TG, D.G, season, t, c, rel);
    const z = {};
    for (const p of PAIRS) {
      const f = prof.factors[p.key]; const offs = []; const defs = [];
      for (const v of Object.values(f)) { if (v.off) offs.push(v.off.sustainable); if (v.def) defs.push(v.def.sustainable); }
      const mo = U.mean(offs); const so = U.sd(offs) || 1; const md = U.mean(defs); const sd = U.sd(defs) || 1;
      z[p.key] = { f, mo, so, md, sd };
    }
    out.push({ t, z });
  }
  return out;
}

function features(prof, off, def) {
  const x = [];
  for (const p of PAIRS) {
    const z = prof.z[p.key]; const a = z.f[off]; const b = z.f[def];
    if (!a || !b || !a.off || !b.def) return null;
    x.push(((a.off.sustainable - z.mo) / z.so) * ((b.def.sustainable - z.md) / z.sd));
  }
  return x;
}

async function main() {
  const D = await WF.prepare(); const frozen = JSON.parse(fs.readFileSync(C.PATHS.frozen, 'utf8'));
  const rows = WF.scored(WF.runCandidate(D, frozen.chosen, 'holdout').rows, 'D1_D1');
  const c = D.coef.holdout.c;
  const rel = {}; for (const f of S.FACTORS) rel[f.key] = S.reliability(D.TG, D.G.byId, [2024], f, c);
  const sides = { 2025: [], 2026: [] };
  for (const season of [2025, 2026]) {
    const weeks = weeklyProfiles(D, season, rel, c);
    for (const r of rows) {
      if (r.season !== season || !r.cal) continue;
      const prof = weeks.filter((w) => w.t <= r.start_ms - C.PREDICT_BEFORE_MS).pop(); if (!prof) continue;
      for (const [off, def, pred, act] of [[r.home, r.away, r.ppp_h, r.y.ppp_h], [r.away, r.home, r.ppp_a, r.y.ppp_a]]) {
        const x = features(prof, off, def); if (!x) continue;
        sides[season].push({ x, e: act - pred, w: r.y.tempo, day: Math.floor(r.day) });
      }
    }
  }
  // weighted least squares on 2025 (with intercept)
  const fit = (data) => {
    const k = PAIRS.length + 1; const A = new Float64Array(k * k); const b = new Float64Array(k);
    for (const d of data) { const x = [1, ...d.x]; for (let i = 0; i < k; i++) { b[i] += d.w * x[i] * d.e; for (let j = 0; j < k; j++) A[i * k + j] += d.w * x[i] * x[j]; } }
    const L = U.cholesky(A, k); const beta = U.cholSolve(L, k, b); const inv = U.cholInverse(L, k);
    let rss = 0; let sw = 0; for (const d of data) { const x = [1, ...d.x]; let p = 0; for (let i = 0; i < k; i++) p += beta[i] * x[i]; rss += d.w * (d.e - p) ** 2; sw += d.w; }
    const s2 = rss / sw * (data.length / Math.max(1, data.length - k)) * (sw / data.length);
    return { beta, se: Array.from({ length: k }, (_, i) => Math.sqrt(s2 * inv[i * k + i])) };
  };
  const f25 = fit(sides[2025]);
  const coef = {}; PAIRS.forEach((p, i) => { coef[p.key] = { label: p.label, points_per_100_per_sd2: U.r(f25.beta[i + 1], 3), se: U.r(f25.se[i + 1], 3), significant_2025: Math.abs(f25.beta[i + 1]) > 1.96 * f25.se[i + 1] }; });
  // 2026: does adding the terms (excluding the intercept, which is a level shift) reduce squared error?
  const test = sides[2026].map((d) => { let adj = 0; d.x.forEach((v, i) => { adj += f25.beta[i + 1] * v; }); return { day: d.day, base: d.e * d.e, with: (d.e - adj) ** 2 }; });
  const cmp = U.clusteredDiffCI(test, (d) => d.day, (d) => d.with - d.base, { B: 1000 });
  const improves = cmp.ci95[1] < 0;
  const supported = {}; for (const p of PAIRS) supported[p.key] = coef[p.key].significant_2025 && improves ? 'MODEL_SUPPORTED' : 'HYPOTHESIS_NOT_SUPPORTED';
  const rec = {
    schema: 'edgedesk_ncaam_interactions_v1', fitted_on: 2025, scored_on: 2026, sides: { 2025: sides[2025].length, 2026: sides[2026].length },
    coefficients_2025: coef, holdout_2026_squared_error_with_minus_without: cmp, improves_holdout: improves, status: supported,
    rule: 'MODEL_SUPPORTED requires a 2025 coefficient beyond 1.96 SE and a 2026 improvement whose 95% interval excludes zero; otherwise the matchup page adds no points for it',
  };
  fs.mkdirSync(C.PATHS.out, { recursive: true });
  fs.writeFileSync(C.PATHS.outFile('validation_interactions.json'), JSON.stringify(rec, null, 1) + '\n');
  console.log(JSON.stringify(rec, null, 1));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { PAIRS };
