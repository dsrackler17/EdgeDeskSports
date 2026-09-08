#!/usr/bin/env node
/* ===========================================================================
   SELF-SERVE MODELS — the SQL, run against a real PostgreSQL.

   supabase/collective_model_autocreate.sql is the whole feature. It exists
   because collective_join, collective_public and collective_admin are deployed
   from the Supabase dashboard and are not in this repository: a get-or-create
   living in one of them could not be reviewed, tested, or relied on by the
   other two. So the capability is in the DATABASE, where the browser, the
   ingest function and any future caller all reach the same one — the same move
   collective_member_removal.sql made, for the same reason.

   Reasoning about that is not evidence. This applies the SHIPPED file,
   unmodified, to a live database holding a reconstruction of the Collective
   schema (tools/collective/sql/collective_fixture.sql) and then uses and
   attacks it.

   THREE LAYERS:

     STATIC — always. The conventions supabase/README.md states (idempotent,
     additive, ends in a report) plus the rules the brief sets for this file in
     particular: RLS is never disabled, no creator is hardcoded, and no client
     role is handed a table.

     SUITE — sql/model_autocreate.test.sql, against a real server: the
     vocabulary, cases A, B, F and I, and what the function refuses.

     CONCURRENCY — case H, which cannot be written from one session. Eight
     connections are released at the same wall-clock instant and all ask for the
     same missing model. Exactly one row may exist afterwards and every one of
     them must have been handed it.

   If no postgres binary is on PATH the suite SAYS SO and passes on the static
   layer alone. A skipped check that announces itself is honest; one that stays
   quiet is how a bug ships.

   Run: node tools/collective/model_autocreate_sql.test.js
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
const SQL_PATH = path.join(ROOT, 'supabase', 'collective_model_autocreate.sql');
const FIXTURE = path.join(__dirname, 'sql', 'collective_fixture.sql');
const SUITE = path.join(__dirname, 'sql', 'model_autocreate.test.sql');
const SQL = fs.readFileSync(SQL_PATH, 'utf8');

/* ═══ STATIC ══════════════════════════════════════════════════════════════ */
{
  const stripped = SQL.replace(/--[^\n]*/g, ' ');

  chk('the schema changes are wrapped in a transaction',
    /^\s*begin;/m.test(SQL) && /^\s*commit;/m.test(SQL));
  chk('the report runs AFTER the commit, so a failing check cannot roll the file back',
    SQL.indexOf('\ncommit;') > 0 && SQL.lastIndexOf('cma_report order by n') > SQL.indexOf('\ncommit;'));
  chk('the file ends in a report whose rows say ok or CHECK THIS',
    /'ok'/.test(SQL) && /'CHECK THIS'/.test(SQL));
  chk('every CREATE TABLE is guarded with IF NOT EXISTS (idempotent)',
    (stripped.match(/create table(?!\s+if not exists)/gi) || []).length === 0);
  chk('every CREATE INDEX is guarded with IF NOT EXISTS',
    (stripped.match(/create (unique )?index(?!\s+if not exists)/gi) || []).length === 0,
    (stripped.match(/create (unique )?index[^\n]{0,60}/gi) || []));
  chk('every function is CREATE OR REPLACE, so a re-run rebinds rather than failing',
    (stripped.match(/create function/gi) || []).length === 0);

  /* THE BRIEF'S OWN PROHIBITIONS. */
  chk('RLS is never disabled — not on any table, not for a moment',
    !/disable\s+row\s+level\s+security/i.test(stripped)
    && !/alter\s+table[\s\S]{0,80}force\s+row\s+level\s+security/i.test(stripped)
    && !/drop\s+policy/i.test(stripped));
  chk('no client role is granted anything on a table',
    (stripped.match(/grant[^;]*\bon\s+table\b/gi) || []).length === 0
    && (stripped.match(/grant\s+(select|insert|update|delete|all)\s+on\s+(?!function)/gi) || []).length === 0,
    (stripped.match(/grant[^;]{0,80}/gi) || []));
  chk('anon is revoked from both public doors, explicitly',
    /revoke all on function public\.collective_model_ensure\(text, text\) from public, anon/.test(SQL)
    && /revoke all on function public\.collective_my_models\(\) from public, anon/.test(SQL));
  chk('the creator-taking function is revoked from every client role',
    /revoke all on function %I\.get_or_create_model\(uuid, text, text\) from public, anon, authenticated/.test(SQL));
  chk('neither public door takes a creator, so a body can never name one',
    /create or replace function public\.collective_model_ensure\(\s*\n?\s*p_sport text,\s*\n?\s*p_model_name text/.test(SQL)
    && /create or replace function public\.collective_my_models\(\)/.test(SQL));
  chk('the acting creator is auth.uid() and is read from the creators table, not the argument',
    /where c\.%I = auth\.uid\(\)/.test(SQL));

  /* No contributor is special. The bug report came from one account; the fix
     may not know its name. */
  chk('no creator slug, display name or user id is hardcoded anywhere',
    !/blizzard/i.test(SQL) && !/edgedesksports'/.test(SQL)
    && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(SQL),
    (SQL.match(/blizzard\w*/gi) || []).concat(SQL.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []));

  /* Concurrency: the brief forbids select-then-insert as the whole strategy. */
  chk('creation is serialised on a transaction-scoped advisory lock',
    /pg_advisory_xact_lock/.test(SQL));
  chk('and the insert itself is ON CONFLICT DO NOTHING with a read-back',
    /on conflict do nothing/.test(SQL)
    && SQL.indexOf('Read it back rather than trusting the insert') > SQL.indexOf('on conflict do nothing'));
  chk('the uniqueness rule is an index on the NORMALISED sport, not the raw string',
    /create unique index if not exists\s+models_creator_sport_family_uniq[\s\S]{0,120}sport_family/.test(SQL));

  /* Nothing existing is rewritten. */
  chk('no existing row is updated or deleted by this file',
    (stripped.match(/\bupdate\s+%s\b|\bupdate\s+%I|\bdelete\s+from\s+%/gi) || []).length === 0,
    (stripped.match(/\b(update|delete from)\s+\S+/gi) || []));
  chk('nothing is dropped except the derived index it immediately recreates',
    (stripped.match(/\bdrop\s+(table|column|database|schema|function|policy)\b/gi) || []).length === 0
    && /drop index if exists %I\.models_creator_sport_family_uniq/.test(SQL));
  chk('the auth schema is never written to',
    !/\b(insert into|update|delete from)\s+auth\./i.test(stripped));
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
     + '     | idempotency, the isolation and the concurrency. CI installs postgres.');
}

const PORT = 55900 + (process.pid % 90);
const asPostgres = process.getuid && process.getuid() === 0;
const HOME = asPostgres
  ? fs.mkdtempSync('/var/lib/postgresql/cma-')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'cma-'));
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

function stage(src) {
  const dst = path.join(HOME, path.basename(src));
  fs.copyFileSync(src, dst);
  if (asPostgres) cp.execSync(`chmod a+r ${dst}`);
  return dst;
}
const fFixture = stage(FIXTURE), fMig = stage(SQL_PATH), fSuite = stage(SUITE);

function psql(args) {
  try {
    return { status: 0, out: run(`${BIN}/psql -h /tmp -p ${PORT} ${args} 2>&1`) };
  } catch (e) {
    return { status: 1, out: String((e.stdout || '') + (e.stderr || '') + e.message) };
  }
}

psql(`-d postgres -q -c "create database cma"`);
let r = psql(`-d cma -q -v ON_ERROR_STOP=1 -f ${fFixture}`);
chk('the reconstructed Collective schema builds', r.status === 0, r.out.slice(-900));
if (r.status !== 0) done();

/* THE MIGRATION, RUN FOR REAL — three times, because the folder says idempotent. */
const okRows = (o) => (o.match(/\|\s*ok\s*\|/g) || []).length;
const badRows = (o) => (o.match(/\|\s*CHECK THIS\s*\|/g) || []).length;

const first = psql(`-d cma -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('the migration runs to completion against a real postgres',
  first.status === 0 && /COMMIT/.test(first.out), first.out.slice(-1400));
chk('its report EXECUTES', /outcome/.test(first.out), first.out.slice(-400));
chk('no report row says CHECK THIS on the first run', badRows(first.out) === 0, first.out.slice(-1400));
chk('the report actually checked things', okRows(first.out) >= 6, okRows(first.out));

/* The fixture spells the column `sport` and the ingest function reads
   `sport_code`. Both shapes exist in the wild, so the file has to find the one
   in front of it rather than assume — and say which it found. */
chk('the file discovered the column names rather than assuming them',
  /collective\.models\(creator_id,slug,sport text\)/.test(first.out), first.out.slice(-1400));

const second = psql(`-d cma -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('running it a second time is clean — the convention says idempotent',
  second.status === 0 && badRows(second.out) === 0, second.out.slice(-900));
chk('and the second run does NOT rebuild an index that has not changed',
  /already correct/.test(second.out), second.out.slice(-900));
const third = psql(`-d cma -v ON_ERROR_STOP=1 -f ${fMig}`);
chk('and a third time', third.status === 0 && badRows(third.out) === 0, third.out.slice(-600));

/* THE SUITE. Every assertion is a NOTICE; a failure is an ERROR. */
const suite = psql(`-d cma -v ON_ERROR_STOP=1 -f ${fSuite}`);
const asserted = (suite.out.match(/NOTICE:\s+ok\s/g) || []).length;
if (suite.status !== 0) {
  const lines = suite.out.split('\n').filter((l) => /ERROR|FAIL|CONTEXT|DETAIL/.test(l)).slice(0, 12);
  chk('the self-serve model suite runs green against a real database', false, { asserted, errors: lines });
  done();
}
chk('the self-serve model suite runs green against a real database', true);
chk('the suite actually ran its assertions', asserted >= 55, asserted);

/* ═══ AN ENUM SPORT COLUMN ═══════════════════════════════════════════════
   `sport` is text on the deployment this repository can see, but a column of
   an enum type is an ordinary way to build one — and a text value assigned to
   an enum column is a HARD ERROR ("column is of type sp but expression is of
   type text"), not a coercion. Unhandled, that turns every first slate in a new
   sport into a 500 on exactly the deployments least able to diagnose it. This
   builds that shape and runs the file against it for real. */
{
  psql(`-d postgres -q -c "create database cma_enum"`);
  let e = psql(`-d cma_enum -q -v ON_ERROR_STOP=1 -f ${fFixture}`);
  chk('a second fixture builds', e.status === 0, e.out.slice(-400));
  psql(`-d cma_enum -q -c "create type collective.sport_kind as enum ('NFL','NCAAF')"`);
  psql(`-d cma_enum -q -c "alter table collective.models alter column sport drop default"`);
  const conv = psql(`-d cma_enum -q -c "alter table collective.models alter column sport type collective.sport_kind using sport::text::collective.sport_kind"`);
  chk('and its sport column can be made an enum', conv.status === 0, conv.out.slice(-300));

  const mig = psql(`-d cma_enum -v ON_ERROR_STOP=1 -f ${fMig}`);
  chk('the migration installs over an enum sport column',
    mig.status === 0 && badRows(mig.out) === 0, mig.out.slice(-1200));
  chk('and the report names the type it found, not just the column',
    /sport collective\.sport_kind/.test(mig.out), mig.out.slice(-1200));

  psql(`-d cma_enum -q -c "insert into auth.users (id,email) values ('ffffffff-0000-0000-0000-000000000001','enum@example.com')"`);
  psql(`-d cma_enum -q -c "insert into collective.creators (user_id,slug,display_name) values ('ffffffff-0000-0000-0000-000000000001','enum-desk','Enum Desk')"`);
  const made = psql(`-d cma_enum -tA -c "select model_slug, sport, created from collective.get_or_create_model((select id from collective.creators where slug='enum-desk'),'NFL',null)"`);
  chk('a model is created against it rather than failing on the cast',
    made.status === 0 && /^enum-desk-nfl\|NFL\|t$/m.test(made.out.trim()), made.out.trim());
  const again2 = psql(`-d cma_enum -tA -c "select model_slug, created from collective.get_or_create_model((select id from collective.creators where slug='enum-desk'),'pro football',null)"`);
  chk('and an alias of it still returns that same model',
    /^enum-desk-nfl\|f$/m.test(again2.out.trim()), again2.out.trim());
  const bad = psql(`-d cma_enum -tA -c "select model_slug from collective.get_or_create_model((select id from collective.creators where slug='enum-desk'),'WNBA',null)"`);
  chk('a sport the enum does not carry fails LOUDLY rather than storing something wrong',
    bad.status !== 0 && /invalid input value for enum|WNBA/.test(bad.out), bad.out.slice(-300));
}

/* ═══ H: TWO SIMULTANEOUS CREATIONS MAKE ONE MODEL ════════════════════════
   The failure this guards against is a select-then-insert race, and it cannot
   be written from one session: both callers have to be inside the window at
   once. Eight connections are opened, each parked on a wall-clock barrier, and
   all released at the same instant to ask for the same missing model.

   Without the advisory lock and the unique index this produces up to eight
   models for one creator, and the contributor's record silently splits across
   them. */
{
  psql(`-d cma -q -c "insert into auth.users (id, email) values ('eeeeeeee-0000-0000-0000-000000000001','race@example.com')"`);
  psql(`-d cma -q -c "insert into collective.creators (user_id, slug, display_name) values ('eeeeeeee-0000-0000-0000-000000000001','race-desk','Race Desk')"`);

  const N = 8;
  const startAt = new Date(Date.now() + 2500).toISOString();
  /* Every session sleeps until the SAME instant, then asks. The sport is
     spelled differently in half of them, because two spellings of one sport
     racing each other is the case a raw string index would not survive. */
  const sqlFor = (i) => `
    begin;
    select pg_sleep(greatest(0, extract(epoch from (timestamptz '${startAt}' - clock_timestamp()))));
    select model_slug from collective.get_or_create_model(
      (select id from collective.creators where slug = 'race-desk'),
      '${i % 2 === 0 ? 'NFL' : 'National Football League'}', null);
    commit;`;

  const kids = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(HOME, `race${i}.sql`);
    fs.writeFileSync(f, sqlFor(i));
    if (asPostgres) cp.execSync(`chmod a+r ${f}`);
    const cmd = `${BIN}/psql -h /tmp -p ${PORT} -d cma -tA -v ON_ERROR_STOP=1 -f ${f}`;
    kids.push(cp.spawn(asPostgres ? 'su' : '/bin/sh',
      asPostgres ? ['postgres', '-c', cmd] : ['-c', cmd],
      { stdio: ['ignore', 'pipe', 'pipe'] }));
  }
  const outs = kids.map((k) => {
    let o = '', e = '';
    k.stdout.on('data', (d) => { o += d; });
    k.stderr.on('data', (d) => { e += d; });
    return () => ({ o, e });
  });
  const codes = kids.map((k) => new Promise((res) => k.on('close', res)));

  Promise.all(codes).then((cs) => {
    const results = outs.map((f) => f());
    const slugs = results.map((x) => (x.o.match(/race-desk-\S+/) || [null])[0]);

    chk('H: every one of the eight simultaneous callers got an answer',
      cs.every((c) => c === 0) && slugs.every((s) => !!s),
      { codes: cs, slugs, errs: results.map((x) => x.e.slice(0, 200)).filter(Boolean).slice(0, 3) });
    chk('H: and every one of them was handed the SAME model',
      new Set(slugs).size === 1, slugs);

    const cnt = psql(`-d cma -tA -c "select count(*) from collective.models m join collective.creators c on c.id=m.creator_id where c.slug='race-desk'"`);
    chk('H: exactly one model exists afterwards', cnt.out.trim() === '1', cnt.out.trim());

    /* And the same holds for a second wave: idempotent under concurrency is not
       a one-shot property. */
    const again = psql(`-d cma -tA -c "select model_slug, created from collective.get_or_create_model((select id from collective.creators where slug='race-desk'),'ncaa football',null)"`);
    chk('H: a later call for a DIFFERENT sport still creates exactly one more',
      /\|t$/m.test(again.out.trim()), again.out.trim());
    const cnt2 = psql(`-d cma -tA -c "select count(*) from collective.models m join collective.creators c on c.id=m.creator_id where c.slug='race-desk'"`);
    chk('H: leaving two models, one per sport', cnt2.out.trim() === '2', cnt2.out.trim());

    done('       (' + asserted + ' database assertions plus a ' + N + '-way race, against PostgreSQL '
      + (run(`${BIN}/psql --version`).match(/\d+\.\d+/) || ['?'])[0] + ')');
  });
}
