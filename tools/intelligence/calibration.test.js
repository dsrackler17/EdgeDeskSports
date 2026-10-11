#!/usr/bin/env node
/* ===========================================================================
   THE CALIBRATION KERNEL (lib/edgedesk_calibration.js, EDCALIB).

   Every assertion is about a claim that must not be made on bad evidence: a
   probability called calibrated that loses to the closing line, a profit
   claimed on a small or negative-interval sample, a backtest that peeked at
   the future, a fee left out of ROI, a test fold that trained on its own rows.

   Run: node tools/intelligence/calibration.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_calibration.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function near(name, a, b, tol) { chk(name, a != null && Math.abs(a - b) <= (tol == null ? 1e-6 : tol), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 500)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

let seed = 12345;
const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
const T0 = Date.parse('2025-09-01T12:00:00Z');
/** n synthetic predictions: true p, the source's p (transform), the close (noisy truth), outcome ~ Bernoulli(true p). */
function synth(n, srcOf, closeNoise, over) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 0.2 + rnd() * 0.6;
    const o = rnd() < p ? 1 : 0;
    const cp = Math.min(0.97, Math.max(0.03, p + (rnd() - 0.5) * 2 * closeNoise));
    const src = srcOf(p);
    const t = T0 + i * 3600000;
    out.push(Object.assign({ id: 'r' + i, predicted_at: new Date(t).toISOString(), event_start: new Date(t + 7200000).toISOString(), prob: src, outcome: o, close_prob: cp, american: -110, sport: 'americanfootball_nfl', market: 'spreads', model_version: 'm1' }, over ? over(i, p, o) : {}));
  }
  return out;
}

/* ═══ 1. THE ARITHMETIC ══════════════════════════════════════════════════ */
{
  const w = C.wilson(50, 100);
  near('Wilson interval for 50/100: 0.4038', w.low, 0.4038, 1e-4);
  near('…to 0.5962', w.high, 0.5962, 1e-4);
  const rows = [
    { id: 'a', predicted_at: '2025-09-01T00:00:00Z', prob: 0.6, outcome: 1, american: 100 },
    { id: 'b', predicted_at: '2025-09-02T00:00:00Z', prob: 0.6, outcome: 0, american: 100 },
    { id: 'c', predicted_at: '2025-09-03T00:00:00Z', prob: 0.6, outcome: 1, american: 100 }
  ];
  const r = C.evaluate(rows).overall;
  near('Brier of (0.6,1),(0.6,0),(0.6,1) = (0.16+0.36+0.16)/3', r.brier, 0.2267, 1e-4);
  near('log loss = mean of -ln 0.6, -ln 0.4, -ln 0.6', r.log_loss, (-Math.log(0.6) * 2 - Math.log(0.4)) / 3, 1e-4);
  eq('flat 1u at +100, W L W: profit +1, ROI 1/3, drawdown 1', [r.staking.profit, r.staking.roi_after_fees, r.staking.max_drawdown], [1, 0.3333, 1]);
  const fee = C.evaluate(rows.map((x) => Object.assign({}, x, { fee: 0.02 }))).overall;
  eq('a 2% fee per $ staked comes off every bet: profit 0.94', fee.staking.profit, 0.94);
  const push = C.evaluate(rows.concat([{ id: 'd', predicted_at: '2025-09-04T00:00:00Z', prob: 0.5, outcome: null, american: 100 }]));
  eq('a push or void is excluded from scoring, and counted', [push.scored, push.excluded_unsettled], [3, 1]);
  eq('sample bands follow lib/edgedesk_validation.js', [C.sampleState(49), C.sampleState(50), C.sampleState(199), C.sampleState(200), C.sampleState(500)], ['TOO_EARLY', 'EARLY_SIGNAL', 'EARLY_SIGNAL', 'DEVELOPING', 'MEANINGFUL']);
}

/* ═══ 2. LOOK-AHEAD IS REJECTED, NOT SCORED ══════════════════════════════ */
{
  const good = synth(60, (p) => p, 0.05);
  const after = { id: 'late', predicted_at: '2025-09-10T20:00:00Z', event_start: '2025-09-10T18:00:00Z', prob: 0.99, outcome: 1, american: -110 };
  const peek = { id: 'peek', predicted_at: '2025-09-10T12:00:00Z', event_start: '2025-09-10T18:00:00Z', inputs_observed_at: '2025-09-10T19:00:00Z', prob: 0.99, outcome: 1, american: -110 };
  const noTime = { id: 'notime', prob: 0.99, outcome: 1, american: -110 };
  const pct = { id: 'pct', predicted_at: '2025-09-10T12:00:00Z', prob: 61, outcome: 1, american: -110 };
  const rep = C.evaluate(good.concat([after, peek, noTime, pct]));
  eq('four bad rows are rejected; the rest are scored', [rep.scored, rep.rejected], [60, 4]);
  eq('two of them are look-ahead violations', rep.lookahead_violations, 2);
  eq('each with its reason', rep.rejected_reasons, { PREDICTED_AFTER_START: 1, INPUT_AFTER_PREDICTION: 1, NO_PREDICTION_TIME: 1, BAD_PROBABILITY: 1 });
  const clean = C.evaluate(good);
  eq('a rejected row changes no metric', rep.overall.brier, clean.overall.brier);
}

/* ═══ 3. CALIBRATED ONLY WHEN IT EARNS IT ═══════════════════════════════ */
{
  const honest = C.evaluate(synth(3000, (p) => p, 0.12));
  eq('a source equal to the truth, against a noisy close, on 3,000 rows: CALIBRATED', honest.overall.calibration_status, 'CALIBRATED');
  chk('…its Brier beats the close', honest.overall.versus_close.brier < honest.overall.versus_close.baseline_brier, honest.overall.versus_close);
  const over = C.evaluate(synth(3000, (p) => Math.min(0.99, Math.max(0.01, 0.5 + 1.8 * (p - 0.5))), 0.12));
  eq('an overconfident source is NOT_CALIBRATED', over.overall.calibration_status, 'NOT_CALIBRATED');
  chk('…and the reason is measured (Brier vs close or buckets outside the interval)', /worse than the no-vig close|outside their 95% interval/.test(over.overall.calibration_why), over.overall.calibration_why);
  const sharpClose = C.evaluate(synth(3000, (p) => Math.min(0.97, Math.max(0.03, p + (rnd() - 0.5) * 0.3)), 0.01));
  eq('a noisy source against a sharp close is NOT_CALIBRATED: the market knew more', [sharpClose.overall.calibration_status, /worse than the no-vig close/.test(sharpClose.overall.calibration_why)], ['NOT_CALIBRATED', true]);
  const small = C.evaluate(synth(120, (p) => p, 0.12));
  eq('120 rows is INSUFFICIENT_SAMPLE whatever the numbers say', small.overall.calibration_status, 'INSUFFICIENT_SAMPLE');
  const noClose = C.evaluate(synth(800, (p) => p, 0.12, () => ({ close_prob: null })));
  eq('no closing baseline: NOT_CALIBRATED (nothing to compare with)', noClose.overall.calibration_status, 'NOT_CALIBRATED');
}

/* ═══ 4. A PROFIT CLAIM NEEDS 500+ BETS AND AN INTERVAL ABOVE ZERO ══════ */
{
  const streak = C.evaluate(synth(40, () => 0.6, 0.05, (i) => ({ outcome: i % 4 === 0 ? 0 : 1, american: 100 })));
  eq('30 wins in 40 at +100 is a streak, not a record: NOT_SUPPORTED', [streak.overall.staking.bets, streak.overall.profit_claim], [40, 'NOT_SUPPORTED']);
  chk('…and says why', /needs 500\+/.test(streak.overall.profit_why), streak.overall.profit_why);
  const edge = C.evaluate(synth(800, () => 0.6, 0.05, () => ({ outcome: rnd() < 0.62 ? 1 : 0, american: 100 })));
  eq('800 bets winning ~62% at +100: ALLOWED, with its interval', [edge.overall.profit_claim, edge.overall.staking.roi_ci95.low > 0], ['ALLOWED', true]);
  const vig = C.evaluate(synth(800, () => 0.5, 0.05, () => ({ outcome: rnd() < 0.5 ? 1 : 0, american: -110 })));
  eq('800 coin flips at -110: NOT_SUPPORTED (the vig is the expected result)', vig.overall.profit_claim, 'NOT_SUPPORTED');
  const fees = C.evaluate(synth(800, () => 0.6, 0.05, () => ({ outcome: rnd() < 0.53 ? 1 : 0, american: 100, fee: 0.07 })));
  chk('fees are inside ROI: a 53% winner at +100 paying 7% a bet is negative', fees.overall.staking.roi_after_fees < 0, fees.overall.staking);
}

/* ═══ 5. GROUPS: SPORT, MARKET, MODEL VERSION, ODDS RANGE ═══════════════ */
{
  const rows = synth(300, (p) => p, 0.1, (i) => ({ market: i % 2 ? 'spreads' : 'totals', model_version: i % 3 ? 'm1' : 'm2', american: [-250, -150, -110, 150, 250][i % 5], group: { decision: i % 2 ? 'BET' : 'PASS' } }));
  const rep = C.evaluate(rows, { groups: ['market', 'model_version', 'odds_range', 'group.decision'] });
  eq('by market', rep.by.market.map((g) => g.key), ['spreads', 'totals']);
  eq('by model version', rep.by.model_version.map((g) => g.key), ['m1', 'm2']);
  eq('by odds range, every bucket a clean partition', rep.by.odds_range.map((g) => g.key).sort(), ['+111 to +199', '+200 or longer', '-110 to +110', '-199 to -111', '-200 or shorter'].sort());
  eq('by a custom group (decision)', rep.by['group.decision'].map((g) => g.key), ['BET', 'PASS']);
  eq('group sizes add up', rep.by.market.reduce((s, g) => s + g.n, 0), 300);
}

/* ═══ 6. WALK-FORWARD: TRAINING NEVER SEES THE TEST ═════════════════════ */
{
  const rows = synth(600, (p) => p, 0.1);
  const seen = [];
  const wf = C.walkForward(rows, { cutoffs: [rows[200].predicted_at, rows[400].predicted_at], fit: (train) => { seen.push(train.map((x) => x.predicted_at)); const m = train.reduce((s, x) => s + x.outcome, 0) / train.length; return () => m; } });
  eq('two folds, both chronologically separated', [wf.folds.length, wf.all_separated], [2, true]);
  chk('fold 1 trained only on rows before its cutoff', seen[0].every((t) => Date.parse(t) < Date.parse(rows[200].predicted_at)), seen[0].slice(-1));
  chk('fold 2 trained only on rows before its cutoff', seen[1].every((t) => Date.parse(t) < Date.parse(rows[400].predicted_at)), seen[1].slice(-1));
  chk('each fold is scored on its own window only', wf.folds[0].report.n === 200 && wf.folds[1].report.n === 200, wf.folds.map((f) => f.report && f.report.n));
  const empty = C.walkForward(rows, { cutoffs: [rows[0].predicted_at] });
  chk('a fold with no training rows is skipped and says why', empty.folds[0].skipped === 'no training rows before the cutoff');
}

/* ═══ 7. THE BACKTEST ROW MATCHES supabase/quant_desk.sql ══════════════ */
{
  const rep = C.evaluate(synth(600, (p) => p, 0.1));
  const row = C.backtestRow(rep, { backtest_id: 'bt_x', sport: 'americanfootball_nfl', market: 'spreads', model_version: 'm1', train_to: '2025-08-31' });
  chk('train_to precedes test_from (the table\'s chronology check)', row.train_to < row.test_from, [row.train_to, row.test_from]);
  eq('no look-ahead violations recorded (the table refuses any)', row.lookahead_violations, 0);
  chk('the baseline is named', /no-vig closing/.test(row.baseline));
  chk('sample state and calibration status are values the table accepts', ['TOO_EARLY', 'EARLY_SIGNAL', 'DEVELOPING', 'MEANINGFUL'].includes(row.sample_state) && ['CALIBRATED', 'NOT_CALIBRATED', 'INSUFFICIENT_SAMPLE'].includes(row.calibration_status));
}

/* ═══ 8. THE COMMITTED REPORT IS HONEST ═════════════════════════════════ */
{
  const fs = require('fs');
  const f = path.join(ROOT, 'football', 'validation', 'calibration_props_2026.json');
  if (fs.existsSync(f)) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    ['nfl', 'cfb'].forEach((lg) => {
      const L = j.leagues[lg];
      if (!L || !L.overall) return;
      chk(lg + ': zero look-ahead violations in the ledger', L.lookahead_violations === 0, L.rejected_reasons);
      chk(lg + ': no CALIBRATED status without beating the close', L.overall.calibration_status !== 'CALIBRATED' || L.overall.versus_close.brier <= L.overall.versus_close.baseline_brier);
      chk(lg + ': no profit claim without an interval above zero', L.overall.profit_claim !== 'ALLOWED' || L.overall.staking.roi_ci95.low > 0);
    });
  } else chk('the committed report exists (run tools/intelligence/calibration_report.js)', false, f);
}

/* ═══ INDEPENDENT-AUDIT REGRESSIONS (quant audit M7, L9) ═══════════════ */
{
  const base = Date.parse('2025-09-01T00:00:00Z');
  const mk = (i, withClose) => ({ id: 'm' + i, predicted_at: new Date(base + i * 3600000).toISOString(), event_start: new Date(base + i * 3600000 + 7200000).toISOString(), prob: 0.5, outcome: i % 2, american: -110, close_prob: withClose ? 0.8 : null });
  const rows = []; for (let i = 0; i < 600; i++) rows.push(mk(i, i < 3));
  const rep = C.evaluate(rows);
  eq('M7: 600 rows with only 3 closes is not CALIBRATED (the market comparison needs 500 closes)', rep.overall.calibration_status, 'INSUFFICIENT_SAMPLE');
  chk('M7: …and says how many closes there were', /only 3 of 600/.test(rep.overall.calibration_why), rep.overall.calibration_why);
  /* pushes count in the ROI denominator */
  const t0 = '2025-09-01T00:00:00Z', k0 = '2025-09-01T03:00:00Z';
  const pr = C.evaluate([{ id: 'w', predicted_at: t0, event_start: k0, prob: 0.6, outcome: 1, decimal: 2 }].concat([1, 2, 3].map((i) => ({ id: 'p' + i, predicted_at: t0, event_start: k0, prob: 0.6, outcome: 'push', decimal: 2 }))));
  eq('L9: 1 win at evens plus 3 pushes: ROI is 1/4 = 0.25, not 1.0', [pr.overall.staking.roi_after_fees, pr.overall.staking.bets, pr.overall.staking.pushes], [0.25, 4, 3]);
  eq('L9: …and the pushes are not scored for calibration', pr.overall.n, 1);
  /* walk-forward trains only on settled rows */
  const wf = C.walkForward([
    { id: 'a', predicted_at: '2025-09-01T00:00:00Z', event_start: '2025-09-01T01:00:00Z', prob: 0.5, outcome: 1 },
    { id: 'b', predicted_at: '2025-09-01T10:00:00Z', event_start: '2025-09-01T11:30:00Z', prob: 0.5, outcome: 0 },
    { id: 'c', predicted_at: '2025-09-01T13:00:00Z', event_start: '2025-09-01T14:00:00Z', prob: 0.5, outcome: 1 }
  ], { cutoffs: ['2025-09-01T12:00:00Z'], fit: (train) => { const ids = train.map((x) => x.id); return () => (ids.includes('b') ? 0.99 : 0.5); } });
  eq('L9: a game that started 30 minutes before the cutoff (outcome unknown) is not trained on', wf.folds[0].train_n, 1);
  const wf2 = C.walkForward([
    { id: 'a', predicted_at: '2025-09-01T00:00:00Z', event_start: '2025-09-01T01:00:00Z', settled_at: '2025-09-01T04:00:00Z', prob: 0.5, outcome: 1 },
    { id: 'b', predicted_at: '2025-09-01T10:00:00Z', event_start: '2025-09-01T10:30:00Z', settled_at: '2025-09-01T11:45:00Z', prob: 0.5, outcome: 0 },
    { id: 'c', predicted_at: '2025-09-01T13:00:00Z', event_start: '2025-09-01T14:00:00Z', prob: 0.5, outcome: 1 }
  ], { cutoffs: ['2025-09-01T12:00:00Z'] });
  eq('L9: …a row settled before the cutoff is', wf2.folds[0].train_n, 2);
  const wf3 = C.walkForward([{ id: 'x', predicted_at: '2025-09-01T00:00:00Z', prob: 0.5, outcome: 1 }, { id: 'y', predicted_at: '2025-09-02T00:00:00Z', prob: 0.5, outcome: 1 }], { cutoffs: ['2025-09-01T12:00:00Z'] });
  chk('L9: …and a row with no start or settle time is never trained on', wf3.folds[0].skipped, wf3.folds[0]);
}

done();
