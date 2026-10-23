/// <reference lib="dom" />
/* ===========================================================================
   College basketball in the Simulator seat, in a real browser (Playwright +
   Chromium) over the real app.html. Supabase is intercepted; every row is
   SYNTHETIC (invented games and numbers shaped as the ncaam_fc_* views
   return them). Nothing about the sport registry is overridden: NCAAM is
   BLOCKED for the tournament in the repository, and the forecast tabs work
   regardless.
     node simulator/tests/ncaam_ui.e2e.ts [--shots DIR]
   Skips (exit 0) without Playwright; NCAAM_E2E_REQUIRED=1 makes that a failure.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/ncaam/inputs.ts';

const require = createRequire(import.meta.url);
const T = kit('College basketball seat (browser)');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
let pw: any = null;
try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (_) { pw = null; } }
const skip = (why: string) => { console.log((process.env.NCAAM_E2E_REQUIRED === '1' ? 'FAILED: ' : 'SKIPPED: ') + why); process.exit(process.env.NCAAM_E2E_REQUIRED === '1' ? 1 : 0); };
if (!pw) skip('playwright is not installed here');

const EVIL = '<img src=x onerror="window.__xss=1">';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const fc = (i: number, o: any = {}) => Object.assign({ game_id: String(401900000 + i), start_utc: iso(now + (2 + i) * 3600e3), home_id: String(100 + i), away_id: String(200 + i), home_name: 'Home ' + i, away_name: 'Away ' + i,
  neutral: i % 4 === 0, event: 'regular', regime: 'D1_D1', available: true, unavailable_reason: null, p_home: 0.5 + 0.04 * (i % 10), p_ot: 0.058, margin: { mean: 3, sd: 11.4, q10: -11, q90: 17 }, total: { mean: 142, sd: 15, q10: 123, q90: 161 },
  pts_home: 72.5, pts_away: 69.5, games_played: { home: 2, away: 2 }, data_quality: ['EARLY_SEASON_FEW_GAMES'], availability_assumption: 'not modelled', provenance: 'Research', underdog: 'away', basis: 'model',
  p_underdog: 0.5 - 0.04 * (i % 10), signals: i % 10 >= 1 && i % 10 <= 3 ? ['upset_probability', 'high_uncertainty'] : i % 10 === 0 ? ['toss_up', 'high_uncertainty'] : ['high_uncertainty'], p_market_underdog: null, disagreement: null,
  factors: { three_point_volume: 0.41, pace: 68.2 }, model_key: 'ncaam_adjeff@1.0.0', as_of: iso(now - 3600e3), upset_policy: { version: 1, theta: 0.37 }, published_at: iso(now - 3000e3) }, o);
const FORECASTS = Array.from({ length: 24 }, (_, i) => fc(i)).concat([fc(30, { available: false, unavailable_reason: 'neither team is a rated Division I team', p_home: null, p_ot: null, margin: null, total: null, underdog: null, signals: [] })]);
const STATUS = { champion_key: 'ncaam_adjeff@1.0.0', champion_since: iso(now - 20 * 864e5), champion_decision: 'PROMOTE', last_weekly_decision: 'RETAIN', last_weekly_at: iso(now - 2 * 864e5),
  published_run_id: 'aaaaaaaa-0000-0000-0000-000000000001', published_as_of: iso(now - 3600e3), published_at: iso(now - 3000e3), last_attempt_status: 'completed', last_attempt_at: iso(now - 3000e3), live_enabled: false };
const HEALTH = [{ model_key: 'ncaam_adjeff@1.0.0', since: STATUS.champion_since, champion_decision: 'PROMOTE', recent_reports: [
  { candidate: 'carry_higher', challenger: 'ncaam_adjeff@1.1.0', decision: 'RETAIN', created_at: iso(now - 2 * 864e5), gates: [{ id: 'G2_log_loss', pass: false, detail: 'difference -0.00004, interval spans 0' }], summary: { challenger: { log_loss: 0.5357, slope: 1.05, margin_c80: 0.801 } } },
  { candidate: 'selection_v1', challenger: 'ncaam_adjeff@1.0.0', decision: 'PROMOTE', created_at: STATUS.champion_since, gates: [], summary: { challenger: { log_loss: 0.5357, slope: 1.06, margin_c80: 0.801 } } }] }];
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

(async () => {
  const srv: http.Server = await new Promise((resolve) => { const s = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url).split('?')[0]); if (p === '/') p = '/app.html';
    const file = path.join(REPO, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(fs.readFileSync(file));
  }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (srv.address() as any).port;
  let browser: any;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (_) { const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((x) => fs.existsSync(x) && fs.statSync(x).isFile()); if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { srv.close(); skip('no Chromium'); } }

  interface Sc { entitled: boolean; published: boolean; stale?: boolean; evil?: boolean; failSecond?: boolean }
  async function open(viewport: { width: number; height: number }, sc: Sc) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('edgedesk_welcome_seen', String(Date.now()));
        localStorage.setItem('edgedesk_decision_onboarded_v1', JSON.stringify('2026-01-01T00:00:00Z'));
        localStorage.setItem('edgedesk_first_run_v1', JSON.stringify({ steps: {}, done_at: '2026-01-01T00:00:00Z' }));
        localStorage.setItem('edgedesk_setup_v1', String(Date.now()));
        localStorage.setItem('edgedesk_session', JSON.stringify({ access_token: 'e2e', refresh_token: 'e2e', expires_at: Math.floor(Date.now() / 1000) + 86400 * 400, user: { id: 'e2e-reader', email: 'e2e@edgedesk.test', created_at: '2025-01-01T00:00:00Z' } }));
      } catch (_) { /* storage */ }
    });
    let calls = 0;
    const status = Object.assign({}, STATUS, sc.published ? {} : { published_run_id: null, published_at: null, published_as_of: null }, sc.stale ? { published_as_of: iso(now - 4 * 864e5) } : {});
    const rows = FORECASTS.map((f) => Object.assign({}, f, sc.stale ? { as_of: iso(now - 4 * 864e5) } : {}, sc.evil && f.game_id === '401900003' ? { home_name: EVIL, away_name: EVIL } : {}));
    await ctx.route('**/*', (route: any) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        const J = (b: unknown, st = 200) => route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(b) });
        if (/rpc\/ncaam_fc_public_status/.test(u)) { calls++; if (sc.failSecond && calls > 1) return J({ message: 'unavailable' }, 503); return J([status]); }
        if (/rpc\/sim_viewer_entitled/.test(u)) return J(sc.entitled);
        if (/rpc\/sim_public_status/.test(u)) return J([]);
        if (/ncaam_fc_current_forecasts/.test(u)) return J(sc.entitled && sc.published ? rows : []);
        if (/ncaam_fc_model_health/.test(u)) return J(sc.entitled ? HEALTH : []);
        if (/subscriptions/.test(u)) return J([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]);
        return J([], 200);
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: any) => errors.push(String(e && e.message || e).slice(0, 240)));
    page.on('dialog', (d: any) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(`http://127.0.0.1:${port}/app.html#simulator/ncaam`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).show === 'function' && !!(window as any).EDSimUI, null, { timeout: 30000 });
    /* TEST ONLY: the personal-research onboarding opens after a quiet moment when no preferences load (the mock has none) */
    await page.evaluate(() => { const M = (window as any).EDMine; if (M) M._onbShown = true; document.querySelectorAll('.edm-ov.on').forEach((e) => e.classList.remove('on')); });
    await page.evaluate(() => (window as any).navHashRoute ? (window as any).navHashRoute('#simulator/ncaam') : (window as any).show('simulator'));
    await page.waitForTimeout(800);
    return { ctx, page, errors };
  }
  const shot = async (page: any, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const text = (page: any) => page.evaluate(() => (document.getElementById('simHost') as HTMLElement).innerText);
  const noScroll = (page: any) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1);
  const tab = async (page: any, t: string) => { await page.click('#simHost [data-sim-tab="' + t + '"]'); await page.waitForTimeout(150); };

  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, { entitled: true, published: true, evil: true });
      let t = await text(page);
      T.chk(W + ': the College Basketball tabs are shown although its tournament is blocked', (await page.locator('#simHost [data-sim-tab]').count()) === 4 && /Games/.test(t) && /Upset Watch/.test(t) && /Model Health/.test(t));
      T.chk(W + ': Games opens by default with a card for every published forecast', (await page.locator('#simHost .sm-gc').count()) === FORECASTS.length, await page.locator('#simHost .sm-gc').count());
      T.chk(W + ': every game card fits inside the viewport', await page.evaluate(() => Array.from(document.querySelectorAll('#simHost .sm-gc')).every((e) => (e as HTMLElement).getBoundingClientRect().right <= window.innerWidth + 1)));
      T.chk(W + ': model version, EXPERIMENTAL and freshness are shown', /ncaam_adjeff@1\.0\.0/.test(t) && /EXPERIMENTAL/.test(t) && /forecasts as of/.test(t));
      T.chk(W + ': an unavailable forecast says why', /No forecast: neither team is a rated Division I team/.test(t));
      T.chk(W + ': definitions and availability assumption are on the page', /How to read these numbers/.test(t));
      T.chk(W + ': hostile names are escaped (no element, no script)', (await page.locator('#simHost img').count()) === 0 && !(await page.evaluate(() => (window as any).__xss)));
      T.chk(W + ': no horizontal page scroll (Games)', await noScroll(page));
      await shot(page, 'ncaam-games-' + W);
      await tab(page, 'upset_watch'); t = await text(page);
      T.chk(W + ': Upset Watch: three separate signals and the frozen threshold', /High upset probability/.test(t) && /Large disagreement with the market/.test(t) && /High uncertainty/.test(t) && /37\.0%/.test(t));
      T.chk(W + ': Upset Watch: the market signal is unavailable, not zero', /Unavailable until synchronized NCAAM quotes/.test(t));
      T.chk(W + ': no horizontal page scroll (Upset Watch)', await noScroll(page));
      await shot(page, 'ncaam-upset-' + W);
      await tab(page, 'tournament'); t = await text(page);
      T.chk(W + ': Tournament: blocked with blockers, switched-off modes, no number', /Blocked/.test(t) && /Before Selection Sunday/.test(t) && !/\d+\.\d%/.test(t));
      await shot(page, 'ncaam-tournament-' + W);
      await tab(page, 'model_health'); t = await text(page);
      T.chk(W + ': Model Health: champion, decisions, gates not passed, live disabled', /ncaam_adjeff@1\.0\.0/.test(t) && /RETAIN/.test(t) && /G2_log_loss/.test(t) && /Disabled/.test(t) && /not an improvement/.test(t));
      T.chk(W + ': no horizontal page scroll (Model Health)', await noScroll(page));
      await shot(page, 'ncaam-health-' + W);
      T.eq(W + ': no page errors', errors, []);
      await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 390, height: 844 }, { entitled: false, published: true });
      for (const t2 of ['games', 'upset_watch', 'model_health']) { await tab(page, t2); const t = await text(page); T.chk('not entitled (' + t2 + '): no number on the page', !/\d+\.\d%/.test(t) && (t2 === 'model_health' || /Full Access/.test(t)), t.slice(0, 200)); }
      T.eq('not entitled: no page errors', errors, []); await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, { entitled: true, published: true, stale: true });
      T.chk('old inputs are marked stale with the reason', /hours old/.test(await text(page))); await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, { entitled: true, published: false });
      const t = await text(page);
      T.chk('nothing published: the empty state, no number', /No college basketball forecast has been published yet/.test(t) && !/\d+\.\d%/.test(t)); await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 1440, height: 900 }, { entitled: true, published: true, failSecond: true });
      await page.click('#simHost [data-sim-refresh]'); await page.waitForTimeout(500);
      const t = await text(page);
      T.chk('a failed refresh keeps the last good forecasts, marked stale', (await page.locator('#simHost .sm-gc').count()) === FORECASTS.length && /Refresh failed/.test(t)); await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
  process.exit(T.done());
})();
