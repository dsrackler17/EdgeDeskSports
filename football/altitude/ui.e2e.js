#!/usr/bin/env node
/* ===========================================================================
   ALTITUDE & TRAVEL, IN A REAL BROWSER — app.html in Chromium at a 390 px
   phone and a 1280 px desktop, on the committed Notre Dame at BYU research
   snapshot (football/game_research/current.json, game 401856809) with the
   altitude block the module builds for it added the way
   lib/edgedesk_game_snapshot.js fromCfb adds it.

   Checks the section is there, says Research only, prints the sourced
   elevations, the climb, the trip and 0.0 pts, keeps the shadow estimate
   inside "Data and method", fits a phone without horizontal scroll, and that
   the projection on the page is the one the snapshot carries (the section
   moves nothing). Fonts and every third-party host are stubbed, so the run is
   offline and deterministic.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node football/altitude/ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
global.window = global.window || global;

const A = require('./engine.js');
const PARAMS = require('./params.js');
const REG = require('./venues.json');
const FIX = require('./fixtures/byu_notredame.json');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); }
function finish(code) { console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | altitude section (browser) | ' + pass + ' passed, ' + fail + ' failed'); process.exit(code != null ? code : (fail ? 1 : 0)); }

const GID = '401856809';
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
const snap = CUR.games.find((g) => g.league === 'cfb' && String(g.game_id) === GID);
const rows = FIX.games.filter((r) => r.season === 2026 || r.season === 2025);
const ctx = A.context(FIX.games.find((r) => String(r.game_id) === GID), { registry: REG, normKey: FBS.normKey, index: A.teamIndex(rows, FBS.normKey) });
const adj = A.adjustment(ctx, PARAMS, { flag_enabled: false });
const block = GS.altitudeBlock(Object.assign(A.publish(ctx, adj, PARAMS), { engine_contribution: { points: 0, available: false, reason: adj.reason } }));
function staged() {
  const c = JSON.parse(JSON.stringify(CUR));
  const s = c.games.find((g) => g.league === 'cfb' && String(g.game_id) === GID);
  s.altitude_travel = block;
  s.started = false;
  return c;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  if (p === '/football/game_research/current.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(staged())); return; }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  if (!snap) { console.log('SKIPPED: the committed research snapshots no longer carry Notre Dame at BYU'); process.exit(0); }
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  try {
    for (const vp of [{ width: 390, height: 844, tag: 'phone' }, { width: 1280, height: 900, tag: 'desktop' }]) {
      console.log('\n' + vp.tag + ' ' + vp.width + 'px');
      const bctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      /* the same signed-in reader tools/football/game_research_ui.e2e.js uses */
      await bctx.addInitScript(() => {
        try {
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        } catch (e) {}
      });
      await bctx.route('**/*', (route) => {
        const url = route.request().url();
        if (url.indexOf('127.0.0.1') >= 0) return route.continue();
        if (/supabase\.co/.test(url)) {
          if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        }
        return route.fulfill({ status: 204, body: '' });
      });
      const page = await bctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
      await page.goto('http://127.0.0.1:' + port + '/app.html#game/cfb/' + GID, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.EDGameView, null, { timeout: 60000 });
      await page.waitForTimeout(1200);
      for (let i = 0; i < 3; i++) { await page.click('text=Skip for now', { timeout: 1000 }).catch(() => {}); await page.waitForTimeout(250); }
      const ok = await page.waitForSelector('section.gv-alt', { timeout: 30000 }).then(() => true).catch(() => false);
      chk('the Altitude & travel section renders', ok);
      if (!ok) { await bctx.close(); continue; }
      const text = await page.$eval('section.gv-alt', (el) => el.innerText);
      ['Altitude & travel', 'Research only', 'LaVell Edwards Stadium', '4,633 ft', '731 ft', '+3,902 ft', 'High altitude exposure',
        'Statistical support', 'Validated model adjustment', 'Impact on EdgeDesk', '0.0 pts', 'pending validation', '1,325 miles', 'Data and method']
        .forEach((t) => chk('shows "' + t + '"', text.toLowerCase().indexOf(t.toLowerCase()) >= 0));   /* headings are upper-cased by CSS */
      chk('the shadow estimate stays inside "Data and method" until opened', !(await page.isVisible('section.gv-alt details tr:has-text("Shadow estimate")')));
      await page.click('section.gv-alt details summary');
      chk('opening "Data and method" shows the shadow, labelled NOT in the number', await page.isVisible('section.gv-alt details tr:has-text("NOT in the number")'));
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      chk('no horizontal scroll at ' + vp.width + 'px', wide <= 1, wide);
      const fair = await page.$eval('.gv', (el) => el.innerText);
      const want = snap.model.display ? snap.model.display.spread.text : snap.model.fair.text;
      chk('the page’s fair spread is the snapshot’s (' + want + '): the section moves nothing', fair.indexOf(want) >= 0);
      chk('no page errors', errors.length === 0, errors);
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        const el = await page.$('section.gv-alt');
        await el.screenshot({ path: path.join(SHOTS, 'altitude_' + vp.tag + '.png') });
      }
      await bctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  finish();
})().catch((e) => { console.error(e); fail++; finish(1); });
