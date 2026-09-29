/* ===========================================================================
   EDGEDESK PLAYER PROPS — the research terminal (browser, ES5).
   docs/player-props/DESIGN.md §7 · lib/edgedesk_props.js is the kernel.

   sport → game → market → player → every line at every book → best price →
   fair probability → EV → research context → BET / LEAN / WATCH / PASS / NO DECISION

   What this file owns: loading the committed feeds
   (football/props/<league>/board.json, players.json, performance.json), the
   page state, filters, sorting, the virtualised board, phone cards, the
   research drawer, the watchlist and the performance view. What it never
   does: compute a probability, an EV or a decision itself — every number
   comes from EDProps (the same function the build ran), re-run here so a
   price that has gone stale since the build is judged stale NOW.

   Mount: EDPropsUI.show(hostElement). Deep link: #playerprops[/<league>[/<prop id>]].
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPropsUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 'edgedesk_props_ui_v1';
  var ROW_H = 50, OVERSCAN = 12, PAGE = 40;
  var LS_WATCH = 'edgedesk_props_watch_v1', LS_VIEW = 'edgedesk_props_view_v1';
  var LEAGUES = [{ key: 'nfl', label: 'NFL' }, { key: 'cfb', label: 'CFB' }];
  var EV_STEPS = [[null, 'Any'], [0, '> 0'], [0.02, '> 2%'], [0.05, '> 5%'], [0.08, '> 8%']];
  var CONF_STEPS = [[null, 'Any'], [60, '60+'], [70, '70+'], [80, '80+'], [90, '90+']];
  var SAMPLE_STEPS = [[null, 'Any'], [3, '3+ g'], [5, '5+ g'], [8, '8+ g']];
  var EDGE_STEPS = [[null, 'Any'], [2, '2+ pp'], [4, '4+ pp'], [6, '6+ pp']];
  var PRICE_STEPS = [[null, 'Any price'], ['plus', 'Plus money'], [-120, '−120 or better'], [-150, '−150 or better']];
  var SORTS = [['value', 'Best value (research quality)'], ['ev', 'Best EV'], ['conf', 'Highest confidence'], ['diff', 'Largest projection difference'],
    ['price', 'Best price'], ['prob', 'Highest fair probability'], ['kick', 'Kickoff time'], ['player', 'Player'], ['game', 'Game']];

  function P() { return root.EDProps; }
  function $(id) { return document.getElementById(id); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ms(t) { if (t == null) return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function lsGet(k, d) { try { var v = root.localStorage && root.localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { if (root.localStorage) root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function now() { return S.clock ? S.clock() : Date.now(); }
  /* NFL codes read as teams; college codes are slugs, so college shows the school's name */
  function tl(code) { var b = S.boards && S.boards[S.league]; return (b && b.league !== 'nfl' && b.team_names && b.team_names[code]) || code || ''; }

  /* ================================================================ STATE */
  var S = {
    host: null, mounted: false, league: 'nfl', boards: {}, players: {}, perf: {}, status: {}, errors: {}, evals: {}, rows: {},
    mode: 'value', game: null, player: null, cat: 'all', market: null, gtab: 'all', gsearch: '', search: '',
    date: 'week', dateCustom: '', team: '', pos: '', book: '', side: 'all', sort: 'value',
    minEv: null, minConf: null, minSample: null, minEdge: null, price: null,
    drawer: null, cardsShown: PAGE, expanded: {}, watch: { player: {}, prop: {}, game: {} }, watchRemote: null,
    reprice: {}, exposure: {}, scrollTop: 0, clock: null, fetch: null
  };
  function restoreView() {
    var v = lsGet(LS_VIEW, null);
    if (!v) return;
    ['league', 'mode', 'sort', 'date', 'side', 'minEv', 'minConf', 'minSample', 'minEdge', 'price'].forEach(function (k) { if (v[k] !== undefined) S[k] = v[k]; });
    if (S.league !== 'nfl' && S.league !== 'cfb') S.league = 'nfl';
  }
  function saveView() { lsSet(LS_VIEW, { league: S.league, mode: S.mode, sort: S.sort, date: S.date, side: S.side, minEv: S.minEv, minConf: S.minConf, minSample: S.minSample, minEdge: S.minEdge, price: S.price }); }

  /* ================================================================ DATA */
  function fetchJson(url) {
    var f = S.fetch || root.fetch;
    return f(url, { cache: 'no-cache' }).then(function (r) {
      if (r.status === 404) { var e = new Error('not published'); e.status = 404; throw e; }
      if (!r.ok) { var e2 = new Error('HTTP ' + r.status); e2.status = r.status; throw e2; }
      return r.json();
    });
  }
  /* relative to app.html; a page elsewhere (research/cfb/) sets S.base = '/football/props/' */
  function base(lg) { return (S.base || 'football/props/') + lg + '/'; }
  /* one fetch of a league's board, shared by the page and the game-card
     sections (a card that loaded it first saves the page the second read) */
  var BOARD_P = {}, BOARD_DONE = {};
  function fetchBoard(lg, force) {
    if (force || !BOARD_P[lg]) {
      var p = BOARD_P[lg] = fetchJson(base(lg) + 'board.json').then(function (b) {
        if (!b || b.schema !== 'edgedesk_player_props_board_v1') throw new Error('unexpected board schema');
        prepBoard(b); BOARD_DONE[lg] = b; return b;
      });
      p.catch(function () { if (BOARD_P[lg] === p) BOARD_P[lg] = null; });
    }
    return BOARD_P[lg];
  }
  function load(lg, force) {
    if (!force && S.boards[lg] && S.status[lg] === 'ok') return Promise.resolve(S.boards[lg]);
    S.status[lg] = 'loading'; S.errors[lg] = null;
    render();
    return fetchBoard(lg, force).then(function (b) {
      S.boards[lg] = b; S.status[lg] = 'ok'; S.evals[lg] = {}; S.rows[lg] = null;
      render();
      repriceAll(lg);
      /* the drawer's history and the performance view load behind the board */
      loadPlayers(lg); loadPerf(lg);
      return b;
    }).catch(function (e) {
      S.status[lg] = 'error'; S.errors[lg] = e && e.status === 404 ? 'not_published' : (e && e.message) || 'failed';
      render();
    });
  }
  function loadPlayers(lg) {
    if (S.players[lg] || S.players[lg + '_loading']) return;
    S.players[lg + '_loading'] = true;
    var after = function () { if (S.drawer) renderDrawerOnly(); else if (S.player && lg === S.league) render(); };
    fetchJson(base(lg) + 'players.json').then(function (j) { S.players[lg] = j; after(); })
      .catch(function () { S.players[lg] = { error: true, players: {} }; after(); });
  }
  function loadPerf(lg) {
    if (S.perf[lg]) return;
    fetchJson(base(lg) + 'performance.json').then(function (j) { S.perf[lg] = j; if (S.mode === 'perf') render(); })
      .catch(function (e) { S.perf[lg] = { error: e && e.status === 404 ? 'not_published' : 'failed' }; if (S.mode === 'perf') render(); });
  }
  function prepBoard(b) {
    var E = P();
    b._games = {}; (b.games || []).forEach(function (g) { b._games[g.game_id] = g; });
    Object.keys(b.shapes || {}).forEach(function (k) { E.registerShape(k, b.shapes[k]); });
    (b.props || []).forEach(function (r) { r.key = r.id || (b.league + '|' + r.g + '|' + r.p + '|' + r.m); });
  }

  /* the evaluate() input for one board row — the same object the build
     priced — and its evaluation in the board's context: EDProps.boardInput /
     boardEval, the one mapping the page and the AI desk share */
  function inputOf(b, r) { return P().boardInput(b, r, now()); }
  function ctxOf(b, r) { return P().boardCtx(b, r); }
  function fullEval(b, r) { return P().boardEval(b, r, now()); }
  /* re-price every row in chunks so the page stays responsive; the build's
     compact evaluation paints first */
  function repriceAll(lg) {
    var b = S.boards[lg]; if (!b) return;
    var list = b.props, i = 0, token = {}, E = P();
    S.reprice[lg] = token;
    function step() {
      if (S.reprice[lg] !== token) return;
      var t0 = Date.now();
      while (i < list.length && Date.now() - t0 < 14) {
        var r = list[i++];
        try { S.evals[lg][r.key] = E.compact(fullEval(b, r)); } catch (e) { /* keep the build's row */ }
      }
      if (i < list.length) { (root.setTimeout || setTimeout)(step, 0); }
      else {
        /* the exposure caps across the board's BETs, as the build applies them */
        var adj = {}; try { adj = E.boardExposure(b, S.evals[lg]) || {}; } catch (e) { adj = {}; }
        S.exposure[lg] = adj;
        Object.keys(adj).forEach(function (k) { if (S.evals[lg][k]) S.evals[lg][k] = E.exposeCompact(S.evals[lg][k], adj[k]); });
        S.reprice[lg] = 'done'; S.rows[lg] = null; S.repricedAt = now(); render();
      }
    }
    step();
  }

  /* ================================================================ ROWS
     One row model, from the build's compact evaluation or the page's own. */
  function rowsOf(lg) {
    if (S.rows[lg]) return S.rows[lg];
    var b = S.boards[lg]; if (!b) return [];
    var out = (b.props || []).map(function (r) { return rowOf(b, r, (S.evals[lg] || {})[r.key] || r.e); });
    S.rows[lg] = out;
    return out;
  }
  function rowOf(b, r, e) {
    var E = P(), g = b._games[r.g] || {}, pl = ctxOf(b, r), md = E.MARKETS[r.m] || { label: r.m, short: r.m, cat: 'other' };
    var c = e.cand, cons = e.cons, ac = e.ac, inf = e.inf, raw = e.raw;
    var cand = c ? { side: c[0], line: c[1], american: c[2], book: c[3], p: c[4], push: c[5], ev: c[6], evRaw: c[7], edge: c[8], fair: c[9], alt: !!c[10], at: c[11] } : null;
    var line = cons ? cons[0] : null;
    var capAt = cand && cand.at ? ms(cand.at) : null;
    if (capAt == null && r.q && r.q.length) capAt = Math.max.apply(null, r.q.map(function (a) { return ms(b.times[a[5]]) || 0; }));
    var age = capAt ? (now() - capAt) / 60000 : null;
    /* best raw price per side at the consensus line — or, once every quote is
       past the decision limit, at the last line seen (shown, never priced) */
    var lastSeen = e.ls || null, refLine = line != null ? line : (lastSeen ? lastSeen[0] : null);
    var bestO = null, bestU = null, nearO = null, nearU = null, books = {};
    (r.q || []).forEach(function (a) {
      if (!a[6]) books[a[0]] = 1;
      /* no book deals the consensus number (it is the snapped median): each
         side's main quote nearest to it, carrying its own line — the card's
         reference price, never the table's column at the consensus line */
      if (refLine != null && !a[6]) {
        var nq = { american: a[3], book: a[0], line: a[1] }, cur = a[2] === 'o' ? nearO : nearU, dd = Math.abs(a[1] - refLine);
        if (!cur || dd < Math.abs(cur.line - refLine) || (dd === Math.abs(cur.line - refLine) && a[1] === cur.line && E.priceBetter(a[3], cur.american))) { if (a[2] === 'o') nearO = nq; else nearU = nq; }
      }
      if (refLine == null || a[1] !== refLine) return;
      var q = { american: a[3], book: a[0], line: a[1] };
      if (a[2] === 'o') { if (!bestO || E.priceBetter(q.american, bestO.american)) bestO = q; } else if (!bestU || E.priceBetter(q.american, bestU.american)) bestU = q;
    });
    var pNoPush = cand ? cand.p / Math.max(1e-9, 1 - (cand.push || 0)) : null;
    var nv = cons && isNum(cons[3]) && cand ? (cand.side === 'over' ? cons[3] : 1 - cons[3]) : null;
    var modelCons = ac ? (cand ? (cand.side === 'over' ? ac[0] : ac[1]) : ac[0]) / Math.max(1e-9, ac[0] + ac[1]) : null;
    var decision = e.d, stale = age != null && age > 90;
    return {
      key: r.key, r: r, g: g, pl: pl, name: pl ? pl.name : (r.name || '—'), pos: pl ? pl.pos : '', team: pl ? pl.team : '', opp: pl ? pl.opp : '',
      market: r.m, md: md, cat: md.cat, decision: decision, tone: toneOf(decision), code: e.c, units: e.u || 0, conf: e.cf, value: e.v || 0,
      cand: cand, bv: e.bv ? { side: e.bv[0], line: e.bv[1], american: e.bv[2], book: e.bv[3], ev: e.bv[4] } : null,
      line: line, over: cons ? cons[1] : null, under: cons ? cons[2] : null, novigOver: cons ? cons[3] : null, nBooks: cons ? cons[4] : 0, nTwo: cons ? cons[5] : 0, interp: cons ? !!cons[6] : false,
      lastSeen: lastSeen, refLine: refLine, bestO: bestO, bestU: bestU, lastO: bestO || nearO, lastU: bestU || nearU, nQBooks: Object.keys(books).length,
      /* the build's own ranking, made while its prices were fresh: the order a
         board of stale rows keeps (for reference — it decides nothing) */
      capValue: e.c === 'STALE_QUOTE' && r.e && isNum(r.e.v) ? r.e.v : 0,
      pOver: ac ? ac[0] / Math.max(1e-9, ac[0] + ac[1]) : null,
      proj: inf ? inf[0] : null, projRaw: raw ? raw[0] : null, median: inf ? inf[1] : null, p25: inf ? inf[2] : null, p75: inf ? inf[3] : null, mktMean: e.mm,
      fairOver: ac ? ac[3] : null, fairUnder: ac ? ac[4] : null, pModel: pNoPush, pNv: nv, pModelCons: modelCons,
      edgeNv: nv != null && modelCons != null ? 100 * (modelCons - nv) : null, dp: e.dp,
      caps: e.caps || [], warns: e.w || [], blockers: e.b || [], priced: !!(r.q && r.q.length), capAt: capAt, age: age, stale: stale,
      sample: r.x ? r.x.sg : null, kick: ms(g.kickoff), flags: r.fl || []
    };
  }
  function toneOf(d) { return { BET: 'bet', LEAN: 'lean', WATCH: 'watch', WAIT: 'watch', PASS: 'pass' }[d] || 'none'; }
  function decLabel(d, code) {
    var V = root.EDVocab;
    if (d === 'NO_DECISION') return code === 'NO_MARKET' ? 'NO MARKET' : code === 'STALE_QUOTE' ? 'STALE PRICE' : 'NO DECISION';
    var v = V && V.DECISION && V.DECISION[d]; return v ? v.label : d;
  }

  /* ================================================================ FILTERS */
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function inDate(row) {
    if (!row.kick) return true;
    var n = now(), today = dayKey(n), tmr = dayKey(n + 86400000), k = dayKey(row.kick);
    if (S.date === 'today') return k === today;
    if (S.date === 'tomorrow') return k === tmr;
    if (S.date === 'custom' && S.dateCustom) return k === S.dateCustom;
    return true;
  }
  function tokensMatch(row, q) {
    if (!q) return true;
    var b = S.boards[S.league] || {}, names = b.team_names || {};
    var hay = [row.name, row.team, row.opp, names[row.team], names[row.opp], row.md.label, row.md.short, row.pos, row.market.replace(/_/g, ' '), (row.g.home_name || ''), (row.g.away_name || '')].join(' ').toLowerCase();
    /* every word must appear: "rush" finds rushing, "rec" receiving and
       receptions, "td" touchdowns — no stemming that would widen a search */
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(function (t) { return hay.indexOf(t) >= 0 || (t === 'tds' && hay.indexOf('td') >= 0); });
  }
  function passes(row) {
    if (S.mode === 'value' && !row.priced) return false;
    if (S.mode === 'mine' && !isWatched(row)) return false;
    if (S.game && row.g.game_id !== S.game) return false;
    if (S.player && row.r.p !== S.player) return false;
    if (S.cat !== 'all' && row.cat !== S.cat) return false;
    if (S.market && row.market !== S.market) return false;
    if (!inDate(row)) return false;
    if (S.team && row.team !== S.team && row.opp !== S.team) return false;
    if (S.pos && row.pos !== S.pos) return false;
    if (S.book && !(row.r.q || []).some(function (a) { return a[0] === S.book; })) return false;
    if (!tokensMatch(row, S.search)) return false;
    var c = row.cand;
    if (S.side !== 'all' && (!c || c.side !== S.side)) return false;
    if (S.minEv != null && (!c || !(c.ev > S.minEv))) return false;
    if (S.minConf != null && !(row.conf >= S.minConf)) return false;
    if (S.minSample != null && !(row.sample >= S.minSample)) return false;
    if (S.minEdge != null && (!c || !(c.edge >= S.minEdge))) return false;
    if (S.price != null) {
      if (!c) return false;
      if (S.price === 'plus' && !(c.american > 0)) return false;
      if (isNum(S.price) && !P().priceBetter(c.american, S.price) && c.american !== S.price) return false;
    }
    return true;
  }
  var RANK = { BET: 4, LEAN: 3, WATCH: 2, PASS: 1, NO_DECISION: 0 };
  var POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DL', 'LB', 'DB'];
  function posRank(r) { var i = POS_ORDER.indexOf(r.pos); return i < 0 ? 99 : i; }
  function sorter(key) {
    var num = function (x, d) { return isNum(x) ? x : d; };
    var byKick = function (a, b) { return num(a.kick, 9e15) - num(b.kick, 9e15); };
    /* nothing priced: kickoff, then the role order a reader scans a game in, then confidence */
    var byRole = function (a, b) { return byKick(a, b) || posRank(a) - posRank(b) || num(b.conf, -1) - num(a.conf, -1) || a.name.localeCompare(b.name); };
    var base;
    switch (key) {
      case 'ev': base = function (a, b) { return num(b.cand && b.cand.ev, -9) - num(a.cand && a.cand.ev, -9) || byRole(a, b); }; break;
      case 'conf': base = function (a, b) { return num(b.conf, -1) - num(a.conf, -1) || num(b.cand && b.cand.ev, -9) - num(a.cand && a.cand.ev, -9) || byRole(a, b); }; break;
      case 'diff': base = function (a, b) { return diffOf(b) - diffOf(a) || byRole(a, b); }; break;
      case 'price': base = function (a, b) { return num(b.cand && P().toDecimal(b.cand.american), 0) - num(a.cand && P().toDecimal(a.cand.american), 0) || byRole(a, b); }; break;
      case 'prob': base = function (a, b) { return num(b.pModel, -1) - num(a.pModel, -1) || byRole(a, b); }; break;
      case 'kick': base = byRole; break;
      case 'player': base = function (a, b) { return a.name.localeCompare(b.name) || a.md.label.localeCompare(b.md.label); }; break;
      case 'game': base = function (a, b) { return byKick(a, b) || (a.g.game_id || '').localeCompare(b.g.game_id || '') || posRank(a) - posRank(b) || a.name.localeCompare(b.name); }; break;
      default: base = function (a, b) { return (RANK[b.decision] || 0) - (RANK[a.decision] || 0) || num(b.value, 0) - num(a.value, 0) || num(b.cand && b.cand.ev, -9) - num(a.cand && a.cand.ev, -9) || num(b.capValue, 0) - num(a.capValue, 0) || byRole(a, b); };
    }
    /* a game that kicked off since the board was built is closed: its rows go last under every sort */
    var t = now();
    var live = function (r) { return isNum(r.kick) && r.kick <= t ? 1 : 0; };
    return function (a, b) { return live(a) - live(b) || base(a, b); };
  }
  function diffOf(r) { var ref = isNum(r.line) ? r.line : r.median; return isNum(r.proj) && isNum(ref) && ref !== 0 ? Math.abs(r.proj - ref) / Math.max(1, Math.abs(ref)) : -1; }
  function visible() {
    var rows = rowsOf(S.league).filter(passes);
    rows.sort(sorter(S.mode === 'value' && S.sort === 'value' ? 'value' : S.sort));
    return rows;
  }

  /* ================================================================ WATCHLIST
     A reader's stars: on their account when signed in (public.player_prop_watchlist,
     supabase/player_props_watchlist.sql), on this device otherwise. */
  function watchKey(kind, row) { return kind === 'game' ? row.g.game_id : kind === 'player' ? row.r.p : row.key; }
  function isWatched(row) { var w = S.watch; return !!(w.prop[row.key] || (row.r.p && w.player[row.r.p]) || w.game[row.g.game_id]); }
  function signedIn() { try { return !!(root.edUser && root.edUser() && root.edUser().id); } catch (e) { return false; } }
  function sb(path, opts) {
    opts = opts || {};
    var url = root.SB_URL, key = root.SB_KEY; if (!url || !key) return Promise.reject(new Error('no database'));
    var tok = null; try { tok = root.edToken ? root.edToken() : null; } catch (e) { tok = null; }
    return Promise.resolve(tok).then(function (t) {
      var h = { apikey: key, Authorization: 'Bearer ' + (t || key), 'Content-Type': 'application/json' };
      if (opts.prefer) h.Prefer = opts.prefer;
      return (S.fetch || root.fetch)(url + '/rest/v1/' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
    }).then(function (r) { if (!r.ok) { var e = new Error('db ' + r.status); e.status = r.status; throw e; } return r.status === 204 ? null : r.json().catch(function () { return null; }); });
  }
  function loadWatch() {
    var local = lsGet(LS_WATCH, null);
    if (local && local.player) S.watch = { player: local.player || {}, prop: local.prop || {}, game: local.game || {} };
    if (!signedIn()) return;
    sb('player_prop_watchlist?select=kind,item_key,league&limit=500').then(function (rows) {
      S.watchRemote = true;
      (rows || []).forEach(function (x) { if (S.watch[x.kind]) S.watch[x.kind][x.item_key] = { league: x.league, at: null }; });
      lsSet(LS_WATCH, S.watch); render();
    }).catch(function () { S.watchRemote = false; });
  }
  function toggleWatch(kind, key, league, label) {
    var w = S.watch[kind]; if (!w) return;
    var on = !w[key];
    if (on) w[key] = { league: league, at: new Date().toISOString(), label: label || null }; else delete w[key];
    lsSet(LS_WATCH, S.watch);
    if (signedIn() && S.watchRemote !== false) {
      var p = on ? sb('player_prop_watchlist?on_conflict=user_id,kind,item_key', { method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates', body: [{ kind: kind, item_key: key, league: league, label: label || null }] })
        : sb('player_prop_watchlist?kind=eq.' + encodeURIComponent(kind) + '&item_key=eq.' + encodeURIComponent(key), { method: 'DELETE', prefer: 'return=minimal' });
      p.catch(function () { S.watchRemote = false; });
    }
    render();
  }

  /* ================================================================ FORMAT */
  var E_ = function () { return P(); };
  function price(a) { return E_().priceText(a); }
  function pct(x, dp) { return isNum(x) ? (100 * x).toFixed(dp == null ? 1 : dp) + '%' : '—'; }
  function spct(x, dp) { return E_().pctText(x, dp); }
  function pp(x, dp) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp == null ? 1 : dp) : '—'; }
  function n1(x) { return isNum(x) ? (Math.abs(x) >= 20 ? x.toFixed(1) : x.toFixed(2).replace(/0$/, '')) : '—'; }
  function book(k) { return E_().bookName(k); }
  function abbr(k) { return E_().bookAbbr(k); }
  function evTone(ev) { return !isNum(ev) ? 't-neu' : ev >= 0.05 ? 't-pos' : ev >= 0.02 ? 't-mod' : ev > -0.01 ? 't-neu' : 't-neg'; }
  function confCls(c) { return !isNum(c) ? '' : c >= 80 ? 'hi' : c >= 60 ? 'md' : c >= 40 ? 'lo' : 'vl'; }
  function ago(t) { var m = (now() - ms(t)) / 60000; if (!isFinite(m)) return '—'; if (m < 1) return 'just now'; if (m < 60) return Math.round(m) + ' min ago'; if (m < 60 * 24) return (m / 60).toFixed(m < 600 ? 1 : 0) + ' h ago'; return Math.round(m / 1440) + ' d ago'; }
  function clock(t) { var d = new Date(ms(t)); if (!isFinite(d.getTime())) return '—'; try { return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); } }
  function clockShort(t) { var d = new Date(ms(t)); if (!isFinite(d.getTime())) return '—'; try { return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (e) { return d.toISOString().slice(11, 16) + 'Z'; } }
  function sel(row) { var c = row.cand; if (!c) return null; return E_().selectionText(row.market, c.side, c.line); }
  function units(row) { return row.units > 0 ? E_().unitsText(row.units) : ''; }
  function bankroll() { var U = root.EDDecisionUI, B = root.EDBankroll; var s = null; try { s = U && U.settings ? U.settings() : (B ? B.load() : null); } catch (e) { s = null; } var uv = null; try { uv = B && s ? B.unitValue(B.normalize ? B.normalize(s) : s) : null; } catch (e) { uv = null; } return { settings: s, unit: uv && isNum(uv.unit) ? uv.unit : null }; }
  function money(x) { return isNum(x) ? '$' + (Math.abs(x) >= 100 ? Math.round(x).toLocaleString() : x.toFixed(2)) : '—'; }

  /* ================================================================ RENDER */
  function render() {
    if (!S.host) return;
    var b = S.boards[S.league], st = S.status[S.league];
    var h = '<div class="pp">' + headHTML(b) + stripHTML(b, st) + modesHTML(b) ;
    if (S.mode === 'perf') { h += perfHTML(b) + '</div>'; S.host.innerHTML = h; return; }
    if (S.filtersOpen == null) S.filtersOpen = !(root.innerWidth && root.innerWidth < 760);
    h += '<details class="pp-fbox"' + (S.filtersOpen ? ' open' : '') + '><summary class="pp-btn ghost" data-pp-act="filters">Search &amp; filters' + activeCount() + '</summary>' + toolsHTML(b) + filtersHTML() + '</details>' +
      '<div class="pp-body' + (S.drawer ? ' drawer-on' : '') + '">' + sideHTML(b, st) +
      '<div class="pp-main pp-pane">' + playerHTML(b) + catsHTML(b) + boardHTML(b, st) + '</div>' +
      (S.drawer ? '<aside class="pp-drawer pp-pane" id="ppDrawer" role="dialog" aria-label="Prop research">' + drawerHTML() + '</aside>' : '') + '</div></div>';
    var keep = document.getElementById('ppScroll'), top = keep ? keep.scrollTop : S.scrollTop;
    S.host.innerHTML = h;
    var sc = $('ppScroll'); if (sc) { sc.scrollTop = top; paintRows(); sc.onscroll = function () { S.scrollTop = sc.scrollTop; paintRows(); }; }
    drawDist();
  }
  function renderDrawerOnly() { var d = $('ppDrawer'); if (d) { d.innerHTML = drawerHTML(); drawDist(); } else render(); }

  function headHTML(b) {
    var upd = b ? b.generated_at : null;
    return '<div class="pp-head"><h2 class="pp-title">PLAYER PROPS<small>Compare prices, projections, probability and EV across player markets. Research, not picks.</small></h2><span class="pp-grow"></span>' +
      '<div class="pp-seg" role="tablist" aria-label="Sport">' + LEAGUES.map(function (l) { return '<button role="tab" aria-selected="' + (S.league === l.key) + '" class="' + (S.league === l.key ? 'on' : '') + '" data-pp-act="league" data-v="' + l.key + '">' + l.label + '</button>'; }).join('') + '</div>' +
      '<span class="pp-upd" title="' + esc(upd || '') + '"><span class="pp-updl">Last updated </span><b>' + (upd ? esc(clockShort(upd)) + ' · ' + esc(ago(upd)) : '—') + '</b>' + (S.reprice[S.league] && S.reprice[S.league] !== 'done' ? ' · re-pricing…' : '') + '</span>' +
      '<button class="pp-btn ghost" data-pp-act="refresh" aria-label="Refresh player props">&#8635; Refresh</button></div>';
  }
  /* the capture's own status (football/props/capture.js STATUSES), never a
     guess from zero priced rows: NOT_RUN, RUNNING, SUCCESS, PARTIAL,
     NO_MARKETS, ERROR. A board from before the status model carries no status
     and a last_run: it reads as a capture that priced, as it always did. */
  function captureView(b) {
    var cap = (b && b.capture) || {};
    var st = cap.status || (cap.last_run ? 'SUCCESS' : 'NOT_RUN');
    var at = cap.status ? cap.last_success_at : cap.last_run;
    var priced = (st === 'SUCCESS' || st === 'PARTIAL') && !!at;
    return { cap: cap, st: st, at: at, priced: priced, age: at ? (now() - ms(at)) / 60000 : null,
      checked: cap.completed_at || cap.last_attempt || null,
      books: cap.books_returned ? cap.books_returned.length : cap.bookmakers ? cap.bookmakers.length : 0 };
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function stripHTML(b, st) {
    if (!b) return '';
    var v = captureView(b), cap = v.cap;
    var stale = v.priced && v.age > 90;
    var dot = v.priced ? (stale ? 'stale' : 'live') : (v.st === 'NO_MARKETS' || v.st === 'RUNNING' ? 'stale' : 'off');
    var checked = v.checked ? ' · checked <b>' + esc(ago(v.checked)) + '</b>' : '';
    var capTxt = v.priced ? 'Sportsbook prices: ' + (stale ? '<span class="pp-stale">STALE</span>' : '<b>LIVE</b>') + ' · captured <b>' + esc(ago(v.at)) + '</b>' + (v.books ? ' · ' + v.books + ' books' : '') + (v.st === 'PARTIAL' ? ' <span class="pp-stale">PARTIAL</span>' : '')
      : v.st === 'NO_MARKETS' ? 'Sportsbook prices: <b>' + (cap.reason === 'NO_EVENTS_IN_WINDOW' ? 'no game inside the capture window' : 'markets not released yet') + '</b>' + checked
      : v.st === 'ERROR' ? 'Sportsbook prices: <b>capture error</b>' + checked + (v.at ? ' · last priced ' + esc(ago(v.at)) : '')
      : v.st === 'RUNNING' ? 'Sportsbook prices: <b>capture did not finish</b>' + (cap.started_at ? ' · started ' + esc(ago(cap.started_at)) : '')
      : cap.reason === 'PROPS_CAPTURE_DISABLED' ? 'Sportsbook prices: <b>capture off</b>' + (v.at ? ' · last priced ' + esc(ago(v.at)) : '')
      : 'Sportsbook prices: <b>not captured yet</b>';
    var pr = b.probability || {};
    var inj = b.sources && b.sources.injuries;
    var h = '<div class="pp-strip"><span><span class="pp-dot ' + dot + '"></span>' + capTxt + '</span>' +
      '<span>Probability source <b>' + esc(pr.label || '—') + '</b></span>' +
      '<span class="pp-sx">Market weight <b>' + Math.round(100 * (b.market_weight || 0)) + '%</b> <span class="pp-note">(raw model shown beside it)</span></span>' +
      (inj ? '<span>Injury report <b>' + (inj.published === false ? (b.league === 'cfb' ? 'no official college report' : 'not on file') : 'week ' + esc(inj.latest_week || '—') + ' · ' + esc(ago(inj.retrieved_at))) + '</b></span>' : '') +
      '<span class="pp-note pp-sx">' + (b.counts ? b.counts.games + ' games · ' + b.counts.props + ' props · ' + b.counts.priced + ' priced' : '') + '</span></div>';
    var open = root.innerWidth && root.innerWidth < 760 ? '' : ' open';
    var noAssume = ' No price is assumed: a prop gets an EV and a decision only from a real, fresh quote.';
    var lead = v.st === 'NO_MARKETS' ? (cap.reason === 'NO_EVENTS_IN_WINDOW' ? 'No game is inside the price-capture window yet.' : 'Sportsbooks have not released these player markets yet.')
      : v.st === 'ERROR' ? 'The sportsbook price capture failed.'
      : v.st === 'RUNNING' ? 'A sportsbook price capture started and did not finish.'
      : 'Waiting for sportsbook prices.';
    if (!v.priced) h += '<details class="pp-warnbox"' + open + '><summary><b>' + lead + '</b> EdgeDesk projections and fair lines only — no prices, no EV yet.</summary>' +
      esc(cap.why || 'The prop capture has not run.') + (v.st === 'ERROR' && cap.error_message ? ' Error: ' + esc(clip(cap.error_message, 400)) : '') +
      (v.checked && v.st !== 'NOT_RUN' ? ' Last checked ' + esc(ago(v.checked)) + '.' : '') + noAssume + '</details>';
    else if (stale) h += '<details class="pp-warnbox"' + open + '><summary><b>Stale prices.</b> The last capture was ' + esc(ago(v.at)) + ': nothing is decided until the next one.</summary>Quotes older than 90 minutes are shown for reference only and never decide anything.' +
      (v.st === 'ERROR' || cap.error_message ? ' The latest capture reported: ' + esc(clip(cap.error_message || cap.why, 300)) : '') + '</details>';
    else if (v.st === 'PARTIAL') h += '<details class="pp-warnbox"><summary><b>Partial capture.</b> Some prices are missing from the latest run.</summary>' + esc(cap.why || '') + (cap.error_message ? ' ' + esc(clip(cap.error_message, 400)) : '') + '</details>';
    return h;
  }
  function modesHTML(b) {
    var rows = b ? rowsOf(S.league) : [];
    var priced = rows.filter(function (r) { return r.priced; }).length, mine = rows.filter(isWatched).length;
    var M = [['value', 'Best Value', priced], ['all', 'All Props', rows.length], ['mine', 'My Props', mine], ['perf', 'Performance', null]];
    return '<div class="pp-modes" role="tablist" aria-label="Views">' + M.map(function (m) { return '<button role="tab" aria-selected="' + (S.mode === m[0]) + '" class="pp-mode' + (S.mode === m[0] ? ' on' : '') + '" data-pp-act="mode" data-v="' + m[0] + '">' + m[1] + (m[2] != null ? '<span class="n">' + m[2] + '</span>' : '') + '</button>'; }).join('') + '</div>';
  }
  function toolsHTML(b) {
    var rows = b ? rowsOf(S.league) : [];
    var teams = {}, books = {}, pos = {};
    rows.forEach(function (r) { if (r.team) teams[r.team] = 1; if (r.opp) teams[r.opp] = 1; if (r.pos) pos[r.pos] = 1; (r.r.q || []).forEach(function (a) { books[a[0]] = 1; }); });
    var names = (b && b.team_names) || {};
    var opt = function (v, l, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>'; };
    return '<div class="pp-tools">' +
      '<input type="search" id="ppSearch" placeholder="Search player, team, opponent or market — e.g. “rushing yards”, “WR receptions”" value="' + esc(S.search) + '" aria-label="Search props">' +
      '<select data-pp-set="date" aria-label="Date">' + opt('week', 'This week', S.date) + opt('today', 'Today', S.date) + opt('tomorrow', 'Tomorrow', S.date) + opt('custom', 'Pick a date…', S.date) + '</select>' +
      (S.date === 'custom' ? '<input type="date" data-pp-set="dateCustom" value="' + esc(S.dateCustom) + '" aria-label="Custom date">' : '') +
      '<select data-pp-set="team" aria-label="Team">' + opt('', 'All teams', S.team) + Object.keys(teams).sort().map(function (t) { return opt(t, names[t] || t, S.team); }).join('') + '</select>' +
      '<select data-pp-set="pos" aria-label="Position">' + opt('', 'All positions', S.pos) + ['QB', 'RB', 'WR', 'TE', 'K', 'LB', 'DB', 'DL'].filter(function (p) { return pos[p]; }).map(function (p) { return opt(p, p, S.pos); }).join('') + '</select>' +
      '<select data-pp-set="book" aria-label="Sportsbook">' + opt('', 'All sportsbooks', S.book) + Object.keys(books).sort().map(function (k) { return opt(k, book(k), S.book); }).join('') + '</select>' +
      '<select data-pp-set="sort" aria-label="Sort">' + SORTS.map(function (s) { return opt(s[0], 'Sort: ' + s[1], S.sort); }).join('') + '</select>' +
      '</div>';
  }
  function activeCount() {
    var n = [S.minEv, S.minConf, S.minSample, S.minEdge, S.price].filter(function (x) { return x != null; }).length + (S.side !== 'all' ? 1 : 0) + (S.team ? 1 : 0) + (S.pos ? 1 : 0) + (S.book ? 1 : 0) + (S.search ? 1 : 0) + (S.date !== 'week' ? 1 : 0);
    return n ? ' <span class="pp-tag">' + n + ' active</span>' : '';
  }
  function chips(label, key, steps) {
    return '<span class="pp-fg"><span>' + label + '</span>' + steps.map(function (s) { var on = S[key] === s[0]; return '<button class="pp-chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-pp-act="flt" data-k="' + key + '" data-v="' + (s[0] === null ? '' : s[0]) + '">' + s[1] + '</button>'; }).join('') + '</span>';
  }
  function filtersHTML() {
    return '<div class="pp-flt">' + chips('EV', 'minEv', EV_STEPS) + chips('Confidence', 'minConf', CONF_STEPS) + chips('Edge', 'minEdge', EDGE_STEPS) +
      chips('Sample', 'minSample', SAMPLE_STEPS) + chips('Price', 'price', PRICE_STEPS) +
      '<span class="pp-fg"><span>Side</span>' + [['all', 'Both'], ['over', 'Over only'], ['under', 'Under only']].map(function (s) { return '<button class="pp-chip' + (S.side === s[0] ? ' on' : '') + '" data-pp-act="side" data-v="' + s[0] + '">' + s[1] + '</button>'; }).join('') + '</span>' +
      '<button class="pp-btn ghost" data-pp-act="reset">Reset filters</button></div>';
  }

  /* ---- the game sidebar */
  function sideHTML(b, st) {
    if (S.sideCollapsed == null) S.sideCollapsed = !!(root.innerWidth && root.innerWidth < 1100);
    var selG = S.game && b && b._games[S.game];
    var h = '<nav class="pp-side pp-pane' + (S.sideCollapsed ? ' collapsed' : '') + '" aria-label="Games"><div class="pp-sh">' + (S.sideCollapsed ? '' : '<input type="search" id="ppGSearch" placeholder="Search players or teams…" value="' + esc(S.gsearch) + '" aria-label="Search players or teams">') +
      '<div class="pp-st">' + (S.sideCollapsed ? '' : [['all', 'All Games'], ['featured', 'Featured'], ['fav', 'Favorites'], ['soon', 'Starting Soon']].map(function (t) { return '<button class="pp-chip' + (S.gtab === t[0] ? ' on' : '') + '" data-pp-act="gtab" data-v="' + t[0] + '">' + t[1] + '</button>'; }).join('')) +
      '<button class="pp-chip" data-pp-act="collapse" aria-expanded="' + !S.sideCollapsed + '">' + (S.sideCollapsed ? 'Show games' + (b ? ' (' + (b.games || []).length + ')' : '') : 'Hide games') + '</button>' +
      (selG && S.sideCollapsed ? '<button class="pp-chip on" data-pp-act="game" data-v="">' + esc(tl(selG.away)) + ' @ ' + esc(tl(selG.home)) + ' ×</button>' : '') + '</div></div><div class="pp-glist">';
    if (!b) return h + (st === 'loading' ? '<div class="pp-skel"></div><div class="pp-skel"></div><div class="pp-skel"></div>' : '') + '</div></nav>';
    var rows = rowsOf(S.league), n = now();
    var gs = (b.games || []).slice();
    var q = S.gsearch.toLowerCase();
    var byGame = {}; rows.forEach(function (r) { (byGame[r.g.game_id] = byGame[r.g.game_id] || []).push(r); });
    if (S.gtab === 'soon') gs = gs.filter(function (g) { var k = ms(g.kickoff); return k > n && k - n <= 6 * 3600e3; });
    if (S.gtab === 'fav') gs = gs.filter(function (g) { return S.watch.game[g.game_id]; });
    if (S.gtab === 'featured') gs = gs.filter(function (g) { return (byGame[g.game_id] || []).some(function (r) { return r.decision === 'BET' || r.decision === 'LEAN'; }) || g.n_priced >= 20; });
    if (q) gs = gs.filter(function (g) { return (g.home_name + ' ' + g.away_name + ' ' + g.home + ' ' + g.away).toLowerCase().indexOf(q) >= 0 || (byGame[g.game_id] || []).some(function (r) { return r.name.toLowerCase().indexOf(q) >= 0; }); });
    h += '<button class="pp-gm' + (!S.game ? ' on' : '') + '" data-pp-act="game" data-v=""><span class="t">All games</span><span class="m"><span>' + (b.games || []).length + ' games</span><span>' + rows.length + ' props</span></span></button>';
    if (!gs.length) h += '<div class="pp-empty" style="margin:10px">' + (S.gtab === 'fav' ? 'No starred games yet. Tap ☆ on a game to follow it.' : S.gtab === 'soon' ? 'No game starts in the next six hours.' : 'No game matches.') + '</div>';
    gs.forEach(function (g) {
      var k = ms(g.kickoff), started = k != null && k <= n, gr = byGame[g.game_id] || [];
      var bets = gr.filter(function (r) { return r.decision === 'BET'; }).length;
      var mkt = g.n_priced ? '<span class="live">' + g.n_priced + ' priced</span>' : '<span class="warn">no prices yet</span>';
      h += '<button class="pp-gm' + (S.game === g.game_id ? ' on' : '') + '" data-pp-act="game" data-v="' + esc(g.game_id) + '" aria-expanded="' + !!S.expanded[g.game_id] + '">' +
        '<span class="t">' + esc(tl(g.away)) + ' @ ' + esc(tl(g.home)) + '<span class="pp-star star' + (S.watch.game[g.game_id] ? ' on' : '') + '" role="button" tabindex="0" aria-label="Follow game" data-pp-act="star" data-kind="game" data-v="' + esc(g.game_id) + '">' + (S.watch.game[g.game_id] ? '★' : '☆') + '</span></span>' +
        '<span class="m"><span>' + esc(clock(g.kickoff)) + '</span><span>' + (started ? '<span class="warn">STARTED</span>' : 'pregame') + '</span>' + mkt + '<span>' + gr.length + ' props</span>' + (bets ? '<span class="live">' + bets + ' BET</span>' : '') + '</span></button>';
      if (S.expanded[g.game_id]) {
        var seen = {}, pls = [];
        gr.forEach(function (r) { if (r.r.p && !seen[r.r.p]) { seen[r.r.p] = 1; pls.push(r); } });
        pls.sort(function (a, b2) { return (a.team === g.away ? 0 : 1) - (b2.team === g.away ? 0 : 1) || ['QB', 'RB', 'WR', 'TE', 'K'].indexOf(a.pos) - ['QB', 'RB', 'WR', 'TE', 'K'].indexOf(b2.pos) || a.name.localeCompare(b2.name); });
        h += '<div class="pp-gplayers">' + pls.map(function (r) { return '<button data-pp-act="player" data-v="' + esc(r.r.p) + '"' + (S.player === r.r.p ? ' style="color:var(--accent)"' : '') + '><span class="pos">' + esc(r.pos) + '</span>' + esc(r.name) + ' <span class="pp-note">' + esc(tl(r.team)) + '</span></button>'; }).join('') + '</div>';
      }
    });
    return h + '</div></nav>';
  }

  /* ---- market tabs: only categories and markets that carry data */
  function catsHTML(b) {
    if (!b) return '';
    var E = P(), rows = rowsOf(S.league).filter(function (r) { return (!S.game || r.g.game_id === S.game) && (S.mode !== 'value' || r.priced) && (S.mode !== 'mine' || isWatched(r)); });
    var cats = {}, mk = {};
    rows.forEach(function (r) { cats[r.cat] = (cats[r.cat] || 0) + 1; if (S.cat === 'all' || r.cat === S.cat) mk[r.market] = (mk[r.market] || 0) + 1; });
    var h = '<div class="pp-cats" role="tablist" aria-label="Market categories"><button role="tab" class="pp-tab' + (S.cat === 'all' ? ' on' : '') + '" data-pp-act="cat" data-v="all">All<span class="n">' + rows.length + '</span></button>' +
      E.CATEGORIES.filter(function (c) { return cats[c.key]; }).map(function (c) { return '<button role="tab" class="pp-tab' + (S.cat === c.key ? ' on' : '') + '" data-pp-act="cat" data-v="' + c.key + '">' + c.label + '<span class="n">' + cats[c.key] + '</span></button>'; }).join('') + '</div>';
    var keys = Object.keys(mk).sort(function (a, c) { return Object.keys(E.MARKETS).indexOf(a) - Object.keys(E.MARKETS).indexOf(c); });
    if (keys.length > 1 || S.market) h += '<div class="pp-mkts">' + '<button class="pp-chip' + (!S.market ? ' on' : '') + '" data-pp-act="market" data-v="">All markets</button>' + keys.map(function (k) { return '<button class="pp-chip' + (S.market === k ? ' on' : '') + '" data-pp-act="market" data-v="' + k + '">' + esc(E.MARKETS[k].label) + '<span class="n">' + mk[k] + '</span></button>'; }).join('') + '</div>';
    return h;
  }

  /* ---- the board */
  var COLS = [['', '', ''], ['Player', 'player', ''], ['Market', '', ''], ['Line', '', 'r'], ['Over', '', 'r'], ['Under', '', 'r'], ['Best price', 'price', ''], ['Proj', 'diff', 'r'], ['Fair', '', 'r c-fair'],
    ['Model', 'prob', 'r'], ['No-vig', '', 'r c-nv'], ['EV', 'ev', 'r'], ['Edge', '', 'r c-edge'], ['Conf', 'conf', 'r'], ['Decision', 'value', ''], ['Stake', '', 'r c-stake']];
  function boardHTML(b, st) {
    if (st === 'loading' && !b) return '<div class="pp-table">' + skelRows(8) + '</div><div class="pp-cards">' + skelRows(4) + '</div>';
    if (st === 'error') return errorHTML();
    if (!b) return '';
    var rows = visible();
    S._visible = rows;
    if (!rows.length) return emptyHTML(b);
    var head = '<div class="pp-thead" role="row">' + COLS.map(function (c) { return '<span class="' + c[2] + '" role="columnheader">' + (c[1] ? '<button class="' + (S.sort === c[1] ? 'on' : '') + '" data-pp-act="sort" data-v="' + c[1] + '">' + c[0] + '</button>' : c[0]) + '</span>'; }).join('') + '</div>';
    var table = '<div class="pp-table" role="table" aria-label="Player props board" aria-rowcount="' + rows.length + '">' + head + '<div class="pp-scroll" id="ppScroll"><div class="pp-rows" id="ppRows" style="height:' + (rows.length * ROW_H) + 'px"></div></div></div>';
    var cv = captureView(b), staleBoard = cv.priced && cv.age > 90;
    var note = S.mode !== 'value' ? '' : staleBoard
      ? '<div class="pp-note pp-cnote"><b>STALE PRICES</b> — listed in the last capture\'s order (' + esc(ago(cv.at)) + '), for reference only.</div>'
      : '<div class="pp-note pp-cnote">TOP PLAYER PROP RESEARCH — ranked by research quality, not by EV alone.</div>';
    var cards = '<div class="pp-cards">' + note +
      rows.slice(0, S.cardsShown).map(function (r, i) { return cardHTML(r, i); }).join('') +
      (rows.length > S.cardsShown ? '<button class="pp-btn pp-more" data-pp-act="more">Show ' + Math.min(PAGE, rows.length - S.cardsShown) + ' more of ' + (rows.length - S.cardsShown) + '</button>' : '') + '</div>';
    return table + cards;
  }
  function skelRows(n) { var h = ''; for (var i = 0; i < n; i++) h += '<div class="pp-skel"></div>'; return h; }
  function errorHTML() {
    var e = S.errors[S.league];
    if (e === 'not_published') return '<div class="pp-empty"><b>No ' + (S.league === 'cfb' ? 'college' : 'NFL') + ' prop board has been published yet.</b>The build writes football/props/' + S.league + '/board.json. The other sport is unaffected.</div>';
    return '<div class="pp-err"><b>The ' + (S.league === 'cfb' ? 'college' : 'NFL') + ' prop board could not be loaded.</b> ' + esc(e || '') + '. Nothing on this page has been guessed to fill the gap. <button class="pp-btn" data-pp-act="retry">Retry</button></div>';
  }
  function emptyHTML(b) {
    var all = rowsOf(S.league);
    if (!b.games || !b.games.length) return '<div class="pp-empty"><b>No upcoming ' + (S.league === 'cfb' ? 'college' : 'NFL') + ' games on the board.</b>Games appear here once they are inside the next week.</div>';
    if (S.mode === 'mine') return '<div class="pp-empty"><b>Nothing starred yet.</b>Tap ☆ on a prop, a player or a game to follow it here.</div>';
    if (S.mode === 'value' && !all.some(function (r) { return r.priced; })) {
      /* what the last capture actually found, not a guess from the zero */
      var v = captureView(b), cap = v.cap;
      var t = v.st === 'NO_MARKETS' && cap.reason === 'NO_EVENTS_IN_WINDOW' ? ['No game is inside the price-capture window yet.', 'Prices are requested for games kicking off in the next ' + (cap.window_h || 96) + ' hours.']
        : v.st === 'NO_MARKETS' ? ['Waiting for sportsbooks to release player markets.', 'The last capture' + (v.checked ? ' (' + ago(v.checked) + ')' : '') + ' found no player market posted for these games yet.']
        : v.st === 'ERROR' ? ['The sportsbook price capture failed.', 'No prop price was captured: the notice above says why.']
        : v.st === 'RUNNING' ? ['The sportsbook price capture did not finish.', 'No prop price was written by it.']
        : v.priced ? ['No prop on this board has a captured price yet.', 'The last capture priced other games or players.']
        : ['Sportsbook prices have not been captured yet.', 'The prop capture has not run for these games.'];
      return '<div class="pp-empty"><b>' + esc(t[0]) + '</b>' + esc(t[1]) + ' <button class="pp-btn acc" data-pp-act="mode" data-v="all">See EdgeDesk projections and fair lines</button></div>';
    }
    if (S.game && !all.some(function (r) { return r.g.game_id === S.game; })) return '<div class="pp-empty"><b>No props currently available for this game.</b></div>';
    return '<div class="pp-empty"><b>No opportunities meet your current filters.</b>Loosen the EV, confidence, edge or sample filters, or clear the search. <button class="pp-btn" data-pp-act="reset">Reset filters</button></div>';
  }
  function paintRows() {
    var sc = $('ppScroll'), host = $('ppRows'), rows = S._visible || [];
    if (!sc || !host) return;
    var top = sc.scrollTop, hgt = sc.clientHeight || 600;
    var a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN), z = Math.min(rows.length, Math.ceil((top + hgt) / ROW_H) + OVERSCAN);
    var h = '';
    for (var i = a; i < z; i++) h += rowHTML(rows[i], i);
    host.innerHTML = h;
  }
  function rowHTML(r, i) {
    var c = r.cand, bk = bankroll();
    var line = r.line != null ? r.line : (r.lastSeen ? r.lastSeen[0] : null);
    var fair = r.priced && c ? price(c.fair) : (isNum(r.median) ? '<span class="sub">line</span>' + (Math.floor(r.median) + 0.5) : '—');
    var bestCell = c ? '<b class="' + evTone(c.ev) + '">' + esc(E_().selectionText(r.market, c.side, c.line).replace(' ' + r.md.short, '')) + ' ' + price(c.american) + '</b><i>' + esc(abbr(c.book)) + (c.alt ? ' · alt' : '') + (r.stale ? ' · <span class="pp-stale">STALE</span>' : '') + '</i>' : (r.priced ? '<i>no executable price</i>' : '<i>no market</i>');
    var evd = c && bk.unit ? E_().evDollars(c.ev, 1, bk.unit) : null;
    var stake = r.units > 0 ? units(r) + (bk.unit ? '<span class="sub">' + money(r.units * bk.unit) + '</span>' : '') : (evd != null ? '<span class="sub">EV/U</span>' + money(evd) : '—');
    var inj = r.pl && r.pl.status && r.pl.status.status ? ' <span class="pp-inj' + (r.pl.status.status === 'OUT' ? ' out' : '') + '">' + esc(r.pl.status.status.charAt(0)) + '</span>' : '';
    return '<div class="pp-row' + (S.drawer === r.key ? ' sel' : '') + '" role="row" tabindex="0" style="top:' + (i * ROW_H) + 'px" data-pp-act="open" data-v="' + esc(r.key) + '">' +
      '<span><span class="pp-star' + (S.watch.prop[r.key] ? ' on' : '') + '" role="button" tabindex="0" aria-label="Watch this prop" data-pp-act="star" data-kind="prop" data-v="' + esc(r.key) + '">' + (S.watch.prop[r.key] ? '★' : '☆') + '</span></span>' +
      '<span class="pl"><b>' + esc(r.name) + inj + '</b><i>' + esc(r.pos) + ' · ' + esc(tl(r.team)) + (r.g.home === r.team ? ' vs ' : ' @ ') + esc(tl(r.opp)) + ' · ' + esc(clock(r.g.kickoff)) + '</i></span>' +
      '<span class="mk">' + esc(r.md.label) + ' ' + stageTag(stageOfRow(S.boards[S.league], r.market), true) + '</span>' +
      '<span class="r">' + (line != null ? line : '—') + (r.nBooks ? '<span class="sub">' + r.nBooks + ' bk</span>' : '') + '</span>' +
      '<span class="r' + (r.bestO && r.over != null && E_().priceBetter(r.bestO.american, r.over) ? ' t-pos' : '') + '">' + (r.bestO ? price(r.bestO.american) : (r.over != null ? price(r.over) : '—')) + (r.bestO ? '<span class="sub">' + esc(abbr(r.bestO.book)) + '</span>' : '') + '</span>' +
      '<span class="r' + (r.bestU && r.under != null && E_().priceBetter(r.bestU.american, r.under) ? ' t-pos' : '') + '">' + (r.bestU ? price(r.bestU.american) : (r.under != null ? price(r.under) : '—')) + (r.bestU ? '<span class="sub">' + esc(abbr(r.bestU.book)) + '</span>' : '') + '</span>' +
      '<span class="best">' + bestCell + '</span>' +
      '<span class="r">' + n1(r.proj) + (isNum(r.projRaw) && isNum(r.proj) && Math.abs(r.projRaw - r.proj) > 0.05 ? '<span class="sub">raw ' + n1(r.projRaw) + '</span>' : '') + '</span>' +
      '<span class="r c-fair">' + fair + '</span>' +
      '<span class="r">' + (c ? pct(r.pModel) : (isNum(r.pModelCons) ? pct(r.pModelCons) : '—')) + '</span>' +
      '<span class="r c-nv">' + (r.pNv != null ? pct(r.pNv) + (r.interp ? '<span class="sub">interp</span>' : '') : '—') + '</span>' +
      '<span class="r ' + evTone(c && c.ev) + '">' + (c ? spct(c.ev) : '—') + '</span>' +
      '<span class="r c-edge">' + (r.edgeNv != null ? pp(r.edgeNv) : '—') + '</span>' +
      '<span class="r"><span class="pp-conf ' + confCls(r.conf) + '">' + (isNum(r.conf) ? r.conf : '—') + '</span></span>' +
      '<span><span class="pp-dec ' + r.tone + '" title="' + esc(r.code || '') + '">' + esc(decLabel(r.decision, r.code)) + '</span></span>' +
      '<span class="r c-stake">' + stake + '</span></div>';
  }
  /* one prop as a phone card. A price past the decision limit keeps its line
     and its last prices on the card, labelled stale — never an EV, never a
     decision; a prop with no market shows EdgeDesk's own line. */
  function cardHTML(r, i) {
    var c = r.cand, bk = bankroll(), E = E_(), yn = !!r.md.yesno;
    var sideTag = function (side) { return yn ? (side === 'over' ? 'Yes' : 'No') : (side === 'over' ? 'O' : 'U'); };
    var tile = function (k, v, cls) { return '<span><span class="k">' + k + '</span><span class="v' + (cls ? ' ' + cls : '') + '">' + v + '</span></span>'; };
    var lineT, priceT, evT, lastT;
    if (c) {
      lineT = tile('Line', r.line != null ? esc(r.line) : esc(c.line));
      priceT = tile('Best price', esc(sideTag(c.side) + (yn ? '' : ' ' + c.line) + ' ' + price(c.american)), evTone(c.ev));
      evT = tile('EV', spct(c.ev), evTone(c.ev));
      lastT = tile(r.units > 0 ? 'Stake' : 'Book', r.units > 0 ? units(r) + (bk.unit ? ' · ' + money(r.units * bk.unit) : '') : esc(abbr(c.book)));
    } else if (r.priced && r.refLine != null) {
      /* the last prices seen at the line, each side's best — shown, not priced */
      var bestTxt = function (q) { return q ? (q.line !== r.refLine ? esc(q.line) + ' ' : '') + esc(price(q.american)) + ' <small>' + esc(abbr(q.book)) + '</small>' : '—'; };
      lineT = tile('Line', esc(r.refLine));
      priceT = tile(yn ? 'Yes' : 'Over', bestTxt(r.lastO));
      evT = tile(yn ? 'No' : 'Under', bestTxt(r.lastU));
      lastT = tile('Books', r.nQBooks || '—');
    } else {
      lineT = tile('EdgeDesk line', isNum(r.median) && !yn ? esc(Math.floor(r.median) + 0.5) : '—');
      priceT = tile('Best price', '<span class="pp-note">' + (r.priced ? 'no price' : 'no market') + '</span>');
      evT = tile('EV', '—');
      lastT = tile('Book', '—');
    }
    /* a yes/no market's projection reads as the chance of a yes, not a count */
    var pYes = null;
    if (yn) {
      pYes = r.pOver;
      if (!isNum(pYes)) { try { var d = r.r.x && r.r.x.dist, pl0 = d && E.validDist(d) ? E.probLine(d, 0.5) : null; pYes = pl0 ? pl0.over / Math.max(1e-9, pl0.over + pl0.under) : null; } catch (e) { pYes = null; } }
    }
    var projT = yn ? tile('TD chance', isNum(pYes) ? pct(pYes, pYes < 0.1 ? 1 : 0) : '—') : tile('Projection', n1(r.proj));
    /* before the page's own re-pricing lands, a stale row still carries the build's numbers */
    var foot = r.stale ? '<span class="pp-cfoot">Priced ' + esc(ago(r.capAt)) + (c ? ' · stale, re-pricing' : ' · no EV or decision on a stale price') + '</span>' : '';
    return '<button class="pp-card' + (r.stale ? ' stale' : '') + '" data-pp-act="open" data-v="' + esc(r.key) + '"><span class="h">' + (S.mode === 'value' ? '<span class="pp-rank">' + (i + 1) + '.</span>' : '') +
      '<span class="who"><b>' + esc(r.name) + '</b><i>' + esc(r.md.label) + ' · ' + esc(tl(r.team)) + (r.g.home === r.team ? ' vs ' : ' @ ') + esc(tl(r.opp)) + ' · ' + esc(clock(r.g.kickoff)) + '</i></span>' +
      '<span class="pp-dec ' + r.tone + '">' + esc(decLabel(r.decision, r.code)) + '</span></span>' +
      '<span class="g">' + lineT + priceT + evT + projT + tile('Confidence', isNum(r.conf) ? r.conf : '—') + lastT + '</span>' + foot + '</button>';
  }

  /* ================================================================ DRAWER */
  function findRow(key) { var rs = rowsOf(S.league); for (var i = 0; i < rs.length; i++) if (rs[i].key === key) return rs[i]; return null; }
  function playerLogs(pid) {
    var j = S.players[S.league]; if (!j || !j.players || !j.players[pid]) return null;
    var p = j.players[pid], cols = p.cols || j.cols;
    return { p: p, logs: (p.logs || []).map(function (a) { var o = {}; cols.forEach(function (c, i) { o[c] = a[i]; }); o.s = o.season; o.w = o.week; o.op = o.opp; o.h = o.home; return o; }) };
  }
  function drawerHTML() {
    var row = findRow(S.drawer), b = S.boards[S.league];
    if (!row || !b) return '<div class="pp-empty">This prop is no longer on the board.</div>';
    var E = P(), r = row.r, ev = null;
    try { ev = fullEval(b, r); } catch (e) { ev = null; }
    if (!ev) return '<div class="pp-err"><b>This prop could not be evaluated.</b></div>';
    ev = E.applyExposure(ev, exposureOf(row));
    S._drawerEval = ev;
    var pl = row.pl || {}, g = row.g, md = row.md, c = ev.candidate, bk = bankroll();
    var PL = r.p ? playerLogs(r.p) : null;
    var h = '<div class="pp-dh"><div class="who"><h3>' + esc(row.name) + ' <span class="pp-tag">' + esc(row.pos) + '</span>' + injChip(pl) + ' ' + stageTag(stageOfRow(b, row.market)) + '</h3><p>' + esc(md.label) + ' · ' + esc(tl(row.team)) + (g.home === row.team ? ' vs ' : ' @ ') + esc(tl(row.opp)) + ' · ' + esc(clock(g.kickoff)) + '</p></div>' +
      (r.p ? '<button class="pp-star' + (S.watch.player[r.p] ? ' on' : '') + '" data-pp-act="star" data-kind="player" data-v="' + esc(r.p) + '" aria-label="Follow player" title="Follow this player">' + (S.watch.player[r.p] ? '★' : '☆') + '<small>Player</small></button>' : '') +
      '<button class="pp-star' + (S.watch.prop[row.key] ? ' on' : '') + '" data-pp-act="star" data-kind="prop" data-v="' + esc(row.key) + '" aria-label="Watch prop" title="Watch this prop">' + (S.watch.prop[row.key] ? '★' : '☆') + '<small>Prop</small></button>' +
      '<button class="x" data-pp-act="close" aria-label="Close research panel">×</button></div>';
    h += decisionSec(ev, row, bk);
    h += priceSec(ev, row, b);
    h += ladderSec(ev, row);
    h += projSec(ev, row, b, PL);
    h += probSec(ev, row);
    h += factorySec(ev, row, b);
    h += evSec(ev, row, bk);
    h += whySec(ev, row, b, PL);
    h += historySec(row, b, PL);
    h += usageSec(row, b, PL);
    h += matchupSec(row, b);
    h += gameSec(row, b);
    h += roleSec(row, PL);
    h += uncertaintySec(ev, row, b);
    h += stageSec(b, row);
    h += corrSec(ev, row, b);
    h += '<div class="pp-sec"><p class="pp-note">Research, not picks. EdgeDesk\'s probability is ' + esc(ev.probability_label) + '. Historical hit rates are context, not probability. 21+ · 1-800-GAMBLER.</p></div>';
    return h;
  }
  /* the market's validation stage (EDProps.stageOf, carried on the board) */
  function stageOfRow(b, m) { var st = b && b.stages && b.stages[m]; return st ? st.stage : null; }
  function stageTag(stage, short) {
    if (!stage) return '';
    var c = { EXPERIMENTAL: 'exp', TRACKING: 'trk', RESEARCH_GRADE: 'rg', PRODUCTION: 'prod' }[stage] || 'exp';
    var lab = short ? ({ EXPERIMENTAL: 'EXP', TRACKING: 'TRK', RESEARCH_GRADE: 'RG', PRODUCTION: 'PROD' }[stage] || 'EXP') : (P().STAGE_LABEL[stage] || stage);
    var help = stage === 'EXPERIMENTAL' ? 'EXPERIMENTAL: this market has not passed EdgeDesk\'s walk-forward gates. It informs; it never stakes (LEAN at most).'
      : stage === 'TRACKING' ? 'TRACKING: passed the walk-forward gates out of sample; live evaluations are frozen and graded.' : stage === 'RESEARCH_GRADE' ? 'RESEARCH GRADE: live calibration, Brier vs the market and CLV hold.' : 'PRODUCTION: a large live sample, tight calibration and positive CLV.';
    return '<span class="pp-stage ' + c + '" title="' + esc(help) + '">' + esc(lab) + '</span>';
  }
  function stageSec(b, row) {
    var st = b && b.stages && b.stages[row.market];
    if (!st) return '';
    var gates = gatesHTML(st.gates);
    return sec('Validation stage ' + stageTag(st.stage), '<p class="pp-note">A market\'s stage is derived from its evidence, never assigned: the walk-forward backtest decides TRACKING, the live record decides the rest. ' +
      (st.stage === 'EXPERIMENTAL' ? 'Until it passes, a decision here is capped at LEAN and carries no units.' : 'Stakes are still capped by the probability source (' + esc(b.probability ? b.probability.label : 'model-estimated') + ').') + '</p>' +
      (st.why && st.why.length ? '<p class="pp-note">' + esc(st.why.join(' · ')) + '</p>' : '') + '<details class="pp-gates"><summary>Every gate</summary>' + gates + '</details>');
  }
  function gatesHTML(gates) { return (gates || []).map(function (g) { return '<div class="pp-gate"><span>' + esc(g.id + ' · ' + g.name) + '</span><span class="' + (!g.measured ? 'na' : g.pass ? 'ok' : 'no') + '">' + (!g.measured ? 'not measured' : g.pass ? 'pass' : 'fail') + (g.detail ? ' <i>' + esc(g.detail) + '</i>' : '') + '</span></div>'; }).join(''); }
  function injChip(pl) { var s = pl && pl.status && pl.status.status; return s ? ' <span class="pp-tag pp-inj' + (s === 'OUT' ? ' out' : '') + '" title="' + esc((pl.status.injury || '') + ' ' + (pl.status.practice || '')) + '">' + esc(s) + '</span>' : ''; }
  function sec(title, body, lbl) { return '<section class="pp-sec"><h4>' + title + (lbl ? ' <span class="lbl">' + lbl + '</span>' : '') + '</h4>' + body + '</section>'; }
  function kv(items) { return '<div class="pp-kv">' + items.map(function (x) { return '<div><span class="k">' + esc(x[0]) + '</span><span class="v' + (x[2] ? ' ' + x[2] : '') + '">' + x[1] + '</span></div>'; }).join('') + '</div>'; }
  /* the page's exposure cap for a row once it has re-priced; before that,
     the one the build wrote on the row */
  function exposureOf(row) {
    var m = S.exposure[S.league];
    if (S.reprice[S.league] === 'done' && m) return m[row.key] || null;
    var xp = row.r.e && row.r.e.xp;
    return xp ? { units: row.r.e.u, from: xp[1], code: xp[0], text: xp[2] } : null;
  }
  /* SAME GAME: the props this one moves with (board.correlation, measured
     from game logs), and a seeded Monte Carlo of each pair's joint outcome
     beside the product of their own chances (EDProps.jointSim) */
  function selOf(b, r2, e) {
    if (!e) return null;
    var c = e.cand, ctx = ctxOf(b, r2) || {};
    var leg = { g: r2.g, p: r2.p, team: ctx.team, pos: ctx.pos, m: r2.m, key: r2.key, name: ctx.name };
    if (c) return Object.assign(leg, { side: c[0], line: c[1], p_win: c[4], p_push: c[5] || 0 });
    if (e.ac && e.cons && isNum(e.cons[0])) { var side = r2.s === 'under' ? 'under' : 'over'; return Object.assign(leg, { side: side, line: e.cons[0], p_win: side === 'over' ? e.ac[0] : e.ac[1], p_push: e.ac[2] || 0 }); }
    return null;
  }
  function corrSec(ev, row, b) {
    var E = P(), model = b.correlation;
    if (!model || !row.r.p) return '';
    var me = selOf(b, row.r, E.compact(ev));
    if (!me) return sec('Same-game correlation', '<p class="pp-note">This prop has no sportsbook line yet, so there is no selection to pair.</p>');
    var pairs = [];
    (b.props || []).forEach(function (r2) {
      if (r2 === row.r || r2.g !== row.r.g || !r2.p) return;
      var o = selOf(b, r2, (S.evals[S.league] || {})[r2.key] || r2.e); if (!o) return;
      var rho = E.selCorr(model, me, o);
      if (Math.abs(rho) >= 0.15) pairs.push({ o: o, rho: rho });
    });
    pairs.sort(function (a, c) { return Math.abs(c.rho) - Math.abs(a.rho); });
    pairs = pairs.slice(0, 6);
    var mine = E.selectionText(row.market, me.side, me.line);
    if (!pairs.length) return sec('Same-game correlation', '<p class="pp-note">No other priced prop in this game moves measurably with ' + esc(mine) + ' (|ρ| < 0.15 in the game logs).</p>', 'measured from game logs');
    var body = '<div class="pp-tw pp-corr"><table class="pp-t"><thead><tr><th>With</th><th>ρ</th><th>Both win</th><th>If independent</th></tr></thead><tbody>' + pairs.map(function (x) {
      var j = E.jointSim([me, x.o], model, { sims: 10000 });
      return '<tr><td>' + esc(x.o.name + ' ' + E.selectionText(x.o.m, x.o.side, x.o.line)) + '</td><td class="' + (x.rho > 0 ? 't-pos' : 't-neg') + '">' + (x.rho > 0 ? '+' : '−') + Math.abs(x.rho).toFixed(2) + '</td><td>' + pct(j.p_all) + '</td><td>' + pct(j.p_indep) + '</td></tr>'; }).join('') + '</tbody></table></div>' +
      '<p class="pp-note">ρ is the correlation of the two selections as they stand (an Under flips it), measured from ' + esc((model.seasons || []).join('–')) + ' game logs' + (model.borrowed ? ' (NFL, borrowed by college)' : '') + '. "Both win" is a seeded 10,000-run simulation that keeps each prop\'s own probability and adds only that dependence. Stakes across one game are capped on it: ' + esc(String((b.exposure || E.CONFIG.exposure).player_max_units)) + 'U per player, ' + esc(String((b.exposure || E.CONFIG.exposure).game_max_units)) + 'U of correlated stake per game.</p>';
    return sec('Same-game correlation', body, 'measured from game logs');
  }
  function decisionSec(ev, row, bk) {
    var E = P(), c = ev.candidate;
    var head = '<span class="pp-dec ' + toneOf(ev.decision) + '">' + esc(decLabel(ev.decision, ev.code)) + '</span> ';
    var txt = ev.decision === 'NO_DECISION' ? esc(ev.blocker_text || E.BLOCK_TEXT[ev.code] || ev.code) : (c ? '<b>' + esc(ev.selection) + ' ' + price(c.american) + '</b> · ' + esc(book(c.book)) + (c.alt ? ' (alternate)' : '') : 'No executable price.');
    var money1 = ev.units > 0 && bk.unit ? E.stake(ev.units, bk.settings, c.american) : null;
    var lines = [head + txt];
    if (c) lines.push('EV <b class="' + evTone(c.ev) + '">' + spct(c.ev) + '</b> · edge ' + pp(c.edge_pp) + ' pp vs break-even · confidence ' + ev.confidence.score + ' (' + esc(ev.confidence.label) + ')' + (ev.units > 0 ? ' · <b>' + E.unitsText(ev.units) + '</b>' + (money1 && money1.stake != null ? ' = ' + money(money1.stake) + ' to win ' + money(money1.to_win) : ' (set a unit to see dollars)') : ''));
    (ev.caps || []).forEach(function (x) { lines.push('<span class="pp-note">Capped: ' + esc(x.text || x.code) + '</span>'); });
    if (ev.trigger && ev.trigger.text && ev.decision !== 'BET') lines.push('<span class="pp-note">Trigger: ' + esc(ev.trigger.text) + '</span>');
    if (ev.decision !== 'BET' && ev.decision !== 'NO_DECISION') lines.push('<span class="pp-note">' + esc(codeText(ev.code)) + '</span>');
    return '<section class="pp-sec">' + lines.map(function (l) { return '<div style="margin:3px 0;font-size:12.5px;line-height:1.5">' + l + '</div>'; }).join('') + (!bk.unit ? '<button class="pp-btn ghost" style="margin-top:6px" data-pp-act="bankroll">Set your unit</button>' : '') + '</section>';
  }
  function codeText(code) {
    return ({ EDGE_BELOW_BET: 'Positive EV, but the edge is below the 4.0 pp / 5% BET threshold.', EDGE_TOO_SMALL: 'The edge is too small to act on at this price.',
      NO_POSITIVE_EV: 'No price on the board has positive expected value.', MARKET_INFORMED_EV_NEGATIVE: 'The raw model sees value; once the market is blended in, the EV is negative.',
      NO_EXECUTABLE_PRICE: 'No fresh price inside the −300 to +300 decision band.', SIZING_ZERO: 'The price qualifies, but every stake cap rounds it to zero.' })[code] || '';
  }
  function priceSec(ev, row, b) {
    var E = P();
    if (!ev.books.length) return sec('Price', ev.last_seen ? '<p class="pp-note">Last seen ' + ev.last_seen.line + ' (' + price(ev.last_seen.over) + ' / ' + price(ev.last_seen.under) + ') — stale, reference only.</p>' : '<p class="pp-note">No sportsbook price is on file for this prop. EdgeDesk\'s fair line is shown under Probability.</p>');
    var bo = ev.best_ev.over, bu = ev.best_ev.under;
    var rows = ev.books.map(function (m) {
      var fr = E.freshnessOf({ captured_at: m.captured_at }, now());
      var isBo = bo && bo.book === m.book && bo.line === m.line, isBu = bu && bu.book === m.book && bu.line === m.line;
      return '<tr class="' + (isBo || isBu ? 'best' : '') + '"><td>' + esc(book(m.book)) + '</td><td>' + m.line + '</td><td class="' + (isBo ? 'bestp' : '') + '">' + price(m.over) + '</td><td class="' + (isBu ? 'bestp' : '') + '">' + price(m.under) + '</td><td>' + (m.novig_over != null ? pct(m.novig_over) : '—') + '</td><td>' + esc(ago(m.captured_at)) + (fr.state === 'STALE' ? ' <span class="pp-stale">STALE</span>' : '') + '</td></tr>';
    }).join('');
    var cons = ev.consensus;
    var body = '<table class="pp-t"><thead><tr><th>Book</th><th>Line</th><th>Over</th><th>Under</th><th>No-vig O</th><th>Updated</th></tr></thead><tbody>' + rows +
      '<tr class="main"><td>Consensus</td><td>' + (cons.line != null ? cons.line : '—') + '</td><td>' + price(cons.over) + '</td><td>' + price(cons.under) + '</td><td>' + (cons.novig_over != null ? pct(cons.novig_over) + (cons.novig_interpolated ? '*' : '') : '—') + '</td><td>' + cons.n_books + ' books</td></tr></tbody></table>';
    var bestTxt = [bo ? 'Best Over (EV): <b>O' + bo.line + ' ' + price(bo.american) + '</b> ' + esc(book(bo.book)) + ' · EV ' + spct(bo.ev) : null, bu ? 'Best Under (EV): <b>U' + bu.line + ' ' + price(bu.american) + '</b> ' + esc(book(bu.book)) + ' · EV ' + spct(bu.ev) : null].filter(Boolean).join('<br>');
    body += '<p class="pp-note" style="margin-top:8px">' + bestTxt + '<br>Best value compares EV across every (book, line, price) — a worse line at a much better price can win.' + (cons.novig_interpolated ? '<br>* No book deals the consensus number: its no-vig is read from the market-implied distribution.' : '') + '</p>';
    var mv = row.r.mv;
    if (mv) body += '<p style="font-size:12px;margin:8px 0 0"><b>Line movement</b> · opened ' + mv.open.line + ' (' + price(mv.open.over) + ' / ' + price(mv.open.under) + ') ' + esc(ago(mv.open.at)) + ' → now ' + mv.current.line + ' (' + price(mv.current.over) + ' / ' + price(mv.current.under) + '). ' + esc(mv.text) + '. <span class="pp-note">Movement is evidence, not a verdict on who moved it.</span></p>';
    else body += '<p class="pp-note" style="margin-top:6px">No earlier capture of this prop yet: movement appears after the next capture.</p>';
    return sec('Price', body, 'every book · best EV highlighted');
  }
  function ladderSec(ev, row) {
    if (!ev.ladder || !ev.ladder.some(function (x) { return !x.main; })) return '';
    var best = null; ev.ladder.forEach(function (x) { if (x.ev != null && (!best || x.ev > best.ev)) best = x; });
    var body = '<table class="pp-t"><thead><tr><th>Line</th><th>Price</th><th>Book</th><th>Implied</th><th>EdgeDesk</th><th>Fair</th><th>EV</th></tr></thead><tbody>' +
      ev.ladder.map(function (x) { return '<tr class="' + (x === best ? 'best' : '') + (x.main ? ' main' : '') + '"><td>' + (x.side === 'over' ? 'O ' : 'U ') + x.line + (x.main ? '' : ' <span class="pp-tag">alt</span>') + '</td><td>' + price(x.american) + '</td><td>' + esc(abbr(x.book)) + (x.books > 1 ? ' +' + (x.books - 1) : '') + '</td><td>' + pct(x.implied) + '</td><td>' + pct(x.p_win) + '</td><td>' + price(x.fair_american) + '</td><td class="' + evTone(x.ev) + '">' + spct(x.ev) + '</td></tr>'; }).join('') + '</tbody></table>';
    return sec('Alternate lines', body + '<p class="pp-note" style="margin-top:6px">The highlighted rung is the best EV on the ladder, not automatically the main line. Rungs priced beyond −300 / +300 are shown, never recommended.</p>', 'fair probability, implied probability and EV per rung');
  }
  function projSec(ev, row, b, PL) {
    var raw = ev.raw || {}, inf = ev.informed || {}, cal = b.calibration && b.calibration.markets ? b.calibration.markets[row.market] : null;
    var d = row.r.x && row.r.x.dist;
    var body = kv([['Raw projection', n1(raw.mean)], ['Market-informed', n1(inf.mean)], ['Market-implied', ev.market_implied_mean != null ? n1(ev.market_implied_mean) : '—'],
      ['Median', inf.median != null ? inf.median : '—'], ['25th pct', inf.p25 != null ? inf.p25 : '—'], ['75th pct', inf.p75 != null ? inf.p75 : '—']]) +
      '<canvas class="pp-dist" id="ppDist" width="360" height="84" aria-label="Projected outcome distribution"></canvas>' +
      '<p class="pp-note">Blend: ' + Math.round(100 * (1 - (ev.market_weight || 0))) + '% raw model + ' + Math.round(100 * (ev.market_weight || 0)) + '% market-implied centre' + (ev.anchored ? '' : ' (no two-sided market: the raw model stands alone)') + '. Distribution: <b>' + esc(d ? distName(d) : '—') + '</b>' +
      (cal ? ' · backtest multipliers: variance ×' + cal.f + ', mean ×' + cal.mean_mult + (cal.adopted === false ? ' (not adopted)' : '') : '') + '.</p>';
    var steps = PL && PL.p && PL.p.steps;
    if (steps && steps.length) body += '<details><summary class="pp-note" style="cursor:pointer">How the projection was built (' + steps.length + ' steps)</summary><ul class="pp-steps">' + steps.map(function (s) { return '<li><span>' + esc(s.label) + '<i>' + esc(s.note || '') + '</i></span><b>' + (isNum(s.value) ? n1(s.value) : esc(s.value)) + '</b></li>'; }).join('') + '</ul></details>';
    else if (!PL) body += '<p class="pp-note">Loading the projection build…</p>';
    return sec('EdgeDesk projection', body, 'raw and market-informed, never merged silently');
  }
  function distName(d) {
    var f = d.family;
    if (f === 'gcomp') return 'gamma compound: N ~ ' + (d.n.family === 'negbin' ? 'NegBin(mean ' + n1(d.n.mean) + ', size ' + n1(d.n.size) + ')' : 'Poisson(' + n1(d.n.lambda) + ')') + ' events × Gamma(shape ' + n1(d.a) + ', scale ' + n1(d.theta) + ')' + (d.shift ? ' − ' + d.shift : '');
    if (f === 'maxemp') return 'longest play: max over N ~ ' + (d.n.family === 'negbin' ? 'NegBin(' + n1(d.n.mean) + ')' : 'Poisson(' + n1(d.n.lambda) + ')') + ' plays of the league per-play table ' + d.shape + ' × ' + n1(d.scale);
    if (f === 'maxcomp') return 'longest play: max of Gamma events';
    if (f === 'conv') return 'convolution of ' + d.parts.length + ' independent parts (rushing + receiving)';
    if (f === 'normal') return 'Normal(μ ' + n1(d.mu) + ', σ ' + n1(d.sigma) + ')';
    if (f === 'negbin') return 'Negative binomial(mean ' + n1(d.mean) + ', size ' + n1(d.size) + ')';
    if (f === 'poisson') return 'Poisson(λ ' + n1(d.lambda) + ')';
    if (f === 'bernoulli') return 'Bernoulli(p ' + pct(d.p) + ')';
    return f;
  }
  /* THE VALIDATED MODEL — the data factory's walk-forward-validated
     distribution for this player and market (board row fx, board.factory,
     EDProps.factoryView), priced at the same line and price as the decision.
     Evidence beside the engine: it never sets the decision. */
  function factorySec(ev, row, b) {
    var E = P(), meta = b.factory, fx = row.r.fx;
    if (!fx || !meta || meta.state !== 'JOINED' || typeof E.factoryView !== 'function') return '';
    var c = ev.candidate, ac = ev.at_consensus;
    var line = c ? c.line : (ac ? ac.line : (ev.informed && isNum(ev.informed.median) ? Math.floor(ev.informed.median) + 0.5 : null));
    var side = c ? c.side : (row.r.s === 'under' ? 'under' : 'over');
    var v = E.factoryView(fx, meta, line, side, c ? c.american : null);
    if (!v) return '';
    var engP = c ? c.p_win : (ac ? (side === 'under' ? ac.under : ac.over) : null);
    var sideTxt = v.yes_no ? (side === 'under' ? 'No' : 'Yes') : (side + ' ' + v.line);
    var items = v.yes_no ? [] : [['Median', n1(v.median)], ['80% range', n1(v.p10) + '–' + n1(v.p90)]];
    items.push(['P(' + sideTxt + ')', pct(v.p_side)], ['Engine P', pct(engP)], ['Fair price', price(v.fair_american)]);
    if (v.american != null) items.push(['EV at ' + price(v.american), spct(v.ev)]);
    var agree = '';
    if (isNum(v.p_side) && isNum(engP)) {
      var same = (v.p_side >= 0.5) === (engP >= 0.5);
      agree = '<p class="pp-note">' + (same ? 'The validated model and the engine lean the same way' : 'The validated model and the engine disagree') + ' on ' + esc(sideTxt) + ': ' + pct(v.p_side) + ' vs ' + pct(engP) + '.' + (same ? '' : ' Treat the decision with extra care.') + '</p>';
    }
    var evidence = esc(v.model_version || '') + ' · ' + esc(String(v.tier || '').replace(/_/g, ' ').toLowerCase()) + (isNum(v.mae_skill) ? ' · walk-forward MAE skill ' + (v.mae_skill >= 0 ? '+' : '') + (100 * v.mae_skill).toFixed(1) + '% vs naive' : '') + (isNum(v.pit_dev) ? ' · PIT deviation ' + v.pit_dev.toFixed(3) : '') + (v.folds ? ' · ' + v.folds + ' folds' : '');
    return sec('Validated model', kv(items) + agree + '<p class="pp-note">' + evidence + ' · as of ' + esc(clock(v.as_of)) + '. A learned model trained on per-game history (NFL 2011+, college 2014+) and validated walk-forward out of sample (docs/player-props/FACTORY.md). Evidence beside the engine: it does not set this decision.</p>', 'the data factory — a second opinion');
  }
  function probSec(ev, row) {
    var E = P(), ac = ev.at_consensus, body = '';
    var line = ac ? ac.line : (ev.informed ? Math.floor(ev.informed.median) + 0.5 : null);
    var pr = null; try { pr = ac ? ac : (line != null && S._drawerEval && S._drawerEval._dist ? E.probLine(S._drawerEval._dist.informed, line) : null); } catch (e) { pr = null; }
    if (pr) {
      var o = pr.over, u = pr.under, pu = pr.push || 0;
      body += kv([['Line', line + (ac ? '' : ' <small>fair</small>')], ['P(over)', pct(o)], ['P(under)', pct(u)], ['P(push)', pu > 0.0005 ? pct(pu) : '—'], ['Fair over', price(E.fairAmerican(o, pu))], ['Fair under', price(E.fairAmerican(u, pu))]]);
      if (ev.consensus.novig_over != null) body += kv([['No-vig over', pct(ev.consensus.novig_over)], ['No-vig under', pct(ev.consensus.novig_under)], ['Model − no-vig', ev.disagreement_pp != null ? pp(ev.disagreement_pp) + ' pp' : '—']]);
      if (ac && ac.raw_over != null) body += '<p class="pp-note">Raw model (before the market blend): P(over) ' + pct(ac.raw_over) + '.</p>';
    }
    if (ev.empirical_check) body += '<p class="pp-note">History check (context, not the model): ' + ev.empirical_check.n + ' recent games imply P(over) ' + pct(ev.empirical_check.over) + '.</p>';
    body += '<div class="pp-custom" id="ppCustom"><span>Price any line:</span><select id="ppCSide"><option value="over">Over</option><option value="under">Under</option></select><input id="ppCLine" type="number" step="0.5" value="' + (line != null ? line : '') + '" aria-label="Line"><input id="ppCPrice" type="number" step="1" placeholder="-110" aria-label="American price"><button class="pp-btn" data-pp-act="custom">Price it</button><output id="ppCOut"></output></div>';
    return sec('Probability', body, 'EdgeDesk model — not a historical hit rate');
  }
  function evSec(ev, row, bk) {
    var E = P(), c = ev.candidate;
    if (!c) return sec('EV', '<p class="pp-note">No executable price: EV needs a real quote.</p>');
    var st = ev.units > 0 ? E.stake(ev.units, bk.settings, c.american) : null;
    var nv = ev.consensus.novig_over != null ? (c.side === 'over' ? ev.consensus.novig_over : ev.consensus.novig_under) : null;
    var pCons = ev.at_consensus ? (c.side === 'over' ? ev.at_consensus.over : ev.at_consensus.under) / Math.max(1e-9, ev.at_consensus.over + ev.at_consensus.under) : null;
    var body = kv([['EV at ' + price(c.american), '<span class="' + evTone(c.ev) + '">' + spct(c.ev) + '</span>'], ['Raw-model EV', spct(c.ev_raw)], ['Break-even', pct(c.implied)],
      ['EdgeDesk P', pct(c.p_win / Math.max(1e-9, 1 - (c.p_push || 0)))], ['Edge vs break-even', pp(c.edge_pp) + ' pp'], ['Edge vs no-vig', nv != null && pCons != null ? pp(100 * (pCons - nv)) + ' pp' : '—'],
      ['Fair price', price(c.fair_american)], ['EV per unit', bk.unit ? money(E.evDollars(c.ev, 1, bk.unit)) : '—'], ['Stake', ev.units > 0 ? E.unitsText(ev.units) + (st && st.stake != null ? ' · ' + money(st.stake) : '') : '0U']]);
    body += '<p class="pp-note">EV = P(win) × (decimal − 1) − P(loss), at this exact price; a push returns the stake. Never computed at an assumed −110.' + (ev.units > 0 ? ' Units are capped by the probability source (' + esc(ev.probability_label) + ') and a quarter-Kelly ceiling, always rounded down.' : '') + '</p>';
    return sec('EV', body);
  }
  function whySec(ev, row, b, PL) {
    var E = P(), line = ev.consensus.line != null ? ev.consensus.line : (ev.informed ? Math.floor(ev.informed.median) + 0.5 : null);
    var lead = leadOf(row, b), hist = null;
    if (PL && line != null) { var hr = hitsFor(row, b, PL, line, 'over'); if (hr && hr.L10) hist = { hits: hr.L10.hits, n: hr.L10.n - hr.L10.pushes }; }
    var f = E.factsFor({ market: row.market, player: row.pl, env: row.pl && row.pl.env, lead: lead, league_implied: b.league_implied, line: line,
      consensus_price: ev.candidate ? (ev.candidate.side === 'over' ? ev.consensus.over : ev.consensus.under) : null, hist: hist, no_targets: b.sources && b.sources.caps && b.sources.caps.targets === false });
    var o = E.explain(ev, f, 'over'), u = E.explain(ev, f, 'under');
    var list = function (xs, cls) { return xs.length ? '<ul class="pp-list ' + cls + '">' + xs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="pp-note">Nothing measured points this way.</p>'; };
    var fav = ev.candidate ? ev.candidate.side : (ev.at_consensus && ev.at_consensus.over >= ev.at_consensus.under ? 'over' : 'under');
    var first = fav === 'under' ? u : o, second = fav === 'under' ? o : u;
    return sec('Why EdgeDesk likes / dislikes it', '<b style="font-size:11px;letter-spacing:.06em">WHY ' + (fav === 'under' ? 'UNDER' : 'OVER') + '</b>' + list(first.why, 'pp-why') +
      '<b style="font-size:11px;letter-spacing:.06em">RISKS</b>' + list(first.risks, 'pp-risk') +
      '<details><summary class="pp-note" style="cursor:pointer">The case for the ' + (fav === 'under' ? 'over' : 'under') + '</summary>' + list(second.why, 'pp-why') + '</details>', 'generated from structured data, deterministic');
  }
  /* the kernel's one reading of the matchup lead (EDProps.boardLead) */
  function leadOf(row, b) { return P().boardLead(b, row.r, row.pos, row.opp); }
  function hitsFor(row, b, PL, line, side) {
    var E = P(), lead = leadOf(row, b), posKey = ['RB', 'WR', 'TE'].indexOf(row.pos) >= 0 ? row.pos : 'WR';
    var leadKey = lead ? ((b.lead || {})[row.r.k] || '').replace('POS', posKey) : null;
    var similar = null;
    if (leadKey && b.matchups[row.opp] && b.matchups[row.opp][leadKey]) { var rk = b.matchups[row.opp][leadKey][0]; similar = Object.keys(b.matchups).filter(function (t) { return b.matchups[t][leadKey] && Math.abs(b.matchups[t][leadKey][0] - rk) <= 6; }); }
    var logs = PL.logs.map(function (l) { return { season: l.season, date: l.date, opp: l.opp, home: l.home === 1 ? true : l.home === 0 ? false : null, value: E.statOf(row.market, l), played: (l.snp == null || l.snp > 0) }; }).filter(function (x) { return x.value != null && x.played; });
    return E.hitRates(logs, line, side, { season: b.season, opp: row.opp, similar: similar });
  }
  function historySec(row, b, PL) {
    if (!row.r.p) return '';
    if (!PL) return sec('History', '<p class="pp-note">' + (S.players[S.league] && S.players[S.league].error ? 'Player history could not be loaded.' : 'Loading game logs…') + '</p>');
    var line = row.line != null ? row.line : (isNum(row.median) ? Math.floor(row.median) + 0.5 : null);
    if (line == null) return '';
    var side = row.cand ? row.cand.side : 'over', hr = hitsFor(row, b, PL, line, side);
    var cell = function (t, lbl) { return t && t.n ? '<td>' + t.hits + '/' + (t.n - t.pushes) + '</td><td>' + (t.pct != null ? pct(t.pct, 0) : '—') + '</td><td>' + n1(t.avg) + '</td>' : '<td colspan="3" class="pp-note">no games</td>'; };
    var body = '<table class="pp-t"><thead><tr><th>' + (side === 'over' ? 'Over ' : 'Under ') + line + '</th><th>Hits</th><th>Rate</th><th>Avg</th></tr></thead><tbody>' +
      [['Last 5', hr.L5], ['Last 10', hr.L10], ['This season', hr.season], ['Home', hr.home], ['Away', hr.away], ['vs ' + tl(row.opp), hr.vs_opp], ['vs similar defences', hr.similar]].map(function (x) { return '<tr><td>' + esc(x[0]) + '</td>' + cell(x[1]) + '</tr>'; }).join('') + '</tbody></table>' +
      '<p class="pp-note">' + esc(hr.label) + '. "Similar defences" rank within ±6 of ' + esc(tl(row.opp)) + ' on this market\'s lead metric.</p>';
    var recent = PL.logs.slice(-10).reverse();
    body += '<details><summary class="pp-note" style="cursor:pointer">Game log (last ' + recent.length + ')</summary><table class="pp-t"><thead><tr><th>Date</th><th>Opp</th><th>' + esc(row.md.short) + '</th><th>vs ' + line + '</th><th>Snaps</th></tr></thead><tbody>' +
      recent.map(function (l) { var v = P().statOf(row.market, l); return '<tr><td>' + esc(l.date) + '</td><td>' + (l.home === 0 ? '@' : '') + esc(l.opp) + '</td><td>' + (v == null ? '—' : v) + '</td><td>' + (v == null ? '—' : v > line ? '<span class="t-pos">O</span>' : v < line ? '<span class="t-neg">U</span>' : 'P') + '</td><td>' + (l.snp_pct != null ? pct(l.snp_pct, 0) : '—') + '</td></tr>'; }).join('') + '</tbody></table></details>';
    return sec('History', body, 'context only');
  }
  function usageSec(row, b, PL) {
    if (!PL || !row.r.p) return '';
    var cur = PL.logs.filter(function (l) { return l.season === b.season && (l.snp == null || l.snp > 0); }), l3 = cur.slice(-3);
    var avg = function (rs, f) { var v = rs.map(f).filter(isNum); return v.length ? v.reduce(function (a, x) { return a + x; }, 0) / v.length : null; };
    var sum = function (rs, f) { return rs.reduce(function (a, x) { var v = f(x); return a + (isNum(v) ? v : 0); }, 0); };
    var sh = (row.pl && row.pl.shares) || {}, caps = (b.sources && b.sources.caps) || {};
    var md = row.md, want = md.usage || [];
    var M = {
      snaps: ['Snaps / g', function (rs) { return avg(rs, function (l) { return l.snp; }); }],
      snap_pct: ['Snap share', function (rs) { var v = avg(rs, function (l) { return l.snp_pct; }); return v == null ? null : pct(v, 0); }],
      carries: ['Carries / g', function (rs) { return avg(rs, function (l) { return l.car; }); }],
      rush_share: ['Rush share', function (rs, k) { var v = sh.car ? (k === 'l3' ? sh.car.now : sh.car.season) : null; return v == null ? null : pct(v, 0); }],
      ypc: ['Yds / carry', function (rs) { var c = sum(rs, function (l) { return l.car; }); return c ? sum(rs, function (l) { return l.ryd; }) / c : null; }],
      rz_carries: ['RZ carries / g', function (rs) { return avg(rs, function (l) { return l.rz || 0; }); }],
      gl_carries: ['GL carries / g', function (rs) { return avg(rs, function (l) { return l.gl || 0; }); }],
      targets: ['Targets / g', function (rs) { return caps.targets === false ? null : avg(rs, function (l) { return l.tgt; }); }],
      target_share: [caps.targets === false ? 'Reception share' : 'Target share', function (rs, k) { var v = sh.tgt ? (k === 'l3' ? sh.tgt.now : sh.tgt.season) : null; return v == null ? null : pct(v, 0); }],
      receptions: ['Receptions / g', function (rs) { return avg(rs, function (l) { return l.rec; }); }],
      air_yards: ['Air yards / g', function (rs) { return caps.pbp === false ? null : avg(rs, function (l) { return l.ay; }); }],
      adot: ['aDOT', function (rs) { var t = sum(rs, function (l) { return l.tgt; }); return t && caps.pbp !== false ? sum(rs, function (l) { return l.ay; }) / t : null; }],
      rz_targets: ['RZ targets / g', function (rs) { return caps.pbp === false ? null : avg(rs, function (l) { return l.rzt || 0; }); }],
      routes: ['Routes', function () { return 'not in feed'; }], route_pct: ['Route %', function () { return 'not in feed'; }], yprr: ['Yds / route', function () { return 'not in feed'; }],
      att: ['Attempts / g', function (rs) { return avg(rs, function (l) { return l.att; }); }], cmp: ['Completions / g', function (rs) { return avg(rs, function (l) { return l.cmp; }); }],
      pass_yds: ['Pass yds / g', function (rs) { return avg(rs, function (l) { return l.pyd; }); }], dropbacks: ['Dropbacks / g', function (rs) { return caps.pbp === false ? null : avg(rs, function (l) { return l.db; }); }],
      ypa: ['Yds / att', function (rs) { var a = sum(rs, function (l) { return l.att; }); return a ? sum(rs, function (l) { return l.pyd; }) / a : null; }],
      sack_rate: ['Sack rate', function (rs) { var d = sum(rs, function (l) { return l.db; }); return d && caps.pbp !== false ? pct(sum(rs, function (l) { return l.sk; }) / d) : null; }],
      pressure_rate: ['Pressure rate', function (rs) { var d = sum(rs, function (l) { return l.db; }); var p = sum(rs, function (l) { return l.prs; }); return d && p ? pct(p / d) : null; }],
      rush_att: ['Rush att / g', function (rs) { return avg(rs, function (l) { return l.car; }); }], designed_runs: ['Designed runs / g', function (rs) { return caps.pbp === false ? null : avg(rs, function (l) { return l.dr || Math.max(0, (l.car || 0) - (l.scr || 0)); }); }],
      scramble_rate: ['Scramble rate', function (rs) { var d = sum(rs, function (l) { return l.db; }); return d && caps.pbp !== false ? pct(sum(rs, function (l) { return l.scr || 0; }) / d) : null; }]
    };
    var fmt = function (v) { return v == null ? '—' : typeof v === 'string' ? v : n1(v); };
    var rows = want.filter(function (k) { return M[k]; }).map(function (k) { return '<tr><td>' + esc(M[k][0]) + '</td><td>' + fmt(M[k][1](cur, 'season')) + '</td><td>' + fmt(M[k][1](l3, 'l3')) + '</td></tr>'; }).join('');
    if (!rows) return '';
    return sec('Usage', '<table class="pp-t"><thead><tr><th>Metric</th><th>Season</th><th>Last 3</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      (b.sources && b.sources.not_in_feed ? '<p class="pp-note">Not in any public feed EdgeDesk reads: ' + esc(b.sources.not_in_feed.join(', ')) + '.</p>' : ''), 'only what this market needs');
  }
  function matchupSec(row, b) {
    var kind = row.r.k, m = (b.matchups || {})[row.opp], defs = (b.matchup_rows || {})[kind];
    if (!m || !defs) return '';
    var posKey = ['RB', 'WR', 'TE'].indexOf(row.pos) >= 0 ? row.pos : 'WR';
    var rows = defs.map(function (d) { var k = d[0].replace('POS', posKey), x = m[k]; if (!x) return ''; var v = d[3] ? pct(x[2]) : (isNum(x[2]) ? x[2].toFixed(d[2]) : '—'); var weak = x[0] > x[1] * 2 / 3, strong = x[0] <= x[1] / 3;
      return '<tr><td>' + esc(d[1].replace('POS', posKey)) + '</td><td>' + v + '</td><td class="' + (weak ? 't-pos' : strong ? 't-neg' : '') + '">' + ordinal(x[0]) + ' of ' + x[1] + '</td></tr>'; }).join('');
    return sec('Matchup · ' + esc((b.team_names || {})[row.opp] || row.opp), '<table class="pp-t"><thead><tr><th>Opponent allows</th><th>Value</th><th>Rank</th></tr></thead><tbody>' + rows + '</tbody></table><p class="pp-note">Rank 1 = allows the least. Recency-weighted, shrunk toward the league for small samples — a rank, not a precise number.</p>');
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function gameSec(row, b) {
    var g = row.g, mk = g.market || {}, home = row.team === g.home, env = row.pl && row.pl.env;
    var teamLine = isNum(mk.home_margin) ? (home ? -mk.home_margin : mk.home_margin) : null;
    var w = g.weather;
    return sec('Game context', kv([['Spread (' + esc(tl(row.team)) + ')', teamLine != null ? (teamLine > 0 ? '+' : '') + teamLine : '—'], ['Total', mk.total != null ? mk.total : '—'],
      ['Implied pts', (home ? mk.home_implied : mk.away_implied) != null ? n1(home ? mk.home_implied : mk.away_implied) + ' <small>vs ' + n1(home ? mk.away_implied : mk.home_implied) + '</small>' : '—'],
      ['Script', env ? esc(env.script) : '—'], ['Pace', g.pace ? n1(home ? g.pace.home : g.pace.away) + ' <small>plays</small>' : '—'],
      ['Weather', w ? (w.dome ? 'Dome' : (isNum(w.temp_f) ? Math.round(w.temp_f) + '°F ' : '') + (isNum(w.wind_mph) ? Math.round(w.wind_mph) + ' mph' : '')) : '—']]) +
      '<p class="pp-note">' + esc(mk.source || '') + (g.edgedesk && isNum(g.edgedesk.total) ? ' · EdgeDesk fair total ' + n1(g.edgedesk.total) : '') + (g.venue ? ' · ' + esc(g.venue) : '') + (g.roof ? ' · ' + esc(g.roof) : '') + (g.surface ? ' · ' + esc(g.surface) : '') + '</p>');
  }
  function roleSec(row, PL) {
    var pl = row.pl; if (!pl) return '';
    var sh = pl.shares || {}, items = [];
    if (pl.depth_rank) items.push(['Depth chart', esc(row.pos) + pl.depth_rank]);
    if (sh.snaps) items.push(['Snap share', pct(sh.snaps.season, 0) + ' <small>L3 ' + pct(sh.snaps.now, 0) + '</small>']);
    if (sh.car && (sh.car.season || sh.car.projected > 0.02)) items.push(['Carry share', pct(sh.car.season, 0) + ' <small>L3 ' + pct(sh.car.now, 0) + ' → proj ' + pct(sh.car.projected, 0) + '</small>']);
    if (sh.tgt && (sh.tgt.season || sh.tgt.projected > 0.02)) items.push(['Target share', pct(sh.tgt.season, 0) + ' <small>L3 ' + pct(sh.tgt.now, 0) + ' → proj ' + pct(sh.tgt.projected, 0) + '</small>']);
    items.push(['Games (season)', pl.sample_games + (pl.prior_games ? ' <small>+' + pl.prior_games + ' prior</small>' : '')]);
    items.push(['Role stability', isNum(pl.role_stability) ? pct(pl.role_stability, 0) : '—']);
    var notes = [];
    (pl.teammates_out || []).forEach(function (t) { notes.push('<b>' + esc(t.name) + '</b> (' + esc(t.pos) + ') ' + esc(t.status) + ' → projected ' + esc(t.label) + ' +' + pct(t.delta) + ' <span class="pp-tag">projected adjustment</span>'); });
    if (pl.teammate_returned) notes.push('<b>' + esc(pl.teammate_returned.name) + '</b> is back after missing recent games (was ' + pct(pl.teammate_returned.share_before, 0) + ' share) <span class="pp-tag">projected: ' + esc(pl.teammate_returned.adjustment) + '</span>');
    if (pl.qb_change) notes.push('Starting QB change: ' + esc(pl.qb_change.from) + ' → ' + esc(pl.qb_change.to) + (pl.qb_change.confirmed ? '' : ' (unconfirmed)'));
    if (pl.status && pl.status.status) notes.push('Listed <b>' + esc(pl.status.status) + '</b>' + (pl.status.injury ? ' (' + esc(pl.status.injury) + ')' : '') + (pl.status.practice ? ' · ' + esc(pl.status.practice) : ''));
    else if (pl.status && pl.status.on_file === false) notes.push('No injury report for this game on file yet.');
    return sec('Role', kv(items) + (notes.length ? '<ul class="pp-list" style="margin-top:8px">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' : '') + '<p class="pp-note">Season and L3 are observed; "proj" and tagged lines are projected adjustments.</p>', 'observed vs projected');
  }
  function uncertaintySec(ev, row, b) {
    var cf = ev.confidence || {}, comp = cf.components || {}, W = cf.weights || {};
    var names = { sample: 'Sample depth', role: 'Role stability', data: 'Data completeness', market: 'Market depth', freshness: 'Price freshness', injury: 'Injury certainty', agreement: 'Model–market agreement', history: 'Model–history agreement', calibration: 'Calibration maturity' };
    var bars = Object.keys(names).map(function (k) { var v = comp[k]; return '<div style="display:grid;grid-template-columns:150px 1fr 38px;gap:8px;align-items:center;font-size:11px;margin:3px 0"><span class="pp-note" style="font-size:11px">' + names[k] + ' <span style="opacity:.7">×' + (W[k] || 0) + '</span></span><span class="pp-bar"><i style="width:' + Math.round(100 * (v || 0)) + '%"></i></span><span class="mono">' + (isNum(v) ? Math.round(100 * v) : '—') + '</span></div>'; }).join('');
    var flags = (row.flags || []).map(function (f) { return ({ NO_TARGETS_IN_FEED: 'college: no targets in the box — reception share used', NFL_PLAY_SHAPE: 'college: per-play yard shape borrowed from the NFL', NFL_CALIBRATION: 'college: distribution widths from the NFL backtest', UNMAPPED: 'book name not matched to one player' })[f] || f; });
    return sec('Uncertainty', '<p style="margin:0 0 6px;font-size:12px">Decision confidence <b>' + (cf.score != null ? cf.score : '—') + '</b> (' + esc(cf.label || '—') + ') — a data-quality score, not a win probability.</p>' + bars +
      (cf.notes && cf.notes.length ? '<p class="pp-note">' + esc(cf.notes.join(' · ')) + '</p>' : '') + (flags.length ? '<p class="pp-note">' + esc(flags.join(' · ')) + '</p>' : '') +
      '<p class="pp-note">Probability source: ' + esc(ev.probability_label) + '. Books quoting: ' + ev.consensus.n_books + ' (' + ev.consensus.n_two_sided + ' two-sided)' + (ev.consensus.dispersion ? ', line spread ' + ev.consensus.dispersion : '') + '.</p>');
  }
  /* a small bar chart of the projected outcome distribution with the line */
  function drawDist() {
    var cv = $('ppDist'); if (!cv || !cv.getContext || !S._drawerEval || !S._drawerEval._dist) return;
    var E = P(), d = S._drawerEval._dist.informed, sm = E.summary(d); if (!sm) return;
    var lo = Math.max(E.quantile(d, 0.005), d.family === 'normal' ? -Infinity : -10), hi = E.quantile(d, 0.995);
    if (!isFinite(lo)) lo = Math.floor(sm.mean - 3 * sm.sd);
    var n = hi - lo + 1, bins = Math.min(60, n), w = Math.ceil(n / bins), vals = [], i, k;
    for (i = 0; i < bins; i++) { var a = lo + i * w, s = 0; for (k = a; k < a + w; k++) s += E.pmfInt(d, k); vals.push([a, s]); }
    var ctx = cv.getContext('2d'), W2 = cv.width, H = cv.height, mx = Math.max.apply(null, vals.map(function (v) { return v[1]; })) || 1;
    ctx.clearRect(0, 0, W2, H);
    var line = S._drawerEval.consensus.line;
    vals.forEach(function (v, j) { var x = j * W2 / bins, h2 = (H - 14) * v[1] / mx; ctx.fillStyle = line != null && v[0] + w - 1 > line ? 'rgba(118,189,62,.55)' : 'rgba(170,156,135,.45)'; ctx.fillRect(x + 1, H - 12 - h2, W2 / bins - 2, h2); });
    if (line != null) { var lx = (line - lo) / (n) * W2; ctx.strokeStyle = '#e3b84d'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lx, 0); ctx.lineTo(lx, H - 12); ctx.stroke(); }
    ctx.fillStyle = '#958a7a'; ctx.font = '10px JetBrains Mono, monospace'; ctx.fillText(String(lo), 2, H - 1); ctx.fillText(String(hi), W2 - 24, H - 1);
    if (line != null) ctx.fillText('line ' + line, Math.min(W2 - 60, Math.max(2, (line - lo) / n * W2 + 4)), 10);
  }
  function customPrice() {
    var E = P(), ev = S._drawerEval; if (!ev || !ev._dist) return;
    var side = $('ppCSide').value, line = Number($('ppCLine').value), am = Number($('ppCPrice').value), out = $('ppCOut');
    var pr = E.probLine(ev._dist.informed, line);
    if (!pr || !isFinite(line)) { out.textContent = 'enter a line'; return; }
    var win = side === 'over' ? pr.over : pr.under, push = pr.push || 0;
    var txt = 'P ' + pct(win / Math.max(1e-9, 1 - push)) + (push > 0.0005 ? ' (push ' + pct(push) + ')' : '') + ' · fair ' + price(E.fairAmerican(win, push));
    if (E.validPrice(am)) txt += ' · EV ' + spct(E.expectedValue(win, am, push)) + ' at ' + price(am);
    out.textContent = txt;
  }

  /* ================================================================ PERFORMANCE */
  function perfHTML(b) {
    var j = S.perf[S.league];
    if (!j) { loadPerf(S.league); return '<div class="pp-pane" style="padding:12px">' + skelRows(4) + '</div>'; }
    var h = '<div class="pp-perf">';
    if (j.error) h += '<div class="pp-empty"><b>No graded props yet.</b>The record starts once captured prices have been evaluated and their games have finished. Nothing is shown until a real prop has been settled.</div>';
    else {
      var s = j.summary || {}, cal = j.calibration || {};
      h += '<p class="pp-note">' + esc(j.note || '') + ' Built ' + esc(ago(j.generated_at)) + '.</p>';
      h += '<div class="pp-kpis">' + [['Bets', s.n], ['W-L-P', (s.wins || 0) + '-' + (s.losses || 0) + '-' + (s.pushes || 0)], ['Units', isNum(s.units) ? (s.units >= 0 ? '+' : '') + s.units.toFixed(2) : '—'], ['ROI', isNum(s.roi) ? spct(s.roi) : '—'],
        ['Avg EV', isNum(s.avg_ev) ? spct(s.avg_ev) : '—'], ['CLV (prob)', isNum(s.avg_prob_clv_pp) ? pp(s.avg_prob_clv_pp) + ' pp' : '—'], ['Beat close', isNum(s.beat_close_rate) ? pct(s.beat_close_rate, 0) : '—'], ['Sample', s.sample ? esc(s.sample.label) : '—']]
        .map(function (k) { return '<div class="pp-kpi"><div class="n">' + (k[1] == null ? '—' : k[1]) + '</div><div class="l">' + k[0] + '</div></div>'; }).join('') + '</div>';
      h += '<h3>Calibration — predicted vs observed</h3>' + calTable(cal) + '<p class="pp-note">Every priced prop\'s final pregame probability, folded so each row reads ≥ 50%. Brier ' + (cal.brier != null ? cal.brier : '—') + ' · ECE ' + (cal.ece != null ? cal.ece : '—') + ' · n ' + (cal.n || 0) + ' (' + esc(cal.sample ? cal.sample.label : '') + '). Probability source: ' + esc(j.calibration_state ? j.calibration_state.state : '—') + '.</p>';
      ['market', 'position', 'ev_bucket', 'confidence_bucket', 'decision'].forEach(function (k) { if (j.breakdown && j.breakdown[k] && j.breakdown[k].length) h += '<h3>By ' + k.replace('_', ' ') + '</h3>' + brTable(j.breakdown[k]); });
    }
    if (b && b.calibration) {
      h += '<h3>Distribution backtest (' + esc(b.calibration.mode) + ', ' + esc(b.calibration.season_tested) + (b.calibration.borrowed ? ', NFL — borrowed by college' : '') + ')</h3>' +
        '<p class="pp-note">Walk-forward: every player projected with data strictly before each week, scored against the realised stat. It proves whether the distributions are honest about outcomes — not that EdgeDesk beats a price (no historical prop prices exist). ' + (b.calibration.n_scored ? b.calibration.n_scored.toLocaleString() + ' player-games scored.' : '') + '</p>' +
        '<div class="pp-tw"><table class="pp-t"><thead><tr><th>Market</th><th>n</th><th>IQR coverage (50%)</th><th>ECE</th><th>Variance ×</th><th>Mean ×</th><th>Adopted</th></tr></thead><tbody>' +
        Object.keys(b.calibration.markets).sort().map(function (k) { var c = b.calibration.markets[k]; return '<tr><td>' + esc((P().MARKETS[k] || {}).label || k) + '</td><td>' + c.n + '</td><td>' + (c.cover50 != null ? pct(c.cover50) : '—') + '</td><td>' + (c.ece != null ? c.ece : '—') + '</td><td>' + c.f + '</td><td>' + c.mean_mult + '</td><td>' + (c.adopted ? 'yes' : 'no — raw held out better') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }
    return h + '</div>';
  }
  function calTable(cal) {
    var t = cal.table || [];
    return '<div class="pp-tw"><table class="pp-t"><thead><tr><th>Predicted</th><th>n</th><th>Expected</th><th>Observed</th><th>Gap</th></tr></thead><tbody>' +
      t.map(function (r) { return '<tr><td>' + esc(r.bucket) + '</td><td>' + r.n + '</td><td>' + (r.expected != null ? pct(r.expected) : '—') + '</td><td>' + (r.observed != null ? pct(r.observed) : '—') + '</td><td class="' + (r.gap_pp == null ? '' : Math.abs(r.gap_pp) <= 3 ? 't-pos' : 't-mod') + '">' + (r.gap_pp != null ? pp(r.gap_pp) + ' pp' : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function brTable(rows) {
    return '<div class="pp-tw"><table class="pp-t"><thead><tr><th>Group</th><th>Bets</th><th>W-L-P</th><th>Units</th><th>ROI</th><th>Avg EV</th><th>CLV pp</th><th>Sample</th></tr></thead><tbody>' +
      rows.map(function (r) { return '<tr><td>' + esc(r.key) + '</td><td>' + r.n + '</td><td>' + r.wins + '-' + r.losses + '-' + r.pushes + '</td><td class="' + (r.units > 0 ? 't-pos' : r.units < 0 ? 't-neg' : '') + '">' + (r.units >= 0 ? '+' : '') + r.units + '</td><td>' + (r.roi != null ? spct(r.roi) : '—') + '</td><td>' + (r.avg_ev != null ? spct(r.avg_ev) : '—') + '</td><td>' + (r.avg_prob_clv_pp != null ? pp(r.avg_prob_clv_pp) : '—') + '</td><td>' + esc(r.sample ? r.sample.label : '') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ================================================================ EVENTS */
  function onClick(ev) {
    var t = ev.target.closest ? ev.target.closest('[data-pp-act]') : null;
    if (!t || !S.host || !S.host.contains(t)) return;
    var a = t.getAttribute('data-pp-act'), v = t.getAttribute('data-v');
    if (a === 'star') { ev.stopPropagation(); ev.preventDefault(); var kind = t.getAttribute('data-kind'); toggleWatch(kind, v, S.league, null); return; }
    switch (a) {
      case 'league': if (S.league !== v) { S.league = v; S.game = null; S.player = null; S.cat = 'all'; S.market = null; S.drawer = null; S.cardsShown = PAGE; S.team = ''; S.book = ''; saveView(); load(v); render(); setHash(); } return;
      case 'mode': S.mode = v; S.cardsShown = PAGE; if (v === 'perf') loadPerf(S.league); saveView(); render(); return;
      case 'refresh': S.perf[S.league] = null; S.players[S.league] = null; S.players[S.league + '_loading'] = false; load(S.league, true); return;
      case 'retry': load(S.league, true); return;
      case 'game': if (v && S.game === v) { S.expanded[v] = !S.expanded[v]; } else { S.game = v || null; S.player = null; if (v) S.expanded[v] = true; } S.cardsShown = PAGE; render(); setHash(); return;
      case 'player': S.player = S.player === v ? null : v; render(); setHash(); return;
      case 'gtab': S.gtab = v; render(); return;
      case 'collapse': S.sideCollapsed = !S.sideCollapsed; render(); return;
      case 'cat': S.cat = v; S.market = null; render(); return;
      case 'market': S.market = v || null; render(); return;
      case 'flt': { var k = t.getAttribute('data-k'), val = v === '' ? null : (v === 'plus' ? 'plus' : Number(v)); S[k] = S[k] === val ? null : val; saveView(); render(); return; }
      case 'side': S.side = v; saveView(); render(); return;
      case 'sort': S.sort = v; saveView(); render(); return;
      case 'reset': S.minEv = S.minConf = S.minSample = S.minEdge = S.price = null; S.side = 'all'; S.search = ''; S.team = ''; S.pos = ''; S.book = ''; S.cat = 'all'; S.market = null; S.player = null; S.date = 'week'; saveView(); render(); return;
      case 'more': S.cardsShown += PAGE; render(); return;
      case 'filters': ev.preventDefault && ev.preventDefault(); S.filtersOpen = !S.filtersOpen; render(); return;
      case 'open': S.drawer = v; render(); setHash(); return;
      case 'close': S.drawer = null; render(); setHash(); return;
      case 'custom': customPrice(); return;
      case 'bankroll': try { if (root.EDDecisionUI && root.EDDecisionUI.openBankroll) root.EDDecisionUI.openBankroll(); } catch (e) { /* no bankroll panel */ } return;
    }
  }
  function onKey(ev) {
    if (!S.host) return;
    var t = ev.target;
    if ((ev.key === 'Enter' || ev.key === ' ') && t && t.getAttribute && t.getAttribute('data-pp-act') && (t.classList.contains('pp-row') || t.classList.contains('pp-star'))) { ev.preventDefault(); onClick({ target: t, stopPropagation: function () {}, preventDefault: function () {} }); }
    if (ev.key === 'Escape' && S.drawer) { S.drawer = null; render(); setHash(); }
  }
  var inputTimer = null;
  function onInput(ev) {
    var t = ev.target; if (!t || !S.host || !S.host.contains(t)) return;
    if (t.id === 'ppSearch' || t.id === 'ppGSearch') {
      var k = t.id === 'ppSearch' ? 'search' : 'gsearch', pos = t.selectionStart;
      S[k] = t.value; clearTimeout(inputTimer);
      inputTimer = setTimeout(function () { render(); var el = $(t.id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } } }, 180);
      return;
    }
    var set = t.getAttribute && t.getAttribute('data-pp-set');
    if (set) { S[set] = t.value; if (set === 'date' && t.value !== 'custom') S.dateCustom = ''; saveView(); render(); }
  }

  /* ================================================================ PLAYER
     #playerprops/<league>/player/<id> (and /players/<league>/<id>, which
     404.html routes here): who he is on this board — role, usage, status,
     game environment and recent production — above every prop he has. All
     read from the board's player context and players.json; nothing new is
     computed. */
  var LOG_COLS = {
    QB: [['att', 'Att'], ['cmp', 'Cmp'], ['pyd', 'Pass yds'], ['ptd', 'Pass TD'], ['int', 'INT'], ['car', 'Car'], ['ryd', 'Rush yds']],
    RB: [['car', 'Car'], ['ryd', 'Rush yds'], ['rtd', 'Rush TD'], ['tgt', 'Tgt'], ['rec', 'Rec'], ['yd', 'Rec yds']],
    WR: [['tgt', 'Tgt'], ['rec', 'Rec'], ['yd', 'Rec yds'], ['td', 'Rec TD'], ['lng', 'Long']],
    K: [['fgm', 'FG'], ['fga', 'FGA'], ['xpm', 'XP']]
  };
  function shareText(sh, lbl) { return sh && isNum(sh.now) ? lbl + ' ' + pct(sh.now, 0) + (isNum(sh.season) ? ' (season ' + pct(sh.season, 0) + ')' : '') + (isNum(sh.projected) ? ' · projected ' + pct(sh.projected, 0) : '') : null; }
  function playerHTML(b) {
    if (!S.player || !b) return '';
    var rs = (b.props || []).filter(function (r) { return r.p === S.player; });
    var clear = '<button class="pp-btn ghost" data-pp-act="player" data-v="' + esc(S.player) + '">× All players</button>';
    if (!rs.length) return '<div class="pp-empty pp-player"><b>This player has no props on the current ' + (S.league === 'cfb' ? 'college' : 'NFL') + ' board.</b>He may be outside this week\'s games, or the link is out of date. ' + clear + '</div>';
    var pl = ctxOf(b, rs[0]) || {}, g = b._games[rs[0].g] || {};
    if (!S.players[S.league]) loadPlayers(S.league);
    var sh = pl.shares || {}, env = pl.env || {};
    var facts = [
      ['Game', esc(tl(pl.team)) + (g.home === pl.team ? ' vs ' : ' @ ') + esc(tl(pl.opp)) + ' · ' + esc(clock(g.kickoff))],
      ['Status', pl.status && pl.status.status ? esc(pl.status.status) + (pl.status.practice ? ' · ' + esc(pl.status.practice) : '') : 'No designation on file'],
      ['Role', (isNum(pl.depth_rank) ? 'Depth ' + pl.depth_rank + ' · ' : '') + (isNum(pl.sample_games) ? pl.sample_games + ' game' + (pl.sample_games === 1 ? '' : 's') + ' this season' : '') + (isNum(pl.role_stability) ? ' · role stability ' + pct(pl.role_stability, 0) : '')],
      ['Usage', [shareText(sh.snaps, 'Snaps'), shareText(sh.car, 'Carries'), shareText(sh.tgt, b.sources && b.sources.caps && b.sources.caps.targets === false ? 'Receptions' : 'Targets')].filter(Boolean).map(esc).join('<br>') || '—'],
      ['Environment', isNum(env.implied) ? 'Team total ' + env.implied + (isNum(env.total) ? ' of ' + env.total : '') + (env.script ? ' · ' + esc(env.script) : '') + (env.dome ? ' · dome' : isNum(env.wind) ? ' · wind ' + Math.round(env.wind) + ' mph' : '') : '—']
    ];
    if (pl.teammates_out && pl.teammates_out.length) facts.push(['Teammates out', pl.teammates_out.map(function (t) { return esc(t.name + ' (' + (t.status || 'out') + ')' + (isNum(t.delta) ? ': +' + pct(t.delta) + ' ' + (t.label || 'share') + ' to him' : '')); }).join('<br>')]);
    var PL = playerLogs(S.player), log = '';
    if (PL && PL.logs.length) {
      var cols = LOG_COLS[pl.pos] || LOG_COLS[pl.pos === 'TE' ? 'WR' : pl.pos === 'FB' ? 'RB' : 'WR'];
      var recent = PL.logs.slice(-6).reverse();
      log = '<div class="pp-tw"><table class="pp-t"><thead><tr><th>Date</th><th>Opp</th>' + cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '<th>Snaps</th></tr></thead><tbody>' +
        recent.map(function (l) { return '<tr><td>' + esc(l.date) + '</td><td>' + (l.home === 0 ? '@' : '') + esc(l.opp) + '</td>' + cols.map(function (c) { return '<td>' + (l[c[0]] == null ? '—' : esc(l[c[0]])) + '</td>'; }).join('') + '<td>' + (l.snp_pct != null ? pct(l.snp_pct, 0) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    } else log = '<p class="pp-note">' + (S.players[S.league] && S.players[S.league].error ? 'Game logs could not be loaded.' : PL ? 'No game logs on file.' : 'Loading game logs…') + '</p>';
    var priced = rs.filter(function (r) { return r.q && r.q.length; }).length;
    return '<section class="pp-player"><div class="pp-dh"><div class="who"><h3>' + esc(pl.name || '—') + ' <span class="pp-tag">' + esc(pl.pos || '') + '</span>' + injChip(pl) + '</h3><p>' + rs.length + ' prop' + (rs.length === 1 ? '' : 's') + ' on the board · ' + priced + ' priced by a sportsbook</p></div>' + clear + '</div>' +
      kv(facts) + '<h4 class="pp-subh">Recent games</h4>' + log + '<p class="pp-note">Context, not the model: the projections below already carry this usage and environment. Research, not picks.</p></section>';
  }

  /* ============================================================ GAME CARDS
     PLAYER PROP RESEARCH on a matchup: the NFL and FBS game cards in the app
     and the canonical CFB research page (research/cfb/). It is never left
     out: it opens on the league's small summary (football/props/<lg>/
     summary.json) and always says which state the game is in —
       A  research-grade props: the best (up to 4) in full, View all N props
       B  props evaluated, none meet the research threshold
       C  sportsbooks have not released the player markets
       D  PLAYER PROP PRICING UNAVAILABLE (the capture failed, or is off)
       E  outside the prop capture window (or not on the board yet)
     The 1-2 MB board loads only on request ("Load player props"), and then
     the same header re-prices every priced prop with the page's boardEval:
     the leads, the QB / RB / WR-TE / TD groups and the headline projections.
     opts.kickoff lets a game the board does not carry say why;
     opts.inline === false (a page without the board) never loads it. */
  function gameSection(lg, gid, lazy, opts) {
    opts = opts || {};
    var id = String(gid == null ? '' : gid), b = BOARD_DONE[lg], inline = opts.inline !== false, ko = ms(opts.kickoff);
    var inner = b && inline ? gameSectionInner(lg, b, id, opts) : summarySectionInner(lg, id, opts);
    if (!b && !lazy && inline) fetchBoard(lg).then(fillGameSections, function () { fillGameSections(null, lg); });
    return '<div class="pp pp-gsec" data-pp-gsec="' + esc(lg + '|' + id) + '"' + (ko != null ? ' data-pp-ko="' + esc(new Date(ko).toISOString()) + '"' : '') + (inline ? '' : ' data-pp-inline="0"') + '>' + inner + '</div>';
  }
  function secOpts(x) { return { kickoff: x.getAttribute('data-pp-ko') || null, inline: x.getAttribute('data-pp-inline') !== '0' }; }
  function wake(el) {
    var els = el && el.querySelectorAll ? [].slice.call(el.querySelectorAll('[data-pp-gsec]')) : [];
    if (el && el.getAttribute && el.getAttribute('data-pp-gsec')) els.push(el);
    els.forEach(function (x) {
      var k = x.getAttribute('data-pp-gsec').split('|'), lg = k[0], o = secOpts(x);
      if (!o.inline) return;
      if (BOARD_DONE[lg]) { x.innerHTML = gameSectionInner(lg, BOARD_DONE[lg], k.slice(1).join('|'), o); return; }
      x.innerHTML = '<p class="pp-note">Loading player props…</p>';
      fetchBoard(lg).then(fillGameSections, function () { fillGameSections(null, lg); });
    });
  }
  function fillGameSections(_, failedLg) {
    var doc = root.document; if (!doc || !doc.querySelectorAll) return;
    var els = doc.querySelectorAll('[data-pp-gsec]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-pp-gsec').split('|'), lg = k[0], b = BOARD_DONE[lg], o = secOpts(els[i]);
      if (b && o.inline) els[i].innerHTML = gameSectionInner(lg, b, k.slice(1).join('|'), o);
      else { o.boardFailed = failedLg === lg; els[i].innerHTML = summarySectionInner(lg, k.slice(1).join('|'), o); }
    }
  }
  /* the board carries games kicking off inside this many days
     (football/props/build_board.js: opts.days || (nfl ? 8 : 7)) */
  var BOARD_DAYS = { nfl: 8, cfb: 7 }, SEC_TOP = 4, SUM_WAIT = {};
  function secHead(lg, ev) {
    return '<div class="pp-rsec-h"><b>PLAYER PROP RESEARCH</b><span class="pp-note">' + (lg === 'cfb' ? 'College' : 'NFL') + (ev ? ' · ' + esc((ev.away_name || ev.away) + ' @ ' + (ev.home_name || ev.home)) : '') + '</span></div>';
  }
  function secState(label, text, warn) { return '<div class="pp-pstate' + (warn ? ' warn' : '') + '"><b>' + esc(label) + '</b><p class="pp-note">' + esc(text) + '</p></div>'; }
  function secBtn(label, js, cls) { return '<button type="button" class="pp-btn' + (cls ? ' ' + cls : '') + '" onclick="' + esc(js) + '">' + esc(label) + '</button>'; }
  function goJs(lg, gid) { return 'EDPropsUI.go(' + JSON.stringify({ league: lg, game: String(gid) }) + ')'; }
  var WAKE_JS = 'EDPropsUI.wake(this.closest(\'[data-pp-gsec]\'))';
  /* the summary-first section: states A-E from the event summary */
  function summarySectionInner(lg, gid, o) {
    o = o || {};
    var X = O(), sum = S.summaries[lg], inline = o.inline !== false, t = now();
    var load = inline ? secBtn('Load player props', WAKE_JS, 'ghost') : '';
    if (!X) return secHead(lg, null) + secState('Player prop research unavailable', 'The player-prop research layer (lib/edgedesk_opportunity.js) did not load on this page, so no prop state can be read. Nothing is shown in its place.', true);
    if (!sum) {
      if (!SUM_WAIT[lg]) { SUM_WAIT[lg] = 1; loadSummary(lg).then(function () { SUM_WAIT[lg] = 0; fillGameSections(); }, function () { SUM_WAIT[lg] = 0; fillGameSections(); }); }
      return secHead(lg, null) + '<p class="pp-note">Loading player-prop research…</p>';
    }
    if (sum.error) return secHead(lg, null) + secState('Player prop research unavailable', 'The player-prop summary (football/props/' + lg + '/summary.json) could not be loaded, so EdgeDesk cannot say what the sportsbooks are offering for this game. Nothing is shown in its place.', true)
      + '<div class="pp-rc-acts">' + (load || secBtn('Open Player Props', goJs(lg, gid), 'ghost')) + '</div>';
    var ev = null; try { ev = X.eventFromSummary(sum, gid, t); } catch (e) { ev = null; }
    var foot = o.boardFailed ? '<p class="pp-note">The full player-prop board could not be loaded; this section reads the summary.</p>' : '';
    if (!ev) return secHead(lg, null) + missingHTML(lg, gid, sum, o, t) + foot;
    var h = secHead(lg, ev), live = (ev.top_opportunities || []).filter(function (x) { return x.research && x.research.grade; });
    var st = (ev.capture && ev.capture.state) || 'PRICED';
    var viewProj = ev.projected_props ? secBtn('View projections', goJs(lg, gid), 'ghost') : '';
    if (live.length) {
      var count = live.length + (ev.more || 0);
      h += '<div class="pp-rsec-h sub"><b>TOP PROP OPPORTUNITIES</b><span class="n">' + count + '</span></div>'
        + live.slice(0, SEC_TOP).map(function (x) { return researchCardHTML(x, { why: 4, concerns: 3 }); }).join('')
        + '<div class="pp-rc-acts">' + secBtn('View all ' + (ev.total_props || count) + ' props', goJs(lg, gid), 'acc pp-rsec-all') + load + '</div>'
        + '<p class="pp-note">' + esc(ev.evaluated_props + ' props evaluated · ' + count + ' meet EdgeDesk’s research threshold. ' + (live[0].probability_label ? live[0].probability_label + '. ' : '') + 'Research score orders what to read first; it is not a bet grade. Research, not picks.') + '</p>';
    } else if (st === 'PRICED') {
      h += evaluatedHTML(X.evaluatedCount(ev), ev.stale_now || X.pricedNotEvaluated(ev) ? X.emptyText(ev) : '') + '<div class="pp-rc-acts">' + secBtn('View all props', goJs(lg, gid), 'acc') + load + '</div>';
    } else h += unpricedHTML(ev, sum) + '<div class="pp-rc-acts">' + viewProj + load + '</div>';
    return h + foot + '<div class="pp-gfoot"><span class="pp-note">' + esc((ev.total_props || 0) + ' props on the board · ' + (ev.priced_props || 0) + ' priced · ' + (ev.evaluated_props || 0) + ' evaluated · ' + (ev.research_grade_now || 0) + ' research grade. Summary built ' + clock(sum.generated_at) + '.') + '</span></div>';
  }
  /* B: priced and evaluated, nothing clears the research threshold */
  function evaluatedHTML(n, pre) {
    return secState(n + ' prop' + (n === 1 ? '' : 's') + ' evaluated', (pre ? pre + ' ' : '') + 'No player props currently meet EdgeDesk’s research threshold. This is a valid result.');
  }
  /* C / D / E: why no sportsbook price, from the event's capture state */
  function unpricedHTML(ev, sum) {
    var X = O(), cs = ev.capture || {}, st = cs.state, text = cs.text || (X ? X.emptyText(ev) : '');
    if (st === 'NOT_RELEASED') return secState('Sportsbook prop markets not released', text);
    if (st === 'CAPTURE_FAILED' || st === 'CAPTURE_OFF') return secState('PLAYER PROP PRICING UNAVAILABLE', text, true);
    /* NOT_CAPTURED_YET: outside the window at the last capture, or inside it and not yet reached */
    var ko = ms(ev.kickoff), cap = (sum && sum.capture) || {}, at = ms(cap.last_run || cap.last_success_at) || ms(sum && sum.generated_at), wh = cs.window_h || cap.window_h || 96;
    return secState(ko == null || at == null || ko - at > wh * 3600e3 ? 'Outside the prop capture window' : 'Prices not captured yet', text);
  }
  /* a game the board does not carry: say why, never go quiet */
  function missingHTML(lg, gid, sum, o, t) {
    var ko = ms(o.kickoff), built = ms(sum.generated_at), days = BOARD_DAYS[lg] || 7, wh = (sum.capture && sum.capture.window_h) || 96;
    var name = lg === 'cfb' ? 'college' : 'NFL';
    if (ko != null && ko <= t) return secState('Player props closed', 'This game has kicked off: pregame player props are closed and it has left the ' + name + ' player-prop board.');
    if (ko != null && built != null && ko > built + days * 864e5) return secState('Outside the prop capture window', 'This game is not on the ' + name + ' player-prop board yet: the board carries games kicking off within ' + days + ' days, and sportsbook prices are captured inside ' + wh + ' hours of kickoff. It joins a later build.')
      + '<div class="pp-rc-acts">' + secBtn('Open Player Props', 'EDPropsUI.go(' + JSON.stringify({ league: lg }) + ')', 'ghost') + '</div>';
    return secState('Not on the player-prop board', 'This game is not on the current ' + name + ' player-prop board, so EdgeDesk has no player-prop projections or prices for it.' + (lg === 'cfb' ? ' The college board covers FBS-vs-FBS games inside ' + days + ' days of kickoff.' : ''))
      + '<div class="pp-rc-acts">' + secBtn('Open Player Props', 'EDPropsUI.go(' + JSON.stringify({ league: lg }) + ')', 'ghost') + '</div>';
  }
  /* ============================================== PROP RESEARCH SURFACES
     The renderers every research surface shares — the Research board's
     game cards, the desk's Top Research Priorities, the TOP PLAYER PROP
     RESEARCH module and a matchup's PLAYER PROP RESEARCH section — over
     EDOpportunity objects (lib/edgedesk_opportunity.js). One renderer, so a
     prop reads the same wherever it appears. Research, not picks. */
  function O() { return root.EDOpportunity || null; }
  S.opps = {};
  function reg(o) { if (o && o.id) S.opps[o.id] = o; return o; }
  function onCard(o) {
    var U = root.EDDecisionUI;
    try { return !!(o && (U && U.onCard ? U.onCard(o.key) : deviceCard().some(function (e) { return e.key === o.key; }))); } catch (e) { return false; }
  }
  /* A PAGE WITHOUT THE CARD'S UI (research/cfb/): Add to Card writes the same
     frozen snapshot (EDOpportunity.cardEntry) into the same device Card the
     app reads (lib/edgedesk_decision_ui.js KEYS.opps), under the same rules
     (one entry per prop, none once the game has started). pending_upload asks
     the app to send it to public.card_opportunities when the reader is signed
     in there (EDDecisionUI's loadRemoteEntries). */
  var CARD_KEY = 'edgedesk_card_opportunities_v1';
  function deviceCard() { return (lsGet(CARD_KEY, []) || []).filter(function (e) { return e && e.entry_id && e.key && e.status !== 'removed'; }); }
  function deviceAdd(o) {
    var X = O(); if (!X || !o || !o.key) return null;
    var ko = ms(o.event && o.event.kickoff);
    if (ko != null && ko <= Date.now()) return { added: false, reason: 'The game has started' };
    var have = deviceCard().filter(function (e) { return e.key === o.key; })[0];
    if (have) return { added: false, reason: 'Already on your Card', entry: have };
    var e = JSON.parse(JSON.stringify(X.cardEntry(o, { now: Date.now() })));
    e.pending_upload = true;
    var raw = lsGet(CARD_KEY, []) || []; raw.push(e); lsSet(CARD_KEY, raw);
    return { added: true, entry: e };
  }
  function ageText(m) { return isNum(m) ? (m < 60 ? Math.round(m) + ' min' : (m / 60).toFixed(m < 600 ? 1 : 0) + ' h') : '—'; }
  function oppActs(o, opts) {
    opts = opts || {};
    var lg = o.league, a = function (label, js, cls) { return '<button type="button" class="pp-btn' + (cls ? ' ' + cls : '') + '" onclick="' + esc(js) + '">' + label + '</button>'; };
    var go = function (x) { return 'EDPropsUI.go(' + JSON.stringify(x) + ')'; };
    return '<div class="pp-rc-acts">' + a('Research prop', go({ league: lg, prop: o.prop_id }), 'acc')
      + (onCard(o) ? '<span class="pp-oncard">On your Card</span>' : a('Add to Card', 'EDPropsUI.addToCard(' + JSON.stringify(o.id) + ',this)'))
      + (opts.compare === false ? '' : a('Compare books', go({ league: lg, prop: o.prop_id }), 'ghost'))
      + (o.player && o.player.id ? a('View player', go({ league: lg, player: o.player.id }), 'ghost') : '') + '</div>';
  }
  function kvRC(items) { return '<div class="pp-rc-g">' + items.filter(Boolean).map(function (x) { return '<span><span class="k">' + esc(x[0]) + '</span><span class="v' + (x[2] ? ' ' + x[2] : '') + '">' + x[1] + '</span></span>'; }).join('') + '</div>'; }
  /* one research candidate: the numbers, why, concerns and the four actions */
  function researchCardHTML(o, opts) {
    opts = opts || {};
    if (!o || o.type !== 'PLAYER_PROP') return '';
    reg(o);
    var pl = o.player || {}, pr = o.price || {}, m = o.model || {}, ex = o.explanation || {};
    var tn = o.league === 'nfl' ? pl.team : (o.event && (o.event.home === pl.team ? o.event.home_name : o.event.away_name)) || pl.team;
    var stage = o.stage && o.stage !== 'PRODUCTION' ? ' ' + stageTag(o.stage, true) : '';
    var nWhy = opts.why == null ? 3 : opts.why, nCon = opts.concerns == null ? 2 : opts.concerns;
    var why = (ex.why || []).slice(0, nWhy), con = (ex.concerns || []).filter(function (t) { return !/^Probability source/.test(t); }).slice(0, nCon);
    return '<div class="pp-rc' + (o.stale ? ' stale' : '') + '">'
      + '<div class="pp-rc-h"><b>' + esc(pl.name || '—') + '</b> <span class="pp-note">' + esc([pl.position, tn].filter(Boolean).join(' · ')) + '</span>'
      + (pl.status ? ' <span class="pp-tag pp-inj' + (pl.status === 'OUT' ? ' out' : '') + '">' + esc(pl.status) + '</span>' : '')
      + '<span class="pp-grow"></span><span class="pp-dec ' + esc(o.tone) + '">' + esc(o.decision_label) + (o.decision === 'BET' && o.units ? ' · ' + esc(unitsFmt(o.units)) : '') + '</span>' + stage + '</div>'
      + '<div class="pp-rc-sel">' + esc(o.selection ? o.selection.text : o.market.label) + '</div>'
      + kvRC([
        o.market.yesno ? null : ['EdgeDesk projection', m.projection ? n1(m.projection.mean) : '—'],
        o.market.yesno ? null : ['Market line', o.market_view && isNum(o.market_view.consensus_line) ? String(o.market_view.consensus_line) : (o.selection ? String(o.selection.line) : '—')],
        ['Best price', pr.american != null ? esc(price(pr.american)) + ' <small>' + esc(abbr(pr.book)) + '</small>' : '—'],
        ['Fair probability', pct(m.probability)], ['Break-even', pct(o.break_even)],
        ['EV', spct(o.ev), evTone(o.ev)], ['Edge', isNum(o.edge_pp) ? pp(o.edge_pp) + ' pp' : '—', evTone(o.ev)],
        ['Confidence', isNum(o.confidence) ? String(o.confidence) : '—'],
        ['Books at line', isNum(pr.books_at_line) ? String(pr.books_at_line) : '—'],
        ['Quote age', esc(ageText(pr.age_minutes)) + (o.stale ? ' <b class="t-mod">stale</b>' : '')],
        ['Research score', o.research ? String(Math.round(o.research.score)) : '—']
      ])
      + (why.length ? '<div class="pp-rc-x"><b>Why</b><ul class="pp-list pp-why">' + why.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '')
      + (con.length ? '<div class="pp-rc-x"><b>Concerns</b><ul class="pp-list pp-risk">' + con.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '')
      + oppActs(o, opts) + '</div>';
  }
  function unitsFmt(u) { return isNum(u) ? (Math.round(u * 100) / 100).toFixed(2) + 'U' : '—'; }
  /* PLAYER PROPS TO RESEARCH — the 2-4 best candidates for one game, from
     the event summary (EDOpportunity.eventFromSummary); every empty state
     says what actually happened */
  function eventSectionHTML(ev, opts) {
    opts = opts || {};
    var E = O(); if (!E) return '';
    var n = opts.n == null ? 3 : opts.n;
    var live = ev ? (ev.top_opportunities || []).filter(function (x) { return x.research && x.research.grade; }) : [];
    var count = live.length ? live.length + (ev.more || 0) : 0;
    var lg = ev ? ev.league : opts.league, gid = ev ? ev.game_id : opts.game_id;
    var h = '<div class="pp pp-rsec"><div class="pp-rsec-h"><b>PLAYER PROPS TO RESEARCH</b><span class="n">' + count + '</span></div>';
    if (!live.length) {
      h += '<p class="pp-note">' + esc(E.emptyText(ev)) + '</p>';
      if (lg && gid != null && (!ev || !ev.capture || ev.capture.state !== 'PRICED')) h += '<button type="button" class="pp-btn ghost" onclick="' + esc('EDPropsUI.go(' + JSON.stringify({ league: lg, game: String(gid) }) + ')') + '">View projections</button>';
      return h + '</div>';
    }
    h += live.slice(0, n).map(function (o) { return researchCardHTML(o, opts); }).join('');
    if (count > Math.min(n, live.length)) h += '<button type="button" class="pp-btn acc pp-rsec-all" onclick="' + esc('EDPropsUI.go(' + JSON.stringify({ league: lg, game: String(gid) }) + ')') + '">View all ' + count + ' props →</button>';
    return h + '<p class="pp-note">' + esc(live[0].probability_label || '') + '. Research score orders what to read first; it is not a bet grade.</p></div>';
  }
  /* TOP PLAYER PROP RESEARCH — the league-wide leaders, the same ranking */
  function topModuleHTML(list, opts) {
    opts = opts || {};
    var h = '<div class="pp pp-top"><div class="pp-rsec-h"><b>TOP PLAYER PROP RESEARCH</b>' + (opts.sub ? '<span class="pp-note">' + esc(opts.sub) + '</span>' : '') + '</div>';
    if (!list || !list.length) return h + '<p class="pp-note">' + esc(opts.empty || 'No player prop currently meets EdgeDesk’s research threshold at a fresh price.') + '</p>'
      + '<button type="button" class="pp-btn ghost" onclick="EDPropsUI.go({league:' + JSON.stringify(opts.league || 'nfl') + '})">View Player Props</button></div>';
    h += '<ol class="pp-toplist">' + list.map(function (o) {
      reg(o);
      var e = o.event || {}, pr = o.price || {};
      return '<li><button type="button" class="pp-toprow" onclick="' + esc('EDPropsUI.go(' + JSON.stringify({ league: o.league, prop: o.prop_id }) + ')') + '">'
        + '<span class="w"><b>' + esc(o.player.name) + '</b> ' + esc(o.selection ? o.selection.text : '') + '</span>'
        + '<span class="m">' + esc((e.away_name || e.away || '') + ' @ ' + (e.home_name || e.home || '')) + ' · ' + esc(o.sport) + '</span>'
        + '<span class="n"><span class="' + evTone(o.ev) + '">EV ' + esc(spct(o.ev)) + '</span> · Confidence ' + esc(o.confidence == null ? '—' : o.confidence) + ' · ' + esc(pr.books_at_line || 0) + ' book' + (pr.books_at_line === 1 ? '' : 's') + ' · <span class="pp-dec ' + esc(o.tone) + '">' + esc(o.decision_label) + '</span></span></button></li>';
    }).join('') + '</ol><button type="button" class="pp-btn ghost" onclick="EDPropsUI.go({league:' + JSON.stringify(list[0].league) + '})">View Player Props</button></div>';
    return h;
  }
  /* Add to Card: the reader's Card snapshots the opportunity as it is NOW */
  function addToCard(id, btn) {
    var o = S.opps[id], U = root.EDDecisionUI, res = null;
    if (!o) return null;
    try { res = U && U.addOpportunity ? U.addOpportunity(o) : deviceAdd(o); } catch (e) { res = null; }
    if (btn && res) { btn.textContent = res.added ? 'Added to Card' : (res.reason || 'Already on your Card'); btn.disabled = true; }
    return res;
  }

  /* PLAYER PROP RESEARCH in a matchup: every priced prop of the game as an
     opportunity (the page's own re-priced evaluation when it has one), the
     research leaders in full, then QB / RB / WR-TE / TD groups, then the
     headline projections. */
  function groupOf(o) {
    var c = o.market.category, p = o.player ? o.player.position : null;
    if (c === 'touchdowns') return 'TD';
    if (p === 'QB') return 'QB'; if (p === 'RB' || p === 'FB') return 'RB'; if (p === 'WR' || p === 'TE') return 'WR / TE'; if (p === 'K') return 'Kicking';
    return 'Other';
  }
  function rowLineHTML(o) {
    reg(o);
    var pl = o.player || {}, pr = o.price || {}, m = o.model || {}, ex = o.explanation || {};
    return '<details class="pp-orow"><summary><span class="w"><b>' + esc(pl.name || '—') + '</b> <span class="pp-note">' + esc([pl.position, pl.team].filter(Boolean).join(' ')) + '</span> ' + esc(o.selection ? o.selection.text : o.market.label) + '</span>'
      + '<span class="n">' + esc(price(pr.american)) + ' ' + esc(abbr(pr.book)) + ' · <span class="' + evTone(o.ev) + '">EV ' + esc(spct(o.ev)) + '</span> · conf ' + esc(o.confidence == null ? '—' : o.confidence) + ' <span class="pp-dec ' + esc(o.tone) + '">' + esc(o.decision_label) + '</span></span></summary>'
      + kvRC([
        ['Market line', o.market_view && isNum(o.market_view.consensus_line) ? String(o.market_view.consensus_line) : '—'], ['Best price', esc(price(pr.american)) + ' <small>' + esc(book(pr.book)) + '</small>'],
        o.market.yesno ? null : ['EdgeDesk projection', m.projection ? n1(m.projection.mean) : '—'], o.market.yesno ? null : ['Fair line', m.fair_line != null ? n1(m.fair_line) : '—'],
        ['Fair probability', pct(m.probability)], ['Break-even', pct(o.break_even)], ['EV', spct(o.ev), evTone(o.ev)], ['Edge', isNum(o.edge_pp) ? pp(o.edge_pp) + ' pp' : '—'],
        ['Confidence', o.confidence == null ? '—' : String(o.confidence)], ['Books', o.market_view ? String(o.market_view.n_books) : '—'], ['Quote age', esc(ageText(pr.age_minutes))],
        ['Decision', esc(o.decision_label) + (o.decision === 'BET' ? ' ' + esc(unitsFmt(o.units)) : '')]])
      + ((ex.why || []).length ? '<ul class="pp-list pp-why">' + ex.why.slice(0, 4).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '')
      + ((ex.concerns || []).length ? '<ul class="pp-list pp-risk">' + ex.concerns.slice(0, 3).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '')
      + oppActs(o) + '</details>';
  }
  function gameSectionInner(lg, b, gid, so) {
    var E = P(), X = O(), t = now(), g = b._games[gid];
    var rows = (b.props || []).filter(function (r) { return r.g === gid && r.p && r.x && r.x.dist; });
    /* not on the board: the summary-first section says why (it never goes quiet) */
    if (!g || !rows.length) return summarySectionInner(lg, gid, so);
    var who = function (r) { var c = ctxOf(b, r); return c ? c.name : '—'; };
    var open = function (o, label, cls) { return '<button class="pp-btn' + (cls ? ' ' + cls : '') + '" onclick="EDPropsUI.go(' + esc(JSON.stringify(o)) + ')">' + label + '</button>'; };
    var priced = rows.filter(function (r) { return r.q && r.q.length; });
    var h = '<div class="pp-rsec-h"><b>PLAYER PROP RESEARCH</b><span class="pp-note">' + (lg === 'cfb' ? 'College' : 'NFL') + ' · ' + esc((g.away_name || g.away) + ' @ ' + (g.home_name || g.home)) + '</span></div>';
    var opps = [];
    if (X) {
      var sum = S.summaries && S.summaries[lg] && !S.summaries[lg].error ? S.summaries[lg] : null;
      var ctx = X.gameContext(g, null, b), rule = (sum && sum.script_rule) || b.script_rule || null;
      /* the script rule rides on the summary: fetch it once and repaint */
      if (!rule && !(S.summaries && S.summaries[lg])) loadSummary(lg).then(function () { fillGameSections(); }, function () {});
      opps = priced.map(function (r) {
        var ev = null; try { ev = E.boardEval(b, r, t); } catch (e) { ev = null; }
        var k = r.key || r.id || (b.league + '|' + r.g + '|' + r.p + '|' + r.m), cmp = (S.evals[lg] && S.evals[lg][k]) || (ev ? E.compact(ev) : r.e);
        if (!cmp || !cmp.cand) return null;
        try { return X.fromPropRow(b, r, { compact: cmp, ev: ev, now: t, context: ctx, script_rule: rule, evaluated_at: ev ? ev.evaluated_at : null }); } catch (e) { return null; }
      }).filter(Boolean).sort(function (a, c) { return (c.research.grade ? 1 : 0) - (a.research.grade ? 1 : 0) || c.research.score - a.research.score; });
    }
    var grade = opps.filter(function (o) { return o.research.grade; });
    if (!priced.length) {
      var su = S.summaries && S.summaries[lg] && !S.summaries[lg].error ? S.summaries[lg] : null, cs = su && X ? X.eventFromSummary(su, gid, t) : null;
      h += cs ? unpricedHTML(cs, su) : secState('Not priced', 'No sportsbook has priced a player prop in this game yet: projections and fair lines only.');
    } else if (!grade.length) h += evaluatedHTML(opps.length, '');
    else h += '<div class="pp-rsec-h sub"><b>TOP PROP OPPORTUNITIES</b><span class="n">' + grade.length + '</span></div>' + grade.slice(0, 4).map(function (o) { return researchCardHTML(o, { why: 4, concerns: 3 }); }).join('');
    if (opps.length) {
      var groups = {}, order = ['QB', 'RB', 'WR / TE', 'TD', 'Kicking', 'Other'];
      opps.forEach(function (o) { var k = groupOf(o); (groups[k] = groups[k] || []).push(o); });
      h += order.filter(function (k) { return groups[k]; }).map(function (k) {
        var gs = groups[k], ng = gs.filter(function (o) { return o.research.grade; }).length;
        return '<details class="pp-ogrp"><summary>' + esc(k === 'TD' ? 'TD markets' : k) + ' <span class="pp-note">' + gs.length + ' priced' + (ng ? ' · ' + ng + ' research grade' : '') + '</span></summary>' + gs.map(rowLineHTML).join('') + '</details>';
      }).join('');
    }
    /* the headline projections: the passer, the lead rusher and the top two receivers per side */
    var top = function (m, n) { return rows.filter(function (r) { return r.m === m && r.e && r.e.inf; }).sort(function (a, c) { return c.e.inf[1] - a.e.inf[1]; }).slice(0, n); };
    var heads = top('pass_yds', 2).concat(top('rush_yds', 2), top('rec_yds', 3));
    if (heads.length) h += '<details class="pp-ogrp"><summary>Headline projections</summary><div class="pp-tw"><table class="pp-t"><thead><tr><th>Player</th><th>Market</th><th>Median</th><th>Middle half</th></tr></thead><tbody>' + heads.map(function (r) {
      return '<tr><td>' + esc(who(r)) + '</td><td>' + esc((E.MARKETS[r.m] || {}).label || r.m) + '</td><td>' + n1(r.e.inf[1]) + '</td><td>' + n1(r.e.inf[2]) + '–' + n1(r.e.inf[3]) + '</td></tr>'; }).join('') + '</tbody></table></div></details>';
    return h + '<div class="pp-gfoot"><span class="pp-note">' + rows.length + ' props projected · ' + priced.length + ' priced · ' + grade.length + ' research grade. ' + esc((b.probability && b.probability.label) || '') + '. Research, not picks.</span>' + open({ league: lg, game: gid }, 'All props for this game ›', 'acc') + '</div>';
  }
  /* the per-league summaries the research surfaces read (football/props/<lg>/summary.json) */
  S.summaries = {}; var SUM_P = {};
  function loadSummary(lg, force) {
    if (!force && SUM_P[lg]) return SUM_P[lg];
    var p = SUM_P[lg] = fetchJson(base(lg) + 'summary.json').then(function (j) {
      if (!j || j.schema !== 'edgedesk_prop_summary_v1') throw new Error('summary.json schema ' + (j && j.schema));
      S.summaries[lg] = j; S.summaryAt = S.summaryAt || {}; S.summaryAt[lg] = Date.now(); return j;
    });
    p.catch(function () { if (SUM_P[lg] === p) SUM_P[lg] = null; S.summaries[lg] = S.summaries[lg] || { error: true }; });
    return p;
  }
  /* open the Props page on a game, a player or one prop, from anywhere */
  function go(o) {
    o = o || {};
    var lg = o.league === 'cfb' ? 'cfb' : 'nfl';
    if (S.league !== lg) { S.league = lg; S.cat = 'all'; S.market = null; S.team = ''; S.book = ''; }
    S.game = o.game || null; S.player = o.player || null; S.drawer = o.prop || null; S.cardsShown = PAGE;
    if (o.game) S.expanded[o.game] = true;
    if (o.game || o.player) S.mode = 'all';
    var want = '#playerprops/' + lg + (o.prop ? '/' + encodeURIComponent(o.prop) : o.player ? '/player/' + encodeURIComponent(o.player) : o.game ? '/game/' + encodeURIComponent(o.game) : '');
    /* a page without the Props terminal (research/cfb/) hands the reader to the app's */
    if (typeof root.show !== 'function' && !S.host) { try { root.location.href = '/app.html' + want; } catch (e) { /* no navigation */ } return; }
    try { history.replaceState(null, '', location.pathname + location.search + want); } catch (e) { /* no history */ }
    if (typeof root.show === 'function') { try { root.show('pprops'); return; } catch (e) { /* fall through */ } }
    if (S.host) show(S.host);
  }

  /* ================================================================== LAB
     "Player props validation" in the Lab: every market's stage and each
     gate's evidence, derived by EDProps.stageTable from the committed
     walk-forward report (football/props/nfl/calibration.json) and the live
     record (performance.json) — the same function the build stamps on the
     board, so the Lab and the board cannot disagree. */
  var LAB = { data: null, loading: false };
  function lab(host) {
    if (!host) return;
    if (LAB.data) { host.innerHTML = labHTML(LAB.data); return; }
    host.innerHTML = '<div class="pp"><div class="pp-pane" style="padding:12px">' + skelRows(4) + '</div></div>';
    if (LAB.loading) return;
    LAB.loading = true;
    var get = function (u) { return fetchJson(u).then(function (j) { return j; }, function (e) { return { _error: e && e.status === 404 ? 'not_published' : 'failed' }; }); };
    Promise.all([get(base('nfl') + 'calibration.json'), get(base('nfl') + 'performance.json'), get(base('cfb') + 'performance.json')]).then(function (a) {
      LAB.data = { cal: a[0], perf: { nfl: a[1], cfb: a[2] } }; LAB.loading = false;
      var h = host.id && root.document ? root.document.getElementById(host.id) : host;
      if (h) h.innerHTML = labHTML(LAB.data);
    });
  }
  function labHTML(d) {
    var E = P(), R = E.STAGE_RULES, cal = d.cal && !d.cal._error ? d.cal : null;
    var ok = function (x) { return x && !x._error ? x : null; };
    var nfl = E.stageTable(cal, ok(d.perf.nfl)), cfb = E.stageTable(null, ok(d.perf.cfb));
    var order = { PRODUCTION: 0, RESEARCH_GRADE: 1, TRACKING: 2, EXPERIMENTAL: 3 };
    var scored = cal && cal.out_of_sample && cal.out_of_sample.after ? Object.keys(cal.out_of_sample.after) : [];
    var mk = function (tbl, keys) {
      return '<div class="pp-tw"><table class="pp-t"><thead><tr><th>Market</th><th>Stage</th><th>Walk-forward gates</th><th>Live gates</th><th>What holds it</th></tr></thead><tbody>' +
        keys.sort(function (a, c) { return order[tbl[a].stage] - order[tbl[c].stage] || ((E.MARKETS[a] || {}).label || a).localeCompare((E.MARKETS[c] || {}).label || c); }).map(function (m) {
          var st = tbl[m], wf = st.gates.slice(0, 8), lv = st.gates.slice(8);
          var cnt = function (gs) { var me = gs.filter(function (x) { return x.measured; }); return me.filter(function (x) { return x.pass; }).length + ' / ' + gs.length + (me.length < gs.length ? ' <span class="pp-note">(' + (gs.length - me.length) + ' not measured)</span>' : ''); };
          var hold = st.gates.filter(function (x) { return !x.pass; })[0];
          return '<tr><td>' + esc((E.MARKETS[m] || {}).label || m) + '</td><td>' + stageTag(st.stage) + '</td><td>' + cnt(wf) + '</td><td>' + cnt(lv) + '</td><td><details class="pp-gates"><summary>' + esc(st.why && st.why.length && st.stage === 'EXPERIMENTAL' && (E.isTailMarket(m) || !scored.length) ? st.why[0] : hold ? hold.id + ' · ' + hold.name : 'every gate passes') + '</summary>' + gatesHTML(st.gates) + '</details></td></tr>';
        }).join('') + '</tbody></table></div>';
    };
    var h = '<div class="pp pp-lab"><p class="pp-note">A prop market\'s stage is derived from evidence, never assigned. <b>TRACKING</b> needs the walk-forward backtest to pass on its out-of-sample half: as-of data only, beating the naive last-8 baseline on log score, PIT mean within ' + R.tracking.pit_mean_dev + ' of 0.5, 50% interval coverage in ' + R.tracking.cover50.join('–') + ', mean bias within ' + R.tracking.max_bias_pct + '%, ECE ≤ ' + R.tracking.max_ece + ' and n ≥ ' + R.tracking.min_n + '. <b>RESEARCH GRADE</b> needs ' + R.research.min_n + ' settled live finals, live ECE ≤ ' + R.research.max_ece + ', a Brier score within ' + R.research.brier_vs_market_max + ' of the no-vig market and non-negative CLV. <b>PRODUCTION</b> needs ' + R.production.min_n + ' finals, ECE ≤ ' + R.production.max_ece + ' and positive CLV on ' + R.production.min_clv_n + ' closes. Tail markets (longest play, first TD) stay EXPERIMENTAL. An EXPERIMENTAL market is capped at LEAN and never carries units.</p>';
    h += '<h3>NFL</h3>' + (cal ? '<p class="pp-note">Walk-forward ' + esc(cal.mode || '') + (cal.season_tested ? ', ' + esc(cal.season_tested) : '') + (cal.n_scored ? ' · ' + Number(cal.n_scored).toLocaleString() + ' player-games scored' : '') + (cal.generated_at ? ' · built ' + esc(ago(cal.generated_at)) : '') + '. Live record: ' + (ok(d.perf.nfl) ? 'on file' : 'no graded props yet') + '.</p>' : '<p class="pp-note">No walk-forward report is on file (football/props/nfl/calibration.json), so every NFL market is EXPERIMENTAL.</p>');
    h += mk(nfl, scored.length ? scored.filter(function (m) { return nfl[m]; }) : Object.keys(nfl));
    if (scored.length) { var rest = Object.keys(nfl).filter(function (m) { return scored.indexOf(m) < 0; }); if (rest.length) h += '<p class="pp-note">Not scored by the backtest, so EXPERIMENTAL: ' + esc(rest.map(function (m) { return (E.MARKETS[m] || {}).label || m; }).join(', ')) + '.</p>'; }
    var cfbN = Object.keys(cfb).length;
    h += '<h3>College football</h3><p class="pp-note">No college walk-forward backtest exists yet (college distributions borrow the NFL fit), so all ' + cfbN + ' college markets are EXPERIMENTAL: they inform and never stake. ' + (ok(d.perf.cfb) ? 'The live record is on file and counts toward the later gates once a backtest passes.' : 'No graded college props yet.') + '</p>';
    return h + '</div>';
  }

  /* ================================================================ ROUTING */
  function setHash() {
    try {
      var want = '#playerprops/' + S.league + (S.drawer ? '/' + encodeURIComponent(S.drawer) : S.player ? '/player/' + encodeURIComponent(S.player) : S.game ? '/game/' + encodeURIComponent(S.game) : '');
      if (location.hash !== want && /^#playerprops|^$|^#$/.test(location.hash || '') || (location.hash || '').indexOf('#playerprops') === 0) history.replaceState(null, '', location.pathname + location.search + want);
    } catch (e) { /* no history */ }
  }
  /* #playerprops[/<league>[/<prop> | /game/<game_id> | /player/<player_id>]] */
  function readHash() {
    var m = /^#playerprops(?:\/(nfl|cfb))?(?:\/(.+))?$/.exec(location.hash || '');
    if (!m) return null;
    var rest = m[2] || '', gp = /^(game|player)\/(.+)$/.exec(rest), v = function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } };
    return { league: m[1] || null, prop: rest && !gp ? v(rest) : null, game: gp && gp[1] === 'game' ? v(gp[2]) : null, player: gp && gp[1] === 'player' ? v(gp[2]) : null };
  }

  /* ================================================================ MOUNT */
  function show(host, opts) {
    opts = opts || {};
    if (host && host !== S.host) { S.host = host; S.mounted = false; }
    if (!S.host) return;
    if (!S.mounted) {
      restoreView();
      var hh = readHash();
      if (hh && hh.league) S.league = hh.league;
      if (hh && hh.prop) S.drawer = hh.prop;
      if (hh && hh.game) { S.game = hh.game; S.expanded[hh.game] = true; }
      if (hh && hh.player) S.player = hh.player;
      if (hh && (hh.game || hh.player)) S.mode = 'all';
      if (opts.league) S.league = opts.league;
      S.host.addEventListener('click', onClick);
      S.host.addEventListener('keydown', onKey);
      S.host.addEventListener('input', onInput);
      S.host.addEventListener('change', onInput);
      S.mounted = true;
      loadWatch();
    }
    render();
    load(S.league);
    setHash();
  }

  return {
    VERSION: VERSION, show: show, render: render, load: load, state: S, go: go, gameSection: gameSection, wake: wake, lab: lab,
    researchCardHTML: researchCardHTML, eventSectionHTML: eventSectionHTML, topModuleHTML: topModuleHTML, addToCard: addToCard, loadSummary: loadSummary,
    /* exposed for tests */
    _rowOf: rowOf, _inputOf: inputOf, _passes: passes, _visible: visible, _sorter: sorter, _prepBoard: prepBoard, _rowsOf: rowsOf, _drawerHTML: drawerHTML,
    _perfHTML: perfHTML, _emptyHTML: emptyHTML, _repriceAll: repriceAll, _toggleWatch: toggleWatch, _readHash: readHash,
    _playerHTML: playerHTML, _gameSectionInner: gameSectionInner, _summarySectionInner: summarySectionInner, _labHTML: labHTML, _fetchBoard: fetchBoard
  };
}));
