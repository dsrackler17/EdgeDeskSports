#!/usr/bin/env node
'use strict';

const assert = require('assert');
const V = require('./coaching_staff_validation.js');

const ledger = { settled: {} };

for (let i = 0; i < 40; i++) {
  const season = i < 20 ? 2025 : 2026;
  const day = String((i % 20) + 1).padStart(2, '0');
  const factorDelta = i % 2 === 0 ? 1 : 0.5;
  const noise = [-0.2, 0, 0.2, 0.1][i % 4];
  const id = 'g' + i;
  ledger.settled[id] = {
    game_id: id,
    season,
    kickoff: season + '-10-' + day + 'T18:00:00Z',
    captured_at: season + '-10-' + day + 'T12:00:00Z',
    pregame_home_margin: 0,
    actual_home_margin: factorDelta + noise,
    coaching_research: {
      schema: V.SNAPSHOT_SCHEMA,
      frozen_at: season + '-10-' + day + 'T12:00:00Z',
      projection_influence: false,
      applied_points: 0,
      home: { available: true, rating: 60, reliability: 0.5, factor: factorDelta / 2 },
      away: { available: true, rating: 40, reliability: 0.5, factor: -factorDelta / 2 }
    }
  };
}

/* This row looks numerically useful but was frozen after kickoff, so it is
   excluded instead of laundering leakage into a flattering report. */
ledger.settled.leaky = {
  game_id: 'leaky',
  season: 2026,
  kickoff: '2026-11-01T18:00:00Z',
  captured_at: '2026-11-01T19:00:00Z',
  pregame_home_margin: 0,
  actual_home_margin: 10,
  coaching_research: {
    schema: V.SNAPSHOT_SCHEMA,
    frozen_at: '2026-11-01T19:00:00Z',
    projection_influence: false,
    applied_points: 0,
    home: { available: true, rating: 100, reliability: 1, factor: 1 },
    away: { available: true, rating: 0, reliability: 1, factor: -1 }
  }
};

ledger.settled.no_snapshot = {
  game_id: 'no_snapshot',
  season: 2026,
  kickoff: '2026-11-02T18:00:00Z',
  captured_at: '2026-11-02T12:00:00Z',
  pregame_home_margin: 0,
  actual_home_margin: 3
};

const report = V.analyze(ledger, {
  caps: [0, 0.5, 1],
  now: '2026-12-01T00:00:00Z'
});

assert.strictEqual(report.schema, V.SCHEMA);
assert.strictEqual(report.status, 'RESEARCH_ONLY');
assert.strictEqual(report.may_move_lines, false);
assert.strictEqual(report.selected_cap, null);
assert.deepStrictEqual(report.caps_tested, [0, 0.5, 1]);
assert.strictEqual(report.games_scored, 40);
assert.deepStrictEqual(report.seasons_scored, [2025, 2026]);
assert.strictEqual(report.excluded.timestamp_not_verifiably_pregame, 1);
assert.strictEqual(report.excluded.no_research_snapshot, 1);
assert.strictEqual(report.leakage_clean_rows_only, true);

const base = report.arms.find((x) => x.cap === 0);
const half = report.arms.find((x) => x.cap === 0.5);
const one = report.arms.find((x) => x.cap === 1);
assert.ok(base.mae > half.mae);
assert.ok(half.mae > one.mae);
assert.ok(one.mae_improvement_vs_baseline > 0);
assert.ok(one.rmse_delta_vs_baseline < 0);
assert.strictEqual(one.paired.n, 40);
assert.ok(one.paired.p != null && one.paired.p < 0.05);

assert.ok(report.promotion_blockers.some((x) => /Brier/i.test(x)));
assert.ok(report.promotion_blockers.some((x) => /selects no cap|no tune\/holdout/i.test(x)));
assert.ok(!Object.prototype.hasOwnProperty.call(report, 'best_cap'));

console.log('nfl coaching_staff_validation: passed');
