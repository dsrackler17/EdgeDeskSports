/* The NBA simulation over the committed snapshots: the model at zero offset, reproducibility, worker
   independence, persistent strength through the playoffs, completed games fixed, qualified-club totals,
   completed postseason games and series scores preserved (2025-26 frozen in the first round), the exact
   home order and four-win end in simulated series, return trajectories, the slate equivalence, and
   fail-closed validation.  node simulator/tests/nba_sim.test.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kit } from './_kit.ts';
import { nbaFixture } from './_nba_fixture.ts';
import { nbaModule, NBA_OUTCOMES, NBA_OUTCOME_SEMANTICS } from '../src/sports/nba/module.ts';
import { runRange, checkAggregateSums, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { validateNbaInputs, nbaMathStatus } from '../src/sports/nba/validate.ts';
import { readSnapshot, writeSnapshot, codeHashes, type NbaSnapshot } from '../src/sports/nba/inputs.ts';
import { hostsGame, NBA_2021 } from '../src/sports/nba/rules.ts';
import { contextKey } from '../src/sports/nba/postseason_context.ts';
import { hashCanonical } from '../src/core/canonical.ts';
import { parseArgs, execute } from '../src/cli/run.ts';
import { validateFuturesConfig, type FuturesConfig, type Mapping } from '../src/markets/compare.ts';
import { runView } from '../src/cli/markets.ts';

const T = kit('NBA simulation');
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const L = nbaFixture('live'), R = nbaFixture('replay');
const SIG = 4;
const rehash = (s: NbaSnapshot): NbaSnapshot => ({ ...s, input_hash: hashCanonical(s.data) });

/* 1 the model at zero offset; every remaining game drawn once per run, completed ones never */
{
  const d = clone(L.data); d.availability.mode = 'off';
  const open = d.games.filter((g) => !g.done), done = new Set(d.games.filter((g) => g.done).map((g) => g.game_id));
  const byId = new Map(open.map((g) => [g.game_id, g]));
  let worst = 0, n = 0, sawDone = false, perRun = new Map<number, number>();
  const m = nbaModule(d, { seed: 3n, sigma: 0, observe: (ev) => {
    if (ev.phase !== 'regular') return;
    if (done.has(ev.game)) sawDone = true;
    perRun.set(ev.run, (perRun.get(ev.run) || 0) + 1);
    worst = Math.max(worst, Math.abs(ev.mu - byId.get(ev.game)!.model!.mu)); n++;
  } });
  runRange(m, { start: 0, end: 20 });
  T.chk('sigma 0, availability off: every simulated game is drawn at the served mean exactly', worst === 0 && n === 20 * open.length, [worst, n]);
  T.chk('completed games are never drawn', !sawDone);
  T.chk('every remaining game is drawn once per run', [...perRun.values()].every((c) => c === open.length), [...perRun.values()].slice(0, 3));
}

/* 2 reproducibility and worker independence */
{
  const a = runRange(nbaModule(R.data, { seed: 11n, sigma: SIG }), { start: 0, end: 600 });
  const b = runRange(nbaModule(R.data, { seed: 11n, sigma: SIG }), { start: 0, end: 600 });
  const c = runRange(nbaModule(R.data, { seed: 12n, sigma: SIG }), { start: 0, end: 600 });
  T.eq('the same seed gives the same counts', a.counts, b.counts);
  T.chk('another seed gives other counts', JSON.stringify(a.counts) !== JSON.stringify(c.counts));
  const w1 = await runPlan({ sport: 'nba', data: L.data, seed: 7n, runs: 900, workers: 1, traceRuns: [], sigma: SIG });
  const w3 = await runPlan({ sport: 'nba', data: L.data, seed: 7n, runs: 900, workers: 3, traceRuns: [], sigma: SIG });
  T.eq('1 worker and 3 workers give identical counts', w1.agg.counts, w3.agg.counts);
  T.eq('... and identical win histograms', w1.agg.hist, w3.agg.hist);
}

/* 3 one persistent offset per club, regular season and postseason alike */
{
  const d = clone(L.data); d.availability.mode = 'off';
  const base = new Map(d.games.filter((g) => !g.done).map((g) => [g.game_id, g.model!.mu]));
  const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
  const rel: Array<Map<string, number>> = [];
  let bad = 0, post = 0;
  const m = nbaModule(d, { seed: 21n, sigma: SIG, observe: (ev) => {
    const r = rel[ev.run] || (rel[ev.run] = new Map());
    let res: number;
    if (ev.phase === 'regular') res = ev.mu - base.get(ev.game)!;
    else { const tab = d.postseason_pairs[ev.game]; res = ev.mu - tab[d.teams[ev.home].code][d.teams[ev.away].code].mu; post++; }
    const k = ev.home + ':' + ev.away, prev = r.get(k);
    if (prev != null && Math.abs(prev - res) > 1e-9) bad++;
    r.set(k, res);
    const rk = ev.away + ':' + ev.home, pr = r.get(rk);
    if (pr != null && Math.abs(pr + res) > 1e-9) bad++;
  } });
  runRange(m, { start: 0, end: 40 });
  /* cycle consistency: d_a - d_b + d_b - d_c = d_a - d_c for every triangle seen */
  let tri = 0;
  for (const r of rel) {
    const get = (a: number, b: number) => r.has(a + ':' + b) ? r.get(a + ':' + b)! : r.has(b + ':' + a) ? -r.get(b + ':' + a)! : null;
    for (let a = 0; a < 30; a += 7) for (let b = 1; b < 30; b += 5) for (let c = 2; c < 30; c += 3) {
      const x = get(a, b), y = get(b, c), z = get(a, c);
      if (x == null || y == null || z == null) continue;
      tri++; if (Math.abs(x + y - z) > 1e-9) bad++;
    }
  }
  T.chk('a club\'s offset is the same in every game of a run, the postseason included (' + tri + ' triangles, ' + post + ' postseason games)', bad === 0 && tri > 1000 && post > 1000, bad);
}

/* 4 sum rules, qualified-club totals */
{
  const m = nbaModule(L.data, { seed: 5n, sigma: SIG });
  const agg = runRange(m, { start: 0, end: 1500 });
  T.eq('every per-run sum rule holds over 1,500 runs (the engine checks each run)', agg.violations.length, 0);
  T.eq('... and every aggregate sum', checkAggregateSums(m, agg), []);
  const res = summarise(m, agg);
  const tot = (k: string, conf?: string) => res.filter((e) => !conf || e.groups.conference === conf).reduce((u, e) => u + e.outcomes[k].count, 0) / agg.n;
  T.eq('per conference: 8 playoff clubs, 4 in the play-in, 4 / 2 / 1 round winners', ['East', 'West'].map((c) => [tot('make_playoffs', c), tot('play_in', c), tot('reach_conference_semifinals', c), tot('reach_conference_finals', c), tot('win_conference', c)]), [[8, 4, 4, 2, 1], [8, 4, 4, 2, 1]]);
  T.eq('six division winners and one champion', [tot('win_division'), tot('win_title')], [6, 1]);
  T.chk('places 1-15 and seeds 1-8 once per conference per run', ['East', 'West'].every((c) => Array.from({ length: 15 }, (_, i) => tot('finish_' + (i + 1), c)).every((x) => x === 1) && Array.from({ length: 8 }, (_, i) => tot('seed_' + (i + 1), c)).every((x) => x === 1)));
  T.chk('a play-in club\'s finish is 7-10; direct qualifiers finish 1-6', res.every((e) => e.outcomes.play_in.count === ['finish_7', 'finish_8', 'finish_9', 'finish_10'].reduce((u, k) => u + e.outcomes[k].count, 0)));
  T.chk('playoffs = finish 1-6 + play-in qualifiers: seed 7 and 8 come only from the play-in', res.every((e) => e.outcomes.seed_7.count + e.outcomes.seed_8.count <= e.outcomes.play_in.count));
  T.chk('regular-season first place and the conference title are different outcomes (some club has one without the other)', res.some((e) => e.outcomes.finish_1.count !== e.outcomes.win_conference.count));
  T.eq('every outcome has its own settlement semantic', new Set(Object.values(NBA_OUTCOME_SEMANTICS)).size, NBA_OUTCOMES.length);
  T.chk('... conference first place, the conference title, the play-in and playoff qualification are four', new Set(['finish_1', 'win_conference', 'play_in', 'make_playoffs'].map((k) => NBA_OUTCOME_SEMANTICS[k])).size === 4);
}

/* 5 2025-26 frozen in the first round: everything already played is kept */
{
  const d = R.data;
  const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
  const done = d.postseason_rows.filter((g) => g.done);
  T.eq('the replay is frozen after the regular season and the play-in, during the first round', [d.games.every((g) => g.done), done.filter((g) => g.stage === 'play_in').length, done.length > 6], [true, 6, true]);
  const m = nbaModule(d, { seed: 9n, sigma: SIG, observe: (ev) => { if (ev.phase === 'regular') regular++; else seen.push(ev); } });
  let regular = 0; const seen: any[] = [];
  const agg = runRange(m, { start: 0, end: 400, traceRuns: [0, 1] });
  const res = summarise(m, agg); const by = new Map(res.map((e) => [e.entity_id, e]));
  T.eq('no regular-season game is simulated', regular, 0);
  T.chk('no play-in game is simulated', seen.every((e) => e.round !== 'play_in'));
  const playIn = new Set(done.filter((g) => g.stage === 'play_in').flatMap((g) => [g.home, g.away]));
  const playoffs = new Set(done.filter((g) => g.stage === 'playoffs').flatMap((g) => [g.home, g.away]));
  T.chk('the 8 play-in clubs have play-in 100%, the rest 0%', res.every((e) => e.outcomes.play_in.probability === (playIn.has(e.entity_id) ? 1 : 0)));
  T.chk('the 16 clubs that played first-round games qualify in every run, the others never', playoffs.size === 16 && res.every((e) => e.outcomes.make_playoffs.probability === (playoffs.has(e.entity_id) ? 1 : 0)));
  T.chk('every seed is fixed (each club one seed with 100%)', res.filter((e) => playoffs.has(e.entity_id)).every((e) => Array.from({ length: 8 }, (_, i) => e.outcomes['seed_' + (i + 1)].probability).filter((p) => p === 1).length === 1));
  /* a series resumes after its observed games, at the right venue, and ends at four wins */
  const pairs = new Map<string, { n: number; hosts: string[] }>();
  for (const g of done.filter((x) => x.stage === 'playoffs')) { const k = [g.home, g.away].sort().join('-'); const p = pairs.get(k) || { n: 0, hosts: [] }; p.n++; p.hosts.push(g.home); pairs.set(k, p); }
  let resumeBad = 0, nResumed = 0;
  for (const ev of seen.filter((e) => e.run === 0 && e.round === 'first_round')) {
    const k = [d.teams[ev.home].code, d.teams[ev.away].code].sort().join('-'); const p = pairs.get(k)!;
    if (!p) { resumeBad++; continue; }
    if (ev.game_no <= p.n) resumeBad++; else nResumed++;
  }
  T.chk('first-round series resume after their observed games, never re-playing one (' + nResumed + ' simulated games in run 0)', resumeBad === 0 && nResumed > 0, resumeBad);
  /* the series in the trace: hosts follow 2-2-1-1-1 from the home-court club, the winner has exactly four wins */
  let patternBad = 0, endBad = 0, nSeries = 0;
  for (const tr of agg.traces) {
    const ser = (tr.events.find((e: any) => e.type === 'series') as any).series as any[];
    for (const [round, high, low, winner, len, seq] of ser) {
      nSeries++;
      const games = String(seq).split(' ');
      games.forEach((g: string, i: number) => { const host = g.slice(0, -1); if ((host === high) !== hostsGame(NBA_2021, round, i + 1)) patternBad++; });
      const wins = (c: string) => games.filter((g: string) => (g.endsWith('W') ? g.slice(0, -1) : (g.slice(0, -1) === high ? low : high)) === c).length;
      if (wins(winner) !== 4 || wins(winner === high ? low : high) > 3 || len !== games.length || len < 4 || len > 7) endBad++;
    }
  }
  T.chk('traced series: every game at the venue the 2-2-1-1-1 order names (' + nSeries + ' series)', patternBad === 0 && nSeries === 30, patternBad);
  T.chk('traced series: each ends the game a club reaches four wins', endBad === 0, endBad);
  const ob = agg.traces[0].events.find((e: any) => e.type === 'series') as any;
  const det = ob.series.find((s: any) => s[0] === 'first_round' && (s[1] === 'DET' || s[2] === 'DET'));
  const real = done.filter((g) => g.stage === 'playoffs' && (g.home === 'DET' || g.away === 'DET'));
  T.eq('the DET-ORL series starts with the games as played', String(det[5]).split(' ').slice(0, real.length), real.map((g) => g.home + ((g.home_score as number) > (g.away_score as number) ? 'W' : 'L')));
  const status = nbaMathStatus(d);
  T.chk('a finished regular season: every division title and top-6 place is decided', Object.values(status).every((s) => s.division != null && s.top6 != null && s.top10 != null));
}

/* 6 return trajectories: a degenerate distribution returns the player at exactly that game */
{
  const d = clone(L.data);
  const team = d.teams.find((t) => d.availability.teams[t.code].tracked.length > 0)!.code;
  const A = d.availability.teams[team];
  A.tracked = A.tracked.slice(0, 1); A.subsets = { net: A.subsets.net.slice(0, 2), full: A.subsets.full.slice(0, 2) };
  A.tracked[0].dist = { periods: [{ period: 5, probability: 1 }], out_for_season: 0, source: 'TEST' };
  for (const t of d.teams) if (t.code !== team) { d.availability.teams[t.code].tracked = []; d.availability.teams[t.code].subsets = { net: [d.availability.teams[t.code].subsets.net[0]], full: [d.availability.teams[t.code].subsets.full[0]] }; }
  const ti = d.teams.findIndex((t) => t.code === team);
  const games: Array<{ n: number; shift: number; mu: number; model: any; home: boolean }> = [];
  const byId = new Map(d.games.map((g) => [g.game_id, g]));
  let count = 0;
  const m = nbaModule(d, { seed: 2n, sigma: 0, observe: (ev) => { if (ev.run !== 0 || ev.phase !== 'regular') return; if (ev.home === ti || ev.away === ti) { count++; games.push({ n: count, shift: ev.avail_shift, mu: ev.mu, model: byId.get(ev.game)!.model, home: ev.home === ti }); } } });
  runRange(m, { start: 0, end: 1 });
  const dn = A.subsets.net[1] - A.subsets.net[0], df = A.subsets.full[1] - A.subsets.full[0];
  const want = (g: typeof games[0]) => (g.home ? 1 : -1) * (g.model.s_plr * g.model.pace * dn / 100 + g.model.s_adj * g.model.pace * (dn - df) / 100);
  T.chk(team + ': no shift before the return game (games 1-4)', games.slice(0, 4).every((g) => g.shift === 0), games.slice(0, 4).map((g) => g.shift));
  T.chk(team + ': from game 5 on, the served player model\'s value of his return through the pricing slopes', games.slice(4).every((g) => Math.abs(g.shift - want(g)) < 1e-12) && games.slice(4).some((g) => g.shift !== 0), games.slice(4, 7).map((g) => [g.shift, want(g)]));
  A.tracked[0].dist = { periods: [], out_for_season: 1, source: 'TEST' };
  let any = false;
  runRange(nbaModule(d, { seed: 2n, sigma: 0, observe: (ev) => { if (ev.avail_shift !== 0) any = true; } }), { start: 0, end: 3 });
  T.chk('out for the season: never a shift', !any);
  /* the live fixture's own plans: a return is drawn in some runs and not others */
  const tr = runRange(nbaModule(L.data, { seed: 4n, sigma: SIG }), { start: 0, end: 5, traceRuns: [0, 1, 2, 3, 4] }).traces;
  const draws = tr.flatMap((t) => (t.events.find((e: any) => e.type === 'returns') as any).players as any[]);
  T.chk('live fixture: tracked absences draw return games (some within the season, some never)', draws.some((x) => x[2] != null) && draws.some((x) => x[2] == null), draws.length);
}

/* 7 the simulator prices exactly what the slate publishes (recorded when the fixture was built from the slate's own data) */
{
  const sc = (L.meta as any).slate_check;
  T.chk('the fixture records the slate check (' + (sc ? sc.games.length : 0) + ' games of nba/roster_inputs.json)', !!sc && sc.games.length >= 10);
  T.chk('every slate game\'s mean equals the slate\'s published baseline to 1e-9', !!sc && sc.games.every((g: any) => Math.abs(g.slate_mu - g.snapshot_mu) < 1e-9), sc && sc.games.slice(0, 3));
}

/* 8 validation fails closed */
{
  const ok = (s: NbaSnapshot, o = {}) => validateNbaInputs(s, { ignoreCodeDrift: true, ...o });
  const blocked = (gs: ReturnType<typeof ok>, id: string) => gs.some((g) => g.id === id && g.status === 'FAIL' && g.blocks === 'simulation');
  T.chk('the replay fixture passes every input gate but the facts (it has a calibrated sigma, a complete season)', ok(R).every((g) => g.status === 'PASS'), ok(R).filter((g) => g.status !== 'PASS'));
  const live = ok(L);
  T.chk('live: the incomplete schedule blocks the simulation', blocked(live, 'schedule.complete'));
  const liveDry = ok(L, { allowIncompleteSchedule: true }).find((g) => g.id === 'schedule.complete')!;
  T.eq('live, --allow-incomplete-schedule: a WARN that blocks publication', [liveDry.status, liveDry.blocks], ['WARN', 'publication']);
  let s = clone(R); s.data.games.find((g) => g.done)!.home_score = s.data.games.find((g) => g.done)!.away_score;
  T.chk('a completed game without a winner blocks', blocked(ok(rehash(s)), 'results.completed'));
  s = clone(L); s.data.games.find((g) => !g.done)!.model = null;
  T.chk('a remaining game without a price blocks', blocked(ok(rehash(s), { allowIncompleteSchedule: true }), 'model.every_remaining_game'));
  s = clone(R); s.data.strength = null;
  T.chk('no strength study blocks', blocked(ok(rehash(s)), 'strength.calibrated'));
  s = clone(R); const pg = s.data.postseason_rows.find((g) => g.done && g.stage === 'playoffs')!; const h = pg.home; pg.home = pg.away; pg.away = h; const hs = pg.home_score; pg.home_score = pg.away_score; pg.away_score = hs;
  T.chk('a completed playoff game hosted by the wrong club blocks (postseason.observed_fit)', blocked(ok(rehash(s)), 'postseason.observed_fit'));
  s = clone(R); delete s.data.postseason_pairs[contextKey('finals', 'finals', 3)]['BOS'];
  T.chk('a missing postseason pair blocks', blocked(ok(rehash(s)), 'model.postseason_pairs'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nba-sim-'));
  /* the CLI checks code identity: the replay fixture is re-stamped with today's code, as a fresh snapshot would be */
  const fresh = clone(R); fresh.data.code_sha256 = codeHashes();
  writeSnapshot(path.join(tmp, 's.json'), rehash(fresh)); const raw = JSON.parse(fs.readFileSync(path.join(tmp, 's.json'), 'utf8')); raw.data.games[0].home_score += 1; fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify(raw));
  T.throws('a snapshot edited after it was built is refused', () => readSnapshot(path.join(tmp, 'bad.json')), /hash mismatch/);
  /* the command line, on the replay fixture: a dry run that is never publishable while the sport is BLOCKED */
  const quiet = () => {};
  const o = await execute(parseArgs(['--snapshot', path.join(tmp, 's.json'), '--runs', '2000', '--workers', '2', '--dry-run', '--out', path.join(tmp, 'out')]), quiet);
  T.chk('CLI replay dry run: results, gates and manifest written', ['results.json', 'gates.json', 'manifest.json', 'snapshot.json'].every((f) => fs.existsSync(path.join(tmp, 'out', f))));
  T.chk('CLI: NOT publishable (sport.active and run.count block publication)', !o.publishable && o.gates.some((g) => g.id === 'sport.active' && g.blocks === 'publication') && o.gates.some((g) => g.id === 'run.count' && g.blocks === 'publication'));
  T.chk('CLI: the results carry each outcome\'s settlement semantic', (o.results as any).outcome_semantics && (o.results as any).outcome_semantics.win_conference === 'conference_playoff_championship');
  T.throws('CLI: --as-of with --publish is refused', () => parseArgs(['--sport', 'nba', '--publish', '--as-of', '2026-04-25']), /dry runs only/);
  T.throws('CLI: --allow-incomplete-schedule for the NFL is refused', () => parseArgs(['--sport', 'nfl', '--allow-incomplete-schedule']), /NBA only/);
  T.eq('CLI: the NBA season defaults to its end year (2026-27 = 2027)', parseArgs(['--sport', 'nba']).season, 2027);
  T.chk('CLI: an NBA snapshot replay may carry --allow-incomplete-schedule (the sport comes from the file)', (() => { try { parseArgs(['--snapshot', 'x.json', '--allow-incomplete-schedule', '--dry-run']); return true; } catch (_) { return false; } })());
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* 9 futures: an outcome maps only to a market that settles on the same thing */
{
  const results = { run: { sport: 'nba', competition: 'NBA', season: '2025-26' }, outcome_semantics: NBA_OUTCOME_SEMANTICS,
    entities: [{ entity_id: 'OKC', outcomes: Object.fromEntries(NBA_OUTCOMES.map((o) => [o.key, { probability: 0.5, mcse: 0.01 }])) }] };
  const run = runView(results);
  T.chk('the markets step reads the outcome semantics from the results', !!run.outcome_semantics && run.outcome_semantics.finish_1 === 'regular_season_conference_first_place');
  const cfg = (m: Partial<Mapping>): FuturesConfig => ({ schema: 'edgedesk_sim_kalshi_futures_v1', mapping_version: 't',
    thresholds: { max_quote_age_minutes: 30, max_reference_spread: 0.06, max_normalization_skew_minutes: 10, exec_quantity: 10, min_exec_edge_pp: 3, min_edge_mcse_multiple: 4 },
    fees: { verified: false, kind: 'taker', formula: 'x', rate: 0.07, source: 'x', verified_by: null, verified_at: null }, outcome_sets: [],
    mappings: [{ mapping_id: 'm1', status: 'verified', sport: 'nba', competition: 'NBA', season: '2025-26', series_ticker: 'S', event_ticker: 'E', market_ticker: 'M', entity_id: 'OKC', outcome: 'win_conference',
      settlement: { basis: 'SYNTHETIC', rules_sha256: 'a'.repeat(64), semantic: 'conference_playoff_championship' }, verified_by: 'test', verified_at: '2026-10-23', ...m } as Mapping] });
  T.eq('a conference-champion market mapped to the conference title validates', validateFuturesConfig(cfg({}), run), []);
  T.chk('the same market mapped to regular-season first place is refused', validateFuturesConfig(cfg({ outcome: 'finish_1' }), run).some((e) => /a different futures market/.test(e)));
  T.chk('a play-in market mapped to playoff qualification is refused', validateFuturesConfig(cfg({ outcome: 'make_playoffs', settlement: { basis: 'SYNTHETIC', rules_sha256: 'a'.repeat(64), semantic: 'play_in_tournament_participation' } }), run).some((e) => /a different futures market/.test(e)));
  T.chk('a mapping that declares no semantic is refused for the NBA', validateFuturesConfig(cfg({ settlement: { basis: 'SYNTHETIC', rules_sha256: 'a'.repeat(64) } }), run).some((e) => /no semantic declared/.test(e)));
  T.chk('two outcomes declaring one semantic are refused', validateFuturesConfig(cfg({}), { ...run, outcome_semantics: { ...run.outcome_semantics, play_in: 'playoff_qualification_after_play_in' } }).some((e) => /the same settlement semantic/.test(e)));
}

process.exit(T.done());
