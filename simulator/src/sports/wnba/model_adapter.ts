/* ===========================================================================
   THE SERVED WNBA MODEL, AS THE SIMULATOR READS IT.

   No new game model. Every simulated WNBA game is priced by the model the
   basketball walk-forward serves (basketball/walkforward.js, league wnba):
   points ratings (basketball/model.js PointsRatings, the served
   hyperparameters from docs/model-loop/wnba/versions.json), and the season's
   calibration fitted on the three seasons before it (walkforward.js
   calibrate): P(home win) = logistic(a·home + b·m), where m is the ratings'
   margin. That is exactly how basketball/build_slate.js prices the board
   (basketball/slate.json) from basketball/params/wnba_live.json.

   replay() runs the served chronological pass over every committed season
   (walkforward.js pass: a game is absorbed only once its result is assumed
   available, start + 4 h), so each playoff game's pre-game probability is
   point-in-time, and the ratings after the last final are the ones the next
   game is priced from. Nothing of the model is copied here: the modules are
   loaded and called.
   =========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../core/canonical.ts';

const require = createRequire(import.meta.url);
export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const BB = path.join(REPO, 'basketball');

export interface BbModules { C: any; I: any; WF: any }
let MODS: BbModules | null = null;
export function bbModules(): BbModules {
  if (MODS) return MODS;
  MODS = { C: require(path.join(BB, 'config.js')), I: require(path.join(BB, 'ingest.js')), WF: require(path.join(BB, 'walkforward.js')) };
  return MODS;
}

/** the code and parameters a priced WNBA game depends on: hashed into every snapshot */
export const WNBA_CODE_FILES = ['basketball/model.js', 'basketball/walkforward.js', 'basketball/build_slate.js', 'basketball/config.js', 'basketball/ingest.js',
  'basketball/params/wnba_tuning.json', 'docs/model-loop/wnba/versions.json', 'engine/stats.js'];
export function codeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of WNBA_CODE_FILES) { const p = path.join(REPO, f); out[f] = fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : 'missing'; }
  return out;
}

export interface GameRow {
  game_id: string; season: number; type: 'R' | 'P'; date: string; start_utc: string; neutral: number;
  home_id: string; away_id: string; hs: number | null; as: number | null; ot: number | null; status: 'FINAL' | 'SCHEDULED';
}
/** one served pre-game forecast: the ratings' margin m, the calibrated P(home) and margin mean */
export interface Forecast { id: string; season: number; type: 'R' | 'P'; date: string; start: number; neutral: number; home: string; away: string; m: number; p_home: number; margin_mu: number; margin_sd: number; y: { hw: number; margin: number } }
export interface Calibration { version: string; intercept: string; win: number[]; margin: { a: number; b: number }; sd_margin: number; n: number }
export interface Replay {
  games: GameRow[];
  forecasts: Forecast[];
  /** calibration by season (fitted on the three seasons before it) */
  cal: Record<number, Calibration | null>;
  /** the ratings after every final the data holds (pass end state), for pricing games not yet played */
  ratings: { mu: number; h: number; season: number; teams: Record<string, { o: number; d: number; games: number }> };
  params: Record<string, unknown>;
  model: string;
}

export function loadGames(seasons: number[]): GameRow[] {
  const { I } = bbModules();
  return (I.loadGames('wnba', seasons) as GameRow[]).slice().sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
}

/** the served pass over every season from the league's first through `last` */
export function replay(last: number): Replay {
  const { C, WF } = bbModules();
  const seasons: number[] = [];
  for (let s = C.LEAGUES.wnba.first; s <= last; s++) seasons.push(s);
  const games = loadGames(seasons);
  const finals = games.filter((g) => g.status === 'FINAL');
  const tuning = JSON.parse(fs.readFileSync(path.join(BB, 'params', 'wnba_tuning.json'), 'utf8'));
  const params = WF.servedParams('wnba');
  const { rows, ratings } = WF.pass(finals, params, tuning.elo);
  const { scored, cal } = WF.score(rows);
  const forecasts: Forecast[] = scored.map((r: any) => ({
    id: String(r.id), season: r.season, type: r.type, date: r.date, start: r.start, neutral: r.neutral, home: String(r.home), away: String(r.away), m: r.m,
    p_home: r.p.points, margin_mu: r.p.margin.mu, margin_sd: r.p.margin.sd, y: { hw: r.y.hw, margin: r.y.margin }
  }));
  /* the season in progress is priced with the calibration fitted on the three seasons before it (walkforward.js main) */
  if (!cal[last]) cal[last] = WF.calibrate(rows.filter((r: any) => r.season >= last - 3 && r.season < last));
  return { games, forecasts, cal, ratings: ratings.dump(), params, model: 'points' };
}

/** the served moneyline for a game not yet played, from the replay's end state (basketball/build_slate.js priceGame, model 'points') */
export function priceFromRatings(R: Replay['ratings'], cal: Calibration, home: string, away: string, neutral: boolean): { m: number; p_home: number; margin_mu: number } {
  const T = (id: string) => R.teams[id] || { o: 0, d: 0, games: 0 };
  const H = T(home), A = T(away), hh = neutral ? 0 : R.h / 2;
  const ph = R.mu + hh + H.o - A.d, pa = R.mu - hh + A.o - H.d, m = ph - pa;
  const on = cal.intercept === 'home_games_only' ? (neutral ? 0 : 1) : 1;
  const p = 1 / (1 + Math.exp(-(cal.win[0] * on + cal.win[1] * m)));
  return { m, p_home: p, margin_mu: cal.margin.a * on + cal.margin.b * m };
}
