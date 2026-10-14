#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — the live parameters for the season in progress.

     node nba/model/live.js

   Fits, for the current season S, exactly what the walk-forward fits for any
   season: each candidate's calibration, the end-game shape and the overtime
   parameters on the out-of-sample rows of S−3..S−1; the ML models trained on
   every season before S. Nothing here is scored, so fitting on the sealed
   test seasons reveals no test metric; it is what any live model must do —
   use all the history it has.

   Writes nba/params/live.json (calibrations, shape, overtime, the chosen model
   per track read from the walk-forward record) and nba/params/ml_live.json
   (the ML models, with feature means for explanations).
   =========================================================================== */
const fs = require('fs');
const C = require('../config');
const WF = require('./walkforward');
const ML = require('./ml');

async function main() {
  const cur = C.currentSeason();
  const tuning = fs.existsSync(WF.TUNING) ? JSON.parse(fs.readFileSync(WF.TUNING, 'utf8')) : { pass: {}, ml: {} };
  const rows = await WF.buildRows(tuning);
  const lab = WF.attachLab(rows);
  const calSeasons = [cur - 3, cur - 2, cur - 1];
  for (const track of ['P', 'C']) ML.fitPredict(rows, track, Object.assign({}, tuning.ml, { seasons: calSeasons }), { log: true });
  const prior = rows.filter((r) => r.y && calSeasons.includes(r.season));
  const so = WF.shapeFor(prior);
  const cal = {};
  for (const c of WF.CANDIDATES) { if (c.special) continue; const x = WF.calibrate(c, prior, so.shape); if (x) cal[c.id] = x; }
  const record = JSON.parse(fs.readFileSync(WF.RECORD, 'utf8'));
  const mlLive = { P: ML.fitLive(rows, 'P', tuning.ml, cur), C: ML.fitLive(rows, 'C', tuning.ml, cur) };
  const live = { schema: 'edgedesk_nba_live_v1', generated_at: new Date().toISOString(), for_season: cur, calibration_seasons: calSeasons, tuning,
    chosen: { P: record.choice.P.chosen, C: record.choice.C.chosen }, record_spec_hash: record.spec_hash, shape: so.shape, ot: so.ot, calibration: cal, lab_attached: lab.attached,
    last_final: rows.filter((r) => r.y).slice(-1)[0] ? rows.filter((r) => r.y).slice(-1)[0].date : null };
  fs.writeFileSync(WF.LIVE, JSON.stringify(live) + '\n');
  fs.writeFileSync(WF.ML_LIVE, JSON.stringify({ schema: 'edgedesk_nba_ml_live_v1', generated_at: live.generated_at, for_season: cur, models: mlLive }) + '\n');
  console.log('[nba live] season ' + cur + ': calibrations for ' + Object.keys(cal).length + ' candidates on ' + prior.length + ' games; chosen P ' + live.chosen.P + ', C ' + live.chosen.C);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
