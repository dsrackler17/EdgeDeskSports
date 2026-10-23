/* NBA rules on SYNTHETIC fixtures: every tiebreak step decides a tie by itself, the
   elimination-and-restart rule, division titles, the 2006-07 seed block, the play-in
   state machine on every path, the exact 2-2-1-1-1 order, series termination at four
   wins, an in-progress series resumed from its observed games, the fixed bracket, and
   home court by record (not seed). Records are set directly; no fixture feeds production. */
import { kit } from './_kit.ts';
import { League, Standings, seedConferences, playPostseason, playSeries, hostsGame, NBA_2021, NBA_2007, rulesFor, type NbaRulesVersion, type PostseasonGameReq, type PlayedGame } from '../src/sports/nba/rules.ts';
import { NBA_TEAMS } from '../src/sports/nba/config.ts';
import { streamFor, STREAM } from '../src/core/prng.ts';

const T = kit('NBA rules (SYNTHETIC fixtures)');
const ix: Record<string, number> = {}; NBA_TEAMS.forEach((t, i) => { ix[t.code] = i; });
const N = NBA_TEAMS.length;

interface Fx { S: Standings; diags: Record<string, number>; flags: string[]; traces: any[] }
/** a 30-club fixture: every club a distinct default record (no ties) unless overridden */
function fixture(rules: NbaRulesVersion, recs: Record<string, [number, number]>, seed = 1n): Fx {
  const diags: Record<string, number> = {}, flags: string[] = [], traces: any[] = [];
  const L = new League(NBA_TEAMS, []);
  const S = new Standings(L, new Int16Array(0), { rng: streamFor(seed, 0, STREAM.coin), diag: (k) => { diags[k] = (diags[k] || 0) + 1; }, flag: (k) => { flags.push(k); }, trace: (e) => { traces.push(e); } }, rules);
  NBA_TEAMS.forEach((t, i) => { const r = recs[t.code] || [10 + 2 * i, 72 - 2 * i]; S.w[i] = r[0]; S.gp[i] = r[0] + r[1]; });
  S.fixPlayoffClubs();
  return { S, diags, flags, traces };
}
const h2h = (S: Standings, a: string, b: string, wa: number, wb: number) => { const A = ix[a], B = ix[b]; S.h2hW[A * N + B] = wa; S.h2hW[B * N + A] = wb; S.h2hG[A * N + B] = wa + wb; S.h2hG[B * N + A] = wa + wb; };
const setConf = (S: Standings, c: string, w: number, g: number) => { S.confW[ix[c]] = w; S.confG[ix[c]] = g; };
const setDiv = (S: Standings, c: string, w: number, g: number) => { S.divW[ix[c]] = w; S.divG[ix[c]] = g; };
const codes = (xs: number[]) => xs.map((i) => NBA_TEAMS[i].code);
const rank = (f: Fx, cs: string[]) => codes(f.S.rankTied(cs.map((c) => ix[c]), 't'));

/* 1 two clubs: each step decides by itself (BOS of the Atlantic vs CHI of the Central, 41-41) */
{
  const base = { BOS: [41, 41] as [number, number], CHI: [41, 41] as [number, number] };
  let f = fixture(NBA_2021, base); h2h(f.S, 'BOS', 'CHI', 1, 2);
  T.eq('two clubs: head-to-head decides', rank(f, ['BOS', 'CHI']), ['CHI', 'BOS']);
  T.chk('  ... at the head-to-head step', f.diags['tb:t:2:head_to_head'] === 1, f.diags);
  f = fixture(NBA_2021, base); h2h(f.S, 'BOS', 'CHI', 1, 1); f.S.divWinner[ix.BOS] = 1;
  T.eq('two clubs: head-to-head level, the division winner wins', rank(f, ['CHI', 'BOS']), ['BOS', 'CHI']);
  T.chk('  ... at the division-winner step', f.diags['tb:t:2:division_winner'] === 1);
  f = fixture(NBA_2021, base); setConf(f.S, 'BOS', 30, 52); setConf(f.S, 'CHI', 31, 52);
  T.eq('two clubs who never met: head-to-head is skipped; conference record decides', rank(f, ['BOS', 'CHI']), ['CHI', 'BOS']);
  T.chk('  ... at the conference-record step', f.diags['tb:t:2:conference_record'] === 1 && !f.diags['tb:t:2:head_to_head']);
  /* division record: same division only (BOS and NY of the Atlantic) */
  f = fixture(NBA_2021, { BOS: [41, 41], NY: [41, 41] }); h2h(f.S, 'BOS', 'NY', 2, 2); setDiv(f.S, 'BOS', 9, 16); setDiv(f.S, 'NY', 8, 16); setConf(f.S, 'BOS', 20, 52); setConf(f.S, 'NY', 30, 52);
  T.eq('two clubs of one division: division record before conference record', rank(f, ['NY', 'BOS']), ['BOS', 'NY']);
  T.chk('  ... at the division-record step', f.diags['tb:t:2:division_record'] === 1);
  f = fixture(NBA_2021, base); setDiv(f.S, 'BOS', 1, 16); setDiv(f.S, 'CHI', 15, 16); setConf(f.S, 'BOS', 31, 52); setConf(f.S, 'CHI', 30, 52);
  T.eq('two clubs of different divisions: division record is not a step', rank(f, ['CHI', 'BOS']), ['BOS', 'CHI']);
  /* playoff clubs of the own conference: the 10 best records of the East, ties at 10th included */
  f = fixture(NBA_2021, base); setConf(f.S, 'BOS', 30, 52); setConf(f.S, 'CHI', 30, 52);
  const eastPO = codes(f.S.playoffSet(0));
  T.chk('the East\'s playoff clubs are its 10 best records', eastPO.length === 10 && eastPO.includes('BOS') && eastPO.includes('CHI'), eastPO);
  { const g = fixture(NBA_2021, { ...base, CLE: [24, 58] }); const po = codes(g.S.playoffSet(0));
    T.chk('a club level with the 10th place counts as a playoff club (11 clubs)', po.length === 11 && po.includes('CLE') && po.includes('DET'), po); }
  h2h(f.S, 'BOS', 'MIL', 2, 1); h2h(f.S, 'CHI', 'MIL', 1, 2);
  T.eq('two clubs: record against the own conference\'s playoff clubs', rank(f, ['CHI', 'BOS']), ['BOS', 'CHI']);
  T.chk('  ... at that step', f.diags['tb:t:2:vs_playoff_own_conference'] === 1, f.diags);
  f = fixture(NBA_2021, base); setConf(f.S, 'BOS', 30, 52); setConf(f.S, 'CHI', 30, 52); h2h(f.S, 'BOS', 'MIL', 1, 1); h2h(f.S, 'CHI', 'MIL', 1, 1);
  h2h(f.S, 'BOS', 'SA', 0, 2); h2h(f.S, 'CHI', 'SA', 1, 1);
  T.eq('two clubs: then the other conference\'s playoff clubs', rank(f, ['BOS', 'CHI']), ['CHI', 'BOS']);
  T.chk('  ... at that step', f.diags['tb:t:2:vs_playoff_other_conference'] === 1, f.diags);
  f = fixture(NBA_2021, base); setConf(f.S, 'BOS', 30, 52); setConf(f.S, 'CHI', 30, 52); h2h(f.S, 'BOS', 'MIL', 1, 1); h2h(f.S, 'CHI', 'MIL', 1, 1); h2h(f.S, 'BOS', 'SA', 1, 1); h2h(f.S, 'CHI', 'SA', 1, 1);
  f.S.net[ix.BOS] = 40; f.S.net[ix.CHI] = 39;
  T.eq('two clubs: then point differential', rank(f, ['CHI', 'BOS']), ['BOS', 'CHI']);
  T.chk('  ... at that step', f.diags['tb:t:2:point_differential'] === 1, f.diags);
  /* random drawing: everything level */
  const winners = new Set<string>();
  for (let sd = 1n; sd <= 40n; sd++) { const g = fixture(NBA_2021, base, sd); const r = rank(g, ['BOS', 'CHI']); winners.add(r[0]); T.chk('a random drawing is flagged (seed ' + sd + ')', g.flags.includes('tiebreak_random_drawing')); }
  T.chk('the random drawing goes either way over seeds', winners.size === 2, [...winners]);
  T.eq('the random drawing is reproducible for a seed', rank(fixture(NBA_2021, base, 7n), ['BOS', 'CHI']), rank(fixture(NBA_2021, base, 7n), ['BOS', 'CHI']));
}

/* 2 three or more clubs */
{
  /* the 2008-09 pattern: two division winners and a non-winner, level; the non-winner is eliminated at step 1 and
     ranks BELOW both even though it beat both head-to-head; the winners then meet head-to-head */
  const rec = { BOS: [41, 41] as [number, number], CHI: [41, 41] as [number, number], NY: [41, 41] as [number, number] };
  let f = fixture(NBA_2021, rec); f.S.divWinner[ix.BOS] = 1; f.S.divWinner[ix.CHI] = 1;
  h2h(f.S, 'BOS', 'CHI', 1, 3); h2h(f.S, 'NY', 'BOS', 3, 1); h2h(f.S, 'NY', 'CHI', 3, 1);
  T.eq('three clubs: the division-winner step eliminates the non-winner, who ranks third', rank(f, ['NY', 'BOS', 'CHI']), ['CHI', 'BOS', 'NY']);
  T.chk('  ... division-winner step (3+), then head-to-head (2)', f.diags['tb:t:3+:division_winner'] === 1 && f.diags['tb:t:2:head_to_head'] === 1, f.diags);
  /* the eliminated clubs start again from step 1: BOS best among the three; NY and CHI level there; the two-club
     procedure then puts CHI ahead on head-to-head although NY has the better conference record */
  f = fixture(NBA_2021, rec); h2h(f.S, 'BOS', 'NY', 1, 1); h2h(f.S, 'BOS', 'CHI', 2, 0); h2h(f.S, 'NY', 'CHI', 0, 1);
  setConf(f.S, 'NY', 33, 52); setConf(f.S, 'CHI', 30, 52); setConf(f.S, 'BOS', 30, 52);
  T.eq('three clubs: one best club; the other two restart with the two-club procedure', rank(f, ['NY', 'CHI', 'BOS']), ['BOS', 'CHI', 'NY']);
  T.chk('  ... games among the tied clubs (3+), then head-to-head (2), never conference record', f.diags['tb:t:3+:games_among_tied'] === 1 && f.diags['tb:t:2:head_to_head'] === 1 && !f.diags['tb:t:3+:conference_record']);
  /* four clubs: a best group of two is ranked first, as a two-club tie, then the other two */
  const r4 = { BOS: [41, 41] as [number, number], CHI: [41, 41] as [number, number], NY: [41, 41] as [number, number], MIL: [41, 41] as [number, number] };
  f = fixture(NBA_2021, r4); f.S.divWinner[ix.BOS] = 1; f.S.divWinner[ix.CHI] = 1; h2h(f.S, 'BOS', 'CHI', 0, 2); h2h(f.S, 'NY', 'MIL', 2, 0);
  h2h(f.S, 'NY', 'BOS', 4, 0); h2h(f.S, 'MIL', 'CHI', 4, 0);
  T.eq('four clubs: the two division winners first (head-to-head between them), then the others', rank(f, ['NY', 'MIL', 'BOS', 'CHI']), ['CHI', 'BOS', 'NY', 'MIL']);
  /* division record applies to three clubs only when all share a division */
  f = fixture(NBA_2021, { BOS: [41, 41], NY: [41, 41], PHI: [41, 41] }); h2h(f.S, 'BOS', 'NY', 1, 1); h2h(f.S, 'BOS', 'PHI', 1, 1); h2h(f.S, 'NY', 'PHI', 1, 1);
  setDiv(f.S, 'BOS', 9, 16); setDiv(f.S, 'NY', 8, 16); setDiv(f.S, 'PHI', 7, 16);
  T.eq('three clubs of one division: division record', rank(f, ['PHI', 'NY', 'BOS']), ['BOS', 'NY', 'PHI']);
  T.chk('  ... at that step (3+), then the two-club procedure for NY-PHI', f.diags['tb:t:3+:division_record'] === 1 && f.diags['tb:t:2:division_record'] === 1, f.diags);
  f = fixture(NBA_2021, { BOS: [41, 41], NY: [41, 41], CHI: [41, 41] }); setDiv(f.S, 'BOS', 1, 16); setDiv(f.S, 'NY', 15, 16); setConf(f.S, 'BOS', 31, 52); setConf(f.S, 'NY', 30, 52); setConf(f.S, 'CHI', 29, 52);
  T.eq('three clubs of different divisions: division record is skipped, conference record decides', rank(f, ['CHI', 'NY', 'BOS']), ['BOS', 'NY', 'CHI']);
  /* the multi-club procedure has no other-conference step: point differential follows the own conference's playoff clubs */
  f = fixture(NBA_2021, { BOS: [41, 41], NY: [41, 41], CHI: [41, 41] }); f.S.net[ix.BOS] = 1; f.S.net[ix.NY] = 3; f.S.net[ix.CHI] = 2;
  h2h(f.S, 'BOS', 'SA', 2, 0); h2h(f.S, 'NY', 'SA', 0, 2); h2h(f.S, 'CHI', 'SA', 0, 2);
  T.eq('three clubs: point differential first (the multi-club procedure has no other-conference step), then BOS-CHI on the two-club procedure', rank(f, ['BOS', 'CHI', 'NY']), ['NY', 'BOS', 'CHI']);
  T.chk('  ... point differential (3+), then the other conference\'s playoff clubs (2)', f.diags['tb:t:3+:point_differential'] === 1 && f.diags['tb:t:2:vs_playoff_other_conference'] === 1 && !f.diags['tb:t:3+:vs_playoff_other_conference'], f.diags);
}

/* 3 division titles first; the order of a full conference */
{
  const f = fixture(NBA_2021, { BOS: [50, 32], NY: [50, 32], PHI: [30, 52], BKN: [20, 62], TOR: [25, 57] });
  h2h(f.S, 'BOS', 'NY', 1, 3);
  f.S.decideDivisions();
  T.chk('a division title tie: head-to-head (NY), and the division-winner step cannot separate them', f.S.divWinner[ix.NY] === 1 && f.S.divWinner[ix.BOS] === 0 && f.diags['tb:division:2:head_to_head'] === 1, f.diags);
  T.eq('six division winners', f.S.divisionWinners.length, 6);
  f.S.rankConferences();
  T.chk('places 1-15 per conference, a permutation', f.S.confOrder.every((o) => o.length === 15 && new Set(o).size === 15));
  T.chk('NY above BOS in the standings (same record, NY won the division)', f.S.place[ix.NY] < f.S.place[ix.BOS]);
}

/* 4 the 2006-07..2014-15 seed block and home court by record */
{
  const f = fixture(NBA_2007, { BOS: [60, 22], NY: [50, 32], PHI: [49, 33], CHI: [40, 42], CLE: [30, 52], ATL: [38, 40], MIA: [20, 62], ORL: [21, 61], WSH: [22, 60], CHA: [23, 59], DET: [55, 27], IND: [48, 34], MIL: [47, 35], BKN: [46, 36], TOR: [45, 37] });
  f.S.decideDivisions(); const cs = seedConferences(f.S);
  T.eq('NBA-2007: the division winners (BOS, DET, ATL) and the best other club (NY) take seeds 1-4, by record', codes(cs[0].direct.slice(0, 4)), ['BOS', 'DET', 'NY', 'ATL']);
  T.eq('NBA-2007: seeds 5-8 by record (PHI 49 wins is the 5 seed behind ATL\'s 38)', codes(cs[0].direct.slice(4)), ['PHI', 'IND', 'MIL', 'BKN']);
  const hosts: string[] = [];
  playPostseason(f.S, cs, (q) => { if (q.round === 'first_round' && q.game_no === 1) hosts.push(NBA_TEAMS[q.home].code + '-' + NBA_TEAMS[q.away].code); return q.home; });
  T.chk('NBA-2007: the 5 seed with the better record hosts the 4 seed', hosts.includes('PHI-ATL'), hosts);
}

/* 5 the play-in: every path */
{
  const recs: Record<string, [number, number]> = {};
  const east = ['BOS', 'NY', 'PHI', 'TOR', 'BKN', 'CHI', 'CLE', 'DET', 'IND', 'MIL', 'ATL', 'CHA', 'MIA', 'ORL', 'WSH'];
  east.forEach((c, i) => { recs[c] = [70 - 3 * i, 12 + 3 * i]; });
  const f = fixture(NBA_2021, recs); f.S.decideDivisions(); const cs = seedConferences(f.S);
  T.eq('places 7-10 enter the play-in', codes(cs[0].playIn), ['CLE', 'DET', 'IND', 'MIL']);
  T.eq('places 1-6 qualify directly', codes(cs[0].direct), ['BOS', 'NY', 'PHI', 'TOR', 'BKN', 'CHI']);
  const paths: Array<[string, string, string, string, string]> = [
    /* winner of 7v8, winner of 9v10, winner of the last game -> 7 seed, 8 seed */
    ['CLE', 'IND', 'DET', 'CLE', 'DET'], ['CLE', 'IND', 'IND', 'CLE', 'IND'], ['DET', 'MIL', 'CLE', 'DET', 'CLE'], ['DET', 'MIL', 'MIL', 'DET', 'MIL']
  ];
  for (const [w78, w910, wLast, s7, s8] of paths) {
    const seen: string[] = [];
    const res = playPostseason(f.S, cs, (q) => {
      if (q.round !== 'play_in') return q.home;
      seen.push(q.conference + ' ' + q.key + ' ' + NBA_TEAMS[q.home].code + '-' + NBA_TEAMS[q.away].code);
      if (q.conference === 'West') return q.home;
      const want = q.key === '7v8' ? w78 : q.key === '9v10' ? w910 : wLast;
      return ix[want];
    });
    const lose78 = w78 === 'CLE' ? 'DET' : 'CLE';
    T.eq('play-in path ' + [w78, w910, wLast].join('/') + ': hosts 7th, 9th, then the loser of 7-8', seen.filter((x) => x.startsWith('East')), ['East 7v8 CLE-DET', 'East 9v10 IND-MIL', 'East last ' + lose78 + '-' + w910]);
    T.eq('play-in path ' + [w78, w910, wLast].join('/') + ': seeds 7 and 8', codes(res.seeds[0].slice(6)), [s7, s8]);
    T.chk('play-in path ' + [w78, w910, wLast].join('/') + ': 8 playoff clubs, the 10th never above 8th seed unless it won twice', res.seeds[0].length === 8 && new Set(res.seeds[0]).size === 8);
  }
  /* home court by record, not seed: the 7th place loses 7v8, wins the last game and is the 8 seed; it meets the 7 seed
     (the 8th place) in the conference finals and hosts it */
  const cfHosts: string[] = [];
  playPostseason(f.S, cs, (q) => {
    if (q.round === 'play_in') return q.key === '7v8' ? q.away : q.home;   /* DET beats CLE (7 seed); IND beats MIL; CLE beats IND (8 seed) */
    if (q.conference === 'East' && (q.round === 'first_round' || q.round === 'conference_semifinals')) {
      const s7 = ix.DET, s8 = ix.CLE; if (q.home === s7 || q.away === s7) return s7; if (q.home === s8 || q.away === s8) return s8;
    }
    if (q.round === 'conference_finals' && q.conference === 'East') cfHosts.push(NBA_TEAMS[q.series_home].code);
    return q.home;
  });
  T.chk('a play-in qualifier\'s home court follows its regular-season place, not its seed (CLE, 7th, is the 8 seed and hosts the 7 seed)', cfHosts.length > 0 && cfHosts.every((x) => x === 'CLE'), cfHosts);
}

/* 6 best of seven: the exact home order, termination at four wins */
{
  const H = 0, L = 1;
  for (const round of ['first_round', 'conference_semifinals', 'conference_finals', 'finals'] as const) {
    T.eq('2-2-1-1-1 in the ' + round, [1, 2, 3, 4, 5, 6, 7].map((n) => hostsGame(NBA_2021, round, n) ? 'H' : 'L').join(''), 'HHLLHLH');
  }
  T.eq('2-3-2 Finals through 2012-13', [1, 2, 3, 4, 5, 6, 7].map((n) => hostsGame(rulesFor(2013), 'finals', n) ? 'H' : 'L').join(''), 'HHLLLHH');
  /* scripted winners by game */
  const script = (ws: number[]) => (q: PostseasonGameReq) => ws[q.game_no - 1];
  let s = playSeries(NBA_2021, 'first_round', 'East', H, L, script([H, H, H, H, H, H, H]), []);
  T.eq('a sweep ends after game 4', [s.games.length, s.winner], [4, H]);
  s = playSeries(NBA_2021, 'first_round', 'East', H, L, script([H, L, H, L, H, L, L]), []);
  T.eq('a seven-game series: hosts H H L L H L H', s.games.map((g) => (g.home === H ? 'H' : 'L')).join(''), 'HHLLHLH');
  T.eq('... the low seed wins game 7 on the road', [s.games.length, s.winner], [7, L]);
  s = playSeries(NBA_2021, 'finals', null, H, L, script([L, L, L, H, L, H, H]), []);
  T.eq('a 4-1 series stops at game 5', [s.games.length, s.winner], [5, L]);
  /* random scripts: never more than 7 games, the winner has exactly 4 wins, the loser fewer */
  const rng = streamFor(99n, 0, STREAM.postseason);
  const lengths = new Set<number>(); let bad = 0;
  for (let i = 0; i < 4000; i++) {
    const r = playSeries(NBA_2021, 'first_round', 'East', H, L, (q) => (rng.nextDouble() < 0.6 ? q.series_home : q.series_away), []);
    const wH = r.games.filter((g) => g.winner === H).length, wL = r.games.length - wH;
    lengths.add(r.games.length);
    if (Math.max(wH, wL) !== 4 || Math.min(wH, wL) > 3 || r.games.length !== wH + wL || (r.winner === H) !== (wH === 4)) bad++;
    if (r.games.some((g, k) => (g.home === H) !== [1, 2, 5, 7].includes(k + 1))) bad++;
  }
  T.chk('4,000 random series: exactly four wins for the winner, fewer for the loser, the pattern always', bad === 0, bad);
  T.eq('... and every length from 4 to 7 occurs', [...lengths].sort(), [4, 5, 6, 7]);
  /* an in-progress series resumes from its observed games */
  const reqs: PostseasonGameReq[] = [];
  s = playSeries(NBA_2021, 'first_round', 'East', H, L, (q) => { reqs.push(q); return q.home; }, [
    { stage: 'playoffs', home: H, away: L, winner: H }, { stage: 'playoffs', home: H, away: L, winner: L }, { stage: 'playoffs', home: L, away: H, winner: L }]);
  T.eq('a series at 1-2 resumes with game 4 at the low seed', [reqs[0].game_no, reqs[0].home, reqs[0].score], [4, L, [1, 2]]);
  T.eq('... the observed games are kept as played', s.games.slice(0, 3).map((g) => [g.game_no, g.home, g.winner, g.observed]), [[1, H, H, true], [2, H, L, true], [3, L, L, true]]);
  T.throws('an observed game hosted by the wrong club is refused', () => playSeries(NBA_2021, 'first_round', 'East', H, L, () => H, [{ stage: 'playoffs', home: L, away: H, winner: H }]), /hosted by the other club/);
  T.throws('more observed games than the series can hold is refused', () => playSeries(NBA_2021, 'first_round', 'East', H, L, () => H,
    [1, 2, 3, 4, 5].map((n): PlayedGame => ({ stage: 'playoffs', home: [1, 2, 5, 7].includes(n) ? H : L, away: [1, 2, 5, 7].includes(n) ? L : H, winner: H }))), /ended after 4/);
}

/* 7 the fixed bracket: no reseeding */
{
  const recs: Record<string, [number, number]> = {};
  ['BOS', 'NY', 'PHI', 'TOR', 'BKN', 'CHI', 'CLE', 'DET', 'IND', 'MIL', 'ATL', 'CHA', 'MIA', 'ORL', 'WSH'].forEach((c, i) => { recs[c] = [70 - 3 * i, 12 + 3 * i]; });
  const f = fixture(NBA_2021, recs); f.S.decideDivisions(); const cs = seedConferences(f.S);
  const pairs: string[] = [];
  /* the 8 seed (DET, after the play-in) upsets the 1 seed; the bracket sends it to the 4-5 winner, never to the 2-7 side */
  const res = playPostseason(f.S, cs, (q) => {
    if (q.round === 'play_in') return q.home;
    if (q.conference === 'East' && q.round === 'first_round' && (q.home === ix.DET || q.away === ix.DET)) return ix.DET;
    if (q.conference === 'East' && q.game_no === 1) pairs.push(q.round + ' ' + [NBA_TEAMS[q.home].code, NBA_TEAMS[q.away].code].sort().join('-'));
    return q.series_home;
  });
  T.eq('the East seeds after the play-in', codes(res.seeds[0]), ['BOS', 'NY', 'PHI', 'TOR', 'BKN', 'CHI', 'CLE', 'DET']);
  T.chk('first round: 1-8, 4-5, 3-6, 2-7', ['first_round BKN-TOR', 'first_round CHI-PHI', 'first_round CLE-NY'].every((p) => pairs.includes(p)), pairs);
  T.chk('no reseeding: the 8 seed meets the 4-5 winner (TOR), not the lowest remaining seed of the other half', pairs.includes('conference_semifinals DET-TOR'), pairs);
  T.chk('the other semifinal is 2-7 winner vs 3-6 winner', pairs.includes('conference_semifinals NY-PHI'), pairs);
  T.eq('four first-round winners per conference, two semifinal winners, one champion each', [res.reached.conference_semifinals.length, res.reached.conference_finals.length, res.reached.finals.length], [8, 4, 2]);
  T.chk('the champion is a conference champion', res.conferenceChampions.includes(res.champion));
  /* the Finals: better record hosts; level records go to the two-club procedure across conferences */
  const g = fixture(NBA_2021, { BOS: [60, 22], SA: [60, 22] }); h2h(g.S, 'BOS', 'SA', 1, 1); g.S.divWinner[ix.BOS] = 1; g.S.divWinner[ix.SA] = 1; setConf(g.S, 'BOS', 40, 52); setConf(g.S, 'SA', 41, 52);
  T.chk('the Finals: level records, the two-club procedure across conferences (conference record here)', g.S.homeCourt(ix.SA, ix.BOS) > 0 && g.diags['tb:finals_home_court:2:conference_record'] === 1, g.diags);
  const h = fixture(NBA_2021, { BOS: [61, 21], SA: [60, 22] });
  T.chk('the Finals: the better record hosts', h.S.homeCourt(ix.BOS, ix.SA) > 0 && h.S.homeCourt(ix.SA, ix.BOS) < 0);
}

/* 8 observed games that do not fit the bracket are refused */
{
  const recs: Record<string, [number, number]> = {};
  ['BOS', 'NY', 'PHI', 'TOR', 'BKN', 'CHI', 'CLE', 'DET', 'IND', 'MIL', 'ATL', 'CHA', 'MIA', 'ORL', 'WSH'].forEach((c, i) => { recs[c] = [70 - 3 * i, 12 + 3 * i]; });
  const f = fixture(NBA_2021, recs); f.S.decideDivisions(); const cs = seedConferences(f.S);
  T.throws('a play-in game between clubs the standings do not pair is refused', () => playPostseason(f.S, cs, (q) => q.home, [{ stage: 'play_in', home: ix.DET, away: ix.ATL, winner: ix.DET }]), /do not fit the bracket/);
  T.throws('a play-in game hosted by the lower place is refused', () => playPostseason(f.S, cs, (q) => q.home, [{ stage: 'play_in', home: ix.DET, away: ix.CLE, winner: ix.DET }]), /hosted by the lower place/);
}

process.exit(T.done());
