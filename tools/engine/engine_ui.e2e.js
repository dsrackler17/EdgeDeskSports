#!/usr/bin/env node
/* ===========================================================================
   The NHL and Engine panels in a real Chromium (app.html, Research → Other),
   desktop and a 390 px phone, against the committed artifacts
   (hockey/slate.json, engine/board.json, engine/registry.json and the NHL
   walk-forward record) with the clock pinned to the slate's build time.

   NHL: the list, a game's seven tabs (the exact decomposition of its price,
   every market table incl. alternates and the first period, the price check
   with a valid and a malformed price, in-page scenario re-pricing, player
   research, model comparison, the per-market record and drift), the URL it
   writes, Back, the full record, the data-source registry.
   Engine: the PASS verdict and its reasons, the sport and market filters,
   a candidate's facts and rules, the readiness and methods sections.
   States: the board failing and coming back on Try again, a stale board, a
   board that fails its integrity check. No page error and no horizontal page
   scroll at either width.

   Run: node tools/engine/engine_ui.e2e.js [--shots DIR]
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
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'engine UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'hockey', 'slate.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'board.json'), 'utf8'));
const NOW = new Date(Date.parse(SLATE.generated_at) + 60000).toISOString();

(async function main() {
  if (!SLATE.games.length) done('SKIP | the committed slate has no games to exercise');
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  let boardMode = 'ok';
  const boardBody = () => {
    const fresh = Object.assign({}, BOARD, { evaluated_at: NOW });
    if (boardMode === 'ok') return JSON.stringify(fresh);
    if (boardMode === 'stale') return JSON.stringify(Object.assign({}, BOARD, { evaluated_at: new Date(Date.parse(NOW) - 40 * 36e5).toISOString() }));
    if (boardMode === 'bad') return JSON.stringify({ schema: 'something_else' });
    return null;
  };
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/engine/board.json') {
      if (boardMode === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(boardBody()); return;
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
  /* on failure, name the elements that stick out past the viewport */
  const overflowers = (page) => page.evaluate(() => { const W = document.documentElement.clientWidth; return Array.from(document.querySelectorAll('body *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1; }).slice(-6).map((e) => e.tagName + '.' + String(e.className).slice(0, 30) + ' right=' + Math.round(e.getBoundingClientRect().right) + ' "' + (e.textContent || '').slice(0, 50) + '"'); });

  try {
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      console.log(label);
      /* ---------------- NHL ---------------- */
      boardMode = 'ok';
      let { ctx, page, errors } = await open(vp, '#research/nhl');
      await page.waitForSelector('#nhlHost .xe-game', { timeout: 20000 });
      chk(label + ': #research/nhl opens the NHL panel inside Research', await page.evaluate(() => !document.getElementById('v-nhl').classList.contains('hide') && !document.getElementById('v-research').classList.contains('hide')));
      chk(label + ': the Other seat names NHL while it is open', await page.evaluate(() => document.getElementById('rsOtherLbl').textContent === 'NHL' && document.querySelector('#rsOther button[data-sub="nhl"]').classList.contains('on')));
      chk(label + ': every upcoming game is listed', (await page.$$eval('#nhlHost .xe-game', (x) => x.length)) === SLATE.games.length);
      chk(label + ': readiness says value claims are disabled and why', await page.evaluate(() => /value claims/i.test(document.querySelector('.xe-ready').textContent) && /disabled/i.test(document.querySelector('.xe-ready').textContent) && /closing/i.test(document.querySelector('.xe-ready').textContent)));
      chk(label + ': each card shows a fair moneyline and a total', await page.evaluate(() => Array.from(document.querySelectorAll('.xe-game')).every((c) => /ML/.test(c.textContent) && /Total/.test(c.textContent))));
      chk(label + ': no horizontal scroll on the NHL list', await noHScroll(page));
      chk(label + ': the record names its second source and calls it a check of past data, not a forecast', await page.evaluate(() => { const e = document.querySelector('#nhlHost .xe-2nd'); return !!e && /Second source/.test(e.textContent) && /2024-25/.test(e.textContent) && /not a forecast/.test(e.textContent); }));
      await shot(page, label + '_nhl_list');
      const g = SLATE.games[0];
      await page.click('#nhlHost .xe-game[data-game="' + g.game_id + '"]');
      await page.waitForSelector('#nhlHost .xe-detail');
      chk(label + ': opening a game writes its URL', await page.evaluate(() => location.hash) === '#research/nhl/' + g.game_id, await page.evaluate(() => location.hash));
      /* the game page is tabbed: walk every tab, collecting what it shows */
      const tabs = await page.$$eval('#nhlHost .xe-tabs button', (x) => x.map((b) => b.dataset.tab));
      chk(label + ': the game page has the seven research tabs', ['overview', 'markets', 'scenarios', 'players', 'evidence', 'models', 'record'].every((t) => tabs.indexOf(t) >= 0), tabs);
      const overview = await page.textContent('#nhlHost .xe-tabp');
      const ex = g.explanation;
      if (ex) {
        chk(label + ': Overview explains the number from the model, and says it is not AI-written', /Why /.test(overview) && /computed from the model — not written by AI/.test(overview) && /no language model/.test(overview), overview.slice(0, 300));
        const nFactors = await page.$$eval('#nhlHost .xe-why2 li:not(.xe-wsum)', (x) => x.length);
        chk(label + ': every factor of the decomposition is listed', nFactors === ex.factors.length, [nFactors, ex.factors.length]);
        chk(label + ': the decomposition adds up exactly to the published probability', ex.check && ex.check.exact === true && /exact/.test(overview));
      }
      chk(label + ': Overview says whether a price is actionable and why not', /Is a price actionable\?/.test(overview) && /No\./.test(overview));
      chk(label + ': no horizontal scroll on Overview', await noHScroll(page), await overflowers(page));
      const caps = [];
      for (const t of ['markets', 'evidence']) { await page.click('#nhlHost .xe-tabs button[data-tab="' + t + '"]'); await page.waitForSelector('#nhlHost .xe-tabs button.on[data-tab="' + t + '"]'); caps.push(...await page.$$eval('#nhlHost .xe-t caption', (x) => x.map((c) => c.textContent))); chk(label + ': no horizontal scroll on ' + t, await noHScroll(page), await overflowers(page)); }
      chk(label + ': the game shows moneyline, 3-way, puck line, totals, team totals, goalies, lineups and evidence', ['Moneyline', '60-minute', 'Puck line', 'Total', 'Team totals', 'Goalies', 'Lineups', 'Evidence'].every((k) => caps.some((c) => c.indexOf(k) === 0)), caps);
      if (g.markets) chk(label + ': alternate lines, regulation totals and the first period are priced, each with its held-out status', ['Regulation total', 'First period', 'First-period total'].every((k) => caps.some((c) => c.indexOf(k) === 0)) && caps.some((c) => /alternates/.test(c)), caps);
      chk(label + ': the lineup block never calls a projection confirmed', caps.filter((c) => c.indexOf('Lineups') === 0).every((c) => !/confirmed/i.test(c.split(' · ')[0])), caps.filter((c) => c.indexOf('Lineups') === 0));
      await page.click('#nhlHost .xe-tabs button[data-tab="markets"]');
      chk(label + ': the fair home moneyline matches the slate', await page.evaluate((fh) => document.querySelector('.xe-detail').textContent.indexOf((fh > 0 ? '+' : '') + fh) >= 0, g.prices.moneyline.fair_home));
      chk(label + ': uncaptured prices are said to be uncaptured, not shown as missing value', /not captured|not authorised|No captured prices/i.test(await page.textContent('#nhlHost .xe-tabp')));
      await page.waitForFunction(() => !!window.EDNHLMarket, null, { timeout: 15000 }).catch(() => {});
      await page.fill('.xe-pc input[name="price"]', '-110');
      await page.click('.xe-pc button[type="submit"]');
      const res = await page.textContent('.xe-pc-res');
      chk(label + ': the price check prints break-even, EdgeDesk and EV, and refuses a value call', /Break-even 52\.4%/.test(res) && /Not a value call/.test(res) && !/verified value/i.test(res), res);
      await page.fill('.xe-pc input[name="price"]', 'abc');
      await page.click('.xe-pc button[type="submit"]');
      chk(label + ': a malformed price is refused with a hint', /Enter an American price/.test(await page.textContent('.xe-pc-res')));
      /* scenarios: re-priced in the page with the slate's own code */
      await page.click('#nhlHost .xe-tabs button[data-tab="scenarios"]');
      await page.waitForSelector('#nhlHost .xe-scn-out .xe-t', { timeout: 15000 });
      const base0 = await page.textContent('#nhlHost .xe-scn-out caption');
      chk(label + ': Scenarios start from the published price', /production model/.test(base0), base0);
      const opts = await page.$$eval('#nhlHost select[data-scn="home"] option', (x) => x.map((o) => o.value).filter(Boolean));
      if (opts.length) {
        await page.selectOption('#nhlHost select[data-scn="home"]', opts[opts.length - 1]);
        const cap = await page.textContent('#nhlHost .xe-scn-out caption');
        chk(label + ': choosing a goalie re-prices with the goalie-aware variant', /goalie-aware variant/.test(cap), cap);
      }
      await page.$eval('#nhlHost input[data-scn="adjH"]', (el) => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      chk(label + ': a what-if is labelled as the reader\'s, not the model\'s', /your what-if/.test(await page.textContent('#nhlHost .xe-scn-out caption')));
      chk(label + ': no horizontal scroll on Scenarios', await noHScroll(page), await overflowers(page));
      /* players, models, record */
      await page.click('#nhlHost .xe-tabs button[data-tab="players"]');
      await page.waitForSelector('#nhlHost .xe-tabp .xe-t, #nhlHost .xe-tabp .xe-empty', { timeout: 15000 });
      const players = await page.textContent('#nhlHost .xe-tabp');
      chk(label + ': Players is research only, says why, and assumes the player dresses', /Research only/.test(players) && /No NHL prop prices are captured/.test(players) && /dresses/.test(players));
      chk(label + ': no horizontal scroll on Players', await noHScroll(page), await overflowers(page));
      await page.click('#nhlHost .xe-tabs button[data-tab="models"]');
      const models = await page.textContent('#nhlHost .xe-tabp');
      if (g.challengers) chk(label + ': Models compares every challenger on this game with its held-out record, the production model marked', /win probability by model/.test(models) && /production/.test(models) && (await page.$$eval('#nhlHost .xe-tabp .xe-t:first-of-type tr', (x) => x.length)) >= 4, models.slice(0, 200));
      chk(label + ': no horizontal scroll on Models', await noHScroll(page), await overflowers(page));
      await page.click('#nhlHost .xe-tabs button[data-tab="record"]');
      await page.waitForFunction(() => /Drift monitor/.test(document.querySelector('#nhlHost .xe-tabp').textContent), null, { timeout: 15000 }).catch(() => {});
      const record = await page.textContent('#nhlHost .xe-tabp');
      chk(label + ': Record lists every market\'s held-out status and the drift monitor', /held-out status/.test(record) && /Drift monitor/.test(record) && /AUC/.test(record), record.slice(0, 200));
      chk(label + ': no horizontal scroll on Record', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nhl_game');
      await page.click('[data-act="back"]');
      await page.waitForSelector('#nhlHost .xe-game');
      chk(label + ': Back returns to the list', (await page.$$eval('#nhlHost .xe-game', (x) => x.length)) === SLATE.games.length);
      await page.click('[data-act="record"]');
      await page.waitForSelector('#nhlHost .xe-t caption', { timeout: 20000 });
      chk(label + ': the full record shows held-out log loss by model', await page.evaluate(() => Array.from(document.querySelectorAll('#nhlHost .xe-t caption')).some((c) => /Moneyline log loss/.test(c.textContent))));
      await page.click('[data-act="sources"]');
      await page.waitForSelector('#nhlHost .xe-sport summary', { timeout: 15000 });
      const src = await page.textContent('#nhlHost');
      chk(label + ': the data-source registry separates operational, awaiting-permission and methodology-only providers', /MoneyPuck/.test(src) && /methodology only/i.test(src) && /awaiting permission/i.test(src) && /operational|stale/i.test(src));
      chk(label + ': no horizontal scroll with the registry open', await noHScroll(page), await overflowers(page));
      chk(label + ': no page errors on NHL', errors.length === 0, errors);
      await ctx.close();

      /* ---------------- ENGINE ---------------- */
      ({ ctx, page, errors } = await open(vp, '#research/engine'));
      await page.waitForSelector('#engineHost .xe-verdict', { timeout: 20000 });
      chk(label + ': #research/engine opens the Engine panel', await page.evaluate(() => !document.getElementById('v-engine').classList.contains('hide')));
      const verdict = await page.textContent('.xe-verdict');
      chk(label + ': the verdict is the board\'s, with its reasons', BOARD.verdict === 'PASS' ? /PASS/.test(verdict) && BOARD.why.every((w) => verdict.indexOf(w.slice(0, 30)) >= 0) : /Best-supported/.test(verdict), verdict.slice(0, 300));
      const ladder = await page.$$eval('#engineHost .xe-ladder tr', (rows) => rows.map((r) => Array.from(r.children).map((c) => c.textContent.trim())));
      chk(label + ': the readiness ladder keeps data, model, validation, market test, verified price and actionable apart, for all 12 sports', ladder.length === 13 && ['Historical data loaded', 'Model trained', 'Validation passed', 'Tested vs closing prices', 'Market price verified now', 'Actionable signal'].every((h, i) => ladder[0][i + 1] === h), ladder[0]);
      const covN = await page.$$eval('#engineHost .xe-sport', (x) => x.length);
      chk(label + ': no sport is marked actionable while the board says PASS', BOARD.verdict !== 'PASS' || ladder.slice(1).every((r) => /^—/.test(r[6])), ladder.map((r) => r[0] + ':' + r[6]));
      chk(label + ': readiness and methods cover all 12 sports (+ sources)', covN === 12 * 2 + 1, covN);
      await page.click('.xe-seg button[data-f="sport"][data-v="nhl"]');
      const sports = await page.$$eval('#engineHost .xe-card .xe-sub', (x) => x.map((s) => s.textContent.split(' · ')[0]));
      chk(label + ': the sport filter keeps NHL only', sports.length > 0 && sports.every((s) => s === 'NHL'), sports.slice(0, 5));
      await page.click('.xe-seg button[data-f="market"][data-v="total"]');
      const labels = await page.$$eval('#engineHost .xe-card .xe-mu', (x) => x.map((s) => s.textContent));
      chk(label + ': the market filter keeps totals only', labels.length > 0 && labels.every((s) => /(over|under) \d/.test(s)), labels.slice(0, 4));
      await page.click('#engineHost .xe-cardh');
      await page.waitForSelector('#engineHost .xe-facts');
      const facts = await page.textContent('#engineHost .xe-facts');
      chk(label + ': a candidate shows event, book, fair price, break-even, probability, EV, minimum price, rules, evidence and invalidators', ['Event', 'Sportsbook', 'Fair price', 'Break-even', 'Probability', 'EV at the price', 'Minimum acceptable price', 'Rules applied', 'Supporting evidence', 'What could invalidate it'].every((k) => facts.indexOf(k) >= 0), facts.slice(0, 300));
      await page.click('#engineHost .xe-sport summary');
      chk(label + ': a sport\'s readiness expands to markets, data, blockers and enable steps', await page.evaluate(() => { const t = document.querySelector('#engineHost .xe-sport[open]').textContent; return /Markets/.test(t) && /Blocked by/.test(t) && /To enable/.test(t); }));
      chk(label + ': no horizontal scroll on the engine', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_engine');
      /* states */
      boardMode = 'down';
      await page.click('[data-act="refresh"]');
      await page.waitForSelector('#engineHost .xe-banner.err');
      chk(label + ': a failed board is an error with Try again, nothing in its place', await page.evaluate(() => /could not load/.test(document.querySelector('.xe-banner.err').textContent) && !document.querySelector('.xe-verdict')));
      boardMode = 'ok';
      await page.click('.xe-banner.err [data-act="refresh"]');
      await page.waitForSelector('#engineHost .xe-verdict');
      chk(label + ': Try again recovers', true);
      boardMode = 'stale';
      await page.click('[data-act="refresh"]');
      await page.waitForSelector('#engineHost .xe-banner.warn');
      chk(label + ': a stale board says so', /Stale board/.test(await page.textContent('#engineHost .xe-banner.warn')));
      boardMode = 'bad';
      await page.click('[data-act="refresh"]');
      await page.waitForSelector('#engineHost .xe-banner.err');
      chk(label + ': a board that fails its integrity check is refused', /Integrity refusal/.test(await page.textContent('#engineHost .xe-banner.err')));
      chk(label + ': no page errors on Engine', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close(); srv.close();
  }
  done();
})();
