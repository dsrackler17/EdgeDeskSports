/* ===========================================================================
   WHEN COLLEGE BASEBALL MAY BE PUBLISHED — the activation conditions,
   evaluated on the committed backtests. Written after the first backtests
   were run (2026-10-24), so they are a floor the evidence must keep
   clearing on every refresh, not a preregistration:

   1. both backtests exist, with their schemas;
   2. the tournament (simulator/data/college_baseball_backtest.json, every
      tournament 2014-2026 the warehouse holds whole, from its first pitch):
      - each regional's winner: the log loss is lower than every team equal
        AND than the seed lines' past rates, each with the pod-bootstrap 95%
        interval of the difference entirely below zero;
      - reaching Omaha: the log loss is lower than 8 in 64 with the season-
        bootstrap interval entirely below zero;
      - the single tournament games: lower log loss than a coin, interval
        entirely below zero;
   3. the season (simulator/data/college_baseball_road.json, walk-forward
      from 2016): from the PRESEASON, making the field and reaching Omaha
      each beat both the base rate and last season's stage, with the season-
      bootstrap interval of each difference entirely below zero.
   The title itself is not a condition: eleven tournaments cannot show it
   (the Model Health tab gives the record either way).
   registry.ts shows college baseball ACTIVE only when every condition
   holds; otherwise BLOCKED, with each failed condition as a blocker.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* the repository root, here and not from model.ts: the registry reads this file, and model.ts loads the engine */
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const BACKTEST_SCHEMA = 'edgedesk_sim_cbase_backtest_v1';
export const ROAD_SCHEMA = 'edgedesk_sim_cbase_road_v1';
export const BACKTEST_FILE = path.join(REPO, 'simulator', 'data', 'college_baseball_backtest.json');
export const ROAD_FILE = path.join(REPO, 'simulator', 'data', 'college_baseball_road.json');

const below = (x: any) => !!(x && x.ci95 && x.ci95[1] < 0);
const show = (x: any) => (x && x.ci95 ? x.mean + ' (' + x.ci95.join(' to ') + ')' : 'missing');

export function cbaseActivation(bt: any = readOrNull(BACKTEST_FILE), road: any = readOrNull(ROAD_FILE)): { status: 'ACTIVE' | 'BLOCKED'; blockers: string[] } {
  const blockers: string[] = [];
  if (!bt || bt.schema !== BACKTEST_SCHEMA) blockers.push('No committed tournament backtest (simulator/data/college_baseball_backtest.json; simulator/src/research/college_baseball_tournament_backtest.ts).');
  if (!road || road.schema !== ROAD_SCHEMA) blockers.push('No committed season backtest (simulator/data/college_baseball_road.json; simulator/src/research/college_baseball_road_backtest.ts).');
  if (blockers.length) return { status: 'BLOCKED', blockers };
  const rg = bt.regional_winner_log_loss || {};
  if (!below(rg.diff_vs_uniform)) blockers.push('Regional winners: the log loss does not beat every team equal with its interval below zero (' + show(rg.diff_vs_uniform) + ').');
  if (!below(rg.diff_vs_seed_lines)) blockers.push('Regional winners: the log loss does not beat the seed lines with its interval below zero (' + show(rg.diff_vs_seed_lines) + ').');
  if (!below(bt.omaha && bt.omaha.log_loss_diff_vs_uniform)) blockers.push('Reaching Omaha: the log loss does not beat 8 in 64 with its interval below zero (' + show(bt.omaha && bt.omaha.log_loss_diff_vs_uniform) + ').');
  if (!below(bt.games && bt.games.vs_coin)) blockers.push('Tournament games: the log loss does not beat a coin with its interval below zero (' + show(bt.games && bt.games.vs_coin) + ').');
  const pre = road.summary && road.summary.preseason && road.summary.preseason.levels;
  for (const l of ['field', 'omaha']) {
    const x = pre && pre[l];
    if (!below(x && x.diff_vs_base_rate)) blockers.push('From the preseason, ' + (l === 'field' ? 'making the field' : 'reaching Omaha') + ' does not beat the base rate with its interval below zero (' + show(x && x.diff_vs_base_rate) + ').');
    if (!below(x && x.diff_vs_last_season)) blockers.push('From the preseason, ' + (l === 'field' ? 'making the field' : 'reaching Omaha') + ' does not beat last season\'s stage with its interval below zero (' + show(x && x.diff_vs_last_season) + ').');
  }
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}
export function readOrNull(f: string): any | null { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; } }
