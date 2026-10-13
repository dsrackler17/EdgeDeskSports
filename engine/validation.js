'use strict';
/* ===========================================================================
   EdgeDesk ENGINE — how every sport model is scored, out of sample.

   Proper scoring rules only (Gneiting & Raftery 2007): log loss and Brier for
   binary and multi-outcome events, the ranked probability score for ordinal
   counts (goals, runs). Calibration is reported three ways: by bucket with a
   Wilson interval, calibration-in-the-large (mean p − mean y), and the
   logistic recalibration slope/intercept (slope 1, intercept 0 is perfect).
   Differences between two forecasters are reported with a block bootstrap
   over dates, because games on one date share information (injuries, the
   schedule, league-wide scoring) and are not independent draws.

   LEAKAGE. `leakageAudit(rows)` rejects any prediction whose inputs were
   known at or after its prediction time, or whose prediction time is not
   strictly before the event. The walk-forward harnesses call it on every row
   they score; a single violation fails the build (tools/hockey/*.test.js).

   Sample bands match lib/edgedesk_validation.js and lib/edgedesk_calibration.js:
   <50 TOO_EARLY · 50-199 EARLY_SIGNAL · 200-499 DEVELOPING · 500+ MEANINGFUL.
   =========================================================================== */
const S = require('./stats');

const EPS = 1e-12;
const Z95 = 1.959964;
const BANDS = [[500, 'MEANINGFUL'], [200, 'DEVELOPING'], [50, 'EARLY_SIGNAL'], [0, 'TOO_EARLY']];

function r(v, k) { if (v == null || !isFinite(v)) return null; const f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
function sampleState(n) { for (const [m, s] of BANDS) if (n >= m) return s; return 'TOO_EARLY'; }
function clamp(p) { return Math.min(1 - EPS, Math.max(EPS, p)); }
function logLoss(p, y) { return -(y ? Math.log(clamp(p)) : Math.log(clamp(1 - p))); }
function brier(p, y) { return (p - y) * (p - y); }
function mlogLoss(probs, k) { return -Math.log(clamp(probs[k])); }
function mbrier(probs, k) { let s = 0; for (let i = 0; i < probs.length; i++) { const d = probs[i] - (i === k ? 1 : 0); s += d * d; } return s; }
/* ranked probability score for an ordinal outcome (pmf over 0..K, observed k) */
function rps(pmf, k) {
  let cp = 0, s = 0;
  for (let i = 0; i < pmf.length - 1; i++) { cp += pmf[i]; const co = k <= i ? 1 : 0; s += (cp - co) * (cp - co); }
  return s / Math.max(1, pmf.length - 1);
}
function wilson(k, n) {
  if (!n) return { low: null, high: null };
  const p = k / n, z2 = Z95 * Z95, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den, h = Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return { low: r(Math.max(0, c - h)), high: r(Math.min(1, c + h)) };
}

/** Binary forecast summary: rows [{p, y, date}] */
function binary(rows, o) {
  o = o || {};
  const n = rows.length;
  if (!n) return { n: 0, sample_state: 'TOO_EARLY' };
  let ll = 0, br = 0, sp = 0, sy = 0;
  for (const x of rows) { ll += logLoss(x.p, x.y); br += brier(x.p, x.y); sp += x.p; sy += x.y; }
  const base = sy / n;
  let brClim = 0, llClim = 0; for (const x of rows) { brClim += brier(base, x.y); llClim += logLoss(base, x.y); }
  const edges = o.buckets || [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const inb = rows.filter((x) => x.p >= edges[i] && x.p < edges[i + 1]);
    if (!inb.length) continue;
    const k = inb.reduce((a, x) => a + x.y, 0); const mp = inb.reduce((a, x) => a + x.p, 0) / inb.length;
    const w = wilson(k, inb.length);
    bins.push({ lo: edges[i], hi: Math.min(1, edges[i + 1]), n: inb.length, mean_p: r(mp), observed: r(k / inb.length), wilson_low: w.low, wilson_high: w.high, inside: w.low <= mp && mp <= w.high });
  }
  const slope = calibrationSlope(rows);
  return {
    n, sample_state: sampleState(n),
    log_loss: r(ll / n, 5), brier: r(br / n, 5),
    climatology: { rate: r(base), log_loss: r(llClim / n, 5), brier: r(brClim / n, 5) },
    brier_skill: r(1 - br / brClim, 4),
    mean_p: r(sp / n), mean_y: r(base), calibration_in_the_large: r(sp / n - base),
    calibration_slope: slope.slope, calibration_intercept: slope.intercept,
    bins,
  };
}

/* logistic recalibration y ~ a + b·logit(p) */
function calibrationSlope(rows) {
  if (rows.length < 30) return { slope: null, intercept: null };
  const X = rows.map((x) => [1, S.logit(x.p)]); const y = rows.map((x) => x.y);
  try { const f = S.logistic(X, y, { l2: 0 }); return { slope: r(f.beta[1], 3), intercept: r(f.beta[0], 3) }; } catch (_) { return { slope: null, intercept: null }; }
}

/**
 * Paired comparison of two forecasters on the same events.
 * rows: [{a, b, date}] where a and b are per-event losses (lower is better).
 * Block bootstrap over dates. Returns mean(a-b) and its 95% interval;
 * negative favours A.
 */
function pairedBootstrap(rows, o) {
  o = o || {};
  const B = o.B || 1000; const rand = S.rng(o.seed || 20261013);
  const byDate = new Map();
  for (const x of rows) { const k = x.date || 'all'; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(x.a - x.b); }
  const blocks = [...byDate.values()].map((d) => ({ s: d.reduce((a, v) => a + v, 0), n: d.length }));
  const tot = blocks.reduce((a, b) => a + b.s, 0), cnt = blocks.reduce((a, b) => a + b.n, 0);
  const means = [];
  for (let b = 0; b < B; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < blocks.length; i++) { const j = Math.floor(rand() * blocks.length); s += blocks[j].s; n += blocks[j].n; }
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const lo = means[Math.floor(0.025 * B)], hi = means[Math.floor(0.975 * B) - 1];
  return { n: cnt, blocks: blocks.length, mean_diff: r(tot / cnt, 6), ci95: [r(lo, 6), r(hi, 6)], a_better: hi < 0, b_better: lo > 0 };
}

/**
 * LEAKAGE AUDIT. rows: [{id, predicted_at, event_start, inputs_known_at}]
 * (ISO strings or ms). A row fails when any input was known at or after the
 * prediction, or the prediction is not before the event.
 */
function leakageAudit(rows) {
  const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
  const bad = [];
  for (const x of rows) {
    const p = ms(x.predicted_at), s = ms(x.event_start), k = x.inputs_known_at == null ? null : ms(x.inputs_known_at);
    if (!isFinite(p)) { bad.push({ id: x.id, why: 'no prediction time' }); continue; }
    if (isFinite(s) && !(p < s)) bad.push({ id: x.id, why: 'prediction not before the event' });
    if (k != null && isFinite(k) && !(k < p)) bad.push({ id: x.id, why: 'an input was known at or after the prediction' });
  }
  return { checked: rows.length, violations: bad.length, examples: bad.slice(0, 10), ok: bad.length === 0 };
}

module.exports = { r, sampleState, logLoss, brier, mlogLoss, mbrier, rps, wilson, binary, calibrationSlope, pairedBootstrap, leakageAudit, BANDS };
