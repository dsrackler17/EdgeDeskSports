#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL research — do the data pack's lagged features add anything to
   my model? (2024-25, chronological hold-out)

     node hockey/research/pack_features.js           writes hockey/validation/nhl_pack_features.json
     node hockey/research/pack_features.js --check   the committed result holds (recomputed when the cache is present)

   The NHL data pack ships prior-5/10/20-game features per team-game
   (datapack/nhl_v1/data/pregame_lagged_research_features.csv), every value
   recomputed by tools/datapack/verify_nhl.js with the target game excluded.
   My walk-forward model already prices each game from information before it.
   The question: given my model's out-of-sample moneyline probability, does a
   pack feature still predict the result?

   Declared before looking at any result:
     features (home − away): Corsi share prior 10, Fenwick share prior 10,
       regulation goal difference per game prior 10, hours since the previous
       scheduled start (capped at 96), games in the prior 7 days;
     rows: 2024-25 games where both teams have 10 prior games;
     split: the first half of those games by date fits, the second half
       scores — nothing from the scoring half is seen while fitting;
     baseline: my model's probability, recalibrated on the fitting half
       (logit a + b·logit p) so the challenger cannot win on calibration alone;
     challenger: the same plus the feature(s), lightly ridged (λ = 1 on
       standardised features);
     a feature ADDS INFORMATION only if the scoring-half log loss improves by
       at least 0.001 and the 95% block-bootstrap interval (blocks = dates)
       lies below zero — the same bar a challenger meets in the walk-forward.

   Reads my per-game predictions from the cache (.cache/nhl_work/predictions.jsonl,
   written by hockey/model/walkforward.js). The pack's features are
   retrospective (first publication unknown): this is research, never a price.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readCsv } = require('../../engine/csv');

const SEASON = 2025;
const PREDS = path.join(C.PATHS.cacheWork, 'predictions.jsonl');
const PACK = path.join(C.ROOT, 'datapack', 'nhl_v1', 'data');
const XWALK = path.join(C.HOCKEY, 'data', 'crosswalk', 'espn_nhl_' + SEASON + '.csv');
const OUT = path.join(C.PATHS.validation, 'nhl_pack_features.json');
const FEATURES = {
  corsi_share_prior_10: (r) => +r.corsi_share_prior_10,
  fenwick_share_prior_10: (r) => +r.fenwick_share_prior_10,
  regulation_goal_diff_prior_10: (r) => +r.regulation_goals_for_pergame_prior_10 - +r.regulation_goals_against_pergame_prior_10,
  hours_since_previous_start: (r) => Math.min(96, +r.hours_between_scheduled_starts),
  games_in_prior_7_days: (r) => +r.games_in_prior_7_days,
};
const r6 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const logit = (p) => Math.log(p / (1 - p));
const sig = (z) => 1 / (1 + Math.exp(-z));
const ll = (p, y) => -(y ? Math.log(p) : Math.log(1 - p));

/** ridge logistic regression by Newton steps; X rows include the intercept; pen[j] = 0 leaves column j free */
function fitLogit(X, y, pen) {
  const k = X[0].length; let b = new Array(k).fill(0);
  for (let it = 0; it < 50; it++) {
    const g = new Array(k).fill(0); const H = [...Array(k)].map(() => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const p = sig(X[i].reduce((s, x, j) => s + x * b[j], 0)); const w = p * (1 - p);
      for (let j = 0; j < k; j++) { g[j] += (p - y[i]) * X[i][j]; for (let l = 0; l < k; l++) H[j][l] += w * X[i][j] * X[i][l]; }
    }
    for (let j = 0; j < k; j++) { g[j] += pen[j] * b[j]; H[j][j] += pen[j]; }
    /* solve H d = g (Gauss-Jordan) */
    const A = H.map((row, i) => row.concat([g[i]]));
    for (let c = 0; c < k; c++) { let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r; [A[c], A[p]] = [A[p], A[c]]; for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let l = c; l <= k; l++) A[r][l] -= f * A[c][l]; } }
    const d = A.map((row, i) => row[k] / row[i]);
    b = b.map((v, j) => v - d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-10) break;
  }
  return b;
}

function rows() {
  if (!fs.existsSync(PREDS)) return null;
  const chosen = JSON.parse(fs.readFileSync(path.join(C.PATHS.validation, 'nhl_walkforward.json'), 'utf8')).selection.chosen;
  const xw = new Map(readCsv(XWALK).rows.map((r) => [String(r.nhl_game_id), r]));
  const games = new Map(readCsv(path.join(PACK, 'games.csv')).rows.map((g) => [g.game_id, g]));
  const lag = new Map(readCsv(path.join(PACK, 'pregame_lagged_research_features.csv')).rows.map((r) => [r.game_id + '|' + r.team_id, r]));
  const out = [];
  for (const line of fs.readFileSync(PREDS, 'utf8').split('\n')) {
    if (!line) continue; const p = JSON.parse(line);
    if (p.season !== SEASON || p.type !== 'R') continue;
    const x = xw.get(String(p.game_id)); if (!x) continue;
    const g = games.get(String(x.espn_game_id));
    const h = lag.get(g.game_id + '|' + g.home_id), a = lag.get(g.game_id + '|' + g.away_id);
    if (!h || !a || +h.games_exposure_prior_10 < 10 || +a.games_exposure_prior_10 < 10) continue;
    const f = {}; for (const [k, fn] of Object.entries(FEATURES)) f[k] = fn(h) - fn(a);
    if (Object.values(f).some((v) => !isFinite(v))) continue;
    out.push({ game_id: p.game_id, date: p.date, p: p.p[chosen].ml, y: p.y.hw, f });
  }
  return { chosen, rows: out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id - b.game_id)) };
}

function evaluate(data) {
  const R = data.rows; const half = Math.floor(R.length / 2);
  /* keep a date whole on one side */
  let cut = half; while (cut < R.length && R[cut].date === R[cut - 1].date) cut++;
  const fitR = R.slice(0, cut), scoreR = R.slice(cut);
  const names = Object.keys(FEATURES);
  const mu = {}, sd = {};
  for (const k of names) { const v = fitR.map((r) => r.f[k]); mu[k] = v.reduce((s, x) => s + x, 0) / v.length; sd[k] = Math.sqrt(v.reduce((s, x) => s + (x - mu[k]) ** 2, 0) / (v.length - 1)) || 1; }
  const design = (r, feats) => [1, logit(r.p)].concat(feats.map((k) => (r.f[k] - mu[k]) / sd[k]));
  const score = (feats) => {
    const b = fitLogit(fitR.map((r) => design(r, feats)), fitR.map((r) => r.y), [0, 0].concat(feats.map(() => 1)));
    return { b, losses: scoreR.map((r) => ll(Math.min(1 - 1e-12, Math.max(1e-12, sig(design(r, feats).reduce((s, x, j) => s + x * b[j], 0)))), r.y)) };
  };
  const base = score([]);
  const dates = [...new Set(scoreR.map((r) => r.date))];
  const idxByDate = new Map(dates.map((d) => [d, []])); scoreR.forEach((r, i) => idxByDate.get(r.date).push(i));
  const boot = (diff) => {
    let s = 0x5eed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const means = [];
    for (let b = 0; b < 2000; b++) { let tot = 0, n = 0; for (let k = 0; k < dates.length; k++) { for (const i of idxByDate.get(dates[Math.floor(rnd() * dates.length)])) { tot += diff[i]; n++; } } means.push(tot / n); }
    means.sort((a, b) => a - b); return [means[49], means[1949]];
  };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const tests = {};
  for (const feats of names.map((k) => [k]).concat([names])) {
    const c = score(feats); const diff = c.losses.map((l, i) => l - base.losses[i]);
    const d = mean(diff); const ci = boot(diff);
    tests[feats.length > 1 ? 'all_five' : feats[0]] = { log_loss_change: r6(d), ci95: ci.map(r6), coefficients_per_sd: feats.reduce((o, k, j) => Object.assign(o, { [k]: r6(c.b[2 + j]) }), {}), adds_information: d <= -0.001 && ci[1] < 0 };
  }
  return {
    chosen_model: data.chosen, games: R.length, fit_games: fitR.length, score_games: scoreR.length,
    fit_window: [fitR[0].date, fitR[fitR.length - 1].date], score_window: [scoreR[0].date, scoreR[scoreR.length - 1].date],
    baseline_score_log_loss: r6(mean(base.losses)), baseline_recalibration: { intercept: r6(base.b[0]), slope: r6(base.b[1]) },
    tests,
  };
}

function build() {
  const data = rows(); if (!data) return null;
  const e = evaluate(data);
  const adds = Object.entries(e.tests).filter(([, t]) => t.adds_information).map(([k]) => k);
  return Object.assign({ schema: 'edgedesk_nhl_pack_features_v1', season: SEASON, question: 'Given my model\'s out-of-sample moneyline probability, does a data-pack lagged feature still predict the result?' }, e,
    { conclusion: adds.length ? 'Adds information on the scoring half: ' + adds.join(', ') + ' — a candidate for a pre-declared walk-forward challenger over several seasons, not a price change.' : 'No pack feature adds information beyond my model on the 2024-25 scoring half; none enters the price.',
      limits: 'One season; the pack\'s lagged features are retrospective (first publication unknown); hours since the previous start is not recovery time or verified travel.' });
}

if (require.main === module) {
  const r = build();
  if (process.argv.includes('--check')) {
    const c = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (r && JSON.stringify(c) !== JSON.stringify(r)) { console.error('[nhl pack features --check] FAILED: the committed result differs from a fresh run'); process.exit(1); }
    if (!c.tests || !c.score_games) { console.error('[nhl pack features --check] FAILED: incomplete report'); process.exit(1); }
    console.log('[nhl pack features --check] ok' + (r ? ' (recomputed)' : ' (no cache: committed report checked)') + ': ' + c.conclusion); process.exit(0);
  }
  if (!r) { console.log('[nhl pack features] no cached predictions (run hockey/model/walkforward.js): nothing written'); process.exit(0); }
  fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
  for (const [k, t] of Object.entries(r.tests)) console.log('[nhl pack features] ' + k + ': Δ log loss ' + t.log_loss_change + ' [' + t.ci95.join(', ') + ']' + (t.adds_information ? ' ADDS' : ''));
  console.log('[nhl pack features] ' + r.conclusion);
}
module.exports = { build, fitLogit };
