#!/usr/bin/env node
/* ===========================================================================
   GAME RESEARCH, IN A REAL BROWSER — app.html in Chromium at a 390 px phone
   and a 1280 px desktop. docs/game-research/README.md

   The research snapshots are the committed ones (football/game_research/).
   The market is staged per scenario by rewriting the committed CFB board's
   market state (football/cfb_terminal/board.json) as the page fetches it:
     FRESH   one game's quote captured 10 minutes ago        → LIVE
     STALE   one game's quote captured 30 hours ago          → last known only
     NONE    one game with no quote                          → unavailable
   The NFL runs with the odds feed down (no captured signals, no nflverse
   schedule): the research must stand complete. One snapshot is rewritten as
   a DATA FAULT to prove it is prominent. Kalshi (public.kalshi_card_current)
   is staged too: FRESH has both teams priced, listed with the book's home
   and away swapped and mascots on the names, so the graphic must place each
   price by team; NONE has a market too wide to trust; the NFL game has none.
   The graphic compares Kalshi at the model's time, so
   public.kalshi_price_snapshots answers each market's quote nearest the time
   the page asks about: a minute after it (and one four minutes before).
   Fonts and every third-party host are stubbed, so the run is offline and
   deterministic.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/football/game_research_ui.e2e.js [--shots <dir>]
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
/* what the page prints of a snapshot's projection: model.display
   (football_half_point_v1) when the snapshot has one, else its own numbers */
const fairOf = (g) => (g.model.display ? g.model.display.spread.text : g.model.fair.text);
const totalOf = (g) => (g.model.display ? g.model.display.total.text : g.model.total.toFixed(1));
function finish(code) {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | game research (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(code != null ? code : (fail ? 1 : 0));
}

const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
const BOARD = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'board.json'), 'utf8'));
const NOW = Date.now();
const cfb = CUR.games.filter((g) => g.league === 'cfb' && g.model.available && !g.started);
const nfl = CUR.games.filter((g) => g.league === 'nfl' && g.model.available && !g.started);
const boardBy = {}; BOARD.rows.forEach((r) => { boardBy[String(r.game_id)] = r; });
const withRow = cfb.filter((g) => boardBy[g.game_id]);
const FRESH = withRow[0], STALE = withRow[1], NONE = withRow[2], FAULT = withRow[3] || cfb[3], NFLG = nfl[0];
function stagedBoard() {
  const b = JSON.parse(JSON.stringify(BOARD));
  b.rows.forEach((r) => {
    const id = String(r.game_id);
    if (FRESH && id === FRESH.game_id) {
      r.market_state = { state: 'LIVE', label: 'LIVE', captured_at: new Date(NOW - 10 * 60000).toISOString(), verified: true, integrity: 'PASS', spread: Math.round((FRESH.model.fair.home_line + 2) * 2) / 2, total: Math.round(FRESH.model.total) + 0.5, provider: 'OK' };
      r.bettor = Object.assign({}, r.bettor || {}, { decision: 'PASS', label: 'PASS', blocker_codes: [], reason: 'The raw model edge disappears after calibration.', quote: { sportsbook: 'draftkings' } });
    } else if (STALE && id === STALE.game_id) {
      r.market_state = { state: 'CACHED', label: 'CACHED', captured_at: new Date(NOW - 30 * 3600e3).toISOString(), verified: false, integrity: 'PASS', spread: -7.5, total: 50.5, provider: 'OK' };
      r.bettor = Object.assign({}, r.bettor || {}, { decision: 'NO_DECISION', label: 'NO DECISION', blocker_codes: ['STALE_QUOTE'], quote: null });
    } else if (NONE && id === NONE.game_id) {
      r.market_state = { state: 'UNAVAILABLE', label: 'MARKET UNAVAILABLE', captured_at: null, spread: null, total: null, provider: 'QUOTA_EXHAUSTED' };
      r.bettor = Object.assign({}, r.bettor || {}, { decision: 'NO_DECISION', label: 'NO DECISION', blocker_codes: ['NO_MARKET'], quote: null });
    }
  });
  return b;
}
/* kalshi_card_current's rows, as anon reads them (no gap) */
function stagedKalshi() {
  const row = (g, yes, opp, st, mid) => ({ sport: g.league, game_id: g.game_id, game_key: g.game_key, odds_event_id: 'ev-' + g.game_id, event_ticker: 'KXNCAAFGAME-E2E' + g.game_id,
    market_ticker: 'KXNCAAFGAME-E2E' + g.game_id + '-' + yes.slice(0, 3).toUpperCase(), kalshi_yes_name: yes, yes_team: yes + ' Hawks', opponent: opp + ' Hawks',
    home_team: g.away.name + ' Hawks', away_team: g.home.name + ' Hawks', kickoff_at: g.kickoff, match_confidence: 'high', pregame: true, state: st,
    snapshot_at: new Date(NOW - 3 * 60000).toISOString(), snapshot_age_minutes: 3, yes_mid: st === 'OK' ? mid : null, yes_bid: mid - 0.01, yes_ask: mid + 0.01,
    spread: st === 'OK' ? 0.02 : 0.11, volume: 4200, gap_pp: null, book_fair_prob: null });
  return [row(FRESH, FRESH.away.name, FRESH.home.name, 'OK', 0.415), row(FRESH, FRESH.home.name, FRESH.away.name, 'OK', 0.59),
    row(NONE, NONE.away.name, NONE.home.name, 'WIDE_SPREAD', 0.5), row(NONE, NONE.home.name, NONE.away.name, 'WIDE_SPREAD', 0.5)];
}
/* kalshi_price_snapshots, as the page asks for it: one market's quote at or before (lte, desc) or at
   or after (gte, asc) a time; staged a minute after and four minutes before, at the staged row's bid and ask */
function stagedSnapshots(url) {
  const u = new URL(url), tk = (u.searchParams.get('ticker') || '').replace(/^eq\./, ''), at = u.searchParams.get('captured_at') || '';
  const row = stagedKalshi().find((x) => x.market_ticker === tk), t = Date.parse(at.replace(/^(lte|gte)\./, ''));
  if (!row || !isFinite(t)) return [];
  /* the quote's own bid and ask: a 2¢ spread where the row is OK, 11¢ where it is too wide */
  const mid = row.yes_mid != null ? row.yes_mid : (row.yes_bid + row.yes_ask) / 2, half = row.spread / 2;
  return [{ ticker: tk, captured_at: new Date(t + (/^gte\./.test(at) ? 60000 : -240000)).toISOString(), yes_bid: Math.round((mid - half) * 1e4) / 1e4, yes_ask: Math.round((mid + half) * 1e4) / 1e4, volume: row.volume }];
}
function stagedCurrent() {
  const c = JSON.parse(JSON.stringify(CUR));
  const f = c.games.find((g) => g.game_key === FAULT.game_key);
  f.data.status = 'FAULT'; f.data.faults = ['scores_reconcile: the score line differs from the margin by 0.4 points'];
  f.checks.ok = false; f.checks.failed = [{ id: 'scores_reconcile', detail: 'the score line differs from the margin by 0.4 points' }];
  return c;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  if (p === '/football/cfb_terminal/board.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(stagedBoard())); return; }
  if (p === '/football/game_research/current.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(stagedCurrent())); return; }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  if (!FRESH || !STALE || !NONE || !NFLG) { console.log('SKIPPED: the committed slate has too few upcoming games to stage the scenarios'); process.exit(0); }
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
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
  const sched = fs.existsSync(path.join(__dirname, 'fixtures', 'fbs_schedule_sample.csv')) ? fs.readFileSync(path.join(__dirname, 'fixtures', 'fbs_schedule_sample.csv')) : null;
  async function open(viewport, hash) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:' + port }); } catch (_) { /* older Chromium */ }
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) {}
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (sched && /cfb_schedules_\d{4}\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: sched });
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/kalshi_card_current/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stagedKalshi()) });
        if (/\/kalshi_price_snapshots/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stagedSnapshots(url)) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });   /* no captured odds: the provider is down */
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto('http://127.0.0.1:' + port + '/app.html' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.EDGameView, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 3; i++) { await page.click('text=Skip for now', { timeout: 1000 }).catch(() => {}); await page.waitForTimeout(250); }
    return { ctx, page, errors };
  }
  async function graphicReady(page) {
    return page.waitForFunction(() => { const i = document.getElementById('gvImg'); return i && !i.hidden && i.naturalWidth > 0; }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  }
  async function marketSettled(page) {
    await page.waitForFunction(() => { const m = document.getElementById('gvMarket'); return m && !/Checking for a current/.test(m.innerText); }, null, { timeout: 60000 }).catch(() => {});
  }
  /* the Kalshi read has answered and the graphic on screen was drawn with it */
  async function kalshiSettled(page) {
    await page.waitForFunction(() => { const s = window.EDGameView._state(), i = document.getElementById('gvImg');
      return s.ks && s.img && i && !i.hidden && i.src === s.img.url && !/checking/i.test((document.querySelector('.gv-status') || {}).innerText || ''); }, null, { timeout: 30000 }).catch(() => {});
    return page.evaluate(() => { const s = window.EDGameView._state(); return { content: s.img && s.img.content ? s.img.content.compare || null : null, alt: (document.getElementById('gvImg') || {}).alt || '',
      market: (document.getElementById('gvMarket') || {}).innerText || '' }; });
  }
  const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
  const readPage = (page) => page.evaluate(() => {
    const g = document.querySelector('.gv'), img = document.getElementById('gvImg');
    const secs = Array.from(document.querySelectorAll('.gv > section')).map((s) => s.getAttribute('aria-label'));
    return { view: !document.getElementById('v-game').classList.contains('hide'), status: (document.querySelector('.gv-status') || {}).innerText || '',
      img: img ? { w: img.naturalWidth, h: img.naturalHeight, alt: img.alt } : null, secs, sw: document.documentElement.scrollWidth, vw: window.innerWidth,
      market: (document.getElementById('gvMarket') || {}).innerText || '', overview: (document.querySelector('[aria-label="Game overview"]') || {}).innerText || '',
      watch: document.querySelectorAll('.gv-ins li').length, text: g ? g.innerText : '' };
  });

  /* ---------------------------------------------------------------- phone */
  console.log('\n== 390 px · CFB with a fresh quote: ' + FRESH.away.name + ' @ ' + FRESH.home.name);
  const A = await open({ width: 390, height: 844 }, '#game/cfb/' + FRESH.game_id);
  const page = A.page;
  chk('the graphic draws (1080×1080 PNG)', await graphicReady(page));
  await marketSettled(page);
  let r = await readPage(page);
  chk('the research page is the view on screen', r.view);
  chk('the graphic is the first section', r.secs[0] === 'Matchup graphic' && r.secs.indexOf('Game overview') === 1 && r.secs.indexOf('Market comparison') > r.secs.indexOf('Deep research'), r.secs);
  chk('the graphic is 1080×1080 with a descriptive alt', r.img && r.img.w === 1080 && r.img.h === 1080 && r.img.alt.indexOf(fairOf(FRESH)) >= 0 && /Research, not picks/.test(r.img.alt), r.img);
  chk('four separate answers: research, model, market live, decision', /RESEARCH\s*available/i.test(r.status) && /MODEL\s*active/i.test(r.status) && /MARKET\s*live/i.test(r.status) && /BETTING DECISION\s*PASS/i.test(r.status), r.status);
  chk('the overview carries the snapshot’s numbers', r.overview.indexOf(fairOf(FRESH)) >= 0 && r.overview.indexOf(totalOf(FRESH)) >= 0 && /Win probability/i.test(r.overview) && /Snapshot /.test(r.overview), r.overview.slice(0, 400));
  if (FRESH.model.display) chk('…as football lines: a whole-number projected score, labelled', /PROJECTED SCORE/i.test(r.overview) && r.overview.indexOf(String(FRESH.model.display.score.home)) >= 0 && /whole points/.test(r.overview), r.overview.slice(0, 400));
  chk('what to watch for lists the snapshot’s insights', r.watch === FRESH.insights.length && r.watch >= 2, r.watch);
  chk('a fresh quote: EdgeDesk beside the market, with book and capture time', /EDGEDESK/i.test(r.market) && /MARKET/.test(r.market) && /draftkings/i.test(r.market) && /captured/.test(r.market), r.market);
  chk('no horizontal scroll at 390 px', r.sw <= r.vw, { sw: r.sw, vw: r.vw });
  let ks = await kalshiSettled(page);
  r = await readPage(page);
  chk('Kalshi: priced, a fifth chip beside the four answers', /KALSHI\s*priced/i.test(r.status), r.status);
  const AW = FRESH.away.abbr.toUpperCase(), HM = FRESH.home.abbr.toUpperCase();
  chk('the graphic draws EDGEDESK vs MARKET: the book’s spread and total, then Kalshi for each team', ks.content && ks.content.title === 'EDGEDESK vs MARKET'
    && ks.content.cols.map((c) => c.head).join('|') === 'SPREAD|TOTAL|' + AW + ' WIN % · ML|' + HM + ' WIN % · ML', ks.content);
  chk('…each team’s Kalshi price on its own team, though the book listed them the other way round', ks.content && /^41\.5% /.test(ks.content.cols[2].mk) && /^59\.0% /.test(ks.content.cols[3].mk), ks.content && ks.content.cols);
  chk('…and its alt text reads the table, with both times and the sources', /EdgeDesk vs the market \(Model \d{1,2}:\d{2} [AP]M ET · Kalshi \d{1,2}:\d{2} [AP]M ET · DraftKings .*Kalshi mid .*before Kalshi’s fees\)/.test(ks.alt), ks.alt);
  chk('…Kalshi is compared at the model’s time: a minute after it, both times on the card', ks.content && ks.content.kalshi && ks.content.kalshi.available
    && ks.content.times === 'Model ' + await page.evaluate((iso) => window.EDGameGraphic.clock(iso), FRESH.model.built_at) + ' · Kalshi ' + await page.evaluate((iso) => window.EDGameGraphic.clock(new Date(Date.parse(iso) + 60000).toISOString()), FRESH.model.built_at), ks.content && ks.content.times);
  chk('…and the difference is a sentence naming the team', ks.content && /^EdgeDesk \d+\.\d pts (higher|lower) on [A-Z&]+ than Kalshi$|^EdgeDesk matches Kalshi on /.test(ks.content.kalshi.diff), ks.content && ks.content.kalshi);
  chk('the Market comparison section sets EdgeDesk beside Kalshi, team by team', /EdgeDesk vs Kalshi/.test(ks.market) && /41\.5%/.test(ks.market) && /59\.0%/.test(ks.market) && /before Kalshi’s trading fees/.test(ks.market), ks.market.slice(-600));
  await shot(page, 'phone_fresh');

  /* levels */
  await page.click('[data-gv-act=level][data-gv-v=beginner]');
  let lv = await page.evaluate(() => document.querySelector('.gv-lvbody').innerText);
  chk('Beginner: a plain-language answer first', /EdgeDesk’s model (expects|sees)/.test(lv) && /out of 100|not a chance of being right|eight of ten/i.test(lv), lv.slice(0, 300));
  await page.click('[data-gv-act=level][data-gv-v=lab]');
  lv = await page.evaluate(() => document.querySelector('.gv-lvbody').innerText);
  chk('Lab: model, inputs, consistency checks, market diagnostics, definitions', /Consistency checks/.test(lv) && /✓ scores reconcile/.test(lv) && /Market diagnostics/.test(lv) && /Definitions/.test(lv) && /football\/fbs\/slate\.json/.test(lv), lv.slice(0, 300));
  await page.click('[data-gv-act=level][data-gv-v=research]');
  lv = await page.evaluate(() => document.querySelector('.gv-lvbody').innerText);
  chk('Research: the projection, unit rankings and the model’s terms', /The projection/.test(lv) && /Unit rankings/.test(lv) && /What moves EdgeDesk’s number|80% outcome range/.test(lv), lv.slice(0, 300));
  chk('the level is remembered with the decision card’s own key', await page.evaluate(() => JSON.parse(localStorage.getItem('edgedesk_info_level_v1'))) === 'research');
  chk('Research: the scoring distribution from the same run', /Scoring distribution/.test(lv) && /Total points\s*80% between/.test(lv), lv.slice(0, 600));
  await page.click('[data-gv-act=alts]');
  await page.waitForFunction(() => /covers/.test((document.getElementById('gvAlt') || {}).innerText || '') || /could not|No probability/.test((document.getElementById('gvAlt') || {}).innerText || ''), null, { timeout: 20000 }).catch(() => {});
  const alt = await page.evaluate(() => { const h = document.getElementById('gvAlt'); return { t: h.innerText, rows: h.querySelectorAll('tbody tr').length }; });
  chk('Fair alternate lines: both ladders, labelled model estimates', alt.rows >= 10 && /covers/i.test(alt.t) && /over/i.test(alt.t) && /not sportsbook prices/i.test(alt.t), alt.t.slice(0, 300));

  /* compare a price */
  await page.selectOption('#gvPrice select[name=side]', 'home');
  await page.fill('#gvPrice input[name=line]', String(Math.round(FRESH.model.fair.home_line * 2) / 2));
  await page.fill('#gvPrice input[name=american]', '-110');
  await page.click('#gvPrice button[type=submit]');
  await page.waitForFunction(() => /Price implies|could not|outside/.test((document.getElementById('gvPriceOut') || {}).innerText || ''), null, { timeout: 20000 }).catch(() => {});
  let po = await page.evaluate(() => document.getElementById('gvPriceOut').innerText);
  chk('a typed spread is labelled user-entered and unverified', /USER-ENTERED, UNVERIFIED SPORTSBOOK QUOTE/i.test(po), po.slice(0, 200));
  chk('…with the implied probability, the model cover probability, the difference and fair odds', /Price implies\s*52\.4%/.test(po) && /model cover probability/i.test(po) && /Difference/.test(po) && /EdgeDesk fair odds/.test(po), po.slice(0, 500));
  chk('…and EV only where the probabilities are calibrated (or the reason it is withheld)', /Expected value\s*([+−]\d+\.\d% per unit|Expected value is not shown)/.test(po), po);
  await page.fill('#gvPrice input[name=american]', '+50');
  await page.click('#gvPrice button[type=submit]');
  await page.waitForTimeout(300);
  po = await page.evaluate(() => document.getElementById('gvPriceOut').innerText);
  chk('impossible odds are refused with the rule', /American odds are \+100 or higher, or -100 or lower/.test(po), po);
  chk('a typed price is never stored', await page.evaluate(() => Object.keys(localStorage).every((k) => !/price|quote/i.test(k) || /level/.test(k))));

  /* download + share */
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('[data-gv-act=download]')]);
  let buf = fs.readFileSync(await dl.path());
  chk('Download PNG: a 1080×1080 PNG named for the matchup', buf.slice(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === 1080 && buf.readUInt32BE(20) === 1080 && /^edgedesk-.+-at-.+-square\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await page.click('[data-gv-act=format][data-gv-v=portrait]');
  await graphicReady(page);
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('[data-gv-act=download]')]);
  buf = fs.readFileSync(await dl2.path());
  chk('Portrait: a 1080×1350 PNG', buf.readUInt32BE(16) === 1080 && buf.readUInt32BE(20) === 1350 && /-portrait\.png$/.test(dl2.suggestedFilename()), dl2.suggestedFilename());
  await page.click('[data-gv-act=copy]');
  await page.waitForTimeout(400);
  const msg = await page.evaluate(() => document.getElementById('gvMsg').innerText);
  chk('Copy link: the research page’s own link', msg.indexOf('#game/cfb/' + FRESH.game_id) >= 0, msg);
  await page.click('[data-gv-act=share]');
  await page.waitForTimeout(600);
  const msg2 = await page.evaluate(() => document.getElementById('gvMsg').innerText);
  chk('Share without the Web Share API falls back to the link, plainly', /link was copied|#game\/cfb\//.test(msg2) || /Saved|Link copied/.test(msg2), msg2);
  chk('no page errors on the phone (fresh)', A.errors.length === 0, A.errors);
  await A.ctx.close();

  console.log('\n== 390 px · CFB with a stale quote: ' + STALE.away.name + ' @ ' + STALE.home.name);
  const S2 = await open({ width: 390, height: 844 }, '#game/cfb/' + STALE.game_id);
  await graphicReady(S2.page); await marketSettled(S2.page);
  r = await readPage(S2.page);
  chk('stale odds: the market reads as last known, never live', /MARKET\s*last known \(not current\)/i.test(r.status), r.status);
  chk('stale odds: the decision is not evaluated, and says so without an error', /BETTING DECISION\s*not evaluated/i.test(r.status) && !/STALE_QUOTE/.test(r.status), r.status);
  chk('stale odds: the calm note, the last known number labelled, research intact', /Live sportsbook prices are currently unavailable\. EdgeDesk’s independent matchup projections remain available\./.test(r.market) && /not a current price/.test(r.market) && r.overview.indexOf(fairOf(STALE)) >= 0, r.market);
  chk('stale odds: the blocker code is in Lab, not on the page', !/STALE_QUOTE/.test(r.text.replace(/Lab[\s\S]*$/, '')) , null);
  await S2.page.click('[data-gv-act=level][data-gv-v=lab]');
  chk('…and Lab names it', /STALE_QUOTE/.test(await S2.page.evaluate(() => document.querySelector('.gv-lvbody').innerText)));
  await S2.page.click('[data-gv-act=level][data-gv-v=research]');
  await S2.ctx.close();

  console.log('\n== 390 px · CFB with no quote at all: ' + NONE.away.name + ' @ ' + NONE.home.name);
  const S3 = await open({ width: 390, height: 844 }, '#game/cfb/' + NONE.game_id);
  chk('no odds: the graphic still draws', await graphicReady(S3.page));
  await marketSettled(S3.page);
  r = await readPage(S3.page);
  chk('no odds: market unavailable, research and model untouched', /MARKET\s*unavailable/i.test(r.status) && /RESEARCH\s*(available|limited)/i.test(r.status) && /MODEL\s*active/i.test(r.status), r.status);
  chk('no odds: the calm note and the door to Compare my number', /Live sportsbook prices are currently unavailable/.test(r.market) && /Compare it with EdgeDesk’s model/.test(r.market), r.market);
  chk('no odds: no "NO DECISION" anywhere on the page', !/NO DECISION/.test(r.text), null);
  ks = await kalshiSettled(S3.page);
  r = await readPage(S3.page);
  chk('a Kalshi market too wide to trust: the chip says so and the graphic says "Kalshi price unavailable at model time", comparing nothing', /KALSHI\s*wide spread/i.test(r.status)
    && ks.content && ks.content.kalshi.available === false && ks.content.kalshi.unavailable === 'Kalshi price unavailable at model time' && !ks.content.cols.some((c) => c.win)
    && /Kalshi price unavailable at model time/.test(ks.alt), { s: r.status, k: ks.content });
  await shot(S3.page, 'phone_no_odds');
  await S3.ctx.close();

  console.log('\n== 390 px · NFL with the odds feed down: ' + NFLG.away.name + ' @ ' + NFLG.home.name);
  const N = await open({ width: 390, height: 844 }, '#game/nfl/' + NFLG.game_id);
  chk('the NFL graphic draws with no market at all', await graphicReady(N.page));
  await marketSettled(N.page);
  r = await readPage(N.page);
  chk('NFL: research available, market unavailable, decision not evaluated', /MARKET\s*unavailable/i.test(r.status) && /BETTING DECISION\s*not evaluated/i.test(r.status), r.status);
  ks = await kalshiSettled(N.page);
  chk('NFL with no Kalshi market linked: "no market", nothing drawn in its place', /KALSHI\s*no market/i.test((await readPage(N.page)).status) && ks.content === null, ks);
  chk('NFL: the overview is complete without a quote', r.overview.indexOf(fairOf(NFLG)) >= 0 && /Model moneyline/i.test(r.overview) && /Data check/i.test(r.overview), r.overview.slice(0, 300));
  await N.page.click('[data-gv-act=pmkt][data-gv-v=moneyline]');
  await N.page.selectOption('#gvPrice select[name=side]', 'away');
  await N.page.fill('#gvPrice input[name=american]', '+150');
  await N.page.click('#gvPrice button[type=submit]');
  await N.page.waitForFunction(() => /Price implies|could not/.test((document.getElementById('gvPriceOut') || {}).innerText || ''), null, { timeout: 20000 }).catch(() => {});
  po = await N.page.evaluate(() => document.getElementById('gvPriceOut').innerText);
  chk('NFL moneyline price check: the model WIN probability, labelled', /Price implies\s*40\.0%/.test(po) && /model win probability/i.test(po), po.slice(0, 300));
  chk('no page errors on the phone (NFL)', N.errors.length === 0, N.errors);
  await N.ctx.close();

  console.log('\n== 390 px · a snapshot that failed its own checks: ' + FAULT.game_key);
  const F2 = await open({ width: 390, height: 844 }, '#game/cfb/' + FAULT.game_id);
  await graphicReady(F2.page);
  r = await readPage(F2.page);
  chk('a data fault is prominent: the status chip and the box', /MODEL\s*data fault/i.test(r.status) && /Data fault\./.test(r.overview), { s: r.status, o: r.overview.slice(-300) });
  await F2.ctx.close();

  console.log('\n== 390 px · a game with no snapshot');
  const M2 = await open({ width: 390, height: 844 }, '#game/cfb/999999999');
  await M2.page.waitForTimeout(800);
  chk('a direct link to an unknown game says so plainly', /No research snapshot for this game/.test(await M2.page.evaluate(() => document.getElementById('gamePage').innerText)));
  await M2.page.evaluate(() => window.fbOpenGameFromDesk('nfl', 'NOPE_404'));
  await M2.page.waitForTimeout(1500);
  chk('a link from outside the board falls back to the football board when there is no snapshot', await M2.page.evaluate(() => document.getElementById('v-game').classList.contains('hide') && !document.getElementById('v-research').classList.contains('hide')));
  await M2.ctx.close();

  /* -------------------------------------------------------------- desktop */
  console.log('\n== 1280 px · the board card leads with the model');
  const D = await open({ width: 1280, height: 1600 }, '#research/football');
  const dpage = D.page;
  await dpage.evaluate(() => { try { window.researchGo('football'); window.fbSetSport('p4'); } catch (e) {} });
  const boardOk = await dpage.waitForFunction(() => { const b = document.getElementById('fbBody'); return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML); }, null, { timeout: 60000 }).then(() => true).catch(() => false);
  if (boardOk && sched) {
    await dpage.waitForTimeout(1500);
    const gid = await dpage.evaluate(() => { const el = document.querySelector('[id^="p4gate-"]'); return el ? el.id.replace('p4gate-', '') : null; });
    await dpage.evaluate((g) => window.fbP4Gate(g), gid);
    await dpage.waitForFunction((g) => { const h = document.getElementById('p4gate-' + g); return h && h.querySelector('.gvl') && (h.querySelector('.edd-act') || h.querySelector('.edd-mkt-only')); }, gid, { timeout: 20000 }).catch(() => {});
    const card = await dpage.evaluate((g) => { const h = document.getElementById('p4gate-' + g), l = h && h.querySelector('.gvl'), a = h && (h.querySelector('.edd-act') || h.querySelector('.edd-mkt-only'));
      return { lead: l ? l.innerText : null, before: !!(l && a && (l.compareDocumentPosition(a) & 4)), hasBtn: !!(l && l.querySelector('.gvl-btn')) }; }, gid);
    chk('an FBS card opens with EdgeDesk’s projection above the decision', card.lead && /EdgeDesk projection/i.test(card.lead) && /Fair spread/i.test(card.lead) && card.before, card);
    if (card.hasBtn) {
      /* the board repaints when late data lands; press the button the page holds right now */
      await dpage.evaluate((g) => { const b = document.querySelector('#p4gate-' + g + ' .gvl-btn'); if (b) b.click(); }, gid);
      chk('"Game research & graphic" opens that game’s research page', await graphicReady(dpage) && await dpage.evaluate((g) => location.hash === '#game/cfb/' + encodeURIComponent(g), gid));
      r = await readPage(dpage);
      chk('desktop: no horizontal scroll', r.sw <= r.vw, { sw: r.sw, vw: r.vw });
      await shot(dpage, 'desktop_page');
      await dpage.click('[data-gv-act=back]');
      await dpage.waitForTimeout(800);
      chk('Back returns to the board', await dpage.evaluate(() => !document.getElementById('v-research').classList.contains('hide')));
    }
  } else console.log('  (the FBS board did not load from the fixture here; its card is covered by tools/football/game_research.test.js)');
  chk('no page errors on desktop', D.errors.length === 0, D.errors);
  await D.ctx.close();

  await browser.close();
  srv.close();
  finish();
})().catch((e) => { console.error(e && e.stack || e); fail++; finish(1); });
