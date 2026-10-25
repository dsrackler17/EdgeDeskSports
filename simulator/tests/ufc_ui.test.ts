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
T.chk('Fights: every card by date (' + S.cards.length + ' cards)', (fights.match(/class="sm-sub"/g) || []).length === S.cards.length && S.cards.every((c: any, i: number) => i === 0 || S.cards[i - 1].date <= c.date)
  && S.cards.every((c: any, i: number) => i === 0 || fights.indexOf(UI.esc(S.cards[i - 1].event)) < fights.indexOf(UI.esc(c.event))));
T.chk('Fights: every bout with both fighters\' win shares and ±', (fights.match(/<b>\d+\.\d% ±\d/g) || []).length === 2 * nBouts);
const allBouts = [].concat(...S.cards.map((c: any) => c.bouts)) as any[];
const nDis = allBouts.filter((b) => b.guard && b.guard.status === 'DISAGREES').length;
T.chk('Fights: fair decimal and American odds for every fighter whose bout agrees with the market (or has no price), withheld where it disagrees ('
  + nDis + ' bouts)', (fights.match(/no margin">\d+\.\d\d · [+-]\d+<\/div>/g) || []).length === 2 * (nBouts - nDis) && (fights.match(/>fair odds withheld</g) || []).length === 2 * nDis);
T.chk('Fights: every bout shows the model beside the market (or says there is no price)', (fights.match(/<b>Model v market<\/b>/g) || []).length === nBouts);
T.chk('Fights: a disagreement is labelled, says it is not an edge, and lists what the model likely misreads or says none is present',
  nDis === 0 || ((fights.match(/class="sm-guard"><span class="sm-tag sm-dis">Model disagrees with market<\/span>/g) || []).length === nDis
    && (fights.match(/Not an edge: the model and the market differ by more than \d+ points/g) || []).length === nDis
    && (fights.match(/What the model likely misreads here:|None of the factors the model is known to misread/g) || []).length === nDis));
T.chk('Fights: a disagreeing title fight withholds the new champion\'s fair odds too', (fights.match(/<b>New champion:<\/b> [^<]*<span class="sm-dim">· fair odds withheld<\/span>/g) || []).length === allBouts.filter((b) => b.title && b.guard && b.guard.status === 'DISAGREES').length);
T.chk('Fights: the guard never shows a signal without certification', allBouts.every((b) => !b.guard || !b.guard.signal_allowed || b.guard.certified));
T.chk('Fights: finish v decision and the round of a finish for every bout', (fights.match(/Ends in a finish \d/g) || []).length === nBouts && (fights.match(/Finish by round: R1 /g) || []).length === nBouts && /R5 \d/.test(fights));
/* the cards change every week (a card leaves the data once it starts), so the counts come from the run itself */
const nTitles = allBouts.filter((b) => b.title).length;
T.chk('Fights: the ' + nTitles + ' booked title fights carry the title badge and the chance of a new champion', (fights.match(/ title<\/span>/g) || []).length === nTitles && (fights.match(/New champion:<\/b> \d+\.\d% ±/g) || []).length === nTitles);
const sides = allBouts.flatMap((b) => [b.a, b.b]);
const nRanked = sides.filter((x) => !x.champion && typeof x.rank === 'number').length;
T.chk('Fights: the ufc.com champion and ranks beside the names (' + nRanked + ' ranked), and debutants marked', (fights.match(/title="ufc\.com champion">Champion<\/span>/g) || []).length === sides.filter((x) => x.champion).length
  && nRanked > 0 && (fights.match(/title="ufc\.com ranking">#\d+ [^<]+<\/span>/g) || []).length === nRanked && /UFC debut/.test(fights));
/* the loop lists only bouts that have not started: the first booked bout it published */
const pubB = allBouts.find((b) => b.published_p_a != null);
T.chk('Fights: the served price and the loop\'s published value (' + (pubB ? pubB.a.name + ' ' + (100 * pubB.served_p_a).toFixed(1) + '%' : 'no bout listed') + ')', !!pubB
  && fights.indexOf('Served Elo price: ' + UI.esc(pubB.a.name) + ' ' + (100 * pubB.served_p_a).toFixed(1) + '% (the model loop published ' + (100 * pubB.published_p_a).toFixed(2) + '%)') >= 0);
T.chk('Fights: the method is never split into KO and submission', !/KO\/TKO \d|Submission \d/.test(fights));
/* Title Path */
const tp = paint(cache(), 'title_path');
T.chk('Title Path: Estimated, the horizon and the matchmaking rule in plain words', /sm-estimated/.test(tp) && /Who becomes champion by/.test(tp) && /highest-ranked contender who is coming off a win/.test(tp) && /EdgeDesk’s rule, not the UFC’s/.test(tp));
T.chk('Title Path: eleven divisions, each with its champion and pace', (tp.match(/<div class="sm-h">[^<]+ <span class="sm-dim sm-small">champion /g) || []).length === 11 && (tp.match(/undisputed title fights in the five years to/g) || []).length === 11);
const titleDivs = new Set(allBouts.filter((b) => b.title).map((b) => b.title.division)).size;
T.chk('Title Path: the booked title fights named (' + titleDivs + ' divisions), the others say none is booked', (tp.match(/Booked title fight:/g) || []).length === titleDivs && (tp.match(/No title fight booked/g) || []).length === 11 - titleDivs);
/* rankings and bookings change every week, so the people named here are read from the run */
const nameRow = (x: any) => tp.indexOf('<td><b>' + UI.esc(x.name) + '</b>') >= 0;
T.chk('Title Path: every contender row with hold, win, shot and beat-the-champion columns', /Champion at horizon/.test(tp) && /Beats the champion if given the shot/.test(tp)
  && S.divisions.every((v: any) => v.people.filter((x: any) => x.champion).every(nameRow)) && S.divisions.some((v: any) => v.people.some((x: any) => !x.champion && nameRow(x))));
T.chk('Title Path: contenders with no shot in any simulated year are listed apart with the reason', /No title shot in any simulated year:<\/b> [^<]*\(#\d+, [^)]+\)/.test(tp));
const TP = S.model_health.title_record.periods;
T.chk('Title Path: how champions are priced, by period (' + TP.map((x: any) => x.champion_won + ' of ' + x.decided + ' v ' + x.elo_expected.toFixed(1)).join('; ') + '), and what is not modelled',
  tp.indexOf('From 2014 to 2020 champions won 71 of 100 where it expected ' + TP[0].elo_expected.toFixed(1) + ' — it underrated them then; since 2021 champions have won about as many title fights as it expected (' + TP[1].champion_won + ' of ' + TP[1].decided + ', expected ' + TP[1].elo_expected.toFixed(1) + ')') >= 0
  && /A champion term is tested every week/.test(tp) && !/understate/.test(tp) && /Interim belts/.test(tp));
const movedOut = S.divisions.flatMap((v: any) => (v.moved_out || []).map((m: any) => (S.divisions.flatMap((d: any) => d.people).find((x: any) => x.id === m.id) || { name: m.id }).name));
T.chk('Title Path: a contender who moved divisions is named under the division they left (' + (movedOut.join(', ') || 'none this run') + ')',
  movedOut.length ? movedOut.every((n: string) => new RegExp('booked in another division \\(counted there\\): [^<]*' + UI.esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(').test(tp)) : !/booked in another division/.test(tp));
/* Model Health */
const h = paint(cache(), 'model_health');
const EH = S.model_health.elo;
T.chk('Model Health: the reproduction check (' + EH.reproduced + ' of ' + EH.published + ') and the three windows beside a coin', EH.published > 0 && EH.reproduced === EH.published && h.indexOf('reproduces every price the loop published: ' + EH.reproduced + ' of ' + EH.published) >= 0 && (h.match(/<tr><td>(validation|holdout|2026)/g) || []).length === 3 && /0\.693/.test(h));
T.chk('Model Health: the plain-language verdict', /better than a coin flip, but not by much/.test(h));
const St = S.model_health.study;
T.chk('Model Health: the served model and 1.1.0 against the closing line, every window, log loss and Brier', !!St && /Against the closing line/.test(h) && (h.match(/<tr><td>(Every bout since 2018|Test 2024 on|Select 2021-2023|Fit 2016-2020)/g) || []).length === St.windows.length && /Closing line<\/th><th>Close Brier/.test(h));
T.chk('Model Health: the reference is named as untimestamped, so it never certifies', !St || St.reference.timestamped || /It is untimestamped \(/.test(h));
T.chk('Model Health: the calibration chart: three series (a dashed close), a diagonal, a legend, a hover title on every point, and its table',
  !!St && (h.match(/<polyline class="sm-cal-line /g) || []).length === 3 && /stroke-dasharray="5 3"/.test(h) && /class="sm-cal-diag"/.test(h) && /class="sm-cal-legend/.test(h)
  && (h.match(/<title>/g) || []).length === ['old', 'new', 'close'].reduce((a, k) => a + St.calibration[k].filter((r: any) => r.n >= 10).length, 0) && /The calibration numbers/.test(h));
T.chk('Model Health: how large gaps resolved, and the certification in plain words', /When the [^<]+ and the close disagree \(2021 on\)/.test(h) && /resolved in the model’s favour and [\d,]+ in the market’s/.test(h) && /(Not certified as a signal|Certified: gaps that size beat the close)/.test(h));
T.chk('Model Health: every change tried, kept or dropped', !!St && (h.match(/class="sm-dec sm-dec-(promote|retain)"/g) || []).length === St.steps.length);
const AG = St && St.age;
T.chk('Model Health: the age study, a row per division with where its decline starts and the older fighter\'s said / won, and every candidate\'s out-of-sample record',
  !!AG && /Age by division \(where the decline starts/.test(h) && AG.divisions.every((d: any) => h.indexOf('<tr><td>' + d.division + '</td>') >= 0)
  && AG.candidates.every((c: any) => h.indexOf('<tr><td>' + c.key.replace(/_/g, ' ')) >= 0) && /Δ 2021 on<\/th>/.test(h));
T.chk('Model Health: an adopted age curve is named with its version, said to be better but not proven, and the test window no longer untouched',
  !AG || !AG.adopted || (h.indexOf(AG.adopted.version + ' carries it') >= 0 && /better, not proven/.test(h) && (St.test_untouched || /2024 on is no longer untouched/.test(h))));
T.chk('Model Health: with nothing adopted, the age block says so', (() => { const r2 = JSON.parse(JSON.stringify(run)); const s2 = r2.validation_summary.sport_summary.model_health.study;
  if (!s2 || !s2.age) return true; s2.age.adopted = null; return /No age curve by division is served/.test(paint(cache({ run: r2 }), 'model_health')); })());
T.chk('Model Health: champions against the Elo, and the finish model out of sample', /champions won <b>\d+<\/b>; the Elo expected about <b>\d+<\/b>/.test(h) && /tested on [\d,]+ later bouts/.test(h));
T.chk('Model Health: the title record in two periods', h.indexOf('<tr><td>2014–2020</td><td class="sm-num">100</td><td class="sm-num">71</td><td class="sm-num">' + TP[0].elo_expected.toFixed(1) + '</td><td class="sm-num">+' + (71 - TP[0].elo_expected).toFixed(1) + '</td></tr>') >= 0 && h.indexOf('<tr><td>2021–' + String(TP[1].to).slice(0, 4) + '</td><td class="sm-num">' + TP[1].decided + '</td><td class="sm-num">' + TP[1].champion_won + '</td>') >= 0);
/* the loop re-tests the champion term every week, so the sentence is checked against the run's own latest test */
const CTS = S.model_health.champion_term, LT = CTS.last_test, sg = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(5);
if (CTS.served_bonus > 0) T.chk('Model Health: the champion term the loop adopted is stated as served (' + CTS.served_bonus + ' points)', h.indexOf('gives the champion going in ' + CTS.served_bonus + ' extra rating points') >= 0 && !/Latest test/.test(h));
else T.chk('Model Health: the champion term, not served, with its latest weekly test in plain words (' + LT.decision + ', ' + sg(LT.delta.logloss) + ')', /The champion term\.<\/b> The model loop tests, every week, giving the champion going in 100 extra rating points/.test(h)
  && h.indexOf(': <b>' + (LT.decision === 'PASS' ? 'passed' : 'not adopted') + '</b>. Over every bout since 2016 it moved the log loss by ' + sg(LT.delta.logloss)
    + ' (lower is better; adopting it takes a fall of at least 0.0005), and on 2025 alone by ' + sg(LT.delta['2025_logloss']) + '.') >= 0 && /title fights are priced without one/.test(h));
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
if (ss.model_health.study) { ss.model_health.study.reference.name = EVIL; ss.model_health.study.steps.forEach((x: any) => { x.label = EVIL; });
  if (ss.model_health.study.age) { ss.model_health.study.age.divisions.forEach((d: any) => { d.division = EVIL; }); ss.model_health.study.age.candidates.forEach((c: any) => { c.key = EVIL; }); } }
ss.cards.forEach((c: any) => c.bouts.forEach((b: any) => { if (b.market) b.market.book = EVIL; b.guard = { status: 'DISAGREES', label: EVIL, threshold_pp: 8, gap_pp: 12, signal_allowed: false, certified: false, factors: [{ code: 'age', text: EVIL, record: null }] }; }));
for (const tab of ['fights', 'title_path', 'model_health']) {
  const x = paint(cache({ entities: evilEnt, results: evilRes, run: evilRun }), tab);
  T.chk('escaping (' + tab + '): hostile text never reaches the page as markup', !/<img/.test(x) && /&lt;img/.test(x));
}
/* the core shell */
T.eq('the shell shows the adapter\'s tab names', [UI.tabLabel(sport, 'fights'), UI.tabLabel(sport, 'title_path'), UI.tabLabel(sport, 'model_health')], ['Fights', 'Title Path', 'Model Health']);
UI.registerSport('ufc', W.adapter);
T.eq('the default tab is Fights', UI.defaultTab(sport), 'fights');

process.exit(T.done());
