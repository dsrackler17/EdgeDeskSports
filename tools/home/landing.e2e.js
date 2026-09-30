#!/usr/bin/env node
/* ===========================================================================
   THE LANDING PAGE, IN A REAL BROWSER, AT SIX WIDTHS AND THREE STATES.

   index.html exactly as it ships, served locally; the two live reads it makes
   are answered from committed data:
     * public_home_board()        tools/home/fixtures/public_home_board.json
                                  (the real SQL's answer over the committed
                                  slate, written by home_sql.test.js)
     * /football/home/board.json  the committed file
   with every capture time moved relative to the browser's clock, so "live"
   means live NOW and "stale" means stale NOW.

   LIVE    at 320 · 375 · 390 · 430 · 768 · 1280:
             nothing wider than the screen (the page clips overflow-x, so a
             scrollWidth check would pass a broken layout — every element's
             box is measured instead); both hero calls to action above the
             fold and at least 44 px tall; the stats ("worth researching" a
             clear minority of the slate), the preview (two RESEARCH/WATCH game
             markets and one player prop — on a phone the prop second, so the
             first two cards are both pillars), the board and the prop table
             filled from the data; no "0" headline; no tout words; the price
             and trial from lib/edgedesk_pricing.js; the hero copy 14 px on a
             phone and as it was on desktop; a visitor's second hero button
             is "See how it works"
   FUNNEL  landing_view on load; cta_clicked for the hero; the live board and
           pricing seen when scrolled to — each once, in batched ed_track calls
   MIDWEEK first kickoff 60 h out, game markets 4 h old, prop prices 2 h
           old — on the capture's schedule: the board, the preview and the
           prop table are filled, nothing reads DATA INCOMPLETE, no age is
           red, and no EV is printed on a price past 90 minutes
   STALE   every capture a day old: no captured price is listed as current —
           no RESEARCH, no DATA INCOMPLETE, no EV; what stays is an NFL
           consensus reference (it has no capture time) and it says so, and the
           prop table says its prices refresh on schedule
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
   kickoffs stay in the future, the first `kickH` hours out (5 by default) */
const TIME_KEYS = /"(captured_at|last_success_at|evaluated_at|computed_at|model_updated_at|market_updated_at|quotes_updated_at|prop_quotes_updated_at|as_of|generated_at|summary_at|first_seen_at)":"([^"]+)"/g;
function shift(obj, newestAgoMs, kickH) {
  const s = JSON.stringify(obj);
  const ts = [...s.matchAll(TIME_KEYS)].map((m) => Date.parse(m[2])).filter(isFinite);
  const d = (Date.now() - newestAgoMs) - Math.max(...ts);
  const kicks = [...s.matchAll(/"(kickoff_at|kickoff)":"([^"]+)"/g)].map((m) => Date.parse(m[2])).filter(isFinite);
  const kd = (Date.now() + (kickH || 5) * 3600e3) - Math.min(...kicks);
  return JSON.parse(s.replace(TIME_KEYS, (m, k, v) => { const t = Date.parse(v); return isFinite(t) ? '"' + k + '":"' + new Date(t + d).toISOString() + '"' : m; })
    .replace(/"(kickoff_at|kickoff)":"([^"]+)"/g, (m, k, v) => { const t = Date.parse(v); return isFinite(t) ? '"' + k + '":"' + new Date(t + kd).toISOString() + '"' : m; }));
}
const RPC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'public_home_board.json'), 'utf8'));
const STAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'home', 'board.json'), 'utf8'));
/* the prop prices in the committed file are a snapshot; for the LIVE case the
   newest is 4 minutes old (FRESH), which the page must print as such */
function scenario(kind) {
  if (kind === 'live') return { rpc: shift(RPC, 15 * 60e3), stat: shift(STAT, 4 * 60e3) };
  if (kind === 'midweek') return { rpc: shift(RPC, 4 * 3600e3, 60), stat: shift(STAT, 2 * 3600e3, 60) };
  if (kind === 'stale') return { rpc: shift(RPC, 26 * 3600e3), stat: shift(STAT, 26 * 3600e3) };
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

  /* elements whose box leaves the screen, outside a deliberate scroller —
     measured against the configured viewport: on a phone the browser widens
     window.innerWidth to fit whatever overflows, which would hide it */
  const overflowing = (page) => page.evaluate((W) => {
    const out = [];
    const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };
    document.querySelectorAll('body *').forEach((el) => {
      if (el.closest('[hidden],dialog:not([open]),.modal:not(.open),noscript,script,style')) return;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const s = getComputedStyle(el); if (s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed') return;
      if ((r.right > W + 1 || r.left < -1) && !clipped(el)) out.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) + ' ' + Math.round(r.left) + '→' + Math.round(r.right));
    });
    return out.slice(0, 6);
  }, page.viewportSize().width);

  const WIDTHS = [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }];
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
      const card = (el) => ({ chip: (el.querySelector('.st') || {}).textContent || '', head: (el.querySelector('.opp-hd b') || {}).textContent || '',
        kicker: (el.querySelector('.opp-k') || {}).textContent || '', cells: [...el.querySelectorAll('.cells .v')].map((v) => v.textContent.trim()),
        where: (el.querySelector('.opp-hd .w') || {}).textContent || '', text: el.innerText, box: el.getBoundingClientRect().right });
      const worth = document.querySelector('#lpStats li[data-k="research"]');
      const sub = getComputedStyle(document.querySelector('.hero .sub')), hs = document.getElementById('heroStart');
      return {
        subFont: sub.fontSize, subLine: sub.lineHeight, second: { text: hs.textContent.trim(), href: hs.getAttribute('href') },
        kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
        games: [...document.querySelectorAll('#lpPrevBody .opp[data-kind="game"]')].map(card),
        props: [...document.querySelectorAll('#lpPrevBody .opp[data-kind="prop"]')].map(card),
        worth: worth.hidden ? null : worth.textContent.replace(/\s+/g, ' ').trim(),
        analyzed: (() => { const li = document.querySelector('#lpStats li[data-k="games_analyzed"]'); return li.hidden ? null : +li.querySelector('b').textContent.replace(/,/g, ''); })(),
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
    /* a phone shows one of each pillar first; wider screens keep the column's order */
    const order = w <= 560 ? 'game,prop,game' : 'game,game,prop';
    chk(w + ': the preview is live: two game markets and one player prop, ' + order, /^Live/.test(r.prevTag) && r.prevCount === 3 && r.kinds.join() === order, [r.prevTag, r.kinds]);
    chk(w + ': a visitor\'s second hero button is "See how it works", to the workflow', r.second.text === 'See how it works' && r.second.href === '#workflow', r.second);
    chk(w + ': the hero copy is 14 px on 20 px lines on a phone (13.5 under 360), as it was above', w <= 560
      ? (r.subFont === (w < 360 ? '13.5px' : '14px') && Math.abs(parseFloat(r.subLine) - parseFloat(r.subFont) * 1.43) < 0.1)
      : (w === 1280 ? r.subFont === '18.5px' && r.subLine === '28.675px' : r.subFont !== '14px'), [r.subFont, r.subLine]);
    chk(w + ': the game markets are RESEARCH / WATCH, each with its market, EdgeDesk number, difference and book',
      r.games.every((g) => (g.chip === 'RESEARCH' || g.chip === 'WATCH') && g.kicker === 'Game market' && g.cells.length === 3 && g.cells.every((v) => v !== '—') && /captured/.test(g.text)), r.games.map((g) => [g.chip, g.cells]));
    const P = r.props[0] || { cells: [], text: '' };
    /* the source line reads "<odds> <book> · captured <age>", whichever book it is */
    chk(w + ': the player prop shows player and prop type, line, projection, difference, status, book and capture',
      P.kicker === 'Player prop' && / · /.test(P.head) && P.cells.length === 3 && P.cells.every((v) => v !== '—') && ['RESEARCH', 'WATCH', 'PASS'].includes(P.chip) && /[+\u2212]\d{3,} [A-Z][A-Za-z .]+ · captured \d+ (min|h) ago/.test(P.text), P);
    chk(w + ': the player prop names its game, with no stray separator', / @ /.test(P.where) && !/^\s*·/.test(P.where), P.where);
    chk(w + ': the preview never labels a card DATA INCOMPLETE', r.chips.length === 3 && r.chips.indexOf('DATA INCOMPLETE') < 0, r.chips);
    chk(w + ': the hero count reads "worth researching" and stays a clear minority of the games analyzed',
      r.worth === null || (/^\d+ worth researching$/.test(r.worth) && r.analyzed && +r.worth.split(' ')[0] <= r.analyzed / 3), [r.worth, r.analyzed]);
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

  /* A FIRST VISIT FROM A SOCIAL LINK: an iPhone SE inside X's in-app browser
     leaves about 548 px of page. Before any scroll the hero must say what
     EdgeDesk is, what it does, that it covers player props, what it costs,
     where to tap, and — from the freshness tile, not a claim — that it is live. */
  {
    const S = await open({ width: 375, height: 548 }, 'live', { search: '?utm_source=x&utm_medium=social' });
    const r = await S.page.evaluate(() => {
      const H = window.innerHeight, upd = document.querySelector('#lpStats li.upd');
      const bottom = (el) => (el && !el.hidden ? Math.round(el.getBoundingClientRect().bottom) : null);
      const sub = document.querySelector('.hero .sub');
      return { H, what: bottom(document.querySelector('.hero h1')), does: bottom(sub), props: /player props/.test(sub.textContent),
        cost: bottom(document.querySelector('.hero .microcta')), price: document.querySelector('.hero .microcta').textContent,
        tap: bottom(document.getElementById('heroBoard')), live: bottom(upd), liveText: upd ? upd.textContent.replace(/\s+/g, ' ').trim() : '',
        next: bottom(document.getElementById('heroStart')), nextText: document.getElementById('heroStart').textContent.trim(),
        second: (() => { const el = document.querySelectorAll('#lpPrevBody .opp[data-kind]')[1]; return el ? { kind: el.getAttribute('data-kind'), top: Math.round(el.getBoundingClientRect().top), text: el.innerText } : null; })() };
    });
    const above = (b) => b !== null && b <= r.H;
    chk('first visit, 375×548: what EdgeDesk is (eyebrow and headline) above the fold', above(r.what), r);
    chk('first visit: what it does, player props named, above the fold', above(r.does) && r.props, r);
    chk('first visit: the price and trial above the fold', above(r.cost) && /\$49\.99/.test(r.price) && /7 days free/.test(r.price), r);
    chk('first visit: the primary call to action above the fold', above(r.tap), r);
    chk('first visit: the live freshness tile above the fold', above(r.live) && /^Updated \d+ min ago$/.test(r.liveText), r);
    chk('first visit: "See how it works" above the fold, beside the board', above(r.next) && r.nextText === 'See how it works', r);
    /* the research module's second card is a live player prop, so a short
       scroll past the first game market shows both pillars */
    chk('first visit: the preview\'s second card is a live player prop', r.second && r.second.kind === 'prop' && /Player prop/i.test(r.second.text) && /captured \d+ (min|h) ago/.test(r.second.text), r.second);
    chk('first visit: no script errors', S.errors.length === 0, S.errors);
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

  /* MIDWEEK: prices on the capture's schedule, hours old */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'midweek');
    const r = await S.page.evaluate(() => ({
      chips: [...document.querySelectorAll('#lpPrevBody .st, #lpBoard .st, #lpPropRows .st, #lpConnBody .st')].map((s) => s.textContent.trim()),
      prevChips: [...document.querySelectorAll('#lpPrevBody .st')].map((s) => s.textContent.trim()),
      kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
      propCard: (document.querySelector('#lpPrevBody .opp[data-kind="prop"]') || { innerText: '' }).innerText,
      boardCards: document.querySelectorAll('#lpBoard > *').length,
      propRows: [...document.querySelectorAll('#lpPropRows tr')].map((tr) => tr.children.length),
      ev: [...document.querySelectorAll('#lpPropRows td[data-l="EdgeDesk EV"]')].map((t) => t.textContent.trim()),
      red: document.querySelectorAll('#lpPrevBody .age.stale, #lpBoard .age.stale, #lpPropRows .age.stale, #lpConnBody .age.stale').length,
      text: ['lpPrevBody', 'lpBoard', 'lpPropRows'].map((id) => document.getElementById(id).innerText).join('\n'),
      propTag: document.getElementById('lpPropTag').textContent
    }));
    chk(vp.width + ' midweek: nothing on the page reads DATA INCOMPLETE', r.chips.length > 0 && r.chips.indexOf('DATA INCOMPLETE') < 0 && !/DATA INCOMPLETE/.test(r.text), r.chips);
    chk(vp.width + ' midweek: no age is printed in red', r.red === 0, r.red);
    chk(vp.width + ' midweek: no stale-price warnings in the copy', !/not a current price|is stale|execution window/i.test(r.text), (r.text.match(/not a current price|is stale|execution window/i) || [])[0]);
    chk(vp.width + ' midweek: the preview holds RESEARCH / WATCH games', r.prevChips.length >= 2 && r.prevChips.every((c) => c === 'RESEARCH' || c === 'WATCH'), r.prevChips);
    chk(vp.width + ' midweek: a prop priced on schedule still takes the prop slot, with its age and no EV', r.kinds.join() === (vp.width <= 560 ? 'game,prop,game' : 'game,game,prop') && /captured \d+ h ago/.test(r.propCard) && !/EdgeDesk EV/.test(r.propCard), [r.kinds, r.propCard]);
    chk(vp.width + ' midweek: the board is filled', r.boardCards > 0, r.boardCards);
    chk(vp.width + ' midweek: the prop table is filled, eight cells a row', r.propRows.length > 0 && r.propRows.every((n) => n === 8), r.propRows);
    chk(vp.width + ' midweek: no EV on a price past 90 minutes, and it says why', r.ev.length > 0 && r.ev.every((t) => /^—/.test(t)) && r.ev.some((t) => /on a fresh price/.test(t)), r.ev);
    chk(vp.width + ' midweek: the prop table is not called live', r.propTag !== 'Live' && /^Priced /.test(r.propTag), r.propTag);
    chk(vp.width + ' midweek: no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await S.page.screenshot({ path: path.join(SHOTS, 'landing-midweek-' + vp.width + '.png'), fullPage: false });
    await S.ctx.close();
  }

  /* STALE: nothing current */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'stale');
    const r = await S.page.evaluate(() => ({
      chips: [...document.querySelectorAll('#lpPrevBody .st, #lpBoard .st, #lpPropRows .st')].map((s) => s.textContent.trim()),
      ev: [...document.querySelectorAll('#lpPropRows td[data-l="EdgeDesk EV"]')].map((t) => t.textContent.trim()),
      rows: document.getElementById('lpPropRows').innerText, propTag: document.getElementById('lpPropTag').textContent,
      cards: [...document.querySelectorAll('#lpBoard > article')].map((a) => a.innerText),
      prevText: document.getElementById('lpPrevBody').innerText,
      kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
      priceEx: document.getElementById('lpPriceEx').innerText,
      prevTag: document.getElementById('lpPrevTag').textContent, prevLive: document.getElementById('lpPrevTag').classList.contains('live'),
      upd: (() => { const li = document.querySelector('#lpStats li[data-k="updated"]'); return { old: li.classList.contains('old'), text: li.textContent }; })(),
      research: (() => { const li = document.querySelector('#lpStats li[data-k="research"]'); return li.hidden ? null : li.querySelector('b').textContent; })()
    }));
    chk(vp.width + ' stale: the preview is not called live', !r.prevLive && /^(Last update|Example)/.test(r.prevTag), r.prevTag);
    chk(vp.width + ' stale: "Last update", not a green "Updated"', r.upd.old && /^Last update/.test(r.upd.text), r.upd);
    chk(vp.width + ' stale: the research-grade headline does not count the games it downgraded', r.research === null || +r.research.replace(/,/g, '') < 4, r.research);
    chk(vp.width + ' stale: no RESEARCH on a stale price, and no wall of DATA INCOMPLETE', r.chips.indexOf('RESEARCH') < 0 && r.chips.indexOf('DATA INCOMPLETE') < 0, r.chips);
    chk(vp.width + ' stale: no prop on a stale price; a third game takes its slot', /Example/.test(r.prevTag) || r.kinds.join() === 'game,game,game', r.kinds);
    chk(vp.width + ' stale: every game still listed is a consensus reference, and says so',
      r.cards.every((t) => /consensus reference, not a captured quote/.test(t)) && (/Example/.test(r.prevTag) || /consensus reference, not a captured quote/.test(r.prevText)), r.cards.map((t) => t.slice(0, 60)));
    chk(vp.width + ' stale: the prop table says its prices refresh on schedule', /refresh on a schedule/.test(r.rows) && r.propTag !== 'Live', [r.rows.slice(0, 80), r.propTag]);
    chk(vp.width + ' stale: no EV printed', r.ev.length === 0, r.ev);
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
