#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — does RATING-STATE DIVERGENCE predict model error?

   rating_state_divergence (game level) =
       (CURRENT FBS POWER RATING home − away)  −  (PRODUCTION PRICING STATE home − away)

   i.e. how differently the two team-strength numbers see this matchup. It is
   a DIAGNOSTIC. This file asks one question of history and changes nothing:
   when the two disagree a lot, is the priced fair spread worse?

   THE DATA. The walk-forward forensic replay
   (football/cfb_p4/research/disagreement_replay.js): every FBS-vs-FBS game
   2015–2026 priced COLD from the Tuesday-freeze state, market never an input,
   joined afterwards to the cfbfastR multi-book opener/close. Beside the
   engine it records the point-in-time current-rating core (edr.js: the
   fixed-point opponent-adjusted margin + measured carryover). The roster and
   availability components of today's rating are not in the historical
   corpus, so the historical current rating is its reconstructable core —
   stated, not hidden.

   THE TEST, fitted before it is scored:
     bands     |divergence| p50 and p90 on the DEVELOPMENT fold (2015–2021)
               only → LOW / MODERATE / LARGE
     folds     DEV 2015–2021 · HOLDOUT 2022–2025 · LIVE SEASON 2026, and every
               season on its own (fold consistency)
     metrics   MAE, bias, favourite over-projection, market disagreement,
               opener MAE, EdgeDesk − opener error, close MAE, closing-line
               movement toward EdgeDesk, CLV points, and whether the result
               sided with the current rating (directional residual)
     verdict   PREDICTS_ERROR when the holdout's LARGE − LOW MAE difference has
               a bootstrap 95% CI entirely above zero AND the development fold
               has the same sign. Then divergence is a research / uncertainty
               flag. The fair spread is changed ONLY if a football-only
               correction (fitted to final margins on DEV, scored walk-forward
               on HOLDOUT) clears the repo's 0.05-point promotion bar — and even
               then it goes to the research backlog as a CHALLENGER, never
               straight into production (football/cfb_validation/README.md).

     node football/cfb_validation/divergence_backtest.js --replay FILE
   Writes football/cfb_validation/divergence_backtest.json
   ============================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; }
const REPLAY = arg('replay', path.join(ROOT, '.cache', 'cfbdata', 'out', 'disagreement_replay.jsonl'));
const OUT = arg('out', path.join(__dirname, 'divergence_backtest.json'));
const GENERATED_AT = arg('generated-at', new Date().toISOString());

const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
const mean = (a) => { a = a.filter((x) => num(x) != null); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const q = (a, p) => { a = a.filter((x) => num(x) != null).sort((x, y) => x - y); if (!a.length) return null; const i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const r = (x, d) => { if (num(x) == null) return null; const f = Math.pow(10, d == null ? 3 : d); const v = Math.round(x * f) / f; return v === 0 ? 0 : v; };
const sign = (x) => (x > 0 ? 1 : (x < 0 ? -1 : 0));

/* mulberry32: exact in 32-bit arithmetic, so every interval reproduces */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/* the difference of two independent group means, bootstrapped */
function bootDiff(a, b, B, seed) {
  const R = rng(seed || 11), out = [];
  for (let k = 0; k < (B || 2000); k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[(R() * a.length) | 0];
    for (let i = 0; i < b.length; i++) sb += b[(R() * b.length) | 0];
    out.push(sa / a.length - sb / b.length);
  }
  out.sort((x, y) => x - y);
  return [r(out[Math.floor(0.025 * out.length)], 3), r(out[Math.floor(0.975 * out.length)], 3)];
}

function load(file) {
  if (!fs.existsSync(file)) { console.error('no replay at ' + file + ' — run football/cfb_p4/research/disagreement_replay.js first'); process.exit(2); }
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const out = [];
  rows.forEach((x) => {
    if (!(x.home_fbs && x.away_fbs && x.completed) || num(x.edr_h) == null || num(x.edr_a) == null || !x.c || num(x.c.rating) == null) return;
    let open = x.mkt && num(x.mkt.open_home_line) != null ? -x.mkt.open_home_line : null;
    const close = x.mkt && num(x.mkt.close_home_line) != null ? -x.mkt.close_home_line : null;
    /* the forensics' archive-opener fault rule: an implausible or 17+ pt-from-close
       single-book opener is a data fault, not a price */
    if (open != null && (Math.abs(open) > 60 || (close != null && Math.abs(open - close) > 17))) open = null;
    const div = (x.edr_h - x.edr_a) - x.c.rating;
    out.push({ season: x.season, week: x.week, game_id: x.game_id, fair: x.fair, final: x.final_margin, open, close,
      div, abs_div: Math.abs(div), min_gp: Math.min(num(x.h_gp) || 0, num(x.a_gp) || 0) });
  });
  return out;
}

function metrics(rows) {
  const e = rows.map((x) => x.fair - x.final);
  const withO = rows.filter((x) => x.open != null), withC = rows.filter((x) => x.close != null);
  const mv = rows.filter((x) => x.open != null && x.close != null);
  let tow = 0, away = 0; const clv = [];
  mv.forEach((x) => {
    const g = sign(x.fair - x.open), d = (x.close - x.open) * g;
    clv.push(d);
    if (Math.abs(x.close - x.open) >= 0.25) { if (d > 0) tow++; else away++; }
  });
  return {
    n: rows.length,
    mae: r(mean(e.map(Math.abs)), 3),
    median_ae: r(q(e.map(Math.abs), 0.5), 3),
    p90_ae: r(q(e.map(Math.abs), 0.9), 3),
    bias: r(mean(e), 3),
    favorite_overprojection: r(mean(rows.map((x) => (x.fair - x.final) * (sign(x.fair) || 1))), 3),
    market_disagreement: r(mean(withO.map((x) => Math.abs(x.fair - x.open))), 3),
    opener_mae: r(mean(withO.map((x) => Math.abs(x.open - x.final))), 3),
    edgedesk_minus_opener_error: r(mean(withO.map((x) => Math.abs(x.fair - x.final) - Math.abs(x.open - x.final))), 3),
    close_mae: r(mean(withC.map((x) => Math.abs(x.close - x.final))), 3),
    close_moved_toward_pct: tow + away ? r(100 * tow / (tow + away), 1) : null,
    moves_counted: tow + away,
    clv_points: r(mean(clv), 3),
    /* did the result side with the CURRENT rating? + = the outcome moved from
       the priced number in the direction the current rating pointed */
    residual_toward_current_rating: r(mean(rows.map((x) => (x.final - x.fair) * sign(x.div))), 3)
  };
}

function main() {
  const all = load(REPLAY);
  const DEV = all.filter((x) => x.season >= 2015 && x.season <= 2021);
  const HOLD = all.filter((x) => x.season >= 2022 && x.season <= 2025);
  const LIVE = all.filter((x) => x.season === 2026);
  const bands = { moderate: r(q(DEV.map((x) => x.abs_div), 0.5), 2), large: r(q(DEV.map((x) => x.abs_div), 0.9), 2) };
  const bucket = (x) => (x.abs_div >= bands.large ? 'LARGE' : (x.abs_div >= bands.moderate ? 'MODERATE' : 'LOW'));
  const foldTable = (rows) => ({ LOW: metrics(rows.filter((x) => bucket(x) === 'LOW')), MODERATE: metrics(rows.filter((x) => bucket(x) === 'MODERATE')), LARGE: metrics(rows.filter((x) => bucket(x) === 'LARGE')), ALL: metrics(rows) });
  const folds = { DEV_2015_2021: foldTable(DEV), HOLDOUT_2022_2025: foldTable(HOLD), LIVE_2026: foldTable(LIVE) };
  const absErr = (rows, b) => rows.filter((x) => bucket(x) === b).map((x) => Math.abs(x.fair - x.final));
  const diffCi = {
    DEV_2015_2021: bootDiff(absErr(DEV, 'LARGE'), absErr(DEV, 'LOW'), 2000, 11),
    HOLDOUT_2022_2025: bootDiff(absErr(HOLD, 'LARGE'), absErr(HOLD, 'LOW'), 2000, 12),
    LIVE_2026: absErr(LIVE, 'LARGE').length >= 10 ? bootDiff(absErr(LIVE, 'LARGE'), absErr(LIVE, 'LOW'), 2000, 13) : [null, null]
  };
  /* every season on its own: is LARGE worse than LOW, season after season? */
  const seasons = [...new Set(all.map((x) => x.season))].sort();
  const bySeason = seasons.map((s) => {
    const rs = all.filter((x) => x.season === s), L = absErr(rs, 'LARGE'), Lo = absErr(rs, 'LOW');
    return { season: s, n: rs.length, n_large: L.length, n_low: Lo.length, mae_large: r(mean(L), 3), mae_low: r(mean(Lo), 3), diff: L.length && Lo.length ? r(mean(L) - mean(Lo), 3) : null };
  });
  const closed = bySeason.filter((s) => s.season <= 2025 && s.diff != null);
  let streak = 0, best = 0;
  closed.forEach((s) => { if (s.diff > 0) { streak++; best = Math.max(best, streak); } else streak = 0; });

  /* the football-only correction, walk-forward: final − fair = β·div + ε on
     DEV (no intercept: the priced number already carries the league mean),
     scored on HOLDOUT */
  const beta = (() => { let sxy = 0, sxx = 0; DEV.forEach((x) => { sxy += x.div * (x.final - x.fair); sxx += x.div * x.div; }); return sxx ? sxy / sxx : 0; })();
  const holdBase = HOLD.map((x) => Math.abs(x.fair - x.final));
  const holdAdj = HOLD.map((x) => Math.abs(x.fair + beta * x.div - x.final));
  const paired = holdAdj.map((v, i) => v - holdBase[i]);
  const pairedCi = (() => { const R = rng(21), out = []; for (let k = 0; k < 2000; k++) { let s = 0; for (let i = 0; i < paired.length; i++) s += paired[(R() * paired.length) | 0]; out.push(s / paired.length); } out.sort((a, b) => a - b); return [r(out[50], 4), r(out[1949], 4)]; })();
  const corr = { beta_fitted_on_dev: r(beta, 4), holdout_mae_base: r(mean(holdBase), 4), holdout_mae_corrected: r(mean(holdAdj), 4),
    holdout_mae_change: r(mean(paired), 4), holdout_change_ci: pairedCi, promotion_bar: -0.05,
    clears_bar: mean(paired) <= -0.05 && pairedCi[1] < 0 };

  const H = folds.HOLDOUT_2022_2025, D = folds.DEV_2015_2021;
  const devSign = D.LARGE.mae - D.LOW.mae, holdSign = H.LARGE.mae - H.LOW.mae;
  const POOL = DEV.concat(HOLD);
  const pooledCi = bootDiff(absErr(POOL, 'LARGE'), absErr(POOL, 'LOW'), 2000, 14);
  const favCi = bootDiff(HOLD.filter((x) => bucket(x) === 'LARGE').map((x) => (x.fair - x.final) * (sign(x.fair) || 1)),
    HOLD.filter((x) => bucket(x) === 'LOW').map((x) => (x.fair - x.final) * (sign(x.fair) || 1)), 2000, 15);
  const consistent = closed.filter((s) => s.diff > 0).length >= Math.ceil(closed.length / 2);
  /* THE RULE, declared before reading the result:
       PREDICTS_ERROR  holdout LARGE − LOW MAE CI entirely above zero, same sign on DEV
       DIRECTIONAL     LARGE worse than LOW on both folds' point estimates and in at
                       least half the seasons, but the holdout CI includes zero
       NOT_ESTABLISHED otherwise */
  const status = (diffCi.HOLDOUT_2022_2025[0] > 0 && devSign > 0) ? 'PREDICTS_ERROR'
    : ((devSign > 0 && holdSign > 0 && consistent) ? 'DIRECTIONAL' : 'NOT_ESTABLISHED');
  const flag = status !== 'NOT_ESTABLISHED';
  const verdict = {
    predicts_error: status === 'PREDICTS_ERROR',
    status,
    use_as_flag: flag,
    reading: 'LARGE divergence (|div| ≥ ' + bands.large + ' pts) vs LOW (< ' + bands.moderate + '): holdout MAE ' + H.LARGE.mae + ' (n ' + H.LARGE.n + ') vs ' + H.LOW.mae + ' (n ' + H.LOW.n + '), '
      + 'difference CI ' + JSON.stringify(diffCi.HOLDOUT_2022_2025) + '; development ' + D.LARGE.mae + ' vs ' + D.LOW.mae + '; pooled CI ' + JSON.stringify(pooledCi) + '; '
      + closed.filter((s) => s.diff > 0).length + ' of ' + closed.length + ' seasons worse. EdgeDesk − opener error ' + H.LARGE.edgedesk_minus_opener_error + ' vs ' + H.LOW.edgedesk_minus_opener_error
      + '; favourite over-projection ' + H.LARGE.favorite_overprojection + ' vs ' + H.LOW.favorite_overprojection + ' (difference CI ' + JSON.stringify(favCi) + '); market disagreement ' + H.LARGE.market_disagreement + ' vs ' + H.LOW.market_disagreement + ' pts.',
    action: (flag
      ? 'Use rating-state divergence as an UNCERTAINTY / RESEARCH FLAG (the high-uncertainty view and the game page) — ' + (status === 'PREDICTS_ERROR' ? 'the error link is established.' : 'the error link is directional, not established at 95%.')
      : 'Keep rating-state divergence as a displayed diagnostic only.')
      + ' The fair spread is NOT changed. ' + (corr.clears_bar
        ? 'A football-only correction (final − fair = ' + corr.beta_fitted_on_dev + ' × divergence, fitted on 2015–2021) improves the 2022–2025 walk-forward MAE by ' + (-corr.holdout_mae_change) + ' pts (CI ' + JSON.stringify(corr.holdout_change_ci) + '), clearing the 0.05 bar: it is QUEUED as a research candidate for the challenger pipeline (RESEARCH → CHALLENGER → WALK-FORWARD → SHADOW → PROMOTION), never applied to production directly.'
        : 'No football-only correction clears the 0.05-point bar walk-forward.'),
    market_note: 'The close moved toward EdgeDesk ' + H.LARGE.close_moved_toward_pct + '% of the time on LARGE-divergence holdout games vs ' + H.LOW.close_moved_toward_pct + '% on LOW: the market partly absorbs the same information, which is not an edge after the vig.',
    pooled_mae_difference_ci95: pooledCi, favorite_overprojection_difference_ci95: favCi
  };

  const out = {
    schema: 'edgedesk_cfb_divergence_backtest_v1', generated_at: GENERATED_AT,
    definition: 'rating_state_divergence = (current FBS power rating home − away) − (production pricing state home − away), neutral-field points',
    source: { replay: 'football/cfb_p4/research/disagreement_replay.js (cold, Tuesday freeze, market never an input)', market: 'cfbfastR cfb_line_odds multi-book opener/close',
      current_rating_proxy: 'point-in-time current-rating core (football/rating/edr.js: opponent-adjusted capped margin + measured carryover); roster and availability components are not in the historical corpus',
      opener_fault_rule: 'an opener more than 60 pts or more than 17 pts from a multi-book close is dropped as a data fault (forensics rule)' },
    n: { all: all.length, dev: DEV.length, holdout: HOLD.length, live_2026: LIVE.length },
    bands: Object.assign({ fitted_on: 'DEV 2015–2021 only', basis: '|divergence| p50 → MODERATE, p90 → LARGE' }, bands),
    folds, mae_difference_large_minus_low_ci95: diffCi,
    by_season: bySeason,
    fold_consistency: { seasons_scored: closed.length, seasons_large_worse: closed.filter((s) => s.diff > 0).length, longest_consecutive_run: best },
    football_only_correction: corr,
    verdict,
    production_effect: 'none: the fair spread is unchanged; the divergence is a research and uncertainty flag (lib/edgedesk_canon.js gameDivergence).'
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ n: out.n, bands, verdict: verdict.status, holdout: { LOW: H.LOW.mae, LARGE: H.LARGE.mae }, ci: diffCi.HOLDOUT_2022_2025, correction: corr, consistency: out.fold_consistency }));
}

if (require.main === module) main();
module.exports = { metrics, load };
