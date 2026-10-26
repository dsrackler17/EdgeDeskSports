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
import { nflFixture, nhlFixture } from './_fixture.ts';
import { nhlModule } from '../src/sports/nhl/module.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { nflModule } from '../src/sports/nfl/module.ts';
import { runRange } from '../src/core/engine.ts';
import { buildResults } from '../src/core/results.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';
import { nflMathStatus } from '../src/sports/nfl/validate.ts';
import { nbaFixture } from './_nba_fixture.ts';
import { nbaModule } from '../src/sports/nba/module.ts';
import { nbaMathStatus } from '../src/sports/nba/validate.ts';
import { executeWnba } from '../src/sports/wnba/run.ts';
import { buildWnbaSnapshot } from '../src/sports/wnba/inputs.ts';
import { executeUfc } from '../src/sports/ufc/run.ts';
import { buildUfcSnapshot } from '../src/sports/ufc/inputs.ts';
import { executeGolf } from '../src/sports/golf/run.ts';
import { tennisRuns } from './_tennis_fixture.ts';
import { executeCbase } from '../src/sports/college_baseball/run.ts';
import { writeCbaseSnapshot } from '../src/sports/college_baseball/inputs.ts';
import { syntheticSnapshot } from './_college_baseball_fixture.ts';
import os from 'node:os';

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

/* the NHL: a REAL 1,000-run simulation of the committed 2026-27 snapshot, through the publisher's row mapping */
const nsnap = nhlFixture();
const nm = nhlModule(nsnap.data, { seed: 2027n });
const nagg = runRange(nm, { start: 0, end: 1000 });
const nrec: Record<string, { gp: number; w: number; l: number; otl: number; pts: number; rw: number; row: number }> = {};
nsnap.data.teams.forEach((t) => { nrec[t.code] = { gp: 0, w: 0, l: 0, otl: 0, pts: 0, rw: 0, row: 0 }; });
nsnap.data.games.filter((g) => g.done).forEach((g) => { const hw = (g.home_score as number) > (g.away_score as number), w = nrec[hw ? g.home : g.away], l = nrec[hw ? g.away : g.home];
  w.gp++; l.gp++; w.w++; w.pts += 2; if (g.decided === 'REG') { w.rw++; w.row++; l.l++; } else { if (g.decided === 'OT') w.row++; l.otl++; l.pts++; } });
const nresults = buildResults({ module: nm, agg: nagg, seed: 2027n, runs: 1000, workers: 1, input_hash: nsnap.input_hash, input_snapshot_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  model_version: nsnap.data.model.model_version, config: nsnap.data.config, rules_version: nsnap.data.config.rules_version, started_at: '', finished_at: '', runtime_ms: 1, peak_rss_mb: 1,
  entityExtras: (id) => ({ record: nrec[id], math_status: null }) });
const NHL_RUN_ID = '66666666-7777-8888-9999-000000000000';
const nrun = { ...run, run_id: NHL_RUN_ID, sport: 'nhl', season: '2026-27', n_sims: 1000, seed: '2027', model_version: nresults.run.model_version, rules_version: nresults.run.rules_version, comparison_id: null, validation_summary: { flags: { tiebreak_goals: 2 } } };
const nrows = resultRows({ results: nresults } as any), nents = entityRows({ results: nresults } as any);

/* the NBA: a REAL 500-run simulation of the committed 2026-27 snapshot (its NBA Cup simulated), through the
   publisher's row mapping */
const bsnap = nbaFixture('live');
const bm = nbaModule(bsnap.data, { seed: 2027n });
const bagg = runRange(bm, { start: 0, end: 500 });
const bmath = nbaMathStatus(bsnap.data);
const brec: Record<string, { w: number; l: number }> = {};
bsnap.data.teams.forEach((t) => { brec[t.code] = { w: 0, l: 0 }; });
bsnap.data.games.filter((g) => g.done).forEach((g) => { const hw = (g.home_score as number) > (g.away_score as number); brec[hw ? g.home : g.away].w++; brec[hw ? g.away : g.home].l++; });
const bresults = buildResults({ module: bm, agg: bagg, seed: 2027n, runs: 500, workers: 1, input_hash: bsnap.input_hash, input_snapshot_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  model_version: bsnap.data.model.model_version, config: bsnap.data.config, rules_version: bsnap.data.rules_version, started_at: '', finished_at: '', runtime_ms: 1, peak_rss_mb: 1,
  entityExtras: (id) => ({ record: brec[id], math_status: bmath[id] }) });
const NBA_RUN_ID = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';
const brun = { ...run, run_id: NBA_RUN_ID, sport: 'nba', season: '2026-27', n_sims: 500, seed: '2027', model_version: bresults.run.model_version, rules_version: bresults.run.rules_version, comparison_id: null, validation_summary: { flags: bresults.flags } };
const brows = resultRows({ results: bresults } as any), bents = entityRows({ results: bresults } as any);
if (brows.length !== 30 * 35) throw new Error('the NBA run should publish 1,050 result rows (30 clubs x 35 outcomes: more than one page), not ' + brows.length);
/* the WNBA: a real (short) postseason run on the committed 2026 data, through the publisher's row builders */
const wsnap = await buildWnbaSnapshot({ offline: true });
const WNBA_OPEN = wsnap.data.remaining.length > 0;
const wout = WNBA_OPEN ? await executeWnba({ season: 2026, runs: 3000, seed: '5', workers: 1, snapshot: null, out: fs.mkdtempSync(path.join(os.tmpdir(), 'wnba-e2e-')), traceRuns: [], offline: true, nowMs: Date.parse(wsnap.data.as_of + 'T12:00:00Z') }, () => {}) : null;
const WNBA_RUN_ID = 'cccccccc-dddd-eeee-ffff-000000000000';
const wrun = wout ? { ...run, run_id: WNBA_RUN_ID, sport: 'wnba', season: '2026', n_sims: 3000, seed: '5', model_version: wout.results.run.model_version, rules_version: wout.results.run.rules_version, comparison_id: null,
  validation_summary: { flags: wout.results.flags, sport_summary: (wout.results as any).sport_summary } } : null;
const wrows = wout ? resultRows(wout as any) : [], wents = wout ? entityRows(wout as any) : [];
/* the UFC: a real (short) run of every booked bout and each division's title path on the committed data */
const usnap = buildUfcSnapshot();
const uout = await executeUfc({ season: 2026, runs: 3000, seed: '9', workers: 1, snapshot: null, out: fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-e2e-')), traceRuns: [], nowMs: Date.parse(usnap.data.rankings.fetched_at) + 3600e3 }, () => {});
const UFC_RUN_ID = 'dddddddd-eeee-ffff-0000-111111111111';
const urun = { ...run, run_id: UFC_RUN_ID, sport: 'ufc', season: '2026', n_sims: 3000, seed: '9', model_version: uout.results.run.model_version, rules_version: uout.results.run.rules_version, comparison_id: null,
  validation_summary: { flags: uout.results.flags, sport_summary: (uout.results as any).sport_summary } };
const urows = resultRows(uout as any), uents = entityRows(uout as any);
/* the booked cards change every week (a card leaves the data once it starts), so the Fights check reads them from the run */
const ucards = (uout.results as any).sport_summary.cards, utitles = ucards.flatMap((c: any) => c.bouts).filter((b: any) => b.title).length;
/* golf: the committed current tour events, simulated offline (3,000 runs each), one competition per event, through
   the publisher's row builders */
const gout = await executeGolf({ season: 2026, runs: 3000, seed: '5', workers: 1, snapshot: null, out: fs.mkdtempSync(path.join(os.tmpdir(), 'golf-e2e-')), traceRuns: [], offline: true }, () => {});
const golf = gout.runs.map((r, i) => {
  const id = 'eeeeeeee-0000-0000-0000-00000000000' + i, comp = r.results.run.competition;
  return { id, comp, run: { ...run, run_id: id, sport: 'golf', competition: comp, season: '2026', n_sims: 3000, seed: '5', model_version: r.results.run.model_version, rules_version: r.results.run.rules_version, comparison_id: null,
    validation_summary: { flags: r.results.flags, sport_summary: (r.results as any).sport_summary } }, rows: resultRows(r as any), ents: entityRows(r as any) };
});
const golfOf = (u: string) => golf.find((g) => u.includes(g.id) || u.includes(encodeURIComponent(g.id)) || u.includes('competition=eq.' + encodeURIComponent(g.comp))) || null;
/* tennis: every draw whose order the committed feeds give, and the day's matches, simulated offline (3,000 runs each) */
const tout = await tennisRuns(3000, '5');   /* the committed feeds, or the frozen fixture on a day they give no draw */
const tennis = tout.runs.map((r, i) => {
  const id = 'ffffffff-0000-0000-0000-00000000000' + i, comp = r.results.run.competition;
  return { id, comp, run: { ...run, run_id: id, sport: 'tennis', competition: comp, season: '2026', n_sims: 3000, seed: '5', model_version: r.results.run.model_version, rules_version: r.results.run.rules_version, comparison_id: null,
    validation_summary: { flags: r.results.flags, sport_summary: (r.results as any).sport_summary } }, rows: resultRows(r as any), ents: entityRows(r as any) };
});
const tennisOf = (u: string) => tennis.find((g) => u.includes(g.id) || u.includes(encodeURIComponent(g.id)) || u.includes('competition=eq.' + encodeURIComponent(g.comp))) || null;
const TENNIS_DRAWS = tennis.filter((t) => t.comp !== 'matches');
/* college baseball: the synthetic 2027 preseason (_college_baseball_fixture.ts: no warehouse replay), 3,000 runs */
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbase-e2e-'));
writeCbaseSnapshot(path.join(cdir, 'snap.json'), syntheticSnapshot());
const cout = await executeCbase({ season: 2027, runs: 3000, seed: '5', workers: 1, snapshot: path.join(cdir, 'snap.json'), out: path.join(cdir, 'out'), traceRuns: [], nowMs: Date.parse('2026-10-24T12:00:00Z') }, () => {});
const CBASE_RUN_ID = 'abababab-0000-0000-0000-000000000000';
const crun = { ...run, run_id: CBASE_RUN_ID, sport: 'college_baseball', competition: 'road-to-omaha', season: '2027', n_sims: 3000, seed: '5', model_version: cout.results!.run.model_version, rules_version: cout.results!.run.rules_version, comparison_id: null,
  validation_summary: { flags: cout.results!.flags, sport_summary: (cout.results as any).sport_summary } };
const crows = resultRows(cout as any), cents = entityRows(cout as any);
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

  /* soon: a sport the served registry shows as COMING_SOON with one test blocker (every sport is ACTIVE or has views of its own) */
  interface Scenario { entitled: boolean; published: boolean; failSecond?: boolean; evil?: boolean; soon?: string }
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
    const nstatus = { ...status, sport: 'nhl', competition: 'NHL', season: '2026-27', published_run_id: sc.published ? NHL_RUN_ID : null, n_sims: 1000, model_version: nrun.model_version, comparison_status: null, comparison_at: null };
    const bstatus = { ...status, sport: 'nba', competition: 'NBA', season: '2026-27', published_run_id: sc.published ? NBA_RUN_ID : null, n_sims: 500, model_version: brun.model_version, comparison_status: null, comparison_at: null };
    const wstatus = { ...status, sport: 'wnba', competition: 'WNBA Playoffs', season: '2026', published_run_id: sc.published && wrun ? WNBA_RUN_ID : null, n_sims: 3000, model_version: wrun ? wrun.model_version : '', comparison_status: null, comparison_at: null };
    const isWnba = (u: string) => u.includes(encodeURIComponent(WNBA_RUN_ID)) || u.includes(WNBA_RUN_ID) || /sport=eq\.wnba/.test(u);
    const ustatus = { ...status, sport: 'ufc', competition: 'UFC Fights and Title Path', season: '2026', published_run_id: sc.published ? UFC_RUN_ID : null, n_sims: 3000, model_version: urun.model_version, comparison_status: null, comparison_at: null };
    const isUfc = (u: string) => u.includes(encodeURIComponent(UFC_RUN_ID)) || u.includes(UFC_RUN_ID) || /sport=eq\.ufc/.test(u);
    const isNhl = (u: string) => u.includes(encodeURIComponent(NHL_RUN_ID)) || u.includes(NHL_RUN_ID) || /sport=eq\.nhl/.test(u);
    const isNba = (u: string) => u.includes(encodeURIComponent(NBA_RUN_ID)) || u.includes(NBA_RUN_ID) || /sport=eq\.nba/.test(u);
    const cstatus = { ...status, sport: 'college_baseball', competition: 'road-to-omaha', season: '2027', published_run_id: sc.published ? CBASE_RUN_ID : null, n_sims: 3000, model_version: crun.model_version, comparison_status: null, comparison_at: null };
    const isCbase = (u: string) => u.includes(CBASE_RUN_ID) || /sport=eq\.college_baseball/.test(u);
    await ctx.route('**/*', async (route: any) => {
      const u = route.request().url();
      if (sc.soon && u.startsWith('http://127.0.0.1') && u.includes('/lib/edgedesk_simulator_sports.js')) {
        const resp = await route.fetch(); const key = sc.soon;
        const body = (await resp.text()).replace(new RegExp('("key": "' + key + '",\\s*"label": "[^"]+",\\s*"status": )"ACTIVE"'), '$1"COMING_SOON"')
          .replace(new RegExp('("key": "' + key + '"[\\s\\S]*?"blockers": )\\[\\]'), '$1["TEST: out of season until February"]');
        return route.fulfill({ response: resp, body });
      }
      if (u.startsWith('http://127.0.0.1')) return route.continue();
      if (/supabase\.co/.test(u)) {
        const J = (b: unknown, st = 200) => route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(b) });
        /* PostgREST pages: limit and offset, as the reader asks (an NBA run publishes 1,050 result rows, a UFC run about 1,500) */
        const paged = <X>(rows: X[]): X[] => { const q = new URL(u).searchParams, off = Number(q.get('offset') || 0), lim = q.get('limit'); return rows.slice(off, lim == null ? undefined : off + Number(lim)); };
        const gstatus = golf.map((g) => ({ ...status, sport: 'golf', competition: g.comp, season: '2026', published_run_id: sc.published ? g.id : null, n_sims: 3000, model_version: g.run.model_version, comparison_status: null, comparison_at: null }));
        const tstatus = tennis.map((g) => ({ ...status, sport: 'tennis', competition: g.comp, season: '2026', published_run_id: sc.published ? g.id : null, n_sims: 3000, model_version: g.run.model_version, comparison_status: null, comparison_at: null }));
        if (/rpc\/sim_public_status/.test(u)) { statusCalls++; if (sc.failSecond && statusCalls > 1) return J({ message: 'unavailable' }, 503); return J([status, nstatus, bstatus, wstatus, ustatus, cstatus, ...gstatus, ...tstatus]); }
        if (/rpc\/sim_viewer_entitled/.test(u)) return J(sc.entitled);
        const g = /sport=eq\.golf|eeeeeeee-/.test(u) ? golfOf(u) : /sport=eq\.tennis|ffffffff-/.test(u) ? tennisOf(u) : null;
        /* the tennis reader first asks for every tennis run (its draw picker's names), then each competition's */
        if (/sim_current_runs/.test(u) && /sport=eq\.tennis/.test(u) && !/competition=eq/.test(u)) return J(sc.entitled && sc.published ? tennis.map((t) => t.run) : []);
        if (/sim_current_runs/.test(u)) return J(sc.entitled && sc.published ? (g ? [g.run] : /sport=eq\.(golf|tennis)/.test(u) ? [] : [isCbase(u) ? crun : isUfc(u) ? urun : isWnba(u) ? wrun : isNhl(u) ? nrun : isNba(u) ? brun : run]) : []);
        if (/sim_current_results/.test(u)) return J(sc.entitled ? paged(g ? g.rows : isCbase(u) ? crows : isUfc(u) ? urows : isWnba(u) ? wrows : isNhl(u) ? nrows : isNba(u) ? brows : rows.map((r) => (sc.evil && r.entity_id === 'BUF' ? { ...r, entity_name: EVIL } : r))) : []);
        if (/sim_current_entities/.test(u)) return J(sc.entitled ? paged(g ? g.ents : isCbase(u) ? cents : isUfc(u) ? uents : isWnba(u) ? wents : isNhl(u) ? nents : isNba(u) ? bents : ents.map((e) => (sc.evil && e.entity_id === 'BUF' ? { ...e, entity_name: EVIL } : e))) : []);
        if (/sim_current_edges/.test(u)) return J(sc.entitled ? edges : []);
        if (/subscriptions/.test(u)) return J([{ status: 'active', current_period_end: '2027-06-01T00:00:00Z' }]);
        /* an onboarded reader: without it the personal desk's first-run walkthrough opens over the page once it is quiet */
        if (/user_preferences/.test(u)) return J([{ persona: null, leagues: [], books: [], interests: [], onboarding_status: 'done' }]);
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
      T.chk(W + ': the Simulator seat is in the navigation and active', await page.evaluate(() => { const b = document.querySelector('.bottomnav button[data-v="simulator"]'); return !!b && b.classList.contains('on'); }));
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
    /* the NHL view */
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '#simulator/nhl', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/nhl')); await page.waitForTimeout(500);
      let t = await text(page);
      T.chk(W + ': NHL title view: 32 Stanley Cup cards, the regular-season honours apart, 1,000 simulated seasons', (await page.locator('#simHost .sm-club').count()) === 32 && /win Stanley Cup/.test(t) && /Presidents’ Trophy/.test(t) && /1,000 simulated seasons/.test(t) && !/Super Bowl/.test(t));
      T.chk(W + ': NHL: no market is mapped, shown as unavailable (not zero)', /Market: unavailable/.test(t));
      T.chk(W + ': NHL: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-nhl-title-' + W);
      await page.click('#simHost [data-sim-tab="division"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': NHL division view: 4 divisions of 8 with W-L-OTL, points and projected points', (await page.locator('#simHost .sm-card .sm-tbl').count()) === 4 && (await page.locator('#simHost .sm-card .sm-tbl tbody tr').count()) === 32 && /W-L-OTL/.test(t) && /Proj\. pts/.test(t));
      await shot(page, 'sim-nhl-division-' + W);
      await page.click('#simHost [data-sim-tab="conference"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': NHL conference view: D1-D3, wild cards and rounds per conference', (await page.locator('#simHost .sm-seeds').count()) === 2 && /WC2/.test(t) && /Conf\. final/.test(t) && !/\(bye\)/.test(t));
      await shot(page, 'sim-nhl-conference-' + W);
      T.eq(W + ': NHL: no page errors', errors, []);
      await ctx.close();
    }
    /* the NBA view (the NBA is ACTIVE in the real registry) */
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '#simulator/nba', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/nba'));
      /* the NBA run's 1,050 result rows come in pages: wait for its 30 cards, not a fixed time (a slow runner took longer than 500 ms) */
      await page.waitForFunction(() => document.querySelectorAll('#simHost .sm-club').length >= 30, null, { timeout: 15000 }).catch(() => {});
      let t = await text(page);
      T.chk(W + ': NBA title view: 30 NBA-title cards, the playoff conference title and the regular-season places apart, 500 simulated seasons', (await page.locator('#simHost .sm-club').count()) === 30 && /win NBA title/.test(t) && /Conference title \(playoffs\)/.test(t) && /Regular season: 1st in the/.test(t) && /500 simulated seasons/.test(t) && !/Super Bowl|Stanley Cup/.test(t));
      T.chk(W + ': NBA: no market is mapped, shown as unavailable (not zero)', /Market: unavailable/.test(t));
      T.chk(W + ': NBA: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-nba-title-' + W);
      await page.click('#simHost [data-sim-tab="division"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': NBA division view: 6 divisions of 5 with W-L, projected wins, the play-in and the playoffs', (await page.locator('#simHost .sm-card .sm-tbl').count()) === 6 && (await page.locator('#simHost .sm-card .sm-tbl tbody tr').count()) === 30 && /Proj\. wins/.test(t) && /Play-in/.test(t) && /Make playoffs/.test(t));
      await shot(page, 'sim-nba-division-' + W);
      await page.click('#simHost [data-sim-tab="conference"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': NBA conference view: first place, play-in, playoffs, seeds 1-8, rounds and the conference title per conference', (await page.locator('#simHost .sm-seeds').count()) === 2 && /1st \(reg\. season\)/.test(t) && /Conf\. finals/.test(t) && /Win East/.test(t) && /Win West/.test(t) && /Four different outcomes/.test(t));
      T.chk(W + ': NBA conference view: no horizontal page scroll (the table scrolls in its card)', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-nba-conference-' + W);
      await page.click('#simHost [data-sim-tab="cup"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': NBA Cup view: six groups of five, win group to win the Cup, the Estimated note', (await page.locator('#simHost .sm-card .sm-tbl').count()) === 6 && (await page.locator('#simHost .sm-card .sm-tbl tbody tr').count()) === 30 && /Win group/.test(t) && /Win Cup/.test(t) && /East group 1/.test(t) && /West group 3/.test(t) && /unpublished formula/.test(t));
      T.chk(W + ': NBA Cup view: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-nba-cup-' + W);
      T.eq(W + ': NBA: no page errors', errors, []);
      await ctx.close();
    }
    /* the WNBA postseason (its own adapter: Finals, Games, Model Health) */
    if (WNBA_OPEN) for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '#simulator/wnba', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/wnba')); await page.waitForTimeout(500);
      let t = await text(page);
      T.chk(W + ': WNBA: the tabs are Finals, Games and Model Health, Finals open', /Finals/.test(await page.locator('#simHost .sm-tabs').innerText()) && /Model Health/.test(await page.locator('#simHost .sm-tabs').innerText()) && (await page.locator('#simHost .sm-tabs button.on').innerText()) === 'Finals');
      T.chk(W + ': WNBA Finals: the series state, two title cards with fair odds, the exact results and the bracket', /(leads|tied)/.test(t) && (await page.locator('#simHost .sm-club').count()) === 2 && /fair \d+\.\d\d \([+-]\d+\)/.test(t) && /Exact series result/.test(t) && /First round:/.test(t) && /3,000 simulated postseasons/.test(t));
      T.chk(W + ': WNBA Finals: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-wnba-finals-' + W);
      await page.click('#simHost [data-sim-tab="games"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': WNBA Games: the games left with how often each is played, and every played game with the model\'s chance', /Games left/.test(t) && /Board price/.test(t) && /Played/.test(t) && /Favourite won/.test(t));
      T.chk(W + ': WNBA Games: no horizontal page scroll (tables scroll in their cards)', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-wnba-games-' + W);
      await page.click('#simHost [data-sim-tab="model_health"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': WNBA Model Health: the record windows, calibration and the shared offset', /The served model/.test(t) && /Calibration, playoff games since 2010/.test(t) && /shared offset/.test(t));
      await shot(page, 'sim-wnba-health-' + W);
      T.eq(W + ': WNBA: no page errors', errors, []);
      await ctx.close();
    }
    /* the UFC (its own adapter: Fights, Title Path, Model Health) */
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '#simulator/ufc', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/ufc')); await page.waitForTimeout(500);
      let t = await text(page);
      const tabs = await page.locator('#simHost .sm-tabs').innerText();
      T.chk(W + ': UFC: the tabs are Fights, Title Path and Model Health, Fights open', /Fights/.test(tabs) && /Title Path/.test(tabs) && /Model Health/.test(tabs) && (await page.locator('#simHost .sm-tabs button.on').innerText()) === 'Fights');
      T.chk(W + ': UFC Fights: the cards by date (' + ucards[0].event + ' first), title fights badged, fair decimal and American odds, finish and rounds', ucards.length > 0 && t.includes(ucards[0].event)
        && (utitles === 0 || (/weight title/.test(t) && /New champion:/.test(t))) && /Finish by round: R1/.test(t) && /[+-]\d{2,4}/.test(t) && /3,000 simulated runs/.test(t));
      T.chk(W + ': UFC Fights: no horizontal page scroll (tables scroll in their cards)', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-ufc-fights-' + W);
      await page.click('#simHost [data-sim-tab="title_path"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': UFC Title Path: the rule in plain words, eleven divisions, Estimated', /Who becomes champion by/.test(t) && /EdgeDesk’s rule, not the UFC’s/.test(t) && (await page.locator('#simHost .sm-card .sm-h .sm-estimated').count()) >= 12 && /Women’s Bantamweight/.test(t));
      T.chk(W + ': UFC Title Path: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-ufc-title-path-' + W);
      await page.click('#simHost [data-sim-tab="model_health"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': UFC Model Health: the served Elo, its record beside a coin, champions against it, the finish model', /The served fight model/.test(t) && /better than a coin flip, but not by much/.test(t) && /Champions against the Elo/.test(t) && /How fights end/.test(t));
      T.chk(W + ': UFC Model Health: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-ufc-health-' + W);
      T.eq(W + ': UFC: no page errors', errors, []);
      await ctx.close();
    }
    /* golf (its own adapter: Leaderboard, Finishes, Model Health; one competition per tour event, a tour picker) */
    if (golf.length) for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width;
      const { ctx, page, errors } = await open(vp, '#simulator/golf', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/golf')); await page.waitForTimeout(600);
      let t = await text(page);
      T.chk(W + ': golf: the tabs are Leaderboard, Finishes and Model Health, Leaderboard open', /Finishes/.test(await page.locator('#simHost .sm-tabs').innerText()) && /Model Health/.test(await page.locator('#simHost .sm-tabs').innerText()) && (await page.locator('#simHost .sm-tabs button.on').innerText()) === 'Leaderboard');
      T.chk(W + ': golf Leaderboard: the event, the field with win/top 5/10/20, fair odds and the dead-heat note', /3,000 simulated tournaments/.test(t) && /Top 10/.test(t) && /dead-heat expectation/.test(t) && (await page.locator('#simHost .sm-tbl tbody tr').count()) > 50);
      if (golf.length > 1) T.chk(W + ': golf: a tour picker with every tour\'s event', (await page.locator('#simHost [data-sim-act="tour"]').count()) === golf.length);
      T.chk(W + ': golf Leaderboard: no horizontal page scroll (the table scrolls in its card)', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1), await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]));
      await shot(page, 'sim-golf-leaderboard-' + W);
      /* the table scrolls in its card under a sticky player column: bring the header into the open part first, as a reader would
         (mid-screen, clear of the fixed bottom bar, then sideways past the sticky column) */
      await page.evaluate(() => { const b = document.querySelector('#simHost [data-sim-act="sort"][data-sim-val="top_20"]') as HTMLElement, sc = b.closest('.sm-scroll') as HTMLElement, th = sc.querySelector('th') as HTMLElement;
        b.scrollIntoView({ block: 'center', inline: 'nearest' });
        sc.scrollLeft += b.getBoundingClientRect().left - sc.getBoundingClientRect().left - th.getBoundingClientRect().width - 8; });
      await page.click('#simHost [data-sim-act="sort"][data-sim-val="top_20"]'); await page.waitForTimeout(150);
      T.chk(W + ': golf Leaderboard: a column header sorts the table', (await page.locator('#simHost .sm-sort.on').innerText()).startsWith('Top 20'));
      await page.click('#simHost [data-sim-tab="finishes"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': golf Finishes: the most likely winners, where each player finishes, fair odds, the winning score', (await page.locator('#simHost .sm-club').count()) === 6 && /Where each player finishes/.test(t) && /Win American/.test(t) && /The winning score/.test(t));
      T.chk(W + ': golf Finishes: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-golf-finishes-' + W);
      await page.click('#simHost [data-sim-tab="model_health"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': golf Model Health: the backtest in plain words and what the model does not know', /Does it work\?/.test(t) && /What the model does not know/.test(t));
      T.chk(W + ': golf Model Health: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-golf-health-' + W);
      if (golf.length > 1) {
        const other = golf.find((x) => !x.comp.startsWith('pga-')) || golf[1], tr = other.comp.split('-')[0];
        await page.click('#simHost [data-sim-act="tour"][data-sim-val="' + tr + '"]'); await page.waitForTimeout(500);
        await page.click('#simHost [data-sim-tab="leaderboard"]'); await page.waitForTimeout(150);
        T.chk(W + ': golf: switching tour shows that tour\'s event', (await text(page)).includes((other.run.validation_summary as any).sport_summary.event.name));
        await shot(page, 'sim-golf-' + tr + '-' + W);
      }
      T.eq(W + ': golf: no page errors', errors, []);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, '#simulator/college_baseball', { entitled: true, published: true, soon: 'college_baseball' });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/college_baseball')); await page.waitForTimeout(300);
      const t = await text(page);
      T.chk('a sport that is not ACTIVE (college baseball, served as Coming Soon) shows its blockers and no number, even with a run published', /Coming Soon/i.test(t) && /TEST: out of season until February/.test(t) && !/\d+\.\d%/.test(t), t.slice(0, 300));
      await shot(page, 'sim-blocked-college-baseball-390'); await ctx.close();
    }
    /* college baseball (its own adapter: Road to Omaha, Conferences, Model Health) */
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width + 'w';
      const { ctx, page, errors } = await open(vp, '#simulator/college_baseball', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/college_baseball'));
      await page.waitForFunction(() => /Who gets to Omaha/.test((document.getElementById('simHost') as HTMLElement).innerText), null, { timeout: 15000 }).catch(() => {});
      let t = await text(page);
      T.chk(W + ': college baseball: the tabs are Road to Omaha, Conferences and Model Health, Road to Omaha open', /Conferences/.test(await page.locator('#simHost .sm-tabs').innerText()) && (await page.locator('#simHost .sm-tabs button.on').innerText()) === 'Road to Omaha');
      T.chk(W + ': college baseball: who gets to Omaha, the preseason stated, 40 teams then all', /Who gets to Omaha/.test(t) && /2027 preseason/.test(t) && /3,000 simulated seasons/.test(t) && (await page.locator('#simHost .sm-tbl tbody tr').count()) === 40, t.slice(0, 300));
      await page.click('#simHost [data-sim-act="all"]'); await page.waitForTimeout(150);
      T.eq(W + ': college baseball: show all lists every team', await page.locator('#simHost .sm-tbl tbody tr').count(), 120);
      T.chk(W + ': college baseball: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1), await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]));
      await shot(page, 'sim-cbase-road-' + W);
      await page.click('#simHost [data-sim-tab="conference"]'); await page.waitForTimeout(150);
      await page.click('#simHost [data-sim-act="conf"][data-sim-val="SWAC"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': college baseball Conferences: the list, then the picked conference', /Bids/.test(t) && /SWAC/.test(t) && (await page.locator('#simHost [data-sim-act="conf"][aria-current="true"]').innerText()) === 'SWAC');
      await shot(page, 'sim-cbase-conferences-' + W);
      await page.click('#simHost [data-sim-tab="model_health"]'); await page.waitForTimeout(150);
      t = await text(page);
      T.chk(W + ': college baseball Model Health: both backtests and what the model does not know', /Does the model call NCAA tournaments\?/.test(t) && /Does the Road to Omaha call a season/.test(t) && /What the model does not know/.test(t));
      T.chk(W + ': college baseball Model Health: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-cbase-health-' + W);
      T.eq(W + ': college baseball: no page errors', errors, []);
      await ctx.close();
    }
    /* tennis (its own adapter: Draws, Matches, Model Health; one competition per draw and one for the day's matches) */
    if (TENNIS_DRAWS.length) for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const W = vp.width + 'w';
      const { ctx, page, errors } = await open(vp, '#simulator/tennis', { entitled: true, published: true });
      await page.evaluate(() => (window as any).navHashRoute('#simulator/tennis'));
      /* every tennis run's summary, then the selected draw's and the matches' rows: wait for the title table, not a fixed time */
      await page.waitForFunction(() => /Who wins the title/.test((document.getElementById('simHost') as HTMLElement).innerText), null, { timeout: 15000 }).catch(() => {});
      let t = await text(page);
      T.chk(W + ': tennis: the tabs are Draws, Matches and Model Health, Draws open', /Matches/.test(await page.locator('#simHost .sm-tabs').innerText()) && (await page.locator('#simHost .sm-tabs button.on').innerText()) === 'Draws');
      T.chk(W + ': tennis Draws: the draw, who wins the title with fair odds', /3,000 simulated draws/.test(t) && /Who wins the title/.test(t) && /Draw order:/.test(t), t.slice(0, 400));
      if (TENNIS_DRAWS.length > 1) T.chk(W + ': tennis: a draw picker with every draw', (await page.locator('#simHost [data-sim-act="draw"]').count()) === TENNIS_DRAWS.length);
      T.chk(W + ': tennis Draws: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1), await page.evaluate(() => [document.scrollingElement!.scrollWidth, window.innerWidth]));
      await shot(page, 'sim-tennis-draws-' + W);
      if (TENNIS_DRAWS.length > 1) {
        const other = TENNIS_DRAWS[TENNIS_DRAWS.length - 1];
        await page.click('#simHost [data-sim-act="draw"][data-sim-val="' + other.comp + '"]'); await page.waitForTimeout(600);
        T.chk(W + ': tennis: picking another draw shows it', (await text(page)).includes((other.run.validation_summary as any).sport_summary.tournament.name));
      }
      await page.click('#simHost .sm-tabs button:has-text("Matches")'); await page.waitForTimeout(400); t = await text(page);
      T.chk(W + ': tennis Matches: every scheduled match with fair odds', /Every scheduled singles match/.test(t) || /No match prices have been published/.test(t));
      T.chk(W + ': tennis Matches: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-tennis-matches-' + W);
      await page.click('#simHost .sm-tabs button:has-text("Model Health")'); await page.waitForTimeout(400); t = await text(page);
      T.chk(W + ': tennis Model Health: the holdout and the draw backtest in plain words', /Does the match rating work\?/.test(t) && /Does the draw simulation call tournaments\?/.test(t));
      T.chk(W + ': tennis Model Health: no horizontal page scroll', await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth + 1));
      await shot(page, 'sim-tennis-health-' + W);
      T.eq(W + ': tennis: no page errors', errors, []);
      await ctx.close();
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
