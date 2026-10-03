/* ===========================================================================
   EDGEDESK P&L — the Records page's profit and loss (browser, ES5).
   docs/pnl/DESIGN.md

   Two questions, two sections, never mixed:

     MODEL PERFORMANCE  how often was the model right? Every graded decision
                        (the model's published number on a game, every BET)
                        as W-L-P, priced or not. Never units.
     VERIFIED P&L       would the priced decisions have made or lost units?
                        Only the graded decisions that settled at a real
                        price EdgeDesk captured at or before the decision.
                        NO PRICE = NO VERIFIED P&L: the rest are record only,
                        counted and named, never turned into a profit.

   Layout, top to bottom: MODEL PERFORMANCE (the graded record, by market) ·
   VERIFIED P&L — net units (the largest number), ROI, the priced decisions,
   how many of the graded decisions they are and how many are record only,
   units risked, each market's own figures — and its chart (verified
   decisions only) · historical model results (by sport; what is record only
   and why; what is pending) · the filters: tabs ALL / CFB / NFL / PLAYER
   PROPS (each with its verified net, else its record), market, period, stake,
   leans · the ledger — Verified P&L / Historical graded / Pending — where a
   priced decision shows its price, stake and units and a record-only one
   says "Record only · Price unavailable" · "How P&L works" and "Advanced
   Analytics" (collapsed).

   Before the ledger rows arrive the Verified P&L card is drawn from the
   build's own precomputed card (record/pnl/summary.json verified.views), so
   "is the model up or down?" is answered on the first paint.

   ONE DATASET. dataset(S) filters the ledger rows by scope, market and
   period; the graded decisions (model picks and BETs; LEAN only when the
   reader includes leans) are cut from that one set — the record from all of
   them, the Verified P&L from the priced ones — and
   every figure on the page — the card, the record, the tabs, the chart, the
   advanced tables and the ledger — is computed from it by lib/edgedesk_pnl.js.
   EDPnl.integrity() proves they agree on every render; a disagreement shows
   as an internal error, never as two quietly different numbers.

   EMPTY IS NOT ZERO. 0.00u only when the arithmetic ran and gave zero; '—'
   when it cannot be computed; "Waiting for settlement" when the bets exist
   and have not finished; "Historical P&L unavailable" when a result exists
   but its entry price was never captured.

   LIVE. The page polls record/pnl/stamp.json (a few bytes that change only
   when the ledger's rows do) and re-reads the ledger after a settlement run.

   RULES IT KEEPS
     - No captured price, no profit: the result counts in the record, never
       in P&L. Pending never mixes with settled. PASS / WATCH are not bets.
     - Units first. Dollars only when the HOST passes the reader's own unit
       value (opts.unitValue → EDBankroll.unitValue); never a default amount.
     - Every string from data is escaped (esc) or set with textContent.

   window.EDPnlUI.mount(host, { base: '', unitValue: fn, surface: 'app' | 'public',
                                advanced: Element, onAdvanced: fn(open),
                                refreshMs: 300000 (0 = never poll) })
     → { reload(), refresh(), check(), openAdvanced(), state }
   `advanced` is moved into the bottom of Advanced Analytics once (the app
   puts its detailed edges and football records there); `onAdvanced` is told
   when that section opens or closes.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPnlUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var VERSION = 'edgedesk_pnl_ui_v4';
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
  function int(n) { return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function dateShort(iso) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (e) { return String(iso).slice(5, 10); }
  }
  function dateYear(iso) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return String(iso).slice(0, 10); }
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
  var STATUS_SHORT = { VERIFIED: 'Verified', PENDING: 'Pending', VOID: 'Void', NO_ENTRY_PRICE: 'No entry price', SIMULATED_PRICE: 'Simulated price', INVALID_PRICE: 'Invalid price', INVALID_STAKE: 'Invalid stake', PRICE_AFTER_DECISION: 'Price after the decision' };
  /* why a graded decision carries no verified price (price_lookup.why on the row) */
  var WHY_TXT = {
    no_snapshot: 'EdgeDesk stored no priced quote for this game at or before the decision',
    before_capture: 'published before EdgeDesk began storing sportsbook quotes for every game in this league',
    no_snapshot_source: 'EdgeDesk stores no timestamped sportsbook price for this league\u2019s game markets',
    line_moved: 'the price EdgeDesk stored at the decision was for another number than the one graded',
    stale: 'the latest price EdgeDesk stored before the decision was too old to vouch for',
    after_decision: 'EdgeDesk\u2019s first stored price came after the decision',
    no_side_price: 'the stored quote carried no price for this side'
  };
  var MARKETS = [['all', 'All markets'], ['spread', 'Spread'], ['total', 'Totals'], ['moneyline', 'Moneyline'], ['player_prop', 'Player props']];
  var REC_MARKETS = [['spread', 'Spread'], ['total', 'Totals'], ['moneyline', 'Moneyline'], ['player_prop', 'Player props']];
  /* the four views a reader compares, in this order */
  var TABS = [['all', 'All'], ['cfb', 'CFB'], ['nfl', 'NFL'], ['props', 'Player Props']];
  var PERIODS = [['season', 'Season'], ['30d', '30 days'], ['7d', '7 days'], ['all', 'All time']];
  /* help the page adds to the kernel's (lib/edgedesk_pnl.js HELP) */
  var HELP_UI = {
    verified: 'Verified P&L includes only settled decisions with a historical market price captured by EdgeDesk. Record-only decisions without a verified price are excluded.',
    historical: 'Every graded EdgeDesk pick: the model’s published number on every game it graded (against the closing line and the final score), and every BET once it settles. A result with no captured entry price counts here as a win or a loss and is never turned into units.',
    states: 'Every recommendation is in exactly one state: pending, settled with verified P&L, settled as a record only (a result, no captured entry price), void, or invalid / incomplete.',
    pending: 'Why the pending recommendations are pending, as of the last settlement run: the settling jobs report it (a game not final yet, a box score not published, a feed that failed) and the ledger build places every row.'
  };

  /* ------------------------------------------------------------ mount */
  function mount(host, opts) {
    opts = opts || {};
    var S = {
      host: host, opts: opts, base: opts.base || '', sum: null, rows: null, byId: {}, err: null, rowsErr: null,
      mode: 'staked', scope: 'all', market: 'all', period: 'season', leans: false, money: 'u', memo: {},
      lq: '', lstatus: null, page: 0, per: 25, open: {}, pq: '', ppage: 0, player: null, pcls: 'BET', chartW: 0, adv: false,
      stamp: null, refreshMs: opts.refreshMs == null ? 300000 : opts.refreshMs, loadedAt: null
    };
    host.classList.add('pnl-root');
    /* HOW HAS THE MODEL PERFORMED? first — the best real figure there is
       (verified P&L once priced bets settle, else the graded record) — then
       the verified P&L's own status, the historical results, the filters,
       the ledger, and the rest collapsed */
    host.innerHTML = '<div data-r="hero"><div class="pnl-hero pnl-skel"><div class="pnl-hero-ey">Model performance</div><div class="pnl-hero-none">Loading…</div></div></div>'
      + '<div data-r="verified"></div><section class="pnl-sec pnl-chartsec" data-r="chart"></section><div data-r="hist"></div><div data-r="controls"></div>'
      + '<section class="pnl-sec pnl-ledger" data-r="ledger"></section>'
      + '<details class="pnl-det pnl-how" data-r="how"><summary>How P&amp;L works</summary><div data-r="howbody"></div></details>'
      + '<details class="pnl-det pnl-adv" data-r="adv"><summary>Advanced Analytics</summary><div data-r="advbody"></div>'
      + '<section class="pnl-sec" data-r="players"></section><div data-r="advslot"></div></details>'
      + '<div class="pnl-pop" hidden role="tooltip"></div>';
    if (opts.advanced && opts.advanced.nodeType === 1) host.querySelector('[data-r="advslot"]').appendChild(opts.advanced);
    wire(S);
    load(S);
    poll(S);
    var api = {
      state: S,
      reload: function () { S.memo = {}; load(S); },
      check: function () { check(S); },
      refresh: function () { S.memo = {}; renderAll(S); },
      openAdvanced: function () { var d = host.querySelector('[data-r="adv"]'); if (d && !d.open) d.open = true; return d; }
    };
    host.__pnl = api;
    return api;
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function load(S) {
    /* the stamp first: a refresh compares against what THIS load read
       ('' = there was none; the first one to appear is a change) */
    stampOf(S).then(function (st) { S.stamp = st || ''; });
    return fetchJson(S.base + 'record/pnl/summary.json').then(function (sum) {
      if (!sum || sum.schema !== 'edgedesk_pnl_summary_v1') throw new Error('unexpected summary');
      S.sum = sum; S.err = null;
      /* the answer first: the build's own Verified P&L card, before the rows arrive */
      if (!S.rows) renderVerified(S);
      var rf = sum.rows_file || ('record/pnl/rows_' + sum.season + '.json');
      return fetchJson(S.base + rf).then(function (page) {
        S.rows = expand(page); S.byId = {}; S.rows.forEach(function (x) { S.byId[x.recommendation_id] = x; }); S.memo = {}; S.rowsErr = null;
        S.loadedAt = Date.now();
        /* the ledger view the page chose by default is chosen again for the new rows; the reader's own choice stays */
        if (!S.lchosen) S.lstatus = null;
        renderAll(S);
      }).catch(function (e) { S.rowsErr = String((e && e.message) || e); renderAll(S); });
    }).catch(function (e) {
      S.err = String((e && e.message) || e);
      S.host.querySelector('[data-r="hero"]').innerHTML = '<div class="pnl-empty"><b>The profit &amp; loss record could not be read.</b><br>' + esc(S.err) + '</div>';
    });
  }
  /* ---- LIVE: re-read the ledger when a settlement run changed it ---- */
  function stampOf(S) {
    return fetchJson(S.base + 'record/pnl/stamp.json').then(function (st) { return st && st.digest ? st.digest : null; }).catch(function () { return null; });
  }
  function visible(S) {
    var d = root.document;
    if (d && d.visibilityState && d.visibilityState !== 'visible') return false;
    return !!(S.host.isConnected !== false && S.host.getClientRects && S.host.getClientRects().length);
  }
  function check(S) {
    if (!S.sum || !visible(S)) return;
    stampOf(S).then(function (st) {
      if (!st) return;                                  /* nothing to compare against */
      if (S.stamp == null) { S.stamp = st; return; }    /* this load's own read is not back yet */
      if (st === S.stamp) return;
      S.stamp = st;
      load(S);
    });
  }
  function poll(S) {
    if (!(S.refreshMs > 0) || typeof root.setInterval !== 'function' || !root.document) return;
    root.setInterval(function () { check(S); }, S.refreshMs);
    if (typeof root.document.addEventListener === 'function') root.document.addEventListener('visibilitychange', function () { if (root.document.visibilityState === 'visible' && S.loadedAt && Date.now() - S.loadedAt > 60000) check(S); });
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

  /* ============================================================ THE DATASET
     Every figure on the page comes from here. */
  function inPeriod(S, x) {
    if (S.period === 'all') return true;
    if (S.period === 'season') return !S.sum || x.season == null || x.season === S.sum.season;
    var t = Date.parse(x.game_date || '');
    return isFinite(t) && t >= Date.now() - (S.period === '7d' ? 7 : 30) * 864e5;
  }
  /* the graded decisions: the model's published numbers and the BETs, and
     LEAN only when the reader includes leans */
  function strategy(S, x) { return x.rec_class === 'MODEL' || x.rec_class === 'BET' || (S.leans && x.rec_class === 'LEAN'); }
  function inMarket(S, x) { return S.market === 'all' || x.market_type === S.market; }
  function defaultStake(S) { var v = S.sum && S.sum.verified && S.sum.verified.default_stake_units; return isNum(v) && v > 0 ? v : K().DEFAULT_STAKE_UNITS; }
  /* a lean, once counted, is a decision that recorded no stake: it risks the
     default (stake_source 'default'), exactly as the model's numbers do */
  function asPick(S, x) {
    if (x.rec_class !== 'LEAN') return x;
    var P = K(), st = x.stake_units > 0 ? x.stake_units : defaultStake(S);
    var pr = x.stake_units > 0 ? x.profit_units : (x.pnl_status === 'VERIFIED' || x.pnl_status === 'VOID' ? P.profit(x.entry_odds, st, x.result) : null);
    return Object.assign({}, x, { rec_class: 'BET', lean: true, stake_units: st, stake_source: x.stake_units > 0 ? x.stake_source : 'default', profit_units: isNum(pr) ? Math.round(pr * 1e6) / 1e6 : null });
  }
  function dataset(S, scope) {
    scope = scope || S.scope;
    var key = scope + '|' + S.market + '|' + S.period + '|' + (S.leans ? 1 : 0) + '|' + S.mode;
    if (S.memo[key]) return S.memo[key];
    if (!S.rows) return null;
    var P = K();
    var base = P.scopeRows(S.rows, scope).filter(function (x) { return inPeriod(S, x) && inMarket(S, x); });
    var bets = base.filter(function (x) { return strategy(S, x); }).map(function (x) { return asPick(S, x); });
    var s = P.summarize(bets, S.mode);
    var settled = P.betsOf(bets, S.mode);
    var pend = bets.filter(function (x) { return P.rowState(x) === 'PENDING'; });
    /* THE GRADED RECORD: model picks + the strategy's bets, priced or not */
    var recRows = base.filter(function (x) { return P.inRecord(x, S.leans); });
    var leanProps = S.leans ? [] : base.filter(function (x) { return x.market_group === 'prop' && x.rec_class === 'LEAN'; });
    var rb = P.recordBreakdowns(recRows);
    var d = {
      scope: scope, base: base, bets: bets, summary: s, settled: settled,
      series: P.series(bets, S.mode),
      pending: pend.length,
      next: pend.reduce(function (a, x) { var t = Date.parse(x.game_date || ''); return isFinite(t) && (a == null || t < a) ? t : a; }, null),
      unpriced: bets.filter(function (x) { return P.rowState(x) === 'RECORD_ONLY'; }).length,
      card: P.verifiedCard(bets, S.mode),
      first: settled.length ? P.chrono(settled)[0].game_date : null,
      recRows: recRows, record: P.gradedRecord(recRows), recBy: rb,
      markets: REC_MARKETS.map(function (m) {
        var g = rb.market.filter(function (x) { return x.key === P.MARKET_LABEL[m[0]]; })[0] || null;
        /* player props the strategy does not count (leans — every college prop
           is one while its model is EXPERIMENTAL) are still tracked: the tile
           shows them, apart, whenever the view holds any */
        if (!g && m[0] === 'player_prop' && leanProps.length) g = P.gradedRecord([]);
        return g ? Object.assign({ type: m[0], label: m[1] }, g) : null;
      }).filter(Boolean),
      leans: { tracked: leanProps.length, record: P.gradedRecord(leanProps),
        pending: leanProps.filter(function (x) { return P.rowState(x) === 'PENDING'; }).length,
        next: leanProps.reduce(function (a, x) { var t = Date.parse(x.game_date || ''); return P.rowState(x) === 'PENDING' && isFinite(t) && (a == null || t < a) ? t : a; }, null) },
      waiting: P.pendingReasons(base, Date.now()),
      integrity: P.integrity(base, S.mode, S.leans)
    };
    if (!d.integrity.ok && root.console && typeof root.console.error === 'function') root.console.error('[EDPnlUI] integrity checks failed', d.integrity.failed);
    S.memo[key] = d;
    return d;
  }
  /* the advanced figures, from the same bets; only built when the section is open */
  function advanced(S, d) {
    if (d.adv) return d.adv;
    var P = K();
    var b = P.breakdowns(d.bets, S.mode);
    /* does BET beat LEAN beat WATCH beat PASS? every class at a flat 1u — the
       one table that reads the other grades, kept apart from the strategy */
    b.grade = P.breakdown(d.base, function (x) { return P.GRADE_LABEL[x.rec_class] || x.rec_class; }, 'flat', P.GRADE_ORDER.map(function (k) { return P.GRADE_LABEL[k]; }));
    d.adv = {
      breakdowns: b,
      compare: { game: P.summarize(d.bets.filter(function (x) { return x.market_group === 'game'; }), S.mode), props: P.summarize(d.bets.filter(function (x) { return x.market_group === 'prop'; }), S.mode) },
      quality: P.dataQuality(d.base),
      states: P.states(d.base)
    };
    return d.adv;
  }

  /* ============================================================ RENDERING */
  function renderAll(S) {
    if (!S.sum) return;
    renderHero(S);
    renderVerified(S);
    renderChart(S);
    renderHistory(S);
    renderControls(S);
    renderHow(S);
    if (S.adv) { renderAdvanced(S); renderPlayersShell(S); renderPlayers(S); }
    renderLedgerShell(S);
    renderLedger(S);
  }
  function box(S, r) { return S.host.querySelector('[data-r="' + r + '"]'); }

  function help(key, label) {
    return '<button type="button" class="pnl-help" data-help="' + esc(key) + '" aria-label="' + esc('What is ' + (label || key) + '?') + '">i</button>';
  }
  function seg(attr, items, cur, cls) {
    return '<div class="pnl-seg ' + (cls || '') + '" role="group">' + items.map(function (it) {
      var on = it[0] === cur;
      return '<button type="button" ' + attr + '="' + esc(it[0]) + '" class="' + (on ? 'on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + (it[2] != null ? it[2] : esc(it[1])) + '</button>';
    }).join('') + '</div>';
  }
  function sampleTag(s) {
    if (!s) return '';
    return '<span class="pnl-sample ' + (s.warn ? 'warn' : '') + '" title="' + esc(s.text) + '">' + esc(s.label) + ' · n=' + s.n + '</span>';
  }
  function periodText(S, d) {
    var P = PERIODS.filter(function (p) { return p[0] === S.period; })[0];
    if (S.period === 'season') return d && d.first ? 'Since ' + dateYear(d.first) : (S.sum ? S.sum.season + ' season' : 'This season');
    if (S.period === 'all') return 'All time' + (d && d.first ? ' · since ' + dateYear(d.first) : '');
    return 'Last ' + P[1];
  }

  /* ---- 1. MODEL PERFORMANCE: how often was the model right? -------------
     The graded record — every graded decision, priced or not — as W-L-P by
     market. Never units: that is the Verified P&L card's question, below. */
  function scopeTail(S) {
    var tail = [], scope = TABS.filter(function (t) { return t[0] === S.scope; })[0][1];
    if (S.scope !== 'all') tail.push(scope);
    if (S.market !== 'all') tail.push(MARKETS.filter(function (m) { return m[0] === S.market; })[0][1]);
    if (S.leans) tail.push('picks + leans');
    return tail;
  }
  function renderHero(S) {
    var el = box(S, 'hero');
    var d = dataset(S);
    if (!d) {
      el.innerHTML = '<div class="pnl-hero pnl-skel"><div class="pnl-hero-ey">Model performance</div><div class="pnl-hero-none">' + (S.rowsErr ? 'The ledger could not be read: ' + esc(S.rowsErr) : 'Loading…') + '</div></div>';
      return;
    }
    var R = d.record, tail = scopeTail(S);
    var alarm = integrityHTML(d);
    if (R.graded) {
      var span = R.first_game ? dateShort(R.first_game + 'T12:00:00Z') + (R.last_game && R.last_game !== R.first_game ? ' – ' + dateShort(R.last_game + 'T12:00:00Z') : '') : '';
      el.innerHTML = alarm + '<div class="pnl-hero perf" data-state="record"><div class="pnl-hero-ey">Model performance ' + help('historical', 'model performance') + '</div>'
        + '<div class="pnl-perf-rec">' + esc(R.record) + '</div>'
        + '<div class="pnl-perf-sub"><b>' + (R.win_rate_pct == null ? '—' : esc(pct(R.win_rate_pct, 1))) + '</b> won · <b>' + int(R.graded) + '</b> graded decision' + (R.graded === 1 ? '' : 's') + '</div>'
        + '<div class="pnl-perf-g">' + d.markets.map(function (m) { return marketTile(d, m, false); }).join('') + '</div>'
        + '<div class="pnl-hero-per">' + esc([span || null, S.sum ? S.sum.season + ' season' : null].concat(tail).filter(Boolean).join(' · ')) + ' · how often the model was right — not whether it made money</div></div>';
      return;
    }
    /* nothing graded in this view yet: say what is tracked, not a zero */
    var tracked = R.tracked + d.leans.tracked, next = d.next != null && d.leans.next != null ? Math.min(d.next, d.leans.next) : (d.next != null ? d.next : d.leans.next);
    el.innerHTML = alarm + '<div class="pnl-hero none" data-state="' + (tracked ? 'waiting' : 'none') + '"><div class="pnl-hero-ey">Model performance</div>'
      + '<div class="pnl-hero-none">' + (tracked ? 'No graded results yet' : 'Nothing tracked in this view yet') + '</div>'
      + (tracked ? '<div class="pnl-hero-sub"><b>' + int(tracked) + '</b> recommendation' + (tracked === 1 ? '' : 's') + ' tracked'
        + (d.leans.tracked ? ' (' + int(R.tracked) + ' pick' + (R.tracked === 1 ? '' : 's') + ', ' + int(d.leans.tracked) + ' lean' + (d.leans.tracked === 1 ? '' : 's') + ')' : '')
        + (next != null ? ' · first game ' + esc(dateShort(new Date(next).toISOString())) : '') + '</div>' : '')
      + '<div class="pnl-hero-per">' + esc([S.sum ? S.sum.season + ' season' : null].concat(tail).filter(Boolean).join(' · ')) + '</div></div>';
  }
  /* one market's tile: its graded record (bets and model picks), what is
     pending, and — for player props — the leans tracked beside it, which are
     never in the record or the P&L unless the reader includes leans */
  function marketTile(d, m, long) {
    var L = m.type === 'player_prop' ? d.leans : null, h = '<div class="pnl-hm" data-market="' + esc(m.type) + '"><div class="pnl-hm-k">' + esc(m.label) + '</div>';
    if (m.graded) h += '<div class="pnl-hm-v">' + esc(m.record) + '</div><div class="pnl-hm-p">' + (m.win_rate_pct == null ? '—' : esc(pct(m.win_rate_pct, 1))) + ' · ' + int(m.graded) + (long ? ' decision' + (m.graded === 1 ? '' : 's') : '') + '</div>';
    else if (L && L.record.graded) h += '<div class="pnl-hm-v">' + esc(L.record.record) + '</div><div class="pnl-hm-p">' + (L.record.win_rate_pct == null ? '—' : esc(pct(L.record.win_rate_pct, 1))) + ' · ' + int(L.record.graded) + ' leans</div>';
    else h += '<div class="pnl-hm-v pnl-mut">—</div><div class="pnl-hm-p">Waiting for settlement</div>';
    if (m.pending) h += '<div class="pnl-hm-w">' + int(m.pending) + (L && L.tracked ? ' bet' + (m.pending === 1 ? '' : 's') : '') + ' pending</div>';
    if (L && L.tracked) h += '<div class="pnl-hm-l" data-lean-count="' + L.tracked + '">' + int(L.tracked) + ' lean' + (L.tracked === 1 ? '' : 's') + ' tracked'
      + (m.graded && L.record.graded ? ' · ' + esc(L.record.record) : L.pending && L.pending < L.tracked ? ' · ' + int(L.pending) + ' pending' : '') + '</div>';
    return h + '</div>';
  }
  function stat(k, v, cls) { return '<div class="pnl-st"><div class="pnl-st-k">' + esc(k) + '</div><div class="pnl-st-v ' + (cls || '') + '">' + esc(v) + '</div></div>'; }
  /* ---- 2. VERIFIED P&L: would the priced decisions have made or lost units?
     Net units first (the largest number), ROI second, then how many priced
     decisions that is, how many of the graded decisions it covers and how
     many are record only — then units risked and each market's own figures.
     Before the rows arrive: the build's precomputed card for this view. */
  function cardOf(S) {
    var d = dataset(S);
    if (d) return { card: d.card, d: d };
    var v = S.sum && S.sum.verified && S.sum.verified.views && S.sum.verified.views[S.scope];
    if (v && v[S.mode] && S.period === 'season' && S.market === 'all' && !S.leans) return { card: v[S.mode], d: null, pre: true };
    return null;
  }
  function vstat(k, v, cls, key) { return '<div class="pnl-vd"' + (key ? ' data-k="' + key + '"' : '') + '><div class="pnl-vd-k">' + esc(k) + '</div><div class="pnl-vd-v ' + (cls || '') + '">' + esc(v) + '</div></div>'; }
  function unitsWord(S, u) {
    if (dollarsOn(S)) return money(S, u);
    var v = Math.round(u * 100) / 100;
    if (Math.abs(v) < 0.005) v = 0;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' unit' + (Math.abs(v) === 1 ? '' : 's');
  }
  var MARKET_NOUN = { spread: 'spread', total: 'total', moneyline: 'moneyline', player_prop: 'prop' };
  function marketCell(S, m) {
    var h = '<div class="pnl-vm" data-market="' + esc(m.type) + '"><div class="pnl-vm-k">' + esc(m.label) + '</div>';
    if (m.n) {
      h += '<div class="pnl-vm-v ' + tone(m.net_units) + '">' + esc(money(S, m.net_units)) + '</div>'
        + '<div class="pnl-vm-r ' + tone(m.roi_pct) + '">' + (m.roi_pct == null ? '— ROI' : esc(pct(m.roi_pct, 1, true)) + ' ROI') + '</div>'
        + '<div class="pnl-vm-n">' + int(m.n) + ' priced · ' + esc(m.record) + (m.n < 20 ? ' · <span class="pnl-vm-s" title="' + esc(K().sampleLabel(m.n).text) + '">very small sample</span>' : '') + '</div>';
    } else {
      /* nothing settled at a verified price: no units, no percentage */
      h += '<div class="pnl-vm-v pnl-mut">—</div><div class="pnl-vm-n">0 settled priced ' + esc(MARKET_NOUN[m.type] || 'decision') + 's</div>';
    }
    if (m.record_only) h += '<div class="pnl-vm-o">' + int(m.record_only) + ' record only</div>';
    if (m.pending_priced) h += '<div class="pnl-vm-o">' + int(m.pending_priced) + ' priced pending</div>';
    return h + '</div>';
  }
  function renderVerified(S) {
    var el = box(S, 'verified');
    if (!el) return;
    var got = cardOf(S);
    if (!got) {
      el.innerHTML = '<section class="pnl-ver pnl-skel" data-state="loading"><div class="pnl-ver-ey">Verified P&amp;L ' + help('verified', 'verified P&L') + '</div>'
        + '<div class="pnl-ver-none">' + (S.rowsErr ? 'The ledger could not be read.' : 'Loading…') + '</div></section>';
      return;
    }
    var c = got.card, has = c.n > 0, net = c.net_units;
    var state = !has ? 'none' : net > 0.005 ? 'profit' : net < -0.005 ? 'loss' : 'even';
    var h = '<section class="pnl-ver ' + state + '" data-state="' + state + '" data-pre="' + (got.pre ? '1' : '0') + '" aria-label="Verified P&amp;L">'
      + '<div class="pnl-ver-ey">Verified P&amp;L ' + help('verified', 'verified P&L') + (has ? '<span class="pnl-ver-tag ' + state + '">' + (state === 'profit' ? 'Up' : state === 'loss' ? 'Down' : 'Even') + '</span>' : '') + '</div>';
    if (has) {
      h += '<div class="pnl-ver-net ' + tone(net) + '" data-v="net">' + esc(unitsWord(S, net)) + '</div>'
        + '<div class="pnl-ver-roi ' + tone(c.roi_pct) + '" data-v="roi">' + (c.roi_pct == null ? '— ROI' : esc(pct(c.roi_pct, 1, true)) + ' ROI') + '</div>'
        + '<div class="pnl-ver-n" data-v="priced"><b>' + int(c.n) + '</b> priced decision' + (c.n === 1 ? '' : 's') + ' · ' + esc(c.record) + ' ' + sampleTag(c.sample) + '</div>';
    } else {
      h += '<div class="pnl-ver-none" data-v="net">No settled priced decisions' + (S.scope !== 'all' || S.market !== 'all' ? ' in this view' : '') + '</div>'
        + '<div class="pnl-ver-n" data-v="priced"><b>0</b> priced decisions · units and ROI start with the first decision that settles at a verified price'
        + (c.pending_priced ? ' (' + int(c.pending_priced) + ' priced, pending)' : '') + '</div>';
    }
    h += '<div class="pnl-ver-inc" data-v="included"><b>' + int(c.priced) + '</b> of <b>' + int(c.graded) + '</b> graded decision' + (c.graded === 1 ? '' : 's') + ' included<br>'
      + '<b>' + int(c.record_only) + '</b> record-only decision' + (c.record_only === 1 ? '' : 's') + ' excluded — no verified price'
      + (c.pending_priced && has ? ' · ' + int(c.pending_priced) + ' priced, pending' : '') + '</div>';
    h += '<div class="pnl-ver-dl">'
      + vstat('Net units', has ? money(S, net) : '—', has ? tone(net) : 'pnl-mut', 'net')
      + vstat('ROI', has && c.roi_pct != null ? pct(c.roi_pct, 1, true) : '—', has ? tone(c.roi_pct) : 'pnl-mut', 'roi')
      + vstat('Units risked', has ? money(S, c.risked_units, true) : '—', has ? '' : 'pnl-mut', 'risked')
      + vstat('Priced decisions', int(c.n), '', 'priced')
      + vstat('Record-only decisions', int(c.record_only), '', 'record_only')
      + '</div>';
    /* the four markets — or the one the view is cut to */
    var mk = c.markets.filter(function (m) { return S.market !== 'all' ? m.type === S.market : S.scope === 'props' ? m.type === 'player_prop' : true; });
    h += '<div class="pnl-ver-mk">' + mk.map(function (m) { return marketCell(S, m); }).join('') + '</div>';
    var basis = [];
    if (S.mode === 'staked') basis.push('recorded stakes' + (c.default_stake ? ' (' + int(c.default_stake) + ' at the default ' + defaultStake(S).toFixed(2) + 'u)' : ''));
    else basis.push('flat 1u each');
    if (c.snapshot_priced) basis.push(int(c.snapshot_priced) + ' priced from a quote EdgeDesk stored before the decision');
    h += '<div class="pnl-ver-per">' + esc([periodText(S, got.d)].concat(scopeTail(S)).concat(basis).join(' · ')) + '</div></section>';
    el.innerHTML = h;
  }
  /* an internal disagreement between the page's own figures: shown, never hidden */
  function integrityHTML(d) {
    if (!d || !d.integrity || d.integrity.ok) return '';
    return '<div class="pnl-integrity" role="alert"><b>Internal check failed</b> — these figures disagree and are being investigated: '
      + d.integrity.failed.map(function (f) { return esc(f.label) + ' (expected ' + esc(JSON.stringify(f.expected)) + ', got ' + esc(JSON.stringify(f.got)) + ')'; }).join('; ') + '</div>';
  }

  /* ---- the four views, each with its own net; the period; the options ---- */
  function renderControls(S) {
    var el = box(S, 'controls'), u = unit(S);
    /* each tab says what it holds: its Verified P&L net; while nothing priced
       has settled, its graded record; with nothing graded, that it is waiting */
    var tabs = '<div class="pnl-tabs" role="tablist" aria-label="Which bets">' + TABS.map(function (t) {
      var d = dataset(S, t[0]), on = S.scope === t[0], s = d ? d.summary : null, v, cls = 'pnl-mut', kind = 'none';
      if (s && s.n) { v = money(S, s.net_units); cls = tone(s.net_units); kind = 'net'; }
      else if (d && d.record.graded) { v = d.record.record; kind = 'record'; }
      else if (d && d.pending) { v = 'Pending'; kind = 'pending'; }
      else v = '—';
      return '<button type="button" role="tab" data-scope="' + t[0] + '" class="' + (on ? 'on' : '') + '" aria-selected="' + (on ? 'true' : 'false') + '">'
        + '<span class="pnl-tab-k">' + (t[0] === 'props' ? '<span class="pnl-long">Player </span>Props' : esc(t[1])) + '</span><span class="pnl-tab-v ' + cls + '" data-kind="' + kind + '"'
        + (kind === 'record' ? ' title="Graded record (W-L-P) — no verified P&amp;L in this view yet"' : kind === 'net' ? ' title="Verified P&amp;L"' : '') + '>' + esc(v) + '</span></button>';
    }).join('') + '</div>';
    el.innerHTML = tabs + '<div class="pnl-opts">'
      + '<label class="pnl-o"><span class="pnl-sr">Market</span><select class="pnl-in pnl-in-sm" data-market aria-label="Market">' + MARKETS.map(function (m) { return '<option value="' + m[0] + '"' + (S.market === m[0] ? ' selected' : '') + '>' + esc(m[1]) + '</option>'; }).join('') + '</select></label>'
      + seg('data-period', PERIODS, S.period, 'pnl-seg-sm')
      + '<label class="pnl-o"><span class="pnl-sr">Stake</span><select class="pnl-in pnl-in-sm" data-mode aria-label="Stake"><option value="staked"' + (S.mode === 'staked' ? ' selected' : '') + '>Recorded stakes</option><option value="flat"' + (S.mode === 'flat' ? ' selected' : '') + '>Flat 1u</option></select></label>'
      + '<label class="pnl-chk"><input type="checkbox" data-leans' + (S.leans ? ' checked' : '') + '> Include leans</label>'
      + (u ? seg('data-money', [['u', 'Units'], ['$', 'Dollars']], S.money, 'pnl-seg-sm') : '')
      + '</div>'
      + (u && S.money === '$' ? '<div class="pnl-note">Dollars use ' + esc(u.text || ('your $' + u.unit + ' unit')) + '. Only you see this; the record itself is kept in units.</div>' : '');
  }

  /* ---- 3. THE ONE CHART -------------------------------------------------- */
  function renderChart(S) {
    var el = box(S, 'chart'), d = dataset(S);
    if (!d || !d.series.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    var s = d.summary;
    el.innerHTML = '<div class="pnl-sh"><h4>Verified P&amp;L over time</h4><span class="pnl-legend"><span><i class="k-line"></i>Cumulative units</span><span><i class="k-peak"></i>Running peak</span></span></div>'
      + '<div class="pnl-chart" data-chart></div>'
      + '<div class="pnl-under">'
      + '<span>Current <b class="' + tone(s.net_units) + '">' + esc(money(S, s.net_units)) + '</b></span>'
      + '<span>Peak <b class="' + tone(s.peak_profit_units) + '">' + esc(money(S, s.peak_profit_units)) + '</b></span>'
      + '<span>Max drawdown <b class="' + tone(s.max_drawdown_units) + '">' + esc(money(S, s.max_drawdown_units)) + '</b></span></div>';
    drawChart(S, d);
  }

  /* ---- 3. HISTORICAL MODEL RESULTS: where the record comes from ----------
     What the two cards above do not already say: the record by sport, how
     many graded decisions are record only and why, what is pending. */
  function renderHistory(S) {
    var el = box(S, 'hist'), d = dataset(S);
    if (!d || !d.record.tracked) { el.innerHTML = ''; return; }
    var R = d.record;
    var span = R.first_game ? dateShort(R.first_game + 'T12:00:00Z') + (R.last_game && R.last_game !== R.first_game ? ' – ' + dateShort(R.last_game + 'T12:00:00Z') : '') : '';
    var h = '<section class="pnl-hist pnl-hist-lead" data-r="record"><div class="pnl-hist-h">Historical model results ' + help('historical', 'the historical record') + '</div>';
    if ((S.scope !== 'all' || S.market !== 'all') && span) h += '<div class="pnl-hist-by"><span><b>' + int(R.graded) + '</b> graded · ' + esc(span) + '</span></div>';
    if (S.scope === 'all' && d.recBy.league.length > 1) {
      h += '<div class="pnl-hist-by">' + d.recBy.league.filter(function (x) { return x.graded; }).map(function (x) {
        return '<span><b>' + esc(x.key) + '</b> ' + esc(x.record) + ' · ' + (x.win_rate_pct == null ? '—' : esc(pct(x.win_rate_pct, 1))) + '</span>';
      }).join('') + '</div>';
    }
    var notes = [];
    if (R.verified) notes.push('<b>' + int(R.verified) + '</b> of these settled at a verified price and are the Verified P&amp;L above.');
    if (R.record_only) {
      var why = {}, keys = [];
      d.recRows.forEach(function (x) { if (K().rowState(x) !== 'RECORD_ONLY') return; var k = x.price_why || x.pnl_exclusion_reason || 'missing_price'; if (!why[k]) { why[k] = 0; keys.push(k); } why[k]++; });
      keys.sort(function (a, b) { return why[b] - why[a]; });
      notes.push('<b>' + int(R.record_only) + '</b> record-only decision' + (R.record_only === 1 ? '' : 's') + ' — a result with no verified price: in the record, never in P&amp;L'
        + (keys.length ? ' (' + keys.slice(0, 3).map(function (k) { return esc(reasonText(k)) + ': ' + int(why[k]); }).join(' · ') + ')' : '') + '.');
    }
    var W = d.waiting;
    if (W.total) {
      var top = W.reasons.slice(0, 2).map(function (x) { return esc(x.label) + ': ' + int(x.n); }).join(' · ');
      notes.push('<b>' + int(W.total) + '</b> recommendation' + (W.total === 1 ? '' : 's') + ' pending' + (top ? ' (' + top + (W.reasons.length > 2 ? ', …' : '') + ')' : '')
        + ' <button type="button" class="pnl-link" data-why>Why pending</button>');
    }
    h += notes.map(function (n) { return '<p class="pnl-hist-note">' + n + '</p>'; }).join('') + '</section>';
    el.innerHTML = h;
  }
  /* a record-only reason in words: the price search's own, else the exclusion */
  function reasonText(k) {
    if (WHY_TXT[k]) return WHY_TXT[k];
    var E = K().EXCLUSION || {};
    return E[k] ? E[k].charAt(0).toLowerCase() + E[k].slice(1) : 'no price was captured with the decision';
  }

  /* where EdgeDesk's stored game prices begin (summary.verified.price_sources) */
  function priceStartHTML(S) {
    var V = S.sum.verified || {}, P = V.price_sources;
    if (!P || !P.every_game_from) return '';
    var lgs = Object.keys(P.every_game_from).sort();
    if (!lgs.length) return '';
    return '<li data-r="pricestart"><b>Where stored prices begin.</b> A model number published before EdgeDesk stored a quote for its game cannot be priced after the fact. EdgeDesk stores every game\u2019s sportsbook quotes '
      + lgs.map(function (lg) { var t = P.every_game_from[lg]; return '<b>' + esc(LEAGUE_TXT[lg] || lg) + '</b>: ' + (t ? 'from ' + esc(dateShort(t)) : 'starting with the next update'); }).join(' · ')
      + '. Player props and BETs carry the price captured with the decision.</li>';
  }
  /* ---- How P&L works (collapsed) ------------------------------------------ */
  function renderHow(S) {
    var el = box(S, 'howbody');
    if (el.getAttribute('data-ready')) return;
    el.setAttribute('data-ready', '1');
    var H = K().HELP, ex = S.sum.excluded_sources || [];
    el.innerHTML = '<ul class="pnl-ul">'
      + '<li><b>Two questions.</b> <b>Model performance</b> is how often the model was right: every graded decision — the model\u2019s published number on a game and every BET — as wins, losses and pushes. <b>Verified P&amp;L</b> is whether the priced ones made money. A good record is not proof of profit.</li>'
      + '<li><b>No price, no verified P&amp;L.</b> A decision counts only when it settled at a real American price EdgeDesk captured <b>at or before</b> the decision. Everything else stays in the record as <b>record only</b>, with its reason. EdgeDesk never assumes −110, never uses a closing price as the entry, and never re-prices with today\u2019s odds.</li>'
      + '<li><b>The model\u2019s own numbers</b> are priced only from a sportsbook quote EdgeDesk stored before the number was published, for the exact number it was graded at. That price is then locked; a later market move never changes it.</li>'
      + '<li><b>Stakes.</b> <b>Recorded stakes</b> risks the units a decision recorded (0.25–1.00u), or the default ' + esc(defaultStake(S).toFixed(2)) + 'u when it recorded none (the model\u2019s numbers, leans) — marked “default”. <b>Flat 1u</b> risks one unit on each. The two are never mixed.</li>'
      + '<li><b>Win</b> pays stake × odds ÷ 100 at plus odds, stake × 100 ÷ |odds| at minus odds. <b>Loss</b> is −stake. <b>Push</b> or <b>void</b> is 0 and risks nothing.</li>'
      + '<li><b>ROI</b> = net units ÷ units risked × 100 — never per bet.</li>'
      + '<li><b>Pending</b> decisions count once they settle, never before.</li>'
      + priceStartHTML(S)
      + '</ul>'
      + '<dl class="pnl-gloss">' + [['Units', H.units], ['CLV', H.clv], ['Drawdown', H.drawdown]].map(function (t) { return '<dt>' + esc(t[0]) + '</dt><dd>' + esc(t[1]) + '</dd>'; }).join('') + '</dl>'
      + (ex.length ? '<p class="pnl-note"><b>Left out, and why.</b></p><ul class="pnl-ul">' + ex.map(function (x) { return '<li><b>' + esc(x.source) + '</b> — ' + esc(x.rows) + ' row' + (x.rows === 1 ? '' : 's') + ': ' + esc(x.reason) + '</li>'; }).join('') + '</ul>' : '');
  }

  /* ============================================================ ADVANCED
     Everything for research, collapsed by default, built only when opened —
     from the same dataset as the card above. */
  function renderAdvanced(S) {
    var el = box(S, 'advbody'), d = dataset(S);
    if (!d) { el.innerHTML = '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read.' : 'Loading the ledger…') + '</div>'; return; }
    var A = advanced(S, d), s = d.summary, st = s.streaks || {}, P = K();
    var h = '<p class="pnl-note">The same rows as the summary above, cut every way. Read every line with its sample tag.</p>';
    h += recordTablesHTML(S, d);
    if (!s.n) {
      /* no settled priced bet: the P&L tables would be all '—'. Say it once. */
      h += '<section class="pnl-sec" data-r="pnlwait"><div class="pnl-sh"><h4>Verified P&amp;L analytics</h4></div><div class="pnl-wait"><b>'
        + (d.card.pending_priced ? 'Waiting for settlement' : 'No settled priced decisions in this view') + '</b>'
        + (d.card.pending_priced ? ' — ' + int(d.card.pending_priced) + ' priced decision' + (d.card.pending_priced === 1 ? '' : 's') + ' pending' + (d.next ? ', first game ' + esc(dateShort(new Date(d.next).toISOString())) : '') : '')
        + '. Units, ROI, drawdown, calibration and CLV start with the first decision that settles at a verified price.</div></section>';
      h += statesHTML(S, d, A);
      el.innerHTML = h;
      return;
    }
    h += '<section class="pnl-sec"><div class="pnl-sh"><h4>More numbers</h4></div><div class="pnl-cards">'
      + card('Total risked', money(S, s.risked_units, true), 'pushes and voids return the stake')
      + card('Default stakes', int(d.card.default_stake), 'priced decisions that recorded no stake: ' + defaultStake(S).toFixed(2) + 'u each')
      + card('Average odds', s.avg_odds == null ? '—' : P.fmtOdds(s.avg_odds), 'stake-weighted, from decimal prices')
      + card('Break-even win rate', s.break_even_pct == null ? '—' : pct(s.break_even_pct, 1), 'what these prices needed', '', 'break_even')
      + card('Profit factor', s.profit_factor == null ? '—' : s.profit_factor.toFixed(2), s.profit_factor_note || 'gross units won ÷ gross units lost', s.profit_factor == null ? '' : s.profit_factor >= 1 ? 'pnl-pos' : 'pnl-neg', 'profit_factor')
      + card('Current streak', st.current || '—', 'pushes neither extend nor break it', st.current_kind === 'win' ? 'pnl-pos' : st.current_kind === 'loss' ? 'pnl-neg' : '')
      + card('Longest streaks', (st.longest_win ? 'W' + st.longest_win : '—') + ' / ' + (st.longest_loss ? 'L' + st.longest_loss : '—'), 'winning / losing')
      + card('Avg CLV', s.avg_clv_points == null ? '—' : signed(s.avg_clv_points, 2, ' pts'), s.avg_clv_prob_pp == null ? (s.clv_n ? 'line CLV, n=' + s.clv_n : 'no close captured yet') : 'price CLV ' + signed(s.avg_clv_prob_pp, 2, ' pp'), tone(s.avg_clv_points), 'clv')
      + card('CLV hit rate', s.clv_hit_rate_pct == null ? '—' : pct(s.clv_hit_rate_pct, 1), s.clv_hit_n ? 'beat the close on ' + s.clv_hit_n + ' measured' : 'no close measured yet')
      + '</div></section>';
    h += drawdownHTML(S, s);
    h += compareHTML(S, A);
    h += breakdownsHTML(S, A);
    h += calibrationHTML(S, A);
    h += clvHTML(S, A);
    h += statesHTML(S, d, A);
    el.innerHTML = h;
  }
  /* WHERE THE RECORD COMES FROM: the graded record by sport, market, model
     version, week and grade — W-L-P, populated whether or not a price was
     captured; units only where it was (the P&L tables below) */
  var REC_TABLES = [['league', 'By sport'], ['market', 'By market'], ['model_version', 'By model version'], ['week', 'By week'], ['grade', 'By grade']];
  function recordTablesHTML(S, d) {
    var h = '<section class="pnl-sec" data-r="rectables"><div class="pnl-sh"><h4>Where the record comes from</h4><span class="pnl-sub">every graded pick, W-L-P — priced or not</span></div>';
    REC_TABLES.forEach(function (t, i) {
      var list = d.recBy[t[0]] || [];
      h += '<details class="pnl-det"' + (i === 0 ? ' open' : '') + '><summary>' + esc(t[1]) + ' <span class="pnl-cnt">' + list.length + '</span></summary>'
        + (list.length ? recTable(list, t[1].replace(/^By /, '')) : '<div class="pnl-empty sm">Nothing graded in this view yet.</div>') + '</details>';
    });
    return h + '</section>';
  }
  function recTable(list, first) {
    var h = '<div class="pnl-tw"><table class="pnl-t pnl-rt"><thead><tr><th>' + esc(first.charAt(0).toUpperCase() + first.slice(1)) + '</th><th>Graded</th><th>W-L-P</th><th>Win %</th><th>Verified bets</th><th>Record only</th><th>Pending</th></tr></thead><tbody>';
    list.forEach(function (x) {
      h += '<tr><td data-l="' + esc(first) + '"><b>' + esc(x.key) + '</b> ' + (x.graded ? sampleTag(x.sample) : '') + '</td>'
        + '<td data-l="Graded">' + int(x.graded) + '</td>'
        + '<td data-l="W-L-P">' + (x.graded ? esc(x.record) : '—') + '</td>'
        + '<td data-l="Win %">' + (x.win_rate_pct == null ? '—' : pct(x.win_rate_pct, 1)) + '</td>'
        + '<td data-l="Verified bets">' + int(x.verified) + '</td>'
        + '<td data-l="Record only">' + int(x.record_only) + '</td>'
        + '<td data-l="Pending">' + int(x.pending) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  /* EVERY ROW'S STATE, WHY "PENDING", AND THE AGREEMENT CHECKS — the
     diagnostics, inside Advanced, never on the face of the page */
  function statesHTML(S, d, A) {
    var st = A.states, W = d.waiting, set = (S.sum && S.sum.settlement) || {}, P = K();
    var h = '<section class="pnl-sec" data-r="states"><div class="pnl-sh"><h4>Every recommendation\'s state ' + help('states', 'states') + '</h4><span class="pnl-sub">each row in this view, exactly once</span></div><div class="pnl-dq">';
    P.STATE_ORDER.forEach(function (k) { h += dq(P.STATE_TEXT[k], int(st[k]), stateSub(k), null, k); });
    h += dq('Corrected after settlement', int(A.quality.corrected), 'logged on the row, never silent');
    h += '</div>';
    h += '<div class="pnl-why" data-r="why"><h5 class="pnl-h5">Why pending ' + help('pending', 'pending reasons') + '</h5>';
    if (!W.total) h += '<p class="pnl-note">Nothing is pending in this view.</p>';
    else h += '<ul class="pnl-whyl">' + W.reasons.map(function (x) { return '<li data-reason="' + esc(x.key) + '"><span>' + esc(x.label) + '</span><b>' + int(x.n) + '</b></li>'; }).join('')
      + '<li class="pnl-whyt"><span>Pending recommendations</span><b>' + int(W.total) + '</b></li></ul>';
    var as = set.as_of || (S.sum && S.sum.generated_at);
    var props = set.props ? Object.keys(set.props).map(function (lg) {
      var x = set.props[lg];
      return lg + ' props grader: ' + (x.checked_at ? 'last reported ' + dateLong(x.checked_at) + (x.dataset_ok === false ? ' — its stat dataset failed to load' : '') : 'no report yet');
    }) : [];
    h += '<p class="pnl-note">As of the last ledger build' + (as ? ', ' + esc(dateLong(as)) : '') + '.' + (props.length ? ' ' + esc(props.join(' · ')) + '.' : '') + '</p></div>';
    var I = d.integrity;
    h += '<p class="pnl-note ' + (I.ok ? '' : 'warn') + '" data-r="integrity">' + (I.ok ? 'All ' + I.n + ' agreement checks pass: the summary, record, tabs, chart, breakdowns and ledger are computed from the same rows and agree.'
      : '<b>' + I.failed.length + ' agreement check' + (I.failed.length === 1 ? '' : 's') + ' failed</b>: ' + I.failed.map(function (f) { return esc(f.label); }).join('; ')) + '</p>';
    var al = alerts(S);
    if (al.length) h += '<p class="pnl-note warn"><b>' + al.length + ' integrity alert(s):</b> a source tried to change a recorded recommendation; the ledger kept what was recommended.</p>';
    return h + '</section>';
  }
  function stateSub(k) {
    return { PENDING: 'not settled yet — see why below', VERIFIED: 'settled at a captured entry price', RECORD_ONLY: 'a result, no captured entry price: W-L only', VOID: 'stake returned', INVALID: 'cannot be graded as recorded' }[k] || '';
  }
  function card(label, value, sub, cls, helpKey) {
    return '<div class="pnl-card"><div class="pnl-cl">' + esc(label) + (helpKey ? ' ' + help(helpKey, label) : '') + '</div>'
      + '<div class="pnl-v ' + (cls || '') + '">' + esc(value) + '</div>' + (sub ? '<div class="pnl-cs">' + esc(sub) + '</div>' : '') + '</div>';
  }
  function alerts(S) {
    var a = (S.sum && S.sum.integrity_alerts) || [];
    return a.filter(function (x) { return !S.rows || !!S.byId[x.recommendation_id]; });
  }
  function dq(label, n, sub, helpKey, state) {
    return '<div class="pnl-dqi"' + (state ? ' data-state="' + esc(state) + '"' : '') + '><div class="pnl-dqn">' + esc(n == null ? 0 : n) + '</div><div class="pnl-dql">' + esc(label) + (helpKey ? ' ' + help(helpKey, label) : '') + '</div><div class="pnl-cs">' + esc(sub) + '</div></div>';
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
  function compareHTML(S, A) {
    var c = A.compare || {};
    function col(title, x) {
      x = x || {};
      return '<div class="pnl-cmp"><div class="pnl-cmph">' + esc(title) + ' ' + sampleTag(x.sample) + '</div>'
        + row('Bets', String(x.n || 0)) + row('Units', money(S, x.net_units), tone(x.net_units)) + row('ROI', x.roi_pct == null ? '—' : pct(x.roi_pct, 1, true), tone(x.roi_pct))
        + row('CLV', x.avg_clv_points == null ? '—' : signed(x.avg_clv_points, 2, ' pts'), tone(x.avg_clv_points)) + row('Win %', x.win_rate_pct == null ? '—' : pct(x.win_rate_pct, 1)) + '</div>';
    }
    function row(l, val, cls) { return '<div class="pnl-kv"><span>' + esc(l) + '</span><b class="' + (cls || '') + '">' + esc(val) + '</b></div>'; }
    var pc = A.breakdowns.prop_category;
    return '<section class="pnl-sec"><div class="pnl-sh"><h4>Game markets vs player props</h4></div>'
      + '<div class="pnl-cmps">' + col('Game markets', c.game) + col('Player props', c.props) + '</div>'
      + (pc && pc.length ? '<h5 class="pnl-h5">Player props by category</h5>' + table(S, pc, 'Category') : '') + '</section>';
  }
  var BREAKDOWNS = [
    ['league', 'By league'], ['market', 'By market'], ['prop_type', 'By player prop type'], ['side', 'By side'], ['book', 'By book'],
    ['edge', 'By model edge'], ['grade', 'By recommendation grade'], ['unit_size', 'By unit size'], ['odds_range', 'By odds range'], ['week', 'By week'], ['month', 'By month'],
    ['price_source', 'By price source'], ['model_version', 'Model version performance']
  ];
  var BD_NOTE = {
    book: 'Only books EdgeDesk actually captured a price at.',
    edge: 'Does a larger claimed edge produce a better result? Read with the sample tags.',
    grade: 'Every grade at a flat 1u, at its own recorded price — the one table that reads leans, watches and passes, to tell whether the gating adds value.',
    price_source: 'Captured with the decision (props, BETs) or a quote EdgeDesk stored before the model published its number (the model\u2019s own numbers).',
    unit_size: 'EdgeDesk staking, by the stake it recommended.',
    model_version: 'Versions are never merged: each is judged on the recommendations it made.'
  };
  function breakdownsHTML(S, A) {
    var b = A.breakdowns;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>Performance breakdowns</h4><span class="pnl-sub">tap a heading to open it</span></div>';
    BREAKDOWNS.forEach(function (d) {
      var list = b[d[0]] || [];
      h += '<details class="pnl-det"><summary>' + esc(d[1]) + ' <span class="pnl-cnt">' + list.length + '</span></summary>'
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
  function calibrationHTML(S, A) {
    var c = A.breakdowns.calibration;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>Edge calibration</h4><span class="pnl-sub">does the edge EdgeDesk claimed go with the result it got?</span></div>'
      + '<p class="pnl-note">Expected win % is the average probability EdgeDesk gave the side; actual is what happened. A bucket is judged only past 50 bets, and only when the gap is larger than its own noise.</p>';
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
  function clvHTML(S, A) {
    var c = A.breakdowns.clv;
    var h = '<section class="pnl-sec"><div class="pnl-sh"><h4>CLV vs P&amp;L ' + help('clv', 'CLV') + '</h4><span class="pnl-sub">is beating the closing line turning into profit?</span></div>';
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

  /* ------------------------------------------------------------ the chart
     Cumulative units (2px accent line) and the running peak (thin muted
     line): one axis, units. x = the bet's place in order; a crosshair snaps
     to the nearest bet, by pointer, tap or arrow keys. */
  function drawChart(S, d) {
    var el = S.host.querySelector('[data-chart]');
    if (!el) return;
    var ser = d.series;
    var W = Math.max(300, Math.round(el.clientWidth || 640)), H = W < 480 ? 200 : 240;
    S.chartW = W;
    var padL = 50, padR = 14, padT = 14, padB = 30;
    var pts = [{ date: null, profit: 0, cum: 0, peak: 0, id: null }].concat(ser);
    var lo = 0, hi = 0;
    pts.forEach(function (p) { lo = Math.min(lo, p.cum); hi = Math.max(hi, p.peak, p.cum); });
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    var span = hi - lo; lo -= span * 0.08; hi += span * 0.08;
    var n = pts.length - 1;
    function X(i) { return padL + (n ? (i / n) : 0) * (W - padL - padR); }
    function Y(val) { return padT + (hi - val) / (hi - lo) * (H - padT - padB); }
    var step = niceStep((hi - lo) / 4), ticks = [];
    for (var t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000);
    var svg = '<svg class="pnl-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" tabindex="0" aria-label="Cumulative verified units, ' + n + ' settled priced decisions, ending at ' + esc(money(S, ser[ser.length - 1].cum)) + '. Use the left and right arrow keys to read each decision.">';
    ticks.forEach(function (tv) {
      var y = Y(tv);
      svg += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" class="' + (Math.abs(tv) < 1e-9 ? 'pnl-zero' : 'pnl-grid') + '"/>'
        + '<text x="' + (padL - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" class="pnl-ax">' + esc(axisMoney(S, tv)) + '</text>';
    });
    [1, Math.ceil(n / 2), n].filter(function (i, k, a) { return i >= 1 && a.indexOf(i) === k; }).forEach(function (i, k, a) {
      var anchor = a.length > 1 && k === 0 ? 'start' : (k === a.length - 1 && a.length > 1 ? 'end' : 'middle');
      svg += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 9) + '" text-anchor="' + anchor + '" class="pnl-ax">' + esc(dateShort((pts[i].date || '') + 'T12:00:00Z')) + '</text>';
    });
    var cum = '', peak = '';
    pts.forEach(function (p, i) { cum += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.cum).toFixed(1); peak += (i ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.peak).toFixed(1); });
    svg += '<path d="' + peak + '" class="pnl-peak"/><path d="' + cum + '" class="pnl-line"/>';
    var last = pts[pts.length - 1];
    svg += '<circle cx="' + X(n).toFixed(1) + '" cy="' + Y(last.cum).toFixed(1) + '" r="4.5" class="pnl-end"/>';
    svg += '<line class="pnl-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden"/><circle class="pnl-hit" r="5" cx="0" cy="0" visibility="hidden"/>';
    svg += '<rect class="pnl-over" x="' + padL + '" y="0" width="' + (W - padL - padR) + '" height="' + H + '"/></svg>';
    el.innerHTML = svg + '<div class="pnl-tip" hidden></div>';
    var svgEl = el.querySelector('svg'), tip = el.querySelector('.pnl-tip'), cross = svgEl.querySelector('.pnl-cross'), dot = svgEl.querySelector('.pnl-hit');
    var cur = null;
    function show(i) {
      i = Math.max(1, Math.min(n, i)); cur = i;
      var p = pts[i], x = X(i), y = Y(p.cum);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('visibility', 'visible');
      tipContent(S, tip, p);
      tip.hidden = false;
      var bw = el.clientWidth || W, tw = tip.offsetWidth || 220;
      var left = x * (bw / W) + 12; if (left + tw > bw - 4) left = Math.max(4, x * (bw / W) - tw - 12);
      tip.style.left = left + 'px'; tip.style.top = Math.max(4, y * (bw / W) - 20) + 'px';
    }
    function hide() { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; }
    function at(evt) {
      var r = svgEl.getBoundingClientRect(), cx = (evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left;
      var x = cx * (W / r.width);
      return Math.round(((x - padL) / (W - padL - padR)) * n);
    }
    svgEl.addEventListener('pointermove', function (e) { show(at(e)); });
    svgEl.addEventListener('pointerdown', function (e) { show(at(e)); });
    svgEl.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });
    svgEl.addEventListener('blur', hide);
    svgEl.addEventListener('keydown', function (e) {
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
    var x = S.byId[p.id] || null;
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    function line(txt, cls) { var d = document.createElement('div'); d.textContent = txt; if (cls) d.className = cls; tip.appendChild(d); }
    line(x ? dateShort(x.game_date) : dateShort((p.date || '') + 'T12:00:00Z'), 'pnl-tip-d');
    if (x) {
      line(betText(x), 'pnl-tip-s');
      var st = rowStake(S, x);
      line('Odds: ' + K().fmtOdds(x.entry_odds) + ' · Stake: ' + (isNum(st) ? Number(st).toFixed(2) : '1.00') + 'u' + (x.stake_source === 'default' || (x.rec_class === 'LEAN' && !(x.stake_units > 0) && S.mode === 'staked') ? ' (default)' : ''));
      line('Result: ' + (RESULT_TXT[x.result] || x.result));
    }
    line('P&L: ' + money(S, p.profit), 'pnl-tip-v ' + tone(p.profit));
    line('Running total: ' + money(S, p.cum), 'pnl-tip-v');
  }
  /* what was bet, in one line: "BUF -7", "Over 47.5", "J. Allen Over 262.5 Pass Yds" */
  function betText(x) {
    if (x.market_group === 'prop') return (x.player_name ? x.player_name + ' ' : '') + (x.selection || '') + (x.prop_label ? ' ' + x.prop_label : '');
    /* a total names no team: the game says which one it was */
    if (x.market_type === 'total' && x.event_label) return (x.selection || '') + ' · ' + x.event_label;
    return x.selection || x.event_label || '';
  }

  /* ------------------------------------------------------------ players (advanced) */
  function renderPlayersShell(S) {
    var el = box(S, 'players');
    if (el.getAttribute('data-ready')) return;
    el.setAttribute('data-ready', '1');
    el.innerHTML = '<div class="pnl-sh"><h4>Player prop performance</h4><span class="pnl-sub">every player EdgeDesk has recommended a prop on</span></div>'
      + '<div class="pnl-prow"><input type="search" class="pnl-in" data-pq placeholder="Search a player, team or league" aria-label="Search players">'
      + '<div data-r="pcls"></div></div><div data-r="plist"></div>';
  }
  function playerBase(S) { var d = dataset(S); return d ? d.base : []; }
  function renderPlayers(S) {
    var el = S.host.querySelector('[data-r="plist"]'), cb = S.host.querySelector('[data-r="pcls"]');
    if (!el) return;
    cb.innerHTML = seg('data-pcls', [['BET', 'Bets'], ['ALL', 'Bets + Leans (flat 1u)']], S.pcls);
    if (!S.rows) { el.innerHTML = '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read.' : 'Loading the ledger…') + '</div>'; return; }
    var P = K(), mode = S.pcls === 'ALL' ? 'flat' : S.mode, pred = S.pcls === 'ALL' ? function (x) { return x.rec_class === 'BET' || x.rec_class === 'LEAN'; } : null;
    var rows = playerBase(S);
    if (S.pcls === 'ALL') rows = rows.filter(pred);
    var list = P.players(rows, mode, pred);
    var q = S.pq.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return [p.player_name, p.team, p.league, LEAGUE_TXT[p.league], p.position].join(' ').toLowerCase().indexOf(q) >= 0; });
    if (!list.length) { el.innerHTML = '<div class="pnl-empty sm">' + (q ? 'No player matches “' + esc(S.pq) + '”.' : 'No player prop recommendation in this view yet.') + '</div>'; return; }
    var per = 20, pages = Math.ceil(list.length / per); S.ppage = Math.min(S.ppage, pages - 1);
    var show = list.slice(S.ppage * per, S.ppage * per + per);
    /* checked against the rows, not assumed: has any of these props finished? */
    var settledAny = list.some(function (p) { return p.settled > 0; });
    var tracked = list.reduce(function (a, p) { return a + p.tracked; }, 0);
    var nextT = playerBase(S).filter(function (x) { return x.market_group === 'prop' && P.rowState(x) === 'PENDING'; })
      .reduce(function (a, x) { var t = Date.parse(x.game_date || ''); return isFinite(t) && (a == null || t < a) ? t : a; }, null);
    var h = settledAny ? '' : '<div class="pnl-wait" data-r="pwait"><b>Waiting for settlement</b> — none of these ' + int(tracked) + ' tracked props has finished yet'
      + (nextT ? ' (first game ' + esc(dateShort(new Date(nextT).toISOString())) + ')' : '') + '. W-L-P and units start with the first settled one.</div>';
    h += '<div class="pnl-tw"><table class="pnl-t pnl-pt"><thead><tr><th>Player</th><th>League</th><th>Team</th><th>Props tracked</th><th>W-L-P</th><th>Units</th><th>ROI</th><th>Avg edge</th><th>Avg CLV</th></tr></thead><tbody>';
    show.forEach(function (p) {
      var open = S.player === p.key;
      h += '<tr class="pnl-click' + (open ? ' open' : '') + '" data-player="' + esc(p.key) + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<td data-l="Player"><b>' + esc(p.player_name) + '</b>' + (p.position ? ' <span class="pnl-mut">' + esc(p.position) + '</span>' : '') + (p.n ? ' ' + sampleTag(p.sample) : '') + '</td>'
        + '<td data-l="League">' + esc(LEAGUE_TXT[p.league] || p.league) + '</td><td data-l="Team">' + esc(p.team || '—') + '</td>'
        + '<td data-l="Props tracked">' + p.tracked + (p.settled < p.tracked ? ' <span class="pnl-mut">(' + p.settled + ' settled)</span>' : '') + '</td>'
        + '<td data-l="W-L-P">' + (p.n ? esc(p.wins + '-' + p.losses + '-' + p.pushes) : '—') + '</td>'
        + '<td data-l="Units" class="' + tone(p.net_units) + '">' + money(S, p.net_units) + '</td>'
        + '<td data-l="ROI" class="' + tone(p.roi_pct) + '">' + (p.roi_pct == null ? '—' : pct(p.roi_pct, 1, true)) + '</td>'
        + '<td data-l="Avg edge">' + (p.avg_edge_pct == null ? '—' : signed(p.avg_edge_pct, 2, '%')) + '</td>'
        + '<td data-l="Avg CLV" class="' + tone(p.avg_clv_points) + '">' + (p.avg_clv_points == null ? '—' : signed(p.avg_clv_points, 2)) + '</td></tr>';
      if (open) h += '<tr class="pnl-drill"><td colspan="9">' + playerDrill(S, p, mode, pred) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (pages > 1) h += '<div class="pnl-pager"><button type="button" class="pnl-btn" data-ppage="-1"' + (S.ppage ? '' : ' disabled') + '>Previous</button><span>' + (S.ppage + 1) + ' / ' + pages + ' · ' + list.length + ' players</span><button type="button" class="pnl-btn" data-ppage="1"' + (S.ppage < pages - 1 ? '' : ' disabled') + '>Next</button></div>';
    el.innerHTML = h;
  }
  function playerDrill(S, p, mode, pred) {
    var P = K();
    var rows = playerBase(S).filter(function (x) { return x.market_group === 'prop' && (x.league + '|' + (x.player_id || x.player_name)) === p.key; });
    var counted = rows.filter(pred || P.isBet).map(function (x) { return pred ? Object.assign({}, x, { rec_class: 'BET' }) : x; });
    var byType = P.breakdown(counted, function (x) { return x.prop_label || x.prop_market; }, mode);
    var bySide = P.breakdown(counted, function (x) { return x.side === 'over' ? 'Over' : x.side === 'under' ? 'Under' : null; }, mode, ['Over', 'Under']);
    var h = '<div class="pnl-drillin"><p class="pnl-note">' + esc(p.player_name) + ': ' + rows.length + ' recommendation' + (rows.length === 1 ? '' : 's') + ' on file. ' + esc(p.sample.text) + '.</p>';
    h += byType.length ? '<h5 class="pnl-h5">By prop type</h5>' + table(S, byType, 'Prop type') : '';
    h += bySide.length ? '<h5 class="pnl-h5">Over vs under</h5>' + table(S, bySide, 'Side') : '';
    h += '<h5 class="pnl-h5">Game log — every recommendation</h5>' + ledgerTable(S, rows.slice().sort(function (a, b) { return (Date.parse(b.game_date) || 0) - (Date.parse(a.game_date) || 0); }));
    return h + '</div>';
  }

  /* ============================================================ THE LEDGER
     The bets of the summary above, one row each: date, sport, bet, odds,
     result, units. A row opens to its full audit. Its settled total is the
     summary's net, by construction. */
  function rowPnl(S, x) { return rowProfit(S, x); }
  function counted(S, x) { return x.pnl_status === 'VERIFIED' && isNum(rowPnl(S, x)); }
  function renderLedgerShell(S) {
    var el = box(S, 'ledger');
    if (el.getAttribute('data-ready')) return;
    el.setAttribute('data-ready', '1');
    el.innerHTML = '<div class="pnl-sh"><h4>Ledger</h4><span class="pnl-sub">every graded decision and every bet, one row each — tap a row for its price, stake and audit</span></div>'
      + '<div class="pnl-lbar"><input type="search" class="pnl-in" data-lq value="" placeholder="Search team, player, market or book" aria-label="Search the ledger"><div data-r="lstat"></div></div>'
      + '<div data-r="lrows"></div>';
  }
  /* the ledger's three views of the one dataset:
       verified  the strategy's bets settled at a captured price (and voids):
                 the summary's own rows — their total is the hero's net
       history   every graded pick of the record (model picks and bets),
                 priced or not: the record's own rows — its count is the
                 record's graded count
       pending   the strategy's bets not settled yet */
  function ledgerPool(S, d, status) {
    var P = K();
    if (status === 'verified') return d.bets.filter(function (x) { var st = P.rowState(x); return st === 'VERIFIED' || st === 'VOID'; });
    if (status === 'pending') return d.bets.filter(function (x) { return P.rowState(x) === 'PENDING'; });
    return d.recRows.filter(function (x) { var st = P.rowState(x); return st === 'VERIFIED' || st === 'RECORD_ONLY'; });
  }
  function ledgerRows(S, d) {
    var q = S.lq.trim().toLowerCase();
    return ledgerPool(S, d, S.lstatus).filter(function (x) {
      if (q) {
        var hay = [x.player_name, x.team, x.opponent, x.event_label, x.home, x.away, x.selection, x.prop_label, MARKET_TXT[x.market_type], x.entry_book_name, x.entry_book, x.model_version, x.league, LEAGUE_TXT[x.league], x.recommendation_id].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return (Date.parse(b.game_date) || 0) - (Date.parse(a.game_date) || 0) || (a.recommendation_id < b.recommendation_id ? -1 : 1); });
  }
  function renderLedger(S) {
    var el = box(S, 'lrows'), sb = box(S, 'lstat');
    if (!el) return;
    var d = dataset(S);
    if (!d) { el.innerHTML = '<div class="pnl-empty">' + (S.rowsErr ? 'The ledger could not be read: ' + esc(S.rowsErr) : 'Loading the ledger…') + '</div>'; return; }
    var nVer = ledgerPool(S, d, 'verified').length, nHist = ledgerPool(S, d, 'history').length;
    /* it opens where the rows are: verified P&L once there is some, else the graded history */
    if (S.lstatus == null || ['verified', 'history', 'pending'].indexOf(S.lstatus) < 0) S.lstatus = nVer ? 'verified' : nHist ? 'history' : 'pending';
    sb.innerHTML = seg('data-lstatus', [
      ['verified', 'Verified P&L ' + int(nVer), 'Verified<span class="pnl-long"> P&amp;L</span> ' + esc(int(nVer))],
      ['history', 'Historical graded ' + int(nHist), '<span class="pnl-long">Historical graded</span><span class="pnl-short" aria-hidden="true">History</span> ' + esc(int(nHist))],
      ['pending', 'Pending ' + int(d.pending)]], S.lstatus, 'pnl-seg-sm');
    var rows = ledgerRows(S, d);
    var pages = Math.max(1, Math.ceil(rows.length / S.per)); S.page = Math.min(S.page, pages - 1);
    var show = rows.slice(S.page * S.per, S.page * S.per + S.per);
    var s = d.summary, R = d.record, h;
    if (S.lstatus === 'history') {
      h = '<div class="pnl-lcount">Historical graded: <b>' + int(R.graded) + '</b> result' + (R.graded === 1 ? '' : 's') + (R.graded ? ' · <b>' + esc(R.record) + '</b> · ' + esc(pct(R.win_rate_pct, 1)) + ' won' : '')
        + (R.record_only ? ' · ' + (R.verified ? int(R.verified) + ' verified, ' : '') + int(R.record_only) + ' record only — no verified price, so no units' : '') + '</div>';
    } else if (S.lstatus === 'pending') {
      h = '<div class="pnl-lcount">' + (d.pending ? '<b>' + int(d.pending) + '</b> ' + (S.leans ? 'decisions and leans' : 'decision' + (d.pending === 1 ? '' : 's')) + ' waiting for settlement — not in any total until they settle' : 'Nothing pending in this view')
        + (d.leans.pending ? ' · <b>' + int(d.leans.pending) + '</b> player-prop lean' + (d.leans.pending === 1 ? '' : 's') + ' tracked too — <button type="button" class="pnl-link" data-leans-on>include leans</button> to list them' : '') + '</div>';
    } else {
      h = '<div class="pnl-lcount">' + (s.n ? 'Verified total: <b class="' + tone(s.net_units) + '">' + esc(money(S, s.net_units)) + '</b> over ' + int(s.n) + ' settled priced decision' + (s.n === 1 ? '' : 's') + ' — the Verified P&amp;L above'
        : d.card.pending_priced ? 'Waiting for first priced settlements — ' + int(d.card.pending_priced) + ' priced decision' + (d.card.pending_priced === 1 ? '' : 's') + ' pending' : 'No settled priced decisions in this view') + '</div>';
    }
    if (!rows.length) { el.innerHTML = h + '<div class="pnl-empty sm">' + (S.lq.trim() ? 'No row matches “' + esc(S.lq.trim()) + '”.' : S.lstatus === 'verified' ? (d.card.pending_priced ? 'The first settled priced decision will appear here.' : 'No settled priced decision in this view.') : S.lstatus === 'history' ? 'Nothing graded in this view yet.' : d.leans.pending ? 'The tracked leans are listed once you include them.' : 'Nothing pending in this view.') + '</div>'; return; }
    h += S.lstatus === 'history' ? historyTable(S, show) : ledgerTable(S, show);
    if (pages > 1) h += '<div class="pnl-pager"><button type="button" class="pnl-btn" data-page="-1"' + (S.page ? '' : ' disabled') + '>Previous</button><span>Page ' + (S.page + 1) + ' of ' + pages + '</span><button type="button" class="pnl-btn" data-page="1"' + (S.page < pages - 1 ? '' : ' disabled') + '>Next</button></div>';
    el.innerHTML = h;
  }
  /* the units a row risks and returns under the reader's stake choice */
  function rowStake(S, x) { return S.mode === 'staked' ? (x.stake_units > 0 ? x.stake_units : (x.rec_class === 'LEAN' ? defaultStake(S) : null)) : 1; }
  function rowProfit(S, x) {
    if (S.mode !== 'staked') return x.flat_profit_units;
    if (isNum(x.profit_units)) return x.profit_units;
    /* a lean counted at the default stake (asPick) */
    if (x.rec_class === 'LEAN' && (x.pnl_status === 'VERIFIED' || x.pnl_status === 'VOID')) { var p = K().profit(x.entry_odds, defaultStake(S), x.result); return isNum(p) ? Math.round(p * 1e6) / 1e6 : null; }
    return null;
  }
  /* "−108 · 1.00u risked · +0.93u" — or "Record only · Price unavailable", never a figure without a price */
  function priceCell(S, x) {
    var P = K(), st = P.rowState(x);
    if (st === 'VERIFIED' || st === 'VOID') {
      var stake = rowStake(S, x), pr = rowProfit(S, x);
      return '<span class="pnl-pc-o">' + esc(P.fmtOdds(x.entry_odds)) + '</span> · ' + (isNum(stake) ? esc(Number(stake).toFixed(2)) + 'u risked' + (x.stake_source === 'default' || (x.lean && !(x.stake_units > 0)) ? ' <span class="pnl-dflt" title="No stake was recorded: the default stake">default</span>' : '') : 'no stake') + ' · '
        + '<b class="' + tone(pr) + '">' + (isNum(pr) ? esc(money(S, pr)) : '—') + '</b>';
    }
    if (st === 'RECORD_ONLY') return '<span class="pnl-ro">Record only</span> · <span class="pnl-mut">Price unavailable</span>';
    return '<span class="pnl-mut">—</span>';
  }
  /* the graded history: date, sport, pick, result, and its price and units —
     or "Record only · Price unavailable" (no units, ever) */
  function historyTable(S, rows) {
    var P = K();
    var h = '<div class="pnl-tw pnl-tw-l"><table class="pnl-t pnl-lt pnl-ht"><thead><tr><th>Date</th><th>Sport</th><th>Bet</th><th>Result</th><th>Price · P&amp;L</th></tr></thead><tbody>';
    rows.forEach(function (x) {
      var open = !!S.open[x.recommendation_id], ver = P.rowState(x) === 'VERIFIED';
      h += '<tr class="pnl-click pnl-lr' + (open ? ' open' : '') + '" data-row="' + esc(x.recommendation_id) + '" data-state="' + (ver ? 'verified' : 'record') + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<td data-l="Date">' + esc(dateShort(x.game_date)) + '</td>'
        + '<td data-l="Sport">' + esc(x.league) + (x.lean ? ' <span class="pnl-grade">Lean</span>' : x.rec_class === 'MODEL' ? ' <span class="pnl-grade">Model</span>' : '') + '</td>'
        + '<td data-l="Bet" class="pnl-sel">' + esc(betText(x)) + (x.corrected ? ' <span class="pnl-corr" title="Corrected after settlement">corrected</span>' : '') + '</td>'
        + '<td data-l="Result">' + resultPill(x.result) + '</td>'
        + '<td data-l="Status" class="pnl-rs pnl-pc ' + (ver ? 'ver' : 'pnl-mut') + '"' + (ver ? '' : ' title="' + esc('Record only — ' + reasonText(x.price_why || x.pnl_exclusion_reason || 'missing_price')) + '"') + '>' + priceCell(S, x) + '</td></tr>';
      if (open) h += '<tr class="pnl-audit"><td colspan="5">' + auditHTML(S, x) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function resultPill(r) { return '<span class="pnl-res r-' + esc(r || 'pending') + '">' + esc(RESULT_TXT[r] || r || '—') + '</span>'; }
  function ledgerTable(S, rows) {
    var P = K();
    var h = '<div class="pnl-tw pnl-tw-l"><table class="pnl-t pnl-lt"><thead><tr><th>Date</th><th>Sport</th><th>Bet</th><th>Odds</th><th>Result</th><th>Units</th></tr></thead><tbody>';
    rows.forEach(function (x) {
      var pnl = rowPnl(S, x), open = !!S.open[x.recommendation_id];
      var st = K().rowState(x);
      var pnlTxt = counted(S, x) || x.pnl_status === 'VOID' ? money(S, pnl) : x.result === 'pending' ? '—' : st === 'RECORD_ONLY' ? 'Record only' : x.pnl_status === 'VERIFIED' && S.mode === 'staked' ? 'not staked' : '—';
      h += '<tr class="pnl-click pnl-lr' + (open ? ' open' : '') + '" data-row="' + esc(x.recommendation_id) + '" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
        + '<td data-l="Date">' + esc(dateShort(x.game_date)) + '</td>'
        + '<td data-l="Sport">' + esc(x.league) + (x.lean ? ' <span class="pnl-grade">Lean</span>' : x.rec_class === 'MODEL' ? ' <span class="pnl-grade">Model</span>' : '') + '</td>'
        + '<td data-l="Bet" class="pnl-sel">' + esc(betText(x)) + (x.corrected ? ' <span class="pnl-corr" title="Corrected after settlement">corrected</span>' : '') + '</td>'
        + '<td data-l="Odds">' + (x.entry_odds != null ? esc(P.fmtOdds(x.entry_odds)) : '<span class="pnl-mut">no price</span>') + '</td>'
        + '<td data-l="Result">' + resultPill(x.result) + '</td>'
        + '<td data-l="Units" class="pnl-pl ' + (isNum(pnl) && (counted(S, x) || x.pnl_status === 'VOID') ? tone(pnl) : 'pnl-mut') + '"' + (st === 'RECORD_ONLY' ? ' title="' + esc('Record only — ' + reasonText(x.price_why || x.pnl_exclusion_reason || 'missing_price')) + '"' : '') + '>' + esc(pnlTxt) + '</td></tr>';
      if (open) h += '<tr class="pnl-audit"><td colspan="6">' + auditHTML(S, x) + '</td></tr>';
    });
    return h + '</tbody></table></div>';
  }
  function auditHTML(S, x) {
    var P = K();
    function kv(l, v) { return '<div><dt>' + esc(l) + '</dt><dd>' + esc(v == null || v === '' ? '—' : v) + '</dd></div>'; }
    function ln(v) { return isNum(v) ? (x.market_type === 'spread' ? lineTxt(v) : numTxt(v, 1)) : null; }
    var h = '<dl class="pnl-audit-dl">'
      + kv('Game', x.event_label) + kv('Market', x.market_group === 'prop' ? (x.prop_label || x.prop_market) : MARKET_TXT[x.market_type])
      + kv('Model number', ln(x.model_line)) + kv('Entry line', ln(x.entry_line)) + kv('Closing line', ln(x.closing_line) != null ? ln(x.closing_line) + (x.closing_odds != null ? ' (' + P.fmtOdds(x.closing_odds) + ')' : '') : null)
      + kv('CLV', isNum(x.clv_points) ? signed(x.clv_points, 1, ' pts') : null) + kv('Edge', isNum(x.model_edge_pct) ? signed(x.model_edge_pct, 1, '%') : null)
      + kv('Price', x.entry_odds != null ? P.fmtOdds(x.entry_odds) + (x.price_source === 'snapshot' ? ' — the quote EdgeDesk stored before the decision, locked' : ' — captured with the decision') : 'none verified')
      + kv('Book', x.entry_book_name || x.entry_book) + kv('Model version', x.model_version)
      + kv('Decision made', dateLong(x.recommended_at)) + kv('Price captured', x.odds_captured_at ? dateLong(x.odds_captured_at) : 'not captured') + kv('Settled', x.settled_at ? dateLong(x.settled_at) : 'not yet')
      + kv('Grade', x.lean ? 'LEAN' : x.rec_class) + kv('State', P.STATE_TEXT[P.rowState(x)]) + kv('P&L status', STATUS_SHORT[x.pnl_status] || x.pnl_status)
      + (P.rowState(x) === 'PENDING' ? kv('Why pending', P.PENDING_REASON[P.pendingReasonOf(x, Date.now())]) : '')
      + kv('Model probability', isNum(x.model_prob) ? (100 * x.model_prob).toFixed(1) + '%' : null) + kv('EV at entry', isNum(x.ev_pct) ? signed(x.ev_pct, 1, '%') : null)
      + kv('Stake', x.stake_units > 0 ? Number(x.stake_units).toFixed(2) + 'u' + (x.stake_source === 'default' ? ' (default — none recorded)' : ' (recorded)') : 'none recorded') + kv('Flat 1u P&L', isNum(x.flat_profit_units) ? money(S, x.flat_profit_units) : null) + kv('Staked P&L', isNum(x.profit_units) ? money(S, x.profit_units) : null)
      + kv('Verified P&L', P.rowState(x) === 'VERIFIED' ? 'yes' : 'no — ' + reasonText(x.price_why || x.pnl_exclusion_reason || (P.rowState(x) === 'PENDING' ? 'missing_settlement' : 'missing_price')))
      + kv('Final', x.final_score || (isNum(x.result_value) ? String(x.result_value) : null)) + kv('Recommendation', x.recommendation_id)
      + '</dl>';
    if (P.rowState(x) === 'INVALID') h += '<p class="pnl-note warn">Invalid / incomplete: ' + esc(x.state_reason || 'this row cannot be graded as recorded') + '</p>';
    else if (x.pnl_status !== 'VERIFIED' && x.pnl_status !== 'VOID' && x.pnl_status !== 'PENDING') h += '<p class="pnl-note">' + esc(P.rowState(x) === 'RECORD_ONLY' && x.pnl_status === 'NO_ENTRY_PRICE' ? 'Record only — ' + reasonText(x.price_why || x.pnl_exclusion_reason || 'missing_price') + '. The result counts in the record, never in P&L.' : (P.STATUS_TEXT[x.pnl_status] || '')) + '</p>';
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
    /* a change to what is shown re-renders everything from the one dataset */
    function all() { S.page = 0; S.ppage = 0; renderAll(S); }
    host.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button, tr.pnl-click') : null;
      if (!b || !host.contains(b)) { closePop(S); return; }
      if (b.hasAttribute('data-help')) { e.preventDefault(); togglePop(S, b); return; }
      closePop(S);
      if (b.hasAttribute('data-leans-on')) { S.leans = true; S.lstatus = 'pending'; S.lchosen = true; all(); return; }
      if (b.hasAttribute('data-why')) {
        var adv = host.querySelector('[data-r="adv"]');
        if (adv && !adv.open) adv.open = true;
        if (!S.adv) { S.adv = true; renderAdvanced(S); renderPlayersShell(S); renderPlayers(S); }
        var w = host.querySelector('[data-r="why"]');
        if (w && w.scrollIntoView) w.scrollIntoView({ block: 'center' });
        return;
      }
      if (b.hasAttribute('data-scope')) { S.scope = b.getAttribute('data-scope'); S.lstatus = null; S.lchosen = false; all(); }
      else if (b.hasAttribute('data-period')) { S.period = b.getAttribute('data-period'); S.lstatus = null; S.lchosen = false; all(); }
      else if (b.hasAttribute('data-money')) { S.money = b.getAttribute('data-money'); renderAll(S); }
      else if (b.hasAttribute('data-lstatus')) { S.lstatus = b.getAttribute('data-lstatus'); S.lchosen = true; S.page = 0; renderLedger(S); }
      else if (b.hasAttribute('data-pcls')) { S.pcls = b.getAttribute('data-pcls'); S.ppage = 0; renderPlayers(S); }
      else if (b.hasAttribute('data-page')) { S.page += Number(b.getAttribute('data-page')); renderLedger(S); }
      else if (b.hasAttribute('data-ppage')) { S.ppage += Number(b.getAttribute('data-ppage')); renderPlayers(S); }
      else if (b.hasAttribute('data-row')) { var id = b.getAttribute('data-row'); S.open[id] = !S.open[id]; renderLedger(S); if (S.player) renderPlayers(S); }
      else if (b.hasAttribute('data-player')) { var k = b.getAttribute('data-player'); S.player = S.player === k ? null : k; renderPlayers(S); }
    });
    host.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr.pnl-click')) { e.preventDefault(); e.target.click(); }
      if (e.key === 'Escape') closePop(S);
    });
    function onField(e) {
      var el = e.target;
      if (el.hasAttribute('data-pq')) { S.pq = el.value; S.ppage = 0; clearTimeout(t); t = setTimeout(function () { renderPlayers(S); }, 120); return; }
      if (el.hasAttribute('data-lq')) { S.lq = el.value; S.page = 0; clearTimeout(t); t = setTimeout(function () { renderLedger(S); }, 150); return; }
      if (el.hasAttribute('data-mode') && e.type === 'change') { S.mode = el.value === 'flat' ? 'flat' : 'staked'; all(); return; }
      if (el.hasAttribute('data-market') && e.type === 'change') { S.market = MARKETS.some(function (m) { return m[0] === el.value; }) ? el.value : 'all'; S.lstatus = null; S.lchosen = false; all(); return; }
      if (el.hasAttribute('data-leans') && e.type === 'change') { S.leans = !!el.checked; S.lstatus = null; S.lchosen = false; all(); }
    }
    /* Advanced Analytics is built the first time it opens */
    var adv = host.querySelector('[data-r="adv"]');
    adv.addEventListener('toggle', function () {
      S.adv = adv.open;
      if (adv.open && S.sum) { renderAdvanced(S); renderPlayersShell(S); renderPlayers(S); }
      if (typeof S.opts.onAdvanced === 'function') { try { S.opts.onAdvanced(adv.open); } catch (err) { /* the host's */ } }
    });
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
        rt = setTimeout(function () { var c = host.querySelector('[data-chart]'); if (c && S.rows && Math.abs((c.clientWidth || 0) - S.chartW) > 24) { var d = dataset(S); if (d && d.series.length) drawChart(S, d); } }, 150);
      });
    }
  }
  function togglePop(S, btn) {
    var pop = S.host.querySelector('.pnl-pop'), key = btn.getAttribute('data-help');
    if (!pop) return;
    if (!pop.hidden && pop.getAttribute('data-for') === key) { closePop(S); return; }
    pop.textContent = HELP_UI[key] || K().HELP[key] || '';
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
