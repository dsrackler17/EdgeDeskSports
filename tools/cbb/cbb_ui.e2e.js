#!/usr/bin/env node
/* ===========================================================================
   THE COLLEGE BASEBALL BOARD AND BRIEF, in a real browser, against a real
   PostgreSQL carrying a real import.

   No stubbed rows. The schema is applied, games are promoted through the real
   gate, and the page's own reads are answered out of that database, so every
   number on the screen came through the query layer from SQL.

   The three screens that matter most are the ones with nothing on them:

     OUT OF SEASON. It is September. College baseball does not play. The board
     has to say so, because an empty list with no explanation is exactly what a
     broken pipeline looks like.
     ABANDONED. A rained-off game must never render as a nil-nil result.
     NOT INSTALLED. An archive that was never imported is a different message
     from one that failed.

   Run: node tools/cbb/cbb_ui.e2e.js
   =========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PG = require('../mlb/pg_client.js');
const S = require('./stage.js');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'edgedesk_cbb_ui';
let pass = 0, fail = 0;
const failures = [];
const chk = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; failures.push({ n, d }); console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d).slice(0, 300) : '')); } };
const eq = (n, g, w) => chk(n, g === w, { got: g, want: w });

let pw; try { pw = require('playwright'); } catch (_) {
  try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
if (!pw) { console.log('SKIP | cbb research surface | playwright is not installed here'); process.exit(0); }

const conn = PG.findServer();
if (!conn) { console.log('SKIP | cbb research surface | no reachable PostgreSQL server'); process.exit(0); }
if (!PG.createDatabase(conn, DB)) { console.log('SKIP | cbb research surface | could not create the test database'); process.exit(0); }
const db = PG.pgClient(conn, { database: DB });
try { db.sql('create role anon nologin; create role authenticated nologin;'); } catch (_) {}

/* the card is dated relative to today so the board's own three-day ET window
   finds it — the season is February to June, so "today" is forced in-season
   by dating the fixture inside it and asking the board for that window */
const IN_SEASON_DAY = '2026-04-18';

const game = (o) => Object.assign({
  game_id: null, season: 2026, game_date: IN_SEASON_DAY, start_time: IN_SEASON_DAY + 'T20:00Z',
  start_time_tbd: false, away_team_id: null, home_team_id: null,
  away_name: 'Away', home_name: 'Home', away_abbr: null, home_abbr: null,
  venue: null, venue_city: null, venue_state: null, neutral_site: false, conference_game: false,
  status_state: 'post', status_detail: 'Final', completed: true,
  away_score: 1, home_score: 2, innings: 9, away_rank: null, home_rank: null,
  notes: null, seen_by: ['scoreboard'],
}, o);

(async function main() {
  let browser = null, site = null;
  try {
    const applied = PG.applyFile(conn, DB, path.join(ROOT, 'supabase', 'college_baseball.sql'));
    if (!applied.ok) { console.log('FAIL | schema did not apply'); throw new Error('apply'); }

    const teams = [
      { team_id: '1', name: 'Alpha Aces', short_name: 'Alpha', abbreviation: 'ALP', slug: 'alpha',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null, first_seen_season: 2026, last_seen_season: 2026 },
      { team_id: '2', name: 'Beta Bears', short_name: 'Beta', abbreviation: 'BET', slug: 'beta',
        conference_id: null, conference_name: 'Big Test', logo: null, color: null, first_seen_season: 2026, last_seen_season: 2026 },
    ];
    const games = [
      game({ game_id: 'p1', game_date: '2026-04-01', home_team_id: '1', away_team_id: '2',
             home_name: 'Alpha Aces', away_name: 'Beta Bears', home_score: 5, away_score: 1, conference_game: true }),
      game({ game_id: 'p2', game_date: '2026-04-02', home_team_id: '2', away_team_id: '1',
             home_name: 'Beta Bears', away_name: 'Alpha Aces', home_score: 3, away_score: 2, conference_game: true }),
      game({ game_id: 'live', home_team_id: '1', away_team_id: '2', home_name: 'Alpha Aces',
             away_name: 'Beta Bears', home_score: 4, away_score: 2, completed: false,
             status_state: 'in', status_detail: 'Top 7th', away_rank: 8, venue: 'Alpha Field',
             seen_by: ['scoreboard', 'team_schedule'] }),
      game({ game_id: 'rain', home_team_id: '2', away_team_id: '1', home_name: 'Beta Bears',
             away_name: 'Alpha Aces', home_score: null, away_score: null,
             completed: true, status_detail: 'Postponed', seen_by: ['team_schedule'] }),
    ];
    const v = await S.stageAndPromote(db, 'ui-1', { season: 2026, from: '2026-04-01', through: '2026-04-30', games, teams, log: () => {} });
    if (!v || v.ok !== true) throw new Error('fixture did not promote');

    /* ── BOX SCORES FOR ONE COMPLETED GAME ONLY ───────────────────────────
       p1 gets lines; p2 does not. That asymmetry is the realistic case and it
       is what makes the coverage assertions below mean something: Alpha played
       two completed games and has lines for one, so every hitting number on
       its card covers half its season and the card has to say so. */
    const SS = require('./stage_stats.js');
    const line = (o) => Object.assign({
      game_id: 'p1', athlete_id: 'x', line_type: 'batting', season: 2026,
      game_date: '2026-04-01', team_id: '1', team_name: 'Alpha Aces',
      opponent_team_id: '2', athlete_name: 'A Player', position: null, jersey: null,
      starter: true, ab: null, runs: null, hits: null, rbi: null, hr: null, bb: null,
      so: null, pitches_seen: null, stolen_bases: null, outs: null, p_hits: null,
      p_runs: null, earned_runs: null, p_bb: null, p_so: null, p_hr: null,
      pitch_count: null, strikes: null, season_avg_at_game: null,
      season_obp_at_game: null, season_slg_at_game: null, season_era_at_game: null,
      source: 'espn_summary',
    }, o);
    const sv = await SS.stageAndPromoteStats(db, 'ui-stats', { season: 2026, log: () => {}, lines: [
      /* Alpha: a qualifying hitter (40 AB is past the 30 threshold), a 2-for-2,
         a qualifying pitcher, and a one-out reliever with a 0.00 ERA. */
      line({ athlete_id: 'h1', athlete_name: 'Real Regular', position: 'CF', ab: 40, hits: 14,
             runs: 9, rbi: 11, hr: 4, bb: 6, so: 8, stolen_bases: 3, pitches_seen: 150,
             season_avg_at_game: 0.350, season_obp_at_game: 0.430, season_slg_at_game: 0.600 }),
      line({ athlete_id: 'h2', athlete_name: 'Two For Two', position: 'PH', ab: 2, hits: 2,
             starter: false, season_avg_at_game: 1.0 }),
      line({ athlete_id: 'p1a', athlete_name: 'Alpha Ace', position: 'P', line_type: 'pitching',
             outs: 60, p_hits: 15, p_runs: 6, earned_runs: 5, p_bb: 4, p_so: 25,
             pitch_count: 280, strikes: 190, season_era_at_game: 2.25 }),
      line({ athlete_id: 'p1b', athlete_name: 'One Out Wonder', position: 'P', line_type: 'pitching',
             outs: 1, p_hits: 0, p_runs: 0, earned_runs: 0, p_bb: 0, p_so: 1,
             pitch_count: 4, strikes: 3, season_era_at_game: 0.0 }),
      /* Beta, so the box score has two sides */
      line({ athlete_id: 'b1', team_id: '2', team_name: 'Beta Bears', opponent_team_id: '1',
             athlete_name: 'Beta Bat', position: 'SS', ab: 35, hits: 9, hr: 1, bb: 3, so: 12,
             season_avg_at_game: 0.257 }),
      line({ athlete_id: 'b2', team_id: '2', team_name: 'Beta Bears', opponent_team_id: '1',
             athlete_name: 'Beta Arm', position: 'P', line_type: 'pitching', outs: 45,
             p_hits: 20, p_runs: 12, earned_runs: 10, p_bb: 8, p_so: 12, pitch_count: 240,
             strikes: 150, season_era_at_game: 6.00 }),
    ] });
    if (!sv || sv.ok !== true) throw new Error('stats fixture did not promote');

    /* serve the app, and answer its reads out of the database */
    const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    site = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' });
      res.end(fs.readFileSync(p));
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const port = site.address().port;

    try { browser = await pw.chromium.launch({ headless: true }); }
    catch (_) {
      const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
      if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
      else { console.log('SKIP | cbb research surface | no Chromium'); process.exit(0); }
    }

    let reads = 0; const readErrors = [];
    async function openApp() {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
          localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e',
            expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: 'e2e', email: 'e2e@edgedesk.test' } }));
        } catch (e) {}
      });
      await ctx.route('**/*', async (route) => {
        const url = route.request().url();
        if (url.indexOf('127.0.0.1') >= 0) return route.continue();
        const m = /\/rest\/v1\/([^?]+)\??(.*)$/.exec(url);
        if (m && /supabase\.co/.test(url)) {
          const profile = route.request().headers()['accept-profile'] || 'public';
          const rel = decodeURIComponent(m[1]);
          if (profile === 'cbb') {
            reads++;
            try {
              const rows = await db.select('cbb', rel, m[2] || '');
              return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
            } catch (e) {
              readErrors.push(`${rel}?${(m[2] || '').slice(0, 120)} -> ${e.message}`);
              return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: e.message }) });
            }
          }
          if (/subscriptions/.test(rel)) {
            return route.fulfill({ status: 200, contentType: 'application/json',
              body: JSON.stringify([{ status: 'active', price_id: 'p', current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false }]) });
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        }
        if (/supabase\.co/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return route.fulfill({ status: 204, body: '' });
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e && e.message).slice(0, 200)));
      await page.goto(`http://127.0.0.1:${port}/app.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof window.researchGo === 'function' && !!window.EDCollegeBaseball,
        null, { timeout: 30000 });
      return { page, ctx, errors };
    }

    /* ══ 1. THE LIBRARY IS ACTUALLY SERVED AND PARSED ═══════════════════════ */
    {
      const { page, ctx, errors } = await openApp();
      chk('the college baseball query layer loads in the browser',
        await page.evaluate(() => !!(window.EDCollegeBaseball && window.EDCollegeBaseball.createService)));
      chk('no page error on boot', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    /* ══ 2. THE BOARD, IN SEASON ════════════════════════════════════════════ */
    {
      const { page, ctx, errors } = await openApp();
      await page.evaluate(() => window.researchGo('baseball'));
      await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
      /* force the board's window onto the fixture's dates */
      await page.evaluate((d) => { window.cbbDay = (o) => {
        const t = new Date(Date.parse(d + 'T12:00:00Z') + (o || 0) * 864e5);
        return t.toISOString().slice(0, 10); }; }, IN_SEASON_DAY);
      await page.evaluate(() => window.mlbhSetSeg('cbb'));
      await page.waitForFunction(() => {
        const b = document.getElementById('mlbhBody');
        return b && /Alpha Aces|out of season|not installed/i.test(b.textContent);
      }, null, { timeout: 25000 });
      const body = await page.evaluate(() => document.getElementById('mlbhBody').textContent);

      chk('the college board renders the day\'s games', /Alpha Aces/.test(body) && /Beta Bears/.test(body), body.slice(0, 200));
      chk('…and says no model is published for this sport',
        /no validated EdgeDesk model/i.test(body), body.slice(0, 260));
      chk('…and says no starting pitcher is named', /no starting pitcher/i.test(body), body.slice(0, 300));
      /* A LIVE GAME AND AN ABANDONED ONE MUST NOT READ ALIKE. */
      chk('a game in progress shows its state', /Top 7th/.test(body), body.slice(0, 400));
      chk('an abandoned game says abandoned, not a score', /Postponed/i.test(body), body.slice(0, 400));
      chk('…and no 0 — 0 appears anywhere on the board', !/\b0\s*[—-]\s*0\b/.test(body), body.slice(0, 400));
      const rank = await page.evaluate(() => !!document.querySelector('.cbb-rk'));
      chk('a ranked club is marked', rank);
      chk('no page error on the board', errors.length === 0, errors.slice(0, 3));

      /* ══ 3. THE BRIEF ════════════════════════════════════════════════════ */
      await page.evaluate(() => window.cbbOpenBrief('live'));
      await page.waitForFunction(() => {
        const el = document.getElementById('mlbhModalCard');
        return el && /Projection|could not be built/.test(el.textContent);
      }, null, { timeout: 25000 });
      const brief = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('the brief opens on the game', /Alpha Aces/.test(brief) && /Beta Bears/.test(brief), brief.slice(0, 200));
      chk('…and refuses to publish a projection',
        /no validated model/i.test(brief) && /no fair line/i.test(brief), brief.slice(0, 400));
      chk('…carries the season record for both clubs', /Record/.test(brief), brief.slice(0, 500));
      /* the record has to be the one the game log implies: Alpha 1-1 before
         the live game, which is not counted */
      const alphaRec = db.rows("select wins, losses from cbb.team_seasons where team_id='1'")[0];
      chk('…and the record matches the database',
        new RegExp(alphaRec.wins + '-' + alphaRec.losses).test(brief), { brief: brief.slice(0, 400), alphaRec });
      chk('…shows prior meetings out of the same log', /Prior meetings/.test(brief), brief.slice(0, 600));
      chk('…shows recent form', /Recent form/.test(brief), brief.slice(0, 600));
      chk('…and names what it could not measure',
        /What EdgeDesk could not measure/.test(brief), brief.slice(0, 600));
      chk('…including the absent starter', /largest single input/i.test(brief), brief.slice(0, 900));
      chk('no page error on the brief', errors.length === 0, errors.slice(0, 3));

      /* ══ 3a. THE MARKET SECTION SAYS THE FEED DOES NOT COVER THE SPORT ══
         Not a blank panel, which reads as a loading failure, and above all not
         a price derived from run rates. */
      chk('the brief has a market section', /Market/.test(brief), brief.slice(0, 300));
      chk('…and says there is no market on the game',
        /no market on this game/.test(brief), brief.slice(0, 2000));
      chk('…and says the feed carries no college baseball',
        /carries no college baseball/.test(brief), brief.slice(0, 2000));
      chk('…and that this was read from the feed rather than assumed',
        /read directly from the feed rather than assumed/.test(brief), brief.slice(0, 2000));
      chk('…and refuses to convert run rates into a price',
        /not a price/.test(brief) && /does not fill that gap/i.test(brief), brief.slice(0, 2500));

      /* ══ 3b. THE STATS THE BOX SCORES BOUGHT ════════════════════════════ */
      chk('the brief carries a batting and pitching table',
        /Batting and pitching, from the box scores/.test(brief), brief.slice(0, 300));
      /* Alpha's club average: (40 + 2) AB, (14 + 2) H = 16/42 = .380… */
      const alphaStats = db.rows("select ab, hits, batting_avg, era from cbb.team_stat_seasons where team_id='1'")[0];
      chk('…and the club average is the one the database folded',
        new RegExp('\\' + String(Number(alphaStats.batting_avg).toFixed(3)).slice(1)).test(brief),
        { brief: brief.slice(0, 2000), alphaStats });
      chk('…with a team ERA', /Team ERA/.test(brief), brief.slice(0, 300));
      chk('…and innings shown in thirds rather than decimals',
        /thirds, not decimals/.test(brief), brief.slice(0, 300));
      /* THE HONESTY THAT MATTERS MOST: these numbers cover 1 of Alpha's 2
         completed games, and the card must not let that pass unmentioned. */
      chk('…and says how many games the hitting numbers cover',
        /1 of 2/.test(brief), brief.slice(0, 3000));
      chk('…and warns the numbers are a sample, not the season',
        /not the season/.test(brief), brief.slice(0, 4000));
      /* OBP IS NOT DERIVED, AND THE CARD SAYS WHY. */
      chk('…and refuses to derive on-base percentage for a club',
        /hit-by-pitch and sacrifice flies/.test(brief), brief.slice(0, 4000));

      chk('the brief names who has hit and pitched', /Who has hit and pitched/.test(brief), brief.slice(0, 300));
      chk('…the qualifying hitter appears', /Real Regular/.test(brief), brief.slice(0, 4000));
      /* THE 2-FOR-2 MUST NOT BE THE CLUB'S LEADING HITTER. */
      chk('…the 2-for-2 is not presented as a leader', !/Two For Two/.test(brief), brief.slice(0, 4000));
      chk('…the qualifying pitcher appears', /Alpha Ace/.test(brief), brief.slice(0, 4000));
      /* NOR IS A 0.00 ERA OVER ONE OUT. */
      chk('…the one-out 0.00 ERA is not presented as a leader',
        !/One Out Wonder/.test(brief), brief.slice(0, 4000));
      chk('…and the threshold is stated rather than hidden',
        /at least 30 at-bats/.test(brief), brief.slice(0, 4000));

      /* a live game has no box score of its own; the completed one does */
      await page.evaluate(() => window.cbbCloseBrief());
      await page.evaluate(() => window.cbbOpenBrief('p1'));
      await page.waitForFunction(() => {
        const el = document.getElementById('mlbhModalCard');
        return el && /Projection|could not be built/.test(el.textContent);
      }, null, { timeout: 25000 });
      const boxBrief = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('a game with a box score shows it', /This game’s box score/.test(boxBrief), boxBrief.slice(0, 300));
      chk('…with both clubs', /Alpha Aces/.test(boxBrief) && /Beta Bears/.test(boxBrief));
      chk('…and its batters', /Real Regular/.test(boxBrief), boxBrief.slice(0, 4000));
      chk('…and its pitchers', /Alpha Ace/.test(boxBrief), boxBrief.slice(0, 4000));
      /* THE COLUMN LABEL IS THE WHOLE POINT. A reader seeing .350 next to a
         2-for-4 line must be told it is his season figure, not that game's. */
      chk('…and labels the rate columns as season-to-date',
        /as of this game/.test(boxBrief), boxBrief.slice(0, 4000));
      chk('…and says so again in the column heading', /Avg to date/.test(boxBrief), boxBrief.slice(0, 4000));
      chk('no page error on the box score', errors.length === 0, errors.slice(0, 3));

      /* p2 is completed and has NO lines: the gap must be named. */
      await page.evaluate(() => window.cbbCloseBrief());
      await page.evaluate(() => window.cbbOpenBrief('p2'));
      await page.waitForFunction(() => {
        const el = document.getElementById('mlbhModalCard');
        return el && /Projection|could not be built/.test(el.textContent);
      }, null, { timeout: 25000 });
      const noBox = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('a completed game with no box score says so', /No box score is available/.test(noBox), noBox.slice(0, 4000));
      chk('…and calls it a gap in the feed rather than a quiet game',
        /gap in the feed, not a quiet game/.test(noBox), noBox.slice(0, 4000));
      chk('…and shows no box-score table at all', !/This game’s box score/.test(noBox), noBox.slice(0, 300));
      chk('no page error with no box score', errors.length === 0, errors.slice(0, 3));

      /* an abandoned game's brief must say there is no result */
      await page.evaluate(() => window.cbbCloseBrief());
      await page.evaluate(() => window.cbbOpenBrief('rain'));
      await page.waitForFunction(() => {
        const el = document.getElementById('mlbhModalCard');
        return el && /No result|Projection/.test(el.textContent);
      }, null, { timeout: 25000 });
      const rainBrief = await page.evaluate(() => document.getElementById('mlbhModalCard').textContent);
      chk('an abandoned game\'s brief says there is no result', /No result/.test(rainBrief), rainBrief.slice(0, 300));
      chk('…and that it is not a nil-nil draw', /not a nil-nil draw/i.test(rainBrief), rainBrief.slice(0, 400));
      chk('…and that it is excluded from the records',
        /excluded from both clubs/i.test(rainBrief), rainBrief.slice(0, 400));
      await ctx.close();
    }

    /* ══ 4. OUT OF SEASON — the screen with nothing on it ═══════════════════ */
    {
      const { page, ctx, errors } = await openApp();
      await page.evaluate(() => window.researchGo('baseball'));
      await page.waitForFunction(() => typeof window.mlbhSetSeg === 'function', null, { timeout: 25000 });
      /* September: the real out-of-season case, with the real clock */
      await page.evaluate(() => { window.cbbDay = (o) => {
        const t = new Date(Date.parse('2026-09-18T12:00:00Z') + (o || 0) * 864e5);
        return t.toISOString().slice(0, 10); }; });
      await page.evaluate(() => window.mlbhSetSeg('cbb'));
      await page.waitForFunction(() => {
        const b = document.getElementById('mlbhBody');
        return b && /out of season|No college games|did not load/i.test(b.textContent);
      }, null, { timeout: 25000 });
      const body = await page.evaluate(() => document.getElementById('mlbhBody').textContent);
      chk('out of season, the board says so plainly', /out of season/i.test(body), body.slice(0, 300));
      chk('…and explains when the season runs',
        /February/i.test(body) && /June/i.test(body), body.slice(0, 400));
      chk('…and does not read as a failure', !/did not load|error/i.test(body), body.slice(0, 300));
      chk('…while still saying what the archive holds', /archive holds/i.test(body), body.slice(0, 400));
      chk('no page error out of season', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }

    console.log(`  ..   ${reads} cbb reads answered from the real database`);
    if (readErrors.length) { console.log('  read errors:'); readErrors.slice(0, 5).forEach((e) => console.log('    ' + e)); }
    chk('every read the page made was answerable', readErrors.length === 0, readErrors.slice(0, 3));
  } catch (e) {
    console.log('FAIL | cbb research surface | ' + (e && e.stack || e)); fail++;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    try { if (site) site.close(); } catch (_) {}
    try { db.close(); } catch (_) {}
    PG.dropDatabase(conn, DB);
  }
  console.log(fail === 0 ? `ALL GREEN ${pass} passed, 0 failed` : `FAILED ${pass} passed, ${fail} failed`);
  if (fail === 0) console.log(`PASS | cbb research surface | ${pass} assertions in a real browser`);
  process.exit(fail === 0 ? 0 : 1);
})();
