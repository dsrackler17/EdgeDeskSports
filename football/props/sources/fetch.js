/* ============================================================================
   PLAYER PROPS — the one cached download door for the prop pipeline.

   Public, keyless release assets only (nflverse, sportsdataverse). A completed
   season's file is permanent in the cache; the season in progress is reused
   only inside football/data/feed_cache.js's short window, so a scheduled run
   always refetches what can still change. A failed refetch serves the previous
   download and SAYS so (from: 'stale-cache'); no download and no cache is an
   honest { ok:false }, never an empty dataset dressed as a real one.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const FC = require('../../data/feed_cache.js');
const C = require('../config.js');

function cacheFile(name) { return path.join(C.CACHE, name.replace(/[^a-z0-9._-]+/gi, '_')); }

async function download(url, timeoutMs) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'EdgeDesk-props-sync (+https://edgedesksports.com)' }, signal: AbortSignal.timeout(timeoutMs || 120000) });
  if (!r.ok) { const e = new Error('HTTP ' + r.status + ' ' + url); e.status = r.status; throw e; }
  return Buffer.from(await r.arrayBuffer());
}

/* -> { ok, buf, from: network|cache|stale-cache, retrieved_at, url, error } */
async function getBuffer(url, name, opts) {
  opts = opts || {};
  const file = cacheFile(name);
  const min = opts.min_bytes || 64;
  if (!opts.force && (opts.offline || FC.usable(file, name, opts.season, min))) {
    try { const st = fs.statSync(file); if (st.size > min) return { ok: true, buf: fs.readFileSync(file), from: 'cache', retrieved_at: new Date(st.mtimeMs).toISOString(), url }; } catch (_) { /* not cached */ }
    if (opts.offline) return { ok: false, buf: null, from: 'offline', error: 'offline and not cached', url };
  }
  try {
    const buf = await (opts.download || download)(url, opts.timeout_ms);
    if (!buf || buf.length <= min) throw new Error('empty body');
    fs.mkdirSync(C.CACHE, { recursive: true });
    fs.writeFileSync(file, buf);
    return { ok: true, buf, from: 'network', retrieved_at: new Date().toISOString(), url };
  } catch (e) {
    try { const st = fs.statSync(file); if (st.size > min) return { ok: true, buf: fs.readFileSync(file), from: 'stale-cache', retrieved_at: new Date(st.mtimeMs).toISOString(), url, error: e.message }; } catch (_) { /* nothing */ }
    return { ok: false, buf: null, from: 'network', error: e.message, status: e.status || null, url };
  }
}
async function getText(url, name, opts) {
  const r = await getBuffer(url, name, opts);
  if (!r.ok) return r;
  let buf = r.buf;
  if (/\.gz$/.test(url) || (buf[0] === 0x1f && buf[1] === 0x8b)) { try { buf = zlib.gunzipSync(buf); } catch (e) { return Object.assign({}, r, { ok: false, error: 'gunzip failed: ' + e.message }); } }
  return Object.assign({}, r, { text: buf.toString('utf8'), buf: undefined });
}

/* A fast CSV reader for large files: only the named columns are kept. Quoted
   fields (with commas and doubled quotes) are handled; a newline inside a
   quoted field is not expected in these feeds and is treated as a row end
   only outside quotes. */
function readCsv(text, columns) {
  const out = [];
  const s = String(text || '');
  let i = 0; const n = s.length;
  function nextRow() {
    const row = []; let field = '', q = false;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (q) {
        if (c === 34) { if (s.charCodeAt(i + 1) === 34) { field += '"'; i += 2; continue; } q = false; i++; continue; }
        const j = s.indexOf('"', i); if (j < 0) { field += s.slice(i); i = n; break; }
        field += s.slice(i, j); i = j; continue;
      }
      if (c === 34) { q = true; i++; continue; }
      if (c === 44) { row.push(field); field = ''; i++; continue; }
      if (c === 10 || c === 13) { if (c === 13 && s.charCodeAt(i + 1) === 10) i++; i++; row.push(field); return row; }
      let j = i; while (j < n) { const d = s.charCodeAt(j); if (d === 44 || d === 10 || d === 13 || d === 34) break; j++; }
      field += s.slice(i, j); i = j;
    }
    if (field.length || row.length) { row.push(field); return row; }
    return null;
  }
  const head = nextRow() || [];
  const idx = (columns || head).map((c) => head.indexOf(c));
  const names = columns || head;
  let row;
  while ((row = nextRow()) !== null) {
    if (row.length < 2) continue;
    const o = {};
    for (let k = 0; k < names.length; k++) { const v = idx[k] >= 0 ? row[idx[k]] : undefined; o[names[k]] = v === undefined ? '' : v; }
    out.push(o);
  }
  out.header = head;
  return out;
}
function NUM(v) { if (v == null || v === '' || v === 'NA' || v === 'NaN') return null; const x = +v; return isFinite(x) ? x : null; }
function STR(v) { return v == null || v === '' || v === 'NA' ? null : String(v); }

/* parquet → rows through the repo's pyarrow helper (football/data/tools) */
function parquetRows(buf, name) {
  const { execFileSync } = require('child_process');
  const tmp = cacheFile(name);
  fs.mkdirSync(C.CACHE, { recursive: true });
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size !== buf.length) fs.writeFileSync(tmp, buf);
  const helper = path.join(C.ROOT, 'football', 'data', 'tools', 'parquet_to_csv.py');
  const text = execFileSync('python3', [helper, tmp], { maxBuffer: 1 << 30 }).toString('utf8');
  return readCsv(text);
}

module.exports = { getBuffer, getText, readCsv, parquetRows, NUM, STR, cacheFile };
