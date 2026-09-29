#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS IN A REAL BROWSER (desktop 1280 and a 390 px phone).

   app.html, players/index.html, record.html and 404.html served from the
   repository; the NFL props files replaced by the fixture board priced through
   the production code (tools/props/_fixture.js: capture.parseEvent →
   mergeGame → build.reprice, INVENTED prices) and the browser clock fixed at
   the fixture's "now", so every freshness state is what the build saw.

     - Research → Props: the tab, the board, filters, sorting, a BET chip,
       the league switch, the three segments
     - the drawer: decision, hero numbers, WHY / RISKS, market, distribution,
       every line and price with its highlights, the calculator, opportunity,
       availability, environment, reliability; its deep link; Esc closes it
     - the game-card section and "view all props for this game"
     - the Lab's Player props validation tool
     - the player page, the player index and the /players/nfl/<slug> route
     - the public record's player-prop section (empty state)
     - a phone: cards instead of the table, no sideways scroll

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/props/props_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const X = require('./_fixture.js');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function finish() {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | player props (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

/* ------------------------------------------------ the priced fixture board */
const F = X.load();
const better = (b) => b.bookmakers.forEach((bk) => bk.markets.forEach((m) => { if (m.key === 'player_reception_yds') m.outcomes.forEach((o) => { if (o.description === 'Davante Adams') { o.point = 63.5; o.price = o.name === 'Over' ? 120 : -145; } }); }));
const cap = X.capture(F, X.NOW - 5 * 60000, null, better);
const priced = X.board(F, X.NOW, cap.file, cap.unmapped);
const BOARD = priced.board, GAMEFILE = priced.asm.gameFiles[0];
const idx = {};
Object.values(F.registry.players).forEach((p) => { if (BOARD.rows.some((r) => r.pid === p.id)) idx[p.id] = [p.name, p.slug, p.position, p.team, null, p.ids.espn || null, p.jersey || null]; });
const OVERRIDE = {
  '/football/props/nfl/board.json': JSON.stringify(BOARD),
  ['/football/props/nfl/games/' + X.GID + '.json']: JSON.stringify(GAMEFILE),
  ['/football/props/nfl/markets/' + X.GID + '.json']: JSON.stringify(cap.file),
  '/football/props/nfl/players_index.json': JSON.stringify({ schema: 'edgedesk_player_index_v1', league: 'NFL', cols: ['name', 'slug', 'position', 'team', 'headshot', 'espn_id', 'jersey'], players: idx }),
  '/football/props/cfb/players_index.json': JSON.stringify({ schema: 'edgedesk_player_index_v1', league: 'CFB', players: {} })
};
const ADAMS = BOARD.rows.find((r) => r.name === 'Davante Adams' && r.prop === 'rec_yds');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.svg': 'image/svg+xml' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (OVERRIDE[p]) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(OVERRIDE[p]); return; }
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    /* a static host serves 404.html for an unknown address (GitHub Pages) */
    if (!/\.(json|js|css|csv)$/.test(p)) { res.writeHead(404, { 'content-type': TYPES['.html'] }); res.end(fs.readFileSync(path.join(ROOT, '404.html'))); return; }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port, BASE = 'http://127.0.0.1:' + port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function context(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.clock.setFixedTime(new Date(X.NOW));
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) {}
      /* the account's first-run setup is not what this test reads: it opens
         over the page after two quiet seconds, so it is taken down on sight */
      var t = setInterval(function () { if (window.EDMine) { window.EDMine._onbShown = true; clearInterval(t); } }, 5);
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(X.NOW + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (/fonts\.(googleapis|gstatic)/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    return { ctx, page, errors };
  }
  const drawerOpen = (page) => page.waitForSelector('.edp-ov .edp-drawer .edp-action', { timeout: 20000 });
  const closeDrawers = (page) => page.evaluate(() => { document.querySelectorAll('.edp-ov').forEach((o) => { if (o.__close) o.__close(true); else o.remove(); }); });

  /* ================================================================ DESKTOP */
  console.log('\n== desktop 1280 ==');
  const A = await context({ width: 1280, height: 1800 });
  const page = A.page;
  await page.goto(BASE + '/app.html#research/props', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.EDPropsUI && !!document.querySelector('#prBoard .edp-tbl tbody tr'), null, { timeout: 45000 });
  await page.click('text=Skip for now', { timeout: 1500 }).catch(() => {});

  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.evaluate(() => document.querySelectorAll('.edm-ov').forEach((o) => o.remove())); await page.screenshot({ path: path.join(SHOTS, 'props_board_desktop.png') }); }
  const nav = await page.evaluate(() => ({ subs: Array.from(document.querySelectorAll('.research-sub button')).map((b) => b.dataset.sub), on: (document.querySelector('.research-sub button.on') || {}).dataset }));
  chk('the Research sub-nav carries Props after Football', nav.subs.join() === 'rdesk,football,props,ufc,baseball,stats,lab', nav.subs);
  chk('and Props is the active tab', nav.on && nav.on.sub === 'props', nav.on);

  const board = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#prBoard .edp-tbl tbody tr'));
    return { n: rows.length, bets: document.querySelectorAll('#prBoard .edp-tbl .edp-dec.bet').length, watch: document.querySelectorAll('#prBoard .edp-tbl .edp-dec.watch').length,
      banner: (document.querySelector('#prBoard .edp-banner.warn') || {}).textContent || '', kpis: (document.querySelector('#prBoard .edp-kpis') || {}).textContent || '',
      heads: Array.from(document.querySelectorAll('#prBoard .edp-tbl th')).map((t) => t.textContent.replace(/[↓↑]/g, '').trim()) };
  });
  chk('the board lists every prop of the fixture game', board.n === BOARD.rows.length, [board.n, BOARD.rows.length]);
  chk('the columns: player, prop, line, best price, fair line, projection, P(Over), P(Under), fair odds, edge, EV, reliability, move, decision',
    ['Player', 'Prop', 'Line', 'Best price', 'Fair line', 'Proj', 'P(O/U)', 'Fair odds', 'Edge', 'EV', 'Decision', 'Reliab.', 'Move'].every((h) => board.heads.indexOf(h) >= 0), board.heads);
  chk('a real price produces a BET chip, and WATCH where availability is pending', board.bets === 1 && board.watch >= 2, board);
  chk('with a capture on file there is no PROJECTION ONLY banner', !/Projection only/i.test(board.banner), board.banner);
  chk('the KPIs count projected, priced and BET · LEAN · WATCH', /Props projected/.test(board.kpis) && /Priced by books/.test(board.kpis) && /BET · LEAN · WATCH/.test(board.kpis));

  /* filters */
  await page.selectOption('#prBoard select[data-f="dec"]', 'ACTION');
  const act = await page.evaluate(() => Array.from(document.querySelectorAll('#prBoard .edp-tbl tbody tr .edp-dec')).map((d) => d.textContent));
  chk('filter BET + LEAN shows only actionable rows', act.length >= 1 && act.every((t) => /^(BET|LEAN)/.test(t)), act);
  await page.selectOption('#prBoard select[data-f="dec"]', 'ALL');
  await page.click('#prBoard [data-pos="QB"]');
  const qbs = await page.evaluate(() => Array.from(document.querySelectorAll('#prBoard .edp-tbl tbody tr .sub')).map((s) => s.textContent.slice(0, 3)));
  chk('the position chips filter', qbs.length > 0 && qbs.every((t) => t === 'QB '), qbs.slice(0, 4));
  await page.click('#prBoard [data-pos="ALL"]');
  await page.fill('#prBoard input[data-f="q"]', 'Adams');
  await page.waitForTimeout(400);
  const srch = await page.evaluate(() => Array.from(document.querySelectorAll('#prBoard .edp-tbl tbody tr .edp-pl')).map((s) => s.childNodes[0].textContent));
  chk('search narrows to the player', srch.length > 0 && srch.every((n) => n === 'Davante Adams'), srch);
  const books = await page.evaluate(() => Array.from(document.querySelectorAll('#prBoard select[data-f="book"] option')).map((o) => o.textContent));
  chk('the sportsbook filter lists the books that deal these props', books.indexOf('DraftKings') >= 0 && books.indexOf('FanDuel') >= 0 && books.indexOf('BetMGM') >= 0, books);
  await page.fill('#prBoard input[data-f="q"]', '');
  await page.waitForTimeout(400);
  await page.click('#prBoard th[data-sort="ev"]');
  const dir = await page.evaluate(() => window.EDPropsUI.state.sort);
  chk('a column header sorts (EV toggles direction)', dir.k === 'ev' && dir.dir === 1, dir);
  await page.click('#prBoard th[data-sort="ev"]');

  /* the drawer */
  await page.click('#prBoard tr[data-id="' + ADAMS.id + '"]');
  await drawerOpen(page);
  await page.waitForTimeout(300);
  const dr = await page.evaluate(() => {
    const d = document.querySelector('.edp-ov .edp-drawer');
    return { text: d.textContent, secs: Array.from(d.querySelectorAll('.edp-sec h3 span:first-child')).map((x) => x.textContent), tags: Array.from(d.querySelectorAll('.edp-tag')).map((t) => t.textContent),
      action: d.querySelector('.edp-action').textContent, hero: Array.from(d.querySelectorAll('.edp-hero .c .l')).map((x) => x.textContent), svg: !!d.querySelector('svg.edp-dist'), hash: location.hash };
  });
  chk('the drawer opens on the decision: BET at the exact price and book', /BET/.test(dr.action) && /Over 63\.5 \+120/.test(dr.action) && /DraftKings/.test(dr.action), dr.action.slice(0, 200));
  chk('the hero answers line, projection, fair line, probability, best price, no-vig, edge and EV', ['Book line', 'EdgeDesk proj.', 'Fair line', 'Best price', 'No-vig market', 'Edge', 'EV'].every((h) => dr.hero.indexOf(h) >= 0), dr.hero);
  chk('every research section is there', ['Risks · what could make this wrong', 'Market', 'Distribution', 'Every line and price', 'Opportunity', 'Recent form', 'Matchup', 'Availability', 'Game environment'].every((s) => dr.secs.indexOf(s) >= 0) && dr.secs.some((s) => /^Why EdgeDesk/.test(s)) && dr.secs.some((s) => /^Reliability/.test(s)), dr.secs);
  chk('the full distribution is drawn', dr.svg);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'props_drawer_desktop.png') });
  chk('the ladder names BEST PRICE / BEST EV', dr.tags.indexOf('BEST PRICE') >= 0 && dr.tags.indexOf('BEST EV') >= 0, dr.tags);
  chk('the drawer is addressable (#research/props/nfl|<id>)', decodeURIComponent(dr.hash) === '#research/props/nfl|' + ADAMS.id, dr.hash);
  chk('"Research, not picks." is on the page, and no banned word', /Research, not picks/.test(dr.text) && !/\block\b|best bet|safe bet|guarantee/i.test(dr.text));
  await page.fill('.edp-drawer [data-c="line"]', '50.5');
  await page.fill('.edp-drawer [data-c="price"]', '-150');
  await page.waitForTimeout(150);
  const calc = await page.textContent('.edp-drawer [data-c="out"]');
  chk('the calculator prices any line and price on the same distribution', /Over 50\.5 -150: P\(win\) \d+\.\d% .*fair .*break-even 60\.0% .*EV [+−]\d/.test(calc), calc);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.edp-ov'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  chk('Esc closes it and steps the URL back', (await page.evaluate(() => location.hash)) === '#research/props');

  /* the deep link */
  await page.goto(BASE + '/app.html#research/props/nfl%7C' + ADAMS.id, { waitUntil: 'domcontentloaded' });
  const deep = await drawerOpen(page).then(() => true, () => false);
  chk('a deep link opens that prop’s research', deep && /Davante Adams/.test(await page.textContent('.edp-drawer .edp-h1')));
  await closeDrawers(page);

  /* the game-card section */
  const sec = await page.evaluate((gid) => {
    const host = document.createElement('div'); host.id = 'e2eGame'; host.innerHTML = window.EDPropsUI.gameSectionHTML('nfl', gid); document.body.appendChild(host);
    window.EDPropsUI.hydrate(host); return true;
  }, X.GID);
  await page.waitForSelector('#e2eGame .gp', { timeout: 10000 });
  const gs = await page.evaluate(() => ({ grp: Array.from(document.querySelectorAll('#e2eGame .grp')).map((g) => g.textContent), items: document.querySelectorAll('#e2eGame .gp').length, all: !!document.querySelector('#e2eGame [data-allprops]') }));
  chk('the game card’s section: top research prop, disagreements, watch list, pass', sec && gs.grp.indexOf('Top research prop') >= 0 && gs.grp.indexOf('Biggest model / market disagreements') >= 0 && gs.items >= 3, gs);
  chk('with "view all player props for this game"', gs.all);
  /* the test host sits at the end of the page, under the bottom nav: click it directly */
  await page.evaluate(() => document.querySelector('#e2eGame .gp').click());
  chk('a game-card prop opens the same drawer', await drawerOpen(page).then(() => true, () => false));
  await closeDrawers(page);
  await page.evaluate(() => document.querySelector('#e2eGame [data-allprops]').click());
  await page.waitForTimeout(400);
  const scoped = await page.evaluate(() => ({ f: window.EDPropsUI.state.f.game, banner: (document.querySelector('#prBoard .edp-banner') || {}).textContent || '' }));
  chk('"view all" scopes the board to the game', scoped.f && /Showing one game/.test(scoped.banner), scoped);

  /* segments */
  await page.click('#prSeg [data-seg="analytics"]');
  await page.waitForFunction(() => /Walk-forward validation/.test((document.getElementById('prAnalytics') || {}).textContent || ''), null, { timeout: 15000 });
  const an = await page.evaluate(() => ({ t: document.getElementById('prAnalytics').textContent, board: document.getElementById('prBoard').classList.contains('hide') }));
  chk('Validation & record: the walk-forward gates and the live record, the board hidden', /Where EdgeDesk is strong/.test(an.t) && /Live record/.test(an.t) && an.board, an.t.slice(0, 200));
  await page.click('#prSeg [data-seg="rates"]');
  chk('Season rates keeps the older projections reachable', await page.evaluate(() => !document.getElementById('prRates').classList.contains('hide')));
  await page.click('#prSeg [data-seg="board"]');
  await page.click('#prBoard [data-league="cfb"]');
  await page.waitForFunction(() => window.EDPropsUI.state.league === 'cfb' && !!document.querySelector('#prBoard .edp-tbl tbody tr'), null, { timeout: 30000 });
  const cfb = await page.evaluate(() => ({ n: document.querySelectorAll('#prBoard .edp-tbl tbody tr').length, banner: (document.querySelector('#prBoard .edp-banner.warn') || {}).textContent || '' }));
  chk('the league switch loads the FBS board (projection only without a capture)', cfb.n > 20 && /Projection only/i.test(cfb.banner), cfb);
  await page.click('#prBoard [data-league="nfl"]');

  /* the Lab */
  await page.evaluate(() => { window.researchGo('lab'); });
  await page.waitForFunction(() => typeof window.labOpen === 'function', null, { timeout: 15000 });
  await page.evaluate(() => window.labOpen('props'));
  const lab = await page.waitForFunction(() => /Walk-forward validation/.test((document.getElementById('labPropsHost') || {}).textContent || ''), null, { timeout: 20000 }).then(() => true, () => false);
  chk('the Lab’s Player props validation tool renders the same analytics', lab);
  const deskErr = A.errors.filter((e) => /edp|EDProps|props/i.test(e));
  chk('no page error from the props surfaces', deskErr.length === 0, deskErr);
  await A.ctx.close();

  /* ========================================================= PLAYER PAGES */
  console.log('\n== player pages, record, 404 ==');
  const Pp = await context({ width: 1280, height: 1400 });
  await Pp.page.goto(BASE + '/players/?p=nfl/davante-adams', { waitUntil: 'domcontentloaded' });
  await Pp.page.waitForSelector('#host .edp-h1', { timeout: 20000 });
  const pl = await Pp.page.evaluate(() => ({ h1: document.querySelector('#host .edp-h1').textContent, rows: document.querySelectorAll('#host tr[data-id]').length, title: document.title, secs: Array.from(document.querySelectorAll('#host .edp-sec h3 span:first-child')).map((x) => x.textContent) }));
  chk('the player page names the player and lists his props', pl.h1 === 'Davante Adams' && pl.rows >= 3 && /Davante Adams/.test(pl.title), pl);
  chk('with usage, production and the graded history', pl.secs.indexOf('Prop markets and projections') >= 0 && pl.secs.indexOf('Graded history on this player') >= 0, pl.secs);
  await Pp.page.click('#host tr[data-id="' + ADAMS.id + '"]');
  chk('a player-page row opens the research drawer', await drawerOpen(Pp.page).then(() => true, () => false));
  await Pp.page.goto(BASE + '/players/', { waitUntil: 'domcontentloaded' });
  await Pp.page.waitForSelector('#list a', { timeout: 15000 });
  const ix = await Pp.page.evaluate(() => Array.from(document.querySelectorAll('#list a')).map((a) => a.getAttribute('href')));
  chk('the player index links every player on the boards', ix.indexOf('/players/?p=nfl/davante-adams') >= 0 && ix.length >= 8, ix.length);
  await Pp.page.goto(BASE + '/players/nfl/puka-nacua', { waitUntil: 'domcontentloaded' });
  await Pp.page.waitForURL(/\/players\/\?p=nfl\/puka-nacua/, { timeout: 10000 }).catch(() => {});
  chk('/players/nfl/<slug> lands on that player’s page', /\/players\/\?p=nfl\/puka-nacua$/.test(Pp.page.url()), Pp.page.url());
  await Pp.page.goto(BASE + '/record.html', { waitUntil: 'domcontentloaded' });
  const rec = await Pp.page.waitForFunction(() => /Nothing has settled yet|Settled/.test((document.getElementById('propsPub') || {}).textContent || ''), null, { timeout: 15000 }).then(() => Pp.page.textContent('#propsPub'), () => '');
  chk('the public record carries the player-prop section (empty until something settles)', /NFL player props/.test(rec) && /Nothing has settled yet/.test(rec), rec.slice(0, 200));
  const ppErr = Pp.errors.filter((e) => /edp|EDProps|props/i.test(e));
  chk('no page error on the player pages or the record', ppErr.length === 0, ppErr);
  await Pp.ctx.close();

  /* ================================================================ PHONE */
  console.log('\n== phone 390 ==');
  const M = await context({ width: 390, height: 844 });
  await M.page.goto(BASE + '/app.html#research/props', { waitUntil: 'domcontentloaded' });
  await M.page.waitForFunction(() => !!document.querySelector('#prBoard .edp-card'), null, { timeout: 45000 });
  await M.page.click('text=Skip for now', { timeout: 1500 }).catch(() => {});
  const mb = await M.page.evaluate(() => ({ table: getComputedStyle(document.querySelector('#prBoard .edp-tblwrap')).display, cards: document.querySelectorAll('#prBoard .edp-card').length,
    sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  chk('a phone gets cards, not the table', mb.table === 'none' && mb.cards > 0, mb);
  chk('and never scrolls sideways', mb.sw <= mb.iw + 1, mb);
  await M.page.click('#prBoard .edp-card[data-id="' + ADAMS.id + '"]');
  await drawerOpen(M.page);
  const md = await M.page.evaluate(() => { const d = document.querySelector('.edp-drawer').getBoundingClientRect(); return { w: d.width, iw: window.innerWidth, sw: document.documentElement.scrollWidth }; });
  chk('the drawer fills the phone and does not overflow it', md.w <= md.iw + 1 && md.w >= md.iw - 24 && md.sw <= md.iw + 1, md);
  if (SHOTS) { await M.page.screenshot({ path: path.join(SHOTS, 'props_drawer_phone.png'), fullPage: false }); }
  await M.ctx.close();

  await browser.close();
  srv.close();
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
