/* ===========================================================================
   PLAYER PROPS — post-hoc distribution calibration (Model_Library M029/M032,
   Validation_Eval V021). docs/player-props/VALIDATION.md

   The simulation's distribution is recalibrated per prop type by two fitted
   numbers, both learned on a TUNING fold and judged on a later, untouched
   HOLDOUT fold (never the same games):

     λ  location blend toward the Marcel baseline (a weighted ensemble of
        the simulation and the "stupidly strong" baseline, M032):
            centre' = baseline + λ · (mean − baseline)
     κ  dispersion scale (fixes interval coverage, V022) applied to the
        positive outcomes around their own mean
   Outcomes at or below zero (no catch, no carry, a lost-yardage game) stay
   exactly where they are — the zero atom is data, not a location. Positive
   outcomes are scaled so the whole mean lands on centre' and each one's
   mass is split between the two integers around it. A binary prop
   (anytime TD) blends its probability instead: p' = b + λ·(p − b).

   λ = 1, κ = 1 is the identity: a prop type with no fitted calibration is
   left exactly as simulated, and says so.
   =========================================================================== */
'use strict';
const P = require('../../lib/edgedesk_props.js');

function transform(d, lambda, kappa, baseline, binary) {
  if (!P.validDist(d)) return d;
  const mo = P.moments(d);
  if (binary) {
    const p = P.probAt(d, 0.5).over, b = typeof baseline === 'number' ? Math.max(0, Math.min(1, baseline)) : p;
    const q = Math.max(0.0005, Math.min(0.9995, b + lambda * (p - b)));
    const n = d.n;
    return { lo: 0, n, pmf: [Math.round((1 - q) * n), n - Math.round((1 - q) * n)] };
  }
  const centre = typeof baseline === 'number' ? baseline + lambda * (mo.mean - baseline) : mo.mean;
  /* ZERO-PRESERVING: a "no catch" / "no carry" game is an atom, and moving
     the centre must not move it. Outcomes ≤ 0 stay where they are; positive
     outcomes are scaled by s (so the whole mean lands on the centre) and
     then spread by κ around their own mean, never crossing below 1. */
  let neg = 0, posMass = 0, posSum = 0;
  for (let i = 0; i < d.pmf.length; i++) { const x = d.lo + i, c = d.pmf[i] / d.n; if (x > 0) { posMass += c; posSum += x * c; } else neg += x * c; }
  const s = posSum > 0 ? Math.max(0.2, (centre - neg) / posSum) : 1;
  const posMean = posMass > 0 ? s * posSum / posMass : 0;
  const mass = new Map();
  for (let i = 0; i < d.pmf.length; i++) {
    const c = d.pmf[i]; if (!c) continue;
    const x0 = d.lo + i;
    if (x0 <= 0) { mass.set(x0, (mass.get(x0) || 0) + c); continue; }
    const x = Math.max(1, posMean + kappa * (x0 * s - posMean));
    const f = Math.floor(x), w = x - f;
    mass.set(f, (mass.get(f) || 0) + c * (1 - w));
    if (w > 0) mass.set(f + 1, (mass.get(f + 1) || 0) + c * w);
  }
  const keys = [...mass.keys()].sort((a, b) => a - b);
  const lo = keys[0], hi = keys[keys.length - 1];
  const out = new Array(hi - lo + 1).fill(0);
  keys.forEach((k) => { out[k - lo] = mass.get(k); });
  /* integer counts that still sum to n exactly */
  const n = d.n; let acc = 0; const pmf = out.map((v) => Math.floor(v));
  acc = pmf.reduce((t, v) => t + v, 0);
  const rem = out.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; acc < n && k < rem.length; k++, acc++) pmf[rem[k][1]]++;
  return { lo, n, pmf };
}

const LAMBDAS = [0.2, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1];
const KAPPAS = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15];
/* rows: [{dist, baseline, y}] of one prop type in the tuning fold → the
   (λ, κ) with the lowest mean CRPS */
function fit(rows, binary) {
  if (rows.length < 150) return null;
  let best = null;
  const ks = binary ? [1] : KAPPAS;
  LAMBDAS.forEach((l) => ks.forEach((k) => {
    let s = 0;
    rows.forEach((x) => { s += P.crps(transform(x.dist, l, k, x.baseline, binary), x.y); });
    const m = s / rows.length;
    if (!best || m < best.crps - 1e-12) best = { lambda: l, kappa: k, crps: m };
  }));
  const id = rows.reduce((t, x) => t + P.crps(x.dist, x.y), 0) / rows.length;
  return { lambda: best.lambda, kappa: best.kappa, crps_tuning: Math.round(best.crps * 1e5) / 1e5, crps_tuning_identity: Math.round(id * 1e5) / 1e5, n: rows.length };
}
function apply(rec, calib) {
  const c = calib && calib.by_prop && calib.by_prop[rec.prop_type];
  if (!c || !rec.dist || !rec.baseline || typeof rec.baseline.mean !== 'number') return rec;
  const binary = P.propType(rec.prop_type).kind === 'binary';
  rec.dist_raw_summary = rec.summary;
  rec.dist = transform(rec.dist, c.lambda, c.kappa, rec.baseline.mean, binary);
  rec.summary = P.summarize(rec.dist);
  rec.calibration = { version: calib.version, lambda: c.lambda, kappa: c.kappa, fitted_on: calib.tuning_range, basis: 'location blend toward the Marcel baseline and a dispersion scale, fitted on the tuning fold and judged on a later holdout' };
  return rec;
}
module.exports = { transform, fit, apply, LAMBDAS, KAPPAS };
