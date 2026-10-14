#!/usr/bin/env node
/* ===========================================================================
   JUICE REEL IN CHROMIUM — the whole browser round trip, in the shipped
   app.html and the shipped oauth/juicereel-callback.html, with the SHIPPED
   portfolio_connect function (in a stub Deno) over the real migrations, and
   a fake Juice Reel (tools/portfolio/_fake_juicereel.js) whose consent page
   sends the browser back to the redirect URI as Juice Reel documents.

     a reader, before Juice Reel approves EdgeDesk: "Awaiting provider
       approval", the Connect button disabled — no way to start linking;
     the operator (under a running PRODUCTION smoke test): Not connected →
       Connect Juice Reel → Juice Reel's page (the browser leaves EdgeDesk) →
       the callback page → back in Accounts: connected as the Juice Reel
       user, the first sync in words, Connected; the address carries no code,
       state or return marker, and nothing is left in sessionStorage;
     each book a "Juice Reel sync" account; the synced bets in Open and
       History; Sync now; a refused consent said plainly; Disconnect →
       Disconnected, history kept;
   at 1280 px and at 390 px, with no sideways scroll and no page error.

   Run: node tools/portfolio/juicereel_ui.e2e.js
   (PORTFOLIO_UI_REQUIRED=1 makes a missing Playwright or PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');
const FAKE = require('./_fake_juicereel.js');

const ROOT = PG.ROOT;
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const OP = 'e7e46801-80c4-4f47-b718-4aff211c8d3a';   // an operator (portfolio_is_admin's fallback)
const B = '00000000-0000-0000-0000-00000000000b';
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | juicereel UI e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
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
  const db = PG.start('jrui');
  if (db.skip) skip(db.skip);
  for (const f of ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_aggregator.sql', 'portfolio_decision.sql', 'portfolio_juicereel.sql']) db.applyFileAtomic(path.join(ROOT, 'supabase', f));
  db.sql(`insert into auth.users (id, email) values ('${OP}', 'op@edgedesk.test'), ('${B}', 'b@edgedesk.test');`);
  const TOKENS = { e2e: OP, 'e2e-b': B };
  const SERVICE = 'service-role-key-for-tests', SB = 'https://iattxbkbufslbauoumga.supabase.co';
  const rest = REST.make(db, { tokens: Object.assign({ [SERVICE]: 'service_role' }, TOKENS) });
  const site = await serve(siteHandler);
  const ORIGIN = 'http://127.0.0.1:' + site.port, REDIRECT = ORIGIN + '/oauth/juicereel-callback.html';
  const J = FAKE.make({ pageSize: 2, redirects: [REDIRECT] });
  const u4 = J.user(4, 'Sharp Bettor');
  u4.bets.push(FAKE.bet(501, { result: 'Won', netResult: 100, dateClosed: '2026-10-05T20:00:00.000Z', datePlaced: '2026-10-05T16:00:00.000Z',
      Subbets: [FAKE.subbet({ type: 'Spread', position: 'Miami Dolphins', value: 4.5, home: 'Kansas City Chiefs', away: 'Miami Dolphins', league: 'NFL', sport: 'Football', result: 'Won' })] }),
    FAKE.bet(502, { oddsAmerican: 140, amountRisked: 25, toWin: 35, datePlaced: '2026-10-14T13:00:00.000Z', Site: { id: 20, name: 'FanDuel' },
      Subbets: [FAKE.subbet({ position: 'Ohio State', home: 'Ohio State', away: 'Michigan', league: 'NCAAF', sport: 'Football', start: '2026-10-18T16:00:00.000Z' })] }),
    FAKE.bet(503, { BetType: { id: 2, typeName: 'Parlay' }, oddsAmerican: 264, amountRisked: 10, toWin: 26.4, datePlaced: '2026-10-14T14:00:00.000Z',
      Subbets: [FAKE.subbet({ id: 1, position: 'Kansas City Chiefs', home: 'Kansas City Chiefs', away: 'Miami Dolphins', league: 'NFL', sport: 'Football', result: 'Won', odds: -150 }),
        FAKE.subbet({ id: 2, type: 'Total', position: 'Over', value: 47.5, home: 'Buffalo Bills', away: 'New York Jets', league: 'NFL', sport: 'Football', eventId: 430 })] }));
  db.service(`select public.portfolio_svc_ag_smoke_begin('juicereel', 'production', 'e2e');`);

  /* the shipped function, in a stub Deno; its network is the test's */
  const logs = [];
  async function fnFetch(url, init) {
    init = init || {};
    const u = new URL(url), h = init.headers || {}, auth = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
    if (u.origin === SB && u.pathname === '/auth/v1/user') return TOKENS[auth] ? new Response(JSON.stringify({ id: TOKENS[auth] }), { status: 200 }) : new Response('{}', { status: 401 });
    if (u.origin === SB && u.pathname.indexOf('/rest/v1/') === 0) {
      const out = rest.handle(init.method || 'GET', decodeURIComponent(u.pathname.slice('/rest/v1/'.length)), u.search.slice(1), init.body ? JSON.parse(init.body) : null, h.prefer || '', auth);
      return new Response(out.body == null ? '' : JSON.stringify(out.body), { status: out.status });
    }
    if (u.hostname === 'external-api.juicereel.com') return J.fetch(u, init);
    throw new Error('no network: ' + url);
  }
  let handler = null;
  const env = { SB_URL: SB, SB_SERVICE_ROLE: SERVICE, SUPABASE_ANON_KEY: 'anon', PORTFOLIO_CREDENTIAL_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 5).toString('base64') }),
    PORTFOLIO_CREDENTIAL_KEY_VERSION: '1', JUICE_REEL_CLIENT_ID: J.clientId, JUICE_REEL_CLIENT_SECRET: J.clientSecret, JUICE_REEL_REDIRECT_URI: REDIRECT,
    SPORTSBOOK_SYNC_PROVIDER: 'juicereel' };
  const sandbox = { Deno: { env: { get: (k) => env[k] }, serve: (x) => { handler = x; } }, fetch: fnFetch, Response, Request, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, btoa, atob, AbortController, setTimeout, clearTimeout, console: { log: (x) => logs.push(String(x)), error: (x) => logs.push(String(x)) } };
  sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'portfolio_connect', 'index.ts'), 'utf8'), sandbox);

  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { db.stop(); site.srv.close(); skip('no Chromium'); }
  }
  const fnCalls = [], consent = [];
  let denyNext = false;
  async function open(viewport, token, uid, url) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((a) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: a.token, refresh_token: a.token, expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: a.uid, email: 'x@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, { token, uid });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = req.url();
      /* the site itself (by host: the consent URL carries 127.0.0.1 inside its redirect_uri) */
      if (new URL(u).hostname === '127.0.0.1') return route.continue();
      /* Juice Reel's consent page, stood in: the user approves (or refuses) and is sent to the redirect URI */
      if (/^https:\/\/www\.juicereel\.com\/oauth2\/authorize\?/.test(u)) {
        consent.push(u);
        const q = new URL(u).searchParams, a = denyNext ? null : J.approve(u, 4);
        const back = denyNext ? q.get('redirect_uri') + '?error=access_denied&state=' + encodeURIComponent(q.get('state'))
          : a.redirect + '?code=' + encodeURIComponent(a.code) + '&state=' + encodeURIComponent(a.state);
        denyNext = false;
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Juice Reel</title><p>Authorize EdgeDesk…</p><script>setTimeout(function () { location.href = '
          + JSON.stringify(back) + '; }, 50);</script>' });
      }
      if (/supabase\.co\/functions\/v1\/portfolio_connect/.test(u)) {
        const body = req.postData() || '{}';
        try { fnCalls.push(JSON.parse(body).action); } catch (_) { /* not JSON */ }
        const r = await handler(new Request('https://fn.local/portfolio_connect', { method: req.method(), headers: { 'content-type': 'application/json', authorization: req.headers().authorization || '' },
          body: req.method() === 'POST' ? body : undefined }));
        return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
      }
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(u);
      if (/supabase\.co\/rest\/v1\/rpc\/ed_track/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      if (m && /^(rpc\/portfolio_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const tok = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', tok);
        return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body == null ? '' : JSON.stringify(out.body) });
      }
      if (/supabase\.co/.test(u)) {
        if (/\/user_preferences/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ user_id: uid, onboarding_status: 'completed', leagues: ['nfl'], books: [], interests: [] }]) });
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
    await page.goto(url || ORIGIN + '/app.html#portfolio', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page) => page.evaluate(() => document.getElementById('pfoHost').innerText);
  const jrText = (page) => page.evaluate(() => { const s = document.querySelector('#pfoHost [data-r="juicereel"]'); return s ? s.innerText : ''; });
  const waitJr = (page, re, ms) => page.waitForFunction((a) => { const s = document.querySelector('#pfoHost [data-r="juicereel"]'); return !!s && new RegExp(a[0], a[1]).test(s.innerText); }, [re.source, re.flags], { timeout: ms || 20000 });
  const waitText = (page, re, ms) => page.waitForFunction((a) => new RegExp(a[0], a[1]).test(document.getElementById('pfoHost').innerText), [re.source, re.flags], { timeout: ms || 15000 });
  const tab = async (page, v) => { await page.click(`#pfoHost .pfo-tab[data-v="${v}"]`); await page.waitForTimeout(250); };
  async function noSideways(page, label) {
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    chk(label + ': nothing scrolls sideways', w.sw <= w.w + 1, w);
  }

  try {
    /* ── a reader, before approval ── */
    let { ctx, page, errors } = await open({ width: 1280, height: 900 }, 'e2e-b', B);
    await tab(page, 'accounts');
    await waitJr(page, /Awaiting provider approval/i);
    chk('a reader sees "Awaiting provider approval" and a disabled Connect — there is no way to start linking',
      /awaiting Juice Reel's approval/.test(await jrText(page)) && await page.evaluate(() => { const b = [...document.querySelectorAll('#pfoHost [data-r="juicereel"] button')].find((x) => /Connect Juice Reel/.test(x.innerText)); return !!b && b.disabled && !b.getAttribute('data-act'); }));
    chk('the reader is never shown "Connected" for Juice Reel', !/Connected as|\bConnected\b/.test(await jrText(page)));
    await ctx.close();

    /* ── the operator connects ── */
    ({ ctx, page, errors } = await open({ width: 1280, height: 900 }, 'e2e', OP));
    await tab(page, 'accounts');
    await waitJr(page, /Not connected/i);
    chk('the operator (under the live smoke test) sees "Not connected", the operator note, what EdgeDesk reads, and no password field',
      /Connect Juice Reel to bring in your sportsbook bets/.test(await jrText(page)) && /live smoke test/.test(await jrText(page)) && /open and settled bets/.test(await jrText(page))
        && await page.evaluate(() => !document.querySelector('#pfoHost input[type="password"], #pfoHost [name="password"], #pfoHost [name="username"]')));
    await Promise.all([page.waitForURL(/juicereel=return|juicereel-callback|app\.html/, { timeout: 30000 }).catch(() => null),
      page.click('#pfoHost [data-r="juicereel"] [data-act="jr-connect"]')]);
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    await waitJr(page, /Juice Reel connected as Sharp Bettor/, 40000);
    const consentUrl = new URL(consent[0]);
    chk('Connect sends the browser to Juice Reel\'s own consent page with the exact redirect URI, the two bet scopes and an S256 challenge',
      consent.length === 1 && consentUrl.origin + consentUrl.pathname === 'https://www.juicereel.com/oauth2/authorize' && consentUrl.searchParams.get('redirect_uri') === REDIRECT
        && consentUrl.searchParams.get('scope') === 'bets.open.read bets.settled.read' && consentUrl.searchParams.get('code_challenge_method') === 'S256', consent);
    let t = await jrText(page);
    chk('back through the callback page: connected as the Juice Reel user, and the first sync in words (3 bets, both books)',
      /Juice Reel connected as Sharp Bettor\. First sync: 3 bets imported from DraftKings, FanDuel\./.test(t), t);
    await waitJr(page, /Connected as Sharp Bettor · last synchronized/);
    chk('…the panel then reads Connected, with when it last synchronized, its books and open bets',
      await page.$eval('#pfoHost [data-r="jr-state"]', (e) => e.getAttribute('data-state')) === 'CONNECTED' && /2 sportsbooks · 2 open bets/.test(await jrText(page)), await jrText(page));
    chk('the address carries no code, state or return marker, and nothing is left in sessionStorage', await page.evaluate(() => !/code=|state=|juicereel=return/.test(location.href)
      && /portfolio\/accounts/.test(location.hash) && sessionStorage.getItem('edgedesk.jr.callback') === null));
    chk('the code went to EdgeDesk\'s server once (jr_callback), never to anything else', fnCalls.filter((a) => a === 'jr_callback').length === 1);
    t = await text(page);
    chk('each book is a Juice Reel account, Connected', /DraftKings[\s\S]*Sportsbook · Juice Reel/i.test(t) && /FanDuel[\s\S]*Sportsbook · Juice Reel/i.test(t)
      && /Synced through your Juice Reel connection/i.test(t) && /Connected/i.test(t));
    chk('the positions are the real rows: the database derived +$100 on the synced win', one(db.sql(`select profit_loss::text from public.portfolio_positions where external_position_id = 'juicereel:501';`)) === '100');
    await tab(page, 'open');
    await waitText(page, /Ohio State/);
    t = await text(page);
    chk('Open shows the synced pending bets, the parlay with each leg and its state', /Ohio State/.test(t) && /Over 47\.5/.test(t)
      && await page.evaluate(() => !!document.querySelector('#pfoHost [data-r="legs"] .pfo-leg-st.WON')));
    await tab(page, 'history');
    await waitText(page, /Dolphins/);
    chk('History shows the synced settled bet', /Miami Dolphins \+4\.5/.test(await text(page)));
    await tab(page, 'accounts');
    await waitJr(page, /Sync now/);
    db.sql(`update portfolio_private.oauth_grants set last_sync_at = now() - interval '5 minutes';`);
    await page.click('#pfoHost [data-r="juicereel"] [data-act="jr-sync"]');
    await page.waitForFunction(() => /Synced from Juice Reel/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => null);
    chk('Sync now runs and says what it did', /Synced from Juice Reel: 0 new, 0 updated/.test(await page.evaluate(() => document.body.innerText)));
    await noSideways(page, '1280px Accounts, Juice Reel connected');
    chk('no page errors (desktop)', errors.length === 0, errors);
    await ctx.close();

    /* ── 390 px ── */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, 'e2e', OP));
    await tab(page, 'accounts');
    await waitJr(page, /Connected as Sharp Bettor/);
    await noSideways(page, '390px Accounts, Juice Reel connected');
    chk('no page errors (phone)', errors.length === 0, errors);

    /* ── disconnect, then a refused consent ── */
    await page.click('#pfoHost [data-r="juicereel"] [data-act="jr-disconnect"]:not([data-delete])');
    await waitJr(page, /Disconnected — your synced history is kept/, 20000);
    chk('Disconnect: revoked at Juice Reel, "Disconnected — your synced history is kept", Connect again offered',
      /Disconnected — your synced history is kept/.test(await jrText(page)) && J.revokes.length === 2 && +db.sql(`select count(*) from public.portfolio_positions where external_position_id like 'juicereel:%';`) === 3
        && !!(await page.$('#pfoHost [data-r="juicereel"] [data-act="jr-connect"]')));
    denyNext = true;
    await page.click('#pfoHost [data-r="juicereel"] [data-act="jr-connect"]');
    await page.waitForFunction(() => !!(window.EDPortfolioUI && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 }).catch(() => null);
    await waitJr(page, /did not authorize/, 40000);
    chk('a refused consent: "You did not authorize EdgeDesk on Juice Reel", still Disconnected, nothing stored',
      /You did not authorize EdgeDesk on Juice Reel, so nothing was connected/.test(await jrText(page)) && one(db.sql(`select status from portfolio_private.oauth_grants;`)) === 'DISCONNECTED');
    await noSideways(page, '390px Accounts, after disconnect');
    chk('no page errors (phone, disconnect and refusal)', errors.length === 0, errors);
    await ctx.close();
    const secretSeen = logs.join('\n').indexOf(J.clientSecret) >= 0 || J.issued.some((s) => logs.join('\n').indexOf(s) >= 0);
    chk('no secret or token in the function\'s log lines', !secretSeen);
  } catch (e) {
    chk('unexpected failure', false, String(e && e.stack || e).slice(0, 1500));
  } finally {
    try { await browser.close(); } catch (_) { /* closed */ }
    site.srv.close();
    db.stop();
  }
  done();
}());
