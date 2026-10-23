/* Tennis draws and matches:
   - the rating (elo.ts): the price and its symmetry, best of five through the set, the step and the
     games-share target on SYNTHETIC matches, duplicate rows merged, walkovers and placeholders left out
   - the draw as a tree (draw.ts): round levels from the final, a SYNTHETIC completed draw rebuilt from who
     advanced, the reasons a draw is refused
   - Wikipedia's draw (wiki_draw.ts): a SYNTHETIC article with a Finals bracket, two halves and byes; an
     article not filled in
   - the order confirmed against ESPN (inputs.ts drawFromArticle): a qualifier placed opposite their ESPN
     opponent, a wrong article, a draw ESPN has barely listed, a result that does not fit; the late rounds
   - the module on a SYNTHETIC draw: the shares converge to the exact bracket calculation, results and byes
     respected, sum rules, the next match's price, determinism and worker-count independence; the day's
     matches
   - the committed data: the study and backtest meet the activation conditions, the current draws build
     offline and pass their gates; the registry, the plan and the CLI carry tennis
   node simulator/tests/tennis_sim.test.ts */
import { kit } from './_kit.ts';
import { expect3, price, setFromBo3, bo5FromSet, bestOf, walk, loadMatches, dedupeFeed, target, ELO_538, type TennisEloConfig, type FeedMatch } from '../src/sports/tennis/elo.ts';
import { buildTree, roundLevels, entrants, isMainRound, type DrawMatch } from '../src/sports/tennis/draw.ts';
import { parseWikiDraw, readLine } from '../src/sports/tennis/wiki_draw.ts';
import { drawFromArticle, drawFromLateRounds, matchName, buildTennisSnapshots, type TennisDrawData } from '../src/sports/tennis/inputs.ts';
import { tennisModule, matchesModule, exactReach, OUTCOMES, type TennisModuleData } from '../src/sports/tennis/module.ts';
import { tennisActivation } from '../src/sports/tennis/activation.ts';
import { validateTennisInputs, executeTennis } from '../src/sports/tennis/run.ts';
import { runRange, summarise } from '../src/core/engine.ts';
import { runPlan } from '../src/core/runner.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns, NIGHTLY, RUNNABLE } from '../src/cli/plan.ts';
import { parseArgs } from '../src/cli/run.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const K = kit('tennis draw simulation');
const cfg: TennisEloConfig = { ...ELO_538, k_num: 400, k_exp: 0.5, mov_weight: 1, mov_stretch: 1.5, bo5_convert: true };

/* ---------------------------------------------------------------- the rating */
K.near('price: 200 points up is 76% (scale 400)', expect3(cfg, 1700, 1500), 1 / (1 + 10 ** -0.5), 1e-12);
K.near('price: symmetric in the two players', price(cfg, 1620, 1480, 3) + price(cfg, 1480, 1620, 3), 1, 1e-12);
K.near('best of five: the set chance makes the best-of-three price', ((s) => s * s * (3 - 2 * s))(setFromBo3(0.7)), 0.7, 1e-9);
K.chk('best of five: a favourite is more likely to win over five sets, an even match stays even', bo5FromSet(setFromBo3(0.7)) > 0.7 && Math.abs(price(cfg, 1500, 1500, 5) - 0.5) < 1e-9);
K.eq('best of five only in a men\'s Grand Slam main draw', [bestOf('ATP', 'Wimbledon', 'Round 1'), bestOf('ATP', 'Wimbledon', 'Qualifying 1st Round'), bestOf('WTA', 'Wimbledon', 'Final'), bestOf('ATP', 'Swiss Indoors Basel', 'Final')], [5, 3, 3, 3]);
const fm = (id: string, tid: string, at: string, a: string, b: string, winner: 'a' | 'b' | null, sets: number[][], extra: Partial<FeedMatch> = {}): FeedMatch =>
  ({ id, tid, tournament: 'SYNTHETIC Open', tour: 'ATP', grouping: "Men's Singles", round: 'Round 1', at, a_id: a, a: 'P' + a, a_seed: null, b_id: b, b: 'P' + b, b_seed: null, status: 'final', result: 'completed', winner,
    sets: sets.map((s) => [s[0], s[1], null, null]) as FeedMatch['sets'], ...extra });
{
  const rows = [fm('1', 't1', '2024-01-01T10:00Z', '10', '11', 'a', [[6, 0], [6, 0]]), fm('2', 't1', '2024-01-01T11:00Z', '12', '13', 'a', [[7, 6], [6, 7], [7, 6]]),
    fm('3', 't1', '2024-01-02T10:00Z', '10', '12', null, [], { status: 'walkover', winner: 'a' }), fm('4', 't1', '2024-01-02T10:00Z', '-3', '-4', null, [], { status: 'scheduled' }),
    fm('5', 't1', '2024-01-01T10:00Z', '11', '10', 'b', [[0, 6], [0, 6]])];
  const { matches, dropped } = loadMatches({ matches: rows });
  K.eq('loadMatches: the walkover and the placeholder are left out, the duplicate merged', [matches.map((m) => m.id), dropped], [['1', '2'], { 'duplicate row (merged)': 1, 'not final': 1, walkover: 1 }]);
  K.chk('the games-share target: a 6-0 6-0 win is near 1, a match decided by a tiebreak near 1/2', target(cfg, matches[0]) > 0.99 && Math.abs(target(cfg, matches[1]) - 0.5) < 0.1);
  const S = walk(matches, cfg);
  K.near('the step: K = 400/(0+5)^0.5 for a first match, target minus expected', S.R.get('ATP:10')! - 1500, 400 / Math.sqrt(5) * (target(cfg, matches[0]) - 0.5), 1e-9);
  K.chk('symmetric: the loser falls by what the winner gained (equal steps)', Math.abs((S.R.get('ATP:10')! - 1500) + (S.R.get('ATP:11')! - 1500)) < 1e-9);
  K.eq('dedupe: played rows disagreeing on the winner are dropped whole', dedupeFeed([fm('7', 't', '2024-01-01T10:00Z', '1', '2', 'a', [[6, 0]]), fm('8', 't', '2024-01-01T10:00Z', '1', '2', 'b', [[6, 0]])]).conflicting, 1);
}

/* ---------------------------------------------------------------- the draw as a tree */
K.eq('round levels: a 32 draw (Round 1, Round 2, then the last three)', [...roundLevels(['Round 1', 'Round 2', 'Quarterfinal', 'Semifinal', 'Final']).level.entries()].sort((a, b) => a[1] - b[1]), [['Round 1', 2], ['Round 2', 3], ['Quarterfinal', 4], ['Semifinal', 5], ['Final', 6]]);
K.eq('round levels: a 128 draw starts at level 0', roundLevels(['Round 1', 'Round 2', 'Round 3', 'Round 4', 'Quarterfinal']).level.get('Round 1'), 0);
K.chk('round levels: a numbered round missing is refused', /Round 2 missing/.test(String(roundLevels(['Round 1', 'Round 3', 'Final']).reason)));
K.chk('qualifying is not a main round', !isMainRound('Qualifying Final') && isMainRound('Round 3') && isMainRound('Semifinal'));
/** a SYNTHETIC completed 8 draw: lines 1..8, the lower line always wins */
const eight = (): DrawMatch[] => {
  const ms: DrawMatch[] = [];
  const rounds = ['Quarterfinal', 'Semifinal', 'Final'];
  let cur = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], k = 0;
  for (const r of rounds) { const nxt: string[] = []; for (let j = 0; j < cur.length; j += 2) { ms.push({ id: 'm' + (k++), round: r, a: cur[j + 1], b: cur[j], winner: cur[j] }); nxt.push(cur[j]); } cur = nxt; }
  return ms;
};
{
  const t = buildTree(eight());
  K.eq('a completed draw rebuilds from who advanced: champion and entrants', [t.root && t.root.match.winner, t.root ? entrants(t.root).sort() : null], ['p1', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']]);
  K.chk('a draw with two finals is refused', /2 finals/.test(String(buildTree(eight().concat([{ id: 'x', round: 'Final', a: 'p9', b: 'p10', winner: 'p9' }])).reason)));
  K.chk('a player twice in one round is refused', /twice/.test(String(buildTree(eight().map((m, i) => (i === 1 ? { ...m, a: 'p1' } : m))).reason)));
}

/* ---------------------------------------------------------------- Wikipedia's draw */
const team = (k: number, name: string | null, seed = '') => '| RD1-seed' + String(k).padStart(2, '0') + '=' + seed + '\n| RD1-team' + String(k).padStart(2, '0') + '=' + (name ? '{{flagicon|SUI}} [[' + name + '|' + name.split(' ').pop() + ']]' : '{{flagicon|}}') + '\n';
const half = (names: Array<string | null>, byeAt: number | null, r2: string | null) => '{{8TeamBracket-Compact-Tennis3-Byes\n| RD1=First round\n'
  + names.map((n, i) => (byeAt != null && (i === byeAt || i === byeAt + 1) ? '' : team(i + 1, n, i === 0 ? '1' : ''))).join('') + (r2 ? '| RD2-seed01=1\n| RD2-team01={{flagicon|ESP}} [[' + r2 + '|X]]\n' : '') + '}}\n';
const article = (top: Array<string | null>, bottom: Array<string | null>, bye = true) => '==Seeds==\nsome\n==Draw==\n{{Draw key}}\n===Finals===\n{{4TeamBracket-Tennis3\n| RD1-team1=[[Somebody Else]]\n}}\n===Top half===\n'
  + half(top, bye ? 0 : null, bye ? top[0] : null) + '===Bottom half===\n' + half(bottom, null, null) + '==Qualifying==\n{{8TeamBracket-Compact-Tennis3\n| RD1-team01=[[Qualifier Person]]\n}}\n';
const TOP = ['Ann One', 'Bye', 'Cat Three', 'Dee Four', 'Eve Five', 'Fay Six', 'Gus Seven', 'Hal Eight'], BOT = ['Ivy Nine', 'Jo Ten', 'Kim Eleven', 'Lu Twelve', 'Mo Thirteen', 'Ned Fourteen', 'Oz Fifteen', 'Pia Sixteen'];
{
  const w = parseWikiDraw(article(TOP, BOT));
  K.eq('a draw article: 16 lines in order, the Finals bracket and qualifying left out, the bye read from the second round', [w.lines.length, w.lines.map((l) => (l.bye ? 'BYE' : l.name)).slice(0, 4), w.lines[15].name, w.reason, w.sections.map((s) => s.heading)], [16, ['Ann One', 'BYE', 'Cat Three', 'Dee Four'], 'Pia Sixteen', null, ['Top half', 'Bottom half']]);
  K.chk('a line\'s seed is read', w.lines[0].seed === '1');
  const empty = parseWikiDraw(article(TOP.map(() => null), BOT.map(() => null), false));
  K.chk('an article whose lines are not filled in says so', /not filled in/.test(String(empty.reason)) && empty.empty === 16);
  K.eq('a link\'s target is the name ("(tennis)" dropped); plain "Bye" is a bye', [readLine('[[Tommy Paul (tennis)|T Paul]]', '7').name, readLine('Bye', '').bye, readLine("'''{{flagicon|}}'''", '').name], ['Tommy Paul', true, null]);
}

/* ---------------------------------------------------------------- the order confirmed against ESPN */
/** ESPN's listing of the SYNTHETIC 16 draw (levels: Round 1 = 3, Round 2... wait: 16 lines -> Round 1 is level 3) */
const espnRows = (opts: { qualifierAt?: number; misfit?: boolean; few?: boolean } = {}): FeedMatch[] => {
  const names = TOP.concat(BOT), rows: FeedMatch[] = [];
  const id = (i: number) => String(100 + i);
  let k = 0;
  for (let j = 0; j < 16; j += 2) {
    if (names[j + 1] === 'Bye') continue;
    if (opts.few && j > 4) break;
    const a = j, b = opts.misfit && j === 2 ? 5 : j + 1;
    rows.push({ id: 'r' + (k++), tid: 't', tournament: 'SYNTHETIC Open', tour: 'ATP', grouping: "Men's Singles", round: 'Round 1', at: '2026-10-20T10:00Z', a_id: id(a), a: opts.qualifierAt === b ? 'Quinn Qualifier' : names[a], a_seed: null,
      b_id: opts.qualifierAt === b ? '999' : id(b), b: opts.qualifierAt === b ? 'Quinn Qualifier' : names[b], b_seed: null, status: 'final', result: 'completed', winner: 'a', sets: [[6, 3, null, null], [6, 3, null, null]] });
  }
  if (!opts.few) rows.push({ id: 'r2a', tid: 't', tournament: 'SYNTHETIC Open', tour: 'ATP', grouping: "Men's Singles", round: 'Round 2', at: '2026-10-21T10:00Z', a_id: id(0), a: names[0], a_seed: '1', b_id: id(2), b: names[2], b_seed: null, status: 'scheduled', result: null, winner: null, sets: [] });
  return rows;
};
const ctxOf = (rows: FeedMatch[]) => {
  const levels = roundLevels(['Round 1', 'Round 2', 'Quarterfinal', 'Semifinal', 'Final']).level;
  const ids = new Map<string, string>();
  for (const m of rows) { ids.set('ATP:' + m.a_id, m.a); ids.set('ATP:' + m.b_id, m.b); }
  return { main: rows, ids, levels, global: new Map(TOP.concat(BOT).map((n, i) => ['ATP:' + (100 + i), n] as [string, string])) };
};
{
  const lines = parseWikiDraw(article(TOP, BOT)).lines;
  /* our ESPN rounds are named for a 32 draw; the 16-line article puts Round 1 at level 3: rename to fit */
  const fix = (rows: FeedMatch[]) => rows.map((m) => ({ ...m, round: m.round === 'Round 1' ? 'Round 2' : m.round === 'Round 2' ? 'Quarterfinal' : m.round }));
  const c0 = ctxOf(fix(espnRows())); c0.levels = roundLevels(['Round 2', 'Quarterfinal', 'Semifinal', 'Final']).level; c0.levels.set('Round 2', 3);
  const o = drawFromArticle(lines, c0);
  K.chk('an article confirmed by ESPN: every line placed, the bye kept', 'lines' in o && o.lines.length === 16 && o.lines[1] === null && o.lines[0] === 'ATP:100' && o.byes === 1, o);
  const cq = ctxOf(fix(espnRows({ qualifierAt: 7 }))); cq.levels = c0.levels;
  const linesQ = lines.map((l, i) => (i === 7 ? { ...l, name: 'Qualifier', label: 'Qualifier' } : l));
  const oq = drawFromArticle(linesQ, cq);
  K.chk('a qualifier the article had not named goes on the line opposite their ESPN opponent', 'lines' in oq && oq.lines[7] === 'ATP:999' && oq.filled_from_espn.length === 1, oq);
  const cm = ctxOf(fix(espnRows({ misfit: true }))); cm.levels = c0.levels;
  K.chk('a listed match whose players are not opposite each other is refused', /does not fit|twice|not placed/.test(String((drawFromArticle(lines, cm) as any).reason)), drawFromArticle(lines, cm));
  const cf = ctxOf(fix(espnRows({ few: true }))); cf.levels = c0.levels;
  K.chk('an article ESPN has barely listed cannot be confirmed', /cannot be confirmed/.test(String((drawFromArticle(lines, cf) as any).reason)));
  const wrong = parseWikiDraw(article(TOP.map((n, i) => (i === 1 ? n : 'Zed Stranger' + i)), BOT.map((_, i) => 'Yan Other' + i))).lines;
  K.chk('the wrong tournament\'s article (its players are not ESPN\'s) is refused', /only \d+ of \d+ ESPN players/.test(String((drawFromArticle(wrong, c0) as any).reason)));
  K.eq('names: the same surname and first initial match when unique', matchName('Ann One', null, new Map([['x', 'A. One'], ['y', 'Bob One']])), 'x');
  const late: FeedMatch[] = [{ ...espnRows()[0], id: 's1', round: 'Semifinal', status: 'scheduled', winner: null }, { ...espnRows()[1], id: 's2', round: 'Semifinal', status: 'scheduled', winner: null }];
  const ol = drawFromLateRounds({ ...ctxOf(late), levels: roundLevels(['Semifinal', 'Final']).level });
  K.chk('from the semifinals on, ESPN\'s listing is the draw (four lines)', 'lines' in ol && ol.lines.length === 4 && ol.first_level === 5);
}

/* ---------------------------------------------------------------- the module */
const synthDraw = (): TennisModuleData => {
  /* 8 lines (first level 4: quarterfinals), line 2 a bye; ratings fall with the line; QF 2 decided (line 3 beat line 4 against the odds) */
  const lines = ['A', null, 'C', 'D', 'E', 'F', 'G', 'H'];
  const R: Record<string, number> = { A: 1900, C: 1600, D: 1750, E: 1700, F: 1650, G: 1620, H: 1580 };
  return { competition: 'atp-SYNTH', season: 2026, draw: { lines, first_level: 4, bo: 3, results: [{ level: 4, index: 1, winner: 'C', loser: 'D', match_id: 'q2', walkover: false, retired: false }] },
    players: Object.keys(R).map((id, i) => ({ id, name: 'Player ' + id, seed: null, entry: null, rating: R[id], n: 50, line: lines.indexOf(id), country: null })), elo: { config: cfg } };
};
{
  const d = synthDraw(), m = tennisModule(d, { seed: 11n }), N = 60000;
  const agg = runRange(m, { start: 0, end: N, traceRuns: [0] }), res = summarise(m, agg);
  const ex = exactReach(d);
  const share = (id: string, k: string) => agg.counts[m.entities.findIndex((e) => e.id === id) * OUTCOMES.length + OUTCOMES.findIndex((o) => o.key === k)] / N;
  let worst = 0;
  for (const id of ['A', 'C', 'E', 'F', 'G', 'H']) for (const [k, lv] of [['win_title', 7], ['reach_final', 6], ['reach_semifinal', 5]] as Array<[string, number]>) {
    const p = ex.get(id)![lv], se = Math.sqrt(Math.max(p * (1 - p), 1e-9) / N);
    worst = Math.max(worst, Math.abs(share(id, k) - p) / se);
  }
  K.chk('SYNTHETIC: every share is the exact bracket calculation within 4.5 standard errors (worst ' + worst.toFixed(2) + ')', worst < 4.5);
  K.eq('SYNTHETIC: the bye: A reaches the semifinals in every run; the decided quarterfinal: D never does, C always', [share('A', 'reach_semifinal'), share('D', 'reach_semifinal'), share('C', 'reach_semifinal')], [1, 0, 1]);
  K.chk('SYNTHETIC: everyone reached the quarterfinals (the first round here)', ['A', 'C', 'D', 'E', 'H'].every((id) => share(id, 'reach_quarterfinal') === 1));
  K.eq('SYNTHETIC: the sum rules (checked after every run: runRange throws on a violation): one champion, two finalists, four semifinalists, seven quarterfinalists (a bye)', m.sumRules.map((r) => r.outcome + ':' + r.perGroup), ['win_title:1', 'reach_final:2', 'reach_semifinal:4', 'reach_quarterfinal:7']);
  K.eq('SYNTHETIC: the summary keeps every player', res.length, 7);
  const pEF = price(cfg, 1700, 1650, 3);
  K.near('SYNTHETIC: E\'s next match (the quarterfinal v F) is won at the rating\'s price', share('E', 'win_next_match'), pEF, 4.5 * Math.sqrt(pEF * (1 - pEF) / N));
  K.near('SYNTHETIC: A\'s next match is the semifinal (after the bye): won at the bracket\'s exact rate', share('A', 'win_next_match'), ex.get('A')![6], 4.5 * Math.sqrt(ex.get('A')![6] * (1 - ex.get('A')![6]) / N));
  K.chk('SYNTHETIC: the trace records only matches left to play', agg.traces[0].events.length > 0 && agg.traces[0].events.every((t: any) => t.ev === 'match' && !(t.level === 4 && t.index === 1)));
  const a2 = runRange(tennisModule(synthDraw(), { seed: 11n }), { start: 0, end: 5000 });
  const a1 = runRange(m, { start: 0, end: 5000 });
  K.eq('the same seed and data give identical counts', a1.counts, a2.counts);
  const w1 = await runPlan({ sport: 'tennis', data: synthDraw(), seed: 3n, runs: 6000, workers: 1, traceRuns: [] }), w3 = await runPlan({ sport: 'tennis', data: synthDraw(), seed: 3n, runs: 6000, workers: 3, traceRuns: [] });
  K.chk('one worker and three workers give byte-identical aggregates', JSON.stringify(w1.agg.counts) === JSON.stringify(w3.agg.counts));
  K.throws('a draw whose lines are not a power of two is refused', () => tennisModule({ ...synthDraw(), draw: { ...synthDraw().draw, lines: ['A', 'C', 'D'] } }, { seed: 1n }), /power of two/);
  K.throws('a result outside the draw is refused', () => tennisModule({ ...synthDraw(), draw: { ...synthDraw().draw, results: [{ level: 4, index: 9, winner: 'C', loser: null, match_id: 'x', walkover: false, retired: false }] } }, { seed: 1n }), /outside the draw/);
}
{
  const md = { competition: 'matches', season: 2026, matches: [{ id: '1', a: { id: 'ATP:1', name: 'One' }, b: { id: 'ATP:2', name: 'Two' }, p_a: 0.7 }, { id: '2', a: { id: 'WTA:3', name: 'Three' }, b: { id: 'WTA:4', name: 'Four' }, p_a: 0.25 }] };
  const m = matchesModule(md, { seed: 5n }), N = 40000, agg = runRange(m, { start: 0, end: N });
  K.near('the day\'s matches: each winner at its price (match 1)', agg.counts[0] / N, 0.7, 4 * Math.sqrt(0.21 / N));
  K.near('the day\'s matches: each winner at its price (match 2)', agg.counts[2] / N, 0.25, 4 * Math.sqrt(0.1875 / N));
  K.eq('the day\'s matches: one winner per match in every run', agg.counts[0] + agg.counts[1], N);
}

/* ---------------------------------------------------------------- the committed data */
const study = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'tennis_elo_study.json'), 'utf8'));
K.chk('the committed study and backtest meet the activation conditions (tennis ACTIVE)', tennisActivation().status === 'ACTIVE', tennisActivation().blockers);
K.chk('the activation conditions bite: a study no better than FiveThirtyEight\'s blocks tennis', (() => { const s = JSON.parse(JSON.stringify(study)); s.holdout.ATP.vs_538.ci95 = [-0.001, 0.002]; const a = tennisActivation(s); return a.status === 'BLOCKED' && a.blockers.some((b) => /FiveThirtyEight/.test(b)); })());
K.chk('the activation conditions bite: a calibration error above 0.03 blocks tennis', tennisActivation({ ...study, ece_bins_30: 0.05 }).status === 'BLOCKED');
const built = await buildTennisSnapshots({ offline: true });
const draws = built.snapshots.filter((s) => s.data.kind === 'draw');
K.chk('committed data: at least one draw builds offline, each with its order\'s source', draws.length >= 1 && draws.every((s) => ['wikipedia', 'espn_late_rounds'].includes((s.data as TennisDrawData).order.source)), built.skipped);
K.chk('committed data: every draw passes its simulation gates', draws.every((s) => validateTennisInputs(s, Date.parse(s.data.as_of) + 3600e3).filter((g) => g.blocks === 'simulation').length === 0));
K.chk('committed data: every skipped draw says why', built.skipped.every((x) => x.reason.length > 5));
K.chk('committed data: a draw\'s exact title chances sum to 1', draws.every((s) => Math.abs(Object.values((s.data as TennisDrawData).exact).reduce((a, v) => a + v[7], 0) - 1) < 1e-4));
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-sim-'));
  const o = await executeTennis({ season: 2026, runs: 4000, seed: '9', workers: 1, snapshot: null, out, traceRuns: [], offline: true, nowMs: Date.parse(built.snapshots[0].data.as_of) + 3600e3 }, () => {});
  K.chk('committed data: the run simulates every snapshot, its sum rules hold, only the run count blocks publication', o.runs.length === built.snapshots.length && o.runs.every((r) => r.gates.filter((g) => g.status === 'FAIL').every((g) => g.id === 'run.count')), o.runs.map((r) => r.gates.filter((g) => g.status === 'FAIL').map((g) => g.id + ': ' + g.detail)));
  K.chk('committed data: the run writes snapshot, results, gates and manifest per competition', o.runs.every((r) => ['snapshot.json', 'results.json', 'gates.json', 'manifest.json'].every((f) => fs.existsSync(path.join(r.outDir, f)))));
}
const reg = sportRegistry().find((s) => s.key === 'tennis')!;
K.chk('registry: tennis is ACTIVE with Draws, Matches and Model Health; its limitations never say "probability"', reg.status === 'ACTIVE' && reg.tabs.join() === 'draws,matches,model_health' && reg.limitations.length >= 4 && !/probability/i.test(JSON.stringify(reg)));
K.chk('the plan: tennis is runnable and nightly through its window', RUNNABLE.tennis === 2026 && NIGHTLY.includes('tennis') && planRuns('schedule', {}, undefined, new Date('2026-11-09T10:17:00Z')).some((r) => r.sport === 'tennis') && !planRuns('schedule', {}, undefined, new Date('2026-12-03T10:17:00Z')).some((r) => r.sport === 'tennis'));
K.eq('the CLI: --sport tennis defaults to the 2026 season', parseArgs(['--sport', 'tennis']).season, 2026);
process.exit(K.done());
