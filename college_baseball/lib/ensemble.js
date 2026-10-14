'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the validated ensemble (Model 8) and the bridge
   that keeps it coherent with every other market.

   STACKING. logit p_ens = w0 + sum_m w_m logit p_m over the calibrated base
   models (hierarchical run model, Elo, Massey, Pythagenpat), fitted ONLY on
   SELECTION out-of-sample rows (2014-2022) and applied unchanged afterwards.
   It is used for prices only if, on VALIDATION, a paired date-block bootstrap
   of its log loss against the chosen single model is wholly below zero
   (ml_ensemble.js records the decision; the walk-forward re-checks it).

   COHERENCE. An ensemble probability is a moneyline only. To price the run
   line, totals and team totals consistently with it, the run model's two
   expectations are moved along their ratio (product fixed) until the run
   distribution's P(home) equals the ensemble's: solveShift() by bisection.
   Every market of the game is then priced from those runs.
   =========================================================================== */
const S = require('../../engine/stats');
const TQ = require('./team_quality');

const MEMBERS = ['hier_cal', 'elo_cal', 'massey_cal', 'pythag_cal'];

function feats(p) { return [1].concat(MEMBERS.map((m) => S.logit(Math.min(1 - 1e-6, Math.max(1e-6, p[m]))))); }
function fit(rows) {
  const xs = rows.filter((x) => MEMBERS.every((m) => x.p[m] != null));
  const f = S.logistic(xs.map((x) => feats(x.p)), xs.map((x) => x.y), { l2: 1e-4 });
  return { members: MEMBERS, weights: Array.from(f.beta).map((v) => Math.round(v * 1e6) / 1e6), n: xs.length };
}
function predict(model, p) { if (!model || !MEMBERS.every((m) => p[m] != null)) return null; return S.sigmoid(S.dot(model.weights, feats(p))); }

/** the shift d (log-ratio) such that P(home | lh e^{d/2}, la e^{-d/2}) = target */
function solveShift(lh, la, sd, target, table) {
  const f = (d) => TQ.integrate(lh * Math.exp(d / 2), la * Math.exp(-d / 2), sd, table) - target;
  let lo = -3; let hi = 3; if (f(lo) > 0) return lo; if (f(hi) < 0) return hi;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function coherentRuns(lh, la, sd, target, table) { const d = solveShift(lh, la, sd, target, table); return [lh * Math.exp(d / 2), la * Math.exp(-d / 2), d]; }

module.exports = { MEMBERS, fit, predict, feats, solveShift, coherentRuns };
