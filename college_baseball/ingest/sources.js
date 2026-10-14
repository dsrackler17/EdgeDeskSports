'use strict';
/* ===========================================================================
   EdgeDesk college baseball — source files in, through the guarded client.

   Every download goes through engine/lab/fetch.js (engine/http.js: TTL
   cache, ETag revalidation, quotas, circuit breaker, bounded retries) and is
   recorded with provenance { url, sha256, bytes, fetched_at }. Only
   raw.githubusercontent.com is used: a free, keyless host already registered
   with the engine. No paid provider can be reached from here.

   Parquet is read through hockey/tools/parquet_select.py (pyarrow), the same
   bridge basketball and hockey use. A column the file does not have arrives
   as null and is reported as missing — never filled with a default.
   =========================================================================== */
const fs = require('fs');
const { fetchFile } = require('../../engine/lab/fetch');
const io = require('../../hockey/lib/io');
const { parseCsv } = require('../../engine/csv');

const PROVENANCE = [];

async function get(url, o) {
  const res = await fetchFile(url, Object.assign({ ttlMs: 24 * 3600e3 }, o || {}));
  PROVENANCE.push({ url, ok: res.ok, sha256: res.sha256 || null, bytes: res.bytes || null, fetched_at: res.fetched_at || null,
    not_found: !!res.not_found, stale: !!res.stale, offline: !!res.offline, error: res.ok ? null : String(res.error || res.status || 'error') });
  return res;
}

/** all rows of the requested columns of a parquet URL; {ok, rows, missing, prov} */
async function parquet(url, columns, o) {
  const res = await get(url, o);
  if (!res.ok) return { ok: false, rows: [], missing: columns, prov: res };
  const rows = []; let missing = [];
  for await (const r of io.parquetRows(res.file, columns, (m) => { missing = m; })) rows.push(r);
  return { ok: true, rows, missing, prov: res };
}

/** streaming variant for the large files (play-by-play, box scores) */
async function parquetEach(url, columns, fn, o) {
  const res = await get(url, o);
  if (!res.ok) return { ok: false, n: 0, missing: columns, prov: res };
  let n = 0; let missing = [];
  for await (const r of io.parquetRows(res.file, columns, (m) => { missing = m; })) { fn(r); n++; }
  return { ok: true, n, missing, prov: res };
}

/** a CSV URL as objects (values stay strings) */
async function csv(url, o) {
  const res = await get(url, o);
  if (!res.ok) return { ok: false, rows: [], prov: res };
  const rows = parseCsv(fs.readFileSync(res.file, 'utf8'));
  if (!rows.length) return { ok: true, rows: [], prov: res };
  const header = rows[0];
  return { ok: true, rows: rows.slice(1).filter((r) => r.length > 1).map((r) => { const o2 = {}; header.forEach((h, i) => { o2[h] = r[i] === undefined ? '' : r[i]; }); return o2; }), prov: res };
}

module.exports = { get, parquet, parquetEach, csv, PROVENANCE };
