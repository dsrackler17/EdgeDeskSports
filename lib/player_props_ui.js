/* ===========================================================================
   EDGEDESK PLAYER PROPS — the Research › Props tab for CFB and NFL.

   Reads ONLY the prepared artifacts football/props/run.js publishes:
     football/props/published/board_<league>.json         the board (packed rows)
     football/props/published/<league>/<game_id>.json      the research card (the
                                                          model half), per game,
                                                          fetched when a prop opens
     football/props/published/<league>/<game_id>.market.json  the game's observed
                                                          quotes, only when one exists
   and unpacks them with the kernel (EDProps.wire), which re-derives every price,
   ladder, EV and decision from the observed quotes — the same function the
   scorer and the AI desk run. Never a raw provider payload, never play-by-play,
   never a history to crunch.

   MODEL, MARKET and EDGE stay three different columns. A row with no observed
   sportsbook quote shows the model alone and says so: no price, no market
   probability, no edge and no EV is ever filled in. Research, not picks.

   Browser global: window.EDPropsUI. Uses window.EDProps (lib/player_props.js)
   to unpack and for the what-if calculator, loaded lazily with
   lib/edgedesk_quote_ev.js.
   =========================================================================== */
(function (root) {
  'use strict';
  var BASE = 'football/props/published/';
  var S = { league: 'NFL', boards: {}, games: {}, loading: {}, f: { q: '', date: '', team: '', game: '', pos: '', market: '', book: '', edge: '', conf: '', dq: '', priced: false },
    sort: 'ev', sortSet: false, shown: 60, open: null, host: null };
  var LABEL = { pass_yards: 'Pass yds', pass_tds: 'Pass TDs', pass_completions: 'Completions', pass_attempts: 'Pass att', pass_interceptions: 'INTs',
    pass_longest_completion: 'Long cmp', rush_yards: 'Rush yds', rush_attempts: 'Rush att', rush_tds: 'Rush TDs', longest_rush: 'Long rush',
    receiving_yards: 'Rec yds', receptions: 'Receptions', targets: 'Targets', receiving_tds: 'Rec TDs', longest_reception: 'Long rec', anytime_td: 'Anytime TD',
    pass_rush_yards: 'Pass+rush yds', rush_rec_yards: 'Rush+rec yds', pass_rush_rec_yards: 'Pass+rush+rec yds', receptions_rush_attempts: 'Rec+carries' };
  var BOOK = { draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM', williamhill_us: 'CZR', espnbet: 'ESPN', betrivers: 'BR', hardrockbet: 'HR', fanatics: 'FAN', pinnacle: 'PIN', bovada: 'BOV' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function spct(x, d) { return isNum(x) ? (x >= 0 ? '+' : '') + (100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function am(a) { return isNum(a) ? (a > 0 ? '+' : '') + Math.round(a) : '—'; }
  function num(x, d) { return isNum(x) ? x.toFixed(d == null ? 1 : d) : '—'; }
  function book(b) { return b ? (BOOK[b] || String(b).slice(0, 10).toUpperCase()) : '—'; }
  function lbl(m) { return LABEL[m] || String(m || '').replace(/_/g, ' '); }
  function kick(iso) { if (!iso) return ''; var d = new Date(iso); try { return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); } }
  function dayKey(iso) { var d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function ago(iso) { if (!iso) return '—'; var m = Math.round((Date.now() - Date.parse(iso)) / 60000); if (!isFinite(m)) return '—'; if (m < 60) return m + 'm'; if (m < 2880) return Math.round(m / 60) + 'h'; return Math.round(m / 1440) + 'd'; }
  function sideTxt(s) { return s === 'over' ? 'o' : s === 'under' ? 'u' : s === 'yes' ? 'Yes' : s === 'no' ? 'No' : ''; }
  function decBadge(d) { var c = { BET: 'pp-bet', LEAN: 'pp-lean', WATCH: 'pp-watch', PASS: 'pp-pass' }[d] || 'pp-pass'; return '<span class="pp-dec ' + c + '">' + esc(d || 'PASS') + '</span>'; }
  function fetchJson(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u); return r.json(); }); }
  function kernel() {
    if (root.EDProps) return Promise.resolve(root.EDProps);
    var load = root.fbScript || function (src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); };
    return load('lib/edgedesk_quote_ev.js').catch(function () {}).then(function () { return load('lib/player_props.js'); }).then(function () { return root.EDProps; });
  }

  /* ---------------------------------------------------------------- data */
  function load(league, force) {
    league = league || S.league;
    if (!force && S.boards[league]) return Promise.resolve(S.boards[league]);
    if (S.loading[league]) return S.loading[league];
    S.loading[league] = Promise.all([fetchJson(BASE + 'board_' + league.toLowerCase() + '.json'), kernel()]).then(function (a) {
      var raw = a[0], K = a[1];
      if (!raw || raw.schema !== 'edgedesk_props_board_v1') throw new Error('unexpected board schema');
      if (!K || !K.wire) throw new Error('the props kernel did not load');
      var b = K.wire.expandBoard(raw);
      b._at = Date.now(); S.boards[league] = b; S.loading[league] = null; return b;
    }, function (e) { S.loading[league] = null; throw e; });
    return S.loading[league];
  }
  /* the card, plus the game's market file when any of its props is priced */
  function loadGame(league, gameId, withMarket) {
    var k = league + '|' + gameId + (withMarket ? '|m' : '');
    if (S.games[k]) return Promise.resolve(S.games[k]);
    var path = BASE + league.toLowerCase() + '/' + encodeURIComponent(gameId);
    return Promise.all([fetchJson(path + '.json'), withMarket ? fetchJson(path + '.market.json').catch(function () { return null; }) : null, kernel()]).then(function (a) {
      var card = a[0], mk = a[1], K = a[2];
      if (!card || card.schema !== 'edgedesk_props_game_v1') throw new Error('unexpected game schema');
      if (!K || !K.wire) throw new Error('the props kernel did not load');
      var g = { game: card.game, props: K.wire.expandCard(card, mk && mk.schema === 'edgedesk_props_market_v1' ? mk : null), market_as_of: mk ? mk.as_of : null };
      S.games[k] = g; return g;
    });
  }

  /* ---------------------------------------------------------------- filters */
  function filtered(b) {
    var f = S.f, q = f.q.trim().toLowerCase();
    var minEdge = f.edge ? Number(f.edge) : null, minConf = f.conf ? Number(f.conf) : null, minDq = f.dq ? Number(f.dq) : null;
    var rows = (b.rows || []).filter(function (r) {
      if (q && (String(r.player) + ' ' + r.team + ' ' + r.opp + ' ' + r.matchup).toLowerCase().indexOf(q) < 0) return false;
      if (f.date && dayKey(r.kickoff) !== f.date) return false;
      if (f.team && r.team !== f.team && r.opp !== f.team) return false;
      if (f.game && r.game_id !== f.game) return false;
      if (f.pos && r.pos !== f.pos) return false;
      if (f.market && r.market !== f.market) return false;
      if (f.book && !(r.focus && r.focus.book === f.book) && !(r.mkt && ((r.mkt.best_over && r.mkt.best_over.sportsbook === f.book) || (r.mkt.best_under && r.mkt.best_under.sportsbook === f.book)))) return false;
      if (f.priced && !r.focus) return false;
      if (minEdge != null && !(r.focus && isNum(r.focus.edge) && r.focus.edge >= minEdge)) return false;
      if (minConf != null && !(isNum(r.conf) && r.conf >= minConf)) return false;
      if (minDq != null && !(isNum(r.dq) && r.dq >= minDq)) return false;
      return true;
    });
    var key = { ev: function (r) { return r.focus && isNum(r.focus.cev) ? r.focus.cev : (r.focus && isNum(r.focus.ev) ? r.focus.ev - 1 : -9); },
      edge: function (r) { return r.focus && isNum(r.focus.edge) ? r.focus.edge : -9; }, conf: function (r) { return isNum(r.conf) ? r.conf : -1; },
      kick: function (r) { return -Date.parse(r.kickoff) / 6e4; }, proj: function (r) { return isNum(r.mean) ? r.mean : -1; } }[S.sort] || function () { return 0; };
    rows.sort(function (a, c) { return key(c) - key(a) || String(a.player).localeCompare(String(c.player)); });
    return rows;
  }
  function uniq(rows, fn) { var m = {}; rows.forEach(function (r) { var v = fn(r); if (v != null && v !== '') m[v] = 1; }); return Object.keys(m).sort(); }

  /* ---------------------------------------------------------------- render */
  function opt(v, t, cur) { return '<option value="' + esc(v) + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(t) + '</option>'; }
  function controls(b) {
    var rows = b.rows || [], f = S.f;
    var dates = uniq(rows, function (r) { return dayKey(r.kickoff); });
    var teams = uniq(rows, function (r) { return r.team; });
    var games = {}; rows.forEach(function (r) { games[r.game_id] = r.matchup + ' · ' + kick(r.kickoff); });
    var books = {}; rows.forEach(function (r) { if (r.focus) books[r.focus.book] = 1; if (r.mkt && r.mkt.best_over) books[r.mkt.best_over.sportsbook] = 1; });
    var markets = uniq(rows, function (r) { return r.market; });
    return '<div class="pp-ctl">' +
      '<input class="stsearch pp-q" id="ppQ" placeholder="Player or team" value="' + esc(f.q) + '" aria-label="Search players">' +
      '<select class="stsearch" id="ppDate" aria-label="Date">' + opt('', 'All dates', f.date) + dates.map(function (d) { return opt(d, new Date(d + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), f.date); }).join('') + '</select>' +
      '<select class="stsearch" id="ppTeam" aria-label="Team">' + opt('', 'All teams', f.team) + teams.map(function (t) { return opt(t, teamName(b, t), f.team); }).join('') + '</select>' +
      '<select class="stsearch" id="ppGame" aria-label="Matchup">' + opt('', 'All matchups', f.game) + Object.keys(games).map(function (g) { return opt(g, games[g], f.game); }).join('') + '</select>' +
      '<select class="stsearch" id="ppPos" aria-label="Position">' + opt('', 'All positions', f.pos) + ['QB', 'RB', 'WR', 'TE'].map(function (p) { return opt(p, p, f.pos); }).join('') + '</select>' +
      '<select class="stsearch" id="ppMkt" aria-label="Market">' + opt('', 'All markets', f.market) + markets.map(function (m) { return opt(m, lbl(m), f.market); }).join('') + '</select>' +
      '<select class="stsearch" id="ppBook" aria-label="Sportsbook">' + opt('', 'All books', f.book) + Object.keys(books).sort().map(function (k) { return opt(k, book(k), f.book); }).join('') + '</select>' +
      '<select class="stsearch" id="ppEdge" aria-label="Minimum edge">' + opt('', 'Any edge', f.edge) + [0.02, 0.04, 0.06, 0.08].map(function (e) { return opt(e, 'Edge ≥ ' + Math.round(e * 100) + '%', f.edge); }).join('') + '</select>' +
      '<select class="stsearch" id="ppConf" aria-label="Minimum confidence">' + opt('', 'Any confidence', f.conf) + [50, 60, 70].map(function (c) { return opt(c, 'Confidence ≥ ' + c, f.conf); }).join('') + '</select>' +
      '<select class="stsearch" id="ppDq" aria-label="Minimum data quality">' + opt('', 'Any data quality', f.dq) + [0.6, 0.7, 0.8].map(function (d) { return opt(d, 'Data ≥ ' + d.toFixed(1), f.dq); }).join('') + '</select>' +
      '<select class="stsearch" id="ppSort" aria-label="Sort">' + opt('ev', 'Sort: best value', S.sort) + opt('edge', 'Sort: edge', S.sort) + opt('conf', 'Sort: confidence', S.sort) + opt('proj', 'Sort: projection', S.sort) + opt('kick', 'Sort: kickoff', S.sort) + '</select>' +
      '<label class="pp-chk"><input type="checkbox" id="ppPriced"' + (f.priced ? ' checked' : '') + '> Priced only</label>' +
      '</div>';
  }
  function teamName(b, id) { var g = (b.games || []).find(function (x) { return x.home_id === id || x.away_id === id; }); return g ? (g.home_id === id ? g.home : g.away) : id; }
  /* NFL teams are codes already; a college team id is a number, so show its name */
  function teamLabel(id) { var b = S.boards[S.league]; return b && /^\d+$/.test(String(id)) ? teamName(b, String(id)) : id; }
  function bindControls(b) {
    var map = { ppQ: 'q', ppDate: 'date', ppTeam: 'team', ppGame: 'game', ppPos: 'pos', ppMkt: 'market', ppBook: 'book', ppEdge: 'edge', ppConf: 'conf', ppDq: 'dq' };
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id); if (!el) return;
      var ev = el.tagName === 'INPUT' ? 'input' : 'change';
      el.addEventListener(ev, function () { S.f[map[id]] = el.value; S.shown = 60; body(b); });
    });
    var so = document.getElementById('ppSort'); if (so) so.addEventListener('change', function () { S.sort = so.value; S.sortSet = true; body(b); });
    var pr = document.getElementById('ppPriced'); if (pr) pr.addEventListener('change', function () { S.f.priced = pr.checked; S.shown = 60; body(b); });
  }
  function status(b) {
    var q = b.quotes || {};
    var gen = b.generated_at ? ('Board last changed ' + ago(b.generated_at) + ' ago') : '';
    var nMod = (b.model_versions || []).length;
    var line = '<div class="pp-status">' + esc(gen) + ' · ' + (b.n_props || 0) + ' props across ' + ((b.games || []).length) + ' games · ' + nMod + ' market models · feature set ' + esc(b.feature_version || '—') + '</div>';
    if (!q.captured) line += '<div class="model-warn pp-nomkt"><b>No observed sportsbook prop line is on file for these games yet.</b> Every row shows EdgeDesk\'s model only: its projection, its distribution and the probability at a reference line near its own median. Market probability, edge, fair-vs-price and EV appear only when a real sportsbook price has been captured — nothing is filled in.</div>';
    else line += '<div class="pp-status">' + (q.n_quotes || 0) + ' observed quotes · last capture ' + ago(q.last_capture) + ' ago · provider ' + esc(q.provider || '') + '</div>';
    return line;
  }
  function cellLine(r) {
    if (r.focus) return '<b>' + sideTxt(r.focus.side) + (isNum(r.focus.line) ? ' ' + r.focus.line : '') + '</b>';
    if (isNum(r.ref_line)) return '<span class="pp-ref" title="EdgeDesk reference line — not a sportsbook line">o' + r.ref_line + ' <i>model</i></span>';
    return r.market === 'anytime_td' ? '<span class="pp-ref">Yes <i>model</i></span>' : '—';
  }
  function modelP(r) { return r.focus ? r.focus.model : r.over; }
  /* a yes/no market has no projection to show beyond its probability */
  function proj(r) { return r.market === 'anytime_td' || r.market === 'first_td' ? '<span class="pp-sub">yes/no</span>' : num(r.median, 1) + '<span class="pp-sub"> μ ' + num(r.mean, 1) + '</span>'; }
  function edgeCls(x) { return !isNum(x) ? '' : x >= 0.02 ? 'up' : x <= -0.02 ? 'dn' : ''; }
  function row(r, i) {
    var f = r.focus, mv = r.move;
    return '<tr class="pp-tr" data-id="' + esc(r.id) + '" tabindex="0">' +
      '<td class="pp-pl"><div class="pp-pn">' + esc(r.player) + '</div><div class="pp-pt">' + esc(r.pos) + ' · ' + esc(teamLabel(r.team)) + '</div></td>' +
      '<td class="pp-mu"><div>' + esc(r.matchup) + '</div><div class="pp-pt">' + esc(kick(r.kickoff)) + '</div></td>' +
      '<td class="pp-pr">' + esc(lbl(r.market)) + '</td><td class="mono">' + cellLine(r) + '</td>' +
      '<td class="mono">' + (f ? am(f.am) + '<div class="pp-pt">' + esc(book(f.book)) + '</div>' : '—') + '</td>' +
      '<td class="mono">' + proj(r) + '</td>' +
      '<td class="mono">' + pct(modelP(r)) + '<div class="pp-pt">fair ' + am(f ? f.fair : r.fair_over) + '</div></td><td class="mono">' + (f ? pct(f.market) : '—') + '</td>' +
      '<td class="mono ' + edgeCls(f && f.edge) + '">' + (f ? spct(f.edge) : '—') + '</td>' +
      '<td class="mono ' + edgeCls(f && f.ev) + '">' + (f ? spct(f.ev) : '—') + '</td>' +
      '<td class="mono">' + (isNum(r.conf) ? r.conf : '—') + '<div class="pp-pt">dq ' + num(r.dq, 2) + '</div></td>' +
      '<td class="mono">' + (mv && isNum(mv.line) && mv.line !== 0 ? (mv.line > 0 ? '+' : '') + mv.line : '—') + '<div class="pp-pt">' + (f ? ago(r.updated_at) : '') + '</div></td>' +
      '<td>' + (f ? decBadge(r.decision) : '<span class="pp-dec pp-pass">MODEL</span>') + '</td></tr>';
  }
  function card(r) {
    var f = r.focus;
    return '<button class="pp-card" data-id="' + esc(r.id) + '">' +
      '<div class="pp-ch"><div><div class="pp-pn">' + esc(r.player) + ' <span class="pp-pt">' + esc(r.pos) + ' · ' + esc(teamLabel(r.team)) + '</span></div><div class="pp-pt">' + esc(r.matchup) + ' · ' + esc(kick(r.kickoff)) + '</div></div>' +
      (f ? decBadge(r.decision) : '<span class="pp-dec pp-pass">MODEL</span>') + '</div>' +
      '<div class="pp-cl"><span class="pp-mk">' + esc(lbl(r.market)) + '</span> ' + cellLine(r) + (f ? ' <span class="mono">' + am(f.am) + '</span> <span class="pp-pt">' + book(f.book) + '</span>' : '') + '</div>' +
      '<div class="pp-cg">' +
        '<span><i>Proj</i>' + (r.market === 'anytime_td' || r.market === 'first_td' ? '—' : num(r.median, 1)) + '</span>' +
        '<span><i>Model</i>' + pct(modelP(r), 0) + '</span>' +
        '<span><i>Market</i>' + (f ? pct(f.market, 0) : '—') + '</span>' +
        '<span class="' + edgeCls(f && f.edge) + '"><i>Edge</i>' + (f ? spct(f.edge) : '—') + '</span>' +
        '<span><i>Fair</i>' + am(f ? f.fair : r.fair_over) + '</span>' +
        '<span class="' + edgeCls(f && f.ev) + '"><i>EV</i>' + (f ? spct(f.ev) : '—') + '</span>' +
        '<span><i>Conf</i>' + (isNum(r.conf) ? r.conf : '—') + '</span>' +
      '</div></button>';
  }
  function body(b) {
    var host = document.getElementById('prBody'); if (!host) return;
    var rows = filtered(b), shown = rows.slice(0, S.shown);
    var head = '<tr><th>Player</th><th>Matchup</th><th>Prop</th><th>Best line</th><th>Price</th><th>Model proj</th><th title="The model\'s probability, and its fair price">Model P</th><th>Market P</th><th>Edge</th><th>EV</th><th>Conf</th><th title="Line move since the opener, and the age of the latest quote">Move</th><th></th></tr>';
    host.innerHTML = status(b) +
      (rows.length ? '<div class="pp-count">' + rows.length + ' props' + (rows.length > shown.length ? ' · showing ' + shown.length : '') + '</div>' +
        '<div class="pp-tablewrap"><table class="pp-table">' + head + shown.map(row).join('') + '</table></div>' +
        '<div class="pp-cards">' + shown.map(card).join('') + '</div>' +
        (rows.length > shown.length ? '<button class="pp-more" id="ppMore">Show ' + Math.min(60, rows.length - shown.length) + ' more</button>' : '')
        : '<div class="empty">No props match these filters.</div>') +
      '<div class="model-warn pp-foot">MODEL = EdgeDesk\'s outcome distribution (market-blind). MARKET = the observed sportsbook consensus, no-vig. EDGE = model minus market at an exact price. EV is per unit at that exact price. Confidence and data quality are separate from edge. Research, not picks.</div>';
    var more = document.getElementById('ppMore'); if (more) more.onclick = function () { S.shown += 60; body(b); };
    var els = host.querySelectorAll('[data-id]');
    for (var i = 0; i < els.length; i++) (function (el) {
      el.addEventListener('click', function () { openProp(el.getAttribute('data-id')); });
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter') openProp(el.getAttribute('data-id')); });
    })(els[i]);
  }

  function render(league) {
    if (league) S.league = league;
    var ctl = document.getElementById('prControls'), host = document.getElementById('prBody');
    if (!ctl || !host) return Promise.resolve();
    host.innerHTML = '<div class="empty">Loading ' + esc(S.league) + ' props…</div>';
    return load(S.league).then(function (b) {
      /* nothing priced: "best value" has nothing to rank, so the default is the next kickoff */
      if (!S.sortSet) S.sort = (b.rows || []).some(function (r) { return r.focus; }) ? 'ev' : 'kick';
      ctl.innerHTML = controls(b); bindControls(b); body(b); return b;
    }, function (e) {
      ctl.innerHTML = '';
      host.innerHTML = '<div class="empty"><b>' + esc(S.league) + ' player props are not published yet.</b><br><span class="pp-pt">' + esc(e.message) + '</span></div>';
    });
  }

  /* ---------------------------------------------------------------- the research card */
  function openProp(id) {
    var b = S.boards[S.league]; if (!b) return;
    var r = (b.rows || []).find(function (x) { return x.id === id; }); if (!r) return;
    var d = document.getElementById('ppDrawer');
    if (!d) { d = document.createElement('div'); d.id = 'ppDrawer'; d.className = 'pp-drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); document.body.appendChild(d);
      d.addEventListener('click', function (e) { if (e.target === d) closeProp(); }); document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeProp(); }); }
    d.innerHTML = '<div class="pp-dcard"><button class="pp-x" aria-label="Close" id="ppX">×</button><div class="empty">Loading the research card…</div></div>';
    d.style.display = 'flex'; document.getElementById('ppX').onclick = closeProp;
    S.open = id;
    var priced = (b.rows || []).some(function (x) { return x.game_id === r.game_id && x.mkt; });
    Promise.all([loadGame(S.league, r.game_id, priced), kernel().catch(function () { return null; })]).then(function (a) {
      var p = (a[0].props || []).find(function (x) { return x.id === id; });
      if (!p) throw new Error('this prop is not in the game file');
      d.querySelector('.pp-dcard').innerHTML = '<button class="pp-x" aria-label="Close" id="ppX">×</button>' + researchCard(p, a[0].game, a[1]);
      document.getElementById('ppX').onclick = closeProp;
      bindWhatIf(p, a[1]);
    }).catch(function (e) { d.querySelector('.pp-dcard').innerHTML = '<button class="pp-x" aria-label="Close" id="ppX">×</button><div class="empty">' + esc(e.message) + '</div>'; document.getElementById('ppX').onclick = closeProp; });
  }
  function closeProp() { var d = document.getElementById('ppDrawer'); if (d) d.style.display = 'none'; S.open = null; }
  function kv(k, v, cls) { return '<div class="pp-kv"><span>' + esc(k) + '</span><b class="' + (cls || '') + '">' + v + '</b></div>'; }
  function section(t, inner) { return '<section class="pp-sec"><h4>' + esc(t) + '</h4>' + inner + '</section>'; }
  function distChart(p, K) {
    var d = p.model && p.model.dist; if (!d || !K) return '';
    var W = 320, H = 70, xs = [], ys = [];
    if (d.t === 'pmf') { var n = Math.min(d.v.length, 40); for (var i = 0; i < n; i++) { xs.push(i); ys.push(d.v[i]); } }
    else if (d.t === 'cdf') { var lo = p.model.p10 - (p.model.p90 - p.model.p10) * 0.6, hi = p.model.p90 + (p.model.p90 - p.model.p10) * 0.6; lo = Math.max(lo, d.x[0]); var nb = 36, w = (hi - lo) / nb;
      for (var j = 0; j < nb; j++) { var a = lo + j * w; xs.push(a + w / 2); ys.push(Math.max(0, K.dist.cdf(d, a + w) - K.dist.cdf(d, a))); } }
    else if (d.t === 'bern') {
      return '<svg class="pp-chart" viewBox="0 0 ' + W + ' 40" role="img" aria-label="Probability of yes">' +
        '<rect x="0" y="4" width="' + (W * d.p).toFixed(1) + '" height="18" class="pp-bo"></rect><rect x="' + (W * d.p).toFixed(1) + '" y="4" width="' + (W * (1 - d.p)).toFixed(1) + '" height="18" class="pp-bu"></rect>' +
        '<text x="0" y="36" class="pp-bt">yes ' + esc(pct(d.p)) + '</text><text x="' + (W - 60) + '" y="36" class="pp-bt">no ' + esc(pct(1 - d.p)) + '</text></svg>';
    }
    else return '';
    var mx = Math.max.apply(null, ys) || 1, bw = W / ys.length;
    var line = p.focus && isNum(p.focus.line) ? p.focus.line : (p.market && isNum(p.market.consensus_line) ? p.market.consensus_line : p.model.ref_line);
    var lx = null;
    if (isNum(line) && xs.length > 1) { var x0 = xs[0], x1 = xs[xs.length - 1]; lx = ((line - x0) / (x1 - x0)) * (W - bw) + bw / 2; }
    return '<svg class="pp-chart" viewBox="0 0 ' + W + ' ' + (H + 14) + '" role="img" aria-label="Outcome distribution">' + ys.map(function (y, i) {
      var h = (y / mx) * H; var over = isNum(line) && xs[i] > line;
      return '<rect x="' + (i * bw + 1).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '" class="' + (over ? 'pp-bo' : 'pp-bu') + '"></rect>';
    }).join('') + (lx != null && lx >= 0 && lx <= W ? '<line x1="' + lx.toFixed(1) + '" x2="' + lx.toFixed(1) + '" y1="0" y2="' + H + '" class="pp-bl"></line><text x="' + Math.min(W - 40, lx + 3).toFixed(1) + '" y="' + (H + 12) + '" class="pp-bt">' + line + '</text>' : '') +
      '<text x="0" y="' + (H + 12) + '" class="pp-bt">' + esc(num(xs[0], 0)) + '</text><text x="' + (W - 24) + '" y="' + (H + 12) + '" class="pp-bt">' + esc(num(xs[xs.length - 1], 0)) + '</text></svg>';
  }
  function ladderTable(L, side) {
    if (!L || !L.rows || !L.rows.length) return '';
    var bv = L.best_value, hp = L.highest_probability;
    return '<div class="pp-lad"><div class="pp-lh">' + esc(side === 'over' ? 'Over ladder' : 'Under ladder') + '</div><table class="pp-lt"><tr><th>Line</th><th>Book</th><th>Price</th><th>Model P</th><th>Fair</th><th>EV</th></tr>' +
      L.rows.map(function (x) {
        var isBv = bv && bv.line === x.line && bv.sportsbook === x.sportsbook, isHp = hp && hp.line === x.line;
        return '<tr class="' + (isBv ? 'pp-bv' : '') + '"><td class="mono">' + x.line + (x.is_main_line ? ' <i>main</i>' : '') + '</td><td>' + book(x.sportsbook) + '</td><td class="mono">' + am(x.american) + '</td>' +
          '<td class="mono">' + pct(x.model_prob) + (isHp ? ' <i>max P</i>' : '') + '</td><td class="mono">' + am(x.fair_american) + '</td><td class="mono ' + edgeCls(x.ev) + '">' + spct(x.ev) + (isBv ? ' <b>best value</b>' : '') + '</td></tr>';
      }).join('') + '</table>' +
      '<div class="pp-note">' + esc(L.rule) + (L.max_ev && bv && (L.max_ev.line !== bv.line) ? ' Largest raw EV is ' + L.max_ev.line + ' at ' + am(L.max_ev.american) + ' (' + spct(L.max_ev.ev) + '), which the conservative read does not prefer.' : '') + '</div>' +
      (L.flags && L.flags.length ? '<div class="pp-note">' + L.flags.map(function (f) { return esc(f.text); }).join(' · ') + '</div>' : '') + '</div>';
  }
  function researchCard(p, g, K) {
    var m = p.model, mk = p.market, f = p.focus, c = p.context || {};
    var tm = g && /^\d+$/.test(String(p.team)) ? (String(p.team) === String(g.home) ? g.home_name : g.away_name) : p.team;
    var hdr = '<div class="pp-dh"><div><div class="pp-dn">' + esc(p.player) + ' <span class="pp-pt">' + esc(p.position) + ' · ' + esc(tm || p.team) + '</span></div>' +
      '<div class="pp-pt">' + esc(p.matchup) + ' · ' + esc(kick(p.kickoff_utc)) + ' · ' + esc(lbl(p.market_key)) + '</div></div>' + (f ? decBadge(p.decision && p.decision.decision) : '<span class="pp-dec pp-pass">MODEL ONLY</span>') + '</div>';
    var bern = m.dist && m.dist.t === 'bern';
    var proj = bern
      ? section('Projection', '<div class="pp-grid">' + kv('P(yes)', pct(m.over_prob)) + kv('P(no)', pct(m.under_prob)) + kv('Fair yes', am(m.fair_over)) + kv('Fair no', am(m.fair_under)) + '</div>' + distChart(p, K) +
        '<div class="pp-note">A yes/no market: one probability, priced at any price with the calculator below.</div>')
      : section('Projection', '<div class="pp-grid">' + kv('Mean', num(m.mean, 2)) + kv('Median', num(m.median, 1)) + kv('80% range', num(m.p10, 0) + '–' + num(m.p90, 0)) +
      kv('50% range', num(m.p25, 0) + '–' + num(m.p75, 0)) + kv('Over ' + m.ref_line, pct(m.over_prob)) + kv('Under ' + m.ref_line, pct(m.under_prob)) +
      kv('Fair over', am(m.fair_over)) + kv('Fair under', am(m.fair_under)) + kv('Uncertainty', num(m.uncertainty, 2)) + '</div>' + distChart(p, K) +
      '<div class="pp-note">' + esc(isNum(m.ref_line) && !(mk && isNum(mk.consensus_line)) ? 'The reference line ' + m.ref_line + ' is EdgeDesk\'s own half point near its median — not a sportsbook line.' : 'Probabilities at the consensus line; every line below is priced from this same distribution.') + '</div>');
    var market = mk ? section('Market', '<div class="pp-grid">' + kv('Consensus line', num(mk.consensus_line, 1)) + kv('No-vig over', pct(mk.consensus_over_prob)) + kv('Books', mk.book_count) +
      kv('Best over', mk.best_over_price ? sideTxt('over') + ' ' + (mk.best_over_price.line == null ? '' : mk.best_over_price.line) + ' ' + am(mk.best_over_price.american) + ' ' + book(mk.best_over_price.sportsbook) : '—') +
      kv('Best under', mk.best_under_price ? sideTxt('under') + ' ' + (mk.best_under_price.line == null ? '' : mk.best_under_price.line) + ' ' + am(mk.best_under_price.american) + ' ' + book(mk.best_under_price.sportsbook) : '—') +
      kv('Best over number', mk.best_over_line ? mk.best_over_line.line + ' ' + am(mk.best_over_line.american) + ' ' + book(mk.best_over_line.sportsbook) : '—') +
      kv('Line dispersion', num(mk.line_dispersion, 1)) + kv('Price dispersion', num(mk.price_dispersion, 3)) +
      (p.movement && p.movement.available ? kv('Opener', num(p.movement.open.line, 1)) + kv('Current', num(p.movement.current.line, 1)) + kv('Move', (p.movement.line_move > 0 ? '+' : '') + num(p.movement.line_move, 1)) + kv('Since move', p.movement.minutes_since_move == null ? '—' : p.movement.minutes_since_move + ' min') : '') +
      '</div>' + (mk.books && mk.books.length ? '<table class="pp-lt"><tr><th>Book</th><th>Line</th><th>Over</th><th>Under</th><th>No-vig over</th></tr>' + mk.books.map(function (bk) {
        return '<tr><td>' + book(bk.sportsbook) + '</td><td class="mono">' + num(bk.main_line, 1) + '</td><td class="mono">' + am(bk.over_price) + '</td><td class="mono">' + am(bk.under_price) + '</td><td class="mono">' + pct(bk.no_vig_over) + '</td></tr>';
      }).join('') + '</table>' : '') + (p.movement ? '<div class="pp-note">' + esc(p.movement.note || '') + '</div>' : ''))
      : section('Market', '<div class="pp-note">No observed sportsbook line has been captured for this prop. Nothing on this card is a price.</div>');
    var edge = f ? section('Model vs market', '<div class="pp-grid">' + kv('Quote', sideTxt(f.side) + (isNum(f.line) ? ' ' + f.line : '') + ' ' + am(f.american) + ' ' + book(f.sportsbook)) + kv('Model P', pct(f.model_prob)) +
      kv('Market P (no-vig)', pct(f.market_prob)) + kv('Edge', spct(f.edge_vs_market != null ? f.edge_vs_market : f.edge_vs_implied), edgeCls(f.edge_vs_market)) + kv('Fair price', am(f.fair_american)) +
      kv('EV', spct(f.ev), edgeCls(f.ev)) + kv('Conservative EV', spct(f.conservative_ev), edgeCls(f.conservative_ev)) + kv('Playable to', p.playable_to == null ? '—' : String(p.playable_to)) + '</div>' +
      '<div class="pp-note">' + (p.decision ? esc((p.decision.reasons || []).join(' ')) : '') + '</div>') : '';
    var ladders = p.ladders ? section('Alternate lines', ladderTable(p.ladders.over, 'over') + ladderTable(p.ladders.under, 'under')) : '';
    var whatIf = section('What if', '<div class="pp-wi">' + (bern ? '' : '<label>Line <input id="ppWiL" type="number" step="0.5" value="' + esc(isNum(f && f.line) ? f.line : (isNum(m.ref_line) ? m.ref_line : 0.5)) + '"></label>') +
      '<label>Price <input id="ppWiP" type="number" step="5" value="' + esc(f ? f.american : -110) + '"></label><div id="ppWiOut" class="mono"></div></div>' +
      '<div class="pp-note">The same distribution at any line and price you type — for a book or a number not on this card.</div>');
    var form = c.form ? section('Form', '<table class="pp-lt"><tr><th>Stat</th><th>L3</th><th>L5</th><th>L8</th><th>Season</th><th>Weighted</th></tr>' + Object.keys(c.form).map(function (k) {
      var x = c.form[k]; return '<tr><td>' + esc(k.replace(/_/g, ' ')) + '</td><td class="mono">' + num(x.l3) + '</td><td class="mono">' + num(x.l5) + '</td><td class="mono">' + num(x.l8) + '</td><td class="mono">' + num(x.season) + '</td><td class="mono">' + num(x.weighted) + '</td></tr>';
    }).join('') + '</table>') : '';
    var grid = function (o, pctKeys) { return '<div class="pp-grid">' + Object.keys(o || {}).filter(function (k) { return o[k] != null; }).map(function (k) {
      var v = o[k], name = k.replace(/_flag$/, '').replace(/_l(\d)$/, ' (L$1)').replace(/_/g, ' ');
      var val = /_flag$/.test(k) ? (v ? 'yes' : 'no') : /_prob$/.test(k) ? pct(v, 0) : (pctKeys && /share|rate|pct/.test(k) && v <= 1.5) ? pct(v) : num(v, /(days|week|years)/.test(k) ? 0 : 2);
      return kv(name, val); }).join('') + '</div>'; };
    var usage = section('Usage', grid(c.usage, true) + grid(c.efficiency, true));
    var matchup = section('Matchup', grid(c.matchup, true) + '<div class="pp-note">Opponent rates over its last eight games, shrunk toward the league so a small sample cannot pose as a trait.</div>');
    var env = c.environment || {};
    var envS = section('Environment', grid(Object.keys(env).reduce(function (o, k) { if (k !== 'market_context_source' && k !== 'market_context_basis') o[k] = env[k]; return o; }, {}), true) +
      '<div class="pp-note">' + esc(env.market_context_basis === 'model' ? 'Spread and total are EdgeDesk\'s own fair numbers: no game market was captured.' : (env.market_context_source ? 'Spread and total: ' + env.market_context_source : '')) + '</div>');
    var av = c.availability || {};
    var avS = section('Availability', '<div class="pp-grid">' + kv('Status', esc(av.status || '—')) + kv('Starting QB', av.qb_confirmed ? 'confirmed' : 'not confirmed') +
      kv('Teammates out', (av.teammates_out || []).map(function (t) { return esc(t.name + (t.position ? ' ' + t.position : '') + ' (' + t.status + ')'); }).join(', ') || 'none on file') + '</div>' + grid(av.vacated, true) +
      ((av.widened_for || []).length ? '<div class="pp-note">The distribution was widened for: ' + esc(av.widened_for.join('; ')) + '.</div>' : ''));
    var ex = p.explain || {};
    var why = section('Why EdgeDesk differs', ['model', 'market', 'disagreement', 'support', 'risks', 'invalidators'].map(function (k) {
      var t = { model: 'What the model sees', market: 'What the market sees', disagreement: 'Why they differ', support: 'Supporting factors', risks: 'Risks', invalidators: 'What would invalidate it' }[k];
      return (ex[k] && ex[k].length) ? '<div class="pp-why"><b>' + t + '</b><ul>' + ex[k].map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' : '';
    }).join('') + '<div class="pp-note"><b>' + esc(ex.tagline || 'Research, not picks.') + '</b></div>');
    var conf = p.confidence || {}, dq = p.data_quality || {};
    var qual = section('Confidence and data quality', '<div class="pp-grid">' + kv('Confidence', (conf.score == null ? '—' : conf.score) + ' ' + esc(conf.grade || '')) + kv('Data quality', num(dq.score, 2)) + '</div>' +
      '<table class="pp-lt"><tr><th>Component</th><th>Value</th><th>Note</th></tr>' + (conf.components || []).map(function (x) { return '<tr><td>' + esc(x.label) + '</td><td class="mono">' + (x.value == null ? 'unknown' : num(x.value, 2)) + '</td><td>' + esc(x.note || '') + '</td></tr>'; }).join('') + '</table>');
    var ver = '<div class="pp-note mono">' + esc(m.model_version) + ' · features ' + esc(m.feature_version) + ' · trained through ' + esc(String(m.training_cutoff || '').slice(0, 10)) + ' · scored ' + esc(String(m.scored_at || '').slice(0, 16).replace('T', ' ')) + ' UTC · outcome tier ' + esc(m.outcome_tier) + ' · market tier ' + esc(m.market_tier) + '</div>';
    return hdr + proj + edge + market + ladders + whatIf + form + usage + matchup + envS + avS + why + qual + ver;
  }
  function bindWhatIf(p, K) {
    var L = document.getElementById('ppWiL'), P = document.getElementById('ppWiP'), out = document.getElementById('ppWiOut');
    if (!P || !out) return;
    function calc() {
      if (!K) { out.textContent = 'The pricing kernel did not load.'; return; }
      var line = L ? Number(L.value) : null, price = Math.round(Number(P.value));
      var d = p.model.dist, bern = d.t === 'bern';
      var sides = bern ? ['yes', 'no'] : ['over', 'under'];
      out.innerHTML = sides.map(function (s) {
        var e = K.evaluateQuote(d, { side: s, line: bern ? null : line, american_price: price, lineage: 'observed' }, {});
        if (!e.ok) return esc(s + ': ' + (e.reason || 'not priced'));
        return '<div>' + esc(s) + (bern ? '' : ' ' + line) + ' @ ' + am(price) + ': P ' + pct(e.model_prob) + (e.model_push ? ' (push ' + pct(e.model_push) + ')' : '') + ' · fair ' + am(e.fair_american) + ' · EV <span class="' + edgeCls(e.ev) + '">' + spct(e.ev) + '</span></div>';
      }).join('');
    }
    if (L) L.addEventListener('input', calc); P.addEventListener('input', calc); calc();
  }

  root.EDPropsUI = { load: load, loadGame: loadGame, render: render, openProp: openProp, closeProp: closeProp, state: S, researchCard: researchCard, filtered: filtered };
})(typeof self !== 'undefined' ? self : this);
