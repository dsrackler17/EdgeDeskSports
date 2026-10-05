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
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio_journal.sql'));
  db.applyFileAtomic(path.join(ROOT, 'supabase', 'portfolio_connect.sql'));
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
    await waitText(page, /process score/i);
    t = await text(page);
    chk('a lost bet taken at a better price than the close grades well: the grade follows the price, not the result', /\b1 of \d+ positions graded/.test(t) && /\bA\+/.test(t), t.slice(t.search(/Decision Grade/i), t.search(/Decision Grade/i) + 300));

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

    /* the Process Coach */
    await tab(page, 'coach');
    await waitText(page, /Process vs outcome/i);
    t = await text(page);
    chk('the Process Report: the grade, process against outcome — the lost Chiefs bet is a good loss', /Process vs outcome/i.test(t) && /1\s*good loss/.test(t), t.slice(0, 600));
    await page.click('#pfoHost [data-act="coach"][data-v="leaks"]');
    await waitText(page, /NO RELIABLE LEAK DETECTED/);
    chk('Leaks: with this little data, no leak is claimed', true);
    for (const sub of ['strengths', 'timing', 'edge']) {
      await page.click(`#pfoHost [data-act="coach"][data-v="${sub}"]`);
      await page.waitForTimeout(250);
    }
    chk('Strengths, Timing and Edge Capture render', !/Loading your process/.test(await text(page)) && /Edge capture/i.test(await text(page)));
    await page.click('#pfoHost [data-act="coach"][data-v="rules"]');
    await page.waitForSelector('#pfoHost form[data-form="rule"]');
    await page.selectOption('#pfoHost form[data-form="rule"] [name="kind"]', 'MAX_STAKE_UNITS');
    await page.fill('#pfoHost form[data-form="rule"] [name="a"]', '2');
    await page.click('#pfoHost [data-act="rule-add"]');
    await waitText(page, /No position larger than 2 units/);
    chk('a rule is adopted from now on', db.sql(`select count(*) from public.portfolio_rules where user_id = '${A}' and kind = 'MAX_STAKE_UNITS' and active_until is null and active_from > now() - interval '5 minutes';`) === '1');
    await page.click('#pfoHost [data-act="rule-retire"]');
    await waitText(page, /retired \d{4}-/);
    chk('and retired, keeping its history', db.sql(`select count(*) from public.portfolio_rules where user_id = '${A}' and active_until is not null;`) === '1');
    await page.click('#pfoHost [data-act="coach"][data-v="experiments"]');
    await page.waitForSelector('#pfoHost form[data-form="experiment"]');
    await page.fill('#pfoHost form[data-form="experiment"] [name="title"]', 'Enter NFL positions a day before kickoff');
    await page.click('#pfoHost [data-act="exp-add"]');
    await waitText(page, /Not enough positions yet/);
    chk('an experiment starts, and says it needs data rather than guessing', db.sql(`select count(*) from public.portfolio_experiments where user_id = '${A}' and status = 'ACTIVE';`) === '1');
    await page.click('#pfoHost [data-act="coach"][data-v="film"]');
    await waitText(page, /Weekly Film Room/i);
    chk('the Film Room opens on a week, best and weakest decisions apart from results', /Best decisions/i.test(await text(page)) && /Won on a poor decision/i.test(await text(page)));
    await shot(page, 'desktop-coach');

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
    for (const v of ['overview', 'calendar', 'journal', 'coach', 'open', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      await page.waitForTimeout(300);
      if (/SECRET-B/.test(await text(page))) { chk('reader B\'s position never appears (' + v + ')', false); }
    }
    chk('reader B\'s position never appears on any tab', !/SECRET-B/.test(await text(page)));

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

    /* ═══ PHONE: 390 px ════════════════════════════════════════════════ */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await waitText(page, /Total P&L/i);
    for (const v of ['overview', 'calendar', 'journal', 'coach', 'open', 'history', 'analytics', 'accounts', 'import']) {
      await tab(page, v);
      await page.waitForTimeout(400);
      await noSideways(page, '390px ' + v);
      await shot(page, 'phone-' + v);
    }
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
