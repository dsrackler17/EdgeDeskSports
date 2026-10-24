/* ===========================================================================
   COLLEGE BASEBALL — the NCAA Division I tournament: its format, rebuilt
   from the games themselves, and simulated.

   THE FORMAT (64 teams, unchanged 1999-2026):
   - 16 regionals of four teams, double elimination: game 1 the 1 seed
     against the 4, game 2 the 2 against the 3, game 3 the two losers
     (elimination), game 4 the two winners, game 5 the loser of game 4
     against the winner of game 3 (elimination), game 6 the winner of game 4
     against the winner of game 5, game 7 only if game 6's winner has a loss.
     The 1 seed hosts: home in its own games; the others are neutral games
     at its park;
   - 8 super regionals, best of three, between paired regionals' winners, at
     one of the two (a national seed hosts when it is there);
   - the College World Series in Omaha (neutral): two four-team double-
     elimination brackets, each fed by two super-regional pairs, then a best-
     of-three final between the brackets' winners.

   REBUILT FROM THE GAMES (nothing about a past bracket is typed in): the
   regional weekend is the first date from which four days of games split
   into sixteen groups of four teams who played only each other; a group's
   host is the team at home in a non-neutral game; game 1 is the host's first
   game. Super-regional pairs are the regional winners who then meet, the
   host the team at home. The two Omaha brackets are the first two days'
   pairs; the final is what follows the brackets. 2023's games carry no
   tournament flag, which is why the rebuild never reads one.
   =========================================================================== */
import { W } from './model.ts';

export interface G { game_id: string; date: string; home_id: string; away_id: string; home_runs: number; away_runs: number; neutral: number; park_key: string | null; home_name: string; away_name: string }
export interface Pod { teams: string[]; host: string | null; park_key: string | null; first: [[string, string], [string, string]]; winner: string; games: G[] }
export interface Super { pods: [number, number]; host: string | null; teams: [string, string]; winner: string; games: G[] }
export interface Cws { brackets: [[[number, number], [number, number]], [[number, number], [number, number]]]; bracket_winners: [string, string]; champion: string; games: G[]; final: G[] }
export interface Tournament { season: number; start: string; field: string[]; names: Record<string, string>; pods: Pod[]; supers: Super[]; cws: Cws }

const winnerOf = (g: G) => (g.home_runs > g.away_runs ? g.home_id : g.away_id);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function components(games: G[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let y = x; while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; } return r; };
  for (const g of games) for (const t of [g.home_id, g.away_id]) if (!parent.has(t)) parent.set(t, t);
  for (const g of games) { const a = find(g.home_id), b = find(g.away_id); if (a !== b) parent.set(a, b); }
  const by = new Map<string, string[]>(); for (const t of parent.keys()) { const r = find(t); if (!by.has(r)) by.set(r, []); by.get(r)!.push(t); }
  return [...by.values()];
}

/** the champion of a four-team double elimination: who won the group's last game */
function deChampion(games: G[]): string { const s = games.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1)); return winnerOf(s[s.length - 1]); }
function seriesWinner(games: G[], a: string, b: string): string | null { let wa = 0, wb = 0; for (const g of games) { const w = winnerOf(g); if (w === a) wa++; else if (w === b) wb++; } return wa >= 2 ? a : wb >= 2 ? b : null; }
/** the games that took place: final, both programs known (a game quarantined for conflicting scores still says who played whom) */
export function tournamentGames(season: number): G[] {
  return W.games(season).filter((g: any) => g.status === 'FINAL' && g.home_id && g.away_id && g.home_id !== g.away_id && g.home_runs != null && g.away_runs != null);
}

/** rebuild one season's tournament from its games, or null with the reason. Who advanced is read from who
    played in the next round (a disputed score never decides it); scores decide only the last round. */
export function reconstruct(season: number, gamesIn?: G[]): { t: Tournament | null; reason: string | null } {
  const all: G[] = (gamesIn || tournamentGames(season)).filter((g: G) => g.date >= season + '-05-20' && g.date <= season + '-07-05')
    .sort((a: G, b: G) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  const names: Record<string, string> = {}; for (const g of all) { names[g.home_id] = g.home_name; names[g.away_id] = g.away_name; }
  const dates = [...new Set(all.map((g) => g.date))];
  /* the regional weekend: of the windows of five days whose games split into sixteen four-team groups, the one
     holding the most games (a conference tournament's last day or a stray game never holds more) */
  let start: string | null = null; let pods: string[][] = []; let best = 0;
  for (const d of dates) {
    const win = all.filter((g) => g.date >= d && g.date <= addDays(d, 4));
    const comps = components(win).filter((c) => c.length === 4 && win.filter((g) => c.includes(g.home_id)).length >= 3);
    if (comps.length !== 16) continue;
    const t = new Set(comps.flat()); const inside = win.filter((g) => t.has(g.home_id));
    if (inside.length > best) { best = inside.length; pods = comps; start = inside.reduce((m, g) => (g.date < m ? g.date : m), inside[0].date); }
  }
  if (!start) {
    const last = (gamesIn || tournamentGames(season)).reduce((m: string, g: G) => (g.date > m ? g.date : m), '');
    return { t: null, reason: last && last < season + '-05-28' ? 'the warehouse holds ' + season + ' results only through ' + last : 'no weekend splits into sixteen four-team regionals' };
  }
  const field = pods.flat();
  const inPod = new Map<string, number>(); pods.forEach((c, i) => c.forEach((t) => inPod.set(t, i)));
  const regG = all.filter((g) => g.date >= start! && g.date <= addDays(start!, 4) && inPod.has(g.home_id) && inPod.get(g.home_id) === inPod.get(g.away_id));
  const supG = all.filter((g) => g.date >= addDays(start!, 5) && g.date <= addDays(start!, 12) && inPod.has(g.home_id) && inPod.has(g.away_id) && inPod.get(g.home_id) !== inPod.get(g.away_id));
  const cwsAll = all.filter((g) => g.date >= addDays(start!, 13) && g.date <= addDays(start!, 30) && inPod.has(g.home_id) && inPod.has(g.away_id));
  const inSupers = new Set(supG.flatMap((g) => [g.home_id, g.away_id]));
  const P: Pod[] = pods.map((teams, i) => {
    const games = regG.filter((g) => inPod.get(g.home_id) === i);
    const host = games.find((g) => !g.neutral)?.home_id || null;
    const park_key = host ? games.find((g) => !g.neutral && g.home_id === host)!.park_key : (games[0] && games[0].park_key) || null;
    const day1 = games.filter((g) => g.date === games[0].date);
    const g1 = (host ? day1.find((g) => g.home_id === host || g.away_id === host) : day1[0]) || games[0];
    const a: [string, string] = host ? [host, g1.home_id === host ? g1.away_id : g1.home_id] : [g1.home_id, g1.away_id];
    const rest = teams.filter((t) => !a.includes(t)) as [string, string];
    const adv = teams.filter((t) => inSupers.has(t));
    return { teams: [a[0], rest[0], rest[1], a[1]], host, park_key, first: [a, rest], winner: adv.length === 1 ? adv[0] : '', games };
  });
  if (P.some((p) => !p.winner)) return { t: null, reason: 'a regional with ' + P.find((p) => !p.winner)!.teams.filter((t) => inSupers.has(t)).length + ' teams in the super regionals' };
  const pairs = components(supG);
  if (pairs.length !== 8 || pairs.some((c) => c.length !== 2)) return { t: null, reason: 'the super regionals do not form eight pairs' };
  const inCws = new Set(cwsAll.flatMap((g) => [g.home_id, g.away_id]));
  const S: Super[] = pairs.map((c) => {
    const games = supG.filter((g) => c.includes(g.home_id));
    const host = games.find((g) => !g.neutral)?.home_id || null;
    const adv = c.filter((t) => inCws.has(t));
    return { pods: [inPod.get(c[0])!, inPod.get(c[1])!] as [number, number], host, teams: [c[0], c[1]] as [string, string], winner: adv.length === 1 ? adv[0] : '', games };
  });
  if (S.some((s) => !s.winner)) return { t: null, reason: 'a super regional whose winner did not play in Omaha alone' };
  const omaha = new Set(S.map((s) => s.winner));
  const cwsG = cwsAll.filter((g) => omaha.has(g.home_id) && omaha.has(g.away_id));
  const cdates = [...new Set(cwsG.map((g) => g.date))];
  const d1 = cwsG.filter((g) => g.date === cdates[0]), d2 = cwsG.filter((g) => g.date === cdates[1]);
  if (d1.length !== 2 || d2.length !== 2) return { t: null, reason: 'the College World Series does not open with two games on each of its first two days' };
  const supOf = new Map<string, number>(); S.forEach((s, i) => supOf.set(s.winner, i));
  const pairOf = (g: G): [number, number] => [supOf.get(g.home_id)!, supOf.get(g.away_id)!];
  const bracketTeams = [new Set(d1.flatMap((g) => [g.home_id, g.away_id])), new Set(d2.flatMap((g) => [g.home_id, g.away_id]))];
  const inB = (g: G, b: number) => bracketTeams[b].has(g.home_id) && bracketTeams[b].has(g.away_id);
  const final = cwsG.filter((g) => !inB(g, 0) && !inB(g, 1));
  const fin = new Set(final.flatMap((g) => [g.home_id, g.away_id]));
  const bw = [0, 1].map((b) => [...bracketTeams[b]].find((t) => fin.has(t)) || '') as [string, string];
  if (!bw[0] || !bw[1]) return { t: null, reason: 'the final is not between the two brackets\' winners' };
  const champion = seriesWinner(final, bw[0], bw[1]);
  if (!champion) return { t: null, reason: 'the final has no winner of two games' };
  const cws: Cws = { brackets: [[pairOf(d1[0]), pairOf(d1[1])], [pairOf(d2[0]), pairOf(d2[1])]], bracket_winners: bw, champion, games: cwsG, final };
  return { t: { season, start, field, names, pods: P, supers: S, cws }, reason: null };
}

/** each program's home park: the park of most of its non-neutral home games of the season before a date */
export function homeParks(season: number, before: string): Record<string, string> {
  const n = new Map<string, Map<string, number>>();
  for (const g of tournamentGames(season)) {
    if (g.neutral || !g.park_key || g.date >= before) continue;
    if (!n.has(g.home_id)) n.set(g.home_id, new Map()); const m = n.get(g.home_id)!; m.set(g.park_key, (m.get(g.park_key) || 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const [t, m] of n) out[t] = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  return out;
}

/** the simulation's structure of a rebuilt tournament (super-regional hosts left to the proxy unless given) */
export function structureOf(t: Tournament, homePark: Record<string, string>, o: { superHosts?: boolean } = {}): import('./sim.ts').Structure {
  return {
    pods: t.pods.map((p) => ({ teams: p.teams as [string, string, string, string], host: p.host, park: p.park_key })),
    supers: t.supers.map((s) => ({ pods: s.pods, host: o.superHosts ? (s.host || 'neutral') : null })),
    cws: t.cws.brackets,
    homePark
  };
}
