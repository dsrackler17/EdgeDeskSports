#!/usr/bin/env node
/* ===========================================================================
   RESEARCH › PROPS, IN A REAL BROWSER — desktop and mobile.

   app.html in Chromium, its own loader fetching lib/player_props_ui.js, the
   kernel and the published artifacts:

     1. the REAL published NFL and CFB boards (model only today: no sportsbook
        prop quote has been captured) — the no-market banner, the table on
        desktop, the cards on mobile, a research card with its distribution,
        the what-if calculator, and no price anywhere
     2. the NFL board priced with the TEST FIXTURE quotes of
        football/props/fixture_quotes.js (labelled at every level, served from
        memory, never written to the published folder) — priced rows, sort by
        best value, the model-vs-market split, line shopping, movement and the
        alternate ladder with its best-value row

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node football/props/ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(__dirname, 'published');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function finish(code) {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | props page (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(code != null ? code : (fail ? 1 : 0));
}
if (!fs.existsSync(path.join(PUB, 'board_nfl.json'))) { console.log('SKIPPED: nothing published (run football/props/run.js score)'); process.exit(0); }

const FX = require('./fixture_quotes.js');
let FIXTURE = null;           /* set while the priced scenario runs */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const served = [];
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  if (/^\/football\/props\/published\//.test(p)) served.push(p.replace('/football/props/published/', ''));
  if (FIXTURE) {
    if (p === '/football/props/published/board_nfl.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FIXTURE.board)); return; }
    const m = p.match(/^\/football\/props\/published\/nfl\/(.+)\.market\.json$/);
    if (m && FIXTURE.markets[m[1]]) { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FIXTURE.markets[m[1]])); return; }
  }
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
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, league) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) {}
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${port}/app.html#research/props`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.researchGo === 'function', null, { timeout: 30000 });
    await page.click('text=Skip for now', { timeout: 1500 }).catch(() => {});
    await page.evaluate(() => { try { window.researchGo('props'); } catch (e) {} });
    await page.waitForFunction(() => !!document.querySelector('#prSports .stchip'), null, { timeout: 30000 });
    await page.evaluate((lg) => { const b = Array.from(document.querySelectorAll('#prSports .stchip')).find((x) => x.getAttribute('data-s') === lg); if (b) b.click(); }, league);
    await page.waitForFunction(() => { const b = document.getElementById('prBody'); return b && (b.querySelector('.pp-table, .pp-cards') || /not published/.test(b.textContent)); }, null, { timeout: 60000 });
    await page.click('text=Skip for now', { timeout: 1000 }).catch(() => {});
    return { ctx, page, errors };
  }
  async function visible(page, sel) { return page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return cs.display !== 'none' && r.width > 0 && r.height > 0; }, sel); }
  async function overflowX(page) { return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); }
  async function openFirst(page, sel) {
    await page.evaluate((s) => { const el = Array.from(document.querySelectorAll(s)).find((x) => x.getBoundingClientRect().height > 0); if (el) el.click(); }, sel);
    await page.waitForFunction(() => { const d = document.getElementById('ppDrawer'); return d && d.style.display === 'flex' && d.querySelector('.pp-dh, .empty:not(:empty)') && !/Loading the research card/.test(d.textContent); }, null, { timeout: 20000 });
    return page.evaluate(() => { const d = document.getElementById('ppDrawer'); const r = d.querySelector('.pp-dcard').getBoundingClientRect(); return { text: d.textContent.replace(/\s+/g, ' '), html: d.innerHTML, w: r.width, vw: window.innerWidth }; });
  }
  const shot = async (page, name, full) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: !!full }); };

  try {
    /* ============================== 1. the real published boards, model only */
    for (const league of ['NFL', 'CFB']) {
      if (!fs.existsSync(path.join(PUB, 'board_' + league.toLowerCase() + '.json'))) continue;
      const raw = JSON.parse(fs.readFileSync(path.join(PUB, 'board_' + league.toLowerCase() + '.json'), 'utf8'));
      console.log('\n== ' + league + ' props, real board, desktop 1280 ==');
      const D = await open({ width: 1280, height: 1600 }, league);
      const st = await D.page.evaluate(() => { const b = document.getElementById('prBody'); return { text: b.textContent.replace(/\s+/g, ' '), rows: b.querySelectorAll('.pp-table .pp-tr').length, cards: b.querySelectorAll('.pp-card').length,
        priced: Array.from(b.querySelectorAll('.pp-tr')).filter((r) => !/MODEL/.test(r.lastElementChild.textContent)).length, ctl: document.querySelectorAll('#prControls select, #prControls input').length }; });
      chk(league + ': the board renders its table on desktop', st.rows > 0 && await visible(D.page, '.pp-table') && !(await visible(D.page, '.pp-cards')), st);
      chk(league + ': the count names every published prop', new RegExp(raw.n_props + ' props').test(st.text), st.text.slice(0, 200));
      chk(league + ': filters and sorts are offered (search, date, team, matchup, position, market, book, edge, confidence, data, sort, priced-only)', st.ctl >= 12, st.ctl);
      if (!raw.quotes.captured) {
        chk(league + ': with no captured quote the no-market banner is shown and no row is priced', /No observed sportsbook prop line is on file/.test(st.text) && st.priced === 0, st.text.slice(0, 300));
      }
      await D.page.selectOption('#ppPos', 'WR');
      const wr = await D.page.evaluate(() => Array.from(document.querySelectorAll('.pp-table .pp-tr .pp-pl .pp-pt')).map((x) => x.textContent.split(' · ')[0]));
      chk(league + ': the position filter narrows the table', wr.length > 0 && wr.every((p) => p === 'WR'), wr.slice(0, 5));
      await D.page.selectOption('#ppPos', '');
      await shot(D.page, league.toLowerCase() + '_board_desktop');
      /* a yardage prop from the table (a distribution to draw), clicked like a reader would */
      await D.page.evaluate(() => { const r = Array.from(document.querySelectorAll('.pp-table .pp-tr')).find((x) => /yds$/.test(x.children[2].textContent)); if (r) r.setAttribute('data-e2e', '1'); });
      const card = await openFirst(D.page, '.pp-table .pp-tr[data-e2e="1"]');
      chk(league + ': a research card opens from the table', /Projection/.test(card.text) && /Why EdgeDesk differs/.test(card.text), card.text.slice(0, 200));
      chk(league + ': the model-only card says there is no market and prints no price', /MODEL ONLY/.test(card.text) && /Nothing on this card is a price/.test(card.text) && !/Alternate lines/.test(card.text), card.text.slice(0, 400));
      chk(league + ': the distribution chart and the model sections render', /<svg class="pp-chart"/.test(card.html) && ['Form', 'Usage', 'Matchup', 'Environment', 'Availability', 'Confidence and data quality'].every((s) => card.text.indexOf(s) >= 0));
      await D.page.fill('#ppWiL', '4.5'); await D.page.fill('#ppWiP', '+120');
      const wi = await D.page.evaluate(() => document.getElementById('ppWiOut').textContent);
      chk(league + ': the what-if calculator prices any line and price from the same distribution', /P \d+\.\d%/.test(wi) && /EV [+-]?\d/.test(wi) && /fair [+-]\d+/.test(wi), wi);
      await shot(D.page, league.toLowerCase() + '_card_desktop');
      await D.page.keyboard.press('Escape');
      chk(league + ': Escape closes the card', await D.page.evaluate(() => document.getElementById('ppDrawer').style.display === 'none'));
      /* a yes/no market: one probability, no median, no line box */
      const td = await D.page.evaluate(() => { const b = window.EDPropsUI.state.boards[window.EDPropsUI.state.league]; const r = b.rows.find((x) => x.market === 'anytime_td'); return r ? r.id : null; });
      if (td) {
        await D.page.evaluate((id) => window.EDPropsUI.openProp(id), td);
        await D.page.waitForFunction(() => { const d = document.getElementById('ppDrawer'); return d && /Projection/.test(d.textContent); }, null, { timeout: 20000 });
        const tc = await D.page.evaluate(() => ({ text: document.getElementById('ppDrawer').textContent.replace(/\s+/g, ' '), line: !!document.getElementById('ppWiL') }));
        chk(league + ': an anytime-TD card shows P(yes) and fair yes/no, not a median or a line box', /P\(yes\)/.test(tc.text) && /Fair yes/.test(tc.text) && !/Median/.test(tc.text) && !tc.line && /chance to score a touchdown/.test(tc.text), tc.text.slice(0, 300));
        await D.page.keyboard.press('Escape');
      }
      const fits = await D.page.evaluate(() => { const w = document.querySelector('.pp-tablewrap'); return w ? w.scrollWidth - w.clientWidth : null; });
      chk(league + ': the table fits a 1280px desktop without a horizontal scroll', fits != null && fits <= 2, fits);
      chk(league + ': no page error on desktop', D.errors.length === 0, D.errors);
      await D.ctx.close();

      console.log('\n== ' + league + ' props, real board, mobile 390 ==');
      const Mb = await open({ width: 390, height: 844 }, league);
      chk(league + ': on mobile the table gives way to cards', await visible(Mb.page, '.pp-cards') && !(await visible(Mb.page, '.pp-tablewrap')));
      chk(league + ': no horizontal page overflow on mobile', (await overflowX(Mb.page)) <= 1, await overflowX(Mb.page));
      await shot(Mb.page, league.toLowerCase() + '_board_mobile');
      const mc = await openFirst(Mb.page, '.pp-card');
      chk(league + ': the research card opens full-width on mobile', /Projection/.test(mc.text) && mc.w >= mc.vw - 2, { w: mc.w, vw: mc.vw });
      chk(league + ': no horizontal overflow with the card open', (await overflowX(Mb.page)) <= 1, await overflowX(Mb.page));
      await shot(Mb.page, league.toLowerCase() + '_card_mobile');
      chk(league + ': no page error on mobile', Mb.errors.length === 0, Mb.errors);
      await Mb.ctx.close();
    }

    /* ============================== 2. priced with TEST FIXTURE quotes */
    FIXTURE = FX.build('nfl');
    console.log('\n== NFL props priced with TEST FIXTURE quotes (' + FIXTURE.n_quotes + ' invented quotes, game ' + FIXTURE.game_id + '), desktop ==');
    served.length = 0;
    const P = await open({ width: 1280, height: 1600 }, 'NFL');
    const ps = await P.page.evaluate(() => { const b = document.getElementById('prBody'); return { text: b.textContent.replace(/\s+/g, ' '),
      rows: Array.from(b.querySelectorAll('.pp-table .pp-tr')).slice(0, 12).map((r) => Array.from(r.children).map((c) => c.textContent.replace(/\s+/g, ' ').trim())) }; });
    chk('fixture: the capture line replaces the no-market banner', /observed quotes · last capture/.test(ps.text) && !/No observed sportsbook prop line is on file/.test(ps.text), ps.text.slice(0, 300));
    chk('fixture: sorted by best value, priced rows lead with a fixture book, a price, model and market', ps.rows.length > 0 && ps.rows.slice(0, 5).every((r) => /^[+-]\d+FIXTURE-[ABC]$/.test(r[4])), ps.rows.slice(0, 3));
    const evs = ps.rows.map((r) => r[9]).filter((x) => /%/.test(x)).map((x) => parseFloat(x));
    chk('fixture: every priced row shows an EV and a decision badge that is never BET (market tier RESEARCH)', evs.length === ps.rows.length && ps.rows.every((r) => /^(LEAN|WATCH|PASS)$/.test(r[12])), ps.rows.map((r) => [r[9], r[12]]));
    await P.page.check('#ppPriced');
    const pricedN = await P.page.evaluate(() => document.querySelectorAll('.pp-table .pp-tr').length);
    chk('fixture: priced-only keeps just the priced rows', pricedN > 0 && pricedN < 400, pricedN);
    await shot(P.page, 'fixture_board_desktop');
    /* open a laddered prop: a yardage market in the fixture game */
    const target = await P.page.evaluate(() => { const b = window.EDPropsUI.state.boards.NFL; const r = b.rows.find((x) => x.focus && /yards$/.test(x.market) && x.mkt && x.mkt.books >= 3); return r ? r.id : null; });
    chk('fixture: a priced yardage prop is on the board', !!target, target);
    await P.page.evaluate((id) => window.EDPropsUI.openProp(id), target);
    await P.page.waitForFunction(() => { const d = document.getElementById('ppDrawer'); return d && /Model vs market/.test(d.textContent); }, null, { timeout: 20000 });
    const pc = await P.page.evaluate(() => { const d = document.getElementById('ppDrawer'); return { text: d.textContent.replace(/\s+/g, ' '), bv: d.querySelectorAll('tr.pp-bv').length, lad: d.querySelectorAll('.pp-lad').length, books: d.querySelectorAll('.pp-lt tr').length }; });
    chk('fixture: the card separates model, market and edge', ['Model P', 'Market P (no-vig)', 'Edge', 'Fair price', 'Conservative EV'].every((s) => pc.text.indexOf(s) >= 0), pc.text.slice(0, 400));
    chk('fixture: line shopping — consensus, books, best price and best number', ['Consensus line', 'Books', 'Best over', 'Best under', 'Best over number'].every((s) => pc.text.indexOf(s) >= 0) && /FIXTUR/.test(pc.text));
    chk('fixture: movement from the opener', /Opener/.test(pc.text) && /Move/.test(pc.text));
    chk('fixture: the alternate ladder renders with the best-value rule stated', pc.lad >= 1 && /Alternate lines/.test(pc.text) && /Best value = highest expected log-growth/.test(pc.text), { lad: pc.lad });
    chk('fixture: the market file was fetched only for the priced game', served.some((s) => s === 'nfl/' + FIXTURE.game_id + '.market.json') && served.filter((s) => /market\.json$/.test(s)).length === 1, served.filter((s) => /market/.test(s)));
    await shot(P.page, 'fixture_card_desktop', true);
    chk('fixture: no page error', P.errors.length === 0, P.errors);
    await P.ctx.close();

    console.log('\n== NFL props priced with TEST FIXTURE quotes, mobile ==');
    const PM = await open({ width: 390, height: 844 }, 'NFL');
    await PM.page.evaluate((id) => window.EDPropsUI.openProp(id), target);
    await PM.page.waitForFunction(() => { const d = document.getElementById('ppDrawer'); return d && /Model vs market/.test(d.textContent); }, null, { timeout: 20000 });
    chk('fixture (mobile): the ladder card fits the screen', (await overflowX(PM.page)) <= 1, await overflowX(PM.page));
    const ladW = await PM.page.evaluate(() => { const t = document.querySelector('#ppDrawer .pp-lt'); return t ? t.getBoundingClientRect().right <= window.innerWidth + 1 : null; });
    chk('fixture (mobile): ladder tables stay inside the viewport', ladW === true, ladW);
    await shot(PM.page, 'fixture_card_mobile', true);
    chk('fixture (mobile): no page error', PM.errors.length === 0, PM.errors);
    await PM.ctx.close();
  } catch (e) {
    fail++; console.log('  FAIL harness: ' + (e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  finish();
})();
