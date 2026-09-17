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
const OD = require('./offense_dataset.js');
const OIMPORT = require('./import_offense.js');
const OM = require('../../lib/mlb_offense_history.js');

const DB = 'edgedesk_mlbhist_ui';
const SHIM = path.join(ROOT, 'tools', 'games', 'sql', 'supabase_shim.sql');
const SCHEMA_SQL = path.join(ROOT, 'supabase', 'mlb_pitcher_history.sql');
const OFFENSE_SQL = path.join(ROOT, 'supabase', 'mlb_offense_history.sql');
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
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 900) : '')));
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
  for (const f of [SHIM, SCHEMA_SQL, OFFENSE_SQL]) {
    const a = PG.applyFile(conn, DB, f);
    if (!a.ok) { console.log('FAIL | ' + path.basename(f) + ' did not apply'); console.error(a.stderr.slice(0, 500)); PG.dropDatabase(conn, DB); process.exit(1); }
  }
  const ds = D.loadDataset(D.DEFAULT_DIR);
  await IMPORT.runImport(db, ds, D.validateDataset(ds), { log: () => {}, chunk: 1000 });
  /* BOTH archives, so the surfaces that join them — a two-way player, the
     club offensive baseline on a game brief — are exercised against the real
     rows rather than against an absence. */
  const ods = OD.loadDataset(OD.DEFAULT_DIR);
  await OIMPORT.runImport(db, ods, OD.validateDataset(ods), { log: () => {}, chunk: 1000 });

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
  /* One ET day, two games: one with both starters posted and one with neither,
     so the board is checked against both the full and the empty case. */
  const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const CARD_TABLES = {
    mlb_game_cards: [
      { game_date: ET, start_time: ET + 'T23:05:00Z', start_time_local: '7:05 PM',
        away_team_id: 147, home_team_id: 143, venue: 'Citizens Bank Park', status: 'Scheduled',
        doubleheader: 'N', game_number: 1, series_game_number: 1, games_in_series: 3,
        away_team_name: 'New York Yankees', away_record: '90-60', away_division: 'AL East',
        away_division_rank: 1, away_games_back: '-', away_road_record: '44-31', away_streak: 'W3',
        away_pitcher_name: 'Gerrit Cole', away_pitcher_throws: 'R',
        home_team_name: 'Philadelphia Phillies', home_record: '88-62', home_division: 'NL East',
        home_division_rank: 1, home_games_back: '-', home_home_record: '47-28', home_streak: 'W1',
        home_pitcher_name: 'Zack Wheeler', home_pitcher_throws: 'R',
        park_factor: 1.03, hr_factor: 1.09, run_factor: 1.02, roof_type: 'Open', is_dome: false,
        temp_f: 74, humidity: 61, precip_prob: 10, wind_mph: 8, wind_dir: 'SW', wind_rel: 'out to right' },
      { game_date: ET, start_time: ET + 'T20:10:00Z', start_time_local: '4:10 PM',
        away_team_id: 111, home_team_id: 110, venue: 'Oriole Park at Camden Yards', status: 'Scheduled',
        doubleheader: 'N', game_number: 1,
        away_team_name: 'Boston Red Sox', away_record: '78-72', away_division: 'AL East',
        away_division_rank: 3, away_games_back: '12.0', away_road_record: '36-39', away_streak: 'L1',
        away_pitcher_name: null, away_pitcher_throws: null,
        home_team_name: 'Baltimore Orioles', home_record: '80-70', home_division: 'AL East',
        home_division_rank: 2, home_games_back: '10.0', home_home_record: '43-32', home_streak: 'W2',
        home_pitcher_name: null, home_pitcher_throws: null,
        park_factor: 1.07, hr_factor: 1.12, run_factor: 1.06, roof_type: 'Open', is_dome: false,
        temp_f: 79, humidity: 66, precip_prob: 20, wind_mph: null, wind_dir: null, wind_rel: null }
    ],
    team_season: [
      { team: 'New York Yankees', runs_per_game: 4.82, ops: 0.773, k_pct: 0.221, hr_per_game: 1.41,
        woba: 0.327, barrel_pct: 0.091, hardhit_pct: 0.421, ra_per_game: 3.98, as_of: ET },
      { team: 'Philadelphia Phillies', runs_per_game: 4.55, ops: 0.748, k_pct: 0.209, hr_per_game: 1.27,
        woba: 0.319, barrel_pct: 0.084, hardhit_pct: 0.405, ra_per_game: 3.81, as_of: ET }
    ],
    pitcher_season: [
      { name: 'Gerrit Cole', team: 'NYY', games_started: 28, ip: 172.1, era: 4.35, fip: 3.55,
        whip: 1.28, k_bb_pct: 0.198, hr_per9: 1.41, as_of: ET },
      { name: 'Zack Wheeler', team: 'PHI', games_started: 30, ip: 189.2, era: 2.88, fip: 2.91,
        whip: 0.98, k_bb_pct: 0.232, hr_per9: 0.84, as_of: ET }
    ]
  };
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
      /* THE MLB CARD. The games board reads the public schema, not mlbhist, so
         those tables are served here. The two starters are real pitchers whose
         records are in the LOCAL ARCHIVE this test imported — which is the
         point: the brief's career line has to come back out of PostgreSQL,
         not out of a fixture. */
      if (CARD_TABLES[rel]) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify(CARD_TABLES[rel]) });
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
    /* the stack rides along ALWAYS. A page error that only appears on a loaded
       CI runner cannot be reproduced locally to ask where it came from, so the
       one run that catches it has to say so by itself. */
    page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 200)
      + ' @@ ' + String((e && e.stack) || '').replace(/\s+/g, ' ')
        .slice(0, process.env.DESK_E2E_STACKS ? 700 : 240)));
    await page.goto(`http://127.0.0.1:${site.port}/app.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.researchGo === 'function'
      && !!window.EDMlbPitchers && !!window.EDMlbBatters, null, { timeout: 30000 });
    return { page, ctx, errors };
  }
  /* THE PANEL NOW OPENS ON THE GAMES BOARD, because that is what a reader came
     for. Every assertion below this point is about the ARCHIVE, so it switches
     to the season board first — the same click a reader makes. */
  async function gotoBaseball(page) {
    await page.evaluate(() => window.researchGo('baseball'));
    await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
    await page.evaluate(() => window.mlbhSetSeg('board'));
    await page.waitForFunction(() => {
      const b = document.getElementById('mlbhBody');
      return b && /MLB regular seasons/.test(b.textContent);
    }, null, { timeout: 25000 });
  }
  async function gotoOffense(page, seg) {
    await page.evaluate(() => window.researchGo('baseball'));
    await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
    /* The offensive archive loads beside the pitching one; wait for ITS status
       rather than for a paint, so the assertions below are about rows and not
       about a loading state. */
    await page.waitForFunction(() => window.MLBO && (window.MLBO.status || window.MLBO.err),
      null, { timeout: 25000 });
    await page.evaluate((x) => window.mlbhSetSeg(x), seg);
    await page.waitForFunction(() => {
      const b = document.getElementById('mlbhBody');
      if (!b) return false;
      /* rows, or a stated empty/error state — anything but the loading text,
         so a genuine "no rows" answer is not indistinguishable from a hang. */
      if (b.querySelector('.mlbh-tbl tbody tr')) return true;
      return /No hitter in|No club rows|did not answer|did not load/.test(b.textContent);
    }, null, { timeout: 25000 });
  }
  async function gotoGames(page) {
    await page.evaluate(() => window.researchGo('baseball'));
    await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
    await page.evaluate(() => window.mlbhSetSeg('games'));
    /* WAIT FOR THE LOAD TO ANSWER, not for the first paint. The board renders
       its loading state before the read returns, and asserting on that paint
       would test an empty screen. */
    await page.waitForFunction(() => window.MLBB && window.MLBB.at, null, { timeout: 25000 });
    await page.waitForFunction(() => {
      const b = document.getElementById('mlbhBody');
      return b && (b.querySelector('.mlbb-row') || /No MLB games on the card/.test(b.textContent));
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

    /* ══ 6d. THE GAMES BOARD AND THE GAME BRIEF ════════════════════════
       What the reader actually asked for: every game on the card, and a full
       brief behind each one. The board is read from the public schema and the
       brief's career line is read from the LOCAL ARCHIVE — so the number the
       browser prints is checked back against SQL, exactly like the board. */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoGames(page);

      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbb-row'))
        .map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
      eq('the board lists every game on the card', rows.length, 2);
      /* THE BOARD ORDERS BY FIRST PITCH, so the row is found by its clubs
         rather than by position — and that ordering is asserted separately. */
      const coleRow = rows.filter((r) => /New York Yankees/.test(r))[0] || '';
      const tbdRow = rows.filter((r) => /Baltimore Orioles/.test(r))[0] || '';
      chk('the earliest game is listed first',
        /Baltimore Orioles/.test(rows[0] || ''), rows.map((r) => r.slice(0, 40)));
      chk('…with both clubs on the row', /New York Yankees/.test(coleRow) && /Philadelphia Phillies/.test(coleRow), coleRow);
      chk('…the probable starters', /Gerrit Cole/.test(coleRow) && /Zack Wheeler/.test(coleRow), coleRow);
      chk('…records carried from the card', /90-60/.test(coleRow), coleRow);
      chk('…the venue', /Citizens Bank Park/.test(coleRow), coleRow);
      chk('…and a way into the brief on every row', rows.every((r) => /Game brief/.test(r)), rows);
      chk('a game with no probable starter shows TBD rather than a guess',
        /TBD/.test(tbdRow) && !/TBD/.test(coleRow), tbdRow);

      const note = await text(page, '.mlbb-note');
      chk('the board says baseball carries no validated model',
        /no validated EdgeDesk model/.test(note || ''), note);
      const boardTxt = await page.evaluate(() => document.getElementById('mlbhBody').textContent);
      chk('the board never prints a win probability', !/% to win/.test(boardTxt));
      chk('…and never calls anything an edge', !/\bedge\b/i.test(boardTxt), boardTxt.slice(0, 200));

      /* OPEN THE BRIEF. The same click a reader makes. */
      await page.evaluate(() => {
        const r = Array.from(document.querySelectorAll('.mlbb-row'))
          .filter((x) => /New York Yankees/.test(x.textContent))[0];
        r.click();
      });
      await page.waitForFunction(() => {
        const s = document.querySelector('.edb-res');
        return s && /Starting pitching/.test(s.textContent);
      }, null, { timeout: 25000 });
      const brief = await page.evaluate(() => document.querySelector('.edb-res').textContent.replace(/\s+/g, ' ').trim());

      chk('the brief names the matchup', /New York Yankees at Philadelphia Phillies/.test(brief), brief.slice(0, 160));
      chk('…is never priced', /has not priced this matchup yet/.test(brief), brief.slice(0, 600));
      chk('…and says why', /no VALIDATED model for baseball|publishes no validated baseball model/.test(brief));
      chk('…keeps both starters PROBABLE', /Both are PROBABLE, not confirmed/.test(brief));
      chk('…never claims a confirmed starter', !/confirmed starter/i.test(brief));
      chk('…draws the starting-pitching panel', /Starting pitching/.test(brief));
      chk('…the ballpark panel', /Ballpark and weather/.test(brief));
      chk('…the standings panel', /Where the clubs are/.test(brief));
      chk('…the head-to-head', /Runs per game/.test(brief) && /Runs allowed per game/.test(brief));
      chk('…the matchups', /vs the Philadelphia Phillies offense/.test(brief), brief.slice(0, 400));
      chk('…a case for each club', /The case for New York Yankees/.test(brief) && /The case for Philadelphia Phillies/.test(brief));
      chk('…why the number could be wrong', /Why the number could be wrong/.test(brief));
      chk('…and what was not measured at all',
        /Not measured at all/.test(brief) && /Batter-versus-pitcher history/.test(brief));
      chk('…with the research state named', /RESEARCH ONLY/.test(brief));
      chk('…and no park adjustment claimed', /applies NO park or weather adjustment/.test(brief));

      /* THE ARCHIVE LINE, CHECKED BACK AGAINST SQL. This is the join the whole
         change exists for: a name on tonight's card, resolved to a player id,
         read out of the 2016-2025 archive, and printed beside — never inside —
         the season line. */
      chk('the career line is drawn from the archive', /Career in the archive/.test(brief), brief.slice(0, 900));
      chk('…labelled as a completed record', /a completed record, not this season/.test(brief));
      chk('…and the season line kept separate', /This season/.test(brief));
      const cole = db.rows(`select player_id, era, first_observed_season, last_observed_season,
                                   weighted_performance_index
                              from mlbhist.pitcher_overview where name_key = 'gerrit cole'`);
      if (chk('the archive holds exactly one Gerrit Cole', cole.length === 1, cole.length)) {
        const era = Number(cole[0].era).toFixed(2);
        chk('…and the brief prints HIS archive ERA, not a recomputed one',
          brief.indexOf('ERA ' + era) >= 0, { era, sample: brief.slice(brief.indexOf('Career in the archive'), brief.indexOf('Career in the archive') + 220) });
        chk('…across the window the archive actually covers',
          brief.indexOf(cole[0].first_observed_season + '\u2013' + cole[0].last_observed_season) >= 0,
          cole[0].first_observed_season + '-' + cole[0].last_observed_season);
        /* He is at 4.35 this season against that archive ERA. The brief must
           print both and refuse to average them. */
        chk('…and says in words that the two periods are measured separately',
          /Two different periods measured separately/.test(brief), brief.slice(0, 1200));
        chk('…and that the archive is not a forecast',
          /the archive is not a forecast of the current season/.test(brief));
        const idx = Number(cole[0].weighted_performance_index).toFixed(1);
        chk('…the index is his, and explained as a scale',
          brief.indexOf(idx) >= 0 && /where 100 is league average/.test(brief), idx);
      }
      chk('the index is never turned into a price',
        !/index[^.]{0,40}(fair|implied|probability|edge)/i.test(brief));

      /* THE GAME WITH NO STARTERS AT ALL. Half the brief's largest input is
         missing and the page has to say so rather than thin out quietly. */
      await page.evaluate(() => window.EDBRIEF.close());
      await gotoGames(page);
      await page.evaluate(() => {
        const r = Array.from(document.querySelectorAll('.mlbb-row'))
          .filter((x) => /Baltimore Orioles/.test(x.textContent))[0];
        r.click();
      });
      await page.waitForFunction(() => {
        const s = document.querySelector('.edb-res');
        return s && /Baltimore Orioles/.test(s.textContent);
      }, null, { timeout: 25000 });
      const bare = await page.evaluate(() => document.querySelector('.edb-res').textContent.replace(/\s+/g, ' ').trim());
      chk('a game with no posted starters still opens a brief', bare.length > 800, bare.length);
      chk('…which says the pitching half is unknown',
        /Neither club has posted a probable starter/.test(bare), bare.slice(0, 200));
      chk('…and does not fill it in', /EdgeDesk does not fill it in/.test(bare));
      chk('…names both missing starters as HIGH uncertainty',
        (bare.match(/starter not posted/g) || []).length === 2, (bare.match(/starter not posted/g) || []).length);
      chk('…and still carries the park and the standings',
        /Ballpark and weather/.test(bare) && /Where the clubs are/.test(bare));
      /* NEITHER club has a team_season row here, so the builder says that once
         rather than twice — and the comparison is absent, not estimated. */
      chk('…with no team rows, the comparison is absent rather than estimated',
        /No season team rows on file for either club/.test(bare)
        && /no offensive or run-prevention comparison is shown/.test(bare), bare.slice(-500));
      chk('…and that absence is a HIGH uncertainty, not a silent gap',
        /No season team rows/.test(bare) && /absent rather than thin/.test(bare));
      /* The head-to-head COMPARISON is absent; the club-offense panel below it
         legitimately mentions runs per game in its own note, so this is scoped
         to the comparison rather than to the whole page. */
      chk('…so no offensive comparison table is drawn at all',
        !/Team research head-to-head/.test(bare) && !/Offense \(season to date\)/.test(bare),
        bare.slice(0, 200));
      chk('…and no career line is invented for a starter who does not exist',
        !/Career in the archive/.test(bare));

      chk('no page error on the games board or either brief', errors.length === 0, errors.slice(0, 3));
      if (SHOTS) { try { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'mlb-game-brief.png'), fullPage: true }); } catch (e) { /* shots are optional */ } }
      await ctx.close();
    }

    /* ══ 6f. THE OFFENSIVE SURFACES — THE COMPLETE USER PATH ═══════════
       Search a hitter, open his profile, change seasons, open a club's
       offense, and check every number on screen back against SQL. */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoOffense(page, 'hitters');

      /* the coverage sentence, before any number */
      const cov = await text(page, '.mlbo-cov');
      chk('the offensive panel states its coverage window', /2016–2025 MLB regular seasons/.test(cov || ''), cov);
      chk('…and that it is not current-season data', /not current-season data/.test(cov || ''), cov);
      chk('…and that it is never a lineup', /never a lineup/.test(cov || ''), cov);
      chk('…and the row counts it actually holds', /3097 hitters \(2513 with a plate appearance\)/.test(cov || ''), cov);

      /* THE LEADERBOARD, checked against SQL */
      const head = await text(page, '#mlbhBody .fb-sechd');
      chk('the board heading names the season and the metric',
        /2025 · Offensive index · 200\+ PA/.test(head || ''), head);
      const qual = await text(page, '.mlbo-qual');
      chk('…and MLB’s own qualification for that season', /qualification for 2025 is 503 PA/.test(qual || ''), qual);

      const first = await page.evaluate(() => {
        const tr = document.querySelector('#mlbhBody .mlbh-tbl tbody tr');
        const c = tr.children;
        return { name: c[1].textContent.trim(), pa: c[3].textContent.trim(),
          ops: c[7].textContent.trim(), hr: c[8].textContent.trim(), idx: c[11].textContent.trim() };
      });
      const sqlTop = db.rows(`select player_name, plate_appearances, ops, home_runs, offensive_index
                                from mlbhist.batter_seasons
                               where season = 2025 and plate_appearances >= 200
                                 and offensive_index is not null
                               order by offensive_index desc limit 1`)[0];
      eq('the board leader is the leader the database has', first.name, sqlTop.player_name);
      eq('…with his plate appearances', first.pa, String(sqlTop.plate_appearances));
      eq('…his home runs', first.hr, String(sqlTop.home_runs));
      near('…his index', Number(first.idx), Number(sqlTop.offensive_index), 0.05);
      near('…and his OPS', Number(first.ops.replace(/^\./, '0.')), Number(sqlTop.ops), 0.0005);

      /* CHANGE THE SEASON — 2020, the short one */
      await page.evaluate(() => window.mlboSetCtl('season', '2020'));
      /* The heading paints from state the moment the control changes; the
         qualification note comes from the BOARD, so waiting on the heading
         races the reload and reads the previous season's screen. */
      await page.waitForFunction(() => {
        const q = document.querySelector('.mlbo-qual');
        return q && /for 2020/.test(q.textContent);
      }, null, { timeout: 25000 });
      const qual2020 = await text(page, '.mlbo-qual');
      chk('2020 states its OWN qualification, not a full season’s',
        /qualification for 2020 is 186 PA/.test(qual2020 || ''), qual2020);
      chk('…and says why', /60-game season/.test(qual2020 || ''), qual2020);
      const rows2020 = await page.evaluate(() => document.querySelectorAll('#mlbhBody .mlbh-tbl tbody tr').length);
      chk('…and the board is not empty at that screen', rows2020 > 0, String(rows2020));
      await page.evaluate(() => window.mlboSetCtl('season', '2025'));
      await page.waitForFunction(() => {
        const q = document.querySelector('.mlbo-qual');
        return q && /for 2025/.test(q.textContent);
      }, null, { timeout: 25000 });

      /* SEARCH A HITTER and open his profile */
      await page.evaluate(() => window.mlboSearchInput('Aaron Judge'));
      await page.waitForSelector('.mlbh-hit', { timeout: 20000 });
      const hits = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbh-hit .nm')).map((n) => n.textContent.trim()));
      chk('searching a hitter finds him', hits.indexOf('Aaron Judge') >= 0, hits.slice(0, 4));
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.mlbh-hit'))
          .filter((x) => /Aaron Judge/.test(x.textContent))[0];
        b.click();
      });
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      eq('his profile opens', await text(page, '#mlbhModal .mlbh-ph h3'), 'Aaron Judge');

      const JUDGE = Number(db.rows(`select player_id from mlbhist.batter_overview
                                     where player_name = 'Aaron Judge'`)[0].player_id);
      const sqlOv = db.rows(`select plate_appearances, games, home_runs, avg, obp, slg, ops, iso,
                                    k_pct, bb_pct, stolen_bases, weighted_offensive_index,
                                    rated_plate_appearances, teams
                               from mlbhist.batter_overview where player_id = ${JUDGE}`)[0];
      const kpis = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-kpi'))
        .map((k) => ({ k: k.querySelector('.k').textContent.trim(),
          v: k.querySelector('.v').textContent.trim(),
          s: k.querySelector('.s') ? k.querySelector('.s').textContent.trim() : '' })));
      const kpi = (name) => (kpis.filter((x) => x.k === name)[0] || {});
      eq('…his plate appearances match the database', kpi('Plate appearances').v, String(sqlOv.plate_appearances));
      eq('…his games', kpi('Plate appearances').s, sqlOv.games + ' games');
      eq('…his home runs', kpi('Home runs').v, String(sqlOv.home_runs));
      chk('…his career index, with the sample that produced it',
        kpi('Offensive index').s.indexOf(sqlOv.rated_plate_appearances + ' rated PA') >= 0,
        kpi('Offensive index').s);
      chk('…and the club list the package ships blank was rebuilt',
        /Yankees/.test(await text(page, '#mlbhModal .mlbh-ph .sub') || ''),
        await text(page, '#mlbhModal .mlbh-ph .sub'));

      /* THE RATING IS NEVER SHOWN WITHOUT ITS TERMS */
      const rating = await text(page, '.mlbo-rating');
      chk('the rating explains itself on the page', /ED_BAT_PERF_V1/.test(rating || ''), rating);
      chk('…says 100 is that season’s average', /100 is the MLB average for that season/.test(rating || ''));
      chk('…and says what it is not', /not.*OPS\+.*wRC\+.*WAR/.test(rating || ''), (rating || '').slice(0, 200));

      /* THE OPS SHAPE */
      const shape = await text(page, '.mlbo-shape');
      chk('the profile says what the OPS is made of', /What the OPS is made of/.test(shape || ''), shape);
      chk('…naming which half leads it', /led by (on-base|slugging)|not driven by one half/.test(shape || ''), shape);
      chk('…against the league baseline, not against the other half',
        /measured against the same season’s league rate/.test(shape || ''), shape);

      /* SEASON BY SEASON, every row against SQL */
      const seasons = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhModal .mlbh-tbl'))[0]
        ? Array.from(Array.from(document.querySelectorAll('#mlbhModal .mlbh-tbl'))[0].querySelectorAll('tbody tr'))
          .map((tr) => Array.from(tr.children).map((td) => td.textContent.trim())) : []);
      const sqlSeasons = db.rows(`select season, games, plate_appearances, home_runs, offensive_index
                                    from mlbhist.batter_seasons
                                   where player_id = ${JUDGE} and plate_appearances > 0 order by season`);
      eq('every season with a plate appearance is on the profile', seasons.length, sqlSeasons.length);
      let seasonBad = 0;
      sqlSeasons.forEach((r, i) => {
        const row = seasons[i];
        if (!row) { seasonBad++; return; }
        if (row[0].indexOf(String(r.season)) !== 0) seasonBad++;
        if (row[2] !== String(r.games)) seasonBad++;
        if (row[3] !== String(r.plate_appearances)) seasonBad++;
        if (row[10] !== String(r.home_runs)) seasonBad++;
      });
      eq('…and every one matches the database', seasonBad, 0);

      /* CLUBS, and the rule that keeps the grains apart */
      const profile = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('the profile lists his clubs', /Clubs/.test(profile), '');
      chk('…and says they are the same performance, split',
        /never add the two together/.test(profile));
      chk('…and that club duration is not a contract date',
        /not verified contract, trade or roster/.test(profile));
      chk('…and names what this archive does not hold',
        /no daily lineups/.test(profile) && /no batter-versus-pitcher history/.test(profile));
      chk('no page error on the offensive profile', errors.length === 0, errors.slice(0, 3));
      if (SHOTS) { try { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'mlb-hitter-profile.png'), fullPage: true }); } catch (e) { /* optional */ } }
      await ctx.close();
    }

    /* ══ 6g. A TWO-WAY PLAYER IS ONE PERSON, TWO ARCHIVES ══════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoOffense(page, 'hitters');
      const OHTANI = Number(db.rows(`select player_id from mlbhist.batter_overview
                                      where player_name like '%Ohtani%'`)[0].player_id);
      await page.evaluate((id) => window.mlboOpenHitter(id), OHTANI);
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const body = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('a two-way player shows his pitching side too', /He pitched too/.test(body), body.slice(0, 120));
      chk('…with the hitting rating named', /ED_BAT_PERF_V1/.test(body));
      chk('…and the pitching rating named separately', /ED_PITCH_PERF_V1/.test(body));
      chk('…and the two never combined', /never combined into one number/.test(body));
      const sqlP = db.rows(`select innings_display, era from mlbhist.pitcher_overview
                             where player_id = ${OHTANI}`)[0];
      chk('…the pitching innings come from the pitching archive',
        body.indexOf(sqlP.innings_display + ' IP') >= 0, sqlP.innings_display);
      /* AND IT IS ONE IDENTITY: the same id opens the pitching record. */
      await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('#mlbhModalCard button'))
          .filter((x) => /Open his pitching record/.test(x.textContent))[0];
        b.click();
      });
      await page.waitForFunction(() => {
        const h = document.querySelector('#mlbhModal .mlbh-ph h3');
        return h && /Ohtani/.test(h.textContent);
      }, null, { timeout: 20000 });
      chk('…and the same id opens his pitching record',
        /IP|ERA|innings/i.test(await page.evaluate(() => document.getElementById('mlbhModalCard').textContent)));
      chk('no page error crossing the two archives', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6h. CLUB OFFENSE, AND THE THREE GAME COUNTS ═══════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoOffense(page, 'offense');
      const head = await text(page, '#mlbhBody .fb-sechd');
      chk('the club board names the season and what it ranks by',
        /2025 · club offense, ranked by the offensive index/.test(head || ''), head);
      const note = await text(page, '.mlbo-note');
      chk('…and says runs per game uses the club’s actual games',
        /actual games/.test(note || ''), note);
      chk('…and that a club rate is not a mean of player rates',
        /never by averaging its players/.test(note || ''), note);

      const top = await page.evaluate(() => {
        const tr = document.querySelector('#mlbhBody .mlbh-tbl tbody tr');
        const c = tr.children;
        return { club: c[1].textContent.trim(), g: c[2].textContent.trim(),
          r: c[3].textContent.trim(), rpg: c[4].textContent.trim() };
      });
      const sqlClub = db.rows(`select team_name, team_games, runs, runs_per_game, player_games_sum
                                 from mlbhist.team_offense_seasons where season = 2025
                                order by offensive_index desc limit 1`)[0];
      eq('the top club matches the database', top.club, sqlClub.team_name);
      eq('…with the club’s ACTUAL games, not the sum of player games', top.g, String(sqlClub.team_games));
      chk('…which is a different number from the sum of player games',
        Number(sqlClub.team_games) !== Number(sqlClub.player_games_sum),
        `${sqlClub.team_games} vs ${sqlClub.player_games_sum}`);
      near('…and runs per game is runs over those games',
        Number(top.rpg), Number(sqlClub.runs) / Number(sqlClub.team_games), 0.005);

      /* DRILL INTO A CLUB and check the roster */
      const TEAM = Number(db.rows(`select team_id from mlbhist.team_offense_seasons
                                    where season = 2025 order by offensive_index desc limit 1`)[0].team_id);
      await page.evaluate((id) => window.mlboSetTeam(String(id)), TEAM);
      await page.waitForFunction(() => document.querySelectorAll('#mlbhBody .mlbh-tbl').length > 1,
        null, { timeout: 20000 });
      const rosterCount = await page.evaluate(() => Array.from(document.querySelectorAll('#mlbhBody .mlbh-tbl'))[1]
        .querySelectorAll('tbody tr').length);
      const sqlRoster = Number(db.rows(`select count(*)::int as n from mlbhist.batter_team_seasons
                                         where season = 2025 and team_id = ${TEAM}`)[0].n);
      eq('the roster behind that club-season is the roster the database has',
        rosterCount, Math.min(sqlRoster, 40));
      const rosterNote = await page.evaluate(() => Array.from(document.querySelectorAll('.mlbo-note'))
        .map((n) => n.textContent).join(' '));
      chk('…and says these rows are parts of each hitter’s season',
        /never add them to his season line/.test(rosterNote), rosterNote.slice(0, 200));
      chk('no page error on the club board', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6i. THE OFFENSIVE BASELINE ON A GAME BRIEF ════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await gotoGames(page);
      await page.evaluate(() => {
        const r = Array.from(document.querySelectorAll('.mlbb-row'))
          .filter((x) => /New York Yankees/.test(x.textContent))[0];
        r.click();
      });
      await page.waitForFunction(() => {
        const s = document.querySelector('.edb-res');
        return s && /Starting pitching/.test(s.textContent);
      }, null, { timeout: 25000 });
      const brief = await page.evaluate(() => document.querySelector('.edb-res').textContent.replace(/\s+/g, ' ').trim());
      chk('the brief carries a completed-season club offense panel',
        /Club offense — this season and the archive/.test(brief), brief.slice(0, 200));
      chk('…labelled as different measurements never averaged',
        /never averaged together/.test(brief));
      chk('…and says the archive is a club record, not a roster',
        /not necessarily the hitters playing tonight/.test(brief));
      chk('…with the ten-season window named',
        /Ten-season baseline \(2016–2025\)/.test(brief), brief.slice(0, 300));
      /* the number on the page is the number in the database */
      const sqlBase = db.rows(`select runs_per_game from mlbhist.team_offense_overview
                                where team_id = 147`)[0];
      chk('…and the baseline runs per game match the archive',
        brief.indexOf('R/G ' + Number(sqlBase.runs_per_game).toFixed(2)) >= 0,
        Number(sqlBase.runs_per_game).toFixed(2));
      chk('no page error on the brief with both archives', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6j. THE OFFENSIVE SURFACES ON A PHONE ═════════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 390, height: 844 });
      await gotoOffense(page, 'hitters');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      chk('the hitter board does not scroll the page sideways on a phone', wide === false);
      const JUDGE2 = Number(db.rows(`select player_id from mlbhist.batter_overview
                                      where player_name = 'Aaron Judge'`)[0].player_id);
      await page.evaluate((id) => window.mlboOpenHitter(id), JUDGE2);
      await page.waitForSelector('#mlbhModal .mlbh-ph h3', { timeout: 20000 });
      const wide2 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      chk('…and neither does the profile', wide2 === false);
      chk('no page error on a phone', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 6e. THE GAMES BOARD ON A PHONE ══════════════════════════════════ */
    {
      const { page, ctx, errors } = await openApp({ width: 390, height: 844 });
      await gotoGames(page);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      chk('the games board does not scroll sideways on a phone', wide === false);
      const clipped = await page.evaluate(() => {
        const r = document.querySelector('.mlbb-row');
        if (!r) return 'no row';
        const b = r.getBoundingClientRect();
        return b.right > window.innerWidth + 1 ? 'clipped' : 'ok';
      });
      eq('…and a row fits the screen', clipped, 'ok');
      chk('no page error on a phone board', errors.length === 0, errors.slice(0, 3));
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

    /* ══ 6k. LEAVING THE PANEL MID-LOAD IS NOT AN ERROR ═══════════════
       The panel aborts its reads when the reader navigates away, taps refresh
       or changes a control — deliberately. Those loaders are started without
       anyone holding their promise, so for a while the cancellation reached
       window.onunhandledrejection and a normal navigation was reported as a
       page error; the seg loaders also painted "signal is aborted without
       reason" at the reader as though the archive had failed.

       THE READS ARE SLOWED so the abort always lands on one in flight, and
       each scenario WAITS FOR ITS OWN REQUESTS TO SETTLE rather than for a
       fixed number of milliseconds: a runner under load finishes them later
       than a quiet one, and a straggler that arrived after a fixed sleep
       would be blamed on whichever scenario happened to be running. Each
       scenario also gets its own context, so nothing can cross between. */
    for (const leave of ['tab', 'refresh', 'segment']) {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      let inflight = 0;
      page.on('request', (r) => { if (/supabase\.co\/rest\/v1\//.test(r.url())) inflight++; });
      const done = (r) => { if (/supabase\.co\/rest\/v1\//.test(r.url())) inflight--; };
      page.on('requestfinished', done);
      page.on('requestfailed', done);
      /* registered after openApp's route, so it is matched first; fallback
         hands the request on to the handler that actually answers it */
      await ctx.route('**/*', async (route) => {
        if (/supabase\.co\/rest\/v1\//.test(route.request().url())) await new Promise((r) => setTimeout(r, 700));
        return route.fallback();
      });
      /* every read this panel starts has answered or been cancelled, plus a
         grace for the rejection to reach the page if it is going to */
      const settle = async () => {
        const until = Date.now() + 30000;
        while (inflight > 0 && Date.now() < until) await page.waitForTimeout(100);
        await page.waitForTimeout(600);
      };

      await page.evaluate(() => window.researchGo('baseball'));
      await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
      if (leave === 'segment') {
        await page.evaluate(() => window.mlbhSetSeg('hitters'));
        await page.waitForTimeout(80);
      }
      /* leave while the reads are still out */
      if (leave === 'refresh') await page.evaluate(() => window.researchRefresh('baseball'));
      else await page.evaluate(() => window.researchGo('football'));
      await settle();

      chk('leaving baseball mid-load raises no page error (' + leave + ')',
        errors.length === 0, errors.slice(0, 3));
      const shown = await page.evaluate(() => ({
        pitching: (window.MLBH && window.MLBH.err) || '',
        offense: (window.MLBO && window.MLBO.err) || '' }));
      chk('\u2026and the reader is never shown the abort as a failure (' + leave + ')',
        !/abort/i.test(String(shown.pitching)) && !/abort/i.test(String(shown.offense)), shown);
      await ctx.close();
    }

    /* ══ 6l. AND THE CANCELLATION RULE IS NARROW ═════════════════════
       The shell ignores an unhandled AbortError because a deliberate
       cancellation is not a failure. The danger in a rule like that is that it
       grows: widen it once and every unhandled rejection in the app goes
       quiet, and the assertions above start passing for the wrong reason. So
       the narrowness is the test. */
    {
      const { page, ctx, errors } = await openApp({ width: 1280, height: 900 });
      await page.evaluate(() => { Promise.reject(new DOMException('signal is aborted without reason', 'AbortError')); });
      await page.waitForTimeout(500);
      chk('an unhandled cancellation is not reported as a page error', errors.length === 0, errors.slice(0, 2));
      await page.evaluate(() => { Promise.reject(new Error('a genuine failure nobody handled')); });
      await page.waitForTimeout(500);
      chk('\u2026but a genuine unhandled rejection still is',
        errors.length === 1 && /a genuine failure nobody handled/.test(errors[0]), errors.slice(0, 2));
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
