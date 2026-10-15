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
     - a researched candidate renders as a card (lib/edgedesk_intel_ui.js) with
       every field the Phase 2 answer prints, its evidence in four expandable
       sections (matchup research, model calculations, market comparison, audit
       findings), the answer's own sections (confidence, coverage, research
       level and cost, historical performance) below it
     - the browser carries the quant state back, so "which sports couldn't be
       scanned?" lands on the scan it follows
     - an MLB "A vs B" question and a contract price reach the server instead
       of being answered as a missing football game
     - at 390 px the page does not scroll sideways and the card is one column

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
/* Phase 2: the slate investigation and the betting-history answer, from the research suite's real responses */
const DUMP2 = path.join(require('os').tmpdir(), 'edgedesk-research-ui-' + process.pid + '.json');
try { cp.execFileSync(process.execPath, [path.join(__dirname, 'research_host.test.js')], { env: Object.assign({}, process.env, { RESEARCH_DUMP: DUMP2, RESEARCH_PRINT: '0' }), stdio: 'pipe' }); }
catch (e) { console.log('research_host.test.js failed, so there is nothing real to render:\n' + String(e.stdout || e.message).slice(-800)); process.exit(1); }
const R2 = JSON.parse(fs.readFileSync(DUMP2, 'utf8'));
try { fs.unlinkSync(DUMP2); } catch (_) { /* ignore */ }
/* the multi-sport desk: the 2026-10-15 answer, from the regression suite's real handler responses */
const DUMP3 = path.join(require('os').tmpdir(), 'edgedesk-multisport-ui-' + process.pid + '.json');
try { cp.execFileSync(process.execPath, [path.join(__dirname, 'multisport_host.test.js')], { env: Object.assign({}, process.env, { MS_DUMP: DUMP3, MS_PRINT: '0' }), stdio: 'pipe' }); }
catch (e) { console.log('multisport_host.test.js failed, so there is nothing real to render:\n' + String(e.stdout || e.message).slice(-800)); process.exit(1); }
const R3 = JSON.parse(fs.readFileSync(DUMP3, 'utf8'));
try { fs.unlinkSync(DUMP3); } catch (_) { /* ignore */ }

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
      const bench = card.querySelector('.qd-bench');
      const kv = card.querySelector('.qd-kv');
      const sections = [...box.querySelectorAll('details.qd-more > summary')].map((s) => s.textContent.trim());
      return { text: card.innerText, chip: chip ? chip.textContent.trim() : null, bench: bench ? bench.textContent.trim() : null, kvCols: kv ? getComputedStyle(kv).gridTemplateColumns.split(' ').length : 0,
        keys: kv ? [...kv.querySelectorAll('dt')].map((d) => d.textContent.trim()) : [], allKeys: [...card.querySelectorAll('.qd-kv dt')].map((d) => d.textContent.trim()), sections, auditRows: box.querySelectorAll('details.qd-more .qd-tbl tr').length,
        src: ([...box.querySelectorAll(':scope > .edai-src')].pop() || {}).textContent || '', html: box.innerHTML.length,
        /* Phase 3: a researched candidate renders as a card (lib/edgedesk_intel_ui.js); its text block is folded into it */
        card: (() => { const c = [...box.querySelectorAll('.ia-card')][0]; if (!c) return null; const kv = {}; c.querySelectorAll('.ia-kv-r').forEach((r) => { const k = r.querySelector('dt').textContent; if (!(k in kv)) kv[k] = r.querySelector('dd').innerText.replace(/\s+/g, ' ').trim(); });
          const aud = [...c.querySelectorAll('details.ia-more')].find((d) => /Audit findings/.test(d.querySelector('summary').textContent)); const tbls = aud ? aud.querySelectorAll('table') : [];
          return { title: c.querySelector('.ia-card-t').textContent, sub: c.querySelector('.ia-card-s').textContent, chip: (c.querySelector('.ia-card-hd .ia-chipcls') || {}).textContent, kv, keys: Object.keys(kv),
            more: [...c.querySelectorAll('details.ia-more > summary')].map((x) => x.textContent), auditRows: tbls.length ? tbls[tbls.length - 1].querySelectorAll('tr').length : 0, checkRows: tbls.length > 1 ? tbls[0].querySelectorAll('tr').length : 0,
            kvCols: getComputedStyle(c.querySelector('.ia-kv')).gridTemplateColumns.split(' ').length, fits: c.scrollWidth <= c.clientWidth + 1 }; })(),
        results: [...box.querySelectorAll('.ia-results details.ia-more')].map((d) => ({ s: d.querySelector('summary').textContent, open: d.open, games: d.querySelectorAll('.ia-g').length })) };
    });
  }

  try {
    const byQuestion = (body) => {
      const q = String(body && body.question || '');
      if (/^Research every available NFL game/.test(q)) return R2.research_slate.response;
      if (/^Why did I lose money/.test(q)) return R2.bets.response;
      if (/best researched opportunity tonight/.test(q)) return (body && body.__odds_off) || /with the odds off/.test(q) ? R3.odds_off.response : R3.oct15.response;
      if (/next 24 hours/.test(q)) return R.scan_24h.response;
      if (/this week across all sports/.test(q)) return R.scan_week.response;
      if (/Rays at 61/.test(q)) return R.contract_rays.response;
      if (/couldn.t be scanned/.test(q)) return R.coverage.response;
      if (/Explain why/.test(q)) return R.explain.response;
      if (/46c on Kalshi fair for Rays vs Guardians/.test(q)) return R.contract_ambiguous.response;
      return { answer: 'ok', build: 'e2e' };
    };
    for (const vp of [{ width: 1280, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'phone' }]) {
      SENT.length = 0;
      const { page, ctx, errors } = await openPanel({ width: vp.width, height: vp.height }, byQuestion);
      /* 1. the week's scan: a verified edge */
      const a1 = await ask(page, R.scan_week.question, 1);
      const w = await lastAnswer(page);
      chk(vp.tag + ': the cross-sport question reached the server', a1.reached_server && SENT[0] && SENT[0].desk === true);
      chk(vp.tag + ': the verdict chip is the multi-sport desk\'s (no independent model priced the Bills, so research only), and the captured-price auditor\'s Verified candidate is a labelled benchmark chip', w && /research only/i.test(w.chip || '') && /^Benchmark: Verified candidate$/i.test(w.bench || ''), w && [w.chip, w.bench]);
      const wc = w && w.card;
      chk(vp.tag + ': the Phase-2 fields are all on the card (event, sport, market and venue in its header and price)', wc && /Detroit Lions @ Buffalo Bills/.test(wc.sub) && /NFL/.test(wc.sub) && wc.title === 'Buffalo Bills -2.5' && /at FanDuel/.test(wc.kv['Verified market price'] || '')
        && ['Verified market price', 'Fair probability', 'Break-even probability', 'Estimated net EV', 'Model reliability', 'Research freshness', 'Why the model disagrees with the market', 'Primary matchup advantage', 'Strongest counterargument', 'What would invalidate the opportunity', 'Audit status'].every((k) => wc.keys.includes(k)) && /max price -112/.test(wc.kv['Estimated net EV'] || ''), wc && [wc.title, wc.sub, wc.keys]);
      chk(vp.tag + ': the final status reads VERIFIED CANDIDATE, Buffalo Bills -2.5', wc && wc.chip === 'Verified candidate' && /final status VERIFIED CANDIDATE/.test(wc.kv['Audit status'] || '') && wc.title === 'Buffalo Bills -2.5', wc && [wc.chip, wc.kv['Audit status']]);
      chk(vp.tag + ': the evidence is there to expand: the card\'s four sections and the answer\'s own', wc && ['Matchup research', 'Model calculations', 'Market comparison', 'Audit findings'].every((k) => wc.more.includes(k)) && ['Confidence — four separate measures', 'Coverage', 'Research level and cost', 'Historical performance'].every((k) => w.sections.includes(k)), w && [wc && wc.more, w.sections]);
      const links = await page.evaluate(() => { const r = [...document.querySelectorAll('#edaiLog .qd-read')].pop(); return r ? [...r.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), rel: a.getAttribute('rel') })) : []; });
      chk(vp.tag + ': the numbered sources are https links that open safely', links.length >= 2 && links.every((l) => /^https:\/\//.test(l.href) && /noopener/.test(l.rel || '')), links);
      chk(vp.tag + ': the audit findings list the seven professional checks and the fifteen audit checks', wc && wc.checkRows >= 8 && wc.auditRows >= 16, wc && [wc.checkRows, wc.auditRows]);
      chk(vp.tag + ': the source line says no model wrote it', w && /no model wrote this/.test(w.src), w && w.src);
      if (vp.tag === 'phone') {
        const geom = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, panelW: document.getElementById('edaiPanel').getBoundingClientRect().width }));
        chk('phone: the page does not scroll sideways', geom.sw <= geom.iw + 1, geom);
        chk('phone: the card\'s fields are one column', wc && wc.kvCols === 1, wc && wc.kvCols);
      } else chk('desktop: the card fits the panel, nothing cut off sideways', wc && wc.fits, wc && wc.fits);
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
      chk(vp.tag + ': no verified trade: the chip says research only, the benchmark Watchlist, never Verified', s24 && /research only/i.test(s24.chip || '') && /^Benchmark: Watchlist$/i.test(s24.bench || '') && !/^verified/i.test(s24.chip || '') && /No verified positive-EV trade/.test(s24.text), s24 && [s24.chip, s24.bench, s24.text.slice(0, 160)]);
      chk(vp.tag + ': …and the final status reads WATCHLIST', s24 && s24.card && /final status WATCHLIST/.test(s24.card.kv['Audit status'] || ''), s24 && s24.card && s24.card.kv['Audit status']);

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

      /* 6. a price attached to neither team: nothing is priced, and the chip says so */
      await ask(page, R.contract_ambiguous.question, 5);
      const amb = await lastAnswer(page);
      chk(vp.tag + ': an unattached price renders as Unverified data with the "which side" request, no edge chip', amb && /unverified/i.test(amb.chip || '') && /say which side/.test(amb.text) && !/verified edge|potential edge/i.test(amb.chip || ''), amb && [amb.chip, amb.text.slice(0, 300)]);

      /* 7. the slate investigation: the discrepancy table opens by default, the survivor is the chip */
      await ask(page, R2.research_slate.question, 6);
      const sl = await lastAnswer(page);
      chk(vp.tag + ': the slate investigation renders with the auditor\'s chip (Verified candidate)', sl && /verified candidate/i.test(sl.chip || '') && /Survived the audit: Buffalo Bills -2\.5/.test(sl.text), sl && [sl.chip, sl.text.slice(0, 200)]);
      chk(vp.tag + ': …with every game\'s model, market and readiness, and the candidate\'s checks to expand', sl && sl.card && ['Matchup research', 'Model calculations', 'Market comparison', 'Audit findings'].every((k) => sl.card.more.includes(k)) && sl.results.some((r) => /^Every game — model, market, readiness/.test(r.s)) && ['Research level and cost'].every((k) => sl.sections.includes(k)), sl && [sl.card && sl.card.more, sl.results, sl.sections]);
      const slRows = sl && sl.results.find((r) => /^Every game — model, market, readiness/.test(r.s));
      chk(vp.tag + ': the every-game table is open and lists the games', slRows && slRows.open && slRows.games >= 4, slRows);
      /* 8. the betting-history answer: no verdict chip, the reader's own figures, past only */
      await ask(page, R2.bets.question, 7);
      const bt = await lastAnswer(page);
      chk(vp.tag + ': the betting-history answer renders, with no verdict chip', bt && !bt.chip && /You lost \$183\.55/.test(bt.text) && /Parlays were more profitable/.test(bt.text), bt && [bt.chip, bt.text.slice(0, 200)]);
      chk(vp.tag + ': …the singles/parlays table is open, and the page says past results only', bt && bt.sections.includes('Singles, parlays and where the money went') && /do not predict future results/.test(await page.evaluate(() => document.getElementById('edaiLog').innerText)), bt && bt.sections);
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, 'quant-bets-' + vp.tag + '.png'), fullPage: false });
      if (vp.tag === 'phone') { const g2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); chk('phone: still no sideways scroll after the slate and bets answers', g2.sw <= g2.iw + 1, g2); }

      /* 9. the multi-sport desk, 2026-10-15 at 8 AM Chicago: research across every sport, nothing verified */
      await ask(page, R3.oct15.question, 8);
      const ms = await lastAnswer(page);
      chk(vp.tag + ': the multi-sport answer renders with its own verdict chip (research only — no verified edge)', ms && /research only/i.test(ms.chip || '') && /^BEST VERIFIED OPPORTUNITY/.test(ms.text.split('\n').slice(1).join('\n').trim() || ms.text) , ms && [ms.chip, ms.text.slice(0, 120)]);
      chk(vp.tag + ': …the best researched matchup is the NHL game, with its probability and validation as separate lines', ms && /BEST RESEARCHED MATCHUP/.test(ms.text) && /Calgary Flames @ Vegas Golden Knights/.test(ms.text) && ms.allKeys.includes('Modeled probability') && ms.allKeys.includes('Model reliability') && ms.allKeys.includes('Freshness (separate from reliability)') && ms.allKeys.includes('Price to watch'), ms && ms.allKeys);
      const covT = await page.evaluate(() => { const box = [...document.querySelectorAll('#edaiLog .qd-read')].pop().parentElement; const d = [...box.querySelectorAll('details.qd-more')].find((x) => /^Coverage — every sport, models first/.test(x.querySelector('summary').textContent)); if (!d) return null; return { open: d.open, rows: [...d.querySelectorAll('.qd-cov-r')].map((r) => ({ sport: r.dataset.sport, events: r.dataset.events, researched: r.dataset.researched, label: r.querySelector('.qd-cov-h').textContent, blockers: (r.querySelector('.qd-cov-b') || {}).textContent || '', fits: r.scrollWidth <= r.clientWidth + 1 })) }; });
      chk(vp.tag + ': the per-sport coverage table is open: NHL 11 discovered and researched, NBA blocked as preseason, MLB without a projection', covT && covT.open && covT.rows.some((r) => r.label === 'NHL' && r.events === '11' && r.researched === '11') && covT.rows.some((r) => r.label === 'NBA' && /preseason/.test(r.blockers)) && covT.rows.some((r) => r.label === 'MLB' && /no per-game MLB projection/.test(r.blockers)) && covT.rows.every((r) => r.fits), covT);
      chk(vp.tag + ': …and the captured-price result is a labelled benchmark section, never the verdict', ms && /MARKET BENCHMARK/.test(ms.text) && !/^Benchmark: Verified/i.test(ms.bench || ''), ms && ms.bench);
      /* every odds integration off: the captured-price audit never ran, so no benchmark chip is shown (it would read "Pass") */
      await ask(page, "What's the best researched opportunity tonight with the odds off?", 9);
      const off = await lastAnswer(page);
      chk(vp.tag + ': odds off: the research answer renders with its research-only chip and NO benchmark chip (the benchmark did not run)', off && /research only/i.test(off.chip || '') && off.bench === null && /odds integrations are disabled/.test(off.text), off && [off.chip, off.bench]);
      if (SHOTS) {
        await page.evaluate(() => [...document.querySelectorAll('#edaiLog .qd-read')].pop().scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(SHOT_DIR, 'quant-multisport-' + vp.tag + '.png'), fullPage: false });
        await page.evaluate(() => { const box = [...document.querySelectorAll('#edaiLog .qd-read')].pop().parentElement; const d = [...box.querySelectorAll('details.qd-more')].find((x) => /^Coverage — every sport/.test(x.querySelector('summary').textContent)); if (d) d.scrollIntoView({ block: 'start' }); });
        await page.screenshot({ path: path.join(SHOT_DIR, 'quant-multisport-coverage-' + vp.tag + '.png'), fullPage: false });
      }
      if (vp.tag === 'phone') { const g3 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); chk('phone: no sideways scroll with the multi-sport answer and its coverage table', g3.sw <= g3.iw + 1, g3); }
      chk(vp.tag + ': no page errors', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) { fail++; failures.push({ name: 'the suite threw', detail: String(e && e.stack || e).slice(0, 600) }); }
  await browser.close();
  site.srv.close();
  done();
})();
