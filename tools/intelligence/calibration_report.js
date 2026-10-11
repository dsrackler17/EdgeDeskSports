#!/usr/bin/env node
/* ===========================================================================
   THE CALIBRATION REPORT over EdgeDesk's own settled ledgers (EDCALIB,
   lib/edgedesk_calibration.js).

   Source: the frozen player-prop evaluations and their graded results
   (football/props/<league>/<season>/{evaluations,results}.jsonl). Each row is
   a probability EdgeDesk published BEFORE kickoff (evaluated_at < kickoff is
   enforced; a row that fails it is rejected and counted), the price it was
   compared with, the result, and the no-vig closing probability of the same
   side where the close was captured. The baseline every number is compared
   with is that close.

   It writes football/validation/calibration_props_<season>.json and prints
   the summary. It changes no model and promotes nothing: a status here is a
   measurement, and CALIBRATED / ALLOWED appear only when the thresholds in
   EDCALIB say so.

   Run: node tools/intelligence/calibration_report.js [--season 2026] [--check]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_calibration.js'));

const args = process.argv.slice(2);
const season = Number((args[args.indexOf('--season') + 1]) || 2026) || 2026;
const check = args.includes('--check');

function jsonl(p) { if (!fs.existsSync(p)) return []; return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); }

function rowsFor(league) {
  const dir = path.join(ROOT, 'football', 'props', league, String(season));
  const ev = jsonl(path.join(dir, 'evaluations.jsonl'));
  const res = new Map(jsonl(path.join(dir, 'results.jsonl')).map((r) => [r.evaluation_id, r]));
  return ev.map((e) => {
    const r = res.get(e.evaluation_id);
    const outcome = !r ? null : r.result === 'WIN' ? 1 : r.result === 'LOSS' ? 0 : null;
    const close = r && r.clv && r.clv.available && r.clv.close_novig != null && Number(r.clv.close_line) === Number(e.line) ? Number(r.clv.close_novig) : null;
    return { id: e.evaluation_id, predicted_at: e.evaluated_at, event_start: e.kickoff, prob: e.p_side, outcome, close_prob: close, american: e.american, fee: 0,
      bet: e.decision === 'BET' || e.decision === 'LEAN', sport: league === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf', market: e.market, model_version: e.model_version || null,
      group: { decision: e.decision, stage: e.stage || null, probability_source: e.probability_source || null } };
  });
}

const leagues = ['nfl', 'cfb'];
const out = { schema: 'edgedesk_calibration_report_v1', calibration_version: C.VERSION, season, generated_at: new Date().toISOString(),
  source: 'football/props/<league>/' + season + '/{evaluations,results}.jsonl — frozen pregame evaluations joined to their graded results',
  baseline: 'the no-vig closing probability of the same side at the same line (results.clv.close_novig)', leagues: {} };
for (const lg of leagues) {
  const rows = rowsFor(lg);
  if (!rows.length) { out.leagues[lg] = { rows_in: 0, note: 'no ledger on file' }; continue; }
  out.leagues[lg] = C.evaluate(rows, { groups: ['market', 'odds_range', 'group.decision', 'group.probability_source'] });
}
const file = path.join(ROOT, 'football', 'validation', 'calibration_props_' + season + '.json');
if (!check) fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
for (const lg of leagues) {
  const L = out.leagues[lg];
  if (!L.overall) { console.log(lg.toUpperCase() + ': ' + (L.note || 'no rows')); continue; }
  const o = L.overall;
  console.log(lg.toUpperCase() + ' props ' + season + ': ' + L.scored + ' settled (' + L.rejected + ' rejected, ' + L.lookahead_violations + ' look-ahead) · Brier ' + o.brier + ' · vs close on ' + o.versus_close.n + ': ' + o.versus_close.brier + ' vs baseline ' + o.versus_close.baseline_brier + ' (skill ' + o.versus_close.brier_skill + ')');
  console.log('   calibration: ' + o.calibration_status + ' — ' + o.calibration_why);
  console.log('   staking: ' + o.staking.bets + ' bets, ROI after fees ' + o.staking.roi_after_fees + ' (95% ' + o.staking.roi_ci95.low + ' to ' + o.staking.roi_ci95.high + '), max drawdown ' + o.staking.max_drawdown + 'u · CLV mean ' + o.clv.mean + ' (n ' + o.clv.n + ')');
  console.log('   profit claim: ' + o.profit_claim + ' — ' + o.profit_why);
}
console.log((check ? 'checked (not written): ' : 'wrote ') + path.relative(ROOT, file));
