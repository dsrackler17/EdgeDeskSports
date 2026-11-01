#!/usr/bin/env node
/* ===========================================================================
   supabase/ncaab_odds_sport.sql — men's college basketball (NCAAB) registered
   with the odds gateway, DISABLED (owner-approved 2026-11-01;
   docs/odds-api-incident-2026-10/METHODOLOGY-2026-11-01-ncaab-lines.md).

   STATIC  the file is pasteable (no meta-command, ends in a report), never
           turns the sport on, never touches the breaker, the budget, the
           categories, a job or any cadence row; its migration mirror is a
           byte copy.
   LIVE    on a real PostgreSQL with the emergency stop and the gateway
           applied: every report row ok, twice; the sport stays disabled (an
           operator's enable is kept); while disabled nothing is bought; once
           enabled, capture (`featured`) and close (`close`) share ONE board
           bought at most hourly inside 24 h of a tip (the '*' bands, the
           approved cost); football's cadence is unchanged; under pressure the
           sport sheds at level 1 with the NBA (priority 4).
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('odds API NCAAB sport SQL');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'ncaab_odds_sport.sql');
const MIRROR = path.join(ROOT, 'supabase', 'migrations', '20261101120000_ncaab_odds_sport_row.sql');
const SQL = fs.readFileSync(FILE, 'utf8');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = SQL.replace(/--[^\n]*/g, ' ');
T.chk('no psql meta-command (the SQL editor would refuse the paste)', !/^\s*\\/m.test(code));
T.chk('it ends in a report', /case when got = want then 'ok' else 'CHECK THIS' end/.test(SQL.slice(-2500)));
T.chk('nothing is dropped, deleted, updated or scheduled', !/\b(drop|delete|update|truncate)\b/i.test(code) && !/cron\./.test(code));
T.chk('it never turns the sport on (the owner\'s switch)', !/odds_api_set_sport|enabled\s*=\s*true/i.test(code));
T.chk('it never touches the breaker, the budget, the categories or the cadence', !/odds_api_set_enabled|odds_api_set_budget|odds_api_config|odds_api_categories|insert into public\.odds_api_cadence/i.test(code));
T.chk('basketball_ncaab is inserted disabled, group ncaab, priority 4, on conflict do nothing',
  /values \('basketball_ncaab', 'ncaab', false, 4,/.test(code) && /on conflict \(sport_key\) do nothing/.test(code));
T.chk('the migration mirror is a byte copy', fs.existsSync(MIRROR) && fs.readFileSync(MIRROR).equals(fs.readFileSync(FILE)));
T.chk('no credential and no provider host', !/eyJ[A-Za-z0-9_-]{20,}/.test(SQL) && !/api\.the-odds-api\.com/.test(SQL));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('oddsncaab');
if (db.skip) {
  if (process.env.ODDS_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const J = (sql) => { const o = db.sql(sql); try { return JSON.parse(o); } catch (_) { return o; } };
const acq = (p) => J("select public.odds_api_acquire('" + JSON.stringify(p).replace(/'/g, "''") + "'::jsonb)");
const rows = (o) => (o.match(/\|(ok|CHECK THIS)$/gm) || []);

try {
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null)
      returns void language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
    grant anon, authenticated, service_role to authenticator;`);
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));
  db.applyFile(path.join(ROOT, 'supabase', 'odds_api_nba_nhl_lines.sql'));
  const cadence = "select string_agg(category || ':' || sport_group || ':' || max_hours_to_start || ':' || coalesce(interval_minutes::text, '-'), ',' order by 1) from public.odds_api_cadence";
  const sportsBefore = db.sql("select string_agg(sport_key || ':' || enabled || ':' || priority, ',' order by sport_key) from public.odds_api_sports where sport_key <> 'basketball_ncaab'");
  const cadBefore = db.sql(cadence);

  /* ── 1 · the file, twice ─────────────────────────────────────────────── */
  let out = db.applyFile(FILE);
  T.chk('1 · it applies; every report row ok', rows(out).length === 11 && rows(out).every((r) => /ok$/.test(r)), out.slice(-1500));
  out = db.applyFile(FILE);
  T.chk('1 · and a second time, with nothing added', rows(out).length === 11 && rows(out).every((r) => /ok$/.test(r))
    && db.sql("select count(*) from public.odds_api_sports where sport_key = 'basketball_ncaab'") === '1');
  T.chk('1 · it is disabled, group ncaab, priority 4', db.sql("select sport_group || ':' || enabled || ':' || priority from public.odds_api_sports where sport_key = 'basketball_ncaab'") === 'ncaab:false:4');
  T.chk('1 · no other sport row and no cadence row changed', db.sql("select string_agg(sport_key || ':' || enabled || ':' || priority, ',' order by sport_key) from public.odds_api_sports where sport_key <> 'basketball_ncaab'") === sportsBefore && db.sql(cadence) === cadBefore);
  T.chk('1 · the breaker is still OFF and the budget still ZERO', db.sql('select odds_api_enabled::text || monthly_budget::text from public.odds_api_config') === 'false0');

  /* ── 2 · what the gateway buys ───────────────────────────────────────── */
  db.sql("select public.odds_api_apply_recovery_budget(); select public.odds_api_set_enabled(true, 'test'); select public.odds_api_confirm_quota(0, 100000, 'test');"
    + " insert into public.odds_api_events (event_id, sport_key, commence_time) values ('ncaab1', 'basketball_ncaab', now() + interval '2 hours'), ('nfl1', 'americanfootball_nfl', now() + interval '2 hours')"
    + " on conflict (event_id) do update set commence_time = excluded.commence_time, last_seen_at = now();");
  const clean = () => db.sql("delete from public.odds_api_requests where caller = 't'");
  const ask = (sport, category) => { const r = acq({ caller: 't', category, sport_key: sport }); clean(); return r; };
  T.chk('2 · while the sport is disabled, nothing is bought (denied_sport) for capture or close',
    ask('basketball_ncaab', 'featured').decision === 'denied_sport' && ask('basketball_ncaab', 'close').decision === 'denied_sport');
  db.sql("select public.odds_api_set_sport('basketball_ncaab', true)");
  const fp = ask('basketball_ncaab', 'featured').fingerprint;
  T.chk('2 · once enabled, capture and close ask for the SAME NCAAB board (one fingerprint)', !!fp && fp === ask('basketball_ncaab', 'close').fingerprint, [fp]);
  const aged = (mins) => db.sql("insert into public.odds_api_snapshots (fingerprint, category, sport_key, endpoint, last_request_id, last_success_at, body) values ('" + fp + "', 'featured', 'basketball_ncaab', 'odds', 1, now() - interval '" + mins + " minutes', '[]'::jsonb) on conflict (fingerprint) do update set last_success_at = excluded.last_success_at");
  aged(30);
  T.chk('2 · 2 h before tip, a board 30 minutes old is served from cache to capture AND to close',
    ask('basketball_ncaab', 'featured').decision === 'cache_hit' && ask('basketball_ncaab', 'close').decision === 'cache_hit');
  aged(65);
  T.chk('2 · at 65 minutes it is bought (hourly inside 24 h: the approved ~2,160 credits a month ceiling)', ask('basketball_ncaab', 'featured').decision === 'granted');
  T.chk('2 · the grant asks for the main board only: h2h, spreads, totals',
    (() => { const r = acq({ caller: 't', category: 'featured', sport_key: 'basketball_ncaab' }); clean(); const u = String(r.provider_url || r.url || JSON.stringify(r)); return /h2h/.test(u) && /spreads/.test(u) && /totals/.test(u) && !/player_|alternate/.test(u); })());
  T.chk('2 · NCAAB props are never bought (the props category has no NCAAB band)', ['props', 'props_extra'].every((c) => ask('basketball_ncaab', c).decision !== 'granted'));
  /* level 1 = past 60% of the day: priority >= 4 is shed (odds_api_gateway.sql, shedding) */
  const fill = Math.round(0.7 * +db.sql("select public.odds_api_budget_state()->>'daily_allowance'"));
  db.sql("insert into public.odds_api_requests (cycle_start, usage_day, caller, decision, dispatched, status, reserved_credits, actual_credits) values (public.odds_api_cycle_start(now()), (now() at time zone 'utc')::date, 'filler', 'granted', true, 'settled', " + fill + ", " + fill + ")");
  aged(240);
  const nbaLike = ask('basketball_ncaab', 'featured').decision;
  db.sql("delete from public.odds_api_requests where caller = 'filler'");
  T.chk('2 · under pressure NCAAB is stretched or shed with the NBA (priority 4), never bought at the full hourly rate', nbaLike !== 'granted', nbaLike);
  db.sql("select public.odds_api_set_sport('basketball_ncaab', false)");
  T.chk('2 · switched off again, nothing is bought', ask('basketball_ncaab', 'featured').decision === 'denied_sport');

  /* ── 3 · an operator's enable is kept ─────────────────────────────────── */
  db.sql("select public.odds_api_set_sport('basketball_ncaab', true)");
  db.applyFile(FILE);
  T.chk('3 · re-applying the file never re-disables a sport an operator enabled', db.sql("select enabled::text from public.odds_api_sports where sport_key = 'basketball_ncaab'") === 'true');
} catch (e) {
  T.chk('the LIVE layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
