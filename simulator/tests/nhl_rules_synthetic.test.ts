/* NHL standings, tiebreakers, bracket and series on hand-built SYNTHETIC
   leagues: points accounting, overtime- and shootout-loss treatment, every
   tiebreak step (regulation wins, ROW, wins, head-to-head with the odd game
   excluded, three clubs without a restart, goal differential, goals for, the
   coin), wild-card placement with crossover, home ice and series state.
   node simulator/tests/nhl_rules_synthetic.test.ts */
import { kit } from './_kit.ts';
import {
  NhlLeague, NhlStandings, NHL_TB_2019, NHL_TB_2014, buildBracket, playPostseason, seriesHome, resultCode,
  HOME_REG, HOME_OT, HOME_SO, AWAY_REG, AWAY_OT, AWAY_SO, type NhlTeam, type GameGoals, type PlayoffGameSpec
} from '../src/sports/nhl/rules.ts';
import { NHL_TEAMS_2027 } from '../src/sports/nhl/config.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';
import { drawRegScore } from '../src/sports/nhl/model_adapter.ts';

const T = kit('NHL rules, synthetic branches (SYNTHETIC fixtures)');
const club = (code: string, division = 'Atlantic'): NhlTeam => ({ code, name: code, division, conference: division === 'Atlantic' || division === 'Metropolitan' ? 'Eastern' : 'Western' });
/** a league from [home, away, result, home goals, away goals] rows; days in row order */
function league(codes: string[], rows: Array<[string, string, number, number?, number?]>) {
  const teams = codes.map((c) => club(c));
  const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
  const L = new NhlLeague(teams, rows.map(([h, a], k) => ({ home: ix[h], away: ix[a], day: 100 + k })));
  const results = Int8Array.from(rows.map((r) => r[2]));
  const goals: GameGoals = { home: Int16Array.from(rows.map((r) => r[3] ?? (r[2] < 3 ? 3 : 1))), away: Int16Array.from(rows.map((r) => r[4] ?? (r[2] < 3 ? 1 : 3))) };
  const diags: Record<string, number> = {}, flags = new Set<string>();
  const make = (rules = NHL_TB_2019, rng: any = streamFor(1n, 0, STREAM.coin)) => new NhlStandings(L, rules, results, () => goals, { rng, diag: (k, n) => { diags[k] = (diags[k] || 0) + (n ?? 1); }, flag: (k) => flags.add(k) });
  const codesOf = (xs: number[]) => xs.map((i) => teams[i].code);
  return { L, teams, ix, make, codesOf, diags, flags };
}

/* ---- 1 points accounting: 2 a win (any kind), 1 an OT or shootout loss, 0 a regulation loss ---- */
{
  const S = league(['A', 'B', 'C'], [['A', 'B', HOME_REG], ['B', 'C', HOME_OT, 2, 1], ['C', 'A', HOME_SO, 4, 3], ['A', 'C', AWAY_REG], ['B', 'A', AWAY_OT, 2, 3], ['C', 'B', AWAY_SO, 3, 4]]);
  const st = S.make(), [A, B, C] = [0, 1, 2];
  T.eq('A: 5 points (regulation win, OT win, shootout loss, regulation loss)', [st.pts[A], st.w[A], st.rw[A], st.row[A], st.otl[A], st.l[A]], [5, 2, 1, 2, 1, 1]);
  T.eq('B: 5 points (OT win, shootout win, OT loss, regulation loss); the shootout win is not a ROW', [st.pts[B], st.w[B], st.rw[B], st.row[B], st.otl[B], st.l[B]], [5, 2, 0, 1, 1, 1]);
  T.eq('C: 6 points (two wins, an OT loss and a shootout loss each worth 1)', [st.pts[C], st.w[C], st.rw[C], st.row[C], st.otl[C], st.l[C]], [6, 2, 1, 1, 2, 0]);
  T.eq('league points = 2 x games + one per game past regulation (6 games, 4 past 60 minutes)', st.pts[A] + st.pts[B] + st.pts[C], 2 * 6 + 4);
  T.eq('an OT or shootout loss is a loss, never a win: wins sum to the games played', st.w[A] + st.w[B] + st.w[C], 6);
  T.eq('A beats B on regulation wins (tied on 5 points)', S.codesOf(st.rankTop([A, B, C], 3, 't')), ['C', 'A', 'B']);
  const g = st.goals()!;
  T.eq('official goals: the shootout winner is credited one goal (C 4-3 over A, B 4-3 at C)', [g.gf[C], g.ga[C]], [1 + 4 + 3 + 3, 2 + 3 + 1 + 4]);
  T.eq('resultCode maps REG/OT/SO and the winner', [resultCode('REG', true), resultCode('OT', true), resultCode('SO', true), resultCode('REG', false), resultCode('OT', false), resultCode('SO', false)], [HOME_REG, HOME_OT, HOME_SO, AWAY_REG, AWAY_OT, AWAY_SO]);
  T.throws('an unknown decision is refused', () => resultCode('TIE', true), /unknown decision/);
}
/* ---- 2 regulation wins first (2019-20 on) vs ROW first (2013-14 .. 2018-19) ---- */
{
  /* X: two OT wins and a regulation loss (4 pts, RW 0, ROW 2); Y: a regulation win and two shootout losses (4 pts, RW 1, ROW 1); 3 games each */
  const S = league(['X', 'Y', 'Z'], [['X', 'Z', HOME_OT, 2, 1], ['Z', 'X', AWAY_OT, 1, 2], ['X', 'Z', AWAY_REG], ['Y', 'Z', HOME_REG], ['Z', 'Y', HOME_SO, 3, 2], ['Y', 'Z', AWAY_SO, 2, 3]]);
  const [X, Y, Z] = [0, 1, 2];
  const s19 = S.make(NHL_TB_2019), s14 = S.make(NHL_TB_2014);
  T.eq('X and Y tied on points in the same number of games', [s19.pts[X], s19.pts[Y], s19.gp[X], s19.gp[Y]], [4, 4, 3, 3]);
  T.eq('NHL-TB-2019: Y ahead on regulation wins (1 to 0)', S.codesOf(s19.rankTop([X, Y, Z], 3, 't')), ['Z', 'Y', 'X']);
  T.eq('NHL-TB-2014: X ahead on regulation + overtime wins (2 to 1)', S.codesOf(s14.rankTop([X, Y, Z], 3, 't')), ['Z', 'X', 'Y']);
}
/* ---- 3 ROW then total wins (a shootout win counts only at step 4) ---- */
{
  /* P: regulation win + shootout win (4 pts, RW 1, ROW 1, W 2); Q: regulation win + 2 OT losses (4 pts, RW 1, ROW 1, W 1) */
  const S = league(['P', 'Q', 'F'], [['P', 'F', HOME_REG], ['P', 'F', HOME_SO, 2, 1], ['Q', 'F', HOME_REG], ['Q', 'F', AWAY_OT, 1, 2], ['F', 'Q', HOME_OT, 2, 1], ['F', 'P', HOME_REG]]);
  const st = S.make();
  T.eq('equal on points, RW and ROW', [st.pts[0], st.pts[1], st.rw[0], st.rw[1], st.row[0], st.row[1]], [4, 4, 1, 1, 1, 1]);
  T.eq('P ahead on total wins (2 to 1): the shootout win counts here', S.codesOf(st.rankTop([0, 1], 2, 't')), ['P', 'Q']);
  T.chk('the wins step decided it', S.diags['tb:wins'] === 1);
}
/* ---- 4 head-to-head with the odd game excluded ---- */
{
  /* A and B meet three times: at A (A wins), at B (B wins), at A (A wins in OT). A had the extra home game, so the
     FIRST game at A does not count: A 2 points, B 3 (a win and an OT loss). With it, A would lead 4-3. Filler games
     (B an OT win over F, A an OT loss to F) leave A and B equal on points, RW, ROW and wins. */
  const S = league(['A', 'B', 'F'], [['A', 'B', HOME_REG], ['B', 'A', HOME_REG], ['A', 'B', HOME_OT, 3, 2], ['B', 'F', HOME_OT, 2, 1], ['A', 'F', AWAY_OT, 1, 2]]);
  const st = S.make(), [A, B] = [0, 1];
  T.eq('A and B equal through total wins', [st.pts[A], st.pts[B], st.rw[A], st.rw[B], st.row[A], st.row[B], st.w[A], st.w[B]], [5, 5, 1, 1, 2, 2, 2, 2]);
  T.eq('the odd game is the first one played at A (the city with the extra game)', S.L.excluded.get(S.L.key(A, B)), [0]);
  T.eq('head-to-head points without the odd game: A 2 of 4, B 3 of 4', [st.h2h(A, [A, B]), st.h2h(B, [A, B])], [[2, 4], [3, 4]]);
  T.eq('B ranks ahead on head-to-head (it would not if the odd game counted)', S.codesOf(st.rankTop([A, B], 2, 't')), ['B', 'A']);
  const even = new NhlLeague([club('A'), club('B')], [{ home: 0, away: 1, day: 1 }, { home: 1, away: 0, day: 2 }]);
  T.eq('an even home split excludes nothing', even.excluded.get(even.key(0, 1)), []);
}
/* ---- 5 three clubs at head-to-head: percentage among the tied clubs, no restart ---- */
{
  /* P, Q, R tied through wins. Among the three: P 6/8, Q 4/8, R 4/8 -> P first; Q and R stay tied (Q beat R twice, so a
     restart would put Q ahead) and go on to goal differential, where R leads. Filler games vs F equalise the totals. */
  const rows: Array<[string, string, number, number?, number?]> = [
    ['P', 'Q', HOME_REG, 3, 1], ['Q', 'P', AWAY_REG, 1, 3],          // P beats Q twice
    ['P', 'R', AWAY_OT, 2, 3], ['R', 'P', HOME_OT, 3, 2],            // R beats P twice in OT
    ['Q', 'R', HOME_REG, 2, 1], ['R', 'Q', AWAY_REG, 1, 2],          // Q beats R twice
    ['P', 'F', HOME_OT, 2, 1], ['P', 'F', HOME_OT, 2, 1], ['F', 'P', HOME_REG, 2, 0], ['F', 'P', HOME_REG, 2, 0],
    ['Q', 'F', HOME_OT, 2, 1], ['Q', 'F', HOME_OT, 2, 1], ['F', 'Q', HOME_SO, 2, 1], ['F', 'Q', HOME_SO, 2, 1],
    ['R', 'F', HOME_REG, 9, 0], ['R', 'F', HOME_REG, 9, 0], ['F', 'R', HOME_SO, 2, 1], ['F', 'R', HOME_SO, 2, 1]
  ];
  const S = league(['P', 'Q', 'R', 'F'], rows);
  const st = S.make(), [P, Q, R] = [0, 1, 2];
  T.eq('P, Q, R equal on points, RW, ROW, wins and games played', [P, Q, R].map((t) => [st.pts[t], st.rw[t], st.row[t], st.w[t], st.gp[t]]), [[10, 2, 4, 4, 8], [10, 2, 4, 4, 8], [10, 2, 4, 4, 8]]);
  T.eq('head-to-head among the three, as a share of points available: 6/8, 4/8, 4/8', [P, Q, R].map((t) => st.h2h(t, [P, Q, R])), [[6, 8], [4, 8], [4, 8]]);
  T.eq('P first; Q and R continue to goal differential (no restart) where R leads', S.codesOf(st.rankTop([P, Q, R], 3, 't')), ['P', 'R', 'Q']);
  T.chk('the partial three-club head-to-head split is counted (tb:head_to_head_partial)', S.diags['tb:head_to_head_partial'] === 1 && S.diags['tb:goal_differential'] === 1);
}
/* ---- 6 goal differential, goals for, then the seeded coin (counted); only reported places are broken ---- */
{
  const tie = (hg: number[], ag: number[]) => league(['A', 'B', 'C'], [['A', 'C', HOME_REG, hg[0], ag[0]], ['B', 'C', HOME_REG, hg[1], ag[1]], ['C', 'A', HOME_REG, hg[2], ag[2]], ['C', 'B', HOME_REG, hg[3], ag[3]], ['A', 'B', HOME_REG, hg[4], ag[4]], ['B', 'A', HOME_REG, hg[5], ag[5]]]);
  const gd = tie([5, 3, 2, 2, 2, 2], [1, 1, 1, 1, 1, 1]);
  T.eq('goal differential decides A (+5) over B (+3)', gd.codesOf(gd.make().rankTop([0, 1], 2, 't')), ['A', 'B']);
  const gf = tie([5, 4, 2, 2, 2, 2], [1, 0, 1, 1, 1, 1]);
  const sgf = gf.make(); const gg = sgf.goals()!;
  T.eq('equal goal differential (+4 each over the A-C and B-C games)...', gg.gf[0] - gg.ga[0], gg.gf[1] - gg.ga[1]);
  T.eq('... goals for decides', gf.codesOf(sgf.rankTop([0, 1], 2, 't')), gf.codesOf(gg.gf[0] > gg.gf[1] ? [0, 1] : [1, 0]));
  const all = tie([3, 3, 2, 2, 2, 2], [1, 1, 1, 1, 1, 1]);
  const o1 = all.codesOf(all.make().rankTop([0, 1], 2, 't'));
  T.chk('identical on every step: the seeded coin decides, and the run is flagged', all.flags.has('tiebreak_coin') && all.diags['tb:coin'] === 1 && o1.length === 2);
  const o2 = all.codesOf(all.make(NHL_TB_2019, streamFor(1n, 0, STREAM.coin)).rankTop([0, 1], 2, 't'));
  T.eq('the same coin stream gives the same order', o2, o1);
  T.throws('without a coin stream such a tie is an error, not a silent order', () => all.make(NHL_TB_2019, null).rankTop([0, 1], 2, 't'), /beyond the last tiebreak step/);
  /* C beats A and B; A and B split, identical on every step below C */
  const part = league(['A', 'B', 'C'], [['C', 'A', HOME_REG, 3, 1], ['B', 'C', AWAY_REG, 1, 3], ['A', 'B', HOME_REG, 3, 1], ['B', 'A', HOME_REG, 3, 1]]);
  const top1 = part.make().rankTop([0, 1, 2], 1, 't');
  T.chk('a ranking asked for 1 place: C (first on points) is first, the A-B tie below it is never broken', part.codesOf(top1)[0] === 'C' && !part.flags.has('tiebreak_coin') && !part.flags.has('tiebreak_goals'));
  part.make().rankTop([0, 1, 2], 3, 't');
  T.chk('asked for all 3 places, the same tie goes to goals and then the coin', part.flags.has('tiebreak_goals') && part.flags.has('tiebreak_coin'));
}
/* ---- 7 the bracket: division top three, crossover wild cards, the better division winner meets WC2 ---- */
const teams = NHL_TEAMS_2027;
const ixOf: Record<string, number> = {}; teams.forEach((t, i) => { ixOf[t.code] = i; });
/** a single round robin in which the better-ranked club always wins in regulation: distinct points = 2 x clubs below */
function ranked(order: string[]) {
  if (new Set(order).size !== 32) throw new Error('order must name all 32 clubs');
  const games: Array<{ home: number; away: number; day: number }> = [], res: number[] = [];
  let day = 0;
  for (let i = 0; i < 32; i++) for (let j = i + 1; j < 32; j++) {
    const a = ixOf[order[i]], b = ixOf[order[j]];
    const home = (i + j) % 2 ? a : b;
    games.push({ home, away: home === a ? b : a, day: day++ });
    res.push(home === a ? HOME_REG : AWAY_REG);
  }
  const L = new NhlLeague(teams, games);
  return new NhlStandings(L, NHL_TB_2019, Int8Array.from(res), () => null, { rng: null });
}
const ORDER = ['CAR', 'COL', 'WSH', 'DAL', 'NJD', 'WPG', 'NYR', 'MIN', 'NYI', 'VGK', 'TOR', 'EDM', 'TBL', 'LAK', 'FLA', 'STL', 'BOS', 'UTA', 'OTT', 'NSH', 'MTL', 'SEA', 'BUF', 'CGY', 'DET', 'ANA', 'PIT', 'VAN', 'PHI', 'SJS', 'CBJ', 'CHI'];
{
  const st = ranked(ORDER);
  const code = (i: number) => teams[i].code;
  const e = buildBracket(st, 'Eastern');
  T.eq('Metropolitan top three: CAR, WSH, NJD', e.divisionTop.Metropolitan.map(code), ['CAR', 'WSH', 'NJD']);
  T.eq('Atlantic top three: TOR, TBL, FLA', e.divisionTop.Atlantic.map(code), ['TOR', 'TBL', 'FLA']);
  T.eq('both wild cards cross over from the Metropolitan, ahead of the Atlantic winner on points: WC1 NYR, WC2 NYI', e.wildCards.map(code), ['NYR', 'NYI']);
  T.eq('the better division winner (CAR) meets WC2 (NYI); the other (TOR) meets WC1 (NYR); D2 v D3 in each division', e.round1.map(([a, b]) => code(a) + '-' + code(b)), ['CAR-NYI', 'WSH-NJD', 'TOR-NYR', 'TBL-FLA']);
  T.eq('conference best record = the better division winner', code(e.first), 'CAR');
  const w = buildBracket(st, 'Western');
  T.eq('Western round 1 (both wild cards from the Central; MIN crosses to the Pacific half)', w.round1.map(([a, b]) => code(a) + '-' + code(b)), ['COL-STL', 'DAL-WPG', 'VGK-MIN', 'EDM-LAK']);
  T.eq('Western wild cards', w.wildCards.map(code), ['MIN', 'STL']);
  T.eq('the Presidents\' Trophy club (CAR) is the league\'s best record', code(st.rankTop(teams.map((_, i) => i), 1, 'p')[0]), 'CAR');
  /* the postseason with chosen winners: NYR (WC1, more points than FLA) meets FLA (D3) in round 2 */
  const pick: Record<string, string> = { 'CAR-NYI': 'CAR', 'NJD-WSH': 'WSH', 'NYR-TOR': 'NYR', 'FLA-TBL': 'FLA', 'CAR-WSH': 'CAR', 'FLA-NYR': 'NYR', 'CAR-NYR': 'NYR',
    'COL-STL': 'COL', 'DAL-WPG': 'DAL', 'MIN-VGK': 'VGK', 'EDM-LAK': 'EDM', 'COL-DAL': 'COL', 'EDM-VGK': 'VGK', 'COL-VGK': 'COL', 'COL-NYR': 'NYR' };
  const calls: PlayoffGameSpec[] = [];
  const res = playPostseason(st, (g) => { calls.push(g); const k = [code(g.home), code(g.away)].sort().join('-'); const w = pick[k]; if (!w) throw new Error('no pick ' + k); return { winner: ixOf[w], ot: false }; });
  const ser = (a: string, b: string) => res.series.find((s) => [code(s.hi), code(s.lo)].sort().join('-') === [a, b].sort().join('-'))!;
  T.eq('round 1: the division winner hosts the wild card even with fewer points (TOR over NYR)', code(ser('TOR', 'NYR').hi), 'TOR');
  T.eq('round 2: the D3 club hosts the wild card even with fewer points (FLA over NYR)', code(ser('FLA', 'NYR').hi), 'FLA');
  T.eq('conference final: the better record hosts (CAR over NYR)', code(ser('CAR', 'NYR').hi), 'CAR');
  T.eq('Stanley Cup Final: the better record hosts (COL over NYR)', code(ser('COL', 'NYR').hi), 'COL');
  T.eq('15 series, champion NYR, finalists NYR and COL', [res.series.length, code(res.champion), res.reached.final.map(code).sort()], [15, 'NYR', ['COL', 'NYR']]);
  T.chk('every series is best of seven: 4 wins, 4-7 games', res.series.every((s) => s.games.filter((g) => g.winner === s.winner).length === 4 && s.games.length >= 4 && s.games.length <= 7));
  T.chk('reached sets: 8 in round 2, 4 in conference finals, 2 in the Final', res.reached.round2.length === 8 && res.reached.conferenceFinal.length === 4 && res.reached.final.length === 2);
}
/* ---- 8 series: 2-2-1-1-1 and the actual state ---- */
{
  T.eq('2-2-1-1-1: games 1, 2, 5, 7 at the club with home ice', [1, 2, 3, 4, 5, 6, 7].map((n) => seriesHome(10, 20, n)), [10, 10, 20, 20, 10, 20, 10]);
  const st = ranked(ORDER);
  const [CAR, NYI, WSH, NJD] = ['CAR', 'NYI', 'WSH', 'NJD'].map((c) => ixOf[c]);
  /* observed: NYI leads CAR 3-0 (games 1-2 at CAR, game 3 at NYI); WSH beat NJD 4-1 (finished) */
  const observed = [
    { a: CAR, b: NYI, home: CAR, winner: NYI, ot: false, day: 1 }, { a: CAR, b: NYI, home: CAR, winner: NYI, ot: true, day: 3 }, { a: NYI, b: CAR, home: NYI, winner: NYI, ot: false, day: 5 },
    { a: WSH, b: NJD, home: WSH, winner: WSH, ot: false, day: 1 }, { a: WSH, b: NJD, home: WSH, winner: NJD, ot: false, day: 3 }, { a: NJD, b: WSH, home: NJD, winner: WSH, ot: false, day: 5 },
    { a: NJD, b: WSH, home: NJD, winner: WSH, ot: true, day: 7 }, { a: WSH, b: NJD, home: WSH, winner: WSH, ot: false, day: 9 }
  ];
  const calls: PlayoffGameSpec[] = [];
  const homeWins = (g: PlayoffGameSpec) => { calls.push(g); return { winner: g.home, ot: false }; };
  const res = playPostseason(st, homeWins, { observed });
  const s1 = res.series.find((s) => s.hi === CAR && s.lo === NYI)!;
  T.eq('a 3-0 series continues at game 4 at the trailing club\'s opponent (NYI hosts game 4)', calls.filter((c) => (c.hi === CAR && c.lo === NYI)).map((c) => [c.game, teams[c.home].code]), [[4, 'NYI']]);
  T.eq('the observed games are kept exactly (winners, venues, OT), then NYI wins game 4 at home', s1.games.map((g) => [g.game, teams[g.home].code, teams[g.winner].code, g.ot, g.observed]), [[1, 'CAR', 'NYI', false, true], [2, 'CAR', 'NYI', true, true], [3, 'NYI', 'NYI', false, true], [4, 'NYI', 'NYI', false, false]]);
  const s2 = res.series.find((s) => s.hi === WSH && s.lo === NJD)!;
  T.chk('a finished series (WSH 4-1) is never re-simulated', calls.every((c) => !(c.hi === WSH && c.lo === NJD)) && s2.winner === WSH && s2.games.every((g) => g.observed));
  T.chk('both observed winners reach round 2', res.reached.round2.includes(NYI) && res.reached.round2.includes(WSH));
  const sched = playPostseason(st, homeWins, { scheduled: [{ a: CAR, b: NYI, home: NYI, game: 1 }] });
  T.eq('a scheduled game\'s listed venue is used (game 1 listed at NYI)', teams[sched.series.find((s) => s.hi === CAR && s.lo === NYI)!.games[0].home].code, 'NYI');
  T.throws('observed games past a decided series are refused', () => playPostseason(st, homeWins, { observed: observed.concat([{ a: WSH, b: NJD, home: NJD, winner: NJD, ot: false, day: 11 }]) }), /past a decided series/);
  const [PIT, PHI] = ['PIT', 'PHI'].map((c) => ixOf[c]);
  T.throws('an observed series the standings\' bracket does not contain is refused (two clubs out of the playoffs)', () => playPostseason(st, homeWins, { observed: [{ a: PIT, b: PHI, home: PIT, winner: PIT, ot: false, day: 1 }] }), /not in the bracket/);
  T.throws('a resolver naming a club not in the game is refused', () => playPostseason(st, () => ({ winner: -1, ot: false })), /not in the game/);
}
/* ---- 9 the shootout credit in drawn scores: a tied 60 minutes, the winner +1 ---- */
{
  const m = new Float64Array(13 * 13); m[2 * 13 + 2] = 0.5; m[3 * 13 + 3] = 0.25; m[3 * 13 + 1] = 0.25;
  T.eq('a 60-minute tie draws only from the diagonal', drawRegScore(m, 2, 0.9), [3, 3]);
  T.eq('a home regulation win draws only above the diagonal', drawRegScore(m, 0, 0.1), [3, 1]);
  T.throws('a class without mass is refused', () => drawRegScore(m, 1, 0.5), /no regulation mass/);
}
process.exit(T.done());
