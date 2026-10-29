#!/usr/bin/env node
/* ============================================================================
   SP+ TRACKING — capture, grade once, report, append-only. Offline, in a
   temporary directory; the Lab's own market rules (lab_core marketAt).

   The worked case is 2026-10-28, Kennesaw State at Middle Tennessee:
   EdgeDesk MTSU −4.52, SP+ MTSU −1.3, the market MTSU −3 when first captured,
   closing KSU −1.5 (home line +1.5), final KSU 44–28 (home margin −16).

   Run: node football/sp_plus/track.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./track.js');
const LAB = require('../cfb_lab/lab_core.js');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500)));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }

const KICK = '2026-10-28T23:00:00.000Z';
const slate = (line) => ({ season: 2026, generated_at: '2026-10-26T12:00:00.000Z', games: [
  { game_id: '401871058', season: 2026, week: 9, season_type: 'regular', kickoff: KICK, home_team: 'Middle Tennessee', away_team: 'Kennesaw State',
    model_status: 'PREDICTED', model_home_line: line == null ? -4.52 : line, model_version: 'edgedesk_cfb_p4_v1.0.1' },
  { game_id: 'PAST', season: 2026, week: 9, season_type: 'regular', kickoff: '2026-10-20T23:00:00.000Z', home_team: 'A', away_team: 'B',
    model_status: 'PREDICTED', model_home_line: -3, model_version: 'v' }
] });
const lines = (cap) => ({ schema: 'edgedesk_cfb_sp_plus_lines_v1', status: 'OK', last_attempt: { status: 'OK', week_key: '2026:0:09' },
  snapshot: { season: 2026, week: 9, week_key: '2026:0:09', captured_at: cap || '2026-10-26T15:17:00.000Z', source_version: 'cfbd-ratings-sp:2026:abcdef012345' },
  games: { 401871058: { home: 'Middle Tennessee', away: 'Kennesaw State', week: 9, week_key: '2026:0:09', state: 'AVAILABLE', home_margin: 1.3, home_line: -1.3 } } });
const quote = (book, line, at) => ({ quote_id: 'q-' + book + at, game_id: '401871058', source: 'odds_api', book, market_type: 'spread', home_line: line,
  observed_at: at, is_pregame: true, is_provider_open: false, is_provider_close: false });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sptrack-'));
try {
  /* --------------------------------------------------------- capture */
  const q1 = [quote('draftkings', -3, '2026-10-26T14:00:00.000Z'), quote('fanduel', -3, '2026-10-26T14:05:00.000Z')];
  let res = T.run({ root: tmp, now: '2026-10-26T15:30:00.000Z', write: true,
    inputs: { slate: slate(), lines: lines(), quotes: q1, labLines: [], results: [], lab: LAB } });
  eq([res.captured, res.graded], [1, 0], 'capture: the upcoming game is captured; a game already played is not');
  const P = T.paths(2026, tmp);
  let C = fs.readFileSync(P.captures, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const c0 = C[0];
  eq([c0.edgedesk.home_line, c0.edgedesk.source], [-4.52, 'football/fbs/slate.json'], 'capture: EdgeDesk’s published fair line');
  eq([c0.sp_plus.state, c0.sp_plus.home_line, c0.sp_plus.week_key], ['AVAILABLE', -1.3, '2026:0:09'], 'capture: the SP+ projected line, as a card shows it');
  eq([c0.market.home_line, c0.market.n_books], [-3, 2], 'capture: the market, the Lab’s consensus at that moment');
  eq([c0.captured_at, c0.kickoff, c0.rule], ['2026-10-26T15:30:00.000Z', KICK, 'cfb_sp_track_v1'], 'capture: stamped with its time');
  ok(/^spt_[0-9a-f]{24}$/.test(c0.capture_id), 'capture: a deterministic id');

  res = T.run({ root: tmp, now: '2026-10-26T16:30:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q1, labLines: [], results: [], lab: LAB } });
  eq(res.captured, 0, 'capture: nothing changed, nothing appended');
  const q2 = q1.concat([quote('draftkings', 1.5, '2026-10-28T19:00:00.000Z'), quote('fanduel', 1.5, '2026-10-28T19:05:00.000Z')]);
  res = T.run({ root: tmp, now: '2026-10-28T20:00:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q2, labLines: [], results: [], lab: LAB } });
  eq(res.captured, 1, 'capture: the market moved, one row appended');
  /* a stale SP+ file is captured as unavailable, never as a number */
  const stale = T.capture('2026-10-28T21:00:00.000Z', { slate: slate(), lines: lines('2026-10-10T15:17:00.000Z'), quotes: q2, lab: LAB }, []);
  eq([stale[0].sp_plus.state, stale[0].sp_plus.home_line], ['UNAVAILABLE', null], 'capture: a stale SP+ file is recorded as unavailable');
  ok(/stale/.test(stale[0].sp_plus.reason), 'capture: with its reason');
  const noMarket = T.capture('2026-10-26T15:30:00.000Z', { slate: slate(), lines: lines(), quotes: [], lab: LAB }, []);
  eq(noMarket[0].market, null, 'capture: no quote, no market (never a zero)');

  /* ------------------------------------------------------------ grade */
  const labLines = [{ line_id: 'cfbl_close', game_id: '401871058', kind: 'CLOSE', book: 'CONSENSUS', market_type: 'spread', home_line: 1.5, quality: 'OBSERVED', n_books: 2 }];
  const results = [{ result_id: 'cfbr_1', game_id: '401871058', status: 'FINAL', home_points: 28, away_points: 44 }];
  res = T.run({ root: tmp, now: '2026-10-29T03:00:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q2, labLines: [], results, lab: LAB } });
  eq(res.graded, 0, 'grade: no close yet, not graded');
  res = T.run({ root: tmp, now: '2026-10-29T03:00:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q2, labLines, results: [], lab: LAB } });
  eq(res.graded, 0, 'grade: no final yet, not graded');
  res = T.run({ root: tmp, now: '2026-10-29T04:00:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q2, labLines, results, lab: LAB } });
  eq(res.graded, 1, 'grade: final and close known, graded');
  const G = JSON.parse(fs.readFileSync(P.grades, 'utf8').trim());
  eq([G.final.margin, G.close.home_line, G.captures.n], [-16, 1.5, 2], 'grade: the final, the Lab’s close, the captures used');
  eq(G.sources.edgedesk, { home_line: -4.52, abs_err_close: 6.02, abs_err_final: 20.52, side_vs_close: 'home', right_side_of_close: false, close_moved: 'away' },
    'grade: EdgeDesk — 6.02 off the close, 20.52 off the final, on the wrong side of the close, and the close moved away from it');
  eq(G.sources.sp_plus, { home_line: -1.3, abs_err_close: 2.8, abs_err_final: 17.3, side_vs_close: 'home', right_side_of_close: false, close_moved: 'toward' },
    'grade: SP+ — 2.8 off the close, 17.3 off the final, wrong side too, but the close moved toward it');
  eq(G.close_abs_err_final, 14.5, 'grade: the close itself was 14.5 off the final');
  res = T.run({ root: tmp, now: '2026-10-30T04:00:00.000Z', write: true, inputs: { slate: slate(), lines: lines(), quotes: q2, labLines,
    results: results.concat([{ result_id: 'cfbr_2', game_id: '401871058', status: 'FINAL', home_points: 28, away_points: 45 }]), lab: LAB } });
  eq(res.graded, 0, 'grade: written once; a later result correction never edits it');
  eq(fs.readFileSync(P.grades, 'utf8').trim().split('\n').length, 1, 'grade: still one row');

  /* the sides and the move, case by case */
  const cl = { home_line: -3 }, fin = (m) => ({ margin: m });
  eq(T.gradeSource({ home_line: -7 }, null, cl, fin(10)).right_side_of_close, true, 'side: likes home more than the close, home covered: right');
  eq(T.gradeSource({ home_line: -7 }, null, cl, fin(1)).right_side_of_close, false, 'side: likes home more, home failed to cover: wrong');
  eq(T.gradeSource({ home_line: 0 }, null, cl, fin(1)).right_side_of_close, true, 'side: likes away more, home failed to cover: right');
  eq(T.gradeSource({ home_line: -7 }, null, cl, fin(3)).right_side_of_close, null, 'side: a push is not counted');
  eq(T.gradeSource({ home_line: -3 }, null, cl, fin(10)).right_side_of_close, null, 'side: on the close itself, no side');
  eq(T.gradeSource({ home_line: -7 }, { src: { home_line: -7 }, market: { home_line: -3 } }, cl, fin(0)).close_moved, 'none', 'move: the close did not move');
  eq(T.gradeSource(null, null, cl, fin(0)), null, 'a source with no number is not graded');

  /* ----------------------------------------------------------- report */
  const files = fs.readdirSync(P.reports).sort();
  eq(files, ['season.json', 'season.md', 'week_09.json', 'week_09.md'], 'report: the week and the season, JSON and Markdown');
  const W = JSON.parse(fs.readFileSync(path.join(P.reports, 'week_09.json'), 'utf8'));
  eq([W.games, W.sources.edgedesk.mae_vs_close, W.sources.sp_plus.mae_vs_close, W.sources.edgedesk.mae_vs_final, W.sources.sp_plus.mae_vs_final],
    [1, 6.02, 2.8, 20.52, 17.3], 'report: MAE vs the close and vs the final, per source');
  eq([W.sources.sp_plus.close_moved.toward, W.sources.edgedesk.close_moved.away, W.common.n, W.common.close_mae_vs_final], [1, 1, 1, 14.5],
    'report: the move toward each, and the common-game comparison with the close as the benchmark');
  eq(W.as_of, '2026-10-29T04:00:00.000Z', 'report: dated by its newest grade, so an hour with no new grade rewrites nothing');
  const mdt = fs.readFileSync(path.join(P.reports, 'week_09.md'), 'utf8');
  ok(/MAE vs close/.test(mdt) && /SP\+ projected \(external\)/.test(mdt) && /never fed into EdgeDesk’s model/.test(mdt), 'report: the Markdown names SP+ as external and says it feeds nothing');

  /* ----------------------------------------------------------- verify */
  const committed = {};
  [P.captures, P.grades].forEach((f) => { committed[path.relative(tmp, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8'); });
  const base = (rel) => (rel in committed ? committed[rel] : null);
  eq(T.verify(2026, { root: tmp, baseContent: base }), [], 'verify: the ledger is intact');
  const g0 = fs.readFileSync(P.grades, 'utf8');
  fs.writeFileSync(P.grades, g0.replace('"abs_err_close":6.02', '"abs_err_close":0.5'));
  ok(T.verify(2026, { root: tmp, baseContent: base }).some((p) => /rewritten/.test(p)), 'verify: an edited graded row is caught');
  fs.writeFileSync(P.grades, g0);
  const c0txt = fs.readFileSync(P.captures, 'utf8');
  fs.writeFileSync(P.captures, c0txt.split('\n').slice(1).join('\n'));
  ok(T.verify(2026, { root: tmp, baseContent: base }).some((p) => /rewritten/.test(p)), 'verify: a removed capture is caught');
  fs.writeFileSync(P.captures, c0txt + c0txt.split('\n')[0] + '\n');
  ok(T.verify(2026, { root: tmp, baseContent: base }).some((p) => /duplicates/.test(p)), 'verify: a duplicated row is caught');
  fs.writeFileSync(P.captures, c0txt);
  const bad = JSON.parse(c0txt.split('\n')[0]); bad.captured_at = '2026-10-26T15:31:00.000Z'; bad.capture_id = 'spt_' + '0'.repeat(24);
  fs.appendFileSync(P.captures, JSON.stringify(bad) + '\n');
  ok(T.verify(2026, { root: tmp, baseContent: base }).some((p) => /does not match its content/.test(p)), 'verify: a row whose id is not its content’s is caught');
  fs.writeFileSync(P.captures, c0txt);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* the committed ledger (when one exists) verifies against the checkout */
{
  const problems = T.verify(2026, { baseContent: T.gitBase('HEAD') });
  eq(problems, [], 'the committed SP+ tracking ledger is intact');
}

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
