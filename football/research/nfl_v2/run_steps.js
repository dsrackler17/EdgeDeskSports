#!/usr/bin/env node
/* ===========================================================================
   THE NFL REBUILD, STEP BY STEP — every candidate in preregistration.json,
   scored by backtest.js, selected on 2010-2024, gated on 2025.

     node football/research/nfl_v2/run_steps.js step1    old (served) vs fixed vs close
     node football/research/nfl_v2/run_steps.js step2    priors: decay grid, personnel, market
     node football/research/nfl_v2/run_steps.js step3    home field, travel, venue terms
     node football/research/nfl_v2/run_steps.js step4    core toggles and combinations
     node football/research/nfl_v2/run_steps.js all

   Each step starts from the previous step's promoted configuration
   (results/step<N-1>.json), writes results/step<N>.json, and appends every
   variant it evaluated to results/variants.jsonl (holdout looks flagged).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./backtest.js');
const M = require(path.join(__dirname, '..', '..', 'nfl_model.js'));
const P = globalThis.EDFootballParams.nfl.hyperparams;

const RES = B.RES;
fs.mkdirSync(RES, { recursive: true });
const V1CFG = M.config({ carry: P.carry, prior: { kind: 'geometric', alpha: P.alpha, alpha_pts: P.alpha_pts }, alpha_league: P.alpha_league,
  qb: { alpha_qb: P.alpha_qb, qb_shrink: P.qb_shrink, qb_prior: P.qb_prior } });

function merge(base, over) {
  const c = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && c[k] && typeof c[k] === 'object') Object.assign(c[k], over[k]);
    else c[k] = over[k];
  }
  return c;
}
function readStep(n) { const f = path.join(RES, `step${n}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
function writeStep(n, obj) { fs.writeFileSync(path.join(RES, `step${n}.json`), JSON.stringify(obj, null, 1) + '\n'); }
const fmt = (x, d) => (x == null ? '—' : (+x).toFixed(d));

/* a candidate's validation metrics (no holdout) */
function validate(step, family, label, cfg) {
  const r = B.evaluate(cfg);
  const rec = { step, family, label, cfg, valid: B.slim(r.valid), valid_close: { mae: +r.valid.close.mae.toFixed(4), logloss: +r.valid.close.logloss.toFixed(5) }, holdout_looked: false };
  B.logVariant(rec);
  return { rec, r };
}
/* the holdout look, on the record */
function holdout(step, family, label, cfg, r) {
  r = r || B.evaluate(cfg);
  const rec = { step, family, label, cfg, valid: B.slim(r.valid), holdout: B.slim(r.holdout), holdout_close: { mae: +r.holdout.close.mae.toFixed(4), logloss: +r.holdout.close.logloss.toFixed(5), brier: +r.holdout.close.brier.toFixed(5) }, holdout_looked: true };
  B.logVariant(rec);
  return { rec, r };
}
/* the preregistered gates */
function beatsValid(c, inc, probOnly) {
  if (probOnly) return c.logloss < inc.logloss;
  return c.mae < inc.mae && c.logloss < inc.logloss;
}
function beatsHoldout(c, inc, probOnly) {
  if (probOnly) return c.logloss < inc.logloss && c.brier < inc.brier;
  return c.mae < inc.mae && c.logloss < inc.logloss;
}
function row(label, v, h) {
  return `| ${label} | ${fmt(v && v.mae, 3)} | ${fmt(v && v.logloss, 4)} | ${fmt(v && v.brier, 4)} | ${fmt(h && h.mae, 3)} | ${fmt(h && h.logloss, 4)} | ${fmt(h && h.brier, 4)} | ${fmt(h && h.ece, 3)} | ${fmt(h && h.cal_slope, 2)} | ${fmt(h && h.home_lean, 2)} |`;
}
const HEAD = '| model | valid MAE | valid log loss | valid Brier | 2025 MAE | 2025 log loss | 2025 Brier | 2025 ECE | 2025 cal. slope | 2025 home lean |\n|---|---|---|---|---|---|---|---|---|---|';

/* ============================================================ step 1 */
function step1() {
  console.log('step 1: the served (bugged) v1, the fixed v1, the close');
  const served = B.evaluate(V1CFG, { served: true });
  const fixed = B.evaluate(V1CFG);
  const rec = (label, r) => { const x = { step: 1, family: 'correctness', label, cfg: V1CFG, valid: B.slim(r.valid), holdout: B.slim(r.holdout), holdout_looked: true }; B.logVariant(x); return x; };
  const out = {
    step: 1, generated_at: new Date().toISOString(),
    note: 'Correctness fixes ship regardless (audit_report.md); this is their measured effect. "served" is the pre-fix board emulated; "fixed" is the incumbent for Step 2.',
    served: rec('v1 as served (defence frozen in season, no QB starts, Normal win prob)', served),
    fixed: rec('v1 fixed (defence mirrored, QB starts, PMF win prob)', fixed),
    close: { valid: { mae: +fixed.valid.close.mae.toFixed(4), logloss: +fixed.valid.close.logloss.toFixed(5), brier: +fixed.valid.close.brier.toFixed(5), ece: +fixed.valid.close.ece.toFixed(4), cal_slope: +fixed.valid.close.slope.toFixed(3) },
      holdout: { mae: +fixed.holdout.close.mae.toFixed(4), logloss: +fixed.holdout.close.logloss.toFixed(5), brier: +fixed.holdout.close.brier.toFixed(5), ece: +fixed.holdout.close.ece.toFixed(4), cal_slope: +fixed.holdout.close.slope.toFixed(3) } },
    live_2026: { served: B.slim(served.live), fixed: B.slim(fixed.live), close_mae: fixed.live ? +fixed.live.close.mae.toFixed(4) : null },
    calibration_2025: { fixed: fixed.holdout.model.bins, close: fixed.holdout.close.bins },
    by_season: { served: served.by_season, fixed: fixed.by_season },
    promoted_cfg: V1CFG,
  };
  writeStep(1, out);
  console.log(HEAD);
  console.log(row('v1 as served', out.served.valid, out.served.holdout));
  console.log(row('v1 fixed', out.fixed.valid, out.fixed.holdout));
  console.log(row('closing line', out.close.valid, out.close.holdout));
  return out;
}

/* ============================================================ step 2 */
function step2() {
  const s1 = readStep(1) || step1();
  let inc = s1.promoted_cfg, incV = s1.fixed.valid, incH = s1.fixed.holdout;
  const decisions = [];
  /* P0 / P1: the decay families, selected on validation */
  const grid = [];
  for (const carry of [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95]) {
    for (const alpha of [0.05, 0.07, 0.10, 0.14, 0.20]) grid.push({ family: 'P0_wide_geometric', label: `geometric carry ${carry} alpha ${alpha}`, over: { carry, prior: { kind: 'geometric', alpha, alpha_pts: +(0.6 * alpha).toFixed(4) }, recency: null } });
    for (const k of [1, 2, 3, 4, 6, 8, 12, 16]) for (const kp of [2, 4, 8, 16]) grid.push({ family: 'P1_hyperbolic', label: `hyperbolic carry ${carry} k ${k} k_pts ${kp}`, over: { carry, prior: { kind: 'hyperbolic', k, k_pts: kp }, recency: 1 } });
  }
  const best = {};
  let i = 0;
  for (const c of grid) {
    const cfg = merge(inc, c.over);
    const { rec } = validate(2, c.family, c.label, cfg);
    i++; if (i % 25 === 0) console.log(`  ${i}/${grid.length} decay variants`);
    const b = best[c.family];
    if (!b || rec.valid.mae < b.valid.mae || (rec.valid.mae === b.valid.mae && rec.valid.logloss < b.valid.logloss)) best[c.family] = { label: c.label, cfg, valid: rec.valid };
  }
  /* the decay finalist: the better of the two family winners on validation */
  const fam = Object.values(best).sort((a, b) => a.valid.mae - b.valid.mae)[0];
  decisions.push(gate(2, 'decay', fam, inc, incV, incH, false));
  if (decisions[decisions.length - 1].promoted) { inc = fam.cfg; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  /* P2 personnel */
  const per = merge(inc, { personnel: { on: true } });
  const perV = validate(2, 'P2_personnel', 'personnel prior (RB, WR/TE, OL)', per);
  decisions.push(gate(2, 'P2_personnel', { label: 'personnel prior (RB, WR/TE, OL)', cfg: per, valid: perV.rec.valid }, inc, incV, incH, false, perV.r));
  if (decisions[decisions.length - 1].promoted) { inc = per; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  /* P3 market */
  let mBest = null;
  for (const beta of [0.10, 0.20, 0.35]) for (const cm of [0.6, 0.8, 1.0]) {
    const cfg = merge(inc, { market: { on: true, beta, carry_m: cm } });
    const v = validate(2, 'P3_market', `market prior beta ${beta} carry ${cm}`, cfg);
    if (!mBest || v.rec.valid.mae < mBest.valid.mae) mBest = { label: `market prior beta ${beta} carry ${cm}`, cfg, valid: v.rec.valid };
  }
  decisions.push(gate(2, 'P3_market', mBest, inc, incV, incH, false));
  if (decisions[decisions.length - 1].promoted) { inc = mBest.cfg; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  const out = { step: 2, generated_at: new Date().toISOString(), family_winners: best, decisions, promoted_cfg: inc, incumbent_valid: incV, incumbent_holdout: incH,
    inactive: ['win-total prior: nfldata win_totals.csv ends at 2020'] };
  writeStep(2, out);
  report(2, decisions);
  return out;
}

/* ============================================================ step 3 */
function step3() {
  const s2 = readStep(2) || step2();
  let inc = s2.promoted_cfg, incV = s2.incumbent_valid, incH = s2.incumbent_holdout;
  const decisions = [];
  let hBest = null;
  for (const rho of [0.5, 0.7, 0.85]) for (const m of [250, 500, 1000]) {
    const cfg = merge(inc, { hfa: { kind: 'season', rho, m } });
    const v = validate(3, 'H1_season_hfa', `season home field rho ${rho} m ${m}`, cfg);
    if (!hBest || v.rec.valid.mae < hBest.valid.mae) hBest = { label: `season home field rho ${rho} m ${m}`, cfg, valid: v.rec.valid };
  }
  decisions.push(gate(3, 'H1_season_hfa', hBest, inc, incV, incH, false));
  if (decisions[decisions.length - 1].promoted) { inc = hBest.cfg; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  const tr = merge(inc, { ctx: { travel: true } });
  const trV = validate(3, 'H2_travel_tz', 'travel, time zones, body clock', tr);
  decisions.push(gate(3, 'H2_travel_tz', { label: 'travel, time zones, body clock', cfg: tr, valid: trV.rec.valid }, inc, incV, incH, false, trV.r));
  if (decisions[decisions.length - 1].promoted) { inc = tr; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  const vn = merge(inc, { ctx: { venue: false } });
  const vnV = validate(3, 'H3_venue_terms', 'drop dome and grass terms', vn);
  decisions.push(gate(3, 'H3_venue_terms', { label: 'drop dome and grass terms', cfg: vn, valid: vnV.rec.valid }, inc, incV, incH, false, vnV.r));
  if (decisions[decisions.length - 1].promoted) { inc = vn; incV = decisions[decisions.length - 1].valid; incH = decisions[decisions.length - 1].holdout; }
  const out = { step: 3, generated_at: new Date().toISOString(), decisions, promoted_cfg: inc, incumbent_valid: incV, incumbent_holdout: incH };
  writeStep(3, out);
  report(3, decisions);
  return out;
}

/* ============================================================ step 4 */
function step4() {
  const s3 = readStep(3) || step3();
  const base = s3.promoted_cfg, baseV = s3.incumbent_valid, baseH = s3.incumbent_holdout;
  const toggles = {};
  /* each toggle's best setting on validation */
  const tv = (key, label, over, probOnly) => { const cfg = merge(base, over); const v = validate(4, key, label, cfg); return { key, label, cfg, over, valid: v.rec.valid, r: v.r, probOnly: !!probOnly }; };
  toggles.T1_split_od = tv('T1_split_od', 'split pass/rush/overall offence and defence', { features: { split_od: true } });
  let rBest = null;
  for (const lam of [0.80, 0.85, 0.90, 0.95]) { const x = tv('T2_recency', `in-season recency lambda ${lam}`, { recency: lam }); if (!rBest || x.valid.mae < rBest.valid.mae) rBest = x; }
  toggles.T2_recency = rBest;
  const g0 = tv('T3_garbage_time', 'play-by-play source, unfiltered (control G0)', { source: 'pbp_G0' });
  let gBest = null;
  for (const gk of ['pbp_G1', 'pbp_G2']) { const x = tv('T3_garbage_time', `play-by-play, garbage time removed (${gk.slice(4)})`, { source: gk }); if (!gBest || x.valid.mae < gBest.valid.mae) gBest = x; }
  gBest.control = { label: g0.label, valid: g0.valid };
  toggles.T3_garbage_time = gBest;
  toggles.T4_isotonic = tv('T4_isotonic', 'isotonic win-probability calibration', { calibration: { kind: 'isotonic' } }, true);
  toggles.T5_net_pts_fix = tv('T5_net_pts_fix', 'net_pts = (for - against) home minus away', { features: { net_pts_fix: true } });
  /* finalists: each toggle that beats the base on validation */
  const decisions = [];
  const finalists = Object.values(toggles).filter((t) => beatsValid(t.valid, baseV, t.probOnly));
  Object.values(toggles).forEach((t) => {
    const fin = finalists.indexOf(t) >= 0;
    const h = fin ? holdout(4, t.key, t.label, t.cfg, t.r).rec.holdout : null;
    decisions.push({ family: t.key, label: t.label, valid: t.valid, holdout: h, finalist: fin, control: t.control || null,
      promoted_alone: fin && beatsHoldout(h, baseH, t.probOnly), why: !fin ? 'did not beat the incumbent on 2010-2024 validation' : (beatsHoldout(h, baseH, t.probOnly) ? 'beats the incumbent on validation and on the 2025 holdout' : 'beat validation, not the 2025 holdout') });
  });
  /* combinations of finalists (every subset of size >= 2) */
  const combos = [];
  const fl = finalists;
  for (let mask = 1; mask < (1 << fl.length); mask++) {
    const parts = fl.filter((_, j) => mask & (1 << j));
    if (parts.length < 2) continue;
    let cfg = base; parts.forEach((p) => { cfg = merge(cfg, p.over); });
    const label = 'combination: ' + parts.map((p) => p.key).join(' + ');
    const v = validate(4, 'combination', label, cfg);
    const probOnly = parts.every((p) => p.probOnly);
    const fin = beatsValid(v.rec.valid, baseV, probOnly);
    const h = fin ? holdout(4, 'combination', label, cfg, v.r).rec.holdout : null;
    combos.push({ label, parts: parts.map((p) => p.key), cfg, valid: v.rec.valid, holdout: h, finalist: fin, promotes: fin && beatsHoldout(h, baseH, probOnly) });
  }
  /* the promoted core: the promoting option (single or combination) with the best holdout MAE, then log loss */
  const options = decisions.filter((d) => d.promoted_alone).map((d) => ({ label: d.label, cfg: toggles[d.family].cfg, valid: d.valid, holdout: d.holdout }))
    .concat(combos.filter((c) => c.promotes).map((c) => ({ label: c.label, cfg: c.cfg, valid: c.valid, holdout: c.holdout })));
  options.sort((a, b) => a.holdout.mae - b.holdout.mae || a.holdout.logloss - b.holdout.logloss);
  const pick = options[0] || null;
  const out = { step: 4, generated_at: new Date().toISOString(), base_valid: baseV, base_holdout: baseH, decisions, combinations: combos,
    promoted: pick ? pick.label : null, promoted_cfg: pick ? pick.cfg : base, incumbent_valid: pick ? pick.valid : baseV, incumbent_holdout: pick ? pick.holdout : baseH };
  writeStep(4, out);
  console.log('step 4: base', JSON.stringify(baseV), JSON.stringify(baseH));
  decisions.forEach((d) => console.log(`  ${d.family}: ${d.label} valid ${d.valid.mae} / ${d.valid.logloss}${d.holdout ? ' holdout ' + d.holdout.mae + ' / ' + d.holdout.logloss : ''} -> ${d.why}`));
  combos.forEach((c) => console.log(`  ${c.label}: valid ${c.valid.mae} / ${c.valid.logloss}${c.holdout ? ' holdout ' + c.holdout.mae + ' / ' + c.holdout.logloss : ''} -> ${c.promotes ? 'PROMOTES' : 'no'}`));
  console.log('  promoted core:', out.promoted);
  return out;
}

/* a family's finalist through the gates; returns the decision record */
function gate(step, family, cand, inc, incV, incH, probOnly, r) {
  const fin = beatsValid(cand.valid, incV, probOnly);
  let h = null;
  if (fin) h = holdout(step, family, cand.label, cand.cfg, r).rec.holdout;
  const promoted = fin && beatsHoldout(h, incH, probOnly);
  return { family, label: cand.label, cfg: cand.cfg, valid: cand.valid, holdout: h, incumbent_valid: incV, incumbent_holdout: incH, finalist: fin, promoted,
    why: !fin ? 'did not beat the incumbent on 2010-2024 validation (MAE and log loss)' : (promoted ? 'beats the incumbent on validation and on the 2025 holdout (MAE and log loss)' : 'beat validation but not the 2025 holdout') };
}
function report(step, decisions) {
  console.log(`step ${step}:`);
  decisions.forEach((d) => console.log(`  ${d.family}: ${d.label} | valid ${d.valid.mae} / ${d.valid.logloss} vs ${d.incumbent_valid.mae} / ${d.incumbent_valid.logloss}${d.holdout ? ' | holdout ' + d.holdout.mae + ' / ' + d.holdout.logloss + ' vs ' + d.incumbent_holdout.mae + ' / ' + d.incumbent_holdout.logloss : ''} -> ${d.promoted ? 'PROMOTED' : d.why}`));
}

if (require.main === module) {
  const which = process.argv[2] || 'all';
  if (which === 'step1' || which === 'all') step1();
  if (which === 'step2' || which === 'all') step2();
  if (which === 'step3' || which === 'all') step3();
  if (which === 'step4' || which === 'all') step4();
}
module.exports = { step1, step2, step3, step4, merge, V1CFG, readStep, HEAD, row };
