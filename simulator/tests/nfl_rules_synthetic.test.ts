/* SYNTHETIC fixtures for every NFL tiebreaker branch the real seasons
   2002-2025 never reached (simulator/tests/nfl_rules_history.test.ts covers
   the ones they did). Every schedule below is INVENTED to force one branch;
   none of it is historical. The clubs and divisions are the real alignment.
   node simulator/tests/nfl_rules_synthetic.test.ts */
import { kit } from './_kit.ts';
import { League, Standings, seedConferences, playPostseason, NFL_TB_2020, type NflTeam, type NflGame, type PlayoffGame } from '../src/sports/nfl/rules.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';
import { NFL_TEAMS_2026 } from '../src/sports/nfl/config.ts';

const T = kit('NFL rules, synthetic branches (SYNTHETIC fixtures)');
const TEAMS: NflTeam[] = NFL_TEAMS_2026;
const ix = (c: string) => { const i = TEAMS.findIndex((t) => t.code === c); if (i < 0) throw new Error(c); return i; };

/** g('BUF', 24, 'MIA', 17): home BUF 24, away MIA 17 */
type G = [string, number, string, number];
function build(gs: G[], tds?: Array<[number, number]>) {
  const games: NflGame[] = gs.map((g, k) => ({ game_id: 'SYN_' + k, week: 1 + (k % 18), home: ix(g[0]), away: ix(g[2]), done: true, home_score: g[1], away_score: g[3],
    home_td: tds ? tds[k][0] : null, away_td: tds ? tds[k][1] : null }));
  const L = new League(TEAMS, games);
  const margin = new Int16Array(games.map((g) => (g.home_score as number) - (g.away_score as number)));
  const home = new Int16Array(games.map((g) => g.home_score as number)), away = new Int16Array(games.map((g) => g.away_score as number));
  const diags: string[] = [], flags: string[] = [], events: Array<Record<string, unknown>> = [];
  const mk = (seed: number) => new Standings(L, {
    margin, points: () => ({ home, away }),
    touchdowns: tds ? () => ({ home: new Int16Array(tds.map((x) => x[0])), away: new Int16Array(tds.map((x) => x[1])) }) : () => null
  }, { rng: streamFor(BigInt(seed), 0, STREAM.coin), diag: (k) => diags.push(k), flag: (k) => flags.push(k), trace: (e) => events.push(e) });
  return { L, mk, diags, flags, events };
}
const code = (i: number) => TEAMS[i].code;
const pick = (st: Standings, clubs: string[], mode: 'division' | 'wildcard') => code(st.pickBest(clubs.map(ix), mode));
const lastStep = (d: string[]) => d.filter((x) => x.startsWith('tb:')).pop();

/* ---------------------------------------------------------------- division, two clubs */
{ // 1 head-to-head: BUF swept MIA
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 10, 'BUF', 20], ['MIA', 30, 'NYJ', 0], ['BUF', 0, 'NE', 30]]);
  const st = b.mk(1); st.rankDivisions();
  T.eq('div-2 step 1: head-to-head decides', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... and the step recorded is head_to_head', lastStep(b.diags), 'tb:division:2:head_to_head');
}
{ // 2 division record: split head-to-head, MIA better in the division
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['MIA', 20, 'NYJ', 10], ['BUF', 20, 'DAL', 10], ['NE', 20, 'BUF', 10], ['DAL', 20, 'MIA', 10]]);
  const st = b.mk(1);
  T.eq('div-2 step 2: division record decides after a split', pick(st, ['BUF', 'MIA'], 'division'), 'MIA');
  T.eq('  ... recorded as division_record', lastStep(b.diags), 'tb:division:2:division_record');
}
{ // 3' common games decisive: common opponents KC, DAL; MIA beats both, BUF splits; conference record would favour BUF
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['BUF', 20, 'KC', 10], ['DAL', 20, 'BUF', 10], ['MIA', 20, 'KC', 10], ['MIA', 20, 'DAL', 10],
    ['BUF', 20, 'PIT', 10], ['BUF', 20, 'CLE', 10], ['NYG', 20, 'MIA', 10], ['MIA', 20, 'PHI', 10]]);
  const st = b.mk(1);
  T.eq('setup: BUF and MIA are both 4-2', [st.w2[ix('BUF')], st.w2[ix('MIA')]], [8, 8]);
  T.eq('div-2 step 3: common games decide (BUF 1-1, MIA 2-0) though BUF has the better conference record', pick(st, ['BUF', 'MIA'], 'division'), 'MIA');
  T.eq('  ... recorded as common_games', lastStep(b.diags), 'tb:division:2:common_games');
}
{ // 4 conference record: everything above equal; BUF beats an AFC club, MIA beats an NFC club
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['BUF', 20, 'PIT', 10], ['MIA', 20, 'DAL', 10], ['CLE', 20, 'MIA', 10], ['NYG', 20, 'BUF', 10]]);
  const st = b.mk(1);
  T.eq('div-2 step 4: conference record decides', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... recorded as conference_record', lastStep(b.diags), 'tb:division:2:conference_record');
}
{ // 5 strength of victory: both beat one AFC club (no common opponents); BUF's victim has the better record
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['BUF', 20, 'PIT', 10], ['MIA', 20, 'CLE', 10], ['PIT', 20, 'SEA', 10], ['PIT', 20, 'ARI', 10]]);
  const st = b.mk(1);
  T.eq('div-2 step 5: strength of victory decides', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... recorded as strength_of_victory', lastStep(b.diags), 'tb:division:2:strength_of_victory');
}
{ // SOV IS LEAGUE-WIDE: the same tie flips when a game between two OTHER clubs flips
  const base: G[] = [['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['BUF', 20, 'PIT', 10], ['MIA', 20, 'CLE', 10]];
  const a = build(base.concat([['PIT', 20, 'SEA', 10]])), b2 = build(base.concat([['CLE', 20, 'SEA', 10]]));
  T.eq('SOV reads the whole league: PIT beating SEA favours BUF', pick(a.mk(1), ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('SOV reads the whole league: CLE beating SEA instead favours MIA', pick(b2.mk(1), ['BUF', 'MIA'], 'division'), 'MIA');
}
{ // 6 strength of schedule: both 1-1 vs the same-record opponents... SOV equal (victims equal), SOS differs via the losses
  const b = build([['BUF', 20, 'MIA', 10], ['MIA', 20, 'BUF', 10], ['BUF', 20, 'PIT', 10], ['MIA', 20, 'CLE', 10], ['DEN', 20, 'BUF', 10], ['LV', 20, 'MIA', 10],
    ['DEN', 20, 'SEA', 10]]);
  const st = b.mk(1);
  T.chk('div-2 setup: SOV equal', st.sov(ix('BUF')) === st.sov(ix('MIA')), [st.sov(ix('BUF')), st.sov(ix('MIA'))]);
  T.eq('div-2 step 6: strength of schedule decides', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... recorded as strength_of_schedule', lastStep(b.diags), 'tb:division:2:strength_of_schedule');
}
{ // 7 combined ranking among conference teams: symmetric records, BUF scores more
  const b = build([['BUF', 40, 'MIA', 10], ['MIA', 31, 'BUF', 30]]);
  const st = b.mk(1);
  // BUF: scored 70 allowed 41; MIA scored 41 allowed 70. Records 1-1 each, h2h split, division 1-1, SOV/SOS equal.
  T.eq('div-2 step 7: combined conference points ranking decides', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... recorded as combined_rank_conference', lastStep(b.diags), 'tb:division:2:combined_rank_conference');
  T.chk('  ... and the run is flagged as having used the (Estimated in simulation) points input', b.flags.includes('tiebreak_estimated_points'));
}
{ // competition ranking: equal points share the better rank
  const b = build([['BUF', 20, 'MIA', 10], ['NE', 20, 'NYJ', 10]]);
  const st = b.mk(1);
  // scored: BUF and NE 20 share rank 1, MIA and NYJ 10 share rank 3; allowed: the 12 idle clubs 0 share rank 1,
  // BUF and NE 10 share rank 13, MIA and NYJ 20 share rank 15
  T.eq('combined rank uses competition ranking (equal values share the better rank)',
    [st.combinedRank('conference', ix('BUF')), st.combinedRank('conference', ix('NE')), st.combinedRank('conference', ix('MIA'))], [14, 14, 18]);
}
{ // 9 net points in common games (records, ranks, SOV/SOS all equal by symmetry)
  // BUF and MIA split; each plays KC (common) and one NON-common opponent with mirrored totals.
  // BUF: W KC 27-3 (+24), L SEA 0-24 (-24) ; MIA: W KC 13-3 (+10), L ARI 14-24 (-10)
  // pf BUF 20+17+27+0 = 64 ; MIA 17+20+13+14 = 64 ; pa BUF 17+20+3+24 = 64 ; MIA 20+17+3+24 = 64
  // SEA and ARI are both 1-0 (SOS equal), KC 0-2 (SOV equal).
  const b = build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17], ['BUF', 27, 'KC', 3], ['MIA', 13, 'KC', 3], ['SEA', 24, 'BUF', 0], ['ARI', 24, 'MIA', 14]]);
  const st = b.mk(1);
  const P = st.pointsTotals()!;
  T.chk('setup: equal points scored and allowed (64/64)', P.pf[ix('BUF')] === 64 && P.pf[ix('MIA')] === 64 && P.pa[ix('BUF')] === 64 && P.pa[ix('MIA')] === 64);
  T.eq('div-2 step 9: net points in common games decides (+24 vs +10)', pick(st, ['BUF', 'MIA'], 'division'), 'BUF');
  T.eq('  ... recorded as net_points_common', lastStep(b.diags), 'tb:division:2:net_points_common');
}
{ // 11 net touchdowns without a touchdown source: UNSUPPORTED -> flagged, then a seeded coin toss
  const b = build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17]]);
  const st = b.mk(7);
  const w = pick(st, ['BUF', 'MIA'], 'division');
  T.chk('div-2 step 11 without touchdowns: the run is flagged unsupported', b.flags.includes('tiebreak_unsupported_input'));
  T.chk('  ... and the unsupported step is named', b.diags.includes('tb:unsupported:net_touchdowns'));
  T.chk('  ... and resolved by the seeded coin toss, traced', b.events.some((e) => e.type === 'coin_toss' && e.why === 'unsupported:net_touchdowns') && ['BUF', 'MIA'].includes(w));
}
{ // 11 net touchdowns with a source decides; 12 coin toss when everything is equal
  const b = build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17]], [[2, 2], [2, 1]]);
  T.eq('div-2 step 11: net touchdowns decide (MIA +1)', pick(b.mk(1), ['BUF', 'MIA'], 'division'), 'MIA');
  T.eq('  ... recorded as net_touchdowns', lastStep(b.diags), 'tb:division:2:net_touchdowns');
  const results = new Set<string>();
  for (let s = 0; s < 40; s++) { const c = build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17]], [[2, 2], [2, 2]]); results.add(pick(c.mk(s), ['BUF', 'MIA'], 'division')); }
  T.eq('div-2 step 12: an all-equal tie is a coin toss that either club can win across seeds', [...results].sort(), ['BUF', 'MIA']);
  const r1 = pick(build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17]], [[2, 2], [2, 2]]).mk(11), ['BUF', 'MIA'], 'division');
  const r2 = pick(build([['BUF', 20, 'MIA', 17], ['MIA', 20, 'BUF', 17]], [[2, 2], [2, 2]]).mk(11), ['BUF', 'MIA'], 'division');
  T.eq('  ... and the same seed gives the same toss', r1, r2);
}
/* ---------------------------------------------------------------- division, three clubs */
{ // RESTART: BUF, MIA and NYJ tied at 4-4. Step 1 (head-to-head among the three) is equal (each 2-2);
  // step 2 (division record) eliminates NYJ (2-4 against BUF and MIA at 4-2). BUF and MIA then RESTART at
  // two-club step 1: MIA swept BUF, so MIA. Continuing at step 3 instead (common games: BUF 4-2, MIA 2-4)
  // would have picked BUF, so this case fails if the restart is skipped.
  const b = build([['MIA', 20, 'BUF', 10], ['BUF', 10, 'MIA', 20], ['BUF', 20, 'NYJ', 10], ['NYJ', 10, 'BUF', 20], ['NYJ', 20, 'MIA', 10], ['MIA', 10, 'NYJ', 20],
    ['BUF', 20, 'NE', 10], ['NE', 10, 'BUF', 20], ['MIA', 20, 'NE', 10], ['NE', 10, 'MIA', 20], ['NE', 20, 'NYJ', 10], ['NYJ', 10, 'NE', 20],
    ['NYJ', 20, 'KC', 10], ['NYJ', 20, 'LV', 10], ['DEN', 20, 'BUF', 10], ['LAC', 20, 'BUF', 10], ['DEN', 20, 'MIA', 10], ['LAC', 20, 'MIA', 10]]);
  const st = b.mk(1);
  T.eq('setup: BUF, MIA and NYJ are all 4-4', ['BUF', 'MIA', 'NYJ'].map((c) => [st.w2[ix(c)], st.gp[ix(c)]]), [[8, 8], [8, 8], [8, 8]]);
  T.eq('div-3: NYJ eliminated at division record, BUF and MIA restart at two-club step 1 (head-to-head): MIA', pick(st, ['BUF', 'MIA', 'NYJ'], 'division'), 'MIA');
  T.chk('  ... the elimination was traced', b.events.some((e) => e.type === 'tiebreak_eliminate' && e.step === 'division_record' && JSON.stringify(e.remaining) === '["BUF","MIA"]'), b.events);
  T.chk('  ... and the deciding step was the two-club head-to-head', b.diags.includes('tb:division:2:head_to_head'));
}
/* ---------------------------------------------------------------- wild card */
{ // two clubs, different divisions, did not meet: head-to-head skipped, conference record decides
  const b = build([['PIT', 20, 'CLE', 10], ['PIT', 20, 'DAL', 10], ['DEN', 20, 'NYG', 10], ['DEN', 20, 'PHI', 10], ['KC', 20, 'PIT', 10], ['KC', 20, 'DEN', 10]]);
  const st = b.mk(1); st.rankDivisions();
  T.eq('wc-2: no head-to-head game, conference record decides', pick(st, ['PIT', 'DEN'], 'wildcard'), 'PIT');
  T.eq('  ... recorded as conference_record', lastStep(b.diags), 'tb:wildcard:2:conference_record');
}
{ // common games MINIMUM OF FOUR: three common games only -> skipped (SOV decides instead)
  const b = build([['PIT', 20, 'NYG', 10], ['DEN', 20, 'NYG', 10], ['PIT', 20, 'PHI', 10], ['PHI', 20, 'DEN', 10], ['WAS', 20, 'PIT', 10], ['DEN', 20, 'WAS', 10],
    ['NYG', 20, 'SEA', 10], ['NYG', 20, 'ARI', 10]]);
  const st = b.mk(1); st.rankDivisions();
  const w = pick(st, ['PIT', 'DEN'], 'wildcard');
  T.chk('wc-2: three common games (fewer than four) do not decide', !b.diags.includes('tb:wildcard:2:common_games_min4'), b.diags);
  T.chk('  ... a later step does', ['PIT', 'DEN'].includes(w));
}
{ // three clubs: the division reduction keeps only each division's top club
  // CLE beats PIT head-to-head (CLE ranks above PIT in the AFC North); CLE, PIT, DEN tied on record; PIT would beat DEN, CLE would lose to DEN.
  const b = build([['CLE', 20, 'PIT', 10], ['PIT', 20, 'DEN', 10], ['DEN', 20, 'CLE', 10], ['BAL', 20, 'KC', 10], ['BAL', 20, 'LV', 10], ['KC', 20, 'NYG', 10]]);
  const st = b.mk(1); st.rankDivisions();
  T.chk('setup: CLE ranks above PIT in the division', st.divRankPos[ix('CLE')] < st.divRankPos[ix('PIT')]);
  const w = pick(st, ['CLE', 'PIT', 'DEN'], 'wildcard');
  T.chk('wc-3 step 1: the division reduction is applied first', b.diags.includes('tb:wildcard:division_reduction'));
  T.eq('  ... then CLE and DEN go two-club: head-to-head DEN', w, 'DEN');
}
{ // three clubs, different divisions: one club beat each of the others (sweep)
  const b = build([['PIT', 20, 'DEN', 10], ['PIT', 20, 'HOU', 10], ['DEN', 20, 'NYG', 10], ['HOU', 20, 'PHI', 10], ['NYG', 20, 'PIT', 10], ['SEA', 20, 'PIT', 10], ['DEN', 10, 'HOU', 20], ['HOU', 10, 'DEN', 20]]);
  T.chk('setup: PIT, DEN and HOU are all 2-2', ['PIT', 'DEN', 'HOU'].every((c) => b.mk(1).w2[ix(c)] === 4));
  const st = b.mk(1); st.rankDivisions();
  T.eq('wc-3 step 2: the club that beat each of the others wins (sweep)', pick(st, ['PIT', 'DEN', 'HOU'], 'wildcard'), 'PIT');
  T.eq('  ... recorded as head_to_head_sweep', lastStep(b.diags), 'tb:wildcard:3+:head_to_head_sweep');
}
{ // four clubs, one eliminated, three left restart at three-club step 2 (not step 1)
  const b = build([['PIT', 20, 'NYG', 10], ['DEN', 20, 'NYG', 10], ['HOU', 20, 'NYG', 10], ['MIA', 10, 'NYG', 20],
    ['PIT', 20, 'DEN', 10], ['DEN', 20, 'HOU', 10], ['HOU', 20, 'PIT', 10], ['MIA', 20, 'SEA', 10], ['MIA', 20, 'ARI', 10], ['SF', 20, 'PIT', 10], ['SF', 20, 'DEN', 10], ['SF', 20, 'HOU', 10], ['SF', 20, 'MIA', 10]]);
  const st = b.mk(1); st.rankDivisions();
  const rec = ['PIT', 'DEN', 'HOU', 'MIA'].map((c) => st.pct(ix(c)));
  T.chk('setup: four clubs share one record', rec.every((x) => x === rec[0]), rec);
  const w = pick(st, ['PIT', 'DEN', 'HOU', 'MIA'], 'wildcard');
  T.chk('wc-4: a club was eliminated before a winner was named', b.events.some((e) => e.type === 'tiebreak_eliminate'));
  T.chk('  ... MIA (no conference games) eliminated at conference record', b.diags.includes('tb:wildcard:3+:conference_record'));
  T.chk('  ... and a winner came from the three left', ['PIT', 'DEN', 'HOU'].includes(w), w);
}
/* ---------------------------------------------------------------- ties count half */
{
  const b = build([['BUF', 20, 'MIA', 20], ['NE', 20, 'NYJ', 10]]);
  const st = b.mk(1);
  T.eq('a tie is half a win and half a loss', [st.pct(ix('BUF')), st.pct(ix('MIA')), st.pct(ix('NE'))], [0.5, 0.5, 1]);
}
/* ---------------------------------------------------------------- seeding and the bracket */
{ // a full synthetic season: every club plays every other club in its conference once (15 games); results by a fixed strength order
  const gs: G[] = [];
  for (const c of ['AFC', 'NFC']) {
    const m = TEAMS.map((t, i) => [t, i] as const).filter(([t]) => t.conference === c).map(([, i]) => i);
    for (let a = 0; a < m.length; a++) for (let z = a + 1; z < m.length; z++) gs.push([code(m[a]), 24, code(m[z]), 17]);
  }
  const b = build(gs);
  const st = b.mk(3);
  const seeds = seedConferences(st, NFL_TB_2020);
  T.chk('seven seeds per conference, all distinct, all from that conference', seeds.every((c) => c.seeds.length === 7 && new Set(c.seeds).size === 7 && c.seeds.every((t) => b.L.conf[t] === c.conference)));
  T.chk('seeds 1-4 are the four division winners', seeds.every((c) => c.seeds.slice(0, 4).every((t) => st.divRankPos[t] === 0)));
  T.chk('division winners are seeded by record', seeds.every((c) => c.seeds.slice(0, 4).every((t, k, a) => k === 0 || st.pct(a[k - 1]) >= st.pct(t))));
  T.chk('wild cards are seeded by record', seeds.every((c) => c.seeds.slice(4).every((t, k, a) => k === 0 || st.pct(a[k - 1]) >= st.pct(t))));
  /* the bracket: higher seed always wins -> each conference's 1 seed is its champion */
  const hi = (g: PlayoffGame) => (g.round === 'super_bowl' ? g.home : (g.homeSeed < g.awaySeed ? g.home : g.away));
  const r = playPostseason(seeds, NFL_TB_2020, hi, 'AFC');
  T.eq('better seed always wins: the 1 seeds meet in the Super Bowl', r.conferenceChampions, [seeds[0].seeds[0], seeds[1].seeds[0]]);
  T.eq('13 postseason games', r.games.length, 13);
  T.chk('wild card round: 2v7, 3v6, 4v5 at the better seed', r.games.filter((g) => g.round === 'wild_card').every((g) => g.homeSeed + g.awaySeed === 9 && g.homeSeed < g.awaySeed));
  T.chk('the 1 seed has a bye and hosts in the divisional round', r.games.filter((g) => g.round === 'divisional' && g.homeSeed === 1).length === 2 && r.games.filter((g) => g.round === 'wild_card' && (g.homeSeed === 1 || g.awaySeed === 1)).length === 0);
  T.chk('the Super Bowl is neutral with the AFC designated home this season', r.games.filter((g) => g.round === 'super_bowl').every((g) => g.neutral && b.L.conf[g.home] === 0));
  /* the lower seed always wins (except the SB) -> reseeding: the 1 seed hosts the LOWEST remaining seed */
  const lo = (g: PlayoffGame) => (g.round === 'super_bowl' ? g.away : (g.homeSeed < g.awaySeed ? g.away : g.home));
  const r2 = playPostseason(seeds, NFL_TB_2020, lo, 'NFC');
  const div1 = r2.games.filter((g) => g.round === 'divisional' && g.homeSeed === 1);
  T.chk('reseeding: with 7, 6 and 5 advancing, the 1 seed hosts the 7 seed', div1.length === 2 && div1.every((g) => g.awaySeed === 7), div1.map((g) => [g.homeSeed, g.awaySeed]));
  T.chk('  ... and the 5 seed hosts the 6 seed', r2.games.filter((g) => g.round === 'divisional' && g.homeSeed === 5).every((g) => g.awaySeed === 6));
  T.chk('NFC designated home in the Super Bowl when configured', r2.games.filter((g) => g.round === 'super_bowl').every((g) => b.L.conf[g.home] === 1));
  T.throws('a resolver that names a club not in the game is refused', () => playPostseason(seeds, NFL_TB_2020, () => -1, 'AFC'), /not in the game/);
}
process.exit(T.done());
