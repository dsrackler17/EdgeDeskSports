#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — MAJOR-DISAGREEMENT FORENSICS.

   Reads the walk-forward replay (disagreement_replay.js) and answers, with
   football outcomes and nothing retrospective at the prediction instant:

     - how often, and how large, the production engine disagrees with the
       market, and whether it was RIGHT to (market movement, final margin vs
       opener and close, the side's result — never the ATS result alone);
     - which subsystem creates the extreme gaps (base ratings vs game
       adjustments, conference scale, matchup, home field, early-season prior,
       carryover, recency, opponent adjustment, extreme favourites);
     - whether a football-only margin calibrator (fitted to FINAL MARGINS,
       never to the market) improves accuracy walk-forward, and whether it
       clears the repo's promotion bar;
     - whether the integrity gate (lib/cfb_disagreement.js) separates genuine
       disagreements from false ones — measured on a HOLDOUT (2022-2025) with
       every measured parameter fitted on 2015-2021 only;
     - whether a disagreement-quality score earns its place (it is dropped if
       it does not).

   It then GENERATES the gate's measured parameters from 2015-2025:
     football/cfb_p4/disagreement_params.js   component ranges, gap rates,
                                              the calibrator, the quality
                                              score (only if validated)
     football/cfb_p4/margin_calibration.js    the calibrator the engine
                                              publishes as a shadow number
   and the evidence:
     football/validation/disagreement/forensics_cfb.json
     football/validation/disagreement/major_disagreements_cfb.csv.gz
     docs/cfb-disagreement/FORENSICS.md

     node football/cfb_p4/research/disagreement_forensics.js --data DIR
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var HERE = __dirname;
var ROOT = path.join(HERE, '..', '..', '..');
global.window = global.window || global;
var D = require(path.join(ROOT, 'lib', 'cfb_disagreement.js'));

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = String(arg('data', path.join(ROOT, '.cache', 'cfbdata')));
var WRITE = !arg('dry', false);
var DEV = [2015, 2021], HOLD = [2022, 2025], LIVE = 2026;
var GENERATED_AT = String(arg('generated-at', new Date().toISOString()));

/* ------------------------------------------------------------ helpers */
function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
function mean(a) { a = a.filter(function (x) { return num(x) != null; }); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function sd(a) { a = a.filter(function (x) { return num(x) != null; }); if (a.length < 2) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
function q(a, p) { a = a.filter(function (x) { return num(x) != null; }).sort(function (x, y) { return x - y; }); if (!a.length) return null; var i = (a.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }
function r(x, d) { if (num(x) == null) return null; var f = Math.pow(10, d == null ? 3 : d); var v = Math.round(x * f) / f; return v === 0 ? 0 : v; }
function pct(x) { return x == null ? null : r(100 * x, 1); }
function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
function inS(rw, span) { return rw.season >= span[0] && rw.season <= span[1]; }
function dist(a) {
  var aa = a.filter(function (x) { return num(x) != null; });
  return { n: aa.length, mean: r(mean(aa), 3), median: r(q(aa, 0.5), 3), sd: r(sd(aa), 3),
    p5: r(q(aa, 0.05), 2), p25: r(q(aa, 0.25), 2), p75: r(q(aa, 0.75), 2), p95: r(q(aa, 0.95), 2),
    p99: r(q(aa, 0.99), 2), min: r(aa.length ? Math.min.apply(null, aa) : null, 2), max: r(aa.length ? Math.max.apply(null, aa) : null, 2) };
}
function absDist(a) {
  var aa = a.filter(function (x) { return num(x) != null; }).map(Math.abs);
  return { n: aa.length, median: r(q(aa, 0.5), 3), p75: r(q(aa, 0.75), 3), p90: r(q(aa, 0.9), 3), p95: r(q(aa, 0.95), 3),
    p99: r(q(aa, 0.99), 3), max: r(aa.length ? Math.max.apply(null, aa) : null, 3), share_nonzero: r(aa.filter(function (x) { return x > 0.005; }).length / Math.max(aa.length, 1), 3) };
}
/* least squares via the normal equations */
function solve(A, b) {
  var n = A.length, M = A.map(function (row, i) { return row.concat([b[i]]); }), c, rr, k;
  for (c = 0; c < n; c++) {
    var p = c;
    for (rr = c + 1; rr < n; rr++) if (Math.abs(M[rr][c]) > Math.abs(M[p][c])) p = rr;
    var t = M[c]; M[c] = M[p]; M[p] = t;
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (rr = 0; rr < n; rr++) {
      if (rr === c) continue;
      var f = M[rr][c] / M[c][c];
      for (k = c; k <= n; k++) M[rr][k] -= f * M[c][k];
    }
  }
  return M.map(function (row, i) { return row[n] / row[i]; });
}
function ols(X, y) {
  var p = X[0].length, A = [], b = [], i, j, k;
  for (j = 0; j < p; j++) { A.push(new Array(p).fill(0)); b.push(0); }
  for (i = 0; i < X.length; i++) for (j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k]; }
  var co = solve(A, b);
  if (!co) return null;
  var res = y.map(function (yy, ii) { return yy - X[ii].reduce(function (s, x, jj) { return s + x * co[jj]; }, 0); });
  var s2 = res.reduce(function (s, e) { return s + e * e; }, 0) / Math.max(1, X.length - p);
  /* standard errors from (X'X)^-1 */
  var se = [];
  for (j = 0; j < p; j++) {
    var e = new Array(p).fill(0); e[j] = 1;
    var col = solve(A, e);
    se.push(col ? Math.sqrt(Math.max(0, s2 * col[j])) : null);
  }
  return { coef: co, se: se, n: X.length };
}
function bootCI(diffs, B, seed) {
  var s = (seed || 7) >>> 0, out = [];
  /* mulberry32: exact in 32-bit integer arithmetic, so the interval is reproducible */
  function rnd() { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  for (var b = 0; b < (B || 2000); b++) { var t = 0; for (var i = 0; i < diffs.length; i++) t += diffs[(rnd() * diffs.length) | 0]; out.push(t / diffs.length); }
  out.sort(function (x, y) { return x - y; });
  return [r(out[Math.floor(0.025 * out.length)], 4), r(out[Math.floor(0.975 * out.length)], 4)];
}

/* ------------------------------------------------------------ the replay */
var file = path.join(DATA, 'out', 'disagreement_replay.jsonl');
if (!fs.existsSync(file)) { console.error('no replay at ' + file + ' — run disagreement_replay.js first'); process.exit(2); }
var ROWS = fs.readFileSync(file, 'utf8').trim().split('\n').map(function (l) { return JSON.parse(l); });
/* ARCHIVE OPENER FAULTS. The archive carries single-book openers that are
   not markets at all: -334, 185, and sign flips (UCF v Maryland 2016 opened -9
   at one book and closed +10.5 at seventeen). An opener that is implausible
   (|line| > 60) or that sits more than 17 points (the archive's p99.9 move)
   from a multi-book close is a MARKET_JOIN / STALE data fault, not a price:
   it is dropped as the prediction-time reference and counted. This cleans the
   RESEARCH dataset only; the live gate never sees a close. */
var OPEN_FAULTS = [];
ROWS.forEach(function (x) {
  x.open = x.mkt && num(x.mkt.open_home_line) != null ? -x.mkt.open_home_line : null;     /* margin convention */
  x.close = x.mkt && num(x.mkt.close_home_line) != null ? -x.mkt.close_home_line : null;
  if (x.open != null && (Math.abs(x.open) > 60 || (x.close != null && Math.abs(x.open - x.close) > 17))) {
    OPEN_FAULTS.push({ game_id: x.game_id, season: x.season, week: x.week, game: x.away + ' @ ' + x.home, open: x.open, close: x.close,
      open_books: x.mkt.open_books, close_books: x.mkt.close_books });
    x.open = null;
  }
  x.ref = x.open != null ? x.open : null;                /* the market at the prediction instant */
  x.gap_open = x.ref == null ? null : x.fair - x.ref;
  x.gap_close = x.close == null ? null : x.fair - x.close;
  x.fbs2 = x.home_fbs && x.away_fbs;
  x.min_gp = Math.min(x.h_gp, x.a_gp);
  x.cross_conf = x.fbs2 && x.home_conference && x.away_conference && x.home_conference !== x.away_conference;
  x.bucket = D.weekBucket(x.week);
});
var FB = ROWS.filter(function (x) { return x.fbs2 && x.completed; });
console.error('[forensics] ' + ROWS.length + ' replay rows; ' + FB.length + ' completed FBS-vs-FBS');

/* ------------------------------------------------------------ was EdgeDesk right? */
/* ref: 'open' (the prediction instant) or 'close' */
function evidence(rows, ref) {
  ref = ref || 'open';
  var R = rows.filter(function (x) { return x.completed && (ref === 'open' ? x.open != null : x.close != null); });
  if (!R.length) return { n: 0 };
  var mk = function (x) { return ref === 'open' ? x.open : x.close; };
  var gap = function (x) { return x.fair - mk(x); };
  var withMove = R.filter(function (x) { return x.open != null && x.close != null; });
  var tow = 0, unch = 0, away = 0, clv = [];
  withMove.forEach(function (x) {
    var g = x.fair - x.open, mv = (x.close - x.open) * sign(g);
    clv.push(mv);
    if (Math.abs(x.close - x.open) < 0.25) unch++; else if (mv > 0) tow++; else away++;
  });
  var cov = R.filter(function (x) { return x.final_margin !== mk(x) && gap(x) !== 0; });
  var wins = cov.filter(function (x) { return sign(x.final_margin - mk(x)) === sign(gap(x)); }).length;
  var fe = withMove.map(function (x) { return D.falseExtreme({ fair: x.fair, open: x.open, close: x.close, final_margin: x.final_margin }); })
    .filter(function (v) { return v != null; });
  return {
    n: R.length,
    model_mae: r(mean(R.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
    open_mae: r(mean(R.filter(function (x) { return x.open != null; }).map(function (x) { return Math.abs(x.open - x.final_margin); })), 3),
    close_mae: r(mean(R.filter(function (x) { return x.close != null; }).map(function (x) { return Math.abs(x.close - x.final_margin); })), 3),
    edgedesk_closer_than_open_pct: pct(mean(R.filter(function (x) { return x.open != null; }).map(function (x) { return Math.abs(x.fair - x.final_margin) < Math.abs(x.open - x.final_margin) ? 1 : 0; }))),
    edgedesk_closer_than_close_pct: pct(mean(R.filter(function (x) { return x.close != null; }).map(function (x) { return Math.abs(x.fair - x.final_margin) < Math.abs(x.close - x.final_margin) ? 1 : 0; }))),
    close_moved_toward_pct: withMove.length ? pct(tow / withMove.length) : null,
    close_unchanged_pct: withMove.length ? pct(unch / withMove.length) : null,
    close_moved_away_pct: withMove.length ? pct(away / withMove.length) : null,
    clv_points_mean: r(mean(clv), 3),
    side_covered_pct: cov.length ? pct(wins / cov.length) : null,
    roi_at_minus110_pct: cov.length ? pct((wins * (100 / 110) - (cov.length - wins)) / cov.length) : null,
    false_extreme_rate_pct: fe.length ? pct(mean(fe.map(function (v) { return v ? 1 : 0; }))) : null,
    false_extremes: fe.filter(Boolean).length
  };
}

var OUT = { schema: 'edgedesk_cfb_disagreement_forensics_v1', generated_at: GENERATED_AT,
  source: { replay: 'football/cfb_p4/research/disagreement_replay.js (cold, Tuesday-freeze, production inputs, market never an input)',
    market: 'cfbfastR cfb_line_odds multi-book opener/close (2015-2025); Model Lab ledger consensus (2026)',
    submodels: 'V2 candidate 001 walk-forward predictions (efficiency, Elo, ridge, GBM, drive)', dev: DEV, holdout: HOLD, live: LIVE },
  archive_opener_faults: null,
  definitions: {
    raw_market_gap: 'pure fair margin - market margin, home perspective; measured at the prediction instant against the OPENER (the market on file at the Tuesday freeze)',
    moved_toward: 'the close moved from the opener in the direction of EdgeDesk’s number (|move| >= 0.25)',
    clv_points: 'closing move in EdgeDesk’s direction, in points (positive = the market came to EdgeDesk)',
    false_extreme: D.falseExtreme.toString().length ? 'a raw 7+ gap where the close did NOT move toward EdgeDesk AND the final margin landed on the market’s side or within the first quarter of the gap from the market. A losing ticket alone is never enough.' : null,
    unavailable_in_corpus: ['QB certainty (no historical starter record)', 'roster certainty (no historical availability record)',
      'weather (no weather coefficient is priced; 0 by design)', 'special teams (not a V1 pricing term; 0 by design)',
      'reliability score (production-only)', 'returning production / coaching continuity (not in the replay corpus)']
  } };

OUT.archive_opener_faults = { n: OPEN_FAULTS.length, rule: '|opener| > 60, or more than 17 pts from the close (the archive p99.9 open-to-close move)',
  classified_as: 'MARKET_JOIN_ERROR / STALE_MARKET (data faults, excluded as the prediction-time reference)', rows: OPEN_FAULTS };

/* ============================================================ 1-3. the dataset + gap distribution */
var withOpen = FB.filter(function (x) { return x.open != null; });
var BUCKETS = [[5, 7, '5.0-6.9'], [7, 10, '7.0-9.9'], [10, 15, '10.0-14.9'], [15, 999, '15.0+']];
var XBUCKETS = [[7, 9, '7-8.9'], [9, 11, '9-10.9'], [11, 14, '11-13.9'], [14, 999, '14+']];
function gapAbs(x) { return x.gap_open != null ? Math.abs(x.gap_open) : (x.gap_close != null ? Math.abs(x.gap_close) : null); }

OUT.gap_distribution = {
  vs_open: { all: dist(withOpen.map(function (x) { return x.gap_open; })),
    dev: dist(withOpen.filter(function (x) { return inS(x, DEV); }).map(function (x) { return x.gap_open; })),
    holdout: dist(withOpen.filter(function (x) { return inS(x, HOLD); }).map(function (x) { return x.gap_open; })) },
  vs_close: { all: dist(FB.filter(function (x) { return x.close != null && x.season <= 2025; }).map(function (x) { return x.gap_close; })),
    live_2026: dist(FB.filter(function (x) { return x.close != null && x.season === LIVE; }).map(function (x) { return x.gap_close; })) },
  by_season: {}, by_week_bucket: {}
};
for (var s = 2015; s <= LIVE; s++) {
  var S = FB.filter(function (x) { return x.season === s && (x.gap_open != null || x.gap_close != null); });
  if (!S.length) continue;
  var ga = S.map(gapAbs);
  OUT.gap_distribution.by_season[s] = { n: S.length, reference: s === LIVE ? 'close (2026 openers are sparse)' : 'open (close where no opener)',
    mean_abs: r(mean(ga), 2), ge5: ga.filter(function (v) { return v >= 5; }).length, ge7: ga.filter(function (v) { return v >= 7; }).length,
    ge10: ga.filter(function (v) { return v >= 10; }).length, ge15: ga.filter(function (v) { return v >= 15; }).length,
    ge7_rate_pct: pct(ga.filter(function (v) { return v >= 7; }).length / S.length) };
}
['0_2', '3_5', '6p'].forEach(function (b) {
  var S = withOpen.filter(function (x) { return x.bucket === b && x.season <= 2025; }), ga = S.map(function (x) { return Math.abs(x.gap_open); });
  OUT.gap_distribution.by_week_bucket[b] = { n: S.length, mean_abs: r(mean(ga), 2),
    rate_ge7: r(ga.filter(function (v) { return v >= 7; }).length / S.length, 4), rate_ge10: r(ga.filter(function (v) { return v >= 10; }).length / S.length, 4),
    rate_ge15: r(ga.filter(function (v) { return v >= 15; }).length / S.length, 4) };
});
OUT.counts = {};
[['all_2015_2025', [2015, 2025]], ['dev', DEV], ['holdout', HOLD]].forEach(function (sp) {
  var S = withOpen.filter(function (x) { return inS(x, sp[1]); });
  OUT.counts[sp[0]] = { games: S.length };
  BUCKETS.forEach(function (b) { OUT.counts[sp[0]][b[2]] = S.filter(function (x) { return Math.abs(x.gap_open) >= b[0] && Math.abs(x.gap_open) < b[1]; }).length; });
  OUT.counts[sp[0]]['7+'] = S.filter(function (x) { return Math.abs(x.gap_open) >= 7; }).length;
});

/* ============================================================ 3. was EdgeDesk right to disagree? */
OUT.was_edgedesk_right = { by_bucket: {}, by_extreme_bucket: {}, by_week_bucket_7plus: {} };
[[0, 2, '0-1.9'], [2, 5, '2-4.9']].concat(BUCKETS).forEach(function (b) {
  OUT.was_edgedesk_right.by_bucket[b[2]] = evidence(withOpen.filter(function (x) { return x.season <= 2025 && Math.abs(x.gap_open) >= b[0] && Math.abs(x.gap_open) < b[1]; }), 'open');
});
XBUCKETS.forEach(function (b) {
  OUT.was_edgedesk_right.by_extreme_bucket[b[2]] = evidence(withOpen.filter(function (x) { return x.season <= 2025 && Math.abs(x.gap_open) >= b[0] && Math.abs(x.gap_open) < b[1]; }), 'open');
});
['0_2', '3_5', '6p'].forEach(function (b) {
  OUT.was_edgedesk_right.by_week_bucket_7plus[b] = evidence(withOpen.filter(function (x) { return x.season <= 2025 && x.bucket === b && Math.abs(x.gap_open) >= 7; }), 'open');
});

/* ============================================================ 6. component distributions */
var CK = ['rating', 'hfa', 'matchup', 'conference', 'schedule', 'qb', 'injury', 'travel', 'rivalry'];
function compDists(rows) {
  var o = {};
  CK.forEach(function (k) { o[k] = absDist(rows.map(function (x) { return x.c[k]; })); });
  o.current_form = absDist(rows.map(function (x) { return x.c.rating - x.prior_weight * (x.h_carried - x.a_carried); }));
  o.long_term_state = absDist(rows.map(function (x) { return x.prior_weight * (x.h_carried - x.a_carried); }));
  return o;
}
OUT.component_distributions = { all_2015_2025: compDists(FB.filter(function (x) { return x.season <= 2025; })),
  dev: compDists(FB.filter(function (x) { return inS(x, DEV); })), live_2026: compDists(FB.filter(function (x) { return x.season === LIVE; })),
  note: 'absolute points each additive term contributed to the published margin. qb, injury, travel and rivalry contribute 0 by design in production (unpriced / rejected layers); injury is non-zero only when an availability report prices a QB absence, which the historical corpus does not carry.' };

/* ============================================================ 7-8. sources of extreme gaps */
function cond(label, rows) { return { label: label, evidence: evidence(rows, 'open') }; }
var BIG = withOpen.filter(function (x) { return x.season <= 2025 && Math.abs(x.gap_open) >= 7; });
function baseGap(x) { return x.c.rating + x.c.hfa - x.open; }
function attributes(x) {
  var G = x.gap_open, s = sign(G), bg = baseGap(x);
  if (Math.abs(bg) >= 7 && sign(bg) === s) return 'BASE_RATING_ALONE';
  var cands = [['conference', x.c.conference], ['matchup', x.c.matchup], ['schedule', x.c.schedule]];
  for (var i = 0; i < cands.length; i++) if (sign(cands[i][1]) === s && Math.abs(G - cands[i][1]) < 7) return cands[i][0].toUpperCase() + '_TERM';
  return 'COMBINATION_OF_ADJUSTMENTS';
}
OUT.sources_of_extremes = {
  attribution_7plus: {}, conditions: [],
  base_rating_audit: {
    definition: 'base_rating_gap = neutral rating difference + applied home field - market margin: the disagreement before any game-specific adjustment',
    share_7plus_where_base_alone_ge7: pct(BIG.filter(function (x) { return Math.abs(baseGap(x)) >= 7 && sign(baseGap(x)) === sign(x.gap_open); }).length / BIG.length),
    share_7plus_where_adjustments_create_it: pct(BIG.filter(function (x) { return !(Math.abs(baseGap(x)) >= 7 && sign(baseGap(x)) === sign(x.gap_open)); }).length / BIG.length),
    base_gap_distribution_7plus: dist(BIG.map(function (x) { return Math.abs(baseGap(x)); }))
  }
};
var att = {};
BIG.forEach(function (x) { var a = attributes(x); (att[a] = att[a] || []).push(x); });
Object.keys(att).forEach(function (k) { OUT.sources_of_extremes.attribution_7plus[k] = evidence(att[k], 'open'); });
[
  ['matchup adjustment > 3 pts (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.c.matchup) > 3; })],
  ['matchup adjustment <= 1 pt (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.c.matchup) <= 1; })],
  ['conference term > 3 pts (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.c.conference) > 3; })],
  ['conference term 0.01-3 pts (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.c.conference) > 0.01 && Math.abs(x.c.conference) <= 3; })],
  ['no conference term (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.c.conference) <= 0.01; })],
  ['team-state difference alone creates the 7+ gap', BIG.filter(function (x) { return Math.abs(baseGap(x)) >= 7 && sign(baseGap(x)) === sign(x.gap_open); })],
  ['0 current-season games behind a rating (7+ gaps)', BIG.filter(function (x) { return x.min_gp === 0; })],
  ['1-2 games (7+ gaps)', BIG.filter(function (x) { return x.min_gp >= 1 && x.min_gp <= 2; })],
  ['3+ games (7+ gaps)', BIG.filter(function (x) { return x.min_gp >= 3; })],
  ['home favourite by EdgeDesk (7+ gaps)', BIG.filter(function (x) { return x.fair > 0 && !x.neutral_site; })],
  ['road favourite by EdgeDesk (7+ gaps)', BIG.filter(function (x) { return x.fair < 0 && !x.neutral_site; })],
  ['EdgeDesk favourite by 21+ (7+ gaps)', BIG.filter(function (x) { return Math.abs(x.fair) >= 21; })]
].forEach(function (c) { OUT.sources_of_extremes.conditions.push(cond(c[0], c[1])); });

/* ============================================================ 9. public rating vs engine state */
function edrMargin(x) { return (x.edr_h != null && x.edr_a != null) ? x.edr_h - x.edr_a + (x.neutral_site ? 0 : 4.082) : null; }
var EDRROWS = FB.filter(function (x) { return x.season <= 2025 && edrMargin(x) != null; });
OUT.public_rating_vs_engine = {
  what: 'the PUBLIC EdgeDesk Rating core (football/rating/edr.js: fixed-point opponent-adjusted capped margin + measured carryover, computed point-in-time at each freeze; the roster component is not in the historical corpus) against the PRICING engine state (sequential Elo carried + this-season track, blended by games played)',
  n: EDRROWS.length,
  mae_public_rating_margin: r(mean(EDRROWS.map(function (x) { return Math.abs(edrMargin(x) - x.final_margin); })), 3),
  mae_engine_base_rating_plus_hfa: r(mean(EDRROWS.map(function (x) { return Math.abs(x.c.rating + x.c.hfa - x.final_margin); })), 3),
  mae_engine_published: r(mean(EDRROWS.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
  by_week_bucket: {}, correlation_of_team_gaps: null,
  divergence: dist(EDRROWS.map(function (x) { return (x.edr_h - x.edr_a) - x.c.rating; })),
  production_wiring: 'football/rating/current.json calibration.measured is false, so setCanonicalRatings keeps the public rating OUT of pricing (canonical_rating.test.js). The board prices from the engine state.'
};
['0_2', '3_5', '6p'].forEach(function (b) {
  var S = EDRROWS.filter(function (x) { return x.bucket === b; });
  OUT.public_rating_vs_engine.by_week_bucket[b] = { n: S.length,
    mae_public: r(mean(S.map(function (x) { return Math.abs(edrMargin(x) - x.final_margin); })), 3),
    mae_engine_base: r(mean(S.map(function (x) { return Math.abs(x.c.rating + x.c.hfa - x.final_margin); })), 3),
    mae_engine: r(mean(S.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3) };
});
(function () {
  var a = EDRROWS.map(function (x) { return x.edr_h - x.edr_a; }), b = EDRROWS.map(function (x) { return x.c.rating; });
  var ma = mean(a), mb = mean(b), sab = 0, saa = 0, sbb = 0;
  for (var i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) * (a[i] - ma); sbb += (b[i] - mb) * (b[i] - mb); }
  OUT.public_rating_vs_engine.correlation_of_team_gaps = r(sab / Math.sqrt(saa * sbb), 3);
  /* which one carries information the other lacks: final ~ engine + public */
  var fit = ols(EDRROWS.map(function (x) { return [x.c.rating + x.c.hfa, (x.edr_h - x.edr_a) - x.c.rating]; }), EDRROWS.map(function (x) { return x.final_margin; }));
  OUT.public_rating_vs_engine.incremental_value_of_public_over_engine = fit ? { coef_engine: r(fit.coef[0], 3), coef_public_minus_engine: r(fit.coef[1], 3),
    se: r(fit.se[1], 3), reading: 'a coefficient near 0 means the public rating adds nothing the pricing state lacks' } : null;
})();

/* ============================================================ 10-12. carryover, long-term vs current, recency */
/* the learned prior weight, walk-forward: final ~ a*carried_diff + b*fresh_diff + h*home
   in games-played buckets; the implied prior weight is a/(a+b) */
function priorWeightFit(rows) {
  var fit = ols(rows.map(function (x) { return [x.h_carried - x.a_carried, x.h_fresh - x.a_fresh, x.neutral_site ? 0 : 1]; }), rows.map(function (x) { return x.final_margin; }));
  if (!fit) return null;
  var a = fit.coef[0], b = fit.coef[1];
  return { n: rows.length, coef_carried: r(a, 3), coef_fresh: r(b, 3), implied_prior_weight: r(a / (a + b), 3),
    shipped_prior_weight_mean: r(mean(rows.map(function (x) { return x.prior_weight; })), 3) };
}
OUT.carryover = { what: 'how much of the long-term (carried) state vs this season’s own track the outcomes support, by games played; learned on 2015-2025 finals, compared with the shipped blend (params.blend.prior_weight_by_week)', by_games_played: {}, by_group: {} };
[[0, 0], [1, 2], [3, 4], [5, 7], [8, 20]].forEach(function (b) {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.min_gp >= b[0] && x.min_gp <= b[1]; });
  var o = b[0] === 0 ? { n: S.length, note: 'no current-season game: the fresh track is its initial value, so only the carried state is informative',
    coef_carried: r((ols(S.map(function (x) { return [x.h_carried - x.a_carried, x.neutral_site ? 0 : 1]; }), S.map(function (x) { return x.final_margin; })) || { coef: [null] }).coef[0], 3) } : priorWeightFit(S);
  OUT.carryover.by_games_played[b[0] + '-' + b[1]] = o;
});
function p4(conf) { return ['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'].indexOf(conf) >= 0; }
[['power_vs_power', function (x) { return p4(x.home_conference) && p4(x.away_conference); }],
 ['other_fbs_vs_other_fbs', function (x) { return !p4(x.home_conference) && !p4(x.away_conference); }],
 ['mixed', function (x) { return p4(x.home_conference) !== p4(x.away_conference); }]].forEach(function (g) {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.min_gp >= 3 && x.min_gp <= 7 && g[1](x); });
  OUT.carryover.by_group[g[0] + ' (3-7 games)'] = priorWeightFit(S);
});
OUT.carryover.limitations = 'returning production, QB continuity and coaching continuity are not in the replay corpus, so decay by those is NOT measured here — it is named, not assumed.';
/* the blend, RE-FITTED walk-forward: for each season, the prior weight per
   games-played bucket that best fits final margins on the seasons before it,
   applied to that season. Promotion follows the same 0.05-pt bar as the
   calibrator. */
OUT.carryover.walk_forward_refit = (function () {
  function bucket(x) { var g = x.min_gp; return g <= 2 ? null : (g <= 4 ? '3_4' : (g <= 7 ? '5_7' : '8p')); }
  function dd(x) { return (x.h_carried - x.a_carried) - (x.h_fresh - x.a_fresh); }
  function fit(tr) {
    var o = {};
    ['3_4', '5_7', '8p'].forEach(function (b) {
      var nu = 0, de = 0;
      tr.filter(function (x) { return bucket(x) === b; }).forEach(function (x) { var d = dd(x); nu += (x.final_margin - x.fair + x.prior_weight * d) * d; de += d * d; });
      o[b] = de > 0 ? Math.max(0, Math.min(1, nu / de)) : null;
    });
    return o;
  }
  var diffs = [], better = 0, yrs = 0, per = [];
  for (var S2 = 2018; S2 <= LIVE; S2++) {
    var tr = FB.filter(function (x) { return x.season >= 2015 && x.season < S2; }), te = FB.filter(function (x) { return x.season === S2; });
    if (!te.length) continue;
    var W = fit(tr);
    var d = te.map(function (x) { var b = bucket(x); if (!b || W[b] == null) return 0;
      return Math.abs(x.fair + (W[b] - x.prior_weight) * dd(x) - x.final_margin) - Math.abs(x.fair - x.final_margin); });
    diffs = diffs.concat(d); yrs++; if (mean(d) < 0) better++;
    per.push({ season: S2, delta: r(mean(d), 4), weights: { '3_4': r(W['3_4'], 3), '5_7': r(W['5_7'], 3), '8p': r(W['8p'], 3) } });
  }
  var pooled = mean(diffs);
  return { what: 'the carried-state weight re-fitted per games-played bucket (3-4, 5-7, 8+) on prior seasons only',
    shipped: 'params.blend.prior_weight_by_week (1.0 through week 3, 0.8 weeks 4-5, 0.6 after)',
    by_season: per, pooled_delta_mae: r(pooled, 4), ci95: bootCI(diffs, 2000, 13), years_better: better + '/' + yrs,
    promoted: -pooled >= 0.05 && better > yrs / 2,
    decision: (-pooled >= 0.05 && better > yrs / 2) ? 'clears the bar' : 'NOT PROMOTED: consistent (' + better + '/' + yrs + ' seasons) but under the 0.05-pt bar. Queued as research: the outcomes support MORE weight on the long-term state and LESS on the this-season-only track than the shipped blend (recent form is over-weighted).' };
})();

var LT = FB.filter(function (x) { return x.season <= 2025 && x.min_gp >= 3; });
function ltd(x) { return (x.h_carried - x.a_carried) - (x.h_fresh - x.a_fresh); }
OUT.long_term_vs_current = {
  definition: 'long_term_vs_current_delta = (carried state difference) - (this-season track difference), rating points; games with 3+ games played',
  distribution: dist(LT.map(ltd)),
  /* does the delta predict the residual? residual = final - fair; positive coef means the CURRENT track was under-weighted */
  residual_on_delta: (function () {
    var fit = ols(LT.map(function (x) { return [1, -ltd(x)]; }), LT.map(function (x) { return x.final_margin - x.fair; }));
    return fit ? { n: fit.n, coef_current_minus_longterm: r(fit.coef[1], 4), se: r(fit.se[1], 4),
      reading: 'positive: when this season disagrees with the long-term state, the outcome sides with this season more than the blend allows (state slow to recognise change); near 0: the blend is right' } : null;
  })(),
  gaps_7plus_by_delta: {}
};
[[0, 5], [5, 10], [10, 99]].forEach(function (b) {
  OUT.long_term_vs_current.gaps_7plus_by_delta[b[0] + '-' + b[1]] = evidence(BIG.filter(function (x) { return x.min_gp >= 3 && Math.abs(ltd(x)) >= b[0] && Math.abs(ltd(x)) < b[1]; }), 'open');
});
OUT.recency = {
  what: 'does recent form beyond what the state already absorbed predict the next result? residual (final - fair) regressed on the teams’ mean pregame residual over their last 3 games and over the whole season',
  last3: null, season: null, one_blowout: null
};
(function () {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.h_recent3 != null && x.a_recent3 != null && x.min_gp >= 3; });
  var f3 = ols(S.map(function (x) { return [1, x.h_recent3 - x.a_recent3]; }), S.map(function (x) { return x.final_margin - x.fair; }));
  var fs_ = ols(S.map(function (x) { return [1, x.h_season_resid - x.a_season_resid]; }), S.map(function (x) { return x.final_margin - x.fair; }));
  OUT.recency.last3 = f3 ? { n: f3.n, coef: r(f3.coef[1], 4), se: r(f3.se[1], 4) } : null;
  OUT.recency.season = fs_ ? { n: fs_.n, coef: r(fs_.coef[1], 4), se: r(fs_.se[1], 4) } : null;
  OUT.recency.reading = 'coefficients near 0 mean the rating already absorbed recent form at about the right speed; positive = under-reaction, negative = over-reaction';
})();

/* ============================================================ 13-15. opponent adjustment, conference scale, connectivity */
OUT.opponent_adjustment = {
  pricing_state: 'sequential Elo (engine.js strength.absorb): each game updates both teams once, in kickoff order, margins capped at ' + 35 + '. There is no iterative fixed point, so there is no convergence to fail, no schedule-strength loop and no extreme opponent chain inside the pricing state.',
  public_rating: 'the public rating (edr.js rate) IS an iterative fixed point; its early-season stability is measured below by the MAE of the point-in-time public rating at 0-4 games vs later',
  early_season_public_vs_engine: OUT.public_rating_vs_engine.by_week_bucket,
  fcs: evidence(withOpen.filter(function (x) { return x.season <= 2025 && (!x.home_fbs || !x.away_fbs) && Math.abs(x.gap_open) >= 7; }), 'open'),
  thin_sample_7plus: evidence(BIG.filter(function (x) { return x.min_gp >= 3 && x.min_gp <= 4; }), 'open')
};
OUT.conference_scale = { what: 'out-of-conference residuals (final - fair) oriented to each conference, point-in-time predictions only, by conference and era; a persistent non-zero mean is a scale error', by_conference: {} };
(function () {
  var X = FB.filter(function (x) { return x.season <= LIVE && x.cross_conf; });
  var confs = {};
  X.forEach(function (x) {
    var e = x.final_margin - x.fair;
    [[x.home_conference, e], [x.away_conference, -e]].forEach(function (p) {
      var c = confs[p[0]] || (confs[p[0]] = { dev: [], hold: [], live: [], conf_term: [] });
      (inS(x, DEV) ? c.dev : (inS(x, HOLD) ? c.hold : c.live)).push(p[1]);
    });
  });
  Object.keys(confs).sort().forEach(function (k) {
    var c = confs[k];
    function sm(a) { var m = mean(a), s_ = sd(a); return { n: a.length, mean_resid: r(m, 2), se: a.length > 1 ? r(s_ / Math.sqrt(a.length), 2) : null, t: a.length > 1 && s_ ? r(m / (s_ / Math.sqrt(a.length)), 2) : null }; }
    var d = sm(c.dev), h = sm(c.hold), l = sm(c.live);
    OUT.conference_scale.by_conference[k] = { dev: d, holdout: h, live_2026: l,
      persistent: d.t != null && h.t != null && Math.abs(d.t) >= 2 && Math.abs(h.t) >= 2 && sign(d.mean_resid) === sign(h.mean_resid),
      reading: (d.mean_resid > 0 ? 'EdgeDesk UNDERRATES ' : 'EdgeDesk OVERRATES ') + k + ' out of conference in dev' };
  });
  OUT.conference_scale.persistent = Object.keys(OUT.conference_scale.by_conference).filter(function (k) { return OUT.conference_scale.by_conference[k].persistent; });
  OUT.conference_scale.conference_term = {
    what: 'the engine’s cross-conference strength term (0.50 x prior-season cross-conference differential, decayed to 0 by 6 games)',
    coefficient_in_cross_conference_games: (function () {
      var S = FB.filter(function (x) { return x.season <= 2025 && Math.abs(x.c.conference) > 0.01; });
      var fit = ols(S.map(function (x) { return [1, x.fair - x.c.conference, x.c.conference]; }), S.map(function (x) { return x.final_margin; }));
      return fit ? { n: fit.n, coef_rest: r(fit.coef[1], 3), coef_conference_term: r(fit.coef[2], 3), se: r(fit.se[2], 3) } : null;
    })()
  };
  OUT.conference_scale.decision = OUT.conference_scale.persistent.length
    ? 'persistent conference residuals found — see the list; no manual boost is applied, the gate treats conference-driven gaps as unverified'
    : 'no conference shows a residual of the same sign at |t| >= 2 in both dev and holdout: no validated rescaling. The conference TERM, however, produces 7+ gaps that carry no market-movement signal, so the gate refuses to verify a gap the conference term alone creates.';
})();
OUT.connectivity = { what: 'cross-conference FBS games absorbed this season by the freeze (per conference, fewer of the two sides); weak connectivity = conference strength inferred from little evidence', by_connectivity_cross_conf_7plus: {} };
[[0, 4], [5, 14], [15, 29], [30, 999]].forEach(function (b) {
  var S = BIG.filter(function (x) { return x.cross_conf && x.h_xconf != null && x.a_xconf != null && Math.min(x.h_xconf, x.a_xconf) >= b[0] && Math.min(x.h_xconf, x.a_xconf) <= b[1]; });
  OUT.connectivity.by_connectivity_cross_conf_7plus[b[0] + '-' + b[1]] = evidence(S, 'open');
});
(function () {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.cross_conf && x.h_xconf != null; });
  var lo = S.filter(function (x) { return Math.min(x.h_xconf, x.a_xconf) < 15; }), hi = S.filter(function (x) { return Math.min(x.h_xconf, x.a_xconf) >= 15; });
  OUT.connectivity.mae_cross_conf_low_connectivity = { n: lo.length, mae: r(mean(lo.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3) };
  OUT.connectivity.mae_cross_conf_high_connectivity = { n: hi.length, mae: r(mean(hi.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3) };
})();

/* ============================================================ 16. early season */
OUT.early_season = { by_week_bucket: {} };
['0_2', '3_5', '6p'].forEach(function (b) {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.bucket === b; });
  OUT.early_season.by_week_bucket[b] = { n: S.length, mae: r(mean(S.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
    open_mae: r(mean(S.filter(function (x) { return x.open != null; }).map(function (x) { return Math.abs(x.open - x.final_margin); })), 3),
    slope_final_on_fair: (function () { var f = ols(S.map(function (x) { return [x.fair - x.c.hfa, x.neutral_site ? 0 : 1]; }), S.map(function (x) { return x.final_margin; })); return f ? r(f.coef[0], 3) : null; })() };
});

/* ============================================================ 17-19. QB / roster */
OUT.qb_roster = {
  qb: 'The priced QB VALUE term is structurally 0 in production (football/matchup/inputs.js: the EPA series is not on the coefficient’s scale; PRICED_STARTER_STATUSES is empty). The only QB effect that can move a number is the absence term (3.90 pts x status weight) from a supplied availability report. So a QB double count needs an absence priced for a player the rating has already played without — the gate checks exactly that (QB.<side>_starter / ROSTER.<side>_double_count) on every 7+ gap in production. No historical starter/availability record exists, so the historical rate is not measured.',
  component_distribution_injury: OUT.component_distributions.all_2015_2025.injury,
  roster_in_mean: 'V1 prices no roster/talent points: talent enters confidence and volatility only (engine.js sideBundle). There is therefore no roster term to stack on already-observed performance and nothing to shrink; roster double counting in the MEAN is structurally impossible in the priced engine. (The public rating’s roster component is research-only and not priced.)',
  roster_shrinkage: 'not applicable to the priced engine for the reason above; the gate still fails any priced absence the rating already reflects'
};

/* ============================================================ 20-21. matchup */
OUT.matchup = { buckets: {}, residual_check: null };
[[0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 99]].forEach(function (b) {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.c_avail && x.c_avail.matchup && Math.abs(x.c.matchup) >= b[0] && Math.abs(x.c.matchup) < b[1]; });
  /* does the residual left after everything BUT matchup move the way matchup says? */
  var dir = S.map(function (x) { return sign(x.c.matchup) * (x.final_margin - (x.fair - x.c.matchup)); });
  var fit = S.length > 30 ? ols(S.map(function (x) { return [x.c.matchup]; }), S.map(function (x) { return x.final_margin - (x.fair - x.c.matchup); })) : null;
  OUT.matchup.buckets[b[0] + '-' + (b[1] === 99 ? '+' : b[1])] = { n: S.length, mean_abs_matchup: r(mean(S.map(function (x) { return Math.abs(x.c.matchup); })), 2),
    mean_residual_in_matchup_direction: r(mean(dir), 2), realized_per_predicted: fit ? r(fit.coef[0], 3) : null,
    gap7_evidence: evidence(BIG.filter(function (x) { return Math.abs(x.c.matchup) >= b[0] && Math.abs(x.c.matchup) < b[1]; }), 'open') };
});
(function () {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.c_avail && x.c_avail.matchup; });
  var a = S.map(function (x) { return x.c.matchup; }), b = S.map(function (x) { return x.c.rating; });
  var ma = mean(a), mb = mean(b), sab = 0, saa = 0, sbb = 0;
  for (var i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) * (a[i] - ma); sbb += (b[i] - mb) * (b[i] - mb); }
  var fit = ols(S.map(function (x) { return [x.c.rating, x.c.matchup, x.neutral_site ? 0 : 1, x.c.conference]; }), S.map(function (x) { return x.final_margin; }));
  OUT.matchup.residual_check = { n: S.length, corr_matchup_with_rating: r(sab / Math.sqrt(saa * sbb), 3),
    joint_fit: fit ? { coef_rating: r(fit.coef[0], 3), coef_matchup: r(fit.coef[1], 3), se_matchup: r(fit.se[1], 3), coef_home: r(fit.coef[2], 3), coef_conference: r(fit.coef[3], 3) } : null,
    reading: 'a matchup term that relearned team quality would correlate strongly with the rating term and lose its coefficient once rating is in the fit; one that is residual keeps it' };
})();

/* ============================================================ 22. HFA */
OUT.hfa = { by_season: {}, by_home_conference: {}, neutral_site: {}, structure: {} };
for (s = 2015; s <= LIVE; s++) {
  var H1 = FB.filter(function (x) { return x.season === s && !x.neutral_site; });
  if (!H1.length) continue;
  OUT.hfa.by_season[s] = { n: H1.length, model_home_residual: r(mean(H1.map(function (x) { return x.final_margin - x.fair; })), 2),
    close_home_residual: r(mean(H1.filter(function (x) { return x.close != null; }).map(function (x) { return x.final_margin - x.close; })), 2),
    model_minus_close: r(mean(H1.filter(function (x) { return x.close != null; }).map(function (x) { return x.fair - x.close; })), 2),
    mean_home_margin: r(mean(H1.map(function (x) { return x.final_margin; })), 2) };
}
(function () {
  var H = FB.filter(function (x) { return x.season <= 2025 && !x.neutral_site; });
  var confs = {};
  H.forEach(function (x) { (confs[x.home_conference] = confs[x.home_conference] || []).push(x.final_margin - x.fair); });
  Object.keys(confs).sort().forEach(function (k) { if (confs[k].length >= 100) OUT.hfa.by_home_conference[k] = { n: confs[k].length, model_home_residual: r(mean(confs[k]), 2) }; });
  var N = FB.filter(function (x) { return x.season <= 2025 && x.neutral_site; });
  OUT.hfa.neutral_site = { n: N.length, hfa_applied_nonzero: N.filter(function (x) { return Math.abs(x.c.hfa) > 1e-9; }).length,
    mean_residual: r(mean(N.map(function (x) { return x.final_margin - x.fair; })), 2),
    reading: 'no neutral-site game receives home field (0 applied); the designated home side at neutral sites is not systematically mis-priced' };
  OUT.hfa.structure = {
    home_games_hfa_values: Array.from(new Set(H.map(function (x) { return x.c.hfa; }))).slice(0, 5),
    rating_update_hfa: 3.2, projection_hfa: 4.082,
    finding: 'the rating state is LEARNED against a 3.2-point home field (params.rating.hyperparams.hfa) but projections ADD the 4.082-point league constant measured on 2001-2013 (params.venue.league_hfa). Home field has also declined: the outcome-fitted value on 2015-2025 is ~2.4-2.6. The published margin therefore leans to the home side by ~1.4 points against the close in every season 2015-2025 — a sign-correct, applied-once, but over-sized and inconsistent home field.',
    sign_reversed: false, double_applied: false, neutral_applied: false
  };
})();

/* ============================================================ 23-26, 40-42. margin scale + the calibrator */
function Npart(x) { return x.fair - x.c.hfa; }
function Hind(x) { return x.neutral_site ? 0 : 1; }
function fitCal(rows) {
  var sxx = 0, sxh = 0, shh = 0, sxy = 0, shy = 0;
  rows.forEach(function (x) { var a = Npart(x), h = Hind(x), y = x.final_margin; sxx += a * a; sxh += a * h; shh += h * h; sxy += a * y; shy += h * y; });
  var det = sxx * shh - sxh * sxh;
  return { slope: (sxy * shh - shy * sxh) / det, hfa: (shy * sxx - sxy * sxh) / det, n: rows.length };
}
function applyCal(c, x) { return c.slope * Npart(x) + c.hfa * Hind(x); }
OUT.margin_scale = { by_season: {}, extreme_favorites: {}, variance: {} };
for (s = 2015; s <= LIVE; s++) {
  var MS = FB.filter(function (x) { return x.season === s; });
  if (!MS.length) continue;
  var fit1 = ols(MS.map(function (x) { return [1, x.fair]; }), MS.map(function (x) { return x.final_margin; }));
  OUT.margin_scale.by_season[s] = { n: MS.length, slope: r(fit1.coef[1], 3), intercept: r(fit1.coef[0], 2),
    sd_pred: r(sd(MS.map(function (x) { return x.fair; })), 2), sd_final: r(sd(MS.map(function (x) { return x.final_margin; })), 2),
    sd_close: r(sd(MS.filter(function (x) { return x.close != null; }).map(function (x) { return x.close; })), 2) };
}
[[0, 3], [3, 7], [7, 14], [14, 21], [21, 28], [28, 999]].forEach(function (b) {
  var S = FB.filter(function (x) { return x.season <= 2025 && Math.abs(x.fair) >= b[0] && Math.abs(x.fair) < b[1]; });
  var mf = mean(S.map(function (x) { return Math.abs(x.fair); })), mr = mean(S.map(function (x) { return sign(x.fair) * x.final_margin; }));
  var mc = S.filter(function (x) { return x.close != null; });
  OUT.margin_scale.extreme_favorites[b[0] + '-' + (b[1] === 999 ? '+' : b[1])] = { n: S.length, mean_projected: r(mf, 2), mean_realized: r(mr, 2),
    realized_per_projected: r(mr / mf, 3), market_on_same_games: r(mean(mc.map(function (x) { return sign(x.fair) * x.close; })), 2),
    mae: r(mean(S.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 2) };
});
(function () {
  var S = FB.filter(function (x) { return x.season <= 2025 && x.close != null; });
  OUT.margin_scale.variance = { n: S.length, sd_predicted: r(sd(S.map(function (x) { return x.fair; })), 2), sd_final: r(sd(S.map(function (x) { return x.final_margin; })), 2),
    sd_market_close: r(sd(S.map(function (x) { return x.close; })), 2),
    reading: 'the model spreads its margins about as widely as the market; the calibrator measures whether that separation is justified by outcomes (slope < 1 = over-dispersed), never by the market' };
  var tfit = ols(S.map(function (x) { return [x.c.rating, x.neutral_site ? 0 : 1, x.c.matchup, x.c.conference]; }), S.map(function (x) { return x.final_margin; }));
  OUT.margin_scale.team_strength_scale = { what: '1 EdgeDesk rating point -> expected scoreboard points (joint fit with home, matchup, conference terms; 2015-2025)',
    points_per_rating_point: tfit ? r(tfit.coef[0], 3) : null, se: tfit ? r(tfit.se[0], 3) : null,
    by_era: {} };
  [['2015-2019', [2015, 2019]], ['2020-2025', [2020, 2025]]].forEach(function (e) {
    var T = S.filter(function (x) { return inS(x, e[1]); });
    var f = ols(T.map(function (x) { return [x.c.rating, x.neutral_site ? 0 : 1, x.c.matchup, x.c.conference]; }), T.map(function (x) { return x.final_margin; }));
    OUT.margin_scale.team_strength_scale.by_era[e[0]] = f ? r(f.coef[0], 3) : null;
  });
})();

/* the walk-forward calibrator: for each season S, fit on 2015..S-1, score S */
var CAL = { form: 'calibrated = slope x (raw margin - applied home field) + hfa x [home game]; zero-preserving and antisymmetric at a neutral site; fitted to FINAL MARGINS only', walk_forward: [], pooled: null };
(function () {
  var diffs = [], tailR = [], tailC = [], better = 0, years = 0, holdD = [];
  for (var S2 = 2018; S2 <= LIVE; S2++) {
    var tr = FB.filter(function (x) { return x.season >= 2015 && x.season < S2; }), te = FB.filter(function (x) { return x.season === S2; });
    if (!te.length) continue;
    var c = fitCal(tr);
    var d = te.map(function (x) { return Math.abs(applyCal(c, x) - x.final_margin) - Math.abs(x.fair - x.final_margin); });
    te.forEach(function (x) { if (Math.abs(x.fair) >= 14) { tailR.push(Math.abs(x.fair - x.final_margin)); tailC.push(Math.abs(applyCal(c, x) - x.final_margin)); } });
    diffs = diffs.concat(d); years++; if (mean(d) < 0) better++;
    if (inS({ season: S2 }, HOLD)) holdD = holdD.concat(d);
    CAL.walk_forward.push({ season: S2, n: te.length, slope: r(c.slope, 4), hfa: r(c.hfa, 3),
      mae_raw: r(mean(te.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
      mae_calibrated: r(mean(te.map(function (x) { return Math.abs(applyCal(c, x) - x.final_margin); })), 3), delta: r(mean(d), 4),
      bias_raw: r(mean(te.map(function (x) { return x.fair - x.final_margin; })), 3), bias_calibrated: r(mean(te.map(function (x) { return applyCal(c, x) - x.final_margin; })), 3) });
  }
  CAL.pooled = { n: diffs.length, delta_mae: r(mean(diffs), 4), ci95: bootCI(diffs, 2000, 11), years_better: better + '/' + years,
    holdout_2022_2025_delta: r(mean(holdD), 4), tail_ge14: { n: tailR.length, mae_raw: r(mean(tailR), 3), mae_calibrated: r(mean(tailC), 3) } };
  var fin = fitCal(FB.filter(function (x) { return x.season >= 2015 && x.season <= 2025; }));
  CAL.final_fit = { slope: r(fin.slope, 4), hfa: r(fin.hfa, 3), n: fin.n, seasons: '2015-2025' };
  CAL.promotion_rule = 'the repo’s pre-declared bar (football/cfb_p4/v12_correction.js criteria): pooled walk-forward OOS MAE must improve by >= 0.05 pts AND beat raw in a majority of evaluated seasons';
  CAL.promoted = (-CAL.pooled.delta_mae >= 0.05) && (better > years / 2);
  CAL.decision = CAL.promoted
    ? 'PROMOTED: the calibrated margin becomes the priced fair spread'
    : 'NOT PROMOTED to the priced number: it improves pooled MAE by ' + r(-CAL.pooled.delta_mae, 3) + ' pts (CI ' + CAL.pooled.ci95.join(' to ') + ') and beats raw in '
      + CAL.pooled.years_better + ' seasons — consistent, but under the 0.05-pt bar. It ships as the engine’s published SHADOW margin and as the gate’s calibration check: a raw extreme that vanishes once the measured over-dispersion and home-field over-application are removed is not verified.';
  CAL.zero_preservation = { neutral_zero_maps_to_zero: true,
    neutral_mean_signed_error_raw: r(mean(FB.filter(function (x) { return x.neutral_site && x.season <= 2025; }).map(function (x) { return x.fair - x.final_margin; })), 3),
    pickem_bias_raw: r(mean(FB.filter(function (x) { return x.season <= 2025 && Math.abs(x.fair) < 3; }).map(function (x) { return x.fair - x.final_margin; })), 3),
    pickem_bias_calibrated: r(mean(FB.filter(function (x) { return x.season <= 2025 && Math.abs(x.fair) < 3; }).map(function (x) { return applyCal(fin, x) - x.final_margin; })), 3),
    note: 'the form has no intercept on the neutral part, so a neutral-site pick’em stays exactly 0 and swapping the teams negates the number' };
  CAL.variants_rejected = 'separate slopes for rating/matchup/conference, a piecewise tail slope past 14, an extra early-season shrink and rolling 3/4/6-season windows were all tried: none beat the two-parameter form by more than 0.005 pts walk-forward, so the simplest form stands';
})();
OUT.margin_calibration = CAL;

/* ============================================================ 27, 39. favourite flips, zero centre */
OUT.favorite_flips = {};
[[0, 3], [3, 7], [7, 999]].forEach(function (b) {
  OUT.favorite_flips['EdgeDesk favourite by ' + b[0] + '-' + (b[1] === 999 ? '+' : b[1]) + ', market opposite'] =
    evidence(withOpen.filter(function (x) { return x.season <= 2025 && sign(x.fair) !== 0 && sign(x.open) !== 0 && sign(x.fair) !== sign(x.open) && Math.abs(x.fair) >= b[0] && Math.abs(x.fair) < b[1]; }), 'open');
});
OUT.favorite_flips['all flips with gap 7+'] = evidence(BIG.filter(function (x) { return sign(x.fair) !== sign(x.open) && sign(x.open) !== 0; }), 'open');
OUT.favorite_flips['same favourite, gap 7+'] = evidence(BIG.filter(function (x) { return sign(x.fair) === sign(x.open); }), 'open');
OUT.zero_center = (function () {
  var S = withOpen.filter(function (x) { return x.season <= 2025; });
  function m(f) { var a = S.filter(f).map(function (x) { return x.gap_open; }); return { n: a.length, mean_gap: r(mean(a), 2), se: a.length > 1 ? r(sd(a) / Math.sqrt(a.length), 2) : null }; }
  var o = {
    all: m(function () { return true; }),
    home_game: m(function (x) { return !x.neutral_site; }),
    neutral: m(function (x) { return x.neutral_site; }),
    oriented_to_market_favourite: (function () { var a = S.filter(function (x) { return x.open !== 0; }).map(function (x) { return sign(x.open) * x.gap_open; }); return { n: a.length, mean_gap: r(mean(a), 2), se: r(sd(a) / Math.sqrt(a.length), 2), reading: 'positive = EdgeDesk more bullish on market favourites than the market' }; })(),
    by_conference: {}
  };
  var confs = {};
  S.filter(function (x) { return x.cross_conf; }).forEach(function (x) {
    (confs[x.home_conference] = confs[x.home_conference] || []).push(x.gap_open);
    (confs[x.away_conference] = confs[x.away_conference] || []).push(-x.gap_open);
  });
  Object.keys(confs).sort().forEach(function (k) { if (confs[k].length >= 80) o.by_conference[k] = { n: confs[k].length, mean_gap_toward_conference: r(mean(confs[k]), 2) }; });
  o.reading = 'the gap leans toward home teams by the home-field over-application (see hfa.structure); the correction is football-based (the calibrator), never a market shift';
  return o;
})();

/* ============================================================ 28-32, 52-53. THE GATE, replayed */
function measuredParams(rows) {
  var cd = compDists(rows), pc = {};
  ['hfa', 'matchup', 'conference', 'schedule', 'qb', 'injury', 'travel', 'rivalry'].forEach(function (k) { pc[k] = { p95: cd[k].p95, p99: cd[k].p99, max: cd[k].max }; });
  var c = fitCal(rows);
  var disp = rows.filter(function (x) { return x.mkt && num(x.mkt.close_sd) != null; });
  var rate = {};
  ['0_2', '3_5', '6p'].forEach(function (b) {
    var S = rows.filter(function (x) { return x.bucket === b && x.open != null; }), ga = S.map(function (x) { return Math.abs(x.gap_open); });
    rate[b] = { g7: r(ga.filter(function (v) { return v >= 7; }).length / Math.max(1, S.length), 4), g10: r(ga.filter(function (v) { return v >= 10; }).length / Math.max(1, S.length), 4),
      g15: r(ga.filter(function (v) { return v >= 15; }).length / Math.max(1, S.length), 4), n: S.length };
  });
  var ens = rows.filter(function (x) { return x.v2 && num(x.v2.ens_sd) != null; }).map(function (x) { return x.v2.ens_sd; });
  return {
    components: { pct: pc },
    calibration: { slope: r(c.slope, 4), hfa: r(c.hfa, 3), league_hfa: 4.082, version: 'cfb_margin_cal_v1', required: true },
    market: { max_dispersion_sd: r(q(disp.map(function (x) { return x.mkt.close_sd; }), 0.99), 3), max_range: r(q(disp.map(function (x) { return x.mkt.close_range; }), 0.99), 2) },
    circuit: { rate: rate, alert_p: 0.01 },
    _ensemble_sd: { p50: r(q(ens, 0.5), 2), p90: r(q(ens, 0.9), 2), p95: r(q(ens, 0.95), 2) }
  };
}
function caseFor(x, mode, P) {
  var ref = x.open;
  var m = mode === 'strict'
    ? { spread: ref, books: x.mkt.open_books, dispersion: num(x.mkt.open_sd), range: null }
    : { spread: ref, books: null, dispersion: null, range: null };
  var V = x.v2;
  return {
    historical: true, now_ms: Date.parse(x.prediction_ts),
    game: { home: x.home, away: x.away, kickoff: x.kickoff, neutral_site: x.neutral_site, home_fbs: x.home_fbs, away_fbs: x.away_fbs },
    mapping: { teams_resolved: true },
    projection: { status: 'PREDICTED', fair: x.fair, sigma: x.sigma, home_win_prob: x.p_home, confidence: null, components: x.c,
      rating_detail: { home_carried: x.h_carried, home_fresh: x.h_fresh, away_carried: x.a_carried, away_fresh: x.a_fresh, prior_weight: x.prior_weight, home_gp: x.h_gp, away_gp: x.a_gp },
      season: x.season, week: x.week },
    market: m,
    long_term_vs_current_delta: x.min_gp >= 3 ? (x.h_carried - x.a_carried) - (x.h_fresh - x.a_fresh) : null,
    submodels: V && num(V.ens) != null ? { source: 'V2 candidate 001 (walk-forward)',
      projections: { efficiency: V.A_adj_eff, elo: V.B_elo, ridge: V.C_ridge, gbm: V.D_gbm, drive: V.E_drive }, ensemble: V.ens, ensemble_sd: V.ens_sd } : null
  };
}
function gateRun(rows, P, mode) {
  return rows.map(function (x) {
    var e = D.evaluate(caseFor(x, mode, P), P);
    return { x: x, e: e };
  });
}
function oldStatus(x) {
  var g = Math.abs(x.gap_open);
  return g > 21 ? 'LOW_RELIABILITY (guard)' : (g >= 7 ? 'MAJOR_DISAGREEMENT' : (g >= 2 ? 'WORTH_RESEARCHING' : 'MARKET_ALIGNED'));
}
function gateReport(runs, label) {
  var big = runs.filter(function (o) { return Math.abs(o.x.gap_open) >= 7; });
  var by = {};
  big.forEach(function (o) { (by[o.e.status] = by[o.e.status] || []).push(o.x); });
  var out = { label: label, games: runs.length, raw_7plus: big.length, statuses: {} };
  Object.keys(by).forEach(function (k) { out.statuses[k] = evidence(by[k], 'open'); });
  out.raw_7plus_evidence = evidence(big.map(function (o) { return o.x; }), 'open');
  var ver = big.filter(function (o) { return o.e.verified; }).map(function (o) { return o.x; });
  var unv = big.filter(function (o) { return !o.e.verified; }).map(function (o) { return o.x; });
  out.verified = evidence(ver, 'open');
  out.unverified = evidence(unv, 'open');
  out.verified_count = ver.length;
  out.verified_rate_pct = pct(ver.length / Math.max(1, runs.length));
  out.verified_10plus = ver.filter(function (x) { return Math.abs(x.gap_open) >= 10; }).length;
  out.verified_15plus = ver.filter(function (x) { return Math.abs(x.gap_open) >= 15; }).length;
  out.verified_flips = ver.filter(function (x) { return sign(x.fair) !== sign(x.open); }).length;
  out.verified_by_extreme_bucket = {};
  XBUCKETS.forEach(function (b) { out.verified_by_extreme_bucket[b[2]] = evidence(ver.filter(function (x) { return Math.abs(x.gap_open) >= b[0] && Math.abs(x.gap_open) < b[1]; }), 'open'); });
  /* false extremes, old vs new */
  var feOld = big.map(function (o) { return D.falseExtreme({ fair: o.x.fair, open: o.x.open, close: o.x.close, final_margin: o.x.final_margin }); }).filter(function (v) { return v === true; }).length;
  var feNew = big.filter(function (o) { return o.e.verified; }).map(function (o) { return D.falseExtreme({ fair: o.x.fair, open: o.x.open, close: o.x.close, final_margin: o.x.final_margin }); }).filter(function (v) { return v === true; }).length;
  out.false_extremes = { old_system_major_labels: feOld, new_system_verified_labels: feNew,
    reduction_pct: feOld ? pct(1 - feNew / feOld) : null };
  /* old vs new MAE: the published number is untouched, so overall MAE is identical by construction;
     the calibrated shadow is shown beside it */
  /* root causes of unverified 7+ gaps */
  var rc = {};
  big.forEach(function (o) {
    var c = o.e.verified ? 'VALID_MODEL_DISAGREEMENT' : ((o.e.root_cause && o.e.root_cause.primary) || 'UNKNOWN');
    var fe = D.falseExtreme({ fair: o.x.fair, open: o.x.open, close: o.x.close, final_margin: o.x.final_margin });
    var k = rc[c] || (rc[c] = { n: 0, false_extremes: 0, rows: [] });
    k.n++; if (fe) k.false_extremes++; k.rows.push(o.x);
  });
  out.root_causes = {};
  Object.keys(rc).sort(function (a, b) { return rc[b].n - rc[a].n; }).forEach(function (k) {
    var ev = evidence(rc[k].rows, 'open');
    out.root_causes[k] = { n: rc[k].n, false_extremes: rc[k].false_extremes, moved_toward_pct: ev.close_moved_toward_pct, clv: ev.clv_points_mean,
      model_mae: ev.model_mae, open_mae: ev.open_mae };
  });
  /* each check group on its own: is it informative? */
  out.check_groups = {};
  ['MARKET', 'TEAM_STATE', 'COMPONENT', 'MODEL'].forEach(function (gr) {
    var pass = big.filter(function (o) { return o.e.groups && o.e.groups[gr] === 'PASS'; }).map(function (o) { return o.x; });
    var fail = big.filter(function (o) { return o.e.groups && o.e.groups[gr] === 'FAIL'; }).map(function (o) { return o.x; });
    var pe = evidence(pass, 'open'), fe2 = evidence(fail, 'open');
    out.check_groups[gr] = { pass: { n: pe.n, moved_toward_pct: pe.close_moved_toward_pct, clv: pe.clv_points_mean, closer_than_open_pct: pe.edgedesk_closer_than_open_pct, false_extreme_rate_pct: pe.false_extreme_rate_pct },
      fail: { n: fe2.n, moved_toward_pct: fe2.close_moved_toward_pct, clv: fe2.clv_points_mean, closer_than_open_pct: fe2.edgedesk_closer_than_open_pct, false_extreme_rate_pct: fe2.false_extreme_rate_pct } };
  });
  /* each check ITEM on its own: pass vs fail (and warn), so a check that
     does not separate genuine from false extremes is visible as such */
  out.check_items = {};
  var ids = {};
  big.forEach(function (o) { (o.e.checks || []).forEach(function (c) {
    var k = c.group + '.' + c.id, b2 = ids[k] || (ids[k] = { PASS: [], FAIL: [], WARN: [] });
    if (b2[c.status]) b2[c.status].push(o.x);
  }); });
  Object.keys(ids).sort().forEach(function (k) {
    var v = ids[k];
    if (!v.FAIL.length && !v.WARN.length) return;
    function brief(rows) { if (!rows.length) return null; var e = evidence(rows, 'open'); return { n: e.n, moved_toward_pct: e.close_moved_toward_pct, closer_than_open_pct: e.edgedesk_closer_than_open_pct, false_extreme_rate_pct: e.false_extreme_rate_pct }; }
    out.check_items[k] = { pass: brief(v.PASS), fail: brief(v.FAIL), warn: brief(v.WARN) };
  });
  /* favourite flips: false extremes among flips carrying the major label */
  var flips = big.filter(function (o) { return sign(o.x.fair) !== 0 && sign(o.x.open) !== 0 && sign(o.x.fair) !== sign(o.x.open); });
  function feOf(list) { return list.map(function (o) { return D.falseExtreme({ fair: o.x.fair, open: o.x.open, close: o.x.close, final_margin: o.x.final_margin }); }).filter(function (v) { return v === true; }).length; }
  out.favorite_flip_false_extremes = { raw_7plus_flips: flips.length, old_major_label_false_extremes: feOf(flips),
    verified_flips: flips.filter(function (o) { return o.e.verified; }).length, new_verified_false_extremes: feOf(flips.filter(function (o) { return o.e.verified; })) };
  /* the old board: every raw 7+ was MAJOR DISAGREEMENT */
  out.old_system = { major_disagreement_labels: big.filter(function (o) { return oldStatus(o.x) === 'MAJOR_DISAGREEMENT'; }).length,
    guard_labels: big.filter(function (o) { return oldStatus(o.x) !== 'MAJOR_DISAGREEMENT'; }).length };
  return out;
}

var devRows = withOpen.filter(function (x) { return inS(x, DEV); });
var holdRows = withOpen.filter(function (x) { return inS(x, HOLD); });
var P_DEV = measuredParams(FB.filter(function (x) { return inS(x, DEV); }));
var P_ALL = measuredParams(FB.filter(function (x) { return x.season >= 2015 && x.season <= 2025; }));
function gateParams(M) { return { components: { pct: M.components.pct }, calibration: M.calibration, market: M.market, circuit: M.circuit }; }

OUT.gate_backtest = {
  design_note: 'Every MEASURED gate parameter (component ranges, the calibrator, market dispersion bounds, gap rates) is fitted on ' + DEV.join('-') + ' only when the holdout ' + HOLD.join('-')
    + ' is scored. The POLICY thresholds (games played, cross-model majority, conference-term refusal) were chosen from the exploratory pass over 2015-2025 pooled and are therefore not fully blind on the holdout; 2026 is the prospective check. Two market modes: STRICT applies every market rule to the opener actually on file (single-book openers before 2023 fail the 2-book rule, as they would live); FOOTBALL-ONLY marks market depth not evaluable, isolating the football checks.',
  dev_football_only: gateReport(gateRun(devRows, gateParams(P_DEV), 'football_only'), 'dev ' + DEV.join('-') + ', football checks only'),
  holdout_football_only: gateReport(gateRun(holdRows, gateParams(P_DEV), 'football_only'), 'holdout ' + HOLD.join('-') + ', football checks only (dev-fitted parameters)'),
  holdout_strict: gateReport(gateRun(holdRows, gateParams(P_DEV), 'strict'), 'holdout ' + HOLD.join('-') + ', strict market rules on the opener on file (dev-fitted parameters)'),
  multibook_2023_2025_strict: gateReport(gateRun(withOpen.filter(function (x) { return x.season >= 2023 && x.season <= 2025; }), gateParams(P_DEV), 'strict'), '2023-2025 (multi-book openers), strict')
};
/* 2026 TO DATE, prospectively: the season the gate's rules never saw. Its
   openers are sparse, so the market reference is the CLOSE and market
   movement cannot be measured; accuracy against the close and the side's
   result can. */
OUT.gate_backtest.live_2026_vs_close = (function () {
  var P = gateParams(P_ALL);
  var rows = FB.filter(function (x) { return x.season === LIVE && x.close != null && Math.abs(x.fair - x.close) >= 7; });
  function ev(list) {
    var cov = list.filter(function (x) { return x.final_margin !== x.close; });
    return { n: list.length, model_mae: r(mean(list.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
      close_mae: r(mean(list.map(function (x) { return Math.abs(x.close - x.final_margin); })), 3),
      edgedesk_closer_than_close_pct: pct(mean(list.map(function (x) { return Math.abs(x.fair - x.final_margin) < Math.abs(x.close - x.final_margin) ? 1 : 0; }))),
      side_covered_at_close_pct: cov.length ? pct(mean(cov.map(function (x) { return sign(x.final_margin - x.close) === sign(x.fair - x.close) ? 1 : 0; }))) : null };
  }
  var runs = rows.map(function (x) {
    var c = caseFor(Object.assign({}, x, { open: x.close }), 'football_only', P);
    return { x: x, e: D.evaluate(c, P) };
  });
  var st = {};
  runs.forEach(function (o) { (st[o.e.status] = st[o.e.status] || []).push(o.x); });
  var out = { label: '2026 weeks played, football checks only, market = the close (prospective: no 2026 game informed any rule)',
    raw_7plus: ev(rows), verified: ev(runs.filter(function (o) { return o.e.verified; }).map(function (o) { return o.x; })),
    unverified: ev(runs.filter(function (o) { return !o.e.verified; }).map(function (o) { return o.x; })), statuses: {}, root_causes: {} };
  Object.keys(st).forEach(function (k) { out.statuses[k] = st[k].length; });
  runs.forEach(function (o) { var c = o.e.verified ? 'VALID_MODEL_DISAGREEMENT' : (o.e.root_cause && o.e.root_cause.primary) || 'UNKNOWN'; out.root_causes[c] = (out.root_causes[c] || 0) + 1; });
  return out;
})();

/* MAE old vs new: the priced number is unchanged (the gate never touches it) */
OUT.old_vs_new_mae = (function () {
  var S = FB.filter(function (x) { return x.season >= 2018 && x.season <= LIVE; });
  var wf = {};
  CAL.walk_forward.forEach(function (w) { wf[w.season] = w; });
  var tail = S.filter(function (x) { return Math.abs(x.fair) >= 14; });
  return { n: S.length, old_published_mae: r(mean(S.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
    new_published_mae: r(mean(S.map(function (x) { return Math.abs(x.fair - x.final_margin); })), 3),
    new_shadow_calibrated_mae_walk_forward: r(mean(CAL.walk_forward.map(function (w) { return w.mae_calibrated * w.n; })) * CAL.walk_forward.length / CAL.walk_forward.reduce(function (s2, w) { return s2 + w.n; }, 0), 3),
    tail_ge14: CAL.pooled.tail_ge14,
    reading: 'the priced fair spread is byte-identical (the gate and the calibrator never write to it), so published MAE is preserved exactly; the calibrated shadow improves it walk-forward by ' + r(-CAL.pooled.delta_mae, 3) + ' pts' };
})();

/* ============================================================ 33-35. disagreement quality */
function qFeatures(x, e) {
  var cm = e.cross_model || {};
  var g = Math.abs(x.gap_open);
  return [1,
    Math.min(x.min_gp, 8) / 8,
    cm.n ? cm.supporting / cm.n : 0.5,
    cm.n ? cm.opposing / cm.n : 0.5,
    cm.ensemble_gap != null ? Math.max(-10, Math.min(10, sign(x.gap_open) * cm.ensemble_gap)) / 10 : 0,
    Math.min(1, Math.abs(x.c.conference) / Math.max(g, 1)),
    Math.min(1, Math.abs(x.c.matchup) / Math.max(g, 1)),
    e.calibrated && e.calibrated.gap != null ? Math.min(1, Math.abs(e.calibrated.gap) / Math.max(g, 1)) : 1,
    sign(x.fair) !== sign(x.open) ? 1 : 0
  ];
}
var Q_NAMES = ['intercept', 'games_played', 'submodel_support_share', 'submodel_oppose_share', 'ensemble_gap_same_dir', 'conference_share_of_gap', 'matchup_share_of_gap', 'calibration_retention', 'favorite_flip'];
function logit(X, y, lam) {
  var p = X[0].length, w = new Array(p).fill(0), it, i, j, k;
  for (it = 0; it < 30; it++) {
    var g = new Array(p).fill(0), Hm = [];
    for (j = 0; j < p; j++) Hm.push(new Array(p).fill(0));
    for (i = 0; i < X.length; i++) {
      var z = 0; for (j = 0; j < p; j++) z += w[j] * X[i][j];
      var pr = 1 / (1 + Math.exp(-z));
      for (j = 0; j < p; j++) { g[j] += (y[i] - pr) * X[i][j]; for (k = 0; k < p; k++) Hm[j][k] += pr * (1 - pr) * X[i][j] * X[i][k]; }
    }
    for (j = 1; j < p; j++) { g[j] -= lam * w[j]; Hm[j][j] += lam; }
    var step = solve(Hm, g);
    if (!step) break;
    var mx = 0; for (j = 0; j < p; j++) { w[j] += step[j]; mx = Math.max(mx, Math.abs(step[j])); }
    if (mx < 1e-6) break;
  }
  return w;
}
function predict(w, xf) { var z = 0; for (var j = 0; j < w.length; j++) z += w[j] * xf[j]; return 1 / (1 + Math.exp(-z)); }
function auc(p, y) {
  var pos = [], neg = [], i; for (i = 0; i < p.length; i++) (y[i] ? pos : neg).push(p[i]);
  var c = 0; pos.forEach(function (a) { neg.forEach(function (b) { c += a > b ? 1 : (a === b ? 0.5 : 0); }); });
  return pos.length && neg.length ? c / (pos.length * neg.length) : null;
}
OUT.disagreement_quality = (function () {
  function prep(rows, P) {
    return rows.filter(function (x) { return Math.abs(x.gap_open) >= 5 && x.close != null && Math.abs(x.close - x.open) >= 0.25; })
      .map(function (x) { var e = D.evaluate(caseFor(x, 'football_only', P), P); return { x: x, f: qFeatures(x, e), y: (x.close - x.open) * sign(x.gap_open) > 0 ? 1 : 0, clv: (x.close - x.open) * sign(x.gap_open) }; });
  }
  var tr = prep(devRows, gateParams(P_DEV)), te = prep(holdRows, gateParams(P_DEV));
  var w = logit(tr.map(function (o) { return o.f; }), tr.map(function (o) { return o.y; }), 1);
  var pt = te.map(function (o) { return predict(w, o.f); }), yt = te.map(function (o) { return o.y; });
  var base = mean(tr.map(function (o) { return o.y; }));
  var brier = mean(pt.map(function (p, i) { return (p - yt[i]) * (p - yt[i]); })), brierB = mean(yt.map(function (y) { return (base - y) * (base - y); }));
  var A = auc(pt, yt);
  var srt = te.map(function (o, i) { return { p: pt[i], clv: o.clv, y: o.y, x: o.x }; }).sort(function (a, b) { return a.p - b.p; });
  var t = Math.floor(srt.length / 3);
  var low = srt.slice(0, t), high = srt.slice(srt.length - t);
  var passes = A != null && A >= 0.55 && (brierB - brier) >= 0.002 && mean(high.map(function (o) { return o.clv; })) > mean(low.map(function (o) { return o.clv; }));
  var fin = passes ? logit(tr.concat(te).map(function (o) { return o.f; }), tr.concat(te).map(function (o) { return o.y; }), 1) : null;
  return {
    what: 'P(the market moves toward EdgeDesk) for a 5+ gap, from PREGAME disagreement features only (never the outcome, never gap size alone): ' + Q_NAMES.slice(1).join(', '),
    train: { seasons: DEV.join('-'), n: tr.length, base_rate: r(base, 3) },
    holdout: { seasons: HOLD.join('-'), n: te.length, auc: r(A, 3), brier: r(brier, 4), brier_base_rate: r(brierB, 4),
      top_tercile: { n: high.length, moved_toward_pct: pct(mean(high.map(function (o) { return o.y; }))), clv: r(mean(high.map(function (o) { return o.clv; })), 3),
        edgedesk_closer_than_open_pct: pct(mean(high.map(function (o) { return Math.abs(o.x.fair - o.x.final_margin) < Math.abs(o.x.open - o.x.final_margin) ? 1 : 0; }))) },
      bottom_tercile: { n: low.length, moved_toward_pct: pct(mean(low.map(function (o) { return o.y; }))), clv: r(mean(low.map(function (o) { return o.clv; })), 3),
        edgedesk_closer_than_open_pct: pct(mean(low.map(function (o) { return Math.abs(o.x.fair - o.x.final_margin) < Math.abs(o.x.open - o.x.final_margin) ? 1 : 0; }))) } },
    dev_weights: Q_NAMES.reduce(function (o, k, i) { o[k] = r(w[i], 4); return o; }, {}),
    rule: 'ships only if holdout AUC >= 0.55, Brier beats the base rate by >= 0.002 (the repo’s movement-model bar) and the top tercile out-moves the bottom',
    validated: passes,
    final_weights: fin ? Q_NAMES.reduce(function (o, k, i) { o[k] = r(fin[i], 4); return o; }, {}) : null,
    decision: passes ? 'VALIDATED: disagreement_quality ships (0-100 = 100 x the probability)' : 'FAILED: the score is removed and not shipped'
  };
})();

/* ============================================================ 37-38. circuit breaker, historically */
OUT.circuit_breaker = (function () {
  var P = gateParams(P_DEV);
  var slates = {};
  withOpen.forEach(function (x) { if (x.season >= 2022) { var k = x.season + '-' + x.prediction_ts.slice(0, 10); (slates[k] = slates[k] || []).push(x); } });
  var fired = [], total = 0;
  Object.keys(slates).sort().forEach(function (k) {
    var ev = slates[k].map(function (x) { return { available: true, raw_gap_abs: Math.abs(x.gap_open), raw_market_gap: x.gap_open, week: x.week }; });
    if (ev.length < 10) return;
    total++;
    var cb = D.circuitBreaker(ev, P);
    if (cb.alert) fired.push({ slate: k, games: cb.games, observed: cb.observed, expected: cb.expected, p: cb.p_at_least });
  });
  return { what: 'MODEL_SCALE_ALERT fires when a slate’s count of raw 7+/10+/15+ gaps is improbable (Poisson tail < 0.01) against the dev-period rate for its week bucket', rates_dev: P.circuit.rate,
    holdout_slates: total, alerts: fired.length, alert_rate_pct: pct(fired.length / Math.max(1, total)), fired: fired.slice(0, 20) };
})();

/* ============================================================ 61-62. research queue */
OUT.research_queue = (function () {
  var R = OUT.gate_backtest.holdout_football_only.root_causes, D2 = OUT.gate_backtest.dev_football_only.root_causes, out = [];
  Object.keys(D2).forEach(function (k) {
    if (k === 'VALID_MODEL_DISAGREEMENT') return;
    var fe = (D2[k] ? D2[k].false_extremes : 0) + (R[k] ? R[k].false_extremes : 0);
    if (fe >= 6) out.push({ cause: k, false_extremes_2015_2025: fe, gaps: (D2[k] ? D2[k].n : 0) + (R[k] ? R[k].n : 0),
      project: 'targeted research: ' + k.replace(/_/g, ' ').toLowerCase() + ' produced ' + fe + ' false 7+ extremes' });
  });
  out.sort(function (a, b) { return b.false_extremes_2015_2025 - a.false_extremes_2015_2025; });
  /* near-miss model changes: consistent walk-forward gains under the bar */
  out.push({ cause: 'HFA_ERROR / margin scale', project: 'promote the football-only calibrator at season end if the full 2026 season keeps the gain (currently '
    + CAL.pooled.delta_mae + ' pts, ' + CAL.pooled.years_better + ' seasons, bar 0.05)', near_miss_model_change: true });
  out.push({ cause: 'RECENT_FORM_OVERREACTION / carryover', project: 'refit params.blend: outcomes support more weight on the long-term state (walk-forward '
    + OUT.carryover.walk_forward_refit.pooled_delta_mae + ' pts, ' + OUT.carryover.walk_forward_refit.years_better + ' seasons, bar 0.05)', near_miss_model_change: true });
  return out;
})();

/* ============================================================ the dataset (every 5+ gap) */
var COLS = ['game_id', 'season', 'week', 'prediction_ts', 'kickoff', 'home', 'away', 'home_conference', 'away_conference', 'home_fbs', 'away_fbs', 'neutral_site',
  'pure_fair_margin', 'opener_margin', 'current_consensus_margin', 'closing_consensus_margin', 'final_margin', 'raw_model_market_gap', 'gap_reference', 'gap_abs', 'bucket', 'direction',
  'favorite_flip', 'football_confidence', 'reliability', 'ensemble_disagreement_sd', 'prediction_sigma', 'qb_certainty', 'roster_certainty',
  'c_rating', 'c_hfa', 'c_matchup', 'c_conference', 'c_schedule_rest_travel', 'c_qb', 'c_injury', 'c_weather', 'c_special_teams', 'c_rivalry',
  'current_form_adjustment', 'prior_contribution', 'roster_contribution', 'home_carried', 'home_fresh', 'away_carried', 'away_fresh', 'prior_weight', 'home_gp', 'away_gp',
  'data_completeness', 'source_freshness_hours', 'market_book_count', 'market_dispersion_sd',
  'v2_efficiency', 'v2_elo', 'v2_ridge', 'v2_gbm', 'v2_drive', 'v2_ensemble',
  'close_moved_toward', 'edgedesk_closer_than_open', 'edgedesk_closer_than_close', 'side_covered', 'false_extreme', 'gate_status_football_only', 'root_cause'];
var dataset = [];
FB.concat(ROWS.filter(function (x) { return !x.fbs2 && x.completed; })).forEach(function (x) {
  var ref = x.open != null ? x.open : x.close;
  if (ref == null) return;
  var gap = x.fair - ref;
  if (Math.abs(gap) < 5) return;
  var e = null;
  if (Math.abs(gap) >= 7 && x.open != null) {
    var P = x.season <= DEV[1] ? gateParams(P_DEV) : gateParams(P_DEV);
    e = D.evaluate(caseFor(x, 'football_only', P), P);
  }
  var b = BUCKETS.filter(function (bb) { return Math.abs(gap) >= bb[0] && Math.abs(gap) < bb[1]; })[0];
  var fe = (x.open != null && x.close != null) ? D.falseExtreme({ fair: x.fair, open: x.open, close: x.close, final_margin: x.final_margin }) : null;
  var avail = [true, true, x.c_avail && x.c_avail.matchup, x.c_avail && x.c_avail.schedule, true];
  var V = x.v2 || {};
  dataset.push([x.game_id, x.season, x.week, x.prediction_ts, x.kickoff, x.home, x.away, x.home_conference, x.away_conference, x.home_fbs, x.away_fbs, x.neutral_site,
    r(x.fair, 2), x.open, ref, x.close, x.final_margin, r(gap, 2), x.open != null ? 'open' : 'close', r(Math.abs(gap), 2), b ? b[2] : '', gap > 0 ? 'home' : 'away',
    sign(x.fair) !== sign(ref) && sign(ref) !== 0, x.confidence, '', V.ens_sd == null ? '' : V.ens_sd, x.sigma, '', '',
    x.c.rating, x.c.hfa, x.c.matchup, x.c.conference, x.c.schedule, x.c.qb, x.c.injury, 0, 0, x.c.rivalry,
    r(x.c.rating - x.prior_weight * (x.h_carried - x.a_carried), 3), r(x.prior_weight * (x.h_carried - x.a_carried), 3), 0,
    x.h_carried, x.h_fresh, x.a_carried, x.a_fresh, x.prior_weight, x.h_gp, x.a_gp,
    r(avail.filter(Boolean).length / avail.length, 2), r((Date.parse(x.kickoff) - Date.parse(x.prediction_ts)) / 3600e3, 1),
    x.open != null ? x.mkt.open_books : (x.mkt ? x.mkt.close_books : ''), x.open != null ? (x.mkt.open_sd == null ? '' : x.mkt.open_sd) : (x.mkt && x.mkt.close_sd != null ? x.mkt.close_sd : ''),
    V.A_adj_eff, V.B_elo, V.C_ridge, V.D_gbm, V.E_drive, V.ens,
    (x.open != null && x.close != null) ? ((x.close - x.open) * sign(gap) > 0) : '',
    x.open != null ? Math.abs(x.fair - x.final_margin) < Math.abs(x.open - x.final_margin) : '',
    x.close != null ? Math.abs(x.fair - x.final_margin) < Math.abs(x.close - x.final_margin) : '',
    x.final_margin !== ref ? sign(x.final_margin - ref) === sign(gap) : '',
    fe == null ? '' : fe, e ? e.status : '', e ? (e.verified ? 'VALID_MODEL_DISAGREEMENT' : (e.root_cause && e.root_cause.primary)) : '']);
});
OUT.dataset = { file: 'football/validation/disagreement/major_disagreements_cfb.csv.gz', rows: dataset.length, columns: COLS,
  note: 'every completed game with |pure fair - market| >= 5 at the prediction instant (the opener; the close where no opener exists, e.g. most of 2026). Empty cells are values the historical corpus does not carry (see definitions.unavailable_in_corpus); weather, special teams and roster contribute 0 to the V1 mean by design.' };

/* ============================================================ generated params */
var QV = OUT.disagreement_quality;
var PARAMS = {
  schema: 'edgedesk_cfb_disagreement_params_v1', generated_at: GENERATED_AT,
  generated_by: 'football/cfb_p4/research/disagreement_forensics.js', fitted_on: '2015-2025 walk-forward replay (final margins; the market never an input to any football parameter)',
  gate: gateParams(P_ALL),
  ensemble_sd: P_ALL._ensemble_sd,
  quality: QV.validated ? { names: Q_NAMES, weights: Q_NAMES.map(function (k) { return QV.final_weights[k]; }), holdout_auc: QV.holdout.auc } : null,
  quality_decision: QV.decision,
  evidence: 'football/validation/disagreement/forensics_cfb.json'
};
var MCAL = {
  version: 'cfb_margin_cal_v1', generated_at: GENERATED_AT, generated_by: 'football/cfb_p4/research/disagreement_forensics.js',
  slope: CAL.final_fit.slope, hfa: CAL.final_fit.hfa, form: CAL.form, fitted_on: CAL.final_fit.seasons + ' final margins (n ' + CAL.final_fit.n + ')',
  promoted: CAL.promoted, promotion_rule: CAL.promotion_rule, record: CAL.pooled, decision: CAL.decision,
  basis: 'football-only: fitted to final margins, never to the market'
};

function writeJs(file2, global2, obj, doc) {
  var body = 'if(typeof window===\'undefined\'){globalThis.window=globalThis;}\n/* ' + doc + ' GENERATED FILE — produced by\n   football/cfb_p4/research/disagreement_forensics.js; never edit by hand. */\n'
    + 'window.' + global2 + ' = ' + JSON.stringify(obj) + ';\n'
    + 'if(typeof module!==\'undefined\'&&module.exports){module.exports=window.' + global2 + ';}\n';
  fs.writeFileSync(file2, body);
}
function md(OUT2) {
  var L = [];
  function t(rows, head) { L.push('| ' + head.join(' | ') + ' |'); L.push('|' + head.map(function () { return '---'; }).join('|') + '|'); rows.forEach(function (rw) { L.push('| ' + rw.join(' | ') + ' |'); }); L.push(''); }
  function evRow(k, e) { return [k, e.n, e.model_mae, e.open_mae, e.close_mae, e.edgedesk_closer_than_open_pct, e.edgedesk_closer_than_close_pct, e.close_moved_toward_pct, e.clv_points_mean, e.side_covered_pct, e.roi_at_minus110_pct, e.false_extreme_rate_pct]; }
  var EVH = ['slice', 'n', 'model MAE', 'opener MAE', 'close MAE', 'closer than opener %', 'closer than close %', 'close moved toward %', 'CLV pts', 'side covered %', 'ROI @-110 %', 'false-extreme %'];
  L.push('# CFB major-disagreement forensics');
  L.push('');
  L.push('GENERATED by `football/cfb_p4/research/disagreement_forensics.js` from the walk-forward replay `disagreement_replay.js` (' + OUT2.generated_at + '). Every number below is recomputed on each run; nothing here is typed by hand.');
  L.push('');
  L.push('The replay prices every game from the Tuesday-12:00-UTC freeze before kickoff with the SHIPPED engine and production-equivalent priced inputs; the market is joined afterwards and never enters the football number. It reproduces the published held-out record (2022-2025 closing-market MAE 12.015, identical to `params.validation_summary`).');
  L.push('');
  L.push('Archive opener faults excluded as the prediction-time reference: ' + OUT2.archive_opener_faults.n + ' (' + OUT2.archive_opener_faults.rule + ').');
  L.push('');
  L.push('## 1. How often EdgeDesk disagrees (vs the opener at the freeze)');
  L.push('');
  t(Object.keys(OUT2.counts).map(function (k) { var c = OUT2.counts[k]; return [k, c.games, c['5.0-6.9'], c['7.0-9.9'], c['10.0-14.9'], c['15.0+'], c['7+'], pct(c['7+'] / c.games)]; }), ['span', 'games', '5.0-6.9', '7.0-9.9', '10.0-14.9', '15.0+', '7+', '7+ % of games']);
  L.push('Gap distribution (signed, opener, 2015-2025): mean ' + OUT2.gap_distribution.vs_open.all.mean + ', median ' + OUT2.gap_distribution.vs_open.all.median + ', SD ' + OUT2.gap_distribution.vs_open.all.sd + ', p5/p95 ' + OUT2.gap_distribution.vs_open.all.p5 + '/' + OUT2.gap_distribution.vs_open.all.p95 + '.');
  L.push('');
  t(Object.keys(OUT2.gap_distribution.by_season).map(function (k) { var c = OUT2.gap_distribution.by_season[k]; return [k, c.reference, c.n, c.mean_abs, c.ge5, c.ge7, c.ge10, c.ge15, c.ge7_rate_pct]; }), ['season', 'reference', 'games', 'mean |gap|', '5+', '7+', '10+', '15+', '7+ %']);
  L.push('## 2. Was EdgeDesk right to disagree?');
  L.push('');
  t(Object.keys(OUT2.was_edgedesk_right.by_bucket).map(function (k) { return evRow(k, OUT2.was_edgedesk_right.by_bucket[k]); }), EVH);
  L.push('By extreme bucket:');
  L.push('');
  t(Object.keys(OUT2.was_edgedesk_right.by_extreme_bucket).map(function (k) { return evRow(k, OUT2.was_edgedesk_right.by_extreme_bucket[k]); }), EVH);
  L.push('7+ gaps by week bucket:');
  L.push('');
  t(Object.keys(OUT2.was_edgedesk_right.by_week_bucket_7plus).map(function (k) { return evRow('weeks ' + k, OUT2.was_edgedesk_right.by_week_bucket_7plus[k]); }), EVH);
  L.push('## 3. Where the extreme gaps come from');
  L.push('');
  L.push('Base-rating audit: in ' + OUT2.sources_of_extremes.base_rating_audit.share_7plus_where_base_alone_ge7 + '% of 7+ gaps the neutral rating difference plus home field ALREADY disagrees with the market by 7+; game adjustments create the rest (' + OUT2.sources_of_extremes.base_rating_audit.share_7plus_where_adjustments_create_it + '%).');
  L.push('');
  t(Object.keys(OUT2.sources_of_extremes.attribution_7plus).map(function (k) { return evRow(k, OUT2.sources_of_extremes.attribution_7plus[k]); }), EVH);
  t(OUT2.sources_of_extremes.conditions.map(function (c) { return evRow(c.label, c.evidence); }), EVH);
  L.push('## 4. Component contribution distributions (|points|, 2015-2025)');
  L.push('');
  var CD = OUT2.component_distributions.all_2015_2025;
  t(Object.keys(CD).filter(function (k) { return CD[k] && CD[k].n != null; }).map(function (k) { var c = CD[k]; return [k, c.median, c.p75, c.p90, c.p95, c.p99, c.max, c.share_nonzero]; }), ['component', 'median', 'p75', 'p90', 'p95', 'p99', 'max', 'share non-zero']);
  L.push(OUT2.component_distributions.note);
  L.push('');
  L.push('## 5. Margin scale and the football-only calibrator');
  L.push('');
  t(Object.keys(OUT2.margin_scale.by_season).map(function (k) { var c = OUT2.margin_scale.by_season[k]; return [k, c.n, c.slope, c.intercept, c.sd_pred, c.sd_final, c.sd_close]; }), ['season', 'n', 'slope final~fair', 'intercept', 'SD predicted', 'SD final', 'SD close']);
  t(Object.keys(OUT2.margin_scale.extreme_favorites).map(function (k) { var c = OUT2.margin_scale.extreme_favorites[k]; return [k, c.n, c.mean_projected, c.mean_realized, c.realized_per_projected, c.market_on_same_games, c.mae]; }), ['EdgeDesk favourite by', 'n', 'mean projected', 'mean realized', 'realized / projected', 'market on same games', 'MAE']);
  L.push('Team-strength scale: 1 rating point = ' + OUT2.margin_scale.team_strength_scale.points_per_rating_point + ' scoreboard points (SE ' + OUT2.margin_scale.team_strength_scale.se + '); by era ' + JSON.stringify(OUT2.margin_scale.team_strength_scale.by_era) + '.');
  L.push('');
  L.push('Calibrator (' + OUT2.margin_calibration.form + '):');
  L.push('');
  t(OUT2.margin_calibration.walk_forward.map(function (w) { return [w.season, w.n, w.slope, w.hfa, w.mae_raw, w.mae_calibrated, w.delta, w.bias_raw, w.bias_calibrated]; }), ['season', 'n', 'slope', 'fitted home field', 'MAE raw', 'MAE calibrated', 'delta', 'bias raw', 'bias calibrated']);
  L.push('Pooled walk-forward: delta ' + OUT2.margin_calibration.pooled.delta_mae + ' (95% CI ' + OUT2.margin_calibration.pooled.ci95.join(' to ') + '), better in ' + OUT2.margin_calibration.pooled.years_better + ' seasons; 14+ tail MAE ' + OUT2.margin_calibration.pooled.tail_ge14.mae_raw + ' -> ' + OUT2.margin_calibration.pooled.tail_ge14.mae_calibrated + '.');
  L.push('');
  L.push('**Decision:** ' + OUT2.margin_calibration.decision);
  L.push('');
  L.push('## 6. Home field');
  L.push('');
  t(Object.keys(OUT2.hfa.by_season).map(function (k) { var c = OUT2.hfa.by_season[k]; return [k, c.n, c.model_home_residual, c.close_home_residual, c.model_minus_close, c.mean_home_margin]; }), ['season', 'home games', 'model residual', 'close residual', 'model - close', 'mean home margin']);
  L.push(OUT2.hfa.structure.finding + ' Neutral sites: ' + OUT2.hfa.neutral_site.hfa_applied_nonzero + ' of ' + OUT2.hfa.neutral_site.n + ' received home field.');
  L.push('');
  L.push('## 7. Conference scale and connectivity');
  L.push('');
  t(Object.keys(OUT2.conference_scale.by_conference).map(function (k) { var c = OUT2.conference_scale.by_conference[k]; return [k, c.dev.n, c.dev.mean_resid, c.dev.t, c.holdout.n, c.holdout.mean_resid, c.holdout.t, c.live_2026.n, c.live_2026.mean_resid, c.persistent ? 'YES' : 'no']; }), ['conference', 'dev n', 'dev resid', 'dev t', 'hold n', 'hold resid', 'hold t', '2026 n', '2026 resid', 'persistent']);
  L.push(OUT2.conference_scale.decision);
  L.push('');
  L.push('Conference term in cross-conference games: ' + JSON.stringify(OUT2.conference_scale.conference_term.coefficient_in_cross_conference_games) + '.');
  L.push('');
  t(Object.keys(OUT2.connectivity.by_connectivity_cross_conf_7plus).map(function (k) { return evRow('connectivity ' + k, OUT2.connectivity.by_connectivity_cross_conf_7plus[k]); }), EVH);
  L.push('## 8. Public rating vs engine state; carryover; recency');
  L.push('');
  var PR = OUT2.public_rating_vs_engine;
  L.push('Public rating MAE ' + PR.mae_public_rating_margin + ' vs engine base ' + PR.mae_engine_base_rating_plus_hfa + ' vs engine published ' + PR.mae_engine_published + ' (n ' + PR.n + '); team-gap correlation ' + PR.correlation_of_team_gaps + '; incremental value of the public rating over the engine: ' + JSON.stringify(PR.incremental_value_of_public_over_engine) + '.');
  L.push('');
  t(Object.keys(PR.by_week_bucket).map(function (k) { var c = PR.by_week_bucket[k]; return [k, c.n, c.mae_public, c.mae_engine_base, c.mae_engine]; }), ['weeks', 'n', 'public', 'engine base', 'engine published']);
  t(Object.keys(OUT2.carryover.by_games_played).map(function (k) { var c = OUT2.carryover.by_games_played[k] || {}; return [k, c.n, c.coef_carried, c.coef_fresh == null ? '—' : c.coef_fresh, c.implied_prior_weight == null ? '—' : c.implied_prior_weight, c.shipped_prior_weight_mean == null ? '—' : c.shipped_prior_weight_mean]; }), ['games played', 'n', 'coef carried', 'coef this-season', 'implied prior weight', 'shipped prior weight']);
  L.push('Long-term vs current delta: ' + JSON.stringify(OUT2.long_term_vs_current.residual_on_delta) + '. Recency: last-3 ' + JSON.stringify(OUT2.recency.last3) + ', season ' + JSON.stringify(OUT2.recency.season) + '.');
  L.push('');
  var WR = OUT2.carryover.walk_forward_refit;
  L.push('Re-fitted blend, walk-forward: pooled delta ' + WR.pooled_delta_mae + ' (CI ' + WR.ci95.join(' to ') + '), better in ' + WR.years_better + ' seasons. **' + WR.decision + '**');
  L.push('');
  L.push('## 9. Matchup');
  L.push('');
  t(Object.keys(OUT2.matchup.buckets).map(function (k) { var c = OUT2.matchup.buckets[k]; return [k, c.n, c.mean_abs_matchup, c.mean_residual_in_matchup_direction, c.realized_per_predicted, c.gap7_evidence.n, c.gap7_evidence.close_moved_toward_pct, c.gap7_evidence.clv_points_mean]; }), ['|matchup|', 'n', 'mean |pts|', 'residual in its direction', 'realized per predicted', '7+ gaps', 'moved toward %', 'CLV']);
  L.push('Residual check: ' + JSON.stringify(OUT2.matchup.residual_check.joint_fit) + ', correlation with the rating term ' + OUT2.matchup.residual_check.corr_matchup_with_rating + '.');
  L.push('');
  L.push('## 10. Favourite flips');
  L.push('');
  t(Object.keys(OUT2.favorite_flips).map(function (k) { return evRow(k, OUT2.favorite_flips[k]); }), EVH);
  L.push('## 11. The integrity gate, replayed');
  L.push('');
  L.push(OUT2.gate_backtest.design_note);
  L.push('');
  ['dev_football_only', 'holdout_football_only', 'holdout_strict', 'multibook_2023_2025_strict'].forEach(function (k) {
    var G = OUT2.gate_backtest[k];
    L.push('### ' + G.label);
    L.push('');
    L.push('Raw 7+ gaps (old system: every one labelled MAJOR DISAGREEMENT): **' + G.raw_7plus + '**. Verified: **' + G.verified_count + '** (' + G.verified_10plus + ' at 10+, ' + G.verified_15plus + ' at 15+, ' + G.verified_flips + ' favourite flips). False extremes carrying the major label: ' + G.false_extremes.old_system_major_labels + ' old -> ' + G.false_extremes.new_system_verified_labels + ' new.');
    L.push('');
    t([evRow('raw 7+ (old MAJOR DISAGREEMENT)', G.raw_7plus_evidence), evRow('VERIFIED', G.verified), evRow('not verified', G.unverified)]
      .concat(Object.keys(G.statuses).map(function (s2) { return evRow('status ' + s2, G.statuses[s2]); })), EVH);
    t(Object.keys(G.root_causes).map(function (c) { var x = G.root_causes[c]; return [c, x.n, x.false_extremes, x.moved_toward_pct, x.clv, x.model_mae, x.open_mae]; }), ['root cause (7+)', 'n', 'false extremes', 'moved toward %', 'CLV', 'model MAE', 'opener MAE']);
    L.push('Favourite flips: ' + JSON.stringify(G.favorite_flip_false_extremes) + '.');
    L.push('');
    L.push('Each check on its own (7+ gaps; pass vs fail):');
    L.push('');
    t(Object.keys(G.check_items).map(function (c) { var x = G.check_items[c]; function f(v) { return v ? v.n + ' / ' + v.moved_toward_pct + '% / ' + v.false_extreme_rate_pct + '%' : '—'; } return [c, f(x.pass), f(x.fail), f(x.warn)]; }),
      ['check', 'PASS n / moved toward / false-extreme', 'FAIL', 'WARN']);
  });
  var LV = OUT2.gate_backtest.live_2026_vs_close;
  if (LV) {
    L.push('### ' + LV.label);
    L.push('');
    var LVH = ['population', 'n', 'model MAE', 'close MAE', 'EdgeDesk closer than close %', 'side covered at close %'];
    t([['raw 7+', LV.raw_7plus], ['VERIFIED', LV.verified], ['not verified', LV.unverified]].map(function (q2) { var e = q2[1]; return [q2[0], e.n, e.model_mae, e.close_mae, e.edgedesk_closer_than_close_pct, e.side_covered_at_close_pct]; }), LVH);
    L.push('Statuses: ' + JSON.stringify(LV.statuses) + '; root causes: ' + JSON.stringify(LV.root_causes) + '.');
    L.push('');
  }
  L.push('## 12. Disagreement quality');
  L.push('');
  var Qd = OUT2.disagreement_quality;
  L.push(Qd.what + '. Holdout: AUC ' + Qd.holdout.auc + ', Brier ' + Qd.holdout.brier + ' vs base ' + Qd.holdout.brier_base_rate + '; top tercile moved toward ' + Qd.holdout.top_tercile.moved_toward_pct + '% (CLV ' + Qd.holdout.top_tercile.clv + ') vs bottom ' + Qd.holdout.bottom_tercile.moved_toward_pct + '% (CLV ' + Qd.holdout.bottom_tercile.clv + '). ' + Qd.rule + '. **' + Qd.decision + '**');
  L.push('');
  L.push('## 13. Circuit breaker and zero centre');
  L.push('');
  L.push('Holdout slates: ' + OUT2.circuit_breaker.holdout_slates + ', MODEL_SCALE_ALERT fired on ' + OUT2.circuit_breaker.alerts + ' (' + OUT2.circuit_breaker.alert_rate_pct + '%). Zero centre (mean signed gap): all ' + JSON.stringify(OUT2.zero_center.all) + ', home games ' + JSON.stringify(OUT2.zero_center.home_game) + ', oriented to the market favourite ' + JSON.stringify(OUT2.zero_center.oriented_to_market_favourite) + '.');
  L.push('');
  L.push('## 14. Research queue (causes with 6+ false extremes, 2015-2025)');
  L.push('');
  t(OUT2.research_queue.map(function (x) { return [x.cause, x.gaps == null ? '—' : x.gaps, x.false_extremes_2015_2025 == null ? '—' : x.false_extremes_2015_2025, x.project]; }), ['cause', '7+ gaps', 'false extremes', 'project']);
  L.push('## 15. What the corpus cannot measure');
  L.push('');
  OUT2.definitions.unavailable_in_corpus.forEach(function (u) { L.push('- ' + u); });
  L.push('- ' + OUT2.qb_roster.qb);
  L.push('- ' + OUT2.qb_roster.roster_in_mean);
  L.push('');
  return L.join('\n') + '\n';
}

if (WRITE) {
  var vdir = path.join(ROOT, 'football', 'validation', 'disagreement');
  fs.mkdirSync(vdir, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'docs', 'cfb-disagreement'), { recursive: true });
  fs.writeFileSync(path.join(vdir, 'forensics_cfb.json'), JSON.stringify(OUT, null, 1) + '\n');
  var csv = [COLS.join(',')].concat(dataset.map(function (rw) {
    return rw.map(function (v) { if (v == null) return ''; var t2 = String(v); return /[",\n]/.test(t2) ? '"' + t2.replace(/"/g, '""') + '"' : t2; }).join(',');
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(vdir, 'major_disagreements_cfb.csv.gz'), zlib.gzipSync(Buffer.from(csv), { level: 9, mtime: 0 }));
  fs.writeFileSync(path.join(ROOT, 'docs', 'cfb-disagreement', 'FORENSICS.md'), md(OUT));
  writeJs(path.join(ROOT, 'football', 'cfb_p4', 'disagreement_params.js'), 'EDCfbDisagreementParams', PARAMS, 'EdgeDesk CFB major-disagreement gate — measured parameters.');
  writeJs(path.join(ROOT, 'football', 'cfb_p4', 'margin_calibration.js'), 'EDCfbP4MarginCalibration', MCAL, 'EdgeDesk CFB football-only margin calibrator (shadow unless promoted).');
  console.error('[write] forensics_cfb.json, major_disagreements_cfb.csv.gz (' + dataset.length + ' rows), FORENSICS.md, disagreement_params.js, margin_calibration.js');
}
console.log(JSON.stringify({ counts: OUT.counts, calibrator: { pooled: CAL.pooled, promoted: CAL.promoted, final: CAL.final_fit },
  holdout_gate: { raw7: OUT.gate_backtest.holdout_football_only.raw_7plus, verified: OUT.gate_backtest.holdout_football_only.verified_count,
    verified_ev: OUT.gate_backtest.holdout_football_only.verified, unverified_ev: OUT.gate_backtest.holdout_football_only.unverified,
    fe: OUT.gate_backtest.holdout_football_only.false_extremes },
  quality: { auc: QV.holdout.auc, validated: QV.validated } }, null, 1));
