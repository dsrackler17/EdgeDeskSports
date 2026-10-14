'use strict';
/* ===========================================================================
   EdgeDesk NBA — source files in, rows out.

   fetchSource(url, {ttlMs, offline}) downloads one public source file through
   the guarded client (engine/http.js: cache, revalidation, quota, breaker,
   bounded retries) into .cache/nba_src and returns its provenance
   { url, file, sha256, bytes, fetched_at, stale }. Offline (or NBA_OFFLINE=1)
   uses the cached copy only. A 404 is `not_found`: for a season the source
   has not published yet that is a fact, not an error.

   Parquet is read through the NHL engine's column-selecting pyarrow helper
   (hockey/tools/parquet_select.py, via hockey/lib/io.parquetRows): a requested
   column the file lacks arrives as null and is listed in `missing` — never
   filled with a default.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('../../engine/http');
const HIO = require('../../hockey/lib/io');
const C = require('../config');

let client = null;
function http() {
  if (!client) client = createClient({ cacheDir: C.PATHS.http, log: (m) => console.error(m) });
  return client;
}
function setClient(c) { client = c; }

function localName(url) { return new URL(url).pathname.replace(/^\/+/, '').split('/').slice(-1)[0]; }

async function fetchSource(url, o) {
  o = o || {};
  const file = path.join(C.PATHS.cacheSrc, localName(url));
  const offline = o.offline || process.env.NBA_OFFLINE === '1';
  if (offline) {
    if (!fs.existsSync(file)) return { ok: false, url, offline: true, error: 'OFFLINE_MISSING' };
    const buf = fs.readFileSync(file);
    return { ok: true, url, file, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, fetched_at: fs.statSync(file).mtime.toISOString(), offline: true };
  }
  const res = await http().get(url, { ttlMs: o.ttlMs == null ? 6 * 3600e3 : o.ttlMs });
  if (!res.ok) {
    const nf = res.status === 404 || (res.error && /404/.test(String(res.error.code || res.error)));
    return { ok: false, url, status: res.status, not_found: nf, error: res.error || res.status };
  }
  fs.mkdirSync(C.PATHS.cacheSrc, { recursive: true });
  const sha = crypto.createHash('sha256').update(res.body).digest('hex');
  let same = false;
  try { same = fs.statSync(file).size === res.body.length && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha; } catch (_) {}
  if (!same) fs.writeFileSync(file, res.body);
  return { ok: true, url, file, sha256: sha, bytes: res.body.length, fetched_at: res.fetchedAt, stale: !!res.stale, from_cache: !!res.fromCache };
}

/** async iterator of row objects; `onMissing(cols)` hears the columns the file lacks */
async function* parquetRows(file, columns, onMissing) {
  const { spawn } = require('child_process');
  const readline = require('readline');
  const py = spawn('python3', [C.PATHS.pyHelper, file, '-', columns.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  py.stderr.on('data', (d) => { stderr += d.toString(); });
  const done = new Promise((res) => py.on('close', (code) => res(code)));
  const rl = readline.createInterface({ input: py.stdout, crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header) { header = HIO.splitCsv(line); continue; }
    if (!line) continue;
    const f = HIO.splitCsv(line); const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = coerce(f[i]);
    yield o;
  }
  const code = await done;
  const m = /missing columns: (.*)/.exec(stderr);
  if (m && onMissing) onMissing(m[1].trim().split(','));
  if (code !== 0) throw new Error('parquet_select failed (' + code + '): ' + stderr.slice(0, 400));
}
function coerce(v) {
  if (v === undefined || v === '' || v === 'NA' || v === 'null') return null;
  if (v === 'true') return true; if (v === 'false') return false;
  return v;
}
async function parquetAll(file, columns) {
  const rows = []; let missing = [];
  for await (const r of parquetRows(file, columns, (m) => { missing = m; })) rows.push(r);
  return { rows, missing };
}
const num = HIO.num;
const bool = HIO.bool;

/* gzip JSON work files (.cache/nba_work): large derived tables that are rebuilt, not committed */
const zlib = require('zlib');
function writeWork(name, obj) {
  fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
  fs.writeFileSync(path.join(C.PATHS.cacheWork, name), zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
}
function readWork(name, dflt) {
  const f = path.join(C.PATHS.cacheWork, name);
  if (!fs.existsSync(f)) return dflt === undefined ? null : dflt;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
}
function hasWork(name) { return fs.existsSync(path.join(C.PATHS.cacheWork, name)); }
/* the same, one JSON value per line, streamed: for row sets larger than one
   JavaScript string can hold (the props rows are ~10^6 player-games) */
async function writeWorkLines(name, head, rows) {
  fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
  const file = path.join(C.PATHS.cacheWork, name), tmp = file + '.tmp';
  const gz = zlib.createGzip(), out = fs.createWriteStream(tmp); gz.pipe(out);
  const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.on('error', rej); });
  const write = (s) => new Promise((res) => (gz.write(s) ? res() : gz.once('drain', res)));
  await write(JSON.stringify(head) + '\n');
  let buf = [];
  for (const r of rows) { buf.push(JSON.stringify(r)); if (buf.length >= 2000) { await write(buf.join('\n') + '\n'); buf = []; } }
  if (buf.length) await write(buf.join('\n') + '\n');
  gz.end(); await done; fs.renameSync(tmp, file);
}
async function readWorkLines(name) {
  const f = path.join(C.PATHS.cacheWork, name);
  if (!fs.existsSync(f)) return null;
  const rl = require('readline').createInterface({ input: fs.createReadStream(f).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let head = null; const rows = [];
  for await (const line of rl) { if (!line) continue; if (head === null) head = JSON.parse(line); else rows.push(JSON.parse(line)); }
  return { head, rows };
}

module.exports = { http, setClient, fetchSource, parquetRows, parquetAll, num, bool, writeWork, readWork, hasWork, writeWorkLines, readWorkLines };
