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
     sees accounts labelled "Manual tracking" / "CSV import", never
     "Connected";
     never sees another reader's position;
     sees the Decision Grade after P&L and ROI — "Not graded yet" until a
     price to judge the decision by exists — and a WHY for it;
     records a bet with its decision (planned, model probability, thesis)
     and sees BEFORE YOU ENTER context that never says BET or DON'T BET;
     reads the calendar by day (entered / events / settled), opens a day and
     records a closing price in the journal, which is then locked — and the
     database refuses a rewrite; the grade follows the price, not the result;
     sees an imported bet marked "Historical import · No pre-entry journal";
     walks the journal's year → month → week → day folders;
     uses the Process Coach: the report, no invented leak, a rule adopted and
     retired, an experiment started, the Film Room;
     filters the one combined book to prediction markets;
     never makes the page download a lifetime of positions;
     still sees P&L when the summary is unavailable;
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
const J = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_journal_ui.js'));
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const SHOTS = (function () { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; }());
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | portfolio UI e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
const json = (s) => JSON.parse(String(s || '').split('\n')[0] || 'null');
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
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio_journal.sql'));
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio_connect.sql'));
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio_decision.sql'));
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

  const tracked = [], fnCalls = [];
  async function open(viewport, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((uid) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: uid, email: 'reader@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, A);
    /* a saved Card entry on this device (lib/edgedesk_decision_ui.js), the Card's onboarding already done */
    if (opts.card) {
      await ctx.addInitScript((c) => {
        try { localStorage.setItem('edgedesk_card_opportunities_v1', JSON.stringify([c])); localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify(new Date().toISOString())); } catch (e) { /* private mode */ }
      }, opts.card);
    }
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
      if (/supabase\.co\/rest\/v1\/rpc\/ed_track/.test(url)) {
        try { (JSON.parse(req.postData() || '{}').p_events || []).forEach((e) => tracked.push(e.event)); } catch (_) { /* ignore */ }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, recorded: 1 }) });
      }
      if (/supabase\.co\/functions\/v1\/portfolio_connect/.test(url)) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { body = {}; }
        fnCalls.push(body);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, account_id: 'acct-e2e', sync: { status: 'SUCCEEDED', totals: { transactions_inserted: 2 } } }) });
      }
      if (m && opts.failRpc && opts.failRpc.test(decodeURIComponent(m[1]))) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }) });
      }
      if (m && /^(rpc\/portfolio_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const token = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', token);
        /* a phone's network: the calendar answers after a beat, so the page is
           seen in the state it is in while a month loads */
        if (/^rpc\/portfolio_calendar$/.test(decodeURIComponent(m[1]))) await new Promise((r) => setTimeout(r, 400));
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
    page.downloads = [];
    page.on('download', (d) => page.downloads.push(d));
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${site.port}/app.html#portfolio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page, host) => page.evaluate((h) => document.getElementById(h).innerText, host || 'pfoHost');
  /* innerText is the RENDERED text: CSS-uppercased headings read uppercased, so keep the regex's own flags */
  const waitText = (page, re, ms, host) => page.waitForFunction((a) => new RegExp(a[0], a[1]).test(document.getElementById(a[2]).innerText), [re.source, re.flags, host || 'pfoHost'], { timeout: ms || 15000 });
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

    /* setup: choose where you bet, add them, see the progress */
    await tab(page, 'accounts');
    await waitText(page, /Set up your portfolio/i);
    chk('a new reader is offered setup: where do you bet or trade?', /Where do you bet or trade\?/.test(await text(page)));
    await page.click('#pfoHost [data-act="setup-pick"][data-v="draftkings"]');
    await page.click('#pfoHost [data-act="setup-pick"][data-v="kalshi"]');
    await page.click('#pfoHost [data-act="setup-add"]');
    await waitText(page, /0 of 2 platforms with history/i);
    chk('the chosen platforms are added as accounts, each waiting for its history',
      db.sql(`select string_agg(platform || ':' || connection_type, ',' order by platform) from public.platform_accounts where user_id = '${A}';`) === 'draftkings:CSV,kalshi:CSV'
      && /Waiting for import/.test(await text(page)) && !/\bConnected\b/.test(await text(page)));
    await shot(page, 'desktop-setup');
    await tab(page, 'overview');

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
    chk('…and says what it detected: platform, wagers found, date range', /Detected: BetMGM · 4 wagers found · [A-Z][a-z]{2} 2026/.test(t), t.slice(t.search(/Detected/), t.search(/Detected/) + 200));
    await page.click('#pfoHost [data-act="imp-check"]');
    await waitText(page, /Before anything is stored/i);
    t = (await text(page)).replace(/\s+/g, ' ');
    chk('the server classifies: 4 found, 2 ready, 1 duplicate, 1 cannot import', /4 Found/i.test(t) && /2 Ready/i.test(t) && /1 Duplicates/i.test(t) && /1 Cannot import/i.test(t) && /Import 2/.test(t),
      t.slice(t.search(/Before anything/i), t.search(/Before anything/i) + 400));
    chk('nothing is inserted before the reader confirms', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === 2);
    await shot(page, 'desktop-import');
    await page.click('#pfoHost [data-act="imp-commit"]');
    await waitText(page, /Imported 2/);
    chk('confirming imports exactly the new rows', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}' and source = 'CSV';`) === 2);
    chk('imported history keeps its own dates: settled at the placed time, not today',
      db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}' and source = 'CSV' and settled_at = placed_at and settled_at < '2026-09-30';`) === '2');

    /* an incremental export: the platform from the file's name, then the same
       columns remembered, and a bet that settled since — an UPDATE */
    const CSV2 = ['Bet ID,Placed,Event,Selection,Odds,Stake,Status,Payout', 'MGM-5,2026-09-20 13:00,Bears @ Packers,Bears +3.5,-105,21,Open,'].join('\n');
    await page.click('#pfoHost [data-act="imp-reset"]');
    await page.setInputFiles('#pfoHost input[type="file"]', { name: 'betmgm-history.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV2) });
    await waitText(page, /from the file's name/);
    t = await text(page);
    chk('a file with no platform column: the platform comes from its name, and the unchecked format is flagged', /Detected: BetMGM/.test(t) && /not yet checked this format against a real BetMGM export/.test(t), t.slice(t.search(/Review/i), t.search(/Review/i) + 400));
    await page.click('#pfoHost [data-act="imp-check"]');
    await waitText(page, /Before anything is stored/i);
    await page.click('#pfoHost [data-act="imp-commit"]');
    await waitText(page, /Imported 1/);
    const CSV3 = CSV2.replace('Open,', 'Won,41');
    await page.click('#pfoHost [data-act="imp-reset"]');
    await page.setInputFiles('#pfoHost input[type="file"]', { name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV3) });
    await waitText(page, /a layout you imported before/);
    chk('the same columns again: read the way they were imported before, platform included', /Detected: BetMGM/.test(await text(page)));
    await page.click('#pfoHost [data-act="imp-check"]');
    await waitText(page, /Updated since/i);
    t = (await text(page)).replace(/\s+/g, ' ');
    chk('the bet that settled since is an UPDATE, with the estimate shown before anything is stored', /1 Updated since/i.test(t) && /If you import these: 1 settled, P&L \+\$20\.00/.test(t)
      && /0 new positions · 1 updated/.test(t) && /Update portfolio · 0 new, 1 updated/.test(t), t.slice(t.search(/Before anything/i), t.search(/Before anything/i) + 500));
    await page.click('#pfoHost [data-act="imp-commit"]');
    await waitText(page, /updated 1/);
    chk('…and committing updates the stored bet in place: WON, +$20.00, still one bet',
      db.sql(`select status || ':' || profit_loss::text || ':' || count(*) over () from public.portfolio_positions where user_id = '${A}' and external_position_id = 'MGM-5';`) === 'WON:20:1');
    await shot(page, 'desktop-import-update');

    /* ═══ the Decision Grade, the journal, the calendar, the coach ═══════ */
    await tab(page, 'overview');
    await waitText(page, /Decision Grade/i);
    t = await text(page);
    chk('the Overview leads with P&L and ROI, then the Decision Grade', t.search(/Total P&L/i) >= 0 && t.search(/ROI/) < t.search(/Decision Grade/i), t.slice(0, 400));
    chk('with no price to judge a decision by, no letter is invented', /Not graded yet/.test(t));
    chk('What\'s working / What\'s not, claiming nothing the data cannot carry', /What's not/i.test(t) && /NO RELIABLE LEAK DETECTED/.test(t), t.slice(t.search(/What's working/i), t.search(/What's working/i) + 300));
    await page.click('#pfoHost [data-act="why"][data-id="grade"]');
    await page.waitForSelector('.pfo-sheet:not([hidden]) .pfo-why-dl');
    const why = await page.$eval('.pfo-sheet', (e) => e.innerText);
    chk('WHY explains the grade: its components and weights, missing data, its limits', /Closing line value 30%/.test(why) && /Missing data/i.test(why) && /Limitations/i.test(why), why.slice(0, 300));
    await page.click('.pfo-sheet [data-act="why-close"]');

    /* a bet recorded with its decision, and the context before entering it */
    const later = await page.evaluate(() => { const d = new Date(Date.now() + 3 * 864e5), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); });
    await page.click('#pfoHost [data-act="add"]');
    await page.click('.pfo-sheet [data-act="new-wager"]');
    await fill(page, { platform: 'draftkings', sport: 'NFL', event_name: 'Ravens @ Steelers', position_type: 'MONEYLINE', selection: 'Ravens', odds: '-120', stake: '60', event_start_at: later });
    await fill(page, { planned: 'true' });
    await page.fill('.pfo-sheet [name="model_probability_j"]', '0.58');
    await page.fill('.pfo-sheet [name="thesis"]', 'Injury news moved the line toward Baltimore; my number is -140.');
    await page.waitForSelector('.pfo-sheet .pfo-prebet', { timeout: 15000 });
    await page.waitForFunction(() => /expected value/.test((document.querySelector('.pfo-sheet .pfo-prebet') || {}).innerText || ''), null, { timeout: 15000 });
    const pre = await page.$eval('.pfo-sheet .pfo-prebet', (e) => e.innerText);
    chk('BEFORE YOU ENTER gives context from the reader\'s own record: the model\'s EV at this price, the timing', /Before you enter/i.test(pre) && /expected value of \+6\.3%/.test(pre) && /the decision is yours/i.test(pre), pre);
    chk('and never says BET, DON\'T BET, LOCK or GUARANTEED', !/\b(BET|DON'T BET|LOCK|GUARANTEED)\b/.test(pre));
    await shot(page, 'desktop-prebet');
    await page.click('.pfo-sheet [data-act="save"]');
    await waitText(page, /Recorded\./);
    const jr = db.sql(`select j.planned::text || '|' || j.thesis || '|' || j.model_probability::text || '|' || (j.decision_recorded_at < p.event_start_at)::text
                         from public.portfolio_journal_entries j join public.portfolio_positions p on p.id = j.position_id where p.user_id = '${A}' and p.event_name = 'Ravens @ Steelers';`);
    chk('the decision is recorded with the position, before the event', /^true\|Injury news moved the line.*\|0\.58\d*\|true$/.test(jr), jr);

    /* the calendar, a day, and a closing price in the journal */
    await tab(page, 'calendar');
    await page.waitForSelector('#pfoHost .pfo-cal-nav b');
    for (let i = 0; i < 36; i++) {
      const head = await page.$eval('#pfoHost .pfo-cal-nav b', (e) => e.innerText);
      if (/September 2026/.test(head)) break;
      const [mo, yr] = head.split(' '), cur = +yr * 12 + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(mo);
      await page.click(`#pfoHost [data-act="cal-move"][data-v="${cur > 2026 * 12 + 8 ? -1 : 1}"]`);
      await page.waitForFunction((h) => document.querySelector('#pfoHost .pfo-cal-nav b').innerText !== h, head);
    }
    await page.waitForSelector('#pfoHost .pfo-cal-d.on');
    const cell = await page.$eval('#pfoHost [data-act="cal-day"][data-v="2026-09-07"]', (e) => e.innerText);
    chk('a calendar day carries what was entered and the P&L that settled: −$100.00 + $60.00 = −$40.00', /2 in/.test(cell) && /−\$40\.00/.test(cell), cell);
    await page.click('#pfoHost [data-act="cal-day"][data-v="2026-09-07"]');
    await waitText(page, /Settled this day/i);
    t = await text(page);
    chk('the day lists what was entered and what settled', /Entered this day/i.test(t) && /Settled this day/i.test(t) && /Chiefs -2\.5/.test(t) && /Jets/.test(t), t.slice(t.search(/Entered this day/i), t.search(/Entered this day/i) + 400));
    chk('an imported bet says there is no pre-entry journal, and invents none', /Historical import · No pre-entry journal available\./.test(t));
    await page.click('#pfoHost [data-act="cal-basis"][data-v="settled"]');
    chk('the calendar reads by settlement day on request', /P&L that settled that day/.test(await text(page)));
    await shot(page, 'desktop-calendar');
    /* a month arrow keeps the calendar on screen while the next month loads */
    await page.click('#pfoHost [data-act="cal-move"][data-v="1"]');
    const mid = await page.evaluate(() => ({ head: (document.querySelector('#pfoHost .pfo-cal-nav b') || {}).innerText || null,
      arrows: document.querySelectorAll('#pfoHost [data-act="cal-move"]').length, grid: !!document.querySelector('#pfoHost .pfo-cal[aria-busy="true"]'),
      note: /Loading October 2026…/.test(document.getElementById('pfoHost').innerText) }));
    chk('a month arrow keeps the heading, the arrows and the grid while the month loads', mid.head === 'October 2026' && mid.arrows === 2 && mid.grid && mid.note, mid);
    await page.waitForSelector('#pfoHost .pfo-cal:not([aria-busy])');
    await page.click('#pfoHost [data-act="cal-move"][data-v="-1"]');
    await page.waitForSelector('#pfoHost .pfo-cal:not([aria-busy])');
    {
      const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      const sep = db.as(A, `select coalesce(sum(pnl), 0)::text || '|' || coalesce(sum(settled), 0)::text from public.portfolio_calendar('2026-09-01', '2026-10-01', '${tz}');`).split('|');
      const sumText = (await page.$eval('#pfoHost .pfo-cal-sum', (e) => e.innerText)).replace(/\s+/g, ' ');
      chk('the month line is what the database settled in September', /Settled in September/i.test(sumText)
        && sumText.indexOf(E.money(sep[0], { sign: true })) >= 0 && sumText.indexOf(sep[1] + ' position') >= 0, [sep, sumText]);
    }
    /* back to the day the journal step below works from */
    await page.click('#pfoHost [data-act="cal-day"][data-v="2026-09-07"]');
    await waitText(page, /Settled this day/i);
    await page.click('#pfoHost .pfo-jcard:has-text("Chiefs -2.5") [data-act="journal"]');
    await page.waitForSelector('.pfo-sheet form[data-form="journal"] [name="closing_odds_american"]');
    await page.fill('.pfo-sheet [name="closing_odds_american"]', '-130');
    await page.selectOption('.pfo-sheet [name="would_repeat"]', 'YES');
    await page.click('.pfo-sheet [data-act="journal-save"]');
    await waitText(page, /Journal saved/);
    const chiefs = db.sql(`select id from public.portfolio_positions where user_id = '${A}' and event_name = 'Chiefs @ Bills';`);
    const jc = db.sql(`select closing_odds_american::text || '|' || closing_source || '|' || would_repeat from public.portfolio_journal_entries where position_id = '${chiefs}';`);
    chk('a closing price is recorded once, as the reader\'s own entry', jc === '-130|USER|YES', jc);
    await page.waitForSelector('#pfoHost .pfo-jcard:has-text("Chiefs -2.5") [data-act="journal"]');
    await page.click('#pfoHost .pfo-jcard:has-text("Chiefs -2.5") [data-act="journal"]');
    await page.waitForSelector('.pfo-sheet form[data-form="journal"] .pfo-locked');
    chk('and is then shown locked, never rewritten', /never rewritten/.test(await page.$eval('.pfo-sheet', (e) => e.innerText)) && !(await page.$('.pfo-sheet [name="closing_odds_american"]')));
    const rw = rest.handle('PATCH', 'portfolio_journal_entries', 'position_id=eq.' + chiefs, { closing_odds_american: -105 }, '', 'e2e');
    chk('the database refuses a rewrite, whatever a page sends', rw.status === 403 && /never rewritten/.test(rw.body.message), rw);
    await page.click('.pfo-sheet [data-act="close"]');
    await tab(page, 'overview');
    await waitText(page, /\b1 of \d+ positions? graded/);
    t = await text(page);
    /* the decision is graded on its price; the book's letter waits for the engine's evidence rule (10 graded) */
    const chiefsGrade = db.as(A, `select grade || '|' || result from public.portfolio_facts(null, null, 'UTC', null) where id = '${chiefs}';`);
    chk('a lost bet taken at a better price than the close grades well: the grade follows the price, not the result', /^A\+\|LOSS$/.test(chiefsGrade), chiefsGrade);
    chk('…and one graded position gives the book no letter yet: Building, with its count', /Building\./.test(t) && /\b1 of \d+ positions? graded/.test(t) && /given from 10 graded positions/.test(t), t.slice(t.search(/Decision Grade/i), t.search(/Decision Grade/i) + 300));

    /* the journal's folders */
    await tab(page, 'journal');
    await page.waitForSelector('#pfoHost details[data-r="year"][data-v="2026"]');
    await page.click('#pfoHost details[data-r="year"][data-v="2026"] > summary');
    await page.waitForSelector('#pfoHost details[data-r="fold"][data-v="m:2026-9"]');
    await page.click('#pfoHost details[data-r="fold"][data-v="m:2026-9"] > summary');
    await page.click('#pfoHost details[data-r="fold"][data-v="m:2026-9"] details[data-r="fold"] > summary');
    await page.click('#pfoHost details[data-r="fold"][data-v="m:2026-9"] [data-act="journal-day"]');
    await page.waitForSelector('#pfoHost .pfo-jcard');
    chk('the journal files by year → month → week → day, and the folders stay open while a day is read',
      await page.$eval('#pfoHost details[data-r="fold"][data-v="m:2026-9"]', (e) => e.open) && /(Entered|Settled) this day/i.test(await text(page)));
    await shot(page, 'desktop-journal');

    /* the Process Coach: the Process seat (docs/ia/NAVIGATION_AUDIT.md), not a Portfolio tab */
    chk('Portfolio has no Coach tab', !(await page.$('#pfoHost .pfo-tab[data-v="coach"]')));
    await tab(page, 'overview');
    await waitText(page, /How you decide: open Process/);
    await page.click('#pfoHost [data-act="tab"][data-v="coach"]');   /* the overview's "How you decide: open Process" */
    await page.waitForFunction(() => !document.getElementById('v-process').classList.contains('hide'));
    chk('the overview\'s "open Process" lands on the Process seat', await page.evaluate(() => location.hash === '#process'
      && document.querySelector('.bottomnav button[data-v="process"]').classList.contains('on')));
    /* Process opens on an answer, not on a menu of reports */
    await waitText(page, /How is my process\?/i, 15000, 'pcoHost');
    t = await text(page, 'pcoHost');
    chk('Process opens on Overview · Film Room · Explore, and answers first: how is my process?', await page.$$eval('#pcoHost .pcx-nav .pcx-seg', (b) => b.map((x) => x.textContent).join('|')) === 'Overview|Film Room|Explore'
      && /How is my process\?/i.test(t) && /Process (score|profile)/i.test(t), t.slice(0, 400));
    const graded = +db.as(A, `select (portfolio_summary(null, null, '${await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)}', null)->'process'->>'graded')::int;`);
    chk('with fewer than 10 graded positions the profile reads Building, with the count — no score is invented', graded >= 10 || (/Process profile\s*Building/i.test(t) && new RegExp('\\b' + graded + '\\s*eligible position').test(t)), [graded, t.slice(0, 300)]);
    chk('no report is a peer of the Overview: Leaks, Timing, Rules … are under Explore', !(await page.$('#pcoHost .pcx-nav [data-v="leaks"]')) && !(await page.$('#pcoHost [data-act="platform"]')) && /All activity/.test(t));
    await page.click('#pcoHost [data-act="why"][data-id="score"]');
    await page.waitForSelector('#pcoHost .pfo-sheet:not([hidden]) .pfo-why-dl');
    const scoreWhy = await page.$eval('#pcoHost .pfo-sheet', (e) => e.innerText);
    chk('WHY opens the evidence: sample size, date range, comparison, CLV, P&L, confidence, methodology, limitations',
      ['Sample size', 'Date range', 'Comparison group', 'CLV', 'P&L', 'Confidence', 'Methodology', 'Limitations'].every((k) => new RegExp(k, 'i').test(scoreWhy)), scoreWhy.slice(0, 500));
    await page.click('#pcoHost .pfo-sheet [data-act="why-close"]');
    /* one Filter; chips only once a filter is applied */
    await page.click('#pcoHost [data-act="filter-open"]');
    await page.waitForSelector('.pfo-sheet form[data-form="filter"]');
    await page.click('.pfo-sheet .pcx-opt:has(input[name="source"][value="SPORTSBOOK"])');
    await page.click('.pfo-sheet [data-act="filter-apply"]');
    await page.waitForSelector('#pcoHost .pcx-chip[data-v="platform"]');
    chk('a filter applied shows as one removable chip', /Sportsbooks/.test(await page.$eval('#pcoHost .pcx-filterbar', (e) => e.innerText)) && !/All activity/.test(await page.$eval('#pcoHost .pcx-filterbar', (e) => e.innerText)));
    await page.click('#pcoHost .pcx-chip[data-v="platform"]');
    await waitText(page, /All activity/, 15000, 'pcoHost');
    /* the depth, one step down */
    const explore = async (sub) => { await page.click('#pcoHost .pcx-nav [data-v="explore"]'); await page.waitForSelector('#pcoHost .pcx-explore'); await page.click(`#pcoHost .pcx-xrow[data-v="${sub}"]`); };
    await explore('outcome');
    await waitText(page, /Process vs outcome/i, 15000, 'pcoHost');
    t = await text(page, 'pcoHost');
    chk('Explore › Process vs outcome: the lost Chiefs bet is a good loss', /1\s*good loss/.test(t), t.slice(0, 600));
    await explore('leaks');
    await waitText(page, /NO RELIABLE LEAK DETECTED/, 15000, 'pcoHost');
    chk('a page of the coach is linkable: #process/leaks', await page.evaluate(() => location.hash) === '#process/leaks');
    chk('Leaks: with this little data, no leak is claimed', true);
    for (const sub of ['strengths', 'timing', 'edge']) { await explore(sub); await page.waitForTimeout(250); }
    chk('Strengths, Timing and Edge Capture render under Explore, each with its way back', !/Loading your process/.test(await text(page, 'pcoHost')) && /Edge capture/i.test(await text(page, 'pcoHost'))
      && !!(await page.$('#pcoHost [data-act="coach"][data-v="explore"]')));
    await explore('rules');
    await page.waitForSelector('#pcoHost form[data-form="rule"]');
    await page.selectOption('#pcoHost form[data-form="rule"] [name="kind"]', 'MAX_STAKE_UNITS');
    await page.fill('#pcoHost form[data-form="rule"] [name="a"]', '2');
    await page.click('#pcoHost [data-act="rule-add"]');
    await waitText(page, /No position larger than 2 units/, 15000, 'pcoHost');
    chk('a rule is adopted from now on', db.sql(`select count(*) from public.portfolio_rules where user_id = '${A}' and kind = 'MAX_STAKE_UNITS' and active_until is null and active_from > now() - interval '5 minutes';`) === '1');
    await page.click('#pcoHost [data-act="rule-retire"]');
    await waitText(page, /retired \d{4}-/, 15000, 'pcoHost');
    chk('and retired, keeping its history', db.sql(`select count(*) from public.portfolio_rules where user_id = '${A}' and active_until is not null;`) === '1');
    await explore('experiments');
    await page.waitForSelector('#pcoHost form[data-form="experiment"]');
    await page.fill('#pcoHost form[data-form="experiment"] [name="title"]', 'Enter NFL positions a day before kickoff');
    await page.click('#pcoHost [data-act="exp-add"]');
    await waitText(page, /Not enough positions yet/, 15000, 'pcoHost');
    chk('an experiment starts, and says it needs data rather than guessing', db.sql(`select count(*) from public.portfolio_experiments where user_id = '${A}' and status = 'ACTIVE';`) === '1');
    await page.click('#pcoHost .pcx-nav [data-v="overview"]');
    await waitText(page, /Current experiment/i, 15000, 'pcoHost');
    t = await text(page, 'pcoHost');
    chk('the Overview shows the running experiment: its week, during against before, and that it never promises a result', /Current experiment\s*Enter NFL positions a day before kickoff/i.test(t) && /Week 1 of 4/.test(t) && /never promises a result/.test(t), t.slice(t.search(/Current experiment/i), t.search(/Current experiment/i) + 400));
    /* the Film Room, on the week the book was built in */
    await page.click('#pcoHost .pcx-nav [data-v="film"]');
    await page.waitForSelector('#pcoHost .pcx-film-t');
    for (let i = 0; i < 80 && !/Sep 7/.test(await page.$eval('#pcoHost .pcx-film-t', (e) => e.textContent)); i++) {
      const before = await page.$eval('#pcoHost .pcx-film-t', (e) => e.textContent);
      await page.click('#pcoHost [data-act="film-move"][data-v="-1"]');
      await page.waitForFunction((b) => { const el = document.querySelector('#pcoHost .pcx-film-t'); return el && el.textContent !== b; }, before, { timeout: 15000 });
    }
    t = await text(page, 'pcoHost');
    chk('the Film Room leads with the week: result, process grade, rules, average CLV, and one sentence with its WHY', /Week of Sep 7/.test(t) && /Financial result/i.test(t) && /Process grade/i.test(t)
      && /Rules followed/i.test(t) && /Avg CLV/i.test(t) && !!(await page.$('#pcoHost [data-act="why"][data-id="week"]')), t.slice(0, 600));
    chk('a sparse week says how few positions it rests on, and shows no empty sections', /Only \d+ eligible position|\d+ eligible positions this week/.test(t) && !/None this week/.test(t));
    chk('the good loss is named, and why EdgeDesk still graded it well', /Lost on a good decision/i.test(t) && /Chiefs -2\.5/.test(t) && /EdgeDesk graded the entry positively despite the loss/.test(t), t.slice(t.search(/Lost on a good/i), t.search(/Lost on a good/i) + 400));
    /* the reflection: after the result, beside what was recorded before */
    const rid = await page.$eval('#pcoHost .pcx-review', (e) => e.getAttribute('data-id'));
    const decisionBefore = db.sql(`select coalesce(thesis, '') || '|' || coalesce(decision_recorded_at::text, '') || '|' || coalesce(closing_odds_american::text, '') from public.portfolio_journal_entries where position_id = '${rid}';`);
    await page.click(`#pcoHost [data-act="review-pick"][data-id="${rid}"][data-v="NO"]`);
    await page.fill(`#pcoHost [data-review="${rid}"]`, 'Took it after the line moved.');
    await page.click(`#pcoHost [data-act="review-save"][data-id="${rid}"]`);
    await waitText(page, /Reflection saved/, 15000, 'pcoHost');
    chk('WOULD YOU MAKE THIS BET AGAIN? NO, and why — stored as the after-the-result reflection',
      db.sql(`select would_repeat || '|' || review_note || '|' || (reviewed_at is not null)::text from public.portfolio_journal_entries where position_id = '${rid}';`) === 'NO|Took it after the line moved.|true');
    chk('…and what was recorded before the bet is unchanged', db.sql(`select coalesce(thesis, '') || '|' || coalesce(decision_recorded_at::text, '') || '|' || coalesce(closing_odds_american::text, '') from public.portfolio_journal_entries where position_id = '${rid}';`) === decisionBefore);
    await shot(page, 'desktop-coach');
    chk('what EdgeDesk tracked is folded under the coach', await page.evaluate(() => { const d = document.getElementById('pcTracked'); return !!d && !d.open && !!d.querySelector('#processHost'); }));
    /* an old #portfolio/coach link lands on the Process seat */
    await page.click('.bottomnav button[data-v="portfolio"]');
    await page.waitForSelector('#pfoHost .pfo-tab[data-v="overview"]');
    await page.evaluate(() => { location.hash = '#portfolio/coach'; });
    await page.waitForFunction(() => !document.getElementById('v-process').classList.contains('hide') && /^#process(\/[a-z]+)?$/.test(location.hash), null, { timeout: 10000 });
    chk('an old #portfolio/coach link opens Process, and the link names the page shown', await page.evaluate(() => location.hash) === '#process/film' && /Film Room/i.test(await text(page, 'pcoHost')));
    await page.click('.bottomnav button[data-v="portfolio"]');
    await page.waitForSelector('#pfoHost .pfo-tab[data-v="overview"]');

    /* one combined book, filtered on request */
    await tab(page, 'overview');
    await page.click('#pfoHost [data-act="platform"][data-v="type:PREDICTION_MARKET"]');
    await page.waitForFunction(() => { const b = document.querySelector('#pfoHost .pfo-big'); return b && /\+\$38\.50/.test(b.innerText); }, null, { timeout: 15000 });
    t = await text(page);
    const byPlat = t.slice(t.search(/P&L by platform/i));
    chk('filtered to prediction markets, the total is Kalshi\'s alone', /Kalshi/.test(byPlat) && !/DraftKings|BetMGM/.test(byPlat), byPlat.slice(0, 200));
    await page.click('#pfoHost [data-act="platform"][data-v=""]');
    await page.waitForFunction(() => { const b = document.querySelector('#pfoHost .pfo-big'); return b && !/\+\$38\.50/.test(b.innerText); }, null, { timeout: 15000 });
    const reads = rest.log.filter((l) => l.method === 'GET' && l.path === 'portfolio_positions');
    chk('the page never downloads a lifetime: positions are read open-only, or the latest 1,000 settled',
      reads.length > 0 && reads.every((l) => /status=eq\.OPEN/.test(l.query) || (/status=neq\.OPEN/.test(l.query) && /limit=1000\b/.test(l.query))), reads.map((l) => l.query.slice(-80)));

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
    for (const v of ['overview', 'calendar', 'journal', 'open', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      await page.waitForTimeout(300);
      if (/SECRET-B/.test(await text(page))) { chk('reader B\'s position never appears (' + v + ')', false); }
    }
    chk('reader B\'s position never appears on any tab', !/SECRET-B/.test(await text(page)));
    await page.click('.bottomnav button[data-v="process"]');
    /* Process reopens on the coach page last read: the Film Room */
    await waitText(page, /Film Room[\s\S]*Week of Sep 7/i, 15000, 'pcoHost');
    chk('Process reopens on the page and week last read, and its link says so', await page.evaluate(() => location.hash) === '#process/film');
    chk('nor in Process', !/SECRET-B/.test(await text(page, 'pcoHost')));
    await page.click('.bottomnav button[data-v="portfolio"]');

    /* "Add account" opens the grouped list; the ready card carries the server's all-time totals */
    await tab(page, 'accounts');
    await page.click('#pfoHost [data-act="setup-open"]');
    await waitText(page, /Tracked positions\s*\d+[\s\S]*Total P&L\s*[+\u2212-]?\$[\d,.]+/i);
    t = await text(page);
    chk('Add account lists platforms by how they come in, and the ready card shows the server\'s totals', /Sportsbooks · import/i.test(t) && /Prediction markets ·/i.test(t)
      && /Your portfolio is ready/i.test(t) && /Process profile\s*(Building|Ready) ·/i.test(t) && /Total\s*\d+ positions?/i.test(t), t.slice(0, 1600));
    await shot(page, 'desktop-ready');

    /* the time-to-value evidence the page sent */
    await page.evaluate(() => window.EDTrack && window.EDTrack.flush && window.EDTrack.flush());
    await page.waitForTimeout(300);
    const want = ['portfolio_onboarding_started', 'platform_selected', 'first_position_created', 'import_started', 'import_detected', 'import_reviewed', 'import_completed', 'portfolio_ready'];
    chk('time to value: setup, platforms chosen, the first position, every import step and "ready" were recorded', want.every((w) => tracked.indexOf(w) >= 0), { missing: want.filter((w) => tracked.indexOf(w) < 0), tracked });

    /* once the database switches automatic connection on, Accounts offers it — read-only, in a sheet */
    const smokeIds = ['kalshi', 'polymarket'].map((pk) => db.sql(`insert into portfolio_private.connector_smoke_tests (platform_key, connector_version, environment, stages, status, finished_at)
      values ('${pk}', '${pk}_v1', 'PRODUCTION', '${JSON.stringify(Object.fromEntries(['CONNECT', 'IMPORT', 'VERIFY', 'INCREMENTAL', 'NEW_ACTIVITY', 'SETTLEMENT', 'RECONCILE', 'DISCONNECT', 'RECONNECT', 'NO_DUPLICATES'].map((x) => [x, { ok: true }])))}'::jsonb, 'PASSED', now()) returning id;`).split('\n')[0]);
    db.sql(`update public.portfolio_platform_registry set automatic_enabled = true, tos_review = 'CLEARED', enabled_at = now(), enabled_by_smoke_test = case platform_key when 'kalshi' then '${smokeIds[0]}'::uuid else '${smokeIds[1]}'::uuid end where platform_key in ('kalshi', 'polymarket');`);
    await tab(page, 'overview'); await tab(page, 'accounts');
    await page.waitForSelector('#pfoHost [data-act="acct-connect"][data-platform="polymarket"]');
    await page.click('#pfoHost .pfo-rows [data-act="acct-connect"][data-platform="polymarket"]');
    await page.waitForSelector('.pfo-sheet form[data-form="connect"] [name="wallet"]');
    await page.fill('.pfo-sheet [name="wallet"]', 'apple banana cherry delta eagle falcon garden harbor island jungle kettle lemon');
    await page.click('.pfo-sheet [data-act="connect-submit"]');
    await page.waitForSelector('.pfo-sheet .pfo-err');
    chk('a seed phrase typed as a wallet is refused in the browser — it is never sent anywhere', /Never share those/.test(await page.$eval('.pfo-sheet .pfo-err', (e) => e.innerText)) && fnCalls.length === 0
      && await page.$eval('.pfo-sheet [name="wallet"]', (e) => e.value === ''));
    await page.click('.pfo-sheet [data-act="close"]');
    await page.click('#pfoHost .pfo-rows [data-act="acct-connect"][data-platform="kalshi"]');
    await page.waitForSelector('.pfo-sheet form[data-form="connect"] [name="private_key"]');
    chk('the Kalshi sheet asks for a READ-ONLY key and says what happens to it', /read access only/.test(await page.$eval('.pfo-sheet', (e) => e.innerText)) && /Read-only/.test(await page.$eval('.pfo-sheet', (e) => e.innerText)));
    const FAKE_KEY = 'e2e-private-key-material-' + 'z'.repeat(40);
    await page.fill('.pfo-sheet [name="key_id"]', 'a952bcbe-ec3b-4b5b-b8f9-11dae589608c');
    await page.fill('.pfo-sheet [name="private_key"]', FAKE_KEY);
    await page.click('.pfo-sheet [data-act="connect-submit"]');
    await waitText(page, /First sync: 2 trades/);
    chk('connect sends the key to EdgeDesk\'s server function once, under the reader\'s token', fnCalls.length === 1 && fnCalls[0].action === 'connect' && fnCalls[0].platform === 'kalshi' && fnCalls[0].private_key === FAKE_KEY);
    chk('…and the key is kept nowhere in the page or the browser afterwards', await page.evaluate((k) => !document.documentElement.innerHTML.includes(k)
      && !JSON.stringify(Object.keys(localStorage).map((x) => localStorage.getItem(x))).includes(k) && !JSON.stringify(window.EDPortfolioUI ? (document.getElementById('pfoHost').__pfo || {}).state || {} : {}).includes(k), FAKE_KEY));
    db.sql(`update public.portfolio_platform_registry set automatic_enabled = false where platform_key in ('kalshi', 'polymarket');`);
    const ls = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
    chk('nothing financial is written to localStorage', !/Chiefs|Kalshi|90\.91|portfolio_positions/.test(ls));
    chk('no page errors on desktop', errors.length === 0, errors);
    await ctx.close();

    /* ═══ CARD → RECORD POSITION → THE DECISION RECORD ═══════════════════ */
    const KICK = new Date(Date.now() + 2 * 86400000).toISOString(), SAVED = new Date(Date.now() - 3 * 3600000).toISOString();
    const CARD_ENTRY = { schema: 'edgedesk_card_entry_v1', entry_id: 'ce_e2e_1', opportunity_id: 'opp_e2e', key: 'game|nfl|e2e1|spread|home', type: 'GAME', sport: 'NFL', league: 'nfl',
      event_key: 'nfl|e2e1', game_id: 'e2e1', kickoff: KICK, home: 'Chiefs', away: 'Bills', market: 'spread', market_label: 'Spread', side: 'home', line: -3,
      selection: 'Chiefs -3', american: -110, book: 'draftkings', captured_at: SAVED, probability: 0.56, ev: 0.069, edge_pp: 3.6, confidence: 71, decision: 'BET', units: 0.5,
      probability_source: 'calibrated', saved_at: SAVED, evaluated_at: SAVED,
      snapshot: { engine: 'opp_v3', decision_id: 'bd_e2e', model: { probability: 0.56, fair_american: -127, fair_line: -4.5, model_version: 'nfl_r2', calibration_version: 'cal_7' }, market_view: { consensus_line: -3, n_books: 6 } } };
    ({ ctx, page, errors } = await open({ width: 1280, height: 900 }, { card: CARD_ENTRY }));
    await page.click('.bottomnav button[data-v="card"]');
    await page.waitForSelector('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_1"]', { timeout: 20000 });
    t = await page.$eval('#eddCardHost [data-edd-entry="ce_e2e_1"]', (e) => e.innerText);
    chk('a saved Card entry is a workspace: View research · Before you enter · Record position · Remove', /View research/.test(t) && /Before you enter/.test(t) && /Record position/.test(t) && /Remove/.test(t), t);
    await page.click('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_1"]');
    await page.waitForSelector('.pfo-sheet form[data-form="wager"]');
    await page.waitForFunction(() => /Before you enter/i.test((document.querySelector('.pfo-sheet [data-r="prebet"]') || {}).innerText || ''), null, { timeout: 15000 });
    const sheet = await page.evaluate(() => {
      const f = document.querySelector('.pfo-sheet form[data-form="wager"]'), v = (n) => (f.querySelector('[name="' + n + '"]') || {}).value;
      const order = [...document.querySelectorAll('.pfo-sheet .pfo-dr-from, .pfo-sheet [data-r="prebet"], .pfo-sheet form[data-form="wager"]')].map((e) => e.className || e.getAttribute('data-r') || e.tagName);
      return { title: document.querySelector('.pfo-sheet .pfo-panel-t').innerText, platform: v('platform'), event: v('event_name'), sel: v('selection'), line: v('line'), odds: v('odds'),
        type: v('position_type'), start: v('event_start_at'), from: document.querySelector('.pfo-sheet .pfo-dr-from').innerText, order: order, hash: location.hash };
    });
    chk('Record position opens on Portfolio, prefilled from the Card — book, event, pick, line, price, market type and start', sheet.title === 'Record position' && sheet.platform === 'draftkings'
      && sheet.event === 'Bills @ Chiefs' && sheet.sel === 'Chiefs -3' && sheet.line === '-3' && sheet.odds === '-110' && sheet.type === 'SPREAD' && sheet.start !== '' && /^#portfolio/.test(sheet.hash), sheet);
    chk('…saying where it came from and that the saved price is not current (captured hours ago — confirm it at the book)',
      /From your Card/.test(sheet.from) && /3 h ago/.test(sheet.from) && /confirm the price at the book/.test(sheet.from), sheet.from);
    await shot(page, 'desktop-record-position');
    chk('…with Before You Enter ahead of the form', sheet.order.length === 3 && /pfo-dr-from/.test(sheet.order[0]) && sheet.order[1] === 'prebet', sheet.order);
    const preCard = await page.$eval('.pfo-sheet [data-r="prebet"]', (e) => e.innerText);
    chk('Before You Enter never says BET or DON\'T BET', !/\bBET THIS\b|DON.?T BET|\bLOCK\b|GUARANTEED/i.test(preCard), preCard.slice(0, 400));
    await fill(page, { odds: '-105', stake: '25' });
    await page.click('.pfo-sheet [data-act="save"]');
    await waitText(page, /Recorded\./);
    const recRow = json(db.sql(`select json_build_object('id', p.id, 'src', p.edge_source, 'origin', s.origin, 'ref', s.origin_ref, 'model', s.edgedesk->>'model_version', 'fresh', s.market_freshness,
        'research', j.research_odds_american, 'rec', (select count(*) from public.portfolio_card_events e where e.entry_id = 'ce_e2e_1' and e.event = 'RECORDED' and e.position_id = p.id),
        'considered', (select count(*) from public.portfolio_card_events e where e.entry_id = 'ce_e2e_1' and e.event = 'CONSIDERED'),
        'path', (select count(*) from public.portfolio_market_path m where m.position_id = p.id))
      from public.portfolio_positions p join public.portfolio_decision_snapshots s on s.position_id = p.id join public.portfolio_journal_entries j on j.position_id = p.id
     where p.user_id = '${A}' and p.event_name = 'Bills @ Chiefs';`));
    chk('one tap stored the position, its immutable decision snapshot (the model\'s version, the saved price and how stale it was), the journal\'s researched price, and the Card\'s RECORDED event',
      recRow && recRow.src === 'EDGEDESK' && recRow.origin === 'CARD' && recRow.ref === 'ce_e2e_1' && recRow.model === 'nfl_r2' && recRow.fresh === 'STALE' && recRow.research === -110
      && +recRow.rec === 1 && +recRow.considered >= 1 && +recRow.path >= 2, recRow);
    await page.click('.bottomnav button[data-v="card"]');
    await page.waitForSelector('#eddCardHost [data-edd-act="card-open-record"]', { timeout: 15000 });
    chk('back on the Card, the entry reads Recorded in Portfolio and opens its record — no second record is offered',
      await page.$('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_1"]') === null
      && await page.$eval('#eddCardHost [data-edd-act="card-open-record"]', (b) => b.getAttribute('data-edd-v')) === recRow.id);
    /* the record, from a notification's or search's door */
    await page.evaluate((id) => window.edOpenRecord(id), recRow.id);
    await page.waitForFunction(() => /Market path/i.test((document.querySelector('.pfo-sheet .pfo-dr') || {}).innerText || ''), null, { timeout: 15000 });
    t = await page.$eval('.pfo-sheet', (e) => e.innerText);
    chk('the Decision Record: BEFORE · ENTRY · MARKET PATH · RESULT · GRADE · REFLECTION · FOLLOW-UP, with its context quality',
      ['Before', 'Entry', 'Market path', 'Result', 'Grade', 'Reflection', 'Follow-up'].every((h) => new RegExp('\\b' + h + '\\b', 'i').test(t)) && /Full context/i.test(t), t.slice(0, 1600));
    chk('…what EdgeDesk said and the market showed, frozen, with the model version and the price\'s age', /Saved to your Card, then recorded/.test(t) && /nfl_r2/.test(t) && /BET/.test(t)
      && /captured more than 90 minutes before the decision/.test(t) && /never rewritten/.test(t), t.slice(0, 1600));
    chk('…and no closing price is invented', /No closing price recorded/.test(t));
    await shot(page, 'desktop-decision-record');
    await page.click('.pfo-sheet [data-act="dr-ask"]');
    await page.waitForFunction(() => document.getElementById('edaiPanel') && document.getElementById('edaiPanel').classList.contains('open'), null, { timeout: 10000 });
    const ans = await page.$eval('#edaiLog', (e) => e.innerText);
    chk('Ask EdgeDesk about this decision answers from the record alone, and says so', /Before\./.test(ans) && /You entered at −105/.test(ans) && /From your own decision record only/.test(ans)
      && !/BET THIS|DON.?T BET|GUARANTEED/i.test(ans), ans.slice(0, 800));
    await page.evaluate(() => window.EDAI && window.EDAI.close());
    /* search reaches the reader's own positions and Card */
    await page.evaluate(() => { if (window.show) window.show('research'); });
    await page.evaluate(() => window.rsToggleSearch && window.rsToggleSearch());
    await page.fill('#rsQ', 'Chiefs');
    await page.waitForFunction(() => /Your positions[\s\S]*Bills @ Chiefs/i.test((document.getElementById('rsMine') || {}).innerText || ''), null, { timeout: 15000 });
    chk('search finds the reader\'s Card entry and recorded position beside research', /On your Card/i.test(await page.$eval('#rsMine', (e) => e.innerText)));
    await page.click('#rsMine [data-ws-rec]');
    await page.waitForFunction(() => /Market path/i.test((document.querySelector('.pfo-sheet .pfo-dr') || {}).innerText || ''), null, { timeout: 15000 });
    chk('…and a position result opens its Decision Record', true);
    await page.click('.pfo-sheet [data-act="close"]');
    /* your data: everything out as data; delete asks for the phrase */
    await tab(page, 'accounts');
    await page.waitForSelector('#pfoHost [data-act="export-json"]');
    await page.click('#pfoHost [data-act="export-json"]');
    await page.waitForFunction(() => /Downloaded/.test(document.getElementById('pfoHost').innerText), null, { timeout: 15000 });
    const dl = page.downloads[page.downloads.length - 1];
    const dlBody = dl ? JSON.parse(fs.readFileSync(await dl.path(), 'utf8')) : null;
    chk('Download everything gives every record as data — positions, snapshots, path, journal — and none of reader B\'s',
      dlBody && dlBody.format === 'edgedesk_portfolio_export_v1' && dlBody.positions.length > 0 && dlBody.decision_snapshots.some((x) => x.origin === 'CARD' && x.origin_ref === 'ce_e2e_1') && dlBody.market_path.length >= 2
      && !/SECRET-B/.test(JSON.stringify(dlBody)), dlBody && Object.keys(dlBody));
    await page.click('#pfoHost [data-act="delete-all"]');
    await waitText(page, /Nothing was deleted/);
    chk('Delete my Portfolio deletes nothing without the typed phrase', +db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) > 0);
    chk('no page errors on the Card → Record → Decision Record path', errors.length === 0, errors);
    await ctx.close();

    /* ═══ PHONE: 390 px ════════════════════════════════════════════════ */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, { card: Object.assign({}, CARD_ENTRY, { entry_id: 'ce_e2e_phone' }) }));
    await waitText(page, /Total P&L/i);
    for (const v of ['overview', 'calendar', 'journal', 'open', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      await page.waitForTimeout(400);
      await noSideways(page, '390px ' + v);
      await shot(page, 'phone-' + v);
    }
    /* a phone's month: every day's P&L legible, none cut to "−$10…" */
    await tab(page, 'calendar');
    await page.waitForSelector('#pfoHost .pfo-cal-nav b');
    for (let i = 0; i < 36; i++) {
      const head = await page.$eval('#pfoHost .pfo-cal-nav b', (e) => e.innerText);
      if (/September 2026/.test(head)) break;
      const [mo, yr] = head.split(' '), cur = +yr * 12 + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(mo);
      await page.click(`#pfoHost [data-act="cal-move"][data-v="${cur > 2026 * 12 + 8 ? -1 : 1}"]`);
      await page.waitForSelector('#pfoHost .pfo-cal:not([aria-busy])');
    }
    await page.click('#pfoHost [data-act="cal-basis"][data-v="settled"]');
    const cells = await page.evaluate(() => [].slice.call(document.querySelectorAll('#pfoHost .pfo-cal .pfo-cal-s')).map((s) => {
      const shown = [].slice.call(s.children).filter((c) => getComputedStyle(c).display !== 'none')[0];
      return { text: shown ? shown.textContent : '', fits: s.scrollWidth <= s.clientWidth + 0.5, cell: s.closest('[data-v]').getAttribute('data-v'), label: s.closest('[data-v]').getAttribute('aria-label') };
    }));
    chk('390px: every settled day shows its P&L whole, none clipped', cells.length > 0 && cells.every((c) => c.fits && !/…/.test(c.text)), cells);
    chk('390px: the short figure is the exact one, rounded (the label keeps it exact)', cells.every((c) => { const m = /P&L ([^,]+)$/.exec(c.label); return m && J.compactMoney(m[1].replace('−', '-').replace(/[$,+]/g, '')) === c.text; }), cells);
    await noSideways(page, '390px calendar, September');
    await shot(page, 'phone-calendar-september');
    /* Process on a phone: the answer in the first screen, no chip explosion */
    await page.click('.bottomnav button[data-v="process"]');
    await waitText(page, /How is my process\?/i, 15000, 'pcoHost');
    const pp = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('#pcoHost .pcx-nav .pcx-seg')], hero = document.querySelector('#pcoHost .pcx-hero');
      return { segs: segs.length, fit: segs.every((b) => b.scrollWidth <= b.clientWidth + 1), heroTop: hero ? hero.getBoundingClientRect().top : 9999, vh: innerHeight,
        bar: document.querySelectorAll('#pcoHost .pcx-filterbar button').length, chips: document.querySelectorAll('#pcoHost [data-act="platform"], #pcoHost [data-act="period"]').length };
    });
    chk('390px: Process shows three places that fit, one Filter, and the answer in the first screen', pp.segs === 3 && pp.fit && pp.bar === 1 && pp.chips === 0 && pp.heroTop < pp.vh * 0.6, pp);
    await noSideways(page, '390px Process overview');
    await shot(page, 'phone-process');
    await page.click('#pcoHost .pcx-nav [data-v="film"]');
    await page.waitForSelector('#pcoHost .pcx-film-t');
    await noSideways(page, '390px Film Room');
    await shot(page, 'phone-film');
    await page.click('#pcoHost .pcx-nav [data-v="explore"]');
    await page.waitForSelector('#pcoHost .pcx-explore');
    await noSideways(page, '390px Explore');
    await shot(page, 'phone-explore');
    await page.click('.bottomnav button[data-v="portfolio"]');
    await page.waitForSelector('#pfoHost .pfo-tab[data-v="history"]');
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
    await page.click('.pfo-sheet [data-act="close"]');
    /* the Card entry's actions and Record Position, on a phone */
    await page.click('.bottomnav button[data-v="card"]');
    await page.waitForSelector('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_phone"]', { timeout: 20000 });
    /* the Card repaints once its decisions load: measure the button once it is laid out */
    await page.waitForFunction(() => { const b = document.querySelector('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_phone"]');
      if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, null, { timeout: 20000 });
    await page.waitForTimeout(300);
    const rec = await page.$eval('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_phone"]', (b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right }; });
    chk('390px: Record position is a full-width, thumb-sized button on the Card', rec.w >= 300 && rec.h >= 40 && rec.right <= 391, rec);
    await noSideways(page, '390px Card with an entry');
    await shot(page, 'phone-card-entry');
    await page.click('#eddCardHost [data-edd-act="card-record"][data-edd-v="ce_e2e_phone"]');
    await page.waitForSelector('.pfo-sheet form[data-form="wager"]');
    const rp = await page.$eval('.pfo-sheet .pfo-panel', (e) => { const r = e.getBoundingClientRect(); return { right: r.right, from: !!e.querySelector('.pfo-dr-from') }; });
    chk('390px: Record position opens prefilled, with where it came from, and fits the screen', rp.right <= 391 && rp.from, rp);
    await noSideways(page, '390px Record position');
    await shot(page, 'phone-record-position');
    chk('no page errors on the phone', errors.length === 0, errors);
    await ctx.close();

    /* ═══ the summary unavailable: the page still answers ════════════════ */
    ({ ctx, page, errors } = await open({ width: 1024, height: 800 }, { failRpc: /^rpc\/portfolio_(summary|cells)$/ }));
    await waitText(page, /could not be loaded/);
    t = await text(page);
    chk('without the server summary, P&L still shows from the positions on the page, and says so', /Total P&L/i.test(t) && /could not be loaded/.test(t) && /\$\d/.test(t), t.slice(0, 400));
    chk('no page errors without the summary', errors.length === 0, errors);
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
