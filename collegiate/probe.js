#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk collegiate — the probe: read a few real pages once, on a GitHub
   runner, so every collector is written against what the sites actually
   serve (this repository's own sandbox cannot reach them).

     node collegiate/probe.js            (reads collegiate/probe/targets.json)

   Every read goes through collegiate/polite.js: robots.txt first, one
   request at a time per host, 2 s apart, EdgeDeskBot by name, and a refusal
   is recorded (collegiate/data/refusals.jsonl) and respected. Each answer is
   kept gzipped under collegiate/probe/fixtures/<host>/ with an index
   (collegiate/probe/index.json): status, size, sha256, which platform the
   page looks built on, and why anything was not read.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createPolite } = require('./polite');

const DIR = path.join(__dirname, 'probe');
const FIX = path.join(DIR, 'fixtures');
const MAX_BYTES = 8 * 1024 * 1024;     /* whole pages: a roster's data sits at the end of the page */

/* what a page looks built on, from markers in its HTML (a guess the parsers confirm) */
function platformOf(html) {
  const h = String(html || '').slice(0, 400000).toLowerCase();
  if (/sidearmsports|sidearm-|sidearm\.|sidearm_/.test(h)) return 'sidearm';
  if (/prestosports|presto-sport/.test(h)) return 'presto';
  if (/wmt\.digital|wmt-|learfield|wmt_/.test(h)) return 'wmt';
  if (/__next_data__/.test(h)) return 'nextjs';
  if (/__nuxt__|window\.__nuxt/.test(h)) return 'nuxt';
  return null;
}
const slug = (u) => { const x = new URL(u); return ((x.pathname.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '_') || 'home') + (x.search ? '_' + crypto.createHash('sha1').update(x.search).digest('hex').slice(0, 8) : '')).slice(0, 80); };

async function main() {
  const T = JSON.parse(fs.readFileSync(path.join(DIR, 'targets.json'), 'utf8'));
  const hosts = new Set(T.schools.map((s) => s.host));
  for (const s of T.sources.concat(T.pages || [])) hosts.add(new URL(s.url).hostname.replace(/^www\./, ''));
  const polite = createPolite({ hosts: [...hosts], cacheDir: path.join(__dirname, '..', '.cache', 'collegiate_probe'), log: (m) => console.error(m) });
  const reads = [];
  const read = async (meta, url) => {
    const r = await polite.get(url, { ttlMs: 0 });
    const rec = Object.assign({}, meta, { url, ok: !!r.ok, status: r.status || null, refused: !!r.refused, error: r.error || null });
    if (r.ok && r.body) {
      const body = r.body.length > MAX_BYTES ? r.body.subarray(0, MAX_BYTES) : r.body;
      const host = new URL(url).hostname.replace(/^www\./, '');
      const file = path.join(FIX, host, slug(url) + '.gz');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, zlib.gzipSync(body));
      Object.assign(rec, { bytes: r.body.length, truncated: r.body.length > MAX_BYTES, sha256: crypto.createHash('sha256').update(r.body).digest('hex'),
        fixture: path.relative(path.join(__dirname, '..'), file), platform: platformOf(body.toString('utf8')) });
    }
    console.error((rec.ok ? 'ok   ' : 'no   ') + url + (rec.error ? '  (' + rec.error.message + ')' : rec.platform ? '  [' + rec.platform + ']' : ''));
    reads.push(rec);
  };
  for (const s of T.sources) await read({ kind: 'source', name: s.name }, s.url);
  /* named pages (a season's roster, a schedule), each school's own in order */
  const work = T.schools.map((s) => ({ host: s.host, list: T.paths.map((p) => [{ kind: 'school', name: s.name, host: s.host, path: p }, 'https://' + s.host + p]) }));
  for (const pg of T.pages || []) {
    const host = new URL(pg.url).hostname.replace(/^www\./, '');
    let w = work.find((x) => x.host === host);
    if (!w) work.push(w = { host, list: [] });
    w.list.push([{ kind: 'page', name: pg.name, host }, pg.url]);
  }
  await Promise.all(work.map(async (w) => { for (const [meta, url] of w.list) await read(meta, url); }));
  const out = { schema: 'edgedesk_collegiate_probe_v1', generated_at: new Date().toISOString(), user_agent: polite.UA,
    summary: { reads: reads.length, ok: reads.filter((r) => r.ok).length, refused: reads.filter((r) => r.refused).length,
      platforms: reads.filter((r) => r.platform).reduce((a, r) => (a[r.platform] = (a[r.platform] || 0) + 1, a), {}) },
    refusals: polite.refusals(), reads };
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify(out, null, 1) + '\n');
  console.error('[probe] ' + out.summary.ok + '/' + out.summary.reads + ' read, ' + out.summary.refused + ' refused; platforms ' + JSON.stringify(out.summary.platforms));
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { platformOf, slug };
