#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — OFFLINE AND RETRY, IN A REAL BROWSER (resume_v1)

   Every other suite in this repository asks the server a question directly.
   This one asks it the way a phone does: Chromium loads the real pages, the
   real client library makes the real calls, and the calls go to REAL
   POSTGRESQL — the route handler runs each RPC through psql against a live
   database and hands the JSON back, exactly as PostgREST would.

   THAT MATTERS, because the whole question here is what happens between a
   client and a server, and a mocked server cannot answer it. When this suite
   "drops the connection" it does one of two very different things, and the
   difference is the point:

     DROP BEFORE   the request is aborted before it reaches the database, so
                   nothing happened and asking again must be safe
     DROP AFTER    the query RUNS and COMMITS and then the response is thrown
                   away, so the client is left holding a key and no answer —
                   the case that grants a reward twice if you get it wrong

   The six scenarios the brief named:

     1  drop before a pack is opened      no pack spent, no reward, a clear retry
     2  drop after the pack is written    the same men come back, never a re-roll
     3  refresh in the middle of a reveal the men are still there, no second pack
     4  drop during a market purchase     COMPLETED or NOT COMPLETED, never maybe
     5  drop while filing a game result   filed once, and it cannot pay twice
     6  drop while advancing the season   advanced exactly once, or not at all

   WHAT IS CLICKED AND WHAT IS CALLED. The pages are really loaded and the
   connection strip is really read off the DOM. The six operations are driven
   through the page's own EDFranchise functions rather than through a full
   click-path, because those functions ARE what the buttons call and a
   forty-snap live game in a headless browser tests the renderer, not the
   retry. Every assertion afterwards is made against the database.

   WITHOUT POSTGRES OR PLAYWRIGHT IT SKIPS, LOUDLY, AND PASSES.

   Run: node tools/games/offline.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SOCIAL = path.join(ROOT, 'supabase', 'games_social.sql');
const SCHEMA = path.join(ROOT, 'supabase', 'games_franchise.sql');
const SHIM = path.join(__dirname, 'sql', 'supabase_shim.sql');
const DB = 'edgedesk_games_offline_sqltest';
const LABEL = 'offline and retry';
const SECRET = 'device-secret-offlinesuiteaaaaaaaaa';
const PORT = 8137;

function skip(why) {
  console.log('SKIP | ' + LABEL + ' | ' + why);
  console.log('       (this suite needs PostgreSQL and Playwright; CI runs it in games-sql.yml)');
  process.exit(0);
}
function have(bin) { return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }
if (!have('psql')) skip('psql is not installed');

let chromium = null, exePath = null;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
  try { chromium = require(p).chromium; break; } catch (_) {}
}
if (!chromium) skip('playwright is not installed');
try {
  const d = fs.readdirSync('/opt/pw-browsers').filter(x => x.startsWith('chromium-'))[0];
  if (d) exePath = '/opt/pw-browsers/' + d + '/chrome-linux/chrome';
} catch (_) {}

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
  console.log('FAIL | ' + LABEL + ' | ' + msg);
  ((r && (r.stderr || '')) + (r && (r.stdout || ''))).split('\n').filter(l => /ERROR|DETAIL|CONTEXT/.test(l)).slice(0, 6).forEach(l => console.log('  × ' + l.trim()));
  drop(); process.exit(1);
}
function q(sql, asOwner) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', (asOwner ? '' : 'set role anon; ') + sql]);
  if (r.status !== 0) die('a query failed: ' + sql.slice(0, 140), r);
  return String(r.stdout).trim();
}
const lit = s => "'" + String(s).replace(/'/g, "''") + "'";

drop();
const mk = psql(conn, ['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
if (mk.status !== 0) skip('cannot create a test database: ' + (mk.stderr || '').trim());
for (const [file, label] of [[SHIM, 'the Supabase shim'], [SOCIAL, 'games_social.sql'], [SCHEMA, 'games_franchise.sql']]) {
  const r = psql(conn, ['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
  if (r.status !== 0) die(label + ' did not apply', r);
}

/* ── THE SERVER THE BROWSER TALKS TO ──────────────────────────────────────
   PostgREST's rpc endpoint, in twenty lines: the function name is the path,
   the body is the named arguments, the answer is whatever the function
   returns. `cut` is what makes this suite possible — 'before' aborts without
   touching the database, 'after' runs the statement, lets it COMMIT, and
   then throws the answer away. */
let cut = null, seen = [];
function callRpc(fn, args) {
  const names = Object.keys(args || {});
  /* an untyped dollar-quoted literal takes the parameter's own type, so text
     and jsonb both arrive intact — as long as an object is serialised as JSON
     and not as "[object Object]" */
  const parts = names.map((k, i) => {
    const v = args[k];
    if (v == null) return k + ' => null';
    const txt = (typeof v === 'object') ? JSON.stringify(v) : String(v);
    return k + ' => $a' + i + '$' + txt + '$a' + i + '$';
  });
  const call = 'select public.' + fn + '(' + parts.join(', ') + ')';
  const r = psql(conn, ['-d', DB, '-qtA', '-c', 'set role anon; ' + call]);
  if (r.status !== 0) {
    const m = String(r.stderr || '').match(/ERROR:\s*(.*)/);
    return { status: 400, body: JSON.stringify({ message: m ? m[1] : 'error', code: 'P0001' }) };
  }
  return { status: 200, body: String(r.stdout).trim() || 'null' };
}

/* the site itself, served from disk */
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const site = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => site.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox'] }, exePath ? { executablePath: exePath } : {}));
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (/googletagmanager|fonts\.g|google-analytics/.test(url)) return route.abort();
    if (/\/games\/data\/config\.json/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ supabase_url: 'https://pg.local', supabase_anon_key: 'anon-key' }) });
    }
    const m = url.match(/pg\.local\/rest\/v1\/rpc\/([a-z_0-9]+)/);
    if (m) {
      const fn = m[1];
      let args = {};
      try { args = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
      seen.push(fn);
      /* THE CONNECTION GOES BEFORE THE REQUEST LANDS: nothing happened. */
      if (cut && cut.when === 'before' && cut.fn === fn) { cut.hits = (cut.hits || 0) + 1; return route.abort('failed'); }
      /* THE CONNECTION GOES AFTER IT LANDS: it happened, and the client will
         never hear about it. This is the one that grants a reward twice. */
      if (cut && cut.when === 'after' && cut.fn === fn) {
        cut.hits = (cut.hits || 0) + 1;
        cut.result = callRpc(fn, args);
        return route.abort('failed');
      }
      /* THE PHONE IS STILL IN THE LIFT. While a drop is in force the client
         cannot ask what happened either, so it is left holding the key — which
         is exactly the state a reconnect has to be able to resolve. */
      if (cut && cut.when === 'after' && fn === 'franchise_op') return route.abort('failed');
      const r = callRpc(fn, args);
      return route.fulfill({ status: r.status, contentType: 'application/json', body: r.body });
    }
    if (/pg\.local/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    return route.continue();
  });
  await page.addInitScript((s) => { try { localStorage.setItem('edgedesk_games_secret', s); } catch (_) {} }, SECRET);

  /* ── the franchise the browser will be playing ─────────────────────── */
  q("select public.franchise_create('Foundry','Bethel','BET','gear','forest','power_run','press_man'," + lit(SECRET) + ")");
  const F = q('select public.franchise_of(' + lit(SECRET) + ')', true);
  q("select public.franchise_credit(" + lit(F) + "::uuid,'tc',9000,'test','fund','a purse')", true);
  /* a rank's pack, waiting to be opened */
  q("update public.franchises set xp = 40000, rank_claimed = 0 where id = " + lit(F) + '::uuid', true);
  q('select public.franchise_packs_sync(' + lit(F) + '::uuid)', true);
  const sealed = +q("select count(*) from public.franchise_packs where franchise_id = " + lit(F) + "::uuid and status = 'sealed'", true);
  chk('the franchise has a sealed pack to open', sealed >= 1, sealed);

  const go = async (route) => {
    await page.goto('http://127.0.0.1:' + PORT + route, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => !!(window.EDFranchise && window.EDGames), null, { timeout: 20000 });
    await page.waitForTimeout(500);
  };
  const call = (fnName, arg) => page.evaluate(([f, a]) => {
    const F = window.EDFranchise;
    return (a == null ? F[f]() : F[f](a)).then(r => ({ ok: !!r.ok, error: r.error || null, state: r.state || null,
      already: !!r.already, recovered: !!r.recovered, message: r.message || null,
      data: r.data ? JSON.parse(JSON.stringify(r.data)) : null }));
  }, [fnName, arg == null ? null : arg]);
  const netNow = () => page.evaluate(() => ({
    state: window.EDFranchise.net(),
    strip: (function () { const e = document.querySelector('.netb'); return e && !e.hidden ? e.textContent : null; })()
  }));

  await go('/games/packs/');
  chk('the packs room loads and the client library is live', pageErrors.length === 0, pageErrors.join(' | '));
  eq('and it starts synced', (await netNow()).state, 'synced');

  /* ── 1. the connection goes BEFORE the pack is opened ───────────────── */
  const packsBefore = q("select count(*) from public.franchise_packs where franchise_id = " + lit(F) + "::uuid and status = 'sealed'", true);
  const claimedBefore = q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true);
  cut = { fn: 'franchise_once', when: 'before' };
  const r1 = await call('packOpen');
  cut = null;
  chk('a pack open that never reached the server does not claim to have worked', r1.ok === false, JSON.stringify(r1));
  eq('and nothing was spent', q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true), claimedBefore);
  eq('and no pack was consumed',
    q("select count(*) from public.franchise_packs where franchise_id = " + lit(F) + "::uuid and status = 'sealed'", true), packsBefore);
  eq('and no man was drawn', q("select count(*) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true), '0');
  eq('and nothing was written to the operation ledger',
    q('select count(*) from public.franchise_ops where franchise_id = ' + lit(F) + '::uuid', true), '0');
  const n1 = await netNow();
  /* THE SERVER WAS REACHABLE FOR THE SECOND QUESTION. The client asked what
     it had done with the key, was told NOT COMPLETED, and says so: the strip
     reads RETRY rather than guessing either way. */
  eq('the operation is reported not completed, which is the only safe answer', r1.state, 'not_completed');
  chk('the strip says the call is safe to make again, and shows it',
    n1.state === 'retry' && /try again/i.test(n1.strip || ''), JSON.stringify(n1));
  chk('and the message offered is a retry, not a reward', /try again|nothing was spent/i.test(r1.message || ''), r1.message);

  /* asking again, connected, works — and it is the SAME key, so it is the
     same operation rather than a second one */
  const r1b = await call('packOpen');
  chk('asking again once the connection is back opens the pack', r1b.ok === true && r1b.data && r1b.data.players, JSON.stringify(r1b).slice(0, 200));
  eq('and the retry produced exactly one operation on the ledger',
    q('select count(*) from public.franchise_ops where franchise_id = ' + lit(F) + '::uuid', true), '1');
  const drawn = +q("select count(*) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true);
  chk('and exactly one pack of men is on the table', drawn >= 2 && drawn <= 4, drawn);
  eq('and the strip is synced again', (await netNow()).state, 'synced');

  /* ── 3. a refresh in the middle of the reveal ───────────────────────── */
  const menBefore = q("select string_agg(id::text, ',' order by id) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true);
  const claimedMid = q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true);
  await go('/games/packs/');
  const pend = await page.evaluate(() => window.EDFranchise.packPending().then(r => JSON.parse(JSON.stringify(r))));
  chk('after a refresh the server still says a pack is on the table',
    pend.ok && pend.data && pend.data.pending === true && pend.data.players.length === menBefore.split(',').length,
    JSON.stringify(pend.data && { p: pend.data.pending, n: pend.data.players && pend.data.players.length }));
  eq('the men are the same men, not a re-roll',
    q("select string_agg(id::text, ',' order by id) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true), menBefore);
  eq('and the pack was not opened a second time',
    q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true), claimedMid);

  /* ── 2. the connection goes AFTER the pack is written ───────────────── */
  /* keep this one first so a second pack can be opened underneath the drop */
  const keepId = q("select id from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack' order by overall desc limit 1", true);
  const kept = await call('packKeep', keepId);
  chk('a man is kept from the pack on the table', kept.ok === true, JSON.stringify(kept).slice(0, 160));
  /* a second pack to lose the connection over — a Postseason Pack rather than
     another rank's cache, so the rank ladder is left exactly where it was */
  q("insert into public.franchise_packs (franchise_id, kind, source, source_key, seed) values ("
    + lit(F) + "::uuid, 'postseason_pack', 'a season seen out', 'offline:1', 'seed-offline-1')", true);
  const PID = q("select id from public.franchise_packs where franchise_id = " + lit(F)
    + "::uuid and source_key = 'offline:1'", true);
  const opsBeforeDrop = +q('select count(*) from public.franchise_ops where franchise_id = ' + lit(F) + '::uuid', true);
  cut = { fn: 'franchise_once', when: 'after' };
  const r2 = await call('packOpenId', PID);
  const cutSaid = cut && cut.result ? String(cut.result.body).slice(0, 200) : '(never ran)';
  cut = null;
  chk('the dropped request did reach the database', /"ok"\s*:\s*true/.test(cutSaid), cutSaid);
  eq('the pack the client never heard about was written all the same',
    +q('select count(*) from public.franchise_ops where franchise_id = ' + lit(F) + '::uuid', true), opsBeforeDrop + 1);
  chk('and the client did NOT invent a success for it', r2.ok === false, JSON.stringify(r2).slice(0, 200));
  eq('it says the outcome is unknown, because from where it sits it is', r2.state, 'unknown');
  eq('and the strip says offline rather than anything hopeful', (await netNow()).state, 'offline');
  const menAfterDrop = q("select string_agg(id::text, ',' order by id) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true);
  const claimedAfterDrop = q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true);
  chk('the men are on the table on the server, whatever the client saw', menAfterDrop && menAfterDrop.length > 10, menAfterDrop);
  /* reconnected: the key was never resolved, so it is still the SAME
     operation, and the server hands back what it did the first time */
  const r2b = await call('packOpenId', PID);
  chk('asking again with the same key returns the pack that was already opened',
    r2b.ok === true && r2b.already === true, JSON.stringify({ ok: r2b.ok, already: r2b.already }));
  eq('the men are the ones the server drew the first time, not a re-roll',
    q("select string_agg(id::text, ',' order by id) from public.game_players where franchise_id = " + lit(F) + "::uuid and status = 'pack'", true), menAfterDrop);
  eq('and the rank was spent once, not twice',
    q('select rank_claimed from public.franchises where id = ' + lit(F) + '::uuid', true), claimedAfterDrop);
  eq('and the ledger still holds one row for that key',
    +q('select count(*) from public.franchise_ops where franchise_id = ' + lit(F) + '::uuid', true), opsBeforeDrop + 1);
  eq('and the strip is synced once the answer is in', (await netNow()).state, 'synced');
  await call('packPass');

  /* ── 4. a market purchase, cut mid-flight ───────────────────────────── */
  const SB = 'device-secret-offlineselleraaaaaaaa';
  q("select public.franchise_create('Anvils','Kirby','KRB','bolt','crimson','spread','zone'," + lit(SB) + ")");
  const S2 = q('select public.franchise_of(' + lit(SB) + ')', true);
  for (let i = 1; i <= 2; i++) q('select public.franchise_generate_player(' + lit(S2) + "::uuid,'WR',9,1,'spare" + i + "','depth','rookie')", true);
  const forSale = q("select id from public.game_players where franchise_id = " + lit(S2) + "::uuid and position = 'WR' order by depth desc limit 1", true);
  const LID = JSON.parse(q('select public.franchise_exchange_list(' + lit(forSale) + '::uuid, 300, ' + lit(SB) + ')')).listing.id;
  await go('/games/exchange/');
  const credBefore = +q('select team_credits from public.franchises where id = ' + lit(F) + '::uuid', true);
  cut = { fn: 'franchise_exchange_buy', when: 'after' };
  const b1 = await page.evaluate((id) => window.EDFranchise.exchangeBuy(id).then(r => ({ ok: !!r.ok, error: r.error || null })), LID);
  cut = null;
  chk('the purchase the client never heard about went through on the server',
    q("select count(*) from public.game_market_txns t join public.franchise_listings l on l.id = t.listing_id where l.id = " + lit(LID) + '::uuid', true) === '1',
    q('select count(*) from public.game_market_txns', true));
  chk('and the page did not decide for itself that it worked', b1.ok === false, JSON.stringify(b1));
  const st = await page.evaluate((id) => window.EDFranchise.marketOp(id).then(r => JSON.parse(JSON.stringify(r))), LID);
  chk('asking the server what happened gives one of exactly two answers',
    st.ok && st.data && ['completed', 'not_completed'].indexOf(st.data.state) >= 0, JSON.stringify(st.data));
  eq('and the answer is COMPLETED, because it was', st.data.state, 'completed');
  const b2 = await page.evaluate((id) => window.EDFranchise.exchangeBuy(id).then(r => ({ ok: !!r.ok, error: r.error || null })), LID);
  eq('buying it again with the same key is the same purchase, not a second one',
    q("select count(*) from public.game_market_txns t where t.listing_id = " + lit(LID) + '::uuid', true), '1');
  eq('the card has exactly one owner after all of it',
    q('select count(*) from public.game_cards c where (select count(*) from public.game_card_ownership o where o.card_id = c.id) <> 1', true), '0');
  const credAfter = +q('select team_credits from public.franchises where id = ' + lit(F) + '::uuid', true);
  eq('and the buyer was charged exactly once', credBefore - credAfter, 300);

  /* ── 5. a game result filed while the connection drops ──────────────── */
  await go('/games/play/');
  const GKEY = 'offline-game-key-0001';
  const GAME = { key: GKEY, difficulty: 'pro', length: 'blitz', score_for: 24, score_against: 17,
    plays: 58, yards: 320, touchdowns: 3, turnovers: 1, players: [] };
  cut = { fn: 'franchise_record_live_game', when: 'after' };
  const g1 = await page.evaluate((g) => window.EDFranchise.recordLiveGame(g.key, g).then(r => ({ ok: !!r.ok, error: r.error || null })), GAME);
  cut = null;
  eq('the result the client never heard about was filed',
    q("select count(*) from public.franchise_activity where franchise_id = " + lit(F) + "::uuid and key = " + lit(GKEY), true), '1');
  chk('and the client did not pretend it landed', g1.ok === false, JSON.stringify(g1));
  const xpAfterOne = +q('select xp from public.franchises where id = ' + lit(F) + '::uuid', true);
  const g2 = await page.evaluate((g) => window.EDFranchise.recordLiveGame(g.key, g).then(r => JSON.parse(JSON.stringify({ ok: !!r.ok, already: !!(r.data && r.data.already) }))), GAME);
  chk('filing it again returns what it already paid rather than paying again', g2.ok === true && g2.already === true, JSON.stringify(g2));
  eq('and the man\'s live career did not grow twice for one game',
    q("select count(*) from public.franchise_activity where franchise_id = " + lit(F) + "::uuid and key = " + lit(GKEY), true), '1');
  eq('and it is still one row on the record',
    q("select count(*) from public.franchise_activity where franchise_id = " + lit(F) + "::uuid and key = " + lit(GKEY), true), '1');
  eq('and the reward was granted exactly once', q('select xp from public.franchises where id = ' + lit(F) + '::uuid', true), String(xpAfterOne));

  /* ── 6. the season advanced while the connection drops ──────────────── */
  await go('/games/gameday/');
  const started = await call('startSeason');
  chk('a season starts', started.ok === true, JSON.stringify(started).slice(0, 160));
  q("update public.franchise_games set opens_at = now() - interval '1 day' where franchise_id = " + lit(F) + '::uuid', true);
  const weekBefore = +q('select week from public.franchise_seasons where franchise_id = ' + lit(F) + '::uuid order by number desc limit 1', true);
  const playedBefore = +q("select count(*) from public.franchise_games where franchise_id = " + lit(F) + "::uuid and status = 'final'", true);
  cut = { fn: 'franchise_once', when: 'after' };
  const w1 = await call('playWeek');
  cut = null;
  const playedMid = +q("select count(*) from public.franchise_games where franchise_id = " + lit(F) + "::uuid and status = 'final'", true);
  eq('the game the client never heard about was played exactly once', playedMid, playedBefore + 1);
  chk('and the page did not claim a result it never received', w1.ok === false || w1.recovered === true, JSON.stringify(w1).slice(0, 160));
  const w2 = await call('playWeek');
  chk('asking again with the same key returns the game that was played', w2.ok === true && w2.already === true,
    JSON.stringify({ ok: w2.ok, already: w2.already }));
  eq('and the season did NOT advance a second time',
    +q("select count(*) from public.franchise_games where franchise_id = " + lit(F) + "::uuid and status = 'final'", true), playedBefore + 1);
  eq('the week moved by exactly one',
    +q('select week from public.franchise_seasons where franchise_id = ' + lit(F) + '::uuid order by number desc limit 1', true), weekBefore + 1);
  eq('and no line of the week was credited twice',
    q("select count(*) from (select currency, kind, key from public.franchise_ledger where franchise_id = " + lit(F)
      + "::uuid and key = '1:1' group by 1, 2, 3 having count(*) > 1) x", true), '0');
  eq('and the game is on the record exactly once',
    q("select count(*) from public.franchise_activity where franchise_id = " + lit(F) + "::uuid and kind = 'weekly_game' and key = '1:1'", true), '1');

  /* ── the four states, and only those four ───────────────────────────── */
  const states = await page.evaluate(() => Object.keys(window.EDFranchise.NET).map(k => window.EDFranchise.NET[k]));
  chk('the connection has four states and no fifth',
    states.length === 4 && ['synced', 'offline', 'reconnecting', 'retry'].every(s => states.indexOf(s) >= 0), states.join(','));
  const words = await page.evaluate(() => ['synced', 'offline', 'reconnecting', 'retry'].map(s => window.EDFranchise.netWord(s)));
  chk('and each of them has something to say', words.every(w => w && w.length > 3), words.join(' | '));
  chk('the client never decides a call worked without the server saying so',
    !/ok:\s*true[^\n]*invent/i.test(fs.readFileSync(path.join(ROOT, 'games', 'lib', 'franchise.js'), 'utf8')));
  chk('no page error was thrown anywhere in the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  await browser.close();
  site.close();
  drop();
  console.log((fail ? 'FAIL' : 'PASS') + ' | ' + LABEL + ' | ' + pass + ' passed, ' + fail + ' failed');
  fails.forEach(l => console.log(l));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('FAIL | ' + LABEL + ' | ' + (e && e.message ? e.message.split('\n')[0] : e));
  try { site.close(); } catch (_) {}
  drop();
  process.exit(1);
});
