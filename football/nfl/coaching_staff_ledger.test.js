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
  home_head_coach: 'Andy Reid',
  away_head_coach: 'Sean Payton',
  model_home_margin: 4.25,
  captured_at: '2026-09-22T17:00:00Z',
  model_version: 'nfl-test'
});
assert.strictEqual(first.captured, true);
assert.strictEqual(ledger.pending.g1.pregame_home_margin, 4.25);
assert.strictEqual(ledger.pending.g1.home_head_coach, 'Andy Reid');
assert.strictEqual(ledger.pending.g1.away_head_coach, 'Sean Payton');

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

/* Raw current-residual evidence is measurable, season-scoped and honest about
   missing teams. No score, reliability curve or neutral default is invented. */
const current = L.summarizeCurrentResidual(ledger, {
  season: 2026,
  teamKeys: ['KC', 'DEN', 'BUF']
});
assert.strictEqual(current.schema, L.EVIDENCE_SCHEMA);
assert.strictEqual(current.input, 'current_residual_conversion');
assert.strictEqual(current.teams.KC.available, true);
assert.strictEqual(current.teams.KC.observations, 1);
assert.strictEqual(current.teams.KC.value, 1.375);
assert.strictEqual(current.teams.KC.total_evidence, 1.375);
assert.deepStrictEqual(current.teams.KC.game_ids, ['g1']);
assert.strictEqual(current.teams.DEN.available, true);
assert.strictEqual(current.teams.DEN.value, -1.375);
assert.strictEqual(current.teams.BUF.available, false);
assert.strictEqual(current.teams.BUF.value, null);
assert.strictEqual(current.teams.BUF.observations, 0);

const otherSeason = L.summarizeCurrentResidual(ledger, {
  season: 2025,
  teamKeys: ['KC']
});
assert.strictEqual(otherSeason.teams.KC.available, false);
assert.strictEqual(otherSeason.teams.KC.value, null);

const invalidEvidence = L.summarizeCurrentResidual(null, { teamKeys: ['KC'] });
assert.match(invalidEvidence.error, /invalid ledger/i);
assert.strictEqual(invalidEvidence.teams.KC.value, null);

/* Multi-season head-coach evidence follows the coach across teams, but is not
   available until the frozen ledger contains at least two distinct seasons. */
const coachLedger = L.newLedger();

L.capture(coachLedger, {
  game_id: 'hc-2025',
  season: 2025,
  home_code: 'KC',
  away_code: 'DEN',
  home_head_coach: 'Andy Reid',
  away_head_coach: 'Sean Payton',
  model_home_margin: 3
});
L.settle(coachLedger, {
  game_id: 'hc-2025',
  home_score: 27,
  away_score: 20
}); // residual +4 => Reid +2

let hc = L.summarizeHeadCoachResidual(coachLedger, {
  teamKeys: ['KC', 'DEN', 'BUF'],
  currentCoaches: {
    KC: 'Andy Reid',
    DEN: 'Sean Payton'
  }
});
assert.strictEqual(hc.schema, L.HEAD_COACH_EVIDENCE_SCHEMA);
assert.strictEqual(hc.input, 'multi_season_head_coach');
assert.strictEqual(hc.teams.KC.available, false);
assert.strictEqual(hc.teams.KC.value, null);
assert.strictEqual(hc.teams.KC.observations, 1);
assert.strictEqual(hc.teams.KC.season_count, 1);
assert.deepStrictEqual(hc.teams.KC.seasons, [2025]);
assert.strictEqual(hc.teams.BUF.available, false);
assert.strictEqual(hc.teams.BUF.value, null);
assert.match(hc.teams.BUF.reason, /current head coach is unavailable/i);

L.capture(coachLedger, {
  game_id: 'hc-2026',
  season: 2026,
  home_code: 'BUF',
  away_code: 'KC',
  home_head_coach: 'New Coach',
  away_head_coach: 'Andy Reid',
  model_home_margin: 1
});
L.settle(coachLedger, {
  game_id: 'hc-2026',
  home_score: 20,
  away_score: 24
}); // actual -4, residual -5 => away Reid +2.5

hc = L.summarizeHeadCoachResidual(coachLedger, {
  teamKeys: ['KC', 'BUF'],
  currentCoaches: {
    KC: 'Andy Reid',
    BUF: 'New Coach'
  }
});
assert.strictEqual(hc.teams.KC.available, true);
assert.strictEqual(hc.teams.KC.observations, 2);
assert.strictEqual(hc.teams.KC.season_count, 2);
assert.deepStrictEqual(hc.teams.KC.seasons, [2025, 2026]);
assert.strictEqual(hc.teams.KC.total_evidence, 4.5);
assert.strictEqual(hc.teams.KC.mean_evidence, 2.25);
assert.strictEqual(hc.teams.KC.value, 2.25);
assert.deepStrictEqual(hc.teams.KC.game_ids, ['hc-2025', 'hc-2026']);
assert.strictEqual(hc.teams.BUF.available, false);
assert.strictEqual(hc.teams.BUF.value, null);
assert.strictEqual(hc.teams.BUF.observations, 1);
assert.strictEqual(hc.teams.BUF.season_count, 1);

/* Program persistence is the same franchise across seasons, time-decayed.
   Current season receives 45%, prior season 30%, normalized over observed
   seasons. One frozen season is still not "persistence." */
const program = L.summarizeProgramPersistence(coachLedger, {
  currentSeason: 2026,
  teamKeys: ['KC', 'BUF', 'DEN']
});
assert.strictEqual(program.schema, L.PROGRAM_EVIDENCE_SCHEMA);
assert.strictEqual(program.input, 'program_persistence');
assert.deepStrictEqual(program.decay, [0.45, 0.30, 0.17, 0.08]);
assert.strictEqual(program.teams.KC.available, true);
assert.strictEqual(program.teams.KC.season_count, 2);
assert.strictEqual(program.teams.KC.observations, 2);
assert.strictEqual(program.teams.KC.observed_decay_weight, 0.75);
assert.strictEqual(program.teams.KC.value, 2.3);
assert.deepStrictEqual(program.teams.KC.seasons.map((s) => s.season), [2026, 2025]);
assert.strictEqual(program.teams.KC.seasons[0].normalized_weight, 0.6);
assert.strictEqual(program.teams.KC.seasons[1].normalized_weight, 0.4);
assert.strictEqual(program.teams.BUF.available, false);
assert.strictEqual(program.teams.BUF.value, null);
assert.strictEqual(program.teams.BUF.season_count, 1);
assert.strictEqual(program.teams.DEN.available, false);
assert.strictEqual(program.teams.DEN.value, null);

const badProgram = L.summarizeProgramPersistence(coachLedger, {
  teamKeys: ['KC']
});
assert.match(badProgram.error, /currentSeason is required/i);
assert.strictEqual(badProgram.teams.KC.value, null);

console.log('nfl coaching_staff_ledger: passed');
