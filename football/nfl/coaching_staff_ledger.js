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
const EVIDENCE_SCHEMA = 'edgedesk_nfl_coaching_staff_current_residual_v1';

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
    home_head_coach: row.home_head_coach || null,
    away_head_coach: row.away_head_coach || null,
    pregame_home_margin: r3(row.model_home_margin),
    captured_at: row.captured_at || null,
    model_version: row.model_version || null,
    feature_version: row.feature_version || null,
    fingerprint: row.fingerprint || null
  };

  ledger.pending[id] = rec;
  return { captured: true, record: rec };
}

function summarizeCurrentResidual(ledger, opts) {
  opts = opts || {};
  const season = opts.season == null ? null : Number(opts.season);
  const requested = Array.isArray(opts.teamKeys) ? opts.teamKeys.map(String) : null;
  const teams = {};

  function blank(code) {
    return {
      team: code,
      available: false,
      value: null,
      observations: 0,
      total_evidence: null,
      mean_evidence: null,
      game_ids: [],
      source: 'frozen pregame residual ledger',
      reason: 'no settled frozen pregame residual evidence'
    };
  }

  if (requested) requested.forEach((code) => { teams[code] = blank(code); });

  if (!ledger || ledger.schema !== SCHEMA || !ledger.settled) {
    return {
      schema: EVIDENCE_SCHEMA,
      season,
      input: 'current_residual_conversion',
      teams,
      error: 'invalid ledger'
    };
  }

  const sums = {};
  Object.keys(ledger.settled).sort().forEach((id) => {
    const rec = ledger.settled[id];
    if (!rec) return;
    if (season != null && Number(rec.season) !== season) return;

    const pairs = [
      [rec.home_code, rec.team_evidence && rec.team_evidence.home],
      [rec.away_code, rec.team_evidence && rec.team_evidence.away]
    ];

    pairs.forEach(([code, evidence]) => {
      if (!code || !isNum(evidence)) return;
      code = String(code);
      if (requested && !requested.includes(code)) return;
      if (!teams[code]) teams[code] = blank(code);
      if (!sums[code]) sums[code] = 0;
      sums[code] += evidence;
      teams[code].observations += 1;
      teams[code].game_ids.push(String(rec.game_id || id));
    });
  });

  Object.keys(teams).forEach((code) => {
    const row = teams[code];
    if (!row.observations) return;
    row.total_evidence = r3(sums[code]);
    row.mean_evidence = r3(sums[code] / row.observations);
    row.value = row.mean_evidence;
    row.available = true;
    row.reason = null;
  });

  return {
    schema: EVIDENCE_SCHEMA,
    season,
    input: 'current_residual_conversion',
    teams
  };
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
  EVIDENCE_SCHEMA,
  newLedger,
  capture,
  settle,
  summarizeCurrentResidual
};
