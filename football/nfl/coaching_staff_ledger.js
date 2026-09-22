/* ============================================================================
   EdgeDesk NFL — frozen pregame Coaching / Staff residual ledger.

   Pure state transitions only. No file I/O here.

   A prediction may be captured exactly once before the result is known. Once
   captured, later builds cannot overwrite it. A game is settled only when a
   final score exists.

   Residual:
     actual_home_margin - frozen_pregame_home_margin

   Team attribution is symmetric:
     home evidence = residual / 2
     away evidence = -residual / 2

   This ledger does not score Coaching / Staff and does not move the NFL model.
   ========================================================================== */
'use strict';

const SCHEMA = 'edgedesk_nfl_coaching_staff_ledger_v1';

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function r3(x) {
  return isNum(x) ? Math.round(x * 1000) / 1000 : null;
}

function newLedger() {
  return {
    schema: SCHEMA,
    pending: {},
    settled: {}
  };
}

function validGameId(row) {
  return row && row.game_id != null && String(row.game_id).length > 0
    ? String(row.game_id)
    : null;
}

function capture(ledger, row) {
  const id = validGameId(row);
  if (!ledger || ledger.schema !== SCHEMA) {
    return { captured: false, reason: 'invalid ledger' };
  }
  if (!id || !row.home_code || !row.away_code || !isNum(row.model_home_margin)) {
    return { captured: false, reason: 'game_id, teams and model_home_margin are required' };
  }
  if (ledger.settled[id]) {
    return { captured: false, reason: 'game is already settled', record: ledger.settled[id] };
  }
  if (ledger.pending[id]) {
    return { captured: false, reason: 'pregame projection is already frozen', record: ledger.pending[id] };
  }

  const rec = {
    game_id: id,
    season: row.season == null ? null : Number(row.season),
    week: row.week == null ? null : Number(row.week),
    kickoff: row.kickoff || null,
    home_code: row.home_code,
    away_code: row.away_code,
    pregame_home_margin: r3(row.model_home_margin),
    captured_at: row.captured_at || null,
    model_version: row.model_version || null,
    feature_version: row.feature_version || null,
    fingerprint: row.fingerprint || null
  };

  ledger.pending[id] = rec;
  return { captured: true, record: rec };
}

function settle(ledger, finalRow) {
  const id = validGameId(finalRow);
  if (!ledger || ledger.schema !== SCHEMA) {
    return { settled: false, reason: 'invalid ledger' };
  }
  if (!id) return { settled: false, reason: 'game_id is required' };
  if (ledger.settled[id]) {
    return { settled: false, reason: 'game is already settled', record: ledger.settled[id] };
  }

  const frozen = ledger.pending[id];
  if (!frozen) {
    return { settled: false, reason: 'no frozen pregame projection exists for this game' };
  }

  const hs = Number(finalRow.home_score);
  const as = Number(finalRow.away_score);
  if (!Number.isFinite(hs) || !Number.isFinite(as)) {
    return { settled: false, reason: 'final home_score and away_score are required' };
  }

  const actual = hs - as;
  const residual = actual - frozen.pregame_home_margin;
  const rec = Object.assign({}, frozen, {
    settled_at: finalRow.settled_at || null,
    home_score: hs,
    away_score: as,
    actual_home_margin: r3(actual),
    residual: r3(residual),
    team_evidence: {
      home: r3(residual / 2),
      away: r3(-residual / 2)
    }
  });

  delete ledger.pending[id];
  ledger.settled[id] = rec;
  return { settled: true, record: rec };
}

module.exports = {
  SCHEMA,
  newLedger,
  capture,
  settle
};
