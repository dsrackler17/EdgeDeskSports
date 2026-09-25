/* ============================================================================
   THE EVIDENCE CACHE — what EdgeDesk last actually knew.

   Sports-data APIs fail. Yesterday's valid injury report does not stop being
   yesterday's valid injury report because today's request was refused. So
   every value the enrichment layer observes is kept here:

     key -> { kind, current: {value, source, observed_at, retrieved_at, digest},
              previous: {...} | null, ttl_hours, max_carry_hours,
              last_attempt_at, last_attempt_ok, last_error, changes }

   When a refresh fails, `recall()` hands back the last-known value WITH ITS
   ORIGINAL CLOCKS, marked `carried` and — once past its TTL — `stale`, with
   the reason. Past `max_carry` it is refused as HISTORICAL. A carried value is
   NEVER re-stamped as fresh: `retrieved_at` stays the time it was really read.

   The store is one committed JSON file (football/enrichment/cache/
   evidence_cache.json), so the scheduled CI run inherits the previous run's
   knowledge and a sandbox run with no network still knows what CI knew.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('../config.js');
const { ms, iso } = require('./lineage.js');

const SCHEMA = 'edgedesk_evidence_cache_v1';

function digest(v) { return crypto.createHash('sha1').update(JSON.stringify(v == null ? null : v)).digest('hex').slice(0, 16); }

function open(file) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { s = null; }
  if (!s || s.schema !== SCHEMA || !s.entries) s = { schema: SCHEMA, updated_at: null, entries: {} };
  Object.defineProperty(s, '_file', { value: file, enumerable: false, writable: true });
  Object.defineProperty(s, '_dirty', { value: false, enumerable: false, writable: true });
  return s;
}

function limits(kind) { return C.CACHE[kind] || { ttl: 24, max_carry: 168 }; }

/* store a freshly observed value. An unchanged value renews retrieved_at and
   keeps observed_at; a changed one rotates current -> previous. */
function put(store, key, kind, rec, now) {
  const L = limits(kind);
  const e = store.entries[key] || (store.entries[key] = { kind, current: null, previous: null, ttl_hours: L.ttl,
    max_carry_hours: L.max_carry, last_attempt_at: null, last_attempt_ok: null, last_error: null, changes: 0 });
  const d = digest(rec.value);
  const at = iso(now);
  if (e.current && e.current.digest === d) {
    e.current.retrieved_at = iso(rec.retrieved_at) || at;
  } else {
    if (e.current) { e.previous = e.current; e.changes++; }
    e.current = { value: rec.value, source: rec.source || null, observed_at: iso(rec.observed_at) || null,
      retrieved_at: iso(rec.retrieved_at) || at, digest: d };
  }
  e.kind = kind; e.ttl_hours = L.ttl; e.max_carry_hours = L.max_carry;
  e.last_attempt_at = at; e.last_attempt_ok = true; e.last_error = null;
  store._dirty = true;
  return e;
}

/* a refresh failed: record it, keep the value */
function fail(store, key, kind, error, now) {
  const L = limits(kind);
  const e = store.entries[key] || (store.entries[key] = { kind, current: null, previous: null, ttl_hours: L.ttl,
    max_carry_hours: L.max_carry, last_attempt_at: null, last_attempt_ok: null, last_error: null, changes: 0 });
  e.last_attempt_at = iso(now); e.last_attempt_ok = false; e.last_error = String(error || 'failed').slice(0, 200);
  store._dirty = true;
  return e;
}

/* the last-known value, judged at `now`:
   { found, value, source, observed_at, retrieved_at, age_hours, fresh, stale,
     historical, carried, reason } */
function recall(store, key, now) {
  const e = store.entries[key];
  if (!e || !e.current) return { found: false, reason: 'nothing was ever observed for ' + key };
  const cur = e.current;
  const t = ms(cur.observed_at) != null ? ms(cur.observed_at) : ms(cur.retrieved_at);
  const age = t == null ? null : (ms(now) - t) / 3600e3;
  const historical = age != null && age > e.max_carry_hours;
  const stale = !historical && age != null && age > e.ttl_hours;
  const carried = e.last_attempt_ok === false;
  let reason = null;
  if (historical) reason = 'the last value on file is ' + Math.round(age) + 'h old, past the ' + e.max_carry_hours + 'h it may be carried: HISTORICAL, not evidence';
  else if (stale) reason = 'observed ' + Math.round(age) + 'h ago, past its ' + e.ttl_hours + 'h freshness window' + (carried ? '; the last refresh failed (' + e.last_error + ')' : '');
  else if (carried) reason = 'the last refresh failed (' + e.last_error + '); this is the last value actually observed, still inside its freshness window';
  return { found: !historical, value: historical ? null : cur.value, source: cur.source, observed_at: cur.observed_at,
    retrieved_at: cur.retrieved_at, age_hours: age == null ? null : Math.round(age * 10) / 10,
    fresh: !historical && !stale, stale, historical, carried, reason,
    previous: e.previous ? { observed_at: e.previous.observed_at, retrieved_at: e.previous.retrieved_at } : null };
}

/* drop entries nobody has touched in `days` */
function prune(store, now, days) {
  const cut = ms(now) - (days || 120) * 86400e3;
  Object.keys(store.entries).forEach((k) => {
    const e = store.entries[k];
    const t = ms(e.last_attempt_at) || ms(e.current && e.current.retrieved_at);
    if (t != null && t < cut) { delete store.entries[k]; store._dirty = true; }
  });
}

function stats(store, now) {
  const out = { entries: 0, fresh: 0, stale: 0, historical: 0, carried: 0, by_kind: {} };
  Object.keys(store.entries).forEach((k) => {
    const r = recall(store, k, now), e = store.entries[k];
    const b = out.by_kind[e.kind] || (out.by_kind[e.kind] = { entries: 0, fresh: 0, stale: 0, historical: 0 });
    out.entries++; b.entries++;
    if (r.historical) { out.historical++; b.historical++; }
    else if (r.stale) { out.stale++; b.stale++; }
    else if (r.found) { out.fresh++; b.fresh++; }
    if (r.carried) out.carried++;
  });
  return out;
}

/* written only when something changed, keys sorted so a no-op run is a
   no-op diff */
function save(store, now) {
  if (!store._dirty) return false;
  store.updated_at = iso(now);
  const sorted = {};
  Object.keys(store.entries).sort().forEach((k) => { sorted[k] = store.entries[k]; });
  const out = { schema: SCHEMA, updated_at: store.updated_at,
    why: 'the last value EdgeDesk actually observed for each enrichment key, with its original clocks, so a run whose provider refuses carries it forward as STALE instead of forgetting it',
    entries: sorted };
  fs.mkdirSync(path.dirname(store._file), { recursive: true });
  fs.writeFileSync(store._file, JSON.stringify(out, null, 1) + '\n');
  store._dirty = false;
  return true;
}

module.exports = { SCHEMA, open, put, fail, recall, prune, stats, save, digest };
