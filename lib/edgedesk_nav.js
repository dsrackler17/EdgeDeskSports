/* ===========================================================================
   EdgeDesk site navigation — the ONE list of the public site's primary links.

   Every public page leads with the same five places, in the same order, so a
   reader who lands on an article from a search can find the free tools, the
   week's games and the terminal without going through the landing page:

     Free Research      /articles/      EdgeDesk's published game research
     Today's Games      /today/         the week's NFL and FBS slate, free
     Tools              /tools/         the free calculators and the explorer
     Research Terminal  /app.html       the subscriber terminal
     Pricing            /#pricing       free vs Full Access, on the landing page

   THE MARKUP IS STATIC. Pages are hand-written HTML with no build step, and a
   crawler must see these links before any script runs, so each page carries
   them in its own header. This file is what the markup is checked against
   (tools/site/nav.test.js fails when a page drifts) and what the article
   generator renders from (tools/articles/article_render.js).

   The landing page links Pricing to its own #pricing; every other page links
   /#pricing. Nothing else differs page to page.

   Browser: window.EDNav. Node: require('./edgedesk_nav.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDNav = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = {};

  /* label is plain text; the pages print the apostrophe as &rsquo; or ’ */
  X.PRIMARY = [
    { key: 'research', label: 'Free Research', href: '/articles/' },
    { key: 'today', label: 'Today’s Games', href: '/today/' },
    { key: 'tools', label: 'Tools', href: '/tools/' },
    { key: 'terminal', label: 'Research Terminal', href: '/app.html' },
    { key: 'pricing', label: 'Pricing', href: '/#pricing' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The five links as anchors, for a generator. `active` is a key from
     PRIMARY (or null); `cls` the anchor class; `onCls` the class an active
     link adds. The active link carries aria-current="page" when the page IS
     that destination (`exact`), and aria-current="true" when the page is
     inside its section (an article under Free Research, a calculator under
     Tools). */
  X.links = function (active, cls, onCls, exact) {
    return X.PRIMARY.map(function (it) {
      var on = it.key === active;
      var c = [cls, on ? onCls : null].filter(Boolean).join(' ');
      return '<a' + (c ? ' class="' + esc(c) + '"' : '') + ' href="' + esc(it.href) + '"'
        + (on ? ' aria-current="' + (exact ? 'page' : 'true') + '"' : '') + ' data-ed-nav="' + esc(it.key) + '">' + esc(it.label) + '</a>';
    }).join('');
  };

  return X;
});
