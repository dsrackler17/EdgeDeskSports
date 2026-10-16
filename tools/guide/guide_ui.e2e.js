#!/usr/bin/env node
/* ===========================================================================
   THE GUIDE, IN A REAL BROWSER.

   app.html in Chromium, desktop and a 390 px phone, with the network stubbed
   the way the other suites stub it (tools/football/quote_ev_ui.e2e.js): the
   committed NFL slate as nflverse's games.csv, the FBS schedule fixture, an
   active subscription, and an empty database. What a first-time visitor
   meets, and what happens when things are not as they should be:

     A  a first visit gets the introduction; Escape dismisses it, it is
        remembered, Help brings it back; "Show me around" → the chooser →
        a walkthrough with Step n of m, Next, Back, arrow keys and Skip
     B  a new account's Setup comes first; the introduction waits for it
     C  an existing reader is not interrupted; the Help button carries a dot
        until it is opened
     D  the account's answer (user_metadata) stops it on a fresh device
     E  every walkthrough reaches every step on the real screen, and the
        Card's own onboarding never opens over the Card walkthrough
     F  the phone: no sideways scroll, a docked card above the navigation,
        the ring clear of it, Help as a bottom sheet
     G  missing data: the football engine down, props without prices
     H  a reader who navigates away mid-walkthrough is told, and can go back
     I  a locked account (paywall): no introduction, no walkthrough
     J  reduced motion: no ring animation
     K  terms: a decision-layer label and a page label open the explainer,
        by click and by keyboard; Escape returns focus
     L  Help keeps Tab inside, and Escape returns focus to the Help button

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/guide/guide_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}

const DAY = 864e5;
const NFL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
function nflGamesCsv() {
  const cols = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'away_rest', 'home_rest',
    'away_moneyline', 'home_moneyline', 'spread_line', 'total_line', 'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name'];
  const rows = NFL.games.map((g) => { const r = g.reference_market || {};
    return [g.game_id, g.season, g.game_type || 'REG', g.week, g.gameday, g.gametime_et, g.away_code, 'NA', g.home_code, 'NA', g.away_rest, g.home_rest,
      r.away_ml == null ? 'NA' : r.away_ml, r.home_ml == null ? 'NA' : r.home_ml, r.home_margin == null ? 'NA' : r.home_margin, r.total == null ? 'NA' : r.total,
      g.div_game ? 1 : 0, g.roof || 'NA', g.surface || 'NA', 'NA', 'NA',
      (g.away_starter && g.away_starter.player_id) || 'NA', (g.home_starter && g.home_starter.player_id) || 'NA',
      (g.away_starter && g.away_starter.player_name) || 'NA', (g.home_starter && g.home_starter.player_name) || 'NA'].join(','); });
  return cols.join(',') + '\n' + rows.join('\n') + '\n';
}
const FIXTURE = path.join(ROOT, 'tools', 'football', 'fixtures', 'fbs_schedule_sample.csv');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  const sched = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE) : '';
  const gamesCsv = nflGamesCsv();

  /* o: { phone, created (ms ago), ls {}, meta {}, noSub, noFootball, reduced, hash } */
  async function open(o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport: o.phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, reducedMotion: o.reduced ? 'reduce' : 'no-preference' });
    await ctx.addInitScript((x) => {
      try {
        if (sessionStorage.getItem('__guide_seeded')) return; sessionStorage.setItem('__guide_seeded', '1');
        Object.keys(x.ls || {}).forEach((k) => localStorage.setItem(k, x.ls[k]));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: 'e2e-guide-reader', email: 'e2e@edgedesk.test', created_at: x.created == null ? undefined : new Date(Date.now() - x.created).toISOString(), user_metadata: x.meta || {} } }));
      } catch (e) { /* storage off */ }
    }, { ls: o.ls || {}, created: o.created, meta: o.meta || null });
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/nfldata\/master\/data\/games\.csv/.test(url)) return o.noFootball ? route.fulfill({ status: 503, body: 'down' }) : route.fulfill({ status: 200, contentType: 'text/csv', body: gamesCsv });
      if (/cfb_schedules_\d{4}\.csv/.test(url)) return o.noFootball ? route.fulfill({ status: 503, body: 'down' }) : route.fulfill({ status: 200, contentType: 'text/csv', body: sched });
      if (/stats_team_week_(\d{4})\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv')) });
      if (/supabase\.co/.test(url)) {
        if (/\/auth\/v1\/user/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        if (/rpc\/my_billing_access|user_preferences/.test(url)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: o.noSub ? '[]' : JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * DAY).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${port}/app.html${o.hash == null ? '#research/football' : o.hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDGuide && window.EDGuide.startTour), null, { timeout: 30000 });
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const introOn = (page) => page.evaluate(() => { const h = document.getElementById('welHost'); return !!(h && h.classList.contains('on') && h.querySelector('.edg-intro')); });
  const guideState = (page) => page.evaluate(() => window.EDGuide.state());
  const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('edgedesk_guide_v1') || 'null'));
  /* the current step, once it has stopped loading */
  async function step(page) {
    await page.waitForFunction(() => { const S = window.EDGuide._S; return !S.tour || (S.mode !== 'loading'); }, null, { timeout: 20000 }).catch(() => {});
    /* until the page has stopped scrolling to the step and the ring has stopped gliding */
    let y = -1;
    for (let k = 0; k < 20; k++) { await page.waitForTimeout(150); const ny = await page.evaluate(() => scrollY); if (ny === y) break; y = ny; }
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const S = window.EDGuide._S, p = document.getElementById('edgPop'), r = document.getElementById('edgRing');
      if (!S.tour) return null;
      const t = S.target && S.mode === 'target' ? S.target.getBoundingClientRect() : r.getBoundingClientRect();
      const pr = p.getBoundingClientRect(), rr = { left: t.left - 4, right: t.right + 4, top: t.top - 4, bottom: t.bottom + 4 }, ringOn = r.classList.contains('on');
      const nav = document.querySelector('.bottomnav').getBoundingClientRect();
      return { tour: S.tour.id, i: S.step, n: S.tour.steps.length, mode: S.mode, title: (p.querySelector('.edg-pop-t') || {}).textContent, body: (p.querySelector('.edg-pop-b') || {}).textContent,
        kicker: (p.querySelector('.edg-pop-k') || {}).textContent, ring: ringOn, dock: p.classList.contains('dock'),
        overlap: ringOn && !(pr.right <= rr.left || pr.left >= rr.right || pr.bottom <= rr.top || pr.top >= rr.bottom),
        popInView: pr.top >= 0 && pr.bottom <= innerHeight && pr.left >= 0 && pr.right <= innerWidth, aboveNav: nav.top < innerHeight / 2 || pr.bottom <= nav.top + 1,
        focus: document.activeElement && document.activeElement.id, page: window.EDGuide.currentPage() };
    });
  }
  const click = (page, sel) => page.click(sel, { timeout: 5000 });

  /* ------------------------------------------------------------------ A */
  console.log('\n== A · a first visit, desktop ==');
  {
    const { ctx, page, errors } = await open({ created: 60000, ls: { edgedesk_setup_v1: '1' } });
    await page.waitForFunction(() => { const h = document.getElementById('welHost'); return h && h.classList.contains('on'); }, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
    const intro = await page.evaluate(() => { const h = document.getElementById('welHost');
      return { on: h.classList.contains('on'), title: (h.querySelector('#edgIntroT') || {}).textContent, buttons: [...h.querySelectorAll('button')].map((b) => b.textContent.trim()),
        labelled: h.getAttribute('aria-labelledby'), modal: h.getAttribute('aria-modal'), focus: document.activeElement && document.activeElement.textContent.trim(),
        persona: !!document.querySelector('.edm-ov.on'), cardModal: !!document.querySelector('#eddModal.on') }; });
    chk('the introduction opens by itself on a first visit', intro.on && intro.title === 'Research, not picks.', intro);
    chk('it offers “Show me around” and “Explore on my own”, and a close button', intro.buttons.indexOf('Show me around') >= 0 && intro.buttons.indexOf('Explore on my own') >= 0 && intro.buttons.indexOf('×') >= 0, intro.buttons);
    chk('it is a labelled modal dialog, with focus on its first action', intro.labelled === 'edgIntroT' && intro.modal === 'true' && intro.focus === 'Show me around', intro);
    chk('nothing else opens on top of it', !intro.persona && !intro.cardModal, intro);
    await shot(page, 'A-intro-desktop');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({ on: document.getElementById('welHost').classList.contains('on'), toast: !!document.querySelector('#edgToast.on'), welcome: !!localStorage.getItem('edgedesk_welcome_seen') }));
    const st = await stored(page);
    chk('Escape dismisses it', !after.on);
    chk('the answer is kept on the device', st && st.intro === 'dismissed', st);
    chk('a short note shows where Help lives', after.toast);
    chk('the old welcome stays quiet too', after.welcome);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.EDGuide, null, { timeout: 30000 });
    await page.waitForTimeout(4500);
    chk('it does not come back on the next visit', !(await introOn(page)));
    await click(page, '#edHelpBtn');
    await click(page, '#edgHelp [data-edg-act="replay"]');
    await page.waitForTimeout(200);
    chk('Help → Replay the introduction brings it back', await introOn(page));
    await click(page, '#welHost [data-edg-act="intro-tour"]');
    const paths = await page.evaluate(() => [...document.querySelectorAll('#welHost .edg-path b')].map((b) => b.textContent));
    chk('“Show me around” asks what you would like to do, with the five tasks this build supports', paths.length === 5 && /Research a game/.test(paths[0]), paths);
    await shot(page, 'A-chooser-desktop');
    await click(page, '#welHost [data-edg-v="game"]');
    let s = await step(page);
    chk('choosing a task starts its walkthrough on the real screen', s && s.tour === 'game' && s.i === 0 && s.mode === 'target' && s.ring && !s.overlap, s);
    chk('the step says where you are (Step 1 of 5) and takes focus', s && /Step 1 of 5/.test(s.kicker) && s.focus === 'edgPopT', s);
    chk('choosing a task marks the introduction done', (await guideState(page)).intro === 'done');
    await click(page, '#edgPop [data-edg-act="next"]'); s = await step(page);
    chk('Next moves on', s && s.i === 1, s);
    await click(page, '#edgPop [data-edg-act="back"]'); s = await step(page);
    chk('Back goes back', s && s.i === 0, s);
    await page.focus('#edgPopT'); await page.keyboard.press('ArrowRight'); s = await step(page);
    chk('the arrow keys move between steps', s && s.i === 1, s);
    await click(page, '#edgPop [data-edg-act="skip"]');
    await page.waitForTimeout(200);
    const skipped = await page.evaluate(() => ({ tour: !!window.EDGuide._S.tour, ring: document.getElementById('edgRing').classList.contains('on'), focus: document.activeElement && document.activeElement.id, st: window.EDGuide.state().tours.game }));
    chk('Skip ends it, clears the highlight and returns focus to Help', !skipped.tour && !skipped.ring && skipped.focus === 'edHelpBtn', skipped);
    chk('a skipped walkthrough is remembered as skipped', skipped.st && skipped.st.status === 'skipped', skipped.st);
    chk('no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ B */
  console.log('\n== B · a new account: Setup first ==');
  {
    const { ctx, page } = await open({ created: 60000, hash: '' });
    await page.waitForTimeout(4500);
    const setup = await page.evaluate(() => !document.getElementById('v-setup').classList.contains('hide'));
    chk('a new account lands on Setup', setup);
    chk('the introduction waits while Setup is on screen', !(await introOn(page)));
    await click(page, '#setupHost [data-su="skip"]');
    await page.waitForFunction(() => document.getElementById('welHost').classList.contains('on'), null, { timeout: 10000 }).catch(() => {});
    chk('…and offers itself once Setup is left', await introOn(page));
    await ctx.close();
  }

  /* ------------------------------------------------------------------ C */
  console.log('\n== C · an existing reader ==');
  {
    const { ctx, page } = await open({ created: 400 * DAY, ls: { edgedesk_welcome_seen: String(Date.now() - 100 * DAY) } });
    await page.waitForTimeout(5000);
    chk('a reader who dismissed the old welcome is not interrupted', !(await introOn(page)));
    const dot = await page.evaluate(() => document.getElementById('edHelpBtn').classList.contains('edg-new'));
    chk('the Help button carries a small “new” dot', dot);
    await click(page, '#edHelpBtn'); await page.keyboard.press('Escape');
    const dot2 = await page.evaluate(() => document.getElementById('edHelpBtn').classList.contains('edg-new'));
    chk('…until Help is opened once', !dot2 && (await stored(page)).helpSeen === true);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ D */
  console.log('\n== D · the account remembers ==');
  {
    const { ctx, page } = await open({ created: 60000, ls: { edgedesk_setup_v1: '1' }, meta: { edgedesk_guide: { intro: 'dismissed', at: '2026-10-01T00:00:00Z', done: ['card'] } } });
    await page.waitForTimeout(5000);
    chk('an answer kept on the account stops it on a fresh device or after sign-out', !(await introOn(page)));
    const st = await stored(page);
    chk('the device copy is filled from the account', st && st.intro === 'dismissed' && st.tours.card && st.tours.card.status === 'done', st);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ E */
  console.log('\n== E · every walkthrough, every step, desktop ==');
  {
    const { ctx, page, errors } = await open({ created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForTimeout(3000);
    let cardModalSeen = false;
    for (const id of ['game', 'numbers', 'props', 'card', 'track']) {
      await page.evaluate((t) => window.EDGuide.startTour(t), id);
      const seen = [];
      for (let k = 0; k < 8; k++) {
        const s = await step(page);
        if (!s) break;
        seen.push(s);
        if (await page.evaluate(() => !!document.querySelector('#eddModal.on'))) cardModalSeen = true;
        if (SHOTS) await shot(page, `E-${id}-${s.i}`);
        await click(page, '#edgPop [data-edg-act="next"]').catch(() => {});
      }
      const n = seen.length ? seen[0].n : 0;
      chk(`“${id}”: all ${n} steps shown, in order`, seen.length === n && seen.every((s, i) => s.i === i), seen.map((s) => s.i));
      /* the last "Research a game" step opens a game, whose research may be a
         panel taller than the screen; every other step points at a control */
      const bad = seen.filter((s, i) => !(s.mode === 'target' && s.ring) || (s.overlap && !(id === 'game' && i === n - 1)) || !s.popInView);
      chk(`“${id}”: each step rings its real control, with the card in view and clear of it`, !bad.length, bad);
      chk(`“${id}”: Done records it as done`, (await guideState(page)).tours[id] && (await guideState(page)).tours[id].status === 'done');
    }
    chk('the Card’s own onboarding never opened over the Card walkthrough', !cardModalSeen);
    chk('finishing the Card walkthrough stands in for the Card’s four-page explainer', await page.evaluate(() => !!localStorage.getItem('edgedesk_decision_onboarded_v1')));
    chk('no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ F */
  console.log('\n== F · a 390 px phone ==');
  {
    const { ctx, page, errors } = await open({ phone: true, created: 60000, ls: { edgedesk_setup_v1: '1' } });
    await page.waitForFunction(() => document.getElementById('welHost').classList.contains('on'), null, { timeout: 20000 }).catch(() => {});
    const m = await page.evaluate(() => { const c = document.querySelector('#welHost .wel-card').getBoundingClientRect(), b = document.getElementById('edHelpBtn').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, card: [c.left, c.right], help: [b.left, b.right, b.width], vw: innerWidth }; });
    chk('the introduction fits the phone, with no sideways scroll', m.sw <= m.vw && m.card[0] >= 0 && m.card[1] <= m.vw, m);
    chk('the Help button sits in the header, on screen', m.help[2] >= 28 && m.help[0] >= 0 && m.help[1] <= m.vw, m);
    await shot(page, 'F-intro-phone');
    await click(page, '#welHost [data-edg-act="intro-tour"]');
    await click(page, '#welHost [data-edg-v="props"]');
    const seen = [];
    for (let k = 0; k < 6; k++) { const s = await step(page); if (!s) break; seen.push(s); if (SHOTS) await shot(page, `F-props-${s.i}`); await click(page, '#edgPop [data-edg-act="next"]').catch(() => {}); }
    chk('the walkthrough card docks above the navigation on a phone', seen.length === 5 && seen.every((s) => s.dock && s.aboveNav && s.popInView), seen.map((s) => [s.i, s.dock, s.aboveNav, s.popInView]));
    chk('…and never covers the control it points at', seen.every((s) => s.ring && !s.overlap), seen.map((s) => [s.i, s.ring, s.overlap]));
    await click(page, '#edHelpBtn');
    const sheet = await page.evaluate(() => { const r = document.getElementById('edgHelp').getBoundingClientRect(); return { bottom: Math.round(r.bottom), top: Math.round(r.top), w: Math.round(r.width), vh: innerHeight, vw: innerWidth }; });
    chk('Help opens as a bottom sheet across the phone', sheet.bottom === sheet.vh && sheet.w === sheet.vw && sheet.top > 0, sheet);
    await shot(page, 'F-help-phone');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => { const b = document.getElementById('edHelpBtn').getBoundingClientRect(), a = document.querySelector('.edav-wrap').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, help: Math.round(b.right), av: Math.round(a.right) }; });
    chk('even at 320 px the header holds the Help button without sideways scroll', narrow.sw <= 320 && narrow.av <= 320 && narrow.help < narrow.av, narrow);
    chk('no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ G */
  console.log('\n== G · missing data ==');
  {
    const { ctx, page } = await open({ noFootball: true, created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.EDGuide.startTour('numbers'));
    const s = await step(page);
    chk('with the football research down, the walkthrough says so instead of pointing at nothing', s && s.mode === 'missing' && !s.ring && /No game decision is on screen/.test(s.body), s);
    await shot(page, 'G-numbers-missing');
    await click(page, '#edgPop [data-edg-act="help"]');
    const h = await page.evaluate(() => ({ help: document.getElementById('edgHelp').classList.contains('on'), focus: document.activeElement && document.activeElement.id, tour: !!window.EDGuide._S.tour }));
    chk('…and offers a useful next step: the terms, explained', h.help && h.focus === 'edgHelpQ' && !h.tour, h);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.EDGuide.startTour('props'));
    let last = null;
    for (let k = 0; k < 6; k++) { const x = await step(page); if (!x) break; last = x; if (x.i === x.n - 1) break; await click(page, '#edgPop [data-edg-act="next"]').catch(() => {}); }
    const priced = await page.evaluate(() => /not been captured/.test((document.querySelector('#ppHost .pp-main') || {}).textContent || ''));
    chk('props without captured prices: the last step says there is no EV or edge to claim', !priced || (last && /no EV to rank and no edge to claim/.test(last.body)), last && last.body);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ H */
  console.log('\n== H · navigating away mid-walkthrough ==');
  {
    const { ctx, page } = await open({ created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.EDGuide.startTour('card'));
    let s = await step(page);
    chk('the Card walkthrough starts on the Card', s && s.page === 'card' && s.mode === 'target', s);
    await click(page, '.bottomnav button[data-v="portfolio"]');
    await page.waitForFunction(() => window.EDGuide._S.mode === 'left', null, { timeout: 8000 }).catch(() => {});
    s = await step(page);
    chk('leaving the screen is said plainly, with a way back', s && s.mode === 'left' && /moved to another screen/.test(s.body), s);
    await click(page, '#edgPop [data-edg-act="return"]');
    s = await step(page);
    chk('“Go back” returns to the same step', s && s.page === 'card' && s.i === 0 && s.mode === 'target', s);
    await page.keyboard.press('Escape');
    chk('Escape ends the walkthrough', !(await page.evaluate(() => !!window.EDGuide._S.tour)));
    await ctx.close();
  }

  /* ------------------------------------------------------------------ I */
  console.log('\n== I · a locked account ==');
  {
    const { ctx, page } = await open({ noSub: true, created: 60000, ls: { edgedesk_setup_v1: '1' } });
    await page.waitForFunction(() => document.getElementById('payGate').classList.contains('on'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const r = await page.evaluate(() => ({ gate: document.getElementById('payGate').classList.contains('on'), intro: document.getElementById('welHost').classList.contains('on'),
      tour: window.EDGuide.startTour('game'), help: window.EDGuide.openHelp() }));
    chk('the paywall is up for an account without access', r.gate, r);
    chk('the introduction does not open over the paywall', !r.intro, r);
    chk('no walkthrough or Help panel starts behind the paywall', r.tour === false && r.help === false, r);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ J */
  console.log('\n== J · reduced motion ==');
  {
    const { ctx, page } = await open({ reduced: true, created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.EDGuide.startTour('game'));
    await step(page);
    const t = await page.evaluate(() => { const cs = getComputedStyle(document.getElementById('edgRing')); return cs.transitionDuration.split(',').map(parseFloat); });
    chk('the ring does not animate when the reader prefers reduced motion', t.every((x) => x <= 0.001), t);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ K */
  console.log('\n== K · terms where they appear ==');
  {
    const { ctx, page } = await open({ created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForFunction(() => !!document.querySelector('#fbBody .edd-tip[data-ed-tip="model_fair"]'), null, { timeout: 30000 }).catch(() => {});
    const tip = await page.evaluate(() => { const t = document.querySelector('#fbBody .edd-tip[data-ed-tip="model_fair"]'); if (!t) return null; t.scrollIntoView({ block: 'center' }); return { role: t.getAttribute('role'), tab: t.getAttribute('tabindex'), popup: t.getAttribute('aria-haspopup') }; });
    chk('a decision-layer label becomes a keyboard button that opens a dialog', tip && tip.role === 'button' && tip.tab === '0' && tip.popup === 'dialog', tip);
    if (tip) {
      await page.click('#fbBody .edd-tip[data-ed-tip="model_fair"] >> nth=0');
      const t = await page.evaluate(() => ({ on: document.getElementById('edgTerm').classList.contains('on'), title: document.getElementById('edgTermT').textContent,
        limits: /Keep in mind/.test(document.getElementById('edgTerm').textContent), expanded: document.querySelector('#fbBody .edd-tip[aria-expanded="true"]') != null, focus: document.activeElement.id }));
      chk('clicking it explains the term in full — what it is, how to use it, its limits', t.on && t.title === 'Fair spread and fair line' && t.limits && t.expanded && t.focus === 'edgTermT', t);
      await shot(page, 'K-term-desktop');
      await page.keyboard.press('Escape');
      const back = await page.evaluate(() => ({ on: document.getElementById('edgTerm').classList.contains('on'), focus: document.activeElement && document.activeElement.getAttribute('data-ed-tip') }));
      chk('Escape closes it and returns focus to the term', !back.on && back.focus === 'model_fair', back);
    }
    await page.evaluate(() => window.show('record'));
    await page.waitForTimeout(400);
    /* the proof layer folds into Advanced Analytics once the P&L mounts */
    await page.evaluate(() => { const t = document.querySelector('#recProofHead [data-ed-term="clv"]'); const d = t && t.closest('details'); if (d) d.open = true; if (t) t.scrollIntoView({ block: 'center' }); });
    await page.focus('#recProofHead [data-ed-term="clv"]');
    await page.keyboard.press('Enter');
    const clv = await page.evaluate(() => ({ on: document.getElementById('edgTerm').classList.contains('on'), title: document.getElementById('edgTermT') && document.getElementById('edgTermT').textContent }));
    chk('a page label (Model performance → Price quality) opens its term by keyboard', clv.on && /Closing line value/.test(clv.title), clv);
    const placed = await page.evaluate(() => { const a = document.querySelector('#recProofHead [data-ed-term="clv"]').getBoundingClientRect(), p = document.getElementById('edgTerm').getBoundingClientRect();
      return { open: p.height > 0, covers: !(p.right <= a.left || p.left >= a.right || p.bottom <= a.top || p.top >= a.bottom) }; });
    chk('the explainer never covers the term it explains', placed.open && !placed.covers, placed);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ L */
  console.log('\n== L · Help, by keyboard ==');
  {
    const { ctx, page } = await open({ created: 400 * DAY, ls: { edgedesk_welcome_seen: '1', edgedesk_guide_v1: JSON.stringify({ v: 1, intro: 'dismissed', helpSeen: true }) } });
    await page.waitForTimeout(2500);
    await page.focus('#edHelpBtn'); await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const inside = [];
    for (let k = 0; k < 40; k++) { await page.keyboard.press('Tab'); inside.push(await page.evaluate(() => !!(document.activeElement && document.activeElement.closest('#edgHelp')))); }
    chk('Tab stays inside Help', inside.every(Boolean), inside.indexOf(false));
    const here = await page.evaluate(() => [...document.querySelectorAll('#edgHelp [data-edg-act="tour"]')].map((b) => b.getAttribute('data-edg-v')));
    chk('Help offers this page’s walkthroughs first (Football: research a game, read the numbers)', here[0] === 'game' && here[1] === 'numbers', here);
    await page.keyboard.press('Escape');
    const f = await page.evaluate(() => ({ open: document.getElementById('edgHelp').classList.contains('on'), focus: document.activeElement && document.activeElement.id, exp: document.getElementById('edHelpBtn').getAttribute('aria-expanded') }));
    chk('Escape closes Help and returns focus to the Help button', !f.open && f.focus === 'edHelpBtn' && f.exp === 'false', f);
    await page.evaluate(() => window.show('more'));
    await page.waitForTimeout(300);
    const more = await page.evaluate(() => [...document.querySelectorAll('#moreList .moreitem b')].map((b) => b.childNodes[0].textContent));
    chk('More → Account lists Learn EdgeDesk', more.indexOf('Learn EdgeDesk') > more.indexOf('Set up EdgeDesk'), more);
    await page.evaluate(() => { const b = [...document.querySelectorAll('#moreList .moreitem')].find((x) => /Learn EdgeDesk/.test(x.textContent)); b.click(); });
    chk('…and it opens Help', await page.evaluate(() => document.getElementById('edgHelp').classList.contains('on')));
    await ctx.close();
  }

  await browser.close(); srv.close();
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | guide (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
