#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk — an in-memory stand-in for the PostgREST client, for tests.

   It answers the same calls tools/<sport>/db.js answers (select, selectAll,
   upsert, insert, patch, del, rpc) with the same PostgREST query grammar the
   jobs write (eq / neq / gt / gte / lt / lte / in / is / like, order, limit,
   offset), keeps the same conflict semantics (merge-duplicates writes only the
   columns present; ignore-duplicates skips a hit), and implements the live
   lock the way the SQL does, including its TTL. That is enough to drive a sync
   and a poller end to end, twice, and count rows.

   It is NOT the database. Constraints, triggers, row-level security and the
   real lock statement are tested against a real PostgreSQL by the *_sql.test.js
   suites; this only stands in for the transport.

   The UFC copy (tools/ufc/fake_db.js) predates this one and is exercised by
   its own committed suites; it is deliberately left where it is rather than
   refactored underneath passing tests.
   =========================================================================== */
'use strict';

function parseQuery(q) {
  const out = { filters: [], order: null, limit: null, offset: 0, select: null };
  String(q || '').split('&').forEach(part => {
    if (!part) return;
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = decodeURIComponent(part.slice(0, i)), v = decodeURIComponent(part.slice(i + 1));
    if (k === 'select') out.select = v;
    else if (k === 'order') { const m = /^([a-z_]+)\.(asc|desc)/.exec(v); out.order = m ? { col: m[1], dir: m[2] } : { col: v.split('.')[0], dir: 'asc' }; }
    else if (k === 'limit') out.limit = Number(v);
    else if (k === 'offset') out.offset = Number(v);
    else if (k === 'on_conflict') out.onConflict = v;
    else {
      const m = /^(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s.exec(v);
      if (!m) return;
      let val = m[2];
      if (m[1] === 'in') val = val.replace(/^\(|\)$/g, '').split(',').map(x => x.trim().replace(/^"|"$/g, ''));
      out.filters.push({ col: k, op: m[1], val });
    }
  });
  return out;
}

function cmp(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a), nb = Number(b);
  if (isFinite(na) && isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb;
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}

/* PostgREST spells the multi-character wildcard '*' in a like filter and hands
   SQL '%'; '_' stays SQL's single-character wildcard. */
function likeRe(pat) {
  const esc = String(pat).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/[*%]/g, '.*').replace(/_/g, '.') + '$');
}

function matches(row, f) {
  const v = row[f.col];
  switch (f.op) {
    case 'eq': return String(v) === String(f.val);
    case 'neq': return String(v) !== String(f.val);
    case 'gt': return v != null && cmp(v, f.val) > 0;
    case 'gte': return v != null && cmp(v, f.val) >= 0;
    case 'lt': return v != null && cmp(v, f.val) < 0;
    case 'lte': return v != null && cmp(v, f.val) <= 0;
    case 'in': return f.val.some(x => String(x) === String(v));
    case 'is': return f.val === 'null' ? v == null : (f.val === 'true' ? v === true : v === false);
    case 'like': return v != null && likeRe(f.val).test(String(v));
    case 'ilike': return v != null && likeRe(String(f.val).toLowerCase()).test(String(v).toLowerCase());
    default: return true;
  }
}

/* opts.lockArg   — the RPC's lock-identity argument ('p_event_id', 'p_lock_key')
   opts.serialTables — tables whose rows get a synthetic id on insert */
function fakePgrest(seed, opts) {
  opts = opts || {};
  const lockArg = opts.lockArg || 'p_lock_key';
  const serial = new Set(opts.serialTables || []);
  const tables = {};
  const stats = { requests: 0, failures: 0, writes: 0, lastLatencyMs: 1 };
  const locks = {};
  let nowFn = () => new Date().toISOString();
  function tbl(schema, rel) { const k = schema + '.' + rel; return tables[k] || (tables[k] = []); }
  if (seed) Object.keys(seed).forEach(k => { tables[k] = seed[k].map(r => Object.assign({}, r)); });

  function query(schema, rel, q) {
    const p = parseQuery(q);
    let rows = tbl(schema, rel).filter(r => p.filters.every(f => matches(r, f)));
    if (p.order) rows = rows.slice().sort((a, b) => { const c = cmp(a[p.order.col], b[p.order.col]); return p.order.dir === 'desc' ? -c : c; });
    if (p.offset) rows = rows.slice(p.offset);
    if (p.limit != null) rows = rows.slice(0, p.limit);
    return rows.map(r => Object.assign({}, r));
  }

  const api = {
    stats, tables, locks,
    setNow(fn) { nowFn = fn; },
    count(schema, rel) { return tbl(schema, rel).length; },
    rows(schema, rel) { return tbl(schema, rel).map(r => Object.assign({}, r)); },
    async select(schema, rel, q) { stats.requests++; return query(schema, rel, q); },
    async selectAll(schema, rel, q) { stats.requests++; return query(schema, rel, q); },
    async upsert(schema, rel, rows, onConflict, o) {
      o = o || {}; stats.requests++; stats.writes++;
      const keys = String(onConflict || '').split(',').map(s => s.trim()).filter(Boolean);
      const t = tbl(schema, rel), out = [];
      rows.forEach(r => {
        const hit = keys.length ? t.find(x => keys.every(k => String(x[k]) === String(r[k]))) : null;
        if (hit) {
          if (o.ignoreDuplicates) return;
          Object.keys(r).forEach(k => { hit[k] = r[k]; });
          hit.updated_at = nowFn();
          out.push(Object.assign({}, hit));
        } else {
          const row = Object.assign({}, r);
          if (row.updated_at == null) row.updated_at = nowFn();
          if (serial.has(rel)) row.id = row.id || t.length + 1;
          t.push(row); out.push(Object.assign({}, row));
        }
      });
      return out;
    },
    async insert(schema, rel, rows) { return api.upsert(schema, rel, rows, null, {}); },
    async patch(schema, rel, q, patch) {
      stats.requests++; stats.writes++;
      const p = parseQuery(q), out = [];
      tbl(schema, rel).forEach(r => { if (p.filters.every(f => matches(r, f))) { Object.assign(r, patch); r.updated_at = nowFn(); out.push(Object.assign({}, r)); } });
      return out;
    },
    async del(schema, rel, q) {
      stats.requests++; stats.writes++;
      const p = parseQuery(q), t = tbl(schema, rel);
      const keep = t.filter(r => !p.filters.every(f => matches(r, f)));
      t.length = 0; keep.forEach(r => t.push(r));
      return [];
    },
    async rpc(schema, fn, args) {
      stats.requests++;
      const now = Date.parse(nowFn());
      const key = args[lockArg];
      if (fn === 'acquire_live_lock') {
        const ttl = Math.max(10, args.p_ttl_seconds || 120), l = locks[key];
        if (!l || l.owner === args.p_owner || l.expires < now) {
          locks[key] = { owner: args.p_owner, expires: now + ttl * 1000, acquired_at: (l && l.owner === args.p_owner) ? l.acquired_at : now };
          return { acquired: true, owner: args.p_owner, expires_at: new Date(now + ttl * 1000).toISOString() };
        }
        return { acquired: false, reason: 'held', owner: l.owner, expires_at: new Date(l.expires).toISOString() };
      }
      if (fn === 'release_live_lock') {
        const l = locks[key];
        if (l && l.owner === args.p_owner) { delete locks[key]; return true; }
        return false;
      }
      throw new Error('unknown rpc ' + fn);
    }
  };
  return api;
}

module.exports = { fakePgrest, parseQuery, matches, cmp };
