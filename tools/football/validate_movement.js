#!/usr/bin/env node
/* ===========================================================================
   THE MOVEMENT VALIDATION — does the number move toward a rating that
   disagrees with the opener, and is the number the desk quotes at the open
   worth more than the close?

   Reads the CFB archive (football/pricing/lines_cfb.json: openers, closes,
   results and the pregame Elo of both sides, 2006 on) and the NFL opener
   ledger (football/pricing/openers_nfl.json, EdgeDesk's own captures) and
   grades, time-separated by season:

     the rating line     a pregame-Elo margin fitted on seasons before S
                         (margin ~ a + b*(home_elo - away_elo) + hfa), so a
                         rating that is independent of the market exists for
                         every historical game; the desk's own fair line
                         replaces it going forward as packets accumulate
     the gap             rating home line minus the opening home line
     the move            closing home line minus the opening home line
     toward the rating   sign(move) == sign(gap), by |gap| threshold, with a
                         one-sided binomial p, held out on S = 2011..2025
     the regression      move ~ c*gap fitted before S, scored on S: MAE vs
                         the no-move baseline
     open beats close    for the side the rating favours at the open, the
                         cover rate at the OPENING number vs at the CLOSE;
                         the difference is the value of betting early when
                         the rating and the market disagree
     tiers               VALIDATED  toward-rating rate >= 55% with p < 0.01,
                                    n >= 500, most seasons, holds on the later
                                    window
                         LEAN       >= 52.5% with p < 0.05, n >= 300
                         RESEARCH   neither

   Output football/validation/movement_<sport>.json, read by the pricing
   kernel's movement() to say BET NOW, WAIT or NO READ with the tier beside
   it. Nothing here claims a betting record; the scorecard grades the desk's
   own quotes as they close.

   Usage
     node tools/football/validate_movement.js [--sport cfb|nfl] [--check]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'football', 'validation');
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));
const CFB = path.join(ROOT, 'football', 'pricing', 'lines_cfb.json');
const NFL_LEDGER = path.join(ROOT, 'football', 'pricing', 'openers_nfl.json');
const NFL_ARCHIVE = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
const THRESHOLDS = [0.5, 1, 2, 3, 5, 7];
const RULES = { first_season: 2006, first_holdout: 2011, validated: { rate: 0.55, p_max: 0.01, min_n: 500 }, lean: { rate: 0.525, p_max: 0.05, min_n: 300 }, min_gap_for_direction: 0.5 };

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function binomP(wins, n) { if (!n) return null; const z = (wins - 0.5 - n / 2) / Math.sqrt(n / 4); return r4(1 - normCdf(z)); }
function ols(rows, xf, yf) {
  const k = xf.length + 1; const A = Array.from({ length: k }, () => new Array(k).fill(0)); const b = new Array(k).fill(0);
  rows.forEach((r) => { const x = [1].concat(xf.map((f) => f(r))); const y = yf(r); for (let i = 0; i < k; i++) { b[i] += x[i] * y; for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j]; } });
  for (let i = 0; i < k; i++) { let p = i; for (let r2i = i + 1; r2i < k; r2i++) if (Math.abs(A[r2i][i]) > Math.abs(A[p][i])) p = r2i; [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]]; const d = A[i][i] || 1e-12; for (let r2i = 0; r2i < k; r2i++) { if (r2i === i) continue; const f = A[r2i][i] / d; for (let c = i; c < k; c++) A[r2i][c] -= f * A[i][c]; b[r2i] -= f * b[i]; } }
  const coef = b.map((v, i) => v / (A[i][i] || 1e-12));
  return { coef, pred: (r) => coef[0] + xf.reduce((s, f, i) => s + coef[i + 1] * f(r), 0) };
}

/** Rows with an opener, a close, a result and both Elo values. Pure. */
function cfbRows(archive) {
  return (archive.games || []).filter((g) => g.open && g.open.home_line != null && g.close && g.close.home_line != null && g.margin != null && g.ctx && num(g.ctx.home_pregame_elo) != null && num(g.ctx.away_pregame_elo) != null && g.home_division === 'fbs' && g.away_division === 'fbs')
    .map((g) => ({ id: g.id, season: g.season, week: g.week, open: g.open.home_line, close: g.close.home_line, margin: g.margin, elo_diff: g.ctx.home_pregame_elo - g.ctx.away_pregame_elo, home: g.neutral ? 0 : 1, move: r2(g.close.home_line - g.open.home_line) }));
}

function directionTable(rows, gapOf, laterFrom) {
  const out = {};
  THRESHOLDS.forEach((t) => {
    let n = 0, w = 0; const bySeason = {};
    rows.forEach((r) => { const gap = gapOf(r); if (gap == null || Math.abs(gap) < t || r.move === 0) return; const s = (bySeason[r.season] = bySeason[r.season] || { n: 0, w: 0 }); n++; s.n++; if (Math.sign(r.move) === Math.sign(gap)) { w++; s.w++; } });
    const later = rows.filter((r) => r.season >= laterFrom); let ln = 0, lw = 0; later.forEach((r) => { const gap = gapOf(r); if (gap == null || Math.abs(gap) < t || r.move === 0) return; ln++; if (Math.sign(r.move) === Math.sign(gap)) lw++; });
    out[String(t)] = { n, toward: w, toward_rate: n ? r4(w / n) : null, p_one_sided: binomP(w, n), seasons_above_half: Object.keys(bySeason).filter((s) => bySeason[s].n >= 20 && bySeason[s].w / bySeason[s].n > 0.5).length, seasons_scored: Object.keys(bySeason).filter((s) => bySeason[s].n >= 20).length, later: { n: ln, toward_rate: ln ? r4(lw / ln) : null } };
  });
  return out;
}
function passes(e, rule) { return !!(e && e.n >= rule.min_n && e.toward_rate != null && e.toward_rate >= rule.rate && e.p_one_sided != null && e.p_one_sided < rule.p_max && e.seasons_above_half * 2 >= e.seasons_scored && e.later.n >= 50 && e.later.toward_rate > 0.5); }
function tierOf(table) {
  for (const t of THRESHOLDS) if (passes(table[String(t)], RULES.validated)) return ['VALIDATED', t];
  for (const t of THRESHOLDS) if (passes(table[String(t)], RULES.lean)) return ['LEAN', t];
  return ['RESEARCH', null];
}
/** Score one set of rows with a rating-line producer fitted per held-out season. */
function score(rows, opts) {
  opts = opts || {};
  const held = []; const fits = [];
  const seasons = [...new Set(rows.map((r) => r.season))].sort();
  const firstHold = opts.first_holdout || RULES.first_holdout;
  seasons.filter((S) => S >= firstHold).forEach((S) => {
    const tune = rows.filter((r) => r.season < S), test = rows.filter((r) => r.season === S);
    if (tune.length < 300 || !test.length) return;
    /* the rating line: margin from Elo and home field, fitted before S; a betting home line is minus the margin */
    const rating = ols(tune, [(r) => r.elo_diff, (r) => r.home], (r) => r.margin);
    const withGap = (rs) => rs.map((r) => Object.assign({}, r, { rating_line: r2(-rating.pred(r)), gap: r2(-rating.pred(r) - r.open) }));
    const tuneG = withGap(tune), testG = withGap(test);
    const mv = ols(tuneG, [(r) => r.gap], (r) => r.move);
    const testM = testG.map((r) => Object.assign({}, r, { pred_move: mv.pred(r) }));
    held.push(...testM);
    fits.push({ season: S, n_tune: tune.length, n_test: test.length, rating: { points_per_elo: r4(rating.coef[1]), home_field: r2(rating.coef[2]), intercept: r2(rating.coef[0]) }, move_per_gap_point: r4(mv.coef[1]), move_intercept: r3(mv.coef[0]), mae_pred: r3(mean(testM.map((r) => Math.abs(r.move - r.pred_move)))), mae_no_move: r3(mean(testM.map((r) => Math.abs(r.move)))) });
  });
  const table = directionTable(held, (r) => r.gap, opts.later_from || 2019);
  const [tier, edge] = tierOf(table);
  /* open beats close: the side the rating favours at the open, graded at the opening number and at the close */
  const openVsClose = {};
  THRESHOLDS.forEach((t) => {
    let n = 0, wOpen = 0, wClose = 0, pOpen = 0, pClose = 0;
    held.forEach((r) => { if (Math.abs(r.gap) < t) return; const side = r.gap < 0 ? 1 : -1; /* rating says home should be MORE favoured (gap negative) -> take home */ n++; const cOpen = side * r.margin + side * r.open, cClose = side * r.margin + side * r.close; if (cOpen > 0) wOpen++; else if (cOpen === 0) pOpen++; if (cClose > 0) wClose++; else if (cClose === 0) pClose++; });
    openVsClose[String(t)] = { n, cover_at_open: n - pOpen ? r4(wOpen / (n - pOpen)) : null, cover_at_close: n - pClose ? r4(wClose / (n - pClose)) : null, points_gained_by_betting_early: n ? r3(mean(held.filter((r) => Math.abs(r.gap) >= t).map((r) => (r.gap < 0 ? 1 : -1) * (r.open - r.close)))) : null };
  });
  const last = fits.length ? fits[fits.length - 1] : null;
  return { n: held.length, seasons_held_out: fits.map((f) => f.season), fits, toward_rating_by_gap: table, open_vs_close_by_gap: openVsClose, tier, required_gap_points: edge, latest: last ? { move_per_gap_point: last.move_per_gap_point, rating: last.rating } : null,
    regression: { pooled_mae_pred: r3(mean(held.map((r) => Math.abs(r.move - r.pred_move)))), pooled_mae_no_move: r3(mean(held.map((r) => Math.abs(r.move)))) },
    tier_basis: tier === 'VALIDATED' ? 'when a rating fitted before the season disagreed with the opener by ' + edge + '+ points, the number moved toward the rating ' + table[String(edge)].toward_rate + ' of the time (n ' + table[String(edge)].n + ', p ' + table[String(edge)].p_one_sided + '), holding on the later window' : tier === 'LEAN' ? 'the number moved toward a disagreeing rating more often than not at ' + edge + '+ points (' + table[String(edge)].toward_rate + ', n ' + table[String(edge)].n + ', p ' + table[String(edge)].p_one_sided + '): a tendency, not a record' : 'no disagreement threshold cleared the movement rule; the opener carries the information' };
}

function buildCfb() {
  const archive = JSON.parse(fs.readFileSync(CFB, 'utf8'));
  const rows = cfbRows(archive);
  const sc = score(rows, { first_holdout: RULES.first_holdout, later_from: 2019 });
  return { schema: 'edgedesk_movement_validation_v1', sport: 'americanfootball_ncaaf', generated_at: new Date().toISOString(),
    frame: { archive: path.relative(ROOT, CFB), rows: rows.length, basis: 'FBS-vs-FBS games with an opener, a close, a result and both pregame Elo values; the rating line is Elo-and-home-field fitted on seasons before each held-out season (2011-2025); the gap is the rating home line minus the opening home line; a move is the closing home line minus the opening home line', rating_is: 'CFBD pregame Elo as carried by the sportsdataverse schedules; independent of the market but not the desk’s own projection. As research packets accumulate with their quoted fair line and the archive closes, the same test runs on the desk’s own numbers (football/validation/scorecard.json).' },
    rules: RULES, thresholds: THRESHOLDS, result: sc, note: 'A movement tendency says where a number tends to go, not whether a side wins. The kernel may say BET NOW or WAIT only under a LEAN or VALIDATED tier, and says so.' };
}
function buildNfl() {
  let ledger = null; try { ledger = JSON.parse(fs.readFileSync(NFL_LEDGER, 'utf8')); } catch (_) { ledger = null; }
  const games = ledger && ledger.games ? Object.values(ledger.games) : [];
  const closed = games.filter((g) => g.closed && g.open && g.close && g.open.home_line != null && g.close.home_line != null);
  return { schema: 'edgedesk_movement_validation_v1', sport: 'americanfootball_nfl', generated_at: new Date().toISOString(),
    frame: { ledger: path.relative(ROOT, NFL_LEDGER), games_captured: games.length, games_closed: closed.length, started_at: ledger ? ledger.started_at : null, basis: 'EdgeDesk’s own opener captures from the nflverse consensus feed; no historical NFL opener archive is on file, so the test accumulates from the ledger’s first capture' },
    rules: RULES, thresholds: THRESHOLDS,
    result: { n: closed.length, tier: 'RESEARCH', required_gap_points: null, tier_basis: closed.length < RULES.lean.min_n ? 'NOT_ESTABLISHED: ' + closed.length + ' closed games in the ledger; ' + RULES.lean.min_n + ' are the floor for a reading' : 'the ledger has enough closed games; wire the desk’s fair line at capture into this test', moves_so_far: closed.length ? { mean_abs_move: r3(mean(closed.map((g) => Math.abs(g.close.home_line - g.open.home_line)))), moved: closed.filter((g) => g.close.home_line !== g.open.home_line).length } : null },
    note: 'Accumulates with the ledger. Until the floor is reached the kernel says NO READ for NFL movement.' };
}
function main() {
  const args = process.argv.slice(2); const sport = args.includes('--sport') ? args[args.indexOf('--sport') + 1] : 'cfb';
  const art = sport === 'nfl' ? buildNfl() : buildCfb();
  const out = path.join(OUT_DIR, 'movement_' + sport + '.json');
  const r = art.result;
  console.log(`movement validation (${sport}): ${r.tier}${r.required_gap_points != null ? ' at ' + r.required_gap_points + '+ points' : ''} — ${r.tier_basis}`);
  if (r.toward_rating_by_gap) Object.keys(r.toward_rating_by_gap).sort((a, b) => a - b).forEach((k) => { const e = r.toward_rating_by_gap[k], o = r.open_vs_close_by_gap[k]; console.log(`  gap >= ${k}: n ${e.n} toward ${e.toward_rate} p ${e.p_one_sided} later ${e.later.toward_rate}; cover at open ${o.cover_at_open} vs close ${o.cover_at_close}, +${o.points_gained_by_betting_early} pts early`); });
  if (r.regression) console.log(`  move regression: MAE ${r.regression.pooled_mae_pred} vs no-move ${r.regression.pooled_mae_no_move}; move per gap point ${r.latest && r.latest.move_per_gap_point}`);
  if (args.includes('--check')) { if (!fs.existsSync(out)) { console.error('CHECK: no artifact'); process.exit(1); } const prev = JSON.parse(fs.readFileSync(out, 'utf8')); const strip = (a) => JSON.stringify(Object.assign({}, a, { generated_at: null })); const same = strip(prev) === strip(art); console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build'); process.exit(same ? 0 : 1); }
  console.log(writeIfChanged(out, art, { pretty: true }) + ' ' + path.relative(ROOT, out));
}
module.exports = { cfbRows, score, directionTable, tierOf, passes, ols, buildCfb, buildNfl, RULES, THRESHOLDS };
if (require.main === module) main();
