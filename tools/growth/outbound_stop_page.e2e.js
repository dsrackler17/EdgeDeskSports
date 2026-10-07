#!/usr/bin/env node
/* ===========================================================================
   /email/stop/ — WHERE AN OUTBOUND EMAIL'S OPT-OUT LINK LANDS, in a real
   browser (the shipped file; the database door mocked).

     1  opening the link changes nothing: the page asks the door WITHOUT
        confirming and shows the masked address and one button; the token
        leaves the address bar at once
     2  the button stops email (the door, confirmed, with the same token) and
        says so; it is never pressed for the reader
     3  a link without a 64-hex token never reaches the database
     4  a token no send carries: "not valid", no button
     5  already stopped: says so, no button; a test send's link: nothing changed
     6  the door's words are shown as text (no markup runs)
     7  the database unreachable: says so, and to reply STOP
     8  inside another site's frame there is no button to trick anyone into
     9  the fragment form (#t=) and the query form (?t=) both work; no page
        errors; fits a phone

   Run:  node tools/growth/outbound_stop_page.e2e.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/frame.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<iframe id="f" src="/email/stop/#t=' + 'ab'.repeat(32) + '" width="600" height="500"></iframe>'); return; }
      const file = path.join(ROOT, path.normalize(p.endsWith('/') ? p + 'index.html' : p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const TOK = 'ab'.repeat(32);

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
  const BASE = 'http://127.0.0.1:' + site.port;

  /* door: (body) => [status, json] | 'abort' */
  async function open(hash, door, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 1100, height: 800 } });
    const calls = [];
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (url === 'https://iattxbkbufslbauoumga.supabase.co/rest/v1/rpc/growth_outbound_optout') {
        const body = JSON.parse(req.postData() || '{}');
        calls.push({ body, apikey: req.headers().apikey });
        const r = door(body);
        if (r === 'abort') return route.abort();
        return route.fulfill({ status: r[0], contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(r[1]) });
      }
      calls.push({ other: url });
      return route.abort();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto(BASE + (o.path || '/email/stop/') + hash, { waitUntil: 'load' });
    await page.waitForTimeout(400);
    return { ctx, page, calls, errors };
  }
  const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
  const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().height > 0; }, sel);
  const DOOR = (state) => (b) => {
    if (!/^[0-9a-f]{64}$/.test(b.p_token)) return [200, { ok: false, reason: 'invalid' }];
    if (b.p_confirm) { state.done = true; return [200, { ok: true, masked: 'p•••@cfbnumbers.test', already: false, done: true }]; }
    return [200, { ok: true, masked: 'p•••@cfbnumbers.test', already: !!state.done, done: !!state.done }];
  };

  /* 1–2 */
  {
    const st = {};
    const t = await open('#t=' + TOK, DOOR(st));
    chk('1 opening the link asks the door WITHOUT confirming, with the token and the public key only', t.calls.length === 1 && t.calls[0].body.p_token === TOK
      && t.calls[0].body.p_confirm === false && /^eyJ/.test(t.calls[0].apikey || ''), t.calls);
    chk('1 … and shows the masked address and one button', /Stop email to p•••@cfbnumbers\.test\?/.test(await text(t.page, '#h')) && await shown(t.page, '#go'));
    chk('1 the token has left the address bar', !(await t.page.evaluate(() => location.href)).includes(TOK));
    chk('1 nothing was stopped by opening it', !st.done);
    await t.page.click('#go'); await t.page.waitForTimeout(400);
    chk('2 the button stops email: the door, confirmed, with the same token', t.calls.length === 2 && t.calls[1].body.p_token === TOK && t.calls[1].body.p_confirm === true);
    chk('2 … and says so; the button is gone', /Done\. You will not hear from us again\./.test(await text(t.page, '#h')) && /will not email p•••@cfbnumbers\.test again/.test(await text(t.page, '#m'))
      && !(await shown(t.page, '#go')));
    chk('1-2 no page errors, no other request', t.errors.length === 0 && t.calls.every((c) => !c.other), [t.errors, t.calls]);
    await t.ctx.close();
  }
  /* 3 */
  for (const h of ['', '#t=', '#t=abc', '#t=' + TOK + '0', '#t=' + 'z'.repeat(64), '#x=' + TOK]) {
    const t = await open(h, DOOR({}));
    chk('3 no token-shaped token, no database call: ' + JSON.stringify(h.slice(0, 10)), t.calls.length === 0 && /incomplete/.test(await text(t.page, '#h')) && !(await shown(t.page, '#go')) && /Reply STOP/.test(await text(t.page, '#m')));
    await t.ctx.close();
  }
  /* 4–7 */
  for (const [label, door, want] of [
    ['4 a token no send carries', () => [200, { ok: false, reason: 'invalid' }], /That link is not valid/],
    ['5 already stopped', () => [200, { ok: true, masked: 'p•••@cfbnumbers.test', already: true, done: true }], /Done\. You will not hear from us again/],
    ['5 a test send\'s link', () => [200, { ok: true, test: true, masked: 'o•••@edgedesk.test', done: false }], /That was a test email/],
    ['7 the database unreachable', () => 'abort', /could not reach EdgeDesk/],
    ['7 the database erroring', () => [500, { message: 'boom' }], /could not reach EdgeDesk/],
    ['7 the door not installed yet', () => [404, { code: 'PGRST202' }], /could not reach EdgeDesk/]]) {
    const t = await open('#t=' + TOK, door);
    chk(label + ': said, and no button', want.test(await text(t.page, '#h')) && !(await shown(t.page, '#go')) && t.calls.length === 1, await text(t.page, '#h'));
    await t.ctx.close();
  }
  /* 6 */
  {
    const t = await open('#t=' + TOK, () => [200, { ok: true, masked: '<img src=x onerror="window.__pwned=1">', already: false, done: false }]);
    chk('6 the door\'s words are text: no element made, nothing ran', await t.page.evaluate(() => !document.querySelector('main img') && !window.__pwned)
      && /<img src=x/.test(await text(t.page, '#h')));
    await t.ctx.close();
  }
  /* 8 */
  {
    const t = await open('', DOOR({}), { path: '/frame.html' });
    const f = t.page.frames().find((x) => /email\/stop/.test(x.url()));
    await t.page.waitForTimeout(300);
    const hidden = f ? await f.evaluate(() => document.getElementById('go').hidden) : null;
    chk('8 inside another site\'s frame the page answers but offers no button', !!f && hidden === true && t.calls.length === 1 && t.calls[0].body.p_confirm === false, hidden);
    await t.ctx.close();
  }
  /* 9 */
  {
    const t = await open('?t=' + TOK.toUpperCase(), DOOR({}), { viewport: { width: 390, height: 844 } });
    chk('9 the query form works too (lower-cased), and the token leaves the address bar', t.calls.length === 1 && t.calls[0].body.p_token === TOK
      && !(await t.page.evaluate(() => location.href)).toLowerCase().includes(TOK));
    const sw = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('9 fits a phone', sw <= 391, sw);
    chk('9 the page is not indexed and sends no referrer', await t.page.evaluate(() => !!document.querySelector('meta[name=robots][content*=noindex]') && !!document.querySelector('meta[name=referrer][content=no-referrer]')));
    chk('9 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound stop page (browser): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
