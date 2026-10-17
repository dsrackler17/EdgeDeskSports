#!/usr/bin/env node
/* ============================================================================
   ALTITUDE -> SUPABASE. Mirrors what the module published into the tables of
   supabase/cfb_altitude.sql, through the one CFB write path
   (football/cfb_production/db.js DB.postRows, ignore-duplicates):

     cfb_altitude_shadow            one pregame row per slate game per build,
                                    from football/fbs/slate.json altitude_travel
     cfb_venue_elevation            the registry, football/altitude/venues.json
     cfb_altitude_validation_runs   the research verdict,
                                    football/validation/altitude_cfb.json

   A game whose kickoff is not after the slate's build time is skipped (the
   table refuses it anyway: a pregame record is written before kickoff). Ids
   are content-derived, so a re-run inserts nothing new.

     node football/altitude/sync_supabase.js [--dry]      (SB_URL, SB_SERVICE_ROLE)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const id = (prefix, parts) => prefix + crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex').slice(0, 24);
const num = (x) => (x == null || x === '' || !isFinite(+x) ? null : +x);

function shadowRows(slate, params) {
  const at = slate.generated_at;
  const out = [];
  (slate.games || []).forEach((g) => {
    const a = g.altitude_travel;
    if (!a || a.schema !== 'edgedesk_cfb_altitude_section_v1' || !a.adjustment) return;
    if (!(Date.parse(g.kickoff) > Date.parse(at))) return;
    const adj = a.adjustment, locks = adj.locks || {};
    const ec = a.engine_contribution;
    const applied = ec && ec.available === true && num(ec.points) != null ? num(ec.points) : 0;
    const base = num(g.model_home_margin);
    out.push({
      shadow_id: id('cfbalt_', [g.game_id, at, adj.model_version || 'none']),
      game_id: String(g.game_id), season: g.season, week: g.week == null ? null : g.week,
      kickoff_ts: g.kickoff, prediction_ts: at,
      baseline_model_version: g.model_version || 'edgedesk_cfb_p4_v1.0.0',
      altitude_model_version: adj.model_version || (params && params.model_version) || 'none',
      candidate: adj.model || null,
      params_status: adj.params_status || (params && params.status) || 'NONE',
      status: adj.status, flag_enabled: locks.flag_enabled === true, neutral_site: !!a.neutral_site,
      /* the slate publishes V1's margin WITH whatever was applied, so the
         baseline is that margin minus the applied points */
      baseline_home_margin: base == null ? null : Math.round((base - applied) * 1000) / 1000,
      shadow_points: num(adj.shadow_points), applied_points: applied,
      published_home_margin: base,
      venue_id: a.venue ? a.venue.venue_id : null, game_elev_ft: a.venue ? num(a.venue.elev_ft) : null,
      home_usual_elev_ft: num(a.home && a.home.usual_elev_ft), away_usual_elev_ft: num(a.away && a.away.usual_elev_ft),
      home_gain_ft: num(a.home && a.home.gain_ft), away_gain_ft: num(a.away && a.away.gain_ft),
      exposure_class: a.exposure ? a.exposure.class : null,
      distance_mi: num(a.focus === 'home' ? a.home && a.home.distance_mi : a.away && a.away.distance_mi),
      tz_change_h: num(a.focus === 'home' ? a.home && a.home.tz_change_h : a.away && a.away.tz_change_h),
      run_id: process.env.GITHUB_RUN_ID || null,
      payload: a
    });
  });
  return out;
}

function registryRows(reg) {
  return Object.keys(reg.venues || {}).map((k) => {
    const v = reg.venues[k];
    return { elevation_id: id('cfbve_', [v.venue_id, reg.generated_at]), venue_id: v.venue_id, name: v.name || ('venue ' + v.venue_id),
      elev_ft: v.elev_ft, elev_m: v.elev_m, confidence: v.confidence, elev_source: v.elev_source, basis: v.basis,
      legacy_of: v.legacy_of == null ? null : v.legacy_of, same_site_as: v.same_site_as == null ? null : v.same_site_as,
      lat: v.lat, lon: v.lon, tz_name: v.tz_name || null, sources: v.sources, registry_generated_at: reg.generated_at,
      run_id: process.env.GITHUB_RUN_ID || null };
  });
}

function validationRow(v, params) {
  return { validation_id: id('cfbav_', [params.model_version, v.generated_at]), model_version: params.model_version,
    generated_at: v.generated_at, declared_gates: v.declared_gates, status: v.status, points_applied: v.points_applied === true,
    support_state: v.support_state, selected: v.selected || null,
    gates: v.gates.map((g) => ({ id: g.id, pass: g.pass })),
    payload: { support_text: v.support_text, selected: v.selected, coverage: v.coverage, confirm: v.walk_forward[v.selected].confirm.affected,
      report: 'docs/cfb-altitude/BACKTEST.md' } };
}

async function main() {
  const dry = process.argv.indexOf('--dry') >= 0;
  global.window = global.window || global;
  const params = require('./params.js');
  const slate = readJson('football/fbs/slate.json');
  const reg = readJson('football/altitude/venues.json');
  const val = readJson('football/validation/altitude_cfb.json');
  const rows = { cfb_altitude_shadow: shadowRows(slate, params), cfb_venue_elevation: registryRows(reg), cfb_altitude_validation_runs: [validationRow(val, params)] };
  const summary = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length]));
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  if (dry || !url || !key) { console.log(JSON.stringify({ dry: true, reason: dry ? '--dry' : 'no SB_URL / SB_SERVICE_ROLE', rows: summary })); return 0; }
  const DB = require(path.join(ROOT, 'football', 'cfb_production', 'db.js'));
  const out = {};
  out.cfb_venue_elevation = await DB.postRows(url, key, 'cfb_venue_elevation', 'venue_id,registry_generated_at', rows.cfb_venue_elevation, {});
  out.cfb_altitude_validation_runs = await DB.postRows(url, key, 'cfb_altitude_validation_runs', 'model_version,generated_at', rows.cfb_altitude_validation_runs, {});
  out.cfb_altitude_shadow = await DB.postRows(url, key, 'cfb_altitude_shadow', 'game_id,prediction_ts,altitude_model_version', rows.cfb_altitude_shadow, {});
  console.log(JSON.stringify({ sent: out }));
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error('[altitude-sync] ' + ((e && e.message) || e)); process.exit(1); });
module.exports = { shadowRows, registryRows, validationRow };
