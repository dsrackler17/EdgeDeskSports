#!/usr/bin/env node
/* ===========================================================================
   THE STAKING SCORECARD — what it is allowed to say, and when.

   The failure this file exists to prevent is a scorecard that reads like a
   result on four graded bets. Every assertion below is about the SENTENCE the
   scorecard produces, not just its arithmetic: below the sample floor it must
   refuse a reading in either direction, and above it it must never call a
   profit a claim about the future.

   Run: node tools/intelligence/stake_grades.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'stake_grades.js'));
const LL = require(path.join(__dirname, 'learning_loop.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function near(name, a, b, tol) { chk(name, a != null && Math.abs(a - b) <= (tol == null ? 1e-6 : tol), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 320)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* One row shaped exactly as the view returns it, with the three profit
   columns the view computes — this file never recomputes them, because the
   database is the one that owns that arithmetic and a second copy here would
   drift away from it silently. */
function row(o) {
  o = o || {};
  const dec = o.odds_decimal == null ? 1.909 : o.odds_decimal;
  const res = o.result === undefined ? 'win' : o.result;
  const u = o.recommended_units == null ? 0.5 : o.recommended_units;
  const profit = (units) => (res === 'win' ? units * (dec - 1) : res === 'loss' ? -units : res === 'push' ? 0 : null);
  return Object.assign({
    recommendation_id: o.id || Math.random().toString(36).slice(2),
    sport: 'americanfootball_nfl', market: 'spreads', status: 'BET',
    recommendation_tier: 'VALIDATED', model_version: 'edgedesk-1',
    odds_decimal: dec, recommended_units: u, result: res,
    grade_state: res == null ? 'NOT_CLOSED' : 'GRADED',
    profit_units: profit(u), profit_units_flat_half: profit(0.5), profit_units_flat_one: profit(1),
    clv: 0.4, beat_close: true, expected_value: 0.03, reliability_score: 0.6,
    brier_conservative: 0.24, brier_calibrated: 0.25, log_loss_conservative: 0.66,
    reader_response: null, reader_accepted_units: null, pass_reason: null,
  }, o);
}

/* ═══ 1. THE SAMPLE FLOOR IS A REFUSAL, NOT A CAVEAT ═══════════════════ */
{
  const four = [row({ result: 'win' }), row({ result: 'win' }), row({ result: 'win' }), row({ result: 'win' })];
  const r = S.report(four, { now: 'T' });
  const g = r.groups.all;
  eq('four graded bets are counted', g.graded, 4);
  eq('and none of them is a sufficient sample', g.sufficient_sample, false);
  chk('so the reading refuses in both directions', /no reading is claimed, in either direction/.test(g.reading), g.reading);
  chk('and it does NOT quote a profit figure a reader could screenshot', !/ROI/.test(g.reading), g.reading);
  eq('the floor it refused against is published', r.sample_floor, S.SAMPLE_FLOOR);
}

/* ═══ 2. BEATING FLAT IS THE ONLY QUESTION IT CAN ANSWER ═══════════════ */
{
  /* 60 positions. The engine sizes the winners at 1u and the losers at 0.25u,
     which is what a sizing engine is FOR — same selections, better staking. */
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const win = i % 3 !== 0;                                   /* 40-20 */
    rows.push(row({ id: 'g' + i, result: win ? 'win' : 'loss', recommended_units: win ? 1 : 0.25 }));
  }
  const g = S.report(rows).groups.all;
  eq('sixty graded positions clear the floor', g.sufficient_sample, true);
  chk('the engine beat both flat arms', g.beats_flat_half === true && g.beats_flat_one === true, g);
  chk('and the reading says it cleared them', /cleared both flat baselines/.test(g.reading), g.reading);
  chk('while refusing to promise it again', /not a claim of profit going forward/.test(g.reading), g.reading);
  /* the mirror: the engine sizes the LOSERS big. Same selections, same
     record, and the sizing has actively hurt. */
  const bad = rows.map((r) => row({ id: r.recommendation_id, result: r.result, recommended_units: r.result === 'win' ? 0.25 : 1 }));
  const b = S.report(bad).groups.all;
  chk('sizing the losers big fails both baselines', b.beats_flat_half === false && b.beats_flat_one === false, b);
  chk('and the reading says the rules earned nothing', /have not earned anything here over flat staking/.test(b.reading), b.reading);
  chk('the two runs took the SAME positions, which is what makes them comparable', g.positions === b.positions && g.wins === b.wins && g.losses === b.losses, { g: [g.positions, g.wins], b: [b.positions, b.wins] });
}

/* ═══ 3. LOSING LESS IS NOT WINNING ════════════════════════════════════ */
{
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row({ id: 'l' + i, result: i % 3 === 0 ? 'win' : 'loss', recommended_units: 0.25 }));
  const g = S.report(rows).groups.all;
  chk('a losing run that lost less than flat still beats the baselines', g.beats_flat_half === true && g.beats_flat_one === true, g);
  chk('but the reading calls it a loss, not a result to act on', /losing direction/.test(g.reading) && /not a result to act on/.test(g.reading), g.reading);
  chk('and it never says the engine cleared them as a good thing', !/evidence the sizing rules add something/.test(g.reading), g.reading);
}

/* ═══ 4. THE ARITHMETIC, ON A HAND-WORKED CARD ═════════════════════════ */
{
  const rows = [
    row({ id: 'a', result: 'win', recommended_units: 1, odds_decimal: 2 }),     /* +1.00 / flat0.5 +0.50 / flat1 +1.00 */
    row({ id: 'b', result: 'loss', recommended_units: 0.5, odds_decimal: 2 }),  /* -0.50 / flat0.5 -0.50 / flat1 -1.00 */
    row({ id: 'c', result: 'push', recommended_units: 0.75, odds_decimal: 2 }), /*  0.00 /          0.00 /        0.00 */
  ];
  const g = S.report(rows).groups.all;
  near('the staked total is the recommended units on graded rows', g.units_staked, 2.25);
  near('profit at the recommended size', g.profit_units, 0.5);
  near('profit at a flat half unit', g.profit_units_flat_half, 0);
  near('profit at a flat one unit', g.profit_units_flat_one, 0);
  near('ROI is on the units actually staked', g.roi_on_staked, 0.5 / 2.25, 1e-4);
  eq('a push is counted and is not a win', [g.wins, g.losses, g.pushes], [1, 1, 1]);
  /* an ungraded row is counted as a position and NOT as a result */
  const withOpen = S.report(rows.concat([row({ id: 'd', result: null, recommended_units: 1 })])).groups.all;
  eq('an open position is a position', withOpen.positions, 4);
  eq('but it is not graded', withOpen.graded, 3);
  near('and it does not move the money', withOpen.profit_units, 0.5);
}

/* ═══ 5. A PASS IS A RESULT, SO IT IS COUNTED LIKE ONE ═════════════════ */
{
  const rows = [
    row({ id: 'p1', status: 'PASS', result: null, grade_state: 'NOT_A_BET', pass_reason: 'STALE_QUOTE: the price was captured 41 minutes ago' }),
    row({ id: 'p2', status: 'PASS', result: null, grade_state: 'NOT_A_BET', pass_reason: 'STALE_QUOTE: the price was captured 55 minutes ago' }),
    row({ id: 'p3', status: 'PASS', result: null, grade_state: 'NOT_A_BET', pass_reason: 'NEGATIVE_EV' }),
    row({ id: 'p4', status: 'PASS', result: null, grade_state: 'NOT_A_BET', pass_reason: null }),
    row({ id: 'b1', result: 'win' }),
  ];
  const r = S.report(rows);
  eq('a pass is not counted as a sized position', r.groups.all.positions, 1);
  eq('the gate is the part before the colon, so one gate is one row', r.passes.STALE_QUOTE.passes, 2);
  eq('a gate with no detail is still a gate', r.passes.NEGATIVE_EV.passes, 1);
  eq('and a pass with no reason recorded is named rather than dropped', r.passes.UNRECORDED.passes, 1);
  chk('each gate says which markets it refused', r.passes.STALE_QUOTE.markets['americanfootball_nfl|spreads'] === 2, r.passes.STALE_QUOTE.markets);
  eq('the grade states are counted across every row, bet or not', r.grade_states.NOT_A_BET, 4);
}

/* ═══ 6. THE READER'S RECORD IS NOT THE ENGINE'S ═══════════════════════ */
{
  /* The vocabulary is the one the table's check constraint permits:
     ACCEPTED, DECLINED, MODIFIED, EXPIRED. A response the database would
     reject must not be a response this file can count. */
  const rows = [
    row({ id: 't1', result: 'win', recommended_units: 1, odds_decimal: 2, reader_response: 'ACCEPTED', reader_accepted_units: 1 }),
    row({ id: 't2', result: 'loss', recommended_units: 1, odds_decimal: 2, reader_response: 'MODIFIED', reader_accepted_units: 0.25 }),
    row({ id: 't3', result: 'win', recommended_units: 1, odds_decimal: 2, reader_response: 'DECLINED' }),
    row({ id: 't4', result: 'win', recommended_units: 1, odds_decimal: 2 }),
  ];
  const a = S.report(rows).acceptance;
  eq('every sized position is a recommendation', a.recommendations, 4);
  eq('three were answered', a.answered, 3);
  eq('one was not', a.unanswered, 1);
  eq('the responses are counted by name', a.responses, { ACCEPTED: 1, MODIFIED: 1, DECLINED: 1 });
  eq('a MODIFIED response is a bet the reader placed, not a decline', a.taken, 2);
  eq('and a DECLINED one is counted as what it is', a.declined, 1);
  eq('the acceptance rate is over recommendations, not over answers', a.acceptance_rate, 0.5);
  eq('only the taken ones enter the reader’s money', a.graded_taken, 2);
  near('the reader staked what the reader said they staked', a.units_staked_by_reader, 1.25);
  near('and the reader’s profit is at the reader’s size', a.profit_units_by_reader, 1 - 0.25);
  near('while the engine’s profit on the same two is at the engine’s size', a.profit_units_if_sized_as_recommended, 0);
  eq('a resize is counted, because following the size is the thing being measured', a.size_followed, 1);
  const expired = S.report([row({ id: 'e1', result: 'win', reader_response: 'EXPIRED' })]).acceptance;
  eq('an EXPIRED recommendation is answered but never taken', [expired.answered, expired.taken, expired.expired], [1, 0, 1]);
  eq('and contributes nothing to the reader’s money', expired.profit_units_by_reader, 0);
  chk('and the note forbids adding the two records together', /never added together/.test(a.note), a.note);
  /* a declined bet that WON must not appear in the reader's profit */
  chk('a declined winner is not in the reader’s money', a.profit_units_by_reader === 0.75, a);
}

/* ═══ 7. THE GROUPS ════════════════════════════════════════════════════ */
{
  const rows = [
    row({ id: 'x1', sport: 'americanfootball_nfl', market: 'spreads', recommendation_tier: 'VALIDATED' }),
    row({ id: 'x2', sport: 'americanfootball_nfl', market: 'totals', recommendation_tier: 'LEAN' }),
    row({ id: 'x3', sport: 'baseball_mlb', market: 'h2h', recommendation_tier: 'LEAN', model_version: 'edgedesk-2' }),
  ];
  const r = S.report(rows);
  eq('every sport and market gets its own row', r.groups['americanfootball_nfl|spreads'].positions, 1);
  eq('and so does every tier', r.groups['tier:LEAN'].positions, 2);
  eq('and every model version, so a regression has a place to show up', r.groups['model:edgedesk-2'].positions, 1);
  eq('with the whole book in one line', r.groups.all.positions, 3);
  chk('a group with no graded row says so rather than printing zeros as a record',
    /nothing has graded yet/.test(S.report([row({ id: 'o', result: null })]).groups.all.reading));
}

/* ═══ 8. THE LOOP PUBLISHES IT ═════════════════════════════════════════ */
{
  const archives = { nfl: { games: [], counts: { games: 0, with_opener: 0 } }, cfb: { games: [], counts: { games: 0, with_open: 0 } } };
  const card = LL.build([], archives, {}, { now: 'T', stake_rows: [row({ id: 'q', result: 'win' })], stake_status: 'FILE', stake_detail: 'x.json' });
  chk('the scorecard carries a staking block', !!card.staking && card.staking.schema === 'edgedesk_stake_scorecard_v1', card.staking && card.staking.schema);
  eq('with the row count and where the rows came from', [card.inputs.stake_rows, card.inputs.stake_rows_status, card.inputs.stake_rows_detail], [1, 'FILE', 'x.json']);
  chk('and the reading beside it', typeof card.staking.groups.all.reading === 'string' && card.staking.groups.all.reading.length > 20);
  /* a database without the migration must not take the whole loop down */
  const bare = LL.build([], archives, {}, { now: 'T', stake_rows: [], stake_status: 'VIEW_NOT_FOUND', stake_detail: 'stake_recommendation_grades does not exist on this database; run supabase/bankroll_and_stakes.sql' });
  eq('a missing view is a missing input, not a failure', bare.inputs.stake_rows_status, 'VIEW_NOT_FOUND');
  chk('and it names the migration that would fix it', /bankroll_and_stakes\.sql/.test(bare.inputs.stake_rows_detail), bare.inputs.stake_rows_detail);
  eq('the rest of the scorecard is still written', bare.schema, 'edgedesk_scorecard_v1');
  eq('the staking block is empty rather than absent', bare.staking.groups, {});
}

done();
