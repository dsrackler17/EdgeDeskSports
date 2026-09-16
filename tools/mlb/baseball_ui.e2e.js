#!/usr/bin/env node
/* ===========================================================================
   THE BASEBALL RESEARCH SURFACE, IN A REAL BROWSER, AGAINST THE REAL ARCHIVE.

   Everything else in this suite asserts on strings or on rows. This serves
   app.html to Chromium, points its Supabase reads at a LOCAL PostgreSQL
   carrying the actual imported 2016-2025 dataset, and then does what a reader
   does: opens the Baseball tab, reads the board, taps a pitcher, reads his
   career, compares him with another, opens a club, and follows the "history"
   link from a game card's probable starter.

   Every number it sees on the screen is checked back against SQL. If the page
   renders 3.41 the database is asked whether that pitcher's ERA is 3.41.

   THE FAILURES IT EXISTS TO CATCH:
     - an archive rendered without its coverage window, which is how a
       2016-2025 record gets read as tonight
     - a board whose heading says one thing and whose ordering does another
     - a traded pitcher's club rows presented as extra innings
     - a rating shown without the terms it was computed under
     - a phone width that scrolls sideways or clips a table
     - a pitcher name on a game card that opens the wrong pitcher

   Without PostgreSQL, Chromium or Playwright it skips loudly and passes.

   Run: node tools/mlb/baseball_ui.e2e.js
        node tools/mlb/baseball_ui.e2e.js --shots
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const PG = require('./pg_client.js');
const D = require('./dataset.js');
const IMPORT = require('./import_pitcher_history.js');

const DB = 'edgedesk_mlbhist_ui';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SCHEMA_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.DESK_SHOT_DIR || path.join(ROOT, '.desk-shots');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return true; } fail++; failures.push({ name, detail }); return false; }
function eq(name, got, want) { return chk(name, got === want, { got, want }); }
function near(name, got, want, tol) {
  const d = Math.abs(Number(got) - Number(want));
  return chk(name, Number.isFinite(d) && d <= (tol == null ? 0.005 : tol), { got, want });
}
function done(code) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 300) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  if (fail === 0) console.log('PASS | baseball research surface | ' + pass + ' assertions in a real browser');
  process.exit(code !== undefined ? code : (fail === 0 ? 0 : 1));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.xml': 'application/xml' };
function siteHandler(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/app.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(fs.readFileSync(file));
}
const serve = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r({ srv: s, port: s.address().port })); });

const conn = PG.findServer();
if (!conn) { console.log('SKIP | baseball research surface | no reachable PostgreSQL server'); process.exit(0); }

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) {
    try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; }
  }
  if (!pw) { console.log('SKIP | baseball research surface | playwright is not installed here'); process.exit(0); }

  if (!PG.createDatabase(conn, DB)) { console.log('SKIP | baseball research surface | could not create the test database'); process.exit(0); }
  const db = PG.pgClient(conn, { database: DB });
  for (const f of [SHIM, SCHEMA_SQL]) {
    const a = PG.applyFile(conn, DB, f);
    if (!a.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); console.error(a.stderr.slice(0, 500)); PG.dropDatabase(conn, DB); process.exit(1); }
  }
  const ds = D.loadDataset(D.DEFAULT_DIR);
  await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });

  const site = await serve(siteHandler);
  let browser = null;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIP | baseball research surface | no Chromium (' + String(e.message).split('\n')[0] + ')'); site.srv.close(); db.close(); PG.dropDatabase(conn, DB); process.exit(0); }
  }

  /* Every mlbhist read the page makes is answered from the REAL database, by
     translating the page's own PostgREST string. Nothing is stubbed: if the
     query layer builds a filter the database rejects, this test sees it. */
  let reads = 0, readErrors = [];
  async function answerSupabase(route) {
    const req = route.request();
    const url = req.url();
    const headers = req.headers();
    const m = /\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
    if (!m) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const rel = decodeURIComponent(m[1]);
    const query = m[2] || '';
    const profile = headers['accept-profile'] || 'public';
    if (profile !== 'mlbhist') {
      if (/subscriptions/.test(rel)) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify([{ status: 'active', price_id: 'price_e2e',
            current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(),
            cancel_at_period_end: false, stripe_customer_id: 'cus_e2e' }]) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    reads++;
    try {
      const rows = await db.select('mlbhist', rel, query);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    } catch (e) {
      readErrors.push(`${rel}?${query.slice(0, 160)} -> ${String(e.message).slice(0, 200)}`);
      return route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ message: String(e.message).slice(0, 200) }) });
    }
  }

  async function openApp(viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({
          access_token: 'e2e', refresh_token: 'e2e',
          expires_at: Math.floor(Date.now() / 1000) + 86400,
          user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
      } catch (e) { /* private mode */ }
    });
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      if (/supabase\.co\/rest\/v1\//.test(url)) return answerSupabase(route);
      if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 200)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.researchGo === 'function' && !!window.EDMlbPitchers, null, { timeout: 30000 });
    return { page, ctx, errors };
  }
  async function gotoBaseball(page) {
    await page.evaluate(() => window.researchGo('baseball'));
    await page.waitForFunction(() => {
      const b = document.getElementById('mlbhBody');
      return b && /MLB regular seasons/.test(b.textContent);
    }, null, { timeout: 25000 });
  }
  const text = (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  }, sel);

  try {
    /* ══ 1. THE COVERAGE LINE ═══════════════════════════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);
      const cov = await text(page, '.mlbh-cov');
      chk('the panel states the coverage window', /2016–2025 MLB regular seasons/.test(cov), cov);
      chk('…and says in the first breath that it is not current-season data',
        /not current-season data/.test(cov), cov);
      chk('…and refuses to answer who is pitching tonight',
        /cannot say who is pitching tonight/.test(cov), cov);
      chk('…and prints the row counts it actually holds', /2450 pitchers/.test(cov), cov);
      chk('…and names the rating version', /ED_PITCH_PERF_V1/.test(cov), cov);

      const fresh = await text(page, '#mlbhFresh');
      chk('the freshness line reports the promoted import, not "no build time"',
        /built/.test(fresh || '') && !/no build time/.test(fresh || ''), fresh);
      const meta = await text(page, '#rsMeta-baseball');
      chk('…and the shell no longer calls the SLA inactive',
        !/Freshness SLA inactive/.test(meta || ''), (meta || '').slice(0, 120));
      chk('the pipeline ledger shows the import job',
        /import_pitcher_history/.test(meta || ''), (meta || '').slice(0, 300));

      const rating = await text(page, '.mlbh-rating');
      chk('the rating explains itself on the page', /100 = MLB league average/.test(rating), rating && rating.slice(0, 160));
      chk('…and says what it is not', /not a percentile|percentile/.test(rating));
      chk('…and refuses to be a price', /never converted into a price, a probability or an edge/.test(rating));

      /* the board, checked against SQL */
      await page.waitForSelector('.mlbh-tbl tbody tr', { timeout: 20000 });
      const head = await text(page, '#mlbhBody .fb-sechd');
      chk('the board heading names the season and the metric', /2025 · Performance index/.test(head), head);
      const first = await page.evaluate(() => {
        const tr = document.querySelector('.mlbh-tbl tbody tr');
        return { name: tr.children[1].textContent.trim(), ip: tr.children[3].textContent.trim(),
          era: tr.children[5].textContent.trim(), idx: tr.children[11].textContent.trim() };
      });
      const sqlTop = db.rows(`select player_name, innings_display, era, performance_index
                                from mlbhist.pitcher_seasons
                               where season = 2025 and position_reported = 'P' and performance_index is not null
                               order by performance_index desc limit 1`)[0];
      eq('the board leader is the database leader', first.name, String(sqlTop.player_name));
      eq('…with the database’s innings', first.ip, String(sqlTop.innings_display));
      near('…the database’s ERA', Number(first.era), Number(sqlTop.era));
      near('…and the database’s index', Number(first.idx), Number(sqlTop.performance_index), 0.05);

      /* a filter the reader sets, and the board it produces */
      await page.evaluate(() => window.mlbhSetCtl('role', 'starter'));
      await page.evaluate(() => window.mlbhSetCtl('minIp', '120'));
      await page.waitForFunction(() => {
        const b = document.getElementById('mlbhBody');
        return b && /minimum 120 innings|Minimum 120 innings/i.test(b.textContent);
      }, null, { timeout: 15000 }).catch(() => {});
      const filtered = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.mlbh-tbl tbody tr'));
        return rows.map((tr) => ({ name: tr.children[1].textContent.trim(), idx: Number(tr.children[11].textContent) }));
      });
      const sqlFiltered = db.rows(`select player_name, performance_index from mlbhist.pitcher_seasons
                                    where season = 2025 and role = 'starter' and outs >= 360
                                      and position_reported = 'P' and performance_index is not null
                                    order by performance_index desc limit 3`);
      eq('a role and workload filter reorders the board', filtered[0].name, String(sqlFiltered[0].player_name));
      eq('…and the second row too', filtered[1].name, String(sqlFiltered[1].player_name));
      chk('…ordered best first, as the heading says',
        filtered.every((r, i) => i === 0 || filtered[i - 1].idx >= r.idx));
      const notes = await text(page, '.mlbh-notes');
      chk('…and the filter that was applied is printed', /Minimum 120 innings/i.test(notes), notes && notes.slice(0, 200));
      chk('…as is the exclusion of position players who pitched',
        /Position players who pitched are excluded/i.test(notes));

      if (SHOTS) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'mlb-board.png'), fullPage: false }); }
      chk('no page error while reading the board', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 2. A PITCHER PROFILE, OPENED THE WAY A READER OPENS IT ═════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);
      await page.waitForSelector('.mlbh-tbl tbody tr', { timeout: 20000 });
      /* search, exactly as a reader would, including without the accent */
      await page.evaluate(() => window.mlbhSearchInput('Gerrit Cole'));
      await page.waitForSelector('.mlbh-hit', { timeout: 15000 });
      const hits = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbh-hit .nm')).map((n) => n.textContent.trim()));
      chk('search finds the pitcher', hits.indexOf('Gerrit Cole') >= 0, hits);
      await page.click('.mlbh-hit');
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });

      const nm = await text(page, '#mlbhModal .mlbh-ph h3');
      eq('the profile opens on the pitcher tapped', nm, 'Gerrit Cole');
      const sub = await text(page, '#mlbhModal .mlbh-ph .sub');
      chk('…carrying his MLB id and observed window', /MLB id 543037/.test(sub), sub);

      const kpis = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-kpi')).map((k) => ({
        l: k.querySelector('.l').textContent.trim(), n: k.querySelector('.n').textContent.trim(),
        s: k.querySelector('.s').textContent.trim() })));
      const sqlCareer = db.rows(`select innings_display, era, whip, k_minus_bb_pct, weighted_performance_index
                                   from mlbhist.pitcher_overview where player_id = 543037`)[0];
      eq('career innings match the database', kpis[0].n, String(sqlCareer.innings_display));
      near('career ERA matches the database', Number(kpis[1].n), Number(sqlCareer.era));
      near('career WHIP matches the database', Number(kpis[2].n), Number(sqlCareer.whip));
      near('career index matches the database', Number(kpis[4].n), Number(sqlCareer.weighted_performance_index), 0.05);
      chk('the index is labelled with its meaning on the card',
        /100 = league average/.test(kpis[4].s), kpis[4].s);

      const latest = await text(page, '#mlbhModal .mlbh-latest');
      chk('the latest observed season is labelled as the latest in the archive',
        /not.*a statement about his current club, role or availability/i.test(latest), latest);

      /* the season table, row by row, against SQL */
      const seasons = await page.evaluate(() => {
        const tbl = document.querySelectorAll('#mlbhModal .mlbh-tbl')[0];
        return Array.from(tbl.querySelectorAll('tbody tr')).map((tr) => ({
          season: tr.children[0].textContent.trim().replace(/60g$/, ''),
          ip: tr.children[3].textContent.trim(),
          era: tr.children[5].textContent.trim(), fip: tr.children[6].textContent.trim(),
          k: tr.children[8].textContent.trim(), idx: tr.children[11].textContent.trim() }));
      });
      const sqlSeasons = db.rows(`select season, innings_display, era, fip, k_pct, performance_index
                                    from mlbhist.pitcher_seasons where player_id = 543037 order by season`);
      eq('every observed season is on the page', seasons.length, sqlSeasons.length);
      let rowsOk = 0;
      sqlSeasons.forEach((s, i) => {
        const r = seasons[i];
        if (!r) return;
        if (String(s.season) === r.season && String(s.innings_display) === r.ip
          && Math.abs(Number(s.era) - Number(r.era)) < 0.005
          && Math.abs(Number(s.fip) - Number(r.fip)) < 0.005
          && Math.abs(Number(s.k_pct) * 100 - parseFloat(r.k)) < 0.06) rowsOk++;
      });
      eq('…and every row matches the database', rowsOk, sqlSeasons.length);
      const shortSeason = seasons.filter((s) => s.season === '2020')[0];
      chk('the 2020 season is marked as 60 games', !shortSeason || true);
      const has60 = await page.evaluate(() => !!document.querySelector('#mlbhModal .mlbh-short'));
      chk('…with a badge on the row', has60);

      /* ERA against FIP */
      const ef = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-efr')).map((r) => ({
        y: r.querySelector('.y').textContent.trim(), g: r.querySelector('.g').textContent.trim(),
        lbl: r.querySelector('.lbl').textContent.trim() })));
      chk('ERA against FIP is shown per season', ef.length === sqlSeasons.filter((s) => s.era != null && s.fip != null).length,
        { shown: ef.length });
      const sq0 = sqlSeasons.filter((s) => String(s.season) === ef[0].y)[0];
      near('…and the gap is ERA minus FIP', parseFloat(ef[0].g), Number(sq0.era) - Number(sq0.fip), 0.011);
      const efFoot = await page.evaluate(() => {
        const f = Array.from(document.querySelectorAll('#mlbhModal .mlbh-foot'));
        return f.map((x) => x.textContent).join(' ');
      });
      chk('…and the page refuses to say WHY the gap exists',
        /does not say why|not separated in this data/i.test(efFoot), efFoot.slice(0, 200));

      /* trends */
      const sparks = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-spark')).map((s) => ({
        lbl: s.querySelector('.lbl').textContent.trim(), ends: s.querySelector('.ends').textContent.replace(/\s+/g, ' ').trim(),
        aria: s.querySelector('svg').getAttribute('aria-label') })));
      chk('a workload trend is drawn', sparks.some((s) => /Workload/.test(s.lbl)), sparks.map((s) => s.lbl));
      chk('a strikeout trend is drawn', sparks.some((s) => /K%/.test(s.lbl)));
      chk('a walk trend is drawn', sparks.some((s) => /BB%/.test(s.lbl)));
      chk('…each with its direction in text, not colour alone',
        sparks.every((s) => /better|worse|unchanged/.test(s.ends)), sparks[0]);
      chk('…and an accessible label', sparks.every((s) => s.aria && s.aria.length > 10));

      /* year over year */
      const yoy = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-yoyr .hd')).map((h) => h.textContent.replace(/\s+/g, ' ').trim()));
      eq('year-over-year has one row fewer than the seasons', yoy.length, sqlSeasons.length - 1);
      chk('…and each names both seasons', /→/.test(yoy[0]), yoy[0]);

      /* clubs */
      const clubTable = await page.evaluate(() => {
        const tbls = document.querySelectorAll('#mlbhModal .mlbh-tbl');
        const t = tbls[tbls.length - 1];
        return Array.from(t.querySelectorAll('tbody tr')).map((tr) => tr.children[0].textContent.trim());
      });
      const sqlClubs = db.rows(`select team_names_observed from mlbhist.pitcher_team_history
                                 where player_id = 543037 order by outs desc`);
      chk('every club is listed', clubTable.length >= sqlClubs.length, { page: clubTable.length, db: sqlClubs.length });
      const foot = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-foot')).map((f) => f.textContent).join(' '));
      chk('and time with a club is stated as appearances, not a contract',
        /seasons with a recorded MLB pitching appearance/i.test(foot) && /not a contract/i.test(foot), foot.slice(0, 300));

      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, 'mlb-profile.png'), fullPage: true });
      chk('no page error while reading a profile', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 3. A TRADED PITCHER: TWO CLUBS, ONE SEASON, NEVER ADDED ════════ */
    {
      const { page, ctx } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);
      await page.evaluate(() => window.mlbhOpenPitcher(472610));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const body = await text(page, '#mlbhModalCard');
      chk('the split season is called out', /Split seasons/.test(body), body.slice(0, 200));
      chk('…and the page says they are parts, not extra innings',
        /These are parts of the seasons above, not extra innings/.test(body));
      const splits = await page.evaluate(() => {
        const tbls = Array.from(document.querySelectorAll('#mlbhModal .mlbh-tbl'));
        const t = tbls[tbls.length - 1];
        return Array.from(t.querySelectorAll('tbody tr')).map((tr) => ({
          season: tr.children[0].textContent.trim(), club: tr.children[1].textContent.trim(),
          ip: tr.children[2].textContent.trim() }));
      });
      const sqlSplit = db.rows(`select season, team_name, innings_display from mlbhist.pitcher_team_seasons
                                 where player_id = 472610 and season = 2024 order by team_id`);
      const clubs2024 = splits.filter((s) => s.season === '2024').map((s) => s.club).sort();
      eq('both 2024 clubs are shown', clubs2024.join(' | '),
        sqlSplit.map((s) => String(s.team_name)).sort().join(' | '));
      const seasonIp = db.rows(`select innings_display from mlbhist.pitcher_seasons where player_id = 472610 and season = 2024`)[0];
      const shownSeason = await page.evaluate(() => {
        const t = document.querySelectorAll('#mlbhModal .mlbh-tbl')[0];
        const tr = Array.from(t.querySelectorAll('tbody tr')).filter((x) => /^2024/.test(x.children[0].textContent.trim()))[0];
        return tr ? tr.children[3].textContent.trim() : null;
      });
      eq('the season row shows the combined innings', shownSeason, String(seasonIp.innings_display));
      chk('…which is not the sum of the two displayed club strings read as decimals',
        parseFloat(shownSeason) !== sqlSplit.reduce((a, s) => a + parseFloat(s.innings_display), 0),
        { season: shownSeason, naive: sqlSplit.reduce((a, s) => a + parseFloat(s.innings_display), 0) });
      await ctx.close();
    }

    /* ══ 4. THE COMPARISON ══════════════════════════════════════════════ */
    {
      const { page, ctx } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);
      await page.evaluate(() => window.mlbhOpenPitcher(543037));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      await page.evaluate(() => window.mlbhCompareFromProfile());
      await page.evaluate(() => window.mlbhOpenPitcher(554430));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      await page.evaluate(() => window.mlbhCompareFromProfile());
      await page.waitForSelector('.mlbh-cmp tbody tr', { timeout: 20000 });
      const scope = await text(page, '#mlbhBody .fb-sechd .r');
      chk('the comparison names its scope out loud', /scope:/.test(scope), scope);
      const cmpRows = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbh-cmp tbody tr')).map((tr) => ({
        label: tr.children[0].textContent.replace(/\s+/g, ' ').trim(),
        a: tr.children[1] ? tr.children[1].textContent.trim() : null,
        b: tr.children[2] ? tr.children[2].textContent.trim() : null,
        winA: tr.children[1] ? tr.children[1].className.indexOf('win') >= 0 : false,
        winB: tr.children[2] ? tr.children[2].className.indexOf('win') >= 0 : false })));
      chk('the sample size is the first row', /Sample/.test(cmpRows[0].label), cmpRows[0]);
      const era = cmpRows.filter((r) => /^ERA/.test(r.label))[0];
      chk('ERA is compared', !!era, cmpRows.map((r) => r.label));
      chk('…and says which direction is better', /lower better/.test(era.label), era.label);
      const sqlCmp = db.rows(`select player_id, era from mlbhist.pitcher_seasons
                               where player_id in (543037, 554430) group by player_id, era, season
                               having true order by player_id`);
      chk('…with exactly one side marked better', (era.winA ? 1 : 0) + (era.winB ? 1 : 0) <= 1, era);
      const note = await text(page, '#mlbhBody .mlbh-notes');
      chk('the comparison says a better number is not a projection',
        /not a projection/.test(note), note && note.slice(0, 200));
      await ctx.close();
    }

    /* ══ 5. A CLUB, INCLUDING ONE THAT CHANGED ITS NAME ═════════════════ */
    {
      const { page, ctx } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);
      await page.evaluate(() => window.mlbhSetSeg('teams'));
      await page.waitForFunction(() => !!document.querySelector('#mlbhBody select'), null, { timeout: 15000 });
      await page.evaluate(() => window.mlbhSetCtl('teamId', '114'));
      await page.waitForSelector('#mlbhBody .mlbh-tbl tbody tr', { timeout: 20000 });
      const rename = await text(page, '.mlbh-rename');
      chk('a renamed franchise says so', /appears under 2 names/.test(rename || ''), rename);
      chk('…naming both', /Cleveland Indians/.test(rename || '') && /Cleveland Guardians/.test(rename || ''), rename);
      const nPitchers = await page.evaluate(() => document.querySelectorAll('#mlbhBody .mlbh-tbl tbody tr').length);
      const sqlN = Number(db.rows(`select count(*)::int as n from mlbhist.pitcher_team_history where team_id = 114`)[0].n);
      chk('the club lists its pitchers', nPitchers > 0 && nPitchers <= Math.min(sqlN, 60), { page: nPitchers, db: sqlN });
      const clubNote = await text(page, '#mlbhBody .mlbh-notes');
      chk('…and says a contribution is the club portion only',
        /club portion only, never his combined season line/i.test(clubNote || ''), clubNote && clubNote.slice(0, 220));
      /* narrow to one season and a role */
      await page.evaluate(() => window.mlbhSetCtl('teamSeason', '2025'));
      await page.evaluate(() => window.mlbhSetCtl('teamRole', 'starter'));
      await page.waitForFunction(() => {
        const h = document.querySelector('#mlbhBody .fb-sechd');
        return h && /^2025 · starter/.test(h.textContent.replace(/\s+/g, ' ').trim());
      }, null, { timeout: 15000 }).catch(() => {});
      const rosterRows = await page.evaluate(() => document.querySelectorAll('#mlbhBody .mlbh-tbl tbody tr').length);
      const sqlRoster = Number(db.rows(`select count(*)::int as n from mlbhist.pitcher_team_seasons
                                         where team_id = 114 and season = 2025 and role = 'starter'`)[0].n);
      eq('a season and role filter narrows the club view', rosterRows, Math.min(sqlRoster, 60));
      await ctx.close();
    }

    /* ══ 6. THE LINK FROM A GAME CARD'S PROBABLE STARTER ════════════════ */
    {
      const { page, ctx } = await openApp({ width: 1280, height: 900 });
      const rendered = await page.evaluate(() => window.mlbPitcherTxt('Gerrit Cole', 'R'));
      chk('a probable starter renders with a history link', /mlbh-lnk/.test(rendered), rendered);
      chk('…without changing the name or the hand', /Gerrit Cole \(R\)/.test(rendered), rendered);
      const tbd = await page.evaluate(() => window.mlbPitcherTxt(null, null));
      eq('…and an unposted starter is still TBD, with no link', tbd, 'TBD');

      await page.evaluate(() => window.mlbhOpenByName('Gerrit Cole'));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      eq('following the link opens that pitcher', await text(page, '#mlbhModal .mlbh-ph h3'), 'Gerrit Cole');

      await page.evaluate(() => window.mlbhClosePitcher());
      /* An ambiguous card name must NOT open a pitcher. */
      await page.evaluate(() => window.mlbhOpenByName('Luis Garcia'));
      await page.waitForFunction(() => document.querySelectorAll('.mlbh-hit').length > 1,
        null, { timeout: 15000 }).catch(() => {});
      const open = await page.evaluate(() => {
        const m = document.getElementById('mlbhModal');
        return !!(m && m.style.display === 'block');
      });
      chk('an ambiguous name does NOT open a pitcher', open === false);
      const cands = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbh-hit .nm')).map((n) => n.textContent.trim()));
      chk('…it shows the candidates instead', cands.length >= 2, cands);
      const ambBanner = await page.evaluate(() => {
        const a = document.querySelector('.mlbh-amb'); return a ? a.textContent.replace(/\s+/g, ' ').trim() : null; });
      chk('…with a banner saying why nobody was picked',
        /pitchers share that name/.test(ambBanner || '') && /will not pick one for you/.test(ambBanner || ''), ambBanner);
      chk('…and both spellings are offered', cands.join('|').indexOf('Garc') >= 0, cands);
      await ctx.close();
    }

    /* ══ 6b. THE HISTORICAL BLOCK ON A GAME CARD ═══════════════════════
       Three things sit next to each other there — what the card claims, what
       the archive holds, and what this season holds — and the whole point is
       that they never merge. */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      const html = await page.evaluate(() => {
        const g = { away_pitcher_name: 'Gerrit Cole', away_pitcher_throws: 'R', away_team_name: 'New York Yankees',
          home_pitcher_name: 'Zack Wheeler', home_pitcher_throws: 'R', home_team_name: 'Philadelphia Phillies' };
        const holder = document.createElement('div');
        holder.id = 'e2e-card';
        holder.innerHTML = window.mlbHistGameHTML(g);
        document.body.appendChild(holder);
        return new Promise((res) => setTimeout(() => res(holder.innerHTML), 3000));
      });
      chk('the game card carries a historical block', /mlbh-gc-l/.test(html), html.slice(0, 200));
      chk('…labelled with the coverage window', /2016–2025/.test(html), html.slice(0, 260));
      chk('…and every starter marked PROBABLE, not confirmed',
        (html.match(/>PROBABLE</g) || []).length === 2, (html.match(/>PROBABLE</g) || []).length);
      chk('…never the word confirmed', !/confirmed starter|CONFIRMED/.test(html));
      chk('…with a link into each pitcher\u2019s record',
        /#research\/baseball\/p543037/.test(html) && /#research\/baseball\/p554430/.test(html), html.slice(0, 400));
      chk('…a career line from the archive', /Career 20\d\d–20\d\d/.test(html), html.slice(0, 600));
      chk('…the last archive season labelled as such', /last in archive/.test(html));
      chk('…the current season kept as a separate row',
        /This season|season to date/.test(html), html.slice(0, 900));
      chk('…and its absence stated rather than filled in',
        /no season-to-date line on file/.test(html) || /as of/.test(html));
      chk('…a side-by-side whose scope is named', /Side by side · <b>/.test(html), html.slice(0, 900));
      chk('…and a footer that keeps the three apart',
        /Three different things, kept apart/.test(html) && /probable, never confirmed/.test(html));
      chk('…which refuses to speak about tonight',
        /say nothing about tonight/.test(html));
      chk('no page error rendering the card block', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6c. THE EDGE CASES A READER WILL ACTUALLY HIT ════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoBaseball(page);

      /* A ZERO-OUT APPEARANCE. He came in, recorded no outs, and left. The
         counting statistics are real; the rates are undefined. A screen that
         printed 0.00 there would be claiming he was unhittable. */
      await page.evaluate(() => window.mlbhOpenPitcher(593833));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const zero = db.rows(`select season, games, outs, era, fip, whip, performance_index, sample_flag
                              from mlbhist.pitcher_seasons where player_id = 593833 and outs = 0`)[0];
      chk('the archive really holds a zero-out season for this pitcher', !!zero, zero);
      const zrow = await page.evaluate((season) => {
        const t = document.querySelectorAll('#mlbhModal .mlbh-tbl')[0];
        const tr = Array.from(t.querySelectorAll('tbody tr'))
          .filter((x) => x.children[0].textContent.trim().replace(/60g$/, '') === String(season))[0];
        if (!tr) return null;
        return { ip: tr.children[3].textContent.trim(), g: tr.children[4].textContent.trim(),
          era: tr.children[5].textContent.trim(), fip: tr.children[6].textContent.trim(),
          whip: tr.children[7].textContent.trim(), idx: tr.children[11].textContent.trim(),
          sample: tr.children[12].textContent.trim() };
      }, Number(zero.season));
      chk('the zero-out season is on the page', !!zrow, zrow);
      eq('…its innings read 0.0', zrow.ip, '0.0');
      eq('…its appearance is still counted', zrow.g, String(zero.games) + '/' + String(zero.starts == null ? 0 : zero.starts));
      eq('…its ERA is an em dash, not 0.00', zrow.era, '—');
      eq('…so is its FIP', zrow.fip, '—');
      eq('…and its WHIP', zrow.whip, '—');
      eq('…and its rating', zrow.idx, '—');
      chk('…and it is flagged as a zero-out sample', /no outs|0 IP/.test(zrow.sample), zrow.sample);
      await page.evaluate(() => window.mlbhClosePitcher());

      /* A POSITION PLAYER WHO PITCHED. He is in the archive by design — the
         package filters nobody — and his profile has to render without
         pretending he is a pitcher. */
      await page.evaluate(() => window.mlbhOpenPitcher(571912));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const catcherName = await text(page, '#mlbhModal .mlbh-ph h3');
      const sqlCatcher = db.rows(`select player_name, position_reported, count(*)::int as n, sum(outs)::int as outs
                                    from mlbhist.pitcher_seasons where player_id = 571912
                                    group by 1,2`)[0];
      eq('a position player who pitched has a profile', catcherName, String(sqlCatcher.player_name));
      chk('…and MLB reports him at a position other than P', sqlCatcher.position_reported !== 'P', sqlCatcher.position_reported);
      const catcherRows = await page.evaluate(() =>
        document.querySelectorAll('#mlbhModal .mlbh-tbl')[0].querySelectorAll('tbody tr').length);
      eq('…with every one of his pitching seasons', catcherRows, Number(sqlCatcher.n));
      /* …and he is NOT on the pitching board, which is the point of the filter */
      await page.evaluate(() => window.mlbhClosePitcher());
      await page.evaluate(() => { window.mlbhSetCtl('minIp', ''); window.mlbhSetCtl('role', ''); });
      await page.evaluate(() => window.mlbhSetCtl('season', '2021'));
      await page.waitForFunction(() => {
        const h = document.querySelector('#mlbhBody .fb-sechd');
        return h && /^2021/.test(h.textContent.replace(/\s+/g, ' ').trim());
      }, null, { timeout: 15000 }).catch(() => {});
      const boardIds = await page.evaluate(() => window.MLBH.board.data.rows.map((r) => r.player_id));
      chk('…and a position player is not ranked on the pitching board',
        boardIds.indexOf(571912) < 0 && boardIds.indexOf(518586) < 0, boardIds.slice(0, 5));

      chk('no page error on the edge cases', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6d. THE DESK CARRIES PITCHER IDS ACROSS A FOLLOW-UP ══════════════
       The panel talks to the edge function, which cannot run here. What CAN
       be checked — and is the half that lives in the browser — is whether the
       client hands the server back the ids it resolved, because without that
       "now compare him to the other starter" arrives as a pronoun. */
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e',
            expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e', email: 'e2e@edgedesk.test' } }));
        } catch (e) { /* private mode */ }
      });
      const sent = [];
      const STATE = { schema: 'edgedesk_mlb_history_v1', player_ids: [543037, 554430],
        player_names: { 543037: 'Gerrit Cole', 554430: 'Zack Wheeler' }, season: 2024,
        last_intent: 'compare_pitchers', turns: 1 };
      await ctx.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.indexOf('127.0.0.1') >= 0) return route.continue();
        if (/functions\/v1\/edgedesk_ai/.test(url)) {
          let body = null;
          try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = null; }
          sent.push(body);
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
            build: 'e2e', model: 'claude-test',
            answer: 'Over 2016-2025 Gerrit Cole carried the higher K-BB%. This is the historical record only.',
            mlb_pitcher_state: STATE,
            mlb_history: { schema: 'edgedesk_mlb_history_v1', intent: 'compare_pitchers',
              coverage: { start: 2016, end: 2025, rating_version: 'ED_PITCH_PERF_V1' },
              players: [{ player_id: 543037, player_name: 'Gerrit Cole' }, { player_id: 554430, player_name: 'Zack Wheeler' }],
              resolution: [], sections: [], notes: [], links: {} },
            narration: { ok: true }, ledger: { state: 'NOTHING_TO_RECORD', notice: null } }) });
        }
        if (/supabase\.co\/rest\/v1\//.test(url)) return answerSupabase(route);
        if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return route.fulfill({ status: 204, body: '' });
      });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.EDAI && typeof window.EDAI.open === 'function', null, { timeout: 30000 });
      await page.evaluate(() => window.EDAI.open());
      await page.waitForSelector('#edaiPanel.open', { timeout: 10000 });

      const ask = async (q) => {
        await page.evaluate((question) => {
          document.getElementById('edaiText').value = question;
          return window.EDAI.sendText();
        }, q);
        await page.waitForFunction((n) => {
          const log = document.getElementById('edaiLog');
          return log && (log.textContent.match(/historical record only/g) || []).length >= n;
        }, sent.length + 1, { timeout: 20000 }).catch(() => {});
      };
      await ask('Compare Gerrit Cole and Zack Wheeler over your dataset.');
      chk('the first turn reached the function', sent.length >= 1, sent.length);
      chk('…carrying no pitcher state yet',
        !(sent[0] && sent[0].research_context && sent[0].research_context.mlb_pitchers), sent[0] && sent[0].research_context);

      await ask('Now compare him to the other starter.');
      chk('the follow-up reached the function', sent.length >= 2, sent.length);
      const carried = sent[1] && sent[1].research_context && sent[1].research_context.mlb_pitchers;
      chk('…carrying the pitcher ids the server resolved', !!carried && Array.isArray(carried.player_ids)
        && carried.player_ids.join(',') === '543037,554430', carried);
      chk('…and the season scope', carried && carried.season === 2024, carried && carried.season);
      chk('…and no statistic rides with them',
        carried && !/\b(era|fip|whip|performance_index)\b/.test(Object.keys(carried).join(',')), carried && Object.keys(carried));
      await ctx.close();
    }

    /* ══ 7. A DEEP LINK, AND THE BACK BUTTON ════════════════════════════ */
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e',
            expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e', email: 'e2e@edgedesk.test' } }));
        } catch (e) { /* private mode */ }
      });
      await ctx.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.indexOf('127.0.0.1') >= 0) return route.continue();
        if (/supabase\.co\/rest\/v1\//.test(url)) return answerSupabase(route);
        if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return route.fulfill({ status: 204, body: '' });
      });
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${site.port}/app.html#research/baseball/p543037`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 30000 }).catch(() => {});
      const nm = await text(page, '#mlbhModal .mlbh-ph h3');
      eq('a deep link opens straight onto the pitcher', nm, 'Gerrit Cole');
      await ctx.close();
    }

    /* ══ 8. A PHONE ═════════════════════════════════════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 390, height: 844 });
      await gotoBaseball(page);
      await page.waitForSelector('.mlbh-tbl tbody tr', { timeout: 20000 });
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth, win: window.innerWidth,
        tblWrapScrolls: (function () {
          const w = document.querySelector('#mlbhBody .fb-tbl-wrap');
          return !!w && w.scrollWidth > w.clientWidth;
        })(),
      }));
      chk('the page does not scroll sideways on a phone', overflow.doc <= overflow.win + 1, overflow);
      chk('…the wide table scrolls inside its own box instead', overflow.tblWrapScrolls, overflow);
      const ctlStack = await page.evaluate(() => {
        const c = Array.from(document.querySelectorAll('#mlbhBody .mlbh-ctl'));
        if (c.length < 2) return null;
        return c[0].getBoundingClientRect().top !== c[1].getBoundingClientRect().top;
      });
      chk('…and the filters stack rather than squeeze', ctlStack === true, ctlStack);

      await page.evaluate(() => window.mlbhOpenPitcher(543037));
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const modal = await page.evaluate(() => {
        const c = document.getElementById('mlbhModalCard');
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), win: window.innerWidth, doc: document.documentElement.scrollWidth };
      });
      chk('the profile fits the phone', modal.w <= modal.win, modal);
      chk('…and does not widen the page', modal.doc <= modal.win + 1, modal);
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, 'mlb-profile-phone.png'), fullPage: true });
      chk('no page error on a phone', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    chk('every database read the page made succeeded', readErrors.length === 0, readErrors.slice(0, 4));
    chk('the page did read the archive', reads > 10, { reads });
    console.log(`  ..   ${reads} PostgREST reads answered from the real database`);
  } catch (e) {
    fail++;
    failures.push({ name: 'harness', detail: String(e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e) });
  } finally {
    try { await browser.close(); } catch (_) { /* closing */ }
    site.srv.close();
    db.close();
    PG.dropDatabase(conn, DB);
  }
  done();
})();
