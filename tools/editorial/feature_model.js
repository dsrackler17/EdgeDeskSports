/*__EDED_FEATURE_START__*/
/* ============================================================================
   EDGEDESK FEATURES — the site's own Monday, Wednesday and Friday articles,
   as a third type in the one article store (pregame, postgame, feature).

   The writing, the research and the twelve publication gates live in
   lib/content_engine.js (firstParty); tools/editorial/features.js runs the
   calendar. This file is what makes a feature an ordinary citizen of the
   site: a registered type (checks, articleFor, compact) and the two pages it
   needs, rendered server-side through the same chrome, head and tracking as
   every other article (tools/articles/article_render.js).

   A FEATURE IS NOT ABOUT ONE GAME. It has no game_id and no SportsEvent; its
   structured data is a NewsArticle and a BreadcrumbList. Its records live in
   features/records/, outside articles/, because the editorial and publishing
   jobs restore articles/ wholesale when their pushes race: a record there
   could be deleted by a job that never knew about it. The build reads both.

   ONE CALL TO ACTION. The page carries "Explore the full matchup research on
   EdgeDesk." and nothing else that asks the reader for anything: no trial
   strip, no header button. Internal links carry no campaign tags.
   ========================================================================== */
(function (root, factory) {
  var node = typeof module === 'object' && module && module.exports;
  var AMODEL = node ? require('../articles/article_model.js') : (root.EDART && root.EDART.model);
  var R = node ? require('../articles/article_render.js') : (root.EDART && root.EDART.render);
  var CE = node ? require('../../lib/content_engine.js') : root.EDContentEngine;
  var api = factory(AMODEL, R, CE);
  if (node) module.exports = api;
  root.EDED = root.EDED || {};
  root.EDED.feature = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AMODEL, R, CE) {
  'use strict';

  var SITE = 'https://edgedesksports.com';
  var HUB = SITE + '/articles/features/';
  var KINDS = {
    weekend_review: { label: 'Weekend Model Review', slug: 'weekend-model-review', blurb: 'Every Monday: the weekend’s results against the numbers EdgeDesk published before kickoff.' },
    storylines: { label: 'Weekend Storylines', slug: 'weekend-storylines', blurb: 'Every Wednesday: the upcoming weekend’s biggest storylines, each built on a number.' },
    research_preview: { label: 'Weekend Research Preview', slug: 'weekend-research-preview', blurb: 'Every Friday: the weekend in five numbers, each one explained.' }
  };
  var CTA_TEXT = 'Explore the full matchup research on EdgeDesk.';
  var CTA_HREF = '/today/';
  var DISCLAIMER = 'EdgeDesk publishes research, not betting advice. Nothing in this article is a pick, a wager or a recommendation. 21+. Gamble responsibly — 1-800-GAMBLER.';
  var FORBIDDEN = /\b(best bets?|lock of the|locks? of|guaranteed win|our pick is|take the points|hammer(?:ing)? the|free money|can'?t lose|sure thing|mortal lock|bet the)\b/i;
  var NOTHING = /(^|[\s>(/])(null|undefined|NaN)([\s<).,;:/%]|$)/;

  function esc(s) { return R.esc(s); }
  function iso(t) { var d = t ? Date.parse(t) : NaN; return isFinite(d) ? new Date(d).toISOString() : null; }
  /* dates as a reader in the publishing time zone reads them */
  function ctLabel(t, withTime) {
    var d = Date.parse(t); if (!isFinite(d)) return '';
    var o = { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' };
    if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; }
    return new Intl.DateTimeFormat('en-US', o).format(new Date(d)) + (withTime ? ' CT' : '');
  }
  function hash(s) { return CE && CE.util && CE.util.hash ? CE.util.hash(s) : null; }
  function contentHash(rec) { return hash(rec.title + '\n' + rec.standfirst + '\n' + (rec.sections || []).map(function (x) { return x.body; }).join('\n\n')); }
  function prose(md) {
    if (CE && CE.mdToHtml) return CE.mdToHtml(md);
    return String(md || '').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('\n');
  }
  function plain(md) { return String(md || '').replace(/\]\([^)]*\)/g, ']').replace(/[*_#\[\]]/g, ''); }

  /* ------------------------------------------------------------ the type */
  function articleFor(rec) {
    var k = KINDS[rec.feature_kind] || {};
    return {
      hero: { eyebrow: k.label || 'EdgeDesk feature', headline: rec.title, standfirst: rec.standfirst },
      sections: (rec.sections || []).map(function (s) { return { kind: 'feature', title: s.heading || null, key: s.key, text: plain(s.body) }; }),
      cta: { line: CTA_TEXT, href: CTA_HREF },
      footer: { disclaimer: rec.disclaimer || DISCLAIMER }
    };
  }
  function compact(rec) { var c = Object.assign({}, rec); delete c.article; return c; }
  /* what a feature must be before it is published, and stay while it is */
  function checks(rec) {
    var out = [];
    function chk(id, ok, why) { out.push({ id: id, ok: !!ok, why: why }); }
    var text = [rec.title, rec.standfirst].concat((rec.sections || []).map(function (s) { return (s.heading || '') + ' ' + s.body; })).join(' \n ');
    chk('kind', !!KINDS[rec.feature_kind], 'a feature is a Weekend Model Review, Storylines or a Research Preview');
    chk('slug', !!rec.slug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rec.slug), 'the slug must be lower-case and hyphenated');
    chk('title', !!rec.title && rec.title.length >= 20 && rec.title.length <= 75, 'a headline of 20–75 characters');
    chk('description', !!rec.seo_description && rec.seo_description.length >= 90 && rec.seo_description.length <= 160, 'a meta description of 90–160 characters');
    chk('canonical', rec.canonical_url === SITE + '/articles/' + rec.slug + '/', 'a feature canonicalises to its own URL and to no other site');
    chk('sections', (rec.sections || []).length >= 4, 'at least four sections');
    chk('disclaimer', (rec.disclaimer || '').indexOf('21+') >= 0 && (rec.disclaimer || '').indexOf('1-800-GAMBLER') >= 0, 'the 21+ responsible-gambling disclaimer');
    chk('not_a_bet', /not a bet|not betting advice|none of it is a pick|none of this is a pick|none of them a pick/i.test(text), 'the article says a projection is not a bet');
    chk('no_recommendation', !FORBIDDEN.test(text), 'no betting-recommendation language');
    chk('no_stringified_nothing', !NOTHING.test(text), 'no null, undefined or NaN in the copy');
    chk('no_internal_utm', !/edgedesksports\.com[^)\s]*[?&]utm_/.test(text), 'internal links carry no campaign tags');
    chk('integrity', !rec.content_hash || rec.content_hash === contentHash(rec), 'the text is the text the gates passed (content hash)');
    chk('gated', !!(rec.gates && rec.gates.length === 12 && rec.gates.every(function (g) { return g.ok; })) || !!rec.owner_approved, 'all twelve gates passed, or the owner approved it');
    return out;
  }

  /* ------------------------------------------------------------- the page */
  function structuredData(rec) {
    var k = KINDS[rec.feature_kind] || {};
    var art = {
      '@context': 'https://schema.org', '@type': 'NewsArticle',
      mainEntityOfPage: { '@type': 'WebPage', '@id': rec.canonical_url },
      headline: rec.title.length > 110 ? rec.title.slice(0, 107) + '…' : rec.title,
      description: rec.seo_description, articleSection: k.label, inLanguage: 'en-US', isAccessibleForFree: true,
      author: { '@type': 'Organization', name: rec.author || 'EdgeDesk Research', url: SITE + '/methodology/' },
      publisher: { '@type': 'Organization', name: 'EdgeDesk Sports', url: SITE, logo: { '@type': 'ImageObject', url: R.OG_DEFAULT, width: 1200, height: 630 } },
      url: rec.canonical_url, image: [R.OG_DEFAULT],
      keywords: [rec.primary_keyword, k.label, 'EdgeDesk', 'college football', 'NFL', 'model projections'].filter(Boolean).join(', ')
    };
    if (rec.published_at) art.datePublished = iso(rec.published_at);
    art.dateModified = iso(rec.updated_at) || iso(rec.published_at);
    return [art, { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Research', item: SITE + '/articles/' },
      { '@type': 'ListItem', position: 2, name: 'Features', item: HUB },
      { '@type': 'ListItem', position: 3, name: rec.title, item: rec.canonical_url }
    ] }];
  }
  var STYLE = '<style>.f-prose p{font-size:17px;line-height:1.7;margin:0 0 14px}.f-prose ul{margin:0 0 16px;padding-left:20px}.f-prose li{font-size:16px;line-height:1.65;margin:0 0 6px}'
    + '.f-prose a{color:var(--pos)}.f-prose h2{font-size:21px;margin:30px 0 10px}.f-related{margin:28px 0 0}.f-related li{margin:0 0 8px}.f-related a{color:var(--text)}'
    + '.f-cat{color:var(--faint);font-size:12px;margin-left:6px}.f-archive li{margin:0 0 6px}.f-sources li{font-size:13px;color:var(--dim)}</style>';
  /* opts: { published: Set of slugs, related: [{title, url, kind}], noindex, now } */
  function page(rec, opts) {
    opts = opts || {};
    var k = KINDS[rec.feature_kind] || {};
    var noindex = !!opts.noindex || rec.status !== 'published';
    var h = '<!doctype html>\n<html lang="en">\n<head>\n';
    h += R.head({ title: rec.seo_title || rec.title, description: rec.seo_description, canonical: rec.canonical_url, og_title: rec.title, noindex: noindex,
      published: iso(rec.published_at), modified: iso(rec.updated_at), section: k.label, ld: noindex ? [] : structuredData(rec) });
    h += STYLE + '</head>\n<body class="a-body" data-ed-engage="feature">\n';
    if (noindex) h += '<div class="a-draftbar">Preview — this feature is <b>' + esc(rec.status) + '</b> and is marked noindex. It is not in the sitemap.</div>';
    h += R.siteHeader('/articles/features/', { noCta: true });
    h += '<main class="a-wrap" id="main"><article class="a-article">';
    h += '<nav class="a-crumbs" aria-label="Breadcrumb"><a href="/articles/">Research</a> <span>›</span> <a href="/articles/features/">Features</a> <span>›</span> '
      + '<a href="/articles/features/#' + esc(k.slug || '') + '">' + esc(k.label || 'Feature') + '</a></nav>';
    h += '<header class="a-hero"><div class="a-eyebrow"><a href="/articles/features/#' + esc(k.slug || '') + '">' + esc(k.label || 'EdgeDesk feature') + '</a></div>';
    h += '<h1 class="a-h1">' + esc(rec.title) + '</h1>';
    if (rec.standfirst) h += '<p class="a-standfirst">' + esc(rec.standfirst) + '</p>';
    h += '<div class="a-byline"><span>By <a href="/methodology/" rel="author">' + esc(rec.author || 'EdgeDesk Research') + '</a></span>'
      + (rec.published_at ? '<span>Published <time datetime="' + esc(iso(rec.published_at)) + '">' + esc(ctLabel(rec.published_at, true)) + '</time></span>' : '')
      + (rec.updated_at && rec.published_at && iso(rec.updated_at) !== iso(rec.published_at) ? '<span>Updated <time datetime="' + esc(iso(rec.updated_at)) + '">' + esc(ctLabel(rec.updated_at, true)) + '</time></span>' : '')
      + '</div></header>';
    h += R.shareHTML(rec);
    h += '<div class="f-prose">';
    (rec.sections || []).forEach(function (s) {
      if (s.heading) h += '<h2 class="a-h2" id="' + esc(R.anchorId(s.heading)) + '">' + esc(s.heading) + '</h2>';
      h += prose(s.body);
    });
    h += '</div>';
    /* the one call to action */
    h += '<section class="a-cta"><p class="a-ctaline">' + esc(CTA_TEXT) + '</p>'
      + '<a class="a-ctabtn" href="' + CTA_HREF + '" data-ed-cta="feature_research">Open today’s games</a></section>';
    var rel = (opts.related || []).filter(function (x) { return x && x.url && x.url !== rec.canonical_url; }).slice(0, 6);
    if (rel.length) {
      h += '<section class="f-related"><h2 class="a-h2" id="sec-related">Related EdgeDesk research</h2><ul class="a-morelist">'
        + rel.map(function (x) { return '<li><a href="' + esc(String(x.url).replace(/^https:\/\/edgedesksports\.com/, '')) + '">' + esc(x.title) + '</a><span class="a-morek">' + esc(x.kind) + '</span></li>'; }).join('')
        + '</ul></section>';
    }
    if ((rec.sources || []).length) {
      h += '<section class="a-method"><h2 class="a-methodh">Sources and method</h2><ul class="f-sources">'
        + rec.sources.map(function (x) { return '<li>' + esc(x.label) + (x.as_of ? ' (as read ' + esc(ctLabel(x.as_of, true)) + ')' : '') + '</li>'; }).join('')
        + '</ul><p>Every number in this article comes from the research EdgeDesk publishes for each game, and was checked against it before publication. '
        + 'This is an original EdgeDesk article; no other site is named as its source.</p></section>';
    }
    h += '<p class="a-source">' + esc(rec.disclaimer || DISCLAIMER) + '</p>';
    h += '</article></main>' + R.siteFooter() + R.SHARE_JS + (noindex ? '' : R.TRACK_JS) + '\n</body>\n</html>\n';
    return h;
  }

  /* ------------------------------------------------------------- the hub */
  /* categories (one section per slot) and an archive by month, all in the
     markup: crawlable, no script */
  function hub(recs, opts) {
    opts = opts || {};
    recs = (recs || []).slice().sort(function (a, b) { return (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0); });
    var title = 'EdgeDesk Features — Weekend Model Reviews, Storylines and Research Previews';
    var desc = 'EdgeDesk’s own weekly features: the Monday model review, the Wednesday storylines and the Friday research preview. Built from EdgeDesk research; research, not picks.';
    var ld = [{ '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description: desc, url: HUB, inLanguage: 'en-US',
      isPartOf: { '@type': 'WebSite', name: 'EdgeDesk Sports', url: SITE },
      mainEntity: { '@type': 'ItemList', numberOfItems: recs.length, itemListElement: recs.slice(0, 50).map(function (r, i) { return { '@type': 'ListItem', position: i + 1, url: r.canonical_url, name: r.title }; }) } },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Research', item: SITE + '/articles/' }, { '@type': 'ListItem', position: 2, name: 'Features', item: HUB }] }];
    var h = '<!doctype html>\n<html lang="en">\n<head>\n' + R.head({ title: title, description: desc, canonical: HUB, og_type: 'website', og_title: 'EdgeDesk features', ld: ld }) + STYLE + '</head>\n<body class="a-body">\n';
    h += R.siteHeader('/articles/features/', { noCta: true }) + '<main class="a-wrap hub" id="main">';
    h += '<nav class="a-crumbs" aria-label="Breadcrumb"><a href="/articles/">Research</a> <span>›</span> <span aria-current="page">Features</span></nav>';
    h += '<header class="a-hubhead"><h1 class="a-h1">EdgeDesk features</h1><p class="a-standfirst">Three a week at most, in Central Time: Monday’s model review, Wednesday’s storylines and Friday’s research preview. Fewer when the research doesn’t support them.</p>'
      + '<p class="a-hubcount">' + recs.length + ' published ' + (recs.length === 1 ? 'feature' : 'features') + '</p></header>';
    h += '<nav class="a-filters" aria-label="Research sections"><a class="a-filter" href="/articles/">All research</a><a class="a-filter" href="/articles/college-football/">College Football</a><a class="a-filter" href="/articles/nfl/">NFL</a><a class="a-filter on" href="/articles/features/">Features</a></nav>';
    Object.keys(KINDS).forEach(function (key) {
      var k = KINDS[key], list = recs.filter(function (r) { return r.feature_kind === key; });
      h += '<section class="a-about"><h2 class="a-h2" id="' + k.slug + '">' + esc(k.label) + '</h2><p>' + esc(k.blurb) + '</p>';
      h += list.length ? '<ul class="a-morelist">' + list.slice(0, 8).map(function (r) {
        return '<li><a href="/articles/' + esc(r.slug) + '/">' + esc(r.title) + '</a><span class="a-morek">' + esc(ctLabel(r.published_at)) + '</span></li>'; }).join('') + '</ul>'
        : '<p class="a-nodata">None published yet. A feature is published only when the research supports it and it clears all twelve publication checks.</p>';
      h += '</section>';
    });
    var months = {};
    recs.forEach(function (r) { var m = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', month: 'long', year: 'numeric' }).format(new Date(Date.parse(r.published_at))); (months[m] = months[m] || []).push(r); });
    var mk = Object.keys(months);
    if (mk.length) {
      h += '<section class="a-about"><h2 class="a-h2" id="archive">Archive</h2>';
      mk.forEach(function (m) {
        h += '<h3 class="a-h3" id="archive-' + esc(R.anchorId(m).replace(/^sec-/, '')) + '">' + esc(m) + '</h3><ul class="f-archive">'
          + months[m].map(function (r) { return '<li><a href="/articles/' + esc(r.slug) + '/">' + esc(r.title) + '</a><span class="f-cat">' + esc((KINDS[r.feature_kind] || {}).label || '') + '</span></li>'; }).join('') + '</ul>';
      });
      h += '</section>';
    }
    h += '<section class="a-cta"><p class="a-ctaline">' + esc(CTA_TEXT) + '</p><a class="a-ctabtn" href="' + CTA_HREF + '" data-ed-cta="feature_research">Open today’s games</a></section>';
    h += '<p class="a-source">' + esc(DISCLAIMER) + '</p>';
    h += '</main>' + R.siteFooter() + R.TRACK_JS + '\n</body>\n</html>\n';
    return h;
  }
  /* the strip on /articles/: the latest features, linked */
  function strip(recs) {
    recs = (recs || []).slice().sort(function (a, b) { return (Date.parse(b.published_at) || 0) - (Date.parse(a.published_at) || 0); }).slice(0, 3);
    if (!recs.length) return '';
    return '<section class="a-about"><h2 class="a-h2" id="features">This week from EdgeDesk</h2><ul class="a-morelist">'
      + recs.map(function (r) { return '<li><a href="/articles/' + esc(r.slug) + '/">' + esc(r.title) + '</a><span class="a-morek">' + esc((KINDS[r.feature_kind] || {}).label || '') + '</span></li>'; }).join('')
      + '</ul><p><a href="/articles/features/">All EdgeDesk features</a></p></section>';
  }

  var API = { KINDS: KINDS, HUB: HUB, CTA_TEXT: CTA_TEXT, CTA_HREF: CTA_HREF, articleFor: articleFor, checks: checks, compact: compact,
    page: page, hub: hub, strip: strip, structuredData: structuredData, contentHash: contentHash };
  if (AMODEL && typeof AMODEL.registerType === 'function') AMODEL.registerType('feature', API);
  return API;
});
/*__EDED_FEATURE_END__*/
