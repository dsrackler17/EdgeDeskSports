#!/usr/bin/env node
/* ===========================================================================
   VALIDATION LAB — the statistics, checked against answers known in advance.
   docs/market-intelligence/VALIDATION.md

   Every test below either has a closed-form answer (normal CDF, a textbook
   Benjamini–Hochberg table) or simulates data from a known process and
   checks that the method recovers it (a slope of 0.5, an overconfident
   forecaster, no information at all). Seeded throughout: the same run gives
   the same numbers.

   Run: node tools/market_intel/validation_lab.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'lib', 'edgedesk_validation_lab.js'));
const EV = require(path.join(ROOT, 'lib', 'edgedesk_ev.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function section(t) { console.log('· ' + t); }
function near(a, b, tol) { return typeof a === 'number' && Math.abs(a - b) <= tol; }

/* a seeded normal, for simulated data */
function gauss(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

section('prng and the normal CDF');
{
  const a = L.prng(7), b = L.prng(7), c = L.prng(8);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  chk('the same seed gives the same stream', JSON.stringify(xs) === JSON.stringify(ys), [xs, ys]);
  chk('a different seed gives a different stream', c() !== xs[0]);
  chk('values lie in [0, 1)', xs.every((x) => x >= 0 && x < 1), xs);
  chk('Φ(0) = 0.5', near(L.normalCdf(0), 0.5, 1e-7), L.normalCdf(0));
  chk('Φ(1.96) = 0.9750', near(L.normalCdf(1.96), 0.97500, 2e-5), L.normalCdf(1.96));
  chk('Φ(-1) = 0.1587', near(L.normalCdf(-1), 0.158655, 2e-6), L.normalCdf(-1));
  chk('two-sided p at z = 1.96 is 0.05', near(L.pTwoSided(1.96), 0.05, 1e-4), L.pTwoSided(1.96));
  chk('normalCdf of a non-number is null', L.normalCdf('x') === null);
}

section('cluster bootstrap');
{
  const rows = [];
  for (let w = 1; w <= 8; w++) for (let i = 0; i < 10; i++) rows.push({ week: w, v: 3 });
  const b = L.clusterBootstrap(rows, (s) => s.reduce((a, r) => a + r.v, 0) / s.length, { cluster: 'week' });
  chk('a constant statistic has a zero-width interval', b.est === 3 && b.ci[0] === 3 && b.ci[1] === 3, b);
  chk('it reports clusters, not rows', b.clusters === 8 && b.n === 80, b);
  const few = L.clusterBootstrap(rows.filter((r) => r.week <= 3), (s) => s.length, { cluster: 'week' });
  chk('below four clusters: an estimate, no interval, and why', few.est === 30 && few.ci[0] === null && /fewer than 4 clusters/.test(few.why), few);
  const rnd = L.prng(11), noisy = [];
  for (let w = 1; w <= 12; w++) { const shock = gauss(rnd) * 2; for (let i = 0; i < 15; i++) noisy.push({ week: w, v: shock + gauss(rnd) }); }
  const meanStat = (s) => s.reduce((a, r) => a + r.v, 0) / s.length;
  const bc = L.clusterBootstrap(noisy, meanStat, { cluster: 'week' });
  const bi = L.clusterBootstrap(noisy.map((r, i) => Object.assign({}, r, { id: i })), meanStat, { cluster: 'id' });
  chk('a shared weekly shock widens the cluster interval past the naive iid one',
    (bc.ci[1] - bc.ci[0]) > 1.5 * (bi.ci[1] - bi.ci[0]), { cluster: bc.ci, iid: bi.ci });
  const again = L.clusterBootstrap(noisy, meanStat, { cluster: 'week' });
  chk('the same seed reproduces the interval exactly', again.ci[0] === bc.ci[0] && again.ci[1] === bc.ci[1]);
  chk('every interval carries the leave-one-cluster-out range', bc.leave_one_out && bc.leave_one_out.min <= bc.est && bc.leave_one_out.max >= bc.est, bc.leave_one_out);
  chk('twelve clusters is not flagged as few; eight is', bc.few_clusters === false && b.few_clusters === true, [bc.few_clusters, b.few_clusters]);
  chk('excludesZero reads the interval', L.excludesZero({ ci: [0.1, 0.4] }) && !L.excludesZero({ ci: [-0.1, 0.4] }) && !L.excludesZero({ ci: [null, null] }));
}

section('paired difference');
{
  const rnd = L.prng(5), rows = [];
  for (let w = 1; w <= 10; w++) for (let i = 0; i < 20; i++) { const truth = gauss(rnd) * 14; rows.push({ week: w, actual: truth, model: truth + gauss(rnd) * 16, market: truth + gauss(rnd) * 8 }); }
  const d = L.pairedDifference(rows, (r) => Math.abs(r.actual - r.model), (r) => Math.abs(r.actual - r.market), { cluster: 'week' });
  chk('a noisier model has the larger absolute error (B_LOWER)', d.verdict === 'B_LOWER' && d.diff.est > 0, d);
  chk('the pair count is the rows where both numbers exist', d.n === 200 && d.a_lower + d.b_lower + d.ties === 200, d);
  const half = L.pairedDifference(rows.slice(0, 20), (r) => r.model, (r) => r.market, { cluster: 'week' });
  chk('below the minimum sample the verdict is INSUFFICIENT_EVIDENCE', half.verdict === 'INSUFFICIENT_EVIDENCE', half.verdict);
  const missing = L.pairedDifference([{ week: 1, a: 1, b: null }], (r) => r.a, (r) => r.b);
  chk('a row missing one side is not paired, never zero-filled', missing.n === 0, missing);
}

section('information test: does the disagreement carry information?');
{
  function sim(slope, seed) {
    const rnd = L.prng(seed), rows = [];
    for (let w = 1; w <= 12; w++) for (let i = 0; i < 30; i++) {
      const market = gauss(rnd) * 10, gap = gauss(rnd) * 4;
      rows.push({ week: w, market, model: market + gap, actual: market + slope * gap + gauss(rnd) * 13 });
    }
    return L.informationTest(rows, { cluster: 'week' });
  }
  const half = sim(0.5, 3), none = sim(0, 4), contra = sim(-0.6, 5);
  chk('a model whose disagreement is half right: slope ≈ 0.5, INFORMATIVE', near(half.slope, 0.5, 0.25) && half.verdict === 'INFORMATIVE', [half.slope, half.slope_boot.ci, half.verdict]);
  chk('no information: the interval includes zero (NOT_DEMONSTRATED)', none.verdict === 'NOT_DEMONSTRATED' && none.slope_boot.ci[0] < 0 && none.slope_boot.ci[1] > 0, [none.slope, none.slope_boot.ci]);
  chk('a disagreement pointing the wrong way is CONTRARY', contra.verdict === 'CONTRARY', [contra.slope, contra.slope_boot.ci]);
  chk('the cluster-robust t agrees in sign with the slope', Math.sign(half.t) === Math.sign(half.slope) && half.p_normal < 0.05, [half.t, half.p_normal]);
  /* with one row per cluster CR1 is HC1: check it against the textbook HC1 */
  const rnd = L.prng(9), pts = [];
  for (let i = 0; i < 200; i++) { const m = 0, x = gauss(rnd); pts.push({ id: i, market: m, model: x, actual: 0.3 * x + gauss(rnd) * (1 + Math.abs(x)) }); }
  const t1 = L.informationTest(pts, { cluster: 'id' });
  const xs = pts.map((p) => p.model), ys = pts.map((p) => p.actual), n = xs.length;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / sxx, a = my - b * mx;
  let meat = 0; for (let i = 0; i < n; i++) { const u = ys[i] - a - b * xs[i]; meat += (xs[i] - mx) ** 2 * u * u; }
  const hc1 = Math.sqrt(meat / (sxx * sxx) * n / (n - 2));
  chk('one row per cluster: the cluster-robust SE equals HC1', near(t1.se_cluster, hc1, 1e-3 * hc1), [t1.se_cluster, hc1]);
  const small = L.informationTest(pts.slice(0, 10), { cluster: 'id' });
  chk('ten games are INSUFFICIENT_EVIDENCE, whatever the slope', small.verdict === 'INSUFFICIENT_EVIDENCE', small.verdict);
  const flat = L.informationTest([1, 2, 3, 4].map((i) => ({ model: 5, market: 5, actual: i, cluster: i })));
  chk('no variation in the disagreement: no slope, and why', flat.slope === null && /no variation/.test(flat.why), flat);
}

section('calibration fit');
{
  const rnd = L.prng(21), cal = [], over = [];
  for (let i = 0; i < 3000; i++) {
    const p = 0.05 + 0.9 * rnd();
    cal.push({ p, y: rnd() < p ? 1 : 0, cluster: i % 20 });
    /* a forecaster twice as far from 50% (in log-odds) as the truth */
    const truth = 1 / (1 + Math.exp(-0.5 * Math.log(p / (1 - p))));
    over.push({ p, y: rnd() < truth ? 1 : 0, cluster: i % 20 });
  }
  const c1 = L.calibrationFit(cal), c2 = L.calibrationFit(over);
  chk('a calibrated forecaster: slope ≈ 1, CONSISTENT_WITH_CALIBRATED', near(c1.slope, 1, 0.15) && c1.verdict === 'CONSISTENT_WITH_CALIBRATED', [c1.slope, c1.slope_boot.ci, c1.verdict]);
  chk('an overconfident forecaster: slope ≈ 0.5, OVERCONFIDENT', near(c2.slope, 0.5, 0.12) && c2.verdict === 'OVERCONFIDENT', [c2.slope, c2.verdict]);
  const ev = EV.logisticSlope(over.map((x) => ({ p: x.p, y: x.y })));
  chk('the fit is the same parametrisation as edgedesk_ev logisticSlope (slope, citl)', near(c2.slope, ev.b, 1e-3) && near(c2.citl, ev.citl, 1e-3), [c2.slope, ev.b, c2.citl, ev.citl]);
  const tiny = L.calibrationFit(cal.slice(0, 20));
  chk('below fifty forecasts: INSUFFICIENT_EVIDENCE', tiny.verdict === 'INSUFFICIENT_EVIDENCE' && tiny.slope === null, tiny);
  const rel = L.reliability(cal);
  chk('reliability: ten buckets that hold every forecast', rel.length === 10 && rel.reduce((a, b) => a + b.n, 0) === 3000, rel.map((b) => b.n));
  chk('reliability: each observed rate sits inside its Wilson interval', rel.every((b) => !b.n || (b.observed >= b.ci[0] && b.observed <= b.ci[1])));
  const edge = L.reliability([{ p: 1, y: 1 }, { p: 0, y: 0 }]);
  chk('reliability: p = 0 and p = 1 are bucketed, not dropped', edge.reduce((a, b) => a + b.n, 0) === 2, edge.map((b) => b.n));
}

section('multiple comparisons');
{
  const p = [0.01, 0.04, 0.03, 0.005];
  const bh = L.adjust(p, 'bh'), holm = L.adjust(p, 'holm');
  chk('Benjamini–Hochberg on a textbook family', JSON.stringify(bh.map((x) => +x.toFixed(4))) === JSON.stringify([0.02, 0.04, 0.04, 0.02]), bh);
  chk('Holm on the same family', JSON.stringify(holm.map((x) => +x.toFixed(4))) === JSON.stringify([0.03, 0.06, 0.06, 0.02]), holm);
  const withNull = L.adjust([0.01, null, 0.02], 'bh');
  chk('a null p-value stays null and is not counted in the family', withNull[1] === null && near(withNull[0], 0.02, 1e-12) && near(withNull[2], 0.02, 1e-12), withNull);
  chk('adjusted values never exceed 1', L.adjust([0.9, 0.95, 0.99], 'holm').every((x) => x <= 1));
}

section('point-in-time benchmark');
{
  const Q = [
    { observed_at: '2026-10-17T12:00:00Z', v: 'morning' },
    { observed_at: '2026-10-17T18:00:00Z', v: 'afternoon' },
    { observed_at: '2026-10-17T20:00:00Z', v: 'at_start' },
    { observed_at: '2026-10-17T23:00:00Z', v: 'in_game' }
  ];
  const a = L.marketAt(Q, '2026-10-17T19:00:00Z');
  chk('the latest quote at or before the time', a.quote.v === 'afternoon' && a.age_minutes === 60 && a.ignored_later === 2, a);
  const c = L.marketAt(Q, '2026-10-18T00:00:00Z', { start: '2026-10-17T20:00:00Z' });
  chk('the close: never at or after the start, whatever the time asked', c.quote.v === 'afternoon', c.quote);
  const none = L.marketAt(Q, '2026-10-17T11:00:00Z');
  chk('nothing before the time: null with NONE_BEFORE, never a later quote', none.quote === null && none.why === 'NONE_BEFORE', none);
  const stale = L.marketAt(Q, '2026-10-17T19:00:00Z', { max_age_minutes: 30 });
  chk('older than the freshness limit: null with STALE', stale.quote === null && stale.why === 'STALE', stale);
  chk('no time: null with NO_TIME', L.marketAt(Q, null).why === 'NO_TIME');
}

section('walk-forward folds');
{
  const rows = [];
  for (let wk = 1; wk <= 5; wk++) for (let i = 0; i < 3; i++) {
    const day = new Date(Date.UTC(2026, 8, wk * 7)).toISOString().slice(0, 10);
    rows.push({ week: wk, predicted_at: day + 'T12:00:00Z', final_at: day + 'T23:00:00Z' });
  }
  const fs = L.folds(rows, { group: 'week', time: 'predicted_at', known_at: 'final_at', min_train_groups: 2 });
  chk('one fold per test week after the first two', fs.length === 3 && fs[0].group === 3, fs.map((f) => f.group));
  chk('each fold trains only on earlier weeks', fs.every((f) => f.train.every((x) => x.week < f.group)), fs.map((f) => f.train.map((x) => x.week)));
  chk('the separation check passes on honest folds', L.checkSeparation(fs, { known_at: 'final_at' }).ok);
  /* a game whose result arrives after the next week's predictions are made */
  const late = rows.concat([{ week: 2, predicted_at: '2026-09-14T12:00:00Z', final_at: '2026-09-30T00:00:00Z' }]);
  const f2 = L.folds(late, { group: 'week', time: 'predicted_at', known_at: 'final_at', min_train_groups: 2 });
  chk('a result not yet known is excluded from training, and counted', f2[0].excluded_unknown_outcome === 1 && f2[0].train.length === 6, f2[0].excluded_unknown_outcome);
  const bad = [{ group: 3, test_opens: '2026-09-21T12:00:00Z', test: [], train: [{ final_at: '2026-09-25T00:00:00Z' }] }];
  chk('the separation check catches an outcome from the future', !L.checkSeparation(bad, { known_at: 'final_at' }).ok);
  const emb = L.folds(rows, { group: 'week', time: 'predicted_at', known_at: 'final_at', min_train_groups: 2, embargo_hours: 24 * 8 });
  const undated = L.folds(rows.concat([{ week: 6, predicted_at: null, final_at: null }]), { group: 'week', time: 'predicted_at', known_at: 'final_at', min_train_groups: 2 });
  chk('a test week with no prediction time is skipped, with why, never trained on everything', undated[3].skipped && undated[3].train.length === 0, undated[3]);
  chk('a skipped fold does not fail the separation check', L.checkSeparation(undated, { known_at: 'final_at' }).ok);
  chk('an embargo removes the most recent training week', emb[0].train.every((x) => x.week === 1), emb[0].train.map((x) => x.week));
}

section('pre-registered hypotheses');
{
  const H = { id: 'H1', statement: 's', mechanism: 'm', metric: 'information slope', data: 'd', registered_at: '2026-10-23',
    acceptance: { rule: 'verdict_in', values: ['INFORMATIVE'] }, status: 'PREREGISTERED' };
  chk('a complete hypothesis passes the check', L.checkHypothesis(H).ok);
  chk('a hypothesis with no mechanism is refused', !L.checkHypothesis(Object.assign({}, H, { mechanism: '' })).ok);
  chk('an unknown acceptance rule is refused', !L.checkHypothesis(Object.assign({}, H, { acceptance: { rule: 'looks_good' } })).ok);
  chk('INFORMATIVE meets verdict_in → ACCEPTED', L.judge(H, { verdict: 'INFORMATIVE' }).status === 'ACCEPTED');
  chk('NOT_DEMONSTRATED → REJECTED (kept, with why)', L.judge(H, { verdict: 'NOT_DEMONSTRATED' }).status === 'REJECTED');
  chk('a result below its minimum is INSUFFICIENT_EVIDENCE, never REJECTED', L.judge(H, { verdict: 'INSUFFICIENT_EVIDENCE' }).status === 'INSUFFICIENT_EVIDENCE');
  const H2 = Object.assign({}, H, { acceptance: { rule: 'ci_upper_below', value: 0 } });
  chk('ci_upper_below accepts an interval wholly below the value', L.judge(H2, { verdict: 'X', ci: [-2, -0.5] }).status === 'ACCEPTED');
  chk('ci_upper_below rejects an interval that crosses it', L.judge(H2, { verdict: 'X', ci: [-2, 0.5] }).status === 'REJECTED');
  chk('no interval is INSUFFICIENT_EVIDENCE', L.judge(H2, { verdict: 'X', ci: [null, null] }).status === 'INSUFFICIENT_EVIDENCE');
  const fragile = L.judge(H2, { verdict: 'X', ci: [-2, -0.5], leave_one_out: { min: -3, max: 0.2 } });
  chk('an acceptance that flips with one cluster left out is INSUFFICIENT_EVIDENCE', fragile.status === 'INSUFFICIENT_EVIDENCE' && /left out/.test(fragile.why), fragile);
  chk('an acceptance that holds with every cluster left out stands', L.judge(H2, { verdict: 'X', ci: [-2, -0.5], leave_one_out: { min: -3, max: -0.4 } }).status === 'ACCEPTED');
  chk('INFORMATIVE needs every leave-one-out slope above zero', L.judge(H, { verdict: 'INFORMATIVE', ci: [0.1, 0.9], leave_one_out: { min: -0.05, max: 0.8 } }).status === 'INSUFFICIENT_EVIDENCE');
  const H3 = Object.assign({}, H, { acceptance: { rule: 'ci_upper_below', value: 1 } });
  chk('robustness is judged against the rule\'s own threshold, not zero', L.judge(H3, { verdict: 'X', ci: [0.2, 0.8], leave_one_out: { min: 0.1, max: 0.95 } }).status === 'ACCEPTED');
}

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'validation lab — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
