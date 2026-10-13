#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — fit the xG model walk-forward and record how it holds up.

     node hockey/xg/train.js [--window 4] [--through 2027]

   For every season S from FIRST_SEASON+1 to --through, fits the model on the
   `window` seasons before S (regular season and playoffs, every strength) and
   scores it on S, which it has never seen. Writes
     hockey/xg/models/xg_for_<S>.json   the model applied to season S
     hockey/xg/report.json              held-out log loss and calibration per S,
                                        beside a distance-only model and, where
                                        the source carries one, the source's xG
   The first season gets an in-sample model and is marked BURN_IN.

   Reads the cached records from hockey/ingest/season.js. No network.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const X = require('./model');
const V = require('../../engine/validation');
const S = require('../../engine/stats');
const { readSeason } = require('../ingest/season');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }

function loadShots(season) {
  const out = [];
  for (const r of readSeason(season)) for (const s of r.shots) out.push(s);
  return out;
}

function score(pred, shots) {
  const rows = shots.filter((s) => s.dist != null).map((s) => ({ p: pred(s), y: s.goal }));
  const b = V.binary(rows, { buckets: [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1.0000001] });
  return { n: b.n, log_loss: b.log_loss, brier: b.brier, mean_p: b.mean_p, mean_y: b.mean_y, calibration_slope: b.calibration_slope, bins: b.bins };
}

function main() {
  const window = Number(arg('window', 4));
  const through = Number(arg('through', C.CURRENT_SEASON));
  fs.mkdirSync(C.PATHS.xgModels, { recursive: true });
  const cache = new Map();
  const shotsOf = (s) => { if (!cache.has(s)) cache.set(s, loadShots(s)); return cache.get(s); };
  const report = { schema: C.SCHEMA.xg + '_report', generated_at: new Date().toISOString(), window, seasons: [] };
  for (let season = C.FIRST_SEASON; season <= through; season++) {
    const train = [];
    const from = Math.max(C.FIRST_SEASON, season - window), to = season - 1;
    const burnIn = to < from;
    const trainSeasons = burnIn ? [season] : Array.from({ length: to - from + 1 }, (_, i) => from + i);
    for (const t of trainSeasons) for (const s of shotsOf(t)) train.push(s);
    const t0 = Date.now();
    const m = X.fit(train);
    m.id = 'xg_for_' + season;
    m.applies_to_season = season; m.train_seasons = trainSeasons; m.burn_in = burnIn;
    m.generated_at = report.generated_at;
    fs.writeFileSync(path.join(C.PATHS.xgModels, 'xg_for_' + season + '.json'), JSON.stringify(m, null, 1));
    const test = shotsOf(season).filter((s) => !s.empty_net && s.state !== 'enf');
    const pred = X.predictor(m).predict;
    /* a distance-only baseline fitted on the same window */
    const dTrain = train.filter((s) => s.dist != null && !s.empty_net && s.state !== 'enf');
    const dm = S.logistic(dTrain.map((s) => [1, Math.min(s.dist, 200) / 10, Math.log1p(Math.min(s.dist, 200))]), dTrain.map((s) => s.goal), { l2: 1 });
    const dpred = (s) => S.predictLogistic(dm.beta, [1, Math.min(s.dist, 200) / 10, Math.log1p(Math.min(s.dist, 200))]);
    const withSrc = test.filter((s) => s.src_xg != null);
    const row = {
      season, burn_in: burnIn, train_seasons: trainSeasons, n_train: m.n_train, fit_seconds: +((Date.now() - t0) / 1000).toFixed(1),
      model: score(pred, test),
      distance_only: score(dpred, test),
      source_xg: withSrc.length ? Object.assign(score((s) => Math.min(0.999, Math.max(0.001, s.src_xg)), withSrc), { note: 'the source\'s own xG (fastRhockey/hockeyR); its training window is not documented per season, so it may be in-sample for earlier seasons' }) : null,
      model_on_source_rows: withSrc.length ? score(pred, withSrc) : null,
    };
    report.seasons.push(row);
    console.log('[xg] ' + season + (burnIn ? ' BURN-IN' : ' held out') + ' n=' + row.model.n + ' LL model ' + row.model.log_loss + ' dist ' + row.distance_only.log_loss + (row.source_xg ? ' src ' + row.source_xg.log_loss + ' (model on same rows ' + row.model_on_source_rows.log_loss + ')' : '') + ' slope ' + row.model.calibration_slope + ' mean p/y ' + row.model.mean_p + '/' + row.model.mean_y);
  }
  fs.writeFileSync(path.join(C.HOCKEY, 'xg', 'report.json'), JSON.stringify(report, null, 1));
}

if (require.main === module) main();
module.exports = { loadShots };
