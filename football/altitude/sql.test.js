#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_altitude.sql (and its rollback) against a real, throwaway
   PostgreSQL (tools/personal/_pg.js, with the repo's Supabase shim).

   Checks:
     - applies to a clean database WITHOUT cfb_production.sql (the switch is
       reported as skipped), again, and as ONE transaction, every row ok;
     - with cfb_production.sql applied first, the switch is declared OFF and
       GUARDED: the door refuses automation, refuses no evidence, accepts a
       person with evidence, and a re-apply never resets it;
     - append-only for the service role and the owner;
     - point in time; the three locks; the 3-point cap; published = V1 +
       applied; a neutral site is never adjusted; a run claims points only
       when VALIDATED;
     - the rows football/altitude/sync_supabase.js builds — from the real
       registry, the real validation record and a Notre Dame at BYU slate row
       built by the module — insert as PostgREST would insert them;
     - access: authenticated reads, anon reads nothing;
     - the rollback removes the objects, leaves the flag off, and the module
       re-applies cleanly afterwards.

   Run: node football/altitude/sql.test.js   (CFB_ALTITUDE_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../../tools/personal/_pg.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = (f) => path.join(ROOT, 'supabase', f + '.sql');
global.window = global.window || global;
const A = require('./engine.js');
const SYNC = require('./sync_supabase.js');
const PARAMS = require('./params.js');
const REG = require('./venues.json');
const VAL = require(path.join(ROOT, 'football', 'validation', 'altitude_cfb.json'));
const FIX = require('./fixtures/byu_notredame.json');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_ALTITUDE_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const J = (o) => '$j$' + JSON.stringify(o).replace(/\$j\$/g, '') + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;

/* the Notre Dame at BYU slate row, built by the module exactly as build_coverage.js builds it */
const rows = FIX.games.filter((r) => r.season === 2026 || r.season === 2025);
const g = FIX.games.find((r) => String(r.game_id) === '401856809');
const ctx = A.context(g, { registry: REG, normKey: FBS.normKey, index: A.teamIndex(rows, FBS.normKey) });
const adj = A.adjustment(ctx, PARAMS, { flag_enabled: false });
const section = Object.assign(A.publish(ctx, adj, PARAMS), { engine_contribution: { points: 0, available: false, reason: adj.reason } });
const slate = { generated_at: '2026-10-17T16:00:00.000Z', games: [{ game_id: '401856809', season: 2026, week: 7, kickoff: '2026-10-17T23:30:00.000Z',
  model_home_margin: -3.2, model_version: 'edgedesk_cfb_p4_v1.0.0', altitude_travel: section }] };

function run() {
  /* ---------------------------------------------------------- standalone */
  let db = PG.start('cfbaltitude');
  if (!db || db.skip) return done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');
  try {
    const r1 = db.applyFile(SQL('cfb_altitude'));
    chk('applies without cfb_production.sql, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 7, r1.slice(-700));
    chk('the switch is reported as skipped, not as declared', /skipped: supabase\/cfb_production\.sql not applied/.test(r1));
    chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL('cfb_altitude'))));
    chk('applies as ONE transaction (the SQL editor), still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL('cfb_altitude'))));

    const refused = (sql, re) => (re || /check constraint|violates/i).test(db.mustFail(() => db.service(sql)) || '');
    const accepted = (sql) => !db.mustFail(() => db.service(sql));

    /* the rows the mirror actually builds */
    const sh = SYNC.shadowRows(slate, PARAMS);
    chk('the mirror builds one pregame row for Notre Dame at BYU', sh.length === 1 && sh[0].status === 'SHADOW' && sh[0].applied_points === 0, sh[0]);
    chk('its pregame row inserts as PostgREST would insert it', accepted(ins('cfb_altitude_shadow', sh[0])));
    chk('the same game x build x version twice is refused (exactly once)', refused(ins('cfb_altitude_shadow', Object.assign({}, sh[0], { shadow_id: 'cfbalt_' + 'b'.repeat(24) })), /duplicate key|unique/i));
    chk('the stored row says 0 points and the V1 margin unchanged',
      db.sql(`select applied_points || '|' || published_home_margin || '|' || baseline_home_margin || '|' || away_gain_ft from public.cfb_altitude_shadow where game_id = '401856809'`) === '0|-3.2|-3.2|3902');
    const reg = SYNC.registryRows(REG);
    chk('the whole registry inserts (' + reg.length + ' venues)', reg.every((r) => accepted(ins('cfb_venue_elevation', r))));
    chk('the current view resolves LaVell Edwards Stadium to 4,632.9 ft', db.sql(`select elev_ft from public.cfb_venue_elevation_current where venue_id = 3801`) === '4632.9');
    chk('Hughes Stadium keeps its own elevation, flagged as a legacy id', db.sql(`select elev_ft || '|' || legacy_of || '|' || confidence from public.cfb_venue_elevation_current where venue_id = 3761`) === '5167.1|5388|MEDIUM');
    const vr = SYNC.validationRow(VAL, PARAMS);
    chk('the validation run inserts', accepted(ins('cfb_altitude_validation_runs', vr)));
    chk('the monitor counts the game and 0 points applied',
      db.sql(`select games || '|' || applied_games || '|' || total_abs_points_applied from public.cfb_altitude_monitor where exposure_class = 'HIGH'`) === '1|0|0.000');

    /* the rules */
    const base = Object.assign({}, sh[0], { shadow_id: 'cfbalt_' + 'c'.repeat(24), prediction_ts: '2026-10-17T17:00:00.000Z' });
    chk('a record at or after kickoff is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, base, { prediction_ts: '2026-10-17T23:30:00.000Z' }))));
    chk('points applied while SHADOW are refused', refused(ins('cfb_altitude_shadow', Object.assign({}, base, { applied_points: 0.76, published_home_margin: -2.44 }))));
    chk('APPLIED with the flag off is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, base, { status: 'APPLIED', applied_points: 0.76, published_home_margin: -2.44 }))));
    chk('APPLIED with the flag on but parameters not VALIDATED is refused',
      refused(ins('cfb_altitude_shadow', Object.assign({}, base, { status: 'APPLIED', flag_enabled: true, params_status: 'REJECTED', applied_points: 0.76, published_home_margin: -2.44 }))));
    chk('all three locks open: accepted',
      accepted(ins('cfb_altitude_shadow', Object.assign({}, base, { status: 'APPLIED', flag_enabled: true, params_status: 'VALIDATED', applied_points: 0.76, published_home_margin: -2.44 }))));
    const b2 = Object.assign({}, base, { shadow_id: 'cfbalt_' + 'd'.repeat(24), prediction_ts: '2026-10-17T18:00:00.000Z', status: 'APPLIED', flag_enabled: true, params_status: 'VALIDATED' });
    chk('beyond the 3-point cap is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, b2, { applied_points: 3.5, published_home_margin: 0.3 }))));
    chk('a published margin that is not V1 + applied is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, b2, { applied_points: 0.76, published_home_margin: -1 }))));
    chk('an adjusted neutral site is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, b2, { neutral_site: true, applied_points: 0.76, published_home_margin: -2.44 }))));
    chk('a neutral site recorded as SHADOW is refused (it is NOT_APPLICABLE)', refused(ins('cfb_altitude_shadow', Object.assign({}, b2, { neutral_site: true, status: 'SHADOW', flag_enabled: false, params_status: 'REJECTED' }))));
    chk('a payload that is not the section is refused', refused(ins('cfb_altitude_shadow', Object.assign({}, b2, { status: 'SHADOW', flag_enabled: false, params_status: 'REJECTED', payload: { schema: 'other' } }))));
    chk('a run that claims points without VALIDATED is refused', refused(ins('cfb_altitude_validation_runs', Object.assign({}, vr, { validation_id: 'cfbav_' + 'e'.repeat(24), generated_at: '2026-10-18T00:00:00Z', points_applied: true }))));
    chk('a run that claims SUPPORTED without VALIDATED is refused', refused(ins('cfb_altitude_validation_runs', Object.assign({}, vr, { validation_id: 'cfbav_' + 'f'.repeat(24), generated_at: '2026-10-19T00:00:00Z', support_state: 'SUPPORTED' }))));
    chk('an elevation outside -300..15,000 ft is refused', refused(ins('cfb_venue_elevation', Object.assign({}, reg[0], { elevation_id: 'cfbve_' + '9'.repeat(24), registry_generated_at: '2030-01-01T00:00:00Z', elev_ft: 40000 }))));
    chk('a legacy id cannot be HIGH confidence', refused(ins('cfb_venue_elevation', Object.assign({}, reg[0], { elevation_id: 'cfbve_' + '8'.repeat(24), registry_generated_at: '2030-01-02T00:00:00Z', legacy_of: 5388, confidence: 'HIGH' }))));

    /* append-only */
    ['cfb_altitude_shadow', 'cfb_venue_elevation', 'cfb_altitude_validation_runs'].forEach((t) => {
      chk(t + ': UPDATE refused for the service role', /append-only|permission denied/.test(db.mustFail(() => db.service(`update public.${t} set recorded_at = now();`)) || ''));
      chk(t + ': UPDATE refused for the owner (the trigger)', /append-only/.test(db.mustFail(() => db.sql(`update public.${t} set recorded_at = now();`)) || ''));
      chk(t + ': DELETE refused for the owner', /append-only/.test(db.mustFail(() => db.sql(`delete from public.${t};`)) || ''));
      chk(t + ': TRUNCATE refused', /append-only/.test(db.mustFail(() => db.sql(`truncate public.${t};`)) || ''));
    });

    /* access */
    chk('authenticated reads the latest pregame record', db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_altitude_shadow_latest;`) === '1');
    chk('authenticated cannot write', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', ins('cfb_altitude_validation_runs', Object.assign({}, vr, { validation_id: 'cfbav_' + '7'.repeat(24), generated_at: '2026-10-20T00:00:00Z' })))));
    chk('anon reads nothing', !!db.mustFail(() => db.anon(`select count(*) from public.cfb_altitude_shadow;`)));

    /* rollback, then re-apply */
    const rb = db.applyFile(SQL('altitude_shadow_rollback'));
    chk('the rollback removes every object, every report row ok', !/CHECK THIS/.test(rb) && db.sql(`select to_regclass('public.cfb_altitude_shadow') is null`) === 't', rb.slice(-300));
    chk('the module re-applies cleanly after a rollback', !/CHECK THIS/.test(db.applyFile(SQL('cfb_altitude'))));
  } finally { db.stop(); }

  /* ---------------------------------------------------------- with the switch table */
  db = PG.start('cfbaltflag');
  if (!db || db.skip) return done('SKIP | ' + ((db && db.skip) || 'no postgres'));
  try {
    for (const f of ['cfb_lab', 'cfb_weekly', 'cfb_personnel', 'cfb_decision', 'cfb_production']) db.applyFile(SQL(f));
    const r = db.applyFile(SQL('cfb_altitude'));
    chk('with cfb_production.sql applied, every report row ok and the switch declared', !/CHECK THIS/.test(r) && !/skipped/.test(r), r.slice(-400));
    chk('the switch is OFF, COMPONENT, guarded', db.sql(`select enabled || '|' || kind || '|' || guarded from public.cfb_feature_flags where flag = 'cfb_altitude_adjustment_enabled'`) === 'false|COMPONENT|true');
    /* every statement ends in ';': db.service() appends `commit;` on the next line */
    const door = (actor, ev) => db.mustFail(() => db.service(`select public.cfb_set_feature_flag('cfb_altitude_adjustment_enabled', true, '${actor}', 'turning the altitude adjustment on'${ev ? ", '" + ev + "'" : ''});`));
    chk('the door refuses to switch it on without evidence', /evidence/.test(door('Jane Analyst') || ''));
    chk('the door refuses automation, even with evidence', /only a person/.test(door('github-actions', 'football/validation/altitude_cfb.json') || ''));
    chk('a person with evidence can switch it on', !door('Jane Analyst', 'football/validation/altitude_cfb.json#run'));
    chk('a re-apply does not reset a person’s switch', (db.applyFile(SQL('cfb_altitude')), db.sql(`select enabled from public.cfb_feature_flags where flag = 'cfb_altitude_adjustment_enabled'`)) === 't');
    const rb = db.applyFile(SQL('altitude_shadow_rollback'));
    chk('the rollback switches it off through the audited door', !/CHECK THIS/.test(rb) && db.sql(`select enabled from public.cfb_feature_flags where flag = 'cfb_altitude_adjustment_enabled'`) === 'f', rb.slice(-300));
    chk('the switch change is in the audit log', Number(db.sql(`select count(*) from public.cfb_audit_log where subject = 'cfb_altitude_adjustment_enabled' and event_type = 'FEATURE_FLAG_CHANGE'`)) >= 2);
  } catch (e) {
    chk('the production flag table applies', false, String(e.message).slice(0, 400));
  } finally { db.stop(); }
  done();
}
run();
