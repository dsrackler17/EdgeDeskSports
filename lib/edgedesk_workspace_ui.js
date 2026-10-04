/* ===========================================================================
   EdgeDesk WORKSPACE — the controllers for the destinations the five-seat
   navigation added (docs/ia/NAVIGATION_AUDIT.md):

     Portfolio   pfOpen / pfRender / pfSetTab        over lib/edgedesk_portfolio.js
     Process     pcOpen                              over lib/edgedesk_process.js
     Setup       edSetupDue / setupOpen              the one-time start for a new account
     Card        cardLinksPaint                      what else the reader is watching
     contextual  edAsk(q, where)                     "Ask EdgeDesk" where the question is
                 edTracked(bet)                      "tracked in Portfolio" without leaving
                 edNewsFor(home, away)               news that names a game's teams

   Everything here is presentation and wiring. The numbers come from the two
   pure libraries; the reader's bets are read through the app's own bets() and
   the Card's EDDecisionUI.placed(), never re-stored in a second place.
   App globals (bets, saveBets, renderLedger, loadMarket, show, researchGo,
   sbGet, GE, prefs, edNavTrack) are read at call time, never at load.
   Browser only: window.*.
   =========================================================================== */
(function () {
  'use strict';
  var W = window;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function track(dest) { try { if (W.edNavTrack) W.edNavTrack('secondary', dest); } catch (e) { /* never in the way */ } }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function PF() { return W.EDPortfolio; }
  function PC() { return W.EDProcess; }

  /* ---------------------------------------------------------- positions
     The reader's positions from both stores, normalised once. The Card's
     placed bets are graded against the committed football record when the
     Card has it loaded; ungraded they are still positions, just open. */
  function cardBets() { try { return W.EDDecisionUI && W.EDDecisionUI.placed ? W.EDDecisionUI.placed() : []; } catch (e) { return []; } }
  function gradeCard(p) { try { return W.EDDecisionUI && W.EDDecisionUI.gradePlaced ? W.EDDecisionUI.gradePlaced(p) : null; } catch (e) { return null; } }
  function positions() {
    var led = []; try { led = typeof W.bets === 'function' ? W.bets() : []; } catch (e) { led = []; }
    return PF() ? PF().collect(led, cardBets(), gradeCard) : [];
  }
  W.edPositions = positions;
  function fmt() {
    return { odds: function (a) { try { return W.GE && W.GE.fmtPrice && W.GE.amToDec ? W.GE.fmtPrice(W.GE.amToDec(a)) : (a > 0 ? '+' + a : String(a)); } catch (e) { return String(a); } } };
  }
  /* the Card grades its placed bets from record/football/<sport>_<season>.json;
     ask it to load what it needs, then paint again */
  function ensureCardGrades(then) {
    try {
      if (W.EDDecisionUI && W.EDDecisionUI.ensureRecords && cardBets().length) {
        var p = W.EDDecisionUI.ensureRecords();
        if (p && p.then) p.then(then, then);
      }
    } catch (e) { /* the positions are still shown, ungraded */ }
  }

  /* ============================================================ PORTFOLIO */
  var TAB_KEY = 'edgedesk_pf_tab_v1';
  var PFS = { tab: lsGet(TAB_KEY) || 'overview', y: null, m: null, busy: false };
  if (!PF() || PF().TABS.indexOf(PFS.tab) < 0) PFS.tab = 'overview';
  function pfVisible() { var v = $('v-portfolio'); return !!(v && !v.classList.contains('hide')); }
  function pfSetTab(tab, fromLink) {
    if (!PF() || PF().TABS.indexOf(tab) < 0) tab = 'overview';
    PFS.tab = tab; lsSet(TAB_KEY, tab);
    var seg = $('pfSeg');
    if (seg) [].forEach.call(seg.querySelectorAll('button'), function (b) { var on = b.getAttribute('data-pf') === tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    PF().TABS.forEach(function (t) { var el = $('pf' + t.charAt(0).toUpperCase() + t.slice(1)); if (el) el.classList.toggle('hide', t !== tab); });
    if (pfVisible()) { try { history.replaceState(null, '', location.pathname + location.search + '#portfolio' + (tab === 'overview' ? '' : '/' + tab)); } catch (e) { /* no history */ } }
    if (!fromLink) track('portfolio:' + tab);
    pfRender();
  }
  W.pfSetTab = pfSetTab;
  function pfRender() {
    if (!PF() || PFS.busy) return;
    PFS.busy = true;
    try {
      var pos = positions(), ov = PF().overview(pos, Date.now()), f = fmt();
      var o = $('pfOverview'); if (o) o.innerHTML = PF().overviewHTML(ov, f);
      if (PFS.y == null) { var d = new Date(); PFS.y = d.getFullYear(); PFS.m = d.getMonth(); }
      var c = $('pfCalendar'); if (c) c.innerHTML = ov.empty ? PF().emptyHTML() : PF().calendarHTML(PF().calendar(pos, PFS.y, PFS.m));
      var cards = pos.filter(function (x) { return x.src === 'card'; });
      var co = $('pfCardOpen'); if (co) co.innerHTML = PF().cardListHTML(cards.filter(function (x) { return !x.result; }), f, 'From the Card');
      var cd = $('pfCardDone'); if (cd) cd.innerHTML = PF().cardListHTML(cards.filter(function (x) { return !!x.result; }), f, 'From the Card');
      var src = $('pfSources'); if (src) src.innerHTML = PF().sourcesHTML(ov);
      var fr = $('pfFresh'); if (fr) fr.textContent = ov.empty ? 'nothing yet' : ov.totals.n + ' position' + (ov.totals.n === 1 ? '' : 's');
    } catch (e) { try { console.error('portfolio render failed:', e); } catch (_) { /* no console */ } }
    finally { PFS.busy = false; }
  }
  W.pfRender = pfRender;
  W.pfOpen = function () {
    pfSetTab(PFS.tab, true);
    try { if (typeof W.renderLedger === 'function') W.renderLedger(); } catch (e) { /* painted below */ }
    /* settle what finished and refresh live CLV, then paint again (loadMarket
       repaints the ledger, which repaints this) */
    try { var p = typeof W.loadMarket === 'function' ? W.loadMarket() : null; if (p && p.then) p.then(pfRender, pfRender); } catch (e) { /* offline */ }
    ensureCardGrades(pfRender);
  };
  /* one listener for the whole Portfolio page */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var b = t.closest('#pfSeg button[data-pf]'); if (b) { pfSetTab(b.getAttribute('data-pf')); return; }
    var g = t.closest('[data-pf-go]'); if (g) { if (!pfVisible() && W.show) W.show('portfolio'); pfSetTab(g.getAttribute('data-pf-go')); return; }
    var cal = t.closest('[data-pf-cal]');
    if (cal) { var step = +cal.getAttribute('data-pf-cal'); PFS.m += step; if (PFS.m < 0) { PFS.m = 11; PFS.y--; } if (PFS.m > 11) { PFS.m = 0; PFS.y++; } pfRender(); return; }
    var nv = t.closest('[data-nav]');
    if (nv) {
      var to = nv.getAttribute('data-nav');
      if (to === 'methodology') { track('process:methodology'); if (typeof W.hiwOpen === 'function') W.hiwOpen(); return; }
      if (W.show) W.show(to);
      return;
    }
  });
  /* IMPORT — a CSV from the reader's book into this device's ledger */
  document.addEventListener('change', function (e) {
    var inp = e.target; if (!inp || (inp.id !== 'pfImportFile' && inp.id !== 'suImportFile')) return;
    var file = inp.files && inp.files[0]; if (!file) return;
    var out = $(inp.id === 'pfImportFile' ? 'pfImportMsg' : 'suImportMsg');
    if (file.size > 5 * 1024 * 1024) { if (out) out.textContent = 'That file is over 5 MB. Export a shorter date range and try again.'; inp.value = ''; return; }
    var rd = new FileReader();
    rd.onload = function () {
      var r = PF().parseCsv(String(rd.result || ''), Date.now());
      if (!r.rows.length) { if (out) out.innerHTML = '<b>Nothing imported.</b> ' + esc(r.errors.slice(0, 3).join(' ')); inp.value = ''; return; }
      var m = PF().mergeImport(W.bets(), r.rows);
      try { W.saveBets(m.list); } catch (er) { if (out) out.textContent = 'This browser would not save the import (storage is full or blocked).'; return; }
      track('portfolio:import');
      if (out) out.innerHTML = '<b>Imported ' + m.added + ' bet' + (m.added === 1 ? '' : 's') + '.</b>' + (m.skipped ? ' ' + m.skipped + ' were already here.' : '')
        + (r.errors.length ? ' ' + r.errors.length + ' row' + (r.errors.length === 1 ? '' : 's') + ' skipped: ' + esc(r.errors.slice(0, 2).join(' ')) + (r.errors.length > 2 ? ' …' : '') : '')
        + ' Imported bets count toward P&amp;L, history and the calendar. They have no captured closing line, so they are not graded for Process.';
      inp.value = '';
      try { W.renderLedger(); } catch (er) { pfRender(); }
      if (inp.id === 'suImportFile') setupPaint();
    };
    rd.onerror = function () { if (out) out.textContent = 'The file could not be read.'; };
    rd.readAsText(file);
  });

  /* ============================================================== PROCESS */
  var PCS = { journalAsked: false };
  function journalSummary() {
    try {
      var M = W.EDMine, P = W.EDPersonal;
      if (!M || !P || !M.S || !M.S.journal || !P.analytics) return null;
      var a = P.analytics(M.S.journal), pr = a.process || {};
      var graded = pr.clv_n || 0;
      return { total: a.counts.total, wagered: a.counts.wagered || 0, passed: a.counts.passed || 0, graded: graded,
        beat: graded && pr.beat_close_rate != null ? Math.round(pr.beat_close_rate * graded) : 0 };
    } catch (e) { return null; }
  }
  function pcPaint() {
    var host = $('processHost'); if (!host || !PC()) return;
    var P = PC().profile(positions(), { now: Date.now() });
    var j = journalSummary();
    host.innerHTML = PC().pageHTML(P, { journal: j || (W.EDMine && W.EDMine.S && W.EDMine.S.schema ? { total: 0 } : null) });
  }
  W.pcOpen = function (force) {
    pcPaint();
    ensureCardGrades(pcPaint);
    /* the decision journal lives on the account; read it once per visit */
    try {
      if ((force || !PCS.journalAsked) && W.EDMine && W.EDMine.loadJournal && W.EDMine.S && W.EDMine.S.schema) {
        PCS.journalAsked = true;
        W.EDMine.loadJournal().then(pcPaint, function () { /* journal not reachable: the rest stands */ });
      }
    } catch (e) { /* the rest of Process stands without it */ }
    if (force) { try { var p = W.autoSettle ? W.autoSettle() : null; if (p && p.then) p.then(pcPaint, pcPaint); } catch (e) { /* offline */ } }
  };
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var j = t.closest('[data-pc-journal]'); if (j) { track('process:journal'); try { W.EDMine.open('quality'); } catch (er) { /* not signed in */ } return; }
    var o = t.closest('[data-pc-open]');
    if (o) { var fam = o.getAttribute('data-pc-open'), d = document.querySelector('#processHost details[data-pc-fam="' + fam + '"]'); if (d) { d.open = true; try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (er) { d.scrollIntoView(); } } }
  });
  /* opening a drill-down is evidence of what readers want from Process */
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (!d || !d.matches || !d.open) return;
    if (d.matches('#processHost details[data-pc-fam]')) track('process:' + d.getAttribute('data-pc-fam'));
    else if (d.matches('#processHost details.pc-ins')) track('process:why');
  }, true);

  /* ================================================================ SETUP
     A new account's first visit: WELCOME → BRING YOUR ACTIVITY → YOUR
     PORTFOLIO → YOUR FIRST READ → ENTER. Once, on this device, and never over a
     deep link. Reachable again from More → Account. */
  var SETUP_KEY = 'edgedesk_setup_v1', NEW_DAYS = 14;
  var SU = { step: 0 };
  W.edSetupDue = function () {
    try {
      if (lsGet(SETUP_KEY)) return false;
      if (location.hash && location.hash !== '#') return false;
      var s = JSON.parse(lsGet('edgedesk_session') || 'null'), u = s && s.user;
      var c = u && Date.parse(u.created_at);
      return !!(isFinite(c) && Date.now() - c < NEW_DAYS * 864e5);
    } catch (e) { return false; }
  };
  function setupDone(to) {
    lsSet(SETUP_KEY, String(Date.now()));
    track('setup:' + (to || 'done'));
    if (to === 'portfolio') { if (W.show) W.show('portfolio'); pfSetTab('accounts', true); return; }
    if (typeof W.researchGo === 'function') W.researchGo((W.prefs && W.prefs().lastResearchSub) || 'football');
  }
  var DEST = [
    ['Research', 'What does EdgeDesk see? Football and props research, the edges, other sports.'],
    ['Card', 'What are you considering? BET, LEAN, WATCH or PASS at today’s price.'],
    ['Portfolio', 'What did you actually bet, and are you up or down?'],
    ['Process', 'What is your history teaching you about how you decide?'],
    ['More', 'Everything else: transparency, system health, account, legal.']
  ];
  function setupPaint() {
    var host = $('setupHost'); if (!host) return;
    var steps = ['Welcome', 'Your activity', 'Your portfolio', 'First read'];
    var bar = '<ol class="su-steps" aria-label="Setup progress">' + steps.map(function (t, i) { return '<li class="' + (i < SU.step ? 'done' : i === SU.step ? 'on' : '') + '"' + (i === SU.step ? ' aria-current="step"' : '') + '><span>' + (i + 1) + '</span>' + esc(t) + '</li>'; }).join('') + '</ol>';
    var body = '', pos = positions();
    if (SU.step === 0) {
      body = '<div class="pf-ey">Welcome to EdgeDesk</div><h2 class="su-t">Research, not picks — organised around what you do.</h2>'
        + '<p class="su-p">EdgeDesk does not tell you what to bet. It shows what the model and the market see, keeps your activity, and tells you what your own history says. Five places, one loop:</p>'
        + '<ol class="su-dest">' + DEST.map(function (d) { return '<li><b>' + esc(d[0]) + '</b><span>' + esc(d[1]) + '</span></li>'; }).join('') + '</ol>'
        + '<div class="pf-acts"><button type="button" class="btn" data-su="next">Next: bring your activity</button></div>';
    } else if (SU.step === 1) {
      var n = pos.length;
      body = '<div class="pf-ey">Bring your activity</div><h2 class="su-t">Connect or import where you bet.</h2>'
        + '<p class="su-p">Your portfolio is built from what you actually did. Export your bet history as a CSV from your sportsbook and import it here, or skip and log bets as you go. EdgeDesk does not sync with sportsbooks or prediction markets yet, and will say so rather than pretend.</p>'
        + '<label class="btn full pf-file">Import a CSV from your sportsbook<input type="file" id="suImportFile" accept=".csv,text/csv" hidden></label>'
        + '<div id="suImportMsg" class="pf-note" role="status">' + (n ? n + ' position' + (n === 1 ? '' : 's') + ' already in your portfolio.' : '') + '</div>'
        + '<div class="pf-acts"><button type="button" class="btn" data-su="next">' + (n ? 'Next: your portfolio' : 'Skip — I’ll log bets as I go') + '</button></div>';
    } else if (SU.step === 2) {
      var ov = PF().overview(pos, Date.now()), t = ov.totals;
      body = '<div class="pf-ey">Your portfolio</div><h2 class="su-t">' + (ov.empty ? 'Empty for now — and that is fine.' : 'Here is where you stand.') + '</h2>'
        + (ov.empty ? '<p class="su-p">It fills as you track a price from an edge, mark a Card bet placed, log a bet, or import your history. Every tracked price is frozen at its number and graded against the close.</p>'
          : '<div class="pc-kpis">' + (t.pnl_n ? '<div class="pf-kpi"><div class="v ' + (t.pnl >= 0 ? 'up' : 'dn') + '">' + PF().money(t.pnl, true) + '</div><div class="l">Profit &amp; loss</div><div class="n">' + t.pnl_n + ' settled with a stake</div></div>' : '')
            + '<div class="pf-kpi"><div class="v">' + t.w + '-' + t.l + (t.p ? '-' + t.p : '') + '</div><div class="l">Record</div><div class="n">' + t.settled + ' settled · ' + t.open + ' open</div></div></div>')
        + '<div class="pf-acts"><button type="button" class="btn" data-su="next">Next: your first read</button></div>';
    } else {
      var P = PC().profile(pos, { now: Date.now() });
      var ins = P.working[0] || P.costing[0] || null;
      body = '<div class="pf-ey">Your first read</div>'
        + (P.state === 'ready'
          ? '<h2 class="su-t">Process score ' + P.score.value + '</h2><p class="su-p">' + P.score.n + ' of your positions are graded against the closing line. ' + esc(ins ? ins.text : P.focus.text) + '</p>'
          : '<h2 class="su-t">Not enough history for a personal insight yet.</h2><p class="su-p">Process compares your prices with the closing line, and it needs ' + PC().MIN_PROFILE + ' graded positions before it says anything about how you decide' + (P.counts.graded ? ' — you have ' + P.counts.graded + '.' : '.') + ' Imported bets give you P&amp;L, history and a calendar now; prices you track from EdgeDesk are what Process grades. Nothing is invented to fill the gap.</p>')
        + '<div class="pf-acts"><button type="button" class="btn" data-su="enter">Enter EdgeDesk</button></div>';
    }
    host.innerHTML = '<div class="su">' + bar + '<div class="su-card">' + body + '</div>'
      + '<div class="su-foot">' + (SU.step > 0 ? '<button type="button" class="pf-link" data-su="back">Back</button>' : '<span></span>') + '<button type="button" class="pf-link" data-su="skip">Skip setup</button></div>'
      + '<p class="su-legal">Research and decision-support tool. Signals can be wrong. 21+ · Bet responsibly · <a href="tel:18004262537">1-800-GAMBLER</a></p></div>';
  }
  W.setupOpen = function () { SU.step = 0; setupPaint(); track('setup:open'); };
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#setupHost [data-su]') : null; if (!b) return;
    var a = b.getAttribute('data-su');
    if (a === 'next') { SU.step = Math.min(3, SU.step + 1); track('setup:step' + SU.step); setupPaint(); W.scrollTo(0, 0); }
    else if (a === 'back') { SU.step = Math.max(0, SU.step - 1); setupPaint(); }
    else if (a === 'skip') setupDone('skip');
    else if (a === 'enter') setupDone('research');
  });

  /* ================================================================= CARD
     The Card is BEFORE and DURING a decision. What the reader is watching
     elsewhere (their watchlist, saved research) is linked from it; what they
     actually bet is Portfolio's, one tap away. */
  W.cardLinksPaint = function () {
    var v = $('v-card'); if (!v) return;
    var host = $('cardLinks');
    if (!host) { host = document.createElement('div'); host.id = 'cardLinks'; host.className = 'ws-links'; v.appendChild(host); }
    var watch = 0, saved = 0;
    try { watch = W.EDMine && W.EDMine.S && W.EDMine.S.watch ? Object.keys(W.EDMine.S.watch).length : 0; } catch (e) { watch = 0; }
    try { saved = (W.prefs && W.prefs().savedResearch || []).length; } catch (e) { saved = 0; }
    host.innerHTML = '<div class="ws-links-h">Also on your list</div>'
      + '<button type="button" data-cl="watch">Watchlist<span>' + watch + ' game' + (watch === 1 ? '' : 's') + '</span></button>'
      + '<button type="button" data-cl="saved">Saved research<span>' + saved + ' item' + (saved === 1 ? '' : 's') + '</span></button>'
      + '<button type="button" data-cl="ask">Ask EdgeDesk<span>about your card and exposure</span></button>'
      + '<button type="button" data-cl="portfolio">Bets you placed<span>live in Portfolio</span></button>';
  };
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#cardLinks [data-cl]') : null; if (!b) return;
    var a = b.getAttribute('data-cl'); track('card:' + a);
    if (a === 'watch') { try { W.EDMine.open('watchlist'); } catch (er) { /* signed out */ } }
    else if (a === 'saved') { if (W.researchGo) W.researchGo((W.prefs && W.prefs().lastResearchSub) || 'football'); setTimeout(function () { try { var w = $('rsSavedWrap'); if (w && w.classList.contains('hide') && W.rsToggleSaved) W.rsToggleSaved(); } catch (er) { /* no saved panel */ } }, 60); }
    else if (a === 'ask') W.edAsk('What is on my card, and what is my exposure?', 'card');
    else if (a === 'portfolio') { if (W.show) W.show('portfolio'); pfSetTab('open', true); }
  });

  /* ========================================================= CONTEXTUAL AI
     "Ask EdgeDesk" opens the drawer already asking the question the reader was
     looking at. The question is sent first, so the drawer's empty-state slate
     scan does not run over it. */
  W.edAsk = function (q, where) {
    var E = W.EDAI; if (!E) return;
    track('ai:' + (where || 'research'));
    try {
      if (q) { var t = $('edaiText'); if (t && E.sendText) { t.value = q; E.sendText(); } }
      E.open();
    } catch (e) { try { E.open(); } catch (er) { /* the drawer is not on this page */ } }
  };

  /* =============================================================== TRACKED */
  W.edTracked = function (bet) {
    var old = $('edTrackedToast'); if (old) old.remove();
    var d = document.createElement('div');
    d.id = 'edTrackedToast'; d.className = 'ws-toast'; d.setAttribute('role', 'status');
    d.innerHTML = '<span>Tracked in Portfolio' + (bet && bet.sel ? ' · <b>' + esc(bet.sel) + '</b>' : '') + '</span><button type="button">View</button>';
    d.querySelector('button').onclick = function () { d.remove(); if (W.show) W.show('portfolio'); pfSetTab('open', true); };
    document.body.appendChild(d);
    setTimeout(function () { try { d.remove(); } catch (e) { /* gone */ } }, 5000);
  };

  /* ================================================================== NEWS
     The news feed exists to inform research, so the items that name a game's
     teams sit on that game's research. One read of the feed per 15 minutes,
     shared by every card; nothing is shown until it has arrived. */
  var NEWS = { rows: null, at: 0, p: null };
  function newsLoad() {
    if (NEWS.p || (NEWS.rows && Date.now() - NEWS.at < 15 * 60e3) || typeof W.sbGet !== 'function') return;
    NEWS.p = W.sbGet('news?select=title,url,source,category,relevant,matched_teams,published_at&order=published_at.desc&limit=120')
      .then(function (r) { NEWS.rows = Array.isArray(r) ? r : []; NEWS.at = Date.now(); NEWS.p = null; }, function () { NEWS.rows = NEWS.rows || []; NEWS.at = Date.now(); NEWS.p = null; });
  }
  function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
  /* read the feed shortly after load, so a game card opened later already has it */
  W.addEventListener('load', function () { setTimeout(function () { try { if (lsGet('edgedesk_session')) newsLoad(); } catch (e) { /* offline */ } }, 4000); });
  W.edNewsFor = function (home, away) {
    newsLoad();
    if (!NEWS.rows || !NEWS.rows.length) return '';
    var keys = [norm(home), norm(away)].filter(Boolean);
    var hit = NEWS.rows.filter(function (n) {
      return (n.matched_teams || []).some(function (t) { var k = norm(t); return keys.some(function (x) { return x === k || x.indexOf(k + ' ') === 0 || k.indexOf(x + ' ') === 0; }); });
    }).slice(0, 4);
    if (!hit.length) return '';
    return '<div class="ws-news">' + hit.map(function (n) {
      var u = typeof W.edSafeUrl === 'function' ? W.edSafeUrl(n.url) : '#';
      var when = Date.parse(n.published_at); when = isFinite(when) ? new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      return '<a class="ws-news-i' + (n.relevant ? ' alert' : '') + '"' + (u && u !== '#' ? ' href="' + esc(u) + '" target="_blank" rel="noopener"' : '') + '><b>' + esc(n.title) + '</b><span>'
        + esc([n.relevant ? 'Moat alert' : n.category, n.source, when].filter(Boolean).join(' · ')) + '</span></a>';
    }).join('') + '<button type="button" class="pf-link" onclick="show(\'news\')">All news &amp; moat alerts ›</button></div>';
  };
})();
