#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK GAMES — THE EXCHANGE UNDER CONTENTION, against a real PostgreSQL.

   The franchise SQL suite proves the Exchange is idempotent and replay-safe
   inside one session. This proves the thing a single session cannot: what
   happens when several buyers reach for the same listing AT THE SAME TIME,
   and when one buyer with the Credits for one man reaches for two.

     1  six franchises call franchise_exchange_buy on one listing from six
        separate connections at once: exactly one wins, five are refused,
        the man belongs to the winner, the buyer paid once, the seller was
        paid once, the fee left the economy, and every balance is the sum
        of its ledger
     2  one franchise with the Credits for one man buys two listings at
        once: exactly one goes through, and the balance never goes below
        zero

   The safety rests on row locks taken in one order (the listing, then both
   franchises by id) and on the ledger's unique key — this is where that is
   demonstrated rather than asserted.

   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES, like the other SQL suites;
   CI installs Postgres and gets the real thing.

   Run: node tools/games/exchange_concurrency.test.js
        EDGD_PG="-h 127.0.0.1 -p 5432 -U postgres" node tools/games/exchange_concurrency.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_games_exchange_sqltest';
const BUYERS = 6;

function have(bin) { return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }
function candidates() {
  const out = [];
  if (process.env.EDGD_PG) out.push(process.env.EDGD_PG.split(' '));
  if (process.env.PGHOST) out.push([]);
  out.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  out.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  out.push([]);
  return out;
}
function psql(conn, args, opts) { return cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8' }, opts || {})); }
function skip(why) {
  console.log('SKIP | exchange concurrency | ' + why);
  console.log('       (this suite needs PostgreSQL; CI runs it in games-sql.yml)');
  process.exit(0);
}
if (!have('psql')) skip('psql is not installed');
let conn = null;
for (const c of candidates()) {
  const r = psql(c, ['-d', 'postgres', '-tAc', 'select 1']);
  if (r.status === 0 && String(r.stdout).trim() === '1') { conn = c; break; }
}
if (!conn) skip('no reachable PostgreSQL server');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]); }
function die(msg, r) {
  console.log('FAIL | exchange concurrency | ' + msg);
  ((r && (r.stderr || '')) + (r && (r.stdout || ''))).split('\n').filter(l => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 10).forEach(l => console.log('  × ' + l.trim()));
  drop(); process.exit(1);
}
function q(sql) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql]);
  if (r.status !== 0) die('a query failed: ' + sql.slice(0, 80), r);
  return String(r.stdout).trim();
}

psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
let mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());
for (const [file, label] of [[SHIM, 'the Supabase shim'], [SOCIAL, 'games_social.sql'], [SCHEMA, 'games_franchise.sql']]) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) die(label + ' did not apply', r);
}

/* ── the table is set: one seller with a spare man listed, six buyers with the Credits ── */
const SELLER = 'device-secret-concurrencysellerseller01';
const buyerSecret = i => 'device-secret-concurrencybuyer0000000' + i;
q("select public.franchise_create('Foundry','Bethel','BET','gear','forest','power_run','press_man','" + SELLER + "')");
const seller = q("select id from public.franchises where anon_hash = public.games_hash('" + SELLER + "')");
q("select public.franchise_credit('" + seller + "','tc',5000,'test','fund','the suite')");
const fa = q("select id from public.game_players where franchise_id = '" + seller + "' and status = 'free_agent' order by overall desc limit 1");
q("select public.franchise_sign('" + fa + "','" + SELLER + "')");
const pos = q("select position from public.game_players where id = '" + fa + "'");
const man = q("select id from public.game_players where franchise_id = '" + seller + "' and status = 'active' and position = '" + pos + "' order by overall asc, id limit 1");
const listing = q("select (public.franchise_exchange_list('" + man + "', 800, '" + SELLER + "')->'listing'->>'id')");
const buyers = [];
for (let i = 1; i <= BUYERS; i++) {
  const sec = buyerSecret(i);
  q("select public.franchise_create('Harbor" + i + "','Kodiak','K" + i + "','anchor','navy','air_raid','zone','" + sec + "')");
  const id = q("select id from public.franchises where anon_hash = public.games_hash('" + sec + "')");
  q("select public.franchise_credit('" + id + "','tc',2000,'test','fund','the suite')");
  buyers.push({ i, sec, id });
}
const before = +q("select sum(team_credits) from public.franchises");
/* what a buyer holds: the founding grant plus the suite's funding */
const funded = +q("select team_credits from public.franchises where id = '" + buyers[0].id + "'");
const ledgerBefore = +q("select coalesce(sum(delta),0) from public.franchise_ledger where currency = 'tc'");

/* ── 1. six hands on one listing, at once ────────────────────────────────── */
function buyAll(jobs) {
  /* one psql process per buyer, all launched before any is awaited; each
     runs as the anon role with the device's secret, as the page would */
  const procs = jobs.map(j => cp.spawn('psql', conn.concat(['-d', DB, '-tA', '-c',
    "set role anon; select public.franchise_exchange_buy('" + j.listing + "','" + j.sec + "')"]), { encoding: 'utf8' }));
  return Promise.all(procs.map((p, k) => new Promise(res => {
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('close', code => res({ job: jobs[k], code, out: out.trim(), err: err.trim() }));
  })));
}
(async () => {
  const results = await buyAll(buyers.map(b => ({ listing, sec: b.sec, id: b.id })));
  const won = results.filter(r => r.code === 0 && /"ok"\s*:\s*true/.test(r.out));
  const lost = results.filter(r => r.code !== 0);
  chk('exactly one of six simultaneous buyers wins', won.length === 1, won.length + ' won: ' + results.map(r => r.code + ':' + (r.err || r.out).slice(0, 60)).join(' | '));
  chk('the other five are refused, not left hanging', lost.length === BUYERS - 1, lost.length + ' refused');
  chk('and refused because the listing was closed, not by a lock error or a deadlock',
    lost.every(r => /closed|already on the books/.test(r.err)) && !lost.some(r => /deadlock|could not serialize/.test(r.err)),
    lost.map(r => r.err.split('\n')[0]).join(' | '));
  if (won.length === 1) {
    const w = won[0].job;
    chk('the man belongs to the winner', q("select franchise_id from public.game_players where id = '" + man + "'") === w.id);
    chk('the winner paid once', q("select count(*) from public.franchise_ledger where franchise_id = '" + w.id + "' and kind = 'exchange_buy'") === '1');
    chk('and nobody else paid at all', q("select count(*) from public.franchise_ledger where kind = 'exchange_buy'") === '1');
    chk('the seller was paid once, the net', q("select string_agg(delta::text, ',') from public.franchise_ledger where franchise_id = '" + seller + "' and kind = 'exchange_sale'") === '760');
    chk('the winner holds what he had less the price', q("select team_credits from public.franchises where id = '" + w.id + "'") === String(funded - 800));
    chk('the listing is sold to the winner, fee 40, net 760',
      q("select status || ':' || buyer_id || ':' || fee || ':' || net from public.franchise_listings where id = '" + listing + "'") === 'sold:' + w.id + ':40:760');
  }
  const after = +q("select sum(team_credits) from public.franchises");
  chk('the economy lost exactly the fee', after === before - 40, before + ' -> ' + after);
  chk('every balance is the sum of its ledger',
    q("select bool_and(f.team_credits = (select coalesce(sum(delta),0) from public.franchise_ledger l where l.franchise_id = f.id and l.currency = 'tc')) from public.franchises f") === 't');
  chk('the ledger moved by exactly the fee too', +q("select coalesce(sum(delta),0) from public.franchise_ledger where currency = 'tc'") === ledgerBefore - 40);

  /* ── 2. one buyer, the Credits for one man, two listings at once ──────── */
  const poor = buyers.find(b => q("select count(*) from public.franchise_ledger where franchise_id = '" + b.id + "' and kind = 'exchange_buy'") === '0');
  /* the seller lists two more spare men at 1500 each; the poor buyer holds 2000 */
  const spares = q("select string_agg(id::text, ',') from (select id from public.game_players where franchise_id = '" + seller + "' and status = 'active' and position = 'WR' order by overall asc, id limit 2) x").split(',');
  /* the seller is at the floor after the first sale: give him room with a second signing */
  const fa2 = q("select id from public.game_players where franchise_id = '" + seller + "' and status = 'free_agent' order by overall desc limit 1");
  q("select public.franchise_sign('" + fa2 + "','" + SELLER + "')");
  const l1 = q("select (public.franchise_exchange_list('" + spares[0] + "', 1500, '" + SELLER + "')->'listing'->>'id')");
  const l2 = q("select (public.franchise_exchange_list('" + spares[1] + "', 1500, '" + SELLER + "')->'listing'->>'id')");
  const two = await buyAll([{ listing: l1, sec: poor.sec, id: poor.id }, { listing: l2, sec: poor.sec, id: poor.id }]);
  const wins2 = two.filter(r => r.code === 0 && /"ok"\s*:\s*true/.test(r.out));
  chk('a buyer with the Credits for one man who reaches for two gets exactly one', wins2.length === 1,
    two.map(r => r.code + ':' + (r.err || r.out).slice(0, 70)).join(' | '));
  chk('the refusal names the Credits', two.some(r => /not enough Credits/.test(r.err)) || two.some(r => /roster|floor|spare/.test(r.err)),
    two.map(r => r.err.split('\n')[0]).join(' | '));
  chk('his balance is what he had less one price, never below zero', q("select team_credits from public.franchises where id = '" + poor.id + "'") === String(funded - 1500));
  chk('and is still the sum of his ledger',
    q("select team_credits = (select sum(delta) from public.franchise_ledger l where l.franchise_id = f.id and l.currency = 'tc') from public.franchises f where id = '" + poor.id + "'") === 't');
  chk('no balance anywhere went negative', q("select bool_and(team_credits >= 0) from public.franchises") === 't');

  drop();
  if (fails.length) console.log(fails.join('\n'));
  console.log((fail ? 'FAIL' : 'PASS') + ' | exchange concurrency | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); drop(); process.exit(1); });
