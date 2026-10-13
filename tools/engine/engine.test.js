#!/usr/bin/env node
/* ===========================================================================
   The multi-sport engine's rules, offline.

     registry   readiness is computed, never typed: no value claim without a
                market validation; no model state without a sport brain; the
                committed registry passes its invariants
     board      every gate on synthetic candidates where the answer is known:
                a market-validated price qualifies; an outcome-validated one
                never does; stale, started and malformed prices are refused;
                an outlier is a data check; two markets on one game are not
                stacked; the selection bar rises with the number of markets
                scanned; EV, break-even and the minimum price include pushes;
                PASS always says why
     artifacts  the committed board passes its check

   Run: node tools/engine/engine.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'lib', 'edgedesk_sport_brains.js'));
const XB = require(path.join(ROOT, 'lib', 'edgedesk_xboard.js'));
const REG = require(path.join(ROOT, 'engine', 'build_registry.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
const near = (a, b, e) => Math.abs(a - b) <= (e == null ? 1e-6 : e);

/* ---------------- registry ---------------- */
const ids = B.SPORTS.map((s) => s.id);
chk('registry: the 12 sports asked for, each once', JSON.stringify(ids.slice().sort()) === JSON.stringify(['cfb', 'college_baseball', 'mlb', 'mma', 'ncaab_m', 'ncaab_w', 'nba', 'nfl', 'nhl', 'soccer', 'tennis', 'wnba'].sort()), ids);
chk('registry: every cited source exists', B.SPORTS.every((s) => (s.brain.candidates || []).every((c) => (c.sources || []).every((k) => B.SOURCES[k]))));
chk('registry: a sport with no brain and no data is UNAVAILABLE', B.computeReadiness(B.byId('nba'), { markets: {} }).state === 'UNAVAILABLE');
chk('registry: a sport with data but no brain is RESEARCH_ONLY', B.computeReadiness(B.byId('mma'), { markets: {} }).state === 'RESEARCH_ONLY');
chk('registry: a retired sport is RETIRED whatever its record', B.computeReadiness(B.byId('tennis'), { markets: { moneyline: { outcome: 'VALIDATED', market: 'TESTED_AHEAD', n: 5000 } } }).state === 'RETIRED');
const outcomeOnly = B.computeReadiness(B.byId('nhl'), { markets: { moneyline: { outcome: 'VALIDATED', market: 'NOT_TESTED', n: 8000 } } });
chk('registry: outcome validation alone never enables value claims', outcomeOnly.state === 'OUTCOME_VALIDATED' && !outcomeOnly.markets.moneyline.value_claims);
const even = B.computeReadiness(B.byId('nfl'), { markets: { spread: { outcome: 'VALIDATED', market: 'TESTED_EVEN', n: 2600 } } });
chk('registry: break-even against the close is not a market validation', even.state === 'OUTCOME_VALIDATED' && !even.value_claims_any);
const ahead = B.computeReadiness(B.byId('nhl'), { markets: { moneyline: { outcome: 'VALIDATED', market: 'TESTED_AHEAD', n: 800 } } });
chk('registry: beating the close with n ≥ 500 is MARKET_VALIDATED and may claim value', ahead.state === 'MARKET_VALIDATED' && ahead.markets.moneyline.value_claims);
const small = B.computeReadiness(B.byId('nhl'), { markets: { moneyline: { outcome: 'VALIDATED', market: 'TESTED_AHEAD', n: 120 } } });
chk('registry: ...but not on 120 games', small.state === 'OUTCOME_VALIDATED' && !small.value_claims_any);
chk('registry: an unvalidated model is EXPERIMENTAL', B.computeReadiness(B.byId('mlb'), { markets: { moneyline: { outcome: 'UNVALIDATED', market: 'NOT_TESTED' } } }).state === 'EXPERIMENTAL');
const built = REG.build();
chk('registry: built from the committed evidence, no sport claims value today', built.value_claims_enabled.length === 0, built.value_claims_enabled);
chk('registry: NHL is outcome-validated on its moneyline and puck line, never market-validated', (() => { const n = built.sports.find((s) => s.id === 'nhl'); return n.readiness.state === 'OUTCOME_VALIDATED' && n.readiness.markets.moneyline.state === 'OUTCOME_VALIDATED' && n.readiness.markets.spread.state === 'OUTCOME_VALIDATED'; })());
chk('registry: no sport without a built brain carries a model state', built.sports.every((s) => s.brain.status !== 'NOT_BUILT' || ['RESEARCH_ONLY', 'UNAVAILABLE', 'RETIRED'].includes(s.readiness.state)));
chk('registry: every sport lists its blockers and the steps to enable it', built.sports.every((s) => s.blockers.length && s.enable.length));
chk('registry: the committed states are the evidence\'s (run node engine/build_registry.js)', (() => { const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'registry.json'), 'utf8')); const st = (r) => r.sports.map((s) => [s.id, s.readiness.state, Object.entries(s.readiness.markets || {}).map(([k, m]) => k + ':' + m.state + ':' + m.value_claims)]); return JSON.stringify(st(c)) === JSON.stringify(st(built)); })());

/* ---------------- board ---------------- */
const NOW = Date.parse('2026-10-13T18:00:00Z');
const regValidated = { sports: [{ id: 'nhl', label: 'NHL', readiness: { markets: { moneyline: { state: 'MARKET_VALIDATED', value_claims: true, reason: 'beat the close' }, total: { state: 'OUTCOME_VALIDATED', value_claims: false, reason: 'never tested against the closing market' } } } }] };
const base = (o) => Object.assign({ sport_id: 'nhl', sport_label: 'NHL', event_key: 'NHL|1', event: { home: 'AAA', away: 'BBB', start_utc: '2026-10-13T23:00:00Z', label: 'BBB @ AAA' }, market: { kind: 'moneyline', side: 'AAA', line: null },
  quote: { book: 'bookA', american: 104, captured_at: '2026-10-13T17:50:00Z', source: 'odds_gateway' }, model: { p_win: 0.53, p_push: 0, method: 'MODEL', sd: 0.005, calibration: { wilson95: [0.52, 0.54] } },
  market_ref: { p_novig: 0.50, method: 'sharp', book: 'pinnacle' }, data: { state: 'FRESH', lineup_certainty: 'CONFIRMED' }, evidence: [], invalidators: [] }, o || {});
let b = XB.evaluate({ candidates: [base()], registry: regValidated, now: NOW });
const c = b.candidates[0];
chk('board: a fresh price on a market-validated model with a real edge QUALIFIES', b.verdict === 'BEST_SUPPORTED' && c.status === 'QUALIFIED', c.gates);
chk('board: break-even and EV are at the actual price (+104)', near(c.break_even, 1 / 2.04, 1e-4) && near(c.ev_raw, 0.53 * 2.04 - 1, 1e-4));
chk('board: the probability is shrunk toward the no-vig market before EV', c.prob.posterior < 0.53 && c.prob.posterior > 0.50 && c.ev_posterior < c.ev_raw);
chk('board: the minimum acceptable price clears the bar at the conservative probability', (() => { const d = XB.amToDec(c.min_acceptable_american); return c.prob.conservative * d - 1 >= 0.02 - 0.003; })(), c.min_acceptable_american);
b = XB.evaluate({ candidates: [base({ market: { kind: 'total', side: 'over', line: 6.5 } })], registry: regValidated, now: NOW });
chk('board: an outcome-validated market never qualifies, however big the edge', b.verdict === 'PASS' && b.candidates[0].gates.some((g) => g.code === 'VALUE_DISABLED') && b.why.length);
b = XB.evaluate({ candidates: [base({ quote: { book: 'bookA', american: 104, captured_at: '2026-10-13T15:00:00Z' } })], registry: regValidated, now: NOW });
chk('board: a price older than the window is STALE and not priced', b.candidates[0].gates[0].code === 'STALE' && b.n_priced === 0);
b = XB.evaluate({ candidates: [base({ event: { home: 'AAA', away: 'BBB', start_utc: '2026-10-13T17:00:00Z', label: 'x' } })], registry: regValidated, now: NOW });
chk('board: a started event is never a candidate', b.candidates[0].status === 'STARTED');
b = XB.evaluate({ candidates: [base({ quote: { book: 'bookA', american: 50, captured_at: '2026-10-13T17:50:00Z' } })], registry: regValidated, now: NOW });
chk('board: a malformed American price is refused', b.candidates[0].gates[0].code === 'BAD_PRICE');
b = XB.evaluate({ candidates: [base({ quote: { book: 'bookA', american: 250, captured_at: '2026-10-13T17:50:00Z' } })], registry: regValidated, now: NOW });
chk('board: an EV above the sanity ceiling is a DATA CHECK, not a bet', b.candidates[0].status === 'DATA_CHECK' && b.verdict === 'PASS');
b = XB.evaluate({ candidates: [base(), base({ market: { kind: 'moneyline', side: 'AAA2', line: null }, quote: { book: 'bookB', american: 103, captured_at: '2026-10-13T17:55:00Z' } })], registry: regValidated, now: NOW });
chk('board: two qualifying markets on one game are not stacked', b.candidates.filter((x) => x.status === 'QUALIFIED').length === 1 && b.candidates.filter((x) => x.status === 'CORRELATED').length === 1);
const many = []; for (let i = 0; i < 200; i++) many.push(base({ event_key: 'NHL|' + i, quote: { book: 'b', american: 104, captured_at: '2026-10-13T17:50:00Z' }, model: { p_win: 0.50, p_push: 0, method: 'MODEL', sd: 0.005, calibration: { wilson95: [0.49, 0.51] } } }));
const one = XB.evaluate({ candidates: [base()], registry: regValidated, now: NOW });
const lots = XB.evaluate({ candidates: [base()].concat(many), registry: regValidated, now: NOW });
chk('board: the selection bar rises with the number of markets scanned', lots.selection_z > one.selection_z && lots.candidates.find((x) => x.event_key === 'NHL|1').prob.conservative < one.candidates[0].prob.conservative, [one.selection_z, lots.selection_z]);
b = XB.evaluate({ candidates: [base({ market: { kind: 'moneyline', side: 'AAA' }, model: { p_win: 0.53, p_push: 0, method: 'MODEL', sd: 0.04 } })], registry: regValidated, now: NOW });
chk('board: a noisy model is shrunk almost all the way to the market', b.candidates[0].prob.shrink_k < 0.2 && b.candidates[0].status !== 'QUALIFIED');
/* pushes */
b = XB.evaluate({ candidates: [base({ market: { kind: 'moneyline', side: 'AAA' }, quote: { book: 'b', american: -110, captured_at: '2026-10-13T17:50:00Z' }, model: { p_win: 0.47, p_push: 0.08, method: 'MODEL', sd: 0.005 }, market_ref: null })], registry: regValidated, now: NOW });
const pc = b.candidates[0];
chk('board: with a push, break-even is (1 − p_push)/decimal and EV counts the returned stake', near(pc.break_even, 0.92 / (1 + 100 / 110), 1e-4) && near(pc.ev_raw, 0.47 * (1 + 100 / 110) - 0.92, 1e-4));
chk('board: the fair price with a push is where EV is zero', (() => { const d = XB.amToDec(pc.fair_american); return near(0.47 * d - 0.92, 0, 0.01); })(), pc.fair_american);
/* market-only (line shopping) path */
b = XB.evaluate({ candidates: [base({ model: { p_win: 0.50, p_push: 0, method: 'MARKET_DEVIG', sd: 0.004 }, market_ref: { p_novig: 0.50, method: 'sharp', book: 'pinnacle' }, quote: { book: 'softbook', american: 112, captured_at: '2026-10-13T17:55:00Z' } })], registry: { sports: [] }, now: NOW });
chk('board: a market-only price needs a sharp reference and is judged by the same EV bar', b.candidates[0].gates.some((g) => g.gate === 'VALUE' && g.ok && g.code === 'MARKET_DEVIG'));
b = XB.evaluate({ candidates: [base({ model: { p_win: 0.50, p_push: 0, method: 'MARKET_DEVIG', sd: 0.004 }, market_ref: { p_novig: 0.50, method: 'consensus' } })], registry: { sports: [] }, now: NOW });
chk('board: ...a consensus reference is not enough', b.candidates[0].gates.some((g) => g.code === 'NO_SHARP_REFERENCE'));
b = XB.evaluate({ candidates: [base({ quote: null })], registry: regValidated, now: NOW });
chk('board: no price → RESEARCH with the price that would be needed, and PASS says why', b.verdict === 'PASS' && b.candidates[0].status === 'RESEARCH' && /needs a price/.test(b.candidates[0].gates[1].reason) && /fresh executable price/.test(b.why[0]));
b = XB.evaluate({ candidates: [base({ data: { state: 'STALE', lineup_certainty: 'CONFIRMED' } })], registry: regValidated, now: NOW });
chk('board: stale research inputs block qualification', b.candidates[0].status !== 'QUALIFIED' && b.candidates[0].gates.some((g) => g.code === 'STALE_DATA'));
b = XB.evaluate({ candidates: [base({ data: { state: 'FRESH', lineup_certainty: 'PROJECTED_UNCERTAIN' } })], registry: regValidated, now: NOW });
chk('board: an unconfirmed lineup widens the uncertainty', b.candidates[0].prob.components.lineup_sd > 0 && b.candidates[0].prob.sd > XB.evaluate({ candidates: [base()], registry: regValidated, now: NOW }).candidates[0].prob.sd);

/* ---------------- artifacts ---------------- */
const board = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'board.json'), 'utf8'));
chk('artifacts: the committed board has a verdict and, if PASS, its reasons', board.schema === 'edgedesk_engine_board_v1' && (board.verdict === 'BEST_SUPPORTED' ? !!board.best : board.why.length > 0));
chk('artifacts: nothing qualified without passing the value gate', board.candidates.filter((x) => x.status === 'QUALIFIED').every((x) => x.gates.some((g) => g.gate === 'VALUE' && g.ok)));
chk('artifacts: coverage names all 12 sports with their state', board.coverage.length === 12 && board.coverage.every((x) => x.state && x.note));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'multi-sport engine — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
