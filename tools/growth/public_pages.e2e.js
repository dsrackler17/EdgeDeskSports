#!/usr/bin/env node
/* ===========================================================================
   THE PUBLIC GROWTH PAGES IN A REAL BROWSER, at a phone (390) and a desktop
   (1280), served the way GitHub Pages serves them (a directory without its
   slash answers 301), with every Supabase call answered locally and recorded.

     TOOLS      the no-vig calculator renders −110/−110 as 50%/+100 on load,
                recomputes on input, names a bad price, records ONE tool_used;
                the fair odds calculator prints the EV at the reader's number;
                the explorer draws the public board, filters it, links a row
                to its published article where there is one
     ARTICLE    a published research page: the trial call to action above
                the fold on a desktop and reachable on a phone, ≥44 px; a
                public_page_view and an acquisition visit carrying the search
                referrer; the CTA press counted
     NEWSLETTER the signup posts the topics, the separate product consent and
                the honeypot, and counts one signup; the confirm page calls
                nothing until the button is pressed; the manage page reads,
                then saves the four topics
     EVERYWHERE nothing wider than the screen; no script error; the trial
                terms as lib/edgedesk_pricing.js words them

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run: node tools/growth/public_pages.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const PRICING = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}

/* the committed board, its clock moved so its newest capture is 30 minutes ago */
function liveBoard() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'home', 'fixtures', 'public_home_board.json'), 'utf8'));
  const s = JSON.stringify(raw.payload || raw);
  const ts = [...s.matchAll(/"(captured_at|computed_at|as_of)":"([^"]+)"/g)].map((m) => Date.parse(m[2])).filter(isFinite);
  const delta = Date.now() - 30 * 60000 - Math.max.apply(null, ts);
  return JSON.parse(s.replace(/"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))"/g, (m, t) => '"' + new Date(Date.parse(t) + delta).toISOString() + '"'));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      let p = decodeURIComponent(u);
      const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!abs.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
      /* GitHub Pages: a directory without its slash is a 301 */
      if (!p.endsWith('/') && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { res.writeHead(301, { location: u + '/' }); res.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { pw = null; }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  const BASE = 'http://127.0.0.1:' + site.port;
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const BOARD = liveBoard();
  const PUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'articles', 'data', 'published.json'), 'utf8'));
  /* make one board row a published game, so the explorer's article link is exercised */
  const pre = PUB.articles.find((a) => a.type === 'pregame');
  if (BOARD.games && BOARD.games[0] && pre) BOARD.games[0].game_key = String(BOARD.games[0].league) + '|' + pre.game_id;

  async function open(urlPath, viewport, opts) {
    opts = opts || {};
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
    const rec = { events: [], rpc: [], nl: [], errors: [] };
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co/.test(url)) {
        let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) { body = null; }
        if (/rpc\/ed_track/.test(url)) { (body && body.p_events || []).forEach((ev) => rec.events.push(ev)); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
        const m = /rpc\/([a-z_]+)/.exec(url);
        if (m) {
          rec.rpc.push({ fn: m[1], body });
          if (m[1] === 'public_home_board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BOARD) });
          if (m[1] === 'newsletter_confirm') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, email_masked: 'r***@example.com', wants_cfb: true, wants_nfl: false, wants_findings: true, wants_product: false, manage_token: 'b'.repeat(64) }) });
          if (m[1] === 'newsletter_preferences_get') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'confirmed', email_masked: 'r***@example.com', wants_cfb: true, wants_nfl: false, wants_findings: false, wants_product: false }) });
          if (m[1] === 'newsletter_preferences_set') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true, email_masked: 'r***@example.com' }, { wants_cfb: body.p_wants_cfb, wants_nfl: body.p_wants_nfl, wants_findings: body.p_wants_findings, wants_product: body.p_wants_product })) });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        }
        if (/functions\/v1\/newsletter\/subscribe/.test(url)) { rec.nl.push(body); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"state":"check_your_email"}' }); }
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      return route.fulfill({ status: 204, body: '' });   /* fonts, GA: not needed */
    });
    if (opts.referer) await ctx.setExtraHTTPHeaders({ referer: opts.referer });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => rec.errors.push(String(e.message).slice(0, 200)));
    await page.goto(BASE + urlPath, { waitUntil: 'domcontentloaded', referer: opts.referer });
    await page.waitForTimeout(400);
    return { ctx, page, rec };
  }
  const overflow = (page, W) => page.evaluate((w) => {
    const out = [];
    const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(a).overflowX)) return true; } return false; };
    document.querySelectorAll('body *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.right > w + 1 && !clipped(el)) out.push(el.tagName + '.' + el.className); });
    return out.slice(0, 5);
  }, W);
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
  const flush = (page) => page.evaluate(() => window.EDTrack && window.EDTrack.flush(false)).then(() => page.waitForTimeout(250));

  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 860 }]) {
    const tag = '@' + vp.width;

    /* ── the no-vig calculator ───────────────────────────────────────── */
    let o = await open('/tools/no-vig-calculator', vp, { referer: 'https://www.google.com/' });
    chk(tag + ' no-vig: a URL without its slash lands on the page (301)', o.page.url().endsWith('/tools/no-vig-calculator/'), o.page.url());
    let txt = await o.page.textContent('#out');
    chk(tag + ' no-vig: −110/−110 renders 52.38% each, 4.76% overround, a fair +100', /52\.38%/.test(txt) && /4\.76%/.test(txt) && /\+100/.test(txt) && /50\.00%/.test(txt), txt.slice(0, 200));
    chk(tag + ' no-vig: every method side by side, and the working', /Every method, side by side/.test(txt) && /The working/.test(txt) && /Shin/.test(txt));
    await o.page.fill('#o0', '-150'); await o.page.fill('#o1', '+130');
    txt = await o.page.textContent('#out');
    chk(tag + ' no-vig: recomputes on input (−150/+130)', /60\.00%/.test(txt) && /43\.48%/.test(txt), txt.slice(0, 160));
    await o.page.fill('#o1', '+50');
    chk(tag + ' no-vig: a price that cannot be names its side', /Side 2:/.test(await o.page.textContent('#err')) && await o.page.isVisible('#err'));
    await o.page.fill('#o1', '+130'); await o.page.selectOption('#method', 'shin');
    await flush(o.page);
    const used = o.rec.events.filter((e) => e.event === 'tool_used');
    chk(tag + ' no-vig: one tool_used for the page load, however many keystrokes', used.length === 1 && used[0].props.entity === 'no_vig', used);
    chk(tag + ' no-vig: a page view for the tool', o.rec.events.some((e) => e.event === 'public_page_view' && e.props.entity === 'tool:no-vig-calculator'));
    const acq = o.rec.rpc.filter((r) => r.fn === 'acq_track_visit');
    chk(tag + ' no-vig: the acquisition visit carries the search referrer and the landing page', acq.length === 1 && acq[0].body.p_touch.referrer_host === 'www.google.com'
      && acq[0].body.p_touch.landing === '/tools/no-vig-calculator/', acq);
    chk(tag + ' no-vig: nothing wider than the screen', (await overflow(o.page, vp.width)).length === 0, await overflow(o.page, vp.width));
    chk(tag + ' no-vig: the trial terms as lib/edgedesk_pricing.js words them', (await o.page.textContent('body')).indexOf(PRICING.CTA_LINE) >= 0);
    const btn = await o.page.$('a[data-ed-cta="tool_novig_trial"]');
    const bb = btn ? await btn.boundingBox() : null;
    chk(tag + ' no-vig: the trial button is at least 44 px tall', bb && bb.height >= 44, bb);
    chk(tag + ' no-vig: no script error', o.rec.errors.length === 0, o.rec.errors);
    await shot(o.page, 'novig' + vp.width);
    await o.ctx.close();

    /* ── the fair odds calculator ────────────────────────────────────── */
    o = await open('/tools/fair-odds-calculator/', vp);
    txt = await o.page.textContent('#out');
    chk(tag + ' fair odds: 55% is −122 / 1.818, and at −110 the EV is +$5.00 per $100', /-122/.test(txt) && /1\.818/.test(txt) && /\+\$5\.00/.test(txt) && /52\.38%/.test(txt), txt.slice(0, 220));
    await o.page.fill('#prob', '40'); await o.page.fill('#price', '+140');
    txt = await o.page.textContent('#out');
    chk(tag + ' fair odds: a negative EV is shown as negative', /\+150/.test(txt) && /−\$4\.00/.test(txt), txt.slice(0, 220));
    chk(tag + ' fair odds: nothing wider than the screen, no script error', (await overflow(o.page, vp.width)).length === 0 && o.rec.errors.length === 0, o.rec.errors);
    await o.ctx.close();

    /* ── the explorer ────────────────────────────────────────────────── */
    o = await open('/tools/model-vs-market/', vp);
    await o.page.waitForFunction(() => document.querySelectorAll('#games .game').length > 0, null, { timeout: 15000 }).catch(() => {});
    const n = await o.page.$$eval('#games .game', (x) => x.length);
    chk(tag + ' explorer: draws the public board', n === (BOARD.games || []).length && n > 0, n);
    txt = await o.page.textContent('#games');
    chk(tag + ' explorer: each row has EdgeDesk\'s number, the market and the gap', /EdgeDesk fair/.test(txt) && /Market/.test(txt) && /pts/.test(txt));
    chk(tag + ' explorer: no EV and no player props', !/EV/.test(txt) && !/Receiving Yards|Passing Yards/.test(txt));
    chk(tag + ' explorer: a published game links to its free research', await o.page.$('#games a[data-ed-cta="explorer_article"][href="' + pre.url + '"]') !== null);
    await o.page.selectOption('#fLeague', 'nfl');
    const nNfl = await o.page.$$eval('#games .game', (x) => x.length);
    chk(tag + ' explorer: filters by league', nNfl === (BOARD.games || []).filter((g) => g.league === 'nfl').length, nNfl);
    chk(tag + ' explorer: reads only the public board', o.rec.rpc.every((r) => ['public_home_board', 'acq_track_visit', 'affiliate_track_click'].indexOf(r.fn) >= 0), o.rec.rpc.map((r) => r.fn));
    chk(tag + ' explorer: nothing wider than the screen, no script error', (await overflow(o.page, vp.width)).length === 0 && o.rec.errors.length === 0, o.rec.errors);
    await shot(o.page, 'explorer' + vp.width);
    await o.ctx.close();

    /* ── a research article ──────────────────────────────────────────── */
    o = await open('/articles/' + pre.slug + '/', vp, { referer: 'https://www.bing.com/' });
    const top = await o.page.$('a[data-ed-cta="article_trial_top"]');
    const tb = top ? await top.boundingBox() : null;
    chk(tag + ' article: the trial call to action near the top, ≥44 px', tb && tb.height >= 44 && (vp.width < 800 || tb.y < 1900), tb);
    chk(tag + ' article: the free/paid line is stated', /Free research · the full terminal is EdgeDesk Full Access/i.test(await o.page.textContent('.a-trial')));
    await top.click({ noWaitAfter: true }).catch(() => {});
    await o.page.waitForTimeout(300);
    const evs = o.rec.events;
    chk(tag + ' article: a page view naming the article', evs.some((e) => e.event === 'public_page_view' && e.props.entity === 'article:' + pre.slug), evs.map((e) => e.event));
    chk(tag + ' article: the CTA press is counted by name', evs.some((e) => e.event === 'public_cta_clicked' && e.props.cta === 'article_trial_top'), evs.map((e) => e.event + ':' + (e.props.cta || '')));
    chk(tag + ' article: the search referrer reaches acquisition', o.rec.rpc.some((r) => r.fn === 'acq_track_visit' && r.body.p_touch.referrer_host === 'www.bing.com'));
    await o.ctx.close();
    o = await open('/articles/' + pre.slug + '/', vp);
    chk(tag + ' article: nothing wider than the screen, no script error', (await overflow(o.page, vp.width)).length === 0 && o.rec.errors.length === 0, [await overflow(o.page, vp.width), o.rec.errors]);
    await shot(o.page, 'article' + vp.width);
    await o.ctx.close();

    /* ── the newsletter ──────────────────────────────────────────────── */
    o = await open('/newsletter/?from=tool_no_vig', vp);
    await o.page.fill('#nlEmail', 'reader@example.com');
    await o.page.check('#nlCfb'); await o.page.check('#nlFindings'); await o.page.check('#nlProduct'); await o.page.check('#nlConsent');
    await o.page.click('#nlSubmit');
    await o.page.waitForTimeout(500);
    const sub = o.rec.nl[0] || {};
    chk(tag + ' newsletter: posts the topics, the separate product consent, the honeypot and the source', sub.cfb === true && sub.findings === true && sub.product === true
      && sub.product_consent === true && sub.consent === true && sub.website === '' && sub.source === 'nl_tool_no_vig', sub);
    chk(tag + ' newsletter: says check your inbox', /Check your inbox/.test(await o.page.textContent('#nlMsg')));
    await flush(o.page);
    const ns = o.rec.events.filter((e) => e.event === 'newsletter_signup');
    chk(tag + ' newsletter: one signup counted, and no address in it', ns.length === 1 && !JSON.stringify(ns).includes('@'), ns);
    chk(tag + ' newsletter: nothing wider than the screen', (await overflow(o.page, vp.width)).length === 0);
    await o.ctx.close();

    o = await open('/newsletter/confirm/#t=' + 'a'.repeat(64), vp);
    chk(tag + ' confirm: the token leaves the address bar', !/#t=/.test(o.page.url()));
    chk(tag + ' confirm: opening the link calls nothing', o.rec.rpc.length === 0, o.rec.rpc);
    await o.page.click('#go');
    await o.page.waitForTimeout(300);
    chk(tag + ' confirm: the button confirms, with the token', o.rec.rpc.length === 1 && o.rec.rpc[0].fn === 'newsletter_confirm' && o.rec.rpc[0].body.p_token === 'a'.repeat(64));
    chk(tag + ' confirm: says what the reader will get', /You are subscribed/.test(await o.page.textContent('#h')) && /findings/i.test(await o.page.textContent('#topics')));
    chk(tag + ' confirm: offers the reader\'s own preferences link', (await o.page.getAttribute('#manage', 'href')) === '/newsletter/manage/#t=' + 'b'.repeat(64));
    await o.ctx.close();

    o = await open('/newsletter/manage/#t=' + 'c'.repeat(64) + '&unsubscribe=CFB', vp);
    chk(tag + ' manage: opening it only reads', o.rec.rpc.length === 1 && o.rec.rpc[0].fn === 'newsletter_preferences_get', o.rec.rpc);
    chk(tag + ' manage: offers the one-topic unsubscribe the link asked for', await o.page.isVisible('#one') && /college football/.test(await o.page.textContent('#one')));
    await o.page.check('#findings'); await o.page.click('#save');
    await o.page.waitForTimeout(300);
    const set = o.rec.rpc.find((r) => r.fn === 'newsletter_preferences_set');
    chk(tag + ' manage: saves the four topics', set && set.body.p_wants_cfb === true && set.body.p_wants_findings === true && set.body.p_wants_product === false, set);
    chk(tag + ' manage: no script error', o.rec.errors.length === 0, o.rec.errors);
    await o.ctx.close();

    /* ── the tools hub and the partners page ─────────────────────────── */
    for (const p of ['/tools/', '/partners/']) {
      o = await open(p, vp);
      chk(tag + ' ' + p + ': nothing wider than the screen, no script error', (await overflow(o.page, vp.width)).length === 0 && o.rec.errors.length === 0, o.rec.errors);
      chk(tag + ' ' + p + ': a page view', (await flush(o.page), o.rec.events.some((e) => e.event === 'public_page_view')));
      await o.ctx.close();
    }
  }

  await browser.close();
  site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' | public growth pages e2e | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
