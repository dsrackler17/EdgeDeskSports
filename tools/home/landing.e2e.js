#!/usr/bin/env node
/* ===========================================================================
   THE LANDING PAGE, IN A REAL BROWSER, AT SIX WIDTHS AND FIVE DATA STATES.

   index.html exactly as it ships, served locally; the two live reads its
   research preview makes are answered from committed data:
     * public_home_board()        tools/home/fixtures/public_home_board.json
                                  (the real SQL's answer over the committed
                                  slate, written by home_sql.test.js)
     * /football/home/board.json  tools/home/fixtures/static_board.json
                                  (the board as build_home.js published it at
                                  2026-09-30T00:46Z, commit 2be399f, with
                                  research-grade NFL props — never the
                                  committed file, whose props every prop run
                                  replaces)
   with every capture time moved relative to the browser's clock, so "live"
   means live NOW and "stale" means stale NOW.

   LIVE    at 320 · 375 · 390 · 430 · 768 · 1280:
             nothing wider than the screen (every element's box is measured,
             since the page clips overflow-x); the hero says "Research, not
             picks" and "Research the game before you bet it."; both hero
             actions above the fold, at least 44 px tall, the first one the
             free research (#free) and the second the trial; beside them a
             free no-vig calculator that works (and says so); the research
             preview (two RESEARCH/WATCH game markets and one player prop — on
             a phone the prop second) and its stats filled from the data; no
             tout words; the price and trial from lib/edgedesk_pricing.js
   FIRST SCREEN  375×548, a first visit inside an in-app browser: the
           eyebrow, the headline, the sentence, both actions, the price and
           the top of the free calculator — labelled Free — before any scroll
   CALC    the hero calculator recomputes on input with the odds library's
           numbers, names a bad price, and records one tool_used
   FREE    #free fills its games from the board and its research from the
           published articles; the free research is reached from the hero
   FUNNEL  landing_view on load; cta_clicked for each hero action, once;
           the live research preview and pricing seen when scrolled to —
           each once; the GA names the reports read (hero_cta_click with its
           legacy hero_trial_click, hero_free_click, how_it_works_click from
           the strip, process_coach_view,
           pricing_view, signup_started) with the hero variant on each
   STICKY  on a phone the sticky call to action appears once the hero's
           buttons scroll away, steps aside at pricing and under an open
           dialog; never on a desktop
   VARIANT ?hero=c shows that headline and every GA event says so
   NOTHING QUALIFIES / MIDWEEK / STALE / DOWN  the research preview tells
           the truth about the data it has: no RESEARCH on a stale price, no
           EV past the execution window, an example that says so when the
           reads fail, and no stat it could not read

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
/* the published board is a committed fixture, never football/home/board.json:
   a prop run with nothing research-grade publishes props.items {} (a valid
   slate), and the preview's prop would then be a game's own, or the board's,
   for reasons of the day's data. Both are tested, each on purpose. */
const STAT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'static_board.json'), 'utf8'));
const BOARD_PLAYERS = Object.values(STAT.props.items).map((p) => p.player.name);
const GAME_PLAYERS = [].concat(...RPC.games.map((g) => (g.props && g.props.top || []).map((p) => p.player.name)));
/* the same board on a slate where no prop qualifies, as a prop run can
   publish it: no items, no top lists, zero research-grade */
function nothingQualifies(board) {
  const b = JSON.parse(JSON.stringify(board));
  b.props.items = {}; b.props.top = [];
  Object.values(b.props.counts).forEach((c) => { c.research_grade = 0; });
  Object.values(b.props.by_game).forEach((g) => { g.research_grade = 0; delete g.top; });
  return b;
}
/* the prop prices in the fixture are a snapshot; for the LIVE case the
   newest is 4 minutes old (FRESH), which the page must print as such */
function scenario(kind) {
  if (kind === 'live') return { rpc: shift(RPC, 15 * 60e3), stat: shift(STAT, 4 * 60e3) };
  if (kind === 'none') return { rpc: shift(RPC, 15 * 60e3), stat: shift(nothingQualifies(STAT), 4 * 60e3) };
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
      return b && !b.classList.contains('loading');
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

  /* a preview prop card in full: player and prop type, line, projection,
     difference, status, and a source line "<odds> <book> · captured <age>",
     whichever book it is */
  const propCardFull = (P) => P.kicker === 'Player prop' && / · /.test(P.head) && P.cells.length === 3 && P.cells.every((v) => v !== '—')
    && ['RESEARCH', 'WATCH', 'PASS'].includes(P.chip) && /[+\u2212]\d{3,} [A-Z][A-Za-z .]+ · captured \d+ (min|h) ago/.test(P.text);
  const propOf = (players, P) => players.some((n) => P.head.indexOf(n + ' · ') === 0);

  /* the page's own refusals are allowed to name what it refuses */
  const REFUSALS = /no picks, no locks, no guaranteed winners|No locks\. No guarantees\.|Does EdgeDesk guarantee I.ll make money\?|does not guarantee profit|not picks|never a pick|not a pick/gi;
  /* GA events the page pushed (gtag writes to dataLayer whether or not the
     tag itself loaded — here it never does) */
  const gaEvents = (page) => page.evaluate(() => (window.dataLayer || []).filter((a) => a && a[0] === 'event').map((a) => ({ name: a[1], params: a[2] || {} })));

  const WIDTHS = [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }];
  for (const vp of WIDTHS) {
    const w = vp.width;
    let S;
    try { S = await open(vp, 'live'); } catch (e) { chk(w + ': the landing page renders its live research preview', false, String(e.message).slice(0, 300)); continue; }
    const { page } = S;
    const r = await page.evaluate(() => {
      const box = (id) => { const el = document.getElementById(id); if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, w: b.width, x: b.left, y: b.top }; };
      const stats = [...document.querySelectorAll('#lpStats li[data-k]')].filter((li) => !li.hidden).map((li) => li.querySelector('b').textContent.trim());
      const card = (el) => ({ chip: (el.querySelector('.st') || {}).textContent || '', head: (el.querySelector('.opp-hd b') || {}).textContent || '',
        kicker: (el.querySelector('.opp-k') || {}).textContent || '', cells: [...el.querySelectorAll('.cells .v')].map((v) => v.textContent.trim()),
        where: (el.querySelector('.opp-hd .w') || {}).textContent || '', text: el.innerText });
      const worth = document.querySelector('#lpStats li[data-k="research"]');
      const hs = document.getElementById('heroStart'), hc = document.getElementById('heroCta');
      const dash = document.querySelector('.hero .dash');
      return {
        second: { text: hs.textContent.trim(), href: hs.getAttribute('href') }, primary: hc.textContent.replace(/\s+/g, ' ').trim(),
        kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
        games: [...document.querySelectorAll('#lpPrevBody .opp[data-kind="game"]')].map(card),
        props: [...document.querySelectorAll('#lpPrevBody .opp[data-kind="prop"]')].map(card),
        worth: worth.hidden ? null : worth.textContent.replace(/\s+/g, ' ').trim(),
        analyzed: (() => { const li = document.querySelector('#lpStats li[data-k="games_analyzed"]'); return li.hidden ? null : +li.querySelector('b').textContent.replace(/,/g, ''); })(),
        h1: document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim(),
        eyebrow: (document.querySelector('header .ey') || {}).textContent || '',
        dashBar: dash ? dash.querySelector('.panel-bar').innerText : '', dashFoot: dash ? dash.querySelector('.panel-foot').innerText : '',
        cta: box('heroCta'), start: box('heroStart'), vh: window.innerHeight,
        stats, chips: [...document.querySelectorAll('#lpPrevBody .st')].map((s) => s.textContent.trim()), prevTag: document.getElementById('lpPrevTag').textContent,
        text: document.body.innerText,
        mbar: !document.getElementById('mbar').hidden,
        priceText: [...document.querySelectorAll('#pricing [data-ed-price="price"]')].map((x) => x.textContent.trim()),
        trialText: [...document.querySelectorAll('[data-ed-price="trial"]')].map((x) => x.textContent.trim())
      };
    });
    chk(w + ': the eyebrow is "Research, not picks."', /Research, not picks\./i.test(r.eyebrow), r.eyebrow);
    chk(w + ': the headline', r.h1 === 'Research the game before you bet it.', r.h1);
    chk(w + ': both hero calls to action above the fold', r.cta && r.start && r.cta.bottom <= r.vh && r.start.bottom <= r.vh, [r.cta, r.start, r.vh]);
    chk(w + ': and at least 44 px tall', r.cta.h >= 44 && r.start.h >= 44, [r.cta.h, r.start.h]);
    chk(w + ': the first is the free research (#free), the second the free trial', /^Explore free research/.test(r.second.text) && r.second.href === '#free' && /^Start free trial/.test(r.primary), [r.second, r.primary]);
    chk(w + ': the free research leads, left of or above the trial', r.start.x < r.cta.x || r.start.y < r.cta.y, [r.start, r.cta]);
    chk(w + ': beside them, a free calculator that says so, and no sample of a feature in development', /Free/i.test(r.dashBar) && !/In development|Sample data/i.test(r.dashBar + r.dashFoot) && /Not a prediction/.test(r.dashFoot), [r.dashBar, r.dashFoot]);
    chk(w + ': live stats shown, none of them a zero', r.stats.length >= 2 && r.stats.every((s) => s && s !== '0'), r.stats);
    /* a phone shows one of each pillar first; wider screens keep the column's order */
    const order = w <= 560 ? 'game,prop,game' : 'game,game,prop';
    chk(w + ': the research preview is live: two game markets and one player prop, ' + order, /^Live/.test(r.prevTag) && r.kinds.join() === order, [r.prevTag, r.kinds]);
    chk(w + ': the game markets are RESEARCH / WATCH, each with its market, EdgeDesk number, difference and book',
      r.games.every((g) => (g.chip === 'RESEARCH' || g.chip === 'WATCH') && g.kicker === 'Game market' && g.cells.length === 3 && g.cells.every((v) => v !== '—') && /captured/.test(g.text)), r.games.map((g) => [g.chip, g.cells]));
    const P = r.props[0] || { head: '', cells: [], text: '' };
    chk(w + ': the player prop shows player and prop type, line, projection, difference, status, book and capture', propCardFull(P), P);
    chk(w + ': the player prop is the published board\'s, research-grade on a current price', P.chip === 'RESEARCH' && propOf(BOARD_PLAYERS, P) && /captured \d+ min ago/.test(P.text), P);
    chk(w + ': the player prop names its game, with no stray separator', / @ /.test(P.where) && !/^\s*·/.test(P.where), P.where);
    chk(w + ': the preview never labels a card DATA INCOMPLETE', r.chips.length === 3 && r.chips.indexOf('DATA INCOMPLETE') < 0, r.chips);
    chk(w + ': the count reads "worth researching" and stays a clear minority of the games analyzed',
      r.worth === null || (/^\d+ worth researching$/.test(r.worth) && r.analyzed && +r.worth.split(' ')[0] <= r.analyzed / 3), [r.worth, r.analyzed]);
    chk(w + ': no tout language anywhere', !BANNED.test(r.text.replace(REFUSALS, '')), (r.text.replace(REFUSALS, '').match(BANNED) || [])[0]);
    chk(w + ': the price is the configured one', r.priceText.length > 0 && r.priceText.every((t) => t === X.PRICE_DISPLAY), r.priceText);
    chk(w + ': the trial is the configured one', r.trialText.length > 0 && r.trialText.every((t) => t === X.TRIAL_LABEL), r.trialText.slice(0, 4));
    chk(w + ': the sticky call to action is not shown at the top of the page', !r.mbar);
    const ov = await overflowing(page);
    chk(w + ': nothing is wider than the screen', ov.length === 0, ov);
    chk(w + ': no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'landing-' + w + '.png'), fullPage: true });

    if (w === 390) {
      /* THE STICKY CALL TO ACTION: past the hero it appears; at pricing it
         steps aside; under an open dialog it is gone */
      const bar = () => page.evaluate(() => !document.getElementById('mbar').hidden);
      await page.evaluate(() => document.getElementById('how').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      chk('sticky: shown on a phone once the hero\'s buttons have scrolled away', await bar());
      await page.evaluate(() => document.getElementById('pricing').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      chk('sticky: steps aside while the pricing card is on screen', !(await bar()));
      await page.evaluate(() => document.getElementById('history').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(300);
      chk('sticky: back after pricing scrolls away', await bar());
      await page.click('#mbar .btn');
      await page.waitForSelector('#authModal.on', { timeout: 5000 });
      await page.waitForTimeout(200);
      chk('sticky: opens the trial flow, and is gone under the dialog', !(await bar()));
      await page.evaluate(() => { closeAuth(); });

      /* the funnel, once each: load → research preview, coach and pricing
         seen → each hero action pressed (twice: still counted once) */
      await page.evaluate(() => document.getElementById('coach').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('lpPreview').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('pricing').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.click('#heroStart');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.click('#heroStart');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.click('.strip-how');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.click('#heroCta');
      await page.waitForSelector('#authModal.on', { timeout: 5000 });
      await page.waitForTimeout(1800);
      const names = S.events.map((e) => e.event);
      const count = (n) => names.filter((x) => x === n).length;
      const ctas = (c) => S.events.filter((e) => e.event === 'cta_clicked' && e.props && e.props.cta === c).length;
      chk('funnel: landing_view once', count('landing_view') === 1, names);
      chk('funnel: the live research preview seen once', count('landing_live_board_view') === 1, names);
      chk('funnel: pricing seen once', count('pricing_view') === 1, names);
      chk('funnel: "Explore free research" once, however often it is pressed', ctas('hero_free') === 1, S.events.filter((e) => e.event === 'cta_clicked'));
      chk('funnel: "How Full Access works" from the strip', ctas('strip_how') === 1, S.events.filter((e) => e.event === 'cta_clicked'));
      chk('funnel: the hero trial click, naming its CTA', ctas('hero_trial') === 1, S.events.filter((e) => e.event === 'cta_clicked'));
      chk('funnel: the sticky trial click, naming its CTA', ctas('sticky_trial') === 1, S.events.filter((e) => e.event === 'cta_clicked'));
      chk('funnel: the sign-up form opening is signup_started', count('signup_started') >= 1, names);
      chk('funnel: every event carries the path, never a query string or an address', S.events.every((e) => e.page_path === '/' && !/[?@]/.test(JSON.stringify(e))), S.events[0]);
      const ga = await gaEvents(page), gn = ga.map((x) => x.name);
      ['landing_page_view', 'hero_cta_click', 'hero_trial_click', 'hero_free_click', 'how_it_works_click', 'hero_how_click', 'process_coach_view', 'pricing_view', 'signup_started', 'sticky_cta_click']
        .forEach((n) => chk('GA: ' + n + ' is sent', gn.indexOf(n) >= 0, gn));
      chk('GA: the page\'s own events carry the hero variant', ga.filter((x) => /_click$|_view$/.test(x.name)).every((x) => x.params.hero_variant === 'a'), ga.slice(0, 4));
      chk('GA: nothing personal is sent', !/@|password|access_token/.test(JSON.stringify(ga)), ga);
    }
    await S.ctx.close();
  }

  /* A FIRST VISIT FROM A SOCIAL LINK: an iPhone SE inside X's in-app browser
     leaves about 548 px of page. Before any scroll the page must say what
     EdgeDesk is, what it does, what it costs, where to tap, and show the top
     of the product — labelled for what it is. */
  {
    const S = await open({ width: 375, height: 548 }, 'live', { search: '?utm_source=x&utm_medium=social' });
    const r = await S.page.evaluate(() => {
      const H = window.innerHeight;
      const bottom = (el) => (el && !el.hidden ? Math.round(el.getBoundingClientRect().bottom) : null);
      const top = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
      const bar = document.querySelector('.hero .dash .panel-bar');
      return { H, ey: bottom(document.querySelector('.hero .ey')), what: bottom(document.querySelector('.hero h1')), does: bottom(document.querySelector('.hero .sub')),
        cost: bottom(document.querySelector('.hero .microcta')), price: document.querySelector('.hero .microcta').textContent,
        tap: bottom(document.getElementById('heroCta')), next: bottom(document.getElementById('heroStart')),
        dashTop: top(bar), dashBar: bottom(bar), label: bar ? bar.innerText : '' };
    });
    const above = (b) => b !== null && b <= r.H;
    chk('first visit, 375×548: "Research, not picks." and the headline above the fold', above(r.ey) && above(r.what), r);
    chk('first visit: what it does, above the fold', above(r.does), r);
    chk('first visit: the price and trial above the fold', above(r.cost) && /\$49\.99/.test(r.price) && /7 days free/.test(r.price), r);
    chk('first visit: both calls to action above the fold', above(r.tap) && above(r.next), r);
    chk('first visit: the top of the free calculator shows, labelled Free', r.dashTop !== null && r.dashTop < r.H && above(r.dashBar) && /Free/i.test(r.label), r);
    chk('first visit: no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  /* utm first-touch, and a desktop never shows the sticky bar */
  {
    const S = await open({ width: 390, height: 844 }, 'live', { search: '?utm_source=Reddit&utm_medium=social&utm_campaign=wk5&email=x@y.z' });
    await S.page.waitForTimeout(1800);
    const lv = S.events.find((e) => e.event === 'landing_view');
    chk('utm: landing_view carries the cleaned campaign, never the rest of the query', lv && lv.utm_source === 'reddit' && lv.utm_medium === 'social' && lv.utm_campaign === 'wk5' && !/x@y|email/.test(JSON.stringify(S.events)), lv);
    await S.ctx.close();
    const D = await open({ width: 1280, height: 900 }, 'live');
    await D.page.evaluate(() => document.getElementById('how').scrollIntoView({ block: 'start', behavior: 'instant' }));
    await D.page.waitForTimeout(300);
    chk('sticky: never on a desktop', await D.page.evaluate(() => getComputedStyle(document.getElementById('mbar')).display === 'none'));
    await D.ctx.close();
  }

  /* A HERO VARIANT, previewed: one predefined headline, and the GA events say
     which one the reader saw */
  {
    const S = await open({ width: 1280, height: 900 }, 'live', { search: '?hero=c' });
    await S.page.click('#heroStart');
    const h1 = await S.page.evaluate(() => document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim());
    const ga = await gaEvents(S.page);
    chk('variant c: its headline is shown', h1 === 'Research the bet. Track the result. Improve the process.', h1);
    chk('variant c: the GA events carry it', ga.filter((x) => x.name === 'hero_free_click').every((x) => x.params.hero_variant === 'c') && ga.some((x) => x.name === 'hero_free_click'), ga);
    await S.ctx.close();
    const P = await open({ width: 1280, height: 900 }, 'live', { search: '?hero=p' });
    chk('variant p: the process headline that led before free research is kept', (await P.page.evaluate(() => document.querySelector('h1').textContent.replace(/\s+/g, ' ').trim())) === 'Bet with a process. Know what’s working.');
    await P.ctx.close();
    {
      /* THE HERO CALCULATOR AND #free, at a phone and a desktop */
      const OT = require(path.join(ROOT, 'lib', 'edgedesk_odds_tools.js'));
      const PUB = JSON.parse(fs.readFileSync(path.join(ROOT, 'articles', 'data', 'published.json'), 'utf8'));
      for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
        const C = await open(vp, 'live');
        const tag = vp.width + ' calc';
        const read = () => C.page.evaluate(() => ({ pa: $t('hcPa'), pb: $t('hcPb'), oa: $t('hcOa'), vig: $t('hcVig'),
          err: document.getElementById('hcErr').hidden ? null : $t('hcErr'), badB: document.getElementById('hcB').getAttribute('aria-invalid') }));
        await C.page.evaluate(() => { window.$t = (id) => document.getElementById(id).textContent.trim(); });
        await C.page.fill('#hcA', '-110'); await C.page.fill('#hcB', '-110');
        let v = await read();
        const want = OT.noVig(['-110', '-110'], { method: 'proportional' });
        chk(tag + ': recomputes with the odds library: -110/-110 is 50/50 with the margin out',
          v.pa === (want.outcomes[0].fair * 100).toFixed(2) + '%' && v.pb === '50.00%' && v.vig === (want.overround * 100).toFixed(2) + '%' && /\+100|−100/.test(v.oa), v);
        await C.page.fill('#hcB', 'abc');
        v = await read();
        chk(tag + ': names a bad price, on the field that has it', !!v.err && /not a price/.test(v.err) && v.badB === 'true', v);
        await C.page.fill('#hcB', '+250');
        v = await read();
        chk(tag + ': prices that cannot be one market are named, and no single field is blamed', !!v.err && /implied probability/.test(v.err) && v.badB === null, v);
        await C.page.fill('#hcB', '-105');
        v = await read();
        chk(tag + ': and it recovers when they are fixed', v.err === null && v.badB === null && /%$/.test(v.pa) && v.pa !== '50.00%', v);
        await C.page.evaluate(() => window.EDTrack && window.EDTrack.flush(false));
        await C.page.waitForTimeout(300);
        const used = C.events.filter((e) => e.event === 'tool_used');
        chk(tag + ': one tool_used for the calculator, however many prices are typed', used.length === 1 && used[0].props && used[0].props.entity === 'no_vig_home', used);
        /* #free: the board's games, the published research, and a way in from the hero */
        await C.page.evaluate(() => document.getElementById('free').scrollIntoView({ block: 'start', behavior: 'instant' }));
        await C.page.waitForTimeout(500);
        const f = await C.page.evaluate(() => ({ games: [...document.querySelectorAll('#freeGames li')].map((li) => li.innerText),
          chips: document.querySelectorAll('#freeGames .st').length, arts: [...document.querySelectorAll('#freeArts a')].map((a) => a.getAttribute('href')),
          links: [...document.querySelectorAll('#free a')].map((a) => a.getAttribute('href')) }));
        chk(vp.width + ' free: the week\'s games from the board, each with EdgeDesk\'s public read', f.games.length >= 1 && f.games.length <= 4 && f.chips === f.games.length, f);
        const pubUrls = PUB.articles.map((a) => a.url.replace('https://edgedesksports.com', ''));
        chk(vp.width + ' free: the latest research, linked to published articles only', f.arts.length >= 1 && f.arts.every((h) => pubUrls.indexOf(h) >= 0), f.arts);
        ['/today/', '/articles/', '/tools/no-vig-calculator/', '/tools/fair-odds-calculator/', '/tools/model-vs-market/', '/research/sample/', '/newsletter/?from=home_free']
          .forEach((h) => chk(vp.width + ' free: links ' + h, f.links.indexOf(h) >= 0, f.links));
        chk(vp.width + ' free: nothing wider than the screen, no script error', (await overflowing(C.page)).length === 0 && C.errors.length === 0, C.errors);
        await C.ctx.close();
      }
    }
    await S.ctx.close();
    const U = await open({ width: 1280, height: 900 }, 'live', { search: '?hero=<b>x</b>' });
    chk('an unknown variant leaves the page as it ships', (await U.page.evaluate(() => document.querySelector('h1').textContent)) === 'Research the game before you bet it.');
    await U.ctx.close();
  }

  /* NOTHING QUALIFIES: the published board holds no research-grade prop, as a
     prop run can leave it. The prop slot is a game's own prop, in full. */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const w = vp.width;
    const S = await open(vp, 'none');
    const r = await S.page.evaluate(() => {
      const el = document.querySelector('#lpPrevBody .opp[data-kind="prop"]');
      const worth = document.querySelector('#lpStats li[data-k="research"]');
      return {
        prevTag: document.getElementById('lpPrevTag').textContent,
        kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((x) => x.getAttribute('data-kind')),
        prop: el ? { chip: (el.querySelector('.st') || {}).textContent || '', head: (el.querySelector('.opp-hd b') || {}).textContent || '',
          kicker: (el.querySelector('.opp-k') || {}).textContent || '', cells: [...el.querySelectorAll('.cells .v')].map((v) => v.textContent.trim()),
          where: (el.querySelector('.opp-hd .w') || {}).textContent || '', text: el.innerText } : null,
        worth: worth.hidden ? null : worth.textContent.replace(/\s+/g, ' ').trim(),
        analyzed: (() => { const li = document.querySelector('#lpStats li[data-k="games_analyzed"]'); return li.hidden ? null : +li.querySelector('b').textContent.replace(/,/g, ''); })()
      };
    });
    const P = r.prop || { head: '', cells: [], text: '' };
    const order = w <= 560 ? 'game,prop,game' : 'game,game,prop';
    chk(w + ' nothing qualifies: the preview is still live, two game markets and one player prop, ' + order, /^Live/.test(r.prevTag) && r.kinds.join() === order, [r.prevTag, r.kinds]);
    chk(w + ' nothing qualifies: the player prop shows player and prop type, line, projection, difference, status, book and capture', propCardFull(P), P);
    chk(w + ' nothing qualifies: and it is a game\'s own prop, naming its game', propOf(GAME_PLAYERS, P) && / @ /.test(P.where) && !/^\s*·/.test(P.where), [P.head, P.where]);
    chk(w + ' nothing qualifies: "worth researching" stays a clear minority of the games analyzed',
      r.worth === null || (/^\d+ worth researching$/.test(r.worth) && r.analyzed && +r.worth.split(' ')[0] <= r.analyzed / 3), [r.worth, r.analyzed]);
    const ov = await overflowing(S.page);
    chk(w + ' nothing qualifies: nothing wider than the screen', ov.length === 0, ov);
    chk(w + ' nothing qualifies: no script errors', S.errors.length === 0, S.errors);
    if (SHOTS) await S.page.screenshot({ path: path.join(SHOTS, 'landing-none-' + w + '.png'), fullPage: false });
    await S.ctx.close();
  }

  /* MIDWEEK: prices on the capture's schedule, hours old */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'midweek');
    const r = await S.page.evaluate(() => ({
      chips: [...document.querySelectorAll('#lpPrevBody .st')].map((s) => s.textContent.trim()),
      kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
      propCard: (document.querySelector('#lpPrevBody .opp[data-kind="prop"]') || { innerText: '' }).innerText,
      red: document.querySelectorAll('#lpPrevBody .age.stale').length,
      text: document.getElementById('lpPrevBody').innerText
    }));
    chk(vp.width + ' midweek: nothing in the preview reads DATA INCOMPLETE', r.chips.length > 0 && r.chips.indexOf('DATA INCOMPLETE') < 0 && !/DATA INCOMPLETE/.test(r.text), r.chips);
    chk(vp.width + ' midweek: no age is printed in red', r.red === 0, r.red);
    chk(vp.width + ' midweek: no stale-price warnings in the copy', !/not a current price|is stale|execution window/i.test(r.text), (r.text.match(/not a current price|is stale|execution window/i) || [])[0]);
    chk(vp.width + ' midweek: the preview holds RESEARCH / WATCH games', r.chips.filter((c, i) => r.kinds[i] === 'game').every((c) => c === 'RESEARCH' || c === 'WATCH'), r.chips);
    chk(vp.width + ' midweek: a prop priced on schedule still takes the prop slot, with its age and no EV', r.kinds.join() === (vp.width <= 560 ? 'game,prop,game' : 'game,game,prop') && /captured \d+ h ago/.test(r.propCard) && !/EdgeDesk EV/.test(r.propCard), [r.kinds, r.propCard]);
    chk(vp.width + ' midweek: no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  /* STALE: nothing current */
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'stale');
    const r = await S.page.evaluate(() => ({
      chips: [...document.querySelectorAll('#lpPrevBody .st')].map((s) => s.textContent.trim()),
      prevText: document.getElementById('lpPrevBody').innerText,
      kinds: [...document.querySelectorAll('#lpPrevBody .opp[data-kind]')].map((el) => el.getAttribute('data-kind')),
      prevTag: document.getElementById('lpPrevTag').textContent, prevLive: document.getElementById('lpPrevTag').classList.contains('live'),
      upd: (() => { const li = document.querySelector('#lpStats li[data-k="updated"]'); return { old: li.classList.contains('old'), text: li.textContent }; })(),
      research: (() => { const li = document.querySelector('#lpStats li[data-k="research"]'); return li.hidden ? null : li.querySelector('b').textContent; })()
    }));
    chk(vp.width + ' stale: the preview is not called live', !r.prevLive && /^(Last update|Example)/.test(r.prevTag), r.prevTag);
    chk(vp.width + ' stale: "Last update", not a green "Updated"', r.upd.old && /^Last update/.test(r.upd.text), r.upd);
    chk(vp.width + ' stale: the research-grade count does not count the games it downgraded', r.research === null || +r.research.replace(/,/g, '') < 4, r.research);
    chk(vp.width + ' stale: no RESEARCH on a stale price, and no wall of DATA INCOMPLETE', r.chips.indexOf('RESEARCH') < 0 && r.chips.indexOf('DATA INCOMPLETE') < 0, r.chips);
    chk(vp.width + ' stale: no prop on a stale price; a third game takes its slot', /Example/.test(r.prevTag) || r.kinds.join() === 'game,game,game', r.kinds);
    chk(vp.width + ' stale: a game still listed is a consensus reference, and says so', /Example/.test(r.prevTag) || /consensus reference, not a captured quote/.test(r.prevText), r.prevText.slice(0, 200));
    chk(vp.width + ' stale: no EV printed', !/EdgeDesk EV/.test(r.prevText), r.prevText.slice(0, 200));
    chk(vp.width + ' stale: no script errors', S.errors.length === 0, S.errors);
    await S.ctx.close();
  }

  /* DOWN */
  for (const vp of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
    const S = await open(vp, 'down');
    await S.page.waitForTimeout(300);
    const r = await S.page.evaluate(() => ({
      tag: document.getElementById('lpPrevTag').textContent, ill: document.getElementById('lpPrevBody').classList.contains('ill'),
      stats: [...document.querySelectorAll('#lpStats li[data-k]')].filter((li) => !li.hidden).length,
      foot: document.getElementById('lpPrevFoot').textContent,
      example: (document.querySelector('.prev-ill') || { innerText: '' }).innerText
    }));
    chk(vp.width + ' down: the preview is an example and says so', r.tag === 'Example' && r.ill && /not live/i.test(r.example), [r.tag, r.ill, r.example.slice(0, 80)]);
    chk(vp.width + ' down: and says it could not be reached', /couldn.t be reached/.test(r.foot), r.foot);
    chk(vp.width + ' down: no stat is shown', r.stats === 0, r.stats);
    chk(vp.width + ' down: no event claims a live board was seen', S.events.every((e) => e.event !== 'landing_live_board_view'));
    chk(vp.width + ' down: no script errors', S.errors.length === 0, S.errors);
    const ov = await overflowing(S.page);
    chk(vp.width + ' down: nothing wider than the screen', ov.length === 0, ov);
    await S.ctx.close();
  }

  /* the methodology page the long explanations live on */
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
