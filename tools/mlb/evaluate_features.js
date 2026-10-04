#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — do the historical features predict anything, out of sample?

   THE QUESTION THIS CAN HONESTLY ASK. The archive is SEASON-LEVEL. It carries
   no game logs, no dates and no as-of snapshots, so it cannot be used to
   predict a game inside a season without leaking that season's own result into
   the prediction. The one chronologically clean question it can answer is:

     standing at the start of a season, knowing only completed prior seasons,
     how well can a pitcher's NEXT-SEASON rate be predicted, and does adding
     history beat the obvious answer of "the same as last year"?

   So that is the question asked, and the answer is reported whether or not it
   flatters the features.

   HOW THE EVALUATION IS KEPT HONEST
     - Walk forward. For a target season S, every predictor is built from
       seasons strictly earlier than S. The fitted model is REFIT at each S on
       pairs with season < S only; nothing is fit once on everything.
     - The league reference for season S is the league's PRIOR season, because
       season S's league value is not knowable at the start of it.
     - Stratified on the PRIOR season's role, which is known in advance.
       Stratifying on the outcome season's role would be conditioning on the
       future.
     - 2020 is excluded as a target season by default and reported separately.
       A 60-game season is not a year, and rescaling it would invent innings.
     - The incumbent to beat is CARRY FORWARD — last season's own number. Any
       result that does not beat it is a result that does not matter.

   WHAT IT IS NOT. It is not a game model, not a betting edge, and not
   connected to any live EdgeDesk price. performance_index is never converted
   into a probability or an odds number here or anywhere else. Nothing this
   script produces is promoted to a model: the registry
   (research_model_current) is untouched, and a candidate that has not beaten
   the incumbent out of sample has earned nothing.

     node tools/mlb/evaluate_features.js
     node tools/mlb/evaluate_features.js --target era --write
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const D = require('./dataset.js');
const F = require('./pitcher_features.js');

const OUT_DIR = path.join(ROOT, 'mlb', 'pitchers', 'validation');

/* The targets this evaluation supports, with the minimum workload a target
   needs for the rate to mean anything, per role. A rate over nine innings is
   noise; requiring a sample is a statement about measurability, not a feature.
   The thresholds are the ones the query layer's own boards use. */
const TARGETS = {
  k_minus_bb_pct: { label: 'K-BB%', better: 'higher', digits: 4,
    minOuts: { starter: 240, reliever: 90, mixed: 150 } },
  era: { label: 'ERA', better: 'lower', digits: 3,
    minOuts: { starter: 240, reliever: 90, mixed: 150 } },
  k_pct: { label: 'K%', better: 'higher', digits: 4,
    minOuts: { starter: 240, reliever: 90, mixed: 150 } },
  bb_pct: { label: 'BB%', better: 'lower', digits: 4,
    minOuts: { starter: 240, reliever: 90, mixed: 150 } }
};

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function flag(n) { return process.argv.indexOf('--' + n) >= 0; }
const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/* ── a very small least-squares, with ridge for conditioning ──────────────
   Normal equations solved by Gaussian elimination with partial pivoting. Ridge
   is applied to the slopes only, never the intercept, and it is a FIXED
   constant rather than a tuned one: tuning it on the evaluation seasons would
   be the leak this whole file exists to avoid. */
function fitRidge(X, y, lambda) {
  const n = X.length, p = X[0].length;
  const A = [], b = [];
  for (let i = 0; i < p; i++) { A.push(new Array(p).fill(0)); b.push(0); }
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < p; i++) {
      b[i] += X[r][i] * y[r];
      for (let j = 0; j < p; j++) A[i][j] += X[r][i] * X[r][j];
    }
  }
  for (let i = 1; i < p; i++) A[i][i] += lambda * n;   // column 0 is the intercept
  /* solve */
  const m = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    const t = m[c]; m[c] = m[piv]; m[piv] = t;
    for (let r = 0; r < p; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= p; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[p] / row[i][i] !== undefined ? row[p] / m[i][i] : 0);
}

/* The as-of feature vector the fitted candidate uses. Every one of these is
   computable before the target season; a missing one is filled with the
   TRAINING mean, which is itself computed only from training rows. */
const FITTED = ['prior_value', 'base_value', 'prior_innings', 'base_innings',
  'prior_era_minus_fip', 'trend_value', 'workload_change_pct', 'prior_age',
  'seasons_before', 'role_changed_flag', 'team_changed_flag', 'gap_flag'];

function vectorFor(f, target, league) {
  const priorV = num(f['prior_' + target]);
  const baseV = num(f['base_' + target]);
  const trendV = num(f['trend_' + target]);
  return {
    prior_value: priorV, base_value: baseV,
    prior_innings: num(f.prior_innings), base_innings: num(f.base_innings),
    prior_era_minus_fip: num(f.prior_era_minus_fip),
    trend_value: trendV,
    workload_change_pct: num(f.workload_change_pct),
    prior_age: num(f.prior_age),
    seasons_before: num(f.seasons_before),
    role_changed_flag: f.role_changed_before === true ? 1 : 0,
    team_changed_flag: f.team_changed_before === true ? 1 : 0,
    gap_flag: (num(f.prior_gap) ?? 0) > 0 ? 1 : 0,
    _league: league
  };
}

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function mae(errs) { return errs.length ? mean(errs.map(Math.abs)) : null; }
function rmse(errs) { return errs.length ? Math.sqrt(mean(errs.map((e) => e * e))) : null; }
/* Standard error of the mean paired difference. Not a p-value and not framed
   as one: it is the spread on the number being quoted, so a difference smaller
   than it can be read for what it is. */
function seOfMean(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
}
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const r6 = (v) => (v == null ? null : Math.round(v * 1000000) / 1000000);

function evaluate(opts) {
  opts = opts || {};
  const target = TARGETS[opts.target] ? opts.target : 'k_minus_bb_pct';
  const spec = TARGETS[target];
  const seasons = opts.seasonRows;
  const features = F.buildFeatures(seasons);
  const league = F.leagueByRole(seasons, { minOuts: 0, pitchersOnly: true });
  const coverage = {
    start: Math.min.apply(null, seasons.map((r) => Number(r.season))),
    end: Math.max.apply(null, seasons.map((r) => Number(r.season)))
  };
  const excludeShortened = opts.includeShortened !== true;

  /* The evaluation population. Every condition is stated, and every one of
     them is either known before the season (the role, the prior sample) or a
     statement about whether the OUTCOME is measurable at all (its innings,
     which is not a feature and is not used as one). */
  const usable = features.filter((f) => {
    if (f.seasons_before < 1) return false;                       // nothing was known
    if (f.prior_role == null) return false;                       // no role to stratify on
    if (f.position_reported && f.position_reported !== 'P') return false;  // position players
    if (num(f['prior_' + target]) == null) return false;          // the incumbent needs a number
    if (num(f['outcome_' + target]) == null) return false;        // the outcome must be defined
    const minOuts = spec.minOuts[f.prior_role] ?? spec.minOuts.mixed;
    if ((num(f.outcome_outs) ?? 0) < minOuts) return false;
    if ((num(f.prior_outs) ?? 0) < Math.round(minOuts / 2)) return false;
    return true;
  });

  const targetSeasons = [];
  for (let s = coverage.start + 1; s <= coverage.end; s++) {
    if (excludeShortened && s === 2020) continue;
    targetSeasons.push(s);
  }

  const METHODS = ['league_prior', 'carry_forward', 'baseline_3y', 'shrunk', 'fitted'];
  const errs = {}; METHODS.forEach((m) => { errs[m] = []; });
  const perSeason = [];
  const byRole = {};
  const paired = {}; METHODS.forEach((m) => { paired[m] = []; });
  let fittedRefits = 0, fittedSkipped = 0;

  for (const S of targetSeasons) {
    const test = usable.filter((f) => f.season === S);
    if (!test.length) continue;
    /* TRAINING IS EVERYTHING STRICTLY EARLIER. Refit per target season. */
    const train = usable.filter((f) => f.season < S);

    /* the shrinkage constant, chosen on TRAINING rows only */
    const K = chooseShrinkage(train, target, league, S);

    /* the fitted candidate, refit on training rows only */
    let model = null;
    if (train.length >= 200) {
      model = fitOn(train, target, league, S);
      if (model) fittedRefits++; else fittedSkipped++;
    } else fittedSkipped++;

    const seasonErr = {}; METHODS.forEach((m) => { seasonErr[m] = []; });
    for (const f of test) {
      const actual = num(f['outcome_' + target]);
      const lg = leagueRef(league, f, target, S);
      const preds = {
        league_prior: lg,
        carry_forward: num(f['prior_' + target]),
        baseline_3y: num(f['base_' + target]) ?? num(f['prior_' + target]),
        shrunk: shrink(f, target, lg, K),
        fitted: model ? predict(model, vectorFor(f, target, lg), lg) : null
      };
      METHODS.forEach((m) => {
        const p = preds[m];
        if (p == null) return;
        const e = p - actual;
        errs[m].push(e); seasonErr[m].push(e);
        const role = f.prior_role;
        byRole[role] = byRole[role] || {};
        byRole[role][m] = byRole[role][m] || [];
        byRole[role][m].push(e);
      });
      /* paired against the incumbent, on rows where BOTH produced a number */
      const cf = preds.carry_forward;
      if (cf != null) {
        METHODS.forEach((m) => {
          if (m === 'carry_forward') return;
          if (preds[m] == null) return;
          paired[m].push(Math.abs(preds[m] - actual) - Math.abs(cf - actual));
        });
      }
    }
    perSeason.push({
      season: S, n: test.length, train_rows: train.length, shrinkage_k: r4(K),
      fitted: !!model,
      mae: METHODS.reduce((a, m) => { a[m] = r6(mae(seasonErr[m])); return a; }, {})
    });
  }

  const summary = METHODS.map((m) => ({
    method: m, n: errs[m].length,
    mae: r6(mae(errs[m])), rmse: r6(rmse(errs[m])),
    /* The number that decides everything: mean |error| minus the incumbent's,
       per row, with the spread on that mean. Negative is better than carry
       forward. */
    vs_carry_forward: m === 'carry_forward' ? null : {
      mean_mae_difference: r6(mean(paired[m])),
      standard_error: r6(seOfMean(paired[m])),
      pairs: paired[m].length,
      beats_incumbent: paired[m].length ? mean(paired[m]) < 0 : null,
      beats_incumbent_beyond_its_own_spread: (paired[m].length > 2 && seOfMean(paired[m]))
        ? (mean(paired[m]) + 2 * seOfMean(paired[m]) < 0) : null
    }
  }));

  const roleSummary = {};
  Object.keys(byRole).forEach((role) => {
    roleSummary[role] = METHODS.reduce((a, m) => {
      a[m] = { n: (byRole[role][m] || []).length, mae: r6(mae(byRole[role][m] || [])) };
      return a;
    }, {});
  });

  /* 2020, reported rather than hidden */
  const shortened = { as_target: null, in_baselines: null };
  {
    const t2020 = usable.filter((f) => f.season === 2020);
    shortened.as_target = { rows: t2020.length, excluded: excludeShortened,
      note: excludeShortened
        ? '2020 is excluded as a target season: 60 games is not a year, and a rate over a third of the usual sample '
          + 'is a different measurement rather than a harder one.'
        : '2020 is INCLUDED as a target season by request; its errors are not comparable with a full season.' };
    const withIt = usable.filter((f) => (num(f.base_share_from_2020) ?? 0) > 0);
    shortened.in_baselines = { rows: withIt.length,
      median_share: r4(median(withIt.map((f) => num(f.base_share_from_2020)).filter((x) => x != null))),
      note: 'These rows carry 2020 innings inside their multi-year baseline. The share is stated on every feature row '
        + 'so a caller can drop them; they are kept here because dropping every 2021-2023 row would leave almost nothing.' };
  }

  const best = summary.filter((s) => s.method !== 'carry_forward' && s.mae != null)
    .sort((a, b) => a.mae - b.mae)[0] || null;
  const incumbent = summary.filter((s) => s.method === 'carry_forward')[0] || null;
  const improved = !!(best && incumbent && best.mae != null && incumbent.mae != null && best.mae < incumbent.mae);
  const convincing = !!(best && best.vs_carry_forward && best.vs_carry_forward.beats_incumbent_beyond_its_own_spread);

  return {
    schema: 'edgedesk_mlb_feature_evaluation_v1',
    generated_at: new Date().toISOString(),
    target, target_label: spec.label,
    coverage, target_seasons: targetSeasons,
    population: {
      rows: usable.length,
      rule: 'pitcher-seasons with at least one completed prior season, a defined prior and outcome value, a '
        + 'source-reported position of P, a prior workload of at least half the minimum, and an outcome workload of at '
        + 'least the per-role minimum. The outcome workload filter is a statement about whether the rate is measurable '
        + 'at all, not a feature, and it is the only condition that reads the target season.',
      minimum_outs: spec.minOuts,
      stratified_on: 'the PRIOR season’s role, which is known before the season being predicted. Stratifying on the '
        + 'outcome season’s role would be conditioning on the future.'
    },
    methods: {
      league_prior: 'the league’s value for this role in the PRIOR season (nothing about the pitcher)',
      carry_forward: 'the pitcher’s own value last season — THE INCUMBENT. A candidate that does not beat this has earned nothing.',
      baseline_3y: 'the innings-weighted value over up to three prior seasons, recomputed from counting statistics',
      shrunk: 'the three-year baseline shrunk toward the prior league value by outs/(outs+K), with K chosen on TRAINING seasons only',
      fitted: 'ridge regression on twelve as-of features, REFIT at every target season on pairs strictly earlier than it'
    },
    fitted_features: FITTED,
    refits: { fitted: fittedRefits, skipped: fittedSkipped },
    results: summary,
    by_prior_role: roleSummary,
    per_season: perSeason,
    shortened_season: shortened,
    verdict: {
      improved_on_incumbent: improved,
      improvement_survives_its_own_spread: convincing,
      best_candidate: best ? best.method : null,
      statement: verdictSentence(best, incumbent, improved, convincing, spec)
    },
    promotion: {
      promoted: false,
      registry: 'research_model_current',
      rule: 'Nothing here is promoted. EdgeDesk promotes a model only on a chronological out-of-sample record against '
        + 'the incumbent, and a next-season RATE forecast is not a game model in any case. No live price, fair line or '
        + 'EV reads any of this.'
    },
    not_a_price: 'performance_index and every feature above are DESCRIPTIVE. None is converted into a probability, a '
      + 'fair price or a betting edge, here or anywhere else in EdgeDesk.'
  };
}

function median(a) {
  const s = (a || []).slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function verdictSentence(best, incumbent, improved, convincing, spec) {
  if (!best || !incumbent || best.mae == null || incumbent.mae == null) {
    return 'No candidate produced enough predictions to compare with the incumbent.';
  }
  const d = best.vs_carry_forward;
  const pct = ((incumbent.mae - best.mae) / incumbent.mae) * 100;
  const head = `Over ${incumbent.n} chronologically out-of-sample pitcher-seasons, carrying last season's ${spec.label} `
    + `forward gives a mean absolute error of ${incumbent.mae}. The best candidate (${best.method}) gives ${best.mae}`;
  if (!improved) {
    return head + ' — WORSE. None of the history features beat simply using last season, so nothing here is worth '
      + 'wiring into anything.';
  }
  const tail = convincing
    ? ` — better by ${Math.abs(pct).toFixed(1)}%, and the per-row difference (${d.mean_mae_difference}, standard error `
      + `${d.standard_error}) is more than twice its own spread away from zero. That is a real if modest improvement in `
      + `NEXT-SEASON RATE ACCURACY. It is not a game model, not an edge, and nothing has been promoted on it.`
    : ` — better by ${Math.abs(pct).toFixed(1)}%, but the per-row difference (${d.mean_mae_difference}, standard error `
      + `${d.standard_error}) is within twice its own spread of zero. Treat that as unproven rather than as an `
      + `improvement, and do not wire it into anything.`;
  return head + tail;
}

/** The league reference: the PRIOR season's league value for that role. */
function leagueRef(league, f, target, S) {
  for (let s = S - 1; s >= S - 4; s--) {
    const row = league.get(`${s}|${f.prior_role}`);
    if (row && num(row[target]) != null) return num(row[target]);
  }
  return null;
}

function shrink(f, target, lg, K) {
  const v = num(f['base_' + target]) ?? num(f['prior_' + target]);
  const outs = num(f.base_outs) ?? num(f.prior_outs) ?? 0;
  if (v == null) return null;
  if (lg == null || !K) return v;
  const w = outs / (outs + K);
  return w * v + (1 - w) * lg;
}

/** K chosen by a grid search on TRAINING rows only. Never on the target season. */
function chooseShrinkage(train, target, league, S) {
  if (train.length < 50) return 300;
  const grid = [0, 50, 100, 200, 300, 500, 800, 1200, 2000];
  let bestK = 300, bestErr = Infinity;
  for (const K of grid) {
    const errs = [];
    for (const f of train) {
      const lg = leagueRef(league, f, target, f.season);
      const p = shrink(f, target, lg, K);
      const a = num(f['outcome_' + target]);
      if (p == null || a == null) continue;
      errs.push(Math.abs(p - a));
    }
    const m = mean(errs);
    if (m != null && m < bestErr) { bestErr = m; bestK = K; }
  }
  return bestK;
}

/** Fit the ridge candidate on training rows, standardising on training moments. */
function fitOn(train, target, league, S) {
  const rows = [];
  for (const f of train) {
    const a = num(f['outcome_' + target]);
    if (a == null) continue;
    const lg = leagueRef(league, f, target, f.season);
    rows.push({ v: vectorFor(f, target, lg), y: a });
  }
  if (rows.length < 200) return null;
  const means = {}, sds = {};
  FITTED.forEach((k) => {
    const vals = rows.map((r) => r.v[k]).filter((x) => x != null);
    const m = mean(vals) ?? 0;
    const sd = Math.sqrt(mean(vals.map((x) => (x - m) * (x - m))) ?? 0) || 1;
    means[k] = m; sds[k] = sd;
  });
  const X = rows.map((r) => [1].concat(FITTED.map((k) => ((r.v[k] ?? means[k]) - means[k]) / sds[k])));
  const y = rows.map((r) => r.y);
  const beta = fitRidge(X, y, 1e-3);
  if (!beta || beta.some((b) => !Number.isFinite(b))) return null;
  return { beta, means, sds, target };
}

function predict(model, v) {
  const x = [1].concat(FITTED.map((k) => ((v[k] ?? model.means[k]) - model.means[k]) / model.sds[k]));
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * model.beta[i];
  return Number.isFinite(s) ? s : null;
}

function render(res) {
  const L = [];
  L.push(`MLB next-season ${res.target_label}: a chronological out-of-sample evaluation`);
  L.push(`coverage ${res.coverage.start}–${res.coverage.end}; target seasons ${res.target_seasons.join(', ')}`);
  L.push(`population ${res.population.rows} pitcher-seasons, stratified on the prior season's role`);
  L.push('');
  L.push('  method            n      MAE        RMSE       vs carry forward (per row, +/- its spread)');
  res.results.forEach((r) => {
    const d = r.vs_carry_forward;
    L.push('  ' + r.method.padEnd(16) + String(r.n).padEnd(7)
      + String(r.mae == null ? '—' : r.mae).padEnd(11)
      + String(r.rmse == null ? '—' : r.rmse).padEnd(11)
      + (d ? `${d.mean_mae_difference >= 0 ? '+' : ''}${d.mean_mae_difference} ± ${d.standard_error}`
        + (d.beats_incumbent_beyond_its_own_spread ? '   BETTER' : d.beats_incumbent ? '   better, within its spread' : '   worse')
        : '   (the incumbent)'));
  });
  L.push('');
  Object.keys(res.by_prior_role).forEach((role) => {
    const r = res.by_prior_role[role];
    L.push(`  by prior role — ${role}: ` + Object.keys(r).map((m) => `${m} ${r[m].mae} (n=${r[m].n})`).join('  '));
  });
  L.push('');
  L.push('  ' + res.verdict.statement);
  L.push('');
  L.push('  ' + res.shortened_season.as_target.note);
  L.push('  ' + res.promotion.rule);
  return L.join('\n');
}

function main() {
  const target = String(arg('target', 'k_minus_bb_pct'));
  const ds = D.loadDataset(arg('dir', D.DEFAULT_DIR));
  const res = evaluate({ seasonRows: ds.rows.pitcher_seasons, target,
    includeShortened: flag('include-2020') });
  console.log(render(res));
  if (flag('write')) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `next_season_${target}.json`);
    fs.writeFileSync(file, JSON.stringify(res, null, 2) + '\n');
    console.log(`\nwritten to ${path.relative(ROOT, file)}`);
  }
}

module.exports = { evaluate, render, TARGETS, FITTED, OUT_DIR, leagueRef, shrink, chooseShrinkage, fitOn, predict };

if (require.main === module) main();
