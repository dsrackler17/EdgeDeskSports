/* ===========================================================================
   The tennis views of the Simulator seat (lib/edgedesk_simulator_tennis.js),
   as pure functions over runs built from the committed data and published
   through the publisher's own row builders: states, provenance, the draw
   picker, fair odds in both formats, the next matches, the day's matches,
   the model record, escaping, never a number without entitlement.
     node simulator/tests/tennis_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/tennis/elo.ts';
import { tennisRuns, fixtureRuns } from './_tennis_fixture.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';

const req = createRequire(import.meta.url);
const T = kit('tennis reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const W = req(path.join(REPO, 'lib', 'edgedesk_simulator_tennis.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const sport = SPORTS.sports.find((s: any) => s.key === 'tennis');
T.eq('the registry lists tennis, ACTIVE, with its three tabs', [sport && sport.status, sport && sport.tabs.join()], ['ACTIVE', 'draws,matches,model_health']);
T.eq('the adapter names the tabs Draws, Matches, Model Health', [W.adapter.tabLabels.draws, W.adapter.tabLabels.matches, W.adapter.tabLabels.model_health], ['Draws', 'Matches', 'Model Health']);
T.eq('fair odds: 60% is 1.67 decimal and -150 American', [W.decimal(0.6), W.american(0.6), W.american(0.4)], ['1.67', '-150', '+150']);
T.eq('fair odds past 1,000 decimal: a 0.075% long shot is 1,333 decimal and +133233 American', [W.decimal(0.00075), W.american(0.00075)], ['1,333', '+133233']);
T.chk('the public registry text never says "probability"', !/probability/i.test(JSON.stringify(sport)));

/* the committed feeds' draws and matches, or the frozen fixture on a day the feeds give no draw (_tennis_fixture.ts) */
const o = await tennisRuns(4000, '3');
const now = Date.parse(o.runs[0].snapshot.data.as_of) + 7200e3;
const pub = (r: any, i: number) => {
  const run = { run_id: 'r' + i, sport: 'tennis', competition: r.results.run.competition, season: '2026', n_sims: 4000, seed: '3', model_version: r.results.run.model_version, rules_version: r.results.run.rules_version,
    input_snapshot_at: new Date(now - 3600e3).toISOString(), published_at: new Date(now - 3000e3).toISOString(), validation_summary: { checks: r.results.checks, flags: r.results.flags, sport_summary: r.results.sport_summary } };
  return { status: { sport: 'tennis', season: '2026', competition: run.competition, published_run_id: run.run_id, published_at: run.published_at, last_attempt_status: 'completed', last_attempt_at: run.published_at },
    entitled: true, run, results: resultRows(r), entities: entityRows(r) };
};
const drawRuns = o.runs.filter((r) => r.results.run.competition !== 'matches'), matchRun = o.runs.find((r) => r.results.run.competition === 'matches');
T.chk('runs from ' + o.source + ': at least one draw and the day\'s matches', drawRuns.length >= 1 && !!matchRun);
const P = drawRuns.map(pub), M = matchRun ? pub(matchRun, 99) : null;
const S0 = (P[0].run.validation_summary as any).sport_summary;
const cache = (x: any = {}) => Object.assign({}, P[0], { comp: P[0].run.competition, draws: P.map((p) => ({ competition: p.run.competition, name: (p.run.validation_summary as any).sport_summary.tournament.name, tour: (p.run.validation_summary as any).sport_summary.tour })), matches: M, edges: [] }, x);
const paint = (c: any, tab: string) => W.adapter.paint({ sport, cache: c, tab, nowMs: now });

/* states (the shared gate) */
T.chk('not entitled: the Full Access card, no number', (() => { const h = paint(cache({ entitled: false, run: null, results: null }), 'draws'); return /Full Access/.test(h) && !/\d+\.\d%/.test(h); })());
T.chk('no draw published: says a draw is simulated only once its order is known', /a draw is simulated only once its order is known/.test(paint(cache({ status: null, run: null, comp: null, draws: [] }), 'draws')));
T.chk('no match prices published: says so on Matches', /No match prices have been published for Tennis/.test(paint(cache({ matches: { status: null, entitled: true, run: null } }), 'matches')));

/* Draws */
const d = paint(cache(), 'draws');
T.chk('Draws: EXPERIMENTAL, the simulated-draw count and the tournament', /EXPERIMENTAL/.test(d) && /4,000 simulated draws/.test(d) && d.includes(UI.esc(S0.tournament.name)));
T.chk('Draws: results Observed, simulation Research, the order\'s source stated', /sm-observed/.test(d) && /sm-research/.test(d) && /Draw order: /.test(d));
/* the title table read row by row against each player's own simulated title share: every player still in and no one
   else, decimal 1/p and American each to the precision printed (2.73 below 1,000 decimal, 1,333 from 1,000 up: EDSim
   fairOdds), and no price (—) where the share is 0 of the draws simulated, since 1/p is then undefined. A count of
   priced cells allowing one gap failed on a correct page whenever a draw had two such players (Curitiba, 2026-10-26) */
const titleOdds = (x: any): string[] => {
  const S = x.run.validation_summary.sport_summary, html = paint(cache({ ...x, comp: x.run.competition }), 'draws'), bad: string[] = [];
  const share = new Map(x.results.filter((r: any) => r.outcome === 'win_title').map((r: any) => [r.entity_id, r.probability]));
  const rows = [...((html.split('Who wins the title')[1] || '').split('</tbody>')[0]).matchAll(/<tr><td><b>(.*?)<\/b>.*?<td class="sm-num">([^<]*)<\/td><\/tr>/g)];
  const alive = S.players.filter((p: any) => !p.out);
  if (rows.length !== alive.length) bad.push(rows.length + ' rows for ' + alive.length + ' players still in');
  for (const p of alive) {
    const mine = rows.filter((r) => r[1] === UI.esc(p.name)), q = share.get(p.id);
    if (mine.length !== 1) { bad.push(p.name + ': ' + mine.length + ' rows'); continue; }
    const text = mine[0][2];
    if (typeof q !== 'number') { bad.push(p.name + ': no title share published'); continue; }
    if (!(q > 0 && q < 1)) { if (text !== '—') bad.push(p.name + ' (' + q + '): ' + text + ', not —'); continue; }
    const f = /^(\d+\.\d\d|\d{1,3}(?:,\d{3})+) · ([+-]\d+)$/.exec(text), dec = 1 / q, am = q >= 0.5 ? -100 * q / (1 - q) : 100 * (1 - q) / q;
    if (!f || f[1].includes(',') !== dec >= 1000 || Math.abs(Number(f[1].replace(/,/g, '')) - dec) > (dec >= 1000 ? 0.5 : 0.005) + 1e-9
      || Math.abs(Number(f[2]) - am) > 0.5 + 1e-9 || (f[2][0] === '+') !== am > 0) bad.push(p.name + ' (' + q + '): ' + text);
  }
  return bad;
};
const titleBad = P.flatMap((x) => titleOdds(x).map((b) => x.run.competition + ' ' + b));
T.chk('Draws: who wins the title, with fair odds in both formats for every player still in', /Who wins the title/.test(d) && titleBad.length === 0, titleBad);
/* the same reading on the frozen fixture's draw, made to hold what a day's feeds may or may not: two players still in
   with no simulated title (no price), and long shots past 1,000 decimal */
{
  const fx = (await fixtureRuns(4000, '3')).filter((r) => r.results.run.competition !== 'matches').map((r, i) => pub(r, 50 + i))[0];
  const alive = (fx.run.validation_summary as any).sport_summary.players.filter((p: any) => !p.out), set = (id: string, n: number) => {
    const r: any = fx.results.find((r: any) => r.entity_id === id && r.outcome === 'win_title'); r.outcome_count = n; r.probability = n / r.n_sims;
  };
  [0, 0, 1, 3].forEach((n, i) => set(alive[alive.length - 1 - i].id, n));
  const h = paint(cache({ ...fx, comp: fx.run.competition }), 'draws'), rowOf = (p: any) => (h.split('<b>' + UI.esc(p.name) + '</b>')[1] || '').split('</tr>')[0];
  T.eq('Draws: no title in 4,000 draws shows no price; 1 and 3 in 4,000 show 4,000 · +399900 and 1,333 · +133233',
    [alive.length >= 4, ...alive.slice(-4).reverse().map((p: any) => (/<td class="sm-num">([^<]*)<\/td>$/.exec(rowOf(p)) || [])[1])], [true, '—', '—', '4,000 · +399900', '1,333 · +133233']);
  T.eq('Draws: ...and the row-by-row reading accepts that page', titleOdds(fx), []);
}
T.chk('Draws: the next matches priced for both players', (S0.scheduled.length === 0 || /The next matches/.test(d)) && S0.scheduled.every((m: any) => d.includes(UI.esc(m.a_name)) && d.includes(UI.esc(m.b_name))));
T.chk('Draws: the results so far, winner and loser', !S0.results.length || (/Results so far/.test(d) && / d\. /.test(d)));
if (P.length > 1) {
  T.chk('Draws: a picker with every draw', (paint(cache(), 'draws').match(/data-sim-act="draw"/g) || []).length === P.length);
  const c = cache({ byComp: Object.fromEntries(P.map((p) => [p.run.competition, p])) });
  T.eq('Draws: picking another draw shows it (no reload: it is loaded)', W.adapter.onAction('draw', P[1].run.competition, c), 'paint');
  T.chk('Draws: ...its tournament', paint(c, 'draws').includes(UI.esc((P[1].run.validation_summary as any).sport_summary.tournament.name)));
}
T.eq('Draws: an unknown draw key is ignored', W.adapter.onAction('draw', 'atp-nope', cache()), null);
/* Matches */
if (M) {
  const m = paint(cache(), 'matches'), SM = (M.run.validation_summary as any).sport_summary;
  T.chk('Matches: every scheduled match, both players, with ± and fair odds', /Every scheduled singles match/.test(m) && SM.matches.every((x: any) => m.includes(UI.esc(x.a.name)) && m.includes(UI.esc(x.b.name))) && (m.match(/<span class="sm-pm">±/g) || []).length >= 2 * SM.matches.length - 2);
  T.chk('Matches: grouped by tournament', new Set(SM.matches.map((x: any) => x.tournament)).size === (m.match(/<div class="sm-card"><div class="sm-h">(ATP|WTA) · /g) || []).length);
}
/* Model Health */
const h = paint(cache(), 'model_health');
T.chk('Model Health: the holdout against FiveThirtyEight and a coin, both tours', /Does the match rating work\?/.test(h) && /FiveThirtyEight/.test(h) && /<td>ATP<\/td>/.test(h) && /<td>WTA<\/td>/.test(h));
T.chk('Model Health: the draw backtest against everyone equal, with its interval', /Does the draw simulation call tournaments\?/.test(h) && /Everyone equal/.test(h) && /\(-\d\.\d+ to -\d\.\d+\)/.test(h));
T.chk('Model Health: what the model does not know (the surface first)', /What the model does not know/.test(h) && /court surface/.test(h));

/* escaping */
const evil = JSON.parse(JSON.stringify(P[0]));
const es = evil.run.validation_summary.sport_summary;
es.tournament.name = EVIL + es.tournament.name; es.players.forEach((p: any) => { p.name = EVIL + p.name; }); es.scheduled.forEach((m: any) => { m.a_name = EVIL; m.b_name = EVIL; m.round = EVIL; });
es.results.forEach((r: any) => { r.winner_name = EVIL; r.loser_name = EVIL; }); if (es.order.article) es.order.article.title = EVIL;
for (const tab of ['draws', 'model_health']) {
  const x = paint(cache({ run: evil.run, draws: [{ competition: evil.run.competition, name: EVIL, tour: 'ATP' }, { competition: 'x', name: EVIL, tour: 'WTA' }] }), tab);
  T.chk('escaping (' + tab + '): hostile text never reaches the page as markup', !/<img/.test(x) && /&lt;img/.test(x));
}
if (M) {
  const em = JSON.parse(JSON.stringify(M)); em.run.validation_summary.sport_summary.matches.forEach((m: any) => { m.a.name = EVIL; m.tournament = EVIL; m.round = EVIL; });
  const x = paint(cache({ matches: em }), 'matches');
  T.chk('escaping (matches): hostile text never reaches the page as markup', !/<img/.test(x) && /&lt;img/.test(x));
}
/* the core shell */
T.eq('the shell shows the adapter\'s tab names', [UI.tabLabel(sport, 'draws'), UI.tabLabel(sport, 'matches'), UI.tabLabel(sport, 'model_health')], ['Draws', 'Matches', 'Model Health']);
UI.registerSport('tennis', W.adapter);
T.eq('the default tab is Draws', UI.defaultTab(sport), 'draws');
process.exit(T.done());
