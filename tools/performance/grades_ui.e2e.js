#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The research grade in a real Chromium, at a 390 px phone and a 1280 px
   desktop:

     DASHBOARD  /performance/grades/ on the committed files (the honest
                "Insufficient Historical Data" state), on a populated record
                built by the kernel from settled rows (charts, the grade table,
                the ordering evidence, filters, hover and keyboard tooltips,
                table views), and on a failed load (nothing stale is shown)
     TERMINAL   app.html#games over the slate fixture with a live grade file:
                a badge on each graded card with the "not a win probability"
                tooltip, the letter filter, the Grade Breakdown in the matchup
                view with every part and its reason
     PUBLIC     /today/ shows no grade and never reads the grade files

   No page error, no horizontal page scroll, only same-origin requests.
   Run: node tools/performance/grades_ui.e2e.js [--shots DIR]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const G = require('../../lib/edgedesk_research_grade.js');
const GB = require('./grade_build.js');
const SF = require('../slate/fixtures/slate_fixture.js');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'research grade UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ------------------------------------------------- a populated record */
function populated() {
  const rows = [];
  const mk = (letter, i, p, y, mErr, sport) => G.compact({ event_key: (sport || 'nfl').toUpperCase() + '|' + letter + i, sport: sport || 'nfl', league: sport === 'cfb' ? 'FBS' : 'NFL', season: 2026,
    home: 'Home ' + i, away: 'Away ' + i, start_utc: new Date(Date.parse('2026-09-06T17:00:00Z') + i * 7 * 3600e3).toISOString(),
    letter, score: { A: 92, B: 84, C: 74, D: 64, F: 50 }[letter] || null, grade_state: letter === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'GRADED', grade_version: 'rg_v1', model_id: 'edgedesk_football_v1.0.0',
    dims: { reliability: 70, completeness: 90, market: 80, clarity: 60, uncertainty: 50 }, market_status: 'CAPTURED', evaluated: { spread: true, total: true },
    snapshot: { hash: 'h' + letter + i, captured_at: '2026-09-06T12:00:00Z', revisions: 2 },
    outcome: { eligible: true, settlement: { state: 'SETTLED', home_score: 24, away_score: 20 }, winner: { p_home: p, outcome: y, brier: +((p - y) * (p - y)).toFixed(6), correct: (p > 0.5) === (y === 1), favourite_p: Math.max(p, 1 - p) },
      spread: { error: mErr, abs_error: Math.abs(mErr) }, total: { error: 3, abs_error: 3 },
      market: { spread: { line: -3, market_margin: 3, market_abs_error: 4, pick: { side: 'home', gap: 1, result: i % 2 ? 'win' : 'loss', price: -110, units: i % 2 ? 0.9091 : -1 } },
        total: { line: 44, market_abs_error: 3, pick: { side: 'over', gap: 1, result: i % 3 ? 'win' : 'loss', price: -110, units: i % 3 ? 0.9091 : -1 } } } } });
  for (let i = 0; i < 60; i++) rows.push(mk('A', i, i % 2 ? 0.75 : 0.25, i % 10 < 8 ? (i % 2 ? 1 : 0) : (i % 2 ? 0 : 1), (i % 5) - 2, i % 3 ? 'nfl' : 'cfb'));
  for (let i = 0; i < 60; i++) rows.push(mk('B', 100 + i, 0.7, i % 10 < 5 ? 1 : 0, (i % 7) * 2 - 6, 'nfl'));
  for (let i = 0; i < 25; i++) rows.push(mk('C', 200 + i, 0.6, i % 2, 4, 'cfb'));
  for (let i = 0; i < 4; i++) rows.push(mk('D', 300 + i, 0.6, 1, 2, 'nfl'));
  rows.push(mk('INSUFFICIENT', 400, 0.6, 1, 2, 'nfl'));
  const st = { research_grades: [{ captured_at: '2026-09-01T00:00:00Z' }, { captured_at: '2026-10-15T00:00:00Z' }], forecasts: [], grade_outcomes: [] };
  const now = Date.parse('2026-10-16T00:00:00Z');
  const sum = GB.buildSummary(st, rows, now, { no_pregame_grade: [{}, {}, {}] });
  sum.games = [{ sport: 'all', season: 2026, path: '/performance/data/grades/games/all-2026.json', rows: rows.length }];
  return { summary: sum, games: { schema: 'edgedesk_research_grade_games_v1', rows } };
}

/* ------------------------------------------------- the live grade file */
function liveFiles() {
  const cap = new Date(SF.NOW - 3600e3).toISOString();
  const entry = (letter, score, extra) => Object.assign({ sport: 'nhl', league: 'NHL', start_utc: new Date(SF.NOW + 3 * 3600e3).toISOString(), home: 'Home', away: 'Away', letter, score, state: letter === 'INSUFFICIENT' ? 'INSUFFICIENT' : 'GRADED',
    dims: { reliability: [75, 'partial'], completeness: [100, 'ok'], market: [95, 'ok'], clarity: [76, 'ok'], uncertainty: [98, 'ok'] }, explanation: letter + ' (' + score + '/100). Strengths: results feed fresh. Holding it back: starting goalies projected.',
    captured_at: cap, model: 'edgedesk_nhl_v1:xg_core', market: 'CAPTURED', revisions: 2, history: [[new Date(SF.NOW - 7200e3).toISOString(), 'B', 82], [cap, letter, score]] }, extra || {});
  const live = { schema: 'edgedesk_research_grade_live_v1', generated_at: new Date(SF.NOW).toISOString(), grade_version: 'rg_v1', weights_version: 'w1-provisional-2026-10', tooltip: G.TOOLTIP, letters: G.LETTER_MEANING,
    counts: { A: 1, C: 1, INSUFFICIENT: 1 },
    games: {
      'NHL|2026020202': entry('A', 91),
      'CFB|401871067': entry('C', 72, { sport: 'cfb', league: 'FBS', caps: ['CALIBRATION_UNVALIDATED'], cap: 'C', flags: ['NO_PREGAME_MARKET'], market: 'NO_QUOTE' }),
      'NCAAM|401910009': entry('INSUFFICIENT', null, { sport: 'ncaab_m', league: 'NCAAM', state: 'INSUFFICIENT', gates: ['FRESH_BUILD'], explanation: 'Not graded — insufficient data: model build expired. The research is shown, but no letter is given.' })
    },
    alias: { 'nhl:espn:401802002': 'NHL|2026020202', 'cfb:espn:401871067': 'CFB|401871067', 'ncaam:espn:401910009': 'NCAAM|401910009' } };
  const sub = (id, label, score, status, detail) => ({ id, label, status, score, points: 1, detail });
  const detail = { schema: 'edgedesk_research_grade_live_detail_v1', games: { 'NHL|2026020202': { dims: {
    reliability: { label: 'Model reliability & calibration', weight: 30, score: 75, points: 22.5, status: 'partial', sub: [sub('live_skill', 'Live pregame record: Brier skill', null, 'unvalidated', '29 graded pregame games; 50 are needed before its record counts'), sub('walk_forward', 'Walk-forward validation (retrospective)', 75, 'ok', 'moneyline outcome validated in walk-forward testing')] },
    completeness: { label: 'Data completeness', weight: 25, score: 100, points: 25, status: 'ok', sub: [sub('model_outputs', 'Model outputs present', 100, 'ok', 'every expected output published')] },
    market: { label: 'Model–market comparison', weight: 20, score: 95, points: 19, status: 'ok', sub: [sub('quote_age', 'Market line age', 100, 'ok', 'Draft Kings line captured 1 h before this grade')] },
    clarity: { label: 'Matchup clarity', weight: 15, score: 76, points: 11.4, status: 'ok', sub: [sub('key_role', 'Key-role availability', 40, 'ok', 'starting goalies: projected uncertain')] },
    uncertainty: { label: 'Uncertainty', weight: 10, score: 98, points: 9.8, status: 'ok', sub: [sub('model_spread', 'Model disagreement / stability', 98, 'ok', 'model variants disagree by 0.3 points of win probability')] } },
    gates: [], caps: [], missing: [] } } };
  return { live, detail };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const built = await SF.buildFixture({ now: SF.NOW - 10 * 60000 });
  const SLATE = built.snap;
  const POP = populated();
  const LIVE = liveFiles();
  const M = { grades: 'committed', live: 'on' };
  const reads = [];

  function json(res, body, status) { res.writeHead(status || 200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); }
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    reads.push(p);
    if (p === '/performance/grades/') p = '/performance/grades/index.html';
    if (p === '/today/') p = '/today/index.html';
    if (p === '/today/slate.json') return json(res, SLATE);
    if (/^\/performance\/data\/grades\//.test(p)) {
      if (M.grades === 'down') return json(res, '{}', 503);
      if (M.grades === 'populated') {
        if (/summary\.json$/.test(p)) return json(res, POP.summary);
        if (/all-2026\.json$/.test(p)) return json(res, POP.games);
      }
      if (/live\.json$/.test(p) && M.live === 'on') return json(res, LIVE.live);
      if (/live_detail\.json$/.test(p) && M.live === 'on') return json(res, LIVE.detail);
    }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, url, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, timezoneId: 'America/Chicago', locale: 'en-US' });
    if (o.app) {
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
          localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ done: true }));
          localStorage.setItem('edgedesk_setup_v1', JSON.stringify({ done: true, at: '2026-01-01T00:00:00Z' }));
          localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        } catch (e) { /* storage */ }
      });
    }
    const foreign = [];
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      foreign.push(u);
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        if (/rpc\/slate_markets/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"entitled":false,"events":[]}' });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    if (o.time) await page.clock.install({ time: o.time });
    await page.goto(base + url, { waitUntil: 'load' });
    return { ctx, page, errors, foreign };
  }
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 900 };
  /* the site's own fonts, analytics tag and anonymous visit counter (lib/edgedesk_public.js), as on /performance/; no other door */
  const sameOrigin = (foreign) => foreign.every((u) => /fonts\.(googleapis|gstatic)\.com|googletagmanager\.com|\/rest\/v1\/rpc\/acq_track_visit$/.test(u));

  try {
    /* ── DASHBOARD: the committed files (insufficient data) ─────────────── */
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      M.grades = 'committed';
      const { ctx, page, errors, foreign } = await open(vp, '/performance/grades/');
      await page.waitForFunction(() => !/Loading/.test((document.getElementById('gp-status') || {}).innerText || ''), null, { timeout: 15000 });
      await page.waitForSelector('#gp-cmp tbody tr', { timeout: 15000 });
      await shot(page, 'grades-committed-' + label);
      const st = await text(page, '#gp-status');
      chk(label + ': the committed record says Insufficient Historical Data, honestly', /Insufficient Historical Data/.test(st) && /no grade is claimed to predict/i.test(st), st);
      chk(label + ': headline tiles: eligible games, graded games, distribution, coverage, period', await page.$$eval('#gp-headline .stat', (e) => e.length) === 5);
      chk(label + ': the grade table lists A–F and Not graded', await page.$$eval('#gp-cmp tbody tr', (e) => e.length) === 6);
      chk(label + ': no rate is printed from nothing (every Brier cell says none or needs 20)', /none|needs 20/.test(await text(page, '#gp-cmp')) && !/\b0\.\d{3}\b/.test(await text(page, '#gp-cmp')));
      chk(label + ': the ordering statement claims nothing', /No evidence yet/.test(await text(page, '#gp-order')));
      chk(label + ': charts say why they are empty', /No started game/.test(await text(page, '#gp-dist')) && /Too few/.test(await text(page, '#gp-cal')));
      const meth = await text(page, '#method');
      chk(label + ': the method: weights, caps, letters, missing data, limits, Research not picks', /30/.test(meth) && /capped at C/.test(meth) && /A 90–100, B 80–89, C 70–79, D 60–69, F below 60/.test(meth) && /Nothing missing earns credit/.test(meth) && /not betting profitability/i.test(meth) && /provisional/.test(meth));
      chk(label + ': "Research, not picks" and "not a betting recommendation" are said', /Research, not picks/.test(await text(page, 'body')) && /not a betting recommendation/.test(await text(page, '.lede')));
      chk(label + ': the main nav is the shared five; the footer links Grade performance', await page.$$eval('nav[aria-label="Main"] a', (a) => a.length) === 5 && !!(await page.$('footer nav a[href="/performance/grades/"]')));
      chk(label + ': no horizontal page scroll', await noHScroll(page));
      chk(label + ': no page error', errors.length === 0, errors);
      chk(label + ': reads only same-origin files (no database table, no third party but the site\'s fonts and analytics)', sameOrigin(foreign), foreign);
      await ctx.close();
    }

    /* ── DASHBOARD: a populated record ──────────────────────────────────── */
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      M.grades = 'populated';
      const { ctx, page, errors } = await open(vp, '/performance/grades/');
      await page.waitForSelector('#gp-dist svg', { timeout: 15000 });
      await shot(page, 'grades-populated-' + label);
      const st = await text(page, '#gp-status');
      chk(label + ': a record with 149 settled graded games leaves the insufficient state', !/Insufficient Historical Data/.test(st) && /149 completed games/.test(st), st);
      chk(label + ': the distribution draws a column per present grade (A, B, C, D, Not graded)', await page.$$eval('#gp-dist path.gp-bar', (e) => e.length) === 5);
      const cmp = await text(page, '#gp-cmp');
      const aB = POP.summary.overall.by_letter.A;
      chk(label + ': the A row prints its Brier with its 95% interval, from the same kernel', cmp.indexOf(aB.brier_ci.mean.toFixed(3)) >= 0 && cmp.indexOf(aB.brier_ci.low.toFixed(3)) >= 0, { want: aB.brier_ci, cmp: cmp.slice(0, 400) });
      chk(label + ': the D row (4 games) prints counts, not a rate', /needs 20/.test(await page.$eval('#gp-cmp tbody tr:nth-child(4)', (e) => e.innerText)));
      chk(label + ': against the spread and over/under come only from sides saved pregame', /\d+-\d+/.test(await page.$eval('#gp-cmp tbody tr:nth-child(1)', (e) => e.innerText)));
      chk(label + ': the A vs B gap is reported as evidence only because its interval excludes zero', /excludes zero/.test(await text(page, '#gp-order')) && /A vs B/.test(await text(page, '#gp-order')), await text(page, '#gp-order'));
      chk(label + ': Brier by grade: a dot and an interval for A, B and C', await page.$$eval('#gp-brier circle.gp-dot', (e) => e.length) === 3 && await page.$$eval('#gp-brier line.gp-ci', (e) => e.length) === 2);
      chk(label + ': calibration draws a panel per grade, with dots where 20 games stand behind it', await page.$$eval('#gp-cal figure', (e) => e.length) === 5 && await page.$$eval('#gp-cal circle.gp-dot', (e) => e.length) >= 3);
      chk(label + ': every chart has a table view', await page.$$eval('.gp-chart details.gp-twin', (e) => e.length) >= 5);
      chk(label + ': no horizontal page scroll', await noHScroll(page));
      /* filters scope everything */
      await page.selectOption('#gp-sport', 'cfb');
      const t2 = await text(page, '#gp-filtered');
      chk(label + ': the sport filter re-scopes every figure (college football only)', /Games in this selection\s*45/i.test(t2), t2.slice(0, 200));
      await page.selectOption('#gp-sport', 'all');
      await page.selectOption('#gp-market', 'ats');
      chk(label + ': the market type filter keeps only games with a side saved pregame', /Games in this selection\s*150/i.test(await text(page, '#gp-filtered')));
      await page.selectOption('#gp-market', 'all');
      await page.fill('#gp-from', '2027-06-01');
      chk(label + ': a date range past the record empties it, honestly', /Games in this selection\s*0\b/i.test(await text(page, '#gp-filtered')) && /No started game/.test(await text(page, '#gp-dist')));
      await page.fill('#gp-from', '');
      /* tooltips on hover and on keyboard focus */
      if (label === 'desktop') {
        await page.hover('#gp-dist path.gp-bar');
        const tip = await page.$eval('.gp-tip', (e) => ({ hidden: e.hidden, t: e.textContent }));
        chk('desktop: hovering a column shows its grade, count and share', !tip.hidden && /^A: 60 games \(\d+%\)$/.test(tip.t), tip);
        await page.mouse.move(1, 1);
        await page.focus('#gp-brier circle.gp-dot');
        const tip2 = await page.$eval('.gp-tip', (e) => ({ hidden: e.hidden, t: e.textContent }));
        chk('desktop: keyboard focus on a dot shows the same tooltip (value, interval, n)', !tip2.hidden && /Grade A: 0\.\d+ \(95% interval/.test(tip2.t) && /n=60/.test(tip2.t), tip2);
      }
      chk(label + ': no page error', errors.length === 0, errors);
      await ctx.close();
    }

    /* ── DASHBOARD: a failed load ───────────────────────────────────────── */
    M.grades = 'down';
    {
      const { ctx, page, errors } = await open(DESK, '/performance/grades/');
      await page.waitForFunction(() => /could not load/.test((document.getElementById('gp-status') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
      chk('a failed load says so and shows no stale or partial record', /could not load/.test(await text(page, '#gp-status')) && !(await page.$('#gp-cmp tbody')));
      chk('a failed load throws no page error', errors.length === 0, errors);
      await ctx.close();
    }
    M.grades = 'committed';

    /* ── TERMINAL: badges, the letter filter, the Grade Breakdown ───────── */
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      reads.length = 0;
      const { ctx, page, errors } = await open(vp, '/app.html#games', { app: true, time: SF.NOW });
      await page.waitForSelector('#gamesPage .gm-card[data-id]', { timeout: 20000 });
      await page.waitForSelector('#gamesPage .edg-badge', { timeout: 15000 });
      await shot(page, 'terminal-games-' + label);
      const badges = await page.$$eval('#gamesPage .gm-card[data-id]', (els) => els.map((e) => ({ id: e.getAttribute('data-id'), b: (e.querySelector('.edg-badge b') || {}).textContent || null, title: (e.querySelector('.edg-badge') || { getAttribute: () => '' }).getAttribute('title') })));
      const nhl = badges.find((x) => x.id === 'nhl:espn:401802002');
      chk(label + ': a graded game carries its letter (A)', nhl && nhl.b === 'A', badges.slice(0, 6));
      chk(label + ': the badge says what it is and is not (not a win probability, not a betting recommendation)', nhl && /not a win probability/.test(nhl.title) && /not a betting recommendation/.test(nhl.title) && /Research, not picks/.test(nhl.title));
      chk(label + ': a game the grade does not cover shows no badge (MLB)', badges.filter((x) => /^mlb:/.test(x.id)).every((x) => !x.b));
      const cfb = badges.find((x) => x.id === 'cfb:espn:401871067');
      chk(label + ': a capped grade says its cap in the tooltip', cfb && cfb.b === 'C' && /capped at C/.test(cfb.title), cfb);
      chk(label + ': the letter filter is on the page', !!(await page.$('#gamesPage [data-gm-grade="A"]')));
      await page.click('#gamesPage [data-gm-grade="A"]');
      const vis = await page.$$eval('#gamesPage .gm-sec .gm-card[data-id]', (els) => els.map((e) => e.getAttribute('data-id')));
      chk(label + ': filtering to A leaves only the A game', vis.length === 1 && vis[0] === 'nhl:espn:401802002', vis);
      await page.click('#gamesPage [data-gm-grade="F"]');
      chk(label + ': a letter no game has says so, with a way back', /has research grade F/.test(await text(page, '#gamesPage')) && !!(await page.$('#gamesPage .gm-empty [data-gm-grade="all"]')));
      await page.click('#gamesPage .gm-empty [data-gm-grade="all"]');
      chk(label + ': back to every grade', (await page.$$eval('#gamesPage .gm-sec .gm-card[data-id]', (e) => e.length)) > 3);
      await page.click('#gamesPage .gm-card[data-id="nhl:espn:401802002"] [data-gm-detail]');
      await page.waitForSelector('#gmDetail .edg-bd', { timeout: 10000 });
      await page.click('#gmDetail .edg-bd > summary');
      await page.waitForFunction(() => /Live pregame record/.test((document.querySelector('#gmDetail .edg-bd') || {}).innerText || ''), null, { timeout: 10000 }).catch(() => {});
      const bd = await text(page, '#gmDetail .edg-bd');
      chk(label + ': the matchup view opens a Grade Breakdown with all five parts', /Grade Breakdown/.test(bd) && ['Model reliability', 'Data completeness', 'Model–market comparison', 'Matchup clarity', 'Uncertainty'].every((w) => bd.indexOf(w) >= 0), bd.slice(0, 400));
      chk(label + ': each part names its sub-factors and reasons, missing ones as missing', /50 are needed before its record counts/.test(bd) && /unvalidated/.test(bd) && /starting goalies: projected uncertain/.test(bd), bd.slice(0, 900));
      chk(label + ': the breakdown carries the versions, the time and "provisional"', /grade rg_v1/.test(bd) && /provisional/.test(bd) && /pregame data only/.test(bd));
      chk(label + ': the grade history before kickoff is shown', /Grade history before kickoff/.test(bd) && /B ·/.test(bd));
      chk(label + ': no horizontal page scroll with the breakdown open', await noHScroll(page));
      chk(label + ': the terminal read the grade files', reads.indexOf('/performance/data/grades/live.json') >= 0 && reads.indexOf('/performance/data/grades/live_detail.json') >= 0);
      chk(label + ': no page error', errors.length === 0, errors);
      await ctx.close();
    }

    /* ── PUBLIC: /today/ shows no grade and reads no grade file ──────────── */
    {
      reads.length = 0;
      const { ctx, page, errors } = await open(PHONE, '/today/', { time: SF.NOW });
      await page.waitForSelector('.gm-card[data-id]', { timeout: 20000 });
      chk('/today/: no grade badge on the free page', (await page.$$('.edg-badge')).length === 0);
      chk('/today/: the free page never reads the grade files', !reads.some((p) => /\/performance\/data\/grades\//.test(p)), reads.filter((p) => /grades/.test(p)));
      chk('/today/: no page error', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 1200));
  } finally {
    await browser.close();
    srv.close();
  }
  done();
})();
