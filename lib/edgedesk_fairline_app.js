/* ===========================================================================
   EdgeDesk FAIRLINE — the page (fairline/index.html).
   docs/fairline.md

   Two questions every bettor has, answered from prices and the reader's own
   bets, never from picks:
     The Board   am I getting a good number right now?
     The Leaks   where am I losing money, and is it bad bets or bad luck?
     The Tape    the weekly recap (Coming Soon).

   WHO CAN USE IT. Any signed-in account. A free account (and a Bet Checker
   one) sees the top three rows of The Board and the name of its biggest
   leak's slice; Fairline (tier black) and the Research Terminal (tier blue)
   see everything. The paid gate is the database's (fairline_paid() ->
   has_fairline_paid()): the page only shows what the answer contains.

   WHAT IT ASKS
     fairline_board(p_sport, p_market, p_book)   The Board
     fairline_leaks()                            The Leaks
     my_billing_access                           the plan (lib/edgedesk_access.js)
     create_checkout_session                     Fairline checkout, after the
                                                 automatic-renewal consent below

   THE CONSENT (California automatic-renewal law), exactly as Bet Checker and
   the landing page do it: the terms are lib/edgedesk_pricing.js
   fairlineTerms(); the box must be ticked; the server checkout is created
   (it refuses a price that is not the figure shown, or that the database
   could not record as Fairline); the terms AS SHOWN are recorded in
   billing_consents; only then does the browser go to Stripe. No record, no
   checkout. A Bet Checker customer is sent to the billing portal to switch
   plan, never to a second checkout.
   The sign-in is the Games door (games/lib/auth.js), configured to come back
   here: the same session the terminal and Bet Checker keep.

   Not lib/edgedesk_fairline.js, which is the Linemaker's fair-line sheet.

   Browser: window.EDFairline.mount(host, { url, key }).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDFairline = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var C = root.EDFairlineCore || (typeof require === 'function' ? require('./edgedesk_fairline_core.js') : null);
  var X = { VERSION: 'edgedesk_fairline_app/1' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(host, sel) { return host.querySelector(sel); }
  function when(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    try { return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
    catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  /* The Board's known limitations: what the page says about its own coverage */
  X.BOARD_LIMITS = [
    'This is a price board, not a pick list. A large edge is a number about a price, not a recommendation to bet it.',
    'Coverage is whatever capture recorded. Per-book quotes are captured for actionable lines only today; every other row shows the single best price capture saw, not every book’s.',
    'Prices are as of the last capture run, not live. The age column says how old each one is; past capture’s own freshness limit for that sport and that distance from the start, a row is greyed out and sorted last.',
    'Game lines only: spreads, totals and moneylines, at each side’s main line. Props are not on The Board.',
    'Kalshi: game winners only, where EdgeDesk has linked the market. Prices are 5-minute snapshots, shown only when the market is two-sided with a spread of 6¢ or less, and before Kalshi’s fees. Kalshi is never counted as the best price.',
    'DK Predictions: no price feed exists yet, so the column is Coming Soon and shows no number.'
  ];

  function make(host, opts) {
    var o = opts || {};
    var S = {
      host: host, url: String(o.url || '').replace(/\/+$/, ''), key: o.key || '',
      auth: o.auth || root.EDGamesAuth, social: o.social || root.EDGamesSocial,
      access: o.access || root.EDAccess, pricing: o.pricing || root.EDPricing, edauth: o.edauth || root.EDAuth,
      fetch: o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(root) : null),
      location: o.location || root.location, history: o.history || root.history,
      user: null, acc: null, board: null, boardError: false, leaks: null, leaksError: false, plan: 'monthly',
      tab: 'board', filters: { sport: '', market: '', book: '' }, facets: null
    };

    /* ── the network ──────────────────────────────────────────────────── */
    async function token() {
      try { if (S.auth && S.auth.ensure) await S.auth.ensure(); } catch (_) { /* signed out below */ }
      var s = S.social && S.social.user() ? S.social.session() : null;
      return s && s.access_token ? s.access_token : null;
    }
    async function rpc(name, args) {
      var t = await token();
      if (!t) { var e0 = new Error('signed_out'); e0.status = 401; throw e0; }
      var r = await S.fetch(S.url + '/rest/v1/rpc/' + name, { method: 'POST',
        headers: { apikey: S.key, authorization: 'Bearer ' + t, 'content-type': 'application/json' },
        body: JSON.stringify(args || {}) });
      var text = await r.text();
      if (!r.ok) { var e = new Error(name + ' ' + r.status); e.status = r.status; e.body = text; throw e; }
      return text ? JSON.parse(text) : null;
    }
    function accessCfg() { return { url: S.url, key: S.key, token: token, fetch: S.fetch }; }

    function status(msg, kind) {
      var el = $(host, '[data-fl="status"]');
      if (!el) return;
      el.hidden = !msg;
      el.className = 'fl-status' + (kind ? ' ' + kind : '');
      el.innerHTML = msg || '';
    }

    /* ── the offer: Fairline's own plan; a Bet Checker customer switches ─ */
    function switcher() { return !!(S.acc && S.acc.bet_checker_paid && !S.acc.fairline_paid && !S.acc.has_access); }
    function offerHTML(what) {
      var P = S.pricing;
      var off = P && P.fairlineOffer ? P.fairlineOffer('monthly') : null;
      var portal = P && P.portalLink ? P.portalLink() : '';
      if (switcher()) {
        return '<span>' + esc(what) + ' Your Bet Checker plan switches to Fairline in the billing portal: the switch replaces Bet Checker, so you are never billed for both, and Bet Checker stays included.</span>' +
          (portal ? '<a class="btn" href="' + esc(portal) + '" target="_blank" rel="noopener" data-fl="upgrade">Switch to Fairline</a>' : '');
      }
      return '<span>' + esc(what) + (off ? ' ' + esc((P.FAIRLINE && P.FAIRLINE.PLAN_NAME) || 'Fairline') + ': ' + esc(off.short) + ', Bet Checker included.' : '') + '</span>' +
        '<button type="button" class="btn" data-fl-act="upgrade" data-fl="upgrade">Get Fairline' + (off ? ' \u2014 ' + esc(off.short) : '') + '</button>';
    }

    /* ── The Board ────────────────────────────────────────────────────── */
    function cell(k, v, cls, sub, title) {
      return '<div class="fl-cell' + (cls ? ' ' + cls : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '><span class="k">' + esc(k) + '</span><span class="v">' + v +
        (sub ? '<i>' + esc(sub) + '</i>' : '') + '</span></div>';
    }
    function rowHTML(r) {
      var v = C.boardRow(r);
      return '<article class="fl-row" data-fresh="' + (v.fresh ? 'true' : 'false') + '" data-key="' + esc(v.key) + '">' +
        '<div class="fl-game"><span class="gm-lg">' + esc(v.league) + '</span><b>' + esc(v.side) + '</b>' +
          '<span class="fl-sub">' + esc(v.game) + ' · ' + esc(when(r.commence_time)) + '</span>' +
          (v.stale ? '<span class="fl-chip stale">Stale</span>' : '') + '</div>' +
        cell('Fair', esc(v.fairProb), '', v.fairOdds) +
        cell('Best price', esc(v.best), '', v.book) +
        cell('Edge vs fair', esc(v.edge), 'edge ' + v.edgeCls) +
        cell('Kalshi', esc(v.kalshi.text), 'kalshi', v.kalshi.sub, v.kalshi.title) +
        cell('DK Predictions', '<span class="fl-chip soon">Coming Soon</span>', 'inactive', '', 'No DK Predictions price feed exists yet.') +
        cell('Quote age', esc(v.age), v.stale ? 'age stale' : 'age', v.stale ? v.staleWhy : '') +
      '</article>';
    }
    var HEAD = '<div class="fl-row fl-head" aria-hidden="true"><div class="fl-game">Game · market · side</div><div class="fl-cell">Fair</div><div class="fl-cell">Best price</div>' +
      '<div class="fl-cell">Edge vs fair</div><div class="fl-cell">Kalshi</div><div class="fl-cell">DK Predictions</div><div class="fl-cell">Quote age</div></div>';
    function filtersHTML(b) {
      var locked = !b.paid;
      /* the choices are the whole board's (kept from the last unfiltered
         read), so picking one filter never removes the others' options */
      var f = S.facets || b.facets || {}, cur = S.filters;
      var opt = function (v, l, on) { return '<option value="' + esc(v) + '"' + (on ? ' selected' : '') + '>' + esc(l) + '</option>'; };
      return '<form class="fl-filters" data-fl="filters" onsubmit="return false">' +
        '<label>Sport<select name="sport"' + (locked ? ' disabled' : '') + '>' + opt('', 'All sports', !cur.sport) +
          (f.sports || []).map(function (s) { return opt(s.key, s.label, cur.sport === s.key); }).join('') + '</select></label>' +
        '<label>Market<select name="market"' + (locked ? ' disabled' : '') + '>' + opt('', 'All markets', !cur.market) +
          ['spread', 'total', 'moneyline'].map(function (m) { return opt(m, C.MARKET_WORDS[m], cur.market === m); }).join('') + '</select></label>' +
        '<label>Book<select name="book"' + (locked ? ' disabled' : '') + '>' + opt('', 'Best price at any book', !cur.book) +
          (f.books || []).slice().sort().map(function (k) { return opt(k, k, cur.book === k); }).join('') + '</select></label>' +
        (locked ? '<p class="note">Filters are part of Fairline.</p>' : '') + '</form>';
    }
    function renderBoard() {
      var el = $(host, '[data-fl="board-body"]');
      if (!el) return;
      if (S.boardError) { el.innerHTML = '<div class="gm-empty">The Board could not be loaded. Reload to try again.</div>'; return; }
      var b = S.board;
      if (!b) { el.innerHTML = '<div class="gm-empty">Loading The Board…</div>'; return; }
      var rows = b.rows || [];
      var top = filtersHTML(b) + '<p class="fl-asof">Prices as captured' + (b.as_of ? ' · read ' + esc(when(b.as_of)) : '') +
        ' · ' + esc(String(b.fresh_rows || 0)) + ' fresh of ' + esc(String(b.total_rows || 0)) + '</p>';
      if (!rows.length) {
        el.innerHTML = top + '<div class="gm-empty">' + (b.paid && (S.filters.sport || S.filters.market || S.filters.book)
          ? 'No rows match these filters.' : 'No upcoming games with a fair price on EdgeDesk’s board right now.') + '</div>';
        return;
      }
      var list = '<div class="fl-board" data-fl="rows">' + HEAD + rows.map(rowHTML).join('') + '</div>';
      if (!b.paid) {
        /* the rest, as shapes under a blur: the server sent no row to reveal */
        var fake = '';
        for (var i = 0; i < 3; i++) {
          fake += '<article class="fl-row"><div class="fl-game"><span class="gm-lg">—</span><b>Team 0.0</b><span class="fl-sub">Away at Home</span></div>' +
            cell('Fair', '00.0%', '', 'fair −000') + cell('Best price', '+000') + cell('Edge vs fair', '+0.00 pts') + cell('Kalshi', '00¢') +
            cell('DK Predictions', 'Coming Soon') + cell('Quote age', '00 min') + '</article>';
        }
        list += '<div class="fl-locked" data-fl="board-locked"><div class="fl-blur" aria-hidden="true">' + fake + '</div>' +
          '<div class="fl-lock-over"><b>' + esc(String(b.hidden_rows || 0)) + ' more ' + (b.hidden_rows === 1 ? 'price' : 'prices') + ' on The Board</b>' +
          offerHTML('Every row, sorted by edge vs fair, with sport, market and book filters.') + '</div></div>';
      }
      el.innerHTML = top + list + (b.truncated ? '<p class="note">The Board shows its first rows only; use the filters to see the rest.</p>' : '');
    }
    function renderLimits() {
      var el = $(host, '[data-fl="limits"]');
      if (el) el.innerHTML = X.BOARD_LIMITS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    }

    /* ── The Leaks ────────────────────────────────────────────────────── */
    function chip(s, big) {
      var lv = C.labelView(s);
      return lv ? '<span class="fl-chip ' + esc(lv.cls) + (big ? ' big' : '') + '">' + esc(lv.chip) + '</span>' : '';
    }
    function numsHTML(s) {
      return '<dl class="fl-nums">' + C.numbersLine(s).map(function (x) { return '<div><dt>' + esc(x.k) + '</dt><dd>' + esc(x.v) + '</dd></div>'; }).join('') + '</dl>';
    }
    function leakCard(s, rules, lead) {
      return '<article class="card fl-leak" data-label="' + esc(s.label || 'small') + '">' + chip(s, true) +
        '<p class="fl-verdict' + (lead ? ' lead' : '') + '">' + esc(C.verdict(s, rules)) + '</p>' + numsHTML(s) + '</article>';
    }
    function sliceRow(s, rules) {
      var x = C.numbersLine(s);
      var v = function (k) { for (var i = 0; i < x.length; i++) if (x[i].k === k) return x[i].v; return '—'; };
      return '<div class="fl-slice" data-dim="' + esc(s.dim) + '" data-val="' + esc(s.val) + '" data-label="' + esc(s.label || 'small') + '">' +
        '<div class="fl-sname"><b>' + esc(C.sliceName(s.dim, s.val, rules)) + '</b>' + chip(s) + '</div>' +
        '<div class="fl-sn"><span class="k">Bets</span>' + esc(v('Bets')) + '</div>' +
        '<div class="fl-sn"><span class="k">Record</span>' + esc(v('Record')) + '</div>' +
        '<div class="fl-sn"><span class="k">Dollars</span>' + esc(v('Dollars')) + '</div>' +
        '<div class="fl-sn"><span class="k">Units</span>' + esc(v('Units')) + '</div>' +
        '<div class="fl-sn"><span class="k">ROI</span>' + esc(v('ROI')) + '</div>' +
        '<div class="fl-sn"><span class="k">Avg CLV</span>' + esc(v('Avg CLV')) + '</div>' +
        '<div class="fl-sn"><span class="k">Beat close</span>' + esc(v('Beat close')) + '</div>' +
      '</div>';
    }
    function legendHTML(rules) {
      return '<ul class="fl-legend">' + ['real_leak', 'bad_luck', 'running_hot', 'real_edge', 'losing'].map(function (k) {
        var L = C.LABELS[k];
        return '<li><span class="fl-chip ' + esc(L.cls) + '">' + esc(L.chip) + '</span> ' + esc(L.about) + '</li>';
      }).join('') + '<li><span class="fl-chip small">Small sample</span> Fewer than ' + esc(String((rules && rules.min_sample_bets) || '')) +
        ' settled bets: no label at all.</li></ul>';
    }
    function renderLeaks() {
      var el = $(host, '[data-fl="leaks-body"]');
      if (!el) return;
      if (S.leaksError) { el.innerHTML = '<div class="gm-empty">Your leaks could not be loaded. Reload to try again.</div>'; return; }
      var L = S.leaks;
      if (!L) { el.innerHTML = '<div class="gm-empty">Reading your bets…</div>'; return; }
      var rules = L.rules || {};
      if (!L.paid) {
        el.innerHTML = '<article class="card fl-teaser" data-fl="teaser"><p class="fl-verdict lead">' + esc(C.teaserLine(L.teaser, rules)) + '</p>' +
          '<div class="fl-locked"><div class="fl-blur" aria-hidden="true"><dl class="fl-nums"><div><dt>Bets</dt><dd>00</dd></div><div><dt>Record</dt><dd>00–00</dd></div>' +
          '<div><dt>Dollars</dt><dd>−$000</dd></div><div><dt>ROI</dt><dd>−00.0%</dd></div><div><dt>Avg CLV</dt><dd>−0.00%</dd></div></dl></div>' +
          '<div class="fl-lock-over"><b>The numbers behind it</b>' + offerHTML('Every slice of your bets: P/L, ROI, CLV and the beat-close rate, and which losses are leaks and which are luck.') +
          '</div></div></article>';
        return;
      }
      var cn = L.counts || {};
      if (!cn.bets) {
        el.innerHTML = '<div class="gm-empty"><b>No bets yet.</b> Log bets in <a href="/bet-checker/">Bet Checker</a>, or import them into your Portfolio (Juice Reel, a CSV, a screenshot), and The Leaks reads them here.</div>' + legendHTML(rules);
        return;
      }
      var h = '<p class="fl-counts">' + esc(cn.bets + ' bets: ' + (cn.bet_checker + cn.both) + ' from Bet Checker, ' + (cn.portfolio + cn.both) + ' from your Portfolio' +
        (cn.both ? ', ' + cn.both + ' in both (counted once)' : '') + '. ' + cn.settled + ' settled, ' + cn.with_clv + ' with a captured close.') + '</p>';
      var top = L.top_leaks || [];
      h += '<h3 class="fl-h3">Your biggest leaks</h3>';
      h += top.length ? '<div class="fl-leaks" data-fl="top">' + top.map(function (s, i) { return leakCard(s, rules, i === 0); }).join('') + '</div>'
        : '<div class="gm-empty" data-fl="top">No real leak: no slice with ' + esc(String(rules.min_sample_bets)) + ' or more settled bets is losing money while the close beats you.</div>';
      if (L.overall) h += '<h3 class="fl-h3">All your bets</h3>' + leakCard(L.overall, rules, false);
      var slices = L.slices || [];
      C.DIMS.forEach(function (d) {
        var mine = slices.filter(function (s) { return s.dim === d.key; });
        if (!mine.length) return;
        h += '<section class="fl-dim" data-fl-dim="' + esc(d.key) + '"><h3 class="fl-h3">' + esc(d.label) + '</h3>' +
          '<div class="fl-slices">' + mine.map(function (s) { return sliceRow(s, rules); }).join('') + '</div></section>';
      });
      h += '<h3 class="fl-h3">What the labels mean</h3>' + legendHTML(rules);
      if (cn.dollars_from_unit_size) h += '<p class="note">' + esc(cn.dollars_from_unit_size + ' Bet Checker ' + (cn.dollars_from_unit_size === 1 ? 'bet is' : 'bets are') +
        ' shown in dollars at the unit size in your bankroll settings.') + '</p>';
      el.innerHTML = h;
    }

    function renderPlan() {
      var el = $(host, '[data-fl="plan"]');
      if (!el) return;
      var paid = !!((S.board && S.board.paid) || (S.leaks && S.leaks.paid));
      el.textContent = (S.user && S.user.email ? '· ' : '') + (paid ? 'Your plan includes Fairline.' : 'Free: the top of The Board, and where your biggest leak is.');
    }
    function planName() {
      var a = S.acc, P = S.pricing;
      if (!a) return 'Free';
      if (a.has_access) return (P && P.PLAN_NAME ? P.PLAN_NAME : 'EdgeDesk Full Access') + ' (includes Fairline)';
      if (a.fairline_paid) return P && P.FAIRLINE ? P.FAIRLINE.PLAN_NAME : 'Fairline';
      if (a.bet_checker_paid) return (P && P.BET_CHECKER ? P.BET_CHECKER.PLAN_NAME : 'Bet Checker') + ' (Fairline not included)';
      return 'Free';
    }
    function renderSettings() {
      var el = $(host, '[data-fl="settings"]');
      if (!el) return;
      var a = S.acc || {}, P = S.pricing;
      var portal = P && P.portalLink ? P.portalLink() : '';
      var sub = a.subscription || {};
      var paid = !!(a.has_access || a.bet_checker_paid);
      var until = sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
      el.innerHTML = '<p><b>Plan:</b> ' + esc(planName()) + (paid && until ? (sub.cancel_at_period_end ? ' \u2014 ends ' : ' \u2014 renews ') + esc(until) : '') + '</p>' +
        (paid
          ? (portal ? '<p><a class="btn ghost" href="' + esc(portal) + '" target="_blank" rel="noopener" data-fl="portal">Manage billing or cancel</a></p>' : '') +
            '<p class="note">Cancel anytime: cancelling stops every future charge, and access continues to the end of the period you have paid for. ' +
            'Or email <a href="mailto:support@edgedesksports.com">support@edgedesksports.com</a>.</p>' +
            (switcher() ? '<p class="note">Fairline is a plan switch in the billing portal: it replaces Bet Checker, so you are never billed for both.</p>' : '')
          : '<p><button type="button" class="btn" data-fl-act="upgrade">Get Fairline</button></p>') +
        '<p><button type="button" class="btn ghost" data-fl-act="signout">Sign out</button></p>';
    }

    /* ── the upgrade, with the automatic-renewal consent ─────────────── */
    function openUpgrade() {
      var m = $(host, '[data-fl="arl"]'); if (!m) return;
      if (S.acc && (S.acc.has_access || S.acc.fairline_paid)) { status('Your plan already includes Fairline.', 'ok'); return; }
      if (switcher()) {
        var portal = S.pricing && S.pricing.portalLink ? S.pricing.portalLink() : '';
        status('Your Bet Checker plan switches to Fairline in the billing portal \u2014 the switch replaces Bet Checker, so you are never billed for both.' +
          (portal ? ' <a href="' + esc(portal) + '" target="_blank" rel="noopener">Switch to Fairline</a>' : ''), 'ok');
        return;
      }
      setPlan(S.plan);
      var feats = $(host, '[data-fl="features"]');
      if (feats && S.pricing && S.pricing.FAIRLINE) feats.innerHTML = S.pricing.FAIRLINE.FEATURES.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('');
      m.hidden = false;
      var cb = $(host, '[data-fl="agree"]'); if (cb) cb.checked = false;
      var go = $(host, '[data-fl="arl-go"]'); if (go) go.disabled = true;
      $(host, '[data-fl="arl-msg"]').textContent = '';
    }
    function setPlan(plan) {
      S.plan = plan === 'annual' ? 'annual' : 'monthly';
      var P = S.pricing; if (!P || !P.fairlineTerms) return;
      var off = P.fairlineOffer(S.plan);
      $(host, '[data-fl="terms"]').textContent = P.fairlineTerms(S.plan);
      $(host, '[data-fl="arl-go"]').textContent = 'Subscribe \u2014 ' + off.short;
      Array.prototype.forEach.call(host.querySelectorAll('[data-fl-plan]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-fl-plan') === S.plan); b.setAttribute('aria-pressed', String(b.getAttribute('data-fl-plan') === S.plan));
      });
    }
    async function confirmUpgrade() {
      var P = S.pricing, msg = $(host, '[data-fl="arl-msg"]'), go = $(host, '[data-fl="arl-go"]');
      if (!$(host, '[data-fl="agree"]').checked) { msg.textContent = 'Please confirm the automatic renewal terms to continue.'; return; }
      if (!P || !P.fairlineOffer || !S.access || !S.access.startCheckout) { msg.textContent = 'Checkout is being updated, so we stopped before recording anything or taking any payment. Nothing has been charged.'; return; }
      var off = P.fairlineOffer(S.plan);
      var terms = $(host, '[data-fl="terms"]').textContent;
      go.disabled = true; msg.textContent = 'Opening secure checkout\u2026';
      /* the server creates the checkout; it refuses a price that is not off.price_cents */
      var co = await S.access.startCheckout(accessCfg(), { kind: 'fairline', plan: off.plan, price_cents: off.price_cents,
        trial_days: 0, consent_version: off.consent_version });
      if (!co.ok) {
        go.disabled = false;
        msg.innerHTML = esc(co.message || 'Checkout could not be started.') + ' <b>Nothing has been charged.</b>' + (co.ref ? ' <span class="fl-ref">Ref ' + esc(co.ref) + '</span>' : '');
        if (co.reason === 'already_entitled' || co.reason === 'switch_plan') await loadAccess();
        return;
      }
      /* NO RECORD, NO CHECKOUT: the terms as shown, before Stripe */
      var u = S.social && S.social.user();
      var t = await token();
      var ok = false;
      try {
        var r = await S.fetch(S.url + '/rest/v1/billing_consents', { method: 'POST',
          headers: { apikey: S.key, authorization: 'Bearer ' + t, 'content-type': 'application/json', prefer: 'return=minimal' },
          body: JSON.stringify([{ user_id: u && u.id, user_email: (u && u.email) || null, price_display: off.price_display,
            billing_period: off.billing_period, trial_days: 0, offer_text: terms, consent_version: off.consent_version,
            user_agent: String((root.navigator && root.navigator.userAgent) || '').slice(0, 300) }]) });
        ok = r.ok;
      } catch (_) { ok = false; }
      if (!ok) {
        go.disabled = false;
        msg.innerHTML = 'We could not record your renewal consent, so we stopped before taking any payment. <b>Nothing has been charged.</b> Try again, or email <a href="mailto:support@edgedesksports.com">support@edgedesksports.com</a>.';
        return;
      }
      S.location.href = co.url;
    }

    /* back from Stripe: ask the SERVER, a bounded number of times */
    async function checkoutReturn() {
      var q; try { q = new URLSearchParams(S.location.search); } catch (_) { return; }
      var c = q.get('checkout'); if (!c) return;
      try { S.history.replaceState(null, '', S.location.pathname); } catch (_) { /* cosmetic */ }
      if (c === 'cancel') { status('Checkout cancelled. Nothing was charged.', 'ok'); return; }
      if (c !== 'success' || !S.access || !S.access.finalize) return;
      status('Payment received. Confirming Fairline with Stripe\u2026', 'ok');
      var f = await S.access.finalize(accessCfg(), { sessionId: q.get('session_id') || undefined,
        until: function (a) { return !!(a && a.fairline_paid); } });
      if (f.state === 'active') { status('<b>Fairline is on.</b> The whole Board and every leak are below.', 'ok'); await load(); }
      else status('Stripe has not confirmed your payment yet. This usually takes a minute \u2014 reload this page shortly. Nothing is lost.' + (f.ref ? ' <span class="fl-ref">Ref ' + esc(f.ref) + '</span>' : ''), 'warn');
    }
    function setTab(t) {
      S.tab = t === 'leaks' ? 'leaks' : 'board';
      Array.prototype.forEach.call(host.querySelectorAll('[data-fl-tab]'), function (b) {
        var on = b.getAttribute('data-fl-tab') === S.tab;
        b.setAttribute('aria-selected', String(on)); b.classList.toggle('on', on);
      });
      var bd = $(host, '[data-fl="board"]'), lk = $(host, '[data-fl="leaks"]');
      if (bd) bd.hidden = S.tab !== 'board';
      if (lk) lk.hidden = S.tab !== 'leaks';
    }
    function renderAll() { renderPlan(); renderBoard(); renderLeaks(); renderLimits(); renderSettings(); }

    /* ── loading ──────────────────────────────────────────────────────── */
    function boardArgs() {
      return { p_sport: S.filters.sport || null, p_market: S.filters.market || null, p_book: S.filters.book || null };
    }
    async function loadBoard() {
      try {
        S.board = await rpc('fairline_board', boardArgs()); S.boardError = false;
        if (S.board && S.board.facets && !S.filters.sport && !S.filters.market && !S.filters.book) S.facets = S.board.facets;
      }
      catch (e) { if (e.status === 401) throw e; S.board = null; S.boardError = true; }
    }
    async function loadLeaks() {
      try { S.leaks = await rpc('fairline_leaks', {}); S.leaksError = false; }
      catch (e) { if (e.status === 401) throw e; S.leaks = null; S.leaksError = true; }
    }
    async function loadAccess() {
      if (!S.access || !S.access.read) return;
      var a = await S.access.read(accessCfg());
      if (a && a.ok) S.acc = a.access;
    }
    async function load() {
      try {
        await Promise.all([loadAccess().catch(function () { return null; }), loadBoard(), loadLeaks()]);
      } catch (e) {
        if (e && e.status === 401) { showSignedOut('Your session ended. Sign in again.'); return; }
      }
      renderAll();
    }
    function showSignedOut(note) {
      $(host, '[data-fl="in"]').hidden = true;
      $(host, '[data-fl="out"]').hidden = false;
      if (note) status(note, 'ok');
    }
    async function onAuth(mode) {
      var f = $(host, 'form[data-fl="auth"]'); if (!f) return;
      var msg = $(host, '[data-fl="auth-msg"]');
      msg.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing in…';
      var r = mode === 'signup'
        ? await S.auth.save(f.elements.email.value, f.elements.password.value, f.elements.consent.checked)
        : await S.auth.signIn(f.elements.email.value, f.elements.password.value);
      if (!r.ok) { msg.textContent = r.message || 'That did not work. Try again.'; return; }
      if (r.confirm) { msg.textContent = 'Check your email to confirm your account. The link brings you back here.'; return; }
      msg.textContent = '';
      await start();
    }
    async function start() {
      var signed = S.social && S.social.user();
      if (!signed) { try { if (S.auth && S.auth.ensure && await S.auth.ensure()) signed = S.social.user(); } catch (_) { /* stays signed out */ } }
      if (!signed) { showSignedOut(); return; }
      S.user = signed;
      $(host, '[data-fl="out"]').hidden = true;
      $(host, '[data-fl="in"]').hidden = false;
      var who = $(host, '[data-fl="who"]'); if (who) who.textContent = signed.email ? 'Signed in as ' + signed.email : '';
      var h = S.location && S.location.hash ? String(S.location.hash).replace('#', '') : '';
      setTab(h === 'leaks' ? 'leaks' : 'board');
      renderAll();
      await load();
      await checkoutReturn();
    }

    /* ── wiring ───────────────────────────────────────────────────────── */
    function bind() {
      host.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-fl-tab],[data-fl-act],[data-fl-plan]') : null;
        if (!t) return;
        if (t.hasAttribute('data-fl-tab')) { if (!t.disabled) setTab(t.getAttribute('data-fl-tab')); return; }
        if (t.hasAttribute('data-fl-plan')) { setPlan(t.getAttribute('data-fl-plan')); return; }
        var act = t.getAttribute('data-fl-act');
        if (act === 'upgrade') openUpgrade();
        else if (act === 'arl-close') $(host, '[data-fl="arl"]').hidden = true;
        else if (act === 'arl-go') confirmUpgrade();
        else if (act === 'signin') onAuth('signin');
        else if (act === 'signup') onAuth('signup');
        else if (act === 'recover') {
          var f = $(host, 'form[data-fl="auth"]');
          S.auth.recover(f.elements.email.value).then(function (r) { $(host, '[data-fl="auth-msg"]').textContent = r.ok ? 'Check your email for a link to reset your password.' : r.message; });
        }
        else if (act === 'signout') { S.auth.signOut().then(function () { S.board = null; S.leaks = null; showSignedOut('Signed out.'); }); }
      });
      host.addEventListener('change', function (e) {
        if (e.target.getAttribute && e.target.getAttribute('data-fl') === 'agree') { $(host, '[data-fl="arl-go"]').disabled = !e.target.checked; return; }
        var f = e.target && e.target.form;
        if (!f || f.getAttribute('data-fl') !== 'filters') return;
        S.filters = { sport: f.elements.sport.value, market: f.elements.market.value, book: f.elements.book.value };
        loadBoard().then(renderBoard).catch(function () { showSignedOut('Your session ended. Sign in again.'); });
      });
    }

    return { S: S, bind: bind, start: start, load: load, setTab: setTab, renderAll: renderAll, rowHTML: rowHTML, leakCard: leakCard,
             openUpgrade: openUpgrade, confirmUpgrade: confirmUpgrade, offerHTML: offerHTML };
  }

  X.mount = function (host, opts) {
    var page = make(host, opts);
    page.bind();
    var S = page.S;
    if (S.auth && S.auth.configure) S.auth.configure(S.url, S.key, { returnPath: '/fairline/', surface: 'fairline' });
    if (S.social && S.social.configure) S.social.configure(S.url, S.key);
    var consumed = S.edauth && S.edauth.consume ? S.edauth.consume({ url: S.url, key: S.key }) : Promise.resolve(null);
    Promise.resolve(consumed).catch(function () { return null; }).then(function (c) {
      if (c && c.handled && !c.ok && c.message) {
        var el = host.querySelector('[data-fl="status"]'); if (el) { el.hidden = false; el.className = 'fl-status err'; el.textContent = c.message; }
      }
      return page.start();
    });
    return page;
  };
  X._make = make;
  return X;
}));
