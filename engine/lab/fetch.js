'use strict';
/* ===========================================================================
   EdgeDesk lab — one source file in, through the guarded client.

   fetchFile(url, {ttlMs, offline}) downloads a public file through
   engine/http.js (cache, ETag revalidation, quota, breaker, bounded retries)
   and returns its local copy with provenance { url, sha256, bytes,
   fetched_at, stale }. Offline (or LAB_OFFLINE=1) uses the cached copy only.
   A 404 is reported as `not_found` — for a season the source has not
   published yet that is a fact, not an error.

   Only free, keyless hosts are registered (raw.githubusercontent.com via the
   engine's defaults). Nothing here can reach a paid provider.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('../http');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, '.cache', 'lab_src');
let client = null;
function http() {
  if (!client) client = createClient({ cacheDir: path.join(ROOT, '.cache', 'lab_http'), log: (m) => console.error(m) });
  return client;
}
function setClient(c) { client = c; }

function localName(url) {
  const u = new URL(url);
  return u.pathname.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function fetchFile(url, o) {
  o = o || {};
  const file = path.join(SRC, localName(url));
  const offline = o.offline || process.env.LAB_OFFLINE === '1';
  if (offline) {
    if (!fs.existsSync(file)) return { ok: false, url, offline: true, error: 'OFFLINE_MISSING' };
    const buf = fs.readFileSync(file);
    return { ok: true, url, file, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, fetched_at: fs.statSync(file).mtime.toISOString(), offline: true };
  }
  const res = await http().get(url, { ttlMs: o.ttlMs == null ? 12 * 3600e3 : o.ttlMs });
  if (!res.ok) {
    const nf = res.status === 404 || (res.error && /404/.test(String(res.error.code || res.error)));
    return { ok: false, url, status: res.status, not_found: nf, error: res.error || res.status };
  }
  fs.mkdirSync(SRC, { recursive: true });
  const sha = crypto.createHash('sha256').update(res.body).digest('hex');
  let same = false;
  try { same = fs.statSync(file).size === res.body.length && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha; } catch (_) {}
  if (!same) fs.writeFileSync(file, res.body);
  return { ok: true, url, file, sha256: sha, bytes: res.body.length, fetched_at: res.fetchedAt, stale: !!res.stale, from_cache: !!res.fromCache };
}

module.exports = { fetchFile, setClient, http, SRC };
