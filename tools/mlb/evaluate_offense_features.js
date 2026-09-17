#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — do the OFFENSIVE features predict anything, out of sample?

   THE QUESTION THIS CAN HONESTLY ASK, and the one it cannot.

   The archive is SEASON-LEVEL. It carries no game logs, no dates and no as-of
   snapshots, so it cannot predict a game inside a season without leaking that
   season's own result into a prediction made before it. That rules out a game
   model, and with it every game-level metric: calibration curves, log loss,
   Brier score and CLV are all defined over game-level probabilities against
   settled outcomes, and this dataset produces none of those. Reporting them
   would mean inventing the thing being scored.

   The one chronologically clean question it CAN answer is:

     standing at the start of a season, knowing only completed prior seasons,
     how well can a hitter's NEXT-SEASON rate be predicted, and does adding
     history beat the obvious answer of "the same as last year"?

   So that is the question asked, and the answer is reported whether or not it
   flatters the features.

   HOW THE EVALUATION IS KEPT HONEST
     - Walk forward. For a target season S every predictor is built from
       seasons strictly earlier than S. The fitted candidate is REFIT at each S
       on pairs earlier than it; nothing is fit once on everything.
     - The league reference for season S is the league's PRIOR season, because
       season S's league value is not knowable at the start of it.
     - The workload screen is applied to the PRIOR season, which is known in
       advance. Screening on the outcome season's plate appearances would be
       conditioning on the future — and it is the single easiest way to make a
       forecast look good, because it quietly drops everyone who got hurt.
     - 2020 is excluded as a target by default and reported separately. A
       60-game season is not a year, and rescaling it would invent plate
       appearances.
     - The incumbent to beat is CARRY FORWARD — last season's own number. A
       result that does not beat it is a result that does not matter.

   WHAT IT IS NOT. It is not a game model, not a betting edge, and not
   connected to any live EdgeDesk price. offensive_index is never converted
   into a probability, a total or a player prop here or anywhere else. Nothing
   this script produces is promoted: research_model_current is untouched, and a
   candidate that has not beaten the incumbent out of sample has earned
   nothing.

     node tools/mlb/evaluate_offense_features.js
     node tools/mlb/evaluate_offense_features.js --target obp
     node tools/mlb/evaluate_offense_features.js --write
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const D = require('./offense_dataset.js');
const M = require('../../lib/mlb_offense_history.js');

const OUT_DIR = path.join(ROOT, 'mlb', 'batters', 'validation');

/* The targets worth asking about, with the workload screen each one needs to
   be a question about hitters rather than about pitchers taking an at-bat. */
const TARGETS = {
  k_pct:  { label: 'next-season strikeout rate', dp: 4, minPa: 200 },
  bb_pct: { label: 'next-season walk rate',      dp: 4, minPa: 200 },
  obp:    { label: 'next-season on-base percentage', dp: 4, minPa: 200 },
  slg:    { label: 'next-season slugging',       dp: 4, minPa: 200 },
  iso:    { label: 'next-season isolated power', dp: 4, minPa: 200 },
  offensive_index: { label: 'next-season offensive index', dp: 2, minPa: 200 }
};

/* The as-of features the fitted candidate is allowed to see. Every one is a
   completed prior season. */
const FITTED = ['prior', 'base3', 'trend', 'prior_pa', 'age', 'share_2020'];

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function flag(n) { return process.argv.indexOf('--' + n) >= 0; }

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function mae(errs) { return errs.length ? mean(errs.map(Math.abs)) : null; }
function rmse(errs) { return errs.length ? Math.sqrt(mean(errs.map((e) => e * e))) : null; }
function seOfMean(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1);
  return Math.sqrt(v / a.length);
}
function median(a) {
  if (!a.length) return null;
  const b = a.slice().sort((x, y) => x - y);
  const h = Math.floor(b.length / 2);
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
}

/* ---- the as-of feature rows, built from the committed dataset ------------
   The SQL view mlbhist.batter_prior_features is the production surface; this
   builds the same thing from the package so the evaluation runs without a
   database and so the two can be checked against each other. */
function buildRows(ds) {
  const byPlayer = new Map();
  ds.tables.batter_seasons.forEach((r) => {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id).push(r);
  });
  const out = [];
  byPlayer.forEach((list) => {
    list.sort((a, b) => a.season - b.season);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      const prior = i > 0 ? list[i - 1] : null;
      const prior2 = i > 1 ? list[i - 2] : null;
      /* THE BASELINE ENDS ONE SEASON SHORT. Same frame as the SQL view. */
      const window3 = list.slice(Math.max(0, i - 3), i);
      /* EACH RATE IS WEIGHTED BY ITS OWN DENOMINATOR. A multi-season on-base
         percentage is times-on-base over TIMES UP, and times up is not
         at-bats — it is AB + BB + HBP + SF. Weighting OBP by at-bats
         understates the hitters who walk, which is exactly the population a
         walk-rate question is about. This matches the window frames in
         supabase/mlb_offense_features.sql field for field, and the test
         compares the two row by row. */
      function weighted(field, denom) {
        let n = 0, d = 0;
        window3.forEach((s) => {
          const v = num(s[field]);
          const w = typeof denom === 'function' ? denom(s) : num(s[denom]);
          if (v == null || w == null || w <= 0) return;
          n += v * w; d += w;
        });
        return d > 0 ? n / d : null;
      }
      const onBaseDenom = (s) => {
        const ab = num(s.at_bats), bb = num(s.walks), hbp = num(s.hit_by_pitch);
        if (ab == null || bb == null || hbp == null) return null;
        return ab + bb + hbp + (num(s.sacrifice_flies) || 0);
      };
      /* 0 and null mean different things here: 0 is "three prior seasons, none
         with a plate appearance", null is "no prior seasons at all". The SQL
         view draws the same distinction, so the two agree. */
      const basePa = window3.length
        ? window3.reduce((a, s) => a + (num(s.plate_appearances) || 0), 0) : null;
      const pa2020 = window3.filter((s) => s.season === 2020)
        .reduce((a, s) => a + (num(s.plate_appearances) || 0), 0);
      out.push({
        player_id: cur.player_id, player_name: cur.player_name, season: cur.season,
        seasons_before: i,
        prior_season: prior ? prior.season : null,
        prior_gap: prior ? cur.season - prior.season - 1 : null,
        prior_pa: prior ? num(prior.plate_appearances) : null,
        prior_age: prior ? num(prior.age) : null,
        prior: {
          k_pct: prior ? num(prior.k_pct) : null, bb_pct: prior ? num(prior.bb_pct) : null,
          obp: prior ? num(prior.obp) : null, slg: prior ? num(prior.slg) : null,
          iso: prior ? num(prior.iso) : null,
          offensive_index: prior ? num(prior.offensive_index) : null
        },
        prior2: {
          k_pct: prior2 ? num(prior2.k_pct) : null, bb_pct: prior2 ? num(prior2.bb_pct) : null,
          obp: prior2 ? num(prior2.obp) : null, slg: prior2 ? num(prior2.slg) : null,
          iso: prior2 ? num(prior2.iso) : null,
          offensive_index: prior2 ? num(prior2.offensive_index) : null
        },
        base3: {
          k_pct: weighted('k_pct', 'plate_appearances'),
          bb_pct: weighted('bb_pct', 'plate_appearances'),
          obp: weighted('obp', onBaseDenom),
          slg: weighted('slg', 'at_bats'),
          iso: weighted('iso', 'at_bats'),
          offensive_index: weighted('offensive_index', 'plate_appearances')
        },
        base3_pa: basePa,
        base3_share_2020: (basePa != null && basePa > 0) ? pa2020 / basePa : null,
        outcome: {
          k_pct: num(cur.k_pct), bb_pct: num(cur.bb_pct), obp: num(cur.obp),
          slg: num(cur.slg), iso: num(cur.iso), offensive_index: num(cur.offensive_index),
          plate_appearances: num(cur.plate_appearances)
        }
      });
    }
  });
  return out;
}

/* The league's own prior season, which is what is knowable at the start of S. */
function leagueTable(ds) {
  const by = {};
  ds.tables.league_seasons.forEach((r) => {
    by[r.season] = { k_pct: num(r.k_pct), bb_pct: num(r.bb_pct), obp: num(r.obp),
      slg: num(r.slg), iso: num(r.iso), offensive_index: 100 };
  });
  return by;
}
function leagueRef(league, S, target) {
  const l = league[S - 1];
  return l ? l[target] : null;
}

/* Shrink the multi-year baseline toward the league's prior value. K is chosen
   on the TRAINING seasons only, so it is not fitted on the season being
   scored. */
function shrink(f, target, lg, K) {
  const b = f.base3[target];
  if (b == null || lg == null) return null;
  const pa = f.base3_pa == null ? 0 : f.base3_pa;
  const w = pa / (pa + K);
  return w * b + (1 - w) * lg;
}
function chooseShrinkage(train, target, league) {
  let best = null, bestK = 300;
  for (const K of [0, 50, 100, 200, 300, 500, 800, 1200, 2000]) {
    const errs = [];
    train.forEach((f) => {
      const lg = leagueRef(league, f.season, target);
      const p = shrink(f, target, lg, K);
      const y = f.outcome[target];
      if (p == null || y == null) return;
      errs.push(p - y);
    });
    const m = mae(errs);
    if (m != null && (best == null || m < best)) { best = m; bestK = K; }
  }
  return { K: bestK, trainMae: best };
}

/* A small ridge on the as-of features, refit at every target season. */
function vectorFor(f, target, lg) {
  const p = f.prior[target], b = f.base3[target], p2 = f.prior2[target];
  if (p == null || b == null || lg == null) return null;
  return [
    1,
    p - lg,
    b - lg,
    (p2 == null ? 0 : p - p2),
    Math.log(1 + (f.prior_pa || 0)) - Math.log(1 + 400),
    (f.prior_age == null ? 0 : (f.prior_age - 28) / 10),
    (f.base3_share_2020 == null ? 0 : f.base3_share_2020)
  ];
}
function fitRidge(X, y, lambda) {
  const n = X[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < n; r++) {
      b[r] += X[i][r] * y[i];
      for (let c = 0; c < n; c++) A[r][c] += X[i][r] * X[i][c];
    }
  }
  for (let r = 1; r < n; r++) A[r][r] += lambda;   /* the intercept is not penalised */
  /* Gaussian elimination with partial pivoting. */
  const Mx = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(Mx[r][c]) > Math.abs(Mx[piv][c])) piv = r;
    if (Math.abs(Mx[piv][c]) < 1e-12) return null;
    const t = Mx[c]; Mx[c] = Mx[piv]; Mx[piv] = t;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = Mx[r][c] / Mx[c][c];
      for (let j = c; j <= n; j++) Mx[r][j] -= k * Mx[c][j];
    }
  }
  /* Back-substitution is unnecessary after full elimination: the matrix is
     diagonal, so each coefficient is its own row's constant over its pivot. */
  return Mx.map((row, i) => (Math.abs(Mx[i][i]) < 1e-12 ? 0 : row[n] / Mx[i][i]));
}
function predict(w, v) { return w ? v.reduce((s, x, i) => s + x * w[i], 0) : null; }

/* ---- the walk-forward evaluation ---------------------------------------- */
function evaluate(opts) {
  opts = opts || {};
  const target = TARGETS[opts.target] ? opts.target : 'k_pct';
  const spec = TARGETS[target];
  const minPa = opts.minPa != null ? opts.minPa : spec.minPa;
  const ds = opts.dataset || D.loadDataset(D.DEFAULT_DIR);
  const league = leagueTable(ds);
  const rows = buildRows(ds);
  const seasons = Array.from(new Set(rows.map((r) => r.season))).sort((a, b) => a - b);
  const first = seasons[0];

  /* ELIGIBILITY IS DECIDED ON THE PRIOR SEASON. Screening on the outcome
     season's workload would drop every hitter who got hurt, which flatters
     any forecast enormously and means nothing. */
  const eligible = rows.filter((f) =>
    f.prior_pa != null && f.prior_pa >= minPa
    && f.prior[target] != null && f.base3[target] != null
    && f.outcome[target] != null
    && f.outcome.plate_appearances != null && f.outcome.plate_appearances > 0);

  const perSeason = [];
  const carryErr = [], shrinkErr = [], ridgeErr = [], leagueErr = [];
  const excluded2020 = [];

  for (const S of seasons) {
    if (S === first + 1) continue;                     /* nothing to train on yet */
    const targets = eligible.filter((f) => f.season === S);
    if (!targets.length) continue;
    if (S === 2020 && !opts.include2020) {
      excluded2020.push({ season: S, n: targets.length });
      continue;
    }
    const train = eligible.filter((f) => f.season < S);
    if (train.length < 50) continue;

    const { K } = chooseShrinkage(train, target, league);
    /* the ridge is refit here, on pairs strictly earlier than S */
    const X = [], y = [];
    train.forEach((f) => {
      const lg = leagueRef(league, f.season, target);
      const v = vectorFor(f, target, lg);
      if (!v || f.outcome[target] == null) return;
      X.push(v); y.push(f.outcome[target] - lg);
    });
    const w = X.length > 40 ? fitRidge(X, y, opts.lambda == null ? 1e-4 : opts.lambda) : null;

    const sErr = [], cErr = [], rErr = [], lErr = [];
    targets.forEach((f) => {
      const lg = leagueRef(league, S, target);
      const yv = f.outcome[target];
      cErr.push(f.prior[target] - yv);
      if (lg != null) lErr.push(lg - yv);
      const sp = shrink(f, target, lg, K);
      if (sp != null) sErr.push(sp - yv);
      const v = vectorFor(f, target, lg);
      const rp = (w && v) ? lg + predict(w, v) : null;
      if (rp != null) rErr.push(rp - yv);
    });
    perSeason.push({ season: S, n: targets.length, shrinkage_k: K,
      carry_mae: mae(cErr), league_mae: mae(lErr), shrink_mae: mae(sErr), ridge_mae: mae(rErr) });
    carryErr.push(...cErr); shrinkErr.push(...sErr); ridgeErr.push(...rErr); leagueErr.push(...lErr);
  }

  const carry = { name: 'carry forward (last season)', mae: mae(carryErr), rmse: rmse(carryErr),
    n: carryErr.length, se: seOfMean(carryErr.map(Math.abs)) };
  const lg = { name: 'the league’s prior value', mae: mae(leagueErr), rmse: rmse(leagueErr),
    n: leagueErr.length, se: seOfMean(leagueErr.map(Math.abs)) };
  const sh = { name: 'three-season baseline shrunk to the league', mae: mae(shrinkErr), rmse: rmse(shrinkErr),
    n: shrinkErr.length, se: seOfMean(shrinkErr.map(Math.abs)) };
  const rg = { name: 'ridge on seven as-of features', mae: mae(ridgeErr), rmse: rmse(ridgeErr),
    n: ridgeErr.length, se: seOfMean(ridgeErr.map(Math.abs)) };

  const candidates = [lg, sh, rg].filter((c) => c.mae != null);
  const best = candidates.slice().sort((a, b) => a.mae - b.mae)[0] || null;
  const improved = (best && carry.mae != null) ? (carry.mae - best.mae) / carry.mae : null;
  /* "Convincing" means the gap is larger than the spread on the gap itself.
     Anything smaller is a number, not a finding. */
  const spread = (best && best.se != null && carry.se != null)
    ? Math.sqrt(best.se * best.se + carry.se * carry.se) : null;
  const convincing = (best && carry.mae != null && spread != null)
    ? (carry.mae - best.mae) > 2 * spread : false;

  return {
    target, label: spec.label, min_prior_pa: minPa,
    seasons_evaluated: perSeason.map((p) => p.season),
    pairs: carry.n,
    incumbent: carry,
    candidates: { league: lg, shrinkage: sh, ridge: rg },
    best, improvement: improved, convincing,
    per_season: perSeason,
    excluded_2020: excluded2020,
    median_shrinkage_k: median(perSeason.map((p) => p.shrinkage_k).filter((x) => x != null)),
    verdict: verdictSentence(best, carry, improved, convincing, spec),
    /* THE METRICS THIS DATASET CANNOT PRODUCE, named rather than omitted. */
    not_computable: {
      metrics: ['calibration', 'log loss', 'Brier score', 'CLV', 'ROI against closing'],
      why: 'Those are defined over GAME-LEVEL probabilities scored against settled outcomes. This archive holds '
        + 'completed-season totals with no game logs and no dates, so it produces no game-level probability to '
        + 'score. Reporting them would mean inventing the thing being measured. A next-season rate forecast is '
        + 'not a game model and is not scored like one.'
    },
    promotion: {
      promoted: false,
      registry_touched: false,
      live_pricing_changed: false,
      note: 'Report-only. research_model_current is untouched, no live price, fair line, total or player prop reads '
        + 'any of this, and offensive_index is never converted into a probability. A candidate that has not beaten '
        + 'carry-forward out of sample has earned nothing.'
    },
    generated_at: new Date().toISOString(),
    rating_version: M.RATING_VERSION,
    coverage: ds.coverage
  };
}

function verdictSentence(best, incumbent, improved, convincing, spec) {
  if (!best || incumbent.mae == null) return 'Not enough out-of-sample pairs to say anything.';
  const pct = (improved * 100).toFixed(1);
  if (improved <= 0) {
    return `Nothing beats carry-forward for ${spec.label}. The best candidate (${best.name}) is `
      + `${Math.abs(pct)}% WORSE out of sample, so there is no case for adding it.`;
  }
  if (!convincing) {
    return `${best.name} is ${pct}% better than carry-forward for ${spec.label}, but the gap is inside its own `
      + `spread. That is a number, not a finding, and it is not a case for promotion.`;
  }
  return `${best.name} beats carry-forward for ${spec.label} by ${pct}% out of sample, comfortably outside its own `
    + `spread. It is a candidate worth arguing about — and still not promoted by this script.`;
}

function render(res) {
  const L = [];
  const f = (v) => v == null ? '—' : v.toFixed(TARGETS[res.target].dp);
  L.push(`${res.label} — walk-forward, ${res.coverage.start}–${res.coverage.end}`);
  L.push(`  ${res.pairs} out-of-sample hitter-seasons, ${res.min_prior_pa}+ PA in the PRIOR season`);
  L.push(`  seasons scored: ${res.seasons_evaluated.join(', ')}`);
  if (res.excluded_2020.length) {
    L.push(`  2020 excluded as a target (${res.excluded_2020[0].n} pairs): a 60-game season is not a year`);
  }
  L.push('');
  L.push(`  ${'incumbent'.padEnd(46)} MAE      RMSE     n`);
  const row = (c) => `  ${c.name.padEnd(46)} ${f(c.mae)}  ${f(c.rmse)}  ${c.n}`;
  L.push(row(res.incumbent));
  L.push('');
  L.push(`  ${'candidates'.padEnd(46)}`);
  ['league', 'shrinkage', 'ridge'].forEach((k) => { if (res.candidates[k].mae != null) L.push(row(res.candidates[k])); });
  L.push('');
  L.push(`  median shrinkage constant chosen on training seasons: ${res.median_shrinkage_k} PA`);
  L.push('');
  L.push(`  ${res.verdict}`);
  L.push('');
  L.push(`  NOT COMPUTABLE FROM THIS DATASET: ${res.not_computable.metrics.join(', ')}.`);
  L.push(`  ${res.not_computable.why}`);
  L.push('');
  L.push(`  PROMOTION: none. ${res.promotion.note}`);
  return L.join('\n');
}

function main() {
  const one = arg('target', null);
  const targets = one && TARGETS[one] ? [one] : Object.keys(TARGETS);
  const ds = D.loadDataset(D.DEFAULT_DIR);
  const write = flag('write');
  const all = [];
  targets.forEach((t) => {
    const res = evaluate({ target: t, dataset: ds });
    all.push(res);
    console.log(render(res));
    console.log('');
    if (write) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `next_season_${t}.json`), JSON.stringify(res, null, 2) + '\n');
    }
  });
  if (write) console.log(`written to ${path.relative(ROOT, OUT_DIR)}`);
  /* The script's exit status is about whether it RAN, not about whether the
     features turned out to be good. A negative result is a result. */
  const broken = all.filter((r) => r.pairs === 0);
  if (broken.length) { console.log('FAIL | no out-of-sample pairs for: ' + broken.map((r) => r.target).join(', ')); process.exit(1); }
}

module.exports = { evaluate, render, buildRows, leagueTable, leagueRef, shrink, chooseShrinkage,
  vectorFor, fitRidge, predict, TARGETS, FITTED, OUT_DIR };

if (require.main === module) main();
