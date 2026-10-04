#!/usr/bin/env node
/* ============================================================================
   NON-QB PERSONNEL AVAILABILITY — the rules, offline.

     node football/personnel/personnel.test.js

   Synthetic fixtures for the scoring rules (so each case isolates one
   effect), the real committed player files for the adapters, and the
   committed artifacts for the contracts they must keep.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CFG = require('./config.js');
const I = require('./impact.js');
const AD = require('./adapters.js');
const F = require('./freeze.js');
const TR = require('./training.js');

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.error('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
function section(s) { console.log('\n== ' + s); }

/* ---------------------------------------------------------------- fixtures */
const OFFICIAL = { name: 'SEC availability report', type: 'OFFICIAL', tier: 1, freshness: 'CURRENT',
  published_at: '2026-09-25T00:10:00.000Z' };
function q(v, conf) { return { value: v, basis: 'MEASURED_PRODUCTION', confidence: conf == null ? 0.8 : conf, scale: 'EPIR' }; }
function u(v) { return { value: v, basis: 'SNAP_SHARE' }; }
function rep(id, name, v, basis) {
  return { player_id: id, player_name: name, quality: v == null ? null : q(v), usage: u(0.1), basis: basis || 'DEPTH_CHART' };
}
function absent(o) {
  return Object.assign({ player_id: 'p1', player_name: 'Player One', position: 'LT', slot: 'LT', slot_depth: 1,
    status: 'OUT', source: OFFICIAL, quality: q(80), usage: u(0.95) }, o || {});
}
function team(absences, o) {
  o = o || {};
  return { team_id: o.team_id || 'home', team_name: o.team_name || 'Home U', side: 'home',
    coverage: o.coverage || { grade: 'OFFICIAL', graded: true, official: true, comprehensive: true },
    absences: absences, depth: o.depth || {},
    opponent: o.opponent || { team_id: 'opp', team_name: 'Opp State', metrics: {} } };
}
function one(absences, o) { const t = I.assessTeam(team(absences, o)); return { t: t, a: t.absences[0] || t.unrated[0] }; }

/* ============================================================ 1. the core */
section('replacement gap drives the score');
const eliteElite = one([absent({ quality: q(82), replacement: rep('b1', 'Good Backup', 76) })]).a;
const elitePoor = one([absent({ quality: q(82), replacement: rep('b1', 'Poor Backup', 45) })]).a;
const avgTerrible = one([absent({ position: 'G', slot: null, slot_depth: null, quality: q(58), usage: u(0.9),
  replacement: rep('b1', 'Terrible Backup', 38) })]).a;
chk('elite player + elite replacement = modest impact (Minimal/Low)',
  eliteElite.rated && eliteElite.impact_if_absent < 40 && /Minimal|Low/.test(eliteElite.classification), eliteElite);
chk('elite player + poor replacement = high impact (60+)',
  elitePoor.impact_if_absent >= 60 && /High|Severe/.test(elitePoor.classification), elitePoor);
chk('the same elite player scores far higher with the poor backup behind him',
  elitePoor.impact_if_absent - eliteElite.impact_if_absent >= 30, [eliteElite.impact_if_absent, elitePoor.impact_if_absent]);
chk('average starter + terrible replacement = meaningful impact (Moderate+)',
  avgTerrible.impact_if_absent >= 40, avgTerrible);
chk('an average starter with a massive drop-off outscores an elite player with an excellent backup',
  avgTerrible.impact_if_absent > eliteElite.impact_if_absent);
chk('replacement_gap = player_quality - replacement_quality',
  elitePoor.replacement_gap === 37 && elitePoor.gap_basis === 'MEASURED_REPLACEMENT');
chk('a replacement better than the starter costs nothing on quality, and the gap stays visible',
  one([absent({ quality: q(60), replacement: rep('b1', 'Better', 66) })]).a.impact_if_absent === 0
  && one([absent({ quality: q(60), replacement: rep('b1', 'Better', 66) })]).a.replacement_gap === -6);

section('usage');
const starter = one([absent({ position: 'DT', slot: null, quality: q(70), usage: u(0.9), replacement: rep('b1', 'B', 52) })]).a;
const rotational = one([absent({ position: 'DT', slot: null, quality: q(70), usage: u(0.3), replacement: rep('b1', 'B', 52) })]).a;
chk('rotational player = lower impact than the same player as a starter',
  rotational.impact_if_absent < starter.impact_if_absent, [rotational.impact_if_absent, starter.impact_if_absent]);
chk('rotational player grades Low or Minimal', /Minimal|Low/.test(rotational.classification), rotational);
chk('usage bands are the brief’s', I.usageBand(0.95) === 'Nearly every snap / central player'
  && I.usageBand(0.75) === 'Major starter' && I.usageBand(0.6) === 'Rotational starter'
  && I.usageBand(0.3) === 'Important rotation' && I.usageBand(0.1) === 'Limited role');

section('position leverage is configuration, not code');
chk('OT prior sits inside the brief’s 1.20-1.40', CFG.POSITIONS.OT.leverage.prior >= 1.2 && CFG.POSITIONS.OT.leverage.prior <= 1.4);
chk('EDGE 1.15-1.35, CB1 1.10-1.30, WR1 1.05-1.25, RB 0.70-0.95, K/P 0.40-0.80',
  CFG.POSITIONS.EDGE.leverage.range.join() === '1.15,1.35' && CFG.POSITIONS.CB1.leverage.range.join() === '1.1,1.3'
  && CFG.POSITIONS.WR1.leverage.range.join() === '1.05,1.25' && CFG.POSITIONS.RB.leverage.range.join() === '0.7,0.95'
  && CFG.POSITIONS.K.leverage.range.join() === '0.4,0.8' && CFG.POSITIONS.P.leverage.range.join() === '0.4,0.8');
chk('every prior sits inside its own range', Object.keys(CFG.POSITIONS).every(function (k) {
  const L = CFG.POSITIONS[k].leverage; return L.prior >= L.range[0] && L.prior <= L.range[1];
}));
chk('a custom configuration changes leverage without a code change',
  (function () {
    const c = JSON.parse(JSON.stringify(CFG)); c.POSITIONS.OT.leverage.prior = 1.4;
    return I.withConfig(c).assessTeam(team([absent({ replacement: rep('b', 'B', 50) })])).absences[0].position_leverage === 1.4;
  })());
chk('WR1/CB1 is the depth-rank-1 player; others take the non-primary prior',
  (function () {
    const depth = { WR: { basis: 'DEPTH_CHART', players: [
      { player_id: 'w1', player_name: 'W One', quality: q(70), usage: u(0.9) },
      { player_id: 'w2', player_name: 'W Two', quality: q(62), usage: u(0.8) },
      { player_id: 'w3', player_name: 'W Three', quality: q(60), usage: u(0.7) },
      { player_id: 'w4', player_name: 'W Four', quality: q(52), usage: u(0.2) }] } };
    const t = I.assessTeam(team([
      { player_id: 'w1', player_name: 'W One', position: 'WR', status: 'OUT', source: OFFICIAL },
      { player_id: 'w3', player_name: 'W Three', position: 'WR', status: 'OUT', source: OFFICIAL }], { depth: depth }));
    const a1 = t.absences.filter(function (a) { return a.player_id === 'w1'; })[0];
    const a3 = t.absences.filter(function (a) { return a.player_id === 'w3'; })[0];
    return a1.slot === 'WR1' && a1.label === 'WR1' && a3.slot === 'WR' && a3.label === 'WR3'
      && a1.position_leverage > a3.position_leverage;
  })());

section('matchup leverage — measured opponent metrics only');
const vsElite = one([absent({ replacement: rep('b1', 'B', 50) })],
  { opponent: { team_name: 'Rush U', metrics: { def_sack_rate: { z: 2.0, reliability: 1, label: 'pass rush' } } } }).a;
const vsWeak = one([absent({ replacement: rep('b1', 'B', 50) })],
  { opponent: { team_name: 'Soft U', metrics: { def_sack_rate: { z: -1.6, reliability: 1 } } } }).a;
const vsNone = one([absent({ replacement: rep('b1', 'B', 50) })]).a;
chk('missing LT versus elite pass rush increases matchup leverage', vsElite.matchup_leverage > 1 && vsElite.impact_if_absent > vsNone.impact_if_absent, vsElite);
chk('missing LT versus weak pass rush lowers matchup leverage', vsWeak.matchup_leverage < 1 && vsWeak.impact_if_absent < vsNone.impact_if_absent, vsWeak);
chk('matchup leverage stays inside 0.75-1.25 however extreme the metric',
  one([absent({ replacement: rep('b1', 'B', 50) })], { opponent: { metrics: { def_sack_rate: { z: 9 } } } }).a.matchup_leverage === 1.25
  && one([absent({ replacement: rep('b1', 'B', 50) })], { opponent: { metrics: { def_sack_rate: { z: -9 } } } }).a.matchup_leverage === 0.75);
chk('the driver is named with its measured z', vsElite.matchup_drivers[0].metric === 'def_sack_rate' && vsElite.matchup_drivers[0].z === 2);
chk('missing CB1 versus an elite passing offense rises; versus a weak one falls',
  (function () {
    const d = { CB: { basis: 'DEPTH_CHART', players: [{ player_id: 'c1', player_name: 'C1', quality: q(72), usage: u(0.95) },
      { player_id: 'c2', player_name: 'C2', quality: q(60), usage: u(0.9) }, { player_id: 'c3', player_name: 'C3', quality: q(50), usage: u(0.2) }] } };
    const row = [{ player_id: 'c1', player_name: 'C1', position: 'CB', status: 'OUT', source: OFFICIAL }];
    const hi = I.assessTeam(team(row, { depth: d, opponent: { metrics: { pass_offense: { z: 1.8 } } } })).absences[0];
    const lo = I.assessTeam(team(row, { depth: d, opponent: { metrics: { pass_offense: { z: -1.8 } } } })).absences[0];
    return hi.slot === 'CB1' && hi.matchup_leverage > 1 && lo.matchup_leverage < 1;
  })());
chk('missing WR1 versus a weak secondary rises (the driver sign is inverted)',
  (function () {
    const d = { WR: { basis: 'DEPTH_CHART', players: [{ player_id: 'w1', player_name: 'W1', quality: q(72), usage: u(0.9) },
      { player_id: 'w2', player_name: 'W2', quality: q(52), usage: u(0.2) }] } };
    const row = [{ player_id: 'w1', player_name: 'W1', position: 'WR', status: 'OUT', source: OFFICIAL }];
    return I.assessTeam(team(row, { depth: d, opponent: { metrics: { pass_defense: { z: -1.5 } } } })).absences[0].matchup_leverage > 1;
  })());
chk('kickers and punters have no matchup driver: not applicable, not a fake 1.0',
  (function () {
    const a = one([absent({ position: 'K', slot: null, replacement: rep('b1', 'B', 50) })]).a;
    return a.matchup_applicable === false && a.matchup_leverage === null;
  })());

section('unit concentration');
chk('the concentration table is the brief’s: 1.00 / 1.08 / 1.18 / 1.30, capped at 4+',
  I.concentrationMultiplier(1) === 1 && I.concentrationMultiplier(2) === 1.08 && I.concentrationMultiplier(3) === 1.18
  && I.concentrationMultiplier(4) === 1.3 && I.concentrationMultiplier(7) === 1.3);
const olDepth = { OL: { basis: 'DEPTH_CHART', players: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) {
  return { player_id: 'ol' + n, player_name: 'OL ' + n, quality: q(n <= 5 ? 66 : 54 - n), usage: u(n <= 5 ? 0.95 : 0.1) };
}) } };
function olOut(ids, st) {
  return I.assessTeam(team(ids.map(function (id) {
    return { player_id: id, player_name: id, position: 'OL', status: st && st[id] || 'OUT', source: OFFICIAL };
  }), { depth: olDepth }));
}
const ol1 = olOut(['ol1']), ol2 = olOut(['ol1', 'ol2']), ol3 = olOut(['ol1', 'ol2', 'ol3']), ol4 = olOut(['ol1', 'ol2', 'ol3', 'ol4']);
chk('multiple OL injuries trigger the concentration effect',
  ol1.absences[0].unit_concentration_multiplier === 1 && ol2.absences[0].unit_concentration_multiplier === 1.08
  && ol3.absences[0].unit_concentration_multiplier === 1.18 && ol4.absences[0].unit_concentration_multiplier === 1.3,
  [ol1, ol2, ol3, ol4].map(function (t) { return t.absences.map(function (a) { return a.unit_concentration_multiplier; }); }));
chk('three OL starters out is a HIGH offensive-line concern', ol3.unit_concern && ol3.unit_concern.unit === 'OFFENSIVE_LINE'
  && ol3.unit_concern.concern === 'HIGH');
chk('two OL out is at least a MODERATE concern', ol2.units[0].concern !== 'LOW');
chk('overlapping absences are replaced from deeper on the depth chart, never by the same backup',
  (function () {
    const reps = ol3.absences.map(function (a) { return a.replacement_player_id; });
    return reps.indexOf('ol6') >= 0 && reps.indexOf('ol7') >= 0 && reps.indexOf('ol8') >= 0
      && new Set(reps).size === reps.length;
  })(), ol3.absences.map(function (a) { return a.replacement_player_id; }));
chk('a replacement who is himself out is skipped',
  (function () {
    const t = olOut(['ol1', 'ol6']);
    const a = t.absences.concat(t.unrated).filter(function (x) { return x.player_id === 'ol1'; })[0];
    return a.replacement_player_id === 'ol7';
  })());
chk('questionable same-unit absences count by probability (1 + 0.5 + 0.5 = 2 -> 1.08)',
  olOut(['ol1', 'ol2', 'ol3'], { ol2: 'QUESTIONABLE', ol3: 'QUESTIONABLE' }).absences
    .filter(function (a) { return a.player_id === 'ol1'; })[0].unit_concentration_multiplier === 1.08);
chk('concentration never compounds: it is one multiplier per absence, from the table',
  ol4.absences.every(function (a) { return a.unit_concentration_multiplier <= 1.3; }));

section('availability states and probability');
chk('every state the brief lists is supported', ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'PROBABLE', 'EXPECTED',
  'GAME_TIME_DECISION', 'LIMITED', 'UNKNOWN'].every(function (s) { return CFG.STATUS[s] && I.normalizeStatus(s).status === s; }));
chk('source spellings normalise', I.normalizeStatus('Game-time decision').status === 'GAME_TIME_DECISION'
  && I.normalizeStatus('out for season').status === 'OUT' && I.normalizeStatus('Out (1st half)').status === 'OUT_FIRST_HALF'
  && I.normalizeStatus('day-to-day').status === 'QUESTIONABLE' && I.normalizeStatus('Probable').status === 'PROBABLE'
  && I.normalizeStatus('???').status === 'UNKNOWN' && I.normalizeStatus('Available').status === 'AVAILABLE');
const outP = one([absent({ replacement: rep('b1', 'B', 50) })]);
const qP = one([absent({ status: 'Questionable', replacement: rep('b1', 'B', 50) })]);
chk('questionable player uses probability weighting: same impact_if_absent, half the expected impact',
  qP.a.impact_if_absent === outP.a.impact_if_absent && qP.a.probability_of_absence === 0.5
  && qP.a.expected_impact === Math.round(outP.a.impact_if_absent * 0.5), [qP.a, outP.a]);
chk('impact_if_absent and probability_of_absence are both kept visible',
  'impact_if_absent' in qP.a && 'probability_of_absence' in qP.a && 'expected_impact' in qP.a);
chk('the team score uses the probability-weighted raw impact', qP.t.impact < outP.t.impact);
chk('an AVAILABLE player is not an absence', one([absent({ status: 'AVAILABLE' })]).t.cleared.length === 1);

section('confidence and missing data');
const known = one([absent({ replacement: rep('b1', 'Known Backup', 55) })]).a;
const unknownRep = one([absent({ replacement: null })]).a;
chk('unknown replacement lowers confidence', unknownRep.confidence < known.confidence, [unknownRep.confidence, known.confidence]);
chk('unknown replacement: replacement_quality stays null, the gap is bounded by the scale’s declared replacement level',
  unknownRep.replacement_quality === null && unknownRep.replacement_player_id === null
  && unknownRep.gap_basis === 'SCALE_REPLACEMENT_LEVEL' && unknownRep.missing.indexOf('replacement') >= 0);
chk('an identified but unmeasured replacement also leaves replacement_quality null',
  one([absent({ replacement: rep('b1', 'Freshman', null) })]).a.replacement_quality === null);
const noQuality = one([absent({ quality: { value: 51, basis: 'NO_MEASURED_PRODUCTION', scale: 'EPIR' }, replacement: rep('b1', 'B', 50) })]).a;
chk('missing data remains null: a prior-only rating is not player quality',
  noQuality.player_quality === null && noQuality.impact_if_absent === null && noQuality.rated === false
  && noQuality.rating_on_file_unmeasured === 51 && noQuality.missing.indexOf('player_quality') >= 0);
const noUsage = one([absent({ usage: null, replacement: rep('b1', 'B', 50) })]).a;
chk('missing data remains null: no usage evidence -> usage_factor null, not a neutral fill',
  noUsage.usage_factor === null && noUsage.impact_if_absent === null);
chk('missing data remains null: no opponent metric -> matchup_leverage null',
  known.matchup_leverage === null && known.matchup_applicable === true && known.missing.indexOf('matchup') >= 0);
const unk = one([absent({ status: 'UNKNOWN', replacement: rep('b1', 'B', 50) })]);
chk('missing data remains null: an UNKNOWN designation has no probability and no expected impact',
  unk.a.probability_of_absence === null && unk.a.expected_impact === null && unk.t.impact === null);
chk('uncertain designations cost confidence (UNKNOWN < QUESTIONABLE < OUT)',
  unk.a.confidence < qP.a.confidence && qP.a.confidence < outP.a.confidence);
chk('a weak source costs confidence',
  one([absent({ source: { tier: 3 }, replacement: rep('b1', 'B', 50) })]).a.confidence < outP.a.confidence);
chk('no field is filled with a fake neutral 50: every quality number came from the input',
  [known, unknownRep, noQuality, noUsage].every(function (a) {
    return a.player_quality === null || a.player_quality === 80;
  }) && known.replacement_quality === 55);
chk('an unassessable team has a null impact, never zero',
  (function () {
    const t = I.assessTeam(team([], { coverage: { grade: 'LIMITED', graded: false } }));
    return t.status === 'NOT_ASSESSABLE' && t.impact === null;
  })());
chk('a comprehensive official report listing nobody scores 0; a partial read listing nobody is lower confidence',
  (function () {
    const a = I.assessTeam(team([], { coverage: { grade: 'OFFICIAL', graded: true, comprehensive: true } }));
    const b = I.assessTeam(team([], { coverage: { grade: 'PARTIAL', graded: true, comprehensive: false } }));
    return a.status === 'NO_REPORTED_ABSENCES' && a.impact === 0 && b.status === 'NO_ABSENCES_ON_FILE' && b.confidence < a.confidence;
  })());

section('the quarterback, duplicates and determinism');
const withQb = one([absent({ player_id: 'qb', player_name: 'Starter QB', position: 'QB', slot: null }),
  absent({ replacement: rep('b1', 'B', 50) })]).t;
chk('the quarterback is excluded, with the reason', withQb.excluded.length === 1 && /QB layer/.test(withQb.excluded[0].reason)
  && withQb.absences.every(function (a) { return a.position !== 'QB'; }));
const dup = I.assessTeam(team([absent({ replacement: rep('b1', 'B', 50), source: { tier: 2, name: 'media' } }),
  absent({ replacement: rep('b1', 'B', 50) })]));
chk('duplicate reports for one athlete count once, highest tier kept',
  dup.absences.length === 1 && dup.duplicates.length === 1 && dup.absences[0].source.tier === 1);
const G = { game_id: 'g1', sport: 'cfb', kickoff: '2026-09-26T23:00:00Z',
  home: team([absent({ replacement: rep('b1', 'B', 50) })]),
  away: team([], { team_id: 'away', team_name: 'Away U' }) };
chk('deterministic: the same input gives byte-identical output',
  JSON.stringify(I.assessGame(JSON.parse(JSON.stringify(G)))) === JSON.stringify(I.assessGame(JSON.parse(JSON.stringify(G)))));
chk('the core reads no clock', !/Date\.now\(|new Date\(\)/.test(fs.readFileSync(path.join(__dirname, 'impact.js'), 'utf8')));

section('team and game summaries');
const game = I.assessGame(G);
chk('a game carries both teams, a comparison and the projection effect', game.home.status === 'ASSESSED'
  && game.away.status === 'NO_REPORTED_ABSENCES' && game.comparison && game.projection_effect.status === 'NOT_ENABLED');
chk('the comparison names the team with materially greater exposure (not points)',
  (function () {
    const g2 = I.assessGame({ game_id: 'g2', home: team([absent({ quality: q(85), replacement: rep('b1', 'B', 40) })]),
      away: team([], { team_id: 'away', team_name: 'Away U' }) });
    return g2.comparison.material === true && g2.comparison.more_affected === 'home'
      && /materially greater personnel-loss exposure/.test(g2.comparison.statement) && !/point/i.test(g2.comparison.statement);
  })());
chk('key losses and the unit concern are published', ol3.key_losses.length === 3 && /Offensive line/.test(ol3.summary_text));
chk('drivers text explains the replacement gap and the matchup', /drop from his 80 rating/.test(vsElite.drivers_text)
  && /pass rush/.test(vsElite.drivers_text) && /raises it/.test(vsElite.drivers_text));

/* ============================================ 2. the projection lock */
section('no injury can change a projection');
chk('projectionAdjustment() is exactly 0', I.projectionAdjustment() === 0 && I.PROJECTION_ADJUSTMENT === 0);
chk('every game, team and absence output carries projection_adjustment 0',
  game.projection_adjustment === 0 && game.projection_effect.adjustment_points === 0 && game.home.projection_adjustment === 0
  && game.home.absences.every(function (a) { return a.projection_adjustment === 0; }));
chk('even a configuration claiming a trained coefficient cannot move it',
  (function () {
    const c = JSON.parse(JSON.stringify(CFG));
    c.PROJECTION.coefficient_trained = true; c.PROJECTION.points_per_impact = 5; c.PROJECTION.adjustment_points = 3;
    const core = I.withConfig(c);
    const g = core.assessGame({ game_id: 'x', home: team([absent({ replacement: rep('b', 'B', 40) })]), away: team([]) });
    return core.projectionAdjustment() === 0 && g.projection_adjustment === 0 && g.projection_effect.adjustment_points === 0;
  })());
chk('the config declares the coefficient untrained', CFG.PROJECTION.coefficient_trained === false
  && CFG.PROJECTION.points_per_impact === null && CFG.PROJECTION.adjustment_points === 0);
const PRICING = ['football/cfb_p4/engine.js', 'football/cfb_p4/params.js', 'football/engine.js', 'football/params.js',
  'football/fbs/build_coverage.js', 'football/matchup/contract.js', 'football/matchup/inputs.js',
  'tools/football/build_nfl_slate.js', 'tools/record/football_record.js', 'tools/record/football_record_core.js'];
chk('nothing that builds or records a projection reads the personnel layer',
  PRICING.every(function (f) { return !/personnel\//.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); }),
  PRICING.filter(function (f) { return /personnel\//.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); }));
chk('the trained engine’s injury layer is unchanged: a non-QB absence moves its mean by 0',
  (function () {
    global.window = global.window || global;
    require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
    const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
    const r = E.context.injuryImpact([{ player: 'LT1', athlete_id: '1', position: 'OL', starter: true, snap_share: 0.95,
      status: 'out', source: 'test' }], 'home');
    return r.points.value === 0;
  })());

/* ================================================= 3. the adapters */
section('college adapter, on the committed player files');
const bama = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'players', 'teams', 'alabama.json'), 'utf8'));
const dp = AD.cfbDepth(bama);
const anyMeasured = [].concat.apply([], Object.keys(dp.depth).map(function (g) { return dp.depth[g].players; }))
  .filter(function (p) { return p.quality && p.quality.basis === 'MEASURED_PRODUCTION'; });
const lineman = (dp.depth.OL || { players: [] }).players[0];
chk('EPIR with measured production is accepted as quality', anyMeasured.length > 0
  && anyMeasured.every(function (p) { return typeof p.quality.value === 'number' && p.quality.scale === 'EPIR'; }));
chk('an offensive lineman’s EPIR (no production feed) is NOT accepted as quality',
  lineman && lineman.quality.basis === 'NO_MEASURED_PRODUCTION');
chk('usage is labelled a participation proxy, never a snap share',
  anyMeasured.filter(function (p) { return p.usage; }).every(function (p) { return p.usage.basis === 'PARTICIPATION_SHARE'; }));
chk('depth is ordered by participation first', (function () {
  const w = dp.depth.WR.players.filter(function (p) { return p.usage; });
  for (let i = 1; i < w.length; i++) if (w[i].usage.value > w[i - 1].usage.value) return false;
  return true;
})());
const OVERLAY = require(path.join(ROOT, 'football', 'availability', 'overlay.js'));
const measuredWr = dp.depth.WR.players[0];
const cfbSide = AD.cfbTeam({
  game: { game_id: 'G1' }, side: 'home', teamName: 'Alabama', teamKey: 'alabama', oppName: 'Opp', oppKey: 'opp',
  overlay: OVERLAY, teamFile: bama, metricsOpp: null,
  availTeam: { team_name: 'Alabama', dataQuality: 'OFFICIAL', official_report: { ok: true, game_id: 'G1', comprehensive: true },
    players: [{ player_name: measuredWr.player_name, player_id: measuredWr.player_id, position: 'WR', status: 'OUT',
      source_type: 'OFFICIAL', tier: 1, game_id: 'G1', source_published_at: '2026-09-25T00:00:00Z' },
    { player_name: 'Old News', position: 'WR', status: 'OUT', freshness: 'HISTORICAL' },
    { player_name: 'Other Game', position: 'WR', status: 'OUT', game_id: 'G0' }] }
});
chk('the college side is graded, fixture-scoped and drops stale records',
  cfbSide.coverage.graded && cfbSide.coverage.comprehensive && cfbSide.absences.length === 1
  && cfbSide.notes.some(function (n) { return /stale or historical/.test(n); }));
chk('a filed row joins the player file by athlete id', cfbSide.absences[0].identity === 'athlete_id on the team’s player file'
  && cfbSide.absences[0].quality.basis === 'MEASURED_PRODUCTION');
chk('an ungraded team is not assessable', !AD.cfbTeam({ game: { game_id: 'G1' }, side: 'home', overlay: OVERLAY,
  teamFile: bama, availTeam: { team_name: 'Alabama', dataQuality: 'LIMITED', players: [] } }).coverage.graded);
const metricsFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'matchup', 'metrics.json'), 'utf8'));
const om = AD.cfbOpponentMetrics(metricsFile.teams.alabama);
chk('opponent metrics are read from the published unit metrics with their z', om.def_sack_rate && typeof om.def_sack_rate.z === 'number'
  && om.run_offense && om.pass_defense);

section('NFL adapter');
const nflInj = { source: 'nflverse', retrieved_at: '2026-09-25T11:00:00Z', published: true, teams: {
  ARI: { week: 3, players: [{ gsis_id: '1', name: 'A Tackle', position: 'T', status: 'Out', practice: 'Did Not Participate In Practice' },
    { gsis_id: '2', name: 'A Corner', position: 'CB', status: null, practice: 'Did Not Participate In Practice' },
    { gsis_id: '3', name: 'A Guard', position: 'G', status: null, practice: 'Full Participation in Practice' },
    { gsis_id: '4', name: 'A Passer', position: 'QB', status: 'Questionable', practice: 'Limited' }] } } };
const ns = AD.nflTeam({ game: { week: 3 }, side: 'home', code: 'ARI', teamName: 'Arizona', injuries: nflInj });
chk('NFL: designations map, a DNP with no designation is UNKNOWN, a full participant is not an absence',
  ns.absences.length === 3 && ns.absences[0].status === 'OUT' && ns.absences[1].status === 'UNKNOWN'
  && ns.coverage.graded && ns.coverage.comprehensive);
const nsA = I.assessTeam(ns);
chk('NFL: with no player-quality feed every absence is listed unrated, never zero',
  nsA.status === 'UNRATED_ABSENCES' && nsA.impact === null && nsA.unrated.length === 2 && nsA.excluded.length === 1);
chk('NFL: last week’s report is not this week’s', !AD.nflTeam({ game: { week: 4 }, side: 'home', code: 'ARI', injuries: nflInj }).coverage.graded);

/* ================================================ 4. the freeze */
section('historical injury records freeze correctly');
const KICK = '2026-09-26T23:00:00.000Z';
const T0 = Date.parse('2026-09-25T16:00:00Z');
function assessment(outStatus) {
  const a = I.assessGame({ game_id: 'G9', sport: 'cfb', season: 2026, week: 4, kickoff: KICK,
    home: team([absent({ status: outStatus || 'OUT', replacement: rep('b1', 'Backup', 50) })]),
    away: team([], { team_id: 'away', team_name: 'Away U' }) });
  a.as_of = '2026-09-25T15:30:00Z';
  return a;
}
const proj = { pick_at: '2026-09-24T12:00:00Z', home_line: -7.5, model_version: 'm1' };
const L = F.emptyLedger('cfb', 2026, 4);
const r1 = F.freeze(L, assessment(), { now: T0, projection: proj });
chk('a pregame assessment freezes beside its projection', r1.result === 'frozen' && L.entries.G9.length === 1);
const e1 = L.entries.G9[0], s1 = L.states[e1.state];
chk('the entry carries the projection it was frozen beside', e1.projection.pick_at === proj.pick_at
  && e1.projection.home_line === -7.5 && e1.projection.projected_home_margin === 7.5 && e1.frozen_at < KICK);
const FIELDS = ['team_id', 'player_id', 'position', 'injury_status', 'probability_of_absence', 'player_quality',
  'replacement_player_id', 'replacement_quality', 'replacement_gap', 'usage_factor', 'position_leverage', 'matchup_leverage',
  'unit_concentration_multiplier', 'raw_injury_impact', 'normalized_injury_impact', 'confidence', 'evidence'];
chk('every stored row carries every field the brief names (game_id and timestamp on the entry)',
  s1.rows.length === 1 && FIELDS.every(function (k) { return k in s1.rows[0]; }) && s1.game_id === 'G9' && e1.frozen_at,
  FIELDS.filter(function (k) { return !(k in s1.rows[0]); }));
chk('the frozen state carries projection_adjustment 0', s1.projection_adjustment === 0);
chk('the ledger verifies', F.verifyLedger(L).length === 0, F.verifyLedger(L));
chk('re-freezing the identical state is a no-op', F.freeze(L, assessment(), { now: T0 + 3600e3, projection: proj }).result === 'unchanged'
  && L.entries.G9.length === 1);
const r2 = F.freeze(L, assessment('QUESTIONABLE'), { now: T0 + 7200e3, projection: proj });
chk('a pregame change in the injury state appends a new entry and leaves the first untouched',
  r2.result === 'frozen' && L.entries.G9.length === 2 && L.entries.G9[0].digest === e1.digest && L.states[e1.state]);
const r3 = F.freeze(L, assessment('QUESTIONABLE'), { now: T0 + 9000e3,
  projection: { pick_at: '2026-09-25T18:00:00Z', home_line: -6, model_version: 'm1' } });
chk('a revised pregame projection appends a new entry; the state is stored once',
  r3.result === 'frozen' && L.entries.G9.length === 3 && L.entries.G9[2].state === L.entries.G9[1].state
  && Object.keys(L.states).length === 2);
chk('an older projection cannot be frozen after a newer one', F.freeze(L, assessment(), { now: T0 + 9500e3, projection: proj }).result
  === 'refused:projection older than the last frozen one');

section('postgame updates cannot mutate frozen pregame evidence');
const snap = JSON.stringify(L);
const late = F.freeze(L, assessment('AVAILABLE'), { now: Date.parse(KICK) + 3 * 3600e3,
  projection: { pick_at: '2026-09-25T18:00:00Z', home_line: -6, model_version: 'm1' } });
chk('a freeze after kickoff is refused and changes nothing', late.result === 'refused:at or after kickoff' && JSON.stringify(L) === snap);
chk('a projection published after kickoff is refused', F.freeze(F.emptyLedger('cfb', 2026, 4), assessment(),
  { now: T0, projection: { pick_at: '2026-09-27T01:00:00Z', home_line: -1 } }).result === 'refused:projection published after kickoff');
const leaky = assessment(); leaky.home.absences[0].source = Object.assign({}, OFFICIAL, { published_at: '2026-09-27T02:00:00Z' });
chk('evidence stamped after kickoff is refused', /stamped at or after kickoff/.test(F.freeze(F.emptyLedger('cfb', 2026, 4), leaky,
  { now: T0, projection: proj }).result));
const leaky2 = assessment(); leaky2.as_of = '2026-09-27T02:00:00Z';
chk('inputs observed after kickoff are refused', /inputs observed at or after kickoff/.test(F.freeze(F.emptyLedger('cfb', 2026, 4),
  leaky2, { now: T0, projection: proj }).result));
const tampered = JSON.parse(snap);
tampered.states[tampered.entries.G9[0].state].rows[0].injury_status = 'AVAILABLE';
chk('editing a frozen state after the game fails verification', F.verifyLedger(tampered).some(function (p) { return /edited/.test(p); }));
const tampered2 = JSON.parse(snap); tampered2.entries.G9[0].frozen_at = '2026-09-27T05:00:00.000Z';
chk('re-dating a frozen entry fails verification', F.verifyLedger(tampered2).length > 0);
const shrunk = JSON.parse(snap); shrunk.entries.G9.pop();
chk('removing a frozen entry is detected as a rewrite of history', F.appendOnly(JSON.parse(snap), shrunk).length > 0);
chk('the CLI run refuses postgame freezes and throws before it could rewrite history',
  (function () {
    const full = { season: 2026, games: { G9: assessment('AVAILABLE') } };
    const recs = { cfb: { games: { G9: { week: 4, pick: { at: '2026-09-25T18:00:00Z', home_line: -6, model_version: 'm1' } } } } };
    const file = F.ledgerPath('cfb', 2026, 4);
    const res = F.run({ now: Date.parse(KICK) + 3600e3, assessment: full, records: recs, ledgers: { [file]: JSON.parse(snap) } });
    return res.counts.cfb.refused === 1 && res.ledgers[file].changed === false
      && JSON.stringify(res.ledgers[file].ledger) === snap;
  })());

section('training readiness (no coefficient is fitted)');
const rows = TR.trainingRows([L], { cfb: { games: { G9: { final: { home_score: 24, away_score: 20 } } } } });
chk('the training row is the LAST pregame entry, with the residual against the frozen projection',
  rows.length === 1 && rows[0].projected_home_margin === 6 && rows[0].actual_home_margin === 4 && rows[0].residual === -2);
const rd = TR.readiness(rows, 'cfb');
chk('readiness reports the gap to the required sample and never trains',
  rd.coefficient_trained === false && rd.projection_adjustment === 0 && rd.required_games === CFG.TRAINING.minimum_games.cfb
  && /building history/.test(rd.statement));

/* ============================================ 5. the committed artifacts */
section('committed artifacts');
const cur = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8'));
const curFull = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.full.json'), 'utf8'));
chk('current.json: schema, config version and a zero projection adjustment',
  cur.schema === 'edgedesk_personnel_impact_v1' && cur.config_version === CFG.VERSION && cur.projection.adjustment_points === 0
  && cur.projection.coefficient_trained === false);
chk('current.json: every game, team and absence carries projection_adjustment 0',
  Object.keys(cur.games).every(function (id) {
    const g = cur.games[id];
    return g.projection_adjustment === 0 && [g.home, g.away].every(function (t) {
      return t.projection_adjustment === 0 && t.absences.concat(t.unrated).every(function (a) { return a.projection_adjustment === 0; });
    });
  }));
chk('current.json: no quarterback is scored', Object.keys(cur.games).every(function (id) {
  const g = cur.games[id];
  return [g.home, g.away].every(function (t) { return t.absences.concat(t.unrated).every(function (a) { return a.slot !== 'QB'; }); });
}));
chk('current.json and current.full.json describe the same games', Object.keys(cur.games).join() === Object.keys(curFull.games).join());
chk('every rated college absence has measured quality; every unrated one says why', Object.keys(curFull.games).every(function (id) {
  const g = curFull.games[id];
  return [g.home, g.away].every(function (t) {
    return t.absences.every(function (a) { return a.player_quality !== null && a.player_quality_basis === 'MEASURED_PRODUCTION'; })
      && t.unrated.every(function (a) { return a.missing.length > 0; });
  });
}));
F.ledgerFiles().forEach(function (f) {
  const probs = F.verifyLedger(JSON.parse(fs.readFileSync(f, 'utf8')));
  chk('committed ' + path.basename(f) + ': every frozen entry is pregame and unedited', probs.length === 0, probs.slice(0, 3));
});

console.log('\n' + (fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
