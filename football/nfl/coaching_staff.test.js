#!/usr/bin/env node
'use strict';

const assert = require('assert');
const C = require('./coaching_staff.js');

assert.strictEqual(C.SCHEMA, 'edgedesk_nfl_coaching_staff_v1');
assert.strictEqual(C.CONFIG.affects_nfl_projection, false);
assert.strictEqual(C.CONFIG.candidate_max_point_adjustment, 0);

const sumW = Object.keys(C.INPUTS).reduce((s, k) => s + C.INPUTS[k].weight, 0);
assert.ok(Math.abs(sumW - 1) < 1e-12, 'configured NFL coaching/staff weights must sum to one');

const st = C.newState();
let o = C.observeGame(st, {
  home: 'A', away: 'B',
  home_coach: 'Coach A', away_coach: 'Coach B',
  pregame_home_margin: 3,
  actual_home_margin: 9,
  at: '2026-09-01T00:00:00Z'
});
assert.strictEqual(o.observed, true);
assert.strictEqual(o.residual, 6);
assert.strictEqual(o.home_evidence, 3);
assert.strictEqual(o.away_evidence, -3);

/* A second game creates cross-sectional dispersion and therefore a real score. */
C.observeGame(st, {
  home: 'C', away: 'D',
  home_coach: 'Coach C', away_coach: 'Coach D',
  pregame_home_margin: 0,
  actual_home_margin: -8,
  at: '2026-09-08T00:00:00Z'
});
const built = C.finalize(st);
assert.strictEqual(built.status, 'RESEARCH_ONLY');
assert.strictEqual(built.affects_projection, false);
assert.strictEqual(built.observed_games, 2);

for (const team of ['A','B','C','D']) {
  const t = built.teams[team];
  assert.ok(t, team + ' must exist');
  assert.ok(t.coaching_staff_rating != null, team + ' should have a measured rating');
  assert.ok(t.coaching_staff_reliability > 0);
  assert.strictEqual(t.coaching_staff_affects_projection, false);
  assert.strictEqual(t.coaching_staff_adjustment_points, 0);
  assert.ok(t.coaching_staff_inputs.current_residual_conversion.available);
  assert.strictEqual(t.coaching_staff_inputs.multi_season_head_coach.available, false);
  assert.strictEqual(t.coaching_staff_inputs.game_management.available, false);
}

/* Better-than-model residual should rank above the symmetric negative side. */
assert.ok(built.teams.A.coaching_staff_rating > built.teams.B.coaching_staff_rating);
assert.ok(built.teams.A.coaching_staff_rank < built.teams.B.coaching_staff_rank);

/* Truly missing evidence remains absent. There is no fake neutral 50. */
const empty = C.finalize(C.newState());
assert.deepStrictEqual(empty.teams, {});

/* One game is measured, not hidden, but its reliability is deliberately tiny
   and the final rating is pulled hard toward 50. */
const one = C.newState();
C.observeGame(one, {
  home: 'A', away: 'B',
  pregame_home_margin: 0, actual_home_margin: 7
});
const oneBuilt = C.finalize(one);
assert.ok(oneBuilt.teams.A.coaching_staff_rating != null);
assert.strictEqual(oneBuilt.teams.A.coaching_staff_available, true);
assert.ok(oneBuilt.teams.A.coaching_staff_reliability < 0.1);
assert.ok(Math.abs(oneBuilt.teams.A.coaching_staff_rating - 50)
  < Math.abs(oneBuilt.teams.A.coaching_staff_raw_score - 50));

/* Historical HC evidence follows the coach, not the franchise logo. */
const seedState = C.newState();
C.observeGame(seedState, {
  home: 'A', away: 'B',
  home_coach: 'Coach A', away_coach: 'Coach B',
  pregame_home_margin: 0, actual_home_margin: 4
});
C.observeGame(seedState, {
  home: 'C', away: 'D',
  home_coach: 'Coach C', away_coach: 'Coach D',
  pregame_home_margin: 0, actual_home_margin: -4
});
const seeds = {
  A: {
    head_coach: {
      coach: 'Coach A',
      rating: 70,
      observations: 34,
      weighted_evidence: 1.2,
      reliability: 0.8,
      source: 'historical walk-forward residual'
    },
    program: {
      rating: 60,
      observations: 64,
      weighted_evidence: 0.4,
      reliability: 0.7,
      source: 'franchise residual'
    }
  },
  B: {
    head_coach: {
      coach: 'Different Coach',
      rating: 95,
      observations: 60,
      reliability: 0.9,
      source: 'historical walk-forward residual'
    }
  }
};
const seeded = C.finalize(seedState, { seeds });
assert.strictEqual(seeded.teams.A.coaching_staff_inputs.multi_season_head_coach.value, 70);
assert.strictEqual(seeded.teams.A.coaching_staff_inputs.multi_season_head_coach.available, true);
assert.strictEqual(seeded.teams.B.coaching_staff_inputs.multi_season_head_coach.value, null);
assert.strictEqual(seeded.teams.B.coaching_staff_inputs.multi_season_head_coach.available, false);
assert.match(seeded.teams.B.coaching_staff_inputs.multi_season_head_coach.reason, /different coach/i);

/* More observations increase current-season reliability. */
const more = C.newState();
for (let i = 0; i < 8; i++) {
  C.observeGame(more, {
    home: 'A', away: 'B',
    home_coach: 'Coach A', away_coach: 'Coach B',
    pregame_home_margin: 0, actual_home_margin: 3 + i * 0.01
  });
  C.observeGame(more, {
    home: 'C', away: 'D',
    home_coach: 'Coach C', away_coach: 'Coach D',
    pregame_home_margin: 0, actual_home_margin: -3 - i * 0.01
  });
}
const moreBuilt = C.finalize(more);
assert.ok(
  moreBuilt.teams.A.coaching_staff_inputs.current_residual_conversion.reliability
    > built.teams.A.coaching_staff_inputs.current_residual_conversion.reliability
);

/* The published final score is shrunk toward 50 versus its raw score. */
const ta = moreBuilt.teams.A;
assert.ok(Math.abs(ta.coaching_staff_rating - 50) <= Math.abs(ta.coaching_staff_raw_score - 50) + 1e-9);

console.log('nfl coaching_staff: passed');
