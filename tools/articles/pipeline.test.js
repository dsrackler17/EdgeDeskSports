#!/usr/bin/env node
/* ============================================================================
   THE ARTICLE PIPELINE, AGAINST THE REAL RESEARCH.

   articles.test.js holds the published pages against the committed records.
   This file holds the records against the RESEARCH TERMINAL: it boots the
   actual football module out of app.html, loads both boards, and asks the
   same two functions the terminal asks. What it is protecting is the one
   promise the whole system rests on — an article says what EdgeDesk says.

   PARITY IS ASSERTED AGAINST THE LIVE PAYLOAD, NOT AGAINST A FROZEN NUMBER.
   The ratings artifact rebuilds weekly and a captured quote ages out of
   freshness, so "the article still says Kansas +4.6 in March" is a test that
   fails for being right. What must hold forever is that whatever the research
   says today, the record and the rendered page say the same thing.

   IT DEGRADES HONESTLY. The two schedule feeds are public and keyless, but a
   build machine with no network cannot read them. When that happens the
   live-parity half reports SKIPPED and says which feed was missing, and the
   contract half — the exports this pipeline depends on, the feed URLs, the
   shape a replayed quote must have — still runs and still fails.

   Run: node tools/articles/pipeline.test.js            (cache or network)
        node tools/articles/pipeline.test.js --network  (allow downloads)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HOST = require('./research_host.js');
const MODEL = require('./article_model.js');
const RENDER = require('./article_render.js');
const STORE = require('./store.js');
const GEN = require('./generate.js');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

const NETWORK = process.argv.indexOf('--network') >= 0 || process.env.EDART_NETWORK === '1';

let pass = 0, fail = 0, skipped = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 260); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) { return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function has(hay, needle, name) { return chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + JSON.stringify(needle)); }
function skip(name, why) { skipped++; console.log('  SKIPPED: ' + name + ' — ' + why); }
function section(t) { console.log('\n' + t); }

/* ======================================================================== */
section('1. THE CONTRACT WITH app.html');
/* ======================================================================== */
/* The generator reaches the research through window. A function that stops
   being exported is unreachable from Node and the whole pipeline goes quiet
   rather than loud, so each door is asserted here by name. */
['window.fbBriefGame=fbBriefGame;', 'window.fbNflBriefGame=fbNflBriefGame;',
 'window.fbP4Load=fbP4Load;', 'window.fbP4Ensure=fbP4Ensure;'].forEach(x => {
  has(APP, x, 'app.html exports ' + x.replace('window.', '').split('=')[0]);
});
/* the two public feeds, asserted against the page rather than restated */
eq('the CFB schedule feed is the board’s own',
  HOST.FEEDS.cfb(2026),
  (APP.match(/function FBP4_URL_SCHED\(y\)\{return '([^']+)'\+y\+'([^']+)'/) || []).slice(1, 3).join('2026'));
chk('the NFL schedule feed is the board’s own',
  APP.indexOf(HOST.FEEDS.nfl()) >= 0, HOST.FEEDS.nfl());
/* a replayed quote has to be in the shape the module's own reader reads */
has(APP, "r.market==='spreads'", 'the module reads a spread row by market name');
has(APP, "r.market==='totals'", 'and a total row the same way');
has(APP, 'out.spread_line=-(+r.point)', 'and the sign convention a replayed quote must honour');

/* ======================================================================== */
section('2. BOOTING THE RESEARCH TERMINAL, HEADLESS');
/* ======================================================================== */
(async function () {
  let host = null, bootError = null;
  try { host = await HOST.open({ network: NETWORK, quiet: true }); }
  catch (e) { bootError = e; }

  if (!chk('the football module boots headlessly', !!host, bootError && (bootError.message || String(bootError)))) {
    return finish();
  }
  chk('the committed rankings artifact is in memory',
    !!(host.notes.rankings && host.notes.rankings.season), JSON.stringify(host.notes.rankings));
  chk('the captured-quote snapshots were injected',
    host.notes.market_snapshots >= 0, String(host.notes.market_snapshots));

  const slate = host.slate();
  if (!slate.length) {
    skip('live parity', 'neither schedule feed was readable in this run'
      + (NETWORK ? '' : ' (run with --network, or warm ' + HOST.CACHE_DIR + ')')
      + '; refused: ' + host.notes.refused.slice(0, 3).join(', '));
    return finish();
  }
  chk('the slate carries both boards',
    slate.some(g => g.sport === 'CFB') && slate.some(g => g.sport === 'NFL'),
    slate.map(g => g.sport).join(','));
  chk('every slate entry names both teams and a kickoff',
    slate.every(g => g.home && g.away && isFinite(Date.parse(g.kickoff))));

  /* ====================================================================== */
  section('3. RESEARCH → RECORD → PAGE: the same numbers all the way down');
  /* ====================================================================== */
  /* Every published record is re-derived from LIVE research and the figures
     are compared against the payload that produced them, not against a value
     written here. A number that changed since the article was published is a
     legitimate update; a number that DISAGREES with the payload inside the
     same run is the bug this file exists for. */
  const wanted = STORE.published();
  if (!wanted.length) skip('parity', 'nothing is published in the store');
  let checked = 0;

  for (const rec of wanted) {
    const entry = slate.filter(g => (g.sport.toLowerCase() + '-' + g.game_id) === rec.id)[0];
    if (!entry) { skip(rec.slug, 'this game is no longer on the board (kicked off, or outside the lookahead window)'); continue; }
    const research = entry.sport === 'NFL'
      ? host.nfl(entry.home, entry.away, entry.kickoff_ms)
      : host.cfb(entry.home, entry.away, entry.kickoff_ms);
    if (!chk(rec.slug + ': the terminal returns a research payload', !!research)) continue;
    checked++;

    const meta = GEN.gameMetaFor(entry, research);
    const built = MODEL.build(research, meta, { now: rec.published_at, status: 'published',
      published_at: rec.published_at, market_source: host.marketSourceFor(entry.sport, entry.game_id) });
    const p = research.projection || {};

    eq(rec.slug + ': the record’s fair spread is the payload’s', built.fair_spread_text, p.fair_spread_text || null);
    eq(rec.slug + ': the record’s fair total is the payload’s', built.fair_total, p.total || null);
    eq(rec.slug + ': the record’s model status is the payload’s', built.model_status,
      p.status || (research.state && research.state.label) || null);
    eq(rec.slug + ': the record’s confidence is the payload’s', built.confidence,
      p.confidence_pct == null ? null : p.confidence_pct);
    eq(rec.slug + ': the slug is still the published one', built.slug, rec.slug);
    eq(rec.slug + ': and the canonical URL has not moved', built.canonical_url, rec.canonical_url);

    /* and the rendered page carries them, which is what a reader gets */
    const html = RENDER.articlePage(built);
    if (p.fair_spread_text) has(html, RENDER.esc(p.fair_spread_text), rec.slug + ': the fair spread reaches the HTML');
    if (p.total) has(html, p.total, rec.slug + ': the fair total reaches the HTML');
    if (p.status) has(html, RENDER.esc(p.status), rec.slug + ': the model status reaches the HTML');
    if (p.confidence_pct != null) has(html, p.confidence_pct + '%', rec.slug + ': the confidence reaches the HTML');

    /* the two things the article must never do with a payload */
    chk(rec.slug + ': no projected score without a published total',
      !(p.priced && p.score && !p.total));
    chk(rec.slug + ': no confidence percentage is invented for a model that publishes none',
      p.confidence_pct != null || built.confidence === null);

    /* and it must never publish a recommendation, whatever came back */
    chk(rec.slug + ': the live-built article carries no recommendation language',
      !MODEL.FORBIDDEN.test(MODEL.flattenText(built)),
      (MODEL.flattenText(built).match(MODEL.FORBIDDEN) || [''])[0]);
  }
  chk('at least one published article was checked against live research', checked > 0);

  /* ====================================================================== */
  section('4. THE PIPELINE ON A GAME IT HAS NEVER SEEN');
  /* ====================================================================== */
  const fresh = slate.filter(g => !STORE.load(g.sport.toLowerCase() + '-' + g.game_id))[0]
    || slate[slate.length - 1];
  (function () {
    const research = fresh.sport === 'NFL'
      ? host.nfl(fresh.home, fresh.away, fresh.kickoff_ms)
      : host.cfb(fresh.home, fresh.away, fresh.kickoff_ms);
    if (!chk('a game with no record yet still produces research', !!research)) return;
    const rec = MODEL.build(research, GEN.gameMetaFor(fresh, research), { now: new Date().toISOString() });
    eq('a brand-new record starts as a draft', rec.status, 'draft');
    chk('and it has a slug nobody has to invent', /^[a-z0-9-]+$/.test(rec.slug), rec.slug);
    chk('and it runs the same publication checks', Array.isArray(MODEL.checks(rec)) && MODEL.checks(rec).length >= 10);
    const html = RENDER.articlePage(rec);
    has(html, 'name="robots" content="noindex,nofollow"', 'an unpublished record renders noindex');
    chk('and renders without a stringified nothing',
      !/(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/.test(
        html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')));
  })();

  /* ====================================================================== */
  section('5. AUTO-PUBLISH REFUSES WHAT IT SHOULD REFUSE');
  /* ====================================================================== */
  (function () {
    const good = STORE.published()[0];
    if (!good) { skip('auto-publish gate', 'nothing published to base it on'); return; }
    chk('a complete record passes every check', MODEL.publishable(good).ok,
      JSON.stringify(MODEL.publishable(good).failed.map(f => f.id)));
    /* each way a record can be incomplete, refused on its own */
    [['research', r => { r.research = { kind: null }; }],
     ['kickoff', r => { r.game_time = null; }],
     ['description', r => { r.seo_description = 'short'; }],
     ['sections', r => { r.article.sections = r.article.sections.slice(0, 1); }],
     ['bottom_line', r => { r.article.bottom_line.paragraphs = []; }],
     ['canonical', r => { r.canonical_url = 'https://example.com/x'; }],
     ['slug', r => { r.slug = 'Not A Slug'; }]
    ].forEach(([id, breakIt]) => {
      const r = JSON.parse(JSON.stringify(good));
      breakIt(r);
      const v = MODEL.publishable(r);
      chk('auto-publish refuses a record with a broken ' + id,
        !v.ok && v.failed.some(f => f.id === id), JSON.stringify(v.failed.map(f => f.id)));
    });
  })();

  finish();
})();

function finish() {
  console.log('');
  failures.forEach(f => console.log('  × ' + f));
  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk article pipeline | '
    + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exit(fail ? 1 : 0);
}
