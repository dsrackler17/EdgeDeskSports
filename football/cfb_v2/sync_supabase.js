#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB V2 — push frozen pregame snapshots into Supabase (insert-only).

     SB_URL=... SB_SERVICE_ROLE=... node football/cfb_v2/sync_supabase.js [--season 2026] [--dry-run]

   Reads football/cfb_v2/snapshots/<season>/*.json (never the replay file) and
   inserts, for every frozen row, the pure projection (cfb_predictions), its
   intervals and its component predictions, with `resolution=ignore-duplicates`
   so a re-run is a no-op. The database's own triggers refuse an update, a
   delete, or anything dated at/after kickoff (supabase/cfb_v2_model.sql), so a
   frozen prediction cannot be rewritten from here even by mistake.
   Without SB_URL / SB_SERVICE_ROLE the script says so and exits 0.

   Writes go through football/cfb_production/db.js (chunked, classified bounded
   retry, incidents); the parent rows (cfb_predictions) are written before the
   intervals and components that reference them. It is a module too
   (plan / sync), so football/cfb_production/sql.test.js can run it 1x, 2x, 3x.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global.window || global;
require(path.join(__dirname, 'params.js'));
const E = require(path.join(__dirname, 'engine.js'));
const P = global.window.EDCfbV2Params;
/* the one canonical pathway to a V2 projection: input contract, the engine, numeric checks */
const CANON = require(path.join(__dirname, '..', 'cfb_production', 'canonical.js'));

const DB = require(path.join(__dirname, '..', 'cfb_production', 'db.js'));
const LOG = require(path.join(__dirname, '..', 'cfb_production', 'log.js'));

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] || true); }

function rowsFor(snap) {
  const preds = [], ints = [], comps = [];
  for (const x of snap.rows) {
    const r = x.row;
    if (r.priced === false) continue;                 // FCS: tracked in the snapshot, not published
    const p = CANON.pure(r, { engine: E, params: P, row_model_version: snap.model_version });
    if (p.status !== 'PREDICTED') continue;
    const key = { game_id: r.game_id, prediction_ts: r.prediction_ts, model_version: snap.model_version };
    preds.push(Object.assign({}, key, {
      feature_version: P.feature_version, season: r.season, week: r.week, kickoff_ts: r.kickoff,
      feature_ts: r.feature_ts, home_team_id: r.home_id, away_team_id: r.away_id,
      neutral_site: r.neutral_site, projected_margin: p.projected_margin,
      fair_home_line: -p.projected_margin, fair_total: p.fair_total, home_win_prob: p.home_win_prob,
      sigma: p.sigma, t_df: p.t_df, ensemble_sd: p.ensemble_sd,
      football_prediction_confidence: p.football_prediction_confidence, drivers: p.drivers,
      uncertainty_drivers: p.uncertainty_drivers, stack_weights: P.stack_weights || {},
      snapshot_hash: x.hash }));
    [['0.5', 'p50'], ['0.8', 'p80'], ['0.95', 'p95']].forEach(function (lv) {
      ints.push(Object.assign({}, key, { level: parseFloat(lv[0]), lo: p.intervals[lv[1]][0], hi: p.intervals[lv[1]][1] }));
    });
    Object.keys(r.components || {}).forEach(function (c) {
      comps.push(Object.assign({}, key, { component: c, predicted: r.components[c] }));
    });
  }
  return { preds, ints, comps };
}

function plan(season, opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(__dirname, 'snapshots', String(season));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'replay_to_date.json').sort() : [];
  const all = { preds: [], ints: [], comps: [] };
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    /* integrity is verified by the writer's own encoder (python3 -m v2.predict_live --verify);
       JSON number formatting differs between Python and JS, so the hash is carried, not recomputed */
    const r = rowsFor(s);
    all.preds.push(...r.preds); all.ints.push(...r.ints); all.comps.push(...r.comps);
  }
  const version = { model_version: P.model_version, feature_version: P.feature_version,
    trained_through: P.trained_through, params: {}, validation: P.validation_summary || {},
    promotion_decision: P.promotion.decision };
  return { files, version, preds: all.preds, ints: all.ints, comps: all.comps };
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const p = plan(season, opts);
  if (!opts.quiet) console.log('[sync] %d files, %d predictions, %d intervals, %d components', p.files.length, p.preds.length, p.ints.length, p.comps.length);
  if (opts.dryRun || !url || !key) { if (!opts.quiet) console.log(opts.dryRun ? '[sync] dry run' : '[sync] SB_URL/SB_SERVICE_ROLE not set: nothing sent'); return { skipped: true }; }
  const log = opts.log || LOG.logger({ job: 'cfb_weekly_refresh' }, { sink: opts.quiet ? () => {} : undefined });
  const io = Object.assign({ log, fetch: opts.fetch, onIncident: DB.incidentSink({ url, key, log, fetch: opts.fetch }) }, opts.io || {});
  const out = {};
  out.cfb_model_versions = await DB.postRows(url, key, 'cfb_model_versions', 'model_version', [p.version], io);
  out.cfb_predictions = await DB.postRows(url, key, 'cfb_predictions', 'game_id,prediction_ts,model_version', p.preds, io);
  out.cfb_prediction_intervals = await DB.postRows(url, key, 'cfb_prediction_intervals', 'game_id,prediction_ts,model_version,level', p.ints, io);
  out.cfb_model_component_predictions = await DB.postRows(url, key, 'cfb_model_component_predictions', 'game_id,prediction_ts,model_version,component', p.comps, io);
  if (!opts.quiet) console.log('[sync] done');
  return out;
}

module.exports = { plan, sync, rowsFor };

if (require.main === module) {
  const SEASON = parseInt(arg('season', new Date().getUTCFullYear()), 10);
  sync(SEASON, { dryRun: process.argv.includes('--dry-run') })
    .catch(e => { console.error(e.message); process.exit(1); });
}
