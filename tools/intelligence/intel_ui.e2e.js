#!/usr/bin/env node
/* ===========================================================================
   ASK EDGEDESK AI, IN A REAL BROWSER, AT PHONE AND DESKTOP WIDTH.

   The Phase 3 brief's ten flows, on app.html in Chromium:
     1  open Research                      6  inspect the price and the sources
     2  find "Ask EdgeDesk AI"             7  understand why a game is not ready
     3  ask for the best opportunity       8  open a game and ask a follow-up
        tonight                               about it, without retyping it
     4  receive a real response            9  navigate away and back
     5  open the matchup analysis         10  all of it again at the other width
   plus the failure paths: an HTTP error with a retry, a provider failure
   mid-research, a run cut off by an error event, cancel and timeout.

   WHAT IS REAL
     - Every answer is the REAL edge function's. tools/intelligence/research_host.test.js
       drives supabase/functions/edgedesk_ai through its full handler with the
       fixture network and dumps each NDJSON stream (RESEARCH_DUMP). This suite
       replays those streams byte for byte, in order, from a local endpoint the
       page's fetch is pointed at. The replay spaces events PACE ms apart so each
       arriving event can be observed; the page itself has no timer — it changes
       only when an event arrives.
     - The board the page computes is its own: the same fixture card the handler
       read (football/nfl/slate.json with the fixture's Lions @ Bills and Colts @
       Texans), turned into the nflverse games.csv the page loads, and the same
       captured signals (Lions @ Bills priced at FanDuel; Colts @ Texans has no
       captured price). The browser clock is pinned to the handler's clock.
   WHAT IS INJECTED
     - The failure paths (HTTP 503, a stream that ends in the server's own error
       event, a hold for cancel and timeout) are failure injection, labelled so.

   Run: node tools/intelligence/intel_ui.e2e.js [--shots <dir>]   (or INTEL_SHOT_DIR)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOT_DIR = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : (process.env.INTEL_SHOT_DIR || null);
const PACE = Number(process.env.INTEL_PACE || 140);

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); return; } fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : '')); }
function done() {
  console.log('\n' + (fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- the real handler's streams ------------------------------------------- */
const DUMP = path.join(require('os').tmpdir(), 'edgedesk-intel-ui-' + process.pid + '.json');
try { cp.execFileSync(process.execPath, [path.join(__dirname, 'research_host.test.js')], { env: Object.assign({}, process.env, { RESEARCH_DUMP: DUMP, RESEARCH_PRINT: '0' }), stdio: 'pipe' }); }
catch (e) { console.log('research_host.test.js failed, so there is nothing real to replay:\n' + String(e.stdout || e.message).slice(-800)); process.exit(1); }
const R = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
try { fs.unlinkSync(DUMP); } catch (_) { /* ignore */ }
const resultOf = (k) => { const d = R[k]; if (!d) return null; return d.events ? ((d.events.find((e) => e.type === 'result') || {}).payload || null) : d.json; };
/* the browser asks (game id, question); the dumps answer exactly those */
const BY = {};
Object.keys(R).filter((k) => /^b_/.test(k) && !/_feedfail$/.test(k)).forEach((k) => { const d = R[k]; BY[((d.carried && d.carried.game && d.carried.game.game_id) || '') + '|' + d.question] = k; });

/* ---- the board's world: the handler's fixture card, at the handler's clock ---- */
const FX = require('./fixtures.js');
const NOW = Date.parse('2026-10-12T16:00:00Z');
const fx = FX.build(NOW);
const ISO = (min) => new Date(NOW + min * 60000).toISOString();
const et = (iso) => {
  const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.year + '-' + p.month + '-' + p.day, time: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute };
};
function gamesCsv() {
  const cols = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'away_rest', 'home_rest',
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name'];
  const real = fx.nfl.games.filter((g) => g.gameday);
  const rows = fx.nfl.games.map((g) => {
    const t = et(g.kickoff), r = g.reference_market || {};
    /* the fixture's two games carry no nflverse week: they take the week of the real games that day */
    const wk = g.gameday ? g.week : ((real.find((x) => x.gameday === t.day) || real[real.length - 1] || {}).week || g.week);
    return [g.game_id, g.season, g.game_type || 'REG', wk, g.gameday || t.day, g.gametime_et || t.time, g.away_code, 'NA', g.home_code, 'NA', g.away_rest, g.home_rest,
      r.away_ml == null ? 'NA' : r.away_ml, r.home_ml == null ? 'NA' : r.home_ml, r.home_margin == null ? 'NA' : r.home_margin, r.total == null ? 'NA' : r.total,
      g.div_game ? 1 : 0, g.roof || 'NA', g.surface || 'NA', 'NA', 'NA',
      (g.away_starter && g.away_starter.player_id) || 'NA', (g.home_starter && g.home_starter.player_id) || 'NA',
      (g.away_starter && g.away_starter.player_name) || 'NA', (g.home_starter && g.home_starter.player_name) || 'NA'].join(',');
  });
  return cols.join(',') + '\n' + rows.join('\n') + '\n';
}
const BUF = fx.nfl.games.find((g) => g.game_id === 'nfl-fx-det-buf');
const nflSig = (o) => fx.signal(Object.assign({ sport_key: 'americanfootball_nfl', sport_title: 'NFL', market: 'spreads', first_seen_at: ISO(-300), last_seen_at: ISO(-4), flagged_at: ISO(-20) }, o));
/* the same two rows research_host gives the handler for the browser's answers */
const SIGNALS = [
  nflSig({ sig_key: 'ev-det-buf|spreads|Buffalo Bills|-2.5', event_id: 'ev-det-buf', selection: 'Buffalo Bills', point: -2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.95, best_book: 'FanDuel', sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528, pin_dec: 1.88, pin_opp_dec: 2.02, corrob_n: 4 }),
  nflSig({ sig_key: 'ev-det-buf|spreads|Detroit Lions|2.5', event_id: 'ev-det-buf', selection: 'Detroit Lions', point: 2.5, home_team: 'Buffalo Bills', away_team: 'Detroit Lions', commence_time: BUF.kickoff, best_dec: 1.87, best_book: 'BetMGM', sharp_fair: 0.468, sharp_book_fair: 0.468, consensus_fair: 0.472, pin_dec: 2.02, pin_opp_dec: 1.88, edge: -0.03, first_edge: -0.03, corrob_n: 4 }),
];
function metrics() {
  const mm = JSON.parse(JSON.stringify(fx.metrics));
  mm.generated_at = ISO(-120);
  Object.keys(mm.nfl.teams).forEach((k) => { const t = mm.nfl.teams[k]; if (t.injuries) t.injuries.retrieved_at = ISO(-120); if (t.starter) { t.starter.published_at = ISO(-1200); t.starter.retrieved_at = ISO(-120); } });
  return mm;
}

/* ---- the replay endpoint ------------------------------------------------------ */
const SENT = [], UNKNOWN = [];
const MODE = { next: null, pace: null, aborted: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function aiHandler(req, res) {
  let raw = ''; for await (const c of req) raw += c;
  let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
  SENT.push(body);
  let closed = false; res.on('close', () => { if (!res.writableEnded) { closed = true; MODE.aborted++; } });
  const q = String(body && body.question || ''), gid = (body && body.research_context && body.research_context.game && body.research_context.game.game_id) || '';
  const mode = MODE.next; MODE.next = null;
  /* FAILURE INJECTION: the service answers HTTP 503 */
  if (mode === 'http503') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream unavailable' })); return; }
  /* FAILURE INJECTION: the server's own bodies (supabase/functions/edgedesk_ai/index.ts subscriptionGate and the daily allowance) */
  if (mode === 'http402') { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'subscription required', note: 'EdgeDesk Intelligence is part of the subscription. The research board and the decision engine in the app do not need it and keep working.' })); return; }
  if (mode === 'http429') { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'daily limit reached', note: 'the daily EdgeDesk AI allowance for this account is used' })); return; }
  let key = BY[gid + '|' + q];
  if (mode === 'feedfail' && key === 'b_game_buf') key = 'b_game_buf_feedfail';
  const d = key ? R[key] : null;
  if (!d) { UNKNOWN.push({ q, gid }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answer: 'No recorded answer for this question in the browser suite.', build: 'e2e' })); return; }
  if (!d.events) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(d.json)); return; }
  if (!(body && body.stream === true)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(resultOf(key))); return; }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const pace = MODE.pace || PACE;
  let events = d.events;
  /* FAILURE INJECTION: the run dies after a few steps; the last line is the server's own error event */
  if (mode === 'stream_error') events = events.filter((e) => e.type !== 'result').slice(0, 5).concat([{ type: 'error', error: 'the research run failed', detail: 'the board could not be read (fixture failure)' }]);
  for (let i = 0; i < events.length; i++) {
    if (closed) return;
    /* FAILURE INJECTION: hold before the result (for cancel and timeout) until the reader gives up */
    if (mode === 'hold' && events[i].type === 'result') { while (!closed) await sleep(50); return; }
    res.write(JSON.stringify(events[i]) + '\n');
    if (i < events.length - 1) await sleep(pace);
  }
  res.end();
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/__ai' && req.method === 'POST') { aiHandler(req, res).catch((e) => { try { res.end(); } catch (_) { /* gone */ } console.log('replay threw ' + e.message); }); return; }
  if (p === '/') p = '/app.html';
  if (p === '/football/nfl/slate.json') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(fx.nfl)); return; }
  if (p === '/football/matchup/metrics.json') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(metrics())); return; }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium (' + String(e.message).split('\n')[0] + ')'); srv.close(); process.exit(0); }
  }
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const shot = async (page, name, o) => { if (!SHOT_DIR) return; try { await page.screenshot(Object.assign({ path: path.join(SHOT_DIR, name + '.png'), fullPage: false }, o || {})); } catch (e) { console.log('  (screenshot ' + name + ' failed: ' + e.message + ')'); } };

  async function open(vp) {
    /* a reader in New York, as the handler's answers were written for (body.timezone) */
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr || 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, timezoneId: 'America/New_York', locale: 'en-US' });
    await ctx.clock.install({ time: NOW });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        /* a returning subscriber: the Card's first-visit walkthrough is already done */
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify(new Date().toISOString()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
      /* the edge function's URL is answered by the local replay of the real handler's streams */
      const of = window.fetch.bind(window);
      window.fetch = function (u, init) { const s = typeof u === 'string' ? u : (u && u.url) || ''; return /functions\/v1\/edgedesk_ai/.test(s) ? of('/__ai', init) : of(u, init); };
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: gamesCsv() });
      if (/stats_team_week_(\d{4})\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv')) });
      if (/open-meteo/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(NOW + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/signals\?/.test(url) && /americanfootball_nfl/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SIGNALS) });
        /* a returning subscriber: preferences already set, so the first-visit questionnaire does not open over the test */
        if (/\/user_preferences\?/.test(url) && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ user_id: 'e2e-reader', persona: 'analyst', leagues: ['nfl'], books: ['fanduel'], interests: [], onboarding_status: 'completed', timezone: 'America/New_York' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${port}/app.html#research/football`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.fbSetSport === 'function' && window.EDAI && window.EDINTELUI, null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) { /* already there */ } });
    await page.click('text=Skip for now', { timeout: 1500 }).catch(() => {});
    return { ctx, page, errors };
  }
  const SEL_LAST = () => {
    const box = document.getElementById('edaiLog');
    const msgs = box ? box.querySelectorAll('.edai-m.a, .edai-msg.a, [data-role="a"]') : [];
    return msgs.length;
  };
  /* wait until the n-th research run has ended (its activity block left "running") */
  async function runEnded(page, n) {
    await page.waitForFunction((k) => { const a = document.querySelectorAll('#edaiLog .ia-act'); return a.length >= k && a[k - 1].getAttribute('data-state') !== 'running'; }, n, { timeout: 30000 }).catch(() => {});
  }
  const runs = (page) => page.evaluate(() => document.querySelectorAll('#edaiLog .ia-act').length);
  async function lastRun(page) {
    return page.evaluate(() => {
      const acts = document.querySelectorAll('#edaiLog .ia-act'); const act = acts[acts.length - 1];
      if (!act) return null;
      /* the answer is the message after the activity's message */
      let msg = act.closest('#edaiLog > *'); let ans = msg ? msg.nextElementSibling : null;
      const txt = ans ? ans.innerText : '';
      return { state: act.getAttribute('data-state'), steps: [...act.querySelectorAll('.ia-step')].map((s) => ({ st: s.getAttribute('data-st'), status: s.getAttribute('data-status'), label: s.querySelector('.ia-step-l').textContent, detail: s.querySelector('.ia-step-d').textContent })),
        title: (act.querySelector('.ia-act-t, summary') || {}).textContent || '', answer: txt, cards: ans ? ans.querySelectorAll('.ia-card').length : 0, html: ans ? ans.innerHTML.length : 0 };
    });
  }
  async function noSideScroll(page) { return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); }

  const VPS = [{ tag: 'phone', width: 390, height: 844, mobile: true, dpr: 2 }, { tag: 'desktop', width: 1280, height: 900 }];
  try {
    for (const vp of VPS) {
      console.log('\n== ' + vp.tag + ' ' + vp.width + '×' + vp.height + ' ==');
      SENT.length = 0; UNKNOWN.length = 0;
      const { ctx, page, errors } = await open(vp);
      const T = vp.tag + ': ';

      /* ── 1. OPEN RESEARCH ── */
      await page.waitForFunction(() => document.querySelectorAll('[id^="fbg-nfl-"]').length > 0 || /What can EdgeDesk research right now/.test((document.getElementById('fbOverview') || {}).textContent || ''), null, { timeout: 60000 }).catch(() => {});
      const clock = await page.evaluate(() => new Date().toISOString());
      chk(T + 'the browser clock is the handler\'s (2026-10-12, noon in New York)', /^2026-10-12T16:0/.test(clock), clock);
      const onResearch = await page.evaluate(() => { const v = document.getElementById('v-research'); const b = document.querySelector('nav [data-v="research"]'); return { shown: v && getComputedStyle(v).display !== 'none' && v.getBoundingClientRect().height > 0, navOn: b && b.classList.contains('on') }; });
      chk(T + '1 · Research is the open screen, its nav seat lit', onResearch.shown && onResearch.navOn, onResearch);

      /* ── 2. FIND ASK EDGEDESK AI ── */
      const ask = await page.evaluate(() => {
        const card = document.querySelector('#iaAskHost .ia-ask'); if (!card) return null;
        const r = card.getBoundingClientRect(), ta = document.getElementById('iaQ'), go = document.getElementById('iaGo');
        const chips = [...card.querySelectorAll('.ia-ex .ia-chip')];
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, h2: (card.querySelector('h2') || {}).textContent, chips: chips.map((c) => c.textContent), chipH: Math.min(...chips.map((c) => c.getBoundingClientRect().height)),
          taFont: parseFloat(getComputedStyle(ta).fontSize), taH: ta.getBoundingClientRect().height, goH: go.getBoundingClientRect().height, label: (document.querySelector('label[for="iaQ"]') || {}).textContent,
          headerBtn: (document.querySelector('#rsAskBtn .rs-ask-l') || {}).textContent };
      });
      chk(T + '2 · the "Ask EdgeDesk AI" card is on the Research screen, labelled, in the first screenful', ask && ask.h2 === 'Ask EdgeDesk AI' && ask.top < ask.vh * 0.6 && !!ask.label, ask);
      chk(T + '2 · the six example questions are there, word for word', ask && ['What\'s the best researched opportunity tonight?', 'Analyze every NFL game this weekend.', 'Why does EdgeDesk disagree with this spread?', 'Which matchup has the biggest offensive advantage?', 'Compare DraftKings Predictions and Kalshi prices.', 'Explain why this game isn\'t research ready.'].every((q) => ask.chips.includes(q)), ask && ask.chips);
      chk(T + '2 · touch targets: chips ≥ 36 px, input ≥ 44 px, send ≥ 44 px; the input is 16 px (no zoom on focus)', ask && ask.chipH >= 36 && ask.taH >= 44 && ask.goH >= 44 && ask.taFont >= 16, ask && { chipH: ask.chipH, taH: ask.taH, goH: ask.goH, taFont: ask.taFont });
      chk(T + '2 · the header button is labelled "Ask AI", not an unlabelled icon', ask && ask.headerBtn === 'Ask AI', ask && ask.headerBtn);
      if (vp.tag === 'phone') {
        const row = await page.evaluate(() => { const ex = document.querySelector('#iaAskHost .ia-ex'); const cr = document.querySelector('#iaAskHost .ia-ask').getBoundingClientRect(); return { scrolls: ex.scrollWidth > ex.clientWidth + 4, rows: new Set([...ex.querySelectorAll('.ia-chip')].map((c) => Math.round(c.getBoundingClientRect().top))).size, cardH: cr.height, vh: window.innerHeight }; });
        chk('phone: the examples are one swipeable row, so the card leaves room for the board in the first screen', row.scrolls && row.rows === 1 && row.cardH < row.vh * 0.5, row);
      }
      const geo1 = await noSideScroll(page);
      chk(T + 'no sideways scroll on Research', geo1.sw <= geo1.iw + 1, geo1);
      await shot(page, '01-research-ask-' + vp.tag);

      /* ── 7 (first look). THE READINESS PANEL, FROM THE BOARD'S OWN ROWS ── */
      await page.waitForFunction(() => /What can EdgeDesk research right now/.test((document.getElementById('fbOverview') || {}).textContent || ''), null, { timeout: 60000 }).catch(() => {});
      const rd = await page.evaluate(() => {
        const s = document.querySelector('#fbOverview .ia-readiness'); if (!s) return null;
        const counts = [...s.querySelectorAll('.ia-ready .ia-rk')].map((k) => ({ n: k.querySelector('b').textContent, l: k.querySelector('span').textContent }));
        const rows = [...s.querySelectorAll('.ia-g')].map((g) => ({ t: g.querySelector('.ia-g-t b').textContent, level: g.getAttribute('data-level'), dots: [...g.querySelectorAll('.ia-sd')].map((d) => d.className.replace('ia-sd ', '')), why: [...g.querySelectorAll('.ia-why-d li')].map((l) => l.textContent), head: (g.querySelector('.ia-g-h') || {}).textContent }));
        return { counts, rows, lead: (s.querySelector('.ia-rd-lead') || {}).textContent };
      });
      chk(T + '7 · the readiness strip counts five separate states', rd && rd.counts.length === 5 && ['Games available', 'Research available', 'Market verified', 'Model ready', 'Actionable signal'].every((l, i) => rd.counts[i] && rd.counts[i].l === l), rd && rd.counts);
      const buf = rd && rd.rows.find((r) => r.t === 'Detroit Lions @ Buffalo Bills'), hou = rd && rd.rows.find((r) => r.t === 'Indianapolis Colts @ Houston Texans');
      chk(T + '7 · Lions @ Bills (a captured FanDuel price): market verified and model ready on the board', buf && buf.dots[2] === 'ok' && buf.dots[3] === 'ok', buf);
      chk(T + '7 · Colts @ Texans (no captured price): still researchable, but "Why not ready?" names the missing market', hou && hou.dots[1] === 'ok' && hou.dots[2] === 'no' && hou.why.some((w) => /^Market verified — needs a captured price/.test(w)), hou);
      chk(T + '7 · the panel says research stays available without a market, in plain words', rd && /the research itself is still available|Every game has a verified market price/.test(rd.lead || ''), rd && rd.lead);
      const canon = await page.evaluate(() => { const d = document.querySelector('#fbOverview .ia-rd-def'); const m = d && /a verified market: (\d+) here/.exec(d.textContent); const both = m ? Number(m[1]) : null;
        const k = [...document.querySelectorAll('#fbOverview .fb-kpi')].find((x) => /^Research ready$/i.test((x.querySelector('.l') || {}).textContent || '')); const n = k ? Number(k.querySelector('.n').textContent) : null; return { both, kpi: k ? k.innerText.replace(/\s+/g, ' ') : null, n }; });
      chk(T + '7 · the board\'s own "Research ready" counter equals the games with both a ready model and a verified market', canon.both != null && canon.n != null && canon.both === canon.n, canon);
      const nReady = rd ? Number(rd.counts[4].n) : -1, nMkt = rd ? Number(rd.counts[2].n) : -1;
      chk(T + '7 · nothing is counted actionable without a verified market', nReady <= nMkt, rd && rd.counts);
      /* open Colts @ Texans's "Why not ready?" for the screenshot */
      await page.evaluate(() => { const s = document.querySelector('#fbOverview .ia-readiness'); if (!s) return; s.querySelectorAll('details.ia-sport').forEach((d) => { d.open = true; }); const g = [...s.querySelectorAll('.ia-g')].find((x) => /Houston Texans/.test(x.textContent)); if (g) { const d = g.querySelector('.ia-why-d'); if (d) d.open = true; g.scrollIntoView({ block: 'center' }); } });
      await page.waitForTimeout(150);
      await shot(page, '07-readiness-why-not-' + vp.tag);

      /* ── 3. ASK FOR THE BEST OPPORTUNITY TONIGHT (example chip) ── */
      await page.evaluate(() => { window.scrollTo(0, 0); });
      MODE.pace = 450;
      await page.click('#iaAskHost .ia-chip >> text="What\'s the best researched opportunity tonight?"');
      await page.waitForFunction(() => document.querySelectorAll('#edaiLog .ia-act .ia-step').length >= 3, null, { timeout: 15000 }).catch(() => {});
      const mid = await lastRun(page);
      chk(T + '3 · the panel opens and the activity shows the steps the server has reported so far, still running', mid && mid.state === 'running' && mid.steps.length >= 2 && mid.steps.some((s) => s.st === 'FIND_EVENTS'), mid);
      await shot(page, '03-activity-running-' + vp.tag);
      await runEnded(page, 1);
      MODE.pace = null;
      const s1 = SENT[SENT.length - 1];
      chk(T + '3 · the request is the research route: stream, desk, no game attached', s1 && s1.stream === true && s1.desk === true && s1.question === 'What\'s the best researched opportunity tonight?' && !(s1.research_context && s1.research_context.game), s1 && { stream: s1.stream, desk: s1.desk, q: s1.question, rc: s1.research_context && Object.keys(s1.research_context) });
      const r1 = await lastRun(page), want1 = resultOf('b_tonight');
      /* ── 4. A REAL RESPONSE ── */
      const evs1 = R.b_tonight.events.filter((e) => e.type === 'progress');
      chk(T + '4 · every step the server streamed is on screen with its status and detail, in its order', r1 && r1.state === 'done' && evs1.every((e) => r1.steps.some((s) => s.st === e.stage)) && r1.steps.filter((s) => s.st !== 'SENT').every((s) => s.status !== 'running'), r1 && r1.steps);
      chk(T + '4 · the answer is the engine\'s, to the word: nothing verified tonight, with the coverage', r1 && /No verified positive-EV trade currently clears/.test(r1.answer) && /Coverage — no eligible games/.test(r1.answer) && want1 && r1.answer.indexOf(want1.answer.split('\n')[0].slice(0, 60)) >= 0, r1 && r1.answer.slice(0, 300));
      chk(T + '4 · no card is drawn for an answer with no candidate (nothing is manufactured)', r1 && r1.cards === 0, r1 && r1.cards);
      await shot(page, '04-answer-tonight-' + vp.tag);

      /* ── 5. THE MATCHUP ANALYSIS: the slate, candidate cards ── */
      await page.evaluate(() => window.EDAI.close());
      await page.click('#iaAskHost .ia-chip >> text="Analyze every NFL game this weekend."');
      await runEnded(page, 2);
      const r2 = await lastRun(page), want2 = resultOf('b_slate');
      chk(T + '5 · "Analyze every NFL game this weekend." streams the slate investigation', r2 && r2.state === 'done' && want2 && want2.quant.intent === 'RESEARCH_SLATE' && /7 games investigated/.test(r2.answer), r2 && [r2.state, r2.answer.slice(0, 200)]);
      const card = await page.evaluate(() => {
        const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; if (!c) return null;
        const kv = {}; c.querySelectorAll('.ia-kv-r').forEach((r) => { const k = r.querySelector('dt').textContent; if (!(k in kv)) kv[k] = r.querySelector('dd').innerText.replace(/\s+/g, ' ').trim(); });
        return { title: c.querySelector('.ia-card-t').textContent, sub: c.querySelector('.ia-card-s').textContent, chip: (c.querySelector('.ia-card-hd .ia-chipcls') || {}).textContent, kv, more: [...c.querySelectorAll('details.ia-more > summary')].map((s) => s.textContent),
          links: [...c.querySelectorAll('.ia-src a')].map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel'), target: a.getAttribute('target') })), buttons: [...c.querySelectorAll('.ia-card-a button')].map((b) => b.textContent) };
      });
      const row2 = want2 && (want2.research_slate.investigated || []).find((r) => r.candidate.selection === 'Buffalo Bills');
      chk(T + '5 · a card for the survivor: Buffalo Bills -2.5, Lions @ Bills, Verified candidate', card && card.title === 'Buffalo Bills -2.5' && /Detroit Lions @ Buffalo Bills/.test(card.sub) && card.chip === 'Verified candidate', card && [card.title, card.sub, card.chip]);
      chk(T + '5 · the card carries every field the brief names', card && ['Verified market price', 'Model projection', 'Fair probability', 'Estimated net EV', 'Research freshness', 'Primary matchup advantage', 'Key injuries or lineup changes', 'Strongest counterargument', 'Audit status', 'Supporting sources'].every((k) => k in card.kv), card && Object.keys(card.kv));
      const bufAfter = await page.evaluate(() => { const g = [...document.querySelectorAll('#fbOverview .ia-g')].find((x) => /Detroit Lions @ Buffalo Bills/.test(x.querySelector('.ia-g-t b').textContent)); const p = document.querySelector('#fbOverview .ia-rd-aud');
        const strip = [...document.querySelectorAll('#fbOverview .ia-ready .ia-rk')].map((k) => Number(k.querySelector('b').textContent));
        const kpi = [...document.querySelectorAll('#fbOverview .fb-kpi')].find((x) => /^Actionable research signals$/i.test((x.querySelector('.l') || {}).textContent || ''));
        return g ? { level: g.getAttribute('data-level'), aud: (g.querySelector('.ia-aud') || {}).textContent || '', note: p ? p.textContent : '', stripAct: strip[4], kpiAct: kpi ? Number(kpi.querySelector('.n').textContent) : null } : null; });
      chk(T + '5 · the board\'s readiness row shows the audit verdict the answer returned, labelled as the price audit (Lions @ Bills)', bufAfter && /Price audit by EdgeDesk AI:\s*Verified candidate/.test(bufAfter.aud) && /audited the price on 1 of these \d+ games in this session; 1 survived/.test(bufAfter.note), bufAfter);
      chk(T + '5 · …and the board\'s actionable count still equals its own canonical counter (the audit is beside it, not folded in)', bufAfter && bufAfter.stripAct === bufAfter.kpiAct, bufAfter);
      chk(T + '5 · four sections expand: matchup research, model calculations, market comparison, audit findings', card && ['Matchup research', 'Model calculations', 'Market comparison', 'Audit findings'].every((k) => card.more.includes(k)), card && card.more);
      /* ── 6. THE PRICE AND THE SOURCES, against the engine's own JSON ── */
      const am = (n) => (n > 0 ? '+' : '') + Math.round(n);
      const ev2 = row2 && row2.evaluation;
      chk(T + '6 · the price on the card is the engine\'s entry price at its book (' + (ev2 && am(ev2.entry_price)) + ' at FanDuel)', card && ev2 && card.kv['Verified market price'].indexOf(am(ev2.entry_price) + ' at FanDuel') === 0, card && [card.kv['Verified market price'], ev2 && ev2.entry_price]);
      chk(T + '6 · the net EV and maximum price are the engine\'s to the digit', card && ev2 && card.kv['Estimated net EV'].indexOf((ev2.net_ev_per_dollar * 100).toFixed(2) + '% per $1') === 0 && card.kv['Estimated net EV'].indexOf('max price ' + am(ev2.maximum_entry_price)) >= 0, card && [card.kv['Estimated net EV'], ev2 && [ev2.net_ev_per_dollar, ev2.maximum_entry_price]]);
      chk(T + '6 · the fair probability is the engine\'s (' + (row2 && (row2.research.fair_probability * 100).toFixed(1)) + '%, sharp no-vig, model cross-check named)', card && row2 && card.kv['Fair probability'].indexOf((row2.research.fair_probability * 100).toFixed(1) + '%') === 0 && /cross-check/.test(card.kv['Fair probability']), card && card.kv['Fair probability']);
      chk(T + '6 · the advantage and counterargument are the server\'s words, not the page\'s', card && row2 && card.kv['Primary matchup advantage'] === row2.advantage && card.kv['Strongest counterargument'] === row2.counterargument, card && [card.kv['Primary matchup advantage'], row2 && row2.advantage]);
      const srcWant = row2 ? [...new Set((row2.research.findings || []).map((f) => f.source_url).filter(Boolean))] : [];
      chk(T + '6 · the sources are the findings\' own https links, opening in a new tab with noopener', card && card.links.length >= 1 && card.links.every((l) => /^https:\/\//.test(l.href) && /noopener/.test(l.rel || '') && l.target === '_blank' && srcWant.includes(l.href)), card && card.links);
      /* expand them all and look */
      await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; if (c) { c.querySelectorAll('details.ia-more').forEach((d) => { d.open = true; }); c.scrollIntoView({ block: 'start' }); } });
      await page.waitForTimeout(150);
      const exp = await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const d = [...c.querySelectorAll('details.ia-more')]; return d.map((x) => ({ s: x.querySelector('summary').textContent, open: x.open, rows: x.querySelectorAll('tr').length, text: x.innerText.slice(0, 160) })); });
      chk(T + '6 · the audit findings list the professional checks and the audit checks', exp.some((x) => x.s === 'Audit findings' && x.rows >= 10), exp.map((x) => [x.s, x.rows]));
      chk(T + '6 · the model calculations show break-even, net EV and the one-point sensitivity', exp.some((x) => x.s === 'Model calculations' && /Break-even probability/i.test(x.text) && /If the fair is wrong/i.test(x.text)), exp.find((x) => x.s === 'Model calculations'));
      /* ── PHASE 4: the plan, the number check, confidence vs probability, why actionable, evidence, calculations, challenge ── */
      const p4 = await page.evaluate(() => {
        const acts = document.querySelectorAll('#edaiLog .ia-act'); const act = acts[acts.length - 1];
        const plan = act && act.querySelector('.ia-plan');
        const res = [...document.querySelectorAll('#edaiLog .ia-results')].pop();
        const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1];
        const kv = {}; c.querySelectorAll('.ia-kv-r').forEach((r) => { const k = r.querySelector('dt').textContent; if (!(k in kv)) kv[k] = r.querySelector('dd').innerText.replace(/\s+/g, ' ').trim(); });
        const sec = (re) => { const d = [...c.querySelectorAll('details.ia-more')].find((x) => re.test(x.querySelector('summary').textContent)); return d ? { s: d.querySelector('summary').textContent, rows: [...d.querySelectorAll('table tr')].slice(1).map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()), text: d.innerText.replace(/\s+/g, ' ') } : null; };
        return { plan: plan ? { text: plan.innerText.replace(/\s+/g, ' '), steps: plan.querySelectorAll('.ia-plan-s li').length } : null,
          vfy: res && res.querySelector('.ia-vfy') ? { ok: res.querySelector('.ia-vfy').classList.contains('ia-vfy-ok'), text: res.querySelector('.ia-vfy').textContent } : null,
          ran: res ? [...res.querySelectorAll('details.ia-more > summary')].map((x) => x.textContent).find((t) => /^What ran/.test(t)) || null : null,
          kv, ev: sec(/^Evidence/), calc: sec(/^Calculation checks/), ch: sec(/^Challenge/) };
      });
      chk(T + 'P4 · the plan the server streamed before any work is on screen: its path, its steps, and that no paid call is planned', p4.plan && /^Plan — /.test(p4.plan.text) && /no paid calls/.test(p4.plan.text) && p4.plan.steps >= 4, p4.plan);
      chk(T + 'P4 · the answer says every number in it traces to a calculation and the recomputation agrees', p4.vfy && p4.vfy.ok && /numbers in this answer trace to a calculation/.test(p4.vfy.text) && /recomputed independently and agree/.test(p4.vfy.text), p4.vfy);
      chk(T + 'P4 · "What ran" sets the plan against what actually happened', p4.ran && /steps done/.test(p4.ran), p4.ran);
      chk(T + 'P4 · "Actionable now?" answers yes at the checked price, and says to re-check', /^Yes, at the checked price/.test(p4.kv['Actionable now?'] || '') && /Re-check before acting/.test(p4.kv['Actionable now?']), p4.kv['Actionable now?']);
      const fairPct = row2 ? (Number(row2.evaluation.fair_probability) * 100).toFixed(1) + '%' : null;
      chk(T + 'P4 · research confidence (a category) beside the probability of winning (the engine\'s fair, ' + fairPct + '), with the difference stated', /research confidence/i.test(p4.kv['Research confidence vs. win probability'] || '') && (p4.kv['Research confidence vs. win probability'] || '').indexOf(fairPct + ' probability of winning') >= 0 && /not a chance of winning/.test(p4.kv['Research confidence vs. win probability']) && !/\d%\s*research confidence/i.test(p4.kv['Research confidence vs. win probability']), p4.kv['Research confidence vs. win probability']);
      chk(T + 'P4 · the evidence ledger lists every fact with its type, source, verification and freshness — the captured price a market quote, the projection a model estimate', p4.ev && p4.ev.rows.length >= 5 && p4.ev.rows.some((r) => /^Market quote/i.test(r) && /verified/i.test(r)) && p4.ev.rows.some((r) => /^Model estimate/i.test(r)) && /\(\d+\)$/.test(p4.ev.s), p4.ev && [p4.ev.s, p4.ev.rows.slice(0, 4)]);
      chk(T + 'P4 · the calculation checks show each number with its check, the market comparison available, and the recomputation agreeing', p4.calc && p4.calc.rows.length === 11 && p4.calc.rows.filter((r) => /✓/.test(r)).length >= 8 && /Market comparison: available/.test(p4.calc.text) && /all agree/.test(p4.calc.text) && /Projection vs market line/.test(p4.calc.text), p4.calc && [p4.calc.rows.length, p4.calc.rows.slice(0, 3)]);
      chk(T + 'P4 · the challenge answers all eight questions, and the conclusion stands', p4.ch && p4.ch.rows.length === 8 && /The conclusion stands/.test(p4.ch.text) && p4.ch.rows.some((r) => /^What evidence contradicts this conclusion\?/.test(r)) && p4.ch.rows.some((r) => /^Does the conclusion survive reasonable alternative assumptions\?/.test(r)), p4.ch && [p4.ch.s, p4.ch.rows.length]);
      await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const r = [...c.querySelectorAll('.ia-kv-r')].find((x) => /Actionable now/.test(x.textContent)); if (r) r.scrollIntoView({ block: 'start' }); });
      await shot(page, '05a-card-head-' + vp.tag);
      await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const d = [...c.querySelectorAll('details.ia-more')].find((x) => /^Evidence/.test(x.querySelector('summary').textContent)); if (d) d.scrollIntoView({ block: 'start' }); });
      await shot(page, '05b-evidence-' + vp.tag);
      await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const d = [...c.querySelectorAll('details.ia-more')].find((x) => /^Challenge/.test(x.querySelector('summary').textContent)); if (d) d.scrollIntoView({ block: 'start' }); });
      await shot(page, '05c-challenge-' + vp.tag);
      await shot(page, '05-cards-' + vp.tag);
      await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const d = [...c.querySelectorAll('details.ia-more')].find((x) => /Audit findings/.test(x.textContent)); if (d) d.scrollIntoView({ block: 'start' }); });
      await shot(page, '06-audit-findings-' + vp.tag);
      if (vp.tag === 'phone') { const g = await noSideScroll(page); chk('phone: the cards and their tables do not push the page sideways', g.sw <= g.iw + 1, g); }

      /* ── 7 (asked). "Explain why this game isn't research ready." with no game open ── */
      await page.evaluate(() => window.EDAI.close());
      await page.click('#iaAskHost .ia-chip >> text="Explain why this game isn\'t research ready."');
      await runEnded(page, 3);
      const r3 = await lastRun(page);
      const s3 = SENT[SENT.length - 1];
      chk(T + '7 · with no game open the question goes without one, and the answer says so and covers the card', s3 && !(s3.research_context && s3.research_context.game) && r3 && /No game is open/.test(r3.answer) && /Readiness: \d+ available/.test(r3.answer), r3 && r3.answer.slice(0, 300));
      const rdRows = await page.evaluate(() => { const rs = [...document.querySelectorAll('#edaiLog .ia-results')].pop(); return rs ? [...rs.querySelectorAll('.ia-g')].map((g) => ({ t: g.querySelector('.ia-g-t b').textContent, why: [...g.querySelectorAll('.ia-why-d li')].map((l) => l.textContent) })) : []; });
      chk(T + '7 · the answer lists each game with its own "Why not ready?"', rdRows.length >= 3 && rdRows.some((g) => g.why.length >= 1), rdRows.slice(0, 3));

      /* ── 8. OPEN A GAME, THEN ASK WITHOUT RETYPING IT ── */
      await page.evaluate(() => window.EDAI.close());
      await page.waitForTimeout(300);   /* the panel's slide-out */
      await page.evaluate(() => { const s = document.querySelector('#fbOverview .ia-readiness'); if (!s) return; s.querySelectorAll('details.ia-sport').forEach((d) => { d.open = true; }); });
      const opened = await page.evaluate(() => { const g = [...document.querySelectorAll('#fbOverview .ia-g')].find((x) => /Detroit Lions @ Buffalo Bills/.test(x.textContent)); const b = g && [...g.querySelectorAll('button')].find((x) => x.textContent === 'Game research'); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); return true; } return false; });
      await page.waitForFunction(() => { const s = document.getElementById('igSheet'); return s && !s.hidden && document.querySelectorAll('#igBody .ig-sec').length >= 5; }, null, { timeout: 15000 }).catch(() => {});
      const sheet = await page.evaluate(() => {
        const s = document.getElementById('igSheet'); if (!s || s.hidden) return null;
        const p = s.querySelector('.ig-panel').getBoundingClientRect(), ai = document.getElementById('igAi').getBoundingClientRect();
        const kv = {}; s.querySelectorAll('.ia-kv-r').forEach((r) => { const k = r.querySelector('dt').textContent; if (!(k in kv)) kv[k] = r.querySelector('dd').innerText.replace(/\s+/g, ' ').trim(); });
        return { title: document.getElementById('igT').textContent, secs: [...s.querySelectorAll('.ig-sec h3')].map((h) => h.textContent), kv, panelW: p.width, aiBottom: ai.bottom, aiH: ai.height, vh: window.innerHeight, aiText: document.getElementById('igAi').textContent,
          row: typeof window.fbRowFor === 'function' ? (() => { const r = window.fbRowFor('nfl', 'nfl-fx-det-buf'); return r ? { fair: r.p && r.p.model ? r.p.model.fair_spread : null, line: r.mkt ? r.mkt.spread_line : null, book: r.book } : null; })() : null };
      });
      chk(T + '8 · "Game research" opens the game view for Lions @ Bills', opened && sheet && sheet.title === 'Detroit Lions @ Buffalo Bills', sheet && sheet.title);
      const kick = await page.evaluate(() => (document.querySelector('#igBody .ig-top > .ia-dim') || {}).textContent || '');
      chk(T + '8 · the kickoff reads in the reader\'s zone, with the zone named (Sun, Oct 18, 12:00 PM EDT — the answer\'s time)', /Sun, Oct 18, 12:00\s?PM EDT/.test(kick), kick);
      chk(T + '8 · the game view has every section the brief names', sheet && ['Readiness', 'Model and market', 'Offensive and defensive efficiency', 'Matchup advantages', 'Player availability', 'Recent performance', 'Weather and venue', 'Research sources and last updated', 'Ask about this game'].every((k) => sheet.secs.includes(k)), sheet && sheet.secs);
      chk(T + '8 · its market spread is the board\'s verified FanDuel line (Bills -2.5, the favourite), its model spread the board\'s own, as betting lines', sheet && sheet.row && /Buffalo Bills -2\.5/.test(sheet.kv['Market spread'] || '') && /verified · FanDuel/.test(sheet.kv['Market spread'] || '') && (sheet.kv['Model spread'] || '').indexOf('Buffalo Bills ' + ((Math.round(-sheet.row.fair * 10) / 10) > 0 ? '+' : '') + (Math.round(-sheet.row.fair * 10) / 10)) === 0, sheet && [sheet.kv['Market spread'], sheet.kv['Model spread'], sheet.row]);
      chk(T + '8 · when the live board and the nightly build differ, both are shown and named', sheet && (Math.abs(-sheet.row.fair - (-5.2)) < 0.5 || /Nightly build \(what EdgeDesk AI researches\): Buffalo Bills -5\.2/.test(sheet.kv['Model spread'] || '')), sheet && sheet.kv['Model spread']);
      chk(T + '8 · "Research with EdgeDesk AI" is prominent and on screen (≥ 44 px, inside the viewport)', sheet && sheet.aiText === 'Research with EdgeDesk AI' && sheet.aiH >= 44 && sheet.aiBottom <= sheet.vh + 1, sheet && { aiH: sheet.aiH, aiBottom: sheet.aiBottom, vh: sheet.vh });
      if (vp.tag === 'phone') chk('phone: the game view is full width', sheet && sheet.panelW >= vp.width - 1, sheet && sheet.panelW);
      else chk('desktop: the game view is a side panel, not a full-page takeover', sheet && sheet.panelW <= 660, sheet && sheet.panelW);
      await shot(page, '08-game-view-' + vp.tag);
      const before8 = SENT.length;
      await page.click('#igAi');
      await runEnded(page, 4);
      const s8 = SENT[before8], r8 = await lastRun(page), want8 = resultOf('b_game_buf');
      chk(T + '8 · the game travels as context: research_context.game is Lions @ Bills, intent GAME_RESEARCH — nothing retyped', s8 && s8.research_context && s8.research_context.game && s8.research_context.game.game_id === 'nfl-fx-det-buf' && s8.research_context.game.sport === 'americanfootball_nfl' && s8.intent_hint === 'GAME_RESEARCH', s8 && { rc: s8.research_context && s8.research_context.game, hint: s8.intent_hint, q: s8.question });
      const bub = await page.evaluate(() => { const u = [...document.querySelectorAll('#edaiLog .u, #edaiLog .edai-u, #edaiLog [class*="msg"]')].map((x) => x.textContent).filter((t) => /Research this game/.test(t)); return u.pop() || null; });
      chk(T + '8 · the conversation shows which game was asked about', bub && /\[Detroit Lions @ Buffalo Bills\]/.test(bub), bub);
      chk(T + '8 · the game research answer: readiness, model, market, disagreement, candidates, sources', r8 && r8.state === 'done' && /^GAME RESEARCH — Detroit Lions @ Buffalo Bills/m.test(r8.answer) && /Model disagreement: 2\.7 points/.test(r8.answer) && r8.cards >= 1 && want8 && r8.answer.indexOf('Model projection: Buffalo Bills -5.2') >= 0, r8 && r8.answer.slice(0, 400));
      const mr8 = await page.evaluate(() => { const cs = [...document.querySelectorAll('#edaiLog .ia-card')]; const c = cs[cs.length - 1]; const d = c && [...c.querySelectorAll('details.ia-more')].find((x) => /Matchup research/.test(x.querySelector('summary').textContent)); return d ? d.textContent : ''; });
      chk(T + '8 · the candidate\'s disagreement names the pricing line, so it is not read as the game\'s 2.7-point gap', /EdgeDesk's pricing line \(-3\.1, its projection blended toward the market\) and the market \(-2\.5\) differ by 0\.6 points/.test(mr8), mr8.slice(0, 300));
      await shot(page, '08b-game-research-answer-' + vp.tag);
      /* the follow-up from the game view: a chip, with the game */
      await page.evaluate(() => window.EDAI.close());
      const sheetStill = await page.evaluate(() => { const s = document.getElementById('igSheet'); return s && !s.hidden; });
      chk(T + '8 · closing the conversation returns to the game view (it is still open)', sheetStill);
      const before8b = SENT.length;
      await page.click('#igBody .ia-chip >> text="What are the biggest offensive mismatches in this game?"');
      await runEnded(page, 5);
      const s8b = SENT[before8b], r8b = await lastRun(page), want8b = resultOf('b_mismatch_buf');
      chk(T + '8 · the follow-up chip carries the same game', s8b && s8b.research_context && s8b.research_context.game && s8b.research_context.game.game_id === 'nfl-fx-det-buf', s8b && s8b.research_context);
      chk(T + '8 · …and is answered for that game only: both unit pairings, the engine\'s sums', r8b && /BIGGEST OFFENSIVE MISMATCHES — NFL, Detroit Lions @ Buffalo Bills/.test(r8b.answer) && want8b && want8b.matchup_edges.rows.length === 2 && want8b.matchup_edges.rows.every((x) => r8b.answer.indexOf((x.edge >= 0 ? '+' : '') + x.edge.toFixed(3)) >= 0), r8b && r8b.answer.slice(0, 300));
      await shot(page, '08c-follow-up-' + vp.tag);
      /* the Ask card now knows the game: "this spread" means it */
      await page.evaluate(() => window.EDAI.close());
      await page.evaluate(() => window.EDINTELUI.closeGame());
      const ctxChip = await page.evaluate(() => { const c = document.getElementById('iaCtx'); return c && !c.hidden ? c.textContent : null; });
      chk(T + '8 · back on Research, the Ask card says which game "this game" now means', ctxChip && /Detroit Lions @ Buffalo Bills/.test(ctxChip), ctxChip);
      const before8c = SENT.length;
      await page.fill('#iaQ', 'Why does EdgeDesk disagree with this spread?');
      await page.press('#iaQ', 'Enter');
      await runEnded(page, 6);
      const s8c = SENT[before8c], r8c = await lastRun(page);
      chk(T + '8 · typed in the Ask card, "this spread" is sent with the game, and answered for it', s8c && s8c.research_context && s8c.research_context.game && s8c.research_context.game.game_id === 'nfl-fx-det-buf' && r8c && /^GAME RESEARCH — Detroit Lions @ Buffalo Bills/m.test(r8c.answer), s8c && [s8c.question, s8c.research_context && s8c.research_context.game]);

      /* ── 9. NAVIGATE AWAY AND BACK ── */
      await page.evaluate(() => window.EDAI.close());
      const logBefore = await page.evaluate(() => document.querySelectorAll('#edaiLog .ia-act').length);
      await page.click('nav [data-v="card"]');
      await page.waitForTimeout(500);
      const onCard = await page.evaluate(() => { const v = document.getElementById('v-card'); return v && getComputedStyle(v).display !== 'none'; });
      const cardRes = await page.evaluate(() => { const h = document.querySelector('#iaCardHost .ia-cardres'); if (!h) return null; const rows = [...h.querySelectorAll('.ia-g')].map((g) => ({ t: g.querySelector('.ia-g-t b').textContent, chip: (g.querySelector('.ia-chipcls') || {}).textContent, kv: [...g.querySelectorAll('.ia-kv-r')].map((r) => r.querySelector('dt').textContent + ': ' + r.querySelector('dd').innerText.replace(/\s+/g, ' ')) }));
        return { head: h.querySelector('h3').textContent, note: (h.querySelector('p') || {}).textContent, rows, card: !!document.querySelector('#eddCardHost').children.length }; });
      const want9 = resultOf('b_slate'), bills9 = want9 && want9.research_slate.investigated.find((r) => r.candidate.selection === 'Buffalo Bills');
      chk(T + '9 · the Card lists what EdgeDesk AI audited, with each status: Buffalo Bills -2.5, Verified candidate, -105 at FanDuel, the engine\'s net EV', cardRes && cardRes.head === 'Researched by EdgeDesk AI' && cardRes.rows.some((r) => r.t === 'Buffalo Bills -2.5' && r.chip === 'Verified candidate' && r.kv.some((x) => /^Price checked: -105 at FanDuel/.test(x)) && bills9 && r.kv.some((x) => x.indexOf('Net EV: ' + (bills9.evaluation.net_ev_per_dollar * 100).toFixed(2) + '% per $1') === 0) && r.kv.some((x) => x === 'Fair used: ' + (bills9.research.fair_probability * 100).toFixed(1) + '% sharp market, no-vig')), cardRes);
      chk(T + '9 · …below the Card\'s own decisions, which still render', cardRes && cardRes.card, cardRes && cardRes.card);
      await page.evaluate(() => { const h = document.getElementById('iaCardHost'); if (h) h.scrollIntoView({ block: 'start' }); });
      await shot(page, '09a-card-researched-' + vp.tag);
      await page.click('nav [data-v="process"]');
      await page.waitForTimeout(400);
      const proc = await page.evaluate(() => { const m = document.querySelector('#iaMethodHost .ia-method'); return m ? { h: m.querySelector('h3').textContent, secs: [...m.querySelectorAll('details > summary')].map((x) => x.textContent), text: m.textContent } : null; });
      chk(T + '9 · Process explains the method, model validation and research verification', proc && proc.h === 'How EdgeDesk researches' && ['The quantitative method', 'Model validation', 'Research verification', 'The adversarial audit and “verified candidate”', 'Readiness: five separate states', 'Limits and cost'].every((k) => proc.secs.includes(k)), proc && proc.secs);
      chk(T + '9 · …and calls nothing calibrated except a VALIDATED model, LEAN a break-even history', proc && /only then is it called calibrated/.test(proc.text) && /a break-even history, not a profit record/.test(proc.text), null);
      await page.evaluate(() => { const m = document.querySelector('#iaMethodHost .ia-method'); if (m) { m.querySelectorAll('details').forEach((d, i) => { d.open = i < 2; }); m.scrollIntoView({ block: 'start' }); } });
      await shot(page, '09b-process-method-' + vp.tag);
      await page.click('nav [data-v="research"]');
      await page.waitForTimeout(500);
      const back = await page.evaluate(() => ({ ask: !!document.querySelector('#iaAskHost .ia-ask'), recent: [...document.querySelectorAll('#iaRecent .ia-chip')].map((c) => c.textContent), ctx: (document.getElementById('iaCtx') || {}).hidden === false, acts: document.querySelectorAll('#edaiLog .ia-act').length,
        rd: !!document.querySelector('#fbOverview .ia-readiness') }));
      chk(T + '9 · Card opens, and back on Research the Ask card, its recent questions and the game context are where they were', onCard && back.ask && back.recent.length >= 3 && back.ctx && back.rd, { onCard, back });
      chk(T + '9 · the conversation is kept: every research run is still in it', back.acts === logBefore && back.acts >= 6, { before: logBefore, after: back.acts });
      await shot(page, '09-back-on-research-' + vp.tag);

      /* ── FAILURE PATHS ── */
      /* HTTP 503, then a retry that works */
      await page.evaluate(() => window.EDINTELUI.setCurrentGame(null));
      MODE.next = 'http503';
      await page.click('#iaAskHost .ia-chip >> text="Which matchup has the biggest offensive advantage?"');
      await runEnded(page, 7);
      const f1 = await page.evaluate(() => { const fs_ = [...document.querySelectorAll('#edaiLog .ia-fail')]; const f = fs_[fs_.length - 1]; return f ? { text: f.innerText, retry: !!f.querySelector('[data-ia-retry]') } : null; });
      chk(T + 'an HTTP 503 says what failed, that the Research screen is unaffected, and offers Try again', f1 && /HTTP 503/.test(f1.text) && /Research screen/.test(f1.text) && f1.retry, f1);
      await page.waitForTimeout(300);
      await shot(page, '10-error-retry-' + vp.tag);
      await page.click('#edaiLog .ia-fail [data-ia-retry]');
      await runEnded(page, 8);
      const rr = await lastRun(page);
      chk(T + '…and Try again asks the same question and gets the engine\'s answer', rr && rr.state === 'done' && /BIGGEST OFFENSIVE MISMATCHES/.test(rr.answer), rr && [rr.state, rr.answer.slice(0, 120)]);
      /* no active subscription (402) and the daily allowance (429): said plainly, nothing researched, the rest of the site unaffected */
      await page.evaluate(() => window.EDAI.close());
      MODE.next = 'http402';
      await page.click('#iaAskHost .ia-chip >> text="Which matchup has the biggest offensive advantage?"');
      await page.waitForFunction(() => /needs an active EdgeDesk subscription/.test(document.getElementById('edaiLog').innerText), null, { timeout: 15000 }).catch(() => {});
      const sub = await page.evaluate(() => { const f = [...document.querySelectorAll('#edaiLog .ia-fail')].pop(); return f ? f.innerText : ''; });
      chk(T + 'no subscription (402): the page says research needs one, that nothing was researched or charged, and the board keeps working', /needs an active EdgeDesk subscription/.test(sub) && /Nothing was researched or charged/.test(sub) && /keep working/.test(sub), sub.slice(0, 300));
      await page.evaluate(() => window.EDAI.close());
      MODE.next = 'http429';
      await page.click('#iaAskHost .ia-chip >> text="Which matchup has the biggest offensive advantage?"');
      await page.waitForFunction(() => /research limit/.test(document.getElementById('edaiLog').innerText), null, { timeout: 15000 }).catch(() => {});
      const lim = await page.evaluate(() => { const f = [...document.querySelectorAll('#edaiLog .ia-fail')].pop(); return f ? f.innerText : ''; });
      chk(T + 'the daily allowance (429): said plainly, with what still works', /today’s EdgeDesk AI research limit/.test(lim) && /Research screen, the Card and every game page still work/.test(lim), lim.slice(0, 300));
      /* a provider fails mid-research: the live injury feed — the answer says what was used instead */
      await page.evaluate(() => window.EDAI.close());
      MODE.next = 'feedfail';
      await page.evaluate(() => window.EDINTELUI.ask(window.EDINTELUI.GAME_Q, { game: { sport: 'americanfootball_nfl', game_id: 'nfl-fx-det-buf', label: 'Detroit Lions @ Buffalo Bills' }, hint: 'GAME_RESEARCH' }));
      await runEnded(page, 11);
      const ff = await lastRun(page);
      chk(T + 'a provider failure (the live injury feed): the activity and the answer say it failed and what was used instead', ff && ff.state === 'done' && ff.steps.some((s) => /live nflverse injury feed: HTTP 503; the committed report was used/.test(s.detail)) && /unavailable: the live nflverse injury feed: HTTP 503; the committed report was used/.test(ff.answer), ff && ff.steps.map((s) => s.detail).slice(0, 10));
      /* the run dies with the server's error event: finished steps stay, with a retry */
      await page.evaluate(() => window.EDAI.close());
      MODE.next = 'stream_error';
      await page.click('#iaAskHost .ia-chip >> text="Analyze every NFL game this weekend."');
      await runEnded(page, 12);
      const se = await page.evaluate(() => { const acts = document.querySelectorAll('#edaiLog .ia-act'); const a = acts[acts.length - 1]; const f = [...document.querySelectorAll('#edaiLog .ia-fail')].pop(); return { state: a.getAttribute('data-state'), done: a.querySelectorAll('.ia-step[data-status="done"]').length, partial: a.querySelectorAll('.ia-partial tr').length, fail: f ? f.innerText : '' }; });
      chk(T + 'a run cut off by an error event keeps its finished steps and whatever partial result arrived, and offers a retry', se.state === 'error' && se.done >= 2 && /stopped before it finished/.test(se.fail) && /the board could not be read/.test(se.fail), se);
      await shot(page, '11-stream-error-' + vp.tag);
      /* cancel: the request is aborted and the page says nothing further was researched */
      await page.evaluate(() => window.EDAI.close());
      MODE.next = 'hold';
      const ab0 = MODE.aborted;
      await page.click('#iaAskHost .ia-chip >> text="Analyze every NFL game this weekend."');
      await page.waitForFunction(() => { const a = [...document.querySelectorAll('#edaiLog .ia-act')].pop(); return a && a.querySelectorAll('.ia-step').length >= 3; }, null, { timeout: 15000 }).catch(() => {});
      await page.click('#edaiLog .ia-act[data-state="running"] [data-ia-cancel]');
      await runEnded(page, 13);
      await page.waitForTimeout(200);
      const cn = await page.evaluate(() => { const a = [...document.querySelectorAll('#edaiLog .ia-act')].pop(); return { state: a.getAttribute('data-state'), title: (a.querySelector('.ia-act-t') || {}).textContent, log: document.getElementById('edaiLog').innerText.slice(-200) }; });
      chk(T + 'Cancel stops the run: the request is aborted, the page says nothing further was researched', cn.state === 'cancelled' && /Nothing further was researched/.test(cn.log) && MODE.aborted > ab0, { cn, aborted: MODE.aborted - ab0 });
      /* timeout (the limit shortened for the test) */
      await page.evaluate(() => { window.EDAI.close(); window.__edIntelTimeoutMs = 1200; });
      MODE.next = 'hold';
      await page.click('#iaAskHost .ia-chip >> text="Analyze every NFL game this weekend."');
      await runEnded(page, 14);
      const to = await page.evaluate(() => { const a = [...document.querySelectorAll('#edaiLog .ia-act')].pop(); const f = [...document.querySelectorAll('#edaiLog .ia-fail')].pop(); return { state: a.getAttribute('data-state'), fail: f ? f.innerText : '' }; });
      await page.evaluate(() => { delete window.__edIntelTimeoutMs; });
      chk(T + 'a timeout ends the run with the steps that finished and a retry', to.state === 'timeout' && /stopped waiting after 1 seconds/.test(to.fail), to);

      /* phone layout: the conversation's input is above the bottom nav, nothing sideways */
      if (vp.tag === 'phone') {
        await page.evaluate(() => window.EDAI.open());
        const lay = await page.evaluate(() => { const i = document.getElementById('edaiText'), nav = document.querySelector('nav.bnav, nav[aria-label="Primary"], body > nav:last-of-type'); const ir = i ? i.getBoundingClientRect() : null; return { inputBottom: ir ? ir.bottom : null, vh: window.innerHeight, sw: document.documentElement.scrollWidth, iw: window.innerWidth, panelW: document.getElementById('edaiPanel').getBoundingClientRect().width }; });
        chk('phone: the conversation input is on screen and the page does not scroll sideways', lay.inputBottom != null && lay.inputBottom <= lay.vh + 1 && lay.sw <= lay.iw + 1, lay);
        await page.evaluate(() => window.EDAI.close());
      }
      chk(T + 'every question the page asked has a recorded engine answer (none unanswered)', UNKNOWN.length === 0, UNKNOWN);
      chk(T + 'no page errors', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) { fail++; console.log('  FAIL the suite threw: ' + String(e && e.stack || e).slice(0, 900)); }
  await browser.close();
  srv.close();
  done();
})();
