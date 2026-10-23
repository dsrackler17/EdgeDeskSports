/* ===========================================================================
   NBA STANDINGS, TIEBREAKERS, SEEDING, THE PLAY-IN AND THE PLAYOFF BRACKET.

   Rules version NBA-2021 (2020-21 onward: seeds 1-6 qualify, 7-10 play in)
   and its predecessors for the historical reproduction tests: NBA-2016
   (2015-16 to 2018-19: seeds 1-8 by record) and NBA-2007 (2006-07 to
   2014-15: the three division winners and the best other club take seeds
   1-4). Season keys are END years (2027 = 2026-27), the data's convention.
   The 2019-20 restart (seeding games, a conditional play-in) is not modelled.
   The procedure text, its source and its verification status are in
   NBA_SIMULATOR_NOTES.md §Rules; nba/config.ts carries the facts.

   TIEBREAKERS (winning percentage; every percentage compared as a cross
   product of integers, so equal rationals are equal)

   TWO CLUBS TIED                            THREE OR MORE CLUBS TIED
    1 head-to-head                            1 division winner (whatever the divisions)
    2 division winner                         2 games among the tied clubs
    3 division record (same division only)    3 division record (all in one division only)
    4 conference record                       4 conference record
    5 vs playoff clubs, own conference        5 vs playoff clubs, own conference
    6 vs playoff clubs, other conference      6 point differential, all games
    7 point differential, all games           7 random drawing (seeded)
    8 random drawing (seeded)

   "Playoff clubs" are the clubs whose record is at least that of the club in
   the last playoff-eligible place (10th with the play-in, 8th before), so a
   club tied for that place counts — they are fixed by records before any
   tie is broken. A step a club cannot be measured on (no games against the
   set) is skipped for the whole tied group.

   COMPLETE AND PARTIAL BREAKS (the league's Paragraph L.2.c, nba.com's
   standings page). The criteria apply in order until the first that tells
   the tied clubs apart. A complete break (every club a different value)
   orders them by it. A partial break orders the levels it separates — any
   club that did better ranks above any that did worse — and each group still
   level starts again from the first criterion, with the two-club or the
   multi-club procedure as its size dictates. (Reproduces 2008-09: DEN, POR
   and SA at 54-28; the division-winner step puts POR below both, DEN beats SA
   head-to-head, and POR is fourth although it beat SA head-to-head — the order
   the league seeded them in.) Division
   titles are decided first, by the same procedure among the clubs tied for
   the lead (the division-winner step cannot separate them).

   HOME COURT in every series: the club with the better regular-season record;
   between clubs of one conference that is the better place in the conference
   standings (record, then the tiebreakers above), which is NOT the seed for a
   play-in qualifier. Between conferences (the Finals): the better record,
   then the two-club procedure applied across conferences.
   =========================================================================== */
import type { Xoshiro128 } from '../../core/prng.ts';

export type Conference = 'East' | 'West';

export interface NbaRulesVersion {
  id: string;
  /** end-year season keys covered */
  seasons: [number, number];
  play_in: boolean;
  /** clubs per conference qualifying without the play-in */
  direct_seeds: number;
  /** the place that fixes "playoff clubs" for tiebreak steps 5-6 */
  tiebreak_playoff_place: number;
  /** seeds reserved for division winners (with the best other club when 4) */
  division_seed_block: 0 | 4;
  /** the multi-club restart rule (see header); kept explicit so a test can pin it */
  multi_club_restart: 'eliminate_then_restart';
  /** home pattern of a best-of-seven per round, as the 1-based game numbers at the home-court club */
  home_games: { first_round: number[]; conference_semifinals: number[]; conference_finals: number[]; finals: number[] };
}

const P22111 = [1, 2, 5, 7], P232 = [1, 2, 6, 7];
export const NBA_2021: NbaRulesVersion = {
  id: 'NBA-2021', seasons: [2021, 2027], play_in: true, direct_seeds: 6, tiebreak_playoff_place: 10, division_seed_block: 0, multi_club_restart: 'eliminate_then_restart',
  home_games: { first_round: P22111, conference_semifinals: P22111, conference_finals: P22111, finals: P22111 }
};
export const NBA_2016: NbaRulesVersion = {
  id: 'NBA-2016', seasons: [2016, 2019], play_in: false, direct_seeds: 8, tiebreak_playoff_place: 8, division_seed_block: 0, multi_club_restart: 'eliminate_then_restart',
  home_games: { first_round: P22111, conference_semifinals: P22111, conference_finals: P22111, finals: P22111 }
};
export const NBA_2007: NbaRulesVersion = {
  id: 'NBA-2007', seasons: [2007, 2015], play_in: false, direct_seeds: 8, tiebreak_playoff_place: 8, division_seed_block: 4, multi_club_restart: 'eliminate_then_restart',
  home_games: { first_round: P22111, conference_semifinals: P22111, conference_finals: P22111, finals: P22111 }
};
/** the Finals were 2-3-2 through 2013 (2012-13), 2-2-1-1-1 from 2014 */
export function rulesFor(season: number): NbaRulesVersion {
  for (const r of [NBA_2021, NBA_2016, NBA_2007]) {
    if (season >= r.seasons[0] && season <= r.seasons[1]) {
      return season <= 2013 ? { ...r, home_games: { ...r.home_games, finals: P232 } } : r;
    }
  }
  throw new Error('no NBA rules version covers season ' + season + ' (2019-20 and before 2006-07 are not modelled)');
}

export interface NbaTeam { id: string; code: string; name: string; conference: Conference; division: string }
export interface NbaGame { game_id: string; home: number; away: number; done: boolean; home_score: number | null; away_score: number | null }

/* ----------------------------------------------------------- the league */
export class League {
  teams: NbaTeam[]; games: NbaGame[]; T: number; G: number;
  conf: Int8Array; div: Int8Array; gHome: Int16Array; gAway: Int16Array; gSameConf: Uint8Array; gSameDiv: Uint8Array;
  divisions: number[][]; conferences: number[][]; divNames: string[];
  constructor(teams: NbaTeam[], games: NbaGame[]) {
    this.teams = teams; this.games = games; this.T = teams.length; this.G = games.length;
    this.conf = new Int8Array(this.T); this.div = new Int8Array(this.T); this.divNames = [];
    const divIdx: Record<string, number> = {};
    teams.forEach((t, i) => {
      if (t.conference !== 'East' && t.conference !== 'West') throw new Error('bad conference for ' + t.code);
      if (divIdx[t.division] == null) { divIdx[t.division] = this.divNames.length; this.divNames.push(t.division); }
      this.conf[i] = t.conference === 'East' ? 0 : 1; this.div[i] = divIdx[t.division];
    });
    for (let d = 0; d < this.divNames.length; d++) {
      const cs = new Set(teams.filter((_, i) => this.div[i] === d).map((t) => t.conference));
      if (cs.size !== 1) throw new Error('division ' + this.divNames[d] + ' spans conferences');
    }
    this.divisions = this.divNames.map((_, d) => teams.map((_, i) => i).filter((i) => this.div[i] === d));
    this.conferences = [0, 1].map((c) => teams.map((_, i) => i).filter((i) => this.conf[i] === c));
    this.gHome = new Int16Array(this.G); this.gAway = new Int16Array(this.G); this.gSameConf = new Uint8Array(this.G); this.gSameDiv = new Uint8Array(this.G);
    games.forEach((g, k) => {
      if (!(g.home >= 0 && g.home < this.T && g.away >= 0 && g.away < this.T) || g.home === g.away) throw new Error('bad teams in ' + g.game_id);
      this.gHome[k] = g.home; this.gAway[k] = g.away;
      this.gSameConf[k] = this.conf[g.home] === this.conf[g.away] ? 1 : 0;
      this.gSameDiv[k] = this.div[g.home] === this.div[g.away] ? 1 : 0;
      if (g.done && !(Number.isInteger(g.home_score) && Number.isInteger(g.away_score) && g.home_score !== g.away_score)) throw new Error('completed game without a decisive score: ' + g.game_id);
    });
  }
  /** set a game's two clubs: an NBA Cup game not yet on the schedule takes the run's own pairing */
  setPair(k: number, home: number, away: number): void {
    if (!(k >= 0 && k < this.G) || this.games[k].done) throw new Error('setPair: game ' + k + ' is not an open slot');
    if (!(home >= 0 && home < this.T && away >= 0 && away < this.T) || home === away) throw new Error('setPair: bad teams for game ' + this.games[k].game_id);
    this.gHome[k] = home; this.gAway[k] = away;
    this.gSameConf[k] = this.conf[home] === this.conf[away] ? 1 : 0;
    this.gSameDiv[k] = this.div[home] === this.div[away] ? 1 : 0;
  }
}

export interface TieContext {
  rng: Xoshiro128;
  diag(key: string, n?: number): void;
  flag(key: string): void;
  trace(ev: Record<string, unknown>): void;
}

/** a winning percentage as an exact fraction */
interface Frac { w: number; g: number }
const cmpFrac = (a: Frac, b: Frac) => a.w * b.g - b.w * a.g;   // > 0: a better

/* -------------------------------------------------------- the standings */
export class Standings {
  L: League; ctx: TieContext; rules: NbaRulesVersion; T: number;
  w: Int32Array; gp: Int32Array; h2hW: Int32Array; h2hG: Int32Array;
  divW: Int32Array; divG: Int32Array; confW: Int32Array; confG: Int32Array; net: Int32Array;
  /** division winner per team (1/0), set by decideDivisions() */
  divWinner: Uint8Array;
  divisionWinners: number[] = [];
  /** playoff clubs for steps 5-6 (by record, ties included) */
  playoffClub: Uint8Array;
  /** conference standings, places 1..15 (team indices), set by rankConferences() */
  confOrder: number[][] = [[], []];
  /** place in the conference standings (0-based) */
  place: Int32Array;

  constructor(L: League, margin: Int16Array | Int32Array, ctx: TieContext, rules: NbaRulesVersion) {
    this.L = L; this.ctx = ctx; this.rules = rules; const T = L.T; this.T = T;
    this.w = new Int32Array(T); this.gp = new Int32Array(T); this.h2hW = new Int32Array(T * T); this.h2hG = new Int32Array(T * T);
    this.divW = new Int32Array(T); this.divG = new Int32Array(T); this.confW = new Int32Array(T); this.confG = new Int32Array(T); this.net = new Int32Array(T);
    for (let k = 0; k < L.G; k++) {
      const h = L.gHome[k], a = L.gAway[k], d = margin[k];
      if (!(d !== 0 && Number.isInteger(d))) throw new Error('game ' + L.games[k].game_id + ' has no decisive margin (' + d + ')');
      const win = d > 0 ? h : a, lose = d > 0 ? a : h;
      this.w[win]++; this.gp[h]++; this.gp[a]++;
      this.h2hW[win * T + lose]++; this.h2hG[h * T + a]++; this.h2hG[a * T + h]++;
      this.net[h] += d; this.net[a] -= d;
      if (L.gSameDiv[k]) { this.divW[win]++; this.divG[h]++; this.divG[a]++; }
      if (L.gSameConf[k]) { this.confW[win]++; this.confG[h]++; this.confG[a]++; }
    }
    this.divWinner = new Uint8Array(T); this.playoffClub = new Uint8Array(T); this.place = new Int32Array(T).fill(-1);
    this.fixPlayoffClubs();
  }
  /** playoff clubs for steps 5-6: record at least that of the club in the last playoff-eligible place */
  fixPlayoffClubs(): void {
    const P = this.rules.tiebreak_playoff_place;
    this.playoffClub.fill(0);
    for (const c of this.L.conferences) {
      const sorted = c.slice().sort((x, y) => -cmpFrac(this.pct(x), this.pct(y)));
      const cut = this.pct(sorted[Math.min(P, sorted.length) - 1]);
      for (const t of c) if (cmpFrac(this.pct(t), cut) >= 0) this.playoffClub[t] = 1;
    }
  }
  pct(t: number): Frac { return { w: this.w[t], g: this.gp[t] }; }
  losses(t: number): number { return this.gp[t] - this.w[t]; }
  /** wins and games of t against a set of clubs */
  vs(t: number, set: number[]): Frac { let w = 0, g = 0; for (const o of set) { if (o === t) continue; w += this.h2hW[t * this.T + o]; g += this.h2hG[t * this.T + o]; } return { w, g }; }
  playoffSet(conf: number): number[] { return this.L.conferences[conf].filter((t) => this.playoffClub[t]); }

  /** the steps, in order, for a tied set (two-club or multi-club procedure) */
  private steps(S: number[]): Array<{ id: string; frac?: (t: number) => Frac | null; int?: (t: number) => number }> {
    const L = this.L;
    const sameDiv = S.every((t) => L.div[t] === L.div[S[0]]);
    const divW = (t: number): Frac => ({ w: this.divW[t], g: this.divG[t] });
    const confW = (t: number): Frac => ({ w: this.confW[t], g: this.confG[t] });
    const ownPO = (t: number): Frac => this.vs(t, this.playoffSet(L.conf[t]));
    const othPO = (t: number): Frac => this.vs(t, this.playoffSet(1 - L.conf[t]));
    if (S.length === 2) {
      const [a, b] = S;
      return [
        { id: 'head_to_head', frac: (t) => (this.h2hG[a * this.T + b] > 0 ? this.vs(t, [t === a ? b : a]) : null) },
        { id: 'division_winner', int: (t) => this.divWinner[t] },
        ...(sameDiv ? [{ id: 'division_record', frac: divW }] : []),
        { id: 'conference_record', frac: confW },
        { id: 'vs_playoff_own_conference', frac: ownPO },
        { id: 'vs_playoff_other_conference', frac: othPO },
        { id: 'point_differential', int: (t) => this.net[t] }
      ];
    }
    return [
      { id: 'division_winner', int: (t) => this.divWinner[t] },
      { id: 'games_among_tied', frac: (t) => this.vs(t, S) },
      ...(sameDiv ? [{ id: 'division_record', frac: divW }] : []),
      { id: 'conference_record', frac: confW },
      { id: 'vs_playoff_own_conference', frac: ownPO },
      { id: 'point_differential', int: (t) => this.net[t] }
    ];
  }

  /** the first step that tells a tied set apart: its clubs grouped by their value on that step, the best
      level first (a complete break when every group is one club), or null when no step separates them */
  private split(S: number[], mode: string): { step: string; levels: number[][] } | null {
    for (const st of this.steps(S)) {
      let cmp: (i: number, j: number) => number;
      if (st.frac) {
        const v = S.map((t) => st.frac!(t));
        if (v.some((x) => x == null || x.g === 0)) continue;   /* not measurable for the whole group: skipped */
        cmp = (i, j) => cmpFrac(v[j] as Frac, v[i] as Frac);
      } else {
        const v = S.map((t) => st.int!(t));
        cmp = (i, j) => v[j] - v[i];
      }
      const order = S.map((_, i) => i).sort((i, j) => cmp(i, j) || i - j);
      const levels: number[][] = [];
      for (let k = 0; k < order.length; k++) {
        if (k > 0 && cmp(order[k - 1], order[k]) === 0) levels[levels.length - 1].push(S[order[k]]);
        else levels.push([S[order[k]]]);
      }
      if (levels.length === 1) continue;
      this.ctx.diag('tb:' + mode + ':' + (S.length === 2 ? '2' : '3+') + ':' + st.id);
      return { step: st.id, levels };
    }
    return null;
  }
  /** rank a set of clubs tied on record (Paragraph L.2.c). The first step that tells them apart orders the
      levels it separates; each group still level on it starts again from step 1, with the two-club or the
      multi-club procedure as its size dictates. */
  rankTied(set: number[], mode: string): number[] {
    if (set.length <= 1) return set.slice();
    const sp = this.split(set, mode);
    const code = (xs: number[]) => xs.map((x) => this.L.teams[x].code);
    if (sp) {
      this.ctx.trace({ type: sp.levels.length === set.length ? 'tiebreak' : 'tiebreak_partial', mode, step: sp.step, clubs: code(set), levels: sp.levels.map(code) });
      return sp.levels.flatMap((g) => this.rankTied(g, mode));
    }
    /* random drawing: one place at a time, seeded */
    const i = this.ctx.rng.nextInt(set.length);
    this.ctx.diag('tb:' + mode + ':random_drawing'); this.ctx.flag('tiebreak_random_drawing');
    this.ctx.trace({ type: 'random_drawing', mode, clubs: code(set), winner: this.L.teams[set[i]].code });
    return [set[i]].concat(this.rankTied(set.filter((_, j) => j !== i), mode));
  }
  /** order a set of clubs: by record, ties broken by rankTied */
  order(set: number[], mode: string): number[] {
    const sorted = set.slice().sort((x, y) => -cmpFrac(this.pct(x), this.pct(y)) || x - y);
    const out: number[] = [];
    let i = 0;
    while (i < sorted.length) {
      let j = i + 1; while (j < sorted.length && cmpFrac(this.pct(sorted[j]), this.pct(sorted[i])) === 0) j++;
      const grp = sorted.slice(i, j);
      if (grp.length > 1) this.ctx.diag('tb:' + mode + ':tied_groups');
      for (const t of this.rankTied(grp, mode)) out.push(t);
      i = j;
    }
    return out;
  }
  /** division titles first */
  decideDivisions(): number[] {
    this.divisionWinners = this.L.divisions.map((d) => {
      let best = d[0]; for (const t of d) if (cmpFrac(this.pct(t), this.pct(best)) > 0) best = t;
      const top = d.filter((t) => cmpFrac(this.pct(t), this.pct(best)) === 0);
      if (top.length > 1) this.ctx.diag('tb:division:tied_groups');
      return top.length === 1 ? top[0] : this.rankTied(top, 'division')[0];
    });
    for (const t of this.divisionWinners) this.divWinner[t] = 1;
    return this.divisionWinners;
  }
  /** the conference standings, places 1..15 */
  rankConferences(): number[][] {
    if (!this.divisionWinners.length) this.decideDivisions();
    this.confOrder = this.L.conferences.map((c) => this.order(c, 'conference'));
    for (const o of this.confOrder) o.forEach((t, i) => { this.place[t] = i; });
    return this.confOrder;
  }
  /** > 0 when a has the better regular-season record for home court (a, b in any conferences) */
  homeCourt(a: number, b: number): number {
    if (this.L.conf[a] === this.L.conf[b]) return this.place[b] - this.place[a];
    const c = cmpFrac(this.pct(a), this.pct(b));
    if (c !== 0) return c;
    return this.rankTied([a, b], 'finals_home_court')[0] === a ? 1 : -1;
  }
}

/* -------------------------------------------------------- seeds */
export interface ConferenceSeeds {
  conference: Conference;
  /** places 1..15 in the regular-season standings (team indices) */
  places: number[];
  /** seeds 1..direct_seeds known before any play-in (team indices) */
  direct: number[];
  /** play-in places 7..10 (empty without a play-in) */
  playIn: number[];
}
export function seedConferences(S: Standings): ConferenceSeeds[] {
  const r = S.rules;
  if (!S.confOrder[0].length) S.rankConferences();
  return S.confOrder.map((places, c) => {
    let order = places.slice();
    if (r.division_seed_block === 4) {
      const winners = S.divisionWinners.filter((t) => S.L.conf[t] === c);
      const best = order.find((t) => !S.divWinner[t]) as number;
      const block = order.filter((t) => winners.includes(t) || t === best);
      order = block.concat(order.filter((t) => !block.includes(t)));
    }
    return { conference: c === 0 ? 'East' : 'West', places, direct: order.slice(0, r.direct_seeds), playIn: r.play_in ? order.slice(r.direct_seeds, r.direct_seeds + 4) : [] } as ConferenceSeeds;
  });
}

/* -------------------------------------------------------- the postseason */
export type Round = 'play_in' | 'first_round' | 'conference_semifinals' | 'conference_finals' | 'finals';
export const ROUNDS: Round[] = ['first_round', 'conference_semifinals', 'conference_finals', 'finals'];

/** one game to decide: who hosts, which game of which series */
export interface PostseasonGameReq {
  round: Round; conference: Conference | null;
  /** play-in: '7v8' | '9v10' | 'last'; series: game number 1..7 */
  key: string; game_no: number;
  home: number; away: number;
  /** the club with home court in the series (its higher-ranked side) */
  series_home: number; series_away: number;
  /** wins before this game: home-court club, other club */
  score: [number, number];
}
export type Resolver = (g: PostseasonGameReq) => number;

/** an observed postseason game, in start order: its stage (the data labels play-in and playoff games,
    not rounds — a pairing meets at most once in the playoffs), the two clubs, the host and the winner */
export interface PlayedGame { stage: 'play_in' | 'playoffs'; home: number; away: number; winner: number; game_id?: string }

export interface SeriesResult { round: Round; conference: Conference | null; high: number; low: number; winner: number; games: Array<{ game_no: number; home: number; winner: number; observed: boolean }> }
export interface PostseasonResult {
  /** final seeds 1..8 per conference after the play-in */
  seeds: number[][];
  playIn: Array<{ conference: Conference; key: string; home: number; away: number; winner: number; observed: boolean }>;
  series: SeriesResult[];
  reached: { conference_semifinals: number[]; conference_finals: number[]; finals: number[] };
  conferenceChampions: number[];
  champion: number;
}

/** the home pattern position of game n of a series in a round: true when the home-court club hosts */
export function hostsGame(rules: NbaRulesVersion, round: Exclude<Round, 'play_in'>, n: number): boolean {
  return rules.home_games[round].includes(n);
}

/** the observed games of one pairing, consumed in order */
class Observed {
  private list: PlayedGame[];
  used = 0;
  constructor(list: PlayedGame[]) { this.list = list.slice(); }
  take(round: Round, a: number, b: number): PlayedGame[] {
    const stage = round === 'play_in' ? 'play_in' : 'playoffs';
    const out = this.list.filter((g) => g.stage === stage && ((g.home === a && g.away === b) || (g.home === b && g.away === a)));
    this.used += out.length;
    return out;
  }
  get total(): number { return this.list.length; }
}

export function playSeries(rules: NbaRulesVersion, round: Exclude<Round, 'play_in'>, conference: Conference | null, high: number, low: number, resolve: Resolver, observed: PlayedGame[]): SeriesResult {
  const wins: [number, number] = [0, 0]; const games: SeriesResult['games'] = [];
  for (let n = 1; n <= 7 && wins[0] < 4 && wins[1] < 4; n++) {
    const home = hostsGame(rules, round, n) ? high : low, away = home === high ? low : high;
    const ob = observed[n - 1];
    let winner: number;
    if (ob) {
      if (ob.home !== home || ob.away !== away) throw new Error('observed ' + round + ' game ' + n + ' was hosted by the other club: the series home court (' + high + ') or the home pattern disagrees with the record');
      winner = ob.winner;
    } else winner = resolve({ round, conference, key: round, game_no: n, home, away, series_home: high, series_away: low, score: [wins[0], wins[1]] });
    if (winner !== home && winner !== away) throw new Error('resolver returned a club not in the game');
    wins[winner === high ? 0 : 1]++;
    games.push({ game_no: n, home, winner, observed: !!ob });
  }
  if (observed.length > games.length) throw new Error(round + ': ' + observed.length + ' observed games in a series that ended after ' + games.length);
  if (Math.max(wins[0], wins[1]) !== 4 || games.length < 4 || games.length > 7) throw new Error('series did not end at four wins');
  return { round, conference, high, low, winner: wins[0] === 4 ? high : low, games };
}

/**
 * The play-in (when the rules have one) and the four best-of-seven rounds.
 * `observed` holds every completed postseason game in start order: those are
 * fixed, and the bracket must agree with them (a disagreement throws: the
 * rules or the standings are wrong, nothing may be simulated).
 */
export function playPostseason(S: Standings, cs: ConferenceSeeds[], resolve: Resolver, observed: PlayedGame[] = []): PostseasonResult {
  const r = S.rules, ob = new Observed(observed);
  const playIn: PostseasonResult['playIn'] = [];
  const seeds: number[][] = [];
  const one = (conference: Conference, key: string, home: number, away: number): number => {
    const o = ob.take('play_in', home, away);
    if (o.length > 1) throw new Error('play-in ' + conference + ' ' + key + ': ' + o.length + ' observed games');
    let winner: number, observedG = false;
    if (o.length) {
      if (o[0].home !== home) throw new Error('observed play-in ' + key + ' (' + conference + ') was hosted by the lower place');
      winner = o[0].winner; observedG = true;
    } else winner = resolve({ round: 'play_in', conference, key, game_no: 1, home, away, series_home: home, series_away: away, score: [0, 0] });
    if (winner !== home && winner !== away) throw new Error('resolver returned a club not in the game');
    playIn.push({ conference, key, home, away, winner, observed: observedG });
    return winner;
  };
  for (const c of cs) {
    const s = c.direct.slice();
    if (r.play_in) {
      const [p7, p8, p9, p10] = c.playIn;
      const wA = one(c.conference, '7v8', p7, p8), lA = wA === p7 ? p8 : p7;
      const wB = one(c.conference, '9v10', p9, p10);
      const wC = one(c.conference, 'last', lA, wB);
      s.push(wA, wC);
    }
    if (s.length !== 8) throw new Error(c.conference + ': ' + s.length + ' playoff clubs');
    seeds.push(s);
  }
  const series: SeriesResult[] = [];
  const reached = { conference_semifinals: [] as number[], conference_finals: [] as number[], finals: [] as number[] };
  const play = (round: Exclude<Round, 'play_in'>, conference: Conference | null, a: number, b: number): number => {
    const high = S.homeCourt(a, b) > 0 ? a : b, low = high === a ? b : a;
    const res = playSeries(r, round, conference, high, low, resolve, ob.take(round, a, b));
    series.push(res);
    return res.winner;
  };
  const champs: number[] = [];
  seeds.forEach((s, c) => {
    const conf: Conference = c === 0 ? 'East' : 'West';
    /* the bracket is fixed: 1v8 and 4v5 meet, 2v7 and 3v6 meet; no reseeding */
    const q = [[0, 7], [3, 4], [2, 5], [1, 6]].map(([x, y]) => play('first_round', conf, s[x], s[y]));
    q.forEach((t) => reached.conference_semifinals.push(t));
    const sf = [play('conference_semifinals', conf, q[0], q[1]), play('conference_semifinals', conf, q[2], q[3])];
    sf.forEach((t) => reached.conference_finals.push(t));
    const cf = play('conference_finals', conf, sf[0], sf[1]);
    reached.finals.push(cf); champs.push(cf);
  });
  const champion = play('finals', null, champs[0], champs[1]);
  if (ob.used !== ob.total) throw new Error((ob.total - ob.used) + ' observed postseason games do not fit the bracket the standings produce');
  return { seeds, playIn, series, reached, conferenceChampions: champs, champion };
}
