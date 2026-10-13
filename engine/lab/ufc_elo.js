#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk UFC — what one year of bout results can and cannot support.

     node engine/lab/ufc_elo.js          writes engine/lab/ufc_elo.json

   The data pack holds the 2024 UFC bout results (566 bouts, ESPN) and no
   round-level statistics (UFCStats refused automated access; the pack did
   not bypass it and neither does this). A chronological Elo (Glickman's
   family; the published baseline for MMA) is run over the year; a bout is
   scored only when both fighters already had a 2024 bout. Draws and no
   contests are counted and excluded.

   The outcome is a measurement of insufficiency: one season and a few
   hundred scorable bouts cannot meet the protocol (n >= 1000, >= 2 seasons),
   so UFC stays RESEARCH_ONLY and no fight probability is published.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { readCsv } = require('../csv');
const V = require('../validation');
const P = require('./protocol');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'ufc_elo.json');

function run(k) {
  const rows = readCsv(path.join(ROOT, 'datapack', 'quant_v1', 'data', 'ufc', 'bouts_2024.csv')).rows
    .sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : a.bout_id < b.bout_id ? -1 : 1));
  const r = new Map(); const seen = new Map();
  const stats = { bouts: rows.length, final: 0, no_winner: 0, scored: 0 };
  const scored = [];
  for (const b of rows) {
    if (b.status !== 'STATUS_FINAL') continue;
    stats.final++;
    const aw = b.a_winner === 'True', bw = b.b_winner === 'True';
    if (aw === bw) { stats.no_winner++; continue; }
    const ra = r.get(b.fighter_a_id) || 1500, rb = r.get(b.fighter_b_id) || 1500;
    const e = 1 / (1 + Math.pow(10, -(ra - rb) / 400));
    if (seen.get(b.fighter_a_id) && seen.get(b.fighter_b_id)) { scored.push({ p: e, y: aw ? 1 : 0, date: b.start_time.slice(0, 10) }); stats.scored++; }
    r.set(b.fighter_a_id, ra + k * ((aw ? 1 : 0) - e)); r.set(b.fighter_b_id, rb - k * ((aw ? 1 : 0) - e));
    seen.set(b.fighter_a_id, true); seen.set(b.fighter_b_id, true);
  }
  return { stats, scored };
}

function main() {
  const { stats, scored } = run(32);
  const m = V.binary(scored);
  const base = V.binary(scored.map((x) => ({ p: 0.5, y: x.y })));
  const cmp = P.compare(scored, (x) => V.logLoss(x.p, x.y), (x) => V.logLoss(0.5, x.y));
  const failed = [];
  if (m.n < P.RULES.min_n) failed.push('n ' + m.n + ' < ' + P.RULES.min_n);
  failed.push('1 season < ' + P.RULES.min_seasons);
  if (!cmp.a_better) failed.push('does not beat a coin flip with a 95% interval below zero');
  const out = {
    schema: 'edgedesk_lab_walkforward_v1', sport: 'mma', label: 'UFC / MMA', generated_at: new Date().toISOString(),
    data: { source: 'datapack/quant_v1/data/ufc/bouts_2024.csv (ESPN, research copy)', bouts: stats.bouts, final: stats.final, draws_or_no_contests: stats.no_winner, scored: stats.scored, seasons: [2024, 2024],
      temporal: { point_in_time: 'RETROSPECTIVE', known_at: 'blank' } },
    method: 'chronological Elo, K = 32 (not tuned: there is no separate selection window in one year); scored only when both fighters had an earlier 2024 bout',
    result: { elo: { log_loss: m.log_loss, brier: m.brier, n: m.n, calibration_slope: m.calibration_slope }, coin_flip: { log_loss: base.log_loss }, elo_vs_coin_flip: cmp },
    markets: { moneyline: Object.assign({ market: 'fight winner', status: 'INSUFFICIENT', failed }, P.MARKET_NOT_TESTED) },
    unresolved: [
      'Round-level fight statistics (significant strikes, takedowns, control time) — UFCStats refuses automated access; an authorised feed is needed.',
      'Multi-year bout history — the pack holds 2024 only; the live UFC center syncs events into Supabase, not a training archive.',
      'Method-of-victory and round markets need the round-level data above.',
    ],
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log('[ufc elo] ' + stats.scored + ' scorable bouts of ' + stats.final + '; Elo LL ' + m.log_loss + ' vs coin flip ' + base.log_loss + '; ' + JSON.stringify(cmp) + ' -> INSUFFICIENT');
}

if (require.main === module) main();
module.exports = { run };
