/* The NHL simulation over the committed 2026-27 snapshot: the served model at
   zero offset, the outcome table's accuracy, reproducibility and worker
   independence, persistent strength, completed games fixed, exact points
   accounting, overtime/shootout-loss treatment, playoff overtime without a
   shootout, championship sums, postseason state preserved (the real 2025-26
   playoffs, cut mid-way), fail-closed validation and the command line.
   node simulator/tests/nhl_sim.test.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kit } from './_kit.ts';
import { nhlFixture, clone } from './_fixture.ts';
import { nhlModule, NHL_OUTCOMES } from '../src/sports/nhl/module.ts';
import { OutcomeTable, exactGame, tieSplit, offsetRates } from '../src/sports/nhl/model_adapter.ts';
import { runRange, checkAggregateSums, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { hashCanonical, canonicalJson } from '../src/core/canonical.ts';
import { validateNhlInputs } from '../src/sports/nhl/validate.ts';
import { codeHashes, writeNhlSnapshot, readNhlSnapshot, type NhlInputData } from '../src/sports/nhl/inputs.ts';
import { loadHockeyGames } from '../src/sports/nhl/history.ts';
import { parseArgs, execute } from '../src/cli/run.ts';
import { sportRegistry } from '../src/sports/registry.ts';

const T = kit('NHL simulation');
const snap = nhlFixture();
const D = snap.data;
const open = D.games.filter((g) => !g.done), done = D.games.filter((g) => g.done);
const O: Record<string, number> = {}; NHL_OUTCOMES.forEach((o, i) => { O[o.key] = i; });

/* ---- 1 the served model: zero offset is exact, the table is accurate, the OT split is the distribution's ---- */
{
  const tab = new OutcomeTable(D.model.dist);
  let worstExact = 0, worstSplit = 0, worstGrid = 0;
  for (const g of open.slice(0, 200)) {
    const e = exactGame(D.model.dist, g.model!.lam_home, g.model!.lam_away);
    const p = tab.probs(g.model!.lam_home, g.model!.lam_away, true), s = tieSplit(D.model.dist, g.model!.lam_home, g.model!.lam_away, false);
    worstExact = Math.max(worstExact, Math.abs(p.home - e.reg.home), Math.abs(p.tie - e.reg.draw));
    worstSplit = Math.max(worstSplit, Math.abs(s.ot_home - e.tie_split.ot_home), Math.abs(s.so_away - e.tie_split.so_away));
    for (const d of [-0.35, -0.12, 0.07, 0.29]) {
      const [lh, la] = offsetRates(g.model!.lam_home, g.model!.lam_away, d, 0);
      const x = exactGame(D.model.dist, lh, la), q = tab.probs(lh, la, false);
      worstGrid = Math.max(worstGrid, Math.abs(q.home - x.reg.home), Math.abs(q.away - x.reg.away), Math.abs(q.tie - x.reg.draw));
    }
  }
  T.chk('zero offset: the regulation home/tie probabilities are EDNHLDist.game exactly', worstExact === 0, worstExact);
  T.chk('the overtime/shootout split equals EDNHLDist.game tie_split (closed form)', worstSplit < 1e-15, worstSplit);
  const po = exactGame(D.model.dist, 3.1, 2.7, true), sp = tieSplit(D.model.dist, 3.1, 2.7, true);
  T.chk('playoff overtime: sudden death in proportion to the rates, no shootout mass (as EDNHLDist.game format PO)', Math.abs(sp.ot_home - po.tie_split.ot_home) < 1e-15 && sp.so_home === 0 && sp.so_away === 0 && po.tie_split.so_home === 0);
  T.chk('interpolated table within 1e-4 of the exact distribution at offsets up to 3 sigma (100,000-run MCSE up to 1.6e-3)', worstGrid < 1e-4, worstGrid);
  T.eq('the snapshot prices the regulation tie with the served distribution (the draw inflation was not adopted)', [D.model.dist.draw_inflation, D.goal_distribution.adopted], [0, false]);
}
/* ---- 2 at sigma 0 the simulated frequencies are the model's ---- */
{
  const tab = new OutcomeTable(D.model.dist);
  let pTie = 0, pOt = 0;
  for (const g of open) { const p = tab.probs(g.model!.lam_home, g.model!.lam_away, true), s = tieSplit(D.model.dist, g.model!.lam_home, g.model!.lam_away, false); pTie += p.tie; pOt += p.tie * (s.ot_home + s.ot_away); }
  const n = 400, agg = runRange(nhlModule(D, { seed: 11n, sigma: 0 }), { start: 0, end: n });
  const G = open.length * n, tieRate = agg.diags['regular:ties_at_60'] / G, se = Math.sqrt((pTie / open.length) * (1 - pTie / open.length) / G);
  T.near('simulated 60-minute tie rate = the model\'s mean P(tie) (within 4 SE)', tieRate, pTie / open.length, 4 * se);
  T.near('simulated overtime-decided share = the model\'s (within 4 SE)', agg.diags['regular:overtime'] / G, pOt / open.length, 4 * Math.sqrt((pOt / open.length) / G));
  T.chk('regular-season games decided in overtime + shootout = 60-minute ties', agg.diags['regular:overtime'] + agg.diags['regular:shootout'] === agg.diags['regular:ties_at_60']);
}
/* ---- 3 reproducibility and worker independence ---- */
{
  const a = runRange(nhlModule(D, { seed: 42n }), { start: 0, end: 300 });
  const b = runRange(nhlModule(D, { seed: 42n }), { start: 0, end: 300 });
  const c = runRange(nhlModule(D, { seed: 43n }), { start: 0, end: 300 });
  T.chk('same seed + same snapshot: identical counts, histograms and diagnostics', hashCanonical([a.counts, a.hist, a.diags]) === hashCanonical([b.counts, b.hist, b.diags]));
  T.chk('a different seed gives different counts', hashCanonical(a.counts) !== hashCanonical(c.counts));
  const s1 = runRange(nhlModule(D, { seed: 42n }), { start: 0, end: 120 }), s2 = runRange(nhlModule(D, { seed: 42n }), { start: 120, end: 300 });
  T.chk('runs 0-119 + 120-299 add up to runs 0-299 exactly', hashCanonical(s1.counts.map((x, i) => x + s2.counts[i])) === hashCanonical(a.counts));
  const w = await runPlan({ sport: 'nhl', data: D, seed: 42n, runs: 300, workers: 3, traceRuns: [] });
  T.chk('three workers give exactly the single-thread result', hashCanonical([w.agg.counts, w.agg.hist, w.agg.diags]) === hashCanonical([a.counts, a.hist, a.diags]) && w.workers === 3);
}
/* ---- 4 persistent offsets; completed games fixed; exact points accounting ---- */
{
  const seen: Record<number, Array<{ phase: string; home: number; away: number; offset: number; result: string; game: number | string }>> = {};
  const m = nhlModule(D, { seed: 7n, observe: (e) => { (seen[e.run] = seen[e.run] || []).push(e); } });
  const agg = runRange(m, { start: 0, end: 30, traceRuns: [0, 1, 2, 3, 4] });
  const ix: Record<string, number> = {}; D.teams.forEach((t, i) => { ix[t.code] = i; });
  const basePts = new Array(32).fill(0), baseRw = new Array(32).fill(0), baseRow = new Array(32).fill(0);
  let basePast60 = 0;
  for (const g of done) {
    const hw = (g.home_score as number) > (g.away_score as number), w = ix[hw ? g.home : g.away], l = ix[hw ? g.away : g.home];
    basePts[w] += 2; if (g.decided !== 'REG') { basePts[l] += 1; basePast60++; } else baseRw[w]++;
    if (g.decided !== 'SO') baseRow[w]++;
  }
  let consistent = true, onlyOpen = true, ptsExact = true, rwExact = true, sumOk = true;
  for (const tr of agg.traces) {
    const offs = Object.fromEntries((tr.events.find((e) => e.type === 'offsets') as any).offsets.map(([c, v]: [string, number]) => [ix[c], v]));
    const evs = seen[tr.run];
    for (const e of evs) if (Math.abs(e.offset - (offs[e.home] - offs[e.away])) > 2e-4) consistent = false;
    const reg = evs.filter((e) => e.phase === 'regular');
    if (reg.length !== open.length) onlyOpen = false;
    const pts = basePts.slice(), rw = baseRw.slice(), row = baseRow.slice();
    let past60 = basePast60;
    for (const e of reg) {
      const homeWon = e.result.startsWith('HOME'), kind = e.result.slice(5), w = homeWon ? e.home : e.away, l = homeWon ? e.away : e.home;
      pts[w] += 2; if (kind !== 'REG') { pts[l] += 1; past60++; } else rw[w]++;
      if (kind !== 'SO') row[w]++;
    }
    const stand = (tr.events.find((e) => e.type === 'standings') as any).clubs as Array<[string, number, number, number, number, number, number]>;
    for (const [c, p, w, l, otl, r, ro] of stand) {
      if (p !== pts[ix[c]] || p !== 2 * w + otl) ptsExact = false;
      if (r !== rw[ix[c]] || ro !== row[ix[c]]) rwExact = false;
      if (w + l + otl !== 84) ptsExact = false;
    }
    if (stand.reduce((a, x) => a + x[1], 0) !== 2 * D.games.length + past60) sumOk = false;
  }
  T.chk('one offset per club per run, the same in every regular-season AND playoff game of the run', consistent);
  T.chk('only the ' + open.length + ' remaining games are drawn; the ' + done.length + ' completed games are fixed as played', onlyOpen);
  T.chk('points = completed points + 2 per simulated win + 1 per simulated OT/shootout loss, and = 2W + OTL over 84 games', ptsExact);
  T.chk('regulation wins and ROW count only regulation (and overtime) wins, completed and simulated', rwExact);
  T.chk('league points = 2 x 1,344 games + every game decided past 60 minutes (each traced run)', sumOk);
  /* the same identity over every run, from the points histogram */
  const big = runRange(nhlModule(D, { seed: 9n }), { start: 0, end: 200 });
  let tot = 0; for (let e = 0; e < 32; e++) for (let b = 0; b < 169; b++) tot += b * big.hist[e * 169 + b];
  T.eq('over 200 runs: sum of every club\'s points = 200 x (2 x 1,344 + completed games past 60) + simulated ties', tot, 200 * (2 * D.games.length + basePast60) + big.diags['regular:ties_at_60']);
}
/* ---- 5 overtime and shootout losses: forced through the model override ---- */
{
  const so = { reg: { home: 0, away: 0, tie: 1 }, split: { ot_home: 0, ot_away: 0, so_home: 1, so_away: 0 } };
  const m = nhlModule(D, { seed: 3n, override: (g) => (g === 'playoff' ? null : so) });
  const agg = runRange(m, { start: 0, end: 2, traceRuns: [0] });
  const ix: Record<string, number> = {}; D.teams.forEach((t, i) => { ix[t.code] = i; });
  const stand = (agg.traces[0].events.find((e) => e.type === 'standings') as any).clubs as Array<[string, number, number, number, number, number, number]>;
  const homeLeft = new Array(32).fill(0), awayLeft = new Array(32).fill(0), w0 = new Array(32).fill(0), otl0 = new Array(32).fill(0), rw0 = new Array(32).fill(0), row0 = new Array(32).fill(0);
  for (const g of open) { homeLeft[ix[g.home]]++; awayLeft[ix[g.away]]++; }
  for (const g of done) { const hw = (g.home_score as number) > (g.away_score as number); const w = ix[hw ? g.home : g.away], l = ix[hw ? g.away : g.home]; w0[w]++; if (g.decided !== 'REG') otl0[l]++; else rw0[w]++; if (g.decided !== 'SO') row0[w]++; }
  T.chk('every remaining game a home shootout win: +1 win (no RW, no ROW) per home game, +1 shootout loss (1 point) per road game',
    stand.every(([c, p, w, l, otl, r, ro]) => w === w0[ix[c]] + homeLeft[ix[c]] && otl === otl0[ix[c]] + awayLeft[ix[c]] && r === rw0[ix[c]] && ro === row0[ix[c]] && p === 2 * w + otl));
  T.eq('every remaining game went to a shootout', [agg.diags['regular:shootout'], agg.diags['regular:overtime']], [2 * open.length, 0]);
}
/* ---- 6 playoff overtime: sudden death, never a shootout ---- */
{
  const results: string[] = [];
  const allTie = { reg: { home: 0, away: 0, tie: 1 }, split: { ot_home: 0.5, ot_away: 0.5, so_home: 0, so_away: 0 } };
  const shootoutBait = { reg: { home: 0, away: 0, tie: 1 }, split: { ot_home: 0, ot_away: 1, so_home: 1, so_away: 0 } };
  const a = runRange(nhlModule(D, { seed: 5n, override: (g) => (g === 'playoff' ? allTie : null), observe: (e) => { if (e.phase === 'postseason') results.push(e.result); } }), { start: 0, end: 20 });
  T.chk('a playoff game tied after 60 minutes is decided in overtime (every result HOME_OT / AWAY_OT)', results.length > 0 && results.every((r) => r.endsWith('_OT')) && a.diags['postseason:overtime'] === a.diags['postseason:games']);
  const res2: string[] = [];
  runRange(nhlModule(D, { seed: 5n, override: (g) => (g === 'playoff' ? shootoutBait : null), observe: (e) => { if (e.phase === 'postseason') res2.push(e.result); } }), { start: 0, end: 5 });
  T.chk('shootout probabilities are never used in a playoff game: with all overtime mass on the road club, every playoff game is a road OT win', res2.length > 0 && res2.every((r) => r === 'AWAY_OT'));
}
/* ---- 7 championship sums and nesting ---- */
{
  const n = 2000, m = nhlModule(D, { seed: 2027n });
  const agg = runRange(m, { start: 0, end: n });
  T.eq('every per-run and aggregate sum rule holds', checkAggregateSums(m, agg), []);
  const sum = (k: string) => m.entities.reduce((a, _, e) => a + agg.counts[e * NHL_OUTCOMES.length + O[k]], 0);
  T.eq('league sums per run x N: Cup 1, Final 2, conference finals 4, round 2 8, playoffs 16, Presidents\' Trophy 1, best conference record 2, division winners 4',
    ['win_stanley_cup', 'win_conference', 'reach_conference_final', 'reach_round_2', 'make_playoffs', 'presidents_trophy', 'conference_best_record', 'win_division', 'bracket_d2', 'bracket_d3', 'bracket_wc1', 'bracket_wc2'].map((k) => sum(k) / n),
    [1, 2, 4, 8, 16, 1, 2, 4, 4, 4, 2, 2]);
  const r = summarise(m, agg);
  const P = (e: any, k: string) => e.outcomes[k].count;
  T.chk('nesting per club: Cup <= Final <= conference final <= round 2 <= playoffs', r.every((e) => P(e, 'win_stanley_cup') <= P(e, 'win_conference') && P(e, 'win_conference') <= P(e, 'reach_conference_final') && P(e, 'reach_conference_final') <= P(e, 'reach_round_2') && P(e, 'reach_round_2') <= P(e, 'make_playoffs')));
  T.chk('playoffs = division top three + wild cards, per club', r.every((e) => P(e, 'make_playoffs') === P(e, 'win_division') + P(e, 'bracket_d2') + P(e, 'bracket_d3') + P(e, 'bracket_wc1') + P(e, 'bracket_wc2')));
  T.chk('regular-season honours nest: Presidents\' Trophy <= best conference record <= division winner', r.every((e) => P(e, 'presidents_trophy') <= P(e, 'conference_best_record') && P(e, 'conference_best_record') <= P(e, 'win_division')));
  const pres = r.map((e) => P(e, 'presidents_trophy')), cup = r.map((e) => P(e, 'win_stanley_cup'));
  T.chk('the Presidents\' Trophy and the Cup are separate outcomes (they differ for some club)', pres.some((x, i) => x !== cup[i]));
}
/* ---- 8 the postseason state preserved: the real 2025-26 playoffs, cut mid-way ---- */
{
  const hist = loadHockeyGames([2026]);
  const reg = hist.filter((g) => g.type === 'R'), po = hist.filter((g) => g.type === 'P');
  const build = (cut: string): NhlInputData => {
    const d = clone(D);
    d.games = reg.map((g) => ({ game_id: g.game_id, date: g.date, start_utc: g.start_utc, home: g.home, away: g.away, venue: null, state: 'OFF', done: true,
      home_score: g.final_home, away_score: g.final_away, reg_home: g.reg_home, reg_away: g.reg_away, decided: g.decided as any, result_source: 'team_games' as const, model: null }));
    d.playoffs = po.filter((g) => g.date < cut).map((g) => ({ game_id: g.game_id, date: g.date, home: g.home, away: g.away, done: true, home_score: g.final_home, away_score: g.final_away, decided: g.decided as any, series_letter: null, round: null, game: null }));
    return d;
  };
  const series = new Map<string, { teams: string[]; first: string; last: string; winner: string }>();
  for (const g of po) {
    const k = [g.home, g.away].sort().join('-');
    if (!series.has(k)) series.set(k, { teams: [g.home, g.away].sort(), first: g.date, last: g.date, winner: '' });
    const s = series.get(k)!; s.last = g.date;
  }
  for (const [k, s] of series) { const w: Record<string, number> = {}; for (const g of po) if ([g.home, g.away].sort().join('-') === k) { const x = g.hw ? g.home : g.away; w[x] = (w[x] || 0) + 1; } s.winner = Object.keys(w).find((t) => w[t] === 4)!; }
  const all = [...series.values()].sort((a, b) => a.first.localeCompare(b.first));
  const r1 = all.slice(0, 8), r2 = all.slice(8, 12), final = all[14];
  /* the day the last round-1 series ended (a seven-game series can end after another half's round 2 began) */
  const r1End = r1.reduce((a, s) => (s.last > a ? s.last : a), r1[0].last) + '~';
  void r2;
  const n = 300;
  const run = (cut: string) => { const d = build(cut); const m = nhlModule(d, { seed: 99n }); return { m, r: summarise(m, runRange(m, { start: 0, end: n })), d }; };
  const a = run(r1End);
  const pr = (x: typeof a, code: string, k: string) => x.r.find((e) => e.entity_id === code)!.outcomes[k].probability;
  T.chk('cut when round 1 ended (round-2 games already played kept too): every round-1 winner reaches round 2 in every run, every loser in none',
    r1.every((s) => pr(a, s.winner, 'reach_round_2') === 1 && pr(a, s.teams.find((t) => t !== s.winner)!, 'reach_round_2') === 0));
  T.eq('... and the regular season is complete and fixed: 2025-26 division winners with probability 1', a.r.filter((e) => e.outcomes.win_division.probability === 1).length, 4);
  /* mid-Final: the Final's first games kept, the series continues from its real state */
  const finalGames = po.filter((g) => [g.home, g.away].sort().join('-') === final.teams.join('-'));
  const cut = finalGames[Math.min(3, finalGames.length - 1)].date;
  const b = run(cut);
  T.chk('cut inside the Final: both real finalists win their conference in every run', final.teams.every((t) => pr(b, t, 'win_conference') === 1));
  const kept = finalGames.filter((g) => g.date < cut), lead: Record<string, number> = {};
  kept.forEach((g) => { const w = g.hw ? g.home : g.away; lead[w] = (lead[w] || 0) + 1; });
  const cupSum = final.teams.reduce((acc, t) => acc + pr(b, t, 'win_stanley_cup'), 0);
  T.chk('... the Cup goes to one of the two finalists (' + JSON.stringify(lead) + ' after ' + kept.length + ' games), probability summing to 1', Math.abs(cupSum - 1) < 1e-12);
  const c = run('2099-01-01');
  T.eq('every playoff game observed: the real champion (' + final.winner + ') wins the Cup in every run', pr(c, final.winner, 'win_stanley_cup'), 1);
}
/* ---- 9 validation fails closed ---- */
{
  T.chk('the committed fixture passes every input gate (code identity aside)', validateNhlInputs(snap, { ignoreCodeDrift: true }).every((g) => g.status === 'PASS'));
  const bad = clone(snap); const g0 = bad.data.games.find((g) => g.done && g.decided === 'REG')!; g0.decided = 'SO';
  T.chk('a regulation result relabelled as a shootout (60-minute score not tied) blocks the simulation', validateNhlInputs(bad, { ignoreCodeDrift: true }).some((g) => g.id === 'results.classified' && g.status === 'FAIL' && g.blocks === 'simulation'));
  const lag = clone(snap); lag.data.reconciliation.lagging.push({ game_id: 1, status: 'UNRESOLVED', detail: 'test' });
  T.chk('a final the snapshot could not read blocks the simulation (a played game is never simulated)', validateNhlInputs(lag, { ignoreCodeDrift: true }).some((g) => g.id === 'results.lagging' && g.status === 'FAIL' && g.blocks === 'simulation'));
  const short = clone(snap); short.data.games = short.data.games.slice(1);
  T.chk('an incomplete schedule blocks the simulation', validateNhlInputs(short, { ignoreCodeDrift: true }).some((g) => g.id === 'schedule.complete' && g.status === 'FAIL'));
  const align = clone(snap); const t0 = align.data.games[0]; const tmp = t0.home; t0.home = t0.away === 'VAN' ? 'CHI' : 'VAN'; void tmp;
  T.chk('a schedule that disagrees with the alignment blocks the simulation', validateNhlInputs(align, { ignoreCodeDrift: true }).some((g) => (g.id === 'schedule.alignment' || g.id === 'schedule.complete') && g.status === 'FAIL'));
  const inPlay = clone(snap); inPlay.data.games.find((g) => !g.done)!.state = 'LIVE';
  T.chk('a game in progress at build time blocks publication (a WARN that blocks it)', validateNhlInputs(inPlay, { ignoreCodeDrift: true }).some((g) => g.id === 'schedule.no_live_games' && g.status === 'WARN' && g.blocks === 'publication'));
  const drift = clone(snap); drift.data.code_sha256['hockey/model/distribution.js'] = '0'.repeat(64);
  T.chk('a snapshot whose model code differs from this checkout is refused for replay', validateNhlInputs(drift).some((g) => g.id === 'replay.code_identity' && g.status === 'FAIL'));
  const po = clone(snap); po.data.playoffs.push({ game_id: 1, date: '2027-04-20', home: 'CAR', away: 'NYR', done: true, home_score: 3, away_score: 3, decided: 'SO', series_letter: null, round: 1, game: 1 });
  T.chk('a playoff game decided by shootout is refused', validateNhlInputs(po, { ignoreCodeDrift: true }).some((g) => g.id === 'postseason.state' && g.status === 'FAIL'));
  T.throws('a negative sigma is refused', () => nhlModule(D, { seed: 1n, sigma: -0.1 }), /sigma/);
  const nm = clone(D); nm.games.find((g) => !g.done)!.model = null;
  T.throws('a remaining game without a price is refused', () => nhlModule(nm, { seed: 1n }), /no price/);
}
/* ---- 10 the command line: NHL replay, worker independence, never publishable while BLOCKED ---- */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-sim-nhl-'));
  try {
    T.eq('--sport nhl defaults to the configured season (2027 = 2026-27)', parseArgs(['--sport', 'nhl']).season, 2027);
    const s = clone(snap); s.data.code_sha256 = codeHashes(); s.input_hash = hashCanonical(s.data);   /* TEST ONLY: re-stamped to this checkout (section 9 covers the gate) */
    const file = path.join(tmp, 'snapshot.json');
    writeNhlSnapshot(file, s);
    T.eq('writeNhlSnapshot / readNhlSnapshot round-trip the content hash', readNhlSnapshot(file).input_hash, s.input_hash);
    const quiet = () => {};
    await execute(parseArgs(['--sport', 'nhl', '--season', '2026', '--snapshot', file, '--runs', '10'])).then(() => T.chk('a season other than 2027 is refused', false), (e) => T.chk('a season other than 2027 is refused', /no NHL season config/.test(String(e.message))));
    const base = ['--sport', 'nhl', '--snapshot', file, '--runs', '1500', '--dry-run'];
    const a = await execute(parseArgs([...base, '--workers', '1', '--out', path.join(tmp, 'a')]), quiet);
    const b = await execute(parseArgs([...base, '--workers', '3', '--out', path.join(tmp, 'b')]), quiet);
    T.chk('1 worker and 3 workers give identical results', canonicalJson(a.results.entities) === canonicalJson(b.results.entities));
    T.chk('results carry mean regular-season points and their histogram (not wins)', (a.results.entities as any[]).every((e) => Number.isFinite(e.mean_points) && Array.isArray(e.points_hist) && e.mean_wins === undefined));
    const gate = (id: string) => a.gates.find((g) => g.id === id)!;
    T.chk('a BLOCKED sport can never be published (sport.active blocks publication)', gate('sport.active').status === 'FAIL' && gate('sport.active').blocks === 'publication' && !a.publishable);
    T.chk('no unsupported tiebreak and no clamped rate in the replay', gate('run.unsupported_tiebreaks').status === 'PASS' && gate('run.lambda_range').status === 'PASS');
    T.eq('a dry run writes the snapshot, results, gates and manifest locally', fs.readdirSync(path.join(tmp, 'a')).sort(), ['gates.json', 'manifest.json', 'results.json', 'snapshot.json']);
    const reg = sportRegistry().find((x) => x.key === 'nhl')!;
    T.chk('the registry says BLOCKED, naming the unverified 2026-27 facts and the missing reader view', reg.status === 'BLOCKED' && reg.blockers.some((x) => /tie-breaking/.test(x)) && reg.blockers.some((x) => /home-ice/.test(x)) && reg.blockers.some((x) => /reader/.test(x)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
process.exit(T.done());
