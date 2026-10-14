'use strict';
/* ===========================================================================
   EdgeDesk college baseball — does each part of the team model earn its place?

     node college_baseball/ablations.js

   The tuned hierarchical model is re-run from 2012 with ONE feature group
   removed at a time, and scored on VALIDATION (2023-2024) against the full
   model with a paired date-block bootstrap of the per-game log-loss
   difference (ablated - full):
     interval wholly above 0   the group KEEPS ITS PLACE (removing it hurts)
     interval contains 0       NO MEASURABLE VALUE (kept only if free; flagged)
     interval wholly below 0   REMOVAL IMPROVES (the auditor flags it)
   Groups: the conference/division hierarchy, park effects, season-to-season
   carryover, rating-uncertainty integration, the seven-inning doubleheader
   mixture, and (from the cached walk-forward) the prior-season calibration map.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const W = require('./lib/warehouse');
const M = require('./lib/models');
const V = require('../engine/validation');
const P = require('../engine/lab/protocol');
const WF = require('./walkforward');
const REG = require('./lib/registry');
const K = require('./ingest/common');

const r = V.r;

function main() {
  const cfgs = WF.cfgsFromTuning(); const base = cfgs.hier || { tq: {} };
  const games = W.results(C.SEASONS.first, C.WINDOWS.team.validation[1]);
  const ctx = { meta: M.meta(), constants: WF.constants() }; const p7 = WF.p7Context(); ctx.p7 = p7.fn; if (cfgs.hier && cfgs.hier.dist) ctx.dist = cfgs.hier.dist;
  const inVal = (g) => P.inWin(g.season, C.WINDOWS.team.validation);
  const runs = {
    full: { cfg: base, ctx },
    hierarchy: { cfg: Object.assign({}, base, { tq: Object.assign({}, base.tq, { hier: false }) }), ctx },
    parks: { cfg: Object.assign({}, base, { tq: Object.assign({}, base.tq, { parks: false }) }), ctx },
    carryover: { cfg: Object.assign({}, base, { tq: Object.assign({}, base.tq, { carry_team: 0, carry_conf: 0, carry_park: 0 }) }), ctx },
    uncertainty_integration: { cfg: Object.assign({}, base, { uncertainty_scale: 0 }), ctx },
    seven_inning_mixture: { cfg: base, ctx: Object.assign({}, ctx, { p7: null }) },
  };
  const preds = {}; const secs = {};
  for (const [k, v] of Object.entries(runs)) { const t0 = Date.now(); preds[k] = M.runModel('hier', v.cfg, games, v.ctx, { score: inVal }).preds; secs[k] = Math.round((Date.now() - t0) / 1000); console.error(`  ${k}: ${secs[k]}s`); }
  const val = games.filter(inVal).map((g) => ({ id: g.game_id, date: g.date, y: g.home_runs > g.away_runs ? 1 : 0 }));
  const ll = (k) => val.reduce((a, x) => a + V.logLoss(preds[k].get(x.id).p, x.y), 0) / val.length;
  const full = ll('full');
  const results = [];
  for (const k of Object.keys(runs)) {
    if (k === 'full') continue;
    const cmp = V.pairedBootstrap(val.map((x) => ({ date: x.date, a: V.logLoss(preds[k].get(x.id).p, x.y), b: V.logLoss(preds.full.get(x.id).p, x.y) })), { B: 1000 });
    const verdict = cmp.ci95[0] > 0 ? 'KEEPS ITS PLACE' : cmp.ci95[1] < 0 ? 'REMOVAL IMPROVES' : 'NO MEASURABLE VALUE';
    results.push({ removed: k.replace(/_/g, ' '), log_loss: r(ll(k), 5), diff_vs_full: cmp.mean_diff, ci95: cmp.ci95, verdict, seconds: secs[k] });
  }
  /* calibration: from the committed walk-forward rows, no re-run */
  if (fs.existsSync(WF.ROWS_FILE)) {
    const rows = JSON.parse(fs.readFileSync(WF.ROWS_FILE, 'utf8')).filter((x) => x.window === 'VALIDATION' && x.p.hier != null && x.p.hier_cal != null);
    const cmp = V.pairedBootstrap(rows.map((x) => ({ date: x.date, a: V.logLoss(x.p.hier, x.y), b: V.logLoss(x.p.hier_cal, x.y) })), { B: 1000 });
    results.push({ removed: 'prior-season calibration map', log_loss: r(rows.reduce((a, x) => a + V.logLoss(x.p.hier, x.y), 0) / rows.length, 5), diff_vs_full: cmp.mean_diff, ci95: cmp.ci95, verdict: cmp.ci95[0] > 0 ? 'KEEPS ITS PLACE' : cmp.ci95[1] < 0 ? 'REMOVAL IMPROVES' : 'NO MEASURABLE VALUE', note: 'compared with hier_cal on the same rows' });
  }
  const out = { schema: 'edgedesk_cbase_ablations_v1', point_in_time: 'RETROSPECTIVE', window: 'VALIDATION 2023-2024', n: val.length, full_log_loss: r(full, 5), config: base, results };
  K.writeJson(path.join(C.PATHS.validation, 'ablations.json'), out);
  for (const a of results) REG.register({ id: 'CBX-ABLATE-' + a.removed.toUpperCase().replace(/[^A-Z0-9]+/g, '-'), family: 'ablation', title: 'Ablation: team model without ' + a.removed,
    hypothesis: `The ${a.removed} improves VALIDATION log loss of the team model`, dataset: { warehouse: 'college_baseball/data' }, windows: { training: [2012, 2022], validation: [2023, 2024], holdout: null },
    features: ['hier minus ' + a.removed], algorithm: { name: 'hier', config: base }, seeds: [20261013], metrics: { full: r(full, 5), ablated: a.log_loss }, uncertainty: { diff: a.diff_vs_full, ci95: a.ci95 },
    decision: a.verdict === 'KEEPS ITS PLACE' ? 'ACCEPT' : a.verdict === 'REMOVAL IMPROVES' ? 'REJECT' : 'INCONCLUSIVE', justification: a.verdict, holdout_evaluated: false });
  console.log('full', r(full, 5)); for (const a of results) console.log(a.removed.padEnd(32), a.log_loss, a.diff_vs_full, JSON.stringify(a.ci95), a.verdict);
}

if (require.main === module) main();
