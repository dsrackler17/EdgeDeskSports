/* ===========================================================================
   EdgeDesk landing page — FREE RESEARCH, FIRST.

   The landing page's free half, kept out of index.html (whose weight budget
   is the preserved auth and billing block's): the hero's no-vig calculator
   and the #free section's games and latest research.

     the calculator   lib/edgedesk_odds_tools.js, the same arithmetic
                      /tools/no-vig-calculator/ prints with its working; one
                      tool_used per page load (entity no_vig_home)
     the games        the board the page already read (public_home_board()
                      through lib/edgedesk_home.js), soonest first; with no
                      public read, the week's schedule
                      (football/home/schedule.json, no model number)
     the research     /articles/data/published.json — this week's pregame
                      articles first, then the most recent

   Public data only. Behind EDFlags home_free_section (lib/edgedesk_flags.js);
   the markup's links stand on their own when this does not run.

   The page calls init({track, funnel, chip, wait}) once — its own GA and
   funnel senders, so every event carries the hero variant like the rest —
   then games(view) whenever its board view is built (or games(null)).

   Browser: window.EDHomeFree. Node: require('./edgedesk_home_free.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDHomeFree = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var X = {}, ctx = {}, RECENT = 6 * 36e5, WAIT = 7000;
  var doc = root && root.document;
  function $(id) { return doc ? doc.getElementById(id) : null; }
  function e(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function on() { return !(root.EDFlags && !root.EDFlags.on('home_free_section')); }
  function getJson(url) {
    var p = root.fetch(url, { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; });
    return ctx.wait ? ctx.wait(p, WAIT) : p.catch(function () { return null; });
  }
  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    try { return new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch (err) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* ---- the no-vig calculator: pure, so it is tested in Node ------------ */
  function pct(x) { return (x * 100).toFixed(2) + '%'; }
  function minus(t) { return String(t).replace(/^-/, '−'); }
  X.calc = function (a, b) {
    var T = root.EDOddsTools;
    var r = T ? T.noVig([a, b], { method: 'proportional' }) : null;
    if (!r || !r.ok) {
      var es = (r && r.errors) || [];
      return { ok: false, bad: es.map(function (x) { return x.index; }), error: (es[0] && es[0].error) || 'Enter both prices.' };
    }
    return { ok: true, pa: pct(r.outcomes[0].fair), pb: pct(r.outcomes[1].fair),
      oa: 'no-vig ' + minus(r.outcomes[0].fair_american_display), ob: 'no-vig ' + minus(r.outcomes[1].fair_american_display),
      margin: pct(r.overround) };
  };
  function heroCalc() {
    var a = $('hcA'), b = $('hcB'), err = $('hcErr'), used = false;
    if (!a || !b || !root.EDOddsTools) return;
    function run() {
      var r = X.calc(a.value, b.value);
      a.removeAttribute('aria-invalid'); b.removeAttribute('aria-invalid');
      if (!r.ok) {
        /* a field's own error marks that field; a market-level one (prices
           that cannot be one market) marks neither */
        r.bad.forEach(function (i) { if (i === 0) a.setAttribute('aria-invalid', 'true'); else if (i === 1) b.setAttribute('aria-invalid', 'true'); });
        if (err) { err.textContent = r.error; err.hidden = false; }
        return;
      }
      if (err) err.hidden = true;
      $('hcPa').textContent = r.pa; $('hcOa').textContent = r.oa;
      $('hcPb').textContent = r.pb; $('hcOb').textContent = r.ob;
      $('hcVig').textContent = r.margin;
    }
    function input() {
      run();
      if (!used) { used = true; if (ctx.track) ctx.track('hero_calc_used'); if (ctx.funnel) ctx.funnel('tool_used', { entity: 'no_vig_home' }); }
    }
    a.addEventListener('input', input); b.addEventListener('input', input);
    run();
  }

  /* ---- the week's games -------------------------------------------------- */
  X.upcoming = function (games, now) {
    return (games || []).filter(function (g) { var t = Date.parse(g.kickoff_at); return isFinite(t) && t > now - RECENT; })
      .sort(function (a, b) { return Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at); }).slice(0, 4);
  };
  X.games = function (V) {
    var ul = $('freeGames'); if (!ul || !on()) return;
    var now = Date.now(), gs = X.upcoming(V && V.games, now);
    if (gs.length) {
      ul.innerHTML = gs.map(function (g) {
        return '<li><span class="fg-m"><b>' + e(g.matchup) + '</b><small>' + e(g.league_label) + (g.kickoff_text ? ' &middot; ' + e(g.kickoff_text) : '')
          + '</small></span>' + (ctx.chip ? ctx.chip(g) : '') + '</li>';
      }).join('');
      return;
    }
    /* no public read right now: the week's schedule is still a slate */
    getJson('/football/home/schedule.json').then(function (s) {
      var list = (s && s.games || []).filter(function (g) { return Date.parse(g.kickoff) > now - RECENT; }).slice(0, 4);
      if (!list.length) return;
      ul.innerHTML = list.map(function (g) {
        return '<li><span class="fg-m"><b>' + e(g.away) + ' @ ' + e(g.home) + '</b><small>' + (g.league === 'nfl' ? 'NFL' : 'College football')
          + ' &middot; ' + e(when(g.kickoff)) + '</small></span></li>';
      }).join('');
    });
  };

  /* ---- the latest research ----------------------------------------------- */
  X.pickArticles = function (articles, now) {
    var pre = (articles || []).filter(function (a) { return a.type === 'pregame' && a.url && a.title; });
    var next = pre.filter(function (a) { return Date.parse(a.game_time) > now - RECENT; })
      .sort(function (a, b) { return Date.parse(a.game_time) - Date.parse(b.game_time); });
    var rest = pre.filter(function (a) { return next.indexOf(a) < 0; })
      .sort(function (a, b) { return Date.parse(b.game_time) - Date.parse(a.game_time); });
    return next.concat(rest).slice(0, 3);
  };
  function research() {
    var ul = $('freeArts'); if (!ul || !on()) return;
    getJson('/articles/data/published.json').then(function (p) {
      var list = X.pickArticles(p && p.articles, Date.now());
      if (!list.length) return;
      ul.innerHTML = list.map(function (a) {
        return '<li><a href="' + e(String(a.url).replace(/^https:\/\/edgedesksports\.com/, '')) + '" data-cta="free_article">' + e(a.title) + '</a><span>'
          + (a.sport === 'NFL' ? 'NFL' : 'College football') + (a.game_time ? ' &middot; ' + e(when(a.game_time)) : '') + '</span></li>';
      }).join('');
    });
  }

  X.init = function (c) {
    ctx = c || {};
    heroCalc();
    research();
  };
  return X;
});
