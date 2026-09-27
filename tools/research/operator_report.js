#!/usr/bin/env node
/* ===========================================================================
   OPERATOR RESEARCH REPORT — walk-forward evaluation of prediction records.

   Reads a JSON array of prediction records in the shape documented at the top
   of lib/research_eval.js (EdgeDesk's replay, a Collective export, or both)
   and prints, per model:

     * what was REJECTED by the leakage guard, and why
     * ATS / MAE / RMSE / Brier / log loss, each on its own n with intervals
     * Brier and Brier skill against the no-vig close, on the same games only
     * calibration by probability bin
     * edge, normalized-edge and lead-time buckets
     * which walk-forward error-scale method is honest (±1σ / ±2σ coverage)
     * component diagnostics (MAE with vs without each term, slope, drift)
   and, across models, residual correlation and walk-forward ensemble
   research with a development / holdout split.

   It changes nothing. No weight, parameter or threshold is written anywhere:
   this is a report for a person to read.

     node tools/research/operator_report.js --records records.json [--out report.json]
     node football/cfb_p4/research/backtest_engine.js --data DIR --records records.json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', '..', 'lib', 'research_core.js'));
const E = require(path.join(__dirname, '..', '..', 'lib', 'research_eval.js'));

function build(records, opts) {
  opts = opts || {};
  const ev = E.evaluate(records, { scaleMethod: opts.scaleMethod, scaleMinN: opts.scaleMinN });
  const rejectedWhy = {};
  ev.rejected.forEach((x) => x.violations.forEach((v) => {
    const k = v.replace(/: .*/, ': <input>');
    rejectedWhy[k] = (rejectedWhy[k] || 0) + 1;
  }));
  const ids = Array.from(new Set(ev.rows.map((r) => r.model_id))).sort();
  const models = {};
  ids.forEach((id) => {
    const rows = ev.rows.filter((r) => r.model_id === id);
    models[id] = {
      diagnostics: E.modelDiagnostics(rows),
      calibration: E.calibration(rows),
      components: rows.some((r) => r.components) ? E.componentDiagnostics(rows, { minN: opts.componentMinN }) : null
    };
  });
  return {
    generated_at: new Date().toISOString(),
    rule: 'walk-forward; records carrying information from after their prediction time are rejected, never scored',
    n_records: (records || []).length, n_scored: ev.rows.length,
    rejected: { n: ev.rejected.length, reasons: rejectedWhy },
    scale_methods: E.compareScaleMethods(records.filter((r) => E.validateRecord(r).ok), { scaleMinN: opts.scaleMinN }),
    models: models,
    correlation: ids.length > 1 ? E.modelCorrelation(ev.rows) : null,
    ensemble: ids.length > 1 ? E.ensembleResearch(ev.rows) : null
  };
}

function f(v, d) { return v == null || !isFinite(v) ? 'n/a' : Number(v).toFixed(d == null ? 2 : d); }
function pct(iv) { return iv ? (100 * iv.p).toFixed(1) + '% [' + (100 * iv.lo).toFixed(0) + '-' + (100 * iv.hi).toFixed(0) + '] n=' + iv.n : 'n/a'; }
function text(rep) {
  const L = [];
  L.push('OPERATOR RESEARCH REPORT  ' + rep.generated_at);
  L.push(rep.rule);
  L.push('records ' + rep.n_records + ' · scored ' + rep.n_scored + ' · rejected ' + rep.rejected.n
    + (rep.rejected.n ? ' (' + Object.entries(rep.rejected.reasons).map(([k, v]) => k + ' ' + v).join('; ') + ')' : ''));
  L.push('');
  L.push('ERROR-SCALE METHODS (share of |residual| within 1 and 2 scales; targets 68% / 95%)');
  const pc = (x) => (x == null ? 'n/a' : f(100 * x, 1) + '%');
  Object.entries(rep.scale_methods).forEach(([k, v]) => L.push('  ' + k.padEnd(5) + ' n=' + v.n + '  ±1σ ' + pc(v.within_1) + '  ±2σ ' + pc(v.within_2)));
  Object.entries(rep.models).forEach(([id, m]) => {
    const o = m.diagnostics.overall;
    L.push('');
    L.push('== ' + id);
    L.push('  ATS ' + o.ats.wins + '-' + o.ats.losses + '-' + o.ats.pushes + '  ' + pct(o.ats.interval));
    L.push('  MAE ' + f(o.mae.value) + ' n=' + o.mae.n + '   RMSE ' + f(o.rmse.value) + '   bias ' + f(o.bias.value));
    L.push('  Brier ' + f(o.brier.value, 4) + ' n=' + o.brier.n + '   log loss ' + f(o.log_loss.value, 4));
    const b = o.market_benchmark;
    L.push('  vs no-vig close (same ' + b.n + ' games): model ' + f(b.model_brier, 4) + ' market ' + f(b.market_brier, 4) + ' skill ' + f(b.skill, 4));
    L.push('  CLV mean ' + f(o.clv.mean) + ' median ' + f(o.clv.median) + ' n=' + o.clv.n);
    L.push('  edge buckets:');
    m.diagnostics.edge_buckets.forEach((x) => L.push('    ' + x.key.padEnd(6) + ' ATS ' + pct(x.summary.ats.interval) + '  MAE ' + f(x.summary.mae.value) + ' n=' + x.summary.mae.n));
    L.push('  normalized buckets (unavailable for ' + m.diagnostics.normalized_unavailable + ' rows):');
    m.diagnostics.normalized_buckets.forEach((x) => L.push('    ' + x.key.padEnd(9) + ' ATS ' + pct(x.summary.ats.interval)));
    L.push('  calibration:');
    m.calibration.forEach((c) => L.push('    ' + f(c.lo, 2) + '-' + f(c.hi, 2) + '  predicted ' + f(c.predicted, 3) + ' observed ' + f(c.observed, 3) + ' n=' + c.n));
    if (m.components) {
      L.push('  components (dMAE > 0 = helps; slope 1 = correctly sized):');
      m.components.forEach((c) => L.push('    ' + c.key.padEnd(11) + ' n=' + String(c.all.n).padEnd(5) + ' dMAE ' + f(c.all.delta_mae, 3)
        + '  slope ' + f(c.all.slope) + (c.all.slope_interval ? ' [' + f(c.all.slope_interval.lo) + ', ' + f(c.all.slope_interval.hi) + ']' : '') + '  ' + c.reading));
    }
  });
  if (rep.correlation) {
    L.push('');
    L.push('RESIDUAL CORRELATION  effective independent models: ' + (rep.correlation.effective_n == null ? 'not measurable (a pair lacks shared history)' : f(rep.correlation.effective_n, 2)));
  }
  if (rep.ensemble) {
    L.push('');
    L.push('ENSEMBLE RESEARCH (' + rep.ensemble.rule + ')');
    ['development', 'holdout'].forEach((part) => {
      L.push('  ' + part + ' (' + rep.ensemble[part].n_games + ' games):');
      Object.entries(rep.ensemble[part].methods).forEach(([k, v]) => L.push('    ' + k.padEnd(17) + ' MAE ' + f(v.mae) + ' n=' + v.n + '  vs mean on same games ' + f(v.vs_mean_same_games, 3)));
    });
    L.push('  A method is only worth promoting if it beats the plain mean on the HOLDOUT half, on the same games.');
  }
  L.push('');
  L.push('Nothing in this report changes a production weight. It is research for a person to read.');
  return L.join('\n');
}

module.exports = { build, text };

if (require.main === module) {
  const arg = (n) => { const i = process.argv.indexOf('--' + n); return i < 0 ? null : process.argv[i + 1]; };
  const file = arg('records');
  if (!file) { console.error('usage: operator_report.js --records records.json [--out report.json]'); process.exit(2); }
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rep = build(Array.isArray(records) ? records : records.records || []);
  console.log(text(rep));
  const out = arg('out');
  if (out) { fs.writeFileSync(out, JSON.stringify(rep, null, 2)); console.error('[write] ' + out); }
}
