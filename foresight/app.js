/* ===========================================================================
   MARKET FORESIGHT IN THE TERMINAL — the record, drawn inside app.html's
   Market Foresight view. docs/research-os/DESIGN.md §5

   Loaded on first use by foresight/service.js. The page's own controller
   (foresight/foresight.js) and renderers (lib/edgedesk_foresight_ui.js) run
   here with the same element ids, the same mf_* doors and the reader's same
   session token: nothing is re-derived. Routes come from the terminal's hash:
     #foresight                                     the overview
     #foresight/game/<sport>:<event>                one game's record
     #foresight/model/<source>:<key>[/<version>]    one model's record
   Links the page draws for itself (?game=, ?model=, /foresight/, #method)
   stay inside the terminal.
   =========================================================================== */
(function () {
  'use strict';
  var W = window;
  function $(id) { return document.getElementById(id); }
  function svc() { return W.EDForesightService; }
  var SKELETON = '<div class="mf-app" id="mfApp">'
    + '<nav class="crumbs" aria-label="Breadcrumb" id="mf-crumbs"><a href="#foresight">Market Foresight</a></nav>'
    + '<span class="ey">Observational research · not picks · every timestamp’s uncertainty kept</span>'
    + '<h2 id="mf-title" class="mf-app-h">Market Foresight</h2>'
    + '<p class="lede" id="mf-lede">Which forecasts, and which observed venues, preceded subsequent market movement? Each identifiable forecast is matched to the DraftKings and Kalshi prices EdgeDesk recorded before and after it was published. NFL and college football pregame markets.</p>'
    + '<div id="mf-status" class="mf-status" role="status" aria-live="polite">Loading…</div>'
    + '<div id="mf-chips"></div>'
    + '<details class="mf-claims" id="mf-claims" open><summary id="mf-claims-h">What this record says, and what it never says</summary>'
    + '<p>It says “forecast preceded observed movement”, “first observed among tracked venues”, “market moved toward this forecast” or “timing unresolved at available sampling resolution”, and only when the timestamps support it.</p>'
    + '<p>It never says that a model caused a move. It never says who led the whole market, because only the tracked venues are observed. Movement toward a forecast does not mean the forecast was right about the result, and a timing advantage is not a profitable or executable trade.</p></details>'
    + '<div id="mf-view" aria-live="polite"></div>'
    + '<section id="method" class="mf-sec" aria-labelledby="mf-method-h"><h2 id="mf-method-h">Methodology</h2><div id="mf-method"><p class="note">The frozen methodology is <a href="/research/foresight/methodology/mf-v1.json">mf-v1.json</a> (its sha256 is in <a href="/research/foresight/methodology/FROZEN.json">FROZEN.json</a>). It was committed before any measurement was computed.</p></div></section>'
    + '<p class="note mf-app-pub">The public page is <a href="/foresight/" target="_blank" rel="noopener">edgedesksports.com/foresight/</a>: the same record, for sharing.</p>'
    + '</div><div id="mf-tip" class="mf-tip" role="tooltip" hidden></div>';
  var MOUNTED = null, LAST = null;
  function onClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !$('mfApp') || !$('mfApp').contains(a)) return;
    var href = a.getAttribute('href') || '', S = svc();
    var q = /^\?(game|model)=([^&#]+)(?:&v=([^&#]+))?/.exec(href);
    if (q) { e.preventDefault(); var v = decodeURIComponent(q[2]); location.hash = S.hashFor(q[1] === 'game' ? { game: v } : { model: v, v: q[3] ? decodeURIComponent(q[3]) : null }); return; }
    if (href === '/foresight/' && !a.target) { e.preventDefault(); location.hash = '#foresight'; return; }
    if (href === '#method') { e.preventDefault(); var m = $('method'); if (m) { m.scrollIntoView({ block: 'start' }); try { m.setAttribute('tabindex', '-1'); m.focus({ preventScroll: true }); } catch (_) { /* focus is best effort */ } } }
  }
  function open(host, h) {
    if (!host) return;
    if (!W.EDForesightUI || !W.EDForesightPage) { host.innerHTML = '<div class="empty">Market Foresight did not load on this page. The public page is <a href="/foresight/">/foresight/</a>.</div>'; return; }
    if (MOUNTED !== host || !$('mfApp')) { host.innerHTML = SKELETON; if (MOUNTED !== host) host.addEventListener('click', onClick); MOUNTED = host; LAST = null; }
    var r = svc().parse(h || location.hash) || {}, key = svc().hashFor(r);
    if (key === LAST && $('mf-view') && $('mf-view').innerHTML) return;   /* the same place again: keep what is on screen */
    LAST = key;
    W.EDForesightPage.boot({ inApp: true, route: r });
    try { W.scrollTo(0, 0); } catch (_) { /* no scroll in tests */ }
  }
  W.EDForesightApp = { open: open };
})();
