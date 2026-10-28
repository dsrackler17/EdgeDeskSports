#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK BOUGHT THROUGH JUICE REEL, IN A REAL BROWSER, ON OUR SIDE OF IT.

   Juice Reel's hosted checkout and the Supabase project are the two things this
   repository cannot run, so both are stood in for at the network edge and
   everything between them is the shipped page:

     1  the landing page shows the Juice Reel partnership; with the server's
        switch OFF it offers no Juice Reel checkout at all
     2  switch ON: "Get EdgeDesk on Juice Reel" → sign up → the function's
        checkout URL on www.juicereel.com (never the card trial's terms, and no
        renewal consent is recorded for a purchase Stripe will not make)
     3  Juice Reel sends the buyer to oauth/juicereel-subscribe.html with
        ?status=success&code&state; the page strips them from the address,
        hands them to the app in this tab, and the app sends them to the server
     4  the server's answer opens the terminal; Settings says it is billed
        through Juice Reel, with no Stripe portal and no Stripe price; the
        account menu (and, from 600 px, the header) offers a way back to
        Juice Reel, which nobody else is shown
     5  a locked reader sees Juice Reel first, the card trial still offered
        below it, and can link a Juice Reel purchase made elsewhere
     6  a cancelled checkout is told not to pay again; switch OFF leaves the
        paywall exactly as before

   What the server does with the code (the exchange, Juice Reel's answer, the
   database) is tools/billing/juicereel_billing.test.js's to prove.

   Needs Playwright + Chromium (skips cleanly without). Run by hand:
     node tools/billing/juicereel_checkout.e2e.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const SB = 'https://iattxbkbufslbauoumga.supabase.co';
const UID = '0e2e0000-0000-4000-8000-0000000000a1';
const EMAIL = 'jrbuyer@example.com';
const CODE = 'jrc_e2e_code_123';

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });
async function eventually(cond, ms) { const until = Date.now() + (ms || 8000); while (Date.now() < until) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return cond(); }

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const JWT = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, email: EMAIL, role: 'authenticated', exp: 4102444800 }) + '.sig';
const SESSION = { access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id: UID, email: EMAIL } };

/* The Supabase project, as far as this flow touches it: the juicereel_billing
   function (health, status, start, complete) and the one access decision. */
function supabase(state) {
  const until = new Date(Date.now() + 30 * 864e5).toISOString();
  const row = () => (state.paid ? { status: 'active', price_id: 'juicereel', current_period_end: until, cancel_at_period_end: false, stripe_customer_id: null } : null);
  return async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/signup' || u.pathname === '/auth/v1/token') return json(200, SESSION);
    if (u.pathname === '/functions/v1/juicereel_billing') {
      if (req.method() === 'GET') return json(200, { ok: true, mode: state.mode, ready: true });
      const b = JSON.parse(req.postData() || '{}');
      state.fn.push(b);
      const on = state.mode === 'on';
      if (b.action === 'status') return json(200, { ok: true, mode: state.mode, available: on, linked: state.paid, access: { has_access: state.paid } });
      if (b.action === 'start') {
        if (!on) return json(403, { ok: false, reason: 'off', message: 'Subscribing through Juice Reel is not open yet.' });
        return json(200, { ok: true, kind: b.kind, url: 'https://www.juicereel.com/checkout/sessions/e2e-' + b.kind });
      }
      if (b.action === 'complete') {
        if (b.state !== state.issuedState) return json(400, { ok: false, reason: 'JR_STATE_INVALID', message: 'not matched' });
        if (b.error) return json(200, { ok: true, kind: 'checkout', outcome: 'cancelled' });
        if (b.code === CODE) { state.paid = true; return json(200, { ok: true, kind: 'checkout', outcome: 'active', display_name: 'JR Buyer', access: { has_access: true } }); }
        return json(400, { ok: false, reason: 'JR_CODE_INVALID', message: 'code' });
      }
      return json(400, { ok: false, reason: 'unknown_action' });
    }
    if (u.pathname.indexOf('/functions/v1/') === 0) return json(404, { error: 'not deployed here' });
    if (u.pathname === '/rest/v1/billing_consents' && req.method() === 'POST') { state.consents.push(1); return json(201, null); }
    if (u.pathname === '/rest/v1/rpc/my_billing_access') {
      return json(200, { signed_in: true, user_id: UID, has_access: state.paid, reason: state.paid ? 'active' : 'no_subscription',
        row_exists: state.paid, offer: state.paid ? 'none' : 'trial', should_sync: false, tier: null, bet_checker_paid: state.paid, subscription: row() });
    }
    if (u.pathname === '/rest/v1/subscriptions') return json(200, state.paid ? [row()] : []);
    if (u.pathname.indexOf('/rest/v1/rpc/') === 0) return json(200, null);
    return json(200, []);
  };
}

async function open(browser, base, opts) {
  const state = { mode: opts.mode, paid: !!opts.paid, fn: [], consents: [], jr: [], issuedState: 'e2eStateAbcdefghijklmnopqrstuvwxyz0123456789' };
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 900 } });
  if (opts.signedIn) await ctx.addInitScript((s) => { try { localStorage.setItem('edgedesk_session', s); } catch (_) {} }, JSON.stringify(SESSION));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(SB + '/**', supabase(state));
  /* Juice Reel's hosted checkout, stood in for: record where the buyer was
     sent, then do what Juice Reel does after payment and consent */
  await page.route('https://www.juicereel.com/**', (route) => {
    const to = route.request().url();
    state.jr.push(to);
    const back = base + '/oauth/juicereel-subscribe.html?' + (opts.cancel ? 'status=cancelled' : 'status=success&code=' + CODE) + '&state=' + state.issuedState;
    return route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><title>Juice Reel checkout (stand-in)</title><script>location.href=' + JSON.stringify(back) + '</script>' });
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|iattxbkbufslbauoumga\.supabase\.co|www\.juicereel\.com)/, (r) => r.abort());
  return { ctx, page, state, errors };
}
/* the way back to Juice Reel: the header chip, and the account menu's item */
const jrBack = (page) => page.evaluate(() => {
  const a = document.getElementById('edJrBack'), m = document.getElementById('avJr');
  return { chip: !!a && getComputedStyle(a).display !== 'none', menu: !!m && getComputedStyle(m).display !== 'none',
    href: a && a.getAttribute('href'), target: a && a.target, rel: a && a.rel };
});
const gateOn = (page) => page.evaluate(() => { const g = document.getElementById('payGate'); return !!(g && g.classList.contains('on')); });
const gateText = (page) => page.evaluate(() => { const g = document.querySelector('#payGate .pg-card'); return g ? g.innerText : ''; });

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  // SKIPPED is not passed: CI sets JUICEREEL_UI_REQUIRED so a missing browser fails
  const SKIP = process.env.JUICEREEL_UI_REQUIRED === '1' ? 1 : 0;
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(SKIP); }
  const site = await serve(siteHandler);
  const base = 'http://127.0.0.1:' + site.port;
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(SKIP); }
  }

  try {
    /* ── 1. the landing page, switch OFF ───────────────────────────────── */
    {
      console.log('\nlanding page, Juice Reel switch OFF');
      const { ctx, page, errors } = await open(browser, base, { mode: 'off' });
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const band = await page.evaluate(() => { const b = document.getElementById('juicereel'); return b ? b.innerText : ''; });
      chk('1 the landing page shows the partnership: EdgeDesk × Juice Reel, "working with Juice Reel"', /EdgeDesk\s*×\s*Juice Reel/.test(band) && /working with Juice Reel/.test(band), band);
      chk('  and links to juicereel.com', await page.evaluate(() => !!document.querySelector('#juicereel a[href="https://www.juicereel.com/"][rel="noopener"]')));
      chk('  switch OFF: no Juice Reel checkout line or button is shown', !(await page.isVisible('#jrAct')) && !(await page.isVisible('#jrLive')) && !(await page.isVisible('#jrBtn')));
      chk('  no script errors', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ── 2-4. switch ON: landing → sign up → Juice Reel → back → terminal ─ */
    for (const width of [390, 1280]) {
      console.log('\n' + width + 'px, Juice Reel switch ON, a new reader');
      const { ctx, page, state, errors } = await open(browser, base, { mode: 'on', width });
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await eventually(() => page.isVisible('#jrBtn'), 6000);
      chk('2 switch ON: the partner band shows "Get EdgeDesk on Juice Reel"', (await page.isVisible('#jrBtn')) && /Get EdgeDesk on Juice Reel/.test(await page.innerText('#jrBtn')));
      chk('  and says Juice Reel shows the plan and price, and bills it', /shows the plan and price before you pay, and bills and renews it/.test(await page.textContent('#jrLive')));
      chk('  the card trial is still offered exactly as before', /7 days free/.test(await page.textContent('.pcard:not(.freecard)')));
      await page.click('#jrBtn');
      await page.waitForSelector('#authModal.on');
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'aEmail');
      await page.fill('#aEmail', EMAIL);
      await page.fill('#aPass', 'correct horse battery staple');
      await page.check('#aConsent');
      await page.click('#authSubmit');
      await page.waitForURL(/\/app\.html/, { timeout: 30000 });
      chk('  after sign-up the buyer went to Juice Reel\'s checkout URL the function gave', state.jr.length === 1 && state.jr[0] === 'https://www.juicereel.com/checkout/sessions/e2e-checkout', state.jr);
      chk('  the card trial\'s renewal terms never opened, and no consent was recorded', state.consents.length === 0 && state.fn.some((b) => b.action === 'start' && b.kind === 'checkout'));
      await eventually(async () => !(await gateOn(page)) && state.paid, 20000);
      const done = state.fn.find((b) => b.action === 'complete') || {};
      chk('3 back through oauth/juicereel-subscribe.html, the app sent the state and code to the server', done.state === state.issuedState && done.code === CODE, done);
      chk('  and the code and state left the address bar', !/code=|state=|jrsub=/.test(page.url()), page.url());
      chk('  and the tab\'s hand-off is gone', await page.evaluate(() => sessionStorage.getItem('edgedesk.jr.subscribe') === null));
      chk('4 the server\'s answer opened the terminal: the paywall is shut', !(await gateOn(page)));
      const card = await eventually(() => page.evaluate(() => typeof renderSetSub === 'function' && window.SUB && window.SUB.price_id === 'juicereel'), 15000)
        ? await page.evaluate(() => renderSetSub().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) : '';
      chk('  Settings: billed through Juice Reel, managed on Juice Reel', /Billed through .*Juice Reel bills and renews it Juice Reel Paid through/.test(card) && /Manage on Juice Reel/.test(card), card.slice(0, 300));
      chk('  and no Stripe price, charge or portal is claimed for it', !/billing portal|You will be charged|\/ month/.test(card), card.slice(0, 300));
      const back = await jrBack(page);
      chk('  a way back to Juice Reel: "Back to Juice Reel" in the account menu' + (width >= 600 ? ', and the header chip' : ' (the phone header has no room for the chip)'),
        back.menu && back.chip === (width >= 600) && back.href === 'https://www.juicereel.com/' && back.target === '_blank' && /noopener/.test(back.rel), back);
      chk('  no script errors on the way', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ── an abandoned Juice Reel click never hijacks the card trial ──────── */
    {
      console.log('\nlanding page, switch ON, a Juice Reel intent left from an abandoned click');
      const { ctx, page, state, errors } = await open(browser, base, { mode: 'on', signedIn: true });
      await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('edgedesk_pending_jr', '1'); sessionStorage.setItem('seeded', '1'); } } catch (_) {} });
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await eventually(() => page.evaluate(() => !document.getElementById('jrAct').hidden), 6000);
      await page.click('#subBtn');
      await page.waitForSelector('#arlModal.on', { timeout: 10000 }).catch(() => null);
      chk('  the card-trial button opens the card trial\'s terms, not Juice Reel', await page.evaluate(() => document.getElementById('arlModal').classList.contains('on'))
        && !state.fn.some((b) => b.action === 'start') && state.jr.length === 0);
      chk('  and the stale Juice Reel intent is gone', await page.evaluate(() => localStorage.getItem('edgedesk_pending_jr') === null));
      chk('  no script errors', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ── 5. a locked reader, switch ON ──────────────────────────────────── */
    {
      console.log('\napp paywall, signed in, not subscribed, switch ON');
      const { ctx, page, state, errors } = await open(browser, base, { mode: 'on', signedIn: true });
      await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
      await eventually(() => gateOn(page), 20000);
      const t = await gateText(page);
      const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#payGate .pg-card .pg-btn')).map((b) => ({ t: b.innerText.trim(), ghost: b.classList.contains('ghost') })));
      chk('5 the paywall offers Subscribe with Juice Reel first, as the primary button', btns[0] && /Subscribe with Juice Reel/.test(btns[0].t) && !btns[0].ghost, btns.slice(0, 4));
      chk('  then "I bought EdgeDesk on Juice Reel — link my account"', btns[1] && /I bought EdgeDesk on Juice Reel/.test(btns[1].t), btns.slice(0, 4));
      chk('  and still the card trial, as a secondary button', btns.some((b) => /days free/.test(b.t) && b.ghost), btns);
      chk('  no way back to Juice Reel for a reader who did not come from it', await jrBack(page).then((x) => !x.chip && !x.menu));
      chk('  saying Juice Reel shows the plan and price and bills it', /secure checkout shows the plan and price before you pay/.test(t) && /Through Juice Reel: billed, renewed and cancelled on Juice Reel/.test(t), t.slice(0, 500));
      await page.click('text=I bought EdgeDesk on Juice Reel');
      await eventually(() => state.jr.length > 0, 8000);
      chk('  "link my account" goes to Juice Reel through the function (kind link)', state.fn.some((b) => b.action === 'start' && b.kind === 'link') && /^https:\/\/www\.juicereel\.com\//.test(state.jr[0] || ''), state.jr);
      chk('  no script errors', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ── 6. cancelled, and switch OFF ───────────────────────────────────── */
    {
      console.log('\na cancelled Juice Reel checkout');
      const { ctx, page, state, errors } = await open(browser, base, { mode: 'on', signedIn: true, cancel: true });
      await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
      await eventually(() => gateOn(page), 20000);
      await page.click('#payGate .pg-card .pg-btn');
      await page.waitForURL(/\/app\.html/, { timeout: 30000 });
      await eventually(async () => /do not pay again/i.test(await gateText(page)), 20000);
      const t = await gateText(page);
      chk('6 a cancelled checkout: nothing opened, and a payer is told not to pay again and how to link', /was cancelled/.test(t) && /do not pay again/i.test(t) && /I bought EdgeDesk on Juice Reel/.test(t) && !state.paid, t.slice(0, 400));
      chk('  no script errors', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    {
      console.log('\napp paywall, switch OFF');
      const { ctx, page, errors } = await open(browser, base, { mode: 'off', signedIn: true });
      await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
      await eventually(() => gateOn(page), 20000);
      const btns = await page.evaluate(() => Array.from(document.querySelectorAll('#payGate .pg-card .pg-btn')).map((b) => ({ t: b.innerText.trim(), ghost: b.classList.contains('ghost') })));
      chk('  switch OFF: no way back to Juice Reel either', await jrBack(page).then((x) => !x.chip && !x.menu));
      chk('  switch OFF: no Juice Reel button, and the card trial is the primary button as before', !btns.some((b) => /Juice Reel/.test(b.t)) && /days free/.test(btns[0].t) && !btns[0].ghost, btns.slice(0, 3));
      chk('  no script errors', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    {
      console.log('\nthe callback page with nothing to finish');
      const { ctx, page } = await open(browser, base, { mode: 'on' });
      await page.goto(base + '/oauth/juicereel-subscribe.html', { waitUntil: 'domcontentloaded' });
      chk('  says there is nothing to finish and stays put', /Nothing to finish/.test(await page.textContent('#title')) && /juicereel-subscribe\.html$/.test(page.url()));
      await ctx.close();
    }
  } finally {
    await browser.close();
    site.srv.close();
  }
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | juicereel checkout | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
