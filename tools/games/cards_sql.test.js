#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — THE CARD IS NOT THE MAN (cards_v1), against a real
   PostgreSQL.

   One table used to carry five ideas: who a man is, what his card says, who
   owns him, where he plays, and whether he is for sale. This suite holds the
   separation to account, and holds the marketplace to the only promise that
   matters when money moves: a card has exactly one owner, always, and two
   buyers racing for it produce one winner and one clean failure.

     1  every career sheet is minted an identity, an edition and an instance
     2  ownership is a row of its own, and cannot be written behind its back
     3  the lineup is a slot that names a card
     4  the Exchange lists and sells an INSTANCE, atomically
     5  a transaction and a price are written; provenance grows
     6  a repeated purchase with the same operation key is the same purchase
     7  two buyers, one card: exactly one wins, nothing is duplicated
     8  the migration is idempotent and preserves everything it found

   WITHOUT POSTGRES IT SKIPS, LOUDLY, AND PASSES, like the other SQL suites.

   Run: node tools/games/cards_sql.test.js
        EDGD_PG="-h 127.0.0.1 -p 5433 -U postgres" node tools/games/cards_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_games_cards_sqltest';

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
function psql(conn, args, opts) { return cp.spawnSync('psql', conn.concat(args), Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {})); }
function skip(why) {
  console.log('SKIP | the card is not the man | ' + why);
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
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + String(detail).slice(0, 300) : '')); } }
function eq(name, got, want) { chk(name, String(got) === String(want), 'got ' + got + ', want ' + want); }
function drop() { psql(conn, ['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']); }
function die(msg, r) {
  console.log('FAIL | the card is not the man | ' + msg);
  ((r && (r.stderr || '')) + (r && (r.stdout || ''))).split('\n').filter(l => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 8).forEach(l => console.log('  × ' + l.trim()));
  drop(); process.exit(1);
}
function q(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  if (r.status !== 0) die('a query failed: ' + sql.slice(0, 120), r);
  return String(r.stdout).trim();
}
/* a statement that is EXPECTED to fail: the error text comes back instead */
function qFail(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  return { ok: r.status === 0, out: String(r.stdout).trim(), err: String(r.stderr || '') };
}
function qj(sql, asOwner) { const t = q(sql, asOwner); try { return JSON.parse(t); } catch (e) { die('not JSON from: ' + sql.slice(0, 80) + ' → ' + t.slice(0, 120)); } }
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());
for (const [file, label] of [[SHIM, 'the Supabase shim'], [SOCIAL, 'games_social.sql'], [SCHEMA, 'games_franchise.sql']]) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) die(label + ' did not apply', r);
}

const SA = 'device-secret-cardsuiteaaaaaaaaaaaaaa';
const SB = 'device-secret-cardsuitebbbbbbbbbbbbbb';
q("select public.franchise_create('Foundry','Bethel','BET','gear','forest','power_run','press_man'," + lit(SA) + ")");
q("select public.franchise_create('Anvils','Kirby','KRB','bolt','crimson','spread','zone'," + lit(SB) + ")");
const A = q('select public.franchise_of(' + lit(SA) + ')', true);
const B = q('select public.franchise_of(' + lit(SB) + ')', true);
q("select public.franchise_credit(" + lit(B) + "::uuid,'tc',5000,'test','fund','a purse')", true);

/* ── 1. every sheet is minted an identity, an edition and an instance ──── */
eq('every career sheet carries the card it is the career of',
  q('select count(*) from public.game_players where card_id is null', true), '0');
const counts = q("select (select count(*) from public.game_players)||'|'||(select count(*) from public.game_cards)||'|'"
  + "||(select count(*) from public.game_card_defs)||'|'||(select count(*) from public.game_player_identities)", true).split('|');
chk('one identity, one edition and one instance per man — no card minted twice',
  counts[0] === counts[1] && counts[1] === counts[2] && counts[2] === counts[3], counts.join('/'));
eq('every instance has exactly one ownership row',
  q('select count(*) from public.game_cards c where (select count(*) from public.game_card_ownership o where o.card_id = c.id) <> 1', true), '0');
eq('the founding roster is owned by the franchise that founded it',
  q('select count(*) from public.game_players p join public.game_card_ownership o on o.card_id = p.card_id'
    + ' where p.franchise_id is distinct from o.owner_id', true), '0');
const ed = qj('select public.franchise_card_entity((select card_id from public.game_players where franchise_id = ' + lit(A) + "::uuid limit 1))", true);
chk('the edition prints as one of one, with the athlete kept apart from the card',
  ed && ed.edition && ed.edition.label === 'One of one' && ed.player && ed.player.first_name && ed.card_id, JSON.stringify(ed && ed.edition));
chk('the adapter hands gameplay one flat entity assembled from the separate parts',
  ed && ed.player && ed.edition && ed.ownership && ed.career && ed.career.overall != null,
  Object.keys(ed || {}).join(','));

/* ── 2. ownership cannot be written behind the new table's back ────────── */
const sneak = qFail('update public.game_players set franchise_id = ' + lit(B) + '::uuid where franchise_id = ' + lit(A) + '::uuid', true);
chk('a direct write to the legacy owner column is refused by the database',
  !sneak.ok && /franchise_card_transfer/.test(sneak.err), sneak.err.split('\n')[0]);
eq('and nothing moved', q('select count(*) from public.game_card_ownership where owner_id = ' + lit(B) + '::uuid', true),
  q('select count(*) from public.game_players where franchise_id = ' + lit(B) + '::uuid', true));

/* ── 3. the lineup is a slot that names a card ─────────────────────────── */
eq('every lineup slot names a card its franchise actually owns',
  q('select count(*) from public.game_lineup_slots s left join public.game_card_ownership o on o.card_id = s.card_id'
    + ' where o.owner_id is distinct from s.franchise_id', true), '0');
eq('a card fills at most one slot anywhere',
  q('select count(*) from (select card_id from public.game_lineup_slots group by card_id having count(*) > 1) x', true), '0');
const slotsA = +q('select count(*) from public.game_lineup_slots where franchise_id = ' + lit(A) + '::uuid', true);
chk('the starting eleven and the kicking game have their slots filled', slotsA >= 22 && slotsA <= 26, slotsA);

/* ── 4-5. the Exchange sells an instance, and writes what happened ─────── */
for (let i = 1; i <= 3; i++) q('select public.franchise_generate_player(' + lit(A) + "::uuid,'WR',9,1,'spare" + i + "','depth','rookie')", true);
const spare = q("select p.id||'|'||p.card_id from public.game_players p where p.franchise_id = " + lit(A)
  + "::uuid and p.status = 'active' and p.position = 'WR' order by p.depth desc limit 1", true).split('|');
const listed = qj('select public.franchise_exchange_list(' + lit(spare[0]) + '::uuid, 400, ' + lit(SA) + ')');
chk('a listing offers the instance, not the career sheet',
  listed.ok === true && listed.card && listed.card.card_id === spare[1], JSON.stringify(listed.card && listed.card.card_id));
const LID = listed.listing.id;
const bought = qj('select public.franchise_exchange_buy(' + lit(LID) + '::uuid, ' + lit(SB) + ", 'op-buy-1')");
chk('the purchase completes and returns its transaction', bought.ok === true && bought.already === false && bought.transaction, JSON.stringify(bought).slice(0, 160));
eq('ownership moved to the buyer', q('select owner_id from public.game_card_ownership where card_id = ' + lit(spare[1]) + '::uuid', true), B);
eq('and the legacy projection followed it', q('select franchise_id from public.game_players where card_id = ' + lit(spare[1]) + '::uuid', true), B);
eq('the card still has exactly one ownership row', q('select count(*) from public.game_card_ownership where card_id = ' + lit(spare[1]) + '::uuid', true), '1');
eq('a transaction was written', q('select count(*) from public.game_market_txns where listing_id = ' + lit(LID) + '::uuid', true), '1');
eq('a price went into the history', q('select count(*) from public.game_market_prices', true), '1');
eq('and the hand it passed through was recorded', q('select count(*) from public.game_card_provenance where card_id = ' + lit(spare[1]) + '::uuid', true), '1');
const mkt = qj('select public.franchise_card_market(' + lit(spare[1]) + '::uuid)', true);
chk('the card can say what it sold for and whose hands it has been in',
  mkt && Array.isArray(mkt.sales) && mkt.sales.length === 1 && mkt.sales[0].price === 400 && mkt.provenance.length === 1,
  JSON.stringify(mkt && mkt.sales));
eq('the seller was paid the price less the printed fee',
  q("select sum(delta) from public.franchise_ledger where franchise_id = " + lit(A) + "::uuid and kind = 'exchange_sale'", true),
  String(400 - Math.ceil(400 * 5 / 100)));
eq('and the buyer paid the price',
  q("select sum(delta) from public.franchise_ledger where franchise_id = " + lit(B) + "::uuid and kind = 'exchange_buy'", true), '-400');

/* ── 6. the same operation key is the same purchase ────────────────────── */
const replay = qj('select public.franchise_exchange_buy(' + lit(LID) + '::uuid, ' + lit(SB) + ", 'op-buy-1')");
chk('a repeated request with the same key is the purchase it already made', replay.ok === true && replay.already === true, JSON.stringify(replay).slice(0, 140));
eq('and no second transaction exists', q('select count(*) from public.game_market_txns', true), '1');
eq('nor a second charge', q("select count(*) from public.franchise_ledger where franchise_id = " + lit(B) + "::uuid and kind = 'exchange_buy'", true), '1');
const opState = qj('select public.franchise_market_op(' + lit('op-buy-1') + ', ' + lit(SB) + ')');
eq('a client that lost its connection can ask what happened and get one answer', opState.state, 'completed');
const opNone = qj('select public.franchise_market_op(' + lit('op-never-sent') + ', ' + lit(SB) + ')');
eq('and an operation that never landed says so plainly', opNone.state, 'not_completed');

/* ── 7. two buyers, one card ───────────────────────────────────────────── */
const SC = 'device-secret-cardsuiteccccccccccccccc';
q("select public.franchise_create('Kilns','Marrow','MRW','horn','slate','pro_style','four_three'," + lit(SC) + ")");
const C = q('select public.franchise_of(' + lit(SC) + ')', true);
q("select public.franchise_credit(" + lit(C) + "::uuid,'tc',5000,'test','fund','a purse')", true);
const spare2 = q("select p.id from public.game_players p where p.franchise_id = " + lit(A)
  + "::uuid and p.status = 'active' and p.position = 'WR' order by p.depth desc limit 1", true);
const race = qj('select public.franchise_exchange_list(' + lit(spare2) + '::uuid, 300, ' + lit(SA) + ')');
const RID = race.listing.id;
/* BOTH BUYERS AT ONCE. Two psql processes are launched together by the
   shell and waited on there, so they genuinely overlap; node then reads the
   exit codes and the errors off disk. */
const RACE = path.join(require('os').tmpdir(), 'edgd-race-' + process.pid);
require('fs').mkdirSync(RACE, { recursive: true });
const cmd = [SB, SC].map((sec, i) =>
  'psql ' + conn.map(x => "'" + x + "'").join(' ') + ' -d ' + DB + " -v ON_ERROR_STOP=1 -qtA -c "
  + '"set role anon; select public.franchise_exchange_buy(' + "'" + RID + "'" + '::uuid, ' + "'" + sec + "'" + ', null)"'
  + ' > ' + RACE + '/out' + i + ' 2> ' + RACE + '/err' + i + '; echo $? > ' + RACE + '/code' + i + ' &').join(' ') + ' wait';
cp.spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 60000 });
const outcomes = [0, 1].map(i => ({
  code: +String(require('fs').readFileSync(RACE + '/code' + i, 'utf8')).trim(),
  err: require('fs').readFileSync(RACE + '/err' + i, 'utf8')
}));
const winners = outcomes.filter(o => o.code === 0);
const losers = outcomes.filter(o => o.code !== 0);
eq('two buyers race for one card: exactly one wins', winners.length, 1);
eq('and exactly one is turned away, cleanly', losers.length, 1);
chk('the loser is told why, not left guessing',
  losers.length === 1 && /listing is closed|no longer good|already|not enough/.test(losers[0].err),
  (losers[0] || { err: '(none)' }).err.split('\n')[0]);
eq('the card has one owner after the race', q('select count(*) from public.game_card_ownership o join public.franchise_listings l on l.card_id = o.card_id where l.id = ' + lit(RID) + '::uuid', true), '1');
eq('one transaction, not two', q('select count(*) from public.game_market_txns where listing_id = ' + lit(RID) + '::uuid', true), '1');
eq('and the losing buyer was not charged',
  q("select count(*) from public.franchise_ledger where kind = 'exchange_buy' and key = " + lit(RID), true), '1');

/* ── 8. the migration is idempotent and loses nothing ──────────────────── */
const before = q("select (select count(*) from public.game_cards)||'|'||(select count(*) from public.game_card_ownership)||'|'"
  + "||(select count(*) from public.game_players)||'|'||(select count(*) from public.game_lineup_slots)||'|'"
  + "||(select coalesce(sum(team_credits),0) from public.franchises)", true);
const again = qj('select public.franchise_cards_migrate()', true);
const after = q("select (select count(*) from public.game_cards)||'|'||(select count(*) from public.game_card_ownership)||'|'"
  + "||(select count(*) from public.game_players)||'|'||(select count(*) from public.game_lineup_slots)||'|'"
  + "||(select coalesce(sum(team_credits),0) from public.franchises)", true);
eq('running the migration again mints nothing, moves nothing, pays nothing', after, before);
eq('and it says so', again.cards_minted, 0);
eq('the projection never drifts from the ownership record',
  q('select count(*) from public.game_players p join public.game_card_ownership o on o.card_id = p.card_id where p.franchise_id is distinct from o.owner_id', true), '0');
eq('no card is owned by nobody while its sheet says otherwise',
  q('select count(*) from public.game_players p left join public.game_card_ownership o on o.card_id = p.card_id where o.card_id is null', true), '0');

drop();
if (fails.length) console.log(fails.join('\n'));
console.log((fail ? 'FAIL' : 'PASS') + ' | the card is not the man | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
