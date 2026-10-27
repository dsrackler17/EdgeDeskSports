#!/usr/bin/env node
/* ===========================================================================
   SHARP LAG (Experimental) IN A REAL BROWSER — every surface in Chromium at
   a 390 px phone and a 1280 px desktop, with public.sharp_lag_flags() and
   public.sharp_lag_progress() stubbed (no database, no provider):
     matchup   the terminal's games page (the slate fixture, the clock pinned
               like tools/slate/games_ui.e2e.js): the matchup view fills its
               Sharp-lag section with that game's flags only; "not deployed"
               is said plainly; /today/ (public) has no section and asks for
               nothing
     game      the game research page (the committed snapshots): the section
               after Market comparison; a reader without access before the
               start sees the note, never a price
     signals   the Signals view: today's flags, each tagged Experimental, with
               the threshold and the progress; the public note when empty
     record    the Performance page: public display OFF (counts and progress
               only), ON (the record and the no-close line)
     nba       the NBA game page (#research/nba/<game>): "Who absorbs the
               minutes" switched on by OUT on the game's current report (the
               build's scenario, nba/role_shift.json), not by QUESTIONABLE;
               the game's role-shift flag with both models' progress
   No page error and no horizontal page scroll anywhere.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one,
   except under SHARP_LAG_E2E_REQUIRED=1 (CI), where a missing browser fails.
   Run:  node tools/sharp_lag/sharp_lag_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const F = require(path.join(ROOT, 'tools', 'slate', 'fixtures', 'slate_fixture.js'));
const NAV = require(path.join(ROOT, 'tools', 'app', 'nav_helper.js'));
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.csv': 'text/csv' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'sharp lag UI (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* a flag as public.sharp_lag_flags() returns it (sharp_lag_rows + access) */
function flagRow(o) {
  const t = Date.parse(o.flagged_at);
  return Object.assign({ flag_id: 1, model_key: 'SHARP-LAG', model_version: '0.1', trigger_type: 'scheduled', market: 'h2h', participant: null, point: null,
    target_venue: 'draftkings', target_price: 2.3, target_price_american: 130, target_cost_prob: 0.4348, fee_per_contract: null, fee_unverified: false,
    target_observed_at: new Date(t - 5 * 60000).toISOString(), reference_kind: 'pinnacle_shin', reference_prob: 0.465, reference_observed_at: new Date(t - 10 * 60000).toISOString(),
    gap_pp: 3.02, threshold_pp: 2.5, snapshot_resolution_s: 3600, close_status: null, clv_pp: null, access: 'subscriber' }, o);
}
/* what the stubs answer, per scenario */
const M = { flags: [], progress: null, deployed: true, access: 'subscriber', publicDisplay: 'off', roleFile: null, injCard: null };
function progressBody() {
  return Object.assign({ threshold: 200, public_display: M.publicDisplay, access: M.access, as_of: new Date().toISOString(),
    models: [{ model_key: 'SHARP-LAG', flags: 7, graded: 3, no_close: 1, pending: 3, registered: true }, { model_key: 'NBA-ROLE-SHIFT', flags: 0, graded: 0, no_close: 0, pending: 0, registered: true }] }, M.progress || {});
}
/* the database's own rule (supabase/sharp_lag.sql sharp_lag_flags): a subscriber sees every flag in
   the window; anyone else only started games, and only with public display on */
function flagsBody(post, now) {
  let b = {}; try { b = JSON.parse(post || '{}'); } catch (_) { /* none */ }
  const from = b.p_from ? Date.parse(b.p_from) : -Infinity, to = b.p_to ? Date.parse(b.p_to) : Infinity;
  if (M.access !== 'subscriber' && M.publicDisplay !== 'on') return [];
  return M.flags.filter((f) => (!b.p_sport || f.sport_key === b.p_sport) && Date.parse(f.commence_time) >= from && Date.parse(f.commence_time) <= to
    && (M.access === 'subscriber' || Date.parse(f.commence_time) <= now)).map((f) => Object.assign({}, f, { access: M.access === 'subscriber' ? 'subscriber' : 'public' }));
}

(async function main() {
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  const REQUIRED = process.env.SHARP_LAG_E2E_REQUIRED === '1';
  if (!pw) { console.log((REQUIRED ? 'FAILED: SHARP_LAG_E2E_REQUIRED is set and ' : 'SKIPPED: ') + 'playwright is not installed here'); process.exit(REQUIRED ? 1 : 0); }
  const built = await F.buildFixture({ now: F.NOW - 10 * 60000 });
  const SLATE = built.snap;
  const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'game_research', 'current.json'), 'utf8'));
  const CFB = CUR.games.filter((g) => g.league === 'cfb' && g.model.available && !g.started && Date.parse(g.kickoff) > Date.now() + 3600e3)[0] || null;

  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/today/') p = '/today/index.html';
    if (p === '/performance/') p = '/performance/index.html';
    if (p === '/today/slate.json') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(SLATE)); return; }
    if (p === '/nba/role_shift.json' && M.roleFile) { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(M.roleFile)); return; }
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
    else { console.log((REQUIRED ? 'FAILED: SHARP_LAG_E2E_REQUIRED is set and there is ' : 'SKIPPED: ') + 'no Chromium'); srv.close(); process.exit(REQUIRED ? 1 : 0); }
  }

  async function open(viewport, url, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, timezoneId: 'America/Chicago', locale: 'en-US' });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ done: true }));
        localStorage.setItem('edgedesk_setup_v1', JSON.stringify({ done: true, at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        if (!localStorage.getItem('edgedesk_prefs')) localStorage.setItem('edgedesk_prefs', JSON.stringify({ lastTab: 'research', rememberTab: true, lastResearchSub: 'football' }));
      } catch (e) { /* storage */ }
    });
    const seen = { flags: 0, progress: 0, auth: [] };
    const clock = o.time != null ? o.time : Date.now();
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/rpc\/sharp_lag_(flags|progress)/.test(u)) {
          const fl = /sharp_lag_flags/.test(u); if (fl) seen.flags++; else seen.progress++;
          seen.auth.push(route.request().headers().authorization || '');
          if (!M.deployed) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fl ? flagsBody(route.request().postData(), o.time != null ? o.time : Date.now()) : progressBody()) });
        }
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        if (/rpc\/nba_injury_card/.test(u) && M.injCard) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(M.injCard) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
    if (o.time != null) await page.clock.install({ time: clock });
    await page.goto(base + url, { waitUntil: 'load' });
    return { ctx, page, errors, seen };
  }
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 900 };

  try {
    /* ── MATCHUP: the terminal's games page, FLA @ CBJ ─────────────────── */
    const CBJ = SLATE.events.find((e) => e.id === 'nhl:espn:401802002'), VGK = SLATE.events.find((e) => e.id === 'nhl:espn:401802004');
    const fAt = new Date(F.NOW - 30 * 60000).toISOString();
    M.flags = [flagRow({ flag_id: 1, flagged_at: fAt, sport_key: 'icehockey_nhl', event_id: 'ev_cbj', home_team: 'Columbus Blue Jackets', away_team: 'Florida Panthers', commence_time: CBJ.start_utc, side: 'Columbus Blue Jackets' }),
      flagRow({ flag_id: 2, flagged_at: fAt, sport_key: 'icehockey_nhl', event_id: 'ev_vgk', home_team: 'Vegas Golden Knights', away_team: 'Seattle Kraken', commence_time: VGK.start_utc, side: 'Seattle Kraken', market: 'totals', point: 6.5, target_price_american: 105, target_price: 2.05 })];
    M.access = 'subscriber'; M.deployed = true;
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      const G = await open(vp, '/app.html#games/nhl/2026-10-13', { time: F.NOW });
      await G.page.waitForSelector('#gamesPage .gm-card[data-id="nhl:espn:401802002"] .gm-more', { timeout: 30000 });
      await G.page.click('#gamesPage .gm-card[data-id="nhl:espn:401802002"] .gm-more');
      await G.page.waitForSelector('#gmDetail:not([hidden])');
      await G.page.waitForFunction(() => /Pinnacle fair|could not be read|not deployed/.test((document.getElementById('gmSharp') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
      const s = await text(G.page, '#gmSharp');
      chk('matchup ' + label + ': the section is drawn in the dialog, tagged Experimental', /Sharp lag · Experimental/i.test(s) && /Experimental research/.test(s), s.slice(0, 300));
      chk('matchup ' + label + ': this game\'s flag: target, Pinnacle fair, gap, trigger and each price\'s age', /DraftKings \+130/.test(s) && /Pinnacle fair 46\.5%/.test(s) && /\+3\.0 pp/.test(s) && /Scheduled check/.test(s) && /seen 35 min ago/.test(s) && /seen 40 min ago/.test(s), s);
      chk('matchup ' + label + ': only this game\'s flags (not the Kraken total)', !/Seattle Kraken Over/.test(s) && (await G.page.$$eval('#gmSharp tbody tr', (r) => r.length)) === 1);
      chk('matchup ' + label + ': the registered threshold and the progress', /3 of 200 graded flags/.test(s) && /95% lower bound on mean CLV above zero, both/.test(s) && /Status: EXPERIMENTAL/.test(s), s.slice(-400));
      chk('matchup ' + label + ': the snapshot resolution beside the lag', /measured only to the snapshot cadence: 60 min/.test(s));
      chk('matchup ' + label + ': read under the reader\'s own token', G.seen.flags >= 1 && G.seen.auth.every((a) => a === 'Bearer e2e'), G.seen.auth);
      chk('matchup ' + label + ': no horizontal page scroll', await noHScroll(G.page));
      chk('matchup ' + label + ': the flag table fits its box, no sideways scroll inside it either', await G.page.$eval('#gmSharp .sl-tblwrap', (w) => w.scrollWidth <= w.clientWidth + 1).catch(() => false));
      chk('matchup ' + label + ': no page error', G.errors.length === 0, G.errors);
      await shot(G.page, 'matchup-' + label);
      await G.ctx.close();
    }
    M.deployed = false;
    const G2 = await open(DESK, '/app.html#games/nhl/2026-10-13', { time: F.NOW });
    await G2.page.waitForSelector('#gamesPage .gm-card[data-id="nhl:espn:401802002"] .gm-more', { timeout: 30000 });
    await G2.page.click('#gamesPage .gm-card[data-id="nhl:espn:401802002"] .gm-more');
    await G2.page.waitForFunction(() => /not deployed|could not be read/.test((document.getElementById('gmSharp') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
    chk('matchup: not deployed is said plainly, and the rest of the dialog stands', /not deployed yet/.test(await text(G2.page, '#gmSharp')) && /Market/i.test(await text(G2.page, '#gmDetail')) && G2.errors.length === 0, G2.errors);
    await G2.ctx.close();
    M.deployed = true;

    const P = await open(DESK, '/today/', { time: F.NOW });
    await P.page.waitForSelector('#gamesPage .gm-card[data-id]', { timeout: 30000 });
    const more = await P.page.$('#gamesPage .gm-card[data-id="nhl:espn:401802002"] .gm-more');
    if (more) { await more.click(); await P.page.waitForSelector('#gmDetail:not([hidden])').catch(() => {}); await P.page.waitForTimeout(400); }
    chk('/today/ (public): no Sharp-lag section, and no Sharp-lag read at all', !(await P.page.$('#gmSharp')) && !(await P.page.$('.sl-sec')) && P.seen.flags === 0 && P.seen.progress === 0, P.seen);
    chk('/today/: no page error', P.errors.length === 0, P.errors);
    await P.ctx.close();

    /* ── GAME: the research page, from the committed snapshots ─────────── */
    if (!CFB) console.log('  (no upcoming CFB snapshot in football/game_research/current.json: the game page is covered by tools/sharp_lag/sharp_lag_ui.test.js only)');
    else {
      const nowG = Date.now();
      M.flags = [flagRow({ flag_id: 11, flagged_at: new Date(nowG - 20 * 60000).toISOString(), sport_key: 'americanfootball_ncaaf', event_id: 'ev_cfb', home_team: CFB.home.name + ' Hilltoppers', away_team: CFB.away.name + ' Blue Hens',
        commence_time: CFB.kickoff, market: 'spreads', side: CFB.home.name + ' Hilltoppers', point: -3.5, target_price_american: -105, target_price: 1.952, target_cost_prob: 0.5122, reference_prob: 0.5401, gap_pp: 2.79 })];
      M.access = 'subscriber';
      for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
        const R = await open(vp, '/app.html#game/cfb/' + CFB.game_id);
        await R.page.waitForFunction(() => /Pinnacle fair|could not be read|not deployed/.test((document.getElementById('gvSharp') || {}).innerText || ''), null, { timeout: 45000 }).catch(() => {});
        const s = await text(R.page, '#gvSharp');
        const secs = await R.page.evaluate(() => Array.from(document.querySelectorAll('.gv > section')).map((x) => x.getAttribute('aria-label')));
        chk('game ' + label + ': the section follows Market comparison', secs.indexOf('Sharp lag, experimental') > secs.indexOf('Market comparison') && secs.indexOf('Market comparison') >= 0, secs);
        chk('game ' + label + ': the flag on its game though the feeds name the clubs differently (mascots)', /Spread/.test(s) && /DraftKings -105/.test(s) && /Pinnacle fair 54\.0%/.test(s) && /\+2\.8 pp/.test(s), s.slice(0, 600));
        chk('game ' + label + ': tagged Experimental, with the threshold and the progress', /Sharp lag · Experimental/i.test(s) && /3 of 200 graded flags/.test(s));
        chk('game ' + label + ': no horizontal page scroll', await noHScroll(R.page));
        chk('game ' + label + ': the flag table fits its box', await R.page.$eval('#gvSharp .sl-tblwrap', (w) => w.scrollWidth <= w.clientWidth + 1).catch(() => false));
        chk('game ' + label + ': no page error', R.errors.length === 0, R.errors);
        await shot(R.page, 'game-' + label);
        await R.ctx.close();
      }
      M.access = 'none';
      const R2 = await open(PHONE, '/app.html#game/cfb/' + CFB.game_id);
      await R2.page.waitForFunction(() => /until the game starts|could not be read/.test((document.getElementById('gvSharp') || {}).innerText || ''), null, { timeout: 45000 }).catch(() => {});
      const s2 = await text(R2.page, '#gvSharp');
      chk('game: a reader without access before the start gets the note and the progress, never a price', /until the game starts/.test(s2) && !/Pinnacle fair/.test(s2) && /graded flags/.test(s2) && !(await R2.page.$('#gvSharp table')), s2);
      await R2.ctx.close();
    }

    /* ── SIGNALS: today's flags ─────────────────────────────────────────── */
    const TS = Date.parse('2026-11-02T18:00:00Z');   /* 12:00 PM CST */
    M.flags = [flagRow({ flag_id: 21, flagged_at: new Date(TS - 40 * 60000).toISOString(), sport_key: 'icehockey_nhl', event_id: 'e1', home_team: 'Columbus Blue Jackets', away_team: 'Florida Panthers', commence_time: new Date(TS + 6 * 3600e3).toISOString(), side: 'Columbus Blue Jackets' }),
      flagRow({ flag_id: 22, flagged_at: new Date(TS - 10 * 60000).toISOString(), sport_key: 'americanfootball_nfl', event_id: 'e2', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: new Date(TS + 30 * 3600e3).toISOString(),
        side: 'Buffalo Bills', target_venue: 'kalshi', target_price: 0.41, target_price_american: null, fee_per_contract: 0.02, fee_unverified: true, target_cost_prob: 0.43, trigger_type: 'kalshi_move' }),
      flagRow({ flag_id: 23, flagged_at: new Date(TS - 20 * 3600e3).toISOString(), sport_key: 'icehockey_nhl', event_id: 'e3', home_team: 'Boston Bruins', away_team: 'Ottawa Senators', commence_time: new Date(TS + 3600e3).toISOString(), side: 'Ottawa Senators' })];
    M.access = 'subscriber';
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      const S = await open(vp, '/app.html', { time: TS });
      await S.page.waitForFunction(() => !!window.slData, null, { timeout: 30000 });
      await NAV.go(S.page, 'signals');
      await S.page.waitForFunction(() => /today’s flags/.test((document.getElementById('slFeed') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
      const s = await text(S.page, '#slFeed');
      const items = await S.page.$$eval('#slFeed .sl-feed li', (li) => li.map((x) => x.innerText));
      chk('signals ' + label + ': today\'s flags only (not yesterday evening\'s), newest first', items.length === 2 && /Bills/.test(items[0]) && /Blue Jackets/.test(items[1]) && !/Senators/.test(s), items);
      chk('signals ' + label + ': every item tagged Experimental, with its time, game, target, fair, gap and trigger', items.every((t) => /Experimental/.test(t) && /\d:\d\d [AP]M C[SD]T/.test(t) && /fair \d+\.\d%/.test(t) && /gap \+\d\.\d pp/.test(t)), items);
      chk('signals ' + label + ': a Kalshi flag says its fee is unverified', /Kalshi YES 41¢ \+ fee 2¢/.test(items[0] || '') && /fee unverified/.test(items[0] || ''), items[0]);
      chk('signals ' + label + ': the registered threshold and the progress', /3 of 200 graded flags/.test(s) && /Registered threshold: 200/.test(s));
      chk('signals ' + label + ': Signal Center still opens under the feed', !!(await S.page.$('#v-signals #scHost')) && await S.page.evaluate(() => !document.getElementById('v-signals').classList.contains('hide')));
      chk('signals ' + label + ': no horizontal page scroll', await noHScroll(S.page));
      chk('signals ' + label + ': no page error', S.errors.length === 0, S.errors);
      await shot(S.page, 'signals-' + label);
      await S.ctx.close();
    }
    M.access = 'none'; M.publicDisplay = 'off';
    const S2 = await open(PHONE, '/app.html', { time: TS });
    await S2.page.waitForFunction(() => !!window.slData, null, { timeout: 30000 });
    await NAV.go(S2.page, 'signals');
    await S2.page.waitForFunction(() => /today’s flags/.test((document.getElementById('slFeed') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
    const e2 = await text(S2.page, '#slFeed');
    chk('signals: a reader without access sees the note, the threshold and the progress, never a live flag', /Live flags are for subscribers/.test(e2) && /graded flags/.test(e2) && !(await S2.page.$('#slFeed .sl-feed li')), e2);
    await S2.ctx.close();

    /* ── RECORD: the Performance page ──────────────────────────────────── */
    const TP = Date.parse('2026-11-02T18:00:00Z');
    const g = (id, ev, minAgo, o) => flagRow(Object.assign({ flag_id: id, event_id: ev, flagged_at: new Date(TP - (minAgo + 120) * 60000).toISOString(), commence_time: new Date(TP - minAgo * 60000).toISOString(), sport_key: 'icehockey_nhl',
      home_team: 'Columbus Blue Jackets', away_team: 'Florida Panthers', side: 'Columbus Blue Jackets' }, o));
    M.flags = [g(31, 'a', 300, { close_status: 'graded', clv_pp: 1.2, converged: true, lag_to_converge_s: 1800 }), g(32, 'a', 300, { close_status: 'graded', clv_pp: -0.4, converged: false }),
      g(33, 'b', 200, { close_status: 'graded', clv_pp: 2.1, converged: true, lag_to_converge_s: 3600 }), g(34, 'c', 100, { close_status: 'no_close' }), g(35, 'd', -120, {})];
    M.access = 'none';
    for (const pub of ['off', 'on']) {
      M.publicDisplay = pub;
      for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
        const R = await open(vp, '/performance/', { time: TP });
        await R.page.waitForFunction(() => /graded flags|could not be read|not deployed/.test((document.getElementById('pf-sharplag') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
        const s = await text(R.page, '#pf-sharplag');
        if (pub === 'off') {
          chk('performance ' + label + ' (public display off): counts and progress only, no flag', /7 flags written, 1 without a usable close, 3 waiting/.test(s) && /3 of 200 graded flags/.test(s) && !(await R.page.$('#pf-sharplag table')) && !/Pinnacle fair/.test(s), s);
        } else {
          chk('performance ' + label + ' (public display on): the record of started games, counts from the database', !!(await R.page.$('#pf-sharplag table')) && /Avg CLV/.test(s) && /Hit rate/.test(s) && /Snapshot resolution/.test(s), s.slice(0, 400));
          chk('performance ' + label + ' (public display on): the no-close count and rate as data quality', /1 flag had no usable close \(25\.0% of closed flags\)/.test(s), (s.match(/Data quality:[^\n]*/) || [''])[0]);
        }
        chk('performance ' + label + ' (' + pub + '): read with the public key, tagged Experimental', R.seen.auth.length >= 2 && R.seen.auth.every((a) => /^Bearer eyJ/.test(a)) && /Experimental/.test(s), R.seen.auth.slice(0, 1));
        chk('performance ' + label + ' (' + pub + '): no horizontal page scroll', await noHScroll(R.page));
        chk('performance ' + label + ' (' + pub + '): no page error', R.errors.length === 0, R.errors);
        await shot(R.page, 'performance-' + pub + '-' + label);
        await R.ctx.close();
      }
    }
    /* ── NBA: the game page, a rotation player out ─────────────────────── */
    {
      const NS = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'slate.json'), 'utf8'));
      const TN = Date.parse(NS.generated_at) + 60000;
      const NG = NS.games.find((x) => Date.parse(x.start_utc) > TN + 3600e3);
      if (!NG) console.log('  (no upcoming NBA game on nba/slate.json: the NBA page is covered by tools/sharp_lag/role_shift.test.js only)');
      else {
        const RF = require(path.join(ROOT, 'tools', 'sharp_lag', 'fixtures', 'role_shift_fixture.js')).file({ now: new Date(TN - 30 * 60000).toISOString(), props_generated_at: new Date(TN - 31 * 60000).toISOString() });
        RF.games[0].game_id = String(NG.game_id);
        M.roleFile = RF;
        const card = (status) => ({ game_id: String(NG.game_id), state: 'AVAILABLE', reason: null, last_check_at: new Date(TN - 7 * 60000).toISOString(), last_check_status: 'ok', last_success_at: new Date(TN - 7 * 60000).toISOString(),
          report: { id: 7, source: 'nba_official', published_at: new Date(TN - 15 * 60000).toISOString(), captured_at: new Date(TN - 8 * 60000).toISOString() },
          statuses: [{ team_id: String(NG.home.id), team_abbr: NG.home.abbr, player_id: '1', player_name: 'Absent Star', status, source_status: status, reason: 'Injury/Illness', match_method: 'team_exact', row_id: 901 }],
          not_submitted: [], rosters: {}, adjusted: null });
        const fAt = new Date(TN - 20 * 60000).toISOString();
        M.flags = [flagRow({ flag_id: 41, flagged_at: fAt, model_key: 'NBA-ROLE-SHIFT', trigger_type: 'role_shift', sport_key: 'basketball_nba', event_id: 'ev_nba', home_team: NG.home.name, away_team: NG.away.name,
          commence_time: NG.start_utc, market: 'player_rebounds', side: 'Over', participant: 'Absorber', point: 6.5, target_price: 2.05, target_price_american: 105, target_cost_prob: 0.4878,
          reference_kind: 'role_shift_model', reference_prob: 0.5214, gap_pp: 3.36, snapshot_resolution_s: 420, absent_player_id: '1', absent_player_name: 'Absent Star', minutes_delta: 4, fair_line: 6.5, posted_line: 6.5 })];
        M.access = 'subscriber';
        for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
          M.injCard = card('OUT');
          const N = await open(vp, '/app.html#research/nba/' + NG.game_id, { time: TN });
          await N.page.waitForFunction(() => /Absorber/.test((document.getElementById('nbRoleShift') || {}).innerText || '') && /Rebounds/.test((document.getElementById('nbSharp') || {}).innerText || ''), null, { timeout: 45000 }).catch(() => {});
          const rs = await text(N.page, '#nbRoleShift'), sl = await text(N.page, '#nbSharp');
          chk('nba ' + label + ': OUT on the current report switches "Who absorbs the minutes" on, tagged Experimental', /Who absorbs the minutes/i.test(rs) && /Experimental/i.test(rs) && /Absent Star \(HOM\) is out/.test(rs), rs.slice(0, 300));
          chk('nba ' + label + ': the absorber: 24.0 -> 28.0 minutes, 10 / 20 games, the stint cross-check, the volume default -> regime', /24\.0 → 28\.0/.test(rs) && /10 \/ 20/.test(rs) && /\+5\.0 min/.test(rs) && /Rebounds 6\.0 → 7\.0/.test(rs), rs.slice(0, 900));
          chk('nba ' + label + ': the game\'s role-shift flag: the player, the line, the book, EdgeDesk\'s fair', /Rebounds/.test(sl) && /Absorber Over 6\.5/.test(sl) && /DraftKings \+105/.test(sl) && /EdgeDesk fair 52\.1%/.test(sl), sl.slice(0, 600));
          chk('nba ' + label + ': both models\' progress, each named', /Validation · Sharp lag:/.test(sl) && /Validation · NBA role shift:/.test(sl), sl.slice(-500));
          chk('nba ' + label + ': no horizontal page scroll', await noHScroll(N.page));
          chk('nba ' + label + ': no page error', N.errors.length === 0, N.errors);
          await shot(N.page, 'nba-' + label);
          await N.ctx.close();
        }
        M.injCard = card('QUESTIONABLE');
        const Q = await open(PHONE, '/app.html#research/nba/' + NG.game_id, { time: TN });
        await Q.page.waitForFunction(() => /default projections stand|Absorber/.test((document.getElementById('nbRoleShift') || {}).innerText || ''), null, { timeout: 45000 }).catch(() => {});
        const q = await text(Q.page, '#nbRoleShift');
        chk('nba: QUESTIONABLE switches nothing on: the default projections stand', /default projections stand/.test(q) && !/Absorber/.test(q), q.slice(0, 400));
        await Q.ctx.close();
        M.roleFile = null; M.injCard = null;
      }
    }
  } catch (e) {
    fail++; failures.push({ name: 'the run threw', detail: String(e && e.stack || e).slice(0, 800) });
  }
  await browser.close();
  srv.close();
  done();
})();
