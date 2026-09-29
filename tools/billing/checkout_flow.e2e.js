#!/usr/bin/env node
/* ===========================================================================
   THE NEW-USER CHECKOUT, IN A REAL BROWSER, ON OUR SIDE OF STRIPE.

   Stripe's hosted checkout and the Supabase project are the two things this
   repository cannot run, so both are stood in for at the network edge and
   everything between them is the shipped page:

     1  a signed-out visitor opens the landing page: $49.99/month is on it
     2  "Start 7 days free" → the signup form → an account
     3  the automatic-renewal terms: $49.99 per month, no founding-rate lock
     4  the consent is recorded BEFORE any checkout, with the figure, the trial,
        the period and the v7 consent version it was given under
     5  the browser goes to the pricing file's CHECKOUT_LINK, carrying the
        account id (client_reference_id) and the email
     6  Stripe sends it back to /?checkout=success; the page waits for the
        webhook's row and opens the terminal
     7  in the terminal, Settings shows EdgeDesk Full Access, the 7-day trial,
        then $49.99/month, and the day the trial ends from the row itself

   And the other half of the same rule: with NO checkout link configured, the
   flow stops at step 4 — nothing recorded, nothing charged, and the visitor is
   told so — and a retired $79.99 link is never navigated to.

   Neither run ever reaches the real Stripe: every buy.stripe.com request is
   answered by the stand-in below, whatever link the pricing file carries.

   The run with a link swaps ONE value in the pricing file as it is served —
   CHECKOUT_LINK — so every other word the page shows is the shipped file's.
   What Stripe itself does (the price, the trial, the product on its page) is
   tools/billing/verify_stripe_offer.js's to prove, against the live account.

   Needs Playwright + Chromium (skips cleanly without). Run by hand:
     node tools/billing/checkout_flow.e2e.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const SB = 'https://iattxbkbufslbauoumga.supabase.co';
const LINK = 'https://buy.stripe.com/e2eTrialLink4999';
const UID = '0e2e0000-0000-4000-8000-00000000c0de';
const EMAIL = 'newreader@example.com';

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); }
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

/* The Supabase project, as far as this flow touches it. `paid` flips when
   "Stripe" sends the visitor back, standing in for the webhook's row. */
function supabase(state) {
  return async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (u.pathname === '/auth/v1/signup' || u.pathname === '/auth/v1/token') return json(200, SESSION);
    if (u.pathname === '/rest/v1/billing_consents' && req.method() === 'POST') { state.consents.push(JSON.parse(req.postData() || '[]')[0]); return json(201, null); }
    if (u.pathname === '/rest/v1/subscriptions') {
      return json(200, state.paid ? [{ status: 'trialing', price_id: null, cancel_at_period_end: false, stripe_customer_id: 'cus_e2e',
        current_period_end: state.trialEnd }] : []);
    }
    if (u.pathname.indexOf('/rest/v1/rpc/') === 0) return json(200, u.pathname.endsWith('my_subscription_price')
      ? [{ unit_amount: X.PRICE_CENTS, currency: 'usd', billing_interval: 'month', interval_count: 1 }] : null);
    return json(200, []);
  };
}

async function run(browser, base, opts) {
  const state = { consents: [], paid: false, stripe: [], trialEnd: new Date(Date.now() + 7 * 864e5).toISOString() };
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(SB + '/**', supabase(state));
  /* Stripe Checkout, stood in for: record where we were sent, then do what
     the payment link's "After payment" redirect does */
  await page.route('https://buy.stripe.com/**', (route) => {
    state.stripe.push(route.request().url());
    state.paid = true;
    return route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><title>Stripe Checkout (stand-in)</title><p>EdgeDesk Full Access</p><script>location.href=' + JSON.stringify(base + '/?checkout=success') + '</script>' });
  });
  if (opts.link != null) {
    await page.route('**/lib/edgedesk_pricing.js*', async (route) => {
      const src = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_pricing.js'), 'utf8');
      const swapped = src.replace(/CHECKOUT_LINK: '[^']*'/, 'CHECKOUT_LINK: ' + JSON.stringify(opts.link));
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: swapped });
    });
  }
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|iattxbkbufslbauoumga\.supabase\.co|buy\.stripe\.com)/, (r) => r.abort());
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  return { ctx, page, state, errors };
}

async function startTrial(page) {
  await page.click('#subBtn');
  await page.waitForSelector('#authModal.on');
  /* openAuth() moves focus to the email field 50 ms after the form opens. A
     browser driven faster than any typist can land its first keystrokes in
     the password box and its next ones in the email box once that focus
     arrives, so wait for it rather than race it. */
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'aEmail');
  await page.fill('#aEmail', EMAIL);
  await page.fill('#aPass', 'correct horse battery staple');
  await page.check('#aConsent');
  await page.click('#authSubmit');
  try { await page.waitForSelector('#arlModal.on', { timeout: 15000 }); }
  catch (e) {
    const why = await page.evaluate(() => ({ auth: (document.getElementById('authMsg') || {}).textContent,
      authOpen: document.getElementById('authModal').classList.contains('on'),
      btn: document.getElementById('authSubmit').disabled, pending: localStorage.getItem('edgedesk_pending_sub'),
      session: !!localStorage.getItem('edgedesk_session') }));
    throw new Error('the renewal-terms screen never opened: ' + JSON.stringify(why));
  }
  await page.check('#arlAgree');
  await page.click('#arlSubmit');
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve(siteHandler);
  const base = 'http://127.0.0.1:' + site.port;
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }

  try {
    /* ── with the $49.99 trial link configured ─────────────────────────── */
    for (const width of [390, 1280]) {
      console.log('\n' + width + 'px, with a checkout link configured');
      const { ctx, page, state, errors } = await run(browser, base, { link: LINK, width });
      const heroText = await page.textContent('#top .microcta');
      chk('1 the signed-out landing page says Then $49.99/month under the hero button', /Then \$49\.99\/month/.test(heroText), heroText);
      chk('  and the plan card says $49.99 / month, 7 days free', (await page.textContent('.pamt')) === '$49.99' && /7 days free/.test(await page.textContent('.pcard')));
      chk('  and nothing on the page says $79.99', !/79\.99/.test(await page.evaluate(() => document.body.innerText)));

      await startTrial(page);
      const terms = await page.evaluate(() => document.getElementById('arlTerms').innerText);
      chk('3 the renewal terms: EdgeDesk Full Access, 7-day free trial, then $49.99 per month', /EdgeDesk Full Access — 7-day free trial, then \$49\.99 per month\./.test(terms), terms.slice(0, 120));
      chk('  and no founding-rate lock is promised', !/founding|locked for the life/i.test(terms));

      await eventually(() => state.stripe.length > 0, 10000);
      const c = state.consents[0] || {};
      chk('4 the consent was recorded before checkout, exactly once', state.consents.length === 1, state.consents.length);
      chk('  with $49.99, 7 days, per month and the v7 terms', c.price_display === '$49.99' && c.trial_days === 7 && c.billing_period === 'month' && c.consent_version === 'arl-2026-09-v7-trial7', c);
      chk('  and the exact words shown, which say $49.99 and not $79.99', /\$49\.99 per month/.test(c.offer_text || '') && !/79\.99/.test(c.offer_text || ''));
      chk('  under the account that consented', c.user_id === UID && c.user_email === EMAIL);
      const to = state.stripe[0] || '';
      chk('5 checkout opened the configured link', to.indexOf(LINK + '?') === 0, to);
      chk('  carrying the account id and the email', new URL(to).searchParams.get('client_reference_id') === UID && new URL(to).searchParams.get('prefilled_email') === EMAIL, to);

      await page.waitForURL(/\/app\.html/, { timeout: 30000 });
      chk('6 back from Stripe, the page waited for the row and opened the terminal', /\/app\.html/.test(page.url()), page.url());
      const settings = await eventually(async () => page.evaluate(() => typeof renderSetSub === 'function' && window.SUB && window.SUB.status === 'trialing'), 20000);
      const card = settings ? await page.evaluate(() => renderSetSub().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) : '';
      const ends = new Date(state.trialEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      chk('7 the terminal reads the trial, and Settings says EdgeDesk Full Access · 7-day free trial · then $49.99/month',
        /EdgeDesk Full Access/.test(card) && /7-day free trial/.test(card) && /Then \$49\.99\/month/.test(card), card.slice(0, 300));
      chk('  with the day the trial ends, from the row', card.indexOf(ends) >= 0 && /Your first charge of \$49\.99/.test(card), card.slice(0, 400));
      chk('  and the paywall stays shut', !(await page.evaluate(() => { const g = document.getElementById('payGate'); return !!(g && g.classList.contains('on')); })));
      chk('  with no script errors on the way', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ── the file exactly as shipped: the link it carries is the one opened ── */
    {
      console.log('\n390px, lib/edgedesk_pricing.js exactly as shipped');
      const { ctx, page, state } = await run(browser, base, {});
      await startTrial(page);
      if (X.checkoutLink('trial')) {
        await eventually(() => state.stripe.length > 0, 10000);
        const to = state.stripe[0] || '';
        chk('the shipped CHECKOUT_LINK is the one opened, with the account id', to.indexOf(X.CHECKOUT_LINK + '?client_reference_id=' + UID) === 0, to);
        chk('after a $49.99 consent, recorded once', state.consents.length === 1 && state.consents[0].price_display === '$49.99', state.consents);
      } else {
        await eventually(async () => /Checkout is being updated/.test(await page.textContent('#arlMsg')), 6000);
        chk('with no link shipped, nothing is recorded and nobody is sent to Stripe', state.consents.length === 0 && state.stripe.length === 0);
      }
      await ctx.close();
    }

    /* ── no link, or a retired one ─────────────────────────────────────── */
    for (const [label, link] of [['no checkout link configured', ''], ['a retired $79.99 link pasted back', X.RETIRED_LINKS[0]]]) {
      console.log('\n390px, ' + label);
      const { ctx, page, state } = await run(browser, base, { link });
      await startTrial(page);
      await eventually(async () => /Checkout is being updated/.test(await page.textContent('#arlMsg')), 6000);
      const m = await page.textContent('#arlMsg');
      chk('the visitor is told checkout is being updated and nothing was charged', /Checkout is being updated/.test(m) && /Nothing has been charged/.test(m), m);
      chk('no consent is recorded for a checkout that cannot happen', state.consents.length === 0, state.consents.length);
      chk('and nobody is sent to Stripe', state.stripe.length === 0, state.stripe);
      await ctx.close();
    }
  } finally {
    await browser.close();
    site.srv.close();
  }
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | checkout flow | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
