/* The NBA Cup (simulator/src/sports/nba/cup.ts) against the league's own Cups 2023-24..2025-26 (nba/data/games:
   the groups the Cup Nights form, the Group Play standings, the knockout field, its hosts, the semifinal pairings,
   the quarterfinal losers' game and the non-advancing clubs' games), the 2026-27 structure on the committed
   schedule, and SYNTHETIC cases for every tiebreak step. */
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { NBA_TEAMS, NBA_2026_27 } from '../src/sports/nba/config.ts';
import { cupStructure, cupStandings, quarterfinals, semifinalHost, losersGameHost, fillerGames, groupLabel, type CupGameResult } from '../src/sports/nba/cup.ts';
import { Xoshiro128, streamFor, STREAM } from '../src/core/prng.ts';

const require = createRequire(import.meta.url);
const D = require('../../nba/lib/data.js');
const VEN = require('../../nba/lib/venues.js');
const T = kit('NBA Cup');
const ix: Record<string, number> = {}; NBA_TEAMS.forEach((t, i) => { ix[t.id] = i; });
const code = (i: number) => NBA_TEAMS[i].code;
const tie = () => ({ rng: streamFor(7n, 0, STREAM.cup), diag() {}, flag() {} });

/* the league's Cups as they were played (observed dates; the 2026-27 ones are config.ts) */
const PAST: Record<number, { nights: string[]; qf: string[]; window: [string, string] }> = {
  2024: { nights: ['2023-11-03', '2023-11-10', '2023-11-14', '2023-11-17', '2023-11-21', '2023-11-24', '2023-11-28'], qf: ['2023-12-04', '2023-12-05'], window: ['2023-12-04', '2023-12-08'] },
  2025: { nights: ['2024-11-12', '2024-11-15', '2024-11-19', '2024-11-22', '2024-11-26', '2024-11-29', '2024-12-03'], qf: ['2024-12-10', '2024-12-11'], window: ['2024-12-09', '2024-12-16'] },
  2026: { nights: ['2025-10-31', '2025-11-07', '2025-11-14', '2025-11-21', '2025-11-25', '2025-11-26', '2025-11-28'], qf: ['2025-12-09', '2025-12-10'], window: ['2025-12-09', '2025-12-15'] }
};
const regular = (s: number) => D.games([s]).filter((g: any) => g.type === 'R' && g.scope === 'regular_season');
function prior(s: number): Array<[number, number]> {
  const w = new Array(30).fill(0), g = new Array(30).fill(0);
  for (const x of regular(s)) { g[ix[x.home_id]]++; g[ix[x.away_id]]++; w[ix[x.hs > x.as ? x.home_id : x.away_id]]++; }
  return w.map((v, i) => [v, g[i]]);
}
function homeCities(games: any[]): Record<number, any> {
  const cnt: Record<number, Record<string, number>> = {};
  for (const g of games) if (!g.neutral && g.city) { const m = (cnt[ix[g.home_id]] = cnt[ix[g.home_id]] || {}); m[g.city] = (m[g.city] || 0) + 1; }
  const out: Record<number, any> = {}; for (let t = 0; t < 30; t++) { const m = cnt[t]; out[t] = VEN.geo(Object.keys(m).sort((a, b) => m[b] - m[a])[0]); }
  return out;
}

let cross = 0, crossHit = 0, within = 0, withinPreferred = 0, qfOk = 0, sfOk = 0, losersOk = 0;
for (const S of [2024, 2025, 2026]) {
  const P = PAST[S];
  const reg = regular(S);
  const rows = reg.map((g: any) => ({ date: g.date, home: ix[g.home_id], away: ix[g.away_id], g }));
  const st = cupStructure(rows, NBA_TEAMS, P.nights);
  T.eq(S + ': the Cup Nights hold 60 games forming six groups of five within a conference', [st.gameIdx.length, st.groups.map((g) => g.length).join(','), st.groupConf.join('')], [60, '5,5,5,5,5,5', '000111']);
  const results: CupGameResult[] = st.gameIdx.map((k) => {
    const g = rows[k].g, ot = Number(g.ot) > 0;
    return { home: rows[k].home, away: rows[k].away, margin: g.hs - g.as, ot, regHome: g.h_q1 + g.h_q2 + g.h_q3 + g.h_q4, regAway: g.a_q1 + g.a_q2 + g.a_q3 + g.a_q4 };
  });
  T.chk(S + ': every overtime game was level after regulation (the differential it counts is 0)', results.every((r) => !r.ot || r.regHome === r.regAway));
  const cs = cupStandings(st, 30, results, prior(S - 1), tie());
  /* the quarterfinals: pairings and hosts */
  const want = reg.filter((g: any) => P.qf.includes(g.date)).map((g: any) => code(ix[g.away_id]) + '@' + code(ix[g.home_id])).sort();
  const got = quarterfinals(cs).map((q) => code(q.away) + '@' + code(q.home)).sort();
  T.eq(S + ': the four quarterfinals and their hosts', got, want);
  if (JSON.stringify(got) === JSON.stringify(want)) qfOk += 4;
  /* the semifinals (neutral then): the quarterfinal winners of each conference */
  const qfGames = reg.filter((g: any) => P.qf.includes(g.date));
  const win = (g: any) => ix[g.hs > g.as ? g.home_id : g.away_id], lose = (g: any) => ix[g.hs > g.as ? g.away_id : g.home_id];
  const inWin = reg.filter((g: any) => g.date >= P.window[0] && g.date <= P.window[1] && !P.qf.includes(g.date));
  for (const c of [0, 1]) {
    const qs = qfGames.filter((g: any) => (NBA_TEAMS[ix[g.home_id]].conference === 'East' ? 0 : 1) === c);
    const ws = qs.map(win).sort(), ls = qs.map(lose);
    const sf = inWin.find((g: any) => ws.includes(ix[g.home_id]) && ws.includes(ix[g.away_id]));
    T.chk(S + ' ' + ['East', 'West'][c] + ': the semifinal is the two quarterfinal winners', !!sf);
    if (sf) sfOk++;
    /* the losers' game, and its host by the Estimated rule */
    const lg = inWin.find((g: any) => ls.includes(ix[g.home_id]) && ls.includes(ix[g.away_id]));
    const hosted = (t: number) => qs.some((g: any) => ix[g.home_id] === t);
    const [h] = losersGameHost(cs, c, ls[0], hosted(ls[0]), ls[1], hosted(ls[1]));
    T.chk(S + ' ' + ['East', 'West'][c] + ': the quarterfinal losers\' game is hosted as the Estimated rule says (' + (lg ? code(ix[lg.away_id]) + '@' + code(ix[lg.home_id]) : 'missing') + ')', !!lg && ix[lg.home_id] === h);
    if (lg && ix[lg.home_id] === h) losersOk++;
    T.eq(S + ' ' + ['East', 'West'][c] + ': the higher seed would host the semifinal (2026-27 rule)', semifinalHost(cs, c, ws[0], ws[1]).map(code).sort(), ws.map(code).sort());
  }
  /* the non-advancing clubs' games */
  const ko = new Set(cs.seeds.flat());
  const fill = inWin.filter((g: any) => !ko.has(ix[g.home_id]) && !ko.has(ix[g.away_id]));
  const per = new Array(30).fill(0), hm = new Array(30).fill(0);
  for (const g of fill) { per[ix[g.home_id]]++; per[ix[g.away_id]]++; hm[ix[g.home_id]]++; }
  T.chk(S + ': 22 games for the 22 non-advancing clubs, two each, one at home', fill.length === 22 && [...Array(30).keys()].every((t) => ko.has(t) ? per[t] === 0 : per[t] === 2 && hm[t] === 1), { n: fill.length });
  const base: Record<string, number> = {};
  for (const g of reg) { if (g.date >= P.window[0] && g.date <= P.window[1]) continue; const k = [ix[g.home_id], ix[g.away_id]].sort((a, b) => a - b).join('|'); base[k] = (base[k] || 0) + 1; }
  const n3 = (a: number, b: number) => (base[[a, b].sort((x, y) => x - y).join('|')] || 0) === 3;
  const crossG = fill.filter((g: any) => NBA_TEAMS[ix[g.home_id]].conference !== NBA_TEAMS[ix[g.away_id]].conference);
  for (const g of fill) if (!crossG.includes(g)) { within++; if (n3(ix[g.home_id], ix[g.away_id])) withinPreferred++; }
  /* the cross-conference stand-in: same place from the bottom, within the distance */
  const geo = homeCities(reg);
  const others = cs.places.map((p) => p.slice(4));
  const sim = fillerGames({ others, need: [...Array(30).keys()].map((t) => (ko.has(t) ? 0 : 2)), homeNeed: [...Array(30).keys()].map((t) => (ko.has(t) ? 0 : 1)), preferred: n3, playing: () => false,
    km: (a, b) => VEN.km(geo[a], geo[b]), maxKm: NBA_2026_27.cup.format.cross_conference_max_km, cross: 2, rng: streamFor(11n, S, STREAM.cup), diag() {} });
  const pairKey = (a: number, b: number) => [code(a), code(b)].sort().join('-');
  const simCross = sim.filter((g) => g.cross).map((g) => pairKey(g.home, g.away)).sort(), realCross = crossG.map((g: any) => pairKey(ix[g.home_id], ix[g.away_id])).sort();
  T.eq(S + ': the cross-conference pairs the stand-in picks are the league\'s', simCross, realCross);
  cross += realCross.length; crossHit += simCross.filter((k) => realCross.includes(k)).length;
  /* ... and its whole schedule is a valid one */
  const sp = new Array(30).fill(0), sh = new Array(30).fill(0);
  for (const g of sim) { sp[g.home]++; sp[g.away]++; sh[g.home]++; }
  T.chk(S + ': the stand-in gives each non-advancing club two games, one at home, within-conference pairings all otherwise three times', sim.length === 22 && [...Array(30).keys()].every((t) => ko.has(t) ? sp[t] === 0 : sp[t] === 2 && sh[t] === 1) && sim.filter((g) => !g.cross).every((g) => n3(g.home, g.away) && NBA_TEAMS[g.home].conference === NBA_TEAMS[g.away].conference));
}
T.eq('history: quarterfinal pairings and hosts reproduced', qfOk, 12);
T.eq('history: semifinal pairings reproduced', sfOk, 6);
T.eq('history: quarterfinal losers\' hosts reproduced by the Estimated rule', losersOk, 6);
T.eq('history: cross-conference pairs reproduced by the Estimated rule', [crossHit, cross], [6, 6]);
T.eq('history: within-conference non-advancing games between clubs otherwise scheduled three times', [withinPreferred, within], [60, 60]);

/* 2026-27 on the committed schedule */
{
  const cf = NBA_2026_27.cup.format;
  const reg = regular(2027), rows = reg.map((g: any) => ({ date: g.date, home: ix[g.home_id], away: ix[g.away_id] }));
  const st = cupStructure(rows, NBA_TEAMS, cf.cup_nights);
  T.eq('2026-27: 60 Group Play games on the seven Cup Nights, six groups of five', [st.gameIdx.length, st.groups.length], [60, 6]);
  T.eq('2026-27: the groups the schedule implies', st.groups.map((g, i) => groupLabel(st, NBA_TEAMS, i)), [
    'East group 1 (ATL, BOS, CHA, CHI, WSH)', 'East group 2 (BKN, DET, MIL, ORL, TOR)', 'East group 3 (CLE, IND, MIA, NY, PHI)',
    'West group 1 (DAL, DEN, HOU, PHX, UTAH)', 'West group 2 (GS, LAL, POR, SA, SAC)', 'West group 3 (LAC, MEM, MIN, NO, OKC)']);
  T.chk('2026-27: the window ' + cf.window.join('..') + ' holds no game yet (the Cup-dependent games are not scheduled)', reg.every((g: any) => g.date < cf.window[0] || g.date > cf.window[1]));
  T.chk('2026-27: every Estimated Cup date is inside the window, the Championship two days after it', [cf.dates.quarterfinal, cf.dates.filler_1, cf.dates.semifinal, cf.dates.filler_2].every((d) => d >= cf.window[0] && d <= cf.window[1]) && cf.dates.championship > cf.window[1]);
  const hm = new Array(30).fill(0); for (const r of rows) hm[r.home]++;
  T.chk('2026-27: every club has 40 home games of its 80 (so each non-advancing club hosts one of its two)', hm.every((h) => h === 40));
  T.chk('2026-27: the last Cup Night is before the window', Math.max(...st.gameIdx.map((k) => Date.parse(rows[k].date))) < Date.parse(cf.window[0]));
}

/* SYNTHETIC tiebreak cases on the 2026-27 groups */
{
  const reg = regular(2027), rows = reg.map((g: any) => ({ date: g.date, home: ix[g.home_id], away: ix[g.away_id] }));
  const st = cupStructure(rows, NBA_TEAMS, NBA_2026_27.cup.format.cup_nights);
  const games = st.gameIdx.map((k) => rows[k]);
  const pri = prior(2026);
  /* every game won by the club listed first in `order` within its group, by `m` points, unless overridden */
  const make = (over: Record<string, { w: string; m?: number; ot?: boolean; sim?: boolean; base?: number }>, by = 5): CupGameResult[] => games.map((g) => {
    const k = [code(g.home), code(g.away)].sort().join('-'), o = over[k];
    const gi = st.groupOf[g.home], pos = (t: number) => st.groups[gi].indexOf(t);
    const w = o ? ix[NBA_TEAMS.find((t) => t.code === o.w)!.id] : pos(g.home) < pos(g.away) ? g.home : g.away;
    const m = o && o.m != null ? o.m : by;
    const margin = w === g.home ? m : -m;
    const b = o && o.base != null ? o.base : 100;
    return { home: g.home, away: g.away, margin, ot: !!(o && o.ot), regHome: o && o.sim ? null : b + (w === g.home ? (o && o.ot ? 0 : m) : 0), regAway: o && o.sim ? null : b + (w === g.away ? (o && o.ot ? 0 : m) : 0) };
  });
  const G1 = st.groups[0].map(code);   // ATL BOS CHA CHI WSH
  T.eq('synthetic: the default fixture orders each group by its listed order', cupStandings(st, 30, make({}), pri, tie()).groupOrder[0].map(code), G1);
  /* a circular three-way tie at 3-1: ATL beat BOS, BOS beat CHA, CHA beat ATL; point differential decides */
  const circ = { 'ATL-CHA': { w: 'CHA', m: 3 }, 'ATL-BOS': { w: 'ATL', m: 9 }, 'BOS-CHA': { w: 'BOS', m: 1 } };
  const c1 = cupStandings(st, 30, make(circ), pri, tie());
  T.eq('synthetic: a circular 3-1 tie goes to point differential (ATL +' + (5 + 5 + 9 - 3) + ', CHA +' + (5 + 5 + 3 - 1) + ', BOS +' + (5 + 5 + 1 - 9) + ')', c1.groupOrder[0].slice(0, 3).map(code), ['ATL', 'CHA', 'BOS']);
  /* overtime counts 0: ATL's 9-point win over BOS came in overtime -> CHA +12, BOS +11, ATL +7 */
  const c2 = cupStandings(st, 30, make({ ...circ, 'ATL-BOS': { w: 'ATL', m: 9, ot: true } }), pri, tie());
  T.eq('synthetic: an overtime game\'s differential counts 0', c2.groupOrder[0].slice(0, 3).map(code), ['CHA', 'BOS', 'ATL']);
  /* head-to-head first for two clubs: CHA beats ATL, both 3-1 -> CHA */
  const two = { 'ATL-CHA': { w: 'CHA' }, 'BOS-CHA': { w: 'CHA' }, 'ATL-BOS': { w: 'ATL' } };
  const c3 = cupStandings(st, 30, make(two), pri, tie());
  T.eq('synthetic: two clubs level on record: head-to-head', c3.groupOrder[0].slice(0, 2).map(code), ['CHA', 'ATL']);
  /* equal differential -> total points (regulation only): ATL's win over CHI was the higher-scoring game */
  const even = { 'ATL-CHA': { w: 'CHA', m: 4 }, 'ATL-BOS': { w: 'ATL', m: 4 }, 'BOS-CHA': { w: 'BOS', m: 4 } };
  let flags: string[] = [];
  const diags: string[] = [];
  const c4 = cupStandings(st, 30, make({ ...even, 'ATL-CHI': { w: 'ATL', base: 120 } }), pri, { rng: streamFor(7n, 0, STREAM.cup), diag(k) { diags.push(k); }, flag(k) { flags.push(k); } });
  T.eq('synthetic: equal differential goes to total points (ATL first), then the 2025-26 record', [c4.groupOrder[0][0], diags.includes('cup:tb:group:total_points'), flags.includes('cup_total_points_unmodelled')].map((x) => (typeof x === 'number' ? code(x) : x)), ['ATL', true, false]);
  flags = [];
  const c5 = cupStandings(st, 30, make({ ...even, 'ATL-CHI': { w: 'ATL', sim: true } }), pri, { rng: streamFor(7n, 0, STREAM.cup), diag() {}, flag(k) { flags.push(k); } });
  const pct = (c: string) => { const p = pri[ix[NBA_TEAMS.find((t) => t.code === c)!.id]]; return p[0] / p[1]; };
  const byPrior = ['ATL', 'BOS', 'CHA'].sort((a, b) => pct(b) - pct(a));
  T.eq('synthetic: a simulated game makes total points unmeasurable: the 2025-26 record decides, and it is flagged', [c5.groupOrder[0].slice(0, 3).map(code), flags.includes('cup_total_points_unmodelled')], [byPrior, true]);
  /* nothing separates them: a seeded random drawing, flagged */
  flags = [];
  const flat: Array<[number, number]> = pri.map(() => [41, 82]);
  const c6 = cupStandings(st, 30, make({ ...even, 'ATL-CHI': { w: 'ATL', sim: true } }), flat, { rng: streamFor(7n, 0, STREAM.cup), diag() {}, flag(k) { flags.push(k); } });
  T.chk('synthetic: when every step is level, a random drawing (flagged)', flags.includes('cup_random_drawing') && new Set(c6.groupOrder[0].slice(0, 3).map(code)).size === 3);
  /* the wild card: the best runner-up; seeds 1-3 the winners by record, the wild card 4th */
  const c7 = cupStandings(st, 30, make({}), pri, tie());
  T.chk('synthetic: seeds are the three group winners then a runner-up', c7.seeds.every((s, c) => s.length === 4 && s.slice(0, 3).every((t) => c7.groupOrder.some((g) => g[0] === t)) && c7.groupOrder.some((g) => g[1] === s[3]) && st.groupConf[st.groupOf[s[0]]] === c));
  T.chk('synthetic: the Group Play standings list all 15 clubs of each conference once', c7.places.every((p, c) => p.length === 15 && new Set(p).size === 15 && p.every((t) => (NBA_TEAMS[t].conference === 'East' ? 0 : 1) === c)));
  const q = quarterfinals(c7);
  T.chk('synthetic: the best winner hosts the wild card, the second hosts the third', q.every((g) => (g.home === c7.seeds[g.conf][0] && g.away === c7.seeds[g.conf][3]) || (g.home === c7.seeds[g.conf][1] && g.away === c7.seeds[g.conf][2])));
  /* the filler games with a pairing already scheduled, and a single home game owed */
  const others = c7.places.map((p) => p.slice(4));
  const need = new Array(30).fill(0), homeNeed = new Array(30).fill(0);
  for (const c of others) for (const t of c) { need[t] = 2; homeNeed[t] = 1; }
  const runs = 200; let ok = 0;
  for (let r = 0; r < runs; r++) {
    const fg = fillerGames({ others, need, homeNeed, preferred: () => true, playing: () => false, km: () => 1000, maxKm: 2500, cross: 2, rng: streamFor(3n, r, STREAM.cup), diag() {} });
    const p = new Array(30).fill(0), h = new Array(30).fill(0), seen = new Set<string>();
    let dup = false; for (const g of fg) { p[g.home]++; p[g.away]++; h[g.home]++; const k = [g.home, g.away].sort().join('|'); if (seen.has(k)) dup = true; seen.add(k); }
    if (!dup && fg.length === 22 && fg.filter((g) => g.cross).length === 2 && others.flat().every((t) => p[t] === 2 && h[t] === 1)) ok++;
  }
  T.eq('synthetic: 200 random filler schedules, each 22 games, two cross-conference, no pairing twice, one home game each', ok, runs);
  T.throws('synthetic: a Cup Night game outside a group of five is refused', () => cupStructure(rows.concat([{ date: NBA_2026_27.cup.format.cup_nights[0], home: 0, away: 29 }]), NBA_TEAMS, NBA_2026_27.cup.format.cup_nights), /Cup Nights/);
  T.chk('synthetic: Xoshiro128 is the generator the Cup draws from', streamFor(1n, 0, STREAM.cup) instanceof Xoshiro128);
}

process.exit(T.done());
