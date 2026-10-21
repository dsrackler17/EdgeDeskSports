#!/usr/bin/env node
/* ===========================================================================
   The NBA panel in a real Chromium (app.html, Research → Other → NBA),
   desktop and a 390 px phone, against the committed artifacts (nba/slate.json,
   nba/props_slate.json, nba/validation/summary.json) with the clock pinned to
   the slate's build time.

   Games: the list, a game's every market table and section, the URL it
   writes, the numbers matching the slate, the price check (valid and
   malformed), Back. The matchup graphic leading every game (drawn, read
   aloud, square and portrait) with the status folded under it; a started
   game opening the research frozen before tip (a staged nba/recent.json). Props, Record and Methods tabs. States: the slate
   failing and coming back on Try again, a stale slate, a slate that fails its
   integrity check. No page error and no horizontal page scroll at either width.

   Who is playing (README §NBA roster and injury layer): Hornets at Nets with
   the injury card the database would return (the Roster-Adjusted Projection
   computed by nba/injury/core.js from the real roster inputs fixture): the
   OUT players, the departed players, the baseline beside the Experimental
   adjusted number, every adjustment traced, the known limitations, the
   graphic's line. Then the source killed: "Injury report not yet available"
   with the last check time, no statuses, no adjusted number, and the System
   health panel reporting the sync as failing.

   Run: node tools/nba/nba_ui.e2e.js [--shots DIR]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'NBA UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const SLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'nba', 'slate.json'), 'utf8'));
const NOW = new Date(Date.parse(SLATE.generated_at) + 60000).toISOString();
/* a started game, frozen before tip, not on the slate: what nba/recent.json holds after tip */
const STARTED = Object.assign(JSON.parse(JSON.stringify(SLATE.games[0])), { game_id: '990000001', start_utc: new Date(Date.parse(NOW) - 2 * 36e5).toISOString().replace(/\.000Z$/, 'Z'), frozen_at: new Date(Date.parse(NOW) - 5 * 36e5).toISOString() });
/* the clock is pinned one minute after the slate was built, and a slate built on a game night still
   lists the games under way: those draw as started, so the upcoming list is the games after NOW */
const UPCOMING = SLATE.games.filter((g) => Date.parse(g.start_utc) > Date.parse(NOW));
const RECENT = { schema: 'edgedesk_nba_recent_v1', sport: 'NBA', generated_at: NOW, window_hours: 96, games: [STARTED] };

/* ---- the injury layer as the database answers it (rpc/nba_injury_card, nba_injury_readiness) ---- */
const K = require(path.join(ROOT, 'nba', 'injury', 'core.js'));
const DIST = require(path.join(ROOT, 'nba', 'model', 'distribution.js'));
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'nba', 'fixtures', 'nba_injury_cha_bkn_2026-10-21.json'), 'utf8'));
const CB = SLATE.games.find((x) => String(x.game_id) === String(FX.game.game_id) && Date.parse(x.start_utc) > Date.parse(NOW)) || null;
const ago = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
let injMode = 'ok';
function injCard(gameId) {
  if (injMode === 'down') return { game_id: gameId, state: 'UNAVAILABLE', reason: 'the last check failed: the official report and the ESPN fallback both failed', last_check_at: ago(5), last_check_status: 'error', last_success_at: ago(125), report: null, statuses: [], not_submitted: [], rosters: {}, adjusted: null };
  if (!CB || String(gameId) !== String(CB.game_id)) return { game_id: gameId, state: 'NOT_ON_REPORT', reason: 'this game is not on the latest injury report yet', last_check_at: ago(7), last_check_status: 'ok', last_success_at: ago(7), report: null, statuses: [], not_submitted: [], rosters: {}, adjusted: null };
  const ids = { 'White, Coby': '4395651', 'Knueppel, Kon': '5061575', 'Williams, Grant': '4066218' };
  const statuses = Object.keys(ids).map((n, i) => ({ team_id: '30', team_abbr: 'CHA', player_id: ids[n], player_name: K.nbaDisplayName(n), status: 'OUT', source_status: 'Out', reason: 'Injury/Illness', match_method: 'team_exact', row_id: 900 + i }));
  const res = K.nbaRosterAdjust({ game: FX.game, shape: FX.shape, players: FX.players, rosters: { home: FX.rosters['17'].map((p) => p.id), away: FX.rosters['30'].map((p) => p.id) },
    roster_meta: { home: { capture_id: 41, captured_at: ago(30), source: 'espn_roster' }, away: { capture_id: 42, captured_at: ago(30), source: 'espn_roster' } },
    statuses: { home: [], away: statuses.map((x) => ({ id: x.row_id, player_id: x.player_id, player_name: x.player_name, status: 'OUT', source_status: 'Out', match_method: 'team_exact' })) },
    report: { id: 7, source: 'nba_official', published_at: ago(15), on_report: true, not_submitted: {} }, team_of: FX.team_of, slate_generated_at: CB.predicted_at || SLATE.generated_at }, DIST);
  return { game_id: gameId, state: 'AVAILABLE', reason: null, last_check_at: ago(7), last_check_status: 'ok', last_success_at: ago(7),
    report: { id: 7, source: 'nba_official', source_url: 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-21_01_00AM.pdf', published_at: ago(15), captured_at: ago(8), latest_seen_published_at: ago(15) },
    statuses, not_submitted: [], rosters: { 30: { capture_id: 42, captured_at: ago(30), source: 'espn_roster', players: FX.rosters['30'].map((p) => ({ player_id: p.id, player_name: p.name })) } },
    adjusted: Object.assign({ id: 501, model_key: 'NBA-ROSTER-ADJ', model_version: '0.1', model_version_ref: '42', injury_report_id: 7, report_source: 'nba_official', slate_generated_at: CB.predicted_at || SLATE.generated_at, computed_at: ago(7),
      home_roster_capture_id: 41, away_roster_capture_id: 42, impact_snapshot_id: 3 }, { status: res.status, reasons: res.reasons, baseline: res.baseline, adjusted: res.adjusted, delta: res.delta, adjustments: res.adjustments, roster_changes: res.roster_changes }) };
}
function injReadiness() {
  return injMode === 'down'
    ? [{ state: 'error', state_reason: 'the last check failed: the official report and the ESPN fallback both failed', last_check_at: ago(5), last_check_status: 'error', last_success_at: ago(125), report_source: 'nba_official', failures_24h: 1, degraded_24h: 1, drift_24h: 0, consecutive_failures: 1, game_day: true, last_official_report_at: ago(135), minutes_since_official_report: 135, unmatched_players: 0, teams_missing: [], teams_missing_count: 0, unread_lines: 0, teams_with_roster: 30 }]
    : [{ state: 'ok', state_reason: null, last_check_at: ago(7), last_check_status: 'ok', last_success_at: ago(7), report_source: 'nba_official', failures_24h: 0, degraded_24h: 0, drift_24h: 0, consecutive_failures: 0, game_day: true, last_official_report_at: ago(15), minutes_since_official_report: 15, unmatched_players: 0, teams_missing: [], teams_missing_count: 0, unread_lines: 0, teams_with_roster: 30 }];
}

(async function main() {
  if (!SLATE.games.length) done('SKIP | the committed slate has no games to exercise');
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  let mode = 'ok';
  const slateBody = () => {
    if (mode === 'ok') return JSON.stringify(Object.assign({}, SLATE, { generated_at: NOW }));
    if (mode === 'stale') return JSON.stringify(Object.assign({}, SLATE, { generated_at: new Date(Date.parse(NOW) - 40 * 36e5).toISOString() }));
    if (mode === 'bad') return JSON.stringify({ schema: 'something_else' });
    return null;
  };
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/nba/recent.json') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(RECENT)); return; }
    if (p === '/nba/slate.json') {
      if (mode === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(slateBody()); return;
    }
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
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
    else { console.log('SKIPPED: no Chromium'); srv.close(); process.exit(0); }
  }
  async function open(viewport, hash) {
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
        if (/rpc\/nba_injury_card/.test(u)) { let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (_) { b = {}; } return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(injCard(b.p_game_id)) }); }
        if (/nba_injury_readiness/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(injReadiness()) });
        if (/nba_injury_meta/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ key: 'nba_injury_sync_last_run', value: ago(injMode === 'down' ? 5 : 7) }, { key: 'nba_injury_sync_last_status', value: injMode === 'down' ? 'error' : 'ok' }, { key: 'row_count_nba_injury_sync', value: '3' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.clock.setFixedTime(new Date(NOW));
    await page.goto(`http://127.0.0.1:${port}/app.html${hash || ''}`, { waitUntil: 'domcontentloaded' });
    return { ctx, page, errors };
  }
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const overflowers = (page) => page.evaluate(() => { const W = document.documentElement.clientWidth; return Array.from(document.querySelectorAll('body *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 1; }).slice(-6).map((e) => e.tagName + '.' + String(e.className).slice(0, 30) + ' right=' + Math.round(e.getBoundingClientRect().right)); });

  try {
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      console.log(label);
      mode = 'ok';
      let { ctx, page, errors } = await open(vp, '#research/nba');
      await page.waitForSelector('#nbaHost .xe-game', { timeout: 25000 });
      chk(label + ': #research/nba opens the NBA panel inside Research', await page.evaluate(() => !document.getElementById('v-nba').classList.contains('hide') && !document.getElementById('v-research').classList.contains('hide')));
      chk(label + ': the Other seat names NBA while it is open', await page.evaluate(() => document.getElementById('rsOtherLbl').textContent === 'NBA' && document.querySelector('#rsOther button[data-sub="nba"]').classList.contains('on')));
      chk(label + ': every slate game not yet started is listed as upcoming', (await page.$$eval('#nbaHost .xe-game:not(.xe-started)', (x) => x.length)) === UPCOMING.length);
      chk(label + ': readiness says value claims are disabled and availability is projected', await page.evaluate(() => { const t = document.querySelector('#nbaHost .xe-ready').textContent; return /Value claims/.test(t) && /disabled/i.test(t) && /projected/.test(t); }));
      chk(label + ': each card shows a win bar, moneyline, spread and total', await page.evaluate(() => Array.from(document.querySelectorAll('#nbaHost .xe-game')).every((c) => c.querySelector('.nb-win') && /ML/.test(c.textContent) && /Spread/.test(c.textContent) && /Total/.test(c.textContent))));
      chk(label + ': no horizontal scroll on the NBA list', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_list');
      const g = UPCOMING[0] || SLATE.games[0];
      await page.click('#nbaHost .xe-game[data-game="' + g.game_id + '"]');
      await page.waitForSelector('#nbaHost .xe-detail');
      chk(label + ': opening a game writes its URL', await page.evaluate(() => location.hash) === '#research/nba/' + g.game_id, await page.evaluate(() => location.hash));
      const drawn = () => page.waitForFunction(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i && !i.hidden && /^(blob|data):/.test(i.src) && i.naturalWidth > 0; }, null, { timeout: 25000 }).then(() => true, () => false);
      chk(label + ': the game opens with the matchup graphic', await drawn(), await page.evaluate(() => (document.querySelector('#nbaHost .xe-gfx') || {}).textContent));
      chk(label + ': the graphic is read aloud: both teams, the fair spread and total, research not picks', await page.evaluate((a) => { const t = document.querySelector('#nbaHost #nbGfxImg').alt; return t.indexOf(a.h) >= 0 && t.indexOf(a.a) >= 0 && /fair spread/.test(t) && t.indexOf('fair total ' + a.t) >= 0 && /Research, not picks\.$/.test(t); }, { h: g.home.abbr, a: g.away.abbr, t: g.price.total.fair_line.toFixed(1) }));
      chk(label + ': the graphic leads the game, before the numbers and tables', await page.evaluate(() => { const d = document.querySelector('#nbaHost .xe-detail'), x = d.querySelector('.xe-gfx'), k = d.querySelector('.nb-kpis'); return !!x && !!k && !!(x.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING); }));
      chk(label + ': the data, model and market status folds away under the game', await page.evaluate(() => !!document.querySelector('#nbaHost details.xe-statusd .xe-ready') && !document.querySelector('#nbaHost details.xe-statusd').open));
      chk(label + ': Download, Share and Copy link sit under the graphic', await page.evaluate(() => ['gfx-dl', 'gfx-share', 'gfx-copy'].every((a) => document.querySelector('#nbaHost .xe-gfx [data-act="' + a + '"]'))));
      await page.click('#nbaHost [data-act="gfx-fmt"][data-v="portrait"]');
      chk(label + ': portrait draws a 1080×1350 graphic', await drawn() && await page.evaluate(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i.naturalWidth === 1080 && i.naturalHeight === 1350; }));
      await page.click('#nbaHost [data-act="gfx-fmt"][data-v="square"]');
      chk(label + ': square draws a 1080×1080 graphic', await drawn() && await page.evaluate(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i.naturalWidth === 1080 && i.naturalHeight === 1080; }));
      const caps = await page.$$eval('#nbaHost .xe-t caption', (x) => x.map((c) => c.textContent));
      chk(label + ': a game shows every market and the research', ['Moneyline', 'Spread ladder', 'Total ladder', 'Team totals', 'First half', 'First quarter', 'Winning margin', 'Every candidate', 'Four factors', 'Scenarios'].every((k) => caps.some((c) => c.indexOf(k) === 0)), caps);
      const secs = await page.$$eval('#nbaHost .xe-sechd > span:first-child', (x) => x.map((c) => c.textContent));
      chk(label + ': the sections are all there', ['Every market, one distribution', 'Model comparison', 'The matchup', 'Who is playing', 'If he sits', 'Uncertainty', 'Reasons to pass', 'The market'].every((k) => secs.indexOf(k) >= 0), secs);
      chk(label + ': the fair home moneyline matches the slate', await page.evaluate((a) => document.querySelector('#nbaHost .xe-detail').textContent.indexOf((a > 0 ? '+' : '') + a) >= 0, g.price.moneyline.home_american));
      chk(label + ': reasons to pass are listed', (await page.$$eval('#nbaHost .nb-pass li', (x) => x.length)) === g.reasons_to_pass.length);
      await page.fill('#nbaHost .xe-pc input[name="price"]', '-110');
      await page.click('#nbaHost .xe-pc button[type="submit"]');
      const res = await page.textContent('#nbaHost .xe-pc-res');
      chk(label + ': the price check prints break-even, EdgeDesk and EV, and refuses a value call', /Break-even 52\.4%/.test(res) && /Not a value call/.test(res), res);
      await page.fill('#nbaHost .xe-pc input[name="price"]', 'abc');
      await page.click('#nbaHost .xe-pc button[type="submit"]');
      chk(label + ': a malformed price is refused with a hint', /Enter an American price/.test(await page.textContent('#nbaHost .xe-pc-res')));
      chk(label + ': no horizontal scroll on a game', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_game');

      /* who is playing: Hornets at Nets */
      if (CB) {
        injMode = 'ok';
        await page.click('#nbaHost [data-act="back"]');
        await page.waitForSelector('#nbaHost .xe-game[data-game="' + CB.game_id + '"]');
        await page.click('#nbaHost .xe-game[data-game="' + CB.game_id + '"]');
        await page.waitForSelector('#nbaHost .nb-inj .nb-inj-team', { timeout: 15000 });
        const inj = await page.evaluate(() => document.querySelector('#nbaHost .nb-inj').textContent);
        chk(label + ': who is playing lists White, Knueppel and Williams out for Charlotte, from the league\'s report, with its time', /Coby White/.test(inj) && /Kon Knueppel/.test(inj) && /Grant Williams/.test(inj) && /NBA official injury report/.test(inj) && /published/.test(inj) && /last check/.test(inj), inj.slice(0, 400));
        chk(label + ': …and Ball and Bridges are no longer on Charlotte\'s roster', /CHA no longer on the roster/.test(inj) && /LaMelo Ball/.test(inj) && /Miles Bridges/.test(inj));
        chk(label + ': the old "rotations from last season" sentence is gone', !/Rotations from last season/.test(await page.evaluate(() => document.querySelector('#nbaHost').textContent)));
        const cmp = await page.$$eval('#nbaHost table.nb-cmp tr', (rs) => rs.map((r) => Array.from(r.children).map((c) => c.textContent)));
        const kpis = await page.$$eval('#nbaHost .nb-kpi', (ks) => ks.map((k) => [k.querySelector('.xe-k').textContent, k.querySelector('.nb-kv').textContent]));
        const kv = (n) => (kpis.find((x) => x[0] === n) || [])[1];
        const row = (n) => cmp.find((r) => r[0] === n) || [];
        chk(label + ': the baseline column is the card\'s own fair spread and total, unchanged', row('Fair spread')[1] === kv('Fair spread') && row('Fair total')[1] === kv('Fair total') && row('Projected score')[1] === kv('Expected score'), { cmp, kpis });
        chk(label + ': the roster-adjusted spread moves toward Brooklyn (at least six points), with its delta', /^BKN /.test(row('Fair spread')[2] || '') && /pts toward BKN/.test(row('Fair spread')[3] || '') && parseFloat(row('Fair spread')[3]) >= 6, row('Fair spread'));
        chk(label + ': the adjusted column is badged Experimental', await page.evaluate(() => Array.from(document.querySelectorAll('#nbaHost .xe-sechd')).some((h) => /Baseline vs Roster-Adjusted/.test(h.textContent) && /Experimental/.test(h.textContent))));
        const adj = await page.$$eval('#nbaHost .nb-adj li', (x) => x.map((l) => l.textContent));
        chk(label + ': adjustments applied: each traced (Coby White OUT, LaMelo Ball no longer on the roster)', adj.some((t) => /Coby White OUT: −/.test(t) && /report #7/.test(t)) && adj.some((t) => /LaMelo Ball no longer on CHA/.test(t) && /roster capture #42/.test(t)), adj.slice(0, 6));
        chk(label + ': known limitations say what is estimated', /Play probabilities for questionable players are fixed estimates/.test(inj) && /no lineup confirmation until tip/i.test(inj));
        /* the graphic redraws once the card has read the report (its cache key carries the report) */
        const gfxInj = await page.waitForFunction(() => { const i = document.querySelector('#nbaHost #nbGfxImg'); return i && !i.hidden && i.naturalWidth > 0 && /CHA out: White, Knueppel, Williams/.test(i.alt); }, null, { timeout: 25000 }).then(() => true, () => false);
        chk(label + ': the graphic\'s who-is-playing line reads the report', gfxInj, await page.evaluate(() => (document.querySelector('#nbaHost #nbGfxImg') || {}).alt));
        chk(label + ': no horizontal scroll with the injury sections', await noHScroll(page), await overflowers(page));
        await shot(page, label + '_nba_injury');
        /* the source killed */
        injMode = 'down';
        await page.click('#nbaHost [data-act="refresh"]');
        await page.waitForFunction(() => /Injury report not yet available/.test((document.querySelector('#nbaHost .nb-inj') || {}).textContent || ''), null, { timeout: 15000 });
        const dn = await page.evaluate(() => document.querySelector('#nbaHost .nb-inj').textContent);
        chk(label + ': the source killed: "Injury report not yet available" with the last check time, and no statuses', /Injury report not yet available/.test(dn) && /last check/.test(dn) && /\(failed\)/.test(dn) && !/Coby White/.test(dn), dn.slice(0, 300));
        const cmp2 = await page.$$eval('#nbaHost table.nb-cmp tr', (rs) => rs.map((r) => Array.from(r.children).map((c) => c.textContent)));
        chk(label + ': …the adjusted number is withheld, the baseline still shown', (cmp2.find((r) => r[0] === 'Fair spread') || [])[2] === '—' && (cmp2.find((r) => r[0] === 'Fair spread') || [])[1] === kv('Fair spread') && /withheld/.test(await page.evaluate(() => document.querySelector('#nbaHost table.nb-cmp caption').textContent)));
        /* the clock is pinned, so the panel's one-minute re-read is asked for directly */
        await page.evaluate(() => (window.sysHealthNbaLoad ? window.sysHealthNbaLoad(true) : null));
        await page.click('#sysHealthBtn');
        await page.waitForFunction(() => /NBA injury sync/.test((document.getElementById('sysHealthPop') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
        const sh = await page.evaluate(() => (document.getElementById('sysHealthPop') || {}).textContent || '');
        chk(label + ': System health reports the failed sync, its failure alert and the report\'s age', /NBA injury sync/.test(sh) && /failing/.test(sh) && /1 failure/.test(sh) && /NBA injury report freshness/.test(sh), sh.slice(0, 600));
        await page.keyboard.press('Escape');
        injMode = 'ok';
      }
      await page.click('#nbaHost [data-act="back"]');
      await page.waitForSelector('#nbaHost .xe-game');
      await page.waitForSelector('#nbaHost .xe-sechd', { timeout: 15000 });
      await page.waitForFunction(() => /Started/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => null);
      chk(label + ': Back returns to the list', (await page.$$eval('#nbaHost .xe-game:not(.xe-started)', (x) => x.length)) === UPCOMING.length);
      chk(label + ': a started game is listed under its own heading', await page.evaluate(() => /Started · research frozen before tip/.test(document.querySelector('#nbaHost').textContent) && !!document.querySelector('#nbaHost .xe-game.xe-started[data-game="990000001"]')));
      await page.click('#nbaHost .xe-game[data-game="990000001"]');
      await page.waitForSelector('#nbaHost .xe-detail');
      chk(label + ': a started game opens the research frozen before tip, said plainly', await page.evaluate(() => /This game has started/.test(document.querySelector('#nbaHost .xe-detail').textContent)));
      chk(label + ': …with its graphic, a pregame snapshot', await drawn() && await page.evaluate(() => /EdgeDesk research graphic/.test(document.querySelector('#nbaHost #nbGfxImg').alt)));
      chk(label + ': no horizontal scroll on a started game', await noHScroll(page), await overflowers(page));
      await page.click('#nbaHost [data-act="back"]');
      await page.waitForSelector('#nbaHost .xe-game');
      /* tabs */
      await page.click('#nbaHost [data-tab="record"]');
      await page.waitForFunction(() => /Selection window/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 20000 });
      chk(label + ': the record shows every candidate on the selection window and says whether the test is sealed', await page.evaluate(() => { const t = document.querySelector('#nbaHost').textContent; return /Selection window/.test(t) && /(sealed|scored once)/i.test(t) && /Elo/.test(t); }));
      chk(label + ': the record names the reference line as a diagnostic, never a market test', await page.evaluate(() => /DIAGNOSTIC/.test(document.querySelector('#nbaHost').textContent)));
      chk(label + ': no horizontal scroll on the record', await noHScroll(page), await overflowers(page));
      await shot(page, label + '_nba_record');
      await page.click('#nbaHost [data-tab="props"]');
      await page.waitForFunction(() => /fair lines|No prop projections/.test((document.querySelector('#nbaHost') || {}).textContent || ''), null, { timeout: 20000 });
      chk(label + ': the props tab shows fair lines (or says it has none)', await page.evaluate(() => /fair lines|No prop projections/.test(document.querySelector('#nbaHost').textContent)));
      chk(label + ': no horizontal scroll on props', await noHScroll(page), await overflowers(page));
      await page.click('#nbaHost [data-tab="methods"]');
      chk(label + ': the methods name all seven model families and the limits', await page.evaluate(() => { const t = document.querySelector('#nbaHost').textContent; return ['Elo', 'efficiency', 'plus-minus', 'simulation', 'boosted', 'Kalman', 'stacked'].every((k) => t.indexOf(k) >= 0) && /Never tested against a closing market/.test(t); }));
      await page.click('#nbaHost [data-tab="games"]');
      await page.waitForSelector('#nbaHost .xe-game');
      /* states */
      mode = 'down';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.err');
      chk(label + ': a failed slate is an error with Try again, nothing in its place', await page.evaluate(() => /could not load/.test(document.querySelector('#nbaHost .xe-banner.err').textContent) && !document.querySelector('#nbaHost .xe-game')));
      mode = 'ok';
      await page.click('#nbaHost .xe-banner.err [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-game');
      chk(label + ': Try again recovers', true);
      mode = 'stale';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.warn');
      chk(label + ': a stale slate says so', /Stale prices/.test(await page.textContent('#nbaHost .xe-banner.warn')));
      mode = 'bad';
      await page.click('#nbaHost [data-act="refresh"]');
      await page.waitForSelector('#nbaHost .xe-banner.err');
      chk(label + ': a slate that fails its integrity check is refused', /Integrity refusal/.test(await page.textContent('#nbaHost .xe-banner.err')));
      chk(label + ': no page errors on NBA', errors.length === 0, errors);
      await ctx.close();
    }
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close(); srv.close();
  }
  done();
})();
