#!/usr/bin/env node
/* ===========================================================================
   QUOTE-LEVEL EV, IN A REAL BROWSER.

   The unit suite (tools/football/quote_ev.test.js) proves the arithmetic.
   This proves the RENDER: app.html in Chromium, its own loader fetching its
   own engine, the FBS board with a pricing line under every game, the EV
   sorts, and a game card whose PRICE EVALUATION prices the captured quote at
   its own odds — never the −110 reference the section used to print.

   The captured board is the REAL one the terminal build priced: each game's
   latest DraftKings two-sided quotes from football/cfb_terminal/games.json,
   replayed as the Supabase `signals` rows the page reads (best price per
   number, with its book and capture time). The alternate-spread feed is a
   TEST FIXTURE built here and labelled so (a provider-shaped response run
   through football/cfb_terminal/alternates.js): EdgeDesk has no captured
   alternates yet, and the page must still render the ladder when it does —
   a short one for the first priced game, and for the second a wide one with
   a hole in it, on which the EV-by-spread chart must lay out cleanly.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/football/quote_ev_ui.e2e.js [--shots <dir>]
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
function finish() {
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | quote EV (browser) | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

const FIXTURE = path.join(__dirname, 'fixtures', 'fbs_schedule_sample.csv');
const GAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'games.json'), 'utf8'));
const NOW = Date.now();
/* the captured quotes, as the signals rows the page reads; captured "now" so the freshness ladder reads them as current */
function signalsFor() {
  const rows = [];
  Object.keys(GAMES.games).forEach((gid) => {
    const g = GAMES.games[gid], mk = g.market || {}, quotes = (mk.quotes || []).filter((q) => q.home_line != null && q.price_home != null && q.price_away != null);
    if (!quotes.length) return;
    const ev = 'e2e_' + gid, at = new Date(NOW - 6 * 60000).toISOString(), t = g.kickoff;
    const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
    const seen = {};
    quotes.forEach((q) => {
      [['home', q.home_line, q.price_home], ['away', -q.home_line, q.price_away]].forEach(([s, pt, pr]) => {
        const sel = s === 'home' ? g.game.home : g.game.away, k = sel + '|' + pt;
        if (seen[k] && seen[k].best_dec >= dec(pr)) return;
        seen[k] = { event_id: ev, market: 'spreads', selection: sel, point: pt, best_dec: +dec(pr).toFixed(4), first_best_dec: +dec(pr).toFixed(4), first_seen_at: at,
          best_book: String(q.book || 'draftkings').replace(/^./, (c) => c.toUpperCase()), n_books: 1, home_team: g.game.home, away_team: g.game.away, commence_time: t, last_seen_at: at };
      });
    });
    Object.keys(seen).forEach((k) => rows.push(seen[k]));
  });
  return rows;
}
const SIGNALS = signalsFor();
/* TEST FIXTURE: an alternate ladder for the first priced game, every price
   derived from its real main quote, 25 cents per half point on the continuous
   price scale. It is written as the PROVIDER's own event-odds response and
   goes through the production path: alternates.js parses it and builds the
   browser feed exactly as a live capture would. */
const ALT = require(path.join(ROOT, 'football', 'cfb_terminal', 'alternates.js'));
const ALT_GAME = SIGNALS.length ? SIGNALS[0] : null;
/* TEST FIXTURE: a second game with the ladder that broke the EV-by-spread
   chart (a Northwestern-shaped one): whole points far out at four- and
   five-figure prices, a ten-point hole no book deals, then every half point
   either side of the main line. Prices follow a normal curve with a vig. */
const WIDE_GAME = ALT_GAME ? SIGNALS.find((r) => r.event_id !== ALT_GAME.event_id) || null : null;
function wideOutcomes(G, home) {
  const Phi = (z) => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z * z * z)));
  const am = (p) => { p = Math.min(0.99, Math.max(0.09, p)); let a = Math.round((p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p) / 5) * 5;
    if (Math.abs(a) < 100) a = a < 0 ? -105 : 100; return Math.max(-10000, Math.min(1000, a)); };
  const offs = [];
  for (let d = -6; d <= 13; d += 0.5) if (d) offs.push(d);
  for (let d = 23; d <= 31; d += 1) offs.push(d);
  const out = [];
  offs.forEach((d) => { const hl = home.point + d;
    out.push({ name: G.home_team, point: hl, price: am(Phi((d + 3) / 13) * 1.04 + 0.01) }, { name: G.away_team, point: -hl, price: am(1.02 - Phi((d - 1) / 13) * 0.96) }); });
  return out;
}
function altFeed() {
  if (!ALT_GAME) return ALT.buildFeed({ league: 'cfb', now: NOW, ledger: [], rebuild: true });
  const home = SIGNALS.find((r) => r.event_id === ALT_GAME.event_id && r.selection === ALT_GAME.home_team);
  if (!home) return ALT.buildFeed({ league: 'cfb', now: NOW, ledger: [], rebuild: true });
  const am = (v) => (v < 0 ? v - 100 : v + 100);          /* continuous cents -> American */
  const outcomes = [];
  for (let k = -4; k <= 4; k++) {
    if (!k) continue;
    const hl = home.point + k * 0.5;
    outcomes.push({ name: ALT_GAME.home_team, point: hl, price: am(-10 - 25 * k) }, { name: ALT_GAME.away_team, point: -hl, price: am(-10 + 25 * k) });
  }
  const provider = (G, outs) => ({ id: G.event_id, commence_time: G.commence_time, home_team: G.home_team, away_team: G.away_team,
    bookmakers: [{ key: 'fixturebook', title: 'FixtureBook (TEST FIXTURE)', markets: [{ key: 'alternate_spreads', last_update: new Date(NOW - 6 * 60000).toISOString(), outcomes: outs }] }] });
  const at = new Date(NOW - 5 * 60000).toISOString();
  const polled = [ALT_GAME.event_id];
  let quotes = ALT.parseEventOdds(provider(ALT_GAME, outcomes), null, at, { league: 'cfb' }).quotes;
  const wideHome = WIDE_GAME && SIGNALS.find((r) => r.event_id === WIDE_GAME.event_id && r.selection === WIDE_GAME.home_team);
  if (wideHome) { polled.push(WIDE_GAME.event_id); quotes = quotes.concat(ALT.parseEventOdds(provider(WIDE_GAME, wideOutcomes(WIDE_GAME, wideHome)), null, at, { league: 'cfb' }).quotes); }
  const feed = ALT.buildFeed({ league: 'cfb', now: NOW, ledger: [], run: { polled, quotes, observed_at: at } });
  feed.provider = 'TEST FIXTURE (provider-shaped, parsed by alternates.js)';
  return feed;
}
/* the EV-by-spread chart, measured as drawn: text boxes that intersect, text
   that leaves the chart, and how far its text is scaled from its CSS size */
function chartLayout(g) {
  const host = document.getElementById('p4gate-' + g);
  return Array.from(host ? host.querySelectorAll('svg.qev-chart') : []).map((svg) => {
    const sr = svg.getBoundingClientRect();
    const ts = Array.from(svg.querySelectorAll('text')).map((t) => ({ s: t.textContent, r: t.getBoundingClientRect() })).filter((t) => t.r.width > 0);
    const hit = [];
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i].r, b = ts[j].r;
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) hit.push(ts[i].s + ' × ' + ts[j].s);
    }
    return { points: svg.querySelectorAll('circle.mk').length, texts: ts.length, overlaps: hit.slice(0, 8), n_overlaps: hit.length,
      outside: ts.filter((t) => t.r.left < sr.left - 0.5 || t.r.right > sr.right + 0.5 || t.r.top < sr.top - 0.5 || t.r.bottom > sr.bottom + 0.5).map((t) => t.s),
      scale: +(sr.width / svg.viewBox.baseVal.width).toFixed(3), gap: !!svg.querySelector('path.ln.gap'), tags: Array.from(svg.querySelectorAll('text.tg')).map((t) => t.textContent),
      zero: Array.from(svg.querySelectorAll('text.yl')).map((t) => t.textContent) };
  });
}

/* THE NFL: games.csv rebuilt from the committed NFL slate (upcoming games,
   nflverse columns the loader reads) and a TEST FIXTURE price board at each
   game's reference number — the repo holds no captured NFL book prices */
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
function nflSignals() {
  const at = new Date(NOW - 4 * 60000).toISOString(), dec = (a) => +(a > 0 ? 1 + a / 100 : 1 + 100 / -a).toFixed(4), out = [];
  NFL.games.forEach((g) => { const r = g.reference_market || {}; if (r.home_line == null || Date.parse(g.kickoff) < NOW) return;
    const ev = 'e2e_nfl_' + g.game_id;
    [[g.home_team, r.home_line, -110, 'FixtureBookA'], [g.away_team, -r.home_line, -110, 'FixtureBookA'], [g.away_team, -r.home_line + 0.5, -118, 'FixtureBookB']].forEach(([sel, pt, pr, bk], i) => {
      out.push({ event_id: ev, market: 'spreads', selection: sel, point: pt, best_dec: dec(pr), first_best_dec: dec(pr), first_seen_at: at, best_book: bk, n_books: i === 2 ? 1 : 3,
        home_team: g.home_team, away_team: g.away_team, commence_time: g.kickoff, last_seen_at: at }); }); });
  return out;
}
const NFL_SIGNALS = nflSignals();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  if (p === '/football/markets/alternates_cfb.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(altFeed())); return; }
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  if (!fs.existsSync(FIXTURE)) { console.log('SKIPPED: no schedule fixture'); process.exit(0); }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) {}
    });
    const sched = fs.readFileSync(FIXTURE);
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/cfb_schedules_\d{4}\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: sched });
      if (/nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: nflGamesCsv() });
      if (/stats_team_week_(\d{4})\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'stats_team_week_2026.csv')) });
      if (/cfb_rosters_\d{4}\.csv/.test(url)) return route.fulfill({ status: 404, body: 'not published' });
      if (/open-meteo/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (/\/signals\?/.test(url) && /americanfootball_ncaaf/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SIGNALS) });
        if (/\/signals\?/.test(url) && /americanfootball_nfl/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NFL_SIGNALS) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto(`http://127.0.0.1:${port}/app.html#research/football`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.fbSetSport === 'function', null, { timeout: 30000 });
    await page.evaluate(() => { try { window.researchGo('football'); } catch (e) {} });
    await page.evaluate(() => window.fbSetSport('p4'));
    await page.waitForFunction(() => { const b = document.getElementById('fbBody'); return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML); }, null, { timeout: 60000 });
    /* the calibration, the tiers and the alternate feed arrive after the board and repaint it */
    await page.waitForFunction(() => !!(window.EDQuoteEV && window.EDEV), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    /* the one-time onboarding card is not what this suite is about */
    await page.click('text=Skip for now', { timeout: 2000 }).catch(() => {});
    return { ctx, page, errors };
  }

  console.log('\n== the FBS board at 1280px ==');
  const D = await open({ width: 1280, height: 2200 });
  const page = D.page;
  if (args.indexOf('--dbg') >= 0) { console.log(JSON.stringify(await page.evaluate(() => window.fbQevDiag()), null, 1)); process.exit(0); }
  const board = await page.evaluate(() => {
    const subs = Array.from(document.querySelectorAll('.qev-sub'));
    return { n: subs.length, rows: document.querySelectorAll('[id^="p4gate-"]').length,
      withEv: subs.filter((x) => /Best price/.test(x.textContent)).length,
      unavailable: subs.filter((x) => /EV unavailable ·/.test(x.textContent)).length,
      zeroFor: subs.filter((x) => /EV unavailable/.test(x.textContent) && /0\.0%/.test(x.textContent)).length,
      sample: subs.filter((x) => /Best price/.test(x.textContent)).slice(0, 3).map((x) => x.textContent.replace(/\s+/g, ' ')),
      naSample: subs.filter((x) => /EV unavailable/.test(x.textContent)).slice(0, 2).map((x) => x.textContent.replace(/\s+/g, ' ')),
      sorts: Array.from(document.querySelectorAll('.fbs-chip')).map((b) => b.textContent).filter((t) => /EV|Freshest/.test(t)) };
  });
  chk('every board row carries a pricing line', board.n === board.rows && board.n > 0, board);
  chk('games with a captured priced quote show the exact quote and its EV', board.withEv > 0, board.sample);
  chk('games without one say why, and never print 0.0% for it', board.unavailable >= 0 && board.zeroFor === 0, board.naSample);
  chk('a pricing line names book, cover, break-even, edge and EV', board.sample.length > 0 && board.sample.every((t) => /Best price .+ · .+ · \d+m/.test(t) && /Cover \d/.test(t) && /BE \d/.test(t) && /Edge [+−]/.test(t) && /EV [+−]\d/.test(t)), board.sample);
  chk('CFB shows the calibrated EV beside the raw EV', board.sample.length > 0 && board.sample.every((t) => /Raw EV/.test(t) && /Calibrated [+−]\d/.test(t)), board.sample);
  chk('the decision is shown apart from the EV', board.sample.every((t) => /Decision/.test(t)), board.sample);
  chk('the board offers Highest EV, Lowest EV and Freshest quote sorts', ['Highest EV', 'Lowest EV', 'Freshest quote'].every((s) => board.sorts.indexOf(s) >= 0), board.sorts);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(() => { const o = document.querySelector('[class*="onb"],[id*="onb"]'); void o; const b = document.querySelector('.qev-sub'); if (b) b.scrollIntoView(); });
    const rows = await page.$$('.rv-row, .qev-sub');
    if (rows.length > 12) { const b0 = await rows[0].boundingBox(), b1 = await rows[12].boundingBox(); if (b0 && b1) await page.screenshot({ path: path.join(SHOTS, 'board_rows.png'), clip: { x: 0, y: b0.y, width: 1280, height: Math.min(900, b1.y + b1.height - b0.y) } }); }
  }

  /* sort by EV: the first rows carry EVs in descending order, unavailable last */
  await page.evaluate(() => window.fbP4SetFilter('sort', 'ev_hi'));
  await page.waitForTimeout(400);
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('.qev-sub')).map((x) => {
    const m = x.textContent.match(/(?:Raw EV|EV)\s*([+−])(\d+\.\d)%/); return m ? (m[1] === '−' ? -1 : 1) * parseFloat(m[2]) : null; }));
  const nums = order.filter((x) => x != null);
  chk('Highest EV sorts the priced games in descending EV', nums.every((x, i) => i === 0 || x <= nums[i - 1] + 1e-9), nums.slice(0, 8));
  chk('games with no EV sort after every priced game', order.indexOf(null) < 0 || order.slice(order.indexOf(null)).every((x) => x == null), order.slice(0, 12));
  await page.evaluate(() => window.fbP4SetFilter('sort', 'kick'));

  /* open the priced game the alternate fixture covers */
  const gid = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('.qev-sub')).find((x) => /Best price/.test(x.textContent));
    const m = el ? (el.getAttribute('onclick') || '').match(/fbP4Gate\('([^']+)'\)/) : null; return m ? m[1] : null;
  });
  chk('a priced game can be opened', !!gid, gid);
  const altGid = await page.evaluate((home) => { const u = (window.FB.p4.up || []).find((x) => x.g.home_team === home); return u ? String(u.g.game_id) : null; }, ALT_GAME && ALT_GAME.home_team);
  const openGid = altGid || gid;
  await page.evaluate((g) => window.fbP4Gate(g), openGid);
  await page.waitForTimeout(800);
  const card = await page.evaluate((g) => {
    const host = document.getElementById('p4gate-' + g); const t = host ? host.textContent.replace(/\s+/g, ' ') : '';
    return { text: t, hasCard: !!(host && host.querySelector('.qev-card')), hasRef: /-110 reference|reference price/i.test(t),
      ladderRows: host ? host.querySelectorAll('#qevl-' + g.replace(/[^a-zA-Z0-9]/g, '_') + ' table.qev-t tbody tr').length : 0,
      chart: !!(host && host.querySelector('svg.qev-chart')), opts: host ? Array.from(host.querySelectorAll('.qev-opt .qev-k')).map((x) => x.textContent) : [],
      twoSided: host ? Array.from(host.querySelectorAll('.qev-t')).length : 0 };
  }, openGid);
  chk('the game card carries the PRICE EVALUATION card', card.hasCard, card.text.slice(0, 300));
  chk('no −110 reference price anywhere on the card', !card.hasRef);
  chk('the card states cover, push, loss, break-even, probability edge and EV', ['EdgeDesk cover probability', 'Push probability', 'Loss probability', 'Break-even probability', 'Probability edge'].every((s) => card.text.indexOf(s) >= 0) && /Expected value/i.test(card.text), card.text.slice(0, 600));
  chk('fair price, market price and price advantage', /EdgeDesk fair price [+−-]\d+/.test(card.text) && /Market price/.test(card.text) && /Price advantage/.test(card.text), card.text.match(/EdgeDesk fair price.{0,120}/));
  chk('the plain-language explanation', /At this exact .+ quote, EdgeDesk estimates a \d+\.\d% probability of covering\. A .+ wager needs approximately \d+\.\d% to break even\./.test(card.text), card.text.match(/At this exact.{0,300}/));
  chk('RAW EV, uncertainty-adjusted EV and DECISION are three separate answers', /Raw EV/.test(card.text) && /Uncertainty-adjusted EV/.test(card.text) && /Decision/.test(card.text));
  chk('the two-sided table lists both teams', card.twoSided >= 2 && /Both sides/.test(card.text));
  chk('totals and moneylines stay unavailable until validated', /TOTAL EV UNAVAILABLE/.test(card.text) && /MONEYLINE EV UNAVAILABLE/.test(card.text), card.text.match(/TOTAL EV.{0,200}/));
  chk('hypothetical rows are labelled and kept apart', /Hypothetical · not offered by any book/.test(card.text));
  chk('the alternate ladder renders with SAFER / MAIN / MAX EV', card.ladderRows > 0 && ['Safer +EV', 'Main line', 'Max EV'].every((s) => card.opts.some((o) => o.indexOf(s) === 0)), card);
  chk('the EV-by-spread chart renders', card.chart);
  chk('buying points is priced step by step', /Buying points/.test(card.text) && /\+Cover/.test(card.text));
  /* the toggles drive the ladder in place */
  const modes = await page.evaluate((g) => {
    const id = 'qevl-' + g.replace(/[^a-zA-Z0-9]/g, '_'), n = () => document.querySelectorAll('#' + id + ' table.qev-t tbody tr').length;
    const out = { best: n() };
    window.fbQevSet(g, 'mode', 'all'); out.all = n();
    window.fbQevSet(g, 'mode', 'frontier'); out.frontier = n();
    window.fbQevSet(g, 'mode', 'best'); window.fbQevSet(g, 'side', 'home'); out.home = n(); window.fbQevSet(g, 'side', 'away'); out.away = n();
    return out;
  }, openGid);
  chk('ALL QUOTES ≥ best-per-spread ≥ VALUE FRONTIER', modes.all >= modes.best && modes.best >= modes.frontier && modes.frontier > 0, modes);
  const altRows = await page.evaluate((g) => {
    window.fbQevSet(g, 'mode', 'all'); window.fbQevSet(g, 'side', 'home');
    const id = 'qevl-' + g.replace(/[^a-zA-Z0-9]/g, '_');
    const rows = Array.from(document.querySelectorAll('#' + id + ' table.qev-t tbody tr')).map((r) => r.textContent.replace(/\s+/g, ' '));
    window.fbQevSet(g, 'mode', 'best');
    const v = window.fbQevFor(g), H = v && v.g && v.g.sides ? v.g.sides.home : null;
    const alts = H ? H.quotes.filter((q) => q.market_type === 'alternate_spread') : [];
    return { rows: rows.filter((t) => /fixturebook/i.test(t)).length, alts: alts.length, fresh: alts.filter((q) => q.ev_available && !/STALE|UNKNOWN/.test(q.quote_status)).length,
      states: alts.map((q) => q.quote_status + ':' + (q.ev_unavailable_code || 'ok')) };
  }, openGid);
  chk('the captured alternates (parsed by alternates.js) reach the ladder, fresh at their poll time, each priced at its own odds',
    altRows.alts === 8 && altRows.rows === 8 && altRows.fresh === 8, altRows);
  chk('both teams have a ladder tab', modes.home > 0 && modes.away > 0, modes);
  if (SHOTS) {
    for (const sec of ['price', 'alts']) {
      const el = await page.$('#gxs-' + String(openGid + '_' + sec).replace(/[^a-zA-Z0-9]/g, '_'));
      if (el) await el.screenshot({ path: path.join(SHOTS, 'card_' + sec + '.png') });
    }
    const sum = await page.$('#p4gate-' + openGid + ' .gx-grid');
    if (sum) await sum.screenshot({ path: path.join(SHOTS, 'card_summary.png') });
  }
  /* the wide ladder: every number drawn, no label on another, text at its own size */
  async function wideChart(pg, label) {
    const wg = await pg.evaluate((home) => { const u = (window.FB.p4.up || []).find((x) => x.g.home_team === home); return u ? String(u.g.game_id) : null; }, WIDE_GAME && WIDE_GAME.home_team);
    if (!wg) { chk(label + ': the wide-ladder fixture game is on the board', false, WIDE_GAME && WIDE_GAME.home_team); return null; }
    await pg.evaluate((g) => window.fbP4Gate(g), wg);
    await pg.waitForTimeout(800);
    const out = {};
    for (const side of ['home', 'away']) {
      await pg.evaluate(([g, sd]) => window.fbQevSet(g, 'side', sd), [wg, side]);
      await pg.waitForTimeout(250);
      out[side] = (await pg.evaluate(chartLayout, wg))[0] || null;
    }
    const all = [out.home, out.away];
    chk(label + ': the wide ladder draws every number on both sides', all.every((c) => c && c.points >= 40), all.map((c) => c && c.points));
    chk(label + ': no chart label overprints another', all.every((c) => c && c.n_overlaps === 0), all.map((c) => c && c.overlaps));
    chk(label + ': no chart label leaves the chart', all.every((c) => c && c.outside.length === 0), all.map((c) => c && c.outside));
    chk(label + ': chart text is drawn at its own size (laid out at the measured width, not scaled)', all.every((c) => c && Math.abs(c.scale - 1) < 0.01), all.map((c) => c && c.scale));
    chk(label + ': the hole no book deals is drawn dashed, never as a known stretch of curve', all.every((c) => c && c.gap), all.map((c) => c && c.gap));
    chk(label + ': zero is "0%", never "+0%"', all.every((c) => c && c.zero.indexOf('0%') >= 0 && c.zero.indexOf('+0%') < 0), all.map((c) => c && c.zero));
    chk(label + ': MAX EV is tagged on the chart', all.every((c) => c && c.tags.some((t) => /MAX EV/.test(t))), all.map((c) => c && c.tags));
    return wg;
  }
  const wideGid = await wideChart(page, '1280px');
  if (wideGid) {
    const bp = await page.evaluate((g) => {
      window.fbQevSet(g, 'side', 'home');                     /* the side whose far numbers are priced past −1000 */
      const host = document.getElementById('p4gate-' + g), sec = host ? Array.from(host.querySelectorAll('.gd-sec')).find((x) => /^Buying points/.test(x.textContent)) : null;
      const wrap = sec ? sec.nextElementSibling : null;
      return wrap ? { rows: Array.from(wrap.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.cells).map((t) => t.textContent)), fits: wrap.scrollWidth <= wrap.clientWidth + 1, sw: wrap.scrollWidth, cw: wrap.clientWidth } : null;
    }, wideGid);
    const far = bp ? bp.rows.filter((r) => { const m = /^\S+ (\S+) → \S+ (\S+)$/.exec(r[0]); return m && (Math.abs(+m[1]) > 1000 || Math.abs(+m[2]) > 1000); }) : [];
    chk('buying points: no juice quoted in cents past ±1000 (−5000 → −10000 is never "5000¢")', far.length > 0 && far.every((r) => r[3] === '—'), far.slice(0, 6).map((r) => r[0] + ' | ' + r[3]));
    chk('buying points: the table fits the card, its Read column on screen', bp && bp.fits, bp && { sw: bp.sw, cw: bp.cw });
    chk('buying points: a signed number never reads "+-"', bp && !bp.rows.some((r) => r.some((t) => /\+-|\+−/.test(t))), bp && bp.rows.filter((r) => r.some((t) => /\+-|\+−/.test(t))).slice(0, 3));
    if (SHOTS) { const el = await page.$('#gxs-' + String(wideGid + '_alts').replace(/[^a-zA-Z0-9]/g, '_')); if (el) await el.screenshot({ path: path.join(SHOTS, 'card_alts_wide.png') }); }
  }
  chk('no page errors on the board or the card', D.errors.length === 0, D.errors);

  if (args.indexOf('--dbgcfb') >= 0) console.log(JSON.stringify(await page.evaluate(() => (window.fbDecisionsLive ? window.fbDecisionsLive() : []).filter((d) => d.sport === 'CFB' && d.decision !== 'PASS' && d.decision !== 'NO_DECISION').map((d) => ({ g: d.away + ' @ ' + d.home, disp: d.decision_display, sel: d.action && d.action.selection, alt: d.selected_is_alternate,
    edge: d.edge_pp, ev: d.decision_ev_pct, raw: d.raw_ev_pct, cls: (d.candidates || []).slice(0, 4).map((c) => c.label + ' ' + c.classification + ' ' + c.decision_ev), fails: d.anomaly && d.anomaly.checks ? d.anomaly.checks.filter((c) => c.status !== 'PASS').map((c) => c.code + ':' + c.status + ' ' + c.text) : null }))), null, 1));
  console.log('\n== the NFL cards ==');
  await page.evaluate(() => window.fbSetSport('nfl'));
  await page.waitForFunction(() => document.querySelectorAll('[id^="fbg-nfl-"]').length > 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(800);
  const nfl = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[id^="fbg-nfl-"]'));
    const priced = cards.filter((c) => c.querySelector('.qev-row') && /Best price/.test(c.querySelector('.qev-row').textContent));
    const c0 = priced[0];
    return { cards: cards.length, priced: priced.length, row: c0 ? c0.querySelector('.qev-row').textContent.replace(/\s+/g, ' ') : null,
      card: c0 && c0.querySelector('.qev-card') ? c0.querySelector('.qev-card').textContent.replace(/\s+/g, ' ') : null,
      ladder: c0 ? c0.querySelectorAll('[id^="qevl-"] table.qev-t tbody tr').length : 0 };
  });
  chk('NFL cards carry the pricing line', nfl.cards > 0 && nfl.priced > 0, nfl);
  /* the NFL's partially calibrated source is the held-out-validated pricing
     blend (football/validation/pricing_nfl.json); raw EV stays beside it */
  chk('NFL shows the raw EV and the BLENDED (partially calibrated) EV apart', nfl.row && /Raw EV/.test(nfl.row) && /Blended [+−]/.test(nfl.row), nfl.row);
  chk('the NFL price evaluation names the pricing blend', nfl.card && /Blended EV \(NFL pricing blend\)/.test(nfl.card), nfl.card && nfl.card.slice(0, 400));
  chk('the NFL decision comes from the unified engine (never "no NFL decision engine")', nfl.row && /Decision (BET|LEAN|WATCH|PASS|NO DECISION)/.test(nfl.row) && !/no (NFL )?decision engine/i.test(nfl.row), nfl.row);
  const nflDec = await page.evaluate(() => {
    const all = (window.fbDecisionsLive ? window.fbDecisionsLive() : []).filter((d) => d.sport === 'NFL');
    const txt = document.body.innerText;
    const sel = Array.from(document.querySelectorAll('select')).filter((x) => Array.from(x.options).some((o) => /^Week \d+/.test(o.textContent)))[0];
    const opt = sel ? getComputedStyle(sel.options[1] || sel.options[0]) : null;
    return { n: all.length, by: all.reduce((o, d) => { o[d.decision] = (o[d.decision] || 0) + 1; return o; }, {}),
      rows: all.map((d) => [d.away + ' @ ' + d.home, d.decision_display, d.action_reason_code, d.action && d.action.selection, d.edge_pp, d.decision_ev_pct, d.raw_ev_pct, d.probability_source, d.decision_confidence, (d.blocker_codes || []).join(','),
        d.anomaly && d.anomaly.triggered ? d.anomaly.checks.filter((c) => c.status !== 'PASS').map((c) => c.code + ':' + c.status).join(' ') : '']),
      stub: /no NFL decision engine/.test(txt), cards: document.querySelectorAll('.edd-act').length,
      option: opt ? { bg: opt.backgroundColor, fg: opt.color } : null };
  });
  console.log('     NFL decisions: ' + JSON.stringify(nflDec.by));
  nflDec.rows.forEach((r) => console.log('       ' + r.join(' | ')));
  chk('every NFL game with a fresh quote reaches BET / LEAN / WATCH / PASS', nflDec.n > 0 && nflDec.rows.every((r) => !/^NO DECISION/.test(r[1]) || r[9]), nflDec.by);
  chk('no NFL page text says "no NFL decision engine"', !nflDec.stub);
  const lum = (c) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || ''); if (!m) return null; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]); };
  const L1 = nflDec.option ? lum(nflDec.option.bg) : null, L2 = nflDec.option ? lum(nflDec.option.fg) : null;
  const contrast = L1 != null && L2 != null ? (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) : null;
  chk('the week dropdown options are readable (contrast ≥ 7:1)', contrast != null && contrast >= 7, { option: nflDec.option, contrast });
  chk('the NFL alternate ladder renders both books', nfl.ladder >= 1, nfl);
  if (SHOTS) {
    /* the EDGEDESK ACTION card of the first two decided NFL games, for a human look */
    const acts = await page.$$('[id^="fbg-nfl-"] .edd-act');
    for (let i = 0; i < Math.min(2, acts.length); i++) await acts[i].screenshot({ path: path.join(SHOTS, 'nfl_action_' + i + '.png') });
  }
  if (SHOTS) { const el = await page.$('[id^="fbg-nfl-"]'); if (el) await el.screenshot({ path: path.join(SHOTS, 'nfl_card.png') }); }
  chk('no page errors on the NFL board', D.errors.length === 0, D.errors);

  console.log('\n== the board at 390px ==');
  const M = await open({ width: 390, height: 1600 });
  const mob = await M.page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth,
    subs: document.querySelectorAll('.qev-sub').length }));
  chk('pricing lines render on a phone', mob.subs > 0, mob);
  await wideChart(M.page, '390px');
  chk('no page errors on a phone', M.errors.length === 0, M.errors);
  if (SHOTS) await M.page.screenshot({ path: path.join(SHOTS, 'board_390.png'), fullPage: false });

  await browser.close(); srv.close();
  finish();
})().catch((e) => { console.log('FAIL (crash) ' + (e && e.stack || e)); process.exit(1); });
