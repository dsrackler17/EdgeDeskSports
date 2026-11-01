#!/usr/bin/env node
/* ===========================================================================
   PREDICTION RADAR IN A REAL BROWSER — Chromium at a 390 px phone and a
   1280 px desktop, the database doors stubbed (no database, no Polymarket):

     overview   the terminal's Overview: Smart Money Tonight is the FIRST thing
                on it, each card leads with its sentence, the Experimental and
                High-conviction labels are words; tapping a bettor opens the
                trader sheet (Polygonscan links, open positions for a
                subscriber); Escape closes it; read under the reader's own token
     off        Radar off: the Overview draws no Radar section at all
     public     /radar/ with no login: "not live" while off; live, the graded
                leaderboard with the score's parts and the Small sample label,
                the side-less teaser, a trader page by its link, the Known
                limitations; only anonymous doors asked, never radar_tonight
   No page error and no horizontal page scroll anywhere.

   Needs Playwright with Chromium; prints SKIPPED and exits 0 without one,
   except under RADAR_E2E_REQUIRED=1 (CI), where a missing browser fails.
   Run:  node tools/radar/radar_ui.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }
function done(note) {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  if (note) console.log(note);
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'radar UI (browser) — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* what the doors answer, as supabase/radar.sql shapes them */
const T1 = '0x' + '1'.repeat(40), T2 = '0x' + '2'.repeat(40);
const TX1 = '0x' + 'a'.repeat(64), TX2 = '0x' + 'b'.repeat(64);
const START = new Date(Date.now() + 3 * 3600e3).toISOString();
const CARDS = [
  { event_id: 'E1', sport_key: 'americanfootball_nfl', condition_id: '0x' + '9'.repeat(64), market_type: 'spreads', outcome: 'Chiefs', selection: 'Kansas City Chiefs', point: -3,
    home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', commence_time: START, n_wallets: 7, dollars: 84210, avg_entry: 0.4144, current_price: 0.6,
    moved: 0.1856, has_moved: true, fair: 0.62, fair_current: true, agrees: true, other_side_wallets: 1, other_side_dollars: 60, high_conviction: 1,
    wallets: [{ wallet: T1, display: 'SharpAlice', rank: 2, cost: 40000, avg_price: 0.4, conviction: 4, high_conviction: true },
      { wallet: T2, display: '0x2222…2222', rank: 3, cost: 22000, avg_price: 0.44, conviction: 1.1, high_conviction: false }] },
  { event_id: 'E2', sport_key: 'americanfootball_nfl', condition_id: '0x' + '8'.repeat(64), market_type: 'moneyline', outcome: 'Dolphins', selection: 'Miami Dolphins', point: null,
    home_team: 'Buffalo Bills', away_team: 'Miami Dolphins', commence_time: START, n_wallets: 2, dollars: 9400, avg_entry: 0.47, current_price: 0.5, moved: 0.03, has_moved: true,
    fair: 0.45, fair_current: false, agrees: null, other_side_wallets: 0, other_side_dollars: null, high_conviction: 0, wallets: [{ wallet: T1, display: 'SharpAlice', rank: 2, cost: 9400, avg_price: 0.47 }] }
];
const GRADE = { wallet: T1, display: 'SharpAlice', rank: 2, style: 'Directional', sample: 'ranked', graded_bets: 120, wins: 70, losses: 48, pushes: 2, roi: 0.061, clv_pp: 2.1,
  follow5_roi: 0.034, follow15_roi: 0.02, radar_score: 3.12, score_parts: { follow_roi: 0.024, clv_pct: 0.031, roi: 0.042 } };
const HISTORY = [{ question: 'Chiefs vs. Raiders', market_type: 'moneyline', outcome: 'Chiefs', game_start_at: '2026-10-12T17:00:00Z', entry_price: 0.42, stake: 250, follow5_price: 0.44,
  close_price: 0.47, clv_pp: 5, result: 'win', profit: 345, entry_tx: TX1, txs: [TX1, TX2] }];
const M = { enabled: true, sub: true };
function door(name) {
  if (name === 'radar_status') return { enabled: M.enabled, registered: true, status: 'EXPERIMENTAL', access: M.sub ? 'subscriber' : 'public', min_graded: 50, top_wallets: 25, graded_at: '2026-10-29T10:20:00Z',
    h_radar_01: { status: 'complete', passed: false, beat_close_rate: 0.512, follow_roi: -0.021, followed: 340 } };
  if (!M.enabled) return { status: 'disabled', rows: [], cards: [] };
  /* as H-RADAR-02's door answers: the featured cards, how many qualify, observed activity apart, how discovery stands */
  if (name === 'radar_tonight') return M.sub ? { status: 'ok', hypothesis: 'H-RADAR-02', top_wallets: 10, featured: 3, conviction_high_x: 3, graded_at: '2026-10-29T10:20:00Z', cards: CARDS,
    observed: [{ kind: 'observed', event_id: 'E9', market_type: 'spreads', home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', commence_time: '2026-11-01T20:25:00Z', n_wallets: 12,
      sides: [{ outcome: 'Chiefs', selection: 'Kansas City Chiefs', point: -3, n_wallets: 8, dollars: 52000 }, { outcome: 'Raiders', selection: 'Las Vegas Raiders', point: 3, n_wallets: 4, dollars: 18000 }] }],
    discovery: { candidates: 1000, screened: 240, flagged: 90, sampled: 90, high_frequency: 60, insufficient_history: 12, fully_evaluated: 150, eligible: 140, pool: 140 } } : { status: 'subscribers_only', cards: [] };
  if (name === 'radar_leaderboard') return { status: 'ok', min_graded: 50, rows: [GRADE, Object.assign({}, GRADE, { wallet: T2, display: '0x2222…2222', rank: null, sample: 'small_sample', graded_bets: 12, radar_score: null, score_parts: null })] };
  if (name === 'radar_trader') return { status: 'ok', access: M.sub ? 'subscriber' : 'public', min_graded: 50, grade: GRADE, history: HISTORY,
    positions: M.sub ? [{ question: 'Chiefs vs. Raiders spread', outcome: 'Chiefs', cost: 40000, avg_price: 0.4, game_start_at: START }] : null, positions_locked: !M.sub };
  if (name === 'radar_record') return M.sub ? { status: 'ok', label: 'EXPERIMENTAL', small_sample: true, min_sample: 200,
    totals: { cards: 14, graded: 11, wins: 6, losses: 5, pushes: 0, void: 1, roi: -0.0312, beat_close_rate: 0.5455, with_close: 11, no_close: 0, pending: 2 },
    h_radar_01: { status: 'complete', passed: false, followed: 340, beat_close_rate: 0.512, beat_close_ci: [0.47, 0.55], follow_roi: -0.021, follow_roi_ci: [-0.08, 0.04] },
    recent: [{ commence_time: '2026-10-28T00:15:00Z', home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', market_type: 'moneyline', outcome: 'Chiefs', follow_price: 0.6, close_price: 0.64, result: 'win', roi: 0.6667 }] }
    : { status: 'subscribers_only' };
  if (name === 'radar_teaser') return { status: 'ok', hypothesis: 'H-RADAR-02', games: 2, card: { sport_key: 'americanfootball_nfl', home_team: 'Las Vegas Raiders', away_team: 'Kansas City Chiefs', commence_time: START, n_wallets: 7, dollars: 84200 } };
  return null;
}

(async function main() {
  let pw = null;
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright', '/opt/node-tools/node_modules/playwright']) { try { pw = require(p); break; } catch (_) { /* next */ } }
  const REQUIRED = process.env.RADAR_E2E_REQUIRED === '1';
  if (!pw) { console.log((REQUIRED ? 'FAILED: RADAR_E2E_REQUIRED is set and ' : 'SKIPPED: ') + 'playwright is not installed here (not verified)'); process.exit(REQUIRED ? 1 : 0); }
  function siteHandler(req, res) {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/app.html';
    if (p.endsWith('/')) p += 'index.html';
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
    else { console.log((REQUIRED ? 'FAILED: RADAR_E2E_REQUIRED is set and there is ' : 'SKIPPED: ') + 'no Chromium (not verified)'); srv.close(); process.exit(REQUIRED ? 1 : 0); }
  }
  async function open(viewport, url, o) {
    o = o || {};
    const ctx = await browser.newContext({ viewport, timezoneId: 'America/New_York', locale: 'en-US' });
    if (o.signedIn) await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test' } }));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ done: true }));
        localStorage.setItem('edgedesk_setup_v1', JSON.stringify({ done: true, at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        localStorage.setItem('edgedesk_prefs', JSON.stringify({ lastTab: 'overview', rememberTab: true }));
      } catch (e) { /* storage */ }
    });
    const seen = { doors: [], auth: [] };
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (/supabase\.co/.test(u)) {
        const m = /rpc\/(radar_[a-z_]+)/.exec(u);
        if (m) {
          seen.doors.push(m[1]); seen.auth.push(route.request().headers().authorization || '');
          const b = door(m[1]);
          return b ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }) : route.fulfill({ status: 404, contentType: 'application/json', body: '{"code":"PGRST202"}' });
        }
        if (/subscriptions/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]) });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
    await page.goto(base + url, { waitUntil: 'load' });
    return { ctx, page, errors, seen };
  }
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
  const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const PHONE = { width: 390, height: 844 }, DESK = { width: 1280, height: 900 };
  try {
    /* ── the terminal's Overview ───────────────────────────────────────── */
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      M.enabled = true; M.sub = true;
      const O = await open(vp, '/app.html#overview', { signedIn: true });
      await O.page.waitForSelector('#ovRadar .rd-card', { timeout: 30000 }).catch(() => {});
      /* the cards lead; the method, observed activity and each card's detail fold away (docs/research-compare/README.md) */
      const collapsed = await text(O.page, '#ovRadar');
      chk('overview ' + label + ': folded, the cards come before the method and the observed activity', collapsed.indexOf('featured bettors, $84K') >= 0 && collapsed.indexOf('featured bettors, $84K') < collapsed.indexOf('How Smart Money Tonight works')
        && collapsed.indexOf('featured bettors, $84K') < collapsed.indexOf('Observed activity'), collapsed.slice(0, 600));
      await O.page.$$eval('#ovRadar details', (ds) => ds.forEach((d) => { d.open = true; }));
      const s = await text(O.page, '#ovRadar');
      chk('overview ' + label + ': Smart Money Tonight is drawn, labelled Experimental in words', /Smart Money Tonight/.test(s) && /Experimental/.test(s), s.slice(0, 300));
      chk('overview ' + label + ': it is the first thing on the Overview', await O.page.evaluate(() => { const w = document.querySelector('#overviewHost .ovw'); return !!w && w.firstElementChild && w.firstElementChild.id === 'ovRadar'; }));
      const heads = await O.page.$$eval('#ovRadar .rd-sent', (h) => h.map((x) => x.innerText));
      chk('overview ' + label + ': each card leads with its sentence (H-RADAR-02: the featured bettors)', heads[0] === '7 featured bettors, $84K, on Chiefs -3' && heads[1] === '2 featured bettors, $9.4K, on Dolphins', heads);
      chk('overview ' + label + ': how many qualify, observed activity apart and labelled, how discovery stands', /3 bettors qualify to be featured today/.test(s) && /Observed activity/.test(s) && /Observed, not a signal/.test(s)
        && /Radar has screened 240 wallets/.test(s), s.slice(0, 600));
      chk('overview ' + label + ': the numbers under it: the historical entry apart, the price by kind, the status in words', /avg entry 41\.4¢ \(historical\)/.test(s) && /Displayed price, not an ask/.test(s)
        && /Comparable model unavailable/.test(s) && !/Smart money agrees/.test(s), s);
      chk('overview ' + label + ': the Pinnacle number is a reference, never "EdgeDesk fair"', /Pinnacle de-vigged reference/.test(s) && !/EdgeDesk fair/.test(s), s);
      chk('overview ' + label + ': the conviction label is a word', /High conviction/.test(s) && /4× usual size/.test(s));
      await O.page.waitForSelector('#ovRadar .rd-rec', { timeout: 10000 }).catch(() => {});
      const rec = await text(O.page, '#ovRadar .rd-rec');
      chk('overview ' + label + ': "How following has done" under the cards, Experimental and a small sample in words', /How following has done/.test(rec) && /Experimental/.test(rec) && /Small sample: 11 of 200 graded/.test(rec), rec.slice(0, 300));
      chk('overview ' + label + ': the record\'s own numbers and what H-RADAR-01 found', /6–5/.test(rec) && /−3\.1%/.test(rec) && /did not pass its criteria/.test(rec), rec);
      chk('overview ' + label + ': read under the reader\'s own token', O.seen.doors.includes('radar_tonight') && O.seen.auth.every((a) => a === 'Bearer e2e'), O.seen);
      chk('overview ' + label + ': no horizontal page scroll', await noHScroll(O.page));
      await shot(O.page, 'overview-' + label);
      if (SHOTS) { const el = await O.page.$('#ovRadar'); if (el) await el.screenshot({ path: path.join(SHOTS, 'smart-money-' + label + '.png') }); }
      await O.page.click('#ovRadar .rd-card [data-radar-wallet="' + T1 + '"]');
      await O.page.waitForSelector('#rdSheet .rd-trader', { timeout: 10000 }).catch(() => {});
      const t = await text(O.page, '#rdSheet');
      chk('overview ' + label + ': tapping a bettor opens the trader page: record, ROI, CLV, follow ROI, style', /SharpAlice/.test(t) && /70–48–2/.test(t) && /Follow ROI, 5 min/.test(t) && /Directional/.test(t), t.slice(0, 400));
      chk('overview ' + label + ': the score with its parts', /Radar Score\s*Experimental\s*3\.12/.test(t) && /0\.5 × follow ROI/.test(t));
      chk('overview ' + label + ': a subscriber sees the open positions', /Chiefs vs\. Raiders spread/.test(t));
      chk('overview ' + label + ': each trade links to Polygonscan', (await O.page.$$eval('#rdSheet a[href^="https://polygonscan.com/tx/"]', (a) => a.length)) === 2);
      chk('overview ' + label + ': the sheet does not scroll the page sideways', await noHScroll(O.page));
      await shot(O.page, 'trader-sheet-' + label);
      await O.page.keyboard.press('Escape');
      chk('overview ' + label + ': Escape closes it', (await O.page.$('#rdSheet')) === null);
      chk('overview ' + label + ': no page error', O.errors.length === 0, O.errors);
      await O.ctx.close();
    }
    M.enabled = false;
    const off = await open(DESK, '/app.html#overview', { signedIn: true });
    await off.page.waitForSelector('#overviewHost .ovw', { timeout: 30000 }).catch(() => {});
    await off.page.waitForTimeout(800);
    chk('off: the Overview draws no Radar section at all', (await text(off.page, '#ovRadar')) === '' && !(await off.page.$('#ovRadar .rd-sec')));
    chk('off: no page error', off.errors.length === 0, off.errors);
    await off.ctx.close();

    /* ── the public page ───────────────────────────────────────────────── */
    M.enabled = false; M.sub = false;
    const P0 = await open(PHONE, '/radar/');
    await P0.page.waitForFunction(() => !/Loading/.test(document.getElementById('rpState').innerText), null, { timeout: 15000 }).catch(() => {});
    chk('public off: "not live", nothing invented', /not live yet/.test(await text(P0.page, '#rpState')) && !(await P0.page.$('#rpLeaders table')));
    chk('public off: the Known limitations are still there', /Known limitations/.test(await text(P0.page, '#rpLimits')));
    await P0.ctx.close();
    M.enabled = true;
    for (const [label, vp] of [['phone', PHONE], ['desktop', DESK]]) {
      const P = await open(vp, '/radar/');
      await P.page.waitForSelector('#rpLeaders table', { timeout: 15000 }).catch(() => {});
      const st = await text(P.page, '#rpState'), lb = await text(P.page, '#rpLeaders'), tz = await text(P.page, '#rpTeaser');
      chk('public ' + label + ': live, and H-RADAR-01\'s finding as recorded (here: did not pass)', /Live\./.test(st) && /did not pass/.test(st) && /51\.2%/.test(st), st);
      chk('public ' + label + ': the leaderboard with the score\'s parts and the Small sample label', /SharpAlice/.test(lb) && /0\.5 × follow ROI/.test(lb) && /Small sample/.test(lb), lb.slice(0, 400));
      chk('public ' + label + ': the teaser gives the game, the count and the dollars, never the side', /7 featured bettors, \$84K, on/.test(tz) && !/Chiefs -3/.test(tz) && /in the terminal/.test(tz), tz);
      chk('public ' + label + ': only anonymous doors, never radar_tonight or the record, all with the anon key', !P.seen.doors.includes('radar_tonight') && !P.seen.doors.includes('radar_record') && P.seen.doors.every((d) => ['radar_status', 'radar_leaderboard', 'radar_teaser', 'radar_trader'].includes(d))
        && P.seen.auth.every((a) => /^Bearer eyJ/.test(a)), P.seen.doors);
      chk('public ' + label + ': no horizontal page scroll', await noHScroll(P.page));
      await shot(P.page, 'public-' + label);
      await P.page.click('#rpLeaders [data-radar-wallet="' + T1 + '"]');
      await P.page.waitForSelector('#rpTrader .rd-trader', { timeout: 10000 }).catch(() => {});
      const tr = await text(P.page, '#rpTrader');
      chk('public ' + label + ': a trader page by its link, with Polygonscan links', /#trader\/0x1{40}$/.test(P.page.url()) && (await P.page.$$eval('#rpTrader a[href^="https://polygonscan.com/tx/"]', (a) => a.length)) === 2, tr.slice(0, 300));
      chk('public ' + label + ': open positions are the terminal\'s', /are in the Research Terminal/.test(tr) && !/Chiefs vs\. Raiders spread/.test(tr));
      chk('public ' + label + ': the trader page fits the screen', await noHScroll(P.page));
      await shot(P.page, 'public-trader-' + label);
      chk('public ' + label + ': no page error', P.errors.length === 0, P.errors);
      await P.ctx.close();
    }
  } catch (e) {
    chk('the suite ran to the end', false, String(e && e.stack || e).slice(0, 800));
  } finally {
    await browser.close();
    srv.close();
  }
  done();
})();
