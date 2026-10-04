#!/usr/bin/env node
/* ===========================================================================
   THE DISAGREEMENT EXPLAINER'S FIT (audit 2026-09-30 follow-up #3).

   lib/edgedesk_explainer.js splits a model-market gap into eight measured
   terms of EdgeDesk's own projection and says how much of each the closing
   market has historically taken out. This fits those discounts:

        G = fair − close = β0 + Σ β_k · x_k + ε        (OLS, every FBS-vs-FBS game)

   FIT 2021-2023, HOLDOUT 2024-2025 scored once (R² of the gap, and the mean
   |gap| against the mean |unexplained|); SHIP refitted on 2021-2025, judged
   on that holdout. A β is reported with its standard error and marked
   significant only when |t| >= 1.96 on the fit years. The close is the
   explainer's TARGET — the thing being explained — never an input to a
   rating or a price.

   Rows: football/cfb_p4/research/replay_rows.js --explainer (a cold replay of
   the shipped engine; the terms are computed by the same termsFromProjection
   the live board calls).

     node tools/football/explainer_fit.js --data D            # print
     node tools/football/explainer_fit.js --data D --write    # football/validation/disagreement_explainer.json
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const X = require(path.join(ROOT, 'lib', 'edgedesk_explainer.js'));

const SCHEMA = 'edgedesk_disagreement_explainer_fit_v1';
const RULES = { fit: [2021, 2023], holdout: [2024, 2025], ship: [2021, 2025], t_significant: 1.96 };
const OUT = path.join(ROOT, 'football', 'validation', 'disagreement_explainer.json');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); if (i < 0) return dflt; const v = process.argv[i + 1]; return (v == null || v.slice(0, 2) === '--') ? true : v; }
function r3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }
function r4(x) { return x == null ? null : Math.round(x * 10000) / 10000; }

/* the terms that VARY in the rows: a cold replay has no efficiency or injury
   feeds, so matchup and other are 0 on every game and cannot be fitted; they
   ship with no discount (named unfitted), never with an invented one */
function activeTerms(rows) {
  return X.TERMS.filter((k) => { let lo = Infinity, hi = -Infinity; rows.forEach((r) => { lo = Math.min(lo, r.terms[k]); hi = Math.max(hi, r.terms[k]); }); return hi - lo > 1e-9; });
}
/* ordinary least squares with an intercept: returns { b: [β0, β1..], se, n, sigma, K } */
function ols(rows, K) {
  const p = K.length + 1, XtX = [], Xty = new Array(p).fill(0);
  for (let i = 0; i < p; i++) XtX.push(new Array(p).fill(0));
  rows.forEach((r) => {
    const x = [1].concat(K.map((k) => r.terms[k])), y = r.fair - r.close;
    for (let i = 0; i < p; i++) { Xty[i] += x[i] * y; for (let j = 0; j < p; j++) XtX[i][j] += x[i] * x[j]; }
  });
  const inv = invert(XtX), b = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  let rss = 0; rows.forEach((r) => { const x = [1].concat(K.map((k) => r.terms[k])); const e = (r.fair - r.close) - x.reduce((s, v, j) => s + v * b[j], 0); rss += e * e; });
  const s2 = rss / (rows.length - p);
  return { b, se: inv.map((row, i) => Math.sqrt(Math.max(0, s2 * row[i]))), n: rows.length, sigma: Math.sqrt(s2), K };
}
function invert(A) {
  const n = A.length, M = A.map((row, i) => row.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c]; if (Math.abs(d) < 1e-12) throw new Error('singular design: a term never varies in the fit window');
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row) => row.slice(n));
}
function asFit(o, fittedOn) {
  const coef = {}, se = {}, sig = {};
  o.K.forEach((k, i) => { coef[k] = r4(o.b[i + 1]); se[k] = r4(o.se[i + 1]); sig[k] = Math.abs(o.b[i + 1] / o.se[i + 1]) >= RULES.t_significant; });
  const unfitted = X.TERMS.filter((k) => o.K.indexOf(k) < 0);
  return { version: X.VERSION, fitted_on: fittedOn, games: o.n, intercept: r4(o.b[0]), intercept_se: r4(o.se[0]), coef, se, significant: sig,
    unfitted, unfitted_why: unfitted.length ? 'zero on every replayed game (the cold replay carries no efficiency or injury feed), so no discount can be measured: shown, never discounted' : null,
    residual_sd: r3(o.sigma) };
}
function score(fit, rows) {
  let sg = 0, su = 0, ss = 0, sr = 0, mean = 0;
  rows.forEach((r) => { mean += r.fair - r.close; }); mean /= rows.length;
  rows.forEach((r) => {
    const g = r.fair - r.close, e = X.explain(r.terms, r.fair, r.close, fit);
    sg += Math.abs(g); su += Math.abs(e.unexplained_points); ss += (g - mean) * (g - mean); sr += e.unexplained_points * e.unexplained_points;
  });
  const big = rows.filter((r) => Math.abs(r.fair - r.close) >= 7);
  let bg = 0, bu = 0; big.forEach((r) => { bg += Math.abs(r.fair - r.close); bu += Math.abs(X.explain(r.terms, r.fair, r.close, fit).unexplained_points); });
  return { games: rows.length, r2: r4(1 - sr / ss), mean_abs_gap: r3(sg / rows.length), mean_abs_unexplained: r3(su / rows.length),
    gaps_7_plus: { games: big.length, mean_abs_gap: big.length ? r3(bg / big.length) : null, mean_abs_unexplained: big.length ? r3(bu / big.length) : null } };
}

function main() {
  const data = arg('data', null);
  if (!data) throw new Error('--data <cfbfastR cache with sched/ and out/> is required');
  const RR = require(path.join(ROOT, 'football', 'cfb_p4', 'research', 'replay_rows.js'));
  const all = RR.replayRows({ data, from: RULES.fit[0], to: RULES.ship[1], explainer: true }).rows.filter((r) => r.close != null && r.terms);
  const sel = (lo, hi) => all.filter((r) => r.season >= lo && r.season <= hi);
  const fitRows = sel(RULES.fit[0], RULES.fit[1]), K = activeTerms(fitRows);
  const evalFit = asFit(ols(fitRows, K), RULES.fit.join('-'));
  const holdout = score(evalFit, sel(RULES.holdout[0], RULES.holdout[1]));
  const ship = asFit(ols(sel(RULES.ship[0], RULES.ship[1]), K), RULES.ship.join('-'));
  ship.holdout = holdout;               /* the record the shipped discounts are judged on */
  const art = { schema: SCHEMA, generated_at: new Date().toISOString(), rules: RULES, terms: X.TERMS, labels: X.LABEL,
    target: 'fair − close (home margin), every FBS-vs-FBS game with a close', market_is_an_input: false,
    source: 'football/cfb_p4/research/replay_rows.js --explainer (cold replay of the shipped engine; cfbfastR schedules, closing archive, regime history)',
    evaluation_fit: evalFit, holdout, explainer: ship };
  console.log(JSON.stringify(art, null, 1));
  if (arg('write', false)) { fs.writeFileSync(OUT, JSON.stringify(art, null, 1) + '\n'); console.error('[write] ' + path.relative(ROOT, OUT)); }
}
if (require.main === module) main();
module.exports = { ols, asFit, score, activeTerms, RULES, SCHEMA };
