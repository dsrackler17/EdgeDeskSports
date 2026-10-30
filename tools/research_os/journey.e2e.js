#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH OS, END TO END — one reader's journey through the terminal in
   Chromium, against the SHIPPED migrations on a real PostgreSQL (through the
   PostgREST stand-in, tools/billing/_pgrest.js), at a desktop and a phone.
   docs/research-os/DESIGN.md · docs/research-os/REPORT.md §7

   The database holds production's billing rule and operator list, and, as
   shipped: the personal research layer (watchlist, research state), the
   Portfolio book and journal, the Simulator, Market Foresight (a real
   committed game measured by the real worker), Signal Center and the Research
   OS navigation events. The bearer token decides the reader, as PostgREST
   does: a subscriber, a free account, an operator, or nobody.

     journey   Overview → a game's Research → Signals → Market Foresight →
               Simulator → My Card → Portfolio → Performance, the game carried
               from feature to feature by its ids (never re-found); the AI
               desk handed the same ids; search; Back / Forward; refresh
     counts    every Overview figure equals what the slate and the database
               hold (games today, the watchlist's server-side "changed", the
               Simulator's published run, Signal Center's state)
     access    a free account meets the paywall, and the doors the terminal's
               new views read give it nothing they hold back: no Foresight
               timeline, no simulation rows, no other reader's watchlist or
               book, no signal numbers; the operator sees shadow mode
     wiring    no page error; no listener added twice by moving around; no
               horizontal scroll at 390 / 768 / 1280 / 1440
     rollback  supabase/research_os.sql applies twice, its rollback removes
               only its four rows, and it applies again

   The game is chosen from the committed slate and game-research snapshot, with
   the browser's clock pinned just after the slate was built, so the run is
   repeatable on any day the repository's data covers.
   Run: node tools/research_os/journey.e2e.js     (JOURNEY_SHOTS=<dir> keeps screenshots)
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const NAV = require(path.join(ROOT, 'tools', 'app', 'nav_helper.js'));
const MF = require(path.join(ROOT, 'tools', 'foresight', '_terminal.js'));
const G = require(path.join(ROOT, 'lib', 'edgedesk_games.js'));
const T = PG.kit('Research OS journey (Chromium, real PostgreSQL)');
const lit = PG.lit;
const SHOTS = process.env.JOURNEY_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ros-journey-'));
const SB = 'https://iattxbkbufslbauoumga.supabase.co';
const ZONE = 'America/Chicago';
const SUB = '00000000-0000-0000-0000-0000000000a1', FREE = '00000000-0000-0000-0000-0000000000b2', ADMIN = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';
const TOK = { sub: 'tok-sub', free: 'tok-free', admin: 'tok-admin' };

let pw = null;
try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
if (!pw) { if (process.env.ROS_E2E_REQUIRED === '1') { T.chk('playwright is installed (required in CI)', false); process.exit(T.done()); } console.log('SKIPPED (not verified): playwright is not installed here'); process.exit(0); }

/* ---------------------------------------------------------------- the game */
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'today', 'slate.json'), 'utf8'));
const SNAPS = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
const CLOCK = Date.parse(SLATE.generated_at) + 20 * 60000;
const snapBy = {}; (SNAPS.games || []).forEach((g) => { snapBy[g.game_key] = g; });
const GAME = (SLATE.events || []).concat(SLATE.upcoming || [])
  .filter((e) => (e.sport === 'nfl' || e.sport === 'cfb') && e.research && e.research.game_key && snapBy[e.research.game_key] && !snapBy[e.research.game_key].started
    && !e.time_tbd && Date.parse(e.start_utc) > CLOCK + 3600e3 && e.status === 'SCHEDULED')
  .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc) || (a.id < b.id ? -1 : 1))[0];
if (!GAME) {
  const why = 'the committed slate holds no upcoming NFL or FBS game with a research snapshot at ' + new Date(CLOCK).toISOString();
  if (process.env.ROS_E2E_REQUIRED === '1') { T.chk('a journey game exists in the committed slate (required in CI)', false, why); process.exit(T.done()); }
  console.log('SKIPPED (not verified): ' + why); process.exit(0);
}
const KEY = GAME.research.game_key, LG = KEY.split('|')[0], GID = KEY.split('|')[1];
const DESK_SPORT = LG === 'nfl' ? 'americanfootball_nfl' : 'americanfootball_ncaaf';
const HOME = GAME.home.name, AWAY = GAME.away.name;
/* the game page names the game as its research snapshot does (app.html gvCtx), and so does the
   context it sets; the slate can name the same club longer: "Western Kentucky Hilltoppers" on the
   slate, "Western Kentucky" in the snapshot (cfb|401871071, 2026-10-27) */
const SNAP_HOME = (snapBy[KEY].home || {}).name, SNAP_AWAY = (snapBy[KEY].away || {}).name;
const DAY = G.dateKey(Date.parse(GAME.start_utc), ZONE), TODAY = G.today(CLOCK, ZONE);
const TODAY_N = G.select(SLATE.events.concat(SLATE.upcoming || []), { zone: ZONE, now: CLOCK, date: TODAY }).total_day;
console.log('the journey game: ' + AWAY + ' at ' + HOME + ' (' + KEY + ', ' + GAME.id + ', ' + GAME.start_utc + '), clock ' + new Date(CLOCK).toISOString() + ', ' + TODAY_N + ' games on ' + TODAY);

/* ---------------------------------------------------------------- the database */
const db = PG.start('rosjourney');
if (db.skip) { if (process.env.ROS_SQL_REQUIRED === '1') { T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip); process.exit(T.done()); } console.log('SKIPPED (not verified): ' + db.skip); process.exit(0); }
const F = (n) => path.join(ROOT, 'supabase', n);
const slice = (src, start, end) => { const i0 = src.indexOf(start); if (i0 < 0) throw new Error('not found: ' + start); return src.slice(i0, src.indexOf(end, i0) + end.length); };
const okApply = (name, twice) => { let out = db.applyFile(F(name)); T.chk(name + ' applies, every report row ok', !/CHECK THIS/.test(out), out.slice(-400)); if (twice) { out = db.applyFile(F(name)); T.chk(name + ' applies a second time', !/CHECK THIS/.test(out), out.slice(-400)); } return out; };

function setupDb() {
  const BH = fs.readFileSync(F('billing_hardening.sql'), 'utf8'), FU = fs.readFileSync(F('funnel.sql'), 'utf8');
  db.sql(`create table public.subscriptions (user_id uuid, status text, price_id text, current_period_end timestamptz);
    ${slice(BH, 'create or replace function public.billing_row_in_good_standing(', '-- THE ACCESS RULE')}
    ${slice(BH, 'create or replace function public.billing_row_grants_access(', '$$;')}
    ${slice(BH, 'create or replace function public.billing_is_admin()', '$$;')}
    create or replace function public.community_is_entitled(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as $b$
      select exists (select 1 from public.subscriptions s where s.user_id = p_user and public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now())); $b$;
    insert into auth.users (id, email) values (${lit(SUB)}, 'sub@x'), (${lit(FREE)}, 'free@x'), (${lit(ADMIN)}, 'op@x');
    insert into public.subscriptions values (${lit(SUB)}, 'active', 'price_x', now() + interval '20 days'), (${lit(ADMIN)}, 'active', 'price_x', now() + interval '20 days');
    ${slice(FU, 'create table if not exists public.user_event_kinds (', '\n);')}`);
  okApply('personal_research.sql');
  db.applyFileAtomic(F('portfolio.sql'));
  db.applyFileAtomic(F('portfolio_journal.sql'));
  okApply('simulator.sql');
  MF.install(db);
  db.sql('drop extension if exists pgcrypto cascade; create schema if not exists extensions; create extension pgcrypto with schema extensions;');
  okApply('signal_center.sql');
  db.sql(`update public.sc_config set value = '"live"' where key = 'mode';`);
  /* the navigation events: apply twice, roll back, apply again */
  let out = okApply('research_os.sql', true);
  const reg = () => +db.sql("select count(*) from public.user_event_kinds where source = 'client' and event_name in ('primary_nav_overview','primary_nav_foresight','primary_nav_performance','primary_nav_simulator');");
  T.chk('research_os.sql registers its four navigation events', reg() === 4 && /\bok\b/.test(out), out.slice(-300));
  db.applyFile(F('research_os_rollback.sql'));
  T.chk('its rollback removes exactly those four', reg() === 0 && +db.sql("select count(*) from public.user_event_kinds;") > 0);
  okApply('research_os.sql');
  T.chk('and it applies again', reg() === 4);

  /* the reader's own rows */
  db.sql(`insert into public.user_preferences (user_id, onboarding_status) values (${lit(SUB)}, 'skipped'), (${lit(ADMIN)}, 'skipped');`);
  /* the journey game is on the subscriber's watchlist, and EdgeDesk's research state changed since they saw it */
  db.sql(`insert into public.game_research_state (game_key, sport, game_id, home, away, kickoff_at, status, projected, state, state_hash, computed_at, key_reason)
      values (${lit(KEY)}, ${lit(LG)}, ${lit(GID)}, ${lit(HOME)}, ${lit(AWAY)}, ${lit(GAME.start_utc)}, 'RESEARCH', true, '{}'::jsonb, 'rs1-now', now(), 'The fair line moved.');
    insert into public.watchlist_games (user_id, game_key, home, away, kickoff_at, seen_hash, last_seen_at) values (${lit(SUB)}, ${lit(KEY)}, ${lit(HOME)}, ${lit(AWAY)}, ${lit(GAME.start_utc)}, 'rs1-then', now() - interval '1 day');`);
  /* a settled book for the subscriber, positions placed by hand */
  const pos = (o) => db.as(SUB, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, stake, odds_american, status, placed_at, settled_at, sport, source)
    values ('draftkings', 'DraftKings', 'SPORTSBOOK', 'MONEYLINE', ${lit(o.ev)}, 'Moneyline', ${lit(o.sel)}, '100', ${lit(o.odds)}, ${lit(o.st)}, '2026-09-0${o.d}T12:00:00Z', '2026-09-0${o.d}T23:00:00Z', 'NFL', 'MANUAL');`);
  pos({ ev: 'Game one', sel: 'Side one', odds: '+120', st: 'WON', d: 1 });
  pos({ ev: 'Game two', sel: 'Side two', odds: '-110', st: 'LOST', d: 2 });
  pos({ ev: 'Game three', sel: 'Side three', odds: '+150', st: 'WON', d: 3 });
  /* one published Simulator run: what the Overview names, and nothing it may not */
  db.sql(`insert into public.sim_runs (run_id, sport, competition, season, idempotency_key, seed, prng_version, n_sims, model_version, engine_version, rules_version, config_hash, input_snapshot_at, input_ref, input_hash, status, completed_at)
      values ('5e000000-0000-0000-0000-000000000001', 'nfl', 'nfl', '2026', ${lit('a'.repeat(64))}, '77', 'pcg32', 100000, 'edgedesk_nfl_v2', 'sim-1', 'nfl-2026', ${lit('b'.repeat(64))}, ${lit(new Date(CLOCK - 5 * 3600e3).toISOString())}, 'test', ${lit('c'.repeat(64))}, 'completed', ${lit(new Date(CLOCK - 3 * 3600e3).toISOString())});
    insert into public.sim_published (sport, competition, season, run_id, input_snapshot_at, published_at) values ('nfl', 'nfl', '2026', '5e000000-0000-0000-0000-000000000001', ${lit(new Date(CLOCK - 5 * 3600e3).toISOString())}, ${lit(new Date(CLOCK - 3 * 3600e3).toISOString())});`);
  /* (times are relative to the browser's pinned clock, so "published 3 h ago" is what a reader at that moment sees) */
}

/* the requests the shipped migrations answer; everything else the terminal reads is not part of this test */
/* (edp_track, the trial-activation door, stands on the whole billing, Stripe and affiliate stack (supabase/growth.sql):
   it is not part of this test, so it answers like any door this test does not serve) */
const SERVED = /\/rest\/v1\/(rpc\/(sc_[a-z_]+|sim_[a-z_]+|portfolio_[a-z_]+)|(my_watchlist|watchlist_games|user_preferences|alert_preferences|user_alerts|game_research_state|research_journal|sim_current_[a-z_]+|portfolio_[a-z_]+|platform_accounts)\b)/;
/* Market Foresight's game door answers late, as it did on a slow runner (#924's phone run, 2026-10-30):
   the game page draws its Foresight card first and adds the record's link when this answers */
const MF_GAME_LATE_MS = 2000;

(async function main() {
  let browser = null, srv = null;
  try {
    setupDb();
    const stand = REST.make(db, { serviceKey: 'svc-key-ros', tokens: { [TOK.sub]: { id: SUB, email: 'sub@x' }, [TOK.free]: { id: FREE, email: 'free@x' }, [TOK.admin]: { id: ADMIN, email: 'op@x' } } });
    const M = await MF.measure(db, stand, ADMIN);
    console.log('the measured record: ' + M.away + ' at ' + M.home + ' (' + M.sport + ' ' + M.eventId + ', a finished game from the committed ledgers)');
    MF.mode(db, ADMIN, 'live');
    T.chk('a committed game is measured by the shipped worker', !!M.eventId, M);
    const door = async (who, url, body) => { const r = await stand.fetch('http://standin/rest/v1/' + url, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + (who ? TOK[who] : 'anon-key'), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { j = t; } return { status: r.status, ok: r.ok, j }; };

    /* ============================================================ access, at the doors */
    {
      const summary = { p_from: '2000-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z', p_tz: null, p_platform: null };
      const mine = await door('sub', 'rpc/portfolio_summary', summary), theirs = await door('free', 'rpc/portfolio_summary', summary), anon = await door(null, 'rpc/portfolio_summary', summary);
      T.chk('the book: a subscriber reads their own settled positions', mine.ok && mine.j.settled.n === 3, mine.j && mine.j.settled);
      T.chk('a free account reads none of them', theirs.ok && theirs.j.settled.n === 0, theirs.j && theirs.j.settled);
      T.chk('and nobody reads it signed out', !anon.ok, anon.status);
      const wSub = await door('sub', 'my_watchlist?select=game_key,changed'), wFree = await door('free', 'my_watchlist?select=game_key,changed');
      T.chk('the watchlist: the subscriber\'s game, marked changed by the server', wSub.ok && wSub.j.length === 1 && wSub.j[0].changed === true, wSub.j);
      T.chk('and no other reader sees it', wFree.ok && wFree.j.length === 0, wFree.j);
      const simSub = await door('sub', 'sim_current_runs?select=run_id'), simFree = await door('free', 'sim_current_runs?select=run_id'), simPub = await door(null, 'rpc/sim_public_status', {});
      T.chk('the Simulator: anyone may know a run is published (no number in it)', simPub.ok && simPub.j.some((r) => r.sport === 'nfl' && r.published_run_id) && !JSON.stringify(simPub.j).match(/probab/i), simPub.j);
      T.chk('a subscriber reads the run itself; a free account reads nothing', simSub.ok && simSub.j.length === 1 && simFree.ok && simFree.j.length === 0, [simSub.j, simFree.j]);
      const GD = MF.gameDoor(M.sport, M.eventId);
      const gSub = await door('sub', GD[0], GD[1]), gFree = await door('free', GD[0], GD[1]);
      T.chk('Foresight (live): Full Access reads the timeline with raw prices', gSub.ok && gSub.j.found && gSub.j.full_access === true && /segments/.test(JSON.stringify(gSub.j.game)), gSub.j && Object.keys(gSub.j));
      T.chk('a free account reads findings, never the timeline\'s raw prices', gFree.ok && gFree.j.found && gFree.j.full_access === false && !/"segments"/.test(JSON.stringify(gFree.j.game)), gFree.j && gFree.j.full_access);
      MF.mode(db, ADMIN, 'shadow');
      const shFree = await door('free', GD[0], GD[1]), shSub = await door('sub', GD[0], GD[1]), shAdmin = await door('admin', GD[0], GD[1]);
      T.chk('Foresight (shadow): readers, paying or not, are locked out; the operator is not', shFree.j.locked === true && shSub.j.locked === true && shAdmin.j.found === true, [shFree.j, shSub.j && shSub.j.locked, shAdmin.j && shAdmin.j.found]);
      MF.mode(db, ADMIN, 'live');
      const scFree = await door('free', 'rpc/sc_feed', { p_filters: {}, p_cursor: null, p_limit: 5 }), scStatus = await door(null, 'rpc/sc_status', {});
      T.chk('Signal Center: a free account gets the number-free preview', scFree.ok && /not_entitled/.test(JSON.stringify(scFree.j)), scFree.j && Object.keys(scFree.j));
      T.chk('and anyone may read its status (live here)', scStatus.ok && scStatus.j.mode === 'live' && scStatus.j.entitled === false, scStatus.j);
    }

    /* ============================================================ the site */
    srv = await new Promise((resolve) => {
      const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
      const s = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        let f = path.join(ROOT, path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, ''));
        if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
        if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
        if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
        fs.createReadStream(f).pipe(res);
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const BASE = 'http://127.0.0.1:' + srv.address().port;
    try { browser = await pw.chromium.launch({ headless: true }); }
    catch (e) { if (fs.existsSync('/opt/pw-browsers/chromium')) browser = await pw.chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' }); else throw e; }

    async function open(viewport, who, hash, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport, timezoneId: ZONE, locale: 'en-US', deviceScaleFactor: 1 });
      const ai = [], served = [], refused = [];
      await ctx.addInitScript((x) => {
        try {
          /* count every listener added to document, window and the shell's hosts, by event type */
          if (!window.__lc) { window.__lc = {}; const add = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (t, f, op) { const who = this === document ? 'document' : this === window ? 'window' : (this && this.id) || null; if (who) { const k = who + ':' + t; window.__lc[k] = (window.__lc[k] || 0) + 1; } return add.call(this, t, f, op); }; }
          if (sessionStorage.getItem('__ros')) return;
          sessionStorage.setItem('__ros', '1');
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
          localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ steps: {}, done_at: '2026-01-01T00:00:00Z' }));
          localStorage.setItem('edgedesk_setup_v1', String(Date.now()));
          if (x.token) localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: x.token, refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: x.uid, email: x.uid + '@x', created_at: '2025-01-01T00:00:00Z' } }));
        } catch (e) { /* storage */ }
      }, { token: TOK[who], uid: who === 'sub' ? SUB : who === 'free' ? FREE : ADMIN });
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await ctx.route('**/*', async (route) => {
        const req = route.request(), url = req.url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.indexOf(SB) === 0) {
          if (/\/functions\/v1\/edgedesk_ai/.test(url)) { ai.push(req.postData() || ''); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'The desk answered from the research packet (test).', model: null }) }); }
          if (/\/rest\/v1\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(who === 'free' ? [] : [{ status: 'active', price_id: 'price_x', current_period_end: '2027-06-01T00:00:00Z' }]) });
          if (MF.owns(url) || SERVED.test(url)) {
            served.push(url.replace(SB, ''));
            if (MF.readsRecord(url)) await new Promise((r) => setTimeout(r, MF_GAME_LATE_MS));
            const h = req.headers();
            const res = await stand.fetch(url.replace(SB, 'http://standin'), { method: req.method(), headers: { authorization: h.authorization || '', prefer: h.prefer || '', 'content-type': 'application/json' }, body: req.postData() || undefined });
            const text = await res.text();
            if (res.status >= 400) refused.push(res.status + ' ' + url.replace(SB, '') + ' ' + text.slice(0, 200));
            return route.fulfill({ status: res.status, contentType: 'application/json', body: text });
          }
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202","message":"not part of this test"}' });
        }
        return route.fulfill({ status: 204, body: '' });
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 240)));
      await page.clock.install({ time: CLOCK });
      await page.goto(BASE + '/app.html' + (hash || ''), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.show === 'function' && !!window.EDOverview && !!window.EDShell, null, { timeout: 40000 });
      return { ctx, page, errors, ai, served, refused };
    }
    const st = (page) => page.evaluate(() => ({ views: [...document.querySelectorAll('section.view')].filter((v) => !v.classList.contains('hide')).map((v) => v.id), seat: [...document.querySelectorAll('.bottomnav button.on[data-v]')].map((b) => b.dataset.v), hash: location.hash,
      ctx: window.EDContext && window.EDContext.get(), screen: window.edScreenGet && window.edScreenGet() }));
    const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    /* what sticks out, when something does */
    const wide = (page) => page.evaluate(() => { const W = document.documentElement.clientWidth, out = [];
      document.querySelectorAll('main *').forEach((e) => { const b = e.getBoundingClientRect(); if (b.width && b.right > W + 1 && e.offsetParent !== null && out.length < 6) out.push(e.tagName + '.' + String(e.className).slice(0, 30) + ' ' + Math.round(b.right)); }); return out; });
    const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {});
    /* a seat tapped where the reader sees it: the sidebar, the bar, or Menu (tools/app/nav_helper.js) */
    const seat = (page, v) => NAV.go(page, v);
    /* a summary tile as words (its label is uppercased by CSS, so read the text, not what is drawn) */
    const tile = (page, k) => page.evaluate((x) => { const t = [...document.querySelectorAll('#ovSum .ov-tile')].filter((e) => e.querySelector('.ov-tk') && e.querySelector('.ov-tk').textContent.trim().toLowerCase() === x)[0];
      return t ? ['.ov-tk', '.ov-tv', '.ov-ts'].map((c) => (t.querySelector(c) || {}).textContent || '').join(' ').replace(/\s+/g, ' ').trim() : ''; }, k);

    for (const vp of [{ width: 1440, height: 900, name: 'desktop' }, { width: 390, height: 844, name: 'phone' }]) {
      const W = vp.name;
      const S = await open(vp, 'sub', '');
      const page = S.page;
      /* ---------------------------------------------------------------- 1 Overview */
      let s = await st(page);
      T.chk(W + ': a reader with nothing saved lands on the Overview', s.views.join() === 'v-overview' && s.seat.join() === 'overview' && s.hash === '#overview', s);
      await page.waitForSelector('#ovQ .ovq-r[data-ov-row]', { timeout: 20000 });
      await page.waitForFunction(() => /changed since you last looked/.test((document.getElementById('ovSum') || {}).textContent || ''), null, { timeout: 25000 }).catch(() => null);
      await page.waitForFunction(() => /simulated seasons/.test((document.getElementById('ovSide') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
      T.chk(W + ': Games today is the slate\'s own count for the reader\'s day (' + TODAY_N + ')', new RegExp('^Games today ' + TODAY_N + ' ').test(await tile(page, 'games today')), await tile(page, 'games today'));
      T.chk(W + ': the watchlist\'s server-side "changed" reaches the Overview', /^Saved, needs a look 1 saved game changed since you last looked/.test(await tile(page, 'saved, needs a look')), await tile(page, 'saved, needs a look'));
      T.chk(W + ': Signal Center\'s live state is read from its doors (no signals published here)', /^Signals 0 published in 24 h/.test(await tile(page, 'signals')), await tile(page, 'signals'));
      const side = await page.textContent('#ovSide');
      T.chk(W + ': the Simulator\'s published run is named with its size, model and time — and no probability', /100,000 simulated seasons · model edgedesk_nfl_v2 · published 3 h ago/.test(side) && !/\d+(\.\d+)?%/.test(side.slice(side.indexOf('Simulator'), side.indexOf('Your workspace'))), side.slice(side.indexOf('Simulator'), side.indexOf('Simulator') + 300));
      await page.waitForFunction(() => /Live\./.test((document.getElementById('ovSide') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
      T.chk(W + ': Market Foresight\'s status is read from its door (live)', /Market Foresight[\s\S]*Live\./.test(await page.textContent('#ovSide')));
      if (DAY === TODAY) T.chk(W + ': the journey game is in Today\'s queue, by its slate id', await page.$('#ovQ .ovq-r[data-ov-row="' + GAME.id + '"]') !== null);
      else { await page.click('#ovTab-upcoming'); T.chk(W + ': the journey game is in Upcoming, by its slate id', await page.$('#ovQ .ovq-r[data-ov-row="' + GAME.id + '"]') !== null); }
      const row = await page.textContent('#ovQ .ovq-r[data-ov-row="' + GAME.id + '"]');
      T.chk(W + ': its row says it is saved', /watchlist/.test(row), row.slice(0, 300));
      await page.click('#ovTab-changed');
      T.chk(W + ': Changed lists it under the watchlist, with the server\'s reason', /The fair line moved/.test(await page.textContent('#ovQ')));
      T.chk(W + ': no horizontal scroll on the Overview', await noHScroll(page));
      await shot(page, W + '-1-overview');
      await page.click('#ovTab-' + (DAY === TODAY ? 'today' : 'upcoming'));

      /* ---------------------------------------------------------------- 2 the game's research */
      await page.click('#ovQ .ovq-r[data-ov-row="' + GAME.id + '"] a[data-ov-open]');
      await page.waitForSelector('#gvWs', { timeout: 30000 });
      s = await st(page);
      T.chk(W + ': Open research lands on the game\'s own page, by its research key', s.views.join() === 'v-game' && s.hash === '#game/' + LG + '/' + GID && s.seat.join() === 'research', s);
      T.chk(W + ': the game is the research context', s.ctx && s.ctx.researchKey === KEY && !!SNAP_HOME && s.ctx.home === SNAP_HOME && !!SNAP_AWAY && s.ctx.away === SNAP_AWAY, s.ctx);
      T.chk(W + ': and the AI desk\'s screen, by the card\'s own id and sport key', s.screen && s.screen.game_id === GID && s.screen.sport === DESK_SPORT, s.screen);
      /* the Foresight card links its record once Market Foresight's door answers */
      await page.waitForFunction(() => { const e = document.getElementById('gvWsFs'); return !!e && !/Checking the record/.test(e.textContent); }, null, { timeout: 15000 }).catch(() => null);
      const links = await page.$$eval('#gvWs a[href]', (as) => as.map((a) => a.getAttribute('href')));
      T.chk(W + ': the workspace links Signals, Foresight and the Simulator for this game', links.indexOf('#signals/' + LG) >= 0 && links.indexOf('#foresight/game/' + encodeURIComponent(LG + ':' + GID)) >= 0 && (LG !== 'nfl' || links.indexOf('#simulator/nfl') >= 0), links);
      T.chk(W + ': no horizontal scroll on the game', await noHScroll(page));
      await page.evaluate(() => { const e = document.getElementById('gvWs'); if (e) e.scrollIntoView(); });
      await shot(page, W + '-2-game');

      /* ---------------------------------------------------------------- 3 Signals, and back */
      await page.click('#gvWs a[href="#signals/' + LG + '"]');
      await page.waitForSelector('#scHost #sc-status', { timeout: 20000 });
      s = await st(page);
      T.chk(W + ': Signals opens on the game\'s sport', s.views.join() === 'v-signals' && s.hash === '#signals/' + LG && s.seat.join() === 'signals', s);
      T.chk(W + ': with Signal Center\'s live state from its doors', /Live/.test(await page.textContent('#scHost #sc-status')));
      T.chk(W + ': the research context survives the move', (await st(page)).ctx.researchKey === KEY);
      await page.goBack();
      await page.waitForSelector('#gvWs', { timeout: 20000 });
      s = await st(page);
      T.chk(W + ': Back returns to the same game', s.views.join() === 'v-game' && s.hash === '#game/' + LG + '/' + GID, s);

      /* ---------------------------------------------------------------- 4 Market Foresight */
      await page.waitForFunction(() => { const e = document.getElementById('gvWsFs'); return !!e && !/Checking the record/.test(e.textContent); }, null, { timeout: 15000 }).catch(() => null);
      T.chk(W + ': the game page previews its Foresight record (not measured before kickoff)', /Not in the record yet/.test(await page.textContent('#gvWsFs')), await page.textContent('#gvWsFs'));
      await page.click('#gvWsFs a[href^="#foresight/game/"]');
      /* the page says the methodology once the status door answers, then the game's own answer replaces it */
      await page.waitForFunction(() => { const e = document.getElementById('mf-status'); return !!e && /in the record|could not|switched off|not been deployed/i.test(e.textContent); }, null, { timeout: 30000 }).catch(() => null);
      s = await st(page);
      T.chk(W + ': Market Foresight opens inside the terminal on the same game', s.views.join() === 'v-foresight' && s.hash === '#foresight/game/' + encodeURIComponent(LG + ':' + GID) && s.seat.join() === 'foresight', s);
      T.chk(W + ': and says, from its own door, that the game is not measured yet', /not in the record/i.test(await page.textContent('#mf-status')), await page.textContent('#mf-status'));
      await page.evaluate((h) => { location.hash = h; }, '#foresight/game/' + encodeURIComponent(M.sport + ':' + M.eventId));
      await page.waitForSelector(MF.SEL.timeline, { timeout: 30000 });
      T.chk(W + ': a measured game draws its record in the terminal, Full Access timeline included', await page.locator(MF.SEL.timeline).count() === 3 && /at/.test(await page.textContent(MF.SEL.title)));
      T.chk(W + ': the terminal keeps its title (the record does not take it over)', /EdgeDesk/.test(await page.title()) && !/Market Foresight \|/.test(await page.title()), await page.title());
      T.chk(W + ': no horizontal page scroll on the record', await noHScroll(page), await wide(page));
      await shot(page, W + '-3-foresight');
      await page.click('#mf-crumbs a[href="#foresight"]');
      await page.waitForSelector('#v-foresight .mf-games li a', { timeout: 30000 });
      s = await st(page);
      T.chk(W + ': its overview, in the terminal', s.hash === '#foresight' && s.views.join() === 'v-foresight', s);
      await page.click('#v-foresight .mf-games li a >> nth=0');
      await page.waitForFunction(() => /^#foresight\/game\//.test(location.hash));
      T.chk(W + ': a game link in the record stays in the terminal', /^#foresight\/game\//.test((await st(page)).hash) && (await st(page)).views.join() === 'v-foresight');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.show === 'function');
      await page.waitForSelector(MF.SEL.findings, { timeout: 30000 });
      T.chk(W + ': refresh keeps the record on screen', (await st(page)).views.join() === 'v-foresight' && /^#foresight\/game\//.test((await st(page)).hash));

      /* ---------------------------------------------------------------- 5 Simulator */
      await page.evaluate((h) => { location.hash = h; }, '#game/' + LG + '/' + GID);
      await page.waitForSelector('#gvWs', { timeout: 30000 });
      if (LG === 'nfl') {
        await page.click('#gvWs a[href="#simulator/nfl"]');
        await page.waitForSelector('#simHost .sm-sports', { timeout: 20000 });
        s = await st(page);
        T.chk(W + ': the Simulator opens on the game\'s sport', s.views.join() === 'v-simulator' && s.seat.join() === 'simulator' && /aria-current="page"[^>]*>NFL|sm-sport on" data-sim-sport="nfl"/.test(await page.innerHTML('#simHost .sm-sports')), s);
      } else {
        await seat(page, 'simulator');
        await page.waitForSelector('#simHost .sm-sports', { timeout: 20000 });
        T.chk(W + ': the Simulator opens', (await st(page)).views.join() === 'v-simulator');
      }
      await page.waitForFunction(() => { const b = document.getElementById('simBody'); return !!b && !/Loading/.test(b.textContent); }, null, { timeout: 20000 }).catch(() => null);
      T.chk(W + ': and reads the published run through its own doors (no error card)', await page.locator('#simBody .sm-err').count() === 0 && await page.locator('#simBody').count() === 1, await page.textContent('#simBody').catch(() => null));
      await shot(page, W + '-4-simulator');

      /* ---------------------------------------------------------------- 6 My Card, 7 Portfolio, 8 Performance */
      await seat(page, 'card');
      s = await st(page);
      T.chk(W + ': My Card', s.views.join() === 'v-card' && s.seat.join() === 'card' && s.hash === '#card', s);
      await seat(page, 'portfolio');
      s = await st(page);
      T.chk(W + ': Portfolio', s.views.join() === 'v-portfolio' && s.seat.join() === 'portfolio', s);
      await page.waitForFunction(() => /\$/.test((document.getElementById('pfoHost') || {}).textContent || ''), null, { timeout: 20000 }).catch(() => null);
      await shot(page, W + '-5-portfolio');
      await seat(page, 'performance');
      await page.waitForFunction(() => /Settled positions/.test((document.getElementById('pfhMine') || {}).textContent || '') && /Right winner/.test((document.getElementById('pfhModel') || {}).textContent || ''), null, { timeout: 20000 }).catch(() => null);
      s = await st(page);
      T.chk(W + ': Performance', s.views.join() === 'v-performance' && s.seat.join() === 'performance' && s.hash === '#performance', s);
      const mineTxt = await page.textContent('#pfhMine');
      const sumSub = (await door('sub', 'rpc/portfolio_summary', { p_from: '2000-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z', p_tz: null, p_platform: null })).j.settled;
      T.chk(W + ': your record is the server\'s sum of your own positions (' + sumSub.n + ' settled, ' + sumSub.pnl + ')', new RegExp('Settled positions\\s*' + sumSub.n).test(mineTxt) && /2–1/.test(mineTxt) && mineTxt.indexOf('$' + Number(sumSub.pnl).toFixed(2)) >= 0, mineTxt.slice(0, 300));
      const perf = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance', 'data', 'summary.json'), 'utf8'));
      T.chk(W + ': EdgeDesk\'s record is the ledger\'s own summary, one row per sport', await page.locator('#pfhModel tbody tr').count() === Object.keys(perf.by_sport).length && (await page.textContent('#pfhModel')).indexOf(String(perf.headline.verified.winner.n)) >= 0);
      const perfTxt = await page.textContent('#v-performance');
      T.chk(W + ': the two are never one figure', /never combined/.test(perfTxt) && !/(?<!never )combined|overall record/i.test(perfTxt));
      T.chk(W + ': no horizontal scroll on Performance', await noHScroll(page));
      await shot(page, W + '-6-performance');

      /* ---------------------------------------------------------------- Back and Forward through the seats */
      await page.goBack(); s = await st(page);
      T.chk(W + ': Back from Performance returns to Portfolio', s.views.join() === 'v-portfolio', s);
      await page.goForward(); s = await st(page);
      T.chk(W + ': Forward returns to Performance', s.views.join() === 'v-performance', s);

      /* ---------------------------------------------------------------- search: the same game, by name */
      await page.keyboard.press('Escape');
      await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
      await page.keyboard.press('/');
      await page.waitForSelector('#edSearch:not([hidden]) #edsQ', { timeout: 5000 });
      await page.keyboard.type((GAME.away.short || AWAY) + ' ' + (GAME.home.short || HOME));
      await page.waitForSelector('#edsL [role=option]', { timeout: 5000 });
      const first = await page.textContent('#edsL [role=option]');
      T.chk(W + ': search finds the game first', first.indexOf(AWAY + ' at ' + HOME) >= 0, first);
      await page.keyboard.press('Enter');
      await page.waitForSelector('#gvWs', { timeout: 20000 });
      s = await st(page);
      T.chk(W + ': and Enter opens its research, the context set again', s.views.join() === 'v-game' && s.ctx.researchKey === KEY, s);

      /* ---------------------------------------------------------------- the AI desk, handed the game */
      await page.click('#gvWs [data-gw-ask]');
      await page.waitForFunction(() => document.getElementById('edaiPanel') && document.getElementById('edaiPanel').classList.contains('open'), null, { timeout: 10000 });
      await page.waitForTimeout(1500);
      const asked = S.ai.join('\n');
      T.chk(W + ': asking about the game sends the desk its ids, not only its names', S.ai.length > 0 && asked.indexOf(GID) >= 0, asked.slice(0, 400));
      await page.evaluate(() => window.EDAI && window.EDAI.close());

      /* ---------------------------------------------------------------- the menu, listeners, errors */
      if (vp.width < 1024) {
        await page.click('#navMenuBtn');
        T.chk(W + ': Menu opens as a sheet with every place', await page.locator('#edNav.open button[data-v]:visible').count() === 10);
        await page.keyboard.press('Escape');
      }
      const lc1 = await page.evaluate(() => Object.assign({}, window.__lc));
      for (const v of ['overview', 'research', 'signals', 'foresight', 'simulator', 'card', 'portfolio', 'performance', 'overview']) { await seat(page, v); await page.waitForTimeout(250); }
      for (const v of ['overview', 'research', 'signals', 'foresight', 'simulator', 'card', 'portfolio', 'performance', 'overview']) { await seat(page, v); await page.waitForTimeout(250); }
      const lc2 = await page.evaluate(() => Object.assign({}, window.__lc));
      for (const v of ['overview', 'research', 'signals', 'foresight', 'simulator', 'card', 'portfolio', 'performance', 'overview']) { await seat(page, v); await page.waitForTimeout(250); }
      const lc3 = await page.evaluate(() => Object.assign({}, window.__lc));
      const grew = Object.keys(lc3).filter((k) => /^(document|window|overviewHost|perfHost|mfHost|scHost|simHost|gamePage):/.test(k) && (lc3[k] || 0) > (lc2[k] || 0));
      T.chk(W + ': moving around the terminal adds no listener twice (document, window and every view host)', grew.length === 0, grew.map((k) => k + ' ' + lc2[k] + '→' + lc3[k]));
      void lc1;
      T.chk(W + ': no page error on the whole journey', S.errors.length === 0, S.errors);
      T.chk(W + ': no door the journey reads answered with an error', S.refused.length === 0, S.refused);
      /* the header's System pill may still name a read this test does not serve (its heartbeat reads public.signals, answered
         "not part of this test" here); it must never name one of the doors the journey serves */
      const dbf = await page.evaluate(() => (typeof ED_DB === 'object' && ED_DB && ED_DB.failAt && !ED_DB.ok) ? String(ED_DB.where || '?') : '');
      if (dbf) console.log('  (' + W + ': the System pill names "' + dbf + '", a read this test does not serve)');
      T.chk(W + ': the System pill names no door the journey serves', !dbf || !SERVED.test('/rest/v1/' + dbf.replace(/^\/?(rest\/v1\/)?/, '')), dbf);
      await S.ctx.close();
    }

    /* ============================================================ widths */
    for (const w of [768, 1280]) {
      const S = await open({ width: w, height: 900 }, 'sub', '#overview');
      await S.page.waitForSelector('#ovQ .ovq-r', { timeout: 20000 });
      const bad = [];
      for (const h of ['#overview', '#game/' + LG + '/' + GID, '#foresight', '#performance', '#signals', '#simulator']) {
        await S.page.evaluate((x) => { location.hash = x; }, h); await S.page.waitForTimeout(1200);
        if (!(await noHScroll(S.page))) bad.push(h);
      }
      T.chk(w + ': no horizontal scroll on any new or changed view', bad.length === 0, bad);
      T.chk(w + ': ' + (w >= 1024 ? 'the sidebar' : 'the bar and Menu') + ' is the navigation', await S.page.evaluate((ww) => { const r = document.getElementById('edNav').getBoundingClientRect(); return ww >= 1024 ? r.height > r.width : r.width > r.height; }, w));
      T.chk(w + ': no page error', S.errors.length === 0, S.errors);
      await shot(S.page, 'w' + w + '-overview');
      await S.ctx.close();
    }

    /* ============================================================ a free account, an operator */
    {
      const S = await open({ width: 1280, height: 900 }, 'free', '');
      await S.page.waitForTimeout(2500);
      T.chk('free: the terminal is behind the paywall', await S.page.evaluate(() => { const g = document.getElementById('payGate'); return !!g && getComputedStyle(g).display !== 'none'; }));
      const fsCalls = S.served.filter((u) => MF.readsRecord(u) || /sim_current|portfolio_summary/.test(u));
      T.chk('free: and the new views asked no door for what they would hold back', fsCalls.length === 0, fsCalls);
      T.chk('free: no page error', S.errors.length === 0, S.errors);
      await S.ctx.close();
      MF.mode(db, ADMIN, 'shadow');
      const A = await open({ width: 1280, height: 900 }, 'admin', '#foresight/game/' + encodeURIComponent(M.sport + ':' + M.eventId));
      await A.page.waitForSelector(MF.SEL.findings, { timeout: 30000 });
      T.chk('operator: in shadow mode the record is still there for review, in the terminal', (await st(A.page)).views.join() === 'v-foresight');
      await A.ctx.close();
      const R = await open({ width: 1280, height: 900 }, 'sub', '#foresight/game/' + encodeURIComponent(M.sport + ':' + M.eventId));
      await R.page.waitForFunction(() => { const e = document.getElementById('mf-status'); return !!e && /review/.test(e.textContent); }, null, { timeout: 30000 }).catch(() => null);
      T.chk('subscriber: in shadow mode the record says it is in review, and shows no measurement', /in review/i.test(await R.page.textContent('#mf-status')) && await R.page.locator(MF.SEL.timeline).count() === 0);
      await R.ctx.close();
      MF.mode(db, ADMIN, 'live');
    }
  } catch (e) {
    T.chk('the journey ran to the end', false, String(e && e.stack || e).slice(0, 900));
  } finally {
    try { if (browser) await browser.close(); } catch (_) { /* closed */ }
    try { if (srv) srv.close(); } catch (_) { /* closed */ }
    db.stop();   /* the throwaway cluster: stopped and deleted */
  }
  console.log('screenshots: ' + SHOTS);
  process.exit(T.done());
})();
