#!/usr/bin/env node
/* ===========================================================================
   THE EDGE P&L ON THE PAGES, FED BY THE REAL DATABASE.

   The fixture (tools/record/pnl_grades_fixture.js, TEST DATA) goes through
   production's migrations and the three pnl_grades files into a throwaway
   PostgreSQL. The rows the pages read are then exactly what pnl_summary,
   pnl_grades and pnl_reconciliation() answer there, served to Chromium in
   place of Supabase. So every number on screen is checked against SQL, not
   against a second implementation in the test.

   KERNEL (Node): lib/edgedesk_edge_pnl.js — units and ROI formatting, the
     rollups (push risked, void not, PASS not a bet, UNLABELLED in All only),
     the cumulative series, month by month.
   record.html #edge-pnl at 375 / 768 / 1440 px: the method note verbatim; All,
     BET and LEAN units, ROI and W-L-P equal SQL for the current sports; the
     counts of what is not in the P&L equal SQL; retired sports only in the
     archive view; the sport filter; the chart draws, its legend ends where
     the units are, and hover names the day; no sideways scroll; no page
     error; and an honest message when the views are not deployed.
   app.html Records: every graded row's P&L is its pnl_grades row (or none,
     with the reason); the receipt names the board's BET/LEAN at the flag;
     Pipeline health shows the reconciliation; and before the migration the
     fallback uses the flag price only (never first_best_dec).

   Needs Playwright + Chromium and a PostgreSQL binary; prints SKIPPED for a
   layer it cannot run. Run: node tools/record/edge_pnl_ui.test.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const E = require(path.join(ROOT, 'lib', 'edgedesk_edge_pnl.js'));
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const FX = require('./pnl_grades_fixture.js');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : ''));
}
const near = (a, b, eps) => a != null && b != null && Math.abs(Number(a) - Number(b)) < (eps || 1e-9);

/* ================================================================ KERNEL */
chk('units: +0.91u, −1.00u, 0.00u, never −0.00u', E.fmtUnits(0.909) === '+0.91u' && E.fmtUnits(-1) === '−1.00u' && E.fmtUnits(0) === '0.00u' && E.fmtUnits(-0.001) === '0.00u');
chk('ROI: one decimal, signed', E.fmtPct(4.56) === '+4.6%' && E.fmtPct(-12.04) === '−12.0%' && E.fmtPct(null) === '—');
chk('the method note is the one the page promises', E.METHOD === '1 unit flat stake at the price when flagged. Pushes = 0. Missing prices are not estimated.');
const R = (sport, verdict, o) => Object.assign({ sport_key: sport, sport_title: sport.toUpperCase(), verdict, flags: 0, graded: 0, wins: 0, losses: 0, pushes: 0, units_risked: 0, units_won: 0,
  graded_with_close: 0, units_risked_at_close: 0, units_won_at_close: 0, void: 0, ungraded_missing_price: 0, ungraded_unsettled: 0, ungraded_unsupported: 0, not_a_bet: 0 }, o);
const ROWS = [
  R('nfl', 'BET', { flags: 5, graded: 3, wins: 1, losses: 1, pushes: 1, units_risked: 3, units_won: 0.5, void: 1, ungraded_missing_price: 1, graded_with_close: 2, units_risked_at_close: 2, units_won_at_close: -0.2 }),
  R('nfl', 'LEAN', { flags: 4, graded: 4, wins: 3, losses: 1, units_risked: 4, units_won: 1.6 }),
  R('nfl', 'PASS', { flags: 2, not_a_bet: 2 }),
  R('nfl', 'ALL', { flags: 11, graded: 7, units_won: 2.1, units_risked: 7 }),
  R('mlb', 'UNLABELLED', { flags: 2, graded: 2, wins: 1, losses: 1, units_risked: 2, units_won: 0.1, ungraded_unsettled: 0 }),
  R('mlb', 'LEAN', { flags: 3, graded: 2, losses: 2, units_risked: 2, units_won: -2, ungraded_unsettled: 1 })
];
const A = E.aggregate(ROWS, '');
chk('All = BET + LEAN + UNLABELLED (the ALL rollup row is not double-counted)', A.ALL.graded === 11 && near(A.ALL.units_won, 0.2) && A.ALL.units_risked === 11, A.ALL);
chk('a push is 1u risked and returned: BET 1-1-1 on 3u risked, ROI 16.7%', A.BET.pushes === 1 && A.BET.units_risked === 3 && near(A.BET.roi_pct, 100 * 0.5 / 3));
chk('UNLABELLED is in All and in neither BET nor LEAN', A.LEAN.graded === 6 && A.UNLABELLED.graded === 2);
chk('counts: void, missing price, unsettled, PASS — never in units', A.counts.void === 1 && A.counts.missing_price === 1 && A.counts.unsettled === 1 && A.counts.not_a_bet === 2);
chk('the at-close comparison is its own ROI', near(A.BET.roi_at_close_pct, -10));
chk('one sport', E.aggregate(ROWS, 'mlb').ALL.graded === 4 && near(E.aggregate(ROWS, 'mlb').ALL.units_won, -1.9));
chk('sports: most graded first, ALL rows ignored', JSON.stringify(E.sports(ROWS).map((s) => s.key)) === '["nfl","mlb"]');
const S = E.series([
  { period_start: '2026-09-02', sport_key: 'nfl', verdict: 'BET', graded: 1, units_won: 1 },
  { period_start: '2026-09-01', sport_key: 'nfl', verdict: 'LEAN', graded: 2, units_won: -1 },
  { period_start: '2026-09-02', sport_key: 'mlb', verdict: 'UNLABELLED', graded: 1, units_won: 0.5 },
  { period_start: '2026-09-03', sport_key: 'nfl', verdict: 'PASS', graded: 0, units_won: 0 }], '');
chk('series: by date, cumulative, All includes UNLABELLED, PASS ignored', JSON.stringify(S.dates) === '["2026-09-01","2026-09-02"]' && near(S.ALL[1], 0.5) && near(S.BET[1], 1) && near(S.LEAN[1], -1) && S.has.BET && S.has.LEAN);
chk('headline says up / down / too few in plain words', /up <b class="pos">0\.20u<\/b>/.test(E.headline(A)) && /too few/.test(E.headline(A)) && /down/.test(E.headline(E.aggregate(ROWS, 'mlb'))));

/* ============================================================== DATABASE */
async function main() {
  const db = PG.start('edgepnlui');
  if (db.skip) { console.log('SKIPPED (live layers): ' + db.skip); return; }
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  const qj = (sql) => JSON.parse(db.sql('select coalesce(json_agg(t), \'[]\') from (' + sql + ') t') || '[]');
  let D;
  try {
    FX.install(db, PG);
    const F = 'flags,graded,wins,losses,pushes,units_risked,units_won,graded_with_close,units_risked_at_close,units_won_at_close,void,ungraded_missing_price,ungraded_unsettled,ungraded_unsupported,not_a_bet';
    D = {
      all: qj(`select sport_key, sport_title, verdict, ${F} from public.pnl_summary where period_type = 'all' and market_type = 'ALL' and sport_key <> 'ALL' and verdict <> 'ALL' order by sport_key, verdict`),
      day: qj(`select period_start, sport_key, verdict, graded, units_won from public.pnl_summary where period_type = 'day' and market_type = 'ALL' and sport_key <> 'ALL' and verdict <> 'ALL' and graded > 0 order by period_start, sport_key, verdict`),
      month: qj(`select period_start, sport_key, verdict, ${F} from public.pnl_summary where period_type = 'month' and market_type = 'ALL' and sport_key <> 'ALL' and verdict <> 'ALL' order by period_start, sport_key, verdict`),
      grades: qj(`select sig_key, verdict, verdict_reason, pnl_status, pnl_reason, pnl_units, pnl_units_at_close, price_at_flag_american, calc_version from public.pnl_grades where settled_at is not null order by sig_key`),
      recon: qj(`select * from public.pnl_reconciliation()`),
      signals: qj(`select * from public.signals where graded_at is not null and flagged_at is not null order by graded_at`),
      /* the truth the page must print, straight from pnl_grades (current sports = not tennis) */
      truth: (cond) => qj(`select verdict, count(*) filter (where pnl_status = 'graded') g, coalesce(sum(pnl_units), 0) u,
          count(*) filter (where pnl_status = 'graded' and result = 'win') w, count(*) filter (where pnl_status = 'graded' and result = 'loss') l,
          count(*) filter (where pnl_status = 'graded' and result = 'push') p from public.pnl_grades
        where (settled_at is not null or event_at <= now()) and ${cond} group by grouping sets ((verdict), ())`),
      counts: (cond) => qj(`select count(*) filter (where pnl_status = 'void') void, count(*) filter (where pnl_status = 'ungraded_missing_price') mp,
          count(*) filter (where pnl_status = 'ungraded_unsettled') un, count(*) filter (where pnl_status = 'ungraded_unsupported') us,
          count(*) filter (where pnl_status = 'not_a_bet') nb from public.pnl_grades where (settled_at is not null or event_at <= now()) and ${cond}`)[0]
    };
    D.cur = D.truth(`sport_key not like 'tennis%'`); D.arc = D.truth('true'); D.nfl = D.truth(`sport_key = 'americanfootball_nfl'`);
    D.curCounts = D.counts(`sport_key not like 'tennis%'`);
  } finally { db.stop(); }
  chk('the database fed the pages: summary, day series, grades, reconciliation', D.all.length > 6 && D.day.length > 10 && D.grades.length > 30 && D.recon.every((r) => r.state === 'ok'), { all: D.all.length, day: D.day.length });
  if (!pw) { console.log('SKIPPED (browser layer): playwright is not installed here'); return; }

  const pick = (T, v) => T.find((r) => (v ? r.verdict === v : r.verdict == null)) || { g: 0, u: 0, w: 0, l: 0, p: 0 };
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/record.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED (browser layer): no Chromium'); srv.close(); return; }
  }
  /* Supabase, answered from the database above */
  function api(u, headers, mode) {
    const url = new URL(u), q = url.searchParams, off = +(q.get('offset') || 0), page = (rows) => (off ? [] : rows);
    const j = (body, h) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body),
      headers: Object.assign({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, h || {}) });
    if (/\/rest\/v1\/pnl_summary/.test(url.pathname)) {
      if (mode.noPnl) return { status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.pnl_summary' in the schema cache" }) };
      const pt = q.get('period_type');
      return j(page(pt === 'eq.all' ? D.all : pt === 'eq.day' ? D.day : pt === 'eq.month' ? D.month : []));
    }
    if (/\/rest\/v1\/pnl_grades/.test(url.pathname)) return mode.noPnl ? { status: 404, contentType: 'application/json', body: '{"code":"PGRST205"}' } : j(page(D.grades));
    if (/\/rest\/v1\/rpc\/pnl_reconciliation/.test(url.pathname)) return mode.noPnl ? { status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' } : j(D.recon);
    if (/\/rest\/v1\/subscriptions/.test(url.pathname)) return j([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]);
    if (/\/rest\/v1\/signals/.test(url.pathname)) {
      const sel = q.get('select') || '';
      if (/count=exact/.test(headers.prefer || '')) return j([], { 'content-range': '0-0/' + D.signals.length });
      if (/^id,sig_key,/.test(sel)) return j(page(D.signals));
      return j([]);
    }
    return j([]);
  }
  async function open(viewport, file, mode) {
    mode = mode || {};
    const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((o) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        if (o.session) localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* storage */ }
    }, mode);
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) return route.fulfill(api(u, route.request().headers(), mode));
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
    await page.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const shot = async (page, name, sel) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator(sel).first().screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const cardText = (page, i) => page.$$eval('#edpPub .edp-card', (els, k) => els[k].textContent.replace(/\s+/g, ' ').trim(), i);
  const wlp = (t) => t.w + '-' + t.l + '-' + t.p;

  try {
    /* ============================================ record.html, every width */
    for (const W of [375, 768, 1440]) {
      const { ctx, page, errors } = await open({ width: W, height: 1000 }, 'record.html');
      await page.waitForSelector('#edpPub .edp-cards', { timeout: 15000 });
      await page.waitForSelector('#edpPub .edp-svg', { timeout: 15000 });
      chk(W + 'px: the method note, verbatim', (await text(page, '#edpMethod')) === E.METHOD);
      const all = pick(D.cur), bet = pick(D.cur, 'BET'), lean = pick(D.cur, 'LEAN');
      const c0 = await cardText(page, 0), c1 = await cardText(page, 1), c2 = await cardText(page, 2);
      chk(W + 'px: All flagged bets = SQL (units, W-L-P, graded) for the current sports', c0.includes(E.fmtUnits(Number(all.u))) && c0.includes(wlp(all) + ' (W-L-P)') && c0.includes(all.g + ' graded'), { c0, all });
      chk(W + 'px: ROI = units ÷ units risked', c0.includes('ROI ' + E.fmtPct(100 * all.u / all.g)), c0);
      chk(W + 'px: BET = SQL', bet.g ? (c1.includes(E.fmtUnits(Number(bet.u))) && c1.includes(wlp(bet))) : /Nothing graded yet/.test(c1), { c1, bet });
      chk(W + 'px: LEAN = SQL', c2.includes(E.fmtUnits(Number(lean.u))) && c2.includes(wlp(lean)), { c2, lean });
      const counts = await text(page, '#edpPub .edp-counts');
      const k = D.curCounts;
      chk(W + 'px: what is not in the P&L, counted = SQL', counts.includes(k.void + ' void') && counts.includes(k.mp + ' settled without a price') && counts.includes(k.un + ' game played')
        && counts.includes(k.us + ' in a market') && counts.includes(k.nb + ' flagged, but the board showed PASS'), { counts, k });
      const unl = pick(D.cur, 'UNLABELLED');
      chk(W + 'px: earlier, unlabelled flags are named, not relabelled', !unl.g || (await text(page, '#edpPub [data-edp="cards"]')).includes(unl.g + ' graded flag'));
      chk(W + 'px: the retired sport is not in the default record', !(await text(page, '#edpPub [data-edp="chips"]')).includes('ATP'));
      const legend = await text(page, '#edpPub .edp-legend');
      chk(W + 'px: the chart\'s line ends where the units are', legend.includes('All flagged bets ' + E.fmtUnits(Number(all.u))), legend);
      chk(W + 'px: three lines, one axis, a break-even line', (await page.$$('#edpPub .edp-svg path')).length === 3 && (await page.$$('#edpPub .edp-zero')).length === 1);
      const hit = await page.$('#edpPub .edp-hit');
      await hit.scrollIntoViewIfNeeded();
      const hb = await hit.boundingBox();
      await page.mouse.move(hb.x + hb.width * 0.6, hb.y + hb.height / 2);
      const tip = await page.$eval('#edpPub .edp-tip', (el) => ({ shown: el.style.display !== 'none', t: el.textContent }));
      chk(W + 'px: hover names the day and each line', tip.shown && /2026/.test(tip.t) && /All flagged bets/.test(tip.t) && /settled/.test(tip.t), tip);
      const layout = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      chk(W + 'px: no sideways scroll', layout.sw <= layout.cw + 1, layout);
      await shot(page, 'edge-pnl-' + W, '#edge-pnl');
      /* the sport filter */
      await page.click('#edpPub [data-sport="americanfootball_nfl"]');
      const nfl = pick(D.nfl), cn = await cardText(page, 0);
      chk(W + 'px: the NFL filter shows the NFL numbers', cn.includes(E.fmtUnits(Number(nfl.u))) && cn.includes(wlp(nfl)), { cn, nfl });
      await page.click('#edpPub [data-sport=""]');
      chk(W + 'px: back to all sports', (await cardText(page, 0)).includes(E.fmtUnits(Number(all.u))));
      await page.click('#edpPub .edp-tbl summary');
      chk(W + 'px: month by month, as a table', (await page.$$('#edpPub .edp-t tbody tr')).length >= 1);
      chk(W + 'px: no page error', errors.length === 0, errors);
      await ctx.close();
    }
    /* the archive view includes the retired sport */
    {
      const { ctx, page, errors } = await open({ width: 1200, height: 900 }, 'record.html?archive=1');
      await page.waitForSelector('#edpPub .edp-cards', { timeout: 15000 });
      const arc = pick(D.arc);
      chk('archive: every sport, tennis included', (await cardText(page, 0)).includes(E.fmtUnits(Number(arc.u))) && (await text(page, '#edpPub [data-edp="chips"]')).includes('ATP'), arc);
      chk('archive: no page error', errors.length === 0, errors);
      await ctx.close();
    }
    /* before the migration: an honest message, nothing made up */
    {
      const { ctx, page, errors } = await open({ width: 1200, height: 900 }, 'record.html', { noPnl: true });
      await page.waitForFunction(() => /not deployed/.test((document.querySelector('#edpPub') || {}).textContent || ''), null, { timeout: 15000 });
      chk('not deployed: says so, shows no number', !(await page.$('#edpPub .edp-card')) && /Nothing is shown rather than something made up/.test(await text(page, '#edpPub')));
      chk('not deployed: the rest of the page is untouched (no page error)', errors.length === 0, errors);
      await ctx.close();
    }

    /* ============================================ app.html, Records → edges */
    const gradeBy = {}; D.grades.forEach((g) => { gradeBy[g.sig_key] = g; });
    {
      const { ctx, page, errors } = await open({ width: 1440, height: 1000 }, 'app.html', { session: true });
      await page.waitForFunction(() => typeof show === 'function' && typeof recBook === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); recBook('edges'); });
      try { await page.waitForFunction(() => window.REC && REC.loaded && REC.rows.length > 0, null, { timeout: 20000 }); }
      catch (e) { console.log('  app state:', await page.evaluate(() => JSON.stringify({ loaded: REC.loaded, loading: REC.loading, n: REC.rows.length, pool: REC.pool, count: (document.getElementById('recCount') || {}).textContent, note: ((document.getElementById('recPoolNote') || {}).textContent || '').slice(0, 300) })), errors); throw e; }
      const rows = await page.evaluate(() => ({ live: REC.pnlLive, rows: REC.rows.map((r) => ({ k: r.sig_key, p: r._profit, why: recPnlWhy(r) })) }));
      chk('app: the P&L table was read', rows.live === true);
      const off = rows.rows.filter((r) => { const g = gradeBy[r.k]; return g && g.pnl_status === 'graded' ? !near(r.p, g.pnl_units) : r.p !== null; });
      chk('app: every graded record\'s P&L is its pnl_grades row (' + rows.rows.length + ' rows)', rows.rows.length > 20 && off.length === 0, off.slice(0, 3));
      chk('app: a record with no P&L says why (void / no flag price / PASS)', rows.rows.some((r) => /void/.test(r.why)) && rows.rows.some((r) => /no price frozen at the flag/.test(r.why)));
      chk('app: the column is P&L, not a simulation', /P&L/.test(await text(page, '#recTbl thead')) && !/Sim P\/L/.test(await page.content()));
      const det = await page.evaluate(() => { const r = REC.rows.find((x) => x._pnl && x._pnl.pnl_status === 'graded'); return recDetailHTML(r); });
      chk('app: the receipt names the board\'s BET/LEAN at the flag, the P&L and the close comparison', /board said at flag/.test(det) && /<b>(BET|LEAN|UNLABELLED)<\/b>/.test(det) && /1u at flag price/.test(det) && /comparison only/.test(det));
      await page.evaluate(() => recPipelineHealth());
      await page.waitForFunction(() => /p&l/.test((document.getElementById('recHealth') || {}).textContent || ''), null, { timeout: 15000 });
      const hl = await text(page, '#recHealth');
      chk('app: Pipeline health shows the reconciliation: 0 settled flags without a P&L row', /p&l\s*0 missing/.test(hl) && /every settled flag carries its P&L/.test(hl), hl);
      await shot(page, 'app-records-health', '#recHealth');
      chk('app: no page error', errors.length === 0, errors);
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 1440, height: 1000 }, 'app.html', { session: true, noPnl: true });
      await page.waitForFunction(() => typeof show === 'function' && typeof recBook === 'function', null, { timeout: 20000 });
      await page.evaluate(() => { show('record'); recBook('edges'); });
      await page.waitForFunction(() => window.REC && REC.loaded && REC.rows.length > 0, null, { timeout: 20000 });
      const fb = await page.evaluate(() => ({ live: REC.pnlLive, rows: REC.rows.map((r) => ({ p: r._profit, dec: r.flagged_best_dec, first: r.first_best_dec, res: r.result })) }));
      chk('fallback: the P&L table is not there, and the page says so', fb.live === false);
      chk('fallback: a record with no flag price has no P&L (first_best_dec is never used)', fb.rows.filter((r) => !(r.dec > 1)).every((r) => r.p === null) && fb.rows.some((r) => !(r.dec > 1) && r.first > 1));
      chk('fallback: a void is not a bet; a win at the flag price pays price − 1', fb.rows.filter((r) => r.res === 'void').every((r) => r.p === null)
        && fb.rows.filter((r) => r.res === 'win' && r.dec > 1).every((r) => near(r.p, r.dec - 1)));
      chk('fallback: Pipeline health says not deployed', await page.evaluate(() => recPipelineHealth().then(() => /p&l\s*not deployed/.test(document.getElementById('recHealth').textContent))));
      chk('fallback: no page error', errors.length === 0, errors);
      await ctx.close();
    }
  } finally {
    await browser.close(); srv.close();
  }
}

main().catch((e) => { chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 1200)); }).then(() => {
  console.log((fail === 0 ? 'ALL GREEN' : 'FAILED') + ' edge P&L UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
});
