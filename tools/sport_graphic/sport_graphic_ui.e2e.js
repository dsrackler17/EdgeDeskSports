#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The matchup graphic for every other sport in a real Chromium, where a
   reader clicks a game (lib/edgedesk_sport_graphic.js):

     Today's Games   the NCAAW and WNBA pills; the matchup view of a men's,
                     a women's and a WNBA game draws its graphic from the lab
                     slate, with Square / Portrait, Download PNG, Share and
                     Copy link; a game the slate has not priced says so; a
                     UFC card's view has a chip per bout, the main event
                     first, and keeps the keyboard on the chip chosen; the
                     public /today/ page draws none
     UFC panel       the next card's fight graphics
     baseball        the MLB brief and the college baseball brief open with
                     the graphic
     everywhere      no page error, no horizontal scroll at 390 px

   The slate is the REAL builder's over constructed ESPN payloads
   (tools/slate/fixtures/slate_fixture.js, clock 2026-10-13 5:30 PM CDT) with
   a women's game, a WNBA game and a UFC card added; the lab slate and the UFC
   model file are staged to match.

   Run: node tools/sport_graphic/sport_graphic_ui.e2e.js [--shots DIR]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const F = require('../slate/fixtures/slate_fixture.js');
const E = require('../slate/fixtures/espn_shapes.js');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'matchup graphic UI, every other sport — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const NOW = F.NOW;
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---- the staged games: a women's game and a WNBA game tonight, a UFC card */
const T = Object.assign({}, F.T, {
  CONN: E.team('CONN', 'UConn Huskies', 'Huskies', 41), SC: E.team('SC', 'South Carolina Gamecocks', 'Gamecocks', 2579),
  ATL: E.team('ATL', 'Atlanta Dream', 'Dream', 20), GSV: E.team('GS', 'Golden State Valkyries', 'Valkyries', 129689)
});
function table() {
  const t = F.table();
  t['basketball/womens-college-basketball|20261013'] = E.board([E.event({ id: 401930001, date: '2026-10-14T00:00Z', home: T.SC, away: T.CONN, venue: 'Colonial Life Arena', city: 'Columbia', state: 'SC', status: E.status('pre') })]);
  t['basketball/wnba|20261013'] = E.board([E.event({ id: 401940001, date: '2026-10-14T02:00Z', home: T.GSV, away: T.ATL, venue: 'Chase Center', city: 'San Francisco', state: 'CA', status: E.status('pre') })]);
  t['mma/ufc|20261013'] = E.board([E.card({ id: 600099001, date: '2026-10-14T00:00Z', name: 'UFC Fight Night: Moicano vs. Nolan', shortName: 'Moicano vs Nolan', status: E.status('pre'),
    bouts: [{ a: 'Tainara Lisboa', b: 'Lucia Szabova', cls: 'W Flyweight' }, { a: 'Renato Moicano', b: 'Tom Nolan', cls: 'Lightweight', arec: '21-7-1', brec: '11-1-0' }] })]);
  return t;
}
/* the lab slate: the committed WNBA game's prices, under each staged game's ids */
const BB = JSON.parse(fs.readFileSync(path.join(ROOT, 'basketball', 'slate.json'), 'utf8'));
const PROTO = Object.keys(BB.leagues).map((k) => (BB.leagues[k].games || [])[0]).filter(Boolean)[0];
function lab(id, start, home, away, neutral) {
  const g = clone(PROTO);
  return Object.assign(g, { event_key: 'X|' + id, game_id: String(id), start_utc: start, neutral: !!neutral, home: home.displayName, away: away.displayName, home_id: String(home.id), away_id: String(away.id) });
}
const LAB = { schema: 'edgedesk_lab_slate_v1', sport: 'basketball', generated_at: new Date(NOW - 3600e3).toISOString(), horizon_hours: 72, leagues: {
  nba: Object.assign({}, BB.leagues.nba, { games: [] }),
  ncaam: Object.assign({}, BB.leagues.ncaam, { early_season: true, games: [lab(401910002, '2026-10-14T23:00:00Z', T.BAY, T.GONZ)] }),
  ncaaw: Object.assign({}, BB.leagues.ncaaw, { games: [lab(401930001, '2026-10-14T00:00:00Z', T.SC, T.CONN)] }),
  wnba: Object.assign({}, BB.leagues.wnba, { games: [lab(401940001, '2026-10-14T02:00:00Z', T.GSV, T.ATL)] }) } };
/* the served UFC model for the staged card: fighter ids as the scoreboard gives them */
const UFC0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'model_loop', 'published', 'ufc', 'current.json'), 'utf8'));
function bout(id, a, b, cls, pA, mk) {
  const x = clone(UFC0.bouts[0]);
  return Object.assign(x, { bout_id: String(id), event_id: '600099001', event: 'UFC Fight Night: Moicano vs. Nolan', start: '2026-10-14T00:00Z', weight_class: cls,
    fighter_a: Object.assign(x.fighter_a, { id: a + 'id', name: a }), fighter_b: Object.assign(x.fighter_b, { id: b + 'id', name: b }), p_a: pA, p_b: 1 - pA,
    market: mk ? Object.assign({}, x.market || {}, { p_a: mk, p_b: 1 - mk, price_a: 150, price_b: -180, book: 'DraftKings', observed_at: new Date(NOW - 7200e3).toISOString() }) : null,
    guard: { status: mk && Math.abs(pA - mk) > 0.08 ? 'DISAGREES' : 'AGREES', label: mk && Math.abs(pA - mk) > 0.08 ? 'Model disagrees with market' : 'Model and market agree within the threshold', threshold_pp: 8, gap_pp: mk ? Math.round((pA - mk) * 1000) / 10 : null, signal_allowed: false, factors: [] } });
}
const UFC = Object.assign(clone(UFC0), { generated_at: new Date(NOW - 3600e3).toISOString(),
  bouts: [bout(1, 'Tainara Lisboa', 'Lucia Szabova', 'W Flyweight', 0.21, 0.19), bout(2, 'Renato Moicano', 'Tom Nolan', 'Lightweight', 0.37, 0.46)] });

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const research = Object.assign(F.research(), { basketball: LAB, ufc: UFC });
  const built = await F.buildFixture({ now: NOW - 10 * 60000, table: table(), research });
  const SLATE = built.snap;
  chk('the builder lists the staged women’s, WNBA and UFC games', ['ncaaw:espn:401930001', 'wnba:espn:401940001', 'mma:espn:600099001'].every((id) => SLATE.events.some((e) => e.id === id)), SLATE.events.map((e) => e.id));
  chk('…and joins the women’s and WNBA games to the lab model', ['ncaaw:espn:401930001', 'wnba:espn:401940001'].every((id) => { const e = SLATE.events.find((x) => x.id === id); return e && e.research && e.research.model && e.research.model.fair.spread_home != null; }));

  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/today/') p = '/today/index.html';
    const staged = { '/today/slate.json': SLATE, '/basketball/slate.json': LAB, '/model_loop/published/ufc/current.json': UFC }[p];
    if (staged) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(staged)); return; }
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  }
  const srv = await new Promise((resolve) => { const s = http.createServer(siteHandler); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  /* o.loadOrder: also record, from the browser itself, the renderer and the
     module as they load: each script's response (URL, status) and the order
     their globals are defined in */
  async function open(viewport, url, o) {
    const ctx = await browser.newContext({ viewport, timezoneId: 'America/Chicago', locale: 'en-US', acceptDownloads: true });
    if (o && o.loadOrder) {
      await ctx.addInitScript(() => {
        window.__sgDefined = [];
        ['EDGameGraphic', 'EDSportGraphic'].forEach((k) => {
          let v;
          Object.defineProperty(window, k, { configurable: true, enumerable: true, get() { return v; }, set(x) { if (v === undefined) window.__sgDefined.push(k); v = x; } });
        });
      });
    }
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ done: true }));
        localStorage.setItem('edgedesk_setup_v1', JSON.stringify({ done: true, at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
      } catch (e) { /* storage */ }
    });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/supabase\.co/.test(u) && /subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
      if (/supabase\.co/.test(u)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [], scripts = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    if (o && o.loadOrder) page.on('response', (r) => { if (/\/lib\/edgedesk_(game|sport)_graphic\.js/.test(r.url())) scripts.push({ url: r.url().slice(base.length), status: r.status() }); });
    await page.clock.install({ time: NOW });
    await page.goto(base + url, { waitUntil: 'load' });
    return { ctx, page, errors, scripts };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
  const drawn = (page, sel) => page.waitForSelector(sel + ' img[data-sg-img]:not([hidden])', { timeout: 20000 }).then(() => true, () => false);
  const alt = (page, sel) => page.$eval(sel + ' img[data-sg-img]', (i) => i.alt).catch(() => '');
  async function detail(page, id) {
    const b = await page.waitForSelector('#gamesPage [data-gm-detail="' + id + '"]', { timeout: 15000 }).catch(() => null);
    if (!b) return false;
    await b.click();
    return !!(await page.waitForSelector('#gmDetail:not([hidden])', { timeout: 5000 }).catch(() => null));
  }
  const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 900 };

  try {
    /* ── TODAY'S GAMES: the pills and a men's game (tomorrow) ─────────── */
    {
      const { ctx, page, errors, scripts } = await open(DESK, '/app.html#games/ncaam/2026-10-14', { loadOrder: true });
      /* THE SCRIPT CONTRACT, as the browser loads app.html: the module fills the renderer's layout
         (EDGameGraphic.layout's shape), so it is fetched under the renderer's own version — a cached
         module never meets a newer renderer, or the reverse — and runs after it */
      const ver = (re) => { const s = scripts.find((x) => re.test(x.url)); return s ? (/[?&]v=([^&]+)/.exec(s.url) || [])[1] || null : null; };
      const vGame = ver(/edgedesk_game_graphic\.js/), vSport = ver(/edgedesk_sport_graphic\.js/);
      chk('the browser fetches the renderer and the module, once each, both found', scripts.length === 2 && scripts.every((s) => s.status === 200), scripts);
      chk('…under one version stamp', !!vGame && vGame === vSport, scripts);
      chk('…and the renderer is defined before the module', JSON.stringify(await page.evaluate(() => window.__sgDefined)) === '["EDGameGraphic","EDSportGraphic"]', await page.evaluate(() => window.__sgDefined));
      chk('…and the module finds that renderer', await page.evaluate(() => !!window.EDSportGraphic && !!window.EDGameGraphic && typeof window.EDGameGraphic.layout === 'function'));
      chk('the NCAAW and WNBA pills are on the games page',!!(await page.waitForSelector('#gamesPage [data-gm-sport="ncaaw"]', { timeout: 15000 }).catch(() => null)) && !!(await page.$('#gamesPage [data-gm-sport="wnba"]')));
      chk('the men’s game opens its matchup view', await detail(page, 'ncaam:espn:401910002'));
      chk('…which draws the graphic', await drawn(page, '#gmGfx'));
      const a = await alt(page, '#gmGfx');
      chk('…from the lab slate: the two teams, the fair spread and total', /Gonzaga Bulldogs at Baylor Bears/.test(a) && /fair spread/.test(a) && /fair total/.test(a), a.slice(0, 300));
      chk('…set against the captured DraftKings price', /DraftKings/.test(a) && /Spread: EdgeDesk|Total: EdgeDesk|Win %/.test(a), a.slice(0, 500));
      chk('…and research, not picks', /Research, not picks\.$/.test(a));
      const btns = await page.$$eval('#gmGfx button', (b) => b.map((x) => x.textContent));
      chk('Square, Portrait, Download PNG, Share and Copy link', ['Square 1080×1080', 'Portrait 1080×1350', 'Download PNG', 'Share', 'Copy link'].every((t) => btns.indexOf(t) >= 0), btns);
      const sq = await page.$eval('#gmGfx img[data-sg-img]', (i) => i.src);
      await page.click('#gmGfx [data-sg-act="fmt"][data-v="portrait"]');
      chk('Portrait redraws at 1080×1350', await drawn(page, '#gmGfx') && await page.$eval('#gmGfx .gv-fig', (f) => f.style.aspectRatio.replace(/\s/g, '')) === '1080/1350'
        && await page.$eval('#gmGfx img[data-sg-img]', (i) => i.naturalWidth === 1080 && i.naturalHeight === 1350), await page.$eval('#gmGfx img[data-sg-img]', (i) => [i.naturalWidth, i.naturalHeight]).catch(() => null));
      chk('…a new picture, not the square one', (await page.$eval('#gmGfx img[data-sg-img]', (i) => i.src)) !== sq);
      const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
      await page.click('#gmGfx [data-sg-act="dl"]');
      const d = await dl;
      chk('Download PNG saves the picture with its league and teams in the name', d && /^edgedesk-ncaam-gonzaga-bulldogs-at-baylor-bears-portrait\.png$/.test(d.suggestedFilename()), d && d.suggestedFilename());
      await page.click('#gmGfx [data-sg-act="fmt"][data-v="square"]');
      await drawn(page, '#gmGfx');
      chk('the keyboard stays on the format pressed', await page.evaluate(() => { const a = document.activeElement; return !!(a && a.getAttribute('data-sg-act') === 'fmt' && a.getAttribute('data-v') === 'square'); }));
      await shot(page, 'ncaam_matchup');
      await page.keyboard.press('Escape');
      chk('…so Escape still closes the view', await page.$eval('#gmDetail', (d) => d.hidden));
      /* a live men's game the lab slate holds nothing for */
      await page.goto(base + '/app.html#games/ncaam/2026-10-13', { waitUntil: 'load' });
      chk('a men’s game the slate has not priced opens its view', await detail(page, 'ncaam:espn:401910003'));
      await page.waitForFunction(() => { const g = document.querySelector('#gmGfx'); return g && /not priced this game yet/.test(g.textContent); }, null, { timeout: 15000 }).catch(() => null);
      chk('…and says the graphic waits for the price, drawing nothing', /not priced this game yet/.test(await page.$eval('#gmGfx', (g) => g.textContent)) && !(await page.$('#gmGfx img[data-sg-img]:not([hidden])')));
      chk('no page error (men’s college basketball)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── WOMEN'S COLLEGE BASKETBALL AND THE WNBA ───────────────────────── */
    for (const [sp, id, re] of [['ncaaw', 'ncaaw:espn:401930001', /Uconn Huskies at South Carolina Gamecocks/], ['wnba', 'wnba:espn:401940001', /Atlanta Dream at Golden State Valkyries/]]) {
      const { ctx, page, errors } = await open(DESK, '/app.html#games/' + sp + '/2026-10-13');
      chk(sp + ': the game opens its matchup view', await detail(page, id));
      chk(sp + ': the graphic draws', await drawn(page, '#gmGfx'));
      chk(sp + ': for this game', re.test(await alt(page, '#gmGfx')), (await alt(page, '#gmGfx')).slice(0, 200));
      chk(sp + ': the research line points at the graphic', /The graphic above is its model’s read/.test(await page.$eval('#gmDetail', (d) => d.textContent)));
      await shot(page, sp + '_matchup');
      chk('no page error (' + sp + ')', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── A UFC CARD ───────────────────────────────────────────────────── */
    {
      const { ctx, page, errors } = await open(DESK, '/app.html#games/mma/2026-10-13');
      chk('the UFC card opens its matchup view', await detail(page, 'mma:espn:600099001'));
      chk('…which draws the main event', await drawn(page, '#gmGfx') && /Renato Moicano vs Tom Nolan/.test(await alt(page, '#gmGfx')), (await alt(page, '#gmGfx')).slice(0, 120));
      const chips = await page.$$eval('#gmGfx .sg-chip', (c) => c.map((x) => ({ t: x.textContent, on: x.getAttribute('aria-pressed') === 'true' })));
      chk('…a chip per bout, the main event first and chosen', chips.length === 2 && /^Main Moicano v Nolan$/.test(chips[0].t) && chips[0].on && !chips[1].on, chips);
      await page.focus('#gmGfx .sg-chip:nth-child(2)');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => /Tainara Lisboa vs Lucia Szabova/.test((document.querySelector('#gmGfx img[data-sg-img]') || {}).alt || ''), null, { timeout: 15000 }).catch(() => null);
      chk('another chip draws that bout', /Tainara Lisboa vs Lucia Szabova/.test(await alt(page, '#gmGfx')));
      chk('…and the keyboard stays on the chip chosen', await page.evaluate(() => { const a = document.activeElement; return !!(a && a.getAttribute('data-sg-bout') === '1' && a.getAttribute('aria-pressed') === 'true'); }));
      await page.keyboard.press('Escape');
      chk('Escape still closes the view', await page.$eval('#gmDetail', (d) => d.hidden));
      chk('no page error (UFC card)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── A PHONE: no horizontal scroll with the graphic open ─────────── */
    {
      const { ctx, page, errors } = await open(PHONE, '/app.html#games/ncaaw/2026-10-13');
      chk('390 px: the women’s game opens', await detail(page, 'ncaaw:espn:401930001'));
      chk('390 px: the graphic draws', await drawn(page, '#gmGfx'));
      chk('390 px: no horizontal scroll', await page.evaluate(() => { const d = document.getElementById('gmDetail'); return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && d.scrollWidth <= d.clientWidth + 1; }));
      chk('390 px: the graphic fits the view', await page.$eval('#gmGfx .gv-fig', (f) => f.getBoundingClientRect().right <= window.innerWidth + 1));
      await shot(page, 'ncaaw_phone');
      chk('no page error (phone)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── THE PUBLIC /today/ PAGE: no model, so no graphic ─────────────── */
    {
      const { ctx, page, errors } = await open(DESK, '/today/#games/ncaaw/2026-10-13');
      const b = await page.waitForSelector('[data-gm-detail="ncaaw:espn:401930001"]', { timeout: 15000 }).catch(() => null);
      if (b) { await b.click(); await page.waitForSelector('#gmDetail:not([hidden])', { timeout: 5000 }).catch(() => null); }
      chk('the public page lists the women’s game and opens it', !!b);
      chk('…without a graphic (the model is the terminal’s)', !(await page.$('#gmGfx')));
      chk('no page error (public)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── THE UFC PANEL ───────────────────────────────────────────────── */
    {
      const { ctx, page, errors } = await open(DESK, '/app.html#research/ufc');
      await page.waitForFunction(() => { const w = document.getElementById('ufcCardWrap'); return w && !w.hidden; }, null, { timeout: 20000 }).catch(() => null);
      chk('the UFC panel shows the next card', await page.$eval('#ufcCardWrap', (w) => !w.hidden).catch(() => false));
      chk('…a chip per bout and the main event drawn', (await page.$$('#ufcCardGfx .sg-chip')).length === 2 && await drawn(page, '#ufcCardGfx') && /Renato Moicano vs Tom Nolan/.test(await alt(page, '#ufcCardGfx')));
      chk('no page error (UFC panel)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
    /* ── THE BASEBALL BRIEFS ─────────────────────────────────────────── */
    {
      const { ctx, page, errors } = await open(DESK, '/app.html#research/baseball');
      await page.waitForFunction(() => typeof window.mlbbOpenBrief === 'function' && typeof window.cbbOpenBrief === 'function' && !!window.EDBRIEF, null, { timeout: 20000 }).catch(() => null);
      const KEY = '2026-10-13|newyorkyankees|bostonredsox|2';
      await page.evaluate((key) => {
        MLBB.cards = [{ __key: key, __game_id: null, game_date: '2026-10-13', start_time: '2026-10-13T23:10:00Z', venue: 'Fenway Park', home_team_name: 'Boston Red Sox', away_team_name: 'New York Yankees', home_record: '81-81', away_record: '94-68',
          home_pitcher_name: 'Garrett Crochet', home_pitcher_throws: 'L', away_pitcher_name: 'Max Fried', away_pitcher_throws: 'L', doubleheader: 'Y', game_number: 2, run_factor: 104, temp_f: 58, wind_mph: 12, wind_rel: 'In from LF' }];
        MLBB.byGame = {}; MLBB.byGame[key] = MLBB.cards[0]; MLBB.at = Date.now(); MLBB.season = 2026;
        MLBB.teamSeason = MLBB.teamSeason || {}; MLBB.pitchers = MLBB.pitchers || {}; MLBB.offense = MLBB.offense || {}; MLBB.pitcherSeason = MLBB.pitcherSeason || {};
        window.mlbbOpenBrief(key);
      }, KEY);
      chk('the MLB brief opens with its graphic', await drawn(page, '#briefGfx'));
      const ma = await alt(page, '#briefGfx');
      chk('…for this game, with the engine’s fair moneyline and runs', /New York Yankees at Boston Red Sox/.test(ma) && /fair moneyline/.test(ma) && /projected total \d+\.\d\d/.test(ma), ma.slice(0, 300));
      chk('…and the probable starters to check', /Probable, not confirmed/.test(ma) && /Fried/.test(ma) && /Crochet/.test(ma));
      chk('…inside the brief, above its research', await page.evaluate(() => { const g = document.getElementById('briefGfx'), card = g && g.closest('.brief-card'); return !!card && !!(g.compareDocumentPosition(card.querySelector('.brief') || card.lastElementChild) & Node.DOCUMENT_POSITION_FOLLOWING); }));
      await shot(page, 'mlb_brief');
      await page.evaluate(() => window.EDBRIEF.close());
      /* college baseball: a game on the board, projected, never priced */
      await page.evaluate(() => {
        CBB.board = { games: [{ game_id: 9001, season: 2027, date: '2026-10-14', start_time: '2026-10-14T18:00:00Z', neutral_site: false, venue: 'Hawkins Field', home: { name: 'Vanderbilt', team_id: 1 }, away: { name: 'Middle Tennessee', team_id: 2 } }] };
        CBB.seasonTable = { ok: true, league: { runs_per_game: 6.5 }, by_id: { 1: { runs_per_game: 7.4, runs_allowed_per_game: 4.6, games: 40, conference_name: 'SEC' }, 2: { runs_per_game: 6.0, runs_allowed_per_game: 6.6, games: 38 } }, conferences: { SEC: { name: 'SEC', sufficient: true, runs_per_nonconf_game: 2.1, nonconference_games: 180 } } };
        CBB.at = Date.now(); CBB.projRows = null;
        window.cbbOpenBrief('9001');
      });
      chk('the college baseball brief opens with its graphic', await drawn(page, '#cbbGfx'));
      const ca = await alt(page, '#cbbGfx');
      chk('…projected, never priced: margin and total, no moneyline', /Middle Tennessee at Vanderbilt/.test(ca) && /projected margin/.test(ca) && !/moneyline/i.test(ca), ca.slice(0, 300));
      chk('…and it draws while the rest of the brief is read', !!(await page.$('#cbbBriefBody')));
      await shot(page, 'cbb_brief');
      chk('no page error (baseball)', errors.length === 0, errors.slice(0, 3));
      await ctx.close();
    }
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 600));
  }
  await browser.close();
  srv.close();
  done();
})();
