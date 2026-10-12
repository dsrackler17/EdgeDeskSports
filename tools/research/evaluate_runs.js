#!/usr/bin/env node
/* ===========================================================================
   EVALUATE GRADED RESEARCH RUNS — Brier score, log loss, calibration by
   bucket and closing-line value of the probabilities EdgeDesk's research
   froze, measured with lib/edgedesk_calibration.js on rows exported from the
   public.research_run_calibration view (supabase/research_engine.sql).

   What it measures, and what it does not do
     - Each row is a probability frozen BEFORE its event (the view and the
       kernel both refuse anything else: a row predicted after its start, or
       with an input observed after its prediction, is rejected and counted).
     - The baseline is the no-vig closing probability of the same side: a
       source that does not beat the close added nothing the market lacked.
     - Calibration and profit are CLAIMED only when the kernel's rules allow
       it (500+ settled predictions, a Brier no worse than the close, buckets
       inside their intervals; an ROI interval above zero after fees).
     - It changes no model. Nothing reads this report back into a
       probability; any change to a model is a separate, reviewed release.

   Run:  node tools/research/evaluate_runs.js <export.json>   (an array of view rows)
         node tools/research/evaluate_runs.js <export.json> --json
   =========================================================================== */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_calibration.js'));

const NOTE = 'This report measures; it changes no model. Nothing here feeds back into a probability automatically.';

/** research_run_calibration rows → the calibration kernel's rows. */
function toCalibRows(rows) {
  return (rows || []).map((x) => ({
    id: x.snapshot_id,
    predicted_at: x.predicted_at,
    event_start: x.event_start,
    prob: x.fair_probability == null ? null : Number(x.fair_probability),
    outcome: x.result === 'WIN' ? 1 : x.result === 'LOSS' ? 0 : x.result === 'PUSH' ? 'push' : null,
    close_prob: x.closing_fair == null ? null : Number(x.closing_fair),
    decimal: x.odds_decimal == null ? null : Number(x.odds_decimal),
    sport: x.sport || null, market: x.market || null, model_version: x.fair_kind || null,
    bet: x.classification === 'VERIFIED_CANDIDATE',
    group: { classification: x.classification || null, fair_kind: x.fair_kind || null, model_tier: x.model_tier || null }
  }));
}
/** The evaluation: the kernel's report, plus the mean CLV recorded by the grader and the honest note. */
function evaluateRuns(rows, opts) {
  const rep = C.evaluate(toCalibRows(rows), Object.assign({ groups: ['sport', 'market', 'group.classification', 'group.fair_kind', 'odds_range'] }, opts || {}));
  const clvs = (rows || []).map((x) => (x.clv == null ? null : Number(x.clv))).filter((v) => v != null && isFinite(v));
  rep.recorded_clv = { n: clvs.length, mean: clvs.length ? Math.round(clvs.reduce((a, b) => a + b, 0) / clvs.length * 1e6) / 1e6 : null, basis: 'the CLV the capture pipeline graded for each priced signal' };
  rep.note = NOTE;
  return rep;
}
function render(rep) {
  const o = rep.overall, L = [];
  L.push('RESEARCH RUN EVALUATION — ' + rep.scored + ' scored, ' + rep.rejected + ' rejected (' + rep.lookahead_violations + ' look-ahead), ' + rep.excluded_unsettled + ' unsettled');
  L.push('Sample: ' + o.n + ' (' + o.sample_state + ')' + (rep.first ? ', ' + rep.first.slice(0, 10) + ' to ' + rep.last.slice(0, 10) : ''));
  L.push('Brier ' + o.brier + ' · log loss ' + o.log_loss + (o.versus_close.n ? ' · against the no-vig close on ' + o.versus_close.n + ' rows: Brier ' + o.versus_close.brier + ' vs ' + o.versus_close.baseline_brier + ' (skill ' + o.versus_close.brier_skill + ')' : ' · no closing baseline on these rows'));
  L.push('CLV at the closing fair: ' + (o.clv && o.clv.mean != null ? o.clv.mean : '—') + ' · recorded CLV: ' + (rep.recorded_clv.mean != null ? rep.recorded_clv.mean + ' over ' + rep.recorded_clv.n : '—'));
  L.push('Calibration: ' + o.calibration_status + ' — ' + o.calibration_why);
  L.push('Profit claim: ' + o.profit_claim + ' — ' + o.profit_why);
  (rep.by['group.classification'] || []).forEach((g) => L.push('  ' + g.key + ': n ' + g.n + ', Brier ' + g.brier + ', ' + g.sample_state));
  L.push(rep.note);
  return L.join('\n');
}
module.exports = { toCalibRows, evaluateRuns, render, NOTE };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('usage: node tools/research/evaluate_runs.js <research_run_calibration export.json> [--json]'); process.exit(2); }
  const rows = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const rep = evaluateRuns(Array.isArray(rows) ? rows : rows.rows || []);
  console.log(process.argv.includes('--json') ? JSON.stringify(rep, null, 2) : render(rep));
}
