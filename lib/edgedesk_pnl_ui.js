/* ===========================================================================
   EDGEDESK P&L — the Record's Profit & Loss section (browser, ES5).
   docs/pnl/DESIGN.md

   Renders record/pnl/ (tools/record/pnl_ledger.js) into a host element, the
   same on the app's Records tab and the public record page:

     summary cards · cumulative P&L with running peak and drawdown · drawdown
     analytics · game markets vs player props · breakdowns (league, market,
     prop type, side, book, model edge, grade, unit size, odds, week, model
     version) · edge calibration · CLV vs P&L · player prop performance ·
     the auditable P&L ledger with filters, search and sort · data quality

   RULES IT KEEPS
     - It prints what the build computed. The default view (all, flat) is the
       precomputed record/pnl/summary.json; any other scope, strategy or filter
       is recomputed from the ledger rows by lib/edgedesk_pnl.js — the same
       functions the build ran, so the two can never disagree.
     - Units first. Dollars only when the HOST passes the reader's own unit
       value (opts.unitValue → EDBankroll.unitValue of the reader's settings);
       there is no default dollar amount anywhere in this file.
     - A row without a captured price never shows a profit: it says
       "P&L unavailable — entry price not captured".
     - Every figure carries its sample; a small sample says so.
     - Every string from data is escaped (esc) or set with textContent.

   window.EDPnlUI.mount(host, { base: '', unitValue: fn, surface: 'app' | 'public' })
     → { reload(), refresh(), state }
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPnlUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var VERSION = 'edgedesk_pnl_ui_v1';
  function K() {
    var k = root.EDPnl;
    if (!k && typeof require === 'function') { try { k = require('./edgedesk_pnl.js'); } catch (e) { k = null; } }
    if (!k) throw new Error('EDPnlUI needs lib/edgedesk_pnl.js loaded first');
    return k;
  }

  /* ------------------------------------------------------------ helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tone(v) { return !isNum(v) || Math.abs(v) < 0.005 ? 'pnl-flat' : v > 0 ? 'pnl-pos' : 'pnl-neg'; }
  function pct(v, dp, signed) { return K().fmtPct(v, dp == null ? 1 : dp, signed); }
  function dateShort(iso) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return String(iso).slice(5, 10); }
  }
  function dateLong(iso) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return String(iso); }
  }
  function lineTxt(v) { if (!isNum(v)) return '—'; var x = Math.round(v * 10) / 10; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toString(); }
  function numTxt(v, dp) { return isNum(v) ? (Math.round(v * Math.pow(10, dp || 1)) / Math.pow(10, dp || 1)).toString() : '—'; }
  function signed(v, dp, unit) { if (!isNum(v)) return '—'; var x = Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(dp) + (unit || ''); }
  var RESULT_TXT = { win: 'Win', loss: 'Loss', push: 'Push', void: 'Void', pending: 'Pending' };
  var LEAGUE_TXT = { NFL: 'NFL', CFB: 'College Football' };
  var MARKET_TXT = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline', player_prop: 'Player prop' };
  var STATUS_SHORT = { VERIFIED: 'Verified', PENDING: 'Pending', VOID: 'Void', NO_ENTRY_PRICE: 'No entry price', SIMULATED_PRICE: 'Simulated price', INVALID_PRICE: 'Invalid price', INVALID_STAKE: 'Invalid stake' };

  /* ------------------------------------------------------------ mount */
  function mount(host, opts) {
    opts = opts || {};
    var S = {
      host: host, opts: opts, base: opts.base || '', sum: null, rows: null, byId: {}, err: null, rowsErr: null,
      mode: 'flat', scope: 'all', money: 'u', memo: {},
      f: { q: '', league: '', market: '', cls: '', result: '', status: '', book: '', version: '', week: '', from: '', to: '', edge: '', stake: '' },
      sort: { k: 'date', d: -1 }, page: 0, per: 25, open: {}, pq: '', ppage: 0, player: null, pcls: 'BET', fopen: false, chartW: 0
    };
    host.classList.add('pnl-root');
    host.innerHTML = '<div class="pnl-loading">Loading the profit &amp; loss record…</div>';
    wire(S);
    load(S);
    var api = {
      state: S,
      reload: function () { S.memo = {}; load(S); },
      refresh: function () { renderAll(S); }
    };
    host.__pnl = api;
    return api;
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function load(S) {
    return fetchJson(S.base + 'record/pnl/summary.json').then(function (sum) {
      if (!sum || sum.schema !== 'edgedesk_pnl_summary_v1') throw new Error('unexpected summary');
      S.sum = sum; S.err = null; renderAll(S);
      var rf = sum.rows_file || ('record/pnl/rows_' + sum.season + '.json');
      return fetchJson(S.base + rf).then(function (page) {
        S.rows = expand(page); S.byId = {}; S.rows.forEach(function (x) { S.byId[x.recommendation_id] = x; }); S.memo = {};
        renderAll(S);
      }).catch(function (e) { S.rowsErr = String((e && e.message) || e); renderAll(S); });
    }).catch(function (e) {
      S.err = String((e && e.message) || e);
      S.host.innerHTML = '<div class="pnl-empty"><b>The profit &amp; loss record could not be read.</b><br>' + esc(S.err) + '</div>';
    });
  }
  function expand(page) {
    var c = (page && page.cols) || [];
    return ((page && page.rows) || []).map(function (a) { var o = {}; c.forEach(function (k, i) { o[k] = a[i]; }); return o; });
  }

  /* the unit value is the host's (the reader's own); null = units only */
  function unit(S) {
    if (typeof S.opts.unitValue !== 'function') return null;
    try { var u = S.opts.unitValue(); return u && isNum(u.unit) && u.unit > 0 ? u : null; } catch (e) { return null; }
  }
  function dollarsOn(S) { return S.money === '$' && !!unit(S); }
  function money(S, u, abs) {
    if (!isNum(u)) return '—';
    var P = K();
    if (dollarsOn(S)) { var d = P.dollars(abs ? Math.abs(u) : u, unit(S).unit); return abs ? '$' + Math.abs(d).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : P.fmtDollars(d); }
    return abs ? Math.abs(u).toFixed(2) + 'u' : P.fmtUnits(u);
  }

  /* ------------------------------------------------------------ the view */
  function scoped(S) { return S.rows ? K().scopeRows(S.rows, S.scope) : null; }
  function current(S) {
    var key = S.scope + '|' + S.mode;
    if (S.memo[key]) return S.memo[key];
    var pre = S.sum && S.sum.views && S.sum.views[S.scope] ? S.sum.views[S.scope][S.mode] : null;
    var v;
    if (pre && pre.breakdowns) v = pre;                                  /* precomputed by the build */
    else if (S.rows) v = K().view(scoped(S), S.mode, true);              /* the same functions, on the ledger */
    else v = pre;
    if (v && S.rows) S.memo[key] = v;
    return v;
  }
  function quality(S) { return S.sum && S.sum.views && S.sum.views[S.scope] ? S.sum.views[S.scope].data_quality : null; }

  /* ------------------------------------------------------------ rendering */
  function renderAll(S) {
    if (!S.sum) return;
    if (!S.host.querySelector('[data-r="top"]')) {
      S.host.innerHTML = '<div data-r="top"></div><section class="pnl-sec" data-r="players"></section><section class="pnl-sec" data-r="ledger"></section><div class="pnl-pop" hidden role="tooltip"></div>';
    }
    renderTop(S);
    renderPlayersShell(S);
    renderPlayers(S);
    renderLedgerShell(S);
    renderLedger(S);
  }

  function help(key, label) {
    return '<button type="button" class="pnl-help" data-help="' + esc(key) + '" aria-label="' + esc('What is ' + (label || key) + '?') + '">?</button>';
  }
  function seg(attr, items, cur) {
    return '<div class="pnl-seg" role="group">' + items.map(function (it) {
      var on = it[0] === cur;
      return '<button type="button" ' + attr + '="' + esc(it[0]) + '" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(it[1]) + '</button>';
    }).join('') + '</div>';
  }
  function sampleTag(s) {
    if (!s) return '';
    return '<span class="pnl-sample ' + (s.warn ? 'warn' : '') + '" title="' + esc(s.text) + '">' + esc(s.label) + ' · n=' + s.n + '</span>';
  }

  function renderTop(S) {
    var P = K(), v = current(S), s = v ? v.summary : null, q = quality(S) || {}, u = unit(S);
    var h = '';
    /* the public page carries its own heading and introduction */
    if (S.opts.surface === 'public') h += '<div class="pnl-head"><div class="pnl-ey">What Profit &amp; Loss means ' + help('pnl', 'P&L') + '</div></div>';
    else h += '<div class="pnl-head"><div class="pnl-ey">Profit &amp; Loss ' + help('pnl', 'P&L') + '</div>'
      + '<h3 class="pnl-h">If you had followed every EdgeDesk recommendation</h3>'
      + '<p class="pnl-lede">Every recommendation EdgeDesk classified <b>BET</b>, at the exact price it recorded when it made the call. Nothing is re-priced with today’s odds or re-predicted with today’s model. A result without a captured price counts in the win/loss record but never in P&amp;L.</p></div>';
    /* controls: one row, above everything they scope */
    h += '<div class="pnl-controls">'
      + '<div class="pnl-ctl"><span class="pnl-cl">Strategy ' + help(S.mode === 'staked' ? 'staked' : 'flat', 'this strategy') + '</span>' + seg('data-mode', [['flat', 'Flat 1u'], ['staked', 'EdgeDesk staking']], S.mode) + '</div>'
      + '<div class="pnl-ctl pnl-ctl-scope"><span class="pnl-cl">Show</span>' + seg('data-scope', P.SCOPE_ORDER.map(function (k) { return [k, P.SCOPES[k].label]; }), S.scope) + '</div>'
      + (u ? '<div class="pnl-ctl"><span class="pnl-cl">Display ' + help('units', 'a unit') + '</span>' + seg('data-money', [['u', 'Units'], ['$', 'Dollars']], S.money) + '</div>' : '')
      + '</div>';
    if (u && S.money === '$') h += '<div class="pnl-note">Dollars use ' + esc(u.text || ('your $' + u.unit + ' unit')) + '. Only you see this; the record itself is kept in units.</div>';
    if (!s) { S.host.querySelector('[data-r="top"]').innerHTML = h + '<div class="pnl-empty">Loading…</div>'; return; }

    /* the sample, before any number */
    if (!s.n) h += '<div class="pnl-samplebar warn"><b>Nothing to judge yet</b> — no BET with a captured price has settled in this view. '
      + (q.pending ? q.pending + ' priced recommendation' + (q.pending === 1 ? ' is' : 's are') + ' pending and settle as their games finish. ' : '')
      + 'Until then every figure below is empty rather than estimated.</div>';
    else h += '<div class="pnl-samplebar ' + (s.sample.warn ? 'warn' : '') + '"><b>' + esc(s.sample.label) + '</b> — ' + s.n + ' settled bet' + (s.n === 1 ? '' : 's') + ' with a captured price'
      + (s.sample.warn ? '. Results over a sample this size swing widely; a winning or losing record here proves nothing yet.' : '.') + '</div>';

    /* summary cards */
    var st = s.streaks || {}, dd = s.drawdown || {};
    var be = s.break_even_pct, wr = s.win_rate_pct;
    if (!s.n) {
      h += '<div class="pnl-cards">'
        + card('Net ' + (dollarsOn(S) ? 'dollars' : 'units'), money(S, 0), 'no settled bet with a captured price yet', 'pnl-flat', 'pnl', 'hero')
        + card('P&L eligible bets', '0', (q.pending || 0) + ' pending · ' + (q.missing_entry_odds || 0) + ' without a price', '', 'missing')
        + '</div>';
    } else h += '<div class="pnl-cards">'
      + card('Net ' + (dollarsOn(S) ? 'dollars' : 'units'), money(S, s.net_units), s.n ? s.record + ' · ' + (S.mode === 'staked' ? 'at the recommended stakes' : '1.00u on every bet') : 'no settled bet with a captured price yet', tone(s.net_units), 'pnl', 'hero')
      + card('ROI', s.roi_pct == null ? '—' : pct(s.roi_pct, 1, true), 'net profit ÷ total risked', tone(s.roi_pct), 'roi')
      + card('Total risked', money(S, s.risked_units, true), 'pushes and voids return the stake')
      + card('P&L eligible bets', String(s.n), (q.pending || 0) + ' pending · ' + (q.missing_entry_odds || 0) + ' without a price', '', 'missing')
      + card('Average odds', s.avg_odds == null ? '—' : P.fmtOdds(s.avg_odds), 'stake-weighted, from decimal prices')
      + card('Win rate', wr == null ? '—' : pct(wr, 1), 'wins ÷ (wins + losses)', wr != null && be != null ? (wr >= be ? 'pnl-pos' : 'pnl-neg') : '')
      + card('Break-even win rate', be == null ? '—' : pct(be, 1), 'what these prices needed', '', 'break_even')
      + card('Max drawdown', money(S, s.max_drawdown_units), dd.max_began ? 'from the ' + dateShort(dd.max_began + 'T12:00:00Z') + ' peak' : 'from the running peak', tone(s.max_drawdown_units), 'drawdown')
      + card('Peak profit', money(S, s.peak_profit_units), 'highest point of the running total', tone(s.peak_profit_units))
      + card('Current streak', st.current || '—', 'pushes neither extend nor break it', st.current_kind === 'win' ? 'pnl-pos' : st.current_kind === 'loss' ? 'pnl-neg' : '')
      + card('Longest win streak', st.longest_win ? 'W' + st.longest_win : '—', '')
      + card('Longest losing streak', st.longest_loss ? 'L' + st.longest_loss : '—', '')
      + card('Avg CLV', s.avg_clv_points == null ? '—' : signed(s.avg_clv_points, 2, ' pts'), s.avg_clv_prob_pp == null ? (s.clv_n ? 'line CLV, n=' + s.clv_n : 'no close captured yet') : 'price CLV ' + signed(s.avg_clv_prob_pp, 2, ' pp'), tone(s.avg_clv_points), 'clv')
      + card('CLV hit rate', s.clv_hit_rate_pct == null ? '—' : pct(s.clv_hit_rate_pct, 1), s.clv_hit_n ? 'beat the close on ' + s.clv_hit_n + ' measured' : 'no close measured yet')
      + card('Profit factor', s.profit_factor == null ? '—' : s.profit_factor.toFixed(2), s.profit_factor_note || 'gross units won ÷ gross units lost', s.profit_factor == null ? '' : s.profit_factor >= 1 ? 'pnl-pos' : 'pnl-neg', 'profit_factor')
      + '</div>';

    h += qualityHTML(S, v, q);
    h += '<section class="pnl-sec"><div class="pnl-sh"><h4>Cumulative P&amp;L</h4><span class="pnl-sub">' + esc(P.SCOPES[S.scope].label) + ' · ' + (S.mode === 'staked' ? 'EdgeDesk staking' : 'flat 1u') + ' · in the order the games were played</span></div>'
      + '<div class="pnl-legend"><span><i class="k-line"></i>Cumulative P&amp;L</span><span><i class="k-peak"></i>Running peak</span><span><i class="k-dd"></i>Drawdown</span></div>'
      + '<div class="pnl-chart" data-chart></div>'
      + '<p class="pnl-note">Every point is one settled bet, and every one is a row in the P&amp;L ledger below. Hover or tap the chart, or use the arrow keys on it, for the bet behind each step.</p></section>';
    h += drawdownHTML(S, s);
    h += compareHTML(S, v);
    h += breakdownsHTML(S, v);
    h += calibrationHTML(S, v);
    h += clvHTML(S, v);
    h += glossaryHTML(S);
    var top = S.host.querySelector('[data-r="top"]');
    top.innerHTML = h;
    drawChart(S, v);
  }
  function card(label, value, sub, cls, helpKey, kind) {
    return '<div class="pnl-card' + (kind === 'hero' ? ' hero' : '') + '"><div class="pnl-cl">' + esc(label) + (helpKey ? ' ' + help(helpKey, label) : '') + '</div>'
      + '<div class="pnl-v ' + (cls || '') + '">' + esc(value) + '</div>' + (sub ? '<div class="pnl-cs">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function qualityHTML(S, v, q) {
    var ex = (S.sum.excluded_sources || []), ro = (v && v.record_only_by_market) || {};
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>Data quality</h4><span class="pnl-sub">what the P&amp;L above is built from, and what it is not</span></div><div class="pnl-dq">'
      + dq('Verified P&L records', q.verified, 'settled at a captured entry price (every grade)')
      + dq('Missing entry odds', q.missing_entry_odds, 'P&L unavailable — entry price not captured', 'missing')
      + dq('Pending', q.pending, 'not settled yet')
      + dq('Voids', q.voids, 'stake returned')
      + dq('Historical records not P&L eligible', q.not_pnl_eligible, 'a result, but no price to price it at')
      + dq('Corrected after settlement', q.corrected, 'logged on the row, never silent')
      + '</div>';
    var keys = Object.keys(ro);
    if (keys.length) {
      h += '<p class="pnl-note"><b>Record-only results</b> (the published model number, graded at the close; no price was ever captured, so no P&amp;L): '
        + keys.map(function (k) { return esc(k) + ' ' + esc(ro[k].record) + (ro[k].win_rate_pct != null ? ' (' + ro[k].win_rate_pct.toFixed(1) + '%)' : ''); }).join(' · ')
        + '. Kept apart by market: a straight-up record and a record against the spread are not the same thing.</p>';
    }
    if (ex.length) {
      h += '<details class="pnl-det"><summary>Left out, and why (' + ex.length + ')</summary><ul class="pnl-ul">'
        + ex.map(function (x) { return '<li><b>' + esc(x.source) + '</b> — ' + esc(x.rows) + ' row' + (x.rows === 1 ? '' : 's') + ': ' + esc(x.reason) + '</li>'; }).join('') + '</ul></details>';
    }
    if ((S.sum.integrity_alerts || []).length) h += '<p class="pnl-note warn"><b>' + S.sum.integrity_alerts.length + ' integrity alert(s):</b> a source tried to change a recorded recommendation; the ledger kept what was recommended.</p>';
    return h + '</section>';
  }
  function dq(label, n, sub, helpKey) {
    return '<div class="pnl-dqi"><div class="pnl-dqn">' + esc(n == null ? 0 : n) + '</div><div class="pnl-dql">' + esc(label) + (helpKey ? ' ' + help(helpKey, label) : '') + '</div><div class="pnl-cs">' + esc(sub) + '</div></div>';
  }

  function drawdownHTML(S, s) {
    var d = s.drawdown || {};
    var rec = d.max_recovered ? dateShort(d.max_recovered + 'T12:00:00Z') : (d.max < 0 ? 'Not yet recovered' : '—');
    var lr = d.longest_recovery_days == null ? '—' : d.longest_recovery_days + ' day' + (d.longest_recovery_days === 1 ? '' : 's') + (d.longest_recovery_ongoing ? ' (still under water)' : '');
    return '<section class="pnl-sec"><div class="pnl-sh"><h4>Drawdown ' + help('drawdown', 'drawdown') + '</h4><span class="pnl-sub">measured from the running peak of cumulative units</span></div><div class="pnl-dd">'
      + ddi('Current drawdown', money(S, d.current), tone(d.current))
      + ddi('Maximum drawdown', money(S, d.max), tone(d.max))
      + ddi('Maximum drawdown began', d.max_began ? dateShort(d.max_began + 'T12:00:00Z') : '—', '')
      + ddi('Recovered', rec, d.max_recovered ? 'pnl-pos' : '')
      + ddi('Longest recovery period', lr, '')
      + '</div></section>';
  }
  function ddi(l, v, cls) { return '<div class="pnl-ddi"><div class="pnl-cl">' + esc(l) + '</div><div class="pnl-v sm ' + (cls || '') + '">' + esc(v) + '</div></div>'; }

  function compareHTML(S, v) {
    var c = v.compare || {};
    function col(title, x) {
      x = x || {};
      return '<div class="pnl-cmp"><div class="pnl-cmph">' + esc(title) + ' ' + sampleTag(x.sample) + '</div>'
        + row('Bets', String(x.n || 0)) + row('Units', money(S, x.net_units), tone(x.net_units)) + row('ROI', x.roi_pct == null ? '—' : pct(x.roi_pct, 1, true), tone(x.roi_pct))
        + row('CLV', x.avg_clv_points == null ? '—' : signed(x.avg_clv_points, 2, ' pts'), tone(x.avg_clv_points)) + row('Win %', x.win_rate_pct == null ? '—' : pct(x.win_rate_pct, 1)) + '</div>';
    }
    function row(l, val, cls) { return '<div class="pnl-kv"><span>' + esc(l) + '</span><b class="' + (cls || '') + '">' + esc(val) + '</b></div>'; }
    var pc = v.breakdowns ? v.breakdowns.prop_category : [];
    return '<section class="pnl-sec"><div class="pnl-sh"><h4>Game markets vs player props</h4><span class="pnl-sub">where EdgeDesk’s signals are earning, measured separately</span></div>'
      + '<div class="pnl-cmps">' + col('Game markets', c.game) + col('Player props', c.props) + '</div>'
      + (pc && pc.length ? '<h5 class="pnl-h5">Player props by category</h5>' + table(S, pc, 'Category') : '') + '</section>';
  }

  var BREAKDOWNS = [
    ['league', 'By league'], ['market', 'By market'], ['prop_type', 'By player prop type'], ['side', 'By side'], ['book', 'By book'],
    ['edge', 'By model edge'], ['grade', 'By recommendation grade'], ['unit_size', 'By unit size'], ['odds_range', 'By odds range'], ['week', 'By week'], ['model_version', 'Model version performance']
  ];
  var BD_NOTE = {
    book: 'Only books EdgeDesk actually captured a price at.',
    edge: 'Does a larger claimed edge produce a better result? Read with the sample tags.',
    grade: 'Every grade at a flat 1u, at its own recorded price. Only BET is the strategy above; this is how to tell whether the gating adds value.',
    unit_size: 'EdgeDesk staking, by the stake it recommended.',
    model_version: 'Versions are never merged: each is judged on the recommendations it made.'
  };
  function breakdownsHTML(S, v) {
    var b = v.breakdowns;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>Performance breakdowns</h4><span class="pnl-sub">tap a heading to open it</span></div>';
    if (!b) return h + '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read: ' + esc(S.rowsErr) : 'Loading the ledger…') + '</div></section>';
    BREAKDOWNS.forEach(function (d, i) {
      var list = b[d[0]] || [];
      h += '<details class="pnl-det"' + (i < 2 ? ' open' : '') + '><summary>' + esc(d[1]) + ' <span class="pnl-cnt">' + list.length + '</span></summary>'
        + (BD_NOTE[d[0]] ? '<p class="pnl-note">' + esc(BD_NOTE[d[0]]) + '</p>' : '')
        + (list.length ? table(S, list, d[1].replace(/^By /, '').replace(/ performance$/, ''), d[0] === 'model_version') : '<div class="pnl-empty sm">No settled bet with a captured price in this view yet.</div>')
        + '</details>';
    });
    return h + '</section>';
  }
  /* the breakdown table; below 640px each row becomes a card (CSS) */
  function table(S, list, first, extra) {
    var h = '<div class="pnl-tw"><table class="pnl-t"><thead><tr><th>' + esc(first) + '</th><th>Bets</th><th>W-L-P</th><th>Win %</th><th>Units</th><th>ROI</th><th>CLV</th><th>Avg odds</th>' + (extra ? '<th>Avg edge</th><th>Max DD</th>' : '') + '</tr></thead><tbody>';
    list.forEach(function (x) {
      h += '<tr><td data-l="' + esc(first) + '"><b>' + esc(x.key) + '</b> ' + sampleTag(x.sample) + '</td>'
        + '<td data-l="Bets">' + esc(x.n) + '</td>'
        + '<td data-l="W-L-P">' + esc(x.wins + '-' + x.losses + '-' + x.pushes) + '</td>'
        + '<td data-l="Win %">' + (x.win_rate_pct == null ? '—' : pct(x.win_rate_pct, 1)) + '</td>'
        + '<td data-l="Units" class="' + tone(x.net_units) + '">' + money(S, x.net_units) + '</td>'
        + '<td data-l="ROI" class="' + tone(x.roi_pct) + '">' + (x.roi_pct == null ? '—' : pct(x.roi_pct, 1, true)) + '</td>'
        + '<td data-l="CLV" class="' + tone(x.avg_clv_points) + '">' + (x.avg_clv_points == null ? '—' : signed(x.avg_clv_points, 2)) + '</td>'
        + '<td data-l="Avg odds">' + (x.avg_odds == null ? '—' : K().fmtOdds(x.avg_odds)) + '</td>'
        + (extra ? '<td data-l="Avg edge">' + (x.avg_edge_pct == null ? '—' : signed(x.avg_edge_pct, 2, '%')) + '</td><td data-l="Max DD" class="' + tone(x.max_drawdown_units) + '">' + money(S, x.max_drawdown_units) + '</td>' : '')
        + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function calibrationHTML(S, v) {
    var c = v.breakdowns ? v.breakdowns.calibration : null;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>Edge calibration</h4><span class="pnl-sub">does the edge EdgeDesk claimed go with the result it got?</span></div>'
      + '<p class="pnl-note">Expected win % is the average probability EdgeDesk gave the side; actual is what happened. A bucket is judged only past 50 bets, and only when the gap is larger than its own noise: <b>overconfident</b> means it won less often than it said, <b>underconfident</b> more often.</p>';
    if (!c) return h + '<div class="pnl-empty">Loading…</div></section>';
    h += '<div class="pnl-tw"><table class="pnl-t"><thead><tr><th>Claimed edge</th><th>Bets</th><th>Expected win %</th><th>Actual win %</th><th>Units</th><th>ROI</th><th>Avg CLV</th><th>Reading</th></tr></thead><tbody>';
    c.forEach(function (b) {
      var vd = b.verdict ? b.verdict.label : (b.n ? 'No model probability on file' : '—');
      h += '<tr><td data-l="Claimed edge"><b>' + esc(b.bucket) + '</b></td><td data-l="Bets">' + b.n + '</td>'
        + '<td data-l="Expected win %">' + (b.expected_win_pct == null ? '—' : pct(b.expected_win_pct, 1)) + '</td>'
        + '<td data-l="Actual win %">' + (b.actual_win_pct == null ? '—' : pct(b.actual_win_pct, 1)) + '</td>'
        + '<td data-l="Units" class="' + tone(b.net_units) + '">' + (b.n ? money(S, b.net_units) : '—') + '</td>'
        + '<td data-l="ROI" class="' + tone(b.roi_pct) + '">' + (b.roi_pct == null ? '—' : pct(b.roi_pct, 1, true)) + '</td>'
        + '<td data-l="Avg CLV" class="' + tone(b.avg_clv_points) + '">' + (b.avg_clv_points == null ? '—' : signed(b.avg_clv_points, 2)) + '</td>'
        + '<td data-l="Reading" class="pnl-read">' + esc(vd) + (b.n && b.sample && b.sample.warn ? '<br><span class="pnl-sample warn">Small sample — results may be unstable</span>' : '') + '</td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  function clvHTML(S, v) {
    var c = v.breakdowns ? v.breakdowns.clv : null;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>CLV vs P&amp;L ' + help('clv', 'CLV') + '</h4><span class="pnl-sub">is beating the closing line turning into profit?</span></div>';
    if (!c) return h + '<div class="pnl-empty">Loading…</div></section>';
    function part(t, x) {
      return '<div class="pnl-cmp"><div class="pnl-cmph">' + esc(t) + ' ' + sampleTag(x.sample) + '</div>'
        + '<div class="pnl-kv"><span>Bets</span><b>' + x.n + '</b></div><div class="pnl-kv"><span>Units</span><b class="' + tone(x.net_units) + '">' + money(S, x.net_units) + '</b></div>'
        + '<div class="pnl-kv"><span>ROI</span><b class="' + tone(x.roi_pct) + '">' + (x.roi_pct == null ? '—' : pct(x.roi_pct, 1, true)) + '</b></div><div class="pnl-kv"><span>Win %</span><b>' + (x.win_rate_pct == null ? '—' : pct(x.win_rate_pct, 1)) + '</b></div></div>';
    }
    h += '<div class="pnl-cmps">' + part('Beat the close (positive CLV)', c.positive) + part('Lost to the close (negative CLV)', c.negative) + '</div>';
    if (c.unmeasured && c.unmeasured.n) h += '<p class="pnl-note">' + c.unmeasured.n + ' bet' + (c.unmeasured.n === 1 ? ' has' : 's have') + ' no close to measure against (or closed exactly where it was bought).</p>';
    h += '<h5 class="pnl-h5">By CLV, in points</h5><div class="pnl-tw"><table class="pnl-t"><thead><tr><th>CLV</th><th>Bets</th><th>W-L-P</th><th>Win %</th><th>Units</th><th>ROI</th></tr></thead><tbody>';
    c.buckets.forEach(function (b) {
      h += '<tr><td data-l="CLV"><b>' + esc(b.bucket) + '</b> ' + sampleTag(b.sample) + '</td><td data-l="Bets">' + b.n + '</td><td data-l="W-L-P">' + esc(b.record) + '</td>'
        + '<td data-l="Win %">' + (b.win_rate_pct == null ? '—' : pct(b.win_rate_pct, 1)) + '</td><td data-l="Units" class="' + tone(b.net_units) + '">' + money(S, b.net_units) + '</td>'
        + '<td data-l="ROI" class="' + tone(b.roi_pct) + '">' + (b.roi_pct == null ? '—' : pct(b.roi_pct, 1, true)) + '</td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  function glossaryHTML(S) {
    var H = K().HELP;
    return '<details class="pnl-det pnl-gloss"><summary>What these terms mean</summary><dl>'
      + [['Profit & Loss (P&L)', H.pnl], ['Units', H.units], ['ROI', H.roi], ['CLV', H.clv], ['Drawdown', H.drawdown], ['Flat 1u', H.flat], ['EdgeDesk staking', H.staked], ['Break-even win rate', H.break_even], ['Profit factor', H.profit_factor], ['Entry price not captured', H.missing]]
        .map(function (t) { return '<dt>' + esc(t[0]) + '</dt><dd>' + esc(t[1]) + '</dd>'; }).join('')
      + '</dl><ul class="pnl-ul">' + (S.sum.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></details>';
  }

  /* ------------------------------------------------------------ the chart
     Cumulative P&L (2px accent line), the running peak (thin muted line),
     drawdown (the gap between them, a ~12% wash of the negative colour).
     x = the bet's place in order; a crosshair snaps to the nearest bet. */
  function drawChart(S, v) {
    var box = S.host.querySelector('[data-chart]');
    if (!box) return;
    var ser = (v && v.series) || [];
    if (!ser.length) {
      box.innerHTML = '<div class="pnl-empty">No settled bet with a captured price in this view yet. The line starts at the first one: nothing is drawn from a guess.</div>';
      return;
    }
    var W = Math.max(300, Math.round(box.clientWidth || 640)), H = W < 480 ? 220 : 260;
    S.chartW = W;
    var padL = 50, padR = 14, padT = 14, padB = 30;
    var pts = [[null, 0, 0, 0, null]].concat(ser);
    var lo = 0, hi = 0;
    pts.forEach(function (p) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[3], p[2]); });
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
    var n = pts.length - 1;
    function X(i) { return padL + (n ? (i / n) : 0) * (W - padL - padR); }
    function Y(val) { return padT + (hi - val) / (hi - lo) * (H - padT - padB); }
    var step = niceStep((hi - lo) / 5), ticks = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
    var svg = '<svg class="pnl-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" tabindex="0" aria-label="Cumulative profit and loss, ' + n + ' bets, ending at ' + esc(money(S, ser[ser.length - 1][2])) + '. Use the left and right arrow keys to read each bet.">';
    ticks.forEach(function (tv) {
      var y = Y(tv);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="' + (Math.abs(tv) < 1e-9 ? 'pnl-zero' : 'pnl-grid') + '"/>'
        + '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="pnl-ax">' + esc(axisMoney(S, tv)) + '</text>';
    });
    /* x labels: first, middle and last bet dates */
    [1, Math.ceil(n / 2), n].filter(function (i, k, a) { return i >= 1 && a.indexOf(i) === k; }).forEach(function (i, k, a) {
      var anchor = a.length > 1 && k === 0 ? 'start' : (k === a.length - 1 && a.length > 1 ? 'end' : 'middle');
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="' + anchor + '" class="pnl-ax">' + esc(dateShort((pts[i][0] || '') + 'T12:00:00Z')) + '</text>';
    });
    var cum = '', peak = '', area = '';
    pts.forEach(function (p, i) { cum += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[2]).toFixed(1); peak += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(p[3]).toFixed(1); });
    area = peak;
    for (var j = pts.length - 1; j >= 0; j--) area += ' L' + X(j).toFixed(1) + ' ' + Y(pts[j][2]).toFixed(1);
    svg += '<path d="' + area + ' Z" class="pnl-ddarea"/>'
      + '<path d="' + peak + '" class="pnl-peak"/>'
      + '<path d="' + cum + '" class="pnl-line"/>';
    var last = pts[pts.length - 1];
    svg += '<circle cx="' + X(n).toFixed(1) + '" cy="' + Y(last[2]).toFixed(1) + '" r="4.5" class="pnl-end"/>';
    svg += '<line class="pnl-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden"/><circle class="pnl-hit" r="5" cx="0" cy="0" visibility="hidden"/>';
    svg += '<rect class="pnl-over" x="' + padL + '" y="0" width="' + (W - padL - padR) + '" height="' + H + '"/></svg>';
    box.innerHTML = '<div class="pnl-endlab ' + tone(last[2]) + '">' + esc(money(S, last[2])) + '</div>' + svg + '<div class="pnl-tip" hidden></div>';
    var el = box.querySelector('svg'), tip = box.querySelector('.pnl-tip'), cross = el.querySelector('.pnl-cross'), dot = el.querySelector('.pnl-hit');
    var cur = null;
    function show(i) {
      i = Math.max(1, Math.min(n, i)); cur = i;
      var p = pts[i], x = X(i), y = Y(p[2]);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('visibility', 'visible');
      tipContent(S, tip, p);
      tip.hidden = false;
      var bw = box.clientWidth || W, tw = tip.offsetWidth || 220;
      var left = x * (bw / W) + 12; if (left + tw > bw - 4) left = Math.max(4, x * (bw / W) - tw - 12);
      tip.style.left = left + 'px'; tip.style.top = Math.max(4, y * (bw / W) - 20) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    function at(evt) {
      var r = el.getBoundingClientRect(), cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left;
      var x = cx * (W / r.width);
      return Math.round(((x - padL) / (W - padL - padR)) * n);
    }
    el.addEventListener('pointermove', function (e) { show(at(e)); });
    el.addEventListener('pointerdown', function (e) { show(at(e)); });
    el.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show((cur == null ? n : cur) + (e.key === 'ArrowRight' ? 1 : -1)); }
      else if (e.key === 'Home') { e.preventDefault(); show(1); } else if (e.key === 'End') { e.preventDefault(); show(n); } else if (e.key === 'Escape') hide();
    });
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  function axisMoney(S, v) {
    if (dollarsOn(S)) { var d = K().dollars(v, unit(S).unit); return (d > 0 ? '+' : d < 0 ? '−' : '') + '$' + Math.abs(Math.round(d)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    var r = Math.round(v * 100) / 100;
    return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + 'u';
  }
  /* the bet behind one step — every string set as text */
  function tipContent(S, tip, p) {
    var x = S.byId[p[4]] || null;
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    function line(txt, cls) { var d = document.createElement('div'); d.textContent = txt; if (cls) d.className = cls; tip.appendChild(d); }
    line(x ? dateShort(x.game_date) : dateShort((p[0] || '') + 'T12:00:00Z'), 'pnl-tip-d');
    if (x) {
      line((LEAGUE_TXT[x.league] || x.league) + ' · ' + (x.event_label || ''));
      line((x.player_name ? x.player_name + ' ' : '') + x.selection + (x.market_group === 'prop' ? ' ' + (x.prop_label || '') : ' · ' + (MARKET_TXT[x.market_type] || '')), 'pnl-tip-s');
      line('Odds: ' + K().fmtOdds(x.entry_odds) + ' · Stake: ' + (S.mode === 'staked' ? Number(x.stake_units).toFixed(2) : '1.00') + 'u');
      line('Result: ' + (RESULT_TXT[x.result] || x.result));
    }
    line('P&L: ' + money(S, p[1]), 'pnl-tip-v ' + tone(p[1]));
    line('Running P&L: ' + money(S, p[2]), 'pnl-tip-v');
  }

  /* ------------------------------------------------------------ players */
  function renderPlayersShell(S) {
    var box = S.host.querySelector('[data-r="players"]');
    if (box.getAttribute('data-ready')) return;
    box.setAttribute('data-ready', '1');
    box.innerHTML = '<div class="pnl-sh"><h4>Player prop performance</h4><span class="pnl-sub">every player EdgeDesk has recommended a prop on</span></div>'
      + '<p class="pnl-note">A handful of props says nothing about whether a player is profitable to bet. Read every line with its sample tag.</p>'
      + '<div class="pnl-prow"><input type="search" class="pnl-in" data-pq placeholder="Search a player, team or league" aria-label="Search players">'
      + '<div data-r="pcls"></div></div><div data-r="plist"></div>';
  }
  function playerRows(S) {
    var rows = scoped(S) || [];
    return S.pcls === 'ALL' ? rows.filter(function (x) { return x.rec_class === 'BET' || x.rec_class === 'LEAN'; }) : rows;
  }
  function renderPlayers(S) {
    var box = S.host.querySelector('[data-r="plist"]'), cb = S.host.querySelector('[data-r="pcls"]');
    if (!box) return;
    cb.innerHTML = seg('data-pcls', [['BET', 'Bets'], ['ALL', 'Bets + Leans (flat 1u)']], S.pcls);
    if (!S.rows) { box.innerHTML = '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read.' : 'Loading the ledger…') + '</div>'; return; }
    var P = K(), mode = S.pcls === 'ALL' ? 'flat' : S.mode, pred = S.pcls === 'ALL' ? function (x) { return x.rec_class === 'BET' || x.rec_class === 'LEAN'; } : null;
    var list = P.players(playerRows(S), mode, pred);
    var q = S.pq.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return [p.player_name, p.team, p.league, LEAGUE_TXT[p.league], p.position].join(' ').toLowerCase().indexOf(q) >= 0; });
    if (!list.length) { box.innerHTML = '<div class="pnl-empty sm">' + (q ? 'No player matches “' + esc(S.pq) + '”.' : 'No player prop recommendation in this view yet.') + '</div>'; return; }
    var per = 20, pages = Math.ceil(list.length / per); S.ppage = Math.min(S.ppage, pages - 1);
    var show = list.slice(S.ppage * per, S.ppage * per + per);
    var h = '<div class="pnl-tw"><table class="pnl-t pnl-pt"><thead><tr><th>Player</th><th>League</th><th>Team</th><th>Props tracked</th><th>W-L-P</th><th>Units</th><th>ROI</th><th>Avg edge</th><th>Avg CLV</th></tr></thead><tbody>';
    show.forEach(function (p) {
      var open = S.player === p.key;
      h += '<tr class="pnl-click' + (open ? ' open' : '') + '" data-player="' + esc(p.key) + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<td data-l="Player"><b>' + esc(p.player_name) + '</b>' + (p.position ? ' <span class="pnl-mut">' + esc(p.position) + '</span>' : '') + ' ' + sampleTag(p.sample) + '</td>'
        + '<td data-l="League">' + esc(LEAGUE_TXT[p.league] || p.league) + '</td><td data-l="Team">' + esc(p.team || '—') + '</td>'
        + '<td data-l="Props tracked">' + p.tracked + (p.settled < p.tracked ? ' <span class="pnl-mut">(' + p.settled + ' settled)</span>' : '') + '</td>'
        + '<td data-l="W-L-P">' + esc(p.wins + '-' + p.losses + '-' + p.pushes) + '</td>'
        + '<td data-l="Units" class="' + tone(p.net_units) + '">' + money(S, p.net_units) + '</td>'
        + '<td data-l="ROI" class="' + tone(p.roi_pct) + '">' + (p.roi_pct == null ? '—' : pct(p.roi_pct, 1, true)) + '</td>'
        + '<td data-l="Avg edge">' + (p.avg_edge_pct == null ? '—' : signed(p.avg_edge_pct, 2, '%')) + '</td>'
        + '<td data-l="Avg CLV" class="' + tone(p.avg_clv_points) + '">' + (p.avg_clv_points == null ? '—' : signed(p.avg_clv_points, 2)) + '</td></tr>';
      if (open) h += '<tr class="pnl-drill"><td colspan="9">' + playerDrill(S, p, mode, pred) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (pages > 1) h += '<div class="pnl-pager"><button type="button" class="pnl-btn" data-ppage="-1"' + (S.ppage ? '' : ' disabled') + '>Previous</button><span>' + (S.ppage + 1) + ' / ' + pages + ' · ' + list.length + ' players</span><button type="button" class="pnl-btn" data-ppage="1"' + (S.ppage < pages - 1 ? '' : ' disabled') + '>Next</button></div>';
    box.innerHTML = h;
  }
  function playerDrill(S, p, mode, pred) {
    var P = K();
    var rows = playerRows(S).filter(function (x) { return x.market_group === 'prop' && (x.league + '|' + (x.player_id || x.player_name)) === p.key; });
    var counted = rows.filter(pred || P.isBet).map(function (x) { return pred ? Object.assign({}, x, { rec_class: 'BET' }) : x; });
    var byType = P.breakdown(counted, function (x) { return x.prop_label || x.prop_market; }, mode);
    var bySide = P.breakdown(counted, function (x) { return x.side === 'over' ? 'Over' : x.side === 'under' ? 'Under' : null; }, mode, ['Over', 'Under']);
    var h = '<div class="pnl-drillin"><p class="pnl-note">' + esc(p.player_name) + ': ' + rows.length + ' recommendation' + (rows.length === 1 ? '' : 's') + ' on file. ' + esc(p.sample.text) + '.</p>';
    h += byType.length ? '<h5 class="pnl-h5">By prop type</h5>' + table(S, byType, 'Prop type') : '';
    h += bySide.length ? '<h5 class="pnl-h5">Over vs under</h5>' + table(S, bySide, 'Side') : '';
    h += '<h5 class="pnl-h5">Game log — every recommendation</h5>' + ledgerTable(S, rows.slice().sort(function (a, b) { return (Date.parse(b.game_date) || 0) - (Date.parse(a.game_date) || 0); }), true);
    return h + '</div>';
  }

  /* ------------------------------------------------------------ ledger */
  function opts(list, cur, all) {
    return '<option value="">' + esc(all) + '</option>' + list.map(function (o) { var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  }
  function uniq(rows, fn) { var s = {}, out = []; rows.forEach(function (x) { var v = fn(x); if (v != null && v !== '' && !s[v]) { s[v] = 1; out.push(v); } }); return out.sort(); }
  function renderLedgerShell(S) {
    var box = S.host.querySelector('[data-r="ledger"]');
    var ready = box.getAttribute('data-ready');
    if (ready === (S.rows ? 'rows' : 'wait')) return;
    box.setAttribute('data-ready', S.rows ? 'rows' : 'wait');
    var rows = S.rows || [];
    var f = S.f;
    var fl = '<div class="pnl-fgrid">'
      + fsel('league', 'Sport / league', opts([['NFL', 'NFL'], ['CFB', 'College Football']], f.league, 'All leagues'))
      + fsel('market', 'Market', opts([['spread', 'Spread'], ['total', 'Total'], ['moneyline', 'Moneyline'], ['player_prop', 'Player props']], f.market, 'All markets'))
      + fsel('cls', 'Grade', opts([['BET', 'Bet'], ['LEAN', 'Lean'], ['WATCH', 'Watch'], ['PASS', 'Pass'], ['MODEL', 'Model number (no price)']], f.cls, 'Every grade'))
      + fsel('result', 'Result', opts([['win', 'Win'], ['loss', 'Loss'], ['push', 'Push'], ['void', 'Void'], ['pending', 'Pending']], f.result, 'Any result'))
      + fsel('status', 'P&L status', opts([['VERIFIED', 'Verified P&L'], ['NO_ENTRY_PRICE', 'No entry price'], ['PENDING', 'Pending'], ['VOID', 'Void'], ['SIMULATED_PRICE', 'Simulated price'], ['INVALID_PRICE', 'Invalid price']], f.status, 'Any status'))
      + fsel('book', 'Book', opts(uniq(rows.filter(function (x) { return x.entry_odds != null; }), function (x) { return x.entry_book_name || x.entry_book; }), f.book, 'All books'))
      + fsel('version', 'Model version', opts(uniq(rows, function (x) { return x.model_version; }), f.version, 'All versions'))
      + fsel('week', 'Week', opts(uniq(rows, function (x) { return x.week != null ? String(x.week) : null; }).sort(function (a, b) { return a - b; }).map(function (w) { return [w, 'Week ' + w]; }), f.week, 'All weeks'))
      + fsel('stake', 'Unit size', opts([['0.25', '0.25u'], ['0.5', '0.50u'], ['0.75', '0.75u'], ['1', '1.00u']], f.stake, 'Any stake'))
      + '<label class="pnl-f"><span>Min edge %</span><input class="pnl-in" type="number" step="0.5" inputmode="decimal" data-f="edge" value="' + esc(f.edge) + '" placeholder="e.g. 3"></label>'
      + '<label class="pnl-f"><span>From</span><input class="pnl-in" type="date" data-f="from" value="' + esc(f.from) + '"></label>'
      + '<label class="pnl-f"><span>To</span><input class="pnl-in" type="date" data-f="to" value="' + esc(f.to) + '"></label>'
      + '<label class="pnl-f"><span>Sort by</span><select class="pnl-in" data-sort>' + [['date', 'Date'], ['pnl', 'P&L'], ['roi', 'ROI'], ['edge', 'Edge'], ['clv', 'CLV'], ['stake', 'Stake']].map(function (o) { return '<option value="' + o[0] + '"' + (S.sort.k === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>'
      + '<label class="pnl-f"><span>Order</span><select class="pnl-in" data-sortd><option value="-1"' + (S.sort.d < 0 ? ' selected' : '') + '>Descending</option><option value="1"' + (S.sort.d > 0 ? ' selected' : '') + '>Ascending</option></select></label>'
      + '</div><div class="pnl-factions"><button type="button" class="pnl-btn" data-freset>Reset filters</button><button type="button" class="pnl-btn acc pnl-only-m" data-fclose>Show results</button></div>';
    box.innerHTML = '<div class="pnl-sh"><h4>P&amp;L ledger</h4><span class="pnl-sub">every recommendation, auditable: what was recommended, at what price, what happened</span></div>'
      + '<div class="pnl-lbar"><input type="search" class="pnl-in" data-f="q" value="' + esc(f.q) + '" placeholder="Search player, team, game, market, book, version" aria-label="Search the ledger">'
      + '<button type="button" class="pnl-btn pnl-only-m" data-fopen aria-expanded="false">Filters <span data-fcount></span></button></div>'
      + '<div class="pnl-filters" data-filters><div class="pnl-fhead pnl-only-m"><b>Filter the ledger</b><button type="button" class="pnl-x" data-fclose aria-label="Close filters">×</button></div>' + fl + '</div>'
      + '<div data-r="lrows"></div>';
  }
  function fsel(k, label, inner) { return '<label class="pnl-f"><span>' + esc(label) + '</span><select class="pnl-in" data-f="' + k + '">' + inner + '</select></label>'; }
  function ledgerFiltered(S) {
    var f = S.f, q = f.q.trim().toLowerCase(), minE = f.edge === '' ? null : Number(f.edge);
    var from = f.from ? Date.parse(f.from + 'T00:00:00') : null, to = f.to ? Date.parse(f.to + 'T23:59:59') : null;
    return (scoped(S) || []).filter(function (x) {
      if (f.league && x.league !== f.league) return false;
      if (f.market && x.market_type !== f.market) return false;
      if (f.cls && x.rec_class !== f.cls) return false;
      if (f.result && x.result !== f.result) return false;
      if (f.status && x.pnl_status !== f.status) return false;
      if (f.book && (x.entry_book_name || x.entry_book) !== f.book) return false;
      if (f.version && x.model_version !== f.version) return false;
      if (f.week && String(x.week) !== f.week) return false;
      if (f.stake && !(Math.abs((x.stake_units || 0) - Number(f.stake)) < 1e-6)) return false;
      if (minE != null && isFinite(minE) && !(isNum(x.model_edge_pct) && x.model_edge_pct >= minE)) return false;
      var t = Date.parse(x.game_date || '');
      if (from != null && !(t >= from)) return false;
      if (to != null && !(t <= to)) return false;
      if (q) {
        var hay = [x.player_name, x.team, x.opponent, x.event_label, x.home, x.away, x.selection, x.prop_label, MARKET_TXT[x.market_type], x.entry_book_name, x.entry_book, x.model_version, x.league, LEAGUE_TXT[x.league], x.rec_class, x.recommendation_id].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function rowPnl(S, x) { return S.mode === 'staked' ? x.profit_units : x.flat_profit_units; }
  function rowStake(S, x) { return S.mode === 'staked' ? (x.stake_units || 0) : 1; }
  function sortVal(S, x) {
    var k = S.sort.k;
    if (k === 'pnl') return rowPnl(S, x);
    if (k === 'roi') { var p = rowPnl(S, x), st = rowStake(S, x); return isNum(p) && st > 0 && x.result !== 'push' && x.result !== 'void' ? p / st : null; }
    if (k === 'edge') return x.model_edge_pct;
    if (k === 'clv') return x.clv_points;
    if (k === 'stake') return x.stake_units;
    return Date.parse(x.game_date || '') || 0;
  }
  function renderLedger(S) {
    var box = S.host.querySelector('[data-r="lrows"]');
    if (!box) return;
    if (!S.rows) { box.innerHTML = '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read: ' + esc(S.rowsErr) : 'Loading the ledger…') + '</div>'; return; }
    var rows = ledgerFiltered(S), d = S.sort.d;
    rows.sort(function (a, b) {
      var va = sortVal(S, a), vb = sortVal(S, b);
      if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
      return (va - vb) * d || ((Date.parse(b.game_date) || 0) - (Date.parse(a.game_date) || 0));
    });
    var nf = 0; Object.keys(S.f).forEach(function (k) { if (k !== 'q' && S.f[k] !== '') nf++; });
    var fc = S.host.querySelector('[data-fcount]'); if (fc) fc.textContent = nf ? '(' + nf + ')' : '';
    var pages = Math.max(1, Math.ceil(rows.length / S.per)); S.page = Math.min(S.page, pages - 1);
    var show = rows.slice(S.page * S.per, S.page * S.per + S.per);
    var verified = rows.filter(function (x) { return x.pnl_status === 'VERIFIED' && isNum(rowPnl(S, x)); });
    var net = verified.reduce(function (a, x) { return a + rowPnl(S, x); }, 0);
    var h = '<div class="pnl-lcount">' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + (rows.length !== (scoped(S) || []).length ? ' of ' + (scoped(S) || []).length : '')
      + ' · ' + verified.length + ' with verified P&amp;L (' + (S.mode === 'staked' ? 'EdgeDesk staking' : 'flat 1u') + ', every grade): <b class="' + tone(net) + '">' + esc(money(S, net)) + '</b></div>';
    if (!rows.length) { box.innerHTML = h + '<div class="pnl-empty sm">No recommendation matches these filters.</div>'; return; }
    h += ledgerTable(S, show, false);
    if (pages > 1) h += '<div class="pnl-pager"><button type="button" class="pnl-btn" data-page="-1"' + (S.page ? '' : ' disabled') + '>Previous</button><span>Page ' + (S.page + 1) + ' of ' + pages + '</span><button type="button" class="pnl-btn" data-page="1"' + (S.page < pages - 1 ? '' : ' disabled') + '>Next</button></div>';
    box.innerHTML = h;
  }
  function resultPill(r) { return '<span class="pnl-res r-' + esc(r || 'pending') + '">' + esc(RESULT_TXT[r] || r || '—') + '</span>'; }
  function ledgerTable(S, rows, compact) {
    var P = K();
    var h = '<div class="pnl-tw pnl-tw-l"><table class="pnl-t pnl-lt"><thead><tr><th>Date</th><th>Sport</th><th>Game</th><th>Player</th><th>Market</th><th>Selection</th><th>Model</th><th>Entry</th><th>Odds</th><th>Close</th><th>Edge</th><th>Stake</th><th>Result</th><th>P&amp;L</th><th>CLV</th><th>Model version</th></tr></thead><tbody>';
    rows.forEach(function (x) {
      var pnl = rowPnl(S, x), open = !!S.open[x.recommendation_id];
      var pnlTxt = isNum(pnl) ? money(S, pnl) : (x.pnl_status === 'NO_ENTRY_PRICE' ? 'No price' : x.pnl_status === 'PENDING' ? 'Pending' : x.pnl_status === 'SIMULATED_PRICE' ? 'Simulated' : x.pnl_status === 'VERIFIED' && S.mode === 'staked' ? 'Not staked' : '—');
      var mkt = x.market_group === 'prop' ? (x.prop_label || x.prop_market) : (MARKET_TXT[x.market_type] || x.market_type);
      h += '<tr class="pnl-click pnl-lr' + (open ? ' open' : '') + '" data-row="' + esc(x.recommendation_id) + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<td data-l="Date">' + esc(dateShort(x.game_date)) + (x.week != null ? ' <span class="pnl-mut">w' + esc(x.week) + '</span>' : '') + '</td>'
        + '<td data-l="Sport">' + esc(x.league === 'CFB' ? 'CFB' : x.league) + ' <span class="pnl-grade g-' + esc(x.rec_class) + '">' + esc(x.rec_class === 'MODEL' ? 'Model' : x.rec_class) + '</span></td>'
        + '<td data-l="Game">' + esc(x.event_label || x.event_id) + '</td>'
        + '<td data-l="Player">' + esc(x.player_name || '—') + '</td>'
        + '<td data-l="Market">' + esc(mkt) + '</td>'
        + '<td data-l="Selection" class="pnl-sel">' + esc(x.selection) + '</td>'
        + '<td data-l="Model">' + (isNum(x.model_line) ? esc(x.market_type === 'spread' ? lineTxt(x.model_line) : numTxt(x.model_line, 1)) : '—') + '</td>'
        + '<td data-l="Entry">' + (isNum(x.entry_line) ? esc(x.market_type === 'spread' ? lineTxt(x.entry_line) : numTxt(x.entry_line, 1)) : '—') + '</td>'
        + '<td data-l="Odds">' + (x.entry_odds != null ? esc(P.fmtOdds(x.entry_odds)) : '<span class="pnl-mut">not captured</span>') + '</td>'
        + '<td data-l="Close">' + (isNum(x.closing_line) ? esc(x.market_type === 'spread' ? lineTxt(x.closing_line) : numTxt(x.closing_line, 1)) : '—') + (x.closing_odds != null ? ' <span class="pnl-mut">' + esc(P.fmtOdds(x.closing_odds)) + '</span>' : '') + '</td>'
        + '<td data-l="Edge">' + (isNum(x.model_edge_pct) ? esc(signed(x.model_edge_pct, 1, '%')) : '—') + '</td>'
        + '<td data-l="Stake">' + (S.mode === 'staked' ? (x.stake_units > 0 ? esc(Number(x.stake_units).toFixed(2) + 'u') : '—') : '1.00u') + '</td>'
        + '<td data-l="Result">' + resultPill(x.result) + (x.corrected ? ' <span class="pnl-corr" title="Corrected after settlement">corrected</span>' : '') + '</td>'
        + '<td data-l="P&amp;L" class="pnl-pl ' + (isNum(pnl) ? tone(pnl) : 'pnl-mut') + '">' + esc(pnlTxt) + '</td>'
        + '<td data-l="CLV" class="' + tone(x.clv_points) + '">' + (isNum(x.clv_points) ? esc(signed(x.clv_points, 1)) : '—') + '</td>'
        + '<td data-l="Model version" class="pnl-ver">' + esc(x.model_version || '—') + '</td></tr>';
      if (open) h += '<tr class="pnl-audit"><td colspan="16">' + auditHTML(S, x) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function auditHTML(S, x) {
    var P = K();
    function kv(l, v) { return '<div><dt>' + esc(l) + '</dt><dd>' + esc(v == null || v === '' ? '—' : v) + '</dd></div>'; }
    var h = '<dl class="pnl-audit-dl">'
      + kv('Recommendation', x.recommendation_id) + kv('Grade', (x.rec_class === 'MODEL' ? 'Model number (no price)' : x.rec_class)) + kv('P&L status', STATUS_SHORT[x.pnl_status] || x.pnl_status)
      + kv('Recommended', dateLong(x.recommended_at)) + kv('Odds captured', x.odds_captured_at ? dateLong(x.odds_captured_at) : 'not captured') + kv('Settled', x.settled_at ? dateLong(x.settled_at) : 'not yet')
      + kv('Book', x.entry_book_name || x.entry_book) + kv('Entry price', x.entry_odds != null ? P.fmtOdds(x.entry_odds) : 'not captured') + kv('Implied probability', isNum(x.implied_prob) ? (100 * x.implied_prob).toFixed(1) + '%' : null)
      + kv('Model probability', isNum(x.model_prob) ? (100 * x.model_prob).toFixed(1) + '%' : null) + kv('EV at entry', isNum(x.ev_pct) ? signed(x.ev_pct, 1, '%') : null) + kv('Confidence', x.confidence)
      + kv('Recommended stake', x.stake_units > 0 ? Number(x.stake_units).toFixed(2) + 'u' : 'none (not a staked bet)') + kv('Flat 1u P&L', isNum(x.flat_profit_units) ? money(S, x.flat_profit_units) : null) + kv('Staked P&L', isNum(x.profit_units) ? money(S, x.profit_units) : null)
      + kv('Model version', x.model_version) + kv('Final', x.final_score || (isNum(x.result_value) ? String(x.result_value) : null)) + kv('Price CLV', isNum(x.clv_prob_pp) ? signed(x.clv_prob_pp, 2, ' pp') : null) + kv('Evaluation', x.evaluation_mode === 'LIVE_RECONSTRUCTED' ? 'published pregame, recovered from the committed history' : 'recorded live, before kickoff')
      + '</dl>';
    if (x.pnl_status !== 'VERIFIED' && x.pnl_status !== 'VOID') h += '<p class="pnl-note">' + esc(P.STATUS_TEXT[x.pnl_status] || '') + '</p>';
    if (x.source_missing) h += '<p class="pnl-note warn">The source ledger no longer carries this recommendation. It is kept here as it was recorded; nothing is deleted.</p>';
    if (x.corrections && x.corrections.length) {
      h += '<div class="pnl-corrs"><b>Corrections</b><ul class="pnl-ul">' + x.corrections.map(function (c) {
        var f = c.fields || {};
        var ch = Object.keys(f).map(function (k) { var v = f[k] || {}; return k.replace(/_/g, ' ') + ': ' + (v.from == null ? '—' : v.from) + ' → ' + (v.to == null ? '—' : v.to); }).join('; ');
        return '<li>' + esc(dateLong(c.at)) + ' — ' + esc(ch) + (c.reason ? ' (' + esc(c.reason) + ')' : '') + '</li>';
      }).join('') + '</ul></div>';
    }
    return h;
  }

  /* ------------------------------------------------------------ events */
  function wire(S) {
    var host = S.host, t = null;
    function rerender(all) { S.memo = S.memo || {}; if (all) { renderTop(S); renderPlayers(S); } renderLedger(S); }
    host.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button, tr.pnl-click') : null;
      if (!b || !host.contains(b)) { closePop(S); return; }
      if (b.hasAttribute('data-help')) { e.preventDefault(); togglePop(S, b); return; }
      closePop(S);
      if (b.hasAttribute('data-mode')) { S.mode = b.getAttribute('data-mode'); rerender(true); }
      else if (b.hasAttribute('data-scope')) { S.scope = b.getAttribute('data-scope'); S.page = 0; S.ppage = 0; rerender(true); }
      else if (b.hasAttribute('data-money')) { S.money = b.getAttribute('data-money'); rerender(true); }
      else if (b.hasAttribute('data-pcls')) { S.pcls = b.getAttribute('data-pcls'); S.ppage = 0; renderPlayers(S); }
      else if (b.hasAttribute('data-page')) { S.page += Number(b.getAttribute('data-page')); renderLedger(S); }
      else if (b.hasAttribute('data-ppage')) { S.ppage += Number(b.getAttribute('data-ppage')); renderPlayers(S); }
      else if (b.hasAttribute('data-freset')) { Object.keys(S.f).forEach(function (k) { S.f[k] = ''; }); S.page = 0; var lb = host.querySelector('[data-r="ledger"]'); lb.removeAttribute('data-ready'); renderLedgerShell(S); renderLedger(S); }
      else if (b.hasAttribute('data-fopen')) { setDrawer(S, true); }
      else if (b.hasAttribute('data-fclose')) { setDrawer(S, false); }
      else if (b.hasAttribute('data-row')) { var id = b.getAttribute('data-row'); S.open[id] = !S.open[id]; renderLedger(S); if (S.player) renderPlayers(S); }
      else if (b.hasAttribute('data-player')) { var k = b.getAttribute('data-player'); S.player = S.player === k ? null : k; renderPlayers(S); }
    });
    host.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.pnl-click')) { e.preventDefault(); e.target.click(); }
      if (e.key === 'Escape') { closePop(S); setDrawer(S, false); }
    });
    function onField(e) {
      var el = e.target;
      if (el.hasAttribute('data-pq')) { S.pq = el.value; S.ppage = 0; clearTimeout(t); t = setTimeout(function () { renderPlayers(S); }, 120); return; }
      if (el.hasAttribute('data-f')) { S.f[el.getAttribute('data-f')] = el.value; S.page = 0; clearTimeout(t); t = setTimeout(function () { renderLedger(S); }, el.type === 'search' ? 150 : 0); return; }
      if (el.hasAttribute('data-sort')) { S.sort.k = el.value; S.page = 0; renderLedger(S); return; }
      if (el.hasAttribute('data-sortd')) { S.sort.d = Number(el.value) || -1; S.page = 0; renderLedger(S); }
    }
    /* a help popover closes on any click outside it, anywhere on the page */
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('click', function (e) { if (!host.contains(e.target)) closePop(S); });
    }
    host.addEventListener('input', onField);
    host.addEventListener('change', onField);
    if (typeof root.addEventListener === 'function') {
      var rt = null;
      root.addEventListener('resize', function () {
        clearTimeout(rt);
        rt = setTimeout(function () { var box = host.querySelector('[data-chart]'); if (box && S.sum && Math.abs((box.clientWidth || 0) - S.chartW) > 24) drawChart(S, current(S)); }, 150);
      });
    }
  }
  function setDrawer(S, on) {
    var d = S.host.querySelector('[data-filters]'), b = S.host.querySelector('[data-fopen]');
    if (!d) return;
    S.fopen = !!on;
    d.classList.toggle('open', S.fopen);
    if (b) b.setAttribute('aria-expanded', S.fopen ? 'true' : 'false');
  }
  function togglePop(S, btn) {
    var pop = S.host.querySelector('.pnl-pop'), key = btn.getAttribute('data-help');
    if (!pop) return;
    if (!pop.hidden && pop.getAttribute('data-for') === key) { closePop(S); return; }
    var H = K().HELP;
    pop.textContent = H[key] || '';
    pop.setAttribute('data-for', key);
    pop.hidden = false;
    var hr = S.host.getBoundingClientRect(), br = btn.getBoundingClientRect();
    var w = Math.min(320, hr.width - 16);
    pop.style.width = w + 'px';
    var left = Math.max(8, Math.min(br.left - hr.left - 12, hr.width - w - 8));
    pop.style.left = left + 'px';
    pop.style.top = (br.bottom - hr.top + 8) + 'px';
  }
  function closePop(S) { var pop = S.host.querySelector('.pnl-pop'); if (pop && !pop.hidden) { pop.hidden = true; pop.removeAttribute('data-for'); } }

  return { VERSION: VERSION, mount: mount, expand: expand, esc: esc };
}));
