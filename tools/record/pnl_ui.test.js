#!/usr/bin/env node
/* ===========================================================================
   THE RECORD'S PROFIT & LOSS SECTION, IN A REAL BROWSER.

   record.html (public) and app.html (Records) in Chromium,
   served from the repo, at 375, 390, 430, 768 and 1440 px. Two data sets:

     FIXTURE  a season of TEST data (never published, never committed) written
              as the real source ledgers — props, NFL and CFB game decisions,
              the model record — and run through tools/record/pnl_ledger.js,
              so the page is fed exactly what the scheduled job writes;
     REAL     the committed record/pnl/ as it stands, whose honest state today
              is "no settled bet with a captured price yet".

   It proves: the summary at the top — net units, PROFIT / LOSS / EVEN, ROI,
   record, win rate, bets — is the kernel's on the page's one dataset, and
   the tabs, the chart, its readout and the ledger total agree with it under
   every scope, period, stake and the leans switch; nothing settled reads
   "waiting for first priced bets to settle", never a giant 0.00u; directly
   under it the graded record (every graded model pick and bet, W-L-P by
   market) is populated from the same rows, never units, with what can never
   carry P&L and what is pending; a tab with no verified net shows its record;
   How P&L works and Advanced Analytics start closed, and Advanced holds the
   record by sport / market / model version / week / grade, the P&L
   breakdowns (or one "waiting for settlement" line — never a table of
   zeros), every row's state, why the pending ones are pending and the
   agreement checks; a changed ledger stamp reloads the page; the ledger has six
   columns and a row opens to its audit; in the app the summary is the first
   thing under the Records header and the detailed records live inside
   Advanced; dollars appear only when the reader has a unit; no horizontal
   page scroll at any width, no card wider than the screen, no page error.

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
  let feed = 'fixture';
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/record.html';
    if (feed === 'fixture' && p === '/record/pnl/summary.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FX.summary)); return; }
    if (feed === 'fixture' && p === '/record/pnl/rows_2026.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FX.page)); return; }
    if (feed === 'fixture' && p === '/record/pnl/stamp.json') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify(FX.stamp)); return; }
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
    const clipped = [];
    root.querySelectorAll('.pnl-net, .pnl-st-v, .pnl-hm-v, .pnl-tab-v, .pnl-v, .pnl-t td').forEach((el) => { if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === 'visible' && el.getBoundingClientRect().right > vw + 1) clipped.push(el.textContent.slice(0, 40)); });
    const small = [];
    root.querySelectorAll('.pnl-seg button, .pnl-tabs button, .pnl-btn, .pnl-in').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.height < 36) small.push(el.textContent.slice(0, 20) + ' ' + Math.round(r.height)); });
    return { hscroll, wide: wide.slice(0, 5), clipped: clipped.slice(0, 5), small: small.slice(0, 5) };
  }, sel);
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  /* the page's figures, read in one go */
  const read = (page, sel) => page.evaluate((s) => {
    const R = document.querySelector(s), t = (q) => { const e = R.querySelector(q); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    const stats = {}; R.querySelectorAll('.pnl-st').forEach((e) => { stats[e.querySelector('.pnl-st-k').textContent.trim()] = e.querySelector('.pnl-st-v').textContent.trim(); });
    const tabs = {}; R.querySelectorAll('.pnl-tabs [data-scope]').forEach((b) => { tabs[b.getAttribute('data-scope')] = b.querySelector('.pnl-tab-v').textContent.trim(); });
    const svg = R.querySelector('.pnl-svg');
    return { state: (R.querySelector('.pnl-hero') || {}).getAttribute ? R.querySelector('.pnl-hero').getAttribute('data-state') : null, net: t('.pnl-net'), verdict: t('.pnl-verdict'), none: t('.pnl-hero-none'), sub: t('.pnl-hero-sub'), stats, tabs,
      ey: t('.pnl-hero-ey'), perf: t('.pnl-perf-rec'), perfSub: t('.pnl-perf-sub'), hero: t('.pnl-hero'), status: t('[data-r="status"]'),
      hist: t('.pnl-hist'), lcount: t('.pnl-lcount'), chart: svg ? svg.getAttribute('aria-label') : null, under: t('.pnl-under'),
      how: R.querySelector('[data-r="how"]').open, adv: R.querySelector('[data-r="adv"]').open };
  }, sel);
  /* THE EXPECTED FIGURES: the kernel on the ledger's rows, with the page's one
     dataset rule — scope, period (Season / 30 / 7 days / All time), BET (and
     LEAN only when leans are included), flat or staked */
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  function expectOn(rows, season, o) {
    o = o || {};
    const per = o.period || 'season';
    const base = PNL.scopeRows(rows, o.scope || 'all').filter((x) => per === 'all' ? true : per === 'season' ? (x.season == null || x.season === season)
      : Date.parse(x.game_date) >= NOW - (per === '7d' ? 7 : 30) * 864e5);
    const bets = base.filter((x) => x.rec_class === 'BET' || (o.leans && x.rec_class === 'LEAN')).map((x) => (x.rec_class === 'LEAN' ? Object.assign({}, x, { rec_class: 'BET' }) : x));
    const s = PNL.summarize(bets, o.mode || 'flat');
    s.pending = bets.filter((x) => x.result === 'pending').length;
    /* the graded record: model picks + the strategy's bets, priced or not */
    const rec = base.filter((x) => PNL.inRecord(x, !!o.leans));
    s.record = PNL.gradedRecord(rec);
    const hist = {};
    PNL.recordBreakdowns(rec).market.forEach((m) => { hist[m.key] = m.graded ? m.record : null; });
    s.hist = hist;
    s.states = PNL.states(base);
    s.waiting = PNL.pendingReasons(base, NOW);
    return s;
  }
  const ROWS = FX.ledger.rows;
  const expect = (o) => expectOn(ROWS, 2026, o);
  const verdict = (s) => (s.net_units > 0.005 ? 'Profit' : s.net_units < -0.005 ? 'Loss' : 'Even');
  /* a tab: its verified net; else its graded record; else that bets are pending */
  const tabWant = (s) => (s.n ? PNL.fmtUnits(s.net_units) : s.record.graded ? s.record.record : s.pending ? 'Pending' : '—');
  /* the record card: the graded count, W-L-P and each market's record; never a unit figure */
  const histMatches = (h, s) => {
    h = h || '';
    if (!s.record.tracked) return h === '';
    const unpriced = !s.record.record_only || /Historical P&L unavailable for [\d,]+ graded result/.test(h);
    const noUnits = !/[+−-]?\d+\.\d\du/.test(h);
    /* the hero leads with the record when nothing priced settled: the card then holds the rest, never the same numbers twice */
    if (!s.n) return unpriced && noUnits && h.indexOf(s.record.record) < 0;
    const markets = Object.keys(s.hist).every((k) => !s.hist[k] || h.indexOf(s.hist[k]) >= 0);
    const head = s.record.graded ? h.indexOf(s.record.graded.toLocaleString('en-US') + ' graded') >= 0 && h.indexOf(s.record.record) >= 0 : /Waiting for settlement/.test(h);
    return markets && head && unpriced && noUnits;
  };
  /* the summary a reader sees, against the kernel */
  function heroMatches(tag, got, s) {
    if (!s.n) {
      /* no verified P&L: the page leads with the graded record (MODEL PERFORMANCE), never with emptiness */
      const waiting = s.pending > 0;
      if (s.record.graded) {
        chk(tag + ': with no settled priced bet the top is MODEL PERFORMANCE — the graded record, never a 0.00u',
          got.state === 'record' && /^Model performance/.test(got.ey || '') && got.perf === s.record.record && got.net === null
          && (got.perfSub || '').indexOf(PNL.fmtPct(s.record.win_rate_pct, 1) + ' won') === 0 && (got.perfSub || '').indexOf(s.record.graded.toLocaleString('en-US') + ' graded decision') >= 0, [got.ey, got.perf, got.perfSub, s.record.record]);
        chk(tag + ': the performance summary carries every market\'s record', Object.keys(s.hist).every((k) => !s.hist[k] || (got.hero || '').indexOf(s.hist[k]) >= 0), [got.hero, s.hist]);
      } else chk(tag + ': nothing graded yet says so (what is tracked), never a zero', got.state === (s.record.tracked ? 'waiting' : 'none') && got.net === null && got.perf === null && /No graded results yet|Nothing tracked in this view yet/.test(got.none || ''), got);
      chk(tag + ': the verified P&L is the small status box under it, honest about why it is empty',
        (waiting ? /Waiting for first priced settlements/ : /No priced bets in this view yet/).test(got.status || '') && (!waiting || (got.status || '').indexOf(s.pending.toLocaleString('en-US') + ' priced bet') >= 0) && !/0\.00u/.test(got.status || ''), got.status);
      return;
    }
    chk(tag + ': with settled priced bets the top is MODEL P&L, and no status box', /^Model P&L/.test(got.ey || '') && !got.status, [got.ey, got.status]);
    chk(tag + ': net units are the kernel\'s', got.net === PNL.fmtUnits(s.net_units), [got.net, s.net_units]);
    chk(tag + ': PROFIT / LOSS / EVEN follows the sign', got.verdict === verdict(s) && got.state === verdict(s).toLowerCase(), [got.verdict, s.net_units]);
    chk(tag + ': ROI, record, win rate and bets are the kernel\'s', got.stats.ROI === PNL.fmtPct(s.roi_pct, 1, true) && got.stats.Record === s.wins + '-' + s.losses + '-' + s.pushes
      && got.stats['Win rate'] === PNL.fmtPct(s.win_rate_pct, 1) && got.stats.Bets === s.n + ' verified', [got.stats, s.roi_pct, s.record, s.win_rate_pct, s.n]);
    chk(tag + ': the chart, its readout and the ledger total say the same net', (got.chart || '').indexOf(PNL.fmtUnits(s.net_units)) >= 0 && (got.under || '').indexOf('Current ' + PNL.fmtUnits(s.net_units)) === 0
      && (got.lcount || '').indexOf(PNL.fmtUnits(s.net_units) + ' over ' + s.n + ' settled') >= 0, [got.chart, got.under, got.lcount]);
  }

  try {
    const fxFlat = expect();
    chk('the fixture has a season to draw (test data)', fxFlat.n >= 20 && expect({ mode: 'staked' }).n >= 20, fxFlat.n);
    /* ============================================ record.html, every width */
    for (const W of [375, 390, 430, 768, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'record.html');
      await page.waitForSelector('#pnlPub .pnl-hero[data-state]', { timeout: 15000 });
      await page.waitForSelector('#pnlPub .pnl-lt', { timeout: 15000 });
      const got = await read(page, '#pnlPub');
      heroMatches(W + 'px public', got, fxFlat);
      chk(W + 'px public: each tab carries its own net (All, CFB, NFL, Player Props)', ['all', 'cfb', 'nfl', 'props'].every((k) => got.tabs[k] === tabWant(expect({ scope: k }))), got.tabs);
      chk(W + 'px public: the graded record is wins and losses by market, from the same rows, never units', histMatches(got.hist, fxFlat), [got.hist, fxFlat.record.record, fxFlat.hist]);
      chk(W + 'px public: How P&L works and Advanced Analytics start closed', got.how === false && got.adv === false);
      const lay = await layout(page, '#pnlPub');
      chk(W + 'px public: the section causes no horizontal page scroll', !lay.hscroll, lay);
      chk(W + 'px public: no card, table row or control wider than the screen', !lay.wide.length, lay.wide);
      chk(W + 'px public: no clipped figure', !lay.clipped.length, lay.clipped);
      chk(W + 'px public: touch targets are at least 36px tall', !lay.small.length, lay.small);
      chk(W + 'px public: no dollar toggle without a reader\'s unit', !(await page.$('#pnlPub [data-money]')));
      chk(W + 'px public: the chart draws the units and the running peak, and no drawdown wash', !!(await page.$('#pnlPub .pnl-svg .pnl-line')) && !!(await page.$('#pnlPub .pnl-svg .pnl-peak')) && !(await page.$('#pnlPub .pnl-ddarea')));
      const heads = await page.$$eval('#pnlPub .pnl-lt thead th', (els) => els.map((e) => e.textContent.trim()));
      chk(W + 'px public: the ledger has six columns: date, sport, bet, odds, result, units', JSON.stringify(heads) === JSON.stringify(['Date', 'Sport', 'Bet', 'Odds', 'Result', 'Units']), heads);
      chk(W + 'px public: no page error', !errors.length, errors);
      if (W === 375) {
        const fold = await page.evaluate(() => { const h = document.querySelector('#pnlPub .pnl-hero'); h.scrollIntoView({ block: 'start' }); return { heroBottom: h.getBoundingClientRect().bottom - h.getBoundingClientRect().top }; });
        chk('375px: the summary leads and fits one phone screen', fold.heroBottom < 700, fold);
        await shot(page, 'record_375_fold');
      }
      if (W === 390) {
        await page.$eval('#pnl', (el) => el.scrollIntoView());
        await shot(page, 'record_390_section', '#pnlPub');
        const chartBox = await page.$('#pnlPub .pnl-svg');
        await chartBox.scrollIntoViewIfNeeded();
        const bb = await chartBox.boundingBox();
        await page.touchscreen.tap(bb.x + bb.width * 0.7, bb.y + bb.height / 2);
        const tip = await text(page, '#pnlPub .pnl-tip');
        chk('390px: tapping the chart names the bet and the running total', /Running total/.test(tip) && /Odds:/.test(tip) && /Stake:/.test(tip), tip);
        chk('390px: ledger rows read as two-line rows (grid), no column labels', await page.$eval('#pnlPub .pnl-lt tbody tr.pnl-lr', (el) => getComputedStyle(el).display === 'grid'));
        await shot(page, 'record_390_ledger', '#pnlPub [data-r="ledger"]');
      }
      if (W === 1440) {
        await page.$eval('#pnl', (el) => el.scrollIntoView());
        await shot(page, 'record_1440_section', '#pnlPub');
        /* every filter moves the same dataset: summary, tabs, chart, ledger */
        await page.selectOption('#pnlPub [data-mode]', 'staked');
        const st = expect({ mode: 'staked' });
        heroMatches('staked', await read(page, '#pnlPub'), st);
        chk('staked: a different number from flat — the two are never mixed', st.net_units !== fxFlat.net_units);
        await page.selectOption('#pnlPub [data-mode]', 'flat');
        for (const k of ['props', 'nfl', 'cfb']) {
          await page.click('#pnlPub .pnl-tabs [data-scope="' + k + '"]');
          heroMatches('tab ' + k, await read(page, '#pnlPub'), expect({ scope: k }));
        }
        await page.click('#pnlPub .pnl-tabs [data-scope="props"]');
        chk('tab props: the record card holds the props record only (no game markets), W-L-P, never units', histMatches(await text(page, '#pnlPub [data-r="hist"]'), expect({ scope: 'props' })) && !/Spread|Moneyline/.test(await text(page, '#pnlPub [data-r="hist"]')), await text(page, '#pnlPub [data-r="hist"]'));
        await page.click('#pnlPub .pnl-tabs [data-scope="all"]');
        chk('the record card is the selected view\'s record (All)', histMatches(await text(page, '#pnlPub [data-r="hist"]'), fxFlat));
        for (const p of ['30d', '7d', 'all', 'season']) {
          await page.click('#pnlPub [data-period="' + p + '"]');
          heroMatches('period ' + p, await read(page, '#pnlPub'), expect({ period: p }));
        }
        await page.check('#pnlPub [data-leans]');
        const ln = expect({ leans: true });
        heroMatches('with leans', await read(page, '#pnlPub'), ln);
        chk('with leans: more bets than BET alone, and leans are marked in the ledger', ln.n > fxFlat.n && /Lean/.test(await text(page, '#pnlPub [data-r="lrows"]')), [ln.n, fxFlat.n]);
        await page.uncheck('#pnlPub [data-leans]');
        heroMatches('leans off again', await read(page, '#pnlPub'), fxFlat);
        /* chart: keyboard readout */
        await page.focus('#pnlPub .pnl-svg');
        await page.keyboard.press('End');
        const tipEnd = await text(page, '#pnlPub .pnl-tip');
        chk('chart: End reads the last bet, and its running total is the net', tipEnd.indexOf('Running total: ' + PNL.fmtUnits(fxFlat.net_units)) >= 0, tipEnd);
        await page.keyboard.press('ArrowLeft');
        chk('chart: arrow keys step through the bets', (await text(page, '#pnlPub .pnl-tip')) !== tipEnd);
        /* help: the long explanation lives behind an info button */
        await page.click('#pnlPub .pnl-hero-ey [data-help="verified"]');
        chk('help: the verified P&L is explained in the popover', /classified BET, at the exact price it recorded/.test(await text(page, '#pnlPub .pnl-pop')));
        await page.mouse.click(5, 5);
        chk('help: a click elsewhere closes it', await page.$eval('#pnlPub .pnl-pop', (el) => el.hidden));
        await page.click('#pnlPub [data-r="how"] > summary');
        chk('How P&L works: the method, on demand', /stake × 100 ÷ \|odds\|/.test(await text(page, '#pnlPub [data-r="how"]')) && /never assumes −110/.test(await text(page, '#pnlPub [data-r="how"]')));
        /* Advanced Analytics: everything else, built when opened */
        chk('advanced: nothing is built while closed', !(await page.$('#pnlPub [data-r="advbody"] .pnl-sec')));
        await page.click('#pnlPub [data-r="adv"] > summary');
        await page.waitForSelector('#pnlPub [data-r="advbody"] .pnl-sec', { timeout: 5000 });
        const bdNames = await page.$$eval('#pnlPub [data-r="advbody"] .pnl-det > summary', (els) => els.map((e) => e.textContent));
        ['By league', 'By market', 'By player prop type', 'By side', 'By book', 'By model edge', 'By recommendation grade', 'By unit size', 'By odds range', 'By week', 'Model version performance'].forEach((n) => chk('advanced: breakdown present: ' + n, bdNames.some((x) => x.indexOf(n) === 0), bdNames));
        const advTxt = await text(page, '#pnlPub [data-r="advbody"]');
        ['Where the record comes from', 'Edge calibration', 'CLV vs P&L', 'Drawdown', 'Game markets vs player props', 'Every recommendation\'s state', 'Why pending'].forEach((n) => chk('advanced: ' + n, advTxt.indexOf(n) >= 0));
        ['By sport', 'By market', 'By model version', 'By week', 'By grade'].forEach((n) => chk('advanced: the record, ' + n, bdNames.some((x) => x.indexOf(n) === 0), bdNames));
        const recGraded = await page.$$eval('#pnlPub [data-r="rectables"] details:first-of-type tbody td[data-l="Graded"]', (els) => els.reduce((a, e) => a + Number(e.textContent.replace(/,/g, '')), 0));
        chk('advanced: the record by sport adds up to the record card', recGraded === fxFlat.record.graded, [recGraded, fxFlat.record.graded]);
        const stN = await page.$$eval('#pnlPub [data-r="states"] .pnl-dqi[data-state]', (els) => els.map((e) => [e.getAttribute('data-state'), Number(e.querySelector('.pnl-dqn').textContent.replace(/,/g, ''))]));
        chk('advanced: every row\'s state, counted once (the kernel\'s)', stN.length === 5 && stN.every((x) => x[1] === fxFlat.states[x[0]]) && stN.reduce((a, x) => a + x[1], 0) === fxFlat.states.total, [stN, fxFlat.states]);
        chk('advanced: the agreement checks are run and pass', /All \d+ agreement checks pass/.test(await text(page, '#pnlPub [data-r="integrity"]')));
        chk('advanced: calibration has eight buckets', (await page.$$('#pnlPub section:has(h4:text("Edge calibration")) tbody tr')).length === 8);
        const mk = PNL.breakdowns(PNL.scopeRows(ROWS, 'all').filter((x) => x.rec_class === 'BET'), 'flat').market;
        const mkSum = mk.reduce((a, x) => a + (x.net_units || 0), 0);
        chk('advanced: the breakdowns add up to the summary (same dataset)', Math.abs(mkSum - fxFlat.net_units) < 0.02, [mkSum, fxFlat.net_units]);
        await page.fill('#pnlPub [data-pq]', 'Receiver Two');
        await page.waitForTimeout(250);
        const prow = await page.$$('#pnlPub .pnl-pt tbody tr.pnl-click');
        chk('advanced: players search finds one player', prow.length === 1);
        await prow[0].click();
        const drill = await text(page, '#pnlPub .pnl-drill');
        chk('advanced: the player drill-down shows prop type, over/under and every recommendation', /By prop type/.test(drill) && /Game log/.test(drill), drill.slice(0, 200));
        await page.click('#pnlPub [data-r="adv"] > summary');
        /* the ledger: the summary's bets, auditable */
        await page.click('#pnlPub [data-lstatus="history"]');
        await page.fill('#pnlPub [data-lq]', 'ppe_noprice');
        await page.waitForTimeout(250);
        const np = await text(page, '#pnlPub [data-r="lrows"] .pnl-lt tbody');
        chk('ledger: a settled bet with no captured price is in the graded history as a record only, with no profit', /Record only/.test(np) && !/[+−]\d+\.\d\du/.test(np), np.slice(0, 300));
        await page.click('#pnlPub [data-r="lrows"] tr.pnl-lr');
        const audit = await text(page, '#pnlPub [data-r="lrows"] .pnl-audit');
        chk('ledger: the audit row names the model number, lines, CLV, edge, book, version, its state and why there is no P&L',
          ['Model number', 'Entry line', 'Closing line', 'CLV', 'Edge', 'Book', 'Model version', 'Recommended', 'State'].every((k) => audit.indexOf(k) >= 0) && /Settled · record only/.test(audit) && /Historical P&L unavailable — entry odds were not captured/.test(audit), audit.slice(0, 500));
        const corr = FX.ledger.rows.find((x) => x.corrected && x.rec_class === 'BET');
        if (corr) {
          await page.click('#pnlPub [data-lstatus="verified"]');
          await page.fill('#pnlPub [data-lq]', corr.recommendation_id);
          await page.waitForTimeout(250);
          chk('ledger: a corrected row is marked', /corrected/.test(await text(page, '#pnlPub [data-r="lrows"]')));
          await page.click('#pnlPub [data-r="lrows"] tr.pnl-lr');
          chk('ledger: the correction names what changed and why', /Corrections/.test(await text(page, '#pnlPub [data-r="lrows"] .pnl-audit')) && /official statistic changed \(TEST\)/.test(await text(page, '#pnlPub [data-r="lrows"] .pnl-audit')));
        }
        await page.fill('#pnlPub [data-lq]', '');
        await page.click('#pnlPub [data-lstatus="pending"]');
        chk('ledger: three views — verified P&L, historical graded, pending', (await page.$$eval('#pnlPub [data-lstatus]', (els) => els.map((e) => e.getAttribute('data-lstatus')))).join() === 'verified,history,pending');
        await page.waitForTimeout(100);
        const pend = await page.$$eval('#pnlPub [data-r="lrows"] tr.pnl-lr td[data-l="Result"]', (els) => els.map((e) => e.textContent.trim()));
        chk('ledger: the pending view holds pending bets only, never in the totals', pend.length === fxFlat.pending && pend.every((x) => x === 'Pending'), [pend.length, fxFlat.pending]);
        await page.click('#pnlPub [data-lstatus="history"]');
        await page.waitForTimeout(100);
        const hCount = await text(page, '#pnlPub [data-r="lrows"] .pnl-lcount');
        const hHead = await page.$$eval('#pnlPub [data-r="lrows"] .pnl-lt thead th', (els) => els.map((e) => e.textContent.trim()));
        const hStatus = await page.$$eval('#pnlPub [data-r="lrows"] tr.pnl-lr td[data-l="Status"]', (els) => els.map((e) => e.textContent.trim()));
        chk('ledger: the historical graded view is the record\'s own rows — date, sport, bet, result, record status',
          JSON.stringify(hHead) === JSON.stringify(['Date', 'Sport', 'Bet', 'Result', 'Record status']) && hCount.indexOf(fxFlat.record.graded.toLocaleString('en-US') + ' result') >= 0 && hCount.indexOf(fxFlat.record.record) >= 0
          && hStatus.length > 0 && hStatus.every((x) => x === 'Verified' || x === 'Record only') && hStatus.some((x) => x === 'Record only'), [hHead, hCount, hStatus.slice(0, 4)]);
        await shot(page, 'record_1440_ledger', '#pnlPub [data-r="ledger"]');
      }
      await ctx.close();
    }

    /* ============================================ app.html, Records */
    for (const W of [390, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'app.html', { session: true, unit: 25 });
      await page.waitForFunction(() => typeof window.recBook === 'function' && typeof window.show === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); });
      await page.waitForSelector('#recPnlWrap .pnl-hero[data-state]', { timeout: 15000 });
      await page.waitForSelector('#recPnlWrap .pnl-lt', { timeout: 15000 });
      const top = await page.evaluate(() => {
        const head = document.querySelector('#v-record > .row-between'), hero = document.querySelector('#recPnlWrap .pnl-hero'), tabs = document.querySelector('#recPnlWrap .pnl-tabs');
        return { first: head && head.nextElementSibling ? head.nextElementSibling.id : null, heroTop: hero.getBoundingClientRect().top + window.scrollY, heroBottom: hero.getBoundingClientRect().bottom + window.scrollY, tabsBottom: tabs.getBoundingClientRect().bottom + window.scrollY,
          order: Array.from(document.querySelectorAll('#recPnlWrap > [data-r]')).map((e) => e.getAttribute('data-r')),
          books: document.querySelectorAll('#recBook button').length, bookText: document.getElementById('recBook').textContent, detailInAdvanced: !!document.querySelector('#recPnlWrap [data-r="adv"] #recDetail') };
      });
      chk(W + 'px app: the P&L summary is the first thing under the Records header', top.first === 'recPnlWrap', top);
      chk(W + 'px app: the summary is on the first screen', top.heroBottom < 900, top);
      chk(W + 'px app: the order — performance, verified P&L status, historical results, filters, ledger, then the collapsed sections',
        JSON.stringify(top.order) === JSON.stringify(['hero', 'chart', 'status', 'hist', 'controls', 'ledger', 'how', 'adv']), top.order);
      chk(W + 'px app: no Profit & Loss book any more — the detailed records are two, inside Advanced Analytics', top.books === 2 && !/Profit & Loss/.test(top.bookText) && top.detailInAdvanced, top);
      heroMatches(W + 'px app', await read(page, '#recPnlWrap'), fxFlat);
      chk(W + 'px app: a reader with a unit gets the dollars toggle', !!(await page.$('#recPnlWrap [data-money="$"]')));
      await page.click('#recPnlWrap [data-money="$"]');
      const d = await text(page, '#recPnlWrap .pnl-net');
      chk(W + 'px app: dollars at the reader\'s own $25 unit', d === PNL.fmtDollars(PNL.dollars(fxFlat.net_units, 25)), [d, fxFlat.net_units]);
      chk(W + 'px app: the note names the unit it used', /\$25/.test(await text(page, '#recPnlWrap [data-r="controls"] .pnl-note')));
      await page.click('#recPnlWrap [data-money="u"]');
      const lay = await layout(page, '#recPnlWrap');
      chk(W + 'px app: no horizontal page scroll', !lay.hscroll, lay);
      chk(W + 'px app: nothing wider than the screen', !lay.wide.length, lay.wide);
      await shot(page, 'app_' + W + '_records');
      await page.evaluate(() => recBook('pnl'));
      chk(W + 'px app: an old link to the P&L book lands on the summary', await page.$eval('#recPnlWrap', (el) => !el.classList.contains('hide')));
      await page.evaluate(() => window.EDFootballRecord.open('nfl'));
      chk(W + 'px app: the Football board\'s track-record link opens the football model record inside Advanced Analytics',
        await page.$eval('#recPnlWrap [data-r="adv"]', (el) => el.open) && await page.$eval('#recFbWrap', (el) => !el.classList.contains('hide')));
      chk(W + 'px app: no page error', !errors.length, errors);
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 1440, height: 900 }, 'app.html', { session: true });
      await page.waitForFunction(() => typeof window.recBook === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); });
      await page.waitForSelector('#recPnlWrap .pnl-hero[data-state]', { timeout: 15000 });
      chk('app: a reader with no unit sees units only — never a default dollar amount', !(await page.$('#recPnlWrap [data-money]')) && !/\$/.test(await text(page, '#recPnlWrap .pnl-hero')));
      chk('app: no page error', !errors.length, errors);
      await ctx.close();
    }

    /* ============================================ the REAL committed record */
    feed = 'real';
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'record', 'pnl', 'summary.json'), 'utf8'));
    const realRows = require('./pnl_core.js').expandRows(JSON.parse(fs.readFileSync(path.join(ROOT, real.rows_file || ('record/pnl/rows_' + real.season + '.json')), 'utf8')));
    const rs = expectOn(realRows, real.season, {});
    for (const W of [390, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 900 }, 'record.html');
      await page.waitForSelector('#pnlPub .pnl-hero[data-state]', { timeout: 15000 });
      const got = await read(page, '#pnlPub');
      heroMatches(W + 'px real', got, rs);
      if (!rs.n) chk(W + 'px real: the verified P&L status counts the pending priced bets, BET only', (got.status || '').indexOf(rs.pending.toLocaleString('en-US') + ' priced bet') >= 0, [got.status, rs.pending]);
      chk(W + 'px real: the graded record is populated from the committed rows (' + rs.record.record + ' over ' + rs.record.graded + ')', histMatches(got.hist, rs) && (!rs.record.graded || rs.record.graded > 0), [got.hist, rs.record.record, rs.hist]);
      chk(W + 'px real: every tab shows what it holds — a net, a record or pending, never a bare dash when rows exist', ['all', 'cfb', 'nfl', 'props'].every((k) => got.tabs[k] === tabWant(expectOn(realRows, real.season, { scope: k }))), got.tabs);
      chk(W + 'px real: the pending line counts every pending recommendation and says why', !rs.waiting.total || ((got.hist || '').indexOf(rs.waiting.total.toLocaleString('en-US') + ' recommendation') >= 0 && (got.hist || '').indexOf(rs.waiting.reasons[0].label) >= 0), [got.hist, rs.waiting]);
      await page.evaluate(() => { document.querySelector('#pnlPub [data-why]') ? document.querySelector('#pnlPub [data-why]').click() : document.querySelector('#pnlPub [data-r="adv"]').open = true; });
      await page.waitForSelector('#pnlPub [data-r="states"]', { timeout: 5000 });
      const whole = await text(page, '#pnlPub');
      chk(W + 'px real: no misleading zero anywhere — no 0.00u and no 0-0-0 while nothing priced has settled', rs.n || (!/(^|[^\d.])0\.00u/.test(whole) && !/(^|[^\d])0-0-0/.test(whole)), (whole.match(/.{30}(0\.00u|0-0-0).{10}/) || [])[0]);
      if (!rs.n) chk(W + 'px real: the P&L analytics say "waiting for settlement" once instead of tables of zeros', /Waiting for settlement/.test(await text(page, '#pnlPub [data-r="pnlwait"]')) && !(await page.$('#pnlPub section:has(h4:text("Edge calibration"))')));
      const whyN = await page.$$eval('#pnlPub [data-r="why"] li[data-reason]', (els) => els.map((e) => [e.getAttribute('data-reason'), Number(e.querySelector('b').textContent.replace(/,/g, ''))]));
      chk(W + 'px real: why pending — the reasons add up to every pending recommendation', whyN.reduce((a, x) => a + x[1], 0) === rs.waiting.total && whyN.every((x) => rs.waiting.reasons.some((r) => r.key === x[0] && r.n === x[1])), [whyN, rs.waiting]);
      chk(W + 'px real: every row\'s state, as the summary counts them', (await page.$$eval('#pnlPub [data-r="states"] .pnl-dqi[data-state]', (els) => els.map((e) => [e.getAttribute('data-state'), Number(e.querySelector('.pnl-dqn').textContent.replace(/,/g, ''))]))).every((x) => x[1] === rs.states[x[0]]));
      if (!rs.n) chk(W + 'px real: with no verified P&L the ledger opens on the historical graded results, not on pending', await page.$eval('#pnlPub [data-lstatus="history"]', (b) => b.classList.contains('on')) && (await text(page, '#pnlPub [data-r="lrows"] .pnl-lcount')).indexOf(rs.record.graded.toLocaleString('en-US') + ' result') >= 0);
      chk(W + 'px real: the agreement checks pass on the committed data', /All \d+ agreement checks pass/.test(await text(page, '#pnlPub [data-r="integrity"]')) && !(await page.$('#pnlPub .pnl-integrity')));
      if (W === 1440) {
        /* LIVE: a settlement run moves the stamp; the open page re-reads the ledger */
        feed = 'fixture';
        await page.evaluate(() => document.getElementById('pnlPub').__pnl.check());
        await page.waitForFunction(() => ['profit', 'loss', 'even'].indexOf(document.querySelector('#pnlPub .pnl-hero').getAttribute('data-state')) >= 0, null, { timeout: 8000 }).catch(() => {});
        heroMatches('after a settlement run (stamp moved)', await read(page, '#pnlPub'), expect({}));
        feed = 'real';
      }
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
