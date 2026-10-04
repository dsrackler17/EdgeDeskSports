#!/usr/bin/env node
/* ============================================================================
   supabase/cfb_terminal_analytics.sql against a REAL PostgreSQL.

   Applies the Supabase shim, a stand-in growth_is_admin(), and the shipped
   file unmodified — twice (idempotent) — reads the file's own report, and then
   attacks it as anon: a direct insert, a read, a forged event name, an
   oversized field, the rate limit, and the admin roll-ups.

     EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node football/cfb_terminal/analytics_sql.test.js

   SKIPs (exit 0) when no PostgreSQL is reachable; CI runs it in
   .github/workflows/cfb-terminal.yml with a postgres service.
   ========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCHEMA = path.join(ROOT, 'supabase', 'cfb_terminal_analytics.sql');
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_cfb_terminal_sqltest';
const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
const psql = (conn, args) => cp.spawnSync('psql', conn.concat(args), { encoding: 'utf8' });
function skip(why) { console.log('SKIP | cfb terminal analytics SQL | ' + why); process.exit(0); }
if (!have('psql')) skip('psql is not installed');
const cands = [];
if (process.env.EDGD_PG) cands.push(process.env.EDGD_PG.split(' '));
if (process.env.PGHOST) cands.push([]);
cands.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'], []);
let conn = null;
for (const c of cands) if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); } };
const q = (sql, role) => {
  const pre = role ? 'set role ' + role + '; ' : '';
  const r = psql(conn, ['-d', DB, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', pre + sql]);
  const lines = (r.stdout || '').trim().split('\n').filter((l) => l && l !== 'SET');
  return { ok: r.status === 0, out: lines.length ? lines[lines.length - 1] : '', err: (r.stderr || '').trim() };
};
psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('could not create the test database');
let code = 0;
try {
  const shim = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SHIM]);
  ok('the Supabase shim applies', shim.status === 0, shim.stderr);
  q("create or replace function public.growth_is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), '') = 'yes' $$; grant execute on function public.growth_is_admin() to anon, authenticated;");
  const a1 = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SCHEMA]);
  ok('the file applies', a1.status === 0, a1.stderr);
  const a2 = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '|', '-f', SCHEMA]);
  ok('and applies twice (idempotent)', a2.status === 0, a2.stderr);
  const bad = (a2.stdout || '').split('\n').filter((l) => /^\d+\|/.test(l) && !/\|ok/.test(l));
  ok('its own report is all ok', bad.length === 0, bad.join('; '));

  ok('anon may track a valid event', q("select public.cfb_terminal_track('vtest0001','game_open','401858472','f',null)", 'anon').out === 't');
  ok('the row landed', q('select count(*) from public.cfb_terminal_events').out === '1');
  ok('anon may NOT insert directly', !q("insert into public.cfb_terminal_events(visitor,event) values ('vtest0001','ask')", 'anon').ok);
  ok('anon may NOT read the table', !q('select count(*) from public.cfb_terminal_events', 'anon').ok);
  ok('authenticated may NOT read the table', !q('select count(*) from public.cfb_terminal_events', 'authenticated').ok);
  ok('a forged event name is refused', q("select public.cfb_terminal_track('vtest0001','bet_placed',null,null,null)", 'anon').out === 'f');
  ok('a bad visitor id is refused', q("select public.cfb_terminal_track('x','ask',null,null,null)", 'anon').out === 'f');
  q("select public.cfb_terminal_track('vtest0002','ask','" + 'g'.repeat(40) + "','" + 's'.repeat(40) + "','" + 'd'.repeat(400) + "')", 'anon');
  ok('oversized fields are clipped, not stored whole', q("select max(char_length(detail)) <= 120 and max(char_length(game_id)) <= 24 from public.cfb_terminal_events where visitor='vtest0002'").out === 't');
  q("select public.cfb_terminal_track('vtest0003','board_view',null,null,null) from generate_series(1,130)", 'anon');
  ok('a visitor is rate-limited to 120 an hour', q("select count(*) from public.cfb_terminal_events where visitor='vtest0003'").out === '120');
  ok('the roll-up returns nothing to a non-admin', q('select count(*) from public.cfb_terminal_usage(28)', 'authenticated').out === '0');
  ok('the roll-up counts for an admin', Number(q("set test.admin = 'yes'; select sum(events) from public.cfb_terminal_usage(28)").out) >= 122);
  ok('anon may not call the roll-up', !q('select * from public.cfb_terminal_usage(28)', 'anon').ok);
  ok('the return-rate roll-up runs for an admin', q("set test.admin = 'yes'; select visitors from public.cfb_terminal_return_rate(28)").ok);
  ok('the table carries no identity columns', q("select count(*) from information_schema.columns where table_name='cfb_terminal_events' and column_name in ('user_id','ip','user_agent','email')").out === '0');
} catch (e) { console.error('harness error: ' + (e && e.stack || e)); code = 1; }
finally { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
console.log((fail || code ? 'FAIL' : 'PASS') + ' | cfb terminal analytics SQL | ' + pass + ' passed, ' + fail + ' failed against a real PostgreSQL');
process.exit(fail || code ? 1 : 0);
