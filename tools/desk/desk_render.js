/* ============================================================================
   DESK PAGES — a published desk article in, a crawlable page out.

   Same head, chrome, tracking, byline and author box as every research
   article (tools/articles/article_render.js), so there is one look and one
   set of structured-data rules. What a desk page adds:

     * the owner's "My take", directly under the lead number;
     * a Dataset block in the JSON-LD for every page that publishes a table
       of my numbers, with each source file as a distribution;
     * "Where every number on this page comes from": the files, their
       digests and the commit, plus the record that holds every query.

   It renders. It never computes: the body is the stored draft's Markdown,
   escaped by lib/edgedesk_desk.js mdToHtml.
   ========================================================================== */
'use strict';
const R = require('../articles/article_render.js');
const D = require('../../lib/edgedesk_desk.js');

const SITE = R.SITE;
const esc = R.esc;
const HUB = SITE + '/articles/desk/';

function urlOf(rec) { return SITE + '/articles/' + rec.slug + '/'; }
function typeLine(rec) { return D.typeLabel(rec.type) + (rec.sport && rec.sport !== 'ALL' ? ' · ' + rec.sport : ''); }
function hasTable(md) { return /^\|.*\|\s*$/m.test(String(md || '')); }
function tableHeads(md) {
  const out = [];
  String(md || '').split(/\n{2,}/).forEach(b => {
    const l = b.split('\n');
    if (l.length >= 2 && /^\|/.test(l[0]) && /^\|(-+\|)+$/.test(l[1].replace(/\s/g, ''))) {
      l[0].replace(/^\|\s?|\s?\|$/g, '').split(' | ').forEach(h => { if (h && out.indexOf(h) < 0) out.push(h); });
    }
  });
  return out;
}
/* The <title> a result list shows is cut near 60 characters, so each type
   gets a short one; the on-page headline keeps the full sentence and its
   numbers. */
function seoTitle(rec) {
  const head = String(rec.title).split(':')[0];
  const clip = (s, n) => s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '');
  switch (rec.type) {
    case 'weekly_clv': case 'got_wrong': return clip(head, 48) + ' | EdgeDesk';
    case 'line_movement': return clip(head, 34) + ', open to close | EdgeDesk';
    case 'disagreement': return clip(head, 18) + ': where my number disagrees | EdgeDesk';
    default: return clip(String(rec.title), 48) + ' | EdgeDesk';
  }
}
function mimeOf(file) { return /\.jsonl$/.test(file) ? 'application/x-ndjson' : 'application/json'; }
function isDir(file) { return !/\.[a-z]+$/.test(file); }

/* ------------------------------------------------------ structured data */
function structuredData(rec) {
  const url = urlOf(rec), snap = rec.data_snapshot || {};
  const out = [{
    '@context': 'https://schema.org', '@type': 'Article',
    mainEntityOfPage: { '@type': 'WebPage', '@id': url }, url: url,
    headline: rec.title.length > 110 ? rec.title.slice(0, 107) + '…' : rec.title,
    description: rec.description, articleSection: D.typeLabel(rec.type), inLanguage: 'en-US', isAccessibleForFree: true,
    author: R.personLD(),
    publisher: { '@type': 'Organization', name: 'EdgeDesk Sports', url: SITE, logo: { '@type': 'ImageObject', url: R.OG_DEFAULT, width: 1200, height: 630 } },
    datePublished: R.iso(rec.published_at), dateModified: R.iso(rec.updated_at) || R.iso(rec.published_at),
    image: [R.OG_DEFAULT]
  }];
  if (hasTable(rec.body_md)) {
    const files = (snap.sources || []).filter(s => !isDir(s.file));
    const ds = {
      '@context': 'https://schema.org', '@type': 'Dataset',
      name: rec.title + ' (the numbers)',
      description: 'The numbers behind "' + rec.title + '": ' + rec.description
        + ' Every value was produced by a stored query against EdgeDesk’s own committed record files, listed as distributions, and is graded in public.',
      url: url, creator: R.personLD(), publisher: { '@type': 'Organization', name: 'EdgeDesk Sports', url: SITE },
      isAccessibleForFree: true, inLanguage: 'en-US',
      datePublished: R.iso(rec.published_at), dateModified: R.iso(rec.data_as_of) || R.iso(rec.updated_at),
      variableMeasured: tableHeads(rec.body_md),
      keywords: [D.typeLabel(rec.type), rec.sport, 'closing line value', 'CLV', 'sports betting research'].filter(Boolean)
    };
    if (/^\d{4}-\d{2}$/.test(rec.period || '')) ds.temporalCoverage = rec.period;
    if (files.length) ds.distribution = files.map(s => ({ '@type': 'DataDownload', contentUrl: SITE + '/' + s.file, encodingFormat: mimeOf(s.file), name: s.file }));
    out.push(ds);
  }
  out.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Research', item: SITE + '/articles/' },
    { '@type': 'ListItem', position: 2, name: 'From my desk', item: HUB },
    { '@type': 'ListItem', position: 3, name: rec.title, item: url }] });
  return out;
}

/* ----------------------------------------------------------- the page */
function sourcesHTML(rec) {
  const snap = rec.data_snapshot || {};
  const n = (snap.numbers || []).length, f = (snap.facts || []).length;
  const commit = String(snap.commit || rec.source_commit || '').slice(0, 12);
  let h = '<section class="d-src" aria-label="Where the numbers come from"><h2>Where every number on this page comes from</h2>';
  h += '<p>Each of the ' + n + ' numbers and ' + f + ' facts above was written through a stored query against one of the files below, as they stood at commit <code>'
    + esc(commit || 'unknown') + '</code>. Nothing was typed by hand, and the page could not publish until every query re-ran and matched.'
    + ' The full trace, every number with the query that produced it, is in <a href="/articles/data/desk/records/' + esc(rec.slug) + '.json">this article’s record</a>.</p><ul>';
  (snap.sources || []).forEach(s => {
    const name = isDir(s.file) ? '<code>' + esc(s.file) + '/</code>' : '<a href="/' + esc(s.file) + '"><code>' + esc(s.file) + '</code></a>';
    h += '<li>' + name + ': ' + esc(s.what || '') + (s.generated_at ? '. Built ' + esc(R.dateLabel(s.generated_at)) : '')
      + '. sha256 <code>' + esc(String(s.sha256 || '').slice(0, 12)) + '</code></li>';
  });
  return h + '</ul></section>';
}
function bodyWithTake(rec) {
  const blocks = String(rec.body_md || '').split(/\n{2,}/);
  const first = blocks.shift() || '';
  return '<div class="d-body">' + D.mdToHtml(first) + '</div>'
    + R.takeSectionHTML(rec.my_take)
    + '<div class="d-body">' + D.mdToHtml(blocks.join('\n\n')) + '</div>';
}
function cardHTML(rec) {
  return '<a class="d-card" href="/articles/' + esc(rec.slug) + '/"><span>' + esc(typeLine(rec)) + '</span><b>' + esc(rec.title) + '</b>'
    + '<span>' + esc(R.dateLabel(rec.published_at, { hour: undefined, minute: undefined, timeZoneName: undefined }) || '') + '</span></a>';
}
function page(rec, opts) {
  opts = opts || {};
  const url = urlOf(rec);
  let h = '<!doctype html>\n<html lang="en">\n<head>\n';
  h += R.head({ title: seoTitle(rec), description: rec.description, canonical: url, og_title: rec.title,
    published: R.iso(rec.published_at), modified: R.iso(rec.updated_at), section: D.typeLabel(rec.type), ld: structuredData(rec) });
  h += '</head>\n<body class="a-body" data-ed-engage>\n';
  h += R.siteHeader('/articles/');
  h += '<main class="a-wrap" id="main"><article class="a-article">';
  h += '<nav class="a-crumbs" aria-label="Breadcrumb"><a href="/articles/">Research</a> <span>›</span> <a href="/articles/desk/">From my desk</a> <span>›</span> <span aria-current="page">' + esc(D.typeLabel(rec.type)) + '</span></nav>';
  h += '<header class="a-hero"><span class="d-type">' + esc(typeLine(rec)) + '</span><h1 class="a-h1">' + esc(rec.title) + '</h1>';
  h += R.bylineHTML({ published: rec.published_at, updated: rec.updated_at, dataAsOf: rec.data_as_of,
    recordUrl: rec.record_link || D.AUTHOR.record_url, recordLabel: rec.record_link && rec.record_link !== D.AUTHOR.record_url ? 'The record behind this page' : D.AUTHOR.record_label });
  h += '</header>';
  h += bodyWithTake(rec);
  h += R.shareHTML({ canonical_url: url, title: rec.title });
  h += sourcesHTML(rec);
  h += R.trialStripHTML();
  h += R.authorBoxHTML();
  const more = (opts.more || []).filter(o => o.slug !== rec.slug).slice(0, 4);
  if (more.length) h += '<section class="a-sec"><h2 class="a-h2">More from my desk</h2><div class="d-cards">' + more.map(cardHTML).join('') + '</div></section>';
  h += '<p class="a-source">Research, not picks. Nothing here is a wager, a recommendation or advice. Every number is graded in public at <a href="/record.html">/record.html</a>.</p>';
  h += '</article></main>';
  h += R.siteFooter() + R.SHARE_JS + R.TRACK_JS + '\n</body>\n</html>\n';
  return h;
}

/* ------------------------------------------------------------ the hub */
const ABOUT = {
  weekly_clv: 'My card for the week: every number against the close, the CLV, the record, wins and losses.',
  disagreement: 'Where my number sits furthest from the market, what is inside it, and what my record says gaps like it are worth.',
  line_movement: 'The biggest moves from open to close, the key numbers crossed, and whether my side beat the close.',
  got_wrong: 'Once a month, my worst numbers on purpose, and what the audits say went wrong.',
  research_notes: 'Plain-English notes on registered studies. Experimental stays labelled experimental.'
};
function hub(recs) {
  const url = HUB;
  const sorted = recs.slice().sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  let h = '<!doctype html>\n<html lang="en">\n<head>\n';
  h += R.head({ title: 'From my desk: CLV reports, disagreements and misses | EdgeDesk', og_type: 'website',
    description: 'Built only on data I own: my weekly card against the close, my disagreements with the market, line moves, my worst misses and study notes.',
    canonical: url, og_title: 'From my desk', ld: [{
      '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'From my desk', url: url, author: R.personLD(),
      mainEntity: { '@type': 'ItemList', itemListElement: sorted.slice(0, 50).map((r, i) => ({ '@type': 'ListItem', position: i + 1, url: urlOf(r), name: r.title })) } }] });
  h += '</head>\n<body class="a-body" data-ed-page="research_hub:desk">\n' + R.siteHeader('/articles/');
  h += '<main class="a-wrap" id="main"><article class="a-article">';
  h += '<nav class="a-crumbs" aria-label="Breadcrumb"><a href="/articles/">Research</a> <span>›</span> <span aria-current="page">From my desk</span></nav>';
  h += '<header class="a-hero"><span class="d-type">From my desk</span><h1 class="a-h1">Data only I have, and what I make of it</h1>';
  h += R.bylineHTML({}) + '</header>';
  h += '<div class="d-body"><p>Every article here is built from my own logged numbers: what I published, the price I took, where the market closed, and how it graded. A machine drafts the tables. Nothing publishes until I have written my take on it, and every number links back to the file it came from.</p></div>';
  Object.keys(D.TYPES).forEach(t => {
    const list = sorted.filter(r => r.type === t);
    h += '<section class="a-sec"><h2 class="a-h2">' + esc(D.TYPES[t].label) + '</h2><p class="a-secnote">' + esc(ABOUT[t]) + '</p>';
    h += list.length ? '<div class="d-cards">' + list.map(cardHTML).join('') + '</div>' : '<p class="a-secnote">Nothing published here yet.</p>';
    h += '</section>';
  });
  h += R.authorBoxHTML() + '</article></main>' + R.siteFooter() + R.TRACK_JS + '\n</body>\n</html>\n';
  return h;
}
/* The block on /articles/: the newest desk articles, above the game pages. */
function strip(recs) {
  if (!recs.length) return '';
  const sorted = recs.slice().sort((a, b) => String(b.published_at).localeCompare(String(a.published_at))).slice(0, 4);
  return '<section class="a-sec"><h2 class="a-h2">From my desk</h2><p class="a-secnote">Built only on data I own: my card against the close, my misses, my disagreements with the market. <a href="/articles/desk/">All of them →</a></p>'
    + '<div class="d-cards">' + sorted.map(cardHTML).join('') + '</div></section>';
}

/* --------------------------------------------------------- author page */
function authorPage(recs) {
  const A = R.AUTHOR, url = A.url;
  const sorted = recs.slice().sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  let h = '<!doctype html>\n<html lang="en">\n<head>\n';
  h += R.head({ title: A.name + ' | EdgeDesk', og_type: 'profile', description: A.bio, canonical: url, og_title: A.name,
    ld: [{ '@context': 'https://schema.org', '@type': 'ProfilePage', url: url, mainEntity: R.personLD() }] });
  h += '</head>\n<body class="a-body" data-ed-page="author">\n' + R.siteHeader('/articles/');
  h += '<main class="a-wrap" id="main"><article class="a-article">';
  h += '<header class="a-hero"><span class="d-type">Author</span><h1 class="a-h1">' + esc(A.name) + '</h1></header>';
  h += '<div class="au-box">' + R.avatarHTML(88) + '<div class="au-boxt"><p class="au-boxb">' + esc(A.bio) + '</p>'
    + '<p class="au-boxb">I write every "My take" on this site myself. The tables are drafted from my logged data and checked against their source files before I can publish them.</p>'
    + '<p class="au-boxl"><a href="' + esc(A.record_url) + '">' + esc(A.record_label) + '</a><a href="/performance/">Model performance</a><a href="/methodology/">How I build the numbers</a></p></div></div>';
  if (sorted.length) h += '<section class="a-sec"><h2 class="a-h2">From my desk</h2><div class="d-cards">' + sorted.slice(0, 24).map(cardHTML).join('') + '</div></section>';
  h += '</article></main>' + R.siteFooter() + R.TRACK_JS + '\n</body>\n</html>\n';
  return h;
}

/* The checks a published desk record must still pass at build time. The
   database already refused anything worse; this is the build refusing to
   ship a record that was edited by hand in the repository. */
function publishable(rec, minTake) {
  const failed = [];
  const take = String(rec.my_take || '').replace(/\s+/g, ' ').trim();
  if (take.length < (minTake || D.MIN_TAKE_CHARS)) failed.push({ id: 'my_take', why: 'My take is ' + take.length + ' characters' });
  const snap = rec.data_snapshot || {};
  if (!Array.isArray(snap.numbers) || !snap.numbers.length) failed.push({ id: 'snapshot', why: 'no traced numbers' });
  const v = D.voiceCheck([rec.title, rec.lead, rec.body_md].join('\n\n'));
  if (!v.ok) failed.push({ id: 'voice', why: v.issues.map(i => i.id).join(', ') });
  if (!/^[a-z0-9-]{3,70}$/.test(rec.slug || '')) failed.push({ id: 'slug', why: 'slug ' + rec.slug });
  const draft = { title: rec.title, lead: rec.lead, highlights: rec.highlights, description: rec.description, body_md: rec.body_md, numbers: snap.numbers, facts: snap.facts };
  const allowed = new Set();
  (snap.numbers || []).forEach(n => D.numberTokens(n.display).forEach(t => allowed.add(t)));
  (snap.facts || []).forEach(f => D.numberTokens(f.value).forEach(t => allowed.add(t)));
  const stray = D.numberTokens([draft.title, draft.lead, draft.body_md].join('\n')).filter(t => !allowed.has(t));
  if (stray.length) failed.push({ id: 'untraced_number', why: stray.slice(0, 6).join(', ') });
  return { ok: !failed.length, failed };
}

module.exports = { page, hub, strip, authorPage, structuredData, publishable, urlOf, cardHTML, seoTitle };
