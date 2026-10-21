#!/usr/bin/env node
/* ===========================================================================
   THE ACCEPTANCE TABLE: the model the board served before the fixes, the v1
   engine with the Step 1 correctness fixes, every v2 version the registry
   archived before the served one, the served v2 (its params' own
   configuration), and the closing line — on 2010-2024
   validation, the 2025 holdout and 2026 to date — with the holdout's
   calibration bins and home lean. Also writes every v2 walk-forward
   prediction, per game, so anyone can re-score it.

     results/final.json      the table (RESULTS.md reads it)
     results/oos_v2.csv.gz   game_id, season, week, type, neutral, model_margin, p_home, close_margin, close_p_home, margin

   Usage: node football/research/nfl_v2/final_eval.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const B = require('./backtest.js');
const S = require('./run_steps.js');
const L = require('./weekly_loop.js');

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
function block(s) {
  if (!s) return null;
  const m = s.model, c = s.close;
  return {
    n: s.n,
    model: { mae: r4(m.mae), rmse: r4(m.rmse), brier: r4(m.brier), logloss: r4(m.logloss), ece: r4(m.ece), cal_slope: r4(m.slope), cal_intercept: r4(m.intercept), home_lean: r4(m.home_lean), ats3: m.ats[3], total_mae: r4(m.total_mae),
      bins: m.bins.map((b) => ({ lo: b.lo, n: b.n, predicted: r4(b.predicted), observed: r4(b.observed) })) },
    close: { mae: r4(c.mae), rmse: r4(c.rmse), brier: r4(c.brier), logloss: r4(c.logloss), ece: r4(c.ece), cal_slope: r4(c.slope), total_mae: r4(c.total_mae),
      bins: c.bins.map((b) => ({ lo: b.lo, n: b.n, predicted: r4(b.predicted), observed: r4(b.observed) })) },
    model_on_market_rows: s.model_on_market_rows ? { n: s.model_on_market_rows.n, brier: r4(s.model_on_market_rows.brier), logloss: r4(s.model_on_market_rows.logloss) } : null,
  };
}
function run(label, cfg, opts) {
  const r = B.evaluate(cfg, Object.assign({ keepPreds: true }, opts || {}));
  return { label, r, out: { label, valid: block(r.valid), holdout: block(r.holdout), live: block(r.live) } };
}

function main() {
  const PV = L.loadParams();
  const served = run('v1 as served before the fixes (frozen defence, frozen QB layer, Normal win probability)', S.V1CFG, { served: true });
  const fixed = run('v1 with the Step 1 correctness fixes', S.V1CFG);
  const reg = JSON.parse(fs.readFileSync(L.PATHS.reg, 'utf8'));
  const earlier = reg.versions.filter((x) => x.model_version !== PV.model_version && x.cfg && x.archive && /versions\/.*\.js$/.test(x.archive))
    .map((x) => run(x.model_version + ' (' + x.status + ')', x.cfg));
  const v2 = run(PV.model_version + ' (promoted; served now)', PV.cfg);
  const doc = { schema: 'edgedesk_nfl_v2_final_eval_v1', generated_at: new Date().toISOString(), served_model: PV.model_version, config_sha: PV.config_sha,
    windows: { valid: '2010-2024 walk-forward', holdout: '2025 (never used to choose anything before its promotion look)', live: '2026 to date (reported only)' },
    models: [served.out, fixed.out].concat(earlier.map((e) => e.out), [v2.out]) };
  fs.writeFileSync(path.join(B.RES, 'final.json'), JSON.stringify(doc, null, 1) + '\n');
  const amToProb = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
  const rows = ['game_id,season,week,type,neutral,model_margin,p_home,close_margin,close_p_home,margin'];
  v2.r.preds.forEach((p) => {
    const cp = p.home_ml != null && p.away_ml != null ? amToProb(p.home_ml) / (amToProb(p.home_ml) + amToProb(p.away_ml)) : null;
    rows.push([p.id, p.season, p.week, p.type || '', p.neutral ? 1 : 0, r4(p.model), r4(p.p), p.close == null ? '' : p.close, cp == null ? '' : r4(cp), p.margin].join(','));
  });
  fs.writeFileSync(path.join(B.RES, 'oos_v2.csv.gz'), zlib.gzipSync(rows.join('\n') + '\n', { mtime: 0 }));
  const f = (x, k) => (x ? x.model[k] : null);
  doc.models.forEach((m) => console.log(`${m.label}\n  valid MAE ${f(m.valid, 'mae')} LL ${f(m.valid, 'logloss')} | 2025 MAE ${f(m.holdout, 'mae')} LL ${f(m.holdout, 'logloss')} Brier ${f(m.holdout, 'brier')} ECE ${f(m.holdout, 'ece')} slope ${f(m.holdout, 'cal_slope')} lean ${f(m.holdout, 'home_lean')} | 2026 MAE ${f(m.live, 'mae')} LL ${f(m.live, 'logloss')}`));
  const c = doc.models[doc.models.length - 1];
  console.log(`close\n  valid MAE ${c.valid.close.mae} LL ${c.valid.close.logloss} | 2025 MAE ${c.holdout.close.mae} LL ${c.holdout.close.logloss} Brier ${c.holdout.close.brier} ECE ${c.holdout.close.ece} slope ${c.holdout.close.cal_slope} | 2026 MAE ${c.live.close.mae} LL ${c.live.close.logloss}`);
  console.log(`wrote results/final.json and results/oos_v2.csv.gz (${rows.length - 1} games)`);
}
if (require.main === module) main();
