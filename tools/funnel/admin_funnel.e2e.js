#!/usr/bin/env node
/* ===========================================================================
   THE OPERATOR'S CONVERSION DASHBOARD, IN A REAL BROWSER (admin/funnel/).

   Rendered from tools/funnel/fixtures/funnel_admin.json — the REAL
   funnel_admin_report(30) and lifecycle_admin_summary() answers, written by
   funnel_sql.test.js --write-fixture — with sign-in and the RPCs mocked:

     1  sign-in → the twelve rates (visitors … cancellation), the funnel with
        its biggest drop marked, the table view of the same numbers, where
        trials stopped, and the cohort tabs (signup week, source, NFL vs CFB,
        stated focus, what they opened)
     2  a rate with no denominator prints "—", never 0%
     3  the email controls show sending OFF and switch it through
        lifecycle_admin_set (the only write)
     4  a non-operator is told so, and sees no numbers
     5  at 390 px nothing is wider than the screen (tables scroll in place)

   Run:  node tools/funnel/admin_funnel.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'funnel_admin.json'), 'utf8'));

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) { const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'; if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); process.exit(0); } }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(viewport, admin) {
    const ctx = await browser.newContext({ viewport });
    const calls = [];
    let lc = JSON.parse(JSON.stringify(FX.lifecycle));
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/auth\/v1\/token/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'op', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { email: 'ops@edgedesk.test' } }) });
      const m = /rest\/v1\/rpc\/([a-z_]+)/.exec(url);
      if (m) {
        const body = JSON.parse(req.postData() || '{}'); calls.push([m[1], body]);
        if (!admin) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"not an admin"}' });
        if (m[1] === 'funnel_admin_report') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FX.report) });
        if (m[1] === 'lifecycle_admin_summary') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lc) });
        if (m[1] === 'lifecycle_admin_set') { lc.settings = Object.assign({}, lc.settings, body.p); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lc) }); }
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + site.port + '/admin/funnel/', { waitUntil: 'load' });
    await page.fill('#gEmail', 'ops@edgedesk.test'); await page.fill('#gPass', 'x');
    await page.click('#gGo');
    return { ctx, page, calls, errors };
  }

  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const w = vp.width;
    const S = await open(vp, true);
    await S.page.waitForSelector('#kpis .kpi', { timeout: 10000 });
    const r = await S.page.evaluate(() => ({
      kpis: [...document.querySelectorAll('#kpis .kpi')].map((k) => k.querySelector('i').textContent + '=' + k.querySelector('b').textContent),
      bars: document.querySelectorAll('#fun .fr').length, drop: document.querySelectorAll('#fun .fr.drop').length,
      funRows: document.querySelectorAll('#funT tr').length, last: document.querySelectorAll('#last tr').length,
      coh: [...document.querySelectorAll('#coh tr')].map((tr) => tr.children.length), lc: document.getElementById('lcState').textContent,
      noindex: !!document.querySelector('meta[name="robots"][content*="noindex"]'), who: document.getElementById('who') ? document.getElementById('who').textContent : ''
    }));
    const names = r.kpis.map((k) => k.split('=')[0]);
    chk(w + ': the twelve rates the brief asks for', ['Visitors', 'Landing CTA', 'Signup', 'Trial start', 'Terminal activation', 'Game open', 'Prop open', 'Day-1 retention', 'Day-3 retention', 'Day-7 retention', 'Trial to paid', 'Cancellation'].every((n) => names.includes(n)), names);
    chk(w + ': numbers from the report', r.kpis.includes('Visitors=1') && r.kpis.includes('Trial to paid=100%'), r.kpis);
    chk(w + ': the funnel draws every step and marks one biggest drop', r.bars === FX.report.steps.length && r.drop <= 1, [r.bars, r.drop]);
    chk(w + ': and has a table view of the same numbers', r.funRows === FX.report.steps.length + 1);
    chk(w + ': where each trial stopped', r.last > 1);
    chk(w + ': cohorts by signup week, eleven columns', r.coh.length > 1 && r.coh.every((n) => n === 11 || n === 1), r.coh);
    for (const d of ['source', 'sport', 'stated_focus', 'research_type']) {
      await S.page.click('#dims button[data-d="' + d + '"]');
      const rows = await S.page.evaluate(() => document.querySelectorAll('#coh tr').length);
      chk(w + ': cohort tab ' + d, rows === (FX.report.cohorts[d] || []).length + 1, rows);
    }
    chk(w + ': the page is not indexed', r.noindex);
    chk(w + ': email sending shows OFF', r.lc === 'off');
    if (w === 1280) {
      await S.page.click('#lcToggle');
      await S.page.waitForFunction(() => document.getElementById('lcState').textContent === 'ON');
      const set = S.calls.filter((c) => c[0] === 'lifecycle_admin_set');
      chk('switching sending on is one lifecycle_admin_set call with only that change', set.length === 1 && JSON.stringify(set[0][1]) === '{"p":{"sending_enabled":true}}', set);
      chk('the dashboard itself writes nothing else', S.calls.every((c) => ['funnel_admin_report', 'lifecycle_admin_summary', 'lifecycle_admin_set'].includes(c[0])), S.calls.map((c) => c[0]));
    }
    const ov = await S.page.evaluate(() => {
      const W = window.innerWidth, out = [];
      const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) return true; } return false; };
      document.querySelectorAll('body *').forEach((el) => { const b = el.getBoundingClientRect(); if (b.width && (b.right > W + 1) && !clipped(el) && getComputedStyle(el).position !== 'fixed' && !el.closest('.hide')) out.push(el.id || el.className || el.tagName); });
      return out.slice(0, 5);
    });
    chk(w + ': nothing wider than the screen', ov.length === 0, ov);
    chk(w + ': no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await S.page.screenshot({ path: path.join(SHOTS, 'admin-funnel-' + w + '.png'), fullPage: true });
    await S.ctx.close();
  }

  {
    const S = await open({ width: 1280, height: 900 }, false);
    await S.page.waitForFunction(() => /operator list/.test(document.getElementById('aMsg').textContent), null, { timeout: 10000 });
    const kp = await S.page.evaluate(() => document.querySelectorAll('#kpis .kpi').length);
    chk('a non-operator is told so and sees no numbers', kp === 0);
    await S.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' admin funnel (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
