/* ===========================================================================
   The women's college basketball views of the Simulator seat
   (lib/edgedesk_simulator_ncaaw.js), as pure functions: states, provenance,
   escaping, never a number without entitlement, and a Tournament tab that
   reads nothing (no women's tournament simulation is built). Rows are
   SYNTHETIC.
     node simulator/tests/ncaaw_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { planRuns, RUNNABLE } from '../src/cli/plan.ts';

const req = createRequire(import.meta.url);
const T = kit('ncaaw reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const N = req(path.join(REPO, 'lib', 'edgedesk_simulator_ncaaw.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const NUMBER = /\d+\.\d%/;
const SRC = fs.readFileSync(path.join(REPO, 'lib', 'edgedesk_simulator_ncaaw.js'), 'utf8');

/* the registry */
T.chk('the generated sport registry is current', (() => { try { execFileSync(process.execPath, [path.join(REPO, 'simulator', 'src', 'cli', 'build_ui_registry.ts'), '--check'], { stdio: 'pipe' }); return true; } catch (_) { return false; } })());
const reg = SPORTS.sports.find((s: any) => s.key === 'ncaaw');
T.chk('the registry lists Women\'s College Basketball as ncaaw with its four tabs', !!reg && reg.label === 'Women\'s College Basketball' && reg.tabs.join() === 'games,upset_watch,tournament,model_health');
T.chk('...and the men\'s entry is labelled as the men\'s', SPORTS.sports.find((s: any) => s.key === 'ncaam').label === 'Men\'s College Basketball');
T.chk('the women\'s tournament is BLOCKED, and its blockers name the host sites and the unverified 2027 field', reg.status === 'BLOCKED' && reg.blockers.length === 2 && /top 16 seeds/.test(reg.blockers[0]) && /not neutral/.test(reg.blockers[0]) && /2027/.test(reg.blockers[1]) && /Selection Sunday/.test(reg.blockers[1]));
T.chk('the limitations say availability, the market and live forecasts are not modelled, and claim no simulation error', reg.limitations.some((l: string) => /availability is not modelled/i.test(l)) && reg.limitations.some((l: string) => /No market comparison/.test(l))
  && reg.limitations.some((l: string) => /live\) forecasts are not built/.test(l)) && !reg.limitations.some((l: string) => /Monte Carlo/.test(l)));
T.chk('the registry carries the switched-off modes and the live status with their reasons', SPORTS.ncaaw.season === '2027' && SPORTS.ncaaw.pre_selection.enabled === false && /No women's tournament simulation/.test(SPORTS.ncaaw.pre_selection.reason)
  && SPORTS.ncaaw.conference_tournaments.enabled === false && SPORTS.ncaaw.live.enabled === false && /no live writer/.test(SPORTS.ncaaw.live.blockers[0]));
T.chk('the registry carries no number', !/probab|"p":|\d\.\d{3,}/.test(fs.readFileSync(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'), 'utf8')));

/* the planner never simulates it */
T.chk('no simulation module is runnable for ncaaw', !('ncaaw' in RUNNABLE));
T.chk('the nightly plan never includes ncaaw', !planRuns('schedule', {}, sportRegistry(), new Date('2027-03-20T08:00:00Z')).some((r) => r.sport === 'ncaaw'));
T.throws('a dispatched ncaaw run is refused: no simulation module', () => planRuns('workflow_dispatch', { sport: 'ncaaw', season: '2027', runs: '100000', publish: 'false' }), /no simulation module/);

/* the reader reads only the women's objects */
T.chk('the reader reads the women\'s objects and never a men\'s one', /rpc\/ncaaw_fc_public_status/.test(SRC) && /ncaaw_fc_current_forecasts/.test(SRC) && /ncaaw_fc_model_health/.test(SRC) && !/ncaam_fc/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
T.chk('the reader never reads a simulation table', !/sim_current|sim_public_status/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));

const now = Date.parse('2026-11-10T15:00:00Z');
const fc = (o: any) => Object.assign({ game_id: '401900001', start_utc: '2026-11-10T23:00:00Z', home_id: '1', away_id: '2', home_name: 'Home State', away_name: 'Away Tech', neutral: false, event: 'regular', regime: 'D1_D1',
  available: true, p_home: 0.74, p_ot: 0.041, margin: { mean: 9.1, sd: 12.6, q10: -7, q90: 25 }, total: { mean: 132, sd: 14, q10: 114, q90: 150 }, pts_home: 70.6, pts_away: 61.4, games_played: { home: 2, away: 3 },
  data_quality: ['EARLY_SEASON_FEW_GAMES'], underdog: 'away', basis: 'model', p_underdog: 0.26, signals: ['high_uncertainty'], p_market_underdog: null, disagreement: null, factors: { pace: 70.1 },
  as_of: '2026-11-10T14:00:00Z', upset_policy: { version: 1, theta: 0.33 } }, o);
const status = { champion_key: 'ncaaw_adjeff@1.0.0', champion_since: '2026-10-24T00:00:00Z', champion_decision: 'PROMOTE', last_weekly_decision: 'RETAIN', last_weekly_at: '2026-11-09T11:30:00Z',
  published_run_id: 'r1', published_as_of: '2026-11-10T14:00:00Z', published_at: '2026-11-10T14:05:00Z', last_attempt_status: 'completed', last_attempt_at: '2026-11-10T14:05:00Z', live_enabled: false };
const cache = (o: any) => Object.assign({ fc_status: status, entitled: true, forecasts: [fc({}), fc({ game_id: '401900002', home_name: EVIL, p_home: 0.62, underdog: 'away', p_underdog: 0.38, signals: ['upset_probability'] }),
  fc({ game_id: '401900003', available: false, unavailable_reason: 'neither team is a rated Division I team', p_home: null, signals: [], underdog: null })], health: { recent_reports: [
  { candidate: 'carry_higher', challenger: 'ncaaw_adjeff@1.1.0', decision: 'RETAIN', created_at: '2026-11-09T11:30:00Z', gates: [{ id: 'G2_log_loss', pass: false, detail: 'difference -0.00004' }], summary: { challenger: { log_loss: 0.4561, slope: 1.03, margin_c80: 0.80 } } }] } }, o);

/* states */
T.eq('nothing published: no_data', N.forecastState({ fc_status: null }, now).kind, 'no_data');
T.chk('the incumbent champion explains why nothing is published', /incumbent points model/.test(N.forecastState({ fc_status: { champion_key: 'ncaaw_points@1.1.0' } }, now).note));
T.chk('...a men\'s champion key never triggers the women\'s note', !N.forecastState({ fc_status: { champion_key: 'ncaam_points@1.1.0' } }, now).note);
T.eq('published but not entitled: unauthorized', N.forecastState(cache({ entitled: false }), now).kind, 'unauthorized');
T.eq('fresh: ok, not stale', [N.forecastState(cache({}), now).kind, N.forecastState(cache({}), now).stale], ['ok', false]);
T.chk('older than 36 hours: stale with the reason', N.forecastState(cache({}), now + 3 * 864e5).stale && /hours old/.test(N.forecastState(cache({}), now + 3 * 864e5).notes.join()));
T.chk('a failed refresh after the publication: stale, last good shown', N.forecastState(cache({ fc_status: Object.assign({}, status, { last_attempt_status: 'failed', last_attempt_at: '2026-11-10T14:40:00Z' }) }), now).stale);

/* the views */
const sport = reg;
const paint = (c: any, tab: string) => N.adapter.paint({ sport, cache: c, tab, nowMs: now });
const games = paint(cache({}), 'games');
T.chk('Games: win probabilities of both sides that add to 100%', /Away Tech<\/span> <b>26\.0%<\/b>/.test(games) && /<b>74\.0%<\/b> <span class="sm-dim">Home State/.test(games));
T.chk('Games: expected score, 80% margin and total intervals, overtime chance', /61–71/.test(games) && /−7 to \+25/.test(games) && /114–150/.test(games) && /4\.1%/.test(games));
T.chk('Games: one card per game, unavailable ones included', (games.match(/class="sm-club sm-gc"/g) || []).length === 3);
T.chk('Games: provenance and the EXPERIMENTAL label', /sm-research/.test(games) && /EXPERIMENTAL/.test(games) && /ncaaw_adjeff@1\.0\.0/.test(games));
T.chk('Games: data-quality flags are shown', /early season few games/.test(games));
T.chk('Games: an unavailable forecast says why, never a number', /No forecast: neither team is a rated Division I team/.test(games));
T.chk('Games: hostile names are escaped', !/<img/.test(games) && /&lt;img/.test(games));
T.chk('Games: availability is stated as not modelled, for the women\'s game', /Availability:<\/b> not modelled\. No owned women’s college-basketball injury or lineup feed/.test(games));
const up = paint(cache({}), 'upset_watch');
T.chk('Upset Watch: three separate signals, never one score', /High upset probability/.test(up) && /Large disagreement with the market/.test(up) && /High uncertainty/.test(up) && !/upset score/i.test(up));
T.chk('Upset Watch: the frozen threshold and the women\'s development window are stated', /33\.0%/.test(up) && /2018-2022 development games/.test(up) && /frozen/.test(up));
T.chk('Upset Watch: the market signal is unavailable, not zero, and says why', /Unavailable: no women’s college basketball price is captured/.test(up) && !/NCAAM/.test(up));
T.chk('Upset Watch: every card shows its underdog basis', /model basis/.test(up));
T.chk('Upset Watch: the long uncertainty list is collapsed', /<details class="sm-lim"><summary>Show 1 games<\/summary>/.test(up));
T.chk('Upset Watch: no narrative boost', /No boost is added for March, momentum/.test(up));
const tour = paint(cache({}), 'tournament');
T.chk('Tournament: blocked with its blockers, and no number', /Blocked/.test(tour) && /top 16 seeds/.test(tour) && /Selection Sunday/.test(tour) && !NUMBER.test(tour));
T.chk('Tournament: the switched-off modes are stated with their reasons', /Before Selection Sunday:<\/b> No women’s tournament simulation is built|Before Selection Sunday:<\/b> No women&#39;s tournament simulation is built|Before Selection Sunday:<\/b> No women&#x27;s tournament simulation is built/.test(tour) && /Conference tournaments/.test(tour));
T.chk('Tournament: the same blocked view for a reader without Full Access (nothing to lock)', paint(cache({ entitled: false }), 'tournament') === tour);
const mh = paint(cache({}), 'model_health');
T.chk('Model Health: the champion and the latest decision', /ncaaw_adjeff@1\.0\.0/.test(mh) && /RETAIN/.test(mh));
T.chk('Model Health: retraining is not called improvement', /not an improvement/.test(mh));
T.chk('Model Health: failed gates are listed', /G2_log_loss: difference -0.00004/.test(mh));
T.chk('Model Health: live forecasts are disabled, and not built for the women\'s game', /Live forecasts/.test(mh) && /Disabled/.test(mh) && /no live writer/.test(mh));
const lockG = paint(cache({ entitled: false }), 'games'), lockU = paint(cache({ entitled: false }), 'upset_watch'), lockH = paint(cache({ entitled: false }), 'model_health');
T.chk('not entitled: Games, Upset Watch and Model Health show no number', !NUMBER.test(lockG) && !NUMBER.test(lockU) && !NUMBER.test(lockH));
T.chk('not entitled: the Full Access card names the women\'s forecasts and Upset Watch only', /Full Access/.test(lockG) && /Women’s college basketball forecasts and Upset Watch are part of Full Access/.test(lockG) && !/tournament simulation/.test(lockG));
T.chk('loading', /Loading the latest published women’s college basketball forecasts/.test(paint({ loading: true }, 'games')));
T.chk('nothing published: the women\'s empty state', /No women’s college basketball forecast has been published yet/.test(paint({ fc_status: { champion_key: 'ncaaw_points@1.1.0' }, entitled: true }, 'games')));
T.chk('a read error is shown, escaped', /could not be read: &lt;b&gt;/.test(paint({ fc_status: status, entitled: true, error: '<b>x' }, 'games')));

/* the load reads exactly the women's objects, and only entitled readers get rows */
{
  const asked: string[] = [];
  const get = async (q: string) => { asked.push(q); if (/public_status/.test(q)) return [status]; if (/sim_viewer_entitled/.test(q)) return false; return []; };
  const c: any = {}; await N.adapter.load(get, c, { sport });
  T.eq('not entitled: the load asks only the public status and the entitlement', asked.map((q) => q.split('?')[0]), ['rpc/ncaaw_fc_public_status', 'rpc/sim_viewer_entitled']);
  const asked2: string[] = [];
  const get2 = async (q: string) => { asked2.push(q); if (/public_status/.test(q)) return [status]; if (/sim_viewer_entitled/.test(q)) return true; if (/current_forecasts/.test(q)) return [fc({})]; return [{ recent_reports: [] }]; };
  const c2: any = {}; await N.adapter.load(get2, c2, { sport });
  T.eq('entitled: the forecasts and the model health, nothing else', asked2.map((q) => q.split('?')[0]), ['rpc/ncaaw_fc_public_status', 'rpc/sim_viewer_entitled', 'ncaaw_fc_current_forecasts', 'ncaaw_fc_model_health']);
  T.chk('...the forecasts arrive in the cache', c2.forecasts.length === 1 && c2.entitled === true);
}

/* the adapter is registered with the reader through its public hook only */
UI.registerSport('ncaaw', N.adapter);
T.chk('the adapter is registered beside the men\'s, as its own sport', UI._adapters.ncaaw === N.adapter && UI._adapters.ncaaw !== UI._adapters.ncaam);

process.exit(T.done());
