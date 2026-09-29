#!/usr/bin/env node
/* ===========================================================================
   PLAYER PROPS, IN A REAL BROWSER (desktop 1440 px and a 390 px phone).

   app.html in Chromium, served from the repo, with a board BUILT IN THIS
   PROCESS by football/props/build_board.js from the real-data fixture
   (football/props/fixtures/dataset_nfl.json.gz) and the hand-written Odds API
   fixture (test data, not market data) — the same code path the scheduled
   build runs. The page's clock is pinned ten minutes after the capture. It
   proves:

     - the Props seat opens #v-pprops; the terminal paints the board, the
       capture strip and the probability source; no horizontal scroll
     - market tabs list only categories that carry data
     - filters (EV, side, price), search ("rushing yards", a team), sort
     - the research drawer: price table, alternates, projection, probability,
       EV, history, usage, matchup, game context, role, uncertainty, why/risks;
       "price any line" prices a typed line
     - My Props (a star), All Props (projection-only rows say NO MARKET)
     - the performance view; the college board loads beside it
     - two hours later every price reads STALE and nothing is decided
     - a phone: cards, collapsed filters, a full-screen drawer
     - #playerprops/nfl/<prop> opens that prop; /player/<id> opens a player
       (usage, recent games, only his props; an unknown id is said);
       /game/<id> opens a game
     - the game-card section reads nothing until opened, then shows the
       leads and the headline projections and links into the game
     - the Lab's Player props validation view and the public record section

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one.
   Run:  node tools/props/props_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
global.window = global.window || global;

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function finish() { console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' | player props (browser) | ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const OBS = '2026-10-04T15:05:00.000Z', NOW = Date.parse('2026-10-04T15:15:00Z');

async function buildFixture() {
  const B = require(path.join(ROOT, 'football', 'props', 'build_board.js'));
  const CAP = require(path.join(ROOT, 'football', 'props', 'capture.js'));
  const G = require(path.join(ROOT, 'football', 'props', 'grade.js'));
  const ds = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'football', 'props', 'fixtures', 'dataset_nfl.json.gz'))).toString('utf8'));
  const ev = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'props', 'fixtures', 'odds_event_nfl.json'), 'utf8'));
  const p = CAP.parseEventProps(ev, OBS);
  const feed = CAP.buildQuotesFeed({ league: 'nfl', now: NOW, polled: [{ id: ev.id, commence_time: ev.commence_time, home_team: ev.home_team, away_team: ev.away_team, books: p.books, quotes: p.quotes }], observed_at: OBS });
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'edp-ui-'));
  const paths = {}; Object.entries(require(path.join(ROOT, 'football', 'props', 'config.js')).leaguePaths('nfl', 2026)).forEach(([k, v]) => { paths[k] = v.replace(path.join(ROOT, 'football', 'props'), tmp); });
  /* the committed same-game correlation model, as the scheduled build reads it */
  fs.mkdirSync(path.dirname(paths.correlation), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'football', 'props', 'nfl', 'correlation.json'), paths.correlation);
  /* TEST FIXTURE factory projections (docs/player-props/FACTORY.md): each
     prop's own engine distribution, shifted 6 % and carried in the factory's
     stored CDF form, so the drawer's Validated model section has a second
     opinion to show. Test data, never published. */
  const r0 = await B.build({ league: 'nfl', season: 2026, now: NOW - 5 * 60000, dataset: ds, quotes: feed, lines: null, paths });
  const EDP = require(path.join(ROOT, 'lib', 'edgedesk_props.js'));
  const factory = { schema: 'edgedesk_props_factory_projections_v1', league: 'NFL', season: 2026, generated_at: new Date(NOW - 3600e3).toISOString(), feature_version: 'pf1',
    rule: 'TEST FIXTURE', model_cols: ['model_version', 'outcome_tier', 'walk_forward_mae_skill', 'walk_forward_pit_dev', 'folds'],
    models: [['nfl_fixture_v1.2025', 'OUTCOME_VALIDATED', 0.11, 0.02, 3]], rows: {}, n: 0 };
  r0.board.props.forEach((x) => {
    if (!x.p || !x.x || !x.x.dist || !EDP.validDist(x.x.dist)) return;
    const d = EDP.scaleDist(x.x.dist, 1.06), lo = EDP.quantile(d, 0.001) - 1, hi = EDP.quantile(d, 0.999) + 1, xs = [], ps = [];
    for (let k = lo; k <= hi; k++) { xs.push(k + 0.5); ps.push(Math.round(EDP.cdfInt(d, k) * 1e4) / 1e4); }
    ps[ps.length - 1] = 1;
    factory.rows[x.g + '|' + x.p + '|' + x.m] = [0, { t: 'cdf', x: xs, p: ps, int: true }, null, null, null, null, factory.generated_at, []];
    factory.n++;
  });
  const r = await B.build({ league: 'nfl', season: 2026, now: NOW - 5 * 60000, dataset: ds, quotes: feed, lines: null, paths, factory });
  r.board.capture = { last_run: OBS, last_attempt: OBS, bookmakers: p.books, events_polled: 1, requests_remaining: 480 };
  /* a small graded record so the performance view has something real to draw */
  const rows = r.ledger_rows.slice(0, 3).map((x) => Object.assign({}, x, { game_id: '2026_03_ATL_GB', kickoff: '2026-09-25T00:15:00.000Z' }));
  const perf = G.report('nfl', 2026, G.grade(ds, rows, [], NOW), rows, NOW);
  return { board: r.board, players: r.players, perf };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const FX = await buildFixture();
  const served = { '/football/props/nfl/board.json': JSON.stringify(FX.board), '/football/props/nfl/players.json': JSON.stringify(FX.players), '/football/props/nfl/performance.json': JSON.stringify(FX.perf) };
  /* the college record is UNPUBLISHED in this run, whatever the repository
     holds today: the record page's empty state is what is being proven */
  const absent = { '/football/props/cfb/performance.json': 1 };
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (absent[p]) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    if (served[p]) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(served[p]); return; }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, hash, at) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) { /* storage */ }
    });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date(at || NOW));
    await page.goto(`http://127.0.0.1:${port}/app.html${hash || ''}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  try {
    /* ---------------------------------------------------------- desktop */
    console.log('desktop');
    let { ctx, page, errors } = await open({ width: 1440, height: 900 }, '');
    await page.waitForSelector('.bottomnav button[data-v="pprops"]');
    await page.click('.bottomnav button[data-v="pprops"]');
    await page.waitForSelector('.pp-row', { timeout: 15000 });
    chk('the Props seat opens the Player Props view', await page.evaluate(() => !document.getElementById('v-pprops').classList.contains('hide') && document.querySelector('.bottomnav button[data-v="pprops"]').classList.contains('on')));
    chk('the terminal paints its header and the capture strip', await page.evaluate(() => /PLAYER PROPS/.test(document.querySelector('.pp-title').textContent) && /Prices captured/.test(document.querySelector('.pp-strip').textContent)));
    chk('the probability source is printed', await page.evaluate(() => /MODEL-ESTIMATED/.test(document.querySelector('.pp-strip').textContent)));
    const nBest = await page.evaluate(() => EDPropsUI._visible().length);
    chk('Best Value lists the priced props, ranked', nBest >= 15 && await page.evaluate(() => { const v = EDPropsUI._visible(); const R = { BET: 4, LEAN: 3, WATCH: 2, PASS: 1, NO_DECISION: 0 }; return v.every((r, i) => i === 0 || R[v[i - 1].decision] >= R[r.decision]); }), nBest);
    chk('no horizontal scroll on a 1440 px desktop', await noHScroll(page));
    await page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
    chk('the page re-priced every prop itself', await page.evaluate(() => Object.keys(EDPropsUI.state.evals.nfl).length === EDPropsUI.state.boards.nfl.props.length));
    const cats = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-cats .pp-tab')).map((b) => b.textContent.replace(/\d+/g, '').trim()));
    chk('market tabs list only categories that carry data', cats.indexOf('Kicking & defence') < 0 && cats.indexOf('Rushing') >= 0 && cats[0] === 'All', cats);
    await shot(page, 'desktop_board');
    /* filters */
    await page.click('.pp-chip[data-k="minEv"][data-v="0.05"]');
    const ev5 = await page.evaluate(() => EDPropsUI._visible().map((r) => r.cand && r.cand.ev));
    chk('EV > 5% keeps only rows above it', ev5.length > 0 && ev5.length < nBest && ev5.every((e) => e > 0.05), ev5);
    await page.click('.pp-chip[data-k="minEv"][data-v="0.05"]');
    await page.click('.pp-chip[data-pp-act="side"][data-v="under"]');
    chk('Under only', await page.evaluate(() => EDPropsUI._visible().every((r) => r.cand && r.cand.side === 'under')));
    await page.click('.pp-chip[data-pp-act="side"][data-v="all"]');
    await page.click('.pp-chip[data-k="price"][data-v="plus"]');
    chk('plus money only', await page.evaluate(() => EDPropsUI._visible().every((r) => r.cand && r.cand.american > 0)));
    await page.click('.pp-chip[data-k="price"][data-v="plus"]');
    await page.fill('#ppSearch', 'rushing yards');
    await page.waitForTimeout(400);
    chk('search "rushing yards" finds the rushing-yards props', await page.evaluate(() => { const v = EDPropsUI._visible(); return v.length > 0 && v.every((r) => r.market === 'rush_yds'); }));
    await page.fill('#ppSearch', 'Saints');
    await page.waitForTimeout(400);
    chk('search by team name', await page.evaluate(() => { const v = EDPropsUI._visible(); return v.length > 0 && v.every((r) => r.team === 'NO' || r.opp === 'NO' || r.g.home === 'NO' || r.g.away === 'NO'); }));
    await page.fill('#ppSearch', 'WR receptions');
    await page.waitForTimeout(400);
    chk('search "WR receptions"', await page.evaluate(() => { const v = EDPropsUI._visible(); return v.length > 0 && v.every((r) => r.pos === 'WR' && r.market === 'receptions'); }));
    await page.fill('#ppSearch', '');
    await page.waitForTimeout(400);
    await page.selectOption('select[data-pp-set="sort"]', 'ev');
    chk('sort by best EV', await page.evaluate(() => { const v = EDPropsUI._visible().map((r) => r.cand ? r.cand.ev : -9); return v.every((x, i) => i === 0 || v[i - 1] >= x); }));
    /* the drawer */
    const bijan = await page.evaluate(() => { const r = EDPropsUI._rowsOf('nfl').find((x) => x.name === 'Bijan Robinson' && x.market === 'rush_yds'); return r && r.key; });
    await page.evaluate((k) => { EDPropsUI.state.drawer = k; EDPropsUI.render(); }, bijan);
    await page.waitForSelector('#ppDrawer .pp-sec');
    await page.waitForFunction(() => /Last 10/.test(document.getElementById('ppDrawer').textContent), null, { timeout: 15000 });
    const secs = await page.evaluate(() => Array.from(document.querySelectorAll('#ppDrawer .pp-sec h4')).map((h) => h.firstChild.textContent.trim()));
    ['Price', 'Alternate lines', 'EdgeDesk projection', 'Probability', 'EV', 'Why EdgeDesk likes / dislikes it', 'History', 'Usage', 'Game context', 'Role', 'Uncertainty'].forEach((s) => chk('the drawer has ' + s, secs.indexOf(s) >= 0, secs));
    chk('the drawer has the opponent matchup', secs.some((s) => /^Matchup/.test(s)), secs);
    const fxSec = await page.evaluate(() => { const h = Array.from(document.querySelectorAll('#ppDrawer .pp-sec')).find((x) => { const t = x.querySelector('h4'); return t && /^Validated model/.test(t.textContent); }); return h ? h.textContent.replace(/\s+/g, ' ') : null; });
    await page.evaluate(() => { const h = Array.from(document.querySelectorAll('#ppDrawer .pp-sec')).find((x) => { const t = x.querySelector('h4'); return t && /^Validated model/.test(t.textContent); }); if (h) h.scrollIntoView({ block: 'center' }); });
    await shot(page, 'desktop_drawer_factory');
    chk('the drawer shows the data factory\'s validated model beside the engine', !!fxSec && /Engine P/.test(fxSec) && /P\((over|under) \d/.test(fxSec) && /walk-forward/.test(fxSec) && /does not set this decision/.test(fxSec), fxSec);
    const corr = await page.evaluate(() => { const h = Array.from(document.querySelectorAll('#ppDrawer .pp-sec')).find((x) => x.querySelector('h4') && /^Same-game correlation/.test(x.querySelector('h4').textContent)); return h ? { text: h.textContent, rows: h.querySelectorAll('tbody tr').length } : null; });
    chk('the drawer shows the props this one moves with, each pair simulated jointly', corr && corr.rows >= 1 && /Both win/.test(corr.text) && /If independent/.test(corr.text) && /10,000-run/.test(corr.text), corr);
    chk('the price table names every book and the consensus', await page.evaluate(() => /DraftKings/.test(document.getElementById('ppDrawer').textContent) && /Consensus/.test(document.getElementById('ppDrawer').textContent)));
    chk('hit rates are labelled context, not probability', await page.evaluate(() => /context only/i.test(document.getElementById('ppDrawer').textContent)));
    chk('usage says what no public feed carries', await page.evaluate(() => /not in feed|Not in any public feed/.test(document.getElementById('ppDrawer').textContent)));
    await page.fill('#ppCLine', '79.5'); await page.fill('#ppCPrice', '-125'); await page.click('[data-pp-act="custom"]');
    chk('"price any line" prices a typed line and price', /EV [+−]/.test(await page.textContent('#ppCOut')), await page.textContent('#ppCOut'));
    chk('the distribution chart is drawn', await page.evaluate(() => { const c = document.getElementById('ppDist'); return !!c && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0); }));
    await shot(page, 'desktop_drawer');
    if (SHOTS) { const el = await page.$('#ppDrawer .pp-corr'); if (el) { await el.scrollIntoViewIfNeeded(); await (await el.evaluateHandle((x) => x.closest('.pp-sec'))).asElement().screenshot({ path: path.join(SHOTS, 'desktop_drawer_correlation.png') }); } }
    await page.click('[data-pp-act="close"]');
    /* stars → My Props */
    await page.click('.pp-row .pp-star');
    await page.click('.pp-mode[data-v="mine"]');
    chk('a starred prop appears in My Props', await page.evaluate(() => EDPropsUI._visible().length === 1));
    chk('stars persist on the device', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('edgedesk_props_watch_v1')).prop).length === 1));
    await page.click('.pp-mode[data-v="all"]');
    chk('All Props includes EdgeDesk-only projections labelled NO MARKET', await page.evaluate(() => EDPropsUI._visible().some((r) => !r.priced && r.code === 'NO_MARKET')));
    /* a game from the sidebar */
    await page.click('.pp-gm[data-v="2026_04_ATL_NO"]');
    chk('a game in the sidebar filters the board to it', await page.evaluate(() => { const v = EDPropsUI._visible(); return v.length > 0 && v.every((r) => r.g.game_id === '2026_04_ATL_NO'); }));
    /* performance */
    await page.click('.pp-mode[data-v="perf"]');
    await page.waitForSelector('.pp-perf');
    chk('the performance view shows the record, calibration and the backtest', await page.evaluate(() => { const t = document.querySelector('.pp-perf').textContent; return /Calibration/.test(t) && /W-L-P/.test(t); }));
    await shot(page, 'desktop_perf');
    /* the college board */
    await page.click('.pp-mode[data-v="all"]');
    await page.click('.pp-seg button[data-v="cfb"]');
    await page.waitForFunction(() => ['ok', 'error'].indexOf(EDPropsUI.state.status.cfb) >= 0, null, { timeout: 20000 });
    chk('the college board loads (or says why) without breaking the NFL one', await page.evaluate(() => EDPropsUI.state.status.cfb === 'ok' ? EDPropsUI._rowsOf('cfb').length > 0 : !!document.querySelector('.pp-err,.pp-empty')) && await page.evaluate(() => EDPropsUI.state.status.nfl === 'ok'));
    chk('no page errors on the desktop', errors.length === 0, errors);
    await ctx.close();

    /* ---------------------------------------------------------- stale */
    console.log('stale');
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl', NOW + 2 * 3600e3));
    await page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
    chk('two hours on, the capture strip warns the prices are stale', await page.evaluate(() => /STALE/.test(document.querySelector('.pp-strip').textContent)));
    chk('and no stale price is decided on', await page.evaluate(() => EDPropsUI._rowsOf('nfl').filter((r) => r.priced && r.r.p).every((r) => r.decision === 'NO_DECISION')));
    await ctx.close();

    /* ---------------------------------------------------------- phone */
    console.log('phone');
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, '#playerprops'));
    await page.waitForSelector('.pp-card', { timeout: 15000 });
    chk('the deep link #playerprops opens the terminal', await page.evaluate(() => !document.getElementById('v-pprops').classList.contains('hide')));
    chk('a phone shows cards, not the table', await page.evaluate(() => getComputedStyle(document.querySelector('.pp-table')).display === 'none' && document.querySelectorAll('.pp-card').length > 0));
    chk('filters are collapsed behind one control', await page.evaluate(() => !document.querySelector('.pp-fbox').open));
    chk('no horizontal scroll on a 390 px phone', await noHScroll(page));
    await shot(page, 'phone_cards');
    await page.click('.pp-card');
    await page.waitForSelector('#ppDrawer .pp-sec');
    chk('a tapped card opens the full-screen research drawer', await page.evaluate(() => { const r = document.getElementById('ppDrawer').getBoundingClientRect(); return r.width >= 380 && r.top <= 1; }));
    chk('the phone drawer does not scroll sideways', await page.evaluate(() => { const d = document.getElementById('ppDrawer'); return d.scrollWidth <= d.clientWidth + 1; }));
    await shot(page, 'phone_drawer');
    chk('no page errors on the phone', errors.length === 0, errors);
    await ctx.close();

    /* ---------------------------------------------------------- deep link to a prop */
    console.log('deep link');
    const key = FX.board.props.find((x) => x.q.length && x.p).g;
    const pk = 'nfl|' + key + '|' + FX.board.props.find((x) => x.q.length && x.p).p + '|' + FX.board.props.find((x) => x.q.length && x.p).m;
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl/' + encodeURIComponent(pk)));
    await page.waitForSelector('#ppDrawer .pp-sec', { timeout: 15000 });
    chk('#playerprops/nfl/<prop> opens that prop\'s research', await page.evaluate((k) => EDPropsUI.state.drawer === k, pk));
    await ctx.close();

    /* ---------------------------------------------------------- a player */
    console.log('player');
    const pr0 = FX.board.props.find((x) => x.q.length && x.p), pid = pr0.p, gid = pr0.g, pname = FX.board.players[pid + '@' + gid].name;
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl/player/' + encodeURIComponent(pid)));
    await page.waitForSelector('.pp-player', { timeout: 15000 });
    chk('#playerprops/nfl/player/<id> opens that player: who he is and his usage', await page.evaluate((n) => { const el = document.querySelector('.pp-player'); return el.textContent.indexOf(n) >= 0 && /Usage/.test(el.textContent) && /Recent games/.test(el.textContent); }, pname));
    await page.waitForFunction(() => document.querySelector('.pp-player table'), null, { timeout: 15000 });
    chk('…with his recent game log from players.json', await page.evaluate(() => document.querySelectorAll('.pp-player table tbody tr').length >= 1));
    chk('…and only his props below it', await page.evaluate((p) => EDPropsUI._visible().length > 0 && EDPropsUI._visible().every((r) => r.r.p === p), pid));
    chk('no horizontal scroll with the player panel', await noHScroll(page));
    await shot(page, 'desktop_player');
    await page.click('.pp-player .pp-btn[data-pp-act="player"]');
    chk('"All players" clears the player and its link', await page.evaluate(() => !EDPropsUI.state.player && !/\/player\//.test(location.hash)));
    chk('no page errors on the player view', errors.length === 0, errors);
    await ctx.close();
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, '#playerprops/nfl/player/00-0000000'));
    await page.waitForSelector('.pp-player', { timeout: 15000 });
    chk('a player not on the board is said, not invented (phone)', await page.evaluate(() => /no props on the current NFL board/.test(document.querySelector('.pp-player').textContent)));
    chk('no horizontal scroll on the phone player view', await noHScroll(page));
    await ctx.close();

    /* ---------------------------------------------------------- a game, and the game-card section */
    console.log('game');
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl/game/' + encodeURIComponent(gid)));
    await page.waitForFunction(() => EDPropsUI.state.boards.nfl && EDPropsUI._visible && EDPropsUI._visible().length > 0, null, { timeout: 15000 });
    chk('#playerprops/nfl/game/<id> opens that game\'s props', await page.evaluate((g) => EDPropsUI.state.game === g && EDPropsUI._visible().every((r) => r.g.game_id === g), gid));
    await ctx.close();
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, ''));
    await page.waitForFunction(() => typeof fbPropsSecHTML === 'function' && window.EDPropsUI, null, { timeout: 15000 });
    const lazy = await page.evaluate((g) => { const d = document.createElement('div'); d.id = 'gcTest'; d.innerHTML = fbPropsSecHTML('nfl', g); document.body.prepend(d); return d.textContent; }, gid);
    chk('the card section is lazy: the board is not read until it opens', /Load player props/.test(lazy) && await page.evaluate(() => !EDPropsUI.state.boards.nfl), lazy);
    await page.evaluate(() => { const d = document.querySelector('#gcTest details'); d.open = true; });
    await page.waitForSelector('#gcTest .pp-gfoot', { timeout: 15000 });
    const card = await page.evaluate(() => document.querySelector('#gcTest .pp-gsec').textContent);
    chk('opened, it shows the priced leads with the page\'s decision and EV, and the headline projections', /EV/.test(card) && /(LEAN|BET)/.test(card) && /Median/.test(card) && /props projected/.test(card), card.slice(0, 400));
    chk('no horizontal scroll with the card section on a phone', await noHScroll(page));
    await page.evaluate(() => { window.scrollTo(0, 0); }); await shot(page, 'phone_game_card_section');
    await page.click('#gcTest .pp-gfoot .pp-btn');
    await page.waitForFunction(() => !document.getElementById('v-pprops').classList.contains('hide') && EDPropsUI._visible && EDPropsUI._visible().length > 0, null, { timeout: 15000 });
    chk('"All props for this game" opens the Props page on that game', await page.evaluate((g) => EDPropsUI.state.game === g && location.hash === '#playerprops/nfl/game/' + encodeURIComponent(g), gid));
    chk('no page errors from the card section', errors.length === 0, errors);
    await ctx.close();

    /* ---------------------------------------------------------- the Lab and the public record */
    console.log('lab and record');
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, ''));
    await page.waitForFunction(() => window.EDPropsUI && EDPropsUI.lab, null, { timeout: 15000 });
    await page.evaluate(() => { const d = document.createElement('div'); d.id = 'labTest'; document.body.prepend(d); EDPropsUI.lab(d); });
    await page.waitForSelector('#labTest .pp-lab', { timeout: 15000 });
    const lab = await page.evaluate(() => ({ text: document.querySelector('#labTest .pp-lab').textContent, tags: document.querySelectorAll('#labTest .pp-stage').length, rows: document.querySelectorAll('#labTest tbody tr').length }));
    chk('the Lab lists every scored market with its stage and gates', lab.rows >= 10 && lab.tags >= lab.rows && /Walk-forward/.test(lab.text) && /Beats the naive last-8 baseline/.test(lab.text), lab);
    chk('…and says college markets are EXPERIMENTAL without a backtest', /College football/.test(lab.text) && /EXPERIMENTAL/.test(lab.text));
    chk('the Lab registers the Player props validation tool', await page.evaluate(() => /Player props validation/.test(document.documentElement.innerHTML)));
    chk('no page errors from the Lab view', errors.length === 0, errors);
    await page.evaluate(() => { window.scrollTo(0, 0); }); await shot(page, 'desktop_lab');
    await ctx.close();
    {
      const rctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await rctx.route('**/*', (route) => (route.request().url().startsWith('http://127.0.0.1') ? route.continue() : route.fulfill({ status: 204, body: '' })));
      const rp = await rctx.newPage(); const rerr = []; rp.on('pageerror', (e) => rerr.push(String(e)));
      await rp.goto(`http://127.0.0.1:${port}/record.html`, { waitUntil: 'domcontentloaded' });
      await rp.waitForFunction(() => document.getElementById('propsPub') && !/Loading/.test(document.getElementById('propsPub').textContent), null, { timeout: 15000 });
      const rec = await rp.evaluate(() => document.getElementById('propsPub').textContent);
      chk('the public record copies the NFL props record from performance.json', /NFL/.test(rec) && /Bets \(W-L-P\)/.test(rec) && /Closing-line value/.test(rec), rec.slice(0, 300));
      chk('…and an unpublished college record is the empty state, not a number', /No college football player prop has been graded yet/.test(rec), rec.slice(-300));
      chk('no horizontal scroll on the record page (phone)', await rp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
      chk('no page errors on the record page', rerr.length === 0, rerr);
      if (SHOTS) await (await rp.$('#player-props')).screenshot({ path: path.join(SHOTS, 'phone_record_props.png') });
      await rctx.close();
    }
  } catch (e) {
    chk('the browser run completed', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close(); srv.close();
  }
  finish();
})();
