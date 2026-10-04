#!/usr/bin/env node
/* ===========================================================================
   PORTFOLIO and PROCESS — the reader's own history, held to what it can say.

     Portfolio (lib/edgedesk_portfolio.js)
       1  one position shape for every source (the device ledger, the Card's
          BET PLACED), so a total never mixes units;
       2  dollars only from positions that carried a stake; a reader who never
          enters stakes gets a flat-unit record, labelled as one;
       3  open exposure, the calendar by local day, recent activity;
       4  an import guesses nothing: no result → open, no stake → unstaked,
          an unreadable row is reported with its reason, a re-import adds 0;
       5  an empty portfolio says how to build it and never claims a sync.

     Process (lib/edgedesk_process.js)
       6  below MIN_PROFILE graded positions: no score, no insight — a
          "building" state with what each step unlocks;
       7  a comparison needs MIN_GROUP graded on BOTH sides, a gap of MIN_GAP,
          and a two-proportion z of Z_SHOW; "clear" only at 95%;
       8  a position without a game time is never put in a timing bucket;
       9  the page never shows EdgeDesk's model record as the reader's.

   Run: node tools/app/portfolio_process.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PF = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const PC = require(path.join(ROOT, 'lib', 'edgedesk_process.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 240); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
}
const eq = (name, got, want) => chk(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const near = (a, b, e) => Math.abs(a - b) < (e || 1e-6);

const NOW = Date.parse('2026-10-04T18:00:00Z');
const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();

/* ===================================================== 1 · positions */
{
  const a = PF.fromLedger({ id: 'b1', ts: iso(NOW - DAY), sport: 'NCAAF', sel: 'Iowa -2.5', odds: -110, stake: 100, result: 'win', clv: 0.02, market: 'spreads', sharp_fair: 0.55 });
  eq('a ledger bet keeps its selection, sport label and market label', [a.sel, a.sport, a.market, a.src], ['Iowa -2.5', 'CFB', 'Spread', 'ledger']);
  chk('a staked win pays stake × (decimal − 1)', near(a.pnl, 90.91, 0.01), a.pnl);
  chk('CLV from the graded signal is a price-kind CLV', a.clv.kind === 'price' && near(a.clv.v, 0.02));
  chk('and a positive CLV with no stored flag is a beat', a.beat_close === true);
  chk('the edge at entry comes from the sharp fair line it was logged against', near(a.entryEdge, 0.55 * (1 + 100 / 110) - 1));
  const b = PF.fromLedger({ id: 'b2', ts: iso(NOW), sel: 'Bills ML', odds: 150, stake: null, result: 'loss' });
  chk('an unstaked bet has no dollar P&L', b.pnl === null && b.stake === null);
  const c = PF.fromLedger({ id: 'b3', ts: iso(NOW), sel: 'X', odds: -110, stake: 0, result: null });
  chk('a zero stake is no stake, and an unsettled bet is open', c.stake === null && c.result === null);
  const d = PF.fromLedger({ id: 'b4', ts: iso(NOW), sel: 'X', odds: -110, result: 'push', clv: 0 });
  chk('a push with flat CLV is not counted as beating or missing the close', d.beat_close === null);
  const e = PF.fromLedger({ id: 'b5', ts: iso(NOW), sel: 'X', odds: -110, beat_close: false, clv: 0.01 });
  chk('a stored beat_close flag wins over the sign of the CLV', e.beat_close === false);
  const k = PF.fromCard({ bet_key: 'ub1', team: 'Texas Tech', line: -3.5, odds: -110, stake_dollars: 100, units: 1, unit_value: 100, placed_at: iso(NOW - 2 * DAY), kickoff: iso(NOW - DAY), sport: 'CFB', entry_vs_recommendation: 'OUTSIDE_RANGE', away_team: 'Kansas', home_team: 'Texas Tech' },
    { result: 'loss', clv_points: -1.5, units_won: -1 });
  eq('a Card bet reads as a position with points CLV and its range', [k.src, k.sel, k.clv.kind, k.clv.v, k.beat_close, k.range, k.pnl], ['card', 'Texas Tech -3.5', 'points', -1.5, false, 'outside', -100]);
  const k2 = PF.fromCard({ bet_key: 'ub2', team: 'Iowa', line: 3, odds: -110, units: 2, unit_value: 50, placed_at: iso(NOW), kickoff: iso(NOW + DAY), sport: 'CFB' }, null);
  chk('an ungraded Card bet is open with no CLV', k2.result === null && k2.clv === null && k2.beat_close === null);
  const k3 = PF.fromCard({ bet_key: 'ub3', team: 'Iowa', line: 3, odds: -110, units: 2, unit_value: 50, placed_at: iso(NOW), sport: 'CFB' }, { result: 'win', clv_points: 0, units_won: 1.82 });
  chk('a Card win without a dollar stake is priced from units × the unit value it was placed at', near(k3.pnl, 91));
  const all = PF.collect([{ id: 'x', ts: iso(NOW - 3 * DAY), sel: 'A', odds: -110 }, { id: 'y', ts: iso(NOW - DAY), sel: 'B', odds: -110 }],
    [{ bet_key: 'z', team: 'C', line: 1, odds: -110, placed_at: iso(NOW - 2 * DAY) }], () => null);
  eq('collect reads both stores, newest first', all.map((p) => p.id), ['y', 'z', 'x']);
  chk('a grader that throws costs only the grade', PF.collect([], [{ bet_key: 'q', team: 'Q', odds: -110, placed_at: iso(NOW) }], () => { throw new Error('x'); }).length === 1);
}

/* ===================================================== 2-3 · overview, calendar */
{
  const L = [
    { id: 'w', ts: iso(NOW - 3 * DAY), commence: iso(NOW - 2 * DAY), sel: 'W', odds: 100, stake: 50, result: 'win' },
    { id: 'l', ts: iso(NOW - 3 * DAY), commence: iso(NOW - 2 * DAY), sel: 'L', odds: -110, stake: 55, result: 'loss' },
    { id: 'p', ts: iso(NOW - 3 * DAY), commence: iso(NOW - 2 * DAY), sel: 'P', odds: -110, stake: 20, result: 'push' },
    { id: 'u', ts: iso(NOW - 10 * DAY), commence: iso(NOW - 9 * DAY), sel: 'U', odds: 200, stake: null, result: 'win' },
    { id: 'o', ts: iso(NOW - 3600e3), commence: iso(NOW + DAY), sel: 'O', odds: 150, stake: 40, result: null },
    { id: 'o2', ts: iso(NOW - 3600e3), commence: iso(NOW + 2 * DAY), sel: 'O2', odds: -110, stake: null, result: null }
  ];
  const ov = PF.overview(PF.collect(L, [], null), NOW);
  const t = ov.totals;
  eq('W-L-P counts every settled position', [t.w, t.l, t.p, t.settled, t.open], [2, 1, 1, 4, 2]);
  chk('dollar P&L counts only staked, non-push positions', near(t.pnl, -5) && near(t.staked, 105) && t.pnl_n === 2, t);
  chk('ROI is P&L over what was risked', near(t.roi, -5 / 105));
  chk('the flat-unit record counts every settled non-push position at 1u', t.unit_n === 3 && near(t.unit_pnl, 1 - 1 + 2), t);
  chk('open exposure is the open stakes and what they would win', near(t.open_staked, 40) && near(t.open_to_win, 60) && t.open_unstaked === 1, t);
  chk('this week holds the positions settled in the last seven days', ov.week.settled === 3);
  eq('current positions are the open ones, soonest game first', ov.open.map((p) => p.id), ['o', 'o2']);
  chk('recent activity is newest first and capped', ov.activity.length <= 6 && ov.activity[0].at >= ov.activity[ov.activity.length - 1].at);
  const empty = PF.overview([], NOW);
  chk('an empty portfolio is marked empty', empty.empty === true);
  const h = PF.overviewHTML(empty, {});
  chk('and says how to build it', /Build your portfolio/.test(h) && /Connect accounts/.test(h) && /data-pf-go="accounts"/.test(h));
  chk('and never claims a sportsbook sync it does not have', /does not sync with sportsbooks or prediction markets yet/.test(h));
  const unst = PF.overviewHTML(PF.overview(PF.collect([{ id: 'a', ts: iso(NOW), sel: 'A', odds: 100, result: 'win' }], [], null), NOW), {});
  chk('a reader with no stakes sees a flat-1u P&L, labelled as one', /flat 1u/.test(unst) && !/\$/.test(unst.replace(/\$0/g, '').replace(/data-[^ ]+/g, '')));
  const d = new Date(NOW - 2 * DAY);
  const cal = PF.calendar(PF.collect(L, [], null), d.getFullYear(), d.getMonth());
  const cell = cal.cells.filter((c) => c && c.day === d.getDate())[0];
  chk('the calendar puts a position on its game day', cell && cell.n === 3 && cell.w === 1 && cell.l === 1 && cell.p === 1, cell);
  chk('and its dollars on that day', cell && near(cell.pnl, -5) && cell.has_dollars);
  chk('the calendar is whole weeks', cal.cells.length % 7 === 0);
  chk('an open position is never on the calendar', cal.n === 3 + (new Date(NOW - 9 * DAY).getMonth() === d.getMonth() ? 1 : 0));
  const other = PF.calendar(PF.collect(L, [], null), 2020, 0);
  chk('another month is empty', other.n === 0 && other.pnl === null);
  chk('the calendar renders its month', /pf-cal-c/.test(PF.calendarHTML(cal)));
}

/* ===================================================== 4 · import */
{
  const csv = 'Date,Selection,Odds,Stake,Result,Sport,Book\n'
    + '2026-09-01,"Bills -3, alt line",-110,$50,W,NFL,DraftKings\n'
    + '2026-09-02,Jets ML,2.50,25,lost,NFL,FanDuel\n'
    + '2026-09-03,Bad odds,abc,10,W,NFL,\n'
    + '2026-09-04,Pending one,+120,,,NFL,\n'
    + '2026-09-05,,-110,10,W,NFL,\n'
    + '2026-09-06,Push one,-105,20,void,NFL,\n'
    + '2026-09-01,"Bills -3, alt line",-110,$50,W,NFL,DraftKings\n';
  const r = PF.parseCsv(csv, NOW);
  eq('rows are read by header name, quoted commas kept', r.rows.map((x) => x.sel), ['Bills -3, alt line', 'Jets ML', 'Pending one', 'Push one']);
  eq('American odds stay; decimal 2.50 becomes +150', r.rows.map((x) => x.odds), [-110, 150, 120, -105]);
  eq('a $ and a comma in the stake are read; a blank stake stays unstaked', r.rows.map((x) => x.stake), [50, 25, null, 20]);
  eq('results are mapped, never guessed (blank stays open; void is a push)', r.rows.map((x) => x.result), ['win', 'loss', null, 'push']);
  chk('P&L is computed from the row, not trusted from a column', near(r.rows[0].pnl, 45.45, 0.01) && r.rows[1].pnl === -25 && r.rows[2].pnl === null && r.rows[3].pnl === 0);
  chk('an unreadable row is reported with its reason', r.errors.length === 2 && /Row 4/.test(r.errors[0]) && /not American/.test(r.errors[0]) && /Row 6: no selection/.test(r.errors[1]), r.errors);
  chk('a duplicate row in the same file is imported once', r.rows.length === 4);
  chk('imported rows are marked, manual, and carry no CLV', r.rows.every((x) => x.imported && x.auto === false && x.closeFair === null && x.clv === undefined));
  const m1 = PF.mergeImport([{ id: 'b1' }], r.rows);
  const m2 = PF.mergeImport(m1.list, r.rows);
  chk('a re-import of the same file adds nothing', m1.added === 4 && m2.added === 0 && m2.skipped === 4 && m2.list.length === 5);
  chk('a file without selection or odds columns says which', PF.parseCsv('when,what\n1,2', NOW).errors.length === 2);
  chk('a header-only file says so', /header row and at least one bet/.test(PF.parseCsv('Selection,Odds', NOW).errors[0]));
  const p = PF.collect(r.rows, [], null);
  chk('imported positions count for P&L but are never graded for Process', p.every((x) => x.beat_close === null) && PF.overview(p, NOW).totals.pnl_n === 2);
}

/* ===================================================== 6-8 · process */
function hist(n, opts) {
  opts = opts || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const early = i % 2 === 0, g = NOW - (i + 1) * DAY;
    out.push({ id: 'h' + i, ts: iso(g - (early ? 48 : 1) * 3.6e6), commence: opts.noTime ? null : iso(g), sport: 'NCAAF', sel: 'S' + i, odds: -110, stake: 10,
      result: 'win', market: 'spreads', clv: 0.01, beat_close: opts.flat ? (i % 3 !== 0) : (early ? true : (i % 4 === 1)) });
  }
  return PF.collect(out, [], null);
}
{
  const e = PC.profile([], { now: NOW });
  chk('no positions: empty, no score, no insight', e.state === 'empty' && e.score === null && !e.working.length && !e.costing.length);
  const b = PC.profile(hist(PC.MIN_PROFILE - 1), { now: NOW });
  chk('one short of the profile: building, no score, no insight', b.state === 'building' && b.score === null && !b.working.length && !b.costing.length);
  chk('and it says how many more it needs', /Grade 1 more position /.test(b.focus.text), b.focus.text);
  const bh = PC.pageHTML(b, {});
  chk('the building page says what it is building, with progress', /Building your process profile/.test(bh) && /19 of 20 positions graded/.test(bh) && /role="progressbar"/.test(bh));
  chk('the building page shows no score and no insight', !/class="pc-score"/.test(bh) && !/class="pc-ins/.test(bh));
  chk('it lists what unlocks next', /What unlocks/.test(bh) && /Edge capture/.test(bh) && /Process score, what’s working/.test(bh));
  chk('edge capture unlocks at MIN_EDGE, before the score', b.edge && b.edge.n === 19 && /Edge capture/.test(bh));
  chk('below MIN_EDGE there is no edge read either', PC.profile(hist(PC.MIN_EDGE - 1), { now: NOW }).edge === null);

  const r = PC.profile(hist(30), { now: NOW });
  chk('at the profile: ready, with a score and its interval', r.state === 'ready' && r.score && r.score.n === 30 && r.score.ci && r.score.ci.lo < r.score.rate && r.score.rate < r.score.ci.hi);
  chk('a real gap is named on both sides of the split', r.working.some((x) => x.family === 'timing' && x.key === 'early') && r.costing.some((x) => x.family === 'timing' && x.key === 'late'), [r.working, r.costing]);
  chk('each insight carries its numbers and its why', r.working.concat(r.costing).every((x) => /beat the closing line \d+% of the time, against \d+%/.test(x.text) && /graded in this group/.test(x.why)));
  chk('a clear gap is labelled clear', r.working[0].strength === 'clear' && Math.abs(r.working[0].z) >= PC.Z_CLEAR);
  chk('next focus points at what is costing', /^Examine your late positions/.test(r.focus.text), r.focus.text);
  const rh = PC.pageHTML(r, {});
  ['Process score', 'What’s working', 'What’s costing you', 'This week', 'Next focus', 'Go deeper', 'Edge capture', 'Timing'].forEach((s) =>
    chk('the ready page carries "' + s + '"', rh.indexOf(s) >= 0));
  chk('the deeper tables sit behind disclosure', (rh.match(/<details class="pc-deep"/g) || []).length >= 3);

  const flat = PC.profile(hist(30, { flat: true }), { now: NOW });
  chk('no real difference: no insight, and the page says so', flat.state === 'ready' && !flat.working.length && !flat.costing.length && /Nothing in your history differs/.test(flat.focus.text), [flat.working, flat.costing]);

  /* a group with fewer than MIN_GROUP on one side is never compared */
  const few = hist(24).map((p, i) => Object.assign({}, p, { sport: i < PC.MIN_GROUP - 1 ? 'NFL' : 'CFB', beat_close: i < PC.MIN_GROUP - 1 ? false : true }));
  const fp = PC.profile(few, { now: NOW });
  chk('a group with fewer than MIN_GROUP graded is shown but never compared', fp.groups.filter((g) => g.id === 'sport')[0].rows.every((x) => !x.comparable) && !fp.costing.some((x) => x.family === 'sport'));

  const nt = PC.profile(hist(30, { noTime: true }), { now: NOW });
  chk('a position without a game time is in no timing bucket', !nt.groups.some((g) => g.id === 'timing'));

  const j = PC.pageHTML(r, { journal: { total: 12, wagered: 5, passed: 6, graded: 4, beat: 3 } });
  chk('the decision journal sits in the deep sections, with a way into it', /Decision journal/.test(j) && /3 of 4 graded wagers beat the close/.test(j) && /data-pc-journal/.test(j));
  chk('Process points at the methodology, not at the model record', /data-nav="methodology"/.test(rh) && !/Model performance/.test(rh) && !/data-nav="record"/.test(rh));
  const w = PC.wilson(5, 10);
  chk('the Wilson interval is the textbook one', near(w.lo, 0.2366, 1e-3) && near(w.hi, 0.7634, 1e-3), w);
}

console.log('');
failures.forEach((f) => console.log('  FAIL  ' + f));
console.log('\nportfolio + process: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
