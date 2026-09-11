#!/usr/bin/env node
/* ===========================================================================
   THE FBS BOARD, IN A REAL BROWSER, AT TWO WIDTHS.

   The unit suites prove the rules. This proves the RENDER: app.html loaded in
   Chromium exactly as it ships, its own loader fetching its own engine and
   the season's schedule feed, and then the board driven the way a reader
   drives it — click a conference, click a matchup type, read the counts,
   copy the URL, open it again.

   Everything except the schedule feed is served locally. The schedule itself
   is the REAL cfbfastR CSV, replayed from the cache the coverage gate wrote,
   so the board under test is the board a reader gets rather than a fixture
   shaped to pass.

   What it prevents that no unit suite can:
     * the board throwing on load and rendering an empty panel;
     * the filter chips existing in the HTML but not driving the DOM;
     * a shared URL that restores the wrong view once the page has booted;
     * the control surface wrapping into a wall of buttons on a phone and
       pushing the board off the screen;
     * the page still calling itself a Power 4 product.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one, so
   it can sit beside the offline suites on a machine that has no browser.

   Run:  node tools/football/fbs_board.e2e.js
         node tools/football/fbs_board.e2e.js --shots /tmp/shots
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; failures.push({ name, detail });
  console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
function finish() {
  if (fail) {
    console.log('\nFAIL | FBS board (browser) | ' + pass + ' passed, ' + fail + ' failed');
    process.exit(1);
  }
  console.log('\nPASS | FBS board (browser) | ' + pass + ' assertions');
  process.exit(0);
}

/* ---- the schedule the board will be given ------------------------------ */
const CACHE_DIR = path.join(ROOT, 'football', 'fbs', '.cache');
function cachedSchedule(season) {
  const f = path.join(CACHE_DIR, 'cfb_schedules_' + season + '.csv');
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
const SEASON = (() => { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); })();
if (!cachedSchedule(SEASON)) {
  console.log('SKIPPED: no cached ' + SEASON + ' schedule (run `npm run cfb:fbs` once)');
  process.exit(0);
}

/* ---- a static server for the repo -------------------------------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.xml': 'application/xml' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
function serve(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) {
    try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; }
  }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }

  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium (' + String(e.message).split('\n')[0] + ')'); site.srv.close(); process.exit(0); }
  }

  async function openBoard(viewport, search) {
    const ctx = await browser.newContext({ viewport });
    /* app.html is the signed-in terminal: it bounces a session-less visitor to
       the landing page and shows a subscription wall to a signed-in reader with
       no entitling row. Both are seeded here so the BOARD is what is under
       test — neither gate is what this suite is about, and neither is what an
       actual reader of this board hits. */
    await ctx.addInitScript(() => {
      try {
        /* the first-run welcome overlay is a one-time UX card, not the board */
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({
          access_token: 'e2e', refresh_token: 'e2e',
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' }
        }));
      } catch (e) { /* private mode: the gate fails open anyway */ }
    });
    /* Everything off this machine is answered here. The schedule is the real
       feed from the cache; the rosters and Supabase are answered as absent,
       which is a state the board is required to render honestly anyway. */
    await ctx.route('**/*', async route => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const m = url.match(/cfb_schedules_(\d{4})\.csv/);
      if (m) {
        const body = cachedSchedule(+m[1]);
        if (body) return route.fulfill({ status: 200, contentType: 'text/csv', body });
        return route.fulfill({ status: 404, body: 'not published' });
      }
      if (/cfb_rosters_\d{4}\.csv/.test(url)) return route.fulfill({ status: 404, body: 'not published' });
      if (/open-meteo/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      if (/supabase\.co/.test(url)) {
        /* the entitlement row, so the reader is inside the terminal. Everything
           else from the database answers empty, which the board must render
           honestly: no captured quotes means NO MARKET, not a zero line. */
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e',
            current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
            cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e && e.message).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html${search || ''}#research/football`,
      { waitUntil: 'domcontentloaded' });
    /* boot the module the way the sub-nav does, then open the FBS board */
    await page.waitForFunction(() => typeof window.fbSetSport === 'function', null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) {} });
    await page.evaluate(() => window.fbSetSport('p4'));
    await page.waitForFunction(() => {
      const b = document.getElementById('fbBody');
      return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML);
    }, null, { timeout: 60000 });
    return { ctx, page, errors };
  }

  /* ===================================================================== */
  /* DESKTOP                                                               */
  /* ===================================================================== */
  console.log('\n== the board at 1280px ==');
  let D;
  try { D = await openBoard({ width: 1280, height: 2000 }); }
  catch (e) {
    chk('the FBS board renders in a browser', false, String(e.message).slice(0, 300));
    await browser.close(); site.srv.close(); return finish();
  }
  const page = D.page;

  /* the header line wherever it sits: the board renders its data-source and
     data-gap notes above it, which is the right order for a research
     terminal and the wrong assumption for a test that reads line zero */
  const headerOf = p => p.evaluate(() => {
    const m = document.getElementById('fbBody').innerText.match(/EDGEDESK \/\/[^\n]*/);
    return m ? m[0] : '';
  });
  const head = await headerOf(page);
  chk('the header names the FBS product', /FBS FOOTBALL OPERATIONS/.test(head), head);
  chk('the header opens on ALL FBS', /ALL FBS/.test(head), head);
  chk('the header carries a visible-of-total count', /\d+ OF \d+ GAMES/.test(head), head);
  chk('the header no longer says POWER 4', !/· POWER 4 ·/.test(head), head);

  const state = await page.evaluate(() => {
    const rows = window.FB.p4.up || [];
    const conf = {}, groups = {}, types = {};
    rows.forEach(u => {
      u.meta.conference_ids.forEach(c => { conf[c] = (conf[c] || 0) + 1; });
      u.meta.groups.forEach(g => { groups[g] = (groups[g] || 0) + 1; });
      types[u.meta.matchup_type] = (types[u.meta.matchup_type] || 0) + 1;
    });
    return { slate: rows.length, conf, groups, types,
      fbsTeams: window.FB.p4.uni.counts.fbs_teams,
      conferences: window.FB.p4.uni.conferences.map(c => c.id),
      labels: window.FB.p4.uni.conferences.map(c => c.label),
      p4: window.FB.p4.uni.p4.ids,
      visibleRows: document.querySelectorAll('[id^="p4gate-"]').length };
  });
  chk('the browser really loaded the whole FBS slate', state.slate > 100, state.slate);
  chk('and the whole FBS universe', state.fbsTeams > 120, state.fbsTeams);
  chk('every conference in the feed is on the board', state.conferences.length >= 10, state.labels);
  chk('the board renders one row per game', state.visibleRows === state.slate,
    { rows: state.visibleRows, slate: state.slate });
  chk('the slate carries Other FBS games', (state.groups.other || 0) > 0, state.groups);
  chk('the slate carries independents', (state.groups.independent || 0) > 0, state.groups);
  chk('the slate carries conference, non-conference and FBS-vs-FCS games',
    state.types.conference > 0 && state.types.non_conference > 0 && state.types.fbs_fcs > 0, state.types);
  chk('games with no Power 4 participant are on the board',
    Object.keys(state.conf).some(c => state.p4.indexOf(c) < 0 && state.conf[c] > 0),
    { p4: state.p4, conf: state.conf });

  /* the filter controls exist as real buttons a reader can press */
  const controls = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('#fbBody .fbs-chip')).map(b => b.textContent.trim());
    const labels = Array.from(document.querySelectorAll('#fbBody .fbs-flab')).map(b => b.textContent.trim());
    return { chips, labels };
  });
  ['GROUP', 'CONFERENCE', 'MATCHUP', 'MARKET', 'STATUS', 'SORT'].forEach(l =>
    chk('the ' + l.toLowerCase() + ' control is on screen', controls.labels.indexOf(l) >= 0, controls.labels));
  ['All FBS', 'Power 4', 'Other FBS', 'Independents'].forEach(l =>
    chk('the group control offers ' + l, controls.chips.indexOf(l) >= 0));
  chk('nothing on screen says "Group of 5"',
    !controls.chips.some(c => /group of (5|five)/i.test(c)));

  /* CLICKING actually filters the DOM */
  async function clickChip(text) {
    return page.evaluate(t => {
      const b = Array.from(document.querySelectorAll('#fbBody .fbs-chip')).find(x => x.textContent.trim() === t
        || x.textContent.trim().indexOf(t) === 0);
      if (!b) return false;
      b.click(); return true;
    }, text);
  }
  const clickedOther = await clickChip('Other FBS');
  chk('the Other FBS chip is clickable', clickedOther === true);
  await page.waitForTimeout(200);
  const other = await page.evaluate(() => {
    const m = document.getElementById('fbBody').innerText.match(/EDGEDESK \/\/[^\n]*/);
    return { head: m ? m[0] : '', rows: document.querySelectorAll('[id^="p4gate-"]').length,
      search: location.search };
  });
  chk('clicking Other FBS narrows the board', other.rows > 0 && other.rows < state.slate,
    { rows: other.rows, slate: state.slate });
  chk('and the header says so', /OTHER FBS/.test(other.head), other.head);
  chk('and the URL carries the view', /fbs_group=other/.test(other.search), other.search);

  const clickedConfGames = await clickChip('Conference games');
  chk('the conference-games chip is clickable', clickedConfGames === true);
  await page.waitForTimeout(200);
  const composed = await page.evaluate(() => ({
    rows: document.querySelectorAll('[id^="p4gate-"]').length,
    search: location.search,
    allConference: (window.FB.p4.up || [])
      .filter(u => window.EDFbs.matches(u.meta, { group: 'other', matchup: 'conference' })).length
  }));
  chk('the two filters compose rather than replacing each other',
    /fbs_group=other/.test(composed.search) && /fbs_matchup=conference/.test(composed.search), composed.search);
  chk('and the rendered rows match the composed filter',
    composed.rows === composed.allConference, composed);

  /* no duplicates, ever */
  const dupes = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id^="p4gate-"]')).map(e => e.id);
    return ids.length - new Set(ids).size;
  });
  chk('no game is rendered twice under a filter', dupes === 0, dupes);

  /* a row opens its research card, and the card carries the conference */
  await page.evaluate(() => {
    const r = document.querySelector('[id^="p4arr-"]');
    if (r) r.parentElement.click();
  });
  await page.waitForTimeout(400);
  /* textContent, not innerText: the design system renders every section
     header through text-transform:uppercase, and Chromium's innerText hands
     back the TRANSFORMED text — so a case-sensitive search for a section
     title finds nothing even though it is on screen. */
  const card = await page.evaluate(() => {
    const open = document.querySelector('[id^="p4gate-"][data-open]');
    return open ? open.textContent.slice(0, 6000) : '';
  });
  chk('a row opens its research card', card.length > 200, card.length);
  chk('the card names the matchup type', /Conference game|Non-conference FBS|FBS vs FCS/.test(card), card.slice(0, 300));
  chk('the card shows the FBS rating on one scale', /EdgeDesk FBS rating/.test(card));
  chk('the card says research, not picks', /Research, not picks/.test(card));

  /* the ratings section */
  const ratings = await page.evaluate(() => {
    const t = document.getElementById('fbBody').textContent;
    const i = t.indexOf('EdgeDesk FBS Rating');
    return i < 0 ? '' : t.slice(i, i + 2500);
  });
  chk('the ratings section is the FBS rating', /EdgeDesk FBS Rating — top 25/.test(ratings), ratings.slice(0, 200));
  chk('and it states the baseline', /points versus an average FBS team/.test(ratings));
  chk('and the engine state is a labelled diagnostic', /Engine state · diagnostic/.test(ratings));
  chk('and nothing claims the board is priced off a Power 4 scale',
    !/Power 4 engine state/i.test(await page.evaluate(() => document.getElementById('fbBody').textContent)));

  /* reset, then prove a shared URL restores the view after a full boot */
  await clickChip('Reset filters');
  await page.waitForTimeout(200);
  const afterReset = await page.evaluate(() => ({ search: location.search,
    rows: document.querySelectorAll('[id^="p4gate-"]').length }));
  chk('reset clears the query string', afterReset.search.indexOf('fbs_') < 0, afterReset.search);
  chk('and puts every game back', afterReset.rows === state.slate, afterReset);

  const shareConf = state.conferences.indexOf('mac') >= 0 ? 'mac' : state.conferences[state.conferences.length - 1];
  await D.ctx.close();
  const S = await openBoard({ width: 1280, height: 2000 }, '?fbs_conf=' + shareConf + '&fbs_sort=gap');
  const shared = await S.page.evaluate(() => {
    const m = document.getElementById('fbBody').innerText.match(/EDGEDESK \/\/[^\n]*/);
    const rows = Array.from(document.querySelectorAll('[id^="p4gate-"]')).map(e => e.id.replace('p4gate-', ''));
    return { head: m ? m[0] : '', rows };
  });
  chk('a shared conference link restores that conference', shared.rows.length > 0
    && shared.rows.length < state.slate, { rows: shared.rows.length, slate: state.slate });
  chk('and the header names it', shared.head.indexOf('GAMES') > 0 && !/ALL FBS/.test(shared.head), shared.head);
  chk('a shared gap sort restores the sort', await S.page.evaluate(() => window.FB.p4.filters.sort === 'gap'));
  await S.ctx.close();

  /* ===================================================================== */
  /* MOBILE                                                               */
  /* ===================================================================== */
  console.log('\n== the board at 390px ==');
  const M = await openBoard({ width: 390, height: 1400 });
  const mob = await M.page.evaluate(() => {
    const body = document.getElementById('fbBody');
    const de = document.documentElement;
    const filters = body.querySelector('.fbs-filters');
    const rows = body.querySelectorAll('[id^="p4gate-"]').length;
    const fr = filters ? filters.getBoundingClientRect() : null;
    /* each filter row scrolls on its own rather than wrapping into a wall */
    const sets = Array.from(body.querySelectorAll('.fbs-fset')).map(s => ({
      h: Math.round(s.getBoundingClientRect().height),
      scrolls: s.scrollWidth > s.clientWidth + 1
    }));
    const counts = body.querySelector('.fbs-counts');
    return {
      pageScrollsSideways: de.scrollWidth > de.clientWidth + 1,
      filterHeight: fr ? Math.round(fr.height) : null,
      filterWidth: fr ? Math.round(fr.width) : null,
      viewport: de.clientWidth,
      rows, sets,
      countsVisible: !!counts && counts.getBoundingClientRect().height > 0,
      /* how far the control surface pushes the board DOWN INSIDE its own
         panel. Measured against the panel, not the viewport: the research
         shell above it is not what this expansion changed. */
      boardOffset: (() => {
        const t = body.querySelector('[style*="overflow-x"]');
        return t ? Math.round(t.getBoundingClientRect().top - body.getBoundingClientRect().top) : null;
      })()
    };
  });
  chk('the page does not scroll sideways on a phone', mob.pageScrollsSideways === false, mob);
  chk('the board still renders every row on a phone', mob.rows === state.slate, { rows: mob.rows, slate: state.slate });
  chk('the filter block stays inside the column', mob.filterWidth <= mob.viewport + 1, mob);
  chk('the filters do not eat the screen', mob.filterHeight != null && mob.filterHeight < 260, mob.filterHeight);
  chk('each filter row is a single scrolling line rather than a wrapped pile',
    mob.sets.length > 0 && mob.sets.every(s => s.h < 46), mob.sets);
  chk('at least one filter row actually scrolls horizontally',
    mob.sets.some(s => s.scrolls), mob.sets);
  chk('the counts strip is still visible', mob.countsVisible === true);
  chk('the controls do not push the board down the panel',
    mob.boardOffset != null && mob.boardOffset < 620, mob.boardOffset);

  /* filtering works on a phone too */
  const mobClicked = await M.page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('#fbBody .fbs-chip')).find(x => x.textContent.trim() === 'FBS vs FCS');
    if (!b) return false;
    b.click(); return true;
  });
  chk('a matchup chip is tappable on a phone', mobClicked === true);
  await M.page.waitForTimeout(200);
  const mobAfter = await M.page.evaluate(() => ({
    rows: document.querySelectorAll('[id^="p4gate-"]').length,
    expected: (window.FB.p4.up || []).filter(u => u.meta.matchup_type === 'fbs_fcs').length,
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  }));
  chk('and it filters the board', mobAfter.rows === mobAfter.expected && mobAfter.rows > 0, mobAfter);
  chk('and the page still does not scroll sideways', mobAfter.sideways === false);

  if (SHOTS) {
    try {
      fs.mkdirSync(SHOTS, { recursive: true });
      await M.page.screenshot({ path: path.join(SHOTS, 'fbs-board-390.png'), fullPage: false });
      const D2 = await openBoard({ width: 1280, height: 2000 });
      await D2.page.screenshot({ path: path.join(SHOTS, 'fbs-board-1280.png'), fullPage: false });
      await D2.ctx.close();
      console.log('  screenshots in ' + SHOTS);
    } catch (e) { console.log('  (screenshots failed: ' + e.message + ')'); }
  }

  const allErrors = D.errors.concat(M.errors);
  chk('the page raised no uncaught errors while the board was driven',
    allErrors.length === 0, allErrors.slice(0, 5));

  await M.ctx.close();
  await browser.close();
  site.srv.close();
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach(f => console.log('  - ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  }
  finish();
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
