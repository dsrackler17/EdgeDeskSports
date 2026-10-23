/* ===========================================================================
   THE SERVED NBA MODEL, AS THE SIMULATOR READS IT.

   No new game model. Every simulated NBA game is priced by the model the
   walk-forward chose for the PROJECTED track (nba/params/live.json
   chosen.P, today E_ridge_P): the point-in-time pass (nba/model/pass.js)
   builds the game's features — team ratings, four factors, the player-impact
   layer with the projected rotation, rest, back-to-backs, travel, time
   zones, altitude, home court, the postseason flag — the ridge model
   (nba/params/ml_live.json) turns them into a regulation-margin mean, the
   season's calibration (live.json calibration[chosen]) into the
   distribution's parameters, and nba/model/distribution.js marginals() into
   the FINAL margin pmf (overtime included, so a game cannot end tied).

   The pricing path is the slate's own (nba/build_slate.js attachMl +
   paramsOf); availability scenarios are the slate's own featFor (the
   projected set changes, the minutes are redistributed by the player
   model, nothing is a fixed number of points). Nothing of the model is
   copied here: the modules are loaded and called.

   FROZEN PASS. A season simulation prices every remaining game from the
   states as they stand at the as-of time. frozenPass() runs the served pass
   with every game that started at or after `freezeAt` treated as not yet
   played (its result is never absorbed), so a historical as-of replay is
   point-in-time by construction. With freezeAt null it is the served pass.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const NBA_DIR = path.join(REPO, 'nba');

export interface NbaModules { C: any; D: any; PASS: any; WF: any; ML: any; DIST: any; DF: any; L: any }
let MODS: NbaModules | null = null;
export function nbaModules(): NbaModules {
  if (MODS) return MODS;
  MODS = {
    C: require(path.join(NBA_DIR, 'config.js')), D: require(path.join(NBA_DIR, 'lib', 'data.js')), PASS: require(path.join(NBA_DIR, 'model', 'pass.js')),
    WF: require(path.join(NBA_DIR, 'model', 'walkforward.js')), ML: require(path.join(NBA_DIR, 'model', 'ml.js')), DIST: require(path.join(NBA_DIR, 'model', 'distribution.js')),
    DF: require(path.join(NBA_DIR, 'model', 'dist_fit.js')), L: require(path.join(NBA_DIR, 'model', 'learn.js'))
  };
  return MODS;
}

/** the code a priced NBA game depends on: hashed into every snapshot */
export const NBA_CODE_FILES = ['nba/model/pass.js', 'nba/model/ratings.js', 'nba/model/players.js', 'nba/model/ml.js', 'nba/model/learn.js', 'nba/model/walkforward.js',
  'nba/model/distribution.js', 'nba/model/dist_fit.js', 'nba/lib/data.js', 'nba/lib/venues.js', 'nba/config.js', 'nba/params/live.json', 'nba/params/ml_live.json', 'engine/stats.js'];

/** one season's pricing parameters for the chosen projected-track model */
export interface SeasonParams {
  season: number;
  chosen: string;
  /** the ridge margin/total models of the P track (features, raw-scale betas) */
  ml: { features: string[]; ridge_m: number[]; ridge_t: number[]; trained_through: number };
  calibration: any;
  shape: any;
  ot: any;
  source: string;
}

/** the served live parameters (nba/params/live.json + ml_live.json) */
export function liveParams(): SeasonParams {
  const { WF } = nbaModules();
  const live = JSON.parse(fs.readFileSync(WF.LIVE, 'utf8')), ml = JSON.parse(fs.readFileSync(WF.ML_LIVE, 'utf8'));
  const chosen = live.chosen.P as string;
  if (chosen !== 'E_ridge_P') throw new Error('the simulator prices the ridge projected-track model; live.json now chooses ' + chosen + ' — extend model_adapter.ts before simulating');
  const P = ml.models.P;
  if (!live.calibration[chosen]) throw new Error('live.json has no calibration for ' + chosen);
  return { season: live.for_season, chosen, ml: { features: P.features, ridge_m: P.ridge_m, ridge_t: P.ridge_t, trained_through: P.trained_through }, calibration: live.calibration[chosen], shape: live.shape, ot: live.ot,
    source: 'nba/params/live.json (generated ' + live.generated_at + ') + nba/params/ml_live.json (generated ' + ml.generated_at + ')' };
}

/** season S's parameters rebuilt out of sample (the nba/model/live.js recipe with cur = S, ridge learner only:
    the ridge for S is trained on every season before S, the calibration, shape and overtime on S-3..S-1's
    out-of-sample rows). `rows` are the walk-forward pass rows (WF.buildRows). */
export function seasonParams(rows: any[], S: number, tuning: any): SeasonParams {
  const { ML, WF, L } = nbaModules();
  const cal = [S - 3, S - 2, S - 1];
  ML.fitPredict(rows, 'P', Object.assign({}, tuning.ml, { seasons: cal, learners: ['ridge'] }), {});
  const prior = rows.filter((r: any) => r.y && cal.includes(r.season));
  const so = WF.shapeFor(prior);
  const cand = WF.candsFor('P').find((c: any) => c.id === 'E_ridge_P');
  const c = WF.calibrate(cand, prior, so.shape);
  if (!c) throw new Error('season ' + S + ': no calibration');
  const names: string[] = ML.featureNames('P');
  const train = rows.filter((r: any) => r.y && r.season >= ML.FIRST_TRAIN && r.season < S);
  const trM = train.filter((r: any) => r.y.reg_margin != null), trT = train.filter((r: any) => r.y.reg_total != null);
  const X = (rs: any[]) => rs.map((r) => [1].concat(names.map((k) => ML.value(r.f, k))));
  const cfg = Object.assign({}, ML.DEFAULT_CFG, tuning.ml || {});
  const ridge_m = L.ridge(X(trM), trM.map((r: any) => r.y.reg_margin), { l2: cfg.ridge_l2 }).beta;
  const ridge_t = L.ridge(X(trT), trT.map((r: any) => r.y.reg_total), { l2: cfg.ridge_l2 }).beta;
  return { season: S, chosen: 'E_ridge_P', ml: { features: names, ridge_m, ridge_t, trained_through: S - 1 }, calibration: c, shape: so.shape, ot: so.ot, source: 'rebuilt out of sample for season ' + S + ' (simulator/src/sports/nba/model_adapter.ts seasonParams)' };
}

/** the chosen model's distribution parameters for one pass row, optionally with feature overrides */
export function priceRow(sp: SeasonParams, row: any, mod?: Record<string, number>): any | null {
  const { WF, ML, L } = nbaModules();
  const f = Object.assign({}, row.f, mod || {});
  const x = [1].concat(sp.ml.features.map((k) => ML.value(f, k)));
  f.mlP_ridge_m = L.predictLinear(sp.ml.ridge_m, x);
  f.mlP_ridge_t = L.predictLinear(sp.ml.ridge_t, x);
  const cand = WF.candsFor('P').find((c: any) => c.id === sp.chosen);
  return WF.paramsFor(cand, sp.calibration, sp.shape, sp.ot, Object.assign({}, row, { f }));
}

/** the served pass, with games that started at or after freezeAt treated as unplayed */
export async function frozenPass(o: { tuning: any; freezeAt: number | null; upTo: number; now?: number; log?: boolean; extraGames?: any[]; extraTeamGames?: any[] }): Promise<any> {
  const { D, PASS } = nbaModules();
  const origGames = D.games, origTg = D.teamGames;
  D.games = (seasons: number[]) => {
    const out = origGames(seasons).map((g: any) => (o.freezeAt != null && g.status === 'FINAL' && g.start_ms >= o.freezeAt) ? Object.assign({}, g, { status: 'SCHEDULED' }) : g);
    if (o.extraGames && o.extraGames.length) { for (const g of o.extraGames) out.push(g); out.sort((a: any, b: any) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : 1)); }
    return out;
  };
  D.teamGames = (seasons: number[]) => { const out = origTg(seasons); if (o.extraTeamGames) for (const r of o.extraTeamGames) out.push(r); return out; };
  try { return await PASS.run(o.tuning.pass, { includeScheduled: true, upTo: o.upTo, now: o.now, log: o.log }); }
  finally { D.games = origGames; D.teamGames = origTg; }
}

/** the FINAL home-margin pmf of a game (overtime resolved; no mass at 0) as a cdf over [lo, lo + n) */
export interface MarginTable { lo: number; cdf: Float64Array; pHome: number }
export function marginTable(p: any): MarginTable {
  const { DIST } = nbaModules();
  const mg = DIST.marginals(p);
  const pmf: Float64Array = mg.margin.pmf; const lo: number = mg.margin.lo;
  const cdf = new Float64Array(pmf.length); let acc = 0;
  for (let i = 0; i < pmf.length; i++) { acc += pmf[i]; cdf[i] = acc; }
  for (let i = 0; i < cdf.length; i++) cdf[i] /= acc;
  cdf[cdf.length - 1] = 1;
  if (pmf[-lo] > 1e-12) throw new Error('the served final-margin distribution carries mass at 0 (' + pmf[-lo] + ')');
  return { lo, cdf, pHome: mg.p_home / acc };
}
