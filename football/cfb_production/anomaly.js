/* ============================================================================
   CFB production — output anomaly detection (docs/cfb-production/OPERATIONS.md §6).

   A diagnostic of the week's outputs against their own history. These shapes
   are almost always software failures before they are football revelations,
   so each one is a WARNING or CRITICAL alert for a person to look at. None of
   them changes a number, cancels a bet or retrains anything.

     rows: [{ game_id, home_id, away_id, margin (+ = home), fair_home_line?,
              p_home, market_home_line? (book convention), status?
              (BET | LEAN | PASS | ...), home_conference?, away_conference? }]
     baseline: { mean_abs_margin: [weekly values], bets_per_week: [weekly counts],
                 conferences: [names expected every regular-season week] }

   RULES (thresholds are declared diagnostics, not tuned; min_n games before a
   distribution rule speaks):
     SIGN_CONVENTION        fair_home_line != -margin              CRITICAL
     HOME_EQUALS_AWAY       home id = away id                      CRITICAL
     OUT_OF_BOUNDS          p outside (0,1), non-finite margin,
                            |margin| > 80                          CRITICAL
     AVG_SPREAD_SHIFT       mean |margin| > 2x or < 0.5x the
                            median of prior weeks                  CRITICAL
     MARKET_GAP_WIDESPREAD  >= 50% of priced games > 10 pts off
                            the market                             CRITICAL
     PROB_NEAR_50           >= 90% of games with |p - 0.5| < 0.03  CRITICAL
     PROB_NEAR_90           >= 90% of games with max(p,1-p) >= 0.88 CRITICAL
     BET_SPIKE              BETs >= max(3, 3x median weekly BETs)  WARNING (review; never cancels)
     CONFERENCE_MISSING     an expected conference has no game     WARNING
   ========================================================================== */
'use strict';

const MIN_N = 10;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function median(a) { const v = (a || []).filter(isNum).slice().sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
function mean(a) { const v = a.filter(isNum); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }

function detect(rows, baseline) {
  rows = rows || []; baseline = baseline || {};
  const alerts = [];
  const add = (rule, severity, message, detail) => alerts.push({ rule, severity, message, detail: detail || null });

  const sign = rows.filter((r) => isNum(r.margin) && isNum(r.fair_home_line) && Math.abs(r.fair_home_line + r.margin) > 1e-6);
  if (sign.length) add('SIGN_CONVENTION', 'CRITICAL', sign.length + ' games whose fair home line is not the negated home margin: a sign flip somewhere upstream', { games: sign.slice(0, 20).map((r) => r.game_id) });
  const same = rows.filter((r) => r.home_id != null && String(r.home_id) === String(r.away_id));
  if (same.length) add('HOME_EQUALS_AWAY', 'CRITICAL', same.length + ' games with the same team on both sides: a mapping failure', { games: same.map((r) => r.game_id) });
  const oob = rows.filter((r) => !isNum(r.margin) || Math.abs(r.margin) > 80 || (r.p_home != null && !(isNum(r.p_home) && r.p_home > 0 && r.p_home < 1)));
  if (oob.length) add('OUT_OF_BOUNDS', 'CRITICAL', oob.length + ' games with a non-finite or impossible margin or probability', { games: oob.slice(0, 20).map((r) => r.game_id) });

  const n = rows.filter((r) => isNum(r.margin)).length;
  if (n >= MIN_N) {
    const m = mean(rows.map((r) => (isNum(r.margin) ? Math.abs(r.margin) : null)));
    const b = median(baseline.mean_abs_margin);
    if (isNum(b) && b > 0 && (m > 2 * b || m < 0.5 * b)) add('AVG_SPREAD_SHIFT', 'CRITICAL', 'mean |margin| ' + m.toFixed(2) + ' vs a prior-week median of ' + b.toFixed(2) + ' (x' + (m / b).toFixed(2) + ')', { mean_abs_margin: m, baseline: b });
    const priced = rows.filter((r) => isNum(r.margin) && isNum(r.market_home_line));
    if (priced.length >= MIN_N) {
      const big = priced.filter((r) => Math.abs(r.margin + r.market_home_line) > 10);
      if (big.length / priced.length >= 0.5) add('MARKET_GAP_WIDESPREAD', 'CRITICAL', big.length + ' of ' + priced.length + ' priced games are more than 10 points from the market', { share: big.length / priced.length });
    }
    const ps = rows.map((r) => r.p_home).filter(isNum);
    if (ps.length >= MIN_N) {
      const near50 = ps.filter((p) => Math.abs(p - 0.5) < 0.03).length / ps.length;
      const near90 = ps.filter((p) => Math.max(p, 1 - p) >= 0.88).length / ps.length;
      if (near50 >= 0.9) add('PROB_NEAR_50', 'CRITICAL', Math.round(near50 * 100) + '% of win probabilities are within 3 points of 50%', { share: near50 });
      if (near90 >= 0.9) add('PROB_NEAR_90', 'CRITICAL', Math.round(near90 * 100) + '% of win probabilities are at or beyond 88/12', { share: near90 });
    }
  }
  const bets = rows.filter((r) => r.status === 'BET').length;
  const bm = median(baseline.bets_per_week);
  const limit = Math.max(3, 3 * (bm || 0));
  if (bets >= limit) add('BET_SPIKE', 'WARNING', bets + ' BET decisions this week (median of prior weeks ' + (bm == null ? 'none' : bm) + '): review each against the integrity checks; nothing is cancelled for its count', { bets, baseline_median: bm });
  const confs = new Set();
  rows.forEach((r) => { if (r.home_conference) confs.add(r.home_conference); if (r.away_conference) confs.add(r.away_conference); });
  const missing = (baseline.conferences || []).filter((c) => !confs.has(c));
  if (rows.length >= MIN_N && missing.length) add('CONFERENCE_MISSING', 'WARNING', 'no game this week for ' + missing.join(', ') + ' (a schedule or mapping gap, or a bye week)', { missing });
  return { n: rows.length, alerts, worst: alerts.some((a) => a.severity === 'CRITICAL') ? 'CRITICAL' : alerts.length ? 'WARNING' : 'OK' };
}

module.exports = { detect, median, mean, MIN_N };
