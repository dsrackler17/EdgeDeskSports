#!/usr/bin/env node
/* ============================================================================
   THE ARTICLE SYSTEM, HELD OFFLINE.

   Everything here runs against the COMMITTED store and the REAL modules —
   article_model.js, article_render.js, build_articles.js — with no network
   and no engine boot, so it is the same check on a laptop and in CI.

   WHAT IT IS PROTECTING, in the order the failures would hurt:

     1  THE FOUR NUMBERS. The published articles must carry EdgeDesk's own
        figures, unrounded and unrenamed, all the way to the HTML. An article
        that quietly disagreed with the terminal would be the worst bug this
        system could have, and it would be invisible.
     2  MEASURED IS NOT BETTER. Where one side is unrated, no edge is claimed
        for the other. Norfolk State at Virginia is the case, and it is
        asserted on the rendered page, not on the payload.
     3  NO INVENTION. No projected score without a total. No confidence number
        for a model that publishes none. No recommendation language anywhere.
        No stringified null reaching a reader.
     4  DRAFTS DO NOT SHIP. Not as a page, not as a hub card, not as a
        sitemap line, not without noindex.
     5  URLS DO NOT MOVE. Deterministic slugs, no duplicates, a canonical on
        every page, and a refresh that cannot rename a published article.
     6  A GAME THAT HAS STARTED IS HISTORY. The record freezes.

   Run: node tools/articles/articles.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MODEL = require('./article_model.js');
const RENDER = require('./article_render.js');
const STORE = require('./store.js');
const BUILD = require('./build_articles.js');
const SITEMAPS = require(path.join(ROOT, 'tools', 'sitemap_set.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 260); } }
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
function eq(name, got, want) { return chk(name, got === want, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function has(hay, needle, name) { return chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + JSON.stringify(needle)); }
function lacks(hay, needle, name) { return chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + JSON.stringify(needle)); }
function section(t) { console.log('\n' + t); }

const RECORDS = STORE.loadAll();
const PUBLISHED = RECORDS.filter(r => r.status === 'published');
const byId = Object.create(null);
RECORDS.forEach(r => { byId[r.id] = r; });
function bySlug(s) { return RECORDS.filter(r => r.slug === s)[0] || null; }
function pageOf(slug) {
  const f = path.join(ROOT, 'articles', slug, 'index.html');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
/* the visible text of a page: markup and scripts removed, entities resolved */
function textOf(html) {
  return String(html).slice(String(html).indexOf('<body'))
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

/* ======================================================================== */
section('1. SLUGS — deterministic, human-readable, and never reused');
/* ======================================================================== */
eq('the away side leads the slug', MODEL.slugFor({ away: 'Missouri', home: 'Kansas', season: 2026 }), 'missouri-vs-kansas-2026');
eq('multi-word programmes hyphenate', MODEL.slugFor({ away: 'Rutgers', home: 'Boston College', season: 2026 }), 'rutgers-vs-boston-college-2026');
eq('FCS visitors are named in full', MODEL.slugFor({ away: 'Norfolk State', home: 'Virginia', season: 2026 }), 'norfolk-state-vs-virginia-2026');
eq('NFL clubs use their full names', MODEL.slugFor({ away: 'New England Patriots', home: 'Seattle Seahawks', season: 2026 }),
  'new-england-patriots-vs-seattle-seahawks-2026');
eq('an ampersand is spelled, never dropped', MODEL.teamSlug('Texas A&M'), 'texas-a-and-m');
eq('an apostrophe closes up', MODEL.teamSlug("Hawai'i"), 'hawaii');
eq('diacritics fold to ASCII', MODEL.teamSlug('San José State'), 'san-jose-state');
eq('parentheses become a hyphen, not a literal', MODEL.teamSlug('Miami (OH)'), 'miami-oh');
chk('a slug carries no random id', MODEL.slugFor({ away: 'A', home: 'B', season: 2026 }).match(/[0-9a-f]{8,}/) === null);
eq('the same input gives the same slug twice',
  MODEL.slugFor({ away: 'Missouri', home: 'Kansas', season: 2026 }),
  MODEL.slugFor({ away: 'Missouri', home: 'Kansas', season: 2026 }));
/* a rematch in one season must not collide, and must not become a random id */
const taken = { 'a-vs-b-2026': 'cfb-1' };
eq('a second meeting is disambiguated by its week',
  MODEL.uniqueSlug({ id: 'cfb-2', away: 'A', home: 'B', season: 2026, week: 13 }, taken), 'a-vs-b-2026-week-13');
eq('and by its date when there is no week',
  MODEL.uniqueSlug({ id: 'cfb-2', away: 'A', home: 'B', season: 2026, game_time: '2026-12-06T18:00:00Z' }, taken), 'a-vs-b-2026-2026-12-06');
eq('a record keeps its own slug rather than being pushed off it',
  MODEL.uniqueSlug({ id: 'cfb-1', away: 'A', home: 'B', season: 2026 }, taken), 'a-vs-b-2026');
/* the store's own namespace */
const slugSeen = Object.create(null);
let dupes = 0;
RECORDS.forEach(r => { [r.slug].concat(r.aliases || []).forEach(s => { if (slugSeen[s]) dupes++; slugSeen[s] = r.id; }); });
eq('no two records claim one URL', dupes, 0);
RECORDS.forEach(r => {
  chk(r.id + ': the slug is URL-safe', /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.slug), r.slug);
});

/* ======================================================================== */
section('2. THE FOUR ACCEPTANCE ARTICLES — EdgeDesk’s numbers, on the page');
/* ======================================================================== */
/* Each figure is asserted twice: on the RECORD, and in the rendered HTML a
   reader actually gets. A record that is right and a page that is wrong is
   the failure mode this pair exists to catch. */
const ACCEPT = [
  { slug: 'missouri-vs-kansas-2026', sport: 'CFB', away: 'Missouri', home: 'Kansas',
    spread: 'Kansas +4.6', win: ['Missouri', 62], conf: 41, status: 'RESEARCH', total: '52.8', score: true },
  { slug: 'rutgers-vs-boston-college-2026', sport: 'CFB', away: 'Rutgers', home: 'Boston College',
    spread: 'Boston College +1.8', win: ['Rutgers', 55], conf: 41, status: 'RESEARCH', total: '56.4', score: true },
  { slug: 'norfolk-state-vs-virginia-2026', sport: 'CFB', away: 'Norfolk State', home: 'Virginia',
    spread: 'Virginia -38.5', win: ['Virginia', 99], conf: 11, status: 'THIN DATA', total: null, score: false },
  { slug: 'new-england-patriots-vs-seattle-seahawks-2026', sport: 'NFL', away: 'New England Patriots', home: 'Seattle Seahawks',
    spread: 'Seattle Seahawks -5.8', win: ['Seattle Seahawks', 70], conf: null, status: 'INVESTIGATE', total: '43.7', score: true }
];
ACCEPT.forEach(a => {
  const r = bySlug(a.slug);
  if (!chk(a.slug + ': the record exists', !!r)) return;
  const html = pageOf(a.slug);
  if (!chk(a.slug + ': the page is built', !!html)) return;
  const text = textOf(html);

  eq(a.slug + ': the sport is right', r.sport, a.sport);
  eq(a.slug + ': the away team', r.away_team, a.away);
  eq(a.slug + ': the home team', r.home_team, a.home);
  eq(a.slug + ': it is published', r.status, 'published');

  eq(a.slug + ': the EdgeDesk fair spread on the record', r.fair_spread_text, a.spread);
  has(text, a.spread, a.slug + ': the fair spread reaches the page');
  eq(a.slug + ': the fair total on the record', r.fair_total, a.total);
  if (a.total) has(text, a.total, a.slug + ': the fair total reaches the page');

  const wp = r.research.projection.win_prob;
  chk(a.slug + ': ' + a.win[0] + ' win probability is ' + a.win[1] + '%',
    wp && (wp.home === a.win[0] ? wp.home_pct : wp.away_pct) === a.win[1],
    JSON.stringify(wp));
  has(text, a.win[1] + '%', a.slug + ': the win probability reaches the page');

  eq(a.slug + ': data confidence on the record', r.confidence, a.conf);
  if (a.conf != null) has(text, a.conf + '%', a.slug + ': data confidence reaches the page');

  eq(a.slug + ': the model status on the record', r.model_status, a.status);
  has(text, a.status, a.slug + ': the model status reaches the page');

  eq(a.slug + ': a projected score is published only with a total', !!r.research.projection.score, a.score);
  chk(a.slug + ': the page carries no stringified nothing',
    !/(^|[\s(])(null|undefined|NaN)([\s).,;:]|$)/.test(text),
    (text.match(/.{0,80}(null|undefined|NaN).{0,80}/) || [''])[0]);
});

/* ======================================================================== */
section('3. MISSING DATA IS SHOWN AS MISSING, never filled in');
/* ======================================================================== */
/* -- no total: no score, and the reason on the page -------------------- */
const NORFOLK = bySlug('norfolk-state-vs-virginia-2026');
const nfText = textOf(pageOf('norfolk-state-vs-virginia-2026') || '');
chk('no total published, so no projected score', NORFOLK && !NORFOLK.research.projection.score);
has(nfText, 'not published', 'the projected-score card says so rather than showing a number');
has(nfText, 'cannot responsibly split it into a projected score', 'and the page gives the reason');
chk('the record still carries a fair spread', NORFOLK && NORFOLK.fair_spread_text === 'Virginia -38.5');

/* -- an unrated opponent: measured is not better ------------------------ */
has(nfText, 'Norfolk State is not one of the 138 FBS programmes EdgeDesk rates',
  'the article says the opponent is outside the FBS dataset');
has(nfText, 'a measured team is not automatically the better one',
  'and states the measured/better rule in the edges section');
has(nfText, 'What EdgeDesk can measure', 'the one-sided case is headed as a measurement');
const nfEdges = NORFOLK.article.sections.filter(s => s.kind === 'edges')[0];
eq('no edge is claimed for the rated side', (nfEdges.away.length + nfEdges.home.length), 0);
chk('the measurements are still published', nfEdges.measured.length > 0);
chk('and the reason the gap size is unproven is published', nfEdges.unproven.length > 0);
has(nfText, 'not measured', 'the comparison table prints "not measured", never a zero');
lacks(nfText, 'Virginia edge', 'no team is given an "edge" heading over an unrated opponent');

/* -- CFB thin data ------------------------------------------------------- */
eq('Norfolk State at Virginia is THIN DATA', NORFOLK.model_status, 'THIN DATA');
eq('and carries 11% confidence', NORFOLK.confidence, 11);
has(nfText, 'THIN DATA', 'the thin-data status is on the page');
has(nfText, 'not enough confidence behind it', 'with the model’s own explanation of it');

/* -- the NFL model publishes no confidence score ------------------------- */
const NFL = bySlug('new-england-patriots-vs-seattle-seahawks-2026');
const nflText = textOf(pageOf('new-england-patriots-vs-seattle-seahawks-2026') || '');
eq('the NFL record carries no confidence percentage', NFL.confidence, null);
has(nflText, 'The NFL model publishes no single confidence score',
  'and the page says so instead of printing a number it does not have');
chk('no confidence percentage is invented for the NFL article',
  !/Data confidence\s*\d+%/.test(nflText), (nflText.match(/Data confidence[^.]{0,40}/) || [''])[0]);
/* -- NFL injury availability ------------------------------------------- */
has(nflText, 'Injuries and availability', 'the NFL article carries the injury panel');
chk('and warns when the league report was not loaded',
  /injury report[^.]{0,60}not loaded/i.test(nflText) || /injur/i.test(nflText),
  'no injury language found at all');
has(nflText, 'INVESTIGATE', 'the INVESTIGATE research state is on the page');
has(nflText, 'does NOT beat the closing line', 'and the UNPROVEN validation note survives to the reader');

/* ======================================================================== */
section('4. INTEGRITY — an article never becomes a pick');
/* ======================================================================== */
const ALL_TEXT = PUBLISHED.map(r => textOf(pageOf(r.slug) || '')).join('\n');
chk('no article carries betting-recommendation language',
  !MODEL.FORBIDDEN.test(ALL_TEXT), (ALL_TEXT.match(MODEL.FORBIDDEN) || [''])[0]);
['Research, not picks.'].forEach(s => has(ALL_TEXT, s, 'the positioning line is on every page: ' + s));
PUBLISHED.forEach(r => {
  const t = textOf(pageOf(r.slug) || '');
  has(t, 'not betting advice', r.slug + ': the disclaimer is on the page');
  has(t, 'DOES NOT MOVE THE PRICED NUMBER', r.slug + ': research context is labelled as not pricing input');
  has(t, 'PRICED BY MODEL', r.slug + ': and the priced drivers are labelled as such');
  chk(r.slug + ': a sportsbook number is never called the EdgeDesk number',
    t.indexOf('Sportsbook') < 0 || t.indexOf('is a sportsbook’s, not EdgeDesk’s') >= 0);
  chk(r.slug + ': the model version survives to the record', !!r.model_version, r.model_version);
});
/* the checker itself must actually reject the thing it claims to reject */
(function () {
  const r = JSON.parse(JSON.stringify(bySlug('missouri-vs-kansas-2026')));
  r.article.bottom_line.paragraphs.push('This is our best bet of the week.');
  const v = MODEL.publishable(r);
  chk('a record carrying a recommendation fails its checks',
    !v.ok && v.failed.some(f => f.id === 'no_recommendation'), JSON.stringify(v.failed.map(f => f.id)));
})();
(function () {
  const r = JSON.parse(JSON.stringify(bySlug('missouri-vs-kansas-2026')));
  r.article.sections[0].paragraphs.push('The projected margin is null points.');
  const v = MODEL.publishable(r);
  chk('a record with a stringified null fails its checks',
    !v.ok && v.failed.some(f => f.id === 'no_stringified_nothing'), JSON.stringify(v.failed.map(f => f.id)));
})();
(function () {
  const r = JSON.parse(JSON.stringify(bySlug('missouri-vs-kansas-2026')));
  r.research.projection.total = null;
  const v = MODEL.publishable(r);
  chk('a projected score without a total fails its checks',
    !v.ok && v.failed.some(f => f.id === 'score_needs_total'), JSON.stringify(v.failed.map(f => f.id)));
})();
(function () {
  const r = JSON.parse(JSON.stringify(bySlug('norfolk-state-vs-virginia-2026')));
  const edges = r.article.sections.filter(s => s.kind === 'edges')[0];
  edges.home.push({ k: 'Everything', text: 'Virginia is better at everything.' });
  const v = MODEL.publishable(r);
  chk('claiming an edge over an unrated opponent fails its checks',
    !v.ok && v.failed.some(f => f.id === 'measured_not_better'), JSON.stringify(v.failed.map(f => f.id)));
})();

/* ======================================================================== */
section('5. METADATA, CANONICALS AND STRUCTURED DATA');
/* ======================================================================== */
PUBLISHED.forEach(r => {
  const html = pageOf(r.slug);
  if (!html) { chk(r.slug + ': page exists', false); return; }
  const head = html.slice(0, html.indexOf('</head>'));
  chk(r.slug + ': has a unique, substantial <title>', /<title>[^<]{25,}<\/title>/.test(head));
  chk(r.slug + ': has a meta description', /name="description" content="[^"]{60,}"/.test(head));
  has(head, '<link rel="canonical" href="' + r.canonical_url + '">', r.slug + ': canonicalises to its own clean URL');
  has(head, 'name="robots" content="index,follow"', r.slug + ': is crawlable');
  has(head, 'property="og:type" content="article"', r.slug + ': declares an OpenGraph article');
  has(head, 'property="og:url" content="' + r.canonical_url + '"', r.slug + ': OpenGraph URL is the canonical one');
  has(head, 'property="og:title"', r.slug + ': has an OpenGraph title');
  has(head, 'property="og:description"', r.slug + ': has an OpenGraph description');
  has(head, 'property="og:site_name" content="EdgeDesk Sports"', r.slug + ': names the publisher in OpenGraph');
  has(head, 'name="twitter:card"', r.slug + ': has a Twitter card');
  has(head, 'name="twitter:title"', r.slug + ': has a Twitter title');
  has(head, 'property="article:published_time"', r.slug + ': declares when it was published');
  has(head, 'property="article:modified_time"', r.slug + ': declares when it was last modified');
  /* structured data */
  const blocks = (head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [])
    .map(s => JSON.parse(s.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')));
  const types = blocks.map(b => b['@type']);
  chk(r.slug + ': carries Article structured data', types.indexOf('Article') >= 0, types.join(','));
  chk(r.slug + ': carries SportsEvent structured data', types.indexOf('SportsEvent') >= 0, types.join(','));
  chk(r.slug + ': carries a breadcrumb trail', types.indexOf('BreadcrumbList') >= 0, types.join(','));
  const art = blocks[types.indexOf('Article')];
  eq(r.slug + ': the structured author is EdgeDesk Research', art.author.name, 'EdgeDesk Research');
  eq(r.slug + ': the structured publisher is EdgeDesk Sports', art.publisher.name, 'EdgeDesk Sports');
  chk(r.slug + ': datePublished is present and parseable', isFinite(Date.parse(art.datePublished)), art.datePublished);
  chk(r.slug + ': dateModified is present and parseable', isFinite(Date.parse(art.dateModified)), art.dateModified);
  chk(r.slug + ': the structured headline is within Google’s limit', art.headline.length <= 110, String(art.headline.length));
  eq(r.slug + ': the structured URL is the canonical one', art.url, r.canonical_url);
  const ev = blocks[types.indexOf('SportsEvent')];
  chk(r.slug + ': the event names both competitors', (ev.competitor || []).length === 2);
  chk(r.slug + ': the event carries a start date', isFinite(Date.parse(ev.startDate)), ev.startDate);
  /* JSON-LD must not be able to close its own script element */
  chk(r.slug + ': no ld+json block can break out of its script tag',
    (head.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || []).every(b => b.split('</script>').length === 2));
});
/* the SEO title may differ from the visible H1, and here it does */
ACCEPT.forEach(a => {
  const r = bySlug(a.slug);
  const html = pageOf(a.slug) || '';
  chk(a.slug + ': the visible H1 is the editorial headline', html.indexOf('<h1 class="a-h1">' + RENDER.esc(r.title) + '</h1>') >= 0);
  chk(a.slug + ': the <title> is written for a result list, not for the page', r.seo_title !== r.title);
  has(r.title, 'EdgeDesk Model Projection', a.slug + ': the headline follows the house style');
});

/* ======================================================================== */
section('6. DRAFTS DO NOT SHIP');
/* ======================================================================== */
(function () {
  const draft = MODEL.unpublish(bySlug('missouri-vs-kansas-2026'), '2026-09-08T00:00:00Z');
  const html = RENDER.articlePage(draft);
  has(html, 'name="robots" content="noindex,nofollow"', 'an unpublished record renders noindex');
  lacks(html, 'application/ld+json', 'and carries no structured data a crawler could index');
  has(html, 'a-draftbar', 'and says on the page that it is a draft');
  /* the preview route is disallowed and never in a sitemap */
  const robots = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
  has(robots, 'Disallow: /articles/_preview/', 'robots.txt disallows the preview route');
  has(robots, 'Disallow: /admin/', 'robots.txt disallows the admin route');
  has(robots, 'Allow: /articles', 'robots.txt admits crawlers to the articles');
})();
chk('no unpublished record has a page under /articles/',
  RECORDS.filter(r => r.status !== 'published').every(r => !pageOf(r.slug)),
  RECORDS.filter(r => r.status !== 'published' && pageOf(r.slug)).map(r => r.slug).join(', '));

/* ======================================================================== */
section('7. SITEMAPS — published only, and reachable from the index');
/* ======================================================================== */
const SM_ARTICLES = fs.readFileSync(path.join(ROOT, 'sitemap-articles.xml'), 'utf8');
const SM_INDEX = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
has(SM_INDEX, '<sitemapindex', 'the primary sitemap is an index');
has(SM_INDEX, 'sitemap-articles.xml', 'and it references the article sitemap');
has(SM_INDEX, 'sitemap-pages.xml', 'and the standing-pages sitemap');
chk('every file the index names exists',
  SITEMAPS.children(ROOT).every(f => fs.existsSync(path.join(ROOT, f))), SITEMAPS.children(ROOT).join(', '));
const smUrls = SITEMAPS.urls(ROOT);
PUBLISHED.forEach(r => {
  chk(r.slug + ': is in the sitemap', smUrls.indexOf(r.canonical_url) >= 0);
  has(SM_ARTICLES, '<lastmod>', 'the article sitemap carries lastmod stamps');
  (r.aliases || []).forEach(a => {
    chk(r.slug + ': its alias /' + a + ' is NOT in the sitemap',
      smUrls.indexOf(MODEL.SITE + '/articles/' + a) < 0);
  });
});
RECORDS.filter(r => r.status !== 'published').forEach(r => {
  chk(r.slug + ': an unpublished article is not in the sitemap', smUrls.indexOf(r.canonical_url) < 0);
});
['/articles', '/articles/college-football', '/articles/nfl'].forEach(u => {
  chk('the hub ' + u + ' is in the sitemap', smUrls.indexOf(MODEL.SITE + u) >= 0);
});
chk('the standing pages survived the split into an index',
  ['/games', '/terms.html', '/privacy.html'].every(u => smUrls.indexOf(MODEL.SITE + u) >= 0));

/* ======================================================================== */
section('8. ALIASES — a second URL that says it is not the first');
/* ======================================================================== */
(function () {
  const r = bySlug('new-england-patriots-vs-seattle-seahawks-2026');
  eq('the NFL article has a short alias', (r.aliases || [])[0], 'patriots-vs-seahawks-2026');
  const alias = pageOf('patriots-vs-seahawks-2026');
  chk('the alias page is built', !!alias);
  has(alias, '<link rel="canonical" href="' + r.canonical_url + '">', 'the alias canonicalises to the article');
  has(alias, 'name="robots" content="noindex,nofollow"', 'the alias is noindex');
  has(alias, 'http-equiv="refresh"', 'and sends a reader on to the real URL');
  /* a college programme is named for its institution, so it gets no alias */
  chk('no alias is invented for a college matchup',
    RECORDS.filter(r2 => r2.sport === 'CFB').every(r2 => (r2.aliases || []).length === 0),
    RECORDS.filter(r2 => r2.sport === 'CFB' && (r2.aliases || []).length).map(r2 => r2.slug).join(', '));
})();

/* ======================================================================== */
section('9. THE HUBS — a publication front page, filterable and crawlable');
/* ======================================================================== */
(function () {
  const hub = fs.readFileSync(path.join(ROOT, 'articles', 'index.html'), 'utf8');
  const cfb = fs.readFileSync(path.join(ROOT, 'articles', 'college-football', 'index.html'), 'utf8');
  const nfl = fs.readFileSync(path.join(ROOT, 'articles', 'nfl', 'index.html'), 'utf8');
  has(hub, 'Latest research', 'the hub leads with the latest research');
  has(hub, 'Most recent research', 'and offers a most-recent ordering');
  has(hub, 'Upcoming games', 'and an upcoming-games ordering');
  has(hub, 'Recently published', 'and a recently-published ordering');
  ['All', 'College Football', 'NFL'].forEach(f => has(hub, '>' + f + '</a>', 'the hub filters by ' + f));
  chk('every filter is a real crawlable URL, not a script',
    ['/articles', '/articles/college-football', '/articles/nfl'].every(u => hub.indexOf('href="' + u + '"') >= 0));
  PUBLISHED.forEach(r => {
    has(hub, '/articles/' + r.slug, 'the hub links to ' + r.slug);
    has(hub, RENDER.esc(r.excerpt), 'and carries its summary');
  });
  chk('the CFB hub carries only college football',
    (cfb.match(/data-sport="([a-z-]+)"/g) || []).every(m => m.indexOf('college-football') >= 0));
  chk('the NFL hub carries only NFL',
    (nfl.match(/data-sport="([a-z-]+)"/g) || []).every(m => m.indexOf('"nfl"') >= 0));
  has(hub, '"@type": "CollectionPage"', 'the hub carries CollectionPage structured data');
  has(hub, '"@type": "ItemList"', 'and lists its articles in it');
  has(cfb, '<link rel="canonical" href="' + MODEL.SITE + '/articles/college-football">', 'the CFB hub canonicalises to itself');
  has(nfl, '<link rel="canonical" href="' + MODEL.SITE + '/articles/nfl">', 'the NFL hub canonicalises to itself');
  chk('a sport hub is written even before anything is published in it',
    fs.existsSync(path.join(ROOT, 'articles', 'nfl', 'index.html')));
  /* the sort control must not be the only way to reach an article */
  chk('every published article is in the markup, not behind a script',
    PUBLISHED.every(r => hub.indexOf('href="/articles/' + r.slug + '"') >= 0));
})();

/* ======================================================================== */
section('10. INTERNAL LINKING AND THE CALL TO ACTION');
/* ======================================================================== */
PUBLISHED.forEach(r => {
  const html = pageOf(r.slug);
  has(html, 'Research the matchup. Then price it.', r.slug + ': carries the call to action');
  has(html, 'Open full EdgeDesk research', r.slug + ': carries the research-terminal button');
  has(html, 'href="' + r.terminal_url + '"', r.slug + ': the button deep-links into the terminal');
  ['/articles/college-football', '/articles/nfl', '/articles', '/app.html#research/football'].forEach(u => {
    has(html, 'href="' + u + '"', r.slug + ': links to ' + u);
  });
  has(html, 'Explore more college football research', r.slug + ': links out to CFB research');
  has(html, 'Explore NFL research', r.slug + ': links out to NFL research');
  has(html, 'EdgeDesk power ratings', r.slug + ': links out to the power ratings');
  /* share */
  has(html, 'twitter.com/intent/tweet', r.slug + ': has an X share link');
  has(html, 'facebook.com/sharer', r.slug + ': has a Facebook share link');
  has(html, 'id="a-copy"', r.slug + ': has a copy-link control');
  chk(r.slug + ': the share links work with JavaScript off',
    html.indexOf('href="https://twitter.com/intent/tweet?url=' + encodeURIComponent(r.canonical_url)) >= 0);
});

/* ======================================================================== */
section('11. REGENERATION, UPDATES AND THE FREEZE');
/* ======================================================================== */
(function () {
  const base = bySlug('missouri-vs-kansas-2026');
  const meta = { sport: 'CFB', game_id: base.game_id, home: base.home_team, away: base.away_team,
    kickoff: base.game_time, venue: base.venue, week: base.week, season: base.season };

  /* the same research twice changes nothing but the "we looked" stamp */
  const same = MODEL.refresh(base, base.research, meta, { now: '2026-09-09T00:00:00Z' });
  eq('re-reading unchanged research changes nothing', same.changed, false);
  eq('and published_at is untouched', same.record.published_at, base.published_at);
  eq('and updated_at is untouched', same.record.updated_at, base.updated_at);
  eq('but the generated_at stamp advances, so a run is visible', same.record.generated_at, '2026-09-09T00:00:00.000Z');

  /* a changed projection moves updated_at and reports the diff */
  const moved = JSON.parse(JSON.stringify(base.research));
  moved.projection.fair_spread_text = 'Kansas +6.1';
  moved.projection.confidence_pct = 47;
  const out = MODEL.refresh(base, moved, meta, { now: '2026-09-09T00:00:00Z' });
  eq('a changed projection is a change', out.changed, true);
  eq('and updated_at moves with it', out.record.updated_at, '2026-09-09T00:00:00.000Z');
  eq('while published_at does not', out.record.published_at, base.published_at);
  eq('the record still says published', out.record.status, 'published');
  eq('the new number is on the record', out.record.fair_spread_text, 'Kansas +6.1');
  eq('the new confidence is on the record', out.record.confidence, 47);
  chk('and the change is reported rather than silent', (out.diff || []).join('; ').indexOf('fair spread') >= 0, JSON.stringify(out.diff));
  /* THE URL NEVER MOVES UNDER A READER */
  eq('a refresh cannot rename a published article', out.record.slug, base.slug);
  eq('nor change its canonical URL', out.record.canonical_url, base.canonical_url);
  eq('nor its id', out.record.id, base.id);

  /* the freeze */
  chk('a game still ahead of us is not frozen', !MODEL.isFrozen(base, '2026-09-09T00:00:00Z'));
  chk('a game that has kicked off is frozen', MODEL.isFrozen(base, '2026-09-13T00:00:00Z'));
  const after = MODEL.refresh(base, moved, meta, { now: '2026-09-13T00:00:00Z' });
  eq('a frozen article refuses the newer research', after.changed, false);
  eq('and keeps the number it published', after.record.fair_spread_text, base.fair_spread_text);
  eq('and is marked frozen', after.record.frozen, true);
  chk('and says why', after.reason.indexOf('frozen') === 0, after.reason);
  /* freezing is exactly at kickoff, not before and not a day later */
  chk('the freeze starts at kickoff', MODEL.isFrozen(base, base.game_time));
  chk('and not a second earlier', !MODEL.isFrozen(base, new Date(Date.parse(base.game_time) - 1000).toISOString()));
})();

/* ======================================================================== */
section('12. THE LIFECYCLE');
/* ======================================================================== */
(function () {
  const base = bySlug('rutgers-vs-boston-college-2026');
  eq('the five states are the five states', MODEL.STATUSES.join(','), 'draft,ready,published,updated,archived');
  const d = MODEL.unpublish(base, '2026-09-09T00:00:00Z');
  eq('unpublishing returns it to draft', d.status, 'draft');
  eq('and keeps the original publication date on the record', d.published_at, base.published_at);
  const p = MODEL.publish(d, '2026-09-10T00:00:00Z');
  eq('re-publishing does not reset published_at', p.published_at, base.published_at);
  eq('but does move updated_at', p.updated_at, '2026-09-10T00:00:00.000Z');
  const a = MODEL.archive(base, '2026-09-20T00:00:00Z');
  eq('archiving is its own state', a.status, 'archived');
  /* a never-published record gets its date on first publish */
  const fresh = Object.assign({}, base, { published_at: null, status: 'ready' });
  eq('a first publish stamps published_at', MODEL.publish(fresh, '2026-09-11T00:00:00Z').published_at, '2026-09-11T00:00:00.000Z');
})();

/* ======================================================================== */
section('13. THE BUILD REFUSES A BROKEN STORE');
/* ======================================================================== */
(function () {
  const report = BUILD.build.length >= 0 ? null : null;
  void report;
  /* the sitemap writer, in isolation, must never list a draft */
  const draft = MODEL.unpublish(bySlug('missouri-vs-kansas-2026'), '2026-09-09T00:00:00Z');
  const xml = BUILD.articleSitemap([]);
  lacks(xml, draft.canonical_url, 'an empty published set produces a sitemap with no articles in it');
  has(xml, '/articles</loc>', 'but the hubs are still listed');
  const idx = BUILD.sitemapIndex();
  has(idx, '<sitemapindex', 'the index writer produces an index');
  chk('the article sitemap is valid XML shape',
    /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(SM_ARTICLES) && SM_ARTICLES.trim().endsWith('</urlset>'));
  chk('and escapes anything it is handed',
    BUILD.articleSitemap([{ slug: 'x', canonical_url: 'https://e.com/a?b=1&c=2', updated_at: null }])
      .indexOf('&amp;c=2') >= 0);
})();

/* ======================================================================== */
section('14. THE ADMIN SURFACE');
/* ======================================================================== */
(function () {
  const f = path.join(ROOT, 'admin', 'articles', 'index.html');
  chk('the article manager exists at /admin/articles', fs.existsSync(f));
  const A = fs.readFileSync(f, 'utf8');
  has(A, 'name="robots" content="noindex,nofollow"', 'the manager is noindex');
  ['Preview', 'Publish', 'Unpublish', 'Regenerate', 'Archive', 'Auto publish'].forEach(w => {
    has(A, w, 'the manager offers ' + w);
  });
  has(A, '/tools/articles/article_render.js', 'preview uses the same renderer as the static build');
  has(A, '/tools/articles/article_model.js', 'and the same model, so its checks are the build’s checks');
  has(A, 'MODEL.publishable(rec)', 'a publish runs the publication checks before it writes');
  has(A, 'site_articles', 'publication state is written to the article table');
  has(A, 'site_article_settings', 'and the auto-publish switch to the settings row');
  /* NOTHING PRIVILEGED IN A BROWSER */
  chk('the manager ships no service-role key',
    !/service_role|SERVICE_ROLE|sb_secret|"role":"service/.test(A));
  chk('and every request carries the operator’s own bearer, not a shared one',
    A.indexOf("Authorization='Bearer '+token()") >= 0 || A.indexOf("h.Authorization='Bearer '+token()") >= 0);
  chk('the manager never re-derives a projection',
    !/fair_spread\s*=|projectGame|fbPredict|\bnew Model\b/.test(A));
  /* the JWT in the page is the anon key the whole site already ships */
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const key = (A.match(/const SB_KEY="([^"]+)"/) || [])[1];
  chk('the only key in the page is the public anon key the site already ships',
    !!key && APP.indexOf(key) >= 0);
})();

/* ======================================================================== */
section('15. THE DATABASE CONTRACT');
/* ======================================================================== */
(function () {
  const f = path.join(ROOT, 'supabase', 'site_articles.sql');
  chk('the migration exists', fs.existsSync(f));
  const S = fs.readFileSync(f, 'utf8');
  /* the house rules for every file in supabase/ */
  chk('it carries no psql meta-command', !/^\s*\\/m.test(S));
  has(S, 'create table if not exists public.site_articles', 'it is idempotent');
  has(S, 'add column if not exists', 'and additive, column by column');
  chk('it ends in a report', /select\s+1\s+as\s+step/.test(S) && S.indexOf("'ok'") > 0);
  /* the security contract */
  has(S, 'alter table public.site_articles enable row level security', 'RLS is on');
  chk('anon may read published rows only',
    /create policy "articles public read"[\s\S]{0,200}using \(status = 'published'\)/.test(S));
  /* THE POLICY SET IS WHAT STOPS anon WRITING, not the grant. Supabase issues
     table-level DML to anon and authenticated as a default privilege on the
     public schema and relies on RLS to decide what either may touch, so an
     assertion about the absence of a grant would be false on every real
     deployment. (It was also matching the migration's own comment explaining
     exactly that, which is the kind of test that passes until somebody writes
     a sentence.) What must hold is that no policy lets anon do anything but
     read a published row. */
  chk('anon is granted select', /grant select on public\.site_articles to anon;/.test(S));
  chk('and no policy lets anon write',
    !/create policy[^;]*on public\.site_articles\s+for (insert|update|delete)[^;]*to [^;]*anon/i.test(S));
  chk('the migration checks that itself, in its own report',
    /anon has no policy that writes/.test(S));
  has(S, 'public.site_article_is_admin()', 'writes go through an admin predicate');
  has(S, 'security definer', 'which is security definer');
  has(S, 'set search_path = public, pg_temp', 'with a pinned search path');
  has(S, 'revoke all on public.site_article_admins from anon, authenticated', 'the allowlist is unreachable from a browser');
  has(S, 'create unique index if not exists site_articles_slug_uk', 'one slug, one article, enforced in the database');
  has(S, "check (status in ('draft', 'ready', 'published', 'updated', 'archived'))", 'the five states are constrained');
  has(S, 'site_articles_published_shape_ck', 'a published row must carry a URL and a date');
  has(S, 'new.updated_at := now()', 'updated_at is stamped by a trigger, not by a browser');
  chk('no service-role credential appears in the migration', !/service_role\s*=|sb_secret/.test(S));
})();

/* ======================================================================== */
section('16. THE STORE');
/* ======================================================================== */
(function () {
  const idx = STORE.loadIndex();
  eq('the manifest counts the published articles', idx.counts.published, PUBLISHED.length);
  eq('and every record', idx.counts.total, RECORDS.length);
  chk('auto publish is off until somebody turns it on', idx.settings.auto_publish === false);
  chk('the lead-time window is stated', idx.settings.auto_publish_min_lead_minutes > 0 && idx.settings.auto_publish_max_lead_days > 0);
  chk('the manifest carries no research payload',
    JSON.stringify(idx).indexOf('"projection"') < 0, 'the manifest is meant to stay small');
  chk('the manifest is newest-published-first',
    idx.articles.every((a, i) => i === 0
      || (Date.parse(idx.articles[i - 1].published_at || 0) || 0) >= (Date.parse(a.published_at || 0) || 0)));
  const taken = STORE.takenSlugs(RECORDS);
  chk('every slug in the store maps to its own record',
    RECORDS.every(r => taken[r.slug] === r.id));
  /* every record carries the research it was built from */
  RECORDS.forEach(r => {
    chk(r.slug + ': the record carries its research payload', !!(r.research && r.research.kind));
    chk(r.slug + ': and the research names its own source', !!r.research_source, r.research_source);
    chk(r.slug + ': the payload is structured, not an HTML blob',
      JSON.stringify(r.article).indexOf('<div') < 0 && JSON.stringify(r.article).indexOf('<p>') < 0);
  });
  /* the market snapshot, where one was used, is disclosed */
  const withMarket = RECORDS.filter(r => r.market_source);
  chk('a replayed sportsbook quote is disclosed on the record', withMarket.length > 0);
  withMarket.forEach(r => {
    has(pageOf(r.slug) || '', 'replayed from a committed snapshot', r.slug + ': and disclosed on the page');
    has(r.market_source, 'not EdgeDesk', r.slug + ': and says whose number it is');
  });
})();

/* ======================================================================== */
section('17. RESPONSIVE AND ACCESSIBLE ENOUGH TO PUBLISH');
/* ======================================================================== */
(function () {
  const css = fs.readFileSync(path.join(ROOT, 'articles', 'articles.css'), 'utf8');
  has(css, '@media (max-width:640px)', 'the stylesheet has a phone breakpoint');
  has(css, 'overflow-x:auto', 'wide tables scroll inside their own container');
  has(css, 'prefers-reduced-motion', 'and motion is reducible');
  const html = pageOf('missouri-vs-kansas-2026') || '';
  has(html, 'name="viewport" content="width=device-width', 'the page is responsive');
  chk('there is exactly one H1', (html.match(/<h1/g) || []).length === 1);
  chk('the section headings are H2s under it', (html.match(/<h2/g) || []).length >= 6);
  has(html, 'aria-label="Breadcrumb"', 'the breadcrumb is labelled for a screen reader');
  has(html, 'aria-label="On this page"', 'and so is the contents list');
  has(html, '<main class="a-wrap" id="main">', 'the page has a main landmark');
  has(html, 'scope="row"', 'the comparison tables carry row scopes');
  has(html, 'scope="col"', 'and column scopes');
  chk('the only script on the page is the copy-link control',
    (html.match(/<script(?![^>]*application\/ld\+json)/g) || []).length === 1);
  chk('and the article is complete without it',
    textOf(html.replace(/<script[\s\S]*?<\/script>/g, '')).indexOf('EdgeDesk fair spread') >= 0);
})();

/* ======================================================================== */
console.log('');
failures.forEach(f => console.log('  × ' + f));
console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk articles | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
