#!/usr/bin/env node
/* ===========================================================================
   supabase/cfb_production.sql, and every CFB database write path, against a
   real throwaway PostgreSQL (tools/personal/_pg.js with the Supabase shim),
   through a PostgREST stand-in (pgrest.js) so the mirrors run exactly as the
   jobs run them.

     A. applies after the CFB contracts, again, and as ONE transaction; applies
        FIRST on an empty database; a re-apply takes NO ACCESS EXCLUSIVE lock on
        any table (measured from pg_locks inside the transaction)
     B. append-only: manifest, audit log, incidents, heartbeats, lock events,
        corrections, compatibility — update / delete / truncate refused for the
        owner and the service role
     C. the manifest: pushed by manifest.js, write-once, NOT_RUN, a SELECTED
        champion without evidence refused, a rollback needs a reason, audited
     D. feature flags: only the function changes one; audited; guarded flags
        need evidence and a person; betting cannot be switched on while the
        manifest's policy has betting disabled; a re-apply never resets a flag
     E. the audit log hash chain: verifies; concurrent writers stay gap-free;
        a tampered row is found
     F. manual corrections: original read from the row, raw row untouched,
        outputs refused, revocation only of the current correction
     G. job locks: N sessions race for one key, exactly one wins; fencing;
        expired takeover; per-game locks independent; a second weekly mirror
        exits cleanly (PIPELINE_CONFLICT) and writes nothing
     H. CHAOS — a real deadlock (two sessions, opposite lock order): exactly one
        victim, its partial write rolled back; through the weekly mirror the
        victim chunk is retried with jitter, an incident is recorded, and the
        final state is complete and identical
     I. CHAOS — lock timeout: retried then succeeds; retries exhausted -> a
        classified DATABASE_TIMEOUT failure, a CRITICAL incident, nothing
        written; permanent errors (409 / 401 / PGRST102) never retried
     J. IDEMPOTENCY — every CFB mirror (weekly, personnel, decision, lab with
        the real ledger, V2) run 1x, 2x, 3x: identical state, no duplicate
        natural keys; lab SQL functions 3x; the manifest pushed 3x = one row;
        the optional market-integrity tables fail soft while missing
     K. published views: a half-mirrored run is invisible until its run row lands
     L. cfb_health(): every check, fresh and failing
     M. DISASTER RECOVERY: pg_dump -> restore into a new database -> the manifest,
        its artifacts (from git blobs), team state and predictions are back,
        identical; the audit chain still verifies; cfb_health() answers

   Run: node football/cfb_production/sql.test.js   (CFB_PRODUCTION_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const PG = require('../../tools/personal/_pg.js');
const PR = require('./pgrest.js');
const DB = require('./db.js');
const T = require('./taxonomy.js');
const LOCKS = require('./locks.js');
const MF = require('./manifest.js');
const J = require('./jobs.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = (f) => path.join(ROOT, 'supabase', f + '.sql');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_PRODUCTION_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres required but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const db = PG.start('cfbprod');
if (!db || db.skip) done('SKIP | ' + ((db && db.skip) || 'no postgres') + ' — the SQL layer did not run');

const asRoot = process.getuid && process.getuid() === 0;
let fno = 0;
function psqlDb(dbname, text, extra) {
  const f = path.join(db.home, 'x' + (fno++) + '.sql');
  fs.writeFileSync(f, text);
  if (asRoot) cp.execSync('chown postgres ' + f);
  const cmd = db.bin + '/psql -h ' + db.home + ' -p ' + db.port + ' -U postgres -d ' + dbname + ' -v ON_ERROR_STOP=1 -X -q -t -A ' + (extra || '') + ' -f ' + f;
  try { return cp.execSync(asRoot ? 'su postgres -c ' + JSON.stringify(cmd) : cmd, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch (e) { const err = new Error(String((e.stderr || '') + (e.stdout || '')).trim()); err.sqlMessage = err.message; throw err; }
}
function shell(cmd) { return cp.execSync(asRoot ? 'su postgres -c ' + JSON.stringify(cmd) : cmd, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

const URL_ = 'http://pgrest.test', KEY = 'service-role-test-key';
process.env.SB_URL = URL_; process.env.SB_SERVICE_ROLE = KEY;
const quietLog = (job) => require('./log.js').logger({ job, correlation_id: 'cfb-test-' + job }, { sink: () => {} });
const FAST = { base: { DATABASE_DEADLOCK: 20, DATABASE_TIMEOUT: 20, PROVIDER_TRANSIENT: 20, PROVIDER_RATE_LIMIT: 20, DATABASE_UNAVAILABLE: 20 },
  cap: { DATABASE_DEADLOCK: 60, DATABASE_TIMEOUT: 60, PROVIDER_TRANSIENT: 60, PROVIDER_RATE_LIMIT: 60, DATABASE_UNAVAILABLE: 60 } };
const hex = (c, n) => c.repeat(n || 24);
const J$ = (o) => PG.lit(JSON.stringify(o)) + '::jsonb';
const refused = (fn) => db.mustFail(fn);
/* a table's content, independent of physical order and of the server clock column */
function fingerprint(tables, dbname) {
  const q = tables.map((t) => `select '${t}' as t, count(*) as n, md5(coalesce(string_agg((to_jsonb(x) - 'recorded_at')::text, '|' order by (to_jsonb(x) - 'recorded_at')::text), '')) as h from public.${t} x`).join(' union all ');
  const out = dbname ? psqlDb(dbname, q + ';') : db.sql(q + ';');
  return out.split('\n').sort().join('\n');
}

(async () => {
  try {
    /* ================================================================ A. apply */
    for (const f of ['cfb_lab', 'cfb_weekly', 'cfb_personnel', 'cfb_decision']) db.applyFile(SQL(f));
    let v2ok = true;
    try { db.applyFile(SQL('cfb_v2_model')); } catch (e) { v2ok = false; chk('cfb_v2_model.sql applies (the V2 mirror\'s tables)', false, e.message.slice(0, 300)); }
    const r1 = db.applyFile(SQL('cfb_production'));
    chk('applies after the CFB contracts, every report row ok', !/CHECK THIS/.test(r1) && (r1.match(/\|ok/g) || []).length >= 13, r1.slice(-900));
    const r2 = db.applyFile(SQL('cfb_production'));
    chk('applies a second time, still ok', !/CHECK THIS/.test(r2));
    const r3 = db.applyFileAtomic(SQL('cfb_production'));
    chk('applies as ONE transaction (the SQL editor), still ok', !/CHECK THIS/.test(r3));
    const locks = psqlDb('postgres', fs.readFileSync(SQL('cfb_production'), 'utf8').replace(/\nselect check_name, status from \([\s\S]*$/, '\n')
      + "\nselect coalesce(string_agg(c.relname || ':' || c.relkind::text, ','), 'none') from pg_locks l join pg_class c on c.oid = l.relation where l.pid = pg_backend_pid() and l.mode = 'AccessExclusiveLock' and c.relkind in ('r','p');\n", '-1');
    chk('a re-apply takes no ACCESS EXCLUSIVE lock on any table (triggers, RLS and policies created only when missing)', locks.split('\n').pop() === 'none', locks.split('\n').pop());
    psqlDb('postgres', 'create database prodfirst;');
    psqlDb('prodfirst', fs.readFileSync(path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'), 'utf8'));
    const rf = psqlDb('prodfirst', fs.readFileSync(SQL('cfb_production'), 'utf8'));
    chk('applies FIRST on an empty database (no dependency), the published views reported as skipped', !/CHECK THIS/.test(rf) && /skipped: apply supabase\/cfb_weekly\.sql/.test(rf), rf.slice(-600));
    const hf = psqlDb('prodfirst', "select check_name || '=' || status from public.cfb_health('2026-10-03T12:00:00Z') where check_name in ('contracts','model_manifest');");
    chk('on that database cfb_health() says the contracts are missing (WARNING) and the manifest absent (CRITICAL)', /contracts=WARNING/.test(hf) && /model_manifest=CRITICAL/.test(hf), hf);

    /* the taxonomy agrees with the SQL copy */
    const codes = db.sql('select array_to_string(public.cfb_error_codes(), \',\')').split(',');
    chk('the SQL error codes are exactly taxonomy.js CODES', codes.slice().sort().join() === Object.keys(T.CODES).sort().join(), codes);
    const mapping = db.sql("select string_agg(c || '=' || public.cfb_runlog_class(c), ',' order by c) from unnest(public.cfb_error_codes()) c");
    chk('the SQL runlog mapping is exactly taxonomy.js runlogClass()', mapping === Object.keys(T.CODES).sort().map((c) => c + '=' + T.runlogClass(c)).join(','), mapping);
    const reg = db.sql("select string_agg(job || '|' || workflow || '|' || max_silence_minutes || '|' || severity_on_miss || '|' || array_to_string(season_months, ','), ';' order by job) from public.cfb_job_registry");
    chk('cfb_job_registry is exactly jobs.json', reg === J.registry().jobs.slice().sort((a, b) => a.job < b.job ? -1 : 1).map((j) => [j.job, j.workflow, j.max_silence_minutes, j.severity_on_miss, j.season_months.join(',')].join('|')).join(';'), reg);

    /* ================================================================ B. append-only */
    db.sql(`select public.cfb_record_incident('seed:x', 'UNKNOWN', 'INFO', 'cfb_lab_hourly', null, 'seed row', '{}'::jsonb);`);
    db.sql(`select public.cfb_heartbeat('cfb_lab_hourly', 'OK', 'c1', null, 10, '{}'::jsonb);`);
    db.sql(`select public.cfb_job_lock('cfb_lab_hourly', '2026', 'seed-holder', 60, null);`);
    for (const t of ['cfb_audit_log', 'cfb_incidents', 'cfb_job_heartbeats', 'cfb_job_lock_events']) {
      for (const [op, sql] of [['update', `update public.${t} set ${t === 'cfb_audit_log' ? 'reason = reason' : 'at = at'};`], ['delete', `delete from public.${t};`], ['truncate', `truncate public.${t};`]]) {
        chk(t + ': ' + op + ' refused for the owner', /append-only/.test(refused(() => db.sql(sql)) || ''));
        chk(t + ': ' + op + ' refused for the service role', /append-only|permission denied/.test(refused(() => db.service(sql)) || ''));
      }
    }
    chk('anon reads nothing operational', /permission denied/.test(refused(() => db.anon('select count(*) from public.cfb_incidents;')) || '') && /permission denied/.test(refused(() => db.anon("select public.cfb_health('2026-10-03T12:00:00Z');")) || ''));
    chk('authenticated reads the registry and calls cfb_health(), writes nothing', db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.cfb_job_registry;') === '9'
      && /permission denied/.test(refused(() => db.as('00000000-0000-0000-0000-000000000001', "select public.cfb_heartbeat('cfb_lab_hourly','OK');")) || ''));
    chk('an unknown job cannot send a heartbeat (no silent new, unmonitored job)', /not a registered CFB job/.test(refused(() => db.service("select public.cfb_heartbeat('cfb_typo_job','OK');")) || ''));
    chk('an incident must use a taxonomy code', /cfb_inc_code|check constraint/.test(refused(() => db.sql("insert into public.cfb_incidents (incident_key, event, error_code, runlog_class, severity) values ('k','OPENED','OOPS','UNKNOWN','INFO');")) || ''));

    /* ================================================================ C. manifest */
    const fetch1 = PR.makeFetch(db);
    const man = MF.build({ deployedAt: '2026-10-03T12:00:00.000Z' });
    chk('the manifest says champion_selection NOT_RUN, V1 champion, V2.1 production pathway', man.champion_selection === 'NOT_RUN' && man.champion_model_version === 'edgedesk_cfb_p4_v1.0.0' && man.production_model_version === 'edgedesk_cfb_v2.1.0');
    const p1 = await MF.push(man, { url: URL_, key: KEY, fetch: fetch1 });
    await MF.push(man, { url: URL_, key: KEY, fetch: fetch1 });
    await MF.push(man, { url: URL_, key: KEY, fetch: fetch1 });
    chk('pushed three times: one manifest row, matrix rows once', db.sql('select count(*) from public.cfb_production_model_manifest') === '1' && db.sql('select count(*) from public.cfb_compatibility_matrix') === String(MF.matrixRows(require('./compat.js').loadMatrix()).length), p1);
    chk('the stored manifest round-trips its content hash (what exact model produced this prediction)', (() => { const m = JSON.parse(db.sql('select payload::text from public.cfb_production_model_manifest')); return MF.contentHash(m) === man.content_sha256; })());
    chk('the manifest is audited on the way in', db.sql("select count(*) from public.cfb_audit_log where event_type = 'MANIFEST_RECORDED'") === '1');
    for (const [op, sql] of [['update', "update public.cfb_production_model_manifest set champion_selection = 'SELECTED';"], ['delete', 'delete from public.cfb_production_model_manifest;'], ['truncate', 'truncate public.cfb_production_model_manifest;']])
      chk('manifest is write-once: ' + op + ' refused', /append-only/.test(refused(() => db.sql(sql)) || ''));
    const bad = MF.row(Object.assign({}, man, { manifest_id: 'cfbm_' + hex('e'), champion_selection: 'SELECTED' }));
    chk('a SELECTED champion without championship evidence is refused', /cfb_manifest_selected_evidence/.test(refused(() => db.service(`insert into public.cfb_production_model_manifest select * from jsonb_populate_record(null::public.cfb_production_model_manifest, ${J$(Object.assign(bad, { recorded_at: new Date().toISOString() }))});`)) || ''));
    const rb = MF.row(Object.assign({}, man, { manifest_id: 'cfbm_' + hex('f'), deployed_at: '2026-10-04T12:00:00.000Z', supersedes: man.manifest_id, reason: null }));
    chk('a rollback manifest without a reason is refused', /cfb_manifest_rollback/.test(refused(() => db.service(`insert into public.cfb_production_model_manifest select * from jsonb_populate_record(null::public.cfb_production_model_manifest, ${J$(Object.assign(rb, { recorded_at: new Date().toISOString() }))});`)) || ''));

    /* ================================================================ D. flags */
    chk('a direct UPDATE of a flag is refused, owner included (use the audited function)', /cfb_set_feature_flag/.test(refused(() => db.sql("update public.cfb_feature_flags set enabled = false where flag = 'cfb_weekly_engine_enabled';")) || '')
      && /permission denied|cfb_set_feature_flag/.test(refused(() => db.service("update public.cfb_feature_flags set enabled = false where flag = 'cfb_weekly_engine_enabled';")) || ''));
    chk('a flag is never deleted', /never deleted/.test(refused(() => db.sql("delete from public.cfb_feature_flags where flag = 'cfb_weekly_engine_enabled';")) || '') && /never deleted/.test(refused(() => db.sql('truncate public.cfb_feature_flags;')) || ''));
    const aud0 = +db.sql("select count(*) from public.cfb_audit_log where event_type = 'FEATURE_FLAG_CHANGE'");
    const off = db.service("select public.cfb_set_feature_flag('cfb_weekly_engine_enabled', false, 'dan', 'kill switch drill: stop the weekly refresh');");
    chk('the kill switch goes off through the function and is audited with actor and reason', /"changed": true/.test(off) && db.sql("select enabled from public.cfb_feature_flags where flag = 'cfb_weekly_engine_enabled'") === 'f'
      && +db.sql("select count(*) from public.cfb_audit_log where event_type = 'FEATURE_FLAG_CHANGE' and actor = 'dan' and subject = 'cfb_weekly_engine_enabled'") === 1);
    db.service("select public.cfb_set_feature_flag('cfb_weekly_engine_enabled', false, 'dan', 'kill switch drill: stop the weekly refresh');");
    chk('setting a flag to the state it already has changes and audits nothing', +db.sql("select count(*) from public.cfb_audit_log where event_type = 'FEATURE_FLAG_CHANGE'") === aud0 + 1);
    db.applyFile(SQL('cfb_production'));
    chk('a re-apply of the migration never resets a person\'s switch', db.sql("select enabled from public.cfb_feature_flags where flag = 'cfb_weekly_engine_enabled'") === 'f');
    db.service("select public.cfb_set_feature_flag('cfb_weekly_engine_enabled', true, 'dan', 'kill switch drill over: resume the weekly refresh');");
    chk('an unknown flag is refused', /unknown flag/.test(refused(() => db.service("select public.cfb_set_feature_flag('cfb_new_thing', true, 'dan', 'switching on something undeclared');")) || ''));
    chk('a reason is required', /reason/.test(refused(() => db.service("select public.cfb_set_feature_flag('cfb_model_lab_enabled', false, 'dan', 'x');")) || ''));
    chk('a guarded flag needs evidence to go on', /evidence/.test(refused(() => db.service("select public.cfb_set_feature_flag('cfb_player_model_enabled', true, 'dan', 'try the personnel layer in production');")) || ''));
    chk('a guarded flag cannot be switched on by automation', /only a person/.test(refused(() => db.service("select public.cfb_set_feature_flag('cfb_player_model_enabled', true, 'automation', 'try the personnel layer in production', 'docs/x.md');")) || ''));
    chk('betting cannot be switched on while the manifest\'s decision policy has betting disabled — even by a person with evidence',
      /betting disabled/.test(refused(() => db.service("select public.cfb_set_feature_flag('cfb_bet_actionable_enabled', true, 'dan', 'turn official bets on', 'docs/cfb-decision/POLICY.md');")) || '')
      && db.sql("select enabled from public.cfb_feature_flags where flag = 'cfb_bet_actionable_enabled'") === 'f');

    /* ================================================================ E. audit chain */
    chk('the audit chain verifies', /"ok": true/.test(db.sql('select public.cfb_audit_verify()')));
    const bgs = [0, 1, 2, 3, 4, 5].map((i) => db.background(`select public.cfb_audit('RELEASE', 'concurrent-${i}', null, null, 'concurrent writer number ${i}', 'tester');`));
    bgs.forEach((x) => x.wait(20000));
    const ch = db.sql('select public.cfb_audit_verify()');
    chk('six concurrent writers: the chain is still gap-free and verifies', /"ok": true/.test(ch) && db.sql("select count(*) from public.cfb_audit_log where subject like 'concurrent-%'") === '6', ch);
    const tampered = db.sql(`begin; alter table public.cfb_audit_log disable trigger cfb_audit_log_no_update_trg;
      update public.cfb_audit_log set reason = 'rewritten after the fact by someone' where chain_seq = 2;
      select public.cfb_audit_verify()::text; rollback;`);
    chk('a row rewritten behind the triggers breaks the chain at that row', /"ok": false/.test(tampered) && /"break_at": 2/.test(tampered), tampered);

    /* ================================================================ F. corrections */
    db.service(`insert into public.cfb_game_validation (validation_id, game_id, season, week, status, pbp_completeness_score, rule_version, payload)
      values ('val-401', '401', 2026, 5, 'FINAL_PARTIAL_DATA', 0.61, 'cfb_game_validation_v1', '{}');`);
    const c1 = db.service(`select public.cfb_record_correction('cfb_game_validation', '{"validation_id":"val-401"}', 'pbp_completeness_score', '0.97', 'provider re-sent the missing drives', 'cfbfastR 2026-10-04 refresh', 'dan');`);
    const cid = (/"correction_id": "(cfbc_[0-9a-f]+)"/.exec(c1) || [])[1];
    chk('a correction records the ORIGINAL value read from the row', /"original_value": 0.61/.test(c1) && !!cid, c1);
    chk('the raw row is never mutated', db.sql("select pbp_completeness_score from public.cfb_game_validation where validation_id = 'val-401'") === '0.61');
    chk('readers get the corrected value through cfb_corrected()', db.sql(`select public.cfb_corrected('cfb_game_validation', '{"validation_id":"val-401"}', 'pbp_completeness_score', '0.61')`) === '0.97');
    chk('the correction is audited', db.sql("select count(*) from public.cfb_audit_log where event_type = 'MANUAL_CORRECTION'") === '1');
    chk('a key that matches no row is refused', /matches 0 rows/.test(refused(() => db.service(`select public.cfb_record_correction('cfb_game_validation', '{"validation_id":"nope"}', 'pbp_completeness_score', '1', 'no such row here at all', 'x', 'dan');`)) || ''));
    chk('a model OUTPUT table is refused (outputs get new versions, never corrections)', /not a correctable source table/.test(refused(() => db.service(`select public.cfb_record_correction('cfb_weekly_projections', '{"projection_id":"x"}', 'ens_pred', '3', 'the projection looked wrong', 'x', 'dan');`)) || ''));
    chk('an unknown column is refused', /no column/.test(refused(() => db.service(`select public.cfb_record_correction('cfb_game_validation', '{"validation_id":"val-401"}', 'nope', '1', 'no such column exists', 'x', 'dan');`)) || ''));
    chk('a "correction" to the stored value is refused', /equals the stored value/.test(refused(() => db.service(`select public.cfb_record_correction('cfb_game_validation', '{"validation_id":"val-401"}', 'pbp_completeness_score', '0.61', 'same value as the raw row', 'x', 'dan');`)) || ''));
    const c2 = db.service(`select public.cfb_record_correction('cfb_game_validation', '{"validation_id":"val-401"}', 'pbp_completeness_score', '0.95', 'second provider refresh, one drive fewer', 'cfbfastR', 'dan');`);
    chk('a second correction supersedes the first', c2.indexOf('"supersedes": "' + cid + '"') >= 0, c2);
    chk('revoking a superseded correction is refused (it would discard the newer one)', /not the current active correction/.test(refused(() => db.service(`select public.cfb_revoke_correction('${cid}', 'dan', 'revoking the older correction');`)) || ''));
    const cid2 = (/"correction_id": "(cfbc_[0-9a-f]+)"/.exec(c2) || [])[1];
    db.service(`select public.cfb_revoke_correction('${cid2}', 'dan', 'the provider value was right after all');`);
    chk('after revoking the current correction readers get the raw value again', db.sql(`select public.cfb_corrected('cfb_game_validation', '{"validation_id":"val-401"}', 'pbp_completeness_score', '0.61')`) === '0.61');
    chk('corrections are append-only', /append-only/.test(refused(() => db.sql('delete from public.cfb_data_corrections;')) || ''));

    /* ================================================================ G. job locks */
    const racers = [0, 1, 2, 3, 4, 5].map((i) => db.background(`select public.cfb_job_lock('cfb_weekly_refresh', '2026', 'racer-${i}', 600, null)::text;`));
    const outs = racers.map((x) => x.wait(20000).out);
    const winners = outs.filter((o) => /"acquired": true/.test(o));
    chk('six sessions race for one weekly lock: exactly one acquires it', winners.length === 1 && outs.filter((o) => /"acquired": false/.test(o)).length === 5, outs.map((o) => o.slice(0, 80)));
    chk('the lock event log shows one ACQUIRED and five CONTENDED', db.sql("select string_agg(event || '=' || n, ',' order by event) from (select event, count(*) n from public.cfb_job_lock_events where job = 'cfb_weekly_refresh' group by event) x") === 'ACQUIRED=1,CONTENDED=5');
    const lease = (/"lease_id": "(lease_[0-9a-f]+)"/.exec(winners[0]) || [])[1];
    const holder = (/"holder": "(racer-\d)"/.exec(winners[0]) || [])[1];
    chk('another holder cannot release it (fenced by the lease id)', /"released": false/.test(db.service("select public.cfb_job_unlock('cfb_weekly_refresh', '2026', 'lease_" + hex('0') + "')")));
    chk('the holder re-enters (the gate and its own mirror share one lease)', /"reentrant": true/.test(db.service(`select public.cfb_job_lock('cfb_weekly_refresh', '2026', '${holder}', 600);`)));
    chk('a per-game lock on another key is independent', /"acquired": true/.test(db.service("select public.cfb_job_lock('cfb_game_refresh', '401871049', 'qb-news', 300);")) && /"acquired": true/.test(db.service("select public.cfb_job_lock('cfb_game_refresh', '401862786', 'scheduled', 300);")));
    db.sql("update public.cfb_job_locks set expires_at = clock_timestamp() - interval '1 second', acquired_at = clock_timestamp() - interval '2 hours' where job = 'cfb_weekly_refresh';");
    chk('cfb_health reports the expired lease', /job_locks=WARNING/.test(db.sql("select string_agg(check_name || '=' || status, ',') from public.cfb_health(now()) where check_name = 'job_locks'")));
    const tk = db.service("select public.cfb_job_lock('cfb_weekly_refresh', '2026', 'next-run', 600);");
    chk('an expired lease is taken over, and the takeover names the crashed holder', /"took_over_from": "racer-\d"/.test(tk) && db.sql("select count(*) from public.cfb_job_lock_events where event = 'TAKEOVER_EXPIRED'") === '1', tk);
    chk('the crashed holder can neither renew nor release the lease it lost', /"renewed": false/.test(db.service(`select public.cfb_job_lock_renew('cfb_weekly_refresh', '2026', '${lease}', 600);`)) && /"released": false/.test(db.service(`select public.cfb_job_unlock('cfb_weekly_refresh', '2026', '${lease}');`)));
    chk('bad arguments are refused (ttl bounds, key charset)', /ttl/.test(refused(() => db.service("select public.cfb_job_lock('cfb_weekly_refresh','2026','x', 5);")) || '') && /required/.test(refused(() => db.service("select public.cfb_job_lock('cfb_weekly_refresh','20 26;drop','x', 60);")) || ''));
    /* withGameLocks: deterministic order, skip what another job holds, release in finally */
    const gl = await LOCKS.withGameLocks({ url: URL_, key: KEY, fetch: fetch1, holder: 'weekly-daily', log: quietLog('cfb_game_refresh') }, ['401871049', '401000003', '401000001'], async (ids) => ids);
    chk('per-game locks: sorted order, the game QB news is refreshing is skipped, the rest refreshed', JSON.stringify(gl.result) === JSON.stringify(['401000001', '401000003']) && gl.skipped.length === 1 && gl.skipped[0].game_id === '401871049' && gl.skipped[0].holder === 'qb-news');
    chk('per-game locks are released afterwards', db.sql("select count(*) from public.cfb_job_locks where job = 'cfb_game_refresh' and holder = 'weekly-daily'") === '0');

    /* ================================================================ weekly fixture ledger */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbprod-'));
    const wroot = path.join(tmp, 'weekly');
    const RUN = 'cfbw_' + hex('a'), RUN2 = 'cfbw_' + hex('b');
    function weeklyLedger(dir) {
      const d = path.join(dir, '2026'); fs.mkdirSync(path.join(d, 'runs'), { recursive: true }); fs.mkdirSync(path.join(d, 'upcoming_game_features'), { recursive: true });
      const w = (f, rows) => fs.writeFileSync(path.join(d, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const teams = Array.from({ length: 24 }, (_, i) => String(100 + i));
      w('runs.jsonl', [{ run_id: RUN, run_key: 'k1', season: 2026, source_week: 4, target_week: 5, mode: 'weekly', started_at: '2026-09-28T10:05:00.000Z', completed_at: '2026-09-28T10:40:00.000Z',
        model_version: 'edgedesk_cfb_v2.1.0', feature_version: 'cfb_v2_fv2', status: 'PUBLISHED', published: true, warnings_count: 0, errors_count: 0 }]);
      fs.writeFileSync(path.join(d, 'runs', RUN + '.json'), JSON.stringify({ run_id: RUN, stages: [{ stage: 'VALIDATE_PBP', status: 'OK', counts: {} }, { stage: 'TEAM_POSTERIORS', status: 'OK', counts: {} }, { stage: 'WRITE_STATE', status: 'OK', counts: {} }] }));
      w('game_validation.jsonl', teams.slice(0, 12).map((t, i) => ({ validation_id: 'gv' + i, game_id: '5' + i, season: 2026, week: 4, status: 'FINAL_VALIDATED', rule_version: 'cfb_game_validation_v1', state_version: 1 })));
      w('team_week_state.jsonl', teams.map((t, i) => ({ state_id: 'cfbs_' + (i.toString(16).padStart(2, '0') + hex('1', 22)), team_id: t, season: 2026, week: 4, feature_version: 'cfb_v2_fv2', model_version: 'edgedesk_cfb_v2.1.0',
        as_of: '2026-09-29T12:00:00.000Z', overall_mean: i - 12, overall_sd: 3.1, state_version: 1, supersedes: null, run_id: RUN })));
      w('qb_week_state.jsonl', teams.slice(0, 6).map((t, i) => ({ qb_state_id: 'qb' + i, player_id: 'espn:' + (9000 + i), team_id: t, season: 2026, week: 4, feature_version: 'cfb_v2_fv2', starter_probability: 0.9, state_version: 1, run_id: RUN })));
      w('unit_week_state.jsonl', teams.slice(0, 4).map((t, i) => ({ unit_state_id: 'u' + i, team_id: t, season: 2026, week: 4, unit: 'QB', knowledge: 'KNOWN', rule_version: 'cfb_personnel_foundation_v1', state_version: 1 })));
      w('qb_events.jsonl', [{ event_id: 'ev1', team_id: '100', season: 2026, week: 4, event_type: 'NEW_STARTER', player_id: 'espn:9000' }]);
      const feats = teams.slice(0, 12).map((t, i) => ({ feature_snapshot_id: 'cfbf_' + (i.toString(16).padStart(2, '0') + hex('2', 22)), game_id: '6' + i, season: 2026, week: 5, kickoff_ts: '2026-10-03T19:30:00.000Z',
        prediction_ts: '2026-09-29T12:00:00.000Z', feature_ts: '2026-09-29T12:00:00.000Z', feature_version: 'cfb_v2_fv2', model_version: 'edgedesk_cfb_v2.1.0', input_hash: 'h' + i, inputs: { edge_epa: i / 10 } }));
      fs.writeFileSync(path.join(d, 'upcoming_game_features', 'week_05.jsonl'), feats.map((r) => JSON.stringify(r)).join('\n') + '\n');
      w('projections.jsonl', feats.map((f, i) => ({ projection_id: 'cfbj_' + (i.toString(16).padStart(2, '0') + hex('3', 22)), game_id: f.game_id, season: 2026, week: 5, kickoff_ts: f.kickoff_ts, prediction_ts: f.prediction_ts,
        model_version: 'edgedesk_cfb_v2.1.0', feature_version: 'cfb_v2_fv2', feature_snapshot_id: f.feature_snapshot_id, input_hash: f.input_hash, ens_pred: i - 6, sigma: 15.9, p_home_raw: 0.4 + i / 100, p_home_calibrated: 0.4 + i / 100, model_mode: i === 3 ? 'DEGRADED_PBP' : 'FULL', run_id: RUN })));
      w('projection_changes.jsonl', [{ change_id: 'chg1', game_id: '60', from_projection_id: 'a', to_projection_id: 'b', from_margin: 1, to_margin: 2 }]);
      w('research.jsonl', [{ item_id: 'r1', pattern: 'x', origin: 'LIVE', season: 2026, n: 12, status: 'RESEARCH' }]);
      w('misses.jsonl', [{ miss_id: 'cfbx_' + hex('4'), game_id: '51', season: 2026, week: 4, rule_version: 'cfb_miss_classification_v1', projected_margin: 7, actual_margin: -14, error: -21, primary_driver: 'TURNOVER_LUCK' }]);
      fs.writeFileSync(path.join(d, 'source_health.json'), JSON.stringify({ season: 2026, as_of: '2026-09-29T12:00:00.000Z', sources: [{ source: 'pbp', status: 'HEALTHY', last_successful_ingestion: '2026-09-29T11:00:00.000Z' }, { source: 'market', status: 'STALE' }] }));
      return { teams: teams.length, feats: feats.length };
    }
    const WL = weeklyLedger(wroot);
    const SYW = require('../cfb_weekly/sync_supabase.js');
    const WT = ['cfb_pipeline_runs', 'cfb_pipeline_stage_log', 'cfb_game_validation', 'cfb_team_week_state', 'cfb_qb_week_state', 'cfb_unit_week_state', 'cfb_qb_events',
      'cfb_upcoming_game_features', 'cfb_weekly_projections', 'cfb_projection_changes', 'cfb_weekly_research', 'cfb_weekly_misses', 'cfb_source_health'];
    const planW = SYW.plan(2026, wroot);
    chk('the weekly mirror plans the run row LAST (the commit marker) and the feature snapshots before the projections',
      planW[planW.length - 1].table === 'cfb_pipeline_runs' && planW.findIndex((x) => x.table === 'cfb_upcoming_game_features') < planW.findIndex((x) => x.table === 'cfb_weekly_projections'), planW.map((x) => x.table));

    /* ================================================================ G2. a second weekly mirror exits cleanly */
    db.sql("delete from public.cfb_job_locks where job = 'cfb_weekly_refresh';");
    db.service("select public.cfb_job_lock('cfb_weekly_refresh', '2026', 'the-scheduled-run', 600);");
    const skipped = await SYW.sync(2026, { root: wroot, fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_weekly_refresh') });
    chk('a weekly mirror started while another run holds the lock exits cleanly and writes nothing', skipped.skipped === 'PIPELINE_CONFLICT' && skipped.holder === 'the-scheduled-run' && db.sql('select count(*) from public.cfb_team_week_state') === '0', skipped);
    db.sql("delete from public.cfb_job_locks where job = 'cfb_weekly_refresh';");

    /* ================================================================ K. published views (half a mirror) */
    const partial = PR.makeFetch(db, { fault: (t) => (t === 'cfb_pipeline_runs' ? { status: 503, body: '<html>gateway</html>' } : null) });
    let cut = null;
    try { await SYW.sync(2026, { root: wroot, fetch: partial, quiet: true, log: quietLog('cfb_weekly_refresh'), io: FAST }); } catch (e) { cut = e; }
    chk('a mirror cut short before its commit marker fails as a classified error (retried, then raised)', cut && cut.cfb_code === 'PROVIDER_TRANSIENT' && partial.attempts.cfb_pipeline_runs === 4, cut && { code: cut.cfb_code, attempts: partial.attempts.cfb_pipeline_runs });
    chk('... its team state is in the table but NOT in the published view', db.sql('select count(*) from public.cfb_team_week_state') === String(WL.teams) && db.sql('select count(*) from public.cfb_team_week_state_published') === '0'
      && db.sql('select count(*) from public.cfb_weekly_projections_published') === '0');
    db.sql("update public.cfb_job_locks set expires_at = clock_timestamp() where false;");
    chk('... and cfb_health flags the orphaned state once it is 2 hours old', /partial_sync=WARNING/.test(db.sql("select string_agg(check_name || '=' || status, ',') from public.cfb_health(now() + interval '3 hours') where check_name = 'partial_sync'")));
    db.sql("delete from public.cfb_job_locks where job = 'cfb_weekly_refresh';");

    /* ================================================================ H. deadlock through the mirror */
    const holdOrder = "select 1 from public.cfb_feature_flags where flag = 'cfb_model_lab_enabled' for update;";
    const otherOrder = "select 1 from public.cfb_feature_flags where flag = 'cfb_weekly_engine_enabled' for update;";
    const B = db.background(`begin; set local deadlock_timeout = '10s'; ${holdOrder} select pg_sleep(1.2); ${otherOrder} select pg_sleep(0.3); commit;`);
    db.sleep(0.4);
    const incidents = [];
    const dfetch = PR.makeFetch(db, { preamble: (t, n) => (t === 'cfb_pipeline_runs' && n === 1 ? `set local deadlock_timeout = '100ms'; ${otherOrder} select pg_sleep(1.6); ${holdOrder}` : null) });
    const res = await SYW.sync(2026, { root: wroot, fetch: dfetch, quiet: true, log: quietLog('cfb_weekly_refresh'),
      io: Object.assign({}, FAST, { onIncident: async (e) => { incidents.push(e); return DB.incidentSink({ url: URL_, key: KEY, fetch: dfetch, job: 'cfb_weekly_refresh' })(e); } }) });
    const bout = B.wait(30000);
    chk('a real deadlock (two sessions, opposite lock order): the other session committed', bout.code === 0, bout.out.slice(0, 300));
    chk('the mirror\'s transaction was the victim (40P01), classified DATABASE_DEADLOCK, and retried with jitter', incidents.length >= 1 && incidents[0].error_code === 'DATABASE_DEADLOCK' && incidents[0].sqlstate === '40P01' && dfetch.attempts.cfb_pipeline_runs === 2, { incidents, attempts: dfetch.attempts.cfb_pipeline_runs });
    chk('the deadlock is recorded as an incident in Postgres', db.sql("select count(*) from public.cfb_incidents where error_code = 'DATABASE_DEADLOCK'") >= '1' && /DATABASE_DEADLOCK:cfb_weekly_refresh/.test(db.sql("select string_agg(incident_key, ',') from public.cfb_incidents where error_code = 'DATABASE_DEADLOCK'")));
    chk('after the retry the mirror is complete: every ledger row once, the run published', res.cfb_pipeline_runs === 1 && db.sql('select count(*) from public.cfb_team_week_state_published') === String(WL.teams)
      && db.sql('select count(*) from public.cfb_upcoming_game_features') === String(WL.feats) && db.sql('select count(*) from public.cfb_weekly_projections_published') === String(WL.feats), res);
    const fW1 = fingerprint(WT);

    /* raw two-session deadlock: exactly one victim, its partial write rolled back */
    db.sql('create table if not exists public.dl_probe (id int primary key, who text);');
    const s1 = db.background(`begin; set local deadlock_timeout = '10s'; insert into public.dl_probe values (1, 'A'); ${holdOrder} select pg_sleep(1.0); ${otherOrder} commit;`);
    db.sleep(0.3);
    const vic = refused(() => db.sql(`\\set VERBOSITY verbose\nbegin; set local deadlock_timeout = '100ms'; insert into public.dl_probe values (2, 'B'); ${otherOrder} select pg_sleep(1.4); ${holdOrder} commit;`));
    const s1o = s1.wait(30000);
    chk('raw deadlock: exactly one session is the victim with SQLSTATE 40P01', /40P01/.test(vic || '') && s1o.code === 0 && T.classify({ message: vic }) === 'DATABASE_DEADLOCK', (vic || '').slice(0, 200));
    chk('raw deadlock: the victim\'s earlier write in the same transaction was rolled back (no partial state)', db.sql("select string_agg(who, ',' order by id) from public.dl_probe") === 'A');

    /* ================================================================ I. lock timeout, permanent errors */
    const LT = "set local lock_timeout = '150ms'; select 1 from public.cfb_feature_flags where flag = 'cfb_player_model_enabled' for update;";
    const hold = db.background("begin; select 1 from public.cfb_feature_flags where flag = 'cfb_player_model_enabled' for update; select pg_sleep(1.5); commit;");
    db.sleep(0.3);
    const tInc = [];
    const tf = PR.makeFetch(db, { preamble: (t, n) => (t === 'cfb_weekly_research' && n === 1 ? LT : null) });
    await SYW.sync(2026, { root: wroot, fetch: tf, quiet: true, log: quietLog('cfb_weekly_refresh'), io: Object.assign({}, FAST, { onIncident: async (e) => { tInc.push(e); } }) });
    hold.wait(20000);
    chk('lock timeout (55P03): classified DATABASE_TIMEOUT, recorded, retried, then the mirror completes', tInc.length === 1 && tInc[0].error_code === 'DATABASE_TIMEOUT' && tInc[0].sqlstate === '55P03' && tf.attempts.cfb_weekly_research === 2, tInc);
    chk('... and the state is identical to before (idempotent re-run)', fingerprint(WT) === fW1);
    const hold2 = db.background("begin; select 1 from public.cfb_feature_flags where flag = 'cfb_player_model_enabled' for update; select pg_sleep(3); commit;");
    db.sleep(0.3);
    const xInc = [];
    let exhausted = null;
    const xf = PR.makeFetch(db, { preamble: () => LT });
    try { await DB.postRows(URL_, KEY, 'cfb_weekly_research', 'item_id', [{ item_id: 'r-new', pattern: 'y', origin: 'LIVE', n: 1, status: 'RESEARCH', payload: {} }], Object.assign({ fetch: xf, onIncident: async (e) => { xInc.push(e); } }, FAST)); }
    catch (e) { exhausted = e; }
    hold2.wait(20000);
    chk('retries exhausted: a DATABASE_TIMEOUT failure after exactly 3 attempts, the stage fails', exhausted && exhausted.cfb_code === 'DATABASE_TIMEOUT' && exhausted.runlog_class === 'DATABASE' && xf.attempts.cfb_weekly_research === 3, exhausted && exhausted.message);
    chk('... a CRITICAL "retries exhausted" incident is reported, and nothing was written', xInc.some((e) => e.exhausted && e.severity === 'CRITICAL') && db.sql("select count(*) from public.cfb_weekly_research where item_id = 'r-new'") === '0');
    for (const [label, fault, code] of [['a 409 unique violation', { status: 409, body: { code: '23505', message: 'duplicate key' } }, 'DATABASE_CONSTRAINT'],
      ['a 401', { status: 401, body: { code: 'PGRST301', message: 'JWT expired' } }, 'AUTH'], ['a PGRST102 body', { status: 400, body: { code: 'PGRST102', message: 'All object keys must match' } }, 'PROVIDER_REJECTED'],
      ['a 500 naming 25P02', { status: 500, body: { code: '25P02', message: 'current transaction is aborted' } }, 'UNKNOWN']]) {
      const ff = PR.makeFetch(db, { fault: () => fault });
      let e = null;
      try { await DB.postRows(URL_, KEY, 'cfb_weekly_research', 'item_id', [{ item_id: 'z', pattern: 'y', origin: 'LIVE', n: 1, status: 'RESEARCH', payload: {} }], Object.assign({ fetch: ff }, FAST)); } catch (x) { e = x; }
      chk(label + ' is never retried and is raised as ' + code, e && e.cfb_code === code && ff.calls.length === 1, e && { code: e.cfb_code, calls: ff.calls.length });
    }
    const flaky = PR.makeFetch(db, { fault: (t, n) => (n <= 2 ? { status: 503, body: 'upstream' } : null) });
    await DB.postRows(URL_, KEY, 'cfb_weekly_research', 'item_id', [{ item_id: 'r-flaky', pattern: 'y', origin: 'LIVE', n: 1, status: 'RESEARCH', payload: {} }], Object.assign({ fetch: flaky }, FAST));
    chk('two 503s then success: retried, written exactly once', flaky.calls.length === 3 && db.sql("select count(*) from public.cfb_weekly_research where item_id = 'r-flaky'") === '1');
    const mixed = [{ item_id: 'm1', pattern: 'a', origin: 'LIVE', n: 1, status: 'RESEARCH', payload: {} }, { item_id: 'm2', pattern: 'b', origin: 'LIVE', n: 2, status: 'RESEARCH', mean_residual: 1.5, payload: {} }];
    const mf = PR.makeFetch(db);
    await DB.postRows(URL_, KEY, 'cfb_weekly_research', 'item_id', mixed, { fetch: mf });
    chk('rows with different key sets are sent as separate bodies (PostgREST PGRST102; the 2026-09-27 lab mirror failure)', mf.calls.length === 2 && db.sql("select count(*) from public.cfb_weekly_research where item_id in ('m1','m2')") === '2');

    /* ================================================================ J. idempotency: every mirror 1x 2x 3x */
    const runs3 = async (label, tables, fn) => {
      const prints = [];
      for (let i = 1; i <= 3; i++) { await fn(i); prints.push(fingerprint(tables)); }
      chk(label + ': run 1x, 2x, 3x -> identical state', prints[0] === prints[1] && prints[1] === prints[2], prints.map((p) => p.slice(0, 120)));
      return prints[0];
    };
    await runs3('weekly mirror', WT, () => SYW.sync(2026, { root: wroot, fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_weekly_refresh') }));
    chk('weekly: no duplicate natural keys (team x season x week x feature_version x state_version)', db.sql('select count(*) from (select team_id, season, week, feature_version, state_version from public.cfb_team_week_state group by 1,2,3,4,5 having count(*) > 1) d') === '0');

    const proot = path.join(tmp, 'personnel', '2026'); fs.mkdirSync(proot, { recursive: true });
    fs.writeFileSync(path.join(proot, 'players.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ player_row_id: 'pr' + i, player_id: 'espn:' + (4000 + i), registry_version: 'reg_v1', full_name: 'Player ' + i, team_id: 251, first_season: 2024, last_season: 2026 })).join('\n') + '\n');
    fs.writeFileSync(path.join(proot, 'player_aliases.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ alias_id: 'al' + i, player_id: 'espn:' + (4000 + i), name: 'Player ' + i, alias_key: 'player' + i, source: 'espn', registry_version: 'reg_v1' })).join('\n') + '\n');
    fs.writeFileSync(path.join(proot, 'transfers.jsonl'), JSON.stringify({ transfer_id: 'tr1', player_id: 'espn:4001', event_type: 'TRANSFER', from_team: 251, to_team: 333, from_season: 2025, to_season: 2026 }) + '\n');
    const SYP = require('../cfb_personnel/sync_supabase.js');
    await runs3('personnel mirror', ['cfb_players', 'cfb_player_aliases', 'cfb_transfer_history'], () => SYP.sync(2026, { root: path.join(tmp, 'personnel'), fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_personnel_mirror') }));

    const droot = path.join(tmp, 'decision', '2026'); fs.mkdirSync(droot, { recursive: true });
    const dec = (i, st) => ({ decision_id: 'cfbd_' + i, game_id: 401871049 + i, season: 2026, week: 5, book: 'draftkings', quote_id: 'q' + i, observed_at: '2026-09-30T12:00:00.000Z', decided_at: '2026-09-30T12:05:00.000Z',
      kickoff_ts: '2026-10-03T19:30:00.000Z', engine_version: 'cfb_decision_engine_v1', engine_role: 'CURRENT', policy_version: 'cfb_decision_policy_v1', artifact_version: 'cfb_decision_calibration_v1',
      model_version: 'edgedesk_cfb_v2.1.0', status: st, timing: 'NONE', side: st === 'LEAN' ? 'HOME' : null, reason_codes: [st === 'PASS' ? 'NO_EDGE' : 'NO_BET_BETTING_DISABLED'], official: true });
    fs.writeFileSync(path.join(droot, 'decisions.jsonl'), [dec(1, 'PASS'), dec(2, 'LEAN'), dec(3, 'PASS')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(path.join(droot, 'eligibility.jsonl'), [1, 2].map((i) => JSON.stringify({ eligibility_id: 'el' + i, decision_id: 'cfbd_' + i, check_name: 'market_fresh', ok: true })).join('\n') + '\n');
    fs.writeFileSync(path.join(droot, 'results.jsonl'), JSON.stringify({ result_id: 'res1', decision_id: 'cfbd_1', graded_at: '2026-10-04T12:00:00.000Z', final_margin: 3, ats_result: 'W', outcome_grade: 'WIN' }) + '\n');
    const SYD = require('../cfb_decision/sync_supabase.js');
    await runs3('decision mirror', ['cfb_decision_snapshots', 'cfb_bet_eligibility', 'cfb_decision_results'], () => SYD.sync(2026, { root: path.join(tmp, 'decision'), fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_lab_hourly') }));

    const SYL = require('../cfb_lab/sync_supabase.js');
    const LT_ = ['cfb_lab_model_roles', 'cfb_lab_experiments', 'cfb_lab_audit_log', 'cfb_lab_partitions', 'cfb_lab_predictions', 'cfb_lab_market_quotes', 'cfb_lab_market_lines', 'cfb_lab_results', 'cfb_lab_evaluations'];
    const labOuts = [];
    await runs3('Model Lab mirror (the real committed ledger)', LT_, async () => { labOuts.push(await SYL.sync(2026, { fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_lab_hourly') })); });
    chk('the real Model Lab ledger mirrors completely (the evaluations whose rows differ in keys included)', labOuts[0].cfb_lab_evaluations > 0 && db.sql('select count(*) from public.cfb_lab_evaluations') === String(labOuts[0].cfb_lab_evaluations), labOuts[0]);

    if (v2ok) {
      const vdir = path.join(tmp, 'v2snap'); fs.mkdirSync(vdir);
      /* the production model's live rows (current.json, V2.1), wrapped the way a frozen
         snapshot file wraps them ({ row, hash }). The mirror runs them through the
         canonical service with the production engine. */
      const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
      fs.writeFileSync(path.join(vdir, 'week_fixture.json'), JSON.stringify({ model_version: cur.model_version, rows: cur.rows.map((r, i) => ({ row: r, hash: 'fixture' + i })) }));
      const SYV = require('../cfb_v2/sync_supabase.js');
      const vp = SYV.plan(2026, { dir: vdir });
      /* another version's rows (the v2.0.0 replay) are never run through the V2.1 engine
         and published under their own label: the canonical service refuses them */
      const odir = path.join(tmp, 'v2snap_other'); fs.mkdirSync(odir);
      const rep = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'snapshots', '2026', 'replay_to_date.json'), 'utf8'));
      fs.writeFileSync(path.join(odir, 'week_fixture.json'), JSON.stringify({ model_version: rep.model_version, rows: rep.rows.map((r, i) => ({ row: r, hash: 'fixture' + i })) }));
      chk('V2 mirror: another version\'s snapshot (v2.0.0) is not re-computed by the V2.1 engine and published', rep.rows.length > 0 && SYV.plan(2026, { dir: odir }).preds.length === 0);
      await runs3('V2 mirror (' + vp.preds.length + ' predictions)', ['cfb_model_versions', 'cfb_predictions', 'cfb_prediction_intervals', 'cfb_model_component_predictions'],
        () => SYV.sync(2026, { dir: vdir, fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_weekly_refresh') }));
      chk('V2 mirror: every prediction once, with its three intervals', db.sql('select count(*) from public.cfb_predictions') === String(vp.preds.length) && db.sql('select count(*) from public.cfb_prediction_intervals') === String(vp.ints.length) && vp.preds.length > 0);
    }

    /* lab SQL functions three times */
    const qjson = JSON.stringify([{ source: 'odds_api', book: 'draftkings', game_id: '401871049', market_type: 'spread', home_line: -3.5, price_home: -110, price_away: -110,
      observed_at: '2026-10-01T12:00:00.000Z', kickoff_ts: '2026-10-03T19:30:00.000Z', season: 2026, week: 5, retrieved_at: '2026-10-01T12:00:05.000Z' }]);
    const ing = [1, 2, 3].map(() => db.service(`select public.cfb_lab_ingest_quotes(${PG.lit(qjson)}::jsonb)::text;`));
    chk('cfb_lab_ingest_quotes 1x, 2x, 3x: written once, then duplicates', /"written": 1/.test(ing[0]) && /"written": 0/.test(ing[1]) && /"written": 0/.test(ing[2]), ing);
    const lines = [1, 2, 3].map(() => { db.service("select public.cfb_lab_derive_lines('2026-09-26T12:00:00Z');"); return fingerprint(['cfb_lab_market_lines']); });
    chk('cfb_lab_derive_lines 1x, 2x, 3x: identical lines', lines[0] === lines[1] && lines[1] === lines[2]);

    /* the optional market-integrity tables: fail soft while missing, mirrored once applied */
    const G = require('../cfb_lab/ledger.js'), MK = require('../cfb_lab/market.js');
    const lroot = path.join(tmp, 'lab');
    const ls = new G.Store(2026, { root: path.join(lroot, 'ledger'), govRoot: path.join(lroot, 'gov') });
    const bq = MK.baseQuote({ game_id: '401900001', season: 2026, week: 6, source: 'odds_api', book: 'fanduel', market_type: 'spread', home_line: 450, price_home: -110, price_away: -110,
      observed_at: '2026-10-05T12:00:00.000Z', kickoff_ts: '2026-10-10T19:30:00.000Z', retrieved_at: '2026-10-05T12:00:00.000Z' });
    const qz = MK.screenCandidates([], [bq], { now: '2026-10-05T12:01:00.000Z' }).quarantined;
    ls.append('quarantine', qz, 'quarantine_id');
    const warns = [];
    const softLog = require('./log.js').logger({ job: 'cfb_lab_hourly' }, { sink: (l, r) => warns.push(r) });
    const soft = await SYL.sync(2026, { store: ls, fetch: PR.makeFetch(db), log: softLog });
    chk('market-integrity tables missing: the lab mirror warns and carries on (never fails the hourly job)', qz.length >= 1 && soft.cfb_market_quote_quarantine && soft.cfb_market_quote_quarantine.skipped === 'table missing'
      && warns.some((w) => w.event === 'optional_table_missing' && w.table === 'cfb_market_quote_quarantine'), { soft: soft.cfb_market_quote_quarantine, qz: qz.length });
    const f404 = PR.makeFetch(db, { fault: (t) => (t === 'cfb_market_quote_quarantine' ? { status: 404, body: { code: 'PGRST205', message: "Could not find the table 'public.cfb_market_quote_quarantine' in the schema cache" } } : null) });
    const soft2 = await SYL.sync(2026, { store: ls, fetch: f404, log: quietLog('cfb_lab_hourly') });
    chk('... PostgREST\'s own answer (404 PGRST205) is treated the same', soft2.cfb_market_quote_quarantine && soft2.cfb_market_quote_quarantine.skipped === 'table missing');
    const f500 = PR.makeFetch(db, { fault: (t) => (t === 'cfb_market_quote_quarantine' ? { status: 500, body: { code: 'XX000', message: 'internal' } } : null) });
    let hard = null;
    try { await SYL.sync(2026, { store: ls, fetch: f500, log: quietLog('cfb_lab_hourly') }); } catch (e) { hard = e; }
    chk('... but any OTHER failure of an optional table still fails the mirror (only "missing" is soft)', hard && hard.cfb_code === 'UNKNOWN');
    const beforeIntegrity = fingerprint(LT_);
    db.applyFile(SQL('cfb_market_integrity'));
    const withQ = await SYL.sync(2026, { store: ls, fetch: PR.makeFetch(db), log: quietLog('cfb_lab_hourly') });
    await SYL.sync(2026, { store: ls, fetch: PR.makeFetch(db), log: quietLog('cfb_lab_hourly') });
    chk('once cfb_market_integrity.sql is applied the quarantine is mirrored, once, with no ledger key dropped', withQ.cfb_market_quote_quarantine === qz.length && db.sql('select count(*) from public.cfb_market_quote_quarantine') === String(qz.length));
    const again = await SYL.sync(2026, { fetch: PR.makeFetch(db), quiet: true, log: quietLog('cfb_lab_hourly') });
    chk('the real ledger still re-mirrors after cfb_market_integrity.sql adds its settlement trigger and graded-once index', again.cfb_lab_results > 0 && fingerprint(LT_) === beforeIntegrity);

    /* ================================================================ L. health */
    db.service("select public.cfb_heartbeat('cfb_weekly_refresh', 'OK', 'c', null, 1000, '{}'::jsonb);");
    const hNow = (t) => Object.fromEntries(db.sql(`select check_name || '=' || status from public.cfb_health('${t}')`).split('\n').map((l) => l.split('=')));
    const h1 = hNow(new Date(Date.now() + 60000).toISOString());
    chk('health: the recorded manifest is reported', h1.model_manifest === 'OK' || h1.model_manifest === 'WARNING', h1);
    const h2 = hNow(new Date(Date.now() + 3 * 86400000).toISOString());
    chk('health: a weekly heartbeat older than its 26 h deadline in season is CRITICAL', h2.cron_heartbeats === 'CRITICAL' || new Date(Date.now() + 3 * 86400000).getUTCMonth() + 1 < 8, h2);
    for (let i = 0; i < 10; i++) db.service(`select public.cfb_record_incident('DATABASE_DEADLOCK:storm:${i}', 'DATABASE_DEADLOCK', 'WARNING', 'cfb_weekly_refresh', null, 'storm', '{}'::jsonb);`);
    chk('health: ten deadlocks in an hour is a CRITICAL deadlock storm', hNow(new Date(Date.now() + 60000).toISOString()).deadlock_storm === 'CRITICAL');
    db.service(`insert into public.cfb_decision_snapshots (decision_id, game_id, season, week, book, decided_at, kickoff_ts, engine_version, engine_role, policy_version, artifact_version, model_version,
      status, timing, side, price, stake_u, probability_edge, reason_codes, payload) values ('cfbd_bet', '401', 2026, 5, 'dk', now() - interval '1 hour', now() + interval '2 days', 'cfb_decision_engine_v1', 'CURRENT',
      'cfb_decision_policy_v1', 'cfb_decision_calibration_v1', 'edgedesk_cfb_v2.1.0', 'BET', 'BET_NOW', 'HOME', -110, 1, 0.03, '{BET}', '{}');`);
    chk('health: a BET while official betting is disabled is CRITICAL (fail-safe breach)', hNow(new Date().toISOString()).fail_closed_betting === 'CRITICAL');
    db.service("select public.cfb_set_feature_flag('cfb_model_lab_enabled', false, 'dan', 'pause the lab for maintenance');");
    chk('health: a kill switch that is off is a WARNING', hNow(new Date().toISOString()).feature_flags === 'WARNING');
    db.service("select public.cfb_set_feature_flag('cfb_model_lab_enabled', true, 'dan', 'maintenance done, lab back on');");
    chk('health: resolving an incident needs an actor and a resolution, and closes it', /"resolved": true/.test(db.service("select public.cfb_resolve_incident('DATABASE_DEADLOCK:storm:0', 'dan', 'lock order fixed in the mirror');"))
      && db.sql("select status from public.cfb_incidents_current where incident_key = 'DATABASE_DEADLOCK:storm:0'") === 'RESOLVED');
    const occ = db.service("select public.cfb_record_incident('repeat:key', 'DATABASE_TIMEOUT', 'WARNING', 'cfb_lab_hourly', null, 'again', '{}'::jsonb);") && db.service("select public.cfb_record_incident('repeat:key', 'DATABASE_TIMEOUT', 'WARNING', 'cfb_lab_hourly', null, 'again', '{}'::jsonb);");
    chk('health: a repeated incident is one open incident with occurrences, not two incidents', /"event": "OCCURRED"/.test(occ) && /"occurrences": 2/.test(occ) && db.sql("select count(*) from public.cfb_incidents_current where incident_key = 'repeat:key'") === '1');

    /* ================================================================ M. disaster recovery */
    const dump = path.join(db.home, 'dr.dump');
    shell(db.bin + '/pg_dump -h ' + db.home + ' -p ' + db.port + ' -U postgres -d postgres -Fc -f ' + dump);
    psqlDb('postgres', 'create database dr;');
    let restoreErr = null;
    try { shell(db.bin + '/pg_restore -h ' + db.home + ' -p ' + db.port + ' -U postgres -d dr --exit-on-error ' + dump); } catch (e) { restoreErr = String((e.stderr || '') + (e.stdout || '')).slice(0, 400); }
    chk('DR: the dump restores into a new database without an error', !restoreErr, restoreErr);
    const DRT = ['cfb_production_model_manifest', 'cfb_compatibility_matrix', 'cfb_audit_log', 'cfb_feature_flags', 'cfb_team_week_state', 'cfb_upcoming_game_features', 'cfb_weekly_projections', 'cfb_pipeline_runs', 'cfb_lab_predictions', 'cfb_lab_market_quotes', 'cfb_incidents'];
    chk('DR: manifest, compatibility, audit, flags, recent team state, features, projections, runs, lab predictions and quotes are identical', fingerprint(DRT, 'dr') === fingerprint(DRT));
    const drm = JSON.parse(psqlDb('dr', 'select payload::text from public.cfb_production_manifest_current;'));
    chk('DR: the restored manifest still hashes to its content (it names exactly what produced the predictions)', MF.contentHash(drm) === drm.content_sha256 && drm.champion_selection === 'NOT_RUN');
    const gitProblems = MF.verifyFromGit(drm);
    chk('DR: every artifact the restored manifest names is recoverable from git, byte for byte (or the gap is named)', gitProblems.every((p) => /git has no blob/.test(p)) && Object.keys(drm.artifact_hashes).length >= 10, gitProblems.slice(0, 5));
    chk('DR: the restored audit chain verifies', /"ok": true/.test(psqlDb('dr', 'select public.cfb_audit_verify();')));
    chk('DR: the restored append-only triggers still refuse a rewrite', /append-only/.test((() => { try { psqlDb('dr', "update public.cfb_production_model_manifest set reason = 'x';"); return ''; } catch (e) { return e.message; } })()));
    const drh = psqlDb('dr', "select string_agg(check_name || '=' || status, ',') from public.cfb_health(now()) where check_name in ('model_manifest','latest_team_state','contracts');");
    chk('DR: cfb_health() answers on the restored database: manifest present, contracts present, team state found', /model_manifest=(OK|WARNING)/.test(drh) && /contracts=OK/.test(drh) && !/latest_team_state=CRITICAL.*no team state/.test(drh), drh);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).split('\n').filter((l) => /ERROR|FATAL|at /.test(l)).slice(0, 8).join(' | ').slice(0, 1500));
  } finally {
    db.stop();
  }
  done();
})();
