/* ===========================================================================
   EdgeDesk SEARCH — one box for every place and record the terminal holds.
   docs/research-os/DESIGN.md §7

   Opened from the header, the Overview, Ctrl/⌘ K or "/". It searches what
   this page already holds, so it answers as the reader types:

     Games       the slate the terminal loaded (EDGamesUI.snapshot()): every
                 game in its window and the next ones, by team, short name,
                 abbreviation and league; each result opens the game's own
                 research, by the slate's ids
     Teams       the same slate's teams, each to its next game
     Your saved  the reader's watchlist rows and Card entries, recently viewed
     Places      every destination, research module, Simulator sport and tool
     Positions   the reader's own recorded positions (portfolio_search under
                 their token), asked after a short pause, only when signed in

   NOTHING NEW IS INDEXED. There is no second sports database: a game is
   found by the slate's own id and research key, and a result is only a link
   into the feature that owns the record — which decides, on the server, what
   the reader may see there. Operator pages are never listed.

   Browser: window.EDSearch. Node: require('./edgedesk_search.js') for the
   index and the matcher (tools/research_os/research_os.test.js).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDSearch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var Q = { VERSION: 'edgedesk_search/1' };
  var D = 86400000;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ms(t) { if (typeof t === 'number') return isFinite(t) ? t : null; var x = Date.parse(t); return isFinite(x) ? x : null; }
  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  Q.norm = norm;

  /* ======================================================== THE PLACES
     The terminal's destinations beyond the navigation itself (which comes
     from EDShell.NAV): research modules, tools, transparency, account, help. */
  Q.PLACES = [
    { t: "Today's games", s: 'Every sport on your calendar day, with research links', href: '#games', k: 'schedule slate today tonight scores' },
    { t: 'Football research', s: 'NFL and college football boards', href: '#research/football', k: 'nfl cfb college fbs matchups board' },
    { t: 'Player props', s: 'Prop research terminal (NFL and CFB)', href: '#playerprops', k: 'props players' },
    { t: 'Edges', s: 'Captured prices against the sharp fair line', href: '#research/edges', k: 'line shopping ev market activity' },
    { t: 'NBA research', s: 'Research › Other › NBA', href: '#research/nba', k: 'basketball' },
    { t: 'NHL research', s: 'Research › Other › NHL', href: '#research/nhl', k: 'hockey goalies' },
    { t: 'Baseball research', s: 'Research › Other › Baseball', href: '#research/baseball', k: 'mlb college baseball pitchers' },
    { t: 'UFC research', s: 'Research › Other › UFC', href: '#research/ufc', k: 'mma fights fighters' },
    { t: 'Lines', s: 'EdgeDesk’s fair-line sheets, with their record', href: '#research/lines', k: 'linemaker fair lines alternate team totals' },
    { t: 'Engine', s: 'Cross-sport board and readiness', href: '#research/engine', k: 'multisport readiness' },
    { t: 'Stats', s: 'Team and player statistics', href: '#research/stats', k: 'statistics players' },
    { t: 'Lab', s: 'Advanced research and data provenance', href: '#research/lab', k: 'provenance data sources experiments' },
    { t: 'Model DNA', s: 'Can I trust this model in this situation?', href: '#signals/dna', k: 'model record calibration reliability' },
    { t: 'Signal coverage', s: 'Which sport supports which signal, and why not', href: '#signals/coverage', k: 'signals coverage' },
    { t: 'Signal alerts', s: 'Your sports, teams and levels', href: '#signals/alerts', k: 'notifications alerts' },
    { t: 'Model performance & P&L', s: 'EdgeDesk’s graded recommendations, at their recorded prices', href: '#record', k: 'record pnl profit loss clv model' },
    { t: 'Public forecast record', s: 'Every forecast, graded, misses included', href: '/performance/', k: 'performance accuracy brier calibration' },
    { t: 'Model Collective', s: 'Independent model creators, one graded record', href: '#collective', k: 'creators models community' },
    { t: 'Portfolio analytics', s: 'Your positions by sport, market and platform', href: '#portfolio/analytics', k: 'roi results my bets' },
    { t: 'Import picks', s: 'Bring positions in from a CSV or screenshots', href: '#portfolio/import', k: 'csv screenshot import upload' },
    { t: 'Connected accounts', s: 'Portfolio › Accounts', href: '#portfolio/accounts', k: 'sportsbook connect sync' },
    { t: 'Settings & account', s: 'Profile, billing, display, odds format, landing page', act: 'settings', k: 'billing profile subscription preferences odds format' },
    { t: 'Methodology', s: 'How EdgeDesk prices, grades and proves itself', act: 'method', k: 'how it works methodology' },
    { t: 'Model & data health', s: 'Feeds, builds and the database, in plain words', act: 'health', k: 'status system health feeds' },
    { t: 'Learn EdgeDesk', s: 'Walkthroughs and every term explained', act: 'help', k: 'help glossary tutorial guide' },
    { t: 'Terms & disclaimer', s: 'Research only. 21+.', href: '#terms', k: 'legal terms disclaimer' }
  ];
  Q.ACTS = {
    settings: function () { if (typeof root.__avGo === 'function') root.__avGo('edge'); else if (typeof root.show === 'function') root.show('settings'); },
    method: function () { if (typeof root.hiwOpen === 'function') root.hiwOpen(); },
    health: function () { if (typeof root.sysHealthOpen === 'function') root.sysHealthOpen(); },
    help: function () { if (root.EDGuide && root.EDGuide.openHelp) root.EDGuide.openHelp(); }
  };

  /* ============================================================ THE INDEX
     src: { nav, events, markets, zone, now, sims, watch, card, recent, researchTarget, links, sportOf } */
  Q.build = function (src) {
    src = src || {};
    var items = [], now = src.now == null ? Date.now() : src.now;
    (src.nav || []).forEach(function (n) { items.push({ cat: 'place', t: n.label, s: n.q || '', href: n.hash, k: [n.v, n.short, n.aria].join(' ') }); });
    Q.PLACES.forEach(function (p) { items.push({ cat: 'place', t: p.t, s: p.s, href: p.href || null, act: p.act || null, k: p.k }); });
    (src.sims || []).forEach(function (s) { items.push({ cat: 'place', t: s.label + ' Simulator', s: 'Season, playoff and title probabilities' + (s.status && s.status !== 'ACTIVE' ? ' · ' + s.status.toLowerCase().replace('_', ' ') : ''), href: '#simulator/' + s.key, k: 'simulation futures championship ' + s.key }); });
    var teams = {};
    (src.events || []).forEach(function (e) {
      if (!e || !e.id || !e.home || !e.away) return;
      var t = ms(e.start_utc), sp = src.sportOf ? src.sportOf(e.sport) : null;
      if (t != null && (t < now - D || t > now + 15 * D)) return;
      var tgt = src.researchTarget ? src.researchTarget(e) : null, lk = src.links ? src.links(e) : {};
      var href = (tgt && tgt.href) || lk.research || ('#games/' + e.sport);
      var lab = (e.away.name || e.away.short) + ' at ' + (e.home.name || e.home.short);
      items.push({ cat: 'game', t: lab, s: (sp ? sp.label : String(e.sport).toUpperCase()) + ' · ' + (src.when ? src.when(e) : (e.start_utc || '')), href: href, id: e.id, start: t, ctx: e,
        alt: lk.foresight ? [{ label: 'Foresight', href: lk.foresight }] : [],
        k: [e.sport, sp && sp.label, sp && sp.name, e.league, e.home.short, e.home.abbr, e.away.short, e.away.abbr, e.venue, 'vs'].join(' ') });
      [e.home, e.away].forEach(function (tm) {
        var key = e.sport + '|' + norm(tm.name || tm.short);
        var cur = teams[key];
        if (!cur || (t != null && t >= now - 4 * 3600000 && (cur.start == null || t < cur.start || cur.start < now - 4 * 3600000))) teams[key] = { cat: 'team', t: tm.name || tm.short, s: (sp ? sp.label : e.sport) + ' · next: ' + lab, href: href, start: t, ctx: e, k: [tm.short, tm.abbr, sp && sp.label, e.sport].join(' ') };
      });
    });
    Object.keys(teams).forEach(function (k) { items.push(teams[k]); });
    (src.watch || []).forEach(function (w) {
      var m = /^([a-z0-9]+)\|(.+)$/.exec(String(w.game_key || '')); if (!m) return;
      items.push({ cat: 'saved', t: (w.away || '') + ' at ' + (w.home || ''), s: 'On your watchlist' + (w.changed ? ' · changed since you last looked' : ''), href: (m[1] === 'nfl' || m[1] === 'cfb') ? '#game/' + m[1] + '/' + encodeURIComponent(m[2]) : '#research/football', k: m[1] + ' watchlist saved' });
    });
    (src.card || []).forEach(function (c) {
      items.push({ cat: 'saved', t: (c.selection || 'Card entry') + (c.player_name ? ' · ' + c.player_name : ''), s: 'On your Card · ' + (c.away || '') + ' at ' + (c.home || '') + (c.decision ? ' · ' + c.decision : ''), href: '#card', k: [c.home, c.away, c.market_label, c.book, c.sport, 'card'].join(' ') });
    });
    (src.recent || []).forEach(function (r) {
      items.push({ cat: 'saved', t: (r.away || '') + ' at ' + (r.home || ''), s: 'Viewed recently', href: (src.linksCtx ? src.linksCtx(r).research : null) || '#games', k: [r.sport, 'recent'].join(' '), recent: true });
    });
    items.forEach(function (it) { it.n = norm(it.t); it.h = norm(it.t + ' ' + (it.k || '') + ' ' + (it.s || '')); });
    return items;
  };

  /* =========================================================== MATCHING
     Every word of the query must start a word of the item (or appear inside
     a team abbreviation run together). Score: the title starts with the
     query, then every word starts a title word, then a match elsewhere; games
     soonest first; a category's weight breaks ties. */
  var CAT_W = { game: 0, team: 1, saved: 2, place: 3, position: 4 };
  Q.CATS = [['game', 'Games'], ['team', 'Teams'], ['saved', 'Your saved research'], ['place', 'Places and tools'], ['position', 'Your positions']];
  Q.match = function (items, q, o) {
    o = o || {};
    var nq = norm(q), now = o.now == null ? Date.now() : o.now;
    if (!nq) return [];
    var words = nq.split(' ');
    var out = [];
    items.forEach(function (it) {
      var hw = ' ' + it.h, tw = ' ' + it.n;
      var all = words.every(function (w) { return hw.indexOf(' ' + w) >= 0 || (w.length >= 3 && it.h.indexOf(w) >= 0); });
      if (!all) return;
      var score = 0;
      if (it.n.indexOf(nq) === 0) score += 100;
      else if (words.every(function (w) { return tw.indexOf(' ' + w) >= 0; })) score += 60;
      else if (words.every(function (w) { return hw.indexOf(' ' + w) >= 0; })) score += 30;
      else score += 10;
      if ((it.cat === 'game' || it.cat === 'team') && it.start != null) {
        var dt = (it.start - now) / 3600000;
        score += dt >= -4 ? Math.max(0, 20 - dt / 12) : -10;
      }
      out.push({ it: it, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score || CAT_W[a.it.cat] - CAT_W[b.it.cat] || (a.it.start || 0) - (b.it.start || 0) || (a.it.t < b.it.t ? -1 : 1); });
    var per = {}, lim = o.perCat || 6, res = [];
    out.forEach(function (x) { per[x.it.cat] = (per[x.it.cat] || 0) + 1; if (per[x.it.cat] <= lim) res.push(x.it); });
    return res.slice(0, o.max || 30);
  };

  /* ============================================================ BROWSER */
  var S = { el: null, items: null, builtAt: 0, slateAt: null, results: [], active: -1, returnTo: null, seq: 0, pos: [] };
  function sources() {
    var G = root.EDGames, CX = root.EDContext, U = root.EDGamesUI, snap = U && U.snapshot ? U.snapshot() : { events: [] };
    var zone = snap.zone || (G ? G.CONFIG.default_zone : 'America/Chicago');
    var watch = []; try { watch = (root.EDMine && root.EDMine.S && root.EDMine.S.watchRows) || []; } catch (_) { watch = []; }
    var card = []; try { card = root.EDDecisionUI && root.EDDecisionUI.entries ? root.EDDecisionUI.entries() : []; } catch (_) { card = []; }
    var sims = []; try { sims = (root.EDSimSports && root.EDSimSports.sports) || []; } catch (_) { sims = []; }
    var simKeys = {}; sims.forEach(function (s) { simKeys[s.key] = 1; });
    return {
      nav: root.EDShell ? root.EDShell.NAV : [], events: snap.events || [], zone: zone, now: Date.now(), sims: sims, watch: watch, card: card, recent: CX ? CX.recent() : [],
      sportOf: function (id) { return G ? G.sport(id) : null; },
      researchTarget: function (e) { return G ? G.researchTarget(e, 'app') : null; },
      links: function (e) { return CX ? CX.links(CX.fromSlateEvent(e), { simSports: simKeys }) : {}; },
      linksCtx: function (ctx) { return CX ? CX.links(ctx, { simSports: simKeys }) : {}; },
      when: function (e) { var t = ms(e.start_utc); if (!G || t == null || e.time_tbd) return 'time TBA'; var dk = G.dateKey(t, zone), td = G.today(Date.now(), zone); return G.relDay(dk, td) + ' · ' + G.timeText(t, zone); },
      slateAt: snap.loaded_at || null
    };
  }
  function index() {
    var src = sources();
    if (!S.items || S.slateAt !== src.slateAt || Date.now() - S.builtAt > 60000) { S.items = Q.build(src); S.builtAt = Date.now(); S.slateAt = src.slateAt; }
    return S.items;
  }
  function $(id) { return root.document.getElementById(id); }
  function ensureDom() {
    if (S.el) return S.el;
    var d = root.document.createElement('div');
    d.id = 'edSearch'; d.className = 'eds'; d.hidden = true;
    d.innerHTML = '<div class="eds-scrim" data-eds-close></div><div class="eds-box" role="dialog" aria-modal="true" aria-labelledby="edsT">'
      + '<h2 id="edsT" class="eds-sr">Search EdgeDesk</h2>'
      + '<div class="eds-in"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>'
      + '<input id="edsQ" type="search" role="combobox" aria-expanded="false" aria-controls="edsL" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search teams, games, tools, your saved research…" aria-label="Search EdgeDesk">'
      + '<button type="button" class="eds-x" data-eds-close aria-label="Close search">Esc</button></div>'
      + '<div id="edsL" class="eds-l" role="listbox" aria-label="Results"></div>'
      + '<p class="eds-foot" id="edsFoot">Games come from EdgeDesk’s schedule; each result opens the feature that holds it. ↑↓ to move · Enter to open · Esc to close</p></div>';
    root.document.body.appendChild(d);
    S.el = d;
    d.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target : null; if (!t) return;
      if (t.closest('[data-eds-close]')) { Q.close(); return; }
      var o = t.closest('[data-eds-i]'); if (o) { e.preventDefault(); choose(+o.getAttribute('data-eds-i'), t.closest('[data-eds-alt]') ? t.closest('[data-eds-alt]').getAttribute('data-eds-alt') : null); }
    });
    var inp = d.querySelector('#edsQ');
    inp.addEventListener('input', function () { run(inp.value); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); Q.close(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' && e.target === inp) { e.preventDefault(); if (S.active >= 0) choose(S.active); else if (S.results.length) choose(0); return; }
      if (e.key === 'Tab') {
        var f = Array.prototype.filter.call(d.querySelectorAll('input,button,[href]'), function (x) { return x.offsetParent !== null; });
        if (!f.length) return;
        var i = f.indexOf(root.document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    return d;
  }
  function optHTML(it, i) {
    var alt = (it.alt || []).map(function (a, j) { return '<span class="eds-alt" data-eds-alt="' + j + '">' + esc(a.label) + '</span>'; }).join('');
    return '<div class="eds-o" role="option" id="edsO' + i + '" data-eds-i="' + i + '" aria-selected="false"><span class="eds-t">' + esc(it.t) + '</span><span class="eds-s">' + esc(it.s || '') + '</span>' + alt + '</div>';
  }
  function paint(q) {
    var L = $('edsL'), inp = $('edsQ'); if (!L) return;
    if (!String(q || '').trim()) {
      S.all = (index().filter(function (x) { return x.recent; })).slice(0, 5);
      L.innerHTML = S.all.length ? '<div class="eds-g" role="presentation">Recently viewed</div>' + S.all.map(optHTML).join('') : '<p class="eds-empty">Type a team, a matchup (“Cowboys Eagles”), a sport, or a place (“Simulator”, “import”).</p>';
    } else {
      /* grouped by category, each option keeping its index in S.all */
      var all = S.results.concat(S.pos), h = '';
      S.all = [];
      Q.CATS.forEach(function (c) {
        var rows = all.filter(function (x) { return x.cat === c[0]; }); if (!rows.length) return;
        h += '<div class="eds-g" role="presentation">' + esc(c[1]) + '</div>' + rows.map(function (x) { S.all.push(x); return optHTML(x, S.all.length - 1); }).join('');
      });
      L.innerHTML = S.all.length ? h : '<p class="eds-empty" role="status">Nothing matches “' + esc(q) + '” on EdgeDesk’s schedule or among its places. A game outside the next two weeks is not listed.</p>';
    }
    S.active = S.all.length ? 0 : -1;
    inp.setAttribute('aria-expanded', S.all.length ? 'true' : 'false');
    mark();
  }
  function mark() {
    var L = $('edsL'), inp = $('edsQ'); if (!L) return;
    Array.prototype.forEach.call(L.querySelectorAll('[role="option"]'), function (o) { var on = +o.getAttribute('data-eds-i') === S.active; o.setAttribute('aria-selected', on ? 'true' : 'false'); o.classList.toggle('on', on); if (on && o.scrollIntoView) o.scrollIntoView({ block: 'nearest' }); });
    if (S.active >= 0) inp.setAttribute('aria-activedescendant', 'edsO' + S.active); else inp.removeAttribute('aria-activedescendant');
  }
  function move(d) { if (!S.all || !S.all.length) return; S.active = (S.active + d + S.all.length) % S.all.length; mark(); }
  function run(q) {
    var t0 = Date.now();
    S.pos = [];
    S.results = Q.match(index(), q, { now: Date.now() });
    S.lastMs = Date.now() - t0;
    paint(q);
    /* the reader's own positions: asked after a pause, under their token */
    var seq = ++S.seq, X = root.EDShell;
    if (String(q || '').trim().length >= 2 && X && X.signedIn() && root.EDPortfolioUI && root.EDPortfolioUI.searchPositions) {
      setTimeout(function () {
        if (seq !== S.seq) return;
        root.EDPortfolioUI.searchPositions(q).then(function (rows) {
          if (seq !== S.seq || !rows || !rows.length) return;
          S.pos = rows.slice(0, 5).map(function (r) { return { cat: 'position', t: r.event_name + ' · ' + r.selection, s: [r.platform_label, String(r.placed_at || '').slice(0, 10), r.result || r.status].filter(Boolean).join(' · '), rec: r.id }; });
          paint(q);
        }).catch(function () { /* the rest of search stands */ });
      }, 250);
    }
  }
  function choose(i, alt) {
    var it = (S.all || [])[i]; if (!it) return;
    Q.close(false);
    try { if (it.ctx && root.EDContext) root.EDContext.set(root.EDContext.fromSlateEvent(it.ctx), { panel: 'search' }); } catch (_) { /* context is optional */ }
    try { if (typeof root.edNavTrack === 'function') root.edNavTrack('secondary', 'search:' + it.cat); } catch (_) { /* evidence is optional */ }
    if (it.rec && root.edOpenRecord) { root.edOpenRecord(it.rec); return; }
    if (it.act && Q.ACTS[it.act]) { Q.ACTS[it.act](); return; }
    var href = alt != null && it.alt && it.alt[+alt] ? it.alt[+alt].href : it.href;
    if (!href) return;
    if (href.charAt(0) === '#') { if (root.EDShell) root.EDShell.go(href); else root.location.hash = href; }
    else if (/^\/[^/]/.test(href)) root.open(href, '_blank', 'noopener');
  }
  Q.open = function (from) {
    var d = ensureDom();
    if (!d.hidden) { $('edsQ').focus(); return; }
    S.returnTo = from && from.focus ? from : root.document.activeElement;
    d.hidden = false; root.document.body.classList.add('eds-open');
    var inp = $('edsQ'); inp.value = ''; S.items = null; S.pos = []; S.results = []; S.all = null;
    paint('');
    try { inp.focus(); } catch (_) { /* focus is best effort */ }
  };
  Q.close = function (restore) {
    if (!S.el || S.el.hidden) return;
    S.el.hidden = true; root.document.body.classList.remove('eds-open'); S.seq++;
    if (restore !== false && S.returnTo && S.returnTo.focus) { try { S.returnTo.focus(); } catch (_) { /* gone */ } }
  };
  Q._state = S;
  return Q;
});
