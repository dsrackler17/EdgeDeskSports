/* ===========================================================================
   THE EMIRATES NBA CUP, AND THE 30 REGULAR-SEASON GAMES IT DECIDES.

   The format is the league's text (nba.com "Emirates NBA Cup 101", 2026-27;
   config.ts nba_cup_format, VERIFIED):
     GROUP PLAY   six groups of five within each conference, one game against
                  each group rival on the Cup Nights (the only games played on
                  them). The groups are not recalled: cupStructure() reads them
                  off the schedule (the 60 games on the Cup Nights form six
                  complete groups of five).
     STANDINGS    by Group Play record; ties within a group: head-to-head in
                  Group Play, point differential in Group Play, total points in
                  Group Play (overtime never counts: an overtime game's
                  differential is 0 and its overtime points are dropped), the
                  previous regular season's record, a random drawing.
     KNOCKOUT     each group winner and one wild card per conference (the best
                  Group Play record among the three runners-up; the same
                  protocol without head-to-head). In each conference the two
                  best group winners host: the best hosts the wild card, the
                  second hosts the third. Semifinals at the higher seed's arena.
                  Quarterfinals and semifinals count as regular-season games;
                  the Championship (Indianapolis) does not.
     THE OTHERS   the 22 clubs that do not advance play two regular-season
                  games each; the two quarterfinal losers of each conference
                  play each other.

   What the league does not publish is Estimated here and labelled so
   (config.ts cup_dependent_schedule): the exact formula behind the 22 clubs'
   pairings, who hosts the quarterfinal losers' game, and the dates. The
   stand-ins, each reproduced against 2023-24..2025-26 (nba_cup.test.ts):
     cross-conference  the text: two games "between bottom-finishing teams ...
                       subject to travel constraints". Here: the same Group
                       Play place in both conferences, from the bottom up, the
                       first two whose arenas are within the configured
                       distance (2,500 km) — 6 of 6 pairs in history.
     within conference the text: teams "otherwise scheduled to play each other
                       three times ... wherever possible". Here: a pairing
                       drawn at random among those (each club its remaining
                       games, never a pairing twice); in history every one of
                       the 60 such games was such a pairing.
     home and away     the 2026-27 schedule gives every club 40 home games of
                       80, so each non-advancing club hosts one of its two
                       (every one did in history: 41 home games). The
                       quarterfinal losers' game: the loser that was away in
                       its quarterfinal hosts; if both or neither were, the
                       higher seed — 6 of 6 in history.
   A game the league has already put on the schedule is always used as it is.
   =========================================================================== */
import type { NbaTeam } from './rules.ts';
import type { Xoshiro128 } from '../../core/prng.ts';

export interface CupFormat {
  /** the Cup Nights, local dates (the data's `date`): the only games played on them are Group Play games */
  cup_nights: string[];
  /** the season (end year) whose regular-season record is the fourth tiebreaker */
  prior_season: number;
  /** local dates [first, last] that hold only Cup-dependent games (the base schedule has none) */
  window: [string, string];
  /** Estimated local dates of the Cup-dependent games and the Championship while they are not on the schedule */
  dates: { quarterfinal: string; filler_1: string; semifinal: string; filler_2: string; championship: string };
  semifinal_site: 'higher_seed';
  championship_city: string;
  /** Estimated: the longest trip between the two arenas of a cross-conference game for two bottom finishers */
  cross_conference_max_km: number;
}

export interface CupStructure {
  /** six groups of five team indices, East first; a group's clubs in code order */
  groups: number[][];
  /** team index -> group index */
  groupOf: number[];
  /** group index -> conference (0 East, 1 West) */
  groupConf: number[];
}

/** the groups the Cup Nights' games form: throws unless they are six complete groups of five, each within one
    conference, every club two home and two away */
export function cupStructure(games: Array<{ date: string; home: number; away: number }>, teams: NbaTeam[], nights: string[]): CupStructure & { gameIdx: number[] } {
  const T = teams.length, idx: number[] = [];
  const adj: Array<Set<number>> = teams.map(() => new Set()), home = new Array(T).fill(0);
  games.forEach((g, k) => {
    if (!nights.includes(g.date)) return;
    idx.push(k);
    if (adj[g.home].has(g.away)) throw new Error('two Cup Night games between ' + teams[g.home].code + ' and ' + teams[g.away].code);
    adj[g.home].add(g.away); adj[g.away].add(g.home); home[g.home]++;
  });
  if (idx.length !== 60) throw new Error(idx.length + ' games on the Cup Nights (60 expected: six groups of five, one game per pair)');
  const seen = new Array(T).fill(false), groups: number[][] = [];
  for (let t = 0; t < T; t++) {
    if (seen[t]) continue;
    const g = [t]; seen[t] = true;
    for (let i = 0; i < g.length; i++) for (const v of adj[g[i]]) if (!seen[v]) { seen[v] = true; g.push(v); }
    groups.push(g);
  }
  for (const g of groups) {
    if (g.length !== 5 || g.some((t) => adj[t].size !== 4)) throw new Error('the Cup Nights do not form groups of five: ' + g.map((t) => teams[t].code).join(' '));
    if (new Set(g.map((t) => teams[t].conference)).size !== 1) throw new Error('a group spans both conferences: ' + g.map((t) => teams[t].code).join(' '));
    if (g.some((t) => home[t] !== 2)) throw new Error('a group club does not play two home and two away: ' + g.map((t) => teams[t].code + ' ' + home[t]).join(' '));
    g.sort((a, b) => (teams[a].code < teams[b].code ? -1 : 1));
  }
  const conf = (g: number[]) => (teams[g[0]].conference === 'East' ? 0 : 1);
  groups.sort((a, b) => conf(a) - conf(b) || (teams[a[0]].code < teams[b[0]].code ? -1 : 1));
  if (groups.filter((g) => conf(g) === 0).length !== 3) throw new Error('not three groups per conference');
  const groupOf = new Array(T).fill(-1); groups.forEach((g, i) => g.forEach((t) => { groupOf[t] = i; }));
  return { groups, groupOf, groupConf: groups.map(conf), gameIdx: idx };
}

/** a group label: the conference and the group's clubs (the league's letters are not in the data) */
export function groupLabel(st: CupStructure, teams: NbaTeam[], g: number): string {
  return (st.groupConf[g] === 0 ? 'East' : 'West') + ' group ' + (g % 3 + 1) + ' (' + st.groups[g].map((t) => teams[t].code).join(', ') + ')';
}

/** one Group Play game for the standings: its winner by the final margin; its differential and points without overtime */
export interface CupGameResult {
  home: number; away: number;
  /** the final margin (overtime included), never 0 */
  margin: number;
  ot: boolean;
  /** regulation points (a simulated game's drawn from the served total); null when unknown, and the total-points step is then skipped (flagged) */
  regHome: number | null; regAway: number | null;
}
export interface CupTieContext { rng: Xoshiro128; diag(key: string, n?: number): void; flag(key: string): void }
type Frac = [number, number];
const cmp = (a: Frac, b: Frac) => a[0] * b[1] - b[0] * a[1];   // > 0: a better

export interface CupStandings {
  /** per group, five clubs best first */
  groupOrder: number[][];
  /** per conference: seeds 1-4 (the three group winners by the protocol, then the wild card) */
  seeds: number[][];
  /** per conference: the Group Play standings, 15 clubs (1-4 the knockout clubs by seed, then the rest) */
  places: number[][];
  wins: number[];
}

export function cupStandings(st: CupStructure, T: number, results: CupGameResult[], prior: Frac[], ctx: CupTieContext): CupStandings {
  const W = new Array(T).fill(0), G = new Array(T).fill(0), PD = new Array(T).fill(0), PTS = new Array(T).fill(0), unk = new Array(T).fill(false);
  const beat = new Map<number, Set<number>>();
  for (const r of results) {
    const w = r.margin > 0 ? r.home : r.away, l = w === r.home ? r.away : r.home;
    W[w]++; G[r.home]++; G[r.away]++;
    if (!beat.has(w)) beat.set(w, new Set()); beat.get(w)!.add(l);
    if (!r.ot) { PD[r.home] += r.margin; PD[r.away] -= r.margin; }
    if (r.regHome == null || r.regAway == null) { unk[r.home] = true; unk[r.away] = true; } else { PTS[r.home] += r.regHome; PTS[r.away] += r.regAway; }
  }
  for (const g of st.groups) for (const t of g) if (G[t] !== 4) throw new Error('a group club has ' + G[t] + ' Group Play results (4 expected)');
  type Step = { id: string; v: (t: number, S: number[]) => Frac | null };
  const h2h: Step = { id: 'head_to_head', v: (t, S) => [S.filter((o) => o !== t && beat.get(t)?.has(o)).length, 1] };
  const pd: Step = { id: 'point_differential', v: (t) => [PD[t], 1] };
  const pts: Step = { id: 'total_points', v: (t) => (unk[t] ? null : [PTS[t], 1]) };
  const rec: Step = { id: 'prior_record', v: (t) => prior[t] };
  /* order a set tied on record: the first step that tells the clubs apart orders the levels it separates; a group still
     level starts again from the first step (the league's Paragraph L.2.c practice; the Cup text lists the steps only) */
  const rank = (S: number[], steps: Step[], mode: string): number[] => {
    if (S.length <= 1) return S.slice();
    for (const s of steps) {
      const v = S.map((t) => s.v(t, S));
      if (v.some((x) => x == null || x[1] === 0)) { if (s.id === 'total_points') { ctx.diag('cup:tb:total_points_unmodelled'); ctx.flag('cup_total_points_unmodelled'); } continue; }
      const order = S.map((_, i) => i).sort((i, j) => cmp(v[j] as Frac, v[i] as Frac) || i - j);
      const levels: number[][] = [];
      for (let k = 0; k < order.length; k++) {
        if (k > 0 && cmp(v[order[k - 1]] as Frac, v[order[k]] as Frac) === 0) levels[levels.length - 1].push(S[order[k]]);
        else levels.push([S[order[k]]]);
      }
      if (levels.length === 1) continue;
      ctx.diag('cup:tb:' + mode + ':' + s.id);
      return levels.flatMap((l) => rank(l, steps, mode));
    }
    const i = ctx.rng.nextInt(S.length);
    ctx.diag('cup:tb:' + mode + ':random_drawing'); ctx.flag('cup_random_drawing');
    return [S[i]].concat(rank(S.filter((_, j) => j !== i), steps, mode));
  };
  const byRecord = (S: number[], steps: Step[], mode: string): number[] => {
    const lv = [...new Set(S.map((t) => W[t]))].sort((a, b) => b - a);
    return lv.flatMap((w) => rank(S.filter((t) => W[t] === w), steps, mode));
  };
  const groupOrder = st.groups.map((g) => byRecord(g, [h2h, pd, pts, rec], 'group'));
  const seeds: number[][] = [], places: number[][] = [];
  for (const c of [0, 1]) {
    const gs = groupOrder.filter((_, i) => st.groupConf[i] === c);
    /* group winners never met in Group Play: head-to-head cannot be measured between them and is skipped */
    const winners = byRecord(gs.map((g) => g[0]), [h2h, pd, pts, rec], 'seed');
    const wild = byRecord(gs.map((g) => g[1]), [pd, pts, rec], 'wild_card')[0];
    const s = winners.concat([wild]); seeds.push(s);
    /* the other eleven (the "Group Play standings in each conference"): record, then the wild-card protocol across
       groups. Not each group's own order: the league's cross-conference pairings 2023-24..2025-26 follow this one */
    const rest = byRecord(gs.flat().filter((t) => !s.includes(t)), [pd, pts, rec], 'place');
    places.push(s.concat(rest));
  }
  return { groupOrder, seeds, places, wins: W };
}

/** the four quarterfinals: per conference the best group winner hosts the wild card, the second hosts the third */
export function quarterfinals(cs: CupStandings): Array<{ conf: number; home: number; away: number }> {
  return [0, 1].flatMap((c) => [{ conf: c, home: cs.seeds[c][0], away: cs.seeds[c][3] }, { conf: c, home: cs.seeds[c][1], away: cs.seeds[c][2] }]);
}
/** a semifinal: at the higher seed's arena */
export function semifinalHost(cs: CupStandings, c: number, a: number, b: number): [number, number] {
  return cs.seeds[c].indexOf(a) < cs.seeds[c].indexOf(b) ? [a, b] : [b, a];
}
/** the quarterfinal losers' game (Estimated host): the loser that was away in its quarterfinal hosts; if both or neither were, the higher seed */
export function losersGameHost(cs: CupStandings, c: number, a: number, aHosted: boolean, b: number, bHosted: boolean): [number, number] {
  if (aHosted !== bHosted) return aHosted ? [b, a] : [a, b];
  return semifinalHost(cs, c, a, b);
}

export interface FillerInputs {
  /** per conference: the clubs that did not advance, best Group Play place first */
  others: number[][];
  /** games each club still needs (0-2) */
  need: number[];
  /** home games each club still needs (0..need) */
  homeNeed: number[];
  /** a within-conference pairing the league prefers: otherwise scheduled three times */
  preferred: (a: number, b: number) => boolean;
  /** a pairing already in the window (never twice) */
  playing: (a: number, b: number) => boolean;
  km: (a: number, b: number) => number;
  maxKm: number;
  /** cross-conference games still to schedule */
  cross: number;
  rng: Xoshiro128;
  diag(key: string, n?: number): void;
}
export interface FillerGame { home: number; away: number; slot: 1 | 2; cross: boolean }

/** the non-advancing clubs' games (Estimated stand-in for the league's formula; see the header) */
export function fillerGames(f: FillerInputs): FillerGame[] {
  const need = f.need.slice(), edges: Array<[number, number, boolean]> = [];
  const shuffle = <X>(xs: X[]): X[] => { for (let i = xs.length - 1; i > 0; i--) { const j = f.rng.nextInt(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  /* 1 cross-conference: the same Group Play place in both conferences, from the bottom up, within the distance */
  const [E, Wc] = f.others;
  let x = f.cross;
  for (let p = Math.min(E.length, Wc.length) - 1; p >= 0 && x > 0; p--) {
    const e = E[p], w = Wc[p];
    if (need[e] > 0 && need[w] > 0 && !f.playing(e, w) && f.km(e, w) <= f.maxKm) { edges.push([e, w, true]); need[e]--; need[w]--; x--; }
  }
  if (x > 0) {
    /* fallback: the shortest remaining trips among the clubs that still need a game, bottom places first */
    f.diag('cup:filler:cross_fallback');
    const cand: Array<[number, number, number]> = [];
    for (const e of E) for (const w of Wc) if (need[e] > 0 && need[w] > 0 && !f.playing(e, w) && !edges.some(([a, b]) => (a === e && b === w))) cand.push([f.km(e, w), e, w]);
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, e, w] of cand) { if (x === 0) break; if (need[e] > 0 && need[w] > 0) { edges.push([e, w, true]); need[e]--; need[w]--; x--; } }
    if (x > 0) throw new Error('no cross-conference pairing left for the NBA Cup filler games');
  }
  /* 2 within each conference: a random simple pairing of the remaining games, preferred pairings only, then any */
  for (const conf of f.others) {
    const solve = (allow: (a: number, b: number) => boolean): Array<[number, number]> | null => {
      const d = conf.map((t) => need[t]), used = new Set<string>(), out: Array<[number, number]> = [];
      const key = (a: number, b: number) => (a < b ? a + '|' + b : b + '|' + a);
      const ok = (i: number, j: number) => i !== j && d[i] > 0 && d[j] > 0 && !used.has(key(conf[i], conf[j])) && !f.playing(conf[i], conf[j]) && allow(conf[i], conf[j]);
      let budget = 20000;
      const go = (): boolean => {
        if (--budget < 0) return false;
        let u = -1, best = Infinity;
        for (let i = 0; i < conf.length; i++) if (d[i] > 0) { let n = 0; for (let j = 0; j < conf.length; j++) if (ok(i, j)) n++; if (n < best) { best = n; u = i; } }
        if (u < 0) return true;
        if (best === 0) return false;
        const cands = shuffle(conf.map((_, j) => j).filter((j) => ok(u, j)));
        for (const v of cands) {
          d[u]--; d[v]--; used.add(key(conf[u], conf[v])); out.push([conf[u], conf[v]]);
          if (go()) return true;
          d[u]++; d[v]++; used.delete(key(conf[u], conf[v])); out.pop();
        }
        return false;
      };
      return go() ? out : null;
    };
    let pairs = solve(f.preferred);
    if (!pairs) { f.diag('cup:filler:pairs_fallback'); pairs = solve(() => true); }
    if (!pairs) throw new Error('no within-conference pairing completes the NBA Cup filler games');
    for (const [a, b] of pairs) { edges.push([a, b, false]); need[a]--; need[b]--; }
  }
  /* 3 home and away, and the two dates: walk each path or cycle, every club hosting the game it is reached by;
     a random direction per component, the one that meets the home games each club still needs */
  const nbr = new Map<number, number[]>();
  edges.forEach(([a, b], i) => { for (const t of [a, b]) { if (!nbr.has(t)) nbr.set(t, []); nbr.get(t)!.push(i); } });
  const done = new Array(edges.length).fill(false), out: FillerGame[] = [];
  const homeNeed = f.homeNeed.slice();
  const starts = [...nbr.keys()].sort((a, b) => nbr.get(a)!.length - nbr.get(b)!.length || a - b);
  for (const s of starts) {
    if (nbr.get(s)!.every((i) => done[i])) continue;
    /* the component as an ordered walk from s */
    const walk: Array<[number, number, number]> = [];   // [edge, from, to]
    let cur = s;
    for (;;) {
      const e = nbr.get(cur)!.find((i) => !done[i]);
      if (e == null) break;
      done[e] = true;
      const [a, b] = edges[e], nx = a === cur ? b : a;
      walk.push([e, cur, nx]); cur = nx;
    }
    const orient = (rev: boolean) => walk.map(([e, fr, to]) => (rev ? { e, home: fr, away: to } : { e, home: to, away: fr }));
    const misses = (o: Array<{ home: number; away: number }>) => { const h = new Map<number, number>(); for (const g of o) h.set(g.home, (h.get(g.home) || 0) + 1); let m = 0; for (const t of new Set(o.flatMap((g) => [g.home, g.away]))) m += Math.abs((h.get(t) || 0) - homeNeed[t]); return m; };
    const a = orient(false), b = orient(true), ma = misses(a), mb = misses(b);
    const pick = ma === mb ? (f.rng.nextInt(2) === 0 ? a : b) : ma < mb ? a : b;
    if (Math.min(ma, mb) > 0) f.diag('cup:filler:home_balance');
    pick.forEach((g, i) => { out.push({ home: g.home, away: g.away, slot: (i % 2 === 0 ? 1 : 2), cross: edges[g.e][2] }); homeNeed[g.home]--; });
  }
  return out;
}
