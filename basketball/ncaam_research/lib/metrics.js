'use strict';
/* ===========================================================================
   Proper scores for what the engine forecasts.

   Win probability: log loss, Brier, reliability by probability band (with
   counts), calibration-in-the-large and slope. Margin and total: MAE, RMSE,
   CRPS of the full normal forecast, bias, and the coverage of the central
   50 / 80 / 95% intervals. Every summary carries its n.
   =========================================================================== */
const U = require('./util');

const EPS = 1e-6;
const ll = (p, y) => -Math.log(Math.min(1 - EPS, Math.max(EPS, y ? p : 1 - p)));

function summarize(rows) {
  const r = rows.filter((x) => x.cal);
  const n = r.length; if (!n) return { n: 0 };
  let sll = 0; let sb = 0; let sm = 0; let sm2 = 0; let scm = 0; let bias = 0; let st = 0; let st2 = 0; let sct = 0; let tb = 0;
  const cov = { m50: 0, m80: 0, m95: 0, t50: 0, t80: 0, t95: 0 };
  const z = { 50: 0.6745, 80: 1.2816, 95: 1.96 };
  for (const x of r) {
    const c = x.cal; const y = x.y;
    sll += ll(c.p_home, y.hw); sb += (c.p_home - y.hw) ** 2;
    const em = y.margin - c.margin_mu; sm += Math.abs(em); sm2 += em * em; bias += em; scm += U.crpsNormal(c.margin_mu, c.margin_sd, y.margin);
    const et = y.total - c.total_mu; st += Math.abs(et); st2 += et * et; tb += et; sct += U.crpsNormal(c.total_mu, c.total_sd, y.total);
    for (const k of [50, 80, 95]) { if (Math.abs(em) <= z[k] * c.margin_sd) cov['m' + k]++; if (Math.abs(et) <= z[k] * c.total_sd) cov['t' + k]++; }
  }
  const rate = (k) => U.r(cov[k] / n, 4);
  return {
    n,
    win: { log_loss: U.r(sll / n, 5), brier: U.r(sb / n, 5), calibration_in_the_large: U.r(U.mean(r.map((x) => x.y.hw)) - U.mean(r.map((x) => x.cal.p_home)), 4), slope: slope(r) },
    margin: { mae: U.r(sm / n, 3), rmse: U.r(Math.sqrt(sm2 / n), 3), crps: U.r(scm / n, 4), bias: U.r(bias / n, 3), coverage: { c50: rate('m50'), c80: rate('m80'), c95: rate('m95') } },
    total: { mae: U.r(st / n, 3), rmse: U.r(Math.sqrt(st2 / n), 3), crps: U.r(sct / n, 4), bias: U.r(tb / n, 3), coverage: { c50: rate('t50'), c80: rate('t80'), c95: rate('t95') } },
  };
}

/* logistic recalibration slope of outcomes on logit(p): 1 = well spread */
function slope(r) {
  let b = 1; let a = 0;
  const xs = r.map((x) => { const p = Math.min(1 - EPS, Math.max(EPS, x.cal.p_home)); return Math.log(p / (1 - p)); });
  for (let it = 0; it < 25; it++) {
    let g0 = 0; let g1 = 0; let h00 = 0; let h01 = 0; let h11 = 0;
    for (let i = 0; i < r.length; i++) {
      const p = 1 / (1 + Math.exp(-(a + b * xs[i]))); const e = r[i].y.hw - p; const w = p * (1 - p);
      g0 += e; g1 += e * xs[i]; h00 += w; h01 += w * xs[i]; h11 += w * xs[i] * xs[i];
    }
    const det = h00 * h11 - h01 * h01; if (!det) break;
    const da = (h11 * g0 - h01 * g1) / det; const db = (h00 * g1 - h01 * g0) / det;
    a += da; b += db; if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return U.r(b, 3);
}

function reliability(rows, bins) {
  const B = bins || 10; const out = [];
  for (let i = 0; i < B; i++) out.push({ lo: i / B, hi: (i + 1) / B, n: 0, p: 0, y: 0 });
  for (const x of rows) { if (!x.cal) continue; const k = Math.min(B - 1, Math.floor(x.cal.p_home * B)); out[k].n++; out[k].p += x.cal.p_home; out[k].y += x.y.hw; }
  return out.map((b) => ({ band: `${U.r(b.lo, 2)}-${U.r(b.hi, 2)}`, n: b.n, mean_forecast: b.n ? U.r(b.p / b.n, 4) : null, observed: b.n ? U.r(b.y / b.n, 4) : null }));
}

const perRow = {
  margin_crps: (x) => U.crpsNormal(x.cal.margin_mu, x.cal.margin_sd, x.y.margin),
  total_crps: (x) => U.crpsNormal(x.cal.total_mu, x.cal.total_sd, x.y.total),
  log_loss: (x) => ll(x.cal.p_home, x.y.hw),
  margin_sq: (x) => (x.y.margin - x.cal.margin_mu) ** 2,
};

/** paired comparison of two candidates over the same games, clustered by game day */
function compare(aRows, bRows, metric, o) {
  const bBy = new Map(bRows.filter((x) => x.cal).map((x) => [x.game_id, x]));
  const pairs = [];
  for (const a of aRows) { if (!a.cal) continue; const b = bBy.get(a.game_id); if (b) pairs.push({ a, b, day: Math.floor(a.day || a.start_ms / 864e5) }); }
  const f = perRow[metric];
  const res = U.clusteredDiffCI(pairs, (p) => p.day, (p) => f(p.a) - f(p.b), o);
  return Object.assign(res, { metric, a_better: res.ci95[1] < 0, b_better: res.ci95[0] > 0 });
}

module.exports = { summarize, reliability, compare, perRow, ll };
