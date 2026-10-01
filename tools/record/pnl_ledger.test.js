#!/usr/bin/env node
/* ===========================================================================
   tools/record/pnl_ledger.js + pnl_core.js — the P&L ledger, end to end.

   A throwaway repository root holds every ledger the builder reads (player
   props, game decisions for BOTH leagues, the football model record), and
   each rule the Record's P&L section promises is proved on it:

     - moneyline, spread, total, player prop over and under, at the price and
       stake recorded at the time; flat 1u and EdgeDesk staking kept apart;
     - push, void, pending, a missing entry price (never -110), LEAN and PASS
       graded but never counted as bets;
     - idempotent: a second build changes nothing; a duplicated settlement or
       a duplicated source row is counted once;
     - a corrected final score and a corrected player statistic update the
       SAME row and are logged on it; nothing is deleted; the recommendation
       half of a row can never be rewritten by a source.

   Run: node tools/record/pnl_ledger.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const L = require('./pnl_ledger.js');
const core = require('./pnl_core.js');
const FR = require('./football_record_core.js');
const PNL = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));

let pass = 0, fail = 0;
function chk(label, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL | ' + label + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-4;

/* ------------------------------------------------------------ fixtures */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-'));
const P = (...a) => path.join(TMP, ...a);
const jsonl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
function put(rel, text) { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), text); }

const K1 = '2026-09-20T17:00:00.000Z', K2 = '2026-09-27T17:00:00.000Z', K3 = '2026-10-04T17:00:00.000Z';
/* player props: BET over, BET under, LEAN, VOID, pending, and a legacy row with no price */
const ev = (id, o) => Object.assign({ schema: 'edgedesk_player_props_evaluation_v1', kind: 'qualified', evaluation_id: id, selection_key: id, prop_id: 'nfl|2026_03_KC_DEN|00-0033873|pass_yds',
  league: 'nfl', season: 2026, week: 3, game_id: '2026_03_KC_DEN', kickoff: K1, player_id: '00-0033873', player_name: 'Patrick Mahomes', team: 'KC', opp: 'DEN', position: 'QB',
  market: 'pass_yds', evaluated_at: '2026-09-19T12:00:00.000Z', decision: 'BET', code: 'QUALIFIES', units: 0.5, confidence: 74, probability_source: 'model_estimated', stage: 'TRACKING',
  side: 'over', line: 276.5, american: -110, book: 'draftkings', p_side: 0.58, ev: 0.1, edge_pp: 4.2, model_mean: 284.1, model_version: 'edgedesk_props_model_v1' }, o);
const EVALS = [
  ev('ppe_over'),
  ev('ppe_under', { market: 'receptions', prop_id: 'nfl|2026_03_KC_DEN|00-0039000|receptions', player_id: '00-0039000', player_name: 'Rashee Rice', position: 'WR', side: 'under', line: 5.5, american: 150, units: 0.25, book: 'fanduel', edge_pp: 7.5, p_side: 0.47 }),
  ev('ppe_lean', { decision: 'LEAN', units: 0, side: 'under', line: 30.5, market: 'rush_yds', american: -150, edge_pp: 2.2, book: 'betmgm' }),
  ev('ppe_void', { market: 'rec_yds', player_id: '00-0039001', player_name: 'Hurt Player', side: 'over', line: 44.5, american: -115, units: 0.75, edge_pp: 5.1 }),
  ev('ppe_pend', { game_id: '2026_05_KC_JAX', kickoff: K3, week: 5, side: 'under', line: 250.5, american: -105, units: 1, edge_pp: 3.4 }),
  ev('ppe_noprice', { decision: 'BET', american: null, units: 0.5, market: 'pass_tds', side: 'over', line: 1.5, edge_pp: 6 })
];
const RESULTS = [
  { evaluation_id: 'ppe_over', kind: 'qualified', result: 'WIN', value: 301, graded_at: '2026-09-21T09:00:00.000Z', clv: { available: true, close_line: 278.5, line_clv: 2, beat_close: true } },
  { evaluation_id: 'ppe_under', kind: 'qualified', result: 'LOSS', value: 7, graded_at: '2026-09-21T09:00:00.000Z', clv: { available: true, close_line: 5.5, line_clv: 0, close_price: 135, prob_clv_pp: -1.4, beat_close: false } },
  { evaluation_id: 'ppe_lean', kind: 'qualified', result: 'WIN', value: 18, graded_at: '2026-09-21T09:00:00.000Z' },
  { evaluation_id: 'ppe_void', kind: 'qualified', result: 'VOID', reason: 'player did not play', graded_at: '2026-09-21T09:00:00.000Z' },
  { evaluation_id: 'ppe_noprice', kind: 'qualified', result: 'WIN', value: 3, graded_at: '2026-09-21T09:00:00.000Z' },
  /* the same settlement written twice (a re-run that did not dedupe): one row, counted once */
  { evaluation_id: 'ppe_over', kind: 'qualified', result: 'WIN', value: 301, graded_at: '2026-09-21T09:00:00.000Z', clv: { available: true, close_line: 278.5, line_clv: 2, beat_close: true } }
];
put('football/props/nfl/2026/evaluations.jsonl', jsonl(EVALS));
put('football/props/nfl/2026/results.jsonl', jsonl(RESULTS));

/* game decisions: CFB spread (BET, PASS, WATCH) and NFL total + moneyline BETs */
const snap = (id, o) => Object.assign({ schema: 'edgedesk_bettor_decision_snapshot_v1', snapshot_id: id, game_id: '401900001', sport: 'CFB', market_key: 'CFB:spread', market_type: 'spread',
  home: 'Utah', away: 'Arkansas', kickoff: K2, decision: 'BET', recommended_units: 0.75, evaluated_at: '2026-09-26T12:00:00.000Z', quote_captured_at: '2026-09-26T11:59:00.000Z',
  model_version: 'edgedesk_cfb_p4_v1.0.0', decision_engine_version: 'edgedesk_football_decision_v2', model_fair_line: -9.5, probability: 0.56, edge_pp: 3.6, decision_ev_pct: 6.9,
  evaluation_mode: 'LIVE', bet_price: { side: 'home', team: 'Utah', line: -6.5, odds: -110, book: 'draftkings', captured_at: '2026-09-26T11:59:00.000Z' } }, o);
const SNAPS = [
  snap('bds_cfb_bet'),
  snap('bds_cfb_pass', { game_id: '401900002', home: 'Iowa', away: 'Ohio State', decision: 'PASS', recommended_units: 0, bet_price: null, reference_quote: { side: 'away', team: 'Ohio State', line: -3, odds: -105, book: 'fanduel' }, edge_pp: -1.2, probability: 0.49 }),
  snap('bds_cfb_watch', { game_id: '401900003', home: 'Tulsa', away: 'Navy', decision: 'WAIT', recommended_units: 0, bet_price: null, reference_quote: { side: 'home', team: 'Tulsa', line: 2.5, odds: -112, book: 'betmgm' }, edge_pp: 1.4, probability: 0.53 }),
  snap('bds_cfb_nodec', { game_id: '401900004', decision: 'NO_DECISION', recommended_units: 0, bet_price: null, reference_quote: null }),
  snap('bds_cfb_backtest', { game_id: '401900005', evaluation_mode: 'BACKTEST' })
];
const DEVALS = [
  { snapshot_id: 'bds_cfb_bet', result: 'win', close_line: -7.5, clv_points: 1, graded_at: '2026-09-28T09:00:00.000Z' },
  { snapshot_id: 'bds_cfb_pass', result: 'loss', close_line: -3.5, clv_points: -0.5, graded_at: '2026-09-28T09:00:00.000Z' },
  { snapshot_id: 'bds_cfb_watch', result: 'push', close_line: 2.5, clv_points: 0, graded_at: '2026-09-28T09:00:00.000Z' }
];
put('football/cfb_terminal/decisions/2026/snapshots.jsonl', jsonl(SNAPS));
put('football/cfb_terminal/decisions/2026/evaluations.jsonl', jsonl(DEVALS));
const NSNAPS = [
  snap('bds_nfl_total', { sport: 'NFL', market_key: 'NFL:total', market_type: 'total', game_id: '2026_03_KC_DEN', home: 'Denver Broncos', away: 'Kansas City Chiefs', kickoff: K1, recommended_units: 1,
    evaluated_at: '2026-09-19T12:00:00.000Z', model_version: 'edgedesk_football_v1.0.0', bet_price: { side: 'under', line: 44.5, odds: -105, book: 'pinnacle', captured_at: '2026-09-19T11:59:00.000Z' } }),
  snap('bds_nfl_ml', { sport: 'NFL', market_key: 'NFL:moneyline', market_type: 'moneyline', game_id: '2026_03_KC_DEN', home: 'Denver Broncos', away: 'Kansas City Chiefs', kickoff: K1, recommended_units: 1,
    evaluated_at: '2026-09-19T12:05:00.000Z', model_version: 'edgedesk_football_v1.1.0', bet_price: { side: 'home', team: 'Denver Broncos', line: null, odds: 135, book: 'betrivers', captured_at: '2026-09-19T12:04:00.000Z' } })
];
put('football/nfl_terminal/decisions/2026/snapshots.jsonl', jsonl(NSNAPS));
put('football/nfl_terminal/decisions/2026/evaluations.jsonl', jsonl([
  { snapshot_id: 'bds_nfl_total', result: 'loss', close_line: 45.5, clv_points: -1, graded_at: '2026-09-21T09:00:00.000Z' },
  { snapshot_id: 'bds_nfl_ml', result: 'win', graded_at: '2026-09-21T09:00:00.000Z' }
]));

/* the football model record: one graded NFL game (lines only, never a price) */
function modelRecord(final) {
  const Lg = FR.emptyLedger('nfl', 2026);
  const p = FR.projectionFromSlate('nfl', { model_status: 'PREDICTED', game_id: '2026_03_KC_DEN', season: 2026, week: 3, kickoff: K1, home_team: 'Denver Broncos', away_team: 'Kansas City Chiefs',
    home_code: 'DEN', away_code: 'KC', model_home_line: 1.5, model_fair_total: 46.1, model_home_win_prob: 0.46, model_version: 'edgedesk_football_v1.0.0',
    reference_market: { home_line: 2.5, total: 47.5 } }, { season: 2026 });
  FR.recordProjection(Lg, p, { published_at: '2026-09-18T10:00:00.000Z', market: { home_line: 2.5, total: 47.5, source: 'nflverse', book: 'consensus', at: '2026-09-18T10:00:00.000Z' } });
  FR.setClose(Lg.games['2026_03_KC_DEN'], { home_line: 3.5, total: 46.5, source: 'nflverse', book: 'consensus' }, '2026-09-20T18:00:00.000Z');
  Lg.games['2026_03_KC_DEN'].final = final;
  FR.gradeLedger(Lg, '2026-09-22T00:00:00.000Z');
  return Lg;
}
put('record/football/nfl_2026.json', JSON.stringify(modelRecord({ home_score: 20, away_score: 27, source: 'nflverse', at: '2026-09-21T02:00:00.000Z' })));
/* things the builder must leave out, and count */
put('football/cfb_lab/ledger/2026/evaluations.jsonl', jsonl([{ price_assumed: true, ats_result: 'WIN', origin: 'GIT_RECONSTRUCTED' }, { price_assumed: true, ats_result: 'LOSS', origin: 'REPLAY' }]));

const NOW1 = '2026-09-30T00:00:00.000Z', NOW2 = '2026-09-30T01:00:00.000Z', NOW3 = '2026-09-30T02:00:00.000Z';
function build(now) { return L.build({ root: TMP, out: 'record/pnl', season: 2026, now }); }
function write(B) {
  fs.mkdirSync(path.dirname(B.files.ledger), { recursive: true });
  fs.writeFileSync(B.files.ledger, JSON.stringify(B.ledger, null, 1) + '\n');
  fs.writeFileSync(B.files.summary, JSON.stringify(B.summary, null, 1) + '\n');
  fs.writeFileSync(B.files.rows, JSON.stringify(B.page));
  fs.writeFileSync(B.files.stamp, JSON.stringify(B.stamp, null, 1) + '\n');
}
const byId = (B) => { const o = {}; B.ledger.rows.forEach((x) => { o[x.recommendation_id] = x; }); return o; };

try {
  /* ============================================================ first build */
  const B1 = build(NOW1), R = byId(B1);
  chk('every source is read: props, CFB and NFL decisions, the model record', B1.summary.sources.map((s) => s.source).join(',') === 'player_props,bettor_decision,bettor_decision,model_record', B1.summary.sources);
  chk('player prop Over (BET 0.50u at -110) WIN: flat +0.9091, staked +0.4545', R['pp:ppe_over'].pnl_status === 'VERIFIED' && near(R['pp:ppe_over'].flat_profit_units, 0.9091) && near(R['pp:ppe_over'].profit_units, 0.4545), R['pp:ppe_over']);
  chk('player prop Over: selection, model line, entry and close are the recorded ones', R['pp:ppe_over'].selection === 'Over 276.5' && R['pp:ppe_over'].model_line === 284.1 && R['pp:ppe_over'].entry_line === 276.5 && R['pp:ppe_over'].closing_line === 278.5 && R['pp:ppe_over'].clv_points === 2);
  chk('player prop Under (BET 0.25u at +150) LOSS: flat -1, staked -0.25', R['pp:ppe_under'].flat_profit_units === -1 && R['pp:ppe_under'].profit_units === -0.25 && R['pp:ppe_under'].selection === 'Under 5.5');
  chk('prop categories come from the props registry (no hardcoded list)', R['pp:ppe_under'].prop_label === 'Receptions' && R['pp:ppe_under'].prop_category_label === 'Receiving' && R['pp:ppe_over'].prop_category_label === 'Passing');
  chk('a LEAN is graded at a flat 1u and carries no stake', R['pp:ppe_lean'].rec_class === 'LEAN' && near(R['pp:ppe_lean'].flat_profit_units, 0.6667) && R['pp:ppe_lean'].profit_units == null && R['pp:ppe_lean'].stake_units === 0);
  chk('a VOID returns the stake: 0, and is not a P&L bet', R['pp:ppe_void'].pnl_status === 'VOID' && R['pp:ppe_void'].flat_profit_units === 0);
  chk('an unsettled prop is PENDING with no P&L', R['pp:ppe_pend'].pnl_status === 'PENDING' && R['pp:ppe_pend'].flat_profit_units == null);
  chk('missing historical entry price: NO_ENTRY_PRICE, P&L null, never -110', R['pp:ppe_noprice'].pnl_status === 'NO_ENTRY_PRICE' && R['pp:ppe_noprice'].flat_profit_units == null && R['pp:ppe_noprice'].profit_units == null && R['pp:ppe_noprice'].missing_entry_odds === true);
  chk('the duplicated settlement produced one row', B1.ledger.rows.filter((x) => x.recommendation_id === 'pp:ppe_over').length === 1);
  chk('event names come from the model record for the same game id', R['pp:ppe_over'].event_label === 'KC @ DEN' && R['pp:ppe_over'].home === 'Denver Broncos');

  chk('CFB spread BET (0.75u at -110) WIN: flat +0.9091, staked +0.6818', near(R['bd:bds_cfb_bet'].flat_profit_units, 0.9091) && near(R['bd:bds_cfb_bet'].profit_units, 0.6818) && R['bd:bds_cfb_bet'].selection === 'Utah -6.5', R['bd:bds_cfb_bet']);
  chk('the spread model line is the side\'s own fair line', R['bd:bds_cfb_bet'].model_line === -9.5 && R['bd:bds_cfb_bet'].entry_line === -6.5 && R['bd:bds_cfb_bet'].closing_line === -7.5);
  chk('a PASS is graded at its reference price, flat only, never a bet', R['bd:bds_cfb_pass'].rec_class === 'PASS' && R['bd:bds_cfb_pass'].flat_profit_units === -1 && R['bd:bds_cfb_pass'].stake_units === 0);
  chk('WAIT is filed as WATCH; a push is 0', R['bd:bds_cfb_watch'].rec_class === 'WATCH' && R['bd:bds_cfb_watch'].flat_profit_units === 0 && R['bd:bds_cfb_watch'].result === 'push');
  chk('NO DECISION and a BACKTEST snapshot never enter the ledger', !R['bd:bds_cfb_nodec'] && !R['bd:bds_cfb_backtest']);
  chk('NFL total BET (1u at -105) LOSS: -1', R['bd:bds_nfl_total'].league === 'NFL' && R['bd:bds_nfl_total'].market_type === 'total' && R['bd:bds_nfl_total'].selection === 'Under 44.5' && R['bd:bds_nfl_total'].profit_units === -1);
  chk('NFL moneyline BET (1u at +135) WIN: +1.35', R['bd:bds_nfl_ml'].market_type === 'moneyline' && R['bd:bds_nfl_ml'].selection === 'Denver Broncos ML' && near(R['bd:bds_nfl_ml'].profit_units, 1.35), R['bd:bds_nfl_ml']);
  chk('the odds timestamp is the quote capture time', R['bd:bds_nfl_ml'].odds_captured_at === '2026-09-19T12:04:00.000Z' && R['bd:bds_cfb_bet'].odds_captured_at === '2026-09-26T11:59:00.000Z');

  const mr = B1.ledger.rows.filter((x) => x.source === 'model_record');
  chk('the model record gives spread, total and moneyline rows for a graded game', mr.map((x) => x.market_type).sort().join() === 'moneyline,spread,total', mr.map((x) => x.market_type));
  chk('model record rows: result kept, P&L never invented', mr.every((x) => x.pnl_status === 'NO_ENTRY_PRICE' && x.entry_odds == null && x.flat_profit_units == null && x.missing_entry_odds === true));
  const mrs = mr.find((x) => x.market_type === 'spread');
  chk('model record spread: side and result from the record\'s own grade, graded at the close', mrs.side === 'home' && mrs.selection === 'DEN +3.5' && mrs.result === 'loss' && mrs.closing_line === 3.5, mrs);
  chk('model record CLV in points from the same source family', mrs.clv_points === -1 && mrs.beat_close === false, mrs);

  /* ============================================================ summary */
  const S = B1.summary, F = S.views.all.flat.summary, ST = S.views.all.staked.summary;
  chk('the strategy is BET only: 8 BET rows, 5 verified (void, pending and the unpriced one are out)', S.counts.bets === 8 && S.counts.verified_bets === 5 && F.n === 5, [S.counts, F.n]);
  chk('flat: record 3-2 over the verified BETs', F.record === '3-2', F.record);
  chk('flat: net units = 0.9091 - 1 + 0.9091 - 1 + 1.35 = +1.17', F.net_units === 1.17, F.net_units);
  chk('flat: ROI = 1.1682 / 5 = 23.36%', F.roi_pct === 23.36, F.roi_pct);
  chk('staked: net units = 0.4545 - 0.25 + 0.6818 - 1 + 1.35 = +1.24', ST.net_units === 1.24, ST.net_units);
  chk('staked: risked 3.5u', ST.risked_units === 3.5, ST.risked_units);
  chk('flat and staked never mixed', F.net_units !== ST.net_units);
  chk('the chart series is chronological, one point per bet', S.views.all.flat.series.length === 5 && S.views.all.flat.series[0][0] <= S.views.all.flat.series[4][0]);
  chk('scopes: NFL / CFB / props / game markets', S.views.nfl.flat.summary.n === 4 && S.views.cfb.flat.summary.n === 1 && S.views.props.flat.summary.n === 2 && S.views.game.flat.summary.n === 3,
    ['nfl', 'cfb', 'props', 'game'].map((k) => S.views[k].flat.summary.n));
  chk('game markets vs props, side by side', S.views.all.flat.compare.game.n === 3 && S.views.all.flat.compare.props.n === 2);
  const grade = S.views.all.flat.breakdowns.grade;
  chk('by grade: BET, LEAN, WATCH, PASS each at flat 1u', grade.map((g) => g.key).join() === 'Bet,Lean,Watch,Pass', grade.map((g) => g.key));
  chk('by market: spread, moneyline, total, player props', S.views.all.flat.breakdowns.market.map((m) => m.key).join() === 'Spread,Moneyline,Total,Player Props', S.views.all.flat.breakdowns.market.map((m) => m.key));
  chk('by book: only books with a captured price', S.books.indexOf('DraftKings') >= 0 && S.books.indexOf('consensus') < 0, S.books);
  chk('by model version: versions are never merged', S.views.all.flat.breakdowns.model_version.map((m) => m.key).join() === 'edgedesk_cfb_p4_v1.0.0,edgedesk_football_v1.0.0,edgedesk_football_v1.1.0,edgedesk_props_model_v1', S.views.all.flat.breakdowns.model_version.map((m) => m.key));
  chk('by unit size: the staked tiers', S.views.all.staked.breakdowns.unit_size.map((u) => u.key).join() === '0.25u,0.50u,0.75u,1.00u');
  const dq = S.views.all.data_quality;
  chk('data quality: verified, pending, void, missing entry odds', dq.verified === 8 && dq.pending === 1 && dq.voids === 1 && dq.missing_entry_odds === 4, dq);
  chk('the record-only W-L is kept apart from P&L', S.views.all.flat.record_only.n === 4, S.views.all.flat.record_only);
  chk('what was excluded is counted, with the reason', S.excluded_sources.length === 2 && S.excluded_sources[0].rows === 1 && /ASSUMED/.test(S.excluded_sources[0].reason), S.excluded_sources);

  /* ============================================================ idempotent */
  write(B1);
  const B2 = build(NOW2);
  chk('a second build over the same inputs changes nothing', B2.report.added === 0 && B2.report.corrected === 0 && B2.report.settled === 0 && B2.report.unchanged === B1.ledger.rows.length, B2.report);
  const strip = (o) => JSON.stringify(Object.assign({}, o, { generated_at: null }));
  chk('byte for byte, apart from the run clock', strip(B2.ledger) === strip(B1.ledger));
  chk('the settlement was not double counted', B2.summary.views.all.flat.summary.net_units === 1.17);
  const cli = cp.spawnSync(process.execPath, [path.join(__dirname, 'pnl_ledger.js'), '--root', TMP, '--season', '2026', '--now', NOW2, '--check'], { encoding: 'utf8' });
  chk('--check: the written files are current', cli.status === 0 && /current/.test(cli.stdout), cli.stdout + cli.stderr);

  /* ============================================================ a pending prop settles (not a correction) */
  put('football/props/nfl/2026/results.jsonl', jsonl(RESULTS.concat([{ evaluation_id: 'ppe_pend', kind: 'qualified', result: 'WIN', value: 212, graded_at: '2026-10-05T09:00:00.000Z' }])));
  const B3 = build(NOW2);
  chk('a pending recommendation settling is a settlement, not a correction', B3.report.settled === 1 && B3.report.corrected === 0 && byId(B3)['pp:ppe_pend'].pnl_status === 'VERIFIED' && !byId(B3)['pp:ppe_pend'].corrected, B3.report);
  write(B3);

  /* ============================================================ corrected player stat */
  put('football/props/nfl/2026/results.jsonl', jsonl(RESULTS.concat([
    { evaluation_id: 'ppe_pend', kind: 'qualified', result: 'WIN', value: 212, graded_at: '2026-10-05T09:00:00.000Z' },
    { evaluation_id: 'ppe_over', kind: 'qualified', result: 'LOSS', value: 270, graded_at: '2026-09-23T09:00:00.000Z', correction: true, corrects: '2026-09-21T09:00:00.000Z',
      correction_reason: 'official statistic changed: 301 → 270 (WIN → LOSS)', clv: { available: true, close_line: 278.5, line_clv: 2, beat_close: true } }
  ])));
  const B4 = build(NOW3), R4 = byId(B4);
  chk('a corrected player stat updates the SAME row', B4.ledger.rows.length === B3.ledger.rows.length && B4.ledger.rows.filter((x) => x.recommendation_id === 'pp:ppe_over').length === 1);
  chk('the row now carries the corrected result and P&L', R4['pp:ppe_over'].result === 'loss' && R4['pp:ppe_over'].result_value === 270 && R4['pp:ppe_over'].flat_profit_units === -1 && R4['pp:ppe_over'].profit_units === -0.5, R4['pp:ppe_over']);
  const c4 = R4['pp:ppe_over'].corrections;
  chk('the correction is logged on the row: from, to, when, why', R4['pp:ppe_over'].corrected === true && c4.length === 1 && c4[0].fields.result.from === 'win' && c4[0].fields.result.to === 'loss' && /301 → 270/.test(c4[0].reason) && c4[0].at === NOW3, c4);
  chk('the summary reflects the correction exactly once', B4.summary.views.all.flat.summary.net_units === r2(1.1682 - 0.9091 - 1 + 0.9524), B4.summary.views.all.flat.summary.net_units);
  chk('the summary counts corrected rows', B4.summary.counts.corrected === 1 && B4.summary.views.all.data_quality.corrected === 1);
  write(B4);
  const B4b = build(NOW3);
  chk('rebuilding after a correction logs it only once', B4b.report.corrected === 0 && byId(B4b)['pp:ppe_over'].corrections.length === 1);

  /* ============================================================ corrected final score */
  put('record/football/nfl_2026.json', JSON.stringify(modelRecord({ home_score: 24, away_score: 20, source: 'nflverse', at: '2026-09-21T02:00:00.000Z' })));
  const B5 = build('2026-09-30T03:00:00.000Z'), R5 = byId(B5);
  const s5 = R5['mr:nfl:2026_03_KC_DEN:spread'];
  chk('a corrected final score updates the model record row in place', B5.ledger.rows.length === B4.ledger.rows.length && s5.result === 'win' && s5.final_score === '20–24', s5);
  chk('and logs the final score and result it replaced', s5.corrected && s5.corrections[0].fields.result.from === 'loss' && s5.corrections[0].fields.final_score.from === '27–20', s5.corrections);
  chk('a corrected score still never invents a P&L figure', s5.flat_profit_units == null && s5.pnl_status === 'NO_ENTRY_PRICE');
  write(B5);

  /* a corrected game result on a PRICED decision: the P&L moves, once */
  put('football/nfl_terminal/decisions/2026/evaluations.jsonl', jsonl([
    { snapshot_id: 'bds_nfl_total', result: 'win', close_line: 45.5, clv_points: -1, graded_at: '2026-09-22T09:00:00.000Z' },
    { snapshot_id: 'bds_nfl_ml', result: 'win', graded_at: '2026-09-21T09:00:00.000Z' }
  ]));
  const B6 = build('2026-09-30T04:00:00.000Z'), R6 = byId(B6);
  chk('a corrected game result moves the priced row\'s P&L: -1 → +0.9524', near(R6['bd:bds_nfl_total'].profit_units, 0.9524) && R6['bd:bds_nfl_total'].corrections.length === 1, R6['bd:bds_nfl_total']);
  write(B6);

  /* ============================================================ the recommendation half is frozen */
  const tampered = EVALS.map((x) => (x.evaluation_id === 'ppe_under' ? Object.assign({}, x, { american: 200, units: 1 }) : x));
  put('football/props/nfl/2026/evaluations.jsonl', jsonl(tampered));
  const B7 = build('2026-09-30T05:00:00.000Z'), R7 = byId(B7);
  chk('a source that rewrites a recorded price is refused: the ledger keeps +150', R7['pp:ppe_under'].entry_odds === 150 && R7['pp:ppe_under'].stake_units === 0.25, R7['pp:ppe_under']);
  chk('and it is reported as an integrity alert', B7.report.integrity_alerts.some((a) => a.recommendation_id === 'pp:ppe_under' && a.field === 'entry_odds') && B7.summary.integrity_alerts.length >= 2, B7.report.integrity_alerts);

  /* ============================================================ never deleted */
  put('football/props/nfl/2026/evaluations.jsonl', jsonl(EVALS.filter((x) => x.evaluation_id !== 'ppe_under')));
  const B8 = build('2026-09-30T06:00:00.000Z'), R8 = byId(B8);
  chk('a losing recommendation whose source line vanished is kept, and flagged', R8['pp:ppe_under'] && R8['pp:ppe_under'].source_missing === true && R8['pp:ppe_under'].profit_units === -0.25 && B8.report.kept_missing_source === 1);
  /* the same source row twice */
  put('football/props/nfl/2026/evaluations.jsonl', jsonl(EVALS.concat([EVALS[0]])));
  const B9 = build('2026-09-30T07:00:00.000Z');
  chk('a duplicated source row is one recommendation', B9.report.duplicates_in_sources === 1 && B9.ledger.rows.filter((x) => x.recommendation_id === 'pp:ppe_over').length === 1);

  /* ============================================================ one state per row, the record, pending reasons */
  {
    /* next week's prop, not settled: the pending row these checks read */
    put('football/props/nfl/2026/evaluations.jsonl', jsonl(EVALS.concat([ev('ppe_next', { game_id: '2026_05_KC_JAX', kickoff: K3, week: 5, side: 'over', line: 1.5, market: 'pass_tds', american: 120, units: 0.5, edge_pp: 4 })])));
    const BN = build('2026-09-30T08:00:00.000Z'), S9 = BN.summary, st = S9.states;
    chk('every row resolves to exactly one state', st.total === BN.ledger.rows.length && PNL.STATE_ORDER.reduce((a, k) => a + st[k], 0) === st.total && BN.ledger.rows.every((x) => PNL.STATE_ORDER.indexOf(x.record_state) >= 0), st);
    chk('states: verified, record only, void and pending are each counted', st.VERIFIED >= 5 && st.RECORD_ONLY >= 4 && st.VOID === 1 && st.PENDING === 1 && st.INVALID === 0, st);
    const rec = S9.record.all;
    chk('the graded record holds the model picks AND the bets, priced or not (never PASS / WATCH)', rec.graded === rec.verified + rec.record_only && rec.record_only >= 4 && rec.verified >= 5
      && BN.ledger.rows.filter((x) => PNL.inRecord(x, false) && (x.record_state === 'VERIFIED' || x.record_state === 'RECORD_ONLY')).length === rec.graded, rec);
    chk('the record by market adds up to the whole', S9.record.by.market.reduce((a, x) => a + x.graded, 0) === rec.graded, S9.record.by.market.map((x) => x.key + ' ' + x.graded));
    chk('the pending prop has a reason, as of the run (its game is next week: UPCOMING)', byId(BN)['pp:ppe_next'].pending_reason === 'UPCOMING' && S9.pending_reasons.total === st.PENDING && S9.pending_reasons.reasons[0].key === 'UPCOMING', S9.pending_reasons);
    chk('a settled row carries no pending reason', BN.ledger.rows.filter((x) => x.record_state !== 'PENDING').every((x) => x.pending_reason == null));
    chk('the integrity checks of every scope pass and are published', S9.integrity.ok === true && Object.keys(S9.integrity.checks).length === PNL.SCOPE_ORDER.length * 3, S9.integrity);
    chk('the page rows carry the state and the pending reason', core.PAGE_COLS.indexOf('record_state') >= 0 && core.PAGE_COLS.indexOf('pending_reason') >= 0
      && core.expandRows(BN.page).find((x) => x.recommendation_id === 'pp:ppe_next').pending_reason === 'UPCOMING');
    chk('the stamp counts the page rows', BN.stamp.schema === 'edgedesk_pnl_stamp_v1' && BN.stamp.rows === BN.page.rows.length && /^[0-9a-f]{16}$/.test(BN.stamp.digest), BN.stamp);
    const again = build('2026-09-30T08:00:00.000Z');
    chk('the stamp moves only when the rows do (a rebuild over the same facts keeps it)', again.stamp.digest === BN.stamp.digest, [again.stamp.digest, BN.stamp.digest]);
    const later = build('2026-10-04T18:00:00.000Z');
    chk('…and the clock alone moves a pending row\'s reason (kickoff passed: IN PROGRESS), which moves the stamp', byId(later)['pp:ppe_next'].pending_reason === 'IN_PROGRESS' && later.stamp.digest !== BN.stamp.digest, byId(later)['pp:ppe_next'].pending_reason);
  }

  /* ============================================================ the page's copy */
  const back = core.expandRows(B9.page);
  chk('the page rows are the ledger rows, columnar', back.length === B9.ledger.rows.length && back.every((x, i) => x.recommendation_id === B9.ledger.rows[i].recommendation_id && x.flat_profit_units === (B9.ledger.rows[i].flat_profit_units == null ? null : B9.ledger.rows[i].flat_profit_units)));
  chk('the kernel re-derives the same P&L from a page row', back.filter((x) => x.pnl_status === 'VERIFIED').every((x) => PNL.settle(x).flat_profit_units === x.flat_profit_units));
  chk('every page column is known to the kernel or the renderer', core.PAGE_COLS.indexOf('pnl_status') >= 0 && core.PAGE_COLS.indexOf('corrections') >= 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
function r2(v) { return Math.round(v * 100) / 100; }

/* ============================================================ why "pending" — every reason, pinned */
{
  const KO = '2026-10-04T17:00:00.000Z', ko = Date.parse(KO), h = (n) => ko + n * 3600e3;
  const prop = (o) => PNL.settle(Object.assign({ recommendation_id: 'pp:e1', market_group: 'prop', league: 'NFL', event_id: '2026_05_KC_JAX', game_date: KO, recommended_at: '2026-10-03T12:00:00.000Z', side: 'over', selection: 'Over 1.5', rec_class: 'BET', entry_odds: -110, stake_units: 1, result: 'pending' }, o));
  const game = (o) => PNL.settle(Object.assign({ recommendation_id: 'bd:s1', market_group: 'game', league: 'CFB', event_id: '401', game_date: KO, recommended_at: '2026-10-03T12:00:00.000Z', side: 'home', selection: 'Utah -6.5', rec_class: 'BET', entry_odds: -110, stake_units: 1, result: 'pending' }, o));
  const ctxP = (pending, checked) => ({ props: { NFL: { checked_at: checked, pending: pending } }, events: {}, finals: {} });
  const why = (row, ctx, t) => core.pendingReason(row, ctx, t);
  chk('pending: before kickoff → UPCOMING', why(prop(), ctxP({}, null), h(-1)) === 'UPCOMING');
  chk('pending: inside the game window → IN_PROGRESS', why(prop(), ctxP({}, null), h(2)) === 'IN_PROGRESS');
  chk('pending: the grader says the box is not published, within 48 h → AWAITING_STAT_FEED', why(prop(), ctxP({ e1: { code: 'STAT_FEED_PENDING' } }, new Date(h(10)).toISOString()), h(12)) === 'AWAITING_STAT_FEED');
  chk('pending: …past 48 h → MISSING_PLAYER_STAT', why(prop(), ctxP({ e1: { code: 'STAT_FEED_PENDING' } }, new Date(h(60)).toISOString()), h(60)) === 'MISSING_PLAYER_STAT');
  chk('pending: the grader says the game is not final, hours later → MISSING_FINAL', why(prop(), ctxP({ e1: { code: 'GAME_NOT_FINAL' } }, new Date(h(8)).toISOString()), h(8)) === 'MISSING_FINAL');
  chk('pending: the game is not in the schedule feed → MISSING_MAPPING', why(prop(), ctxP({ e1: { code: 'MISSING_MAPPING' } }, new Date(h(8)).toISOString()), h(8)) === 'MISSING_MAPPING');
  chk('pending: the grader could not load its dataset → SETTLEMENT_FAILED', why(prop(), ctxP({ e1: { code: 'DATASET_UNAVAILABLE' } }, new Date(h(8)).toISOString()), h(8)) === 'SETTLEMENT_FAILED');
  chk('pending: the grader has not run since kickoff, shortly after → AWAITING_SETTLEMENT', why(prop(), ctxP({}, new Date(h(-5)).toISOString()), h(7)) === 'AWAITING_SETTLEMENT');
  chk('pending: …and a day later → SETTLEMENT_FAILED (the job is not running)', why(prop(), ctxP({}, new Date(h(-5)).toISOString()), h(30)) === 'SETTLEMENT_FAILED');
  chk('pending: the grader ran after kickoff, did not settle it and gave no reason → SETTLEMENT_FAILED', why(prop(), ctxP({}, new Date(h(20)).toISOString()), h(24)) === 'SETTLEMENT_FAILED');
  const ctxG = (fin, known) => ({ props: {}, events: known ? { 401: { home: 'Utah' } } : {}, finals: fin ? { 401: { at: new Date(h(4)).toISOString() } } : {} });
  chk('pending game: a final EdgeDesk holds, within the grader\'s window → AWAITING_SETTLEMENT', why(game(), ctxG(true, true), h(20)) === 'AWAITING_SETTLEMENT');
  chk('pending game: a final held for days with no settlement → SETTLEMENT_FAILED', why(game(), ctxG(true, true), h(80)) === 'SETTLEMENT_FAILED');
  chk('pending game: a known game with no final → MISSING_FINAL', why(game(), ctxG(false, true), h(20)) === 'MISSING_FINAL');
  chk('pending game: a game EdgeDesk cannot place → MISSING_MAPPING', why(game(), ctxG(false, false), h(20)) === 'MISSING_MAPPING');
  chk('a settled row has no pending reason', why(game({ result: 'win' }), ctxG(true, true), h(20)) === null);
  chk('every reason the build gives is one the kernel words', ['UPCOMING', 'IN_PROGRESS', 'AWAITING_SETTLEMENT', 'AWAITING_STAT_FEED', 'MISSING_FINAL', 'MISSING_PLAYER_STAT', 'SETTLEMENT_FAILED', 'MISSING_MAPPING'].every((k) => !!PNL.PENDING_REASON[k]));
}

/* ============================================================ the real sources, rebuilt now (the backfill)
   The canonical record is built from every committed source ledger with the
   code under test — not from whatever an earlier build left in record/pnl —
   and must hold together: one state per row, a reason for every pending row,
   the record = its verified + record-only rows, every scope consistent. */
{
  const B = L.build({ root: ROOT, out: 'record/pnl', season: null, now: new Date().toISOString() });
  const rows = B.ledger.rows, S = B.summary, st = S.states;
  chk('real: every recommendation resolves to exactly one state', st.total === rows.length && PNL.STATE_ORDER.reduce((a, k) => a + st[k], 0) === rows.length, st);
  chk('real: no row is left INVALID without a reason', rows.filter((x) => x.record_state === 'INVALID').every((x) => !!x.state_reason));
  chk('real: every pending row says why', rows.filter((x) => x.record_state === 'PENDING').every((x) => !!PNL.PENDING_REASON[x.pending_reason]) && S.pending_reasons.total === st.PENDING, S.pending_reasons);
  const rec = S.record.all;
  chk('real: the graded record = its verified + record-only rows (' + rec.record + ' over ' + rec.graded + ')', rec.graded === rec.verified + rec.record_only && rec.graded === rec.wins + rec.losses + rec.pushes, rec);
  chk('real: historical results with no entry price are kept in the record, never dropped', rows.filter((x) => x.source === 'model_record').every((x) => x.record_state === 'RECORD_ONLY' || x.record_state === 'VOID') && rec.record_only >= rows.filter((x) => x.source === 'model_record' && x.record_state === 'RECORD_ONLY').length);
  chk('real: the integrity checks of every scope pass', S.integrity.ok, Object.keys(S.integrity.checks).filter((k) => !S.integrity.checks[k].ok).map((k) => k + ': ' + JSON.stringify(S.integrity.checks[k].failed)));
  const page = core.expandRows(B.page);
  const prec = PNL.gradedRecord(page.filter((x) => PNL.inRecord(x, false)));
  chk('real: the page rows give the same record and states as the build', prec.record === rec.record && PNL.STATE_ORDER.every((k) => PNL.states(page)[k] === st[k]), [prec.record, rec.record]);
}

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'P&L ledger — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
