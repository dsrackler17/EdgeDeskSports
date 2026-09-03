#!/usr/bin/env node
/* ===========================================================================
   Tests for the brief grader — CLOSE THE LOOP without inventing anything.

   Offline: every network edge sits behind an exported pure function, so the
   part that decides what a published call is worth is the part under test.

   THE RULES UNDER TEST
   - the price graded is the PUBLISHED price, never a live one
   - the close is the engine's closing fair line; missing means waiting
   - a result comes from the close pipeline or an agreed final; two sources
     that disagree grade nothing
   - a graded pick is never re-graded
   - NO QUALIFYING BETS counts as discipline, never as a gap
   - the record file is byte-stable when nothing changed
   - a legacy brief (no raw fields on its prices) still grades

   Run: node tools/record/grade_briefs.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const G = require(path.join(__dirname, 'grade_briefs.js'));
const P = require(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const KICK = '2026-09-11T00:15:00Z';           /* Thursday night ET */
const BEFORE = Date.parse('2026-09-10T20:00:00Z');
const AFTER = Date.parse('2026-09-11T09:00:00Z');   /* well past the 6h no-row window */

/* A stored public brief, exactly as share() writes it (new snapshot shape). */
function price(over) {
  return Object.assign({ event_id: 'ev1', matchup: 'Chiefs @ Ravens', market: 'Spread', market_key: 'spreads', selection: 'Chiefs +3.5', selection_raw: 'Chiefs', line: 3.5,
    odds: '-110', odds_am: -110, book: 'DraftKings', captured_at: '2026-09-10T18:00:00Z', verdict: 'BET', kind: 'pick', rank: 1,
    commence: KICK, sport_key: 'americanfootball_nfl', sport_label: 'NFL', home: 'Ravens', away: 'Chiefs' }, over || {});
}
function brief(over, prices) {
  return Object.assign({ id: 'b1', share_slug: 'abcdefghijkl', report_key: 'GAME:TNF:ev1', report_type: 'GAME', preset: 'TNF', version_no: 1, sport: 'americanfootball_nfl', sport_label: 'NFL',
    title: 'Thursday Night Football', event_label: 'Chiefs at Ravens', when_label: 'Thursday, Sep 10, 8:15 PM ET', generated_at: '2026-09-10T18:05:00Z',
    public_payload: { cards: [{ rank: 1, brief: { call: { verdict: 'BET', selection: 'Chiefs +3.5', odds: '-110' } } }], watch: [], slate: null,
      data_status: { status: 'Current', price_captured_at: '2026-09-10T18:00:00Z', prices: prices || [price()] } } }, over || {});
}
function closeRow(over) {
  return Object.assign({ event_id: 'ev1', sport_key: 'americanfootball_nfl', market: 'spreads', selection: 'Chiefs', point: 3.5, home_team: 'Ravens', away_team: 'Chiefs',
    commence_time: KICK, best_dec: 1.8, best_book: 'FanDuel', closing_sharp_fair: 0.5556, closed_at: '2026-09-11T00:10:00Z', result: 'win', graded_at: '2026-09-11T04:00:00Z' }, over || {});
}

/* ---- picks out of a brief ------------------------------------------------ */
{
  const pk = G.picksFromBrief(brief())[0];
  chk('a stored price becomes a pick with its raw identity', pk.event_id === 'ev1' && pk.market_key === 'spreads' && pk.selection_raw === 'Chiefs' && pk.line === 3.5 && pk.odds_am === -110 && pk.verdict === 'BET' && pk.kind === 'pick', pk);
  chk('the grade key is event|market|side|line', pk.key === 'ev1|spreads|Chiefs|3.5', pk.key);
  /* A brief shared before the snapshot carried raw fields. */
  const legacy = brief({}, [{ event_id: 'ev1', matchup: 'Chiefs @ Ravens', market: 'Spread', selection: 'Chiefs +3.5', line: 3.5, odds: '-110', book: 'DraftKings', captured_at: '2026-09-10T18:00:00Z' }]);
  const lp = G.picksFromBrief(legacy)[0];
  chk('a legacy brief recovers market key, side and line from its labels', lp.market_key === 'spreads' && lp.selection_raw === 'Chiefs' && lp.line === 3.5 && lp.odds_am === -110, lp);
  chk('a legacy brief takes its verdict from the card it was published with', lp.verdict === 'BET' && lp.kind === 'pick', lp);
  const tot = G.picksFromBrief(brief({}, [{ event_id: 'ev1', market: 'Total', selection: 'Over 47.5', odds: '+100' }]))[0];
  chk('a legacy total parses to Over / 47.5', tot.market_key === 'totals' && tot.selection_raw === 'Over' && tot.line === 47.5 && tot.odds_am === 100, tot);
  const ml = G.picksFromBrief(brief({}, [{ event_id: 'ev1', market: 'Moneyline', selection: 'Chiefs ML', odds: '+145' }]))[0];
  chk('a legacy moneyline strips the ML suffix', ml.market_key === 'h2h' && ml.selection_raw === 'Chiefs' && ml.line === null, ml);
}

/* ---- matching the close --------------------------------------------------- */
{
  const pk = G.picksFromBrief(brief())[0];
  chk('the pick finds its own signal row', G.matchClose(pk, [closeRow(), closeRow({ selection: 'Ravens', point: -3.5 })]).selection === 'Chiefs');
  chk('a different line is a different row', G.matchClose(pk, [closeRow({ point: 4.5 })]) === null);
  chk('a different market is a different row', G.matchClose(pk, [closeRow({ market: 'h2h', point: null })]) === null);
  chk('no event id, no match', G.matchClose(Object.assign({}, pk, { event_id: null }), [closeRow()]) === null);
}

/* ---- grading one pick ----------------------------------------------------- */
{
  const pk = G.picksFromBrief(brief())[0];
  const g = G.gradeOne(pk, closeRow(), null, AFTER, { closeSource: 'ok' });
  chk('a graded pick carries the close, the cents and the result', g.status === 'graded' && g.grade.close_fair_odds === '-125' && g.grade.cents === 15 && g.grade.result === 'win' && g.grade.beat_close === true, g);
  chk('CLV is the engine arithmetic, fair × decimal − 1', Math.abs(g.grade.clv - (0.5556 * (1 + 100 / 110) - 1)) < 1e-4, g.grade.clv);
  chk('the receipt reads like a sportsbook', g.grade.text === 'Closed -125. Beat the close by 15 cents. Won.', g.grade.text);
  chk('the closing board price is carried, labelled by book', g.grade.close_best_odds === '-125' && g.grade.close_best_book === 'FanDuel', g.grade);
  chk('before kickoff nothing is graded', G.gradeOne(pk, closeRow(), null, BEFORE, { closeSource: 'ok' }).status === 'pending_kickoff');
  const noClose = G.gradeOne(pk, null, null, AFTER, { closeSource: 'ok' });
  chk('no signal row after kickoff says so, and grades nothing', noClose.status === 'no_signal_row' && noClose.grade === null, noClose);
  const noView = G.gradeOne(pk, null, null, AFTER, { closeSource: 'unavailable' });
  chk('a missing close view is reported as a deploy state, not a result', noView.status === 'no_close_source' && noView.grade === null, noView);
  const closeOnly = G.gradeOne(pk, closeRow({ result: null, graded_at: null }), null, AFTER, { closeSource: 'ok' });
  chk('a close without a result grades CLV and waits for the final', closeOnly.status === 'awaiting_result' && closeOnly.grade.cents === 15 && closeOnly.grade.result === null && /Final pending/.test(closeOnly.grade.text), closeOnly);
  const noFair = G.gradeOne(pk, closeRow({ closing_sharp_fair: null, result: null }), null, AFTER, { closeSource: 'ok' });
  chk('a row with no closing fair line is waiting on the close, not graded', noFair.status === 'awaiting_close' && noFair.grade.clv === null, noFair);
  const noOdds = G.gradeOne(Object.assign({}, pk, { odds_am: null, odds: null }), closeRow(), null, AFTER, { closeSource: 'ok' });
  chk('a pick published without a price cannot be graded against the close', noOdds.status === 'no_odds' && noOdds.grade === null, noOdds);
  const failed = G.gradeOne(Object.assign({}, pk, { verdict: 'DATA CHECK FAILED' }), closeRow(), null, AFTER, { closeSource: 'ok' });
  chk('a failed data check was never a call and is not graded as one', failed.status === 'not_gradeable', failed);
  chk('the live price cannot change a grade: the entry is the published odds', g.grade.entry_odds === '-110');
}

/* ---- the final score ------------------------------------------------------ */
{
  const pk = G.picksFromBrief(brief())[0];
  const final = { ok: true, home_score: 27, away_score: 24, agreed_by: ['espn', 'nflverse'] };
  const g = G.gradeOne(pk, closeRow({ result: null, graded_at: null }), final, AFTER, { closeSource: 'ok' });
  chk('Chiefs +3.5 losing by 3 is a win from the score', g.status === 'graded' && g.grade.result === 'win' && /final score/.test(g.grade.result_source), g);
  chk('the score is carried with its sources', g.score && g.score.home_score === 27 && g.score.away_score === 24 && g.score.source === 'espn+nflverse', g.score);
  const push = G.gradeOne(Object.assign({}, pk, { line: 3, selection: 'Chiefs +3', key: 'ev1|spreads|Chiefs|3' }), closeRow({ point: 3, result: null }), final, AFTER, { closeSource: 'ok' });
  chk('a spread landing exactly is a push', push.grade.result === 'push', push.grade);
  const contested = G.gradeOne(pk, closeRow({ result: 'loss' }), final, AFTER, { closeSource: 'ok' });
  chk('the pipeline saying loss and the score saying win grades NOTHING', contested.status === 'contested' && contested.grade === null && /disagree|says/.test(contested.note), contested);
  const scoreOnly = G.gradeOne(pk, null, final, AFTER, { closeSource: 'ok' });
  chk('a final with no close records the outcome and keeps waiting on the close', scoreOnly.status === 'awaiting_close' && scoreOnly.grade.result === 'win' && scoreOnly.grade.clv === null, scoreOnly);
  chk('a total is graded from the combined score', P.outcomeFromScore({ market_key: 'totals', selection_raw: 'Under', point: 51.5, home_score: 27, away_score: 24 }) === 'win');
  chk('a moneyline on the loser is a loss', P.outcomeFromScore({ market_key: 'h2h', selection_raw: 'Chiefs', home: 'Ravens', away: 'Chiefs', home_score: 27, away_score: 24 }) === 'loss');
  chk('a side that matches neither team grades nothing', P.outcomeFromScore({ market_key: 'h2h', selection_raw: 'Bills', home: 'Ravens', away: 'Chiefs', home_score: 27, away_score: 24 }) === null);
  chk('an ambiguous containment (Miami vs Miami) grades nothing', P.sideOf('Miami', 'Miami (OH)', 'Miami (FL)') === null);
  chk('an accent-folded name still matches', P.sideOf('San Jose State', 'San José State', 'Stanford') === 'home');
}

/* ---- the whole record ------------------------------------------------------ */
{
  const rows = [brief(), brief({ id: 'b2', share_slug: 'mmmmmmmmmmmm', report_type: 'SLATE', preset: 'CFB', title: 'College Football', event_label: null, generated_at: '2026-09-04T18:00:00Z',
    public_payload: { cards: [], watch: [{ rank: 1, brief: { call: { verdict: 'LEAN', selection: 'Baylor -3.5', odds: '-108' } } }], slate: { headline: 'NO QUALIFYING BETS', no_bet: true, counts: { bet: 0, lean: 1, wait: 0, pass: 2, failed: 0 } },
      data_status: { status: 'Current', prices: [price({ event_id: 'ev9', matchup: 'Texas Tech @ Baylor', selection: 'Baylor -3.5', selection_raw: 'Baylor', line: -3.5, odds: '-108', odds_am: -108, verdict: 'LEAN', kind: 'watch', rank: 1, commence: '2026-09-05T23:30:00Z', sport_key: 'americanfootball_ncaaf', sport_label: 'CFB', home: 'Baylor', away: 'Texas Tech' })] } } })];
  const closes = [closeRow(), closeRow({ event_id: 'ev9', sport_key: 'americanfootball_ncaaf', selection: 'Baylor', point: -3.5, home_team: 'Baylor', away_team: 'Texas Tech', commence_time: '2026-09-05T23:30:00Z', closing_sharp_fair: 0.50, result: 'loss' })];
  const rec = G.buildRecord(rows, closes, {}, null, AFTER, { closeSource: 'ok', closeSourceName: 'public_brief_closes' });
  chk('every public brief is in the record, newest first', rec.briefs.length === 2 && rec.briefs[0].id === 'b1' && rec.briefs[1].id === 'b2', rec.briefs.map(b => b.id));
  chk('the TNF call graded', rec.briefs[0].picks[0].status === 'graded' && rec.briefs[0].picks[0].graded_at === new Date(AFTER).toISOString(), rec.briefs[0].picks[0]);
  chk('the no-bet slate is kept and marked as discipline', rec.briefs[1].no_bet === true && rec.summary.no_bet_briefs === 1, rec.summary);
  chk('a watch row grades but is research, not a call', rec.briefs[1].picks[0].status === 'graded' && rec.summary.calls.n === 1 && rec.summary.research.n === 1, rec.summary);
  chk('the headline record counts only published calls', rec.summary.calls.graded === 1 && rec.summary.calls.win === 1 && rec.summary.calls.beat_rate === 1 && rec.summary.calls.avg_cents === 15, rec.summary.calls);
  chk('by preset, TNF and CFB are separate rows', rec.summary.by_preset.TNF && rec.summary.by_preset.TNF.calls.n === 1 && rec.summary.by_preset.CFB && rec.summary.by_preset.CFB.no_bet === 1, rec.summary.by_preset);
  const cal = rec.calibration;
  chk('calibration is verdict × sport', cal.length === 2 && cal[0].verdict === 'BET' && cal[0].sport === 'NFL' && cal[1].verdict === 'LEAN' && cal[1].sport === 'CFB', cal);
  chk('the LEAN row that missed the close says so', cal[1].with_close === 1 && cal[1].beat === 0 && cal[1].loss === 1, cal[1]);
  chk('the record summary filters by preset', P.recordSummary(rec.briefs, { preset: 'CFB' }).briefs === 1 && P.recordSummary(rec.briefs, { preset: 'CFB' }).calls.n === 0);

  /* Immutability: a later run with a DIFFERENT close row must not touch a graded pick. */
  const later = G.buildRecord(rows, [closeRow({ closing_sharp_fair: 0.40, result: 'loss' }), closes[1]], {}, rec, AFTER + 3600e3, { closeSource: 'ok', closeSourceName: 'public_brief_closes' });
  chk('a graded pick is never re-graded', later.briefs[0].picks[0].grade.close_fair_odds === '-125' && later.briefs[0].picks[0].grade.result === 'win' && later.briefs[0].picks[0].graded_at === rec.briefs[0].picks[0].graded_at, later.briefs[0].picks[0].grade);
  chk('nothing changed, so the file is byte-stable (same object back)', later === rec);
  /* A pending pick does update when its close arrives. */
  const pendingFirst = G.buildRecord(rows, [], {}, null, AFTER, { closeSource: 'ok' });
  chk('with no closes, the calls wait', pendingFirst.briefs[0].picks[0].status === 'no_signal_row' && pendingFirst.summary.calls.graded === 0);
  const thenGraded = G.buildRecord(rows, closes, {}, pendingFirst, AFTER + 3600e3, { closeSource: 'ok' });
  chk('a waiting pick grades once its close exists', thenGraded !== pendingFirst && thenGraded.briefs[0].picks[0].status === 'graded');
  /* A brief withdrawn from public stays in the record. */
  const withdrawn = G.buildRecord([rows[0]], closes, {}, rec, AFTER + 3600e3, { closeSource: 'ok' });
  chk('a withdrawn brief keeps its grade, marked', withdrawn.briefs.length === 2 && withdrawn.briefs.filter(b => b.id === 'b2')[0].still_public === false, withdrawn.briefs.map(b => [b.id, b.still_public]));
  /* Zero briefs is an honest, empty record. */
  const empty = G.buildRecord([], [], {}, null, AFTER, { closeSource: 'unavailable' });
  chk('no briefs means an empty record with a note, not an invented one', empty.briefs.length === 0 && empty.summary.calls.n === 0 && /brief_record\.sql/.test(empty.notes.join(' ')), empty);
}

/* ---- the shared receipt on the in-app card --------------------------------- */
{
  const o = P.outcomeOf({ clv: 0.021, beat_close: true, closing: 0.5556, result: 'win', entry_am: -110 });
  chk('the in-app receipt uses the engine CLV verbatim and adds display cents', o.clv === 0.021 && o.cents === 15 && o.text === 'Closed -125. Beat the close by 15 cents. Won.', o);
  chk('no graded row, no receipt', P.outcomeOf({ clv: null, result: null }) === null);
  const miss = P.outcomeOf({ clv: -0.02, beat_close: false, closing: 0.5, result: 'loss', entry_am: -115 });
  chk('a miss reads as a miss', /Missed the close by 15 cents\. Lost\./.test(miss.text), miss.text);
}

/* ---- cents arithmetic across the +100 / -100 seam --------------------------- */
{
  chk('-110 vs -125 is 15 cents', P.centsBetween(-110, -125) === 15);
  chk('+105 vs -110 is 15 cents', P.centsBetween(105, -110) === 15);
  chk('-105 vs +105 is minus 10 cents', P.centsBetween(-105, 105) === -10);
  chk('+120 vs +110 is 10 cents', P.centsBetween(120, 110) === 10);
  chk('a fair probability of 0.5 is +100', P.probToAmerican(0.5) === 100 && P.fmtAmerican(P.probToAmerican(0.5)) === '+100');
  chk('American -110 is decimal 1.909', Math.abs(P.americanToDec(-110) - 1.90909) < 1e-4);
  chk('an American price inside (-100, 100) is not a price', P.americanToDec(50) === null && P.parseAmerican('50') === null);
}

/* ---- helpers ------------------------------------------------------------------ */
{
  chk('football maps to its feed; nothing else does', G.feedKind('americanfootball_nfl') === 'nfl' && G.feedKind('americanfootball_ncaaf') === 'cfb' && G.feedKind('basketball_nba') === null);
  chk('a January game belongs to the previous season', G.seasonOf('2027-01-10T00:00:00Z') === 2026 && G.seasonOf('2026-09-10T00:00:00Z') === 2026);
  chk('args parse', G.parseArgs(['--out', 'x.json', '--json', '--now', 'T']).out === 'x.json');
}

done();
