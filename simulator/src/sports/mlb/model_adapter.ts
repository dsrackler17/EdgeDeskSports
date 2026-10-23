/* ===========================================================================
   THE SERVED MLB GAME MODEL, AS THE SIMULATOR READS IT.

   No new game model. Every simulated MLB game is priced by the EdgeDesk MLB
   lab brain, mlb/history/model.js (RunsModel), in the configuration the
   weekly loop serves (docs/model-loop/mlb/versions.json `current`), exactly
   as mlb/history/walkforward.js prices a game:

     log E[home runs] = mu + home + o_home - d_away - s_awaySP + k_park
     log E[away runs] = mu + o_away - d_home - s_homeSP + k_park

   then a negative binomial of size r for each side's nine-inning runs, a
   level score going to the home club at the extra-inning home rate xi, and
   the season's logistic recalibration of the win probability. r, xi and the
   recalibration are the served calibration for the season: fitted on the
   three earlier seasons' out-of-sample predictions (walkforward.js
   calibrationFor, called here, not copied).

   REPLAY. The fit is point-in-time by construction: replay() walks the
   committed game record date by date exactly as walkforward.js pass() does
   (startSeason, fit on earlier dates, predict, absorb) and captures the full
   state (unrounded) at the as-of date. simulator/tests/mlb_model.test.ts
   holds replay()'s predictions equal to walkforward.pass() on 2010-2011.
   The served model is fitted on regular-season games only; postseason games
   are never absorbed (an as-of date in October prices from the end of the
   regular season).

   THE ONE SIMULATOR CHOICE. A postseason game is played under the standard
   extra-inning rule while the served xi is measured on regular-season games
   played with the automatic runner (2020-): the postseason resolves a level
   draw at xi_standard, the home rate measured on extra-inning games played
   WITHOUT the runner (simulator/data/mlb_game_model_study.json). Nothing
   about innings, runners or scoring within a game is modelled.

   FAST PATH. A run moves every lambda by the persistent offsets, so the two
   quantities the price needs, P(home runs > away runs) and P(level), are
   tabulated once over a grid of log lambdas (0.01 apart) and read by
   bilinear interpolation. simulator/tests/mlb_model.test.ts bounds the
   interpolation error against model.js game() (below 2e-5).
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256Hex } from '../../core/canonical.ts';
import { REPO, dayOf, type HistGame } from './history.ts';

const require = createRequire(import.meta.url);
export const MODEL_FILES = ['mlb/history/model.js', 'mlb/history/walkforward.js', 'docs/model-loop/mlb/versions.json'];
export function loadRunsModel(): { RunsModel: any; game: (lh: number, la: number, r: number, xi: number, max?: number) => any; nbPmf: (m: number, r: number, max: number) => Float64Array } {
  return require(path.join(REPO, 'mlb', 'history', 'model.js'));
}
export function loadWalkforward(): { calibrationFor: (prior: any[]) => { r: number; xi: number; recal: number[]; n: number; extra_inning_games: number }; CANDS: any } {
  return require(path.join(REPO, 'mlb', 'history', 'walkforward.js'));
}

export interface ServedConfig { version: string; config: Record<string, number>; config_sha256: string; source: string }
export function servedConfig(): ServedConfig {
  const file = path.join(REPO, 'docs', 'model-loop', 'mlb', 'versions.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = d.versions.find((x: any) => x.version === d.current);
  if (!v || !v.config) throw new Error('docs/model-loop/mlb/versions.json has no served version');
  return { version: v.version, config: v.config, config_sha256: v.config_sha256, source: 'docs/model-loop/mlb/versions.json current ' + d.current };
}

export interface ModelState {
  mu: number; home: number;
  teams: Record<string, { o: number; d: number; k: number }>;
  /** the starter effect s of every fitted pitcher (a pitcher absent here is 0: his club's average) */
  pitchers: Record<string, number>;
  season: number;
}
function capture(m: any): ModelState {
  const teams: ModelState['teams'] = {};
  for (const t of new Set<string>([...m.o.keys(), ...m.d.keys(), ...m.k.keys()])) teams[t] = { o: m.g(m.o, t), d: m.g(m.d, t), k: m.g(m.k, t) };
  const pitchers: Record<string, number> = {};
  for (const [id, v] of m.s) if (v !== 0) pitchers[id] = v;
  return { mu: m.mu, home: m.home, teams, pitchers, season: m.season };
}

export interface ReplayOptions {
  params: Record<string, number>;
  /** UTC day numbers at which to capture the state as of that morning: every game of an earlier date absorbed, fitted at that day */
  captureDays?: number[];
  /** stop before this day: games on or after it are not absorbed; the state as of that morning is returned as `final` */
  stopAt?: number;
}
export interface Replay { raw: Map<string, { lh: number; la: number }>; captures: Map<number, ModelState>; final: ModelState | null }

/* a copy of the model to fit at a capture day without disturbing the replay (fit() mutates) */
function fittedCopy(RunsModel: any, m: any, params: Record<string, number>, day: number, season: number | null): ModelState {
  const c = new RunsModel(params, m.use);
  c.mu = m.mu; c.home = m.home; c.season = m.season;
  for (const k of ['o', 'd', 's', 'k']) c[k] = new Map(m[k]);
  c.hist = m.hist.slice();
  if (season != null) c.startSeason(season);
  c.fit(day);
  return capture(c);
}

/** walkforward.js pass(), candidate team_park_sp, with captures */
export function replay(games: HistGame[], opt: ReplayOptions): Replay {
  const { RunsModel } = loadRunsModel();
  const m = new RunsModel(opt.params, { park: true, sp: true });
  const byDay = new Map<string, HistGame[]>();
  for (const g of games) { if (!byDay.has(g.date)) byDay.set(g.date, []); byDay.get(g.date)!.push(g); }
  const raw = new Map<string, { lh: number; la: number }>();
  const captures = new Map<number, ModelState>();
  const pending = [...new Set(opt.captureDays || [])].sort((a, b) => a - b);
  for (const date of [...byDay.keys()].sort()) {
    const day = dayOf(date);
    if (opt.stopAt != null && day >= opt.stopAt) break;
    const list = byDay.get(date)!;
    /* a capture day with no games of its own (off-season, the All-Star break): as of that morning */
    while (pending.length && pending[0] < day) { const c = pending.shift()!; captures.set(c, fittedCopy(RunsModel, m, opt.params, c, null)); }
    m.startSeason(list[0].season); m.fit(day);
    if (pending.length && pending[0] === day) { pending.shift(); captures.set(day, capture(m)); }
    for (const g of list) { const l = m.lambdas(g.home, g.away, g.sp_home || null, g.sp_away || null, g.home); raw.set(g.id, { lh: l.lh, la: l.la }); }
    m.absorb(day, list.map((g) => ({ home: g.home, away: g.away, hs: g.hs, as: g.as, sp_home: g.sp_home, sp_away: g.sp_away })));
  }
  for (const c of pending) if (opt.stopAt == null || c < opt.stopAt) captures.set(c, fittedCopy(RunsModel, m, opt.params, c, null));
  const final = opt.stopAt != null ? fittedCopy(RunsModel, m, opt.params, opt.stopAt, null) : null;
  return { raw, captures, final };
}

export interface Calibration { season: number; r: number; xi: number; recal: [number, number]; n: number; extra_inning_games: number }
/** the served calibration of `season`: walkforward.js calibrationFor on the three earlier seasons' out-of-sample predictions */
export function calibrationFor(season: number, games: HistGame[], raw: Replay['raw']): Calibration {
  const W = loadWalkforward();
  const prior = games.filter((g) => g.season >= season - 3 && g.season < season).map((g) => {
    const x = raw.get(g.id); if (!x) throw new Error('no out-of-sample prediction for ' + g.id);
    return { lh: x.lh, la: x.la, hs: g.hs, as: g.as, outs: g.outs };
  });
  if (prior.length < 1000) throw new Error('too few prior-season predictions to calibrate ' + season + ': ' + prior.length);
  const k = W.calibrationFor(prior);
  return { season, r: k.r, xi: k.xi, recal: [k.recal[0], k.recal[1]], n: k.n, extra_inning_games: k.extra_inning_games };
}

export function lambdas(M: ModelState, home: string, away: string, spHome: number, spAway: number): { lh: number; la: number } {
  const th = M.teams[home] || { o: 0, d: 0, k: 0 }, ta = M.teams[away] || { o: 0, d: 0, k: 0 };
  return { lh: Math.exp(M.mu + M.home + th.o - ta.d - spAway + th.k), la: Math.exp(M.mu + ta.o - th.d - spHome + th.k) };
}
export const starterEffect = (M: ModelState, id: string | null): number => (id && M.pitchers[id] != null ? M.pitchers[id] : 0);

const sig = (z: number) => 1 / (1 + Math.exp(-z));
/** the served home win probability from the raw pieces: recal(P(H>A) + P(level) * xi) */
export function calibratedHome(pWin: number, pLevel: number, xi: number, recal: [number, number]): number {
  const pr = pWin + pLevel * xi;
  return sig(recal[0] + recal[1] * Math.log(pr / (1 - pr)));
}

/** P(home > away) and P(level) for two negative binomials, model.js game()'s own sums (support 0..25, as served) */
export class WinTable {
  readonly r: number; readonly lo: number; readonly step: number; readonly n: number;
  readonly W: Float64Array; readonly L: Float64Array;
  private nb: (m: number, r: number, max: number) => Float64Array;
  constructor(r: number, opt: { lo?: number; hi?: number; step?: number } = {}) {
    this.r = r; this.lo = opt.lo ?? Math.log(0.4); this.step = opt.step ?? 0.01;
    const hi = opt.hi ?? Math.log(16);
    this.n = Math.ceil((hi - this.lo) / this.step) + 1;
    this.nb = loadRunsModel().nbPmf;
    const pm: Float64Array[] = [];
    for (let i = 0; i < this.n; i++) pm.push(this.nb(Math.exp(this.lo + i * this.step), r, 25));
    this.W = new Float64Array(this.n * this.n); this.L = new Float64Array(this.n * this.n);
    for (let i = 0; i < this.n; i++) for (let j = 0; j < this.n; j++) {
      const a = pm[i], b = pm[j]; let w = 0, t = 0;
      for (let x = 0; x <= 25; x++) { const ax = a[x]; let cum = 0; for (let y = 0; y < x; y++) cum += b[y]; w += ax * cum; t += ax * b[x]; }
      this.W[i * this.n + j] = w; this.L[i * this.n + j] = t;
    }
  }
  /** exact, off the grid */
  exact(lh: number, la: number): [number, number] {
    const a = this.nb(lh, this.r, 25), b = this.nb(la, this.r, 25); let w = 0, t = 0;
    for (let x = 0; x <= 25; x++) { let cum = 0; for (let y = 0; y < x; y++) cum += b[y]; w += a[x] * cum; t += a[x] * b[x]; }
    return [w, t];
  }
  /** [P(home > away), P(level)] at lambdas (lh, la) */
  at(lh: number, la: number, out: Float64Array): void {
    const fx = (Math.log(lh) - this.lo) / this.step, fy = (Math.log(la) - this.lo) / this.step;
    if (!(fx >= 0 && fy >= 0 && fx < this.n - 1 && fy < this.n - 1)) { const e = this.exact(lh, la); out[0] = e[0]; out[1] = e[1]; return; }
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, n = this.n, k = i * n + j;
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    out[0] = this.W[k] * w00 + this.W[k + n] * w10 + this.W[k + 1] * w01 + this.W[k + n + 1] * w11;
    out[1] = this.L[k] * w00 + this.L[k + n] * w10 + this.L[k + 1] * w01 + this.L[k + n + 1] * w11;
  }
}

export function modelCodeHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of MODEL_FILES) out[f] = sha256Hex(fs.readFileSync(path.join(REPO, f)));
  return out;
}
