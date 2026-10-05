#!/usr/bin/env node
/* ===========================================================================
   /admin/growth/ SIGN-IN, IN A REAL BROWSER.

   The reported failure: an operator opened the console with a session stored
   an hour earlier, the page sent the expired JWT, PostgREST answered
   401 PGRST303 "JWT expired", and the gate said the account "cannot open the
   growth console: an operator must add it to public.affiliate_admins" with
   the raw JSON appended. Supabase is mocked; the page is the shipped file.

     1  stale stored session, refresh works  → straight into the console,
                                               no gate, rotated session stored,
                                               the expired token never sent
     2  stale stored session, refresh refused → the gate says "sign in again"
                                               in words; storage cleared; a
                                               fresh sign-in opens the console
     3  a signed-in non-operator             → "does not have access", no data
                                               RPC is ever called, and a way to
                                               switch accounts
     4  growth.sql not installed             → said so, not "not an operator"
     5  a 401 mid-session on one section     → refreshed, retried once, drawn
     6  sign out                             → storage cleared, server session
                                               revoked, gate shown
     7  nothing the page shows or logs carries a token; no page errors
     8  at 390 px the gate and the console fit the screen

   Run:  node tools/growth/admin_growth_login.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const SKEY = 'edgedesk_growth_admin_session';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function jwt(tag, expSec) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256', typ: 'JWT' }) + '.' + b({ sub: 'owner-' + tag, exp: expSec, role: 'authenticated', email: 'owner@edgedesk.test' }) + '.sig' + tag;
}
const nowSec = () => Math.floor(Date.now() / 1000);

/* what the three sections are drawn from — the shapes growth.sql returns */
const ACTIVATION = {
  window_days: 90, trials: 12, activated_trials: 5, activation_rate: 5 / 12, paid_conversions: 3, trial_to_paid_rate: 0.25,
  activated_to_paid_rate: 0.4, activated_paid: 2, not_activated_to_paid_rate: 1 / 7, not_activated_paid: 1,
  time_to_activation_hours: { median: 20, p75: 41, n: 5 }, states: { NOT_ACTIVATED: 4, EXPLORING: 3, ACTIVATED: 4, POWER_USER: 1 },
  actions: { matchup_viewed: 10 }, cohorts: [{ week: '2026-09-28', trials: 4, activated: 2, paid: 1 }],
  settings: { weights: { matchup_viewed: 1 }, per_kind_cap: 5, exploring_min_points: 2, activated_min_points: 6, activated_min_kinds: 2,
    activated_min_active_days: 2, power_min_points: 15, power_min_kinds: 4, power_min_active_days: 5, trial_days: 7,
    retained_min_paid_invoices: 2, activated_requires_core: false, core_kinds: [] }
};
const FUNNEL = { touch: 'first', retained_rule: '2+ paid invoices', rows: [{ source: 'search', visitors: 40, signups: 9, trials: 6, activated_trials: 3, paid: 2, retained: 1, creator_credited: 0 }],
  totals: { visitors: 40, signups: 9, trials: 6, activated_trials: 3, paid: 2, retained: 1, creator_credited: 0 } };
const SAMPLES = { samples: [], candidates: [] };
const DATA_RPCS = ['growth_admin_activation', 'growth_admin_funnel', 'growth_admin_samples'];

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const BASE = 'http://127.0.0.1:' + site.port;

  /* o: { stored, refresh(rt) -> [status, body], password(body) -> [status, body], rpc(name, bearer, n) -> [status, body], viewport } */
  async function open(o) {
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 } });
    const calls = [];
    if (o.stored) await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } } catch (_) {} }, [SKEY, JSON.stringify(o.stored)]);
    const counts = {};
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const bearer = String(req.headers().authorization || '').replace(/^Bearer /, '');
      const reply = (st, body) => route.fulfill({ status: st, contentType: 'application/json', body: body == null ? '' : JSON.stringify(body) });
      if (/auth\/v1\/token\?grant_type=refresh_token/.test(url)) { const b = JSON.parse(req.postData() || '{}'); calls.push(['refresh', b.refresh_token]); const [s, j] = o.refresh ? o.refresh(b.refresh_token) : [400, { error_code: 'refresh_token_not_found' }]; return reply(s, j); }
      if (/auth\/v1\/token\?grant_type=password/.test(url)) { const b = JSON.parse(req.postData() || '{}'); calls.push(['password', b.email]); const [s, j] = o.password ? o.password(b) : [400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }]; return reply(s, j); }
      if (/auth\/v1\/logout/.test(url)) { calls.push(['logout', bearer]); return route.fulfill({ status: 204, body: '' }); }
      const m = /rest\/v1\/rpc\/([a-z_]+)/.exec(url);
      if (m) {
        counts[m[1]] = (counts[m[1]] || 0) + 1;
        calls.push(['rpc', m[1], bearer]);
        const [s, j] = o.rpc(m[1], bearer, counts[m[1]]);
        return reply(s, j);
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [], logs = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    page.on('console', (m) => logs.push(m.text()));
    await page.goto(BASE + '/admin/growth/', { waitUntil: 'load' });
    return { ctx, page, calls, errors, logs };
  }
  const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.closest('.hide') && e.getBoundingClientRect().height > 0; }, sel);
  const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
  const stored = (page) => page.evaluate((k) => localStorage.getItem(k), SKEY);
  const settle = (page) => page.waitForTimeout(400);
  /* these operators are affiliate admins, not outbound owners (tools/growth/outbound_console.e2e.js covers the owner) */
  const dataAns = (name) => name === 'growth_admin_activation' ? [200, ACTIVATION] : name === 'growth_admin_funnel' ? [200, FUNNEL] : name === 'growth_admin_samples' ? [200, SAMPLES]
    : name === 'growth_outbound_is_owner' ? [200, false] : [404, { code: 'PGRST202', message: 'no such function' }];

  /* ── 1. the reported case: an hour-old session, refresh works ───────────── */
  {
    const OLD = jwt('old', nowSec() - 900), NEW = jwt('new', nowSec() + 3600);
    const t = await open({
      stored: { access_token: OLD, refresh_token: 'rt-old', expires_in: 3600, expires_at: nowSec() - 900, token_type: 'bearer', user: { id: 'owner-1', email: 'owner@edgedesk.test', user_metadata: {} } },
      refresh: (rt) => rt === 'rt-old' ? [200, { access_token: NEW, refresh_token: 'rt-new', expires_in: 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } }] : [400, { error_code: 'refresh_token_already_used' }],
      rpc: (name, bearer) => bearer !== NEW ? [401, { code: 'PGRST303', details: null, hint: null, message: 'JWT expired' }] : name === 'growth_is_admin' ? [200, true] : dataAns(name)
    });
    await t.page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await settle(t.page);
    chk('1 stale session → the console opens without a sign-in', await visible(t.page, '#actKpis') && !(await visible(t.page, '#gEmail')));
    chk('1 … the expired token was never sent', !t.calls.some((c) => c[0] === 'rpc' && c[2] === OLD), t.calls);
    chk('1 … one refresh', t.calls.filter((c) => c[0] === 'refresh').length === 1);
    chk('1 … every section drawn', /Trials/.test(await text(t.page, '#actKpis')) && /Search/.test(await text(t.page, '#funnel')));
    const s = JSON.parse((await stored(t.page)) || 'null');
    chk('1 … the rotated session is stored', s && s.access_token === NEW && s.refresh_token === 'rt-new');
    chk('1 … the operator is named', (await text(t.page, '#who')) === 'owner@edgedesk.test');
    chk('1 … no app-level error banner', !(await visible(t.page, '#appMsg')));
    chk('1 … no page errors', t.errors.length === 0, t.errors);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, '1-console.png'), fullPage: false });
    await t.ctx.close();
  }

  /* ── 2. the refresh is refused → clean sign-in, then a fresh session ────── */
  {
    const OLD = jwt('old', nowSec() - 900), FRESH = jwt('fresh', nowSec() + 3600);
    const t = await open({
      stored: { access_token: OLD, refresh_token: 'rt-revoked', expires_at: nowSec() - 900, user: { id: 'owner-1', email: 'owner@edgedesk.test' } },
      refresh: () => [400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }],
      password: (b) => b.password === 'right' ? [200, { access_token: FRESH, refresh_token: 'rt-fresh', expires_in: 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } }] : [400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }],
      rpc: (name, bearer) => bearer !== FRESH ? [401, { code: 'PGRST303', message: 'JWT expired' }] : name === 'growth_is_admin' ? [200, true] : dataAns(name)
    });
    await settle(t.page);
    const g = await text(t.page, '#gMsg');
    chk('2 refused refresh → the gate, saying sign in again', await visible(t.page, '#gEmail') && /sign in again/i.test(g), g);
    chk('2 … in words: no JSON, no PGRST, no affiliate_admins', !/[{}]|PGRST|JWT expired|affiliate_admins|growth\.sql/.test(g), g);
    chk('2 … the dead session is gone from storage', (await stored(t.page)) === null);
    chk('2 … no RPC was attempted with the dead token', !t.calls.some((c) => c[0] === 'rpc'), t.calls);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, '2-expired.png') });

    await t.page.fill('#gEmail', 'owner@edgedesk.test'); await t.page.fill('#gPass', 'wrong'); await t.page.click('#gGo'); await settle(t.page);
    const w = await text(t.page, '#gMsg');
    chk('2 a wrong password is said plainly', /wrong email or password/i.test(w), w);
    chk('2 … without pointing at a "Forgot password?" link this page does not have', !/forgot/i.test(w), w);
    chk('2 … and the password field is cleared', (await t.page.inputValue('#gPass')) === '');

    await t.page.fill('#gPass', 'right'); await t.page.press('#gPass', 'Enter');
    await t.page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await settle(t.page);
    chk('2 signing back in (Enter) → a fresh session opens the console', await visible(t.page, '#actKpis'));
    chk('2 … stored', JSON.parse((await stored(t.page)) || '{}').access_token === FRESH);
    chk('2 … the password is not in storage', !/right/.test(String(await stored(t.page)).replace(/refresh_token|"rt-fresh"/g, '')));
    chk('2 … no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 3. a signed-in subscriber who is not an operator ───────────────────── */
  {
    const T = jwt('sub', nowSec() + 3600);
    const t = await open({
      password: () => [200, { access_token: T, refresh_token: 'rt-sub', expires_in: 3600, user: { id: 'sub-1', email: 'reader@example.test' } }],
      rpc: (name) => name === 'growth_is_admin' ? [200, false] : [403, { code: '42501', message: 'not an admin' }]
    });
    await t.page.fill('#gEmail', 'reader@example.test'); await t.page.fill('#gPass', 'pw'); await t.page.click('#gGo'); await settle(t.page);
    const g = await text(t.page, '#gMsg');
    chk('3 non-operator → "does not have access"', /does not have access/.test(g), g);
    chk('3 … no data RPC was called', !t.calls.some((c) => c[0] === 'rpc' && DATA_RPCS.indexOf(c[1]) >= 0), t.calls);
    chk('3 … the console stays hidden', !(await visible(t.page, '#actKpis')));
    chk('3 … the message names no table or file', !/affiliate_admins|growth\.sql/.test(g));
    chk('3 … offers a way to switch accounts', await visible(t.page, '#gOut') && !(await visible(t.page, '#gEmail')));
    await t.page.click('#gOut'); await settle(t.page);
    chk('3 switching clears the session and shows sign-in', (await stored(t.page)) === null && await visible(t.page, '#gEmail'));
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, '3-not-operator.png') });
    await t.ctx.close();
  }

  /* ── 4. growth.sql not installed ─────────────────────────────────────────── */
  {
    const T = jwt('own', nowSec() + 3600);
    const t = await open({
      stored: { access_token: T, refresh_token: 'rt', expires_at: nowSec() + 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } },
      rpc: () => [404, { code: 'PGRST202', details: 'Searched for the function public.growth_is_admin without parameters', hint: null, message: 'Could not find the function public.growth_is_admin without parameters in the schema cache' }]
    });
    await settle(t.page);
    const g = await text(t.page, '#gMsg');
    chk('4 missing functions → "not installed", not "not an operator"', /not installed/.test(g) && !/does not have access/.test(g), g);
    chk('4 … no schema-cache text', !/schema cache|PGRST/.test(g));
    chk('4 … the session is kept (nothing wrong with it)', (await stored(t.page)) !== null);
    await t.ctx.close();
  }

  /* ── 5. a 401 mid-session on one section → refresh once, retry, drawn ───── */
  {
    const A = jwt('a', nowSec() + 1800), B = jwt('b', nowSec() + 3600);
    let funnelSeen = 0;
    const t = await open({
      stored: { access_token: A, refresh_token: 'rt-a', expires_at: nowSec() + 1800, user: { id: 'owner-1', email: 'owner@edgedesk.test' } },
      refresh: (rt) => rt === 'rt-a' ? [200, { access_token: B, refresh_token: 'rt-b', expires_in: 3600 }] : [400, {}],
      rpc: (name, bearer) => {
        if (name === 'growth_admin_funnel' && bearer === A) { funnelSeen++; return [401, { code: 'PGRST303', message: 'JWT expired' }]; }
        if (bearer !== A && bearer !== B) return [401, { code: 'PGRST301', message: 'bad jwt' }];
        return name === 'growth_is_admin' ? [200, true] : dataAns(name);
      }
    });
    await t.page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await settle(t.page);
    chk('5 a 401 on one section → refreshed and retried, every section drawn', /Search/.test(await text(t.page, '#funnel')) && /Trials/.test(await text(t.page, '#actKpis')));
    chk('5 … one refresh', t.calls.filter((c) => c[0] === 'refresh').length === 1, t.calls);
    chk('5 … the funnel retried once with the new token', funnelSeen === 1 && t.calls.filter((c) => c[1] === 'growth_admin_funnel' && c[2] === B).length === 1, t.calls);
    chk('5 … no banner', !(await visible(t.page, '#appMsg')));

    /* ── 6. sign out ──────────────────────────────────────────────────────── */
    await t.page.click('#signOut'); await settle(t.page);
    chk('6 sign out → the gate', await visible(t.page, '#gEmail') && !(await visible(t.page, '#actKpis')));
    chk('6 … storage cleared', (await stored(t.page)) === null);
    chk('6 … the server session is revoked with the live token', t.calls.some((c) => c[0] === 'logout' && c[1] === B), t.calls.filter((c) => c[0] === 'logout').length);
    chk('6 … "Signed out." is said, and the sign-out button is gone', /Signed out/.test(await text(t.page, '#gMsg')) && !(await visible(t.page, '#signOut')));
    await t.page.reload({ waitUntil: 'load' }); await settle(t.page);
    chk('6 … a reload stays signed out (no request at all)', await visible(t.page, '#gEmail') && (await stored(t.page)) === null);

    /* ── 7. no token in anything the page shows or logs ──────────────────── */
    const html = await t.page.content();
    chk('7 no access or refresh token in the rendered page', [A, B, 'rt-a', 'rt-b'].every((x) => html.indexOf(x) < 0));
    chk('7 no token in the console output', t.logs.every((l) => [A, B, 'rt-a', 'rt-b'].every((x) => l.indexOf(x) < 0)), t.logs.slice(0, 5));
    chk('7 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 8. a phone: gate and console both fit ──────────────────────────────── */
  {
    const T = jwt('m', nowSec() + 3600);
    const t = await open({ viewport: { width: 390, height: 844 },
      stored: { access_token: T, refresh_token: 'rt', expires_at: nowSec() + 3600, user: { id: 'owner-1', email: 'owner@edgedesk.test' } },
      rpc: (name) => name === 'growth_is_admin' ? [200, true] : dataAns(name) });
    await t.page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await settle(t.page);
    const sw = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 at 390 px the console is not wider than the screen', sw <= 391, sw);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, '8-phone.png') });
    await t.page.click('#signOut'); await settle(t.page);
    const sw2 = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 … nor is the gate', sw2 <= 391, sw2);
    await t.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' — growth console sign-in (browser): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
