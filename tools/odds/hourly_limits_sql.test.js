#!/usr/bin/env node
/* ===========================================================================
   supabase/odds_api_hourly_limits.sql — nothing runs or buys more often than
   hourly (2026-10-21).

   STATIC  the file is pasteable (no meta-command, under the SQL editor limit,
           ends in a report) and its schedules agree with the files that
           create the jobs, so neither can bring a faster one back.
   LIVE    on a real PostgreSQL shaped like production on 2026-10-21 — the
           pre-incident schedules (every 10 min, :04 and :34, every 4 h, every 5 min), a
           20-minute purchase band, a close job only the database knows, paused
           legacy jobs, Kalshi and a stats job that must not be touched — it
           slows every paid job to at most hourly, keeps every command and every
           paused/active state, raises the purchase floor to an hour and makes
           the database refuse anything faster, leaves the breaker and budget
           alone, re-runs cleanly, and the emergency stop still pauses it all.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('odds API hourly limits SQL');
const ROOT = PG.ROOT;
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8');
const HOURLY = read('odds_api_hourly_limits.sql');
const STOP = read('odds_api_emergency_stop.sql');
const GW = read('odds_api_gateway.sql');
const CAPCRON = read('capture_cron.sql');
const PROPCRON = read('player_props_cron.sql');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = HOURLY.replace(/--[^\n]*/g, ' ');
T.chk('no psql meta-command (the SQL editor would refuse the paste)', !/^\s*\\/m.test(code));
T.chk('under the SQL editor paste limit (18 KB)', Buffer.byteLength(HOURLY) <= 18000, Buffer.byteLength(HOURLY));
T.chk('it ends in a report', /case when got = want then 'ok' else 'CHECK THIS' end/.test(HOURLY.slice(-1500)));
T.chk('nothing is dropped, unscheduled or deleted', !/\bdrop\s+(table|column|schema|function)\b/i.test(code) && !/cron\.unschedule/.test(code) && !/delete from/i.test(code));
T.chk('it never touches the breaker or the budget', !/odds_api_set_enabled|odds_api_set_budget|update public\.odds_api_config/i.test(code));
T.chk('it never changes a command or an active flag (alter_job with a schedule only)', /cron\.alter_job\(\$1, \$2\)/.test(code) && !/alter_job\([^)]*,[^)]*,[^)]*\)/.test(code));
T.chk('no credential and no provider host', !/eyJ[A-Za-z0-9_-]{20,}/.test(HOURLY) && !/api\.the-odds-api\.com/.test(HOURLY));

/* The schedules here are the ones the job-creating files use. */
const capSched = (tier) => (new RegExp("cron\\.schedule\\('capture_" + tier + "',\\s*'([^']+)'").exec(CAPCRON) || [])[1];
const mine = (job) => (new RegExp("when '" + job + "' then '([^']+)'").exec(HOURLY) || [])[1];
for (const tier of ['near', 'day', 'board']) {
  T.chk('capture_' + tier + ': this file and supabase/capture_cron.sql agree', !!mine('capture_' + tier) && mine('capture_' + tier) === capSched(tier), [mine('capture_' + tier), capSched(tier)]);
}
const propSched = (/'player_props_dispatch',\s*'([^']+)'/.exec(PROPCRON) || [])[1];
T.chk('player_props_dispatch: this file and supabase/player_props_cron.sql agree', !!propSched && mine('player_props_dispatch') === propSched, [mine('player_props_dispatch'), propSched]);
T.chk('the gateway seeds no band under an hour, and carries the same floor', !/\('(featured|close|collective)', '\*', 3, 20\)/.test(GW) && /odds_api_cadence_hourly_floor/.test(GW));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('oddshourly');
if (db.skip) {
  if (process.env.ODDS_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const J = (sql) => { const o = db.sql(sql); try { return JSON.parse(o); } catch (_) { return o; } };
const rows = (o) => (o.match(/\|(ok|CHECK THIS)$/gm) || []);
const jobs = () => J("select jsonb_object_agg(jobname, jsonb_build_object('schedule', schedule, 'command', command, 'active', active)) from cron.job");

try {
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null)
      returns void language sql as $$ update cron.job set schedule = coalesce(alter_job.schedule, cron.job.schedule),
        command = coalesce(alter_job.command, cron.job.command), active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;`);

  /* 1 · the guard: nothing happens before the gateway and the stop exist */
  let refused = '';
  try { db.sql(HOURLY); } catch (e) { refused = String(e.message); }
  T.chk('1 · refuses to run before the gateway is applied, and says which file to apply', /odds_api_gateway\.sql first/.test(refused), refused.slice(0, 200));

  db.sql(STOP);
  db.sql(GW);
  /* production as found on 2026-10-21: the gateway applied before its floor */
  db.sql(`alter table public.odds_api_cadence drop constraint if exists odds_api_cadence_hourly_floor;
    update public.odds_api_cadence set interval_minutes = 20 where category in ('featured', 'close', 'collective') and max_hours_to_start = 3;
    update public.odds_api_config set odds_api_enabled = true, monthly_budget = 60000, monthly_reserve = 40000, daily_target = 1500 where id = 1;
    insert into cron.job (jobname, schedule, command, active) values
      ('capture_near', '*/10 * * * *', 'select public.capture_poke(''near'');', true),
      ('capture_day', '4,34 * * * *', 'select public.capture_poke(''day'');', true),
      ('capture_board', '18 */4 * * *', 'select public.capture_poke(''board'');', true),
      ('player_props_dispatch', '*/5 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/props_cron'')', true),
      ('edgedesk_close', '*/35 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/close'', headers := ''{}''::jsonb)', true),
      ('edgedesk_capture', '5,25,45 9-23 * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/capture?tier=day'')', false),
      ('legacy_wta_odds', '30 seconds', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/wta_odds'')', false),
      ('odds_nightly', '7 3 * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/odds?sport=nfl'')', true),
      ('kalshi_snapshot_5m', '*/5 * * * *', 'select public.kalshi_poke(''snapshot'');', true),
      ('edgedesk_stats_nfl', '*/15 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/stats_nfl'')', true);`);
  const before = jobs();
  const cfgBefore = db.sql('select row_to_json(c)::text from public.odds_api_config c');

  /* 2 · the first run */
  const out = db.sql(HOURLY);
  T.chk('2 · every report row ok (5 rows)', rows(out).length === 5 && rows(out).every((r) => /ok$/.test(r)), out.slice(-900));
  const after = jobs();
  const sched = (n) => after[n] && after[n].schedule;
  T.chk('2 · capture: near hourly, day every 2 h, board every 6 h',
    sched('capture_near') === '12 * * * *' && sched('capture_day') === '4 */2 * * *' && sched('capture_board') === '18 */6 * * *',
    [sched('capture_near'), sched('capture_day'), sched('capture_board')]);
  T.chk('2 · the prop dispatch is hourly', sched('player_props_dispatch') === '38 * * * *', sched('player_props_dispatch'));
  T.chk('2 · a close job only the database knows is slowed to hourly', sched('edgedesk_close') === '27 * * * *', sched('edgedesk_close'));
  T.chk('2 · a paused legacy job keeps its first minute and its hours', sched('edgedesk_capture') === '5 9-23 * * *', sched('edgedesk_capture'));
  T.chk("2 · pg_cron's sub-minute 'seconds' form is slowed too", sched('legacy_wta_odds') === '27 * * * *', sched('legacy_wta_odds'));
  T.chk('2 · a paid job already slower than hourly is left alone', sched('odds_nightly') === '7 3 * * *', sched('odds_nightly'));
  T.chk('2 · Kalshi and stats jobs (no paid path) are untouched',
    JSON.stringify(after.kalshi_snapshot_5m) === JSON.stringify(before.kalshi_snapshot_5m)
    && JSON.stringify(after.edgedesk_stats_nfl) === JSON.stringify(before.edgedesk_stats_nfl));
  T.chk('2 · no command changed', Object.keys(before).every((n) => after[n].command === before[n].command));
  T.chk('2 · no paused/active state changed', Object.keys(before).every((n) => after[n].active === before[n].active));
  T.chk('2 · the breaker and the budget are untouched', db.sql('select row_to_json(c)::text from public.odds_api_config c') === cfgBefore);
  T.chk('2 · no purchase band under an hour; the main markets inside 3 h are 60 min',
    db.sql('select count(*) from public.odds_api_cadence where interval_minutes < 60') === '0'
    && db.sql("select string_agg(distinct interval_minutes::text, ',') from public.odds_api_cadence where category in ('featured', 'close', 'collective') and max_hours_to_start = 3") === '60');
  const floor = (sql) => { try { db.sql(sql); return 'accepted'; } catch (e) { return /odds_api_cadence_hourly_floor/.test(String(e.message)) ? 'refused' : String(e.message).slice(0, 200); } };
  T.chk('2 · the database refuses a faster band, new or edited',
    floor("insert into public.odds_api_cadence (category, sport_group, max_hours_to_start, interval_minutes) values ('props', 'nfl', 1, 15)") === 'refused'
    && floor("update public.odds_api_cadence set interval_minutes = 20 where category = 'featured' and max_hours_to_start = 3") === 'refused');
  T.chk('2 · the gateway still applies on top of the floor (its seed and its report agree)', !/CHECK THIS/.test(db.sql(GW)));

  /* 3 · the helpers */
  const hourly = (s) => db.sql("select public.odds_api_cron_at_most_hourly('" + s + "')") === 't';
  T.chk('3 · at most hourly: one fixed minute or a slow macro', hourly('12 * * * *') && hourly('4 */2 * * *') && hourly('7 3 * * 1') && hourly('@daily') && hourly('@hourly'));
  T.chk('3 · faster than hourly: steps, lists, ranges, wildcards, seconds',
    !hourly('*/10 * * * *') && !hourly('4,34 * * * *') && !hourly('0-30 * * * *') && !hourly('* * * * *') && !hourly('30 seconds') && !hourly('nonsense'));
  T.chk('3 · the anon and signed-in roles cannot run the audit',
    db.sql("select has_function_privilege('anon', 'public.odds_api_schedule_audit()', 'execute') or has_function_privilege('authenticated', 'public.odds_api_schedule_audit()', 'execute')") === 'f');

  /* 4 · a re-run changes nothing and stays ok */
  const out2 = db.sql(HOURLY);
  T.chk('4 · a second run: every report row ok, the same schedules', rows(out2).length === 5 && rows(out2).every((r) => /ok$/.test(r)) && JSON.stringify(jobs()) === JSON.stringify(after), out2.slice(-600));

  /* 5 · a paid job added faster later is reported, then slowed by the next run */
  db.sql("insert into cron.job (jobname, schedule, command, active) values ('rogue_odds', '*/2 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/close'')', true)");
  T.chk('5 · the audit names a paid job that fires more than hourly', (J('select public.odds_api_schedule_audit()').faster_than_hourly || []).join() === 'rogue_odds (*/2 * * * *)');
  const out3 = db.sql(HOURLY);
  T.chk('5 · the next run slows it, and the report is ok again', rows(out3).every((r) => /ok$/.test(r)) && jobs().rogue_odds.schedule === '27 * * * *', jobs().rogue_odds);

  /* 6 · the emergency stop still finds every slowed job */
  db.sql("select public.odds_api_emergency_stop('test: stop again')");
  T.chk('6 · after the stop no paid job is active', db.sql('select public.odds_api_active_spend_jobs()') === '0');
  T.chk('6 · and the Kalshi job still runs', jobs().kalshi_snapshot_5m.active === true);
  T.chk('6 · the stop pauses but never re-speeds a schedule', jobs().capture_near.schedule === '12 * * * *' && jobs().edgedesk_close.schedule === '27 * * * *');
} catch (e) {
  T.chk('the live layer ran without an unexpected error', false, String(e.message || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
