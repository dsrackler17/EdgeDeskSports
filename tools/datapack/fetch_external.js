#!/usr/bin/env node
'use strict';
/* ===========================================================================
   The pack's files kept outside git (datapack/quant_v1/IMPORT.json
   `excluded_from_git`), re-fetched from their public source and accepted ONLY
   when the SHA-256 matches the pack's inventory.

   nflverse revises play-by-play in place. A download that no longer matches
   is REVISED_AT_SOURCE: it is not stored as the pack's file and nothing
   derived from the pack is recomputed from it — the pack's derived NFL
   tables were built from the earlier revision. A file the upload lacked
   (NFL 2022) stays MISSING unless the source still serves the exact bytes.

   Free source only (github.com release assets, through engine/http.js: cache,
   quota, breaker, bounded retries). One request per file, at most three.

   Run: node tools/datapack/fetch_external.js        (prints a JSON report)
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('../../engine/http');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'datapack', 'quant_v1');
const DEST = path.join(ROOT, '.cache', 'datapack', 'quant_v1');

const PROVIDERS = {
  github_release: { host: /^github\.com$/, paid: false, perRun: 6, perDay: 12, concurrency: 1, minIntervalMs: 1000 },
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchExternal(o) {
  o = o || {};
  const imp = JSON.parse(fs.readFileSync(path.join(o.pack || PACK, 'IMPORT.json'), 'utf8'));
  const dest = o.dest || DEST;
  const client = o.client || createClient({ cacheDir: path.join(ROOT, '.cache', 'http_datapack'), providers: PROVIDERS, retries: 2, log: (m) => console.error(m) });
  const out = [];
  for (const e of imp.excluded_from_git) {
    const target = path.join(dest, e.file);
    const r = { file: e.file, expected_sha256: e.sha256, source_url: e.source_url };
    if (fs.existsSync(target) && sha(fs.readFileSync(target)) === e.sha256) { out.push(Object.assign(r, { state: 'VERIFIED', from: 'cache' })); continue; }
    if (!e.source_url) { out.push(Object.assign(r, { state: 'MISSING', reason: 'no source' })); continue; }
    const res = await client.get(e.source_url, { ttlMs: 7 * 86400e3 });
    if (!res.ok) { out.push(Object.assign(r, { state: e.reason_code === 'EMPTY_UPLOAD' ? 'MISSING' : 'EXTERNAL', reason: 'fetch failed: ' + (res.error || res.status) })); continue; }
    const got = sha(res.body);
    if (got !== e.sha256) { out.push(Object.assign(r, { state: e.reason_code === 'EMPTY_UPLOAD' ? 'MISSING' : 'REVISED_AT_SOURCE', got_sha256: got, bytes: res.body.length, reason: 'the source now serves different bytes; not accepted as the pack file' })); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, res.body);
    out.push(Object.assign(r, { state: 'VERIFIED', from: 'source', bytes: res.body.length }));
  }
  return { schema: 'edgedesk_datapack_external_v1', checked_at: new Date(o.now ? o.now() : Date.now()).toISOString(), files: out };
}

if (require.main === module) {
  fetchExternal().then((r) => { console.log(JSON.stringify(r, null, 2)); }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
module.exports = { fetchExternal, PROVIDERS };
