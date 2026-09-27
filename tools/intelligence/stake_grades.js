#!/usr/bin/env node
/* ============================================================================
   THE STAKING SCORECARD — the sizing engine graded against flat staking.

   `stake_recommendation_grades` already computes, for every position the
   engine sized, the profit in units at the size it recommended AND the profit
   a flat 0.5u and a flat 1u would have returned on the SAME selections at the
   SAME prices. This file does the grouping and states the reading in words.

   The reading is the whole point. A sizing engine that does not beat flat
   staking on its own selections has added nothing: it has taken the same
   bets and moved money around. So the verdict is never "profit" — it is
   whether the engine cleared both baselines, on a sample large enough to
   read, with the sample floor printed beside every figure that is below it.

   A pass is graded too. `pass_reason` says which gate refused a candidate,
   and a gate that refuses everything is a broken gate, not a strict one.

   Pure given its rows: no I/O, no clock beyond `generated_at`.
   ========================================================================== */
'use strict';

const SAMPLE_FLOOR = 50;

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r3(v) { return v == null ? null : Math.round(v * 1000) / 1000; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function mean(a) { const x = a.filter((v) => v != null); return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null; }

function blank() {
  return {
    positions: 0, graded: 0, wins: 0, losses: 0, pushes: 0,
    units_staked: 0, profit_units: 0, profit_units_flat_half: 0, profit_units_flat_one: 0,
    clv: [], beat: 0, missed: 0, brier_cons: [], brier_cal: [], logloss: [], ev: [], rel: [],
  };
}

function absorb(e, r) {
  e.positions++;
  const graded = r.grade_state === 'GRADED' && r.result != null;
  const ev = num(r.expected_value), rel = num(r.reliability_score);
  if (ev != null) e.ev.push(ev);
  if (rel != null) e.rel.push(rel);
  const clv = num(r.clv);
  if (clv != null) e.clv.push(clv);
  if (r.beat_close === true) e.beat++; else if (r.beat_close === false) e.missed++;
  if (!graded) return;
  e.graded++;
  if (r.result === 'win') e.wins++; else if (r.result === 'loss') e.losses++; else if (r.result === 'push') e.pushes++;
  e.units_staked += num(r.recommended_units) || 0;
  e.profit_units += num(r.profit_units) || 0;
  e.profit_units_flat_half += num(r.profit_units_flat_half) || 0;
  e.profit_units_flat_one += num(r.profit_units_flat_one) || 0;
  const bc = num(r.brier_conservative), bk = num(r.brier_calibrated), ll = num(r.log_loss_conservative);
  if (bc != null) e.brier_cons.push(bc);
  if (bk != null) e.brier_cal.push(bk);
  if (ll != null) e.logloss.push(ll);
}

/* THE READING. Written once, because this is the sentence a reader will quote
   back and it must not be able to overstate what the numbers support. */
function reading(g) {
  if (g.graded === 0) return 'nothing has graded yet in this group: the engine has sized ' + g.positions + ' position' + (g.positions === 1 ? '' : 's') + ' and none has a closed result';
  if (!g.sufficient_sample) return 'below the sample floor of ' + SAMPLE_FLOOR + ' graded positions (' + g.graded + ' so far): no reading is claimed, in either direction';
  const beatBoth = g.beats_flat_half && g.beats_flat_one;
  const money = 'the engine returned ' + r3(g.profit_units) + 'u on ' + r3(g.units_staked) + 'u staked'
    + (g.roi_on_staked == null ? '' : ' (ROI ' + (Math.round(g.roi_on_staked * 1000) / 10) + '%)')
    + ', against flat 0.5u ' + r3(g.profit_units_flat_half) + 'u and flat 1u ' + r3(g.profit_units_flat_one) + 'u on the same selections';
  if (beatBoth && g.profit_units > 0) return money + '. It cleared both flat baselines: that is evidence the sizing rules add something over betting the same card flat, and it is not a claim of profit going forward.';
  if (beatBoth) return money + '. It lost less than both flat baselines would have, which is the sizing rules working in the losing direction; it is not a result to act on.';
  return money + '. It did not clear both flat baselines, so on this evidence the sizing rules have not earned anything here over flat staking on the same card.';
}

function finish(e) {
  const g = {
    positions: e.positions, graded: e.graded, wins: e.wins, losses: e.losses, pushes: e.pushes,
    units_staked: r3(e.units_staked), profit_units: r3(e.profit_units),
    profit_units_flat_half: r3(e.profit_units_flat_half), profit_units_flat_one: r3(e.profit_units_flat_one),
    roi_on_staked: e.units_staked > 0 ? r4(e.profit_units / e.units_staked) : null,
    beats_flat_half: e.graded > 0 ? e.profit_units > e.profit_units_flat_half : null,
    beats_flat_one: e.graded > 0 ? e.profit_units > e.profit_units_flat_one : null,
    mean_clv: r3(mean(e.clv)), with_clv: e.clv.length,
    beat_close_rate: e.beat + e.missed ? r3(e.beat / (e.beat + e.missed)) : null,
    brier_conservative: r4(mean(e.brier_cons)), brier_calibrated: r4(mean(e.brier_cal)),
    log_loss_conservative: r4(mean(e.logloss)),
    avg_expected_value: r4(mean(e.ev)), avg_reliability: r3(mean(e.rel)),
    sufficient_sample: e.graded >= SAMPLE_FLOOR,
  };
  g.reading = reading(g);
  return g;
}

/** The pass ledger: which gate refused what, counted like a result. */
function passes(rows) {
  const out = {};
  rows.filter((r) => r.status && r.status !== 'BET').forEach((r) => {
    const gate = String(r.pass_reason || 'UNRECORDED').split(':')[0];
    const e = (out[gate] = out[gate] || { passes: 0, statuses: {}, markets: {}, ev: [], rel: [] });
    e.passes++;
    e.statuses[r.status] = (e.statuses[r.status] || 0) + 1;
    const mk = (r.sport || '?') + '|' + (r.market || '?');
    e.markets[mk] = (e.markets[mk] || 0) + 1;
    const ev = num(r.expected_value), rel = num(r.reliability_score);
    if (ev != null) e.ev.push(ev);
    if (rel != null) e.rel.push(rel);
  });
  Object.keys(out).forEach((k) => {
    const e = out[k];
    out[k] = { passes: e.passes, statuses: e.statuses, markets: e.markets, avg_expected_value: r4(mean(e.ev)), avg_reliability: r3(mean(e.rel)) };
  });
  return out;
}

/* DID THE READER TAKE IT? The engine's record is one thing; the record of the
   bets a reader actually placed is a different one, and conflating them would
   credit the engine with a discipline it did not supply. Both are reported,
   never summed. */
const TAKEN = { ACCEPTED: true, MODIFIED: true };
function acceptance(rows) {
  const bets = rows.filter((r) => r.status === 'BET');
  const answered = bets.filter((r) => r.reader_response != null && r.reader_response !== '');
  const counts = {};
  answered.forEach((r) => { counts[r.reader_response] = (counts[r.reader_response] || 0) + 1; });
  /* ACCEPTED and MODIFIED are both bets the reader placed; DECLINED is one
     they did not, and EXPIRED is one they never answered before kickoff. Only
     the first two can carry a result the reader actually owns. */
  const took = answered.filter((r) => TAKEN[r.reader_response] && r.grade_state === 'GRADED' && r.result != null);
  let acceptedStaked = 0, acceptedProfit = 0, recommendedOnSame = 0, sizeMatched = 0;
  took.forEach((r) => {
    const rec = num(r.recommended_units) || 0;
    const acc = num(r.reader_accepted_units);
    const u = acc == null ? rec : acc;
    const d = num(r.odds_decimal);
    if (d == null) return;
    acceptedStaked += u;
    acceptedProfit += r.result === 'win' ? u * (d - 1) : r.result === 'loss' ? -u : 0;
    recommendedOnSame += num(r.profit_units) || 0;
    if (acc == null || Math.abs(acc - rec) < 1e-9) sizeMatched++;
  });
  const takenAll = answered.filter((r) => TAKEN[r.reader_response]).length;
  return {
    recommendations: bets.length,
    answered: answered.length,
    unanswered: bets.length - answered.length,
    responses: counts,
    taken: takenAll,
    declined: answered.filter((r) => r.reader_response === 'DECLINED').length,
    expired: answered.filter((r) => r.reader_response === 'EXPIRED').length,
    acceptance_rate: bets.length ? r3(takenAll / bets.length) : null,
    graded_taken: took.length,
    size_followed: sizeMatched,
    units_staked_by_reader: r3(acceptedStaked),
    profit_units_by_reader: r3(acceptedProfit),
    profit_units_if_sized_as_recommended: r3(recommendedOnSame),
    note: 'The reader’s record and the engine’s record are reported separately and never added together: a bet the reader declined is not a bet the engine lost, and a bet the reader resized is not the bet the engine sized.',
  };
}

/** The whole staking scorecard. Pure given its rows. */
function report(rows, opts) {
  opts = opts || {};
  rows = Array.isArray(rows) ? rows : [];
  const bets = rows.filter((r) => r.status === 'BET');
  const groups = {};
  const add = (key, r) => { absorb(groups[key] = groups[key] || blank(), r); };
  bets.forEach((r) => {
    add('all', r);
    add((r.sport || 'unknown') + '|' + (r.market || 'unknown'), r);
    if (r.recommendation_tier) add('tier:' + r.recommendation_tier, r);
    if (r.model_version) add('model:' + r.model_version, r);
  });
  const table = {};
  Object.keys(groups).forEach((k) => { table[k] = finish(groups[k]); });
  const states = {};
  rows.forEach((r) => { const s = r.grade_state || 'UNKNOWN'; states[s] = (states[s] || 0) + 1; });
  return {
    schema: 'edgedesk_stake_scorecard_v1',
    generated_at: opts.now || new Date().toISOString(),
    rows: rows.length, sized: bets.length,
    status: opts.status || 'OK', detail: opts.detail || null,
    sample_floor: SAMPLE_FLOOR,
    grade_states: states,
    groups: table,
    passes: passes(rows),
    acceptance: acceptance(rows),
    note: 'Every figure here is measured against the SAME selections at the SAME prices, so the only question it can answer is whether the sizing rules beat flat staking on the card the engine chose. It cannot answer whether the card was worth betting; that is what the closing-line-value scorecard and the walk-forward validation are for. Below the sample floor no reading is claimed in either direction.',
  };
}

module.exports = { report, passes, acceptance, reading, SAMPLE_FLOOR };
