#!/usr/bin/env node
/* ===========================================================================
   THE LANDING PAGE, IN A REAL BROWSER, AT FIVE WIDTHS AND THREE STATES.

   index.html exactly as it ships, served locally; the two live reads it makes
   are answered from committed data:
     * public_home_board()        tools/home/fixtures/public_home_board.json
                                  (the real SQL's answer over the committed
                                  slate, written by home_sql.test.js)
     * /football/home/board.json  the committed file
   with every capture time moved relative to the browser's clock, so "live"
   means live NOW and "stale" means stale NOW.

   LIVE    at 375 · 390 · 430 · 768 · 1280:
             nothing wider than the screen (the page clips overflow-x, so a
             scrollWidth check would pass a broken layout — every element's
             box is measured instead); both hero calls to action above the
             fold and at least 44 px tall; the stats, the preview (2-4 items,
             RESEARCH/WATCH only), the board and the prop table filled from
             the data; no "0" headline; no tout words; the price and trial
             from lib/edgedesk_pricing.js
   FUNNEL  landing_view on load; cta_clicked for the hero; the live board and
           pricing seen when scrolled to — each once, in batched ed_track calls
   STALE   market and prop prices hours old: no RESEARCH label anywhere, no
           EV printed for an expired price, the ageing is labelled
   DOWN    both reads fail: the example card says "Example", the stats hide,
           the board says it could not be reached — nothing pretends to be live

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.

   Run:  node tools/home/landing.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}

/* every capture/compute time moved so the newest is `newestAgoMs` before now;
   kickoffs stay in the future */
const TIME_KEYS = /"(captured_at|last_success_at|evaluated_at|computed_at|model_updated_at|market_updated_at|quotes_updated_at|prop_quotes_updated_at|as_of|generated_at|summary_at|first_seen_at)":"([^"]+)"/g;
function shift(obj, newestAgoMs) {
  const s = JSON.stringify(obj);
  const ts = [...s.matchAll(TIME_KEYS)].map((m) => Date.parse(m[2])).filter(isFinite);
  const d = (Date.now() - newestAgoMs) - Math.max(...ts);
  const kicks = [...s.matchAll(/"(kickoff_at|kickoff)":"([^"]+)"/g)].map((m) => Date.parse(m[2])).filter(isFinite);
  const kd = (Date.now() + 5 * 3600e3) - Math.min(...kicks);
  return JSON.parse(s.replace(TIME_KEYS, (m, k, v) => { const t = Date.parse(v); return isFinite(t) ? '"' + k + '":"' + new Date(t + d).toISOString() + '"' : m; })
    .replace(/"(kickoff_at|kickoff)":"([^"]+)"/g, (m, k, v) => { const t = Date.parse(v); return isFinite(t) ? '"' + k + '":"' + new Date(t + kd).toISOString() + '"' : m; }));
}
const RPC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'public_home_board.json'), 'utf8'));
const STAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'home', 'board.json'), 'utf8'));
/* the prop prices in the committed file are a snapshot; for the LIVE case the
   newest is 4 minutes old (FRESH), which the page must print as such */
function scenario(kind) {
  if (kind === 'live') return { rpc: shift(RPC, 15 * 60e3), stat: shift(STAT, 4 * 60e3) };
  if (kind === 'stale') return { rpc: shift(RPC, 5 * 3600e3), stat: shift(STAT, 4 * 3600e3) };
  return { rpc: null, stat: null };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const BANNED = /\b(lock of the day|locks?\b|guaranteed?|can'?t lose|free money|tail (?:this|us|me)|sure thing|hurry|act now|last chance|only \d+ (?:spots|left)|limited spots)/i;

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(viewport, kind, opts) {
    opts = opts || {};
    const data = scenario(kind);
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
    const events = [], errors = [];
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) {
        if (/\/football\/home\/board\.json/.test(url)) return data.stat ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.stat) }) : route.fulfill({ status: 404, body: '' });
        return route.continue();
      }
      if (/supabase\.co/.test(url)) {
        if (/rpc\/public_home_board/.test(url)) return data.rpc ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data.rpc) }) : route.fulfill({ status: 503, body: '{}' });
        if (/rpc\/ed_track/.test(url)) {
          try { const b = JSON.parse(route.request().postData() || '{}'); (b.p_events || []).forEach((ev) => events.push(ev)); } catch (e) { /* ignore */ }
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + site.port + '/' + (opts.search || ''), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const b = document.getElementById('lpPrevBody');
      return b && !b.classList.contains('loading') && !/Reading the current/.test(document.getElementById('lpPropRows').textContent);
    }, null, { timeout: 20000 });
    return { ctx, page, events, errors };
  }

  /* elements whose box leaves the screen, outside a deliberate scroller */
  const overflowing = (page) => page.evaluate(() => {
    const W = window.innerWidth, out = [];
    const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };
    document.querySelectorAll('body *').forEach((el) => {
      if (el.closest('[hidden],dialog:not([open]),.modal:not(.open),noscript,script,style')) return;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed') return;
      if ((r.right > W + 1 || r.left < -1) && !clipped(el)) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(r.left) + '→' + Math.round(r.right));
    });
    return out.slice(0, 6);
  });

  const WIDTHS = [{ width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }];
  for (const vp of WIDTHS) {
    const w = vp.width;
    let S;
    try { S = await open(vp, 'live'); } catch (e) { chk(w + ': the landing page renders its live board', false, String(e.message).slice(0, 300)); continue; }
    const { page } = S;
    const r = await page.evaluate(() => {
      const box = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, w: b.width }; };
      const stats = [...document.querySelectorAll('#lpStats li[data-k]')].filter((li) => !li.hidden).map((li) => li.querySelector('b').textContent.trim());
      const prev = [...document.querySelectorAll('#lpPrevBody .opp')];
      const chips = [...document.querySelectorAll('#lpPrevBody .st')].map((s) => s.textContent.trim());
      return {
        h1: document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim(),
        eyebrow: (document.querySelector('header .ey, header .eyebrow') || {}).textContent || '',
        board: box('heroBoard'), start: box('heroStart'), vh: window.innerHeight,
        stats, prevCount: prev.length, chips, prevTag: document.getElementById('lpPrevTag').textContent,
        boardCards: document.querySelectorAll('#lpBoard .opp, #lpBoard .gcard, #lpBoard > *').length,
        tilesShown: !document.getElementById('lpTiles').hidden,
        propRows: [...document.querySelectorAll('#lpPropRows tr')].map((tr) => tr.children.length),
        propStatus: [...document.querySelectorAll('#lpPropRows .st')].map((s) => s.textContent.trim()),
        text: document.body.innerText,
        boardText: document.getElementById('lpBoard').innerText, nflOnBoard: /NFL ·/.test(document.getElementById('lpBoard').innerText),
        priceText: [...document.querySelectorAll('#pricing [data-ed-price="price"]')].map((x) => x.textContent.trim()),
        trialText: [...document.querySelectorAll('[data-ed-price="trial"]')].map((x) => x.textContent.trim())
      };
    });
    chk(w + ': the headline', /Find where the model and the market disagree/.test(r.h1), r.h1);
    chk(w + ': both hero calls to action above the fold', r.board && r.start && r.board.bottom <= r.vh && r.start.bottom <= r.vh, [r.board, r.start, r.vh]);
    chk(w + ': and at least 44 px tall', r.board.h >= 44 && r.start.h >= 44, [r.board.h, r.start.h]);
    chk(w + ': live stats shown, none of them a zero', r.stats.length >= 2 && r.stats.every((s) => s && s !== '0'), r.stats);
    chk(w + ': the preview is live with 2-4 items', /^Live/.test(r.prevTag) && r.prevCount >= 2 && r.prevCount <= 4, [r.prevTag, r.prevCount]);
    chk(w + ': the preview labels are RESEARCH / WATCH only', r.chips.length > 0 && r.chips.every((c) => c === 'RESEARCH' || c === 'WATCH'), r.chips);
    chk(w + ': the board and its tiles are filled', r.boardCards > 0 && r.tilesShown);
    chk(w + ': the prop table has rows of eight cells', r.propRows.length > 0 && r.propRows.every((n) => n === 8), r.propRows);
    chk(w + ': prop statuses are the four public words', r.propStatus.every((s) => ['RESEARCH', 'WATCH', 'PASS', 'DATA INCOMPLETE'].includes(s)), r.propStatus);
    /* the page's own refusals ("no locks, no guaranteed winners", "does not
       guarantee profit", the FAQ's "Does EdgeDesk guarantee…? No") are allowed */
    const refusals = /no picks, no locks, no guaranteed winners|does not guarantee profit|Does EdgeDesk guarantee winning bets\?|not picks|never a pick|not a pick/gi;
    chk(w + ': no tout language anywhere', !BANNED.test(r.text.replace(refusals, '')), (r.text.replace(refusals, '').match(BANNED) || [])[0]);
    chk(w + ': an NFL consensus market says it is not a captured quote', !r.nflOnBoard || /consensus reference, not a captured quote/.test(r.boardText), r.boardText.slice(0, 200));
    chk(w + ': the price is the configured one', r.priceText.length > 0 && r.priceText.every((t) => t === X.PRICE_DISPLAY), r.priceText);
    chk(w + ': the trial is the configured one', r.trialText.length > 0 && r.trialText.every((t) => t === X.TRIAL_LABEL), r.trialText.slice(0, 4));
    const ov = await overflowing(page);
    chk(w + ': nothing is wider than the screen', ov.length === 0, ov);
    chk(w + ': no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'landing-' + w + '.png'), fullPage: true });

    if (w === 390) {
      /* the funnel, once: load → scroll the board and pricing into view → hero click */
      await page.evaluate(() => document.getElementById('today').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('pricing').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('today').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.click('#heroBoard');
      await page.click('#heroBoard');
      await page.waitForTimeout(1800);
      const names = S.events.map((e) => e.event);
      const count = (n) => names.filter((x) => x === n).length;
      chk('funnel: landing_view once', count('landing_view') === 1, names);
      chk('funnel: the live board seen once', count('landing_live_board_view') === 1, names);
      chk('funnel: pricing seen once', count('pricing_view') === 1, names);
      chk('funnel: the hero click once, naming its CTA', S.events.filter((e) => e.event === 'cta_clicked' && e.props && e.props.cta === 'hero_board').length === 1, S.events.filter((e) => e.event === 'cta_clicked'));
      chk('funnel: every event carries the path, never a query string or an address', S.events.every((e) => e.page_path === '/' && !/[?@]/.test(JSON.stringify(e))), S.events[0]);
    }
    await S.ctx.close();
  }

  /* utm first-touch */
  {
    const S = await open({ width: 390, height: 844 }, 'live', { search: '?utm_source=Reddit&utm_medium=social&utm_campaign=wk5&email=x@y.z' });
    await S.page.waitForTimeout(1800);
    const lv = S.events.find((e) => e.event === 'landing_view');
    chk('utm: landing_view carries the cleaned campaign, never the rest of the query', lv && lv.utm_source === 'reddit' && lv.utm_medium === 'social' && lv.utm_campaign === 'wk5' && !/x@y|email/.test(JSON.stringify(S.events)), lv);
    await S.ctx.close();
  }

  /* STALE */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'stale');
    const r = await S.page.evaluate(() => ({
      chips: [...document.querySelectorAll('#lpPrevBody .st, #lpBoard .st, #lpPropRows .st')].map((s) => s.textContent.trim()),
      ev: [...document.querySelectorAll('#lpPropRows td[data-l="EdgeDesk EV"]')].map((t) => t.textContent.trim()),
      stale: document.querySelectorAll('#lpPrevBody .age.stale, #lpBoard .age.stale, #lpPropRows .age.stale').length,
      prevText: document.getElementById('lpPrevBody').innerText, propTag: document.getElementById('lpPropTag').textContent,
      priceEx: document.getElementById('lpPriceEx').innerText,
      prevTag: document.getElementById('lpPrevTag').textContent, prevLive: document.getElementById('lpPrevTag').classList.contains('live'),
      upd: (() => { const li = document.querySelector('#lpStats li[data-k="updated"]'); return { old: li.classList.contains('old'), text: li.textContent }; })(),
      research: (() => { const li = document.querySelector('#lpStats li[data-k="research"]'); return li.hidden ? null : li.querySelector('b').textContent; })()
    }));
    chk(vp.width + ' stale: the preview is not called live', !r.prevLive && /^Last update/.test(r.prevTag), r.prevTag);
    chk(vp.width + ' stale: "Last update 5 h ago", not a green "Updated"', r.upd.old && /^Last update/.test(r.upd.text), r.upd);
    chk(vp.width + ' stale: the research-grade headline does not count the games it downgraded', r.research === null || +r.research.replace(/,/g, '') < 4, r.research);
    chk(vp.width + ' stale: no RESEARCH label on a stale price', r.chips.length > 0 && r.chips.indexOf('RESEARCH') < 0, r.chips);
    chk(vp.width + ' stale: games with stale markets are DATA INCOMPLETE', r.chips.indexOf('DATA INCOMPLETE') >= 0);
    chk(vp.width + ' stale: no EV printed for an expired price', r.ev.every((t) => t === '—'), r.ev);
    chk(vp.width + ' stale: the ageing is labelled', r.stale > 0 && r.propTag !== 'Live', [r.stale, r.propTag]);
    chk(vp.width + ' stale: what the preview still labels WATCH is a market that never had a capture time, and it says so',
      /No game clears/.test(r.prevText) || /Example/.test(r.prevText) || /consensus reference, not a captured quote/.test(r.prevText), r.prevText.slice(0, 300));
    chk(vp.width + ' stale: no "right now" EV example from a stale quote', !/Right now:/.test(r.priceEx));
    chk(vp.width + ' stale: no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await S.page.screenshot({ path: path.join(SHOTS, 'landing-stale-' + vp.width + '.png'), fullPage: false });
    await S.ctx.close();
  }

  /* DOWN */
  for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'down');
    await S.page.waitForTimeout(300);
    const r = await S.page.evaluate(() => ({
      tag: document.getElementById('lpPrevTag').textContent, ill: document.getElementById('lpPrevBody').classList.contains('ill'),
      stats: [...document.querySelectorAll('#lpStats li[data-k]')].filter((li) => !li.hidden).length,
      empty: !document.getElementById('lpBoardEmpty').hidden && document.getElementById('lpBoardEmpty').textContent,
      tiles: document.getElementById('lpTiles').hidden, rows: document.getElementById('lpPropRows').textContent,
      example: (document.querySelector('.prev-ill') || { innerText: '' }).innerText
    }));
    chk(vp.width + ' down: the preview is an example and says so', r.tag === 'Example' && r.ill && /not live/i.test(r.example), [r.tag, r.ill, r.example.slice(0, 80)]);
    chk(vp.width + ' down: no stat is shown', r.stats === 0 && r.tiles === true, r.stats);
    chk(vp.width + ' down: the board says it could not be reached', /couldn.t be reached/.test(r.empty || ''), r.empty);
    chk(vp.width + ' down: the prop table says so too', /could not be read/.test(r.rows), r.rows);
    chk(vp.width + ' down: no event claims a live board was seen', S.events.every((e) => e.event !== 'landing_live_board_view'));
    chk(vp.width + ' down: no script errors', S.errors.length === 0, S.errors);
    const ov = await overflowing(S.page);
    chk(vp.width + ' down: nothing wider than the screen', ov.length === 0, ov);
    await S.ctx.close();
  }

  /* the methodology page the long explanations moved to */
  for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'live').catch(() => null);
    if (!S) continue;
    await S.page.goto('http://127.0.0.1:' + site.port + '/methodology/', { waitUntil: 'load' });
    await S.page.waitForTimeout(300);
    const ov = await overflowing(S.page);
    chk(vp.width + ' methodology: nothing wider than the screen', ov.length === 0, ov);
    chk(vp.width + ' methodology: no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await S.page.screenshot({ path: path.join(SHOTS, 'methodology-' + vp.width + '.png'), fullPage: false });
    await S.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' landing page (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
