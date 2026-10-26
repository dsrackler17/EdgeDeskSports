#!/usr/bin/env node
/* ===========================================================================
   supabase/sharp_lag.sql on a real PostgreSQL (the repo's Supabase shim: roles
   anon / authenticated / service_role, auth.uid()).
     apply      twice, every report row ok; static file rules
     append     every table refuses update, delete and truncate (service role
                and owner too); a price snapshot read twice is stored once
     access     no client reads a table directly
     cron       the free job every 10 minutes and never a spend path; no secret,
                no call
     config     every switch change is logged, append-only; the rules frozen
   Run: node tools/sharp_lag/sharp_lag_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('sharp lag SQL');
const ROOT = PG.ROOT;
const FILE = path.join(ROOT, 'supabase', 'sharp_lag.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
const MIG = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /_sharp_lag\.sql$/.test(f));

/* ═══ STATIC ═════════════════════════════════════════════════════════════ */
const code = SQL.replace(/--[^\n]*/g, ' ');
T.chk('static: no psql meta-command', !/^\s*\\/m.test(code));
T.chk('static: every CREATE TABLE / INDEX / ADD COLUMN is guarded', !/create table(?!\s+if not exists)/i.test(code) && !/create (unique )?index(?!\s+if not exists)/i.test(code) && !/add column(?!\s+if not exists)/i.test(code));
T.chk('static: nothing is dropped but triggers being re-created', !/\bdrop\s+(table|column|schema|view|function)\b/i.test(code));
T.chk('static: it ends in a report', /'CHECK THIS'/.test(SQL.slice(-3000)));
T.chk('static: it never names the odds provider or a key', !/the-odds-api\.com|apiKey=|ODDS_API_KEY/i.test(SQL));
T.chk('static: the migration mirror is the same file', MIG.length === 1 && fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', MIG[0]), 'utf8') === SQL, MIG);

/* ═══ LIVE ═══════════════════════════════════════════════════════════════ */
const db = PG.start('sharplagsql');
if (db.skip) {
  if (process.env.SHARP_LAG_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip + ' — the LIVE layer did not run'); process.exit(T.done());
}
const SUB = '00000000-0000-0000-0000-00000000000a', NOSUB = '00000000-0000-0000-0000-00000000000b';
const J = (s) => { const o = s; try { return JSON.parse(o); } catch (_) { return o; } };
const refused = (fn, re) => { const m = db.mustFail(fn); return m !== null && (!re || re.test(m)); };
const iso = (min) => new Date(Date.now() + min * 60000).toISOString();

try {
  db.sql(`create or replace function public.has_active_sub() returns boolean language sql stable as $$ select auth.uid() = '${SUB}'::uuid $$;
    grant execute on function public.has_active_sub() to authenticated;`);
  let out = db.applyFile(FILE);
  const rows = (o) => (o.match(/\|(ok|CHECK THIS[^\n]*)$/gm) || []);
  const REPORT_ROWS = 4;
  T.chk('apply: every report row ok', rows(out).length === REPORT_ROWS && rows(out).every((r) => /\|ok$/.test(r)), out.slice(-800));
  out = db.applyFile(FILE);
  T.chk('apply: and a second time, with the switches left as they were', rows(out).length === REPORT_ROWS && rows(out).every((r) => /\|ok$/.test(r))
    && db.sql("select value from public.sharp_lag_config where key = 'dispatch'") === 'shadow' && db.sql("select value from public.sharp_lag_config where key = 'public_display'") === 'off');

  /* ── append-only ─────────────────────────────────────────────────────── */
  const price = (req, side, dec) => `insert into public.sharp_price_snapshots (captured_at, source_request_id, source_category, sport_key, event_id, home_team, away_team, commence_time, book, market, side, point, price_dec)
    values (now() - interval '5 minutes', ${req}, 'featured', 'americanfootball_nfl', 'ev1', 'Philadelphia Eagles', 'Dallas Cowboys', now() + interval '4 hours', 'pinnacle', 'h2h', '${side}', null, ${dec})
    on conflict (source_request_id, event_id, book, market, side, participant_key, point_key) do nothing;`;
  db.service(price(1, 'Philadelphia Eagles', 1.6) + price(1, 'Dallas Cowboys', 2.5) + price(1, 'Dallas Cowboys', 2.5));
  T.chk('append: a snapshot read twice is stored once (the unique key, null point included)', db.sql('select count(*) from public.sharp_price_snapshots') === '2');
  const SEALED = ['sharp_price_snapshots', 'sharp_lag_runs', 'sharp_lag_config_log'];
  for (const t of ['sharp_price_snapshots', 'sharp_lag_config_log']) {
    const col = t === 'sharp_price_snapshots' ? 'book' : 'key';
    T.chk('append: ' + t + ' refuses UPDATE: the service role has no UPDATE grant, and the trigger refuses even the owner', refused(() => db.service('update public.' + t + ' set ' + col + ' = ' + col + ';'))
      && refused(() => db.sql('update public.' + t + ' set ' + col + ' = ' + col + ';'), /append-only/));
    T.chk('append: ' + t + ' refuses DELETE (the owner too)', refused(() => db.service('delete from public.' + t + ';')) && refused(() => db.sql('delete from public.' + t + ';'), /append-only/));
    T.chk('append: ' + t + ' refuses TRUNCATE', refused(() => db.sql('truncate public.' + t + ';'), /append-only/));
  }
  T.chk('append: a price must be a real decimal price', refused(() => db.service(price(2, 'X', 1.0))));

  T.chk('append: every sealed table carries both guards', SEALED.every((t) => db.sql("select count(*) from pg_trigger where tgname in ('" + t + "_frozen', '" + t + "_no_truncate')") === '2'));
  /* ── access ──────────────────────────────────────────────────────────── */
  const tables = SEALED.concat(['sharp_lag_config']);
  T.chk('access: anon reads no table directly', tables.every((t) => refused(() => db.anon('select count(*) from public.' + t + ';'), /permission denied/)));
  /* ── cron ────────────────────────────────────────────────────────────── */
  db.sql(`create schema if not exists cron;
    create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = job_id returning true $$;
    create schema if not exists vault; create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
    create schema if not exists net; create table if not exists net.posted (url text);
    create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
      returns bigint language sql as $$ insert into net.posted values (url); select 1::bigint $$;`);
  const CRON = path.join(ROOT, 'supabase', 'sharp_lag_cron.sql');
  out = db.applyFile(CRON); db.applyFile(CRON);
  T.chk('cron: the free job is scheduled every 10 minutes, once however often the file runs', db.sql("select count(*) || ':' || max(schedule) from cron.job where jobname = 'sharp_lag'") === '1:*/10 * * * *');
  T.chk('cron: no secret, no call: the run is recorded as an error and nothing is sent', JSON.parse(db.sql('select public.sharp_lag_poke()')).queued === false
    && db.sql('select count(*) from net.posted') === '0' && db.sql("select count(*) from public.sharp_lag_runs where status = 'error' and details->>'code' = 'no_cron_secret'") === '1');
  db.sql("insert into vault.decrypted_secrets values ('sharp_lag_cron_secret', 's1'), ('sharp_check_cron_secret', 's2')");
  T.chk('cron: with the secret the free job is called', JSON.parse(db.sql('select public.sharp_lag_poke()')).queued === true && db.sql("select count(*) from net.posted where url like '%/functions/v1/sharp_lag'") === '1');
  const STOP = fs.readFileSync(path.join(ROOT, 'supabase', 'odds_api_emergency_stop.sql'), 'utf8');
  const spend = (STOP.match(/function public\.odds_api_spend_patterns\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/) || [])[1] || '';
  const patterns = (spend.match(/'((?:[^']|'')*)'/g) || []).map((q) => q.slice(1, -1).replace(/''/g, "'"));
  const like = (cmd, pat) => new RegExp('^' + pat.split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(cmd);
  T.chk('cron: the free job\'s command matches no spend pattern (it may run every 10 minutes)', patterns.length > 10 && !patterns.some((pt) => like(db.sql("select command from cron.job where jobname = 'sharp_lag'"), pt)));
  T.chk('cron: no client may poke', refused(() => db.anon('select public.sharp_lag_poke();'), /permission denied/));

  /* ── config ──────────────────────────────────────────────────────────── */
  db.sql("update public.sharp_lag_config set value = 'live', note = 'test' where key = 'dispatch'; update public.sharp_lag_config set value = 'shadow' where key = 'dispatch';");
  T.chk('config: every switch change is logged with old and new values', db.sql("select string_agg(coalesce(old_value, '-') || '>' || new_value, ',' order by id) from public.sharp_lag_config_log where key = 'dispatch'") === '->shadow,shadow>live,live>shadow');
  T.chk('config: the log is append-only', refused(() => db.sql('delete from public.sharp_lag_config_log;'), /append-only/));
  T.chk('config: the rules are frozen in a function', db.sql("select public.sharp_lag_rule('gap_pp')::text || ',' || public.sharp_lag_rule('close_max_lead_min')::text || ',' || public.sharp_lag_rule('validation_min_graded')::text") === '2.5,90,200');
} catch (e) {
  T.chk('the live layer ran without an unexpected error', false, String(e && e.stack || e).slice(0, 900));
} finally {
  db.stop();
}
process.exit(T.done());
