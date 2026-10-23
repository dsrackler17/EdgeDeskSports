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

const require = createRequire(import.meta.url);
const UI = require(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const REG = require(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
const T = kit('Simulator reader');

/* the registry the page shows is the one the publisher gates on */
T.chk('lib/edgedesk_simulator_sports.js is current with simulator/src/sports/registry.ts', (() => { try { execFileSync(process.execPath, [path.join(REPO, 'simulator', 'src', 'cli', 'build_ui_registry.ts'), '--check'], { stdio: 'pipe' }); return true; } catch (_) { return false; } })());
T.eq('every covered sport is listed, active or not', REG.sports.map((s: any) => s.key), sportRegistry().map((s) => s.key));
T.chk('the registry carries no probability', !/probab|"p":|\d\.\d{3,}/.test(fs.readFileSync(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'), 'utf8').replace(/max_reference_spread|0\.06/g, '')));
T.chk('every inactive sport names its blockers', REG.sports.filter((s: any) => s.status !== 'ACTIVE').every((s: any) => s.blockers.length > 0));
T.eq('UFC is Coming Soon (no artificial season)', REG.sports.find((s: any) => s.key === 'ufc').status, 'COMING_SOON');

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
process.exit(T.done());
