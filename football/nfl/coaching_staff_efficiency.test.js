#!/usr/bin/env node
'use strict';

const assert = require('assert');
const E = require('./coaching_staff_efficiency.js');

function row(season, week, team, opp, gameId, epaPerPlay, plays) {
  plays = plays || 10;
  return {
    season,
    week,
    team,
    opponent_team: opp,
    game_id: gameId,
    season_type: 'REG',
    attempts: plays,
    sacks_suffered: 0,
    carries: 0,
    passing_epa: epaPerPlay * plays,
    rushing_epa: 0
  };
}

/* passing_epa includes sacks, so sacks belong in the play denominator. */
assert.strictEqual(E.offenseEpaPerPlay({
  attempts: 8,
  sacks_suffered: 2,
  carries: 0,
  passing_epa: 2,
  rushing_epa: 0
}), 0.2);

const rows = [];
for (let w = 1; w <= 6; w++) {
  const game = 'g' + w;
  const teamOff = 0.1 * w;
  const oppOff = 0.1;
  rows.push(row(2026, w, 'A', 'O' + w, game, teamOff, 10));
  rows.push(row(2026, w, 'O' + w, 'A', game, oppOff, 10));
}

/* B has only five usable games and must remain unavailable. */
for (let w = 1; w <= 5; w++) {
  const game = 'b' + w;
  rows.push(row(2026, w, 'B', 'P' + w, game, 0.2, 10));
  rows.push(row(2026, w, 'P' + w, 'B', game, 0.1, 10));
}

/* A net EPA/play: 0.0, 0.1, 0.2, 0.3, 0.4, 0.5.
   Early mean = 0.1, recent mean = 0.4, development = +0.3. */
const out = E.build(rows, { season: 2026, teamKeys: ['A', 'B', 'C'] });
assert.strictEqual(out.schema, E.SCHEMA);
assert.strictEqual(out.input, 'efficiency_development');
assert.strictEqual(out.window_games, 3);
assert.strictEqual(out.min_games, 6);
assert.strictEqual(out.opponent_strength_adjusted, false);

assert.strictEqual(out.teams.A.available, true);
assert.strictEqual(out.teams.A.games_available, 6);
assert.strictEqual(out.teams.A.observations, 6);
assert.strictEqual(out.teams.A.early_mean_net_epa_per_play, 0.1);
assert.strictEqual(out.teams.A.recent_mean_net_epa_per_play, 0.4);
assert.strictEqual(out.teams.A.value, 0.3);
assert.deepStrictEqual(out.teams.A.early_game_ids, ['g1', 'g2', 'g3']);
assert.deepStrictEqual(out.teams.A.recent_game_ids, ['g4', 'g5', 'g6']);

assert.strictEqual(out.teams.B.available, false);
assert.strictEqual(out.teams.B.value, null);
assert.strictEqual(out.teams.B.games_available, 5);
assert.match(out.teams.B.reason, /at least 6/i);

assert.strictEqual(out.teams.C.available, false);
assert.strictEqual(out.teams.C.value, null);
assert.strictEqual(out.teams.C.games_available, 0);

const bad = E.build(rows, { teamKeys: ['A'] });
assert.match(bad.error, /season is required/i);
assert.strictEqual(bad.teams.A.value, null);

console.log('nfl coaching_staff_efficiency: passed');
