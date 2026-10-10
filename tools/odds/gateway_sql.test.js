#!/usr/bin/env node
/* ===========================================================================
   THE ODDS API CONTROL PLANE, IN SQL — static rules everywhere, a real
   PostgreSQL where one exists.

     supabase/odds_api_emergency_stop.sql   the breaker, the zero budget, the
                                            pause/resume of pg_cron jobs
     supabase/odds_api_gateway.sql          ledger, reservations, cadence,
                                            snapshots, budgets, alerts, grants
     supabase/capture_cron.sql              the capture poke respects the breaker

   The concurrency cases use SEPARATE database sessions released together by
   an advisory-lock barrier, so the row lock odds_api_acquire takes is
   exercised the way overlapping gateway workers exercise it. Permission cases
   connect as a login role `authenticator` and SET ROLE, the way PostgREST does,
   so the gateway's own "privileged caller" rule is tested honestly.

   Run: node tools/odds/gateway_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('odds gateway SQL');
const ROOT = PG.ROOT;
const STOP = fs.readFileSync(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'), 'utf8');
const GW = fs.readFileSync(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'), 'utf8');
const CAPCRON = fs.readFileSync(path.join(ROOT, 'supabase', 'capture_cron.sql'), 'utf8');

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = (sql) => sql.replace(/--[^\n]*/g, ' ');
for (const [name, sqlText] of [['emergency stop', STOP], ['gateway', GW]]) {
  const sql = code(sqlText);
  T.chk(name + ': no psql meta-command (the SQL editor would refuse the paste)', !/^\s*\\/m.test(sql));
  T.chk(name + ': every CREATE TABLE is guarded', !/create table(?!\s+if not exists)/i.test(sql));
  T.chk(name + ': every ADD COLUMN is guarded', !/add column(?!\s+if not exists)/i.test(sql));
  T.chk(name + ': every CREATE INDEX is guarded', !/create (unique )?index(?!\s+if not exists)/i.test(sql));
  T.chk(name + ': nothing is dropped', !/\bdrop\s+(table|column|schema|database)\b/i.test(sql));
  T.chk(name + ': it ends in a report', /case when got = want then 'ok' else 'CHECK THIS' end/.test(sqlText.slice(-1500)));
  T.chk(name + ': no provider host and no key', !/api\.the-odds-api\.com/.test(sql) && !/apiKey=/i.test(sql.replace(/regexp_replace[^\n]*/g, '')));
}
T.chk('emergency stop: under the SQL editor paste limit (18 KB)', Buffer.byteLength(STOP) <= 18000, Buffer.byteLength(STOP));
T.chk('emergency stop: pauses (alter_job active false), never unschedules or deletes a job',
  /cron\.alter_job\(\$1, null, null, null, null, false\)/.test(STOP) && !/cron\.unschedule/.test(STOP) && !/delete from cron/.test(STOP));
T.chk('gateway: the switch row is created OFF (fail closed)', /insert into public\.odds_api_config \(id, odds_api_enabled[^)]*\)\s*values \(1, false/.test(GW));
T.chk('gateway: acquire locks the one config row before deciding (FOR UPDATE)', /from public\.odds_api_config where id = 1 for update;[\s\S]*v_now := clock_timestamp\(\)/.test(GW));
T.chk('gateway: parts exist for the SQL editor', fs.readdirSync(path.join(ROOT, 'supabase', 'parts')).some((f) => /^odds_api_gateway\.part1-of-\d+\.sql$/.test(f)));

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('oddsgwsql');
if (db.skip) {
  /* ODDS_SQL_REQUIRED=1 (CI) makes a missing PostgreSQL a failure, never a silent pass */
  if (process.env.ODDS_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}

const J = (sql) => { const o = db.sql(sql); try { return JSON.parse(o); } catch (_) { return o; } };
const acq = (p) => J("select public.odds_api_acquire('" + JSON.stringify(p).replace(/'/g, "''") + "'::jsonb)");
const settle = (p) => J("select public.odds_api_settle('" + JSON.stringify(p).replace(/'/g, "''") + "'::jsonb)");
/* PostgREST connects as a LOGIN role and switches with SET ROLE */
function asApi(role, sql, sub) {
  const f = path.join(db.home, 'api' + Date.now() + Math.random().toString(36).slice(2) + '.sql');
  fs.writeFileSync(f, "begin; select set_config('request.jwt.claims', '" + JSON.stringify({ role, sub: sub || null }) + "', true) \\g /dev/null\nset local role " + role + ";\n" + sql + "\ncommit;\n");
  cp.execSync('chmod 644 ' + f);
  try {
    return { ok: true, out: cp.execFileSync(path.join(db.bin, 'psql'), ['-h', db.home, '-p', String(db.port), '-U', 'authenticator', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', f], { encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; }
}

try {
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.alter_job(job_id bigint, schedule text default null, command text default null, database text default null, username text default null, active boolean default null)
      returns void language sql as $$ update cron.job set active = coalesce(alter_job.active, cron.job.active) where jobid = job_id $$;
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
    insert into cron.job (jobname, schedule, command) values
      ('capture_near', '*/10 * * * *', 'select public.capture_poke(''near'');'),
      ('capture_day', '4,34 * * * *', 'select public.capture_poke(''day'');'),
      ('player_props_dispatch', '*/5 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/props_cron'')'),
      ('close_every_5', '*/5 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/close'', headers := ''{}'')'),
      ('collective_odds', '*/2 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/collective_odds_ingest/v1/ingest?league=nfl'')'),
      ('legacy_wta_odds', '*/15 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/wta_odds'')'),
      ('settle_hourly', '0 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/settle'')'),
      ('research_state_dispatch', '*/5 * * * *', 'select net.http_post(url := ''https://x.supabase.co/functions/v1/research_cron'')');
    do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
    grant anon, authenticated, service_role to authenticator;`);

  /* ── 1 · the emergency stop ───────────────────────────────────────────── */
  let out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
  T.chk('1 · the emergency stop applies; every report row ok', !/CHECK THIS/.test(out) && (out.match(/\|ok$/gm) || []).length === 4, out.slice(-500));
  const active = (n) => db.sql("select active from cron.job where jobname = '" + n + "'") === 't';
  T.chk('1 · capture, props dispatch, close, collective ingest and a legacy odds function are paused',
    ['capture_near', 'capture_day', 'player_props_dispatch', 'close_every_5', 'collective_odds', 'legacy_wta_odds'].every((n) => !active(n)));
  T.chk('1 · research jobs and the suspect settle job are NOT paused', active('research_state_dispatch') && active('settle_hourly'));
  T.chk('1 · paused jobs are recorded, nothing is deleted', db.sql('select count(*) from public.odds_api_paused_jobs') === '6' && db.sql('select count(*) from cron.job') === '8');
  out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'));
  T.chk('1 · running it twice changes nothing', !/CHECK THIS/.test(out) && db.sql('select count(*) from public.odds_api_paused_jobs') === '6');

  /* ── 2 · the gateway file, twice ─────────────────────────────────────── */
  out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));
  const rows = (o) => (o.match(/\|(ok|CHECK THIS)$/gm) || []);
  T.chk('2 · the gateway applies; every report row ok', rows(out).length === 9 && rows(out).every((r) => /ok$/.test(r)), out.slice(-900));
  out = db.applyFile(path.join(ROOT, 'supabase', 'odds_api_gateway.sql'));
  T.chk('2 · and a second time', rows(out).length === 9 && rows(out).every((r) => /ok$/.test(r)));
  T.chk('2 · the breaker is still OFF and the budget still ZERO after the gateway is applied',
    db.sql('select odds_api_enabled::text || monthly_budget::text || daily_target::text from public.odds_api_config') === 'false00');
  T.chk('2 · the retention job is scheduled, and is not a spend path', db.sql("select count(*) from cron.job where jobname = 'odds_api_prune' and command not like '%functions/v1%'") === '1');

  /* ── 3 · resume: only jobs routed through the gateway ─────────────────── */
  const res = J("select public.odds_api_resume_schedules('test')");
  T.chk('3 · resume restores capture, props dispatch, close and collective ingest', ['capture_near', 'capture_day', 'player_props_dispatch', 'close_every_5', 'collective_odds'].every(active), res);
  T.chk('3 · a legacy function nobody can audit stays paused', !active('legacy_wta_odds') && JSON.stringify(res.kept_paused).indexOf('legacy_wta_odds') >= 0);
  T.chk('3 · resuming schedules does not turn the breaker on', db.sql('select odds_api_enabled from public.odds_api_config') === 'f');

  /* ── 4 · the capture poke honours the breaker ─────────────────────────── */
  db.sql(`create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create table if not exists vault.secrets (name text);
    insert into vault.secrets values ('capture_cron_secret');
    insert into vault.decrypted_secrets values ('capture_cron_secret', 's3cret');
    create schema if not exists net; create table if not exists net.posted (url text);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
      returns bigint language sql as $$ insert into net.posted values (url); select 1::bigint $$;`);
  const capFile = path.join(db.home, 'capcron.sql');
  fs.writeFileSync(capFile, CAPCRON.replace(/^create extension if not exists pg_(cron|net);$/mg, '')); cp.execSync('chmod 644 ' + capFile);
  db.sql(fs.readFileSync(capFile, 'utf8'));
  T.chk('4 · the capture schedule is 20 min / hourly / 6 h', db.sql("select string_agg(schedule, ',' order by jobname) from cron.job where jobname in ('capture_board','capture_day','capture_near')") === '18 */6 * * *,4 * * * *,*/20 * * * *');
  let poke = J("select public.capture_poke('near')");
  T.chk('4 · breaker off: the poke sends nothing', poke.queued === false && db.sql('select count(*) from net.posted') === '0', poke);
  db.sql("update public.odds_api_config set odds_api_enabled = true where id = 1");
  poke = J("select public.capture_poke('near')");
  T.chk('4 · breaker on: the poke wakes capture', poke.queued === true && db.sql('select count(*) from net.posted') === '1', poke);
  db.sql("update public.odds_api_config set odds_api_enabled = false where id = 1");

  /* ── 5 · enabling needs a budget; a budget cannot exceed the plan ─────── */
  T.chk('5 · the breaker cannot be turned on with a zero budget', J("select public.odds_api_set_enabled(true, 'x')").ok === false);
  T.chk('5 · budget + reserve may not exceed the plan', J("select public.odds_api_set_budget(70000, 40000, 1500)").ok === false);
  T.chk('5 · the recovery budget is 60,000 operational, 40,000 reserve, 1,500/day', J("select public.odds_api_apply_recovery_budget()").monthly_budget === 60000
    && db.sql('select monthly_reserve::text || daily_target::text from public.odds_api_config') === '400001500');
  T.chk('5 · a reason is required to turn it on', J("select public.odds_api_set_enabled(true, '  ')").ok === false);
  T.chk('5 · with a budget and a reason it turns on', J("select public.odds_api_set_enabled(true, 'test')").ok === true);
  db.sql("select public.odds_api_confirm_quota(0, 100000, 'test')");
  db.sql("update public.odds_api_config set day_weights = '{\"0\":1,\"1\":1,\"2\":1,\"3\":1,\"4\":1,\"5\":1,\"6\":1}'::jsonb");

  /* ── 6 · single flight under REAL concurrency ─────────────────────────── */
  const barrier = db.background('select pg_advisory_lock(4242); select pg_sleep(1.5); select pg_advisory_unlock(4242);');
  db.sleep(0.3);
  const workers = Array.from({ length: 12 }, (_, i) => db.background("select pg_advisory_lock_shared(4242); select pg_advisory_unlock_shared(4242); select public.odds_api_acquire('{\"caller\":\"w" + i + "\",\"category\":\"featured\",\"sport_key\":\"americanfootball_nfl\"}'::jsonb)->>'decision';"));
  barrier.wait(20000);
  const decided = workers.map((w) => w.wait(20000).out.trim().split('\n').pop());
  T.chk('6 · 12 sessions released together: exactly ONE granted, eleven collapsed into it',
    decided.filter((d) => d === 'granted').length === 1 && decided.filter((d) => d === 'in_flight').length === 11, decided);
  T.chk('6 · and exactly one lease is open', db.sql("select count(*) from public.odds_api_requests where status = 'reserved'") === '1');

  /* ── 7 · the budget holds under REAL concurrency ─────────────────────── */
  db.sql("truncate public.odds_api_requests restart identity; select public.odds_api_set_budget(60000, 0, 100);");
  const b2 = db.background('select pg_advisory_lock(4343); select pg_sleep(1.5); select pg_advisory_unlock(4343);');
  db.sleep(0.3);
  const w2 = Array.from({ length: 16 }, (_, i) => db.background("select pg_advisory_lock_shared(4343); select pg_advisory_unlock_shared(4343); select public.odds_api_acquire('{\"caller\":\"p" + i + "\",\"category\":\"props\",\"sport_key\":\"americanfootball_nfl\",\"event_id\":\"ev" + i + "\",\"commence_time\":\"" + new Date(Date.now() + 2 * 3600e3).toISOString() + "\"}'::jsonb)->>'decision';"));
  b2.wait(20000);
  const d2 = w2.map((w) => w.wait(20000).out.trim().split('\n').pop());
  const reservedTotal = Number(db.sql("select coalesce(sum(reserved_credits), 0) from public.odds_api_requests where status = 'reserved'"));
  T.chk('7 · 16 concurrent prop leases against a 100-credit day: reservations stop at the shedding line (80%)', reservedTotal <= 80 && d2.filter((d) => d === 'granted').length === 7, [reservedTotal, d2]);
  T.chk('7 · every other request was refused by the budget, none by a race', d2.filter((d) => d === 'denied_daily_budget').length === 9, d2);

  /* ── 8 · reconciliation and lease expiry ─────────────────────────────── */
  const lease = Number(db.sql("select min(id) from public.odds_api_requests where status = 'reserved'"));
  const leaseEvent = db.sql('select event_id from public.odds_api_requests where id = ' + lease);
  let s = settle({ request_id: lease, ok: true, http_status: 200, requests_used: 120, requests_remaining: 99880, requests_last: 2, body: { id: 'ev0', commence_time: new Date(Date.now() + 2 * 3600e3).toISOString(), bookmakers: [{ key: 'dk', markets: [{ key: 'player_pass_yds' }, { key: 'player_rush_yds' }] }] } });
  T.chk('8 · settle charges x-requests-last (2), not the reservation (11)', s.actual_credits === 2 && s.cost_is_exact === true, s);
  T.chk('8 · a lease cannot be settled twice', settle({ request_id: lease, ok: true, requests_last: 5 }).ok === false);
  db.sql("update public.odds_api_requests set lease_expires_at = now() - interval '1 second' where status = 'reserved'");
  acq({ caller: 'sweep', category: 'featured', sport_key: 'americanfootball_ncaaf' });
  T.chk('8 · an abandoned lease expires and is charged at its reservation (conservative)',
    db.sql("select count(*) || ':' || sum(actual_credits) from public.odds_api_requests where status = 'expired' and cost_is_exact = false") === '6:66');
  T.chk('8 · the event clock was learned from the settled body, under the lease\'s own event and sport', db.sql("select count(*) from public.odds_api_events where event_id = '" + leaseEvent + "' and sport_key = 'americanfootball_nfl'") === '1', leaseEvent);

  /* ── 9 · shedding order as the day fills ─────────────────────────────── */
  db.sql("truncate public.odds_api_requests, public.odds_api_snapshots restart identity; select public.odds_api_set_budget(60000, 0, 1000);"
    + " insert into public.odds_api_events (event_id, sport_key, commence_time) values ('near_nfl', 'americanfootball_nfl', now() + interval '2 hours'), ('far_cfb', 'americanfootball_ncaaf', now() + interval '100 hours')"
    + " on conflict (event_id) do update set commence_time = excluded.commence_time, last_seen_at = now();");
  const fill = (n) => db.sql("delete from public.odds_api_requests where caller = 'filler'; insert into public.odds_api_requests (cycle_start, usage_day, caller, decision, dispatched, status, reserved_credits, actual_credits) values (public.odds_api_cycle_start(now()), (now() at time zone 'utc')::date, 'filler', 'granted', true, 'settled', " + n + ", " + n + ")");
  const tryAll = () => ({
    alternates: acq({ caller: 't', category: 'alternates', sport_key: 'americanfootball_nfl', event_id: 'near_nfl' }).decision,
    props: acq({ caller: 't', category: 'props', sport_key: 'americanfootball_nfl', event_id: 'near_nfl' }).decision,
    far: acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_ncaaf' }).decision,
    near: acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).decision,
  });
  const clean = () => db.sql("delete from public.odds_api_requests where caller = 't'");
  fill(100); let lv = tryAll(); clean();
  T.chk('9 · level 0: everything enabled is bought', Object.values(lv).every((d) => d === 'granted'), lv);
  fill(650); lv = tryAll(); clean();
  T.chk('9 · level 1 (past 60%): alternate ladders shed first; props and main markets still bought', lv.alternates === 'denied_daily_budget' && lv.props === 'granted' && lv.far === 'granted' && lv.near === 'granted', lv);
  fill(850); lv = tryAll(); clean();
  T.chk('9 · level 2 (past 80%): props and far boards shed; near main markets still bought', lv.props === 'denied_daily_budget' && lv.far === 'denied_daily_budget' && lv.near === 'granted', lv);
  fill(1100); lv = tryAll(); clean();
  T.chk('9 · level 3 (over the allowance): only main markets inside 24 h', lv.near === 'granted' && lv.far === 'denied_daily_budget', lv);
  fill(1300); lv = tryAll(); clean();
  T.chk('9 · level 4 (past the overdraft): nothing paid at all', Object.values(lv).every((d) => d === 'denied_daily_budget'), lv);
  /* the cadence stretches with the level: a near board 30 minutes old is due
     at level 0 (20-minute interval) and still a cache hit at level 2 (x2) */
  db.sql("insert into public.odds_api_snapshots (fingerprint, category, sport_key, endpoint, last_request_id, last_success_at, body) select fingerprint, 'featured', 'americanfootball_nfl', 'odds', id, now() - interval '30 minutes', '[]'::jsonb from public.odds_api_requests where caller = 'filler' limit 0");
  fill(0);
  const fp = acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).fingerprint; clean();
  db.sql("insert into public.odds_api_snapshots (fingerprint, category, sport_key, endpoint, last_request_id, last_success_at, body) values ('" + fp + "', 'featured', 'americanfootball_nfl', 'odds', 1, now() - interval '30 minutes', '[]'::jsonb) on conflict (fingerprint) do update set last_success_at = excluded.last_success_at");
  const atZero = acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).decision; clean();
  fill(850);
  const atTwo = acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).decision; clean();
  T.chk('9 · under pressure the cadence stretches before anything is refused', atZero === 'granted' && atTwo === 'cache_hit', [atZero, atTwo]);
  fill(0);

  /* ── 10 · the monthly picture ────────────────────────────────────────── */
  const st = J('select public.odds_api_budget_state(now())');
  T.chk('10 · the budget state carries the reset date, the thresholds and a projection', st.next_reset && st.warning_at === 30000 && st.critical_at === 48000 && st.emergency_at === 57000
    && 'projected_cycle' in st && st.quota_confirmed === true, st);
  db.sql("update public.odds_api_config set provider_observed_at = date_trunc('month', now()) - interval '1 day' where id = 1");
  T.chk('10 · a quota observed only in the previous cycle is NOT assumed for this one', acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).decision === 'denied_unconfirmed_quota');
  db.sql("select public.odds_api_confirm_quota(0, 100000, 'test')"); clean();
  db.sql("update public.odds_api_config set monthly_reserve = 99999 where id = 1");
  T.chk('10 · the provider reserve is never spent', acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_nfl' }).decision === 'denied_reserve');
  db.sql("update public.odds_api_config set monthly_reserve = 0 where id = 1"); clean();

  /* ── 11 · untracked usage, alerts, redaction ─────────────────────────── */
  db.sql("truncate public.odds_api_requests, public.odds_api_alerts restart identity; update public.odds_api_config set untracked_baseline = null, untracked_baseline_cycle = null;");
  let g = acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_ncaaf' });
  settle({ request_id: g.request_id, ok: true, http_status: 200, requests_used: 1003, requests_remaining: 98997, requests_last: 3, body: [] });
  db.sql("update public.odds_api_snapshots set last_success_at = now() - interval '1 day'");
  g = acq({ caller: 't', category: 'featured', sport_key: 'americanfootball_ncaaf' });
  settle({ request_id: g.request_id, ok: false, http_status: 500, requests_used: 1500, requests_remaining: 98500, requests_last: 0, error: 'HTTP 500 for /odds?apiKey=deadbeefdeadbeef&x=1' });
  T.chk('11 · usage the gateway did not see raises a critical alert', db.sql("select count(*) from public.odds_api_alerts where code = 'untracked_provider_usage' and level = 'critical'") === '1');
  T.chk('11 · an upstream error never stores the key', db.sql("select error from public.odds_api_requests where status = 'failed'").indexOf('deadbeef') < 0
    && /apiKey=REDACTED/.test(db.sql("select error from public.odds_api_requests where status = 'failed'")));
  T.chk('11 · one alert per code per day, however hot the loop', (db.sql("select public.odds_api_alert('warning', 'x', 'a'); select public.odds_api_alert('warning', 'x', 'b'); select count(*) from public.odds_api_alerts where code = 'x'").split('\n').pop()) === '1');

  /* ── 12 · consumer marks, job locks, retention ───────────────────────── */
  T.chk('12 · a consumer sees a snapshot as new exactly once', db.sql("select public.odds_api_consume('capture', 'fp1', 5)") === 't' && db.sql("select public.odds_api_consume('capture', 'fp1', 5)") === 'f'
    && db.sql("select public.odds_api_consume('close', 'fp1', 5)") === 't' && db.sql("select public.odds_api_consume('capture', 'fp1', 6)") === 't');
  T.chk('12 · a job lock admits one holder until it expires', db.sql("select public.odds_api_job_lock('capture:near', 'a', 60)") === 't'
    && db.sql("select public.odds_api_job_lock('capture:near', 'b', 60)") === 'f' && db.sql("select public.odds_api_job_lock('capture:near', 'a', 60)") === 't');
  db.sql("update public.odds_api_job_locks set expires_at = now() - interval '1 second'");
  T.chk('12 · an expired lock is taken over', db.sql("select public.odds_api_job_lock('capture:near', 'b', 60)") === 't');
  db.sql(`insert into public.odds_api_snapshots (fingerprint, event_id, sport_key, category, updated_at, last_success_at) values ('old_ev', 'e1', 'americanfootball_nfl', 'props', now() - interval '10 days', now() - interval '10 days'), ('old_board', null, 'americanfootball_nfl', 'featured', now() - interval '10 days', now() - interval '10 days');
    insert into public.odds_api_requests (created_at, cycle_start, usage_day, caller, decision, dispatched, status) values (now() - interval '30 days', '2026-01-01', '2026-01-01', 'old', 'cache_hit', false, 'not_dispatched'), (now() - interval '30 days', '2026-01-01', '2026-01-01', 'old', 'granted', true, 'settled');`);
  const pr = J('select public.odds_api_prune()');
  T.chk('12 · retention: old event snapshots and old refusals go; the last sport board and the billed ledger stay',
    db.sql("select count(*) from public.odds_api_snapshots where fingerprint = 'old_ev'") === '0' && db.sql("select count(*) from public.odds_api_snapshots where fingerprint = 'old_board'") === '1'
    && db.sql("select count(*) from public.odds_api_requests where caller = 'old' and dispatched") === '1' && db.sql("select count(*) from public.odds_api_requests where caller = 'old' and not dispatched") === '0', pr);

  /* ── 13 · who may call what (as PostgREST connects) ──────────────────── */
  const anonFeed = asApi('anon', "select public.odds_feed_status()->>'state';");
  T.chk('13 · anyone may read the feed status', anonFeed.ok && /^(live|paused|degraded)$/.test(anonFeed.out), anonFeed.out);
  T.chk('13 · anon cannot acquire, settle or read the dashboard', !asApi('anon', "select public.odds_api_acquire('{}'::jsonb);").ok
    && !asApi('anon', "select public.odds_api_settle('{}'::jsonb);").ok && !asApi('anon', 'select public.odds_api_dashboard(7);').ok);
  T.chk('13 · a signed-in reader cannot acquire or read the ledger tables', !asApi('authenticated', "select public.odds_api_acquire('{}'::jsonb);").ok
    && !asApi('authenticated', 'select count(*) from public.odds_api_requests;').ok);
  const notAdmin = asApi('authenticated', 'select public.odds_api_dashboard(7);', '00000000-0000-0000-0000-000000000001');
  T.chk('13 · a signed-in reader who is not an operator is refused the dashboard', !notAdmin.ok && /operators only/.test(notAdmin.out), notAdmin.out.slice(0, 200));
  T.chk('13 · nor may they pause or unpause anything', !asApi('authenticated', "select public.odds_api_admin_pause('x');", '00000000-0000-0000-0000-000000000001').ok
    && !asApi('authenticated', "select public.odds_api_set_enabled(true, 'x');").ok);
  db.sql("create or replace function public.billing_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('request.jwt.claims', true)::jsonb->>'sub', '') = '00000000-0000-0000-0000-0000000000ad' $$;");
  const admin = asApi('authenticated', "select (public.odds_api_dashboard(7))->'budget'->>'next_reset';", '00000000-0000-0000-0000-0000000000ad');
  T.chk('13 · an operator reads the dashboard', admin.ok && /^\d{4}-\d{2}-01/.test(admin.out), admin.out.slice(0, 200));
  const paused = asApi('authenticated', "select public.odds_api_admin_pause('from the dashboard')->>'enabled';", '00000000-0000-0000-0000-0000000000ad');
  T.chk('13 · an operator can PAUSE from the dashboard (turning it on stays a SQL act)', paused.ok && paused.out === 'false' && db.sql('select odds_api_enabled from public.odds_api_config') === 'f', paused.out);
  const svc = asApi('service_role', "select public.odds_api_acquire('{\"caller\":\"svc\",\"category\":\"featured\",\"sport_key\":\"americanfootball_nfl\"}'::jsonb)->>'decision';");
  T.chk('13 · the service role (the gateway) may acquire', svc.ok && svc.out === 'denied_breaker', svc.out);
} catch (e) {
  T.chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
