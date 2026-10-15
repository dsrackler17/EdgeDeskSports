#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Today's Games in a real Chromium: the strip on the terminal's first screen,
   the full games page (#games), the matchup view and the public /today/ page,
   at a 390 px phone and a 1280 px desktop, America/Chicago, the clock pinned
   to 2026-10-13 5:30 PM CDT, over the slate the REAL builder makes from
   constructed ESPN payloads (tools/slate/fixtures/slate_fixture.js).

   It checks what a reader sees and can do: live first, the reader's own day
   (an 11:50 PM game is today's, a 12:10 AM one is tomorrow's), puck line /
   run line / 1X2 with the draw, "Odds unavailable", an honest empty sport
   with its Upcoming games, "Unable to load" for a sport whose source failed,
   one tap to research and Back to the same sport and date, filters, search,
   keyboard, the matchup dialog, the live overlay, the reader's own prices,
   a failed slate (and recovery), the copy saved on the device, a stale
   slate, the day rolling over at local midnight, the public page's limits,
   and that the terminal's own navigation still works. No page error and no
   horizontal page scroll anywhere.

   Run: node tools/slate/games_ui.e2e.js [--shots DIR]
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const http = require('http');
const F = require('./fixtures/slate_fixture.js');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'games UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const NOW = F.NOW;

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  /* the slate was built ten minutes ago, so a live read from now is the newer one */
  const built = await F.buildFixture({ now: NOW - 10 * 60000 });
  const SLATE = built.snap;

  /* what the stubs answer, changed per scenario */
  const M = { slate: 'ok', live: 'none', markets: 'none', board: 'none' };
  function slateBody() {
    if (M.slate === 'stale') return JSON.stringify(Object.assign({}, SLATE, { generated_at: new Date(NOW - 8 * 36e5).toISOString() }));
    return JSON.stringify(SLATE);
  }
  function liveBody() {
    const ev = JSON.parse(JSON.stringify(SLATE.events.filter((e) => e.feed === 'nhl:hockey/nhl' && e.sb_day === '2026-10-13' && e.id !== 'nhl:espn:401802004')));
    const det = ev.find((e) => e.id === 'nhl:espn:401802001');
    det.home.score = 3; det.status_detail = '3rd 4:10'; det.updated_at = new Date(NOW - 30000).toISOString();
    ev.forEach((e) => { e.market = null; });
    return JSON.stringify({ schema: 'edgedesk_slate_live/1', as_of: new Date(NOW).toISOString(), covered: [{ feed: 'nhl:hockey/nhl', sport: 'nhl', day: '2026-10-13', fetched_at: new Date(NOW - 30000).toISOString() }], failed: [], events: ev });
  }
  function marketsBody() {
    return JSON.stringify({ schema: 'edgedesk_slate_markets/1', entitled: true, available: true, events: [{
      event_id: 'zz1', sport_key: 'americanfootball_ncaaf', commence_time: '2026-10-13T23:00:00Z', home_team: 'Middle Tennessee Blue Raiders', away_team: 'Delaware Blue Hens', odds_format: 'decimal',
      bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [
        { key: 'h2h', last_update: new Date(NOW - 6e5).toISOString(), outcomes: [{ name: 'Middle Tennessee Blue Raiders', price: 1.5 }, { name: 'Delaware Blue Hens', price: 2.7 }] },
        { key: 'spreads', last_update: new Date(NOW - 6e5).toISOString(), outcomes: [{ name: 'Middle Tennessee Blue Raiders', price: 1.91, point: -4.5 }, { name: 'Delaware Blue Hens', price: 1.91, point: 4.5 }] }] }] }] });
  }
  function boardBody() {
    return JSON.stringify({ ok: true, as_of: new Date(NOW - 60000).toISOString(), counts: { research: 1 }, games: [{ game_key: 'cfb|401871067', league: 'cfb', home: 'Middle Tennessee', away: 'Delaware', kickoff_at: '2026-10-13T23:00:00Z',
      status: 'RESEARCH', fair: { home_line: -10.5, text: 'Middle Tennessee -10.5' }, market: { home_line: -4.5, text: 'Middle Tennessee -4.5', book: 'draftkings', captured_at: new Date(NOW - 10 * 60000).toISOString(), kind: 'live' }, gap: 6 }] });
  }

  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/today/') p = '/today/index.html';
    if (p === '/today/slate.json') {
      if (M.slate === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(slateBody()); return;
    }
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

  async function open(viewport, url, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, timezoneId: 'America/Chicago', locale: 'en-US' });
    await ctx.addInitScript((seed) => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ done: true }));
        localStorage.setItem('edgedesk_setup_v1', JSON.stringify({ done: true, at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        if (seed) Object.keys(seed).forEach((k) => localStorage.setItem(k, seed[k]));
      } catch (e) { /* storage */ }
    }, o.seed || null);
    const seen = { live: 0, markets: 0, board: 0 };
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/supabase\.co/.test(u)) {
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        if (/rpc\/public_slate_live/.test(u)) { seen.live++; return M.live === 'on' ? route.fulfill({ status: 200, contentType: 'application/json', body: liveBody() }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' }); }
        if (/rpc\/slate_markets/.test(u)) { seen.markets++; if (M.markets === '404') return route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202","message":"Could not find the function public.slate_markets"}' }); return M.markets === 'on' ? route.fulfill({ status: 200, contentType: 'application/json', body: marketsBody() }) : route.fulfill({ status: 200, contentType: 'application/json', body: '{"entitled":false,"events":[]}' }); }
        if (/rpc\/public_home_board/.test(u)) { seen.board++; return M.board === 'on' ? route.fulfill({ status: 200, contentType: 'application/json', body: boardBody() }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }); }
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.clock.install({ time: o.time != null ? o.time : NOW });
    await page.goto(base + url, { waitUntil: 'load' });
    return { ctx, page, errors, seen };
  }
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const cards = (page, scope) => page.$$eval(scope + ' .gm-card[data-id]', (els) => els.map((e) => e.getAttribute('data-id')));
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };
  const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 900 };

  try {
    /* ── THE STRIP: the terminal's first screen ─────────────────────── */
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      const { ctx, page, errors } = await open(vp, '/app.html');
      await page.waitForSelector('#gamesStrip .gm-card[data-id]', { timeout: 15000 });
      await shot(page, 'strip-' + label);
      const ids = await cards(page, '#gamesStrip');
      chk(label + ': the strip is the first thing in Research', await page.evaluate(() => { const s = document.getElementById('gamesStrip'), h = document.querySelector('#v-research .rs-hd'); return !!s && h.nextElementSibling === s && !document.getElementById('v-research').classList.contains('hide'); }));
      chk(label + ': live games first', ids[0] === 'soccer:espn:701003' && ids[1] === 'nhl:espn:401802001', ids.slice(0, 3));
      chk(label + ': the 11:50 PM game is today’s; the 12:10 AM one is not', ids.indexOf('nhl:espn:401802004') >= 0 && ids.indexOf('nhl:espn:401802005') < 0);
      chk(label + ': yesterday’s final is not today’s', ids.indexOf('soccer:espn:701001') < 0);
      chk(label + ': All sports counts today’s nine games', /All sports\s*9/.test(await text(page, '#gamesStrip [data-gm-sport="all"]')));
      chk(label + ': no horizontal page scroll', await noHScroll(page));
      chk(label + ': the strip never names ESPN, in its words, tooltips or labels', await page.evaluate(() => { const s = document.getElementById('gamesStrip'); return !/ESPN/i.test(s.innerText) && ![...s.querySelectorAll('[title],[aria-label]')].some((e) => /ESPN/i.test((e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || ''))); }));
      if (label === 'phone') {
        chk('phone: scoreboard tiles, two abreast with the next peeking', await page.evaluate(() => { const li = document.querySelectorAll('#gamesStrip .gm-row > .gm-li'); const a = li[1].getBoundingClientRect(), b = li[2].getBoundingClientRect(); return a.right <= window.innerWidth && b.left < window.innerWidth && a.width < 200; }));
        chk('phone: the research pill and its Details button are full tap targets', await page.evaluate(() => [...document.querySelectorAll('#gamesStrip .gm-cta .gm-go, #gamesStrip .gm-cta .gm-more')].every((b) => b.getBoundingClientRect().height >= 35.5 && b.getBoundingClientRect().width >= 28)));
        chk('phone: the pill\'s words fit (nothing cut off)', await page.evaluate(() => [...document.querySelectorAll('#gamesStrip .gm-cta-tx b, #gamesStrip .gm-cta-tx small')].every((e) => e.scrollWidth <= e.clientWidth + 1)));
      }
      chk(label + ': no page error', errors.length === 0, errors);
      await ctx.close();
    }

    const D = await open(DESK, '/app.html');
    const { page } = D;
    await page.waitForSelector('#gamesStrip .gm-card[data-id]');
    const cbj = await text(page, '#gamesStrip .gm-card[data-id="nhl:espn:401802002"]');
    chk('a hockey tile prints each side\'s moneyline beside it and the total under them', /FLA\s+−150\s+[\s\S]*CBJ\s+\+130\s+6:00 PM\s+o6\.5/.test(cbj), cbj);
    chk('with its book and its age, in words', /DraftKings · \d+ min ago/.test(cbj) && /FLA moneyline −150, CBJ moneyline \+130, total 6\.5 \(over −110, under −110\)/.test(cbj), cbj);
    chk('and EdgeDesk\'s state on the research pill', /Research[\s\S]*Model ready/.test(cbj), cbj);
    const cfb = await text(page, '#gamesStrip .gm-card[data-id="cfb:espn:401871067"]');
    chk('a game with only a consensus quote stays on the slate and says it has no odds', /No odds/.test(cfb) && /odds unavailable/i.test(cfb) && /Research/.test(cfb) && !(await page.$('#gamesStrip .gm-card[data-id="cfb:espn:401871067"] .gm-cv')), cfb);
    chk('the board\'s read rides on the pill', /Read: Research/.test(cfb), cfb);
    const mlb = await text(page, '#gamesStrip .gm-card[data-id="mlb:espn:401803002"]');
    chk('a baseball tile prints the moneylines; a doubleheader game says which', /NYY\s+\+100/.test(mlb) && /BOS\s+−120/.test(mlb) && /\bG2\b/.test(mlb) && /Game 2 of 2/.test(mlb), mlb);
    const det = await text(page, '#gamesStrip .gm-card[data-id="nhl:espn:401802001"]');
    chk('a live game shows its clock and score, and no in-play price', /Live · 2nd 12:34/.test(det) && /\b2\b/.test(det) && !(await page.$('#gamesStrip .gm-card[data-id="nhl:espn:401802001"] .gm-cv')), det);
    chk('times are the reader’s, with the zone named once under the strip', /6:00 PM/.test(cbj) && /Times in CDT \(America\/Chicago\)/.test(await text(page, '#gamesStrip .gm-foot')));
    const rma = await text(page, '#gamesStrip .gm-card[data-id="soccer:espn:701003"]');
    chk('a game with no research page: the pill opens the matchup', /Matchup/.test(rma) && /No research yet/.test(rma) && !!(await page.$('#gamesStrip .gm-card[data-id="soccer:espn:701003"] button.gm-go[data-gm-detail]')), rma);

    /* empty, failed, upcoming */
    await page.click('#gamesStrip [data-gm-sport="nba"]');
    const nba = await text(page, '#gamesStrip');
    chk('a sport with nothing today says so plainly', /No NBA games scheduled today/.test(nba), nba.slice(0, 300));
    chk('and offers its next games under Upcoming, labelled as not today', /Upcoming/i.test(nba) && /not today/i.test(nba) && (await cards(page, '#gamesStrip')).indexOf('nba:espn:401900001') >= 0);
    chk('the NBA opener carries its own date, never today’s', /Tue, Oct 20/.test(nba));
    await page.click('#gamesStrip [data-gm-sport="mma"]');
    const mma = await text(page, '#gamesStrip');
    chk('a sport whose source failed says "Unable to load", never "no games"', /Unable to load UFC \/ MMA games today/.test(mma) && !/No UFC \/ MMA games scheduled/.test(mma), mma.slice(0, 300));
    chk('and its pill shows a dash, not a zero', (await text(page, '#gamesStrip [data-gm-sport="mma"]')).indexOf('–') >= 0);
    await page.click('#gamesStrip [data-gm-sport="ncaabase"]');
    const cbase = await text(page, '#gamesStrip');
    chk('a sport that answered empty is a confirmed empty day, with nothing in the next 14 days', /No College Baseball games scheduled today/.test(cbase) && /next 14 days/.test(cbase), cbase.slice(0, 300));
    await page.click('#gamesStrip [data-gm-sport="all"]');

    /* keyboard: the pills are a group the arrow keys move through */
    await page.focus('#gamesStrip [data-gm-sport="all"]');
    await page.keyboard.press('ArrowRight');
    chk('ArrowRight moves focus along the sport pills', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-gm-sport') === 'nfl'));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    chk('Enter selects the focused sport, and focus stays on it', await page.evaluate(() => { const b = document.querySelector('#gamesStrip [data-gm-sport="mma"]'); return b.getAttribute('aria-pressed') === 'true' && document.activeElement === b; }));
    await page.click('#gamesStrip [data-gm-sport="all"]');

    /* one tap to research, and back */
    await page.click('#gamesStrip .gm-card[data-id="nhl:espn:401802001"] a.gm-go');
    await page.waitForFunction(() => location.hash === '#research/nhl/2026020090');
    chk('View Research opens the NHL panel on that game (#research/nhl/<id>)', await page.waitForFunction(() => !document.getElementById('v-nhl').classList.contains('hide'), null, { timeout: 5000 }).then(() => true, () => false));
    await page.goBack();
    await page.waitForFunction(() => !/^#research\/nhl/.test(location.hash));
    chk('Back returns to where the reader was', await page.evaluate(() => !document.getElementById('v-research').classList.contains('hide')));

    /* the matchup view */
    await page.click('#gamesStrip .gm-card[data-id="nhl:espn:401802002"] .gm-more');
    await page.waitForSelector('#gmDetail:not([hidden])');
    const dlg = await text(page, '#gmDetail');
    chk('the matchup view never names ESPN', !/ESPN/i.test(dlg), dlg.slice(-300));
    chk('Details opens a dialog with the market, the research, the model and the five readiness answers',
      /Market/i.test(dlg) && /Research/i.test(dlg) && /EdgeDesk model/i.test(dlg) && /Fair puck line/.test(dlg) && /Games available/.test(dlg) && /Actionable signal/.test(dlg), dlg.slice(0, 500));
    chk('the NHL matchup sets EdgeDesk against the captured price: the favourite, the gap, the price that pays, never verified',
      /EdgeDesk vs the market\. EdgeDesk makes FLA the likelier winner, 52\.8% \(fair −112\)/.test(dlg) && /Largest difference: EdgeDesk rates CBJ to win 5\.2 pp higher than the book/.test(dlg) && /CBJ at \+130 pays above EdgeDesk’s fair \+112/.test(dlg) && /not a verified edge/.test(dlg) && !/verified value/i.test(dlg), dlg.slice(0, 1400));
    chk('the model is labelled as an estimate, with its validation and why value claims are off', /not a recommendation/.test(dlg) && /outcome validated/i.test(dlg) && /value claims are off/i.test(dlg));
    chk('focus moves into the dialog', await page.evaluate(() => document.activeElement && document.activeElement.hasAttribute('data-gm-close')));
    await page.keyboard.press('Escape');
    chk('Escape closes it and returns focus to Details', await page.evaluate(() => document.getElementById('gmDetail').hidden && document.activeElement && document.activeElement.classList.contains('gm-more')));

    /* ── THE FULL PAGE ─────────────────────────────────────────────── */
    await page.click('#gamesStrip a.gm-all');
    await page.waitForFunction(() => /^#games\/all\/2026-10-13/.test(location.hash) && !document.getElementById('v-games').classList.contains('hide'));
    chk('View all opens the games page on today', true);
    chk('the Research seat stays lit', await page.evaluate(() => document.querySelector('.bottomnav button[data-v="research"]').getAttribute('aria-current') === 'page'));
    await shot(page, 'page-desktop');
    const pcbj = await text(page, '#gamesPage .gm-card[data-id="nhl:espn:401802002"]');
    chk('the games page card keeps every market: puck line, moneyline and total, both sides labelled', /Puck line/i.test(pcbj) && /FLA\s+−1\.5 \+170\s+−150\s+O 6\.5 −110/.test(pcbj) && /CBJ\s+\+1\.5 −205\s+\+130\s+U 6\.5 −110/.test(pcbj), pcbj);
    chk('with its book and its age, and no ESPN', /DraftKings · \d+ min ago/.test(pcbj) && !/ESPN/.test(await text(page, '#gamesPage')), pcbj);
    chk('a baseball page card prices the run line', /Run line/i.test(await text(page, '#gamesPage .gm-card[data-id="mlb:espn:401803002"]')));
    const secs = await page.$$eval('#gamesPage .gm-sec .gm-sech', (h) => h.map((x) => x.firstChild.textContent.trim()));
    chk('sections in order: live, scheduled, final, postponed', JSON.stringify(secs) === JSON.stringify(['Live', 'Scheduled', 'Final', 'Postponed and canceled']), secs);
    chk('the postponed game is in its own section', (await cards(page, '#gamesPage .gm-sec[aria-labelledby="gm-sec-off"]')).join() === 'mlb:espn:401803003');
    chk('both doubleheader games, labelled', /Game 1 of 2/.test(await text(page, '#gamesPage .gm-card[data-id="mlb:espn:401803001"]')) && /Game 2 of 2/.test(await text(page, '#gamesPage .gm-card[data-id="mlb:espn:401803002"]')));
    await page.click('#gamesPage [data-gm-sport="nhl"]');
    await page.waitForFunction(() => location.hash === '#games/nhl/2026-10-13');
    await page.click('#gamesPage [data-gm-status="final"]');
    await page.waitForFunction(() => location.hash === '#games/nhl/2026-10-13?status=final');
    chk('sport and status filters write the hash', JSON.stringify(await cards(page, '#gamesPage')) === JSON.stringify(['nhl:espn:401802003']));
    await page.click('#gamesPage [data-gm-status="all"]');
    await page.fill('#gmSearch', 'montreal');
    await page.waitForFunction(() => /q=montreal/.test(location.hash));
    chk('search ignores accents (montreal finds Montréal)', JSON.stringify(await cards(page, '#gamesPage')) === JSON.stringify(['nhl:espn:401802003']));
    await page.fill('#gmSearch', '');
    await page.waitForFunction(() => !/q=/.test(location.hash));
    await page.click('#gamesPage [data-gm-date="2026-10-14"]');
    await page.waitForFunction(() => location.hash === '#games/nhl/2026-10-14');
    const tmr = await cards(page, '#gamesPage');
    chk('Tomorrow holds the 12:10 AM game and not the 11:50 PM one', tmr.indexOf('nhl:espn:401802005') >= 0 && tmr.indexOf('nhl:espn:401802004') < 0, tmr);
    await page.click('#gamesPage [data-gm-date="2026-10-13"]');
    await page.waitForFunction(() => location.hash === '#games/nhl/2026-10-13');
    await page.click('#gamesPage .gm-card[data-id="nhl:espn:401802001"] a.gm-go');
    await page.waitForFunction(() => location.hash === '#research/nhl/2026020090');
    await page.goBack();
    await page.waitForFunction(() => location.hash === '#games/nhl/2026-10-13' && !document.getElementById('v-games').classList.contains('hide'));
    chk('research and Back: the same sport and date, selected', await page.evaluate(() => document.querySelector('#gamesPage [data-gm-sport="nhl"]').getAttribute('aria-pressed') === 'true'
      && document.querySelector('#gamesPage [data-gm-date="2026-10-13"]').getAttribute('aria-pressed') === 'true'));
    await page.click('#gamesPage [data-gm-sport="all"]');
    await page.click('#gamesPage [data-gm-date="2026-10-12"]');
    await page.waitForFunction(() => location.hash === '#games/all/2026-10-12');
    const yday = await text(page, '#gamesPage .gm-card[data-id="soccer:espn:701001"]');
    chk('Yesterday holds the final, with its score', /Final/.test(yday) && /Arsenal[\s\S]*2[\s\S]*Chelsea[\s\S]*2|Chelsea[\s\S]*2[\s\S]*Arsenal[\s\S]*2/.test(yday), yday);
    await page.fill('#gmDateInput', '2026-10-14');
    await page.dispatchEvent('#gmDateInput', 'change');
    await page.waitForFunction(() => location.hash === '#games/all/2026-10-14');
    const liv = await text(page, '#gamesPage .gm-card[data-id="soccer:espn:701002"]');
    chk('a soccer moneyline is the 1X2, with the draw priced on its own row', /1X2/i.test(liv) && /Draw\s+\+250/.test(liv), liv);
    await page.fill('#gmDateInput', '2026-10-15');
    await page.dispatchEvent('#gmDateInput', 'change');
    await page.waitForFunction(() => location.hash === '#games/all/2026-10-15');
    const den = await text(page, '#gamesPage .gm-card[data-id="nfl:espn:401880001"]');
    chk('the date picker reaches Thursday: the NFL game with its spread', /Spread/i.test(den) && /SEA\s+−2\.5 −110/.test(den), den);
    chk('dates outside the slate cannot be picked', await page.evaluate(() => { const i = document.getElementById('gmDateInput'); return !!i.min && !!i.max && i.max <= '2026-10-16'; }));
    await page.goto(base + '/app.html#games/nba/2026-10-13');
    await page.waitForSelector('#gamesPage .gm-up .gm-card');
    await page.click('#gamesPage .gm-card[data-id="nba:espn:401900001"] .gm-go');
    await page.waitForSelector('#gmDetail:not([hidden])');
    const nbaDlg = await text(page, '#gmDetail');
    chk('a game with no research page opens the matchup view and says research is not available yet', /Research not available yet/.test(nbaDlg) && /Boston Celtics at New York Knicks/.test(nbaDlg), nbaDlg.slice(0, 300));
    await page.keyboard.press('Escape');
    chk('the games page: no page error', D.errors.length === 0, D.errors);
    await D.ctx.close();

    /* the page at phone width, from a deep link */
    const P = await open(PHONE, '/app.html#games/nhl/2026-10-13?status=live');
    await P.page.waitForSelector('#gamesPage .gm-card[data-id]');
    await shot(P.page, 'page-phone');
    chk('phone: a deep link restores sport, date and status', JSON.stringify(await cards(P.page, '#gamesPage')) === JSON.stringify(['nhl:espn:401802001'])
      && await P.page.evaluate(() => document.querySelector('#gamesPage [data-gm-status="live"]').getAttribute('aria-pressed') === 'true'));
    chk('phone: no horizontal page scroll on the games page', await noHScroll(P.page));
    chk('phone: every tap target in the page tools is at least 36 px tall', await P.page.evaluate(() => Array.from(document.querySelectorAll('#gamesPage .gm-pill, #gamesPage .gm-seg button, #gamesPage .gm-db, #gamesPage .gm-go, #gamesPage .gm-more')).every((b) => b.getBoundingClientRect().height >= 35.5)));
    chk('phone: no page error', P.errors.length === 0, P.errors);
    await P.ctx.close();

    /* ── LIVE OVERLAY AND THE READER'S PRICES ───────────────────────── */
    M.live = 'on'; M.markets = 'on';
    const L = await open(DESK, '/app.html');
    await L.page.waitForFunction(() => { const c = document.querySelector('#gamesStrip .gm-card[data-id="nhl:espn:401802001"]'); return c && /3rd 4:10/.test(c.innerText); }, null, { timeout: 15000 });
    chk('the live layer updates the score and clock between builds', /\b3\b/.test(await text(L.page, '#gamesStrip .gm-card[data-id="nhl:espn:401802001"]')));
    chk('a game the live read no longer lists for its day leaves it', (await cards(L.page, '#gamesStrip')).indexOf('nhl:espn:401802004') < 0);
    chk('days and sports the live read did not cover are untouched', (await cards(L.page, '#gamesStrip')).indexOf('mlb:espn:401803002') >= 0);
    await L.page.waitForFunction(() => /FanDuel/.test((document.querySelector('#gamesStrip .gm-card[data-id="cfb:espn:401871067"]') || {}).innerText || ''), null, { timeout: 15000 });
    const cfbP = await text(L.page, '#gamesStrip .gm-card[data-id="cfb:espn:401871067"]');
    chk('a subscriber sees the price capture holds for the game: the favourite\'s spread, the underdog\'s moneyline, one book, oriented to the home team', /FanDuel/.test(cfbP) && /DEL\s+\+170\s+[\s\S]*MTSU\s+−4\.5/.test(cfbP) && /DEL moneyline \+170, MTSU spread −4\.5 \(−110\)/.test(cfbP), cfbP);
    /* a background refresh never moves the reader */
    await L.page.focus('#gamesStrip .gm-card[data-id="nhl:espn:401802002"] a.gm-go');
    M.live = 'none';
    await L.page.evaluate(() => { window.EDGamesUI._state.live = null; window.EDGamesUI.render(); });
    chk('a background re-render keeps keyboard focus on the same card’s link', await L.page.evaluate(() => { const a = document.activeElement; return !!a && a.matches('a.gm-go') && a.closest('[data-id]').getAttribute('data-id') === 'nhl:espn:401802002'; }));
    chk('live overlay and prices: no page error', L.errors.length === 0, L.errors);
    await L.ctx.close();
    M.live = 'none'; M.markets = 'none';

    /* the phone rail keeps its scroll through a refresh */
    M.live = 'on';
    const Rl = await open(PHONE, '/app.html');
    await Rl.page.waitForFunction(() => /3rd 4:10/.test((document.querySelector('#gamesStrip .gm-card[data-id="nhl:espn:401802001"]') || {}).innerText || ''), null, { timeout: 15000 });
    await Rl.page.evaluate(() => { document.querySelector('#gamesStrip .gm-row').scrollLeft = 600; });
    await Rl.page.waitForTimeout(400);
    const railAt = await Rl.page.evaluate(() => document.querySelector('#gamesStrip .gm-row').scrollLeft);
    M.live = 'none';
    await Rl.page.evaluate(() => { window.EDGamesUI._state.live = null; window.EDGamesUI.render(); });
    await Rl.page.waitForTimeout(200);
    const railAfter = await Rl.page.evaluate(() => document.querySelector('#gamesStrip .gm-row').scrollLeft);
    chk('phone: a re-render keeps the rail where the reader scrolled it', railAt > 100 && Math.abs(railAfter - railAt) < 2, { railAt, railAfter });
    await Rl.ctx.close();

    /* prices not installed yet: no database fault on the System health pill */
    M.markets = '404';
    const H4 = await open(DESK, '/app.html');
    await H4.page.waitForSelector('#gamesStrip .gm-card[data-id]');
    await H4.page.waitForFunction(() => window.EDGamesUI._state.mkAt > 0 || window.EDGamesUI._state.mkErr !== null, null, { timeout: 10000 }).catch(() => null);
    chk('a slate_markets() not yet installed is "no prices", never a recorded database fault', H4.seen.markets >= 1 && await H4.page.evaluate(() => !(window.ED_DB && /slate_markets/.test(String(window.ED_DB.where || '')))));
    chk('and the cards still show the slate’s own captured prices', /DraftKings · /.test(await text(H4.page, '#gamesStrip .gm-card[data-id="nhl:espn:401802002"]')));
    await H4.ctx.close();
    M.markets = 'none';

    /* ── FAILURE, THE DEVICE COPY, STALENESS ───────────────────────── */
    M.slate = 'down';
    const X = await open(PHONE, '/app.html');
    await X.page.waitForSelector('#gamesStrip .gm-empty.err');
    const xs = await text(X.page, '#gamesStrip');
    chk('the slate cannot be read and nothing is saved: "Unable to load games", never "no games"', /Unable to load games/.test(xs) && !/No games scheduled/.test(xs), xs.slice(0, 200));
    M.slate = 'ok';
    await X.page.click('#gamesStrip [data-gm-retry]');
    await X.page.waitForSelector('#gamesStrip .gm-card[data-id]');
    chk('Try again recovers when the slate is back', (await cards(X.page, '#gamesStrip')).length > 3);
    M.slate = 'down';
    await X.page.reload();
    await X.page.waitForSelector('#gamesStrip .gm-card[data-id]');
    const xs2 = await text(X.page, '#gamesStrip');
    chk('down again after a good load: the copy saved on this device, labelled as such', /saved on this device/.test(xs2), xs2.slice(-400));
    await X.ctx.close();
    M.slate = 'stale';
    const S2 = await open(DESK, '/app.html#games/all/2026-10-13');
    await S2.page.waitForSelector('#gamesPage .gm-card[data-id]');
    chk('an eight-hour-old slate says so', /Schedule updated 8 h ago \(stale\)/.test(await text(S2.page, '#gamesPage .gm-fresh')));
    await S2.ctx.close();
    M.slate = 'ok';

    /* ── LOCAL MIDNIGHT ────────────────────────────────────────────── */
    const N = await open(DESK, '/app.html', { time: Date.parse('2026-10-14T04:59:00Z') });
    await N.page.waitForSelector('#gamesStrip .gm-card[data-id]');
    const before = await cards(N.page, '#gamesStrip');
    chk('at 11:59 PM the strip is still Tuesday’s', /Tue, Oct 13/i.test(await text(N.page, '#gamesStrip .gm-date')) && before.indexOf('nhl:espn:401802004') >= 0, { date: await text(N.page, '#gamesStrip .gm-date'), before });
    await N.page.clock.fastForward(120000);
    await N.page.waitForFunction(() => /Wed, Oct 14/.test((document.querySelector('#gamesStrip .gm-date') || {}).textContent || ''), null, { timeout: 10000 });
    const after = await cards(N.page, '#gamesStrip');
    chk('two minutes later, past local midnight, Today is Wednesday on its own', after.indexOf('nhl:espn:401802005') >= 0 && after.indexOf('nhl:espn:401802004') < 0, after);
    chk('midnight: no page error', N.errors.length === 0, N.errors);
    await N.ctx.close();

    /* ── THE PUBLIC PAGE ───────────────────────────────────────────── */
    M.board = 'on';
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      const T = await open(vp, '/today/');
      await T.page.waitForSelector('#gamesPage .gm-card[data-id]');
      await shot(T.page, 'today-' + label);
      chk('/today/ ' + label + ': the multi-sport slate renders', (await cards(T.page, '#gamesPage')).length >= 8);
      chk('/today/ ' + label + ': no prices and no EdgeDesk numbers on the public page', await T.page.evaluate(() => !document.querySelector('#gamesPage .gm-mk') && !/Puck line|Run line|Moneyline/.test(document.getElementById('gamesPage').innerText)));
      chk('/today/ ' + label + ': no horizontal page scroll', await noHScroll(T.page));
      chk('/today/ ' + label + ': no page error', T.errors.length === 0, T.errors);
      if (label === 'desktop') {
        chk('/today/: a game with a free article links to it', await T.page.$eval('#gamesPage .gm-card[data-id="cfb:espn:401871067"] a.gm-go', (a) => a.getAttribute('href')) === '/articles/delaware-vs-middle-tennessee-2026/');
        chk('/today/: research that lives in the terminal says so and goes there', await T.page.$eval('#gamesPage .gm-card[data-id="nhl:espn:401802001"] a.gm-go', (a) => a.getAttribute('href') + '|' + a.textContent).then((v) => /^\/app\.html#research\/nhl\/2026020090\|Research in the terminal/.test(v)));
        await T.page.waitForSelector('#gamesPage .gm-pread', { timeout: 10000 }).catch(() => null);
        chk('/today/: the public read rides on its game', /Research|Watch|Pass|Data incomplete/i.test(await text(T.page, '#gamesPage .gm-card[data-id="cfb:espn:401871067"] .gm-pread')));
        chk('/today/: it reads public_home_board, and never the subscriber prices', T.seen.board >= 1 && T.seen.markets === 0);
        chk('/today/: every card ends in the upgrade path, after its research', await T.page.$$eval('#gamesPage .gm-card[data-id]', (cs) => cs.every((c) => { const a = [...c.querySelectorAll('a[data-ed-cta]')].map((x) => x.getAttribute('data-ed-cta')); return a[a.length - 1] === 'today_row_upgrade'; })));
        await T.page.click('#gamesPage [data-gm-date="2026-10-14"]');
        await T.page.waitForFunction(() => location.hash === '#games/all/2026-10-14');
        await T.page.goBack();
        await T.page.waitForFunction(() => /^#games\/all\/2026-10-13/.test(location.hash) && document.querySelector('#gamesPage [data-gm-date="2026-10-13"]').getAttribute('aria-pressed') === 'true', null, { timeout: 5000 }).catch(() => null);
        chk('/today/: Back after picking a date returns to the day before (the page follows its own hash)', await T.page.evaluate(() => document.querySelector('#gamesPage [data-gm-date="2026-10-13"]').getAttribute('aria-pressed') === 'true'));
      }
      await T.ctx.close();
    }
    M.board = 'none';

    /* ── THE TERMINAL STILL WORKS ──────────────────────────────────── */
    const A = await open(DESK, '/app.html');
    await A.page.waitForSelector('#gamesStrip .gm-card[data-id]');
    await A.page.click('.bottomnav button[data-v="portfolio"]');
    chk('the bottom navigation still moves to Portfolio', await A.page.evaluate(() => !document.getElementById('v-portfolio').classList.contains('hide') && document.getElementById('v-games').classList.contains('hide')));
    await A.page.click('.bottomnav button[data-v="research"]');
    chk('and back to Research, with the strip', await A.page.evaluate(() => !document.getElementById('v-research').classList.contains('hide') && !!document.querySelector('#gamesStrip .gm-card')));
    await A.page.goto(base + '/app.html#research/football');
    await A.page.waitForSelector('#v-football:not(.hide)');
    chk('a #research deep link still lands on its panel', true);
    chk('the subscription read still answers active (the strip does not touch the paywall)', await A.page.evaluate(() => !document.getElementById('payGate').classList.contains('open')));
    chk('terminal: no page error', A.errors.length === 0, A.errors);
    await A.ctx.close();
  } catch (e) {
    chk('the run completed', false, String(e && e.stack || e).slice(0, 600));
  } finally {
    await browser.close();
    srv.close();
  }
  done();
})();
