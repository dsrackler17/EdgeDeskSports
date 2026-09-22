/* ============================================================================
   EdgeDesk NFL — Coaching / Staff frozen walk-forward report.

   REPORT ONLY. It does not select a cap and cannot move an NFL projection.

   Every evaluated game must have:
     - a frozen pregame model margin
     - a frozen coaching research snapshot
     - both home/away cap-independent coaching factors
     - capture + research timestamps strictly before kickoff
     - a settled final margin

   Hypothetical candidate:
     baseline_home_margin + cap * (home_factor - away_factor)

   The cap grid is descriptive research. Choosing a cap on the same rows used to
   report its performance would be optimization on the holdout, so this module
   deliberately reports every cap and selects none.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_nfl_coaching_staff_validation_v1';
const SNAPSHOT_SCHEMA = 'edgedesk_nfl_coaching_staff_pregame_research_v1';
const DEFAULT_CAPS = Object.freeze([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]);

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function r4(x) {
  return isNum(x) ? Math.round(x * 10000) / 10000 : null;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function rmse(xs) {
  return xs.length ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : null;
}

function twoSidedPFromT(t) {
  const x = Math.abs(t) / Math.SQRT2;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const tt = 1 / (1 + p * x);
  const erf = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
  return 1 - erf;
}

function pairedAbsoluteErrorTest(baseErrors, candidateErrors) {
  const n = Math.min(baseErrors.length, candidateErrors.length);
  if (n < 30) return { n, p: null, reason: 'fewer than thirty paired frozen games' };
  const d = [];
  for (let i = 0; i < n; i++) d.push(baseErrors[i] - candidateErrors[i]);
  const m = mean(d);
  let ss = 0;
  for (const x of d) ss += (x - m) * (x - m);
  const sd = Math.sqrt(ss / (n - 1));
  if (!(sd > 0)) return { n, mean_improvement: r4(m), p: null, reason: 'zero paired-error variance' };
  const t = m / (sd / Math.sqrt(n));
  return { n, mean_improvement: r4(m), t: r4(t), p: r4(twoSidedPFromT(t)) };
}

function frozenRows(ledger) {
  const rows = [];
  const excluded = {
    no_research_snapshot: 0,
    missing_factor: 0,
    missing_margin: 0,
    timestamp_not_verifiably_pregame: 0
  };

  if (!ledger || !ledger.settled) return { rows, excluded, error: 'invalid or empty settled ledger' };

  Object.keys(ledger.settled).sort().forEach((id) => {
    const rec = ledger.settled[id];
    if (!rec) return;
    const research = rec.coaching_research;
    if (!research || research.schema !== SNAPSHOT_SCHEMA ||
        research.projection_influence !== false || research.applied_points !== 0) {
      excluded.no_research_snapshot++;
      return;
    }
    const hf = research.home && research.home.factor;
    const af = research.away && research.away.factor;
    if (!isNum(hf) || !isNum(af)) {
      excluded.missing_factor++;
      return;
    }
    if (!isNum(rec.pregame_home_margin) || !isNum(rec.actual_home_margin)) {
      excluded.missing_margin++;
      return;
    }

    const captured = Date.parse(rec.captured_at || '');
    const researchAt = Date.parse(research.frozen_at || '');
    const kickoff = Date.parse(rec.kickoff || '');
    if (!Number.isFinite(captured) || !Number.isFinite(researchAt) || !Number.isFinite(kickoff) ||
        !(captured < kickoff) || !(researchAt < kickoff)) {
      excluded.timestamp_not_verifiably_pregame++;
      return;
    }

    rows.push({
      game_id: String(rec.game_id || id),
      season: Number.isFinite(Number(rec.season)) ? Number(rec.season) : null,
      baseline_home_margin: rec.pregame_home_margin,
      actual_home_margin: rec.actual_home_margin,
      home_factor: hf,
      away_factor: af,
      factor_delta: hf - af
    });
  });

  return { rows, excluded };
}

function arm(rows, cap) {
  const abs = [], sq = [], signed = [];
  const bySeason = {};

  rows.forEach((r) => {
    const predicted = r.baseline_home_margin + cap * r.factor_delta;
    const err = r.actual_home_margin - predicted;
    const ae = Math.abs(err);
    abs.push(ae);
    sq.push(err);
    signed.push(err);
    const key = r.season == null ? 'unknown' : String(r.season);
    (bySeason[key] = bySeason[key] || []).push(err);
  });

  const perSeason = Object.keys(bySeason).sort().map((season) => {
    const errs = bySeason[season];
    return {
      season: season === 'unknown' ? null : Number(season),
      n: errs.length,
      mae: r4(mean(errs.map(Math.abs))),
      rmse: r4(rmse(errs)),
      bias: r4(mean(errs))
    };
  });

  return {
    cap,
    n: rows.length,
    mae: r4(mean(abs)),
    rmse: r4(rmse(sq)),
    bias: r4(mean(signed)),
    per_season: perSeason,
    _abs_errors: abs
  };
}

function analyze(ledger, opts) {
  opts = opts || {};
  const caps = Array.isArray(opts.caps) && opts.caps.length
    ? opts.caps.map(Number).filter(Number.isFinite)
    : DEFAULT_CAPS.slice();
  const uniqueCaps = Array.from(new Set(caps.concat([0]))).sort((a, b) => a - b);
  const frozen = frozenRows(ledger);
  const rows = frozen.rows;
  const baseline = arm(rows, 0);

  const arms = uniqueCaps.map((cap) => {
    const a = arm(rows, cap);
    a.mae_improvement_vs_baseline = isNum(baseline.mae) && isNum(a.mae)
      ? r4(baseline.mae - a.mae) : null;
    a.rmse_delta_vs_baseline = isNum(baseline.rmse) && isNum(a.rmse)
      ? r4(a.rmse - baseline.rmse) : null;
    a.paired = cap === 0
      ? { n: rows.length, p: null, reason: 'baseline arm' }
      : pairedAbsoluteErrorTest(baseline._abs_errors, a._abs_errors);
    delete a._abs_errors;
    return a;
  });
  delete baseline._abs_errors;

  const seasons = Array.from(new Set(rows.map((r) => r.season).filter(Number.isFinite))).sort((a, b) => a - b);
  const blockers = [];
  if (rows.length < 30) blockers.push('fewer than thirty paired frozen games');
  if (seasons.length < 2) blockers.push('fewer than two frozen holdout seasons');
  blockers.push('probability calibration/Brier impact is not yet measured for hypothetical coaching caps');
  blockers.push('no tune/holdout cap selection has been run; this report deliberately selects no cap');

  return {
    schema: SCHEMA,
    generated_at: opts.now || null,
    status: 'RESEARCH_ONLY',
    may_move_lines: false,
    selected_cap: null,
    statement: 'Frozen NFL Coaching / Staff factors are being measured out of sample. This report selects no cap and changes no projection.',
    caps_tested: uniqueCaps,
    games_scored: rows.length,
    seasons_scored: seasons,
    excluded: frozen.excluded,
    leakage_clean_rows_only: true,
    baseline,
    arms,
    promotion_blockers: blockers
  };
}

module.exports = {
  SCHEMA,
  SNAPSHOT_SCHEMA,
  DEFAULT_CAPS,
  frozenRows,
  pairedAbsoluteErrorTest,
  analyze
};
