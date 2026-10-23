/* ===========================================================================
   The UFC views of the Simulator seat (lib/edgedesk_simulator_ufc.js), as
   pure functions over a run built from the committed data and published
   through the publisher's own row builders: states, provenance, fair odds
   in both formats, the title path and its rule, the model record, escaping,
   never a number without entitlement.
     node simulator/tests/ufc_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/ufc/elo.ts';
import { executeUfc } from '../src/sports/ufc/run.ts';
import { buildUfcSnapshot } from '../src/sports/ufc/inputs.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';

const req = createRequire(import.meta.url);
const T = kit('UFC reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const W = req(path.join(REPO, 'lib', 'edgedesk_simulator_ufc.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const sport = SPORTS.sports.find((s: any) => s.key === 'ufc');
T.eq('the registry lists the UFC, ACTIVE, with its three tabs', [sport && sport.status, sport && sport.tabs.join()], ['ACTIVE', 'fights,title_path,model_health']);
T.eq('the adapter names the tabs Fights, Title Path, Model Health', [W.adapter.tabLabels.fights, W.adapter.tabLabels.title_path, W.adapter.tabLabels.model_health], ['Fights', 'Title Path', 'Model Health']);
T.eq('fair American odds: 60% is -150, 40% is +150; fair decimal 1/p', [W.american(0.6), W.american(0.4), W.decimal(0.4)], ['-150', '+150', '2.50']);
T.eq('a simulated share carries its ± (1.96 x the sampling error)', W.share({ count: 4000, probability: 0.4, mcse: 0.0049 }), '40.0% ±1.0');
T.chk('the public registry text never says "probability"', !/probability/i.test(JSON.stringify(sport)));

const snap = buildUfcSnapshot();
const nowRun = Date.parse(snap.data.rankings.fetched_at) + 3600e3;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-ui-'));
const o = await executeUfc({ season: 2026, runs: 4000, seed: '3', workers: 1, snapshot: null, out, traceRuns: [], nowMs: nowRun }, () => {});
const now = nowRun + 7200e3;
const run = { run_id: 'r1', sport: 'ufc', season: '2026', n_sims: 4000, seed: '3', model_version: o.results.run.model_version, rules_version: o.results.run.rules_version, input_snapshot_at: new Date(now - 3600e3).toISOString(),
  published_at: new Date(now - 3000e3).toISOString(), validation_summary: { checks: o.results.checks, flags: o.results.flags, sport_summary: (o.results as any).sport_summary } };
const status = { sport: 'ufc', season: '2026', published_run_id: 'r1', published_at: run.published_at, last_attempt_status: 'completed', last_attempt_at: run.published_at };
const results = resultRows(o), entities = entityRows(o);
const cache = (x: any = {}) => Object.assign({ status, entitled: true, run, results, entities, edges: [] }, x);
const paint = (c: any, tab: string) => W.adapter.paint({ sport, cache: c, tab, nowMs: now });

/* states (the shared gate) */
T.chk('not entitled: the Full Access card, no number', (() => { const h = paint(cache({ entitled: false, run: null, results: null }), 'fights'); return /Full Access/.test(h) && !/\d+\.\d%/.test(h); })());
T.chk('nothing published: says so', /No simulation has been published for UFC yet/.test(paint(cache({ status: null, run: null }), 'fights')));
T.chk('a failed latest attempt with nothing published: says so', /latest attempt failed/.test(paint(cache({ status: { sport: 'ufc', season: '2026', published_run_id: null, last_attempt_status: 'failed' }, run: null }), 'title_path')));
T.chk('a run without its summary says so instead of failing', /no fight summary/.test(paint(cache({ run: Object.assign({}, run, { validation_summary: {} }) }), 'fights')));

/* Fights */
const S = (o.results as any).sport_summary;
const nBouts = S.cards.reduce((a: number, c: any) => a + c.bouts.length, 0);
const fights = paint(cache(), 'fights');
T.chk('Fights: the EXPERIMENTAL label and the count of simulated runs', /EXPERIMENTAL/.test(fights) && /4,000 simulated runs/.test(fights));
T.chk('Fights: every card by date, UFC 333 first', (fights.match(/class="sm-sub"/g) || []).length === S.cards.length && fights.indexOf('UFC 333') < fights.indexOf('UFC 335'));
T.chk('Fights: every bout with both fighters\' win shares and ±', (fights.match(/<b>\d+\.\d% ±\d/g) || []).length === 2 * nBouts);
T.chk('Fights: fair decimal and American odds for every fighter', (fights.match(/no margin">\d+\.\d\d · [+-]\d+<\/div>/g) || []).length === 2 * nBouts);
T.chk('Fights: finish v decision and the round of a finish for every bout', (fights.match(/Ends in a finish \d/g) || []).length === nBouts && (fights.match(/Finish by round: R1 /g) || []).length === nBouts && /R5 \d/.test(fights));
T.chk('Fights: the four title fights carry the title badge and the chance of a new champion', (fights.match(/ title<\/span>/g) || []).length === 4 && (fights.match(/New champion:<\/b> \d+\.\d% ±/g) || []).length === 4);
T.chk('Fights: the ufc.com champion and ranks beside the names, and debutants marked', /Champion<\/span>/.test(fights) && /#1 Featherweight/.test(fights) && /UFC debut/.test(fights));
T.chk('Fights: the served price and the loop\'s published value', /Served Elo price: Alexander Volkanovski 45\.9% \(the model loop published 45\.93%\)/.test(fights));
T.chk('Fights: the method is never split into KO and submission', !/KO\/TKO \d|Submission \d/.test(fights));
/* Title Path */
const tp = paint(cache(), 'title_path');
T.chk('Title Path: Estimated, the horizon and the matchmaking rule in plain words', /sm-estimated/.test(tp) && /Who becomes champion by/.test(tp) && /highest-ranked contender who is coming off a win/.test(tp) && /EdgeDesk’s rule, not the UFC’s/.test(tp));
T.chk('Title Path: eleven divisions, each with its champion and pace', (tp.match(/<div class="sm-h">[^<]+ <span class="sm-dim sm-small">champion /g) || []).length === 11 && (tp.match(/undisputed title fights in the five years to/g) || []).length === 11);
T.chk('Title Path: the booked title fights named, the others say none is booked', (tp.match(/Booked title fight:/g) || []).length === 4 && (tp.match(/No title fight booked/g) || []).length === 7);
T.chk('Title Path: every contender row with hold, win, shot and beat-the-champion columns', /Champion at horizon/.test(tp) && /Beats the champion if given the shot/.test(tp) && /Movsar Evloev/.test(tp));
T.chk('Title Path: contenders with no shot in any simulated year are listed apart with the reason', /No title shot in any simulated year:<\/b> [^<]*Alexandre Pantoja \(#1, coming off a loss\)/.test(tp));
T.chk('Title Path: how champions are priced, by period, and what is not modelled', /From 2014 to 2020 champions won 71 of 100 where it expected 54\.8 — it underrated them then; since 2021 champions have won about as many title fights as it expected \(52 of 87, expected 51\.2\)/.test(tp)
  && /A champion term is tested every week/.test(tp) && !/understate/.test(tp) && /Interim belts/.test(tp));
T.chk('Title Path: a contender who moved divisions is named under the division they left', /booked in another division \(counted there\): [^<]*Diego Lopes \(Lightweight\)/.test(tp));
/* Model Health */
const h = paint(cache(), 'model_health');
T.chk('Model Health: the reproduction check and the three windows beside a coin', /reproduces every price the loop published: 25 of 25/.test(h) && (h.match(/<tr><td>(validation|holdout|2026)/g) || []).length === 3 && /0\.693/.test(h));
T.chk('Model Health: the plain-language verdict and no closing-price test', /better than a coin flip, but not by much/.test(h) && /never been compared with closing prices/.test(h));
T.chk('Model Health: champions against the Elo, and the finish model out of sample', /champions won <b>\d+<\/b>; the Elo expected about <b>\d+<\/b>/.test(h) && /tested on [\d,]+ later bouts/.test(h));
T.chk('Model Health: the title record in two periods', /<tr><td>2014–2020<\/td><td class="sm-num">100<\/td><td class="sm-num">71<\/td><td class="sm-num">54\.8<\/td><td class="sm-num">\+16\.2<\/td><\/tr>/.test(h) && /<tr><td>2021–2026<\/td><td class="sm-num">87<\/td>/.test(h));
T.chk('Model Health: the champion term, not served, with its latest weekly test in plain words', /The champion term\.<\/b> The model loop tests, every week, giving the champion going in 100 extra rating points/.test(h)
  && /Latest test, [^:]+: <b>not adopted<\/b>\. Over every bout since 2016 it moved the log loss by \+0\.00009 \(lower is better; adopting it takes a fall of at least 0\.0005\), and on 2025 alone by \+0\.00241\./.test(h) && /title fights are priced without one/.test(h));
T.chk('Model Health: a served champion term is stated as served', (() => { const r2 = JSON.parse(JSON.stringify(run)); r2.validation_summary.sport_summary.model_health.champion_term.served_bonus = 100;
  const x = paint(cache({ run: r2 }), 'model_health'); return /gives the champion going in 100 extra rating points/.test(x) && !/Latest test/.test(x); })());

/* escaping */
const evilEnt = entities.map((e) => Object.assign({}, e, { entity_name: EVIL + e.entity_name }));
const evilRes = results.map((r) => Object.assign({}, r, { entity_name: EVIL + r.entity_name }));
const evilRun = JSON.parse(JSON.stringify(run));
const ss = evilRun.validation_summary.sport_summary;
ss.cards.forEach((c: any) => { c.event = EVIL + c.event; c.bouts.forEach((b: any) => { b.a.name = EVIL + b.a.name; b.b.name = EVIL + b.b.name; b.weight_class = EVIL; }); });
ss.divisions.forEach((v: any) => { v.people.forEach((p: any) => { p.name = EVIL + p.name; }); });
ss.model_health.market = EVIL; ss.matchmaking.min_rest_days = EVIL;
for (const tab of ['fights', 'title_path', 'model_health']) {
  const x = paint(cache({ entities: evilEnt, results: evilRes, run: evilRun }), tab);
  T.chk('escaping (' + tab + '): hostile text never reaches the page as markup', !/<img/.test(x) && /&lt;img/.test(x));
}
/* the core shell */
T.eq('the shell shows the adapter\'s tab names', [UI.tabLabel(sport, 'fights'), UI.tabLabel(sport, 'title_path'), UI.tabLabel(sport, 'model_health')], ['Fights', 'Title Path', 'Model Health']);
UI.registerSport('ufc', W.adapter);
T.eq('the default tab is Fights', UI.defaultTab(sport), 'fights');

process.exit(T.done());
