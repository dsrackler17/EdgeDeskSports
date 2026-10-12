#!/usr/bin/env node
/* ===========================================================================
   tools/research/evaluate_runs.js — graded research runs through the
   calibration kernel: hand-computed Brier and log loss, the closing baseline,
   look-ahead rows rejected, pushes not scored, no calibration or profit
   claim on a small sample, and the statement that nothing changes a model.
   Run: node tools/intelligence/evaluate_runs.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const EV = require(path.join(__dirname, '..', 'research', 'evaluate_runs.js'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
const T = (d, h) => new Date(Date.UTC(2026, 9, d, h || 17)).toISOString();
const row = (id, p, result, close, o) => Object.assign({ snapshot_id: id, predicted_at: T(10, 12), event_start: T(11), sport: 'americanfootball_nfl', market: 'spreads', selection: 'X', classification: 'VERIFIED_CANDIDATE', fair_probability: p, fair_kind: 'SHARP_NO_VIG', model_tier: null, odds_decimal: 1.95, net_ev_per_dollar: 0.03, result, closing_fair: close, clv: 0.01, graded_at: T(12) }, o || {});
const rows = [
  row('ps_a', 0.6, 'WIN', 0.55), row('ps_b', 0.6, 'LOSS', 0.58), row('ps_c', 0.4, 'LOSS', 0.42), row('ps_d', 0.55, 'WIN', 0.5),
  row('ps_e', 0.5, 'PUSH', 0.5),
  row('ps_late', 0.7, 'WIN', 0.6, { predicted_at: T(11, 18) }),
  row('ps_ungraded', 0.5, null, null),
  row('ps_wl', 0.45, 'LOSS', 0.47, { classification: 'WATCHLIST', fair_kind: 'MODEL', model_tier: 'LEAN' })
];
const rep = EV.evaluateRuns(rows);
const scoredP = [[0.6, 1], [0.6, 0], [0.4, 0], [0.55, 1], [0.45, 0]];
const brier = scoredP.reduce((s, [p, o]) => s + (p - o) ** 2, 0) / scoredP.length;
const ll = scoredP.reduce((s, [p, o]) => s - (o * Math.log(p) + (1 - o) * Math.log(1 - p)), 0) / scoredP.length;
const closeP = [[0.55, 1], [0.58, 0], [0.42, 0], [0.5, 1], [0.47, 0]];
const bClose = closeP.reduce((s, [p, o]) => s + (p - o) ** 2, 0) / closeP.length;
ok('five rows scored: the push is not scored, the ungraded row is excluded, the late row rejected', rep.scored === 5 && rep.excluded_unsettled === 1 && rep.rejected === 1, [rep.scored, rep.excluded_unsettled, rep.rejected]);
ok('a prediction made after its event started is rejected as look-ahead, never scored', rep.lookahead_violations === 1 && rep.rejected_reasons.PREDICTED_AFTER_START === 1);
ok('Brier = mean((p − o)²), hand-computed', Math.abs(rep.overall.brier - Math.round(brier * 1e4) / 1e4) < 1e-9, [rep.overall.brier, brier]);
ok('log loss, hand-computed', Math.abs(rep.overall.log_loss - Math.round(ll * 1e4) / 1e4) < 1e-9, [rep.overall.log_loss, ll]);
ok('the baseline is the no-vig close on the same rows', Math.abs(rep.overall.versus_close.baseline_brier - Math.round(bClose * 1e4) / 1e4) < 1e-9 && rep.overall.versus_close.n === 5, rep.overall.versus_close);
ok('five predictions: TOO_EARLY, calibration INSUFFICIENT_SAMPLE, no profit claim', rep.overall.sample_state === 'TOO_EARLY' && rep.overall.calibration_status === 'INSUFFICIENT_SAMPLE' && rep.overall.profit_claim === 'NOT_SUPPORTED', [rep.overall.sample_state, rep.overall.calibration_status, rep.overall.profit_claim]);
ok('grouped by classification and fair kind', rep.by['group.classification'].some((g) => g.key === 'WATCHLIST' && g.n === 1) && rep.by['group.fair_kind'].some((g) => g.key === 'MODEL'));
ok('the recorded CLV is averaged over graded rows that carry it', rep.recorded_clv.n === 8 && rep.recorded_clv.mean === 0.01, rep.recorded_clv);
ok('only verified candidates count as bets for ROI: four settled plus the push (money at risk, stake returned); the watchlist row is not a bet', rep.overall.staking.bets === 5, rep.overall.staking);
const txt = EV.render(rep);
ok('the report says it measures and changes no model', /changes no model/.test(txt) && /Nothing here feeds back into a probability/.test(txt) && rep.note === EV.NOTE, txt);
ok('an empty export is an honest empty report', EV.evaluateRuns([]).scored === 0 && EV.evaluateRuns([]).overall.sample_state === 'TOO_EARLY');

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
