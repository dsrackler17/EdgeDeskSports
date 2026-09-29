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
     - two hours later (between scheduled checks) the strip says "on schedule"
       and when the next check is, with no banner; nothing is decided; a
       new week's injury report not out yet is said plainly, not flagged STALE
     - a phone: cards, collapsed filters, a full-screen drawer; two hours
       on, stale cards keep their line and last prices (no EV, no decision)
       in the last capture's order
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
  r.board.capture = { status: 'SUCCESS', reason: 'QUOTES_WRITTEN', last_run: OBS, last_success_at: OBS, last_attempt: OBS, completed_at: OBS, bookmakers: p.books, books_returned: p.books, events_polled: 1, events_checked: 1, requests_remaining: 480 };
  /* a small graded record so the performance view has something real to draw */
  const rows = r.ledger_rows.slice(0, 3).map((x) => Object.assign({}, x, { game_id: '2026_03_ATL_GB', kickoff: '2026-09-25T00:15:00.000Z' }));
  const perf = G.report('nfl', 2026, G.grade(ds, rows, [], NOW), rows, NOW);
  /* the per-league summary written with every board build (football/props/build_summary.js) */
  const summary = require(path.join(ROOT, 'football', 'props', 'build_summary.js')).summarize(r.board, null);
  return { board: r.board, players: r.players, perf, summary };
}

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const FX = await buildFixture();
  const served = { '/football/props/nfl/board.json': JSON.stringify(FX.board), '/football/props/nfl/players.json': JSON.stringify(FX.players), '/football/props/nfl/performance.json': JSON.stringify(FX.perf), '/football/props/nfl/summary.json': JSON.stringify(FX.summary) };
  /* the college record is UNPUBLISHED in this run, whatever the repository
     holds today: the record page's empty state is what is being proven */
  const absent = { '/football/props/cfb/performance.json': 1 };
  const seenUrls = [];
  let propsCron = null;   /* the refresh flow's stand-in for supabase/functions/props_cron */
  function siteHandler(req, res) {
    seenUrls.push(req.url);
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
      if (/functions\/v1\/props_cron/.test(u) && propsCron) return propsCron(route);
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
    chk('the terminal paints its header and the capture strip', await page.evaluate(() => /PLAYER PROPS/.test(document.querySelector('.pp-title').textContent) && /Sportsbook prices: current · updated \d+ min ago · \d+ books · [\d,]+ current prices/.test(document.querySelector('.pp-strip').textContent)));
    chk('healthy: no banner at all (nothing to explain)', await page.evaluate(() => !document.querySelector('.pp-banner') && !document.querySelector('.pp-warnbox')));
    chk('the header says when the PRICES were captured, not only when the board was built', await page.evaluate(() => /Prices updated\s*\d+ min ago/.test(document.querySelector('.pp-upd').textContent)));
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
    /* two hours on, a game 33 h out is on its 2-hour cadence: the pipeline is
       on schedule, but no price is executable — said once, calmly, in the
       strip (never a banner over every visit, never "0 current prices", never
       a STALE pill on every row); the ⓘ explains the price clock */
    const st2 = await page.evaluate(() => ({ strip: document.querySelector('.pp-strip').textContent, banner: (document.querySelector('.pp-banner') || {}).textContent || '', pills: document.querySelectorAll('.pp-rows .pp-stale').length,
      sched: (document.querySelector('.pp-strip .pp-sched') || {}).textContent || '',
      /* what is on screen: the ⓘ's explanation is collapsed */
      shown: (() => { const c = document.querySelector('.pp-strip').cloneNode(true); c.querySelectorAll('.pp-sched > span').forEach((x) => x.remove()); return c.textContent; })(),
      rows: EDPropsUI._rowsOf('nfl').filter((r) => r.priced && r.r.p), health: EDPropsUI._pageHealth(EDPropsUI.state.boards.nfl).state }));
    chk('two hours on (between the far game\'s checks): no banner, and the strip says "on schedule" and how old the last prices are — never "0 current prices"', /Sportsbook prices: on schedule/.test(st2.shown) && /last 2\.\d h ago/.test(st2.shown) && !/current prices/.test(st2.shown) && !st2.banner && st2.health === 'HEALTHY', st2.shown + ' || ' + st2.banner);
    const fold = await page.evaluate(() => { const d = document.querySelector('.pp-strip .pp-sched'); return d ? { open: d.open, h: d.querySelector('span').getBoundingClientRect().height, vis: d.querySelector('span').checkVisibility ? d.querySelector('span').checkVisibility() : null } : null; });
    chk('…its explanation is folded away until asked for', !!fold && !fold.open && (fold.h === 0 || fold.vis === false), fold);
    chk('…and its ⓘ explains the price clock: reference only, nothing decided, Refresh prices', /every 1 h inside 24 h, 2 h inside 48 h, 6 h beyond/.test(st2.sched) && /reference only/.test(st2.sched) && /nothing is decided on a price older than 30 minutes/.test(st2.sched) && /Refresh prices/.test(st2.sched), st2.sched);
    chk('and no stale price is decided on', st2.rows.length > 0 && st2.rows.every((r) => r.decision === 'NO_DECISION' && r.wait && !r.cand && !r.units));
    chk('no STALE pill on any row', st2.pills === 0, st2.pills);
    await shot(page, 'desktop_between_checks');
    const cells = await page.evaluate(() => Array.from(document.querySelectorAll('.pp-row')).filter((row) => /WAIT FOR PRICE/.test(row.textContent)).slice(0, 5).map((row) => { const c = row.children; return { best: c[6].textContent, proj: c[7].textContent, fair: c[8].textContent, ev: c[11].textContent, stake: c[15].textContent, over: c[4].className, dec: c[14].textContent }; }));
    chk('a waiting row: decision WAIT FOR PRICE and its last price "O 212.5 +105 MGM" — its age is the strip\'s, not repeated on every row', cells.length > 0 && cells.every((c) => /WAIT FOR PRICE/.test(c.dec) && /^(O|U|Yes|No)[^+−-]*[+−-]\d+ \w+$/.test(c.best)), cells.slice(0, 2));
    chk('…and the reference price still carries its age where it is read closely (the tooltip)', await page.evaluate(() => Array.from(document.querySelectorAll('.pp-row .best b.pp-last')).slice(0, 5).every((x) => /Last seen .* 2\.\d h ago — reference only/.test(x.title))));
    chk('…its research stays (projection and fair line), its price-dependent numbers wait (EV, stake)', cells.every((c) => /\d/.test(c.proj) && /\d/.test(c.fair) && c.ev === '—' && c.stake === '—'), cells.slice(0, 2));
    chk('…and its last Over / Under prices are styled as reference, never as live numbers', cells.every((c) => /pp-ref/.test(c.over)), cells.map((c) => c.over).slice(0, 2));
    await page.click('.pp-row');
    await page.waitForSelector('#ppDrawer .pp-sec');
    const dw = await page.evaluate(() => document.getElementById('ppDrawer').textContent);
    await shot(page, 'desktop_wait_drawer');
    chk('the drawer keeps the model opinion beside the dead market: projection, last line, last quote, PRICE EXPIRED/STALE, WAIT FOR CURRENT MARKET', /Projection/.test(dw) && /Last observed line/.test(dw) && /Last quote\s*2\.\d h ago/.test(dw) && /PRICE (EXPIRED|STALE)/.test(dw) && /WAIT FOR CURRENT MARKET/.test(dw) && /\(reference\)/.test(dw), dw.slice(0, 600));
    await ctx.close();
    /* the same two hours, with the scheduler's next check ahead and the new
       week's injury report not published yet (Monday, Tuesday) */
    {
      const bp = '/football/props/nfl/board.json', keep = served[bp];
      const wk = Math.min.apply(null, FX.board.games.map((g) => g.week).filter(Number.isFinite));
      served[bp] = JSON.stringify(Object.assign({}, FX.board, { capture: Object.assign({}, FX.board.capture, { next_due_at: new Date(NOW + 2.5 * 3600e3).toISOString() }),
        sources: Object.assign({}, FX.board.sources, { injuries: Object.assign({}, FX.board.sources.injuries, { latest_week: wk - 1 }) }) }));
      const o = await open({ width: 1440, height: 900 }, '#playerprops/nfl', NOW + 2 * 3600e3);
      await o.page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
      const t = await o.page.evaluate(() => document.querySelector('.pp-strip').textContent);
      await shot(o.page, 'desktop_between_checks_next');
      chk('with the next check ahead, the strip says when it is', /on schedule · next check \d{1,2}:\d{2}/.test(t), t);
      chk('a new week\'s injury report not out yet is said plainly, without a STALE flag', new RegExp('Injury report week ' + wk + ' not out yet').test(t) && !/STALE/.test(t), t);
      chk('no page errors with the next check and the pending report', o.errors.length === 0, o.errors);
      await o.ctx.close();
      served[bp] = keep;
    }
    /* the far game is now past its 2-hour target: DELAYED, with recovery */
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl', NOW + 2.75 * 3600e3));
    await page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
    const d3 = await page.evaluate(() => ({ strip: document.querySelector('.pp-strip').textContent, banner: (document.querySelector('.pp-banner.delayed') || {}).textContent || '' }));
    await shot(page, 'desktop_delayed');
    chk('past its check target: DELAYED — "temporarily unavailable", last capture, recovery running, no stale decision', /prices delayed/.test(d3.strip) && /Current sportsbook pricing temporarily unavailable/.test(d3.banner) && /Last successful capture: 2\.\d h ago/.test(d3.banner) && /Automatic recovery is running/.test(d3.banner) && /No stale quote will generate a betting decision/.test(d3.banner), d3);
    await ctx.close();
    /* nothing has even tried for five hours: OUTAGE, and it says the capture is overdue */
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl', NOW + 5 * 3600e3));
    await page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
    const d5 = await page.evaluate(() => (document.querySelector('.pp-banner.outage') || {}).textContent || '');
    await shot(page, 'desktop_outage');
    chk('no capture attempt for five hours: OUTAGE, naming the overdue capture', /Current sportsbook pricing is unavailable/.test(d5) && /overdue/.test(d5) && /Model projections remain available/.test(d5), d5);
    chk('no page errors across the freshness states', errors.length === 0, errors);
    await ctx.close();

    /* the capture's status reaches the page as itself: a provider answer with
       no markets, a failed capture and a capture that never ran each say so */
    console.log('capture status');
    const boardPath = '/football/props/nfl/board.json', live = served[boardPath];
    const unpriced = (capture) => JSON.stringify(Object.assign({}, FX.board, { capture, props: FX.board.props.map((x) => Object.assign({}, x, { q: [] })), counts: Object.assign({}, FX.board.counts, { priced: 0 }) }));
    const stripAndEmpty = async (capture) => {
      served[boardPath] = unpriced(capture);
      const o = await open({ width: 1440, height: 900 }, '#playerprops/nfl');
      await o.page.waitForSelector('.pp-strip');
      await o.page.waitForSelector('.pp-empty');
      const t = await o.page.evaluate(() => ({ strip: document.querySelector('.pp-strip').textContent, warn: (document.querySelector('.pp-banner') || {}).textContent || '', empty: document.querySelector('.pp-empty').textContent }));
      await o.ctx.close();
      return t;
    };
    const tNo = await stripAndEmpty({ status: 'NO_MARKETS', reason: 'MARKETS_NOT_RELEASED', why: 'The Odds API answered for 1 NFL event (HTTP 200) with no player market from any of the 10 books asked.', last_run: OBS, last_success_at: null, completed_at: OBS, events_checked: 1 });
    chk('NO_MARKETS: the strip says markets are not released, and shows the provider evidence', /markets not released yet/.test(tNo.strip) && /Sportsbooks have not released/.test(tNo.warn) && /HTTP 200/.test(tNo.warn) && /Waiting for sportsbooks to release player markets/.test(tNo.empty), tNo);
    const tErr = await stripAndEmpty({ status: 'ERROR', reason: 'EVENT_INDEX_FAILED', why: 'The Odds API event index for NFL failed (HTTP 401): no prop was requested.', error_message: 'event index HTTP 401: invalid key', last_run: null, last_success_at: null, completed_at: OBS });
    chk('ERROR: the strip says the capture failed, with the provider\'s error — not "not released"', /capture error/.test(tErr.strip) && /capture failed/.test(tErr.warn) && /HTTP 401: invalid key/.test(tErr.warn) && !/not released/.test(tErr.strip + tErr.warn + tErr.empty), tErr);
    const tNot = await stripAndEmpty({ status: 'NOT_RUN', reason: 'NO_STATE_FILE', state: 'NOT_CAPTURED', why: 'The prop capture has never run for this league.', last_run: null, last_success_at: null });
    chk('NOT_RUN: the strip says not captured yet and the empty state does not claim the books are late', /not captured yet/.test(tNot.strip) && /never run/.test(tNot.warn) && /have not been captured yet/.test(tNot.empty) && !/release/.test(tNot.empty), tNot);
    served[boardPath] = live;

    /* ---------------------------------------------------------- refresh
       "Refresh prices" asks props_cron for a real capture, says so, cannot be
       spammed, follows the request, and loads the new board past the CDN */
    console.log('refresh');
    const calls = [];
    let statusN = 0;
    const later = JSON.stringify(Object.assign({}, FX.board, { generated_at: new Date(NOW + 60000).toISOString(), capture: Object.assign({}, FX.board.capture, { last_attempt: new Date(NOW + 30000).toISOString(), last_success_at: new Date(NOW + 30000).toISOString() }) }));
    propsCron = (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body.action);
      if (body.action === 'refresh') return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, request_id: '33333333-3333-3333-3333-333333333333', status: 'dispatched', message: 'Refreshing prices…' }) });
      statusN++;
      if (statusN >= 2) served[boardPath] = later;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, request: statusN < 2 ? { status: 'running' } : { status: 'completed', reason: 'fresh prices captured', result: { leagues: { nfl: { quotes: 2641 } } } } }) });
    };
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl'));
    await page.waitForSelector('.pp-row', { timeout: 15000 });
    await page.evaluate(() => { EDPropsUI.state.pollMs = 150; });
    seenUrls.length = 0;
    await page.click('button[data-pp-act="refresh"]');
    const busy = await page.evaluate(() => { const b = document.querySelector('button[data-pp-act="refresh"]'); return { disabled: b.disabled, text: b.textContent, note: (document.querySelector('.pp-refresh') || {}).textContent || '' }; });
    chk('Refresh asks for a real capture and says "Refreshing prices…", its button disabled', busy.disabled && /Refreshing prices/.test(busy.text) && /Refreshing prices/.test(busy.note), busy);
    await page.evaluate(() => EDPropsUI._requestRefresh('nfl'));
    chk('a second press while one is in flight sends nothing (no refresh spam)', calls.filter((c) => c === 'refresh').length === 1, calls);
    await page.waitForFunction(() => { const n = document.querySelector('.pp-refresh.ok'); return n && /Fresh prices captured \(2,641 quotes\)/.test(n.textContent); }, null, { timeout: 15000 });
    chk('it follows the request to completion and reports what was captured', calls.filter((c) => c === 'status').length >= 2);
    chk('…and reloads the board past the CDN cache (a cache-busting query)', seenUrls.some((u) => /\/football\/props\/nfl\/board\.json\?t=\d+/.test(u)), seenUrls.filter((u) => /board/.test(u)));
    chk('…and the button is usable again', await page.evaluate(() => !document.querySelector('button[data-pp-act="refresh"]').disabled));
    served[boardPath] = live;
    await ctx.close();
    propsCron = (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'rate_limited', retry_after_s: 240, message: 'Prices were refreshed moments ago. Try again in 4 min.' }) });
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl'));
    await page.waitForSelector('.pp-row', { timeout: 15000 });
    await page.click('button[data-pp-act="refresh"]');
    await page.waitForSelector('.pp-refresh.info');
    chk('refused by the cool-down: it says exactly how long to wait', await page.evaluate(() => /Try again in 4 min/.test(document.querySelector('.pp-refresh').textContent)));
    await ctx.close();
    propsCron = (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'sign_in_required', message: 'Sign in to ask for a fresh price capture. The page has reloaded the latest published prices.' }) });
    ({ ctx, page, errors } = await open({ width: 1440, height: 900 }, '#playerprops/nfl'));
    await page.waitForSelector('.pp-row', { timeout: 15000 });
    await page.click('button[data-pp-act="refresh"]');
    await page.waitForSelector('.pp-refresh.info');
    chk('signed out: it says to sign in, and that the latest published prices are shown', await page.evaluate(() => /Sign in/.test(document.querySelector('.pp-refresh').textContent)));
    chk('no page errors in the refresh flow', errors.length === 0, errors);
    await ctx.close();
    propsCron = null;

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

    /* a phone two hours on: stale cards keep their line and last prices (never
       an EV or a decision) and keep the last capture's order, not A-to-Z QBs */
    console.log('phone, stale');
    ({ ctx, page, errors } = await open({ width: 390, height: 844 }, '#playerprops', NOW + 2 * 3600e3));
    await page.waitForSelector('.pp-card', { timeout: 15000 });
    await page.waitForFunction(() => EDPropsUI.state.reprice.nfl === 'done', null, { timeout: 20000 });
    const sc = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.pp-card')).slice(0, 8);
      const v = EDPropsUI._visible().slice(0, 8);
      return { txt: cards.map((c) => c.textContent.replace(/\s+/g, ' ')), dec: v.map((r) => r.decision), line: v.map((r) => r.refLine), cap: v.map((r) => r.capValue),
        note: (document.querySelector('.pp-cnote') || {}).textContent || '', tile: getComputedStyle(document.querySelector('.pp-card .g > span')).backgroundColor };
    });
    chk('stale phone cards are not decided', sc.dec.length > 0 && sc.dec.every((d) => d === 'NO_DECISION'), sc.dec);
    chk('…yet show the last line and each side\'s last price, labelled as the LAST ones, waiting for a price', sc.txt.every((t) => /WAIT FOR PRICE/.test(t) && /Last line\s*\d/.test(t) && /Last (Over|Under|Yes|No)\s*[+−-]?\d/.test(t) && !/STALE PRICE/.test(t)), sc.txt.filter((t) => !/Last (Over|Under|Yes|No)\s*[+−-]?\d/.test(t)));
    chk('…and the list says once, calmly, that no EV or decision comes until a current price (not a footer on every card)', /Between price checks/.test(sc.note) && /No EV or decision until a current price/.test(sc.note) && sc.txt.every((t) => !/no EV or decision until a current price/.test(t)), [sc.note, sc.txt[0]]);
    chk('…never an EV figure', sc.txt.every((t) => !/EV\s*[+−-]\d/.test(t)), sc.txt.slice(0, 2));
    chk('…listed in the last capture\'s order, and the list says so', sc.cap.every((x, i) => i === 0 || sc.cap[i - 1] >= x) && sc.cap[0] > 0 && /ranked and priced as of the last check \(2\.\d h ago/.test(sc.note), [sc.cap, sc.note]);
    chk('the card tiles are styled (the tile rule matches the card\'s spans)', sc.tile && sc.tile !== 'rgba(0, 0, 0, 0)', sc.tile);
    chk('a collapsed games pane on a phone is one button', await page.evaluate(() => !document.getElementById('ppGSearch') && document.querySelectorAll('.pp-side .pp-chip').length === 1));
    chk('no horizontal scroll on a stale phone board', await noHScroll(page));
    await shot(page, 'phone_cards_stale');
    chk('no page errors on the stale phone board', errors.length === 0, errors);
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
    await page.evaluate((g) => { const d = document.createElement('div'); d.id = 'gcTest'; d.innerHTML = fbPropsSecHTML('nfl', g); document.body.prepend(d); }, gid);
    await page.waitForSelector('#gcTest .pp-gsec .pp-gfoot', { timeout: 15000 });
    const lazy = await page.evaluate(() => ({ open: document.querySelector('#gcTest details').open, t: document.querySelector('#gcTest').textContent }));
    chk('the card section is open on the summary alone: PLAYER PROP RESEARCH says the state, the board is not read until asked', lazy.open && /PLAYER PROP RESEARCH/.test(lazy.t) && /Load player props/.test(lazy.t) && await page.evaluate(() => !EDPropsUI.state.boards.nfl), lazy);
    await page.click('#gcTest button:has-text("Load player props")');
    await page.waitForFunction(() => /props projected/.test((document.querySelector('#gcTest .pp-gsec') || {}).textContent || ''), null, { timeout: 15000 });
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
