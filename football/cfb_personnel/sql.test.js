#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_personnel.sql against a real, throwaway PostgreSQL
   (tools/personal/_pg.js, with the repo's Supabase shim for the roles).

   Checks:
     - applies to a clean database, again, and as ONE transaction (the SQL
       editor), with every report row ok;
     - every table is append-only for the service role and the owner;
     - exactly-once keys and correction versions (player-week state);
     - probabilities are probabilities; SDs are not negative;
     - point in time: a game snapshot at or after kickoff is refused; an
       event known before it happened is refused; a transfer runs forward;
     - lineup scenarios must sum to one;
     - the depth chart can only be usage-derived (no provider has one);
     - no personnel version becomes CHAMPION without a person and evidence;
     - an event that triggers a refresh must say why;
     - access: authenticated reads, anon reads nothing (player rows are internal);
     - the mirror's rows (sync_supabase.js shape()) insert as PostgREST would,
       from the committed ledger when one exists.

   Run: node football/cfb_personnel/sql.test.js   (CFB_PERSONNEL_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require('../../tools/personal/_pg.js');
const SY = require('./sync_supabase.js');

const SQL = path.join(__dirname, '..', '..', 'supabase', 'cfb_personnel.sql');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_PERSONNEL_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const db = PG.start('cfbpersonnel');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;
const hex = (c) => c.repeat(24);
const refused = (sql, re) => (re || /check constraint|violates/i).test(db.mustFail(() => db.service(sql)) || '');
const accepted = (sql) => !db.mustFail(() => db.service(sql));

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 12, r1.slice(-600));
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction (the SQL editor), still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  /* registry */
  const pl = { player_row_id: 'cfbpl_' + hex('a'), player_id: 'espn:4431611', espn_id: 4431611, registry_version: 'r1',
    full_name: 'A Quarterback', team_id: '251', first_season: 2023, last_season: 2026, payload: {} };
  chk('a registry row is accepted', accepted(ins('cfb_players', pl)));
  chk('a player id outside the one id system is refused', refused(ins('cfb_players', Object.assign({}, pl, { player_row_id: 'cfbpl_' + hex('b'), player_id: 'cfbd:12' }))));
  chk('the same player and registry version twice is refused', refused(ins('cfb_players', Object.assign({}, pl, { player_row_id: 'cfbpl_' + hex('c') })), /duplicate key|unique/i));
  chk('a new registry version of the same player is accepted', accepted(ins('cfb_players', Object.assign({}, pl, { player_row_id: 'cfbpl_' + hex('d'), registry_version: 'r2', team_id: '2' }))));
  chk('the current registry view shows one row per player', db.sql(`select count(*) from public.cfb_players_current where player_id = 'espn:4431611'`) === '1');
  const tr = { transfer_id: 'cfbtr_' + hex('1'), player_id: pl.player_id, event_type: 'TRANSFER', from_team: '251', to_team: '2',
    from_season: 2025, to_season: 2026, known_from: '2026-08-30T19:00:00.000Z', payload: {} };
  chk('a transfer is accepted', accepted(ins('cfb_transfer_history', tr)));
  chk('a transfer that runs backward in time is refused', refused(ins('cfb_transfer_history', Object.assign({}, tr, { transfer_id: 'cfbtr_' + hex('2'), from_season: 2026, to_season: 2025 }))));

  /* player-week state */
  const st = { player_week_state_id: 'cfbpws_' + hex('1'), player_id: pl.player_id, team_id: '2', season: 2026,
    as_of: '2026-09-29T12:00:00.000Z', rule_version: 'cfb_player_week_state_v1', position_family: 'QB', unit: 'QB', role: 'STARTER',
    expected_usage_share: 0.93, starter_probability: 0.9, expected_availability: 1, player_value_mean: 2.1, player_value_sd: 1.4,
    source_quality: 'HIGH', state_version: 1, supersedes: null, payload: {} };
  chk('a player-week state is accepted', accepted(ins('cfb_player_week_state', st)));
  chk('a duplicate player-week state is refused (exactly once)', refused(ins('cfb_player_week_state', Object.assign({}, st, { player_week_state_id: 'cfbpws_' + hex('2') })), /duplicate key|unique/i));
  chk('a correction is a new version that supersedes', accepted(ins('cfb_player_week_state', Object.assign({}, st, { player_week_state_id: 'cfbpws_' + hex('3'), state_version: 2, supersedes: st.player_week_state_id, starter_probability: 0.4 }))));
  chk('the current view shows the correction', db.sql(`select starter_probability from public.cfb_player_week_state_current where player_id = 'espn:4431611'`) === '0.4');
  chk('a starter probability above 1 is refused', refused(ins('cfb_player_week_state', Object.assign({}, st, { player_week_state_id: 'cfbpws_' + hex('4'), as_of: '2026-10-06T12:00:00.000Z', starter_probability: 1.2 }))));
  chk('a negative value SD is refused', refused(ins('cfb_player_week_state', Object.assign({}, st, { player_week_state_id: 'cfbpws_' + hex('5'), as_of: '2026-10-06T12:00:00.000Z', player_value_sd: -1 }))));
  chk('version 1 cannot claim to supersede', refused(ins('cfb_player_week_state', Object.assign({}, st, { player_week_state_id: 'cfbpws_' + hex('6'), as_of: '2026-10-13T12:00:00.000Z', supersedes: 'x' }))));
  for (const [op, sql] of [['update', `update public.cfb_player_week_state set role = 'X';`], ['delete', `delete from public.cfb_player_week_state;`],
    ['truncate', `truncate public.cfb_player_week_state;`]]) {
    chk('append-only: ' + op + ' is refused for the service role', /append-only|permission denied/i.test(db.mustFail(() => db.service(sql)) || ''));
    chk('append-only: ' + op + ' is refused for the owner too', /append-only/i.test(db.mustFail(() => db.sql(sql)) || ''));
  }

  /* depth chart, units */
  const dc = { depth_chart_state_id: 'cfbdc_' + hex('1'), team_id: '2', season: 2026, as_of: st.as_of, position_family: 'WR', unit: 'WR_TE',
    source: 'usage_derived', ordering: 'usage_share', confidence: 0.7, rule_version: 'cfb_depth_chart_state_v1', payload: {} };
  chk('a usage-derived depth chart is accepted', accepted(ins('cfb_depth_chart_state', dc)));
  chk('a depth chart claiming a provider source is refused', refused(ins('cfb_depth_chart_state', Object.assign({}, dc, { depth_chart_state_id: 'cfbdc_' + hex('2'), position_family: 'RB', source: 'provider' }))));
  const us = { unit_state_id: 'cfbpu_' + hex('1'), team_id: '2', season: 2026, as_of: st.as_of, unit: 'OL', rule_version: 'cfb_personnel_units_v1',
    knowledge: 'KNOWN', value_status: 'NOT_ESTIMATED', lineup_delta_pts: 0, lineup_delta_sd: 0, variance_inflation_pts2: 2.0,
    state_version: 1, supersedes: null, payload: {} };
  chk('an uncertainty-only OL unit state is accepted', accepted(ins('cfb_personnel_unit_state', us)));
  chk('an unknown knowledge label is refused (UNKNOWN is not HEALTHY)', refused(ins('cfb_personnel_unit_state', Object.assign({}, us, { unit_state_id: 'cfbpu_' + hex('2'), unit: 'RB', knowledge: 'HEALTHY' }))));

  /* events */
  const ev = { event_id: 'cfbpe_' + hex('1'), player_id: pl.player_id, team_id: '2', season: 2026, event_type: 'AVAILABILITY_REPORTED',
    event_ts: '2026-10-01T18:00:00.000Z', known_at: '2026-10-01T18:00:00.000Z', source: 'official_report', source_tier: 1,
    triggers_refresh: true, refresh_reason: 'expected starter QB listed OUT', payload: {} };
  chk('a player event is accepted', accepted(ins('cfb_player_events', ev)));
  chk('an event known before it happened is refused', refused(ins('cfb_player_events', Object.assign({}, ev, { event_id: 'cfbpe_' + hex('2'), known_at: '2026-10-01T17:00:00.000Z' }))));
  chk('a refresh trigger without a reason is refused', refused(ins('cfb_player_events', Object.assign({}, ev, { event_id: 'cfbpe_' + hex('3'), refresh_reason: null }))));
  chk('an unknown event type is refused', refused(ins('cfb_player_events', Object.assign({}, ev, { event_id: 'cfbpe_' + hex('4'), event_type: 'RUMOR' }))));

  /* game snapshots */
  const gs = { snapshot_id: 'cfbpg_' + hex('1'), game_id: '401', season: 2026, week: 5, as_of: '2026-09-29T12:00:00.000Z',
    kickoff_ts: '2026-10-03T19:30:00.000Z', personnel_version: 'cfb_personnel_v1', base_model_version: 'edgedesk_cfb_v2.1.0',
    input_hash: 'h1', n_scenarios: 2, scenario_p_sum: 1.0, base_margin: -3.2, personnel_margin: -5.1, personnel_sigma: 16.2,
    p_home: 0.37, delta_margin: -1.9, payload: {} };
  chk('a game snapshot is accepted', accepted(ins('cfb_personnel_game_snapshot', gs)));
  chk('a snapshot at or after kickoff is refused (point in time)', refused(ins('cfb_personnel_game_snapshot', Object.assign({}, gs, { snapshot_id: 'cfbpg_' + hex('2'), input_hash: 'h2', as_of: gs.kickoff_ts }))));
  chk('scenarios that do not sum to one are refused', refused(ins('cfb_personnel_game_snapshot', Object.assign({}, gs, { snapshot_id: 'cfbpg_' + hex('3'), input_hash: 'h3', scenario_p_sum: 0.85 }))));
  chk('the same game x as_of x version x inputs twice is refused', refused(ins('cfb_personnel_game_snapshot', Object.assign({}, gs, { snapshot_id: 'cfbpg_' + hex('4') })), /duplicate key|unique/i));

  /* versions */
  const mv = { version_row_id: 'cfbpv_' + hex('1'), personnel_version: 'cfb_personnel_v1', component: 'qb', status: 'CHALLENGER',
    base_model_version: 'edgedesk_cfb_v2.1.0', decided_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('a challenger version is accepted', accepted(ins('cfb_personnel_model_versions', mv)));
  chk('a champion without a person and evidence is refused', refused(ins('cfb_personnel_model_versions', Object.assign({}, mv, { version_row_id: 'cfbpv_' + hex('2'), status: 'CHAMPION' }))));
  chk('a champion with a person and evidence is accepted', accepted(ins('cfb_personnel_model_versions', Object.assign({}, mv, { version_row_id: 'cfbpv_' + hex('3'), status: 'CHAMPION', decided_at: '2026-10-01T00:00:00.000Z', decided_by: 'reviewer', evidence: 'docs/cfb-personnel/BACKTEST.md' }))));
  chk('the status view shows the newest decision', db.sql(`select status from public.cfb_personnel_model_status where component = 'qb'`) === 'CHAMPION');

  /* access */
  chk('authenticated reads player state', db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_player_week_state;`) === '2');
  chk('anon reads nothing (player rows are internal)', /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_player_week_state;`)) || '')
    && /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_player_week_state_current;`)) || ''));

  /* the mirror's own rows */
  const now = new Date();
  const season = now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const P = SY.plan(season);
  const withRows = P.filter((x) => x.rows.length);
  const bad = [];
  for (const x of withRows) {
    const e = db.mustFail(() => db.service(x.rows.slice(0, 40).map((r) => ins(x.table, r)).join('\n')));
    if (e && !/duplicate key/.test(e)) bad.push({ table: x.table, error: e.slice(0, 200) });
  }
  chk('the mirror\'s rows insert as PostgREST would insert them (' + withRows.length + ' tables with rows)', !bad.length, bad);
} finally {
  db.stop();
}
done();
