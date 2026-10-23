/* ===========================================================================
   The WNBA views of the Simulator seat (lib/edgedesk_simulator_wnba.js), as
   pure functions over a run built from the committed 2026 data and
   published through the publisher's own row builders: states, provenance,
   fair odds, escaping, never a number without entitlement.
     node simulator/tests/wnba_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/wnba/model_adapter.ts';
import { executeWnba } from '../src/sports/wnba/run.ts';
import { buildWnbaSnapshot } from '../src/sports/wnba/inputs.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';

const req = createRequire(import.meta.url);
const T = kit('WNBA reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const W = req(path.join(REPO, 'lib', 'edgedesk_simulator_wnba.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const sport = SPORTS.sports.find((s: any) => s.key === 'wnba');
T.eq('the registry lists the WNBA with its three tabs', sport && sport.tabs.join(), 'title,games,model_health');
T.eq('the adapter names the tabs Finals, Games, Model Health', [W.adapter.tabLabels.title, W.adapter.tabLabels.games, W.adapter.tabLabels.model_health], ['Finals', 'Games', 'Model Health']);
T.eq('fair American odds: 60% is -150, 40% is +150, 50% is -100', [W.american(0.6), W.american(0.4), W.american(0.5)], ['-150', '+150', '-100']);

const snap = await buildWnbaSnapshot({ offline: true });
if (!snap.data.remaining.length) {
  T.chk('the committed 2026 postseason is over: nothing to render (the run gate refuses it)', true);
  process.exit(T.done());
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wnba-ui-'));
const o = await executeWnba({ season: 2026, runs: 4000, seed: '3', workers: 1, snapshot: null, out, traceRuns: [], offline: true, nowMs: Date.parse(snap.data.as_of + 'T12:00:00Z') }, () => {});
const now = Date.parse(snap.data.as_of + 'T15:00:00Z');
const run = { run_id: 'r1', sport: 'wnba', season: '2026', n_sims: 4000, seed: '3', model_version: o.results.run.model_version, rules_version: o.results.run.rules_version, input_snapshot_at: new Date(now - 3600e3).toISOString(),
  published_at: new Date(now - 3000e3).toISOString(), validation_summary: { checks: o.results.checks, flags: o.results.flags, sport_summary: (o.results as any).sport_summary } };
const status = { sport: 'wnba', season: '2026', published_run_id: 'r1', published_at: run.published_at, last_attempt_status: 'completed', last_attempt_at: run.published_at };
const results = resultRows(o), entities = entityRows(o);
const cache = (x: any = {}) => Object.assign({ status, entitled: true, run, results, entities, edges: [] }, x);
const paint = (c: any, tab: string) => W.adapter.paint({ sport, cache: c, tab, nowMs: now });

/* states (shared gate) */
T.chk('not entitled: the Full Access card, no probability', (() => { const h = paint(cache({ entitled: false, run: null, results: null }), 'title'); return /Full Access/.test(h) && !/\d+\.\d%/.test(h); })());
T.chk('nothing published: says so', /No simulation has been published for WNBA yet/.test(paint(cache({ status: null, run: null }), 'title')));
T.chk('a failed latest attempt with nothing published: says so', /latest attempt failed/.test(paint(cache({ status: { sport: 'wnba', season: '2026', published_run_id: null, last_attempt_status: 'failed' }, run: null }), 'title')));

/* Finals */
const fin = paint(cache(), 'title');
T.chk('Finals: the series state as it stands (Observed), with the next game', /sm-observed/.test(fin) && /(leads|tied)/.test(fin) && /Next: game \d/.test(fin));
T.chk('Finals: each finalist\'s title chance with fair decimal and American odds', (fin.match(/win the title · fair \d+\.\d\d \([+-]\d+\)/g) || []).length === 2);
T.chk('Finals: the exact series results, each with fair odds', /Exact series result/.test(fin) && /in [4-7]<\/td>/.test(fin));
T.chk('Finals: the bracket so far, every round', /First round:/.test(fin) && /Semifinals:/.test(fin) && /Finals:/.test(fin));
T.chk('Finals: the EXPERIMENTAL label and the run\'s count of simulated postseasons', /EXPERIMENTAL/.test(fin) && /4,000 simulated postseasons/.test(fin));
/* Games */
const games = paint(cache(), 'games');
T.chk('Games: every remaining game with how often it is played and the board price', (games.match(/<td>G\d<\/td>/g) || []).length === snap.data.remaining.length && /Board price/.test(games));
T.chk('Games: the first remaining game is played in every simulated postseason', /<td class="sm-num">100\.0%<\/td>/.test(games));
T.chk('Games: every played playoff game with its score and the model\'s pre-game chance', (games.match(/class="sm-num">\d+–\d+/g) || []).length === snap.data.series.reduce((a, s) => a + s.games.filter((g) => g.status === 'FINAL').length, 0));
/* Model Health */
const h = paint(cache(), 'model_health');
T.chk('Model Health: the four windows with Brier, log loss, coin and home-rate baselines', (h.match(/<tr><td>(2026|playoffs|regular)/g) || []).length === 4 && /0\.693/.test(h));
T.chk('Model Health: playoff calibration bins and the shared offset with its holdout', /Calibration, playoff games since 2010/.test(h) && /held out, was more volatile/.test(h));

/* escaping */
const evilEnt = entities.map((e) => Object.assign({}, e, { entity_name: EVIL + e.entity_name }));
const evilRun = JSON.parse(JSON.stringify(run)); evilRun.validation_summary.sport_summary.series.forEach((s: any) => { s.names = s.names.map((n: string) => EVIL + n); });
for (const tab of ['title', 'games', 'model_health']) {
  const x = paint(cache({ entities: evilEnt, run: evilRun }), tab);
  T.chk('escaping (' + tab + '): hostile names never reach the page as markup', !/<img/.test(x) && (tab === 'model_health' || /&lt;img/.test(x)));
}
/* the core shell uses the adapter's tab names */
T.eq('the shell shows the adapter\'s tab names', [UI.tabLabel(sport, 'title'), UI.tabLabel(sport, 'games')], ['Finals', 'Games']);
UI.registerSport('wnba', W.adapter);
T.eq('the default tab is Finals', UI.defaultTab(sport), 'title');

process.exit(T.done());
