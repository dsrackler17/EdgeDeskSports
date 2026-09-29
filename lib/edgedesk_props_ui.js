/* ===========================================================================
   EDGEDESK PLAYER PROPS — the surfaces. docs/player-props/UI.md

     board(host, opts)        the Player Props research board (Research → Props)
     openProp(id, league)     the research drawer for one prop
     gameSectionHTML(l, gid)  a placeholder the game card drops in; hydrate()
                              fills it with the 3-5 most informative props
     playerPage(host, opts)   the reusable player research page (/players/…)
     analytics(host, league)  validation + live record analytics (Lab / Stats)
     recordSection(host)      the public record's player-prop section

   EVERY NUMBER comes from the committed files through EDProps: the board row
   the build evaluated, and — in the drawer — EDProps.prepare() re-run on the
   same projection, the same quotes and the same board context. The drawer
   never computes a football number and never simulates; it reads the stored
   distribution. A reader sees what the board saw, the desk saw, the record
   froze.

   Browser only: window.EDPropsUI (needs EDResearchCore + EDProps, and
   EDVocab/EDDecision for decision words when present).
   =========================================================================== */
(function (root) {
  'use strict';
  var P = root.EDProps;
  var S = { base: '', league: 'nfl', boards: {}, pidx: {}, games: {}, markets: {}, logs: {}, record: {}, validation: {}, index: null,
    f: { pos: 'ALL', group: 'ALL', prop: 'ALL', book: 'ALL', q: '', minEdge: '', minEv: '', conf: 'ALL', stage: 'ALL', dec: 'ALL', slate: 'ALL', marketOnly: false, game: null },
    sort: { k: 'ev', dir: -1 }, limit: 120, host: null };
  var PROP_LABEL = {}, GROUP_OF = {};
  function catalog() { if (!P) return; P.PROP_ORDER.forEach(function (k) { var t = P.propType(k); PROP_LABEL[k] = t.label; GROUP_OF[k] = t.group; }); }
  catalog();

  /* ---------------------------------------------------------------- utils */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function f1(x) { return isNum(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—'; }
  function f0(x) { return isNum(x) ? String(Math.round(x)) : '—'; }
  function pct(x, d) { return isNum(x) ? (100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function spct(x, d) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function pp(x) { return isNum(x) ? (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + ' pp' : '—'; }
  function am(a) { return isNum(a) ? (a > 0 ? '+' + Math.round(a) : String(Math.round(a))) : '—'; }
  function book(k) { return P ? P.bookLabel(k) : k; }
  function short(k) { var t = P && P.propType(k); return t ? t.short : k; }
  function side(s) { return s === 'over' ? 'Over' : s === 'under' ? 'Under' : s === 'yes' ? 'Yes' : s === 'no' ? 'No' : '—'; }
  function sideShort(s) { return s === 'over' ? 'o' : s === 'under' ? 'u' : s === 'yes' ? 'Yes ' : s === 'no' ? 'No ' : ''; }
  function dt(t) { var d = new Date(t); if (!isFinite(d)) return '—'; try { return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); } }
  function day(t) { var d = new Date(t); if (!isFinite(d)) return '—'; try { return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (_) { return d.toISOString().slice(0, 10); } }
  function url(p) { return (S.base || '') + p; }
  var inflight = {};
  function getJson(p, soft) {
    if (inflight[p]) return inflight[p];
    inflight[p] = fetch(url(p), { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) { if (soft && r.status === 404) return null; throw new Error('HTTP ' + r.status + ' ' + p); }
      return r.json();
    }).then(function (x) { delete inflight[p]; return x; }, function (e) { delete inflight[p]; if (soft) return null; throw e; });
    return inflight[p];
  }
  function loadLeague(L) {
    L = L.toLowerCase();
    if (S.boards[L]) return Promise.resolve(S.boards[L]);
    return Promise.all([getJson('football/props/' + L + '/board.json'), getJson('football/props/' + L + '/players_index.json', true)]).then(function (x) {
      S.boards[L] = x[0]; S.pidx[L] = x[1] && x[1].players ? x[1].players : {};
      var gmap = {}; (x[0].games || []).forEach(function (g) { gmap[g.game_id] = g; }); x[0]._games = gmap;
      return x[0];
    });
  }
  function loadGame(L, gid) {
    var k = L + '|' + gid;
    if (S.games[k] && S.markets[k] !== undefined) return Promise.resolve({ game: S.games[k], market: S.markets[k] });
    return Promise.all([getJson('football/props/' + L + '/games/' + gid + '.json'), getJson('football/props/' + L + '/markets/' + gid + '.json', true)]).then(function (x) {
      S.games[k] = x[0]; S.markets[k] = x[1] || null; return { game: x[0], market: x[1] || null };
    });
  }
  function loadLogs(L) { L = L.toLowerCase(); if (S.logs[L]) return Promise.resolve(S.logs[L]); return getJson('football/props/' + L + '/player_logs.json', true).then(function (x) { S.logs[L] = x || { players: {} }; return S.logs[L]; }); }

  /* the compact board row → a view (board.row_cols names the positions) */
  function view(row, board) {
    var g = board._games[row.gid] || {};
    var pj = row.proj || [];
    var v = { row: row, id: row.id, name: row.name, pos: row.pos, team: row.team, gid: row.gid, prop: row.prop, stage: row.stage || 'EXPERIMENTAL', status: row.status || 'PROJECTED',
      opp: g.home === row.team ? g.away : g.home, ha: g.home === row.team ? 'vs' : '@', ko: g.kickoff,
      mean: pj[0], median: pj[1], sd: pj[2], p10: pj[3], p25: pj[4], p75: pj[5], p90: pj[6], rel: row.rel, avail: row.avail,
      mkt: row.mkt || null, at: row.at_line || null, px: row.px || null, dec: row.dec || { cls: row.mkt ? 'PASS' : 'NO_DECISION', code: 'NO_MARKET', units: 0, state: 'PROJECTION_ONLY' } };
    v.line = v.mkt ? v.mkt.line : null;
    v.marketOnly = v.status === 'UNMAPPED' || v.status === 'UNMODELED' || (v.status === 'INSUFFICIENT_DATA' && !pj.length);
    if (v.marketOnly) { v.opp = g.home && g.away ? g.away + ' @ ' + g.home : ''; v.ha = ''; }
    v.diff = isNum(v.median) && isNum(v.line) ? v.median - v.line : null;
    v.dz = isNum(v.diff) && isNum(v.sd) && v.sd > 0 ? Math.abs(v.diff) / v.sd : null;
    v.edgeNv = v.px && isNum(v.px.cover) && isNum(v.px.mkt_p) ? 100 * (v.px.cover - v.px.mkt_p) : null;
    v.ev = v.px ? v.px.ev : null;
    v.decEv = v.px ? v.px.dec_p != null ? v.px.dec_ev : null : null;
    return v;
  }
  function stageBadge(st, short) {
    var c = st === 'TRACKING' ? 'trk' : st === 'RESEARCH_GRADE' ? 'rg' : st === 'PRODUCTION' ? 'prod' : 'exp';
    var lab = short ? ({ TRACKING: 'TRK', RESEARCH_GRADE: 'RG', PRODUCTION: 'PROD', EXPERIMENTAL: 'EXP' }[st] || 'EXP') : ((P && P.STAGE_LABEL[st]) || st);
    return '<span class="edp-badge ' + c + '" title="' + esc(stageHelp(st)) + '">' + esc(lab) + '</span>';
  }
  function stageHelp(st) {
    return st === 'EXPERIMENTAL' ? 'EXPERIMENTAL: this market has not passed EdgeDesk’s validation gates. It informs; it never carries a stake.'
      : st === 'TRACKING' ? 'TRACKING: passed the walk-forward gates on an untouched holdout; live predictions are frozen and graded. Stakes are capped at 0.25U until the live record validates it.'
        : st === 'RESEARCH_GRADE' ? 'RESEARCH GRADE: 200+ settled live predictions with acceptable calibration and CLV.' : 'PRODUCTION: 500+ settled live predictions, CLV interval above zero, held-out calibration.';
  }
  function decChip(d) {
    var k = (d && d.cls) || 'NO_DECISION';
    var c = k === 'BET' ? 'bet' : k === 'LEAN' ? 'lean' : k === 'WATCH' ? 'watch' : k === 'PASS' ? 'pass' : 'none';
    var lab = k === 'NO_DECISION' ? (d && d.state === 'PROJECTION_ONLY' ? 'NO MARKET' : (d && d.state === 'MARKET_ONLY' ? 'MKT ONLY' : (d && d.state === 'INSUFFICIENT_DATA' ? 'INSUFF. DATA' : (d && d.state === 'BAD_MAPPING' ? 'MAPPING' : 'NO DECISION')))) : k;
    return '<span class="edp-dec ' + c + '" title="' + esc(d && d.code ? P.reasonText(d.code) : '') + '">' + esc(lab) + (k === 'BET' && d.units ? ' ' + d.units.toFixed(2) + 'U' : '') + '</span>';
  }
  function relBar(score) {
    if (!isNum(score)) return '<span class="edp-faint">—</span>';
    return '<span class="edp-rel"><i><b style="width:' + Math.max(4, Math.min(100, score)) + '%"></b></i><span class="num">' + Math.round(score) + '</span></span>';
  }
  function bestText(v, twoLine) {
    if (!v.px) return v.mkt && v.mkt.bo ? 'o' + f1(v.mkt.bo[2]) + ' ' + am(v.mkt.bo[1]) + (twoLine ? '<span class="s2">' + esc(book(v.mkt.bo[0])) + '</span>' : '') : '—';
    var t = sideShort(v.px.side) + (v.px.side === 'yes' || v.px.side === 'no' ? '' : f1(v.px.line)) + ' ' + am(v.px.am);
    return twoLine ? t + '<span class="s2">' + esc(book(v.px.book)) + '</span>' : t + ' <span class="edp-faint">' + esc(book(v.px.book)) + '</span>';
  }
  function subLine(v) {
    if (v.marketOnly) return v.status === 'UNMAPPED' ? 'unmatched book name' : (v.status === 'UNMODELED' ? 'market only · not modeled' : 'market only · no data');
    return v.pos + ' · ' + v.team + ' ' + v.ha + ' ' + (v.opp || '');
  }

  /* ================================================================ BOARD */
  function filtered(board) {
    var F = S.f, out = [];
    board.rows.forEach(function (r) {
      var v = view(r, board);
      if (F.game && v.gid !== F.game) return;
      if (F.pos !== 'ALL' && v.pos !== F.pos) return;
      if (F.group !== 'ALL' && GROUP_OF[v.prop] !== F.group && !(F.group === 'Receiving' && v.prop === 'receptions')) return;
      if (F.prop !== 'ALL' && v.prop !== F.prop) return;
      if (F.marketOnly && !v.mkt) return;
      if (F.book !== 'ALL' && !(v.mkt && v.mkt.bl && v.mkt.bl.indexOf(F.book) >= 0) && !(v.px && v.px.book === F.book)) return;
      if (F.q && (v.name + ' ' + v.team + ' ' + v.opp).toLowerCase().indexOf(F.q.toLowerCase()) < 0) return;
      if (F.minEdge !== '' && !(isNum(v.px && v.px.edge) && v.px.edge >= +F.minEdge)) return;
      if (F.minEv !== '' && !(isNum(v.ev) && 100 * v.ev >= +F.minEv)) return;
      if (F.conf === 'HIGH' && !(v.rel >= 75)) return;
      if (F.conf === 'MEDIUM' && !(v.rel >= 60)) return;
      if (F.conf === 'LOW' && !(v.rel >= 40)) return;
      if (F.stage === 'VALIDATED' && v.stage === 'EXPERIMENTAL') return;
      if (F.stage === 'EXPERIMENTAL' && v.stage !== 'EXPERIMENTAL') return;
      if (F.dec === 'ACTION' && !(v.dec.cls === 'BET' || v.dec.cls === 'LEAN')) return;
      if (F.dec !== 'ALL' && F.dec !== 'ACTION' && v.dec.cls !== F.dec && !(F.dec === 'NONE' && v.dec.cls === 'NO_DECISION')) return;
      if (F.slate !== 'ALL' && day(v.ko) !== F.slate) return;
      out.push(v);
    });
    var k = S.sort.k, dir = S.sort.dir;
    var key = function (v) {
      switch (k) {
        case 'ev': return isNum(v.ev) ? v.ev : (isNum(v.dz) ? -5 + v.dz / 100 : -9);
        case 'edge': return isNum(v.px && v.px.edge) ? v.px.edge : -99;
        case 'rel': return isNum(v.rel) ? v.rel : -1;
        case 'disagree': return isNum(v.dz) ? v.dz : -1;
        case 'price': return v.px && isNum(v.px.am) ? (v.px.am > 0 ? v.px.am : -10000 / v.px.am) : -9999;
        case 'player': return v.name;
        case 'time': return Date.parse(v.ko) || 0;
        case 'move': return v.mkt && isNum(v.mkt.move) ? Math.abs(v.mkt.move) : -1;
        case 'proj': return isNum(v.mean) ? v.mean : -1;
        default: return 0;
      }
    };
    out.sort(function (a, b) { var x = key(a), y = key(b); if (x < y) return -dir; if (x > y) return dir; return (a.name < b.name ? -1 : 1); });
    return out;
  }
  function board(host, opts) {
    opts = opts || {};
    S.host = host; S.base = opts.base != null ? opts.base : S.base;
    if (opts.league) S.league = opts.league.toLowerCase();
    if (opts.game) S.f.game = opts.game;
    host.classList.add('edp');
    host.innerHTML = '<div class="empty">Loading player props…</div>';
    return loadLeague(S.league).then(function (b) { paint(); return b; }, function (e) {
      host.innerHTML = '<div class="empty">Player props are not available right now (' + esc(e.message) + '). Nothing is shown rather than something invented.</div>';
    });
  }
  function kpis(b) {
    var c = b.counts || {};
    var tr = Object.keys(b.stages || {}).filter(function (k) { return b.stages[k].stage !== 'EXPERIMENTAL'; }).map(function (k) { return PROP_LABEL[k] || k; });
    return '<div class="edp-kpis">' +
      '<div class="edp-kpi"><div class="l">Props projected</div><div class="v">' + (c.projected || 0) + '</div><div class="s">' + (b.games || []).length + ' games · ' + esc(b.model_version) + '</div></div>' +
      '<div class="edp-kpi"><div class="l">Priced by books</div><div class="v">' + (c.with_market || 0) + '</div><div class="s">' + (b.market_captured_at ? 'captured ' + esc(dt(b.market_captured_at)) : 'no capture on file') + '</div></div>' +
      '<div class="edp-kpi"><div class="l">BET · LEAN · WATCH</div><div class="v">' + (c.BET || 0) + ' · ' + (c.LEAN || 0) + ' · ' + (c.WATCH || 0) + '</div><div class="s">PASS ' + (c.PASS || 0) + '</div></div>' +
      '<div class="edp-kpi"><div class="l">Validated markets</div><div class="v">' + tr.length + '</div><div class="s">' + esc(tr.slice(0, 3).join(', ') || 'none yet') + (tr.length > 3 ? '…' : '') + '</div></div></div>';
  }
  function paint() {
    var b = S.boards[S.league], host = S.host;
    if (!b || !host) return;
    var F = S.f;
    var slates = []; (b.games || []).forEach(function (g) { var d = day(g.kickoff); if (slates.indexOf(d) < 0) slates.push(d); });
    var groups = ['Passing', 'Rushing', 'Receiving', 'Touchdowns'];
    var props = P.PROP_ORDER.filter(function (k) { return b.rows.some(function (r) { return r.prop === k; }); });
    var books = {}; b.rows.forEach(function (r) { if (r.mkt && r.mkt.bl) r.mkt.bl.forEach(function (k) { books[k] = 1; }); if (r.px && r.px.book) books[r.px.book] = 1; });
    var list = filtered(b);
    var html = '';
    html += '<div class="edp-chips" role="tablist" aria-label="League">' + ['nfl', 'cfb'].map(function (L) { return '<button class="edp-chip' + (L === S.league ? ' on' : '') + '" data-league="' + L + '">' + L.toUpperCase() + '</button>'; }).join('') +
      '<span style="flex:1"></span>' + ['ALL', 'QB', 'RB', 'WR', 'TE'].map(function (p) { return '<button class="edp-chip' + (F.pos === p ? ' on' : '') + '" data-pos="' + p + '">' + (p === 'ALL' ? 'All positions' : p) + '</button>'; }).join('') + '</div>';
    if (!b.market_captured_at) html += '<div class="edp-banner warn"><b>Projection only.</b> ' + esc(b.market_note || 'No sportsbook prop capture on file.') + ' Fair lines, fair odds and full distributions are shown; EV and decisions appear only against a real, fresh sportsbook price.</div>';
    html += kpis(b);
    html += '<div class="edp-filters">' +
      sel('slate', 'Slate', [['ALL', 'All games']].concat(slates.map(function (d) { return [d, d]; }))) +
      sel('group', 'Market', [['ALL', 'All markets']].concat(groups.map(function (g) { return [g, g]; }))) +
      sel('prop', 'Prop', [['ALL', 'All props']].concat(props.filter(function (k) { return F.group === 'ALL' || GROUP_OF[k] === F.group || (F.group === 'Receiving' && k === 'receptions'); }).map(function (k) { return [k, PROP_LABEL[k]]; }))) +
      sel('book', 'Book', [['ALL', 'Any sportsbook']].concat(Object.keys(books).sort().map(function (k) { return [k, book(k)]; }))) +
      sel('conf', 'Reliability', [['ALL', 'Any reliability'], ['HIGH', 'High (75+)'], ['MEDIUM', 'Moderate+ (60+)'], ['LOW', 'Low+ (40+)']]) +
      sel('stage', 'Stage', [['ALL', 'All stages'], ['VALIDATED', 'Tracking or better'], ['EXPERIMENTAL', 'Experimental only']]) +
      sel('dec', 'Decision', [['ALL', 'All decisions'], ['ACTION', 'BET + LEAN'], ['WATCH', 'WATCH'], ['PASS', 'PASS'], ['NONE', 'No decision']]) +
      '<label>Min edge <input type="number" step="0.5" data-f="minEdge" value="' + esc(F.minEdge) + '" placeholder="pp"></label>' +
      '<label>Min EV <input type="number" step="0.5" data-f="minEv" value="' + esc(F.minEv) + '" placeholder="%"></label>' +
      '<button class="edp-toggle' + (F.marketOnly ? ' on' : '') + '" data-toggle="marketOnly" aria-pressed="' + (F.marketOnly ? 'true' : 'false') + '">Best price only</button>' +
      '<input type="search" data-f="q" placeholder="Search player or team" value="' + esc(F.q) + '" aria-label="Search player"></div>';
    if (F.game) { var gg = b._games[F.game]; html += '<div class="edp-banner">Showing one game: <b>' + esc(gg ? gg.away + ' @ ' + gg.home : F.game) + '</b> · <a href="#" data-clear-game="1">show every game</a></div>'; }
    var cols = [['player', 'Player', 'l'], ['prop', 'Prop', 'l'], ['line', 'Line'], ['price', 'Best price'], ['fair', 'Fair line'], ['proj', 'Proj'], ['po', 'P(O/U)'], ['fo', 'Fair odds'], ['edge', 'Edge'], ['ev', 'EV'], ['dec', 'Decision'], ['rel', 'Reliab.'], ['move', 'Move']];
    var sortable = { player: 'player', price: 'price', proj: 'proj', edge: 'edge', ev: 'ev', rel: 'rel', move: 'move', fair: 'disagree', line: 'time' };
    var shown = list.slice(0, S.limit);
    html += '<div class="edp-tblwrap"><table class="edp-tbl"><thead><tr>' + cols.map(function (c) { var sk = sortable[c[0]]; return '<th class="' + (c[2] || '') + (sk && S.sort.k === sk ? ' on' : '') + '"' + (sk ? ' data-sort="' + sk + '"' : '') + ' title="' + esc(COL_HELP[c[0]] || (sk ? 'Sort' : '')) + '">' + c[1] + (sk && S.sort.k === sk ? (S.sort.dir < 0 ? ' ↓' : ' ↑') : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
    html += shown.map(function (v) {
      var fo = v.at ? (v.px && (v.px.side === 'under' || v.px.side === 'no') ? v.at[3] : v.at[2]) : null;
      return '<tr class="r" tabindex="0" data-id="' + esc(v.id) + '"><td class="l"><span class="edp-pl">' + esc(v.name) + '<span class="sub">' + esc(subLine(v)) + (v.avail ? ' · <span class="edp-warn">' + esc(v.avail[0]) + '</span>' : '') + '</span></span></td>' +
        '<td class="l"><span class="edp-prop">' + esc(short(v.prop)) + '</span> ' + (v.marketOnly ? '' : stageBadge(v.stage, true)) + '</td>' +
        '<td>' + (isNum(v.line) ? f1(v.line) : '—') + (v.mkt ? '<span class="s2">' + v.mkt.books + ' book' + (v.mkt.books === 1 ? '' : 's') + '</span>' : '') + '</td>' +
        '<td>' + bestText(v, true) + '</td><td>' + f1(v.median) + (isNum(v.diff) ? '<span class="s2 ' + (v.diff > 0 ? 'edp-pos' : 'edp-neg') + '">' + (v.diff > 0 ? '+' : '−') + f1(Math.abs(v.diff)) + '</span>' : '') + '</td>' +
        '<td>' + f1(v.mean) + '</td><td>' + (v.at ? pct(v.at[0]) + '<span class="s2">' + pct(v.at[1]) + ' under</span>' : '—') + '</td><td>' + am(fo) + '</td>' +
        '<td class="' + (v.px && v.px.edge > 0 ? 'edp-pos' : '') + '">' + (v.px ? pp(v.px.edge) : '—') + '</td><td class="' + (v.ev > 0 ? 'edp-pos' : (v.ev < 0 ? 'edp-neg' : '')) + '">' + (isNum(v.ev) ? spct(v.ev) : '—') + '</td>' +
        '<td>' + decChip(v.dec) + '</td><td>' + relBar(v.rel) + '</td><td>' + (v.mkt && isNum(v.mkt.move) && v.mkt.move !== 0 ? (v.mkt.move > 0 ? '+' : '−') + f1(Math.abs(v.mkt.move)) : '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
    html += '<div class="edp-cards">' + shown.map(cardHTML).join('') + '</div>';
    if (!list.length) html += '<div class="empty">No props match these filters.</div>';
    if (list.length > shown.length) html += '<button class="edp-more" data-more="1">Show more (' + (list.length - shown.length) + ' more)</button>';
    html += '<p class="edp-note">Research, not picks. Fair line = the median of EdgeDesk’s simulated distribution; P(Over/Under) at the consensus line; edge = EdgeDesk probability minus the break-even of the best price; EV at that exact price. Reliability measures how much the number can be trusted (data, sample, role stability, availability, market depth, calibration) — never the size of the edge. Decisions use a risk-adjusted probability and the same BET / LEAN / WATCH / PASS rules as game markets. Model ' + esc(b.model_version) + ' · built ' + esc(dt(b.generated_at || b.as_of)) + '.</p>';
    host.innerHTML = html;
    wire(host);
  }
  var COL_HELP = { po: 'P(Over) at the consensus line, with P(Under) beneath: EdgeDesk’s distribution, not the market', fo: 'Fair American odds of the side EdgeDesk prices', edge: 'EdgeDesk probability minus the break-even of the best price, in points',
    ev: 'Expected value per 1U at the best price (sorts)', fair: 'The median of EdgeDesk’s simulated distribution, and how far it sits from the book line (sorts by disagreement)', rel: 'How much the number can be trusted — never the size of the edge (sorts)',
    move: 'Consensus line move since EdgeDesk’s first capture (sorts)', price: 'Best price for EdgeDesk’s side at the consensus line (sorts)', line: 'The consensus line books deal (sorts by kickoff)' };
  function sel(f, label, opts) { return '<select data-f="' + f + '" aria-label="' + esc(label) + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (S.f[f] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }
  function cardHTML(v) {
    return '<div class="edp-card" tabindex="0" data-id="' + esc(v.id) + '"><div class="top"><div><div class="edp-pl">' + esc(v.name) + '<span class="sub">' + esc(subLine(v) + ' · ' + day(v.ko)) + '</span></div>' +
      '<div style="margin-top:4px"><span class="edp-prop">' + esc(PROP_LABEL[v.prop] || v.prop) + '</span> ' + (v.marketOnly ? '' : stageBadge(v.stage)) + (v.avail ? ' <span class="edp-badge st">' + esc(v.avail[0]) + '</span>' : '') + '</div></div>' + decChip(v.dec) + '</div>' +
      '<div class="grid"><div><div class="l">Market</div><div class="v">' + (isNum(v.line) ? f1(v.line) : '—') + '</div></div><div><div class="l">Fair line</div><div class="v">' + f1(v.median) + '</div></div><div><div class="l">Projection</div><div class="v">' + f1(v.mean) + '</div></div>' +
      '<div><div class="l">Best price</div><div class="v">' + (v.px ? sideShort(v.px.side) + f1(v.px.line) + ' ' + am(v.px.am) : '—') + '</div></div><div><div class="l">P(' + (v.px && (v.px.side === 'under' || v.px.side === 'no') ? 'Under' : 'Over') + ')</div><div class="v">' + (v.px ? pct(v.px.cover) : (v.at ? pct(v.at[0]) : '—')) + '</div></div><div><div class="l">EV</div><div class="v ' + (v.ev > 0 ? 'edp-pos' : '') + '">' + (isNum(v.ev) ? spct(v.ev) : '—') + '</div></div>' +
      '<div><div class="l">Edge</div><div class="v">' + (v.px ? pp(v.px.edge) : '—') + '</div></div><div><div class="l">Fair odds</div><div class="v">' + (v.px ? am(v.px.fair) : '—') + '</div></div><div><div class="l">Reliability</div><div class="v">' + (isNum(v.rel) ? Math.round(v.rel) : '—') + '</div></div></div>' +
      (v.row.why && v.row.why.length ? '<div class="why">' + esc(v.row.why[0]) + '</div>' : '') + '</div>';
  }
  function wire(host) {
    var q = function (s) { return host.querySelectorAll(s); };
    Array.prototype.forEach.call(q('[data-league]'), function (el) { el.onclick = function () { S.league = el.getAttribute('data-league'); S.f.game = null; S.f.prop = 'ALL'; S.f.book = 'ALL'; S.limit = 120; host.innerHTML = '<div class="empty">Loading…</div>'; loadLeague(S.league).then(paint, function (e) { host.innerHTML = '<div class="empty">' + esc(S.league.toUpperCase()) + ' player props are not available (' + esc(e.message) + ').</div>'; }); }; });
    Array.prototype.forEach.call(q('[data-pos]'), function (el) { el.onclick = function () { S.f.pos = el.getAttribute('data-pos'); paint(); }; });
    Array.prototype.forEach.call(q('select[data-f]'), function (el) { el.onchange = function () { S.f[el.getAttribute('data-f')] = el.value; if (el.getAttribute('data-f') === 'group') S.f.prop = 'ALL'; paint(); }; });
    Array.prototype.forEach.call(q('input[data-f]'), function (el) { var t = null; el.oninput = function () { clearTimeout(t); t = setTimeout(function () { S.f[el.getAttribute('data-f')] = el.value; var pos = el.selectionStart; paint(); var n = S.host.querySelector('input[data-f="' + el.getAttribute('data-f') + '"]'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} } }, 220); }; });
    Array.prototype.forEach.call(q('[data-toggle]'), function (el) { el.onclick = function () { var k = el.getAttribute('data-toggle'); S.f[k] = !S.f[k]; paint(); }; });
    Array.prototype.forEach.call(q('[data-sort]'), function (el) { el.onclick = function () { var k = el.getAttribute('data-sort'); if (S.sort.k === k) S.sort.dir = -S.sort.dir; else { S.sort.k = k; S.sort.dir = k === 'player' || k === 'time' ? 1 : -1; } paint(); }; });
    Array.prototype.forEach.call(q('[data-id]'), function (el) { var go = function () { openProp(el.getAttribute('data-id'), S.league); }; el.onclick = go; el.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } }; });
    Array.prototype.forEach.call(q('[data-more]'), function (el) { el.onclick = function () { S.limit += 150; paint(); }; });
    Array.prototype.forEach.call(q('[data-clear-game]'), function (el) { el.onclick = function (e) { e.preventDefault(); S.f.game = null; paint(); }; });
  }

  /* ================================================================ DRAWER */
  function findRow(L, id) { var b = S.boards[L]; if (!b) return null; for (var i = 0; i < b.rows.length; i++) if (b.rows[i].id === id) return b.rows[i]; return null; }
  function evaluateProp(L, id) {
    return loadLeague(L).then(function (b) {
      var row = findRow(L, id);
      if (!row) throw new Error('This prop is no longer on the board.');
      return loadGame(L, row.gid).then(function (gm) {
        var rec = null;
        (gm.game.projections || []).forEach(function (x) { if (x.projection_id === id) rec = x; });
        var key = row.gid + '|' + row.pid + '|' + row.prop;
        var mk = gm.market || {};
        var quotes = mk.props && mk.props[key] ? mk.props[key] : [];
        var proj = rec ? P.hydrate(gm.game, rec) : { league: b.league, game_id: row.gid, player_id: row.pid, player_name: row.name, prop_type: row.prop, status: row.status || 'INSUFFICIENT_DATA', missing: row.miss || [], projection_id: id, stage: row.stage };
        var out = P.prepare(proj, quotes, { now: Date.now(), stages: b.stages, cv_norm: b.cv_norm, calibration: b.calibration, history: mk.history ? mk.history[key] : null, open: mk.open ? mk.open[key] : null });
        return { board: b, row: row, game: gm.game, market: mk, quotes: quotes, projection: out.projection, ev: out.evaluation };
      });
    });
  }
  function openProp(id, L) {
    L = (L || S.league).toLowerCase();
    var ov = document.createElement('div');
    ov.className = 'edp-ov edp';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Player prop research');
    ov.innerHTML = '<div class="edp-drawer"><button class="x" aria-label="Close">×</button><div class="empty">Loading the research…</div></div>';
    document.body.appendChild(ov);
    /* the drawer is addressable (#research/props/<league>|<id>) only when it is
       opened on the Props panel itself; closing it steps back off the entry it
       pushed, so Back and the × agree. From a game card it leaves the URL alone. */
    var pushed = false;
    var close = function (fromHistory) {
      try { document.body.removeChild(ov); } catch (_) {}
      document.removeEventListener('keydown', onKey);
      if (pushed && !fromHistory) { pushed = false; try { if (/^#research\/props\/./.test(location.hash || '')) history.back(); } catch (_) {} }
    };
    ov.__close = close;
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.onclick = function (e) { if (e.target === ov) close(); };
    ov.querySelector('.x').onclick = function () { close(); };
    try { if (root.researchSetHash && root.RESEARCH_SUB === 'props' && !/^#research\/props\/./.test(location.hash || '')) { root.researchSetHash('props', L + '|' + id, true); pushed = true; } } catch (_) {}
    evaluateProp(L, id).then(function (x) {
      var d = ov.querySelector('.edp-drawer');
      d.innerHTML = '<button class="x" aria-label="Close">×</button>' + drawerHTML(x, L);
      d.querySelector('.x').onclick = function () { close(); };
      wireDrawer(d, x, L, close);
    }, function (e) { ov.querySelector('.edp-drawer').innerHTML = '<button class="x" aria-label="Close">×</button><div class="empty">' + esc(e.message) + '</div>'; ov.querySelector('.x').onclick = function () { close(); }; });
  }
  function drawerHTML(x, L) {
    var p = x.projection, ev = x.ev, row = x.row, b = x.board, g = b._games[row.gid] || {};
    var sm = p.summary || {}, c = ev.consensus || {}, rec = ev.recommended || ev.best, fa = ev.fair && ev.fair.at_market;
    var opp = g.home === row.team ? g.away : g.home;
    var units = row.dec ? row.dec.units : ev.units;
    var h = '';
    h += '<div class="edp-h2">' + esc((row.pos || '') + ' · ' + row.team + (g.home === row.team ? ' vs ' : ' @ ') + (opp || '') + ' · ' + dt(g.kickoff)) + '</div>';
    h += '<div class="edp-h1">' + esc(row.name) + '</div>';
    h += '<div style="margin:0 0 10px"><span class="edp-prop" style="font-size:14px;font-weight:700">' + esc(PROP_LABEL[row.prop] || row.prop) + '</span> ' + stageBadge(p.stage || row.stage) + ' <span class="edp-badge">Tier ' + (P.tierOf(row.prop, row.pos) || '—') + '</span>' +
      (p.availability && p.availability.status !== 'ACTIVE' ? ' <span class="edp-badge st">' + esc(p.availability.status) + '</span>' : '') + '</div>';
    /* the action */
    var cls = ev.decision, cl = cls === 'BET' ? 'bet' : cls === 'LEAN' ? 'lean' : cls === 'WATCH' ? 'watch' : '';
    h += '<div class="edp-action ' + cl + '"><div class="k">EdgeDesk decision</div><div class="t">' + esc(cls === 'NO_DECISION' ? 'NO DECISION' : cls) + (cls === 'BET' && units ? ' · ' + units.toFixed(2) + 'U' : '') + (rec && cls !== 'NO_DECISION' && cls !== 'PASS' ? ' — ' + esc(side(rec.side) + ' ' + (rec.side === 'yes' || rec.side === 'no' ? '' : f1(rec.line)) + ' ' + am(rec.american) + ' · ' + book(rec.book)) : '') + '</div>' +
      '<div class="d">' + esc(ev.reason || '') + (ev.watch_trigger && ev.watch_trigger.text ? ' <b>Would change:</b> ' + esc(ev.watch_trigger.text) + '.' : '') + (ev.caps && ev.caps.length ? '<br><span class="edp-faint">Capped by: ' + esc(ev.caps.map(function (k) { return k.replace(/_/g, ' ').toLowerCase(); }).join(', ')) + '</span>' : '') +
      (cls === 'BET' && row.dec && row.dec.exposure_capped ? '<br><span class="edp-faint">Units reduced by the card’s exposure caps (player, game, team, correlated group).</span>' : '') + '</div></div>';
    /* the hero numbers */
    var sideRec = rec ? rec.side : (fa && fa.p_over >= fa.p_under ? 'over' : 'under');
    h += '<div class="edp-hero">' +
      heroC('Book line', c.books ? f1(c.consensus_line) : '—', c.books ? c.books + ' book' + (c.books === 1 ? '' : 's') : 'no market') +
      heroC('EdgeDesk proj.', f1(sm.mean), 'median ' + f1(sm.median)) +
      heroC('Fair line', f1(sm.fair_line), fa ? (fa.diff > 0 ? '+' : '−') + f1(Math.abs(fa.diff)) + ' vs book' : 'the distribution’s median') +
      heroC('P(' + side(sideRec) + ')', rec ? pct(rec.model_cover) : (fa ? pct(sideRec === 'under' ? fa.p_under : fa.p_over) : '—'), rec ? 'fair ' + am(rec.fair_american) : (fa ? 'fair ' + am(sideRec === 'under' ? fa.fair_under : fa.fair_over) : '')) +
      heroC('Best price', rec ? sideShort(rec.side) + (rec.side === 'yes' || rec.side === 'no' ? '' : f1(rec.line)) + ' ' + am(rec.american) : '—', rec ? book(rec.book) + ' · BE ' + pct(rec.break_even) : '') +
      heroC('No-vig market', rec && isNum(rec.market_prob) ? pct(rec.market_prob) : '—', rec ? esc(rec.market_prob_source || '') : '') +
      heroC('Edge', rec ? pp(rec.edge_pp) : '—', rec && isNum(rec.market_prob) ? 'vs no-vig ' + pp(100 * (rec.model_cover - rec.market_prob)) : 'vs break-even') +
      heroC('EV', rec ? spct(rec.ev) : '—', rec && isNum(rec.decision_ev) ? 'risk-adjusted ' + spct(rec.decision_ev) : '') + '</div>';
    h += '<div class="edp-links"><button class="primary" data-ask="1">Ask the Research Desk about this prop</button><a href="' + esc(url('players/?p=' + L + '/' + slugOf(L, row.pid, row.name))) + '">Player page</a>' +
      (root.researchGo ? '<button data-game="' + esc(row.gid) + '">Game research</button>' : '') + '<button data-allgame="' + esc(row.gid) + '">All props in this game</button></div>';
    /* why and risks */
    h += sec('Why EdgeDesk ' + (rec ? 'leans ' + side(rec.side) : 'sees it this way'), (ev.why && ev.why.length ? '<ul class="edp-list why">' + ev.why.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '<div class="edp-dim">No single driver dominates this projection.</div>'));
    h += sec('Risks · what could make this wrong', (ev.risks && ev.risks.length ? '<ul class="edp-list risk">' + ev.risks.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '<div class="edp-dim">No specific risk flagged beyond the width of the distribution below.</div>') +
      (p.soft_missing && p.soft_missing.length ? '<div class="edp-note">Inputs missing or thin: ' + esc(p.soft_missing.join(', ').toLowerCase().replace(/_/g, ' ')) + '.</div>' : ''));
    /* market */
    h += sec('Market', marketHTML(x), c.freshness ? esc(c.freshness.state + ' · ' + c.freshness.text) : 'no capture');
    /* distribution */
    if (p.dist) h += sec('Distribution', distSVG(p, c.books ? c.consensus_line : null) + '<div class="edp-legend"><span><i style="background:#2fa79a"></i>book line</span><span><i style="background:#e3b84d"></i>median (fair line)</span><span><i style="background:#d274b0"></i>mean</span><span><i style="background:rgba(170,156,135,.35);height:8px"></i>80% interval</span></div>' +
      '<div class="edp-line"><span>Percentiles 10 / 25 / 50 / 75 / 90</span><span class="v">' + [sm.p10, sm.p25, sm.p50, sm.p75, sm.p90].map(f0).join(' / ') + '</span></div><div class="edp-line"><span>Standard deviation</span><span class="v">' + f1(sm.sd) + '</span></div>' +
      (p.availability && p.availability.conditional_on_playing ? '<div class="edp-note">Conditional on playing: books void a prop when the player does not play, so this is the distribution in the games he plays.</div>' : '') +
      (p.calibration ? '<div class="edp-note">Calibrated (λ ' + p.calibration.lambda + ', κ ' + p.calibration.kappa + ', fitted on ' + esc(p.calibration.fitted_on) + '): ' + esc(p.calibration.basis) + '.</div>' : ''), esc(P.propType(row.prop) ? P.propType(row.prop).family : ''));
    /* alternate lines */
    h += sec('Every line and price', ladderHTML(ev) + calcHTML(p), 'price sensitivity');
    /* opportunity, form, matchup, availability, environment */
    h += sec('Opportunity', oppHTML(p, row));
    h += sec('Recent form', formHTML(p), 'shown, not chased');
    h += sec('Matchup', matchupHTML(x));
    h += sec('Availability', availHTML(x));
    h += sec('Game environment', envHTML(x));
    h += sec('Reliability ' + (ev.reliability && isNum(ev.reliability.score) ? ev.reliability.score + ' / 100' : ''), relHTML(ev, b, row));
    var corr = corrHTML(x);
    if (corr) h += sec('Correlated props in this game', corr, 'never assumed independent');
    h += '<p class="edp-note">Research, not picks. Model ' + esc(p.model_version || b.model_version) + ' · projection ' + esc(p.projection_id) + (p.inputs_hash ? ' · inputs ' + esc(p.inputs_hash) : '') + ' · as of ' + esc(dt(p.as_of)) + '. ' + esc((root.EDVocab && root.EDVocab.COPY && root.EDVocab.COPY.responsible) || 'Signals can be wrong. 21+. Bet responsibly.') + '</p>';
    return h;
  }
  function heroC(l, v, s) { return '<div class="c"><div class="l">' + l + '</div><div class="v">' + v + '</div><div class="s">' + (s || '') + '</div></div>'; }
  function sec(title, body, right) { return '<div class="edp-sec"><h3><span>' + esc(title) + '</span>' + (right ? '<span class="r">' + right + '</span>' : '') + '</h3>' + body + '</div>'; }
  function slugOf(L, pid, name) { var r = S.pidx[L] && S.pidx[L][pid]; return r ? r[1] : (P ? P.slugify(name) : pid); }
  function marketHTML(x) {
    var ev = x.ev, c = ev.consensus || {}, mv = ev.movement || {};
    if (!c.books) return '<div class="edp-dim">No sportsbook has been captured dealing this prop. EdgeDesk’s fair line and fair odds stand on their own; no EV is claimed without a real price.</div>';
    var h = '<div class="edp-line"><span>Consensus line</span><span class="v">' + f1(c.consensus_line) + (c.line_range ? ' <span class="edp-faint">(range ' + f1(c.line_range) + ')</span>' : '') + '</span></div>' +
      '<div class="edp-line"><span>No-vig Over / Under</span><span class="v">' + pct(c.novig_over) + ' / ' + pct(c.novig_under) + (c.novig_books ? ' <span class="edp-faint">' + c.novig_books + ' bk</span>' : '') + '</span></div>' +
      '<div class="edp-line"><span>Median hold</span><span class="v">' + pct(c.hold_median) + '</span></div>' +
      '<div class="edp-line"><span>Best Over / Under</span><span class="v">' + (c.best_over ? am(c.best_over.price) + ' ' + book(c.best_over.book) : '—') + ' / ' + (c.best_under ? am(c.best_under.price) + ' ' + book(c.best_under.book) : '—') + '</span></div>' +
      '<div class="edp-line"><span>Best line (Over / Under)</span><span class="v">' + (c.best_line_over ? 'o' + f1(c.best_line_over.line) + ' ' + am(c.best_line_over.price) : '—') + ' / ' + (c.best_line_under ? 'u' + f1(c.best_line_under.line) + ' ' + am(c.best_line_under.price) : '—') + '</span></div>' +
      '<div class="edp-line"><span>Opening → current</span><span class="v">' + (mv.opening ? f1(mv.opening.line) : '—') + ' → ' + (mv.current ? f1(mv.current.line) : f1(c.consensus_line)) + '</span></div>' +
      (mv.text ? '<div class="edp-note">' + esc(mv.text) + (isNum(mv.novig_move_pp) ? ' · no-vig Over ' + pp(mv.novig_move_pp) : '') + '. ' + esc((mv.opening && mv.opening.basis) || 'The opening is the first capture EdgeDesk made, not necessarily the book’s opener.') + '</div>' : '');
    var mains = (x.quotes || []).filter(function (q) { return !q.is_alternate; });
    if (mains.length) h += '<table class="edp-mini" style="margin-top:8px"><thead><tr><th class="l">Book</th><th>Line</th><th>Over</th><th>Under</th><th>Hold</th><th>No-vig O</th><th>Captured</th></tr></thead><tbody>' +
      mains.map(function (q) { var m = P.quoteMath(q); return '<tr><td class="l">' + esc(book(q.book)) + '</td><td>' + f1(q.line) + '</td><td>' + am(q.over) + '</td><td>' + am(q.under) + '</td><td>' + pct(m.hold) + '</td><td>' + pct(m.novig_over) + '</td><td>' + esc(P.freshness(q.captured_at, Date.now()).text) + '</td></tr>'; }).join('') + '</tbody></table>';
    if (c.sharp) h += '<div class="edp-note">Sharp reference: ' + esc(book(c.sharp.book)) + ' ' + f1(c.sharp.line) + ' (no-vig Over ' + pct(c.sharp.novig_over) + '), reported beside the consensus, never substituted for it.</div>';
    var hist = x.market && x.market.history ? x.market.history[x.row.gid + '|' + x.row.pid + '|' + x.row.prop] : null;
    if (hist && hist.length > 1) h += spark(hist);
    return h;
  }
  function spark(hist) {
    var W = 320, H = 44, ls = hist.map(function (x) { return x.line; }), lo = Math.min.apply(null, ls), hi = Math.max.apply(null, ls);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var pts = hist.map(function (x, i) { return (i / (hist.length - 1) * (W - 8) + 4).toFixed(1) + ',' + (H - 6 - (x.line - lo) / (hi - lo) * (H - 12)).toFixed(1); }).join(' ');
    return '<svg class="edp-dist" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Consensus line history"><polyline points="' + pts + '" fill="none" stroke="#2fa79a" stroke-width="2"/></svg><div class="edp-note">Consensus line across ' + hist.length + ' captures (' + f1(ls[0]) + ' → ' + f1(ls[ls.length - 1]) + ').</div>';
  }
  function distSVG(p, line) {
    var d = p.dist, sm = p.summary || {};
    var n = d.pmf.length, W = 640, H = 170, pad = 22;
    var group = Math.max(1, Math.ceil(n / 70)), bins = [];
    for (var i = 0; i < n; i += group) { var s = 0; for (var j = i; j < Math.min(n, i + group); j++) s += d.pmf[j]; bins.push({ x0: d.lo + i, x1: d.lo + Math.min(n, i + group) - 1, v: s / d.n }); }
    var vmax = Math.max.apply(null, bins.map(function (b) { return b.v; })) || 1, lo = d.lo - 0.5, hi = d.lo + n - 0.5;
    var X = function (v) { return pad + (v - lo) / (hi - lo) * (W - 2 * pad); };
    var bw = (W - 2 * pad) / bins.length;
    var svg = '<svg class="edp-dist" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Outcome distribution">';
    if (isNum(sm.p10) && isNum(sm.p90)) svg += '<rect x="' + X(sm.p10 - 0.5).toFixed(1) + '" y="4" width="' + Math.max(1, X(sm.p90 + 0.5) - X(sm.p10 - 0.5)).toFixed(1) + '" height="' + (H - pad - 4) + '" fill="rgba(170,156,135,.12)"/>';
    bins.forEach(function (b, k) {
      var h = b.v / vmax * (H - pad - 12);
      var over = isNum(line) && b.x0 > line;
      svg += '<rect x="' + (pad + k * bw + 0.5).toFixed(1) + '" y="' + (H - pad - h).toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (over ? 'rgba(47,167,154,.75)' : 'rgba(170,156,135,.55)') + '"><title>' + b.x0 + (b.x1 !== b.x0 ? '–' + b.x1 : '') + ': ' + (100 * b.v).toFixed(1) + '%</title></rect>';
    });
    var mark = function (v, col, lab, dash, top) { if (!isNum(v)) return ''; var xx = X(v).toFixed(1); return '<line x1="' + xx + '" x2="' + xx + '" y1="' + (top ? 14 : 4) + '" y2="' + (H - pad) + '" stroke="' + col + '" stroke-width="2"' + (dash ? ' stroke-dasharray="4 3"' : '') + '/>' + (lab ? '<text x="' + xx + '" y="' + (top ? 10 : H - 6) + '" fill="' + col + '" font-size="10" text-anchor="middle" font-family="JetBrains Mono,monospace">' + lab + '</text>' : ''); };
    svg += mark(sm.median, '#e3b84d', f1(sm.median)) + mark(sm.mean, '#d274b0', '') + mark(line, '#2fa79a', 'book ' + f1(line), true, true);
    svg += '<text x="' + pad + '" y="' + (H - 6) + '" fill="#958a7a" font-size="10" font-family="JetBrains Mono,monospace">' + d.lo + '</text><text x="' + (W - pad) + '" y="' + (H - 6) + '" fill="#958a7a" font-size="10" text-anchor="end" font-family="JetBrains Mono,monospace">' + (d.lo + n - 1) + '</text>';
    return svg + '</svg>';
  }
  function ladderHTML(ev) {
    var L = ev.ladder;
    if (!L || !L.rows || !L.rows.length) return '<div class="edp-dim">No fresh priced quote to compare. Use the calculator below to price any line and price against EdgeDesk’s distribution.</div>';
    var TAG = { best_price: 'BEST PRICE', best_ev: 'BEST EV', safer_line: 'SAFER LINE', higher_upside: 'HIGHER UPSIDE' };
    return '<table class="edp-mini"><thead><tr><th class="l">Quote</th><th>P(win)</th><th>Fair</th><th>Break-even</th><th>Edge</th><th>EV</th><th>Adj. EV</th></tr></thead><tbody>' +
      L.rows.map(function (r) {
        var tags = (r.tags || []).map(function (t) { return '<span class="edp-tag ' + t + '">' + TAG[t] + '</span>'; }).join('');
        return '<tr class="' + (r.tags && r.tags.length ? 'best' : (r.dominated ? 'dom' : '')) + '"><td class="l">' + esc(side(r.side) + ' ' + (r.side === 'yes' || r.side === 'no' ? '' : f1(r.line)) + ' ' + am(r.american) + ' ' + book(r.book)) + (r.is_alternate ? ' <span class="edp-faint">alt</span>' : '') + (r.tail ? ' <span class="edp-warn" title="Depends on the distribution’s tail">tail</span>' : '') + tags + '</td>' +
          '<td>' + pct(r.model_cover) + '</td><td>' + am(r.fair_american) + '</td><td>' + pct(r.break_even) + '</td><td class="' + (r.edge_pp > 0 ? 'edp-pos' : '') + '">' + pp(r.edge_pp) + '</td><td class="' + (r.ev > 0 ? 'edp-pos' : 'edp-neg') + '">' + spct(r.ev) + '</td><td>' + spct(r.decision_ev) + '</td></tr>';
      }).join('') + '</tbody></table><div class="edp-note">The highest-probability line is not the highest-EV line when its price costs more than the extra probability is worth. Highlights describe the numbers; none is a certainty. Dominated quotes (another quote has at least the probability and more EV) are dimmed.</div>';
  }
  function calcHTML(p) {
    if (!p.dist) return '';
    var bin = P.propType(p.prop_type) && P.propType(p.prop_type).kind === 'binary';
    return '<div class="edp-calc" data-calc="1"><select data-c="side" aria-label="Side">' + (bin ? '<option value="yes">Yes</option><option value="no">No</option>' : '<option value="over">Over</option><option value="under">Under</option>') + '</select>' +
      (bin ? '' : '<input data-c="line" type="number" step="0.5" value="' + esc(p.summary ? Math.floor(p.summary.median) + 0.5 : '') + '" aria-label="Line">') + '<input data-c="price" type="number" step="5" value="-110" aria-label="American price"><div class="out" data-c="out"></div></div>';
  }
  function oppHTML(p, row) {
    var o = p.opportunity;
    if (!o) return '<div class="edp-dim">No opportunity estimate for this player.</div>';
    var line = function (l, v, s1, s3) { return '<tr><td class="l">' + l + '</td><td>' + v + '</td><td>' + (s1 || '—') + '</td><td>' + (s3 || '—') + '</td></tr>'; };
    var h = '<table class="edp-mini"><thead><tr><th class="l"></th><th>Projected</th><th>Season</th><th>Last 3</th></tr></thead><tbody>';
    if (p.position === 'QB') h += line('Pass attempts', f1(o.expected_attempts), '', '');
    h += line('Snap share', pct(o.snap_share, 0) + ' · ' + f1(o.expected_snaps) + ' snaps', '', '');
    if (o.route_estimate != null) h += line('Routes (est.)', f1(o.route_estimate), '', '');
    if (o.target_share) h += line('Target share', pct(o.target_share) + ' · ' + f1(o.expected_targets) + ' tgt', pct(o.season && o.season.target_share), pct(o.last3 && o.last3.target_share));
    if (o.carry_share) h += line('Carry share', pct(o.carry_share) + ' · ' + f1(o.expected_carries) + ' car', pct(o.season && o.season.carry_share), pct(o.last3 && o.last3.carry_share));
    if (o.rz_target_share) h += line('Red-zone target share', pct(o.rz_target_share), '', '');
    if (o.rz_carry_share && o.carry_share) h += line('Red-zone carry share', pct(o.rz_carry_share), '', '');
    if (o.third_down_target_share != null) h += line('Third-down share of his targets', pct(o.third_down_target_share), '', '');
    h += '</tbody></table>';
    h += '<div class="edp-line"><span>Team volume</span><span class="v">' + f1(o.team_plays) + ' plays · ' + f1(o.team_dropbacks) + ' dropbacks · ' + f1(o.team_attempts) + ' att · ' + f1(o.team_designed_runs) + ' runs</span></div>';
    h += '<div class="edp-note">Role: ' + (o.role ? 'rank ' + o.role.rank + ' (' + esc(o.role.source) + '), prior target share ' + pct(o.role.prior_target_share) : '—') + '. Shares are recency-weighted and shrunk toward the role prior, so a small sample never gets a veteran’s certainty. ' + (o.route_basis ? esc(o.route_basis) + '.' : '') + '</div>';
    var e = p.efficiency;
    if (e) h += '<details class="edp-adv"><summary>Efficiency (true-talent estimates)</summary><div class="edp-line"><span>Catch rate</span><span class="v">' + pct(e.catch_rate) + ' <span class="edp-faint">raw ' + pct(e.catch_rate_raw) + '</span></span></div><div class="edp-line"><span>Yards per catch</span><span class="v">' + f1(e.yards_per_catch) + ' <span class="edp-faint">raw ' + f1(e.yards_per_catch_raw) + '</span></span></div><div class="edp-line"><span>Yards per carry</span><span class="v">' + f1(e.yards_per_carry) + ' <span class="edp-faint">raw ' + f1(e.yards_per_carry_raw) + '</span></span></div><div class="edp-line"><span>aDOT</span><span class="v">' + f1(e.adot) + '</span></div></details>';
    return h;
  }
  function formHTML(p) {
    var r = p.recent;
    if (!r || !r.games || !r.games.length) return '<div class="edp-dim">No recent games on file.</div>';
    var mx = Math.max.apply(null, r.games.map(function (g) { return g.value || 0; }).concat([p.summary ? p.summary.mean : 0, 1]));
    return '<table class="edp-mini"><thead><tr><th class="l">Game</th><th>Result</th><th class="l" style="width:45%"></th></tr></thead><tbody>' + r.games.map(function (g) {
      return '<tr><td class="l">' + esc(g.season + ' wk ' + g.week + ' vs ' + g.opp) + '</td><td>' + f0(g.value) + '</td><td class="l"><span style="display:inline-block;height:6px;border-radius:3px;background:rgba(170,156,135,.6);width:' + Math.max(1, (g.value || 0) / mx * 100).toFixed(0) + '%"></span></td></tr>';
    }).join('') + '</tbody></table><div class="edp-line"><span>Last 3 · season · projection</span><span class="v">' + f1(r.last3) + ' · ' + f1(r.season) + ' · ' + f1(p.summary && p.summary.mean) + '</span></div><div class="edp-note">Recent games are context. The projection shrinks them toward the longer record and the role prior (Validation_Eval V003: recent form must beat a regressed baseline to earn weight).</div>';
  }
  function teamOf(x) { var t = x.game && x.game.teams; if (!t) return null; return t.home && t.home.team === x.row.team ? t.home : t.away; }
  function matchupHTML(x) {
    var t = teamOf(x); if (!t || !t.opponent_factors) return '<div class="edp-dim">No opponent data.</div>';
    var of = t.opponent_factors, pos = x.row.pos, pf = of.pos && of.pos[pos];
    var h = '';
    if (pf) h += '<div class="edp-line"><span>' + esc(t.opponent) + ' yards per target to ' + pos + 's</span><span class="v">' + f1(pf.ypt_allowed) + ' <span class="edp-faint">league ' + f1(pf.lg_ypt) + ' · factor ' + (pf.ypt_factor || 1).toFixed(2) + '</span></span></div><div class="edp-line"><span>Catch-rate factor allowed</span><span class="v">' + (pf.catch_factor || 1).toFixed(2) + '</span></div>';
    if (of.rush) h += '<div class="edp-line"><span>' + esc(t.opponent) + ' yards per RB carry</span><span class="v">' + f1(of.rush.ypc_allowed) + ' <span class="edp-faint">league ' + f1(of.rush.lg_ypc) + ' · factor ' + (of.rush.ypc_factor || 1).toFixed(2) + '</span></span></div>';
    h += '<div class="edp-line"><span>Sack / interception factor</span><span class="v">' + (of.sack_factor || 1).toFixed(2) + ' / ' + (of.int_factor || 1).toFixed(2) + '</span></div>';
    h += '<div class="edp-note">Opponent rates are recency-weighted over ' + (of.n_games || 0) + ' games and shrunk toward the league, so one bad week does not define a defense. Factors multiply the player’s own efficiency; they are not "vs position" fantasy points.</div>';
    return h;
  }
  function availHTML(x) {
    var p = x.projection, a = p.availability || {}, t = teamOf(x);
    var h = '<div class="edp-line"><span>' + esc(x.row.name) + '</span><span class="v">' + esc(a.status || '—') + (a.p_active != null && a.p_active < 1 ? ' · ' + pct(a.p_active, 0) + ' to play' : '') + '</span></div><div class="edp-note">' + esc(a.basis || '') + '</div>';
    var rd = t && t.redistribution || [];
    if (rd.length) h += '<table class="edp-mini" style="margin-top:6px"><thead><tr><th class="l">Teammate</th><th>Status</th><th>Share</th><th class="l">Goes to (confidence)</th></tr></thead><tbody>' + rd.slice(0, 8).map(function (d) {
      return '<tr><td class="l">' + esc(d.name + ' ' + d.pos) + '</td><td>' + esc(d.status) + (d.p_active != null && d.p_active < 1 && d.status !== 'OUT' ? ' ' + pct(d.p_active, 0) : '') + '</td><td>' + pct(d.share) + ' ' + (d.kind === 'tgt' ? 'tgt' : 'car') + '</td><td class="l">' + esc((d.recipients || []).slice(0, 3).map(function (q) { return q.name + ' ' + pct(q.fraction, 0); }).join(', ')) + ' <span class="edp-faint">(' + esc(String(d.confidence).toLowerCase()) + ')</span></td></tr>';
    }).join('') + '</tbody></table><div class="edp-note">An absent player’s share is handed to named teammates by role (the team’s own games without him when they exist, a structural plan otherwise); part of it always stays unassigned. A questionable player is a scenario inside the simulation, weighted by the league’s measured play-through rate.</div>';
    else h += '<div class="edp-note">No teammate absence changes this projection.</div>';
    return h;
  }
  function envHTML(x) {
    var e = x.game.environment || {}, t = teamOf(x);
    var h = '<div class="edp-line"><span>Source</span><span class="v">' + esc(e.source === 'edgedesk_model' ? 'EdgeDesk game model' : (e.source || '—')) + '</span></div>' +
      '<div class="edp-line"><span>' + esc(x.game.home) + ' margin · total</span><span class="v">' + (isNum(e.home_margin) ? (e.home_margin > 0 ? '+' : '') + f1(e.home_margin) : '—') + ' · ' + f1(e.total) + '</span></div>' +
      '<div class="edp-line"><span>Team points (' + esc(x.game.away) + ' / ' + esc(x.game.home) + ')</span><span class="v">' + f1(e.away_points) + ' / ' + f1(e.home_points) + '</span></div>';
    if (t) h += '<div class="edp-line"><span>' + esc(t.team) + ' plays · dropback rate · neutral</span><span class="v">' + f1(t.plays) + ' · ' + pct(t.pass_rate, 0) + ' · ' + pct(t.neutral_pass_rate, 0) + '</span></div>' +
      '<div class="edp-line"><span>Expected game script</span><span class="v">' + (isNum(t.expected_margin) ? (t.expected_margin > 0 ? 'lead by ' : 'trail by ') + f1(Math.abs(t.expected_margin)) : '—') + '</span></div>';
    if (e.weather) h += '<div class="edp-line"><span>Weather</span><span class="v">' + esc(e.weather.outdoor === false ? 'indoors (' + (e.weather.roof || 'roof') + ')' : (e.weather.windy ? 'wind ' + e.weather.wind_mph + ' mph (passing factor applied)' : (e.weather.known ? 'no windy-game factor' : 'no forecast on file'))) + '</span></div>';
    h += '<div class="edp-note">The game environment is EdgeDesk’s own game model: every player in this game is simulated from the same draws of margin and total, which is what makes QB and receiver outcomes move together.</div>';
    return h;
  }
  function relHTML(ev, b, row) {
    var r = ev.reliability;
    var h = '';
    if (r && r.components) {
      var LBL = { data_completeness: 'Data completeness', sample_size: 'Sample size', role_stability: 'Role stability', injury_certainty: 'Availability certainty', model_agreement: 'Agreement with the baseline', market_liquidity: 'Market depth', book_agreement: 'Book agreement', projection_variance: 'Projection variance', historical_calibration: 'Historical calibration', redistribution: 'Redistribution confidence' };
      Object.keys(LBL).forEach(function (k) { var v = r.components[k]; h += '<div class="edp-line"><span>' + LBL[k] + '</span><span class="v">' + (isNum(v) ? Math.round(100 * v) : '<span class="edp-faint">not measured</span>') + '</span></div>'; });
      if (r.caps && r.caps.length) h += '<div class="edp-note">' + esc(r.caps.join(' · ')) + '</div>';
    } else h += '<div class="edp-dim">Reliability is scored only for a projected prop.</div>';
    var st = b.stages && b.stages[row.prop];
    if (st && st.gates) h += '<details class="edp-adv"><summary>Validation gates for ' + esc(PROP_LABEL[row.prop] || row.prop) + ' (' + esc(st.label) + ')</summary>' + st.gates.map(function (g) {
      return '<div class="edp-gate"><span>' + esc(g.id + ' ' + g.name) + '</span><span class="' + (!g.measured ? 'na' : (g.pass ? 'ok' : 'no')) + '">' + (!g.measured ? 'not measured' : (g.pass ? 'pass' : 'fail')) + (g.detail ? ' · ' + esc(g.detail) : '') + '</span></div>';
    }).join('') + '</details>';
    h += '<div class="edp-note">Reliability is not the size of the edge: a 9% edge on thin, unstable inputs can score below a 4% edge on a stable role. Decisions move the model probability toward the no-vig market in proportion to what is not known (risk-adjusted EV).</div>';
    return h;
  }
  function corrHTML(x) {
    var list = (x.game.correlations || []).filter(function (c) { return c.a === x.row.id || c.b === x.row.id; }).slice(0, 6);
    if (!list.length) return '';
    return '<table class="edp-mini"><thead><tr><th class="l">Prop</th><th>Rank correlation</th></tr></thead><tbody>' + list.map(function (c) {
      var other = c.a === x.row.id ? c.b_label : c.a_label;
      return '<tr><td class="l">' + esc(other.replace(/_/g, ' ')) + '</td><td class="' + (c.rho > 0 ? 'edp-pos' : 'edp-neg') + '">' + (c.rho > 0 ? '+' : '') + c.rho.toFixed(2) + '</td></tr>';
    }).join('') + '</tbody></table><div class="edp-note">Measured on the same simulated games. Combining correlated props is not the product of their probabilities; EdgeDesk sizes correlated positions as one exposure.</div>';
  }
  function toBoard(L, gid) {
    S.league = L; S.f.game = gid || null;
    if (root.researchGo) { try { root.researchGo('props'); if (root.prSetSeg) root.prSetSeg('board'); return; } catch (_) {} }
    if (S.host) paint(); else location.href = url('app.html#research/props');
  }
  function wireDrawer(d, x, L, close) {
    var ask = d.querySelector('[data-ask]');
    if (ask) ask.onclick = function () {
      var rec = x.ev.recommended || x.ev.best;
      var q = 'Research ' + x.row.name + ' ' + (PROP_LABEL[x.row.prop] || x.row.prop).toLowerCase() + (rec ? ' ' + side(rec.side).toLowerCase() + ' ' + f1(rec.line) + ' ' + am(rec.american) + ' at ' + book(rec.book) : '') + '. Why does EdgeDesk see it this way, and what could make it wrong?';
      try { if (root.EDAI && root.EDAI.open) { root.EDAI.open(); setTimeout(function () { root.EDAI.deskAsk(q); }, 80); return; } } catch (_) {}
      location.href = url('app.html#research/props/' + L + '|' + x.row.id);
    };
    var gb = d.querySelector('[data-game]');
    if (gb) gb.onclick = function () { close(true); try { root.researchGo('football'); if (root.fbOpenGameFromDesk) root.fbOpenGameFromDesk(L === 'cfb' ? 'ncaaf' : 'nfl', x.row.gid); } catch (_) {} };
    var ag = d.querySelector('[data-allgame]');
    if (ag) ag.onclick = function () { close(true); toBoard(L, x.row.gid); };
    var calc = d.querySelector('[data-calc]');
    if (calc) {
      var run = function () {
        var sd = calc.querySelector('[data-c="side"]').value, li = calc.querySelector('[data-c="line"]'), pr = +calc.querySelector('[data-c="price"]').value;
        var line = li ? +li.value : 0.5;
        var ps = P.priceSide(x.projection.dist, sd, line, pr);
        var out = calc.querySelector('[data-c="out"]');
        if (!ps.available) { out.textContent = 'Not a valid price or line (' + (ps.reason || '') + ').'; return; }
        var bel = sd === 'over' || sd === 'under' ? P.breakEvenLine(x.projection.dist, sd, pr) : null;
        out.innerHTML = esc(side(sd) + ' ' + (li ? f1(line) : '') + ' ' + am(pr)) + ': P(win) ' + pct(ps.model_win) + (ps.model_push > 0 ? ' · push ' + pct(ps.model_push) : '') + ' · fair ' + am(ps.fair_american) + ' · break-even ' + pct(ps.break_even) + ' · edge ' + pp(ps.edge_pp) + ' · <b class="' + (ps.ev > 0 ? 'edp-pos' : 'edp-neg') + '">EV ' + spct(ps.ev) + '</b>' + (isNum(bel) ? ' · zero-EV line at this price ≈ ' + f1(bel) : '');
      };
      Array.prototype.forEach.call(calc.querySelectorAll('input,select'), function (el) { el.oninput = run; el.onchange = run; });
      run();
    }
  }

  /* ============================================== GAME-PAGE SECTION (cards) */
  function gameSectionHTML(league, gid) { return '<div class="edp edp-gsec" data-edp-game="' + esc(String(league).toLowerCase() + '|' + gid) + '"><div class="edp-dim" style="font-size:12px">Loading player props…</div></div>'; }
  function hydrate(scope) {
    var els = (scope || document).querySelectorAll('[data-edp-game]');
    Array.prototype.forEach.call(els, function (el) {
      if (el.getAttribute('data-edp-done')) return;
      el.setAttribute('data-edp-done', '1');
      var parts = el.getAttribute('data-edp-game').split('|'), L = parts[0], gid = parts.slice(1).join('|');
      loadLeague(L).then(function (b) { el.innerHTML = gameSectionBody(b, L, gid); wireSection(el, L, gid); }, function () { el.innerHTML = '<div class="edp-dim" style="font-size:12px">Player props are not available for this game.</div>'; });
    });
  }
  function gameSectionBody(b, L, gid) {
    var rows = b.rows.filter(function (r) { return r.gid === gid; }).map(function (r) { return view(r, b); });
    if (!rows.length) return '<div class="edp-dim" style="font-size:12px">EdgeDesk has no player projections for this game yet.</div>';
    var priced = rows.filter(function (v) { return v.mkt && v.px; });
    var pick = function (list, n, seen) { var out = []; list.forEach(function (v) { if (out.length < n && !seen[v.id]) { out.push(v); seen[v.id] = 1; } }); return out; };
    var seen = {};
    var research = pick(priced.filter(function (v) { return v.dec.cls === 'BET' || v.dec.cls === 'LEAN'; }).sort(function (a, b2) { return (b2.decEv || 0) - (a.decEv || 0); }), 1, seen);
    if (!research.length) research = pick(priced.slice().sort(function (a, b2) { return (b2.dz || 0) * (b2.rel || 50) - (a.dz || 0) * (a.rel || 50); }), 1, seen);
    var disagree = pick(priced.slice().sort(function (a, b2) { return (b2.dz || 0) - (a.dz || 0); }), 2, seen);
    var watch = pick(priced.filter(function (v) { return v.dec.cls === 'WATCH'; }), 1, seen);
    var pass = pick(priced.filter(function (v) { return v.dec.cls === 'PASS'; }).sort(function (a, b2) { return (b2.rel || 0) - (a.rel || 0); }), 1, seen);
    var h = '';
    var item = function (v) { return '<div class="gp" data-id="' + esc(v.id) + '" tabindex="0"><span class="n">' + esc(v.name + ' · ' + short(v.prop)) + '</span><span class="m">' + (v.px ? esc(sideShort(v.px.side) + f1(v.px.line) + ' ' + am(v.px.am)) + ' · fair ' + f1(v.median) + ' · EV ' + spct(v.ev) : 'fair ' + f1(v.median)) + ' ' + decChip(v.dec) + '</span></div>'; };
    if (priced.length) {
      if (research.length) h += '<div class="grp">Top research prop</div>' + research.map(item).join('');
      if (disagree.length) h += '<div class="grp">Biggest model / market disagreements</div>' + disagree.map(item).join('');
      if (watch.length) h += '<div class="grp">Watch list</div>' + watch.map(item).join('');
      if (pass.length) h += '<div class="grp">Pass</div>' + pass.map(item).join('');
    } else {
      var top = rows.filter(function (v) { return v.status === 'PROJECTED' && /^(pass_yds|rush_yds|rec_yds)$/.test(v.prop); }).sort(function (a, b2) { return (b2.mean || 0) - (a.mean || 0); }).slice(0, 4);
      h += '<div class="grp">EdgeDesk fair lines (no sportsbook price captured yet)</div>' + top.map(item).join('');
    }
    return h + '<div class="edp-links" style="margin-top:8px"><button class="primary" data-allprops="1">View all player props for this game</button></div>';
  }
  function wireSection(el, L, gid) {
    Array.prototype.forEach.call(el.querySelectorAll('[data-id]'), function (n) { var go = function () { openProp(n.getAttribute('data-id'), L); }; n.onclick = go; n.onkeydown = function (e) { if (e.key === 'Enter') go(); }; });
    var all = el.querySelector('[data-allprops]');
    if (all) all.onclick = function () { toBoard(L, gid); };
  }

  /* ========================================================== PLAYER PAGE */
  function playerPage(host, opts) {
    var L = (opts.league || 'nfl').toLowerCase(), slug = opts.slug;
    S.base = opts.base != null ? opts.base : S.base;
    host.classList.add('edp');
    host.innerHTML = '<div class="empty">Loading…</div>';
    return Promise.all([loadLeague(L), loadLogs(L), getJson('record/props/' + L + '_' + (new Date().getUTCMonth() <= 1 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear()) + '.json', true)]).then(function (x) {
      var b = x[0], logs = x[1], rec = x[2];
      var idx = S.pidx[L] || {}, pid = null;
      Object.keys(idx).forEach(function (k) { if (idx[k][1] === slug) pid = k; });
      var rows = b.rows.filter(function (r) { return r.pid === pid; }).map(function (r) { return view(r, b); });
      if (!pid) { host.innerHTML = '<div class="empty">No current EdgeDesk research for this player. Player pages list the players on the current ' + L.toUpperCase() + ' props board.</div>'; return; }
      var meta = idx[pid], lg = logs.players ? logs.players[pid] : null;
      if (typeof document !== 'undefined') { document.title = meta[0] + ' player props research · EdgeDesk'; }
      var v0 = rows[0];
      var h = '<div style="display:flex;gap:14px;align-items:center;margin:0 0 12px">' + (meta[4] ? '<img src="' + esc(meta[4]) + '" alt="" width="72" height="72" style="border-radius:50%;background:#221c15;object-fit:cover">' : '') +
        '<div><div class="edp-h1">' + esc(meta[0]) + '</div><div class="edp-h2">' + esc(meta[2] + ' · ' + meta[3] + (meta[6] ? ' · #' + meta[6] : '') + ' · ' + L.toUpperCase()) + '</div>' +
        (v0 ? '<div class="edp-dim" style="font-size:12.5px">Next: ' + esc(v0.team + ' ' + v0.ha + ' ' + v0.opp + ' · ' + dt(v0.ko)) + '</div>' : '') + '</div></div>';
      if (v0 && v0.avail) h += '<div class="edp-banner warn"><b>' + esc(v0.avail[0]) + '</b>' + (isNum(v0.avail[1]) && v0.avail[1] < 1 ? ' · ' + pct(v0.avail[1], 0) + ' historical play-through' : '') + '. Distributions are conditional on playing.</div>';
      h += '<div class="edp-sec"><h3><span>Prop markets and projections</span><span class="r">tap a row for the full research</span></h3><table class="edp-mini"><thead><tr><th class="l">Prop</th><th>Line</th><th>Best</th><th>Fair</th><th>Proj</th><th>P(Over)</th><th>EV</th><th>Rel.</th><th>Decision</th></tr></thead><tbody>' +
        rows.map(function (v) { return '<tr class="r" data-id="' + esc(v.id) + '" style="cursor:pointer"><td class="l">' + esc(PROP_LABEL[v.prop]) + ' ' + stageBadge(v.stage) + '</td><td>' + (isNum(v.line) ? f1(v.line) : '—') + '</td><td>' + bestText(v) + '</td><td>' + f1(v.median) + '</td><td>' + f1(v.mean) + '</td><td>' + (v.at ? pct(v.at[0]) : '—') + '</td><td>' + (isNum(v.ev) ? spct(v.ev) : '—') + '</td><td>' + (isNum(v.rel) ? Math.round(v.rel) : '—') + '</td><td>' + decChip(v.dec) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      if (lg) {
        var cols = lg.cols, ix = function (k) { return cols.indexOf(k); };
        var pos = meta[2];
        var show = pos === 'QB' ? ['att', 'cmp', 'pass_yds', 'pass_td', 'int', 'car', 'rush_yds'] : (pos === 'RB' ? ['snap_pct', 'car', 'rush_yds', 'rush_td', 'tgt', 'rec', 'rec_yds'] : ['snap_pct', 'tgt', 'rec', 'rec_yds', 'rec_td', 'rz_tgt', 'long_rec']);
        var LBL = { att: 'Att', cmp: 'Cmp', pass_yds: 'Pass yds', pass_td: 'Pass TD', int: 'INT', car: 'Car', rush_yds: 'Rush yds', rush_td: 'Rush TD', tgt: 'Tgt', rec: 'Rec', rec_yds: 'Rec yds', rec_td: 'Rec TD', snap_pct: 'Snap %', rz_tgt: 'RZ tgt', long_rec: 'Long' };
        h += '<div class="edp-sec"><h3><span>Recent games · usage and production</span></h3><div class="edp-tblwrap" style="display:block"><table class="edp-mini"><thead><tr><th class="l">Game</th>' + show.map(function (k) { return '<th>' + LBL[k] + '</th>'; }).join('') + '</tr></thead><tbody>' +
          lg.games.map(function (g) { return '<tr><td class="l">' + esc(g[ix('season')] + ' wk ' + g[ix('week')] + ' · ' + g[ix('team')] + ' v ' + g[ix('opp')]) + '</td>' + show.map(function (k) { var val = g[ix(k)]; return '<td>' + (k === 'snap_pct' ? (isNum(val) ? pct(val, 0) : '—') : (val == null ? '—' : val)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' +
          (lg.season_avg && lg.season_avg.games ? '<div class="edp-note">This season (' + lg.season_avg.games + ' games): ' + esc(Object.keys(lg.season_avg).filter(function (k) { return k !== 'games' && lg.season_avg[k] != null && lg.season_avg[k] !== 0; }).map(function (k) { return (LBL[k] || k) + ' ' + (k === 'snap_pct' ? pct(lg.season_avg[k], 0) : lg.season_avg[k]); }).join(' · ')) + '</div>' : '') + '</div>';
      }
      var graded = rec && rec.predictions ? rec.predictions.filter(function (p) { return p.player_id === pid && p.status === 'GRADED'; }) : [];
      h += '<div class="edp-sec"><h3><span>Graded history on this player</span><span class="r">frozen before kickoff</span></h3>' + (graded.length ? '<table class="edp-mini"><thead><tr><th class="l">Game</th><th class="l">Prop</th><th>Taken</th><th>P</th><th>Result</th><th>Actual</th><th>CLV</th></tr></thead><tbody>' + graded.slice(-12).reverse().map(function (p) {
        return '<tr><td class="l">' + esc('wk ' + p.week + ' ' + p.team + ' v ' + p.opponent) + '</td><td class="l">' + esc(short(p.prop_type)) + '</td><td>' + esc(sideShort(p.side) + f1(p.line) + ' ' + am(p.american)) + '</td><td>' + pct(p.model_cover) + '</td><td class="' + (p.result === 'WIN' ? 'edp-pos' : (p.result === 'LOSS' ? 'edp-neg' : '')) + '">' + esc(p.result) + '</td><td>' + f0(p.actual) + '</td><td>' + (isNum(p.clv_price) ? spct(p.clv_price) : '—') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<div class="edp-dim">No graded predictions on this player yet.</div>') + '</div>';
      h += '<p class="edp-note">Research, not picks. EdgeDesk player id ' + esc(pid) + ' — a durable id, never a name. Projections and prices refresh with the board.</p>';
      host.innerHTML = h;
      Array.prototype.forEach.call(host.querySelectorAll('[data-id]'), function (n) { n.onclick = function () { openProp(n.getAttribute('data-id'), L); }; });
    }, function (e) { host.innerHTML = '<div class="empty">Player research is not available right now (' + esc(e.message) + ').</div>'; });
  }

  /* ============================================================ ANALYTICS */
  function analytics(host, league) {
    var L = (league || 'nfl').toLowerCase();
    host.classList.add('edp');
    host.innerHTML = '<div class="empty">Loading prop analytics…</div>';
    var season = new Date().getUTCMonth() <= 1 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear();
    return Promise.all([getJson('football/props/' + L + '/validation.json', true), getJson('record/props/' + L + '_' + season + '.json', true), loadLeague(L).catch(function () { return null; })]).then(function (x) {
      var v = x[0], rec = x[1], b = x[2];
      var h = '<div class="edp-chips">' + ['nfl', 'cfb'].map(function (k) { return '<button class="edp-chip' + (k === L ? ' on' : '') + '" data-al="' + k + '">' + k.toUpperCase() + ' props</button>'; }).join('') + '</div>';
      h += '<div class="edp-banner">Three questions kept apart: <b>projection accuracy</b> (MAE, CRPS), <b>probability calibration</b> (PIT, coverage, calibration slope, Brier) and <b>betting value</b> (CLV, ROI). A market is only as trusted as the gates it passed; the gates are shown, pass or fail.</div>';
      if (v && v.by_prop) {
        h += '<div class="edp-sec"><h3><span>Walk-forward validation · untouched holdout</span><span class="r">' + esc((v.n_holdout || v.n) + ' scored · ' + (v.folds_all || v.folds) + ' weekly folds · leakage violations ' + v.leakage_violations) + '</span></h3><div style="overflow-x:auto"><table class="edp-mini"><thead><tr><th class="l">Prop</th><th>n</th><th>CRPS</th><th>vs last-8</th><th>MAE</th><th>vs Marcel</th><th>80% cov.</th><th>PIT dev</th><th>Slope</th><th>Brier</th><th class="l">Stage</th></tr></thead><tbody>' +
          Object.keys(v.by_prop).map(function (k) {
            var r = v.by_prop[k], st = b && b.stages && b.stages[k];
            var better = isNum(r.crps) && isNum(r.crps_baseline) ? (1 - r.crps / r.crps_baseline) : null;
            return '<tr><td class="l">' + esc(PROP_LABEL[k] || k) + '</td><td>' + r.n + '</td><td>' + (isNum(r.crps) ? r.crps.toFixed(2) : '—') + '</td><td class="' + (better > 0 ? 'edp-pos' : 'edp-neg') + '">' + (isNum(better) ? spct(better) : '—') + '</td><td>' + (isNum(r.mae) ? r.mae.toFixed(2) : '—') + '</td><td>' + (isNum(r.mae_marcel) ? r.mae_marcel.toFixed(2) : '—') + '</td>' +
              '<td>' + pct(r.coverage80, 0) + '</td><td>' + (isNum(r.pit_max_dev) ? r.pit_max_dev.toFixed(3) : '—') + '</td><td>' + (r.synthetic_line && r.synthetic_line.calibration_fit && isNum(r.synthetic_line.calibration_fit.slope) ? r.synthetic_line.calibration_fit.slope.toFixed(2) : '—') + '</td><td>' + (r.synthetic_line ? r.synthetic_line.brier.toFixed(3) : '—') + '</td><td class="l">' + (st ? stageBadge(st.stage) : '—') + '</td></tr>';
          }).join('') + '</tbody></table></div><div class="edp-note">CRPS "vs last-8" is the improvement over the player’s own last-8-game empirical distribution; MAE is compared with a Marcel-style regressed baseline. Slope and Brier are measured at a synthetic line (the Marcel mean on the half point) because no archive holds historical prop lines; market benchmarks begin with live captures. ' + esc((v.caveats || []).join(' ')) + '</div></div>';
        var strong = [], weak = [];
        Object.keys(v.by_prop).forEach(function (k) { var st = b && b.stages && b.stages[k]; if (st && st.stage !== 'EXPERIMENTAL') strong.push(PROP_LABEL[k]); else if (st) { var fail = (st.gates || []).filter(function (g) { return g.measured && !g.pass; }).map(function (g) { return g.name.toLowerCase(); }); if (fail.length) weak.push(PROP_LABEL[k] + ' (' + fail.join(', ') + ')'); } });
        h += '<div class="edp-sec"><h3><span>Where EdgeDesk is strong, and where it is weak</span></h3><div class="edp-line"><span>Passed the gates</span><span class="v edp-pos">' + esc(strong.join(', ') || 'none yet') + '</span></div><div style="font-size:12.5px;margin-top:6px"><b>Failed a gate:</b> <span class="edp-dim">' + esc(weak.join('; ') || 'none') + '</span></div></div>';
        if (v.redistribution) h += '<div class="edp-sec"><h3><span>Injury redistribution (Build_Roadmap phase 5)</span></h3>' + Object.keys(v.redistribution).map(function (k) { var r = v.redistribution[k]; return '<div class="edp-line"><span>' + (k === 'tgt' ? 'Target share' : 'Carry share') + ' of teammates of an absent player (n=' + r.n + ')</span><span class="v">model MAE ' + (isNum(r.model_mae) ? (100 * r.model_mae).toFixed(1) + ' pp' : '—') + ' · naive ' + (isNum(r.naive_mae) ? (100 * r.naive_mae).toFixed(1) + ' pp' : '—') + '</span></div>'; }).join('') + '</div>';
        if (v.by_position) h += '<div class="edp-sec"><h3><span>By position (holdout)</span></h3>' + Object.keys(v.by_position).map(function (k) { var r = v.by_position[k]; return '<div class="edp-line"><span>' + k + ' (n=' + r.n + ')</span><span class="v">80% cov ' + pct(r.coverage80, 0) + ' · PIT dev ' + (r.pit_max_dev || 0).toFixed(3) + '</span></div>'; }).join('') + '</div>';
      } else h += '<div class="empty">No walk-forward validation on file for ' + L.toUpperCase() + ' player props yet. Every market stays EXPERIMENTAL until one exists.</div>';
      var sc = rec && rec.scorecards;
      h += '<div class="edp-sec"><h3><span>Live record · frozen before kickoff, graded after</span><span class="r">' + esc(sc && sc.all ? sc.all.sample_state : 'no settled predictions') + '</span></h3>';
      if (sc && sc.all && sc.all.settled) {
        var a = sc.all;
        h += '<div class="edp-kpis"><div class="edp-kpi"><div class="l">Settled</div><div class="v">' + a.settled + '</div><div class="s">' + a.wins + '-' + a.losses + '-' + a.pushes + ' · voids ' + a.voids + '</div></div><div class="edp-kpi"><div class="l">Win rate vs mean P</div><div class="v">' + pct(a.win_rate) + '</div><div class="s">expected ' + pct(a.mean_model_prob) + '</div></div>' +
          '<div class="edp-kpi"><div class="l">Brier (vs market)</div><div class="v">' + (isNum(a.brier) ? a.brier.toFixed(3) : '—') + '</div><div class="s">market ' + (isNum(a.market_brier) ? a.market_brier.toFixed(3) : '—') + '</div></div><div class="edp-kpi"><div class="l">CLV (price)</div><div class="v">' + spct(a.clv_mean, 2) + '</div><div class="s">beat close ' + pct(a.clv_beat_rate, 0) + '</div></div>' +
          '<div class="edp-kpi"><div class="l">Flat ROI</div><div class="v">' + spct(a.flat_roi) + '</div><div class="s">1U on every graded prop</div></div><div class="edp-kpi"><div class="l">BET units</div><div class="v">' + (sc.bets && sc.bets.settled ? (sc.bets.units >= 0 ? '+' : '') + sc.bets.units + 'U' : '—') + '</div><div class="s">' + (sc.bets ? sc.bets.settled : 0) + ' BETs settled</div></div></div>';
        var tbl = function (title, o) { return '<div class="gd-sec" style="margin-top:10px">' + esc(title) + '</div><table class="edp-mini"><thead><tr><th class="l"></th><th>n</th><th>Win %</th><th>Mean P</th><th>Brier</th><th>CLV</th><th>ROI</th></tr></thead><tbody>' + Object.keys(o || {}).map(function (k) { var r = o[k]; return '<tr><td class="l">' + esc(PROP_LABEL[k] || k) + '</td><td>' + r.decided + '</td><td>' + pct(r.win_rate) + '</td><td>' + pct(r.mean_model_prob) + '</td><td>' + (isNum(r.brier) ? r.brier.toFixed(3) : '—') + '</td><td>' + spct(r.clv_mean, 2) + '</td><td>' + spct(r.flat_roi) + '</td></tr>'; }).join('') + '</tbody></table>'; };
        h += tbl('By prop type', sc.by_prop) + tbl('By position', sc.by_position) + tbl('By confidence tier', sc.by_confidence) + tbl('By sportsbook', sc.by_book) + tbl('By model version', sc.by_model_version) + tbl('By decision', sc.by_decision);
        if (a.calibration && a.calibration.length) h += '<div class="gd-sec" style="margin-top:10px">Calibration (predicted vs observed)</div><table class="edp-mini"><thead><tr><th class="l">Bucket</th><th>n</th><th>Predicted</th><th>Observed</th><th>95% interval</th></tr></thead><tbody>' + a.calibration.map(function (c) { return '<tr><td class="l">' + pct(c.lo, 0) + '–' + pct(c.hi, 0) + '</td><td>' + c.n + '</td><td>' + pct(c.mean_p) + '</td><td>' + pct(c.observed) + '</td><td>' + pct(c.ci_lo, 0) + '–' + pct(c.ci_hi, 0) + '</td></tr>'; }).join('') + '</tbody></table>';
        if (sc.edge_buckets) h += '<div class="gd-sec" style="margin-top:10px">By model edge (V016: larger edges must perform better)</div><table class="edp-mini"><thead><tr><th class="l">Edge</th><th>n</th><th>Win %</th><th>Mean P</th><th>CLV</th><th>Flat ROI</th></tr></thead><tbody>' + sc.edge_buckets.map(function (e) { return '<tr><td class="l">' + esc(e.bucket) + '</td><td>' + e.n + '</td><td>' + pct(e.win_rate) + '</td><td>' + pct(e.mean_model_prob) + '</td><td>' + spct(e.clv_mean, 2) + '</td><td>' + spct(e.flat_roi) + '</td></tr>'; }).join('') + '</tbody></table>';
      } else h += '<div class="edp-dim">No settled player-prop predictions yet. EdgeDesk freezes every qualifying pregame prediction (price, book, probability, fair odds, EV, model version) and grades it after the final; this panel fills as they settle. ' + esc((root.EDVocab && root.EDVocab.COPY && root.EDVocab.COPY.no_settled_bets) || '') + '</div>';
      h += '</div>';
      host.innerHTML = h;
      Array.prototype.forEach.call(host.querySelectorAll('[data-al]'), function (el) { el.onclick = function () { analytics(host, el.getAttribute('data-al')); }; });
    });
  }
  function recordSection(host) {
    host.classList.add('edp');
    var season = new Date().getUTCMonth() <= 1 ? new Date().getUTCFullYear() - 1 : new Date().getUTCFullYear();
    return Promise.all([getJson('record/props/nfl_' + season + '.json', true), getJson('record/props/cfb_' + season + '.json', true)]).then(function (x) {
      var h = '';
      [['NFL', x[0]], ['CFB', x[1]]].forEach(function (p) {
        var sc = p[1] && p[1].scorecards, a = sc && sc.all;
        h += '<div class="edp-sec"><h3><span>' + p[0] + ' player props</span><span class="r">' + esc(a ? a.sample_state : 'no settled predictions yet') + '</span></h3>' +
          (a && a.settled ? '<div class="edp-line"><span>Settled (W-L-P) · voids</span><span class="v">' + a.wins + '-' + a.losses + '-' + a.pushes + ' · ' + a.voids + '</span></div><div class="edp-line"><span>Win rate vs EdgeDesk’s mean probability</span><span class="v">' + pct(a.win_rate) + ' vs ' + pct(a.mean_model_prob) + '</span></div><div class="edp-line"><span>Brier · market Brier</span><span class="v">' + (isNum(a.brier) ? a.brier.toFixed(3) : '—') + ' · ' + (isNum(a.market_brier) ? a.market_brier.toFixed(3) : '—') + '</span></div><div class="edp-line"><span>Closing-line value</span><span class="v">' + spct(a.clv_mean, 2) + '</span></div><div class="edp-line"><span>Flat 1U ROI</span><span class="v">' + spct(a.flat_roi) + '</span></div>'
            : '<div class="edp-dim">Every qualifying pregame prediction is frozen before kickoff (append-only, hash-identified) and graded after the final. Nothing is shown until something has settled.</div>') + '</div>';
      });
      host.innerHTML = h;
    });
  }

  root.EDPropsUI = { board: board, openProp: openProp, evaluateProp: evaluateProp, gameSectionHTML: gameSectionHTML, hydrate: hydrate, playerPage: playerPage, analytics: analytics, recordSection: recordSection,
    loadLeague: loadLeague, loadGame: loadGame, setBase: function (b) { S.base = b; }, setLeague: function (L) { S.league = String(L).toLowerCase(); }, state: S, view: view, _paint: paint };
})(typeof window !== 'undefined' ? window : this);
