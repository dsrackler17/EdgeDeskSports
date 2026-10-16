/* ===========================================================================
   EdgeDesk GUIDE — the introduction, the walkthroughs, the Help panel and
   the term explainers. The words live in lib/edgedesk_guide_content.js;
   this file shows them.

   FIRST VISIT. One short introduction ("Show me around" / "Explore on my
   own") in the welcome overlay (#welHost), which it replaces: the old
   conceptual welcome (app.html welOpen) now opens this, and only runs itself
   if this file failed to load. It waits until nothing else is in the way —
   the paywall, Setup, another dialog, a field being typed in — and it is
   asked once: the answer is kept on the device (edgedesk_guide_v1, the same
   edgedesk_* convention every per-user key uses, cleared on sign-out) and on
   the account (auth user_metadata.edgedesk_guide, as the display name is),
   so signing out or a new device does not start it over. A reader who
   already dismissed the old welcome is not interrupted again; the Help
   button carries a small dot until they open it once.

   WALKTHROUGHS. One task each, a few steps, on the real screen: a ring
   around the real control (pointer-events: none — nothing on the page is
   ever blocked), a card beside it (docked above the navigation on a phone)
   with Step n of m, Back, Next and Skip. Targets are re-resolved on every
   frame, because the boards replace their innerHTML; a step whose control
   never appears says why and offers the next useful action, and a reader
   who navigates away is told so instead of being pointed at nothing.

   HELP. The ? button in the header (desktop and phone), the account menu
   and More: walk through this page, learn another task, look up a term,
   replay the introduction.

   TERMS. Anything marked data-ed-term="<id>", and every decision-layer
   tooltip (lib/edgedesk_decision_ui.js tip(), data-ed-tip="<key>") opens a
   short explainer on click, tap or Enter: what it is, how to use it, what it
   cannot tell you.

   Browser: window.EDGuide. Node: require (tests; the DOM parts no-op).
   =========================================================================== */
(function (root, factory) {
  var C = (root && root.EDGuideContent) || (typeof require === 'function' ? require('./edgedesk_guide_content.js') : null);
  var api = factory(root, C);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root && root.document) root.EDGuide = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root, C) {
  'use strict';

  var VERSION = 'edgedesk_guide_v1';
  var KEY = 'edgedesk_guide_v1', WEL_KEY = 'edgedesk_welcome_seen', FOCUS_KEY = 'edgedesk_focus', DEC_KEY = 'edgedesk_decision_onboarded_v1';
  var NEW_DAYS = 14, META = 'edgedesk_guide';

  /* ===================================================== STATE (pure) */
  function blank() { return { v: 1, intro: null, introAt: null, tours: {}, helpSeen: false }; }
  function norm(o) {
    var b = blank();
    if (!o || typeof o !== 'object') return b;
    if (o.intro === 'done' || o.intro === 'dismissed') { b.intro = o.intro; b.introAt = o.introAt || null; }
    if (o.tours && typeof o.tours === 'object') Object.keys(o.tours).forEach(function (k) {
      var t = o.tours[k];
      if (t && (t.status === 'done' || t.status === 'skipped')) b.tours[k] = { status: t.status, at: t.at || null };
    });
    b.helpSeen = !!o.helpSeen;
    return b;
  }
  function readState(store) { try { return norm(JSON.parse((store && store.getItem(KEY)) || 'null')); } catch (e) { return blank(); } }
  function writeState(store, s) { try { if (!store) return false; store.setItem(KEY, JSON.stringify(norm(s))); return true; } catch (e) { return false; } }
  function isNewAccount(createdAt, now) { var c = Date.parse(createdAt); return isFinite(c) && (now - c) < NEW_DAYS * 864e5; }
  /* Is the first-visit introduction due?
       state        this device's answer
       meta         the account's answer (user_metadata.edgedesk_guide)
       welcomeSeen  the old welcome's key. A reader who dismissed it already
                    met EdgeDesk; but a brand-new account has it pre-set by
                    the first-run panel (lib/edgedesk_first_run.js), so for
                    an account under 14 days old it says nothing. */
  function introDue(o) {
    o = o || {};
    if (o.state && o.state.intro) return false;
    if (o.meta && (o.meta.intro === 'done' || o.meta.intro === 'dismissed')) return false;
    if (o.welcomeSeen && !isNewAccount(o.createdAt, o.now || Date.now())) return false;
    return true;
  }
  function mergeMeta(state, meta) {
    var s = norm(state);
    if (!meta || typeof meta !== 'object') return s;
    if (!s.intro && (meta.intro === 'done' || meta.intro === 'dismissed')) { s.intro = meta.intro; s.introAt = meta.at || null; }
    (Array.isArray(meta.done) ? meta.done : []).forEach(function (id) { if (typeof id === 'string' && !s.tours[id]) s.tours[id] = { status: 'done', at: null }; });
    return s;
  }
  function metaOf(s) { return { intro: s.intro, at: s.introAt, done: Object.keys(s.tours).filter(function (k) { return s.tours[k].status === 'done'; }).sort() }; }
  /* can this walkthrough run in this build? env answers has(selector),
     fn(name), module(id), obj(name) */
  function available(tour, env) {
    if (!tour) return false;
    return (tour.needs || []).every(function (n) {
      if (/^fn:/.test(n)) return env.fn(n.slice(3));
      if (/^module:/.test(n)) return env.module(n.slice(7));
      if (/^obj:/.test(n)) return env.obj(n.slice(4));
      return env.has(n);
    });
  }
  /* the known empty or error state a step's target is showing, if any:
     `when` is a RegExp over its text or a function of the element */
  function adaptFor(step, el) {
    var a = step && step.adapt;
    if (!a || !el) return null;
    var text = typeof el === 'string' ? el : (el.textContent || '');
    for (var i = 0; i < a.length; i++) {
      var w = a[i].when;
      try {
        if (w instanceof RegExp ? w.test(text) : (typeof w === 'function' && typeof el !== 'string' && w(el))) return a[i];
      } catch (e) { /* a rule that cannot run does not apply */ }
    }
    return null;
  }

  var PURE = { VERSION: VERSION, KEY: KEY, blank: blank, norm: norm, readState: readState, writeState: writeState, isNewAccount: isNewAccount,
    introDue: introDue, mergeMeta: mergeMeta, metaOf: metaOf, available: available, adaptFor: adaptFor, content: C };
  var doc = root && root.document;
  if (!doc || !C) return PURE;

  /* ====================================================== DOM HELPERS */
  function $(id) { return doc.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function store() { try { return root.localStorage; } catch (e) { return null; } }
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* storage off: this visit only */ } }
  function mq(q) { try { return !!(root.matchMedia && root.matchMedia(q).matches); } catch (e) { return false; } }
  function reduced() { return mq('(prefers-reduced-motion: reduce)'); }
  function phone() { return mq('(max-width: 640px)'); }
  function visible(e) {
    if (!e || !e.isConnected) return false;
    var r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = root.getComputedStyle ? root.getComputedStyle(e) : null;
    return !(cs && (cs.visibility === 'hidden' || cs.display === 'none'));
  }
  function track(name, props) { try { if (typeof root.edEvent === 'function') root.edEvent(name, props || {}); } catch (e) { /* analytics optional */ } }
  function cssq(v) { return root.CSS && root.CSS.escape ? root.CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'); }
  function sessionUser() { try { var s = JSON.parse(lsGet('edgedesk_session') || 'null'); return s && s.user ? s.user : null; } catch (e) { return null; } }
  function focusIn(el) { if (!el) return; try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_) { /* not focusable */ } } }
  function restoreFocus(el) { if (el && el.isConnected && visible(el)) focusIn(el); }
  /* Tab stays inside a modal of ours */
  function trapTab(host, ev) {
    if (ev.key !== 'Tab') return;
    var f = Array.prototype.filter.call(host.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'), function (x) { return !x.disabled && visible(x); });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && doc.activeElement === first) { ev.preventDefault(); focusIn(last); }
    else if (!ev.shiftKey && doc.activeElement === last) { ev.preventDefault(); focusIn(first); }
  }

  var S = { state: readState(store()), tour: null, step: 0, ctx: {}, seq: 0, target: null, missingSince: 0, mode: null,
    introOpen: false, introView: 'intro', introReturn: null, autoTimer: null,
    helpOpen: false, helpView: 'home', helpReturn: null, helpQuery: '',
    termOpen: null, termTrigger: null, metaPushed: null, loop: null, raf: 0, upRaf: 0 };

  function save() { writeState(store(), S.state); paintHelpBtn(); }

  /* ============================================== THE ACCOUNT'S COPY */
  function metaGet() {
    try { var u = typeof root.edUser === 'function' ? root.edUser() : sessionUser(); var m = u && u.user_metadata && u.user_metadata[META]; return m && typeof m === 'object' ? m : null; } catch (e) { return null; }
  }
  /* written once per change, best effort: the device copy already holds it */
  function metaPush() {
    if (typeof root.edAuthPut !== 'function') return;
    var m = metaOf(S.state), k = JSON.stringify(m);
    var cur = metaGet();
    if (S.metaPushed === k || (cur && JSON.stringify({ intro: cur.intro, at: cur.at, done: (cur.done || []).slice().sort() }) === k)) return;
    S.metaPushed = k;
    var data = {}; data[META] = m;
    try {
      Promise.resolve(root.edAuthPut({ data: data })).then(function () {
        try { var s = JSON.parse(lsGet('edgedesk_session') || 'null'); if (s && s.user) { s.user.user_metadata = s.user.user_metadata || {}; s.user.user_metadata[META] = m; lsSet('edgedesk_session', JSON.stringify(s)); } } catch (e) { /* cached copy only */ }
      }).catch(function () { S.metaPushed = null; });
    } catch (e) { S.metaPushed = null; }
  }

  /* =================================================== WHERE AM I */
  function currentPage() {
    var vr = $('v-research');
    if (vr && !vr.classList.contains('hide')) return 'research:' + (root.RESEARCH_SUB || 'football');
    var v = doc.querySelector('main > .view:not(.hide)');
    return v ? v.id.replace(/^v-/, '') : 'research:football';
  }
  function onPage(want) {
    if (!want || want === '*') return true;
    var p = currentPage();
    return want === p || (want === 'research' && /^research:/.test(p));
  }
  function locked() { var g = $('payGate'); return !!(g && g.classList.contains('on')); }
  var ENV = {
    has: function (sel) { return !!doc.querySelector(sel); },
    fn: function (n) { return typeof root[n] === 'function'; },
    module: function (id) { return !!(root.RESEARCH_MODULES && root.RESEARCH_MODULES[id]); },
    obj: function (n) { return !!root[n]; }
  };
  function tourOk(id) { return available(C.TOURS[id], ENV); }

  /* =================================================== BUSY, AND WHO ASKS
     Other first-run layers (the six-step setup modal, the Card's own
     onboarding) ask EDGuide.busy() before they open, so nothing stacks on a
     walkthrough. Our own first-visit introduction waits for the reverse. */
  function busy() { return !!(S.introOpen || S.tour || S.helpOpen); }
  function busyElsewhere() {
    if (locked()) return 'paywall';
    var setup = $('v-setup'); if (setup && !setup.classList.contains('hide')) return 'setup';
    if (root.ED_ENTITLED !== 'ok' && root.ED_ENTITLED !== 'unknown') return 'access';
    var on = ['hiwHost', 'eddModal'].some(function (id) { var e = $(id); return e && e.classList.contains('on'); });
    var brief = $('briefHost'); if (brief && brief.classList.contains('open')) on = true;
    if (on || doc.querySelector('.edm-ov.on')) return 'dialog';
    var ai = $('edaiPanel'); if (ai && ai.classList.contains('open')) return 'ai';
    if (doc.querySelector('dialog[open]')) return 'dialog';
    var mods = ['cfbModal', 'ufcModal', 'mlbhModal', 'rsDrawer', 'rsDossier'].some(function (id) { var e = $(id); return e && visible(e) && (e.style.display === 'block' || e.style.display === 'flex' || e.classList.contains('on')); });
    if (mods) return 'dialog';
    var a = doc.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return 'typing';
    if (doc.hidden) return 'hidden';
    return null;
  }

  /* ====================================================== INTRODUCTION */
  function introHost() {
    var h = $('welHost');
    if (!h) { h = doc.createElement('div'); h.id = 'welHost'; h.className = 'wel'; h.setAttribute('role', 'dialog'); h.setAttribute('aria-modal', 'true'); doc.body.appendChild(h); }
    if (!h.getAttribute('data-edg-wired')) {
      h.setAttribute('data-edg-wired', '1');
      /* a click on the dimmed backdrop is "explore on my own" */
      h.addEventListener('click', function (ev) { if (!S.introOpen) return; if (ev.target === h) closeIntro('dismissed'); else onClick(ev); });
    }
    return h;
  }
  function chooserHTML() {
    var ids = C.TASKS.filter(tourOk);
    return '<div class="wel-ey">' + esc(C.INTRO.eyebrow) + '</div><h2 class="wel-t" id="edgIntroT" tabindex="-1">' + esc(C.INTRO.chooserTitle) + '</h2>'
      + '<p class="wel-p" id="edgIntroB">' + esc(C.INTRO.chooserLede) + '</p>'
      + '<div class="edg-paths" role="list">' + ids.map(function (id) { var t = C.TOURS[id];
        return '<div role="listitem"><button type="button" class="edg-path" data-edg-act="tour" data-edg-v="' + id + '"><b>' + esc(t.title) + '</b><span>' + esc(t.line) + '</span><i>' + t.steps.length + ' short steps</i></button></div>'; }).join('') + '</div>'
      + '<div class="edg-acts"><button type="button" class="btn ghost sm" data-edg-act="intro-back">Back</button><span class="edg-sp"></span><button type="button" class="edg-link" data-edg-act="intro-skip">' + esc(C.INTRO.secondary) + '</button></div>'
      + '<div class="wel-legal">' + esc(C.INTRO.reopen) + '</div>';
  }
  function introHTML() {
    var I = C.INTRO;
    return '<div class="wel-ey">' + esc(I.eyebrow) + '</div><h2 class="wel-t" id="edgIntroT" tabindex="-1">' + esc(I.title) + '</h2>'
      + '<p class="wel-p" id="edgIntroB">' + esc(I.lede) + '</p>'
      + '<ul class="edg-points">' + I.points.map(function (p) { return '<li><b>' + esc(p[0]) + '</b><span>' + esc(p[1]) + '</span></li>'; }).join('') + '</ul>'
      + '<p class="edg-caution">' + esc(I.caution) + '</p>'
      + '<div class="edg-acts"><button type="button" class="btn sm edg-primary" data-edg-act="intro-tour">' + esc(I.primary) + '</button><button type="button" class="btn ghost sm" data-edg-act="intro-skip">' + esc(I.secondary) + '</button></div>'
      + '<div class="wel-legal">' + esc(I.reopen) + ' ' + esc(I.legal) + '</div>';
  }
  function paintIntro() {
    var h = introHost();
    h.innerHTML = '<div class="wel-card edg-intro">' + '<button type="button" class="edg-x" data-edg-act="intro-skip" aria-label="Close the introduction">×</button>' + (S.introView === 'choose' ? chooserHTML() : introHTML()) + '</div>';
    h.setAttribute('aria-labelledby', 'edgIntroT'); h.setAttribute('aria-describedby', 'edgIntroB'); h.removeAttribute('aria-label');
    var f = S.introView === 'choose' ? h.querySelector('#edgIntroT') : h.querySelector('.edg-primary');
    setTimeout(function () { focusIn(f); }, 20);
  }
  function openIntro(opts) {
    opts = opts || {};
    if (locked()) return false;
    closeHelp(true); closeTerm(true);
    if (S.tour) endTour('skipped', true);
    S.introOpen = true; S.introView = opts.view === 'choose' ? 'choose' : 'intro';
    S.introReturn = opts.returnTo || doc.activeElement;
    var h = introHost(); paintIntro(); h.classList.add('on'); h.scrollTop = 0;
    track('guide_intro_open', { auto: !!opts.auto });
    return true;
  }
  function closeIntro(kind, keepFocus, noToast) {
    var h = $('welHost');
    if (h) { h.classList.remove('on'); h.innerHTML = ''; h.setAttribute('aria-label', 'Welcome to EdgeDesk'); h.removeAttribute('aria-labelledby'); h.removeAttribute('aria-describedby'); }
    var was = S.introOpen; S.introOpen = false;
    if (!was) return;
    if (kind) {
      if (!S.state.intro || kind === 'done') { S.state.intro = kind; S.state.introAt = new Date().toISOString(); }
      /* the old welcome's side effects, kept: its key (so nothing else
         re-opens it) and a first visit's calm desk (Focus mode) */
      if (!lsGet(WEL_KEY)) lsSet(WEL_KEY, String(Date.now()));
      try { if (lsGet(FOCUS_KEY) == null && typeof root.deskFocus === 'function') root.deskFocus(true); } catch (e) { /* desk not loaded */ }
      save(); metaPush();
      track('guide_intro_' + kind, {});
    }
    if (!keepFocus) restoreFocus(S.introReturn);
    if (kind === 'dismissed' && !noToast) toast(C.INTRO.toast);
  }
  /* the first visit: once the paywall, Setup and any other dialog are out
     of the way, and the reader is not typing. Two quiet checks in a row;
     after ten minutes it stops asking for this visit (and asks next time). */
  function autoIntro() {
    if (S.autoTimer) return;
    var u = sessionUser();
    if (!introDue({ state: S.state, meta: metaGet(), welcomeSeen: !!lsGet(WEL_KEY), createdAt: u && u.created_at, now: Date.now() })) return;
    var quiet = 0, t0 = Date.now();
    S.autoTimer = setInterval(function () {
      if (Date.now() - t0 > 10 * 60000 || S.state.intro) { clearInterval(S.autoTimer); S.autoTimer = null; return; }
      quiet = (busyElsewhere() || busy()) ? 0 : quiet + 1;
      if (quiet >= 2) { clearInterval(S.autoTimer); S.autoTimer = null; openIntro({ auto: true }); }
    }, 700);
  }

  /* ============================================================ TOAST */
  function toast(msg) {
    var t = $('edgToast');
    if (!t) { t = doc.createElement('div'); t.id = 'edgToast'; t.className = 'edg-toast'; t.setAttribute('role', 'status'); doc.body.appendChild(t); }
    t.innerHTML = '<span>' + esc(msg) + '</span><button type="button" class="edg-x sm" aria-label="Dismiss">×</button>';
    t.classList.add('on');
    var b = $('edHelpBtn'); if (b) b.classList.add('edg-pulse');
    clearTimeout(S.toastT);
    S.toastT = setTimeout(hideToast, 7000);
  }
  function hideToast() { var t = $('edgToast'); if (t) t.classList.remove('on'); var b = $('edHelpBtn'); if (b) b.classList.remove('edg-pulse'); }

  /* ======================================================= WALKTHROUGHS */
  /* every guide layer shares the welcome overlays' tier (9998, under the
     paywall's 9999); appending it last puts it above whichever of those
     another module opened first, such as a game's stored brief */
  function toTop(el) { if (el && el.parentNode === doc.body && doc.body.lastElementChild !== el) doc.body.appendChild(el); }
  function ensureTourUI() {
    if ($('edgPop')) { toTop($('edgRing')); toTop($('edgPop')); return; }
    var ring = doc.createElement('div'); ring.id = 'edgRing'; ring.className = 'edg-ring'; ring.setAttribute('aria-hidden', 'true');
    var pop = doc.createElement('div'); pop.id = 'edgPop'; pop.className = 'edg-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false');
    pop.setAttribute('aria-labelledby', 'edgPopT'); pop.setAttribute('aria-describedby', 'edgPopB');
    doc.body.appendChild(ring); doc.body.appendChild(pop);
    pop.addEventListener('click', onClick);
    pop.addEventListener('keydown', function (ev) {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '')) return;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); next(); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); back(); }
    });
  }
  /* a game on today's strip to use as the example: one EdgeDesk has
     research for; one that has not started (a started game's board row has
     gone, and its research is the stored pregame copy); the NFL first, then
     college football (their research is the richest), then any sport */
  function gameRank(c) {
    var id = c.getAttribute('data-id') || '', st = c.getAttribute('data-status') || '';
    return (st === 'SCHEDULED' ? 0 : 10) + (/^nfl:/.test(id) ? 0 : /^cfb:/.test(id) ? 1 : 2);
  }
  function chooseGame(ctx) {
    var strip = $('gamesStrip'); if (!strip) return null;
    if (ctx.gameId) { var again = strip.querySelector('.gm-card[data-id="' + cssq(ctx.gameId) + '"]'); if (again) return again; }
    /* the strip folds its overflow away (display: none): only a card the
       reader can see is an example */
    var withMod = Array.prototype.filter.call(strip.querySelectorAll('.gm-card'), function (c) { return visible(c) && c.querySelector('.gm-go[data-kind="module"]'); });
    var pick = withMod.map(function (c, i) { return { c: c, k: gameRank(c) * 100 + i }; }).sort(function (a, b) { return a.k - b.k; })[0];
    if (pick) ctx.gameId = pick.c.getAttribute('data-id');
    return pick ? pick.c : null;
  }
  function decisionCardEl(ctx) {
    var host = $('fbBody'); if (!host) return null;
    if (ctx.cardGame) { var c = host.querySelector('section.edd-act[data-edd-game="' + cssq(ctx.cardGame) + '"]'); if (c && visible(c)) return c; }
    var all = Array.prototype.filter.call(host.querySelectorAll('section.edd-act'), visible);
    if (!all.length) return null;
    /* the one on screen, else the first on the board */
    var vh = root.innerHeight || 800, best = null;
    all.forEach(function (x) { var r = x.getBoundingClientRect(); if (!best && r.bottom > 60 && r.top < vh) best = x; });
    best = best || all[0];
    ctx.cardGame = best.getAttribute('data-edd-game');
    return best;
  }
  var NAMED = {
    gameDetails: function (ctx) { var g = chooseGame(ctx); return g && g.querySelector('.gm-more'); },
    gameResearch: function (ctx) { var g = chooseGame(ctx); return g && g.querySelector('.gm-go[data-kind="module"]'); },
    openedGame: function (ctx) {
      var o = ctx.opened; if (!o) return null;
      var m = /#research\/([a-z]+)(?:\/(.+))?$/.exec(o.href || '');
      var sub = m ? m[1] : null, ent = m && m[2] ? decodeURIComponent(m[2]) : '';
      if (sub === 'football') {
        var p = ent.split('|'), gid = p[p.length - 1];
        var e = $('fbg-nfl-' + gid) || ($('p4gate-' + gid) && ($('p4gate-' + gid).previousElementSibling || $('p4gate-' + gid)));
        if (e) { ctx.cardGame = gid; return e; }
        /* a game that has kicked off opens the research stored before it */
        var bh = $('briefHost'), bc = bh && bh.classList.contains('open') ? bh.querySelector('.brief-card') : null;
        return bc || null;
      }
      var panel = sub ? $('v-' + sub) : null;
      return panel && !panel.classList.contains('hide') ? (panel.firstElementChild || panel) : null;
    }
  };
  function resolveTarget(step, ctx) {
    var list = Array.isArray(step.target) ? step.target : [step.target];
    for (var i = 0; i < list.length; i++) {
      var spec = list[i], e = null;
      try {
        if (typeof spec === 'function') e = spec(ctx);
        else if (NAMED[spec]) e = NAMED[spec](ctx);
        else if (/^card:/.test(spec)) { var c = decisionCardEl(ctx); e = c && c.querySelector(spec.slice(5)); }
        else e = doc.querySelector(spec);
      } catch (err) { e = null; }
      if (e && visible(e)) return e;
    }
    return null;
  }
  function runGo(step, ctx) {
    var g = step.go;
    try {
      if (!g) return;
      /* a step that moves to a screen first closes a game's stored brief, so
         the ring never points at something under it */
      if (g !== 'openGame') { var bh = $('briefHost'); if (bh && bh.classList.contains('open') && root.EDBRIEF && typeof root.EDBRIEF.close === 'function') root.EDBRIEF.close(); }
      if (g === 'openGame') {
        /* already open, or opened a moment ago (by the reader's own tap) and
           still loading: leave it; otherwise (Back closed a stored brief) open it */
        if (ctx.opened && (NAMED.openedGame(ctx) || Date.now() - (ctx.openedAt || 0) < 4000)) return;
        var card = chooseGame(ctx), a = card && card.querySelector('.gm-go[data-kind="module"]');
        if (a) { ctx.opened = { id: ctx.gameId, href: a.getAttribute('href') }; ctx.openedAt = Date.now(); a.click(); }
        return;
      }
      if (g === 'decisionCard') {
        var vr = $('v-research');
        if (!vr || vr.classList.contains('hide') || root.RESEARCH_SUB !== 'football') root.researchGo('football');
        /* decisions live on the NFL and CFB matchup boards, not on Players,
           Rankings or Rosters */
        var seg = doc.querySelector('#fbSeg button.on'), fs = seg && seg.getAttribute('data-fs');
        if (fs && fs !== 'nfl' && fs !== 'p4' && typeof root.fbSetSport === 'function') root.fbSetSport('nfl');
        return;
      }
      if (g[0] === 'research') {
        var r = $('v-research');
        if (g[1]) { if (root.RESEARCH_SUB !== g[1] || !r || r.classList.contains('hide')) root.researchGo(g[1]); }
        else if (!r || r.classList.contains('hide')) root.show('research');
        return;
      }
      if (g[0] === 'view') { var v = $('v-' + g[1]); if (!v || v.classList.contains('hide')) root.show(g[1]); }
    } catch (e) { /* the step will say what it could not find */ }
  }

  function startTour(id, opts) {
    opts = opts || {};
    var t = C.TOURS[id];
    if (!t) return false;
    if (locked()) return false;
    if (!tourOk(id)) { openHelp('home', { note: 'That walkthrough isn’t available in this version of EdgeDesk.' }); return false; }
    if (S.introOpen) closeIntro(opts.fromIntro ? 'done' : null, true);
    closeHelp(true); closeTerm(true); hideToast();
    if (S.tour) endTour('skipped', true);
    ensureTourUI();
    S.tour = t; S.step = 0; S.ctx = opts.ctx || {}; S.returnFocus = opts.returnTo || $('edHelpBtn');
    doc.body.classList.add('edg-touring');
    track('guide_tour_start', { tour: id });
    startLoop();
    showStep(0);
    return true;
  }
  function endTour(status, quiet) {
    var t = S.tour; if (!t) return;
    S.seq++; S.tour = null; S.target = null; S.mode = null;
    stopLoop();
    var ring = $('edgRing'), pop = $('edgPop');
    if (ring) ring.classList.remove('on');
    if (pop) { pop.classList.remove('on'); pop.innerHTML = ''; }
    doc.body.classList.remove('edg-touring');
    if (status === 'done' || (status === 'skipped' && !(S.state.tours[t.id] && S.state.tours[t.id].status === 'done'))) {
      S.state.tours[t.id] = { status: status, at: new Date().toISOString() };
      /* the Card walkthrough covers the Card's own four-page explainer, which
         stays one tap away ("How to read this card") */
      if (status === 'done' && t.id === 'card' && !lsGet(DEC_KEY)) lsSet(DEC_KEY, JSON.stringify(new Date().toISOString()));
      save(); if (status === 'done') metaPush();
    }
    track('guide_tour_' + status, { tour: t.id });
    if (!quiet) restoreFocus(S.returnFocus);
  }
  function next() {
    if (!S.tour) return;
    if (S.step >= S.tour.steps.length - 1) { endTour('done'); return; }
    showStep(S.step + 1);
  }
  function back() { if (S.tour && S.step > 0) showStep(S.step - 1); }

  function showStep(i) {
    var t = S.tour; if (!t) return;
    var step = t.steps[i], seq = ++S.seq;
    S.step = i; S.target = null; S.mode = 'loading'; S.missingSince = 0;
    runGo(step, S.ctx);
    var deadline = Date.now() + (step.wait || 2500), shown = false;
    (function poll() {
      if (seq !== S.seq || !S.tour) return;
      if (locked()) { endTour('interrupted', true); return; }
      var e = resolveTarget(step, S.ctx);
      if (e) { S.mode = 'target'; S.target = e; reveal(e, function () { if (seq === S.seq) renderPop(true); }); return; }
      if (Date.now() > deadline) { S.mode = onPage(step.page) ? 'missing' : 'left'; renderPop(true); return; }
      if (!shown && Date.now() > deadline - (step.wait || 2500) + 350) { shown = true; renderPop(true); }
      setTimeout(poll, 150);
    })();
  }
  /* bring the target into view: inside its own scrolling row first, then
     the page, leaving room for the sticky header and (on a phone) the card */
  function reveal(e, done) {
    var smooth = !reduced();
    try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (err) { /* old engines */ }
    var bar = doc.querySelector('.appbar'), top = (bar ? bar.getBoundingClientRect().bottom : 0) + 12;
    var vh = root.innerHeight || 800, r = e.getBoundingClientRect(), want = 0;
    if (phone()) want = r.top - top;              /* the card docks below it */
    else {
      /* the card needs about this much room beside its target */
      var CARD = 300, room = vh - top - 40, above = r.top - top, below = top + room - r.bottom;
      var inView = r.top >= top && r.bottom <= top + room;
      if (inView && (above >= CARD || below >= CARD)) want = 0;
      else if (r.height + CARD <= room) want = above;                 /* top-align: the card fits underneath */
      else want = r.height > room ? above : r.top - (top + (room - r.height) / 2);
    }
    if (Math.abs(want) > 4) {
      try { root.scrollBy({ top: want, behavior: smooth ? 'smooth' : 'auto' }); } catch (err) { root.scrollBy(0, want); }
    }
    setTimeout(done, smooth ? 340 : 30);
  }

  function chipsHTML(ids) {
    return (ids && ids.length) ? '<div class="edg-chips">' + ids.map(function (id) { var g = C.glossary(id); return g ? '<button type="button" class="edg-chip" data-edg-act="term" data-edg-v="' + id + '" aria-haspopup="dialog">' + esc(g.ask || g.term) + '</button>' : ''; }).join('') + '</div>' : '';
  }
  function renderPop(focus) {
    var t = S.tour, pop = $('edgPop'); if (!t || !pop) return;
    var step = t.steps[S.step], n = t.steps.length, last = S.step === n - 1;
    var body = step.body, note = '', action = null, title = step.title;
    if (S.mode === 'target' && step.adapt && S.target) { var a = adaptFor(step, S.target); if (a) body = a.body; }
    if (S.mode === 'loading') note = '<p class="edg-note" role="status">Loading this screen…</p>';
    if (S.mode === 'missing') {
      var m = step.missing || { body: 'This part of the screen isn’t showing right now, so there’s nothing to point at. You can carry on — the next step still works.' };
      /* the example game was never there to open */
      if (m.none && step.go === 'openGame' && !(S.ctx && S.ctx.opened)) m = m.none;
      note = '<p class="edg-note warn">' + m.body + '</p>'; action = m.action || null;
    }
    if (S.mode === 'left') { note = '<p class="edg-note warn">You’ve moved to another screen. Go back to carry on, or end the walkthrough — you can restart it from Help any time.</p>'; }
    var dots = '<div class="edg-dots" aria-hidden="true">' + t.steps.map(function (_, k) { return '<i class="' + (k < S.step ? 'past' : k === S.step ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var acts = '<div class="edg-acts">'
      + '<button type="button" class="edg-link" data-edg-act="skip">' + (last ? 'Close' : 'Skip') + '</button><span class="edg-sp"></span>'
      + (S.mode === 'left' ? '<button type="button" class="btn sm" data-edg-act="return">Go back</button>'
        : (S.step > 0 ? '<button type="button" class="btn ghost sm" data-edg-act="back">Back</button>' : '')
          + '<button type="button" class="btn sm edg-next" data-edg-act="next">' + (last ? 'Done' : 'Next') + '</button>')
      + '</div>';
    var fix = action === 'research' ? '<button type="button" class="edg-link" data-edg-act="goto" data-edg-v="research">Open Research</button>'
      : action === 'games' ? '<button type="button" class="edg-link" data-edg-act="goto" data-edg-v="games">View all games</button>'
        : action === 'glossary' ? '<button type="button" class="edg-link" data-edg-act="help" data-edg-v="terms">Open Terms &amp; numbers</button>' : '';
    var after = '';
    if (last && S.mode !== 'left') {
      var nx = (t.next || []).filter(tourOk);
      if (nx.length) after = '<div class="edg-next-up"><span>Next up</span>' + nx.map(function (id) { return '<button type="button" class="edg-chip" data-edg-act="follow" data-edg-v="' + id + '">' + esc(C.TOURS[id].title) + '</button>'; }).join('') + '</div>';
    }
    pop.innerHTML = '<div class="edg-pop-hd"><span class="edg-pop-k">' + esc(t.title) + ' · Step ' + (S.step + 1) + ' of ' + n + '</span>'
      + '<button type="button" class="edg-x sm" data-edg-act="skip" aria-label="End walkthrough">×</button></div>' + dots
      + '<h3 class="edg-pop-t" id="edgPopT" tabindex="-1">' + esc(title) + '</h3>'
      + '<div class="edg-pop-b" id="edgPopB"><p>' + body + '</p>' + note + (fix ? '<p class="edg-fix">' + fix + '</p>' : '') + '</div>'
      + (S.mode === 'left' ? '' : chipsHTML(step.terms)) + after + acts;
    /* a step may have opened a same-tier overlay (a stored brief) after us */
    var ringEl = $('edgRing');
    toTop(ringEl); toTop(pop);
    if (focus && ringEl) { ringEl.classList.add('glide'); clearTimeout(S.glideT); S.glideT = setTimeout(function () { ringEl.classList.remove('glide'); }, 260); }
    pop.classList.add('on');
    place();
    if (focus) focusIn(pop.querySelector('#edgPopT'));
  }
  /* the ring follows its target; the card sits beside it without covering it */
  function place() {
    var pop = $('edgPop'), ring = $('edgRing'); if (!pop || !S.tour) return;
    var vw = root.innerWidth || 1024, vh = root.innerHeight || 800;
    var bar = doc.querySelector('.appbar'), topRes = (bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0) + 8;
    var nav = doc.querySelector('.bottomnav'), foot = $('edFoot');
    var botRes = 8 + (foot ? foot.offsetHeight : 0) + (nav && nav.getBoundingClientRect().top > vh / 2 ? nav.offsetHeight : 0);
    var e = S.mode === 'target' ? S.target : null;
    var r = e ? e.getBoundingClientRect() : null;
    if (r) {
      var pad = 6, x1 = Math.max(4, r.left - pad), y1 = Math.max(topRes - 4, r.top - pad), x2 = Math.min(vw - 4, r.right + pad), y2 = Math.min(vh - 4, r.bottom + pad);
      if (y2 - y1 > 4 && x2 - x1 > 4) {
        ring.style.left = x1 + 'px'; ring.style.top = y1 + 'px'; ring.style.width = (x2 - x1) + 'px'; ring.style.height = (y2 - y1) + 'px';
        ring.classList.add('on');
      } else ring.classList.remove('on');
    } else ring.classList.remove('on');
    pop.style.left = pop.style.top = pop.style.right = pop.style.bottom = '';
    if (phone()) {
      pop.classList.add('dock');
      var ph = pop.offsetHeight;
      /* docked above the navigation; if that would cover the target, dock
         under the header instead */
      var dockTop = vh - botRes - ph;
      if (r && r.bottom > dockTop - 4 && r.top > topRes + ph + 12) { pop.style.top = topRes + 'px'; }
      else pop.style.bottom = botRes + 'px';
      return;
    }
    pop.classList.remove('dock');
    var pw = pop.offsetWidth, ph2 = pop.offsetHeight, gap = 12, left, top;
    if (!r || !ring.classList.contains('on')) { left = (vw - pw) / 2; top = Math.max(topRes, (vh - ph2) / 2); }
    else if (r.bottom + gap + ph2 <= vh - botRes) { top = r.bottom + gap; left = r.left; }
    else if (r.top - gap - ph2 >= topRes) { top = r.top - gap - ph2; left = r.left; }
    else if (r.right + gap + pw <= vw - 8) { left = r.right + gap; top = r.top; }
    else if (r.left - gap - pw >= 8) { left = r.left - gap - pw; top = r.top; }
    else { left = vw - pw - 16; top = vh - botRes - ph2; }
    left = Math.max(8, Math.min(left, vw - pw - 8)); top = Math.max(topRes, Math.min(top, vh - botRes - ph2));
    pop.style.left = Math.round(left) + 'px'; pop.style.top = Math.round(top) + 'px';
  }
  function schedule() { if (S.raf) return; S.raf = (root.requestAnimationFrame || setTimeout)(function () { S.raf = 0; tick(); }); }
  /* every frame that matters: a re-rendered board replaced the target, the
     reader scrolled, or left the screen */
  function tick() {
    if (!S.tour) return;
    var step = S.tour.steps[S.step];
    if (S.mode === 'target' && !(S.target && visible(S.target))) {
      var e = resolveTarget(step, S.ctx);
      if (e) S.target = e;
      else {
        if (!S.missingSince) S.missingSince = Date.now();
        if (Date.now() - S.missingSince > 1200) { S.mode = onPage(step.page) ? 'missing' : 'left'; renderPop(false); }
        else { var ring = $('edgRing'); if (ring) ring.classList.remove('on'); }
        return;
      }
    }
    if (S.mode === 'target') S.missingSince = 0;
    /* data that arrived late, or a reader who came back: the step finds its control again */
    if ((S.mode === 'left' || S.mode === 'missing') && onPage(step.page)) { var back2 = resolveTarget(step, S.ctx); if (back2) { S.mode = 'target'; S.target = back2; reveal(back2, function () { renderPop(false); }); return; } }
    place();
  }
  function startLoop() {
    stopLoop();
    root.addEventListener('scroll', schedule, true);
    root.addEventListener('resize', schedule);
    S.loop = setInterval(schedule, 400);
  }
  function stopLoop() {
    root.removeEventListener('scroll', schedule, true);
    root.removeEventListener('resize', schedule);
    if (S.loop) { clearInterval(S.loop); S.loop = null; }
  }

  /* ========================================================== HELP PANEL */
  function ensureHelpUI() {
    if ($('edgHelp')) return;
    var bg = doc.createElement('div'); bg.id = 'edgHelpBg'; bg.className = 'edg-help-bg';
    var h = doc.createElement('aside'); h.id = 'edgHelp'; h.className = 'edg-help'; h.setAttribute('role', 'dialog'); h.setAttribute('aria-modal', 'true'); h.setAttribute('aria-labelledby', 'edgHelpT');
    doc.body.appendChild(bg); doc.body.appendChild(h);
    bg.addEventListener('click', function () { closeHelp(); });
    h.addEventListener('click', onClick);
    h.addEventListener('keydown', function (ev) { trapTab(h, ev); });
    h.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'edgHelpQ') { S.helpQuery = ev.target.value; paintTermList(); } });
  }
  function taskRow(id) {
    var t = C.TOURS[id], st = S.state.tours[id];
    var badge = st && st.status === 'done' ? '<i class="edg-done">✓ Done</i>' : '<i>' + t.steps.length + ' steps</i>';
    return '<button type="button" class="edg-row" data-edg-act="tour" data-edg-v="' + id + '"><b>' + esc(t.title) + '</b><span>' + esc(t.line) + '</span>' + badge + '</button>';
  }
  function termRow(g) { return '<button type="button" class="edg-row" data-edg-act="entry" data-edg-v="' + g.id + '"><b>' + esc(g.term) + '</b><span>' + esc(g.short) + '</span></button>'; }
  function termListHTML() {
    var hits = C.search(S.helpQuery);
    if (!hits.length) return '<p class="edg-muted">No term matches “' + esc(S.helpQuery) + '”. Try “fair”, “EV” or “confidence”.</p>';
    if (S.helpQuery) return hits.map(termRow).join('');
    return C.GROUPS.map(function (gr) { var rows = hits.filter(function (g) { return g.group === gr; }); return rows.length ? '<div class="edg-grp">' + esc(gr) + '</div>' + rows.map(termRow).join('') : ''; }).join('');
  }
  function paintTermList() { var l = $('edgTermList'); if (l) l.innerHTML = termListHTML(); }
  function helpHomeHTML(opts) {
    var page = currentPage(), here = C.toursFor(page).filter(tourOk), terms = C.termsFor(page);
    var others = C.TASKS.filter(function (id) { return tourOk(id) && here.indexOf(id) < 0; });
    var h = '<p class="edg-lede">Research, not picks. Learn a screen in a few steps, or look up what a number means.</p>';
    if (opts && opts.note) h += '<p class="edg-note warn">' + esc(opts.note) + '</p>';
    h += '<section class="edg-sec" aria-labelledby="edgSecHere"><h3 id="edgSecHere">On this page <span>' + esc(C.pageLabel(page)) + '</span></h3>';
    if (here.length) h += here.map(function (id, k) { return '<button type="button" class="btn sm edg-wide' + (k ? ' ghost' : '') + '" data-edg-act="tour" data-edg-v="' + id + '">' + (k ? '' : 'Walk me through it: ') + esc(C.TOURS[id].title) + '</button>'; }).join('');
    else h += '<p class="edg-muted">There’s no walkthrough for this screen yet. Pick a task below, or look up a term.</p>';
    if (terms.length) h += '<div class="edg-chips">' + terms.map(function (id) { var g = C.glossary(id); return g ? '<button type="button" class="edg-chip" data-edg-act="entry" data-edg-v="' + id + '">' + esc(g.term) + '</button>' : ''; }).join('') + '</div>';
    h += '</section>';
    if (others.length) h += '<section class="edg-sec" aria-labelledby="edgSecTasks"><h3 id="edgSecTasks">Learn a task</h3>' + others.map(taskRow).join('') + '</section>';
    h += '<section class="edg-sec" aria-labelledby="edgSecTerms"><h3 id="edgSecTerms">Terms &amp; numbers</h3>'
      + '<label class="edg-search"><span class="edg-vh">Search terms</span><input type="search" id="edgHelpQ" placeholder="Search: fair spread, EV, CLV…" value="' + esc(S.helpQuery) + '" autocomplete="off"></label>'
      + '<div id="edgTermList">' + termListHTML() + '</div></section>';
    h += '<section class="edg-sec" aria-labelledby="edgSecMore"><h3 id="edgSecMore">Start over</h3>'
      + '<button type="button" class="edg-row" data-edg-act="replay"><b>Replay the introduction</b><span>The one-minute welcome, and the choice of where to start.</span></button>'
      + (typeof root.hiwOpen === 'function' ? '<button type="button" class="edg-row" data-edg-act="method"><b>How EdgeDesk works</b><span>The methodology, screen by screen.</span></button>' : '')
      + '</section>';
    return h;
  }
  function entryHTML(id) {
    var g = C.glossary(id); if (!g) return helpHomeHTML();
    return '<button type="button" class="edg-link edg-backlink" data-edg-act="home">← All help</button>'
      + '<article class="edg-entry"><h3 class="edg-entry-t">' + esc(g.term) + '</h3>' + (g.aka ? '<p class="edg-aka">Also shown as: ' + esc(g.aka) + '</p>' : '')
      + '<h4>What it is</h4><p>' + esc(g.what) + '</p><h4>How to use it</h4><p>' + esc(g.use) + '</p>'
      + '<h4>Keep in mind</h4><p class="edg-limit">' + esc(g.limits) + '</p>'
      + (g.where && g.where.length ? '<h4>Where you’ll see it</h4><ul>' + g.where.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '')
      + (g.related && g.related.length ? '<h4>Related</h4><div class="edg-chips">' + g.related.map(function (r) { var x = C.glossary(r); return x ? '<button type="button" class="edg-chip" data-edg-act="entry" data-edg-v="' + r + '">' + esc(x.term) + '</button>' : ''; }).join('') + '</div>' : '')
      + '</article>';
  }
  function paintHelp(opts) {
    var h = $('edgHelp'); if (!h) return;
    var v = S.helpView;
    var body = v === 'home' || v === 'terms' ? helpHomeHTML(opts) : /^entry:/.test(v) ? entryHTML(v.slice(6)) : helpHomeHTML(opts);
    h.innerHTML = '<div class="edg-help-hd"><h2 id="edgHelpT" tabindex="-1">Help <span>· Learn EdgeDesk</span></h2><button type="button" class="edg-x" data-edg-act="help-close" aria-label="Close help">×</button></div>'
      + '<div class="edg-help-b">' + body + '</div>'
      + '<div class="edg-help-ft">Research and decision-support tool. EdgeDesk can be wrong. 21+ · Bet responsibly · <a href="tel:18004262537">1-800-GAMBLER</a></div>';
    var b = h.querySelector('.edg-help-b'); if (b) b.scrollTop = 0;
    if (v === 'terms') { var q = $('edgHelpQ'); if (q) { q.scrollIntoView({ block: 'start' }); focusIn(q); return; } }
    focusIn(h.querySelector('#edgHelpT'));
  }
  function openHelp(view, opts) {
    if (locked()) return false;
    ensureHelpUI(); closeTerm(true); hideToast();
    if (S.introOpen) closeIntro('dismissed', true, true);
    if (!S.helpOpen) S.helpReturn = (opts && opts.returnTo) || doc.activeElement;
    toTop($('edgHelpBg')); toTop($('edgHelp'));
    S.helpOpen = true; S.helpView = typeof view === 'string' ? view : 'home';
    if (S.helpView !== 'terms' && !/^entry:/.test(S.helpView)) S.helpQuery = '';
    $('edgHelp').classList.add('on'); $('edgHelpBg').classList.add('on');
    doc.body.classList.add('edg-help-open');
    var btn = $('edHelpBtn'); if (btn) btn.setAttribute('aria-expanded', 'true');
    if (!S.state.helpSeen) { S.state.helpSeen = true; save(); }
    paintHelp(opts);
    track('guide_help_open', { page: currentPage() });
    return true;
  }
  function closeHelp(quiet) {
    if (!S.helpOpen) return;
    S.helpOpen = false;
    var h = $('edgHelp'), bg = $('edgHelpBg');
    if (h) { h.classList.remove('on'); h.innerHTML = ''; }
    if (bg) bg.classList.remove('on');
    doc.body.classList.remove('edg-help-open');
    var btn = $('edHelpBtn'); if (btn) btn.setAttribute('aria-expanded', 'false');
    if (!quiet) restoreFocus(S.helpReturn);
  }

  /* ======================================================= TERM EXPLAINER */
  function termIdOf(el) {
    if (!el) return null;
    var id = el.getAttribute('data-ed-term');
    if (id && C.glossary(id)) return id;
    var k = el.getAttribute('data-ed-tip');
    return k ? C.termForTip(k) : null;
  }
  function explain(id, anchor) {
    var g = C.glossary(id); if (!g) return false;
    closeTerm(true);
    var p = $('edgTerm');
    if (!p) {
      p = doc.createElement('div'); p.id = 'edgTerm'; p.className = 'edg-term'; p.setAttribute('role', 'dialog'); p.setAttribute('aria-modal', 'false'); p.setAttribute('aria-labelledby', 'edgTermT');
      doc.body.appendChild(p); p.addEventListener('click', onClick);
      p.addEventListener('keydown', function (ev) { trapTab(p, ev); });
    }
    p.innerHTML = '<div class="edg-term-hd"><h3 id="edgTermT" tabindex="-1">' + esc(g.term) + '</h3><button type="button" class="edg-x sm" data-edg-act="term-close" aria-label="Close">×</button></div>'
      + '<p>' + esc(g.what) + '</p><p><b>How to use it.</b> ' + esc(g.use) + '</p><p class="edg-limit"><b>Keep in mind.</b> ' + esc(g.limits) + '</p>'
      + (S.helpOpen || S.tour ? '' : '<button type="button" class="edg-link" data-edg-act="term-more" data-edg-v="' + id + '">More in Help →</button>');
    toTop(p);
    S.termOpen = id; S.termTrigger = anchor || doc.activeElement;
    if (anchor && anchor.setAttribute) anchor.setAttribute('aria-expanded', 'true');
    p.classList.add('on');
    placeTerm(p, anchor);
    focusIn(p.querySelector('#edgTermT'));
    track('guide_term_open', { term: id });
    return true;
  }
  function placeTerm(p, a) {
    p.style.left = p.style.top = p.style.bottom = p.style.maxHeight = '';
    if (phone() || !a || !visible(a)) {
      p.classList.add('dock');
      /* docked above the navigation: keep the term it explains in view */
      if (a && visible(a)) { var ar = a.getBoundingClientRect(), pt = p.getBoundingClientRect().top; if (ar.bottom > pt - 8) root.scrollBy(0, ar.bottom - pt + 16); }
      return;
    }
    p.classList.remove('dock');
    p.style.maxHeight = '';
    var r = a.getBoundingClientRect(), vw = root.innerWidth || 1024, vh = root.innerHeight || 800, pw = p.offsetWidth, ph = p.offsetHeight;
    var bar = doc.querySelector('.appbar'), topRes = (bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0) + 8, botRes = 40;
    var below = vh - botRes - (r.bottom + 8), above = r.top - 8 - topRes, left = Math.max(8, Math.min(r.left, vw - pw - 8)), top;
    /* below the term, else above it, else beside it — never over it */
    if (ph <= below) top = r.bottom + 8;
    else if (ph <= above) top = r.top - 8 - ph;
    else if (vw - r.right - 16 >= pw || r.left - 16 >= pw) {
      left = vw - r.right - 16 >= pw ? r.right + 8 : r.left - 8 - pw;
      top = Math.max(topRes, Math.min(r.top - 24, vh - botRes - ph));
    } else if (below >= above) { top = r.bottom + 8; p.style.maxHeight = Math.max(160, below) + 'px'; }
    else { p.style.maxHeight = Math.max(160, above) + 'px'; top = r.top - 8 - p.offsetHeight; }
    p.style.left = Math.round(left) + 'px'; p.style.top = Math.round(Math.max(topRes, top)) + 'px';
  }
  function closeTerm(quiet) {
    var p = $('edgTerm'); if (!p || !S.termOpen) return;
    p.classList.remove('on'); p.innerHTML = '';
    var a = S.termTrigger; S.termOpen = null; S.termTrigger = null;
    if (a && a.removeAttribute) a.removeAttribute('aria-expanded');
    if (!quiet) restoreFocus(a);
  }
  /* terms rendered by other modules become keyboard- and screen-reader
     reachable buttons, whenever they are (re)drawn */
  function upgradeTerms() {
    S.upRaf = 0;
    var list = doc.querySelectorAll('[data-ed-term]:not([data-edg-up]),.edd-tip[data-ed-tip]:not([data-edg-up])');
    for (var i = 0; i < list.length; i++) {
      var el = list[i], id = termIdOf(el);
      el.setAttribute('data-edg-up', id ? '1' : '0');
      if (!id) continue;
      el.classList.add('edg-termlink');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-haspopup', 'dialog');
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', (el.textContent || '').trim() + ' — what does this mean?');
    }
  }
  function scheduleUpgrade() { if (!S.upRaf) S.upRaf = (root.requestAnimationFrame || setTimeout)(upgradeTerms); }

  /* =========================================================== EVENTS */
  function onClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-edg-act]') : null; if (!b) return;
    var a = b.getAttribute('data-edg-act'), v = b.getAttribute('data-edg-v');
    ev.preventDefault();
    if (a === 'intro-tour') { S.introView = 'choose'; paintIntro(); }
    else if (a === 'intro-back') { S.introView = 'intro'; paintIntro(); }
    else if (a === 'intro-skip') closeIntro('dismissed');
    else if (a === 'tour') {
      var from = S.introOpen; var ret = S.helpOpen ? S.helpReturn : S.introOpen ? S.introReturn : null;
      if (from) closeIntro('done', true);
      startTour(v, { fromIntro: from, returnTo: (ret && ret.isConnected && ret !== doc.body) ? ret : $('edHelpBtn') });
    }
    else if (a === 'next') next();
    else if (a === 'back') back();
    else if (a === 'skip') endTour(S.tour && S.step === S.tour.steps.length - 1 && S.mode === 'target' ? 'done' : 'skipped');
    else if (a === 'return') { if (S.tour) showStep(S.step); }
    else if (a === 'follow') { var c = S.ctx; endTour('done', true); startTour(v, { ctx: v === 'numbers' && c.cardGame ? { cardGame: c.cardGame } : {} }); }
    else if (a === 'goto') { var t = S.tour; if (v === 'games' && typeof root.show === 'function') root.show('games'); else if (v === 'research' && typeof root.show === 'function') root.show('research'); if (t) setTimeout(function () { if (S.tour === t) showStep(S.step); }, 300); }
    else if (a === 'help') { if (S.tour) endTour('skipped', true); openHelp(v || 'home'); }
    else if (a === 'help-close') closeHelp();
    else if (a === 'home') { S.helpView = 'home'; paintHelp(); }
    else if (a === 'entry') { S.helpView = 'entry:' + v; paintHelp(); }
    else if (a === 'replay') { closeHelp(true); openIntro({ returnTo: S.helpReturn }); }
    else if (a === 'method') { closeHelp(true); try { root.hiwOpen(); } catch (e) { /* methodology unavailable */ } }
    else if (a === 'term') explain(v, b);
    else if (a === 'term-close') closeTerm();
    else if (a === 'term-more') { closeTerm(true); if (S.tour) endTour('skipped', true); openHelp('entry:' + v); }
  }
  function onDocClick(ev) {
    var t = ev.target;
    /* a term on the page: explain it instead of what the row would do */
    var term = t && t.closest ? t.closest('[data-ed-term],.edd-tip[data-ed-tip]') : null;
    if (term && !(t.closest('#edgHelp,#edgPop,#edgTerm'))) {
      var id = termIdOf(term);
      if (id) { ev.preventDefault(); ev.stopPropagation(); if (S.termOpen === id && S.termTrigger === term) closeTerm(); else explain(id, term); return; }
    }
    if (S.termOpen && !(t && t.closest && t.closest('#edgTerm'))) closeTerm(true);
    var toastEl = $('edgToast'); if (toastEl && toastEl.classList.contains('on') && t && t.closest && t.closest('#edgToast')) hideToast();
    /* the reader pressed the highlighted control themselves */
    if (S.tour && S.mode === 'target' && S.target && S.target.contains(t)) {
      var step = S.tour.steps[S.step];
      if (step.clickNext) {
        var a = S.target.closest ? (S.target.matches('a') ? S.target : S.target.querySelector('a')) : null;
        S.ctx.openedAt = Date.now(); S.ctx.opened = { id: S.ctx.gameId, href: a ? a.getAttribute('href') : null };
        var tr = S.tour; setTimeout(function () { if (S.tour === tr) next(); }, 250);
      }
    }
  }
  function onKey(ev) {
    var k = ev.key;
    if ((k === 'Enter' || k === ' ') && ev.target && ev.target.matches && ev.target.matches('[data-ed-term],.edd-tip[data-ed-tip]')) {
      var id = termIdOf(ev.target); if (id) { ev.preventDefault(); ev.stopPropagation(); explain(id, ev.target); return; }
    }
    if (k !== 'Escape') { if (S.introOpen && $('welHost')) trapTab($('welHost'), ev); return; }
    if (S.termOpen) { ev.stopPropagation(); closeTerm(); return; }
    if (S.helpOpen) { ev.stopPropagation(); closeHelp(); return; }
    if (S.introOpen) { ev.stopPropagation(); closeIntro('dismissed'); return; }
    if (S.tour) { ev.stopPropagation(); endTour('skipped'); }
  }

  /* =========================================================== ENTRIES */
  function paintHelpBtn() {
    var b = $('edHelpBtn'); if (!b) return;
    b.classList.toggle('edg-new', !S.state.helpSeen);
  }
  function wire() {
    var b = $('edHelpBtn');
    if (b && !b.getAttribute('data-edg-wired')) {
      b.setAttribute('data-edg-wired', '1'); b.removeAttribute('onclick');
      b.addEventListener('click', function (ev) { ev.stopPropagation(); if (S.helpOpen) closeHelp(); else openHelp('home', { returnTo: b }); });
    }
    paintHelpBtn();
  }
  function boot() {
    if (S.booted) return; S.booted = true;
    S.state = mergeMeta(readState(store()), metaGet());
    save();
    wire();
    doc.addEventListener('click', onDocClick, true);
    doc.addEventListener('keydown', onKey, true);
    try { new root.MutationObserver(scheduleUpgrade).observe(doc.body, { childList: true, subtree: true }); } catch (e) { /* no observer: terms keep their tooltips */ }
    upgradeTerms();
    if ($('welHost')) introHost();
    root.addEventListener('resize', function () { if (S.termOpen) placeTerm($('edgTerm'), S.termTrigger); });
    autoIntro();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();

  return Object.assign(PURE, {
    openIntro: openIntro, autoIntro: autoIntro, openHelp: openHelp, closeHelp: closeHelp, startTour: startTour, endTour: endTour,
    next: next, back: back, explain: explain, closeTerm: closeTerm, busy: busy, currentPage: currentPage,
    state: function () { return norm(S.state); }, tourOk: tourOk,
    /* tests */
    _S: S, _busyElsewhere: busyElsewhere, _resolveTarget: resolveTarget, _upgradeTerms: upgradeTerms
  });
}));
