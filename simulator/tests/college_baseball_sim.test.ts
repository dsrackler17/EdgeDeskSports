/* ===========================================================================
   College baseball's Road to Omaha (simulator/src/sports/college_baseball):
   the bridge to the served model (it reproduces the walk-forward's own
   predictions), the tournament rebuilt from the games, the double
   elimination and the series, results already played, the super-regional
   host, the correlated strength draws, the season's move and the committee
   proxy, the module's sum rules and determinism, the activation conditions,
   the gates, the nightly plan, and one real snapshot built from the
   committed warehouse.
     node simulator/tests/college_baseball_sim.test.ts
   =========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { kit } from './_kit.ts';
import { replay, expectations, priceGame, pricePinned, pHome, W, REPO, type Snapshot } from '../src/sports/college_baseball/model.ts';
import { reconstruct, homeParks } from '../src/sports/college_baseball/bracket.ts';
import { TournamentSim, simulate, type Structure } from '../src/sports/college_baseball/sim.ts';
import { driftAt, fitDrift, hasAq, type DriftAt } from '../src/sports/college_baseball/road.ts';
import { cbaseModule, OUTCOMES } from '../src/sports/college_baseball/module.ts';
import { cbaseActivation, readOrNull, BACKTEST_FILE, ROAD_FILE } from '../src/sports/college_baseball/activation.ts';
import { validateCbaseInputs, executeCbase } from '../src/sports/college_baseball/run.ts';
import { buildCbaseSnapshot, readCbaseSnapshot, writeCbaseSnapshot } from '../src/sports/college_baseball/inputs.ts';
import { runRange, summarise } from '../src/core/engine.ts';
import { streamFor } from '../src/core/prng.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns, NIGHTLY, RUNNABLE, inSeason } from '../src/cli/plan.ts';
import { parseArgs } from '../src/cli/run.ts';
import { syntheticData, syntheticSnapshot } from './_college_baseball_fixture.ts';
import { createRequire } from 'node:module';

const K = kit('college baseball sim');
const req = createRequire(import.meta.url);
const CAL = req(path.join(REPO, 'college_baseball', 'lib', 'calibration.js'));
const TQ = req(path.join(REPO, 'college_baseball', 'lib', 'team_quality.js'));

/* ------------------------------------------------------------ the bridge (2012-2015 only: fast) */
{
  const t15 = reconstruct(2015).t!;
  const rp = replay({ through: 2015, at: [{ season: 2015, date: t15.start, teams: t15.field, key: 'start' }] });
  const S = rp.snapshots.get('start')!;
  K.chk('BRIDGE: the replay scores every 2014-2015 game it adds (the walk-forward\'s rows)', rp.rows.length > 15000 && rp.rows.every((r) => r.season >= 2014), rp.rows.length);
  K.chk('BRIDGE: 2015 has a run-space calibration fitted on 2014 only', !!S.cal && S.cal.n === rp.rows.filter((r) => r.season === 2014).length, S.cal);
  const day = rp.rows.filter((r) => r.date === t15.start);
  const gs = new Map(W.games(2015).map((g: any) => [g.game_id, g]));
  let worst = 0;
  for (const r of day) {
    const g: any = gs.get(r.game_id);
    const e = expectations({ ...S, cal: null }, S.teams[r.home_id], S.teams[r.away_id], { neutral: !!r.neutral, park: (g.park_key && S.parks[g.park_key]) || 0 });
    worst = Math.max(worst, Math.abs(e.lh - r.lh), Math.abs(e.la - r.la), Math.abs(e.sd - r.sd));
  }
  K.chk('BRIDGE: a snapshot rebuilds the served model\'s run expectations and sd exactly (every game of the first regional day)', day.length >= 30 && worst < 1e-9, { games: day.length, worst });
  const r0 = day[0]; const g0: any = gs.get(r0.game_id);
  const p = priceGame(S, S.teams[r0.home_id], S.teams[r0.away_id], { neutral: !!r0.neutral, park: (g0.park_key && S.parks[g0.park_key]) || 0 });
  K.near('BRIDGE: the price is the board\'s hier_cal (calibration.js pOf)', p, CAL.pOf({ lh: r0.lh, la: r0.la, sd: r0.sd, neutral: r0.neutral, p7: 0 }, S.cal, pHome, 0.7736), 1e-12);
  /* the correlated draws: averaged over the gap's posterior, a pinned price is the integrated one */
  const e = expectations(S, S.teams[r0.home_id], S.teams[r0.away_id], { neutral: true, park: 0 });
  const rs = streamFor(5n, 0, 1); let acc = 0; const M = 40000;
  for (let i = 0; i < M; i++) { let u = rs.nextDouble(); while (u <= 0) u = rs.nextDouble(); acc += pricePinned(e.lh, e.la, e.sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rs.nextDouble())); }
  K.near('DRAWS: one strength draw per tournament keeps each game\'s served price on average', acc / M, TQ.integrate(e.lh, e.la, e.sd, pHome), 0.004);
  /* the committed walk-forward predictions agree with the replay */
  const txt = zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'college_baseball', 'validation', 'oos_team_predictions.csv.gz'))).toString().split('\n');
  const hd = txt[0].split(','), iG = hd.indexOf('game_id'), iL = hd.indexOf('hier_lh');
  const rows = new Map(rp.rows.map((x) => [x.game_id, x])); let n = 0, diff = 0;
  for (const line of txt.slice(1)) { const c = line.split(','); const x = rows.get(c[iG]); if (!x || c[iL] === '') continue; n++; diff = Math.max(diff, Math.abs(Number(c[iL]) - x.lh)); }
  K.chk('BRIDGE: the replay matches the committed out-of-sample predictions (oos_team_predictions.csv.gz) to their rounding', n === rp.rows.length && diff < 1e-4, { n, rows: rp.rows.length, diff });
}

/* ------------------------------------------------------------ the tournament rebuilt from its games */
{
  const t = reconstruct(2025).t!;
  K.eq('REBUILD 2025: 64 teams, 16 regionals of four, every one hosted, 8 super regionals, the champion LSU', [t.field.length, t.pods.length, t.pods.every((p) => p.teams.length === 4), t.pods.filter((p) => p.host).length, t.supers.length, t.names[t.cws.champion]], [64, 16, true, 16, 8, 'LSU']);
  K.chk('REBUILD 2025: each regional\'s game 1 is its host against the 4 seed; the brackets hold four supers each', t.pods.every((p) => p.first[0][0] === p.host) && t.cws.brackets.flat(2).sort().join() === '0,1,2,3,4,5,6,7');
  const t17 = reconstruct(2017).t!;
  K.eq('REBUILD 2017: the Stanford regional started on a Thursday; Florida won', [t17.start, t17.names[t17.cws.champion]], ['2017-06-01', 'Florida']);
  K.chk('REBUILD 2023: refused, with the reason (the warehouse holds 2023 results only through March)', reconstruct(2023).t === null && /holds 2023 results only through 2023-03-29/.test(reconstruct(2023).reason || ''), reconstruct(2023).reason);
  K.chk('REBUILD 2019: who advanced comes from the next round, not a quarantined score', reconstruct(2019).t?.cws.champion != null && reconstruct(2019).t!.names[reconstruct(2019).t!.cws.champion] === 'Vanderbilt');
  K.chk('REBUILD: home parks from the season\'s non-neutral home games', Object.keys(homeParks(2025, t.start)).length > 250);
}

/* ------------------------------------------------------------ the simulation on a synthetic snapshot */
function synthSnap(nets: number[], sdTeam = 0): Snapshot {
  const teams: Snapshot['teams'] = {};
  nets.forEach((v, i) => { const id = 'x' + i; teams[id] = { id, name: id, conf: 'C' + (i % 8), off: v / 2, def: v / 2, sd_team: sdTeam, sd_conf: 0, info: 0 }; });
  return { season: 2099, date: '2099-06-01', mu: Math.log(6), hb: 0.04, hp: 0.04, teams, parks: {}, cal: null };
}
const ids64 = Array.from({ length: 64 }, (_, i) => 'x' + i);
const st64: Structure = { pods: Array.from({ length: 16 }, (_, k) => ({ teams: [ids64[4 * k], ids64[4 * k + 1], ids64[4 * k + 2], ids64[4 * k + 3]] as [string, string, string, string], host: ids64[4 * k], park: null })), supers: Array.from({ length: 8 }, (_, k) => ({ pods: [k, 15 - k] as [number, number] })), cws: [[[0, 7], [3, 4]], [[1, 6], [2, 5]]] };
{
  const nets = ids64.map((_, i) => (i === 0 ? 3 : 0));
  const sim = new TournamentSim(synthSnap(nets), st64);
  const T = simulate(sim, 2000, streamFor(9n, 0, 3));
  K.chk('SIM: a team far stronger than everyone wins its regional, reaches Omaha and wins the title almost always', (T.regional.get('x0') || 0) > 1990 && (T.champion.get('x0') || 0) > 1900, [T.regional.get('x0'), T.champion.get('x0')]);
  const even = new TournamentSim(synthSnap(ids64.map(() => 0)), st64);
  const E = simulate(even, 20000, streamFor(9n, 1, 3));
  const hostShare = [...Array(16).keys()].reduce((a, k) => a + (E.regional.get(ids64[4 * k]) || 0), 0) / (16 * 20000);
  K.chk('SIM: equal teams: the host wins its regional more than a quarter of the time (home field), the others share the rest', hostShare > 0.27 && hostShare < 0.36, hostShare);
  K.near('SIM: equal teams: each of the 64 reaches Omaha about 1 in 8 times', [...E.omaha.values()].reduce((a, b) => a + b, 0) / (64 * 20000), 8 / 64, 1e-9);
  /* results already played: the double elimination goes on from them, game 7 included */
  const p = st64.pods[0].teams; // A host(1), B, C, D(4): game 1 A-D, game 2 B-C
  const played = [{ a: p[0], b: p[3], winner: p[0] }, { a: p[1], b: p[2], winner: p[1] }, { a: p[3], b: p[2], winner: p[3] }, { a: p[0], b: p[1], winner: p[0] }, { a: p[1], b: p[3], winner: p[1] }, { a: p[0], b: p[1], winner: p[1] }];
  const s7 = new TournamentSim(synthSnap(ids64.map(() => 0)), st64, played.concat([{ a: p[0], b: p[1], winner: p[0] }]));
  const T7 = simulate(s7, 500, streamFor(9n, 2, 3));
  K.eq('SIM: the losers\' bracket team wins game 6, game 7 decides (results given): its winner takes the regional every time', T7.regional.get(p[0]), 500);
  const s6 = new TournamentSim(synthSnap(ids64.map(() => 0)), st64, played);
  const T6 = simulate(s6, 4000, streamFor(9n, 3, 3));
  K.chk('SIM: ...and with game 7 still to play, only the two teams left can win it, neither every time', (T6.regional.get(p[0]) || 0) + (T6.regional.get(p[1]) || 0) === 4000 && (T6.regional.get(p[0]) || 0) > 1000 && (T6.regional.get(p[1]) || 0) > 1000, [T6.regional.get(p[0]), T6.regional.get(p[1])]);
  /* the super-regional host */
  const hs = new TournamentSim(synthSnap(ids64.map((_, i) => -i / 100)), { ...st64, national: { x4: 1 } });
  K.eq('SIM: the super-regional host: a national seed; else the regional host; else the stronger team', [hs.superHost(0, 'x5', 'x4'), hs.superHost(0, 'x1', 'x8'), hs.superHost(0, 'x3', 'x2')], ['x4', 'x8', 'x2']);
  K.throws('SIM: a team without a rating is refused', () => new TournamentSim(synthSnap([0, 0]), st64), /no rating/);
}

/* ------------------------------------------------------------ the season's move and the committee */
{
  const road = readOrNull(ROAD_FILE);
  const D = road.next.drift as DriftAt[];
  K.eq('DRIFT: the preseason checkpoint before the first game; the nearest measured checkpoint past either end', [driftAt(D, 300, true).team_sd, driftAt(D, 90, false).team_sd, driftAt(D, 1, false).team_sd], [D[0].team_sd, D[1].team_sd, D[D.length - 1].team_sd]);
  const mid = driftAt(D, 56, false);
  K.chk('DRIFT: between two checkpoints the sds interpolate in variance (56 days: between 70 and 42)', mid.team_sd < D[1].team_sd && mid.team_sd > D[2].team_sd, mid);
  K.chk('DRIFT: the committed parameters move less as the season is played', D.slice(1).every((d, i) => d.team_sd <= D[i].team_sd + 1e-9));
  /* fitDrift on a known move */
  const rs = streamFor(3n, 0, 8); const g = () => { let u = rs.nextDouble(); while (u <= 0) u = rs.nextDouble(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rs.nextDouble()); };
  const pairs = [0, 1, 2, 3].map((s) => { const pre = synthSnap(Array.from({ length: 300 }, () => 0.4 * g())); const sel = JSON.parse(JSON.stringify(pre)); for (const t of Object.values(sel.teams) as any[]) { const ch = (0.9 - 1) * (t.off + t.def) + 0.15 * g(); t.off += ch / 2; t.def += ch / 2; } return { season: s, pre, sel }; });
  const f = fitDrift(pairs);
  K.chk('DRIFT: fitDrift recovers a known slope (0.9) and team sd (0.15)', Math.abs(f.slope - 0.9) < 0.03 && Math.abs(f.team_sd - 0.15) < 0.015, f);
  K.chk('AQ: an independent or no-conference program holds no automatic bid', !hasAq('DI Independent') && !hasAq('none_D1') && hasAq('SEC'));
}

/* ------------------------------------------------------------ the module */
{
  const d = syntheticData();
  const m = cbaseModule(d, { seed: 77n });
  const agg = runRange(m, { start: 0, end: 3000, traceRuns: [0] });
  const res = summarise(m, agg);
  K.eq('MODULE: the sum rules: one automatic bid per conference that holds one; 64, 16, 8, 16, 8, 2, 1', m.sumRules.map((r) => r.outcome + ':' + r.perGroup), ['auto_bid:1', 'make_field:64', 'host_regional:16', 'national_seed:8', 'win_regional:16', 'reach_omaha:8', 'reach_final:2', 'win_title:1']);
  K.chk('MODULE: no sum-rule violation in 3,000 runs (checked after every run)', agg.violations.length === 0, agg.violations.slice(0, 2));
  K.eq('MODULE: the conferences without an automatic bid are skipped by its rule', m.sumRules[0].skip, ['DI Independent', 'none_D1']);
  K.chk('MODULE: every outcome is Estimated (it passes through the committee proxy)', OUTCOMES.every((o) => o.provenance === 'Estimated'));
  const by = (k: string) => res.reduce((a, e) => a + e.outcomes[k].probability, 0);
  K.near('MODULE: the field shares add to 64', by('make_field'), 64, 1e-9);
  const ind = res.filter((e) => e.groups.conference === 'DI Independent' || e.groups.conference === 'none_D1');
  K.chk('MODULE: programs without a conference bid can still get in at large, never by an automatic bid', ind.every((e) => e.outcomes.auto_bid.probability === 0) && ind.some((e) => e.outcomes.make_field.probability > 0));
  const nested = res.every((e) => e.outcomes.win_title.probability <= e.outcomes.reach_final.probability + 1e-12 && e.outcomes.reach_final.probability <= e.outcomes.reach_omaha.probability + 1e-12 && e.outcomes.reach_omaha.probability <= e.outcomes.win_regional.probability + 1e-12 && e.outcomes.win_regional.probability <= e.outcomes.make_field.probability + 1e-12 && e.outcomes.national_seed.probability <= e.outcomes.host_regional.probability + 1e-12 && e.outcomes.host_regional.probability <= e.outcomes.make_field.probability + 1e-12);
  K.chk('MODULE: the levels nest (title <= final <= Omaha <= regional <= field; national seed <= host <= field)', nested);
  const a2 = runRange(cbaseModule(d, { seed: 77n }), { start: 0, end: 3000 });
  K.eq('MODULE: the same seed gives the same counts', a2.counts.join(), agg.counts.join());
  const split = runRange(cbaseModule(d, { seed: 77n }), { start: 0, end: 1500 }), rest = runRange(cbaseModule(d, { seed: 77n }), { start: 1500, end: 3000 });
  K.eq('MODULE: runs are independent of how they are split (each run has its own streams)', split.counts.map((c, i) => c + rest.counts[i]).join(), agg.counts.join());
  K.chk('MODULE: a traced run names its hosts, its Omaha teams and its champion', agg.traces.length === 1 && agg.traces[0].events.some((e: any) => e.ev === 'season' && e.omaha.length === 8));
  const strong = res.slice().sort((a, b) => b.outcomes.win_title.probability - a.outcomes.win_title.probability)[0];
  K.chk('MODULE: the strongest conference\'s best team is among the title favourites', ['SEC', 'ACC'].includes(strong.groups.conference), strong.groups);
  K.throws('MODULE: fewer than 64 programs cannot fill the field', () => cbaseModule({ ...d, teams: d.teams.slice(0, 50) }, { seed: 1n }), /cannot fill/);
}

/* ------------------------------------------------------------ activation, gates, plan */
{
  const bt = readOrNull(BACKTEST_FILE), road = readOrNull(ROAD_FILE);
  K.eq('ACTIVATION: the committed backtests meet every condition', cbaseActivation(), { status: 'ACTIVE', blockers: [] });
  const bad = JSON.parse(JSON.stringify(bt)); bad.regional_winner_log_loss.diff_vs_seed_lines.ci95 = [-0.1, 0.02];
  const b1 = cbaseActivation(bad, road);
  K.chk('ACTIVATION: regional winners no better than the seed lines -> BLOCKED, saying so', b1.status === 'BLOCKED' && /seed lines/.test(b1.blockers.join()), b1);
  const bad2 = JSON.parse(JSON.stringify(road)); bad2.summary.preseason.levels.field.diff_vs_last_season.ci95 = [-0.01, 0.01];
  K.chk('ACTIVATION: the preseason field no better than last season -> BLOCKED', cbaseActivation(bt, bad2).blockers.some((x) => /last season/.test(x)));
  K.chk('ACTIVATION: no backtest -> BLOCKED', cbaseActivation(null, road).status === 'BLOCKED');
  const reg = sportRegistry().find((s) => s.key === 'college_baseball')!;
  K.eq('REGISTRY: college baseball is ACTIVE with three tabs', [reg.status, reg.tabs.join()], ['ACTIVE', 'tournament,conference,model_health']);
  K.chk('REGISTRY: the public text never says "probability"', !/probability/i.test(JSON.stringify(reg)));
  const ok = validateCbaseInputs(syntheticSnapshot(), Date.parse('2026-10-24T12:00:00Z'));
  K.chk('GATES: the synthetic preseason passes every input gate out of season', ok.every((g) => g.status === 'PASS'), ok.filter((g) => g.status !== 'PASS'));
  const sel = validateCbaseInputs(syntheticSnapshot({ phase: 'selected', lastGame: '2027-05-30' }), Date.parse('2027-05-31T12:00:00Z'));
  K.chk('GATES: on Selection Monday the run is refused (season.window blocks simulation)', sel.some((g) => g.id === 'season.window' && g.status === 'FAIL' && g.blocks === 'simulation'));
  const stale = validateCbaseInputs(syntheticSnapshot({ phase: 'in_season', lastGame: '2027-03-01' }), Date.parse('2027-03-20T12:00:00Z'));
  K.chk('GATES: in season, a warehouse a week behind blocks publication (results.current)', stale.some((g) => g.id === 'results.current' && g.status === 'FAIL' && g.blocks === 'publication'));
  K.chk('PLAN: college baseball runs nightly with season 2027', NIGHTLY.includes('college_baseball') && RUNNABLE.college_baseball === 2027);
  K.eq('PLAN: through the night before Selection Monday, not after', [inSeason('college_baseball', new Date('2027-05-30T08:00:00Z')).ready, inSeason('college_baseball', new Date('2027-05-31T08:00:00Z')).ready], [true, false]);
  const pr = planRuns('schedule', {}, sportRegistry(), new Date('2026-10-25T08:00:00Z')).find((r) => r.sport === 'college_baseball');
  K.chk('PLAN: the nightly run publishes (ACTIVE)', !!pr && pr.publish === true && pr.season === '2027', pr);
  K.eq('CLI: --sport college_baseball defaults to the 2027 season', parseArgs(['--sport', 'college_baseball', '--dry-run']).season, 2027);
}

/* ------------------------------------------------------------ the real snapshot, from the committed warehouse */
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbase-'));
  const snap = buildCbaseSnapshot({ nowMs: Date.parse('2026-11-30T12:00:00Z') });
  const d = snap.data;
  K.chk('SNAPSHOT: the 2027 preseason from the warehouse: 300+ programs, 29 automatic bids, calibration fitted on 2024-2026', d.phase === 'preseason' && d.teams.length >= 300 && d.aq_conferences.length >= 25 && !!d.model.calibration && d.model.calibration.n > 15000, { phase: d.phase, teams: d.teams.length, aq: d.aq_conferences.length, cal: d.model.calibration });
  K.chk('SNAPSHOT: the as-of is the morning after the warehouse\'s last game, not the clock (the input hash holds until a game is added)', d.as_of === '2026-06-23' && d.last_game === null && !JSON.stringify(d).includes('2026-11-30'), d.as_of);
  const f = path.join(tmp, 'snap.json'); writeCbaseSnapshot(f, snap);
  K.eq('SNAPSHOT: written and read back, hash checked', readCbaseSnapshot(f).input_hash, snap.input_hash);
  const o = await executeCbase({ season: 2027, runs: 2000, seed: '5', workers: 1, snapshot: f, out: path.join(tmp, 'out'), traceRuns: [], nowMs: Date.parse('2026-10-24T12:00:00Z') }, () => {});
  K.chk('RUN: the replayed snapshot runs; every input gate passes; only run.count (2,000 < 100,000) blocks publication', !!o.results && o.gates.filter((g) => g.status !== 'PASS').map((g) => g.id).join() === 'run.count', o.gates.filter((g) => g.status !== 'PASS'));
  const S = (o.results as any).sport_summary;
  K.chk('RUN: the reader summary carries every team, the conferences and Model Health', S.kind === 'cbase_road' && S.teams.length === d.teams.length && S.conferences.length > 25 && !!S.model_health.tournament && !!S.model_health.road);
  const fav = (o.results as any).entities.slice().sort((a: any, b: any) => b.outcomes.win_title.probability - a.outcomes.win_title.probability)[0];
  K.chk('RUN: the title favourite is a power-conference program under 20%', ['SEC', 'ACC', 'Big 12', 'Big Ten'].includes(fav.record.conf) && fav.outcomes.win_title.probability < 0.2, { name: fav.entity_name, p: fav.outcomes.win_title.probability });
}
process.exit(K.done());
