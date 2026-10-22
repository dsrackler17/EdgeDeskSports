#!/usr/bin/env node
/* ===========================================================================
   THE OFFICIATING BLOCK, IN A REAL BROWSER — app.html in Chromium.
   data/refs/README.md, supabase/nfl_ref_flags.sql

   The NFL board runs on the nflverse schedule (cached, else fetched once)
   with the odds feed down, and every page reads 2026-10-22 16:00 UTC (a pinned
   clock) from a schedule whose 2026 results from Week 7 on are blanked, so
   Week 7 is the upcoming week whenever this runs. public.nfl_game_ref_context answers with
   tools/refs/fixtures/nfl_game_ref_context_2026_w7.json — the view's own
   Week 7 rows on the seeded data (tools/refs/nfl_ref_flags_sql.test.js holds
   the two equal) — filtered by the request's game_id=in.(...):

     DEPLOYED      every Week 7 card shows its referee and that referee's
                   numbers exactly as the view has them: GB @ DET Alex Moore,
                   CLE @ TEN Scott Novak; above the league average in --pos,
                   below in --neg; rank of 17; the 3-season baseline with its
                   games; the O/U record as a count. A game with no assignment
                   reads "Assignment not announced". One request for the board.
                   No grade, label or score words. The Known Limitations carry
                   the three officiating caveats.
     PHONE         390 px, the section open: no sideways scroll
     NOT DEPLOYED  the view answers 404: the block says Not deployed and names
                   the file; the page's database health is not marked failing
     FROZEN        every card line outside the Market Structure section reads
                   the same as the committed app.html (HEAD)

     node tools/refs/ref_flags_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nfl_game_ref_context_2026_w7.json'), 'utf8'));

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 700) : ''));
}
function finish() { console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | officiating (browser) | ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHED = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
async function gamesCsv() {
  if (fs.existsSync(CACHED)) return fs.readFileSync(CACHED, 'utf8');
  try { const r = await fetch(GAMES_URL); if (r.ok) return await r.text(); } catch (_) { /* below */ }
  return null;
}
const f2 = (x) => Number(x).toFixed(2);
const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2);
const PIN = Date.parse('2026-10-22T16:00:00Z');
/* one CSV line, quoted fields kept whole */
function cells(line) {
  const out = []; let cur = '', q = false;
  for (const ch of line) { if (ch === '"') q = !q; if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur); return out;
}
/* 2026 from Week 7 on, as it stood before kickoff: no scores, no result */
function upcoming(csv) {
  const rows = csv.split('\n'), h = cells(rows[0]), ix = (k) => h.indexOf(k);
  const blank = ['away_score', 'home_score', 'result', 'total', 'overtime'].map(ix).filter((i) => i >= 0);
  return rows.map((l, i) => {
    if (!i || !l) return l;
    const c = cells(l);
    if (c[ix('season')] !== '2026' || Number(c[ix('week')]) < 7) return l;
    blank.forEach((k) => { c[k] = ''; });
    return c.join(',');
  }).join('\n');
}

(async function main() {
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const raw = await gamesCsv();
  if (!raw) { console.log('SKIPPED: the nflverse schedule is neither cached nor reachable'); process.exit(0); }
  const csv = upcoming(raw);
  const W8 = (/(^|\n)(2026_08_[A-Z]+_[A-Z]+),/.exec(csv) || [])[2];
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
    const pinned = !!ctx.clock;
    if (pinned) await ctx.clock.setFixedTime(new Date(PIN));
    await ctx.addInitScript(() => { try {
      localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
      localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
    } catch (e) {} });
    const asked = [];
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (url === GAMES_URL || /nfldata\/master\/data\/games\.csv/.test(url)) return route.fulfill({ status: 200, contentType: 'text/csv', body: csv });
      if (/supabase\.co/.test(url)) {
        const m = /\/rest\/v1\/([^?]+)/.exec(url), t = m ? m[1] : '';
        if (t === 'nfl_game_ref_context') {
          const q = new URL(url).searchParams, ids = (/^in\.\((.*)\)$/.exec(q.get('game_id') || '') || [])[1];
          asked.push({ ids: ids ? ids.split(',').length : 0, sel: q.get('select') });
          if (mode === 'absent') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.nfl_game_ref_context in the schema cache' }) });
          const want = new Set((ids || '').split(','));
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIX.filter((r) => want.has(r.game_id))) });
        }
        if (/\/subscriptions/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
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
    return { ctx, page, errors, asked, pinned };
  }
  /* the Officiating rows of one card, with the section opened */
  const block = (page, gid) => page.evaluate((gid) => {
    const c = document.getElementById('fbg-nfl-' + gid), d = c && c.querySelector('.ms-wrap');
    if (!d) return null;
    d.open = true;
    const rows = Array.from(d.querySelectorAll('.ms-body .ms-row')), i = rows.findIndex((r) => /^Officiating/.test(r.querySelector('.l').innerText));
    if (i < 0) return { rows: [], summary: d.querySelector('summary').innerText };
    const mine = []; let n = rows[i];
    for (let k = i; k < rows.length && (k === i || !/^(Key numbers|Half-point value|Six watch)/.test(rows[k].querySelector('.l').innerText)); k++) mine.push(rows[k]);
    const note = mine[mine.length - 1].nextElementSibling;
    return {
      summary: d.querySelector('summary').innerText,
      rows: mine.map((r) => ({ l: r.querySelector('.l').innerText.replace(/\s+/g, ' ').trim(), v: r.querySelector('.v').innerText.replace(/\s+/g, ' ').trim(),
        colors: Array.from(r.querySelectorAll('.v span[style]')).map((s) => [s.innerText, s.getAttribute('style')]) })),
      note: note && note.classList.contains('ms-note') ? note.innerText : '',
      lim: (d.querySelector('.ms-lim') || {}).innerText || '',
      first: n.previousElementSibling ? n.previousElementSibling.querySelector('.l').innerText : null
    };
  }, gid);
  const shot = async (page, name, sel) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const el = sel && await page.$(sel); if (el) await el.screenshot({ path: path.join(SHOTS, name + '.png') }); else await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

  try {
    /* ------------------------------------------------------- DEPLOYED */
    {
      const { ctx, page, errors, asked } = await open({ width: 1280, height: 1600 }, 'deployed');
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).map((c) => c.id.replace('fbg-nfl-', '')));
      const w7 = FIX.filter((r) => ids.indexOf(r.game_id) >= 0);
      chk('the NFL board renders with no page error', ids.length > 0 && errors.length === 0, { cards: ids.length, errors });
      if (!w7.length) { console.log('SKIPPED: the board shows no 2026 Week 7 game today (' + ids.slice(0, 3).join(', ') + ')'); await ctx.close(); throw new Error('skip'); }
      chk('the board asked for every card\'s referee in one request', asked.length === 1 && asked[0].ids === ids.length && asked[0].sel === '*', asked);

      const gb = await block(page, '2026_07_GB_DET'), G = FIX.filter((r) => r.game_id === '2026_07_GB_DET')[0];
      const txt = (b) => b ? b.rows.map((r) => r.l + ' :: ' + r.v).join('\n') : '';
      if (process.env.REF_DUMP) console.log(txt(gb) + '\n' + (gb && gb.note));
      chk('GB @ DET: Officiating sits in Observed, after Circa Million', gb && gb.rows.length && /^Circa Million/.test(gb.first || ''), gb && gb.first);
      chk('GB @ DET: Alex Moore, assignment from Football Zebras', gb && /^Officiating :: Alex Moore · referee · assignment from Football Zebras$/.test(gb.rows[0].l + ' :: ' + gb.rows[0].v), gb && gb.rows[0]);
      chk('GB @ DET: the referee on the closed section\'s summary', gb && /ref Alex Moore/i.test(gb.summary), gb && gb.summary);
      chk('GB @ DET: flags 18.60, +3.61 vs league 14.99, rank 2 of 17, 5 games', /Flags \/ game 2026 · 5 games :: 18\.60 \+3\.61 vs league 14\.99 · rank 2 of 17/.test(txt(gb)), txt(gb));
      chk('GB @ DET: holding 7.20, +3.19 vs league 4.01, rank 1 of 17', /Holding \/ game 2026 · 5 games :: 7\.20 \+3\.19 vs league 4\.01 · rank 1 of 17/.test(txt(gb)), txt(gb));
      chk('GB @ DET: the 3-season baseline with its game count', new RegExp('3-season baseline 2024–2026 · ' + G.y3_games + ' games :: ' + f2(G.y3_flags_pg) + ' flags ' + signed(G.y3_flags_vs_league).replace('+', '\\+')
        + ' · ' + f2(G.y3_holding_pg) + ' holding ' + signed(G.y3_holding_vs_league).replace('+', '\\+') + ' per game, vs league 13\\.11 / ' + f2(G.y3_lg_holding_pg)).test(txt(gb)), txt(gb));
      chk('GB @ DET: the O/U record as a plain count', new RegExp('O/U record over-under :: 2026 ' + G.season_overs + '-' + G.season_unders + ' · 2024–2026 ' + G.y3_overs + '-' + G.y3_unders + ' in this referee’s games; a count, not a signal').test(txt(gb)), txt(gb));
      chk('GB @ DET: above the league average in --pos', gb && gb.rows[1].colors.length === 1 && gb.rows[1].colors[0][0] === '+3.61' && /var\(--pos\)/.test(gb.rows[1].colors[0][1]), gb && gb.rows[1].colors);
      chk('GB @ DET: the rank and the small sample are explained', gb && /Rank 1 is the most per game among the 17 referees who worked a 2026 game; 5 games are a small sample/.test(gb.note), gb && gb.note);
      chk('the three officiating limitations are in Known limitations', gb && /counted one per play from nflverse play-by-play/.test(gb.lim) && /current-season sample is small/.test(gb.lim)
        && /league-wide flags are up in 2026 \(15\.0 a game, against 13\.1 over 2024–26\)/.test(gb.lim), gb && gb.lim);
      await shot(page, 'officiating_gb_det', '#fbg-nfl-2026_07_GB_DET');

      const cle = await block(page, '2026_07_CLE_TEN');
      chk('CLE @ TEN: Scott Novak, the most flags (21.33, rank 1 of 17)', /Officiating :: Scott Novak/.test(txt(cle)) && /Flags \/ game 2026 · 6 games :: 21\.33 \+6\.34 vs league 14\.99 · rank 1 of 17/.test(txt(cle)), txt(cle));
      const sf = await block(page, '2026_07_SF_ATL');
      chk('SF @ ATL: below the league average in --neg (Clay Martin, −3.49)', sf && sf.rows[1].colors[0][0] === '−3.49' && /var\(--neg\)/.test(sf.rows[1].colors[0][1]), sf && sf.rows[1]);

      const off = [];
      for (const r of w7) {
        const b = await block(page, r.game_id), t = txt(b);
        const want = ['Officiating :: ' + r.referee + ' ', 'Flags / game 2026 · ' + r.season_games + ' games :: ' + f2(r.season_flags_pg) + ' ' + signed(r.season_flags_vs_league) + ' vs league 14.99 · rank ' + r.flags_rank + ' of 17',
          'Holding / game 2026 · ' + r.season_games + ' games :: ' + f2(r.season_holding_pg) + ' ' + signed(r.season_holding_vs_league) + ' vs league 4.01 · rank ' + r.holding_rank + ' of 17',
          '3-season baseline 2024–2026 · ' + r.y3_games + ' games :: ' + f2(r.y3_flags_pg) + ' flags ' + signed(r.y3_flags_vs_league)];
        want.forEach((w) => { if (t.indexOf(w) < 0) off.push(r.game_id + ': ' + w); });
        if (/happy|tight|loose|lenient|strict|grade|score|edge|lean|over-friendly|under-friendly/i.test(t + (b && b.note))) off.push(r.game_id + ': a label word');
      }
      chk('every Week 7 card on the board: its referee and numbers exactly as the view has them, no label words (' + w7.length + ' games)', off.length === 0, off.slice(0, 4));

      const later = ids.filter((id) => !FIX.some((r) => r.game_id === id))[0] || W8;
      const nb = later ? await block(page, later) : null;
      chk('a game with no assignment reads "Assignment not announced", in the same block (' + later + ')', nb && nb.rows.length === 1 && nb.rows[0].l === 'Officiating' && nb.rows[0].v === 'Assignment not announced' && !/ref /i.test(nb.summary), nb);
      await ctx.close();
    }
    /* ------------------------------------------------------ PHONE */
    {
      const { ctx, page, errors } = await open({ width: 390, height: 900 }, 'deployed');
      await block(page, '2026_07_GB_DET');
      await page.waitForTimeout(150);
      const w = await page.evaluate(() => { const c = document.getElementById('fbg-nfl-2026_07_GB_DET'); const d = c && c.querySelector('.ms-wrap');
        return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, card: c ? c.scrollWidth - c.clientWidth : null, sec: d ? d.scrollWidth - d.clientWidth : null }; });
      chk('390 px phone: the open section never scrolls sideways', errors.length === 0 && w.sec !== null && w.sec <= 1 && w.card <= 1 && w.doc <= w.vw + 1, w);
      await shot(page, 'officiating_phone', '#fbg-nfl-2026_07_GB_DET');
      await ctx.close();
    }
    /* ------------------------------------------------- NOT DEPLOYED */
    {
      const { ctx, page, errors, asked } = await open({ width: 1280, height: 1400 }, 'absent');
      const b = await block(page, '2026_07_GB_DET');
      const db = await page.evaluate(() => window.ED_DB ? { ok: window.ED_DB.ok, where: window.ED_DB.where || null } : null);
      chk('not deployed: no page error, the view was asked for', errors.length === 0 && asked.length >= 1, { errors, asked });
      chk('not deployed: the block says Not deployed and names the file', b && b.rows.length === 1 && /NOT DEPLOYED/i.test(b.rows[0].v) && /nfl_ref_flags\.sql is not applied yet/.test(b.rows[0].v), b);
      chk('not deployed: the page\'s database health is not marked failing by the view', !db || db.ok !== false || !/nfl_game_ref_context/.test(String(db.where)), db);
      await ctx.close();
    }
    /* ------------------------------------------------------- FROZEN */
    if (!HEAD_APP) console.log('  note the committed app.html could not be read (git): the frozen comparison did not run');
    else {
      /* both pages read the same pinned instant: the decision id hashes
         evaluated_at, and quote ages and "refreshed … ago" are clock readings.
         Without a clock to pin (an old Playwright), those are masked instead. */
      const read = (page, pinned) => page.evaluate((pinned) => Array.from(document.querySelectorAll('#fbBody .mdl-card[id^="fbg-nfl-"]')).map((c) => {
        const x = c.cloneNode(true); x.querySelectorAll('.ms-wrap').forEach((n) => n.remove());
        if (pinned) return c.id + ' :: ' + x.innerText.replace(/\s+/g, ' ').trim();
        return c.id + ' :: ' + x.innerText.replace(/\bbd_[0-9a-f]+/g, 'bd_#').replace(/\b\d{1,2}:\d{2}( ?[AP]M)?/g, '#:#').replace(/\b\d+ ?(s|m|h|d|secs?|seconds?|mins?|minutes?|hours?|days?) (ago|old)/g, '# $2').replace(/\s+/g, ' ').trim();
      }), pinned);
      const A = await open({ width: 1280, height: 1400 }, 'deployed', '/app.head.html');
      const a = await read(A.page, A.pinned); await A.ctx.close();
      const B = await open({ width: 1280, height: 1400 }, 'deployed');
      const b = await read(B.page, B.pinned); await B.ctx.close();
      const diff = a.filter((x, i) => x !== b[i]);
      const at = (x) => { const y = b[a.indexOf(x)]; let i = 0; while (i < x.length && x[i] === y[i]) i++; return [x.slice(Math.max(0, i - 80), i + 60), y.slice(Math.max(0, i - 80), i + 60)]; };
      chk('frozen: the committed page and this one show the same ' + a.length + ' NFL cards, word for word, outside the Market Structure section', a.length > 0 && a.length === b.length && diff.length === 0,
        { a: a.length, b: b.length, n: diff.length, first: diff[0] && at(diff[0]) });
    }
  } catch (e) {
    if (String(e && e.message) !== 'skip') chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
    else { await browser.close(); srv.close(); process.exit(0); }
  } finally {
    await browser.close().catch(() => {}); srv.close();
  }
  finish();
})();
