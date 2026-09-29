#!/usr/bin/env node
/* ===========================================================================
   THE CONNECTED RESEARCH JOURNEY, IN A REAL BROWSER. By default on an NFL
   board BUILT IN THIS PROCESS by football/props/build_board.js from the
   committed real-data fixture (football/props/fixtures, with the committed
   calibration and correlation files) and its summary, the page's clock
   pinned five minutes after the capture; with --live, on the committed
   boards themselves (football/props/<lg>/board.json and summary.json, which
   change hourly), ten minutes after their capture.

     matchup  a game's PLAYER PROP RESEARCH: the top opportunities in full
              (projection, line, best price, fair probability, break-even,
              EV, edge, confidence, books, quote age, decision), the QB / RB /
              WR-TE / TD groups, and Research prop · Add to Card · Compare
              books · View player
     research PLAYER PROPS TO RESEARCH for one game from the summary (and its
              empty states), TOP PLAYER PROP RESEARCH across both leagues
     card     two props added from research sit on the EdgeDesk Card beside
              the game decisions: one bankroll, one exposure, the correlated-
              exposure warning, GROUP BY GAME with the total game exposure,
              the saved price re-checked against the market now
     phone    no horizontal scroll at 390 px

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/opportunity/opportunity_ui.e2e.js [--live] [--shots <dir>]
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8' };
const LIVE = args.indexOf('--live') >= 0;
const CFBS = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'cfb', 'summary.json'), 'utf8'));
const CFB_NR = (Object.values(CFBS.events).find((e) => e.capture.state === 'NOT_RELEASED') || {}).game_id;
let NFL = null, NOW = null, GID = null, FAR = null;
const served = {};
async function fixture() {
  const os = require('os'), zlib = require('zlib');
  global.window = global.window || global;
  ['research_core', 'edgedesk_vocab', 'edgedesk_market', 'edgedesk_decision', 'edgedesk_bankroll', 'research_priority', 'edgedesk_props'].forEach((f) => require(path.join(ROOT, 'lib', f + '.js')));
  const C = require(path.join(ROOT, 'football', 'props', 'config.js')), CAP = require(path.join(ROOT, 'football', 'props', 'capture.js')), B = require(path.join(ROOT, 'football', 'props', 'build_board.js'));
  const SUM = require(path.join(ROOT, 'football', 'props', 'build_summary.js'));
  const FX = path.join(ROOT, 'football', 'props', 'fixtures'), T = Date.parse('2026-10-04T15:10:00Z'), OBS = '2026-10-04T15:05:00.000Z';
  const ds = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FX, 'dataset_nfl.json.gz'))).toString('utf8'));
  const EVENT = JSON.parse(fs.readFileSync(path.join(FX, 'odds_event_nfl.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-oppui-')), P0 = C.leaguePaths('nfl', 2026), BP = {};
  Object.keys(P0).forEach((k) => { BP[k] = P0[k].replace(C.DIR, tmp); });
  fs.mkdirSync(BP.dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'correlation.json'), BP.correlation);
  fs.copyFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'calibration.json'), BP.calibration);
  const pq = CAP.parseEventProps(EVENT, OBS);
  const feed = CAP.buildQuotesFeed({ league: 'nfl', now: T, polled: [{ id: EVENT.id, commence_time: EVENT.commence_time, home_team: EVENT.home_team, away_team: EVENT.away_team, books: pq.books, quotes: pq.quotes }], observed_at: OBS });
  const r = await B.build({ league: 'nfl', season: 2026, now: T - 5 * 60000, dataset: ds, quotes: feed, lines: null, paths: BP });
  r.board.capture = { status: 'SUCCESS', reason: 'QUOTES_WRITTEN', last_run: OBS, last_success_at: OBS, last_attempt: OBS, completed_at: OBS, bookmakers: pq.books, books_returned: pq.books, events_polled: 1, events_checked: 1, window_h: 96 };
  const S = SUM.summarize(r.board, null);
  served['/football/props/nfl/board.json'] = JSON.stringify(r.board);
  served['/football/props/nfl/players.json'] = JSON.stringify(r.players);
  served['/football/props/nfl/summary.json'] = JSON.stringify(S);
  return { board: r.board, now: T };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  if (LIVE) { NFL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'board.json'), 'utf8')); NOW = Date.parse(NFL.generated_at) + 10 * 60000; }
  else { const f = await fixture(); NFL = f.board; NOW = f.now; }
  GID = (NFL.games.find((g) => g.n_priced > 0) || {}).game_id;
  FAR = (NFL.games.find((g) => !g.n_priced) || {}).game_id;
  console.log(LIVE ? 'LIVE committed boards · ' + NFL.generated_at : 'fixture board (football/props/fixtures) · ' + NFL.generated_at);
  if (!GID) { console.log('SKIPPED: the NFL board prices no game'); process.exit(0); }
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (served[p]) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(served[p]); return; }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) { /* storage */ }
    });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(`http://127.0.0.1:${port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.EDPropsUI && window.EDOpportunity && window.EDDecisionUI && typeof fbPropsSecHTML === 'function', null, { timeout: 20000 });
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  try {
    /* ------------------------------------------------ the matchup section */
    console.log('matchup');
    let { ctx, page, errors } = await open({ width: 1440, height: 900 });
    await page.evaluate((g) => { const d = document.createElement('div'); d.id = 'mx'; d.style.maxWidth = '860px'; d.innerHTML = fbPropsSecHTML('nfl', g); document.body.prepend(d); }, GID);
    /* open from the summary alone, the top opportunities already listed; the board loads on request */
    await page.waitForSelector('#mx .pp-rsec-h.sub', { timeout: 20000 });
    const first = await page.evaluate(() => ({ open: document.querySelector('#mx details').open, cards: document.querySelectorAll('#mx .pp-rc').length, board: !!EDPropsUI.state.boards.nfl, t: document.querySelector('#mx .pp-gsec').textContent.replace(/\s+/g, ' ') }));
    chk('the section is open on the summary alone: TOP PROP OPPORTUNITIES listed, the board not read', first.open && first.cards >= 1 && !first.board && /PLAYER PROP RESEARCH/.test(first.t) && /View all \d+ props/.test(first.t), first);
    await page.click('#mx button:has-text("Load player props")');
    await page.waitForSelector('#mx .pp-ogrp', { timeout: 20000 });
    const mx = await page.evaluate(() => document.querySelector('#mx .pp-gsec').textContent.replace(/\s+/g, ' '));
    chk('PLAYER PROP RESEARCH opens with the top prop opportunities', /PLAYER PROP RESEARCH/.test(mx) && /TOP PROP OPPORTUNITIES/.test(mx), mx.slice(0, 300));
    ['EdgeDesk projection', 'Market line', 'Best price', 'Fair probability', 'Break-even', 'EV', 'Edge', 'Confidence', 'Books at line', 'Quote age', 'Research score'].forEach((k) => chk('a research card shows ' + k, mx.indexOf(k) >= 0));
    chk('…with Why and Concerns', /Why/.test(mx) && /Concerns/.test(mx));
    const acts = await page.evaluate(() => Array.from(document.querySelectorAll('#mx .pp-rc')[0].querySelectorAll('.pp-rc-acts button')).map((b) => b.textContent));
    chk('…and Research prop · Add to Card · Compare books · View player', ['Research prop', 'Add to Card', 'Compare books', 'View player'].every((a) => acts.indexOf(a) >= 0), acts);
    const groups = await page.evaluate(() => Array.from(document.querySelectorAll('#mx .pp-ogrp>summary')).map((s) => s.textContent.split(' ')[0]));
    chk('the QB / RB / WR-TE / TD groups follow', ['QB', 'RB', 'WR', 'TD'].every((g) => groups.indexOf(g) >= 0), groups);
    chk('the probability source is printed', /MODEL-ESTIMATED/.test(mx));
    await page.evaluate(() => document.getElementById('mx').scrollIntoView());
    await shot(page, 'matchup_prop_research');
    /* ------------------------------------------------ ADD TO CARD */
    const added = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('#mx .pp-rc .pp-rc-acts button')).filter((b) => b.textContent === 'Add to Card');
      btns[0].click(); btns[1].click();
      return { t0: btns[0].textContent, n: EDDecisionUI.entries().length, e: EDDecisionUI.entries().map((x) => ({ type: x.type, d: x.decision, u: x.units, line: x.line, price: x.american, book: x.book, p: x.player_name })) };
    });
    chk('Add to Card stores the frozen snapshot (two props from the game)', added.t0 === 'Added to Card' && added.n === 2 && added.e.every((x) => x.type === 'PLAYER_PROP' && x.line != null && x.price != null && x.book), added);
    chk('…a second click on the same prop does not duplicate it', await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#mx .pp-rc .pp-rc-acts button'))[1]; return b.disabled && EDDecisionUI.entries().length === 2; }));
    chk('no page errors in the matchup section', errors.length === 0, errors);

    /* ------------------------------------------------ the Card */
    console.log('card');
    await page.evaluate(() => { document.getElementById('mx').remove(); show('card'); });
    await page.waitForSelector('#eddCardHost .edd-page', { timeout: 15000 });
    await page.waitForFunction(() => /PLAYER PROPS/.test(document.getElementById('eddCardHost').textContent) && !/Checking the current price/.test(document.getElementById('eddCardHost').textContent), null, { timeout: 20000 });
    const card = await page.evaluate(() => document.getElementById('eddCardHost').textContent.replace(/\s+/g, ' '));
    const ent = added.e;
    chk('the Card lists the saved props beside the game decisions, with price and book', ent.every((x) => card.indexOf(x.p) >= 0) && /PROP/.test(card), card.slice(0, 500));
    const bets = ent.filter((x) => x.d === 'BET');
    chk('one exposure: the saved BET units are in TOTAL EXPOSURE, split GAMES / PLAYER PROPS', !bets.length || (/GAMES/.test(card) && /PLAYER PROPS/.test(card) && new RegExp((bets.reduce((a, x) => a + x.u, 0)).toFixed(2) + 'U').test(card)), card.slice(0, 400));
    chk('the saved price is checked against the market now (unchanged here)', /Unchanged since saved|Minor price change since saved/.test(card), card.match(/Saved [^·]+·[^·]+/g));
    chk('two props on one game carry the correlated-exposure warning', bets.length < 2 || /CORRELATED EXPOSURE/.test(card));
    await shot(page, 'card_combined');
    await page.check('#eddCardHost input[data-edd-act="group"]');
    await page.waitForFunction(() => /TOTAL GAME EXPOSURE/.test(document.getElementById('eddCardHost').textContent), null, { timeout: 5000 });
    const grp = await page.evaluate(() => document.getElementById('eddCardHost').textContent.replace(/\s+/g, ' '));
    chk('GROUP BY GAME: the game, its PROPS, and the total game exposure', /TOTAL GAME EXPOSURE/.test(grp) && /PROPS/.test(grp), grp.slice(0, 400));
    await shot(page, 'card_grouped');
    await page.uncheck('#eddCardHost input[data-edd-act="group"]');
    await page.click('#eddCardHost .edd-f[data-edd-v="props"]');
    const onlyProps = await page.evaluate(() => ({ saved: document.querySelectorAll('#eddCardHost .edd-r-saved').length, engine: document.querySelectorAll('#eddCardHost .edd-row:not(.edd-r-saved)').length, sub: !!document.querySelector('#eddCardHost .edd-sub') }));
    chk('the Props filter shows only props, with Passing / Rushing / Receiving / TD beneath', onlyProps.saved === 2 && onlyProps.engine === 0 && onlyProps.sub, onlyProps);
    await page.click('#eddCardHost .edd-f[data-edd-v="all"]');
    await page.click('#eddCardHost .edd-rm');
    chk('Remove takes a position off the Card', await page.evaluate(() => EDDecisionUI.entries().length === 1));
    chk('no page errors on the Card', errors.length === 0, errors);

    /* ------------------------------------------------ research modules */
    console.log('research');
    await page.evaluate(() => EDPropsUI.loadSummary('nfl'));
    await page.evaluate(() => EDPropsUI.loadSummary('cfb'));
    const sec = await page.evaluate((g) => { const ev = EDOpportunity.eventFromSummary(EDPropsUI.state.summaries.nfl, g, Date.now()); const d = document.createElement('div'); d.id = 'rs'; d.innerHTML = EDPropsUI.eventSectionHTML(ev, { n: 3 }); document.body.prepend(d); return d.textContent.replace(/\s+/g, ' '); }, GID);
    chk('PLAYER PROPS TO RESEARCH on the game card: up to three, then "View all N props →"', /PLAYER PROPS TO RESEARCH/.test(sec) && /View all \d+ props →/.test(sec) && (await page.evaluate(() => document.querySelectorAll('#rs .pp-rc').length)) === 3, sec.slice(0, 300));
    const far = await page.evaluate((g) => EDPropsUI.eventSectionHTML(EDOpportunity.eventFromSummary(EDPropsUI.state.summaries.nfl, g, Date.now()), { league: 'nfl', game_id: g }).replace(/<[^>]+>/g, ' '), FAR);
    chk('a game outside the capture window says EdgeDesk has not asked yet, and offers the projections', /has not asked the sportsbooks/.test(far) && /View projections/.test(far), far);
    if (CFB_NR) {
      const nr = await page.evaluate((g) => EDPropsUI.eventSectionHTML(EDOpportunity.eventFromSummary(EDPropsUI.state.summaries.cfb, g, Date.now()), { league: 'cfb', game_id: g }).replace(/<[^>]+>/g, ' '), CFB_NR);
      chk('a college game whose markets are not released says exactly that', /have not released enough player markets/.test(nr), nr);
    }
    const top = await page.evaluate(() => { const d = document.createElement('div'); d.id = 'tp'; d.innerHTML = fbPsTopHTML(); document.body.prepend(d); return { t: d.textContent.replace(/\s+/g, ' '), n: d.querySelectorAll('.pp-toprow').length }; });
    chk('TOP PLAYER PROP RESEARCH lists the league leaders with EV, confidence and book count', /TOP PLAYER PROP RESEARCH/.test(top.t) && top.n >= 1 && /EV/.test(top.t) && /Confidence/.test(top.t) && /books?/.test(top.t), top);
    await page.evaluate(() => document.getElementById('tp').scrollIntoView());
    await shot(page, 'research_modules');
    chk('no page errors in the research modules', errors.length === 0, errors);
    await ctx.close();

    /* ------------------------------------------------ phone */
    console.log('phone');
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await page.evaluate((g) => { const d = document.createElement('div'); d.id = 'mx'; d.innerHTML = fbPropsSecHTML('nfl', g); document.body.prepend(d); d.querySelector('details').open = true; }, GID);
    await page.waitForSelector('#mx .pp-gfoot', { timeout: 20000 });
    chk('no horizontal scroll with prop research on a phone', await noHScroll(page));
    await shot(page, 'phone_matchup_props');
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#mx .pp-rc .pp-rc-acts button')).filter((x) => x.textContent === 'Add to Card')[0]; b.click(); document.getElementById('mx').remove(); show('card'); });
    await page.waitForSelector('#eddCardHost .edd-r-saved', { timeout: 15000 });
    chk('no horizontal scroll on the combined Card on a phone', await noHScroll(page));
    await shot(page, 'phone_card');
    chk('no page errors on the phone', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    fail++; console.log('  FAIL (threw) ' + (e && e.stack || e));
  } finally {
    await browser.close(); srv.close();
  }
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | connected research (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
