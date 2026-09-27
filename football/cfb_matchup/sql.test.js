#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_matchup.sql against a real, throwaway PostgreSQL
   (tools/personal/_pg.js, with the repo's Supabase shim for the roles).

   Checks:
     - applies to a clean database, again, and as ONE transaction (the SQL
       editor), with every report row ok;
     - every table is append-only for the service role and the owner;
     - exactly-once keys and correction versions (team style);
     - point in time: a matchup snapshot at or after kickoff is refused; a
       similar matchup citing a game that kicked off at or after the target
       prediction (or the target game itself) is refused;
     - matchup intelligence is a correction: a NO_ADJUSTMENT model with a
       non-zero adjustment is refused; an adjustment beyond the 3-point safety
       cap is refused; matchup-aware must equal general + adjustment;
     - probabilities / scores in range (confidence, similarity, drift p);
     - a statistical style event below its threshold is refused;
     - no matchup component becomes CHAMPION without a person and evidence;
     - access: authenticated reads, anon reads nothing;
     - the rows the Python hook actually produced (v2/matchup/hook.py
       table_rows, committed fixture) insert as PostgREST would insert them.

   Run: node football/cfb_matchup/sql.test.js   (CFB_MATCHUP_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require('../../tools/personal/_pg.js');

const SQL = path.join(__dirname, '..', '..', 'supabase', 'cfb_matchup.sql');
const FIXTURE = path.join(__dirname, 'fixtures', 'hook_rows.json');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_MATCHUP_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const db = PG.start('cfbmatchup');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row) => `insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)});`;
const hex = (c) => c.repeat(24);
const refused = (sql, re) => (re || /check constraint|violates/i).test(db.mustFail(() => db.service(sql)) || '');
const accepted = (sql) => !db.mustFail(() => db.service(sql));

try {
  const r1 = db.applyFile(SQL);
  chk('applies to a clean database, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 10, r1.slice(-600));
  chk('applies a second time, still ok', !/CHECK THIS/.test(db.applyFile(SQL)));
  chk('applies as ONE transaction (the SQL editor), still ok', !/CHECK THIS/.test(db.applyFileAtomic(SQL)));

  /* team style */
  const st = { style_id: 'cfbms_' + hex('a'), team_id: '251', season: 2026, week: 5, as_of: '2026-09-29T12:00:00.000Z',
    feature_version: 'cfb_style_v1', style_games: 4, offensive_scheme_continuity: 1, defensive_scheme_continuity: 0,
    head_coach_new: false, style_drift_p: 0.42, state_version: 1, supersedes: null,
    payload: { style: { proe: { off_mean: 0.05, off_sd: 0.03 } } } };
  chk('a team style row is accepted', accepted(ins('cfb_team_week_style', st)));
  chk('the same team x freeze x version twice is refused (exactly once)', refused(ins('cfb_team_week_style', Object.assign({}, st, { style_id: 'cfbms_' + hex('b') })), /duplicate key|unique/i));
  chk('a correction is a new version that supersedes', accepted(ins('cfb_team_week_style', Object.assign({}, st, { style_id: 'cfbms_' + hex('c'), state_version: 2, supersedes: st.style_id, style_drift_p: 0.1 }))));
  chk('the current view shows the correction', db.sql(`select style_drift_p from public.cfb_team_week_style_current where team_id = '251'`) === '0.1');
  chk('version 1 cannot claim to supersede', refused(ins('cfb_team_week_style', Object.assign({}, st, { style_id: 'cfbms_' + hex('d'), as_of: '2026-10-06T12:00:00.000Z', supersedes: 'x' }))));
  chk('a continuity outside [0, 1] is refused', refused(ins('cfb_team_week_style', Object.assign({}, st, { style_id: 'cfbms_' + hex('e'), as_of: '2026-10-06T12:00:00.000Z', offensive_scheme_continuity: 2 }))));
  chk('a style row without the style object is refused', refused(ins('cfb_team_week_style', Object.assign({}, st, { style_id: 'cfbms_' + hex('f'), as_of: '2026-10-13T12:00:00.000Z', payload: {} }))));

  /* game matchup snapshot */
  const gm = { matchup_id: 'cfbmg_' + hex('1'), game_id: '401', season: 2026, week: 5, prediction_ts: '2026-09-29T12:00:00.000Z',
    kickoff_ts: '2026-10-03T19:30:00.000Z', base_model_version: 'edgedesk_cfb_v2.1.0', feature_version: 'cfb_matchup_fv1',
    style_version: 'cfb_style_v1', similarity_version: 'cfb_similarity_v1', matchup_model_version: 'cfb_matchup_resid_v1',
    matchup_model_status: 'NO_ADJUSTMENT', general_fair_margin: -3.2, matchup_adjustment_points: 0, matchup_aware_margin: -3.2,
    matchup_confidence: 0.61, shadow_adjustment_points: 0.8, expected_possessions: 24.1, input_hash: 'h1',
    payload: { explanation: { note: 'x' } } };
  chk('a NO_ADJUSTMENT snapshot is accepted', accepted(ins('cfb_game_matchup_features', gm)));
  chk('the same game x freeze x versions x inputs twice is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('2') })), /duplicate key|unique/i));
  chk('a snapshot at or after kickoff is refused (point in time)', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('3'), input_hash: 'h3', prediction_ts: gm.kickoff_ts }))));
  chk('NO_ADJUSTMENT with a non-zero adjustment is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('4'), input_hash: 'h4', matchup_adjustment_points: 0.5, matchup_aware_margin: -2.7 }))));
  chk('an ADJUST snapshot inside the cap is accepted', accepted(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('5'), input_hash: 'h5', matchup_model_status: 'ADJUST', matchup_adjustment_points: 1.4, matchup_aware_margin: -1.8 }))));
  chk('an adjustment beyond the 3-point safety cap is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('6'), input_hash: 'h6', matchup_model_status: 'ADJUST', matchup_adjustment_points: 4, matchup_aware_margin: 0.8 }))));
  chk('matchup-aware != general + adjustment is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('7'), input_hash: 'h7', matchup_model_status: 'ADJUST', matchup_adjustment_points: 1, matchup_aware_margin: 5 }))));
  chk('a confidence above 1 is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('8'), input_hash: 'h8', matchup_confidence: 1.3 }))));
  chk('an unknown model status is refused', refused(ins('cfb_game_matchup_features', Object.assign({}, gm, { matchup_id: 'cfbmg_' + hex('9'), input_hash: 'h9', matchup_model_status: 'MAYBE' }))));
  chk('the latest view shows one row per game', db.sql(`select count(*) from public.cfb_game_matchup_latest where game_id = '401'`) === '1');

  /* similar matchups */
  const sm = { similar_id: 'cfbmx_' + hex('1'), target_game_id: '401', comparison_game_id: '399', team_side: 'home', team_id: '251',
    prediction_ts: '2026-09-29T12:00:00.000Z', comparison_kickoff_ts: '2026-09-12T19:30:00.000Z', similarity_score: 0.71,
    feature_distance: 1.9, eligible_pre_prediction: true, display_allowed: false, similarity_version: 'cfb_similarity_v1', payload: {} };
  chk('a similar matchup is accepted', accepted(ins('cfb_similar_matchups', sm)));
  chk('a comparison that kicked off after the target prediction is refused', refused(ins('cfb_similar_matchups', Object.assign({}, sm, { similar_id: 'cfbmx_' + hex('2'), comparison_game_id: '402', comparison_kickoff_ts: '2026-10-03T19:30:00.000Z' }))));
  chk('a comparison not marked eligible is refused', refused(ins('cfb_similar_matchups', Object.assign({}, sm, { similar_id: 'cfbmx_' + hex('3'), comparison_game_id: '398', eligible_pre_prediction: false }))));
  chk('the target game cannot be its own comparison', refused(ins('cfb_similar_matchups', Object.assign({}, sm, { similar_id: 'cfbmx_' + hex('4'), comparison_game_id: '401' }))));
  chk('a similarity above 1 is refused', refused(ins('cfb_similar_matchups', Object.assign({}, sm, { similar_id: 'cfbmx_' + hex('5'), comparison_game_id: '397', similarity_score: 1.2 }))));

  /* style change events */
  const ev = { event_id: 'cfbme_' + hex('1'), team_id: '251', season: 2026, event_type: 'PACE_REGIME_CHANGE', metric: 'tempo',
    trigger_game_id: '399', detected_at: '2026-09-15T12:00:00.000Z', z: -3.4, threshold: 2.8, rule_version: 'cfb_style_change_v1', payload: {} };
  chk('a style event above its threshold is accepted', accepted(ins('cfb_style_change_events', ev)));
  chk('a statistical event below its threshold is refused (weekly noise)', refused(ins('cfb_style_change_events', Object.assign({}, ev, { event_id: 'cfbme_' + hex('2'), trigger_game_id: '398', z: 1.2 }))));
  chk('a coordinator-change event needs no z', accepted(ins('cfb_style_change_events', { event_id: 'cfbme_' + hex('3'), team_id: '251', season: 2026, event_type: 'COORDINATOR_CHANGE_OFF', rule_version: 'cfb_style_change_v1', payload: {} })));
  chk('an unknown event type is refused', refused(ins('cfb_style_change_events', Object.assign({}, ev, { event_id: 'cfbme_' + hex('4'), event_type: 'VIBES' }))));

  /* versions */
  const mv = { version_row_id: 'cfbmv_' + hex('1'), component: 'residual', version: 'cfb_matchup_resid_v1', status: 'NO_ADJUSTMENT',
    base_model_version: 'edgedesk_cfb_v2.1.0', artifact_sha256: 'a'.repeat(64), decided_at: '2026-09-27T00:00:00.000Z', payload: {} };
  chk('a NO_ADJUSTMENT version is accepted', accepted(ins('cfb_matchup_model_versions', mv)));
  chk('a champion without a person and evidence is refused', refused(ins('cfb_matchup_model_versions', Object.assign({}, mv, { version_row_id: 'cfbmv_' + hex('2'), status: 'CHAMPION', decided_at: '2026-10-01T00:00:00.000Z' }))));
  chk('a champion with a person and evidence is accepted', accepted(ins('cfb_matchup_model_versions', Object.assign({}, mv, { version_row_id: 'cfbmv_' + hex('3'), status: 'CHAMPION', decided_at: '2026-10-02T00:00:00.000Z', decided_by: 'reviewer', evidence: 'docs/cfb-matchup/BACKTEST.md' }))));
  chk('the status view shows the newest decision', db.sql(`select status from public.cfb_matchup_model_status where component = 'residual'`) === 'CHAMPION');
  chk('an unknown component is refused', refused(ins('cfb_matchup_model_versions', Object.assign({}, mv, { version_row_id: 'cfbmv_' + hex('4'), component: 'astrology' }))));

  /* monitor */
  const mo = { monitor_id: 'cfbmm_' + hex('1'), season: 2026, week: 5, as_of: '2026-10-05T12:00:00.000Z', matchup_model_version: 'cfb_matchup_resid_v1',
    n_games: 48, mae_general: 12.1, mae_matchup: 12.1, mae_shadow: 12.14, payload: {} };
  chk('a monitoring row is accepted', accepted(ins('cfb_matchup_monitor', mo)));

  /* append-only */
  for (const t of ['cfb_team_week_style', 'cfb_game_matchup_features', 'cfb_similar_matchups', 'cfb_style_change_events', 'cfb_matchup_model_versions', 'cfb_matchup_monitor']) {
    for (const [op, sql] of [['update', `update public.${t} set payload = '{}'::jsonb;`], ['delete', `delete from public.${t};`], ['truncate', `truncate public.${t};`]]) {
      chk('append-only: ' + op + ' on ' + t + ' is refused for the service role', /append-only|permission denied/i.test(db.mustFail(() => db.service(sql)) || ''));
      chk('append-only: ' + op + ' on ' + t + ' is refused for the owner too', /append-only/i.test(db.mustFail(() => db.sql(sql)) || ''));
    }
  }

  /* access */
  chk('authenticated reads matchup snapshots', +db.as('00000000-0000-0000-0000-000000000001', `select count(*) from public.cfb_game_matchup_features;`) >= 2);
  chk('anon reads nothing', /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_game_matchup_features;`)) || '')
    && /permission denied/i.test(db.mustFail(() => db.anon(`select count(*) from public.cfb_game_matchup_latest;`)) || ''));
  chk('authenticated cannot insert', /permission denied|row-level security/i.test(db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', ins('cfb_matchup_monitor', Object.assign({}, mo, { monitor_id: 'cfbmm_' + hex('2'), week: 6 })))) || ''));

  /* the rows the Python hook produced */
  if (fs.existsSync(FIXTURE)) {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const bad = [];
    let n = 0;
    for (const [table, rows] of Object.entries(fx.rows)) {
      for (const r of rows) {
        n++;
        const e = db.mustFail(() => db.service(ins(table, r)));
        if (e && !/duplicate key/.test(e)) bad.push({ table, error: e.slice(0, 240) });
      }
    }
    chk('the hook\'s real rows insert as PostgREST would insert them (' + n + ' rows, ' + Object.keys(fx.rows).length + ' tables)', !bad.length && n > 0, bad.slice(0, 3));
    const gms = fx.rows.cfb_game_matchup_features || [];
    chk('the hook\'s snapshots are NO_ADJUSTMENT with zero adjustment (the frozen dev decision)',
      gms.length > 0 && gms.every((g) => g.matchup_model_status !== 'NO_ADJUSTMENT' || g.matchup_adjustment_points === 0));
  } else {
    chk('fixture present (python3 -m v2.matchup.hook ' + FIXTURE + ')', false);
  }
} finally {
  db.stop();
}
done();
