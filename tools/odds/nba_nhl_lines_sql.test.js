#!/usr/bin/env node
/* ===========================================================================
   supabase/odds_api_nba_nhl_lines.sql — NBA and NHL game lines every two
   hours (owner-approved 2026-10-29; METHODOLOGY-2026-10-29-nba-nhl-lines.md).

   STATIC  the file is pasteable (no meta-command, ends in a report), never
           turns a league on, never touches the breaker, the budget, a job or
           another sport's cadence, and registers each league exactly as its
           own file does (disabled, priority 4).
   LIVE    on a real PostgreSQL with the emergency stop and the gateway
           applied: every report row ok, twice; the leagues stay disabled
           (an enabled one stays enabled); the gateway buys an NBA or NHL
           board at most every two hours whether capture (`featured`) or close
           (`close`) asks, while football still buys hourly; under pressure the
           band stretches; an operator's edit is kept and reported.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('odds API NBA/NHL lines SQL');
const ROOT = PG.ROOT;
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase', f), 'utf8');
const LINES = read('odds_api_nba_nhl_lines.sql');
const NBA = read('nba_odds_sport.sql');
const NHL = read('nhl_odds_sport.sql');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = LINES.replace(/--[^\n]*/g, ' ');
T.chk('no psql meta-command (the SQL editor would refuse the paste)', !/^\s*\\/m.test(code));
T.chk('it ends in a report', /case when got = want then 'ok' else 'CHECK THIS' end/.test(LINES.slice(-2500)));
T.chk('nothing is dropped, deleted, updated or unscheduled', !/\b(drop|delete|update|truncate)\b/i.test(code) && !/cron\./.test(code));
T.chk('it never turns a league on (the owner\'s switch, after the November reset)', !/odds_api_set_sport|enabled\s*=\s*true/i.test(code));
T.chk('it never touches the breaker, the budget or the categories', !/odds_api_set_enabled|odds_api_set_budget|odds_api_config|odds_api_categories/i.test(code));
const cadenceRows = code.match(/\('\w+',\s*'\w+',\s*\d+,\s*\d+\)/g) || [];
T.chk('it adds cadence rows only for featured and close, and only for the nba and nhl groups',
  cadenceRows.length === 16 && cadenceRows.every((m) => /^\('(featured|close)',\s*'(nba|nhl)'/.test(m)), cadenceRows);
T.chk('no band under the hourly floor', (code.match(/'(nba|nhl)',\s*\d+,\s*(\d+)\)/g) || []).every((m) => Number(/(\d+)\)$/.exec(m)[1]) >= 60));
const sportRow = (sql, key) => (new RegExp("\\('" + key + "',\\s*'(\\w+)',\\s*(true|false),\\s*(\\d+)").exec(sql.replace(/--[^\n]*/g, ' ')) || []).slice(1).join('|');
T.chk('basketball_nba is registered exactly as nba_odds_sport.sql does', sportRow(LINES, 'basketball_nba') === 'nba|false|4' && sportRow(NBA, 'basketball_nba') === 'nba|false|4', [sportRow(LINES, 'basketball_nba'), sportRow(NBA, 'basketball_nba')]);
T.chk('icehockey_nhl is registered exactly as nhl_odds_sport.sql does', sportRow(LINES, 'icehockey_nhl') === 'nhl|false|4' && sportRow(NHL, 'icehockey_nhl') === 'nhl|false|4', [sportRow(LINES, 'icehockey_nhl'), sportRow(NHL, 'icehockey_nhl')]);
T.chk('no credential and no provider host', !/eyJ[A-Za-z0-9_-]{20,}/.test(LINES) && !/api\.the-odds-api\.com/.test(LINES));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('oddsnbanhl');
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
  db.applyFile(path.join(ROOT, 'supabase', 'nhl_odds_sport.sql'));   // production may hold one league's row already
  db.sql("update public.odds_api_sports set enabled = true where sport_key = 'icehockey_nhl'");   // …and an operator may have enabled it
  const others = "select string_agg(category || ':' || sport_group || ':' || max_hours_to_start || ':' || coalesce(interval_minutes::text, '-'), ',' order by 1) from public.odds_api_cadence where not (sport_group in ('nba', 'nhl') and category in ('featured', 'close'))";
  const before = db.sql(others);

  /* ── 1 · the file, twice ─────────────────────────────────────────────── */
  let out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_nba_nhl_lines.sql'));
  T.chk('1 · it applies; every report row ok', rows(out).length === 19 && rows(out).every((r) => /ok$/.test(r)), out.slice(-1500));
  out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_nba_nhl_lines.sql'));
  T.chk('1 · and a second time, with nothing added', rows(out).length === 19 && rows(out).every((r) => /ok$/.test(r))
    && db.sql("select count(*) from public.odds_api_cadence where sport_group in ('nba', 'nhl') and category in ('featured', 'close')") === '16');
  T.chk('1 · no other cadence row changed (nba_role_props\' nba rows included)', db.sql(others) === before && /nba_role_props:nba/.test(before));
  T.chk('1 · the NBA stays disabled; the NHL an operator enabled stays enabled; both priority 4',
    db.sql("select string_agg(sport_key || ':' || enabled || ':' || priority, ',' order by sport_key) from public.odds_api_sports where sport_key in ('basketball_nba', 'icehockey_nhl')") === 'basketball_nba:false:4,icehockey_nhl:true:4');
  T.chk('1 · the breaker is still OFF and the budget still ZERO', db.sql('select odds_api_enabled::text || monthly_budget::text from public.odds_api_config') === 'false0');

  /* ── 2 · what the gateway buys ───────────────────────────────────────── */
  db.sql("select public.odds_api_apply_recovery_budget(); select public.odds_api_set_enabled(true, 'test'); select public.odds_api_confirm_quota(0, 100000, 'test');"
    + " update public.odds_api_sports set enabled = true where sport_key = 'basketball_nba';"
    + " insert into public.odds_api_events (event_id, sport_key, commence_time) values ('nba1', 'basketball_nba', now() + interval '2 hours'), ('nhl1', 'icehockey_nhl', now() + interval '10 hours'), ('nfl1', 'americanfootball_nfl', now() + interval '2 hours')"
    + " on conflict (event_id) do update set commence_time = excluded.commence_time, last_seen_at = now();");
  const clean = () => db.sql("delete from public.odds_api_requests where caller = 't'");
  const fpOf = (sport, category) => { const r = acq({ caller: 't', category, sport_key: sport }); clean(); return r.fingerprint; };
  const aged = (fp, sport, mins) => db.sql("insert into public.odds_api_snapshots (fingerprint, category, sport_key, endpoint, last_request_id, last_success_at, body) values ('" + fp + "', 'featured', '" + sport + "', 'odds', 1, now() - interval '" + mins + " minutes', '[]'::jsonb) on conflict (fingerprint) do update set last_success_at = excluded.last_success_at");
  const ask = (sport, category) => { const d = acq({ caller: 't', category, sport_key: sport }).decision; clean(); return d; };
  const nbaFp = fpOf('basketball_nba', 'featured');
  T.chk('2 · capture and close ask for the same NBA board (one fingerprint, so one cadence must hold for both)', !!nbaFp && nbaFp === fpOf('basketball_nba', 'close'), [nbaFp]);
  aged(nbaFp, 'basketball_nba', 90);
  T.chk('2 · NBA, 2 h before tip: a board 90 minutes old is served from cache to capture AND to close',
    ask('basketball_nba', 'featured') === 'cache_hit' && ask('basketball_nba', 'close') === 'cache_hit');
  aged(nbaFp, 'basketball_nba', 117);
  T.chk('2 · …and at 117 minutes', ask('basketball_nba', 'featured') === 'cache_hit' && ask('basketball_nba', 'close') === 'cache_hit');
  aged(nbaFp, 'basketball_nba', 119);
  T.chk('2 · at two hours (less the scheduler\'s 2-minute slack) it is bought', ask('basketball_nba', 'featured') === 'granted');
  const nhlFp = fpOf('icehockey_nhl', 'featured');
  aged(nhlFp, 'icehockey_nhl', 90);
  T.chk('2 · NHL, 10 h before the first faceoff: 90 minutes old is a cache hit; 119 is bought',
    ask('icehockey_nhl', 'close') === 'cache_hit' && (aged(nhlFp, 'icehockey_nhl', 119), ask('icehockey_nhl', 'close')) === 'granted');
  const nflFp = fpOf('americanfootball_nfl', 'featured');
  aged(nflFp, 'americanfootball_nfl', 90);
  T.chk('2 · football is unchanged: an NFL board 90 minutes old, 2 h before kickoff, is bought (hourly)', ask('americanfootball_nfl', 'featured') === 'granted');
  /* level 1 = past 60% of the day: the band stretches (x1.5), it is not refused first.
     The filler is 70% of the gateway's own daily allowance, which day_weights scale
     by weekday (Sat 1.6: 2,400); a fixed 950 sat under 60% at the weekend */
  const fill = Math.round(0.7 * +db.sql("select public.odds_api_budget_state()->>'daily_allowance'"));
  db.sql("insert into public.odds_api_requests (cycle_start, usage_day, caller, decision, dispatched, status, reserved_credits, actual_credits) values (public.odds_api_cycle_start(now()), (now() at time zone 'utc')::date, 'filler', 'granted', true, 'settled', " + fill + ", " + fill + ")");
  aged(nbaFp, 'basketball_nba', 150);
  const stretched = ask('basketball_nba', 'featured');
  db.sql("delete from public.odds_api_requests where caller = 'filler'");
  T.chk('2 · under pressure the two-hour band stretches like every other (150 minutes old, past 60% of the day: cache)', stretched === 'cache_hit', stretched);
  db.sql("update public.odds_api_sports set enabled = false where sport_key = 'basketball_nba'");
  T.chk('2 · with the league switched off, nothing is bought whatever the cadence', ask('basketball_nba', 'featured') === 'denied_sport');

  /* ── 3 · an operator's edit is kept, and reported ────────────────────── */
  db.sql("update public.odds_api_cadence set interval_minutes = 60 where category = 'close' and sport_group = 'nhl' and max_hours_to_start = 3");
  out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_nba_nhl_lines.sql'));
  T.chk('3 · a band an operator changed is not overwritten, and the report says CHECK THIS for exactly that row',
    db.sql("select interval_minutes from public.odds_api_cadence where category = 'close' and sport_group = 'nhl' and max_hours_to_start = 3") === '60'
    && rows(out).filter((r) => /CHECK THIS$/.test(r)).length === 1 && /nhl close, next start 1 h away[^\n]*\|60\|120\|CHECK THIS/.test(out), out.slice(-1500));
} catch (e) {
  T.chk('the LIVE layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
