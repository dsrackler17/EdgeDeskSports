#!/usr/bin/env node
/* ===========================================================================
   THE MODEL INTEGRITY AUDIT, offline (lib/edgedesk_model_integrity.js,
   tools/model_integrity/build.js). No network.

     1  price arithmetic as the audit reads it: American odds, no-vig, push-aware EV
     2  the market, timestamp-matched: a quote after the projection or after the
        start is never compared; no quote is no comparison
     3  thresholds: a disagreement past the sport's trigger is LARGE, never an
        edge; the NHL total 5.99 against 5.5 is not past 0.5 goals
     4  the signal rule: VALIDATED_INDEPENDENT_SIGNAL only with a market
        validated against the close, a record that beats the break-even and
        clean inputs; otherwise INSUFFICIENT_EVIDENCE, or the input explains it
     5  each sport's own inputs on fixture artifacts: a transferred NBA player,
        a missing injury feed, an NFL starter on the reserve list and a pending
        one, an unconfirmed NHL goalie and a CONFIRMED label on an unconfirmed
        side, a college favourite priced 90%+
     6  stale data: a stale projection is STALE_DATA first
     7  chronological validation: the last forecast before the start, the last
        quote at or before the forecast, a result after; nothing later
     8  the committed data: no validated signal, the build is reproducible at a
        fixed moment, and it writes nothing but its own artifact

     node tools/model_integrity/model_integrity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const MI = require(path.join(ROOT, 'lib', 'edgedesk_model_integrity.js'));
const CALC = require(path.join(ROOT, 'lib', 'edgedesk_calc.js'));
const BLD = require(path.join(ROOT, 'tools', 'model_integrity', 'build.js'));

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 300); ok = false; } } if (ok) pass++; else { fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); } }
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t == null ? 1e-4 : t);
function tmpRoot(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-'));
  Object.entries(files).forEach(([f, v]) => { const p = path.join(d, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); });
  return d;
}
const proj = (o) => Object.assign({ sport: 'nba', event_key: 'NBA|1', start_utc: '2026-10-27T00:00:00Z', home: { abbr: 'CHA' }, away: { abbr: 'WSH' },
  model: { id: 'm', version: 'v', predicted_at: '2026-10-26T13:00:00Z', inputs_known_at: '2026-10-26T05:00:00Z', market_inputs: [] },
  fair: { spread: { home_line: -9.5 }, total: { expected: 228.5 } }, projected_score: { margin: 10.2 }, outcome: { p_home: 0.78 },
  freshness: { state: 'FRESH', age_hours: 1, max_age_hours: 8 }, integrity: { invalidated: false, conflicts: [] },
  validation: { markets: { spread: { state: 'OUTCOME_VALIDATED', market_test: 'NOT_TESTED', value_claims: false } } } }, o || {});
const quote = (at, line, extra) => Object.assign({ book: 'DraftKings', source: 'espn_scoreboard', captured_at: at, moneyline: { home: -120, away: 100 }, spread: { home_point: line, home_price: -110, away_point: -line, away_price: -110 }, total: { point: 227.5, over: -110, under: -110 } }, extra || {});

/* ======================================================================== */
console.log('  · 1. price arithmetic');
chk('American −130 breaks even at 56.52%', near(CALC.impliedFromAmerican(-130), 0.565217));
chk('American +150 is 40%, −100 and +100 are 50%', near(CALC.impliedFromAmerican(150), 0.4) && near(CALC.impliedFromAmerican(-100), 0.5) && near(CALC.impliedFromAmerican(100), 0.5));
chk('an impossible price (−50) is no probability', CALC.impliedFromAmerican(-50) === null);
{
  const nv = CALC.noVigTwoWay(-180, 150);
  chk('no-vig −180 / +150: the pair sums to 1 and keeps its order', nv && near(nv.a + nv.b, 1, 1e-12) && near(nv.a, 0.642857 / (0.642857 + 0.4), 1e-5) && nv.overround > 0, nv);
  chk('no-vig −110 / −110 is 50/50 with a 4.76% overround', near(CALC.noVigTwoWay(-110, -110).a, 0.5) && near(CALC.noVigTwoWay(-110, -110).overround, 0.047619));
  const m = MI.market(quote('2026-10-26T12:00:00Z', -1.5, { moneyline: { home: -180, away: 150 } }));
  chk('the audit\'s market reads the same numbers: implied with vig, no-vig without', near(m.implied_home, 0.6429) && near(m.novig_home, nv.a, 1e-4) && near(m.implied_away, 0.4), m);
}
chk('push-aware EV: 0.47 win / 0.06 push at 1.909 is −4.27%', near(CALC.expectedValue(0.47, 0.06, 0.47, 1.909), 0.47 * 0.909 - 0.47));
chk('…and a push contributes nothing: 0.5 win / 0.5 push at 2.0 is +50%', near(CALC.expectedValue(0.5, 0.5, 0, 2), 0.5));
{
  /* the NHL example the brief named: over 5.5 at −130 needs P(6+ goals), not a mean above 5.5 */
  const be = CALC.impliedFromAmerican(-130);
  const ev = CALC.expectedValue(0.5267, 0, 0.4733, CALC.decimalFromAmerican(-130));
  chk('NHL over 5.5 at −130: the model\'s 52.67% is below the 56.52% break-even, EV −6.8%, though the mean (5.99) is above the line', 0.5267 < be && near(ev, -0.0682, 1e-3), [be, ev]);
}

/* ======================================================================== */
console.log('  · 2. the market, timestamp-matched');
{
  const qs = [quote('2026-10-25T10:00:00Z', -2), quote('2026-10-26T12:00:00Z', -1.5), quote('2026-10-26T15:00:00Z', -3), quote('2026-10-27T00:30:00Z', -4)];
  const pk = MI.pickQuotes(qs, '2026-10-26T13:00:00Z', '2026-10-27T00:00:00Z');
  chk('the compared quote is the latest at or before the projection', pk.at_prediction && pk.at_prediction.spread_home === -1.5 && pk.at_prediction.captured_at === '2026-10-26T12:00:00.000Z', pk);
  chk('the latest before the start is shown beside it, and nothing after the start is used', pk.latest && pk.latest.spread_home === -3);
  const old = MI.pickQuotes([quote('2026-10-24T12:00:00Z', -2)], '2026-10-26T13:00:00Z', '2026-10-27T00:00:00Z');
  chk('a quote older than the age limit before the projection is shown, never compared', old.at_prediction === null && old.latest && /no quote within 24 h/.test(old.basis), old);
  const none = MI.auditGame({ sport: 'nba', projection: proj(), quotes: [] });
  chk('missing market odds: no comparison, no disagreement, no market classification', none.market.compared === null && none.disagreement === null && !none.codes.some((c) => /DISAGREEMENT|EVIDENCE|SIGNAL/.test(c)) && /no quote on file/.test(none.market.basis), none);
  const after = MI.auditGame({ sport: 'nba', projection: proj(), quotes: [quote('2026-10-26T14:00:00Z', -1.5)] });
  chk('a quote captured after the projection is never the comparison (no hindsight)', after.market.compared === null && after.market.latest && after.disagreement === null, after.market);
}

/* ======================================================================== */
console.log('  · 3. thresholds');
{
  const a = MI.auditGame({ sport: 'nba', projection: proj(), quotes: [quote('2026-10-26T07:44:00Z', -1.5)] });
  chk('the unrounded margin is compared, not the half-point display line: 10.2 vs 1.5 is 8.7', a.disagreement.spread_pts === -8.7 && a.model.home_line === -10.2 && a.model.display_home_line === -9.5, a.disagreement);
  chk('8.7 points past the NBA trigger (3) is a LARGE_MARKET_DISAGREEMENT, named as a trigger, not proof', a.codes.indexOf('LARGE_MARKET_DISAGREEMENT') >= 0 && /not proof/.test(a.classifications.find((c) => c.code === 'LARGE_MARKET_DISAGREEMENT').message));
  chk('…and with clean inputs and no validated record it is INSUFFICIENT_EVIDENCE, never a signal', a.codes.indexOf('INSUFFICIENT_EVIDENCE') >= 0 && a.codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0 && a.signal_rule && !a.signal_rule.ok, a.codes);
  const small = MI.auditGame({ sport: 'nba', projection: proj({ projected_score: { margin: 4.5 } }), quotes: [quote('2026-10-26T07:44:00Z', -1.5)] });
  chk('exactly 3 points is not past "greater than 3"', small.disagreement.spread_pts === -3 && small.codes.length === 0 && small.status === 'OK', small.codes);
  const nhl = (exp, nvHome, line) => MI.auditGame({ sport: 'nhl', projection: proj({ sport: 'nhl', event_key: 'NHL|1', projected_score: { home: 3, away: 2.99 - 0.01 }, fair: { spread: { home_line: null }, total: { expected: exp } }, outcome: { p_home: 0.5373 } }),
    quotes: [quote('2026-10-26T07:44:00Z', null, { spread: null, total: { point: line, over: -130, under: 110 }, moneyline: nvHome })] });
  const t1 = nhl(5.99, { home: -130, away: 110 }, 5.5);
  chk('NHL: 5.99 expected goals against a 5.5 total is 0.49, not past the 0.5-goal trigger', t1.disagreement.total_pts === 0.49 && t1.codes.indexOf('LARGE_MARKET_DISAGREEMENT') < 0, t1.disagreement);
  const t2 = nhl(6.39, { home: -180, away: 150 }, 5.5);
  chk('NHL: 0.89 goals is past it, and the moneyline is measured against the no-vig price in points', t2.disagreement.over_threshold.some((o) => o.market === 'total') && t2.disagreement.win_prob_pp === r1(100 * (0.5373 - CALC.noVigTwoWay(-180, 150).a)), t2.disagreement);
  const cfg = MI.config({ thresholds: { nba: { spread_pts: 10 } } });
  chk('thresholds are configurable: at 10 points the same 8.7 is not flagged', MI.auditGame({ sport: 'nba', projection: proj(), quotes: [quote('2026-10-26T07:44:00Z', -1.5)] }, cfg).codes.indexOf('LARGE_MARKET_DISAGREEMENT') < 0 && cfg.thresholds.nfl.spread_pts === 3);
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine', 'model_integrity_config.json'), 'utf8'));
  chk('the operating config carries the brief\'s initial triggers', file.thresholds.nba.spread_pts === 3 && file.thresholds.nfl.spread_pts === 3 && file.thresholds.cfb.spread_pts === 5 && file.thresholds.nhl.ml_pp === 5 && file.thresholds.nhl.total_goals === 0.5, file.thresholds);
}
function r1(x) { return Math.round(x * 10) / 10; }

/* ======================================================================== */
console.log('  · 4. the signal rule');
{
  const rec = (n, k) => ({ above: { n, model_side_cover: { k, n, rate: k / n, wilson95: MI.wilson(k, n) } } });
  const val = { state: 'MARKET_VALIDATED', market_test: 'TESTED_AHEAD', value_claims: true };
  const go = (v, record, checks) => MI.auditGame({ sport: 'nfl', projection: proj({ sport: 'nfl', event_key: 'NFL|x', validation: { markets: { spread: v } } }), quotes: [quote('2026-10-26T07:44:00Z', -1.5)], record, checks });
  const ok = go(val, rec(400, 240));
  chk('a validated market, 400 graded gaps covering 60% (lower bound above 52.38%), clean inputs: VALIDATED_INDEPENDENT_SIGNAL', ok.codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') >= 0 && ok.signal_rule.ok, ok.signal_rule);
  chk('…an outcome-validated market is not enough', go({ state: 'OUTCOME_VALIDATED', market_test: 'NOT_TESTED' }, rec(400, 240)).codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0);
  chk('…nor a close test passed while the market is not MARKET_VALIDATED (value claims never switched on)', go({ state: 'OUTCOME_VALIDATED', market_test: 'TESTED_AHEAD' }, rec(400, 240)).codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0);
  chk('…nor a record under 200 games', go(val, rec(150, 100)).codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0);
  chk('…nor a record whose lower bound does not clear the break-even (54% of 400)', go(val, rec(400, 216)).codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0);
  const dirty = go(val, rec(400, 240), [{ code: 'MISSING_CRITICAL_INPUT', severity: 'high', component: 'x', message: 'QB unknown' }]);
  chk('…nor a game with an unresolved critical input: the input is the first explanation, so no INSUFFICIENT_EVIDENCE either', dirty.codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') < 0 && dirty.codes.indexOf('INSUFFICIENT_EVIDENCE') < 0 && dirty.status === 'MISSING_CRITICAL_INPUT', dirty.codes);
}

/* ======================================================================== */
console.log('  · 5. each sport\'s own inputs');
{
  /* NBA: Naz Reid (4396971) was MIN's absent regular while CHA's current roster carried him (the 2026-10-26 slate) */
  const g = { game_id: '1', home: { id: '16', abbr: 'MIN' }, away: { id: '5', abbr: 'CLE' }, predicted_at: '2026-10-26T13:00:00Z',
    availability: { home: { projected: [{ id: '1', name: 'Anthony Edwards', on_current_roster: true }], absent_regulars: [{ id: '4396971', name: 'Naz Reid' }], likely_starters: ['Anthony Edwards'], rotation_source: 'the team\'s previous game' }, away: { projected: [], absent_regulars: [] } },
    scenarios: [{ kind: 'returns', team: 'MIN', player: 'Naz Reid', player_id: '4396971', delta_p_home: -0.02 }, { kind: 'sits', team: 'MIN', player: 'Anthony Edwards', player_id: '1', delta_p_home: -0.07 }],
    decision: { gates: [{ gate: 'confirmed availability', pass: false }] }, uncertainty: { early_season: true, notes: [] } };
  const ri = { rosters_fallback: { teams: { 16: [{ id: '1' }], 30: [{ id: '4396971' }], 5: [] } } };
  const d = tmpRoot({ 'nba/slate.json': { rosters: { fetched_at: '2026-10-26T13:00:00Z' }, games: [g] }, 'nba/roster_inputs.json': ri });
  const c = BLD.nbaInputs(d, Date.parse('2026-10-26T14:00:00Z'))['NBA|1'];
  chk('NBA: a regular on another team\'s current roster is an INPUT_ERROR, high when it was priced as a return', c.checks.some((x) => x.code === 'INPUT_ERROR' && /Naz Reid/.test(x.message) && x.severity === 'high' && x.chip === 'Roster data error'), c.checks);
  chk('NBA: no injury feed in the price is a MISSING_CRITICAL_INPUT, "Missing injury inputs"', c.checks.some((x) => x.code === 'MISSING_CRITICAL_INPUT' && x.chip === 'Missing injury inputs'));
  chk('NBA: a player whose status moves the win probability 5+ points is listed unresolved', c.checks.some((x) => x.chip === 'Key player status unresolved' && /Anthony Edwards/.test(x.message)) && c.assumptions.unresolved.length === 1, c.assumptions);
  chk('NBA: who the price assumed active is published', c.assumptions.assumed_active.home[0] === 'Anthony Edwards');
  const fixed = JSON.parse(JSON.stringify(g)); fixed.availability.home.absent_regulars = []; fixed.availability.home.regulars_left_team = [{ id: '4396971', name: 'Naz Reid', now_with: 'CHA' }]; fixed.scenarios = fixed.scenarios.filter((s) => s.kind !== 'returns');
  const d2 = tmpRoot({ 'nba/slate.json': { games: [fixed] }, 'nba/roster_inputs.json': ri });
  const c2 = BLD.nbaInputs(d2, Date.now())['NBA|1'];
  chk('NBA: the repaired slate (the player under regulars_left_team) carries no input error', !c2.checks.some((x) => x.code === 'INPUT_ERROR') && c2.assumptions.left_team.home[0] === 'Naz Reid', c2.checks);
}
{
  /* NFL: the priced QB on the reserve list; a pending replacement */
  const qbs = 'season,team,position,status,full_name,first_name,last_name,jersey_number,depth_chart_position,gsis_id,espn_id,years_exp,headshot_url,week\n2026,PHI,QB,RES,Jalen Hurts,Jalen,Hurts,1,QB,00-0036389,,6,,7\n2026,PHI,QB,ACT,Tanner McKee,Tanner,McKee,16,QB,00-0038400,,3,,7\n';
  const games = [{ game_id: 'A', home_code: 'PHI', away_code: 'DAL', home_starter: { player_name: 'Jalen Hurts', player_id: '00-0036389', status: 'SCHEDULE_FEED' }, away_starter: { player_name: 'Dak Prescott', player_id: 'x', status: 'SCHEDULE_FEED' } },
    { game_id: 'B', home_code: 'WAS', away_code: 'PHI', home_starter: { player_name: 'Jayden Daniels', player_id: 'y', status: 'SCHEDULE_FEED' }, away_starter: { player_name: 'Tanner McKee', player_id: '00-0038400', status: 'ROSTER_RESERVE_REPLACEMENT_PENDING', scheduled: { player_name: 'Jalen Hurts', status: 'RES', report_week: 7 } } }];
  const d = tmpRoot({ 'football/nfl/slate.json': { season: 2026, games }, 'football/nfl/qbs_2026.csv': qbs, 'football/injuries/nfl_2026.json': { published: true, retrieved_at: '2026-10-25T11:36:24Z', latest_week: 7 } });
  const N = BLD.nflInputs(d, Date.parse('2026-10-26T14:00:00Z'));
  chk('NFL: a priced starting QB ruled out by the roster (RES) is an INPUT_ERROR', N['NFL|A'].checks.some((x) => x.code === 'INPUT_ERROR' && /Jalen Hurts is RES/.test(x.message)), N['NFL|A'].checks);
  chk('NFL: the backup priced in his place, pending the week\'s roster, is "Starting QB unconfirmed"', N['NFL|B'].checks.some((x) => x.code === 'MISSING_CRITICAL_INPUT' && x.chip === 'Starting QB unconfirmed' && /McKee/.test(x.message)) && !N['NFL|B'].checks.some((x) => x.code === 'INPUT_ERROR'), N['NFL|B'].checks);
  chk('NFL: the injury report\'s age is carried', N['NFL|A'].injury_feed.retrieved_at === '2026-10-25T11:36:24Z' && N['NFL|A'].injury_feed.age_hours > 24);
  const d3 = tmpRoot({ 'football/nfl/slate.json': { season: 2026, games }, 'football/nfl/qbs_2026.csv': qbs, 'football/injuries/nfl_2026.json': { published: true, retrieved_at: '2026-10-01T00:00:00Z' } });
  chk('NFL: an injury report more than 8 days old is STALE_DATA', BLD.nflInputs(d3, Date.parse('2026-10-26T14:00:00Z'))['NFL|A'].checks.some((x) => x.code === 'STALE_DATA'));
}
{
  /* NHL: goalies */
  const g = (goalies) => ({ game_id: '9', home: 'NYR', away: 'LAK', goalies, uncertainty: { goalie_range_p_home: [0.5353, 0.5534], calibration_bin: { range: [0.5, 0.6], n: 2793, model_mean: 0.5503, observed: 0.5274, wilson95: [0.5088, 0.5459] } } });
  const proj_ = { certainty: 'PROJECTED_UNCERTAIN', home: [{ name: 'D. Garand', p_start: 0.846, confirmed: false }, { name: 'I. Shesterkin', p_start: 0.154, confirmed: false }], away: [{ name: 'D. Kuemper', p_start: 0.6, confirmed: false }] };
  const d = tmpRoot({ 'hockey/slate.json': { readiness: { data: { state: 'FRESH' } }, games: [g(proj_)] } });
  const h = BLD.nhlInputs(d)['NHL|9'];
  chk('NHL: a projected goalie is "Starting goalie unconfirmed", with both candidates and the price\'s goalie range', h.checks.some((x) => x.chip === 'Starting goalie unconfirmed' && /Garand 85%/.test(x.message) && /Shesterkin 15%/.test(x.message) && /no goalie term/.test(x.message)), h.checks);
  chk('NHL: a probability bin outside its measured interval is "Calibration under review"', h.checks.some((x) => x.code === 'CALIBRATION_WARNING' && /55% predicted against 52\.7% observed/.test(x.message)));
  const wrong = JSON.parse(JSON.stringify(proj_)); wrong.certainty = 'CONFIRMED'; wrong.home = [{ name: 'D. Garand', p_start: 1, confirmed: true }];
  const d2 = tmpRoot({ 'hockey/slate.json': { readiness: { data: { state: 'STALE' } }, games: [g(wrong)] } });
  const h2 = BLD.nhlInputs(d2)['NHL|9'];
  chk('NHL: a CONFIRMED label with an unconfirmed side is an INPUT_ERROR (an unavailable goalie cannot ride a CONFIRMED label)', h2.checks.some((x) => x.code === 'INPUT_ERROR' && /CONFIRMED/.test(x.message)), h2.checks);
  chk('NHL: stale results are STALE_DATA', h2.checks.some((x) => x.code === 'STALE_DATA'));
  const scr = JSON.parse(JSON.stringify(proj_)); scr.conflicts = [{ side: 'home', goalie: 7, name: 'I. Shesterkin', reason: 'injured reserve' }];
  chk('NHL: a confirmation naming a goalie listed unavailable is an INPUT_ERROR', BLD.nhlInputs(tmpRoot({ 'hockey/slate.json': { games: [g(scr)] } }))['NHL|9'].checks.some((x) => x.code === 'INPUT_ERROR' && /Shesterkin/.test(x.message)));
}
{
  /* College football: an extreme favourite, against this season's measured 90%+ bucket */
  const cal = { data_through: '2026-10-18', diagnostics: { calibration: { table_fbs_vs_fbs: [{ bucket: '90-100', n: 45, avg_pred: 0.9478, actual: 0.8667, inside_interval: false }] }, margin_buckets: { fbs_vs_fbs: [{ bucket: '21+', n: 43, model_bias: -4.73, bias_se: 2.46 }] } } };
  const games = [{ game_id: 'T', home_team: 'Home U', away_team: 'Away U', home_division: 'fbs', away_division: 'fbs', model_home_margin: 24.5, model_home_win_prob: 0.95, home_starter: { player_name: 'A', status: 'DEPTH_CHART' }, away_starter: { player_name: 'B', status: 'COMPETITION' } },
    { game_id: 'F', home_team: 'Big U', away_team: 'FCS U', home_division: 'fbs', away_division: 'fcs', model_home_margin: 35, model_home_win_prob: 0.99 }];
  const d = tmpRoot({ 'football/fbs/slate.json': { games }, 'football/validation/cfb_live_calibration.json': cal });
  const C = BLD.cfbInputs(d);
  chk('CFB: a 95% FBS favourite carries the season\'s 90%+ record (86.7% won of 45, outside the interval)', C['CFB|T'].checks.some((x) => x.code === 'CALIBRATION_WARNING' && /86\.7% of 45/.test(x.message)), C['CFB|T'].checks);
  chk('CFB: a 24.5-point FBS favourite carries the 21+ bucket\'s measured shortfall', C['CFB|T'].checks.some((x) => /21\+ this season finished 4\.73 points short/.test(x.message)));
  chk('CFB: an FBS-vs-FCS game is not held to the FBS-vs-FBS record', !C['CFB|F'].checks.some((x) => x.code === 'CALIBRATION_WARNING'));
  chk('CFB: a contested starter is unconfirmed, and the card says the college price carries no QB term', C['CFB|T'].checks.some((x) => x.chip === 'Starting QB unconfirmed' && /carries no QB term/.test(x.message)));
}

/* ======================================================================== */
console.log('  · 6. stale data');
{
  const st = MI.auditGame({ sport: 'nba', projection: proj({ freshness: { state: 'STALE', why: 'built 30 h ago (limit 8 h)' } }), quotes: [quote('2026-10-26T07:44:00Z', -1.5)] });
  chk('a stale cached projection is STALE_DATA, ahead of the disagreement it carries', st.status === 'STALE_DATA' && st.codes.indexOf('LARGE_MARKET_DISAGREEMENT') > 0 && st.codes.indexOf('INSUFFICIENT_EVIDENCE') < 0, st.codes);
}

/* ======================================================================== */
console.log('  · 7. chronological validation');
{
  const L = (dir, rows) => [dir, rows.map((x) => JSON.stringify(x)).join('\n') + '\n'];
  const fc = (k, at, line) => ({ event_key: k, start_utc: '2026-10-20T00:00:00Z', model: { predicted_at: at, version: 'v' }, forecast: { fair_home_line: line, fair_total: 220, p_home: 0.6 } });
  const files = Object.fromEntries([
    L('performance/ledger/forecasts/nba-2026.jsonl', [fc('NBA|1', '2026-10-19T10:00:00Z', -4), fc('NBA|1', '2026-10-19T20:00:00Z', -5), fc('NBA|1', '2026-10-20T01:00:00Z', -12)]),
    L('performance/ledger/quotes/nba-2026.jsonl', [{ event_key: 'NBA|1', captured_at: '2026-10-19T09:00:00Z', spread: { home_point: -2 } }, { event_key: 'NBA|1', captured_at: '2026-10-19T19:00:00Z', spread: { home_point: -3 } }, { event_key: 'NBA|1', captured_at: '2026-10-19T21:00:00Z', spread: { home_point: -9 } }]),
    L('performance/ledger/results/nba-2026.jsonl', [{ event_key: 'NBA|1', state: 'FINAL', home_score: 110, away_score: 100 }])
  ]);
  const rows = BLD.ledgerRows(tmpRoot(files), 'nba');
  chk('the last forecast BEFORE the start is graded, never one made after it', rows.length === 1 && rows[0].model_home_line === -5, rows);
  chk('the market is the last quote at or before that forecast, never a later one', rows[0].market_home_line === -3, rows[0]);
  chk('the result is joined after', rows[0].final_margin === 10);
  const rec = MI.thresholdRecord([{ model_home_line: -10, market_home_line: -4, final_margin: 8 }, { model_home_line: -2, market_home_line: -1, final_margin: -3 }], 'spread', 3);
  chk('the record splits at the threshold: the model side covered (home −4, won by 8)', rec.above.n === 1 && rec.above.model_side_cover.k === 1 && rec.at_or_below.n === 1 && rec.at_or_below.model_side_cover.k === 0, rec);
}

/* ======================================================================== */
console.log('  · 8. the committed data');
{
  const NOW = '2026-10-26T17:30:00Z';
  const watch = ['performance/ledger/quotes/nba-2026.jsonl', 'performance/ledger/forecasts/nfl-2026.jsonl', 'nba/slate.json', 'hockey/slate.json', 'football/nfl/slate.json', 'engine/projections.json'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const h = () => watch.map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex')).join();
  const before = h();
  const a1 = BLD.build({ now: NOW }), a2 = BLD.build({ now: NOW });
  chk('the build reads the ledgers and the artifacts and writes none of them (historical records stay byte for byte)', h() === before);
  chk('the build is reproducible at a fixed moment', JSON.stringify(a1) === JSON.stringify(a2));
  /* every projection of the four sports the contract carries at that moment (a sport out of season carries none) */
  const S = require(path.join(ROOT, 'tools', 'performance', 'sources.js'));
  const want = S.currentProjections(ROOT, Date.parse(NOW)).projections.filter((p) => ['nba', 'nfl', 'cfb', 'nhl'].indexOf(p.sport) >= 0).map((p) => p.event_key).sort();
  chk('every NBA, NFL, college and NHL projection is audited, and nothing else', want.length > 0 && JSON.stringify(a1.games.map((g) => g.event_key).sort()) === JSON.stringify(want), [want.length, a1.games.length]);
  chk('no game on file is a VALIDATED_INDEPENDENT_SIGNAL: no market is validated against the close', !a1.games.some((g) => g.codes.indexOf('VALIDATED_INDEPENDENT_SIGNAL') >= 0));
  chk('every LARGE_MARKET_DISAGREEMENT names the quote it was measured against, captured before the projection', a1.games.filter((g) => g.codes.indexOf('LARGE_MARKET_DISAGREEMENT') >= 0).every((g) => g.market.compared && Date.parse(g.market.compared.captured_at) <= Date.parse(g.model.predicted_at)));
  chk('every model in the audit read no market input', a1.games.every((g) => Array.isArray(g.model.market_inputs) && g.model.market_inputs.length === 0));
  chk('the thresholds are validated on the record and the result is published', a1.threshold_validation && a1.threshold_validation.cfb.spread_history && a1.threshold_validation.cfb.spread_history.n_rows > 1000 && a1.threshold_validation.nfl.spread.n_rows > 0, Object.keys(a1.threshold_validation || {}));
}

/* ======================================================================== */
console.log('  · 9. the reader\'s view (lib/edgedesk_model_integrity_ui.js) and the board\'s signal');
{
  const vm = require('vm');
  const win = {};
  const file = { schema: 'edgedesk_model_integrity_v1', generated_at: '2026-10-26T18:00:00Z', games: [
    { slate_id: 'nhl:espn:1', status: 'MISSING_CRITICAL_INPUT', codes: ['MISSING_CRITICAL_INPUT', 'LARGE_MARKET_DISAGREEMENT'], home: 'EDM', away: 'DET',
      chips: [{ code: 'MISSING_CRITICAL_INPUT', label: 'Starting goalie unconfirmed' }, { code: 'LARGE_MARKET_DISAGREEMENT', label: 'Major model-market disagreement' }, { code: 'CALIBRATION_WARNING', label: 'Calibration under review' }],
      classifications: [{ code: 'MISSING_CRITICAL_INPUT', chip: 'Starting goalie unconfirmed', component: 'c', message: 'Levi <b>63%</b>' }], model: { id: 'm' }, market: { compared: null, basis: 'no quote on file' } },
    { slate_id: 'nhl:espn:2', status: 'LARGE_MARKET_DISAGREEMENT', codes: ['LARGE_MARKET_DISAGREEMENT', 'INSUFFICIENT_EVIDENCE'], chips: [{ code: 'LARGE_MARKET_DISAGREEMENT', label: 'Major model-market disagreement' }], classifications: [], model: {}, market: {} }] };
  let served = file;
  const ctx = { window: win, fetch: () => Promise.resolve({ ok: !!served, status: served ? 200 : 404, json: () => Promise.resolve(served) }), Date, JSON, Promise, String, Math, isFinite };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_model_integrity_ui.js'), 'utf8'), ctx);
  const U = win.EDIntegrityUI;
  (async () => {
    await U.load();
    const a = U.forEvent('nhl:espn:1'), b = U.forEvent('nhl:espn:2');
    chk('ui: an event finds its audit by the slate\'s own id, and an unknown one finds none', !!a && !!b && U.forEvent('nhl:espn:9') === null);
    const html = U.chipsHTML(a, 2);
    chk('ui: the chips are the audit\'s labels, in its order, at most the number asked', (html.match(/class="gm-chip warn"/g) || []).length === 2 && html.indexOf('Starting goalie unconfirmed') < html.indexOf('Major model-market disagreement') && !/Calibration/.test(html));
    chk('ui: every value it writes is escaped', !/<b>63%<\/b>/.test(html) && /&lt;b&gt;63%/.test(html) && !/<b>63/.test(U.detailHTML(a)));
    chk('ui: an unresolved critical input holds the signal badge; a disagreement alone does not', U.holdsSignal(a) === true && U.holdsSignal(b) === false && U.holdsSignal(null) === false);
    chk('ui: with no comparison the section says why, never a number', /no quote on file/.test(U.detailHTML(a)));
    const GUI = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_games_ui.js'), 'utf8');
    chk('board: the signal chip is withheld while the audit holds it (no confident badge on an unresolved input)', /if \(rd\.signal\.ok && !\(ia && window\.EDIntegrityUI\.holdsSignal\(ia\)\)\)/.test(GUI));
    chk('board: the audit shows only in the terminal, never on the public page', /function integrityOn\(\) \{ return S\.opts\.host !== 'public' && O\('model'\) !== false && !!window\.EDIntegrityUI; \}/.test(GUI)
      && !/edgedesk_model_integrity_ui\.js/.test(fs.readFileSync(path.join(ROOT, 'today', 'index.html'), 'utf8')));
    const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
    chk('app: the terminal loads the reader before the board', APP.indexOf('/lib/edgedesk_model_integrity_ui.js?v=') > 0 && APP.indexOf('/lib/edgedesk_model_integrity_ui.js?v=') < APP.indexOf('/lib/edgedesk_games_ui.js?v='));
    served = null; win.EDIntegrityUI = null;
    const ctx2 = Object.assign({}, ctx, { window: {} });
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_model_integrity_ui.js'), 'utf8'), ctx2);
    const j = await ctx2.window.EDIntegrityUI.load();
    chk('ui: a missing audit file shows nothing (no throw, no guess)', j === null && ctx2.window.EDIntegrityUI.forEvent('nhl:espn:1') === null && ctx2.window.EDIntegrityUI.chipsHTML(null) === '');
  })().then(finish, (e) => { chk('ui: ran', false, String(e && e.stack || e)); finish(); });
}

function finish() {
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'model integrity audit — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
}
