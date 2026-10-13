#!/usr/bin/env node
'use strict';
/* ===========================================================================
   supabase/games_slate.sql against a real PostgreSQL.

   The file applies twice (idempotent) the way the SQL editor sends it (one
   raw string, one round trip) and its report says ok on every row. Then, by
   role: the poller (service_role) writes through slate_live_ingest; a visitor
   (anon) reads public_slate_live and nothing else — not the tables, not the
   ingest, not the prices; a signed-in reader without an entitlement gets no
   prices from slate_markets, an entitled one gets the captured events inside
   the window and nothing outside it. The live rules: a game gone from a
   (feed, day) that answered leaves it; an older read never overwrites a newer
   one; a failed read writes no events and keeps the last good read time; a
   malformed id is refused; a window over four days is refused.

   Needs psql and a server: EDGD_PG="-h host -p port -U user", or PGHOST, or
   the socket the repository's other SQL suites use (/var/tmp/edgpg/sock:5433),
   else a throwaway cluster from the runner's own binaries (tools/personal/_pg.js).
   Prints SKIP and exits 0 when none can be had, unless SLATE_SQL_REQUIRED=1.

   Run: node tools/slate/slate_sql.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_slate.sql'), 'utf8');

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) pass++; else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function skip(why) { console.log('SKIP | games slate SQL | ' + why); process.exit(0); }
const have = (b) => cp.spawnSync('sh', ['-c', 'command -v ' + b], { encoding: 'utf8' }).status === 0;
if (!have('psql')) skip('psql is not installed');
const conns = [];
if (process.env.EDGD_PG) conns.push(process.env.EDGD_PG.split(' '));
if (process.env.PGHOST) conns.push([]);
conns.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
const psql = (conn, args, input) => cp.spawnSync('psql', conn.concat(args), { encoding: 'utf8', input });
let conn = null, cluster = null;
for (const c of conns) if (psql(c, ['-d', 'postgres', '-tAc', 'select 1']).status === 0) { conn = c; break; }
/* no server answering (a CI runner): start a throwaway cluster the way the
   repository's other SQL suites do (tools/personal/_pg.js) */
if (!conn) {
  cluster = require(path.join(ROOT, 'tools', 'personal', '_pg.js')).start('slate');
  if (cluster && !cluster.skip) { conn = ['-h', cluster.home, '-p', String(cluster.port), '-U', 'postgres']; process.on('exit', () => cluster.stop()); }
}
if (!conn) { if (process.env.SLATE_SQL_REQUIRED === '1') { console.log('FAIL | games slate SQL | no PostgreSQL (' + (cluster && cluster.skip) + ')'); process.exit(1); } skip('no PostgreSQL answered' + (cluster && cluster.skip ? ' (' + cluster.skip + ')' : '')); }
const DB = 'edgd_slate_' + process.pid;
const drop = () => psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
drop();
if (psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]).status !== 0) skip('cannot create a database');
process.on('exit', drop);

/* one statement string, ON_ERROR_STOP; returns { ok, out, err } */
function run(sql) {
  const r = psql(conn, ['-d', DB, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function as(role, sql, sub) {
  return run('begin; set local role ' + role + ';' + (sub ? " select set_config('request.jwt.claim.sub', '" + sub + "', true);" : '') + ' ' + sql + '; commit;');
}
function json(r) { const lines = r.out.split('\n').filter((l) => /^[{[]/.test(l)); try { return JSON.parse(lines[lines.length - 1]); } catch (_) { return null; } }

/* Supabase's roles and auth.uid(), as the platform provides them */
const boot = run(`
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase's own defaults: every new table and function in public is granted
  -- to the client roles, so the file's revokes are what keeps them out
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;`);
chk('the platform roles exist', boot.ok, boot.err);

/* ── APPLY, AS THE SQL EDITOR DOES ─────────────────────────────────── */
const a1 = run(SQL), a2 = run(SQL);
chk('the file applies as one raw string', a1.ok, a1.err.slice(0, 300));
chk('and again: idempotent', a2.ok, a2.err.slice(0, 300));
const report = a2.out.split('\n').filter((l) => /\|(ok|CHECK THIS)$/.test(l));
chk('its report has eight rows, every one ok', report.length === 8 && report.every((l) => /\|ok$/.test(l)), report);

/* ── THE POLLER WRITES ─────────────────────────────────────────────── */
function evRow(id, status, upd, o) {
  o = o || {};
  return { id, sport: 'nhl', feed: 'nhl:hockey/nhl', sb_day: o.day || '2026-10-13', start_utc: o.start || '2026-10-13T23:00:00Z', status, updated_at: upd,
    event: { id, sport: 'nhl', status, start_utc: o.start || '2026-10-13T23:00:00Z', feed: 'nhl:hockey/nhl', sb_day: o.day || '2026-10-13', home: { name: 'Detroit Red Wings', score: o.hs != null ? o.hs : null }, away: { name: 'New Jersey Devils', score: o.as != null ? o.as : null } },
    market: o.market || null };
}
const feedOk = (day, at) => ({ feed: 'nhl:hockey/nhl', sport: 'nhl', day: day || '2026-10-13', ok: true, fetched_at: at, count: 2 });
const ingest = (evs, feeds, role) => as(role || 'service_role', "select public.slate_live_ingest('" + JSON.stringify(evs).replace(/'/g, "''") + "'::jsonb, '" + JSON.stringify(feeds).replace(/'/g, "''") + "'::jsonb)");
const w1 = ingest([evRow('nhl:espn:1', 'LIVE', '2026-10-13T22:30:00Z', { hs: 2, as: 1 }), evRow('nhl:espn:2', 'SCHEDULED', '2026-10-13T22:30:00Z', { market: { book: 'DraftKings', captured_at: '2026-10-13T22:30:00Z', moneyline: { home: -140, away: 120 } } })], [feedOk('2026-10-13', '2026-10-13T22:30:00Z')]);
chk('the poller writes through slate_live_ingest', w1.ok && /"upserted": 2/.test(w1.out), w1.err || w1.out);

const live = (from, to, role) => json(as(role || 'anon', "select public.public_slate_live('" + from + "', '" + to + "')"));
const r1 = live('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z');
chk('a visitor reads both games, scores and the pregame quote', r1 && r1.events.length === 2 && r1.events.find((e) => e.id === 'nhl:espn:1').home.score === 2
  && r1.events.find((e) => e.id === 'nhl:espn:2').market.book === 'DraftKings', r1);
chk('with the (feed, day) it covered and when', r1 && r1.covered.length === 1 && r1.covered[0].feed === 'nhl:hockey/nhl' && r1.covered[0].day === '2026-10-13');

/* ── WHAT A VISITOR CANNOT DO ──────────────────────────────────────── */
chk('a visitor cannot read the table', /permission denied/.test(as('anon', 'select count(*) from public.slate_live').err));
chk('a visitor cannot write', /permission denied/.test(ingest([], [], 'anon').err));
chk('a signed-in reader cannot write', /permission denied/.test(ingest([], [], 'authenticated').err));
chk('a visitor cannot read prices', /permission denied/.test(as('anon', "select public.slate_markets('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')").err));
const tooLong = live('2026-10-01T00:00:00Z', '2026-10-13T00:00:00Z');
chk('a window over four days is refused', tooLong && /one to four days/.test(tooLong.error) && tooLong.events.length === 0);

/* ── THE LIVE RULES ────────────────────────────────────────────────── */
const w2 = ingest([evRow('nhl:espn:1', 'FINAL', '2026-10-13T22:00:00Z', { hs: 9, as: 9 })], []);
chk('an older read never overwrites a newer one', w2.ok && live('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z').events.find((e) => e.id === 'nhl:espn:1').status === 'LIVE');
const w3 = ingest([evRow('nhl:espn:1', 'LIVE', '2026-10-13T22:45:00Z', { hs: 3, as: 1 })], [feedOk('2026-10-13', '2026-10-13T22:45:00Z')]);
const r3 = live('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z');
chk('a game gone from a day that answered (moved, dropped) leaves it', w3.ok && r3.events.length === 1 && r3.events[0].home.score === 3, r3 && r3.events.map((e) => e.id));
const w4 = ingest([], [{ feed: 'nhl:hockey/nhl', sport: 'nhl', day: '2026-10-13', ok: false, fetched_at: '2026-10-13T23:00:00Z', count: 0, error: '503 from scoreboard' }]);
const r4 = live('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z');
chk('a failed read writes no events, removes none, and keeps the last good read time', w4.ok && r4.events.length === 1 && r4.covered.length === 0 && r4.failed.length === 1
  && r4.failed[0].last_ok_at.indexOf('2026-10-13T22:45') === 0, r4);
chk('a malformed event id is refused', !ingest([evRow('<script>', 'LIVE', '2026-10-13T23:00:00Z')], []).ok);
chk('an unknown status is refused', !ingest([evRow('nhl:espn:7', 'MAYBE', '2026-10-13T23:00:00Z')], []).ok);

/* ── THE SUBSCRIBER'S PRICES ───────────────────────────────────────── */
const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
const m0 = json(as('authenticated', "select public.slate_markets('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')", U));
chk('without the entitlement function nobody is entitled', m0 && m0.entitled === false && m0.events.length === 0, m0);
const setup = run(`
  create or replace function public.edp_entitled(p_user uuid) returns boolean language sql stable as $f$ select p_user = '${U}'::uuid $f$;
  grant execute on function public.edp_entitled(uuid) to authenticated, service_role;`);
chk('an entitlement stub', setup.ok, setup.err);
const m1 = json(as('authenticated', "select public.slate_markets('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')", U));
chk('entitled, with no snapshot store installed: entitled, unavailable, no events', m1 && m1.entitled === true && m1.available === false, m1);
const store = run(`
  create table if not exists public.odds_api_snapshots (fingerprint text primary key, category text, sport_key text, odds_format text, last_success_at timestamptz, body jsonb);
  insert into public.odds_api_snapshots values
   ('f1', 'featured', 'icehockey_nhl', 'decimal', now() - interval '1 hour',
     '[{"id":"in1","sport_key":"icehockey_nhl","commence_time":"2026-10-13T23:00:00Z","home_team":"Detroit Red Wings","away_team":"New Jersey Devils","bookmakers":[{"key":"draftkings","title":"DraftKings","markets":[]}]},
       {"id":"out1","sport_key":"icehockey_nhl","commence_time":"2026-10-20T23:00:00Z","home_team":"A","away_team":"B","bookmakers":[]}]'::jsonb),
   ('f2', 'close', 'icehockey_nhl', 'decimal', now() - interval '1 hour', '[{"id":"close1","commence_time":"2026-10-13T23:00:00Z"}]'::jsonb),
   ('f3', 'featured', 'icehockey_nhl', 'decimal', now() - interval '5 days', '[{"id":"old1","commence_time":"2026-10-13T23:00:00Z"}]'::jsonb);`);
chk('a snapshot store', store.ok, store.err);
const m2 = json(as('authenticated', "select public.slate_markets('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')", U));
chk('an entitled reader gets the featured capture inside the window, nothing outside it, no close and nothing past 72 h',
  m2 && m2.entitled === true && m2.events.length === 1 && m2.events[0].event_id === 'in1' && m2.events[0].bookmakers[0].title === 'DraftKings' && m2.events[0].odds_format === 'decimal', m2);
const m3 = json(as('authenticated', "select public.slate_markets('2026-10-13T05:00:00Z', '2026-10-14T05:00:00Z')", V));
chk('a signed-in reader without the entitlement gets none', m3 && m3.entitled === false && m3.events.length === 0, m3);

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'games slate SQL — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
