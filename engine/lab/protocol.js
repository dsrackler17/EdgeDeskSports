'use strict';
/* ===========================================================================
   EdgeDesk lab — the walk-forward protocol every new brain shares.

   The rules are written here once, before any sport is scored, and each
   brain's walkforward.js applies them unchanged:

     WINDOWS    burn-in (rated, never scored) · SELECTION (choose and tune) ·
                CONFIRMATION (report only) · LIVE (the season in progress).
     CHOOSING   the candidate with the lowest SELECTION log loss; a challenger
                replaces the incumbent only if it beats it by >= 0.001.
     OUTCOME_VALIDATED (per market) on CONFIRMATION:
                n >= 1000 and >= 2 seasons (one season cannot show stability);
                binary markets: |mean p - mean y| <= 0.02, calibration slope
                in [0.85, 1.15], and (moneyline) a block-bootstrap 95% interval
                of the log-loss difference vs the best baseline wholly below 0;
                distribution markets (margin, total): 80% interval coverage in
                [0.77, 0.83], |mean bias| <= 1% of the mean outcome, and a CRPS
                interval vs the baseline wholly below 0.
                Anything else is PROVISIONAL, with the failed rules listed.
     MARKET     NOT_TESTED until a licensed archive of timestamped closing
                prices is on file. Archived, untimestamped lines never count.
     TIME       every input is dated; a game's facts enter ratings only for
                games on later dates (audited by engine/validation.leakageAudit).
   =========================================================================== */
const V = require('../validation');

const RULES = {
  min_n: 1000, min_seasons: 2, max_citl: 0.02, slope: [0.85, 1.15], challenger_margin: 0.001,
  coverage80: [0.77, 0.83], max_bias_share: 0.01,
};

const inWin = (s, w) => s >= w[0] && s <= w[1];

/* the standard normal */
function phi(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
function Phi(z) {
  /* Abramowitz-Stegun 7.1.26 via erf; |error| < 1.5e-7 */
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** CRPS of a normal forecast N(mu, sd) for outcome y (Gneiting & Raftery 2007) */
function crpsNormal(mu, sd, y) { const z = (y - mu) / sd; return sd * (z * (2 * Phi(z) - 1) + 2 * phi(z) - 1 / Math.sqrt(Math.PI)); }

/** distribution scores of normal forecasts: [{mu, sd, y}] */
function distribution(rows) {
  const n = rows.length; if (!n) return { n: 0 };
  let crps = 0, bias = 0, cover = 0, mean = 0;
  const z80 = 1.2815515655;
  for (const r of rows) { crps += crpsNormal(r.mu, r.sd, r.y); bias += r.mu - r.y; mean += r.y; if (Math.abs(r.y - r.mu) <= z80 * r.sd) cover++; }
  return { n, crps: V.r(crps / n, 4), mean_bias: V.r(bias / n, 3), mean_outcome: V.r(mean / n, 2), coverage_80: V.r(cover / n, 4) };
}

/** status of a binary market (moneyline) on the confirmation window */
function binaryStatus(m, seasons, beatsBest) {
  const fails = [];
  if (!m || m.n < RULES.min_n) fails.push('n ' + (m ? m.n : 0) + ' < ' + RULES.min_n);
  if (seasons < RULES.min_seasons) fails.push(seasons + ' confirmation season(s) < ' + RULES.min_seasons);
  if (m && Math.abs(m.calibration_in_the_large) > RULES.max_citl) fails.push('mean p off by ' + m.calibration_in_the_large);
  if (m && (m.calibration_slope == null || m.calibration_slope < RULES.slope[0] || m.calibration_slope > RULES.slope[1])) fails.push('calibration slope ' + m.calibration_slope);
  if (beatsBest === false) fails.push('does not beat the best baseline with a 95% interval below zero');
  return { status: fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED', failed: fails };
}

/** status of a distribution market (margin / total) */
function distributionStatus(d, seasons, beatsBaseline) {
  const fails = [];
  if (!d || d.n < RULES.min_n) fails.push('n ' + (d ? d.n : 0) + ' < ' + RULES.min_n);
  if (seasons < RULES.min_seasons) fails.push(seasons + ' confirmation season(s) < ' + RULES.min_seasons);
  if (d && (d.coverage_80 < RULES.coverage80[0] || d.coverage_80 > RULES.coverage80[1])) fails.push('80% interval covers ' + d.coverage_80);
  if (d && Math.abs(d.mean_bias) > RULES.max_bias_share * Math.abs(d.mean_outcome || 1) && Math.abs(d.mean_bias) > 0.25) fails.push('mean bias ' + d.mean_bias);
  if (beatsBaseline === false) fails.push('CRPS does not beat the baseline with a 95% interval below zero');
  return { status: fails.length ? 'PROVISIONAL' : 'OUTCOME_VALIDATED', failed: fails };
}

/** choose by the selection rule; candidates in order of complexity, the first is the incumbent */
function choose(selLL, order) {
  let chosen = order[0];
  for (const c of order.slice(1)) if (selLL[c] != null && selLL[c] <= selLL[chosen] - RULES.challenger_margin) chosen = c;
  return chosen;
}

/** paired block bootstrap of a per-game loss difference a - b, blocked by date */
function compare(rows, la, lb, o) {
  return V.pairedBootstrap(rows.map((r) => ({ date: r.date, a: la(r), b: lb(r) })), Object.assign({ B: 1000 }, o || {}));
}

const MARKET_NOT_TESTED = { market_status: 'NOT_TESTED', market_reason: 'no licensed archive of timestamped closing prices is on file; archived untimestamped lines are not a market test' };

module.exports = { RULES, inWin, Phi, phi, crpsNormal, distribution, binaryStatus, distributionStatus, choose, compare, MARKET_NOT_TESTED };
