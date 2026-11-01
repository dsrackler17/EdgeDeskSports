#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/games_slate_dispatch.sql on a real PostgreSQL: the half-hourly
   wake-up for games-slate.yml (GitHub runs its own schedule only every few
   hours: docs/research-compare/README.md "Refresh").

   pg_net and pg_cron are stubbed with their real signatures, so the
   assertions are about WHAT IT ASKED GITHUB FOR, recorded, not a live call:
     - it dispatches games-slate.yml on main, with the token only in the header
     - a missing token is reported as no_token, never as success
     - a second poke inside the debounce sends nothing (duplicate refreshes)
     - the file applies twice and leaves one schedule (idempotent)
     - neither anon nor a signed-in reader can call it or read its log

   Needs PostgreSQL binaries (a throwaway cluster, tools/personal/_pg.js);
   prints SKIP and exits 0 without them, unless SLATE_SQL_REQUIRED=1.

   Run: node tools/slate/dispatch_sql.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const FILE = path.join(PG.ROOT, 'supabase', 'games_slate_dispatch.sql');

const db = PG.start('slatecron');
if (!db || db.skip) {
  const why = (db && db.skip) || 'no PostgreSQL';
  if (process.env.SLATE_SQL_REQUIRED === '1') { console.log('FAIL | slate dispatch SQL | ' + why); process.exit(1); }
  console.log('SKIP | slate dispatch SQL | ' + why); process.exit(0);
}
const K = PG.kit('slate dispatch SQL');
let code = 1;
try {
  db.sql(`
    create schema if not exists net; create schema if not exists cron; create schema if not exists vault;
    create table net.sent (id bigserial primary key, url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer);
    create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language plpgsql as $s$
      declare v bigint; begin insert into net.sent (url, body, params, headers, timeout_milliseconds) values (url, body, params, headers, timeout_milliseconds) returning id into v; return v; end $s$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language plpgsql as $s$
      declare v bigint; begin insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid into v; return v; end $s$;
    create function cron.unschedule(job_name text) returns boolean language plpgsql as $s$ begin delete from cron.job where jobname = job_name; return true; end $s$;
    create table vault.decrypted_secrets (name text, decrypted_secret text);`);
  /* the two `create extension` lines cannot succeed against stubs; everything else runs verbatim */
  const sql = fs.readFileSync(FILE, 'utf8').replace(/^create extension if not exists pg_(cron|net);$/gm, '-- (stubbed)');
  const tmp = path.join(db.home, 'dispatch_under_test.sql');
  fs.writeFileSync(tmp, sql); try { require('child_process').execSync('chown postgres ' + tmp); } catch (_) { /* not root */ }
  db.applyFile(tmp); db.applyFile(tmp);
  K.chk('applies twice, leaving one schedule at :12 and :42', db.sql("select count(*) || '|' || min(schedule) from cron.job where jobname = 'games_slate_dispatch'") === '1|12,42 * * * *');

  const poke = () => JSON.parse(db.sql("select public.games_slate_poke('test')::text"));
  let r = poke();
  K.chk('no token: reported as no_token, nothing sent', r.action === 'no_token' && r.ok === false && db.sql('select count(*) from net.sent') === '0', r);

  db.sql("insert into vault.decrypted_secrets values ('edgedesk_gh_token', 'ghp_secret_test')");
  r = poke();
  const sent = JSON.parse(db.sql('select row_to_json(s)::text from net.sent s order by id desc limit 1'));
  K.chk('dispatches games-slate.yml on main', r.action === 'dispatched' && sent.url === 'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/games-slate.yml/dispatches' && sent.body.ref === 'main', { r, sent });
  K.chk('the token travels only in the authorization header: not in the result, the body or the log', sent.headers.authorization === 'Bearer ghp_secret_test'
    && !/ghp_secret_test/.test(JSON.stringify(r)) && !/ghp_secret_test/.test(JSON.stringify(sent.body)) && !/ghp_secret_test/.test(db.sql('select coalesce(string_agg(reason, \' \'), \'\') from public.games_slate_pokes')));

  r = poke();
  K.chk('a second poke inside the debounce sends nothing (a duplicate refresh is a no-op)', r.action === 'debounced' && db.sql('select count(*) from net.sent') === '1', r);
  db.sql("update public.games_slate_pokes set at = now() - interval '11 minutes' where action = 'dispatched'");
  r = poke();
  K.chk('after the debounce it dispatches again', r.action === 'dispatched' && db.sql('select count(*) from net.sent') === '2', r);
  K.chk('every decision is logged', db.sql("select string_agg(action, ',' order by id) from public.games_slate_pokes") === 'no_token,dispatched,debounced,dispatched');

  K.chk('anon cannot call it', !!db.mustFail(() => db.anon("select public.games_slate_poke('x')")));
  K.chk('a signed-in reader cannot call it', !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', "select public.games_slate_poke('x')")));
  K.chk('nobody but the owner reads the log', !!db.mustFail(() => db.anon('select count(*) from public.games_slate_pokes')) && !!db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', 'select count(*) from public.games_slate_pokes')));
  db.sql("update public.games_slate_pokes set at = now() - interval '8 days' where id = 1");
  K.chk('the log keeps a week', db.sql('select public.games_slate_pokes_prune()') === '1');
  code = K.done();
} catch (e) {
  console.log('FAIL | slate dispatch SQL | ' + String(e.message).slice(0, 600));
  code = 1;
} finally { db.stop(); }
process.exit(code);
