#!/usr/bin/env node
/* ===========================================================================
   NFL MARKET STRUCTURE — the SQL, run against a real PostgreSQL.

   supabase/nfl_market_structure.sql is applied UNMODIFIED to a live server
   holding a reconstruction of the capture tables it reads (public.signals,
   public.signal_ticks, public.book_quote_ticks, collective.fg2_event_links —
   the columns capture writes, nothing more), then used and attacked:

     STATIC   the supabase/README.md conventions: no psql meta-command,
              idempotent DDL, additive, ends in a report.
     DB       applied twice; every report row ok; the committed artifact
              loads and a second load writes nothing; append-only tables refuse
              update, delete and truncate; anon reads but cannot write or run
              the writers.
     PARITY   public.half_point_value() against lib/edgedesk_market_structure.js
              halfPoint() for every half point from -20 to +20 in both windows,
              and nfl_keys_crossed() against keysCrossed(); the seeded division
              table against the core's own.
     SNAPSHOT a fixture week that exercises every status (ok, no_capture,
              stale_capture, no_main_line), a pass AFTER the freeze that must
              not be read, the DST change, idempotent re-runs, the backfill,
              the board's current / close deltas, key numbers touched, flags,
              and CLV from both close sources.

   If no postgres binary is available the suite SAYS SO and passes on the
   static layer alone.

   Run: node tools/football/market_structure_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { findPgBin, startCluster } = require(path.join(ROOT, 'tools', 'collective', 'pg_harness.js'));
const MS = require(path.join(ROOT, 'lib', 'edgedesk_market_structure.js'));
const FILE = path.join(ROOT, 'supabase', 'nfl_market_structure.sql');
const ART = path.join(ROOT, 'football', 'market_structure', 'nfl.json');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done(extra) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : '')));
  if (extra) console.log(extra);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ------------------------------------------------------------- STATIC */
const SQL = fs.readFileSync(FILE, 'utf8');
chk('no psql meta-command anywhere (the SQL editor is not psql)', !/^\s*\\/m.test(SQL));
chk('every table is create-if-not-exists', !/create table (?!if not exists)/i.test(SQL));
chk('nothing is dropped but triggers, policies and its own views', !/\bdrop (table|function|schema|view|column|index)\b/i.test(SQL));
chk('no existing capture table is written', !/(insert into|update|delete from)\s+public\.(signals|signal_ticks|book_quotes|book_quote_ticks)\b/i.test(SQL));
chk('ends in a report', /THE REPORT[\s\S]*select piece, state[\s\S]*$/.test(SQL));
chk('nothing writes or alters model_predictions, projections, record or P&L tables',
  !/(insert into|update|delete from|alter table|truncate|create trigger[^;]* on)\s+(public\.)?(model_predictions|game_projections|model_pnl\w*|pnl_grades|recommendation\w*|signals|signal_ticks)\b/i.test(SQL));

const BIN = findPgBin();
if (!BIN) done('NOTE | no postgres binary on this machine: the database layers did not run (static layer only)');
const pg = startCluster(BIN, 'mstruct');
if (!pg.ok) done('NOTE | could not start postgres (' + pg.why + '): the database layers did not run');

function q(sql, db) {
  const f = path.join(require('os').tmpdir(), 'ms_' + process.pid + '_' + Math.random().toString(36).slice(2) + '.sql');
  fs.writeFileSync(f, sql);
  const staged = pg.stage(f);
  fs.unlinkSync(f);
  return pg.psql('-d ' + (db || 'ms') + ' -X -q -t -A -v ON_ERROR_STOP=1 -f ' + staged);
}
function one(sql, db) { const r = q(sql, db); if (r.status !== 0) throw new Error(r.out); return r.out.trim(); }
function json(sql) { const o = one(sql); return o ? JSON.parse(o) : null; }

pg.psql('-d postgres -q -c "create database ms"');
/* the Supabase roles, and the capture tables as capture writes them */
one(`
do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $r$;
grant usage on schema public to anon, authenticated, service_role;
create table public.signals (
  id bigserial primary key, sig_key text unique not null, event_id text, sport_key text, sport_title text, commence_time timestamptz,
  home_team text, away_team text, market text, selection text, point numeric, last_seen_at timestamptz, best_dec numeric, best_book text,
  sharp_fair numeric, consensus_fair numeric, n_books integer, closing_sharp_fair numeric, closed_at timestamptz);
create table public.signal_ticks (id bigserial primary key, sig_key text not null, created_at timestamptz not null default now(),
  best_dec numeric, sharp_fair numeric, edge numeric, n_books integer, fresh_books integer, n_books_eff integer, actionable boolean);
create index signal_ticks_sig_created_idx on public.signal_ticks (sig_key, created_at);
create table public.book_quote_ticks (id bigserial primary key, sig_key text not null, book_key text, book_title text, dec numeric, fair numeric,
  is_sharp boolean, event_id text, seen_at timestamptz not null default now(), payload jsonb);
create schema collective;
create table collective.fg2_event_links (source text not null, source_event_id text not null, status text not null, canonical_game_id text,
  primary key (source, source_event_id));
`);

/* --------------------------------------------------------------- DB */
const staged = pg.stage(FILE);
const run1 = pg.psql('-d ms -X -v ON_ERROR_STOP=1 -f ' + staged);
chk('applies cleanly', run1.status === 0, run1.out.slice(-1500));
const run2 = pg.psql('-d ms -X -v ON_ERROR_STOP=1 -f ' + staged);
chk('applies cleanly a second time (idempotent)', run2.status === 0, run2.out.slice(-1500));
/* AS THE SQL EDITOR SENDS IT: one raw string, one round trip, no psql meta
   handling. The invocation lives in a script file read by the inner shell only
   (tools/collective/model_autocreate_sql.test.js says why an inline $(cat) fails). */
{
  const port = pg.psql('-d postgres -X -t -A -c "show port"').out.trim();
  const shSrc = path.join(require('os').tmpdir(), 'ms_editor_' + process.pid + '.sh');
  fs.writeFileSync(shSrc, '#!/bin/sh\nSQL=$(cat "$1")\nexec ' + BIN + '/psql -X -h /tmp -p ' + port + ' -d "$2" -v ON_ERROR_STOP=1 -c "$SQL" 2>&1\n');
  const sh = pg.stage(shSrc);
  fs.unlinkSync(shSrc);
  const asRoot = process.getuid && process.getuid() === 0;
  let raw;
  try { raw = { status: 0, out: require('child_process').execSync(asRoot ? 'su postgres -c ' + JSON.stringify('sh ' + sh + ' ' + staged + ' ms') : 'sh ' + sh + ' ' + staged + ' ms', { encoding: 'utf8' }) }; }
  catch (e) { raw = { status: 1, out: String((e.stdout || '') + (e.stderr || '') + e.message) }; }
  chk('applies as one raw string (the editor path)', raw.status === 0 && !/ERROR|syntax error/i.test(raw.out), raw.out.slice(-800));
}
const report = one(`select string_agg(piece || ' => ' || state, E'\\n') from (${SQL.slice(SQL.lastIndexOf('select piece, state from (')).replace(/;\s*$/, '')}) r`);
chk('every report row reads ok', report.split('\n').every((l) => / => ok$/.test(l)), report);

const A = JSON.parse(fs.readFileSync(ART, 'utf8'));
const lit = (o) => '$art$' + JSON.stringify(o) + '$art$';
const load1 = json(`set role service_role; select public.nfl_market_structure_load(${lit(A)}::jsonb);`);
chk('the artifact loads (service role)', load1 && load1.margin_rows_written > 0 && load1.two_point_weeks_written > 0, load1);
const load2 = json(`set role service_role; select public.nfl_market_structure_load(${lit(A)}::jsonb);`);
chk('loading the same artifact again writes nothing', load2 && load2.margin_rows_written === 0 && load2.two_point_weeks_written === 0, load2);
const nRows = A.margin_frequency.windows.reduce((s, w) => s + w.abs.rows.length + w.fav_signed.rows.length, 0);
chk('every margin row is held, exactly once', Number(one('select count(*) from public.nfl_margin_frequency_current')) === nRows);
chk('anon cannot run the loader', q(`set role anon; select public.nfl_market_structure_load('{}'::jsonb);`).status !== 0);
chk('anon cannot write a margin row', q(`set role anon; insert into public.nfl_margin_frequency values ('x','abs',1,1,0.1,1,null,null,now(),'x');`).status !== 0);
chk('anon reads the margin table', Number(one('set role anon; select count(*) from public.nfl_margin_frequency_current')) === nRows);
chk('a margin row cannot be updated', q('update public.nfl_margin_frequency set games = games + 1;').status !== 0);
chk('a margin row cannot be deleted', q('delete from public.nfl_margin_frequency;').status !== 0);
chk('the margin table cannot be truncated', q('truncate public.nfl_margin_frequency;').status !== 0);
chk('a non-artifact is refused by the loader', q(`select public.nfl_market_structure_load('{"schema":"nope"}'::jsonb);`).status !== 0);
const seasons2 = json(`select json_agg(json_build_object('season', season, 'share', share) order by season) from public.nfl_two_point_season`);
chk('two-point season shares match the artifact', seasons2 && seasons2.length === A.two_point.seasons.length
  && seasons2.every((s) => { const a = A.two_point.seasons.filter((x) => x.season === s.season)[0]; return a && Math.abs(Number(s.share) - a.share) < 1e-4; }), seasons2);

/* the freeze on pg_cron (a stub cron schema: this server has no pg_cron) */
{
  one(`create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create or replace function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint language sql as $f$
  insert into cron.job (jobname, schedule, command) values (p_name, p_sched, p_cmd) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $f$;
create or replace function cron.unschedule(p_id bigint) returns boolean language sql as $f$ delete from cron.job where jobid = p_id returning true $f$;`);
  const cron = pg.stage(path.join(ROOT, 'supabase', 'nfl_market_structure_cron.sql'));
  const c1 = pg.psql('-d ms -X -A -t -v ON_ERROR_STOP=1 -f ' + cron), c2 = pg.psql('-d ms -X -A -t -v ON_ERROR_STOP=1 -f ' + cron);
  chk('cron: applies, and again (idempotent)', c1.status === 0 && c2.status === 0, (c1.out + c2.out).slice(-600));
  chk('cron: two jobs, every 15 minutes Thursday afternoon UTC and hourly Friday-Sunday, both calling the freeze',
    one(`select string_agg(jobname || '=' || schedule, ',' order by jobname) from cron.job where command like '%nfl_line_snapshot_take%'`) === 'nfl_line_snapshot=*/15 16-23 * * 4,nfl_line_snapshot_backstop=23 * * * 5,6,0');
  chk('cron: the report reads ok and names the freeze due', /1 the Thursday job is scheduled\|ok/.test(c2.out) && /3 the freeze due now\|Thu \d{4}-\d\d-\d\d 13:00 ET/.test(c2.out), c2.out.slice(-400));
}

/* ----------------------------------------------------------- PARITY */
['full', 'recent_2023'].forEach((wl) => {
  const W = A.margin_frequency.windows.filter((w) => w.window_label === wl)[0];
  const sql = json(`select json_agg(h order by l) from generate_series(-40, 40) l, lateral public.half_point_value(l / 2.0, '${wl}') h`);
  let bad = [];
  for (let i = -40; i <= 40; i++) {
    const L = i / 2, js = MS.halfPoint(W.fav_signed.rows, L, W.fav_signed), s = sql && sql[i + 40];
    if (!s || !js) { bad.push({ L, s: !!s, js: !!js }); continue; }
    const pairs = [['push_prob', js.push_prob], ['up_moved_mass', js.up.moved_mass], ['up_win_change', js.up.win_change], ['up_push_change', js.up.push_change],
      ['up_loss_change', js.up.loss_change], ['up_half_push_change', js.up.half_push_change], ['down_moved_mass', js.down.moved_mass], ['down_win_change', js.down.win_change],
      ['down_push_change', js.down.push_change], ['down_loss_change', js.down.loss_change], ['down_half_push_change', js.down.half_push_change]];
    pairs.forEach(([k, v]) => { if (Math.abs(Number(s[k]) - v) > 1e-12) bad.push({ L, k, sql: s[k], js: v }); });
    if (s.up_effect !== js.up.effect || s.down_effect !== js.down.effect) bad.push({ L, effects: [s.up_effect, js.up.effect] });
    if (Number(s.games) !== W.fav_signed.n_games) bad.push({ L, games: s.games });
  }
  chk('half_point_value() = halfPoint() at every half point -20..+20, window ' + wl, bad.length === 0, bad.slice(0, 5));
});
chk('half_point_value(-6) in the full window pushes on the favourite-by-six share', () => {
  const h = json(`select row_to_json(h) from public.half_point_value(-6, 'full') h`);
  const W = A.margin_frequency.windows[0], six = W.fav_signed.rows.filter((r) => r.margin === 6)[0].frequency;
  return Math.abs(h.push_prob - six) < 1e-12 && h.up_effect === 'push_to_win' && h.down_effect === 'push_to_loss';
});
chk('an unknown window returns no row (never a zero dressed as a value)', one(`select count(*) from public.half_point_value(-6, 'nope')`) === '0');
{
  const grid = []; for (let a = -16; a <= 16; a += 0.5) for (let b = -16; b <= 16; b += 2.5) grid.push([a, b]);
  const sql = json(`select json_agg(public.nfl_keys_crossed(a, b) order by i) from (select i, (v->>0)::numeric a, (v->>1)::numeric b from jsonb_array_elements('${JSON.stringify(grid)}'::jsonb) with ordinality t(v, i)) z`);
  const bad = grid.filter((g, i) => JSON.stringify(sql[i]) !== JSON.stringify(MS.keysCrossed(g[0], g[1])));
  chk('nfl_keys_crossed() = keysCrossed() over a ' + grid.length + '-move grid', bad.length === 0, bad.slice(0, 5));
}
chk('the seeded division table = the core\'s DIVISIONS', () => {
  const d = json(`select json_agg(json_build_array(team_code, nflverse_code, team_name, conference, division) order by team_code) from public.nfl_team_divisions`);
  return JSON.stringify(d) === JSON.stringify(MS.DIVISIONS.slice().sort((x, y) => (x[0] < y[0] ? -1 : 1)));
});

/* --------------------------------------------------------- SNAPSHOT */
chk('the freeze is Thursday 13:00 Eastern (EDT: 17:00Z)', one(`select public.market_snapshot_instant('2026-10-08 18:30+00') at time zone 'UTC'`) === '2026-10-08 17:00:00');
chk('before this week\'s freeze, the freeze due is last week\'s', one(`select public.market_snapshot_instant('2026-10-08 16:59+00') at time zone 'UTC'`) === '2026-10-01 17:00:00');
chk('after DST ends the freeze is still 13:00 Eastern (EST: 18:00Z)', one(`select public.market_snapshot_instant('2026-11-05 19:00+00') at time zone 'UTC'`) === '2026-11-05 18:00:00');

/* The fixture. Freeze 2026-10-08 17:00Z (Thursday 1 PM EDT). */
function sig(ev, home, away, kick, sel, point, extra) {
  return Object.assign({ sig_key: ev + '|spreads|' + sel + '|' + point, event_id: ev, sport_key: 'americanfootball_nfl', commence_time: kick,
    home_team: home, away_team: away, market: 'spreads', selection: sel, point }, extra || {});
}
const H = 'Philadelphia Eagles', D = 'Dallas Cowboys';
const S = [], T = [];
function tick(s, at, dec, fair, n) { T.push({ sig_key: s.sig_key, created_at: at, best_dec: dec, sharp_fair: fair, n_books: n }); }
/* A: a clean week. Main -3 at the freeze (12 books); a pass AFTER the freeze at -4
   must not be read; the close at -4.5; the close pipeline priced -3 at 0.58. */
const kA = '2026-10-11T17:00:00Z';
const a = {
  h25: sig('evA', H, D, kA, H, -2.5), h3: sig('evA', H, D, kA, H, -3, { closing_sharp_fair: 0.58 }), h35: sig('evA', H, D, kA, H, -3.5), h7: sig('evA', H, D, kA, H, -7),
  h4: sig('evA', H, D, kA, H, -4), h45: sig('evA', H, D, kA, H, -4.5),
  a25: sig('evA', H, D, kA, D, 2.5), a3: sig('evA', H, D, kA, D, 3, { closing_sharp_fair: 0.42 }), a35: sig('evA', H, D, kA, D, 3.5), a45: sig('evA', H, D, kA, D, 4.5)
};
Object.values(a).forEach((s) => S.push(s));
const P1 = '2026-10-08T15:00:00Z';
tick(a.h25, P1, 1.87, 0.515, 8); tick(a.h3, P1, 2.02, 0.47, 12); tick(a.h35, P1, 2.15, 0.44, 5); tick(a.h7, P1, 3.1, 0.30, 2);
tick(a.a25, P1, 1.98, 0.485, 8); tick(a.a3, P1, 1.83, 0.53, 12); tick(a.a35, P1, 1.76, 0.56, 5);
tick(a.h4, '2026-10-08T20:00:00Z', 1.95, 0.5, 13);                                   /* after the freeze */
const P3 = '2026-10-11T16:40:00Z';
tick(a.h45, P3, 1.92, 0.50, 14); tick(a.a45, P3, 1.92, 0.50, 14); tick(a.h3, P3, 1.75, 0.58, 9); tick(a.a3, P3, 2.2, 0.42, 9);
/* B: first captured after the freeze */
const kB = '2026-10-11T20:25:00Z';
const b = sig('evB', 'Chicago Bears', 'Detroit Lions', kB, 'Chicago Bears', 1.5); S.push(b); tick(b, '2026-10-09T12:00:00Z', 1.9, 0.5, 9);
/* C: the last pass was eleven hours before the freeze */
const kC = '2026-10-11T17:00:00Z';
const c = sig('evC', 'Miami Dolphins', 'Buffalo Bills', kC, 'Miami Dolphins', 2.5); S.push(c); tick(c, '2026-10-08T06:00:00Z', 1.9, 0.5, 9);
/* E: a pass at the freeze, but nothing near even money on the home side */
const kE = '2026-10-12T00:20:00Z';
const e1 = sig('evE', 'Kansas City Chiefs', 'Denver Broncos', kE, 'Kansas City Chiefs', -10); S.push(e1); tick(e1, P1, 1.4, 0.80, 9);
/* G: the close pipeline did not price the frozen number: CLV from the last tick */
const kG = '2026-10-11T20:05:00Z';
const gH = sig('evG', 'Seattle Seahawks', 'Los Angeles Rams', kG, 'Seattle Seahawks', -1.5), gA = sig('evG', 'Seattle Seahawks', 'Los Angeles Rams', kG, 'Los Angeles Rams', 1.5);
const gH1 = sig('evG', 'Seattle Seahawks', 'Los Angeles Rams', kG, 'Seattle Seahawks', -0.5);
S.push(gH, gA, gH1);
tick(gH, P1, 1.91, 0.5, 10); tick(gA, P1, 1.95, 0.5, 10);
tick(gH1, '2026-10-11T19:50:00Z', 1.93, 0.5, 11); tick(gA, '2026-10-11T19:50:00Z', 2.25, 0.45, 6);
/* D: kicks off beyond the six-day horizon of both freezes in range */
const dd = sig('evD', 'Houston Texans', 'Indianapolis Colts', '2026-10-21T18:00:00Z', 'Houston Texans', -3); S.push(dd); tick(dd, '2026-10-15T12:00:00Z', 1.9, 0.5, 9);
/* F: the next freeze (2026-10-15 17:00Z), still pregame when the board is read */
const kF = '2026-10-18T17:00:00Z';
const fH6 = sig('evF', 'Green Bay Packers', 'Minnesota Vikings', kF, 'Green Bay Packers', -6), fA6 = sig('evF', 'Green Bay Packers', 'Minnesota Vikings', kF, 'Minnesota Vikings', 6);
const fH65 = sig('evF', 'Green Bay Packers', 'Minnesota Vikings', kF, 'Green Bay Packers', -6.5);
S.push(fH6, fA6, fH65);
tick(fH6, '2026-10-15T16:00:00Z', 1.92, 0.5, 10); tick(fA6, '2026-10-15T16:00:00Z', 1.92, 0.5, 10);
tick(fH65, '2026-10-17T12:00:00Z', 1.93, 0.5, 11);

const cols = ['sig_key', 'event_id', 'sport_key', 'commence_time', 'home_team', 'away_team', 'market', 'selection', 'point', 'closing_sharp_fair'];
one('insert into public.signals (' + cols.join(',') + ') select ' + cols.map((k) => '(x->>\'' + k + '\')' + (k === 'point' || k === 'closing_sharp_fair' ? '::numeric' : (k === 'commence_time' ? '::timestamptz' : ''))).join(',')
  + ' from jsonb_array_elements(' + lit(S) + '::jsonb) x;');
one(`insert into public.signal_ticks (sig_key, created_at, best_dec, sharp_fair, n_books)
     select x->>'sig_key', (x->>'created_at')::timestamptz, (x->>'best_dec')::numeric, (x->>'sharp_fair')::numeric, (x->>'n_books')::int from jsonb_array_elements(${lit(T)}::jsonb) x;`);
one(`insert into public.book_quote_ticks (sig_key, book_key, seen_at) values
  ('evA|spreads|${H}|-3', 'pinnacle', '2026-10-08T14:58:00Z'), ('evA|spreads|${H}|-3', 'draftkings', '2026-10-08T14:59:00Z'),
  ('evA|spreads|${H}|-3', 'fanduel', '2026-10-08T19:00:00Z');
  insert into collective.fg2_event_links values ('edgedesk_capture', 'evA', 'linked', 'game-uuid-A');`);

const take1 = json(`set role service_role; select public.nfl_line_snapshot_take('2026-10-08 18:30+00');`);
chk('the freeze is written for every game on the slate (D is past the horizon)', take1 && take1.events_written === 5 && take1.snapshot_at && /2026-10-08T17:00:00/.test(new Date(take1.snapshot_at).toISOString()), take1);
chk('statuses: 2 ok, no_capture, stale_capture, no_main_line', take1 && take1.statuses.ok === 2 && take1.statuses.no_capture === 1 && take1.statuses.stale_capture === 1 && take1.statuses.no_main_line === 1, take1);
const take2 = json(`set role service_role; select public.nfl_line_snapshot_take('2026-10-09 02:00+00');`);
chk('a second run that week writes nothing (idempotent)', take2 && take2.events_written === 0 && take2.already_frozen === 5, take2);
const snapA = json(`select row_to_json(s) from public.nfl_line_snapshots s where event_id = 'evA'`);
chk('A froze at -3: the most books near even, not the alternate -7, not the pass after the freeze', snapA && Number(snapA.home_spread) === -3 && Number(snapA.n_books) === 12 && Number(snapA.fair_home) === 0.47, snapA);
chk('A carries both sides\' frozen prices and keys', snapA && Number(snapA.best_dec_home) === 2.02 && Number(snapA.best_dec_away) === 1.83 && snapA.sig_key_away === 'evA|spreads|' + D + '|3');
chk('A names the books that quoted it before the freeze (not after)', snapA && JSON.stringify(snapA.books) === JSON.stringify(['draftkings', 'pinnacle']), snapA && snapA.books);
chk('A carries the canonical game the grading layer linked', snapA && snapA.canonical_game_id === 'game-uuid-A');
chk('A says how old the pass was at the freeze', snapA && Number(snapA.capture_age_minutes) === 120);
chk('a partial freeze raised a WARNING (and named the statuses)', one(`select count(*) from public.market_structure_alerts where module = 'nfl_line_snapshot' and severity = 'WARNING' and code = 'partial_freeze'`) === '1');
chk('a snapshot cannot be rewritten', q(`update public.nfl_line_snapshots set home_spread = -2 where event_id = 'evA';`).status !== 0);
chk('a snapshot cannot be deleted', q(`delete from public.nfl_line_snapshots;`).status !== 0);
chk('anon cannot take a snapshot', q(`set role anon; select public.nfl_line_snapshot_take();`).status !== 0);
chk('anon cannot read capture history through the consensus function', q(`set role anon; select * from public.nfl_consensus_spread_at('evA', now());`).status !== 0);
chk('an ok row without a line is refused by the table itself', q(`insert into public.nfl_line_snapshots (sport_key, snapshot_at, event_id, status, rule) values ('americanfootball_nfl', now(), 'x', 'ok', 'x');`).status !== 0);

const back = json(`set role service_role; select public.nfl_line_snapshot_backfill('2026-10-01', '2026-10-16');`);
chk('the backfill walks each Thursday in range (10-01, 10-08, 10-15)', back && back.length === 3, back);
chk('the backfill leaves the 10-08 freeze as it was', back && back[1].events_written === 0 && back[1].already_frozen === 5, back && back[1]);
chk('the backfill freezes F on 10-15', one(`select home_spread from public.nfl_line_snapshots where event_id = 'evF'`) === '-6');
chk('a backfilled row says it was reconstructed late', one(`select taken_at > snapshot_at + interval '1 hour' from public.nfl_line_snapshots where event_id = 'evF'`) === 't');

const board = json(`set role anon; select json_agg(b order by event_id) from public.nfl_snapshot_board('2026-10-01', '2026-10-31', '2026-10-17 13:00+00') b;`);
const row = (id) => (board || []).filter((x) => x.event_id === id)[0];
const bA = row('evA'), bF = row('evF'), bG = row('evG'), bB = row('evB'), bE = row('evE');
chk('anon reads the board', Array.isArray(board) && board.length === 6, board && board.length);
chk('A closed at -4.5 (the last pass before kickoff)', bA && bA.close_status === 'ok' && Number(bA.close_home_spread) === -4.5 && bA.current_status === null, bA);
chk('A: delta -1.5, touched 3 (it left 3), flagged', bA && Number(bA.close_delta) === -1.5 && JSON.stringify(bA.close_crossed) === '[3]' && bA.close_flagged === true, bA);
chk('A: the market moved toward the home side', bA && bA.moved_toward === 'home');
chk('A: CLV = frozen home price × the close pipeline\'s fair at -3 − 1 = 2.02 × 0.58 − 1', bA && Math.abs(Number(bA.clv) - (2.02 * 0.58 - 1)) < 1e-5 && bA.clv_source === 'close_pipeline', bA);
chk('G: the close pipeline never priced the frozen number: CLV from the last tick (away +1.5 at 0.45)',
  bG && bG.moved_toward === 'away' && bG.clv_source === 'last_tick' && Math.abs(Number(bG.clv) - (1.95 * 0.45 - 1)) < 1e-5, bG);
chk('F is pregame at the read: current -6.5, delta -0.5, touched 6, flagged, no CLV yet',
  bF && bF.current_status === 'ok' && Number(bF.current_home_spread) === -6.5 && Number(bF.current_delta) === -0.5
  && JSON.stringify(bF.current_crossed) === '[6]' && bF.current_flagged === true && bF.close_status === null && bF.clv === null && bF.clv_reason === 'not_closed', bF);
chk('B carries its reason, never a line', bB && bB.snapshot_status === 'no_capture' && bB.snap_home_spread === null && bB.clv_reason === 'no_snapshot_line', bB);
chk('E carries its reason, never a line', bE && bE.snapshot_status === 'no_main_line' && bE.snap_home_spread === null, bE);
chk('JS snapshotDelta agrees with the board on A and F', () => {
  const x = MS.snapshotDelta(-3, -4.5), y = MS.snapshotDelta(-6, -6.5);
  return x.delta === -1.5 && x.flagged && JSON.stringify(x.crossed) === '[3]' && x.toward === 'home' && y.flagged && JSON.stringify(y.crossed) === '[6]';
});
/* a freeze where nothing on the slate had a line is a FAILURE, not a quiet empty week */
one(`insert into public.signals (sig_key, event_id, sport_key, commence_time, home_team, away_team, market, selection, point)
     values ('evZ|spreads|Tennessee Titans|3', 'evZ', 'americanfootball_nfl', '2026-11-01T18:00:00Z', 'Tennessee Titans', 'Jacksonville Jaguars', 'spreads', 'Tennessee Titans', 3);`);
const take3 = json(`set role service_role; select public.nfl_line_snapshot_take('2026-10-29 18:00+00');`);
chk('an all-empty freeze raises a FAILURE alert', take3 && take3.statuses.no_capture === 1
  && one(`select count(*) from public.market_structure_alerts where severity = 'FAILURE' and code = 'no_line_at_freeze'`) === '1', take3);

done();
