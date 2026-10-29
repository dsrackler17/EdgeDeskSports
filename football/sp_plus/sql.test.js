#!/usr/bin/env node
/* ===========================================================================
   THE SP+ TABLES (supabase/cfb_sp_plus.sql), AGAINST A REAL POSTGRESQL.

   The raw SP+ capture is ESPN's rating served by CollegeFootballData: it must
   be append-only, and nobody but the service role may read or write it (CFBD
   terms §5, no public mirror). Both rules live in triggers, row level
   security and grants, and are proved here by a server refusing the
   operation: a throwaway cluster, the Supabase role shim, the migration
   applied twice (and once as one string, the way the SQL editor sends it),
   then attacked.

   Run: node football/sp_plus/sql.test.js
   In CI set CFB_SP_SQL_REQUIRED=1: a skipped live layer is then a failure.
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('./cfbd.js');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'cfb_sp_plus.sql'), 'utf8');
const SHIM = fs.readFileSync(path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(note) {
  if (note && /^SKIP/.test(note) && process.env.CFB_SP_SQL_REQUIRED === '1') { fail++; failures.push({ name: 'Postgres is required here (CFB_SP_SQL_REQUIRED=1) but ' + note }); }
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ═══ STATIC ═══════════════════════════════════════════════════════════ */
chk('both tables are declared', /create table if not exists public\.cfb_sp_ratings/.test(SQL) && /create table if not exists public\.cfb_sp_sync_runs/.test(SQL));
chk('the ratings table has every column the sync writes', ['rating_id', 'snapshot_id', 'season', 'week', 'week_key', 'season_type', 'team_id', 'source_team',
  'sp_overall', 'sp_off', 'sp_def', 'source', 'source_version', 'payload_sha256', 'captured_at'].every((c) => new RegExp('\\n  ' + c + '\\s').test(SQL)));
chk('the only read policy is the registry’s (the raw tables have none)', (SQL.match(/create policy/gi) || []).length === 1 && /create policy cfb_external_estimates_read/.test(SQL));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse().map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl' ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim()) : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}
const BIN = findPgBin();
if (!BIN) done('SKIP | no postgres binary (pg_ctl) found — the LIVE layer did not run. CI installs postgres.');

const PORT = 56500 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
let HOME;
try {
  HOME = asPostgres ? fs.mkdtempSync('/var/lib/postgresql/cfbsp-') : fs.mkdtempSync(path.join(os.tmpdir(), 'cfbsp-'));
} catch (e) { done('SKIP | cannot create a cluster directory (' + String(e.message).slice(0, 120) + ') — LIVE layer skipped.'); }
const DATA = path.join(HOME, 'data');
const run = (cmd) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd, { stdio: 'pipe', encoding: 'utf8' });
let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres ${HOME} && chmod 700 ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -U postgres -A trust -E UTF8 --locale=C`);
  run(`${BIN}/pg_ctl -D ${DATA} -o "-p ${PORT} -k ${HOME} -c listen_addresses=" -l ${HOME}/log start -w -t 30`);
  started = true;
} catch (e) {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* nothing to clean */ }
  done('SKIP | postgres would not start (' + String(e.message).slice(0, 160) + ') — LIVE layer skipped.');
}

const PSQL = fs.existsSync(path.join(BIN, 'psql')) ? path.join(BIN, 'psql') : 'psql';
function psql(sql, opts) {
  opts = opts || {};
  const args = ['-X', '-q', '-h', HOME, '-p', String(PORT), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-t', '-A'];
  if (opts.command) args.push('-c', sql);
  else args.push('-f', '-');
  const input = opts.command ? undefined : (opts.role ? 'set role ' + opts.role + ';\n' : '') + sql;
  return cp.execFileSync(PSQL, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PGCLIENTENCODING: 'UTF8' }) }).trim();
}
function mustFail(sql, opts) { try { psql(sql, opts); return null; } catch (e) { return String(e.stderr || e.stdout || e.message); } }
const J = (o) => '$j$' + JSON.stringify(o) + '$j$::jsonb';
const ins = (table, row, opts) => psql(`insert into public.${table} select * from jsonb_populate_record(jsonb_populate_record(null::public.${table}, jsonb_build_object('recorded_at', now())), ${J(row)})`, opts);

function rating(over) {
  const snap = { season: 2026, week_key: '2026:0:09', payload_sha256: 'a'.repeat(64), captured_at: '2026-10-27T15:17:00.000Z' };
  const r = Object.assign({ snapshot_id: C.ids.snapshot(snap), season: 2026, week: 9, week_key: '2026:0:09', season_type: 'regular', team_id: 'jamesmadison',
    source_team: 'James Madison', sp_overall: 9.8, sp_off: 30.1, sp_def: 20.3, source: C.SOURCE, source_version: 'cfbd-ratings-sp:2026:aaaaaaaaaaaa',
    payload_sha256: 'a'.repeat(64), captured_at: snap.captured_at }, over || {});
  r.rating_id = r.rating_id || C.ids.rating(r);
  return r;
}
function runRow(over) {
  const r = Object.assign({ season: 2026, week: 9, week_key: '2026:0:09', started_at: '2026-10-27T15:17:00Z', finished_at: '2026-10-27T15:17:05Z',
    status: 'OK', reason: null, n_received: 6, n_valid: 6, n_mapped: 6, unmapped: [], rejected: [], payload_sha256: 'a'.repeat(64), snapshot_id: rating().snapshot_id }, over || {});
  r.run_id = r.run_id || C.ids.run(r);
  return r;
}

try {
  psql(SHIM);
  psql(SQL);
  chk('the migration applies to a clean database', true);
  psql(SQL);
  chk('and applies a second time without error', true);
  psql(SQL, { command: true });
  chk('and a third time as one string (the SQL editor)', true);

  /* the service role writes */
  ins('cfb_sp_ratings', rating(), { role: 'service_role' });
  ins('cfb_sp_sync_runs', runRow(), { role: 'service_role' });
  chk('the service role inserts a rating and a run', psql(`select count(*) from public.cfb_sp_ratings`) === '1' && psql(`select count(*) from public.cfb_sp_sync_runs`) === '1');
  chk('and reads them back', psql(`select team_id from public.cfb_sp_ratings`, { role: 'service_role' }) === 'jamesmadison');
  chk('a second insert of the same rating id is refused (the sync ignores duplicates)', !!mustFail(`insert into public.cfb_sp_ratings select * from jsonb_populate_record(null::public.cfb_sp_ratings, ${J(Object.assign(rating(), { recorded_at: new Date().toISOString() }))})`, { role: 'service_role' }));

  /* append-only, even for the service role and for postgres itself */
  for (const t of ['cfb_sp_ratings', 'cfb_sp_sync_runs']) {
    chk(t + ': UPDATE is refused for the service role', !!mustFail(`update public.${t} set season = 2025`, { role: 'service_role' }));
    chk(t + ': UPDATE is refused even for the owner (trigger)', /append-only/.test(mustFail(`update public.${t} set season = 2025`) || ''));
    chk(t + ': DELETE is refused even for the owner (trigger)', /append-only/.test(mustFail(`delete from public.${t}`) || ''));
    chk(t + ': TRUNCATE is refused even for the owner (trigger)', /append-only/.test(mustFail(`truncate public.${t}`) || ''));
  }

  /* nobody else reads or writes */
  for (const role of ['anon', 'authenticated']) {
    for (const t of ['cfb_sp_ratings', 'cfb_sp_sync_runs']) {
      chk(role + ' cannot read ' + t, /permission denied/.test(mustFail(`select count(*) from public.${t}`, { role }) || ''));
    }
    chk(role + ' cannot insert a rating', /permission denied/.test(mustFail(`insert into public.cfb_sp_ratings (rating_id) values ('cfbsp_${'0'.repeat(24)}')`, { role }) || ''));
  }
  chk('row level security is on, with no policy', psql(`select bool_and(relrowsecurity) from pg_class where relname in ('cfb_sp_ratings','cfb_sp_sync_runs')`) === 't'
    && psql(`select count(*) from pg_policies where tablename in ('cfb_sp_ratings','cfb_sp_sync_runs')`) === '0');

  /* constraints */
  const bad = (over, re, what) => chk('refused: ' + what, re.test(mustFail(`insert into public.cfb_sp_ratings select * from jsonb_populate_record(null::public.cfb_sp_ratings, ${J(Object.assign(rating(Object.assign({ rating_id: 'cfbsp_' + 'f'.repeat(24) }, over)), { recorded_at: new Date().toISOString() }))})`, { role: 'service_role' }) || ''), over);
  bad({ team_id: 'James Madison' }, /cfb_sp_rating_team/, 'a team id that is not a canonical key');
  bad({ sp_overall: 120 }, /cfb_sp_rating_values/, 'a rating outside +/-100');
  bad({ week_key: '9' }, /cfb_sp_rating_week_key/, 'a malformed week key');
  bad({ season_type: 'bowl' }, /cfb_sp_rating_season_type/, 'an unknown season type');
  bad({ payload_sha256: 'abc' }, /cfb_sp_rating_hash/, 'a payload hash that is not sha256');
  bad({ rating_id: 'x' }, /cfb_sp_rating_id_format/, 'a malformed rating id');
  chk('refused: a second row for the same team in one snapshot', /cfb_sp_rating_one_per_team/.test(mustFail(`insert into public.cfb_sp_ratings select * from jsonb_populate_record(null::public.cfb_sp_ratings, ${J(Object.assign(rating({ rating_id: 'cfbsp_' + 'e'.repeat(24) }), { recorded_at: new Date().toISOString() }))})`, { role: 'service_role' }) || ''));
  chk('refused: an OK run without a snapshot', /cfb_sp_run_snapshot/.test(mustFail(`insert into public.cfb_sp_sync_runs select * from jsonb_populate_record(null::public.cfb_sp_sync_runs, ${J(Object.assign(runRow({ run_id: 'cfbsr_' + '1'.repeat(24), snapshot_id: null }), { recorded_at: new Date().toISOString() }))})`, { role: 'service_role' }) || ''));
  chk('refused: a FAILED run without a reason', /cfb_sp_run_reason/.test(mustFail(`insert into public.cfb_sp_sync_runs select * from jsonb_populate_record(null::public.cfb_sp_sync_runs, ${J(Object.assign(runRow({ run_id: 'cfbsr_' + '2'.repeat(24), status: 'FAILED', snapshot_id: null, reason: null }), { recorded_at: new Date().toISOString() }))})`, { role: 'service_role' }) || ''));
  ins('cfb_sp_sync_runs', runRow({ run_id: 'cfbsr_' + '3'.repeat(24), status: 'FAILED', snapshot_id: null, reason: 'CollegeFootballData answered HTTP 500', unmapped: [{ source_team: 'Narnia Tech', reason: 'does not resolve' }] }), { role: 'service_role' });
  chk('a FAILED run with its reason and its unmapped names is stored', psql(`select unmapped->0->>'source_team' from public.cfb_sp_sync_runs where status = 'FAILED'`) === 'Narnia Tech');

  /* the registry: SP+ is an external estimate, and the server keeps it one */
  const REG = JSON.parse(fs.readFileSync(path.join(__dirname, 'registry.json'), 'utf8')).estimates[0];
  chk('the registry is seeded with SP+’s projected line, once (the migration ran three times)',
    psql(`select count(*) from public.cfb_external_estimates where estimate_id = 'cfbd.sp_plus_projected_line'`) === '1');
  chk('seeded as external: not an EdgeDesk model, not validated, T3 rating, T2 line',
    psql(`select edgedesk_model::text || validated_by_edgedesk::text || rating_tier || line_tier || kind from public.cfb_external_estimates`) === 'falsefalseT3T2EXTERNAL_ESTIMATE');
  chk('with the same attribution as registry.json and the cards', psql(`select attribution from public.cfb_external_estimates`) === REG.attribution);
  chk('with its source, version and terms', psql(`select (length(source) > 0 and length(source_version) > 0 and terms_url = 'https://collegefootballdata.com/terms' and length(terms_summary) > 40)::text from public.cfb_external_estimates`) === 'true');
  const ext = (over) => `insert into public.cfb_external_estimates (estimate_id, name, kind, sport, edgedesk_model, validated_by_edgedesk, rating_tier, line_tier, source, provider, source_version, terms_url, terms_summary, attribution, registered_at)
    values ('x.${Object.keys(over).join('_')}', 'X', ${over.kind || "'EXTERNAL_ESTIMATE'"}, 'cfb', ${over.edgedesk_model || 'false'}, ${over.validated || 'false'}, ${over.rating_tier || "'T3'"}, 'T2', 's', 'p', 'v', 'u', 't', 'a', now())`;
  chk('refused: an external estimate marked as an EdgeDesk model', /cfb_ext_not_edgedesk/.test(mustFail(ext({ edgedesk_model: 'true' })) || ''));
  chk('refused: an external estimate marked validated by EdgeDesk', /cfb_ext_not_edgedesk/.test(mustFail(ext({ validated: 'true' })) || ''));
  chk('refused: any other kind', /cfb_ext_kind/.test(mustFail(ext({ kind: "'EDGEDESK_MODEL'" })) || ''));
  chk('refused: a rating tier other than T3', /cfb_ext_rating_tier/.test(mustFail(ext({ rating_tier: "'T1'" })) || ''));
  chk('refused: flipping the seeded row to validated, even for the owner', /append-only/.test(mustFail(`update public.cfb_external_estimates set validated_by_edgedesk = true`) || ''));
  chk('authenticated reads the registry', psql(`select count(*) from public.cfb_external_estimates`, { role: 'authenticated' }) === '1');
  chk('anon cannot read it (least privilege: anon reads only the settled-record views)', /permission denied/.test(mustFail(`select count(*) from public.cfb_external_estimates`, { role: 'anon' }) || ''));
  chk('anon cannot write it', /permission denied/.test(mustFail(ext({ anon: 'x' }), { role: 'anon' }) || ''));
  chk('authenticated cannot write it', /permission denied/.test(mustFail(ext({ auth: 'x' }), { role: 'authenticated' }) || ''));
  chk('no grant to anon anywhere in the migration', !/\bgrant\b[^;]*\bto\s+[a-z_, ]*\banon\b/i.test(SQL));
} catch (e) {
  chk('the live layer ran without an unexpected error', false, String(e.stderr || e.message).slice(0, 600));
} finally {
  if (started) { try { run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) { /* going away */ } }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
done();
