/* The NBA Cup inside the simulation, on the committed 2026-27 snapshot (simulator/fixtures): the gates that let
   the season run before the league schedules its 30 Cup-dependent games, every run's Cup (the knockout field,
   the hosts, the non-advancing clubs' two games, 82 games per club), the Cup's outcomes and their sums,
   reproducibility across workers, the overtime draw, and SYNTHETIC later stages: Group Play over and the
   quarterfinals and non-advancing games on the schedule (only the semifinals and the losers' games simulated),
   then every game on it.  node simulator/tests/nba_cup_sim.test.ts */
import { kit } from './_kit.ts';
import { nbaFixture } from './_nba_fixture.ts';
import { nbaModule, NBA_CUP_OUTCOMES } from '../src/sports/nba/module.ts';
import { runRange, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { validateNbaInputs } from '../src/sports/nba/validate.ts';
import { cupStandings, quarterfinals, fillerGames, type CupStructure } from '../src/sports/nba/cup.ts';
import { NbaGameDist } from '../src/sports/nba/game_dist.ts';
import { nbaModules } from '../src/sports/nba/model_adapter.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';
import type { NbaInputData, NbaInputGame } from '../src/sports/nba/inputs.ts';

const T = kit('NBA Cup simulation');
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const L = nbaFixture('live');
const SIG = 3;
const gate = (d: NbaInputData, id: string) => validateNbaInputs({ schema: L.schema, input_hash: '', data: d, meta: L.meta }, { ignoreCodeDrift: true }).find((g) => g.id === id)!;

/* 1 the gates: the season runs with the Cup-dependent games simulated */
{
  const d = L.data, cup = d.cup!;
  T.chk('the snapshot carries the 2026-27 Cup: six groups, 60 Group Play games, nothing posted yet', !!cup && !cup.error && cup.groups.length === 6 && cup.group_games.length === 60 && cup.posted.length === 0 && cup.championship === null);
  const sc = gate(d, 'schedule.complete');
  T.chk('schedule.complete passes: 1,200 on the schedule + 30 simulated from the Cup\'s format', sc.status === 'PASS' && /1200 regular-season games on the schedule \+ 30 NBA Cup-dependent games simulated/.test(sc.detail), sc);
  T.eq('cup.structure and model.cup_pairs pass', [gate(d, 'cup.structure').status, gate(d, 'model.cup_pairs').status], ['PASS', 'PASS']);
  T.chk('... 2,805 Cup pairings priced', /2805 NBA Cup pairings priced/.test(gate(d, 'model.cup_pairs').detail));
  T.chk('every slot is priced after the as-of time and in the Cup\'s order', Object.values(cup.slot_start).every((s, i, a) => Date.parse(s) > Date.parse(d.as_of) && (i === 0 || s >= a[i - 1])));
  const bad = clone(d); bad.cup!.pairs.semifinal.BOS.NY = undefined as any;
  T.eq('a missing Cup price fails the gate', gate(bad, 'model.cup_pairs').status, 'FAIL');
  const noCup = clone(d); noCup.cup = null;
  T.eq('without the Cup the 1,200-game schedule is incomplete again', gate(noCup, 'schedule.complete').status, 'FAIL');
}

/* 2 every run's Cup */
{
  const d = L.data, teams = d.teams;
  const runs = 400;
  const per: Array<Record<string, Array<{ home: number; away: number }>>> = [];
  const m = nbaModule(d, { seed: 41n, sigma: SIG, observe: (ev) => {
    if (ev.phase !== 'cup') return;
    const kind = ev.game.split('|')[1];
    const r = (per[ev.run] = per[ev.run] || {}); (r[kind] = r[kind] || []).push({ home: ev.home, away: ev.away });
  } });
  const agg = runRange(m, { start: 0, end: runs, traceRuns: [0, 1, 2] });
  T.eq('no run reaches the Cup\'s total-points step without a game\'s points (every simulated Group Play game has them)', agg.flags.cup_total_points_unmodelled || 0, 0);
  T.chk('every run plays 4 quarterfinals, 22 non-advancing games, 2 semifinals, 2 losers\' games and the Championship, all simulated', per.length === runs && per.every((r) => r.quarterfinal.length === 4 && r.filler.length === 22 && r.semifinal.length === 2 && r.losers.length === 2 && r.championship.length === 1));
  let homeOk = true, koOk = true, crossOk = true, confOk = true;
  for (const r of per) {
    const ko = new Set(r.quarterfinal.flatMap((g) => [g.home, g.away]));
    const g2 = new Array(30).fill(0), h2 = new Array(30).fill(0);
    for (const g of r.filler) { g2[g.home]++; g2[g.away]++; h2[g.home]++; if (ko.has(g.home) || ko.has(g.away)) koOk = false; }
    for (let t = 0; t < 30; t++) if (!ko.has(t) && (g2[t] !== 2 || h2[t] !== 1)) homeOk = false;
    if (r.filler.filter((g) => teams[g.home].conference !== teams[g.away].conference).length !== 2) crossOk = false;
    for (const g of r.quarterfinal.concat(r.semifinal, r.losers)) if (teams[g.home].conference !== teams[g.away].conference) confOk = false;
    const sf = r.semifinal.flatMap((g) => [g.home, g.away]), lo = r.losers.flatMap((g) => [g.home, g.away]);
    if (![...ko].every((t) => (sf.includes(t) ? 1 : 0) + (lo.includes(t) ? 1 : 0) === 1)) koOk = false;
    if (teams[r.championship[0].home].conference !== 'East' || teams[r.championship[0].away].conference !== 'West') confOk = false;
  }
  T.chk('each non-advancing club plays two of them, one at home; no knockout club plays one', homeOk && koOk);
  T.chk('exactly two cross-conference games a run; every knockout game within a conference; the Championship East v West', crossOk && confOk);
  /* the outcomes */
  const S = summarise(m, agg);
  const P = (o: string) => S.reduce((s: number, e) => s + e.outcomes[o].probability, 0);
  T.chk('the Cup outcomes are in the run: win group, knockout, semifinal, Championship, the Cup', NBA_CUP_OUTCOMES.every((o) => S[0].outcomes[o.key] != null));
  T.eq('their totals: 6 group winners, 8 knockout clubs, 4 semifinalists, 2 finalists, 1 winner', ['cup_win_group', 'cup_knockout', 'cup_semifinal', 'cup_final', 'cup_champion'].map((o) => Math.round(P(o) * 1e9) / 1e9), [6, 8, 4, 2, 1]);
  T.chk('a club\'s Cup outcomes nest: champion <= finalist <= semifinalist <= knockout; group winner <= knockout', S.every((e) => { const o = e.outcomes, q = (k: string) => o[k].probability; return q('cup_champion') <= q('cup_final') && q('cup_final') <= q('cup_semifinal') && q('cup_semifinal') <= q('cup_knockout') && q('cup_win_group') <= q('cup_knockout'); }));
  T.chk('every club carries its Cup group as a label', m.entities.every((e) => /^(East|West) group [123] \(/.test(e.groups.cup_group)));
  T.chk('the trace shows the run\'s Cup (seeds, games, champion, the 30 virtual games)', agg.traces.length === 3 && agg.traces.every((t) => t.events.some((e: any) => e.type === 'cup' && e.virtual.length === 30 && e.seeds.length === 2)));
  T.chk('Cup diagnostics count the virtual games', agg.diags['cup:quarterfinal:virtual'] === 4 * runs && agg.diags['cup:filler:virtual'] === 22 * runs && agg.diags['cup:championship:virtual'] === runs);
}

/* 3 reproducibility and worker independence with the Cup */
{
  const a = runRange(nbaModule(L.data, { seed: 5n, sigma: SIG }), { start: 0, end: 300 });
  const b = runRange(nbaModule(L.data, { seed: 5n, sigma: SIG }), { start: 0, end: 300 });
  T.eq('the same seed gives the same counts, the Cup included', a.counts, b.counts);
  const w1 = await runPlan({ sport: 'nba', data: L.data, seed: 9n, runs: 600, workers: 1, traceRuns: [], sigma: SIG });
  const w3 = await runPlan({ sport: 'nba', data: L.data, seed: 9n, runs: 600, workers: 3, traceRuns: [], sigma: SIG });
  T.eq('1 worker and 3 workers give identical counts', w1.agg.counts, w3.agg.counts);
}

/* 4 the overtime draw: the served P(overtime | margin), averaged over the served margins, is the served P(overtime) */
{
  const dist = new NbaGameDist(L.data.model);
  for (const mu of [0, 4.5]) {
    const rs = streamFor(1n, 0, STREAM.cup); let s = 0; const N = 20000;
    const pH = dist.pHome(mu);
    for (let i = 0; i < N; i++) { const mg = dist.drawMargin(mu, rs.nextOpen() < pH, rs.nextOpen()); s += dist.pOvertime(mu, mg); }
    const pot = nbaModules().DIST.marginals(dist.params(Math.round(mu * 10) / 10)).p_ot;
    T.near('mean P(overtime | margin) at mu ' + mu + ' is the served P(overtime) ' + pot.toFixed(4), s / N, pot, 0.004);
  }
  T.chk('a blowout almost never went to overtime', dist.pOvertime(0, 25) < 0.001 && dist.pOvertime(0, 1) > 0.1);
  /* a simulated Group Play game's regulation points: the served total given the regulation margin */
  const id = Object.keys(L.data.cup!.group_totals)[0], tot = L.data.cup!.group_totals[id], g = L.data.games.find((x) => x.game_id === id)!;
  const rs = streamFor(6n, 0, STREAM.cup), N = 40000, mu = g.model!.mu, pH = dist.pHome(mu);
  let s = 0, s2 = 0, bad = 0;
  for (let i = 0; i < N; i++) {
    const mg = dist.drawMargin(mu, rs.nextOpen() < pH, rs.nextOpen()), ot = rs.nextOpen() < dist.pOvertime(mu, mg);
    const [h, a] = dist.regulationPoints(mu, mg, ot, tot, rs.nextOpen()), T2 = h + a; s += T2; s2 += T2 * T2;
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || (ot ? h !== a : h - a !== mg)) bad++;
  }
  const mean = s / N, sd = Math.sqrt(s2 / N - mean * mean);
  T.chk('regulation points: the margin is the final margin (level after an overtime), integers, every draw', bad === 0, bad);
  T.near('... their mean total is the served mu_t (' + tot.mu_t.toFixed(1) + ')', mean, tot.mu_t, 0.5);
  T.near('... their spread the served sd_t (' + tot.sd_t.toFixed(2) + ', plus the 2-point bins)', sd, Math.sqrt(tot.sd_t * tot.sd_t + 1 / 3), 0.4);
  T.eq('every remaining Group Play game carries its served total', Object.keys(L.data.cup!.group_totals).length, L.data.cup!.group_games.filter((x) => !L.data.games.find((y) => y.game_id === x)!.done).length);
}

/* 5 SYNTHETIC later stages: Group Play over (every group game final), the league's quarterfinals and
   non-advancing games on the schedule */
{
  const d = clone(L.data), cup = d.cup!;
  const ix: Record<string, number> = {}; d.teams.forEach((t, i) => { ix[t.code] = i; });
  const byId = new Map(d.games.map((g) => [g.game_id, g]));
  let n = 0;
  for (const id of cup.group_games) {
    const g = byId.get(id)!; n++;
    const homeWins = n % 3 !== 0, mg = 2 + (n % 11);
    g.done = true; g.home_score = homeWins ? 100 + mg : 100; g.away_score = homeWins ? 100 : 100 + mg; g.model = null;
    cup.group_results[id] = { ot: false, reg_home: g.home_score, reg_away: g.away_score };
  }
  const groups = cup.groups.map((x) => x.map((c) => ix[c]));
  const groupOf = new Array(30).fill(-1); groups.forEach((x, i) => x.forEach((t) => { groupOf[t] = i; }));
  const st: CupStructure = { groups, groupOf, groupConf: groups.map((x) => (d.teams[x[0]].conference === 'East' ? 0 : 1)) };
  const cs = cupStandings(st, 30, cup.group_games.map((id) => { const g = byId.get(id)!; return { home: ix[g.home], away: ix[g.away], margin: (g.home_score as number) - (g.away_score as number), ot: false, regHome: g.home_score, regAway: g.away_score }; }),
    d.teams.map((t) => cup.prior_record[t.code]), { rng: streamFor(0n, 0, STREAM.cup), diag() {}, flag() {} });
  const add = (id: string, date: string, h: number, a: number, slot: 'quarterfinal' | 'filler_1' | 'filler_2'): NbaInputGame => {
    const g: NbaInputGame = { game_id: id, date, start_utc: date + 'T23:00:00Z', home: d.teams[h].code, away: d.teams[a].code, neutral: false, city: null, done: false, home_score: null, away_score: null, model: cup.pairs[slot][d.teams[h].code][d.teams[a].code] };
    d.games.push(g); cup.posted.push(id); return g;
  };
  const qf = quarterfinals(cs);
  qf.forEach((q, i) => add('test-qf-' + i, '2026-12-0' + (4 + (i % 2)), q.home, q.away, 'quarterfinal'));
  const ko = new Set(cs.seeds.flat());
  const base = new Int32Array(900); d.games.forEach((g) => { if (cup.posted.includes(g.game_id)) return; base[ix[g.home] * 30 + ix[g.away]]++; base[ix[g.away] * 30 + ix[g.home]]++; });
  const fg = fillerGames({ others: cs.places.map((p) => p.slice(4)), need: d.teams.map((_, t) => (ko.has(t) ? 0 : 2)), homeNeed: d.teams.map((_, t) => (ko.has(t) ? 0 : 1)), cross: 2,
    preferred: (a, b) => base[a * 30 + b] === 3, playing: () => false, km: (a, b) => cup.cross_km[d.teams[d.teams[a].conference === 'East' ? a : b].code][d.teams[d.teams[a].conference === 'East' ? b : a].code], maxKm: 2500, rng: streamFor(2n, 0, STREAM.cup), diag() {} });
  fg.forEach((g, i) => add('test-fill-' + i, g.slot === 1 ? '2026-12-06' : '2026-12-09', g.home, g.away, g.slot === 1 ? 'filler_1' : 'filler_2'));
  T.eq('synthetic: 26 posted Cup-dependent games (4 quarterfinals, 22 non-advancing)', cup.posted.length, 26);
  const sc = gate(d, 'schedule.complete'), cg = gate(d, 'cup.structure');
  T.chk('synthetic: the gates pass, 4 games still simulated', sc.status === 'PASS' && /\+ 4 NBA Cup-dependent games simulated/.test(sc.detail) && cg.status === 'PASS', [sc.detail, cg.detail]);
  const kinds: Record<string, number> = {};
  const m = nbaModule(d, { seed: 8n, sigma: SIG, observe: (ev) => { if (ev.phase === 'cup') { const k = ev.game.split('|')[1]; kinds[k] = (kinds[k] || 0) + 1; } } });
  const runs = 200, agg = runRange(m, { start: 0, end: runs });
  T.eq('synthetic: only the semifinals, the losers\' games and the Championship are simulated', kinds, { semifinal: 2 * runs, losers: 2 * runs, championship: runs });
  T.eq('synthetic: the posted quarterfinals and non-advancing games are the run\'s (diagnostics)', [agg.diags['cup:quarterfinal:scheduled'], agg.diags['cup:filler:virtual'] || 0], [4 * runs, 0]);
  const S = summarise(m, agg);
  const pr = (c: string, o: string) => S.find((e) => e.entity_id === c)!.outcomes[o].probability;
  T.chk('synthetic: Group Play over, the knockout field is certain', d.teams.every((t, i) => pr(t.code, 'cup_knockout') === (ko.has(i) ? 1 : 0)));
  /* a posted game that does not fit the real Group Play results is refused */
  const bad = clone(d), q0 = bad.games.find((g) => g.game_id === 'test-qf-0')!, other = d.teams.find((t, i) => !ko.has(i) && t.conference === d.teams[ix[q0.home]].conference)!;
  q0.away = other.code;
  T.eq('synthetic: a posted quarterfinal against a club that did not advance fails cup.structure', gate(bad, 'cup.structure').status, 'FAIL');
  const early = clone(L.data); early.games.push({ ...clone(d.games.find((g) => g.game_id === 'test-qf-0')!) }); early.cup!.posted.push('test-qf-0');
  T.eq('synthetic: a posted Cup-dependent game before Group Play is over fails cup.structure', gate(early, 'cup.structure').status, 'FAIL');
}

process.exit(T.done());
