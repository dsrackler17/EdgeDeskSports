/* ===========================================================================
   NHL STANDINGS, TIEBREAKERS, PLAYOFF QUALIFICATION, BRACKET AND SERIES.

   Rules versions (seasons by their END year, the hockey/ convention):
     NHL-TB-2019  2019-20 onward: regulation wins first
     NHL-TB-2014  2013-14 .. 2018-19: regulation + overtime wins first
   The procedure text, its source and its verification status are in
   NHL_SIMULATOR_NOTES.md; simulator/src/sports/nhl/config.ts carries the
   2026-27 facts with their verification fields.

   POINTS. A win is 2 points (regulation, overtime or shootout); a loss in
   overtime or in the shootout is 1 point; a regulation loss is 0. Goals for
   and against are the official final score: overtime goals count, and the
   shootout winner is credited one goal (the loser one goal against).

   TIEBREAKERS (clubs tied in points), NHL-TB-2019:
     1 points percentage (fewer games played)
     2 regulation wins (RW)
     3 regulation + overtime wins (ROW: wins excluding shootout wins)
     4 total wins (including shootout wins)
     5 points in games among the tied clubs, as a percentage of the points
       available, excluding each pair's "odd" games: when two clubs did not
       play an even number of home games against each other, the first game(s)
       played in the city that had the extra game are not counted
     6 goal differential, whole regular season
     7 goals for, whole regular season
   NHL-TB-2014: 1 points percentage, 2 ROW, 3 points among the tied clubs
   (odd games excluded), 4 goal differential.
   Beyond the last published step the clubs are ordered by the seeded coin
   stream; the run is flagged (tiebreak_coin) and counted.

   MULTI-CLUB TIES. Each step partitions the tied clubs by its value; every
   sub-group still tied goes on to the NEXT step (no restart), and the
   head-to-head step is computed among the clubs still tied when they reach
   it. The NHL text states no restart rule; a restart would change only a
   three-or-more club tie that the head-to-head step splits into one club and
   a still-tied pair. Each step that separates clubs is counted (diag
   tb:<step>), so that case is measurable (tb:head_to_head_partial).

   ONLY WHAT MATTERS IS BROKEN. A ranking asks for its top k places; a tie is
   resolved only as far as it decides one of those places, so a coin toss or
   a goals draw is counted only when it decides something reported.

   QUALIFICATION AND BRACKET (fixed, no reseeding). The top three clubs of
   each division (D1-D3) and two wild cards per conference (WC1, WC2: the
   best two of the other conference clubs, regardless of division). The
   division winner with the better record meets WC2, the other meets WC1; D2
   meets D3 in each division. Round 2 pairs the two series of a division's
   half; the conference final pairs the two halves; the Stanley Cup Final
   pairs the conference champions.

   HOME ICE. Rounds 1 and 2: the club placed higher in the bracket
   (D1 > D2 > D3 > wild card). Conference final and Final: the club with the
   better regular-season record (points, then the tiebreakers above).
   simulator/tests/nhl_rules_history.test.ts holds this to every series of
   2013-14 .. 2018-19 and 2021-22 .. 2025-26.

   SERIES. Best of seven, 2-2-1-1-1: games 1, 2, 5 and 7 at the club with home
   ice. A playoff game cannot end tied: overtime is sudden death, never a
   shootout (the resolver supplies the winner and whether it went to OT).
   Completed games of a series are kept exactly as played (winner, venue);
   the series continues from its actual state.

   Every comparison of a percentage is one integer cross-multiplication, so
   equal rationals compare equal.
   =========================================================================== */
import type { Xoshiro128 } from '../../core/prng.ts';

export type Conference = 'Eastern' | 'Western';
export interface NhlTeam { code: string; name: string; conference: Conference; division: string }

/** how a regular-season game ended, from the home club's side */
export const HOME_REG = 0, HOME_OT = 1, HOME_SO = 2, AWAY_REG = 3, AWAY_OT = 4, AWAY_SO = 5;
export const RESULT_CODES = ['HOME_REG', 'HOME_OT', 'HOME_SO', 'AWAY_REG', 'AWAY_OT', 'AWAY_SO'] as const;
/** the result code of a decided game: decided REG | OT | SO and who won */
export function resultCode(decided: string, homeWon: boolean): number {
  const k = decided === 'REG' ? 0 : decided === 'OT' ? 1 : decided === 'SO' ? 2 : -1;
  if (k < 0) throw new Error('unknown decision ' + decided + ' (REG, OT or SO)');
  return homeWon ? k : k + 3;
}

export type TiebreakStep = 'points_pct' | 'regulation_wins' | 'regulation_ot_wins' | 'wins' | 'head_to_head_points' | 'goal_differential' | 'goals_for';

export interface NhlRulesVersion {
  id: string;
  /** season end years covered */
  seasons: [number, number];
  steps: TiebreakStep[];
  clubs_per_division: number;
  wild_cards_per_conference: number;
}
export const NHL_TB_2019: NhlRulesVersion = {
  id: 'NHL-TB-2019', seasons: [2020, 2027],
  steps: ['points_pct', 'regulation_wins', 'regulation_ot_wins', 'wins', 'head_to_head_points', 'goal_differential', 'goals_for'],
  clubs_per_division: 3, wild_cards_per_conference: 2
};
export const NHL_TB_2014: NhlRulesVersion = {
  id: 'NHL-TB-2014', seasons: [2014, 2019],
  steps: ['points_pct', 'regulation_ot_wins', 'head_to_head_points', 'goal_differential'],
  clubs_per_division: 3, wild_cards_per_conference: 2
};
export function nhlRulesFor(season: number): NhlRulesVersion {
  for (const r of [NHL_TB_2019, NHL_TB_2014]) if (season >= r.seasons[0] && season <= r.seasons[1]) return r;
  throw new Error('no NHL rules version covers season ' + season + ' (the division/wild-card format began in 2013-14)');
}

export interface NhlGameDef { home: number; away: number; day: number }

/** the schedule: who plays whom, where and when, and each pair's counted head-to-head games */
export class NhlLeague {
  readonly teams: NhlTeam[];
  readonly T: number;
  readonly G: number;
  readonly gHome: Int16Array;
  readonly gAway: Int16Array;
  readonly gDay: Int32Array;
  /** games per team (indices) */
  readonly byTeam: number[][];
  /** pair key a*T+b (a<b) -> game indices that count for head-to-head (odd games excluded) */
  readonly counted = new Map<number, number[]>();
  /** pair key -> odd games excluded */
  readonly excluded = new Map<number, number[]>();
  readonly divisions: string[];
  readonly conferences: Conference[];
  constructor(teams: NhlTeam[], games: NhlGameDef[]) {
    this.teams = teams; this.T = teams.length; this.G = games.length;
    this.gHome = new Int16Array(this.G); this.gAway = new Int16Array(this.G); this.gDay = new Int32Array(this.G);
    this.byTeam = teams.map(() => []);
    const pairs = new Map<number, number[]>();
    games.forEach((g, k) => {
      if (!(g.home >= 0 && g.home < this.T && g.away >= 0 && g.away < this.T) || g.home === g.away) throw new Error('bad game ' + k);
      this.gHome[k] = g.home; this.gAway[k] = g.away; this.gDay[k] = g.day;
      this.byTeam[g.home].push(k); this.byTeam[g.away].push(k);
      const key = this.key(g.home, g.away);
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key)!.push(k);
    });
    for (const [key, ks] of pairs) {
      ks.sort((x, y) => this.gDay[x] - this.gDay[y] || x - y);
      const a = Math.floor(key / this.T), b = key % this.T;
      const atA = ks.filter((k) => this.gHome[k] === a), atB = ks.filter((k) => this.gHome[k] === b);
      /* the odd game(s): the first played in the city that had the extra game(s) */
      const drop = atA.length > atB.length ? atA.slice(0, atA.length - atB.length) : atB.slice(0, atB.length - atA.length);
      const dropSet = new Set(drop);
      this.counted.set(key, ks.filter((k) => !dropSet.has(k)));
      this.excluded.set(key, drop);
    }
    this.divisions = Array.from(new Set(teams.map((t) => t.division))).sort();
    this.conferences = Array.from(new Set(teams.map((t) => t.conference))).sort() as Conference[];
  }
  key(a: number, b: number): number { return a < b ? a * this.T + b : b * this.T + a; }
  divisionTeams(d: string): number[] { return this.teams.map((t, i) => (t.division === d ? i : -1)).filter((i) => i >= 0); }
  conferenceTeams(c: Conference): number[] { return this.teams.map((t, i) => (t.conference === c ? i : -1)).filter((i) => i >= 0); }
  conferenceDivisions(c: Conference): string[] { return this.divisions.filter((d) => this.teams.some((t) => t.division === d && t.conference === c)); }
}

export interface TieContext {
  rng: Xoshiro128 | null;
  diag?: (k: string, n?: number) => void;
  flag?: (k: string) => void;
  trace?: (e: Record<string, unknown>) => void;
}

/** goals of every game (official final: OT goals, and +1 to the shootout winner) */
export interface GameGoals { home: Int16Array; away: Int16Array }

type Rat = [number, number];
const cmpRat = (a: Rat, b: Rat) => a[0] * b[1] - b[0] * a[1];

/**
 * One season's standings from per-game results (-1 = not played).
 * `goals` is asked for only when a tie reaches a goals step; it returns
 * null when no score is available (the step is then counted unsupported and
 * the clubs go on to the coin toss).
 */
export class NhlStandings {
  readonly L: NhlLeague;
  readonly rules: NhlRulesVersion;
  readonly results: Int8Array;
  readonly pts: Int32Array; readonly gp: Int32Array; readonly w: Int32Array; readonly rw: Int32Array;
  readonly row: Int32Array; readonly otl: Int32Array; readonly l: Int32Array;
  private goalsFn: () => GameGoals | null;
  private gf: Int32Array | null | undefined;
  private ga: Int32Array | null | undefined;
  private ctx: TieContext;
  constructor(L: NhlLeague, rules: NhlRulesVersion, results: Int8Array, goals: () => GameGoals | null, ctx: TieContext) {
    this.L = L; this.rules = rules; this.results = results; this.goalsFn = goals; this.ctx = ctx;
    const T = L.T;
    this.pts = new Int32Array(T); this.gp = new Int32Array(T); this.w = new Int32Array(T); this.rw = new Int32Array(T);
    this.row = new Int32Array(T); this.otl = new Int32Array(T); this.l = new Int32Array(T);
    for (let k = 0; k < L.G; k++) {
      const r = results[k]; if (r < 0) continue;
      const h = L.gHome[k], a = L.gAway[k];
      const win = r < 3 ? h : a, lose = r < 3 ? a : h, kind = r % 3;
      this.gp[h]++; this.gp[a]++;
      this.w[win]++; this.pts[win] += 2;
      if (kind === 0) { this.rw[win]++; this.row[win]++; this.l[lose]++; }
      else { if (kind === 1) this.row[win]++; this.otl[lose]++; this.pts[lose] += 1; }
    }
  }
  /** official GF / GA per club (lazy; null when no scores) */
  goals(): { gf: Int32Array; ga: Int32Array } | null {
    if (this.gf === undefined) {
      const g = this.goalsFn();
      if (!g) { this.gf = null; this.ga = null; }
      else {
        const gf = new Int32Array(this.L.T), ga = new Int32Array(this.L.T);
        for (let k = 0; k < this.L.G; k++) {
          if (this.results[k] < 0) continue;
          const h = this.L.gHome[k], a = this.L.gAway[k];
          gf[h] += g.home[k]; ga[h] += g.away[k]; gf[a] += g.away[k]; ga[a] += g.home[k];
        }
        this.gf = gf; this.ga = ga;
      }
    }
    return this.gf ? { gf: this.gf, ga: this.ga as Int32Array } : null;
  }
  /** points earned by club t in counted games against the clubs of `group` */
  h2h(t: number, group: number[]): Rat {
    let p = 0, n = 0;
    for (const u of group) {
      if (u === t) continue;
      for (const k of this.L.counted.get(this.L.key(t, u)) || []) {
        const r = this.results[k]; if (r < 0) continue;
        const home = this.L.gHome[k] === t;
        const won = (r < 3) === home;
        n++; p += won ? 2 : r % 3 === 0 ? 0 : 1;
      }
    }
    return [p, 2 * n];
  }
  private values(step: TiebreakStep, group: number[]): Rat[] | null {
    switch (step) {
      case 'points_pct': return group.map((t) => [this.pts[t], Math.max(1, 2 * this.gp[t])]);
      case 'regulation_wins': return group.map((t) => [this.rw[t], 1]);
      case 'regulation_ot_wins': return group.map((t) => [this.row[t], 1]);
      case 'wins': return group.map((t) => [this.w[t], 1]);
      case 'head_to_head_points': {
        const v = group.map((t) => this.h2h(t, group));
        return v.some((x) => x[1] === 0) ? null : v;
      }
      case 'goal_differential': case 'goals_for': {
        const g = this.goals();
        if (!g) { this.ctx.diag?.('tb:goals_unavailable'); this.ctx.flag?.('tiebreak_unsupported_input'); return null; }
        this.ctx.flag?.('tiebreak_goals');
        return group.map((t) => [step === 'goals_for' ? g.gf[t] : g.gf[t] - g.ga[t], 1]);
      }
    }
  }
  /** order `group` (clubs tied in points) well enough to decide its first `need` places */
  private order(group: number[], step: number, need: number, label: string): number[] {
    if (group.length <= 1 || need <= 0) return group.slice();
    const steps = this.rules.steps;
    if (step >= steps.length) return this.coin(group, label);
    const s = steps[step];
    const v = this.values(s, group);
    if (!v) return this.order(group, step + 1, need, label);
    const idx = group.map((_, i) => i).sort((x, y) => cmpRat(v[y], v[x]) || group[x] - group[y]);
    const out: number[] = [];
    let k = 0, parts = 0;
    while (k < idx.length) {
      let m = k + 1;
      while (m < idx.length && cmpRat(v[idx[m]], v[idx[k]]) === 0) m++;
      const sub = idx.slice(k, m).map((i) => group[i]);
      const left = need - out.length;
      out.push(...(left > 0 ? this.order(sub, step + 1, Math.min(left, sub.length), label) : sub));
      k = m; parts++;
    }
    if (parts > 1) {
      this.ctx.diag?.('tb:' + s);
      if (s === 'head_to_head_points' && group.length >= 3 && parts < group.length) this.ctx.diag?.('tb:head_to_head_partial');
      this.ctx.trace?.({ type: 'tiebreak', label, step: s, clubs: group.map((t) => this.L.teams[t].code) });
    }
    return out;
  }
  private coin(group: number[], label: string): number[] {
    if (!this.ctx.rng) throw new Error('tie in ' + label + ' beyond the last tiebreak step and no coin stream: ' + group.map((t) => this.L.teams[t].code).join(', '));
    const g = group.slice();
    for (let i = g.length - 1; i > 0; i--) { const j = this.ctx.rng.nextInt(i + 1); const x = g[i]; g[i] = g[j]; g[j] = x; }
    this.ctx.diag?.('tb:coin'); this.ctx.flag?.('tiebreak_coin');
    this.ctx.trace?.({ type: 'coin_toss', label, order: g.map((t) => this.L.teams[t].code) });
    return g;
  }
  /** the first `k` places among `clubs` (points, then the tiebreakers); the rest follow unordered */
  rankTop(clubs: number[], k: number, label: string): number[] {
    const byPts = clubs.slice().sort((x, y) => this.pts[y] - this.pts[x] || x - y);
    const out: number[] = [];
    let i = 0;
    while (i < byPts.length) {
      let j = i + 1;
      while (j < byPts.length && this.pts[byPts[j]] === this.pts[byPts[i]]) j++;
      const grp = byPts.slice(i, j);
      const left = k - out.length;
      out.push(...(left > 0 ? this.order(grp, 0, Math.min(left, grp.length), label) : grp));
      i = j;
    }
    return out;
  }
  /** whether club a has the better record than club b (points, then the tiebreakers) */
  better(a: number, b: number, label: string): boolean { return this.rankTop([a, b], 1, label)[0] === a; }
}

export type BracketPos = 'D1' | 'D2' | 'D3' | 'WC1' | 'WC2';
/** bracket placement rank for home ice in rounds 1 and 2 (lower hosts) */
export const POS_RANK: Record<BracketPos, number> = { D1: 1, D2: 2, D3: 3, WC1: 4, WC2: 4 };

export interface ConferenceBracket {
  conference: Conference;
  /** division -> [D1, D2, D3] */
  divisionTop: Record<string, number[]>;
  wildCards: [number, number];
  /** the division whose winner has the better record (it meets WC2) */
  topDivision: string;
  otherDivision: string;
  /** the conference's best regular-season record (the better division winner) */
  first: number;
  /** club -> bracket position */
  pos: Map<number, BracketPos>;
  /** round-1 pairs [higher, lower] in bracket order: top half (D1 v WC2, D2 v D3), other half (D1 v WC1, D2 v D3) */
  round1: Array<[number, number]>;
}

export function buildBracket(S: NhlStandings, conf: Conference): ConferenceBracket {
  const L = S.L, rules = S.rules;
  const divs = L.conferenceDivisions(conf);
  if (divs.length !== 2) throw new Error(conf + ' has ' + divs.length + ' divisions; the format needs 2');
  const divisionTop: Record<string, number[]> = {};
  const inTop = new Set<number>();
  for (const d of divs) {
    const top = S.rankTop(L.divisionTeams(d), rules.clubs_per_division, 'division ' + d).slice(0, rules.clubs_per_division);
    divisionTop[d] = top; top.forEach((t) => inTop.add(t));
  }
  const pool = L.conferenceTeams(conf).filter((t) => !inTop.has(t));
  const wc = S.rankTop(pool, rules.wild_cards_per_conference, 'wild card ' + conf).slice(0, 2) as [number, number];
  const [da, db] = divs;
  const aBetter = S.better(divisionTop[da][0], divisionTop[db][0], 'division winners ' + conf);
  const topDivision = aBetter ? da : db, otherDivision = aBetter ? db : da;
  const pos = new Map<number, BracketPos>();
  for (const d of divs) divisionTop[d].forEach((t, i) => pos.set(t, ('D' + (i + 1)) as BracketPos));
  pos.set(wc[0], 'WC1'); pos.set(wc[1], 'WC2');
  const T1 = divisionTop[topDivision], T2 = divisionTop[otherDivision];
  return {
    conference: conf, divisionTop, wildCards: wc, topDivision, otherDivision, first: T1[0], pos,
    round1: [[T1[0], wc[1]], [T1[1], T1[2]], [T2[0], wc[0]], [T2[1], T2[2]]]
  };
}

/* ---------------- the postseason ---------------- */

export type PlayoffRound = 1 | 2 | 3 | 4;
export interface PlayoffGameSpec { round: PlayoffRound; game: number; home: number; away: number; hi: number; lo: number }
/** decides one playoff game: the winner, and whether it needed overtime */
export type PlayoffResolver = (g: PlayoffGameSpec) => { winner: number; ot: boolean };

export interface ObservedPlayoffGame { a: number; b: number; home: number; winner: number; ot: boolean; day: number }
export interface ScheduledPlayoffGame { a: number; b: number; home: number; game: number }

export interface SeriesRecord {
  round: PlayoffRound; hi: number; lo: number; winner: number;
  games: Array<{ game: number; home: number; winner: number; ot: boolean; observed: boolean }>;
}
export interface PostseasonResult {
  brackets: ConferenceBracket[];
  series: SeriesRecord[];
  reached: { round2: number[]; conferenceFinal: number[]; final: number[] };
  conferenceChampions: Record<Conference, number>;
  champion: number;
}

/** home club of game n (1-7) of a 2-2-1-1-1 series */
export const SERIES_PATTERN = [0, 0, 1, 1, 0, 1, 0];
export function seriesHome(hi: number, lo: number, game: number): number { return SERIES_PATTERN[game - 1] === 0 ? hi : lo; }

export interface PostseasonOptions {
  observed?: ObservedPlayoffGame[];
  scheduled?: ScheduledPlayoffGame[];
  diag?: (k: string, n?: number) => void;
}

export function playPostseason(S: NhlStandings, resolve: PlayoffResolver, opt: PostseasonOptions = {}): PostseasonResult {
  const L = S.L;
  const confs = L.conferences;
  if (confs.length !== 2) throw new Error('the league needs exactly two conferences');
  const brackets = confs.map((c) => buildBracket(S, c));
  const posOf = new Map<number, BracketPos>();
  brackets.forEach((b) => b.pos.forEach((p, t) => posOf.set(t, p)));
  /* observed games by pair, in the order played */
  const obs = new Map<number, ObservedPlayoffGame[]>();
  for (const g of (opt.observed || []).slice().sort((x, y) => x.day - y.day)) {
    const k = L.key(g.a, g.b);
    if (!obs.has(k)) obs.set(k, []);
    obs.get(k)!.push(g);
  }
  const used = new Set<number>();
  const sched = new Map<string, number>();
  for (const g of opt.scheduled || []) sched.set(L.key(g.a, g.b) + ':' + g.game, g.home);
  const series: SeriesRecord[] = [];
  const play = (round: PlayoffRound, x: number, y: number): number => {
    /* home ice: bracket placement in rounds 1-2, regular-season record after */
    let hi: number, lo: number;
    if (round <= 2) {
      const rx = POS_RANK[posOf.get(x)!], ry = POS_RANK[posOf.get(y)!];
      if (rx === ry) throw new Error('round ' + round + ' pairs two clubs of the same bracket rank');
      [hi, lo] = rx < ry ? [x, y] : [y, x];
    } else {
      [hi, lo] = S.better(x, y, 'home ice, round ' + round) ? [x, y] : [y, x];
    }
    const key = L.key(hi, lo);
    const past = obs.get(key) || [];
    used.add(key);
    const rec: SeriesRecord = { round, hi, lo, winner: -1, games: [] };
    let wHi = 0, wLo = 0, n = 0;
    for (const g of past) {
      n++;
      if (n > 7 || wHi === 4 || wLo === 4) throw new Error('observed playoff games ' + L.teams[hi].code + '-' + L.teams[lo].code + ' continue past a decided series');
      if (g.winner !== hi && g.winner !== lo) throw new Error('observed playoff winner is not in the series');
      if (g.home !== seriesHome(hi, lo, n)) opt.diag?.('series:observed_home_differs_from_2_2_1_1_1');
      if (g.winner === hi) wHi++; else wLo++;
      rec.games.push({ game: n, home: g.home, winner: g.winner, ot: g.ot, observed: true });
    }
    if (past.length) opt.diag?.('series:observed_games', past.length);
    while (wHi < 4 && wLo < 4) {
      n++;
      const sh = sched.get(key + ':' + n);
      const home = sh != null ? sh : seriesHome(hi, lo, n);
      const away = home === hi ? lo : hi;
      const r = resolve({ round, game: n, home, away, hi, lo });
      if (r.winner !== home && r.winner !== away) throw new Error('playoff resolver returned a club not in the game');
      if (r.winner === hi) wHi++; else wLo++;
      rec.games.push({ game: n, home, winner: r.winner, ot: r.ot, observed: false });
    }
    rec.winner = wHi === 4 ? hi : lo;
    series.push(rec);
    return rec.winner;
  };
  const reached = { round2: [] as number[], conferenceFinal: [] as number[], final: [] as number[] };
  const champs = {} as Record<Conference, number>;
  for (const b of brackets) {
    const r1 = b.round1.map(([x, y]) => play(1, x, y));
    reached.round2.push(...r1);
    const r2 = [play(2, r1[0], r1[1]), play(2, r1[2], r1[3])];
    reached.conferenceFinal.push(...r2);
    const cf = play(3, r2[0], r2[1]);
    reached.final.push(cf);
    champs[b.conference] = cf;
  }
  const champion = play(4, champs[confs[0]], champs[confs[1]]);
  for (const k of obs.keys()) if (!used.has(k)) {
    const g = obs.get(k)![0];
    throw new Error('observed playoff series ' + L.teams[g.a].code + '-' + L.teams[g.b].code + ' is not in the bracket the standings produce');
  }
  return { brackets, series, reached, conferenceChampions: champs, champion };
}
