/* ===========================================================================
   WHEN GOLF MAY BE PUBLISHED — the activation conditions, written before
   the backtest was run and evaluated on its committed result
   (simulator/data/golf_backtest.json, simulator/src/research/
   golf_backtest.ts), for EACH tour, on the HOLDOUT seasons (2025-2026):

   1. the skill study (golf_skill_study.json) and the backtest exist, with
      their schemas, for the PGA Tour, the LPGA and the DP World Tour;
   2. before the first round, the model's log loss for win, top 10, top 20
      and make the cut is lower than the field-size baseline's, with the
      event-bootstrap 95% interval of the difference entirely below zero;
   3. after round 2, the model's log loss for win and top 10 is lower than
      the "scores only" baseline's (the same simulation with every player
      equally skilled: what the leaderboard alone says);
   4. the per-tournament uncertainty does not make the forecast worse: for
      win, top 10 and top 20 before the first round, the interval of the
      difference against the same model without it (skill as a point) does
      not lie entirely above zero.
   registry.ts shows golf ACTIVE only when every condition holds for every
   tour; otherwise BLOCKED, with each failed condition as a blocker.
   =========================================================================== */
import fs from 'node:fs';
import { STUDY_FILE, BACKTEST_FILE, TOURS, TOUR_LABEL } from './model.ts';

export const BACKTEST_SCHEMA = 'edgedesk_sim_golf_backtest_v1';
export const STUDY_SCHEMA = 'edgedesk_sim_golf_skill_study_v1';

export function golfActivation(study: any = readOrNull(STUDY_FILE), backtest: any = readOrNull(BACKTEST_FILE)): { status: 'ACTIVE' | 'BLOCKED'; blockers: string[] } {
  const blockers: string[] = [];
  if (!study || study.schema !== STUDY_SCHEMA) blockers.push('No committed golf skill study (simulator/data/golf_skill_study.json; simulator/src/research/golf_skill_study.ts).');
  if (!backtest || backtest.schema !== BACKTEST_SCHEMA) blockers.push('No committed golf backtest (simulator/data/golf_backtest.json; simulator/src/research/golf_backtest.ts).');
  if (blockers.length) return { status: 'BLOCKED', blockers };
  for (const t of TOURS) {
    const L = TOUR_LABEL[t];
    if (!study.tours || !study.tours[t]) { blockers.push(L + ': the skill study has no entry.'); continue; }
    const h = backtest.tours && backtest.tours[t] && backtest.tours[t].holdout;
    if (!h || !h.pre || !h.r2) { blockers.push(L + ': the backtest has no holdout result.'); continue; }
    for (const k of ['win', 'top_10', 'top_20', 'make_cut']) {
      const m = h.pre.metrics[k];
      if (!m || !m.diff_vs_uniform || !(m.diff_vs_uniform.ci95[1] < 0)) blockers.push(L + ': before round 1, the ' + k.replace('_', ' ') + ' log loss does not beat the field-size baseline on the 2025-2026 holdout (difference ' + (m && m.diff_vs_uniform ? m.diff_vs_uniform.log_loss + ', 95% interval ' + m.diff_vs_uniform.ci95.join(' to ') : 'missing') + ').');
    }
    for (const k of ['win', 'top_10']) {
      const m = h.r2.metrics[k];
      if (!m || !m.diff_vs_scores_only || !(m.diff_vs_scores_only.log_loss < 0)) blockers.push(L + ': after round 2, the ' + k.replace('_', ' ') + ' log loss does not beat the scores-only baseline on the holdout (difference ' + (m && m.diff_vs_scores_only ? m.diff_vs_scores_only.log_loss : 'missing') + ').');
    }
    for (const k of ['win', 'top_10', 'top_20']) {
      const m = h.pre.metrics[k];
      if (!m || !m.diff_vs_point || m.diff_vs_point.ci95[0] > 0) blockers.push(L + ': the per-tournament uncertainty makes the ' + k.replace('_', ' ') + ' forecast worse than skill as a point on the holdout (difference ' + (m && m.diff_vs_point ? m.diff_vs_point.log_loss + ', 95% interval ' + m.diff_vs_point.ci95.join(' to ') : 'missing') + ').');
    }
  }
  return { status: blockers.length ? 'BLOCKED' : 'ACTIVE', blockers };
}
function readOrNull(f: string): any | null { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (_) { return null; } }
