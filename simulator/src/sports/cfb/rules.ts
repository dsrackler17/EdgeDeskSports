/* ===========================================================================
   COLLEGE FOOTBALL CONFERENCE STANDINGS, TIEBREAKERS AND CHAMPIONSHIP-GAME
   QUALIFICATION — one engine, a procedure per conference rules version.

   Every conference publishes its own procedure (CFB_SIMULATOR_NOTES.md §5
   quotes each one with its source and verification status; config.ts carries
   the status the gates read). They share a small vocabulary of steps, so a
   procedure here is an ordered list of steps for a two-team tie and another
   for a tie of three or more:

     h2h               two teams: the winner of their game (skipped if they did not play)
     h2h_group         three or more: win percentage in games among the tied teams,
                       only when every tied team played every other one
     h2h_sweep         three or more, not all played: a tied team that beat every other
                       tied team it played advances; with `eliminate_swept`, one that
                       lost to every other is removed
     common_pct        win percentage against the conference opponents every tied team played
     next_common       win percentage against the next highest placed common opponent,
                       proceeding down the standings; a group of teams tied in the
                       standings is taken as one collective opponent (the Big 12 text)
     opp_conf_pct      combined conference win percentage of the team's conference opponents
     div_pct / next_div / common_nondiv_pct    the Sun Belt's divisional steps
     total_wins_12     wins in a 12-game season, one FCS win counted (Big 12 step e)
     fbs_pct           overall win percentage against FBS teams (Sun Belt)
     scoring_margin    the SEC's capped relative scoring margin: needs scores, which
                       the simulation draws only for this step (Estimated)
     metric            an EXTERNAL ranking the procedure names (SportSource Analytics,
                       a composite of computer rankings, the CFP committee's ranking).
                       No model here produces one: the step is resolved by an
                       Estimated surrogate (the run's latent team strength: frozen
                       rating + the run's persistent offset), and every run that
                       reaches it is flagged and counted per conference
     draw              the commissioner's coin toss / lot / draw, from the seeded coin stream

   Resolution, for every procedure: the steps run in order on the tied set.
   A step that separates one team from the rest advances that team; a step
   that separates a SUBSET (two or more best) removes the others and the
   procedure restarts on the subset (with the two-team list when two remain);
   a step that separates nobody passes to the next step. After a team
   advances, the remaining tied teams restart at step 1. Percentages are
   compared as exact fractions (cross-multiplied integers).

   Participants: the conference's slots (two, or one per division) are
   filled from the top of the standings by conference win percentage. A
   group no larger than the remaining slots qualifies whole; a larger group
   goes to the procedure one team at a time. A postseason-ineligible team's
   games count in every standing, but it cannot take a slot. The ACC's 2026
   definition of tied teams (a team with an alternate number of conference
   games is tied when it has the same number of wins or of losses) replaces
   the plain win-percentage group for that conference.
   =========================================================================== */

export interface CfbTeam {
  id: string;           // normalized key (football/fbs/fbs.js normKey)
  name: string;         // feed spelling
  conference: string;   // season conference (feed label), or 'FBS Independents'
  division: string | null;
  ccg_eligible: boolean;
  cfp_eligible: boolean;
  /** the frozen opponent-adjusted rating (points, neutral field) at the as-of date */
  rating: number;
}
export interface CfbGame {
  game_id: string;
  week: number;
  kickoff: string;
  home: number;          // team index, or -1 for a non-FBS (FCS or lower) opponent
  away: number;
  neutral: boolean;
  /** the conference whose standings this game counts in, or null (non-conference) */
  conf: string | null;
  /** counts in championship-game qualification (false: Army-Navy after the title game, Pac-12 flex week) */
  ccg_counts: boolean;
  /** played before Selection Day (the committee does not consider later games) */
  before_selection: boolean;
  done: boolean;
  home_points: number | null;
  away_points: number | null;
  /** the venue hosts an exempt contest for the visitor (a game at Hawai'i, NCAA Bylaw 17.10.5.2.1) */
  exempt_for_visitor: boolean;
}

export type StepKind = 'h2h' | 'h2h_group' | 'h2h_sweep' | 'common_pct' | 'next_common' | 'opp_conf_pct' | 'div_pct' | 'next_div'
  | 'common_nondiv_pct' | 'total_wins_12' | 'fbs_pct' | 'scoring_margin' | 'metric' | 'draw';
export interface Step { kind: StepKind; label: string; eliminate_swept?: boolean; metric?: string }
export interface Procedure {
  id: string;
  two: Step[];
  multi: Step[];
  /** the ACC 2026 definition of tied teams (alternate numbers of conference games) */
  acc_alternate_games?: boolean;
  /** one slot per division (division champions) instead of two from the whole conference */
  divisions?: boolean;
  /** the procedure that decides which division champion hosts, when their conference records are equal */
  host?: Step[];
}

const S = (kind: StepKind, label: string, extra: Partial<Step> = {}): Step => ({ kind, label, ...extra });
const H2H = S('h2h', 'head-to-head');
const GROUP = S('h2h_group', 'win percentage among the tied teams (all played each other)');
const SWEEP = S('h2h_sweep', 'a tied team that beat each of the others advances');
const COMMON = S('common_pct', 'win percentage against all common conference opponents');
const NEXT = S('next_common', 'win percentage against the next highest placed common opponent');
const SOS = S('opp_conf_pct', 'combined conference win percentage of conference opponents');
const DRAW = S('draw', 'draw / coin toss');
const metric = (name: string) => S('metric', name + ' (external ranking: Estimated surrogate)', { metric: name });

/* The procedures. Source and verification status per id: config.ts CONFERENCE_RULES. */
export const PROCEDURES: Record<string, Procedure> = {
  /* ACC Football Tiebreaker Policy, as amended July 1, 2026 (official PDF) */
  'ACC-2026': { id: 'ACC-2026', acc_alternate_games: true,
    two: [H2H, metric('SportSource Analytics Team Success Ranking'), DRAW],
    multi: [S('h2h_group', 'best record among the tied teams (all common opponents)'), S('h2h_sweep', 'beat each of the other tied teams (placed) / lost to each (removed)', { eliminate_swept: true }), metric('SportSource Analytics Team Success Ranking'), DRAW] },
  /* Big 12 Football 2024 Tiebreaker Policy (official PDF; "beginning with the 2024 football season") */
  'B12-2024': { id: 'B12-2024',
    two: [H2H, COMMON, NEXT, SOS, S('total_wins_12', 'total wins in a 12-game season (one FCS win counted)'), metric('SportSource Analytics Team Rating Score'), DRAW],
    multi: [GROUP, SWEEP, COMMON, NEXT, SOS, S('total_wins_12', 'total wins in a 12-game season (one FCS win counted)'), metric('SportSource Analytics Team Rating Score'), DRAW] },
  /* MAC Football Championship Tiebreaker (official page, published 2025-11-12) */
  'MAC-2025': { id: 'MAC-2025',
    two: [H2H, S('common_pct', 'win percentage versus all common opponents'), metric('SportSource Analytics Team Rating Score'), S('next_common', 'win percentage versus common opponents by order of finish'), SOS, DRAW],
    multi: [GROUP, SWEEP, S('common_pct', 'win percentage versus all common opponents'), metric('SportSource Analytics Team Rating Score'), S('next_common', 'win percentage versus common opponents by order of finish'), SOS, DRAW] },
  /* Sun Belt Football Tie-Breaking Procedures (official page; East and West divisions) */
  'SBC-DIV': { id: 'SBC-DIV', divisions: true,
    two: [H2H, S('div_pct', 'overall divisional win percentage'), S('next_div', 'win percentage versus the next highest team in the divisional standings'), S('common_nondiv_pct', 'win percentage against common non-divisional conference opponents'),
      metric('CFP ranking if the ranked team wins its final game, else computer composite (Anderson & Hester, Massey, Colley, Wolfe)'), S('fbs_pct', 'overall win percentage against FBS teams'), DRAW],
    multi: [S('h2h_group', 'win percentage in games among the tied teams'), S('div_pct', 'overall divisional win percentage'), S('next_div', 'win percentage versus the next highest team in the divisional standings'), S('common_nondiv_pct', 'win percentage against common non-divisional conference opponents'),
      metric('CFP ranking if the ranked team wins its final game, else computer composite (Anderson & Hester, Massey, Colley, Wolfe)'), S('fbs_pct', 'overall win percentage against FBS teams'), DRAW],
    host: [H2H, metric('CFP ranking / computer composite'), COMMON, S('fbs_pct', 'overall win percentage against FBS teams'), DRAW] },
  /* SEC 2024 procedure (secondary reports; the official page is script-rendered) */
  'SEC-2024': { id: 'SEC-2024',
    two: [H2H, COMMON, S('next_common', 'record against the highest placed common opponent, proceeding through the standings'), S('opp_conf_pct', 'cumulative conference winning percentage of all conference opponents'), S('scoring_margin', 'capped relative total scoring margin versus all conference opponents (Estimated scores)'), DRAW],
    multi: [GROUP, SWEEP, COMMON, S('next_common', 'record against the highest placed common opponent, proceeding through the standings'), S('opp_conf_pct', 'cumulative conference winning percentage of all conference opponents'), S('scoring_margin', 'capped relative total scoring margin versus all conference opponents (Estimated scores)'), DRAW] },
  /* Big Ten 2024 procedure (secondary reports; the official PDF refused the runner) */
  'B1G-2024': { id: 'B1G-2024',
    two: [H2H, COMMON, NEXT, SOS, metric('SportSource Analytics Team Rating Score'), DRAW],
    multi: [GROUP, SWEEP, COMMON, NEXT, SOS, metric('SportSource Analytics Team Rating Score'), DRAW] },
  /* American 2025 procedure (official 2025 scenarios page) */
  'AAC-2025': { id: 'AAC-2025',
    two: [H2H, metric('CFP ranking if the ranked team wins its final game, else computer composite (SP+, SportSource SOR, ESPN SOR, KPI)'), DRAW],
    multi: [GROUP, SWEEP, metric('CFP ranking if the ranked team wins its final game, else computer composite (SP+, SportSource SOR, ESPN SOR, KPI)'), DRAW] },
  /* Mountain West (secondary reports) */
  'MW-2024': { id: 'MW-2024',
    two: [H2H, metric('CFP ranking, else composite (SP+, ESPN SOR, KPI, SportSource)'), S('fbs_pct', 'overall win percentage'), DRAW],
    multi: [GROUP, SWEEP, metric('CFP ranking, else composite (SP+, ESPN SOR, KPI, SportSource)'), S('fbs_pct', 'overall win percentage'), DRAW] },
  /* No published 2026 procedure found (Conference USA, Pac-12): a PROVISIONAL procedure, labelled so */
  'PROVISIONAL': { id: 'PROVISIONAL',
    two: [H2H, COMMON, metric('unpublished procedure (provisional)'), DRAW],
    multi: [GROUP, SWEEP, COMMON, metric('unpublished procedure (provisional)'), DRAW] }
};

/* --------------------------------------------------------------- the league */
export interface ConfInfo { name: string; members: number[]; procedure: Procedure; slots: number; divisions: string[] }

export class CfbLeague {
  readonly T: number;
  readonly G: number;
  readonly teams: CfbTeam[];
  readonly games: CfbGame[];
  readonly confs: ConfInfo[];
  readonly confOf: Int32Array;              // team -> index into confs, -1 for independents
  /** per conference: the indices of the games that count for its title-game qualification */
  readonly confGames: number[][];
  /** per team: the indices of every regular-season game it plays */
  readonly teamGames: number[][];
  constructor(teams: CfbTeam[], games: CfbGame[], procedures: Record<string, string>) {
    this.teams = teams; this.games = games; this.T = teams.length; this.G = games.length;
    const names = [...new Set(teams.map((t) => t.conference))].filter((c) => procedures[c]).sort();
    this.confs = names.map((name) => {
      const p = PROCEDURES[procedures[name]];
      if (!p) throw new Error('no tiebreak procedure ' + procedures[name] + ' for ' + name);
      const members = teams.map((t, i) => (t.conference === name ? i : -1)).filter((i) => i >= 0);
      const divisions = p.divisions ? [...new Set(members.map((i) => teams[i].division as string))].sort() : [];
      if (p.divisions && (divisions.length !== 2 || divisions.some((d) => !d))) throw new Error(name + ': a divisional procedure needs exactly two named divisions');
      return { name, members, procedure: p, slots: 2, divisions };
    });
    this.confOf = new Int32Array(this.T).fill(-1);
    this.confs.forEach((c, ci) => c.members.forEach((t) => { this.confOf[t] = ci; }));
    this.confGames = this.confs.map(() => []);
    this.teamGames = teams.map(() => []);
    games.forEach((g, k) => {
      if (g.home >= 0) this.teamGames[g.home].push(k);
      if (g.away >= 0) this.teamGames[g.away].push(k);
      if (g.conf && g.ccg_counts) {
        const ci = this.confs.findIndex((c) => c.name === g.conf);
        if (ci < 0) return;
        if (g.home < 0 || g.away < 0 || this.confOf[g.home] !== ci || this.confOf[g.away] !== ci) throw new Error('conference game ' + g.game_id + ' between teams outside ' + g.conf);
        this.confGames[ci].push(k);
      }
    });
  }
}

/** one simulated (or observed) season's results: the home margin of every game (no ties in college football) */
export interface SeasonResults {
  margin: Float64Array;                       // > 0 home won, < 0 away won; never 0
  /** Estimated scores for the scoring-margin step, drawn on first use (null: unavailable) */
  points: () => { home: Float64Array; away: Float64Array } | null;
  /** the Estimated surrogate for an external ranking: higher is better */
  surrogate: (t: number) => number;
}

export interface TbContext {
  rng: { nextInt(n: number): number };
  diag: (k: string, n?: number) => void;
  flag: (k: string) => void;
  trace: (ev: Record<string, unknown>) => void;
}

type Frac = [number, number];
const cmp = (a: Frac, b: Frac) => a[0] * b[1] - b[0] * a[1];

/* ---------------------------------------------------- one conference's table */
export class ConfTable {
  readonly L: CfbLeague;
  readonly ci: number;
  readonly info: ConfInfo;
  readonly R: SeasonResults;
  readonly ctx: TbContext;
  readonly w = new Map<number, number>();
  readonly l = new Map<number, number>();
  readonly dw = new Map<number, number>();
  readonly dl = new Map<number, number>();
  /** games counted, as [opponent, won 1/0, game index] per team */
  readonly log = new Map<number, Array<[number, number, number]>>();
  /** every step that separated teams, and what for: a title-game berth, or only the seed order of teams already in */
  readonly decisions: Array<{ purpose: 'berth' | 'seed'; step: StepKind }> = [];
  /** the Estimated / random inputs that decided something, by purpose (e.g. 'berth:metric', 'seed:draw') */
  get estimated(): string[] { return this.decisions.filter((d) => d.step === 'metric' || d.step === 'draw' || d.step === 'scoring_margin').map((d) => d.purpose + ':' + d.step); }
  /** a scoring-margin step that found no Estimated scores to use */
  pointsUnavailable = false;
  constructor(L: CfbLeague, ci: number, R: SeasonResults, ctx: TbContext) {
    this.L = L; this.ci = ci; this.info = L.confs[ci]; this.R = R; this.ctx = ctx;
    for (const t of this.info.members) { this.w.set(t, 0); this.l.set(t, 0); this.dw.set(t, 0); this.dl.set(t, 0); this.log.set(t, []); }
    for (const k of L.confGames[ci]) {
      const g = L.games[k], m = R.margin[k];
      if (!(m !== 0 && Number.isFinite(m))) throw new Error('game ' + g.game_id + ' has no decided result');
      const win = m > 0 ? g.home : g.away, lose = m > 0 ? g.away : g.home;
      this.w.set(win, this.w.get(win)! + 1); this.l.set(lose, this.l.get(lose)! + 1);
      this.log.get(g.home)!.push([g.away, m > 0 ? 1 : 0, k]); this.log.get(g.away)!.push([g.home, m > 0 ? 0 : 1, k]);
      if (this.info.divisions.length && L.teams[g.home].division === L.teams[g.away].division) {
        this.dw.set(win, this.dw.get(win)! + 1); this.dl.set(lose, this.dl.get(lose)! + 1);
      }
    }
  }
  pct(t: number): Frac { const w = this.w.get(t)!, n = w + this.l.get(t)!; return n ? [w, n] : [0, 1]; }
  games(t: number): number { return this.w.get(t)! + this.l.get(t)!; }
  /** the conference standings as groups of equal win percentage, best first (optionally within a division) */
  groups(members: number[] = this.info.members): number[][] {
    const s = members.slice().sort((a, b) => cmp(this.pct(b), this.pct(a)) || a - b);
    const out: number[][] = [];
    for (const t of s) { const last = out[out.length - 1]; if (last && cmp(this.pct(last[0]), this.pct(t)) === 0) last.push(t); else out.push([t]); }
    return out;
  }
  /** a's record against the set `opp` (games counted in this table) */
  recordVs(a: number, opp: Set<number>): Frac {
    let w = 0, n = 0;
    for (const [o, won] of this.log.get(a)!) if (opp.has(o)) { n++; w += won; }
    return [w, n];
  }
  played(a: number, b: number): boolean { return this.log.get(a)!.some(([o]) => o === b); }
  opponents(a: number): Set<number> { return new Set(this.log.get(a)!.map(([o]) => o)); }

  /* ------------------------------------------------------------ the steps */
  evalStep(step: Step, tied: number[]): Frac[] | null {
    const L = this.L;
    switch (step.kind) {
      case 'h2h': {
        if (tied.length !== 2) return null;
        const [a, b] = tied, ra = this.recordVs(a, new Set([b]));
        if (!ra[1]) return null;
        return [[ra[0], ra[1]], [ra[1] - ra[0], ra[1]]];
      }
      case 'h2h_group': {
        const set = new Set(tied);
        for (const a of tied) for (const b of tied) if (a < b && !this.played(a, b)) return null;
        return tied.map((a) => { const r = this.recordVs(a, set); return r[1] ? r : [0, 1]; });
      }
      case 'h2h_sweep': {
        let allPlayed = true;
        for (const a of tied) for (const b of tied) if (a < b && !this.played(a, b)) allPlayed = false;
        if (allPlayed) return null;
        /* swept / sweeper among the tied teams it actually played */
        const v = tied.map((a) => {
          const others = tied.filter((b) => b !== a);
          const beatAll = others.every((b) => { const r = this.recordVs(a, new Set([b])); return r[1] > 0 && r[0] === r[1]; });
          const lostAll = others.every((b) => { const r = this.recordVs(a, new Set([b])); return r[1] > 0 && r[0] === 0; });
          return beatAll ? 2 : lostAll && step.eliminate_swept ? 0 : 1;
        });
        return v.map((x): Frac => [x, 1]);
      }
      case 'common_pct': {
        const common = this.common(tied);
        if (!common.size) return null;
        return tied.map((a) => { const r = this.recordVs(a, common); return r[1] ? r : [0, 1]; });
      }
      case 'next_common': {
        const common = this.common(tied), set = new Set(tied);
        for (const grp of this.groups()) {
          const opp = new Set(grp.filter((o) => !set.has(o) && common.has(o)));
          if (!opp.size) continue;
          const v = tied.map((a) => this.recordVs(a, opp));
          if (v.some((x) => !x[1])) continue;
          if (v.some((x) => cmp(x, v[0]) !== 0)) return v;
        }
        return null;
      }
      case 'opp_conf_pct': {
        return tied.map((a): Frac => {
          let w = 0, n = 0;
          for (const [o] of this.log.get(a)!) { w += this.w.get(o)!; n += this.games(o); }
          return n ? [w, n] : [0, 1];
        });
      }
      case 'div_pct':
        return tied.map((a): Frac => { const w = this.dw.get(a)!, n = w + this.dl.get(a)!; return n ? [w, n] : [0, 1]; });
      case 'next_div': {
        const div = L.teams[tied[0]].division, set = new Set(tied);
        const mates = this.info.members.filter((t) => L.teams[t].division === div && !set.has(t));
        for (const grp of this.groups(mates)) {
          const opp = new Set(grp);
          const v = tied.map((a) => this.recordVs(a, opp));
          if (v.some((x) => !x[1])) continue;
          if (v.some((x) => cmp(x, v[0]) !== 0)) return v;
        }
        return null;
      }
      case 'common_nondiv_pct': {
        const div = L.teams[tied[0]].division;
        const common = new Set([...this.common(tied)].filter((o) => L.teams[o].division !== div));
        if (!common.size) return null;
        return tied.map((a) => { const r = this.recordVs(a, common); return r[1] ? r : [0, 1]; });
      }
      case 'total_wins_12':
        return tied.map((a): Frac => [this.totalWins12(a), 1]);
      case 'fbs_pct':
        return tied.map((a): Frac => this.fbsPct(a));
      case 'scoring_margin': {
        const pts = this.R.points();
        if (!pts) { this.pointsUnavailable = true; return null; }
        return tied.map((a): Frac => [this.cappedMargin(a, pts), 1]);
      }
      case 'metric':
        return tied.map((a): Frac => [this.R.surrogate(a), 1]);
      case 'draw': {
        const pick = tied[this.ctx.rng.nextInt(tied.length)];
        return tied.map((a): Frac => [a === pick ? 1 : 0, 1]);
      }
    }
  }
  /** opponents (in this table) that every tied team played */
  common(tied: number[]): Set<number> {
    const set = new Set(tied);
    let c: Set<number> | null = null;
    for (const a of tied) {
      const o = new Set<number>([...this.opponents(a)].filter((x) => !set.has(x)));
      c = c ? new Set<number>([...c].filter((x: number) => o.has(x))) : o;
    }
    return c || new Set<number>();
  }
  /** Big 12 step e: regular-season wins, one FCS (or lower) win counted, the visitor's exempt game at Hawai'i excluded */
  totalWins12(a: number): number {
    let w = 0, fcs = 0;
    for (const k of this.L.teamGames[a]) {
      const g = this.L.games[k], m = this.R.margin[k], home = g.home === a;
      if (!home && g.exempt_for_visitor) continue;
      const won = home ? m > 0 : m < 0, opp = home ? g.away : g.home;
      if (!won) continue;
      if (opp < 0) { if (fcs++ === 0) w++; } else w++;
    }
    return w;
  }
  fbsPct(a: number): Frac {
    let w = 0, n = 0;
    for (const k of this.L.teamGames[a]) {
      const g = this.L.games[k], home = g.home === a, opp = home ? g.away : g.home;
      if (opp < 0) continue;
      n++; if (home ? this.R.margin[k] > 0 : this.R.margin[k] < 0) w++;
    }
    return n ? [w, n] : [0, 1];
  }
  /** the SEC's capped relative scoring margin: offense capped at 42, defense at 48, over conference games */
  cappedMargin(a: number, pts: { home: Float64Array; away: Float64Array }): number {
    let s = 0;
    for (const [, , k] of this.log.get(a)!) {
      const g = this.L.games[k], home = g.home === a;
      const pf = home ? pts.home[k] : pts.away[k], pa = home ? pts.away[k] : pts.home[k];
      s += Math.min(pf, 42) - Math.min(pa, 48);
    }
    return s;
  }

  /* ---------------------------------------------------------- resolution */
  /** the team that wins the tie among `tied` (two or more), by this conference's procedure */
  pickOne(tied: number[], steps?: Step[], purpose: 'berth' | 'seed' = 'berth'): number {
    let cur = tied.slice();
    restart: for (let guard = 0; guard < 64; guard++) {
      if (cur.length === 1) return cur[0];
      const list = steps || (cur.length === 2 ? this.info.procedure.two : this.info.procedure.multi);
      for (const step of list) {
        const v = this.evalStep(step, cur);
        if (!v) continue;
        let best = v[0];
        for (const x of v) if (cmp(x, best) > 0) best = x;
        const top = cur.filter((_, i) => cmp(v[i], best) === 0);
        if (top.length === cur.length) continue;
        this.ctx.diag('tiebreak:' + this.info.name + ':' + purpose + ':' + step.kind);
        this.decisions.push({ purpose, step: step.kind });
        if (top.length === 1) return top[0];
        cur = top;
        continue restart;
      }
      throw new Error(this.info.name + ': tiebreak procedure ' + this.info.procedure.id + ' did not resolve ' + cur.length + ' teams');
    }
    throw new Error(this.info.name + ': tiebreak did not converge');
  }
  /** the full order of a tied group: the procedure advances one team at a time and the rest restart */
  order(tied: number[], steps?: Step[], purpose: 'berth' | 'seed' = 'berth'): number[] {
    const out: number[] = [], rem = tied.slice();
    while (rem.length) { const t = rem.length === 1 ? rem[0] : this.pickOne(rem, steps, purpose); out.push(t); rem.splice(rem.indexOf(t), 1); }
    return out;
  }

  /** the ACC's tied teams among `cand`: best win percentage plus alternate-games teams with the same wins or losses */
  accTied(cand: number[]): number[] {
    const g = this.groups(cand), best = g[0];
    const bestW = new Set(best.map((t) => this.w.get(t)!)), bestL = new Set(best.map((t) => this.l.get(t)!)), bestN = new Set(best.map((t) => this.games(t)));
    const extra = cand.filter((t) => !best.includes(t) && !bestN.has(this.games(t)) && (bestW.has(this.w.get(t)!) || bestL.has(this.l.get(t)!)));
    return best.concat(extra);
  }

  /** the championship-game participants in seed order (seed 1 first), and how they were decided */
  participants(): { seeds: number[]; decided_by: string[] } {
    const L = this.L, P = this.info.procedure;
    const eligible = (t: number) => L.teams[t].ccg_eligible;
    const decided: string[] = [];
    if (P.divisions) {
      const champs = this.info.divisions.map((d) => {
        const cand = this.info.members.filter((t) => L.teams[t].division === d && eligible(t));
        const top = this.groups(cand)[0];
        if (top.length > 1) decided.push(d + ': ' + top.length + '-team tie');
        return top.length === 1 ? top[0] : this.pickOne(top);
      });
      /* host: the division champion with the better conference win percentage; equal records go to the host procedure */
      const c = cmp(this.pct(champs[0]), this.pct(champs[1]));
      const seeds = c > 0 ? champs : c < 0 ? [champs[1], champs[0]] : (() => { decided.push('host tie'); const h = this.pickOne(champs, P.host, 'seed'); return [h, champs.find((x) => x !== h)!]; })();
      return { seeds, decided_by: decided };
    }
    const seeds: number[] = [];
    let cand = this.info.members.filter(eligible);
    while (seeds.length < this.info.slots && cand.length) {
      const grp = P.acc_alternate_games ? this.accTied(cand) : this.groups(cand)[0];
      const room = this.info.slots - seeds.length;
      if (grp.length <= room) {
        /* the whole group qualifies; its seed order (who hosts / who is No. 1) by the procedure */
        const ord = grp.length > 1 ? this.order(grp, undefined, 'seed') : grp;
        if (grp.length > 1) decided.push('seed order of a ' + grp.length + '-team group');
        seeds.push(...ord);
        cand = cand.filter((t) => !grp.includes(t));
      } else {
        decided.push(grp.length + '-team tie for ' + room + ' slot' + (room > 1 ? 's' : ''));
        const t = this.pickOne(grp);
        seeds.push(t);
        cand = cand.filter((x) => x !== t);
      }
    }
    if (seeds.length < this.info.slots) throw new Error(this.info.name + ': fewer than ' + this.info.slots + ' eligible teams');
    return { seeds, decided_by: decided };
  }
}
