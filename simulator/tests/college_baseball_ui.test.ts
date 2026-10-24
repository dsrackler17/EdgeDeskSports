/* ===========================================================================
   The college baseball views of the Simulator seat (lib/edgedesk_simulator_
   college_baseball.js), as pure functions over a run of the synthetic
   season (_college_baseball_fixture.ts) published through the publisher's
   own row builders: states, the Road to Omaha table with fair odds in both
   formats, show all, the conferences and the picker, Model Health from the
   committed backtests, escaping, never a number without entitlement.
     node simulator/tests/college_baseball_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/college_baseball/model.ts';
import { executeCbase } from '../src/sports/college_baseball/run.ts';
import { writeCbaseSnapshot } from '../src/sports/college_baseball/inputs.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';
import { syntheticSnapshot } from './_college_baseball_fixture.ts';

const req = createRequire(import.meta.url);
const T = kit('college baseball reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const W = req(path.join(REPO, 'lib', 'edgedesk_simulator_college_baseball.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const sport = SPORTS.sports.find((s: any) => s.key === 'college_baseball');
T.eq('the registry lists college baseball, ACTIVE, with its three tabs', [sport && sport.status, sport && sport.tabs.join()], ['ACTIVE', 'tournament,conference,model_health']);
T.eq('the adapter names the tabs Road to Omaha, Conferences, Model Health', [W.adapter.tabLabels.tournament, W.adapter.tabLabels.conference, W.adapter.tabLabels.model_health], ['Road to Omaha', 'Conferences', 'Model Health']);
T.eq('fair odds: 25% is 4.00 decimal and +300 American', [W.decimal(0.25), W.american(0.25)], ['4.00', '+300']);
T.chk('the public registry text never says "probability"', !/probability/i.test(JSON.stringify(sport)));

async function publishedRun(names?: (i: number) => string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbase-ui-'));
  const f = path.join(tmp, 'snap.json'); writeCbaseSnapshot(f, syntheticSnapshot({ names }));
  const o = await executeCbase({ season: 2027, runs: 3000, seed: '3', workers: 1, snapshot: f, out: path.join(tmp, 'out'), traceRuns: [], nowMs: Date.parse('2026-10-24T12:00:00Z') }, () => {});
  return o;
}
const o = await publishedRun();
const now = Date.parse('2026-10-24T14:00:00Z');
const r = o.results!;
const run = { run_id: 'r1', sport: 'college_baseball', competition: 'road-to-omaha', season: '2027', n_sims: 3000, seed: '3', model_version: r.run.model_version, rules_version: r.run.rules_version,
  input_snapshot_at: new Date(now - 3600e3).toISOString(), published_at: new Date(now - 3000e3).toISOString(), validation_summary: { checks: r.checks, flags: r.flags, sport_summary: (r as any).sport_summary } };
const pub = { status: { sport: 'college_baseball', season: '2027', competition: 'road-to-omaha', published_run_id: 'r1', published_at: run.published_at, last_attempt_status: 'completed', last_attempt_at: run.published_at }, entitled: true, run, results: resultRows(o as any), entities: entityRows(o as any), edges: [] };
const cache = (x: any = {}) => Object.assign({}, pub, x);
const paint = (c: any, tab: string) => W.adapter.paint({ sport, cache: c, tab, nowMs: now });
const S = (r as any).sport_summary;

/* states */
T.chk('not entitled: the Full Access card, no number', (() => { const h = paint(cache({ entitled: false, run: null, results: null }), 'tournament'); return /Full Access/.test(h) && !/\d+\.\d%/.test(h); })());
T.chk('nothing published: says so', /No simulation has been published for College Baseball/.test(paint(cache({ status: null, run: null }), 'tournament')));

/* Road to Omaha */
const h = paint(cache(), 'tournament');
T.chk('Road to Omaha: Estimated, the simulated-season count and the preseason stated', /Estimated/.test(h) && /3,000 simulated seasons/.test(h) && /2027 preseason/.test(h));
T.chk('Road to Omaha: the seven levels, with fair odds in both formats for the title', ['Field', 'Host', 'Top 8', 'Regional', 'Omaha', 'Final', 'Title'].every((l) => h.includes('<th>' + l + '</th>')) && (h.match(/<td class="sm-num">\d+\.\d\d · [+-]\d+<\/td>/g) || []).length >= 10);
T.eq('Road to Omaha: the first 40 teams, and a button to show all', [(h.match(/<tr><td><b>/g) || []).length, /Show all 120 teams/.test(h)], [40, true]);
T.eq('Road to Omaha: "show all" repaints with every team', [W.adapter.onAction('all', '1', cache()), (paint(cache({ showAll: true }), 'tournament').match(/<tr><td><b>/g) || []).length], ['paint', 120]);
const ents = (r as any).entities.slice().sort((a: any, b: any) => b.outcomes.win_title.probability - a.outcomes.win_title.probability);
T.chk('Road to Omaha: sorted by the title chance (the favourite first)', h.indexOf(UI.esc(ents[0].entity_name)) < h.indexOf(UI.esc(ents[5].entity_name)));

/* Conferences */
const c = paint(cache(), 'conference');
T.chk('Conferences: every conference with expected bids, hosts and Omaha teams', /Expected teams in the 64-team field/.test(c) && S.conferences.every((k: any) => c.includes(UI.esc(k.name.startsWith('none_') ? 'No conference' : k.name))));
T.chk('Conferences: the one with the most expected bids shown in detail, with the automatic-bid column', /Auto bid/.test(c) && /aria-current="true"/.test(c));
T.chk('Conferences: a conference without an automatic bid is marked and has no automatic-bid column', /\(no automatic bid\)/.test(c) && !/Auto bid/.test(paint(cache({ conf: 'DI Independent' }), 'conference')));
T.eq('Conferences: picking one repaints it', [W.adapter.onAction('conf', 'SWAC', cache()), /<div class="sm-h">SWAC/.test(paint(cache({ conf: 'SWAC' }), 'conference'))], ['paint', true]);
T.eq('Conferences: an unknown action is ignored', W.adapter.onAction('nope', 'x', cache()), null);

/* Model Health */
const m = paint(cache(), 'model_health');
T.chk('Model Health: the tournament backtest against every team equal and the seed lines, with intervals', /Does the model call NCAA tournaments\?/.test(m) && /Every team equal/.test(m) && /Seed lines/.test(m) && /\(-\d\.\d+ to -\d\.\d+\)/.test(m));
T.chk('Model Health: every season\'s champion, and the refused seasons named', /2025/.test(m) && /LSU/.test(m) && /2020: no tournament/.test(m));
T.chk('Model Health: the single games against a coin, by round', /The single tournament games/.test(m) && /super regionals/.test(m));
T.chk('Model Health: the season backtest from the preseason and four in-season checkpoints', /Does the Road to Omaha call a season before it is played\?/.test(m) && ['Preseason', '10 weeks out', '6 weeks out', '3 weeks out', '1 week out'].every((x) => m.includes(x)));
T.chk('Model Health: what the model does not know (the schedule first)', /What the model does not know/.test(m) && /The 2027 schedule/.test(m));
T.chk('Model Health: says plainly the title cannot be proved and Omaha is a coin', /cannot prove/.test(m) && /no better than a coin/.test(m));

/* escaping */
const oe = await publishedRun(() => EVIL);
const re = oe.results!;
const evil = { ...pub, run: { ...run, validation_summary: { checks: re.checks, flags: re.flags, sport_summary: (re as any).sport_summary } }, results: resultRows(oe as any), entities: entityRows(oe as any) };
for (const tab of ['tournament', 'conference', 'model_health']) {
  const x = paint(cache(evil), tab);
  T.chk('escaping (' + tab + '): hostile text never reaches the page as markup', !/<img/.test(x) && (tab === 'model_health' || /&lt;img/.test(x)));
}

/* the core shell */
T.eq('the shell shows the adapter\'s tab names', [UI.tabLabel(sport, 'tournament'), UI.tabLabel(sport, 'conference'), UI.tabLabel(sport, 'model_health')], ['Road to Omaha', 'Conferences', 'Model Health']);
UI.registerSport('college_baseball', W.adapter);
T.eq('the default tab is Road to Omaha', UI.defaultTab(sport), 'tournament');
process.exit(T.done());
