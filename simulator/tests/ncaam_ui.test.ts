/* ===========================================================================
   The college basketball views of the Simulator seat (lib/edgedesk_simulator_ncaam.js),
   as pure functions: states, provenance, escaping, never a number without
   entitlement. Rows are SYNTHETIC.
     node simulator/tests/ncaam_ui.test.ts
   =========================================================================== */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/ncaam/inputs.ts';

const req = createRequire(import.meta.url);
const T = kit('ncaam reader');
const SPORTS = req(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'));
(globalThis as any).EDSimSports = SPORTS;
const UI = req(path.join(REPO, 'lib', 'edgedesk_simulator.js'));
const N = req(path.join(REPO, 'lib', 'edgedesk_simulator_ncaam.js'));
const EVIL = '<img src=x onerror="window.__xss=1">';
const NUMBER = /\d+\.\d%/;

T.chk('the generated sport registry is current', (() => { try { execFileSync(process.execPath, [path.join(REPO, 'simulator', 'src', 'cli', 'build_ui_registry.ts'), '--check'], { stdio: 'pipe' }); return true; } catch (_) { return false; } })());
const reg = SPORTS.sports.find((s: any) => s.key === 'ncaam');
T.chk('the registry lists College Basketball as ncaam with its four tabs', !!reg && reg.tabs.join() === 'games,upset_watch,tournament,model_health');
T.chk('the registry carries the switched-off modes with their reasons', /selection/.test(SPORTS.ncaam.pre_selection.reason) && /conference/i.test(SPORTS.ncaam.conference_tournaments.reason));
T.chk('the registry carries no number', !/probab|"p":|\d\.\d{3,}/.test(fs.readFileSync(path.join(REPO, 'lib', 'edgedesk_simulator_sports.js'), 'utf8')));

const now = Date.parse('2026-11-10T15:00:00Z');
const fc = (o: any) => Object.assign({ game_id: '401900001', start_utc: '2026-11-10T23:00:00Z', home_id: '1', away_id: '2', home_name: 'Home State', away_name: 'Away Tech', neutral: false, event: 'regular', regime: 'D1_D1',
  available: true, p_home: 0.68, p_ot: 0.057, margin: { mean: 5.2, sd: 11.2, q10: -9, q90: 19 }, total: { mean: 141, sd: 15, q10: 122, q90: 160 }, pts_home: 73.1, pts_away: 67.9, games_played: { home: 2, away: 3 },
  data_quality: ['EARLY_SEASON_FEW_GAMES'], underdog: 'away', basis: 'model', p_underdog: 0.32, signals: ['high_uncertainty'], p_market_underdog: null, disagreement: null, factors: { pace: 69.1 },
  as_of: '2026-11-10T14:00:00Z', upset_policy: { version: 1, theta: 0.37 } }, o);
const status = { champion_key: 'ncaam_adjeff@1.0.0', champion_since: '2026-10-23T00:00:00Z', champion_decision: 'PROMOTE', last_weekly_decision: 'RETAIN', last_weekly_at: '2026-11-09T11:00:00Z',
  published_run_id: 'r1', published_as_of: '2026-11-10T14:00:00Z', published_at: '2026-11-10T14:05:00Z', last_attempt_status: 'completed', last_attempt_at: '2026-11-10T14:05:00Z', live_enabled: false };
const cache = (o: any) => Object.assign({ fc_status: status, entitled: true, forecasts: [fc({}), fc({ game_id: '401900002', home_name: EVIL, p_home: 0.6, underdog: 'away', p_underdog: 0.4, signals: ['upset_probability'] }),
  fc({ game_id: '401900003', available: false, unavailable_reason: 'neither team is a rated Division I team', p_home: null, signals: [], underdog: null })], health: { recent_reports: [
  { candidate: 'carry_higher', challenger: 'ncaam_adjeff@1.1.0', decision: 'RETAIN', created_at: '2026-11-09T11:00:00Z', gates: [{ id: 'G2_log_loss', pass: false, detail: 'difference -0.00004' }], summary: { challenger: { log_loss: 0.5356, slope: 1.05, margin_c80: 0.80 } } }] } }, o);

/* states */
T.eq('nothing published: no_data', N.forecastState({ fc_status: null }, now).kind, 'no_data');
T.chk('the incumbent champion explains why nothing is published', /incumbent points model/.test(N.forecastState({ fc_status: { champion_key: 'ncaam_points@1.1.0' } }, now).note));
T.eq('published but not entitled: unauthorized', N.forecastState(cache({ entitled: false }), now).kind, 'unauthorized');
T.eq('fresh: ok, not stale', [N.forecastState(cache({}), now).kind, N.forecastState(cache({}), now).stale], ['ok', false]);
T.chk('older than 36 hours: stale with the reason', N.forecastState(cache({}), now + 3 * 864e5).stale && /hours old/.test(N.forecastState(cache({}), now + 3 * 864e5).notes.join()));
T.chk('a failed refresh after the publication: stale, last good shown', N.forecastState(cache({ fc_status: Object.assign({}, status, { last_attempt_status: 'failed', last_attempt_at: '2026-11-10T14:40:00Z' }) }), now).stale);

/* the views */
const sport = reg;
const paint = (c: any, tab: string) => N.adapter.paint({ sport, cache: c, tab, nowMs: now });
const games = paint(cache({}), 'games');
T.chk('Games: win probabilities of both sides that add to 100%', /Away Tech<\/span> <b>32\.0%<\/b>/.test(games) && /<b>68\.0%<\/b> <span class="sm-dim">Home State/.test(games));
T.chk('Games: expected score, 80% margin and total intervals, overtime chance', /68–73/.test(games) && /−9 to \+19/.test(games) && /122–160/.test(games) && /5\.7%/.test(games));
T.chk('Games: one card per game, unavailable ones included', (games.match(/class="sm-club sm-gc"/g) || []).length === 3);
T.chk('Games: provenance and the EXPERIMENTAL label', /sm-research/.test(games) && /EXPERIMENTAL/.test(games));
T.chk('Games: data-quality flags are shown', /early season few games/.test(games));
T.chk('Games: an unavailable forecast says why, never a number', /No forecast: neither team is a rated Division I team/.test(games));
T.chk('Games: hostile names are escaped', !/<img/.test(games) && /&lt;img/.test(games));
T.chk('Games: availability is stated as not modelled', /Availability:<\/b> not modelled/.test(games));
const up = paint(cache({}), 'upset_watch');
T.chk('Upset Watch: three separate signals, never one score', /High upset probability/.test(up) && /Large disagreement with the market/.test(up) && /High uncertainty/.test(up) && !/upset score/i.test(up));
T.chk('Upset Watch: the frozen threshold is stated', /37\.0%/.test(up) && /frozen/.test(up));
T.chk('Upset Watch: the market signal is unavailable, not zero', /Unavailable until synchronized NCAAM quotes/.test(up));
T.chk('Upset Watch: every card shows its underdog basis', /model basis/.test(up));
T.chk('Upset Watch: the long uncertainty list is collapsed', /<details class="sm-lim"><summary>Show 1 games<\/summary>/.test(up));
T.chk('Upset Watch: no narrative boost', /No boost is added for March, momentum/.test(up));
T.chk('Upset Watch: factors are descriptive only', /none changes the probability/.test(up));
const tour = paint(cache({}), 'tournament');
T.chk('Tournament: blocked with its blockers, and no number', /Blocked/.test(tour) && /bracket/.test(tour) && !NUMBER.test(tour));
T.chk('Tournament: pre-selection and conference-tournament modes are off with reasons', /Before Selection Sunday/.test(tour) && /Conference tournaments/.test(tour));
const mh = paint(cache({}), 'model_health');
T.chk('Model Health: the champion and the latest decision', /ncaam_adjeff@1\.0\.0/.test(mh) && /RETAIN/.test(mh));
T.chk('Model Health: retraining is not called improvement', /not an improvement/.test(mh));
T.chk('Model Health: failed gates are listed', /G2_log_loss: difference -0.00004/.test(mh));
T.chk('Model Health: live forecasts are disabled', /Live forecasts/.test(mh) && /Disabled/.test(mh));
const lockG = paint(cache({ entitled: false }), 'games'), lockU = paint(cache({ entitled: false }), 'upset_watch'), lockH = paint(cache({ entitled: false }), 'model_health');
T.chk('not entitled: Games, Upset Watch and Model Health show no number', !NUMBER.test(lockG) && !NUMBER.test(lockU) && !NUMBER.test(lockH));
T.chk('not entitled: the Full Access card', /Full Access/.test(lockG));
T.chk('loading', /Loading/.test(paint({ loading: true }, 'games')));
T.chk('a read error is shown, escaped', /could not be read: &lt;b&gt;/.test(paint({ fc_status: status, entitled: true, error: '<b>x' }, 'games')));

/* preseason: the seat names its season's phase; what stays blocked is the tournament simulation */
{
  const pre = Date.parse('2026-10-24T15:00:00Z'), opener = Date.parse('2026-11-02T05:00:00Z');
  T.chk('the registry dates the opening day; the tournament simulation stays BLOCKED (the planner\'s gate)', reg.games && reg.games.regular_season_start === '2026-11-02T05:00:00Z' && reg.status === 'BLOCKED');
  T.eq('seasonPhase: preseason before the opener, the season from the opener on, null for a sport without game forecasts',
    [UI.seasonPhase(reg, pre), UI.seasonPhase(reg, opener - 1), UI.seasonPhase(reg, opener), UI.seasonPhase(reg, now), UI.seasonPhase(SPORTS.sports.find((s: any) => s.key === 'nfl'), pre)], ['preseason', 'preseason', 'season', 'season', null]);
  T.eq('the opening day, in US Eastern', UI.openingDay(reg), 'Mon, Nov 2');
  const paintAt = (c: any, tab: string, t: number) => N.adapter.paint({ sport: reg, cache: c, tab, nowMs: t });
  const empty = paintAt({ fc_status: { champion_key: 'ncaam_adjeff@1.0.0' }, entitled: true }, 'games', pre);
  T.chk('preseason, nothing published: the preseason card, the opening day and why exhibitions are not priced', /class="sm-card sm-preseason"/.test(empty) && /regular season opens Mon, Nov 2/.test(empty) && /Exhibition games are priced where a school lists one/.test(empty) && /takes over on its own/.test(empty) && /No college basketball forecast has been published yet/.test(empty));
  const preFc = (o: any) => fc(Object.assign({ start_utc: '2026-11-02T23:00:00Z', as_of: '2026-10-24T13:40:00Z', data_quality: ['PRESEASON_RATINGS', 'EARLY_SEASON_FEW_GAMES'], games_played: { home: 0, away: 0 } }, o));
  const preCache = cache({ fc_status: Object.assign({}, status, { published_as_of: '2026-10-24T13:40:00Z', published_at: '2026-10-24T13:45:00Z' }), forecasts: [preFc({})] });
  const g = paintAt(preCache, 'games', pre), u = paintAt(preCache, 'upset_watch', pre);
  T.chk('preseason, published: the card above the opening week\'s forecasts, each flagged', /sm-preseason/.test(g) && /preseason ratings/.test(g) && /early season few games/.test(g) && /68\.0%/.test(g) && g.indexOf('sm-preseason') < g.indexOf('sm-gc'));
  T.chk('...and above Upset Watch', /sm-preseason/.test(u) && /High upset probability/.test(u));
  T.chk('after the opener, forecasts made before it say so until the next refresh replaces them', /regular season opened Mon, Nov 2/.test(paintAt(preCache, 'games', opener + 3600e3)) && /made before it/.test(paintAt(preCache, 'games', opener + 3600e3)));
  T.chk('in season, in-season forecasts: no preseason card', !/sm-preseason/.test(games) && !/sm-preseason/.test(up));
  T.chk('preseason, not entitled: the card and the lock, no number', /sm-preseason/.test(paintAt(cache({ entitled: false }), 'games', pre)) && /Full Access/.test(paintAt(cache({ entitled: false }), 'games', pre)) && !NUMBER.test(paintAt(cache({ entitled: false }), 'games', pre)));
  T.chk('Tournament: the blocked card names the tournament simulation, not the seat', /NCAA tournament simulation — Blocked/.test(tour) && !/Men&#39;s College Basketball — Blocked/.test(tour));
  /* the picker (the clock decides Preseason or nothing; never Blocked) */
  const host: any = { innerHTML: '', addEventListener() {}, querySelector() { return null; } };
  UI.open(host, { sport: 'ncaam' });
  const btn = (k: string) => (host.innerHTML.match(new RegExp('<button[^>]*data-sim-sport="' + k + '"[^>]*>[\\s\\S]*?</button>')) || [''])[0];
  for (const k of ['ncaam', 'ncaaw']) {
    const b = btn(k), sp = SPORTS.sports.find((s: any) => s.key === k);
    T.chk('picker: ' + k + ' is never marked Blocked or dimmed, and says Preseason exactly before its opening day', !!b && !/Blocked/.test(b) && !/sm-sport[^"]* off/.test(b) && /Preseason/.test(b) === (UI.seasonPhase(sp, Date.now()) === 'preseason'));
  }
  T.chk('picker: a sport without game forecasts keeps its status chip (college baseball, NFL unchanged)', !/Preseason/.test(btn('nfl')) && !/Preseason/.test(btn('college_baseball')));
}

/* the adapter is registered with the reader through its public hook only */
T.chk('the reader exports registerSport and the shared helpers', typeof UI.registerSport === 'function' && typeof UI.badge === 'function' && typeof UI.cell === 'function');
UI.registerSport('ncaam', N.adapter);
T.chk('the adapter is registered', UI._adapters.ncaam === N.adapter);
T.throws('an adapter without load/paint is refused', () => UI.registerSport('x', {}), /needs load and paint/);

process.exit(T.done());
