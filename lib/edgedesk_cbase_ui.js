/* ===========================================================================
   EDGEDESK — the college baseball research terminal.

     Research → Other → NCAA Baseball   (#research/cbase[/<date>~<game_id>])

   ALL-GAMES BOARD   every Division I game of a date: matchup, projected
                     starters, readiness (seven separate states), fair
                     moneyline and total, uncertainty, freshness, market status
   GAME PAGE         team strength, offence/defence, starters and the price
                     under each starter scenario, bullpen workload, park and
                     environment, run distributions, every market, model
                     disagreement, the market comparison (or why there is none)
   ADVANCED          conference-adjusted ratings, conferences, pitchers,
                     calibration evidence, model comparison, coverage, the
                     adversarial audit, release gates and the experiment registry

   Reads committed artifacts only (college_baseball/board/*). It computes no
   probability, invents no statistic and never labels research as a betting
   opportunity: value claims are DISABLED in the board files themselves.
   Research, not picks.

   Browser: window.EDCbaseUI.show(host, { game: '<date>~<game_id>' })
   =========================================================================== */
(function (W) {
  'use strict';
  var BASE = '/college_baseball/board/';
  var CSS = '/lib/edgedesk_cbase.css?v=20261014cb1';
  var S = { host: null, view: 'board', idx: null, days: {}, detail: {}, date: null, game: null, adv: 'ratings', data: {}, err: null, loading: false, f: { q: '', conf: 'all', state: 'all' }, loadedAt: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function n(v) { return v == null || v === '' || !isFinite(Number(v)) ? null : Number(v); }
  function pct(v, d) { var x = n(v); if (x == null) return '—'; var f = Math.pow(10, d == null ? 0 : d); return Math.round(x * 100 * f) / f + '%'; }
  function am(v) { var x = n(v); return x == null ? '—' : (x > 0 ? '+' : '') + Math.round(x); }
  function fx(v, d) { var x = n(v); return x == null ? '—' : x.toFixed(d == null ? 2 : d); }
  function sg(v, d) { var x = n(v); return x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d == null ? 2 : d); }
  function chip(t, cls, title) { return '<span class="cb-chip ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(t) + '</span>'; }
  var LABEL_CLS = { 'PROVISIONAL RESEARCH': 'warn', 'RESEARCH BLOCKED': 'bad', 'NOT PRICED': '', 'VALUE EVALUATED': 'ok', 'RESEARCH PRICE': 'acc', 'INFERENCE FAILED': 'bad' };
  function day(d) { try { return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return d; } }

  function ensureCss() { if (document.getElementById('cb-css')) return; var l = document.createElement('link'); l.id = 'cb-css'; l.rel = 'stylesheet'; l.href = CSS; document.head.appendChild(l); }
  function get(path) {
    return fetch(BASE + path + '?v=' + new Date().toISOString().slice(0, 13), { cache: 'default' }).then(function (r) { if (!r.ok) throw new Error(path + ' answered HTTP ' + r.status); return r.json(); });
  }
  function loadIndex(force) { if (S.idx && !force) return Promise.resolve(S.idx); return get('index.json').then(function (d) { S.idx = d; S.loadedAt = new Date().toISOString(); return d; }); }
  function loadDay(date) { if (S.days[date]) return Promise.resolve(S.days[date]); return get(S.idx.season + '/' + date + '.json').then(function (d) { S.days[date] = d; return d; }); }
  /* a date's full research is gzipped; the browser decompresses it (DecompressionStream) */
  function loadDetail(date) {
    if (S.detail[date]) return Promise.resolve(S.detail[date]);
    if (typeof W.DecompressionStream !== 'function') return Promise.reject(new Error('this browser cannot open the game research files (no DecompressionStream); the board above still works'));
    return fetch(BASE + S.idx.season + '/detail/' + date + '.json.gz?v=' + new Date().toISOString().slice(0, 13)).then(function (r) {
      if (!r.ok) throw new Error('game research for ' + date + ' answered HTTP ' + r.status);
      return new Response(r.body.pipeThrough(new W.DecompressionStream('gzip'))).json();
    }).then(function (d) { S.detail[date] = d; return d; });
  }
  function loadData(k) { if (S.data[k]) return Promise.resolve(S.data[k]); var p = k === 'research' ? 'research.json' : S.idx.season + '/' + k + '.json'; return get(p).then(function (d) { S.data[k] = d; return d; }); }

  /* ------------------------------------------------------------ shell */
  function show(host, o) {
    ensureCss(); S.host = host || S.host; o = o || {};
    if (!S.host) return Promise.resolve();
    S.host.classList.add('cb');
    if (o.game) { var k = String(o.game).split('~'); if (k.length === 2) { S.date = k[0]; S.game = k[1]; S.view = 'game'; } }
    if (!S.idx) S.host.innerHTML = '<div class="cb-loading">Loading the college baseball board…</div>';
    return loadIndex(false).then(function () {
      if (!S.date) S.date = defaultDate();
      return loadDay(S.date).then(function () { return S.view === 'game' ? loadDetail(S.date).catch(function (e) { S.detailErr = e.message; }) : null; });
    }).then(render).catch(function (e) { S.err = (e && e.message) || 'the board could not be read'; render(); });
  }
  function defaultDate() {
    var ds = S.idx.dates.map(function (d) { return d.date; }); var today = new Date().toISOString().slice(0, 10);
    if (S.idx.mode === 'LIVE') { for (var i = 0; i < ds.length; i++) if (ds[i] >= today) return ds[i]; }
    /* replay: the busiest recent date, so the board opens on a full slate */
    var best = S.idx.dates.slice(-40).sort(function (a, b) { return b.priced - a.priced; })[0];
    return best ? best.date : ds[ds.length - 1];
  }
  function go(date) { S.date = date; S.game = null; S.view = 'board'; S.host.innerHTML = '<div class="cb-loading">Loading ' + esc(day(date)) + '…</div>'; return loadDay(date).then(render).catch(function (e) { S.err = e.message; render(); }); }
  function openGame(id) { S.game = id; S.view = 'game'; S.detailErr = null; render(); loadDetail(S.date).then(render).catch(function (e) { S.detailErr = e.message; render(); }); try { if (W.history && W.location.hash.indexOf('#research/cbase') === 0) W.history.replaceState(null, '', '#research/cbase/' + S.date + '~' + id); } catch (e) { /* hash is a convenience */ } }
  function closeGame() { S.game = null; S.view = 'board'; render(); }

  function header() {
    var i = S.idx; var h = '<div class="cb-head"><div><h3>NCAA Division I baseball</h3><small>EdgeDesk\'s independent research prices for every Division I game, from its own validated models. Research, not picks.</small></div><div class="cb-grow"></div>';
    h += '<div class="cb-seg" role="tablist" aria-label="College baseball views">' + ['board', 'advanced'].map(function (v) { var on = (S.view === v || (v === 'board' && S.view === 'game')); return '<button role="tab" aria-selected="' + on + '" class="' + (on ? 'on' : '') + '" data-view="' + v + '">' + (v === 'board' ? 'All games' : 'Advanced research') + '</button>'; }).join('') + '</div></div>';
    if (i) {
      h += '<div class="cb-banner ' + (i.mode === 'LIVE' ? 'info' : '') + '"><b>' + (i.mode === 'LIVE' ? 'Pregame prices.' : 'Retrospective replay — not live.') + '</b> ' + esc(i.mode_note) + '</div>';
      h += '<div class="cb-banner err"><b>No betting opportunities are shown.</b> ' + esc(i.value_reason) + '. Every price is provisional research until the release gates pass; the market column reads unavailable because no authorised college-baseball odds feed exists.</div>';
    }
    return h;
  }

  function render() {
    if (!S.host) return;
    var h = header();
    if (S.err) h += '<div class="cb-banner err"><b>Could not load:</b> ' + esc(S.err) + '. Nothing is shown in its place.</div>';
    else if (!S.idx) h += '<div class="cb-loading">Loading…</div>';
    else if (S.view === 'advanced') h += advanced();
    else if (S.view === 'game') h += gamePage();
    else h += board();
    S.host.innerHTML = h;
    bind();
  }

  /* ------------------------------------------------------------ board */
  function stateChips(g) {
    var st = (g.readiness && g.readiness.states) || {}; var out = [];
    out.push(chip(g.readiness ? g.readiness.label : '—', LABEL_CLS[g.readiness && g.readiness.label] || ''));
    if (st.MODEL_ELIGIBLE === false && !st.RESEARCH_BLOCKED) out.push(chip('not eligible', 'bad'));
    if (st.MARKET_VERIFIED === false) out.push(chip('no market', ''));
    return '<div class="cb-chips">' + out.join('') + '</div>';
  }
  function starterCell(g, side) {
    var s = g.starters && g.starters[side]; if (!s) return '<span class="cb-faint">no data</span>';
    return (s.name ? esc(s.name) + ' <span class="num cb-faint">' + pct(s.p) + '</span>' : '<span class="cb-faint">unknown</span>') + ' ' + chip(s.status.toLowerCase(), s.status === 'PROJECTED' ? 'warn' : 'bad');
  }
  function board() {
    var d = S.days[S.date]; var i = S.idx;
    var dates = i.dates.map(function (x) { return x.date; }); var k = dates.indexOf(S.date);
    var h = '<div class="cb-ctl"><button class="cb-btn" data-date="' + (dates[k - 1] || '') + '"' + (k <= 0 ? ' disabled' : '') + ' aria-label="Previous date">‹</button>';
    h += '<select class="cb-in" id="cbDate" aria-label="Date">' + i.dates.map(function (x) { return '<option value="' + x.date + '"' + (x.date === S.date ? ' selected' : '') + '>' + esc(day(x.date)) + ' — ' + x.games + ' games</option>'; }).join('') + '</select>';
    h += '<button class="cb-btn" data-date="' + (dates[k + 1] || '') + '"' + (k >= dates.length - 1 ? ' disabled' : '') + ' aria-label="Next date">›</button>';
    if (!d) return h + '</div><div class="cb-loading">Loading…</div>';
    var confs = {}; d.games.forEach(function (g) { if (g.home.conf) confs[g.home.conf] = 1; if (g.away.conf) confs[g.away.conf] = 1; });
    h += '<input class="cb-in" id="cbQ" type="search" placeholder="Team" aria-label="Filter by team" value="' + esc(S.f.q) + '">';
    h += '<select class="cb-in" id="cbConf" aria-label="Conference"><option value="all">All conferences</option>' + Object.keys(confs).sort().map(function (c) { return '<option' + (S.f.conf === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>';
    h += '<select class="cb-in" id="cbState" aria-label="Readiness"><option value="all">Every state</option>' + ['priced', 'blocked', 'not priced'].map(function (s) { return '<option' + (S.f.state === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>';
    var gs = d.games.filter(function (g) {
      var q = S.f.q.toLowerCase(); if (q && (g.home.name + ' ' + g.away.name).toLowerCase().indexOf(q) < 0) return false;
      if (S.f.conf !== 'all' && g.home.conf !== S.f.conf && g.away.conf !== S.f.conf) return false;
      var st = (g.readiness && g.readiness.states) || {};
      if (S.f.state === 'priced' && !st.PRICE_GENERATED) return false; if (S.f.state === 'blocked' && !st.RESEARCH_BLOCKED) return false; if (S.f.state === 'not priced' && (st.PRICE_GENERATED || st.RESEARCH_BLOCKED)) return false;
      return true;
    });
    var priced = d.games.filter(function (g) { return g.readiness && g.readiness.states.PRICE_GENERATED; }).length;
    h += '<div class="cb-note">' + d.games.length + ' Division I games on ' + esc(day(S.date)) + ': ' + priced + ' priced, ' + (d.games.length - priced) + ' not priced (reasons on each game). Showing ' + gs.length + '. Freshness: warehouse built ' + esc((i.freshness.warehouse_built || '').slice(0, 16).replace('T', ' ')) + ' UTC from ' + esc(i.freshness.source) + '.</div>';
    if (!gs.length) return h + '<div class="cb-empty">No game matches these filters.</div>';
    h += '<div class="cb-scroll"><table class="cb-t"><thead><tr><th>Game</th><th>Projected starters</th><th>Readiness</th><th class="r">Fair moneyline</th><th class="r">Fair total</th><th class="r">Uncertainty</th><th>Market</th>' + (i.mode === 'LIVE' ? '' : '<th class="r">Result (postgame)</th>') + '</tr></thead><tbody>';
    gs.forEach(function (g) {
      var ml = g.ml; var tot = g.total;
      var rk = function (t) { return t.rank ? '<span class="num cb-faint">#' + t.rank + '</span> ' : ''; };
      h += '<tr class="cb-row" tabindex="0" data-game="' + esc(g.game_id) + '"><td><span class="cb-mu">' + rk(g.away) + esc(g.away.name) + ' <span class="cb-faint">' + (g.neutral ? 'vs' : '@') + '</span> ' + rk(g.home) + esc(g.home.name) + '</span><span class="cb-sub">' + esc([g.away.conf, g.home.conf].filter(Boolean).join(' · ')) + (g.dh ? ' · DH game ' + g.dh : '') + (g.start_time_local ? ' · ' + esc(g.start_time_local) + ' local' : '') + (g.neutral ? ' · neutral' : '') + '</span></td>';
      h += '<td><span class="cb-sub">' + esc(g.away.name) + ': ' + starterCell(g, 'away') + '</span><span class="cb-sub">' + esc(g.home.name) + ': ' + starterCell(g, 'home') + '</span></td>';
      h += '<td>' + stateChips(g) + '</td>';
      h += '<td class="r num">' + (ml ? am(ml.fair_away) + ' / ' + am(ml.fair_home) + '<span class="cb-sub">' + pct(ml.p_away) + ' / ' + pct(ml.p_home) + '</span>' : '—') + '</td>';
      h += '<td class="r num">' + (tot ? tot.line + '<span class="cb-sub">over ' + pct(tot.over) + '</span>' : '—') + '</td>';
      h += '<td class="r num">' + (g.sd != null ? '±' + fx(g.sd) + '<span class="cb-sub">MC ' + fx(g.se, 3) + '</span>' : '—') + '</td>';
      h += '<td><span class="cb-faint">unavailable</span></td>';
      if (i.mode !== 'LIVE') h += '<td class="r num">' + (g.result_postgame ? g.result_postgame.away_runs + '–' + g.result_postgame.home_runs + (g.result_postgame.innings && g.result_postgame.innings !== 9 ? ' (' + g.result_postgame.innings + ')' : '') : esc(String(g.status || '').toLowerCase())) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div><div class="cb-note">Fair moneyline is away / home (American, no vig). Uncertainty is the posterior sd of the rating gap (log runs) and the simulation\'s standard error on P(home). Starters are projections from rotation patterns, never confirmations.</div>';
    return h;
  }

  /* ------------------------------------------------------------ game page */
  function bars(arr, labels, neg) { var mx = Math.max.apply(null, arr.concat([1e-9])); return '<div class="cb-bars" aria-hidden="true">' + arr.map(function (v, i) { return '<div class="cb-bar' + (neg && neg(i) ? ' neg' : '') + '" style="height:' + Math.max(1, Math.round(v / mx * 100)) + '%" title="' + esc(labels[i]) + ': ' + pct(v, 1) + '"></div>'; }).join('') + '</div><div class="cb-bars-lab"><span>' + esc(labels[0]) + '</span><span>' + esc(labels[Math.floor(labels.length / 2)]) + '</span><span>' + esc(labels[labels.length - 1]) + '</span></div>'; }
  function statesBlock(g) {
    var r = g.readiness || { states: {}, reasons: {} }; var order = ['DATA_AVAILABLE', 'MODEL_ELIGIBLE', 'PRICE_GENERATED', 'PROVISIONAL', 'MARKET_VERIFIED', 'VALUE_EVALUATED', 'RESEARCH_BLOCKED'];
    return '<div class="cb-states">' + order.map(function (k) {
      var v = r.states[k]; var cls = k === 'RESEARCH_BLOCKED' ? (v ? 'block' : 'no') : k === 'PROVISIONAL' ? (v ? 'alert' : 'no') : (v ? 'yes' : 'no');
      var rs = r.reasons[k] || [];
      return '<div class="cb-state ' + cls + '"><b>' + k.replace(/_/g, ' ') + ': ' + (v == null ? 'n/a' : v ? 'yes' : 'no') + '</b>' + (rs.length ? '<ul>' + rs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function teamCard(t, side) {
    var r = t.rating || {};
    return '<div class="cb-card"><h4>' + esc(t.name) + ' <span class="cb-faint">' + esc(side) + '</span></h4><div class="cb-kv">' +
      '<span class="k">D-I rank</span><span class="num">' + (r.rank ? '#' + r.rank : '—') + '</span>' +
      '<span class="k">Net</span><span class="num">' + sg(r.net) + ' <span class="cb-faint">± ' + fx(r.sd) + '</span></span>' +
      '<span class="k">Offence</span><span class="num">' + sg(r.off) + '</span><span class="k">Run prevention</span><span class="num">' + sg(r.def) + '</span>' +
      '<span class="k">Conference</span><span>' + esc(t.conf || '—') + ' <span class="num cb-faint">' + sg(r.conf_net) + '</span></span>' +
      '<span class="k">Record</span><span class="num">' + esc(r.record || '—') + ' <span class="cb-faint">' + (r.rs != null ? r.rs + ' RS · ' + r.ra + ' RA' : '') + '</span></span></div>' +
      '<div class="cb-note">Log-run scale, opponent-adjusted: +0.10 net ≈ 10% more runs scored than allowed against an average D-I opponent. Before this game.</div></div>';
  }
  function starterCard(g, side) {
    var s = g.starters && g.starters[side]; var t = g[side];
    if (!s) return '<div class="cb-card"><h4>' + esc(t.name) + ' starter</h4><div class="cb-note">No box-score history before 2024: no starter information.</div></div>';
    var h = '<div class="cb-card"><h4>' + esc(t.name) + ' starter ' + chip(s.status.toLowerCase(), s.status === 'PROJECTED' ? 'warn' : 'bad') + '</h4>';
    h += '<div class="cb-scroll"><table class="cb-t"><thead><tr><th>Candidate</th><th class="r">P(start)</th><th class="r">K%</th><th class="r">BB%</th><th class="r">Runs/BF</th><th class="r">Exp. outs</th></tr></thead><tbody>';
    s.candidates.forEach(function (c) { h += '<tr><td>' + esc(c.name) + '<span class="cb-sub">' + c.starts + ' starts on record · reliability ' + fx(c.reliability) + '</span></td><td class="r num">' + pct(c.p) + '</td><td class="r num">' + pct(c.k_rate, 1) + '</td><td class="r num">' + pct(c.bb_rate, 1) + '</td><td class="r num">' + fx(c.rv_per_bf, 3) + '</td><td class="r num">' + fx(c.exp_outs, 1) + '</td></tr>'; });
    h += '<tr><td class="cb-faint">someone not in the recent rotation</td><td class="r num">' + pct(s.p_unseen) + '</td><td colspan="4" class="cb-faint">team-average starter assumed</td></tr></tbody></table></div>';
    if (s.actual_postgame) h += '<div class="cb-note">Postgame: ' + esc(s.actual_postgame) + ' started (not known when the price was made).</div>';
    return h + '<div class="cb-note">Rates are shrunk toward the college population by batters faced; ERA is not an input. No starter is ever shown as confirmed without a timestamped source.</div></div>';
  }
  function penCard(g, side) {
    var b = g.bullpen && g.bullpen[side]; var t = g[side];
    if (!b) return '';
    var h = '<div class="cb-card"><h4>' + esc(t.name) + ' bullpen</h4><div class="cb-kv"><span class="k">Available quality</span><span class="num">' + fx(b.rv_available, 3) + ' runs/BF <span class="cb-faint">(normal ' + fx(b.rv_normal, 3) + ')</span></span>' +
      '<span class="k">Depletion</span><span class="num">' + pct(b.depletion) + '</span><span class="k">Last 3 days</span><span class="num">' + b.bf_last3 + ' BF ≈ ' + b.pitches_last3_est + ' ± ' + b.pitches_last3_sd + ' pitches</span></div>';
    if (b.relievers && b.relievers.length) { h += '<div class="cb-scroll" style="margin-top:6px"><table class="cb-t"><thead><tr><th>Reliever</th><th class="r">Usage</th><th class="r">P(available)</th><th class="r">Last 3 days</th></tr></thead><tbody>'; b.relievers.forEach(function (x) { h += '<tr><td>' + esc(x.name) + '</td><td class="r num">' + pct(x.usage) + '</td><td class="r num">' + pct(x.p_available) + '</td><td class="r num">' + x.bf_last3 + ' BF ≈ ' + x.pitches_last3_est + '±' + x.pitches_last3_sd + '</td></tr>'; }); h += '</tbody></table></div>'; }
    return h + '<div class="cb-note">Pitch counts are not published; they are estimated as 4.2 per batter faced (measured from 2024 pitch sequences) with that uncertainty.</div></div>';
  }
  function gamePage() {
    var h = '<div class="cb-back"><button class="cb-btn ghost" data-back="1">‹ All games on ' + esc(day(S.date)) + '</button></div>';
    if (S.detailErr) return h + '<div class="cb-banner err"><b>Could not load the game research:</b> ' + esc(S.detailErr) + '.</div>';
    var d = S.detail[S.date];
    if (!d) return h + '<div class="cb-loading">Loading the game research…</div>';
    var g = d.games.filter(function (x) { return x.game_id === S.game; })[0];
    if (!g) return h + '<div class="cb-empty">This game is not on the board.</div>';
    h += '<div class="cb-head"><div><h3>' + esc(g.away.name) + (g.neutral ? ' vs ' : ' at ') + esc(g.home.name) + '</h3><small>' + esc(day(g.date)) + (g.dh ? ' · doubleheader game ' + g.dh : '') + (g.site ? ' · ' + esc(g.site) : '') + ' · ' + esc(g.game_id) + '</small></div></div>';
    h += '<div class="cb-chips">' + stateChips(g) + '</div>';
    if (g.explanation) h += '<ul class="cb-expl">' + g.explanation.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    var p = g.prices;
    if (p) {
      h += '<div class="cb-sec">Fair prices <span class="r">settlement template: ' + esc(p.settlement_profile) + ' (unverified) · simulator ' + p.simulator.n + ' games, SE ' + fx(p.simulator.se_p_home, 3) + '</span></div><div class="cb-grid">';
      h += '<div class="cb-card"><h4>Moneyline</h4><div class="cb-kv"><span class="k">' + esc(g.away.name) + '</span><span class="cb-big">' + am(p.moneyline.fair_away) + '</span><span class="k">' + esc(g.home.name) + '</span><span class="cb-big">' + am(p.moneyline.fair_home) + '</span></div><div class="cb-note">' + pct(p.moneyline.p_away, 1) + ' / ' + pct(p.moneyline.p_home, 1) + ' · expected runs ' + fx(p.expected.away, 1) + '–' + fx(p.expected.home, 1) + ' · extra innings and walk-offs simulated</div></div>';
      h += '<div class="cb-card"><h4>Run lines (home)</h4><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Line</th><th class="r">Home</th><th class="r">Away</th><th class="r">Push</th></tr></thead><tbody>' + p.run_lines.map(function (l) { return '<tr><td class="num">' + sg(l.home_line, 1) + '</td><td class="r num">' + am(l.fair_home) + ' <span class="cb-faint">' + pct(l.home_cover) + '</span></td><td class="r num">' + am(l.fair_away) + '</td><td class="r num">' + (l.push ? pct(l.push, 1) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div><div class="cb-note">Whole-number lines can push; their fair price excludes the push.</div></div>';
      h += '<div class="cb-card"><h4>Totals</h4><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Line</th><th class="r">Over</th><th class="r">Under</th><th class="r">Push</th></tr></thead><tbody>' + p.totals.map(function (t) { return '<tr' + (t.line === p.main_total_line ? ' style="font-weight:700"' : '') + '><td class="num">' + t.line + '</td><td class="r num">' + am(t.fair_over) + ' <span class="cb-faint">' + pct(t.over) + '</span></td><td class="r num">' + am(t.fair_under) + '</td><td class="r num">' + (t.push ? pct(t.push, 1) : '—') + '</td></tr>'; }).join('') + '</tbody></table></div></div>';
      h += '<div class="cb-card"><h4>Team totals</h4>' + ['away', 'home'].map(function (s) { var tt = p.team_totals[s]; var mid = tt[Math.floor(tt.length / 2)]; return '<div class="cb-kv"><span class="k">' + esc(g[s].name) + '</span><span class="num">' + mid.line + ': over ' + am(mid.fair_over) + ' / under ' + am(mid.fair_under) + '</span></div>'; }).join('') + (p.first_five ? '<h4 style="margin-top:10px">First five innings ' + chip('provisional', 'warn') + '</h4><div class="cb-kv"><span class="k">3-way</span><span class="num">' + pct(p.first_five.three_way.away) + ' / tie ' + pct(p.first_five.three_way.tie) + ' / ' + pct(p.first_five.three_way.home) + '</span><span class="k">2-way (tie push)</span><span class="num">' + am(p.first_five.two_way_tie_push.fair_away) + ' / ' + am(p.first_five.two_way_tie_push.fair_home) + '</span></div>' : '') + '</div>';
      h += '</div>';
      var dd = g.distribution;
      if (dd) {
        h += '<div class="cb-sec">Run distribution</div><div class="cb-grid"><div class="cb-card"><h4>Combined runs</h4>' + bars(dd.total, dd.total.map(function (_, i) { return i === dd.total.length - 1 ? (i) + '+' : String(i); })) + '</div>';
        h += '<div class="cb-card"><h4>Margin (home − away)</h4>' + bars(dd.margin, dd.margin.map(function (_, i) { return String(i + dd.margin_min); }), function (i) { return i + dd.margin_min < 0; }) + '</div>';
        h += '<div class="cb-card"><h4>Innings played</h4>' + bars(dd.innings, dd.innings.map(function (_, i) { return String(i + 5); })) + '<div class="cb-note">Seven-inning share ' + pct(p.simulator.seven_share) + ', walk-off ' + pct(p.simulator.walkoff_share) + ', run rule ' + pct(p.simulator.run_rule_share) + ' (measured probability for this game\'s context).</div></div></div>';
      }
    }
    h += '<div class="cb-sec">Research readiness</div>' + statesBlock(g);
    if (g.home.rating) h += '<div class="cb-sec">Opponent-adjusted team strength</div><div class="cb-grid">' + teamCard(g.away, 'away') + teamCard(g.home, g.neutral ? 'neutral' : 'home') + '</div>';
    if (g.starters) {
      h += '<div class="cb-sec">Starting pitching <span class="r">' + (g.model && g.model.pitcher_adjusted ? 'in the price, weighted across scenarios' : 'research only: the pitcher adjustment did not pass validation') + '</span></div><div class="cb-grid">' + starterCard(g, 'away') + starterCard(g, 'home') + '</div>';
      if (g.scenarios && g.scenarios.length) { h += '<details open><summary>How the price moves with the starters</summary><div class="cb-scroll"><table class="cb-t"><thead><tr><th>' + esc(g.home.name) + '</th><th>' + esc(g.away.name) + '</th><th class="r">Scenario P</th><th class="r">P(' + esc(g.home.name) + ')</th></tr></thead><tbody>' + g.scenarios.map(function (s) { return '<tr><td>' + esc(s.home_starter) + '</td><td>' + esc(s.away_starter) + '</td><td class="r num">' + pct(s.p) + '</td><td class="r num">' + pct(s.p_home, 1) + '</td></tr>'; }).join('') + '</tbody></table></div></details>'; }
    }
    if (g.bullpen) h += '<div class="cb-sec">Bullpen availability</div><div class="cb-grid">' + penCard(g, 'away') + penCard(g, 'home') + '</div>';
    if (g.environment) { var e = g.environment; h += '<div class="cb-sec">Park and environment</div><div class="cb-card"><div class="cb-kv"><span class="k">Park factor</span><span class="num">' + sg(e.park_factor) + ' <span class="cb-faint">(log runs, shrunk by games observed)</span></span><span class="k">Home advantage</span><span class="num">' + sg(e.home_advantage) + '</span><span class="k">Neutral site</span><span>' + (e.neutral ? 'yes' : 'no') + '</span><span class="k">Rest (days)</span><span class="num">' + (e.rest_away == null ? '—' : e.rest_away) + ' / ' + (e.rest_home == null ? '—' : e.rest_home) + '</span><span class="k">Weather</span><span>' + esc(e.weather) + '</span><span class="k">Altitude</span><span>' + esc(e.altitude) + '</span></div></div>'; }
    if (g.model && g.model.disagreement) { var m = g.model.disagreement; h += '<div class="cb-sec">Model disagreement <span class="r">P(' + esc(g.home.name) + '), each model out of sample</span></div><div class="cb-scroll"><table class="cb-t"><thead><tr>' + Object.keys(m).map(function (k) { return '<th class="r">' + esc(k.replace(/_/g, ' ')) + '</th>'; }).join('') + '</tr></thead><tbody><tr>' + Object.keys(m).map(function (k) { return '<td class="r num">' + pct(m[k], 1) + '</td>'; }).join('') + '</tr></tbody></table></div>'; }
    h += '<div class="cb-sec">Market comparison</div><div class="cb-card"><div class="cb-note"><b>Unavailable.</b> ' + esc((g.market && g.market.reason) || 'no authorised quote') + '. No expected value is computed without a timestamped quote whose settlement rules match.</div></div>';
    if (g.result_postgame) h += '<div class="cb-note" style="margin-top:10px">' + esc(g.result_postgame.label) + ': ' + esc(g.away.name) + ' ' + g.result_postgame.away_runs + ', ' + esc(g.home.name) + ' ' + g.result_postgame.home_runs + (g.result_postgame.innings ? ' (' + g.result_postgame.innings + ' inn.)' : '') + '.</div>';
    return h;
  }

  /* ------------------------------------------------------------ advanced */
  var ADV = [['ratings', 'Ratings'], ['conferences', 'Conferences'], ['pitchers', 'Pitchers'], ['calibration', 'Calibration'], ['models', 'Models'], ['coverage', 'Coverage'], ['audit', 'Audit & gates'], ['registry', 'Experiments']];
  function advanced() {
    var h = '<div class="cb-ctl"><div class="cb-seg" role="tablist" aria-label="Advanced research">' + ADV.map(function (a) { return '<button role="tab" aria-selected="' + (S.adv === a[0]) + '" class="' + (S.adv === a[0] ? 'on' : '') + '" data-adv="' + a[0] + '">' + a[1] + '</button>'; }).join('') + '</div></div>';
    var need = S.adv === 'ratings' || S.adv === 'conferences' ? 'ratings' : S.adv === 'pitchers' ? 'pitchers' : 'research';
    var d = S.data[need];
    if (!d) { loadData(need).then(render).catch(function (e) { S.err = e.message; render(); }); return h + '<div class="cb-loading">Loading…</div>'; }
    var R = S.data.research;
    if (S.adv === 'ratings') {
      h += '<div class="cb-note">' + esc(d.model) + ' · as of ' + esc(day(d.as_of)) + ' · ' + esc(d.scale) + '. SOS: mean net rating of opponents played.</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th class="r">#</th><th>Team</th><th>Conference</th><th class="r">Net</th><th class="r">± sd</th><th class="r">Offence</th><th class="r">Prevention</th><th class="r">Record</th><th class="r">SOS</th></tr></thead><tbody>';
      d.teams.forEach(function (t) { h += '<tr><td class="r num">' + t.rank + '</td><td>' + esc(t.name) + '</td><td>' + esc(t.conf) + '</td><td class="r num">' + sg(t.net) + '</td><td class="r num">' + fx(t.sd) + '</td><td class="r num">' + sg(t.off) + '</td><td class="r num">' + sg(t.def) + '</td><td class="r num">' + esc(t.record) + '</td><td class="r num">' + sg(t.sos) + '</td></tr>'; });
      return h + '</tbody></table></div>';
    }
    if (S.adv === 'conferences') {
      h += '<div class="cb-note">Conference strength is identified only by non-conference games; its sd shows how well connected each conference is.</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Conference</th><th class="r">Teams</th><th class="r">Strength</th><th class="r">± sd</th><th class="r">Mean team net</th><th>Best</th></tr></thead><tbody>';
      d.conferences.forEach(function (c) { h += '<tr><td>' + esc(c.conf) + '</td><td class="r num">' + c.teams + '</td><td class="r num">' + sg(c.conf_net) + '</td><td class="r num">' + fx(c.sd) + '</td><td class="r num">' + sg(c.mean_team_net) + '</td><td>' + esc(c.best) + '</td></tr>'; });
      return h + '</tbody></table></div>';
    }
    if (S.adv === 'pitchers') {
      h += '<div class="cb-note">' + esc(d.method) + '. Pitcher adjustment in the price: ' + (d.pitcher_adjustment_in_price ? 'yes' : 'no (it did not pass validation)') + '.</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Starter</th><th class="r">Starts</th><th class="r">K%</th><th class="r">BB%</th><th class="r">HR%</th><th class="r">Runs/BF</th><th class="r">Exp. outs</th><th class="r">Reliability</th></tr></thead><tbody>';
      d.starters.forEach(function (s) { h += '<tr><td>' + esc(s.name) + '</td><td class="r num">' + s.starts + '</td><td class="r num">' + pct(s.k_rate, 1) + '</td><td class="r num">' + pct(s.bb_rate, 1) + '</td><td class="r num">' + pct(s.hr_rate, 1) + '</td><td class="r num">' + fx(s.rv_per_bf, 3) + '</td><td class="r num">' + fx(s.exp_outs, 1) + '</td><td class="r num">' + fx(s.reliability) + '</td></tr>'; });
      return h + '</tbody></table></div>';
    }
    if (!R) return h;
    if (S.adv === 'calibration') {
      var wf = R.walkforward; var v = wf && wf.windows.VALIDATION;
      if (!v || !v.bins) return h + '<div class="cb-empty">No calibration record.</div>';
      var sz = 260; var pt = function (x) { return 20 + x * (sz - 30); };
      var svg = '<svg viewBox="0 0 ' + sz + ' ' + sz + '" width="' + sz + '" height="' + sz + '" role="img" aria-label="Reliability diagram" style="max-width:100%"><line x1="' + pt(0) + '" y1="' + (sz - pt(0)) + '" x2="' + pt(1) + '" y2="' + (sz - pt(1)) + '" stroke="currentColor" opacity=".3"/>';
      v.bins.forEach(function (b) { svg += '<line x1="' + pt(b.mean_p) + '" x2="' + pt(b.mean_p) + '" y1="' + (sz - pt(b.wilson_low)) + '" y2="' + (sz - pt(b.wilson_high)) + '" stroke="var(--accent)" opacity=".6"/><circle cx="' + pt(b.mean_p) + '" cy="' + (sz - pt(b.observed)) + '" r="' + Math.max(2.5, Math.min(7, Math.sqrt(b.n) / 8)) + '" fill="var(--accent)"><title>' + pct(b.mean_p, 1) + ' predicted, ' + pct(b.observed, 1) + ' observed, n ' + b.n + '</title></circle>'; });
      svg += '<text x="' + pt(0.5) + '" y="' + (sz - 2) + '" font-size="10" fill="currentColor" text-anchor="middle" opacity=".6">predicted P(home)</text></svg>';
      h += '<div class="cb-note">Chosen model (' + esc(wf.chosen) + ') on VALIDATION ' + esc(v.seasons.join('–')) + ', n ' + v.n + '. Dots: observed home win rate per bucket with 95% Wilson intervals. Retrospective reconstruction.</div><div class="cb-grid"><div class="cb-card">' + svg + '</div><div class="cb-card"><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Bucket</th><th class="r">n</th><th class="r">Predicted</th><th class="r">Observed</th><th class="r">95% interval</th></tr></thead><tbody>' + v.bins.map(function (b) { return '<tr><td class="num">' + pct(b.lo) + '–' + pct(b.hi) + '</td><td class="r num">' + b.n + '</td><td class="r num">' + pct(b.mean_p, 1) + '</td><td class="r num">' + pct(b.observed, 1) + '</td><td class="r num">' + pct(b.wilson_low, 1) + '–' + pct(b.wilson_high, 1) + '</td></tr>'; }).join('') + '</tbody></table></div></div></div>';
      if (v.slices) { h += '<div class="cb-sec">By slice</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Slice</th><th>Group</th><th class="r">n</th><th class="r">Log loss</th><th class="r">Mean p</th><th class="r">Observed</th></tr></thead><tbody>'; ['venue', 'conference_game', 'day', 'opponent_division', 'season_phase', 'favourite', 'ncaa_tourney', 'season'].forEach(function (k) { var s = v.slices[k] || {}; Object.keys(s).forEach(function (g) { var x = s[g]; h += '<tr><td>' + esc(k.replace(/_/g, ' ')) + '</td><td>' + esc(g.replace(/_/g, ' ')) + '</td><td class="r num">' + x.n + '</td><td class="r num">' + fx(x.log_loss, 4) + '</td><td class="r num">' + pct(x.mean_p, 1) + '</td><td class="r num">' + pct(x.mean_y, 1) + '</td></tr>'; }); }); h += '</tbody></table></div>'; }
      return h;
    }
    if (S.adv === 'models') {
      var w = R.walkforward; if (!w) return h + '<div class="cb-empty">No walk-forward record.</div>';
      h += '<div class="cb-note">Team models, chronological walk-forward (protocol written before scoring). Chosen: <b>' + esc(w.chosen) + '</b>; best baseline: ' + esc(w.best_baseline) + '. Log loss (lower is better).</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Model</th>' + Object.keys(w.windows).map(function (k) { return '<th class="r">' + esc(k) + '</th>'; }).join('') + '</tr></thead><tbody>';
      Object.keys(w.selection).forEach(function (mdl) { h += '<tr><td>' + esc(mdl.replace(/_/g, ' ')) + '</td>' + Object.keys(w.windows).map(function (k) { var x = w.windows[k].models ? w.windows[k].models[mdl] : null; return '<td class="r num">' + (x ? fx(x.log_loss, 4) : (w.windows[k].withheld ? 'withheld' : '—')) + '</td>'; }).join('') + '</tr>'; });
      h += '</tbody></table></div>';
      if (R.pitcher) { var pw = R.pitcher; h += '<div class="cb-sec">Pitcher-aware variants (box-score seasons)</div><div class="cb-note">Chosen: ' + esc(pw.selection.chosen) + '. The oracle uses the starter who actually started: what confirmation would be worth, never a pregame model.</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Variant</th>' + Object.keys(pw.windows).map(function (k) { return '<th class="r">' + esc(k) + '</th>'; }).join('') + '</tr></thead><tbody>' + Object.keys(pw.windows.SELECTION.models).map(function (vn) { return '<tr><td>' + esc(vn.replace(/_/g, ' ')) + '</td>' + Object.keys(pw.windows).map(function (k) { var x = pw.windows[k].models[vn]; return '<td class="r num">' + (x ? fx(x.log_loss, 4) : '—') + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>'; if (pw.starter_projection && pw.starter_projection.SELECTION) { var sp = pw.starter_projection.SELECTION.all; h += '<div class="cb-note">Starter projection, 2025: top candidate correct ' + pct(sp.top1_accuracy, 1) + ' of ' + sp.n + ' team-games (mean stated confidence ' + pct(sp.mean_top_p, 1) + ').</div>'; } }
      if (R.distribution) { h += '<div class="cb-sec">Run distributions</div><ul class="cb-expl">' + R.distribution.findings.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '<li>Chosen family: ' + esc(R.distribution.chosen) + ' ' + esc(JSON.stringify(R.distribution.spec)) + '</li></ul>'; }
      if (R.simulator) { var sm = R.simulator; h += '<div class="cb-sec">Simulator</div><div class="cb-note">Moneyline log loss: simulator ' + fx(sm.moneyline_log_loss.simulator, 4) + ', closed form ' + fx(sm.moneyline_log_loss.closed_form, 4) + ' · mean |ΔP(home)| ' + fx(sm.mean_abs_diff_p_home, 3) + ' · walk-offs predicted ' + pct(sm.walkoff_share.predicted, 1) + ' vs observed ' + pct(sm.walkoff_share.observed, 1) + ' · run rule ' + pct(sm.run_rule_share.predicted, 1) + ' vs ' + pct(sm.run_rule_share.observed, 1) + '.</div>'; }
      if (R.ml) { h += '<div class="cb-sec">Machine learning and ensemble</div><div class="cb-note">Decisions (VALIDATION, paired block bootstrap): GLM ' + esc(R.ml.decisions.glm) + ', boosting ' + esc(R.ml.decisions.gbm) + ', ensemble ' + esc(R.ml.decisions.ensemble) + '.</div>'; }
      if (R.features) { h += '<div class="cb-sec">Feature research</div><ul class="cb-expl">' + Object.keys(R.features).map(function (k) { var x = R.features[k]; return '<li><b>' + esc(k) + '</b>: ' + esc(x.decision) + ' ' + esc(JSON.stringify(x.test_log_score || {})) + '</li>'; }).join('') + '</ul>'; }
      if (R.ablations && R.ablations.results) { h += '<div class="cb-sec">Ablations (VALIDATION)</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Removed</th><th class="r">Log loss</th><th class="r">Δ vs full</th><th>95% interval</th><th>Keeps its place?</th></tr></thead><tbody>' + R.ablations.results.map(function (a) { return '<tr><td>' + esc(a.removed) + '</td><td class="r num">' + fx(a.log_loss, 4) + '</td><td class="r num">' + sg(a.diff_vs_full, 4) + '</td><td class="num">' + esc((a.ci95 || []).join(' to ')) + '</td><td>' + esc(a.verdict) + '</td></tr>'; }).join('') + '</tbody></table></div>'; }
      return h;
    }
    if (S.adv === 'coverage') {
      var c = R.coverage; if (!c) return h;
      h += '<div class="cb-note">Counted from the warehouse, never typed. Weather and market columns are zero because no authorised source supplies them.</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Season</th><th class="r">Scheduled</th><th class="r">Final</th><th class="r">Quarantined</th><th class="r">Box score</th><th class="r">Play-by-play</th><th class="r">Starters</th><th class="r">Eligible</th></tr></thead><tbody>' + c.seasons.map(function (s) { return '<tr><td class="num">' + s.season + '</td><td class="r num">' + s.scheduled + '</td><td class="r num">' + s.final + '</td><td class="r num">' + s.quarantined + '</td><td class="r num">' + s.box + '</td><td class="r num">' + s.pbp + '</td><td class="r num">' + s.starters + '</td><td class="r num">' + s.eligible + '</td></tr>'; }).join('') + '</tbody></table></div>';
      return h;
    }
    if (S.adv === 'audit') {
      if (!R.gates) h += '<div class="cb-banner err"><b>Release gates not run yet.</b> Nothing here is releasable until college_baseball/release_gates.js has run and every gate passes.</div>';
      if (!R.audit) h += '<div class="cb-sec">Adversarial audit <span class="r">not run yet</span></div>';
      if (R.gates) h += '<div class="cb-banner ' + (/BLOCKED/.test(R.gates.summary) ? 'err' : 'info') + '"><b>Release gates.</b> ' + esc(R.gates.summary) + '</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Gate</th><th>Status</th><th>Why</th></tr></thead><tbody>' + R.gates.gates.map(function (g) { return '<tr><td>' + esc(g.id + ' ' + g.name) + '</td><td>' + chip(g.status, g.status === 'PASS' ? 'ok' : 'bad') + '</td><td class="cb-note">' + esc(g.why) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      if (R.audit) h += '<div class="cb-sec">Adversarial audit <span class="r">' + esc(R.audit.summary) + '</span></div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Check</th><th>Status</th><th>Threshold</th></tr></thead><tbody>' + R.audit.checks.map(function (c2) { return '<tr><td>' + esc(c2.id.replace(/_/g, ' ').toLowerCase()) + (c2.critical ? ' ' + chip('critical', 'warn') : '') + '</td><td>' + chip(c2.status, c2.status === 'PASS' ? 'ok' : c2.status === 'WARN' ? 'warn' : 'bad') + '</td><td class="cb-note">' + esc(c2.threshold) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      return h;
    }
    if (S.adv === 'registry') {
      h += '<div class="cb-note">Every experiment, accepted or rejected, from the append-only, hash-chained registry (college_baseball/research/experiments.jsonl).</div><div class="cb-scroll"><table class="cb-t"><thead><tr><th>Experiment</th><th>Decision</th><th class="r">Revision</th><th>Recorded</th></tr></thead><tbody>' + R.registry.map(function (x) { return '<tr><td>' + esc(x.id) + '<span class="cb-sub">' + esc(x.title) + '</span></td><td>' + chip(x.decision, x.decision === 'ACCEPT' ? 'ok' : x.decision === 'REJECT' ? 'bad' : 'warn') + (x.holdout ? ' ' + chip('holdout', 'warn') : '') + '</td><td class="r num">' + x.revision + '</td><td class="num">' + esc(String(x.created_at).slice(0, 10)) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      return h;
    }
    return h;
  }

  /* ------------------------------------------------------------ events */
  function bind() {
    var H = S.host; if (!H) return;
    Array.prototype.forEach.call(H.querySelectorAll('[data-view]'), function (b) { b.onclick = function () { S.view = b.getAttribute('data-view'); if (S.view === 'board') S.game = null; render(); }; });
    Array.prototype.forEach.call(H.querySelectorAll('[data-adv]'), function (b) { b.onclick = function () { S.adv = b.getAttribute('data-adv'); render(); }; });
    Array.prototype.forEach.call(H.querySelectorAll('[data-date]'), function (b) { b.onclick = function () { var d = b.getAttribute('data-date'); if (d) go(d); }; });
    Array.prototype.forEach.call(H.querySelectorAll('tr.cb-row'), function (tr) { var f = function () { openGame(tr.getAttribute('data-game')); }; tr.onclick = f; tr.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f(); } }; });
    var back = H.querySelector('[data-back]'); if (back) back.onclick = closeGame;
    var ds = H.querySelector('#cbDate'); if (ds) ds.onchange = function () { go(ds.value); };
    var q = H.querySelector('#cbQ'); if (q) q.oninput = function () { S.f.q = q.value; var pos = q.selectionStart; render(); var q2 = S.host.querySelector('#cbQ'); if (q2) { q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (e) { /* not a text input */ } } };
    var cf = H.querySelector('#cbConf'); if (cf) cf.onchange = function () { S.f.conf = cf.value; render(); };
    var st = H.querySelector('#cbState'); if (st) st.onchange = function () { S.f.state = st.value; render(); };
  }

  W.EDCbaseUI = {
    show: show,
    refresh: function () { S.idx = null; S.days = {}; S.detail = {}; S.data = {}; return show(S.host, {}); },
    hasData: function () { return !!S.idx; },
    closeGame: closeGame,
    entityOpen: function () { return S.view === 'game' && !!S.game; },
    entityKey: function () { return S.view === 'game' && S.game ? S.date + '~' + S.game : null; },
    freshness: function () { return { loadedAt: S.loadedAt, builtAt: S.idx ? S.idx.generated_at : null }; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
