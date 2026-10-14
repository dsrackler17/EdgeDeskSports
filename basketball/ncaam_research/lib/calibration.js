'use strict';
/* ===========================================================================
   From ratings to distributions, fitted only on earlier out-of-sample rows.

   A model row carries a raw predicted margin m, total t and the parameter
   variance of the ratings behind them. The calibrator, refitted weekly on the
   rows whose games had finished (tip + 4 h) before the refit, maps them to

     margin ~ Normal(a + b m, s0 + k * var_param)
     total  ~ Normal(c + d t, s0t + kt * var_param)
     P(home wins) = Phi(mean margin / sd margin)   (overtime included: a tie
                                                   in regulation is decided later)

   so early-season games, whose ratings rest on a few results, get wider
   distributions automatically, and the width is learned, not assumed. The
   margin-total residual correlation is kept for score distributions.
   =========================================================================== */
const U = require('./util');
const C = require('../config');

function ols(x, y) {
  const n = x.length; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const den = n * sxx - sx * sx; const b = den ? (n * sxy - sx * sy) / den : 0;
  return { a: (sy - b * sx) / n, b };
}

const usable = (r) => Number.isFinite(r.margin) && Number.isFinite(r.total) && Number.isFinite(r.var_param || 0);

function fit(all) {
  const rows = all.filter(usable);
  if (rows.length < 300) return null;
  const m = ols(rows.map((r) => r.margin), rows.map((r) => r.y.margin));
  const t = ols(rows.map((r) => r.total), rows.map((r) => r.y.total));
  const em = rows.map((r) => r.y.margin - (m.a + m.b * r.margin));
  const et = rows.map((r) => r.y.total - (t.a + t.b * r.total));
  const vp = rows.map((r) => r.var_param || 0);
  const varFit = (e) => {
    const sq = e.map((x) => x * x);
    if (U.sd(vp) > 1e-9) {
      const f = ols(vp, sq); let k = Math.max(0, f.b); let s0 = U.mean(sq) - k * U.mean(vp);
      if (s0 < 1) { s0 = 1; k = Math.max(0, (U.mean(sq) - s0) / Math.max(1e-9, U.mean(vp))); }
      return { s0, k };
    }
    return { s0: U.mean(sq), k: 0 };
  };
  const vm = varFit(em); const vt = varFit(et);
  return { n: rows.length, margin: m, total: t, var_margin: vm, var_total: vt, rho: U.corr(em, et) };
}

function apply(r, cal) {
  const mm = cal.margin.a + cal.margin.b * r.margin; const sm = Math.sqrt(cal.var_margin.s0 + cal.var_margin.k * (r.var_param || 0));
  const tm = cal.total.a + cal.total.b * r.total; const st = Math.sqrt(cal.var_total.s0 + cal.var_total.k * (r.var_param || 0));
  return { margin_mu: mm, margin_sd: sm, total_mu: tm, total_sd: st, p_home: U.Phi(mm / sm), pts_h: (tm + mm) / 2, pts_a: (tm - mm) / 2, rho: cal.rho };
}

/** causal: each row is calibrated with a fit on rows whose games were available before the weekly refit preceding its prediction */
function causal(rows, o) {
  const minRows = (o && o.min_rows) || 300; const step = ((o && o.refit_days) || 7) * 864e5;
  const sorted = rows.slice().sort((a, b) => a.start_ms - b.start_ms);
  const done = sorted.slice().sort((a, b) => a.start_ms - b.start_ms);
  let cal = null; let nextRefit = -Infinity; let k = 0; const pool = [];
  for (const r of sorted) {
    const at = r.start_ms - C.PREDICT_BEFORE_MS;
    if (at >= nextRefit) {
      while (k < done.length && done[k].start_ms + C.AVAILABLE_AFTER_MS < at) pool.push(done[k++]);
      cal = pool.length >= minRows ? fit(pool) : null;
      nextRefit = at - (at % step) + step;
    }
    r.cal = cal && usable(r) ? apply(r, cal) : null;
  }
  return sorted;
}

module.exports = { fit, apply, causal, ols };
