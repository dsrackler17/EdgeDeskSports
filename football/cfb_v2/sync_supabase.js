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
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global.window || global;
require(path.join(__dirname, 'params.js'));
const E = require(path.join(__dirname, 'engine.js'));
const P = global.window.EDCfbV2Params;

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] || true); }
const SEASON = parseInt(arg('season', new Date().getUTCFullYear()), 10);
const DRY = process.argv.includes('--dry-run');
const URL_ = process.env.SB_URL, KEY = process.env.SB_SERVICE_ROLE;

function rowsFor(snap) {
  const preds = [], ints = [], comps = [];
  for (const x of snap.rows) {
    const r = x.row;
    if (r.priced === false) continue;                 // FCS: tracked in the snapshot, not published
    const p = E.pure(r, {});
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

async function post(table, rows, conflict) {
  if (!rows.length) return 0;
  const res = await fetch(URL_ + '/rest/v1/' + table + '?on_conflict=' + conflict, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows) });
  if (!res.ok) throw new Error(table + ': ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return rows.length;
}

(async function main() {
  const dir = path.join(__dirname, 'snapshots', String(SEASON));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'replay_to_date.json') : [];
  const all = { preds: [], ints: [], comps: [] };
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    /* integrity is verified by the writer's own encoder (python3 -m v2.predict_live --verify);
       JSON number formatting differs between Python and JS, so the hash is carried, not recomputed */
    const r = rowsFor(s);
    all.preds.push(...r.preds); all.ints.push(...r.ints); all.comps.push(...r.comps);
  }
  console.log('[sync] %d files, %d predictions, %d intervals, %d components', files.length,
    all.preds.length, all.ints.length, all.comps.length);
  if (DRY || !URL_ || !KEY) { console.log(DRY ? '[sync] dry run' : '[sync] SB_URL/SB_SERVICE_ROLE not set: nothing sent'); return; }
  await post('cfb_model_versions', [{ model_version: P.model_version, feature_version: P.feature_version,
    trained_through: P.trained_through, params: {}, validation: P.validation_summary || {},
    promotion_decision: P.promotion.decision }], 'model_version');
  await post('cfb_predictions', all.preds, 'game_id,prediction_ts,model_version');
  await post('cfb_prediction_intervals', all.ints, 'game_id,prediction_ts,model_version,level');
  await post('cfb_model_component_predictions', all.comps, 'game_id,prediction_ts,model_version,component');
  console.log('[sync] done');
})().catch(e => { console.error(e.message); process.exit(1); });
