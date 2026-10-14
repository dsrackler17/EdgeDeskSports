#!/usr/bin/env node
/* ===========================================================================
   The college baseball engine (Research → Baseball → NCAA engine) in a real
   Chromium, desktop and a 390 px phone, against the committed board files.

   The board: the replay banner and the no-betting banner, every game of the
   date listed, filters, readiness chips, the fair prices from the file.
   A game page: prices, distributions, readiness states with reasons, team
   strength, starters and scenarios, bullpen, environment, model disagreement,
   the market reading unavailable, Back. Advanced: ratings, calibration
   (reliability diagram), audit and gates, the registry.
   States: the board index failing shows an error, never a blank panel.
   No page error and no horizontal page scroll at either width.

   Run: node tools/college_baseball/cbase_ui.e2e.js [--shots DIR]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let pass = 0; let fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'college baseball UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const BOARD = path.join(ROOT, 'college_baseball', 'board');
if (!fs.existsSync(path.join(BOARD, 'index.json'))) { console.log('SKIPPED: no committed board'); process.exit(0); }
const IDX = JSON.parse(fs.readFileSync(path.join(BOARD, 'index.json'), 'utf8'));

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  let indexMode = 'ok';
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/college_baseball/board/index.json' && indexMode === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport) {
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
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/app.html#research/baseball`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 20000 });
    await page.evaluate(() => window.mlbhSetSeg('ncaa'));
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  try {
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      indexMode = 'ok';
      const { ctx, page, errors } = await open(vp);
      await page.waitForSelector('#cbaseHost .cb-t tbody tr', { timeout: 30000 });
      const date = await page.$eval('#cbDate', (s) => s.value);
      const day = JSON.parse(fs.readFileSync(path.join(BOARD, String(IDX.season), date + '.json'), 'utf8'));
      const detail = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(BOARD, String(IDX.season), 'detail', date + '.json.gz'))).toString('utf8'));
      chk(label + ': the segment is labelled and the NCAA engine button is on', await page.evaluate(() => document.querySelector('#mlbhSeg button[data-seg="ncaa"]').classList.contains('on')));
      chk(label + ': the replay is labelled retrospective, not live', await page.evaluate((m) => { const t = document.getElementById('cbaseHost').textContent; return m === 'LIVE' ? /Pregame prices/.test(t) : /Retrospective replay/.test(t) && /not live/.test(t); }, IDX.mode));
      chk(label + ': no betting opportunity is shown, and it says why', await page.evaluate(() => /No betting opportunities are shown/.test(document.getElementById('cbaseHost').textContent)));
      chk(label + ': every game of the date is listed', (await page.$$eval('#cbaseHost tr.cb-row', (x) => x.length)) === day.games.length, { shown: await page.$$eval('#cbaseHost tr.cb-row', (x) => x.length), file: day.games.length });
      const priced = detail.games.find((g) => g.prices && g.starters) || detail.games.find((g) => g.prices);
      chk(label + ': a fair moneyline matches the board file', await page.evaluate((g) => { const tr = document.querySelector('tr.cb-row[data-game="' + g.id + '"]'); return !!tr && tr.textContent.indexOf(g.fh) >= 0; }, { id: priced.game_id, fh: (priced.prices.moneyline.fair_home > 0 ? '+' : '') + priced.prices.moneyline.fair_home }));
      chk(label + ': the market column reads unavailable', await page.evaluate(() => Array.from(document.querySelectorAll('tr.cb-row')).every((tr) => /unavailable/.test(tr.textContent))));
      chk(label + ': no horizontal scroll on the board', await noHScroll(page));
      await shot(page, label + '_board');
      /* filter */
      const team = priced.home.name;
      await page.fill('#cbQ', team);
      chk(label + ': the team filter narrows the board', (await page.$$eval('#cbaseHost tr.cb-row', (x) => x.length)) === day.games.filter((g) => (g.home.name + ' ' + g.away.name).toLowerCase().indexOf(team.toLowerCase()) >= 0).length);
      await page.fill('#cbQ', '');
      /* game page */
      await page.click('tr.cb-row[data-game="' + priced.game_id + '"]');
      await page.waitForSelector('#cbaseHost .cb-states', { timeout: 20000 });
      const txt = await page.$eval('#cbaseHost', (e) => e.textContent);
      chk(label + ': the game page has prices, distributions, readiness, strength and the market section', ['Fair prices', 'Run lines', 'Totals', 'Run distribution', 'Research readiness', 'Opponent-adjusted team strength', 'Market comparison'].every((k) => txt.indexOf(k) >= 0), txt.slice(0, 300));
      chk(label + ': the market comparison is unavailable, with the reason', /Unavailable\./.test(txt) && /baseball_ncaa|authorised/.test(txt));
      chk(label + ': every readiness state is shown separately', (await page.$$eval('#cbaseHost .cb-state', (x) => x.length)) === 7);
      if (priced.starters) chk(label + ': starters are projections, never confirmed', /Starting pitching/.test(txt) && !/\bconfirmed\b(?! without)/i.test(Array.from(await page.$$eval('#cbaseHost .cb-card h4', (x) => x.map((h) => h.textContent))).join(' ')));
      chk(label + ': no horizontal scroll on a game page', await noHScroll(page));
      await shot(page, label + '_game');
      await page.click('[data-back]');
      await page.waitForSelector('#cbaseHost tr.cb-row');
      chk(label + ': Back returns to the board', true);
      /* advanced */
      await page.click('#cbaseHost [data-view="advanced"]');
      await page.waitForSelector('#cbaseHost [data-adv="ratings"]');
      await page.waitForSelector('#cbaseHost .cb-t tbody tr');
      chk(label + ': ratings list the Division I programs', (await page.$$eval('#cbaseHost .cb-t tbody tr', (x) => x.length)) > 250);
      await page.click('#cbaseHost [data-adv="calibration"]');
      await page.waitForSelector('#cbaseHost svg[aria-label="Reliability diagram"]', { timeout: 15000 });
      chk(label + ': calibration shows a reliability diagram', true);
      await page.click('#cbaseHost [data-adv="audit"]');
      await page.waitForFunction(() => /Release gates/.test(document.getElementById('cbaseHost').textContent));
      chk(label + ': the release gates and the audit are shown', await page.evaluate(() => /Release gates/.test(document.getElementById('cbaseHost').textContent) && /Adversarial audit/.test(document.getElementById('cbaseHost').textContent)));
      await page.click('#cbaseHost [data-adv="registry"]');
      await page.waitForFunction(() => /CBX-/.test(document.getElementById('cbaseHost').textContent));
      chk(label + ': the experiment registry lists rejected experiments too', await page.evaluate(() => /REJECT|INCONCLUSIVE/.test(document.getElementById('cbaseHost').textContent)));
      chk(label + ': no horizontal scroll on the advanced views', await noHScroll(page));
      await shot(page, label + '_advanced');
      chk(label + ': no page errors', errors.length === 0, errors);
      await ctx.close();
    }
    /* the board failing */
    indexMode = 'down';
    const { ctx, page } = await open({ width: 1024, height: 800 });
    await page.waitForFunction(() => { const h = document.getElementById('cbaseHost'); return h && /Could not load/.test(h.textContent); }, null, { timeout: 20000 });
    chk('a failing board shows an error, never a blank panel', true);
    await ctx.close();
  } catch (e) { chk('the run completes', false, String(e && e.stack || e).slice(0, 600)); }
  await browser.close(); srv.close();
  done();
})();
