#!/usr/bin/env node
/* ============================================================================
   PULL WHAT THE OPERATOR PUBLISHED INTO THE STORE THE BUILD READS.

   THE GAP THIS CLOSES. Publication state is decided in a browser — the
   article manager at /admin/articles, and the "Publish as article" button on
   a game brief — and written to public.site_articles. The public page is a
   committed static file built from articles/data/records/. Until this
   existed, those two halves never met: an operator could publish an article
   and the pipeline would never hear about it. store.js even claimed this file
   was here. It was not, which is the same defect the repository has been
   bitten by before (see supabase/README.md on `feedback.sql`).

   NO SECRET. It reads through the anon key every page already ships, and RLS
   returns published rows and nothing else — which is exactly the set that
   should become public pages. A draft is not merely skipped here, it is
   unreadable, so this job cannot leak one even if it tried.

   THE ROW CARRIES THE WHOLE RECORD. `site_articles.article` holds the compact
   record — research payload included — because the static build renders from
   that record. A row holding only the rendered half could not be rebuilt
   from, and a second source of numbers is the one thing this system refuses.

   WHICH SIDE WINS. Newer `updated_at` wins, and the losing side is reported
   rather than silently discarded. The pipeline's own generate.js refreshes a
   record only when the research actually moved, so a browser publish is
   almost always the newer of the two — but "almost always" is not a rule, and
   a rule is what a job that overwrites committed work needs.

     node tools/articles/sync.js            # report what would change
     node tools/articles/sync.js --write    # write it into the store
   ========================================================================== */
'use strict';
const path = require('path');
const STORE = require('./store.js');
const MODEL = require('./article_model.js');

/* The same project and the same public key every page ships. Overridable so a
   test can point at a stub, never so a secret can be supplied. */
const SB_URL = process.env.EDART_SB_URL || 'https://iattxbkbufslbauoumga.supabase.co';
const SB_KEY = process.env.EDART_SB_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const WRITE = !!arg('write', false);
const QUIET = !!arg('quiet', false);
function log(...a) { if (!QUIET) console.log(...a); }

const COLS = 'id,slug,status,published_at,updated_at,generated_at,article';

async function fetchPublished() {
  const url = SB_URL + '/rest/v1/site_articles?select=' + COLS
    + '&status=eq.published&order=updated_at.desc&limit=500';
  const r = await fetch(url, { headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const e = new Error('site_articles read ' + r.status + (body ? ': ' + body.slice(0, 200) : ''));
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* A row is only usable if it carries a record the build can render. A row
   whose payload is missing or shaped wrong is REPORTED, never guessed at:
   half an article is not a thing this publishes. */
function recordFrom(row) {
  const rec = row && row.article;
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'the row carries no article payload' };
  if (!rec.id || !rec.slug) return { ok: false, why: 'the payload has no id or slug' };
  if (!rec.research || !rec.research.kind) {
    return { ok: false, why: 'the payload carries no research, so the page could not be rendered from it' };
  }
  if (String(rec.id) !== String(row.id)) {
    return { ok: false, why: 'the row id and the payload id disagree (' + row.id + ' vs ' + rec.id + ')' };
  }
  /* the row's own columns are the authority on publication state: they are
     what the trigger and the operator actually wrote */
  const out = Object.assign({}, rec, {
    status: row.status, published_at: row.published_at || rec.published_at || null,
    updated_at: row.updated_at || rec.updated_at, generated_at: row.generated_at || rec.generated_at
  });
  const v = MODEL.publishable(MODEL.hydrate(out));
  if (!v.ok) return { ok: false, why: 'published but failing ' + v.failed.map(f => f.id).join(', ') };
  return { ok: true, rec: out };
}

async function main() {
  let rows = [];
  try {
    rows = await fetchPublished();
  } catch (e) {
    /* AN UNREACHABLE TABLE IS NOT A FAILED BUILD. The committed store is the
       one the build reads; this only adds to it. Saying so and carrying on is
       right, and going red would stop the research articles publishing over a
       feature that may not even be installed. */
    log('site_articles not read (' + (e && e.message) + ')');
    log('the committed store is unchanged; the build will publish what is already in it');
    return { read: 0, written: [], skipped: [], reachable: false };
  }

  const local = STORE.loadAll();
  const byId = Object.create(null);
  local.forEach(r => { byId[r.id] = r; });

  const written = [], skipped = [], unchanged = [];
  rows.forEach(row => {
    const got = recordFrom(row);
    if (!got.ok) { skipped.push({ id: row.id, slug: row.slug, why: got.why }); return; }
    const rec = got.rec;
    const have = byId[rec.id];
    if (have) {
      const a = Date.parse(rec.updated_at || 0) || 0;
      const b = Date.parse(have.updated_at || 0) || 0;
      if (b > a) {
        skipped.push({ id: rec.id, slug: rec.slug,
          why: 'the committed record is newer (' + have.updated_at + ' vs ' + rec.updated_at + ')' });
        return;
      }
      if (b === a && have.status === rec.status) { unchanged.push(rec.slug); return; }
    }
    if (WRITE) STORE.save(rec);
    written.push({ id: rec.id, slug: rec.slug, status: rec.status, was: have ? have.status : 'new' });
  });

  if (WRITE && written.length) STORE.saveIndex(STORE.loadAll());

  log(rows.length + ' published row(s) read · ' + written.length + ' into the store · '
    + unchanged.length + ' already current · ' + skipped.length + ' skipped'
    + (WRITE ? '' : ' (DRY RUN — pass --write)'));
  written.forEach(w => log('  ' + (w.was === 'new' ? 'new    ' : 'update ') + w.slug + '  → ' + w.status));
  skipped.forEach(sk => log('  skip   ' + (sk.slug || sk.id) + ' — ' + sk.why));
  return { read: rows.length, written, skipped, unchanged, reachable: true };
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => {
    console.error('sync failed: ' + (e && e.stack || e));
    process.exit(1);
  });
}
module.exports = { main, recordFrom, SB_URL };
