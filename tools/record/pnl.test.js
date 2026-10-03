#!/usr/bin/env node
/* ===========================================================================
   lib/edgedesk_pnl.js — the P&L arithmetic, case by case.

   Every figure the Record's Profit & Loss section prints comes from this
   kernel, so every rule the section promises is pinned here: the American
   odds formula, what is refused as a price or a stake, push / void / pending,
   the two strategies (flat 1u and EdgeDesk staking) never mixing, ROI as net
   profit over risked, drawdown from the running peak, streaks, profit
   factor, CLV, calibration and the sample-size labels.

   Run: node tools/record/pnl.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'lib', 'edgedesk_pnl.js'));

let pass = 0, fail = 0;
function chk(label, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }
}
const near = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) < (eps || 1e-4);

/* ── American odds → profit, exactly as the spec's examples ───────────── */
chk('-110 winner, 1u: +0.9091u', near(P.profit(-110, 1, 'win'), 0.9091));
chk('-110 loser, 1u: -1.00u', P.profit(-110, 1, 'loss') === -1);
chk('+150 winner, 1u: +1.50u', near(P.profit(150, 1, 'win'), 1.5));
chk('+150 loser, 1u: -1.00u', P.profit(150, 1, 'loss') === -1);
chk('-150 winner, 1u: +0.6667u', near(P.profit(-150, 1, 'win'), 0.6667));
chk('push is 0', P.profit(-110, 1, 'push') === 0);
chk('void is 0', P.profit(-110, 1, 'void') === 0);
chk('pending has no profit yet (null, not 0)', P.profit(-110, 1, 'pending') === null);
chk('missing result has no profit', P.profit(-110, 1, null) === null && P.profit(-110, 1, 'banana') === null);
chk('positive odds: stake × odds / 100', near(P.profit(240, 0.5, 'win'), 1.2));
chk('negative odds: stake × 100 / |odds|', near(P.profit(-200, 0.75, 'win'), 0.375));
chk('a loss costs the stake', P.profit(-200, 0.75, 'loss') === -0.75);

/* ── stake sizes ─────────────────────────────────────────────────────── */
chk('0.25u at -110 wins +0.2273u', near(P.profit(-110, 0.25, 'win'), 0.2273));
chk('0.50u at -110 wins +0.4545u', near(P.profit(-110, 0.5, 'win'), 0.4545));
chk('0.75u at -110 wins +0.6818u', near(P.profit(-110, 0.75, 'win'), 0.6818));
chk('1.00u at -110 wins +0.9091u', near(P.profit(-110, 1, 'win'), 0.9091));
chk('0.25u loser loses 0.25u', P.profit(-110, 0.25, 'loss') === -0.25);
chk('0.50u loser loses 0.50u', P.profit(+120, 0.5, 'loss') === -0.5);
chk('0.75u loser loses 0.75u', P.profit(-105, 0.75, 'loss') === -0.75);

/* ── odds and stake safety ───────────────────────────────────────────── */
[0, null, undefined, NaN, Infinity, -Infinity, '', 'abc', '-110x', true, false, {}, [], 50, -99, 99.9, -100.1 + 0.2, 1e7, -1e7].forEach((bad) => {
  chk('refused as American odds: ' + String(bad), P.validAmerican(bad) === null, bad);
});
[-110, 100, -100, 150, '+150', '-110', ' -105 ', 10000].forEach((ok) => {
  chk('accepted as American odds: ' + JSON.stringify(ok), P.validAmerican(ok) !== null, ok);
});
chk('a numeric string is read as its number', P.validAmerican('+150') === 150 && P.validAmerican('-110') === -110);
chk('0 odds never produce a profit', P.profit(0, 1, 'win') === null);
chk('null odds never produce a profit', P.profit(null, 1, 'win') === null);
chk('undefined odds never produce a profit', P.profit(undefined, 1, 'loss') === null);
chk('a negative stake is refused', P.validStake(-0.25) === null && P.profit(-110, -1, 'win') === null);
chk('a string stake is refused', P.validStake('1') === null);
chk('a zero stake risks nothing', P.profit(-110, 0, 'loss') === 0);
chk('decimal of -110', near(P.decimal(-110), 1.9091));
chk('implied probability of -110', near(P.impliedProb(-110), 0.5238));
chk('implied probability of +150', near(P.impliedProb(150), 0.4));
chk('decimal 1.9091 back to -110', P.toAmerican(1.90909) === -110);
chk('decimal 2.5 back to +150', P.toAmerican(2.5) === 150);
chk('decimal ≤ 1 has no American price', P.toAmerican(1) === null && P.toAmerican(0.5) === null);

/* ── result words ───────────────────────────────────────────────────── */
chk('WIN / W / won → win', ['WIN', 'W', 'won', 'Win'].every((x) => P.normResult(x) === 'win'));
chk('LOSS / L / lost → loss', ['LOSS', 'L', 'lost'].every((x) => P.normResult(x) === 'loss'));
chk('PUSH → push', P.normResult('PUSH') === 'push');
chk('VOID / cancelled / DNP → void', ['VOID', 'cancelled', 'dnp'].every((x) => P.normResult(x) === 'void'));

/* ── one row: status and the two strategies ─────────────────────────── */
const base = { recommendation_id: 'x', event_id: 'g', side: 'home', selection: 'BUF -3', game_date: '2026-09-20T17:00:00Z', stake_units: 0.5, entry_odds: -110 };
let s = P.settle(Object.assign({}, base, { result: 'win' }));
chk('a settled priced row is VERIFIED', s.pnl_status === 'VERIFIED' && s.pnl_eligible === true);
chk('flat profit is at 1u', near(s.flat_profit_units, 0.9091));
chk('staked profit is at the recommended 0.50u', near(s.profit_units, 0.4545));
chk('flat stake is always 1', s.flat_stake_units === 1);
chk('implied probability is stamped', near(s.implied_prob, 0.5238));
s = P.settle(Object.assign({}, base, { entry_odds: null, result: 'win' }));
chk('missing entry odds: NO_ENTRY_PRICE, not -110', s.pnl_status === 'NO_ENTRY_PRICE' && s.flat_profit_units === null && s.profit_units === null);
chk('missing entry odds: flagged missing_entry_odds', s.missing_entry_odds === true);
chk('missing entry odds: the note says so', /entry price not captured/.test(s.pnl_note));
chk('missing entry odds: the result still stands', s.result === 'win');
s = P.settle(Object.assign({}, base, { entry_odds: null, result: 'pending' }));
chk('missing odds on an unsettled row is PENDING', s.pnl_status === 'PENDING' && s.missing_entry_odds === true);
s = P.settle(Object.assign({}, base, { entry_odds: 0, result: 'win' }));
chk('0 stored as a price: INVALID_PRICE', s.pnl_status === 'INVALID_PRICE' && s.flat_profit_units === null);
s = P.settle(Object.assign({}, base, { entry_odds: -110, price_assumed: true, result: 'win' }));
chk('an assumed price is SIMULATED, never verified', s.pnl_status === 'SIMULATED_PRICE' && s.flat_profit_units === null && !s.pnl_eligible);
s = P.settle(Object.assign({}, base, { stake_units: -1, result: 'win' }));
chk('a negative stake: INVALID_STAKE', s.pnl_status === 'INVALID_STAKE' && s.profit_units === null);
s = P.settle(Object.assign({}, base, { result: 'void' }));
chk('void: VOID with 0 P&L, not eligible', s.pnl_status === 'VOID' && s.flat_profit_units === 0 && !s.pnl_eligible);
s = P.settle(Object.assign({}, base, { result: 'push' }));
chk('push: VERIFIED with 0 P&L', s.pnl_status === 'VERIFIED' && s.flat_profit_units === 0 && s.profit_units === 0);
s = P.settle(Object.assign({}, base, { result: null }));
chk('missing result: PENDING', s.pnl_status === 'PENDING' && s.flat_profit_units === null);
s = P.settle(Object.assign({}, base, { stake_units: 0, result: 'win' }));
chk('no recommended stake: flat P&L only', near(s.flat_profit_units, 0.9091) && s.profit_units === null);

/* market shapes: the kernel treats every market the same way — the row
   carries the selection, the kernel prices it */
[['moneyline', { market_type: 'moneyline', side: 'home', entry_odds: 135, result: 'win' }, 1.35],
  ['spread', { market_type: 'spread', side: 'away', entry_line: 3.5, entry_odds: -108, result: 'loss' }, -1],
  ['total', { market_type: 'total', side: 'under', entry_line: 44.5, entry_odds: -112, result: 'win' }, 0.8929],
  ['player prop Over', { market_type: 'player_prop', prop_market: 'pass_yds', side: 'over', entry_line: 276.5, entry_odds: -110, result: 'win' }, 0.9091],
  ['player prop Under', { market_type: 'player_prop', prop_market: 'receptions', side: 'under', entry_line: 3.5, entry_odds: -135, result: 'loss' }, -1]
].forEach(([label, row, want]) => {
  const x = P.settle(Object.assign({ recommendation_id: label, event_id: 'g', selection: label, game_date: '2026-09-20T17:00:00Z', stake_units: 1 }, row));
  chk(label + ': flat P&L ' + want, near(x.flat_profit_units, want), x.flat_profit_units);
});

/* ── aggregates over a known path ───────────────────────────────────── */
function mk(i, date, result, odds, stake, extra) {
  /* a complete row, as the ledger writes one (a row with no game or no side is INVALID and graded nowhere) */
  return P.settle(Object.assign({ recommendation_id: 'r' + i, event_id: 'g' + i, side: 'home', selection: 'Test ' + i, game_date: date + 'T17:00:00Z', result, entry_odds: odds, stake_units: stake }, extra || {}));
}
const rows = [
  mk(1, '2026-09-01', 'win', -110, 1, { model_edge_pct: 0.5, model_prob: 0.53, clv_points: 1.5, beat_close: true }),
  mk(2, '2026-09-02', 'loss', -110, 1, { model_edge_pct: 1.5, model_prob: 0.54, clv_points: -0.5, beat_close: false }),
  mk(3, '2026-09-03', 'loss', 150, 0.5, { model_edge_pct: 2.5, model_prob: 0.43, clv_points: -2.5, beat_close: false }),
  mk(4, '2026-09-04', 'win', 150, 0.5, { model_edge_pct: 4, model_prob: 0.44, clv_points: 2.5, beat_close: true }),
  mk(5, '2026-09-05', 'push', -110, 1, { model_edge_pct: 6, clv_points: 0 }),
  mk(6, '2026-09-06', 'win', -110, 0.25, { model_edge_pct: 8, model_prob: 0.6, clv_points: 0.5, beat_close: true }),
  mk(7, '2026-09-07', 'pending', -110, 1),
  mk(8, '2026-09-08', 'win', null, 1),              /* no entry price: never in P&L */
  mk(9, '2026-09-09', 'void', -110, 1)
];
const F = P.summarize(rows, 'flat'), S = P.summarize(rows, 'staked');
chk('flat: 6 P&L bets (pending, void and unpriced excluded)', F.n === 6, F.n);
chk('flat: record 3-2-1', F.record === '3-2-1', F.record);
chk('flat: net units +1.32', F.net_units === 1.32, F.net_units);
chk('flat: risked 5u (a push returns its stake)', F.risked_units === 5, F.risked_units);
chk('flat: ROI = net / risked × 100 = 26.36%', F.roi_pct === 26.36, F.roi_pct);
chk('flat: win rate 60% (pushes out of the denominator)', F.win_rate_pct === 60, F.win_rate_pct);
chk('flat: max drawdown -2.00u', F.max_drawdown_units === -2, F.max_drawdown_units);
chk('flat: peak +1.32u', F.peak_profit_units === 1.32, F.peak_profit_units);
chk('flat: drawdown began 09-01, recovered 09-06', F.drawdown.max_began === '2026-09-01' && F.drawdown.max_recovered === '2026-09-06', F.drawdown);
chk('flat: longest recovery 5 days', F.drawdown.longest_recovery_days === 5, F.drawdown);
chk('flat: profit factor 3.32 / 2.00 = 1.66', F.profit_factor === 1.66, F.profit_factor);
chk('flat: current streak W2, longest W2 / L2', F.streaks.current === 'W2' && F.streaks.longest_win === 2 && F.streaks.longest_loss === 2, F.streaks);
chk('flat: avg CLV (+1.5 -0.5 -2.5 +2.5 0 +0.5)/6 = +0.25', F.avg_clv_points === 0.25, F.avg_clv_points);
chk('flat: CLV hit rate 3 of 5 measured = 60%', F.clv_hit_rate_pct === 60, F.clv_hit_rate_pct);
chk('flat: avg odds from mean decimal (+115)', F.avg_odds === 115, F.avg_odds);
chk('flat: break-even from those prices 46.61%', F.break_even_pct === 46.61, F.break_even_pct);
chk('staked: net units at recommended stakes +0.39', S.net_units === 0.39, S.net_units);
chk('staked: risked 3.25u', S.risked_units === 3.25, S.risked_units);
chk('staked: ROI 11.89%', S.roi_pct === 11.89, S.roi_pct);
chk('staked: max drawdown -1.50u, not recovered', S.max_drawdown_units === -1.5 && S.drawdown.max_recovered === null, S.drawdown);
chk('staked: currently underwater', S.drawdown.underwater === true && S.current_drawdown_units < 0);
chk('the two strategies are different numbers (never mixed)', F.net_units !== S.net_units);

const ser = P.series(rows, 'flat');
chk('series: one point per bet, chronological', ser.length === 6 && ser[0].id === 'r1' && ser[5].id === 'r6');
chk('series: running peak and drawdown', ser[2].cum === -1.0909 && ser[2].peak === 0.9091 && ser[2].dd === -2, ser[2]);
chk('series: the last point is the net', near(ser[5].cum, 1.3182));

/* profit factor with no losses */
const allWin = [mk(1, '2026-09-01', 'win', -110, 1), mk(2, '2026-09-02', 'win', 120, 1)];
const W = P.summarize(allWin, 'flat');
chk('profit factor with no losing units is null, and says why', W.profit_factor === null && /no losing/.test(W.profit_factor_note));
chk('no drawdown on an all-winning path', W.max_drawdown_units === 0 && W.drawdown.max_began === null);
/* a path that loses from the first bet */
const down = [mk(1, '2026-09-01', 'loss', -110, 1), mk(2, '2026-09-02', 'loss', -110, 1), mk(3, '2026-09-03', 'win', -110, 1)];
const D = P.summarize(down, 'flat');
chk('drawdown is measured from 0 when the first bet loses', D.max_drawdown_units === -2 && D.peak_profit_units === 0, D);
chk('current streak after L, L, W is W1', D.streaks.current === 'W1' && D.streaks.longest_loss === 2);
chk('an empty strategy prints nothing it does not know: no ROI, and no 0.00u that reads like a result', (function () { var e = P.summarize([], 'flat'); return e.n === 0 && e.roi_pct === null && e.net_units === null && e.risked_units === null && e.max_drawdown_units === null && e.peak_profit_units === null && e.drawdown === null && P.fmtUnits(e.net_units) === '—'; })(), P.summarize([], 'flat'));

/* ── breakdowns, calibration, CLV ──────────────────────────────────── */
const bd = P.breakdown(rows, (x) => P.edgeBucket(x.model_edge_pct), 'flat', P.EDGE_BUCKETS.map((b) => b[2]));
chk('edge breakdown: ordered by bucket', bd.map((x) => x.key).join(',') === '0–1%,1–2%,2–3%,3–5%,5–7%,7%+', bd.map((x) => x.key));
chk('edge breakdown: the 0–1% bucket is the one -110 winner', bd[0].n === 1 && bd[0].net_units === 0.91);
chk('unit tier labels', P.unitTier(0.25) === '0.25u' && P.unitTier(1) === '1.00u' && P.unitTier(0) === null);
chk('odds buckets', P.oddsBucket(-110) === '−114 to −105' && P.oddsBucket(150) === '+150 to +249' && P.oddsBucket(0) === null);
chk('record-only W-L for unpriced rows', P.recordOnly(rows).record === '1-0', P.recordOnly(rows));

const cal = P.calibration(rows, 'flat');
chk('calibration: eight edge buckets', cal.length === 8 && cal[7].bucket === '10%+');
chk('calibration: expected win % is the mean model probability', cal[0].expected_win_pct === 53 && cal[0].actual_win_pct === 100, cal[0]);
chk('calibration: no verdict from one bet', cal[0].verdict.key === 'INSUFFICIENT');
chk('calibration: small-sample warning on every thin bucket', cal.every((b) => b.sample.warn));
/* a large, well-calibrated bucket and a large overconfident one */
function many(n, p, winRate, edge) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(mk('c' + edge + '_' + i, '2026-10-01', i < Math.round(n * winRate) ? 'win' : 'loss', -110, 1, { model_edge_pct: edge, model_prob: p }));
  return out;
}
const cal2 = P.calibration(many(200, 0.55, 0.55, 2.5).concat(many(200, 0.6, 0.45, 5.5)), 'flat');
chk('calibration: 55% claimed, 55% hit → consistent', cal2[2].verdict.key === 'CALIBRATED', cal2[2]);
chk('calibration: 60% claimed, 45% hit → overconfident', cal2[5].verdict.key === 'OVERCONFIDENT', cal2[5]);
const cal3 = P.calibration(many(200, 0.5, 0.62, 1.5), 'flat');
chk('calibration: 50% claimed, 62% hit → underconfident', cal3[1].verdict.key === 'UNDERCONFIDENT', cal3[1]);

const cv = P.clvAnalysis(rows, 'flat');
chk('CLV split: 3 positive-CLV bets, all won', cv.positive.n === 3 && cv.positive.record === '3-0', cv.positive);
chk('CLV split: 2 negative-CLV bets, both lost', cv.negative.n === 2 && cv.negative.record === '0-2', cv.negative);
chk('CLV split: the push had no beat/lose reading', cv.unmeasured.n === 1);
chk('CLV buckets: six ranges', cv.buckets.length === 6 && cv.buckets[0].n === 1 && cv.buckets[5].n === 1, cv.buckets.map((b) => b.n));

const dq = P.dataQuality(rows.concat([P.settle({ recommendation_id: 's', entry_odds: -110, price_assumed: true, result: 'win' })]));
chk('data quality: verified / pending / void / missing / simulated', dq.verified === 6 && dq.pending === 1 && dq.voids === 1 && dq.missing_entry_odds === 1 && dq.simulated_price === 1, dq);
chk('data quality: not P&L eligible = missing + simulated', dq.not_pnl_eligible === 2, dq);

/* ── the one state of every row ────────────────────────────────────── */
{
  const base = { event_id: 'g1', game_date: '2026-10-04T17:00:00.000Z', recommended_at: '2026-10-03T12:00:00.000Z', side: 'home', selection: 'BUF -3', rec_class: 'BET', stake_units: 1 };
  let sid = 0;
  const S = (o) => P.settle(Object.assign({ recommendation_id: 'st' + (++sid) }, base, o));
  chk('state: no result yet → PENDING', S({ entry_odds: -110, result: 'pending' }).record_state === 'PENDING');
  chk('state: settled at a captured price → VERIFIED', S({ entry_odds: -110, result: 'win' }).record_state === 'VERIFIED');
  const ro = S({ entry_odds: null, result: 'loss' });
  chk('state: a result with no entry price → RECORD_ONLY, with the reason, and no units', ro.record_state === 'RECORD_ONLY' && /entry price not captured/.test(ro.state_reason) && ro.flat_profit_units === null && ro.profit_units === null, ro);
  chk('state: a simulated (assumed) price is RECORD_ONLY, never verified', S({ entry_odds: -110, price_assumed: true, result: 'win' }).record_state === 'RECORD_ONLY');
  chk('state: an invalid stored price is RECORD_ONLY once settled', S({ entry_odds: 50, result: 'win' }).record_state === 'RECORD_ONLY');
  chk('state: void → VOID', S({ entry_odds: -110, result: 'void' }).record_state === 'VOID' && S({ entry_odds: null, result: 'void' }).record_state === 'VOID');
  const bad = S({ entry_odds: -110, result: 'graded?' });
  chk('state: an unreadable settlement is INVALID with the value, never quietly pending', bad.record_state === 'INVALID' && /graded\?/.test(bad.state_reason) && bad.profit_units === null, bad);
  const lateBet = S({ entry_odds: -110, result: 'win', recommended_at: '2026-10-04T18:00:00.000Z' });
  chk('state: a recommendation stamped after kickoff is INVALID, and graded nowhere (no P&L, not a verified bet)', lateBet.record_state === 'INVALID' && lateBet.flat_profit_units === null && lateBet.profit_units === null && P.betsOf([lateBet], 'flat').length === 0, lateBet);
  chk('state: the model record\'s own rows are pregame by its rule, never refused here', S({ rec_class: 'MODEL', entry_odds: null, result: 'win', recommended_at: '2026-10-04T18:00:00.000Z' }).record_state === 'RECORD_ONLY');
  chk('state: a row with no game is INVALID', S({ event_id: null, game_date: null, entry_odds: -110, result: 'win' }).record_state === 'INVALID');
  chk('state: a row written before record_state existed is read the same way', P.rowState({ result: 'win', pnl_status: 'VERIFIED', event_id: 'x', side: 'home' }) === 'VERIFIED' && P.rowState({ result: 'pending', event_id: 'x', side: 'home' }) === 'PENDING');

  /* the record: model picks + BET, never PASS / WATCH, LEAN on request */
  const rows2 = [
    S({ rec_class: 'MODEL', entry_odds: null, result: 'win', market_type: 'spread', league: 'CFB', model_version: 'm1', week: 2 }),
    S({ rec_class: 'MODEL', entry_odds: null, result: 'loss', market_type: 'spread', league: 'NFL', model_version: 'm2', week: 2 }),
    S({ rec_class: 'MODEL', entry_odds: null, result: 'push', market_type: 'total', league: 'NFL', model_version: 'm2', week: 3 }),
    S({ rec_class: 'BET', entry_odds: 120, result: 'win', market_type: 'player_prop', league: 'NFL', model_version: 'p1', week: 3 }),
    S({ rec_class: 'BET', entry_odds: -110, result: 'pending', market_type: 'player_prop', league: 'NFL', model_version: 'p1', week: 4 }),
    S({ rec_class: 'LEAN', entry_odds: -110, result: 'loss', market_type: 'player_prop', league: 'NFL', model_version: 'p1', week: 3 }),
    S({ rec_class: 'PASS', entry_odds: -110, result: 'loss', market_type: 'spread', league: 'CFB', model_version: 'm1', week: 2 }),
    S({ rec_class: 'BET', entry_odds: -110, result: 'void', market_type: 'player_prop', league: 'NFL', model_version: 'p1', week: 3 })
  ];
  const st = P.states(rows2);
  chk('states: every row exactly once', st.total === 8 && P.STATE_ORDER.reduce((a, k) => a + st[k], 0) === 8 && st.PENDING === 1 && st.VERIFIED === 3 && st.RECORD_ONLY === 3 && st.VOID === 1, st);
  const recRows = rows2.filter((x) => P.inRecord(x, false));
  const R = P.gradedRecord(recRows);
  chk('record: model picks and BETs, priced or not — 2-1-1 over 4 graded; PASS and LEAN left out', R.record === '2-1-1' && R.graded === 4 && R.verified === 1 && R.record_only === 3 && R.pending === 1 && R.voids === 1 && R.tracked === 6, R);
  chk("record: win rate leaves pushes out", R.win_rate_pct === 66.6667, R.win_rate_pct);
  chk('record: leans join only when asked', P.gradedRecord(rows2.filter((x) => P.inRecord(x, true))).record === '2-2-1');
  const RB = P.recordBreakdowns(recRows);
  const sumOf = (g) => g.reduce((a, x) => [a[0] + x.wins, a[1] + x.losses, a[2] + x.pushes], [0, 0, 0]).join('-');
  chk('record by sport / market / model version / week each add up to the whole', ['league', 'market', 'model_version', 'week'].every((k) => sumOf(RB[k]) === '2-1-1'), Object.keys(RB).map((k) => k + ' ' + sumOf(RB[k])));
  chk('record by market: spread 1-1, totals 0-0-1, props 1-0 (and one pending)', RB.market.map((x) => x.key + ' ' + x.record + (x.pending ? ' +' + x.pending : '')).join() === 'Spread 1-1,Total 0-0-1,Player Props 1-0 +1', RB.market.map((x) => x.key + ' ' + x.record));

  /* the tabs: a player prop is its own record, never also its league's */
  const grp = (x) => Object.assign({}, x, { market_group: x.market_type === 'player_prop' ? 'prop' : 'game' });
  const rows3 = rows2.concat([S({ rec_class: 'BET', entry_odds: 105, result: 'loss', market_type: 'player_prop', league: 'CFB', week: 2 })]).map(grp);
  const ids = (k) => P.scopeRows(rows3, k).map((x) => x.recommendation_id).sort();
  chk('scopes: NFL and CFB hold only their game markets — no player prop', P.scopeRows(rows3, 'nfl').every((x) => x.league === 'NFL' && x.market_group === 'game') && P.scopeRows(rows3, 'cfb').every((x) => x.league === 'CFB' && x.market_group === 'game')
    && ids('nfl').length === 2 && ids('cfb').length === 2, [ids('nfl'), ids('cfb')]);
  chk('scopes: Player Props holds every prop, NFL and college, and nothing else', ids('props').length === 5 && P.scopeRows(rows3, 'props').every((x) => x.market_group === 'prop'), ids('props'));
  chk('scopes: NFL + CFB + Player Props = All, each row exactly once', ids('nfl').concat(ids('cfb'), ids('props')).sort().join() === ids('all').join(), [ids('nfl'), ids('cfb'), ids('props')]);
  const RB3 = P.recordBreakdowns(rows3.filter((x) => P.inRecord(x, false)));
  chk('record by sport: NFL games, college games and player props apart — the tabs', RB3.league.map((x) => x.key + ' ' + x.record).join() === 'NFL 0-1-1,College Football 1-0,Player Props 1-1', RB3.league.map((x) => x.key + ' ' + x.record));
  chk('P&L by sport: the priced props are not inside NFL', P.breakdowns(rows3, 'flat').league.map((x) => x.key + ' ' + x.n).join() === 'NFL 0,College Football 0,Player Props 2', P.breakdowns(rows3, 'flat').league.map((x) => x.key + ' ' + x.n));

  const pr = P.pendingReasons([Object.assign({}, rows2[4], { pending_reason: 'UPCOMING' }), Object.assign({}, rows2[4], { pending_reason: 'MISSING_PLAYER_STAT' }), rows2[4], rows2[0]]);
  chk('pending reasons: counted per reason, a row without one is UNKNOWN, settled rows ignored', pr.total === 3 && pr.reasons.map((x) => x.key + ' ' + x.n).join() === 'UPCOMING 1,MISSING_PLAYER_STAT 1,UNKNOWN 1', pr);
  chk('pending reasons: with the reader\'s clock, a reasonless row before its kickoff is UPCOMING — after it, still UNKNOWN (never guessed)',
    P.pendingReasonOf(rows2[4], Date.parse('2026-10-01T00:00:00Z')) === 'UPCOMING' && P.pendingReasonOf(rows2[4], Date.parse('2026-10-05T00:00:00Z')) === 'UNKNOWN'
    && P.pendingReasonOf(Object.assign({}, rows2[4], { pending_reason: 'MISSING_FINAL' }), Date.parse('2026-10-01T00:00:00Z')) === 'MISSING_FINAL');

  /* integrity: the page's figures agree, and a broken row is caught */
  const I = P.integrity(rows2, 'flat', false);
  chk('integrity: every check passes on a sound dataset', I.ok && I.n >= 10, I.failed);
  const I2 = P.integrity(rows2, 'flat', true);
  chk('integrity: also with leans counted', I2.ok, I2.failed);
  const forged = rows2.concat([Object.assign({}, rows2[3], { recommendation_id: 'forged', entry_odds: null })]);
  const I3 = P.integrity(forged, 'flat', false);
  chk('integrity: a VERIFIED row with no captured price is an internal error, not a quiet number', !I3.ok && I3.failed.some((f) => f.key === 'verified_priced'), I3.failed);
  const unitsOnRecord = rows2.concat([Object.assign({}, rows2[0], { recommendation_id: 'ro_units', flat_profit_units: 0.91 })]);
  chk('integrity: units on a record-only row are an internal error', P.integrity(unitsOnRecord, 'flat', false).failed.some((f) => f.key === 'record_only_unpriced'));
  const E = P.integrity([], 'flat', false);
  chk('integrity: an empty view passes (nothing to disagree about)', E.ok, E.failed);
}

/* ── sample labels ─────────────────────────────────────────────────── */
chk('n < 20: very small sample', P.sampleLabel(19).key === 'VERY_SMALL' && P.sampleLabel(19).warn);
chk('20–49: small sample', P.sampleLabel(20).key === 'SMALL' && P.sampleLabel(49).key === 'SMALL');
chk('50–99: developing sample', P.sampleLabel(50).key === 'DEVELOPING' && P.sampleLabel(99).key === 'DEVELOPING');
chk('100+: more meaningful sample', P.sampleLabel(100).key === 'MEANINGFUL' && !P.sampleLabel(100).warn);
chk('a 6-2 record is labelled very small, with a warning', /unstable/.test(P.sampleLabel(8).text));

/* ── dollars and formatting ────────────────────────────────────────── */
chk('dollars: 8.42u at the reader\'s $25 unit = $210.50', P.dollars(8.42, 25) === 210.5);
chk('dollars: no unit value → no dollars (never a default)', P.dollars(8.42, null) === null && P.dollars(8.42, 0) === null);
chk('format: +8.42u', P.fmtUnits(8.42) === '+8.42u');
chk('format: −4.18u', P.fmtUnits(-4.18) === '−4.18u');
chk('format: 0.00u, unsigned', P.fmtUnits(0) === '0.00u' && P.fmtUnits(-0.001) === '0.00u');
chk('format: odds', P.fmtOdds(-110) === '−110' && P.fmtOdds(150) === '+150' && P.fmtOdds(0) === '—');
chk('format: dollars', P.fmtDollars(210.5) === '+$210.50' && P.fmtDollars(-1234.5) === '−$1,234.50');
chk('tone', P.tone(1) === 'pos' && P.tone(-1) === 'neg' && P.tone(0) === 'flat' && P.tone(null) === 'flat');
chk('the help text defines P&L as the spec words it', /Unlike win percentage, P&L reflects the actual price paid for each wager/.test(P.HELP.pnl));
chk('ROI help says it is not wins over losses', /not wins divided by losses/.test(P.HELP.roi));

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'P&L kernel — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
