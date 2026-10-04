#!/usr/bin/env node
/* ===========================================================================
   THE FLAGGED-EDGE P&L, ON THE PAGE, IN A REAL BROWSER.

   The data is not hand-written for the page. A real PostgreSQL is seeded with
   the TEST history in tools/record/signal_pnl_fixture.js, the three migration
   files are applied, the backfill is committed, and the page is then served
   exactly what the database returns to an anonymous reader (pnl_summary,
   pnl_grades, pnl_reconciliation) — RLS and all. So a number on the page is
   checked against the database, not against a copy of the page's own maths.

   record.html (public, #edge-pnl) at 375 / 390 / 430 / 768 / 1440 px:
     the hero is the database's all-sports units (the retired sport left out,
     as the CLV record does); the sport chips filter every number; Tier A and
     Tier B side by side with their own units; the running-total chart draws,
     hovers and reads on the keyboard; the not-counted counts and the method
     note; no sideways scroll, no page error. Then ?archive=1, the
     not-deployed state and the empty state.
   app.html (Records → the bets table, Pipeline health) at 390 / 1440 px:
     every graded row carries its recorded P&L; the column and the
     simulated one are told apart; the P&L sync row reads 0 missing.

   Needs PostgreSQL and Playwright with Chromium; prints SKIPPED without them
   (fails instead when PNL_UI_REQUIRED=1).
   Run: node tools/record/signal_pnl_ui.test.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const FX = require('./signal_pnl_fixture.js');
const ROOT = PG.ROOT;
const P = require(path.join(ROOT, 'lib', 'edgedesk_edge_pnl.js'));
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const REQUIRED = process.env.PNL_UI_REQUIRED === '1';

const T = PG.kit('flagged-edge P&L in the browser');
const chk = T.chk;
function skip(why) {
  if (REQUIRED) { chk(why, false); process.exit(T.done()); }
  console.log('SKIPPED: ' + why); process.exit(0);
}

let pw = null;
try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
if (!pw) skip('playwright is not installed here');

/* ── the database, as an anonymous reader sees it ─────────────────────── */
const db = PG.start('edgepnlui');
if (db.skip) skip(db.skip);
const q = (sql, as) => JSON.parse((as || db.sql.bind(db))("select coalesce(json_agg(t), '[]'::json) from (" + sql + ") t;"));
const anon = (sql) => q(sql, db.anon.bind(db));
let D;
try {
  const NOW = Date.now();
  if (!FX.buildSchema(db)) throw new Error('signals schema did not build');
  db.sql(FX.insertSql(FX.signals({ now: NOW }), PG.lit));
  [FX.FILES.core, FX.FILES.summary, FX.FILES.sync].forEach((f) => db.applyFileAtomic(f));
  db.sql('select * from public.pnl_backfill(true);');
  const COLS = 'grain,breakdown,sport_key,sport_title,tier,market_type,flags,graded,wins,losses,pushes,voids,ungraded_missing_price,ungraded_unsettled,outside_edge_band,'
    + 'units_won,units_risked,close_compared,units_won_at_close,units_won_flag_compared,units_risked_compared,first_game_date,last_game_date,last_computed_at';
  const cur = "sport_key not like 'tennis%'";
  D = {
    all: anon(`select ${COLS} from public.pnl_summary where grain = 'all' and sport_key is not null order by sport_key`),
    day: anon("select period_start, sport_key, tier, graded, units_won from public.pnl_summary where grain = 'day' and breakdown = 'sport+tier' order by period_start"),
    grades: anon('select sig_key, pnl_status, ungraded_reason, pnl_units, pnl_units_at_close, price_at_flag, calc_version from public.pnl_grades order by sig_key'),
    recon: JSON.parse(db.anon('select public.pnl_reconciliation();')),
    /* the Records tab reads signals itself (a signed-in subscriber) */
    signals: q('select to_jsonb(s) j from public.signals s where s.graded_at is not null and s.flagged_at is not null order by s.graded_at').map((r) => r.j),
    /* what the page should say, straight from SQL */
    cur: anon(`select coalesce(sum(units_won), 0) u, coalesce(sum(graded), 0) n, coalesce(sum(wins), 0) w, coalesce(sum(losses), 0) l, coalesce(sum(pushes), 0) p,
      coalesce(sum(voids), 0) v, coalesce(sum(ungraded_missing_price), 0) m, coalesce(sum(ungraded_unsettled), 0) un, coalesce(sum(outside_edge_band), 0) o
      from public.pnl_summary where grain = 'all' and breakdown = 'sport' and ${cur}`)[0],
    curTier: anon(`select tier, sum(units_won) u, sum(graded) n from public.pnl_summary where grain = 'all' and breakdown = 'sport+tier' and ${cur} group by tier`),
    nfl: anon("select units_won u, graded n from public.pnl_summary where grain = 'all' and breakdown = 'sport' and sport_key = 'americanfootball_nfl'")[0],
    every: anon("select coalesce(sum(units_won), 0) u, coalesce(sum(graded), 0) n from public.pnl_summary where grain = 'all' and breakdown = 'sport'")[0]
  };
} catch (e) {
  chk('the database is seeded and backfilled', false, String(e.message).slice(0, 600));
} finally {
  db.stop();
}
if (!D) process.exit(T.done());
chk('the fixture graded enough bets to draw (test data)', D.cur.n >= 100 && D.day.length > 20, [D.cur.n, D.day.length]);
chk('the anonymous reconciliation is green', D.recon.ok === true, D.recon);

/* ── a PostgREST stand-in that answers with the rows above ─────────────── */
function page(rows, url) {
  const off = +(url.searchParams.get('offset') || 0), lim = +(url.searchParams.get('limit') || 1000);
  return rows.slice(off, off + lim);
}
let mode = 'live';
function answer(u) {
  const url = new URL(u), p = url.pathname.replace(/^\/rest\/v1\//, '');
  const json = (body, status, headers) => ({ status: status || 200, contentType: 'application/json',
    headers: Object.assign({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, headers || {}), body: JSON.stringify(body) });
  if (p === 'pnl_summary') {
    if (mode === 'missing') return json({ code: 'PGRST205', message: "Could not find the table 'public.pnl_summary' in the schema cache" }, 404);
    if (mode === 'empty') return json([]);
    return json(page(url.searchParams.get('grain') === 'eq.day' ? D.day : D.all, url));
  }
  if (p === 'pnl_grades') return mode === 'missing' ? json({ code: 'PGRST205', message: "Could not find the table 'public.pnl_grades' in the schema cache" }, 404) : json(page(D.grades, url));
  if (p === 'rpc/pnl_reconciliation') return mode === 'missing' ? json({ code: 'PGRST202', message: 'Could not find the function public.pnl_reconciliation' }, 404) : json(D.recon);
  if (p === 'signals') {
    if (/id/.test(url.searchParams.get('select') || '') && url.searchParams.get('limit') === '1' && !url.searchParams.get('order')) {
      return json([], 200, { 'content-range': '0-0/' + D.signals.length });
    }
    const ord = url.searchParams.get('order') || '';
    if (/\.desc$/.test(ord) && url.searchParams.get('limit') === '1') {
      const col = ord.replace(/\.desc$/, ''), r = D.signals.slice().sort((a, b) => String(b[col] || '').localeCompare(String(a[col] || '')))[0];
      return json(r ? [r] : []);
    }
    return json(page(D.signals, url));
  }
  if (/subscriptions/.test(p)) return json([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]);
  return json([]);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function site(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/record.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}

(async function main() {
  const srv = await new Promise((resolve) => { const s = http.createServer(site); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { srv.close(); skip('no Chromium'); }
  }
  async function open(viewport, file, opt) {
    opt = opt || {};
    const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((o) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        if (o.session) localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* storage */ }
    }, opt);
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co\/rest\/v1\//.test(u)) return route.fulfill(answer(u));
      if (/supabase\.co/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return route.fulfill({ status: 204, body: '' });
    });
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.goto(`http://127.0.0.1:${port}/${file}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page: pg, errors };
  }
  const text = (pg, sel) => pg.$eval(sel, (el) => el.textContent.replace(/\s+/g, ' ').trim());
  const shot = async (pg, name, sel) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await pg.locator(sel).first().screenshot({ path: path.join(SHOTS, name + '.png') });
  };
  const layout = (pg, sel) => pg.evaluate((s) => {
    const vw = document.documentElement.clientWidth, root = document.querySelector(s), wide = [];
    root.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect(); if (!(r.width > 0) || r.right <= vw + 1) return;
      let p = el.parentElement, contained = false;
      while (p && p !== root.parentElement) { if (/(auto|scroll|hidden)/.test(getComputedStyle(p).overflowX) && p.getBoundingClientRect().right <= vw + 1) { contained = true; break; } p = p.parentElement; }
      if (!contained && wide.length < 5) wide.push(el.tagName + '.' + el.className + ' ' + Math.round(r.right));
    });
    const small = [];
    root.querySelectorAll('.edp2-chip').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.height < 40) small.push(el.textContent + ' ' + Math.round(r.height)); });
    return { wide, small, page: document.documentElement.scrollWidth > vw + 1 };
  }, sel);
  const tierU = (k) => { const r = D.curTier.find((x) => x.tier === k); return r ? Number(r.u) : null; };

  try {
    /* ============================================ record.html, every width */
    for (const W of [375, 390, 430, 768, 1440]) {
      mode = 'live';
      const { ctx, page: pg, errors } = await open({ width: W, height: 900 }, 'record.html');
      await pg.waitForSelector('#edgePnl .edp2-hero', { timeout: 15000 });
      const hero = await text(pg, '#edgePnl .edp2-big');
      chk(W + 'px: the hero is the database\'s units for the current sports', hero === P.fmtUnits(D.cur.u), [hero, D.cur.u]);
      chk(W + 'px: it says it in a sentence anyone can read', /If you had bet 1 unit on every edge EdgeDesk flagged, at the price on the screen when it was flagged, you would be (up|down) \d+\.\d\d units after \d+ bets\./.test(await text(pg, '#edgePnl .edp2-say')));
      const kpis = await text(pg, '#edgePnl .edp2-kpis');
      chk(W + 'px: ROI, W–L–P and bets graded are the database\'s', kpis.indexOf(D.cur.w + '–' + D.cur.l + '–' + D.cur.p) >= 0 && kpis.indexOf(String(D.cur.n)) >= 0
        && kpis.indexOf(P.fmtPct(D.cur.u / (D.cur.w + D.cur.l) * 100)) >= 0, kpis);
      const chips = await pg.$$eval('#edgePnl .edp2-chip', (els) => els.map((e) => e.firstChild.textContent));
      chk(W + 'px: a chip per current sport, the retired one left out', chips.join(',') === 'All sports,NFL,NCAAF,MLB' || (chips[0] === 'All sports' && chips.length === 4 && chips.indexOf('ATP US Open') < 0), chips);
      chk(W + 'px: Tier A and Tier B side by side (and the older flags)', !!(await pg.$('#edgePnl .edp2-tier.t-A')) && !!(await pg.$('#edgePnl .edp2-tier.t-B')) && !!(await pg.$('#edgePnl .edp2-tier.t-legacy')));
      chk(W + 'px: each tier\'s units are its own', (await text(pg, '#edgePnl .t-A .edp2-tn')) === P.fmtUnits(tierU('A')) && (await text(pg, '#edgePnl .t-B .edp2-tn')) === P.fmtUnits(tierU('B')));
      chk(W + 'px: each tier says what it means in plain words', /sharpest book/.test(await text(pg, '#edgePnl .t-A')) && /other books/.test(await text(pg, '#edgePnl .t-B')));
      chk(W + 'px: the chart draws a line per series, with a legend for each', (await pg.$$('#edgePnl .edp2-line')).length === 4 && (await pg.$$('#edgePnl .edp2-legend span')).length === 4);
      await pg.$eval('#edgePnl .edp2-svg', (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      const box = await (await pg.$('#edgePnl .edp2-svg')).boundingBox();
      await pg.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      const tip = await pg.$eval('#edgePnl .edp2-tip', (el) => ({ hidden: el.hidden, t: el.textContent }));
      chk(W + 'px: hovering reads a game day and every series', !tip.hidden && /All flags/.test(tip.t) && /Tier A/.test(tip.t) && /that day/.test(tip.t), tip);
      await pg.focus('#edgePnl .edp2-svg');
      await pg.keyboard.press('End');
      const last = await pg.$eval('#edgePnl .edp2-tip .edp2-tip-r b', (el) => el.textContent);
      chk(W + 'px: End on the keyboard reads the last day, and it equals the hero', last === hero, [last, hero]);
      await pg.keyboard.press('ArrowLeft');
      chk(W + 'px: the arrows step through the days', (await text(pg, '#edgePnl .edp2-tip .edp2-tip-d')).length > 0);
      const nc = await pg.$$eval('#edgePnl .edp2-nci .n', (els) => els.map((e) => +e.textContent));
      chk(W + 'px: every flag not counted is counted, with its reason', nc.join(',') === [D.cur.v, D.cur.m, D.cur.un, D.cur.o].join(','), [nc, D.cur]);
      chk(W + 'px: the method note, word for word', (await text(pg, '#edgePnl .edp2-method')).indexOf('1 unit flat stake at the price when flagged. Pushes = 0. Missing prices are not estimated.') === 0);
      chk(W + 'px: the closing-price comparison is there, labelled as comparison only', /At the closing price instead/.test(await text(pg, '#edgePnl .edp2-close')) && /comparison only/.test(await text(pg, '#edgePnl .edp2-close')));
      chk(W + 'px: the table view of the chart exists', !!(await pg.$('#edgePnl details.edp2-tbl table')));
      const lay = await layout(pg, '#edge-pnl');
      chk(W + 'px: nothing wider than the screen, no sideways page scroll', !lay.wide.length && !lay.page, lay);
      chk(W + 'px: the sport chips are big enough to tap', !lay.small.length, lay.small);
      await shot(pg, 'record_' + W + '_edge_pnl', '#edge-pnl');
      await pg.click('#edgePnl .edp2-chip[data-sport="americanfootball_nfl"]');
      chk(W + 'px: one sport: every number follows the chip', (await text(pg, '#edgePnl .edp2-big')) === P.fmtUnits(D.nfl.u)
        && /in NFL/.test(await text(pg, '#edgePnl .edp2-say')) && (await pg.$eval('#edgePnl .edp2-chip[data-sport="americanfootball_nfl"]', (el) => el.getAttribute('aria-pressed'))) === 'true');
      await pg.click('#edgePnl .edp2-chip[data-sport=""]');
      chk(W + 'px: and back to all sports', (await text(pg, '#edgePnl .edp2-big')) === hero);
      chk(W + 'px: the CLV section still renders above it', !!(await pg.$('#recKpis')));
      chk(W + 'px: no page error', !errors.length, errors);
      await ctx.close();
    }
    /* ============================================ the archive view */
    {
      const { ctx, page: pg, errors } = await open({ width: 1440, height: 900 }, 'record.html?archive=1');
      await pg.waitForSelector('#edgePnl .edp2-hero', { timeout: 15000 });
      chk('archive: the retired sport is back, and so are its units', /ATP US Open/.test(await text(pg, '#edgePnl .edp2-chips')) && (await text(pg, '#edgePnl .edp2-big')) === P.fmtUnits(D.every.u));
      chk('archive: no page error', !errors.length, errors);
      await ctx.close();
    }
    /* ============================================ not deployed, and empty */
    {
      mode = 'missing';
      const { ctx, page: pg, errors } = await open({ width: 390, height: 900 }, 'record.html');
      await pg.waitForFunction(() => /switched on/.test((document.getElementById('edgePnl') || {}).textContent || ''), null, { timeout: 15000 });
      chk('not deployed: it says so, and shows no number', !(await pg.$('#edgePnl .edp2-big')));
      chk('not deployed: no page error', !errors.length, errors);
      await ctx.close();
      mode = 'empty';
      const e = await open({ width: 390, height: 900 }, 'record.html');
      await e.page.waitForFunction(() => /reached its close yet/.test((document.getElementById('edgePnl') || {}).textContent || ''), null, { timeout: 15000 });
      chk('empty: it says nothing has closed yet, still shows the method note', !!(await e.page.$('#edgePnl .edp2-method')) && !(await e.page.$('#edgePnl .edp2-big')));
      chk('empty: no page error', !e.errors.length, e.errors);
      await e.ctx.close();
      mode = 'live';
    }
    /* ============================================ app.html, Records */
    for (const W of [390, 1440]) {
      const { ctx, page: pg, errors } = await open({ width: W, height: 900 }, 'app.html', { session: true });
      await pg.waitForFunction(() => typeof window.show === 'function' && typeof window.recGo === 'function', null, { timeout: 20000 });
      await pg.evaluate(() => { show('record'); });
      try { await pg.waitForFunction(() => window.REC && REC.loaded && REC.pnl && REC.pnl.state !== 'loading', null, { timeout: 20000 }); }
      catch (e) { throw new Error('the Records tab did not load: ' + JSON.stringify(await pg.evaluate(() => ({ loaded: window.REC && REC.loaded, loading: window.REC && REC.loading, pnl: window.REC && REC.pnl, count: (document.getElementById('recCount') || {}).textContent, pool: (document.getElementById('recPoolNote') || {}).textContent, hero: ((document.getElementById('recHero') || {}).textContent || '').slice(0, 200) }))) + ' errors: ' + JSON.stringify(errors)); }
      const st = await pg.evaluate(() => {
        const rows = REC.rows.filter((r) => !r._unsupported);
        return { n: rows.length, state: REC.pnl.state, synced: rows.filter((r) => r._pnlRow).length,
          pairs: rows.slice(0, 400).map((r) => [r.sig_key, r._pnl, r._pnlStatus]) };
      });
      const byKey = {};
      D.grades.forEach((g) => { byKey[g.sig_key] = g; });
      const off = st.pairs.filter((x) => { const g = byKey[x[0]]; return !g || g.pnl_status !== x[2] || (g.pnl_status === 'graded' ? Math.abs(Number(g.pnl_units) - x[1]) > 1e-9 : x[1] !== null); });
      chk(W + 'px app: every graded row carries its recorded P&L, equal to the database', st.state === 'ok' && st.n > 100 && st.synced === st.n && off.length === 0, [st.state, st.n, st.synced, off.slice(0, 3)]);
      /* the edges record is a detailed record: it lives inside the Records
         page's Advanced Analytics, closed until the reader opens it */
      await pg.waitForSelector('#recPnlWrap [data-r="adv"] #recDetail', { state: 'attached', timeout: 15000 });
      chk(W + 'px app: the edges record sits inside Advanced Analytics, closed by default', await pg.$eval('#recPnlWrap [data-r="adv"]', (el) => !el.open));
      await pg.click('#recPnlWrap [data-r="adv"] > summary');
      await pg.evaluate(() => recGo('bets'));
      await pg.waitForSelector('#recTbl tbody tr.rrow', { timeout: 15000 });
      const heads = await pg.$$eval('#recTbl thead th', (els) => els.map((e) => e.textContent.replace(/[▴▾]/g, '').trim()));
      chk(W + 'px app: the bets table has a P&L column beside the simulation, told apart', heads.indexOf('P&L') > heads.indexOf('Sim P/L') && heads.indexOf('Sim P/L') >= 0 && heads.indexOf('Profit') < 0, heads);
      const cells = await pg.$$eval('#recTbl tbody tr.rrow', (trs, idx) => trs.map((tr) => tr.children[idx].textContent), heads.indexOf('P&L'));
      chk(W + 'px app: P&L cells read +0.00u / void / no flag price / pending, never blank', cells.length > 0 && cells.every((c) => /^[+-]\d+\.\d\du$|^void$|^no flag price$|^pending$/.test(c)), cells.slice(0, 8));
      await pg.waitForFunction(() => /P&L sync/.test((document.getElementById('recHealth') || {}).textContent || ''), null, { timeout: 15000 });
      const health = await pg.$eval('#recHealth', (el) => { const r = Array.from(el.querySelectorAll('.rhl-r')).find((x) => /P&L sync/.test(x.textContent)); return r ? { t: r.textContent, ok: !!r.querySelector('.rpos') } : null; });
      chk(W + 'px app: Pipeline health shows the P&L sync row, 0 missing, green', health && /0 missing/.test(health.t) && health.ok, health);
      await shot(pg, 'app_' + W + '_records_bets', '#recTblWrap');
      await pg.evaluate(() => recGo('overview'));
      await shot(pg, 'app_' + W + '_records_health', '#recHealth');
      chk(W + 'px app: no page error', !errors.length, errors);
      await ctx.close();
    }
    /* ============================================ app.html, P&L not deployed yet */
    {
      mode = 'missing';
      const { ctx, page: pg, errors } = await open({ width: 1440, height: 900 }, 'app.html', { session: true });
      await pg.waitForFunction(() => typeof window.show === 'function', null, { timeout: 20000 });
      await pg.evaluate(() => { show('record'); });
      await pg.waitForFunction(() => window.REC && REC.loaded && REC.pnl && REC.pnl.state !== 'loading', null, { timeout: 20000 });
      await pg.waitForFunction(() => /P&L sync/.test((document.getElementById('recHealth') || {}).textContent || ''), null, { timeout: 15000 });
      const st = await pg.evaluate(() => ({ pnl: REC.pnl.state, db: window.ED_DB ? ED_DB.ok !== false : true,
        row: (Array.from(document.querySelectorAll('#recHealth .rhl-r')).find((x) => /P&L sync/.test(x.textContent)) || {}).textContent || '' }));
      chk('app, not deployed: the record still loads, P&L says "not on"', st.pnl === 'missing' && /not on/.test(st.row) && /has not been applied/.test(st.row), st);
      chk('app, not deployed: the missing P&L table is NOT reported as a database outage', st.db === true, st);
      chk('app, not deployed: no page error', !errors.length, errors);
      await ctx.close();
      mode = 'live';
    }
  } catch (e) {
    chk('the browser suite ran to the end', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(T.done());
})();
