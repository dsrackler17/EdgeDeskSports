#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the PROVIDER CONTRACTS.

   WHY THIS FILE EXISTS. The historical archive EdgeDesk holds is CC BY-NC-SA:
   research only. It will have to be replaced by a licensed feed before any
   paid tennis surface ships, and the point of this layer is that replacing it
   is a configuration change rather than a rewrite. Nothing downstream of here
   — not the importer, not the feature builder, not the model, not the board,
   not the AI — ever sees a provider's own payload. They see the NORMALISED
   shapes below, and those shapes are the contract.

   FIVE CONTRACTS, one per kind of thing a tennis product needs:

     HistoricalTennisProvider   settled matches, with whatever pre-match
                                context the source carries
     LiveResultsProvider        fixtures, live state and final results
     RankingsProvider           the official ranking tables
     OddsProvider               prices, by book, by market, at a moment
     WeatherProvider            conditions at a venue, with their precision

   WHAT AN ADAPTER MUST DO, and what it must never do:

     MUST  return the normalised shape, or throw. A field the source does not
           carry is null and is NAMED in `unmapped`. It is never invented and
           never defaulted to zero.
     MUST  declare its source_key, which must be registered in
           tennis.source_licenses. An unregistered source cannot write.
     MUST  be pure with respect to the database: an adapter reads its source
           and returns rows. It does not write. The job that called it writes.
     NEVER expose a provider id, a provider field name, or a provider-specific
           status string to anything downstream.
     NEVER delete. A provider that stops mentioning a match has not un-played
           it; see `deletionPolicy` below.

   THE SOURCE PRIORITY RULE. Two sources will disagree — a score corrected in
   one and not the other, a ranking published a day apart. `priority` decides
   which is written, and the loser is NOT discarded: it is recorded as a
   source_conflict data-quality issue with both observations, because a
   disagreement between two feeds is information about the feeds.
   =========================================================================== */
'use strict';

const M = require('../../../lib/tennis_model.js');

/* Higher wins. A licensed feed outranks a public scoreboard, which outranks a
   community archive. Changing this is a deliberate act with a comment. */
const SOURCE_PRIORITY = {
  licensed_feed: 100,
  odds_api: 90,
  espn: 50,
  archive: 30,
  open_meteo: 20,
  'open-meteo': 20
};
function priorityOf(sourceKey) {
  return SOURCE_PRIORITY[sourceKey] != null ? SOURCE_PRIORITY[sourceKey] : 10;
}

/* A provider NEVER deletes. This is the rule written down so an adapter author
   cannot decide otherwise: a feed that omits a match has not un-played it, and
   history that disappears because a vendor had a bad morning is the failure
   mode this whole layer exists to prevent. */
const deletionPolicy = {
  mayDelete: false,
  reason: 'A source omitting a record is not evidence the record is false. '
        + 'Absence is recorded as a data-quality observation; the row stays.'
};

/* ─────────────────────────── normalised shapes ────────────────────────── */
/* These are DESCRIPTIONS, not classes: the adapters are plain functions and
   the shapes are validated rather than constructed, so an adapter written in
   any style still has to produce the same thing. */

const SHAPES = {
  match: {
    required: ['source_key', 'tour', 'source_tourney_id', 'match_num', 'match_date'],
    optional: ['tourney_name', 'surface', 'level', 'round', 'best_of', 'winner_source_id',
               'loser_source_id', 'winner_name', 'loser_name', 'score', 'minutes',
               'winner_rank', 'loser_rank', 'retirement', 'walkover', 'source_updated_at']
  },
  fixture: {
    required: ['source_key', 'match_ref', 'tour', 'scheduled_at'],
    optional: ['tournament_ref', 'tournament_name', 'surface', 'environment', 'round',
               'best_of', 'player_a_source_id', 'player_b_source_id', 'player_a_name',
               'player_b_name', 'status', 'is_doubles']
  },
  ranking: {
    required: ['source_key', 'tour', 'source_player_id', 'rank', 'as_of'],
    optional: ['points', 'player_name', 'movement']
  },
  odds: {
    required: ['source_key', 'match_ref', 'sportsbook', 'market_type', 'selection', 'captured_at'],
    optional: ['event_id', 'tour', 'line', 'odds_american', 'odds_decimal', 'implied_prob',
               'no_vig_prob', 'market_state', 'market_status', 'selection_source_id', 'book_trusted']
  },
  weather: {
    required: ['source_key', 'observed_on', 'temporal_precision'],
    optional: ['venue_ref', 'tournament_ref', 'temp_mean_f', 'temp_max_f', 'temp_min_f',
               'humidity_mean_pct', 'precip_in', 'wind_mean_mph', 'gust_max_mph',
               'solar_mj_m2', 'days_covered', 'venue_confidence', 'quality', 'window_start', 'window_end']
  }
};

/* Validate one normalised row against its shape. Returns {ok, missing, unknown}.
   A row that fails is REPORTED, not silently dropped: an adapter producing the
   wrong shape is a bug worth seeing on the run summary. */
function validate(kind, row) {
  const shape = SHAPES[kind];
  if (!shape) return { ok: false, missing: ['<unknown shape ' + kind + '>'], unknown: [] };
  const missing = shape.required.filter((k) => row[k] == null);
  const known = new Set(shape.required.concat(shape.optional).concat(['unmapped', 'raw_ref']));
  const unknown = Object.keys(row).filter((k) => !known.has(k));
  return { ok: missing.length === 0, missing, unknown };
}

/* The base every adapter is built on. It gives an adapter its identity, its
   licence gate and its normalisation helpers, and it refuses to let one write
   under a source key it did not declare. */
function defineProvider(spec) {
  const required = ['kind', 'name', 'source_key'];
  required.forEach((k) => { if (!spec[k]) throw new Error('a provider must declare ' + k); });
  const kinds = ['historical', 'live_results', 'rankings', 'odds', 'weather'];
  if (kinds.indexOf(spec.kind) < 0) throw new Error('unknown provider kind: ' + spec.kind);

  return Object.assign({
    kind: spec.kind,
    name: spec.name,
    source_key: spec.source_key,
    priority: spec.priority != null ? spec.priority : priorityOf(spec.source_key),
    /* What this provider CANNOT do. Stated by the adapter, surfaced by the job,
       shown on the page. "EdgeDesk does not have this" is a fact worth
       publishing; a silent null is not. */
    capabilities: Object.assign({
      pre_match_features: false, serve_statistics: false, exact_start_time: false,
      live_score: false, closing_price: false, doubles: false
    }, spec.capabilities || {}),
    credentials: spec.credentials || [],
    /* True when every credential this adapter needs is present. A provider
       that cannot run says so; it never half-runs and it never invents. */
    ready(env) {
      const e = env || process.env;
      return (spec.credentials || []).every((k) => String(e[k] || '').trim().length > 0);
    },
    missingCredentials(env) {
      const e = env || process.env;
      return (spec.credentials || []).filter((k) => !String(e[k] || '').trim().length);
    },
    deletionPolicy: deletionPolicy,
    validate: (row) => validate(({ historical: 'match', live_results: 'fixture', rankings: 'ranking',
                                   odds: 'odds', weather: 'weather' })[spec.kind], row)
  }, spec);
}

/* ─────────────────────────── conflict resolution ──────────────────────── */

/* Two observations of the same fact from two sources. Returns which one to
   write and what to record about the disagreement. The loser is never thrown
   away: `conflict` is written to tennis.data_quality_issues. */
function resolveConflict(a, b, fields) {
  const pa = priorityOf(a.source_key), pb = priorityOf(b.source_key);
  const winner = pa === pb
    ? (Date.parse(a.source_updated_at || 0) >= Date.parse(b.source_updated_at || 0) ? a : b)
    : (pa > pb ? a : b);
  const loser = winner === a ? b : a;
  const differing = (fields || Object.keys(a)).filter((f) => {
    const x = a[f], y = b[f];
    if (x == null || y == null) return false;
    return String(x) !== String(y);
  });
  return {
    winner, loser,
    reason: pa === pb ? 'same priority — newer source_updated_at wins' : 'source priority',
    conflict: differing.length ? {
      issue_type: 'source_conflict',
      detail: `${a.source_key} and ${b.source_key} disagree on ${differing.join(', ')}`,
      payload: { a: { source: a.source_key, values: pick(a, differing) },
                 b: { source: b.source_key, values: pick(b, differing) },
                 chosen: winner.source_key }
    } : null
  };
}
function pick(o, keys) { const r = {}; keys.forEach((k) => { r[k] = o[k]; }); return r; }

/* ─────────────────────────── the cursor ───────────────────────────────── */

/* INCREMENTAL INGESTION, expressed once.

   A feed is read forward from the last successful cursor, MINUS an overlap
   window. The overlap is not paranoia: results get corrected, a retirement
   gets reclassified, a ranking is republished. Without it the one thing an
   incremental feed is worst at — corrections — would never arrive.

   The cursor only advances on SUCCESS. A failed run leaves it where it was, so
   the next run re-reads the same window rather than stepping over it. */
const DEFAULT_OVERLAP_HOURS = { historical: 24 * 14, live_results: 48, rankings: 24 * 8, odds: 6, weather: 24 * 30 };

function nextWindow(kind, lastSuccessAt, now, overlapHours) {
  const end = now instanceof Date ? now : new Date(now || Date.now());
  const overlap = (overlapHours != null ? overlapHours : DEFAULT_OVERLAP_HOURS[kind] || 24) * 3600 * 1000;
  if (!lastSuccessAt) {
    /* No cursor: the caller decides how far back a cold start reaches. This
       returns null rather than guessing "all of history", because a cold start
       that silently re-reads 1968 is a surprise nobody wants at 3am. */
    return { from: null, to: end, cold_start: true, overlap_hours: overlap / 3600000 };
  }
  const last = lastSuccessAt instanceof Date ? lastSuccessAt : new Date(lastSuccessAt);
  return { from: new Date(last.getTime() - overlap), to: end, cold_start: false,
           overlap_hours: overlap / 3600000 };
}

/* Has this record MATERIALLY changed? Only a material change triggers the
   expensive downstream work (recomputing a player's features and every later
   match they played). A source that rewrites `updated_at` on every poll must
   not cost a full recompute. */
const MATERIAL_FIELDS = ['score', 'winner_source_id', 'loser_source_id', 'minutes', 'retirement',
                         'walkover', 'surface', 'round', 'best_of', 'winner_rank', 'loser_rank',
                         'match_date', 'rank', 'points'];
function materiallyChanged(existing, incoming, fields) {
  const keys = fields || MATERIAL_FIELDS;
  const changed = [];
  keys.forEach((k) => {
    if (!(k in incoming)) return;
    const a = existing == null ? null : existing[k];
    const b = incoming[k];
    if (a == null && b == null) return;
    if (String(a == null ? '' : a) !== String(b == null ? '' : b)) changed.push(k);
  });
  return { changed: changed.length > 0, fields: changed };
}

module.exports = {
  SHAPES, SOURCE_PRIORITY, MATERIAL_FIELDS, DEFAULT_OVERLAP_HOURS,
  priorityOf, deletionPolicy, validate, defineProvider,
  resolveConflict, nextWindow, materiallyChanged,
  M
};
