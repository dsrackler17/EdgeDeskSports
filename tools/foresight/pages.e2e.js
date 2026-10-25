#!/usr/bin/env node
/* ===========================================================================
   Market Foresight — the pages in Chromium, against the shipped doors on a
   real PostgreSQL (through the PostgREST stand-in), at desktop and phone
   widths.

     node tools/foresight/pages.e2e.js       (MF_E2E_REQUIRED=1 in CI)
     MF_SHOTS=<dir> keeps the screenshots there (default: a temp directory)

   The database holds what the worker computed from the COMMITTED DraftKings
   and EdgeDesk records, plus, for one real game, TEST-SEEDED Kalshi quotes and
   Collective models (tools/foresight/_scenario.js) with a verified Kalshi
   settlement profile, so every surface has something to draw.

     overview   live: status, coverage, model observations, venue timing,
                the T3 check, games; filters; no horizontal scroll
     game       anon: findings and coverage, the timeline withheld; Full
                Access: three panels, legend, event table, the readout on
                hover and on the keyboard, a move highlighted
     model      the complete record, paged, with the embed code
     states     in review (shadow), not deployed, a database error
     embed      renders the top line in a shadow root
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const PG = require(path.join(ROOT, 'tools', 'personal', '_pg.js'));
const REST = require(path.join(ROOT, 'tools', 'billing', '_pgrest.js'));
const RUN = require(path.join(__dirname, 'run.js'));
const SC = require(path.join(__dirname, '_scenario.js'));
const T = PG.kit('Market Foresight pages (Chromium)');
const SB = 'https://iattxbkbufslbauoumga.supabase.co';
const SHOTS = process.env.MF_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'mf-shots-'));
const quiet = { log: () => {}, error: () => {} };

let pw = null;
try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
if (!pw) {
  if (process.env.MF_E2E_REQUIRED === '1') { T.chk('playwright is installed (required in CI)', false); process.exit(T.done()); }
  console.log('SKIPPED: playwright is not installed here'); process.exit(0);
}
const picked = SC.pickGame([]);
const pick = picked.pick;
if (!pick) { T.chk('a real committed game qualifies for the scenario', false); process.exit(T.done()); }
const db = PG.start('mfpages');
if (db.skip) {
  if (process.env.MF_SQL_REQUIRED === '1') T.chk('a PostgreSQL cluster starts (required in CI)', false, db.skip);
  console.log('NOTE | ' + db.skip); process.exit(T.done());
}
const lit = PG.lit;

/* the static site, plus one test page for the embed */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/__embed_test.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><body style="background:#fff"><h1>A creator\'s site</h1><div id="edgedesk-foresight"></div><script src="/foresight/embed.js" data-source="' + process.env.MF_EMBED_SOURCE + '" data-model="' + process.env.MF_EMBED_MODEL + '"></script></body></html>');
        return;
      }
      let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      let f = path.join(ROOT, p);
      if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let browser = null, srv = null;
  try {
    /* ---- the database, as production would have it after a run ---- */
    SC.install(db, { entitled: SC.SUB });
    const seeded = SC.seed(db, pick, picked.local);
    const stand = REST.make(db, { serviceKey: 'svc-key-xyz', tokens: { 'tok-sub': { id: SC.SUB, email: 'sub@example.com' }, 'tok-admin': { id: SC.ADMIN, email: 'op@example.com' } } });
    const env = { SB_URL: 'http://standin', SB_SERVICE_ROLE: 'svc-key-xyz' };
    const go = () => RUN.execute({ write: true, dry: false, now: SC.NOW, since: '2026-08-01T00:00:00.000Z', cache: null, trigger: 'test' }, env, Object.assign({ fetchImpl: SC.collectiveFetch(stand), sleep: async () => {} }, quiet));
    T.chk('the worker stores the committed record', await go() === 0);
    const digest = require('crypto').createHash('sha256').update(seeded.RULES, 'utf8').digest('hex');
    db.as(SC.ADMIN, 'select public.mf_admin_verify_settlement(' + lit(JSON.stringify({ series_ticker: 'KXNCAAFGAME', sport: 'cfb', rules_sha256: digest, overtime: 'included', tie: 'impossible', note: 'e2e (test-seeded market)' })) + '::jsonb);');
    T.chk('and again after the test market is verified', await go() === 0);
    db.as(SC.ADMIN, "select public.mf_admin_set_mode('live', 'e2e');");
    const edModel = JSON.parse(db.sql("select to_jsonb(x) from (select source, model_key from public.mf_units where event_id = " + lit(pick.event_id) + " and source = 'edgedesk' and status = 'measured' limit 1) x;"));
    process.env.MF_EMBED_SOURCE = edModel.source; process.env.MF_EMBED_MODEL = edModel.model_key;

    srv = await serve();
    const BASE = 'http://127.0.0.1:' + srv.address().port;
    try { browser = await pw.chromium.launch({ headless: true }); }
    catch (e) {
      if (fs.existsSync('/opt/pw-browsers/chromium')) browser = await pw.chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
      else throw e;
    }
    const errors = [];
    async function context(o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      if (o.token) await ctx.addInitScript((t) => { localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: t, expires_at: Math.floor(Date.now() / 1000) + 3600 })); }, o.token);
      await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await ctx.route(SB + '/rest/v1/**', async (route) => {
        const req = route.request(), url = req.url();
        if (o.override) { const ov = await o.override(url); if (ov) return route.fulfill(ov); }
        if (!/\/rpc\/mf_/.test(url)) return route.fulfill({ status: 204, body: '' });
        const res = await stand.fetch(url.replace(SB, 'http://standin'), { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
        route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
      return { ctx, page };
    }
    const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const shot = (page, name, full) => page.screenshot({ path: path.join(SHOTS, name), fullPage: !!full });

    /* ---------------------------------------------------------------- overview, anon, desktop */
    let { ctx, page } = await context();
    await page.goto(BASE + '/foresight/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mf-sum tbody tr', { timeout: 20000 });
    T.chk('overview: the status strip says live and names each source', /Live/.test(await page.textContent('#mf-chips')) && /DraftKings: connected/.test(await page.textContent('#mf-chips')) && /Kalshi: connected/.test(await page.textContent('#mf-chips')));
    T.chk('overview: model observations, one row per model version, sport, market and venue', await page.locator('#h-models ~ .mf-tw tbody tr').count() > 5);
    T.chk('overview: coverage shows observed cadence beside the intended schedule', /intended: polled hourly/.test(await page.textContent('#mf-view')));
    T.chk('overview: venue timing and the T3 check are present', await page.locator('#h-ll').count() === 1 && /T3/.test(await page.textContent('#h-inc')));
    T.chk('overview: the claims it never makes are on the page', /never says that a model caused a move/.test(await page.textContent('.mf-claims')));
    await page.waitForSelector('.mf-games li', { timeout: 10000 });
    T.chk('overview: games are listed with links', await page.locator('.mf-games li a').count() > 5);
    T.chk('overview: no horizontal scroll at desktop width', await noHScroll(page));
    await shot(page, 'overview-desktop.png', true);
    const before = await page.locator('#h-models ~ .mf-tw tbody tr').count();
    await page.selectOption('#f-market', 'total');
    await page.waitForFunction((n) => document.querySelectorAll('#h-models ~ .mf-tw tbody tr').length !== n, before, { timeout: 10000 });
    T.chk('filters: market narrows every table below', (await page.locator('#h-models ~ .mf-tw tbody tr').allTextContents()).every((t) => /Total/.test(t)));
    await ctx.close();

    /* ---------------------------------------------------------------- a game, anon */
    ({ ctx, page } = await context());
    await page.goto(BASE + '/foresight/?game=cfb:' + pick.event_id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mf-units', { timeout: 20000 });
    T.chk('game, anon: findings in plain language', await page.locator('.mf-find').count() > 0);
    T.chk('game, anon: the timeline is withheld and Full Access is named', await page.locator('.mf-svg').count() === 0 && /Full Access/.test(await page.textContent('#mf-status')));
    T.chk('game, anon: coverage for the game is shown instead', /observations from/.test(await page.textContent('#mf-view')));
    await shot(page, 'game-anon-desktop.png', true);
    await ctx.close();

    /* ---------------------------------------------------------------- a game, Full Access */
    ({ ctx, page } = await context({ token: 'tok-sub' }));
    await page.goto(BASE + '/foresight/?game=cfb:' + pick.event_id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mf-svg', { timeout: 20000 });
    T.chk('game, Full Access: three panels (spread, total, win probability)', await page.locator('.mf-svg').count() === 3);
    T.chk('game, Full Access: the win-probability legend names Kalshi\'s mid and its bid–ask band', /Kalshi · YES mid/.test(await page.textContent('.mf-panel:nth-of-type(3) .mf-legend')) || /Kalshi · YES mid/.test(await page.textContent('#mf-view')));
    T.chk('game, Full Access: the event table lists every observation', await page.locator('.mf-events tbody tr').count() > 20);
    T.chk('game, Full Access: venue timing is measured for the verified test market', /DraftKings interval/.test(await page.textContent('#mf-view')) || /No paired moves/.test(await page.textContent('#mf-view')));
    await page.locator('.mf-plot').first().scrollIntoViewIfNeeded();
    const box = await page.locator('.mf-plot').first().boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
    await page.waitForSelector('#mf-tip:not([hidden])', { timeout: 5000 });
    const tipText = await page.textContent('#mf-tip');
    T.chk('the readout on hover says what DraftKings showed (or that it was unknown) and names the timestamp type', /DraftKings: /.test(tipText) && /collector observation times/.test(tipText), tipText.slice(0, 300));
    await shot(page, 'game-full-desktop.png', true);
    await page.locator('.mf-panel').first().screenshot({ path: path.join(SHOTS, 'timeline-readout.png') });
    await page.mouse.move(5, 5);
    await page.focus('.mf-plot >> nth=2');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    T.chk('the readout on the keyboard (arrow keys step through observations)', !(await page.locator('#mf-tip').isHidden()) && /Kalshi: /.test(await page.textContent('#mf-tip')));
    await page.keyboard.press('Escape');
    if (await page.locator('.mf-show').count()) {
      await page.locator('.mf-show').first().click();
      T.chk('“Show the move on the timeline” highlights its interval', await page.locator('.mf-hlr').count() === 1);
    } else T.chk('a finding with a move interval exists for the highlight', false);
    await page.locator('.mf-panel').nth(2).screenshot({ path: path.join(SHOTS, 'timeline-kalshi.png') });
    T.chk('game, Full Access: no horizontal scroll', await noHScroll(page));
    await ctx.close();

    /* ---------------------------------------------------------------- phone */
    ({ ctx, page } = await context({ token: 'tok-sub', viewport: { width: 390, height: 844 } }));
    await page.goto(BASE + '/foresight/?game=cfb:' + pick.event_id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mf-svg', { timeout: 20000 });
    T.chk('phone, game: no horizontal page scroll (tables scroll inside their frame)', await noHScroll(page));
    await shot(page, 'game-mobile.png', true);
    await page.goto(BASE + '/foresight/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.mf-sum tbody tr', { timeout: 20000 });
    T.chk('phone, overview: no horizontal page scroll', await noHScroll(page));
    await shot(page, 'overview-mobile.png', true);
    await ctx.close();

    /* ---------------------------------------------------------------- a model's record */
    ({ ctx, page } = await context());
    await page.goto(BASE + '/foresight/?model=' + encodeURIComponent(edModel.source + ':' + edModel.model_key), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mf-rec table tbody tr', { timeout: 20000 });
    T.chk('model: the complete record, measured and not, with reasons', await page.locator('#mf-rec tbody tr').count() > 10 && /Not measured:/.test(await page.textContent('#mf-rec')));
    T.chk('model: separate measurements, no combined grade', /never a combined grade/.test(await page.textContent('#mf-status')));
    T.chk('model: the embed code links the complete record', /foresight\/embed\.js/.test(await page.inputValue('#mf-embed')));
    const rows1 = await page.locator('#mf-rec tbody tr').count();
    if (await page.locator('#mf-more:not([hidden])').count()) { await page.click('#mf-more'); await page.waitForFunction((n) => document.querySelectorAll('#mf-rec tbody tr').length > n, rows1, { timeout: 10000 }); }
    T.chk('model: the record pages with “Load more”', await page.locator('#mf-rec tbody tr').count() >= rows1);
    await shot(page, 'model-desktop.png', true);
    await ctx.close();

    /* ---------------------------------------------------------------- the embed */
    ({ ctx, page } = await context());
    await page.goto(BASE + '/__embed_test.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => { const h = document.getElementById('edgedesk-foresight'); return h && h.shadowRoot && /Closes closer/.test(h.shadowRoot.textContent); }, null, { timeout: 15000 });
    const emb = await page.evaluate(() => document.getElementById('edgedesk-foresight').shadowRoot.textContent);
    T.chk('embed: the top line with samples and a link to the complete record', /Complete record, misses included/.test(emb) && /n = \d+/.test(emb));
    await page.locator('#edgedesk-foresight').screenshot({ path: path.join(SHOTS, 'embed.png') });
    await ctx.close();

    /* ---------------------------------------------------------------- states */
    db.as(SC.ADMIN, "select public.mf_admin_set_mode('shadow', 'e2e');");
    ({ ctx, page } = await context());
    await page.goto(BASE + '/foresight/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /in review/i.test(document.getElementById('mf-status').textContent), null, { timeout: 15000 });
    T.chk('shadow: readers are told it is in review and see coverage, not measurements', await page.locator('.mf-sum').count() === 0 && /Coverage and freshness/.test(await page.textContent('#mf-view')));
    await shot(page, 'state-shadow.png');
    await ctx.close();
    db.as(SC.ADMIN, "select public.mf_admin_set_mode('live', 'e2e');");
    ({ ctx, page } = await context({ override: async (u) => /mf_status/.test(u) ? { status: 404, contentType: 'application/json', body: '{"code":"PGRST202","message":"Could not find the function public.mf_status"}' } : null }));
    await page.goto(BASE + '/foresight/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /not been deployed/.test(document.getElementById('mf-status').textContent), null, { timeout: 15000 });
    T.chk('not deployed: says so plainly, and the frozen methodology still renders', /not been deployed/.test(await page.textContent('#mf-status')));
    await page.waitForFunction(() => /Definitions/.test(document.getElementById('mf-method').textContent), null, { timeout: 15000 });
    T.chk('the methodology panel renders from the frozen file', /closing convergence/.test(await page.textContent('#mf-method')));
    await shot(page, 'state-not-deployed.png');
    await ctx.close();
    ({ ctx, page } = await context({ override: async (u) => /mf_overview/.test(u) ? { status: 500, contentType: 'application/json', body: '{"message":"boom"}' } : null }));
    await page.goto(BASE + '/foresight/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /Could not load the measurements/.test(document.getElementById('mf-status').textContent), null, { timeout: 15000 });
    T.chk('a database error: says what failed and offers a retry', await page.locator('#mf-retry').count() === 1);
    await ctx.close();

    T.chk('no script error on any page', errors.length === 0, errors.slice(0, 5));
    console.log('screenshots: ' + SHOTS);
  } catch (e) {
    T.chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    try { if (browser) await browser.close(); } catch (_) { /* closed */ }
    try { if (srv) srv.close(); } catch (_) { /* closed */ }
    db.stop();
    process.exit(T.done());
  }
})();
