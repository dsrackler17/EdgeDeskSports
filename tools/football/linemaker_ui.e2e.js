#!/usr/bin/env node
/* ===========================================================================
   The Fair Lines panel in a real Chromium (app.html, Research → Other →
   Lines), desktop and a 390 px phone, against a feed built by the real
   builder (tools/football/build_fair_lines.js) from the committed slates
   with a pinned clock.

   Every control is exercised: the league switch, the team search, the sort,
   opening a game (and the URL it writes), the four ladder tabs, the price
   check (a THIN, a NO VALUE and a VALUE), the multi-book comparison and its
   clear, the accountability section, Ask EdgeDesk, Back. Then the states:
   the feed failing and coming back on Try again, a feed that fails its
   integrity check, an empty slate, and a stale build. No page error and no
   horizontal page scroll at either width.

   Run: node tools/football/linemaker_ui.e2e.js [--shots DIR]
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const BFL = require(path.join(__dirname, 'build_fair_lines.js'));
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'fair lines UI — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* the feed: the real builder over the committed slates, clock pinned to the
   NFL slate's build time so every committed game is still pregame */
const nflSlate = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'slate.json'), 'utf8'));
const NOW = new Date(Date.parse(nflSlate.generated_at) + 60000).toISOString();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lmui-'));
const FEED = BFL.build({ now: NOW, out: tmp, noLedger: true }).out;
fs.rmSync(tmp, { recursive: true, force: true });
const NFL_N = FEED.games.filter((g) => g.league === 'NFL').length, CFB_N = FEED.games.filter((g) => g.league === 'CFB').length;

(async function main() {
  if (NFL_N < 2 || CFB_N < 2) done('SKIP | the committed slates carry too few pregame games at ' + NOW + ' to exercise the panel');
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  let feedMode = 'ok';
  const feedBody = () => {
    if (feedMode === 'ok') return JSON.stringify(FEED);
    if (feedMode === 'stale') return JSON.stringify(Object.assign({}, FEED, { generated_at: new Date(Date.parse(NOW) - 40 * 36e5).toISOString() }));
    if (feedMode === 'empty') return JSON.stringify(Object.assign({}, FEED, { games: [], counts: { games: 0, nfl: 0, cfb: 0, refused: 0 } }));
    if (feedMode === 'bad') return JSON.stringify({ schema: 'something_else' });
    return null;
  };
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p === '/football/linemaker/fair_lines.json') {
      if (feedMode === 'down') { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('unavailable'); return; }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(feedBody()); return;
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
    const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
    if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe });
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
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const cards = (page) => page.evaluate(() => document.querySelectorAll('#linesHost .lm-card').length);

  try {
    for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      console.log(label);
      const { ctx, page, errors } = await open(vp, '#research/lines');
      await page.waitForSelector('#linesHost .lm-card', { timeout: 20000 });
      chk(label + ': #research/lines opens the Lines panel inside Research', await page.evaluate(() => !document.getElementById('v-lines').classList.contains('hide') && !document.getElementById('v-research').classList.contains('hide')));
      chk(label + ': the Other seat names Lines while it is open', await page.evaluate(() => document.getElementById('rsOtherLbl').textContent === 'Lines' && document.querySelector('#rsOther button[data-sub="lines"]').classList.contains('on')));
      chk(label + ': the header and the build time', await page.evaluate(() => /Fair lines/.test(document.querySelector('.lm-title').textContent) && /Built/.test(document.querySelector('.lm-upd').textContent)));
      chk(label + ': NFL lists every priced NFL game', (await cards(page)) === NFL_N, [await cards(page), NFL_N]);
      chk(label + ': every card carries a calibration chip', await page.evaluate(() => Array.from(document.querySelectorAll('.lm-card')).every((c) => c.querySelector('.lm-chip'))));
      chk(label + ': no stale banner on a fresh build', await page.evaluate(() => !document.querySelector('.lm-banner.warn')));
      await page.click('.lm-seg button[data-league="CFB"]');
      chk(label + ': CFB lists every priced FBS game', (await cards(page)) === CFB_N, [await cards(page), CFB_N]);
      const team = FEED.games.find((g) => g.league === 'CFB').home;
      await page.fill('#lmSearch', team);
      const found = await page.evaluate(() => Array.from(document.querySelectorAll('.lm-card .lm-mu')).map((x) => x.textContent));
      chk(label + ': search narrows to games with that team', found.length >= 1 && found.length < CFB_N && found.every((t) => t.indexOf(team) >= 0), found);
      await page.fill('#lmSearch', 'zzzz no such team');
      chk(label + ': a search with no match says so', await page.evaluate(() => /No CFB game matches/.test(document.querySelector('.lm-empty').textContent)));
      await page.fill('#lmSearch', '');
      await page.click('.lm-seg button[data-league="NFL"]');
      await page.selectOption('#lmSort', 'gap');
      const gaps = await page.evaluate(() => Array.from(document.querySelectorAll('.lm-card')).map((c) => { const g = EDLinemakerUI._state.data.games.find((x) => x.game_id === c.dataset.game); const s = g.reference_versus && g.reference_versus.spread; return s ? Math.abs(s.gap_points) : -1; }));
      chk(label + ': sorting by gap orders the largest reference gap first', gaps.every((x, i) => i === 0 || gaps[i - 1] >= x), gaps);
      chk(label + ': no horizontal page scroll on the list', await noHScroll(page));
      await shot(page, label + '_list');
      /* open a game */
      const gid = await page.evaluate(() => document.querySelector('.lm-card').dataset.game);
      await page.click('.lm-card');
      await page.waitForSelector('.lm-tab.main');
      chk(label + ': opening a game writes its URL', await page.evaluate(() => location.hash) === '#research/lines/' + gid);
      const mainRows = await page.evaluate(() => Array.from(document.querySelectorAll('.lm-tab.main tbody tr td:first-child')).map((x) => x.textContent));
      chk(label + ': the sheet shows spread, moneyline, total and team totals', JSON.stringify(mainRows) === JSON.stringify(['Spread', 'Moneyline', 'Total', 'Team totals']), mainRows);
      chk(label + ': each market says calibration and vs-close separately', await page.evaluate(() => Array.from(document.querySelectorAll('.lm-tab.main tbody tr')).every((r) => r.querySelector('.lm-chip:not(.tier)') && r.querySelector('.lm-chip.tier'))));
      for (const tab of ['spread', 'total', 'away_team_total', 'home_team_total']) {
        await page.click('.lm-tabs button[data-tab="' + tab + '"]');
        const st = await page.evaluate(() => ({ rows: document.querySelectorAll('#lmLadder tbody tr').length, fair: document.querySelectorAll('#lmLadder tr.fair').length }));
        chk(label + ': the ' + tab + ' ladder renders with the fair number marked', st.rows >= 15 && st.fair === 1, st);
      }
      chk(label + ': no horizontal page scroll on the sheet (tables scroll in their own box)', await noHScroll(page));
      await shot(page, label + '_sheet');
      /* price check: THIN at -110 a few points better than fair, NO_VALUE on the other side, VALUE at +250 */
      const fairHalf = await page.evaluate((id) => EDLinemakerUI._state.data.games.find((x) => x.game_id === id).markets.spread.fair_home_line_half, gid);
      await page.selectOption('#lmMk', 'spread');
      await page.selectOption('#lmSide', 'home');
      await page.fill('#lmLine', String(fairHalf + 4));
      await page.fill('#lmOdds', '-110');
      await page.fill('#lmOther', '-110');
      await page.click('button[data-act="check"]');
      const v1 = await page.evaluate(() => ({ v: document.querySelector('.lm-verdict').textContent, t: document.querySelector('#lmResult').textContent }));
      chk(label + ': four points better than fair at -110 is THIN, with the held-out reason', v1.v === 'THIN' && /market posted|provisional/.test(v1.t), v1);
      chk(label + ': the no-vig split of the two prices is shown', /No-vig market/.test(v1.t) && /50%/.test(v1.t), v1.t.slice(0, 300));
      await page.click('button[data-act="add"]');
      await page.selectOption('#lmSide', 'away');
      await page.fill('#lmLine', String(-(fairHalf + 4)));
      await page.click('button[data-act="check"]');
      chk(label + ': the other side of that number is NO VALUE', await page.evaluate(() => document.querySelector('.lm-verdict').textContent) === 'NO VALUE');
      await page.click('button[data-act="add"]');
      await page.selectOption('#lmSide', 'home');
      await page.fill('#lmLine', String(fairHalf + 4));
      await page.fill('#lmOdds', '250');
      await page.fill('#lmOther', '');
      await page.fill('#lmBook', 'TestBook');
      await page.click('button[data-act="check"]');
      const v3 = await page.evaluate(() => document.querySelector('.lm-verdict').textContent);
      chk(label + ': a real mispricing (+250 on EdgeDesk’s favourite) is VALUE', v3 === 'VALUE', v3);
      await page.click('button[data-act="add"]');
      const cmp = await page.evaluate(() => document.querySelector('.lm-cmp').textContent);
      chk(label + ': the comparison ranks three quotes and says how many clear', /1 of 3 clears/.test(cmp) && /TestBook/.test(cmp), cmp.slice(0, 200));
      await page.click('button[data-act="clear"]');
      chk(label + ': clear empties the comparison', await page.evaluate(() => document.getElementById('lmCompare').textContent === ''));
      await page.selectOption('#lmMk', 'tt_home');
      chk(label + ': a team total offers over and under and prefills the fair number', await page.evaluate(() => Array.from(document.querySelectorAll('#lmSide option')).map((o) => o.value).join() === 'over,under' && Number(document.getElementById('lmLine').value) > 0));
      await page.fill('#lmOdds', '400');
      await page.click('button[data-act="check"]');
      chk(label + ': a team total is never VALUE (never tested at a market number)', await page.evaluate(() => document.querySelector('.lm-verdict').textContent) !== 'VALUE');
      await page.selectOption('#lmMk', 'moneyline');
      chk(label + ': a moneyline hides the line field', await page.evaluate(() => document.getElementById('lmLineL').classList.contains('hide')));
      await page.fill('#lmOdds', '50');
      await page.click('button[data-act="check"]');
      chk(label + ': an invalid price cannot be evaluated', await page.evaluate(() => document.querySelector('.lm-verdict').textContent) === 'CANNOT EVALUATE');
      /* accountability */
      await page.click('#lmAcc > summary');
      await page.waitForFunction(() => document.querySelectorAll('#lmAccBody .lm-tab tbody tr').length === 4, null, { timeout: 15000 });
      chk(label + ': the held-out record lists the four markets with their at-market slope', await page.evaluate(() => /slope|never tested/.test(document.getElementById('lmAccBody').textContent)));
      await shot(page, label + '_check');
      /* ask the desk */
      await page.click('button[data-act="ask"]');
      chk(label + ': Ask EdgeDesk opens the desk', await page.evaluate(() => document.getElementById('edaiPanel').classList.contains('open')));
      await page.evaluate(() => { try { EDAI.close && EDAI.close(); } catch (e) { /* closed */ } });
      await page.evaluate(() => { const s = document.getElementById('edaiScrim'); const p = document.getElementById('edaiPanel'); if (s) s.classList.remove('open'); if (p) p.classList.remove('open'); });
      await page.click('button[data-act="back"]');
      chk(label + ': Back returns to the list', (await cards(page)) > 0 && await page.evaluate(() => location.hash) === '#research/lines');
      chk(label + ': no page error', errors.length === 0, errors);
      await ctx.close();
    }

    /* ---------------------------------------------------------- states */
    console.log('states');
    feedMode = 'down';
    let { ctx, page, errors } = await open({ width: 1024, height: 800 }, '#research/lines');
    await page.waitForSelector('.lm-banner.err', { timeout: 15000 });
    chk('a feed that fails says so, with nothing shown in its place', await page.evaluate(() => /could not be loaded/.test(document.querySelector('.lm-banner.err').textContent) && !document.querySelector('.lm-card')));
    feedMode = 'ok';
    await page.click('button[data-act="retry"]');
    await page.waitForSelector('.lm-card', { timeout: 15000 });
    chk('Try again recovers when the feed is back', (await cards(page)) === NFL_N);
    await ctx.close();
    feedMode = 'bad';
    ({ ctx, page, errors } = await open({ width: 1024, height: 800 }, '#research/lines'));
    await page.waitForSelector('.lm-banner.err', { timeout: 15000 });
    chk('a feed that fails its integrity check is refused, not half-rendered', await page.evaluate(() => /unavailable/.test(document.querySelector('.lm-banner.err').textContent) && !document.querySelector('.lm-card')));
    await ctx.close();
    feedMode = 'empty';
    ({ ctx, page, errors } = await open({ width: 1024, height: 800 }, '#research/lines'));
    await page.waitForSelector('.lm-empty', { timeout: 15000 });
    chk('an empty slate is a plain empty state', await page.evaluate(() => /No upcoming NFL game is priced/.test(document.querySelector('.lm-empty').textContent)));
    await ctx.close();
    feedMode = 'stale';
    ({ ctx, page, errors } = await open({ width: 1024, height: 800 }, '#research/lines'));
    await page.waitForSelector('.lm-card', { timeout: 15000 });
    chk('a 40-hour-old build carries the stale banner', await page.evaluate(() => /Stale/.test((document.querySelector('.lm-banner.warn') || {}).textContent || '')));
    chk('and no page error in any state', errors.length === 0, errors);
    await ctx.close();
    /* a deep link straight to a game */
    feedMode = 'ok';
    const deep = FEED.games.find((g) => g.league === 'CFB');
    ({ ctx, page, errors } = await open({ width: 1024, height: 800 }, '#research/lines/' + deep.game_id));
    await page.waitForSelector('.lm-tab.main', { timeout: 20000 });
    chk('a deep link opens that game’s sheet directly', await page.evaluate((h) => document.querySelector('.lm-dhead .lm-mu').textContent.indexOf(h) >= 0, deep.home));
    await ctx.close();
  } catch (e) {
    chk('unexpected error: ' + String(e && e.stack || e).slice(0, 400), false);
  } finally {
    await browser.close();
    srv.close();
  }
  done();
})();
