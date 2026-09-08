#!/usr/bin/env node
/* ============================================================================
   THE SYNC, AGAINST A STUB POSTGREST.

   sync.js is the join between two halves that never met: publication is
   decided in a browser and written to public.site_articles, and the public
   page is a committed static file built from articles/data/records/. It is
   also the job that can OVERWRITE committed work, so what it refuses matters
   more than what it copies.

   A stub server rather than the real project: the behaviour under test is
   this file's merge and validation logic, and pointing it at production
   would make the suite depend on what happens to be published today. The
   PostgREST shape it consumes is one URL and one JSON array, reproduced here
   exactly.

   Run: node tools/articles/sync.test.js
   ========================================================================== */
'use strict';
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STORE = require('./store.js');
const MODEL = require('./article_model.js');

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('  × ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : ''));
}
function done() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | article sync | ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

const base = STORE.published()[0];
if (!base) { console.log('SKIP | article sync | nothing published in the store to build fixtures from'); process.exit(0); }

let ROWS = [];
let HITS = 0;
const srv = http.createServer((req, res) => {
  HITS++;
  if (req.url.indexOf('/rest/v1/site_articles') !== 0) { res.writeHead(404); return res.end('[]'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(ROWS));
});

srv.listen(0, '127.0.0.1', async () => {
  process.env.EDART_SB_URL = 'http://127.0.0.1:' + srv.address().port;
  process.env.EDART_SB_KEY = 'stub';
  const SYNC = require('./sync.js');

  function row(rec, over) {
    return Object.assign({
      id: rec.id, slug: rec.slug, status: 'published',
      published_at: rec.published_at, updated_at: rec.updated_at,
      generated_at: rec.generated_at, article: MODEL.compact(rec)
    }, over || {});
  }
  const later = () => new Date(Date.now() + 60000).toISOString();
  const clone = () => JSON.parse(JSON.stringify(base));

  try {
    /* ---- what it copies ------------------------------------------------- */
    const fresh = clone();
    fresh.id = 'cfb-synctest'; fresh.slug = 'sync-stub-vs-sync-stub-2026';
    fresh.canonical_url = MODEL.SITE + '/articles/' + fresh.slug;
    fresh.updated_at = later();
    ROWS = [row(fresh)];
    let r = await SYNC.main();
    chk('a row published from a browser reaches the store',
      r.written.length === 1 && r.written[0].was === 'new', JSON.stringify(r.written));
    chk('and it is reported by slug, not silently',
      r.written[0].slug === fresh.slug, JSON.stringify(r.written));

    /* ---- what it refuses ------------------------------------------------ */
    const stale = clone();
    stale.updated_at = '2020-01-01T00:00:00.000Z';
    ROWS = [row(stale)];
    r = await SYNC.main();
    chk('an older remote row never clobbers newer committed work',
      r.written.length === 0 && r.skipped.length === 1 && /newer/.test(r.skipped[0].why),
      JSON.stringify(r.skipped));

    const gutted = clone(); gutted.updated_at = later(); delete gutted.research;
    ROWS = [row(gutted)];
    r = await SYNC.main();
    chk('a row carrying no research is refused — the page could not be rendered from it',
      r.written.length === 0 && /no research/.test(r.skipped[0].why), JSON.stringify(r.skipped));

    ROWS = [row(base, { id: 'cfb-someone-else' })];
    r = await SYNC.main();
    chk('a row whose id disagrees with its payload is refused',
      r.written.length === 0 && /disagree/.test(r.skipped[0].why), JSON.stringify(r.skipped));

    const bad = clone(); bad.updated_at = later(); bad.seo_description = 'too short';
    ROWS = [row(bad)];
    r = await SYNC.main();
    chk('a published row that fails its own publication checks is refused',
      r.written.length === 0 && /failing/.test(r.skipped[0].why), JSON.stringify(r.skipped));

    const empty = clone(); empty.updated_at = later();
    ROWS = [row(empty, { article: null })];
    r = await SYNC.main();
    chk('a row with no payload at all is refused',
      r.written.length === 0 && /no article payload/.test(r.skipped[0].why), JSON.stringify(r.skipped));

    /* ---- and it writes nothing without being told to -------------------- */
    chk('every case above was a dry run and touched no file',
      STORE.load('cfb-synctest') === null, 'a record was written without --write');

    /* ---- an unreachable table is not a failed build --------------------- */
    const port = srv.address().port;
    await new Promise(res => srv.close(res));
    r = await SYNC.main();
    chk('an unreachable table degrades to a note, not a failure',
      r.reachable === false && r.written.length === 0, JSON.stringify(r));
    chk('the stub was actually being reached before that', HITS > 0, String(HITS));
    void port;
  } catch (e) {
    fail++; console.log('  × the harness threw — ' + (e && e.stack || e));
  }
  try { srv.close(); } catch (_) {}
  done();
});
