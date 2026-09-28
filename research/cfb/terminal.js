/* EdgeDesk CFB Research Terminal — the page.
   Reads football/cfb_terminal/{board,games,record,brief}.json and renders them.
   Nothing here computes a projection, a probability or a status: those are
   in the research objects. The page only filters, sorts, draws and asks
   lib/cfb_terminal.js questions about objects it already holds. */
(function () {
  'use strict';
  var T = window.EDCfbTerminal;
  var RD = window.EDRead || null;
  var DATA = '/football/cfb_terminal/';
  /* ?asof=ISO pins the Read's clock (review and demo builds); otherwise every read is re-priced at the reader's own clock,
     so a quote that has aged past the freshness rule stops being a price the moment it does */
  var ASOF = (function () { var m = /[?&]asof=([^&#]+)/.exec(location.search); var t = m ? Date.parse(decodeURIComponent(m[1])) : NaN; return isFinite(t) ? t : null; })();
  function nowMs() { return ASOF != null ? ASOF : Date.now(); }
  var S = { board: null, games: null, record: null, brief: null, filters: [], readFilters: [], status: null, sort: 'queue', recFilters: [], recPage: 1 };
  var cache = {};
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function pct(p, dp) { return num(p) ? (100 * p).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function pp(x) { return num(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + ' pp' : '—'; }
  function f1(x) { return num(x) ? x.toFixed(1) : '—'; }
  function bk(v) { return T.format.bookText(v); }
  function when(t) {
    if (!t) return '—';
    var d = new Date(t);
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ago(t) {
    if (!t) return '—';
    var m = Math.round((Date.now() - Date.parse(t)) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  /* ---------------------------------------------------------- storage */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };
  var KW = 'edcfb_watch_v1', KB = 'edcfb_books_v1', KE = 'edcfb_events_v1', KV = 'edcfb_vid', KRV = 'edcfb_read_view_v1';

  /* ---------------------------------------------------------- analytics
     UX analytics only: which pages and sections people use. It is stored
     in the reader's browser and, when the table exists, sent insert-only to
     cfb_terminal_events (supabase/cfb_terminal_analytics.sql). No model
     build reads it — engagement never changes a projection. */
  var SB = 'https://iattxbkbufslbauoumga.supabase.co';
  var SBK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';
  function vid() { var v = store.get(KV, null); if (!v) { v = 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set(KV, v); } return v; }
  var sent = 0;
  function track(ev, props) {
    if (T.ANALYTICS_EVENTS.indexOf(ev) < 0) return;
    props = props || {};
    var row = { e: ev, g: props.game_id || null, s: props.section || null, d: props.detail || null, t: new Date().toISOString() };
    var q = store.get(KE, []); q.push(row); store.set(KE, q.slice(-500));
    if (sent > 60 || location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
    sent++;
    try {
      fetch(SB + '/rest/v1/rpc/cfb_terminal_track', { method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json', apikey: SBK, authorization: 'Bearer ' + SBK },
        body: JSON.stringify({ p_visitor: vid(), p_event: ev, p_game_id: row.g, p_section: row.s, p_detail: row.d ? String(row.d).slice(0, 120) : null })
      }).catch(function () {});
    } catch (e) { /* analytics never breaks the page */ }
  }

  /* ---------------------------------------------------------- data */
  function load(name) {
    if (cache[name]) return cache[name];
    cache[name] = fetch(DATA + name + '.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(name + '.json ' + r.status);
      return r.json();
    });
    return cache[name];
  }

  /* ---------------------------------------------------------- tooltip */
  var tip = $('tip');
  document.addEventListener('mousemove', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) { tip.style.display = 'none'; return; }
    tip.innerHTML = t.getAttribute('data-tip');
    tip.style.display = 'block';
    var x = e.clientX + 14, y = e.clientY + 14, w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });

  /* ---------------------------------------------------------- chips */
  var TONE = { BET: 'bet', RESEARCH: 'research', WAIT: 'wait', INVESTIGATE: 'investigate', PASS: 'pass', DATA_FAULT: 'fault', NO_MARKET: 'nomarket' };
  function stChip(key, label) { return '<span class="st ' + (TONE[key] || 'pass') + '" title="' + esc((T.STATUS[key] || {}).means || '') + '"><i></i>' + esc(label || (T.STATUS[key] || {}).label || key) + '</span>'; }
  function vBadge() { return '<span class="vbadge" title="' + esc(T.TERMS.VERIFIED_DISAGREEMENT) + '">★ VERIFIED MAJOR DISAGREEMENT</span>'; }

  /* ---------------------------------------------------------- trust panel */
  function renderTrust(b) {
    if (!b) { $('trust').innerHTML = ''; return; }
    var w = (b.warnings || []);
    $('trust').innerHTML =
      '<span><b>Model</b> ' + esc(b.champion.label || '') + ' ' + esc(b.champion.model_version) + '</span>'
      + '<span><b>Built</b> ' + esc(ago(b.generated_at)) + '</span>'
      + '<span><b>Decision policy</b> ' + esc(b.decision.policy) + ' · betting ' + (b.decision.bet_enabled ? 'ON' : 'OFF') + '</span>'
      + '<span><b>Operations</b> ' + esc(b.operations ? b.operations.status : 'unknown') + '</span>'
      + (w.length ? '<span class="warnchip" data-tip="' + esc(w.join('<br>')) + '">⚠ ' + w.length + ' warning' + (w.length === 1 ? '' : 's') + '</span>' : '');
  }

  /* ---------------------------------------------------------- router */
  function route() {
    var h = location.hash || '#/';
    var m = h.match(/^#\/game\/([^/?]+)/);
    var r = m ? 'game' : (h.replace(/^#\//, '').split(/[/?]/)[0] || 'queue');
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) { a.classList.toggle('on', a.getAttribute('data-r') === r); });
    window.scrollTo(0, 0);
    load('board').then(function (b) {
      S.board = b; renderTrust(b);
      if (r === 'game') return renderGame(decodeURIComponent(m[1]));
      if (r === 'brief') return renderBrief();
      if (r === 'watch') return renderWatch();
      if (r === 'record') return renderRecord();
      if (r === 'read') return renderReadRecord();
      if (r === 'why') return renderWhy();
      if (r === 'terms') return renderTerms();
      return renderQueue();
    }).catch(function (e) {
      $('view').innerHTML = '<div class="banner warn"><b>The research artifacts could not be loaded.</b> ' + esc(e.message) + '. Nothing is shown rather than a stale or partial board.</div>';
    });
  }
  window.addEventListener('hashchange', route);

  /* ================================================================ QUEUE */
  var SORTS = { queue: 'Research queue (default)', read: 'Cleanest price first', kickoff: 'Kickoff', gap: 'Raw gap (secondary)', uncertain: 'Most uncertain' };
  /* the Read's queue order: price quality, never the raw gap (an unverified 20-point gap never outranks a clean 4-point price) */
  function readRank(r) {
    var x = r.read; if (!x) return -99;
    var s0 = { BET_EARLY: 60, BET: 55, RESEARCH: 40, WAIT: 30, PRICE_TARGET: 25, PRICE_GONE: 10, PASS: 5, INVESTIGATE: -20, NO_DECISION: -30 }[x.timing] || 0;
    if (x.flags && x.flags.cleanest_price) s0 += 30;
    if (x.flags && x.flags.fresh_market) s0 += 5;
    return s0 + (typeof x.ev === 'number' ? Math.max(-5, Math.min(5, x.ev * 20)) : 0);
  }
  function renderQueue() {
    track('board_view');
    var b = S.board, rows = b.rows.slice();
    var watch = store.get(KW, {});
    if (S.status) rows = rows.filter(function (r) { return r.status === S.status; });
    S.filters.forEach(function (k) { rows = rows.filter(function (r) { return r.flags && r.flags[k]; }); });
    S.readFilters.forEach(function (k) { rows = rows.filter(function (r) { return r.read && r.read.flags && r.read.flags[k]; }); });
    if (S.sort === 'read') rows.sort(function (a, c) { return readRank(c) - readRank(a); });
    else if (S.sort === 'kickoff') rows.sort(function (a, c) { return Date.parse(a.kickoff) - Date.parse(c.kickoff); });
    else if (S.sort === 'gap') rows.sort(function (a, c) { return (c.gap || 0) - (a.gap || 0); });
    else if (S.sort === 'uncertain') rows.sort(function (a, c) { return c.uncertainty - a.uncertainty; });
    var c = b.counts;
    var h = '';
    if (!c.BET) h += '<div class="banner"><b>No certified bets on this slate.</b> ' + esc(b.decision.calibrated_ev_note || 'The decision engine certifies none today.')
      + ' That is a normal answer. The research below is ranked by how worth opening each game is — never by edge size alone.</div>';
    h += '<div class="counts">' + T.STATUS_KEYS.map(function (k) {
      return '<button class="cnt' + (S.status === k ? ' on' : '') + '" data-st="' + k + '">' + stChip(k) + '<b>' + (c[k] || 0) + '</b></button>';
    }).join('') + (c.verified ? '<span class="cnt">' + vBadge() + '<b>' + c.verified + '</b></span>' : '<span class="cnt" title="' + esc(T.TERMS.VERIFIED_DISAGREEMENT) + '"><span class="mut">Verified major: </span><b>0</b></span>') + '</div>';
    h += '<div class="filters">' + b.filters.map(function (f) {
      return '<button class="fchip' + (S.filters.indexOf(f.key) >= 0 ? ' on' : '') + '" data-f="' + f.key + '">' + esc(f.label) + '<span class="n">' + f.n + '</span></button>';
    }).join('') + '</div>';
    if (b.read_filters && b.read_filters.length) {
      h += '<div class="filters rfil"><span class="flab">EdgeDesk Read</span>' + b.read_filters.map(function (f) {
        return '<button class="fchip' + (S.readFilters.indexOf(f.key) >= 0 ? ' on' : '') + '" data-rf="' + f.key + '">' + esc(f.label) + '<span class="n">' + f.n + '</span></button>';
      }).join('') + '</div>';
    }
    h += '<div class="sortbar">Sort <select id="sort">' + Object.keys(SORTS).map(function (k) { return '<option value="' + k + '"' + (S.sort === k ? ' selected' : '') + '>' + SORTS[k] + '</option>'; }).join('') + '</select>'
      + '<span>' + rows.length + ' of ' + b.rows.length + ' games · week ' + esc(String(b.rows.length ? b.rows[0].week : '—')) + '</span></div>';
    h += '<div class="board">' + (rows.length ? rows.map(function (r) { return rowHTML(r, !!watch[r.game_id]); }).join('') : '<div class="empty">No game matches these filters.</div>') + '</div>';
    $('view').innerHTML = h;
    Array.prototype.forEach.call(document.querySelectorAll('[data-st]'), function (x) { x.onclick = function () { S.status = S.status === x.getAttribute('data-st') ? null : x.getAttribute('data-st'); track('filter_apply', { detail: 'status:' + S.status }); renderQueue(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-rf]'), function (x) { x.onclick = function () { var k = x.getAttribute('data-rf'), i = S.readFilters.indexOf(k); if (i >= 0) S.readFilters.splice(i, 1); else S.readFilters.push(k); track('filter_apply', { detail: 'read:' + k }); renderQueue(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-f]'), function (x) { x.onclick = function () { var k = x.getAttribute('data-f'), i = S.filters.indexOf(k); if (i >= 0) S.filters.splice(i, 1); else S.filters.push(k); track('filter_apply', { detail: k }); renderQueue(); }; });
    $('sort').onchange = function () { S.sort = this.value; renderQueue(); };
    Array.prototype.forEach.call(document.querySelectorAll('.rh'), function (x) { x.onclick = function (e) { if (e.target.closest('.star')) return; x.parentNode.classList.toggle('open'); }; });
    bindStars();
  }
  function rowHTML(r, watched) {
    var cls = 'row' + (r.verified ? ' verified' : '') + (r.status === 'INVESTIGATE' ? ' investigate' : '') + ((r.status === 'PASS' || r.status === 'NO_MARKET') ? ' quiet' : '');
    var gap = r.gap == null ? '—' : r.gap.toFixed(1);
    var s = r.summary || {};
    return '<div class="' + cls + '" data-id="' + esc(r.game_id) + '">'
      + '<div class="rh">'
      + '<div class="g"><div class="m"><button class="star' + (watched ? ' on' : '') + '" data-w="' + esc(r.game_id) + '" title="Watch">★</button> ' + esc(r.away) + ' @ ' + esc(r.home) + '</div>'
      + '<div class="k">' + esc(when(r.kickoff)) + (r.fcs ? ' · FCS' : '') + '</div></div>'
      + '<div class="c ed"><div class="l">EdgeDesk</div><div class="v">' + esc(r.fair || '—') + '</div></div>'
      + '<div class="c mk"><div class="l">Market</div><div class="v">' + esc(r.market || '—') + (r.market_stale ? ' <span class="mut">stale</span>' : '') + '</div></div>'
      + '<div class="c gap"><div class="l">Gap</div><div class="v">' + gap + '</div></div>'
      + '<div class="s">' + stChip(r.status, r.status_label) + (r.verified ? vBadge() : (r.gap_class === 'MAJOR' ? '<span class="ubadge">UNVERIFIED</span>' : '')) + (r.read ? rdChip(r.read.timing, true) : '') + '</div>'
      + '<div class="mini"><span><b>ED</b>' + esc(r.fair || '—') + '</span><span><b>MKT</b>' + esc(r.market || '—') + (r.market_stale ? '*' : '') + '</span><span><b>GAP</b>' + gap + '</span></div>'
      + '</div>'
      + '<div class="rx">'
      + (r.gap != null ? '<div class="ln"><span class="l">Gap</span><span>' + esc(r.gap.toFixed(1) + ' pts toward ' + (r.gap_toward || '—')) + (r.gap_class === 'MAJOR' ? ' · ' + esc(String(r.verification).toLowerCase().replace(/_/g, ' ')) : '') + '</span></div>' : '')
      + '<div class="ln"><span class="l">Why</span><span>' + esc(s.why || '—') + '</span></div>'
      + '<div class="ln"><span class="l">Risk</span><span>' + esc(s.risk || '—') + '</span></div>'
      + '<div class="ln"><span class="l">Price</span><span>' + esc(s.price || '—') + '</span></div>'
      + (r.read ? '<div class="ln"><span class="l">Read</span><span>' + esc(readLine(r.read)) + '</span></div>' : '')
      + '<div class="ln"><span class="l">Status</span><span>' + esc(r.status_reason || '') + '</span></div>'
      + '<div class="ln"><span class="l">Quality</span><span class="mono">confidence ' + (r.confidence == null ? '—' : r.confidence) + ' · reliability ' + (r.reliability == null ? '—' : r.reliability) + ' · models ' + esc(r.agreement || '—') + (r.model_sd != null ? ' (SD ' + r.model_sd.toFixed(1) + ')' : '') + ' · interest ' + r.research_interest + '</span></div>'
      + '<div class="act"><a class="btn pri" href="#/game/' + esc(r.game_id) + '">Open research page →</a></div>'
      + '</div></div>';
  }
  function bindStars() {
    Array.prototype.forEach.call(document.querySelectorAll('.star[data-w]'), function (x) {
      x.onclick = function (e) {
        e.stopPropagation();
        var id = x.getAttribute('data-w'), w = store.get(KW, {});
        if (w[id]) { delete w[id]; store.set(KW, w); x.classList.remove('on'); track('watch_remove', { game_id: id }); return; }
        load('games').then(function (G) {
          var o = G.games[id]; if (!o) return;
          w[id] = T.watchEntry(o, readWatchOpts(o)); store.set(KW, w); x.classList.add('on'); track('watch_add', { game_id: id });
        });
      };
    });
  }

  /* ================================================================ THE EDGEDESK READ
     The page never computes a football number. It re-prices the stored read
     inputs (the champion's probability at every half point, every captured
     quote, the policy's thresholds) through lib/edgedesk_read.js — for the
     reader's clock, their book, a typed quote, a moved line — exactly as the
     build does. BET and BET EARLY exist only when the governed decision engine
     certified that exact quote at build time. */
  var RD_TONE = { BET_EARLY: 'bet', BET: 'bet', RESEARCH: 'research', WAIT: 'wait', PRICE_TARGET: 'wait', PASS: 'pass', PRICE_GONE: 'pass', INVESTIGATE: 'investigate', NO_DECISION: 'nomarket' };
  function rdChip(key, small) {
    var k = String(key || 'NO_DECISION');
    return '<span class="st rd ' + (RD_TONE[k] || 'pass') + (small ? ' sm' : '') + '" title="' + esc(RD && RD.TIMING[k] ? RD.TIMING[k] : '') + '"><i></i>' + esc((small ? 'READ ' : '') + k.replace(/_/g, ' ')) + '</span>';
  }
  function readLine(r) {
    var parts = [String(r.timing).replace(/_/g, ' ')];
    if (r.selected) parts.push(r.selected);
    if (num(r.cover) && num(r.break_even)) parts.push('cover ' + pct(r.cover, 1) + (r.basis === 'RAW' ? ' raw' : '') + ' vs ' + pct(r.break_even, 1));
    if (r.bettable_to != null) parts.push((r.bettable_label === 'NEEDS' ? 'needs ' : 'bettable to ') + bk(r.bettable_to));
    if (r.target != null) parts.push('target ' + bk(r.target));
    return parts.join(' · ');
  }
  function readWatchOpts(o) {
    var r = S.read && S.read.game_id === o.game_id ? S.read : o.read;
    if (!r || !r.side) return {};
    if (r.target_price) return { side: r.side, target_line: r.target_price.line, target_price: r.target_price.price };
    if (r.bettable_to && r.bettable_to.line != null) return { side: r.side, target_line: r.bettable_to.line, target_price: r.bettable_to.reference_price };
    return { side: r.side };
  }
  function readView() {
    var v = store.get(KRV, { mode: 'best' });
    if (v.mode === 'mine') v.books = store.get(KB, []);
    return v;
  }
  function readInput(o, extra) {
    extra = extra || {};
    return RD.fromTerminal(o, o.read_inputs, { now: nowMs(), view: extra.view || readView(), user_quotes: extra.user_quotes || [], integrity: window.EDCfbIntegrity || null });
  }
  function liveRead(o) {
    if (!RD || !o.read_inputs) return o.read || null;
    try { return RD.read(readInput(o)); } catch (e) { return o.read || null; }
  }
  function sgn(x, dp) { return num(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) : '—'; }
  function evs(x) { return num(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + '%' : '—'; }
  function tag(t, cls) { return '<span class="rtag' + (cls ? ' ' + cls : '') + '">' + esc(t) + '</span>'; }
  function readCard(o, R) {
    if (!R) return '<section class="rd-card"><div class="rd-h"><span class="rd-t">EDGEDESK READ</span></div><div class="empty">No EdgeDesk Read for this game in this build.</div></section>';
    var s = R.selected, g = o.game, inv = R.timing_read === 'INVESTIGATE', raw = R.probability_basis === 'RAW';
    var books = {};
    ((o.read_inputs && o.read_inputs.market && o.read_inputs.market.quotes) || []).forEach(function (q) { if (q.book && !/consensus/i.test(q.book)) books[q.book] = 1; });
    var v = R.view || { mode: 'best' };
    var viewSel = '<label class="rd-view">Price from <select id="rdView">'
      + '<option value="best"' + (v.mode === 'best' ? ' selected' : '') + '>Best available (every book)</option>'
      + '<option value="consensus"' + (v.mode === 'consensus' ? ' selected' : '') + '>Market consensus</option>'
      + Object.keys(books).sort().map(function (b) { return '<option value="book:' + esc(b) + '"' + (v.mode === 'book' && v.book === b ? ' selected' : '') + '>' + esc(b) + ' only</option>'; }).join('')
      + '<option value="mine"' + (v.mode === 'mine' ? ' selected' : '') + '>My books' + (store.get(KB, []).length ? ' (' + store.get(KB, []).length + ')' : ' (none set)') + '</option></select></label>';
    var h = '<section class="rd-card t-' + (RD_TONE[R.timing_read] || 'pass') + '" id="read" aria-label="EdgeDesk Read">'
      + '<div class="rd-h"><span class="rd-t">EDGEDESK READ</span>' + viewSel + '</div>'
      + '<div class="rd-top"><div class="rd-state">' + rdChip(R.timing_read) + '<span class="rd-dec">Decision: <b>' + esc(R.decision_status.replace(/_/g, ' ')) + '</b> · Research: <b>' + esc(R.research_status.label) + '</b></span></div>'
      + '<div class="rd-best"><div class="l">' + (v.mode === 'mine' ? 'Best price for you' : (v.mode === 'consensus' ? 'Consensus price' : (R.best_value_market.type !== 'NONE' && !R.research_status.blocks_action ? 'Best value' : 'Current price'))) + '</div>'
      + '<div class="v">' + (s ? esc(s.label) + (s.price && s.price.approximate_american ? ' <span class="mut" title="converted from the source’s implied percentage">≈</span>' : '') : '<span class="mut">no live price</span>') + '</div>'
      + '<div class="n">' + (s ? esc((s.book || '') + (s.alternate ? ' · alternate' : '') + (num(s.age_minutes) ? ' · ' + s.age_minutes + ' min old' : '') + (s.freshness && s.freshness !== 'FRESH' ? ' · ' + s.freshness.toLowerCase() : '')) : esc(R.timing_reason)) + '</div></div></div>';
    var cell = function (l, v2, n, cls) { return '<div class="rc' + (cls ? ' ' + cls : '') + '"><div class="l">' + l + '</div><div class="v">' + v2 + '</div>' + (n ? '<div class="n">' + n + '</div>' : '') + '</div>'; };
    h += '<div class="rd-grid' + (inv ? ' inv' : '') + '">'
      + cell('EdgeDesk fair', R.fair_spread ? esc(R.fair_spread.text) : '—', R.projected_score ? esc(g.away + ' ' + R.projected_score.away + ' – ' + g.home + ' ' + R.projected_score.home) : (R.fair_total != null ? 'total ' + f1(R.fair_total) : null), 'ed')
      + cell('Market', R.market_consensus_spread ? esc(R.market_consensus_spread.text) : '—', R.market_consensus_spread ? esc(R.market_consensus_spread.n_books + ' book' + (R.market_consensus_spread.n_books === 1 ? '' : 's') + (R.market_consensus_spread.stale ? ' · stale' : '')) : null, 'mk')
      + cell('Model cushion', s && num(s.cushion) ? sgn(s.cushion) + ' pts' : (R.model_market_gap ? R.model_market_gap.points.toFixed(1) + ' pts' : '—'), R.model_market_gap ? 'gap toward ' + esc(R.model_market_gap.toward_team || '—') : null)
      + cell('Cover', s && num(s.cover_used) ? pct(s.cover_used, 1) + (raw ? ' ' + tag('RAW', 'warn') : '') : '—', s && s.probability ? 'push ' + pct(s.probability.push, 1) + ' · loss ' + pct(s.probability.loss, 1) : null)
      + cell('Break-even', s && num(s.break_even) ? pct(s.break_even, 1) : '—', s && s.price ? 'at ' + esc(T.format.priceText(s.price.american)) + (s.price.precision === 'IMPLIED_PERCENT' ? ' (source %)' : '') : null)
      + cell('Est. EV', s && num(s.ev) ? '<span class="' + (raw ? 'rawv' : '') + '">' + evs(s.ev) + '</span>' + (raw ? ' ' + tag('RAW', 'warn') : '') : '—', raw ? 'calibration pending: research, not a decision number' : (s && num(s.ev_threshold) ? 'after buffer ' + evs(s.ev_threshold) : null))
      + cell(esc(R.bettable_to ? R.bettable_to.label : 'Bettable to'), R.bettable_to && R.bettable_to.line != null ? esc(R.side_team + ' ' + bk(R.bettable_to.line)) + ' <span class="mut">' + esc(T.format.priceText(R.bettable_to.reference_price)) + '</span>' : '<span class="mut">no nearby number</span>',
        R.bettable_to && R.bettable_to.price_at_current_line != null && s ? 'at ' + esc(bk(s.line)) + ': ' + esc(T.format.priceText(R.bettable_to.price_at_current_line)) + (R.bettable_to.current_clears ? ' or better' : ' needed') : null)
      + cell('Price', esc(R.price_status.label), R.target_price ? 'target ' + esc(R.target_price.text) : (R.price_is_gone && R.price_is_gone.state === 'MOSTLY_GONE' ? 'most of the price is gone' : null))
      + '</div>';
    if (inv) h += '<div class="banner warn"><b>Not priced until verified.</b> The numbers above are what EdgeDesk’s distribution says <i>if</i> its number is right. ' + esc(String(R.research_status.reason).replace(/[\s.]+$/, '')) + '.</div>';
    h += '<div class="rd-lines">'
      + '<div class="ln"><span class="l">Timing</span><span>' + esc(R.timing_reason) + '</span></div>'
      + '<div class="ln"><span class="l">Market</span><span>' + esc(R.market_movement_summary.text || '—') + '</span></div>'
      + (R.edge_kind ? '<div class="ln"><span class="l">Edge</span><span>' + esc(R.edge_kind.text) + '</span></div>' : '')
      + '<div class="ln"><span class="l">Alt</span><span>' + esc(R.main_vs_alt_summary.text || '—') + '</span></div>'
      + (R.market_quote_check.length ? '<div class="ln qc"><span class="l">Quote check</span><span>' + R.market_quote_check.map(function (c) { return '<b>MARKET QUOTE CHECK</b> · ' + esc((c.stored_label || c.kind) + ' showed ' + g.home + ' ' + bk(c.stored_home_line) + '; ' + c.book + ' now ' + bk(c.current_home_line) + ' (' + c.difference_pts + ' pts). ' + c.resolution); }).join('<br>') + '</span></div>' : '')
      + '</div>';
    h += '<div class="rd-badges">' + R.maturity.filter(function (m) { return ['Cover probability', 'Timing (bet early / wait)', 'Alternate value', 'Betting'].indexOf(m.item) >= 0; })
      .map(function (m) { return '<span class="mbadge' + (/PENDING|DISABLED|EXPERIMENTAL|SHADOW/.test(m.status) ? ' pend' : '') + '" title="' + esc(m.note) + '"><b>' + esc(m.item.toUpperCase()) + '</b> ' + esc(m.status) + '</span>'; }).join('') + '</div>';
    h += '<div class="rd-more">' + readWhy(o, R) + readRisk(R) + readMarket(o, R) + readAlts(o, R) + readCurve(o, R) + readTools(o, R) + readAdvanced(o, R) + '</div>';
    h += '<div class="note">' + esc(R.principle) + ' Research, not advice: an edge is an expected value and any single game can lose.' + (ASOF != null ? ' · clock pinned to ' + esc(new Date(ASOF).toISOString()) : '') + '</div>';
    return h + '</section>';
  }
  function rsec(id, title, teaser, body) { return '<details class="rx-sec" data-rsec="' + id + '"><summary><span class="caret">▶</span><b>' + esc(title) + '</b><span class="x">' + esc(teaser || '') + '</span></summary><div class="b">' + body + '</div></details>'; }
  function rows2(list) { return '<table class="t kvt">' + list.filter(Boolean).map(function (x) { return '<tr><th>' + esc(x.k) + '</th><td>' + esc(x.v) + '</td></tr>'; }).join('') + '</table>'; }
  function readWhy(o, R) {
    var W = R.why_edgedesk_differs, b = '';
    if (R.why_bet_early) b += '<div class="sub"><h3>Why bet early?</h3>' + rows2(R.why_bet_early) + '</div>';
    if (R.why_wait) b += '<div class="sub"><h3>Why wait?</h3>' + rows2(R.why_wait) + '</div>';
    if (R.why_not_bet.length) b += '<div class="sub"><h3>' + (R.timing_read === 'PASS' || R.timing_read === 'PRICE_GONE' ? 'Why EdgeDesk passes' : 'Why not bet?') + '</h3><ul class="l">' + R.why_not_bet.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul></div>';
    b += '<div class="sub"><h3>Why EdgeDesk differs</h3>' + (W.available ? '<table class="t">' + W.rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + esc(r.text) + '</td></tr>'; }).join('') + (W.final_fair ? '<tr class="cur"><td><b>EdgeDesk fair</b></td><td class="n"><b>' + esc(W.final_fair) + '</b></td></tr>' : '') + '</table>'
      + (W.market_implied ? '<div class="note">' + esc(W.market_implied) + '</div>' : '') + (W.unpriced && W.unpriced.length ? '<div class="note">Not priced today: ' + esc(W.unpriced.join(', ')) + '.</div>' : '') : '<div class="empty">' + esc(W.text) + '</div>') + '<div class="note">' + esc(W.note || '') + '</div></div>';
    return rsec('why', 'Why', R.why_bet_early ? 'why bet early' : (R.why_wait ? 'why wait' : 'why not bet · why EdgeDesk differs'), b);
  }
  function readRisk(R) {
    var b = R.risk_summary.length ? '<ul class="l">' + R.risk_summary.map(function (x) { return '<li><span class="sev ' + (x.severity === 'high' ? 'high' : (x.severity === 'moderate' ? 'moderate' : '')) + '">' + esc(x.severity) + '</span>' + esc(x.text) + ' <span class="mut">· ' + esc(x.source) + '</span></li>'; }).join('') + '</ul>' : '<div class="empty">No structured risk on file.</div>';
    b += '<div class="note">Only EdgeDesk’s structured data: quarterback state, model disagreement, what would have to be wrong, the error model, the integrity gate and the calibration. Nothing is inferred from narratives.</div>';
    return rsec('risk', 'Risk · what could make EdgeDesk wrong', R.risk_summary.length + ' item' + (R.risk_summary.length === 1 ? '' : 's'), b);
  }
  function readMarket(o, R) {
    var M = R.market_movement_summary, C = R.consensus, F = R.quote_freshness, g = o.game;
    var b = rows2([
      { k: 'Open', v: M.open ? g.home + ' ' + bk(M.open.home_line) + (M.open.at ? ' · ' + when(M.open.at) : '') : 'no opener captured' },
      { k: 'Consensus', v: C.available ? g.home + ' ' + bk(C.home_line) + ' · ' + C.method.replace(/_/g, ' ').toLowerCase() + ' · ' + C.n_books + ' book' + (C.n_books === 1 ? '' : 's') + (C.stale ? ' · STALE' : '') : (C.reason || '—') },
      { k: 'Best available', v: R.best_available ? R.best_available.label + ' · ' + R.best_available.book : '—' },
      { k: 'Selected', v: R.selected ? R.selected.label + ' · ' + (R.selected.book || '') : '—' },
      { k: 'Direction', v: M.text || '—' },
      { k: 'Edge decay', v: R.edge_decay.available ? (R.edge_decay.decay_pct != null ? 'EDGE DECAY ' + Math.round(100 * R.edge_decay.decay_pct) + '% · ' : '') + R.edge_decay.text : R.edge_decay.text },
      { k: 'Price', v: R.price_is_gone.text || R.price_is_gone.state },
      { k: 'Market freshness', v: R.market_freshness.score == null ? 'unknown' : R.market_freshness.score + '/100 ' + R.market_freshness.label + (R.market_freshness.basis && R.market_freshness.basis.length ? ' · ' + R.market_freshness.basis.join(', ') : '') + ' — separate from football confidence' }
    ]);
    b += '<div class="note">' + esc(C.weighting || '') + ' · outlier screen: ' + esc(C.outlier_screen || '') + (C.duplicate_feeds_merged && C.duplicate_feeds_merged.length ? ' · merged duplicate feeds: ' + esc(C.duplicate_feeds_merged.join(', ')) : '') + (C.excluded && C.excluded.length ? ' · excluded: ' + esc(C.excluded.map(function (x) { return x.book + ' (' + x.reason + ')'; }).join('; ')) : '') + '</div>';
    b += '<div class="sub"><h3>Line shopping · ' + esc(R.side_team || '—') + '</h3>' + (R.line_shopping.length ? '<div class="tscroll"><table class="t"><tr><th>Book</th><th>Price</th><th>Cover</th><th>Break-even</th><th>EV</th><th>Age</th></tr>'
      + R.line_shopping.map(function (x) { return '<tr' + (R.selected && x.label === R.selected.label && x.book === R.selected.book ? ' class="cur"' : '') + '><td>' + esc(x.book || '—') + '</td><td class="n">' + esc(bk(x.line) + ' ' + T.format.priceText(x.price ? x.price.american : null)) + '</td><td class="n">' + pct(x.cover_used, 1) + '</td><td class="n">' + pct(x.break_even, 1) + '</td><td class="n">' + evs(x.ev) + '</td><td class="n">' + (num(x.age_minutes) ? x.age_minutes + 'm' : '—') + (x.fresh ? '' : ' <span class="mut">stale</span>') + '</td></tr>'; }).join('') + '</table></div>'
      : '<div class="empty">No priced quote on EdgeDesk’s side.</div>') + '<div class="note">Ranked by EdgeDesk’s expected value at each book’s own line and price — not by the biggest number or the lowest juice alone.</div></div>';
    b += '<div class="sub"><h3>Quote freshness</h3><div class="tscroll"><table class="t"><tr><th>Book</th><th>Source</th><th>' + esc(g.home) + ' line</th><th>Prices</th><th>Captured</th><th>Age</th><th>Status</th></tr>'
      + F.quotes.slice().sort(function (a, c) { return Date.parse(c.captured_at || 0) - Date.parse(a.captured_at || 0); }).slice(0, 12).map(function (q) { return '<tr><td>' + esc(q.book || '—') + (q.alternate ? ' <span class="mut">alt</span>' : '') + '</td><td>' + esc(q.source || '') + '</td><td class="n">' + esc(bk(q.home_line)) + '</td><td class="n">' + esc(T.format.priceText(q.price_home) + ' / ' + T.format.priceText(q.price_away)) + '</td><td class="n">' + esc(q.captured_at ? when(q.captured_at) : '—') + '</td><td class="n">' + (q.age_minutes == null ? '—' : q.age_minutes + 'm') + '</td><td>' + tag(q.status, q.status === 'STALE' ? 'neg' : (q.status === 'AGING' ? 'warn' : '')) + '</td></tr>'; }).join('')
      + '</table></div><div class="note">' + esc(F.rule) + '</div></div>';
    return rsec('market', 'Market', (M.direction && M.direction !== 'UNKNOWN' ? M.direction.toLowerCase() + ' · ' : '') + (C.available ? C.n_books + ' book' + (C.n_books === 1 ? '' : 's') : 'no market') + (R.market_quote_check.length ? ' · QUOTE CHECK' : ''), b);
  }
  function readAlts(o, R) {
    var A = R.alternates, S2 = R.main_vs_alt_summary;
    var b = rows2([{ k: 'Main line', v: S2.main_line || '—' }, { k: 'Best value', v: S2.best_value || 'nothing clears' }, { k: 'Best alternate', v: S2.best_alt || '—' }, { k: 'Safest alternate', v: S2.safest_alt ? S2.safest_alt + ' (safest is never “preferred” for being safer)' : '—' }]);
    if (A.rows.length) b += '<div class="tscroll"><table class="t"><tr><th>Alternate</th><th>Book</th><th>+pts</th><th>Cover gain</th><th>Break-even rise</th><th>EV change</th><th>Read</th></tr>' + A.rows.map(function (x) {
      var c = x.vs_main || {};
      return '<tr><td class="n">' + esc(x.option.label) + '</td><td>' + esc(x.option.book || '') + '</td><td class="n">' + (num(c.line_change) ? sgn(c.line_change) : '—') + '</td><td class="n">' + (num(c.cover_probability_change) ? pp(c.cover_probability_change) : '—') + '</td><td class="n">' + (num(c.break_even_change) ? pp(c.break_even_change) : '—') + '</td><td class="n">' + (num(c.ev_change_after_buffer) ? evs(c.ev_change_after_buffer) : '—') + '</td><td>' + esc(x.text) + '</td></tr>'
        + (c.why ? '<tr class="why"><td colspan="7">' + esc(c.why) + (c.key_numbers_crossed && c.key_numbers_crossed.length ? ' ' + esc(c.key_numbers_crossed.map(function (k) { return k.text; }).join(' ')) : '') + '</td></tr>' : '');
    }).join('') + '</table></div>';
    else b += '<div class="empty">' + esc(S2.note) + '</div>';
    if (R.frontier) b += '<div class="sub"><h3>Alternate price frontier · ' + esc(R.side_team || '') + '</h3>' + frontierChart(R) + (R.frontier.text ? '<div class="note">' + esc(R.frontier.text) + '</div>' : '') + '</div>';
    b += '<div class="edu"><b>Buying points.</b> Buying points increases your chance of covering, but sportsbooks charge for that protection. EdgeDesk compares the model’s additional cover probability with the additional price required — the break-even the new price demands — plus the same uncertainty buffer every price has to clear. A safer line is never better just because it is safer.</div>';
    return rsec('alts', 'Alternates', S2.captured ? S2.captured + ' captured · ' + (S2.alt_verdict ? S2.alt_verdict.replace(/_/g, ' ').toLowerCase() : '') : 'none captured · price one below', b);
  }
  function readCurve(o, R) {
    var P = R.price_curve;
    if (!P) return rsec('curve', 'Price curve', 'no side', '<div class="empty">No side to price: EdgeDesk matches the market or has no number.</div>');
    var row = function (x) { return '<tr' + (x.read === 'BEST VALUE' ? ' class="cur"' : '') + '><td class="n">' + esc(bk(x.line)) + '</td><td class="n">' + esc(T.format.priceText(x.price)) + (x.approximate_price ? '≈' : '') + '</td><td>' + esc(x.kind === 'REFERENCE' ? 'reference' : (x.book || '') + (x.kind === 'ALTERNATE' ? ' · alt' : '')) + '</td><td class="n">' + pct(x.break_even, 1) + '</td><td class="n">' + pct(x.cover, 1) + '</td><td class="n">' + (x.push ? pct(x.push, 1) : '—') + '</td><td class="n">' + evs(x.ev) + '</td><td>' + tag(x.read, /VALUE/.test(x.read) ? 'pos' : (x.read === 'MARGINAL' ? 'warn' : '')) + '</td></tr>'; };
    var head = '<tr><th>Line</th><th>Price</th><th>Source</th><th>Break-even</th><th>Model cover</th><th>Push</th><th>EV</th><th>Read</th></tr>';
    var b = '<div class="sub" style="margin-top:0"><h3>Offered prices · ' + esc(P.team) + '</h3>' + (P.offered.length ? '<div class="tscroll"><table class="t">' + head + P.offered.map(row).join('') + '</table></div>' : '<div class="empty">No fresh priced quote on this side.</div>') + '</div>'
      + '<div class="sub"><h3>Reference ladder · ' + esc(T.format.priceText(P.reference_price)) + ' at every half point</h3><div class="tscroll"><table class="t">' + head + P.ladder.map(row).join('') + '</table></div><div class="note">' + esc(P.note) + ' Cover is ' + (R.probability_basis === 'RAW' ? 'the raw champion distribution (calibration pending).' : 'the calibrated decision probability.') + '</div></div>';
    return rsec('curve', 'Price curve', P.offered.length + ' offered · ' + P.ladder.length + ' reference rows', b);
  }
  function readTools(o, R) {
    var team = R.side_team || o.game.home, ex = R.selected ? team + ' ' + bk(R.selected.line) + ' ' + T.format.priceText(R.selected.price ? R.selected.price.american : -110) : team + ' +3.5 -110';
    var b = '<div class="tool"><h3>Enter a price</h3><div class="note" style="margin-top:0">A USER QUOTE: priced with EdgeDesk’s distribution and the same threshold, never stored as consensus and never a certified bet.</div>'
      + '<div class="askrow"><input id="rdMan" placeholder="e.g. ' + esc(ex) + ' draftkings" value=""><button class="btn pri" id="rdManGo">Read it</button></div><div id="rdManOut"></div></div>'
      + '<div class="tool"><h3>Compare lines</h3><div class="note" style="margin-top:0">One price per line, same team. The first line is the baseline.</div>'
      + '<textarea id="rdCmp" rows="3">' + esc(ex + (R.selected ? '\n' + team + ' ' + bk(R.selected.line + 1) + ' ' : '')) + '</textarea><div class="askrow"><span class="mut" style="font-size:11.5px">Add the price for each line, then</span><button class="btn pri" id="rdCmpGo">Compare</button></div><div id="rdCmpOut"></div></div>'
      + '<div class="tool"><h3>What if this line moves?</h3><div class="askrow"><span>' + esc(team) + '</span><input id="rdWiL" type="number" step="0.5" value="' + (R.selected ? R.selected.line : '') + '" style="max-width:90px"><input id="rdWiP" type="number" step="1" value="-110" style="max-width:90px"><button class="btn pri" id="rdWiGo">Recalculate</button></div><div id="rdWiOut"></div></div>';
    return rsec('tools', 'Tools · enter a price · compare · what if', 'instant, from the stored distribution', b);
  }
  function readAdvanced(o, R) {
    var ag = R.model_agreement, b = '';
    b += '<div class="sub" style="margin-top:0"><h3>Model agreement · ' + esc(ag.label) + '</h3>' + (ag.available ? '<div>' + esc(ag.basis || '') + '</div>' + (ag.side_support ? '<div class="note">' + esc(ag.side_support) + '</div>' : '') + '<table class="t">' + ag.components.map(function (c) { return '<tr><td>' + esc(c.label) + (c.independent ? '' : ' <span class="mut">(not independent)</span>') + '</td><td class="n">' + esc(c.text) + '</td><td class="n">' + (num(c.vs_market) ? sgn(c.vs_market) + ' vs mkt' : '—') + '</td></tr>'; }).join('') + '</table>' + (ag.why_disagree || []).map(function (t) { return '<div class="note">' + esc(t) + '</div>'; }).join('') : '<div class="empty">' + esc(ag.text) + '</div>') + '</div>';
    b += '<div class="sub"><h3>Calibration</h3>' + rows2([{ k: 'Status', v: R.calibration.status }, { k: 'Artifact', v: (R.calibration.version || '—') + ' (for ' + (R.calibration.base_model_version || '—') + ')' }, { k: 'Why', v: R.calibration.reason || 'validated for this model version' }, { k: 'Probability used', v: R.probability_basis === 'RAW' ? 'raw champion distribution — no decision is certified on it' : 'calibrated decision probability; EV after the calibration’s 95% interval on the model weight' }]) + '</div>';
    b += '<div class="sub"><h3>Maturity</h3><table class="t">' + R.maturity.map(function (m) { return '<tr><td>' + esc(m.item) + '</td><td>' + tag(m.status, /PENDING|DISABLED|EXPERIMENTAL|SHADOW|RESEARCH/.test(m.status) ? 'warn' : 'pos') + '</td><td class="mut">' + esc(m.note) + '</td></tr>'; }).join('') + '</table></div>';
    var ml = R.markets.moneyline;
    b += '<div class="sub"><h3>Other markets</h3>' + rows2([{ k: 'Spread', v: R.markets.spread.status + ' · ' + R.markets.spread.probability }, { k: 'Total', v: R.markets.total.status + ' · ' + R.markets.total.reason }, { k: 'Team total', v: R.markets.team_total.status + ' · ' + R.markets.team_total.reason },
      { k: 'Moneyline', v: ml.status + (ml.fair ? ' · fair ' + o.game.home + ' ' + T.format.priceText(ml.fair.home) + ' / ' + o.game.away + ' ' + T.format.priceText(ml.fair.away) : '') + (ml.book ? ' · ' + ml.book.book + ' ' + T.format.priceText(ml.book.price_home) + ' / ' + T.format.priceText(ml.book.price_away) + ' (no-vig ' + o.game.home + ' ' + pct(ml.book.no_vig_home, 1) + ')' : '') + ' · ' + ml.reason }]) + '</div>';
    b += '<div class="sub"><h3>Provenance</h3>' + rows2([{ k: 'Read', v: R.version + ' · built ' + R.generated_at }, { k: 'Model', v: R.model_version || '—' }, { k: 'Probability curve', v: (o.read_inputs && o.read_inputs.curve ? o.read_inputs.curve.basis + ' (half points ' + o.read_inputs.curve.lo + ' to ' + (o.read_inputs.curve.lo + (o.read_inputs.curve.n - 1) * 0.5) + ', home margin)' : 'not stored') },
      { k: 'Thresholds', v: 'edge ≥ ' + (100 * R.config.min_probability_edge).toFixed(0) + ' pp (ideal ' + (100 * R.config.ideal_probability_edge).toFixed(0) + ' pp), EV ≥ ' + R.config.min_ev + ', quotes ≤ ' + R.config.stale_minutes + ' min, reference ' + R.config.reference_price + ', typical move ' + R.config.typical_move_pts + ' pts' }, { k: 'Valid until', v: R.valid_until ? when(R.valid_until) + ' (the quote’s age limit)' : '—' }]) + '</div>';
    b += '<details><summary class="mut" style="cursor:pointer;font-size:12px">The full read object</summary><pre class="raw">' + esc(JSON.stringify(R, null, 1)) + '</pre></details>';
    return rsec('adv', 'Advanced', 'model components · calibration · maturity · other markets · provenance', b);
  }
  /* THE FRONTIER: protection (the side's line) on x, probability on y — the
     model's cover probability as a line (EdgeDesk colour), each offered
     price's break-even as a dot (market colour), the reference price's
     break-even dashed. Where the orange dots sit above the blue line, the
     book charges more for the points than EdgeDesk thinks they are worth. */
  function frontierChart(R) {
    var F = R.frontier, pts = F.points || [];
    var lad = pts.filter(function (p) { return p.kind === 'REFERENCE' && num(p.cover); });
    var off = pts.filter(function (p) { return p.kind !== 'REFERENCE' && num(p.break_even); });
    if (lad.length < 2) return '<div class="empty">Not enough of the curve to draw.</div>';
    var W = 640, H = 230, ml = 44, mr = 14, mt = 14, mb = 34;
    var xs = lad.map(function (p) { return p.line; }).concat(off.map(function (p) { return p.line; }));
    var marks = [];
    if (num(R.fair_line_for_side)) marks.push({ x: R.fair_line_for_side, t: 'FAIR' });
    if (R.selected) marks.push({ x: R.selected.line, t: 'CURRENT' });
    if (R.bettable_to && R.bettable_to.line != null) marks.push({ x: R.bettable_to.line, t: R.bettable_to.label === 'NEEDS' ? 'NEEDS' : 'BETTABLE TO' });
    if (R.target_price) marks.push({ x: R.target_price.line, t: 'TARGET' });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var ys = lad.map(function (p) { return p.cover; }).concat(lad.map(function (p) { return p.break_even; })).concat(off.map(function (p) { return p.break_even; })).concat(off.map(function (p) { return p.cover; }).filter(num));
    var y0 = Math.max(0, Math.floor(Math.min.apply(null, ys) * 20) / 20 - 0.02), y1 = Math.min(1, Math.ceil(Math.max.apply(null, ys) * 20) / 20 + 0.02);
    var sx = function (x) { return ml + (x - x0) / ((x1 - x0) || 1) * (W - ml - mr); }, sy = function (y) { return mt + (1 - (y - y0) / ((y1 - y0) || 1)) * (H - mt - mb); };
    var svg = '<svg class="fr" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Model cover probability and break-even by line">';
    for (var gy = Math.ceil(y0 * 20) / 20; gy <= y1 + 1e-9; gy += 0.05) svg += '<line class="grid" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + sy(gy).toFixed(1) + '" y2="' + sy(gy).toFixed(1) + '"/><text class="ax" x="' + (ml - 6) + '" y="' + (sy(gy) + 3.5).toFixed(1) + '" text-anchor="end">' + Math.round(gy * 100) + '%</text>';
    lad.forEach(function (p, i) { if (i % 2 === 0) svg += '<text class="ax" x="' + sx(p.line).toFixed(1) + '" y="' + (H - mb + 16) + '" text-anchor="middle">' + esc(bk(p.line)) + '</text>'; });
    marks.forEach(function (m, i) { if (m.x < x0 || m.x > x1) return; svg += '<line class="mk mk-' + m.t.replace(/ /g, '') + '" x1="' + sx(m.x).toFixed(1) + '" x2="' + sx(m.x).toFixed(1) + '" y1="' + mt + '" y2="' + (H - mb) + '"/><text class="mkt" x="' + (sx(m.x) + 3).toFixed(1) + '" y="' + (mt + 10 + 11 * (i % 3)) + '">' + esc(m.t) + '</text>'; });
    var refBe = lad[0].break_even;
    svg += '<line class="ref" x1="' + ml + '" x2="' + (W - mr) + '" y1="' + sy(refBe).toFixed(1) + '" y2="' + sy(refBe).toFixed(1) + '"/>';
    svg += '<path class="cov" d="' + lad.map(function (p, i) { return (i ? 'L' : 'M') + sx(p.line).toFixed(1) + ' ' + sy(p.cover).toFixed(1); }).join(' ') + '"/>';
    off.forEach(function (p) { svg += '<circle class="be" cx="' + sx(p.line).toFixed(1) + '" cy="' + sy(p.break_even).toFixed(1) + '" r="5"/>'; });
    /* hit targets: one column per half point, the readout lists every series there */
    var step = (W - ml - mr) / Math.max(1, (x1 - x0) / 0.5);
    lad.forEach(function (p) {
      var at = off.filter(function (q) { return Math.abs(q.line - p.line) < 1e-9; });
      var tip = '<b>' + esc(R.side_team + ' ' + bk(p.line)) + '</b><br>model cover ' + pct(p.cover, 1) + '<br>break-even at ' + esc(T.format.priceText(R.config.reference_price)) + ' ' + pct(p.break_even, 1)
        + at.map(function (q) { return '<br>' + esc((q.book || '') + ' ' + T.format.priceText(q.price)) + ': break-even ' + pct(q.break_even, 1) + ', EV ' + evs(q.ev); }).join('');
      svg += '<rect class="hit" x="' + (sx(p.line) - step / 2).toFixed(1) + '" y="' + mt + '" width="' + step.toFixed(1) + '" height="' + (H - mt - mb) + '" data-tip="' + esc(tip) + '"/>';
    });
    svg += '</svg>';
    var lab = '<div class="lgd"><span><i class="k cov"></i>EdgeDesk cover probability' + (R.probability_basis === 'RAW' ? ' (raw)' : '') + '</span><span><i class="k be"></i>Break-even of an offered price</span><span><i class="k ref"></i>Break-even at ' + esc(T.format.priceText(R.config.reference_price)) + '</span></div>';
    return lab + '<div class="frw">' + svg + '</div><div class="note">Where an orange dot sits above the blue line, the book charges more for those points than EdgeDesk thinks they are worth. The table view is the price curve above.</div>';
  }
  function bindRead(o) {
    if (!RD || !o.read_inputs) return;
    var sel = $('rdView');
    if (sel) sel.onchange = function () {
      var v = this.value, view = v.indexOf('book:') === 0 ? { mode: 'book', book: v.slice(5) } : { mode: v };
      store.set(KRV, view); track('section_open', { game_id: o.game_id, section: 'read_view', detail: view.mode });
      S.read = liveRead(o);
      $('rdWrap').innerHTML = readCard(o, S.read); bindRead(o);
    };
    Array.prototype.forEach.call(document.querySelectorAll('details.rx-sec'), function (d) { d.addEventListener('toggle', function () { if (d.open) track('section_open', { game_id: o.game_id, section: 'read_' + d.getAttribute('data-rsec') }); }); });
    var inp = function () { return readInput(o); };
    function optLine(x) { return x.problem ? esc(x.problem) : '<b>' + esc(x.label) + '</b> · cover ' + pct(x.cover_used, 1) + (x.cover_basis === 'RAW' ? ' (raw)' : '') + ' · break-even ' + pct(x.break_even, 1) + ' · edge ' + pp(x.edge) + ' · EV ' + evs(x.ev) + ' · ' + esc(x.threshold ? x.threshold.text : x.grade); }
    var man = $('rdManGo');
    if (man) man.onclick = function () {
      var r = RD.manual(inp(), $('rdMan').value);
      track('ask', { game_id: o.game_id, detail: 'read_manual' });
      $('rdManOut').innerHTML = '<div class="ans">' + (r.ok ? optLine(r.option) + (r.quote_check ? '<div class="banner warn">' + esc(r.quote_check.text) + '</div>' : '') + (r.whatif && r.whatif.text ? '<div class="note">' + esc(r.whatif.label + ': ' + r.whatif.text) + '</div>' : '') + '<div class="note">' + esc(r.note) + '</div>' : '<span class="unk">' + esc(r.problem) + '</span>') + '</div>';
    };
    var cmp = $('rdCmpGo');
    if (cmp) cmp.onclick = function () {
      var lines = $('rdCmp').value.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean);
      var specs = [], bad = [];
      lines.forEach(function (l) { var p = RD.parseQuoteText(l, o.game); if (p.ok && p.price && p.price.valid) specs.push({ side: p.side || (S.read && S.read.side) || 'home', line: p.line, price: p.price, book: p.book }); else bad.push(l + ': ' + (p.problem || 'add the price')); });
      var r = specs.length >= 2 ? RD.compare(inp(), specs) : { ok: false, problem: 'Enter at least two complete prices (line and juice).' };
      track('ask', { game_id: o.game_id, detail: 'read_compare' });
      var h2 = bad.length ? '<div class="banner warn">' + esc(bad.join(' · ')) + '</div>' : '';
      if (!r.ok) { $('rdCmpOut').innerHTML = h2 + '<div class="ans"><span class="unk">' + esc(r.problem) + '</span></div>'; return; }
      h2 += '<div class="ans"><div><b>RESULT: ' + esc(r.result) + '</b></div><ul class="l">' + r.options.map(function (x) { return '<li>' + optLine(x) + '</li>'; }).join('') + '</ul>'
        + r.comparisons.filter(Boolean).map(function (c) { return rows2([{ k: 'From → to', v: c.from + ' → ' + c.to }, { k: 'Additional points', v: sgn(c.line_change) }, { k: 'Break-even change', v: pp(c.break_even_change) }, { k: 'Cover probability change', v: pp(c.cover_probability_change) }, { k: 'Juice', v: (c.juice_cost_cents == null ? '—' : (c.juice_cost_cents === 0 ? 'same price' : Math.abs(c.juice_cost_cents) + ' cents ' + (c.juice_cost_cents > 0 ? 'more' : 'less'))) }, { k: 'EV difference', v: evs(c.ev_change_after_buffer) }, { k: 'Read', v: c.why + (c.key_numbers_crossed.length ? ' ' + c.key_numbers_crossed.map(function (k) { return k.text; }).join(' ') : '') }]); }).join('')
        + '<div class="note">Basis: ' + esc(r.basis) + '.</div></div>';
      $('rdCmpOut').innerHTML = h2;
    };
    var wi = $('rdWiGo');
    if (wi) wi.onclick = function () {
      var L = parseFloat($('rdWiL').value), P2 = parseFloat($('rdWiP').value), side = S.read && S.read.side ? S.read.side : 'home';
      var r = RD.whatIf(inp(), { side: side, line: L, price: isFinite(P2) ? P2 : -110 });
      track('ask', { game_id: o.game_id, detail: 'read_whatif' });
      $('rdWiOut').innerHTML = '<div class="ans"><b>' + esc(r.status) + '</b> · ' + optLine(r.option) + (r.bettable_to && r.bettable_to.text ? '<div class="note">' + esc(r.bettable_to.label + ': ' + r.bettable_to.text) + '</div>' : '') + '<div class="note">' + esc(r.note) + '</div></div>';
    };
  }

  /* ================================================================ GAME */
  function sec(id, title, teaser, body, open) {
    return '<details class="sec" id="s-' + id + '"' + (open ? ' open' : '') + ' data-sec="' + id + '"><summary><span class="caret">▶</span><span class="t">' + esc(title) + '</span><span class="x">' + esc(teaser || '') + '</span></summary><div class="b">' + body + '</div></details>';
  }
  function kv(items) { return '<div class="kv">' + items.filter(Boolean).map(function (x) { return '<div class="c"><div class="l">' + esc(x[0]) + '</div><div class="v">' + x[1] + '</div>' + (x[2] ? '<div class="n">' + x[2] + '</div>' : '') + '</div>'; }).join('') + '</div>'; }
  function renderGame(id) {
    $('view').innerHTML = '<div class="empty">Loading the research page…</div>';
    return load('games').then(function (G) {
      var o = G.games[id];
      if (!o) return renderPast(id);
      S.game = o; track('game_open', { game_id: id });
      var g = o.game, A = o.edgedesk, B = o.market, C = o.disagreement, F = o.price, St = o.status, sm = o.summary;
      var watched = !!store.get(KW, {})[id];
      var h = '<div class="gh"><h1>' + esc(g.away) + ' @ ' + esc(g.home) + '</h1>'
        + '<div class="meta">' + esc(when(o.kickoff)) + ' · ' + esc([g.away_conference, g.home_conference].filter(Boolean).join(' at ')) + (g.venue ? ' · ' + esc(g.venue) : '') + (g.neutral_site ? ' · neutral site' : '') + (g.fcs ? ' · FCS opponent' : '') + ' · week ' + esc(o.week) + '</div>'
        + '<div class="tools"><button class="btn sm" id="watchBtn">' + (watched ? '★ Watching' : '☆ Watch') + '</button>'
        + '<button class="btn sm" id="expBtn">Copy research card</button>'
        + '<button class="btn sm" id="flagBtn">Flag an issue ▾</button></div>'
        + '<div class="pillset hide" id="flagMenu"><button class="fchip" data-flag="Wrong or missing data" data-what="incorrect player status">Incorrect player status</button>'
        + '<button class="fchip" data-flag="Wrong or missing data" data-what="bad market quote">Bad market quote</button>'
        + '<button class="fchip" data-flag="Confusing or hard to use" data-what="confusing explanation">Confusing explanation</button>'
        + '<span class="mut" style="font-size:11.5px">Reports go to review. They never change EdgeDesk’s data or model by themselves.</span></div></div>';
      /* THE EDGEDESK READ — first, before everything else on the page */
      S.read = liveRead(o);
      h += '<div id="rdWrap">' + readCard(o, S.read) + '</div>';
      /* THE 15-SECOND SUMMARY */
      h += '<div class="sum' + (C.verified ? ' verified' : '') + '">'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">' + stChip(St.key, St.label) + (C.verified ? vBadge() : (C.class === 'MAJOR' ? '<span class="ubadge">UNVERIFIED 7+ GAP</span>' : '')) + '<span class="mut" style="font-size:12px">' + esc(St.reason) + '</span></div>'
        + '<div class="sum-grid">'
        + '<div class="cell"><div class="l">EdgeDesk fair</div><div class="v ed">' + esc(sm.model_says) + '</div></div>'
        + '<div class="cell"><div class="l">Market</div><div class="v mk">' + esc(sm.market_says) + '</div></div>'
        + '<div class="cell"><div class="l">Model gap</div><div class="v">' + (C.available ? C.points.toFixed(1) + ' pts' : '—') + '</div></div>'
        + '<div class="cell"><div class="l">Win prob</div><div class="v">' + (A.available ? esc(A.favorite || g.home) + ' ' + pct(A.home_margin >= 0 ? A.home_win_prob : A.away_win_prob, 0) : '—') + '</div></div>'
        + '<div class="cell"><div class="l">Cover prob</div><div class="v">' + (F.available && F.current && St.key !== 'INVESTIGATE' ? pct(F.current.cover, 1) : '—') + '</div></div>'
        + '<div class="cell"><div class="l">Reliability</div><div class="v">' + (o.data_quality.reliability == null ? '—' : o.data_quality.reliability) + '</div></div>'
        + '</div><div class="sum-lines">'
        + '<div class="ln"><span class="l">Why</span><span>' + esc(sm.why) + '</span></div>'
        + '<div class="ln"><span class="l">Risk</span><span>' + esc(sm.risk) + '</span></div>'
        + '<div class="ln"><span class="l">Price</span><span>' + esc(sm.price) + '</span></div>'
        + (St.price_condition && St.price_condition.bettable_to && St.key !== 'INVESTIGATE' ? '<div class="ln"><span class="l">Needs</span><span class="mono">' + needsText(o) + '</span></div>' : '')
        + '</div><div class="note">Win probability is who wins the game. Cover probability is whether a side beats the spread. Reliability is how complete the inputs are — not a probability.</div></div>';
      h += '<nav class="secnav">' + [['a', 'A · EdgeDesk'], ['b', 'B · Market'], ['c', 'C · Disagreement'], ['d', 'D · Why'], ['e', 'E · What could be wrong'], ['f', 'F · Price'], ['g', 'G · Timing'], ['h', 'H · History'], ['ask', 'Ask'], ['adv', 'Advanced']]
        .map(function (x) { return '<a href="#/game/' + esc(id) + '" data-jump="s-' + x[0] + '">' + x[1] + '</a>'; }).join('') + '</nav>';
      h += secA(o) + secB(o) + secC(o) + secD(o) + secE(o) + secF(o) + secG(o) + secH(o) + secAsk(o) + secAdv(o);
      $('view').innerHTML = h;
      bindGame(o);
      bindRead(o);
    });
  }
  /* current / preferred / bettable to / pass beyond, each once */
  function needsText(o) {
    var F = o.price, t = F.team, parts = [];
    if (F.current) parts.push('now ' + bk(F.current.line) + ' ' + T.format.priceText(F.current.price));
    var same = F.preferred_entry && F.bettable_to && Math.abs(F.preferred_entry.line - F.bettable_to.line) < 1e-9;
    if (F.preferred_entry && !same) parts.push('preferred ' + bk(F.preferred_entry.line) + ' or better');
    if (F.bettable_to) parts.push((same ? 'preferred and bettable to ' : 'bettable to ') + bk(F.bettable_to.line) + ' ' + T.format.priceText(F.bettable_to.price));
    if (F.pass_beyond) parts.push('pass at ' + bk(F.pass_beyond.line) + ' or worse');
    return esc(t + ': ' + parts.join(' · '));
  }
  function secA(o) {
    var A = o.edgedesk, g = o.game;
    if (!A.available) return sec('a', 'A · EdgeDesk view', A.reason, '<div class="empty">' + esc(A.reason) + '</div>', true);
    var b = kv([
      ['EdgeDesk fair', esc(A.fair_text), 'home line ' + bk(A.fair_home_line)],
      A.projected_score ? ['Projected score', esc(A.projected_score.away + '–' + A.projected_score.home), esc(g.away + ' – ' + g.home)] : null,
      ['Win probability', esc(g.home) + ' ' + pct(A.home_win_prob, 0), esc(g.away) + ' ' + pct(A.away_win_prob, 0)],
      num(A.fair_total) ? ['Fair total', f1(A.fair_total), null] : null,
      ['80% range', esc(A.interval_80 ? A.interval_80.text : '—'), 'σ ' + f1(A.sigma)],
      ['Football confidence', (A.football_confidence.score == null ? '—' : A.football_confidence.score) + ' · ' + esc(A.football_confidence.label), 'information quality, not a probability']
    ]) + '<div class="sub"><h3>Outcome distribution (margin, ' + esc(g.home) + ' perspective)</h3>' + distStrip(o) + '</div>'
      + '<div class="note">' + esc(A.model_version) + ' (' + esc(A.label || '') + ', governance ' + esc(A.role || '') + ') · published ' + esc(when(A.prediction_ts)) + ' · distribution: ' + esc(A.distribution_basis || '—') + '</div>';
    return sec('a', 'A · EdgeDesk view', A.fair_text + ' · ' + (A.projected_score ? A.projected_score.text : ''), b, true);
  }
  function secB(o) {
    var B = o.market, g = o.game, LS = o.line_shopping;
    if (!B.available) return sec('b', 'B · Market', 'no market', '<div class="empty">' + esc(B.reason) + '</div>', false);
    var books = store.get(KB, []);
    var mine = books.length ? T.bestForBooks(o, books) : null;
    var b = kv([
      ['Consensus', esc(B.consensus_text || '—') + (B.stale ? ' <span class="mut">stale</span>' : ''), B.books_fresh + ' fresh book' + (B.books_fresh === 1 ? '' : 's') + (B.dispersion ? ' · spread ' + B.dispersion.toFixed(1) : '')],
      ['Opener', B.open_home_line == null ? '—' : esc(g.home) + ' ' + bk(B.open_home_line), B.open_at ? esc(when(B.open_at)) : 'no opener archived'],
      ['Move since open', B.move_since_open ? esc(B.move_since_open.text) : '—', null],
      ['Best ' + esc(g.home), B.best && B.best.home ? esc(bk(B.best.home.line) + ' ' + T.format.priceText(B.best.home.price)) : '—', B.best && B.best.home ? esc(B.best.home.book) : ''],
      ['Best ' + esc(g.away), B.best && B.best.away ? esc(bk(B.best.away.line) + ' ' + T.format.priceText(B.best.away.price)) : '—', B.best && B.best.away ? esc(B.best.away.book) : ''],
      ['Quote freshness', B.age_minutes == null ? '—' : B.age_minutes + ' min', esc(B.freshness_rule)]
    ]);
    if (mine) b += '<div class="banner">Your books (' + esc(books.join(', ')) + '): ' + (mine.none_available ? 'no fresh quote at your books.' : esc(g.home) + ' ' + (mine.home ? esc(bk(mine.home.line) + ' ' + T.format.priceText(mine.home.price) + ' @ ' + mine.home.book) : '—') + ' · ' + esc(g.away) + ' ' + (mine.away ? esc(bk(mine.away.line) + ' ' + T.format.priceText(mine.away.price) + ' @ ' + mine.away.book) : '—')) + ' <a href="#/watch">change books</a></div>';
    b += '<div class="sub"><h3>Line shopping</h3>' + (LS.note ? '<div class="note" style="margin:0 0 6px">' + esc(LS.note) + '</div>' : '')
      + '<div class="tscroll"><table class="t"><tr><th>Book</th><th>' + esc(g.home) + '</th><th>' + esc(g.away) + '</th><th>EV ' + esc(g.home) + '</th><th>EV ' + esc(g.away) + '</th><th>Age</th><th></th></tr>'
      + LS.rows.map(function (r) {
        return '<tr><td>' + esc(r.book) + '</td><td class="n">' + bk(r.home_line) + ' ' + esc(T.format.priceText(r.price_home)) + '</td><td class="n">' + bk(-r.home_line) + ' ' + esc(T.format.priceText(r.price_away)) + '</td>'
          + '<td class="n">' + (num(r.ev_home) ? (100 * r.ev_home).toFixed(1) + '%' : '—') + '</td><td class="n">' + (num(r.ev_away) ? (100 * r.ev_away).toFixed(1) + '%' : '—') + '</td>'
          + '<td class="n">' + r.age_minutes + 'm' + (r.fresh ? '' : ' <span class="mut">stale</span>') + '</td><td class="mut">' + esc(r.stale_note || '') + '</td></tr>';
      }).join('') + '</table></div>'
      + (LS.edge_kind_text ? '<div class="note"><b>' + esc(LS.model_edge ? LS.model_edge.text : '') + '</b> · <b>' + esc(LS.book_edge ? LS.book_edge.text : '') + '</b><br>' + esc(LS.edge_kind_text) + '</div>' : '')
      + '<div class="note">EV is the champion model’s, per unit, at each quote’s own line and price — research, not validated for wagering.</div></div>';
    return sec('b', 'B · Market', (B.consensus_text || '—') + ' · ' + B.books_fresh + ' book' + (B.books_fresh === 1 ? '' : 's') + ' · ' + (B.age_minutes == null ? '' : B.age_minutes + ' min old'), b, false);
  }
  function secC(o) {
    var C = o.disagreement, D = o.edge_decay, X = o.market_check, K = o.contradiction;
    if (!C.available) return sec('c', 'C · Disagreement', C.reason, '<div class="empty">' + esc(C.reason) + '</div>', false);
    var b = kv([
      ['Model gap', C.points.toFixed(1) + ' pts', esc(C.toward_team ? 'toward ' + C.toward_team : 'none')],
      ['Class', esc(C.class_label), C.favorite_flip ? 'EdgeDesk and the market name different favourites' : null],
      ['Verification', C.verified ? vBadge() : esc(String(C.verification).replace(/_/g, ' ')), C.class === 'MAJOR' ? 'a 7+ gap must pass every integrity check' : 'not required under 7 pts'],
      ['Market direction', esc(C.market_direction), esc(C.market_direction_text || '')]
    ]);
    if (C.integrity && (C.integrity.failed.length || C.integrity.incomplete.length)) b += '<div class="sub"><h3>Integrity checks</h3><ul class="l">' + C.integrity.failed.map(function (f) { return '<li><span class="sev high">fail</span>' + esc(f) + '</li>'; }).join('') + C.integrity.incomplete.map(function (f) { return '<li><span class="sev">incomplete</span>' + esc(f) + '</li>'; }).join('') + '</ul></div>';
    else if (C.class === 'MAJOR' && !C.integrity) b += '<div class="note">The integrity gate could not run: this build’s slate did not publish the engine’s football inputs. Fail closed — the gap stays unverified.</div>';
    b += '<div class="sub"><h3>EdgeDesk vs market over time</h3>' + timeline(o.timeline, o.game) + '</div>';
    if (o.timeline.events.length) b += '<ul class="l">' + o.timeline.events.map(function (e) { return '<li><span class="mono mut">' + esc(when(e.at)) + '</span> ' + esc(e.text) + '</li>'; }).join('') + '</ul>';
    if (D.available) b += '<div class="sub"><h3>Edge decay</h3>' + (D.verdict_text ? '<div style="font-weight:700">' + esc(D.verdict_text) + '</div>' : '') + '<div>' + esc(D.text) + '</div>'
      + (D.initial ? kv([['Initial', f1(D.initial.points) + ' pts', esc(when(D.initial.at))], ['Current', f1(D.current.points) + ' pts', esc(when(D.current.at))], ['Lost to market', f1(D.lost_to_market) + ' pts', null], ['EdgeDesk moved', f1(D.model_moved) + ' pts', null]]) : '') + '</div>';
    if (X.triggered) b += '<div class="sub"><h3>Is the market telling us something?</h3><div class="note" style="margin:0 0 6px">' + esc(X.trigger) + '</div><table class="t">' + X.checks.map(function (c) { return '<tr><td>' + esc(c.area) + '</td><td><span class="sev ' + (c.status === 'EXPLANATION' ? 'high' : (c.status === 'OPEN' ? 'moderate' : '')) + '">' + esc(c.status) + '</span></td><td>' + esc(c.text) + '</td></tr>'; }).join('') + '</table><div style="margin-top:8px;font-weight:700">' + esc(X.verdict_text) + '</div></div>';
    if (K.available) b += '<div class="sub"><h3>Market contradiction</h3><table class="t"><tr><td class="mut">EdgeDesk</td><td>' + K.edgedesk.map(esc).join('<br>') + '</td></tr><tr><td class="mut">Market</td><td>' + K.market.map(esc).join('<br>') + '</td></tr><tr><td class="mut">Unresolved</td><td>' + (K.unresolved.length ? K.unresolved.map(esc).join('<br>') : 'nothing') + '</td></tr><tr><td class="mut">Status</td><td><b>' + esc(K.status_text) + '</b></td></tr></table></div>';
    return sec('c', 'C · Disagreement', C.text + ' · ' + String(C.verification).toLowerCase().replace(/_/g, ' ') + (D.available && D.verdict_text ? ' · ' + D.verdict_text : ''), b, C.class !== 'ALIGNED');
  }
  function secD(o) {
    var W = o.why, K = o.consensus, M = o.matchup, WC = o.what_changed, g = o.game;
    var b = '';
    if (W.available) {
      b += '<div class="sub" style="margin-top:0"><h3>Why this number' + (W.partial ? ' · partial' : '') + '</h3>' + waterfall(o) + '<div class="note">' + esc(W.basis) + (W.calibration ? ' · ' + esc(W.calibration.text) : '') + '</div>'
        + (W.unpriced && W.unpriced.length ? '<div class="note">Not priced in the champion today (0.0): ' + esc(W.unpriced.join(', ')) + '.</div>' : '')
        + (W.market_implied ? '<div class="banner">' + esc(W.market_implied.text) + '</div>' : '') + '</div>';
    } else b += '<div class="empty">' + esc(W.reason || 'no decomposition') + '</div>';
    if (W.v2_drivers) b += '<div class="sub"><h3>Production pathway (V2.1) drivers</h3><table class="t">' + W.v2_drivers.rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + T.util.signed(Math.abs(r.points)) + '</td><td>' + esc(r.favors || '') + '</td></tr>'; }).join('') + '</table><div class="note">' + esc(W.v2_drivers.note) + '</div></div>';
    if (K.available) b += '<div class="sub"><h3>Model consensus · agreement ' + esc(K.agreement.tier) + ' (' + K.agreement.score + '/100)</h3>' + consensusPlot(o)
      + '<details><summary class="mut" style="cursor:pointer;font-size:12px">Every model number</summary><table class="t">' + K.rows.map(function (r) { return '<tr><td>' + esc(r.label) + (r.independent ? '' : ' <span class="mut">(not independent)</span>') + '</td><td class="n">' + esc(r.text) + '</td><td class="n">' + (r.vs_market == null ? '—' : T.util.signed(r.vs_market) + ' vs mkt') + '</td></tr>'; }).join('') + '</table></details>'
      + '<div class="note">' + esc(K.agreement.basis) + (K.side_support ? ' · ' + esc(K.side_support.text) : '') + '</div>'
      + '<ul class="l">' + K.why_disagree.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
    if (M.available) b += '<div class="sub"><h3>Matchup intelligence</h3><div class="cards">' + M.cards.map(function (c) {
      return '<div class="mc"><div class="h"><span>' + esc(c.label) + '</span><span>' + esc(c.confidence) + '</span></div><div class="f">' + esc(c.text) + '</div><div class="vals">' + c.values.map(function (v) { return '<div><span>' + esc(v.team) + ' ' + esc(v.metric) + '</span><span class="mono">' + esc(v.value) + ' <span class="mut">lg ' + esc(v.league) + '</span></span></div>'; }).join('') + '</div></div>';
    }).join('') + '</div><div class="note">' + esc(M.basis) + ' Not measured: ' + esc(M.not_measured.join(', ')) + '.</div></div>';
    b += '<div class="sub"><h3>What changed?</h3>' + (WC.available ? '<div>' + esc(WC.text) + '</div>' + (WC.rows.length ? '<ul class="l">' + WC.rows.map(function (r) { return '<li>' + esc(r.text) + '</li>'; }).join('') + '</ul>' : '') + (WC.attribution_text ? '<div class="note">' + esc(WC.attribution_text) + '</div>' : '') + (WC.market ? '<div class="note">' + esc(WC.market.text) + '</div>' : '') : '<div class="empty">' + esc(WC.reason) + '</div>') + '</div>';
    b += '<div class="sub"><h3>Projection history</h3>' + (o.timeline.model.length ? '<table class="t">' + o.timeline.model.map(function (p) { return '<tr><td>' + esc(when(p.at)) + '</td><td class="n">' + esc(T.format.marginLine(p.home_margin, g.home, g.away, 1)) + '</td><td class="mut">' + esc(p.checkpoint || '') + ' · ' + esc(p.source || '') + '</td></tr>'; }).join('') + '</table>' : '<div class="empty">No stored EdgeDesk number yet.</div>') + '<div class="note">' + esc(o.timeline.model_note) + '</div></div>';
    return sec('d', 'D · Why EdgeDesk sees it differently', W.market_implied ? W.market_implied.text : (W.available ? 'the champion’s own terms' : ''), b, true);
  }
  function secE(o) {
    var R = o.risks, RC = o.reconcile, SE = o.sensitivity, P = o.paths, DQ = o.data_quality;
    var b = '<div class="sub" style="margin-top:0"><h3>Risks</h3>' + (R.items.length ? '<ul class="l">' + R.items.map(function (i) { return '<li><span class="sev ' + i.severity + '">' + esc(i.severity) + '</span>' + esc(i.text) + '</li>'; }).join('') + '</ul>' : '<div class="empty">None on file.</div>') + '</div>';
    b += '<div class="sub"><h3>What would have to be wrong for the market to be right?</h3>' + (RC.available ? '<div class="note" style="margin:0 0 6px">' + esc(RC.headline || '') + '</div><table class="t"><tr><th>Assumption that would have to break</th><th>Needs</th><th>Plausibility</th></tr>'
      + RC.rows.map(function (r) { return '<tr><td>' + esc(r.text) + '<div class="mut" style="font-size:11px">' + esc(r.source) + '</div></td><td class="n">' + f1(r.points_needed) + ' pts</td><td class="n">' + (r.sds_needed != null ? r.sds_needed.toFixed(1) + ' SD' : (r.covers_share != null ? Math.round(100 * r.covers_share) + '% of gap' : '—')) + '</td></tr>'; }).join('') + '</table>'
      + (RC.baseline ? '<div class="note">' + esc(RC.baseline.text) + '</div>' : '') + '<div class="note">' + esc(RC.note || '') + '</div>' : '<div class="empty">' + esc(RC.reason || '') + '</div>') + '</div>';
    b += '<div class="sub"><h3>Fair-line sensitivity</h3>' + (SE.available ? '<table class="t"><tr><th>If…</th><th>EdgeDesk fair</th><th>Change</th></tr>' + SE.rows.map(function (r) {
      return '<tr><td>' + esc(r.label) + '<div class="mut" style="font-size:11px">' + esc(r.basis) + '</div></td><td class="n">' + esc(r.fair_text) + '</td><td class="n">' + (r.kind === 'variance' ? 'σ ' + (r.sigma_delta >= 0 ? '+' : '') + (num(r.sigma_delta) ? r.sigma_delta.toFixed(2) : '—') : T.util.signed(r.delta, 2)) + '</td></tr>'; }).join('') + '</table>' + (SE.basis.length ? '<div class="note">' + esc(SE.basis.join(' ')) + '</div>' : '') : '<div class="empty">' + esc(SE.reason) + '</div>') + '</div>';
    if (P.available) b += '<div class="sub"><h3>Path to cover · ' + esc(o.price.team) + '</h3><ul class="l">' + P.cover.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>'
      + '<div class="sub"><h3>Path to failure</h3><ul class="l">' + P.failure.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul><div class="note">' + esc(P.note) + '</div></div>';
    b += '<div class="sub"><h3>Data quality · reliability ' + (DQ.reliability == null ? '—' : DQ.reliability) + ' ' + esc(DQ.grade || '') + '</h3><table class="t">' + DQ.rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + esc(r.value) + (r.unit || '') + '</td><td class="mut">' + esc(r.detail || '') + '</td></tr>'; }).join('') + '</table>'
      + (DQ.main_deduction ? '<div class="note">Main deduction: ' + esc(DQ.main_deduction) + '</div>' : '') + (DQ.fcs_note ? '<div class="banner warn">' + esc(DQ.fcs_note) + '</div>' : '') + '<div class="note">' + esc(DQ.separate) + '</div></div>';
    return sec('e', 'E · What could make EdgeDesk wrong', R.high + ' high-severity · ' + (RC.available ? RC.rows.length + ' reconciliations' : ''), b, false);
  }
  function secF(o) {
    var F = o.price, St = o.status, KN = o.key_numbers, H = o.historical;
    var b = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + stChip(St.key, St.label) + '<span>' + esc(St.reason) + '</span></div>';
    if (St.why_not_bet.length) b += '<div class="sub"><h3>' + (St.key === 'PASS' ? 'Why EdgeDesk passes' : 'Why not bet this?') + '</h3><ul class="l">' + St.why_not_bet.map(function (x) { return '<li>' + esc(x.text) + '</li>'; }).join('') + '</ul></div>';
    if (!F.available) return sec('f', 'F · Price decision', St.label + ' · ' + (F.reason || ''), b + '<div class="empty">' + esc(F.reason) + '</div>', true);
    if (St.key === 'INVESTIGATE' || St.key === 'DATA_FAULT') b += '<div class="banner warn"><b>Not priced until verified.</b> The numbers below are what the model would say if its number were right. At this size, missing information is more often the cause than an edge.</div>';
    var cur = F.current;
    if (cur) b += '<div class="sub">' + kv([
      ['Current', esc(bk(cur.line) + ' ' + T.format.priceText(cur.price)), esc(F.team + ' · ' + cur.book)],
      ['Cover probability', pct(cur.cover, 1), 'push ' + pct(cur.push, 1)],
      ['Break-even', pct(cur.break_even, 1), 'at ' + T.format.priceText(cur.price)],
      ['Model edge', pp(cur.edge), 'model grade ' + esc(cur.grade)],
      ['Model EV', (cur.ev >= 0 ? '+' : '') + (100 * cur.ev).toFixed(1) + '%', 'per unit · not validated'],
      ['Preferred', F.preferred_entry ? esc(bk(F.preferred_entry.line) + ' ' + T.format.priceText(F.preferred_entry.price)) : '—', 'edge ≥ ' + pp(0.02)],
      ['Bettable to', F.bettable_to ? esc(bk(F.bettable_to.line) + ' ' + T.format.priceText(F.bettable_to.price)) : '—', 'edge ≥ ' + pp(0.01)],
      ['Pass beyond', F.pass_beyond ? esc(bk(F.pass_beyond.line)) + ' or worse' : '—', 'the model edge falls under +1.0 pp'],
      F.price_floor_at_current_line ? ['Worst price at ' + esc(bk(cur.line)), esc(T.format.priceText(F.price_floor_at_current_line)), 'the edge still clears +1.0 pp'] : null
    ]) + '</div>';
    var hs = H && H.available ? H.sets.filter(function (x) { return x.shown; })[0] : null;
    if (hs) b += '<div class="banner"><b>Reality check.</b> ' + esc(hs.label) + ': ' + hs.w + '-' + hs.l + ' ATS (' + hs.pct + '%, 95% CI ' + hs.ci[0] + '–' + hs.ci[1] + '%, n=' + hs.n + ') against a 52.4% break-even. The model’s cover probability is a model output; this is what its published numbers actually did.</div>';
    b += '<div class="sub"><h3>Price curve · ' + esc(F.team) + ' at ' + T.format.priceText(F.reference_price) + '</h3><div class="tscroll"><table class="t"><tr><th>Line</th><th>Cover</th><th>Push</th><th>Edge vs break-even</th><th></th><th>EV</th><th>Model grade</th></tr>'
      + F.curve.map(function (r) { return '<tr' + (r.is_current ? ' class="cur"' : '') + '><td class="n">' + esc(bk(r.line)) + (r.is_current ? ' ◂' : '') + '</td><td class="n">' + pct(r.cover, 1) + '</td><td class="n">' + (r.push ? pct(r.push, 1) : '—') + '</td><td class="n">' + pp(r.edge) + '</td><td>' + edgeBar(r.edge) + '</td><td class="n">' + (100 * r.ev).toFixed(1) + '%</td><td>' + esc(r.grade) + '</td></tr>'; }).join('')
      + '</table></div><div class="note">' + esc(F.probability_basis || '') + '. Grades: strong ≥ +4 pp, acceptable ≥ +2 pp (policy ideal), marginal ≥ +1 pp (policy minimum). ' + esc(F.model_probability_note) + '</div></div>';
    b += '<div class="sub"><h3>Key numbers</h3>' + (KN.half_point ? '<div class="banner">' + esc(KN.half_point.text) + '</div>' : '') + KN.warnings.map(function (w) { return '<div class="banner warn">' + esc(w.text) + '</div>'; }).join('')
      + '<div class="pillset">' + KN.table.filter(function (x) { return KN.primary.indexOf(x.margin) >= 0 || x.share >= 0.03; }).map(function (x) { return '<span class="fchip" data-tip="' + esc(x.text) + '">' + x.margin + ' · ' + pct(x.share, 1) + '</span>'; }).join('') + '</div><div class="note">' + esc(KN.basis || '') + '</div></div>';
    return sec('f', 'F · Price decision', St.label + (cur ? ' · ' + bk(cur.line) + ' ' + T.format.priceText(cur.price) + ' · cover ' + pct(cur.cover, 1) + ' vs ' + pct(cur.break_even, 1) : ''), b, true);
  }
  function secG(o) {
    var t = o.timing;
    return sec('g', 'G · Market timing', t.validated ? 'validated evidence' : 'no validated timing evidence', '<div>' + esc(t.text) + '</div><div class="note">' + esc(t.movement_context) + '</div>', false);
  }
  function secH(o) {
    var H = o.historical;
    if (!H || !H.available) return sec('h', 'H · Historical context', 'none', '<div class="empty">' + esc(H ? H.reason : '') + '</div>', false);
    var b = '<table class="t"><tr><th>Comparable set</th><th>ATS</th><th>Rate</th><th>95% CI</th><th>n</th></tr>' + H.sets.map(function (x) {
      return '<tr><td>' + esc(x.label) + '</td><td class="n">' + x.w + '-' + x.l + '</td><td class="n">' + (x.shown ? x.pct + '%' : '<span class="mut">too few</span>') + '</td><td class="n">' + (x.shown ? x.ci[0] + '–' + x.ci[1] + '%' : '—') + '</td><td class="n">' + x.n + '</td></tr>'; }).join('') + '</table>'
      + '<div class="note">' + esc(H.model) + '. ' + esc(H.note) + '</div>';
    return sec('h', 'H · Historical context', H.sets.length + ' comparable sets · n shown', b, false);
  }
  function secAsk(o) {
    var b = '<div class="note" style="margin-top:0">Ask about this game. Answers come only from EdgeDesk’s stored research; what EdgeDesk does not hold is answered UNKNOWN. The status is read, never changed.</div>'
      + '<div class="q">' + o.questions.map(function (q) { return '<button data-q="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>'
      + '<div class="askrow"><input id="askIn" placeholder="e.g. Why are you ' + (o.disagreement.available ? o.disagreement.points.toFixed(0) : 'N') + ' points off the market?"><button class="btn pri" id="askGo">Ask</button></div><div id="askOut"></div>'
      + '<div class="note">For the full conversational desk, <a href="/app.html">open The Desk in the terminal</a>.</div>';
    return sec('ask', 'Ask this game', 'research assistant · answers from structured data only', b, false);
  }
  function secAdv(o) {
    return sec('adv', 'Advanced · raw data', 'sources and the full research object', '<div class="sub" style="margin-top:0"><h3>Sources</h3><table class="t">' + (o.sources || []).map(function (s) { return '<tr><td>' + esc(s.id) + '</td><td class="mono">' + esc(s.path) + '</td><td class="mut">' + esc(s.what || '') + '</td><td class="n">' + esc(s.updated_at ? ago(s.updated_at) : '—') + '</td></tr>'; }).join('') + '</table></div><div class="sub"><h3>Research object</h3><pre class="raw">' + esc(JSON.stringify(o, null, 1)) + '</pre></div>', false);
  }
  function bindGame(o) {
    var id = o.game_id;
    $('watchBtn').onclick = function () {
      var w = store.get(KW, {});
      if (w[id]) { delete w[id]; track('watch_remove', { game_id: id }); } else { w[id] = T.watchEntry(o, readWatchOpts(o)); track('watch_add', { game_id: id }); }
      store.set(KW, w); this.textContent = w[id] ? '★ Watching' : '☆ Watch';
    };
    $('expBtn').onclick = function () {
      var txt = T.exportCard(S.read ? Object.assign({}, o, { read: S.read }) : o);
      try { navigator.clipboard.writeText(txt); this.textContent = 'Copied'; } catch (e) { window.prompt('Research card', txt); }
      track('export', { game_id: id });
    };
    $('flagBtn').onclick = function () { $('flagMenu').classList.toggle('hide'); };
    Array.prototype.forEach.call(document.querySelectorAll('[data-flag]'), function (x) {
      x.onclick = function () {
        track('feedback', { game_id: id, detail: x.getAttribute('data-what') });
        var summary = 'CFB research ' + o.game.away + ' @ ' + o.game.home + ' (' + id + '): ' + x.getAttribute('data-what');
        if (window.EDReport && window.EDReport.open) window.EDReport.open({ category: x.getAttribute('data-flag'), summary: summary });
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-jump]'), function (a) {
      a.onclick = function (e) { e.preventDefault(); var el = document.getElementById(a.getAttribute('data-jump')); if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
    });
    Array.prototype.forEach.call(document.querySelectorAll('details.sec'), function (d) {
      d.addEventListener('toggle', function () { if (d.open) track('section_open', { game_id: id, section: d.getAttribute('data-sec') }); });
    });
    function ask(q) {
      /* the assistant reads the Read the reader is looking at: their clock, their book */
      var a = T.ask(q, S.read ? Object.assign({}, o, { read: S.read }) : o, null);
      track('ask', { game_id: id, detail: a.intent });
      var body = esc(a.text).replace(/^UNKNOWN\./, '<span class="unk">UNKNOWN.</span>');
      if (a.facts && a.facts.length) body += '<details><summary>Sources for ' + a.facts.length + ' claim' + (a.facts.length === 1 ? '' : 's') + '</summary><table class="t"><tr><th>Claim</th><th>Source</th><th>Updated</th><th>Confidence</th></tr>'
        + a.facts.map(function (f) { return '<tr><td>' + esc(f.claim) + '</td><td>' + esc(f.source) + '</td><td class="n">' + esc(f.updated ? ago(f.updated) : '—') + '</td><td>' + esc(f.confidence) + '</td></tr>'; }).join('') + '</table></details>';
      $('askOut').innerHTML = '<div class="ans"><div class="mut" style="font-size:11.5px;margin-bottom:4px">Q: ' + esc(q) + '</div>' + body + '</div>';
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-q]'), function (x) { x.onclick = function () { ask(x.getAttribute('data-q')); }; });
    $('askGo').onclick = function () { var q = $('askIn').value.trim(); if (q) ask(q); };
    $('askIn').onkeydown = function (e) { if (e.key === 'Enter') { var q = this.value.trim(); if (q) ask(q); } };
  }

  /* past game: the postgame research object */
  function renderPast(id) {
    return load('record').then(function (R) {
      var p = (R.postgame || []).filter(function (x) { return x.game_id === id; })[0];
      if (!p) { $('view').innerHTML = '<div class="empty">No research object for game ' + esc(id) + '. It may be outside the current slate. <a href="#/">Back to the queue</a>.</div>'; return; }
      $('view').innerHTML = postgameCard(p, true);
    });
  }

  /* ================================================================ CHARTS */
  /* model vs market over time — home line convention, step lines */
  function timeline(TL, g) {
    var pts = [];
    TL.model.forEach(function (p) { pts.push({ t: Date.parse(p.at), y: -p.home_margin, k: 'ed', raw: p }); });
    TL.market.forEach(function (p) { pts.push({ t: Date.parse(p.at), y: p.home_line, k: 'mk', raw: p }); });
    if (!pts.length) return '<div class="empty">No captured numbers yet.</div>';
    var W = 640, H = 200, L = 46, R = 90, Tp = 12, Bt = 24;
    var t0 = Math.min.apply(null, pts.map(function (p) { return p.t; })), t1 = Math.max.apply(null, pts.map(function (p) { return p.t; }));
    if (t1 - t0 < 3600e3) { t0 -= 1800e3; t1 += 1800e3; }
    var ys = pts.map(function (p) { return p.y; }), y0 = Math.floor(Math.min.apply(null, ys) - 1.5), y1 = Math.ceil(Math.max.apply(null, ys) + 1.5);
    function X(t) { return L + (W - L - R) * (t - t0) / (t1 - t0); }
    function Y(v) { return Tp + (H - Tp - Bt) * (v - y0) / (y1 - y0); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="EdgeDesk fair line and market consensus over time">';
    var step = Math.max(1, Math.round((y1 - y0) / 5));
    for (var v = Math.ceil(y0); v <= y1; v += step) s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="tick" x="' + (L - 6) + '" y="' + (Y(v) + 3) + '" text-anchor="end">' + bk(v) + '</text>';
    s += '<text class="tick" x="' + L + '" y="' + (H - 6) + '">' + esc(new Date(t0).toUTCString().slice(0, 11)) + '</text><text class="tick" x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(new Date(t1).toUTCString().slice(0, 11)) + '</text>';
    function series(k, color, name) {
      var ps = pts.filter(function (p) { return p.k === k; }).sort(function (a, b) { return a.t - b.t; });
      if (!ps.length) return '';
      var d = '', out = '';
      ps.forEach(function (p, i) {
        if (i === 0) d += 'M' + X(p.t) + ',' + Y(p.y);
        else d += 'H' + X(p.t) + 'V' + Y(p.y);
      });
      d += 'H' + X(t1);
      out += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2"/>';
      ps.forEach(function (p) {
        out += '<circle cx="' + X(p.t) + '" cy="' + Y(p.y) + '" r="4" fill="' + color + '" stroke="var(--surface)" stroke-width="2"/>'
          + '<circle cx="' + X(p.t) + '" cy="' + Y(p.y) + '" r="11" fill="transparent" data-tip="<b>' + esc(name) + '</b><br>' + esc(g.home) + ' ' + esc(bk(p.y)) + '<br>' + esc(when(new Date(p.t).toISOString())) + (p.raw.checkpoint ? '<br>' + esc(p.raw.checkpoint) : '') + (p.raw.books ? '<br>' + p.raw.books + ' book(s)' : '') + '"/>';
      });
      var last = ps[ps.length - 1];
      out += '<text class="lab" x="' + (W - R + 6) + '" y="' + (Y(last.y) + 4) + '">' + esc(name) + ' ' + esc(bk(last.y)) + '</text>';
      return out;
    }
    s += series('mk', 'var(--s-mkt)', 'Market') + series('ed', 'var(--s-ed)', 'EdgeDesk');
    s += '</svg>';
    var one = TL.model.length <= 1 && TL.market.length <= 1;
    return '<div class="legend"><span><i style="background:var(--s-ed)"></i>EdgeDesk fair</span><span><i style="background:var(--s-mkt)"></i>Market consensus</span><span class="mut">' + esc(g.home) + ' line (− = ' + esc(g.home) + ' favoured)</span></div><div class="chart">' + s + '</div>'
      + '<div class="note">' + esc(TL.point_in_time) + '.' + (one ? ' One reading of each so far: the timeline fills as the Model Lab takes its checkpoints (OPEN, T72, T48, T24, T12, T6, T2).' : '') + '</div>';
  }
  /* the fair line as a sum: horizontal bars from a running total, one ink,
     direction by position (right = home, left = away) */
  var SHORT = { rating: 'Team strength (neutral)', hfa: 'Home field', qb: 'QB / personnel', matchup: 'Matchup', travel: 'Travel', schedule: 'Rest / schedule',
    injury: 'Availability', rivalry: 'Rivalry', conference: 'Conference', remainder: 'Home field + other terms' };
  function waterfall(o) {
    var W = o.why, g = o.game, rows = W.rows.slice();
    var final = W.final_margin;
    var run = 0, items = rows.map(function (r) { var a = run; run += r.points; return { r: r, a: a, b: run }; });
    var all = [0, final].concat(items.map(function (x) { return x.a; })).concat(items.map(function (x) { return x.b; }));
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all), pad = Math.max(2, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    var Wd = 640, rowH = 26, L = 220, R = 60, H = (items.length + 1) * rowH + 30;
    function X(v) { return L + (Wd - L - R) * (v - lo) / (hi - lo); }
    var s = '<svg viewBox="0 0 ' + Wd + ' ' + H + '" role="img" aria-label="Fair-line decomposition">';
    s += '<line class="axis" x1="' + X(0) + '" x2="' + X(0) + '" y1="4" y2="' + (H - 22) + '"/>';
    s += '<text class="tick" x="' + (X(0) - 6) + '" y="' + (H - 6) + '" text-anchor="end">← ' + esc(g.away) + '</text><text class="tick" x="' + (X(0) + 6) + '" y="' + (H - 6) + '">' + esc(g.home) + ' →</text>';
    items.forEach(function (x, i) {
      var y = 6 + i * rowH, x1 = X(Math.min(x.a, x.b)), x2 = X(Math.max(x.a, x.b)), w = Math.max(2, x2 - x1);
      s += '<text class="lab" x="' + (L - 8) + '" y="' + (y + 14) + '" text-anchor="end">' + esc(SHORT[x.r.key] || (x.r.label.length > 30 ? x.r.label.slice(0, 28) + '…' : x.r.label)) + '</text>'
        + '<rect x="' + x1 + '" y="' + (y + 4) + '" width="' + w + '" height="14" rx="3" fill="' + (x.r.remainder ? 'var(--div-mid)' : 'var(--s-ed)') + '" data-tip="<b>' + esc(x.r.label) + '</b><br>' + esc(x.r.text) + ' pts<br>running total ' + esc(T.format.marginLine(x.b, g.home, g.away, 1)) + (x.r.source ? '<br>' + esc(x.r.source) : '') + '"/>'
        + '<text class="tick" x="' + (x2 + 5) + '" y="' + (y + 15) + '">' + esc(T.util.signed(x.r.points)) + '</text>';
    });
    var yF = 6 + items.length * rowH;
    s += '<text class="lab" x="' + (L - 8) + '" y="' + (yF + 14) + '" text-anchor="end" style="font-weight:700;fill:var(--text)">EDGEDESK FAIR</text>'
      + '<line x1="' + X(final) + '" x2="' + X(final) + '" y1="' + (yF + 2) + '" y2="' + (yF + 20) + '" stroke="var(--text)" stroke-width="2"/>'
      + '<text class="tick" x="' + (X(final) + 6) + '" y="' + (yF + 15) + '" style="fill:var(--text)">' + esc(T.format.marginLine(final, g.home, g.away, 1)) + '</text>';
    s += '</svg>';
    return '<div class="chart">' + s + '</div><table class="t" style="margin-top:6px">' + rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + esc(r.text) + '</td><td class="mut">' + esc(r.source || '') + '</td></tr>'; }).join('')
      + '<tr><td><b>EdgeDesk fair</b></td><td class="n"><b>' + esc(o.edgedesk.fair_text) + '</b></td><td></td></tr></table>';
  }
  /* the outcome distribution: p10–p90 and p25–p75 bands, median, EdgeDesk and market */
  function distStrip(o) {
    var A = o.edgedesk, q = A.quantiles, g = o.game, mk = o.disagreement.available ? o.disagreement.market_margin : null;
    if (!num(q.p10) || !num(q.p90)) return '<div class="empty">No distribution published.</div>';
    var lo = Math.min(q.p10, mk == null ? q.p10 : mk) - 4, hi = Math.max(q.p90, mk == null ? q.p90 : mk) + 4;
    var W = 640, H = 70, L = 16, R = 16;
    function X(v) { return L + (W - L - R) * (v - lo) / (hi - lo); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Outcome distribution">';
    s += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="40" y2="40"/>';
    if (lo < 0 && hi > 0) s += '<line class="grid" x1="' + X(0) + '" x2="' + X(0) + '" y1="18" y2="52"/>'
      + (Math.abs(X(0) - X(q.p10)) > 34 && Math.abs(X(0) - X(q.p90)) > 34 ? '<text class="tick" x="' + X(0) + '" y="66" text-anchor="middle">tie</text>' : '');
    s += '<rect x="' + X(q.p10) + '" y="33" width="' + (X(q.p90) - X(q.p10)) + '" height="14" rx="4" fill="#1c3a5e" data-tip="80% of EdgeDesk outcomes: ' + esc(T.format.marginLine(q.p10, g.home, g.away, 0)) + ' to ' + esc(T.format.marginLine(q.p90, g.home, g.away, 0)) + '"/>';
    s += '<rect x="' + X(q.p25) + '" y="33" width="' + (X(q.p75) - X(q.p25)) + '" height="14" rx="4" fill="#2a5b92" data-tip="middle half: ' + esc(T.format.marginLine(q.p25, g.home, g.away, 0)) + ' to ' + esc(T.format.marginLine(q.p75, g.home, g.away, 0)) + '"/>';
    s += '<line x1="' + X(q.p50) + '" x2="' + X(q.p50) + '" y1="29" y2="51" stroke="var(--text)" stroke-width="2" data-tip="median ' + esc(T.format.marginLine(q.p50, g.home, g.away, 0)) + '"/>';
    s += '<circle cx="' + X(A.home_margin) + '" cy="40" r="5" fill="var(--s-ed)" stroke="var(--surface)" stroke-width="2" data-tip="EdgeDesk fair ' + esc(A.fair_text) + '"/>';
    if (mk != null) s += '<line x1="' + X(mk) + '" x2="' + X(mk) + '" y1="16" y2="56" stroke="var(--s-mkt)" stroke-width="2"/><circle cx="' + X(mk) + '" cy="16" r="8" fill="transparent" data-tip="market ' + esc(T.format.marginLine(mk, g.home, g.away, 1)) + '"/><text class="lab" x="' + X(mk) + '" y="11" text-anchor="middle">market</text>';
    [['p10', q.p10], ['p90', q.p90]].forEach(function (x) { s += '<text class="tick" x="' + X(x[1]) + '" y="64" text-anchor="middle">' + x[0] + '</text>'; });
    s += '</svg>';
    return '<div class="chart">' + s + '</div><table class="t"><tr><th>10th</th><th>25th</th><th>Median</th><th>75th</th><th>90th</th></tr><tr>'
      + [q.p10, q.p25, q.p50, q.p75, q.p90].map(function (v) { return '<td class="n">' + esc(T.format.marginLine(v, g.home, g.away, 0)) + '</td>'; }).join('') + '</tr></table>';
  }
  function consensusPlot(o) {
    var K = o.consensus, g = o.game, mk = o.disagreement.available ? o.disagreement.market_margin : null;
    var vs = K.rows.map(function (r) { return r.home_margin; }).concat(mk == null ? [] : [mk]);
    var lo = Math.min.apply(null, vs) - 2, hi = Math.max.apply(null, vs) + 2;
    var W = 640, rowH = 22, L = 230, R = 70, H = K.rows.length * rowH + 26;
    function X(v) { return L + (W - L - R) * (v - lo) / (hi - lo); }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Model consensus">';
    if (mk != null) s += '<line x1="' + X(mk) + '" x2="' + X(mk) + '" y1="2" y2="' + (H - 20) + '" stroke="var(--s-mkt)" stroke-width="2"/><text class="lab" x="' + X(mk) + '" y="' + (H - 6) + '" text-anchor="middle">market ' + esc(T.format.marginLine(mk, g.home, g.away, 1)) + '</text>';
    K.rows.forEach(function (r, i) {
      var y = 12 + i * rowH;
      s += '<text class="lab" x="' + (L - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(r.label) + '</text><line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/>'
        + '<circle cx="' + X(r.home_margin) + '" cy="' + y + '" r="' + (r.key === 'v1' ? 6 : 4.5) + '" fill="' + (r.independent ? 'var(--s-ed)' : 'var(--surface)') + '" stroke="var(--s-ed)" stroke-width="2" data-tip="<b>' + esc(r.label) + '</b><br>' + esc(r.text) + (r.vs_market != null ? '<br>' + esc(T.util.signed(r.vs_market)) + ' vs market' : '') + '"/>'
        + '<text class="tick" x="' + (W - R + 6) + '" y="' + (y + 4) + '">' + esc(T.util.signed(-r.home_margin, 1)) + '</text>';
    });
    s += '</svg>';
    return '<div class="chart">' + s + '</div>';
  }
  function edgeBar(e) {
    if (!num(e)) return '';
    var w = Math.min(50, Math.abs(e) / 0.2 * 50);
    return '<div class="bar"><i style="' + (e >= 0 ? 'left:50%;width:' + w + '%;background:var(--div-pos)' : 'right:50%;width:' + w + '%;background:var(--div-neg)') + '"></i><span class="z"></span></div>';
  }

  /* ================================================================ BRIEF */
  function renderBrief() {
    track('brief_view');
    load('brief').then(function (B) {
      var h = '<div class="gh"><h1>Weekly research brief</h1><div class="meta">Week ' + esc(B.week) + ' · generated ' + esc(ago(B.generated_at)) + ' · ' + esc(B.champion.model_version) + '</div></div>'
        + '<div class="banner"><b>' + esc(B.headline) + '</b> ' + esc(B.decision.calibrated_ev_note || '') + '</div>';
      B.sections.forEach(function (s) {
        h += '<div class="bsec"><h2>' + esc(s.title) + '</h2>' + (s.rows.length ? s.rows.map(function (r) {
          return '<a class="brow" href="#/game/' + esc(r.game_id) + '"><span class="m">' + esc(r.matchup) + '</span>' + stChip(r.status === 'NO MARKET' ? 'NO_MARKET' : (r.status === 'DATA FAULT' ? 'DATA_FAULT' : r.status), r.status) + '<span class="mono">ED ' + esc(r.model_says) + ' · MKT ' + esc(r.market_says) + '</span><span class="mut">' + esc(r.note || '') + '</span></a>';
        }).join('') : '<div class="empty">' + esc(s.empty) + '</div>') + '</div>';
      });
      h += '<div class="note">' + esc(B.note) + '</div>';
      $('view').innerHTML = h;
    });
  }

  /* ================================================================ WATCHLIST */
  function renderWatch() {
    Promise.all([load('games')]).then(function (res) {
      var G = res[0].games, w = store.get(KW, {}), books = store.get(KB, []);
      var allBooks = {};
      Object.keys(G).forEach(function (k) { (G[k].market.quotes || []).forEach(function (q) { allBooks[q.book] = 1; }); });
      var ids = Object.keys(w);
      var h = '<div class="gh"><h1>Watchlist</h1><div class="meta">Saved on this device. EdgeDesk compares each game with the moment you saved it: fair line, market, quarterbacks, status, and your target price.</div></div>';
      h += '<div class="sub"><h3>My sportsbooks</h3><div class="pillset">' + Object.keys(allBooks).sort().map(function (b) { return '<button class="fchip' + (books.indexOf(b) >= 0 ? ' on' : '') + '" data-book="' + esc(b) + '">' + esc(b) + '</button>'; }).join('') + '</div><div class="note">Best prices are computed only from the books you select. None selected = every captured book.</div></div>';
      if (!ids.length) h += '<div class="empty">Nothing saved yet. Tap ★ on the queue or a research page.</div>';
      ids.forEach(function (id) {
        var e = w[id], o = G[id];
        h += '<div class="sec" style="padding:12px 14px"><div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>' + esc(e.matchup) + '</b>' + (o ? stChip(o.status.key, o.status.label) : '<span class="mut">no longer on the slate</span>') + '<span class="mut" style="font-size:11.5px">saved ' + esc(ago(e.saved_at)) + '</span>' + (o ? '<a href="#/game/' + esc(id) + '" style="margin-left:auto">Open →</a>' : '') + '</div>';
        if (o) {
          var diff = T.watchDiff(e, o, books);
          h += '<ul class="l">' + (diff.length ? diff.map(function (d) { return '<li>' + (d.kind === 'TARGET_REACHED' ? '<b>' : '') + esc(d.text) + (d.kind === 'TARGET_REACHED' ? '</b>' : '') + '</li>'; }).join('') : '<li class="mut">No change since you saved it.</li>') + '</ul>';
          h += '<div class="note">Target: ' + esc(e.team || '—') + ' <input class="tgt" type="number" step="0.5" data-tgt="' + esc(id) + '" value="' + (e.target_line == null ? '' : e.target_line) + '"> at <input class="tgt" type="number" step="1" data-tgp="' + esc(id) + '" value="' + (e.target_price == null ? '' : e.target_price) + '"> <span class="mut">(EdgeDesk’s preferred entry is the default target. Alerts are not sent; the target is stored for when they are.)</span></div>';
        }
        h += '<button class="btn sm" data-unw="' + esc(id) + '">Remove</button></div>';
      });
      $('view').innerHTML = h;
      Array.prototype.forEach.call(document.querySelectorAll('[data-book]'), function (x) { x.onclick = function () { var b = x.getAttribute('data-book'), l = store.get(KB, []), i = l.indexOf(b); if (i >= 0) l.splice(i, 1); else l.push(b); store.set(KB, l); renderWatch(); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-unw]'), function (x) { x.onclick = function () { var w2 = store.get(KW, {}); delete w2[x.getAttribute('data-unw')]; store.set(KW, w2); track('watch_remove', { game_id: x.getAttribute('data-unw') }); renderWatch(); }; });
      Array.prototype.forEach.call(document.querySelectorAll('[data-tgt],[data-tgp]'), function (x) {
        x.onchange = function () {
          var id = x.getAttribute('data-tgt') || x.getAttribute('data-tgp'), w2 = store.get(KW, {}), v = parseFloat(x.value);
          if (!w2[id]) return;
          if (x.hasAttribute('data-tgt')) w2[id].target_line = isFinite(v) ? v : null; else w2[id].target_price = isFinite(v) ? v : null;
          store.set(KW, w2); track('target_set', { game_id: id }); renderWatch();
        };
      });
    });
  }

  /* ================================================================ RECORD */
  var RF_LABEL = { bet: 'BET only', lean: 'LEAN (gap ≥ 2)', gap_2_4: 'Gap 2–4', gap_4_7: 'Gap 4–7', gap_7: 'Gap 7+', rel_80: 'Reliability 80+', rel_lt60: 'Reliability < 60', favorite: 'Favorite', underdog: 'Underdog', conference: 'Conference', nonconference: 'Non-conference' };
  function renderRecord() {
    track('record_view');
    load('record').then(function (R) {
      var rows = R.rows.slice();
      S.recFilters.forEach(function (k) { rows = rows.filter(T.RECORD_FILTERS[k]); });
      var wk = S.recWeek ? rows.filter(function (r) { return String(r.week) === S.recWeek; }) : rows;
      rows = wk;
      var sm = T.recordSummary(rows);
      var h = '<div class="gh"><h1>Record</h1><div class="meta">Every number EdgeDesk published before kickoff, graded as published. Nothing is removed.</div></div>';
      h += kv([
        ['ATS', sm.ats.w + '-' + sm.ats.l + (sm.ats.p ? '-' + sm.ats.p : ''), 'n=' + (sm.ats.w + sm.ats.l) + (sm.ats.pct != null ? ' · ' + sm.ats.pct + '% (95% CI ' + sm.ats.ci[0] + '–' + sm.ats.ci[1] + '%) · break-even 52.4%' : '')],
        ['Average CLV', sm.clv.avg == null ? '—' : T.util.signed(sm.clv.avg, 2) + ' pts', 'n=' + sm.clv.n + (sm.clv.positive_pct != null ? ' · beat the close ' + sm.clv.positive_pct + '%' : '')],
        ['Model versions', Object.keys(sm.versions).length + '', Object.keys(sm.versions).map(function (v) { return esc(v) + ' (' + sm.versions[v] + ')'; }).join('<br>')],
        ['Benchmark', R.benchmark.model_mae == null ? '—' : 'MAE ' + R.benchmark.model_mae, 'the close: ' + R.benchmark.close_mae + ' · EdgeDesk closer than the close in ' + R.benchmark.model_beat_close_share + '% (n=' + R.benchmark.n + ')']
      ]);
      if (sm.note) h += '<div class="note">' + esc(sm.note) + '</div>';
      h += '<div class="sub"><h3>Filter</h3><div class="pillset">' + Object.keys(RF_LABEL).map(function (k) { return '<button class="fchip' + (S.recFilters.indexOf(k) >= 0 ? ' on' : '') + '" data-rf="' + k + '">' + esc(RF_LABEL[k]) + '</button>'; }).join('')
        + ' <select id="recWeek" class="fchip"><option value="">All weeks</option>' + Array.from(new Set(R.rows.map(function (r) { return String(r.week); }))).sort(function (a, b) { return a - b; }).map(function (w) { return '<option' + (S.recWeek === w ? ' selected' : '') + '>' + w + '</option>'; }).join('') + '</select></div>'
        + '<div class="note">BET: none — betting has been disabled for every game in this record. VERIFIED disagreement and confidence at the time are stored from the terminal’s first build on; older rows carry the record rule and the reliability they were published with.</div></div>';
      h += '<div class="sub"><h3>Calibration · when EdgeDesk says X%, it happened Y%</h3><table class="t"><tr><th>EdgeDesk said</th><th>Average said</th><th>Happened</th><th>95% CI</th><th>n</th></tr>' + R.calibration.rows.map(function (x) {
        return '<tr><td>' + esc(x.bucket) + '</td><td class="n">' + (x.shown ? x.predicted + '%' : '—') + '</td><td class="n">' + (x.shown ? x.observed + '%' : '<span class="mut">too few</span>') + '</td><td class="n">' + (x.shown ? x.ci[0] + '–' + x.ci[1] + '%' : '—') + '</td><td class="n">' + x.n + '</td></tr>'; }).join('')
        + '</table><div class="note">' + esc(R.calibration.what) + '. Rates print only at n ≥ ' + R.calibration.min_n + '. ' + esc(R.calibration.cover_note) + '</div></div>';
      var quad = {};
      rows.forEach(function (r) { quad[r.quadrant] = (quad[r.quadrant] || 0) + 1; });
      h += '<div class="sub"><h3>Process vs outcome</h3><div class="pillset">' + Object.keys(quad).sort().map(function (k) { return '<span class="fchip">' + esc(k) + ' <span class="n">' + quad[k] + '</span></span>'; }).join('') + '</div><div class="note">Process is the price against the close (CLV); outcome is the result. A good price that lost is still a good process; a bad price that won is still a bad one. UNKNOWN = no same-source close to measure against.</div></div>';
      var per = 40, page = rows.slice(0, S.recPage * per);
      h += '<div class="sub"><h3>Every graded game (' + rows.length + ')</h3><div class="tscroll"><table class="t"><tr><th>Wk</th><th>Game</th><th>Frozen fair</th><th>Entry (home)</th><th>Close (home)</th><th>Final</th><th>Side</th><th>ATS</th><th>CLV</th><th>Process / outcome</th><th>Rel.</th><th>Version</th></tr>'
        + page.map(function (r) {
          return '<tr><td class="n">' + r.week + '</td><td><a href="#/game/' + esc(r.game_id) + '">' + esc(r.matchup) + '</a></td><td class="n">' + esc(r.home) + ' ' + bk(r.frozen_home_line) + '</td><td class="n">' + (r.market_at_entry == null ? '—' : bk(r.market_at_entry)) + '</td><td class="n">' + bk(r.close_home_line) + '</td><td>' + esc(r.final_text) + '</td><td>' + esc(r.side_team || '—') + '</td><td>' + esc(r.ats) + '</td><td class="n">' + (r.clv == null ? '—' : T.util.signed(r.clv, 1)) + '</td><td>' + esc(r.quadrant) + '</td><td class="n">' + (r.reliability == null ? '—' : r.reliability) + '</td><td class="mono mut">' + esc((r.model_version || '').replace('edgedesk_cfb_', '')) + '</td></tr>';
        }).join('') + '</table></div>' + (rows.length > page.length ? '<button class="btn sm" id="more">Show more</button>' : '') + '</div>';
      h += '<div class="sub"><h3>Postgame research</h3>' + (R.postgame || []).slice().sort(function (a, b) { return Date.parse(b.kickoff) - Date.parse(a.kickoff); }).slice(0, 12).map(function (p) { return postgameCard(p, false); }).join('') + '</div>';
      h += '<div class="sub"><h3>Model versions</h3><table class="t">' + R.governance.map(function (x) { return '<tr><td>' + esc(x.label || '') + '</td><td class="mono">' + esc(x.model_version) + '</td><td>' + esc(x.role) + '</td><td class="mut">' + esc(x.reason || '') + '</td></tr>'; }).join('') + '</table><div class="note">Performance is never merged across model versions: every graded row names the version that published it.</div></div>';
      h += '<div class="sub"><h3>Product quality scorecard</h3><table class="t">' + R.scorecard.map(function (x) { return '<tr><td>' + esc(x.dimension) + '</td><td>' + esc(x.value) + '</td><td class="mut">' + esc(x.evidence) + '</td></tr>'; }).join('') + '</table><div class="note">Eight dimensions, never collapsed into one score.</div></div>';
      h += '<ul class="l note">' + R.rules.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      $('view').innerHTML = h;
      Array.prototype.forEach.call(document.querySelectorAll('[data-rf]'), function (x) { x.onclick = function () { var k = x.getAttribute('data-rf'), i = S.recFilters.indexOf(k); if (i >= 0) S.recFilters.splice(i, 1); else S.recFilters.push(k); S.recPage = 1; track('record_filter', { detail: k }); renderRecord(); }; });
      $('recWeek').onchange = function () { S.recWeek = this.value || null; S.recPage = 1; renderRecord(); };
      if ($('more')) $('more').onclick = function () { S.recPage++; renderRecord(); };
    });
  }
  function postgameCard(p, full) {
    var r = p.record, pm = p.postmortem;
    var h = '<div class="sec" style="padding:12px 14px"><div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>' + esc(p.matchup) + '</b><span class="mut">' + esc(p.final) + '</span><span class="fchip">' + esc(r.quadrant) + '</span>' + (pm.available ? '<span class="fchip">' + esc(pm.class.replace(/_/g, ' ')) + '</span>' : '') + (full ? '' : '<a href="#/game/' + esc(p.game_id) + '" style="margin-left:auto">Open →</a>') + '</div>'
      + '<div class="note">Frozen fair ' + esc(r.home) + ' ' + bk(r.frozen_home_line) + ' · close ' + bk(r.close_home_line) + ' · side ' + esc(r.side_team || '—') + ' · ' + esc(r.ats) + (r.clv != null ? ' · CLV ' + T.util.signed(r.clv, 1) : '') + '</div>'
      + (pm.available ? '<div>' + esc(pm.text) + '</div>' : '')
      + readAtDecision(p);
    if (full) {
      h += '<div class="sub"><h3>EdgeDesk vs market before kickoff</h3>' + timeline(p.timeline, { home: r.home, away: r.away }) + '</div>';
      if (p.edge_decay.available) h += '<div class="sub"><h3>Edge decay</h3><b>' + esc(p.edge_decay.verdict_text || '') + '</b> ' + esc(p.edge_decay.text || '') + '</div>';
      if (pm.available) h += '<div class="note">Not measured: ' + esc(pm.not_measured.join('; ')) + '. ' + esc(pm.note) + '</div>';
    }
    return h + '</div>';
  }

  /* the EdgeDesk Read AT THE TIME OF DECISION — the frozen snapshot, never a hindsight value */
  function readAtDecision(p) {
    var x = p.read_at_decision, gr = p.read_grade;
    if (!x) return '';
    return '<div class="rad"><span class="l">EdgeDesk Read at the time of decision</span> ' + rdChip(x.timing_read, true) + ' '
      + esc((x.team || '—') + ' ' + (x.line == null ? '' : bk(x.line)) + ' ' + T.format.priceText(x.price) + (x.book ? ' · ' + x.book : '') + ' · cover ' + pct(x.cover_probability, 1) + (x.probability_basis === 'RAW' ? ' raw' : '') + ' vs ' + pct(x.break_even, 1)
        + (x.target_line != null ? ' · target ' + bk(x.target_line) : '') + (x.bettable_to_line != null ? ' · bettable to ' + bk(x.bettable_to_line) : '') + ' · frozen ' + when(x.recorded_at))
      + (gr ? ' <span class="mut">· graded: ' + esc((gr.result ? gr.result + ' at the recorded number' : 'no result') + (gr.clv_pts != null ? ', CLV ' + T.util.signed(gr.clv_pts, 1) + ' pts' : '') + (gr.hypothetical ? ' (hypothetical)' : '')) + '</span>' : '') + '</div>';
  }
  /* THE READ RECORD — every frozen read and the validation dashboard */
  function renderReadRecord() {
    track('record_view');
    load('record').then(function (R) {
      var RR = R.read_record || { validation: null, reads: [], grades: [] }, V = RR.validation || {};
      var gi = {}; (RR.grades || []).forEach(function (g) { gi[g.read_id] = g; });
      var h = '<div class="gh"><h1>EdgeDesk Read record</h1><div class="meta">Every price-specific read EdgeDesk froze, graded once against the close and the final at the number it recorded. Timing is validated by CLV and entry quality — not by whether BET EARLY reads happened to win.</div></div>';
      var blk = function (b, extra) {
        if (!b) return '';
        return '<tr><td>' + esc(b.label) + '</td><td class="n">' + b.n + '</td><td class="n">' + b.graded + '</td><td class="n">' + (b.rates_shown ? T.util.signed(b.mean_clv_pts, 2) : '<span class="mut">n ' + b.clv_n + '</span>') + '</td><td class="n">' + (b.rates_shown && b.positive_clv_rate != null ? pct(b.positive_clv_rate, 0) : '—') + '</td><td class="n">' + (b.rates_shown && b.ats_rate != null ? pct(b.ats_rate, 0) : '—') + '</td><td class="mut">' + (extra || '') + '</td></tr>';
      };
      h += '<div class="sub"><h3>Validation dashboard</h3><div class="tscroll"><table class="t"><tr><th>Read</th><th>n</th><th>Graded</th><th>Avg CLV</th><th>+CLV</th><th>ATS</th><th>Also</th></tr>'
        + blk(V.bet_early, V.bet_early && V.bet_early.rates_shown ? 'later worse ' + pct(V.bet_early.later_worse_rate, 0) + ' · line preserved ' + T.util.signed(V.bet_early.mean_line_preserved_pts, 2) : 'later-worse rate and line preserved print at n ≥ ' + (V.min_n_for_rates || 30))
        + blk(V.bet) + blk(V.wait, V.wait ? 'all waits ' + V.wait.n_all_waits + (V.wait.mean_price_improvement_pts != null ? ' · avg improvement ' + T.util.signed(V.wait.mean_price_improvement_pts, 2) + ' pts' : '') + (V.wait.wait_success_rate != null ? ' · wait success ' + pct(V.wait.wait_success_rate, 0) : '') + (V.wait.target_reached_rate != null ? ' · target reached ' + pct(V.wait.target_reached_rate, 0) : '') : '')
        + blk(V.research) + blk(V.pass, 'counterfactual: never a wager') + blk(V.price_gone, 'counterfactual')
        + '</table></div><div class="note">' + esc(V.rule || '') + ' Reads frozen: ' + (V.n_reads || 0) + ' · graded: ' + (V.n_grades || 0) + ' · reads with alternates: ' + (V.alternates ? V.alternates.n_reads_with_alts : 0) + '.</div></div>';
      h += '<div class="sub"><h3>Frozen reads (newest first)</h3>' + (RR.reads.length ? '<div class="tscroll"><table class="t"><tr><th>Frozen</th><th>Game</th><th>Read</th><th>Price</th><th>Cover / BE</th><th>EV</th><th>Bettable / target</th><th>Grade</th></tr>'
        + RR.reads.slice().reverse().slice(0, 150).map(function (x) {
          var g = gi[x.read_id];
          return '<tr><td class="n">' + esc(when(x.recorded_at)) + '</td><td>' + esc(x.away + ' @ ' + x.home) + '</td><td>' + rdChip(x.timing_read) + '</td><td class="n">' + esc((x.team || '') + ' ' + (x.line == null ? '' : bk(x.line)) + ' ' + T.format.priceText(x.price)) + '<div class="mut">' + esc(x.book || '') + '</div></td>'
            + '<td class="n">' + pct(x.cover_probability, 1) + (x.probability_basis === 'RAW' ? ' raw' : '') + ' / ' + pct(x.break_even, 1) + '</td><td class="n">' + (num(x.estimated_ev) ? (x.estimated_ev >= 0 ? '+' : '−') + Math.abs(100 * x.estimated_ev).toFixed(1) + '%' : '—') + '</td>'
            + '<td class="n">' + (x.bettable_to_line != null ? bk(x.bettable_to_line) : '—') + (x.target_line != null ? ' / ' + bk(x.target_line) : '') + '</td><td>' + (g ? esc((g.result || '—') + (g.clv_pts != null ? ' · CLV ' + T.util.signed(g.clv_pts, 1) : '') + (g.hypothetical ? ' · hyp.' : '')) : '<span class="mut">pending</span>') + '</td></tr>';
        }).join('') + '</table></div>' : '<div class="empty">No read has been frozen yet.</div>') + '</div>';
      h += '<ul class="l note">' + (RR.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
      $('view').innerHTML = h;
    });
  }

  /* ================================================================ WHY / TERMS */
  function renderWhy() {
    track('why_view');
    var b = S.board, rh = b.record_headline;
    var cards = [
      ['An independent number, first', 'EdgeDesk prices every FBS game from football information alone — opponent-adjusted results, home field, quarterback, matchup, travel, rest. The market never enters the fair line, so a disagreement is a real disagreement, not an echo.'],
      ['Why, in points', 'The fair line is an explicit sum of the champion engine’s own terms. You see the team-strength edge, the home field and every adjustment, and where the market’s number would have to differ.'],
      ['What would have to be wrong', 'For every real disagreement EdgeDesk asks which of its assumptions the market is implicitly rejecting, measured against each input’s own uncertainty — ranked, never presented as equally likely.'],
      ['Integrity before interest', 'A 7-point gap is INVESTIGATE until it passes every integrity check. Most large gaps are missing information, and EdgeDesk says so rather than turning them into headlines.'],
      ['Price discipline', 'Every read is tied to a price: cover probability against break-even at each half point, the bettable-to number and where to pass — from the champion’s empirical margin distribution with real key-number mass.'],
      ['Uncertainty you can see', 'Outcome ranges, model agreement from dispersion, quarterback and availability status, reliability and data coverage — shown beside the number, kept apart from any probability.'],
      ['Market context, not market following', 'The model-versus-market timeline shows when a disagreement opened, whether the market moved toward EdgeDesk, and how much value is already gone.'],
      ['A record that is not edited', 'The record grades every published number against the close and the final: ' + (rh ? rh.ats.w + '-' + rh.ats.l + ' ATS (n=' + (rh.ats.w + rh.ats.l) + ') and an average CLV of ' + (rh.clv.avg == null ? '—' : T.util.signed(rh.clv.avg, 2)) + ' pts (n=' + rh.clv.n + ')' : 'see the Record') + '. That is not a winning record, and it is printed first.'],
      ['PASS is an answer', 'Betting is disabled until the decision policy passes its promotion gate. On a week with nothing certified, EdgeDesk says so and explains every refusal.']
    ];
    var h = '<div class="gh"><h1>Why EdgeDesk</h1><div class="meta">What a scanner tells you: one book’s price differs from another’s. What EdgeDesk adds: what the game itself is worth, why, how sure it is, and what price that implies.</div></div>'
      + '<div class="why-grid">' + cards.map(function (c) { return '<div class="c"><h3>' + esc(c[0]) + '</h3><p>' + esc(c[1]) + '</p></div>'; }).join('') + '</div>'
      + '<div class="banner" style="margin-top:14px"><b>No performance claim is made here.</b> EdgeDesk’s published record is on the Record page with every sample size. Capabilities above are what the product does, not a promise about results.</div>';
    $('view').innerHTML = h;
  }
  function renderTerms() {
    var h = '<div class="gh"><h1>Terms</h1><div class="meta">One definition per word, everywhere EdgeDesk uses it.</div></div><table class="t">'
      + Object.keys(T.TERMS).map(function (k) { return '<tr><td class="mono">' + esc(k.replace(/_/g, ' ')) + '</td><td>' + esc(T.TERMS[k]) + '</td></tr>'; }).join('') + '</table>'
      + '<div class="sub"><h3>Status</h3><table class="t">' + T.STATUS_KEYS.map(function (k) { return '<tr><td>' + stChip(k) + '</td><td>' + esc(T.STATUS[k].means) + '</td></tr>'; }).join('') + '</table></div>'
      + '<div class="sub"><h3>Older labels, and what they are now</h3><table class="t">' + Object.keys(T.LEGACY_MAP).map(function (k) { return '<tr><td class="mono">' + esc(k) + '</td><td>' + esc(T.LEGACY_MAP[k]) + '</td></tr>'; }).join('') + '</table></div>';
    $('view').innerHTML = h;
  }

  route();
})();
