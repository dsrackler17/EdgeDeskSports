#!/usr/bin/env node
/* ===========================================================================
   NFL MARKET STRUCTURE, IN A REAL BROWSER — app.html in Chromium.
   docs/market-structure/README.md

   The NFL board runs on the nflverse schedule (served from the local feed
   cache, else fetched once) with the odds feed down, so every card's line is
   the nflverse reference. The Market Structure tables are staged:

     DEPLOYED      the snapshot board, Circa ownership and the registry answer
                   with staged rows for Week 7: DAL @ PHI froze at PHI +3 and
                   sits at +4.5 now (moved toward DAL, touched 3: flagged), a
                   divisional home dog with PARTIAL ownership; IND @ MIN froze
                   with no capture; MIN -5.5 is on the Six watch.
     NOT DEPLOYED  every Market Structure table answers 404 (migration not
                   applied): the card says Not deployed, and the page's own
                   database health is NOT marked failing by it.
     FROZEN        the same board served from the committed app.html (HEAD)
                   and from this one: every card line outside the new section
                   reads identically — the section adds, it never changes a
                   number the board already showed.

   Also: no page error; one section per NFL card; the Drift strip; a 390 px
   phone with no sideways scroll; Coming Soon for status changes; Known
   Limitations. Needs Playwright with Chromium; prints SKIPPED without one.

     node tools/football/market_structure_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const MS = require(path.join(ROOT, 'lib', 'edgedesk_market_structure.js'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}
function finish(code) { console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | market structure (browser) | ' + pass + ' passed, ' + fail + ' failed'); process.exit(code != null ? code : (fail ? 1 : 0)); }

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHED = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
async function gamesCsv() {
  if (fs.existsSync(CACHED)) return fs.readFileSync(CACHED, 'utf8');
  try { const r = await fetch(GAMES_URL); if (r.ok) return await r.text(); } catch (_) { /* below */ }
  return null;
}
const NAME = {}; MS.DIVISIONS.forEach((d) => { NAME[d[1]] = d[2]; NAME[d[0]] = d[2]; });
/* the schedule's ET kickoff, as the odds feed would carry it */
function kickIso(day, time) { const d = new Date(day + 'T' + (time || '13:00') + ':00-04:00'); return d.toISOString(); }

function staged(csv) {
  const rows = csv.trim().split('\n'), h = rows[0].split(','), ix = (k) => h.indexOf(k);
  const want = {};
  rows.slice(1).forEach((l) => { const c = l.split(','); if (c[ix('season')] === '2026' && c[ix('week')] === '7') want[c[ix('away_team')] + '@' + c[ix('home_team')]] = { day: c[ix('gameday')], time: c[ix('gametime')], id: c[ix('game_id')] }; });
  const g1 = want['DAL@PHI'], g2 = want['IND@MIN'];
  if (!g1 || !g2) return null;
  const board = [
    { event_id: 'evDALPHI', canonical_game_id: 'g1', home_team: NAME.PHI, away_team: NAME.DAL, commence_time: kickIso(g1.day, g1.time), snapshot_at: '2026-10-22T17:00:00Z',
      snapshot_status: 'ok', snapshot_backfilled: false, snap_home_spread: 3, snap_fair_home: 0.482, snap_n_books: 14, snap_books: ['draftkings', 'pinnacle'], snap_pass_at: '2026-10-22T16:20:00Z',
      current_status: 'ok', current_at: new Date().toISOString(), current_home_spread: 4.5, current_delta: 1.5, current_crossed: [3], current_flagged: true,
      close_status: null, close_at: null, close_home_spread: null, close_delta: null, close_crossed: null, close_flagged: null, moved_toward: null, clv: null, clv_source: null, clv_reason: 'not_closed' },
    { event_id: 'evINDMIN', canonical_game_id: null, home_team: NAME.MIN, away_team: NAME.IND, commence_time: kickIso(g2.day, g2.time), snapshot_at: '2026-10-22T17:00:00Z',
      snapshot_status: 'no_capture', snapshot_backfilled: false, snap_home_spread: null, current_status: null, close_status: null, clv: null, clv_reason: 'no_snapshot_line' }
  ];
  const run = { contest: 'circa_million', season: 2026, week: 7, event_id: 'evDALPHI', canonical_game_id: 'g1', entries: 2400, game_picks: 1000, fetched_at: '2026-10-24T14:07:00Z',
    source_url: 'https://www.circasports.com/wp-content/uploads/2026/10/Circa-Sports-Million-VIII-Week-7-Selections.pdf', run_status: 'partial', picks_quarantined: 3, rows_unread: 0, entries_stated: 2400, run_id: 'r1' };
  const own = [Object.assign({}, run, { side_team_code: 'PHI', contest_game_no: 6, contest_line: 3.5, picks: 720, share_of_cards: 0.3, share_of_game: 0.72 }),
    Object.assign({}, run, { side_team_code: 'DAL', contest_game_no: 5, contest_line: -3.5, picks: 280, share_of_cards: 0.116667, share_of_game: 0.28 })];
  const models = ['H-NFL-KEY-01', 'H-NFL-STALE-01', 'H-NFL-OWN-01', 'H-NFL-DIV-01'].map((k) => ({ model_key: k, status: 'experimental', version: '1.0.0-prereg', passed: null }));
  return { board, own, models, ids: { dalphi: g1.id, indmin: g2.id } };
}

(async function main() {
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const csv = await gamesCsv();
  if (!csv) { console.log('SKIPPED: the nflverse schedule is neither cached nor reachable'); process.exit(0); }
  const ST = staged(csv);
  if (!ST) { console.log('SKIPPED: the schedule carries no 2026 Week 7 DAL @ PHI / IND @ MIN to stage'); process.exit(0); }
  let HEAD_APP = null;
  try { HEAD_APP = cp.execSync('git show HEAD:app.html', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); } catch (_) { HEAD_APP = null; }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/app.html';
      if (p === '/app.head.html' && HEAD_APP) { res.writeHead(200, { 'content-type': TYPES['.html'] }); res.end(HEAD_APP); return; }
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }

  async function open(viewport, mode, appPath) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => { try {
      localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
      localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
    } catch (e) {} });
    const seen = [];
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (url === GAMES_URL || /nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: csv });
      if (/supabase\.co/.test(url)) {
        const m = /\/rest\/v1\/([^?]+)/.exec(url), t = m ? m[1] : '';
        const mine = /^(rpc\/nfl_snapshot_board|contest_ownership_latest|contest_ownership_status|market_structure_alerts)$/.test(t);
        if (mine) seen.push(t);
        if (mine && mode === 'absent') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function or table in the schema cache' }) });
        if (t === 'rpc/nfl_snapshot_board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ST.board) });
        if (t === 'contest_ownership_latest') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ST.own) });
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
        if (t === 'research_model_current') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mode === 'absent' ? [] : ST.models) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 300)));
    await page.goto('http://127.0.0.1:' + port + (appPath || '/app.html') + '#research/football', { waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 3; i++) { await page.click('text=Skip for now', { timeout: 800 }).catch(() => {}); await page.waitForTimeout(200); }
    await page.waitForFunction(() => document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]').length > 0, null, { timeout: 90000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { ctx, page, errors, seen };
  }
  const shot = async (page, name, sel) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); if (sel) { const el = await page.$(sel); if (el) { await el.screenshot({ path: path.join(SHOTS, name + '.png') }); return; } } await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

  try {
    /* ------------------------------------------------------- DEPLOYED */
    {
      const { ctx, page, errors } = await open({ width: 1280, height: 1600 }, 'deployed');
      const r = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]'));
        return { cards: cards.length, withSection: cards.filter((c) => c.querySelectorAll('.ms-wrap').length === 1).length,
          strip: (document.querySelector('#fbBody .ms-strip') || {}).innerText || '', ids: cards.map((c) => c.id) };
      });
      chk('the NFL board renders with no page error', r.cards > 0 && errors.length === 0, { cards: r.cards, errors });
      chk('every NFL card carries exactly one Market Structure section', r.cards > 0 && r.withSection === r.cards, r);
      chk('the Drift strip sits above the board: the two-point try share and its baseline', /two-point try share/i.test(r.strip) && /vs/.test(r.strip) && /exactly 6/.test(r.strip), r.strip);
      const id = 'fbg-nfl-' + ST.ids.dalphi;
      const sum = await page.evaluate((id) => { const c = document.getElementById(id); const s = c && c.querySelector('.ms-wrap > summary'); return s ? s.innerText : null; }, id);
      chk('DAL @ PHI, closed: stale-line, divisional home dog and ownership chips on the summary', sum && /stale line/i.test(sum) && /div home dog/i.test(sum) && /Circa 72% PHI/i.test(sum), sum);
      await page.evaluate((id) => { const d = document.querySelector('#' + id + ' .ms-wrap'); d.open = true; d.dispatchEvent(new Event('toggle')); }, id);
      await page.waitForTimeout(150);
      const body = await page.evaluate((id) => document.querySelector('#' + id + ' .ms-wrap .ms-body').innerText, id);
      chk('three subsections, labelled by epistemic status', /OBSERVED/i.test(body) && /Deterministic/i.test(body) && /Research Models \(Experimental\)/i.test(body), body.slice(0, 300));
      chk('the freeze: PHI +3, 14 books, its fair', /PHI \+3 · 14 books · fair 48\.2%/.test(body), body.slice(0, 600));
      chk('now: +4.5, moved 1.5 toward DAL, touched 3, flagged', /PHI \+4\.5/.test(body) && /moved \+1\.5 toward DAL/.test(body) && /touched 3/.test(body) && /STALE LINE/i.test(body));
      chk('status changes after the freeze are Coming Soon (EdgeDesk does not own them)', /COMING SOON/i.test(body) && /does not own timestamped/i.test(body));
      chk('the situation and its season-to-date records with samples and intervals', /division rival/.test(body) && /divisional home underdogs/.test(body) && /W-L-P/.test(body) && /95%/.test(body));
      chk('Circa: both sides, shares, the source and fetch time, PARTIAL with its quarantine', /PHI \+3\.5 72\.0% of game picks \(720\)/.test(body) && /DAL −3\.5 28\.0% of game picks/.test(body)
        && /circasports\.com selections PDF · fetched/.test(body) && /PARTIAL · 3 PICKS QUARANTINED/i.test(body), body.slice(body.indexOf('Circa'), body.indexOf('Circa') + 400));
      if (process.env.MS_DUMP) console.log('---BODY---\n' + body + '\n---END---');
      chk('the contest line is shown against the market when they differ', /contest line PHI \+3\.5 vs market PHI \+4\.5/.test(body));
      chk('deterministic: key numbers and the half-point value from both windows', /Key numbers/.test(body) && /Half-point value at/i.test(body) && /since 2023/.test(body));
      chk('the four studies, Experimental, no result, holdouts named', ['H-NFL-KEY-01', 'H-NFL-STALE-01', 'H-NFL-OWN-01', 'H-NFL-DIV-01'].every((k) => body.indexOf(k) >= 0) && (body.match(/No result/g) || []).length === 4 && /EXPERIMENTAL/i.test(body));
      chk('the studies that apply to this game say so (stale, ownership, divisional)', (body.match(/APPLIES HERE/gi) || []).length === 3, (body.match(/APPLIES HERE/gi) || []).length);
      chk('Known limitations names what EdgeDesk does not own', /Known limitations/.test(body) && /injury-status/.test(body) && /margins before 1999/.test(body) && /unique player/.test(body));
      await shot(page, 'market_structure_desktop', '#' + id);
      const min = 'fbg-nfl-' + ST.ids.indmin;
      const m = await page.evaluate((id) => { const d = document.querySelector('#' + id + ' .ms-wrap'); d.open = true; return { sum: d.querySelector('summary').innerText, body: d.querySelector('.ms-body').innerText }; }, min);
      chk('IND @ MIN: MIN -5.5 is on the Six watch, with the favourite-by-six share in both windows', /six watch/i.test(m.sum) && /MIN −5\.5 straddles 6/.test(m.body) && /Six watch/.test(m.body), m.body.slice(0, 400));
      chk('IND @ MIN: a freeze with no capture shows its reason, never a line', /NO CAPTURE/i.test(m.body) && /no line is shown in its place/.test(m.body));
      const other = await page.evaluate((ids) => { const c = Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).filter((x) => ids.indexOf(x.id) < 0)[0];
        if (!c) return null; const d = c.querySelector('.ms-wrap'); d.open = true; return d.querySelector('.ms-body').innerText; }, ['fbg-nfl-' + ST.ids.dalphi, 'fbg-nfl-' + ST.ids.indmin]);
      chk('a game with no freeze yet says when the next one is', other === null || /no freeze for this game yet — next Thu/.test(other) || /no freeze for this game/.test(other), (other || '').slice(0, 300));
      await ctx.close();
    }
    /* ------------------------------------------------------ PHONE */
    {
      const { ctx, page, errors } = await open({ width: 390, height: 900 }, 'deployed');
      const id = 'fbg-nfl-' + ST.ids.dalphi;
      await page.evaluate((id) => { const d = document.querySelector('#' + id + ' .ms-wrap'); if (d) d.open = true; }, id);
      await page.waitForTimeout(150);
      const w = await page.evaluate((id) => { const c = document.getElementById(id); const d = c && c.querySelector('.ms-wrap');
        return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, card: c ? c.scrollWidth - c.clientWidth : null, sec: d ? d.scrollWidth - d.clientWidth : null }; }, id);
      chk('390 px phone: the open section never scrolls sideways', errors.length === 0 && w.sec !== null && w.sec <= 1 && w.card <= 1 && w.doc <= w.vw + 1, w);
      await shot(page, 'market_structure_phone', '#' + id);
      await ctx.close();
    }
    /* ------------------------------------------------- NOT DEPLOYED */
    {
      const { ctx, page, errors, seen } = await open({ width: 1280, height: 1400 }, 'absent');
      const id = 'fbg-nfl-' + ST.ids.dalphi;
      const r = await page.evaluate((id) => { const d = document.querySelector('#' + id + ' .ms-wrap'); if (!d) return null; d.open = true;
        return { body: d.querySelector('.ms-body').innerText, db: window.ED_DB ? { ok: window.ED_DB.ok, where: window.ED_DB.where || null } : null }; }, id);
      chk('not deployed: the page still renders, no page error', r && errors.length === 0, errors);
      chk('not deployed: the freeze and Circa rows say Not deployed and name the file', r && (r.body.match(/NOT DEPLOYED/gi) || []).length >= 2 && /nfl_market_structure\.sql/.test(r.body) && /contest_ownership\.sql/.test(r.body), r && r.body.slice(0, 500));
      chk('not deployed: the studies read Experimental with registration not applied', r && /registration not applied yet/.test(r.body));
      chk('not deployed: the section asked for its tables', seen.length >= 2, seen);
      chk('not deployed: the page\'s database health is not marked failing by these tables', r && (!r.db || r.db.ok !== false || !/nfl_snapshot_board|contest_ownership|market_structure_alerts/.test(String(r.db.where))), r && r.db);
      await ctx.close();
    }
    /* ------------------------------------------------------- FROZEN */
    if (!HEAD_APP) console.log('  note the committed app.html could not be read (git): the frozen comparison did not run');
    else {
      const read = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).map((c) => {
        const x = c.cloneNode(true); x.querySelectorAll('.ms-wrap').forEach((n) => n.remove());
        return c.id + ' :: ' + Array.from(x.querySelectorAll('.gd-line, .gd-nodata, .mdl-card-match, .qev-row, .dcard')).map((n) => n.innerText.replace(/\s+/g, ' ').trim()).join(' | ');
      }));
      const A = await open({ width: 1280, height: 1400 }, 'deployed', '/app.head.html');
      const a = await read(A.page); await A.ctx.close();
      const B = await open({ width: 1280, height: 1400 }, 'deployed');
      const b = await read(B.page); await B.ctx.close();
      const diff = a.filter((x, i) => x !== b[i]);
      chk('frozen: the committed page and this one show the same ' + a.length + ' NFL cards, line for line, outside the new section', a.length > 0 && a.length === b.length && diff.length === 0,
        { a: a.length, b: b.length, first: diff[0], vs: b[a.indexOf(diff[0])] });
    }
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close(); srv.close();
  }
  finish();
})();
