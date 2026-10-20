#!/usr/bin/env node
/* ===========================================================================
   The NBA panel in a real Chromium (app.html, Research → Other → NBA),
   desktop and a 390 px phone, against the committed artifacts (nba/slate.json,
   nba/props_slate.json, nba/validation/summary.json) with the clock pinned to
   the slate's build time.

   Games: the list, a game's every market table and section, the URL it
   writes, the numbers matching the slate, the price check (valid and
   malformed), Back. The matchup graphic leading every game (drawn, read
   aloud, square and portrait) with the status folded under it; a started
   game opening the research frozen before tip (a staged nba/recent.json). Props, Record and Methods tabs. States: the slate
   failing and coming back on Try again, a stale slate, a slate that fails its
   integrity check. No page error and no horizontal page scroll at either width.

   Run: node tools/nba/nba_ui.e2e.js [--shots DIR]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NBA UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'slate.json'), 'utf8'));
const NOW = new Date(Date.parse(SLATE.generated_at) + 60000).toISOString();
/* a started game, frozen before tip, not on the slate: what nba/recent.json holds after tip */
const STARTED = Object.assign(JSON.parse(JSON.stringify(SLATE.games[0])), { game_id: '990000001', start_utc: new Date(Date.parse(NOW) - 2 * 36e5).toISOString().replace(/\.000Z$/, 'Z'), frozen_at: new Date(Date.parse(NOW) - 5 * 36e5).toISOString() });
const RECENT = { schema: 'edgedesk_nba_recent_v1', sport: 'NBA', generated_at: NOW, window_hours: 96, games: [STARTED] };

(async function main() {
  if (!SLATE.games.length) done('SKIP | the committed slate has no games to exercise');
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  let mode = 'ok';
  const slateBody = () => {
    if (mode === 'ok') return JSON.stringify(Object.assign({}, SLATE, { generated_at: NOW }));
    if (mode === 'stale') return JSON.stringify(Object.assign({}, SLATE, { generated_at: new Date(Date.parse(NOW) - 40 * 36e5).toISOString() }));
    if (mode === 'bad') return JSON.stringify({ schema: 'something_else' });
    return null;
  };
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/nba/recent.json') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(RECENT)); return; }
    if (p === '/nba/slate.json') {
      if (mode === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(slateBody()); return;
    }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, hash) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) { /* storage */ }
    });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(`http://127.0.0.1:${port}/app.html${hash || ''}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const overflowers = (page) => page.evaluate(() => { const W = document.documentElement.clientWidth; return Array.from(document.querySelectorAll('body *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1; }).slice(-6).map((e) => e.tagName + '.' + String(e.className).slice(0, 30) + ' right=' + Math.round(e.getBoundingClientRect().right)); });

  try {
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      console.log(label);
      mode = 'ok';
      let { ctx, page, errors } = await open(vp, '#research/nba');
      await page.waitForSelector('#nbaHost .xe-game', { timeout: 25000 });
      chk(label + ': #research/nba opens the NBA panel inside Research', await page.evaluate(() => !document.getElementById('v-nba').classList.contains('hide') && !document.getElementById('v-research').classList.contains('hide')));
      chk(label + ': the Other seat names NBA while it is open', await page.evaluate(() => document.getElementById('rsOtherLbl').textContent === 'NBA' && document.querySelector('#rsOther button[data-sub="nba"]').classList.contains('on')));
      chk(label + ': every slate game is listed', (await page.$$eval('#nbaHost .xe-game:not(.xe-started)', (x) => x.length)) === SLATE.games.length);
      chk(label + ': readiness says value claims are disabled and availability is projected', await page.evaluate(() => { const t = document.querySelector('#nbaHost .xe-ready').textContent; return /Value claims/.test(t) && /disabled/i.test(t) && /projected/.test(t); }));
      chk(label + ': each card shows a win bar, moneyline, spread and total', await page.evaluate(() => Array.from(document.querySelectorAll('#nbaHost .xe-game')).every((c) => c.querySelector('.nb-win') && /ML/.test(c.textContent) && /Spread/.test(c.textContent) && /Total/.test(c.textContent))));
      chk(label + ': no horizontal scroll on the NBA list', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_list');
      const g = SLATE.games[0];
      await page.click('#nbaHost .xe-game[data-game="' + g.game_id + '"]');
      await page.waitForSelector('#nbaHost .xe-detail');
      chk(label + ': opening a game writes its URL', await page.evaluate(() => location.hash) === '#research/nba/' + g.game_id, await page.evaluate(() => location.hash));
      const drawn = () => page.waitForFunction(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i && !i.hidden && /^(blob|data):/.test(i.src) && i.naturalWidth > 0; }, null, { timeout: 25000 }).then(() => true, () => false);
      chk(label + ': the game opens with the matchup graphic', await drawn(), await page.evaluate(() => (document.querySelector('#nbaHost .xe-gfx') || {}).textContent));
      chk(label + ': the graphic is read aloud: both teams, the fair spread and total, research not picks', await page.evaluate((a) => { const t = document.querySelector('#nbaHost #nbGfxImg').alt; return t.indexOf(a.h) >= 0 && t.indexOf(a.a) >= 0 && /fair spread/.test(t) && t.indexOf('fair total ' + a.t) >= 0 && /Research, not picks\.$/.test(t); }, { h: g.home.abbr, a: g.away.abbr, t: g.price.total.fair_line.toFixed(1) }));
      chk(label + ': the graphic leads the game, before the numbers and tables', await page.evaluate(() => { const d = document.querySelector('#nbaHost .xe-detail'), x = d.querySelector('.xe-gfx'), k = d.querySelector('.nb-kpis'); return !!x && !!k && !!(x.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING); }));
      chk(label + ': the data, model and market status folds away under the game', await page.evaluate(() => !!document.querySelector('#nbaHost details.xe-statusd .xe-ready') && !document.querySelector('#nbaHost details.xe-statusd').open));
      chk(label + ': Download, Share and Copy link sit under the graphic', await page.evaluate(() => ['gfx-dl', 'gfx-share', 'gfx-copy'].every((a) => document.querySelector('#nbaHost .xe-gfx [data-act="' + a + '"]'))));
      await page.click('#nbaHost [data-act="gfx-fmt"][data-v="portrait"]');
      chk(label + ': portrait draws a 1080×1350 graphic', await drawn() && await page.evaluate(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i.naturalWidth === 1080 && i.naturalHeight === 1350; }));
      await page.click('#nbaHost [data-act="gfx-fmt"][data-v="square"]');
      chk(label + ': square draws a 1080×1080 graphic', await drawn() && await page.evaluate(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i.naturalWidth === 1080 && i.naturalHeight === 1080; }));
      const caps = await page.$$eval('#nbaHost .xe-t caption', (x) => x.map((c) => c.textContent));
      chk(label + ': a game shows every market and the research', ['Moneyline', 'Spread ladder', 'Total ladder', 'Team totals', 'First half', 'First quarter', 'Winning margin', 'Every candidate', 'Four factors', 'Scenarios'].every((k) => caps.some((c) => c.indexOf(k) === 0)), caps);
      const secs = await page.$$eval('#nbaHost .xe-sechd > span:first-child', (x) => x.map((c) => c.textContent));
      chk(label + ': the sections are all there', ['Every market, one distribution', 'Model comparison', 'The matchup', 'Who is playing', 'If he sits', 'Uncertainty', 'Reasons to pass', 'The market'].every((k) => secs.indexOf(k) >= 0), secs);
      chk(label + ': the fair home moneyline matches the slate', await page.evaluate((a) => document.querySelector('#nbaHost .xe-detail').textContent.indexOf((a > 0 ? '+' : '') + a) >= 0, g.price.moneyline.home_american));
      chk(label + ': reasons to pass are listed', (await page.$$eval('#nbaHost .nb-pass li', (x) => x.length)) === g.reasons_to_pass.length);
      await page.fill('#nbaHost .xe-pc input[name="price"]', '-110');
      await page.click('#nbaHost .xe-pc button[type="submit"]');
      const res = await page.textContent('#nbaHost .xe-pc-res');
      chk(label + ': the price check prints break-even, EdgeDesk and EV, and refuses a value call', /Break-even 52\.4%/.test(res) && /Not a value call/.test(res), res);
      await page.fill('#nbaHost .xe-pc input[name="price"]', 'abc');
      await page.click('#nbaHost .xe-pc button[type="submit"]');
      chk(label + ': a malformed price is refused with a hint', /Enter an American price/.test(await page.textContent('#nbaHost .xe-pc-res')));
      chk(label + ': no horizontal scroll on a game', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_game');
      await page.click('#nbaHost [data-act="back"]');
      await page.waitForSelector('#nbaHost .xe-game');
      await page.waitForSelector('#nbaHost .xe-sechd', { timeout: 15000 });
      await page.waitForFunction(() => /Started/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
      chk(label + ': Back returns to the list', (await page.$$eval('#nbaHost .xe-game:not(.xe-started)', (x) => x.length)) === SLATE.games.length);
      chk(label + ': a started game is listed under its own heading', await page.evaluate(() => /Started · research frozen before tip/.test(document.querySelector('#nbaHost').textContent) && !!document.querySelector('#nbaHost .xe-game.xe-started[data-game="990000001"]')));
      await page.click('#nbaHost .xe-game[data-game="990000001"]');
      await page.waitForSelector('#nbaHost .xe-detail');
      chk(label + ': a started game opens the research frozen before tip, said plainly', await page.evaluate(() => /This game has started/.test(document.querySelector('#nbaHost .xe-detail').textContent)));
      chk(label + ': …with its graphic, a pregame snapshot', await drawn() && await page.evaluate(() => /EdgeDesk research graphic/.test(document.querySelector('#nbaHost #nbGfxImg').alt)));
      chk(label + ': no horizontal scroll on a started game', await noHScroll(page), await overflowers(page));
      await page.click('#nbaHost [data-act="back"]');
      await page.waitForSelector('#nbaHost .xe-game');
      /* tabs */
      await page.click('#nbaHost [data-tab="record"]');
      await page.waitForFunction(() => /Selection window/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 20000 });
      chk(label + ': the record shows every candidate on the selection window and says whether the test is sealed', await page.evaluate(() => { const t = document.querySelector('#nbaHost').textContent; return /Selection window/.test(t) && /(sealed|scored once)/i.test(t) && /Elo/.test(t); }));
      chk(label + ': the record names the reference line as a diagnostic, never a market test', await page.evaluate(() => /DIAGNOSTIC/.test(document.querySelector('#nbaHost').textContent)));
      chk(label + ': no horizontal scroll on the record', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_record');
      await page.click('#nbaHost [data-tab="props"]');
      await page.waitForFunction(() => /fair lines|No prop projections/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 20000 });
      chk(label + ': the props tab shows fair lines (or says it has none)', await page.evaluate(() => /fair lines|No prop projections/.test(document.querySelector('#nbaHost').textContent)));
      chk(label + ': no horizontal scroll on props', await noHScroll(page), await overflowers(page));
      await page.click('#nbaHost [data-tab="methods"]');
      chk(label + ': the methods name all seven model families and the limits', await page.evaluate(() => { const t = document.querySelector('#nbaHost').textContent; return ['Elo', 'efficiency', 'plus-minus', 'simulation', 'boosted', 'Kalman', 'stacked'].every((k) => t.indexOf(k) >= 0) && /Never tested against a closing market/.test(t); }));
      await page.click('#nbaHost [data-tab="games"]');
      await page.waitForSelector('#nbaHost .xe-game');
      /* states */
      mode = 'down';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.err');
      chk(label + ': a failed slate is an error with Try again, nothing in its place', await page.evaluate(() => /could not load/.test(document.querySelector('#nbaHost .xe-banner.err').textContent) && !document.querySelector('#nbaHost .xe-game')));
      mode = 'ok';
      await page.click('#nbaHost .xe-banner.err [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-game');
      chk(label + ': Try again recovers', true);
      mode = 'stale';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.warn');
      chk(label + ': a stale slate says so', /Stale prices/.test(await page.textContent('#nbaHost .xe-banner.warn')));
      mode = 'bad';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.err');
      chk(label + ': a slate that fails its integrity check is refused', /Integrity refusal/.test(await page.textContent('#nbaHost .xe-banner.err')));
      chk(label + ': no page errors on NBA', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close(); srv.close();
  }
  done();
})();
