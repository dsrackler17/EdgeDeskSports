#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — as-of pitching features, in JavaScript.

   The same features supabase/mlb_pitcher_features.sql computes as a view,
   computed here from the dataset rows so the evaluation can run with no
   database at all. tools/mlb/features.test.js asserts the two agree field for
   field on a real PostgreSQL, because two implementations that quietly drift
   are worse than one.

   THE ONE INVARIANT. A feature row for (player, season S) is built from that
   pitcher's seasons STRICTLY EARLIER than S. Not "usually earlier", not
   "earlier after a filter" — the slice is taken at index i and everything it
   reads comes from indices below i. That is what makes a walk-forward
   evaluation over these features honest, and it is the property the tests
   attack directly.

   2020 IS LABELLED, NOT RESCALED. A 60-game season is a third of a year's
   innings; multiplying it by 2.7 would invent innings nobody threw. Every row
   says whether 2020 is in its window and what share of the baseline's workload
   came from it, and the caller decides.
   =========================================================================== */
'use strict';

const M = require('../../lib/mlb_pitcher_history.js');

const BASE_SEASONS = 3;   // the multi-year baseline window, in OBSERVED seasons

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function div(a, b) { const x = num(a), y = num(b); return (x == null || y == null || y === 0) ? null : x / y; }
function sub(a, b) { const x = num(a), y = num(b); return (x == null || y == null) ? null : x - y; }

/**
 * Feature rows for one pitcher's career, in season order.
 * `seasons` is that pitcher's pitcher_seasons rows, any order.
 */
function featuresForPitcher(seasons) {
  const rows = (seasons || []).slice().sort((a, b) => num(a.season) - num(b.season));
  return rows.map((cur, i) => {
    const prior = i >= 1 ? rows[i - 1] : null;
    const prior2 = i >= 2 ? rows[i - 2] : null;
    /* The baseline frame: up to three rows ENDING ONE SHORT of the current
       one. `rows.slice(max(0, i-3), i)` cannot include index i. */
    const base = rows.slice(Math.max(0, i - BASE_SEASONS), i);

    const sum = (k) => base.reduce((a, r) => a + (num(r[k]) ?? 0), 0);
    const baseOuts = base.length ? sum('outs') : null;
    const baseBf = base.length ? sum('batters_faced') : null;
    const rated = base.filter((r) => num(r.performance_index) != null && num(r.outs) != null);
    const idxDen = rated.reduce((a, r) => a + num(r.outs), 0);
    const idxNum = rated.reduce((a, r) => a + num(r.performance_index) * num(r.outs), 0);
    const base2020 = base.reduce((a, r) => a + (num(r.season) === 2020 ? (num(r.outs) ?? 0) : 0), 0);
    const baseGames = base.length ? sum('games') : null;
    const baseStarts = base.length ? sum('starts') : null;

    return {
      player_id: num(cur.player_id), player_name: cur.player_name, season: num(cur.season),
      position_reported: cur.position_reported ?? null,

      /* the season being predicted. NEVER a feature. */
      outcome_role: cur.role ?? null,
      outcome_outs: num(cur.outs),
      outcome_era: num(cur.era), outcome_fip: num(cur.fip), outcome_whip: num(cur.whip),
      outcome_k_pct: num(cur.k_pct), outcome_bb_pct: num(cur.bb_pct),
      outcome_k_minus_bb_pct: num(cur.k_minus_bb_pct),
      outcome_performance_index: num(cur.performance_index),
      outcome_provisional: cur.provisional === true,

      seasons_before: i,
      first_season_before: i ? num(rows[0].season) : null,
      prior_season: prior ? num(prior.season) : null,
      prior_gap: prior ? num(cur.season) - num(prior.season) - 1 : null,
      prior_era: prior ? num(prior.era) : null,
      prior_fip: prior ? num(prior.fip) : null,
      prior_whip: prior ? num(prior.whip) : null,
      prior_k_pct: prior ? num(prior.k_pct) : null,
      prior_bb_pct: prior ? num(prior.bb_pct) : null,
      prior_k_minus_bb_pct: prior ? num(prior.k_minus_bb_pct) : null,
      prior_performance_index: prior ? num(prior.performance_index) : null,
      prior_outs: prior ? num(prior.outs) : null,
      prior_games: prior ? num(prior.games) : null,
      prior_starts: prior ? num(prior.starts) : null,
      prior_role: prior ? (prior.role ?? null) : null,
      prior_teams: prior ? (prior.teams ?? null) : null,
      prior_age: prior ? num(prior.age) : null,
      prior_era_minus_fip: prior ? sub(prior.era, prior.fip) : null,
      prior_innings: prior ? div(prior.outs, 3) : null,

      trend_k_pct: (prior && prior2) ? sub(prior.k_pct, prior2.k_pct) : null,
      trend_bb_pct: (prior && prior2) ? sub(prior.bb_pct, prior2.bb_pct) : null,
      trend_k_minus_bb_pct: (prior && prior2) ? sub(prior.k_minus_bb_pct, prior2.k_minus_bb_pct) : null,
      trend_era: (prior && prior2) ? sub(prior.era, prior2.era) : null,
      workload_change_outs: (prior && prior2) ? sub(prior.outs, prior2.outs) : null,
      workload_change_pct: (prior && prior2 && num(prior2.outs)) ? div(sub(prior.outs, prior2.outs), prior2.outs) : null,

      role_changed_before: (prior && prior2 && prior.role != null && prior2.role != null)
        ? (prior.role !== prior2.role) : null,
      team_changed_before: (prior && prior2 && prior.teams != null && prior2.teams != null)
        ? (String(prior.teams) !== String(prior2.teams)) : null,
      prior_season_was_split: prior && prior.teams != null ? String(prior.teams).indexOf(';') >= 0 : null,

      base_seasons: base.length,
      base_outs: baseOuts,
      base_innings: baseOuts == null ? null : baseOuts / 3,
      base_era: baseOuts ? 27 * sum('earned_runs') / baseOuts : null,
      base_whip: baseOuts ? 3 * (sum('walks') + sum('hits')) / baseOuts : null,
      base_k_per_9: baseOuts ? 27 * sum('strikeouts') / baseOuts : null,
      base_bb_per_9: baseOuts ? 27 * sum('walks') / baseOuts : null,
      base_hr_per_9: baseOuts ? 27 * sum('home_runs') / baseOuts : null,
      base_k_pct: baseBf ? sum('strikeouts') / baseBf : null,
      base_bb_pct: baseBf ? sum('walks') / baseBf : null,
      base_k_minus_bb_pct: baseBf ? (sum('strikeouts') - sum('walks')) / baseBf : null,
      base_performance_index: idxDen ? idxNum / idxDen : null,
      base_start_share: baseGames ? baseStarts / baseGames : null,

      prior_is_2020: prior ? (num(prior.season) === 2020) : null,
      outcome_is_2020: num(cur.season) === 2020,
      base_outs_from_2020: base2020,
      base_share_from_2020: baseOuts ? base2020 / baseOuts : null
    };
  });
}

/** Feature rows for every pitcher in a loaded dataset (or any season rows). */
function buildFeatures(seasonRows) {
  const byPlayer = new Map();
  (seasonRows || []).forEach((r) => {
    const id = num(r.player_id);
    if (id == null) return;
    if (!byPlayer.has(id)) byPlayer.set(id, []);
    byPlayer.get(id).push(r);
  });
  const out = [];
  for (const rows of byPlayer.values()) out.push(...featuresForPitcher(rows));
  out.sort((a, b) => (a.season - b.season) || (a.player_id - b.player_id));
  return out;
}

/**
 * League-wide values per season and role, computed from COUNTING STATISTICS.
 * Used as the "what would you guess knowing nothing about this pitcher"
 * reference, and only ever read for seasons strictly before a target.
 */
function leagueByRole(seasonRows, opts) {
  opts = opts || {};
  const minOuts = opts.minOuts ?? 0;
  const acc = new Map();
  (seasonRows || []).forEach((r) => {
    if ((num(r.outs) ?? 0) < minOuts) return;
    if (opts.pitchersOnly !== false && r.position_reported && r.position_reported !== 'P') return;
    const role = r.role || 'unknown';
    const key = `${num(r.season)}|${role}`;
    if (!acc.has(key)) acc.set(key, { season: num(r.season), role, outs: 0, earned_runs: 0, hits: 0,
      walks: 0, strikeouts: 0, home_runs: 0, batters_faced: 0, n: 0 });
    const a = acc.get(key);
    ['outs', 'earned_runs', 'hits', 'walks', 'strikeouts', 'home_runs', 'batters_faced']
      .forEach((k) => { a[k] += num(r[k]) ?? 0; });
    a.n++;
  });
  const out = new Map();
  for (const a of acc.values()) {
    out.set(`${a.season}|${a.role}`, {
      season: a.season, role: a.role, n: a.n, outs: a.outs,
      era: a.outs ? 27 * a.earned_runs / a.outs : null,
      whip: a.outs ? 3 * (a.walks + a.hits) / a.outs : null,
      k_pct: a.batters_faced ? a.strikeouts / a.batters_faced : null,
      bb_pct: a.batters_faced ? a.walks / a.batters_faced : null,
      k_minus_bb_pct: a.batters_faced ? (a.strikeouts - a.walks) / a.batters_faced : null
    });
  }
  return out;
}

module.exports = { BASE_SEASONS, featuresForPitcher, buildFeatures, leagueByRole, M };
