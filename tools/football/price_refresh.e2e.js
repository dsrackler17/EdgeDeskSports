#!/usr/bin/env node
/* ===========================================================================
   AN OPEN FOOTBALL TAB KEEPS ITS PRICES CURRENT, IN A REAL BROWSER
   (audit 2026-10-01).

   The report: Thursday night, PIT @ CLE, ten hours out. The NFL board read
   NO DECISION · STALE_QUOTE on the spread, the total and the moneyline, and
   "NFL MARKET SELF-CHECK FAILED" named the game as a MARKET FAULT, thirty
   minutes after capture had re-priced it. Two causes, both in app.html:

     1. The tab re-read the captured quotes only when its six-hour re-learn
        came round, so the quotes it held aged past the 90-minute rung
        however often capture ran (fbPriceRefresh now re-reads them every
        five minutes while the module is on screen).
     2. With no current quote, the market was rebuilt from EVERY row on
        file, the opener and every point the line had passed through, and
        that median sat two points off the last line the books dealt
        (fbLatestCapture now takes the newest capture only).

   This loads app.html in Chromium with the committed NFL slate, serves a
   `signals` board for PIT @ CLE whose last capture is three hours old (and
   whose history holds two earlier lines), then lets capture "re-price" it
   and brings the tab back to the foreground.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/football/price_refresh.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}

const NFL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
const NOW = Date.now();
/* the game under test: the first upcoming one on the committed slate */
const GAME = NFL.games.filter((g) => Date.parse(g.kickoff) > NOW + 3600e3).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff))[0] || null;

function nflGamesCsv() {
  const cols = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'away_rest', 'home_rest',
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name'];
  const rows = NFL.games.map((g) => { const r = g.reference_market || {};
    return [g.game_id, g.season, g.game_type || 'REG', g.week, g.gameday, g.gametime_et, g.away_code, 'NA', g.home_code, 'NA', g.away_rest, g.home_rest,
      r.away_ml == null ? 'NA' : r.away_ml, r.home_ml == null ? 'NA' : r.home_ml, r.home_margin == null ? 'NA' : r.home_margin, r.total == null ? 'NA' : r.total,
      g.div_game ? 1 : 0, g.roof || 'NA', g.surface || 'NA', 'NA', 'NA',
      (g.away_starter && g.away_starter.player_id) || 'NA', (g.home_starter && g.home_starter.player_id) || 'NA',
      (g.away_starter && g.away_starter.player_name) || 'NA', (g.home_starter && g.home_starter.player_name) || 'NA'].join(','); });
  return cols.join(',') + '\n' + rows.join('\n') + '\n';
}
/* The game's `signals` rows. The last capture deals home +3 (eight books)
   and +2.5 (two); `signals` also still holds the opener (home -1) and a stop
   at home +1, six books each. `lastMin` is how long ago the last capture ran. */
function signals(lastMin) {
  if (!GAME) return [];
  const ago = (m) => new Date(NOW - m * 60000).toISOString(), out = [], ev = 'e2e_nfl_' + GAME.game_id;
  const base = { event_id: ev, home_team: GAME.home_team, away_team: GAME.away_team, commence_time: GAME.kickoff, first_seen_at: ago(60 * 40) };
  const sp = (homePt, books, seen, modal, bk) => {
    out.push(Object.assign({}, base, { market: 'spreads', selection: GAME.home_team, point: homePt, best_dec: 1.9091, first_best_dec: 1.9091, best_book: bk, n_books: books, last_seen_at: ago(seen), point_is_modal: modal }));
    out.push(Object.assign({}, base, { market: 'spreads', selection: GAME.away_team, point: -homePt, best_dec: 1.9091, first_best_dec: 1.9091, best_book: bk, n_books: books, last_seen_at: ago(seen), point_is_modal: modal }));
  };
  sp(-1, 6, 60 * 30, true, 'FixtureBookA');
  sp(1, 6, 60 * 20, true, 'FixtureBookA');
  sp(3, 8, lastMin, true, 'FixtureBookA');
  sp(2.5, 2, lastMin, false, 'FixtureBookB');
  [['Over', 38.5], ['Under', 38.5]].forEach(([s, pt]) => out.push(Object.assign({}, base, { market: 'totals', selection: s, point: pt, best_dec: 1.9091, first_best_dec: 1.9091, best_book: 'FixtureBookA', n_books: 8, last_seen_at: ago(lastMin), point_is_modal: true })));
  out.push(Object.assign({}, base, { market: 'h2h', selection: GAME.home_team, point: null, best_dec: 2.3, first_best_dec: 1.95, best_book: 'FixtureBookA', n_books: 8, last_seen_at: ago(lastMin) }));
  out.push(Object.assign({}, base, { market: 'h2h', selection: GAME.away_team, point: null, best_dec: 1.65, first_best_dec: 1.95, best_book: 'FixtureBookA', n_books: 8, last_seen_at: ago(lastMin) }));
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  if (!GAME) { console.log('SKIPPED: the committed NFL slate has no upcoming game'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  let lastMin = 180, nflReads = 0;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 2200 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
      localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
    } catch (e) {}
  });
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.indexOf('127.0.0.1') >= 0) return route.continue();
    if (/nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: nflGamesCsv() });
    if (/stats_team_week_(\d{4})\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv')) });
    if (/open-meteo/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (/supabase\.co/.test(url)) {
      if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
      if (/\/signals\?/.test(url) && /americanfootball_nfl/.test(url)) {
        nflReads++;
        /* PostgREST pages: everything on the first page */
        return route.fulfill({ status: 200, contentType: 'application/json', body: /offset=0/.test(url) ? JSON.stringify(signals(lastMin)) : '[]' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/app.html#research/football`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.fbSetSport === 'function', null, { timeout: 30000 });
  await page.evaluate(() => { try { window.researchGo('football'); } catch (e) {} });
  const cardId = 'fbg-nfl-' + GAME.game_id;
  await page.waitForFunction((id) => !!document.getElementById(id), cardId, { timeout: 60000 });
  await page.waitForFunction(() => !!(window.EDDecision && window.EDQuoteEV), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.click('text=Skip for now', { timeout: 2000 }).catch(() => {});
  const read = () => page.evaluate((id) => {
    const body = document.getElementById('fbBody'), card = document.getElementById(id);
    const t = card ? card.textContent.replace(/\s+/g, ' ') : '';
    return { selfCheckFailed: /NFL MARKET SELF-CHECK FAILED/.test(body ? body.textContent : ''), marketFault: /MARKET FAULT/.test(t),
      noFresh: (t.match(/No sufficiently fresh sportsbook quote/g) || []).length, staleMarket: /STALE MARKET/.test(t),
      details: card ? card.querySelectorAll('details').length : 0, open: card ? card.querySelectorAll('details[open]').length : 0,
      decision: (t.match(/EDGEDESK DECISION.{0,240}/i) || [''])[0] };
  }, cardId);

  console.log('\n== ' + GAME.away_team + ' @ ' + GAME.home_team + ': the tab holds a capture three hours old ==');
  const before = await read();
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.locator('#' + cardId).screenshot({ path: path.join(SHOTS, 'before.png') }).catch(() => {}); }
  chk('aged quotes read as stale: NO DECISION · no sufficiently fresh quote', before.noFresh >= 1, before);
  chk('…and are NOT a market fault: the market is the last capture, not every row on file', !before.selfCheckFailed && !before.marketFault, before);

  /* capture re-prices the game; the tab's own read is now six minutes old */
  lastMin = 2;
  const opened = await page.evaluate((id) => { const d = document.getElementById(id).querySelector('details'); if (d) d.open = true; return !!d; }, cardId);
  await page.evaluate(() => { window.FB.nfl.pricesAt = Date.now() - 6 * 60e3; });
  const readsBefore = nflReads;
  /* the reader comes back to the tab */
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction((id) => { const c = document.getElementById(id); return c && !/No sufficiently fresh sportsbook quote/.test(c.textContent); }, cardId, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const after = await read();
  if (SHOTS) await page.locator('#' + cardId).screenshot({ path: path.join(SHOTS, 'after.png') }).catch(() => {});
  console.log('\n== capture re-priced it two minutes ago; the reader returns to the tab ==');
  chk('the tab re-read the captured quotes on its own', nflReads > readsBefore, { readsBefore, nflReads });
  chk('the decision is made on the current quotes: no "no sufficiently fresh quote" anywhere on the card', after.noFresh === 0, after);
  chk('no self-check failure and no market fault', !after.selfCheckFailed && !after.marketFault, after);
  chk('the section the reader had open is still open after the repaint', !opened || after.open >= 1, { opened, after });
  chk('no page errors', errors.length === 0, errors);

  await browser.close(); srv.close();
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | price refresh (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + String(e && e.stack || e)); process.exit(1); });
