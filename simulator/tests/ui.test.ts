/* The Simulator reader's pure functions (lib/edgedesk_simulator.js) and the
   generated sport registry it reads (lib/edgedesk_simulator_sports.js).
   node simulator/tests/ui.test.ts */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import os from 'node:os';
import { execute, parseArgs } from '../src/cli/run.ts';
import { resultRows, entityRows } from '../src/publish/publish.ts';
import { CFB_FIXTURE } from './_cfb.ts';
import { nhlFixture } from './_fixture.ts';
import { nhlModule } from '../src/sports/nhl/module.ts';
import { mlbModule } from '../src/sports/mlb/module.ts';
import { mlbFixture } from './_mlb_fixture.ts';
import { runRange } from '../src/core/engine.ts';
import { buildResults } from '../src/core/results.ts';
import { nbaFixture } from './_nba_fixture.ts';
import { nbaModule } from '../src/sports/nba/module.ts';
import { nbaMathStatus } from '../src/sports/nba/validate.ts';

const require = createRequire(import.meta.url);
const UI = require(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const REG = require(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
const T = kit('Simulator reader');

/* the registry the page shows is the one the publisher gates on */
T.chk('lib/edgedesk_simulator_sports.js is current with simulator/src/sports/registry.ts', (() => { try { execFileSync(process.execPath, [path.join(REPO, 'simulator', 'src', 'cli', 'build_ui_registry.ts'), '--check'], { stdio: 'pipe' }); return true; } catch (_) { return false; } })());
T.eq('every covered sport is listed, active or not', REG.sports.map((s: any) => s.key), sportRegistry().map((s) => s.key));
T.chk('the registry carries no probability', !/probab|"p":|\d\.\d{3,}/.test(fs.readFileSync(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'), 'utf8').replace(/max_reference_spread|0\.06/g, '')));
T.chk('every inactive sport names its blockers', REG.sports.filter((s: any) => s.status !== 'ACTIVE').every((s: any) => s.blockers.length > 0));
T.eq('UFC is ACTIVE: every booked bout and each division\'s title path, not a season (Fights, Title Path, Model Health)', [REG.sports.find((s: any) => s.key === 'ufc').status, REG.sports.find((s: any) => s.key === 'ufc').tabs.join()], ['ACTIVE', 'fights,title_path,model_health']);

/* formatting: zero, all, tiny, not applicable */
const o = (k: number, n = 100000) => { const p = k / n; return { applicable: true, outcome_count: k, n_sims: n, probability: p, mcse: Math.sqrt(p * (1 - p) / n), wilson_lo: Math.max(0, p - 0.01), wilson_hi: Math.min(1, p + 0.01) }; };
T.eq('a probability in percent, one decimal', UI.fmtProb(o(61234)).text, '61.2%');
T.eq('the ± is 1.96 x MCSE in points', UI.fmtPm(o(61234)), '±0.3');
T.eq('a zero count is "0 in N", never "0%" or impossible', UI.fmtProb(o(0)).text, '0 in 100,000');
T.chk('  ... and its tooltip says it is not impossible', /not impossible/.test(UI.fmtProb(o(0)).title));
T.eq('every run is "all N", never a certainty', UI.fmtProb(o(100000)).text, 'all 100,000');
T.eq('a tiny probability reads <0.1%', UI.fmtProb(o(30)).text, '<0.1%');
T.eq('not applicable is a dash, distinct from zero', UI.fmtProb({ applicable: false }).text, '—');
T.eq('no ± on a zero count', UI.fmtPm(o(0)), '');
T.chk('the legend says the ± is Monte Carlo sampling error at 95%, not model accuracy', /95% Monte Carlo/.test(UI.LEGEND) && /not model accuracy/.test(UI.LEGEND));
T.eq('fair odds 1/p', UI.fairOdds(0.25), '4.00');
T.eq('fair odds at p = 0 are undefined', UI.fairOdds(0), '—');
T.eq('fair odds at p = 1 are 1.00', UI.fairOdds(1), '1.00');
/* sorting: numeric, missing last both ways */
{
  const rows = [{ v: 2 }, { v: null }, { v: 10 }, { v: -1 }, { v: NaN }, { v: 3 }];
  T.eq('descending numeric sort, missing last', UI.sortRows(rows, 'v', 'desc').map((r: any) => r.v), [10, 3, 2, -1, null, NaN]);
  T.eq('ascending numeric sort, missing still last', UI.sortRows(rows, 'v', 'asc').map((r: any) => r.v), [-1, 2, 3, 10, null, NaN]);
  T.eq('10 sorts above 9 (numbers, not strings)', UI.sortRows([{ v: 9 }, { v: 10 }], 'v', 'desc').map((r: any) => r.v), [10, 9]);
}
/* states */
{
  const nfl = { key: 'nfl', label: 'NFL', status: 'ACTIVE' }, now = Date.parse('2026-10-24T12:00:00Z');
  const status = { published_run_id: 'r1', published_at: '2026-10-24T06:00:00Z', last_attempt_status: 'completed', last_attempt_at: '2026-10-24T06:00:00Z' };
  const run = { input_snapshot_at: '2026-10-24T05:00:00Z' };
  T.eq('a blocked sport shows its blockers', UI.deriveState({ sport: { ...nfl, status: 'BLOCKED' }, nowMs: now }).kind, 'blocked');
  T.eq('a Coming Soon sport', UI.deriveState({ sport: { ...nfl, status: 'COMING_SOON' }, nowMs: now }).kind, 'coming_soon');
  T.eq('nothing published: no-data state', UI.deriveState({ sport: nfl, status: null, nowMs: now }).kind, 'no_data');
  T.eq('published but not entitled: unauthorized', UI.deriveState({ sport: nfl, status, entitled: false, nowMs: now }).kind, 'unauthorized');
  T.eq('published and entitled: ok, fresh', JSON.stringify(UI.deriveState({ sport: nfl, status, entitled: true, run, nowMs: now })), JSON.stringify({ kind: 'ok', stale: false, notes: [] }));
  const failed = { ...status, last_attempt_status: 'failed', last_attempt_at: '2026-10-24T09:00:00Z' };
  const s2 = UI.deriveState({ sport: nfl, status: failed, entitled: true, run, nowMs: now });
  T.chk('a failed refresh after the last publication keeps the results, marked stale', s2.kind === 'ok' && s2.stale && /latest refresh failed/.test(s2.notes.join(' ')));
  const s3 = UI.deriveState({ sport: nfl, status, entitled: true, run: { input_snapshot_at: '2026-10-21T00:00:00Z' }, nowMs: now });
  T.chk('inputs older than the stale limit are marked stale', s3.stale && /hours old/.test(s3.notes.join(' ')));
  const s4 = UI.deriveState({ sport: nfl, status, entitled: true, run, loadError: 'db 503', nowMs: now });
  T.chk('a load error with results already on screen keeps them, stale', s4.kind === 'ok' && s4.stale);
  T.eq('a load error with nothing on screen is an error state', UI.deriveState({ sport: nfl, status, entitled: true, run: null, loadError: 'db 503', nowMs: now }).kind, 'error');
  T.eq('no comparison: market unavailable, not zero', UI.marketState(status, { comparison_id: null }, []).kind, 'unavailable');
  T.chk('a failed market refresh never shows quotes as current', /No quote is shown as current/.test(UI.marketState({ ...status, comparison_status: 'failed', comparison_at: '2026-10-24T07:00:00Z' }, { comparison_id: null }, []).text));
}
/* safe rendering: every interpolated value is escaped */
{
  const evil = '<img src=x onerror=alert(1)>';
  const res = [{ entity_id: 'BUF', entity_name: evil, entity_groups: { conference: 'AFC', division: evil }, outcome: 'win_division', ...o(500) },
    { entity_id: 'BUF', entity_name: evil, entity_groups: { conference: 'AFC', division: evil }, outcome: 'make_playoffs', ...o(900) }];
  const M = UI.buildModel({ comparison_id: null }, res, [{ entity_id: 'BUF', entity_name: evil, entity_groups: { conference: 'AFC', division: evil }, record: { w: 1, l: 0, t: 0 }, mean_wins: 10 }], []);
  const html = UI.renderDivision(M) + UI.renderTitle(M, { kind: 'unavailable' }) + UI.renderBlocked({ label: evil, status: 'BLOCKED', blockers: [evil], limitations: [evil], activation_path: evil });
  T.chk('no raw tag from data reaches the page', !/<img/i.test(html) && /&lt;img/.test(html));
  const fut = UI.renderFutures(UI.buildModel({ comparison_id: 'c' }, res, [], [{ entity_id: 'BUF', outcome: 'win_super_bowl', research_prob: 0.2, research_mcse: 0.001, research_fair_decimal: 5,
    reference_prob: null, normalized_ref_prob: null, reference_edge_pp: null, exec_price: 0.14, exec_cost_prob: 0.14, exec_edge_pp: 6, quote_age_minutes: 5, fee_verified: false, stale: false, actionable: false, block_reasons: [evil] }]), { kind: 'ok' }, { key: 'exec_edge_pp', dir: 'desc' });
  T.chk('the futures table escapes block reasons and states pre-fee', !/<img/i.test(fut) && /before fees/.test(fut) && /never a recommendation/.test(fut));
  T.chk('the futures table separates reference and executable edges, with no combined score', /Ref edge/.test(fut) && /Exec edge/.test(fut) && !/edge score/i.test(fut));
}
/* college football: the conference and CFP views from a real (small) run of the committed snapshot, as the database returns it */
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'edgedesk-ui-cfb-'));
  const o = await execute(parseArgs(['--sport', 'cfb', '--snapshot', CFB_FIXTURE, '--runs', '400', '--workers', '2', '--dry-run', '--out', out]), () => {});
  const rows = resultRows(o) as any[];
  const ents = (o.results.entities as any[]).map((e) => ({ entity_id: e.entity_id, entity_name: e.entity_name, entity_groups: e.groups, record: e.record, mean_wins: e.mean_wins, wins_hist_x2: e.wins_hist_x2, math_status: e.math_status }));
  const cfb = (o.results as any).cfb;
  const run = { comparison_id: null, rules_version: o.results.run.rules_version, validation_summary: { checks: o.results.checks, flags: o.results.flags, cfb: { cfp_mode: cfb.cfp_mode, cfp_mode_reason: cfb.cfp_mode_reason, conferences: cfb.conferences } } };
  const M = UI.buildModel(run, rows, ents, []);
  const conf: string = UI.renderCfbConference(M), cfp: string = UI.renderCfbPlayoff(M);
  const confs = [...new Set(ents.map((e) => e.entity_groups.conference))].filter((c) => c !== 'FBS Independents');
  const cards = conf.split('<div class="sm-card">').slice(1), indCard = cards.find((c) => /FBS Independents/.test(c)) || '';
  T.eq('conference tab: one card per conference with a title game, then one for the independents', [cards.length, cards.filter((c) => /Title game/.test(c)).length], [confs.length + 1, confs.length]);
  T.chk('... each with title-game, No. 1 seed and conference-title columns', /Title game/.test(conf) && /No\. 1 seed/.test(conf) && /Win SEC/.test(conf));
  T.chk('... the independents with no title-game column, Notre Dame among them with its top-12 rule', /Notre Dame/.test(indCard) && !/Title game|No\. 1 seed/.test(indCard) && /ranked in the top 12/.test(indCard) && /Make CFP/.test(indCard));
  T.chk('... the regular season: projected record, six wins and an unbeaten season', ['Proj. record', '6+ wins', 'Unbeaten'].every((h) => cards.every((c) => c.includes(h))));
  T.chk('... and the Estimated-ranking exposure where a conference has it', /Estimated/.test(conf) && /outside ranking/.test(conf));
  T.chk('every team publishes its schedule length, and its wins histogram covers it', ents.every((e) => e.record.games >= e.record.w + e.record.l && e.record.games > 0 && e.wins_hist_x2.length >= 2 * e.record.games + 1
    && e.wins_hist_x2.reduce((a: number, b: number) => a + b, 0) === 400 && e.wins_hist_x2.every((n: number, i: number) => i >= 2 * e.record.w && i <= 2 * (e.record.games - e.record.l) || n === 0)));
  {
    /* the regular-season cells, read straight from the histogram, against counts done here */
    const row = (name: string) => conf.split('<tr>').find((r) => r.includes('<b>' + UI.esc(name) + '</b>')) || '';
    const live = ents.find((e) => e.record.w < 6 && e.record.w + (e.record.games - e.record.w - e.record.l) >= 6 && e.wins_hist_x2.slice(12).some((n: number) => n > 0) && e.wins_hist_x2.slice(0, 12).some((n: number) => n > 0))!;
    const six = live.wins_hist_x2.slice(12).reduce((a: number, b: number) => a + b, 0);
    T.chk('6+ wins is the share of runs with six or more regular-season wins (' + live.entity_name + ': ' + six + ' of 400)', new RegExp('title="' + six + ' of 400 simulated seasons').test(row(live.entity_name)));
    const done6 = ents.find((e) => e.record.w >= 6)!, out6 = ents.find((e) => e.record.w + (e.record.games - e.record.w - e.record.l) < 6)!;
    T.chk('... "reached" once a team has six wins and "out" once it cannot, never "all N" or "0 in N"', />reached</.test(row(done6.entity_name)) && />out</.test(row(out6.entity_name)));
    const unbeaten = ents.find((e) => e.record.l === 0 && e.record.games > e.record.w)!, lost = ents.find((e) => e.record.l > 0)!;
    const ub = unbeaten.wins_hist_x2[2 * unbeaten.record.games];
    T.chk('Unbeaten is the share of runs winning every regular-season game (' + unbeaten.entity_name + ': ' + ub + ' of 400); a team that has lost shows a dash', new RegExp('title="' + ub + ' of 400 simulated seasons').test(row(unbeaten.entity_name)) && /title="Has lost a game">—</.test(row(lost.entity_name)));
    const proj = (e: any) => e.mean_wins.toFixed(1) + '-' + (e.record.games - e.mean_wins).toFixed(1);
    T.chk('... and the projected record is mean wins against the schedule length (' + live.entity_name + ' ' + proj(live) + ')', row(live.entity_name).includes('>' + proj(live) + '<'));
  }
  T.chk('CFP tab: labelled Estimated, says the proxy is not the committee, and that a record never fixes the ranking', /sm-badge sm-estimated/.test(cfp) && /not the committee/.test(cfp) && /never fixes its ranking/.test(cfp));
  T.chk('... lists the rounds through the national title, with Notre Dame eligible', ['Make CFP', 'Bye', 'Quarterfinal', 'Semifinal', 'Final', 'Win title', 'Win conf.', 'Proj. record'].every((h) => cfp.includes(h)) && /Notre Dame/.test(cfp));
  T.chk('... states the 2026 selection rules: four power champions, the best Group of Six team, Notre Dame top 12, byes and campus first round', /ACC, Big Ten, Big 12 and SEC champions qualify automatically/.test(cfp) && /highest-ranked team from the American/.test(cfp) && /Notre Dame is in if it is ranked in the top 12/.test(cfp) && /5 v 12/.test(cfp));
  {
    const main = cfp.split('<div class="sm-card">')[1], made = [...main.matchAll(/<tr><td><b>([^<]+)<\/b>[\s\S]*?<\/tr>/g)].map((m) => m[1]);
    const pf = (name: string) => M.clubs.find((c: any) => UI.esc(c.name) === name).outcomes.cfp_field.probability;
    T.chk('... sorted by playoff probability (the projected field first, then the bubble)', made.length > 12 && made.every((n, i) => i === 0 || pf(made[i - 1]) >= pf(n)));
    const heads = [...main.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    T.eq('... Make CFP and the title lead the row, right after the team (on a phone they stay on screen)', heads.slice(0, 3), ['Team', 'Make CFP', 'Win title']);
  }
  {
    const g6 = cfp.split('<div class="sm-card">').find((c) => /Group of Six bid/.test(c)) || '';
    const g6Teams = [...g6.matchAll(/<tr><td><b>([^<]+)<\/b> <span class="sm-dim sm-sub">([^<]+)</g)].map((m) => m[2]);
    const g6Sum = M.clubs.filter((c: any) => !['ACC', 'Big Ten', 'Big 12', 'SEC', 'FBS Independents'].includes(c.groups.conference)).reduce((a: number, c: any) => a + c.outcomes.cfp_field.outcome_count, 0);
    T.chk('a Group of Six card lists only teams from the six other conferences (' + g6Teams.length + ' teams)', g6Teams.length > 0 && g6Teams.every((cf) => !['ACC', 'Big Ten', 'Big 12', 'SEC', 'FBS Independents'].includes(cf)));
    T.chk('... whose Make CFP sums to at least every run (one of them is always in): ' + g6Sum + ' of 400', g6Sum >= 400);
  }
  {
    const seeds = cfp.split('<div class="sm-card">').find((c) => /CFP seeds/.test(c)) || '';
    T.chk('a CFP seeds card: 12 seed columns, byes 1-4 and hosts 5-8 marked', (seeds.match(/<th title="CFP seed \d+/g) || []).length === 12 && /4 \(bye\)/.test(seeds) && /8 \(host\)/.test(seeds) && !/9 \(/.test(seeds));
  }
  T.chk('... and no NFL vocabulary', !/Super Bowl|Playoffs<\/th>|AFC|NFC/.test(conf + cfp));
  {
    /* a run published before the schedule length and the histogram were read: no unbeaten column, no invented numbers */
    const oldEnts = ents.map((e) => ({ ...e, record: { w: e.record.w, l: e.record.l }, wins_hist_x2: undefined }));
    const oldM = UI.buildModel({ ...run }, rows, oldEnts, []), oldConf: string = UI.renderCfbConference(oldM);
    const tds = (name: string) => [...(oldConf.split('<tr>').find((r) => r.includes('<b>' + UI.esc(name) + '</b>')) || '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const open = ents.find((e) => e.record.w < 6)!, done = ents.find((e) => e.record.w >= 6)!;
    T.chk('an older run: projected wins only, no Unbeaten column, and 6+ wins a dash unless already reached', /Proj\. wins/.test(oldConf) && !/Unbeaten|Proj\. record/.test(oldConf)
      && tds(open.entity_name)[2] === open.mean_wins.toFixed(1) && tds(open.entity_name)[3] === '—' && tds(done.entity_name)[3] === 'reached');
  }
  const off = UI.buildModel({ validation_summary: { cfb: { cfp_mode: 'off', cfp_mode_reason: 'no defensible selection proxy' } } }, rows.filter((r) => !/^(cfp|reach|national)/.test(r.outcome)), ents, []);
  T.chk('with the CFP layer off, the tab says no CFP probability is published, and why', /No CFP or national-title probability is published/.test(UI.renderCfbPlayoff(off)) && /no defensible selection proxy/.test(UI.renderCfbPlayoff(off)));
  T.chk('... and the conference tab drops the Make CFP column', !/Make CFP/.test(UI.renderCfbConference(off)));
  const evilRows = rows.filter((r) => r.entity_id === 'alabama').map((r) => ({ ...r, entity_name: '<img src=x onerror=alert(1)>' }));
  const evil = UI.buildModel(run, evilRows, [{ ...ents.find((e) => e.entity_id === 'alabama'), entity_name: '<img src=x onerror=alert(1)>', entity_groups: { conference: '<b>SEC</b>', ccg: 'SEC', division: '-' } }], []);
  T.chk('team and conference names are escaped in both views', !/<img|<b>SEC/.test(UI.renderCfbConference(evil) + UI.renderCfbPlayoff(evil)));
  T.eq('the reader opens a sport on its title view (CFP & Title for college football)', [UI.defaultTab({ tabs: ['conference', 'title', 'futures'] }), UI.defaultTab({ tabs: ['division', 'conference', 'title', 'futures'] }), UI.defaultTab({ tabs: ['tournament'] })], ['title', 'title', 'tournament']);
  fs.rmSync(out, { recursive: true, force: true });
}
/* PostgREST answers at most max-rows per request: the reader pages until a short page */
{
  const asked: string[] = [];
  const get = async (q: string) => { asked.push(q); const off = Number(/offset=(\d+)/.exec(q)![1]); return Array.from({ length: off < 3000 ? 1000 : 213 }, (_, i) => ({ i: off + i })); };
  const all = await UI.getAll(get, 'sim_current_results?run_id=eq.x&order=entity_id,outcome');
  T.eq('3,213 rows read in pages of 1,000 (college football publishes about 3,200)', [all.length, asked.length, asked.map((q) => /offset=(\d+)/.exec(q)![1]).join()], [3213, 4, '0,1000,2000,3000']);
}
/* the NHL view, from a real (short) NHL simulation through the publisher's own row mapping */
{
  const snap = nhlFixture();
  const m = nhlModule(snap.data, { seed: 5n });
  const agg = runRange(m, { start: 0, end: 300 });
  const results = buildResults({ module: m, agg, seed: 5n, runs: 300, workers: 1, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at, model_version: 'm', config: {}, rules_version: 'NHL-TB-2019',
    started_at: '2026-10-23T00:00:00Z', finished_at: '2026-10-23T00:00:01Z', runtime_ms: 1, peak_rss_mb: 1,
    entityExtras: () => ({ record: { gp: 10, w: 6, l: 3, otl: 1, pts: 13, rw: 5, row: 6 }, math_status: null }) });
  const res = resultRows({ results }), ents = entityRows({ results });
  const M = UI.buildModel({ sport: 'nhl', comparison_id: null }, res, ents, []);
  const div = UI.renderDivision(M), conf = UI.renderConference(M), title = UI.renderTitle(M, { kind: 'unavailable' });
  T.chk('NHL division tab: W-L-OTL, points and projected points (from the record), not wins', /W-L-OTL/.test(div) && />Pts</.test(div) && /Proj\. pts/.test(div) && /6-3-1/.test(div) && !/Proj\. wins/.test(div) && !/W-L-T</.test(div));
  T.eq('NHL division tab: four divisions of eight', (div.match(/<div class="sm-h">/g) || []).length, 4);
  const mp = (ents[0] as any).record.mean_points as number;
  T.chk('the projected points shown are the simulation\'s mean regular-season points', div.includes('>' + mp.toFixed(1) + '<'));
  T.chk('NHL conference tab: D1-D3, WC1, WC2, round 2, conference final and the playoff conference title; no NFL seeds', ['D1', 'D2', 'D3', 'WC1', 'WC2', 'Round 2', 'Conf. final', 'Win Eastern', 'Win Western'].every((h) => conf.includes('>' + h + '<')) && !/\(bye\)/.test(conf));
  T.chk('NHL title tab: the Stanley Cup, with the regular-season honours on their own line', /win Stanley Cup/.test(title) && /Regular season: Presidents’ Trophy/.test(title) && !/Super Bowl/.test(title));
  T.eq('NHL title cards: one per club', (title.match(/class="sm-club"/g) || []).length, 32);
  const meta = UI.renderMeta({ key: 'nhl', label: 'NHL' }, { n_sims: 100000, input_snapshot_at: '2026-10-23T05:00:00Z', published_at: '2026-10-23T06:00:00Z', model_version: 'm', rules_version: 'r', seed: '1', validation_summary: { flags: { tiebreak_goals: 155 } } }, { stale: false, notes: [] }, Date.parse('2026-10-23T12:00:00Z'));
  T.chk('NHL run notes count goal-differential tiebreaks and coin tosses (not the NFL\'s points model)', /155 runs reached goal differential/.test(meta) && !/points-ranking/.test(meta));
  T.eq('the reader asks the database for the NHL\'s season label', REG.nhl.season, '2026-27');
}
/* the NBA view, from a real (short) NBA simulation of the committed 2026-27 snapshot through the publisher's row mapping */
{
  const snap = nbaFixture('live'), d = snap.data;
  const m = nbaModule(d, { seed: 27n });
  const agg = runRange(m, { start: 0, end: 300 });
  const math = nbaMathStatus(d);
  const rec: Record<string, { w: number; l: number }> = {};
  d.teams.forEach((t) => { rec[t.code] = { w: 0, l: 0 }; });
  d.games.filter((g) => g.done).forEach((g) => { const hw = (g.home_score as number) > (g.away_score as number); rec[hw ? g.home : g.away].w++; rec[hw ? g.away : g.home].l++; });
  const results = buildResults({ module: m, agg, seed: 27n, runs: 300, workers: 1, input_hash: snap.input_hash, input_snapshot_at: snap.meta.built_at, model_version: d.model.model_version, config: d.config, rules_version: d.rules_version,
    started_at: '2026-10-23T00:00:00Z', finished_at: '2026-10-23T00:00:01Z', runtime_ms: 1, peak_rss_mb: 1, entityExtras: (id) => ({ record: rec[id], math_status: math[id] }) });
  const res = resultRows({ results }), ents = entityRows({ results });
  const M = UI.buildModel({ sport: 'nba', comparison_id: null }, res, ents, []);
  const div = UI.renderDivision(M), conf = UI.renderConference(M), title = UI.renderTitle(M, { kind: 'unavailable' });
  T.eq('NBA division tab: six divisions of five', [(div.match(/<div class="sm-h">/g) || []).length, (div.match(/<tr><td><b>/g) || []).length], [6, 30]);
  T.chk('NBA division tab: W-L and projected wins, the play-in apart from the playoffs; no points or ties', />W-L</.test(div) && /Proj\. wins/.test(div) && />Play-in</.test(div) && />Make playoffs</.test(div) && !/>Pts</.test(div) && !/W-L-T|W-L-OTL/.test(div));
  T.eq('NBA conference tab: one card per conference', (conf.match(/class="sm-card"/g) || []).length, 2);
  T.chk('NBA conference tab: first place (regular season), play-in, playoffs, seeds 1-8, both rounds and the playoff conference title', ['Eastern Conference', 'Western Conference', '1st (reg. season)', 'Play-in', 'Playoffs', 'Conf. semis', 'Conf. finals', 'Win East', 'Win West', 'Seed 1', 'Seed 8'].every((h) => conf.includes('>' + h + '<')) && !/\(bye\)|WC1|Seed 9/.test(conf));
  T.chk('... and it says these are four different outcomes, the play-in not a playoff berth, home court by record', /Four different outcomes/.test(conf) && /which is not a playoff berth/.test(conf) && /not the better seed/.test(conf));
  /* each column reads its own outcome: the top club's row is exactly its cells in the header's order */
  const top = M.conferences.East.slice().sort((a: any, b: any) => b.outcomes.make_playoffs.probability - a.outcomes.make_playoffs.probability)[0];
  const want = ['finish_1', 'play_in', 'make_playoffs', 'reach_conference_semifinals', 'reach_conference_finals', 'win_conference', 'seed_1', 'seed_2', 'seed_3', 'seed_4', 'seed_5', 'seed_6', 'seed_7', 'seed_8'].map((k) => UI.cell(top.outcomes[k])).join('');
  T.chk('NBA conference tab: each column is its own outcome (first place, play-in, playoffs and the conference title never share one)', conf.includes(want));
  T.eq('NBA title tab: one card per club', (title.match(/class="sm-club"/g) || []).length, 30);
  T.chk('NBA title tab: the NBA title, the playoff conference title, and the regular-season places on their own line', /win NBA title/.test(title) && /Conference title \(playoffs\)/.test(title) && /Regular season: 1st in the (East|West)/.test(title) && !/Super Bowl|Stanley Cup|Presidents/.test(title));
  const tag = UI.renderConference(UI.buildModel({ sport: 'nba' }, res.filter((r: any) => r.entity_id === top.id), [{ ...ents.find((e: any) => e.entity_id === top.id), math_status: { division: null, top6: 'clinched', top10: 'clinched' } }], []));
  const out = UI.renderConference(UI.buildModel({ sport: 'nba' }, res.filter((r: any) => r.entity_id === top.id), [{ ...ents.find((e: any) => e.entity_id === top.id), math_status: { division: 'eliminated', top6: 'eliminated', top10: 'eliminated' } }], []));
  T.chk('NBA clinch tags: a top-6 place reads "clinched playoffs", out of the top 10 reads "eliminated"', /clinched playoffs/.test(tag) && !/clinched play-in/.test(tag) && /eliminated/.test(out) && !/clinched/.test(out));
  const meta = UI.renderMeta({ key: 'nba', label: 'NBA' }, { n_sims: 100000, input_snapshot_at: '2026-10-23T05:00:00Z', published_at: '2026-10-23T06:00:00Z', model_version: 'm', rules_version: 'r', seed: '1', validation_summary: { flags: { tiebreak_random_drawing: 3 } } }, { stale: false, notes: [] }, Date.parse('2026-10-23T12:00:00Z'));
  T.chk('NBA run notes count random drawings (a league rule), not the NFL\'s points model', /3 runs reached the random drawing/.test(meta) && !/points-ranking/.test(meta));
  T.eq('the reader asks the database for the NBA\'s season label', REG.nba.season, '2026-27');
  /* the NBA Cup tab */
  const cup = UI.renderCupNba(M);
  T.eq('NBA Cup tab: one card per group, five clubs each', [(cup.match(/<div class="sm-h">(East|West) group [123] \(/g) || []).length, (cup.match(/<tr><td><b>/g) || []).length], [6, 30]);
  T.chk('NBA Cup tab: win group, knockout, semifinal, Championship, the Cup and fair odds', ['Win group', 'Knockout', 'Semifinal', 'Championship', 'Win Cup', 'Fair odds'].every((h) => cup.includes('>' + h + '<')));
  const cupTop = M.clubs.slice().sort((a: any, b: any) => b.outcomes.cup_champion.probability - a.outcomes.cup_champion.probability)[0];
  T.chk('NBA Cup tab: each column is its own outcome', cup.includes(['cup_win_group', 'cup_knockout', 'cup_semifinal', 'cup_final', 'cup_champion'].map((k) => UI.cell(cupTop.outcomes[k])).join('')));
  T.chk('NBA Cup tab: the Championship counts in no standings; the Cup-dependent games are Estimated until scheduled', /the Championship does not/.test(cup) && /sm-estimated/.test(cup) && /unpublished formula/.test(cup));
  T.chk('NBA Cup tab: a run without the Cup says so', /carries no NBA Cup/.test(UI.renderCupNba(UI.buildModel({ sport: 'nba' }, res.filter((r: any) => !/^cup_/.test(r.outcome)).map((r: any) => ({ ...r, entity_groups: { conference: r.entity_groups.conference, division: r.entity_groups.division } })), ents.map((e: any) => ({ ...e, entity_groups: { conference: e.entity_groups.conference, division: e.entity_groups.division } })), []))));
  const cupMeta = UI.renderMeta({ key: 'nba', label: 'NBA' }, { n_sims: 100000, input_snapshot_at: '2026-10-23T05:00:00Z', published_at: '2026-10-23T06:00:00Z', model_version: 'm', rules_version: 'r', seed: '1', validation_summary: { flags: { cup_total_points_unmodelled: 12, cup_random_drawing: 1 } } }, { stale: false, notes: [] }, Date.parse('2026-10-23T12:00:00Z'));
  T.chk('NBA run notes count the Cup\'s total-points fallback (Estimated) and its random drawing', /12 runs reached the NBA Cup’s total-points tiebreaker without a game’s points/.test(cupMeta) && /1 run reached the NBA Cup’s random drawing/.test(cupMeta));
  T.chk('the registry gives the NBA its Cup tab, labelled', (REG.sports.find((s: any) => s.key === 'nba') as any).tabs.includes('cup'));
}
/* the MLB view, from a real (short) simulation of the committed 2025 World Series snapshot through the publisher's row mapping */
{
  const snap = mlbFixture('ws');
  const m = mlbModule(snap.data, { seed: 7n });
  const agg = runRange(m, { start: 0, end: 300 });
  const results = buildResults({ module: m, agg, seed: 7n, runs: 300, workers: 1, input_hash: snap.input_hash, input_snapshot_at: '2025-10-27T12:00:00Z', model_version: 'm', config: {}, rules_version: 'MLB-2022',
    started_at: '2025-10-27T12:00:00Z', finished_at: '2025-10-27T12:00:01Z', runtime_ms: 1, peak_rss_mb: 1,
    entityExtras: () => ({ record: { w: 93, l: 69 }, math_status: null }) });
  const res = resultRows({ results }), ents = entityRows({ results });
  const M = UI.buildModel({ sport: 'mlb', comparison_id: null }, res, ents, []);
  T.eq('MLB clubs are grouped by league, not conference', Object.keys(M.conferences).sort(), ['AL', 'NL']);
  const div = UI.renderDivision(M), conf = UI.renderConference(M), title = UI.renderTitle(M, { kind: 'unavailable' });
  T.chk('MLB division tab: W-L and projected wins, make postseason; no ties, points or OTL', />W-L</.test(div) && /Proj\. wins/.test(div) && /93-69/.test(div) && /Make postseason/.test(div) && !/W-L-T|W-L-OTL|>Pts</.test(div));
  T.eq('MLB division tab: six divisions of five', [(div.match(/<div class="sm-h">/g) || []).length, (div.match(/<tr><td>/g) || []).length], [6, 30]);
  T.chk('MLB league tab: per league seeds 1-6 with the two byes, the Division Series, the LCS and the pennant; no seed 7', ['American League seeds', 'National League seeds', '1 (bye)', '2 (bye)', '6', 'Division Series', 'LCS', 'Pennant'].every((h) => conf.includes('>' + h + '<')) && !conf.includes('>7<') && !conf.includes('>3 (bye)<'));
  T.chk('MLB title tab: the World Series, the pennant and the postseason, never the Super Bowl or a conference', /win World Series/.test(title) && /Pennant /.test(title) && /Postseason /.test(title) && !/Super Bowl|Conference /.test(title));
  T.eq('MLB title cards: one per club', (title.match(/class="sm-club"/g) || []).length, 30);
  const ws = ents.map((e: any) => (results.entities as any[]).find((x) => x.entity_id === e.entity_id).outcomes.win_world_series.probability);
  T.chk('... and its World Series column sums to one champion', Math.abs(ws.reduce((a: number, b: number) => a + b, 0) - 1) < 1e-9);
  T.eq('the reader asks the database for MLB\'s season', REG.mlb.season, '2026');
  T.eq('the league view is labelled League for MLB, Conference elsewhere', [UI.tabLabel({ key: 'mlb' }, 'conference'), UI.tabLabel({ key: 'nfl' }, 'conference')], ['League', 'Conference']);
  /* no Kalshi market mapped: the Futures tab still shows a fair price for every key outcome */
  const fut = UI.renderFutures(M, UI.marketState(null, { comparison_id: null }, []), { key: 'exec_edge_pp', dir: 'desc' });
  T.chk('MLB futures with no market mapped: the unavailable notice, then the fair-price board', /No Kalshi futures comparison/.test(fut) && /Fair prices/.test(fut) && ['Make postseason', 'Win division', 'Win pennant', 'Win World Series'].every((h) => fut.includes('>' + h + '<')));
  T.chk('... only clubs still alive for a listed outcome (the two pennant winners at most for the World Series)', (fut.match(/<tr><td><b>/g) || []).length >= 2 && (fut.match(/<tr><td><b>/g) || []).length <= 30);
  T.chk('... each open probability carries fair decimal and American odds', /<span class="sm-dim">\d+\.\d\d · [+-]\d+<\/span>/.test(fut));
  T.eq('fair American odds: 60% -150, 40% +150, 50% -100, none at 0 or 1', [UI.fairAmerican(0.6), UI.fairAmerican(0.4), UI.fairAmerican(0.5), UI.fairAmerican(0), UI.fairAmerican(1)], ['-150', '+150', '-100', '—', '—']);
  const evilM = UI.buildModel({ sport: 'mlb', comparison_id: null }, res.map((r: any) => ({ ...r, entity_name: '<img src=x onerror=1>' })), ents.map((e: any) => ({ ...e, entity_name: '<img src=x onerror=1>' })), []);
  T.chk('... hostile names are escaped on the fair-price board', !/<img/.test(UI.renderFairBoard(evilM)));
}
process.exit(T.done());
