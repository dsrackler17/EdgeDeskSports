#!/usr/bin/env node
/* ===========================================================================
   THE SEO AUDIT — every page EdgeDesk offers to a search engine, checked the
   way a crawler meets it: from the sitemap, through robots.txt, into the
   page's own head and links.

   For every URL in the sitemap set (sitemap.xml and the urlsets it names)
   and every standing public page, it reports:
     served      a file in the repository answers that URL (GitHub Pages)
     crawlable   robots.txt allows it (Google's rules: longest match wins, a
                 tie goes to Allow, * and $ honoured)
     indexable   no noindex in the page's head
     in_sitemap  submitted through the sitemap set
     canonical   present, absolute, on edgedesksports.com, and the URL itself
     title / description lengths, og:image a real https image (not data:),
                 twitter:card, JSON-LD @types (each block must parse), one H1
     links       every internal link resolves to a file the site serves

   ERRORS (fail --check): a sitemap URL that is not served, not crawlable or
   noindex; a missing title or canonical; a canonical pointing elsewhere; an
   og:image that is a data: URI; JSON-LD that does not parse; an internal link
   from an indexable page to a page that does not exist.
   WARNINGS (reported, never fail): long titles or descriptions, a directory
   URL listed without its trailing slash (GitHub Pages answers it with a 301),
   no structured data, no social image.

   It never fetches anything: the repository IS the site.

     node tools/seo/audit.js            write articles/data/seo-report.json, print a summary
     node tools/seo/audit.js --check    print, and exit 1 on any error
     node tools/seo/audit.js --json     print the full report

   The report is read by /admin/seo/. tools/articles/build_articles.js
   rewrites it on every article build, so it stays current without a job of
   its own.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SITE = 'https://edgedesksports.com';
/* standing public pages that must pass even when a sitemap forgets them */
const STANDING = ['/', '/articles/', '/articles/college-football/', '/articles/nfl/', '/today/', '/tools/', '/tools/no-vig-calculator/',
  '/tools/fair-odds-calculator/', '/tools/model-vs-market/', '/newsletter/', '/methodology/', '/record.html', '/partners/',
  '/terms.html', '/privacy.html', '/disclaimer.html'];

function read(root, rel) { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } }

/* ── the sitemap set ─────────────────────────────────────────────────── */
function sitemapUrls(root) {
  const index = read(root, 'sitemap.xml') || '';
  const locs = (x) => (String(x).match(/<loc>([^<]+)<\/loc>/g) || []).map((m) => m.replace(/<\/?loc>/g, '').trim());
  let urls = [];
  if (index.indexOf('<sitemapindex') >= 0) {
    locs(index).map((u) => u.replace(/^https?:\/\/[^/]+\//, '')).filter((f) => /^sitemap[\w-]*\.xml$/.test(f))
      .forEach((f) => { urls = urls.concat(locs(read(root, f) || '')); });
  } else urls = locs(index);
  return Array.from(new Set(urls));
}

/* ── robots.txt, Google's semantics, for the * group ─────────────────── */
function robotsRules(root) {
  const txt = read(root, 'robots.txt') || '';
  const rules = [];
  let inStar = false, sawAgentLine = false;
  txt.split(/\r?\n/).forEach((line) => {
    const l = line.replace(/#.*$/, '').trim();
    if (!l) return;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(l);
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!sawAgentLine) inStar = false; inStar = inStar || v === '*'; sawAgentLine = true; return; }
    sawAgentLine = false;
    if (!inStar) return;
    if ((k === 'allow' || k === 'disallow') && v) rules.push({ allow: k === 'allow', path: v });
  });
  return rules;
}
function ruleMatches(pattern, p) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : '')).test(p);
}
function allowed(rules, p) {
  let best = null;
  rules.forEach((r) => {
    if (!ruleMatches(r.path, p)) return;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, path: r.path };
  });
  return best ? { ok: best.allow, rule: (best.allow ? 'Allow: ' : 'Disallow: ') + best.path } : { ok: true, rule: null };
}

/* ── URL → the file GitHub Pages serves ───────────────────────────────── */
function fileFor(root, urlPath) {
  const p = decodeURIComponent(String(urlPath || '/').split(/[?#]/)[0]);
  const rel = p.replace(/^\/+/, '');
  const cands = rel === '' ? ['index.html']
    : p.endsWith('/') ? [rel + 'index.html']
      : /\.[a-z0-9]+$/i.test(rel) ? [rel] : [rel + '/index.html', rel + '.html'];
  for (const c of cands) { const f = path.join(root, c); if (fs.existsSync(f) && fs.statSync(f).isFile()) return { file: c, redirect: !p.endsWith('/') && c.endsWith('/index.html') && rel !== '' }; }
  return null;
}
function pathOf(u) {
  const m = /^https?:\/\/(www\.)?edgedesksports\.com(\/[^#?]*)?/.exec(u);
  if (m) return m[2] || '/';
  return u.startsWith('/') ? u.split(/[?#]/)[0] : null;
}

/* ── one page ─────────────────────────────────────────────────────────── */
function attr(head, re) { const m = re.exec(head); return m ? m[1].replace(/&amp;/g, '&') : null; }
function auditPage(root, url, ctx) {
  const p = pathOf(url) || '/';
  const row = { url: url.startsWith('http') ? url : SITE + p, path: p, errors: [], warnings: [] };
  const served = fileFor(root, p);
  row.served = !!served;
  row.file = served ? served.file : null;
  row.in_sitemap = ctx.sitemap.has(row.url);
  const rb = allowed(ctx.rules, p);
  row.crawlable = rb.ok; row.robots_rule = rb.rule;
  if (!served) { row.errors.push('not served: no file answers ' + p); return row; }
  if (served.redirect) row.warnings.push('listed without its trailing slash: GitHub Pages answers ' + p + ' with a 301 to ' + p + '/');
  const html = read(root, served.file) || '';
  const head = (html.split(/<\/head>/i)[0] || '');
  const robotsMeta = attr(head, /<meta\s+name="robots"\s+content="([^"]*)"/i) || '';
  row.indexable = !/noindex/i.test(robotsMeta);
  row.title = attr(head, /<title>([^<]*)<\/title>/i);
  row.description = attr(head, /<meta\s+name="description"\s+content="([^"]*)"/i);
  row.canonical = attr(head, /<link\s+rel="canonical"\s+href="([^"]*)"/i);
  row.og_image = attr(head, /<meta\s+property="og:image"\s+content="([^"]*)"/i);
  row.twitter_card = attr(head, /<meta\s+name="twitter:card"\s+content="([^"]*)"/i);
  row.h1 = (html.match(/<h1[\s>]/gi) || []).length;
  row.ld_types = [];
  (head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || []).forEach((b) => {
    try {
      const j = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
      const walk = (o) => { if (!o) return; if (Array.isArray(o)) o.forEach(walk); else if (o['@type']) row.ld_types.push(o['@type']); if (o['@graph']) walk(o['@graph']); };
      walk(j);
    } catch (e) { row.errors.push('JSON-LD that does not parse'); }
  });
  const listed = row.in_sitemap;
  if (listed && !row.crawlable) row.errors.push('in the sitemap but disallowed by robots.txt (' + rb.rule + ')');
  if (listed && !row.indexable) row.errors.push('in the sitemap but marked noindex');
  if (row.indexable) {
    if (!row.title) row.errors.push('no <title>');
    else if (row.title.length > 70) row.warnings.push('title is ' + row.title.length + ' characters (results show ~60)');
    if (!row.description) row.warnings.push('no meta description');
    else if (row.description.length > 170) row.warnings.push('description is ' + row.description.length + ' characters (results show ~160)');
    if (!row.canonical) row.errors.push('no canonical');
    else {
      const cp = pathOf(row.canonical);
      if (!/^https:\/\/edgedesksports\.com\//.test(row.canonical)) row.errors.push('canonical is not on https://edgedesksports.com: ' + row.canonical);
      else if (listed && row.canonical !== row.url) row.errors.push('canonical points elsewhere: ' + row.canonical);
      else if (cp && fileFor(root, cp) && fileFor(root, cp).redirect) row.warnings.push('canonical without its trailing slash (a 301 on GitHub Pages)');
    }
    if (row.og_image && /^data:/.test(row.og_image)) row.errors.push('og:image is a data: URI, which no social card can fetch');
    else if (!row.og_image) row.warnings.push('no og:image');
    if (!row.ld_types.length) row.warnings.push('no structured data');
    if (row.h1 !== 1) row.warnings.push(row.h1 + ' <h1> elements');
  }
  /* internal links */
  const broken = [];
  const hrefs = (html.replace(/<script[\s\S]*?<\/script>/gi, '').match(/href="([^"]+)"/g) || []).map((m) => m.slice(6, -1).replace(/&amp;/g, '&'));
  hrefs.forEach((h) => {
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(h)) return;
    const lp = pathOf(h);
    if (!lp || /^\/(app\.html|\/)/.test(lp) || lp.startsWith('//')) return;
    if (/^\/(fonts|lib|assets)\//.test(lp) && /\.(css|js|png|svg|woff2?)$/.test(lp)) { if (!fileFor(root, lp)) broken.push(lp); return; }
    if (!fileFor(root, lp)) broken.push(lp);
  });
  row.broken_links = Array.from(new Set(broken)).slice(0, 20);
  if (row.indexable && row.broken_links.length) row.errors.push('links to ' + row.broken_links.length + ' page(s) that do not exist: ' + row.broken_links.slice(0, 5).join(', '));
  return row;
}

function run(root) {
  root = root || ROOT;
  const sm = sitemapUrls(root);
  const ctx = { sitemap: new Set(sm), rules: robotsRules(root) };
  const urls = Array.from(new Set(sm.concat(STANDING.map((p) => SITE + p))));
  const pages = urls.sort().map((u) => auditPage(root, u, ctx));
  const missingStanding = STANDING.filter((p) => !ctx.sitemap.has(SITE + p) && !(p === '/' && ctx.sitemap.has(SITE + '/')));
  const summary = {
    pages: pages.length,
    in_sitemap: pages.filter((r) => r.in_sitemap).length,
    served: pages.filter((r) => r.served).length,
    crawlable: pages.filter((r) => r.crawlable).length,
    indexable: pages.filter((r) => r.served && r.indexable).length,
    with_structured_data: pages.filter((r) => (r.ld_types || []).length).length,
    errors: pages.reduce((a, r) => a + r.errors.length, 0),
    warnings: pages.reduce((a, r) => a + r.warnings.length, 0),
    standing_not_in_sitemap: missingStanding
  };
  return {
    schema: 'edgedesk_seo_report/1', generated_at: new Date().toISOString(), site: SITE,
    robots_rules: ctx.rules.length, summary, pages,
    note: 'Read from the repository, which is the site. Whether Google has INDEXED a page is only known to Search Console (see /admin/acquisition/ once the import is configured); nothing here claims it.'
  };
}
function write(root) {
  root = root || ROOT;
  const rep = run(root);
  const out = path.join(root, 'articles', 'data', 'seo-report.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  /* stable bytes when nothing changed: the timestamp alone does not rewrite the file */
  const prev = read(root, 'articles/data/seo-report.json');
  const strip = (s) => String(s || '').replace(/"generated_at": "[^"]*"/, '');
  const next = JSON.stringify(rep, null, 1) + '\n';
  if (!prev || strip(prev) !== strip(next)) fs.writeFileSync(out, next);
  return rep;
}

if (require.main === module) {
  const check = process.argv.indexOf('--check') >= 0, json = process.argv.indexOf('--json') >= 0;
  const rep = check ? run(ROOT) : write(ROOT);
  if (json) { console.log(JSON.stringify(rep, null, 1)); process.exit(0); }
  const s = rep.summary;
  console.log('SEO audit · ' + s.pages + ' pages · ' + s.in_sitemap + ' in the sitemap · ' + s.crawlable + ' crawlable · ' + s.indexable
    + ' indexable · ' + s.with_structured_data + ' with structured data · ' + s.errors + ' error(s) · ' + s.warnings + ' warning(s)');
  if (s.standing_not_in_sitemap.length) console.log('  standing pages not in the sitemap: ' + s.standing_not_in_sitemap.join(', '));
  rep.pages.forEach((r) => r.errors.forEach((e) => console.log('  ERROR ' + r.path + ': ' + e)));
  if (process.argv.indexOf('--warnings') >= 0) rep.pages.forEach((r) => r.warnings.forEach((w) => console.log('  warn  ' + r.path + ': ' + w)));
  process.exit(check && s.errors ? 1 : 0);
}
module.exports = { run, write, allowed, robotsRules, sitemapUrls, fileFor, auditPage, STANDING };
