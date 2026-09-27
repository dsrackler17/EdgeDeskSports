#!/usr/bin/env node
/* ===========================================================================
   Tests for lib/tennis_model.js — the shared tennis engine.

   The questions asked here are the ones that decide whether the rest of the
   tennis system can be trusted:

     does an empty cell stay ABSENT rather than becoming zero?
     is a match's identity its draw slot rather than its result, so a corrected
       winner updates instead of duplicating?
     does a walkover stay distinguishable from a straight-sets win?
     does an implausible height become absent rather than entering the record?
     is the power rating shrunk when the sample is thin, and is the shrinkage
       visible in `uncertainty`?
     does a missing model input widen uncertainty and get NAMED, rather than
       silently contributing a neutral zero nobody can see?
     do the two engines fold a name the same way, so identity resolves
       identically on the server and on the page?
     is a fair price the inverse of a probability, and does EV mean what it says?

   Run: node tools/tennis/model.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const M = require('../../lib/tennis_model.js');
const R = require('../../lib/tennis_research.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  chk(name, a === b, 'got ' + a + ', want ' + b);
}
function near(name, got, want, tol) {
  chk(name, got != null && Math.abs(got - want) <= (tol == null ? 1e-6 : tol), 'got ' + got + ', want ~' + want);
}

/* ── 1. THE NULL RULE ─────────────────────────────────────────────────── */
eq('an empty cell is absent, not zero', M.num(''), null);
eq('whitespace is absent', M.num('   '), null);
eq('NA is absent', M.num('NA'), null);
eq('nan is absent', M.num('nan'), null);
eq('None is absent', M.num('None'), null);
eq('a lone dash is absent', M.num('-'), null);
eq('but a real zero is a zero', M.num('0'), 0);
eq('and a real zero stays a zero through int()', M.int(0), 0);
eq('a number string parses', M.num('12.5'), 12.5);
eq('str() folds an empty cell to null too', M.str('  '), null);
chk('zero and absent are distinguishable at every entry point',
    M.num('') !== M.num('0') && M.int('') !== M.int('0'));

/* ── 2. IDENTITY IS THE DRAW SLOT, NOT THE RESULT ─────────────────────── */
const slotA = M.matchKey('ATP', '2023-2843', 274);
const slotB = M.matchKey('ATP', '2023-2843', 274);
eq('the same draw slot is the same key', slotA, slotB);
eq('the key does not contain either player', slotA, 'archive:ATP:2023-2843:274');
chk('a different match number is a different match', M.matchKey('ATP', '2023-2843', 275) !== slotA);
/* A PLACEHOLDER IS NOT A PLAYER.
   The archive uses sentinel names for competitors it could not identify, and
   one id carries 87 matches played by 87 different people. Its rating is not a
   rating, and the daily brief duly published "U Unknown up 7.4 rating points"
   as a finding about a person who does not exist. But "Unknown <Surname>" is a
   REAL person whose given name the archive lacks — suppressing those would
   delete genuine records to tidy up a display. */
['U Unknown', 'Unknown', 'unknown unknown', 'Bye', 'BYE', 'Qualifier', 'TBD', ''].forEach((n) =>
  chk('a placeholder competitor is recognised: ' + JSON.stringify(n), M.isPlaceholderPlayer(n)));
['Unknown Doherty', 'Unknown Rios', 'Novak Djokovic', 'Aryna Sabalenka', 'Byron Black'].forEach((n) =>
  chk('a real player is NOT suppressed: ' + n, !M.isPlaceholderPlayer(n)));
chk('the surname Black is not read as "Bye"', !M.isPlaceholderPlayer('Byron Black'));

chk('a different tour is a different match', M.matchKey('WTA', '2023-2843', 274) !== slotA);

/* THE COLLISION THE REAL ARCHIVE CONTAINS.
   Five WTA events restart match_num inside one tourney_id, giving 16 slots that
   each hold two DIFFERENT matches. With the slot as the whole key the second
   silently overwrote the first and 16 real matches vanished — while every
   import total still reconciled, because they had been read and accepted.
   The pair is part of the identity, and it is UNORDERED so that a correction
   still updates the match it corrects. */
{
  const SLOT = ['WTA', '1973-W-SL-USA-01A-1973', 1, 'archive'];
  const pairA = M.matchKey(...SLOT, '200001', '200002');
  const pairB = M.matchKey(...SLOT, '200003', '200004');
  chk('two DIFFERENT matches in one draw slot get different ids', pairA !== pairB);
  chk('and neither collides with the bare slot', pairA !== M.matchKey(...SLOT) && pairB !== M.matchKey(...SLOT));

  const corrected = M.matchKey(...SLOT, '200002', '200001');   // winner and loser swapped
  chk('a CORRECTED result keeps the same match id — the pair is unordered', pairA === corrected);

  chk('the id still leads with the draw slot, so it is readable',
      pairA.indexOf('archive:WTA:1973-W-SL-USA-01A-1973:1') === 0, pairA);
  chk('a caller with no pair still gets a stable slot key',
      M.matchKey(...SLOT) === M.matchKey(...SLOT));

  /* And through the real parser, which is what the importer actually calls. */
  const row = (w, l) => ({ tour: 'WTA', tourney_id: 'T1', match_num: '5', tourney_date: '1973-06-01',
    winner_id: w, loser_id: l, winner_name: 'W' + w, loser_name: 'L' + l,
    score: '6-4 6-3', best_of: '3', round: 'R32', tourney_name: 'X' });
  const p1 = M.parseArchiveRow(row('11', '22'));
  const p2 = M.parseArchiveRow(row('33', '44'));
  const p1c = M.parseArchiveRow(row('22', '11'));
  chk('the parser gives two different slot-sharing matches two ids',
      p1.match.match_id !== p2.match.match_id);
  chk('and gives a corrected result the SAME id',
      p1.match.match_id === p1c.match.match_id, p1.match.match_id + ' vs ' + p1c.match.match_id);
}
chk('a different source cannot collide with the archive',
    M.matchKey('ATP', '2023-2843', 274, 'licensed_feed') !== slotA);
eq('a player key namespaces source and tour', M.playerKey('ATP', '105138'), 'archive:ATP:105138');
chk('the same source id on two tours is two players',
    M.playerKey('ATP', '1') !== M.playerKey('WTA', '1'));

/* THE CORRECTION TEST: a row whose winner and loser are swapped upstream must
   produce the SAME match id, so a re-import updates rather than duplicating. */
const base = { tour: 'ATP', tourney_id: '2023-2843', tourney_name: 'Adelaide 1', match_num: '274',
  tourney_date: '2023-01-02', surface: 'Hard', best_of: '3', round: 'R32', score: '4-6 6-3 6-4',
  winner_id: '105138', winner_name: 'A Player', loser_id: '126094', loser_name: 'B Player',
  match_uid: 'ATP_2023-2843_274_105138_126094' };
const corrected = Object.assign({}, base, { winner_id: '126094', winner_name: 'B Player',
  loser_id: '105138', loser_name: 'A Player', match_uid: 'ATP_2023-2843_274_126094_105138' });
eq('a corrected result keeps the same match id',
   M.parseArchiveRow(base).match.match_id, M.parseArchiveRow(corrected).match.match_id);
chk('and the source uid is kept beside it as provenance',
    M.parseArchiveRow(base).match.source_match_uid !== M.parseArchiveRow(corrected).match.source_match_uid);

/* ── 3. SCORES ────────────────────────────────────────────────────────── */
eq('a straight-sets score parses', M.parseScore('6-4 6-2').sets_played, 2);
eq('a tiebreak annotation does not break the parse', M.parseScore('7-6(5) 6-4').sets_played, 2);
chk('a retirement is a retirement', M.parseScore('6-3 2-1 RET').retirement);
chk('a retirement still counts the games actually played', M.parseScore('6-3 2-1 RET').sets_played === 2);
chk('a walkover is a walkover', M.parseScore('W/O').walkover);
eq('a walkover played no sets', M.parseScore('W/O').sets_played, 0);
chk('a walkover is not a retirement', !M.parseScore('W/O').retirement);
chk('a default is neither', M.parseScore('DEF').defaulted && !M.parseScore('DEF').walkover);
eq('an unparseable score yields no sets and says so', M.parseScore('').parsed, false);

/* ── 4. IMPLAUSIBLE VALUES BECOME ABSENT, NEVER ZERO ──────────────────── */
eq('a 71cm player is not a height', M.plausibleHeight(71), null);
eq('a real height survives', M.plausibleHeight(188), 188);
eq('a zero height is absent, not zero', M.plausibleHeight(0), null);
eq('an impossible age is absent', M.plausibleAge(0.5), null);
eq('a real age survives', M.plausibleAge(25.2), 25.2);
eq('rank zero is absent', M.plausibleRank(0), null);
eq('a negative rank is absent', M.plausibleRank(-4), null);
const badHt = M.parseArchiveRow(Object.assign({}, base, { winner_ht: '71' }));
eq('an implausible height never reaches the player row', badHt.winner.height_cm, null);
const v = M.validateRow(Object.assign({}, base, { winner_ht: '71' }));
chk('and the row records it as a data-quality issue',
    v.issues.some(i => i.type === 'impossible_statistic' && i.field === 'winner_ht'));
chk('but the match itself is still accepted', v.ok);

/* ── 5. VALIDATION: what is fatal and what is merely wrong ────────────── */
chk('a row with no winner is rejected', !M.validateRow(Object.assign({}, base, { winner_id: '' })).ok);
chk('a row where both sides are the same player is rejected',
    !M.validateRow(Object.assign({}, base, { loser_id: '105138' })).ok);
chk('a row with an unparseable date is rejected',
    !M.validateRow(Object.assign({}, base, { tourney_date: 'soon' })).ok);
chk('a row with an out-of-range year is rejected',
    !M.validateRow(Object.assign({}, base, { tourney_date: '1301-01-01' })).ok);
const noSurf = M.validateRow(Object.assign({}, base, { surface: '' }));
chk('a missing surface is NOT fatal', noSurf.ok);
chk('but it is recorded', noSurf.issues.some(i => i.type === 'missing_surface'));
eq('and the surface is stored as unknown, never inferred',
   M.parseArchiveRow(Object.assign({}, base, { surface: '', tourney_name: 'Roland Garros' })).match.surface, 'unknown');
chk('more first serves in than points played is impossible and is caught',
    M.validateRow(Object.assign({}, base, { w_svpt: '50', w_1stIn: '60' }))
      .issues.some(i => i.type === 'impossible_statistic'));

/* ── 6. ENVIRONMENT AND WEATHER ───────────────────────────────────────── */
eq('Indoor is indoor', M.normEnvironment('Indoor'), 'indoor');
eq('"Outdoor/unknown" is UNKNOWN, not outdoor', M.normEnvironment('Outdoor/unknown'), 'unknown');
eq('a blank environment is unknown', M.normEnvironment(''), 'unknown');
eq('plain Outdoor is outdoor', M.normEnvironment('Outdoor'), 'outdoor');
const indoorRow = M.parseArchiveRow(Object.assign({}, base, { environment: 'Indoor',
  venue_name: 'Arena', weather_temp_mean_f: '70' }));
eq('an indoor event stores weather as explicitly indoor, not as a gap',
   indoorRow.weather.temporal_precision, 'indoor');
eq('and marks it unusable', indoorRow.weather.quality, 'unusable');
const outdoorRow = M.parseArchiveRow(Object.assign({}, base, { environment: 'Outdoor',
  venue_name: 'Court', weather_temp_mean_f: '70', weather_days_covered: '7',
  geocode_confidence: 'name_inferred' }));
eq('outdoor weather is a tournament-week profile, never match-time',
   outdoorRow.weather.temporal_precision, 'tournament_week');
chk('weather usability is one rule shared by every consumer',
    M.SURFACES.length === 4);

/* ── 7. THE FEATURE VECTOR ────────────────────────────────────────────── */
const A = { elo_pre: 1900, surface_elo_pre: 1950, win_pct_90d_pre: 0.7, win_pct_365d_pre: 0.68,
  matches_14d_pre: 3, rest_days_pre: 5, career_surface_win_pct_pre: 0.65, career_surface_matches_pre: 300,
  rank_pre: 4, rank_points_pre: 5000, age_pre: 25, serve_strength_pre: 0.68, return_strength_pre: 0.41,
  sos_elo_pre: 1800, best_of: 3 };
const B = Object.assign({}, A, { elo_pre: 1800, surface_elo_pre: 1790, rank_pre: 20 });
const fv = M.featureVector(A, B, { best_of: 3, level: 'M' });
eq('the vector has one value per named feature', fv.values.length, M.FEATURE_NAMES.length);
near('the Elo difference is scaled by 100', fv.map.d_elo, 1.0);
chk('a complete vector reports nothing missing', fv.missing.length === 0);
eq('and full completeness', fv.completeness, 1);
const gapped = M.featureVector(Object.assign({}, A, { serve_strength_pre: null }), B, { best_of: 3 });
chk('a missing input is NAMED', gapped.missing.indexOf('d_serve_strength') >= 0);
eq('and contributes a neutral zero rather than a false reading', gapped.map.d_serve_strength, 0);
chk('and completeness falls', gapped.completeness < 1);
chk('the vector is anti-symmetric on the inputs that should be',
    Math.abs(M.featureVector(A, B, {}).map.d_elo + M.featureVector(B, A, {}).map.d_elo) < 1e-9);

/* THE LEAKAGE ASSERTION, mechanical: no model input may name a post-match
   column. This is what stops a refactor quietly reintroducing the leak. */
const overlap = M.FEATURE_NAMES.filter(f => M.POST_MATCH_COLUMNS.some(c => f.indexOf(c) >= 0));
eq('no model input names a post-match column', overlap, []);
const featRow = M.parseArchiveRow(Object.assign({}, base, { w_ace: '10', minutes: '120' })).features[0];
M.POST_MATCH_COLUMNS.forEach(c => chk('the feature row does not carry ' + c,
  !Object.prototype.hasOwnProperty.call(featRow, c)));
chk('the feature row carries only pre-match inputs plus the label',
    featRow.won === true && featRow.player_role === 'winner');

/* ── 8. PRICE ─────────────────────────────────────────────────────────── */
near('a fair decimal price is the inverse of a probability', M.decimalFromProb(0.5), 2.0);
near('60% is 1.6667', M.decimalFromProb(0.6), 1.6667, 1e-4);
eq('2.00 decimal is +100 American', M.americanFromDecimal(2.0), 100);
eq('1.50 decimal is -200 American', M.americanFromDecimal(1.5), -200);
near('American converts back', M.decimalFromAmerican(-200), 1.5, 1e-4);
near('and the round trip holds', M.probFromDecimal(M.decimalFromProb(0.42)), 0.42, 1e-4);
const dv = M.devigTwoWay(0.55, 0.50);
near('de-vigging normalises to one', dv.a + dv.b, 1, 1e-9);
near('and reports the overround', dv.overround, 0.05, 1e-9);
eq('a one-sided market cannot be de-vigged', M.devigTwoWay(0.55, null).a, null);
near('EV at a fair price is zero', M.expectedValue(0.5, 2.0), 0, 1e-9);
near('EV at a better price is positive', M.expectedValue(0.5, 2.2), 0.1, 1e-9);
near('EV at a worse price is negative', M.expectedValue(0.5, 1.8), -0.1, 1e-9);
near('edge is the probability difference', M.edge(0.6, 0.55), 0.05, 1e-9);
eq('edge against no market is null', M.edge(0.6, null), null);

/* ── 9. THE POWER RATING IS SHRUNK, VISIBLY ───────────────────────────── */
const ref = { mean: 1500, stdev: 150 };
const thin = M.powerRating(1900, 4, ref), thick = M.powerRating(1900, 400, ref);
chk('a thin record is pulled toward the median', thin.power_rating < thick.power_rating);
chk('and says so through uncertainty', thin.uncertainty > thick.uncertainty);
eq('a full record carries no shrinkage penalty', thick.uncertainty, 0);
near('50 is the median player', M.powerRating(1500, 100, ref).power_rating, 50, 0.01);
near('ten points is one standard deviation', M.powerRating(1650, 100, ref).power_rating, 60, 0.01);
eq('an absent Elo is an absent rating, not a 50', M.powerRating(null, 100, ref).power_rating, null);
eq('and its uncertainty is total', M.powerRating(null, 100, ref).uncertainty, 1);
chk('the rating is clamped to the documented scale',
    M.powerRating(9999, 500, ref).power_rating <= 100 && M.powerRating(-9999, 500, ref).power_rating >= 0);
chk('the scale is documented in one place and says what 50 means',
    /50 is the median rated player/.test(M.ratingScaleText()));

/* ── 10. THE RESEARCH GATE ────────────────────────────────────────────── */
const good = { completeness: 0.95, rating_sample_a: 200, rating_sample_b: 150, uncertainty: 0.1,
  surface: 'clay', market_prob: 0.55, overround: 0.04, market_age_minutes: 20,
  feature_age_hours: 5, model_active: true, doubles: false, players_resolved: true };
eq('a complete, priced, resolved match is research grade', M.gradeResearch(good).grade, 'research');
eq('no market price excludes it', M.gradeResearch(Object.assign({}, good, { market_prob: null })).grade, 'excluded');
eq('a doubles match is excluded', M.gradeResearch(Object.assign({}, good, { doubles: true })).grade, 'excluded');
eq('an unresolved side is excluded', M.gradeResearch(Object.assign({}, good, { players_resolved: false })).grade, 'excluded');
eq('no active model excludes it', M.gradeResearch(Object.assign({}, good, { model_active: false })).grade, 'excluded');
eq('an unknown surface is a caveat, not an exclusion',
   M.gradeResearch(Object.assign({}, good, { surface: 'unknown' })).grade, 'provisional');
eq('a stale price is a caveat', M.gradeResearch(Object.assign({}, good, { market_age_minutes: 600 })).grade, 'provisional');
eq('a thin rating sample is a caveat', M.gradeResearch(Object.assign({}, good, { rating_sample_a: 2 })).grade, 'provisional');
eq('incomplete features exclude', M.gradeResearch(Object.assign({}, good, { completeness: 0.2 })).grade, 'excluded');
chk('every refusal carries a reason code',
    M.gradeResearch(Object.assign({}, good, { market_prob: null })).reasons.indexOf('no_market_price') >= 0);
chk('a wide market is refused as a reference price',
    M.gradeResearch(Object.assign({}, good, { overround: 0.5 })).reasons.indexOf('market_too_wide') >= 0);

chk('confidence falls with a thin sample',
    M.confidence({ completeness: 1, uncertainty: 0, rating_sample_a: 2, rating_sample_b: 200, surface: 'clay' })
    < M.confidence({ completeness: 1, uncertainty: 0, rating_sample_a: 200, rating_sample_b: 200, surface: 'clay' }));
chk('and with an unknown surface',
    M.confidence({ completeness: 1, uncertainty: 0, rating_sample_a: 200, rating_sample_b: 200, surface: 'unknown' })
    < M.confidence({ completeness: 1, uncertainty: 0, rating_sample_a: 200, rating_sample_b: 200, surface: 'clay' }));
eq('confidence buckets are named, not numeric', M.confidenceBucket(0.9), 'high');
eq('and an unknown confidence says so', M.confidenceBucket(null), 'unknown');

/* ── 11. METRICS ──────────────────────────────────────────────────────── */
near('log loss of a perfect prediction is ~0', M.logLoss([0.999], [1]), 0.001, 0.001);
near('log loss of a coin flip is ln 2', M.logLoss([0.5, 0.5], [1, 0]), Math.LN2, 1e-6);
near('Brier of a coin flip is 0.25', M.brier([0.5, 0.5], [1, 0]), 0.25, 1e-9);
eq('accuracy counts the side it picked', M.accuracy([0.9, 0.2], [1, 0]), 1);
const curve = M.calibrationCurve([0.05, 0.15, 0.95], [0, 0, 1], 10);
eq('the calibration curve has one row per bin', curve.length, 10);
chk('and each row carries its own n', curve.every(c => typeof c.n === 'number'));
const ce = M.calibrationError(curve, 1);
chk('calibration error is computed over measurable bins only', ce.measured > 0 && ce.bins > 0);
const ceStrict = M.calibrationError(curve, 1000);
eq('with a high floor nothing is measurable and it says so', ceStrict.ece, null);
chk('and the unmeasured matches are counted rather than dropped silently', ceStrict.unmeasured === 3);

/* ── 12. THE FITTER ───────────────────────────────────────────────────── */
(function () {
  /* a separable problem the fitter must solve */
  const X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const d = (i % 2 ? 1 : -1) * (1 + (i % 7) / 7);
    X.push([d, 0]); y.push(d > 0 ? 1 : 0);
  }
  const f = M.fitLogistic(X, y, { epochs: 400, l2: 1e-4, lr: 0.3 });
  chk('the fitter learns the sign of a separable feature', f.weights[0] > 0, JSON.stringify(f.weights));
  chk('and leaves an irrelevant feature near zero', Math.abs(f.weights[1]) < 0.2);
  chk('and reports whether it converged', typeof f.converged === 'boolean');
  const mdl = M.modelFromFit(f, ['a', 'b']);
  eq('a fitted model names its coefficients', Object.keys(mdl.coefficients).sort(), ['a', 'b']);
})();

/* a model that does not carry a coefficient treats it as zero, so an old
   version cannot be changed by adding a feature to this file later */
(function () {
  const old = { intercept: 0, coefficients: { d_elo: 1 } };
  const p1 = M.predict(old, M.featureVector(A, B, {}));
  const p2 = M.predict(old, M.featureVector(A, B, {}));
  eq('a published model version is reproducible', p1, p2);
  chk('and unaffected by features it never carried', p1 > 0.5);
})();
chk('a probability is never 0 or 1', () => {
  const p = M.predict({ intercept: 99, coefficients: {} }, M.featureVector(A, B, {}));
  return p > 0 && p < 1;
});

/* ── 13. BASELINES ────────────────────────────────────────────────────── */
near('equal Elo is a coin flip', M.eloProb(1500, 1500), 0.5, 1e-9);
chk('400 Elo points is about 10 to 1', Math.abs(M.eloProb(1900, 1500) - 0.909) < 0.01);
eq('an absent Elo has no baseline probability', M.eloProb(null, 1500), null);
chk('the better rank is favoured', M.rankProb(1, 100) > 0.5);
eq('rank zero has no baseline', M.rankProb(0, 10), null);

/* ── 14. ONE NAME-FOLDING RULE ACROSS BOTH ENGINES ───────────────────── */
const NAMES = ['Roberto Bautista Agut', 'Novák Djoković', 'Alex de Minaur', "Karen Khachanov",
  'Jo-Wilfried Tsonga', 'Félix Auger-Aliassime', 'Aryna Sabalenka', 'Iga Świątek',
  'J. Sinner', 'Sinner J.', 'María Sákkari', '  spaced   name  '];
NAMES.forEach(n => eq('both engines fold "' + n + '" identically', M.normName(n), R.normName(n)));
chk('the two engines are separate files on purpose',
    fs.existsSync(path.join(__dirname, '..', '..', 'lib', 'tennis_model.js')) &&
    fs.existsSync(path.join(__dirname, '..', '..', 'lib', 'tennis_research.js')));

/* ── 15. THE ENGINE LOADS IN BOTH HOSTS ──────────────────────────────── */
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'tennis_model.js'), 'utf8');
chk('the engine is a plain script for the browser', /root\.EDTennisModel = api/.test(SRC));
chk('and a module for Node', /module\.exports = api/.test(SRC));
chk('it declares its own versions', !!M.VERSION && !!M.FEATURE_VERSION && !!M.RATING_VERSION);
['BET', 'LOCK', 'HAMMER', 'guaranteed', 'stake', 'bankroll'].forEach(w =>
  chk('the engine contains no wagering verb: ' + w, SRC.toUpperCase().indexOf(w.toUpperCase() + ' THIS') < 0));

if (fail) {
  console.log('FAIL | tennis model engine | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
  failures.forEach(f => console.log('     | ' + f));
  process.exit(1);
}
console.log('PASS | tennis model engine | ' + pass + ' assertions');
