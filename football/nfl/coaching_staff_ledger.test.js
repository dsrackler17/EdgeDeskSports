#!/usr/bin/env node
'use strict';

const assert = require('assert');
const L = require('./coaching_staff_ledger.js');

const ledger = L.newLedger();

const first = L.capture(ledger, {
  game_id: 'g1',
  season: 2026,
  week: 3,
  kickoff: '2026-09-27T17:00:00Z',
  home_code: 'KC',
  away_code: 'DEN',
  model_home_margin: 4.25,
  captured_at: '2026-09-22T17:00:00Z',
  model_version: 'nfl-test'
});
assert.strictEqual(first.captured, true);
assert.strictEqual(ledger.pending.g1.pregame_home_margin, 4.25);

/* A later build is not allowed to rewrite history. */
const overwrite = L.capture(ledger, {
  game_id: 'g1',
  home_code: 'KC',
  away_code: 'DEN',
  model_home_margin: 10
});
assert.strictEqual(overwrite.captured, false);
assert.strictEqual(ledger.pending.g1.pregame_home_margin, 4.25);

/* Unknown finals cannot be retroactively projected. */
const unknown = L.settle(ledger, {
  game_id: 'g2',
  home_score: 24,
  away_score: 20
});
assert.strictEqual(unknown.settled, false);
assert.match(unknown.reason, /no frozen pregame projection/i);

/* g1 final margin = +7. Residual = 7 - 4.25 = +2.75.
   Symmetric evidence = +1.375 home, -1.375 away. */
const settled = L.settle(ledger, {
  game_id: 'g1',
  home_score: 27,
  away_score: 20,
  settled_at: '2026-09-27T20:30:00Z'
});
assert.strictEqual(settled.settled, true);
assert.strictEqual(settled.record.actual_home_margin, 7);
assert.strictEqual(settled.record.residual, 2.75);
assert.strictEqual(settled.record.team_evidence.home, 1.375);
assert.strictEqual(settled.record.team_evidence.away, -1.375);
assert.strictEqual(ledger.pending.g1, undefined);
assert.ok(ledger.settled.g1);

/* Settlement is immutable too. */
const resettle = L.settle(ledger, {
  game_id: 'g1',
  home_score: 40,
  away_score: 0
});
assert.strictEqual(resettle.settled, false);
assert.strictEqual(ledger.settled.g1.residual, 2.75);

console.log('nfl coaching_staff_ledger: passed');
