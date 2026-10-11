#!/usr/bin/env node
/* ===========================================================================
   THE QUANT DESK, IN A REAL BROWSER, AT BOTH WIDTHS.

   The answers are the REAL handler's: tools/intelligence/quant_host.test.js
   runs the acceptance questions through supabase/functions/edgedesk_ai with
   the fixture network and dumps each response (QUANT_DUMP). This suite opens
   app.html in Chromium, seeds a signed-in reader, answers the panel's request
   with those responses and checks what is on the screen:
     - the verdict chip is the server's classification (Verified edge only on a
       BUY; Potential edge, Pass otherwise), never upgraded by the page
     - the brief's fields render as a grid, the evidence as expandable
       sections (EV calculation, market comparison, audit results, source
       verification, model assumptions, coverage, historical performance)
     - the browser carries the quant state back, so "which sports couldn't be
       scanned?" lands on the scan it follows
     - an MLB "A vs B" question and a contract price reach the server instead
       of being answered as a missing football game
     - at 390 px the page does not scroll sideways and the grid is one column

   Run: node tools/intelligence/quant_ui.e2e.js   (--shots writes PNGs to .desk-shots/)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.DESK_SHOT_DIR || path.join(ROOT, '.desk-shots');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done(code) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(code !== undefined ? code : (fail === 0 ? 0 : 1));
}

/* ---- the real handler's responses ----------------------------------------- */
const DUMP = path.join(require('os').tmpdir(), 'edgedesk-quant-ui-' + process.pid + '.json');
try { cp.execFileSync(process.execPath, [path.join(__dirname, 'quant_host.test.js')], { env: Object.assign({}, process.env, { QUANT_DUMP: DUMP, QUANT_PRINT: '0' }), stdio: 'pipe' }); }
catch (e) { console.log('quant_host.test.js failed, so there is nothing real to render:\n' + String(e.stdout || e.message).slice(-800)); process.exit(1); }
const R = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
try { fs.unlinkSync(DUMP); } catch (_) { /* ignore */ }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium (' + String(e.message).split('\n')[0] + ')'); site.srv.close(); process.exit(0); }
  }
  const SENT = [];
  async function openPanel(viewport, reply) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/functions\/v1\/edgedesk_ai/.test(url)) {
        let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) { body = null; }
        SENT.push(body);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply(body)) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.EDAI && typeof window.EDAI.open === 'function', null, { timeout: 30000 });
    await page.evaluate(() => window.EDAI.open());
    await page.waitForSelector('#edaiPanel.open', { timeout: 10000 });
    return { page, ctx, errors };
  }
  async function ask(page, q, count) {
    const before = SENT.length;
    await page.evaluate((question) => { const t = document.getElementById('edaiText'); t.value = question; return window.EDAI.sendText(); }, q);
    await page.waitForFunction((n) => document.querySelectorAll('#edaiLog .qd-read').length >= n, count || 1, { timeout: 20000 }).catch(() => {});
    return { reached_server: SENT.length > before };
  }
  async function lastAnswer(page) {
    return page.evaluate(() => {
      const all = document.querySelectorAll('#edaiLog .qd-read');
      const card = all[all.length - 1];
      if (!card) return null;
      const box = card.parentElement;
      const chip = card.querySelector('.qd-chip');
      const kv = card.querySelector('.qd-kv');
      const sections = [...box.querySelectorAll('details.qd-more > summary')].map((s) => s.textContent.trim());
      return { text: card.innerText, chip: chip ? chip.textContent.trim() : null, kvCols: kv ? getComputedStyle(kv).gridTemplateColumns.split(' ').length : 0,
        keys: kv ? [...kv.querySelectorAll('dt')].map((d) => d.textContent.trim()) : [], sections, auditRows: box.querySelectorAll('details.qd-more .qd-tbl tr').length,
        src: ([...box.querySelectorAll(':scope > .edai-src')].pop() || {}).textContent || '', html: box.innerHTML.length };
    });
  }

  try {
    const byQuestion = (body) => {
      const q = String(body && body.question || '');
      if (/next 24 hours/.test(q)) return R.scan_24h.response;
      if (/this week across all sports/.test(q)) return R.scan_week.response;
      if (/Rays at 61/.test(q)) return R.contract_rays.response;
      if (/couldn.t be scanned/.test(q)) return R.coverage.response;
      if (/Explain why/.test(q)) return R.explain.response;
      return { answer: 'ok', build: 'e2e' };
    };
    for (const vp of [{ width: 1280, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'phone' }]) {
      SENT.length = 0;
      const { page, ctx, errors } = await openPanel({ width: vp.width, height: vp.height }, byQuestion);
      /* 1. the week's scan: a verified edge */
      const a1 = await ask(page, R.scan_week.question, 1);
      const w = await lastAnswer(page);
      chk(vp.tag + ': the cross-sport question reached the server', a1.reached_server && SENT[0] && SENT[0].desk === true);
      chk(vp.tag + ': the verdict chip is the server\'s: Verified edge', w && /verified edge/i.test(w.chip || ''), w && w.chip);
      chk(vp.tag + ': the brief\'s fields render as a grid', w && ['Event', 'Market', 'Venue', 'Available price', 'Independent fair price', 'Estimated net EV', 'Maximum acceptable entry', 'Model reliability', 'Primary matchup advantage', 'Biggest risk', 'Decision'].every((k) => w.keys.includes(k)), w && w.keys);
      chk(vp.tag + ': the decision reads BUY, Buffalo Bills -2.5', w && /Decision\s*BUY/.test(w.text) && /Buffalo Bills -2\.5/.test(w.text), w && w.text.slice(0, 600));
      chk(vp.tag + ': the evidence sections are there to expand', w && ['EV calculation', 'Audit results', 'Source verification', 'Model assumptions', 'Coverage', 'Historical performance'].every((k) => w.sections.includes(k)), w && w.sections);
      chk(vp.tag + ': the audit table lists the fifteen checks', w && w.auditRows >= 16, w && w.auditRows);
      chk(vp.tag + ': the source line says no model wrote it', w && /no model wrote this/.test(w.src), w && w.src);
      if (vp.tag === 'phone') {
        const geom = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, panelW: document.getElementById('edaiPanel').getBoundingClientRect().width }));
        chk('phone: the page does not scroll sideways', geom.sw <= geom.iw + 1, geom);
        chk('phone: the field grid is one column', w && w.kvCols === 1, w && w.kvCols);
      } else chk('desktop: the field grid is two columns', w && w.kvCols === 2, w && w.kvCols);
      if (SHOTS) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'quant-scan-' + vp.tag + '.png'), fullPage: false }); }

      /* 2. the follow-up carries the quant state */
      await ask(page, R.coverage.question, 2);
      const cov = await lastAnswer(page);
      const sent2 = SENT[SENT.length - 1];
      chk(vp.tag + ': the follow-up carried the quant state back', sent2 && sent2.research_context && sent2.research_context.quant && sent2.research_context.quant.schema === 'edgedesk_quant_state_v1' && sent2.research_context.quant.coverage.length > 3, sent2 && sent2.research_context && Object.keys(sent2.research_context));
      chk(vp.tag + ': the coverage answer names the sports not scanned', cov && /NBA/.test(cov.text) && /not capture/i.test(cov.text), cov && cov.text.slice(0, 300));

      /* 3. the 24-hour scan: nothing verified */
      await ask(page, R.scan_24h.question, 3);
      const s24 = await lastAnswer(page);
      chk(vp.tag + ': no verified trade: the chip says Potential edge, not Verified', s24 && /potential edge/i.test(s24.chip || '') && /No verified positive-EV trade/.test(s24.text), s24 && [s24.chip, s24.text.slice(0, 160)]);
      chk(vp.tag + ': …and the decision reads WATCH', s24 && /Decision\s*WATCH/.test(s24.text));

      /* 4. the contract: an MLB "A vs B" with a price reaches the server and passes */
      const a4 = await ask(page, R.contract_rays.question, 4);
      const c = await lastAnswer(page);
      chk(vp.tag + ': "Rays vs. Guardians … 61¢" reached the server (not answered as a missing football game)', a4.reached_server, SENT.map((b) => b && b.question));
      chk(vp.tag + ': the contract verdict is Pass', c && /^pass$/i.test(c.chip || ''), c && c.chip);
      chk(vp.tag + ': the market comparison is there, FanDuel first', c && c.sections.includes('Market comparison') && /FanDuel/.test(await page.evaluate(() => { const d = [...document.querySelectorAll('details.qd-more')].filter((x) => /Market comparison/.test(x.textContent)).pop(); return d ? d.textContent : ''; })), c && c.sections);
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, 'quant-contract-' + vp.tag + '.png'), fullPage: false });

      /* 5. an MLB matchup question with no price also reaches the server */
      const before = SENT.length;
      await page.evaluate(() => { const t = document.getElementById('edaiText'); t.value = 'Who has the advantage in Rays vs. Guardians?'; return window.EDAI.sendText(); });
      await page.waitForFunction((n) => window.__edaiSentCount === undefined, before, { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const notOnCard = await page.evaluate(() => /on any card EdgeDesk publishes/.test(document.getElementById('edaiLog').innerText));
      chk(vp.tag + ': an MLB matchup is not answered as a football game missing from the card', !notOnCard && SENT.length > before, { notOnCard, sent: SENT.length - before });

      chk(vp.tag + ': no page errors', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) { fail++; failures.push({ name: 'the suite threw', detail: String(e && e.stack || e).slice(0, 600) }); }
  await browser.close();
  site.srv.close();
  done();
})();
