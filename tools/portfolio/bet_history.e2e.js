#!/usr/bin/env node
/* ===========================================================================
   "WHAT COST YOU MONEY" IN CHROMIUM, AGAINST THE REAL MIGRATION.

   The pattern of tools/portfolio/portfolio_ui.e2e.js: app.html served from
   this repository, every PostgREST call answered by tools/portfolio/_pgrest.js
   running SQL on a throwaway PostgreSQL (supabase/portfolio*.sql applied) AS
   THE SIGNED-IN READER, under row level security.

   A reader, starting from nothing:
     imports a Juice-Reel-style export (one row per parlay leg, the ticket
     repeated) through the Import tab: the page reads it as leg rows, says
     22 rows became 14 tickets, the server classifies one row per ticket, and
     confirming stores one position per ticket (a 3-leg parlay is one row
     with 3 legs);
     opens Analytics and sees "What cost you money": the loss and its base,
     singles vs parlays with n, legs, risked, P&L, ROI and win rate, the
     worst segments with their n and the small-sample label, the worst day
     and its share, the alt-line effect, data quality, the answer in words
     and the caveat line — every figure the one EDBETS computes in Node from
     the same stored rows, and no chasing language anywhere;
     never sees another reader's ticket in it;
   at 1280 px and at a 390 px phone, with no sideways scroll and no page error.

   Run: node tools/portfolio/bet_history.e2e.js [--shots DIR]
   (PORTFOLIO_UI_REQUIRED=1 makes a missing Playwright or PostgreSQL a failure.)
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const REST = require('./_pgrest.js');

const ROOT = PG.ROOT;
global.window = global;
const BETS = require(path.join(ROOT, 'lib', 'edgedesk_bet_history.js'));
const UI = require(path.join(ROOT, 'lib', 'edgedesk_portfolio_ui.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_portfolio.js'));
const REQUIRED = process.env.PORTFOLIO_UI_REQUIRED === '1';
const SHOTS = (function () { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; }());
const CSV = fs.readFileSync(path.join(__dirname, 'fixtures', 'juice_reel_style.csv'), 'utf8');
const A = '00000000-0000-0000-0000-0000000000a5';
const B = '00000000-0000-0000-0000-0000000000b5';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 500) : '')); } }
function done(note) { console.log((fail ? 'FAIL' : 'PASS') + ' | bet history e2e | ' + pass + ' passed, ' + fail + ' failed' + (note ? ' | ' + note : '')); process.exit(fail ? 1 : 0); }
function skip(why) { if (REQUIRED) { chk('environment: ' + why, false); done(); } console.log('SKIPPED: ' + why); process.exit(0); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.png': 'image/png' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) skip('playwright is not installed here');
  const db = PG.start('bhui');
  if (db.skip) skip(db.skip);
  ['portfolio.sql', 'portfolio_journal.sql', 'portfolio_connect.sql', 'portfolio_decision.sql'].forEach((f) => db.applyFileAtomic(path.join(ROOT, 'supabase', f)));
  db.sql(`insert into auth.users (id, email) values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
  /* reader B's losing parlay, which reader A's analysis must never include */
  db.as(B, `insert into public.portfolio_positions (platform, platform_label, platform_type, position_type, event_name, market_name, selection, odds_american, stake, status, placed_at, settled_at)
            values ('fanduel', 'FanDuel', 'SPORTSBOOK', 'PARLAY', 'SECRET-B Rams @ Seahawks', 'Parlay (2 legs)', 'Rams + Over', 264, 777, 'LOST', '2026-09-01T12:00:00Z', '2026-09-01T20:00:00Z');`);
  const rest = REST.make(db, { tokens: { e2e: A } });
  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].filter((x) => fs.existsSync(x))[0];
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { db.stop(); site.srv.close(); skip('no Chromium'); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(viewport) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
    await ctx.addInitScript((uid) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: uid, email: 'reader@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    }, A);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const m = /supabase\.co\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
      if (/supabase\.co\/rest\/v1\/rpc\/ed_track/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, recorded: 1 }) });
      if (m && /^(rpc\/portfolio_|portfolio_|platform_accounts)/.test(decodeURIComponent(m[1]))) {
        let body = null; try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (_) { body = null; }
        const token = String(req.headers().authorization || '').replace(/^Bearer\s+/i, '');
        const out = rest.handle(req.method(), decodeURIComponent(m[1]), m[2] || '', body, req.headers().prefer || '', token);
        return route.fulfill({ status: out.status, contentType: 'application/json', body: out.body == null ? '' : JSON.stringify(out.body) });
      }
      if (/supabase\.co/.test(url)) {
        if (/\/user_preferences/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ user_id: A, onboarding_status: 'completed', leagues: ['nfl'], books: [], interests: [] }]) });
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${site.port}/app.html#portfolio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window.EDPortfolioUI && window.EDBETS && document.querySelector('#pfoHost.pfo-root')), null, { timeout: 40000 });
    return { ctx, page, errors };
  }
  const text = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.innerText : ''; }, sel || '#pfoHost');
  const flat = (s) => String(s).replace(/\s+/g, ' ');
  const waitText = (page, re, ms, sel) => page.waitForFunction((a) => { const el = document.querySelector(a[2]); return !!el && new RegExp(a[0], a[1]).test(el.innerText); }, [re.source, re.flags, sel || '#pfoHost'], { timeout: ms || 15000 });
  const tab = async (page, v) => { await page.click(`#pfoHost .pfo-tab[data-v="${v}"]`); await page.waitForTimeout(150); };
  async function noSideways(page, label) {
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
    chk(label + ': nothing scrolls sideways', w.sw <= w.w + 1, w);
  }
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
  const LP = '#pfoHost [data-r="loss-patterns"]';

  try {
    /* ═══ DESKTOP: import the leg rows, then read what cost money ═══════ */
    let { ctx, page, errors } = await open({ width: 1280, height: 900 });
    await waitText(page, /Build your portfolio/);
    await tab(page, 'import');
    await page.setInputFiles('#pfoHost input[type="file"]', { name: 'juice_reel_export.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await waitText(page, /Check the columns/i);
    let t = flat(await text(page));
    chk('the page reads the export as leg rows (one row per parlay leg)', /one row per parlay leg/i.test(t), t.slice(0, 400));
    chk('…22 rows read, 14 bets once the parlay legs are joined', /22 Rows read/i.test(t) && /14 Bets \(parlay legs joined\)/i.test(t), t.slice(t.search(/Rows read/i) - 40, t.search(/Rows read/i) + 200));
    chk('…and it says what it joined, merged and flagged', /7 leg rows were joined into 5 multi-leg tickets/.test(t) && /1 row repeated a leg already listed/.test(t) && /1 row has no ticket id/.test(t) && /1 ticket list different stakes/.test(t));
    await page.click('#pfoHost [data-act="imp-check"]');
    await waitText(page, /Before anything is stored/i);
    t = flat(await text(page));
    chk('the server classifies one row per ticket: 14 found, 11 ready, 3 need review', /14 Found/i.test(t) && /11 Ready/i.test(t) && /3 Need review/i.test(t) && /Import 11/.test(t), t.slice(t.search(/Before anything/i), t.search(/Before anything/i) + 300));
    chk('nothing is stored before the reader confirms', db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === '0');
    await shot(page, 'desktop-import-legs');
    await page.click('#pfoHost [data-act="imp-commit"]');
    await waitText(page, /Imported 11/);
    chk('confirming stores one position per ticket (11), never one per leg row', db.sql(`select count(*) from public.portfolio_positions where user_id = '${A}';`) === '11');
    chk('…the 3-leg parlay is one position with 3 legs and its $50 stake once',
      db.sql(`select position_type || ' ' || jsonb_array_length(legs) || ' ' || trim_scale(stake)::text || ' ' || trim_scale(profit_loss)::text from public.portfolio_positions where user_id = '${A}' and external_position_id = 'T1001';`) === 'PARLAY 3 50 -50');

    /* what EDBETS says over the same stored rows, read as the page reads them */
    const rowsA = rest.handle('GET', 'portfolio_positions', 'select=' + UI.POSITION_SELECT + '&order=placed_at.asc', null, '', 'e2e').body;
    const want = BETS.analyze(BETS.fromPositions(rowsA), { tz: 'UTC' });
    chk('(the expected figures: 9 counted tickets, risked $535.00, P&L −$113.55)', want.totals.n === 9 && want.totals.risked === '535.00' && want.totals.pnl === '-113.55', want.totals);

    await tab(page, 'analytics');
    await waitText(page, /What cost you money/i, 20000, LP);
    await waitText(page, /Sportsbook · prediction market · combined/i, 20000);
    t = flat(await text(page, LP));
    chk('Analytics opens with "What cost you money"', /What cost you money · all time/i.test(t), t.slice(0, 200));
    chk('…the loss and its base, from the stored rows', /You lost \$113\.55 on 9 tickets that settled or were cashed out \(risked \$535\.00, ROI −21\.2%\)/.test(t), t.slice(0, 400));
    chk('…pending and void stated apart', /1 pending ticket \(\$60\.00 at risk\) is not counted until it settles\. 1 voided ticket is left out/.test(t));
    const kinds = flat(await text(page, '#pfoHost [data-r="lp-kinds"]'));
    chk('…singles vs parlays with n, legs, risked, P&L, ROI and win rate', /Tickets\s+5\s+4/.test(kinds) && /Legs\s+5\s+10/.test(kinds) && /Risked\s+\$430\.00\s+\$105\.00/.test(kinds)
      && /P&L\s+−\$140\.00\s+\+\$26\.45/.test(kinds) && /ROI\s+−32\.6%\s+\+25\.2%/.test(kinds) && /Record \(W-L-P\)\s+1-2-1 \+1 cash-out\s+2-2-0/.test(kinds) && /Win rate\s+33\.3%\s+50\.0%/.test(kinds), kinds);
    chk('…which one was more profitable, and how weak the evidence is', /Parlays were more profitable per dollar risked than singles/.test(t) && /weak evidence/.test(t));
    const segs = flat(await text(page, '#pfoHost [data-r="lp-segments"]'));
    const w0 = want.worstSegments[0];
    chk('…the worst segments, each with its n and the small-sample label', segs.indexOf(w0.label) === 0 && new RegExp('n=' + w0.n).test(segs) && /small sample/.test(segs)
      && segs.indexOf(E.money(w0.pnl, { sign: true })) > 0, { segs, w0 });
    chk('…the worst day with its share of losing-day losses', new RegExp('Worst day: ' + want.days.worst.date + ', ' + E.money(want.days.worst.pnl, { sign: true }).replace(/[$.]/g, '\\$&')).test(t)
      && t.indexOf(E.pct(want.days.worst.share, 1, { plain: true }) + ' of the') > 0, t.slice(t.search(/Days that/), t.search(/Days that/) + 200));
    chk('…the alt-line effect: the −250 alt spread single and the parlay with alt legs', /1 single −\$125\.00, won 0 of 1/.test(t) && /71\.4% of the time just to break even/.test(t)
      && /Together: −\$150\.00 on 2 tickets/.test(t), t.slice(t.search(/Alternate lines/), t.search(/Alternate lines/) + 400));
    chk('…data quality, with CLV said to be not verifiable (no closing price is stored)', /Data quality/i.test(t) && /not verifiable/.test(t));
    chk('…and the caveat line', /These figures describe your past results only; they do not predict future results\./.test(t));
    chk('no chasing, stake-raising or forecasting language in the section', BETS.checkLanguage(t).ok, BETS.checkLanguage(t).hits);
    chk('reader B\'s $777 parlay is nowhere in reader A\'s analysis', !/SECRET-B|777/.test(t));
    await page.click('#pfoHost [data-r="lp-answer"] summary');
    t = flat(await text(page, '#pfoHost [data-r="lp-answer"]'));
    chk('the answer in plain words names the drivers from the analytics', /The biggest loss drivers: \(1\)/.test(t) && t.indexOf(want.worstSegments.length ? 'small sample' : '') >= 0, t.slice(0, 500));
    await noSideways(page, '1280px Analytics');
    await shot(page, 'desktop-analytics-loss-patterns');
    await page.click('#pfoHost [data-act="period"][data-v="7D"]');
    await waitText(page, /What cost you money · last 7 days/i, 15000, LP);
    chk('the period chips re-cut it (last 7 days)', /What cost you money · last 7 days/i.test(flat(await text(page, LP))));
    chk('no page errors on the desktop', errors.length === 0, errors);
    await ctx.close();

    /* ═══ PHONE: 390 px ════════════════════════════════════════════════ */
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }));
    await waitText(page, /Total P&L/i, 20000);
    await tab(page, 'analytics');
    await waitText(page, /What cost you money/i, 20000, LP);
    await page.waitForTimeout(300);
    await noSideways(page, '390px Analytics with loss patterns');
    const fit = await page.evaluate((sel) => {
      const sec = document.querySelector(sel), r = sec.getBoundingClientRect();
      const wide = [...sec.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1 && el.offsetParent !== null).map((el) => el.tagName + '.' + el.className).slice(0, 5);
      const tbl = sec.querySelector('[data-r="lp-kinds"]');
      return { left: r.left, right: r.right, vw: innerWidth, wide, table: tbl ? { sw: tbl.scrollWidth, cw: tbl.clientWidth, right: tbl.getBoundingClientRect().right } : null };
    }, LP);
    chk('390px: the section sits inside the screen', fit.left >= 0 && fit.right <= fit.vw + 1, fit);
    chk('390px: nothing in it runs past the edge', fit.wide.length === 0, fit.wide);
    chk('390px: singles vs parlays fits without its own scroll', fit.table && fit.table.sw <= fit.table.cw + 1 && fit.table.right <= fit.vw + 1, fit.table);
    t = flat(await text(page, LP));
    chk('390px: the same answer and the caveat line', /You lost \$113\.55 on 9 tickets/.test(t) && /do not predict future results/.test(t));
    await page.click('#pfoHost [data-r="lp-answer"] summary');
    await page.waitForTimeout(150);
    await noSideways(page, '390px with the answer open');
    await shot(page, 'phone-analytics-loss-patterns');
    chk('no page errors on the phone', errors.length === 0, errors);
    await ctx.close();
  } catch (e) {
    chk('unexpected failure', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close();
    site.srv.close();
    db.stop();
  }
  done(SHOTS ? 'screenshots in ' + SHOTS : '');
}());
