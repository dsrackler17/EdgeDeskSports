/* ============================================================================
   FSIE — the one download door for the engine's source files.

   Why not football/data/recovery.js: its session reads every body as text,
   and the two feeds this engine needs are binary (nflverse .csv.gz, the ESPN
   play-by-play .parquet). The rules are the same ones recovery.js enforces:
     - retries on transient failures only (timeouts, 408/425/429/5xx), with
       exponential backoff; a 403 or 404 is an answer and is never retried;
     - the cache-freshness rule of football/data/feed_cache.js (a completed
       season is permanent, the season in progress is re-fetched);
     - a stale cache is served only when the network refuses, and says so;
     - every file is recorded in a manifest with its URL, sha256, size,
       Last-Modified and retrieval time — the source fingerprint every
       imported observation carries.
   The transport is injectable, so the tests drive the real retry path.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FC = require(path.join(__dirname, '..', '..', 'data', 'feed_cache.js'));

const ROOT = path.join(__dirname, '..', '..', '..');
const CACHE = process.env.FSIE_CACHE || path.join(ROOT, 'football', 'situational', '.cache');
const RETRYABLE = { 408: 1, 425: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function manifestFile(dir) { return path.join(dir || CACHE, 'manifest.json'); }
function readManifest(dir) { try { return JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8')); } catch (_) { return { schema: 'edgedesk_fsie_source_manifest_v1', files: {} }; } }
function writeManifest(m, dir) {
  fs.mkdirSync(dir || CACHE, { recursive: true });
  const f = manifestFile(dir); const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, f);
}
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

async function defaultTransport(url, timeoutMs) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'EdgeDesk-fsie (+https://edgedesksports.com)' }, signal: AbortSignal.timeout(timeoutMs) });
  const lm = r.headers && r.headers.get ? r.headers.get('last-modified') : null;
  if (!r.ok) return { status: r.status, buf: null, last_modified: lm };
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), last_modified: lm };
}

/* -> { ok, file, from: network|cache|stale-cache, url, sha256, bytes, last_modified,
        retrieved_at, attempts, error, status } */
async function getFile(url, name, opts) {
  opts = opts || {};
  const dir = opts.cache_dir || CACHE;
  const file = path.join(dir, 'raw', name.replace(/[^a-z0-9._-]+/gi, '_'));
  const min = opts.min_bytes || 256;
  const man = readManifest(dir);
  const prev = man.files[name] || null;
  const tries = Math.max(1, (opts.retries == null ? 4 : opts.retries) + 1);
  let wait = opts.backoff_ms == null ? 1000 : opts.backoff_ms;
  if (!opts.force && (opts.offline || FC.usable(file, name, opts.season, min))) {
    if (fs.existsSync(file) && fs.statSync(file).size > min) {
      return Object.assign({ ok: true, file, from: 'cache', url, attempts: 0, error: null }, prev || { sha256: sha256File(file), bytes: fs.statSync(file).size });
    }
    if (opts.offline) return { ok: false, file: null, from: 'offline', url, error: 'offline and not cached', attempts: 0 };
  }
  const transport = opts.transport || defaultTransport;
  let last = { status: null, error: null };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await transport(url, opts.timeout_ms || 300000);
      if (r.status >= 200 && r.status < 300 && r.buf && r.buf.length > min) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.part-' + process.pid;
        fs.writeFileSync(tmp, r.buf); fs.renameSync(tmp, file);
        const rec = { url, sha256: crypto.createHash('sha256').update(r.buf).digest('hex'), bytes: r.buf.length,
          last_modified: r.last_modified || null, retrieved_at: new Date().toISOString() };
        const m = readManifest(dir); m.files[name] = rec; writeManifest(m, dir);
        return Object.assign({ ok: true, file, from: 'network', attempts: attempt, error: null, status: r.status,
          changed: !prev || prev.sha256 !== rec.sha256 }, rec);
      }
      last = { status: r.status, error: r.buf && r.buf.length <= min ? 'body too small' : 'HTTP ' + r.status };
      if (!RETRYABLE[r.status] || attempt === tries) break;
    } catch (e) {
      last = { status: null, error: String((e && e.name === 'TimeoutError') ? 'timeout' : ((e && e.message) || e)).slice(0, 160) };
      if (attempt === tries) break;
    }
    await sleep(wait); wait *= 2;
  }
  if (fs.existsSync(file) && fs.statSync(file).size > min) {
    return Object.assign({ ok: true, file, from: 'stale-cache', url, attempts: tries, error: last.error || 'refetch failed', status: last.status }, prev || { sha256: sha256File(file), bytes: fs.statSync(file).size });
  }
  return { ok: false, file: null, from: 'network', url, attempts: tries, error: last.error, status: last.status };
}

/* bounded concurrency: never more than `limit` downloads in flight */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

module.exports = { getFile, mapLimit, readManifest, sha256File, CACHE, ROOT };
