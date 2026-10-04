#!/usr/bin/env node
/* ===========================================================================
   ADMIN-ONLY MEMBER REMOVAL — the SQL, run against a real PostgreSQL.

   supabase/collective_member_removal.sql is the whole feature: the
   authorization, the foreign-key ordering, the transaction, the audit log and
   the recalculation all live in the database, so that removing a contributor
   does not depend on a browser being honest or on which edge function happens
   to be deployed. Reasoning about that is not evidence. This applies the
   SHIPPED file, unmodified, to a live database holding a reconstruction of the
   Collective schema (tools/collective/sql/collective_fixture.sql) and then uses
   and attacks it: as anon, as a signed-in contributor, as an admin, twice over,
   and with a foreign key deliberately in the way so the rollback happens for
   real.

   TWO LAYERS, so this runs everywhere and runs properly where it can:

     STATIC — always. The conventions supabase/README.md states: idempotent,
     additive, ends in a report; plus the rules this file in particular must
     never break (no CASCADE, nothing dropped, no table name hardcoded into a
     DELETE, the auth schema never written to).

     LIVE — when a postgres server binary is on PATH. If it is not, the suite
     SAYS SO and passes on the static layer alone. A skipped check that
     announces itself is honest; one that stays quiet is how a bug ships.

   Run: node tools/collective/member_removal_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/collective/member_removal_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') {
    try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; }
  }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done(extra) {
  failures.forEach((f) => console.log('FAIL | ' + f.name
    + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  if (extra) console.log(extra);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const SQL_PATH = path.join(ROOT, 'supabase', 'collective_member_removal.sql');
const FIXTURE = path.join(__dirname, 'sql', 'collective_fixture.sql');
const SUITE = path.join(__dirname, 'sql', 'member_removal.test.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

/* ═══ STATIC ══════════════════════════════════════════════════════════════ */
{
  const stripped = SQL.replace(/--[^\n]*/g, ' ');

  chk('the schema changes are wrapped in a transaction',
    /^\s*begin;/m.test(SQL) && /^\s*commit;/m.test(SQL));
  chk('the report runs AFTER the commit, so a failing check cannot roll the file back',
    SQL.indexOf('\ncommit;') > 0 && SQL.lastIndexOf('mcr_report order by n') > SQL.indexOf('\ncommit;'));
  chk('the file ends in a report whose rows say ok or CHECK THIS',
    /'ok'/.test(SQL) && /'CHECK THIS'/.test(SQL));
  chk('every CREATE TABLE is guarded with IF NOT EXISTS (idempotent)',
    (stripped.match(/create table(?!\s+if not exists)/gi) || []).length === 0);
  chk('every CREATE INDEX is guarded with IF NOT EXISTS',
    (stripped.match(/create index(?!\s+if not exists)/gi) || []).length === 0);
  chk('every ADD COLUMN is guarded with IF NOT EXISTS',
    (stripped.match(/add column(?!\s+if not exists)/gi) || []).length === 0);

  /* The rules this file in particular lives or dies by. */
  chk('NO CASCADE is added anywhere — the brief forbids it and so does the schema',
    !/on delete cascade/i.test(stripped) && !/drop\s+\w+\s+.*cascade/i.test(stripped));
  chk('nothing is dropped except the trigger it immediately recreates',
    (stripped.match(/\bdrop\s+(table|column|index|database|schema|function)\b/gi) || []).length === 0,
    (stripped.match(/\bdrop\s+\w+/gi) || []));
  chk('no DELETE in this file names a table — every one goes through the discovered plan',
    (stripped.match(/delete from (?!%s)\S/gi) || []).filter((x) => !/delete from collective\.admin_audit_log/i.test(x)).length === 0,
    (stripped.match(/delete from [^\s%][^\s]*/gi) || []));
  chk('the auth schema is never written to',
    !/\b(insert into|update|delete from)\s+auth\./i.test(stripped));
  chk('the creators table is protected by name, so it can never enter a delete plan',
    /'creators','members','contributors','admin_audit_log'/.test(SQL));
  chk('the acting user is never an argument on the client-facing wrappers',
    /public\.collective_member_remove\(\s*\n?\s*p_creator_slug text, p_mode text, p_confirm text/.test(SQL)
      && /collective\.admin_member_remove\(auth\.uid\(\)/.test(SQL));
  chk('anon is revoked from every client-facing wrapper',
    /revoke all on function ' \|\| fn \|\| ' from anon/.test(SQL));
  chk('the append-only maintenance switch is set transaction-locally, so it lifts on rollback',
    /set_config\('collective\.maintenance', 'on', true\)/.test(SQL));
  chk('a full delete requires the word DELETE, checked on the server',
    /coalesce\(p_confirm, ''\) <> 'DELETE'/.test(SQL));
  chk('the audit row is written before the deletions, so a failure is still recorded',
    SQL.indexOf('insert into collective.admin_audit_log') < SQL.indexOf("perform set_config('collective.maintenance', 'on', true)"));
  chk('a second removal of the same contributor is serialized by an advisory lock',
    /pg_advisory_xact_lock/.test(SQL));
  chk('a recalculation that fails is NOT swallowed into the success response',
    /A failure here is NOT swallowed/.test(SQL)
    && !/refresh materialized view[\s\S]{0,200}exception when others then[\s\S]{0,120}'failed'/.test(SQL));
}

/* ═══ LIVE ════════════════════════════════════════════════════════════════ */
function findPgBin() {
  const cands = ['pg_ctl'].concat(
    (() => { try { return fs.readdirSync('/usr/lib/postgresql').sort().reverse()
      .map((v) => '/usr/lib/postgresql/' + v + '/bin/pg_ctl'); } catch (_) { return []; } })());
  for (const c of cands) {
    try {
      cp.execSync(`${c} --version`, { stdio: 'ignore' });
      return c === 'pg_ctl'
        ? path.dirname(cp.execSync('command -v pg_ctl').toString().trim())
        : path.dirname(c);
    } catch (_) { /* keep looking */ }
  }
  return null;
}

const BIN = findPgBin();
if (!BIN) {
  done('NOTE | no postgres binary on PATH — the LIVE layer did not run.\n'
     + '     | The static layer above holds the conventions; only a real server can hold the\n'
     + '     | authorization, the delete ordering and the rollback. CI installs postgres.');
}

const PORT = 55700 + (process.pid % 200);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres
  ? fs.mkdtempSync('/var/lib/postgresql/mcr-')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'mcr-'));
const DATA = path.join(HOME, 'data');
const run = (cmd, opts) => cp.execSync(asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd,
  Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));

let started = false;
try {
  if (asPostgres) cp.execSync(`chown -R postgres:postgres ${HOME}`);
  run(`${BIN}/initdb -D ${DATA} -A trust -E UTF8`);
  run(`${BIN}/pg_ctl -D ${DATA} -o '-k /tmp -p ${PORT} -c listen_addresses=' -l ${HOME}/pg.log start -w`);
  started = true;
} catch (e) {
  done('NOTE | could not start a local postgres (' + String(e.message).slice(0, 160) + ')\n'
     + '     | The LIVE layer did not run; the static layer above did.');
}
function cleanup() {
  try { if (started) run(`${BIN}/pg_ctl -D ${DATA} -m immediate stop`); } catch (_) {}
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', cleanup);

/* Copy the files somewhere the postgres user can read when we are root. */
function stage(src) {
  const dst = path.join(HOME, path.basename(src));
  fs.copyFileSync(src, dst);
  if (asPostgres) cp.execSync(`chmod a+r ${dst}`);
  return dst;
}
const fFixture = stage(FIXTURE), fMig = stage(SQL_PATH), fSuite = stage(SUITE);

function psql(args, quiet) {
  try {
    return { status: 0, out: run(`${BIN}/psql -h /tmp -p ${PORT} ${args} 2>&1`) };
  } catch (e) {
    return { status: 1, out: String((e.stdout || '') + (e.stderr || '') + (quiet ? '' : e.message)) };
  }
}

psql(`-d postgres -q -c "create database mcr"`);
let r = psql(`-d mcr -q -v ON_ERROR_STOP=1 -f ${fFixture}`);
chk('the reconstructed Collective schema builds', r.status === 0, r.out.slice(-900));
if (r.status !== 0) done();

/* THE MIGRATION, RUN FOR REAL — three times, because the folder says idempotent. */
const okRows = (o) => (o.match(/\|\s*ok\s*\|/g) || []).length;
const badRows = (o) => (o.match(/\|\s*CHECK THIS\s*\|/g) || []).length;

const first = psql(`-d mcr -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('the migration runs to completion against a real postgres', first.status === 0 && /COMMIT/.test(first.out),
  first.out.slice(-1200));
chk('its report EXECUTES', /outcome/.test(first.out), first.out.slice(-400));
chk('no report row says CHECK THIS on the first run', badRows(first.out) === 0, first.out.slice(-1400));
chk('the report actually checked things', okRows(first.out) >= 8, okRows(first.out));

const second = psql(`-d mcr -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('running it a second time is clean — the convention says idempotent',
  second.status === 0 && badRows(second.out) === 0, second.out.slice(-900));
const third = psql(`-d mcr -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('and a third time', third.status === 0 && badRows(third.out) === 0, third.out.slice(-600));

/* THE SUITE. Every assertion is a NOTICE; a failure is an ERROR. */
const suite = psql(`-d mcr -v ON_ERROR_STOP=1 -f ${fSuite}`);
const asserted = (suite.out.match(/NOTICE:\s+ok\s/g) || []).length;
if (suite.status !== 0) {
  const lines = suite.out.split('\n').filter((l) => /ERROR|FAIL|CONTEXT|DETAIL/.test(l)).slice(0, 12);
  chk('the member-removal suite runs green against a real database', false,
    { asserted, errors: lines });
  done();
}
chk('the member-removal suite runs green against a real database', true);
/* A suite that asserts nothing must not be able to report success. */
chk('the suite actually ran its assertions', asserted >= 70, asserted);

done('       (' + asserted + ' database assertions ran against PostgreSQL '
  + (run(`${BIN}/psql --version`).match(/\d+\.\d+/) || ['?'])[0] + ')');
