#!/usr/bin/env node
/* ===========================================================================
   College baseball's odds-gateway row, on a real PostgreSQL: registered
   DISABLED, so the gateway refuses baseball_ncaa with `denied_sport` and
   nothing is bought until an operator authorises it; re-applying never
   re-disables an operator's choice.

   Run: node tools/college_baseball/cbase_sql.test.js   (CBASE_SQL_REQUIRED=1 in CI)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const T = PG.kit('college baseball odds sport row');
const ROOT = PG.ROOT;
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'cbase_odds_sport.sql'), 'utf8');
T.chk('the file only inserts, with on conflict do nothing (never disables an enabled row)', /insert into public\.odds_api_sports[\s\S]*on conflict \(sport_key\) do nothing/.test(SQL) && !/\bupdate\b|\bdelete\b|\bdrop\b/i.test(SQL.replace(/--[^\n]*/g, '')));
T.chk('the row is inserted disabled, at the lowest priority', /values \('baseball_ncaa', 'cbase', false, 5,/.test(SQL));
T.chk('the migration is the same file', fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261021200000_cbase_odds_sport_row.sql'), 'utf8') === SQL);
const db = PG.start('cbasesql');
if (db.skip) {
  if (process.env.CBASE_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
try {
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null) returns void language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;`);
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));
  let out = db.applyFile(path.join(ROOT, 'supabase', 'cbase_odds_sport.sql'));
  T.chk('it applies and its report is all ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 2, out);
  db.sql("update public.odds_api_config set odds_api_enabled = true where id = 1");
  const acq = () => JSON.parse(db.sql("select public.odds_api_acquire('{\"caller\":\"cbase_prices\",\"category\":\"featured\",\"sport_key\":\"baseball_ncaa\"}'::jsonb)"));
  let a = acq();
  T.chk('the gateway refuses college baseball while the row is disabled', a.decision === 'denied_sport', a);
  db.sql("select public.odds_api_set_sport('baseball_ncaa', true)");
  a = acq();
  T.chk('once authorised, the refusal is no longer the sport', a.decision !== 'denied_sport', a.decision);
  out = db.applyFile(path.join(ROOT, 'supabase', 'cbase_odds_sport.sql'));
  T.chk('re-applying the file leaves the operator\'s choice alone', db.sql("select enabled from public.odds_api_sports where sport_key = 'baseball_ncaa'") === 't');
} catch (e) { T.chk('the run completed', false, String(e.message).slice(0, 500)); }
finally { db.stop(); }
process.exit(T.done());
