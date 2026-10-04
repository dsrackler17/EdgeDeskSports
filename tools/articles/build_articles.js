#!/usr/bin/env node
/* ============================================================================
   BUILD THE PUBLIC ARTICLE SITE — records in, crawlable HTML out.

   WHY THE PAGES ARE FILES. EdgeDesk is served as static files, so an article
   Google can read has to exist as one. Everything a crawler needs — headline,
   numbers, reasoning, uncertainty, structured data, internal links — is in
   the markup before any JavaScript runs, and no article page is behind an
   account.

   WHAT IT WRITES
     articles/index.html                    the hub, all sports
     articles/college-football/index.html   sport hubs, one per sport in the store
     articles/nfl/index.html
     articles/<slug>/index.html             one per PUBLISHED article
     articles/<alias>/index.html            a short alias, canonical to the article
     sitemap-articles.xml                   published articles only
     sitemap.xml                            a sitemap index that points at both

   DRAFTS NEVER SHIP. An unpublished record produces no public page, no hub
   card and no sitemap entry. With --drafts it produces a page under
   /articles/_preview/<slug>/, which is noindex, disallowed in robots.txt and
   still not in any sitemap — a preview URL the operator can open, not a
   publication.

   IT IS A CLEAN BUILD. Every directory it owns is removed before it writes,
   so an article that was unpublished or renamed leaves nothing behind for a
   crawler to keep finding.

     node tools/articles/build_articles.js
     node tools/articles/build_articles.js --drafts
     node tools/articles/build_articles.js --check      # build nothing, report
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const STORE = require('./store.js');
const MODEL = require('./article_model.js');
const R = require('./article_render.js');

const ROOT = STORE.ROOT;
const OUT = path.join(ROOT, 'articles');
const PREVIEW = path.join(OUT, '_preview');
const SITE = MODEL.SITE;

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const DRAFTS = !!arg('drafts', false);
const CHECK = !!arg('check', false);
const QUIET = !!arg('quiet', false);
const NOW = arg('now', null) ? new Date(arg('now', null)).toISOString() : new Date().toISOString();
function log(...a) { if (!QUIET) console.log(...a); }

/* Directories this build owns and may therefore delete.
   
   IT IS A DENY LIST FOR A REASON, AND THE REASON IS A BUG THIS ALREADY HAD.
   The build removes the directories it owns before writing, so an article
   that was unpublished leaves nothing behind for a crawler to keep finding.
   The first version of that rule was "every directory under /articles except
   data" — which quietly deleted /articles/community/ and /articles/write/,
   the hand-maintained member-post pages, the first time it ran after they
   were added. Nothing failed; the pages were simply gone.

   So the set of things this build must not touch is named here, once, and
   tools/articles/community.test.js asserts each one survives a build. A
   directory added under /articles in future has to be added to this list or
   it will be deleted, and that is the trade: an explicit list somebody must
   maintain, rather than an implicit rule that eats work silently. */
const NOT_OURS = ['data', 'community', 'write'];
function ownedDirs() {
  if (!fs.existsSync(OUT)) return [];
  return fs.readdirSync(OUT, { withFileTypes: true })
    .filter(d => d.isDirectory() && NOT_OURS.indexOf(d.name) < 0)
    .map(d => path.join(OUT, d.name));
}
function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
function page(slug, body) { return write(path.join(OUT, slug, 'index.html'), body); }

/* ------------------------------------------------------------- sitemaps */
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function lastmod(rec) {
  const t = Date.parse(rec.updated_at || rec.published_at || rec.generated_at);
  return isFinite(t) ? new Date(t).toISOString() : null;
}
/* PUBLISHED ONLY. A draft in a sitemap is an invitation to index a draft, and
   an alias is never listed: it is a second URL for one document and the
   sitemap's job is to name the canonical one. */
function articleSitemap(recs) {
  const hubs = [
    { loc: SITE + '/articles', freq: 'daily', pri: '0.9' },
    { loc: SITE + '/articles/college-football', freq: 'daily', pri: '0.8' },
    { loc: SITE + '/articles/nfl', freq: 'daily', pri: '0.8' }
  ];
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n';
  x += '<!-- EdgeDesk research articles. PUBLISHED ONLY: a draft, a preview and a\n';
  x += '     short alias URL are all deliberately absent. Written by\n';
  x += '     tools/articles/build_articles.js; do not edit by hand. -->\n';
  x += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  hubs.forEach(h => {
    x += '  <url><loc>' + xmlEsc(h.loc) + '</loc><changefreq>' + h.freq + '</changefreq><priority>' + h.pri + '</priority></url>\n';
  });
  recs.slice().sort((a, b) => String(a.slug).localeCompare(String(b.slug))).forEach(r => {
    const lm = lastmod(r);
    /* a frozen article is history and will not change again */
    const freq = r.frozen ? 'yearly' : 'hourly';
    x += '  <url><loc>' + xmlEsc(r.canonical_url) + '</loc>'
      + (lm ? '<lastmod>' + lm + '</lastmod>' : '')
      + '<changefreq>' + freq + '</changefreq><priority>0.7</priority></url>\n';
  });
  x += '</urlset>\n';
  return x;
}
/* The primary sitemap becomes an INDEX pointing at the two real ones, so
   adding a sport or a section later never touches the site-wide list again. */
function sitemapIndex() {
  const now = new Date(NOW).toISOString();
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n';
  x += '<!-- EdgeDesk. The primary sitemap is an INDEX: the pages that rarely\n';
  x += '     change live in sitemap-pages.xml, and the research articles, which\n';
  x += '     are added and refreshed continuously, live in their own file that a\n';
  x += '     build rewrites. Written by tools/articles/build_articles.js. -->\n';
  x += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  x += '  <sitemap><loc>' + SITE + '/sitemap-pages.xml</loc><lastmod>' + now + '</lastmod></sitemap>\n';
  x += '  <sitemap><loc>' + SITE + '/sitemap-articles.xml</loc><lastmod>' + now + '</lastmod></sitemap>\n';
  x += '</sitemapindex>\n';
  return x;
}

/* ------------------------------------------------------------------ build */
function build() {
  const all = STORE.loadAll();
  const pub = all.filter(r => r.status === 'published');
  const problems = [];

  /* two published articles cannot share a URL */
  const seen = Object.create(null);
  pub.forEach(r => {
    [r.slug].concat(r.aliases || []).forEach(s => {
      if (seen[s] && seen[s] !== r.id) problems.push('duplicate URL /articles/' + s + ' claimed by ' + seen[s] + ' and ' + r.id);
      seen[s] = r.id;
    });
  });
  /* and a published article must still pass its own checks */
  pub.forEach(r => {
    const v = MODEL.publishable(r);
    if (!v.ok) problems.push(r.slug + ': published but failing ' + v.failed.map(f => f.id).join(', '));
  });

  if (CHECK) {
    log(all.length + ' record(s), ' + pub.length + ' published');
    problems.forEach(p => log('  PROBLEM: ' + p));
    log(problems.length ? '\n' + problems.length + ' problem(s)' : '\nno problems');
    return { written: [], problems: problems, published: pub.length };
  }
  if (problems.length) {
    problems.forEach(p => console.error('  PROBLEM: ' + p));
    throw new Error(problems.length + ' problem(s) in the article store — nothing was built');
  }

  ownedDirs().forEach(d => fs.rmSync(d, { recursive: true, force: true }));
  const written = [];

  pub.forEach(r => {
    written.push(page(r.slug, R.articlePage(r)));
    (r.aliases || []).forEach(a => { written.push(page(a, R.aliasPage(r, a))); });
  });

  /* the hubs. A sport hub is written for every sport the model knows, even
     with nothing published in it yet: an empty section that says so is a
     better answer to a crawler and a reader than a 404. */
  written.push(page('', R.hubPage({
    records: pub, canonical: SITE + '/articles', active: '/articles', now: NOW,
    title: 'EdgeDesk Research Articles — Model Projections, Fair Spreads and Matchup Analysis',
    og_title: 'EdgeDesk research — every game, priced and explained',
    description: 'EdgeDesk publishes a research article for every game it prices: the fair spread, the projected score, what moved the number, where each team has an edge, and what the model could not measure. Research, not picks.',
    h1: 'EdgeDesk research',
    standfirst: 'Every article here is the EdgeDesk model’s own read on one game — what it projects, why it landed there, and what it still does not know. Research, not picks.'
  })));

  Object.keys(MODEL.SPORTS).forEach(code => {
    const S = MODEL.SPORTS[code];
    const recs = pub.filter(r => r.sport === code);
    written.push(page(S.slug, R.hubPage({
      records: recs, canonical: SITE + '/articles/' + S.slug, active: '/articles/' + S.slug, now: NOW,
      title: 'EdgeDesk ' + S.label + ' Research — Fair Spreads, Model Projections and Matchup Analysis',
      og_title: 'EdgeDesk ' + S.label + ' research',
      description: 'EdgeDesk ' + S.label + ' research: the model’s fair spread and projected score for every game it prices, the drivers behind the number, the matchups that decide it, and the data it is missing. Research, not picks.',
      h1: 'EdgeDesk ' + S.label + ' research',
      standfirst: 'One model, one set of numbers, published with its own confidence and its own gaps — for every ' + S.label + ' game EdgeDesk prices.'
    })));
  });

  if (DRAFTS) {
    const drafts = all.filter(r => r.status !== 'published' && r.status !== 'archived');
    drafts.forEach(r => {
      written.push(write(path.join(PREVIEW, r.slug, 'index.html'), R.articlePage(r, { noindex: true })));
    });
    written.push(write(path.join(PREVIEW, 'index.html'), R.hubPage({
      records: drafts, canonical: SITE + '/articles', active: '/articles', now: NOW, noindex: true,
      title: 'EdgeDesk article previews', description: 'Unpublished EdgeDesk article previews. Not indexed.',
      h1: 'Article previews', standfirst: 'Unpublished records, rendered exactly as they would publish. Not indexed, not in any sitemap.'
    })));
    log('  ' + drafts.length + ' draft preview(s) under /articles/_preview/');
  }

  write(path.join(ROOT, 'sitemap-articles.xml'), articleSitemap(pub));
  write(path.join(ROOT, 'sitemap.xml'), sitemapIndex());

  log(written.length + ' file(s) written · ' + pub.length + ' published article(s)');
  return { written: written, problems: [], published: pub.length };
}

if (require.main === module) {
  try { build(); process.exit(0); }
  catch (e) { console.error('build failed: ' + (e && e.message || e)); process.exit(1); }
}
module.exports = { build, articleSitemap, sitemapIndex, OUT, NOT_OURS };
