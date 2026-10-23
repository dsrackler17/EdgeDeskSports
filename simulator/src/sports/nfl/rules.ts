/* ===========================================================================
   NFL STANDINGS, TIEBREAKERS, SEEDING AND THE POSTSEASON BRACKET.

   Rules version NFL-TB-2020 (7-club playoff field, 2020 onward) and its
   6-club predecessor NFL-TB-2002 (2002-2019) for the historical fixtures.
   The procedure text is in SIMULATOR_NOTES.md §NFL rules with its source and
   verification status. What is implemented, step by step:

   DIVISION, two clubs                       DIVISION, three or more clubs
    1 head-to-head                            1 head-to-head (games among the clubs)
    2 division record                         2 division record
    3 common games (no minimum)               3 common games
    4 conference record                       4 conference record
    5 strength of victory                     5 strength of victory
    6 strength of schedule                    6 strength of schedule
    7 combined rank, conference, points       7 .. 12 as for two clubs
    8 combined rank, league, points
    9 net points, common games
   10 net points, all games
   11 net touchdowns, all games
   12 coin toss

   WILD CARD (clubs from different divisions)
    two clubs                                 three or more clubs
    1 head-to-head, if they played            1 reduce to the top club of each division
    2 conference record                       2 head-to-head SWEEP (one beat each, or lost to each)
    3 common games, minimum of four           3 conference record
    4 strength of victory                     4 common games, minimum of four
    5 strength of schedule                    5 .. 12 as for two clubs, shifted by one
    6 combined rank, conference
    7 combined rank, league
    8 net points, conference games
    9 net points, all games
   10 net touchdowns
   11 coin toss

   RESTART. Only one club advances per step. When a step separates the best
   club(s) from the rest without naming a single winner, the rest are
   eliminated and the remaining clubs start again: two clubs at step 1 of the
   two-club format, three or more at step 1 (division) or step 2 (wild card)
   of the three-club format. When one club wins, the others revert to step 1
   to decide the next place. Ties count half a win and half a loss.

   Every percentage is computed as one division of two integers, so two equal
   rationals compare equal and two different ones never do.
   =========================================================================== */
import { Xoshiro128 } from '../../core/prng.ts';

export interface RulesVersion {
  id: string;
  seasons: [number, number];
  playoff_clubs_per_conference: number;
  byes_per_conference: number;
  /** wild-card round pairings as [higher seed, lower seed] */
  wild_card_pairs: Array<[number, number]>;
}

export const NFL_TB_2020: RulesVersion = {
  id: 'NFL-TB-2020',
  seasons: [2020, 2026],
  playoff_clubs_per_conference: 7,
  byes_per_conference: 1,
  wild_card_pairs: [[2, 7], [3, 6], [4, 5]]
};
export const NFL_TB_2002: RulesVersion = {
  id: 'NFL-TB-2002',
  seasons: [2002, 2019],
  playoff_clubs_per_conference: 6,
  byes_per_conference: 2,
  wild_card_pairs: [[3, 6], [4, 5]]
};
export function rulesFor(season: number): RulesVersion {
  for (const r of [NFL_TB_2020, NFL_TB_2002]) if (season >= r.seasons[0] && season <= r.seasons[1]) return r;
  throw new Error('no NFL rules version covers season ' + season);
}

export interface NflTeam {
  code: string;
  name: string;
  conference: 'AFC' | 'NFC';
  division: string;   // e.g. 'AFC East'
}

export interface NflGame {
  game_id: string;
  week: number;
  home: number;       // team index
  away: number;
  done: boolean;
  home_score: number | null;
  away_score: number | null;
  /** touchdowns scored, when the source carries them (completed games only) */
  home_td: number | null;
  away_td: number | null;
}

/* ----------------------------------------------------------- the league */
export class League {
  teams: NflTeam[];
  games: NflGame[];
  T: number;
  G: number;
  conf: Int8Array;        // 0 AFC, 1 NFC
  div: Int8Array;         // 0..7
  gHome: Int16Array;
  gAway: Int16Array;
  gDone: Uint8Array;
  gSameConf: Uint8Array;
  gSameDiv: Uint8Array;
  divisions: number[][];  // team indices per division, in team order
  conferences: number[][];
  divNames: string[];

  constructor(teams: NflTeam[], games: NflGame[]) {
    this.teams = teams; this.games = games;
    this.T = teams.length; this.G = games.length;
    this.conf = new Int8Array(this.T); this.div = new Int8Array(this.T);
    this.divNames = [];
    const divIdx: Record<string, number> = {};
    teams.forEach((t, i) => {
      if (t.conference !== 'AFC' && t.conference !== 'NFC') throw new Error('bad conference for ' + t.code);
      if (!t.division.startsWith(t.conference + ' ')) throw new Error('division ' + t.division + ' is not in ' + t.conference);
      if (divIdx[t.division] == null) { divIdx[t.division] = this.divNames.length; this.divNames.push(t.division); }
      this.conf[i] = t.conference === 'AFC' ? 0 : 1;
      this.div[i] = divIdx[t.division];
    });
    this.divisions = this.divNames.map((_, d) => teams.map((_, i) => i).filter((i) => this.div[i] === d));
    this.conferences = [0, 1].map((c) => teams.map((_, i) => i).filter((i) => this.conf[i] === c));
    this.gHome = new Int16Array(this.G); this.gAway = new Int16Array(this.G);
    this.gDone = new Uint8Array(this.G); this.gSameConf = new Uint8Array(this.G); this.gSameDiv = new Uint8Array(this.G);
    games.forEach((g, k) => {
      if (!(g.home >= 0 && g.home < this.T && g.away >= 0 && g.away < this.T) || g.home === g.away) throw new Error('bad teams in ' + g.game_id);
      this.gHome[k] = g.home; this.gAway[k] = g.away; this.gDone[k] = g.done ? 1 : 0;
      this.gSameConf[k] = this.conf[g.home] === this.conf[g.away] ? 1 : 0;
      this.gSameDiv[k] = this.div[g.home] === this.div[g.away] ? 1 : 0;
      if (g.done && !(Number.isInteger(g.home_score) && Number.isInteger(g.away_score))) throw new Error('completed game without scores: ' + g.game_id);
    });
  }
}

/** a run's results for every game, plus lazily available scoring detail */
export interface SeasonResults {
  /** home margin per game (home - away); 0 is a tie */
  margin: Int16Array;
  /** points per side for every game, completed exactly and simulated games
      from the Estimated points model; null when the provider cannot supply */
  points?: () => { home: Int16Array; away: Int16Array } | null;
  /** touchdowns per side; null when any game lacks them */
  touchdowns?: () => { home: Int16Array; away: Int16Array } | null;
}

export interface TieContext {
  rng: Xoshiro128;
  diag(key: string, n?: number): void;
  flag(key: string): void;
  trace(ev: Record<string, unknown>): void;
}

/* -------------------------------------------------------- the standings */
export class Standings {
  L: League;
  R: SeasonResults;
  ctx: TieContext;
  T: number;
  w2: Int32Array; gp: Int32Array;            // 2*wins + ties, games
  h2hW2: Int32Array; h2hG: Int32Array; h2hNet: Int32Array;   // [a*T+b]
  divW2: Int32Array; divG: Int32Array;
  confW2: Int32Array; confG: Int32Array;
  netAll: Int32Array; netConf: Int32Array;
  sovNum: Float64Array; sovDen: Float64Array;
  sosNum: Float64Array; sosDen: Float64Array;
  divRankPos: Int32Array;                    // position within division after the division tiebreaker (0 = winner)
  private pts: { pf: Int32Array; pa: Int32Array } | null | undefined;
  private tds: Int32Array | null | undefined;
  private rankCache: Record<string, Int32Array> = {};

  constructor(L: League, R: SeasonResults, ctx: TieContext) {
    this.L = L; this.R = R; this.ctx = ctx;
    const T = L.T; this.T = T;
    this.w2 = new Int32Array(T); this.gp = new Int32Array(T);
    this.h2hW2 = new Int32Array(T * T); this.h2hG = new Int32Array(T * T); this.h2hNet = new Int32Array(T * T);
    this.divW2 = new Int32Array(T); this.divG = new Int32Array(T);
    this.confW2 = new Int32Array(T); this.confG = new Int32Array(T);
    this.netAll = new Int32Array(T); this.netConf = new Int32Array(T);
    this.sovNum = new Float64Array(T); this.sovDen = new Float64Array(T);
    this.sosNum = new Float64Array(T); this.sosDen = new Float64Array(T);
    this.divRankPos = new Int32Array(T).fill(-1);
    const m = R.margin;
    for (let k = 0; k < L.G; k++) {
      const h = L.gHome[k], a = L.gAway[k], d = m[k];
      const hw = d > 0 ? 2 : d === 0 ? 1 : 0, aw = 2 - hw;
      this.w2[h] += hw; this.w2[a] += aw; this.gp[h]++; this.gp[a]++;
      this.h2hW2[h * T + a] += hw; this.h2hW2[a * T + h] += aw;
      this.h2hG[h * T + a]++; this.h2hG[a * T + h]++;
      this.h2hNet[h * T + a] += d; this.h2hNet[a * T + h] -= d;
      this.netAll[h] += d; this.netAll[a] -= d;
      if (L.gSameDiv[k]) { this.divW2[h] += hw; this.divW2[a] += aw; this.divG[h]++; this.divG[a]++; }
      if (L.gSameConf[k]) { this.confW2[h] += hw; this.confW2[a] += aw; this.confG[h]++; this.confG[a]++; this.netConf[h] += d; this.netConf[a] -= d; }
    }
    /* strength of victory: the combined record of every club defeated (each
       defeat counted once per game); strength of schedule: of every opponent
       (each game counted once). Aggregated as one ratio of integers. */
    for (let k = 0; k < L.G; k++) {
      const h = L.gHome[k], a = L.gAway[k], d = m[k];
      this.sosNum[h] += this.w2[a]; this.sosDen[h] += 2 * this.gp[a];
      this.sosNum[a] += this.w2[h]; this.sosDen[a] += 2 * this.gp[h];
      if (d > 0) { this.sovNum[h] += this.w2[a]; this.sovDen[h] += 2 * this.gp[a]; }
      else if (d < 0) { this.sovNum[a] += this.w2[h]; this.sovDen[a] += 2 * this.gp[h]; }
    }
  }

  pct(t: number): number { return this.gp[t] > 0 ? this.w2[t] / (2 * this.gp[t]) : 0; }
  sov(t: number): number { return this.sovDen[t] > 0 ? this.sovNum[t] / this.sovDen[t] : 0; }
  sos(t: number): number { return this.sosDen[t] > 0 ? this.sosNum[t] / this.sosDen[t] : 0; }
  wins(t: number): number { return this.w2[t] / 2; }

  /** points for/against every club, or null when the provider cannot supply them */
  pointsTotals(): { pf: Int32Array; pa: Int32Array } | null {
    if (this.pts !== undefined) return this.pts;
    const P = this.R.points ? this.R.points() : null;
    if (!P) { this.pts = null; return null; }
    const pf = new Int32Array(this.T), pa = new Int32Array(this.T);
    for (let k = 0; k < this.L.G; k++) {
      const h = this.L.gHome[k], a = this.L.gAway[k];
      if (P.home[k] - P.away[k] !== this.R.margin[k]) throw new Error('points provider disagrees with the margin of game ' + this.L.games[k].game_id);
      pf[h] += P.home[k]; pa[h] += P.away[k]; pf[a] += P.away[k]; pa[a] += P.home[k];
    }
    this.pts = { pf, pa };
    return this.pts;
  }
  netTouchdowns(): Int32Array | null {
    if (this.tds !== undefined) return this.tds;
    const D = this.R.touchdowns ? this.R.touchdowns() : null;
    if (!D) { this.tds = null; return null; }
    const net = new Int32Array(this.T);
    for (let k = 0; k < this.L.G; k++) {
      const h = this.L.gHome[k], a = this.L.gAway[k], d = D.home[k] - D.away[k];
      net[h] += d; net[a] -= d;
    }
    this.tds = net;
    return net;
  }
  /** combined rank (points scored rank + points allowed rank) among `pool`,
      competition ranking: equal values share the better rank */
  combinedRank(pool: 'conference' | 'league', t: number): number | null {
    const P = this.pointsTotals();
    if (!P) return null;
    const key = pool + (pool === 'conference' ? this.L.conf[t] : '');
    let ranks = this.rankCache[key];
    if (!ranks) {
      const members = pool === 'conference' ? this.L.conferences[this.L.conf[t]] : this.L.teams.map((_, i) => i);
      ranks = new Int32Array(this.T).fill(-1);
      for (const x of members) {
        let rs = 1, ra = 1;
        for (const y of members) { if (P.pf[y] > P.pf[x]) rs++; if (P.pa[y] < P.pa[x]) ra++; }
        ranks[x] = rs + ra;
      }
      this.rankCache[key] = ranks;
    }
    return ranks[t];
  }

  /* --------------------------------------------- tiebreaker step values
     Each returns one value per club (higher is better), or null when the
     step does not apply to this set of clubs. */
  private recordAmong(clubs: number[]): number[] | null {
    const T = this.T;
    const vals: number[] = [];
    for (const x of clubs) {
      let w = 0, g = 0;
      for (const y of clubs) if (y !== x) { w += this.h2hW2[x * T + y]; g += this.h2hG[x * T + y]; }
      if (g === 0) return null;
      vals.push(w / (2 * g));
    }
    return vals;
  }
  private commonOpponents(clubs: number[]): number[] {
    const T = this.T, out: number[] = [];
    for (let o = 0; o < T; o++) {
      if (clubs.indexOf(o) >= 0) continue;
      let all = true;
      for (const x of clubs) if (this.h2hG[x * T + o] === 0) { all = false; break; }
      if (all) out.push(o);
    }
    return out;
  }
  private commonRecord(clubs: number[], minimum: number): number[] | null {
    const T = this.T, opp = this.commonOpponents(clubs);
    const vals: number[] = [];
    for (const x of clubs) {
      let w = 0, g = 0;
      for (const o of opp) { w += this.h2hW2[x * T + o]; g += this.h2hG[x * T + o]; }
      if (g === 0 || g < minimum) return null;
      vals.push(w / (2 * g));
    }
    return vals;
  }
  private commonNet(clubs: number[]): number[] | null {
    const T = this.T, opp = this.commonOpponents(clubs);
    if (!opp.length) return null;
    return clubs.map((x) => { let s = 0; for (const o of opp) s += this.h2hNet[x * T + o]; return s; });
  }
  /** -1: unsupported input (the caller flags it); values otherwise */
  private stepValues(step: string, clubs: number[]): number[] | null | -1 {
    switch (step) {
      case 'head_to_head': return this.recordAmong(clubs);
      case 'head_to_head_if_played': {
        const [a, b] = clubs;
        if (this.h2hG[a * this.T + b] === 0) return null;
        return this.recordAmong(clubs);
      }
      case 'head_to_head_sweep': return this.sweep(clubs);
      case 'division_record': return clubs.map((x) => this.divG[x] > 0 ? this.divW2[x] / (2 * this.divG[x]) : 0);
      case 'common_games': return this.commonRecord(clubs, 0);
      case 'common_games_min4': return this.commonRecord(clubs, 4);
      case 'conference_record': return clubs.map((x) => this.confG[x] > 0 ? this.confW2[x] / (2 * this.confG[x]) : 0);
      case 'strength_of_victory': return clubs.map((x) => this.sov(x));
      case 'strength_of_schedule': return clubs.map((x) => this.sos(x));
      case 'combined_rank_conference':
      case 'combined_rank_league': {
        const pool = step === 'combined_rank_conference' ? 'conference' : 'league';
        const out: number[] = [];
        for (const x of clubs) { const r = this.combinedRank(pool, x); if (r == null) return -1; out.push(-r); }
        return out;
      }
      case 'net_points_common': return this.commonNet(clubs);
      case 'net_points_conference': return clubs.map((x) => this.netConf[x]);
      case 'net_points_all': return clubs.map((x) => this.netAll[x]);
      case 'net_touchdowns': {
        const n = this.netTouchdowns();
        if (!n) return -1;
        return clubs.map((x) => n[x]);
      }
      default: throw new Error('unknown tiebreaker step ' + step);
    }
  }
  /** wild card head-to-head sweep among 3+ clubs: 1 for a club that beat each
      of the others, -1 for one that lost to each, 0 otherwise; null when no
      club swept or was swept */
  private sweep(clubs: number[]): number[] | null {
    const T = this.T;
    const playedAll = (x: number) => clubs.every((y) => y === x || this.h2hG[x * T + y] > 0);
    const wonAll = (x: number) => clubs.every((y) => y === x || this.h2hW2[x * T + y] === 2 * this.h2hG[x * T + y]);
    const lostAll = (x: number) => clubs.every((y) => y === x || this.h2hW2[x * T + y] === 0);
    for (const x of clubs) if (playedAll(x) && wonAll(x)) return clubs.map((y) => (y === x ? 1 : 0));
    const swept = clubs.filter((x) => playedAll(x) && lostAll(x));
    if (swept.length === 1) return clubs.map((y) => (y === swept[0] ? -1 : 0));
    return null;
  }

  /* ------------------------------------------------------ the procedure */
  /** the club that wins a tie among `clubs` (same record), by `mode` */
  pickBest(clubs: number[], mode: 'division' | 'wildcard', depth = 0): number {
    if (depth > 64) throw new Error('tiebreaker did not terminate');
    if (clubs.length === 1) return clubs[0];
    const L = this.L;
    let set = clubs.slice().sort((a, b) => a - b);
    if (mode === 'wildcard') {
      const d0 = L.div[set[0]];
      if (set.every((x) => L.div[x] === d0)) return this.pickBest(set, 'division', depth + 1);
      if (set.length >= 3) {
        /* step 1 of the three-club format: keep only the highest-ranked club of
           each division, by the division tiebreaker's own order */
        const best: Record<number, number> = {};
        for (const x of set) {
          if (this.divRankPos[x] < 0) throw new Error('division ranks must be settled before wild card ties');
          const d = L.div[x];
          if (best[d] == null || this.divRankPos[x] < this.divRankPos[best[d]]) best[d] = x;
        }
        const reps = Object.keys(best).map((k) => best[+k]).sort((a, b) => a - b);
        if (reps.length < set.length) this.ctx.diag('tb:wildcard:division_reduction');
        if (reps.length === 1) return reps[0];
        set = reps;
      }
    }
    const steps = mode === 'division' ? DIVISION_STEPS
      : (set.length === 2 ? WILDCARD_TWO_STEPS : WILDCARD_THREE_STEPS);
    for (const step of steps) {
      const vals = this.stepValues(step, set);
      if (vals === null) continue;
      if (vals === -1) {
        this.ctx.flag('tiebreak_unsupported_input');
        this.ctx.diag('tb:unsupported:' + step);
        this.ctx.trace({ type: 'tiebreak_unsupported', step, clubs: set.map((x) => L.teams[x].code) });
        return this.coin(set, mode, 'unsupported:' + step);
      }
      if (step === 'combined_rank_conference' || step === 'combined_rank_league') this.ctx.flag('tiebreak_estimated_points');
      let best = -Infinity;
      for (const v of vals) if (v > best) best = v;
      const top = set.filter((_, i) => vals[i] === best);
      if (top.length === set.length) continue;
      this.ctx.diag('tb:' + mode + ':' + (set.length === 2 ? '2' : '3+') + ':' + step);
      if (top.length === 1) {
        this.ctx.trace({ type: 'tiebreak', mode, step, clubs: set.map((x) => L.teams[x].code), winner: L.teams[top[0]].code });
        return top[0];
      }
      this.ctx.trace({ type: 'tiebreak_eliminate', mode, step, clubs: set.map((x) => L.teams[x].code), remaining: top.map((x) => L.teams[x].code) });
      return this.pickBest(top, mode, depth + 1);
    }
    return this.coin(set, mode, 'coin_toss');
  }

  private coin(set: number[], mode: string, why: string): number {
    const i = this.ctx.rng.nextInt(set.length);
    this.ctx.diag('tb:' + mode + ':coin_toss');
    this.ctx.trace({ type: 'coin_toss', mode, why, clubs: set.map((x) => this.L.teams[x].code), winner: this.L.teams[set[i]].code });
    return set[i];
  }

  /** order clubs: by percentage, ties by repeated application of the procedure */
  orderBy(clubs: number[], mode: 'division' | 'wildcard', limit = Infinity): number[] {
    const byPct = clubs.slice().sort((a, b) => this.pct(b) - this.pct(a) || a - b);
    const out: number[] = [];
    let i = 0;
    while (i < byPct.length && out.length < limit) {
      let j = i;
      while (j + 1 < byPct.length && this.pct(byPct[j + 1]) === this.pct(byPct[i])) j++;
      let group = byPct.slice(i, j + 1);
      while (group.length && out.length < limit) {
        const w = group.length === 1 ? group[0] : this.pickBest(group, mode);
        out.push(w);
        group = group.filter((x) => x !== w);
      }
      i = j + 1;
    }
    return out;
  }

  /** settle every division's order (needed first: wild card reductions read it) */
  rankDivisions(): number[][] {
    return this.L.divisions.map((members) => {
      const ord = this.orderBy(members, 'division');
      ord.forEach((t, p) => { this.divRankPos[t] = p; });
      return ord;
    });
  }
}

export const DIVISION_STEPS = ['head_to_head', 'division_record', 'common_games', 'conference_record', 'strength_of_victory',
  'strength_of_schedule', 'combined_rank_conference', 'combined_rank_league', 'net_points_common', 'net_points_all', 'net_touchdowns'];
export const WILDCARD_TWO_STEPS = ['head_to_head_if_played', 'conference_record', 'common_games_min4', 'strength_of_victory',
  'strength_of_schedule', 'combined_rank_conference', 'combined_rank_league', 'net_points_conference', 'net_points_all', 'net_touchdowns'];
export const WILDCARD_THREE_STEPS = ['head_to_head_sweep', 'conference_record', 'common_games_min4', 'strength_of_victory',
  'strength_of_schedule', 'combined_rank_conference', 'combined_rank_league', 'net_points_conference', 'net_points_all', 'net_touchdowns'];

export interface ConferenceSeeds {
  conference: number;
  /** seeds[k] = team index of seed k+1 */
  seeds: number[];
  divisionWinners: number[];
}

/** the playoff field of each conference: division winners seeded by record
    (ties: wild card tiebreakers), then the wild cards by record (ties: the
    wild card procedure, which reduces to one club per division first) */
export function seedConferences(S: Standings, rules: RulesVersion): ConferenceSeeds[] {
  const divOrders = S.rankDivisions();
  return [0, 1].map((c) => {
    const winners = divOrders.filter((o) => S.L.conf[o[0]] === c).map((o) => o[0]);
    const seededWinners = S.orderBy(winners, 'wildcard');
    const rest = S.L.conferences[c].filter((t) => winners.indexOf(t) < 0);
    const wc = S.orderBy(rest, 'wildcard', rules.playoff_clubs_per_conference - winners.length);
    return { conference: c, seeds: seededWinners.concat(wc), divisionWinners: seededWinners };
  });
}

/* ------------------------------------------------------- the postseason */
export type Round = 'wild_card' | 'divisional' | 'conference' | 'super_bowl';
export interface PlayoffGame { round: Round; home: number; away: number; neutral: boolean; homeSeed: number; awaySeed: number; homeBye: boolean }
/** decides one postseason game: returns the winner (never a tie) */
export type GameResolver = (g: PlayoffGame) => number;

export interface PostseasonResult {
  reached: Record<Round, number[]>;   // clubs that played in each round (bye clubs listed in divisional)
  conferenceChampions: number[];      // [AFC, NFC]
  champion: number;
  games: Array<PlayoffGame & { winner: number }>;
}

/** the bracket: wild card pairings by seed, the top seed(s) on a bye, the
    divisional round RESEEDED (the best remaining seed hosts the lowest), the
    conference final at the better seed, the Super Bowl at a neutral site */
export function playPostseason(seeds: ConferenceSeeds[], rules: RulesVersion, resolve: GameResolver, superBowlHome: 'AFC' | 'NFC'): PostseasonResult {
  const games: Array<PlayoffGame & { winner: number }> = [];
  const reached: Record<Round, number[]> = { wild_card: [], divisional: [], conference: [], super_bowl: [] };
  const play = (g: PlayoffGame) => { const w = resolve(g); if (w !== g.home && w !== g.away) throw new Error('resolver returned a club not in the game'); games.push({ ...g, winner: w }); return w; };
  const champs: number[] = [];
  for (const cs of seeds) {
    if (cs.seeds.length !== rules.playoff_clubs_per_conference) throw new Error('conference field has ' + cs.seeds.length + ' clubs');
    const seedOf = (t: number) => cs.seeds.indexOf(t) + 1;
    let alive: number[] = cs.seeds.slice(0, rules.byes_per_conference);
    for (const [hi, lo] of rules.wild_card_pairs) {
      const h = cs.seeds[hi - 1], a = cs.seeds[lo - 1];
      reached.wild_card.push(h, a);
      alive.push(play({ round: 'wild_card', home: h, away: a, neutral: false, homeSeed: hi, awaySeed: lo, homeBye: false }));
    }
    /* divisional: reseed */
    alive.sort((x, y) => seedOf(x) - seedOf(y));
    reached.divisional.push(...alive);
    const byes = new Set(cs.seeds.slice(0, rules.byes_per_conference));
    const d1 = play({ round: 'divisional', home: alive[0], away: alive[3], neutral: false, homeSeed: seedOf(alive[0]), awaySeed: seedOf(alive[3]), homeBye: byes.has(alive[0]) });
    const d2 = play({ round: 'divisional', home: alive[1], away: alive[2], neutral: false, homeSeed: seedOf(alive[1]), awaySeed: seedOf(alive[2]), homeBye: byes.has(alive[1]) });
    const pair = [d1, d2].sort((x, y) => seedOf(x) - seedOf(y));
    reached.conference.push(...pair);
    champs.push(play({ round: 'conference', home: pair[0], away: pair[1], neutral: false, homeSeed: seedOf(pair[0]), awaySeed: seedOf(pair[1]), homeBye: false }));
  }
  reached.super_bowl.push(champs[0], champs[1]);
  /* the neutral-site final still has a designated home team (it alternates by
     conference; the season config states which); the model's context terms
     read that designation even with home field switched off */
  const [sh, sa] = superBowlHome === 'AFC' ? [champs[0], champs[1]] : [champs[1], champs[0]];
  const champion = play({ round: 'super_bowl', home: sh, away: sa, neutral: true, homeSeed: 0, awaySeed: 0, homeBye: false });
  return { reached, conferenceChampions: champs, champion, games };
}
