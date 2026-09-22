#!/usr/bin/env node
'use strict';

const assert = require('assert');
const CS = require('./coaching_staff.js');

function doc(overrides) {
  return {
    config: Object.assign({
      enabled: true,
      affects_model: false,
      alpha: 0.2,
      shrink_k: 8,
      season_carry: 0.7,
      evidence_carry: 0.75,
      max_point_adjustment: 1,
      effect_sd: 1.5,
      validation_status: 'CANDIDATE',
      trained_through_season: 2025,
      source: 'synthetic test'
    }, overrides || {}),
    seeds: {}
  };
}

assert.strictEqual(CS.coachKey('  Andy   Reid '), 'Andy Reid');

const empty = CS.newState(doc());
const unknown = CS.view(empty, 'New Coach');
assert.strictEqual(unknown.available, false);
assert.strictEqual(unknown.rating, null, 'missing evidence must not become a fake 50');
assert.strictEqual(unknown.effect_points, null);
assert.strictEqual(unknown.reliability, 0);

const noPair = CS.matchup(empty, 'Andy Reid', 'Sean McVay');
assert.strictEqual(noPair.available, false);
assert.strictEqual(noPair.candidate_adjustment_points, null);
assert.strictEqual(noPair.applied_adjustment_points, 0);

const st = CS.newState(doc());
let u = CS.absorb(st, {
  home_coach: 'Coach A', away_coach: 'Coach B'
}, 3, 9, 2024);
assert.strictEqual(u.updated, true);
assert.strictEqual(u.residual_points, 6);
assert.strictEqual(st.coaches['Coach A'].observations, 1);
assert.strictEqual(st.coaches['Coach B'].observations, 1);
assert.ok(st.coaches['Coach A'].value > 0);
assert.ok(st.coaches['Coach B'].value < 0);

/* Same identity follows the coach, independent of team name. */
CS.absorb(st, {
  home_coach: 'Coach A', away_coach: 'Coach C'
}, -1, 4, 2024);
assert.strictEqual(st.coaches['Coach A'].observations, 2);
assert.strictEqual(st.coaches['Coach C'].observations, 1);

const va = CS.view(st, 'Coach A');
assert.strictEqual(va.available, true);
assert.ok(va.rating > 50);
assert.ok(va.reliability > 0 && va.reliability < 1);

const research = CS.matchup(st, 'Coach A', 'Coach B');
assert.strictEqual(research.available, true);
assert.ok(research.candidate_adjustment_points > 0);
assert.strictEqual(research.applied_adjustment_points, 0,
  'CANDIDATE staff signal is visible but cannot move the model');
assert.strictEqual(research.affects_model, false);

const promoted = CS.newState(doc({
  affects_model: true,
  validation_status: 'VALIDATED',
  max_point_adjustment: 0.5
}));
promoted.coaches = JSON.parse(JSON.stringify(st.coaches));
const priced = CS.matchup(promoted, 'Coach A', 'Coach B');
assert.strictEqual(priced.affects_model, true);
assert.ok(Math.abs(priced.applied_adjustment_points) <= 0.5 + 1e-12);
assert.strictEqual(priced.applied_adjustment_points, priced.candidate_adjustment_points);

const beforeValue = promoted.coaches['Coach A'].value;
const beforeEvidence = promoted.coaches['Coach A'].evidence;
CS.seasonBreak(promoted, 2025);
assert.ok(Math.abs(promoted.coaches['Coach A'].value - beforeValue * 0.7) < 1e-12);
assert.ok(Math.abs(promoted.coaches['Coach A'].evidence - beforeEvidence * 0.75) < 1e-12);

const missingIdentity = CS.absorb(st, {
  home_coach: null, away_coach: 'Coach B'
}, 0, 7, 2024);
assert.strictEqual(missingIdentity.updated, false,
  'one missing coach cannot silently assign the other half of a symmetric residual');

const disabled = CS.newState(doc({ enabled: false, affects_model: true, validation_status: 'VALIDATED' }));
const disabledMatch = CS.matchup(disabled, 'Coach A', 'Coach B');
assert.strictEqual(disabledMatch.applied_adjustment_points, 0);
assert.strictEqual(disabledMatch.candidate_adjustment_points, null);

console.log('nfl coaching_staff: passed');
