/* ===========================================================================
   COLLEGE BASEBALL — the bridge to the served team model.

   The Simulator does not refit or reinvent the college baseball model. It
   replays the served one (college_baseball/lib/team_quality.js, the "hier"
   run model, with the configuration the learning loop serves:
   docs/model-loop/college_baseball/versions.json) through the committed
   warehouse, date by date, exactly as the walk-forward scores it:
     predict every game of a date, then add the date's games, then refit.
   Two things come out:
   - SNAPSHOTS of the model at chosen dates (before that date's games are
     added): each team's offence, defence and their posterior sds (team and
     conference parts), the run level and home terms, the parks. A game's two
     run expectations are rebuilt from a snapshot with the model's own
     formula (lh = exp(mu + off(home) - def(away) + hb [home] + park), ...),
     so a simulated tournament is priced by the model as of its first pitch;
   - every game's out-of-sample prediction, for the run-space calibration of
     season S, fitted on seasons S-3..S-1 only (college_baseball/lib/
     calibration.js), the "hier_cal" pricing model of the betting board.
   A season after the last one in the warehouse starts from its priors
   (carried strength regressed toward the current conference), with the last
   season's conference memberships where the new season has none.
   =========================================================================== */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CB = path.join(REPO, 'college_baseball');
const req = createRequire(import.meta.url);
export const W = req(path.join(CB, 'lib', 'warehouse.js'));
const M = req(path.join(CB, 'lib', 'models.js'));
const TQ = req(path.join(CB, 'lib', 'team_quality.js'));
const D = req(path.join(CB, 'lib', 'distribution.js'));
const CAL = req(path.join(CB, 'lib', 'calibration.js'));
const CFG = req(path.join(CB, 'config.js'));
/* the walk-forward module (the served configuration, the constants) loads only where it is needed: a worker
   prices from the snapshot's own copy (usePricing) */
let wf: any = null;
const WF = () => (wf = wf || req(path.join(CB, 'walkforward.js')));

export const FIRST_SEASON: number = CFG.SEASONS.first;
export const LAST_SEASON: number = CFG.SEASONS.last;

export interface ServedModel { version: string; tq: Record<string, number>; dist: { family: string; r: number }; seven_inning_factor: number; dh_seven_share: number }
let served: ServedModel | null = null;
/** the served run model's configuration (the learning loop's current version) and the constants it prices with */
export function servedModel(): ServedModel {
  if (served) return served;
  const h = WF().cfgsFromTuning().hier;
  if (!h || !h.tq) throw new Error('college baseball: no served run model configuration');
  const k = WF().constants();
  served = { version: h.loop_version || 'tuning', tq: h.tq, dist: h.dist || { family: 'nb', r: 4 }, seven_inning_factor: k.seven_inning_factor, dh_seven_share: WF().p7Context().share };
  return served;
}
/** the run-distribution constants the served model prices with (college_baseball/params/constants.json) */
export function servedConstants(): Record<string, unknown> { return WF().constants(); }

let table: ((lh: number, la: number) => number) | null = null;
let pricing: { dist: { family: string; r: number }; constants: Record<string, unknown> } | null = null;
/** price from this distribution and these constants (a snapshot's copy) instead of reading the served ones */
export function usePricing(dist: { family: string; r: number }, constants: Record<string, unknown>): void {
  if (pricing && JSON.stringify(pricing) === JSON.stringify({ dist, constants })) return;
  pricing = { dist, constants }; table = null;
}
/** P(home wins) for two run expectations, from the fitted run distribution (extra innings resolved, no ties) */
export function pHome(lh: number, la: number): number {
  if (!table) { const p = pricing || { dist: servedModel().dist, constants: servedConstants() }; table = D.pHomeTable(p.dist, p.constants); }
  return table!(lh, la);
}

export interface TeamState { id: string; name: string; conf: string; off: number; def: number; sd_team: number; sd_conf: number; info: number }
export interface Snapshot {
  season: number; date: string; mu: number; hb: number; hp: number;
  teams: Record<string, TeamState>;
  parks: Record<string, number>;
  /** the run-space calibration for this season (fitted on S-3..S-1), or null (raw expectations) */
  cal: { a: number; b: number; n: number } | null;
}
export interface Row { season: number; date: string; game_id: string; home_id: string; away_id: string; y: 0 | 1; neutral: number; lh: number; la: number; sd: number; p7: number; tourney: boolean }

function metaWithCarry(): any {
  const base = M.meta();
  const conf = (s: number, id: string) => { const c = base.conf(s, id); return c != null || s <= LAST_SEASON ? c : base.conf(LAST_SEASON, id); };
  const div = (s: number, id: string) => { const d = base.div(s, id); return d != null || s <= LAST_SEASON ? d : base.div(LAST_SEASON, id); };
  const name = (s: number, id: string) => base.name(s, id) || base.name(LAST_SEASON, id);
  return Object.assign({}, base, { conf, div, name });
}

function snap(tq: any, season: number, date: string, ids: Iterable<string>, meta: any): Snapshot {
  const teams: Record<string, TeamState> = {};
  for (const id of ids) {
    const r = tq.rating(id);
    teams[id] = { id, name: meta.name(season, id) || id, conf: r.conf, off: r.off, def: r.def, sd_team: r.sd_team, sd_conf: r.sd_conf, info: r.info };
  }
  const parks: Record<string, number> = {};
  for (let i = 0; i < tq.Pk.size; i++) parks[tq.Pk.keys[i]] = tq.pk[i] || 0;
  return { season, date, mu: tq.mu, hb: tq.hb, hp: tq.hp, teams, parks, cal: null };
}

export interface ReplayRequest {
  /** the last season to replay (its games are added); a later preseason may still be requested */
  through: number;
  /** snapshot dates per season: the model before that date's games, for the listed teams (null: every D-I team of the season) */
  at?: Array<{ season: number; date: string; teams: string[] | null; key?: string }>;
  /** the preseason of this season (after the replay ends): every D-I team of the last season, at its priors */
  preseason?: number;
}
export interface ReplayResult { snapshots: Map<string, Snapshot>; rows: Row[]; seconds: number; version: string }

/** D-I programs of a season (the last season's with any, for one the warehouse does not list yet) */
export function d1Teams(season: number): string[] {
  const all = W.teamSeasons().filter((t: any) => t.division === 1);
  const s = all.some((t: any) => t.season === season) ? season : Math.max(...all.filter((t: any) => t.season < season).map((t: any) => t.season));
  return all.filter((t: any) => t.season === s).map((t: any) => t.team_id);
}

/** replay the served model through the warehouse (see the header) */
export function replay(rq: ReplayRequest): ReplayResult {
  const t0 = Date.now();
  const sm = servedModel();
  const meta = metaWithCarry();
  const tq = new TQ.TeamQuality(Object.assign({}, sm.tq, { hier: true, parks: true }), meta);
  const games = W.results(FIRST_SEASON, rq.through);
  const want = new Map<string, Array<{ season: number; date: string; teams: string[] | null; key?: string }>>();
  for (const a of rq.at || []) { if (!want.has(a.date)) want.set(a.date, []); want.get(a.date)!.push(a); }
  const snapshots = new Map<string, Snapshot>(); const rows: Row[] = [];
  const share = sm.dh_seven_share;
  let season: number | null = null; let i = 0;
  const pending = [...want.keys()].sort();
  const takeUpTo = (date: string) => {
    /* snapshot dates with no games of their own are taken before the first later date */
    while (pending.length && pending[0] <= date) {
      const d = pending.shift()!;
      for (const a of want.get(d)!) {
        if (season !== a.season) continue;
        snapshots.set(a.key || a.season + ':' + a.date, snap(tq, a.season, a.date, a.teams || d1Teams(a.season), meta));
      }
    }
  };
  while (i < games.length) {
    const date = games[i].date; let j = i; while (j < games.length && games[j].date === date) j++;
    const day = games.slice(i, j); const s = day[0].season;
    if (s !== season) { takeUpTo(String(s) + '-01-00'); tq.startSeason(s); season = s; }
    takeUpTo(date);
    for (const g of day) {
      if (g.season < 2014) continue;
      const pr = tq.predict(g);
      rows.push({ season: g.season, date: g.date, game_id: g.game_id, home_id: g.home_id, away_id: g.away_id, y: g.home_runs > g.away_runs ? 1 : 0, neutral: g.neutral ? 1 : 0, lh: pr.lh, la: pr.la, sd: pr.sd_delta, p7: g.dh ? share : 0, tourney: false });
    }
    tq.addGames(day);
    tq.fit(Date.parse(date + 'T00:00:00Z') / 864e5 + 1);
    i = j;
  }
  takeUpTo('9999-12-31');
  if (rq.preseason) {
    tq.startSeason(rq.preseason);
    const key = 'preseason:' + rq.preseason;
    snapshots.set(key, snap(tq, rq.preseason, rq.preseason + '-01-01', d1Teams(rq.preseason), meta));
  }
  /* each snapshot carries its season's run-space calibration */
  const cals = calibrations(rows, [...new Set([...snapshots.values()].map((x) => x.season))]);
  for (const x of snapshots.values()) x.cal = cals.get(x.season) || null;
  return { snapshots, rows, seconds: (Date.now() - t0) / 1000, version: sm.version };
}

/** season S's run-space calibration, fitted on the replay's out-of-sample rows of S-3..S-1 (as the walk-forward does) */
export function calibrations(rows: Row[], seasons: number[]): Map<number, { a: number; b: number; n: number } | null> {
  const sm = servedModel();
  const by = new Map<number, Row[]>(); for (const r of rows) { if (!by.has(r.season)) by.set(r.season, []); by.get(r.season)!.push(r); }
  const out = new Map<number, { a: number; b: number; n: number } | null>();
  for (const s of seasons) {
    const fit: any[] = []; for (let t = s - 3; t < s; t++) for (const r of by.get(t) || []) fit.push({ lh: r.lh, la: r.la, sd: r.sd, y: r.y, neutral: r.neutral, p7: r.p7 });
    if (!table) pHome(5, 5);
    const c = CAL.fit(fit, table, sm.seven_inning_factor);
    out.set(s, c ? { a: c.a, b: c.b, n: c.n } : null);
  }
  return out;
}

/* ------------------------------------------------------------ pricing a game from a snapshot */
export interface Venue { neutral: boolean; park: number }
/** the model's log run expectations for home h against away a at a venue, calibrated (the board's hier_cal) */
export function expectations(S: Snapshot, h: TeamState, a: TeamState, v: Venue): { lh: number; la: number; sd: number } {
  const nh = v.neutral ? 0 : 1;
  let lh = Math.exp(S.mu + h.off - a.def + S.hb * nh + v.park);
  let la = Math.exp(S.mu + a.off - h.def - S.hp * nh + v.park);
  if (S.cal) { const c = CAL.apply(lh, la, S.cal, v.neutral); lh = c[0]; la = c[1]; }
  const same = h.conf === a.conf;
  const sd = Math.sqrt(h.sd_team * h.sd_team + a.sd_team * a.sd_team + (same ? 0 : h.sd_conf * h.sd_conf + a.sd_conf * a.sd_conf));
  return { lh, la, sd };
}
/** the served price of a single game: the calibrated expectations, integrated over the rating gap's uncertainty */
export function priceGame(S: Snapshot, h: TeamState, a: TeamState, v: Venue): number {
  const e = expectations(S, h, a, v);
  return TQ.integrate(e.lh, e.la, e.sd, pHome);
}
/** the same for a game whose rating gap is fixed by a draw (shift: home's log-strength draw minus away's) */
export function pricePinned(lh: number, la: number, shift: number): number {
  const f = Math.exp(shift / 2);
  return pHome(lh * f, la / f);
}
