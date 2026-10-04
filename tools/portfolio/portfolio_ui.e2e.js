#!/usr/bin/env node
/* ===========================================================================
   THE PORTFOLIO PAGE IN CHROMIUM, AGAINST THE REAL MIGRATION.

   app.html is served from this repository; every PostgREST call it makes is
   answered by tools/portfolio/_pgrest.js running SQL on a throwaway
   PostgreSQL that has supabase/portfolio.sql applied — as the signed-in
   reader, under row level security. So what this proves is the whole path:
   form → request → trigger → stored figure → page.

   A reader, starting from nothing:
     opens #portfolio and sees an empty book that says how to build one (no sample data);
     records a sportsbook bet that won and sees +$90.91;
     records a prediction-market position that resolved YES and sees the
     total, the sportsbook / prediction split and both platforms;
     records an open bet and sees it, with its risk and potential profit;
     records the same winning bet again and is told it is a duplicate;
     edits a bet to lost and the total follows; deletes one;
     imports a CSV — detected / new / duplicate / review / invalid — and
     confirms;
     opens the Calendar, finds a month and a day whose P&L is what the
     database settled in the reader's zone, and follows the day to History;
     sees accounts labelled "Manual tracking" / "CSV import", never
     "Connected";
     never sees another reader's position;
   at 1280 px and at a 390 px phone, with no sideways scroll, no page error,
   and nothing financial written to localStorage.

   Run: node tools/portfolio/portfolio_ui.e2e.js [--shots DIR]
   (PORTFOLIO_UI_REQUIRED=1 makes a missing Playwright or PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');

const ROOT = PG.ROOT;
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const SHOTS = (function () { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; }());
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | portfolio UI e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why); process.exit(0); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.png': 'image/png' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

const CSV = [
  'Date Placed,Sportsbook,Sport,Event,Market,Selection,Odds,Stake,Result,Bet ID',
  '2026-09-07 13:00,BetMGM,NFL,Jets @ Giants,Moneyline,Jets,+150,40,Won,MGM-1',
  '2026-09-08 13:00,BetMGM,NFL,Jets @ Giants,Moneyline,Jets,+150,40,Won,MGM-1',
  '2026-09-09 19:00,BetMGM,NBA,Lakers vs Celtics,Total,Over 220.5,-110,22,Lost,MGM-3',
  '2026-09-10 12:00,BetMGM,MLB,Yankees @ Red Sox,Moneyline,Yankees,-130,"12,50",Won,MGM-4'
].join('\n');

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) skip('playwright is not installed here');
  const db = PG.start('pfui');
  if (db.skip) skip(db.skip);
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio.sql'));
  db.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
  /* reader B's book, which reader A must never see */
  db.as(B, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake, status, placed_at)
            values ('fanduel', 'FanDuel', 'SPORTSBOOK', 'MONEYLINE', 'SECRET-B Rams @ Seahawks', 'Moneyline', 'Rams', 120, 77, 'WON', '2026-09-01T12:00:00Z');`);
  const rest = REST.make(db, { tokens: { e2e: A } });
  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { db.stop(); site.srv.close(); skip('no Chromium'); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((uid) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: uid, email: 'reader@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, A);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
      if (m && /^(rpc\/portfolio_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const token = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', token);
        return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body == null ? '' : JSON.stringify(out.body) });
      }
      if (/supabase\.co/.test(url)) {
        /* a returning reader: the personal-research onboarding is already done */
        if (/\/user_preferences/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ user_id: A, onboarding_status: 'completed', leagues: ['nfl'], books: [], interests: [] }]) });
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${site.port}/app.html#portfolio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page) => page.evaluate(() => document.getElementById('pfoHost').innerText);
  /* innerText is the RENDERED text: CSS-uppercased headings read uppercased, so keep the regex's own flags */
  const waitText = (page, re, ms) => page.waitForFunction((a) => new RegExp(a[0], a[1]).test(document.getElementById('pfoHost').innerText), [re.source, re.flags], { timeout: ms || 15000 });
  const tab = async (page, v) => { await page.click(`#pfoHost .pfo-tab[data-v="${v}"]`); await page.waitForTimeout(150); };
  async function noSideways(page, label) {
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    chk(label + ': nothing scrolls sideways', w.sw <= w.w + 1, w);
  }
  async function fill(page, values) {
    for (const [name, v] of Object.entries(values)) {
      const sel = `.pfo-sheet [name="${name}"]`;
      const tag = await page.$eval(sel, (el) => el.tagName);
      if (tag === 'SELECT') { await page.selectOption(sel, v); await page.waitForTimeout(60); }
      else await page.fill(sel, v);
    }
  }
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };

  try {
    /* ═══ DESKTOP: the whole journey ════════════════════════════════════ */
    let { ctx, page, errors } = await open({ width: 1280, height: 900 });
    await waitText(page, /Build your portfolio/);
    chk('a new reader sees an empty book, and no sample data', /Build your portfolio/.test(await text(page)) && !/\$/.test(await page.$eval('#pfoHost [data-r="body"]', (e) => e.innerText)));
    /* a seat of its own since the five-destination navigation (docs/ia/NAVIGATION_AUDIT.md) */
    chk('Portfolio is a primary destination', await page.evaluate(() => !!document.querySelector('.bottomnav button[data-v="portfolio"]')));
    chk('and its own seat reads active while it is open', await page.evaluate(() => { const b = document.querySelector('.bottomnav button[data-v="portfolio"]'); return !!b && b.classList.contains('on'); }));
    await shot(page, 'desktop-empty');

    /* a winning sportsbook bet */
    await page.click('#pfoHost [data-act="new-wager"]');
    await page.waitForSelector('.pfo-sheet:not([hidden]) form[data-form="wager"]');
    await fill(page, { platform: 'draftkings', sport: 'NFL', event_name: 'Chiefs @ Bills', position_type: 'SPREAD', selection: 'Chiefs -2.5', odds: '-110', stake: '100', placed_at: '2026-09-07T13:00' });
    await fill(page, { status: 'WON' });
    await page.fill('.pfo-sheet [name="stake"]', '100');
    const preview = await page.$eval('.pfo-sheet .pfo-preview', (e) => e.innerText);
    chk('the form previews the payout and profit before saving ($100 at -110 wins $90.91)', /to win \$90\.91/.test(preview) && /payout \$190\.91/.test(preview) && /\+\$90\.91/.test(preview), preview);
    await shot(page, 'desktop-form');
    await page.click('.pfo-sheet [data-act="save"]');
    /* wait for the OVERVIEW to carry the figure, not the whole host: the form
       sheet's own preview already reads +$90.91, so waiting on #pfoHost could
       finish before the save landed and read the empty book */
    await page.waitForFunction(() => { const b = document.querySelector('#pfoHost [data-r="body"]'); return !!b && /Total P&L/i.test(b.innerText) && /\+\$90\.91/.test(b.innerText); }, null, { timeout: 15000 });
    let t = await text(page);
    chk('the overview answers first: +$90.91', /Total P&L/i.test(t) && /\+\$90\.91/.test(t), t.slice(0, 300));

    /* a prediction-market position that resolved YES */
    await page.click('#pfoHost [data-act="add"]');
    await page.click('.pfo-sheet [data-act="new-prediction"]');
    await page.waitForSelector('.pfo-sheet form[data-form="prediction"]');
    await fill(page, { platform: 'kalshi', event_name: 'Will the Chiefs win the AFC West?', side: 'YES', contracts: '100', price: '0.61', fees: '0.50', placed_at: '2026-09-02T10:00' });
    await fill(page, { state: 'RESOLVED' });
    await fill(page, { resolution: 'YES', settled_at: '2026-09-20T10:00' });
    const pv = await page.$eval('.pfo-sheet .pfo-preview', (e) => e.innerText);
    chk('the contract preview: cost $61.00, settled P&L +$38.50 after fees', /Cost basis \$61\.00/.test(pv) && /\+\$38\.50/.test(pv), pv);
    await page.click('.pfo-sheet [data-act="save"]');
    await waitText(page, /\+\$129\.41/);
    t = await text(page);
    chk('the total combines both: +$129.41', /\+\$129\.41/.test(t));
    chk('sportsbook and prediction-market P&L are shown apart', /Sportsbook P&L\s*\+\$90\.91/i.test(t) && /Prediction-market P&L\s*\+\$38\.50/i.test(t), t.slice(0, 800));
    chk('P&L by platform lists DraftKings and Kalshi', /DraftKings[\s\S]*\+\$90\.91/.test(t) && /Kalshi[\s\S]*\+\$38\.50/.test(t));

    /* an open bet */
    await page.click('#pfoHost [data-act="add"]');
    await page.click('.pfo-sheet [data-act="new-wager"]');
    await fill(page, { platform: 'fanduel', sport: 'NBA', event_name: 'Lakers @ Celtics', position_type: 'MONEYLINE', selection: 'Lakers', odds: '+150', stake: '50', placed_at: '2026-10-03T19:00' });
    await page.click('.pfo-sheet [data-act="save"]');
    await waitText(page, /1 open/);
    await tab(page, 'open');
    t = await text(page);
    chk('Open shows the bet with its risk and potential profit', /Lakers/.test(t) && /\$50\.00 @ \+150/.test(t) && /Potential profit\s*\$75\.00/.test(t), t.slice(0, 600));
    chk('the settled bets are not in Open', !/Chiefs -2\.5/.test(t));
    await page.click('#pfoHost [data-act="open-kind"][data-v="PREDICTION_MARKET"]');
    chk('filtering to prediction markets hides the sportsbook bet', !/Lakers/.test(await text(page)));
    await shot(page, 'desktop-open');

    /* the same bet twice */
    await page.click('#pfoHost [data-act="add"]');
    await page.click('.pfo-sheet [data-act="new-wager"]');
    await fill(page, { platform: 'draftkings', sport: 'NFL', event_name: 'Chiefs vs. Bills', position_type: 'SPREAD', selection: 'Chiefs -2.5', odds: '-110', stake: '100', placed_at: '2026-09-07T13:00' });
    await fill(page, { status: 'WON' });
    await page.click('.pfo-sheet [data-act="save"]');
    await page.waitForSelector('.pfo-sheet .pfo-err', { timeout: 10000 });
    const dupMsg = await page.$eval('.pfo-sheet .pfo-err', (e) => e.innerText);
    chk('recording the same bet again is caught as a duplicate (event written differently)', /already recorded/.test(dupMsg) && /separate bet/.test(dupMsg), dupMsg);
    await page.click('.pfo-sheet [data-act="close"]');
    chk('and nothing was added', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === 3);

    /* edit to lost, then delete */
    await tab(page, 'history');
    t = await text(page);
    chk('History lists the settled positions with their P&L', /Chiefs -2\.5/.test(t) && /\+\$90\.91/.test(t) && /YES/.test(t));
    await page.click('#pfoHost .pfo-hist-table tr[data-act="edit"]:has-text("Chiefs -2.5")');
    await page.waitForSelector('.pfo-sheet form[data-form="wager"]');
    await fill(page, { status: 'LOST' });
    await page.click('.pfo-sheet [data-act="save"]');
    await waitText(page, /−\$100\.00/);
    await tab(page, 'overview');
    t = await text(page);
    chk('editing the bet to lost moves the total to −$61.50', /−\$61\.50/.test(t), t.slice(0, 300));
    await tab(page, 'open');
    await page.click('#pfoHost [data-act="open-kind"][data-v="ALL"]');   /* the filter chosen earlier persists */
    await page.click('#pfoHost [data-act="edit"]');
    await page.waitForSelector('.pfo-sheet [data-act="delete"]');
    await page.click('.pfo-sheet [data-act="delete"]');
    await waitText(page, /No open positions/);
    chk('deleting a position removes it', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === 2);

    /* a CSV import */
    await tab(page, 'import');
    await page.setInputFiles('#pfoHost input[type="file"]', { name: 'betmgm.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await waitText(page, /Check the columns/i);
    t = await text(page);
    chk('the importer reads the file in the browser and maps the columns', /Rows read\s*4/i.test(t.replace(/\n/g, ' ')) || /4\s*Rows read/i.test(t), t.slice(0, 500));
    await page.click('#pfoHost [data-act="imp-check"]');
    await waitText(page, /Detected/i);
    t = (await text(page)).replace(/\s+/g, ' ');
    chk('the server classifies: 4 detected, 2 new, 1 duplicate, 1 invalid', /4 Detected/i.test(t) && /2 New/i.test(t) && /1 Duplicates/i.test(t) && /1 Invalid/i.test(t), t.slice(t.search(/detected/i) - 40, t.search(/detected/i) + 400));
    chk('nothing is inserted before the reader confirms', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === 2);
    await shot(page, 'desktop-import');
    await page.click('#pfoHost [data-act="imp-commit"]');
    await waitText(page, /Imported 2/);
    chk('confirming imports exactly the new rows', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}' and source = 'CSV';`) === 2);
    chk('imported history keeps its own dates: settled at the placed time, not today',
      db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}' and source = 'CSV' and settled_at = placed_at and settled_at < '2026-09-30';`) === '2');

    /* the calendar: a month and a day, each the database's own sum in the
       reader's zone, and the day's way into History */
    await tab(page, 'calendar');
    chk('the Calendar tab is linkable: #portfolio/calendar', await page.evaluate(() => location.hash) === '#portfolio/calendar');
    const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (let i = 0; i < 36; i++) {
      const m = await page.$eval('#pfoHost .pfo-cal-m', (e) => e.textContent);
      if (m === 'September 2026') break;
      const later = Date.parse(m + ' 1') > Date.parse('2026-09-01T12:00:00Z');
      await page.click(`#pfoHost [data-act="cal-month"][data-dir="${later ? 'prev' : 'next'}"]`);
    }
    const settledSum = (from, to) => db.sql(`select coalesce(sum(profit_loss), 0)::text from public.portfolio_positions where user_id = '${A}' and status <> 'OPEN'
      and (settled_at at time zone '${tz}') >= '${from}' and (settled_at at time zone '${tz}') < '${to}';`);
    const sepPnl = settledSum('2026-09-01', '2026-10-01'), dayPnl = settledSum('2026-09-07', '2026-09-08');
    t = await text(page);
    chk('September\'s total is what the database settled in September, in the reader\'s zone', new RegExp('Settled in September\\s*' + E.money(sepPnl, { sign: true }).replace(/[$+.]/g, '\\$&'), 'i').test(t), [sepPnl, t.slice(0, 300)]);
    chk('focus stays on the month arrow after a repaint', await page.evaluate(() => !!document.activeElement && document.activeElement.getAttribute('data-act') === 'cal-month'));
    await page.click('#pfoHost .pfo-cal [data-act="cal-day"][data-v="2026-09-07"]');
    await page.waitForSelector('#pfoHost [data-r="cal-day"]');
    const day = await page.$eval('#pfoHost [data-r="cal-day"]', (e) => e.innerText);
    chk('a day opens with its settled P&L, from the database', day.indexOf(E.money(dayPnl, { sign: true })) >= 0 && /Jets/.test(day), [dayPnl, day.slice(0, 400)]);
    chk('the day is marked as chosen', await page.$eval('#pfoHost .pfo-cal [data-v="2026-09-07"]', (e) => e.getAttribute('aria-pressed') === 'true'));
    await shot(page, 'desktop-calendar');
    await page.click('#pfoHost [data-act="cal-history"]');
    await page.waitForSelector('#pfoHost .pfo-tab[data-v="history"][aria-selected="true"]');
    chk('"See in History" opens History, and the link follows', await page.evaluate(() => location.hash) === '#portfolio/history');
    const dayRows = +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}' and status <> 'OPEN' and (settled_at at time zone '${tz}')::date = '2026-09-07';`);
    t = (await text(page)).replace(/\s+/g, ' ');
    chk('History holds exactly that day\'s settled positions', new RegExp('\\b' + dayRows + ' positions? · settled P&L ' + E.money(dayPnl, { sign: true }).replace(/[$+.]/g, '\\$&')).test(t)
      && await page.$eval('#pfoHost [name="from"]', (e) => e.value) === '2026-09-07' && await page.$eval('#pfoHost [name="to"]', (e) => e.value) === '2026-09-07', t.slice(0, 400));

    /* accounts, analytics, isolation */
    await tab(page, 'accounts');
    t = await text(page);
    chk('Accounts lists each platform with how it is tracked', /DraftKings/.test(t) && /Kalshi/.test(t) && /BetMGM/.test(t) && /Manual tracking/.test(t) && /CSV import/.test(t), t.slice(0, 600));
    chk('and never says "Connected"', !/\bConnected\b/.test(t));
    await shot(page, 'desktop-accounts');
    await tab(page, 'analytics');
    t = await text(page);
    chk('Analytics compares sportsbook, prediction market and combined', /Sportsbook/i.test(t) && /Prediction/i.test(t) && /Combined/i.test(t) && /Win rate/i.test(t), t.slice(0, 400));
    await page.click('#pfoHost [data-act="period"][data-v="7D"]');
    chk('and filters by period', await page.$eval('#pfoHost [data-act="period"][data-v="7D"]', (e) => e.getAttribute('aria-pressed') === 'true'));
    await shot(page, 'desktop-analytics');
    for (const v of ['overview', 'open', 'calendar', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      if (/SECRET-B/.test(await text(page))) { chk('reader B\'s position never appears (' + v + ')', false); }
    }
    chk('reader B\'s position never appears on any tab', !/SECRET-B/.test(await text(page)));
    const ls = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    chk('nothing financial is written to localStorage', !/Chiefs|Kalshi|90\.91|portfolio_positions/.test(ls));
    chk('no page errors on desktop', errors.length === 0, errors);
    await ctx.close();

    /* ═══ PHONE: 390 px ════════════════════════════════════════════════ */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await waitText(page, /Total P&L/i);
    for (const v of ['overview', 'open', 'calendar', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      await noSideways(page, '390px ' + v);
      await shot(page, 'phone-' + v);
    }
    await tab(page, 'calendar');
    for (let i = 0; i < 36 && (await page.$eval('#pfoHost .pfo-cal-m', (e) => e.textContent)) !== 'September 2026'; i++) {
      const later = Date.parse((await page.$eval('#pfoHost .pfo-cal-m', (e) => e.textContent)) + ' 1') > Date.parse('2026-09-01T12:00:00Z');
      await page.click(`#pfoHost [data-act="cal-month"][data-dir="${later ? 'prev' : 'next'}"]`);
    }
    const fit = await page.evaluate(() => {
      const g = document.querySelector('#pfoHost .pfo-cal'), cells = [].slice.call(g.querySelectorAll('.pfo-cal-d'));
      const clipped = [].slice.call(g.querySelectorAll('.pfo-cal-d .a, .pfo-cal-d .o')).filter((a) => a.scrollWidth > a.parentNode.clientWidth + 0.5).map((a) => a.textContent);
      const r = cells.map((c) => c.getBoundingClientRect());
      return { cols: new Set(r.map((b) => Math.round(b.left))).size, minW: Math.min.apply(null, r.map((b) => b.width)), minH: Math.min.apply(null, r.map((b) => b.height)),
        inside: g.scrollWidth <= g.clientWidth + 1, clipped, amounts: g.querySelectorAll('.pfo-cal-d .a').length };
    });
    chk('390px: the month is seven columns, every day on screen', fit.cols === 7 && fit.inside && fit.amounts > 0, fit);
    chk('390px: no day\'s amount is clipped', fit.clipped.length === 0, fit.clipped);
    chk('390px: a day is big enough to tap (≥ 40 × 50)', fit.minW >= 40 && fit.minH >= 50, fit);
    await page.click('#pfoHost .pfo-cal [data-act="cal-day"][data-v="2026-09-07"]');
    await page.waitForSelector('#pfoHost [data-r="cal-day"]');
    await noSideways(page, '390px calendar day');
    await shot(page, 'phone-calendar-day');
    await tab(page, 'history');
    chk('390px: history is cards, not a wide table', await page.evaluate(() => {
      const c = document.querySelector('#pfoHost .pfo-hist-cards'), tb = document.querySelector('#pfoHost .pfo-hist-table');
      return !!c && getComputedStyle(c).display !== 'none' && (!tb || getComputedStyle(tb).display === 'none');
    }));
    await tab(page, 'overview');
    await page.click('#pfoHost [data-act="add"]');
    await page.click('.pfo-sheet [data-act="new-prediction"]');
    await page.waitForSelector('.pfo-sheet form[data-form="prediction"]');
    const panel = await page.$eval('.pfo-sheet .pfo-panel', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, right: r.right }; });
    chk('390px: the form sheet fits the screen', panel.right <= 391, panel);
    await noSideways(page, '390px form');
    await shot(page, 'phone-form');
    chk('no page errors on the phone', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      const pg = pages[pages.length - 1];
      if (pg) {
        if (SHOTS) await pg.screenshot({ path: path.join(SHOTS, 'failure.png'), fullPage: false });
        console.log('  at failure, topmost elements:', await pg.evaluate(() => {
          const r = document.querySelector('#pfoHost tr[data-act="edit"]') || document.querySelector('#pfoHost .pfo-tab');
          if (!r) return 'none';
          const b = r.getBoundingClientRect(), el = document.elementFromPoint(b.left + 20, b.top + b.height / 2);
          return JSON.stringify({ box: [b.left, b.top, b.width, b.height], top: el && (el.id || el.className || el.tagName), vh: innerHeight });
        }));
      }
    } catch (_) { /* best effort */ }
    chk('unexpected failure', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close();
    site.srv.close();
    db.stop();
  }
  done(SHOTS ? 'screenshots in ' + SHOTS : '');
}());
