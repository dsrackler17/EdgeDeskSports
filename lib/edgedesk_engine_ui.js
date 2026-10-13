/* ===========================================================================
   EDGEDESK ENGINE — the multi-sport research panels.

     Research → Other → NHL     (#research/nhl[/<game_id>])  the NHL brain:
                                fair prices for every market of every upcoming
                                game, goalie scenarios, evidence, uncertainty,
                                the held-out record and a price check
     Research → Other → Engine  (#research/engine)           the cross-sport
                                opportunity board (or PASS, with why), every
                                sport's readiness, data and blockers, and the
                                methods with their sources

   Reads committed artifacts only:
     /engine/board.json  /engine/registry.json  /hockey/slate.json
     /hockey/validation/nhl_walkforward.json (on demand)
   Nothing here computes a probability or fetches a price. Research, not picks.

   Browser: window.EDEngineUI.show(host, { view: 'nhl' | 'engine', game })
   =========================================================================== */
(function (W) {
  'use strict';
  var FILES = { board: '/engine/board.json', registry: '/engine/registry.json', slate: '/hockey/slate.json', record: '/hockey/validation/nhl_walkforward.json' };
  var STALE_H = 18;
  var S = { host: null, view: 'engine', data: {}, err: {}, loading: {}, sport: 'all', market: 'all', open: null, nhlOpen: null, showAll: false, recordOpen: false, check: { market: 'moneyline:home', price: '' } };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pct(v, d) { var n = num(v); if (n == null) return '—'; var f = Math.pow(10, d == null ? 1 : d); return (Math.round(n * 100 * f) / f) + '%'; }
  function am(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function ln(v) { var n = num(v); return n == null ? '' : (n > 0 ? '+' : '') + n; }
  function when(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function ago(iso) { var t = Date.parse(iso); if (!isFinite(t)) return 'unknown'; var h = (Date.now() - t) / 36e5; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min ago' : h < 48 ? Math.round(h) + ' h ago' : Math.round(h / 24) + ' days ago'; }
  function isStale(iso) { var t = Date.parse(iso); return !isFinite(t) || (Date.now() - t) / 36e5 > STALE_H; }
  function chip(text, cls, title) { return '<span class="xe-chip ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  var STATE_CLS = { MARKET_VALIDATED: 'ok', OUTCOME_VALIDATED: 'ok2', EXPERIMENTAL: 'warn', RESEARCH_ONLY: 'none', UNAVAILABLE: 'bad', RETIRED: 'none', PROVISIONAL: 'warn', NOT_TESTED: 'none', QUALIFIED: 'ok', WATCH: 'warn', RESEARCH: 'none', DATA_CHECK: 'bad', CORRELATED: 'none', NO_VALUE: 'none', STARTED: 'none', FRESH: 'ok2', STALE: 'bad', DISABLED: 'bad', NOT_CAPTURED: 'none' };
  function stateChip(s, title) { return chip(String(s || '—').replace(/_/g, ' ').toLowerCase(), STATE_CLS[s] || 'none', title); }

  /* ------------------------------------------------------------ data */
  function bust() { var d = new Date(); return '?v=' + d.getUTCFullYear() + (d.getUTCMonth() + 1) + d.getUTCDate() + d.getUTCHours(); }
  function load(key, force) {
    if (S.loading[key]) return S.loading[key];
    if (S.data[key] && !force) return Promise.resolve(S.data[key]);
    S.err[key] = null;
    S.loading[key] = fetch(FILES[key] + bust(), { cache: force ? 'no-cache' : 'default' }).then(function (r) {
      if (!r.ok) throw new Error(FILES[key] + ' answered HTTP ' + r.status);
      return r.json();
    }).then(function (d) { S.data[key] = d; return d; })
      .catch(function (e) { S.err[key] = (e && e.message) || 'could not be read'; return null; })
      .then(function (d) { S.loading[key] = null; return d; });
    return S.loading[key];
  }
  function need() { return S.view === 'nhl' ? ['slate', 'registry'] : ['board', 'registry']; }
  function refresh() { var ks = need(); S.data = {}; return Promise.all(ks.map(function (k) { return load(k, true); })).then(render); }

  /* ------------------------------------------------------------ shell */
  function show(host, o) {
    S.host = host || S.host; o = o || {};
    if (o.view) S.view = o.view;
    if (o.game != null) S.nhlOpen = String(o.game);
    if (!S.host) return Promise.resolve();
    render();
    return Promise.all(need().map(function (k) { return load(k); })).then(render);
  }
  function banner(kind, html) { return '<div class="xe-banner ' + kind + '" role="' + (kind === 'err' ? 'alert' : 'status') + '">' + html + '</div>'; }
  function render() {
    var h = S.host; if (!h) return;
    var ks = need(), errs = ks.filter(function (k) { return S.err[k]; }), busy = ks.some(function (k) { return !S.data[k] && !S.err[k]; });
    var head = S.view === 'nhl'
      ? '<div class="xe-head"><div class="xe-title"><h3>NHL</h3><small>EdgeDesk\'s own price for every market, the goalies, the evidence and the record behind it. Research, not picks.</small></div><div class="xe-grow"></div><button class="xe-btn ghost" data-act="refresh">Refresh</button></div>'
      : '<div class="xe-head"><div class="xe-title"><h3>Multi-sport engine</h3><small>One board across every sport I cover, ranked by what the evidence supports — or PASS. Research, not picks.</small></div><div class="xe-grow"></div><button class="xe-btn ghost" data-act="refresh">Refresh</button></div>';
    var body;
    if (errs.length) body = banner('err', '<b>The engine could not load.</b> ' + esc(errs.map(function (k) { return S.err[k]; }).join('; ')) + '. Nothing is shown in its place. <button class="xe-btn" data-act="refresh">Try again</button>');
    else if (busy) body = '<div class="xe-loading" aria-busy="true">Loading…</div>';
    else body = S.view === 'nhl' ? renderNhl() : renderEngine();
    h.innerHTML = '<div class="xe">' + head + body + '</div>';
    wire(h);
  }

  /* ------------------------------------------------------------ ENGINE view */
  function renderEngine() {
    var b = S.data.board, reg = S.data.registry;
    if (!b || b.schema !== 'edgedesk_engine_board_v1' || !reg || !reg.sports) return banner('err', '<b>Integrity refusal.</b> The board or the registry is not in the expected format. Nothing is shown in its place.');
    var out = '';
    if (isStale(b.evaluated_at)) out += banner('warn', '<b>Stale board.</b> Evaluated ' + esc(ago(b.evaluated_at)) + '. Prices and freshness gates are judged at build time.');
    out += verdictCard(b);
    out += filters(b);
    out += candidatesBlock(b);
    out += readinessBlock(reg);
    out += methodsBlock(reg);
    out += '<p class="xe-foot">' + esc(b.disclaimer) + ' 21+. Gamble responsibly — 1-800-GAMBLER.</p>';
    return out;
  }
  function verdictCard(b) {
    var s = '<section class="xe-verdict ' + (b.verdict === 'PASS' ? 'pass' : 'best') + '" aria-label="Verdict">';
    if (b.verdict === 'BEST_SUPPORTED' && b.best) {
      s += '<div class="xe-vk">Best-supported opportunity</div><div class="xe-vh">' + esc(b.best.label) + '</div>' + candidateFacts(b.best, true);
    } else {
      s += '<div class="xe-vk">PASS</div><div class="xe-vh">No opportunity clears the evidence bar right now.</div><ul class="xe-why">' + (b.why || []).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>';
      var c = b.strongest_candidate;
      if (c) s += '<div class="xe-strong"><b>Closest to qualifying:</b> ' + esc(c.label) + ' (' + esc(c.sport_label) + ') — model ' + pct(c.prob && c.prob.model) + ', after shrinkage toward the market ' + pct(c.prob && c.prob.posterior) + ' (conservative ' + pct(c.prob && c.prob.conservative) + '). It would need ' + am(c.min_acceptable_american) + ' or better, and its sport would need a market-validated model.</div>';
    }
    s += '<div class="xe-vmeta">' + b.n_candidates + ' markets evaluated · ' + b.n_priced + ' with an executable price · selection bar z = ' + (b.selection_z == null ? '—' : b.selection_z) + ' · evaluated ' + esc(ago(b.evaluated_at)) + '</div>';
    return s + '</section>';
  }
  function filters(b) {
    var sports = [['all', 'All sports']].concat((b.coverage || []).filter(function (c) { return c.candidates > 0; }).map(function (c) { return [c.id, c.label]; }));
    var mk = [['all', 'All markets'], ['moneyline', 'Moneyline'], ['spread', 'Spread / puck line'], ['total', 'Total']];
    var seg = function (name, list, cur) { return '<div class="xe-seg" role="group" aria-label="' + name + '">' + list.map(function (x) { return '<button data-f="' + name + '" data-v="' + esc(x[0]) + '" class="' + (cur === x[0] ? 'on' : '') + '" aria-pressed="' + (cur === x[0]) + '">' + esc(x[1]) + '</button>'; }).join('') + '</div>'; };
    return '<div class="xe-ctl">' + seg('sport', sports, S.sport) + seg('market', mk, S.market) + '</div>';
  }
  function candidatesBlock(b) {
    var list = (b.candidates || []).filter(function (c) { return (S.sport === 'all' || c.sport_id === S.sport) && (S.market === 'all' || c.market.kind === S.market); });
    var cov = '<div class="xe-cov">' + (b.coverage || []).map(function (c) { return '<span class="xe-covi" title="' + esc(c.note) + '">' + esc(c.label) + ' ' + stateChip(c.state) + ' <span class="num">' + c.priced + '/' + c.candidates + '</span></span>'; }).join('') + '</div>';
    var head = '<div class="xe-sechd"><span>Candidates</span><span class="r">priced / evaluated per sport</span></div>' + cov;
    if (!list.length) return head + '<div class="xe-empty">No candidates for this filter. That is a valid result.</div>';
    var shown = S.showAll ? list : list.slice(0, 12);
    var html = head + '<div class="xe-list">' + shown.map(function (c) {
      var open = S.open === c.id;
      return '<article class="xe-card' + (open ? ' open' : '') + '"><button class="xe-cardh" data-open="' + esc(c.id) + '" aria-expanded="' + open + '"><span class="xe-mu">' + esc(c.label) + '</span><span class="xe-sub">' + esc(c.sport_label) + ' · ' + esc(when(c.event && c.event.start_utc)) + '</span><span class="xe-chips">' + stateChip(c.status) + (c.quote ? chip((c.quote.book || 'book') + ' ' + am(c.quote.american), c.quote.source === 'user_supplied' ? 'warn' : 'ok2', c.quote.source === 'user_supplied' ? 'a price I entered by hand' : 'captured price') : chip('no price', 'none')) + chip('fair ' + am(c.fair_american), 'tier') + '</span></button>' + (open ? candidateFacts(c, false) : '') + '</article>';
    }).join('') + '</div>';
    if (list.length > 12) html += '<button class="xe-btn ghost" data-act="all">' + (S.showAll ? 'Show fewer' : 'Show all ' + list.length) + '</button>';
    if (b.candidates_trimmed) html += '<p class="xe-note">' + b.candidates_trimmed.research_kept + ' of ' + b.candidates_trimmed.research_total + ' research rows are kept in this file (' + esc(b.candidates_trimmed.rule) + ').</p>';
    return html;
  }
  function candidateFacts(c, big) {
    var p = c.prob || {};
    var rows = [
      ['Event', esc((c.event && c.event.label) || '') + ' · ' + esc(when(c.event && c.event.start_utc))],
      ['Market', esc(c.label.split(' — ').slice(-1)[0]) + (c.market && c.market.settles ? ' <span class="xe-dim">(' + esc(c.market.settles) + ')</span>' : '')],
      ['Sportsbook', c.quote ? esc(c.quote.book) + ' ' + am(c.quote.american) + ' <span class="xe-dim">captured ' + esc(when(c.quote.captured_at)) + (c.quote.source === 'user_supplied' ? ', entered by hand' : '') + '</span>' : '<span class="xe-dim">no executable price</span>'],
      ['Fair price', am(c.fair_american)],
      ['Break-even', c.break_even == null ? '—' : pct(c.break_even)],
      ['Probability', 'model ' + pct(p.model) + (p.market_novig != null ? ' · market (no-vig) ' + pct(p.market_novig) : '') + ' · after shrinkage ' + pct(p.posterior) + ' ± ' + pct(p.sd) + ' · conservative ' + pct(p.conservative)],
      ['EV at the price', c.ev_raw == null ? '—' : 'raw ' + pct(c.ev_raw) + ' · after shrinkage ' + pct(c.ev_posterior) + ' · conservative ' + pct(c.ev_conservative)],
      ['Minimum acceptable price', am(c.min_acceptable_american) + ' <span class="xe-dim">(clears the bar only if its sport-market is validated against the close)</span>'],
    ];
    var gates = (c.gates || []).map(function (g) { return '<li class="' + (g.ok ? 'ok' : 'no') + '"><b>' + esc(g.gate) + '</b> ' + esc(g.reason) + '</li>'; }).join('');
    return '<div class="xe-facts' + (big ? ' big' : '') + '"><dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
      '<div class="xe-two"><div><div class="xe-k">Rules applied</div><ul class="xe-gates">' + gates + '</ul></div>' +
      '<div><div class="xe-k">Supporting evidence</div><ul>' + (c.evidence || []).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul><div class="xe-k">What could invalidate it</div><ul>' + (c.invalidators || []).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div></div></div>';
  }
  function readinessBlock(reg) {
    var rows = reg.sports.map(function (s) {
      var mk = Object.keys(s.readiness.markets || {}).map(function (k) { var m = s.readiness.markets[k]; return '<div class="xe-mk"><span>' + esc(k.replace(/_/g, ' ')) + '</span> ' + stateChip(m.state, m.headline || m.reason) + '<div class="xe-dim">' + esc(m.headline || m.reason) + '</div></div>'; }).join('') || '<div class="xe-dim">No market has a model.</div>';
      return '<details class="xe-sport"><summary><span class="xe-mu">' + esc(s.label) + '</span> ' + stateChip(s.readiness.state) + (s.readiness.value_claims_any ? chip('value claims on', 'ok') : chip('value claims off', 'none')) + '<span class="xe-dim"> · brain ' + esc(String(s.brain.status).replace(/_/g, ' ').toLowerCase()) + '</span></summary>' +
        '<div class="xe-sbody"><div class="xe-k">Markets</div>' + mk +
        '<div class="xe-k">Data</div><ul>' + ((s.data || []).map(function (d) { return '<li><b>' + esc(d.source) + '</b> — ' + esc(d.what) + '. ' + esc(d.cadence) + '. Licence: ' + esc(d.license) + '. Cost: ' + esc(d.cost) + '.</li>'; }).join('') || '<li>None wired.</li>') + '</ul>' +
        '<div class="xe-k">Blocked by</div><ul>' + (s.blockers || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<div class="xe-k">To enable</div><ul>' + (s.enable || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div></details>';
    }).join('');
    var sum = Object.keys(reg.summary || {}).map(function (k) { return stateChip(k) + ' <span class="num">' + reg.summary[k] + '</span>'; }).join(' ');
    return '<div class="xe-sechd"><span>Readiness by sport</span><span class="r">computed from validation files</span></div><div class="xe-cov">' + sum + '</div>' + rows;
  }
  function methodsBlock(reg) {
    var src = reg.sources || {};
    var rows = reg.sports.map(function (s) {
      var cands = (s.brain.candidates || []).map(function (c) { return '<li><b>' + esc(c.name) + '</b> — ' + esc(c.role) + (c.sources && c.sources.length ? ' <span class="xe-dim">[' + c.sources.map(esc).join(', ') + ']</span>' : '') + '</li>'; }).join('');
      return '<details class="xe-sport"><summary><span class="xe-mu">' + esc(s.label) + '</span> <span class="xe-dim">' + esc(s.brain.id || 'not built') + '</span></summary><div class="xe-sbody"><p>' + esc(s.brain.approach) + '</p><p class="xe-dim">' + esc(s.brain.why) + '</p><div class="xe-k">Methods considered</div><ul>' + cands + '</ul>' +
        (s.brain.not_modelled && s.brain.not_modelled.length ? '<div class="xe-k">Not modelled</div><ul>' + s.brain.not_modelled.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div></details>';
    }).join('');
    var refs = '<details class="xe-sport"><summary><span class="xe-mu">Sources</span></summary><div class="xe-sbody"><ul class="xe-refs">' + Object.keys(src).map(function (k) { return '<li><b>' + esc(k) + '</b> ' + esc(src[k]) + '</li>'; }).join('') + '</ul></div></details>';
    return '<div class="xe-sechd"><span>Methods and sources</span><span class="r">published methods, adapted and tested here</span></div>' + rows + refs;
  }

  /* ------------------------------------------------------------ NHL view */
  function renderNhl() {
    var s = S.data.slate;
    if (!s || s.schema !== 'edgedesk_nhl_slate_v1' || !Array.isArray(s.games)) return banner('err', '<b>Integrity refusal.</b> The NHL slate is not in the expected format. Nothing is shown in its place.');
    var r = s.readiness, out = '';
    if (isStale(s.generated_at)) out += banner('warn', '<b>Stale prices.</b> The slate was built ' + esc(ago(s.generated_at)) + '. Goalies and results may have changed since.');
    out += '<section class="xe-ready" aria-label="Readiness"><div><span class="xe-k">Data</span> ' + stateChip(r.data.state) + ' <span class="xe-dim">latest result ' + esc(r.data.latest_completed_game || '—') + (r.data.results_lagging && r.data.results_lagging.length ? ' · ' + r.data.results_lagging.length + ' finals not yet in the feed' : '') + '</span></div>' +
      '<div><span class="xe-k">Model</span> moneyline ' + stateChip(r.model.moneyline && r.model.moneyline.status) + ' puck line ' + stateChip(r.model.puck_line && r.model.puck_line.status) + ' total ' + stateChip(r.model.total && r.model.total.status, (r.model.total && r.model.total.failed || []).join('; ')) + '</div>' +
      '<div><span class="xe-k">Market</span> ' + stateChip(r.market.state) + ' <span class="xe-dim">' + esc(r.market.reason || '') + '</span></div>' +
      '<div><span class="xe-k">Value claims</span> ' + stateChip(r.value_claims.state) + ' <span class="xe-dim">' + esc((r.value_claims.reasons || []).join('; ')) + '</span></div></section>';
    if (S.nhlOpen) { var g = s.games.filter(function (x) { return String(x.game_id) === S.nhlOpen; })[0]; if (g) return out + gameDetail(s, g); out += banner('warn', 'Game ' + esc(S.nhlOpen) + ' is not on the current slate (it may have started).'); S.nhlOpen = null; }
    if (!s.games.length) out += '<div class="xe-empty">No NHL games in the next ' + esc(s.horizon_hours) + ' hours. That is a valid result.</div>';
    else out += '<div class="xe-list">' + s.games.map(function (g) {
      var m = g.prices.moneyline, t = g.prices.total, pl = g.prices.puck_line, fav = m.home >= 0.5;
      return '<button class="xe-card xe-game" data-game="' + esc(g.game_id) + '"><span class="xe-mu">' + esc(g.away) + ' @ ' + esc(g.home) + '</span><span class="xe-sub">' + esc(when(g.start_utc)) + (g.venue ? ' · ' + esc(g.venue) : '') + '</span>' +
        '<span class="xe-row"><span class="k">ML</span><span class="v num">' + esc(g.away) + ' ' + am(m.fair_away) + ' · ' + esc(g.home) + ' ' + am(m.fair_home) + '</span></span>' +
        '<span class="xe-row"><span class="k">Puck line</span><span class="v num">' + (fav ? esc(g.home) + ' −1.5 ' + am(pl.fair_home_minus_1_5) : esc(g.away) + ' −1.5 ' + am(pl.fair_away_minus_1_5)) + '</span></span>' +
        '<span class="xe-row"><span class="k">Total</span><span class="v num">' + t.expected + ' · fair line ' + t.fair_line + '</span><span class="xe-dim">OT ' + pct(g.prices.p_overtime, 0) + '</span></span>' +
        '<span class="xe-row"><span class="k">Goalies</span>' + stateChip(g.goalies.certainty) + '</span></button>';
    }).join('') + '</div>';
    out += recordBlock(s);
    out += '<p class="xe-foot">' + esc(s.attribution) + '</p>';
    return out;
  }
  function gameDetail(s, g) {
    var m = g.prices.moneyline, rg = g.prices.regulation, pl = g.prices.puck_line, t = g.prices.total;
    var tot = Object.keys(t.lines).map(Number).sort(function (a, b) { return a - b; }).map(function (L) { var x = t.lines[L]; return '<tr><td>' + L + '</td><td class="num">' + pct(x.over) + '</td><td class="num">' + am(x.fair_over) + '</td><td class="num">' + pct(x.under) + '</td><td class="num">' + am(x.fair_under) + '</td><td class="num">' + (x.push ? pct(x.push) : '—') + '</td></tr>'; }).join('');
    var tt = ['home', 'away'].map(function (side) { var o = g.prices.team_total[side]; return Object.keys(o).map(Number).sort(function (a, b) { return a - b; }).map(function (L) { var x = o[L]; return '<tr><td>' + esc(g[side]) + ' ' + L + '</td><td class="num">' + pct(x.over) + '</td><td class="num">' + am(x.fair_over) + '</td><td class="num">' + pct(x.under) + '</td><td class="num">' + am(x.fair_under) + '</td></tr>'; }).join(''); }).join('');
    var sc = g.goalies.scenarios.map(function (x) { return '<tr><td>' + esc(x.home_goalie_name || '—') + '</td><td>' + esc(x.away_goalie_name || '—') + '</td><td class="num">' + pct(x.p_scenario, 0) + '</td><td class="num">' + pct(x.p_home) + '</td><td class="num">' + x.exp_total + '</td></tr>'; }).join('');
    var ev = function (side) { var e = g.evidence[side]; return '<tr><td>' + esc(g[side]) + '</td><td class="num">' + e.ev_xg_for_vs_league + '</td><td class="num">' + e.ev_xg_against_vs_league + '</td><td class="num">' + e.goals_for_vs_league + '</td><td class="num">' + e.pp_vs_league + '</td><td class="num">' + e.rest_days + (e.back_to_back ? ' (B2B)' : '') + '</td></tr>'; };
    var cb = g.uncertainty.calibration_bin;
    return '<button class="xe-btn ghost" data-act="back">← All games</button><section class="xe-detail"><h4>' + esc(g.away) + ' @ ' + esc(g.home) + '</h4><div class="xe-sub">' + esc(when(g.start_utc)) + (g.venue ? ' · ' + esc(g.venue) : '') + ' · expected regulation goals ' + g.lambda.away + ' – ' + g.lambda.home + '</div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Moneyline <span class="xe-dim">(' + esc(m.settles) + ')</span></caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.away) + '</td><td class="num">' + pct(m.away) + '</td><td class="num">' + am(m.fair_away) + '</td></tr><tr><td>' + esc(g.home) + '</td><td class="num">' + pct(m.home) + '</td><td class="num">' + am(m.fair_home) + '</td></tr></table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>60-minute 3-way <span class="xe-dim">(' + esc(rg.settles) + ')</span></caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.away) + '</td><td class="num">' + pct(rg.away) + '</td><td class="num">' + am(rg.fair_away) + '</td></tr><tr><td>Draw</td><td class="num">' + pct(rg.draw) + '</td><td class="num">' + am(rg.fair_draw) + '</td></tr><tr><td>' + esc(g.home) + '</td><td class="num">' + pct(rg.home) + '</td><td class="num">' + am(rg.fair_home) + '</td></tr></table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Puck line <span class="xe-dim">(' + esc(pl.settles) + ')</span></caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.home) + ' −1.5</td><td class="num">' + pct(pl.home_minus_1_5) + '</td><td class="num">' + am(pl.fair_home_minus_1_5) + '</td></tr><tr><td>' + esc(g.away) + ' +1.5</td><td class="num">' + pct(pl.away_plus_1_5) + '</td><td class="num">' + am(pl.fair_away_plus_1_5) + '</td></tr><tr><td>' + esc(g.away) + ' −1.5</td><td class="num">' + pct(pl.away_minus_1_5) + '</td><td class="num">' + am(pl.fair_away_minus_1_5) + '</td></tr><tr><td>' + esc(g.home) + ' +1.5</td><td class="num">' + pct(pl.home_plus_1_5) + '</td><td class="num">' + am(pl.fair_home_plus_1_5) + '</td></tr></table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Total — expected ' + t.expected + ', fair line ' + t.fair_line + ' <span class="xe-dim">(' + esc(t.settles) + ')</span></caption><tr><th>Line</th><th>Over</th><th>Fair</th><th>Under</th><th>Fair</th><th>Push</th></tr>' + tot + '</table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Team totals <span class="xe-dim">(provisional: not separately validated)</span></caption><tr><th>Line</th><th>Over</th><th>Fair</th><th>Under</th><th>Fair</th></tr>' + tt + '</table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Goalies — ' + esc(String(g.goalies.certainty).replace(/_/g, ' ').toLowerCase()) + (g.goalies.confirmed_source ? ' (' + esc(g.goalies.confirmed_source.source) + ')' : '') + '</caption><tr><th>' + esc(g.home) + '</th><th>' + esc(g.away) + '</th><th>Chance</th><th>' + esc(g.home) + ' wins</th><th>Total</th></tr>' + sc + '</table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Evidence (× league average)</caption><tr><th></th><th>5v5 xG for</th><th>5v5 xG against</th><th>Goals for</th><th>Power play</th><th>Rest</th></tr>' + ev('home') + ev('away') + '</table></div>' +
      '<div class="xe-k">Uncertainty</div><p>Spread across validated variants: ±' + g.uncertainty.moneyline_sd_pp + ' points on the moneyline, ±' + g.uncertainty.total_sd_goals + ' goals on the total. ' + esc(g.uncertainty.basis) + (cb ? ' In the held-out record, games the model priced at ' + pct(cb.range[0], 0) + '–' + pct(cb.range[1], 0) + ' were won ' + pct(cb.observed) + ' of the time (95% ' + pct(cb.wilson95[0]) + '–' + pct(cb.wilson95[1]) + ', n ' + cb.n + ').' : '') + '</p>' +
      '<div class="xe-k">What could invalidate this price</div><ul>' + g.invalidators.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      priceCheck(g) + '</section>';
  }
  function priceCheck(g) {
    var opts = [['moneyline:home', g.home + ' moneyline', g.prices.moneyline.home, 0], ['moneyline:away', g.away + ' moneyline', g.prices.moneyline.away, 0], ['pl:home-', g.home + ' −1.5', g.prices.puck_line.home_minus_1_5, 0], ['pl:away+', g.away + ' +1.5', g.prices.puck_line.away_plus_1_5, 0], ['pl:away-', g.away + ' −1.5', g.prices.puck_line.away_minus_1_5, 0], ['pl:home+', g.home + ' +1.5', g.prices.puck_line.home_plus_1_5, 0]];
    Object.keys(g.prices.total.lines).forEach(function (L) { var x = g.prices.total.lines[L]; opts.push(['o:' + L, 'Over ' + L, x.over, x.push || 0], ['u:' + L, 'Under ' + L, x.under, x.push || 0]); });
    var sel = opts.filter(function (o) { return o[0] === S.check.market; })[0] || opts[0];
    var a = num(S.check.price), res = '';
    if (a != null && Math.abs(a) >= 100) {
      var d = a > 0 ? 1 + a / 100 : 1 + 100 / -a, p = sel[2], push = sel[3];
      var be = (1 - push) / d, ev = p * d - (1 - push);
      res = '<div class="xe-pc-res" role="status">Break-even ' + pct(be) + ' · EdgeDesk ' + pct(p) + ' · EV ' + pct(ev) + ' per unit at ' + am(a) + '. <b>Not a value call:</b> NHL value claims are disabled until the model is tested against closing prices.</div>';
    } else if (S.check.price) res = '<div class="xe-pc-res bad" role="status">Enter an American price such as −135 or +120.</div>';
    return '<div class="xe-k">Check a price</div><form class="xe-pc" data-form="check"><label class="xe-lab">Market <select class="xe-in" name="market">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === sel[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label><label class="xe-lab">Price <input class="xe-in num" name="price" inputmode="numeric" placeholder="-135" value="' + esc(S.check.price) + '"></label><button class="xe-btn acc" type="submit">Check</button></form>' + res;
  }
  function recordBlock(s) {
    var rec = s.record || {}, ml = rec.moneyline || {};
    var head = '<div class="xe-sechd"><span>The record</span><span class="r">walk-forward, seasons the model never saw</span></div>';
    var cmp = rec.comparisons ? Object.keys(rec.comparisons).filter(function (k) { return /_vs_(elo|goals_only)$/.test(k); }).map(function (k) { var c = rec.comparisons[k]; return '<li>vs ' + esc(k.split('_vs_')[1].replace('_', ' ')) + ': log loss ' + (c.mean_diff < 0 ? 'lower by ' : 'higher by ') + Math.abs(c.mean_diff) + ' (95% ' + c.ci95.join(' to ') + ', n ' + c.n + ')' + (c.a_better ? ' — better' : ' — not distinguishable') + '</li>'; }).join('') : '';
    var body = '<p>Moneyline: ' + stateChip(ml.status) + ' n ' + (ml.n || '—') + ', log loss ' + (ml.log_loss || '—') + ', Brier ' + (ml.brier || '—') + ', calibration slope ' + (ml.calibration_slope || '—') + '. Against the closing market: ' + stateChip(ml.market_status) + '.</p><ul>' + cmp + '</ul><p class="xe-dim">Leakage audit: ' + (rec.leakage ? rec.leakage.checked + ' predictions checked, ' + rec.leakage.violations + ' violations' : '—') + '.</p>';
    var full = '';
    if (S.recordOpen) {
      var R = S.data.record;
      if (!R) full = S.err.record ? banner('err', esc(S.err.record)) : '<div class="xe-loading">Loading the record…</div>';
      else {
        var w = R.windows, cands = Object.keys(w.confirmation.by_candidate);
        full = '<div class="xe-tw"><table class="xe-t"><caption>Moneyline log loss (lower is better)</caption><tr><th>Model</th><th>Selection ' + w.selection.seasons.join('–') + '</th><th>Confirmation ' + w.confirmation.seasons.join('–') + '</th><th>Live ' + w.live.seasons[0] + '</th></tr>' + cands.map(function (c) { return '<tr' + (c === R.selection.chosen ? ' class="on"' : '') + '><td>' + esc(c.replace(/_/g, ' ')) + '</td><td class="num">' + w.selection.by_candidate[c].moneyline.log_loss + '</td><td class="num">' + w.confirmation.by_candidate[c].moneyline.log_loss + '</td><td class="num">' + (w.live.by_candidate[c].moneyline.log_loss == null ? '—' : w.live.by_candidate[c].moneyline.log_loss) + ' <span class="xe-dim">n ' + w.live.n + '</span></td></tr>'; }).join('') + '</table></div>' +
          '<div class="xe-tw"><table class="xe-t"><caption>Calibration of the chosen model, confirmation window</caption><tr><th>Priced at</th><th>n</th><th>Model</th><th>Observed</th><th>95%</th></tr>' + (w.confirmation.by_candidate[R.selection.chosen].moneyline.bins || []).map(function (b) { return '<tr><td>' + pct(b.lo, 0) + '–' + pct(b.hi, 0) + '</td><td class="num">' + b.n + '</td><td class="num">' + pct(b.mean_p) + '</td><td class="num">' + pct(b.observed) + '</td><td class="num">' + pct(b.wilson_low) + '–' + pct(b.wilson_high) + '</td></tr>'; }).join('') + '</table></div>' +
          '<ul class="xe-dim">' + (R.caveats || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>';
      }
    }
    return head + body + '<button class="xe-btn ghost" data-act="record" aria-expanded="' + S.recordOpen + '">' + (S.recordOpen ? 'Hide the full record' : 'Show the full record') + '</button>' + full;
  }

  /* ------------------------------------------------------------ events */
  function wire(h) {
    h.onclick = function (e) {
      var t = e.target.closest ? e.target.closest('[data-act],[data-open],[data-f],[data-game]') : null; if (!t) return;
      if (t.dataset.act === 'refresh') { refresh(); return; }
      if (t.dataset.act === 'all') { S.showAll = !S.showAll; render(); return; }
      if (t.dataset.act === 'back') { S.nhlOpen = null; setHash(null); render(); return; }
      if (t.dataset.act === 'record') { S.recordOpen = !S.recordOpen; render(); if (S.recordOpen && !S.data.record) load('record').then(render); return; }
      if (t.dataset.open) { S.open = S.open === t.dataset.open ? null : t.dataset.open; render(); return; }
      if (t.dataset.f) { S[t.dataset.f] = t.dataset.v; S.showAll = false; render(); return; }
      if (t.dataset.game) { S.nhlOpen = t.dataset.game; setHash(S.nhlOpen); render(); try { h.scrollIntoView({ block: 'start' }); } catch (_) {} }
    };
    h.onsubmit = function (e) {
      var f = e.target; if (!f || f.dataset.form !== 'check') return;
      e.preventDefault(); S.check.market = f.market.value; S.check.price = String(f.price.value || '').trim().replace(/[−–]/g, '-'); render();
    };
  }
  function setHash(game) {
    try { var base = '#research/nhl'; var want = game ? base + '/' + game : base; if (location.hash !== want && S.view === 'nhl') history.replaceState(null, '', want); } catch (_) {}
    try { if (W.edScreenSet) W.edScreenSet({ panel: 'nhl', sport: 'icehockey_nhl', game_id: game || null }); } catch (_) {}
  }

  W.EDEngineUI = {
    show: show, refresh: refresh,
    hasData: function () { return need().every(function (k) { return !!S.data[k]; }); },
    openGame: function (id) { S.view = 'nhl'; S.nhlOpen = String(id); render(); },
    closeGame: function () { S.nhlOpen = null; render(); },
    entityOpen: function () { return S.view === 'nhl' && !!S.nhlOpen; },
    entityKey: function () { return S.nhlOpen; },
    freshness: function () { var d = S.view === 'nhl' ? S.data.slate : S.data.board; return { loadedAt: d ? Date.now() : null, builtAt: d ? Date.parse(d.generated_at || d.evaluated_at) : null }; },
    _state: S
  };
})(typeof window !== 'undefined' ? window : this);
