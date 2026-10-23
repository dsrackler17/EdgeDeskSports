/// <reference lib="dom" />
/* ===========================================================================
   The Simulator seat in a real browser (Playwright + Chromium), over the real
   app.html. Supabase is intercepted: its rows are a REAL simulation of the
   committed snapshot (3,000 runs, in process) shaped exactly as the
   sim_current_* views return them; the futures rows are SYNTHETIC (invented
   tickers and prices). TEST ONLY: the sport registry is served with the NFL
   marked ACTIVE so the results views can be exercised (it already is once its
   2026 facts are verified; the override only applies while it is BLOCKED).

     node simulator/tests/ui.e2e.ts [--shots DIR]
   Skips (exit 0) when Playwright is not installed.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { nflFixture } from './_fixture.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { nflModule } from '../src/sports/nfl/module.ts';
import { runRange } from '../src/core/engine.ts';
import { buildResults } from '../src/core/results.ts';
import { resultRows } from '../src/publish/publish.ts';
import { nflMathStatus } from '../src/sports/nfl/validate.ts';

const require = createRequire(import.meta.url);
const T = kit('Simulator seat (browser)');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
let pw: any = null;
try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (_) { pw = null; } }
/* CI sets SIM_E2E_REQUIRED=1: there a missing browser is a failure, never a quiet skip */
const skip = (why: string) => { console.log((process.env.SIM_E2E_REQUIRED === '1' ? 'FAILED: ' : 'SKIPPED: ') + why); process.exit(process.env.SIM_E2E_REQUIRED === '1' ? 1 : 0); };
if (!pw) skip('playwright is not installed here');

/* ---- the rows the views would return ---- */
const snap = nflFixture();
const m = nflModule(snap.data, { seed: 2026n });
const agg = runRange(m, { start: 0, end: 3000 });
const status = nflMathStatus(snap.data);
const results = buildResults({ module: m, agg, seed: 2026n, runs: 3000, workers: 1, input_hash: snap.input_hash, input_snapshot_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  model_version: snap.data.model.model_version, config: snap.data.config, rules_version: snap.data.config.rules_version, started_at: '', finished_at: '', runtime_ms: 1, peak_rss_mb: 1,
  entityExtras: (id) => ({ math_status: status[id] }) });
const RUN_ID = '11111111-2222-3333-4444-555555555555';
const run = { run_id: RUN_ID, sport: 'nfl', season: '2026', n_sims: 3000, seed: '2026', model_version: results.run.model_version, rules_version: results.run.rules_version, engine_version: results.run.engine_version,
  input_snapshot_at: results.run.input_snapshot_at, completed_at: new Date(Date.now() - 3600e3).toISOString(), published_at: new Date(Date.now() - 3600e3).toISOString(), comparison_id: 'c0ffee00-0000-0000-0000-000000000000',
  limitations: [], validation_summary: { flags: { tiebreak_estimated_points: 1 } } };
const rows = resultRows({ results } as any);
const W2: Record<string, { w: number; l: number; t: number }> = {};
snap.data.teams.forEach((t) => { W2[t.code] = { w: 0, l: 0, t: 0 }; });
snap.data.games.filter((g) => g.done).forEach((g) => { const d = (g.home_score as number) - (g.away_score as number); if (d > 0) { W2[g.home].w++; W2[g.away].l++; } else if (d < 0) { W2[g.away].w++; W2[g.home].l++; } else { W2[g.home].t++; W2[g.away].t++; } });
const ents = (results.entities as any[]).map((e) => ({ entity_id: e.entity_id, entity_name: e.entity_name, entity_groups: e.groups, record: W2[e.entity_id], mean_wins: e.mean_wins, math_status: e.math_status }));
const sb = (id: string) => (results.entities as any[]).find((e) => e.entity_id === id).outcomes.win_super_bowl;
const edges = ['BUF', 'KC', 'SF', 'DET'].map((id, i) => ({ entity_id: id, outcome: 'win_super_bowl', market_ticker: 'SYNTHETIC-' + id, research_prob: sb(id).probability, research_mcse: sb(id).mcse, research_fair_decimal: sb(id).probability > 0 ? 1 / sb(id).probability : null,
  reference_prob: i === 2 ? null : [0.08, 0.06, 0, 0.05][i], normalized_ref_prob: null, reference_edge_pp: i === 2 ? null : Math.round((sb(id).probability - [0.08, 0.06, 0, 0.05][i]) * 1e4) / 100,
  exec_price: [0.09, 0.07, 0.15, 0.06][i], exec_cost_prob: [0.09, 0.07, 0.15, 0.06][i], exec_edge_pp: Math.round((sb(id).probability - [0.09, 0.07, 0.15, 0.06][i]) * 1e4) / 100,
  quote_age_minutes: [4, 6, 90, 5][i], fee_verified: false, stale: i === 2, actionable: false, block_reasons: ['fee schedule unverified: the executable cost is pre-fee'], quote_at: new Date(Date.now() - [4, 6, 90, 5][i] * 60000).toISOString(), normalization_note: 'not normalised' }));

const EVIL = '<img src=x onerror="window.__xss=1">';
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

(async () => {
  const srv: http.Server = await new Promise((resolve) => { const s = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url).split('?')[0]); if (p === '/') p = '/app.html';
    const file = path.join(REPO, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    let body: Buffer | string = fs.readFileSync(file);
    if (p === '/lib/edgedesk_simulator_sports.js') {
      const before = String(body);
      body = before.replace(/("key": "nfl",\s*"label": "NFL",\s*"status": )"BLOCKED"/, '$1"ACTIVE"');
      if (!/"key": "nfl",\s*"label": "NFL",\s*"status": "ACTIVE"/.test(String(body))) throw new Error('the NFL is neither ACTIVE nor overridable to ACTIVE');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body);
  }); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (srv.address() as any).port;
  let browser: any;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (_) { const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'; if (fs.existsSync(exe)) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { srv.close(); skip('no Chromium'); } }

  interface Scenario { entitled: boolean; published: boolean; failSecond?: boolean; evil?: boolean }
  async function open(viewport: { width: number; height: number }, hash: string, sc: Scenario) {
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
    let statusCalls = 0;
    const status = { sport: 'nfl', competition: 'NFL', season: '2026', published_run_id: sc.published ? RUN_ID : null, published_at: sc.published ? run.published_at : null, input_snapshot_at: run.input_snapshot_at,
      n_sims: 3000, model_version: run.model_version, last_attempt_status: 'completed', last_attempt_at: run.completed_at, comparison_status: 'completed', comparison_at: run.completed_at };
    await ctx.route('**/*', (route: any) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        const J = (b: unknown, st = 200) => route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(b) });
        if (/rpc\/sim_public_status/.test(u)) { statusCalls++; if (sc.failSecond && statusCalls > 1) return J({ message: 'unavailable' }, 503); return J([status]); }
        if (/rpc\/sim_viewer_entitled/.test(u)) return J(sc.entitled);
        if (/sim_current_runs/.test(u)) return J(sc.entitled && sc.published ? [run] : []);
        if (/sim_current_results/.test(u)) return J(sc.entitled ? rows.map((r) => (sc.evil && r.entity_id === 'BUF' ? { ...r, entity_name: EVIL } : r)) : []);
        if (/sim_current_entities/.test(u)) return J(sc.entitled ? ents.map((e) => (sc.evil && e.entity_id === 'BUF' ? { ...e, entity_name: EVIL } : e)) : []);
        if (/sim_current_edges/.test(u)) return J(sc.entitled ? edges : []);
        if (/subscriptions/.test(u)) return J([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]);
        return J([], 200);
      }
      return route.fulfill({ status: 204, body: '' });
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: any) => errors.push(String(e && e.message || e).slice(0, 240)));
    page.on('dialog', (d: any) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(`http://127.0.0.1:${port}/app.html${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as any).show === 'function' && !!(window as any).EDSimUI, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).show('simulator'));
    await page.waitForTimeout(700);
    return { ctx, page, errors };
  }
  const shot = async (page: any, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
  const text = (page: any) => page.evaluate(() => (document.getElementById('simHost') as HTMLElement).innerText);

  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '', { entitled: true, published: true });
      T.chk(W + ': the Simulator seat is in the bottom bar and active', await page.evaluate(() => { const b = document.querySelector('.bottomnav button[data-v="simulator"]'); return !!b && b.classList.contains('on'); }));
      const t = await text(page);
      T.chk(W + ': title view: EXPERIMENTAL, simulated seasons, inputs time and the ± legend', /EXPERIMENTAL/.test(t) && /3,000 simulated seasons/.test(t) && /95% Monte Carlo interval/.test(t));
      T.chk(W + ': 32 club cards with probability and fair odds', (await page.locator('#simHost .sm-club').count()) === 32 && /fair odds/.test(t));
      T.chk(W + ': provenance badges: Research and Observed', (await page.locator('#simHost .sm-research').count()) > 0 && (await page.locator('#simHost .sm-observed').count()) > 0);
      T.chk(W + ': a mapped synthetic market shows its reference, its age and pre-fee executable edge', /Kalshi/.test(t) && /pre-fee/.test(t));
      T.chk(W + ': known limitations are on the page', /Known limitations/.test(t));
      T.chk(W + ': no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1), await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]));
      await shot(page, 'sim-title-' + W);
      await page.click('#simHost [data-sim-tab="division"]'); await page.waitForTimeout(150);
      T.chk(W + ': division view: 8 divisions of 4 clubs', (await page.locator('#simHost .sm-card .sm-tbl').count()) === 8 && (await page.locator('#simHost .sm-card .sm-tbl tbody tr').count()) === 32);
      await shot(page, 'sim-division-' + W);
      await page.click('#simHost [data-sim-tab="conference"]'); await page.waitForTimeout(150);
      T.chk(W + ': conference view: seeds 1-7 per conference', (await page.locator('#simHost .sm-seeds').count()) === 2 && /1 \(bye\)/.test(await text(page)));
      await shot(page, 'sim-conference-' + W);
      await page.click('#simHost [data-sim-tab="futures"]'); await page.waitForTimeout(150);
      T.eq(W + ': futures view: one row per market', await page.locator('#simHost .sm-sortable tbody tr').count(), 4);
      const sortBtn = '#simHost [data-sim-sort="reference_edge_pp"]';
      await page.locator(sortBtn).click();
      await page.waitForSelector(sortBtn + '[aria-sort="descending"]');
      const desc = await page.$$eval('#simHost .sm-sortable tbody tr td:nth-child(7)', (td: any[]) => td.map((x) => x.textContent));
      await page.locator(sortBtn).click();
      await page.waitForSelector(sortBtn + '[aria-sort="ascending"]');
      const asc = await page.$$eval('#simHost .sm-sortable tbody tr td:nth-child(7)', (td: any[]) => td.map((x) => x.textContent));
      const nums = (a: string[]) => a.filter((x) => x !== '—').map(Number);
      T.chk(W + ': sorting is numeric, descending then ascending, the missing value last both times', desc[desc.length - 1] === '—' && asc[asc.length - 1] === '—'
        && nums(desc).every((v, i, a) => i === 0 || a[i - 1] >= v) && nums(asc).every((v, i, a) => i === 0 || a[i - 1] <= v), { desc, asc });
      await shot(page, 'sim-futures-' + W);
      T.eq(W + ': no page errors', errors, []);
      await ctx.close();
    }
    /* states */
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, '', { entitled: false, published: true });
      const t = await text(page);
      T.chk('not a subscriber: the Full Access state, and no probability on the page', /Full Access/.test(t) && !/\d+\.\d%/.test(t));
      await shot(page, 'sim-unauthorized-390'); await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, '', { entitled: true, published: false });
      T.chk('nothing published: the no-data state', /No simulation has been published/.test(await text(page)));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, '#simulator/nba', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/nba')); await page.waitForTimeout(300);
      const t = await text(page);
      T.chk('a blocked sport (#simulator/nba) shows its blockers and no number', /Blocked/.test(t) && /NBA Cup/.test(t) && !/\d+\.\d%/.test(t));
      await shot(page, 'sim-blocked-nba-390'); await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 390, height: 844 }, '', { entitled: true, published: true, failSecond: true });
      await page.click('#simHost [data-sim-refresh]'); await page.waitForTimeout(500);
      const t = await text(page);
      T.chk('a failed refresh keeps the last good results on screen, marked stale', (await page.locator('#simHost .sm-club').count()) === 32 && /Refresh failed/.test(t) && (await page.locator('#simHost .sm-stalebar').count()) === 1);
      T.eq('  ... with no page error', errors, []);
      await shot(page, 'sim-stale-390'); await ctx.close();
    }
    {
      const { ctx, page, errors } = await open({ width: 390, height: 844 }, '', { entitled: true, published: true, evil: true });
      await page.click('#simHost [data-sim-tab="division"]'); await page.waitForTimeout(200);
      T.chk('a hostile club name is rendered as text, never as markup', (await page.locator('#simHost img').count()) === 0 && await page.evaluate(() => !(window as any).__xss) && /<img src=x/.test(await text(page)));
      T.eq('  ... and nothing executed', errors, []);
      await ctx.close();
    }
  } catch (e) {
    T.chk('the browser suite ran to the end', false, String((e as Error).stack || e).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2500));
  } finally { await browser.close(); srv.close(); }
  process.exit(T.done(SHOTS ? 'screenshots: ' + SHOTS : undefined));
})();
