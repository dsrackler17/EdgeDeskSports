/* MLB rules, every branch the 2022-2025 history never reached (SYNTHETIC fixtures, built by hand here and
   never fed to production): each tiebreak step, the restart among the best, multi-club ties, the last-half
   window and its extension (which skips games between the tied clubs), a step that does not apply,
   exhaustion, qualification and seeding, byes, every series' length and host order (2-2-1, 2-3-2, the
   best-of-3 at the higher seed, 2012's 2-3), the World Series home field, and the refusals.
   Every fixture first asserts that its clubs ARE level, so no tiebreak assertion is vacuous. */
import { kit } from './_kit.ts';
import { teamsFor, formatFor } from '../src/sports/mlb/config.ts';
import { Season, Standings, qualify, playPostseason, playSeries, hostOf, worldSeriesHigher, UnsupportedTie, type SeriesSpec, type PlayedGame } from '../src/sports/mlb/rules.ts';
import { Xoshiro128 } from '../src/core/prng.ts';

const K = kit('MLB rules, synthetic branches (SYNTHETIC fixtures)');
const teams = teamsFor(2026);
const ix: Record<string, number> = {}; teams.forEach((t, i) => { ix[t.code] = i; });
const F22 = formatFor(2026);
type G = [string, string, 1 | -1];
const W = (h: string, a: string): G => [h, a, 1];          // the home club h beats a
const L = (h: string, a: string): G => [h, a, -1];         // the home club h loses to a

/** a SYNTHETIC season: one game per day, in the order given (the order is the chronology) */
function build(spec: G[], rng: Xoshiro128 | null = null, tm = teams) {
  const loc: Record<string, number> = {}; tm.forEach((t, i) => { loc[t.code] = i; });
  const S = new Season(tm, spec.map(([h, a], i) => ({ home: loc[h], away: loc[a], day: 20000 + i, game_no: 0 })));
  const diags: string[] = [];
  const st = new Standings(S, Int8Array.from(spec.map((x) => x[2])), { rng, diag: (k) => diags.push(k) });
  const rec = (c: string) => st.w[loc[c]] + '-' + st.l[loc[c]];
  const order = (cs: string[]) => st.breakTie(cs.map((c) => loc[c])).map((t) => tm[t].code);
  return { S, st, diags, rec, order };
}
const steps = (d: string[]) => d.filter((k) => k.startsWith('tiebreak:step:')).map((k) => k.slice(14));

/* 1 head-to-head */
{
  const f = build([W('NYA', 'TOR'), W('NYA', 'TOR'), L('NYA', 'TOR'), W('TOR', 'BOS'), L('NYA', 'BOS')]);
  K.eq('head-to-head fixture is level (2-2 / 2-2)', [f.rec('NYA'), f.rec('TOR')], ['2-2', '2-2']);
  K.eq('head-to-head: NYA 2-1 over TOR', f.order(['TOR', 'NYA']), ['NYA', 'TOR']);
  K.eq('decided at head-to-head', steps(f.diags), ['head_to_head']);
}
/* 2 intradivision */
{
  const f = build([W('NYA', 'TOR'), L('NYA', 'TOR'), W('NYA', 'BOS'), W('NYA', 'BAL'), W('TOR', 'BOS'), L('TOR', 'BAL'), W('TOR', 'CHN'), L('NYA', 'CHN')]);
  K.eq('intradivision fixture is level (3-2 / 3-2)', [f.rec('NYA'), f.rec('TOR')], ['3-2', '3-2']);
  K.eq('intradivision: NYA 3-1 v TOR 2-2 in division games (head-to-head 1-1)', f.order(['TOR', 'NYA']), ['NYA', 'TOR']);
  K.eq('decided at intradivision', steps(f.diags), ['intradivision']);
}
/* 3 interdivision games within the league */
{
  const f = build([W('NYA', 'TOR'), L('NYA', 'TOR'), W('NYA', 'BOS'), L('NYA', 'BOS'), W('TOR', 'BAL'), L('TOR', 'BAL'),
    W('NYA', 'HOU'), W('NYA', 'SEA'), W('TOR', 'HOU'), L('TOR', 'SEA'), W('TOR', 'ATL'), L('NYA', 'ATL')]);
  K.eq('interdivision fixture is level (4-3 / 4-3)', [f.rec('NYA'), f.rec('TOR')], ['4-3', '4-3']);
  K.eq('interdivision within the league: NYA 2-0 v TOR 1-1 (TOR\'s interleague win does not count)', f.order(['TOR', 'NYA']), ['NYA', 'TOR']);
  K.eq('decided at interdivision', steps(f.diags), ['interdivision_intraleague']);
}
/* 4 the last half of intraleague games (head-to-head and intradivision do not apply: no such games) */
{
  const f = build([W('TOR', 'HOU'), W('TOR', 'SEA'), L('NYA', 'HOU'), L('NYA', 'SEA'), L('TOR', 'TEX'), L('TOR', 'OAK'), W('NYA', 'TEX'), W('NYA', 'OAK')]);
  K.eq('last-half fixture is level (2-2 / 2-2), interdivision level too', [f.rec('NYA'), f.rec('TOR')], ['2-2', '2-2']);
  K.eq('last half (two games each): NYA 2-0 v TOR 0-2', f.order(['TOR', 'NYA']), ['NYA', 'TOR']);
  K.eq('head-to-head and intradivision passed over (not applicable), decided at the last half', steps(f.diags), ['last_half_intraleague']);
}
/* 5 the last half plus one, skipping games between the tied clubs */
{
  const spec: G[] = [L('NYA', 'HOU'), W('TOR', 'SEA'), W('NYA', 'TEX'), L('TOR', 'OAK'),     // first half, outside head-to-head
    W('NYA', 'TOR'), W('TOR', 'NYA'),                                                         // head-to-head 1-1, the last games of the first half
    W('NYA', 'ANA'), L('TOR', 'CHA'), L('NYA', 'CLE'), W('TOR', 'DET'), W('NYA', 'KCA'), L('TOR', 'MIN'), L('NYA', 'HOU'), W('TOR', 'SEA')];
  const f = build(spec);
  K.eq('plus-one fixture is level (4-4 / 4-4)', [f.rec('NYA'), f.rec('TOR')], ['4-4', '4-4']);
  const tied = [ix.NYA, ix.TOR];
  K.eq('every earlier step level: head-to-head 1-1, intradivision 1-1, interdivision 3-3, last half 2-2',
    [f.st.stepRecord('head_to_head', ix.NYA, tied), f.st.stepRecord('intradivision', ix.NYA, tied), f.st.stepRecord('interdivision_intraleague', ix.NYA, tied), f.st.stepRecord('last_half_intraleague', ix.NYA, tied),
     f.st.stepRecord('head_to_head', ix.TOR, tied), f.st.stepRecord('intradivision', ix.TOR, tied), f.st.stepRecord('interdivision_intraleague', ix.TOR, tied), f.st.stepRecord('last_half_intraleague', ix.TOR, tied)],
    [[1, 1], [1, 1], [3, 3], [2, 2], [1, 1], [1, 1], [3, 3], [2, 2]]);
  K.eq('plus one skips both head-to-head games and reaches NYA\'s win over TEX and TOR\'s loss to OAK', [f.st.lastIntraleague(ix.NYA, 1, tied), f.st.lastIntraleague(ix.TOR, 1, tied)], [[3, 2], [2, 3]]);
  K.eq('without the skip the next game back would be the head-to-head game TOR won', [f.st.lastIntraleague(ix.NYA, 1, [ix.NYA, ix.BOS]), f.st.lastIntraleague(ix.TOR, 1, [ix.TOR, ix.BOS])], [[2, 3], [3, 2]]);
  K.eq('last half plus one: NYA', f.order(['TOR', 'NYA']), ['NYA', 'TOR']);
  K.eq('decided at the last half plus one', steps(f.diags), ['last_half_plus']);
}
/* three clubs: combined head-to-head, one place per pass, the rest revert to step 1 (two-club head-to-head) */
{
  const f = build([W('NYA', 'TOR'), L('NYA', 'TOR'), W('NYA', 'BOS'), W('NYA', 'BOS'), W('TOR', 'BOS'), L('TOR', 'BOS'), L('TOR', 'BOS'),
    W('TOR', 'CHN'), W('BOS', 'ATL'), L('NYA', 'MIA'), L('NYA', 'WAS')]);
  K.eq('three-club fixture is level (3-3 each)', [f.rec('NYA'), f.rec('TOR'), f.rec('BOS')], ['3-3', '3-3', '3-3']);
  K.eq('combined head-to-head: NYA 3-1 first; then BOS 2-1 over TOR on their own games', f.order(['TOR', 'BOS', 'NYA']), ['NYA', 'BOS', 'TOR']);
}
/* restart among the best: two of three level at combined head-to-head; they restart at TWO-club head-to-head
   (a procedure that went on to intradivision with the two instead would put NYA first) */
{
  const f = build([W('TOR', 'NYA'), W('TOR', 'NYA'), W('NYA', 'TOR'), W('NYA', 'BOS'), W('NYA', 'BOS'), W('TOR', 'BOS'), L('TOR', 'BOS'),
    W('NYA', 'BAL'), L('TOR', 'BAL'), L('NYA', 'CHN'), W('TOR', 'ATL'), W('BOS', 'MIA'), W('BOS', 'WAS'), W('BOS', 'PHI')]);
  K.eq('restart fixture is level (4-3 each)', [f.rec('NYA'), f.rec('TOR'), f.rec('BOS')], ['4-3', '4-3', '4-3']);
  K.eq('combined head-to-head: NYA 3-2 and TOR 3-2 level, BOS 1-3 out', [ix.NYA, ix.TOR, ix.BOS].map((t) => f.st.stepRecord('head_to_head', t, [ix.NYA, ix.TOR, ix.BOS])), [[3, 2], [3, 2], [1, 3]]);
  K.eq('intradivision would favour NYA (4-2 v 3-3)', [f.st.stepRecord('intradivision', ix.NYA, []), f.st.stepRecord('intradivision', ix.TOR, [])], [[4, 2], [3, 3]]);
  K.eq('restart: TOR 2-1 over NYA head-to-head; then NYA 2-0 over BOS', f.order(['BOS', 'NYA', 'TOR']), ['TOR', 'NYA', 'BOS']);
}
/* a step with no games behind it is passed over, never invented */
{
  const f = build([L('NYA', 'BOS'), W('SEA', 'HOU'), W('NYA', 'BAL'), L('SEA', 'TEX')]);
  K.eq('never-met fixture is level (1-1 / 1-1)', [f.rec('NYA'), f.rec('SEA')], ['1-1', '1-1']);
  K.eq('never met: head-to-head and interdivision do not apply; intradivision level; the last half (NYA W, SEA L) decides', f.order(['SEA', 'NYA']), ['NYA', 'SEA']);
  K.eq('the steps that decided', steps(f.diags), ['last_half_intraleague']);
}
/* every step exhausted: a seeded draw, flagged and counted; without a draw stream, a refusal */
{
  const spec: G[] = [W('NYA', 'BOS'), W('SEA', 'HOU'), L('NYA', 'BAL'), L('SEA', 'TEX')];
  const flags: string[] = [];
  const loc = ix;
  const S = new Season(teams, spec.map(([h, a], i) => ({ home: loc[h], away: loc[a], day: 20000 + i, game_no: 0 })));
  const diags: string[] = [];
  const st = new Standings(S, Int8Array.from(spec.map((x) => x[2])), { rng: new Xoshiro128(5, 6, 7, 8), diag: (k) => diags.push(k), flag: (k) => flags.push(k) });
  const o = st.breakTie([ix.NYA, ix.SEA]);
  K.chk('exhausted: a seeded draw orders the two', o.length === 2 && new Set(o).size === 2);
  K.chk('exhausted: flagged tiebreak_exhausted and counted', flags.includes('tiebreak_exhausted') && diags.includes('tiebreak:exhausted'));
  const st2 = new Standings(S, Int8Array.from(spec.map((x) => x[2])), { rng: null });
  K.throws('exhausted with no draw stream: refused', () => st2.breakTie([ix.NYA, ix.SEA]), /tiebreak exhausted/);
}

/* ---- qualification and seeds ---- */
/** each club plays ten home games against the other league; `wins` of them are wins */
function tenEach(wins: Record<string, number>, rng = new Xoshiro128(9, 9, 9, 9)) {
  const al = teams.filter((t) => t.league === 'AL').map((t) => t.code), nl = teams.filter((t) => t.league === 'NL').map((t) => t.code);
  const spec: G[] = [];
  al.forEach((c, i) => { for (let k = 0; k < 10; k++) spec.push([c, nl[(i + k) % 15], k < (wins[c] ?? 5) ? 1 : -1]); });
  nl.forEach((c, i) => { for (let k = 0; k < 10; k++) spec.push([c, al[(i + k) % 15], k < (wins[c] ?? 5) ? 1 : -1]); });
  return build(spec, rng);
}
{
  const f = tenEach({ NYA: 9, TOR: 8, BOS: 7, BAL: 2, TBA: 1, CLE: 6, DET: 5, KCA: 4, MIN: 3, CHA: 0, SEA: 3, HOU: 2, TEX: 1, OAK: 0, ANA: 0 });
  const q = qualify(f.st, F22)[0]; const code = (t: number) => teams[t].code;
  K.eq('division winners: the best record in each division', q.divisionWinners.map(code), ['NYA', 'CLE', 'SEA']);
  K.eq('seeds 1-3: the division winners by record, the weakest (SEA) still third', q.seeds.slice(0, 3).map(code), ['NYA', 'CLE', 'SEA']);
  K.eq('seeds 4-6: the three best other clubs by record, two of them better than every division winner but one', q.seeds.slice(3).map(code), ['TOR', 'BOS', 'DET']);
  K.chk('SEA is seeded with a worse record than every wild card', ['TOR', 'BOS', 'DET'].every((c) => f.st.cmpRecord(ix[c], ix.SEA) > 0));
}
/* the bracket: byes, pairings without reseeding, the higher seed hosting */
{
  const f = tenEach({ NYA: 9, TOR: 8, BOS: 7, BAL: 2, TBA: 1, CLE: 6, DET: 5, KCA: 4, MIN: 3, CHA: 0, SEA: 3, HOU: 2, TEX: 1, OAK: 0, ANA: 0 });
  const seeds = qualify(f.st, F22);
  const hosts: Record<string, string[]> = {};
  /* the LOWER seed wins every game */
  const r = playPostseason(f.st, F22, seeds, (spec, _k, home) => { (hosts[spec.id] = hosts[spec.id] || []).push(teams[home].code); return spec.lower; });
  const al = seeds[0].seeds.map((t) => teams[t].code);
  const ser = (id: string) => { const s = r.series.find((x) => x.spec.id === id)!; return [teams[s.spec.higher].code, teams[s.spec.lower].code, s.games]; };
  K.eq('Wild Card Series 3 v 6 and 4 v 5, swept by the lower seed in two games at the higher seed', [ser('AL-WC-3v6'), ser('AL-WC-4v5'), hosts['AL-WC-4v5']], [[al[2], al[5], 2], [al[3], al[4], 2], [al[3], al[3]]]);
  K.chk('byes: seeds 1 and 2 play no Wild Card game', r.series.filter((s) => s.spec.round === 'WC').every((s) => ![seeds[0].seeds[0], seeds[0].seeds[1], seeds[1].seeds[0], seeds[1].seeds[1]].includes(s.spec.higher) && ![seeds[0].seeds[0], seeds[0].seeds[1], seeds[1].seeds[0], seeds[1].seeds[1]].includes(s.spec.lower)));
  K.eq('Division Series: 1 v winner of 4/5 (seed 5), 2 v winner of 3/6 (seed 6); three games when swept', [ser('AL-DS-1'), ser('AL-DS-2')], [[al[0], al[4], 3], [al[1], al[5], 3]]);
  K.eq('Division Series hosts when swept by the lower seed: H H L', hosts['AL-DS-1'], [al[0], al[0], al[4]]);
  K.eq('LCS: no reseeding; seed 5 hosts seed 6; swept in four (H H L L)', [ser('AL-LCS'), hosts['AL-LCS']], [[al[4], al[5], 4], [al[4], al[4], al[5], al[5]]]);
  K.eq('eleven series, two pennants, one champion', [r.series.length, r.pennant.length, typeof r.champion], [11, 2, 'number']);
  K.eq('reached the Division Series: 8 clubs (byes included); the LCS: 4', [r.reachedDS.length, new Set(r.reachedDS).size, r.reachedLCS.length], [8, 8, 4]);
}
/* series length and host order, every round */
{
  K.eq('Wild Card Series: every game at the higher seed', [1, 2, 3].map((k) => hostOf(F22, 'WC', k, 1, 2)), [1, 1, 1]);
  K.eq('Division Series 2-2-1', [1, 2, 3, 4, 5].map((k) => hostOf(F22, 'DS', k, 1, 2)), [1, 1, 2, 2, 1]);
  K.eq('LCS 2-3-2', [1, 2, 3, 4, 5, 6, 7].map((k) => hostOf(F22, 'LCS', k, 1, 2)), [1, 1, 2, 2, 2, 1, 1]);
  K.eq('World Series 2-3-2', [1, 2, 3, 4, 5, 6, 7].map((k) => hostOf(F22, 'WS', k, 1, 2)), [1, 1, 2, 2, 2, 1, 1]);
  K.eq('2012 Division Series 2-3: the LOWER seed hosts games 1-2', [1, 2, 3, 4, 5].map((k) => hostOf(formatFor(2012), 'DS', k, 1, 2)), [2, 2, 1, 1, 1]);
  K.eq('2013-2021: one Wild Card Game at the higher seed', [formatFor(2019).rounds[0].best_of, hostOf(formatFor(2019), 'WC', 1, 1, 2)], [1, 1]);
  K.throws('no game 4 in a best-of-3', () => hostOf(F22, 'WC', 4, 1, 2), /outside a best-of-3/);
  const spec = (round: 'WC' | 'DS' | 'LCS' | 'WS', bo: number): SeriesSpec => ({ id: 'X', round, league: 'AL', higher: 1, lower: 2, higherSeed: 1, lowerSeed: 2, best_of: bo });
  const play = (round: 'WC' | 'DS' | 'LCS' | 'WS', bo: number, win: (k: number, home: number) => number) => { const g: PlayedGame[] = []; const r = playSeries(F22, spec(round, bo), (_s, k, home) => win(k, home), g); return [r.winner, r.games, g.map((x) => x.home)]; };
  K.eq('a best-of-3 swept in 2', play('WC', 3, () => 2), [2, 2, [1, 1]]);
  K.eq('a best-of-3 that goes 3', play('WC', 3, (k) => (k === 2 ? 2 : 1)), [1, 3, [1, 1, 1]]);
  K.eq('a best-of-5 where the home club always wins: 5 games, the higher seed', play('DS', 5, (_k, h) => h), [1, 5, [1, 1, 2, 2, 1]]);
  K.eq('a best-of-7 where the home club always wins: 7 games', play('WS', 7, (_k, h) => h), [1, 7, [1, 1, 2, 2, 2, 1, 1]]);
  K.eq('a best-of-7 sweep: 4 games', play('LCS', 7, () => 1), [1, 4, [1, 1, 2, 2]]);
  K.throws('a winner outside the series is refused', () => playSeries(F22, spec('DS', 5), () => 7, []), /not a participant/);
}
/* World Series home field */
{
  const f = build([W('NYA', 'LAN'), W('NYA', 'LAN'), L('NYA', 'LAN'), L('NYA', 'BOS'), W('LAN', 'SDN')]);
  K.eq('World Series fixture: equal records 2-2 / 2-2', [f.rec('NYA'), f.rec('LAN')], ['2-2', '2-2']);
  K.eq('equal records: the tiebreak procedure, head-to-head first (NYA 2-1)', teams[worldSeriesHigher(f.st, F22, ix.NYA, ix.LAN)].code, 'NYA');
  const h = build([W('NYA', 'BOS'), L('NYA', 'BAL'), W('LAN', 'SDN'), W('LAN', 'SFN')]);
  K.eq('the better record hosts: LAN 2-0 over NYA 1-1', teams[worldSeriesHigher(h.st, F22, ix.NYA, ix.LAN)].code, 'LAN');
  K.eq('2012-2016: the All-Star Game league hosts (2012: NL; 2013: AL)', [teams[worldSeriesHigher(h.st, formatFor(2012), ix.NYA, ix.LAN)].code, teams[worldSeriesHigher(h.st, formatFor(2013), ix.NYA, ix.LAN)].code], ['LAN', 'NYA']);
}
/* refusals */
K.throws('2020 is refused, not approximated', () => formatFor(2020), /2020 MLB format/);
{
  const t12 = teamsFor(2012);
  const f = build([W('NYA', 'BOS'), W('BOS', 'NYA'), L('BAL', 'CHN'), L('TBA', 'CHN'), L('TOR', 'CHN')], null, t12);
  K.eq('MLB-2012 fixture: NYA and BOS level 1-1 at the top of the AL East', [f.rec('NYA'), f.rec('BOS')], ['1-1', '1-1']);
  let err: unknown = null; try { qualify(f.st, formatFor(2015)); } catch (e) { err = e; }
  K.chk('MLB-2012: a division tie needs a tiebreaker game, which this engine refuses to invent (UnsupportedTie)', err instanceof UnsupportedTie && /tiebreaker game/.test(String((err as Error).message)));
}
K.eq('2012: Houston in the NL Central; 2013 on, the AL West', [teamsFor(2012).find((t) => t.code === 'HOU')!.division, teamsFor(2013).find((t) => t.code === 'HOU')!.division], ['NL Central', 'AL West']);
process.exit(K.done());
