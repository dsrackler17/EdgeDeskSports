/* ===========================================================================
   NCAAM tournament simulation: the bracket, the engine contract, the
   correlated strength, analytic agreement, reproducibility.

     node simulator/tests/ncaam_sim.test.ts

   SYNTHETIC fixtures are labelled in their assertion names; the last block
   reads the committed 2026 data and reconstructs the real bracket.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { validateBracket, playOrder, type Bracket } from '../src/sports/ncaam/bracket.ts';
import { ncaamModule, ncaamSumRules, type NcaamInputData } from '../src/sports/ncaam/module.ts';
import { runRange, checkAggregateSums, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { REPO } from '../src/sports/ncaam/inputs.ts';
import { validateNcaamInputs } from '../src/sports/ncaam/run.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns, inputsReady } from '../src/cli/plan.ts';

const req = createRequire(import.meta.url);
const DIST = req(path.join(REPO, 'basketball', 'ncaam_forecast', 'dist.js'));
const T = kit('ncaam simulation');
const CAL = { kappa: 2.1, ot: { sd: 4.8 } };

/** a SYNTHETIC field of 2^k teams in one region, with given neutral means mu_i - mu_j */
function synthetic(strength: number[], o: { V?: number; fixed?: Record<string, string>; sd?: number } = {}): NcaamInputData {
  const n = strength.length; const ids = strength.map((_, i) => 't' + String(i).padStart(2, '0'));
  const slots: any[] = []; let layer = ids.map((id) => ({ team: id })) as any[]; let r = 0; const rounds = ['R1', 'R2', 'R3', 'R4', 'R5'].slice(0, Math.log2(n));
  while (layer.length > 1) {
    const next: any[] = [];
    for (let i = 0; i < layer.length; i += 2) { const id = rounds[r] + '-' + (i / 2); slots.push({ id, round: rounds[r], region: null, a: layer[i], b: layer[i + 1], winner: o.fixed && o.fixed[id] }); next.push({ winnerOf: id }); }
    layer = next; r++;
  }
  for (const s of slots) if (s.winner == null) delete s.winner;
  const entrants: Record<string, { region: string | null; seed: number | null }> = {}; ids.forEach((id) => { entrants[id] = { region: 'R', seed: null }; });
  const mu = new Array(n * n).fill(0), sd = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { mu[i * n + j] = strength[i] - strength[j]; sd[i * n + j] = o.sd || 11; }
  return { schema: 'edgedesk_ncaam_sim_inputs_v1', season: 2099, competition: 'SYNTHETIC', rules_version: 'test', bracket: { competition: 'SYNTHETIC', season: '2099', rounds, slots, entrants, source: 'SYNTHETIC', provenance: 'Estimated' },
    teams: ids.map((id) => ({ id, name: id, region: 'R', seed: null, rating_games: 30 })), pairs: { mu, sd }, strength: { variance: ids.map(() => o.V || 0), method: 'test', source: 'test', ci95: null },
    calibration: CAL, model: { model_id: 'test', version: '0', artifact_sha256: '0'.repeat(64), as_of: '2099-03-15T00:00:00Z', config_sha256: '0'.repeat(64) },
    config: { drift: { mode: 'off' }, availability: { mode: 'off', reason: 'test' }, venue: 'neutral' } };
}

/* ---- the bracket ---- */
{
  const d = synthetic([10, 5, 0, -5]);
  T.eq('SYNTHETIC: a valid 4-team bracket validates', validateBracket(d.bracket), []);
  const twice = JSON.parse(JSON.stringify(d.bracket)); twice.slots[1].a = { team: 't00' };
  T.chk('a team entering twice is refused', validateBracket(twice).some((e) => /enters twice/.test(e)));
  const orphan = JSON.parse(JSON.stringify(d.bracket)); orphan.slots[2].b = { winnerOf: 'nope' };
  T.chk('a slot fed by an unknown slot is refused', validateBracket(orphan).some((e) => /unknown slot/.test(e)));
  const back = JSON.parse(JSON.stringify(d.bracket)); back.slots[0].round = 'R2';
  T.chk('a slot fed by a later or same round is refused', validateBracket(back).some((e) => /not an earlier round/.test(e)));
  const wrong = JSON.parse(JSON.stringify(d.bracket)); wrong.slots[0].winner = 't03';
  T.chk('a fixed winner that is not in the game is refused', validateBracket(wrong).some((e) => /cannot reach/.test(e)));
  const down = JSON.parse(JSON.stringify(d.bracket)); down.slots[2].winner = 't00';
  T.chk('a completed game downstream of an unplayed one is refused', validateBracket(down).some((e) => /is not/.test(e)));
  T.eq('play order puts every slot after its feeders', playOrder(d.bracket).map((s) => s.id), ['R1-0', 'R1-1', 'R2-0']);
  T.eq('the sum rules follow the bracket', ncaamSumRules(d.bracket).map((r) => r.outcome + ':' + r.perGroup), ['reach_r1:4', 'reach_r2:2', 'win_title:1']);
}

/* ---- analytic agreement and normalisation (SYNTHETIC, V = 0) ---- */
{
  const d = synthetic([8, 3, 0, -6]);
  const N = 120000; const m = ncaamModule(d, { seed: 1n });
  const agg = runRange(m, { start: 0, end: N });
  T.eq('every per-run and aggregate sum rule holds', checkAggregateSums(m, agg), []);
  const res = summarise(m, agg);
  const p = (i: number, j: number) => DIST.winProbAt(d.pairs.mu[i * 4 + j], 11, CAL);
  /* exact title probabilities by enumeration of the 4-team bracket */
  const exact = [0, 1, 2, 3].map((t) => {
    const semi = t < 2 ? (t === 0 ? p(0, 1) : p(1, 0)) : (t === 2 ? p(2, 3) : p(3, 2));
    const opp = t < 2 ? [2, 3] : [0, 1];
    const reachOpp = (o: number) => (o === opp[0] ? p(opp[0], opp[1]) : p(opp[1], opp[0]));
    return semi * opp.reduce((a, o) => a + reachOpp(o) * p(t, o), 0);
  });
  let worst = 0;
  res.forEach((e, i) => { const sim = e.outcomes.win_title.probability; worst = Math.max(worst, Math.abs(sim - exact[i]) / e.outcomes.win_title.mcse); });
  T.chk('SYNTHETIC: simulated title probabilities match exact enumeration (all within 4 MCSE)', worst < 4, { worst });
  T.near('title probabilities sum to 1 exactly', res.reduce((a, e) => a + e.outcomes.win_title.probability, 0), 1, 1e-12);
  T.chk('every probability is finite and in [0, 1]', res.every((e) => Object.values(e.outcomes).every((o) => Number.isFinite(o.probability) && o.probability >= 0 && o.probability <= 1)));
}

/* ---- persistent latent strength: one draw per team per run, no double counting ---- */
{
  const d = synthetic([0, 0], { V: 9, sd: 11 });
  const offsets: number[] = []; const ps: number[] = [];
  const m = ncaamModule(d, { seed: 5n, observe: (ev) => { offsets.push(ev.offset); ps.push(ev.p); } });
  const N = 150000; const agg = runRange(m, { start: 0, end: N });
  const pSim = summarise(m, agg)[0].outcomes.win_title.probability;
  T.near('SYNTHETIC: with V the single-game marginal equals the calibrated distribution (no double counting)', pSim, DIST.winProbAt(0, 11, CAL), 4 * Math.sqrt(0.25 / N));
  T.chk('each game uses sd_game = sqrt(sd^2 - V_a - V_b)', Math.abs(ps[0] - DIST.winProbAt(offsets[0], Math.sqrt(121 - 18), CAL)) < 1e-12);
  const vOff = offsets.reduce((a, x) => a + x * x, 0) / offsets.length;
  T.near('the drawn offset difference has variance V_a + V_b', vOff, 18, 0.6);
  /* persistence: a team's offset is identical in every game of a run */
  const d8 = synthetic([4, 2, 1, 0, 0, -1, -2, -4], { V: 9 });
  const seen = new Map<number, Map<string, number>>(); let consistent = true;
  const m8 = ncaamModule(d8, { seed: 9n, observe: (ev) => {
    if (!seen.has(ev.run)) seen.set(ev.run, new Map());
    const k = ev.a + '-' + ev.b; const prev = seen.get(ev.run)!; void k; prev.set(ev.slot, ev.offset);
  } });
  const tr = runRange(m8, { start: 0, end: 200, traceRuns: [0, 1, 2] });
  for (const t of tr.traces) {
    const off = new Map((t.events.find((e: any) => e.type === 'offsets') as any).offsets as Array<[string, number]>);
    const games = (t.events.find((e: any) => e.type === 'games') as any).games as Array<[string, string, string, string, number]>;
    for (const g of games) { const i = d8.teams.findIndex((x) => x.id === g[1]), j = d8.teams.findIndex((x) => x.id === g[2]);
      const want = DIST.winProbAt(d8.pairs.mu[i * 8 + j] + (off.get(g[1]) as number) - (off.get(g[2]) as number), Math.sqrt(121 - 18), CAL);
      if (Math.abs(want - g[4]) > 2e-4) consistent = false; }
  }
  T.chk('a team\'s latent strength persists through every round of a run (traces)', consistent && tr.traces.length === 3);
  /* correlation: with V, early and late success of the same team are more dependent */
  const dep = (V: number) => { const dd = synthetic([0, 0, 0, 0, 0, 0, 0, 0], { V }); const mm = ncaamModule(dd, { seed: 3n }); const a = runRange(mm, { start: 0, end: 60000 });
    const e = summarise(mm, a)[0]; return e.outcomes.win_title.probability; };
  T.chk('SYNTHETIC: equal teams have a 1/8 title chance with or without V', Math.abs(dep(0) - 0.125) < 0.006 && Math.abs(dep(9) - 0.125) < 0.006);
}

/* ---- completed games stay fixed ---- */
{
  const d = synthetic([10, -10, 0, 0], { fixed: { 'R1-0': 't01' } });
  const m = ncaamModule(d, { seed: 2n }); const agg = runRange(m, { start: 0, end: 20000 });
  const r = summarise(m, agg);
  T.eq('SYNTHETIC: the observed winner of a completed game always advances', r[1].outcomes.reach_r2.probability, 1);
  T.eq('...and its loser never does, however strong', r[0].outcomes.reach_r2.probability, 0);
}

/* ---- reproducibility ---- */
{
  const d = synthetic([6, 4, 3, 2, 1, 0, -2, -5], { V: 4 });
  const a1 = runRange(ncaamModule(d, { seed: 77n }), { start: 0, end: 5000 });
  const a2 = runRange(ncaamModule(d, { seed: 77n }), { start: 0, end: 5000 });
  T.eq('the same seed and inputs give identical counts', a1.counts, a2.counts);
  const a3 = runRange(ncaamModule(d, { seed: 78n }), { start: 0, end: 5000 });
  T.chk('another seed gives other counts', JSON.stringify(a1.counts) !== JSON.stringify(a3.counts));
  const w1 = await runPlan({ sport: 'ncaam', data: d, seed: 77n, runs: 6000, workers: 1, traceRuns: [] });
  const w3 = await runPlan({ sport: 'ncaam', data: d, seed: 77n, runs: 6000, workers: 3, traceRuns: [] });
  T.eq('1 worker and 3 workers give identical counts', w1.agg.counts, w3.agg.counts);
  const v0 = await runPlan({ sport: 'ncaam', data: d, seed: 77n, runs: 2000, workers: 2, traceRuns: [], sigma: 0 });
  T.chk('the V = 0 arm runs through the shared runner', v0.agg.n === 2000);
}

/* ---- refusals ---- */
{
  const d = synthetic([1, 0]);
  T.throws('within-tournament drift is refused', () => ncaamModule(Object.assign({}, d, { config: Object.assign({}, d.config, { drift: { mode: 'random_walk' } }) }) as any, { seed: 1n }), /drift/);
  T.throws('availability sampling without an owned source is refused', () => ncaamModule(Object.assign({}, d, { config: Object.assign({}, d.config, { availability: { mode: 'sample', reason: '' } }) }) as any, { seed: 1n }), /availability/);
  T.throws('a strength variance larger than the game variance is refused', () => ncaamModule(synthetic([1, 0], { V: 70, sd: 11 }), { seed: 1n }), /exceeds/);
  const src = fs.readdirSync(path.join(REPO, 'simulator', 'src', 'sports', 'ncaam')).map((f) => fs.readFileSync(path.join(REPO, 'simulator', 'src', 'sports', 'ncaam', f), 'utf8')).join('\n');
  T.chk('Math.random is never used', !/Math\.random/.test(src));
  T.chk('no network call inside the module', !/fetch\(|https?:\/\//.test(fs.readFileSync(path.join(REPO, 'simulator', 'src', 'sports', 'ncaam', 'module.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
}

/* ---- registry and plan ---- */
{
  const reg = sportRegistry().find((s) => s.key === 'ncaam')!;
  T.chk('college basketball is in the registry as ncaam (cbb is college baseball here)', !!reg && !sportRegistry().some((s) => s.key === 'cbb'));
  T.eq('NCAAM is BLOCKED until the 2027 format and bracket are verified', reg.status, 'BLOCKED');
  T.eq('its tabs', reg.tabs, ['games', 'upset_watch', 'tournament', 'model_health']);
  T.chk('the blockers name what is missing', reg.blockers.some((b) => /format/.test(b)) && reg.blockers.some((b) => /bracket/.test(b)));
  const ready = inputsReady('ncaam');
  T.chk('without the official bracket file the nightly plan skips NCAAM with a reason', fs.existsSync(path.join(REPO, 'basketball', 'ncaam_forecast', 'config', 'brackets', '2027.json')) ? ready.ready : (!ready.ready && !planRuns('schedule', {}).some((p) => p.sport === 'ncaam')));
  T.throws('a dispatch for NCAAM without inputs is refused', () => planRuns('workflow_dispatch', { sport: 'ncaam', season: '2027', runs: '100000', seed: '', publish: 'false' }), /bracket/);
}

/* ---- the real 2026 tournament, reconstructed from the committed data ---- */
{
  const { buildNcaamSnapshot } = await import('../src/sports/ncaam/inputs.ts');
  const DS = req(path.join(REPO, 'basketball', 'ncaam_forecast', 'dataset.js'));
  const MD = req(path.join(REPO, 'basketball', 'ncaam_forecast', 'model.js'));
  const W = req(path.join(REPO, 'basketball', 'ncaam_forecast', 'weekly.js'));
  const games = DS.load([2025, 2026]);
  const cache = MD.researchRows(DS.engineGames(games.filter((g: any) => g.season === 2025)), W.selectionConfig());
  const snap = buildNcaamSnapshot({ season: 2026, mode: 'historical', modelSource: 'selection', cacheWalk: cache, games });
  T.eq('2026: 68 entrants, First Four to the final', [snap.data.teams.length, snap.data.bracket.rounds], [68, ['FF', 'R64', 'R32', 'S16', 'E8', 'F4', 'NC']]);
  const gates = validateNcaamInputs(snap);
  T.chk('2026: every input gate passes except the champion rule (a selection run)', gates.filter((g) => g.status !== 'PASS').map((g) => g.id).join() === 'model.champion', gates);
  const m = ncaamModule(snap.data, { seed: 1n }); const agg = runRange(m, { start: 0, end: 4000 });
  T.eq('2026: every per-run and aggregate sum rule holds (64 in the R64, 4 per region in the Sweet 16, 1 per region in the Final Four)', checkAggregateSums(m, agg), []);
  const seeds = new Map(snap.data.teams.map((t) => [t.id, t.seed]));
  T.chk('2026: verified seeds are carried (1-16)', [...seeds.values()].every((s) => Number.isInteger(s) && (s as number) >= 1 && (s as number) <= 16));
  T.chk('2026: the snapshot hash is content-derived', /^[0-9a-f]{64}$/.test(snap.input_hash));
}

process.exit(T.done());
