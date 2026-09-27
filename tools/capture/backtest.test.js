#!/usr/bin/env node
/* ===========================================================================
   TESTS FOR THE BACKTEST HARNESS.

   A backtest is a machine for producing a number that nobody can check, so the
   machine itself has to be checked. Three things are asserted here:

     THE LEAKAGE GUARD IS REAL. Not documented — real. A policy that reads an
     outcome field throws, and the fold split never lets a policy see the rows
     it will be judged on.

     THE ARITHMETIC IS RIGHT. Wilson, bootstrap, Brier, log loss, ECE, ROI,
     drawdown and both CLV constructions are checked against values worked out
     by hand, because a metric that is subtly wrong produces a confident,
     plausible, wrong answer forever.

     IT CANNOT BE FOOLED. Given a dataset with a real edge it finds it; given
     coin flips priced at fair value it reports nothing; given the same bet
     entered ten times it counts one.

   Run: node tools/capture/backtest.test.js
   =========================================================================== */
'use strict';
const B = require('./backtest.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function near(a, b, tol) { return a != null && Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function done() {
  failures.forEach(function (f) {
    console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const T0 = Date.parse('2026-01-01T00:00:00Z');
function row(i, over) {
  return Object.assign({
    sig_key: 'e' + i + '|spreads|A|-3.5', event_id: 'e' + i,
    sport_key: 'americanfootball_nfl', sport_title: 'NFL',
    market: 'spreads', selection: 'A', point: -3.5,
    commence_time: new Date(T0 + i * 86400000 + 3600000).toISOString(),
    decision_at: new Date(T0 + i * 86400000).toISOString(),
    hours_to_start: 6, entry_dec: 1.95, entry_book: 'draftkings',
    fair_prob: 0.53, edge: 0.0335, edge_floor: 0.015,
    tier: 'A', reference_type: 'sharp', reference_book: 'pinnacle', quality_score: 72,
    n_books: 7, fresh_books: 6, families: 6, dispersion: 0.004,
    ref_quote_age_s: 120, best_quote_age_s: 90, qual_streak: 1,
    pin_dec: 1.88, pin_opp_dec: 1.94, is_fav: true, devig_method: 'shin',
    flagged_policy: 'qual-2026.09.1', point_is_modal: true, modal_point: -3.5,
    result: 'win', closing_fair: 0.545, closing_dec: 1.88, closing_point: -4,
  }, over || {});
}

/* ═══ 1. THE LEAKAGE GUARD ════════════════════════════════════════════════ */
{
  const d = B.decisionView(row(1));
  chk('a decision view exposes decision fields', d.edge === 0.0335 && d.tier === 'A' && d.entry_dec === 1.95);

  B.OUTCOME_FIELDS.forEach(function (f) {
    let threw = false;
    try { void d[f]; } catch (e) { threw = /LEAKAGE/.test(e.message) && e.message.indexOf(f) >= 0; }
    chk('reading the future throws, and names the field: ' + f, threw);
  });

  chk('`in` also hides the future, so a policy cannot branch on its presence',
    !('result' in d) && !('closing_fair' in d) && ('edge' in d));

  /* The realistic failure this prevents: a policy that quietly reads undefined,
     still runs, still produces numbers, and is wrong in a way nobody notices. */
  let leaked = false;
  const cheating = (dv) => { try { return dv.result === 'win'; } catch (e) { leaked = true; return false; } };
  cheating(d);
  chk('a policy that peeks at the result cannot silently succeed', leaked === true);

  chk('the two field lists do not overlap',
    B.DECISION_FIELDS.every((f) => B.OUTCOME_FIELDS.indexOf(f) < 0));
  chk('every field the shipped policy reads is a decision field',
    ['tier', 'edge', 'fresh_books', 'families', 'qual_streak', 'ref_quote_age_s', 'quality_score', 'sport_key']
      .every((f) => B.DECISION_FIELDS.indexOf(f) >= 0));
}

/* ═══ 2. THE ARITHMETIC ═══════════════════════════════════════════════════ */
{
  /* Wilson, worked by hand: k=5, n=10, z=1.96 -> [0.2366, 0.7634]. */
  const w = B.wilson(5, 10);
  chk('wilson interval is centred and correct at p=0.5', near(w[0], 0.2366, 1e-3) && near(w[1], 0.7634, 1e-3), w);
  chk('wilson is asymmetric near the boundary, as it must be',
    (() => { const x = B.wilson(1, 10); return x[0] > 0 && x[1] < 0.5 && (0.1 - x[0]) < (x[1] - 0.1); })(), B.wilson(1, 10));
  chk('wilson of an empty sample is null, not a number', B.wilson(0, 0) === null);
  chk('a perfect record still has an interval below 1',
    (() => { const x = B.wilson(10, 10); return x[1] === 1 && x[0] > 0.6 && x[0] < 1; })(), B.wilson(10, 10));

  /* The bootstrap must be deterministic: an interval that moves when you re-run
     it is weather, not evidence. */
  const xs = [1, -1, 1, -1, 1, 1, -1, 1, -1, 1];
  chk('the bootstrap is deterministic across runs',
    JSON.stringify(B.bootstrapCI(xs)) === JSON.stringify(B.bootstrapCI(xs)));
  chk('the bootstrap interval brackets the sample mean',
    (() => { const c = B.bootstrapCI(xs); return c[0] <= 0.2 && c[1] >= 0.2; })(), B.bootstrapCI(xs));

  /* Brier: p=0.5 on a coin flip is 0.25 exactly. */
  chk('brier of a coin flip at 0.5 is 0.25', near(B.brier([[0.5, 1], [0.5, 0]]), 0.25));
  chk('brier of a perfect forecast is 0', near(B.brier([[1, 1], [0, 0]]), 0));
  chk('log loss of a perfect forecast is ~0', B.logLoss([[1, 1], [0, 0]]) < 1e-6);
  chk('log loss of a confident miss is finite, not Infinity',
    Number.isFinite(B.logLoss([[1, 0]])) && B.logLoss([[1, 0]]) > 15);

  /* ECE: a perfectly calibrated set has zero expected calibration error. */
  const perfect = [];
  for (let i = 0; i < 100; i++) perfect.push([0.75, i < 75 ? 1 : 0]);
  chk('ECE of a perfectly calibrated forecast is 0', near(B.calibration(perfect).ece, 0, 1e-9));
  const over = [];
  for (let i = 0; i < 100; i++) over.push([0.75, i < 50 ? 1 : 0]);
  chk('ECE catches a 25-point overconfidence', near(B.calibration(over).ece, 0.25, 1e-9));
  chk('the reliability table names the bin and its counts',
    (() => { const c = B.calibration(perfect); const b = c.bins.find((x) => x.n > 0); return b.bin === '0.7-0.8' && b.n === 100; })());

  /* Drawdown: +1, -1, -1, +1 peaks at 1 and troughs at -1, so 2 units. */
  chk('max drawdown measures peak to trough', B.maxDrawdown([1, -1, -1, 1]) === 2);
  chk('a monotonically winning curve has no drawdown', B.maxDrawdown([1, 1, 1]) === 0);

  /* P&L on a 1-unit stake. */
  chk('a win at 1.95 returns 0.95 units', near(B.unitPnl(row(1, { result: 'win' })), 0.95));
  chk('a loss returns -1', B.unitPnl(row(1, { result: 'loss' })) === -1);
  chk('a push returns the stake', B.unitPnl(row(1, { result: 'push' })) === 0);
  chk('an ungraded row is not a zero, it is a null', B.unitPnl(row(1, { result: null })) === null);
}

/* ═══ 3. CLV, BOTH CONSTRUCTIONS ══════════════════════════════════════════ */
{
  /* Price CLV: closing fair 0.545 x a taken price of 1.95 - 1 = +6.275%. */
  chk('price CLV is the closing fair times the price actually taken',
    near(B.priceCLV(row(1)), 0.545 * 1.95 - 1, 1e-12), B.priceCLV(row(1)));
  chk('price CLV is negative when the close says the price was bad',
    B.priceCLV(row(1, { closing_fair: 0.48 })) < 0);
  chk('price CLV is null with no close — never zero, which would count as neutral',
    B.priceCLV(row(1, { closing_fair: null })) === null);
  chk('an impossible closing probability is refused', B.priceCLV(row(1, { closing_fair: 1.4 })) === null);

  /* Line CLV, in points. Taking -3.5 and closing -4 means the number moved our
     way: we got the better side of half a point. */
  chk('a spread that closes further from our number is positive line CLV',
    near(B.lineCLV(row(1, { point: -3.5, closing_point: -4 })), 0.5));
  chk('a spread that closes back through our number is negative',
    near(B.lineCLV(row(1, { point: -3.5, closing_point: -3 })), -0.5));
  /* The brief's two cases, and they must come out with opposite signs.
     "We constantly bet +3 and close +2.5" is EdgeDesk being right: we took the
     extra half point before the market took it away. "We recommend +3 and the
     market closes +4" is EdgeDesk being wrong: the market moved to a better
     number than ours and we are on the worse side of it, whatever a short run
     of results happens to say. */
  chk('bet +3 and the market closes +2.5 — we took the better number: POSITIVE',
    B.lineCLV(row(1, { point: 3, closing_point: 2.5 })) === 0.5);
  chk('recommend +3 and the market closes +4 — the market beat us: NEGATIVE',
    B.lineCLV(row(1, { point: 3, closing_point: 4 })) === -1);
  chk('laying -3.5 into a close of -4 is also positive: we laid the shorter number',
    B.lineCLV(row(1, { point: -3.5, closing_point: -4 })) === 0.5);
  chk('the two directions have opposite signs, which is the whole test',
    B.lineCLV(row(1, { point: 3, closing_point: 2.5 })) > 0
    && B.lineCLV(row(1, { point: 3, closing_point: 4 })) < 0);
  const over = { market: 'totals', selection: 'Over', point: 47.5, closing_point: 48.5 };
  chk('an Over wants the total to close HIGHER', B.lineCLV(row(1, over)) === 1);
  chk('an Under on the same move is the mirror image',
    B.lineCLV(row(1, Object.assign({}, over, { selection: 'Under' }))) === -1);
  chk('a moneyline has no line CLV at all', B.lineCLV(row(1, { market: 'h2h', point: null })) === null);
}

/* ═══ 4. ONE PREDICTION IS ONE OBSERVATION ════════════════════════════════ */
{
  /* The same signal seen on ten capture cycles. */
  const repeats = [];
  for (let i = 0; i < 10; i++) {
    repeats.push(row(1, { decision_at: new Date(T0 + i * 600000).toISOString(), entry_dec: 1.95 + i * 0.01 }));
  }
  const d = B.dedupe(repeats);
  chk('ten sightings of one signal collapse to one observation', d.length === 1, d.length);
  chk('and the one kept is the FIRST, whose entry price was frozen',
    near(d[0].entry_dec, 1.95), d[0].entry_dec);

  /* Both sides of the same market. */
  const bothSides = [
    row(2, { sig_key: 'e2|spreads|A|-3.5', selection: 'A', point: -3.5 }),
    row(2, { sig_key: 'e2|spreads|B|3.5', selection: 'B', point: 3.5,
      decision_at: new Date(T0 + 1000).toISOString() }),
  ];
  chk('the favourite spread and its opponent are ONE observation',
    B.dedupe(bothSides).length === 1, B.dedupe(bothSides).length);

  /* Over and under. */
  const ou = [
    row(3, { sig_key: 'e3|totals|Over|47.5', market: 'totals', selection: 'Over', point: 47.5 }),
    row(3, { sig_key: 'e3|totals|Under|47.5', market: 'totals', selection: 'Under', point: 47.5,
      decision_at: new Date(T0 + 1000).toISOString() }),
  ];
  chk('over and under are ONE observation', B.dedupe(ou).length === 1);

  /* Different markets on one game are correlated but not identical, so they are
     kept by default and collapsed only when asked. */
  const twoMarkets = [
    row(4, { sig_key: 'e4|spreads|A|-3.5', market: 'spreads' }),
    row(4, { sig_key: 'e4|h2h|A|', market: 'h2h', point: null, decision_at: new Date(T0 + 1000).toISOString() }),
  ];
  chk('the spread and the moneyline on one game are kept apart by default',
    B.dedupe(twoMarkets).length === 2);
  chk('and collapsed to one when the stricter per-event view is asked for',
    B.dedupe(twoMarkets, { perEvent: true }).length === 1);

  chk('the deduped output is in chronological order',
    (() => { const x = B.dedupe([row(9), row(1), row(5)]); return x[0].event_id === 'e1' && x[2].event_id === 'e9'; })());
}

/* ═══ 5. THE POLICY READS ONLY WHAT IT MAY ═══════════════════════════════ */
{
  const P = B.SHIPPED_POLICY;
  chk('a strong Tier A signal is admitted', B.policyAdmits(B.decisionView(row(1)), P) === true);
  chk('a Tier A signal below the floor is not',
    B.policyAdmits(B.decisionView(row(1, { edge: 0.010 })), P) === false);
  chk('Tier B is held to a higher floor than Tier A',
    B.policyAdmits(B.decisionView(row(1, { tier: 'B', edge: 0.020, families: 5, fresh_books: 5, qual_streak: 2 })), P) === false
    && B.policyAdmits(B.decisionView(row(1, { tier: 'B', edge: 0.030, families: 5, fresh_books: 5, qual_streak: 2 })), P) === true);
  chk('college football is held above the NFL on the same market',
    B.policyAdmits(B.decisionView(row(1, { sport_key: 'americanfootball_ncaaf', edge: 0.017 })), P) === false
    && B.policyAdmits(B.decisionView(row(1, { edge: 0.017 })), P) === true);
  chk('a Tier B signal seen only once is not admitted',
    B.policyAdmits(B.decisionView(row(1, { tier: 'B', edge: 0.030, families: 5, fresh_books: 5, qual_streak: 1 })), P) === false);
  chk('a stale reference quote is not admitted',
    B.policyAdmits(B.decisionView(row(1, { ref_quote_age_s: 99999 })), P) === false);
  chk('a PASS row is never admitted whatever its edge',
    B.policyAdmits(B.decisionView(row(1, { tier: 'PASS', edge: 0.9 })), P) === false);
  chk('the whole grid runs against a decision view without leaking',
    B.defaultGrid().every((p) => typeof B.policyAdmits(B.decisionView(row(1)), p) === 'boolean'));
}

/* ═══ 6. SCORING OVER A KNOWN POPULATION ═════════════════════════════════ */
{
  /* 60 bets at 1.95, 33 winners. ROI = (33*0.95 - 27)/60 = 0.0725. */
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(row(i, { result: i < 33 ? 'win' : 'loss' }));
  const s = B.score(rows, 'known');
  chk('win rate over settled bets', near(s.win_rate, 33 / 60));
  chk('ROI is computed from the ACTUAL entry price', near(s.roi, (33 * 0.95 - 27) / 60, 1e-12), s.roi);
  chk('break-even is the reciprocal of the average price', near(s.break_even_rate, 1 / 1.95, 1e-12));
  chk('the win rate carries an interval', s.win_rate_ci && s.win_rate_ci[0] < s.win_rate && s.win_rate_ci[1] > s.win_rate);
  chk('60 bets is reported as UNPROVEN however good it looks',
    s.proven === false && /UNPROVEN/.test(s.verdict), s.verdict);
  chk('the minimum is stated, not implied', B.MIN_N_PROVEN === 200);

  /* Pushes are returned, not scored as losses, and are outside the win rate. */
  const withPush = rows.concat([row(99, { result: 'push' })]);
  const sp = B.score(withPush, 'push');
  chk('a push does not enter the win rate denominator', sp.settled === 60 && sp.pushes === 1);
  chk('a push returns the stake rather than losing it', near(sp.units, s.units, 1e-12));

  /* A 200-bet sample with a genuine edge should be called profitable. */
  const big = [];
  for (let i = 0; i < 400; i++) big.push(row(i, { entry_dec: 2.00, result: i % 100 < 58 ? 'win' : 'loss' }));
  const sb = B.score(big, 'big');
  chk('a 400-bet 58% record at even money is called PROFITABLE',
    sb.proven === true && /PROFITABLE/.test(sb.verdict), [sb.roi, sb.roi_ci, sb.verdict]);

  /* Coin flips priced at their true probability must not produce a claim. */
  const flat = [];
  for (let i = 0; i < 400; i++) flat.push(row(i, { entry_dec: 2.00, fair_prob: 0.5, result: i % 2 ? 'win' : 'loss' }));
  const sf = B.score(flat, 'flat');
  chk('a fairly-priced coin flip is INCONCLUSIVE, never profitable',
    /INCONCLUSIVE|LOSING/.test(sf.verdict) && sf.roi_ci[0] < 0, [sf.roi, sf.verdict]);
}

/* ═══ 7. SEGMENTATION ════════════════════════════════════════════════════ */
{
  const segs = B.segmentsOf(row(1));
  chk('the headline football segment is recognised at a standard two-way price',
    segs.indexOf('HEADLINE:football standard spreads+totals') >= 0, segs);
  chk('a longshot moneyline is NOT in the headline segment',
    B.segmentsOf(row(1, { market: 'h2h', entry_dec: 4.5, point: null }))
      .indexOf('HEADLINE:football standard spreads+totals') < 0);
  chk('an NBA spread is not in the football headline segment',
    B.segmentsOf(row(1, { sport_key: 'basketball_nba' }))
      .indexOf('HEADLINE:football standard spreads+totals') < 0);
  chk('price bands, edge bands, tier, reference and time-to-kick are all axes',
    segs.some((s) => s.startsWith('price:')) && segs.some((s) => s.startsWith('edge:'))
    && segs.some((s) => s.startsWith('tier:')) && segs.some((s) => s.startsWith('reference:'))
    && segs.some((s) => s.startsWith('ttk:')) && segs.some((s) => s.startsWith('side:')), segs);
  chk('favourite and underdog are separated', B.segmentsOf(row(1, { is_fav: false })).indexOf('side:underdog') >= 0);
}

/* ═══ 8. WALK-FORWARD ════════════════════════════════════════════════════ */
{
  const rows = [];
  for (let i = 0; i < 500; i++) rows.push(row(i, { result: i % 100 < 56 ? 'win' : 'loss' }));
  const wf = B.walkForward(rows, { folds: 5, minTrain: 50 });
  chk('walk-forward runs and returns per-fold detail', wf.ok === true && wf.per_fold.length === 5);

  chk('validation is always strictly later than training',
    wf.per_fold.every((f, i) => i === 0 || Date.parse(f.valid_from) >= Date.parse(wf.per_fold[i - 1].valid_to)),
    wf.per_fold.map((f) => [f.valid_from, f.valid_to]));
  chk('fold 0 has no training data and therefore no swept arm',
    wf.per_fold[0].train_rows === 0 && wf.per_fold[0].swept === null);
  chk('training set sizes grow monotonically as the walk rolls forward',
    wf.per_fold.every((f, i) => i === 0 || f.train_rows > wf.per_fold[i - 1].train_rows),
    wf.per_fold.map((f) => f.train_rows));
  chk('the shipped policy is evaluated on every fold',
    wf.per_fold.every((f) => f.fixed && f.fixed.n > 0));
  chk('out-of-sample results are segmented', !!wf.fixed_oos.ALL && !!wf.fixed_oos['tier:A']);
  chk('the overfitting gap between the fixed and swept arms is reported',
    wf.overfitting_gap === null || typeof wf.overfitting_gap.gap === 'number');

  /* The whole point: no row may be scored by a policy chosen with that row. */
  const seenInTrain = new Set();
  let violation = null;
  wf.per_fold.forEach((f, i) => {
    const trainEnd = i === 0 ? null : wf.per_fold[i - 1].valid_to;
    if (trainEnd && f.valid_from && Date.parse(f.valid_from) < Date.parse(trainEnd)) violation = [i, f.valid_from, trainEnd];
    seenInTrain.add(i);
  });
  chk('no fold validates on a row that was inside its own training window', violation === null, violation);

  chk('too few rows for the requested folds is refused, not fudged',
    B.walkForward([row(1)], { folds: 5 }).ok === false);
}

/* ═══ 9. THE DE-VIG COMPARISON REFUSES TO ANSWER WITHOUT DATA ════════════ */
{
  const few = [];
  for (let i = 0; i < 20; i++) few.push(row(i, { result: i % 2 ? 'win' : 'loss' }));
  const r = B.devigComparison(few, () => [0.5, 0.5]);
  chk('a de-vig comparison on 20 rows reports that it cannot answer',
    r.ok === false && /cannot separate|below/.test(r.reason), r.reason);
  chk('and it says WHY the data is missing, naming capture v8', /capture v8 never wrote pin_dec/.test(r.reason));

  const none = [];
  for (let i = 0; i < 200; i++) none.push(row(i, { pin_dec: null, pin_opp_dec: null, result: 'win' }));
  chk('rows with no raw two-way reference price are not silently counted',
    B.devigComparison(none, () => [0.5, 0.5]).ok === false);
}

/* ═══ 10. LOADING IS DEFENSIVE ═══════════════════════════════════════════ */
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(os.tmpdir(), 'bt-test-' + process.pid + '.ndjson');
  fs.writeFileSync(f, [
    JSON.stringify(row(1)),
    '',
    'not json at all',
    JSON.stringify({ sig_key: 'x', decision_at: null }),
    JSON.stringify(row(2, { entry_dec: 0.5 })),
    JSON.stringify(row(3)),
  ].join('\n'));
  const { rows, bad } = B.loadNdjson(f);
  chk('a malformed export line never kills the load', rows.length === 2, rows.length);
  chk('and every unusable line is counted with a reason', bad.length === 3, bad);
  chk('a row with no entry price is refused', rows.every((r) => r.entry_dec > 1));
  fs.unlinkSync(f);
}

done();
