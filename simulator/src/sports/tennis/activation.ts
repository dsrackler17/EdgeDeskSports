/* ===========================================================================
   WHEN TENNIS MAY BE PUBLISHED — the activation conditions, evaluated on
   the committed study (simulator/data/tennis_elo_study.json) and backtest
   (simulator/data/tennis_backtest.json), for EACH tour, on the HOLDOUT
   (2025 to the feed's last match). Written after the first study and
   backtest were run (2026-10-23), so they are a floor the evidence must
   keep clearing on every refresh, not a preregistration:

   1. the study and the backtest exist, with their schemas;
   2. match prices: the holdout log loss is lower than a coin's and lower
      than FiveThirtyEight's published parameters', each with the
      tournament-bootstrap 95% interval of the difference entirely below
      zero (the chosen parameters must earn their place);
   3. calibration: the expected calibration error over bins of 30 or more
      matches is at most 0.03;
   4. draws: the champion's log loss before the first round is lower than
      the field-size baseline's (every entrant equally likely), with the
      draw-bootstrap 95% interval entirely below zero.
   registry.ts shows tennis ACTIVE only when every condition holds for both
   tours; otherwise BLOCKED, with each failed condition as a blocker.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { STUDY_FILE, REPO, TOURS, TOUR_LABEL } from './elo.ts';

export const STUDY_SCHEMA = 'edgedesk_sim_tennis_elo_study_v1';
export const BACKTEST_SCHEMA = 'edgedesk_sim_tennis_backtest_v1';
export const BACKTEST_FILE = path.join(REPO, 'simulator', 'data', 'tennis_backtest.json');

export function tennisActivation(study: any = readOrNull(STUDY_FILE), backtest: any = readOrNull(BACKTEST_FILE)): { status: 'ACTIVE' | 'BLOCKED'; blockers: string[] } {
  const blockers: string[] = [];
  if (!study || study.schema !== STUDY_SCHEMA) blockers.push('No committed tennis Elo study (simulator/data/tennis_elo_study.json; simulator/src/research/tennis_elo_study.ts).');
  if (!backtest || backtest.schema !== BACKTEST_SCHEMA) blockers.push('No committed tennis backtest (simulator/data/tennis_backtest.json; simulator/src/research/tennis_tournament_backtest.ts).');
  if (blockers.length) return { status: 'BLOCKED', blockers };
  for (const t of TOURS) {
    const L = TOUR_LABEL[t], h = study.holdout && study.holdout[t];
    if (!h) { blockers.push(L + ': the study has no holdout result.'); continue; }
    if (!(h.vs_coin && h.vs_coin.ci95[1] < 0)) blockers.push(L + ': the holdout match log loss does not beat a coin with its interval below zero (' + (h.vs_coin ? h.vs_coin.log_loss + ', ' + h.vs_coin.ci95.join(' to ') : 'missing') + ').');
    if (!(h.vs_538 && h.vs_538.ci95[1] < 0)) blockers.push(L + ': the holdout match log loss does not beat FiveThirtyEight\'s parameters with its interval below zero (' + (h.vs_538 ? h.vs_538.log_loss + ', ' + h.vs_538.ci95.join(' to ') : 'missing') + ').');
    const b = backtest.tours && backtest.tours[t] && backtest.tours[t].champion_log_loss;
    if (!b || !(b.diff_vs_field_size.ci95[1] < 0)) blockers.push(L + ': the champion\'s log loss does not beat the field-size baseline on the holdout draws with its interval below zero (' + (b ? b.diff_vs_field_size.mean + ', ' + b.diff_vs_field_size.ci95.join(' to ') : 'missing') + ').');
  }
  if (!(study.ece_bins_30 <= 0.03)) blockers.push('The holdout calibration error is ' + study.ece_bins_30 + ' (at most 0.03).');
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}
function readOrNull(f: string): any | null { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; } }
