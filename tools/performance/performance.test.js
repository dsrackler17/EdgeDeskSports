#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk Model Performance — the kernel, the ledger and the whole lifecycle,
   offline. docs/model-performance/DESIGN.md

     K  kernel: spread / total / moneyline grading, pushes and ties, Brier and
        log loss, missing odds (no quote, a quote with no price), the pregame
        rule at the exact start, designation (verified over recorded, last
        before the start, a moved start), results (final, conflict, 0-0,
        postponed, canceled, forfeit), small samples, time zones
     L  ledger: the hash chain, a tampered row, a truncated file, the prefix
        rule, a refused write on a broken chain
     C  lifecycle on a throwaway repository: capture → revise → refuse a late
        number → a duplicate run adds nothing → verify the final → grade →
        public rows (started games only) → a source correction regrades as a
        push → a postponed game is void after 14 days → a model version
        change → a grader change regrades with its reason → the article block
        → health and the weekly packet
     P  public files: no upcoming forecast, nothing secret-shaped
   Run: node tools/performance/performance.test.js
   =========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../../lib/edgedesk_performance.js');
const L = require('./ledger.js');
const PL = require('./pipeline.js');
const B = require('./build.js');
const RUN = require('./run.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= (eps || 1e-6); }

/* ------------------------------------------------------------- fixtures */
function snap(o) {
  return { event_key: o.key || 'NFL|G1', sport: o.sport || 'nfl', start_utc: o.start || '2026-10-02T00:15:00.000Z', home: { name: 'Home' }, away: { name: 'Away' },
    model: { id: o.model || 'm1', predicted_at: o.pred || '2026-10-01T10:00:00.000Z' },
    forecast: { p_home: o.p == null ? 0.6 : o.p, fair_home_line: o.line === undefined ? -3.5 : o.line, fair_total: o.total === undefined ? 44 : o.total, expected_total: o.expected === undefined ? null : o.expected,
      projected_score: o.ps || null },
    readiness: Object.assign({ research: 'RESEARCH_CONDITIONAL', invalidated: false }, o.readiness || {}),
    quote: o.quote === undefined ? null : o.quote,
    capture: { method: o.method || 'ledger_capture', captured_at: o.method && o.method !== 'ledger_capture' ? null : (o.cap || '2026-10-01T12:00:00.000Z'), recorded_at: o.rec || null },
    hash: o.hash || 'h_' + Math.random().toString(16).slice(2), seq: o.seq || 1 };
}
const Q = { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: '2026-10-01T11:00:00.000Z', moneyline: { home: -160, away: 135 },
  spread: { home_point: -3, home_price: -110, away_point: 3, away_price: -110 }, total: { point: 44.5, over: -110, under: -105 } };
const FINAL = (h, a, start) => ({ state: 'FINAL', home_score: h, away_score: a, start_utc: start || '2026-10-02T00:15:00.000Z', hash: 'r1' });

/* ------------------------------------------------------------- K kernel */
(function kernel() {
  /* spread: model −3.5 vs market −3 → home; final 24-20 (margin 4): covers −3 by 1 */
  let g = P.gradeGame(snap({ quote: Q }), FINAL(24, 20));
  chk('K spread error is actual minus projected margin', g.spread.projected_margin === 3.5 && g.spread.actual_margin === 4 && g.spread.error === 0.5 && g.spread.abs_error === 0.5, g.spread);
  chk('K the side the fair line favours, at the captured line', g.market.spread.pick.side === 'home' && g.market.spread.pick.gap === 0.5 && g.market.spread.pick.result === 'win', g.market.spread.pick);
  chk('K units at the captured price: −110 wins 0.9091', near(g.market.spread.pick.units, 0.9091, 1e-4), g.market.spread.pick.units);
  /* the market's own error on the same game */
  chk('K the market margin error on the same game', g.market.spread.market_abs_error === 1);
  /* push at the market line: margin 3 vs −3 */
  g = P.gradeGame(snap({ quote: Q }), FINAL(23, 20));
  chk('K a final exactly on the line is a push, 0 units', g.market.spread.pick.result === 'push' && g.market.spread.pick.units === 0);
  /* away side: model +1 for home (home_line −1 vs market −3 → away +3) */
  g = P.gradeGame(snap({ line: -1, quote: Q }), FINAL(20, 24));
  chk('K away side: +3 covers when the away team wins', g.market.spread.pick.side === 'away' && g.market.spread.pick.result === 'win');
  g = P.gradeGame(snap({ line: -1, quote: Q }), FINAL(27, 20));
  chk('K away side: +3 loses when the home team wins by 7', g.market.spread.pick.result === 'loss' && g.market.spread.pick.units === -1);
  /* total: model 44 vs 44.5 → under; 44 → under wins; 44.5 impossible; 45 → loss */
  g = P.gradeGame(snap({ quote: Q }), FINAL(24, 20));
  chk('K total: under at 44.5 with 44 points wins at −105', g.market.total.pick.side === 'under' && g.market.total.pick.result === 'win' && near(g.market.total.pick.units, 0.9524, 1e-4), g.market.total.pick);
  g = P.gradeGame(snap({ total: 45, quote: Object.assign({}, Q, { total: { point: 44, over: -110, under: -110 } }) }), FINAL(24, 20));
  chk('K total: a final on the total line is a push', g.market.total.pick.result === 'push');
  chk('K total error uses the expected total when there is one', P.gradeGame(snap({ total: 44.5, expected: 43.8 }), FINAL(24, 20)).total.projected_total === 43.8);
  chk('K NHL: a priced half-goal line is not an expectation', !P.gradeGame(snap({ sport: 'nhl', line: null, total: 6.5, expected: null }), FINAL(3, 2)).total
    && P.gradeGame(snap({ sport: 'nhl', line: null, total: 6.5, expected: 6.12 }), FINAL(3, 2)).total.projected_total === 6.12);
  /* probability */
  g = P.gradeGame(snap({ p: 0.7 }), FINAL(24, 20));
  chk('K Brier and log loss of a 70% call that happened', near(g.winner.brier, 0.09) && near(g.winner.log_loss, -Math.log(0.7), 1e-6) && g.winner.correct === true && g.winner.favourite === 'home');
  g = P.gradeGame(snap({ p: 0.7 }), FINAL(17, 20));
  chk('K Brier of a 70% call that missed', near(g.winner.brier, 0.49) && g.winner.correct === false);
  /* a tie is a push for the winner and never scored for probability */
  g = P.gradeGame(snap({ p: 0.7 }), FINAL(20, 20));
  chk('K an NFL tie: no winner, no Brier, still a margin error', g.winner.outcome === 'push' && g.winner.correct === null && g.winner.brier === null && g.spread.abs_error === 3.5);
  chk('K a 50% forecast calls no winner', P.gradeGame(snap({ p: 0.5 }), FINAL(24, 20)).winner.correct === null);
  /* missing odds */
  g = P.gradeGame(snap({ quote: null }), FINAL(24, 20));
  chk('K no captured quote: no market comparison at all', !g.market);
  const noPrice = Object.assign({}, Q, { spread: { home_point: -3, home_price: null, away_point: 3, away_price: null }, moneyline: null });
  g = P.gradeGame(snap({ quote: noPrice }), FINAL(24, 20));
  chk('K a quote with no price: the record, but never units (no assumed −110)', g.market.spread.pick.result === 'win' && g.market.spread.pick.units === null && !g.market.moneyline);
  g = P.gradeGame(snap({ quote: noPrice }), FINAL(23, 20));
  chk('K …and a push without a price is not a priced bet either', g.market.spread.pick.result === 'push' && g.market.spread.pick.units === null);
  const lateQ = Object.assign({}, Q, { captured_at: '2026-10-02T00:20:00.000Z' });
  chk('K a quote captured after the start is never compared', !P.gradeGame(snap({ quote: lateQ }), FINAL(24, 20)).market);
  /* CLV: only against a close from the same source family */
  g = P.gradeGame(snap({ quote: Q }), FINAL(24, 20), { close: { home_line: -4, total: 45, source: 'espn' } });
  chk('K CLV in points against a same-family close', g.market.clv && g.market.clv.spread_pts === 1 && g.market.clv.total_pts === -0.5, g.market.clv);
  chk('K no CLV against a different source family', !P.gradeGame(snap({ quote: Q }), FINAL(24, 20), { close: { home_line: -4, source: 'nflverse' } }).market.clv);
  /* eligibility is decided by pregame facts */
  chk('K a forecast flagged DATA_INSUFFICIENT pregame is recorded, not graded', P.gradeGame(snap({ readiness: { research: 'DATA_INSUFFICIENT' } }), FINAL(24, 20)).why === 'FLAGGED_PREGAME_DATA_INSUFFICIENT');
  chk('K an invalidated forecast is not graded', P.gradeGame(snap({ readiness: { invalidated: true } }), FINAL(24, 20)).eligible === false);
  chk('K a void game is never graded', P.gradeGame(snap({}), { state: 'VOID', void_reason: 'CANCELED' }).why === 'VOID_CANCELED');

  /* the pregame rule at the boundary */
  const st = '2026-10-02T00:15:00.000Z';
  chk('K captured exactly at the start: refused', P.pregameProblem(snap({ cap: st, start: st })) === 'CAPTURED_AFTER_START');
  chk('K captured 1 ms before the start: admitted', P.pregameProblem(snap({ cap: '2026-10-02T00:14:59.999Z', start: st })) === null);
  chk('K predicted at the start: refused even when captured before', P.pregameProblem(snap({ cap: '2026-10-02T00:10:00.000Z', pred: st, start: st })) === 'PREDICTED_AFTER_START');
  chk('K a recorded import dated after the start: refused', P.pregameProblem(snap({ method: 'import:x', rec: '2026-10-02T00:16:00.000Z', start: st })) === 'RECORDED_AFTER_START');
  chk('K the same instant in another zone is the same instant', P.pregameProblem(snap({ cap: '2026-10-01T20:14:59-04:00', start: st })) === null && P.pregameProblem(snap({ cap: '2026-10-01T19:15:00-05:00', start: st })) === 'CAPTURED_AFTER_START');

  /* designation */
  const v1 = snap({ cap: '2026-10-01T10:00:00.000Z', hash: 'v1' }), v2 = snap({ cap: '2026-10-01T20:00:00.000Z', p: 0.62, hash: 'v2' });
  const late = snap({ cap: '2026-10-02T00:30:00.000Z', p: 0.9, hash: 'late' });
  const rec = snap({ method: 'import:football_record', rec: '2026-10-01T23:00:00.000Z', p: 0.55, hash: 'rec' });
  let d = P.designate([v1, v2, late, rec], st);
  chk('K the graded forecast is the last verified one before the start', d.snapshot.hash === 'v2' && d.tier === 'VERIFIED' && d.revisions === 3, d);
  chk('K a capture after the start is listed as ineligible', d.ineligible.some((x) => x.hash === 'late' && x.why === 'CAPTURED_AFTER_START'));
  d = P.designate([rec], st);
  chk('K with nothing verified, the recorded forecast is graded as RECORDED', d.snapshot.hash === 'rec' && d.tier === 'RECORDED');
  /* a postponement: the actual start moved four days */
  d = P.designate([v1, v2], '2026-10-06T00:15:00.000Z');
  chk('K a forecast for a start that moved more than 36 hours is not graded', !d.snapshot && d.ineligible.every((x) => x.why === 'RESCHEDULED'));
  d = P.designate([v1, snap({ start: '2026-10-06T00:15:00.000Z', cap: '2026-10-05T12:00:00.000Z', hash: 'v3' })], '2026-10-06T00:15:00.000Z');
  chk('K …a forecast made for the new date is', d.snapshot && d.snapshot.hash === 'v3');

  /* results */
  const c = (src, st2, h, a) => ({ source: src, status: st2, home_score: h, away_score: a, start_utc: st });
  chk('K one source with a final: FINAL', P.resolveResult([c('espn', 'FINAL', 24, 20)]).state === 'FINAL');
  chk('K two sources that agree: FINAL with both named', P.resolveResult([c('espn', 'FINAL', 24, 20), c('nflverse', 'FINAL', 24, 20)]).sources.length === 2);
  chk('K two sources that disagree: CONFLICT, nothing settled', P.resolveResult([c('espn', 'FINAL', 24, 20), c('nflverse', 'FINAL', 24, 21)]).state === 'CONFLICT');
  chk('K a 0-0 "final" is a placeholder', P.resolveResult([c('espn', 'FINAL', 0, 0)]).state === 'PENDING');
  chk('K a non-integer score is not a final', P.resolveResult([c('espn', 'FINAL', 24.5, 20)]).state === 'PENDING');
  chk('K canceled: VOID', P.resolveResult([c('espn', 'CANCELED')]).void_reason === 'CANCELED');
  chk('K a forfeit: VOID, even if a feed calls it final', P.resolveResult([c('espn', 'FORFEIT'), c('x', 'FINAL', 1, 0)]).void_reason === 'FORFEIT');
  chk('K the slate maps a forfeit detail apart from FINAL', P.slateStatus({ status: 'FINAL', status_detail: 'Final - Forfeit' }) === 'FORFEIT');
  chk('K postponed: pending', P.resolveResult([c('espn', 'POSTPONED')], { now: '2026-10-05T00:00:00Z', scheduled_start: st }).state === 'PENDING');
  chk('K postponed 14+ days with no new date: VOID (revisable)', P.resolveResult([c('espn', 'POSTPONED')], { now: '2026-10-17T00:00:00Z', scheduled_start: st }).void_reason === 'POSTPONED_UNRESOLVED');

  /* metrics: small samples print counts, not rates */
  const row = (p, h, a) => P.compact(P.publicRow(snap({ p, quote: Q }), FINAL(h, a), P.gradeGame(snap({ p, quote: Q }), FINAL(h, a))));
  const few = [row(0.7, 24, 20), row(0.6, 10, 20)];
  const m = P.metrics(few);
  chk('K under ' + P.MIN_N + ' games: counts, no rate, no Brier, no MAE', m.winner.correct === 1 && m.winner.called === 2 && m.winner.pct === null && m.winner.brier === null && m.margin.mae === null && m.winner.sample_state === 'TOO_EARLY');
  const many = []; for (let i = 0; i < 25; i++) many.push(row(0.7, i % 3 ? 24 : 17, 20));
  const m2 = P.metrics(many);
  chk('K with ' + P.MIN_N + '+ games the rate prints', m2.winner.pct != null && m2.winner.called === 25 && m2.winner.brier != null && m2.margin.mae != null);
  chk('K calibration buckets carry Wilson intervals', m2.winner.calibration.length >= 1 && m2.winner.calibration.every((b) => b.wilson_low != null));
  chk('K the trend is cumulative and holds a rate back until it has ' + P.MIN_N, P.metrics(few.concat(many)).trend.every((t) => t.cum_called >= P.MIN_N ? t.cum_pct != null : t.cum_pct === null));
  chk('K a model version is its own group', P.filterRows(few.concat([Object.assign({}, few[0], { model_version: 'm2' })]), { model: 'm2' }).length === 1);
  chk('K ISO weeks across the new year', P.isoWeek('2026-12-31T23:00:00Z') === '2026-W53' && P.isoWeek('2027-01-04T12:00:00Z') === '2027-W01');
  /* the Central Time review week across the end of daylight time (Nov 1 2026) */
  const wb = B.weekBounds(Date.parse('2026-11-03T15:00:00Z'));
  chk('K the review week is Monday to Monday, Central Time, across DST', wb.id === '2026-10-26' && new Date(wb.from).toISOString() === '2026-10-26T05:00:00.000Z' && new Date(wb.to).toISOString() === '2026-11-02T06:00:00.000Z', wb);
})();

/* ------------------------------------------------------------- L ledger */
(function ledger() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-ledger-'));
  const f = path.join(tmp, 'performance', 'ledger', 'forecasts', 'nfl-2026.jsonl');
  const w = L.append(f, [{ event_key: 'A', n: 1 }, { event_key: 'B', n: 2 }], { root: tmp });
  chk('L rows get seq, prev and hash', w[0].seq === 1 && w[0].prev === L.GENESIS && w[1].prev === w[0].hash && w[1].hash === L.hashOf(w[1]));
  L.append(f, [{ event_key: 'C', n: 3 }], { root: tmp });
  chk('L the chain verifies', L.verifyAll(tmp).ok);
  const before = fs.readFileSync(f, 'utf8');
  /* tamper: change one number in the middle row */
  fs.writeFileSync(f, before.replace('"n":2', '"n":5'));
  const v = L.verifyAll(tmp);
  chk('L a changed row breaks its hash and the chain', !v.ok && /hash does not match/.test(v.files[0].errors.join(';')));
  chk('L a broken chain is never extended', /refusing to extend a broken chain/.test((() => { try { L.append(f, [{ event_key: 'D' }], { root: tmp }); return ''; } catch (e) { return e.message; } })()));
  fs.writeFileSync(f, before);
  chk('L the prefix rule: appending passes', L.verifyPrefix(before.split('\n').slice(0, 2).join('\n') + '\n', before).ok);
  chk('L the prefix rule: a removed line fails', !L.verifyPrefix(before, before.split('\n').slice(1).join('\n')).ok);
  chk('L the prefix rule: an edited line fails', !L.verifyPrefix(before, before.replace('"n":1', '"n":9')).ok);
  chk('L canonical JSON ignores key order', L.canonical({ b: 1, a: { d: 2, c: 3 } }) === L.canonical({ a: { c: 3, d: 2 }, b: 1 }));
  fs.rmSync(tmp, { recursive: true, force: true });
})();

/* ---------------------------------------------------------- C lifecycle */
function makeRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-life-'));
  ['lib', 'tools'].forEach((d) => fs.symlinkSync(path.join(ROOT, d), path.join(tmp, d)));
  fs.mkdirSync(path.join(tmp, 'today'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'record', 'football'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'articles', 'data', 'records'), { recursive: true });
  return tmp;
}
function writeJson(root, rel, obj) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), JSON.stringify(obj)); }
function proj(o) {
  const margin = -o.line;
  return { event_key: 'NFL|' + o.id, sport: 'nfl', league: 'NFL', event_id: o.id, start_utc: o.start, home: { name: 'Green Bay Packers', abbr: 'GB' }, away: { name: 'Atlanta Falcons', abbr: 'ATL' }, neutral: false,
    model: { id: o.model || 'edgedesk_football_v1.0.0', version: 'nfl_fv1', artifact: 'football/nfl/slate.json', predicted_at: o.pred, artifact_generated_at: o.pred },
    outcome: { p_home: o.p, p_away: +(1 - o.p).toFixed(4) }, fair: { moneyline: { home: -150, away: 150 }, spread: { home_line: o.line }, total: { line: o.total, expected: o.total } },
    projected_score: { home: (o.total + margin) / 2, away: (o.total - margin) / 2, margin, total: o.total }, research: { outcome: 'RESEARCH_CONDITIONAL', reasons: [] },
    freshness: { state: 'FRESH', age_hours: 1 }, integrity: { invalidated: false }, projection_id: 'pj_' + o.id + o.pred, projection_hash: 'ph' };
}
function slateFile(events, markets, at) { return { schema: 'edgedesk_slate/1', generated_at: at, events, upcoming: [], markets: markets || {} }; }
function ev(o) { return { id: 'nfl:espn:' + o.espn, sport: 'nfl', league: 'NFL', start_utc: o.start, status: o.status || 'SCHEDULED', status_detail: o.detail || '', updated_at: o.at,
  home: { name: 'Green Bay Packers', abbr: 'GB', score: o.hs == null ? null : o.hs }, away: { name: 'Atlanta Falcons', abbr: 'ATL', score: o.as == null ? null : o.as } }; }

(async function lifecycle() {
  const root = makeRoot();
  const START = '2026-10-02T00:15:00.000Z';
  const MKT = { book: 'Draft Kings', source: 'espn_scoreboard', captured_at: '2026-10-01T11:00:00.000Z', moneyline: { home: -160, away: 135 },
    spread: { home: { point: -3, price: -110 }, away: { point: 3, price: -110 } }, total: { point: 44.5, over: -110, under: -110 } };
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9001, start: START, at: '2026-10-01T11:00:00.000Z' })], { 'nfl:espn:9001': MKT }, '2026-10-01T11:00:00.000Z'));
  writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: START, home: 'Green Bay Packers', away: 'Atlanta Falcons' } } });
  writeJson(root, 'articles/data/published.json', { articles: [{ game_id: 'G1', sport: 'NFL', type: 'pregame', slug: 'atlanta-falcons-vs-green-bay-packers-2026' }] });
  writeJson(root, 'articles/data/records/nfl-G1.json', { id: 'nfl-G1', home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons', generated_at: '2026-10-01T09:00:00.000Z',
    research: { projection: { fair_spread: 3, fair_spread_text: 'Green Bay Packers -3.0', total: '44.0', score: { home: { points: '24' }, away: { points: '20' } },
      win_prob: { home: 'Green Bay Packers', away: 'Atlanta Falcons', home_pct: 60, away_pct: 40, favourite: 'Green Bay Packers', favourite_pct: 60 } } } });
  const T0 = Date.parse('2026-10-01T12:00:00Z'), T1 = Date.parse('2026-10-01T18:00:00Z');
  const run = (now, projections, extra) => RUN.runAll(Object.assign({ root, now, write: true, network: false, projections: projections || [], log: () => {} }, extra || {}));

  let r = await run(T0, [proj({ id: 'G1', start: START, pred: '2026-10-01T10:00:00.000Z', p: 0.6, line: -3, total: 44 })]);
  chk('C capture: the first forecast is locked, with its quote', r.report.steps.capture.appended === 1 && r.report.steps.capture.quotes === 1 && r.state.forecasts[0].capture.method === 'ledger_capture', r.report.steps.capture);
  chk('C the market quote rides on the forecast, captured before it', r.state.forecasts[0].quote && r.state.forecasts[0].quote.spread.home_point === -3);
  chk('C nothing is public before the game starts', !fs.existsSync(path.join(root, 'performance', 'data', 'games')) || fs.readdirSync(path.join(root, 'performance', 'data', 'games')).length === 0);

  /* a revision, then the same run twice */
  const rev = [proj({ id: 'G1', start: START, pred: '2026-10-01T17:00:00.000Z', p: 0.62, line: -3.5, total: 44 })];
  r = await run(T1, rev);
  chk('C a changed forecast is a new revision; the first is kept', r.report.steps.capture.appended === 1 && r.state.forecasts.length === 2);
  r = await run(T1 + 60e3, rev);
  chk('C a duplicate run appends nothing', r.report.steps.capture.appended === 0 && r.report.steps.results.appended === 0 && r.report.steps.grade.appended === 0 && r.state.forecasts.length === 2);
  /* a number produced at kickoff is refused */
  r = await run(Date.parse(START), [proj({ id: 'G1', start: START, pred: START, p: 0.9, line: -10, total: 50 })]);
  chk('C a forecast at the start is refused, never stored', r.report.steps.capture.appended === 0 && (r.report.steps.capture.refused.STARTED || 0) === 1 && r.state.forecasts.length === 2);

  /* the final: the slate and the record agree */
  const T3 = Date.parse('2026-10-02T04:00:00Z');
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9001, start: START, status: 'FINAL', detail: 'Final', hs: 24, as: 20, at: '2026-10-02T03:30:00.000Z' })], {}, '2026-10-02T03:40:00.000Z'));
  writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: START, home: 'Green Bay Packers', away: 'Atlanta Falcons', final: { home_score: 24, away_score: 20, source: 'nflverse', at: '2026-10-02T03:50:00.000Z' },
    close: { home_line: -4, total: 44, source: 'nflverse', book: 'consensus' } } } });
  r = await run(T3, []);
  const res1 = r.state.results[0], g1 = r.state.grades[0];
  chk('C the final is verified from both sources', r.report.steps.results.appended === 1 && res1.state === 'FINAL' && res1.home_score === 24 && res1.sources.length === 2, res1);
  chk('C the graded forecast is the last before the start (−3.5), not the first', g1.forecast_hash === r.state.forecasts[1].hash && g1.spread.projected_margin === 3.5 && g1.forecast_tier === 'VERIFIED', g1.spread);
  chk('C at the captured line: −3.5 against −3, 24-20 covers', g1.market.spread.pick.result === 'win' && g1.market.spread.pick.side === 'home');
  chk('C no CLV: the close is nflverse, the quote ESPN', !g1.market.clv);
  const gamesFile = JSON.parse(fs.readFileSync(path.join(root, 'performance', 'data', 'games', 'nfl-2026.json'), 'utf8'));
  chk('C the game is public once it has started', gamesFile.rows.length === 1 && gamesFile.rows[0].tier === 'VERIFIED' && gamesFile.rows[0].revisions === 2);
  const pg = JSON.parse(fs.readFileSync(path.join(root, 'performance', 'articles', 'postgame.json'), 'utf8')).articles['nfl-G1'];
  chk('C the article block keeps the article\'s own published numbers', pg && pg.published.fair_spread_text === 'Green Bay Packers -3.0' && pg.error.margin_abs === 1 && pg.error.total_abs === 0 && pg.error.favourite_won === true, pg);
  chk('C …and says the graded forecast moved after it was written', pg.ledger.differs === true && pg.ledger.fair_home_line === -3.5);
  const R = require('../articles/article_render.js');
  const html = R.predictionVsActualHTML({}, pg);
  chk('C the article renders "EdgeDesk Prediction vs. Actual Result" with a link to the record', /EdgeDesk Prediction vs\. Actual Result/.test(html) && /Off by 1\.0 points/.test(html) && /\/performance\/\?g=NFL%7CG1/.test(html));

  /* a correction: the record now says 24-21 and the slate no longer carries the game */
  writeJson(root, 'today/slate.json', slateFile([], {}, '2026-10-05T00:00:00.000Z'));
  writeJson(root, 'record/football/nfl_2026.json', { games: { G1: { kickoff: START, home: 'Green Bay Packers', away: 'Atlanta Falcons', final: { home_score: 24, away_score: 21, source: 'nflverse' } } } });
  r = await run(Date.parse('2026-10-05T00:00:00Z'), []);
  const res2 = PL.latest(r.state.results), g2 = PL.latest(r.state.grades);
  chk('C a source correction is a new result revision that supersedes the first', r.state.results.length === 2 && res2.revision === 2 && res2.supersedes === res1.hash && res2.reason === 'source_correction');
  chk('C …and the game is regraded as a new grade revision: now a push at −3', r.state.grades.length === 2 && g2.revision === 2 && g2.reason === 'result_revision' && g2.market.spread.pick.result === 'push');
  r = await run(Date.parse('2026-10-05T01:00:00Z'), []);
  chk('C running again after the correction adds nothing', r.report.steps.results.appended === 0 && r.report.steps.grade.appended === 0);

  /* a postponed game: pending, then void after 14 days */
  const S2 = '2026-10-09T00:15:00.000Z';
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9002, start: S2, at: '2026-10-08T10:00:00.000Z' })], {}, '2026-10-08T10:00:00.000Z'));
  const g2p = Object.assign(proj({ id: 'G2', start: S2, pred: '2026-10-08T09:00:00.000Z', p: 0.55, line: -1, total: 41 }));
  r = await run(Date.parse('2026-10-08T12:00:00Z'), [g2p]);
  chk('C a second game is captured', r.state.forecasts.filter((s) => s.event_key === 'NFL|G2').length === 1);
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9002, start: S2, status: 'POSTPONED', at: '2026-10-08T20:00:00.000Z' })], {}, '2026-10-09T12:00:00.000Z'));
  r = await run(Date.parse('2026-10-09T12:00:00Z'), []);
  const hl = JSON.parse(fs.readFileSync(path.join(root, 'performance', 'data', 'health.json'), 'utf8'));
  chk('C a postponed game is pending, reported as postponed (not as a missing final)', r.report.steps.results.appended === 0 && hl.items.some((i) => i.check === 'postponed') && !hl.items.some((i) => i.check === 'missing_finals'), hl.items);
  r = await run(Date.parse('2026-10-24T12:00:00Z'), []);
  const v2 = PL.latest(r.state.results.filter((x) => x.event_key === 'NFL|G2'));
  chk('C postponed 14+ days: void, never a loss', v2 && v2.state === 'VOID' && v2.void_reason === 'POSTPONED_UNRESOLVED');
  chk('C a void game is graded ineligible, with its reason', PL.latest(r.state.grades.filter((x) => x.event_key === 'NFL|G2')).why === 'VOID_POSTPONED_UNRESOLVED');

  /* a model version change: a new revision, and the version is on the grade */
  const S3 = '2026-10-16T00:15:00.000Z';
  writeJson(root, 'today/slate.json', slateFile([ev({ espn: 9003, start: S3, at: '2026-10-15T10:00:00.000Z' })], {}, '2026-10-15T10:00:00.000Z'));
  await run(Date.parse('2026-10-15T10:00:00Z'), [proj({ id: 'G3', start: S3, pred: '2026-10-15T09:00:00.000Z', p: 0.55, line: -1, total: 41 })]);
  r = await run(Date.parse('2026-10-15T12:00:00Z'), [proj({ id: 'G3', start: S3, pred: '2026-10-15T09:00:00.000Z', p: 0.55, line: -1, total: 41, model: 'edgedesk_football_v1.1.0' })]);
  chk('C the same numbers from a new model version are a new revision', r.report.steps.capture.appended === 1 && r.state.forecasts.filter((s) => s.event_key === 'NFL|G3').map((s) => s.model.id).join() === 'edgedesk_football_v1.0.0,edgedesk_football_v1.1.0');

  /* a grader change regrades every game with its reason, keeping the old grades */
  const graded = r.state.grades.length;
  const GV = P.GRADER_VERSION;
  require('../../lib/edgedesk_performance.js');
  const st = RUN.loadState(root);
  const orig = P.gradeGame;
  P.gradeGame = function (s, res, o) { const g = orig(s, res, o); g.grader = 'perf_grader_v2_test'; return g; };
  const gr = PL.grade(st, { now: Date.parse('2026-10-25T00:00:00Z'), native: null });
  P.gradeGame = orig;
  chk('C a method change regrades every game as a new revision, reason method_change', gr.appended.length === new Set(st.grades.map((g) => g.event_key)).size && gr.appended.every((g) => g.reason === 'method_change' && g.revision > 1), gr.appended.map((g) => g.reason));
  chk('C the current grader version is recorded on every grade', st.grades.every((g) => g.grader === GV) && graded >= 3);

  /* the chains, and the public files */
  chk('C every chain in the lifecycle verifies', L.verifyAll(root).ok);
  const pub = fs.readdirSync(path.join(root, 'performance', 'data', 'games')).map((n) => JSON.parse(fs.readFileSync(path.join(root, 'performance', 'data', 'games', n), 'utf8')));
  const now = Date.parse('2026-10-15T12:00:00Z');
  chk('P no public row is a game that had not started when it was built', pub.every((f) => f.rows.every((x) => Date.parse(x.start_utc) <= Date.parse(f.generated_at))));
  const allText = pub.map((f) => JSON.stringify(f)).join('') + fs.readFileSync(path.join(root, 'performance', 'data', 'summary.json'), 'utf8');
  chk('P public files carry nothing secret-shaped', !/service_role|SB_SERVICE|apikey|password|eyJhbGci|@[a-z0-9-]+\.[a-z]{2,}/i.test(allText));
  void now;
  fs.rmSync(root, { recursive: true, force: true });

  /* P the committed public data in this repository */
  const sum = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance', 'data', 'summary.json'), 'utf8'));
  chk('P the committed summary lists every game file and no retired sport', Array.isArray(sum.games) && sum.coverage.every((c) => ['soccer', 'tennis', 'golf'].indexOf(c.sport) < 0));
  const committed = sum.games.map((g) => JSON.parse(fs.readFileSync(path.join(ROOT, g.path.slice(1)), 'utf8')));
  chk('P every committed public row had started when it was built', committed.every((f) => f.rows.every((x) => Date.parse(x.start_utc) <= Date.parse(f.generated_at))));
  chk('P the verified headline never includes a recorded forecast', committed.every((f) => f.rows.every((x) => x.tier === 'RECORDED' || x.forecast.captured_at)) && sum.headline.verified.eligibility.games === committed.reduce((s, f) => s + f.rows.filter((x) => x.tier === 'VERIFIED').length, 0));
  chk('P the committed ledger verifies', L.verifyAll(ROOT).ok);

  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'model performance — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | the lifecycle threw  ' + (e && e.stack || e)); process.exit(1); });
