#!/usr/bin/env node
/* ===========================================================================
   FOOTBALL SITUATIONAL INTELLIGENCE, IN A REAL BROWSER — app.html in Chromium.
   football/situational/README.md

   The COMMITTED artifact (football/situational/data/cards.json) is served as
   is and the page clock is pinned to its build time, so the NFL and FBS
   boards list the same upcoming games the artifact covers:
     NFL      every NFL card the artifact covers carries exactly one
              Situational Intelligence section; opened, it shows observed
              tendencies with samples and the experimental research block
     FBS      a board row opens its research card; its "Situational
              intelligence" section shows the same, for a college game
     PHONE    390 px: the open sections never scroll sideways
     FROZEN   the committed app.html (HEAD) and this one show the same NFL
              cards, line for line, outside the new section
   Needs Playwright with Chromium and the nflverse schedule (cache or network);
   prints SKIPPED without them, which AGENTS.md counts as NOT VERIFIED.

     node tools/football/fsie_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : '')); }
function finish() { console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | situational intelligence (browser) | ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHED = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
async function gamesCsv() { if (fs.existsSync(CACHED)) return fs.readFileSync(CACHED, 'utf8'); try { const r = await fetch(GAMES_URL); if (r.ok) return await r.text(); } catch (_) { /* below */ } return null; }
function cfbSchedule(y) {
  for (const d of [path.join(ROOT, 'football', 'situational', '.cache', 'raw', 'cfb_schedule_' + y + '.csv'), path.join(ROOT, 'football', 'fbs', '.cache', 'cfb_schedules_' + y + '.csv')]) if (fs.existsSync(d)) return fs.readFileSync(d, 'utf8');
  return null;
}

(async function main() {
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const ART = path.join(ROOT, 'football', 'situational', 'data', 'cards.json');
  if (!fs.existsSync(ART)) { console.log('SKIPPED: no committed cards.json'); process.exit(0); }
  const cards = JSON.parse(fs.readFileSync(ART, 'utf8'));
  const PIN = Date.parse(cards.built_at);
  const nflIds = Object.keys(cards.games).filter((k) => cards.games[k].sport === 'nfl');
  const cfbIds = Object.keys(cards.games).filter((k) => cards.games[k].sport === 'cfb' && cards.games[k].research.status === 'projected');
  const csv = await gamesCsv();
  if (!csv) { console.log('SKIPPED: the nflverse schedule is neither cached nor reachable'); process.exit(0); }
  let HEAD_APP = null; try { HEAD_APP = cp.execSync('git show HEAD:app.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (_) { HEAD_APP = null; }
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/app.html';
      if (p === '/app.head.html' && HEAD_APP) { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(HEAD_APP); return; }
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) { const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'; if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); } }

  async function open(viewport, appPath) {
    const ctx = await browser.newContext({ viewport });
    if (ctx.clock) await ctx.clock.setFixedTime(new Date(PIN));
    await ctx.addInitScript(() => { try {
      localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
      localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
    } catch (e) {} });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (url === GAMES_URL || /nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: csv });
      const m = url.match(/cfb_schedules_(\d{4})\.csv/);
      if (m) { const b = cfbSchedule(+m[1]); return b ? route.fulfill({ status: 200, contentType: 'text/csv', body: b }) : route.fulfill({ status: 404, body: 'not published' }); }
      if (/supabase\.co/.test(url)) {
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(PIN + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto('http://127.0.0.1:' + port + (appPath || '/app.html') + '#research/football', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 3; i++) { await page.click('text=Skip for now', { timeout: 800 }).catch(() => {}); await page.waitForTimeout(200); }
    await page.waitForFunction(() => document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]').length > 0, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);
    /* the artifact is fetched on the first hook call; let the repaint land */
    await page.waitForFunction(() => window.__fsieState && window.__fsieState().st === 'ok', null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => { try { window.renderFootball(); } catch (_) {} });
    await page.waitForTimeout(800);
    return { ctx, page, errors };
  }
  const shot = async (page, name, sel) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const el = sel ? await page.$(sel) : null; if (el) await el.screenshot({ path: path.join(SHOTS, name + '.png') }); else await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

  try {
    /* ------------------------------------------------------------- NFL */
    {
      const { ctx, page, errors } = await open({ width: 1280, height: 1600 });
      const r = await page.evaluate((ids) => {
        const cards = Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]'));
        const covered = cards.filter((c) => ids.indexOf(c.id.replace('fbg-nfl-', '')) >= 0);
        return { cards: cards.length, covered: covered.length, withOne: covered.filter((c) => c.querySelectorAll('.fsie-wrap').length === 1).length,
          uncoveredWithSection: cards.filter((c) => ids.indexOf(c.id.replace('fbg-nfl-', '')) < 0 && c.querySelector('.fsie-wrap')).length, first: covered[0] ? covered[0].id : null, state: window.__fsieState && window.__fsieState() };
      }, nflIds);
      chk('the NFL board renders with no page error', r.cards > 0 && errors.length === 0, { cards: r.cards, errors });
      chk('the artifact loaded in the page', r.state && r.state.st === 'ok' && r.state.games > 0, r.state);
      chk('every NFL card the artifact covers carries exactly one section', r.covered > 0 && r.withOne === r.covered, r);
      chk('a card the artifact does not cover carries none', r.uncoveredWithSection === 0, r);
      const body = await page.evaluate((id) => { const d = document.querySelector('#' + id + ' .fsie-wrap'); d.open = true; d.dispatchEvent(new Event('toggle')); return d.querySelector('.fsie-body').textContent; }, r.first);
      chk('NFL: observed tendencies with their samples', /Observed · season to date/.test(body) && /Early-down pass rate/.test(body) && /n \d+/.test(body) && /games ·/.test(body), body.slice(0, 400));
      chk('NFL: the experimental research block with model version and as-of', /Research Models \(Experimental\)/.test(body) && /situational_v1/.test(body) && /as of/.test(body) && /P10–P90/.test(body), body.slice(body.indexOf('Research'), body.indexOf('Research') + 400));
      chk('NFL: known limitations are stated', /Known limitations/.test(body));
      await shot(page, 'fsie_nfl_desktop', '#' + r.first);
      await ctx.close();
    }
    /* ------------------------------------------------------------- FBS */
    {
      const { ctx, page, errors } = await open({ width: 1280, height: 2000 });
      await page.evaluate(() => { try { window.researchGo('football'); } catch (e) {} });
      await page.evaluate(() => window.fbSetSport('p4'));
      await page.waitForFunction(() => { const b = document.getElementById('fbBody'); return b && /FBS FOOTBALL OPERATIONS/.test(b.innerHTML); }, null, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(800);
      const gid = await page.evaluate((ids) => { const rows = Array.from(document.querySelectorAll('[id^="p4gate-"]')).map((e) => e.id.replace('p4gate-', '')); return rows.find((g) => ids.indexOf(g) >= 0) || null; }, cfbIds);
      chk('the FBS board lists a game the artifact covers', !!gid, { covered: cfbIds.length });
      if (gid) {
        await page.evaluate((g) => { const a = document.getElementById('p4arr-' + g); if (a) a.parentElement.click(); }, gid);
        await page.waitForTimeout(600);
        const sec = await page.evaluate((g) => { const el = document.getElementById('gxs-' + g + '_situational'); if (!el) return null; const h = el.querySelector('.gx-sec-h'); if (h) h.click(); return true; }, gid);
        await page.waitForTimeout(300);
        const text = await page.evaluate((g) => { const el = document.getElementById('gxs-' + g + '_situational'); return el ? el.textContent : ''; }, gid);
        chk('FBS: the card has a Situational intelligence section', sec === true && /Situational intelligence/i.test(text), text.slice(0, 200));
        chk('FBS: observed college tendencies with samples, and the college gaps stated', /Early-down pass rate/.test(text) && /n \d+/.test(text) && /not observed in any college feed/.test(text), text.slice(0, 500));
        chk('FBS: the experimental research block', /Research Models \(Experimental\)/.test(text) && /situational_v1/.test(text), text.slice(text.indexOf('Research'), text.indexOf('Research') + 300));
        chk('FBS: no page error', errors.length === 0, errors);
        await shot(page, 'fsie_fbs_desktop', '#p4gate-' + gid);
      }
      await ctx.close();
    }
    /* ----------------------------------------------------------- PHONE */
    {
      const { ctx, page, errors } = await open({ width: 390, height: 900 });
      const w = await page.evaluate((ids) => {
        const c = Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).find((x) => ids.indexOf(x.id.replace('fbg-nfl-', '')) >= 0);
        if (!c) return null; const d = c.querySelector('.fsie-wrap'); d.open = true;
        return { id: c.id, doc: document.documentElement.scrollWidth, vw: window.innerWidth, card: c.scrollWidth - c.clientWidth, sec: d.scrollWidth - d.clientWidth };
      }, nflIds);
      chk('390 px phone: the open section never scrolls sideways', w && errors.length === 0 && w.sec <= 1 && w.card <= 1 && w.doc <= w.vw + 1, w);
      if (w) await shot(page, 'fsie_nfl_phone', '#' + w.id);
      await ctx.close();
    }
    /* ---------------------------------------------------------- FROZEN */
    if (!HEAD_APP) console.log('  note the committed app.html could not be read (git): the frozen comparison did not run');
    else {
      const read = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).map((c) => {
        const x = c.cloneNode(true); x.querySelectorAll('.fsie-wrap').forEach((n) => n.remove());
        return c.id + ' :: ' + Array.from(x.querySelectorAll('.gd-line, .gd-nodata, .mdl-card-match, .qev-row, .dcard')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()).join(' | ');
      }));
      const A = await open({ width: 1280, height: 1400 }, '/app.head.html'); const a = await read(A.page); await A.ctx.close();
      const B = await open({ width: 1280, height: 1400 }); const b = await read(B.page); await B.ctx.close();
      const diff = a.filter((x, i) => x !== b[i]);
      chk('frozen: the committed page and this one show the same ' + a.length + ' NFL cards, line for line, outside the new section', a.length > 0 && a.length === b.length && diff.length === 0, { a: a.length, b: b.length, first: diff[0] });
    }
  } catch (e) { chk('the run completed', false, String(e && e.stack || e).slice(0, 600)); }
  finally { await browser.close(); srv.close(); }
  finish();
})();
