#!/usr/bin/env node
/* ============================================================================
   PULL PUBLISHED DESK ARTICLES INTO THE STORE THE BUILD READS.

   NO SECRET. It reads the public view desk_published with the anon key every
   page already ships. The view returns published articles only, so this job
   cannot leak a draft even if it tried.

   A WITHDRAWN ARTICLE LEAVES. A record whose article is no longer published
   is removed from the store, and the clean build removes its page. That only
   happens after a SUCCESSFUL read: a network failure keeps the committed
   store exactly as it was, so an outage delays a change rather than
   unpublishing everything.

     node tools/desk/sync.js            # report what would change
     node tools/desk/sync.js --write    # write it
   ========================================================================== */
'use strict';
const STORE = require('./store.js');

const SB_URL = process.env.EDART_SB_URL || 'https://iattxbkbufslbauoumga.supabase.co';
const SB_KEY = process.env.EDART_SB_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
const WRITE = process.argv.indexOf('--write') >= 0;

async function fetchPublished(fetchImpl) {
  const f = fetchImpl || fetch;
  const r = await f(SB_URL + '/rest/v1/desk_published?select=*&order=published_at.desc&limit=500',
    { headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY } });
  if (!r.ok) throw new Error('desk_published HTTP ' + r.status);
  return r.json();
}

async function sync(opts) {
  opts = opts || {};
  const write = opts.write != null ? opts.write : WRITE;
  let rows;
  try { rows = await fetchPublished(opts.fetch); }
  catch (e) { console.log('desk sync: could not read desk_published (' + (e && e.message || e) + '); the committed store is unchanged'); return { ok: false, changed: 0 }; }
  const live = new Set(), report = [];
  rows.forEach(row => {
    const rec = STORE.toRecord(row);
    live.add(rec.slug);
    if (write) { if (STORE.save(rec, opts.dir)) report.push('write  ' + rec.slug); }
    else report.push('would write ' + rec.slug);
  });
  STORE.loadPublished(opts.dir).forEach(rec => {
    if (!live.has(rec.slug)) {
      if (write) { STORE.remove(rec.slug, opts.dir); report.push('remove ' + rec.slug + ' (no longer published)'); }
      else report.push('would remove ' + rec.slug);
    }
  });
  report.forEach(l => console.log('  ' + l));
  console.log('desk sync: ' + rows.length + ' published desk article(s), ' + report.length + ' change(s)' + (write ? '' : ' (dry run)'));
  return { ok: true, changed: report.length, published: rows.length };
}

if (require.main === module) sync().then(r => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
module.exports = { sync, fetchPublished };
