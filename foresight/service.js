/* ===========================================================================
   MARKET FORESIGHT, AS A SERVICE TO THE TERMINAL — small, always loaded.
   docs/research-os/DESIGN.md §5 · docs/market-foresight/README.md

   What the rest of the terminal may ask of Market Foresight, through
   EDShell.provide('foresight', …) — nothing outside this directory names the
   layer (tools/foresight/isolation.test.js), and nothing here feeds a
   ranking, a grade or a model: it answers status questions for display.

     status()         mf_status(): mode, the reader's access, the last run —
                      no forecast and no price (memoized for a minute)
     game(sport, id)  mf_game(), counted for the game page's preview; the
                      server decides what the reader may see (shadow mode
                      shows operators only; the timeline needs Full Access)
     previewHTML()    that preview in words
     covers(sport)    NFL and college football pregame markets: the documented
                      initial scope, and nothing else
     open(host, hash) the record itself: loads the page's renderers and
                      controller on first use (foresight/app.js), then mounts
   Foresight stays in whatever mode the database holds; nothing here can
   change it.
   =========================================================================== */
(function () {
  'use strict';
  var W = window, SCOPE = { nfl: 1, cfb: 1 }, V = '20261026ros1';
  function X() { return W.EDShell || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function parse(h) {
    var m = /^#foresight(?:\/(game|model)\/([^/?#]+)(?:\/([^/?#]+))?)?\/?$/.exec(String(h || ''));
    if (!m) return null;
    var dec = function (x) { try { return decodeURIComponent(x); } catch (_) { return x; } };
    if (m[1] === 'game' && dec(m[2]).indexOf(':') > 0) return { game: dec(m[2]) };
    if (m[1] === 'model' && dec(m[2]).indexOf(':') > 0) return { model: dec(m[2]), v: m[3] ? dec(m[3]) : null };
    return {};
  }
  function hashFor(r) {
    if (r && r.game) return '#foresight/game/' + encodeURIComponent(r.game);
    if (r && r.model) return '#foresight/model/' + encodeURIComponent(r.model) + (r.v ? '/' + encodeURIComponent(r.v) : '');
    return '#foresight';
  }

  function status() {
    var x = X(); if (!x) return Promise.resolve({ state: 'error' });
    return x.memo('mf:status', 60000, function () {
      return x.rpc('mf_status', {}).then(function (st) {
        if (!st) return { state: 'error' };
        var rd = st.reader || {};
        return { state: 'ok', mode: st.mode, can_read: !!rd.can_read, full_access: !!rd.full_access, admin: !!rd.admin,
          last_run_at: st.last_run ? (st.last_run.finished_at || st.last_run.started_at) : null, methodology: st.methodology ? st.methodology.version : null };
      }).catch(function (e) { return x.notDeployed(e) ? { state: 'not_deployed' } : { state: 'error' }; });
    });
  }
  function game(sport, id) {
    var x = X(); if (!x || !SCOPE[sport]) return Promise.resolve({ state: 'out_of_scope' });
    return status().then(function (st) {
      if (st.state !== 'ok') return st;
      if (st.mode === 'off') return { state: 'ok', mode: 'off' };
      if (!st.can_read) return { state: 'ok', mode: st.mode, locked: true };
      return x.memo('mf:game:' + sport + ':' + id, 5 * 60000, function () {
        return x.rpc('mf_game', { p_sport: sport, p_event_id: String(id) }).then(function (r) {
          if (!r || r.locked) return { state: 'ok', mode: st.mode, locked: true };
          if (!r.found) return { state: 'ok', mode: st.mode, found: false };
          var u = r.units || [], by = {};
          u.forEach(function (y) { var k = y.market || 'other'; by[k] = by[k] || { measured: 0, not: 0 }; if (y.status === 'measured') by[k].measured++; else by[k].not++; });
          return { state: 'ok', mode: st.mode, found: true, computed_at: r.computed_at, methodology: r.methodology, full_access: !!r.full_access,
            measured: u.filter(function (y) { return y.status === 'measured'; }).length, units: u.length, by_market: by };
        });
      });
    }).catch(function (e) { return x.notDeployed(e) ? { state: 'not_deployed' } : { state: 'error' }; });
  }
  var MK = { spread: 'Spread', total: 'Total', moneyline: 'Win probability' };
  function previewHTML(p, href) {
    var body, x = X();
    if (!p || p.state === 'loading') body = '<p class="gw-note">Checking the record…</p>';
    else if (p.state === 'out_of_scope') body = '<p class="gw-note">Market Foresight covers NFL and college football pregame markets only.</p>';
    else if (p.state === 'not_deployed') body = '<p class="gw-note">Built and in review; its database layer is not deployed yet, so nothing is measured here.</p>';
    else if (p.state === 'error') body = '<p class="gw-note">The record could not be read just now. Research on this page is unaffected.</p>';
    else if (p.mode === 'off') body = '<p class="gw-note">Market Foresight is switched off.</p>';
    else if (p.locked) body = '<p class="gw-note">' + (p.mode === 'shadow' ? 'In review: measurements are visible to operators only while the first runs are checked.' : 'Not available to this account.') + '</p>';
    else if (!p.found) body = '<p class="gw-note">Not in the record yet: games are measured once they have kicked off, from the prices and forecasts EdgeDesk recorded before.</p>';
    else body = '<p class="gw-note"><b>' + esc(p.measured) + '</b> of ' + esc(p.units) + ' forecast–venue units measured' + (p.computed_at && x ? ', computed ' + esc(x.ago(p.computed_at) || '') : '') + ' under ' + esc(p.methodology || 'the frozen methodology') + '.</p>'
      + '<ul class="gw-mini">' + Object.keys(p.by_market).map(function (k) { var b = p.by_market[k]; return '<li>' + esc(MK[k] || k) + ': ' + esc(b.measured) + ' measured · ' + esc(b.not) + ' not measured (each with its reason)</li>'; }).join('') + '</ul>'
      + '<p class="gw-note">' + (p.full_access ? 'The full timeline, with every observation, is on the game’s record.' : 'Findings and coverage are on the game’s record; the full timeline is part of Full Access.') + '</p>';
    return body + (href ? '<a class="gw-btn ghost" href="' + esc(href) + '">Open the game’s Foresight record</a>' : '');
  }

  /* the record's own renderers and controller, loaded on the first visit */
  var LOADING = null;
  function script(src) {
    return new Promise(function (res, rej) {
      var have = document.querySelector('script[data-mf="' + src + '"]');
      if (have) { if (have.getAttribute('data-ok')) res(); else { have.addEventListener('load', function () { res(); }); have.addEventListener('error', function () { rej(new Error('failed to load ' + src)); }); } return; }
      var s = document.createElement('script'); s.src = src; s.setAttribute('data-mf', src);
      s.onload = function () { s.setAttribute('data-ok', '1'); res(); }; s.onerror = function () { rej(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function load() {
    if (W.EDForesightApp) return Promise.resolve(W.EDForesightApp);
    if (!LOADING) LOADING = script('/lib/edgedesk_foresight_ui.js?v=20261025mf1').then(function () { return script('/foresight/foresight.js?v=' + V); })
      .then(function () { return script('/foresight/app.js?v=' + V); })
      .then(function () { if (!W.EDForesightApp) throw new Error('the record did not load'); return W.EDForesightApp; })
      .catch(function (e) { LOADING = null; throw e; });
    return LOADING;
  }
  function open(host, h) {
    if (!host) return Promise.resolve();
    if (!W.EDForesightApp) host.innerHTML = '<div class="empty" role="status">Loading Market Foresight…</div>';
    return load().then(function (A) { A.open(host, h); }, function () {
      host.innerHTML = '<div class="empty" role="alert">Market Foresight did not load just now. <button type="button" class="ov-link" data-mf-retry>Try again</button> · The public page is <a href="/foresight/">/foresight/</a>.</div>';
      var b = host.querySelector('[data-mf-retry]'); if (b) b.onclick = function () { open(host, h); };
    });
  }

  var API = { status: status, game: game, previewHTML: previewHTML, covers: function (s) { return !!SCOPE[s]; }, parse: parse, hashFor: hashFor, open: open, load: load };
  W.EDForesightService = API;
  function install() { var x = X(); if (x) x.provide('foresight', API); }
  if (X()) install(); else document.addEventListener('DOMContentLoaded', install);
})();
