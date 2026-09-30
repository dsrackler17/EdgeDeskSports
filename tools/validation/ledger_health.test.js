#!/usr/bin/env node
/* ============================================================================
   THE DECISION LEDGER GRADES EVERY CLASS, AND MODEL HEALTH READS IT.

     node tools/validation/ledger_health.test.js

   snapshots carry versions, the canonical market, execution and ladder ·
   the snapshot id changes with the engine version · the first snapshot of
   each class is graded once, with opening / evaluated / bet / closing lines,
   CLV in points and price-equivalent, and the hypothetical flat result kept
   apart from BET units · a close that is missing is never invented · the
   ledger replays through football/cfb_terminal/decisions.js · the transition
   text names the book and the EV · model_health.json is current, keeps modes
   apart, prints n everywhere and carries the research alerts
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'lib', 'research_core.js'));
const BT = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js'));
const BDS = require(path.join(ROOT, 'football', 'cfb_terminal', 'decisions.js'));
const V = require(path.join(ROOT, 'lib', 'edgedesk_validation.js'));
const MH = require(path.join(ROOT, 'tools', 'validation', 'model_health.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function section(t) { console.log('  · ' + t); }

/* a real FINAL game from the Lab ledger: 401856696, home won by 31 */
const GID = '401856696', KICK = '2026-09-26T23:00:00.000Z';
function dec(decision, at, extra) {
  const q = { side: 'away', team: 'Visitors', line: 12.5, odds: -110, book: 'DraftKings', captured_at: at, decision_ev: decision === 'BET' ? 0.06 : 0.01, quote_age_minutes: 10 };
  return Object.assign({ game_id: GID, sport: 'CFB', market_key: 'CFB:spread', home: 'Home U', away: 'Visitors', kickoff: KICK, decision, action_reason_code: decision === 'BET' ? 'QUALIFIES' : 'EDGE_TOO_SMALL',
    side: 'Visitors', side_key: 'away', market_type: 'spread', selected_line: 12.5, selected_odds: -110, selected_book: 'DraftKings', recommended_units: decision === 'BET' ? 0.5 : 0,
    bet_price: decision === 'BET' ? q : null, reference_quote: decision === 'BET' ? null : q, probability: 0.55, cover_probability: 0.57, break_even: 0.5238, edge_pp: decision === 'BET' ? 4.2 : 1.1,
    calibrated_ev_pct: 6, decision_ev_pct: decision === 'BET' ? 6 : 1, decision_confidence: 70, probability_source: 'partially_calibrated', reliability_score: 80, market_quality: 'VERIFIED',
    model_market_gap: 3, evaluated_at: at, quote_captured_at: at, model_version: 'edgedesk_cfb_p4_v1.0.0', calibration_version: 'cfb_ev_calibration_v1', pricing_model_version: 'edgedesk_quote_ev_v1',
    decision_engine_version: 'edgedesk_football_decision_v2', config_version: 'football_decision_config_v2', evaluation_mode: 'LIVE', data_snapshot_at: at,
    versions: { version_key: 'dv_test0001', data_snapshot_at: at }, market: { consensus_line: 12.5, book_count: 3, verification_status: 'VERIFIED', quality: { score: 90, label: 'HIGH' }, outliers: [] },
    best_execution: { best: { label: 'Visitors +12.5 (-110)', line: 12.5, odds: -110, book: 'DraftKings', decision_ev: 0.06 }, reason: 'x', n_executable: 2 },
    ladder: { summary: 'At -110: +12 WATCH · +12.5 BET 0.50U (now)', by_line: [], by_price: [] } }, extra || {});
}

section('snapshots freeze the versions, the market, the execution and the ladder');
{
  const s = BT.snapshot(dec('BET', '2026-09-26T12:00:00.000Z'));
  chk('versions, market, best execution, ladder, mode and data time are frozen', s.versions && s.versions.version_key === 'dv_test0001' && s.market.verification_status === 'VERIFIED' && s.best_execution.best.book === 'DraftKings' && /BET 0\.50U/.test(s.ladder.summary) && s.evaluation_mode === 'LIVE' && s.data_snapshot_at, s);
  const s2 = BT.snapshot(dec('BET', '2026-09-26T12:00:00.000Z', { versions: { version_key: 'dv_other' } }));
  chk('the same call made by another engine version is a different row', s.snapshot_id !== s2.snapshot_id);
  chk('a snapshot is frozen', Object.isFrozen(s) && Object.isFrozen(s.market));
}
section('every decision class is graded once, the same way');
{
  const snaps = [dec('PASS', '2026-09-26T10:00:00.000Z'), dec('WATCH', '2026-09-26T11:00:00.000Z'), dec('BET', '2026-09-26T12:00:00.000Z'), dec('BET', '2026-09-26T13:00:00.000Z', { selected_line: 13 }), dec('NO_DECISION', '2026-09-26T14:00:00.000Z')].map((d) => BT.snapshot(d));
  const first = BT.firstPerClass(snaps);
  chk('the first snapshot per class: PASS, WATCH, BET — the second BET and NO DECISION are not graded', first.map((x) => x.decision).join() === 'PASS,WATCH,BET', first.map((x) => x.decision));
  const coverAt = BDS.closingDistribution();
  const g = BT.gradeEvaluation(first[2], { open: -13, close: -10.5, close_captured_at: '2026-09-26T23:00:00.000Z' }, { home_margin: 31 }, { coverAt, now: '2026-09-28T00:00:00Z' });
  chk('lines: opening, evaluated, bet, closing — side-stated', g.open_line === 13 && g.evaluated_line === 12.5 && g.bet_line === 12.5 && g.close_line === 10.5, g);
  chk('CLV in points: +12.5 against a +10.5 close is +2', g.clv_points === 2, g.clv_points);
  chk('price-equivalent CLV is positive and explained', g.clv_price_pp > 0 && g.clv_ev != null && /cover probability/.test(g.clv_basis), g);
  chk('the result at the evaluated number, the BET’s units, and a flat 1U kept apart', g.result === 'loss' && g.units_won === -0.5 && g.flat_units_won_hypothetical === -1, g);
  chk('the versions that made the call ride with the grade', g.model_version === 'edgedesk_cfb_p4_v1.0.0' && g.version_key === 'dv_test0001' && g.rules_version === 'football_decision_config_v2');
  const gw = BT.gradeEvaluation(first[1], { close: -10.5 }, { home_margin: 31 }, {});
  chk('a WATCH is graded with no units and a hypothetical result', gw.decision === 'WATCH' && gw.units === 0 && gw.units_won === null && gw.flat_units_won_hypothetical === -1 && gw.bet_line === null, gw);
  const noClose = BT.gradeEvaluation(first[0], {}, { home_margin: 31 }, {});
  chk('no close: CLV is null, never zero', noClose.clv_points === null && noClose.clv_price_pp === null, noClose);
  chk('no sharp close captured: none is invented', g.close_sharp_line === null && g.clv_sharp_points === null);
  chk('a NO DECISION is never graded', BT.gradeEvaluation(BT.snapshot(dec('NO_DECISION', '2026-09-26T14:00:00.000Z')), { close: -10 }, { home_margin: 1 }) === null);
  const row = V.fromDecisionEvaluation(g);
  chk('the graded row reads straight into the validation engine', row.decision === 'BET' && row.clv_points === 2 && row.mode === 'LIVE' && row.predicted === 0.55);
}
section('the build’s ledger stage grades the classes through decisions.js');
{
  const snaps = [dec('PASS', '2026-09-26T10:00:00.000Z'), dec('BET', '2026-09-26T12:00:00.000Z')].map((d) => BT.snapshot(d));
  const byGame = new Map([[GID, snaps]]);
  const lines = new Map([[GID, [{ kind: 'OPEN', book: 'CONSENSUS', market_type: 'spread', home_line: -13 }, { kind: 'CLOSE', book: 'CONSENSUS', market_type: 'spread', home_line: -10.5 }]]]);
  const ctx = { decLedger: { season: 2026, snaps: snaps, grades: [], evaluations: [], byGame: byGame }, ledger: { lines: lines } };
  const DL = BDS.ledger(2026, [], ctx, Date.parse('2026-09-28T00:00:00Z'));
  chk('both classes graded once into evaluations.jsonl', DL.new_evaluations.length === 2 && DL.new_evaluations.map((e) => e.decision).sort().join() === 'BET,PASS', DL.new_evaluations.map((e) => e.decision));
  chk('the BET is also graded the old way (grades.jsonl unchanged)', DL.new_grades.length === 1 && DL.new_grades[0].clv_points === 2);
  chk('the opening line comes from the Lab’s consensus open', DL.new_evaluations.every((e) => e.open_line === 13));
  const ctx2 = { decLedger: { season: 2026, snaps: snaps, grades: DL.new_grades, evaluations: DL.new_evaluations, byGame: byGame }, ledger: { lines: lines } };
  const DL2 = BDS.ledger(2026, [], ctx2, Date.parse('2026-09-29T00:00:00Z'));
  chk('a second build grades nothing twice', DL2.new_evaluations.length === 0 && DL2.new_grades.length === 0);
  chk('the artifact points at the cached model health, never recomputing it', /model_health\.json/.test(BDS.artifact({}, [], DL).model_health) && BDS.artifact({}, [], DL).n_evaluations === 2);
}
section('the audit trail names the book and what it did to EV');
{
  const w = dec('WATCH', '2026-09-26T16:11:00.000Z', { reference_quote: { side: 'away', line: 10, odds: -110, book: 'DraftKings', decision_ev: 0.02 }, action_reason_code: 'NEAR_THRESHOLD' });
  const b = dec('BET', '2026-09-26T16:42:00.000Z', { bet_price: { side: 'away', line: 10.5, odds: -105, book: 'DraftKings', decision_ev: 0.095 } });
  const t = BT.transition(w, b);
  chk('WATCH → BET: "DraftKings moved from +10 (-110) to +10.5 (-105), pushing calibrated EV above the betting threshold (+9.5%)."', t.kind === 'PRICE_IMPROVED' && t.text === 'DraftKings moved from +10 (-110) to +10.5 (-105), pushing calibrated EV above the betting threshold (+9.5%).', t.text);
  const back = BT.transition(b, dec('PASS', '2026-09-26T17:00:00.000Z', { action_reason_code: 'PRICE_MOVED', reference_quote: { side: 'away', line: 9.5, odds: -110, book: 'DraftKings', decision_ev: -0.01 } }));
  chk('BET → PASS names the book and the EV now', back.kind === 'PRICE_MOVED' && /^DraftKings moved from \+10\.5 \(-105\) to \+9\.5 \(-110\) and crossed EdgeDesk’s playable threshold \(calibrated EV now −1\.0%\)\.$/.test(back.text), back.text);
}
section('model health: cached, current, honest');
{
  const H = MH.build();
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'model_health.json'), 'utf8'));
  const st = MH.staleness(committed, H);
  chk('the committed model_health.json is not stale for these inputs (npm run validation:health:check)', st === 'CURRENT' || st === 'INPUTS_MOVED', st);
  if (st === 'INPUTS_MOVED') console.log('    NOTE | the inputs moved on since model_health.json was built; the hourly job rebuilds it');
  chk('the committed report carries the same sections as a fresh build', Object.keys(committed).join() === Object.keys(H).join(), [Object.keys(committed), Object.keys(H)]);
  chk('every input is fingerprinted and keyed', H.inputs_key && H.sources.every((x) => x.sha1 === null || /^[0-9a-f]{12}$/.test(x.sha1)) && H.sources.filter((x) => x.sha1).length >= 6, H.sources);
  {
    const moved = JSON.parse(JSON.stringify(H)); moved.inputs_key = 'other'; moved.as_of = '2000-01-01T00:00:00.000Z';
    const edited = JSON.parse(JSON.stringify(H)); edited.alerts = [];
    chk('staleness: data moved on is INPUTS_MOVED; the same inputs with a different report is CODE_CHANGED', MH.staleness(moved, H) === 'INPUTS_MOVED' && MH.staleness(edited, H) === 'CODE_CHANGED' && MH.staleness(H, H) === 'CURRENT' && MH.staleness(null, H) === 'MISSING');
  }
  chk('its as-of time is the newest input, not the clock (reproducible)', H.as_of && JSON.stringify(MH.build().as_of) === JSON.stringify(H.as_of));
  chk('modes are separate sections: the Lab has BACKTEST and LIVE_RECONSTRUCTED apart', H.cfb_lab.report.modes.BACKTEST && H.cfb_lab.report.modes.LIVE_RECONSTRUCTED);
  chk('walk-forward is its own section, as published', H.walk_forward.NFL.mode === 'WALK_FORWARD' && H.walk_forward.NFL.markets.spread.tier);
  chk('the live model record is labelled model-level, not decisions', /not bettor decisions/.test(H.live_model_record.level));
  const all = JSON.stringify(H.cfb_lab.dashboard);
  chk('every dashboard bucket carries n and a sample state', (all.match(/"bucket"/g) || []).length > 0 && (all.match(/"bucket"/g) || []).length === (all.match(/"sample":"/g) || []).length);
  chk('the maturity ladder is reported stage by stage, with n', H.maturity.length === 5 && H.maturity.every((m) => typeof m.n === 'number' && m.sample));
  chk('the NFL no-skill finding is a research alert', H.alerts.some((a) => a.code === 'NO_SKILL_OVER_BASE_RATE' && /NFL spread blend/.test(a.text)));
  /* audit 2026-09-30 #4: the NFL engine now reads its table by the median, so
     the table's drift no longer reaches a decision's centre — it is reported
     as a note, like the college table's, never silently dropped */
  chk('the distribution audit still reports the NFL table drift, as a note now that decisions read the table by its median', H.alerts.some((a) => a.code === 'DISTRIBUTION_CENTRE_DRIFT' && a.league === 'NFL' && a.severity === 'INFO' && /BY ITS MEDIAN/.test(a.text)));
  chk('the CFB drift is a note: its decision path re-centres the shape', H.alerts.some((a) => a.code === 'DISTRIBUTION_CENTRE_DRIFT' && a.league === 'CFB' && a.severity === 'INFO'));
  chk('a losing published record is said out loud, not hidden', H.alerts.some((a) => a.code === 'MODEL_RECORD_BELOW_BREAK_EVEN'));
  chk('every alert says it changes nothing', H.alerts.every((a) => /not an automatic change|excluded from nothing automatically/.test(a.note || '')));
  chk('no leakage in the live ledger', !H.alerts.some((a) => a.code === 'LEAKAGE'));
}

console.log(fail ? 'FAILURES:\n  ' + failures.join('\n  ') : '');
console.log((fail ? 'FAIL' : 'ALL GREEN') + ' ledger & model health — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
