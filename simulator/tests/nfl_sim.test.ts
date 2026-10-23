/* The NFL simulation over the committed snapshot: the model at zero offset,
   reproducibility, worker independence, persistent strength, fixed completed
   games, an analytic fixed-probability fixture, clinch/elimination, and
   fail-closed validation.  node simulator/tests/nfl_sim.test.ts */
import { kit } from './_kit.ts';
import { nflFixture, clone } from './_fixture.ts';
import { nflModule } from '../src/sports/nfl/module.ts';
import { engineMarginDist, withMarginTable, MarginCache, MARGIN_LO, loadEngine } from '../src/sports/nfl/model_adapter.ts';
import { runRange, checkAggregateSums, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { validateNflInputs, nflMathStatus } from '../src/sports/nfl/validate.ts';
import { hashCanonical } from '../src/core/canonical.ts';

const T = kit('NFL simulation');
const snap = nflFixture();
const D = snap.data;
const open = D.games.filter((g) => !g.done);

/* ---- 1 the model at zero offset IS the model ---- */
{
  const restore = withMarginTable(D.model.margin_pmf_by_spread);
  let worst = 0;
  for (const g of open) { const d = engineMarginDist(g.model!.fair_margin); worst = Math.max(worst, Math.abs(d.pHome + 0.5 * d.pTie - g.model!.home_win_prob)); }
  T.chk('zero offset: P(home) + P(tie)/2 equals the served predictGame win probability for all ' + open.length + ' remaining games', worst < 1e-12, worst);
  const E = loadEngine().E;
  const d0 = engineMarginDist(open[0].model!.fair_margin), c = E.dist.coverProbSpread('nfl', open[0].model!.fair_margin, 0);
  T.near('the tie mass is the model\'s own (coverProbSpread push at 0)', d0.pTie, c.push, 1e-12);
  /* the 0.001-point grid, over the centres the run actually visits (fair +- 3 sigma) */
  const C = new MarginCache();
  let g1 = 0;
  for (const g of open.slice(0, 40)) for (let k = -30; k <= 30; k++) {
    const x = g.model!.fair_margin + k * 0.3137 + 0.00049;
    const e = engineMarginDist(x), q = C.gridAt(x);
    g1 = Math.max(g1, Math.abs(e.pHome + e.pTie / 2 - (q.pHome + q.pTie / 2)));
  }
  T.chk('grid rounding moves a game\'s win probability by under 1e-4 (100,000-run MCSE is up to 1.6e-3)', g1 < 1e-4, g1);
  restore();
}
/* ---- 2 reproducibility ---- */
{
  const a = runRange(nflModule(D, { seed: 42n }), { start: 0, end: 300 });
  const b = runRange(nflModule(D, { seed: 42n }), { start: 0, end: 300 });
  const c = runRange(nflModule(D, { seed: 43n }), { start: 0, end: 300 });
  T.chk('same seed + same snapshot: identical counts, histograms and diagnostics', hashCanonical([a.counts, a.hist, a.diags]) === hashCanonical([b.counts, b.hist, b.diags]));
  T.chk('a different seed gives different counts', hashCanonical(a.counts) !== hashCanonical(c.counts));
  const s1 = runRange(nflModule(D, { seed: 42n }), { start: 0, end: 150 }), s2 = runRange(nflModule(D, { seed: 42n }), { start: 150, end: 300 });
  T.chk('runs 0-149 + 150-299 add up to runs 0-299 exactly', hashCanonical(s1.counts.map((x, i) => x + s2.counts[i])) === hashCanonical(a.counts));
  const w = await runPlan({ sport: 'nfl', data: D, seed: 42n, runs: 300, workers: 3, traceRuns: [] });
  T.chk('three workers give exactly the single-thread result', hashCanonical([w.agg.counts, w.agg.hist, w.agg.diags]) === hashCanonical([a.counts, a.hist, a.diags]) && w.workers === 3);
}
/* ---- 3 persistent strength; completed games fixed ---- */
{
  const seen: Record<number, Array<{ phase: string; home: number; away: number; offset: number; game: number | string }>> = {};
  const m = nflModule(D, { seed: 7n, observe: (e) => { (seen[e.run] = seen[e.run] || []).push(e); } });
  const agg = runRange(m, { start: 0, end: 40, traceRuns: [0, 1, 2, 3, 4] });
  let consistent = true, onlyOpen = true, counted = true, postOk = true;
  for (const tr of agg.traces) {
    const offs = Object.fromEntries((tr.events.find((e) => e.type === 'offsets') as any).offsets.map(([c, v]: [string, number]) => [c, v]));
    const evs = seen[tr.run];
    for (const e of evs) {
      const want = offs[D.teams[e.home].code] - offs[D.teams[e.away].code];
      if (Math.abs(want - e.offset) > 2e-3) consistent = false;
      if (e.phase === 'regular' && D.games[e.game as number].done) onlyOpen = false;
    }
    if (evs.filter((e) => e.phase === 'regular').length !== open.length) counted = false;
    if (evs.filter((e) => e.phase === 'postseason').length !== 13) postOk = false;
  }
  T.chk('one offset per club persists through every regular-season AND postseason game of a run', consistent);
  T.chk('completed games are never drawn', onlyOpen);
  T.chk('every remaining game is drawn exactly once per run', counted);
  T.chk('13 postseason games per run, all with the run\'s offsets', postOk);
  const rec = agg.traces[0].events.find((e) => e.type === 'records') as any;
  const w2: Record<string, number> = Object.fromEntries(rec.w2);
  const real: Record<string, number> = {}; D.teams.forEach((t) => { real[t.code] = 0; });
  D.games.filter((g) => g.done).forEach((g) => { const d = (g.home_score as number) - (g.away_score as number); real[g.home] += d > 0 ? 2 : d === 0 ? 1 : 0; real[g.away] += d < 0 ? 2 : d === 0 ? 1 : 0; });
  T.chk('a simulated season\'s record never falls below the real completed record', D.teams.every((t) => w2[t.code] >= real[t.code] && w2[t.code] <= real[t.code] + 2 * open.filter((g) => g.home === t.code || g.away === t.code).length));
}
/* ---- 4 sigma = 0 reproduces each game's model probability (statistically) ---- */
{
  const k = open.findIndex((g) => Math.abs(g.model!.fair_margin) > 5);
  let hw = 0, n = 0;
  const m = nflModule(D, { seed: 9n, sigma: 0, observe: (e) => { if (e.phase === 'regular' && e.game === D.games.indexOf(open[k])) { n++; hw += e.margin > 0 ? 1 : e.margin === 0 ? 0.5 : 0; } } });
  runRange(m, { start: 0, end: 20000 });
  const p = open[k].model!.home_win_prob, se = Math.sqrt(p * (1 - p) / n);
  T.chk('sigma 0: a game\'s simulated home win rate matches the model within 4 MCSE (' + (hw / n).toFixed(4) + ' vs ' + p.toFixed(4) + ')', Math.abs(hw / n - p) < 4 * se, { got: hw / n, p, se });
}
/* ---- 5 analytic fixture (SYNTHETIC): every remaining game 60/40 for the home club, no ties, sigma 0 ---- */
{
  const fixed = new Float64Array(181); for (let i = 0; i < 181; i++) fixed[i] = MARGIN_LO + i < -1 ? 0 : MARGIN_LO + i < 1 ? 0.4 : 1;
  const m = nflModule(D, { seed: 11n, sigma: 0, gameDist: () => ({ cdf: fixed }) });
  const N = 20000, agg = runRange(m, { start: 0, end: N });
  const res = summarise(m, agg);
  let worstZ = 0;
  for (const r of res) {
    const t = r.entity_id;
    let base = 0; D.games.filter((g) => g.done).forEach((g) => { const d = (g.home_score as number) - (g.away_score as number); if (g.home === t) base += d > 0 ? 2 : d === 0 ? 1 : 0; if (g.away === t) base += d < 0 ? 2 : d === 0 ? 1 : 0; });
    /* exact Poisson-binomial distribution of remaining wins */
    let dist = [1];
    for (const g of open.filter((g) => g.home === t || g.away === t)) { const p = g.home === t ? 0.6 : 0.4; const nd = new Array(dist.length + 1).fill(0); dist.forEach((q, i) => { nd[i] += q * (1 - p); nd[i + 1] += q * p; }); dist = nd; }
    dist.forEach((q, i) => { const c = r.value_hist[base + 2 * i] || 0, se = Math.sqrt(N * q * (1 - q)); if (se > 0) worstZ = Math.max(worstZ, Math.abs(c - N * q) / se); });
  }
  T.chk('fixed-probability fixture: every club\'s win distribution matches the exact Poisson-binomial (max |z| < 5)', worstZ < 5, worstZ);
  T.eq('fixed-probability fixture: no ties occur when the distribution has none', agg.hist.filter((_, i) => i % 35 % 2 === 1).length >= 0 && res.every((r) => r.value_hist.every((c, b) => {
    let base2 = 0; D.games.filter((g) => g.done && (g.home === r.entity_id || g.away === r.entity_id)).forEach((g) => { if (g.home_score === g.away_score) base2 += 1; });
    return c === 0 || (b - base2) % 2 === 0;
  })), true);
}
/* ---- 6 the aggregate's format sums and bounds ---- */
{
  const m = nflModule(D, { seed: 5n }), agg = runRange(m, { start: 0, end: 2000 });
  T.eq('aggregate sums: one division winner per division, 7 per conference, one champion', checkAggregateSums(m, agg), []);
  const res = summarise(m, agg);
  T.chk('every probability is finite and in [0,1], every interval contains its estimate', res.every((r) => Object.values(r.outcomes).every((o) => o.probability >= 0 && o.probability <= 1 && o.wilson_lo <= o.probability && o.wilson_hi >= o.probability)));
  T.chk('seed distributions reconcile: P(playoffs) = sum of P(seed k)', res.every((r) => Math.abs(r.outcomes.make_playoffs.probability - [1, 2, 3, 4, 5, 6, 7].reduce((a, k) => a + r.outcomes['seed_' + k].probability, 0)) < 1e-12));
  T.chk('round reconciliation: SB <= conference <= conference final <= divisional <= playoffs', res.every((r) => r.outcomes.win_super_bowl.count <= r.outcomes.win_conference.count && r.outcomes.win_conference.count <= r.outcomes.reach_conference_final.count
    && r.outcomes.reach_conference_final.count <= r.outcomes.reach_divisional.count && r.outcomes.reach_divisional.count <= r.outcomes.make_playoffs.count));
  T.chk('seed 1 always reaches the divisional round (bye)', res.every((r) => r.outcomes.seed_1.count <= r.outcomes.reach_divisional.count));
}
/* ---- 7 clinched and eliminated (SYNTHETIC season: everything decided but week 18) ---- */
{
  const d = clone(D);
  /* BUF wins every game it plays; MIA loses every game; every other game is a 20-17 home win; week 18 stays open */
  d.games.forEach((g) => {
    if (g.week === 18) return;
    g.done = true; g.model = null;
    const [hs, as] = g.home === 'BUF' || g.away === 'MIA' ? (g.home === 'BUF' || g.away === 'MIA' ? [27, 10] : [10, 27]) : (g.away === 'BUF' || g.home === 'MIA' ? [10, 27] : [20, 17]);
    g.home_score = hs; g.away_score = as;
  });
  d.games.forEach((g) => { if (!g.done && !g.model) g.model = { fair_margin: 0, fair_total: 44, home_win_prob: 0.5, quality: 'OK', warnings: [], qb_notes: [] }; });
  const st = nflMathStatus(d);
  T.eq('SYNTHETIC: BUF (16-0) has clinched its division', st.BUF.division, 'clinched');
  T.eq('SYNTHETIC: MIA (0-16) is eliminated from the playoffs', st.MIA.playoffs, 'eliminated');
  const m = nflModule(d, { seed: 3n }), agg = runRange(m, { start: 0, end: 3000 }), res = summarise(m, agg);
  const B = res.find((r) => r.entity_id === 'BUF')!, Mi = res.find((r) => r.entity_id === 'MIA')!;
  T.chk('a clinched division simulates at exactly 100% (shown with its Wilson interval, not as certainty)', B.outcomes.win_division.probability === 1 && B.outcomes.win_division.wilson_lo < 1);
  T.chk('an eliminated club simulates at exactly 0% playoffs (Wilson upper bound > 0)', Mi.outcomes.make_playoffs.count === 0 && Mi.outcomes.make_playoffs.wilson_hi > 0);
  const all = nflMathStatus(D);
  T.chk('every math status is respected by a 2000-run simulation of the real snapshot', (() => {
    const m2 = nflModule(D, { seed: 4n }), r2 = summarise(m2, runRange(m2, { start: 0, end: 2000 }));
    return r2.every((r) => { const s = all[r.entity_id]; return (s.division !== 'clinched' || r.outcomes.win_division.probability === 1) && (s.division !== 'eliminated' || r.outcomes.win_division.count === 0)
      && (s.playoffs !== 'clinched' || r.outcomes.make_playoffs.probability === 1) && (s.playoffs !== 'eliminated' || r.outcomes.make_playoffs.count === 0); });
  })());
}
/* ---- 8 missing or wrong inputs stop the run ---- */
{
  const ok = validateNflInputs(snap, { ignoreCodeDrift: true });
  T.chk('the fixture snapshot passes every simulation gate', ok.every((g) => !(g.status === 'FAIL' && g.blocks === 'simulation')), ok.filter((g) => g.status === 'FAIL'));
  const noModel = clone(snap); (noModel.data.games.find((g) => !g.done) as any).model = null;
  T.chk('a remaining game without a model price blocks the simulation', validateNflInputs(noModel, { ignoreCodeDrift: true }).some((g) => g.id === 'model.every_remaining_game' && g.status === 'FAIL' && g.blocks === 'simulation'));
  const short = clone(snap); short.data.games.pop();
  T.chk('a missing game blocks the simulation', validateNflInputs(short, { ignoreCodeDrift: true }).some((g) => g.id === 'schedule.complete' && g.status === 'FAIL'));
  const mism = clone(snap); mism.data.reconciliation.status = 'MISMATCH'; mism.data.reconciliation.mismatches = ['BUF: results 5/1/0 vs standings 4/2/0'];
  T.chk('results that disagree with the standings block the simulation', validateNflInputs(mism, { ignoreCodeDrift: true }).some((g) => g.id === 'results.reconcile' && g.status === 'FAIL' && g.blocks === 'simulation'));
  const un = clone(snap); un.data.reconciliation.status = 'UNAVAILABLE';
  T.chk('an unavailable standings source blocks publication (and passes only a dry run that asks for it)', validateNflInputs(un, { ignoreCodeDrift: true }).some((g) => g.id === 'results.reconcile' && g.status === 'FAIL' && g.blocks === 'publication')
    && validateNflInputs(un, { ignoreCodeDrift: true, allowUnreconciled: true }).some((g) => g.id === 'results.reconcile' && g.status === 'WARN'));
  const pairs = clone(snap); delete (pairs.data.postseason_pairs.default as any).BUF;
  T.chk('a missing postseason pairing blocks the simulation', validateNflInputs(pairs, { ignoreCodeDrift: true }).some((g) => g.id === 'model.postseason_pairs' && g.status === 'FAIL'));
  const drift = clone(D); (drift.config as any).drift = { mode: 'random_walk' };
  T.throws('within-season drift cannot be switched on without validation', () => nflModule(drift, { seed: 1n }), /not validated/);
}
process.exit(T.done());
