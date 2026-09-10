/*__EDART_RENDER_START__*/
/* ============================================================================
   THE ARTICLE RENDERER — one article record in, one crawlable page out.

   WHY IT IS A PURE FUNCTION OF THE RECORD. EdgeDesk is a static site. There
   is no server to render a page on request, so an article that a crawler can
   read has to EXIST as HTML in the repository. Everything a reader or
   Googlebot needs — the headline, the numbers, the reasoning, the
   uncertainty, the structured data — is in the markup before a single byte of
   JavaScript runs. The only script on an article page is the share buttons,
   and the page is complete without them.

   IT ADDS NO FACTS. Every figure printed here came out of article_model.js,
   which took it from the research payload. This file decides where a number
   sits on the page and nothing else.

   Loads in Node (the static build) and in a browser (the operator's preview),
   from one file, so a preview cannot look like something the build will not
   produce.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDART = root.EDART || {};
  root.EDART.render = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SITE = 'https://edgedesksports.com';
  var ORG = 'EdgeDesk Sports';
  var CSS_HREF = '/articles/articles.css?v=2';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* JSON-LD is inside a <script> element, so the one sequence that can end it
     early is escaped. Everything else stays as written. */
  function jsonld(o) {
    return JSON.stringify(o, null, 2).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  }
  function has(x) { return x != null && x !== ''; }
  function iso(t) { var d = t ? Date.parse(t) : NaN; return isFinite(d) ? new Date(d).toISOString() : null; }
  function dateLabel(t, opts) {
    var d = t ? Date.parse(t) : NaN;
    if (!isFinite(d)) return null;
    try {
      return new Intl.DateTimeFormat('en-US', Object.assign({
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short'
      }, opts || {})).format(new Date(d));
    } catch (_) { return new Date(d).toISOString(); }
  }
  function dayLabel(t) { return dateLabel(t, { hour: undefined, minute: undefined, timeZoneName: undefined }); }

  /* ---------------------------------------------------------------- head */
  /* Everything a crawler reads before the body. Draft and preview pages get
     `noindex` here and nowhere else, so an unpublished article can never be
     indexed by forgetting a rule somewhere downstream. */
  function head(o) {
    var robots = o.noindex ? 'noindex,nofollow' : 'index,follow';
    var h = '';
    h += '<meta charset="utf-8">\n';
    h += '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n';
    h += '<title>' + esc(o.title) + '</title>\n';
    h += '<meta name="description" content="' + esc(o.description) + '">\n';
    h += '<link rel="canonical" href="' + esc(o.canonical) + '">\n';
    h += '<meta name="robots" content="' + robots + '">\n';
    h += '<meta name="theme-color" content="#0b0d1f">\n';
    h += '<meta name="color-scheme" content="dark">\n';
    h += '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'7\' fill=\'%230b0d11\'/%3E%3Cpath d=\'M18 6 L23 6 L14 26 L9 26 Z\' fill=\'%233fb883\'/%3E%3C/svg%3E">\n';
    h += '<meta property="og:type" content="' + (o.og_type || 'article') + '">\n';
    h += '<meta property="og:site_name" content="' + esc(ORG) + '">\n';
    h += '<meta property="og:url" content="' + esc(o.canonical) + '">\n';
    h += '<meta property="og:title" content="' + esc(o.og_title || o.title) + '">\n';
    h += '<meta property="og:description" content="' + esc(o.description) + '">\n';
    h += '<meta property="og:locale" content="en_US">\n';
    if (o.image) {
      h += '<meta property="og:image" content="' + esc(o.image) + '">\n';
      h += '<meta name="twitter:card" content="summary_large_image">\n';
      h += '<meta name="twitter:image" content="' + esc(o.image) + '">\n';
    } else {
      h += '<meta name="twitter:card" content="summary">\n';
    }
    h += '<meta name="twitter:site" content="@edgedesksports">\n';
    h += '<meta name="twitter:title" content="' + esc(o.og_title || o.title) + '">\n';
    h += '<meta name="twitter:description" content="' + esc(o.description) + '">\n';
    if (o.published) h += '<meta property="article:published_time" content="' + esc(o.published) + '">\n';
    if (o.modified) h += '<meta property="article:modified_time" content="' + esc(o.modified) + '">\n';
    if (o.section) h += '<meta property="article:section" content="' + esc(o.section) + '">\n';
    h += '<link rel="preconnect" href="https://fonts.googleapis.com">\n';
    h += '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n';
    h += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">\n';
    h += '<link rel="stylesheet" href="' + CSS_HREF + '">\n';
    (o.ld || []).forEach(function (block) {
      h += '<script type="application/ld+json">' + jsonld(block) + '</script>\n';
    });
    return h;
  }

  /* -------------------------------------------------------- shared chrome */
  function siteHeader(active) {
    function tab(href, label) {
      return '<a class="ah-tab' + (active === href ? ' on' : '') + '" href="' + href + '">' + esc(label) + '</a>';
    }
    return '<header class="ah">'
      + '<a class="ah-brand" href="/"><span class="ah-mark" aria-hidden="true"></span>EdgeDesk</a>'
      + '<nav class="ah-nav" aria-label="Research sections">'
      + tab('/articles', 'All research')
      + tab('/articles/college-football', 'College football')
      + tab('/articles/nfl', 'NFL')
      + tab('/articles/community', 'Members')
      + '</nav>'
      + '<a class="ah-cta" href="/app.html#research/football">Research terminal</a>'
      + '</header>';
  }
  function siteFooter() {
    return '<footer class="af">'
      + '<p class="af-line"><b>Research, not picks.</b> EdgeDesk publishes what its model sees, how confident it is, and what it could not measure. Nothing on this site is betting advice, a wager or a recommendation.</p>'
      + '<nav class="af-nav" aria-label="Site">'
      + '<a href="/articles">Research articles</a><a href="/articles/college-football">College football</a>'
      + '<a href="/articles/nfl">NFL</a><a href="/articles/community">Member posts</a>'
      + '<a href="/app.html#research/football">Research terminal</a>'
      + '<a href="/games">EdgeDesk Games</a><a href="/terms.html">Terms</a><a href="/privacy.html">Privacy</a>'
      + '<a href="/disclaimer.html">Disclaimer</a></nav>'
      + '<p class="af-legal">21+. Gamble responsibly — 1-800-GAMBLER. © ' + new Date().getUTCFullYear() + ' ' + esc(ORG) + '.</p>'
      + '</footer>';
  }

  /* ------------------------------------------------------------- sections */
  function secHead(title, note, id) {
    return '<h2 class="a-h2"' + (id ? ' id="' + esc(id) + '"' : '') + '>' + esc(title) + '</h2>'
      + (note ? '<p class="a-secnote">' + esc(note) + '</p>' : '');
  }
  function anchorId(s) { return 'sec-' + String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  function readHTML(s) {
    return '<section class="a-sec a-read">' + secHead(s.title, null, anchorId(s.title))
      + s.paragraphs.map(function (p) { return '<p class="a-lede">' + esc(p) + '</p>'; }).join('')
      + '</section>';
  }

  function snapshotHTML(s) {
    var h = '<section class="a-sec a-snap">' + secHead(s.title, null, anchorId(s.title));
    h += '<div class="a-cards">';
    s.cards.forEach(function (c) {
      var cls = 'a-card' + (c.lead ? ' lead' : '') + (c.wide ? ' wide' : '') + (c.absent ? ' absent' : '')
        + (c.tone === 'status' ? ' status' : '');
      h += '<div class="' + cls + '"><div class="a-ck">' + esc(c.k) + '</div>';
      if (c.absent) {
        h += '<div class="a-cv a-nodata">not published</div>';
        if (c.why) h += '<div class="a-cwhy">' + esc(c.why) + '</div>';
      } else if (c.score) {
        h += '<div class="a-cscore"><span><i>' + esc(c.score.away.team) + '</i><b>' + esc(c.score.away.points) + '</b></span>'
          + '<span><i>' + esc(c.score.home.team) + '</i><b>' + esc(c.score.home.points) + '</b></span></div>';
        if (c.sub) h += '<div class="a-cs">' + esc(c.sub) + '</div>';
      } else if (c.pair) {
        h += '<div class="a-cpair">' + c.pair.map(function (x) {
          return '<span><i>' + esc(x.team) + '</i><b>' + esc(x.v) + '</b></span>';
        }).join('') + '</div>';
        if (c.sub) h += '<div class="a-cs">' + esc(c.sub) + '</div>';
      } else {
        h += '<div class="a-cv">' + esc(c.v) + '</div>';
        if (c.sub) h += '<div class="a-cs">' + esc(c.sub) + '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
    (s.notes || []).forEach(function (n) { h += '<p class="a-note">' + esc(n) + '</p>'; });
    if (s.note) h += '<p class="a-note">' + esc(s.note) + '</p>';
    return h + '</section>';
  }

  function pricingHTML(s) {
    var h = '<section class="a-sec a-price">' + secHead(s.title, s.basis, anchorId(s.title));
    h += '<p class="a-tag priced">PRICED BY MODEL — validated inputs only</p>';
    if (s.rows.length) {
      h += '<ul class="a-drivers">' + s.rows.map(function (d) {
        var sign = d.points_n == null ? '' : (d.points_n > 0 ? ' pos' : d.points_n < 0 ? ' neg' : '');
        return '<li><span class="a-dpts' + sign + '">' + esc(d.points) + '</span>'
          + '<span class="a-dtext">' + esc(d.text) + '</span></li>';
      }).join('') + '</ul>';
    }
    if ((s.total_rows || []).length) {
      h += '<h3 class="a-h3">What moves the total</h3><ul class="a-drivers">' + s.total_rows.map(function (d) {
        return '<li><span class="a-dpts">' + esc(d.points) + '</span><span class="a-dtext">' + esc(d.text) + '</span></li>';
      }).join('') + '</ul>';
    }
    if (s.empty) h += '<p class="a-note">' + esc(s.empty) + '</p>';
    if (s.excluded) {
      h += '<div class="a-excluded"><p class="a-tag context">' + esc(s.context_label) + '</p>'
        + '<p>' + esc(s.excluded) + '</p></div>';
    }
    return h + '</section>';
  }

  function cellHTML(c) {
    if (!c || c.v == null) {
      return '<td class="a-c"><span class="a-nodata">' + (c && c.note ? 'unavailable' : 'not measured') + '</span>'
        + (c && c.note ? '<span class="a-cn">' + esc(c.note) + '</span>' : '') + '</td>';
    }
    return '<td class="a-c"><b>' + esc(c.v) + '</b>'
      + (c.rank ? '<span class="a-cn">' + esc(c.rank) + '</span>'
        : (c.note ? '<span class="a-cn">' + esc(c.note) + '</span>' : '')) + '</td>';
  }
  function cmpRowHTML(x) {
    var lead = x.edge && x.edge.side && x.edge.side !== 'even' ? x.edge.side : null;
    function cell(side) {
      var html = cellHTML(side === 'a' ? x.a : x.h);
      if (lead === side) html = html.replace('<td class="a-c"', '<td class="a-c adv"');
      return html;
    }
    return '<tr><th scope="row">' + esc(x.k) + (x.note ? '<span class="a-cn">' + esc(x.note) + '</span>' : '') + '</th>'
      + cell('a') + cell('h') + '</tr>';
  }
  function tableHTML(cols, groups) {
    var h = '<div class="a-tablewrap"><table class="a-table">';
    h += '<thead><tr><th scope="col"></th><th scope="col">' + esc(cols[0]) + '</th><th scope="col">' + esc(cols[1]) + '</th></tr></thead>';
    groups.forEach(function (g) {
      h += '<tbody><tr class="a-group"><th colspan="3" scope="colgroup">' + esc(g.title) + '</th></tr>';
      g.rows.forEach(function (r) { h += cmpRowHTML(r); });
      h += '</tbody>';
    });
    return h + '</table></div>';
  }

  function breakdownHTML(s) {
    var h = '<section class="a-sec a-break">' + secHead(s.title, null, anchorId(s.title));
    if (s.context_label) h += '<p class="a-tag context">' + esc(s.context_label) + '</p>';
    if (s.one_sided_note) h += '<p class="a-warn">' + esc(s.one_sided_note) + '</p>';
    h += tableHTML(s.cols || ['Away', 'Home'], s.groups);
    return h + '</section>';
  }

  function advItemHTML(x) {
    if (typeof x === 'string') return '<li>' + esc(x) + '</li>';
    var k = x.k ? '<b>' + esc(x.k) + '</b> ' : '';
    return '<li>' + k + esc(x.text || '') + '</li>';
  }
  function edgesHTML(s) {
    var h = '<section class="a-sec a-edges">' + secHead(s.title, s.rule, anchorId(s.title));
    if (s.away.length || s.home.length) {
      h += '<div class="a-edgecols">';
      h += '<div class="a-edgecol"><h3 class="a-h3">' + esc(s.away_team) + ' edge</h3>'
        + (s.away.length ? '<ul class="a-bul">' + s.away.map(advItemHTML).join('') + '</ul>'
          : '<p class="a-nodata">No category where EdgeDesk ranks this side ahead.</p>') + '</div>';
      h += '<div class="a-edgecol"><h3 class="a-h3">' + esc(s.home_team) + ' edge</h3>'
        + (s.home.length ? '<ul class="a-bul">' + s.home.map(advItemHTML).join('') + '</ul>'
          : '<p class="a-nodata">No category where EdgeDesk ranks this side ahead.</p>') + '</div>';
      h += '</div>';
    }
    if (s.measured.length) {
      h += '<h3 class="a-h3">' + esc(s.measured_title) + '</h3>';
      if (s.measured_note) h += '<p class="a-secnote">' + esc(s.measured_note) + '</p>';
      h += '<ul class="a-bul">' + s.measured.map(advItemHTML).join('') + '</ul>';
    }
    if (s.unproven.length) {
      h += '<h3 class="a-h3">' + esc(s.unproven_title) + '</h3>'
        + '<ul class="a-bul a-dim">' + s.unproven.map(function (u) { return '<li>' + esc(u) + '</li>'; }).join('') + '</ul>';
    }
    if (!s.away.length && !s.home.length && !s.measured.length && !s.unproven.length) {
      h += '<p class="a-nodata">EdgeDesk claims no category edge on this matchup: not enough of the component board clears its confidence floor for either team.</p>';
    }
    if (s.note) h += '<p class="a-note">' + esc(s.note) + '</p>';
    return h + '</section>';
  }

  function matchupsHTML(s) {
    var h = '<section class="a-sec a-matchups">' + secHead(s.title, s.note, anchorId(s.title));
    h += '<div class="a-mgrid">';
    s.items.forEach(function (m) {
      h += '<article class="a-m' + (m.complete ? '' : ' partial') + '">';
      h += '<h3 class="a-mh">' + esc(m.title) + '</h3>';
      h += '<div class="a-mrow">';
      [m.att, m.def].forEach(function (side) {
        if (!side || !side.team) return;
        h += '<div class="a-mside"><span class="a-mteam">' + esc(side.team) + '</span>'
          + '<span class="a-mlabel">' + esc(side.label || '') + '</span>'
          + (side.v != null ? '<span class="a-mv">' + esc(side.v) + '</span>'
            : '<span class="a-mv a-nodata">not rated</span>')
          + (side.rank ? '<span class="a-mrank">' + esc(side.rank) + '</span>' : '') + '</div>';
      });
      h += '</div><p class="a-mread">' + esc(m.read) + '</p></article>';
    });
    return h + '</div></section>';
  }

  function panelHTML(s) {
    var h = '<section class="a-sec a-panel">' + secHead(s.title, s.note, anchorId(s.title));
    if ((s.rows || []).length) {
      var cols = s.cols || ['Away', 'Home'];
      h += '<div class="a-tablewrap"><table class="a-table"><thead><tr><th scope="col"></th>'
        + '<th scope="col">' + esc(cols[0]) + '</th><th scope="col">' + esc(cols[1]) + '</th></tr></thead><tbody>';
      s.rows.forEach(function (r) {
        if (r.span) {
          h += '<tr><th scope="row">' + esc(r.k) + (r.note ? '<span class="a-cn">' + esc(r.note) + '</span>' : '')
            + '</th><td class="a-c" colspan="2"><b>' + esc(r.v) + '</b></td></tr>';
        } else {
          h += '<tr><th scope="row">' + esc(r.k) + (r.note ? '<span class="a-cn">' + esc(r.note) + '</span>' : '') + '</th>'
            + cellHTML({ v: r.a }) + cellHTML({ v: r.h }) + '</tr>';
        }
      });
      h += '</tbody></table></div>';
    }
    if ((s.reads || []).length) h += '<ul class="a-bul">' + s.reads.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    return h + '</section>';
  }

  function rosterHTML(s) {
    var h = '<section class="a-sec a-roster">' + secHead(s.title, null, anchorId(s.title));
    var cols = s.cols || ['Away', 'Home'];
    h += '<div class="a-tablewrap"><table class="a-table"><thead><tr><th scope="col"></th>'
      + '<th scope="col">' + esc(cols[0]) + '</th><th scope="col">' + esc(cols[1]) + '</th></tr></thead><tbody>';
    s.rows.forEach(function (r) {
      h += '<tr><th scope="row">' + esc(r.k) + (r.note ? '<span class="a-cn">' + esc(r.note) + '</span>' : '') + '</th>'
        + cellHTML({ v: r.a }) + cellHTML({ v: r.h }) + '</tr>';
    });
    h += '</tbody></table></div>';
    if ((s.highlights || []).length) {
      h += '<ul class="a-bul">' + s.highlights.map(function (x) {
        return '<li>' + (x.lead ? '<b>' + esc(x.lead) + '</b> ' : '') + esc(x.text) + '</li>';
      }).join('') + '</ul>';
    }
    if (s.note) h += '<p class="a-note">' + esc(s.note) + '</p>';
    return h + '</section>';
  }

  function casesHTML(s) {
    var h = '<section class="a-sec a-cases">' + secHead(s.title, s.note, anchorId(s.title));
    h += '<div class="a-edgecols">';
    [s.favourite, s.underdog].forEach(function (c) {
      if (!c) return;
      h += '<div class="a-edgecol"><h3 class="a-h3">' + esc(c.heading || ('The case for ' + (c.team || ''))) + '</h3>'
        + '<ul class="a-bul">' + (c.bullets || []).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul></div>';
    });
    return h + '</div></section>';
  }

  function uncertaintyHTML(s) {
    var h = '<section class="a-sec a-unc">' + secHead(s.title, s.lede, anchorId(s.title));
    if (s.items.length) {
      h += '<ul class="a-unclist">' + s.items.map(function (i) {
        return '<li class="sev-' + esc(String(i.sev || 'MEDIUM').toLowerCase()) + '">'
          + '<span class="a-sev">' + esc(i.sev || 'MEDIUM') + '</span>'
          + '<span class="a-unctext"><b>' + esc(i.label || 'uncertainty') + '</b> ' + esc(i.text)
          + (i.widening ? ' <em>' + esc(i.widening) + '</em>' : '') + '</span></li>';
      }).join('') + '</ul>';
    }
    if (s.unmeasured.length) {
      h += '<h3 class="a-h3">' + esc(s.unmeasured_title) + '</h3><ul class="a-bul a-dim">'
        + s.unmeasured.map(function (u) {
          return '<li>' + esc(u.item) + (u.why ? ' — ' + esc(u.why) : '') + '</li>';
        }).join('') + '</ul>';
    }
    if (s.missing.length) {
      h += '<h3 class="a-h3">' + esc(s.missing_title) + '</h3><ul class="a-bul a-dim">'
        + s.missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
    }
    if (s.note) h += '<p class="a-note">' + esc(s.note) + '</p>';
    return h + '</section>';
  }

  function marketHTML(s) {
    var h = '<section class="a-sec a-market">' + secHead(s.title, null, anchorId(s.title));
    if (!s.available) {
      h += '<div class="a-mkt-none"><p><b>' + esc(s.headline || 'No sportsbook number is joined to this game.') + '</b></p>'
        + (s.model ? '<p>EdgeDesk fair spread: <b>' + esc(s.model) + '</b>.</p>' : '')
        + (s.note ? '<p>' + esc(s.note) + '</p>' : '') + '</div>';
      return h + '</section>';
    }
    h += '<div class="a-mktgrid">';
    function box(k, v, sub) {
      return '<div class="a-mb"><div class="a-ck">' + esc(k) + '</div><div class="a-cv">' + esc(v) + '</div>'
        + (sub ? '<div class="a-cs">' + esc(sub) + '</div>' : '') + '</div>';
    }
    h += box('EdgeDesk', s.model || '—', s.total_model ? 'fair total ' + s.total_model : null);
    h += box('Sportsbook', s.market || '—', [s.book, s.capture_age, s.stale ? 'stale' : null].filter(Boolean).join(' · ') || null);
    h += box('Difference', s.difference || '—', s.classification || null);
    if (s.total_model || s.total_market) {
      h += box('EdgeDesk total', s.total_model || '—', null);
      h += box('Market total', s.total_market || '—', null);
    }
    h += '</div>';
    if (s.classification_note) h += '<p class="a-note">' + esc(s.classification_note) + '</p>';
    if (s.note) h += '<p class="a-note">' + esc(s.note) + '</p>';
    h += '<p class="a-note">' + esc(s.disclaimer) + '</p>';
    return h + '</section>';
  }

  var SECTION_HTML = {
    read: readHTML, snapshot: snapshotHTML, pricing: pricingHTML, breakdown: breakdownHTML,
    edges: edgesHTML, matchups: matchupsHTML, panel: panelHTML, roster: rosterHTML,
    cases: casesHTML, uncertainty: uncertaintyHTML, market: marketHTML
  };

  /* ------------------------------------------------------------ the hero */
  function heroHTML(rec) {
    var a = rec.article.hero;
    var bits = [a.venue, rec.neutral_site ? 'neutral site' : null, a.conference_line,
      a.week ? 'Week ' + a.week : null, a.season ? String(a.season) : null].filter(has);
    var h = '<header class="a-hero">';
    h += '<div class="a-eyebrow"><a href="' + esc('/articles/' + rec.sport_slug) + '">' + esc(a.eyebrow) + '</a>'
      + (a.status ? '<span class="a-status">' + esc(a.status) + '</span>' : '')
      + (a.confidence != null ? '<span class="a-conf">' + esc(a.confidence) + '% data confidence</span>' : '') + '</div>';
    h += '<h1 class="a-h1">' + esc(a.headline) + '</h1>';
    if (a.standfirst) h += '<p class="a-standfirst">' + esc(a.standfirst) + '</p>';
    h += '<div class="a-gamebar"><div class="a-matchup">' + esc(a.matchup) + '</div>';
    if (rec.game_time) h += '<div class="a-when"><time datetime="' + esc(iso(rec.game_time)) + '">' + esc(dateLabel(rec.game_time)) + '</time></div>';
    if (bits.length) h += '<div class="a-gmeta">' + esc(bits.join(' · ')) + '</div>';
    h += '</div>';
    h += '<div class="a-byline">'
      + '<span>By <a href="/app.html#research/football" rel="author">' + esc(rec.author) + '</a></span>'
      + (rec.published_at ? '<span>Published <time datetime="' + esc(iso(rec.published_at)) + '">' + esc(dayLabel(rec.published_at)) + '</time></span>' : '')
      + (rec.updated_at ? '<span>Updated <time datetime="' + esc(iso(rec.updated_at)) + '">' + esc(dayLabel(rec.updated_at)) + '</time></span>' : '')
      + (rec.frozen ? '<span class="a-frozen">Frozen at kickoff</span>' : '')
      + '</div>';
    return h + '</header>';
  }

  /* -------------------------------------------------------- contents / CTA */
  function tocHTML(rec) {
    var items = (rec.article.sections || []).map(function (s) {
      return '<li><a href="#' + esc(anchorId(s.title)) + '">' + esc(s.title) + '</a></li>';
    });
    items.push('<li><a href="#sec-the-edgedesk-bottom-line">The EdgeDesk bottom line</a></li>');
    return '<nav class="a-toc" aria-label="On this page"><h2 class="a-tocH">On this page</h2><ol>' + items.join('') + '</ol></nav>';
  }
  function bottomHTML(b) {
    return '<section class="a-sec a-bottom">' + secHead(b.title, null, anchorId(b.title))
      + b.paragraphs.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('')
      + '</section>';
  }
  function ctaHTML(rec) {
    var c = rec.article.cta;
    return '<section class="a-cta">'
      + '<p class="a-ctaline">' + esc(c.line) + '</p>'
      + '<a class="a-ctabtn" href="' + esc(c.href) + '">' + esc(c.button) + '</a>'
      + '<nav class="a-ctalinks" aria-label="More EdgeDesk research">'
      + c.links.map(function (l) { return '<a href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('')
      + '</nav></section>';
  }
  /* Share links are plain anchors with the URL already in them, so they work
     with JavaScript off. Copy Link is the one control that needs a script and
     it is hidden until the script says it can run. */
  function shareHTML(rec) {
    var u = encodeURIComponent(rec.canonical_url);
    var t = encodeURIComponent(rec.title);
    return '<div class="a-share"><span class="a-sharek">Share</span>'
      + '<a class="a-sharebtn" href="https://twitter.com/intent/tweet?url=' + u + '&amp;text=' + t + '" rel="noopener nofollow" target="_blank">X</a>'
      + '<a class="a-sharebtn" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '" rel="noopener nofollow" target="_blank">Facebook</a>'
      + '<button class="a-sharebtn" type="button" id="a-copy" hidden data-url="' + esc(rec.canonical_url) + '">Copy link</button>'
      + '</div>';
  }
  var SHARE_JS = '<script>(function(){var b=document.getElementById("a-copy");if(!b||!navigator.clipboard)return;b.hidden=false;'
    + 'b.addEventListener("click",function(){navigator.clipboard.writeText(b.getAttribute("data-url")).then(function(){'
    + 'var o=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=o;},1600);});});})();</script>';

  /* ------------------------------------------------------ structured data */
  /* Article + SportsEvent. Both describe the SAME page and both are true of
     it: it is an analysis article, and it is about a scheduled game. */
  function structuredData(rec) {
    var out = [];
    var art = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      mainEntityOfPage: { '@type': 'WebPage', '@id': rec.canonical_url },
      headline: rec.title.length > 110 ? rec.title.slice(0, 107) + '…' : rec.title,
      description: rec.seo_description,
      articleSection: rec.sport_label,
      inLanguage: 'en-US',
      isAccessibleForFree: true,
      author: { '@type': 'Organization', name: rec.author, url: SITE },
      publisher: { '@type': 'Organization', name: ORG, url: SITE },
      url: rec.canonical_url,
      keywords: [rec.away_team, rec.home_team, rec.sport_label, 'EdgeDesk', 'fair spread', 'model projection'].join(', ')
    };
    if (rec.published_at) art.datePublished = iso(rec.published_at);
    art.dateModified = iso(rec.updated_at) || iso(rec.published_at) || iso(rec.generated_at);
    if (rec.hero_image) art.image = [rec.hero_image];
    out.push(art);

    var ev = {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: rec.away_team + ' at ' + rec.home_team,
      sport: rec.sport === 'NFL' ? 'American Football' : 'College Football',
      url: rec.canonical_url,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      competitor: [
        { '@type': 'SportsTeam', name: rec.away_team },
        { '@type': 'SportsTeam', name: rec.home_team }
      ]
    };
    if (rec.game_time) ev.startDate = iso(rec.game_time);
    if (!rec.neutral_site) ev.homeTeam = { '@type': 'SportsTeam', name: rec.home_team };
    if (!rec.neutral_site) ev.awayTeam = { '@type': 'SportsTeam', name: rec.away_team };
    if (rec.venue) ev.location = { '@type': 'Place', name: rec.venue };
    out.push(ev);

    out.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Research', item: SITE + '/articles' },
        { '@type': 'ListItem', position: 2, name: rec.sport_label, item: SITE + '/articles/' + rec.sport_slug },
        { '@type': 'ListItem', position: 3, name: rec.away_team + ' at ' + rec.home_team, item: rec.canonical_url }
      ]
    });
    return out;
  }

  /* ------------------------------------------------------------- the page */
  function articleBody(rec) {
    var h = '';
    h += '<nav class="a-crumbs" aria-label="Breadcrumb"><a href="/articles">Research</a> <span>›</span> '
      + '<a href="/articles/' + esc(rec.sport_slug) + '">' + esc(rec.sport_label) + '</a> <span>›</span> '
      + '<span aria-current="page">' + esc(rec.away_team + ' at ' + rec.home_team) + '</span></nav>';
    h += heroHTML(rec);
    h += shareHTML(rec);
    h += tocHTML(rec);
    (rec.article.sections || []).forEach(function (s) {
      var fn = SECTION_HTML[s.kind];
      if (fn) h += fn(s);
    });
    h += bottomHTML(rec.article.bottom_line);
    h += ctaHTML(rec);
    if (rec.article.footer && rec.article.footer.source) {
      h += '<p class="a-source">' + esc(rec.article.footer.source) + '</p>';
    }
    if (rec.market_source) h += '<p class="a-source">' + esc(rec.market_source) + '</p>';
    h += '<p class="a-source">' + esc(rec.article.footer.disclaimer) + '</p>';
    return h;
  }

  function articlePage(rec, opts) {
    opts = opts || {};
    var noindex = !!opts.noindex || rec.status !== 'published';
    var h = '<!doctype html>\n<html lang="en">\n<head>\n';
    h += head({
      title: rec.seo_title, description: rec.seo_description, canonical: rec.canonical_url,
      og_title: rec.title, image: rec.hero_image, noindex: noindex,
      published: iso(rec.published_at), modified: iso(rec.updated_at),
      section: rec.sport_label, ld: noindex ? [] : structuredData(rec)
    });
    h += '</head>\n<body class="a-body">\n';
    if (noindex) h += '<div class="a-draftbar">Draft preview — this article is <b>' + esc(rec.status) + '</b> and is marked noindex. It is not in the sitemap.</div>';
    h += siteHeader('/articles/' + rec.sport_slug);
    h += '<main class="a-wrap" id="main"><article class="a-article">';
    h += articleBody(rec);
    h += '</article></main>';
    h += siteFooter();
    h += SHARE_JS;
    h += '\n</body>\n</html>\n';
    return h;
  }

  /* An alias URL is a real page that says, in the one way a crawler trusts,
     that it is not the real page. Canonical to the article, noindex, and a
     link a human can click. No meta refresh: a redirect a crawler cannot
     follow is worse than a page that explains itself. */
  function aliasPage(rec, alias) {
    var url = SITE + '/articles/' + alias;
    var h = '<!doctype html>\n<html lang="en">\n<head>\n';
    h += head({ title: rec.seo_title, description: rec.seo_description, canonical: rec.canonical_url,
      og_title: rec.title, noindex: true, ld: [] });
    h += '<meta http-equiv="refresh" content="0; url=' + esc(rec.canonical_url) + '">\n';
    h += '</head>\n<body class="a-body">\n' + siteHeader('/articles/' + rec.sport_slug);
    h += '<main class="a-wrap"><article class="a-article"><p class="a-lede">This article lives at '
      + '<a href="' + esc(rec.canonical_url) + '">' + esc(rec.canonical_url) + '</a>.</p></article></main>';
    h += siteFooter() + '\n</body>\n</html>\n';
    void url;
    return h;
  }

  /* -------------------------------------------------------------- the hub */
  function cardHTML(rec) {
    var when = rec.game_time ? dateLabel(rec.game_time, { timeZoneName: undefined }) : null;
    var h = '<article class="a-cardart" data-sport="' + esc(rec.sport_slug) + '" data-kick="' + esc(iso(rec.game_time) || '') + '">';
    h += '<a class="a-cardlink" href="/articles/' + esc(rec.slug) + '">';
    h += '<div class="a-cardtop"><span class="a-cardsport">' + esc(rec.sport_label) + '</span>'
      + (rec.model_status ? '<span class="a-status">' + esc(rec.model_status) + '</span>' : '')
      + (rec.confidence != null ? '<span class="a-conf">' + esc(rec.confidence) + '%</span>' : '') + '</div>';
    if (rec.hero_image) h += '<img class="a-cardimg" src="' + esc(rec.hero_image) + '" alt="" loading="lazy" width="640" height="360">';
    h += '<h3 class="a-cardh">' + esc(rec.away_team + ' vs. ' + rec.home_team) + '</h3>';
    h += '<p class="a-cardsum">' + esc(rec.excerpt) + '</p>';
    h += '<div class="a-cardmeta">';
    if (rec.fair_spread_text) h += '<span class="a-cardline">' + esc(rec.fair_spread_text) + '</span>';
    if (when) h += '<span>Kickoff ' + esc(when) + '</span>';
    if (rec.published_at) h += '<span>Published ' + esc(dayLabel(rec.published_at)) + '</span>';
    if (rec.updated_at && rec.published_at && rec.updated_at !== rec.published_at) h += '<span>Updated ' + esc(dayLabel(rec.updated_at)) + '</span>';
    h += '</div></a></article>';
    return h;
  }

  /* Sorting is a property of the page, not of a script: each ordering is
     rendered server-side into its own list and a radio input swaps which one
     is visible. No JavaScript, no layout shift, and a crawler sees all of it. */
  function hubPage(o) {
    var recs = o.records || [];
    var scope = o.scope || null;              /* null = all sports */
    var now = o.now ? new Date(o.now).getTime() : Date.now();
    var title = o.title, desc = o.description, canonical = o.canonical;

    var byPublished = recs.slice().sort(function (a, b) {
      return (Date.parse(b.published_at || b.updated_at || 0) || 0) - (Date.parse(a.published_at || a.updated_at || 0) || 0);
    });
    var byUpdated = recs.slice().sort(function (a, b) {
      return (Date.parse(b.updated_at || b.published_at || 0) || 0) - (Date.parse(a.updated_at || a.published_at || 0) || 0);
    });
    var upcoming = recs.filter(function (r) {
      var t = Date.parse(r.game_time);
      return isFinite(t) && t >= now;
    }).sort(function (a, b) { return Date.parse(a.game_time) - Date.parse(b.game_time); });

    var ld = [{
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: title, description: desc, url: canonical, inLanguage: 'en-US',
      isPartOf: { '@type': 'WebSite', name: ORG, url: SITE },
      publisher: { '@type': 'Organization', name: ORG, url: SITE },
      mainEntity: {
        '@type': 'ItemList', numberOfItems: byPublished.length,
        itemListElement: byPublished.slice(0, 50).map(function (r, i) {
          return { '@type': 'ListItem', position: i + 1, url: r.canonical_url, name: r.title };
        })
      }
    }];

    var h = '<!doctype html>\n<html lang="en">\n<head>\n';
    h += head({ title: title, description: desc, canonical: canonical, og_type: 'website',
      og_title: o.og_title || title, noindex: !!o.noindex, ld: o.noindex ? [] : ld });
    h += '</head>\n<body class="a-body">\n';
    h += siteHeader(o.active || '/articles');
    h += '<main class="a-wrap hub" id="main">';
    h += '<header class="a-hubhead"><h1 class="a-h1">' + esc(o.h1) + '</h1>'
      + '<p class="a-standfirst">' + esc(o.standfirst) + '</p>'
      + '<p class="a-hubcount">' + recs.length + ' published ' + (recs.length === 1 ? 'article' : 'articles') + '</p></header>';

    /* THE ONE PLACE A MEMBER STARTS WRITING. It sits above the filters rather
       than in the footer because a call to action nobody sees is not one, and
       it says in the same breath that a member post is a different thing from
       what the rest of this page is — the separation has to be legible before
       somebody clicks, not after they have written. */
    h += '<div class="a-writebar">'
      + '<p><b>Got a read of your own?</b> Anyone with an EdgeDesk account can write for the member section. '
      + 'Member posts are the author’s own view, kept separate from EdgeDesk’s model research.</p>'
      + '<a class="a-ctabtn" href="/articles/write">Write a post</a>'
      + '<a class="a-sharebtn" href="/articles/community">Read member posts</a>'
      + '</div>';

    /* the sport filter — three real links, so each is a crawlable URL */
    h += '<nav class="a-filters" aria-label="Filter by sport">';
    [['All', '/articles'], ['College Football', '/articles/college-football'], ['NFL', '/articles/nfl']].forEach(function (f) {
      h += '<a class="a-filter' + (canonical === SITE + f[1] ? ' on' : '') + '" href="' + f[1] + '">' + esc(f[0]) + '</a>';
    });
    h += '</nav>';

    if (!recs.length) {
      h += '<p class="a-nodata">No article is published in this section yet. EdgeDesk publishes one per matchup once the research clears its own publication checks — never a placeholder.</p>';
    } else {
      h += '<div class="a-sortpanel">';
      h += '<h2 class="a-h2" id="latest-research">Latest research</h2>';
      h += '<div class="a-sorttabs">'
        + '<input type="radio" name="a-sort" id="sort-latest" checked><label for="sort-latest">Most recent research</label>'
        + '<input type="radio" name="a-sort" id="sort-upcoming"><label for="sort-upcoming">Upcoming games</label>'
        + '<input type="radio" name="a-sort" id="sort-updated"><label for="sort-updated">Recently published</label>'
        + '<div class="a-list a-list-latest">' + byPublished.map(cardHTML).join('') + '</div>'
        + '<div class="a-list a-list-upcoming">'
        + (upcoming.length ? upcoming.map(cardHTML).join('')
          : '<p class="a-nodata">Every published article in this section is for a game that has already kicked off.</p>')
        + '</div>'
        + '<div class="a-list a-list-updated">' + byUpdated.map(cardHTML).join('') + '</div>'
        + '</div></div>';
    }
    h += '<section class="a-about"><h2 class="a-h2">How to read an EdgeDesk article</h2>'
      + '<p>Every article on this page is built from the same research the EdgeDesk terminal runs: one model, one set of numbers, published with its own confidence and its own gaps. EdgeDesk prices a game before it looks at a sportsbook, says which inputs moved the number and which did not, and names what it could not measure.</p>'
      + '<p><b>Research, not picks.</b> Nothing here is a wager, a recommendation or advice. A model status of <code>THIN DATA</code>, <code>INVESTIGATE</code> or <code>UNPROVEN</code> means exactly what it says, and EdgeDesk leaves it on the page rather than dressing it up.</p>'
      + '<p><a class="a-ctabtn" href="/app.html#research/football">Open the EdgeDesk research terminal</a></p></section>';
    h += '</main>' + siteFooter() + '\n</body>\n</html>\n';
    return h;
  }

  return {
    SITE: SITE, esc: esc, head: head, anchorId: anchorId,
    structuredData: structuredData, articlePage: articlePage, aliasPage: aliasPage,
    hubPage: hubPage, cardHTML: cardHTML, articleBody: articleBody, dateLabel: dateLabel
  };
});
/*__EDART_RENDER_END__*/
