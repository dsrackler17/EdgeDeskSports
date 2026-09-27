/* ============================================================================
   A VALUE WITH ITS PROVENANCE.

   Every important field the enrichment layer publishes — a starting
   quarterback, an injury status, a venue, a forecast, a spread, a depth-chart
   slot, a player rating, a team rating — travels as a lineage record:

     { value, source, source_type, tier, observed_at, retrieved_at,
       confirmation, ttl_hours, age_hours, stale, stale_reason, carried,
       raw_evidence_reference }

   observed_at   when the world said it (a report's publication time, a game's
                 kickoff for a box score). The clock freshness is judged on.
   retrieved_at  when EdgeDesk read it. Re-reading an unchanged value renews
                 THIS clock and never the other one.

   A value without provenance is not refused — it is trusted less, and says
   so: `provenance: 'INCOMPLETE'` and a trust factor of half.
   ========================================================================== */
'use strict';

const C = require('../config.js');

function ms(t) {
  if (t == null || t === '') return null;
  const x = typeof t === 'number' ? t : Date.parse(t);
  return isFinite(x) ? x : null;
}
function iso(t) { const x = ms(t); return x == null ? null : new Date(x).toISOString(); }
function hoursBetween(a, b) { const x = ms(a), y = ms(b); return (x == null || y == null) ? null : (y - x) / 3600e3; }
function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }

/* make(value, o) — o: {source, source_type, tier, observed_at, retrieved_at,
   confirmation, kind (a CACHE kind for its TTL), ttl_hours, carried,
   carried_reason, ref, now} */
function make(value, o) {
  o = o || {};
  const kind = o.kind && C.CACHE[o.kind] ? C.CACHE[o.kind] : null;
  const ttl = o.ttl_hours != null ? o.ttl_hours : (kind ? kind.ttl : null);
  const observed = iso(o.observed_at), retrieved = iso(o.retrieved_at);
  const age = o.now != null ? hoursBetween(observed || retrieved, o.now) : null;
  const stale = !!(o.stale || (ttl != null && age != null && age > ttl));
  const complete = !!(o.source && (observed || retrieved));
  return {
    value: value === undefined ? null : value,
    source: o.source || null,
    source_type: o.source_type || null,
    tier: o.tier == null ? null : o.tier,
    observed_at: observed,
    retrieved_at: retrieved,
    confirmation: o.confirmation || null,
    ttl_hours: ttl,
    age_hours: r1(age),
    stale: stale,
    stale_reason: stale ? (o.stale_reason || (age != null && ttl != null
      ? 'observed ' + r1(age) + 'h ago, past its ' + ttl + 'h freshness window' : 'marked stale by its source')) : null,
    carried: !!o.carried,
    carried_reason: o.carried ? (o.carried_reason || 'the last refresh failed; this is the last value EdgeDesk actually observed') : null,
    provenance: complete ? 'COMPLETE' : 'INCOMPLETE',
    raw_evidence_reference: o.ref || null
  };
}

/* trust(rec) 0..1 — how much a record may count, from its source weight, its
   freshness and whether its provenance is complete. A stale or carried
   record is never trusted as a fresh one. */
function trust(rec) {
  if (!rec) return 0;
  const st = rec.source_type && C.SOURCE_TYPES[rec.source_type];
  let w = st ? st.weight : 0.5;
  if (rec.stale) w *= 0.5;
  if (rec.carried && !rec.stale) w *= 0.85;
  if (rec.provenance !== 'COMPLETE') w *= 0.5;
  return Math.round(w * 1000) / 1000;
}

/* a lineage record from an input-contract row (football/matchup/contract.js
   row(): {field, side, state, source, as_of, observed_at, detail}) */
function fromContractRow(row, now, kind) {
  if (!row) return make(null, { source: null, now });
  return make(row.detail || row.state, { source: row.source, source_type: null,
    observed_at: row.observed_at || row.as_of, retrieved_at: row.as_of, confirmation: row.state,
    kind, now, stale: row.state === 'STALE', ref: 'input contract ' + row.field + (row.side ? ':' + row.side : '') });
}

module.exports = { make, trust, fromContractRow, ms, iso, hoursBetween, r1 };
