#!/usr/bin/env node
/* ===========================================================================
   SP+ ON THE GAME PAGE AND THE RESEARCH TERMINAL, IN A REAL BROWSER.

   The committed pages and research objects are served from the checkout;
   only football/sp_plus/lines.json is staged per scenario, for one upcoming
   CFB game that both the game page (football/game_research/current.json) and
   the research terminal (football/cfb_terminal/games.json) carry:
     FRESH   captured two days ago, SP+ 5 points off EdgeDesk  -> the line,
                                                                 the tiers, the
                                                                 attribution and
                                                                 "Models disagree"
     STALE   captured ten days ago                             -> unavailable, why
     MISSING the file answers 404                              -> unavailable; the
                                                                 page still renders
   Every third-party host is stubbed, so the run is offline and deterministic.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one
   (SKIPPED is not a pass: CI installs both).
   Run:  node football/sp_plus/ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SP = require('../../lib/cfb_sp_plus.js');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function finish(code) {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | SP+ on the game page and the terminal (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(code != null ? code : (fail ? 1 : 0));
}

const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
const TERM = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const G = CUR.games.find((g) => g.league === 'cfb' && g.model.available && !g.started && TERM.games[g.game_id] && TERM.games[g.game_id].edgedesk.available);
let MODE = 'FRESH';
function staged() {
  const ed = -G.model.fair.home_line, sp = Math.round((ed - 5) * 100) / 100;
  const at = new Date(Date.now() - (MODE === 'STALE' ? 10 : 2) * 864e5).toISOString();
  const games = {};
  games[G.game_id] = { home: G.home.name, away: G.away.name, week: 9, week_key: '2026:0:09', state: 'AVAILABLE', reason: null, home_margin: sp, home_line: -sp || 0 };
  return { schema: SP.SCHEMA, status: 'OK', season: 2026, last_attempt: { at, week_key: '2026:0:09', status: 'OK', reason: null },
    snapshot: { season: 2026, week: 9, week_key: '2026:0:09', captured_at: at, source_version: 'cfbd-ratings-sp:2026:abcdef012345' }, games };
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  if (p === '/research/cfb/') p = '/research/cfb/index.html';
  if (p === SP.URL) {
    if (MODE === 'MISSING') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(staged())); return;
  }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  if (!G) { console.log('SKIPPED: no upcoming CFB game is on both the game page and the terminal in this checkout'); process.exit(0); }
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port, base = 'http://127.0.0.1:' + port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(url) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) {}
    });
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(base + url, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const shot = async (page, name, sel) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    const el = sel ? await page.$(sel) : null;
    await (el || page).screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const want = SP.lineText(G.home.name, G.away.name, Math.round((-G.model.fair.home_line - 5) * 100) / 100);
  const overviewText = (page) => page.evaluate(() => ((document.querySelector('[aria-label="Game overview"]') || {}).innerText || ''));
  async function gamePage(mode) {
    MODE = mode;
    const o = await open('/app.html#game/cfb/' + encodeURIComponent(G.game_id));
    await o.page.waitForFunction(() => !!window.EDGameView, null, { timeout: 30000 }).catch(() => {});
    for (let i = 0; i < 3; i++) { await o.page.click('text=Skip for now', { timeout: 1000 }).catch(() => {}); await o.page.waitForTimeout(250); }
    await o.page.waitForFunction(() => { const t = (document.querySelector('[aria-label="Game overview"]') || {}).innerText || ''; return /SP\+ projection/i.test(t) && !/reading the external SP\+ line/i.test(t); }, null, { timeout: 45000 }).catch(() => {});
    const t = await overviewText(o.page);
    return Object.assign(o, { t });
  }
  async function terminal(mode) {
    MODE = mode;
    const o = await open('/research/cfb/#/game/' + encodeURIComponent(G.game_id));
    await o.page.waitForFunction(() => /SP\+ projection/i.test((document.getElementById('view') || {}).innerText || ''), null, { timeout: 45000 }).catch(() => {});
    const t = await o.page.evaluate(() => (document.getElementById('view') || {}).innerText || '');
    const proj = await o.page.evaluate(() => (document.getElementById('rz-projection') || {}).innerText || '');
    return Object.assign(o, { t, proj });
  }

  console.log('\n== the game page · ' + G.away.name + ' @ ' + G.home.name + ' (' + G.game_id + ')');
  let r = await gamePage('FRESH');
  chk('FRESH: the overview has an SP+ projection tile', /SP\+ projection/i.test(r.t), r.t.slice(0, 600));
  chk('FRESH: with the SP+ line, named for its favourite', r.t.indexOf(want) >= 0, { want, t: r.t.slice(0, 600) });
  chk('FRESH: labelled external (T3) and computed (T2), with its week', /T3 external model · T2 computed line · SP\+ week 9/.test(r.t), r.t.slice(0, 800));
  chk('FRESH: with the attribution, word for word', r.t.indexOf(SP.ATTRIBUTION) >= 0);
  chk('FRESH: 5 points off EdgeDesk: Models disagree', /Models disagree/i.test(r.t) && /5\.0 points apart/.test(r.t), r.t.slice(0, 800));
  chk('FRESH: EdgeDesk’s fair spread is still its own tile', /Fair spread/i.test(r.t) && r.t.indexOf(G.model.display ? G.model.display.spread.text : G.model.fair.text) >= 0);
  chk('no page error', r.errors.length === 0, r.errors);
  await shot(r.page, 'game_page_fresh', '[aria-label="Game overview"]');
  await r.ctx.close();
  r = await gamePage('STALE');
  chk('STALE: the tile says Unavailable', /SP\+ projection/i.test(r.t) && /Unavailable/i.test(r.t), r.t.slice(0, 600));
  chk('STALE: with the reason', /older than the current week/.test(r.t), r.t.slice(0, 600));
  chk('STALE: and never the stale number', r.t.indexOf(want) < 0);
  await r.ctx.close();
  r = await gamePage('MISSING');
  chk('MISSING: unavailable, the file did not load', /Unavailable/i.test(r.t) && /the SP\+ file did not load/.test(r.t), r.t.slice(0, 600));
  chk('MISSING: the rest of the overview still renders', /Fair spread/i.test(r.t) && /Win probability/i.test(r.t));
  await r.ctx.close();

  console.log('\n== the research terminal');
  r = await terminal('FRESH');
  chk('FRESH: the terminal shows the SP+ projection', /SP\+ projection/i.test(r.t), r.t.slice(0, 600));
  chk('FRESH: with the line', r.t.indexOf(want) >= 0, { want });
  chk('FRESH: the tiers, the week and the attribution', /T3 external model · T2 computed line · SP\+ week 9/.test(r.t) && r.t.indexOf(SP.ATTRIBUTION) >= 0);
  chk('FRESH: Models disagree', /Models disagree/i.test(r.t));
  chk('FRESH: beside EdgeDesk’s fair line', /EdgeDesk fair/i.test(r.t));
  chk('FRESH: in the first section, right after the fair spread', /Fair spread[\s\S]*?SP\+ projection/i.test(r.proj) && r.proj.indexOf(want) >= 0
    && r.proj.search(/SP\+ projection/i) < r.proj.search(/Projected score|Fair total/i), r.proj.slice(0, 400));
  chk('no page error', r.errors.length === 0, r.errors);
  await shot(r.page, 'terminal_fresh', '#rz-projection');
  await r.ctx.close();
  r = await terminal('STALE');
  chk('STALE: unavailable, with the reason, never the number', /unavailable/i.test(r.t) && /older than the current week/.test(r.t) && r.t.indexOf(want) < 0, r.t.slice(0, 600));
  chk('STALE: the first section says unavailable too', /SP\+ projection/i.test(r.proj) && /Unavailable/i.test(r.proj) && r.proj.indexOf(want) < 0, r.proj.slice(0, 400));
  await r.ctx.close();
  r = await terminal('MISSING');
  chk('MISSING: unavailable; the research page still renders', /the SP\+ file did not load/.test(r.t) && /EdgeDesk fair/i.test(r.t), r.t.slice(0, 600));
  await r.ctx.close();

  await browser.close();
  srv.close();
  finish();
})().catch((e) => { console.error(e && e.stack || e); finish(1); });
