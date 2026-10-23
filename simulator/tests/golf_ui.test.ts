/* ===========================================================================
   The golf views of the Simulator seat (lib/edgedesk_simulator_golf.js), as
   pure functions over runs built from the committed feeds (the current tour
   events, simulated offline) and published through the publisher's own row
   builders: the tour picker, states, provenance, sorting, fair odds, the
   dead-heat explanation, the backtest in plain words, escaping, never a
   number without entitlement; and the loader over several competitions
   against a SYNTHETIC database answer.
     node simulator/tests/golf_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/golf/model.ts';
import { executeGolf } from '../src/sports/golf/run.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';

const req = createRequire(import.meta.url);
const T = kit('golf reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const G = req(path.join(REPO, 'lib', 'edgedesk_simulator_golf.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const sport = SPORTS.sports.find((s: any) => s.key === 'golf');
T.eq('the registry lists golf with Leaderboard, Finishes and Model Health', sport && sport.tabs.join(), 'leaderboard,finishes,model_health');
T.eq('the adapter names its tabs', [G.adapter.tabLabels.leaderboard, G.adapter.tabLabels.finishes, G.adapter.tabLabels.model_health], ['Leaderboard', 'Finishes', 'Model Health']);
T.eq('fair American odds: 60% is -150, 40% is +150, 10% is +900', [G.american(0.6), G.american(0.4), G.american(0.1)], ['-150', '+150', '+900']);
T.chk('the registry text carries no probability and every limitation names what is not modelled', !/probab/i.test(JSON.stringify(sport)) && /course fit/.test(sport.limitations.join(' ')) && /tee-time wave/.test(sport.limitations.join(' ')));

/* the committed current events, simulated offline (3,000 runs: a reader test, not a forecast) */
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'golf-ui-'));
const o = await executeGolf({ season: 2026, runs: 3000, seed: '5', workers: 1, snapshot: null, out, traceRuns: [], offline: true }, () => {});
if (!o.runs.length) { T.chk('no tour event in play in the committed feed: nothing to render (each skip has its reason)', o.skipped.every((s) => s.reason.length > 0)); process.exit(T.done()); }
const pick = o.runs.find((r) => r.results.run.competition.startsWith('pga-')) || o.runs[0];
const comp = pick.results.run.competition, tour = comp.split('-')[0];
const S0 = (pick.results as any).sport_summary;
const now = Date.parse(S0.as_of) + 3600e3;
const runOf = (r: typeof pick, id: string) => ({ run_id: id, sport: 'golf', competition: r.results.run.competition, season: '2026', n_sims: r.results.run.n_sims, seed: r.results.run.seed, model_version: r.results.run.model_version, rules_version: r.results.run.rules_version,
  input_snapshot_at: new Date(now - 1800e3).toISOString(), published_at: new Date(now - 1200e3).toISOString(), validation_summary: { checks: r.results.checks, flags: r.results.flags, sport_summary: (r.results as any).sport_summary } });
const run = runOf(pick, 'g1');
const status = { sport: 'golf', competition: comp, season: '2026', published_run_id: 'g1', published_at: run.published_at, input_snapshot_at: run.input_snapshot_at, last_attempt_status: 'completed', last_attempt_at: run.published_at };
const results = resultRows(pick as any), entities = entityRows(pick as any);
const events: any = {}; for (const r of o.runs) { const t = r.results.run.competition.split('-')[0]; events[t] = { competition: r.results.run.competition, row: { ...status, competition: r.results.run.competition } }; }
const cache = (x: any = {}) => Object.assign({ status, entitled: true, run, results, entities, edges: [], events, tour, byComp: {} }, x);
/* the views are tested on an ACTIVE copy of the registry entry (TEST ONLY: whether golf is ACTIVE is the backtest's
   business, registry.ts); the entry as it stands is tested for its blocked state below */
const active = { ...sport, status: 'ACTIVE', blockers: [] };
const paint = (c: any, tab: string) => G.adapter.paint({ sport: active, cache: c, tab, nowMs: now });
if (sport.status !== 'ACTIVE') T.chk('the registry entry as it stands is BLOCKED: its blockers are shown, never a number', (() => { const h = G.adapter.paint({ sport, cache: cache(), tab: 'leaderboard', nowMs: now }); return /Blocked/.test(h) && sport.blockers.every((b: string) => h.includes(UI.esc(b))) && !/\d+\.\d%/.test(h); })());

/* states (the shared gate) */
T.chk('not entitled: the Full Access card, no probability', (() => { const h = paint(cache({ entitled: false, run: null, results: null }), 'leaderboard'); return /Full Access/.test(h) && !/\d+\.\d%/.test(h); })());
T.chk('nothing published: says so', /No simulation has been published for Golf yet/.test(paint(cache({ status: null, run: null, events: {} }), 'leaderboard')));
T.chk('a failed latest attempt with nothing published: says so', /latest attempt failed/.test(paint(cache({ status: { sport: 'golf', season: '2026', competition: comp, published_run_id: null, last_attempt_status: 'failed' }, run: null }), 'leaderboard')));

/* Leaderboard */
const lb = paint(cache(), 'leaderboard');
const nPlayers = S0.leaderboard.length;
T.chk('Leaderboard: the event card as it stands (Observed), its stage and the leaderboard time', /sm-observed/.test(lb) && /(Round \d of \d in progress|After round \d of \d|Before round 1)/.test(lb) && /leaderboard read/.test(lb));
T.chk('Leaderboard: the cut as measured (pending with its rule and projected line, made, or none) and its provenance', S0.cut.state === 'pending' ? /top \d+ and ties/.test(lb) && /Projected cut line/.test(lb) : S0.cut.state === 'made' ? /The cut has been made/.test(lb) : /No cut/.test(lb));
T.chk('Leaderboard: every player of the field is a row', (lb.match(/<tr><td><span class="sm-dim">/g) || []).length === nPlayers);
T.chk('Leaderboard: win, top 5/10/20 (and the cut when there is one) with the Monte Carlo ±', /Top 5/.test(lb) && /Top 10/.test(lb) && /Top 20/.test(lb) && /sm-pm">±/.test(lb) && (S0.cut.state === 'none' || /Make cut/.test(lb)));
T.chk('Leaderboard: fair decimal odds with American under them, and how many simulated tournaments each won', /<td class="sm-num">\d+\.\d\d<span class="sm-pm">[+-]\d+<\/span><\/td>/.test(lb) && /title="Simulated tournaments won/.test(lb));
T.chk('Leaderboard: the dead-heat expectation explained under the table', /dead-heat expectation/.test(lb) && /simulation noise, not model error/.test(lb));
T.chk('Leaderboard: the EXPERIMENTAL label and the run\'s count of simulated tournaments', /EXPERIMENTAL/.test(lb) && /3,000 simulated tournaments/.test(lb));
const out1 = S0.leaderboard.filter((p: any) => p.status !== 'active');
if (out1.length) { const lastRows = lb.split('<tr><td>').slice(-out1.length).join(''); T.chk('Leaderboard: players out of the event (MC, WD) are listed last', out1.every((p: any) => lastRows.includes(UI.esc(p.name)))); }
/* sorting */
const c1 = cache();
T.eq('sorting is the adapter\'s own control: a repaint, not a reload', G.adapter.onAction('sort', 'top_20', c1), 'paint');
const firstName = (h: string) => (h.match(/<tr><td><span class="sm-dim">[^<]*<\/span> <b>([^<]+)<\/b>/) || [])[1];
const byT20 = results.filter((r: any) => r.outcome === 'top_20').sort((a: any, b: any) => b.probability - a.probability)[0];
T.eq('...sorted by top 20, the top-20 favourite leads', firstName(paint(c1, 'leaderboard')), UI.esc(byT20 ? byT20.entity_name : ''));
T.eq('...a second click reverses it', G.adapter.onAction('sort', 'top_20', c1) && c1.sort.dir, 'asc');
T.eq('an unknown sort key is ignored', G.adapter.onAction('sort', 'evil"key', cache()), null);

/* Finishes */
const fi = paint(cache(), 'finishes');
T.chk('Finishes: the six most likely winners with fair decimal and American odds and their simulated wins', (fi.match(/fair \d+\.\d\d \([+-]\d+\) · won [\d,]+ of 3,000/g) || []).length === 6);
T.chk('Finishes: where each player finishes, in bands, with the most likely band, the median and the average place', /Where each player finishes/.test(fi) && /<th class="sm-num">2–5<\/th>/.test(fi) && /Most likely/.test(fi) && /Median/.test(fi));
const rowPcts = (fi.split('Where each player finishes')[1] || '').split('<tr><td><b>').slice(1, 6).map((r: string) => (r.match(/>([\d.]+)%</g) || []).map((x: string) => Number(x.replace(/[>%<]/g, ''))).reduce((a: number, b: number) => a + b, 0));
T.chk('Finishes: each player\'s bands sum to 100% (within rounding)', rowPcts.length > 0 && rowPcts.every((s: number) => Math.abs(s - 100) < 1.2), rowPcts);
T.chk('Finishes: fair odds for every market in decimal AND American', /Win decimal/.test(fi) && /Win American/.test(fi) && /Top 10 decimal/.test(fi) && /dead heat/.test(fi));
T.chk('Finishes: the projected winning score', /The winning score/.test(fi) && /moves the scores, never who beats whom/.test(fi));

/* Model Health */
const mh = paint(cache(), 'model_health');
const bt = fs.existsSync(path.join(REPO, 'simulator', 'data', 'golf_backtest.json'));
if (bt) {
  T.chk('Model Health: the holdout backtest in plain words (events, the winner and top 10 against the field-size baseline)', /Does it work\?/.test(mh) && /Picking the winner before round 1: log loss \d\.\d{4} against \d\.\d{4}/.test(mh) && /(better|worse|not better)/.test(mh));
  T.chk('Model Health: the before-round-1 and after-round-2 tables with every baseline', /Before round 1: log loss/.test(mh) && /After round 2/.test(mh) && /Scores only/.test(mh) && /Skill as a point/.test(mh) && /Field size/.test(mh));
  T.chk('Model Health: calibration tables (top 10, the cut, the winner)', /Calibration: Top 10, before round 1/.test(mh) && /Calibration: Win/.test(mh));
} else T.chk('Model Health: no committed backtest -> says so', /no backtest record/.test(mh));
T.chk('Model Health: what the model does not know (course fit, weather and the tee-time wave, injuries)', bt ? /course fit/i.test(mh) && /tee-time wave/.test(mh) && /Injuries/.test(mh) : true);

/* the tour picker and the loader over several competitions */
if (Object.keys(events).length > 1) {
  const h = paint(cache(), 'leaderboard');
  T.chk('the tour picker lists each tour with a published event, the current one marked', (h.match(/data-sim-act="tour"/g) || []).length === Object.keys(events).length && /aria-current="page">[^<]*Tour/.test(h));
}
const c2 = cache({ events: { pga: events[tour] || { competition: comp, row: status }, lpga: { competition: 'lpga-1', row: { ...status, competition: 'lpga-1' } } }, byComp: {} });
T.eq('switching to a tour not loaded yet asks for a load', G.adapter.onAction('tour', 'lpga', c2), 'load');
T.eq('...and to an unknown tour is ignored', G.adapter.onAction('tour', 'nope', c2), null);
{
  /* SYNTHETIC database answer: two PGA Tour events (the newer wins), one LPGA event never published */
  const calls: string[] = [];
  const rows = [
    { sport: 'golf', competition: 'pga-100', season: '2026', published_run_id: 'old', input_snapshot_at: '2026-10-10T10:00:00Z', published_at: '2026-10-10T10:30:00Z', last_attempt_status: 'completed' },
    { sport: 'golf', competition: 'pga-200', season: '2026', published_run_id: 'new', input_snapshot_at: '2026-10-23T10:00:00Z', published_at: '2026-10-23T10:30:00Z', last_attempt_status: 'completed' },
    { sport: 'golf', competition: 'lpga-300', season: '2026', published_run_id: null, input_snapshot_at: null, last_attempt_status: 'failed', last_attempt_at: '2026-10-23T10:00:00Z' },
    { sport: 'nfl', competition: 'NFL', season: '2026', published_run_id: 'x' }];
  const get = async (q: string) => { calls.push(q); if (q === 'rpc/sim_public_status') return rows; if (q === 'rpc/sim_viewer_entitled') return true; if (/^sim_current_runs/.test(q)) return [{ ...run, run_id: 'new', competition: 'pga-200' }]; return []; };
  const c: any = {};
  await G.adapter.load(get, c, { sport });
  T.eq('SYNTHETIC loader: each tour\'s latest published event, the PGA Tour selected first', [c.events.pga.competition, c.events.lpga.competition, c.tour, c.run && c.run.run_id], ['pga-200', 'lpga-300', 'pga', 'new']);
  T.chk('SYNTHETIC loader: the run is read for that one competition', calls.some((q) => /^sim_current_runs\?sport=eq\.golf&season=eq\.2026&competition=eq\.pga-200/.test(q)));
  T.eq('SYNTHETIC loader: switching to the LPGA (nothing published there) reloads', G.adapter.onAction('tour', 'lpga', c), 'load');
  await G.adapter.load(get, c, { sport });
  T.chk('SYNTHETIC loader: the LPGA\'s failed attempt says nothing was published, with the picker still shown', /latest attempt failed/.test(paint(c, 'leaderboard')) && /data-sim-act="tour"/.test(paint(c, 'leaderboard')));
}

/* escaping */
const evilEnt = entities.map((e: any) => Object.assign({}, e, { entity_name: EVIL + e.entity_name }));
const evilRes = results.map((r: any) => Object.assign({}, r, { entity_name: EVIL + r.entity_name }));
const evilRun = JSON.parse(JSON.stringify(run));
evilRun.validation_summary.sport_summary.leaderboard.forEach((p: any) => { p.name = EVIL + p.name; p.position = EVIL; });
evilRun.validation_summary.sport_summary.event.name = EVIL; evilRun.validation_summary.sport_summary.event.course = EVIL; evilRun.validation_summary.sport_summary.cut.source = EVIL;
for (const tab of ['leaderboard', 'finishes', 'model_health']) {
  const x = paint(cache({ entities: evilEnt, results: evilRes, run: evilRun }), tab);
  T.chk('escaping (' + tab + '): hostile names never reach the page as markup', !/<img/.test(x) && (tab === 'model_health' || /&lt;img/.test(x)));
}
/* the core shell uses the adapter's names and default */
UI.registerSport('golf', G.adapter);
T.eq('the shell shows the adapter\'s tab names; the default tab is the Leaderboard', [UI.tabLabel(sport, 'leaderboard'), UI.tabLabel(sport, 'finishes'), UI.defaultTab(sport)], ['Leaderboard', 'Finishes', 'leaderboard']);

process.exit(T.done());
