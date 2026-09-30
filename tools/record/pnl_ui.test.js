#!/usr/bin/env node
/* ===========================================================================
   THE RECORD'S PROFIT & LOSS SECTION, IN A REAL BROWSER.

   record.html (public) and app.html (Records → Profit & Loss) in Chromium,
   served from the repo, at 375, 390, 430, 768 and 1440 px. Two data sets:

     FIXTURE  a season of TEST data (never published, never committed) written
              as the real source ledgers — props, NFL and CFB game decisions,
              the model record — and run through tools/record/pnl_ledger.js,
              so the page is fed exactly what the scheduled job writes;
     REAL     the committed record/pnl/ as it stands, whose honest state today
              is "no settled bet with a captured price yet".

   It proves: the numbers on the page are the kernel's; flat and staked are
   different numbers; the scopes filter; the chart draws, and its hover and
   keyboard readout name the bet; drawdown, breakdowns, calibration, CLV,
   players (search, drill-down) and the ledger (search, filters, sort, audit
   row, "entry price not captured", a corrected row) work; the help popover
   explains P&L; dollars appear in the app only when the reader has a unit,
   and never on the public page; no horizontal page scroll at any width, no
   card wider than the screen, no page error.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/record/pnl_ui.test.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const L = require('./pnl_ledger.js');
const FR = require('./football_record_core.js');
const PNL = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}

/* ------------------------------------------------------------ the fixture
   TEST DATA: a deterministic, invented season. Players, prices and results
   are generated; nothing here is a real recommendation. */
function fixture() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-ui-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(TMP, rel)), { recursive: true }); fs.writeFileSync(path.join(TMP, rel), text); };
  const jsonl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const PLAYERS = [['00-0033873', 'Test Quarterback One', 'KC', 'DEN', 'QB', 'pass_yds', 262.5], ['00-0039000', 'Test Receiver Two', 'KC', 'DEN', 'WR', 'receptions', 5.5],
    ['00-0039001', 'Test Runner Three', 'PHI', 'DAL', 'RB', 'rush_yds', 71.5], ['00-0039002', 'Test Receiver Four', 'PHI', 'DAL', 'WR', 'rec_yds', 58.5],
    ['00-0039003', 'Test Tight End Five', 'BUF', 'MIA', 'TE', 'rec_yds', 41.5], ['00-0039004', 'Test Quarterback Six', 'BUF', 'MIA', 'QB', 'pass_tds', 1.5]];
  const BOOKS = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'betonlineag', 'pinnacle'];
  const evals = [], results = [];
  for (let w = 2; w <= 7; w++) {
    PLAYERS.forEach((p, i) => {
      const id = 'ppe_w' + w + '_' + i, kick = new Date(Date.UTC(2026, 8, 6 + 7 * (w - 2), 17 + (i % 3))).toISOString();
      const side = rnd() < 0.55 ? 'under' : 'over', odds = [-125, -118, -115, -110, -105, 100, 110, 125][Math.floor(rnd() * 8)];
      const bet = rnd() < 0.6, units = bet ? [0.25, 0.5, 0.75, 1][Math.floor(rnd() * 4)] : 0, edge = Math.round((1 + rnd() * 9) * 10) / 10;
      evals.push({ kind: 'qualified', evaluation_id: id, selection_key: id, prop_id: 'nfl|g|' + p[0] + '|' + p[5], league: 'nfl', season: 2026, week: w,
        game_id: '2026_' + String(w).padStart(2, '0') + '_' + p[2] + '_' + p[3], kickoff: kick, player_id: p[0], player_name: p[1], team: p[2], opp: p[3], position: p[4], market: p[5],
        evaluated_at: new Date(Date.parse(kick) - 86400000).toISOString(), decision: bet ? 'BET' : 'LEAN', units, confidence: 70, probability_source: 'model_estimated', stage: 'TRACKING',
        side, line: p[6], american: odds, book: BOOKS[(w + i) % BOOKS.length], p_side: Math.round((0.5 + edge / 100) * 1000) / 1000, ev: edge / 100, edge_pp: edge, model_mean: p[6] + (side === 'over' ? 6 : -6), model_version: w < 5 ? 'edgedesk_props_model_v1' : 'edgedesk_props_model_v1.1' });
      if (w < 7) {
        const r = rnd(), res = r < 0.52 ? 'WIN' : r < 0.97 ? 'LOSS' : 'PUSH', cl = Math.round((rnd() * 4 - 1.5) * 2) / 2;
        results.push({ evaluation_id: id, kind: 'qualified', result: res, value: p[6] + (res === 'WIN' ? (side === 'over' ? 9 : -9) : res === 'LOSS' ? (side === 'over' ? -9 : 9) : 0), graded_at: new Date(Date.parse(kick) + 86400000).toISOString(),
          clv: { available: true, close_line: side === 'over' ? p[6] + cl : p[6] - cl, line_clv: cl, beat_close: cl > 0 ? true : cl < 0 ? false : null } });
      }
    });
  }
  /* one corrected stat, and one row whose price was never captured */
  const c0 = results[0];
  results.push(Object.assign({}, c0, { result: c0.result === 'WIN' ? 'LOSS' : 'WIN', graded_at: '2026-09-12T12:00:00.000Z', correction: true, corrects: c0.graded_at, correction_reason: 'official statistic changed (TEST)' }));
  evals.push(Object.assign({}, evals[1], { evaluation_id: 'ppe_noprice', selection_key: 'np', american: null, decision: 'BET', units: 0.5 }));
  results.push({ evaluation_id: 'ppe_noprice', kind: 'qualified', result: 'WIN', value: 9, graded_at: '2026-09-08T12:00:00.000Z' });
  put('football/props/nfl/2026/evaluations.jsonl', jsonl(evals));
  put('football/props/nfl/2026/results.jsonl', jsonl(results));
  /* CFB and NFL game decisions */
  const snaps = [], dev = [];
  for (let k = 0; k < 14; k++) {
    const nfl = k % 3 === 0, mt = ['spread', 'total', 'moneyline'][k % 3], w = 2 + (k % 6);
    const kick = new Date(Date.UTC(2026, 8, 5 + 7 * (w - 2), 20)).toISOString(), odds = mt === 'moneyline' ? [135, -140, 115][k % 3] : [-110, -108, -112][k % 3];
    const side = mt === 'total' ? (k % 2 ? 'over' : 'under') : (k % 2 ? 'home' : 'away');
    const id = 'bds_' + k, cls = k % 4 === 3 ? 'PASS' : 'BET';
    snaps.push({ snapshot_id: id, game_id: (nfl ? '2026_0' + w + '_TST_TSU' : '40199' + k), sport: nfl ? 'NFL' : 'CFB', market_key: 'x:' + mt, market_type: mt, home: 'Home Test ' + k, away: 'Away Test ' + k,
      kickoff: kick, decision: cls, recommended_units: cls === 'BET' ? [0.5, 1, 0.75][k % 3] : 0, evaluated_at: new Date(Date.parse(kick) - 2 * 86400000).toISOString(), evaluation_mode: 'LIVE',
      model_version: nfl ? 'edgedesk_football_v1.0.0' : 'edgedesk_cfb_p4_v1.0.0', decision_engine_version: 'edgedesk_football_decision_v2', model_fair_line: -7, probability: 0.55, edge_pp: 2 + (k % 5), decision_ev_pct: 4,
      bet_price: cls === 'BET' ? { side, team: side === 'home' ? 'Home Test ' + k : side === 'away' ? 'Away Test ' + k : null, line: mt === 'moneyline' ? null : (mt === 'total' ? 47.5 : -3.5), odds, book: BOOKS[k % BOOKS.length], captured_at: new Date(Date.parse(kick) - 2 * 86400000 - 60000).toISOString() } : null,
      reference_quote: cls === 'PASS' ? { side, line: mt === 'total' ? 44.5 : 2.5, odds: -110, book: 'fanduel' } : null });
    if (w < 7) dev.push({ snapshot_id: id, result: k % 5 === 1 ? 'loss' : k % 7 === 2 ? 'push' : 'win', close_line: mt === 'moneyline' ? null : -4, clv_points: mt === 'moneyline' ? null : (k % 2 ? 0.5 : -0.5), graded_at: new Date(Date.parse(kick) + 86400000).toISOString() });
  }
  put('football/cfb_terminal/decisions/2026/snapshots.jsonl', jsonl(snaps));
  put('football/cfb_terminal/decisions/2026/evaluations.jsonl', jsonl(dev));
  /* a model-record game: a result, never a price */
  const Lg = FR.emptyLedger('nfl', 2026);
  FR.recordProjection(Lg, FR.projectionFromSlate('nfl', { model_status: 'PREDICTED', game_id: '2026_03_TST_TSU', season: 2026, week: 3, kickoff: '2026-09-20T17:00:00.000Z', home_team: 'Test Home', away_team: 'Test Away', home_code: 'TSU', away_code: 'TST', model_home_line: -2.5, model_fair_total: 44, model_home_win_prob: 0.58, model_version: 'edgedesk_football_v1.0.0' }, { season: 2026 }), { published_at: '2026-09-18T00:00:00Z' });
  FR.setClose(Lg.games['2026_03_TST_TSU'], { home_line: -3.5, total: 45.5, source: 'nflverse', book: 'consensus' }, '2026-09-20T18:00:00Z');
  Lg.games['2026_03_TST_TSU'].final = { home_score: 24, away_score: 17, source: 'nflverse', at: '2026-09-21T00:00:00Z' };
  FR.gradeLedger(Lg, '2026-09-22T00:00:00Z');
  put('record/football/nfl_2026.json', JSON.stringify(Lg));
  const B = L.build({ root: TMP, out: 'record/pnl', season: 2026, now: '2026-10-20T00:00:00.000Z' });
  fs.rmSync(TMP, { recursive: true, force: true });
  return B;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const FX = fixture();
  const fxSum = FX.summary.views.all;
  chk('the fixture has a season to draw (test data)', fxSum.flat.summary.n >= 20 && fxSum.staked.summary.n >= 20, fxSum.flat.summary.n);
  let feed = 'fixture';
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/record.html';
    if (feed === 'fixture' && p === '/record/pnl/summary.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FX.summary)); return; }
    if (feed === 'fixture' && p === '/record/pnl/rows_2026.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FX.page)); return; }
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
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, file, opt) {
    opt = opt || {};
    const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 700, isMobile: false });
    await ctx.addInitScript((o) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        if (o.session) localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        if (o.unit) localStorage.setItem('edgedesk_bankroll_v1', JSON.stringify({ unit_mode: 'fixed', base_unit_amount: o.unit }));
      } catch (e) { /* storage */ }
    }, opt);
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date('2026-10-20T12:00:00Z'));
    await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const shot = async (page, name, sel) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    if (sel) await page.locator(sel).first().screenshot({ path: path.join(SHOTS, name + '.png') });
    else await page.screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  /* nothing wider than the screen: the page, every card, every table cell's own box */
  /* the section's own overflow: anything inside it that reaches past the
     screen without a scrolling container of its own between it and the page
     (another section's layout is that section's business) */
  const layout = (page, sel) => page.evaluate((s) => {
    const de = document.documentElement, vw = de.clientWidth, root = document.querySelector(s);
    const wide = [];
    let hscroll = false;
    root.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect(); if (!(r.width > 0) || r.right <= vw + 1) return;
      let p = el.parentElement, contained = false;
      while (p && p !== root.parentElement) { if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= vw + 1) { contained = true; break; } p = p.parentElement; }
      if (!contained) { hscroll = true; if (wide.length < 5) wide.push(el.tagName + '.' + el.className + ' ' + Math.round(r.right)); }
    });
    root.querySelectorAll('.pnl-tw').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > vw + 1) wide.push('table wrapper ' + Math.round(r.right)); });
    const clipped = [];
    root.querySelectorAll('.pnl-v, .pnl-cl, .pnl-cs, .pnl-t td').forEach((el) => { if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === 'visible' && el.getBoundingClientRect().right > vw + 1) clipped.push(el.textContent.slice(0, 40)); });
    const small = [];
    root.querySelectorAll('.pnl-seg button, .pnl-btn, .pnl-in').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.height < 36) small.push(el.textContent.slice(0, 20) + ' ' + Math.round(r.height)); });
    return { hscroll, wide: wide.slice(0, 5), clipped: clipped.slice(0, 5), small: small.slice(0, 5) };
  }, sel);
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());

  try {
    /* ============================================ record.html, every width */
    for (const W of [375, 390, 430, 768, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'record.html');
      await page.waitForSelector('#pnlPub .pnl-cards', { timeout: 15000 });
      await page.waitForSelector('#pnlPub .pnl-lt', { timeout: 15000 });
      const hero = await text(page, '#pnlPub .pnl-card.hero .pnl-v');
      chk(W + 'px public: the hero is the kernel\'s net units', hero === PNL.fmtUnits(fxSum.flat.summary.net_units), [hero, fxSum.flat.summary.net_units]);
      const lay = await layout(page, '#pnlPub');
      chk(W + 'px public: the section causes no horizontal page scroll', !lay.hscroll, lay);
      chk(W + 'px public: no card, table row or control wider than the screen', !lay.wide.length, lay.wide);
      chk(W + 'px public: no clipped figure', !lay.clipped.length, lay.clipped);
      chk(W + 'px public: touch targets are at least 36px tall', !lay.small.length, lay.small);
      chk(W + 'px public: no dollar toggle without a reader\'s unit', !(await page.$('#pnlPub [data-money]')));
      chk(W + 'px public: the chart draws the path', !!(await page.$('#pnlPub .pnl-svg .pnl-line')));
      chk(W + 'px public: no page error', !errors.length, errors);
      if (W === 390) {
        await page.$eval('#pnl', (el) => el.scrollIntoView());
        await shot(page, 'record_390_section', '#pnlPub');
        const chartBox = await page.$('#pnlPub .pnl-svg');
        await chartBox.scrollIntoViewIfNeeded();
        const bb = await chartBox.boundingBox();
        await page.touchscreen.tap(bb.x + bb.width * 0.7, bb.y + bb.height / 2);
        const tip = await text(page, '#pnlPub .pnl-tip');
        chk('390px: tapping the chart names the bet and the running P&L', /Running P&L/.test(tip) && /Odds:/.test(tip) && /Stake:/.test(tip), tip);
        await shot(page, 'record_390_chart_tip', '#pnlPub .pnl-chart');
        await page.click('#pnlPub [data-fopen]');
        chk('390px: the ledger filters open as a sheet', await page.$eval('#pnlPub [data-filters]', (el) => getComputedStyle(el).position === 'fixed' && el.classList.contains('open')));
        await shot(page, 'record_390_filters');
        await page.selectOption('#pnlPub [data-f="market"]', 'player_prop');
        await page.click('#pnlPub .pnl-filters [data-fclose]');
        chk('390px: the drawer closes on "Show results"', !(await page.$eval('#pnlPub [data-filters]', (el) => el.classList.contains('open'))));
        chk('390px: the filter count shows on the button', /\(1\)/.test(await text(page, '#pnlPub [data-fopen]')));
        const cells = await page.$$eval('#pnlPub .pnl-lt tbody tr.pnl-lr td[data-l="Market"]', (els) => els.map((e) => e.textContent));
        chk('390px: filtered to player props only', cells.length > 0 && cells.every((c) => !/Spread|Total|Moneyline/.test(c)), cells.slice(0, 5));
        chk('390px: ledger rows render as cards (grid)', await page.$eval('#pnlPub .pnl-lt tbody tr.pnl-lr', (el) => getComputedStyle(el).display === 'grid'));
        await shot(page, 'record_390_ledger', '#pnlPub [data-r="ledger"]');
      }
      if (W === 1440) {
        await page.$eval('#pnl', (el) => el.scrollIntoView());
        await shot(page, 'record_1440_section', '#pnlPub');
        /* strategies never mixed */
        await page.click('#pnlPub [data-mode="staked"]');
        const staked = await text(page, '#pnlPub .pnl-card.hero .pnl-v');
        chk('staking: the hero becomes the recommended-stake net', staked === PNL.fmtUnits(fxSum.staked.summary.net_units) && staked !== hero, [staked, hero]);
        await page.click('#pnlPub [data-mode="flat"]');
        /* scopes */
        await page.click('#pnlPub [data-scope="props"]');
        const props = await text(page, '#pnlPub .pnl-card.hero .pnl-cs');
        chk('scope: player props only', props.indexOf(FX.summary.views.props.flat.summary.record) === 0, [props, FX.summary.views.props.flat.summary.record]);
        await page.click('#pnlPub [data-scope="nfl"]');
        const nfl = await text(page, '#pnlPub .pnl-card.hero .pnl-v');
        chk('scope: NFL, computed on the page, equals the build', nfl === PNL.fmtUnits(FX.summary.views.nfl.flat.summary.net_units), [nfl, FX.summary.views.nfl.flat.summary.net_units]);
        await page.click('#pnlPub [data-scope="all"]');
        /* chart: keyboard readout */
        await page.focus('#pnlPub .pnl-svg');
        await page.keyboard.press('End');
        const tipEnd = await text(page, '#pnlPub .pnl-tip');
        chk('chart: End reads the last bet, and its running total is the net', tipEnd.indexOf('Running P&L: ' + PNL.fmtUnits(fxSum.flat.summary.net_units)) >= 0, tipEnd);
        await page.keyboard.press('ArrowLeft');
        chk('chart: arrow keys step through the bets', (await text(page, '#pnlPub .pnl-tip')) !== tipEnd);
        await shot(page, 'record_1440_chart', '#pnlPub .pnl-chart');
        /* help */
        await page.click('#pnlPub .pnl-ey [data-help="pnl"]');
        const pop = await text(page, '#pnlPub .pnl-pop');
        chk('help: P&L is explained in plain English', /Unlike win percentage, P&L reflects the actual price paid for each wager/.test(pop), pop);
        await page.mouse.click(5, 5);
        chk('help: a click elsewhere closes it', await page.$eval('#pnlPub .pnl-pop', (el) => el.hidden));
        /* breakdowns, calibration, CLV */
        const bdNames = await page.$$eval('#pnlPub .pnl-det > summary', (els) => els.map((e) => e.textContent));
        ['By league', 'By market', 'By player prop type', 'By side', 'By book', 'By model edge', 'By recommendation grade', 'By unit size', 'By week', 'Model version performance'].forEach((n) => chk('breakdown present: ' + n, bdNames.some((x) => x.indexOf(n) === 0), bdNames));
        const books = await page.$$eval('#pnlPub details', (ds) => { const d = ds.find((x) => x.querySelector('summary').textContent.indexOf('By book') === 0); return d ? Array.from(d.querySelectorAll('tbody td:first-child b')).map((b) => b.textContent) : []; });
        chk('by book: only books with a captured price', books.length > 0 && books.indexOf('consensus') < 0, books);
        chk('calibration: eight buckets with a reading', (await page.$$('#pnlPub section:has(h4:text("Edge calibration")) tbody tr')).length === 8);
        chk('small samples are flagged', (await page.$$('#pnlPub .pnl-sample.warn')).length > 0);
        /* players */
        await page.fill('#pnlPub [data-pq]', 'Receiver Two');
        await page.waitForTimeout(250);
        const prow = await page.$$('#pnlPub .pnl-pt tbody tr.pnl-click');
        chk('players: search finds one player', prow.length === 1);
        await prow[0].click();
        const drill = await text(page, '#pnlPub .pnl-drill');
        chk('players: the drill-down shows prop type, over/under and every recommendation', /By prop type/.test(drill) && /Game log/.test(drill), drill.slice(0, 200));
        await shot(page, 'record_1440_player', '#pnlPub [data-r="players"]');
        /* ledger */
        await page.fill('#pnlPub [data-f="q"]', 'ppe_noprice');
        await page.waitForTimeout(250);
        const np = await text(page, '#pnlPub [data-r="lrows"]');
        chk('ledger: a row with no captured price says so and shows no profit', /not captured/.test(np) && /No price/.test(np), np.slice(0, 300));
        await page.click('#pnlPub [data-r="lrows"] tr.pnl-lr');
        const audit = await text(page, '#pnlPub [data-r="lrows"] .pnl-audit');
        chk('ledger: the audit row says P&L unavailable — entry price not captured', /P&L unavailable — entry price not captured/.test(audit), audit.slice(0, 300));
        await page.fill('#pnlPub [data-f="q"]', '');
        await page.selectOption('#pnlPub [data-sort]', 'pnl');
        await page.waitForTimeout(100);
        const firstPnl = await text(page, '#pnlPub [data-r="lrows"] tr.pnl-lr td[data-l="P&L"]');
        chk('ledger: sorted by P&L, the biggest winner leads', /^\+/.test(firstPnl), firstPnl);
        await page.fill('#pnlPub [data-f="q"]', 'official statistic');
        await page.fill('#pnlPub [data-f="q"]', FX.ledger.rows.find((x) => x.corrected).recommendation_id);
        await page.waitForTimeout(250);
        chk('ledger: a corrected row is marked, and its audit lists the correction', /corrected/.test(await text(page, '#pnlPub [data-r="lrows"]')));
        await page.click('#pnlPub [data-r="lrows"] tr.pnl-lr');
        chk('ledger: the correction names what changed and why', /Corrections/.test(await text(page, '#pnlPub [data-r="lrows"] .pnl-audit')) && /official statistic changed \(TEST\)/.test(await text(page, '#pnlPub [data-r="lrows"] .pnl-audit')));
        await shot(page, 'record_1440_ledger', '#pnlPub [data-r="ledger"]');
      }
      await ctx.close();
    }

    /* ============================================ app.html, Records → P&L */
    for (const W of [390, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'app.html', { session: true, unit: 25 });
      await page.waitForFunction(() => typeof window.recBook === 'function' && typeof window.show === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); recBook('pnl'); });
      await page.waitForSelector('#recPnlWrap .pnl-cards', { timeout: 15000 });
      await page.waitForSelector('#recPnlWrap .pnl-lt', { timeout: 15000 });
      chk(W + 'px app: the Profit & Loss book is a third tab', /Profit & Loss/.test(await text(page, '#recBook')) && await page.$eval('#recPnlWrap', (el) => !el.classList.contains('hide')));
      chk(W + 'px app: the other books are hidden, not removed', await page.$eval('#recEdgesWrap', (el) => el.classList.contains('hide')) && !!(await page.$('#recFbWrap')));
      chk(W + 'px app: a reader with a unit gets the dollars toggle', !!(await page.$('#recPnlWrap [data-money="$"]')));
      await page.click('#recPnlWrap [data-money="$"]');
      const d = await text(page, '#recPnlWrap .pnl-card.hero .pnl-v');
      chk(W + 'px app: dollars at the reader\'s own $25 unit', d === PNL.fmtDollars(PNL.dollars(fxSum.flat.summary.net_units, 25)), [d, fxSum.flat.summary.net_units]);
      chk(W + 'px app: the note names the unit it used', /\$25/.test(await text(page, '#recPnlWrap [data-r="top"] .pnl-note')));
      const lay = await layout(page, '#recPnlWrap');
      chk(W + 'px app: no horizontal page scroll', !lay.hscroll, lay);
      chk(W + 'px app: nothing wider than the screen', !lay.wide.length, lay.wide);
      await shot(page, 'app_' + W + '_pnl', '#recPnlWrap');
      await page.evaluate(() => recBook('football'));
      chk(W + 'px app: the football model record still renders', await page.waitForSelector('#recFbWrap .rkpis', { timeout: 15000 }).then(() => true).catch(() => false));
      await page.evaluate(() => recBook('pnl'));
      chk(W + 'px app: no page error', !errors.length, errors);
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 1440, height: 900 }, 'app.html', { session: true });
      await page.waitForFunction(() => typeof window.recBook === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); recBook('pnl'); });
      await page.waitForSelector('#recPnlWrap .pnl-cards', { timeout: 15000 });
      chk('app: a reader with no unit sees units only — never a default dollar amount', !(await page.$('#recPnlWrap [data-money]')) && !/\$/.test(await text(page, '#recPnlWrap .pnl-cards')));
      chk('app: no page error', !errors.length, errors);
      await ctx.close();
    }

    /* ============================================ the REAL committed record */
    feed = 'real';
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'pnl', 'summary.json'), 'utf8'));
    for (const W of [390, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'record.html');
      await page.waitForSelector('#pnlPub .pnl-cards', { timeout: 15000 });
      await page.waitForSelector('#pnlPub [data-r="lrows"] .pnl-lcount', { timeout: 15000 });
      const hero = await text(page, '#pnlPub .pnl-card.hero .pnl-v');
      chk(W + 'px real: the hero is the committed summary\'s', hero === PNL.fmtUnits(real.views.all.flat.summary.net_units), hero);
      if (!real.views.all.flat.summary.n) chk(W + 'px real: no bet settled yet — the chart says so rather than drawing a guess', /nothing is drawn from a guess/.test(await text(page, '#pnlPub [data-chart]')));
      const dq = await text(page, '#pnlPub .pnl-dq');
      chk(W + 'px real: data quality counts are the committed ones', dq.indexOf(String(real.views.all.data_quality.missing_entry_odds)) >= 0, dq.slice(0, 200));
      const lay = await layout(page, '#pnlPub');
      chk(W + 'px real: no horizontal page scroll', !lay.hscroll, lay);
      chk(W + 'px real: no page error', !errors.length, errors);
      await shot(page, 'real_' + W, '#pnlPub');
      await ctx.close();
    }
  } finally {
    await browser.close();
    srv.close();
  }
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'P&L section (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
module.exports = { fixture };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
