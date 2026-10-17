#!/usr/bin/env node
/* ============================================================================
   ALTITUDE & TRAVEL — the module, its registry, its record and its locks.

   The fixture is Notre Dame at BYU: LaVell Edwards Stadium, the largest
   elevation climb a Power-conference visitor makes, played on 2026-10-17
   (game 401856809), on 2004-09-04 in Provo, and at a neutral Allegiant
   Stadium in 2022. Every number asserted here is computed from committed
   files (football/altitude/venues.json, params.js, the fixture schedule
   rows) — nothing is fetched.

   What must hold:
     1  the measurements: elevation, gain, ratio, distance, DST-correct time
        zones (including Indiana before 2006), rest, acclimatization proxies
     2  a descent is a descent, a neutral site is not a home game, a missing
        elevation is missing (never imputed), a legacy stadium id never
        inherits its successor's elevation
     3  the three locks: nothing moves a published number unless the
        parameters say VALIDATED with points_applied AND the server flag is
        on — and when all three are open, the engine applies exactly the
        capped adjustment and explains it
     4  the record: params.js and football/validation/altitude_cfb.json agree,
        the gates are the declared ones, a failed gate means 0 points
     5  the words: the section, the desk facts and the page never claim an
        edge, a certainty, or a mechanism nobody validated

   Run: node football/altitude/altitude.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
const A = require('./engine.js');
const REG = require('./venues.json');
const PARAMS = require('./params.js');
const VAL = require(path.join(ROOT, 'football', 'validation', 'altitude_cfb.json'));
const GATES = require('./research/gates.js');
const FIX = require('./fixtures/byu_notredame.json');
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const P4 = global.EDCfbP4Params;

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error('  FAIL: ' + what + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function near(a, b, tol, what) { ok(typeof a === 'number' && Math.abs(a - b) <= tol, what + ' (got ' + a + ', wanted ' + b + ' ± ' + tol + ')'); }
function section(t) { console.log('\n' + t); }

const rows = FIX.games.map(g => Object.assign({}, g, { start_date: g.start_date }));
const env = (season) => ({ registry: REG, normKey: FBS.normKey,
  index: A.teamIndex(rows.filter(r => r.season === season || r.season === season - 1), FBS.normKey) });
const game = id => rows.find(r => String(r.game_id) === String(id));

/* ------------------------------------------------------------------ 1 */
section('1. Notre Dame at BYU, 2026-10-17 (game 401856809)');
const g26 = game('401856809');
ok(!!g26, 'the fixture carries the 2026 game');
const c26 = A.context(g26, env(2026));
eq(c26.venue.venue_id, 3801, 'located by the schedule venue id: LaVell Edwards Stadium');
eq(c26.venue.elev_ft, 4633, 'game elevation 4,633 ft (CollegeFootballData 1,412.1 m)');
eq(c26.venue.confidence, 'HIGH', 'three agreeing sources: HIGH confidence');
eq(c26.home.usual_elev_ft, 4633, 'BYU normally plays at 4,633 ft');
eq(c26.away.usual_elev_ft, 731, 'Notre Dame normally plays at 731 ft (Notre Dame Stadium, 222.6 m)');
eq(c26.away.gain_ft, 3902, 'Notre Dame climbs 3,902 ft');
eq(c26.home.gain_ft, 0, 'BYU is at home: no climb');
eq(c26.away.bucket, 'high_gain', 'bucket: 3,000+ ft');
eq(c26.away.direction, 'gain', 'direction: gain');
eq(c26.exposure.class, 'HIGH', 'exposure HIGH, about the visitor');
eq(c26.exposure.team, 'Notre Dame', 'the exposure is Notre Dame’s');
near(c26.away.ratio, 6.34, 0.005, 'ratio 6.34x (descriptive only)');
eq(c26.away.ratio_ge6, true, 'clears 6x');
near(c26.away.distance_mi, 1325, 2, 'about 1,325 miles from Notre Dame Stadium');
eq(c26.away.tz_change_h, -2, 'two zones west at kickoff (EDT -4 to MDT -6)');
eq(c26.away.acclimatization.resident_high, false, 'Notre Dame does not live at altitude');
eq(c26.away.acclimatization.recent_high_exposure, false, 'its previous game was not at altitude');
eq(c26.home.acclimatization.resident_high, true, 'BYU lives at altitude');
ok(c26.away.rest_days > 0 && c26.home.rest_days > 0, 'rest days from the previous game of the same season');
ok(c26.quality.usable, 'usable for the adjustment');

const adj26 = A.adjustment(c26, PARAMS, { flag_enabled: false });
eq(adj26.status, 'SHADOW', 'the adjustment is a SHADOW');
eq(adj26.applied_points, 0, '0 points applied');
eq(adj26.applied, false, 'not applied');
eq(adj26.model, PARAMS.shadow_candidate.id, 'shadow from the selected candidate');
near(adj26.shadow_points, PARAMS.shadow_candidate.coefficients.high_gain, 0.006, 'shadow = the shrunk 3,000+ ft coefficient');
ok(/not passed its validation gates/.test(adj26.reason), 'the reason names the failed gates', adj26.reason);
const adjFlag = A.adjustment(c26, PARAMS, { flag_enabled: true });
eq(adjFlag.applied_points, 0, 'the server flag alone cannot move a point while the gates have failed');

/* ------------------------------------------------------------------ 2 */
section('2. the same matchup in 2004 and at a neutral site in 2022');
const g04 = game('242480252');
const c04 = A.context(g04, env(2004));
eq(c04.venue.venue_id, 3801, '2004 in Provo');
eq(c04.away.gain_ft, 3902, 'the same 3,902 ft climb');
eq(c04.away.tz_change_h, -1, 'Indiana had no DST in 2004: EST -5 to MDT -6 is one zone, not two');
eq(A.tzOffsetAt('America/Indiana/Indianapolis', Date.parse('2004-09-05T01:15:00Z')), -5, 'Indiana on standard time in September 2004');
eq(A.tzOffsetAt('America/Indiana/Indianapolis', Date.parse('2026-10-17T23:30:00Z')), -4, 'Indiana on daylight time in October 2026');
eq(A.tzOffsetAt('America/Phoenix', Date.parse('2026-10-17T23:30:00Z')), -7, 'Arizona never observes DST');
eq(A.tzOffsetAt('America/Denver', Date.parse('2026-11-01T07:59:00Z')), -6, 'Denver still on MDT one minute before 02:00 MDT, 1 Nov 2026');
eq(A.tzOffsetAt('America/Denver', Date.parse('2026-11-01T08:00:00Z')), -7, 'Denver on MST from 02:00 MDT, 1 Nov 2026');
eq(A.tzOffsetAt('America/Denver', Date.parse('2006-10-29T08:00:00Z')), -7, 'the pre-2007 rule ends DST on the last Sunday of October');

const g22 = game('401404127');
const c22 = A.context(g22, env(2022));
eq(c22.neutral_site, true, '2022 at Allegiant Stadium is a neutral site');
eq(c22.venue.venue_id, 6501, 'located at Allegiant (not either campus)');
eq(c22.home.team, 'Notre Dame', 'Notre Dame was the designated home team (Shamrock Series)');
eq(c22.home.gain_ft, Math.round(REG.venues['6501'].elev_ft - REG.venues['3855'].elev_ft), 'the designated home team still climbs ~1,455 ft to Las Vegas');
eq(c22.home.bucket, 'moderate_gain', 'a moderate climb');
eq(c22.away.gain_ft, Math.round(REG.venues['6501'].elev_ft - REG.venues['3801'].elev_ft), 'BYU descends ~2,448 ft');
eq(c22.away.bucket, 'descent', 'a descent is not "no gain"');
eq(c22.away.direction, 'loss', 'direction: loss');
eq(c22.focus, 'home', 'at a neutral site the story is about the team that climbed, whichever side the schedule lists');
eq(c22.exposure.team, 'Notre Dame', '... Notre Dame');
eq(A.adjustment(c22, PARAMS, { flag_enabled: true }).status, 'NOT_APPLICABLE', 'a neutral site is never adjusted');

section('2b. buckets, legacy stadiums and missing elevations');
eq(A.gainBucket(0), 'level', '0 ft: level');
eq(A.direction(0), 'none', '0 ft: no gain');
eq(A.direction(-500), 'loss', '-500 ft: a loss, within the level bucket');
eq(A.gainBucket(-1000), 'descent', '-1,000 ft: descent');
eq(A.gainBucket(-3500), 'large_descent', '-3,500 ft: large descent');
eq(A.gainBucket(2999), 'moderate_gain', '2,999 ft: moderate');
eq(A.gainBucket(3000), 'high_gain', '3,000 ft: high');
eq(REG.venues['3761'].elev_ft, 5167.1, 'Hughes Stadium keeps its own captured elevation, not Canvas Stadium’s');
eq(REG.venues['3761'].legacy_of, 5388, '... and is marked as Canvas Stadium’s legacy id');
eq(REG.venues['3914'].elev_ft, 1607.8, 'Sam Boyd Stadium is not given Allegiant Stadium’s 2,185 ft');
ok(REG.venues['3914'].confidence !== 'HIGH', 'a research-package capture is never HIGH');
const g12 = rows.find(r => r.season === 2012 && r.venue_id === 3761);
if (g12) {
  const c12 = A.context(g12, env(2012));
  eq(c12.venue.elev_ft, 5167, 'a 2012 Colorado State home game is placed at Hughes Stadium’s elevation');
}
Object.keys(REG.venues).forEach(k => {
  const v = REG.venues[k];
  if (!(v.elev_ft != null && ['HIGH', 'MEDIUM', 'LOW'].indexOf(v.confidence) >= 0 && v.sources.length)) ok(false, 'registry entry ' + k + ' is complete', v);
});
ok(Object.keys(REG.venues).length > 300, 'the registry covers every sourced venue (' + Object.keys(REG.venues).length + ')');
const gMissing = Object.assign({}, g26, { game_id: 'x1', venue_id: 999999 });
const cMissing = A.context(gMissing, env(2026));
eq(cMissing.venue, null, 'an unknown venue id has no elevation');
eq(cMissing.quality.usable, false, 'and the context is not usable');
eq(A.adjustment(cMissing, PARAMS, { flag_enabled: true }).status, 'UNAVAILABLE', 'no adjustment from a missing elevation');
const secMissing = A.publish(cMissing, A.adjustment(cMissing, PARAMS), PARAMS);
ok(/unavailable/i.test(secMissing.model_adjustment.label + secMissing.model_adjustment.text), 'the section says unavailable');
ok(secMissing.away.gain_ft === null, 'no gain is invented');

/* ------------------------------------------------------------------ 3 */
section('3. the engine: shadow moves nothing; three open locks apply the capped term');
function v1(alt) {
  const st = E.strength.newState();
  return E.projectGame({ season: P4.trained_through_season, week: 7, state: st,
    game: { home: 'BYU', away: 'Notre Dame', neutral_site: false, venue_id: 3801 },
    teams: { home: { conference: 'Big 12' }, away: { conference: 'FBS Independents' } }, altitude: alt });
}
const base = v1(undefined);
const shadowed = v1({ adjustment: adj26, section: A.publish(c26, adj26, PARAMS) });
eq(base.status, 'PREDICTED', 'V1 projects the game');
eq(shadowed.model.fair_spread, base.model.fair_spread, 'the shadow leaves the fair spread exactly unchanged');
eq(shadowed.model.home_win_prob, base.model.home_win_prob, '... and the win probability');
const ac = shadowed.contributions.find(c => c.key === 'altitude');
ok(ac && ac.available === false && ac.points === 0, 'the altitude contribution is 0 and unavailable', ac);
ok(/NOT applied/.test(ac.reason) && /shadow \+0\.\d\d pts/.test(ac.reason), 'its reason carries the shadow number', ac && ac.reason);
const forged = v1({ adjustment: Object.assign({}, adj26, { applied: true, applied_points: 2.5, status: 'APPLIED' }) });
eq(forged.model.fair_spread, base.model.fair_spread, 'a request that CLAIMS an applied adjustment is refused while params are not VALIDATED');

const VALID = JSON.parse(JSON.stringify(PARAMS));
VALID.status = 'VALIDATED'; VALID.points_applied = true;
const saved = global.EDCfbAltitudeParams;
try {
  global.EDCfbAltitudeParams = VALID;
  const off = A.adjustment(c26, VALID, { flag_enabled: false });
  eq(off.status, 'SHADOW', 'validated parameters with the flag off: still SHADOW');
  ok(/flag cfb_altitude_adjustment_enabled is off/.test(off.reason), 'the reason names the flag');
  const on = A.adjustment(c26, VALID, { flag_enabled: true });
  eq(on.status, 'APPLIED', 'validated + points_applied + flag on: APPLIED');
  const applied = v1({ adjustment: on, section: A.publish(c26, on, VALID) });
  near(applied.model.fair_spread - base.model.fair_spread, on.applied_points, 1e-9, 'the engine moves the fair spread by exactly the applied points');
  ok(applied.model.home_win_prob > base.model.home_win_prob, 'a home-side adjustment raises the home win probability');
  const drv = (applied.explanation.primary_drivers || []).find(d => d.key === 'altitude');
  ok(!drv || /3,902 ft above its normal elevation/.test(drv.text), 'if it is a driver, the explanation states the measured climb', drv);
  const big = A.adjustment(c26, Object.assign({}, VALID, { shadow_candidate: { id: 'x', coefficients: { high_gain: 9 } } }), { flag_enabled: true });
  eq(big.applied_points, 3, 'the adjustment is capped at 3 points');
  const neutralOn = v1({ adjustment: on });
  ok(neutralOn.model.fair_spread !== base.model.fair_spread, 'control: the same request at a home game moves the number');
  const st = E.strength.newState();
  const atNeutral = E.projectGame({ season: P4.trained_through_season, week: 7, state: st,
    game: { home: 'BYU', away: 'Notre Dame', neutral_site: true }, teams: { home: { conference: 'Big 12' }, away: { conference: 'FBS Independents' } }, altitude: { adjustment: on } });
  ok(atNeutral.contributions.find(c => c.key === 'altitude').points === 0, 'and the engine still refuses it at a neutral site');
} finally {
  global.EDCfbAltitudeParams = saved;
}

/* ------------------------------------------------------------------ 4 */
section('4. the record');
ok(['VALIDATED', 'CANDIDATE', 'RESEARCH_ONLY', 'REJECTED'].indexOf(PARAMS.status) >= 0, 'params carry a promotion status');
eq(PARAMS.points_applied, PARAMS.status === 'VALIDATED', 'points_applied is true only when VALIDATED');
eq(PARAMS.status, VAL.status, 'params.js and the validation record agree on the status');
eq(PARAMS.shadow_candidate.id, VAL.selected, '... and on the selected candidate');
eq(PARAMS.validation.support_text, VAL.support_text, '... and on the fan-facing support text');
eq(VAL.declared_gates, GATES.DECLARED, 'the gates are the declared ones');
eq(VAL.gates.length, GATES.GATES.length, 'every declared gate was evaluated');
ok(VAL.gates.every((g, i) => g.id === GATES.GATES[i].id), 'in the declared order, by id');
eq(VAL.points_applied, VAL.gates.every(g => g.pass), 'points apply if and only if every gate passed');
ok(A.CANDIDATES[VAL.selected] && A.CANDIDATES[VAL.selected].eligible, 'the selected candidate is an eligible, pre-registered one');
ok(VAL.full_sample.ratio6 && A.CANDIDATES.ratio6.eligible === false, 'the 6x ratio is measured but can never price');
ok(VAL.walk_forward[VAL.selected].fits.every(f => f.season >= GATES.WINDOWS.select[0]), 'walk-forward fits start at the selection window');
ok(VAL.baseline.replay.n > 10000, 'the baseline replay covers the historical seasons');
ok(/cfb_p4\/engine\.js/.test(VAL.baseline.engine), 'the baseline is the shipped V1 engine');
const cat = VAL.full_sample.cat_3000.coefficients[0];
ok(cat.ci95[0] <= cat.ols && cat.ols <= cat.ci95[1], 'the 3,000+ ft coefficient sits inside its interval');
ok(PARAMS.validation.support_state !== 'SUPPORTED' || PARAMS.status === 'VALIDATED', 'SUPPORTED is never shown for an unvalidated adjustment');
const docs = fs.readFileSync(path.join(ROOT, 'docs', 'cfb-altitude', 'BACKTEST.md'), 'utf8');
ok(docs.indexOf('Status: ' + VAL.status) >= 0, 'the rendered report states the same status');

/* ------------------------------------------------------------------ 5 */
section('5. the words');
const sec = A.publish(c26, adj26, PARAMS);
const words = [sec.interpretation.join(' '), sec.model_adjustment.label, sec.model_adjustment.text, sec.statistical_support.text, sec.not_claimed].join(' ');
eq(sec.model_adjustment.label, 'Research only', 'the label is Research only');
ok(/0\.0 pts applied/.test(sec.model_adjustment.text), 'the text says 0.0 pts applied');
eq(sec.fair_line_impact_pts, 0, 'the impact on the fair line is 0');
const BANNED = /\b(lock|locks|guarantee[ds]?|sure thing|free money|can't lose|will win|will cover|best bet|smash|hammer|edge of the day|bet this)\b/i;
ok(!BANNED.test(words), 'no betting-call or certainty language', words.match(BANNED));
ok(!/missed tackles|penalt(y|ies) because|turnovers because|collapse/i.test(sec.interpretation.join(' ')), 'no unvalidated mechanism is asserted');
ok(/does not claim altitude causes missed tackles, penalties, turnovers or late-game collapses/.test(sec.not_claimed), 'the section says what it does not claim');
const desk = A.deskFacts(sec);
ok(desk.facts.some(f => f.key === 'elevation_gain_ft' && f.value === 3902), 'the desk is handed the measured gain');
ok(desk.facts.some(f => f.key === 'altitude_points_applied' && f.value === 0), 'and the 0 points applied');
ok(desk.facts.some(f => f.key === 'altitude_support' && f.value === PARAMS.validation.support_state), 'and the record’s verdict');

/* the snapshot block and the page */
const GS = require(path.join(ROOT, 'lib', 'edgedesk_game_snapshot.js'));
const blk = GS.altitudeBlock(Object.assign({}, sec, { engine_contribution: { points: 0, available: false } }));
ok(blk && blk.adjustment.applied === false && blk.adjustment.applied_points === 0, 'the snapshot block carries 0 applied points');
eq(GS.altitudeBlock({ schema: 'something else' }), null, 'a foreign object is refused');
const lying = GS.altitudeBlock(Object.assign({}, sec, { adjustment: Object.assign({}, sec.adjustment, { applied: true, applied_points: 2 }), engine_contribution: { points: 0, available: false } }));
eq(lying.adjustment.applied, false, 'a section that claims points the engine did not apply is not believed');
const VIEW = fs.readFileSync(path.join(ROOT, 'lib', 'edgedesk_game_view.js'), 'utf8');
const sb = { window: { EDGameSnapshot: GS }, localStorage: null };
sb.window.window = sb.window;
vm.runInNewContext(VIEW.replace(/\}\)\(typeof window !== 'undefined' \? window : this\);?\s*$/, '})(window);'), sb);
const GV = sb.window.EDGameView;
ok(GV && typeof GV.altitudeSection === 'function', 'the page exposes its altitude section');
if (GV && GV.altitudeSection) {
  const html = GV.altitudeSection({ league: 'cfb', altitude_travel: blk, home: { name: 'BYU' }, away: { name: 'Notre Dame' } });
  ['Altitude &amp; travel', 'Research only', 'LaVell Edwards Stadium', '4,633 ft', '731 ft', '+3,902 ft', 'High altitude exposure',
    'Statistical support', 'Validated model adjustment', 'Impact on EdgeDesk', '0.0 pts', 'pending validation', '1,325 miles', '2 time zones west',
    'Shadow estimate', 'NOT in the number', 'Descriptive only'].forEach(t => ok(html.indexOf(t) >= 0, 'the page shows "' + t + '"'));
  ok(!BANNED.test(html.replace(/<[^>]+>/g, ' ')), 'the page section has no betting-call language');
  eq(GV.altitudeSection({ league: 'nfl', altitude_travel: blk }), '', 'no section on an NFL page');
  eq(GV.altitudeSection({ league: 'cfb' }), '', 'no section on a snapshot built before it existed');
}

console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' | altitude & travel | ' + (checks - failures) + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
