#!/usr/bin/env node
'use strict';
/* ===========================================================================
   /performance/ IN A REAL BROWSER, at a phone (390) and a desktop (1280),
   served the way GitHub Pages serves it.

     COMMITTED  the repository's own performance/data: the verified headline
                says "insufficient data" with its count (never a rate from
                nothing); the recorded tier prints its labelled numbers; the
                ledger lists games and opens one; ?g=<event> opens that game
     VERIFIED   a synthetic record with enough verified games: the headline
                prints a rate with its n, the calibration chart draws, the
                trend draws, a filter by sport narrows every figure
     FAILURE    no summary file: the page says it could not load, and shows
                nothing rather than a stale or partial record
     EVERYWHERE nothing wider than the screen; no script error; only public,
                same-origin files are read (no database, no /football/*.json);
                the tracker scripts are the page's last two
   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run: node tools/performance/performance_ui.e2e.js [--shots <dir>]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const P = require('../../lib/edgedesk_performance.js');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      let p = decodeURIComponent(u);
      const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!abs.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
      if (!p.endsWith('/') && fs.existsSync(abs) && fs.statSync(abs).isDirectory()) { res.writeHead(301, { location: u + '/' }); res.end(); return; }
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* a synthetic verified record: 30 NHL games, 30 NFL games */
function synthetic() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    const sport = i < 30 ? 'nhl' : 'nfl', start = new Date(Date.UTC(2026, 9, 1 + (i % 28), 23)).toISOString();
    const p = 0.45 + (i % 7) * 0.06, hs = i % 3 ? 4 : 1, as = 2;
    const s = { event_key: sport.toUpperCase() + '|S' + i, sport, start_utc: start, home: { name: 'Home ' + i }, away: { name: 'Away ' + i }, model: { id: sport + '_model_v1', predicted_at: start.slice(0, 10) + 'T10:00:00.000Z' },
      forecast: { p_home: p, fair_home_line: sport === 'nfl' ? -2.5 : null, fair_total: sport === 'nfl' ? 44 : 6.5, expected_total: sport === 'nhl' ? 6.1 : null },
      readiness: { research: 'RESEARCH_CONDITIONAL' }, capture: { method: 'ledger_capture', captured_at: start.slice(0, 10) + 'T12:00:00.000Z' }, hash: ('a' + i).padEnd(64, '0') };
    const res = { state: 'FINAL', home_score: sport === 'nfl' ? hs * 7 : hs, away_score: sport === 'nfl' ? as * 7 : as, start_utc: start, verified_at: start, sources: [{ source: 'espn_scoreboard' }] };
    rows.push(P.compact(P.publicRow(s, res, P.gradeGame(s, res), { revisions: 1 })));
  }
  const nfl = rows.filter((x) => x.sport === 'nfl'), nhl = rows.filter((x) => x.sport === 'nhl');
  const sum = { schema: 'edgedesk_perf_summary_v1', generated_at: '2026-10-30T00:00:00.000Z', ledger: { epoch: '2026-10-01T12:00:00.000Z' }, min_n: P.MIN_N,
    headline: { verified: P.metrics(rows), recorded: P.metrics([]) }, coverage: [
      { sport: 'nfl', label: 'NFL', league: 'NFL', status: 'GRADED', games: 30, verified_graded: 30, recorded_graded: 0, models: ['nfl_model_v1'] },
      { sport: 'nhl', label: 'NHL', league: 'NHL', status: 'GRADED', games: 30, verified_graded: 30, recorded_graded: 0, models: ['nhl_model_v1'] },
      { sport: 'mlb', label: 'MLB', league: 'MLB', status: 'NO_FORECAST', why: 'no per-game forecast', games: 0, verified_graded: 0, recorded_graded: 0, models: [] }],
    retrospective: [], rules: ['rule one'], games: [{ sport: 'nfl', season: 2026, path: '/performance/data/games/nfl-2026.json', rows: 30 }, { sport: 'nhl', season: 2027, path: '/performance/data/games/nhl-2027.json', rows: 30 }] };
  return { sum, files: { '/performance/data/games/nfl-2026.json': { rows: nfl }, '/performance/data/games/nhl-2027.json': { rows: nhl } } };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { pw = null; }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  const BASE = 'http://127.0.0.1:' + site.port;
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); site.srv.close(); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const SYN = synthetic();

  async function open(urlPath, viewport, mode) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 800, isMobile: viewport.width < 800 });
    const rec = { requests: [], errors: [] };
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (!u.startsWith(BASE)) { rec.requests.push(u); return route.fulfill({ status: 204, body: '' }); }
      const p = u.slice(BASE.length).split('?')[0];
      rec.requests.push(p);
      if (mode === 'synthetic' && p === '/performance/data/summary.json') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SYN.sum) });
      if (mode === 'synthetic' && SYN.files[p]) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SYN.files[p]) });
      if (mode === 'missing' && p === '/performance/data/summary.json') return route.fulfill({ status: 404, body: 'not found' });
      return route.continue();
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => rec.errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) rec.errors.push(m.text()); });
    await page.goto(BASE + urlPath);
    await page.waitForFunction(() => { const s = document.getElementById('pf-status'); return s && !/^Loading/.test(s.textContent); }, null, { timeout: 15000 });
    await page.waitForTimeout(250);
    return { ctx, page, rec };
  }
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  /* the page's own data is same-origin; the database is touched only by the
     site-wide tracker, and only through an anonymous door (lib/edgedesk_plans.js DOORS.anon) */
  const PLANS = require('../../lib/edgedesk_plans.js');
  const anonRpc = (r) => { const m = /supabase\.co\/rest\/v1\/rpc\/([a-z_]+)/.exec(r); return !!m && PLANS.DOORS.anon.rpc.indexOf(m[1]) >= 0; };
  const publicOnly = (rec) => rec.requests.every((r) => /^\/(performance\/|lib\/edgedesk_(calibration|performance|track|public)\.js|tools\/tools\.css)/.test(r) || /^https:\/\/fonts\./.test(r) || /googletagmanager|google-analytics/.test(r) || anonRpc(r));

  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 860 }]) {
    const tag = vp.width + 'px';
    /* COMMITTED data */
    let { ctx, page, rec } = await open('/performance/', vp, 'committed');
    const sum = JSON.parse(fs.readFileSync(path.join(ROOT, 'performance', 'data', 'summary.json'), 'utf8'));
    const vGraded = sum.headline.verified.eligibility.graded;
    const status = await page.textContent('#pf-status');
    if (vGraded < P.MIN_N) chk(tag + ' committed: the verified headline says insufficient data, with its count', /insufficient data/i.test(status) && status.indexOf(String(vGraded)) >= 0, status);
    else chk(tag + ' committed: the verified headline states its count', status.indexOf(String(vGraded)) >= 0, status);
    const head = await page.textContent('#pf-headline');
    if (vGraded < P.MIN_N) chk(tag + ' committed: no verified rate is printed from a small sample', !/%/.test(head) && /Insufficient data/.test(head), head);
    await page.click('.pf-tier button[data-tier="RECORDED"]');
    await page.waitForTimeout(150);
    const rows = await page.$$eval('#pf-ledger tbody tr', (x) => x.length);
    chk(tag + ' committed: the recorded tier lists its games, labelled', rows > 0 && (await page.$$eval('#pf-ledger .pf-chip.RECORDED', (x) => x.length)) > 0, rows);
    chk(tag + ' committed: the recorded tier prints its own figures', /%/.test(await page.textContent('#pf-filtered')));
    await page.click('#pf-ledger button.pf-x');
    await page.waitForTimeout(100);
    chk(tag + ' committed: a game opens to its sources and fingerprint', /Fingerprint/.test(await page.textContent('#pf-ledger')) && /Result/.test(await page.textContent('#pf-ledger')));
    const ov = await overflow(page);
    chk(tag + ' committed: nothing wider than the screen', ov <= 1, ov);
    chk(tag + ' committed: no script error', rec.errors.length === 0, rec.errors);
    chk(tag + ' committed: only public same-origin files are read', publicOnly(rec), rec.requests.filter((r) => !/^\/(performance|lib|tools)/.test(r)));
    chk(tag + ' committed: the record reads no database table and no /football/*.json', !rec.requests.some((r) => /\/football\//.test(r) || (/supabase/.test(r) && !anonRpc(r))));
    const btn = await page.$eval('#pf-ledger button.pf-x', (b) => b.getBoundingClientRect().height);
    chk(tag + ' committed: the ledger buttons are thumb-sized (44px)', btn >= 44, btn);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'performance_committed_' + vp.width + '.png'), fullPage: false });
    await ctx.close();

    /* a deep link to one game */
    const anyRow = (() => { for (const g of sum.games || []) { const f = JSON.parse(fs.readFileSync(path.join(ROOT, g.path.slice(1)), 'utf8')); if (f.rows.length) return f.rows[0]; } return null; })();
    if (anyRow) {
      ({ ctx, page, rec } = await open('/performance/?g=' + encodeURIComponent(anyRow.event_key), vp, 'committed'));
      await page.waitForTimeout(200);
      chk(tag + ' ?g= opens that game in its own tier', /Fingerprint/.test(await page.textContent('#pf-ledger')) && (await page.$eval('.pf-tier button.on', (b) => b.getAttribute('data-tier'))) === anyRow.tier);
      await ctx.close();
    }

    /* VERIFIED synthetic record */
    ({ ctx, page, rec } = await open('/performance/', vp, 'synthetic'));
    const head2 = await page.textContent('#pf-headline');
    chk(tag + ' verified: the headline prints a rate with its count', /\d+\.\d%/.test(head2) && /of 60/.test(head2), head2);
    chk(tag + ' verified: the calibration chart draws', (await page.$$eval('#pf-cal svg circle', (x) => x.length)) > 0);
    chk(tag + ' verified: the trend draws', (await page.$$eval('#pf-trend svg rect', (x) => x.length)) > 0);
    await page.selectOption('#pf-sport', 'nhl');
    await page.waitForTimeout(150);
    const f2 = await page.textContent('#pf-filtered');
    chk(tag + ' verified: a sport filter narrows the figures', /30 on record/.test(f2) && /of 30/.test(f2), f2.slice(0, 300));
    chk(tag + ' verified: an NHL game has no margin error (no fair spread was published)', /Insufficient data/.test(await page.textContent('#pf-filtered')) || /Margin error \(MAE\)Insufficient/.test(f2));
    await page.fill('#pf-q', 'Home 3');
    await page.waitForTimeout(150);
    chk(tag + ' verified: search narrows the ledger', (await page.$$eval('#pf-ledger tbody tr', (x) => x.length)) <= 12);
    chk(tag + ' verified: nothing wider than the screen', (await overflow(page)) <= 1);
    chk(tag + ' verified: no script error', rec.errors.length === 0, rec.errors);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'performance_verified_' + vp.width + '.png'), fullPage: true });
    await ctx.close();

    /* FAILURE */
    ({ ctx, page, rec } = await open('/performance/', vp, 'missing'));
    chk(tag + ' failure: the page says it could not load, and shows no record', /could not load/i.test(await page.textContent('#pf-status')) && (await page.$$eval('#pf-ledger tbody tr', (x) => x.length)) === 0);
    await ctx.close();
  }
  /* the page's last two scripts are the trackers, in order (tools/growth/growth_engine.test.js) */
  const html = fs.readFileSync(path.join(ROOT, 'performance', 'index.html'), 'utf8');
  const scripts = html.match(/<script src="[^"]+"[^>]*><\/script>/g) || [];
  chk('the trackers are the last two scripts', /edgedesk_track\.js/.test(scripts[scripts.length - 2]) && /edgedesk_public\.js/.test(scripts[scripts.length - 1]));
  chk('the page says research, not picks, and 21+', /Research, not picks/.test(html) && /21\+/.test(html) && /1-800-GAMBLER/.test(html));
  await browser.close();
  site.srv.close();
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'performance page — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL | ' + (e && e.stack || e)); process.exit(1); });
