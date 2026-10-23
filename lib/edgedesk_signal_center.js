/* ===========================================================================
   EDGEDESK SIGNAL CENTER — the reader (the Signal Center seat of the terminal).
   docs/signal-center/README.md

   Know what changed. Understand why. See whether the evidence supports it.

   WHAT IT SHOWS
     Research Pulse     counts of what was published in the chosen window
     Signal feed        verified signals, filtered and sorted on the server,
                        paged by cursor; the casual line first (what changed,
                        for whom, how much, how sure), the evidence one tap away
     Signal detail      what changed; previous vs current; the market; the
                        dated facts; the timing; the model and its inputs; the
                        model's record (Model DNA); the uncertainty; the
                        Consensus Breaker; the score's parts; every version and
                        the audit trail; the graphic (drawn from the stored
                        payload); the methodology, folded away
     Model DNA          "can I trust this model in this kind of situation?"
     Coverage           which sport supports which signal, and why not
     Alerts             the reader's sports, teams, categories and level
     Method             the rules the engine keeps

   DATA. Only the sc_* doors of supabase/signal_center.sql, under the reader's
   own token. The server decides what a reader may see: Full Access gets the
   numbers; anyone else gets the number-free preview and a plain way to
   upgrade; nothing here decides access. A failed read keeps the last good
   page on screen, marked stale. The database not being deployed yet, shadow
   mode, an empty window and a signed-out reader each say exactly that.

   Browser: window.EDSignalCenter. Node: require('./edgedesk_signal_center.js')
   for the pure render functions (tools/signal_center/ui.test.js).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDSignalCenter = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var CAT = {
    FORECAST_SHIFT: 'Forecast shift', MARKET_DIVERGENCE: 'Market divergence', MARKET_CONVERGENCE: 'Market convergence', LINE_MOVEMENT: 'Line movement',
    SIMULATION_SHIFT: 'Simulation shift', INJURY_IMPACT: 'Availability', ROSTER_MOVEMENT: 'Roster movement', MODEL_DISAGREEMENT: 'Model disagreement',
    MODEL_RELIABILITY_WARNING: 'Model reliability', HISTORICAL_ANOMALY: 'Historical anomaly', DATA_QUALITY_WARNING: 'Data quality'
  };
  var EVIDENCE = { CONFIRMED_CAUSE: 'Confirmed cause', SUPPORTED_ASSOCIATION: 'Supported association', OBSERVED: 'Observed', UNEXPLAINED: 'Unexplained movement', MODEL_VERSION_CHANGE: 'Model version change' };
  var SPORTS = [['nfl', 'NFL'], ['cfb', 'College football'], ['nba', 'NBA'], ['nhl', 'NHL'], ['mlb', 'MLB'], ['wnba', 'WNBA'], ['ncaam', 'Men’s college basketball']];
  var LABELS = ['Major', 'Notable', 'Routine', 'Monitor'];
  var SORTS = [['recent', 'Most recent'], ['shift', 'Largest verified shift'], ['disagreement', 'Largest market disagreement'], ['evidence', 'Highest evidence quality'], ['rarity', 'Most unusual']];
  var GRADE_TEXT = { VALIDATED: 'Validated', PARTIAL: 'Partial', EARLY: 'Early', EXPERIMENTAL: 'Experimental', UNVALIDATED: 'Unvalidated' };
  var STORE = 'edgedesk_signal_center_v1';

  /* ------------------------------------------------------------ pure helpers */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]; }); }
  function ms(t) { var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  var ETF = null;
  try { ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); } catch (_) { ETF = null; }
  function when(t) { var x = ms(t); if (x === null) return '—'; return ETF ? ETF.format(new Date(x)) + ' ET' : new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  function ago(t, nowMs) {
    var x = ms(t); if (x === null) return 'time unknown';
    var m = Math.round(((nowMs || Date.now()) - x) / 60000);
    if (m < -1) return 'in ' + Math.abs(m) + ' min';
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 48 * 60) return Math.round(m / 60) + ' h ago'; return Math.round(m / 1440) + ' days ago';
  }
  /* an input value as a reader reads it: a full ISO time becomes Eastern */
  function shownVal(v) { if (v == null) return 'none'; if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return when(v); return typeof v === 'object' ? JSON.stringify(v) : String(v); }
  function lc(x) { return String(x == null ? '' : x).toLowerCase(); }
  function labelCls(l) { return 'sc-l-' + lc(l || 'monitor'); }
  function sportLabel(k) { for (var i = 0; i < SPORTS.length; i++) if (SPORTS[i][0] === k) return SPORTS[i][1]; return String(k || '').toUpperCase(); }
  function isProbCat(c) { return c === 'FORECAST_SHIFT' || c === 'SIMULATION_SHIFT' || c === 'LINE_MOVEMENT' || c === 'MARKET_DIVERGENCE'; }

  /* the filters the server applies (sc_feed's p_filters): only what is set */
  function filtersToRpc(f) {
    f = f || {};
    var o = {};
    if (f.sport) o.sport = f.sport;
    if (f.category) o.category = f.category;
    var team = String(f.team || '').trim().slice(0, 60);
    if (team) o.team = team;
    if (f.min_label) o.min_label = f.min_label;
    if (f.sort && f.sort !== 'recent') o.sort = f.sort;
    if (f.scope && f.scope !== 'active') o.scope = f.scope;
    if (f.from) o.from = f.from;
    if (f.to) o.to = f.to;
    if (f.freshness) o.freshness = f.freshness;
    if (f.event_kind) o.event_kinds = [f.event_kind];
    if (f.reliability) o.reliability = [f.reliability];
    if (f.evidence) o.evidence = [f.evidence];
    if (f.market_type) o.market_types = [f.market_type];
    if (f.research_grade) o.research_grades = [f.research_grade];
    if (f.verification) o.verification = [f.verification];
    if (f.include_shadow) o.include_shadow = true;
    return o;
  }
  /* #signals, #signals/<sport>, #signals/s/<id>, #signals/dna[/<sport>], #signals/coverage, #signals/alerts, #signals/method */
  function parseHash(h) {
    var m = /^#(?:signals|signal-center)(?:\/(.*))?$/.exec(String(h || ''));
    if (!m) return null;
    var p = (m[1] || '').split('/').filter(Boolean);
    if (!p.length) return { view: 'feed' };
    if (p[0] === 's' && /^\d+$/.test(p[1] || '')) return { view: 'detail', id: +p[1] };
    if (p[0] === 'dna') return { view: 'dna', sport: p[1] || null };
    if (p[0] === 'coverage' || p[0] === 'alerts' || p[0] === 'method') return { view: p[0] };
    if (/^[a-z_]{2,24}$/.test(p[0])) return { view: 'feed', sport: p[0] };
    return { view: 'feed' };
  }
  function hashFor(st) {
    if (st.view === 'detail') return '#signals/s/' + st.id;
    if (st.view === 'dna') return '#signals/dna' + (st.sport ? '/' + st.sport : '');
    if (st.view === 'coverage' || st.view === 'alerts' || st.view === 'method') return '#signals/' + st.view;
    return '#signals' + (st.sport ? '/' + st.sport : '');
  }

  /* ------------------------------------------------------------ render: pieces */
  function chip(text, cls, title) { return '<span class="sc-chip ' + (cls || '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>'; }
  function renderStatusBar(st, nowMs) {
    if (!st) return '';
    var out = [];
    if (st.deployed === false) return '<div class="sc-banner sc-warn" role="status">Signal Center’s database is not deployed yet. ' + esc(st.reason || '') + ' Nothing here is invented to fill the page.</div>';
    if (st.mode === 'shadow') out.push(chip(st.admin ? 'Shadow mode · operators see unpublished signals' : 'Shadow mode · signals are being validated before publication', 'sc-c-warn'));
    if (st.mode === 'live') out.push(chip('Live · ' + ((st.live_sports || []).map(function (s) { return sportLabel(s); }).join(', ') || 'no sport switched on'), 'sc-c-ok'));
    var last = st.last_completed_at;
    if (last) {
      var stale = (nowMs || Date.now()) - ms(last) > 3 * 3600e3;
      out.push(chip('Evaluated ' + ago(last, nowMs), stale ? 'sc-c-warn' : '', when(last)));
      if (stale) out.push(chip('The last evaluation is over 3 hours old: newer changes may not be here yet', 'sc-c-warn'));
    } else out.push(chip('No evaluation has completed yet', 'sc-c-warn'));
    if (!st.entitled && !st.admin) out.push(chip(st.signed_in ? 'Preview · Full Access shows the numbers' : 'Signed out · preview', 'sc-c-lock'));
    return '<div class="sc-statusbar" role="status">' + out.join('') + '</div>';
  }
  function renderPulse(p, hours) {
    if (!p) return '<section class="sc-pulse" aria-label="Research Pulse"><div class="sc-empty">Research Pulse is loading…</div></section>';
    var cells = [
      ['published', 'New signals'], ['major', 'Major'], ['forecast_shifts', 'Forecast shifts ≥ 5 pp'], ['market_divergences', 'Model–market disagreements'],
      ['availability', 'Availability updates'], ['simulator', 'Simulator changes'], ['reliability_warnings', 'Model reliability warnings'], ['freshness_warnings', 'Source freshness warnings']
    ];
    var any = cells.some(function (c) { return (p[c[0]] || 0) > 0; });
    var sel = '<label class="sc-inline">Window <select data-sc-pulse aria-label="Research Pulse window">' + [[24, '24 hours'], [72, '3 days'], [168, '7 days']].map(function (h) { return '<option value="' + h[0] + '"' + (h[0] === hours ? ' selected' : '') + '>' + h[1] + '</option>'; }).join('') + '</select></label>';
    return '<section class="sc-pulse" aria-label="Research Pulse"><div class="row-between"><h3 class="sc-h3">Research Pulse</h3><span class="spacer"></span>' + sel + '</div>'
      + (any ? '<div class="sc-kpis">' + cells.map(function (c) { var v = p[c[0]] || 0; return '<div class="sc-kpi' + (v ? '' : ' sc-zero') + '"><b>' + esc(v) + '</b><span>' + esc(c[1]) + '</span></div>'; }).join('') + '</div>'
        : '<div class="sc-empty sc-quiet">No material changes detected in the selected period.</div>')
      + (p.model_version_changes ? '<p class="sc-foot">' + esc(p.model_version_changes) + ' forecast change' + (p.model_version_changes === 1 ? '' : 's') + ' in this window came from a model version change, not new information, and are counted apart.</p>' : '')
      + '</section>';
  }
  function select(name, label, opts, val) {
    return '<label class="sc-f"><span>' + esc(label) + '</span><select data-sc-filter="' + name + '" aria-label="' + esc(label) + '"><option value="">' + (name === 'sort' ? 'Most recent' : 'Any') + '</option>'
      + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === val ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
  }
  function renderFilters(f, access, admin, ui) {
    f = f || {}; ui = ui || {};
    var basic = select('sport', 'Sport', SPORTS, f.sport) + select('category', 'Signal type', Object.keys(CAT).map(function (k) { return [k, CAT[k]]; }), f.category)
      + select('min_label', 'Importance', LABELS.map(function (l) { return [l, l + ' and above']; }), f.min_label) + select('sort', 'Sort', SORTS.slice(1), f.sort === 'recent' ? '' : f.sort)
      + '<label class="sc-f"><span>Team</span><input type="search" data-sc-filter="team" value="' + esc(f.team || '') + '" placeholder="e.g. Texas Tech" aria-label="Team" maxlength="60"></label>';
    var more = select('event_kind', 'Event type', [['game', 'Game'], ['season', 'Season outcome'], ['player', 'Player'], ['model', 'Model'], ['source', 'Data source']], f.event_kind)
      + select('evidence', 'Evidence', Object.keys(EVIDENCE).map(function (k) { return [k, EVIDENCE[k]]; }), f.evidence)
      + select('reliability', 'Model confidence', Object.keys(GRADE_TEXT).map(function (k) { return [k, GRADE_TEXT[k]]; }), f.reliability)
      + select('market_type', 'Market', [['moneyline', 'Moneyline / win'], ['season_outcome', 'Season outcome'], ['availability', 'Availability']], f.market_type)
      + select('freshness', 'Data freshness', [['fresh', 'Source under 3 h old'], ['stale', 'Source 3 h or older']], f.freshness)
      + select('research_grade', 'Research grade', [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['F', 'F']], f.research_grade)
      + select('scope', 'Show', [['history', 'History (expired, superseded)'], ['all', 'Everything published']], f.scope === 'active' ? '' : f.scope)
      + '<label class="sc-f"><span>From</span><input type="date" data-sc-filter="from" value="' + esc((f.from || '').slice(0, 10)) + '" aria-label="Detected from"></label>'
      + '<label class="sc-f"><span>To</span><input type="date" data-sc-filter="to" value="' + esc((f.to || '').slice(0, 10)) + '" aria-label="Detected before"></label>'
      + (admin ? select('verification', 'Verification (operators)', [['VERIFIED', 'Verified'], ['UNVERIFIED', 'Unverified'], ['INVALIDATED', 'Invalidated']], f.verification)
        + '<label class="sc-f sc-chk"><input type="checkbox" data-sc-filter="include_shadow"' + (f.include_shadow ? ' checked' : '') + '> <span>Include shadow</span></label>' : '');
    var n = Object.keys(filtersToRpc(f)).length;
    return '<details class="sc-filters"' + (n || ui.open ? ' open' : '') + '><summary>Filters' + (n ? ' · ' + n + ' on' : '') + '</summary>'
      + (access === 'full' || admin ? '<div class="sc-fgrid">' + basic + '</div><details class="sc-more"' + (ui.more ? ' open' : '') + '><summary>More filters</summary><div class="sc-fgrid">' + more + '</div></details>'
        + '<div class="sc-factions"><button type="button" class="btn sm ghost" data-sc-act="clear">Clear filters</button></div>'
        : '<p class="sc-foot">Filters, sorting and history are part of Full Access.</p>')
      + '</details>';
  }
  function valuesLine(it) {
    var v = it.values || {};
    if (!v.previous || !v.current) return '';
    if (it.category === 'MARKET_DIVERGENCE') return '<div class="sc-vals"><span><i>EdgeDesk</i><b>' + esc(v.current.display) + '</b></span><span class="sc-vs">vs</span><span><i>' + esc((v.previous.book || 'Market') + ' no-vig') + '</i><b>' + esc(v.previous.display) + '</b></span><span class="sc-delta">' + esc(v.change_display || '') + '</span></div>';
    if (it.category === 'INJURY_IMPACT') return '<div class="sc-vals"><span><i>Was</i><b>' + esc(v.previous.display || 'not listed') + '</b></span><span class="sc-arrow" aria-hidden="true">→</span><span><i>Now</i><b>' + esc(v.current.display) + '</b></span></div>';
    if (v.unit === 'probability' || v.unit === 'gap_pp') return '<div class="sc-vals"><span><i>Previous</i><b>' + esc(v.previous.display) + '</b></span><span class="sc-arrow" aria-hidden="true">→</span><span><i>Updated</i><b>' + esc(v.current.display) + '</b></span><span class="sc-delta ' + (+it.change_pp < 0 ? 'sc-down' : 'sc-up') + '">' + esc(v.change_display || '') + '</span></div>';
    return '';
  }
  function renderCard(it, access, nowMs) {
    if (!it) return '';
    var full = access === 'full' && !it.locked;
    var head = '<div class="sc-card-top">' + chip(it.label, labelCls(it.label)) + chip(CAT[it.category] || it.category, 'sc-c-cat') + chip(sportLabel(it.sport), 'sc-c-sport')
      + (it.publication && it.publication !== 'PUBLISHED' ? chip(it.publication, 'sc-c-warn') : '') + (it.verification && it.verification !== 'VERIFIED' ? chip(it.verification, 'sc-c-warn') : '')
      + (it.lifecycle && it.lifecycle !== 'ACTIVE' ? chip(lc(it.lifecycle), 'sc-c-dim') : '') + (it.backfilled ? chip('found in the ledger later', 'sc-c-dim', 'Detected after the fact from the append-only snapshot ledger: EdgeDesk did not show this signal at the time') : '')
      + '<span class="sc-when" title="' + esc(when(it.first_detected_at)) + '">detected ' + esc(ago(it.first_detected_at, nowMs)) + '</span></div>';
    var ev = it.event && it.event.label ? it.event.label + (it.event.at ? ' · ' + when(it.event.at) : '') : (it.event_label ? it.event_label + (it.event_at ? ' · ' + when(it.event_at) : '') : '');
    if (!full) {
      return '<article class="sc-card sc-locked" aria-label="' + esc(it.public_headline) + '">' + head + '<h4 class="sc-headline">' + esc(it.public_headline) + '</h4>'
        + (ev ? '<div class="sc-ev">' + esc(ev) + '</div>' : '') + '<p class="sc-expl">' + esc(it.explanation || '') + '</p>'
        + '<div class="sc-actions"><a class="btn sm" href="/#pricing">See the numbers with Full Access</a></div></article>';
    }
    var acts = '<button type="button" class="btn sm" data-sc-open="' + esc(it.signal_id) + '" aria-label="Why: open the evidence for ' + esc(it.headline) + '">Why?</button>'
      + (it.links && it.links.research ? '<a class="btn sm ghost" href="' + esc(it.links.research) + '">Research</a>' : '')
      + (it.links && it.links.simulator && it.category === 'SIMULATION_SHIFT' ? '<a class="btn sm ghost" href="' + esc(it.links.simulator) + '">Explore in Simulator</a>' : '')
      + (it.graphics ? '<button type="button" class="btn sm ghost" data-sc-open="' + esc(it.signal_id) + '" data-sc-goto="graphic">Graphic</button>' : '');
    return '<article class="sc-card" aria-label="' + esc(it.headline) + '">' + head + '<h4 class="sc-headline">' + esc(it.headline) + '</h4>'
      + (ev ? '<div class="sc-ev">' + esc(ev) + '</div>' : '') + valuesLine(it)
      + '<div class="sc-tags">' + chip(EVIDENCE[it.evidence_class] || it.evidence_class, 'sc-c-ev', 'Evidence class') + (it.reliability_grade ? chip('Model: ' + (GRADE_TEXT[it.reliability_grade] || it.reliability_grade), 'sc-c-dna', 'Model DNA grade') : '')
      + chip('Verified', 'sc-c-ok', 'Every number re-read from its source record; every comparability check passed') + (it.model_version ? chip(it.model_version, 'sc-c-dim', 'Model version') : '') + '</div>'
      + '<div class="sc-actions">' + acts + '</div></article>';
  }
  function renderFeed(page, access, nowMs, opts) {
    opts = opts || {};
    if (!page) return '<div class="sc-empty">Loading signals…</div>';
    var items = page.items || [];
    var lead = access === 'full' || opts.admin ? '' : '<div class="sc-banner sc-lock" role="note"><b>Free preview.</b> ' + esc(page.note || 'What changed, without the numbers.') + ' <a href="/#pricing">See plans</a>.</div>';
    if (!items.length) return lead + '<div class="sc-empty sc-quiet">' + (opts.filtered ? 'No signals match these filters.' : 'No material changes detected in the selected period.') + '</div>';
    return lead + '<div class="sc-list">' + items.map(function (it) { return renderCard(it, access, nowMs); }).join('') + '</div>'
      + (page.next_cursor ? '<div class="sc-more-row"><button type="button" class="btn" data-sc-act="more">Load more signals</button></div>' : '')
      + (page.examples && page.examples.length ? '<section class="sc-examples"><h3 class="sc-h3">Example research graphics</h3><p class="sc-foot">From EdgeDesk’s published history. The events have passed; these are not current research.</p><div class="sc-ex-grid">' + page.examples.map(function (x, i) { return '<figure class="sc-ex" data-sc-example="' + i + '"><div class="sc-gfx-slot" aria-label="Example graphic loading"></div></figure>'; }).join('') + '</div></section>' : '');
  }

  /* ------------------------------------------------------------ render: detail */
  function row(k, v) { return '<div class="sc-kv"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>'; }
  function renderDna(d, compact) {
    if (!d) return '<div class="sc-empty">No Model DNA record is stored for this sport yet.</div>';
    if (d.locked) return '<div class="sc-dna sc-locked"><div class="sc-dna-h"><b>' + esc(d.label) + '</b>' + chip(GRADE_TEXT[d.grade] || d.grade, 'sc-g-' + lc(d.grade)) + '</div><p>' + esc(d.grade_means || '') + '</p><p class="sc-foot">' + esc(d.live_n == null ? 'No live record' : d.live_n + ' verified live games graded') + '. The full record is part of Full Access.</p></div>';
    var L = d.live || {}, W = L.winner || {}, M = (L.market && L.market.moneyline) || null;
    var cal = (L.calibration || []).filter(function (b) { return b.n; });
    var bars = cal.length ? '<div class="sc-cal" role="img" aria-label="Calibration: predicted versus observed by probability band">' + cal.map(function (b) {
      var mp = Math.round(100 * b.mean_predicted), ob = Math.round(100 * b.observed);
      return '<div class="sc-cal-row' + (b.inside_interval === false ? ' sc-out' : '') + '"><span class="sc-cal-k">' + Math.round(b.from * 100) + '–' + Math.round(b.to * 100) + '%</span><span class="sc-cal-bar"><i class="sc-cal-p" style="width:' + mp + '%"></i><i class="sc-cal-o" style="width:' + ob + '%"></i></span><span class="sc-cal-v">said ' + mp + '% · saw ' + ob + '% · n ' + b.n + (b.inside_interval === false ? ' · outside its interval' : '') + '</span></div>';
    }).join('') + '</div>' : '<p class="sc-foot">No calibration band has enough live games yet.</p>';
    var bt = (d.backtest && d.backtest.markets) || [];
    var hist = (d.history || []).length > 1 ? '<p class="sc-foot">Grade history: ' + d.history.map(function (h) { return (GRADE_TEXT[h.grade] || h.grade) + ' (' + when(h.evaluated_at) + (h.n != null ? ', n ' + h.n : '') + ')'; }).join(' → ') + '</p>' : '';
    return '<div class="sc-dna"><div class="sc-dna-h"><b>' + esc(d.label) + '</b>' + chip(GRADE_TEXT[d.grade] || d.grade, 'sc-g-' + lc(d.grade), d.grade_means) + '</div>'
      + '<p class="sc-trust"><b>Can I trust it here?</b> ' + esc(d.trust_answer || d.grade_means || '') + '</p>'
      + (compact ? '' : '<dl class="sc-kvs">'
        + row('Serving version', esc(d.serving ? d.serving.version + (d.serving.live_graded != null ? ' · ' + d.serving.live_graded + ' graded live games' : '') : 'unknown'))
        + row('Live record', esc(W.n != null ? W.n + ' verified games · ' + lc(W.sample_state || '').replace(/_/g, ' ') : 'none published'))
        + row('Brier score (winner)', esc(W.brier != null ? W.brier : 'not printed under ' + (L.min_n || 20) + ' games'))
        + row('Log loss (winner)', esc(W.log_loss != null ? W.log_loss : '—'))
        + (M ? row('Against the market, same games', esc(M.n + ' games · model ' + (M.model_brier != null ? M.model_brier : '—') + ' · market ' + (M.market_brier != null ? M.market_brier : '—') + ' · ' + lc(M.sample_state || '').replace(/_/g, ' '))) : '')
        + (L.margin ? row('Margin error (spread)', esc('MAE ' + L.margin.mae + ' · bias ' + L.margin.bias + ' · RMSE ' + L.margin.rmse + ' (n ' + L.margin.n + ')')) : '')
        + (L.degradation && L.degradation.available ? row('Recent window', esc(L.degradation.recent_period + ': Brier ' + L.degradation.recent_brier + ' vs ' + L.degradation.earlier_brier + ' before (' + L.degradation.derived + ')')) : row('Recent degradation', esc(L.degradation ? L.degradation.reason : 'not measurable yet')))
        + row('Evaluation window', esc(L.window ? when(L.window.from) + ' to ' + when(L.window.to) : '—'))
        + '</dl><h5 class="sc-h5">Calibration, live (said vs saw)</h5>' + bars
        + (bt.length ? '<h5 class="sc-h5">Out-of-sample backtest</h5><div class="sc-scroll"><table class="sc-tbl"><thead><tr><th>Market</th><th>Forecast type</th><th>Outcome test</th><th>Market test</th><th class="sc-num">n</th></tr></thead><tbody>'
          + bt.map(function (m) { return '<tr><td>' + esc(m.market) + '</td><td>' + esc(m.forecast_type) + '</td><td>' + esc(m.outcome || '—') + '</td><td>' + esc(lc(m.market_test || '—').replace(/_/g, ' ')) + '</td><td class="sc-num">' + esc(m.n == null ? '—' : m.n) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '')
        + ((d.limitations || []).length ? '<h5 class="sc-h5">Known limitations</h5><ul class="sc-ul">' + d.limitations.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '')
        + hist + '<p class="sc-foot">' + esc(d.comparisons || '') + ' Source: ' + esc(d.source || '') + '. Raw win rate is not a measure of model quality and is not shown as one.</p>')
      + '</div>';
  }
  function renderConsensus(c) {
    if (!c || !c.available) return '';
    return '<section class="sc-sec" id="sc-consensus"><h3 class="sc-h3">Consensus Breaker</h3><p class="sc-foot">Every compatible estimate of the same outcome (' + esc(c.outcome) + '), side by side.</p>'
      + '<div class="sc-scroll"><table class="sc-tbl"><thead><tr><th>Source</th><th class="sc-num">' + esc(c.outcome) + '</th><th>As of</th><th>Group</th></tr></thead><tbody>'
      + c.references.map(function (r) { return '<tr><td>' + esc(r.label) + (r.version ? ' <span class="sc-dim">' + esc(r.version) + '</span>' : '') + '</td><td class="sc-num">' + esc(r.display) + '</td><td>' + esc(when(r.at)) + '</td><td>' + esc(r.group) + '</td></tr>'; }).join('')
      + '</tbody></table></div><dl class="sc-kvs">' + row('Range', esc((Math.round(c.range.lo * 1000) / 10).toFixed(1) + '% to ' + (Math.round(c.range.hi * 1000) / 10).toFixed(1) + '% · ' + c.range.width_pp + ' pp wide'))
      + row('Independent groups', esc(c.independent_groups)) + row('Correlation', esc(c.correlation_note)) + row('Consensus', esc(c.consensus_note)) + '</dl></section>';
  }
  function renderScore(s) {
    if (!s) return '';
    return '<details class="sc-sec"><summary><h3 class="sc-h3 sc-inline">Importance ' + esc(s.total) + '/100 · ' + esc(s.label) + '</h3></summary><p class="sc-foot">' + esc(s.claim) + '</p>'
      + '<div class="sc-scroll"><table class="sc-tbl"><thead><tr><th>Component</th><th class="sc-num">Value</th><th class="sc-num">Weight</th><th class="sc-num">Points</th><th>Rule</th></tr></thead><tbody>'
      + s.components.map(function (c) { return '<tr><td>' + esc(c.id) + '</td><td class="sc-num">' + esc(c.value == null ? 'not scored' : c.value) + '</td><td class="sc-num">' + esc(c.weight) + '</td><td class="sc-num">' + esc(c.points) + '</td><td class="sc-small">' + esc(c.rule) + (c.note ? ' (' + esc(c.note) + ')' : '') + '</td></tr>'; }).join('')
      + (s.penalties || []).map(function (p) { return '<tr class="sc-pen"><td>' + esc(p.id) + '</td><td></td><td></td><td class="sc-num">−' + esc(p.points) + '</td><td class="sc-small">' + esc(p.rule) + '</td></tr>'; }).join('')
      + '</tbody></table></div><p class="sc-foot">Specification ' + esc(s.spec) + '.</p></details>';
  }
  function renderDetail(d, nowMs) {
    if (!d) return '<div class="sc-empty">Loading the signal…</div>';
    if (d.found === false) return '<div class="sc-empty">That signal is not available: it does not exist, it is not published, or it was withdrawn.</div>';
    if (d.access === 'locked') return '<div class="sc-banner sc-lock"><b>Full Access.</b> The evidence behind this signal, its versions and its graphic are part of Full Access. <a href="/#pricing">See plans</a>.</div>';
    if (d.access === 'preview') return renderCard(d.item, 'preview', nowMs);
    var p = d.payload || {}, it = d.item || {}, v = p.values || {}, ev = p.evidence || {}, ts = p.timestamps || {}, m = p.model || {};
    var nav = '<nav class="sc-jump" aria-label="On this signal">' + [['sc-what', 'What changed'], ['sc-why', 'Why'], ['sc-timing', 'Timing'], ['sc-model', 'Model'], ['sc-dna', 'Model DNA'], ['sc-unc', 'Uncertainty']].concat(p.consensus && p.consensus.available ? [['sc-consensus', 'Consensus']] : []).concat([['sc-history', 'History'], ['sc-graphic', 'Graphic']]).map(function (j) { return '<a href="#" data-sc-jump="' + j[0] + '">' + esc(j[1]) + '</a>'; }).join('') + '</nav>';
    var lifeNote = it.lifecycle && it.lifecycle !== 'ACTIVE' ? '<div class="sc-banner sc-warn" role="note">This signal is ' + esc(lc(it.lifecycle)) + (it.lifecycle === 'SUPERSEDED' ? ': a newer signal about the same subject exists.' : it.lifecycle === 'EXPIRED' ? ': its event has started; it is history now.' : '.') + '</div>' : '';
    var what = '<section class="sc-sec" id="sc-what"><div class="sc-card-top">' + chip(it.label, labelCls(it.label)) + chip(CAT[p.category] || p.category, 'sc-c-cat') + chip(sportLabel(p.sport), 'sc-c-sport') + '</div>'
      + '<h3 class="sc-big" tabindex="-1" id="sc-detail-h">' + esc(p.headline) + '</h3><p class="sc-lede">' + esc(p.summary || '') + '</p>' + valuesLine(Object.assign({}, it, { values: v, change_pp: v.change_pp }))
      + (p.market && p.market.book ? '<dl class="sc-kvs">' + row('Market', esc(p.market.book + (p.market.source_label ? ' via ' + p.market.source_label : '') + ' · captured ' + when(p.market.captured_at) + (p.market.moneyline ? ' · moneyline ' + p.market.moneyline.home + ' / ' + p.market.moneyline.away : '') + (p.market.devig_method ? ' · de-vig ' + p.market.devig_method : ''))) + '</dl>' : '')
      + (p.relevance ? '<p class="sc-foot">' + esc(p.relevance) + '</p>' : '') + '</section>';
    var items = (ev.items || []).map(function (x) { return '<li>' + chip(x.kind === 'event' || x.kind === 'fact' ? 'fact' : x.kind, x.verified ? 'sc-c-ok' : 'sc-c-dim') + ' ' + esc(x.text) + (x.source ? ' <span class="sc-dim">' + esc(x.source) + '</span>' : '') + '</li>'; }).join('');
    var why = '<section class="sc-sec" id="sc-why"><h3 class="sc-h3">Why did this change?</h3><div class="sc-ladder">' + chip(EVIDENCE[ev.class] || ev.class, 'sc-c-ev') + '<span class="sc-dim">' + esc(ev.means || '') + '</span></div>'
      + '<p>' + esc(ev.summary || '') + '</p>' + (items ? '<ul class="sc-ul">' + items + '</ul>' : '') + (ev.attribution ? '<p class="sc-foot">' + esc(ev.attribution) + '</p>' : '')
      + (p.facts_vs_estimates ? '<dl class="sc-kvs">' + row('Facts', esc((p.facts_vs_estimates.facts || []).join(' '))) + row('Estimate', esc(p.facts_vs_estimates.estimate || 'None calculated.')) + '</dl>' : '') + '</section>';
    var tl = [['Event', ts.event_at], ['Source published', ts.source_published_at], ['Forecast calculated', ts.calculated_at], ['Recorded by EdgeDesk', ts.recorded_at], ['Detected by Signal Center', ts.detected_at], ['Published', it.publication === 'PUBLISHED' ? (d.events || []).filter(function (e) { return e.kind === 'published'; }).map(function (e) { return e.at; })[0] : null]];
    var timing = '<section class="sc-sec" id="sc-timing"><h3 class="sc-h3">Timing</h3><ol class="sc-timeline">' + tl.map(function (x) { return '<li class="' + (x[1] ? '' : 'sc-none') + '"><b>' + esc(x[0]) + '</b><span>' + esc(x[1] ? when(x[1]) : 'not recorded') + '</span></li>'; }).join('') + '</ol>'
      + '<p class="sc-foot">Each time is a different fact. An earlier timestamp on a source never proves EdgeDesk knew earlier' + (it.backfilled ? '; this signal was found in the ledger after the fact.' : '.') + '</p></section>';
    var ic = (ev.input_changes || []);
    var model = '<section class="sc-sec" id="sc-model"><h3 class="sc-h3">Model version and inputs</h3><dl class="sc-kvs">' + row('Model', esc((m.id || '—') + (m.version && m.version !== m.id ? ' · ' + m.version : ''))) + (m.previous_version && m.previous_version !== m.version ? row('Previous version', esc(m.previous_version)) : '')
      + (m.status ? row('Status', esc(m.status)) : '') + (m.built_at ? row('Model run', esc(when(m.built_at))) : '') + (p.simulation ? row('Simulation', esc(p.simulation.competition + ' ' + p.simulation.season + ' · runs ' + p.simulation.previous_run + ' → ' + p.simulation.current_run + ' · ' + p.simulation.seeds)) : '') + '</dl>'
      + (ic.length ? '<div class="sc-scroll"><table class="sc-tbl"><thead><tr><th>Input</th><th>Before</th><th>After</th><th>Kind</th></tr></thead><tbody>' + ic.map(function (x) { return '<tr><td>' + esc(x.label) + '</td><td>' + esc(shownVal(x.from)) + '</td><td>' + esc(shownVal(x.to)) + '</td><td>' + esc(x.verified ? 'source-dated fact' : 'model input') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p class="sc-foot">No input change is recorded between the two records.</p>')
      + (p.simulation && p.simulation.estimated_note ? '<div class="sc-banner sc-warn">' + esc(p.simulation.estimated_note) + '</div>' : '') + '</section>';
    var dna = '<section class="sc-sec" id="sc-dna"><h3 class="sc-h3">Model DNA</h3>' + renderDna(d.dna, false) + '</section>';
    var dist = v.distribution || {};
    var unc = '<section class="sc-sec" id="sc-unc"><h3 class="sc-h3">Uncertainty and checks</h3><dl class="sc-kvs">'
      + row('How unusual', esc(dist.rarity != null ? 'Larger than ' + Math.floor(dist.rarity * 100) + '% of ' + dist.reference_n + ' earlier comparable changes (' + (dist.basis || '') + ')' : (dist.note || 'not scored')))
      + (v.sampling_note ? row('Monte Carlo', esc(v.sampling_note)) : '') + (v.z != null ? row('Change in sampling errors', esc('z = ' + v.z)) : '')
      + row('Data flags', esc((p.quality && p.quality.flags && p.quality.flags.length) ? p.quality.flags.join(', ') : 'none')) + '</dl>'
      + '<details><summary>Verification checks (' + esc((p.verification && p.verification.checks || []).length) + ')</summary><ul class="sc-ul">' + ((p.verification && p.verification.checks) || []).map(function (c) { return '<li>' + chip(c.ok ? 'pass' : 'fail', c.ok ? 'sc-c-ok' : 'sc-c-warn') + ' ' + esc(c.id.replace(/_/g, ' ')) + (c.detail != null ? ' <span class="sc-dim">' + esc(typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)) + '</span>' : '') + '</li>'; }).join('') + '</ul></details></section>';
    var versions = (d.versions || []).map(function (x) { return '<li><b>v' + esc(x.version) + '</b> · ' + esc(x.reason) + ' · ' + esc(when(x.created_at)) + ' · ' + esc(x.headline) + (x.version === it.version ? ' ' + chip('current', 'sc-c-ok') : ' <button type="button" class="btn sm ghost" data-sc-version="' + esc(x.version) + '">Read v' + esc(x.version) + '</button>') + '</li>'; }).join('');
    var events = (d.events || []).map(function (e) { return '<li>' + esc(when(e.at)) + ' · ' + esc(e.kind.replace(/_/g, ' ')) + ' · ' + esc(e.actor) + '</li>'; }).join('');
    var timeline = (d.timeline || []).length > 1 ? '<h5 class="sc-h5">How this subject evolved</h5><ol class="sc-ul">' + d.timeline.map(function (t) { return '<li>' + (t.signal_id === it.signal_id ? '<b>' + esc(t.headline) + '</b>' : '<a href="#signals/s/' + esc(t.signal_id) + '">' + esc(t.headline) + '</a>') + ' · ' + esc(when(t.first_detected_at)) + ' · ' + esc(lc(t.lifecycle)) + '</li>'; }).join('') + '</ol>' : '';
    var hist = '<section class="sc-sec" id="sc-history"><h3 class="sc-h3">Versions and history</h3><ol class="sc-ul">' + versions + '</ol>' + timeline + '<details><summary>Audit trail (' + (d.events || []).length + ')</summary><ul class="sc-ul">' + events + '</ul></details><div id="sc-version-view"></div></section>';
    var gfx = (d.graphics || []).filter(function (g) { return g.content; });
    var cur = gfx.filter(function (g) { return g.current && g.status === 'READY'; });
    var graphic = '<section class="sc-sec" id="sc-graphic"><h3 class="sc-h3">Graphic</h3>' + (cur.length
      ? '<div class="stseg sc-fmt" role="group" aria-label="Graphic format">' + cur.map(function (g, i) { return '<button type="button" data-sc-fmt="' + esc(g.graphic_id) + '" class="' + (i === 0 ? 'on' : '') + '">' + esc(g.format) + '</button>'; }).join('') + '</div>'
        + '<div class="sc-gfx-slot" id="sc-gfx" aria-live="polite"></div><div class="sc-actions"><button type="button" class="btn sm" data-sc-act="download">Download PNG</button><button type="button" class="btn sm ghost" data-sc-act="share">Share</button></div>'
        + '<p class="sc-foot">Drawn from version ' + esc(it.version) + ' of this signal (payload ' + esc(String(d.payload_sha256 || '').slice(0, 12)) + '…). Nothing is posted anywhere automatically.</p>'
      : '<p class="sc-foot">' + (gfx.length ? 'The graphics on file belong to an earlier version and are marked outdated.' : 'No graphic for this signal: graphics are drawn for verified signals rated Notable or above.') + '</p>')
      + (gfx.filter(function (g) { return !g.current || g.status !== 'READY'; }).length ? '<details><summary>Earlier graphics</summary><ul class="sc-ul">' + gfx.filter(function (g) { return !g.current || g.status !== 'READY'; }).map(function (g) { return '<li>' + esc(g.template + ' · ' + g.format + ' · ' + lc(g.status) + ' · ' + when(g.generated_at)) + ' <button type="button" class="btn sm ghost" data-sc-oldgfx="' + esc(g.graphic_id) + '">View (stamped)</button></li>'; }).join('') + '</ul></details>' : '') + '</section>';
    var links = '<section class="sc-sec"><h3 class="sc-h3">Keep researching</h3><div class="sc-actions">' + (p.links && p.links.research ? '<a class="btn sm" href="' + esc(p.links.research) + '">Open the game research</a>' : '')
      + (p.links && p.links.simulator ? '<a class="btn sm ghost" href="' + esc(p.links.simulator) + '">Explore in Simulator</a>' : '') + '<a class="btn sm ghost" href="#signals/dna/' + esc(p.sport) + '">Model DNA · ' + esc(sportLabel(p.sport)) + '</a></div>'
      + (p.links && p.links.simulator ? '<p class="sc-foot">The Simulator opens on ' + esc(sportLabel(p.sport)) + '; it has no team-level link yet, so find the team in its tables.</p>' : '') + '</section>';
    var meth = '<details class="sc-sec sc-meth"><summary><h3 class="sc-h3 sc-inline">Methodology and identifiers</h3></summary><dl class="sc-kvs">' + row('Signal key', '<code>' + esc(p.signal_key) + '</code>') + row('Version hash', '<code>' + esc(p.version_hash) + '</code>') + row('Payload SHA-256', '<code>' + esc(d.payload_sha256 || '') + '</code>')
      + row('Engine', esc(p.engine_version)) + row('Scoring spec', esc(p.spec_version)) + row('Sources', esc((p.sources || []).filter(Boolean).map(function (s) { return s.label + (s.ref ? ' (' + s.ref + ')' : ''); }).join('; '))) + '</dl></details>';
    var adm = d.admin ? '<section class="sc-sec sc-admin"><h3 class="sc-h3">Operator</h3><p class="sc-foot">Publication: ' + esc(it.publication) + '. Decisions here are server-checked and kept in the audit trail.</p><div class="sc-actions">'
      + ['publish', 'hold', 'withdraw', 'preview_on', 'preview_off', 'regenerate'].map(function (a) { return '<button type="button" class="btn sm ghost" data-sc-admin="' + a + '">' + esc(a.replace('_', ' ')) + '</button>'; }).join('') + '</div><p class="sc-foot"><a href="/admin/signals/">Open the operator console</a></p></section>' : '';
    return '<div class="sc-detail"><div class="sc-actions"><button type="button" class="btn sm ghost" data-sc-act="back" aria-label="Back to the signal feed">← Signals</button></div>' + lifeNote + nav + what + why + timing + model + dna + unc + renderConsensus(p.consensus) + renderScore(p.score) + hist + graphic + links + adm + meth + '</div>';
  }

  /* ------------------------------------------------------------ render: other views */
  function renderCoverage(reg) {
    if (!reg) return '<div class="sc-empty">The capability registry is not loaded.</div>';
    var cats = ['FORECAST_SHIFT', 'MARKET_DIVERGENCE', 'LINE_MOVEMENT', 'SIMULATION_SHIFT', 'INJURY_IMPACT', 'MODEL_RELIABILITY_WARNING'];
    var st = function (c) { if (!c) return '<span class="sc-st sc-st-na" title="No source supports it">—</span>'; var k = lc(c.state); return '<span class="sc-st sc-st-' + k + '" title="' + esc(c.detail) + '">' + esc(c.state.replace('_', ' ').toLowerCase()) + '</span>'; };
    return '<section class="sc-sec"><h3 class="sc-h3">Coverage</h3><p class="sc-lede">A sport supports a signal because a dated source exists, not because it is in a menu. Hover or tap a state for its source or its blocker.</p>'
      + '<div class="sc-scroll"><table class="sc-tbl sc-cov"><thead><tr><th>Sport</th><th>Rollout</th>' + cats.map(function (c) { return '<th>' + esc(CAT[c]) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + reg.sports().map(function (s) { return '<tr><td><b>' + esc(s.label) + '</b><span class="sc-sub">' + esc(s.season_note) + '</span></td><td>' + esc(lc(s.rollout).replace('_', ' ')) + '</td>' + cats.map(function (c) { return '<td>' + st(s.signals[c]) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div><h5 class="sc-h5">Not supported anywhere yet</h5><ul class="sc-ul">' + Object.keys(reg.UNSUPPORTED).map(function (k) { return '<li><b>' + esc(CAT[k]) + '.</b> ' + esc(reg.UNSUPPORTED[k]) + '</li>'; }).join('') + '</ul>'
      + '<details><summary>Every capability, with its source</summary>' + reg.sports().map(function (s) { return '<h5 class="sc-h5">' + esc(s.label) + '</h5><ul class="sc-ul">' + Object.keys(s.capabilities).map(function (k) { var c = s.capabilities[k]; return '<li>' + st(c) + ' <b>' + esc(k.replace(/_/g, ' ')) + '</b>: ' + esc(c.detail) + (c.source ? ' <code>' + esc(c.source) + '</code>' : '') + '</li>'; }).join('') + '</ul>'; }).join('') + '</details></section>';
  }
  function renderPrefs(p, st) {
    p = p || {};
    var has = function (arr, v) { return (arr || []).indexOf(v) >= 0; };
    return '<section class="sc-sec"><h3 class="sc-h3">Alerts</h3><p class="sc-lede">Choose what Signal Center tells you about. Notices land in your research alerts (the bell), once per signal, and at most one per team or player every few hours.</p>'
      + (st && !st.entitled ? '<div class="sc-banner sc-lock">Notices are sent to Full Access accounts. Your choices are saved and take effect when you have it.</div>' : '')
      + '<form class="sc-prefs" data-sc-prefs="1"><fieldset><legend>Sports</legend>' + SPORTS.map(function (s) { return '<label class="sc-chk"><input type="checkbox" name="sports" value="' + s[0] + '"' + (has(p.sports, s[0]) ? ' checked' : '') + '> ' + esc(s[1]) + '</label>'; }).join('') + '<p class="sc-foot">None ticked means every sport.</p></fieldset>'
      + '<fieldset><legend>Signal types</legend>' + Object.keys(CAT).filter(function (k) { return ['ROSTER_MOVEMENT', 'MODEL_DISAGREEMENT', 'HISTORICAL_ANOMALY'].indexOf(k) < 0; }).map(function (k) { return '<label class="sc-chk"><input type="checkbox" name="categories" value="' + k + '"' + (has(p.categories, k) ? ' checked' : '') + '> ' + esc(CAT[k]) + '</label>'; }).join('') + '<p class="sc-foot">None ticked means every type.</p></fieldset>'
      + '<fieldset><legend>Teams</legend><label class="sc-f"><span>Teams, comma separated</span><input type="text" name="teams" value="' + esc((p.teams || []).join(', ')) + '" maxlength="600" placeholder="Texas Tech, Kansas City Chiefs"></label></fieldset>'
      + '<fieldset><legend>Level</legend><label class="sc-f"><span>Tell me about</span><select name="min_label">' + LABELS.map(function (l) { return '<option value="' + l + '"' + ((p.min_label || 'Notable') === l ? ' selected' : '') + '>' + l + ' and above</option>'; }).join('') + '</select></label>'
      + '<label class="sc-chk"><input type="checkbox" name="notify"' + (p.notify ? ' checked' : '') + '> Send me in-app notices</label></fieldset>'
      + '<div class="sc-actions"><button type="submit" class="btn">Save alert preferences</button><span class="sc-dim" id="sc-prefs-msg" role="status"></span></div></form>'
      + '<p class="sc-foot">No email, text message or outside service is used for these notices.</p></section>';
  }
  function renderMethod(E) {
    var spec = E && E.SPEC;
    return '<section class="sc-sec"><h3 class="sc-h3">How Signal Center decides</h3><ol class="sc-ul">'
      + '<li><b>Only comparable numbers.</b> The same event, the same outcome, the same model identity and the same market definition, or no signal.</li>'
      + '<li><b>A model change is labelled as one.</b> A move across a model version change is never presented as news.</li>'
      + '<li><b>The evidence ladder.</b> Confirmed cause needs a controlled computation that isolates one input; a dated event between two snapshots is a supported association; otherwise the movement is unexplained, and Signal Center says it does not know yet.</li>'
      + '<li><b>Market references.</b> A named book, a capture time inside 180 minutes, a two-way market, multiplicative de-vig, and the teams in the right order. A disagreement is a question, never a recommendation.</li>'
      + '<li><b>The Simulator.</b> Two published runs, the same outcome definition, and a change beyond four Monte Carlo standard errors. Monte Carlo error is sampling error only.</li>'
      + '<li><b>Verified means re-read.</b> Every number in a verified signal was re-read from its source record and every check passed; unverified signals never reach the feed.</li>'
      + '<li><b>History is kept.</b> A correction is a new version; a withdrawal keeps every earlier version readable.</li></ol>'
      + (spec ? '<h5 class="sc-h5">Importance score (' + esc(spec.id) + ')</h5><p>' + esc(spec.claim) + '</p><div class="sc-scroll"><table class="sc-tbl"><thead><tr><th>Component</th><th class="sc-num">Weight</th><th>Rule</th></tr></thead><tbody>'
        + Object.keys(spec.components).map(function (k) { return '<tr><td>' + esc(k) + '</td><td class="sc-num">' + esc(spec.components[k].weight) + '</td><td class="sc-small">' + esc(spec.components[k].rule) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        + '<p class="sc-foot">Labels: Major 70+, Notable 50+, Routine 30+, Monitor below. Penalties: ' + Object.keys(spec.penalties).map(function (k) { return k.replace(/_/g, ' ') + ' ' + spec.penalties[k].points; }).join(', ') + '.</p>' : '')
      + '<p class="sc-foot">Full methodology: docs/signal-center/METHODOLOGY.md. Research, not picks.</p></section>';
  }
  function renderDnaList(list) {
    if (!list) return '<div class="sc-empty">Loading Model DNA…</div>';
    if (!list.length) return '<div class="sc-empty">No Model DNA record is stored yet: the first evaluation run writes them.</div>';
    return '<section class="sc-sec"><h3 class="sc-h3">Model DNA</h3><p class="sc-lede">Can I trust this model in this kind of situation? Each record reads EdgeDesk’s published audits only: the out-of-sample backtest and the live, locked-before-the-game record.</p>'
      + list.map(function (d) { return renderDna(d, false); }).join('') + '</section>';
  }

  function shell(st, view) {
    var tabs = [['feed', 'Signals'], ['dna', 'Model DNA'], ['coverage', 'Coverage'], ['alerts', 'Alerts'], ['method', 'Method']];
    return '<div class="sc-root"><div class="row-between"><h2 style="margin:0">Signal Center</h2><span class="spacer"></span><span class="sc-unread" id="sc-unread" aria-live="polite"></span><button class="refreshbtn" type="button" title="Refresh" aria-label="Refresh Signal Center" data-sc-act="refresh">&#8635;</button></div>'
      + '<p class="lede">Know what changed. Understand why. See whether the evidence supports it. Research, not picks.</p>'
      + '<div id="sc-status"></div>'
      + '<nav class="stseg sc-tabs" aria-label="Signal Center">' + tabs.map(function (t) { var on = (view === t[0]) || (view === 'detail' && t[0] === 'feed'); return '<button type="button" data-sc-view="' + t[0] + '" class="' + (on ? 'on' : '') + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(t[1]) + '</button>'; }).join('') + '</nav>'
      + '<div id="sc-body" aria-live="polite"></div></div>';
  }

  /* ============================================================ the browser part */
  var S = { host: null, view: 'feed', id: null, sport: null, filters: { sort: 'recent', scope: 'active' }, page: null, status: null, pulse: null, hours: 24, detail: null, dna: null, prefs: null, error: null, loading: false, stale: false, gfx: null };
  try { var saved = root.localStorage && JSON.parse(root.localStorage.getItem(STORE) || 'null'); if (saved && saved.filters) S.filters = Object.assign(S.filters, saved.filters); if (saved && saved.hours) S.hours = saved.hours; } catch (_) { /* a private window: defaults */ }
  function persist() { try { root.localStorage.setItem(STORE, JSON.stringify({ filters: S.filters, hours: S.hours })); } catch (_) { /* per-viewer convenience only */ } }

  async function rpc(name, args) {
    if (S.rpc) return S.rpc(name, args || {});
    var url = root.SB_URL, key = root.SB_KEY;
    if (!url || !key) throw Object.assign(new Error('the database client is not loaded'), { status: 0 });
    var tok = key;
    try { if (typeof root.edToken === 'function') tok = await root.edToken(); } catch (_) { tok = key; }
    var r = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: JSON.stringify(args || {}) });
    var text = await r.text();
    if (!r.ok) { var e = new Error('db ' + r.status); e.status = r.status; e.body = text; throw e; }
    return text ? JSON.parse(text) : null;
  }
  function notDeployed(e) { return e && (e.status === 404 || /PGRST202|Could not find the function|does not exist/i.test(String(e.body || ''))); }
  function el(id) { return S.host && S.host.querySelector('#' + id); }
  function body(html) { var b = el('sc-body'); if (b) b.innerHTML = html; }
  function paintStatus() { var b = el('sc-status'); if (b) b.innerHTML = renderStatusBar(S.status, Date.now()) + (S.stale ? '<div class="sc-banner sc-warn" role="status">The last refresh failed (' + esc(S.error || '') + '). What you see is the last good read.</div>' : ''); }
  function access() { return (S.page && S.page.access) || (S.status && (S.status.entitled || S.status.admin) ? 'full' : 'preview'); }
  function paint() {
    if (!S.host) return;
    paintStatus();
    if (S.status && S.status.deployed === false) { body(S.view === 'coverage' ? renderCoverage(root.EDSignalRegistry) : (S.view === 'method' ? methodBody() : '<div class="sc-empty">There is nothing to show until Signal Center’s database is deployed. Coverage and Method explain what it will read.</div>')); return; }
    if (S.view === 'detail') { body(renderDetail(S.detail, Date.now())); afterDetail(); return; }
    if (S.view === 'dna') { body(renderDnaList(S.dna)); return; }
    if (S.view === 'coverage') { body(renderCoverage(root.EDSignalRegistry)); return; }
    if (S.view === 'alerts') { body(S.status && S.status.signed_in === false ? '<div class="sc-empty">Sign in to choose your alerts.</div>' : renderPrefs(S.prefs, S.status)); return; }
    if (S.view === 'method') { body(methodBody()); return; }
    var f = Object.assign({}, S.filters, S.sport ? { sport: S.sport } : {});
    body(renderPulse(S.pulse, S.hours) + renderFilters(f, access(), S.status && S.status.admin, { open: S.filtersOpen, more: S.moreOpen }) + (S.loading && !S.page ? '<div class="sc-empty">Loading signals…</div>' : renderFeed(S.page, access(), Date.now(), { filtered: Object.keys(filtersToRpc(f)).length > 0, admin: S.status && S.status.admin })));
    paintExamples();
  }
  function render() { if (!S.host) return; S.host.innerHTML = shell(S.status, S.view); S.rendered = true; paint(); }
  function setHash() { try { history.replaceState(null, '', location.pathname + location.search + hashFor(S)); } catch (_) { /* fine */ } }

  async function loadStatus() {
    try { S.status = await rpc('sc_status', {}); }
    catch (e) { if (notDeployed(e)) S.status = { deployed: false, reason: 'Apply supabase/signal_center.sql (docs/signal-center/DEPLOYMENT.md).' }; else throw e; }
  }
  /* a landing (no route asked for) stays only when there is something to read:
     the database is deployed and either live, or the reader is an operator */
  function landingKeeps(st) { return !!(st && st.deployed !== false && (st.mode === 'live' || st.admin)); }
  function handoff() { var h = S.handoff; S.handoff = null; if (typeof h === 'function') { try { h(); } catch (_) { /* the host routes */ } } }
  async function loadFeed(more) {
    var f = Object.assign({}, S.filters, S.sport ? { sport: S.sport } : {});
    var signedIn = S.status && S.status.signed_in;
    var page = signedIn ? await rpc('sc_feed', { p_filters: filtersToRpc(f), p_cursor: more && S.page ? S.page.next_cursor : null, p_limit: 25 }) : await rpc('sc_public_feed', { p_limit: 25 });
    if (more && S.page && page.items) page.items = S.page.items.concat(page.items);
    S.page = page;
  }
  async function load(force) {
    if (!S.host || S.loading) return;
    S.loading = true; if (!S.page || force) paint();
    try {
      if (!S.status || force) await loadStatus();
      if (S.landing) { S.landing = false; if (!landingKeeps(S.status)) { handoff(); return; } }
      if (S.status && S.status.deployed === false) return;
      if (S.view === 'feed') { S.pulse = await rpc('sc_pulse', { p_hours: S.hours }); await loadFeed(false); }
      else if (S.view === 'detail') S.detail = await rpc('sc_signal', { p_id: S.id });
      else if (S.view === 'dna') S.dna = await rpc('sc_model_dna_current', { p_sport: S.sport || null });
      else if (S.view === 'alerts' && S.status.signed_in) S.prefs = await rpc('sc_my_preferences', {});
      try { var n = S.status && S.status.signed_in ? await rpc('sc_unread_count', {}) : 0; var u = el('sc-unread'); if (u) u.textContent = n ? n + ' unread notice' + (n === 1 ? '' : 's') : ''; } catch (_) { /* the count is a convenience */ }
      S.error = null; S.stale = false;
    } catch (e) {
      if (S.landing) { S.landing = false; handoff(); return; }
      S.error = String(e && (e.message || e)).slice(0, 160); S.stale = !!(S.page || S.detail);
      if (!S.stale) body('<div class="sc-banner sc-warn">Signal Center could not be read: ' + esc(S.error) + '. Try the refresh button.</div>');
    } finally { S.loading = false; if (!S.error || S.stale) paint(); else paintStatus(); }
  }

  /* graphics: drawn in the page from the stored content, never from new numbers */
  var GFX_LIBS = ['/lib/edgedesk_signal_engine.js?v=20261024sc1', '/lib/edgedesk_signal_graphic.js?v=20261024sc1'];
  var gfxReady = null, engineReady = null;
  function script(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = function () { res(); }; s.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(s); }); }
  function loadEngine() {
    if (root.EDSignalEngine) return Promise.resolve(root.EDSignalEngine);
    if (!engineReady) engineReady = script(GFX_LIBS[0]).then(function () { return root.EDSignalEngine; }, function (e) { engineReady = null; throw e; });
    return engineReady;
  }
  function loadGfx() {
    if (root.EDSignalGraphic) return Promise.resolve(root.EDSignalGraphic);
    if (!gfxReady) gfxReady = loadEngine().then(function () { return script(GFX_LIBS[1]); }).then(function () { return root.EDSignalGraphic; }, function (e) { gfxReady = null; throw e; });
    return gfxReady;
  }
  /* Method prints the live scoring spec from the engine itself, so it waits for it */
  function methodBody() {
    if (!root.EDSignalEngine) loadEngine().then(function () { if (S.view === 'method') paint(); }).catch(function () { /* the prose stands without the table */ });
    return renderMethod(root.EDSignalEngine);
  }
  function drawInto(slot, content, format, stamp) {
    if (!slot) return;
    slot.innerHTML = '<div class="sc-empty">Drawing…</div>';
    loadGfx().then(function (SG) { return SG.render(content, format, { stamp: stamp || null }); }).then(function (r) {
      S.gfx = r;
      slot.innerHTML = '<img src="' + r.url + '" alt="' + esc(r.alt) + '" width="' + r.canvas.width + '" height="' + r.canvas.height + '" class="sc-gfx-img">';
    }).catch(function (e) { slot.innerHTML = '<div class="sc-banner sc-warn">The graphic could not be drawn here: ' + esc(e && e.message || e) + '</div>'; });
  }
  function afterDetail() {
    var d = S.detail;
    if (!d || !d.graphics) return;
    var cur = d.graphics.filter(function (g) { return g.current && g.status === 'READY' && g.content; });
    if (cur.length) drawInto(el('sc-gfx'), cur[0].content, cur[0].format, null);
    var h = el('sc-detail-h'); if (h && S.focusDetail) { try { h.focus(); } catch (_) {} S.focusDetail = false; }
    if (S.goto) { var t = el('sc-' + S.goto); if (t && t.scrollIntoView) t.scrollIntoView({ block: 'start' }); S.goto = null; }
  }
  function paintExamples() {
    var ex = S.page && S.page.examples;
    if (!ex || !ex.length || !S.host) return;
    Array.prototype.forEach.call(S.host.querySelectorAll('[data-sc-example]'), function (fig) { var x = ex[+fig.getAttribute('data-sc-example')]; if (x && x.content) drawInto(fig.querySelector('.sc-gfx-slot'), x.content, x.format || 'square', 'EXAMPLE'); });
  }
  function download() { var r = S.gfx; if (!r) return; var a = document.createElement('a'); a.href = r.url; a.download = r.file_name; document.body.appendChild(a); a.click(); a.remove(); }
  function share() {
    var r = S.gfx; if (!r) return;
    try {
      var file = r.blob && typeof File !== 'undefined' ? new File([r.blob], r.file_name, { type: 'image/png' }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'EdgeDesk Signal Center', text: 'EdgeDesk research. Research, not picks.' }).catch(function () {}); return; }
    } catch (_) { /* fall through */ }
    download();
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-sc-view],[data-sc-open],[data-sc-act],[data-sc-jump],[data-sc-fmt],[data-sc-version],[data-sc-admin],[data-sc-oldgfx]') : null;
    if (!t) return;
    if (t.hasAttribute('data-sc-view')) { S.view = t.getAttribute('data-sc-view'); S.sport = S.view === 'feed' ? S.sport : null; setHash(); render(); load(false); return; }
    if (t.hasAttribute('data-sc-open')) { S.view = 'detail'; S.id = +t.getAttribute('data-sc-open'); S.detail = null; S.goto = t.getAttribute('data-sc-goto') || null; S.focusDetail = true; try { location.hash = hashFor(S); } catch (_) { setHash(); } render(); load(false); return; }
    if (t.hasAttribute('data-sc-jump')) { ev.preventDefault(); var j = el(t.getAttribute('data-sc-jump')); if (j && j.scrollIntoView) j.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
    if (t.hasAttribute('data-sc-fmt')) {
      var gid = +t.getAttribute('data-sc-fmt'), g = (S.detail.graphics || []).filter(function (x) { return x.graphic_id === gid; })[0];
      Array.prototype.forEach.call(S.host.querySelectorAll('[data-sc-fmt]'), function (b) { b.classList.toggle('on', b === t); });
      if (g) drawInto(el('sc-gfx'), g.content, g.format, null); return;
    }
    if (t.hasAttribute('data-sc-oldgfx')) { var og = (S.detail.graphics || []).filter(function (x) { return x.graphic_id === +t.getAttribute('data-sc-oldgfx'); })[0]; if (og) { var slot = el('sc-gfx') || el('sc-version-view'); drawInto(slot, og.content, og.format, og.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'OUTDATED'); } return; }
    if (t.hasAttribute('data-sc-version')) {
      var vn = +t.getAttribute('data-sc-version');
      rpc('sc_signal_version', { p_id: S.id, p_version: vn }).then(function (x) { var b = el('sc-version-view'); if (b) b.innerHTML = x && x.found ? '<div class="sc-card"><b>Version ' + esc(x.version) + '</b> · ' + esc(x.reason) + ' · ' + esc(when(x.created_at)) + '<h4 class="sc-headline">' + esc(x.payload.headline) + '</h4><p>' + esc(x.payload.summary || '') + '</p><p class="sc-foot">' + esc((x.payload.evidence && x.payload.evidence.summary) || '') + '</p></div>' : '<div class="sc-empty">That version is not available.</div>'; }).catch(function () {});
      return;
    }
    if (t.hasAttribute('data-sc-admin')) {
      var a = t.getAttribute('data-sc-admin'), reason = null;
      if (a === 'withdraw' || a === 'hold') { reason = root.prompt ? root.prompt('Reason (kept in the audit trail):') : null; if (a === 'withdraw' && !reason) return; }
      rpc('sc_admin_act', { p_signal: S.id, p_action: a, p_reason: reason }).then(function (d) { S.detail = d; paint(); }).catch(function (e) { root.alert && root.alert('Refused: ' + (e.body || e.message)); });
      return;
    }
    var act = t.getAttribute('data-sc-act');
    if (act === 'refresh') { S.page = null; load(true); }
    else if (act === 'more') loadFeed(true).then(paint).catch(function (e) { S.error = e.message; S.stale = true; paint(); });
    else if (act === 'back') { S.view = 'feed'; S.detail = null; try { if (history.length > 1 && /^#signals\/s\//.test(location.hash)) { history.back(); return; } } catch (_) {} setHash(); render(); load(false); }
    else if (act === 'clear') { S.filters = { sort: 'recent', scope: 'active' }; S.sport = null; persist(); setHash(); S.page = null; render(); load(false); }
    else if (act === 'download') download();
    else if (act === 'share') share();
  }
  function onChange(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.hasAttribute('data-sc-pulse')) { S.hours = +t.value || 24; persist(); rpc('sc_pulse', { p_hours: S.hours }).then(function (p) { S.pulse = p; paint(); }).catch(function () {}); return; }
    if (t.hasAttribute('data-sc-filter')) {
      var k = t.getAttribute('data-sc-filter'), v = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'from' || k === 'to') v = v ? new Date(v + 'T00:00:00Z').toISOString() : '';
      if (k === 'sport') { S.sport = v || null; setHash(); }
      S.filters[k] = v || (k === 'sort' ? 'recent' : (k === 'scope' ? 'active' : ''));
      persist(); S.page = null; paint(); loadFeed(false).then(paint).catch(function (e) { S.error = e.message; S.stale = true; paint(); });
    }
  }
  function onSubmit(ev) {
    var f = ev.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-sc-prefs')) return;
    ev.preventDefault();
    var vals = function (name) { return Array.prototype.filter.call(f.querySelectorAll('input[name="' + name + '"]'), function (i) { return i.checked; }).map(function (i) { return i.value; }); };
    var p = { sports: vals('sports'), categories: vals('categories'), teams: String(f.querySelector('input[name="teams"]').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 60),
      min_label: f.querySelector('select[name="min_label"]').value, notify: !!f.querySelector('input[name="notify"]').checked };
    var msg = el('sc-prefs-msg');
    rpc('sc_save_preferences', { p: p }).then(function (r) { S.prefs = r; if (msg) msg.textContent = 'Saved.' + (r.notices_need_full_access ? ' Notices start with Full Access.' : ''); })
      .catch(function (e) { if (msg) msg.textContent = 'Not saved: ' + (e.body || e.message); });
  }
  /* the filter panels stay as the reader left them across repaints */
  function onToggle(ev) { var t = ev.target; if (!t || !t.classList) return; if (t.classList.contains('sc-filters')) S.filtersOpen = t.open; else if (t.classList.contains('sc-more')) S.moreOpen = t.open; }
  function onKey(ev) { if (ev.key === 'Escape' && S.view === 'detail') { var b = S.host.querySelector('[data-sc-act="back"]'); if (b) b.click(); } }

  /* open(host, { route }) — route from parseHash(location.hash) */
  function open(host, opts) {
    if (!host) return;
    opts = opts || {};
    if (S.host !== host) { S.host = host; host.addEventListener('click', onClick); host.addEventListener('change', onChange); host.addEventListener('submit', onSubmit); host.addEventListener('keydown', onKey); host.addEventListener('toggle', onToggle, true); }
    var r = opts.route || parseHash(root.location && root.location.hash) || { view: 'feed' };
    var changed = r.view !== S.view || (r.id || null) !== (S.id || null) || (r.sport || null) !== (S.sport || null);
    if (opts.landing) { S.landing = true; S.handoff = opts.onHandoff || null; }
    /* the same place again (a seat tap back, the hashchange after our own link):
       keep what is on screen and refresh it */
    if (!changed && !opts.force && !opts.landing && S.rendered && host.querySelector('#sc-body')) { load(false); return; }
    S.view = r.view || 'feed'; S.id = r.id || null; S.sport = r.sport || (S.view === 'feed' ? S.sport : null);
    if (S.view === 'detail' && changed) { S.detail = null; S.focusDetail = true; }
    if (S.view === 'feed' && changed) S.page = null;
    render(); load(!!opts.force);
  }
  return {
    open: open, parseHash: parseHash, hashFor: hashFor, filtersToRpc: filtersToRpc,
    /* pure, for tests */
    esc: esc, when: when, ago: ago, renderCard: renderCard, renderFeed: renderFeed, renderPulse: renderPulse, renderFilters: renderFilters, renderDetail: renderDetail,
    renderDna: renderDna, renderDnaList: renderDnaList, renderCoverage: renderCoverage, renderPrefs: renderPrefs, renderMethod: renderMethod, renderStatusBar: renderStatusBar, renderConsensus: renderConsensus,
    CAT: CAT, EVIDENCE: EVIDENCE, _state: function () { return S; }, _setRpc: function (f) { S.rpc = f; }
  };
});
