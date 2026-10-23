/* ===========================================================================
   MLB STANDINGS, TIEBREAKERS, QUALIFICATION, SEEDING AND THE POSTSEASON.

   Formats (config.ts formatFor): MLB-2022 (2022 onward: 12 clubs, two byes
   per league, no tiebreaker games) and MLB-2012 (2012-2019 and 2021: 10
   clubs, a one-game wild card, tiebreaker games). 2020 is refused.

   STANDINGS are winning percentages. A tie game (it happens: a called game
   never resumed, e.g. PIT-CHN 2016-09-29) counts in neither column, the MLB
   convention. Every percentage comparison is a cross-multiplication of
   integers, so equal records compare equal.

   TIEBREAKS (MLB-2022; the text and its verification status are in
   config.ts MLB_2026.tiebreakers and MLB_SIMULATOR_NOTES.md):
     1 head-to-head winning percentage, combined among the tied clubs
     2 winning percentage in intradivision games
     3 winning percentage in interdivision games within the league
     4 winning percentage in the last half of intraleague games
     5 the last half plus one intraleague game (games between the tied clubs
       are skipped when the window is extended), one game at a time
     6 exhausted: a seeded draw, flagged `tiebreak_exhausted` and counted
   One club is placed per pass. When a step separates the best club(s) from
   the rest without naming one, the procedure restarts at step 1 among the
   best; once a club is placed, the rest start again from step 1.
   A step with no games behind it for some tied club (two clubs that never
   met) is not applicable and is passed over, never invented.

   MLB-2012 seeds ties among clubs ALREADY qualified with the same steps.
   A tie for a division title or a berth was decided by a tiebreaker game,
   which the game logs record as a regular-season game, so a replay of
   history never meets one; a simulated season under MLB-2012 would have to
   play it, and this engine refuses (throws) rather than invent one.
   =========================================================================== */
import { Xoshiro128 } from '../../core/prng.ts';
import type { MlbFormat, MlbTeam, Round, League } from './config.ts';

export interface RegGame { home: number; away: number; day: number; game_no: number }

/** the fixed schedule: who plays whom, in order; results vary by run */
export class Season {
  readonly T: number; readonly G: number;
  readonly teams: MlbTeam[];
  readonly gHome: Int16Array; readonly gAway: Int16Array;
  readonly sameDiv: Uint8Array; readonly sameLeague: Uint8Array;
  readonly divOf: Int8Array; readonly leagueOf: Int8Array;
  readonly divisions: string[];
  /** per club, its intraleague games in chronological order (game indices) */
  readonly intraleague: Int32Array[];
  constructor(teams: MlbTeam[], games: RegGame[]) {
    this.teams = teams; this.T = teams.length; this.G = games.length;
    this.divisions = [...new Set(teams.map((t) => t.division))];
    this.divOf = Int8Array.from(teams.map((t) => this.divisions.indexOf(t.division)));
    this.leagueOf = Int8Array.from(teams.map((t) => (t.league === 'AL' ? 0 : 1)));
    this.gHome = new Int16Array(this.G); this.gAway = new Int16Array(this.G);
    this.sameDiv = new Uint8Array(this.G); this.sameLeague = new Uint8Array(this.G);
    const order = games.map((g, i) => i).sort((a, b) => games[a].day - games[b].day || games[a].game_no - games[b].game_no || a - b);
    games.forEach((g, i) => {
      if (!(g.home >= 0 && g.home < this.T && g.away >= 0 && g.away < this.T && g.home !== g.away)) throw new Error('bad game ' + i);
      this.gHome[i] = g.home; this.gAway[i] = g.away;
      this.sameDiv[i] = this.divOf[g.home] === this.divOf[g.away] ? 1 : 0;
      this.sameLeague[i] = this.leagueOf[g.home] === this.leagueOf[g.away] ? 1 : 0;
    });
    const lists: number[][] = teams.map(() => []);
    for (const i of order) if (this.sameLeague[i]) { lists[this.gHome[i]].push(i); lists[this.gAway[i]].push(i); }
    this.intraleague = lists.map((l) => Int32Array.from(l));
  }
}

export interface TieContext {
  rng: Xoshiro128 | null;
  diag?: (key: string, n?: number) => void;
  flag?: (key: string) => void;
  trace?: (ev: Record<string, unknown>) => void;
}

/** one season's results: win[g] = 1 home won, -1 away won, 0 no decision (tie or not played) */
export class Standings {
  readonly S: Season;
  readonly win: Int8Array;
  readonly w: Int16Array; readonly l: Int16Array;
  readonly divW: Int16Array; readonly divL: Int16Array;
  readonly ildW: Int16Array; readonly ildL: Int16Array;      // intraleague, outside the division
  readonly h2h: Int16Array;                                 // h2h[i*T+j]: wins of i over j
  readonly ctx: TieContext;
  constructor(S: Season, win: Int8Array, ctx: TieContext) {
    this.S = S; this.win = win; this.ctx = ctx;
    const T = S.T;
    this.w = new Int16Array(T); this.l = new Int16Array(T);
    this.divW = new Int16Array(T); this.divL = new Int16Array(T);
    this.ildW = new Int16Array(T); this.ildL = new Int16Array(T);
    this.h2h = new Int16Array(T * T);
    for (let g = 0; g < S.G; g++) {
      const r = win[g]; if (r === 0) continue;
      const W = r > 0 ? S.gHome[g] : S.gAway[g], L = r > 0 ? S.gAway[g] : S.gHome[g];
      this.w[W]++; this.l[L]++; this.h2h[W * T + L]++;
      if (S.sameDiv[g]) { this.divW[W]++; this.divL[L]++; }
      else if (S.sameLeague[g]) { this.ildW[W]++; this.ildL[L]++; }
    }
  }
  /** a > b (1), equal (0), a < b (-1) for winning percentages wa/(wa+la) vs wb/(wb+lb) */
  static cmpPct(wa: number, la: number, wb: number, lb: number): number {
    const x = wa * (wb + lb), y = wb * (wa + la);
    return x > y ? 1 : x < y ? -1 : 0;
  }
  cmpRecord(a: number, b: number): number { return Standings.cmpPct(this.w[a], this.l[a], this.w[b], this.l[b]); }

  /** clubs in order of record, best first; equal records ordered by the tiebreak procedure (only as far as `need` places) */
  rank(clubs: number[], need: number = clubs.length): number[] {
    const sorted = clubs.slice().sort((a, b) => -this.cmpRecord(a, b) || a - b);
    const out: number[] = [];
    let i = 0;
    while (i < sorted.length && out.length < need) {
      let j = i + 1;
      while (j < sorted.length && this.cmpRecord(sorted[i], sorted[j]) === 0) j++;
      const group = sorted.slice(i, j);
      if (group.length === 1) out.push(group[0]);
      else {
        this.ctx.diag && this.ctx.diag('tiebreak:groups');
        out.push(...this.breakTie(group, need - out.length));
      }
      i = j;
    }
    return out.slice(0, need);
  }

  /** order a group of clubs with equal records: one place per pass, the rest revert to step 1 */
  breakTie(group: number[], need: number = group.length): number[] {
    const order: number[] = [];
    let rest = group.slice();
    while (rest.length > 1 && order.length < need) {
      const best = this.pickBest(rest, 0);
      order.push(best);
      rest = rest.filter((t) => t !== best);
    }
    if (order.length < need) order.push(...rest);
    return order.slice(0, Math.min(need, group.length));
  }

  static readonly STEPS = ['head_to_head', 'intradivision', 'interdivision_intraleague', 'last_half_intraleague', 'last_half_plus'] as const;

  /** the single best club of a tied set, by the steps from `from` on */
  pickBest(S: number[], from: number): number {
    if (S.length === 1) return S[0];
    for (let step = from; step < Standings.STEPS.length; step++) {
      const name = Standings.STEPS[step];
      if (name === 'last_half_plus') {
        const b = this.lastHalfExtended(S);
        if (b !== null) return b;
        continue;
      }
      const recs = S.map((t) => this.stepRecord(name, t, S));
      if (recs.some((r) => r[0] + r[1] === 0)) continue;          // not applicable: no games behind it
      let bestIdx: number[] = [0];
      for (let k = 1; k < S.length; k++) {
        const c = Standings.cmpPct(recs[k][0], recs[k][1], recs[bestIdx[0]][0], recs[bestIdx[0]][1]);
        if (c > 0) bestIdx = [k]; else if (c === 0) bestIdx.push(k);
      }
      if (bestIdx.length === S.length) continue;                   // nobody separated: next step
      this.ctx.diag && this.ctx.diag('tiebreak:step:' + name);
      if (this.ctx.trace) this.ctx.trace({ type: 'tiebreak', step: name, clubs: S.map((t) => this.S.teams[t].code), best: bestIdx.map((k) => this.S.teams[S[k]].code) });
      if (bestIdx.length === 1) return S[bestIdx[0]];
      return this.pickBest(bestIdx.map((k) => S[k]), 0);           // restart among the best
    }
    /* every step exhausted: a seeded draw, flagged and counted */
    if (this.ctx.flag) this.ctx.flag('tiebreak_exhausted');
    if (this.ctx.diag) this.ctx.diag('tiebreak:exhausted');
    if (!this.ctx.rng) throw new Error('tiebreak exhausted and no draw stream: ' + S.map((t) => this.S.teams[t].code).join(','));
    return S[this.ctx.rng.nextInt(S.length)];
  }

  /** [wins, losses] of club t in the games a step counts */
  stepRecord(step: string, t: number, S: number[]): [number, number] {
    const T = this.S.T;
    switch (step) {
      case 'head_to_head': {
        let w = 0, l = 0;
        for (const o of S) if (o !== t) { w += this.h2h[t * T + o]; l += this.h2h[o * T + t]; }
        return [w, l];
      }
      case 'intradivision': return [this.divW[t], this.divL[t]];
      case 'interdivision_intraleague': return [this.ildW[t], this.ildL[t]];
      case 'last_half_intraleague': return this.lastIntraleague(t, 0, S);
      default: throw new Error('unknown step ' + step);
    }
  }

  /** record over the club's last half of decided intraleague games, plus `extra` earlier games not against the other tied clubs */
  lastIntraleague(t: number, extra: number, S: number[]): [number, number] {
    const S0 = this.S, list = S0.intraleague[t];
    const decided: number[] = [];
    for (let k = 0; k < list.length; k++) if (this.win[list[k]] !== 0) decided.push(list[k]);
    const half = Math.floor(decided.length / 2);
    let w = 0, l = 0, k = decided.length - 1, taken = 0;
    for (; k >= 0 && taken < half; k--, taken++) { const g = decided[k]; if (this.wonBy(g, t)) w++; else l++; }
    let added = 0;
    for (; k >= 0 && added < extra; k--) {
      const g = decided[k], opp = S0.gHome[g] === t ? S0.gAway[g] : S0.gHome[g];
      if (S.includes(opp)) continue;
      if (this.wonBy(g, t)) w++; else l++;
      added++;
    }
    return [w, l];
  }
  private wonBy(g: number, t: number): boolean { const r = this.win[g]; return (r > 0 && this.S.gHome[g] === t) || (r < 0 && this.S.gAway[g] === t); }

  /** step 5: extend the window one game at a time until one club (or a subset) is best */
  private lastHalfExtended(S: number[]): number | null {
    for (let extra = 1; extra <= 200; extra++) {
      const recs = S.map((t) => this.lastIntraleague(t, extra, S));
      let bestIdx = [0];
      for (let k = 1; k < S.length; k++) {
        const c = Standings.cmpPct(recs[k][0], recs[k][1], recs[bestIdx[0]][0], recs[bestIdx[0]][1]);
        if (c > 0) bestIdx = [k]; else if (c === 0) bestIdx.push(k);
      }
      if (bestIdx.length === S.length) continue;
      this.ctx.diag && this.ctx.diag('tiebreak:step:last_half_plus');
      if (bestIdx.length === 1) return S[bestIdx[0]];
      return this.pickBest(bestIdx.map((k) => S[k]), 0);
    }
    return null;
  }
}

/* ---------------- qualification and seeds ---------------- */
export interface LeagueSeeds {
  league: League;
  /** division winners, in division order of Season.divisions (this league's) */
  divisionWinners: number[];
  /** seeds 1..N (index 0 = seed 1) */
  seeds: number[];
}

export class UnsupportedTie extends Error {}

export function qualify(st: Standings, fmt: MlbFormat): LeagueSeeds[] {
  const S = st.S;
  const out: LeagueSeeds[] = [];
  for (const lg of ['AL', 'NL'] as League[]) {
    const li = lg === 'AL' ? 0 : 1;
    const clubs = [...Array(S.T).keys()].filter((t) => S.leagueOf[t] === li);
    const divs = S.divisions.filter((d) => d.startsWith(lg));
    const winners: number[] = [];
    for (const d of divs) {
      const members = clubs.filter((t) => S.divisions[S.divOf[t]] === d);
      const top = st.rank(members, 1)[0];
      if (fmt.berth_ties === 'tiebreaker_game') {
        const tied = members.filter((t) => t !== top && st.cmpRecord(t, top) === 0);
        if (tied.length) throw new UnsupportedTie('division tie in ' + d + ' needs a tiebreaker game (' + fmt.id + ')');
      }
      winners.push(top);
    }
    const dw = st.rank(winners);
    const rest = clubs.filter((t) => !winners.includes(t));
    const wc = st.rank(rest, fmt.wild_cards_per_league);
    if (fmt.berth_ties === 'tiebreaker_game') {
      const last = wc[wc.length - 1];
      if (rest.some((t) => !wc.includes(t) && st.cmpRecord(t, last) === 0)) throw new UnsupportedTie('wild-card tie in the ' + lg + ' needs a tiebreaker game (' + fmt.id + ')');
    }
    out.push({ league: lg, divisionWinners: winners, seeds: dw.concat(wc) });
  }
  return out;
}

/* ---------------- the postseason ---------------- */
export interface SeriesSpec {
  id: string;                 // e.g. 'AL-WC-3v6', 'NL-DS-1', 'AL-LCS', 'WS'
  round: Round;
  league: League | 'MLB';
  higher: number; lower: number;
  higherSeed: number; lowerSeed: number;
  best_of: number;
}
export interface PlayedGame { series: string; round: Round; game: number; home: number; away: number; winner: number }
/** decide one postseason game; the caller knows the date, the starters and whether it is already played */
export type PostseasonGame = (s: SeriesSpec, game: number, home: number, away: number) => number;

export interface PostseasonResult {
  reachedDS: number[]; reachedLCS: number[]; pennant: number[]; champion: number;
  series: Array<{ spec: SeriesSpec; winner: number; games: number }>;
  games: PlayedGame[];
}

/** home team of game k (1-based) of a series */
export function hostOf(fmt: MlbFormat, round: Round, k: number, higher: number, lower: number): number {
  const def = fmt.rounds.find((r) => r.key === round);
  if (!def) throw new Error('format ' + fmt.id + ' has no round ' + round);
  if (!(k >= 1 && k <= def.best_of)) throw new Error('game ' + k + ' outside a best-of-' + def.best_of);
  return def.hosts[k - 1] === 'H' ? higher : lower;
}

export function playSeries(fmt: MlbFormat, spec: SeriesSpec, play: PostseasonGame, games: PlayedGame[]): { winner: number; games: number } {
  const need = (spec.best_of + 1) / 2;
  let wh = 0, wl = 0, k = 0;
  while (wh < need && wl < need) {
    k++;
    const home = hostOf(fmt, spec.round, k, spec.higher, spec.lower);
    const away = home === spec.higher ? spec.lower : spec.higher;
    const w = play(spec, k, home, away);
    if (w !== home && w !== away) throw new Error('postseason game winner is not a participant: ' + spec.id + ' game ' + k);
    games.push({ series: spec.id, round: spec.round, game: k, home, away, winner: w });
    if (w === spec.higher) wh++; else wl++;
  }
  return { winner: wh === need ? spec.higher : spec.lower, games: k };
}

/** the World Series home club: better record (2017-) or the All-Star Game league (2012-2016) */
export function worldSeriesHigher(st: Standings, fmt: MlbFormat, al: number, nl: number): number {
  if (fmt.ws_home.rule === 'all_star_game') return fmt.ws_home.league === 'AL' ? al : nl;
  const c = st.cmpRecord(al, nl);
  if (c !== 0) return c > 0 ? al : nl;
  st.ctx.diag && st.ctx.diag('tiebreak:world_series_home');
  return st.breakTie([al, nl], 1)[0];
}

export function playPostseason(st: Standings, fmt: MlbFormat, seeds: LeagueSeeds[], play: PostseasonGame): PostseasonResult {
  const games: PlayedGame[] = [];
  const series: PostseasonResult['series'] = [];
  const reachedDS: number[] = [], reachedLCS: number[] = [], pennant: number[] = [];
  const def = (r: Round) => fmt.rounds.find((x) => x.key === r) as { best_of: number };
  const run = (spec: Omit<SeriesSpec, 'best_of'>): number => {
    const full: SeriesSpec = { ...spec, best_of: def(spec.round).best_of };
    const r = playSeries(fmt, full, play, games);
    series.push({ spec: full, winner: r.winner, games: r.games });
    return r.winner;
  };
  const seedOf = (L: LeagueSeeds, t: number) => L.seeds.indexOf(t) + 1;
  for (const L of seeds) {
    const s = (k: number) => L.seeds[k - 1];
    let dsPairs: Array<[number, number]>;
    if (fmt.id === 'MLB-2022') {
      const w45 = run({ id: L.league + '-WC-4v5', round: 'WC', league: L.league, higher: s(4), lower: s(5), higherSeed: 4, lowerSeed: 5 });
      const w36 = run({ id: L.league + '-WC-3v6', round: 'WC', league: L.league, higher: s(3), lower: s(6), higherSeed: 3, lowerSeed: 6 });
      dsPairs = [[s(1), w45], [s(2), w36]];
    } else {
      const wc = run({ id: L.league + '-WC-4v5', round: 'WC', league: L.league, higher: s(4), lower: s(5), higherSeed: 4, lowerSeed: 5 });
      dsPairs = [[s(1), wc], [s(2), s(3)]];
    }
    const lcs: number[] = [];
    dsPairs.forEach(([a, b], i) => {
      reachedDS.push(a, b);
      const [hi, lo] = seedOf(L, a) < seedOf(L, b) ? [a, b] : [b, a];
      lcs.push(run({ id: L.league + '-DS-' + (i + 1), round: 'DS', league: L.league, higher: hi, lower: lo, higherSeed: seedOf(L, hi), lowerSeed: seedOf(L, lo) }));
    });
    reachedLCS.push(...lcs);
    const [hi, lo] = seedOf(L, lcs[0]) < seedOf(L, lcs[1]) ? [lcs[0], lcs[1]] : [lcs[1], lcs[0]];
    pennant.push(run({ id: L.league + '-LCS', round: 'LCS', league: L.league, higher: hi, lower: lo, higherSeed: seedOf(L, hi), lowerSeed: seedOf(L, lo) }));
  }
  const al = pennant[0], nl = pennant[1];
  const hi = worldSeriesHigher(st, fmt, al, nl), lo = hi === al ? nl : al;
  const champion = run({ id: 'WS', round: 'WS', league: 'MLB', higher: hi, lower: lo, higherSeed: 0, lowerSeed: 0 });
  return { reachedDS, reachedLCS, pennant, champion, series, games };
}
