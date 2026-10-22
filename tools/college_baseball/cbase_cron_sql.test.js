#!/usr/bin/env node
/* ===========================================================================
   College baseball's primary scheduler (supabase/cbase_cron.sql) on a real
   PostgreSQL: pg_cron asking GitHub to run the college baseball and
   collegiate workflows. pg_cron, pg_net and Vault are stand-ins with the real
   signatures; net.http_post records what it was asked to send, so "nothing
   was dispatched" is a checkable claim.

     - five jobs, none faster than hourly, the price job hourly in season;
     - a missing token dispatches nothing and says so;
     - it starts only its own workflows, the loop only to research;
     - the price job is not woken while the Odds API breaker is off;
     - no browser can call it; re-applying adds nothing.

   Run: node tools/college_baseball/cbase_cron_sql.test.js   (CBASE_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('college baseball scheduler (pg_cron)');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'cbase_cron.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const code = SQL.replace(/--[^\n]*/g, '');

/* ------------------------------------------------------------ the file itself */
const jobs = [...code.matchAll(/\('([a-z_]+)',\s*'([^']+)',\s*\$c\$([\s\S]*?)\$c\$\)/g)].map((m) => ({ name: m[1], schedule: m[2], command: m[3] }));
const byName = Object.fromEntries(jobs.map((j) => [j.name, j]));
T.chk('five jobs: prices, the daily build, the backfill, the weekly rosters, the loop', jobs.length === 5 && ['cbase_prices', 'cbase_build', 'collegiate_backfill', 'collegiate_rosters', 'cbase_loop'].every((n) => byName[n]), jobs.map((j) => j.name));
T.chk('nothing runs more often than hourly (each minute field is one minute)', jobs.every((j) => /^\d{1,2}$/.test(j.schedule.split(' ')[0])), jobs.map((j) => j.schedule));
T.chk('the price job: hourly from 14:00 to 04:59 UTC, February to June', byName.cbase_prices && byName.cbase_prices.schedule === '24 14-23,0-4 * 2-6 *' && /college-baseball-prices\.yml/.test(byName.cbase_prices.command));
T.chk('the loop is only woken to research', byName.cbase_loop && /"mode":"research"/.test(byName.cbase_loop.command) && !/release/.test(jobs.map((j) => j.command).join(' ')));
T.chk('the GitHub backup crons agree with the primary and stay off the hour it runs', (() => {
  const wf = (f) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');
  const prices = wf('college-baseball-prices.yml'); const loop = wf('model-loop-college-baseball.yml'); const bf = wf('collegiate-backfill.yml');
  return /cron: '44 14-22\/2 \* 2-6 \*'/.test(prices) && /cron: '44 0-4\/2 \* 2-6 \*'/.test(prices) && !/\*\/20/.test(prices) && /cron: '13 19 \* \* 4'/.test(loop) && /cron: '17 13 \* \* \*'/.test(bf);
})());

const db = PG.start('cbasecron');
if (db.skip) {
  if (process.env.CBASE_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
try {
  db.sql(`create schema if not exists cron; create schema if not exists net; create schema if not exists vault;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
    create function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
    create table net.sent (id bigserial primary key, url text, body jsonb, headers jsonb, timeout_milliseconds integer);
    create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
      returns bigint language sql as $$ insert into net.sent (url, body, headers, timeout_milliseconds) values (url, body, headers, timeout_milliseconds) returning id $$;
    create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
    create table public.breaker (on_ boolean); insert into public.breaker values (true);
    create function public.odds_api_enabled() returns boolean language sql stable as $$ select on_ from public.breaker $$;`);
  const text = SQL.replace(/^create extension if not exists pg_cron;$/m, '-- (stubbed)').replace(/^create extension if not exists pg_net;$/m, '-- (stubbed)');
  const tmp = path.join(db.home, 'cbase_cron.sql'); fs.writeFileSync(tmp, text); try { require('child_process').execSync('chmod 644 ' + tmp); } catch (_) { /* fine */ }
  let out = db.applyFile(tmp);
  T.chk('it applies; the report says the function and the jobs are ok and the token is pending', /1 cbase_poke[^|]*\|ok/.test(out) && /2 five jobs[^|]*\|ok/.test(out) && /3 the GitHub token[^|]*\|pending/.test(out), out);
  const J = (s) => JSON.parse(db.sql(s));
  const sent = () => +db.sql('select count(*) from net.sent');
  let r = J("select public.cbase_poke('collegiate-backfill.yml')");
  T.chk('no token: nothing dispatched, and it says so (never a quiet success)', r.ok === false && r.action === 'no_token' && sent() === 0, r);

  db.sql("insert into vault.decrypted_secrets values ('edgedesk_gh_token', 'github_pat_test')");
  r = J("select public.cbase_poke('collegiate-backfill.yml')");
  const last = () => J("select jsonb_build_object('url', url, 'body', body, 'headers', headers) from net.sent order by id desc limit 1");
  let L = last();
  T.chk('with the token: the workflow is dispatched on main, with the token and no inputs', r.action === 'dispatched' && sent() === 1 && L.url === 'https://api.github.com/repos/dsrackler17/EdgeDeskSports/actions/workflows/collegiate-backfill.yml/dispatches'
    && L.body.ref === 'main' && JSON.stringify(L.body.inputs) === '{}' && L.headers.authorization === 'Bearer github_pat_test' && L.headers['user-agent'] === 'edgedesk-cbase-cron', L);
  r = J("select public.cbase_poke('model-loop-college-baseball.yml', '{\"mode\":\"research\"}'::jsonb)"); L = last();
  T.chk('the loop is dispatched to research', r.action === 'dispatched' && L.body.inputs.mode === 'research' && /model-loop-college-baseball\.yml/.test(L.url));
  const n = sent();
  r = J("select public.cbase_poke('model-loop-college-baseball.yml', '{\"mode\":\"release\"}'::jsonb)");
  T.chk('the loop is never woken to release (the owner serves a version, by hand)', r.action === 'refused' && sent() === n, r);
  r = J("select public.cbase_poke('editorial.yml')");
  T.chk('another workflow is refused: the token starts only college baseball\'s and the collector\'s', r.action === 'refused' && sent() === n, r);

  db.sql('update public.breaker set on_ = false');
  r = J("select public.cbase_poke('college-baseball-prices.yml')");
  const b = J("select public.cbase_poke('college-baseball-research-build.yml')");
  T.chk('breaker off: the price job is not woken; the build (no odds) still is', r.action === 'paused' && b.action === 'dispatched' && sent() === n + 1, [r, b]);
  db.sql('update public.breaker set on_ = true');
  r = J("select public.cbase_poke('college-baseball-prices.yml')");
  T.chk('breaker on: the price job is woken', r.action === 'dispatched' && /college-baseball-prices\.yml/.test(last().url));

  const anon = db.mustFail(() => db.anon("select public.cbase_poke('collegiate-backfill.yml')"));
  const auth = db.mustFail(() => db.as('00000000-0000-0000-0000-000000000001', "select public.cbase_poke('collegiate-backfill.yml')"));
  const rep = db.mustFail(() => db.anon('select * from public.cbase_cron_report()'));
  T.chk('no browser can call it (anon and signed-in readers refused), nor its report', /permission denied/.test(anon || '') && /permission denied/.test(auth || '') && /permission denied/.test(rep || ''), [anon, auth, rep]);

  out = db.applyFile(tmp);
  T.chk('re-applying replaces the jobs (five, not ten) and the report now finds the token', +db.sql('select count(*) from cron.job') === 5 && /3 the GitHub token[^|]*\|ok/.test(out), out);
  T.chk('the jobs call only cbase_poke', J("select jsonb_agg(command) from cron.job").every((c) => /^select public\.cbase_poke\('/.test(c)));
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 600)); }
finally { db.stop(); }
process.exit(T.done());
