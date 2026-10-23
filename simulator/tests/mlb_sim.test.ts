/* MLB simulation, on the committed 2025 snapshots:
   - fixed completed postseason results: the morning of World Series game 3 2025, every completed regular-season
     and postseason game is the real one in every run (division titles, seeds, byes, every round through the
     pennants exactly 0 or 1), only games 3-7 are simulated, at the format's hosts
   - series order and length inside the simulation; qualification consistency mid-season (2025-08-15)
   - sum rules, determinism, worker-count independence, input gates, the command line */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kit } from './_kit.ts';
import { mlbModule } from '../src/sports/mlb/module.ts';
import { validateMlbInputs, mlbMathStatus } from '../src/sports/mlb/validate.ts';
import { runRange, summarise, checkAggregateSums } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { parseArgs, execute, mlbTiebreakGate } from '../src/cli/run.ts';
import { MLB_FIXTURES } from '../src/cli/build_mlb_fixture.ts';
import { planRuns } from '../src/cli/plan.ts';
import { mlbFixture } from './_mlb_fixture.ts';
import { checkSnapshot, finalize } from '../src/sports/mlb/inputs.ts';

const K = kit('MLB simulation');
const P = (r: ReturnType<typeof summarise>, code: string, o: string) => r.find((e) => e.entity_id === code)!.outcomes[o].probability;

/* ---- fixed completed postseason results ---- */
{
  const d = mlbFixture('ws').data;
  const evs: any[] = [];
  const m = mlbModule(d, { seed: 11n, observe: (e) => evs.push(e) });
  const agg = runRange(m, { start: 0, end: 3000 });
  const r = summarise(m, agg);
  K.eq('sum rules hold on every run and in aggregate', [agg.violations.length, checkAggregateSums(m, agg)], [0, []]);
  const SEEDS: Record<string, string[]> = { AL: ['TOR', 'SEA', 'CLE', 'NYA', 'BOS', 'DET'], NL: ['MIL', 'PHI', 'LAN', 'CHN', 'SDN', 'CIN'] };
  K.chk('every 2025 seed is fixed (probability exactly 1), as the final standings and the tiebreaks give them', Object.values(SEEDS).every((s) => s.every((c, i) => P(r, c, 'seed_' + (i + 1)) === 1)));
  K.chk('division titles fixed: TOR SEA CLE MIL PHI LAN at 1, everyone else 0', r.every((e) => e.outcomes.win_division.probability === (['TOR', 'SEA', 'CLE', 'MIL', 'PHI', 'LAN'].includes(e.entity_id) ? 1 : 0)));
  K.chk('byes fixed: TOR SEA MIL PHI', r.every((e) => e.outcomes.bye.probability === (['TOR', 'SEA', 'MIL', 'PHI'].includes(e.entity_id) ? 1 : 0)));
  K.chk('every completed round fixed: Division Series, LCS and both pennants exactly 0 or 1', r.every((e) => ['reach_division_series', 'reach_lcs', 'win_pennant'].every((o) => e.outcomes[o].probability === 0 || e.outcomes[o].probability === 1)) && P(r, 'LAN', 'win_pennant') === 1 && P(r, 'TOR', 'win_pennant') === 1);
  const ws = P(r, 'LAN', 'win_world_series') + P(r, 'TOR', 'win_world_series');
  K.chk('only the World Series is open: LAN + TOR = 1, each strictly between 0 and 1', ws === 1 && P(r, 'LAN', 'win_world_series') > 0.05 && P(r, 'LAN', 'win_world_series') < 0.95);
  K.eq('only World Series games 3-7 are simulated; games 1-2 and every earlier round are fixed', [...new Set(evs.map((e) => e.game))].sort(), ['WS-G3', 'WS-G4', 'WS-G5', 'WS-G6', 'WS-G7']);
  K.chk('fixed postseason games counted every run (42 completed postseason games before game 3)', agg.diags['postseason:games_fixed'] === 3000 * 42, agg.diags['postseason:games_fixed']);
  const hosts: Record<string, Set<string>> = {}; for (const e of evs) (hosts[e.game] = hosts[e.game] || new Set()).add(e.home);
  K.eq('World Series hosts 2-3-2: TOR (94-68, the better record) games 1-2 and 6-7, LAN games 3-5', ['WS-G3', 'WS-G4', 'WS-G5', 'WS-G6', 'WS-G7'].map((g) => [...hosts[g]].join()), ['LAN', 'LAN', 'LAN', 'TOR', 'TOR']);
  const perRun = new Map<number, number>(); for (const e of evs) perRun.set(e.run, (perRun.get(e.run) || 0) + 1);
  K.chk('from 1-1 a series needs 3 to 5 more games: every run plays between 3 and 5', [...perRun.values()].every((n) => n >= 3 && n <= 5) && perRun.size === 3000);
  const wins = new Map<number, Record<string, number>>(); for (const e of evs) { const w = wins.get(e.run) || { LAN: 1, TOR: 1 }; w[e.winner]++; wins.set(e.run, w); }
  K.chk('every run ends with exactly one club at four wins', [...wins.values()].every((w) => (w.LAN === 4) !== (w.TOR === 4) && Math.max(w.LAN, w.TOR) === 4));
  K.chk('the World Series dates are the calendar\'s: game 3 the announced Oct 27, then Oct 28, 29, 31, Nov 1', ['WS-G3', 'WS-G4', 'WS-G5', 'WS-G6', 'WS-G7'].map((g) => [...new Set(evs.filter((e) => e.game === g).map((e) => e.date))].join()).join(' ') === '2025-10-27 2025-10-28 2025-10-29 2025-10-31 2025-11-01');
  const status = mlbMathStatus(d);
  K.chk('math status after the regular season: every club clinched or eliminated (final standings and tiebreaks), and the probabilities agree',
    r.every((e) => { const s = status[e.entity_id]; return s.playoffs != null && s.division != null && (s.playoffs === 'clinched' ? e.outcomes.make_playoffs.probability === 1 : e.outcomes.make_playoffs.probability === 0) && (s.division === 'clinched' ? e.outcomes.win_division.probability === 1 : e.outcomes.win_division.probability === 0); }));
}
/* a tampered completed postseason game is refused by the gate before anything is simulated */
{
  const snap = mlbFixture('ws');
  const g = snap.data.games.find((x) => x.phase === 'postseason' && x.round === 'WS' && x.series_game === 1)!;
  const [h, a] = [g.home, g.away]; g.home = a; g.away = h;          // World Series game 1 "hosted" by the wrong club
  const bad = finalize(snap.data, snap.meta);
  const gate = validateMlbInputs(bad, { ignoreCodeDrift: true }).find((x) => x.id === 'postseason.consistent')!;
  K.chk('a completed postseason game at the wrong host fails postseason.consistent (blocks the simulation)', gate.status === 'FAIL' && gate.blocks === 'simulation', gate.detail);
  K.throws('and the module refuses it too', () => runRange(mlbModule(bad.data, { seed: 1n }), { start: 0, end: 1 }), /the schedule has it at/);
}
/* ---- mid-season: qualification consistency ---- */
{
  const d = mlbFixture('aug').data;
  const m = mlbModule(d, { seed: 2n });
  const agg = runRange(m, { start: 0, end: 1500 });
  const r = summarise(m, agg);
  K.eq('mid-season: sum rules hold on every run', [agg.violations.length, checkAggregateSums(m, agg).length], [0, 0]);
  K.chk('a bye only ever goes to a division winner (seeds 1-2)', r.every((e) => e.outcomes.bye.probability <= e.outcomes.win_division.probability + 1e-12));
  K.chk('seeds 1-3 only ever go to division winners: P(seed 1..3) = P(win division)', r.every((e) => Math.abs(e.outcomes.seed_1.probability + e.outcomes.seed_2.probability + e.outcomes.seed_3.probability - e.outcomes.win_division.probability) < 1e-12));
  K.chk('P(postseason) = P(seed 1) + ... + P(seed 6)', r.every((e) => Math.abs([1, 2, 3, 4, 5, 6].reduce((a, k) => a + e.outcomes['seed_' + k].probability, 0) - e.outcomes.make_playoffs.probability) < 1e-12));
  K.chk('round advancement is monotone: postseason >= DS >= LCS >= pennant >= title', r.every((e) => { const o = e.outcomes; return o.make_playoffs.probability >= o.reach_division_series.probability && o.reach_division_series.probability >= o.reach_lcs.probability && o.reach_lcs.probability >= o.win_pennant.probability && o.win_pennant.probability >= o.win_world_series.probability; }));
  K.chk('a bye is a Division Series berth: P(reach DS) >= P(bye)', r.every((e) => e.outcomes.reach_division_series.probability >= e.outcomes.bye.probability));
  const cur: Record<string, number> = {}; for (const t of d.teams) cur[t.code] = 0;
  for (const g of d.games) if (g.phase === 'regular' && g.status === 'final') cur[(g.home_score as number) > (g.away_score as number) ? g.home : g.away]++;
  K.chk('completed games are fixed: no club\'s simulated wins fall below its wins on 2025-08-15', r.every((e) => e.value_hist.slice(0, 2 * cur[e.entity_id]).every((c) => c === 0)));
  const open = d.games.filter((g) => g.status === 'scheduled').length;
  K.chk('the fixture is mid-season (non-vacuous): 600+ games left and no club certain of the World Series', open > 600 && r.every((e) => e.outcomes.win_world_series.probability < 0.5));
  K.chk('tiebreaks were reached and resolved by the procedure (counted), never exhausted', (agg.diags['tiebreak:groups'] || 0) > 0 && !agg.flags.tiebreak_exhausted);
  const ms = mlbMathStatus(d);
  K.chk('mid-season math status (sufficient conditions) never contradicts the simulation', r.every((e) => { const s = ms[e.entity_id]; const p = e.outcomes.make_playoffs.probability, q = e.outcomes.win_division.probability;
    return (s.playoffs !== 'clinched' || p === 1) && (s.playoffs !== 'eliminated' || p === 0) && (s.division !== 'clinched' || q === 1) && (s.division !== 'eliminated' || q === 0); }));
}
/* ---- determinism and worker independence ---- */
{
  const d = mlbFixture('aug').data;
  const a = runRange(mlbModule(d, { seed: 99n }), { start: 0, end: 120 });
  const b = runRange(mlbModule(d, { seed: 99n }), { start: 0, end: 120 });
  K.eq('the same seed reproduces every count exactly', [a.counts, a.hist], [b.counts, b.hist]);
  const c = runRange(mlbModule(d, { seed: 100n }), { start: 0, end: 120 });
  K.chk('another seed gives other counts', JSON.stringify(a.counts) !== JSON.stringify(c.counts));
  const one = await runPlan({ sport: 'mlb', data: d, seed: 5n, runs: 90, workers: 1, traceRuns: [] });
  const three = await runPlan({ sport: 'mlb', data: d, seed: 5n, runs: 90, workers: 3, traceRuns: [] });
  K.eq('1 worker and 3 workers give identical integer counts', [one.agg.counts, one.agg.hist, one.agg.n], [three.agg.counts, three.agg.hist, three.agg.n]);
}
/* ---- input gates ---- */
{
  for (const k of ['ws', 'aug'] as const) {
    const gates = validateMlbInputs(mlbFixture(k));
    const fail = gates.filter((g) => g.status === 'FAIL');
    K.eq('fixture ' + k + ': no input gate fails (code identity included: the committed snapshot matches the committed code)', fail.map((g) => g.id + ': ' + g.detail), []);
  }
  const s = mlbFixture('aug'); s.data.games[0].home_score = 99;
  K.throws('a snapshot edited after it was built is refused (content hash)', () => checkSnapshot(s), /content hash mismatch/);
  const t = mlbFixture('aug'); t.data.games.find((g) => g.status === 'scheduled')!.starters.home = { id: 'x', status: 'Observed' };
  K.chk('a scheduled game may not carry an Observed starter (starters.labels)', validateMlbInputs(finalize(t.data, t.meta), { ignoreCodeDrift: true }).find((g) => g.id === 'starters.labels')!.status === 'FAIL');
}
/* ---- the command line ---- */
{
  const a = parseArgs(['--sport', 'mlb', '--season', '2025', '--as-of', '2025-10-27', '--runs', '2000']);
  K.eq('parseArgs: MLB history replay', [a.sport, a.season, a.asOf, a.runs], ['mlb', 2025, '2025-10-27', 2000]);
  K.throws('a history season needs --as-of', () => parseArgs(['--sport', 'mlb', '--season', '2025']), /needs --as-of/);
  K.throws('a history replay is never published', () => parseArgs(['--sport', 'mlb', '--season', '2025', '--as-of', '2025-08-15', '--publish']), /never published/);
  K.throws('--as-of is an MLB option', () => parseArgs(['--sport', 'nfl', '--as-of', '2026-10-01']), /MLB options/);
  K.throws('a bad date is refused', () => parseArgs(['--sport', 'mlb', '--season', '2025', '--as-of', '10/27/2025']), /YYYY-MM-DD/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mlbsim-'));
  const o = await execute(parseArgs(['--sport', 'mlb', '--season', '2025', '--snapshot', MLB_FIXTURES.ws.file, '--runs', '2000', '--workers', '2', '--out', out]), () => {});
  const res = o.results as any;
  K.chk('the run writes snapshot, results, gates and manifest', ['snapshot.json', 'results.json', 'gates.json', 'manifest.json'].every((f) => fs.existsSync(path.join(out, f))));
  K.eq('confirmed starters are reported as Confirmed (game 3)', res.starting_pitchers.confirmed.map((g: any) => [g.away_starter, g.home_starter, g.label]), [['Max Scherzer', 'Tyler Glasnow', 'Confirmed']]);
  K.chk('game 3 is reported Confirmed (one name, as announced)', Object.values(res.starting_pitchers.by_game['WS-G3']).every((x: any) => x.label === 'Confirmed' && Object.keys(x.share).length === 1));
  K.chk('later starters are reported as Projected distributions, never one name', Object.entries(res.starting_pitchers.by_game).filter(([k]) => k !== 'WS-G3').every(([, clubs]: any) => Object.values(clubs).every((x: any) => x.label === 'Projected' && Object.keys(x.share).length >= 2)));
  K.chk('not publishable: a history replay is never published (MLB itself is ACTIVE)', !o.publishable && o.gates.some((g) => g.id === 'sport.active' && g.status === 'PASS') && o.gates.some((g) => g.id === 'mode.live' && g.status === 'FAIL' && g.blocks === 'publication'));
  K.chk('starter keys are moved out of the diagnostics', !Object.keys(res.diagnostics).some((k) => k.startsWith('starter|')));
  fs.rmSync(out, { recursive: true, force: true });
  K.eq('the workflow plan: an MLB dispatch plans one live 2026 dry run', planRuns('workflow_dispatch', { sport: 'mlb', season: '2026', runs: '100000', seed: '', publish: 'false' }).map((r) => [r.sport, r.season, r.publish, r.status]), [['mlb', '2026', false, 'ACTIVE']]);
  K.eq('  ... and a publication, at 100,000 runs', planRuns('workflow_dispatch', { sport: 'mlb', season: '2026', runs: '100000', seed: '', publish: 'true' }).map((r) => r.publish), [true]);
  K.throws('  ... never with fewer runs', () => planRuns('workflow_dispatch', { sport: 'mlb', season: '2026', runs: '99999', seed: '', publish: 'true' }), /at least 100000/);
  const nightly = (iso: string) => planRuns('schedule', {}, undefined, new Date(iso)).filter((r) => r.sport === 'mlb');
  K.eq('the nightly schedule runs MLB through the World Series window, under its configured season', nightly('2026-10-24T10:17:00Z').map((r) => [r.season, r.runs]), [['2026', '100000']]);
  K.eq('  ... through its last date, and not after it', [nightly('2026-11-07T10:17:00Z').length, nightly('2026-11-08T10:17:00Z').length], [1, 0]);
  K.eq('  ... while a dispatch is never refused by the date', planRuns('workflow_dispatch', { sport: 'mlb', season: '2026', runs: '100000', seed: '', publish: 'false' }, undefined, new Date('2027-01-15T00:00:00Z')).length, 1);
}
/* ---- the tiebreak procedure, measured while unverified: a tie that decides a reported place refuses the run ---- */
{
  const fact = { value: 'x', source: 's', retrieved: '2026-10-23', verification: 'UNVERIFIED' as const, verify_by: 'v', affects_results: true, verified_by: null, verified_at: null, measured: true };
  const g = (f: any, diags: Record<string, number>) => mlbTiebreakGate(f, diags, 100000);
  K.eq('measured and unverified: no tie reached a reported place -> passes', [g(fact, {}).status, g(fact, {}).blocks], ['PASS', 'none']);
  K.eq('  ... one tie group in any run -> refused', [g(fact, { 'tiebreak:groups': 1 }).status, g(fact, { 'tiebreak:groups': 1 }).blocks], ['FAIL', 'publication']);
  K.eq('  ... an equal-record World Series host -> refused', g(fact, { 'tiebreak:world_series_home': 3 }).blocks, 'publication');
  K.eq('  ... the steps a group used are not what counts (the group is)', g(fact, { 'tiebreak:step:head_to_head': 5 }).status, 'PASS');
  const verified = { ...fact, verification: 'VERIFIED' as const, verified_by: 'x', verified_at: '2026-10-23' };
  K.eq('verified: ties are the procedure\'s to decide -> passes', g(verified, { 'tiebreak:groups': 40 }).status, 'PASS');
  K.eq('not measured (a history replay): never refused here', g({ ...fact, measured: undefined, verification: 'NOT_APPLICABLE' }, { 'tiebreak:groups': 40 }).status, 'PASS');
  /* the 2025 World Series snapshot: its final standings carry three ties at reported places (MLB_SIMULATOR_NOTES.md
     §4.2: the AL East and the NL wild cards, decided head-to-head), so every run forms exactly three tie groups and a
     measured, unverified procedure would refuse the season. 2026 has none (MLB's standings: no equal record at any place). */
  const d = mlbFixture('ws').data;
  const agg = runRange(mlbModule(d, { seed: 3n }), { start: 0, end: 400 });
  K.eq('a finished 2025 season: the same three tie groups in every run, no equal-record World Series', [agg.diags['tiebreak:groups'], agg.diags['tiebreak:world_series_home'] || 0], [3 * 400, 0]);
  K.eq('  ... which the gate refuses while the procedure is measured', g(fact, agg.diags).blocks, 'publication');
}
process.exit(K.done());
