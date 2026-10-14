'use strict';
/* ===========================================================================
   EdgeDesk college baseball — calibration in RUN SPACE, so every market
   stays coherent.

   The raw run model under-predicts home wins (calibration-in-the-large about
   -0.03) and is under-confident (slope above 1). A logistic map on P(home)
   fixes the moneyline alone and leaves the run line, totals and team totals
   priced from the uncorrected runs, so the markets of one game would disagree.
   Instead the two run expectations are adjusted before ANY market is priced:
        L  = log(lh / la)
        L' = a [non-neutral] + b L                 (the ratio, shifted and stretched)
        lh' = sqrt(lh la) e^{L'/2},  la' = sqrt(lh la) e^{-L'/2}
   The product lh la (and so, closely, the total) is unchanged. (a, b) for
   season S are fitted by maximum likelihood on the out-of-sample rows of
   seasons S-3..S-1 only — never on S itself.
   =========================================================================== */
const TQ = require('./team_quality');

function apply(lh, la, cal, neutral) {
  if (!cal) return [lh, la];
  const g = Math.sqrt(lh * la); const L = Math.log(lh / la);
  const L2 = (neutral ? 0 : cal.a) + cal.b * L;
  return [g * Math.exp(L2 / 2), g * Math.exp(-L2 / 2)];
}

function pOf(row, cal, table, f7) {
  const [lh, la] = apply(row.lh, row.la, cal, row.neutral);
  let p = TQ.integrate(lh, la, row.sd, table);
  if (row.p7 > 0) p = (1 - row.p7) * p + row.p7 * TQ.integrate(lh * f7, la * f7, row.sd, table);
  return p;
}

function nll(rows, cal, table, f7) {
  let s = 0;
  for (const r of rows) { const p = Math.min(1 - 1e-9, Math.max(1e-9, pOf(r, cal, table, f7))); s -= r.y ? Math.log(p) : Math.log(1 - p); }
  return s / rows.length;
}

function golden(f, lo, hi, it) {
  const g = (Math.sqrt(5) - 1) / 2; let a = lo; let b = hi; let c = b - g * (b - a); let d = a + g * (b - a); let fc = f(c); let fd = f(d);
  for (let i = 0; i < (it || 30); i++) { if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); } }
  return (a + b) / 2;
}

/** rows: [{lh, la, sd, y, neutral, p7}]; returns {a, b, n, nll_before, nll_after} or null if too few rows */
function fit(rows, table, f7) {
  if (rows.length < 500) return null;
  let cal = { a: 0, b: 1 };
  const before = nll(rows, cal, table, f7);
  for (let round = 0; round < 3; round++) {
    cal.a = golden((a) => nll(rows, { a, b: cal.b }, table, f7), -0.4, 0.4, 25);
    cal.b = golden((b) => nll(rows, { a: cal.a, b }, table, f7), 0.6, 2.2, 25);
  }
  return { a: Math.round(cal.a * 1e5) / 1e5, b: Math.round(cal.b * 1e5) / 1e5, n: rows.length, nll_before: Math.round(before * 1e6) / 1e6, nll_after: Math.round(nll(rows, cal, table, f7) * 1e6) / 1e6 };
}

module.exports = { apply, fit, pOf, nll };

/* ===========================================================================
   The REST LAYER (hypothesis H-ENV-1, accepted on VALIDATION): a team that
   played yesterday, its opponent having played yesterday, and the second game
   of a doubleheader shift run expectations multiplicatively. The three
   coefficients for season S are fitted (offset Poisson GLM, the run model's
   expectation as the offset) on seasons S-3..S-1 only, then applied before
   the run-space calibration. Coherent: it moves runs, not a probability.
   =========================================================================== */
const ST = require('../../engine/stats');
function restFeatures(battingYday, pitchingYday, dh2) { return [battingYday ? 1 : 0, pitchingYday ? 1 : 0, dh2 ? 1 : 0]; }
/** rows: [{lh, la, home_runs, away_runs, home_yday, away_yday, dh2}] -> {beta:[b0,b1,b2,b3]} */
function restFit(rows) {
  if (rows.length < 1000) return null;
  const X = []; const y = []; const off = [];
  for (const r of rows) {
    X.push([1].concat(restFeatures(r.home_yday, r.away_yday, r.dh2))); y.push(r.home_runs); off.push(Math.log(r.lh));
    X.push([1].concat(restFeatures(r.away_yday, r.home_yday, r.dh2))); y.push(r.away_runs); off.push(Math.log(r.la));
  }
  try { const f = ST.poisson(X, y, { l2: 1, offset: off }); return { beta: Array.from(f.beta).map((v) => Math.round(v * 1e5) / 1e5), n: rows.length }; } catch (_) { return null; }
}
function restApply(lh, la, flags, layer) {
  if (!layer) return [lh, la];
  const b = layer.beta;
  const fh = restFeatures(flags.home_yday, flags.away_yday, flags.dh2); const fa = restFeatures(flags.away_yday, flags.home_yday, flags.dh2);
  /* the intercept is applied too: fitted on earlier seasons, it is the level correction the flags are relative to */
  return [lh * Math.exp(b[0] + b[1] * fh[0] + b[2] * fh[1] + b[3] * fh[2]), la * Math.exp(b[0] + b[1] * fa[0] + b[2] * fa[1] + b[3] * fa[2])];
}
module.exports.restFit = restFit; module.exports.restApply = restApply;
