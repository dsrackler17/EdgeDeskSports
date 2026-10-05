/* ===========================================================================
   EdgeDesk WORKSPACE — the controllers for the destinations the five-seat
   navigation added (docs/ia/NAVIGATION_AUDIT.md):

     Portfolio   pfOpen / pfRender / pfSetTab        the Phase A page (EDPortfolioUI) and,
                                                     under it, what EdgeDesk tracked
     Process     pcOpen / pcSetSub                   the Process Coach (the same Phase A page,
                                                     mounted coach-only) and, under it, what
                                                     EdgeDesk tracked graded against the close
                                                     (lib/edgedesk_process.js)
     Setup       edSetupDue / setupOpen              the one-time start for a new account
     Card        cardLinksPaint                      what else the reader is watching
     contextual  edAsk(q, where)                     "Ask EdgeDesk" where the question is
                 edTracked(bet)                      "tracked in Portfolio" without leaving
                 edNewsFor(home, away)               news that names a game's teams

   Everything here is presentation and wiring. Portfolio's money is the Phase A
   engine's (supabase/portfolio.sql); the closing-line grades Process reads come
   from lib/edgedesk_positions.js over the app's own bets() and the Card's
   EDDecisionUI.placed(), never re-stored in a second place.
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
  function PS() { return W.EDPositions; }
  function PC() { return W.EDProcess; }

  /* ---------------------------------------------------------- positions
     The reader's positions from both stores, normalised once. The Card's
     placed bets are graded against the committed football record when the
     Card has it loaded; ungraded they are still positions, just open. */
  function cardBets() { try { return W.EDDecisionUI && W.EDDecisionUI.placed ? W.EDDecisionUI.placed() : []; } catch (e) { return []; } }
  function gradeCard(p) { try { return W.EDDecisionUI && W.EDDecisionUI.gradePlaced ? W.EDDecisionUI.gradePlaced(p) : null; } catch (e) { return null; } }
  function positions() {
    var led = []; try { led = typeof W.bets === 'function' ? W.bets() : []; } catch (e) { led = []; }
    return PS() ? PS().collect(led, cardBets(), gradeCard) : [];
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

  /* ============================================================ PORTFOLIO
     The book is the Phase A page (lib/edgedesk_portfolio_ui.js): its own title,
     tabs (Overview · Calendar · Journal · Open · History · Analytics · Accounts
     · Import) and data. Its Coach is the Process seat's, not a tab here.
     This controller mounts it, keeps #portfolio/<tab> linkable, records which
     tab readers open, and paints the "Tracked from EdgeDesk" section under it —
     the old Ledger's prices and the Card's placed bets. */
  var PFO_TABS = ['overview', 'calendar', 'journal', 'open', 'history', 'analytics', 'accounts', 'import'];
  var PFS = { tab: null, ctl: null, busy: false };
  function pfVisible() { var v = $('v-portfolio'); return !!(v && !v.classList.contains('hide')); }
  function pfHash(tab) {
    if (!pfVisible()) return;
    try { history.replaceState(null, '', location.pathname + location.search + '#portfolio' + (tab && tab !== 'overview' ? '/' + tab : '')); } catch (e) { /* no history */ }
  }
  /* a tab of the Phase A page, or 'tracked' for the section under it; an old
     tab name lands on its nearest one */
  function pfSetTab(tab, fromLink) {
    tab = { settled: 'history', ledger: 'tracked', bets: 'tracked' }[tab] || tab;
    /* the coach was a Portfolio tab before it became the Process seat */
    if (tab === 'coach') { if (W.show) W.show('process'); return; }
    if (tab === 'tracked') {
      var d = $('pfTracked'); if (d) { d.open = true; try { d.scrollIntoView({ block: 'start' }); } catch (e) { /* old browser */ } }
      if (!fromLink) track('portfolio:tracked');
      return;
    }
    if (PFO_TABS.indexOf(tab) < 0) return;
    PFS.tab = tab;
    var c = PFS.ctl || ($('pfoHost') && $('pfoHost').__pfo);
    if (c && c.setTab) { try { c.setTab(tab); } catch (e) { /* the page keeps its tab */ } }
    pfHash(tab);
    if (!fromLink) track('portfolio:' + tab);
  }
  W.pfSetTab = pfSetTab;
  /* the tracked section: the Card's placed bets beside the ledger's, and a count */
  function pfRender() {
    if (!PS() || PFS.busy) return;
    PFS.busy = true;
    try {
      var pos = positions(), f = fmt();
      var cards = pos.filter(function (x) { return x.src === 'card'; });
      var co = $('pfCardOpen'); if (co) co.innerHTML = PS().cardListHTML(cards.filter(function (x) { return !x.result; }), f, 'From the Card');
      var cd = $('pfCardDone'); if (cd) cd.innerHTML = PS().cardListHTML(cards.filter(function (x) { return !!x.result; }), f, 'From the Card');
      var s = PS().summary(pos);
      var n = $('pfTrackedN'); if (n) n.textContent = pos.length ? pos.length + ' · ' + s.open + ' open' + (s.graded ? ' · ' + s.beat + '/' + s.graded + ' beat the close' : '') : 'none yet';
      var fr = $('pfFresh'); if (fr && !pos.length) fr.textContent = 'nothing tracked yet';
    } catch (e) { try { console.error('portfolio tracked render failed:', e); } catch (_) { /* no console */ } }
    finally { PFS.busy = false; }
  }
  W.pfRender = pfRender;
  W.pfOpen = function () {
    var host = $('pfoHost');
    try { if (host && W.EDPortfolioUI) PFS.ctl = W.EDPortfolioUI.show(host); } catch (e) { /* the tracked section still stands */ }
    if (PFS.tab) pfSetTab(PFS.tab, true);
    else pfHash((PFS.ctl && PFS.ctl.state && PFS.ctl.state.tab) || 'overview');
    try { if (typeof W.renderLedger === 'function') W.renderLedger(); } catch (e) { /* painted below */ }
    /* settle what finished and refresh live CLV, then paint again (loadMarket
       repaints the ledger, which repaints this) */
    try { var p = typeof W.loadMarket === 'function' ? W.loadMarket() : null; if (p && p.then) p.then(pfRender, pfRender); } catch (e) { /* offline */ }
    ensureCardGrades(pfRender);
  };
  /* the Phase A tabs are buttons inside its page: follow them for the link and
     the evidence, never for their behaviour (the page handles its own tabs) */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var b = t.closest('#pfoHost .pfo-tab[data-v]');
    if (b) { var v = b.getAttribute('data-v'); PFS.tab = v; pfHash(v); track('portfolio:' + v); return; }
    var g = t.closest('[data-pf-go]'); if (g) { if (!pfVisible() && W.show) W.show('portfolio'); pfSetTab(g.getAttribute('data-pf-go')); return; }
    var nv = t.closest('[data-nav]');
    if (nv) {
      var to = nv.getAttribute('data-nav');
      if (to === 'methodology') { track('process:methodology'); if (typeof W.hiwOpen === 'function') W.hiwOpen(); return; }
      if (W.show) W.show(to);
      return;
    }
  });
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (d && d.id === 'pfTracked' && d.open) track('portfolio:tracked');
  }, true);
  /* a link inside one mount to the other's tab: Portfolio's "open Process",
     Process's "Connect accounts" / "Import a CSV" */
  document.addEventListener('pfo-route', function (e) {
    var v = e && e.detail && e.detail.tab; if (!v) return;
    if (v === 'coach') { track('process:from-portfolio'); if (W.show) W.show('process'); return; }
    if (PFO_TABS.indexOf(v) < 0) return;
    if (!pfVisible() && W.show) W.show('portfolio');
    pfSetTab(v);
  });

  /* ============================================================== PROCESS */
  var PCS = { journalAsked: false, ctl: null, sub: null };
  function pcVisible() { var v = $('v-process'); return !!(v && !v.classList.contains('hide')); }
  function pcHash(sub) {
    if (!pcVisible()) return;
    try { history.replaceState(null, '', location.pathname + location.search + '#process' + (sub && sub !== 'report' && sub !== 'overview' ? '/' + sub : '')); } catch (e) { /* no history */ }
  }
  /* a page of Process: #process (Overview), #process/film, #process/explore,
     and each report under Explore — #process/leaks, … ('' = the page open now;
     'report', the first Coach's name for its Overview, still lands there) */
  var PC_SUBS = ['overview', 'film', 'explore', 'leaks', 'strengths', 'timing', 'edge', 'rules', 'experiments', 'outcome'];
  function pcSetSub(sub, fromLink) {
    sub = sub || PCS.sub || 'overview';
    if (sub === 'report') sub = 'overview';
    if (sub === 'tracked') {
      var d = $('pcTracked'); if (d) { d.open = true; try { d.scrollIntoView({ block: 'start' }); } catch (e) { /* old browser */ } }
      return;
    }
    if (PC_SUBS.indexOf(sub) < 0) return;
    PCS.sub = sub;
    var c = PCS.ctl || ($('pcoHost') && $('pcoHost').__pfo);
    if (c && c.coach) { try { c.coach(sub); } catch (e) { /* the coach keeps its page */ } }
    pcHash(sub);
    if (!fromLink) track('process:' + sub);
  }
  W.pcSetSub = pcSetSub;
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
    /* the Process Coach: the Phase A page's coach, on the reader's own positions */
    var host = $('pcoHost');
    try { if (host && W.EDPortfolioUI) PCS.ctl = W.EDPortfolioUI.show(host, { tabs: ['coach'], bare: true, name: 'Process' }); } catch (e) { /* the tracked section still stands */ }
    if (PCS.sub) pcSetSub(PCS.sub, true); else pcHash('overview');
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
  /* a page of the coach: followed for the link and the evidence on the way
     down (capture), because the coach repaints and detaches the button */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var cs = t.closest('#pcoHost [data-act="coach"][data-v]');
    if (cs) { var sv = cs.getAttribute('data-v'); PCS.sub = sv; pcHash(sv); track('process:' + sv); return; }
    /* "Set up an experiment" from a focus opens Experiments */
    if (t.closest('#pcoHost [data-act="exp-setup"]')) { PCS.sub = 'experiments'; pcHash('experiments'); track('process:focus-experiment'); return; }
    var ws = t.closest('#pcoHost [data-act="why"][data-id]');
    if (ws) track('process:why');
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var j = t.closest('[data-pc-journal]'); if (j) { track('process:journal'); try { W.EDMine.open('quality'); } catch (er) { /* not signed in */ } return; }
    var o = t.closest('[data-pc-open]');
    if (o) { var fam = o.getAttribute('data-pc-open'), d = document.querySelector('#processHost details[data-pc-fam="' + fam + '"]'); if (d) { d.open = true; try { d.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (er) { d.scrollIntoView(); } } }
  });
  /* opening a drill-down is evidence of what readers want from Process */
  document.addEventListener('toggle', function (e) {
    var d = e.target; if (!d || !d.matches || !d.open) return;
    if (d.id === 'pcTracked') track('process:tracked');
    else if (d.matches('#processHost details[data-pc-fam]')) track('process:' + d.getAttribute('data-pc-fam'));
    else if (d.matches('#processHost details.pc-ins')) track('process:why');
  }, true);

  /* ================================================================ SETUP
     A new account's first visit: WELCOME → YOUR PORTFOLIO (connect or import
     where you bet, which builds it) → YOUR FIRST READ → ENTER. Once: it is
     marked done the moment it is shown, so leaving through any seat counts.
     Never over a deep link. Reachable again from More → Account. */
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
  function setupLeave(to, tab) {
    track('setup:' + to);
    if (to === 'portfolio') { if (W.show) W.show('portfolio'); pfSetTab(tab || 'import', true); return; }
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
    var steps = ['Welcome', 'Your portfolio', 'First read'];
    var bar = '<ol class="su-steps" aria-label="Setup progress">' + steps.map(function (t, i) { return '<li class="' + (i < SU.step ? 'done' : i === SU.step ? 'on' : '') + '"' + (i === SU.step ? ' aria-current="step"' : '') + '><span>' + (i + 1) + '</span>' + esc(t) + '</li>'; }).join('') + '</ol>';
    var body = '';
    if (SU.step === 0) {
      body = '<div class="pf-ey">Welcome to EdgeDesk</div><h2 class="su-t">Research, not picks — organised around what you do.</h2>'
        + '<p class="su-p">EdgeDesk does not tell you what to bet. It shows what the model and the market see, keeps your activity, and tells you what your own history says. Five places, one loop:</p>'
        + '<ol class="su-dest">' + DEST.map(function (d) { return '<li><b>' + esc(d[0]) + '</b><span>' + esc(d[1]) + '</span></li>'; }).join('') + '</ol>'
        + '<div class="pf-acts"><button type="button" class="btn" data-su="next">Next: your portfolio</button></div>';
    } else if (SU.step === 1) {
      body = '<div class="pf-ey">Build your portfolio</div><h2 class="su-t">Connect or import where you bet.</h2>'
        + '<p class="su-p">Your portfolio is built from what you actually did, on every sportsbook and prediction market you use: P&amp;L, history and performance. Import a CSV export from your book, or record bets by hand. No platform syncs automatically yet, and EdgeDesk will say so rather than pretend.</p>'
        + '<div class="pf-acts"><button type="button" class="btn" data-su="import">Import a CSV</button><button type="button" class="btn ghost" data-su="accounts">Connect accounts</button></div>'
        + '<div class="pf-acts"><button type="button" class="pf-link" data-su="next">Skip for now — show me my first read</button></div>';
    } else {
      var P = PC().profile(positions(), { now: Date.now() });
      var ins = P.working[0] || P.costing[0] || null;
      body = '<div class="pf-ey">Your first read</div>'
        + (P.state === 'ready'
          ? '<h2 class="su-t">Process score ' + P.score.value + '</h2><p class="su-p">' + P.score.n + ' of your positions are graded against the closing line. ' + esc(ins ? ins.text : P.focus.text) + '</p>'
          : '<h2 class="su-t">Not enough history for a personal insight yet.</h2><p class="su-p">Process compares your prices with the closing line, and it needs ' + PC().MIN_PROFILE + ' graded positions before it says anything about how you decide' + (P.counts.graded ? ' — you have ' + P.counts.graded + '.' : '.') + ' Prices you track from EdgeDesk and bets you place from the Card are graded as their games close. Nothing is invented to fill the gap.</p>')
        + '<div class="pf-acts"><button type="button" class="btn" data-su="enter">Enter EdgeDesk</button></div>';
    }
    host.innerHTML = '<div class="su">' + bar + '<div class="su-card">' + body + '</div>'
      + '<div class="su-foot">' + (SU.step > 0 ? '<button type="button" class="pf-link" data-su="back">Back</button>' : '<span></span>') + '<button type="button" class="pf-link" data-su="skip">Skip setup</button></div>'
      + '<p class="su-legal">Research and decision-support tool. Signals can be wrong. 21+ · Bet responsibly · <a href="tel:18004262537">1-800-GAMBLER</a></p></div>';
  }
  W.setupOpen = function () { SU.step = 0; lsSet(SETUP_KEY, String(Date.now())); setupPaint(); track('setup:open'); };
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#setupHost [data-su]') : null; if (!b) return;
    var a = b.getAttribute('data-su');
    if (a === 'next') { SU.step = Math.min(2, SU.step + 1); track('setup:step' + SU.step); setupPaint(); W.scrollTo(0, 0); }
    else if (a === 'back') { SU.step = Math.max(0, SU.step - 1); setupPaint(); }
    else if (a === 'import') setupLeave('portfolio', 'import');
    else if (a === 'accounts') setupLeave('portfolio', 'accounts');
    else if (a === 'skip') setupLeave('skip');
    else if (a === 'enter') setupLeave('research');
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
      + '<button type="button" data-cl="portfolio">Bets you placed<span>tracked in Portfolio</span></button>';
  };
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#cardLinks [data-cl]') : null; if (!b) return;
    var a = b.getAttribute('data-cl'); track('card:' + a);
    if (a === 'watch') { try { W.EDMine.open('watchlist'); } catch (er) { /* signed out */ } }
    else if (a === 'saved') { if (W.researchGo) W.researchGo((W.prefs && W.prefs().lastResearchSub) || 'football'); setTimeout(function () { try { var w = $('rsSavedWrap'); if (w && w.classList.contains('hide') && W.rsToggleSaved) W.rsToggleSaved(); } catch (er) { /* no saved panel */ } }, 60); }
    else if (a === 'ask') W.edAsk('What is on my card, and what is my exposure?', 'card');
    else if (a === 'portfolio') { if (W.show) W.show('portfolio'); pfSetTab('tracked', true); }
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

  /* ===================================================== RECORD POSITION
     One door from anywhere EdgeDesk shows an opportunity (the Card today) to
     Portfolio's record sheet: prefilled from what was saved, Before You Enter
     first, the decision snapshot stored with it. EdgeDesk records a position
     the reader placed themselves; it never places one. */
  function pfCtl() {
    if (W.show) W.show('portfolio');
    return PFS.ctl || ($('pfoHost') && $('pfoHost').__pfo) || null;
  }
  W.edRecordPosition = function (o) {
    var c = pfCtl();
    track('record:' + ((o && o.surface) || 'card'));
    if (c && c.record) { try { c.record(o || {}); } catch (e) { /* the Portfolio page stays open */ } }
  };
  /* a position's Decision Record, from search or a notification */
  W.edOpenRecord = function (id) {
    var c = pfCtl();
    if (c && c.openRecord) { try { c.openRecord(id); } catch (e) { /* the Portfolio page stays open */ } }
  };
  /* SEARCH beyond research: the reader's Card entries (on this device) and
     their recorded positions (portfolio_search, their own rows only) */
  W.edSearchMine = function (q, host) {
    if (!host) return;
    q = String(q || '').trim();
    var lq = q.toLowerCase(), html = '';
    var ents = [];
    try { ents = W.EDDecisionUI && W.EDDecisionUI.entries ? W.EDDecisionUI.entries() : []; } catch (e) { ents = []; }
    var hits = ents.filter(function (e) {
      return [e.selection, e.home, e.away, e.player_name, e.market_label, e.book].some(function (x) { return x && String(x).toLowerCase().indexOf(lq) >= 0; });
    }).slice(0, 6);
    if (hits.length) {
      html += '<div class="rs-mine-h">On your Card</div>' + hits.map(function (e) {
        return '<div class="rs-hit" data-ws-card="1"><span class="mod">card</span><span class="nm">' + esc((e.selection || '') + (e.player_name ? ' · ' + e.player_name : ''))
          + '<span style="display:block;font-size:10.5px;color:var(--faint)">' + esc((e.away || '') + ' @ ' + (e.home || '') + (e.decision ? ' · ' + e.decision : '')) + '</span></span></div>';
      }).join('');
    }
    host.innerHTML = html + '<div data-ws-pos></div>';
    var signed = false; try { signed = !!(W.edUser && W.edUser()); } catch (e) { signed = false; }
    if (!signed || q.length < 2 || !W.EDPortfolioUI || !W.EDPortfolioUI.searchPositions) return;
    var seq = (W.edSearchMine.seq = (W.edSearchMine.seq || 0) + 1);
    W.EDPortfolioUI.searchPositions(q).then(function (rows) {
      if (seq !== W.edSearchMine.seq) return;
      var slot = host.querySelector('[data-ws-pos]'); if (!slot || !rows || !rows.length) return;
      slot.innerHTML = '<div class="rs-mine-h">Your positions</div>' + rows.map(function (r) {
        return '<div class="rs-hit" data-ws-rec="' + esc(r.id) + '"><span class="mod">record</span><span class="nm">' + esc(r.event_name + ' · ' + r.selection)
          + '<span style="display:block;font-size:10.5px;color:var(--faint)">' + esc([r.platform_label, String(r.placed_at || '').slice(0, 10), r.result || r.status].filter(Boolean).join(' · ')) + '</span></span></div>';
      }).join('');
    }).catch(function () { /* research search stands alone */ });
  };
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null; if (!t) return;
    var r = t.closest('[data-ws-rec]'); if (r) { W.edOpenRecord(r.getAttribute('data-ws-rec')); return; }
    var c = t.closest('[data-ws-card]'); if (c) { if (W.show) W.show('card'); }
  });

  /* =============================================================== TRACKED */
  W.edTracked = function (bet) {
    var old = $('edTrackedToast'); if (old) old.remove();
    var d = document.createElement('div');
    d.id = 'edTrackedToast'; d.className = 'ws-toast'; d.setAttribute('role', 'status');
    d.innerHTML = '<span>Tracked in Portfolio' + (bet && bet.sel ? ' · <b>' + esc(bet.sel) + '</b>' : '') + '</span><button type="button">View</button>';
    d.querySelector('button').onclick = function () { d.remove(); if (W.show) W.show('portfolio'); pfSetTab('tracked', true); };
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
  /* More may be painted at boot (#more) before the desk script defines
     Methodology's hiwOpen; paint it again once everything has loaded */
  W.addEventListener('load', function () { try { var m = $('v-more'); if (m && !m.classList.contains('hide') && typeof W.loadMore === 'function') W.loadMore(); } catch (e) { /* More stays as painted */ } });
  /* read the feed shortly after load, so a game card opened later already has it */
  W.addEventListener('load', function () { setTimeout(function () { try { if (lsGet('edgedesk_session')) newsLoad(); } catch (e) { /* offline */ } }, 4000); });
  W.edNewsFor = function (home, away) {
    newsLoad();
    if (!NEWS.rows || !NEWS.rows.length) return '';
    var keys = [norm(home), norm(away)].filter(Boolean);
    /* the exact school, never a prefix of it: Missouri is not Missouri State,
       Texas is not Texas Tech, North Dakota is not North Dakota State */
    var hit = NEWS.rows.filter(function (n) {
      return (n.matched_teams || []).some(function (t) { return keys.indexOf(norm(t)) >= 0; });
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
