/* ============================================================================
   CFB production — numeric safety (docs/cfb-production/CANONICAL.md §5).

   Checks, never computations: every function here reads a number the one
   engine produced and says whether it is possible and self-consistent. None
   of them rounds, clamps or replaces a number; a projection that fails is
   refused (UNAVAILABLE), never repaired.

     sanity(p)              broad bounds (brief §64). Deliberately wide: the
                            largest legitimate spread in 2006-2025 is 67.5, so
                            |margin| <= 80; a total of 10-160; team points
                            0-150; sigma 3-40; probabilities strictly in (0, 1)
                            (exactly 0 or 1 only past a 40-point margin, where
                            the engine's 1e-4 rounding reaches it: a note).
     consistency(p, opts)   brief §65: home + away win probability = 1; the
                            fair home line = -margin; score difference =
                            margin; interval ordering (low < mean < high, 50%
                            inside 80% inside 95%); the win probability on the
                            margin's side; the ensemble = the weighted
                            components; a cover probability that matches the
                            engine's own distribution at the offered line.
     policyConsistency(d)   a BET only while betting is enabled; a BET only
                            with a side, a line and a price.
     displayRound(x, k)     the ONLY rounding the production pathway adds, and
                            only for display (brief §69).
     utc(ts)                an ISO-8601 instant with an explicit UTC offset, or
                            null: a naive local time is refused (brief §70).
     hoursBetween(a, b)     UTC millisecond arithmetic; DST cannot move it.
     requireAsOf(opts)      point-in-time code takes an explicit as_of_ts; a
                            missing one is an error, never now() (brief §71).

   TOLERANCES. The engine (football/cfb_v2/engine.js, pinned) rounds the
   margin and the fair line to 0.01 separately and probabilities to 1e-4, so
   the checks allow exactly that: 0.015 on fair + margin, 2e-4 on p + (1 - p),
   0.02 on score difference (points are rounded to 0.01 each).
   ========================================================================== */
'use strict';

const BOUNDS = {
  margin_abs_max: 80,
  total: [10, 160],
  team_points: [0, 150],
  sigma: [3, 40],
  interval_abs_max: 160,
};
const TOL = { fair_line: 0.015, prob_sum: 2e-4, score_diff: 0.02, interval: 1e-9, ensemble: 0.006, cover: 2e-3 };
const VERSION = 'cfb_numeric_safety_v1';
const CERTAIN_MARGIN = 40;       // beyond this a 1e-4-rounded probability may legitimately read 0 or 1

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function inOpen01(p) { return isNum(p) && p > 0 && p < 1; }

/* the ISO instant, or null for anything without an explicit offset */
function utc(ts) {
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.toISOString() : null;
  if (typeof ts !== 'string') return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(ts)) return null;
  const v = Date.parse(ts);
  return Number.isFinite(v) ? new Date(v).toISOString() : null;
}
function hoursBetween(a, b) {
  const x = utc(a), y = utc(b);
  if (!x || !y) return null;
  return (Date.parse(y) - Date.parse(x)) / 3600000;
}
function requireAsOf(opts) {
  const t = opts && utc(opts.as_of_ts);
  if (!t) throw new Error('as_of_ts is required (an ISO-8601 UTC instant): point-in-time code never reads the clock');
  return t;
}
function displayRound(x, k) {
  if (!isNum(x)) return null;
  const m = Math.pow(10, k == null ? 1 : k);
  return Math.round(x * m) / m;
}

/* p: the engine's pure projection (engine.pure()) */
function sanity(p) {
  const out = [];
  if (!p) return ['no projection'];
  const m = p.projected_margin;
  if (!isNum(m)) out.push('MARGIN_NOT_FINITE');
  else if (Math.abs(m) > BOUNDS.margin_abs_max) out.push('MARGIN_OUT_OF_BOUNDS: ' + m);
  /* the engine rounds probabilities to 1e-4, so a legitimate projection of 40+
     points can read exactly 1 / 0: a rounding note (roundingNotes), not a refusal */
  const extreme = isNum(m) && Math.abs(m) >= CERTAIN_MARGIN;
  if (!inOpen01(p.home_win_prob) && !(extreme && (p.home_win_prob === 0 || p.home_win_prob === 1))) out.push('HOME_WIN_PROB_OUT_OF_BOUNDS: ' + p.home_win_prob);
  if (!inOpen01(p.away_win_prob) && !(extreme && (p.away_win_prob === 0 || p.away_win_prob === 1))) out.push('AWAY_WIN_PROB_OUT_OF_BOUNDS: ' + p.away_win_prob);
  if (!isNum(p.sigma) || p.sigma < BOUNDS.sigma[0] || p.sigma > BOUNDS.sigma[1]) out.push('SIGMA_OUT_OF_BOUNDS: ' + p.sigma);
  if (p.fair_total != null && (!isNum(p.fair_total) || p.fair_total < BOUNDS.total[0] || p.fair_total > BOUNDS.total[1])) out.push('TOTAL_OUT_OF_BOUNDS: ' + p.fair_total);
  const iv = p.intervals || {};
  ['p50', 'p80', 'p95'].forEach((k) => {
    const x = iv[k];
    if (!Array.isArray(x) || x.length !== 2 || !isNum(x[0]) || !isNum(x[1])) out.push('INTERVAL_MISSING_' + k);
    else if (Math.abs(x[0]) > BOUNDS.interval_abs_max || Math.abs(x[1]) > BOUNDS.interval_abs_max) out.push('INTERVAL_OUT_OF_BOUNDS_' + k);
  });
  if (isNum(p.football_prediction_confidence) && (p.football_prediction_confidence < 0 || p.football_prediction_confidence > 100)) out.push('CONFIDENCE_OUT_OF_BOUNDS');
  return out;
}

/* notes that are not problems: what a reader must not be shown as precise */
function roundingNotes(p) {
  const out = [];
  if (p && (p.home_win_prob === 0 || p.home_win_prob === 1)) out.push('PROBABILITY_ROUNDED_TO_CERTAINTY: the engine rounds to 1e-4; display as >99%');
  return out;
}

/* opts.engine: the engine instance (for its own t CDF, a check only);
   opts.stack_weights: {C_ridge: 0.5, D_gbm: 0.5}; opts.row: the frozen row */
function consistency(p, opts) {
  opts = opts || {};
  const out = [];
  if (!p) return ['no projection'];
  const m = p.projected_margin;
  if (isNum(p.home_win_prob) && isNum(p.away_win_prob) && Math.abs(p.home_win_prob + p.away_win_prob - 1) > TOL.prob_sum) out.push('WIN_PROBS_DO_NOT_SUM_TO_1');
  if (isNum(m) && isNum(p.fair_spread_home_line) && Math.abs(p.fair_spread_home_line + m) > TOL.fair_line) out.push('FAIR_LINE_NOT_NEGATED_MARGIN');
  /* score difference = margin (when the projection carries team points) */
  if (isNum(p.projected_home_points) && isNum(p.projected_away_points) && isNum(m)
    && Math.abs((p.projected_home_points - p.projected_away_points) - m) > TOL.score_diff) out.push('SCORE_DIFF_NOT_MARGIN');
  /* interval ordering and nesting around the mean */
  const iv = p.intervals || {};
  const ok = (k) => Array.isArray(iv[k]) && isNum(iv[k][0]) && isNum(iv[k][1]);
  ['p50', 'p80', 'p95'].forEach((k) => {
    if (ok(k) && isNum(m) && !(iv[k][0] < m + 0.05 && m - 0.05 < iv[k][1] && iv[k][0] < iv[k][1])) out.push('INTERVAL_ORDER_' + k);
  });
  if (ok('p50') && ok('p80') && ok('p95') && !(iv.p95[0] <= iv.p80[0] + TOL.interval && iv.p80[0] <= iv.p50[0] + TOL.interval
    && iv.p50[1] <= iv.p80[1] + TOL.interval && iv.p80[1] <= iv.p95[1] + TOL.interval)) out.push('INTERVALS_NOT_NESTED');
  /* the win probability sits on the margin's side (raw: exactly; the
     calibrated number is a monotone map of it) */
  const pr = isNum(p.home_win_prob_raw) ? p.home_win_prob_raw : p.home_win_prob;
  if (isNum(m) && isNum(pr) && Math.abs(m) >= 0.5 && (m > 0) !== (pr > 0.5)) out.push('WIN_PROB_SIDE_DISAGREES_WITH_MARGIN');
  /* the ensemble is the weighted components (the frozen row, 3-decimal rounding) */
  const row = opts.row, W = opts.stack_weights;
  if (row && W && row.components && isNum(row.ens_pred)) {
    let s = 0, wsum = 0, all = true;
    Object.keys(W).forEach((k) => { if (isNum(row.components[k])) { s += W[k] * row.components[k]; wsum += W[k]; } else all = false; });
    if (all && Math.abs(wsum - 1) < 1e-9 && Math.abs(s - row.ens_pred) > TOL.ensemble) out.push('ENSEMBLE_NOT_WEIGHTED_COMPONENTS: ' + s.toFixed(4) + ' vs ' + row.ens_pred);
  }
  return out;
}

/* A decision's cover probability must come from the engine's own
   distribution at the line it names (the raw number, before the cover
   calibration): P(home covers) = 1 - T((line_margin - mu) / sigma). */
function coverConsistency(p, d, engine) {
  if (!d || !isNum(d.cover_probability_raw) || !isNum(d.current_home_line) || !p || !engine || typeof engine.tCdf !== 'function') return [];
  const mk = -d.current_home_line;
  const pHome = 1 - engine.tCdf((mk - p.projected_margin) / p.sigma, p.t_df);
  const want = d.side === 'AWAY' ? 1 - pHome : pHome;
  return Math.abs(want - d.cover_probability_raw) > TOL.cover ? ['COVER_PROB_INCONSISTENT_WITH_LINE: ' + d.cover_probability_raw + ' vs ' + want.toFixed(4)] : [];
}

/* d: a decision row (engine.decide, a Model Lab snapshot or decision.js) */
function policyConsistency(d, opts) {
  opts = opts || {};
  const out = [];
  if (!d) return out;
  const status = d.decision_class || d.status;
  const betEnabled = opts.bet_enabled != null ? !!opts.bet_enabled : !!d.bet_enabled;
  if (status === 'BET' && !betEnabled) out.push('BET_WHILE_BETTING_DISABLED');
  if (status === 'BET' && !(d.side && (isNum(d.recommended_line) || isNum(d.current_home_line)) && (isNum(d.recommended_price) || isNum(d.price_american)))) out.push('BET_WITHOUT_SIDE_LINE_OR_PRICE');
  if (isNum(d.stake_units) && d.stake_units > 0 && status !== 'BET') out.push('STAKE_ON_A_NON_BET');
  return out;
}

module.exports = { VERSION, BOUNDS, TOL, CERTAIN_MARGIN, roundingNotes, isNum, utc, hoursBetween, requireAsOf, displayRound, sanity, consistency, coverConsistency, policyConsistency };
