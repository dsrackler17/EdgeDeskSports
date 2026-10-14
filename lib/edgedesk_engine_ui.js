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
  var FILES = { board: '/engine/board.json', registry: '/engine/registry.json', slate: '/hockey/slate.json', record: '/hockey/validation/nhl_walkforward.json',
    props: '/hockey/props/slate.json', diagnostics: '/hockey/validation/nhl_diagnostics.json', sources: '/hockey/sources/registry.json' };
  var STALE_H = 18;
  var S = { host: null, view: 'engine', data: {}, err: {}, loading: {}, sport: 'all', market: 'all', open: null, nhlOpen: null, showAll: false, recordOpen: false, check: { market: 'moneyline:home', price: '' }, nhlTab: 'overview', sourcesOpen: false, scn: { home: '', away: '', lineup: false, adjH: 0, adjA: 0 } };

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
  var STATE_CLS = { MARKET_VALIDATED: 'ok', OUTCOME_VALIDATED: 'ok2', EXPERIMENTAL: 'warn', RESEARCH_ONLY: 'none', UNAVAILABLE: 'bad', RETIRED: 'none', PROVISIONAL: 'warn', NOT_TESTED: 'none', QUALIFIED: 'ok', FRAGILE: 'warn', WATCH: 'warn', RESEARCH: 'none', DATA_CHECK: 'bad', CORRELATED: 'none', NO_VALUE: 'none', STARTED: 'none', FRESH: 'ok2', STALE: 'bad', DISABLED: 'bad', NOT_CAPTURED: 'none' };
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
    out += ladderBlock(reg, b);
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
    var mk = [['all', 'All markets'], ['moneyline', 'Moneyline'], ['three_way', '1X2'], ['spread', 'Spread / puck line'], ['asian_handicap', 'Asian handicap'], ['total', 'Total']];
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
    if (c.settlement && c.settlement.split) rows.push(['Settlement', 'two half stakes (quarter line): priced as a ' + pct(c.settlement.effective_p_win) + ' win with ' + pct(c.settlement.stake_returned) + ' of the stake returned']);
    else if (c.settlement && c.settlement.p_void) rows.push(['Settlement', pct(c.settlement.p_void) + ' chance the bet is void (stake returned)']);
    if (c.sensitivity && c.sensitivity.length) rows.push(['Sensitivity', c.sensitivity.map(function (x) { return esc(x.check) + ': ' + pct(x.ev_conservative) + (x.survives ? ' ✓' : ' ✗'); }).join(' · ')]);
    var gates = (c.gates || []).map(function (g) { return '<li class="' + (g.ok ? 'ok' : 'no') + '"><b>' + esc(g.gate) + '</b> ' + esc(g.reason) + '</li>'; }).join('');
    return '<div class="xe-facts' + (big ? ' big' : '') + '"><dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>' +
      '<div class="xe-two"><div><div class="xe-k">Rules applied</div><ul class="xe-gates">' + gates + '</ul></div>' +
      '<div><div class="xe-k">Supporting evidence</div><ul>' + (c.evidence || []).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul><div class="xe-k">What could invalidate it</div><ul>' + (c.invalidators || []).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div></div></div>';
  }
  /* the readiness ladder: what is true of each sport, rung by rung (registry + the board's live rungs) */
  var RUNGS = [['data_loaded', 'Historical data loaded'], ['model_trained', 'Model trained'], ['validation_passed', 'Validation passed'], ['market_tested', 'Tested vs closing prices'], ['market_verified', 'Market price verified now'], ['actionable', 'Actionable signal']];
  function ladderBlock(reg, b) {
    var cov = {}; ((b && b.coverage) || []).forEach(function (c) { cov[c.id] = c; });
    var head = '<tr><th scope="col">Sport</th>' + RUNGS.map(function (r) { return '<th scope="col">' + esc(r[1]) + '</th>'; }).join('') + '</tr>';
    var rows = reg.sports.map(function (s) {
      var L = Object.assign({}, s.readiness.ladder || {}, (cov[s.id] && cov[s.id].ladder) || {});
      return '<tr><th scope="row">' + esc(s.label) + '</th>' + RUNGS.map(function (r) { var x = L[r[0]] || { done: false, detail: null }; return '<td class="' + (x.done ? (x.partial ? 'part' : 'yes') : 'no') + '" title="' + esc(x.detail || '') + '"><span aria-hidden="true">' + (x.done ? (x.partial ? '½' : '✓') : '—') + '</span><span class="xe-sr">' + (x.done ? (x.partial ? 'partly (not the primary market)' : 'yes') : 'no') + (x.detail ? ': ' + esc(x.detail) : '') + '</span></td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="xe-sechd"><span>Readiness ladder</span><span class="r">each rung is computed; none is typed in</span></div><div class="xe-tw"><table class="xe-t xe-ladder"><caption>A sport is actionable only at the last rung: its market beat the close out of sample and a fresh verified price clears the bar now. ½ = validated only on a secondary market, not the sport\'s primary one.</caption>' + head + rows + '</table></div>';
  }
  function readinessBlock(reg) {
    var rows = reg.sports.map(function (s) {
      var lad = s.readiness.ladder ? '<div class="xe-k">Ladder</div><ul>' + RUNGS.slice(0, 4).map(function (r) { var x = s.readiness.ladder[r[0]]; return x ? '<li>' + (x.done ? '✓ ' : '— ') + esc(r[1]) + (x.detail ? ' <span class="xe-dim">(' + esc(x.detail) + ')</span>' : '') + '</li>' : ''; }).join('') + '</ul>' : '';
      var mk = Object.keys(s.readiness.markets || {}).map(function (k) { var m = s.readiness.markets[k]; return '<div class="xe-mk"><span>' + esc(k.replace(/_/g, ' ')) + '</span> ' + stateChip(m.state, m.headline || m.reason) + '<div class="xe-dim">' + esc(m.headline || m.reason) + '</div></div>'; }).join('') || '<div class="xe-dim">No market has a model.</div>';
      return '<details class="xe-sport"><summary><span class="xe-mu">' + esc(s.label) + '</span> ' + stateChip(s.readiness.state, s.readiness.label) + (s.readiness.partial ? chip('secondary markets only', 'warn', s.readiness.label) : '') + (s.readiness.value_claims_any ? chip('value claims on', 'ok') : chip('value claims off', 'none')) + '<span class="xe-dim"> · brain ' + esc(String(s.brain.status).replace(/_/g, ' ').toLowerCase()) + '</span></summary>' +
        '<div class="xe-sbody">' + lad + '<div class="xe-k">Markets</div>' + mk +
        '<div class="xe-k">Data</div><ul>' + ((s.data || []).map(function (d) { return '<li><b>' + esc(d.source) + '</b> — ' + esc(d.what) + '. ' + esc(d.cadence) + '. Licence: ' + esc(d.license) + '. Cost: ' + esc(d.cost) + '.</li>'; }).join('') || '<li>None wired.</li>') + '</ul>' +
        ((s.gaps && s.gaps.length) ? '<div class="xe-k">Known data gaps</div><ul>' + s.gaps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
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
        (s.brain.not_modelled && s.brain.not_modelled.length ? '<div class="xe-k">Not modelled</div><ul>' + s.brain.not_modelled.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        (s.research && s.research.page ? '<p><a href="' + esc(s.research.page) + '">Open the research engine →</a> <span class="xe-dim">team, player, lineup and matchup research; runs without odds</span></p>' : '') + '</div></details>';
    }).join('');
    var refs = '<details class="xe-sport"><summary><span class="xe-mu">Sources</span></summary><div class="xe-sbody"><ul class="xe-refs">' + Object.keys(src).map(function (k) { return '<li><b>' + esc(k) + '</b> ' + esc(src[k]) + '</li>'; }).join('') + '</ul></div></details>';
    return '<div class="xe-sechd"><span>Methods and sources</span><span class="r">published methods, adapted and tested here</span></div>' + rows + refs;
  }

  /* ------------------------------------------------------------ NHL view */
  var TABS = [['overview', 'Overview'], ['markets', 'Markets'], ['scenarios', 'Scenarios'], ['players', 'Players'], ['evidence', 'Evidence'], ['models', 'Models'], ['record', 'Record']];
  var LABEL_CLS = { VERIFIED_VALUE: 'ok', PROVISIONAL: 'warn', RESEARCH_ONLY: 'none', PASS: 'none', OUTCOME_VALIDATED: 'ok2', NOT_SCORED: 'none' };
  function lab(s, title) { return chip(String(s || '—').replace(/_/g, ' ').toLowerCase(), LABEL_CLS[s] || STATE_CLS[s] || 'none', title); }
  function pp(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toFixed(1) + ' pp'; }
  function line(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + n; }
  /* lazy browser dependencies: the same pricing code the slate used, and the market engine */
  var SCRIPTS = { dist: '/hockey/model/distribution.js', market: '/lib/edgedesk_nhl_market.js' };
  var scriptP = {};
  function script(k) {
    if (k === 'dist' && W.EDNHLDist) return Promise.resolve(); if (k === 'market' && W.EDNHLMarket) return Promise.resolve();
    if (scriptP[k]) return scriptP[k];
    scriptP[k] = new Promise(function (res, rej) { var el = document.createElement('script'); el.src = SCRIPTS[k] + bust(); el.onload = function () { res(); }; el.onerror = function () { scriptP[k] = null; rej(new Error(SCRIPTS[k] + ' could not be loaded')); }; document.head.appendChild(el); });
    return scriptP[k];
  }

  function renderNhl() {
    var s = S.data.slate;
    if (!s || s.schema !== 'edgedesk_nhl_slate_v1' || !Array.isArray(s.games)) return banner('err', '<b>Integrity refusal.</b> The NHL slate is not in the expected format. Nothing is shown in its place.');
    var r = s.readiness, out = '';
    if (isStale(s.generated_at)) out += banner('warn', '<b>Stale prices.</b> The slate was built ' + esc(ago(s.generated_at)) + '. Goalies and results may have changed since.');
    out += '<section class="xe-ready" aria-label="Readiness"><div><span class="xe-k">Data</span> ' + stateChip(r.data.state) + ' <span class="xe-dim">latest result ' + esc(r.data.latest_completed_game || '—') + (r.data.hours_since_latest_result != null ? ' (' + Math.round(r.data.hours_since_latest_result) + ' h ago)' : '') + (r.data.results_lagging && r.data.results_lagging.length ? ' · ' + r.data.results_lagging.length + ' finals not yet in the feed' : '') + '</span></div>' +
      '<div><span class="xe-k">Model</span> moneyline ' + stateChip(r.model.moneyline && r.model.moneyline.status) + ' puck line ' + stateChip(r.model.puck_line && r.model.puck_line.status) + ' total ' + stateChip(r.model.total && r.model.total.status, (r.model.total && r.model.total.failed || []).join('; ')) + (r.model.team_total ? ' team totals ' + stateChip(r.model.team_total.status) : '') + '</div>' +
      '<div><span class="xe-k">Market</span> ' + stateChip(r.market.state) + ' <span class="xe-dim">' + esc(r.market.reason || '') + '</span></div>' +
      '<div><span class="xe-k">Value claims</span> ' + stateChip(r.value_claims.state) + ' <span class="xe-dim">' + esc((r.value_claims.reasons || []).join('; ')) + '</span></div></section>';
    if (S.nhlOpen) { var g = s.games.filter(function (x) { return String(x.game_id) === S.nhlOpen; })[0]; if (g) return out + gameDetail(s, g); out += banner('warn', 'Game ' + esc(S.nhlOpen) + ' is not on the current slate (it may have started).'); S.nhlOpen = null; }
    if (!s.games.length) out += '<div class="xe-empty">No NHL games in the next ' + esc(s.horizon_hours) + ' hours. That is a valid result.</div>';
    else out += '<div class="xe-list">' + s.games.map(function (g) {
      var m = g.prices.moneyline, t = g.prices.total, pl = g.prices.puck_line, fav = m.home >= 0.5;
      var top = g.explanation && g.explanation.factors && g.explanation.factors[0];
      return '<button class="xe-card xe-game" data-game="' + esc(g.game_id) + '"><span class="xe-mu">' + esc(g.away) + ' @ ' + esc(g.home) + '</span><span class="xe-sub">' + esc(when(g.start_utc)) + (g.venue ? ' · ' + esc(g.venue) : '') + '</span>' +
        '<span class="xe-row"><span class="k">ML</span><span class="v num">' + esc(g.away) + ' ' + am(m.fair_away) + ' · ' + esc(g.home) + ' ' + am(m.fair_home) + '</span><span class="xe-dim">' + esc(fav ? g.home : g.away) + ' ' + pct(fav ? m.home : m.away) + '</span></span>' +
        '<span class="xe-row"><span class="k">Puck line</span><span class="v num">' + (fav ? esc(g.home) + ' −1.5 ' + am(pl.fair_home_minus_1_5) : esc(g.away) + ' −1.5 ' + am(pl.fair_away_minus_1_5)) + '</span></span>' +
        '<span class="xe-row"><span class="k">Total</span><span class="v num">' + t.expected + ' · fair line ' + t.fair_line + '</span><span class="xe-dim">OT ' + pct(g.prices.p_overtime, 0) + '</span></span>' +
        (top ? '<span class="xe-row"><span class="k">Biggest factor</span><span class="xe-dim">' + esc((top.team ? top.team + ' ' : '') + top.label.split(' (')[0]) + ' ' + pp(top.pp) + ' for ' + esc(g.home) + '</span></span>' : '') +
        '<span class="xe-row"><span class="k">Goalies</span>' + stateChip(g.goalies.certainty) + (g.challengers ? ' <span class="xe-dim">models disagree by ' + g.challengers.spread_pp + ' pp</span>' : '') + '</span></button>';
    }).join('') + '</div>';
    out += recordBlock(s);
    out += sourcesBlock();
    out += '<p class="xe-foot">' + esc(s.attribution) + '</p>';
    return out;
  }

  function gameDetail(s, g) {
    var tab = S.nhlTab || 'overview';
    var head = '<button class="xe-btn ghost" data-act="back">← All games</button><section class="xe-detail"><h4>' + esc(g.away) + ' @ ' + esc(g.home) + '</h4><div class="xe-sub">' + esc(when(g.start_utc)) + (g.venue ? ' · ' + esc(g.venue) : '') + ' · expected regulation goals ' + esc(g.away) + ' ' + Number(g.lambda.away).toFixed(2) + ' – ' + esc(g.home) + ' ' + Number(g.lambda.home).toFixed(2) + '</div>' +
      '<div class="xe-tabs" role="tablist" aria-label="Game research">' + TABS.map(function (t) { return '<button role="tab" data-tab="' + t[0] + '" aria-selected="' + (tab === t[0]) + '" class="' + (tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div class="xe-tabp" role="tabpanel">';
    var body = tab === 'markets' ? marketsTab(s, g) : tab === 'scenarios' ? scenariosTab(s, g) : tab === 'players' ? playersTab(s, g) : tab === 'evidence' ? evidenceTab(s, g) : tab === 'models' ? modelsTab(s, g) : tab === 'record' ? recordTab(s, g) : overviewTab(s, g);
    return head + body + '</div></section>';
  }

  /* ---- Overview: the number, why, how sure, and whether a price is actionable ---- */
  function overviewTab(s, g) {
    var m = g.prices.moneyline, fav = m.home >= 0.5, F = fav ? g.home : g.away;
    var out = '<div class="xe-big"><div><span class="xe-k">' + esc(F) + ' to win</span><span class="xe-bn num">' + pct(fav ? m.home : m.away) + '</span><span class="xe-dim">fair ' + am(fav ? m.fair_home : m.fair_away) + ' · ' + esc(fav ? g.away : g.home) + ' ' + am(fav ? m.fair_away : m.fair_home) + ' · ' + esc(m.settles) + '</span></div>' +
      '<div><span class="xe-k">Total goals</span><span class="xe-bn num">' + g.prices.total.expected + '</span><span class="xe-dim">fair line ' + g.prices.total.fair_line + ' · OT ' + pct(g.prices.p_overtime, 0) + ' · shootout ' + pct(g.prices.p_shootout, 0) + '</span></div></div>';
    var e = g.explanation;
    if (e) {
      var fs = e.factors || []; var max = Math.max.apply(null, fs.map(function (f) { return Math.abs(f.pp); }).concat([1]));
      out += '<div class="xe-sechd"><span>Why ' + esc(g.home) + ' is ' + pct(e.published.p_home) + '</span><span class="r">computed from the model — not written by AI</span></div>' +
        '<p class="xe-dim">Start: two league-average clubs at a neutral rink, ' + esc(g.home) + ' ' + pct(e.baseline.p_home) + '. Each factor\'s contribution is its exact Shapley value through the full pricing chain; they add up to the published ' + pct(e.published.p_home) + ' (check: ' + (e.check && e.check.exact ? 'exact' : 'not exact') + ').</p>' +
        '<ul class="xe-why2" aria-label="Factors, largest first">' + fs.map(function (f) {
          var w = Math.min(50, Math.abs(f.pp) / max * 50);
          return '<li><span class="xe-wl">' + esc((f.team ? f.team + ' ' : '') + f.label) + '</span><span class="xe-wb" aria-hidden="true"><span class="xe-wz"></span><span class="xe-wbar ' + (f.pp >= 0 ? 'pos' : 'neg') + '" style="' + (f.pp >= 0 ? 'left:50%' : 'right:50%') + ';width:' + w.toFixed(1) + '%"></span></span><span class="xe-wv num">' + pp(f.pp) + '</span></li>';
        }).join('') + '<li class="xe-wsum"><span class="xe-wl">Published</span><span class="xe-wb" aria-hidden="true"></span><span class="xe-wv num">' + pct(e.published.p_home) + '</span></li></ul>' +
        '<div class="xe-k">In words <span class="xe-dim">(a fixed template over the numbers above; no language model)</span></div><ul>' + (e.narrative || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
    }
    /* how sure */
    var u = g.uncertainty || {}, ch = g.challengers;
    var scen = (g.goalies && g.goalies.scenarios || []).map(function (x) { return x.p_home; });
    out += '<div class="xe-sechd"><span>How sure</span><span class="r">sensitivity, not a confidence interval</span></div><ul>' +
      '<li>Goalies: ' + stateChip(g.goalies.certainty) + (scen.length ? ' — ' + esc(g.home) + ' ' + pct(Math.min.apply(null, scen)) + ' to ' + pct(Math.max.apply(null, scen)) + ' across the projected pairings' : '') + '.</li>' +
      '<li>Validated variants spread ±' + u.moneyline_sd_pp + ' pp on the moneyline, ±' + u.total_sd_goals + ' goals on the total.</li>' +
      (ch ? '<li>The ' + ch.models.length + ' models in the lab range over ' + ch.spread_pp + ' pp for ' + esc(g.home) + ' (see Models). Only the production model prices.</li>' : '') +
      (u.calibration_bin ? '<li>Held-out games priced ' + pct(u.calibration_bin.range[0], 0) + '–' + pct(u.calibration_bin.range[1], 0) + ' were won ' + pct(u.calibration_bin.observed) + ' of the time (95% ' + pct(u.calibration_bin.wilson95[0]) + '–' + pct(u.calibration_bin.wilson95[1]) + ', n ' + u.calibration_bin.n + ').</li>' : '') + '</ul>';
    out += actionable(s, g);
    out += '<div class="xe-k">What could invalidate this price</div><ul>' + g.invalidators.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    return out;
  }
  function actionable(s, g) {
    var mc = g.market_check, r = s.readiness;
    var out = '<div class="xe-sechd"><span>Is a price actionable?</span><span class="r">VERIFIED VALUE only when every gate passes</span></div>';
    if (!mc || mc.state !== 'PRICED') return out + '<p><b>No.</b> ' + esc(String((mc && mc.reason) || (r.market && r.market.reason) || 'No captured price').replace(/\.?\s*$/, '.')) + ' Value claims are off: ' + esc((r.value_claims.reasons || []).join('; ')) + '.</p>';
    var c = mc.counts || {};
    return out + '<p>' + ['VERIFIED_VALUE', 'PROVISIONAL', 'RESEARCH_ONLY', 'PASS'].filter(function (k) { return c[k]; }).map(function (k) { return lab(k) + ' <span class="num">' + c[k] + '</span>'; }).join(' ') + '</p><p class="xe-dim">Each captured price is listed with its gates under Markets.</p>';
  }

  /* ---- Markets ---- */
  function vchip(v) { return v ? lab(v, v === 'OUTCOME_VALIDATED' ? 'calibrated on held-out games' : v === 'NOT_SCORED' ? 'this line is not separately scored' : 'held-out calibration failed a rule') : ''; }
  function marketsTab(s, g) {
    var m = g.prices.moneyline, rg = g.prices.regulation, M = g.markets, st = s.market_statuses || {};
    var out = '<div class="xe-tw"><table class="xe-t"><caption>Moneyline <span class="xe-dim">(' + esc(m.settles) + ')</span> ' + vchip(st.moneyline && st.moneyline.status) + '</caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.away) + '</td><td class="num">' + pct(m.away) + '</td><td class="num">' + am(m.fair_away) + '</td></tr><tr><td>' + esc(g.home) + '</td><td class="num">' + pct(m.home) + '</td><td class="num">' + am(m.fair_home) + '</td></tr></table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>60-minute 3-way <span class="xe-dim">(' + esc(rg.settles) + ')</span> ' + vchip(M ? M.regulation_3way_validation : null) + '</caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.away) + '</td><td class="num">' + pct(rg.away) + '</td><td class="num">' + am(rg.fair_away) + '</td></tr><tr><td>Draw</td><td class="num">' + pct(rg.draw) + '</td><td class="num">' + am(rg.fair_draw) + '</td></tr><tr><td>' + esc(g.home) + '</td><td class="num">' + pct(rg.home) + '</td><td class="num">' + am(rg.fair_home) + '</td></tr></table></div>';
    if (M) {
      var two = function (rows, a, b, lbl) { return rows.map(function (x) { return '<tr><td>' + lbl(x) + '</td><td class="num">' + pct(x.p) + '</td><td class="num">' + am(x.fair) + '</td><td class="num">' + pct(x.p_other) + '</td><td class="num">' + am(x.fair_other) + '</td><td class="num">' + (x.push ? pct(x.push) : '—') + '</td><td>' + vchip(x.validation) + '</td></tr>'; }).join(''); };
      var hd = function (a, b) { return '<tr><th>Line</th><th>' + a + '</th><th>Fair</th><th>' + b + '</th><th>Fair</th><th>Push</th><th>Held-out</th></tr>'; };
      out += '<div class="xe-tw"><table class="xe-t"><caption>Puck line and alternates <span class="xe-dim">(' + esc(M.settles.puck_line) + ')</span></caption>' + hd(esc(g.home), esc(g.away)) + two(M.puck_line, 0, 0, function (x) { return esc(g.home) + ' ' + line(x.home_line) + ' / ' + esc(g.away) + ' ' + line(-x.home_line); }) + '</table></div>';
      out += '<div class="xe-tw"><table class="xe-t"><caption>Total — expected ' + g.prices.total.expected + ' <span class="xe-dim">(' + esc(M.settles.total) + ')</span></caption>' + hd('Over', 'Under') + two(M.total, 0, 0, function (x) { return x.line; }) + '</table></div>';
      out += '<div class="xe-tw"><table class="xe-t"><caption>Regulation total <span class="xe-dim">(' + esc(M.settles.regulation_total) + ')</span></caption>' + hd('Over', 'Under') + two(M.regulation_total, 0, 0, function (x) { return x.line; }) + '</table></div>';
      out += '<div class="xe-tw"><table class="xe-t"><caption>Team totals <span class="xe-dim">(' + esc(M.settles.team_total) + ')</span></caption>' + hd('Over', 'Under') + two(M.team_total.home, 0, 0, function (x) { return esc(g.home) + ' ' + x.line; }) + two(M.team_total.away, 0, 0, function (x) { return esc(g.away) + ' ' + x.line; }) + '</table></div>';
      if (M.first_period) { var fp = M.first_period; out += '<div class="xe-tw"><table class="xe-t"><caption>First period <span class="xe-dim">(' + esc(M.settles.first_period) + ')</span> ' + vchip(fp.validation_3way) + '</caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.away) + '</td><td class="num">' + pct(fp.away) + '</td><td class="num">' + am(fp.fair_away) + '</td></tr><tr><td>Tied after 20</td><td class="num">' + pct(fp.draw) + '</td><td class="num">' + am(fp.fair_draw) + '</td></tr><tr><td>' + esc(g.home) + '</td><td class="num">' + pct(fp.home) + '</td><td class="num">' + am(fp.fair_home) + '</td></tr></table></div><div class="xe-tw"><table class="xe-t"><caption>First-period total — expected ' + fp.expected + '</caption>' + hd('Over', 'Under') + two(fp.total, 0, 0, function (x) { return x.line; }) + '</table></div>'; }
    } else {
      var pl = g.prices.puck_line, t = g.prices.total;
      out += '<div class="xe-tw"><table class="xe-t"><caption>Puck line <span class="xe-dim">(' + esc(pl.settles) + ')</span></caption><tr><th></th><th>Probability</th><th>Fair</th></tr><tr><td>' + esc(g.home) + ' −1.5</td><td class="num">' + pct(pl.home_minus_1_5) + '</td><td class="num">' + am(pl.fair_home_minus_1_5) + '</td></tr><tr><td>' + esc(g.away) + ' +1.5</td><td class="num">' + pct(pl.away_plus_1_5) + '</td><td class="num">' + am(pl.fair_away_plus_1_5) + '</td></tr></table></div>' +
        '<div class="xe-tw"><table class="xe-t"><caption>Total — expected ' + t.expected + '</caption><tr><th>Line</th><th>Over</th><th>Fair</th><th>Under</th><th>Fair</th></tr>' + Object.keys(t.lines).map(function (L) { var x = t.lines[L]; return '<tr><td>' + L + '</td><td class="num">' + pct(x.over) + '</td><td class="num">' + am(x.fair_over) + '</td><td class="num">' + pct(x.under) + '</td><td class="num">' + am(x.fair_under) + '</td></tr>'; }).join('') + '</table></div>';
    }
    out += marketCheckBlock(g);
    out += priceCheck(s, g);
    return out;
  }
  function marketCheckBlock(g) {
    var mc = g.market_check;
    var head = '<div class="xe-sechd"><span>Against the books</span><span class="r">lib/edgedesk_nhl_market.js</span></div>';
    if (!mc || mc.state !== 'PRICED') return head + '<p class="xe-dim">' + esc((mc && mc.reason) || 'No captured prices for this game.') + '</p>';
    return head + '<div class="xe-tw"><table class="xe-t"><caption>Captured prices, best first</caption><tr><th>Book</th><th>Market</th><th>Price</th><th>Fair</th><th>EV</th><th>Model vs market</th><th>Age</th><th>Label</th></tr>' + mc.checks.map(function (c) { var n = c.numbers || {}; return '<tr><td>' + esc(c.book) + '</td><td>' + esc(c.market) + '</td><td class="num">' + (n.decimal ? am(n.decimal >= 2 ? (n.decimal - 1) * 100 : -100 / (n.decimal - 1)) : '—') + '</td><td class="num">' + am(n.fair_american) + '</td><td class="num">' + pct(n.ev) + '</td><td class="num">' + pp(n.disagreement_pp) + '</td><td class="num">' + (n.quote_age_minutes == null ? '—' : Math.round(n.quote_age_minutes) + ' min') + '</td><td>' + lab(c.label, (c.reasons || []).join(' · ')) + '</td></tr>'; }).join('') + '</table></div>';
  }
  function priceCheck(s, g) {
    var st = s.market_statuses || {}, M = g.markets;
    var opts = [['moneyline:home', g.home + ' moneyline', g.prices.moneyline.home, 0, (st.moneyline || {}).status], ['moneyline:away', g.away + ' moneyline', g.prices.moneyline.away, 0, (st.moneyline || {}).status]];
    if (M) {
      M.puck_line.forEach(function (x) { opts.push(['pl:h' + x.home_line, g.home + ' ' + line(x.home_line), x.p, x.push, x.validation], ['pl:a' + x.home_line, g.away + ' ' + line(-x.home_line), x.p_other, x.push, x.validation]); });
      M.total.forEach(function (x) { opts.push(['o:' + x.line, 'Over ' + x.line, x.p, x.push, x.validation], ['u:' + x.line, 'Under ' + x.line, x.p_other, x.push, x.validation]); });
      ['home', 'away'].forEach(function (sd) { M.team_total[sd].forEach(function (x) { opts.push(['tt' + sd + 'o' + x.line, g[sd] + ' over ' + x.line, x.p, x.push, x.validation], ['tt' + sd + 'u' + x.line, g[sd] + ' under ' + x.line, x.p_other, x.push, x.validation]); }); });
    } else {
      opts.push(['pl:home-', g.home + ' −1.5', g.prices.puck_line.home_minus_1_5, 0, null], ['pl:away+', g.away + ' +1.5', g.prices.puck_line.away_plus_1_5, 0, null]);
      Object.keys(g.prices.total.lines).forEach(function (L) { var x = g.prices.total.lines[L]; opts.push(['o:' + L, 'Over ' + L, x.over, x.push || 0, null], ['u:' + L, 'Under ' + L, x.under, x.push || 0, null]); });
    }
    var sel = opts.filter(function (o) { return o[0] === S.check.market; })[0] || opts[0];
    var a = num(S.check.price), res = '';
    if (a != null && Math.abs(a) >= 100) {
      var d = a > 0 ? 1 + a / 100 : 1 + 100 / -a, p = sel[2], push = sel[3] || 0;
      var be = (1 - push) / d, ev = p * d - (1 - push);
      var verdict = '';
      if (W.EDNHLMarket) {
        var r = W.EDNHLMarket.evaluate({ market: { kind: sel[0].split(':')[0], label: sel[1] }, model: { p_win: p, p_push: push, sd_pp: g.uncertainty && g.uncertainty.moneyline_sd_pp, status: sel[4] || 'NOT_SCORED', market_status: 'NOT_TESTED' }, quote: { american: a, source: 'user_supplied', captured_at: new Date().toISOString() }, context: { data_state: s.readiness.data.state, goalie_certainty: g.goalies.certainty } });
        verdict = ' ' + lab(r.label) + (r.label === 'VERIFIED_VALUE' ? '' : ' <b>Not a value call:</b> ' + esc(r.reasons.slice(0, 3).join(' · ')));
      } else verdict = ' <b>Not a value call:</b> NHL value claims are disabled until the model is tested against closing prices.';
      res = '<div class="xe-pc-res" role="status">Break-even ' + pct(be) + ' · EdgeDesk ' + pct(p) + (push ? ' (push ' + pct(push) + ')' : '') + ' · EV ' + pct(ev) + ' per unit at ' + am(a) + '.' + verdict + '</div>';
    } else if (S.check.price) res = '<div class="xe-pc-res bad" role="status">Enter an American price such as −135 or +120.</div>';
    return '<div class="xe-k">Check a price</div><form class="xe-pc" data-form="check"><label class="xe-lab">Market <select class="xe-in" name="market">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === sel[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label><label class="xe-lab">Price <input class="xe-in num" name="price" inputmode="numeric" placeholder="-135" value="' + esc(S.check.price) + '"></label><button class="xe-btn acc" type="submit">Check</button></form>' + res;
  }

  /* ---- Scenarios: re-price in the page with the slate's own distribution ---- */
  function scenariosTab(s, g) {
    var sc = (g.goalies && g.goalies.scenarios) || [];
    var hs = [], as = [];
    sc.forEach(function (x) { if (hs.indexOf(x.home_goalie) < 0) hs.push(x.home_goalie); if (as.indexOf(x.away_goalie) < 0) as.push(x.away_goalie); });
    var name = function (side, id) { var x = sc.filter(function (y) { return y[side + '_goalie'] === id; })[0]; return x ? x[side + '_goalie_name'] || ('#' + id) : '—'; };
    var p0 = function (side, id) { var L = (g.goalies[side] || []).filter(function (y) { return y.goalie === id; })[0]; return L ? ' (' + pct(L.p_start, 0) + ')' : ''; };
    var sel = function (side, list) { return '<label class="xe-lab">' + esc(g[side]) + ' goalie <select class="xe-in" data-scn="' + side + '"><option value="">projected mix</option>' + list.map(function (id) { return '<option value="' + esc(id) + '"' + (String(S.scn[side]) === String(id) ? ' selected' : '') + '>' + esc(name(side, id) + p0(side, id)) + '</option>'; }).join('') + '</select></label>'; };
    var slider = function (k, team) { return '<label class="xe-lab">' + esc(team) + ' expected goals <input type="range" min="-20" max="20" step="1" value="' + (S.scn[k] || 0) + '" data-scn="' + k + '" aria-label="' + esc(team) + ' expected goals, percent change"> <span class="num" data-scn-val="' + k + '">' + ((S.scn[k] || 0) > 0 ? '+' : '') + (S.scn[k] || 0) + '%</span></label>'; };
    return '<p class="xe-dim">Re-price every market in your browser with the same code that priced the slate (hockey/model/distribution.js). Goalie choices use the goalie-aware variant of the model; the expected-goals sliders are <b>your what-if</b>, not a model output.</p>' +
      '<form class="xe-scn" data-form="scn" onsubmit="return false">' + (hs.length ? sel('home', hs) + sel('away', as) : '<p class="xe-dim">No goalie scenarios for this game.</p>') +
      (g.repricing && g.repricing.lineup_variant ? '<label class="xe-lab xe-inl"><input type="checkbox" data-scn="lineup"' + (S.scn.lineup ? ' checked' : '') + '> lineup-aware variant (each club\'s last lineup)</label>' : '') +
      slider('adjH', g.home) + slider('adjA', g.away) + '<button class="xe-btn ghost" type="button" data-act="scn-reset">Reset</button></form><div class="xe-scn-out" aria-live="polite">' + scenarioOut(s, g) + '</div>';
  }
  function scenarioLambda(g) {
    var sc = (g.goalies && g.goalies.scenarios) || [], base = g.repricing ? g.repricing.base : g.lambda, lam = { home: base.home, away: base.away }, basis = 'production model';
    var h = S.scn.home, a = S.scn.away;
    if (h !== '' && h != null || a !== '' && a != null) {
      var pick = sc.filter(function (x) { return (h === '' || h == null || String(x.home_goalie) === String(h)) && (a === '' || a == null || String(x.away_goalie) === String(a)); });
      if (pick.length && pick[0].lambda) { var wsum = pick.reduce(function (t, x) { return t + (x.p_scenario || 0); }, 0) || pick.length; lam = { home: pick.reduce(function (t, x) { return t + x.lambda.home * ((x.p_scenario || 0) || 1); }, 0) / wsum, away: pick.reduce(function (t, x) { return t + x.lambda.away * ((x.p_scenario || 0) || 1); }, 0) / wsum }; basis = 'goalie-aware variant'; }
    } else if (S.scn.lineup && g.repricing && g.repricing.lineup_variant) { lam = { home: g.repricing.lineup_variant.home, away: g.repricing.lineup_variant.away }; basis = 'lineup-aware variant'; }
    lam.home *= 1 + (S.scn.adjH || 0) / 100; lam.away *= 1 + (S.scn.adjA || 0) / 100;
    if (S.scn.adjH || S.scn.adjA) basis += ' + your what-if';
    return { lam: lam, basis: basis };
  }
  function scenarioOut(s, g) {
    if (!W.EDNHLDist) { script('dist').then(function () { if (S.nhlTab === 'scenarios') render(); }, function (e) { S.err.dist = e.message; render(); }); return S.err.dist ? banner('err', esc(S.err.dist)) : '<div class="xe-loading">Loading the pricing code…</div>'; }
    if (!s.distribution) return banner('warn', 'This slate predates browser re-pricing.');
    var x = scenarioLambda(g), base = g.repricing ? g.repricing.base : g.lambda;
    var ot = g.repricing && g.repricing.ot === 'playoff' ? s.distribution.ot_playoff : s.distribution.ot;
    var D = W.EDNHLDist.game({ lamH: x.lam.home, lamA: x.lam.away, effects: s.distribution.effects, ot: ot });
    var B = W.EDNHLDist.game({ lamH: base.home, lamA: base.away, effects: s.distribution.effects, ot: ot });
    var rows = [
      [esc(g.home) + ' moneyline', B.p_home, D.p_home], [esc(g.away) + ' moneyline', B.p_away, D.p_away], ['60-minute draw', B.reg.draw, D.reg.draw],
      [esc(g.home) + ' −1.5', W.EDNHLDist.spread(B, -1.5).win, W.EDNHLDist.spread(D, -1.5).win], [esc(g.away) + ' −1.5', W.EDNHLDist.spread(B, 1.5).lose, W.EDNHLDist.spread(D, 1.5).lose],
      ['Over 5.5', W.EDNHLDist.total(B, 5.5).over, W.EDNHLDist.total(D, 5.5).over], ['Over 6.5', W.EDNHLDist.total(B, 6.5).over, W.EDNHLDist.total(D, 6.5).over],
      [esc(g.home) + ' over 2.5', W.EDNHLDist.teamTotal(B, 'home', 2.5).over, W.EDNHLDist.teamTotal(D, 'home', 2.5).over], [esc(g.away) + ' over 2.5', W.EDNHLDist.teamTotal(B, 'away', 2.5).over, W.EDNHLDist.teamTotal(D, 'away', 2.5).over],
    ];
    return '<div class="xe-tw"><table class="xe-t"><caption>Scenario: ' + esc(x.basis) + ' — expected goals ' + esc(g.home) + ' ' + x.lam.home.toFixed(2) + ', ' + esc(g.away) + ' ' + x.lam.away.toFixed(2) + '</caption><tr><th>Market</th><th>Published</th><th>Scenario</th><th>Fair</th><th>Move</th></tr>' + rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td class="num">' + pct(r[1]) + '</td><td class="num">' + pct(r[2]) + '</td><td class="num">' + am(W.EDNHLDist.probToAmerican(r[2])) + '</td><td class="num">' + pp((r[2] - r[1]) * 100) + '</td></tr>'; }).join('') + '<tr><td>Expected total</td><td class="num">' + W.EDNHLDist.expectedTotal(B).toFixed(2) + '</td><td class="num">' + W.EDNHLDist.expectedTotal(D).toFixed(2) + '</td><td></td><td></td></tr></table></div><p class="xe-dim">A scenario is conditional: it says what the price would be if the condition held. It is not a forecast that it will.</p>';
  }

  /* ---- Players: the prop research slate ---- */
  function playersTab(s, g) {
    var P = S.data.props;
    if (!P) { if (!S.loading.props && !S.err.props) load('props').then(render); return S.err.props ? banner('err', '<b>Player research could not load.</b> ' + esc(S.err.props)) : '<div class="xe-loading">Loading player research…</div>'; }
    var pg = (P.games || []).filter(function (x) { return x.game_id === g.game_id; })[0];
    if (!pg) return '<div class="xe-empty">No player projections for this game yet.</div>';
    var mk = P.markets || {}; var v = function (k) { return mk[k] ? lab(mk[k].status) : ''; };
    var out = '<p class="xe-dim"><b>Research only.</b> No NHL prop prices are captured, so nothing here is compared with a book or called value. Every probability assumes the player dresses (a prop on a scratch is void). Projected lineups are each club\'s last game; no injury feed is wired. Goals are a thinning of shots on goal, so each player\'s shot, goal and point numbers are mutually consistent.</p>' +
      '<p class="xe-dim">Held-out status: shots on goal 2.5 ' + v('sog_over_2.5') + ' goal ' + v('goal_anytime') + ' assist ' + v('assists_over_0.5') + ' point ' + v('points_over_0.5') + ' saves 25.5 ' + v('saves_over_25.5') + '</p>';
    ['home', 'away'].forEach(function (side) {
      var t = pg[side];
      out += '<div class="xe-tw"><table class="xe-t"><caption>' + esc(t.team) + ' skaters <span class="xe-dim">(projected from ' + esc(t.projected_lineup_from ? t.projected_lineup_from.date : '—') + ')</span></caption><tr><th>Player</th><th>Pos</th><th>TOI</th><th>SOG</th><th>2+ SOG</th><th>3+ SOG</th><th>Goal</th><th>Assist</th><th>Point</th><th>2+ pts</th></tr>' + t.skaters.slice(0, 20).map(function (p) { return '<tr><td>' + esc(p.name || ('#' + p.player_id)) + '</td><td>' + esc(p.pos) + '</td><td class="num">' + p.toi_proj + '</td><td class="num">' + p.sog.mean + '</td><td class="num">' + pct(p.sog.over_1_5, 0) + '</td><td class="num">' + pct(p.sog.over_2_5, 0) + '</td><td class="num">' + pct(p.goal, 0) + '</td><td class="num">' + pct(p.assist, 0) + '</td><td class="num">' + pct(p.point, 0) + '</td><td class="num">' + pct(p.points_2plus, 0) + '</td></tr>'; }).join('') + '</table></div>';
      if (t.goalies.length) out += '<div class="xe-tw"><table class="xe-t"><caption>' + esc(t.team) + ' goalies (if he starts)</caption><tr><th>Goalie</th><th>Start</th><th>Shots against</th><th>Saves</th><th>22.5+</th><th>25.5+</th><th>28.5+</th><th>31.5+</th></tr>' + t.goalies.map(function (x) { return '<tr><td>' + esc(x.name || ('#' + x.goalie_id)) + '</td><td class="num">' + (x.confirmed ? 'confirmed' : pct(x.p_start, 0)) + '</td><td class="num">' + x.shots_against_mean + '</td><td class="num">' + x.saves_mean + '</td>' + ['22.5', '25.5', '28.5', '31.5'].map(function (L) { return '<td class="num">' + pct(x.saves_over[L], 0) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
    });
    return out;
  }

  /* ---- Evidence ---- */
  function evidenceTab(s, g) {
    var ev = function (side) { var e = g.evidence[side]; return '<tr><td>' + esc(g[side]) + '</td><td class="num">' + e.ev_xg_for_vs_league + '</td><td class="num">' + e.ev_xg_against_vs_league + '</td><td class="num">' + e.goals_for_vs_league + '</td><td class="num">' + e.goals_against_vs_league + '</td><td class="num">' + e.pp_vs_league + '</td><td class="num">' + e.pk_xga_vs_league + '</td><td class="num">' + e.rest_days + (e.back_to_back ? ' (B2B)' : '') + '</td></tr>'; };
    var sc = g.goalies.scenarios.map(function (x) { return '<tr><td>' + esc(x.home_goalie_name || '—') + '</td><td>' + esc(x.away_goalie_name || '—') + '</td><td class="num">' + pct(x.p_scenario, 0) + '</td><td class="num">' + pct(x.p_home) + '</td><td class="num">' + x.exp_total + '</td></tr>'; }).join('');
    var gl = function (side) { return (g.goalies[side] || []).map(function (x) { return esc(x.name || '—') + ' <span class="xe-dim">' + pct(x.p_start, 0) + (x.gsax_rate != null ? ', GSAx ' + (x.gsax_rate > 0 ? '+' : '') + (x.gsax_rate * 100).toFixed(1) + '% of xG' : '') + '</span>'; }).join(' · '); };
    var out = '<div class="xe-tw"><table class="xe-t"><caption>Evidence (× league average)</caption><tr><th></th><th>5v5 xG for</th><th>5v5 xG against</th><th>Goals for</th><th>Goals against</th><th>Power play</th><th>PK xG against</th><th>Rest</th></tr>' + ev('home') + ev('away') + '</table></div>' +
      '<div class="xe-tw"><table class="xe-t"><caption>Goalies — ' + esc(String(g.goalies.certainty).replace(/_/g, ' ').toLowerCase()) + (g.goalies.confirmed_source ? ' (' + esc(g.goalies.confirmed_source.source) + ')' : '') + '</caption><tr><th>' + esc(g.home) + '</th><th>' + esc(g.away) + '</th><th>Chance</th><th>' + esc(g.home) + ' wins</th><th>Total</th></tr>' + sc + '</table></div><p class="xe-dim">' + esc(g.home) + ': ' + gl('home') + '<br>' + esc(g.away) + ': ' + gl('away') + '</p>' + lineupBlock(g);
    if (g.context) {
      var c = function (side) { var x = g.context[side]; return '<tr><td>' + esc(g[side]) + '</td><td class="num">' + x.travel_km + ' km</td><td class="num">' + (x.tz_shift > 0 ? '+' : '') + x.tz_shift + ' h</td><td class="num">' + x.games_in_prior_3_days + '</td><td class="num">' + x.road_trip_game + '</td><td class="num">' + x.recent_5v5_xg_for_vs_last_40 + '</td><td class="num">' + x.goals_vs_xg_last_20 + '</td></tr>'; };
      out += '<div class="xe-tw"><table class="xe-t"><caption>Schedule and form <span class="xe-dim">(measured, not in the price)</span></caption><tr><th></th><th>Travel</th><th>Clock change</th><th>Games, prior 3 days</th><th>Road game no.</th><th>5v5 xG for, last 10 ÷ last 40</th><th>Goals ÷ xG, last 20</th></tr>' + c('home') + c('away') + '</table></div><p class="xe-note">' + esc(g.context.note) + '</p>';
    }
    return out;
  }
  function lineupBlock(g) {
    var L = g.lineups; if (!L) return '';
    var side = function (k) { var x = L[k]; var miss = (x.regulars_absent || []).map(function (m) { return esc(m.name || ('#' + m.player_id)) + ' <span class="xe-dim">(' + esc(m.toi_per_game) + ' a game; out ' + m.absent_last_games + ' game' + (m.absent_last_games === 1 ? '' : 's') + ')</span>'; }).join(', '); return '<tr><td>' + esc(g[k]) + '</td><td class="num">' + (x.projected_delta == null ? '—' : (x.projected_delta > 0 ? '+' : '') + (x.projected_delta * 100).toFixed(1) + '%') + '</td><td>' + (miss || '<span class="xe-dim">none</span>') + '</td></tr>'; };
    return '<div class="xe-tw"><table class="xe-t"><caption>Lineups — ' + esc(String(L.state).replace(/_/g, ' ').toLowerCase()) + (L.p_home_lineup_variant != null ? ' · lineup-aware variant: ' + esc(g.home) + ' ' + pct(L.p_home_lineup_variant) : '') + '</caption><tr><th></th><th>Lineup vs typical</th><th>Regulars absent from the last game</th></tr>' + side('home') + side('away') + '</table></div><p class="xe-note">' + esc(L.note) + '</p>';
  }

  /* ---- Models: every challenger on this game, with its record ---- */
  function modelsTab(s, g) {
    var ch = g.challengers, R = s.challenger_records;
    if (!ch || !R) return '<div class="xe-empty">No lab comparison in this slate.</div>';
    var prod = ch.models.filter(function (m) { return m.model === 'B_incumbent'; })[0];
    var out = '<p>' + esc(R.decision ? R.decision.why : '') + '</p><div class="xe-tw"><table class="xe-t"><caption>' + esc(g.home) + ' win probability by model — they range over ' + ch.spread_pp + ' pp</caption><tr><th>Model</th><th>This game</th><th>vs production</th><th>Held-out log loss: selection</th><th>confirmation</th><th>live (n)</th><th>vs production, confirmation (95%)</th><th>Role</th></tr>' +
      ch.models.map(function (m) { var r = R.models[m.model] || {}; var v = r.vs_production; return '<tr' + (m.model === 'B_incumbent' ? ' class="on"' : '') + '><td>' + esc(r.label || m.model) + '</td><td class="num">' + pct(m.p_home) + '</td><td class="num">' + (prod && m.model !== 'B_incumbent' ? pp((m.p_home - prod.p_home) * 100) : '—') + '</td><td class="num">' + (r.selection == null ? '—' : r.selection) + '</td><td class="num">' + (r.confirmation == null ? '—' : r.confirmation) + '</td><td class="num">' + (r.live == null ? '—' : r.live) + ' <span class="xe-dim">' + (r.live_n || '') + '</span></td><td class="num">' + (v ? (v.confirmation > 0 ? '+' : '') + v.confirmation + ' (' + v.confirmation_ci95.join(' to ') + ')' : '—') + '</td><td>' + chip(String(r.role || '').toLowerCase(), r.role === 'PRODUCTION' ? 'ok2' : 'none') + '</td></tr>'; }).join('') + '</table></div><p class="xe-dim">Lower log loss is better. A challenger would replace the production model only by beating it by ≥ 0.001 on the selection window AND with a confirmation interval wholly below zero (hockey/lab/run.js). None does.</p>';
    if (s.lab && s.lab.ablation && s.lab.ablation.length) out += '<div class="xe-tw"><table class="xe-t"><caption>What each feature group adds (held-out log loss change when removed / added)</caption><tr><th>Feature group</th><th>Selection</th><th>Confirmation</th><th>Verdict</th></tr>' + s.lab.ablation.map(function (a) { return '<tr><td>' + esc(a.feature.replace(/_/g, ' ')) + '</td><td class="num">' + a.selection_delta + '</td><td class="num">' + a.confirmation_delta + '</td><td>' + esc(a.verdict) + '</td></tr>'; }).join('') + '</table></div>';
    return out;
  }

  /* ---- Record: per-market status, diagnostics, the season so far ---- */
  function recordTab(s, g) {
    var st = s.market_statuses || {};
    var keys = Object.keys(st).sort();
    var out = '<div class="xe-tw"><table class="xe-t"><caption>Every market\'s held-out status (confirmation window)</caption><tr><th>Market</th><th>Status</th><th>n</th><th>Slope</th><th>Mean p − mean y</th><th>Against the close</th><th>Why not validated</th></tr>' + keys.map(function (k) { var m = st[k]; return '<tr><td>' + esc(k.replace(/_/g, ' ')) + '</td><td>' + lab(m.status) + '</td><td class="num">' + (m.n || '—') + '</td><td class="num">' + (m.calibration_slope == null ? '—' : m.calibration_slope) + '</td><td class="num">' + (m.calibration_in_the_large == null ? '—' : m.calibration_in_the_large) + '</td><td>' + lab(m.market_status) + '</td><td class="xe-dim">' + esc((m.failed || []).join('; ')) + '</td></tr>'; }).join('') + '</table></div>';
    var D = S.data.diagnostics;
    if (!D) { if (!S.loading.diagnostics && !S.err.diagnostics) load('diagnostics').then(render); out += S.err.diagnostics ? '' : '<div class="xe-loading">Loading diagnostics…</div>'; }
    else out += '<div class="xe-tw"><table class="xe-t"><caption>Diagnostics of the production model</caption><tr><th></th><th>Selection</th><th>Confirmation</th><th>Live</th></tr>' +
      '<tr><td>Log loss</td><td class="num">' + D.windows.selection.log_loss + '</td><td class="num">' + D.windows.confirmation.log_loss + '</td><td class="num">' + D.windows.live.log_loss + '</td></tr>' +
      '<tr><td>AUC (discrimination)</td><td class="num">' + D.windows.selection.auc + '</td><td class="num">' + D.windows.confirmation.auc + '</td><td class="num">' + D.windows.live.auc + '</td></tr>' +
      '<tr><td>First 20 games of a club\'s season</td><td class="num">' + D.season_phase.selection.first_20_games.log_loss + '</td><td class="num">' + D.season_phase.confirmation.first_20_games.log_loss + '</td><td></td></tr>' +
      '<tr><td>Rest of the season</td><td class="num">' + D.season_phase.selection.rest.log_loss + '</td><td class="num">' + D.season_phase.confirmation.rest.log_loss + '</td><td></td></tr>' +
      '<tr><td>Both projected starters started</td><td class="num">' + D.starters.selection.both_projections_right.log_loss + '</td><td class="num">' + D.starters.confirmation.both_projections_right.log_loss + '</td><td></td></tr>' +
      '<tr><td>A projected starter did not</td><td class="num">' + D.starters.selection.at_least_one_wrong.log_loss + '</td><td class="num">' + D.starters.confirmation.at_least_one_wrong.log_loss + '</td><td></td></tr>' +
      '</table></div><p>Drift monitor: ' + lab(D.drift.status) + ' <span class="xe-dim">season log loss ' + D.drift.live_mean_log_loss + ' vs ' + D.drift.reference_mean + ' on confirmation (z ' + D.drift.z + ', n ' + D.drift.n + '). ' + esc(D.drift.rule) + '</span></p>';
    return out + recordBlock(s);
  }

  /* ---- Data sources (registry) ---- */
  function sourcesBlock() {
    var R = S.data.sources;
    var head = '<div class="xe-sechd"><span>Data sources</span><span class="r">authorisation, freshness and what each adds</span></div>';
    if (!S.sourcesOpen) return head + '<button class="xe-btn ghost" data-act="sources" aria-expanded="false">Show the data-source registry</button>';
    if (!R) { if (!S.loading.sources && !S.err.sources) load('sources').then(render); return head + (S.err.sources ? banner('err', esc(S.err.sources)) : '<div class="xe-loading">Loading…</div>'); }
    return head + '<button class="xe-btn ghost" data-act="sources" aria-expanded="true">Hide the registry</button><p class="xe-dim">' + esc(R.rule) + ' ' + esc(R.environment_note) + '.</p>' + R.providers.map(function (p) {
      return '<details class="xe-sport"><summary><span class="xe-mu">' + esc(p.name) + '</span> ' + stateChip(p.status) + (p.data_permission && p.status !== 'AWAITING_PERMISSION' ? chip('data awaiting permission', 'warn') : '') + '</summary><div class="xe-sbody"><ul>' +
        '<li><b>Use:</b> ' + esc(p.use || p.methodology || p.value_if_granted || '—') + '</li><li><b>Datasets:</b> ' + esc((p.datasets || []).join('; ')) + ' · ' + esc(p.coverage || '') + '</li>' +
        '<li><b>Terms:</b> ' + esc(p.terms.summary) + (p.terms.verified ? '' : ' <span class="xe-dim">(not verified from this build\'s environment)</span>') + (p.terms.owner_action ? ' — ' + esc(p.terms.owner_action) : '') + '</li>' +
        '<li><b>Cost:</b> ' + esc(p.cost || '—') + (p.last_sync ? ' · last sync ' + esc(ago(p.last_sync)) : '') + '</li>' +
        (p.contribution ? '<li><b>Measured contribution:</b> ' + esc(p.contribution.evidence || p.contribution.role) + '</li>' : '') + '</ul></div></details>';
    }).join('');
  }

  function recordBlock(s) {
    var rec = s.record || {}, ml = rec.moneyline || {};
    var head = '<div class="xe-sechd"><span>The record</span><span class="r">walk-forward, seasons the model never saw</span></div>';
    var cmp = rec.comparisons ? Object.keys(rec.comparisons).filter(function (k) { return /_vs_(elo|goals_only)$/.test(k); }).map(function (k) { var c = rec.comparisons[k]; return '<li>vs ' + esc(k.split('_vs_')[1].replace('_', ' ')) + ': log loss ' + (c.mean_diff < 0 ? 'lower by ' : 'higher by ') + Math.abs(c.mean_diff) + ' (95% ' + c.ci95.join(' to ') + ', n ' + c.n + ')' + (c.a_better ? ' — better' : ' — not distinguishable') + '</li>'; }).join('') : '';
    var ss = rec.second_source;
    var n0 = function (v) { var n = num(v); return n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
    var second = ss ? '<p class="xe-2nd"><span class="xe-k">Second source</span> ' + esc(ss.season) + ', ' + esc(ss.source) + ': ' + n0(ss.games_matched) + '/' + n0(ss.games) + ' games matched, ' + n0(ss.finals_agree) + ' finals and ' + n0(ss.decided_agree) + ' decisions agree; ' + n0(ss.attempts_matched) + '/' + n0(ss.attempts) + ' shot attempts matched event by event; blocked attempts credited to the shooter ' + n0(ss.blocked_credited_to_shooter) + '/' + n0(ss.blocked) + '; skater TOI within 5 s ' + n0(ss.skater_toi_within_5s) + '/' + n0(ss.skater_rows) + '. A consistency check of past data, not a forecast.</p>' : '';
    var body = '<p>Moneyline: ' + stateChip(ml.status) + ' n ' + (ml.n || '—') + ', log loss ' + (ml.log_loss || '—') + ', Brier ' + (ml.brier || '—') + ', calibration slope ' + (ml.calibration_slope || '—') + '. Against the closing market: ' + stateChip(ml.market_status) + '.</p><ul>' + cmp + '</ul><p class="xe-dim">Leakage audit: ' + (rec.leakage ? rec.leakage.checked + ' predictions checked, ' + rec.leakage.violations + ' violations' : '—') + '.</p>' + second;
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
      var t = e.target.closest ? e.target.closest('[data-act],[data-open],[data-f],[data-game],[data-tab]') : null; if (!t) return;
      if (t.dataset.act === 'refresh') { refresh(); return; }
      if (t.dataset.act === 'all') { S.showAll = !S.showAll; render(); return; }
      if (t.dataset.act === 'back') { S.nhlOpen = null; S.nhlTab = 'overview'; setHash(null); render(); return; }
      if (t.dataset.act === 'sources') { S.sourcesOpen = !S.sourcesOpen; render(); return; }
      if (t.dataset.act === 'scn-reset') { S.scn = { home: '', away: '', lineup: false, adjH: 0, adjA: 0 }; render(); return; }
      if (t.dataset.tab) { S.nhlTab = t.dataset.tab; render(); if (t.dataset.tab === 'markets') script('market').then(render, function () { /* the price check falls back to its own sentence */ }); return; }
      if (t.dataset.act === 'record') { S.recordOpen = !S.recordOpen; render(); if (S.recordOpen && !S.data.record) load('record').then(render); return; }
      if (t.dataset.open) { S.open = S.open === t.dataset.open ? null : t.dataset.open; render(); return; }
      if (t.dataset.f) { S[t.dataset.f] = t.dataset.v; S.showAll = false; render(); return; }
      if (t.dataset.game) { S.nhlOpen = t.dataset.game; setHash(S.nhlOpen); render(); try { h.scrollIntoView({ block: 'start' }); } catch (_) {} }
    };
    /* scenario controls re-price in place, without re-rendering the controls (a slider keeps its focus) */
    var scn = function (e) {
      var el = e.target; if (!el || !el.dataset || !el.dataset.scn) return;
      var k = el.dataset.scn; S.scn[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      var v = h.querySelector('[data-scn-val="' + k + '"]'); if (v) v.textContent = (S.scn[k] > 0 ? '+' : '') + S.scn[k] + '%';
      var s = S.data.slate; var g = s && s.games.filter(function (x) { return String(x.game_id) === S.nhlOpen; })[0];
      var o = h.querySelector('.xe-scn-out'); if (o && g) o.innerHTML = scenarioOut(s, g);
    };
    h.oninput = scn; h.onchange = scn;
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
