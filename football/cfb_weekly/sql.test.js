#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_weekly.sql against a real, throwaway PostgreSQL
   (tools/personal/_pg.js, with the repo's Supabase shim for the roles).

   Checks:
     - applies to a clean database, again, and as ONE transaction (the SQL
       editor), with every report row ok;
     - every table is append-only for the service role too (update, delete,
       truncate refused);
     - exactly-once keys: a second row for the same team x season x week x
       feature_version x state_version is refused; a correction (state_version 2,
       supersedes set) is accepted; version 1 cannot claim to supersede;
     - point in time: a feature snapshot at or after kickoff is refused;
     - projection checks (probability, sigma, mode);
     - access: authenticated reads, anon reads nothing, anon cannot poke;
     - the dispatcher: an unknown mode is refused, no token -> no_token;
     - the mirror's rows (football/cfb_weekly/sync_supabase.js shape()) insert
       as PostgREST would insert them, for every table, from a real run's
       ledger when one exists.

   Run: node football/cfb_weekly/sql.test.js   (CFB_WEEKLY_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const SY = require('./sync_supabase.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = path.join(ROOT, 'supabase', 'cfb_weekly.sql');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_WEEKLY_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const db = PG.start('cfbweekly');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;
const hex = (c) => c.repeat(24);

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 13, r1.slice(-600));
  const r2 = db.applyFile(SQL);
  chk('applies a second time, still ok', !/CHECK THIS/.test(r2));
  const r3 = db.applyFileAtomic(SQL);
  chk('applies as ONE transaction (the SQL editor), still ok', !/CHECK THIS/.test(r3));

  const team = { state_id: 'cfbs_' + hex('a'), team_id: '251', season: 2026, week: 4, feature_version: 'cfb_v2_fv2',
    model_version: 'edgedesk_cfb_v2.1.0', as_of: '2026-09-29T12:00:00.000Z', overall_mean: 12.5, overall_sd: 3.1,
    state_version: 1, supersedes: null, payload: { team_id: '251' } };
  chk('service role inserts a team state', !db.mustFail(() => db.service(ins('cfb_team_week_state', team))));
  chk('a duplicate natural key and version is refused (exactly once)',
    /duplicate key|unique/i.test(db.mustFail(() => db.service(ins('cfb_team_week_state', Object.assign({}, team, { state_id: 'cfbs_' + hex('b') })))) || ''));
  chk('a correction is a new state_version that supersedes', !db.mustFail(() => db.service(ins('cfb_team_week_state',
    Object.assign({}, team, { state_id: 'cfbs_' + hex('c'), state_version: 2, supersedes: team.state_id, overall_mean: 12.9 })))));
  chk('version 1 cannot claim to supersede, version 2 must',
    /check constraint/i.test(db.mustFail(() => db.service(ins('cfb_team_week_state', Object.assign({}, team, { state_id: 'cfbs_' + hex('d'), week: 5, supersedes: 'x' })))) || '')
    && /check constraint/i.test(db.mustFail(() => db.service(ins('cfb_team_week_state', Object.assign({}, team, { state_id: 'cfbs_' + hex('e'), week: 6, state_version: 2, supersedes: null })))) || ''));
  chk('the current view shows the newest version', db.sql(`select overall_mean from public.cfb_team_week_state_current where team_id='251' and week=4`) === '12.9');
  for (const [op, sql] of [['update', `update public.cfb_team_week_state set overall_mean = 0;`], ['delete', `delete from public.cfb_team_week_state;`],
    ['truncate', `truncate public.cfb_team_week_state;`]]) {
    chk('append-only: ' + op + ' is refused for the service role', /append-only|permission denied/i.test(db.mustFail(() => db.service(sql)) || ''));
    chk('append-only: ' + op + ' is refused for the owner too', /append-only/i.test(db.mustFail(() => db.sql(sql)) || ''));
  }
  const feat = { feature_snapshot_id: 'cfbf_' + hex('1'), game_id: '401', season: 2026, week: 5, kickoff_ts: '2026-10-03T19:30:00.000Z',
    prediction_ts: '2026-09-29T12:00:00.000Z', feature_ts: '2026-09-29T12:00:00.000Z', feature_version: 'cfb_v2_fv2',
    model_version: 'edgedesk_cfb_v2.1.0', input_hash: 'h1', payload: {} };
  chk('a feature snapshot before kickoff is accepted', !db.mustFail(() => db.service(ins('cfb_upcoming_game_features', feat))));
  chk('a feature snapshot at or after kickoff is refused (point in time)', /cfb_upcoming_features_pit/.test(db.mustFail(() => db.service(ins('cfb_upcoming_game_features',
    Object.assign({}, feat, { feature_snapshot_id: 'cfbf_' + hex('2'), input_hash: 'h2', feature_ts: '2026-10-03T19:30:00.000Z' })))) || ''));
  const proj = { projection_id: 'cfbj_' + hex('1'), game_id: '401', season: 2026, week: 5, prediction_ts: feat.prediction_ts,
    model_version: 'edgedesk_cfb_v2.1.0', feature_version: 'cfb_v2_fv2', feature_snapshot_id: feat.feature_snapshot_id, input_hash: 'h1',
    ens_pred: -3.2, sigma: 15.9, p_home_raw: 0.42, p_home_calibrated: 0.42, model_mode: 'FULL', payload: {} };
  chk('a projection is accepted', !db.mustFail(() => db.service(ins('cfb_weekly_projections', proj))));
  chk('a projection with probability 1 is refused', /prob/.test(db.mustFail(() => db.service(ins('cfb_weekly_projections',
    Object.assign({}, proj, { projection_id: 'cfbj_' + hex('2'), input_hash: 'h9', p_home_raw: 1 })))) || ''));
  chk('an unknown model mode is refused', /mode/.test(db.mustFail(() => db.service(ins('cfb_weekly_projections',
    Object.assign({}, proj, { projection_id: 'cfbj_' + hex('3'), input_hash: 'h8', model_mode: 'CONFIDENT' })))) || ''));
  chk('the same game x inputs x version cannot be projected twice', /unique|duplicate/i.test(db.mustFail(() => db.service(ins('cfb_weekly_projections',
    Object.assign({}, proj, { projection_id: 'cfbj_' + hex('4') })))) || ''));
  chk('authenticated reads the state', db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_team_week_state;`) === '2');
  chk('anon reads nothing', /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_team_week_state;`)) || ''));
  chk('anon cannot execute the dispatcher', /permission denied/i.test(db.mustFail(() => db.anon(`select public.cfb_weekly_poke('weekly');`)) || ''));
  chk('the dispatcher refuses an unknown mode', /mode must be/.test(db.sql(`select public.cfb_weekly_poke('retrain')`)));
  chk('without a token the dispatcher says no_token (never success)', /no_token/.test(db.sql(`select public.cfb_weekly_poke('weekly')`)));
  const stage = { run_id: 'cfbw_' + hex('9'), stage: 'VALIDATE_PBP', status: 'OK', counts: {} };
  chk('stage log accepts a known status', !db.mustFail(() => db.service(ins('cfb_pipeline_stage_log', stage))));
  chk('stage log refuses an unknown status and error class', /check constraint/i.test(db.mustFail(() => db.service(ins('cfb_pipeline_stage_log',
    Object.assign({}, stage, { stage: 'X', status: 'MAYBE' })))) || '') && /check constraint/i.test(db.mustFail(() => db.service(ins('cfb_pipeline_stage_log',
    Object.assign({}, stage, { stage: 'Y', status: 'FAILED', error_class: 'OOPS' })))) || ''));

  /* the mirror's own rows, from a real run's ledger when there is one */
  const now = new Date();
  const season = now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const P = SY.plan(season);
  const withRows = P.filter((x) => x.rows.length);
  let bad = [];
  for (const x of withRows) {
    const rows = x.rows.slice(0, 40);
    const e = db.mustFail(() => db.service(rows.map((r) => ins(x.table, r)).join('\n')));
    if (e && !/duplicate key/.test(e)) bad.push({ table: x.table, error: e.slice(0, 200) });
  }
  chk('the mirror\'s rows insert as PostgREST would insert them (' + withRows.length + ' tables with rows)', !bad.length, bad);
} finally {
  db.stop();
}
done();
