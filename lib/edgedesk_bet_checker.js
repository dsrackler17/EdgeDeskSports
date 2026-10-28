/* ===========================================================================
   EdgeDesk BET CHECKER — the page (bet-checker/index.html).
   docs/bet-checker.md

   Log a bet you already placed; see, at once, how your price compared with
   EdgeDesk's fair price; see, after the close, whether you beat it. No picks.

   WHO CAN USE IT. Any signed-in account — including a free one, and a Bet
   Checker (tier red) subscriber, neither of whom can open the research
   terminal. So this is its own page, with its own sign-in: the Games door
   (games/lib/auth.js, configured to come back here), the same session the
   terminal keeps.

   WHAT IT ASKS, AND WHERE
     bet_checker_games / bet_checker_lines   the board: games not started, and
                                             the lines EdgeDesk carries for one
     log_user_bet (edge function)            log + the instant grade
     my_bet_checker_bets                     the reader's cards (free: 30 days)
     my_bet_checker_stats                    paid only; free gets {paid:false}
     my_billing_access                       the plan (lib/edgedesk_access.js)
     create_checkout_session                 Bet Checker checkout, after the
                                             automatic-renewal consent below
   The landing page's "Get Bet Checker" arrives as ?upgrade=monthly|annual:
   after sign-in that OPENS the consent sheet on that plan (takeIntent).
   Every grade, every threshold and every paid gate is the database's
   (supabase/bet_checker.sql, has_bet_checker_paid). The page shows answers.

   THE CONSENT (California automatic-renewal law), exactly as the landing page
   does it (index.html confirmArl): the terms are the words
   lib/edgedesk_pricing.js betCheckerTerms() writes; the box must be ticked;
   the server checkout is created (it refuses a price that is not the figure
   shown); the terms AS SHOWN are recorded in billing_consents; only then does
   the browser go to Stripe. No record, no checkout.

   Browser: window.EDBetChecker.mount(host, { url, key }).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDBetChecker = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var C = root.EDBetCheckerCore || (typeof require === 'function' ? require('./edgedesk_bet_checker_core.js') : null);
  var X = { VERSION: 'edgedesk_bet_checker/1' };

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

  /* ── the state of one mounted page ───────────────────────────────────── */
  function make(host, opts) {
    var o = opts || {};
    var S = {
      host: host, url: String(o.url || '').replace(/\/+$/, ''), key: o.key || '',
      auth: o.auth || root.EDGamesAuth, social: o.social || root.EDGamesSocial,
      access: o.access || root.EDAccess, pricing: o.pricing || root.EDPricing, edauth: o.edauth || root.EDAuth,
      fetch: o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(root) : null),
      location: o.location || root.location, history: o.history || root.history,
      user: null, acc: null, usage: null, bets: [], olderHidden: false, historyDays: null,
      stats: null, rules: null, games: [], boardError: false, lines: [], sport: 'all', plan: 'monthly', ref: null, intent: null
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
    async function fn(name, body) {
      var t = await token();
      if (!t) return { status: 401, body: { ok: false, reason: 'sign_in_required', message: 'Sign in to log a bet.' } };
      try {
        var r = await S.fetch(S.url + '/functions/v1/' + name, { method: 'POST',
          headers: { apikey: S.key, authorization: 'Bearer ' + t, 'content-type': 'application/json' },
          body: JSON.stringify(body || {}) });
        var j = null; try { j = await r.json(); } catch (_) { j = null; }
        return { status: r.status, body: j || { ok: false, message: 'Bet Checker could not be reached. Nothing was saved; try again.' } };
      } catch (_) {
        return { status: 0, body: { ok: false, reason: 'unavailable', message: 'Bet Checker could not be reached. Nothing was saved; try again.' } };
      }
    }
    function accessCfg() { return { url: S.url, key: S.key, token: token, fetch: S.fetch }; }

    /* ── rendering ────────────────────────────────────────────────────── */
    function status(msg, kind) {
      var el = $(host, '[data-bc="status"]');
      if (!el) return;
      el.hidden = !msg;
      el.className = 'bc-status' + (kind ? ' ' + kind : '');
      el.innerHTML = msg || '';
    }

    function cardHTML(b, fresh) {
      var g = C.gradeView(b), cl = C.closeView(b), rs = C.resultView(b);
      var started = b.kickoff && Date.parse(b.kickoff) <= Date.now();
      var units = C.num(b.stake_units);
      return '<article class="gm-card bc-card' + (fresh ? ' bc-fresh' : '') + '" data-grade="' + esc(g.cls) + '" data-id="' + esc(b.id) + '">' +
        '<div class="gm-ctop"><span class="gm-lg">' + esc([b.sport, (b.market || '').replace(/^./, function (c) { return c.toUpperCase(); }), b.book].filter(Boolean).join(' · ')) + '</span>' +
          '<span class="gm-st ' + (started ? 'final' : 'sched') + '">' + esc(when(b.kickoff)) + '</span></div>' +
        '<div class="bc-title">' + esc(C.betTitle(b)) + '</div>' +
        '<div class="bc-pick"><b>' + esc(C.sideLabel(b)) + '</b><span class="bc-odds">' + esc(C.fmtOdds(b.odds)) + '</span>' +
          (units != null ? '<span class="bc-units">' + esc(units) + 'u</span>' : '') + '</div>' +
        '<div class="bc-row"><span class="bc-chip ' + esc(g.cls) + '">' + esc(g.label) + '</span>' +
          (g.edge ? '<span class="bc-edge">' + esc(g.edge) + ' · fair ' + esc(g.fair) + '</span>' : '') + '</div>' +
        '<p class="bc-why">' + esc(g.sentence) + '</p>' +
        '<div class="bc-row"><span class="bc-chip clv ' + esc(cl.cls) + '">' + esc(cl.label) + '</span></div>' +
        '<p class="bc-why">' + esc(cl.sentence) + '</p>' +
        '<div class="bc-row"><span class="bc-res ' + esc(rs.cls) + '">' + esc(rs.label) +
          (rs.units != null && rs.cls !== 'pending' ? ' ' + esc((rs.units > 0 ? '+' : rs.units < 0 ? '−' : '') + Math.abs(rs.units).toFixed(2) + 'u') : '') + '</span>' +
          (b.edgedesk_flagged ? '<span class="bc-flag">EdgeDesk had this flagged</span>' : '') +
          (b.status === 'void' ? '<span class="bc-chip ungraded">Voided</span>' : '') + '</div>' +
      '</article>';
    }

    function renderBets() {
      var el = $(host, '[data-bc="bets"]');
      if (!el) return;
      if (!S.bets.length) {
        el.innerHTML = '<div class="gm-empty"><b>No bets logged yet.</b> Log one above: you get its grade at once, and its CLV after the close.</div>';
      } else {
        el.innerHTML = '<div class="bc-cards">' + S.bets.map(function (b, i) { return cardHTML(b, i === 0 && S.freshId === b.id); }).join('') + '</div>';
      }
      var more = $(host, '[data-bc="older"]');
      if (more) {
        more.hidden = !S.olderHidden;
        more.innerHTML = S.olderHidden ? 'Bets older than ' + esc(S.historyDays) + ' days are kept, not shown. <button type="button" class="bc-link" data-bc-act="upgrade">Bet Checker shows your full history</button>.' : '';
      }
    }

    function kpi(k, v, s) { return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>' + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>'; }
    function splitTable(title, rows) {
      if (!rows || !rows.length) return '';
      return '<h3 class="bc-h3">' + esc(title) + '</h3><div class="tblwrap"><table class="tbl bc-tbl"><thead><tr><th></th><th>Bets</th><th>Graded</th><th>CLV rate</th><th>Avg edge</th><th>Avg CLV</th></tr></thead><tbody>' +
        rows.map(function (r) { var x = C.statRow(r); return '<tr><td>' + esc(x.label) + '</td><td class="n">' + x.bets + '</td><td class="n">' + x.graded +
          '</td><td class="n">' + esc(x.clv_rate) + '</td><td class="n">' + esc(x.avg_edge) + '</td><td class="n">' + esc(x.avg_clv) + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    }
    function renderStats() {
      var el = $(host, '[data-bc="stats"]');
      if (!el) return;
      if (S.stats && S.stats.paid) {
        var ov = S.stats.overall || {};
        var x = C.statRow(Object.assign({ val: 'all' }, ov));
        el.innerHTML = '<div class="bc-kpis">' +
          kpi('CLV rate', x.clv_rate, (ov.beat_close || 0) + ' of ' + (ov.clv_bets || 0) + ' closes beaten') +
          kpi('Avg entry edge', x.avg_edge, 'vs EdgeDesk fair') +
          kpi('Avg CLV', x.avg_clv, 'at the captured close') +
          kpi('Bets graded', String(ov.graded || 0), (ov.bets || 0) + ' logged · ' + (ov.no_close || 0) + ' no close') + '</div>' +
          splitTable('By market', S.stats.by_market) + splitTable('By sport', S.stats.by_sport) + splitTable('By book', S.stats.by_book);
        return;
      }
      /* free: the SHAPE of the stats, with made-up placeholder figures under a
         blur — the server sent no number, so there is nothing real to reveal */
      var off = S.pricing && S.pricing.betCheckerOffer ? S.pricing.betCheckerOffer('monthly') : null;
      el.innerHTML = '<div class="bc-locked"><div class="bc-blur" aria-hidden="true"><div class="bc-kpis">' +
        kpi('CLV rate', '00%', '00 of 00 closes beaten') + kpi('Avg entry edge', '+0.00 pts', 'vs EdgeDesk fair') +
        kpi('Avg CLV', '+0.00%', 'at the captured close') + kpi('Bets graded', '00', '00 logged') + '</div>' +
        '<div class="bc-fake-tbl"></div></div>' +
        '<div class="bc-lock-over"><b>Your running stats</b><span>CLV rate, average edge and CLV, and splits by market, sport and book are part of Bet Checker' +
        (off ? ' — ' + esc(off.short) : '') + '.</span><button type="button" class="btn" data-bc-act="upgrade">Upgrade to Bet Checker</button></div></div>';
    }

    function renderUsage() {
      var el = $(host, '[data-bc="usage"]');
      if (!el) return;
      var u = S.usage;
      if (!u || u.paid) { el.hidden = true; return; }
      var used = Math.min(u.free_grades_used, u.free_limit);
      el.hidden = false;
      el.innerHTML = '<span class="bc-meter" aria-hidden="true"><i style="width:' + Math.round(100 * used / Math.max(1, u.free_limit)) + '%"></i></span>' +
        '<b>' + esc(C.usageLine(u)) + '</b>' + (used >= u.free_limit
          ? ' <span>New bets are saved without a grade until next month. <button type="button" class="bc-link" data-bc-act="upgrade">Upgrade for a grade on every bet</button></span>'
          : '');
    }

    function planName() {
      var a = S.acc;
      if (!a) return 'Free';
      if (a.has_access) return 'EdgeDesk Research Terminal (includes Bet Checker)';
      if (a.bet_checker_paid) return (S.pricing && S.pricing.BET_CHECKER ? S.pricing.BET_CHECKER.PLAN_NAME : 'Bet Checker');
      return 'Free';
    }
    function renderSettings() {
      var el = $(host, '[data-bc="settings"]');
      if (!el) return;
      var a = S.acc || {};
      var portal = S.pricing && S.pricing.portalLink ? S.pricing.portalLink() : '';
      var sub = a.subscription || {};
      var paid = !!(a.has_access || a.bet_checker_paid);
      var until = sub.current_period_end ? new Date(sub.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
      el.innerHTML = '<p><b>Plan:</b> ' + esc(planName()) + (paid && until ? (sub.cancel_at_period_end ? ' — ends ' : ' — renews ') + esc(until) : '') + '</p>' +
        (paid
          ? '<p>' + (portal ? '<a class="btn ghost" href="' + esc(portal) + '" target="_blank" rel="noopener" data-bc="portal">Manage billing or cancel</a>' : '') +
            ' Cancel anytime: cancelling stops every future charge, and access continues to the end of the period you have paid for. ' +
            'Or email <a href="mailto:support@edgedesksports.com">support@edgedesksports.com</a>.</p>' +
            (a.bet_checker_paid && !a.has_access ? '<p class="note">Want the whole research terminal? Switch your plan to the EdgeDesk Research Terminal in the billing portal — it replaces Bet Checker, so you are never billed for both, and Bet Checker stays included.</p>' : '')
          : '<p><button type="button" class="btn" data-bc-act="upgrade">Upgrade to Bet Checker</button></p>') +
        '<p><button type="button" class="btn ghost" data-bc-act="signout">Sign out</button></p>';
    }

    function renderLegend() {
      var el = $(host, '[data-bc="legend"]');
      if (!el) return;
      var L = C.legend(S.rules);
      el.innerHTML = L ? '<li><span class="bc-chip green">Beat fair</span> ' + esc(L.green) + '</li><li><span class="bc-chip yellow">Near fair</span> ' + esc(L.yellow) +
        '</li><li><span class="bc-chip red">Below fair</span> ' + esc(L.red) + '</li>' : '';
    }

    function renderAll() { renderUsage(); renderStats(); renderBets(); renderSettings(); renderLegend(); }

    /* ── the form ─────────────────────────────────────────────────────── */
    function form() { return $(host, 'form[data-bc="form"]'); }
    function field(n) { var f = form(); return f ? f.elements[n] : null; }
    function renderGames() {
      var sel = field('game');
      if (!sel) return;
      var list = S.games.filter(function (g) { return S.sport === 'all' || g.sport === S.sport; });
      sel.innerHTML = '<option value="">' + (S.boardError ? 'EdgeDesk’s board could not be loaded'
        : list.length ? 'Pick a game (' + list.length + ')' : 'No upcoming games on EdgeDesk’s board') + '</option>' +
        list.map(function (g) { return '<option value="' + esc(g.event_id) + '">' + esc(g.away_team + ' at ' + g.home_team + ' · ' + when(g.commence_time)) + '</option>'; }).join('');
      resetFrom('game');
    }
    function resetFrom(step) {
      var f = form(); if (!f) return;
      if (step === 'game') { S.lines = []; f.elements.market.innerHTML = '<option value="">Market</option>'; }
      if (step === 'game' || step === 'market') f.elements.side.innerHTML = '<option value="">Side</option>';
      if (step !== 'side') { f.elements.line.value = ''; f.elements.line.dataset.auto = ''; }
      linesHint();
    }
    function currentGame() { var id = field('game') && field('game').value; for (var i = 0; i < S.games.length; i++) if (S.games[i].event_id === id) return S.games[i]; return null; }
    async function onGame() {
      resetFrom('game');
      var g = currentGame(); if (!g) return;
      try { S.lines = (await rpc('bet_checker_lines', { p_event_id: g.event_id })) || []; }
      catch (_) { S.lines = []; status('The lines for that game could not be loaded. Try again.', 'err'); return; }
      var have = {};
      S.lines.forEach(function (l) { have[l.market_type] = true; });
      field('market').innerHTML = '<option value="">Market</option>' + C.MARKETS.filter(function (m) { return have[m.key]; })
        .map(function (m) { return '<option value="' + m.key + '">' + m.label + '</option>'; }).join('');
    }
    function onMarket() {
      resetFrom('market');
      var g = currentGame(), mk = field('market').value; if (!g || !mk) return;
      var m = C.MARKETS.filter(function (x) { return x.key === mk; })[0];
      field('side').innerHTML = '<option value="">Side</option>' + m.sides.map(function (sd) {
        var label = mk === 'total' ? (sd === 'over' ? 'Over' : 'Under') : (sd === 'home' ? g.home_team : g.away_team);
        return '<option value="' + sd + '">' + esc(label) + '</option>';
      }).join('');
      var lr = $(host, '[data-bc="line-row"]'); if (lr) lr.hidden = mk === 'moneyline';
    }
    function sideLines() {
      var mk = field('market') && field('market').value, sd = field('side') && field('side').value;
      return S.lines.filter(function (l) { return l.market_type === mk && l.side === sd; });
    }
    function onSide() {
      var ls = sideLines(), line = field('line');
      if (!line) return;
      var modal = ls.filter(function (l) { return l.modal && l.line != null; })[0];
      if (modal && (!line.value || line.dataset.auto === '1')) { line.value = modal.line; line.dataset.auto = '1'; }
      linesHint();
    }
    function linesHint() {
      var el = $(host, '[data-bc="lines"]'), dl = $(host, '#bc-lines');
      var ls = sideLines().filter(function (l) { return l.line != null; });
      if (dl) dl.innerHTML = ls.map(function (l) { return '<option value="' + esc(l.line) + '">'; }).join('');
      if (!el) return;
      var mk = field('market') && field('market').value;
      if (!ls.length) { el.textContent = mk === 'moneyline' && sideLines().some(function (l) { return l.priced; }) ? 'EdgeDesk has a current fair price on this moneyline.' : ''; return; }
      var priced = ls.filter(function (l) { return l.priced; }).map(function (l) { return C.fmtLine(mk, l.line) + (l.modal ? ' (main)' : ''); });
      el.textContent = priced.length
        ? 'Graded at: ' + priced.join(', ') + '. Any other line is saved without an entry grade — we never estimate one.'
        : 'EdgeDesk has no current fair price on this side, so a bet here is saved without an entry grade.';
    }
    function onBook() {
      var pm = C.PREDICTION_MARKETS.indexOf(field('book').value) >= 0;
      var el = $(host, '[data-bc="cents-row"]'); if (el) el.hidden = !pm;
    }
    function onCents() {
      var a = C.centsToAmerican(field('cents').value);
      var out = $(host, '[data-bc="cents-out"]');
      if (a != null) { field('odds').value = a > 0 ? '+' + a : String(a); if (out) out.textContent = '= ' + C.fmtOdds(a) + ' American'; }
      else if (out) out.textContent = '';
    }

    async function submit(ev) {
      if (ev) ev.preventDefault();
      var f = form(); if (!f || S.busy) return;
      var v = C.check({ event_id: f.elements.game.value, market: f.elements.market.value, side: f.elements.side.value,
        line: f.elements.line.value, odds: String(f.elements.odds.value).replace(/^\+/, ''), book: f.elements.book.value, stake_units: f.elements.stake.value });
      var res = $(host, '[data-bc="result"]');
      if (!v.ok) { res.hidden = false; res.className = 'bc-result err'; res.textContent = v.message; return; }
      S.busy = true;
      var btn = $(host, '[data-bc="submit"]'); if (btn) { btn.disabled = true; btn.textContent = 'Grading…'; }
      if (!S.clientKey) S.clientKey = C.newClientKey();
      var r = await fn('log_user_bet', Object.assign({ client_key: S.clientKey }, v.bet));
      S.busy = false; if (btn) { btn.disabled = false; btn.textContent = 'Log bet and grade it'; }
      res.hidden = false;
      if (!r.body || !r.body.ok) {
        res.className = 'bc-result err';
        res.textContent = (r.body && r.body.message) || 'That bet could not be logged.';
        if (r.status === 401) showSignedOut();
        return;
      }
      S.clientKey = null;   // the next bet is a new bet; a retry of THIS one reused the key
      var b = r.body.bet, g = C.gradeView(b);
      if (r.body.usage) S.usage = r.body.usage;
      if (r.body.rules) S.rules = Object.assign({}, S.rules || {}, r.body.rules);
      res.className = 'bc-result ' + g.cls;
      res.innerHTML = '<span class="bc-chip big ' + esc(g.cls) + '">' + esc(g.label) + '</span>' +
        (g.edge ? '<b class="bc-edge-big">' + esc(g.edge) + '</b>' : '') + '<p>' + esc(g.sentence) + '</p>' +
        (r.body.upgrade ? '<p><button type="button" class="btn" data-bc-act="upgrade">Upgrade for a grade on every bet</button></p>' : '');
      S.bets = [b].concat(S.bets.filter(function (x) { return x.id !== b.id; }));
      S.freshId = b.id;
      renderAll();
      f.elements.odds.value = ''; f.elements.stake.value = '1';
      if (f.elements.cents) f.elements.cents.value = '';
    }

    /* ── the landing page's door: /bet-checker/?upgrade=monthly|annual ────
       The plan a reader chose is kept in this tab's sessionStorage, so it
       survives the sign-in round trip (the Games door comes back to
       /bet-checker/ with no query), and the query leaves the address so a
       reload does not ask again. Once the reader is signed in and the plan is
       read, a plan that already includes Bet Checker says so; any other
       reader gets the upgrade sheet OPEN on that plan. It only opens it: the
       renewal terms must still be read and ticked. Either way the intent is
       then forgotten. Every storage access is guarded, and without storage
       the link still works for a reader who is already signed in. */
    var INTENT_KEY = 'bc_upgrade_intent';
    function planOf(v) { return v === 'monthly' || v === 'annual' ? v : null; }
    function store() { try { return root.sessionStorage || null; } catch (_) { return null; } }
    function takeIntent() {
      var q = null;
      try { q = new URLSearchParams((S.location && S.location.search) || ''); } catch (_) { q = null; }
      var asked = q ? planOf(q.get('upgrade')) : null;
      if (q && q.has('upgrade')) {
        q.delete('upgrade');
        var rest = q.toString();
        try { S.history.replaceState(null, '', S.location.pathname + (rest ? '?' + rest : '') + (S.location.hash || '')); } catch (_) { /* cosmetic */ }
      }
      if (asked) {
        S.intent = asked;
        try { var st = store(); if (st) st.setItem(INTENT_KEY, asked); } catch (_) { /* kept for this page only */ }
      } else {
        try { var st2 = store(); S.intent = st2 ? planOf(st2.getItem(INTENT_KEY)) : null; } catch (_) { S.intent = null; }
      }
      return S.intent;
    }
    function forgetIntent() {
      S.intent = null;
      try { var st = store(); if (st) st.removeItem(INTENT_KEY); } catch (_) { /* nothing was kept */ }
    }
    function applyIntent() {
      /* signed out, or the plan could not be read: kept for the next load */
      if (!S.intent || !S.acc) return;
      var p = S.intent;
      forgetIntent();
      if (S.acc.has_access || S.acc.bet_checker_paid) { status('Your plan already includes Bet Checker.', 'ok'); return; }
      S.plan = p;
      openUpgrade();
    }
    function intentHint() {
      var el = $(host, '[data-bc="intent"]');
      if (!el) return;
      var off = S.intent && S.pricing && S.pricing.betCheckerOffer ? S.pricing.betCheckerOffer(S.intent) : null;
      el.hidden = !S.intent;
      el.textContent = S.intent ? 'Sign in or create a free account, and Bet Checker’s checkout opens next' +
        (off ? ' (' + off.short + ')' : '') + '. You read the renewal terms before anything is charged.' : '';
    }

    /* ── signing in (the Games door, coming back here) ───────────────── */
    function showSignedOut(note) {
      $(host, '[data-bc="in"]').hidden = true;
      $(host, '[data-bc="out"]').hidden = false;
      intentHint();
      if (note) status(note, 'ok');
    }
    async function onAuth(mode) {
      var f = $(host, 'form[data-bc="auth"]'); if (!f) return;
      var msg = $(host, '[data-bc="auth-msg"]');
      msg.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing in…';
      var r = mode === 'signup'
        ? await S.auth.save(f.elements.email.value, f.elements.password.value, f.elements.consent.checked)
        : await S.auth.signIn(f.elements.email.value, f.elements.password.value);
      if (!r.ok) { msg.textContent = r.message || 'That did not work. Try again.'; return; }
      if (r.confirm) { msg.textContent = 'Check your email to confirm your account. The link brings you back here.'; return; }
      msg.textContent = '';
      await start();
    }

    /* ── the upgrade, with the automatic-renewal consent ─────────────── */
    function openUpgrade() {
      var m = $(host, '[data-bc="arl"]'); if (!m) return;
      if (S.acc && (S.acc.has_access || S.acc.bet_checker_paid)) { status('Your plan already includes Bet Checker.', 'ok'); return; }
      setPlan(S.plan);
      m.hidden = false;
      var cb = $(host, '[data-bc="agree"]'); if (cb) cb.checked = false;
      var go = $(host, '[data-bc="arl-go"]'); if (go) go.disabled = true;
      $(host, '[data-bc="arl-msg"]').textContent = '';
    }
    function setPlan(plan) {
      S.plan = plan === 'annual' ? 'annual' : 'monthly';
      var P = S.pricing; if (!P || !P.betCheckerTerms) return;
      var off = P.betCheckerOffer(S.plan);
      $(host, '[data-bc="terms"]').textContent = P.betCheckerTerms(S.plan);
      $(host, '[data-bc="arl-go"]').textContent = 'Subscribe — ' + off.short;
      Array.prototype.forEach.call(host.querySelectorAll('[data-bc-plan]'), function (b) { b.classList.toggle('on', b.getAttribute('data-bc-plan') === S.plan); b.setAttribute('aria-pressed', String(b.getAttribute('data-bc-plan') === S.plan)); });
    }
    async function confirmUpgrade() {
      var P = S.pricing, msg = $(host, '[data-bc="arl-msg"]'), go = $(host, '[data-bc="arl-go"]');
      if (!$(host, '[data-bc="agree"]').checked) { msg.textContent = 'Please confirm the automatic renewal terms to continue.'; return; }
      if (!P || !P.betCheckerOffer || !S.access || !S.access.startCheckout) { msg.textContent = 'Checkout is being updated, so we stopped before recording anything or taking any payment. Nothing has been charged.'; return; }
      var off = P.betCheckerOffer(S.plan);
      var terms = $(host, '[data-bc="terms"]').textContent;
      go.disabled = true; msg.textContent = 'Opening secure checkout…';
      /* the server creates the checkout; it refuses a price that is not off.price_cents */
      var co = await S.access.startCheckout(accessCfg(), { kind: 'bet_checker', plan: off.plan, price_cents: off.price_cents,
        trial_days: 0, consent_version: off.consent_version });
      if (!co.ok) {
        go.disabled = false;
        msg.innerHTML = esc(co.message || 'Checkout could not be started.') + ' <b>Nothing has been charged.</b>' + (co.ref ? ' <span class="bc-ref">Ref ' + esc(co.ref) + '</span>' : '');
        if (co.reason === 'already_entitled') await loadAccess();
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
      status('Payment received. Confirming Bet Checker with Stripe…', 'ok');
      var f = await S.access.finalize(accessCfg(), { sessionId: q.get('session_id') || undefined,
        until: function (a) { return !!(a && a.bet_checker_paid); } });
      if (f.state === 'active') { status('<b>Bet Checker is on.</b> Every bet gets a grade, and your stats are below.', 'ok'); await load(); }
      else status('Stripe has not confirmed your payment yet. This usually takes a minute — reload this page shortly. Nothing is lost.' + (f.ref ? ' <span class="bc-ref">Ref ' + esc(f.ref) + '</span>' : ''), 'warn');
    }

    /* ── loading ──────────────────────────────────────────────────────── */
    async function loadAccess() {
      if (!S.access || !S.access.read) return;
      var a = await S.access.read(accessCfg());
      if (a.ok) S.acc = a.access;
    }
    async function load() {
      var results = await Promise.all([
        loadAccess().catch(function () { return null; }),
        rpc('my_bet_checker_bets', {}).catch(function (e) { return { error: e }; }),
        rpc('my_bet_checker_stats', {}).catch(function () { return null; }),
        rpc('bet_checker_rules', {}).catch(function () { return null; }),
        rpc('bet_checker_games', {}).catch(function (e) { return { error: e }; })
      ]);
      var bets = results[1], stats = results[2], rules = results[3], games = results[4];
      if (bets && bets.error) {
        if (bets.error.status === 401) { showSignedOut('Your session ended. Sign in again.'); return; }
        status('Your bets could not be loaded. Reload to try again.', 'err');
      } else if (bets) {
        S.bets = bets.bets || []; S.usage = bets.usage || null; S.olderHidden = !!bets.older_hidden; S.historyDays = bets.history_days;
      }
      S.stats = stats; S.rules = rules;
      S.games = games && !games.error ? games : [];
      S.boardError = !!(games && games.error);   // the picker never calls an unread board empty
      if (S.boardError) status('EdgeDesk’s board could not be loaded. Reload to try again.', 'err');
      renderGames(); renderAll();
      var det = $(host, '[data-bc="form-wrap"]'); if (det && !S.bets.length) det.open = true;
    }
    async function start() {
      var signed = S.social && S.social.user();
      if (!signed) { try { if (S.auth && S.auth.ensure && await S.auth.ensure()) signed = S.social.user(); } catch (_) { /* stays signed out */ } }
      if (!signed) { showSignedOut(); return; }
      S.user = signed;
      $(host, '[data-bc="out"]').hidden = true;
      $(host, '[data-bc="in"]').hidden = false;
      var who = $(host, '[data-bc="who"]'); if (who) who.textContent = signed.email ? 'Signed in as ' + signed.email : '';
      await load();
      await checkoutReturn();
      applyIntent();
    }

    /* ── wiring ───────────────────────────────────────────────────────── */
    function bind() {
      host.addEventListener('click', function (e) {
        var t = e.target.closest ? e.target.closest('[data-bc-act],[data-bc-sport],[data-bc-plan]') : null;
        if (!t) return;
        if (t.hasAttribute('data-bc-sport')) {
          S.sport = t.getAttribute('data-bc-sport');
          Array.prototype.forEach.call(host.querySelectorAll('[data-bc-sport]'), function (p) { p.setAttribute('aria-pressed', String(p === t)); });
          renderGames(); return;
        }
        if (t.hasAttribute('data-bc-plan')) { setPlan(t.getAttribute('data-bc-plan')); return; }
        var act = t.getAttribute('data-bc-act');
        if (act === 'upgrade') openUpgrade();
        else if (act === 'arl-close') $(host, '[data-bc="arl"]').hidden = true;
        else if (act === 'arl-go') confirmUpgrade();
        else if (act === 'signin') onAuth('signin');
        else if (act === 'signup') onAuth('signup');
        else if (act === 'recover') {
          var f = $(host, 'form[data-bc="auth"]');
          S.auth.recover(f.elements.email.value).then(function (r) { $(host, '[data-bc="auth-msg"]').textContent = r.ok ? 'Check your email for a link to reset your password.' : r.message; });
        }
        else if (act === 'signout') { S.auth.signOut().then(function () { S.bets = []; showSignedOut('Signed out.'); }); }
      });
      host.addEventListener('change', function (e) {
        var n = e.target && e.target.name;
        if (e.target.getAttribute && e.target.getAttribute('data-bc') === 'agree') { $(host, '[data-bc="arl-go"]').disabled = !e.target.checked; return; }
        if (n === 'game') onGame(); else if (n === 'market') onMarket(); else if (n === 'side') onSide(); else if (n === 'book') onBook();
      });
      host.addEventListener('input', function (e) {
        var n = e.target && e.target.name;
        if (n === 'cents') onCents();
        if (n === 'line') e.target.dataset.auto = '';
        if (n === 'odds' || n === 'line' || n === 'game' || n === 'market' || n === 'side') S.clientKey = null;
      });
      var f = form(); if (f) f.addEventListener('submit', submit);
    }

    return { S: S, bind: bind, start: start, load: load, submit: submit, openUpgrade: openUpgrade, confirmUpgrade: confirmUpgrade,
             cardHTML: cardHTML, renderAll: renderAll, takeIntent: takeIntent, applyIntent: applyIntent };
  }

  X.mount = function (host, opts) {
    var page = make(host, opts);
    page.bind();
    page.takeIntent();
    var S = page.S;
    if (S.auth && S.auth.configure) S.auth.configure(S.url, S.key, { returnPath: '/bet-checker/', surface: 'bet_checker' });
    if (S.social && S.social.configure) S.social.configure(S.url, S.key);
    /* a confirmation link lands here with its session in the address bar */
    var consumed = S.edauth && S.edauth.consume ? S.edauth.consume({ url: S.url, key: S.key }) : Promise.resolve(null);
    Promise.resolve(consumed).catch(function () { return null; }).then(function (c) {
      if (c && c.handled && !c.ok && c.message) {
        var el = host.querySelector('[data-bc="status"]'); if (el) { el.hidden = false; el.className = 'bc-status err'; el.textContent = c.message; }
      }
      return page.start();
    });
    return page;
  };
  X._make = make;
  return X;
}));
