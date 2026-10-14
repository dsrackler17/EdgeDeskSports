#!/usr/bin/env node
/* ===========================================================================
   BETSYNC IN CHROMIUM — the Accounts tab's SharpSports flow, in the shipped
   app.html, against the real migrations (portfolio, journal, connect,
   aggregator, decision) through the PostgREST stand-in, as an operator in
   the sandbox environment.

   The portfolio_connect function is answered here by a stand-in that does
   what the shipped function does on the database side — the SAME service
   functions (portfolio_svc_ag_account_upsert, portfolio_svc_ingest_wagers),
   so the account, the bets and their settlement are the real rows. SharpSports'
   own linking page is a stand-in too: it sends the reader back to the
   redirect URL, as SharpSports documents. Neither is SharpSports' sandbox;
   that run is the live smoke test (docs/platform-connections.md).

   An operator:
     opens Accounts and sees "Connect a sportsbook", with the sandbox warning
     and the books SharpSports lists (an app-only book disabled);
     picks DraftKings and presses Connect DraftKings — the browser goes to
     ui.sharpsports.io, never asked for a password by EdgeDesk;
     comes back (?betsync=return) and sees DraftKings verified with its first
     sync; the address no longer carries the return marker;
     sees the account as BetSync (SharpSports) · sandbox, Connected,
     verified, and its bets in Open and History;
     asks for a refresh and is told SharpSports is reading the book;
   at 1280 px and at 390 px, with no sideways scroll and no page error.

   Run: node tools/portfolio/sharpsports_ui.e2e.js
   (PORTFOLIO_UI_REQUIRED=1 makes a missing Playwright or PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
const K = require(path.join(PG.ROOT, 'lib', 'edgedesk_portfolio_connect_core.js'));

const ROOT = PG.ROOT;
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const OP = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';   // an operator (portfolio_is_admin's fallback)
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | sharpsports UI e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why); process.exit(0); }
const L = PG.lit;
const one = (s) => String(s).split('\n')[0];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) skip('playwright is not installed here');
  const db = PG.start('ssui');
  if (db.skip) skip(db.skip);
  for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_aggregator.sql', 'portfolio_decision.sql']) db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  db.sql(`insert into auth.users (id, email) values ('${OP}', 'op@edgedesk.test');`);
  const rest = REST.make(db, { tokens: { e2e: OP } });
  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { db.stop(); site.srv.close(); skip('no Chromium'); }
  }

  /* what the shipped function does on the database side, through the same service functions */
  const fnCalls = [], ssPages = [];
  function linkBook() {
    const up = JSON.parse(one(db.service(`select public.portfolio_svc_ag_account_upsert('sharpsports', 'sandbox', ${L(OP)}, 'BACT_e2e0001', 'draftkings', 'DraftKings',
        ${L(JSON.stringify({ verified: true, access: true, paused: false, book: { name: 'DraftKings' }, region: { name: 'DraftKings Ohio' } }))}::jsonb);`)));
    const slips = [
      { id: 'SLIP_e2e01', type: 'single', oddsAmerican: -110, atRisk: 11000, toWin: 10000, status: 'completed', outcome: 'win', netProfit: 10000, timePlaced: '2026-10-05T16:00:00Z',
        timeClosed: '2026-10-05T20:00:00Z', bets: [{ proposition: 'spread', position: 'Miami Dolphins', line: 4.5, event: { league: 'NFL', startTime: '2026-10-05T17:00:00Z',
          contestantHome: { fullName: 'Kansas City Chiefs' }, contestantAway: { fullName: 'Miami Dolphins' } } }] },
      { id: 'SLIP_e2e02', type: 'single', oddsAmerican: 140, atRisk: 2500, toWin: 3500, status: 'pending', timePlaced: '2026-10-14T13:00:00Z',
        bets: [{ proposition: 'moneyline', position: 'Ohio State', event: { league: 'NCAAF', startTime: '2026-10-18T16:00:00Z', contestantHome: { fullName: 'Ohio State' }, contestantAway: { fullName: 'Michigan' } } }] },
      { id: 'SLIP_e2e03', type: 'parlay', oddsAmerican: 264, atRisk: 1000, toWin: 2640, status: 'pending', timePlaced: '2026-10-14T14:00:00Z',
        bets: [{ proposition: 'moneyline', position: 'Kansas City Chiefs', oddsAmerican: -150, status: 'completed', outcome: 'win', event: { league: 'NFL', contestantHome: { fullName: 'Kansas City Chiefs' }, contestantAway: { fullName: 'Miami Dolphins' } } },
          { proposition: 'total', position: 'Over', line: 47.5, oddsAmerican: -110, status: 'pending', event: { league: 'NFL', contestantHome: { fullName: 'Buffalo Bills' }, contestantAway: { fullName: 'New York Jets' } } }] }];
    const norm = K.sharpsportsNormalize(slips, { platform: 'draftkings' });
    const run = one(db.service(`select public.portfolio_svc_run_begin(${L(up.account_id)}, 'INITIAL');`));
    const tot = JSON.parse(one(db.service(`select public.portfolio_svc_ingest_wagers(${L(up.account_id)}, ${L(run)}, ${L(JSON.stringify({ positions: norm.positions, fetched: 2 }))}::jsonb);`)));
    db.service(`select public.portfolio_svc_run_finish(${L(run)}, 'SUCCEEDED', null, null, '{"v":1}', '{"ok":true}'::jsonb);`);
    return { ok: true, environment: 'sandbox', accounts: [{ account_id: up.account_id, platform: 'draftkings', label: 'DraftKings', created: up.created, verified: true, access: true }],
      issues: [], synced: [{ account_id: up.account_id, status: 'SUCCEEDED', totals: tot }] };
  }
  function fn(body) {
    if (body.action === 'ss_status') return { ok: true, available: true, environment: 'sandbox', operator: true, provider: { what_the_reader_gives: K.SHARPSPORTS.what_the_reader_gives } };
    if (body.action === 'ss_books') return { ok: true, environment: 'sandbox', books: [{ name: 'DraftKings', abbr: 'dk', status: 'active', sdk_required: false, platform: 'draftkings', label: 'DraftKings' },
      { name: 'FanDuel', abbr: 'fd', status: 'active', sdk_required: false, platform: 'fanduel', label: 'FanDuel' },
      { name: 'Ohio Super Book', abbr: 'zz', status: 'active', sdk_required: true, platform: 'custom_ohio_super_book', label: 'Ohio Super Book' }] };
    if (body.action === 'ss_link') return { ok: true, url: 'https://ui.sharpsports.io/link/CTX_e2e1', environment: 'sandbox' };
    if (body.action === 'ss_discover') return linkBook();
    if (body.action === 'ss_refresh') return { ok: true, status: 'ACCEPTED', message: 'SharpSports is reading your book now. New bets appear here when it finishes — usually within a few minutes.' };
    if (body.action === 'sync') return { ok: true, status: 'SUCCEEDED', totals: { positions_inserted: 0, positions_updated: 0 } };
    return { ok: false, reason: 'unknown_action' };
  }
  async function open(viewport, url) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((uid) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: uid, email: 'op@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, OP);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = req.url();
      if (u.indexOf('127.0.0.1') >= 0) return route.continue();
      /* SharpSports' linking page, stood in: the reader "links" and is sent back to the redirect URL */
      if (/^https:\/\/ui\.sharpsports\.io\//.test(u)) {
        ssPages.push(u);
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>SharpSports</title><p>Linking…</p><script>setTimeout(function () { location.href = '
          + JSON.stringify('http://127.0.0.1:' + site.port + '/app.html?betsync=return#portfolio/accounts') + '; }, 50);</script>' });
      }
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(u);
      if (/supabase\.co\/rest\/v1\/rpc\/ed_track/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      if (/supabase\.co\/functions\/v1\/portfolio_connect/.test(u)) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) { body = {}; }
        fnCalls.push(body);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fn(body)) });
      }
      if (m && /^(rpc\/portfolio_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const token = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', token);
        return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body == null ? '' : JSON.stringify(out.body) });
      }
      if (/supabase\.co/.test(u)) {
        if (/\/user_preferences/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ user_id: OP, onboarding_status: 'completed', leagues: ['nfl'], books: [], interests: [] }]) });
        if (/\/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    page.on('dialog', (d) => d.accept());
    await page.goto(url || `http://127.0.0.1:${site.port}/app.html#portfolio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page) => page.evaluate(() => document.getElementById('pfoHost').innerText);
  const waitText = (page, re, ms) => page.waitForFunction((a) => new RegExp(a[0], a[1]).test(document.getElementById('pfoHost').innerText), [re.source, re.flags], { timeout: ms || 15000 });
  const tab = async (page, v) => { await page.click(`#pfoHost .pfo-tab[data-v="${v}"]`); await page.waitForTimeout(200); };
  async function noSideways(page, label) {
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    chk(label + ': nothing scrolls sideways', w.sw <= w.w + 1, w);
  }

  try {
    let { ctx, page, errors } = await open({ width: 1280, height: 900 });
    await tab(page, 'accounts');
    await waitText(page, /Connect a sportsbook/i);
    await waitText(page, /Ohio Super Book/);
    let t = await text(page);
    chk('Accounts offers "Connect a sportsbook" through BetSync, with the sandbox warning', /Connect a sportsbook/i.test(t) && /Sandbox: SharpSports test accounts only/.test(t));
    chk('the books SharpSports lists, an app-only book disabled', /DraftKings/.test(t) && /FanDuel/.test(t)
      && await page.$eval('#pfoHost [data-act="ss-pick"][data-v="custom_ohio_super_book"]', (b) => b.disabled));
    chk('EdgeDesk shows no field for a sportsbook username or password', await page.evaluate(() => !document.querySelector('#pfoHost input[type="password"], #pfoHost [name="password"], #pfoHost [name="username"]')));
    await page.click('#pfoHost [data-act="ss-pick"][data-v="draftkings"]');
    await page.waitForTimeout(100);
    chk('picking a book names it on the button', /Connect DraftKings/.test(await page.$eval('#pfoHost [data-r="betsync"] [data-act="ss-link"]', (b) => b.innerText)));
    await Promise.all([page.waitForRequest(/^https:\/\/ui\.sharpsports\.io\//, { timeout: 20000 }).catch(() => null),
      page.click('#pfoHost [data-r="betsync"] [data-act="ss-link"]')]);
    await page.waitForURL(/betsync=return/, { timeout: 20000 }).catch(() => null);
    chk('Connect asks EdgeDesk\'s server for a link (with the way back to this app), and the browser goes to SharpSports\' own page',
      fnCalls.some((c) => c.action === 'ss_link' && /^http:\/\/127\.0\.0\.1:\d+\/app\.html$/.test(c.return_to || '')) && ssPages[0] === 'https://ui.sharpsports.io/link/CTX_e2e1', { fnCalls, ssPages });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    await waitText(page, /DraftKings — verified/, 20000);
    t = await text(page);
    chk('back from SharpSports: DraftKings verified, with its first sync', /DraftKings — verified · first sync succeeded: 3 new bets/.test(t), t.slice(0, 600));
    chk('the return marker is gone from the address', await page.evaluate(() => !/betsync=return/.test(location.search) && /portfolio\/accounts/.test(location.hash)));
    await waitText(page, /BetSync \(SharpSports\) · sandbox/);
    t = await text(page);
    chk('the account: BetSync (SharpSports) · sandbox, Connected, verified with its book and region, last synced',
      /BetSync \(SharpSports\) · sandbox/.test(t) && /\bConnected\b/i.test(t) && /SharpSports: verified · DraftKings · DraftKings Ohio/.test(t) && /Last synced/i.test(t),
      t.slice(Math.max(0, t.search(/your platforms/i)), Math.max(0, t.search(/your platforms/i)) + 700));
    chk('it offers Refresh from book, Sync now and Disconnect', await page.evaluate(() => ['ss-refresh', 'acct-sync', 'acct-disconnect'].every((a) => !!document.querySelector('#pfoHost [data-act="' + a + '"]'))));
    await page.click('#pfoHost [data-act="ss-refresh"]');
    await page.waitForTimeout(400);
    chk('a refresh says SharpSports is reading the book', /SharpSports is reading your book now/.test(await page.evaluate(() => document.body.innerText)));
    await tab(page, 'open');
    await waitText(page, /Ohio State/);
    t = await text(page);
    chk('Open shows the synced pending bets, a parlay with each leg and its state', /Ohio State/.test(t) && /Over 47\.5/.test(t)
      && await page.evaluate(() => !!document.querySelector('#pfoHost [data-r="legs"] .pfo-leg-st.WON')));
    await tab(page, 'history');
    await waitText(page, /Dolphins/);
    t = await text(page);
    chk('History shows the synced settled bet, marked Synced', /Miami Dolphins \+4\.5/.test(t) || /Dolphins/.test(t));
    chk('the positions are the real rows: the database derived +$100 on the synced win', one(db.sql(`select profit_loss::text from public.portfolio_positions where external_position_id = 'sharpsports:SLIP_e2e01';`)) === '100');
    await tab(page, 'analytics');
    await waitText(page, /Bankroll trend/i, 20000);
    t = await text(page);
    chk('Analytics draws the bankroll trend from the server, with the drawdown', /Bankroll trend/i.test(t) && /Largest drawdown/i.test(t)
      && await page.evaluate(() => !!document.querySelector('#pfoHost [data-r="bankroll"]')));
    await noSideways(page, '1280px Accounts');
    chk('no page errors (desktop)', errors.length === 0, errors);
    await ctx.close();

    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await tab(page, 'accounts');
    await waitText(page, /Connect a sportsbook/i);
    await waitText(page, /BetSync \(SharpSports\)/);
    await noSideways(page, '390px Accounts with BetSync');
    chk('no page errors (phone)', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    chk('unexpected failure', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    try { await browser.close(); } catch (_) { /* closed */ }
    site.srv.close();
    db.stop();
  }
  done();
}());
