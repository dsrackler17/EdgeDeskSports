'use strict';
/* ===========================================================================
   EdgeDesk NHL — source files in, rows out.

   fetchSource(url, {ttlMs}) downloads one source file through the guarded
   client (engine/http.js: cache, revalidation, quota, breaker, retries) and
   returns its local path with provenance { url, sha256, fetched_at, stale }.

   parquetRows(file, columns) streams the requested columns of a parquet file
   through hockey/tools/parquet_select.py (pyarrow) and yields plain objects.
   A requested column the file lacks arrives as null and is listed in
   `missing` — it is never filled with a default.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { createClient } = require('../../engine/http');
const C = require('../config');

let client = null;
function http(opts) {
  if (!client) client = createClient(Object.assign({ cacheDir: C.PATHS.http, log: (m) => console.error(m) }, opts || {}));
  return client;
}
function setClient(c) { client = c; }

async function fetchSource(url, o) {
  o = o || {};
  const res = await http().get(url, { ttlMs: o.ttlMs == null ? 6 * 3600e3 : o.ttlMs });
  if (!res.ok) return { ok: false, url, error: res.error, status: res.status };
  fs.mkdirSync(C.PATHS.cacheSrc, { recursive: true });
  const name = o.name || path.basename(new URL(url).pathname);
  const file = path.join(C.PATHS.cacheSrc, name);
  const sha = crypto.createHash('sha256').update(res.body).digest('hex');
  let same = false;
  try { same = fs.statSync(file).size === res.body.length && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha; } catch (_) {}
  if (!same) fs.writeFileSync(file, res.body);
  return { ok: true, url, file, sha256: sha, bytes: res.body.length, fetched_at: res.fetchedAt, stale: !!res.stale, from_cache: !!res.fromCache, warning: res.error || null };
}

/* RFC4180-ish line splitter for pyarrow's CSV output (quotes doubled inside quoted fields) */
function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function coerce(v) {
  if (v === '' || v === 'NA' || v === 'null') return null;
  if (v === 'true') return true; if (v === 'false') return false;
  return v;
}

/** async iterator of row objects; `onMissing(cols)` hears the columns the file lacks */
async function* parquetRows(file, columns, onMissing) {
  const py = spawn('python3', [C.PATHS.pyHelper, file, '-', columns.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  py.stderr.on('data', (d) => { stderr += d.toString(); });
  const done = new Promise((res) => py.on('close', (code) => res(code)));
  const rl = readline.createInterface({ input: py.stdout, crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = splitCsv(line); continue; }
    if (!line) continue;
    const f = splitCsv(line); const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = coerce(f[i]);
    yield o;
  }
  const code = await done;
  const m = /missing columns: (.*)/.exec(stderr);
  if (m && onMissing) onMissing(m[1].trim().split(','));
  if (code !== 0) throw new Error('parquet_select failed (' + code + '): ' + stderr.slice(0, 400));
}

async function parquetAll(file, columns) {
  const rows = []; let missing = [];
  for await (const r of parquetRows(file, columns, (m) => { missing = m; })) rows.push(r);
  return { rows, missing };
}

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }
function bool(v) { return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1'; }

module.exports = { http, setClient, fetchSource, parquetRows, parquetAll, splitCsv, num, bool };
