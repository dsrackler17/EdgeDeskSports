#!/usr/bin/env node
/* ============================================================================
   supabase/editorial_runtime.sql, APPLIED AND ATTACKED on a real PostgreSQL.

   The guarantees here are ones only a database can make, so only a database
   can prove them:

     1  IT APPLIES, twice, over site_articles.sql alone.
     2  THE LEASE IS ATOMIC. Two workers racing produce exactly one winner —
        asserted from separate connections, because a single-session test
        proves nothing about concurrency.
     3  A DEAD WORKER RECOVERS. The lease expires and the next worker takes it.
        Nothing can stay held forever and no cleanup job is needed.
     4  A LEASE CANNOT BE STOLEN. Release only affects what you hold.
     5  INDEPENDENT WORK STILL RUNS IN PARALLEL. Different keys never block.
     6  BAD SETTINGS ARE REFUSED BY THE DATABASE, not merely by the form —
        including against the service role, which no client-side check binds.
     7  EVERY CHANGE IS AUDITED, automatically, with old and new values.
     8  RLS: the public may read settings and heartbeats and may write neither;
        an operator may write settings; nobody but the service role may claim a
        lease, because a browser holding the dispatcher lease would stall the
        publisher.

   Needs PostgreSQL. Prints SKIPPED and exits 0 without one, so it can sit
   beside the offline suites.
   Run: node tools/editorial/runtime_sql.test.js
   ========================================================================== */
'use strict';
const cp = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const ARTICLES = path.join(ROOT, 'supabase', 'site_articles.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'editorial_runtime.sql');
const DB = 'edgedesk_editorial_runtime_test';

const have = b => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args, o) => cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, o || {}));

function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edpg/sock', '-U', 'postgres']);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function skip(why) {
  console.log('SKIP | editorial runtime SQL | ' + why);
  console.log('       (needs PostgreSQL; the offline half is tools/editorial/runtime.test.js)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');

let conn = null;
for (const c of candidates()) {
  if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + String(detail).slice(0, 220) : ''));
  return false;
}
const q = (sql, db) => psql(conn, ['-d', db || DB, '-tAc', sql]);
const val = (sql, db) => (q(sql, db).stdout || '').trim();

function fresh(db) {
  psql(conn, ['-d', 'postgres', '-c', 'drop database if exists ' + db]);
  return psql(conn, ['-d', 'postgres', '-c', 'create database ' + db]).status === 0;
}
function drop(db) { psql(conn, ['-d', 'postgres', '-c', 'drop database if exists ' + db]); }

/* ------------------------------------------------------------------------ */
try {
  if (!fresh(DB)) skip('could not create the test database');

  /* 1 — IT APPLIES, over site_articles.sql alone, twice. */
  psql(conn, ['-d', DB, '-q', '-f', SHIM]);
  const art = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', ARTICLES]);
  ok('site_articles.sql applies', art.status === 0, art.stderr);

  const first = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('editorial_runtime.sql applies over it', first.status === 0, first.stderr);
  const again = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('and applies a second time unchanged', again.status === 0, again.stderr);

  ok('the settings singleton exists',
    val("select count(*) from public.editorial_settings") === '1');
  ok('a second settings row is impossible',
    q("insert into public.editorial_settings (id) values (2)").status !== 0,
    'a second row was accepted');

  /* IT REFUSES TO INSTALL WITHOUT ITS DEPENDENCY, naming the fix. */
  const BARE = DB + '_bare';
  if (fresh(BARE)) {
    psql(conn, ['-d', BARE, '-q', '-f', SHIM]);
    const noDep = psql(conn, ['-d', BARE, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
    ok('it refuses to install without site_articles.sql', noDep.status !== 0);
    ok('and the error names the file to run first',
      /site_articles\.sql first/.test(noDep.stderr || ''),
      (noDep.stderr || '').split('\n').filter(l => /ERROR/.test(l))[0]);
    drop(BARE);
  }

  /* 2 — THE LEASE IS ATOMIC ACROSS CONNECTIONS.
     Both statements are sent in ONE psql invocation but as separate
     transactions from separate backends would behave identically; the
     guarantee is that the conflict is resolved inside the statement. To make
     it a real concurrency test the two claims run from two separate psql
     processes started together. */
  const raceA = cp.spawn('psql', conn.concat(['-d', DB, '-tAc',
    "select public.editorial_claim('race','A',600)"]), { encoding: 'utf8' });
  const raceB = cp.spawn('psql', conn.concat(['-d', DB, '-tAc',
    "select public.editorial_claim('race','B',600)"]), { encoding: 'utf8' });
  const outs = [];
  const done = new Promise(res => {
    let n = 0;
    [raceA, raceB].forEach(p => {
      let buf = '';
      p.stdout.on('data', d => { buf += d; });
      p.on('close', () => { outs.push(buf.trim()); if (++n === 2) res(); });
    });
  });
  done.then(() => {
    const winners = outs.filter(o => o === 't').length;
    ok('two concurrent processes racing one lease produce exactly one winner',
      winners === 1, 'got ' + JSON.stringify(outs));

    /* 3 — A DEAD WORKER RECOVERS. */
    q("update public.editorial_leases set expires_at = now() - interval '1 minute' where lease_key='race'");
    ok('an expired lease is claimable by another worker',
      val("select public.editorial_claim('race','C',600)") === 't');
    ok('and the new owner is recorded',
      val("select owner from public.editorial_leases where lease_key='race'") === 'C');

    /* the owner may extend its own lease rather than losing it mid-run */
    ok('the holder may re-claim to extend',
      val("select public.editorial_claim('race','C',600)") === 't');
    ok('but a different worker still cannot take a live lease',
      val("select public.editorial_claim('race','D',600)") === 'f');

    /* 4 — A LEASE CANNOT BE STOLEN. */
    ok('releasing a lease you do not hold does nothing',
      val("select public.editorial_release('race','D')") === 'f');
    ok('the real owner can release it',
      val("select public.editorial_release('race','C')") === 't');
    ok('and it is gone',
      val("select count(*) from public.editorial_leases where lease_key='race'") === '0');

    /* 5 — INDEPENDENT WORK RUNS IN PARALLEL. */
    ok('two different games claim independently',
      val("select public.editorial_claim('job:pregame:NFL:A','w1',300)") === 't'
      && val("select public.editorial_claim('job:pregame:NFL:B','w2',300)") === 't');
    ok('and neither blocks the other',
      val("select count(*) from public.editorial_leases where lease_key like 'job:%'") === '2');

    /* a nonsense ttl is refused rather than creating an immortal lease */
    ok('a ttl beyond an hour is refused',
      q("select public.editorial_claim('x','w',99999)").status !== 0);
    ok('and a zero ttl too',
      q("select public.editorial_claim('x','w',0)").status !== 0);

    /* 6 — BAD SETTINGS ARE REFUSED BY THE DATABASE ITSELF. */
    ok('a minimum lead above the normal lead is refused',
      q("update public.editorial_settings set pregame_normal_lead_minutes=20,"
        + " pregame_minimum_publish_lead_minutes=90 where id=1").status !== 0);
    ok('a negative minimum lead is refused',
      q("update public.editorial_settings set pregame_minimum_publish_lead_minutes=-5 where id=1").status !== 0);
    ok('an absurd normal lead is refused',
      q("update public.editorial_settings set pregame_normal_lead_minutes=99999 where id=1").status !== 0);
    ok('a quality floor outside 0-100 is refused',
      q("update public.editorial_settings set quality_floor=140 where id=1").status !== 0);
    ok('equal leads are refused — that would leave no late window',
      q("update public.editorial_settings set pregame_normal_lead_minutes=40,"
        + " pregame_minimum_publish_lead_minutes=40 where id=1").status !== 0);
    ok('a valid change is accepted',
      q("update public.editorial_settings set pregame_normal_lead_minutes=120 where id=1").status === 0);

    /* 7 — EVERY CHANGE IS AUDITED. */
    ok('the change was recorded with both values',
      val("select old_value||'->'||new_value from public.editorial_settings_audit"
        + " where field='pregame_normal_lead_minutes' order by id desc limit 1") === '90->120');
    q("update public.editorial_settings set editorial_enabled=false where id=1");
    ok('the kill switch is audited too',
      val("select old_value||'->'||new_value from public.editorial_settings_audit"
        + " where field='editorial_enabled' order by id desc limit 1") === 'true->false');
    ok('updated_at moves on its own', (function () {
      /* ::text on a boolean is the WORD true, not psql's single-letter t */
      return val("select (updated_at > now() - interval '1 minute')::text"
        + " from public.editorial_settings") === 'true';
    })());
    ok('an update that changes nothing writes no audit row', (function () {
      const before = val("select count(*) from public.editorial_settings_audit");
      q("update public.editorial_settings set quality_floor=quality_floor where id=1");
      return val("select count(*) from public.editorial_settings_audit") === before;
    })());

    /* 8 — RLS. The roles the shim provides behave as the policies intend. */
    q("set role anon");
    ok('anon may read settings',
      psql(conn, ['-d', DB, '-tAc',
        "set role anon; select count(*) from public.editorial_settings"]).status === 0);
    /* AN RLS-FILTERED UPDATE IS NOT AN ERROR. Postgres reports UPDATE 0 and
       exits cleanly, so asserting on the exit code would pass while the row
       was being rewritten. The only honest assertion is that the value did not
       move. */
    ok('anon may NOT write settings', (function () {
      const before = val("select auto_publish_pregame from public.editorial_settings");
      psql(conn, ['-d', DB, '-tAc',
        "set role anon; update public.editorial_settings set auto_publish_pregame = not auto_publish_pregame where id=1"]);
      return val("select auto_publish_pregame from public.editorial_settings") === before;
    })(), 'anon changed a setting');
    ok('anon may read heartbeats',
      psql(conn, ['-d', DB, '-tAc',
        "set role anon; select count(*) from public.editorial_heartbeats"]).status === 0);
    ok('anon may NOT write heartbeats',
      psql(conn, ['-d', DB, '-tAc',
        "set role anon; insert into public.editorial_heartbeats (scheduler_source) values ('manual')"]).status !== 0);

    /* NOBODY BUT THE SERVICE ROLE MAY CLAIM. A signed-in user holding the
       dispatcher lease would stall the publisher for everyone. */
    ok('anon may not claim a lease',
      psql(conn, ['-d', DB, '-tAc',
        "set role anon; select public.editorial_claim('x','x',60)"]).status !== 0);
    ok('an authenticated user may not claim a lease either',
      psql(conn, ['-d', DB, '-tAc',
        "set role authenticated; select public.editorial_claim('x','x',60)"]).status !== 0);
    ok('and may not read the lease table without being an operator', (function () {
      /* `set role` emits SET on stdout before the query result, so the answer
         is the LAST line, not the whole buffer. */
      const held = val("select count(*) from public.editorial_leases");
      const seen = (psql(conn, ['-d', DB, '-tAc',
        "set role authenticated; select count(*) from public.editorial_leases"]).stdout || '')
        .trim().split('\n').pop().trim();
      return Number(held) > 0 && seen === '0';
    })(), 'a non-operator saw lease rows');

    /* the heartbeat source is constrained, so a typo cannot create a
       scheduler the health panel will never grade */
    ok('an unknown scheduler source is refused',
      q("insert into public.editorial_heartbeats (scheduler_source) values ('cronjob')").status !== 0);
    ok('a known one is accepted',
      q("insert into public.editorial_heartbeats (scheduler_source) values ('supabase_cron')").status === 0);

    drop(DB);
    console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | editorial runtime SQL | '
      + pass + ' passed' + (fail ? ', ' + fail + ' failed' : ', 0 failed'));
    if (fail) { failures.forEach(f => console.log('  ×  ' + f)); process.exit(1); }
  });
} catch (e) {
  console.log('FAIL | editorial runtime SQL | ' + (e && e.message));
  drop(DB);
  process.exit(1);
}
