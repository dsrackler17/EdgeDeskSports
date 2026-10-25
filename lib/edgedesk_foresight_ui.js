/* ===========================================================================
   EDGEDESK MARKET FORESIGHT — the reader's renderers (pure; tested in Node
   by tools/foresight/ui.test.js). The browser shell is foresight/foresight.js.

   WHAT A CHART MAY SHOW, AND WHAT IT MAY NOT
     - an observed quote is a flat step from its first to its last
       observation of the same value; nothing is drawn between two values
       except a translucent band that says "it changed somewhere in here";
     - a coverage gap is a grey band labelled as such; no line crosses it;
     - a forecast is drawn from its publication onward, never before it;
     - every panel has one unit: line points OR one probability contract;
     - the readout at any instant says what each source showed, how old that
       observation was, or that the value is unknown there.
   Every value a tooltip shows is also in the event table.

   Browser: window.EDForesightUI. Node: require('./edgedesk_foresight_ui.js').
   ES5, no dependencies.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.EDForesightUI = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var U = { VERSION: 'edgedesk_foresight_ui/1' };
  var MIN = 60000;

  /* ================================================================ text */
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(t) { var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  U.esc = esc;

  var ETF = null, ETD = null, ETH = null;
  try {
    ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    ETD = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
    ETH = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
  } catch (_) { ETF = null; ETD = null; ETH = null; }
  /* the Eastern hour of an instant, 0-23 */
  U.etHour = function (t) { var x = ms(t); if (x === null) return null; return ETH ? (+ETH.format(new Date(x)).replace(/\D/g, '')) % 24 : new Date(x).getUTCHours(); };
  U.hourLabel = function (h) { return h === 0 ? '12 AM' : h < 12 ? h + ' AM' : h === 12 ? '12 PM' : (h - 12) + ' PM'; };
  U.time = function (t) { var x = ms(t); if (x === null) return '—'; return ETF ? ETF.format(new Date(x)) + ' ET' : new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
  U.day = function (t) { var x = ms(t); return x === null ? '' : (ETD ? ETD.format(new Date(x)) : new Date(x).toISOString().slice(5, 10)); };
  U.dur = function (minutes) {
    if (!isNum(minutes)) return '—';
    var m = Math.abs(Math.round(minutes)), sign = minutes < 0 ? '−' : '';
    if (m < 60) return sign + m + ' min';
    if (m < 48 * 60) { var h = Math.floor(m / 60), r = m % 60; return sign + h + ' h' + (r ? ' ' + r + ' min' : ''); }
    var d = Math.floor(m / 1440), hh = Math.round((m % 1440) / 60); return sign + d + ' d' + (hh ? ' ' + hh + ' h' : '');
  };
  function minus(x) { return String(x).replace(/^-/, '−'); }
  U.line = function (v) { if (!isNum(v)) return '—'; if (v === 0) return 'PK'; return (v > 0 ? '+' : '') + minus(String(Math.round(v * 100) / 100)); };
  U.pts = function (v) { return isNum(v) ? minus(String(Math.round(v * 100) / 100)) : '—'; };
  U.pct = function (p, dp) { return isNum(p) ? (p * 100).toFixed(dp === undefined ? 1 : dp) + '%' : '—'; };
  U.value = function (market, v) { return market === 'moneyline' ? U.pct(v) : (market === 'spread' ? U.line(v) : U.pts(v)); };
  /* a difference in the unit of its market: points, or probability points */
  U.delta = function (market, v) {
    if (!isNum(v)) return '—';
    if (market === 'moneyline') { var pp = Math.round(v * 1000) / 10; return (pp > 0 ? '+' : '') + minus(String(pp)) + ' pp'; }
    var x = Math.round(v * 100) / 100; return (x > 0 ? '+' : '') + minus(String(x)) + ' pts';
  };
  U.american = function (a) { return isNum(a) ? (a > 0 ? '+' + a : minus(String(a))) : '—'; };
  U.cents = function (p) { return isNum(p) ? Math.round(p * 100) + '¢' : '—'; };

  U.SOURCE = { edgedesk: 'EdgeDesk model', collective: 'Model Collective', collective_consensus: 'Collective consensus' };
  U.VENUE = { draftkings: 'DraftKings (via ESPN)', kalshi: 'Kalshi' };
  U.VENUE_SHORT = { draftkings: 'DraftKings', kalshi: 'Kalshi' };
  U.MARKET = { spread: 'Spread', total: 'Total', moneyline: 'Win probability' };
  U.AXIS = { spread: 'Home team’s line, points (negative = home favoured)', total: 'Total points line', moneyline: 'P(home team wins), full game incl. overtime' };
  U.SPORT = { nfl: 'NFL', cfb: 'College football' };
  U.CLASS = {
    TOWARD_HELD: 'Moved toward the forecast and held to the close', TOWARD_REVERSED: 'Moved toward the forecast, then reversed',
    NO_QUALIFYING_MOVE: 'No sustained move toward the forecast', MOVED_AWAY: 'Closed further from the forecast',
    NO_MATERIAL_DISAGREEMENT: 'Agreed with the market at publication'
  };
  U.EVIDENCE = { INSUFFICIENT_EVIDENCE: 'Insufficient evidence', THIN: 'Thin sample: no interval', OK: 'Interval shown' };
  U.QUOTE = { line: 'line', devig_fair: 'de-vigged fair probability (multiplicative, both sides)', kalshi_mid: 'YES mid (research reference, not executable)' };
  U.reason = function (code, reasons) {
    if (!code) return '';
    if (reasons && reasons[code]) return reasons[code];
    return String(code).replace(/_/g, ' ');
  };
  U.sourceStatus = function (s) {
    if (!s) return { cls: 'off', text: 'unknown' };
    if (s.status === 'connected') return { cls: 'ok', text: 'connected' };
    if (s.status === 'partial') return { cls: 'warn', text: 'partial' };
    if (s.status === 'error') return { cls: 'bad', text: 'unreadable this run' };
    return { cls: 'off', text: 'not connected' };
  };

  /* ================================================================ the status strip */
  U.statusHTML = function (st, now) {
    if (!st) return '';
    var nowMs = ms(now) || 0, out = [];
    var mode = st.mode === 'live' ? '<span class="mf-chip ok">Live</span>' : (st.mode === 'shadow' ? '<span class="mf-chip warn">In review (operators only)</span>' : '<span class="mf-chip off">Off</span>');
    out.push(mode);
    if (st.methodology) out.push('<a class="mf-chip" href="#method">Methodology ' + esc(st.methodology.version) + ' · ' + esc(String(st.methodology.sha256 || '').slice(0, 10)) + '</a>');
    if (st.last_run && st.last_run.finished_at) {
      var age = (nowMs - ms(st.last_run.finished_at)) / MIN;
      out.push('<span class="mf-chip' + (age > 180 ? ' warn' : '') + '">Last computed ' + esc(U.time(st.last_run.finished_at)) + ' (' + esc(U.dur(age)) + ' ago)' + (st.last_run.status === 'partial' ? ' · partial' : '') + '</span>');
    } else out.push('<span class="mf-chip off">Not computed yet</span>');
    var src = (st.last_run && st.last_run.sources) || {};
    ['draftkings', 'edgedesk', 'kalshi', 'collective'].forEach(function (k) {
      var s = U.sourceStatus(src[k]);
      var label = { draftkings: 'DraftKings', edgedesk: 'EdgeDesk forecasts', kalshi: 'Kalshi', collective: 'Model Collective' }[k];
      out.push('<span class="mf-chip ' + s.cls + '" title="' + esc(src[k] && src[k].reason || '') + '">' + esc(label) + ': ' + esc(s.text) + '</span>');
    });
    return '<div class="mf-chips">' + out.join('') + '</div>';
  };

  /* ================================================================ coverage and freshness */
  U.coverageHTML = function (cov) {
    if (!cov || !cov.length) return '<p class="mf-empty">No observations have been processed yet.</p>';
    var rows = cov.map(function (c) {
      var vc = c.valid_close || {};
      return '<tr><th scope="row">' + esc(U.SPORT[c.sport] || c.sport) + ' · ' + esc(U.VENUE_SHORT[c.venue] || c.venue) + ' ' + esc(U.MARKET[c.market] || c.market).toLowerCase() + '</th>'
        + '<td>' + esc(c.games) + '</td><td>' + esc(c.observations) + '</td>'
        + '<td>' + esc(U.time(c.last_at)) + '<br><small>' + esc(U.dur(c.latest_age_minutes)) + ' before the run</small></td>'
        + '<td>median ' + esc(U.dur(c.observed_cadence && c.observed_cadence.median_minutes)) + ' · 90th pct ' + esc(U.dur(c.observed_cadence && c.observed_cadence.p90_minutes)) + '<br><small>intended: ' + esc(c.intended || '—') + '</small></td>'
        + '<td>' + esc(c.gaps) + ' (' + esc(c.gap_hours) + ' h)</td>'
        + '<td>' + (vc.n ? esc(vc.k + ' of ' + vc.n) + ' <small>(' + esc(U.pct(vc.p, 0)) + ')</small>' : '—') + '</td></tr>';
    }).join('');
    return '<div class="mf-tw"><table class="tbl mf-tbl"><caption class="mf-vh">Coverage and freshness by sport, venue and market</caption><thead><tr><th scope="col">Series</th><th scope="col">Games</th><th scope="col">Observations</th>'
      + '<th scope="col">Latest observation</th><th scope="col">Observed cadence (between stored observations)</th><th scope="col">Coverage gaps</th><th scope="col">Valid close</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + '<p class="note">A coverage gap is a silence longer than the collector’s own rule allows (DraftKings: its heartbeat plus 90 minutes; Kalshi: 20 minutes). Nothing is carried across a gap. Historical records keep the timing they were collected with.</p>';
  };

  /* ================================================================ model observations */
  function ci(arr, f) { return arr ? ' <small>[' + esc(f(arr[0])) + ', ' + esc(f(arr[1])) + ']</small>' : ''; }
  U.modelLink = function (s, label) {
    return '<a href="?model=' + encodeURIComponent(s.source + ':' + s.model_key) + (s.model_version ? '&v=' + encodeURIComponent(s.model_version) : '') + '">' + esc(label || s.model_label || s.model_key) + '</a>';
  };
  U.summaryRowHTML = function (s, opts) {
    opts = opts || {};
    var d = function (x) { return U.delta(s.market, x); };
    var w = s.closer && s.closer.wilson;
    var ttm = s.time_to_move && s.time_to_move.preceded;
    return '<tr class="ev-' + esc(s.evidence) + '">'
      + (opts.noModel ? '' : '<th scope="row">' + U.modelLink(s) + '<br><small>' + esc(U.SOURCE[s.source] || s.source) + ' · ' + esc(s.model_version) + '</small></th>')
      + '<td>' + esc(U.SPORT[s.sport] || s.sport) + '<br><small>' + esc(U.MARKET[s.market]) + ' vs ' + esc(U.VENUE_SHORT[s.venue]) + (s.horizon_bucket && s.horizon_bucket !== 'all' ? ' · published ' + esc(s.horizon_bucket) + ' before' : '') + '</small></td>'
      + '<td>' + esc(s.measured) + ' <small>of ' + esc(s.units) + '</small>' + (s.no_material_disagreement ? '<br><small>' + esc(s.no_material_disagreement) + ' agreed at publication</small>' : '') + '</td>'
      + '<td>' + (s.closer && s.closer.n ? esc(s.closer.k + ' of ' + s.closer.n) + (w && s.closer.n >= 10 ? ' <small>[' + esc(U.pct(w.lo, 0)) + ', ' + esc(U.pct(w.hi, 0)) + ']</small>' : '') : '—') + '</td>'
      + '<td>' + esc(d(s.convergence && s.convergence.median)) + ci(s.convergence && s.convergence.median_ci, d) + '<br><small>mean ' + esc(d(s.convergence && s.convergence.mean)) + '</small></td>'
      + '<td>' + esc(d(s.directional && s.directional.mean)) + ci(s.directional && s.directional.mean_ci, d) + '</td>'
      + '<td>' + (s.qualifying && s.qualifying.n ? esc(s.qualifying.k + ' of ' + s.qualifying.n) : '—') + '<br><small>' + esc((s.precedence ? s.precedence.preceded : 0) + ' preceded · ' + (s.precedence ? s.precedence.unresolved : 0) + ' unresolved') + '</small></td>'
      + '<td>' + (ttm && ttm.n ? esc(U.dur(ttm.median_lower) + ' to ' + U.dur(ttm.median_upper)) + '<br><small>n = ' + esc(ttm.n) + ' preceded</small>' : '—') + '</td>'
      + '<td><small>' + esc('no move ' + s.rates.no_move.k + '/' + s.rates.no_move.n) + '<br>' + esc('reversed ' + s.rates.reversal.k + '/' + s.rates.reversal.n) + '<br>' + esc('moved away ' + s.rates.moved_away.k + '/' + s.rates.moved_away.n) + '</small></td>'
      + '<td><span class="mf-chip ' + (s.evidence === 'OK' ? 'ok' : (s.evidence === 'THIN' ? 'warn' : 'off')) + '">' + esc(U.EVIDENCE[s.evidence] || s.evidence) + '</span></td></tr>';
  };
  U.summaryTableHTML = function (rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return '<p class="mf-empty">' + esc(opts.empty || 'No measured forecasts match these filters yet.') + '</p>';
    return '<div class="mf-tw"><table class="tbl mf-tbl mf-sum"><caption class="mf-vh">' + esc(opts.caption || 'Model observations') + '</caption><thead><tr>'
      + (opts.noModel ? '' : '<th scope="col">Model</th>') + '<th scope="col">Sport · market</th><th scope="col">Measured</th><th scope="col">Closes closer to the forecast</th>'
      + '<th scope="col">Closing convergence (median)</th><th scope="col">Directional movement (mean)</th><th scope="col">Sustained move toward</th><th scope="col">Time to that move</th>'
      + '<th scope="col">Misses</th><th scope="col">Evidence</th></tr></thead><tbody>' + rows.map(function (s) { return U.summaryRowHTML(s, opts); }).join('') + '</tbody></table></div>';
  };

  /* combinations with nothing measured yet: listed with their counts and
     reasons, so nothing disappears silently */
  U.unmeasuredHTML = function (rows, reasons) {
    if (!rows || !rows.length) return '';
    return '<details class="mf-det"><summary>' + esc(rows.length) + ' model–market–venue combination' + (rows.length === 1 ? ' has' : 's have') + ' nothing measured yet — show them and why</summary><ul class="mf-list mf-small">'
      + rows.map(function (s) {
        var ex = Object.keys(s.exclusions || {}).sort(function (a, b) { return s.exclusions[b] - s.exclusions[a]; }).map(function (k) { return esc(U.reason(k, reasons).replace(/\.$/, '')) + ' (' + esc(s.exclusions[k]) + ')'; }).join('; ');
        return '<li><b>' + esc(s.model_label) + '</b> <small>' + esc(s.model_version) + '</small> · ' + esc(U.SPORT[s.sport] || s.sport) + ' · ' + esc(U.MARKET[s.market]) + ' vs ' + esc(U.VENUE_SHORT[s.venue]) + ': 0 of ' + esc(s.units) + ' measured — ' + (ex || 'no unit') + '</li>';
      }).join('') + '</ul></details>';
  };

  /* ================================================================ venue lead-lag */
  U.leadLagHTML = function (rows) {
    if (!rows || !rows.length) return '<p class="mf-empty">No venue timing has been computed yet.</p>';
    var all = rows.filter(function (r) { return r.bucket === 'all'; });
    var blocked = all.filter(function (r) { return r.blocked; });
    var html = '';
    if (blocked.length) {
      html += '<p class="mf-state warn">' + blocked.map(function (r) {
        return esc(U.SPORT[r.sport] || r.sport) + ': ' + esc(r.blocked) + ' game(s) not compared — ' + Object.keys(r.blocked_reasons).map(function (k) { return esc(String(k).replace(/_/g, ' ')) + ' (' + esc(r.blocked_reasons[k]) + ')'; }).join(', ');
      }).join('<br>') + '. Kalshi’s settlement rules are compared with DraftKings’ only after an operator verifies them.</p>';
    }
    var body = rows.filter(function (r) { return r.pairs || (r.moves && Object.keys(r.moves).length); }).map(function (r) {
      var lead = Object.keys(r.leaders || {}).sort().map(function (v) { return esc(U.VENUE_SHORT[v] || v) + ' ' + esc(r.leaders[v]); }).join(' · ') || '—';
      var um = Object.keys(r.unmatched || {}).sort().map(function (v) { return esc(U.VENUE_SHORT[v] || v) + ' ' + esc(r.unmatched[v]); }).join(' · ') || '0';
      var ic = Object.keys(r.insufficient_coverage || {}).sort().map(function (v) { return esc(U.VENUE_SHORT[v] || v) + ' ' + esc(r.insufficient_coverage[v]); }).join(' · ') || '0';
      return '<tr><th scope="row">' + esc(U.SPORT[r.sport] || r.sport) + ' · ' + esc(r.bucket === 'all' ? 'all times' : r.bucket + ' before start') + '</th>'
        + '<td>' + esc(r.pairs) + '</td><td>' + lead + '</td><td>' + esc(r.unresolved) + '</td><td>' + esc(r.ties) + '</td><td>' + um + '</td><td>' + ic + '</td>'
        + '<td>' + (r.label ? '<b>' + esc(U.VENUE_SHORT[r.label.venue] || r.label.venue) + '</b>: ' + esc(r.label.text) + ' <small>(' + esc(U.pct(r.label.share.p, 0)) + ' of ' + esc(r.label.resolved) + ' resolved pairs; 95% interval from ' + esc(U.pct(r.label.share.lo, 0)) + ')</small>'
          : '<small>No label: ' + esc(r.label_status === 'INSUFFICIENT_RESOLVED_PAIRS' ? 'fewer than the required resolved pairs' : 'no venue clears the bound') + '</small>') + '</td></tr>';
    }).join('');
    if (body) html += '<div class="mf-tw"><table class="tbl mf-tbl"><caption class="mf-vh">Venue lead–lag</caption><thead><tr><th scope="col">Segment</th><th scope="col">Paired moves</th><th scope="col">First observed</th><th scope="col">Unresolved (overlapping)</th><th scope="col">Ties</th><th scope="col">Unmatched</th><th scope="col">Insufficient coverage</th><th scope="col">Label</th></tr></thead><tbody>' + body + '</tbody></table></div>';
    else if (!blocked.length) html += '<p class="mf-empty">No paired venue moves yet.</p>';
    return html + '<p class="note">Temporal precedence between the two tracked venues only. Both may be reacting to a third source or to public news; an earlier move is not a better remaining price.</p>';
  };

  /* ================================================================ incremental information (T3) */
  U.incrementalHTML = function (rows) {
    if (!rows || !rows.length) return '<p class="mf-empty">Not computed yet.</p>';
    return '<ul class="mf-list">' + rows.map(function (r) {
      var k = String(r.key || '').split('|');
      return '<li><b>' + esc(U.SPORT[k[0]] || k[0]) + ' · ' + esc(U.MARKET[k[1]] || k[1]) + ' vs ' + esc(U.VENUE_SHORT[k[2]] || k[2]) + '</b> — '
        + (r.status === 'COMPUTED' ? esc(r.text) + ' <small>(holdout ' + esc(r.n_holdout) + ' units from ' + esc(U.day(r.holdout_from)) + '; difference ' + esc(r.mse_difference) + ', 95% ' + esc(r.ci ? '[' + r.ci[0] + ', ' + r.ci[1] + ']' : '—') + ')</small>'
          : '<span class="mf-chip off">Insufficient evidence</span> <small>(' + esc(r.n_train || 0) + ' training, ' + esc(r.n_holdout || 0) + ' holdout units)</small>') + '</li>';
    }).join('') + '</ul>';
  };

  /* ================================================================ games */
  U.gamesListHTML = function (items) {
    if (!items || !items.length) return '<p class="mf-empty">No games match these filters.</p>';
    return '<ul class="mf-games">' + items.map(function (g) {
      return '<li><a href="?game=' + encodeURIComponent(g.sport + ':' + g.event_id) + '"><b>' + esc(g.away) + ' at ' + esc(g.home) + '</b>'
        + '<span>' + esc(U.SPORT[g.sport] || g.sport) + ' · ' + esc(U.time(g.kickoff)) + '</span>'
        + '<span>' + esc(g.n_measured) + ' measured of ' + esc(g.n_units) + (g.has_kalshi ? ' · Kalshi' : '') + (g.state === 'VOID' ? ' · void' : '') + '</span></a></li>';
    }).join('') + '</ul>';
  };

  /* ================================================================ one unit's finding */
  U.findingText = function (f) {
    if (!f) return '';
    return String(f.template).replace(/\{([A-Za-z]+)\}/g, function (_, k) { var v = f.params && f.params[k]; return /^\d{4}-\d\d-\d\dT/.test(String(v)) ? U.time(v) : String(v === undefined ? '' : v); });
  };
  U.unitHTML = function (u, reasons) {
    var m = u.metrics || {}, mk = u.market;
    var head = '<div class="mf-uh"><b>' + esc(u.model_label) + '</b> <small>' + esc(U.SOURCE[u.source] || u.source) + ' · ' + esc(u.model_version) + '</small>'
      + '<span class="mf-chip">' + esc(U.MARKET[mk]) + ' vs ' + esc(U.VENUE_SHORT[u.venue]) + '</span></div>';
    if (u.status !== 'measured') {
      return '<li class="mf-unit ex" data-unit="' + esc(u.unit_key) + '">' + head + '<p>Not measured: ' + esc(U.reason(u.exclusion_reason, reasons)) + '.</p>'
        + (u.forecast_value !== null && u.forecast_value !== undefined ? '<p class="mf-k"><small>Forecast ' + esc(U.value(mk, u.forecast_value)) + ', published ' + esc(U.time(u.published_at)) + ' (' + esc(String(u.evidence || '').replace(/_/g, ' ')) + ')</small></p>' : '') + '</li>';
    }
    var hz = (m.horizons || []).map(function (h) { return h.status === 'measured' ? esc(U.dur(h.minutes)) + ': ' + esc(U.delta(mk, h.movement)) : esc(U.dur(h.minutes)) + ': ' + esc(String(h.status).replace(/_/g, ' ')); }).join(' · ');
    return '<li class="mf-unit" data-unit="' + esc(u.unit_key) + '"' + (m.move && m.move.lo ? ' data-lo="' + esc(m.move.lo) + '" data-hi="' + esc(m.move.hi) + '" data-market="' + esc(mk) + '"' : '') + '>' + head
      + '<p class="mf-find">' + esc(U.findingText(u.finding)) + '</p>'
      + '<dl class="mf-kv"><div><dt>Forecast F</dt><dd>' + esc(U.value(mk, m.F)) + '<small>' + esc(U.time(u.published_at)) + ' · ' + esc(String(u.evidence || '').replace(/_/g, ' ')) + '</small></dd></div>'
      + '<div><dt>Market at publication M0</dt><dd>' + esc(U.value(mk, m.M0)) + '<small>observed ' + esc(U.time(m.baseline && m.baseline.at)) + ' (' + esc(U.dur(m.baseline && m.baseline.age_minutes)) + ' earlier)</small></dd></div>'
      + '<div><dt>Close C</dt><dd>' + esc(U.value(mk, m.C)) + '<small>observed ' + esc(U.dur(m.close && m.close.minutes_before_kickoff)) + ' before kickoff</small></dd></div>'
      + '<div><dt>Disagreement F − M0</dt><dd>' + esc(U.delta(mk, m.disagreement)) + '</dd></div>'
      + '<div><dt>Closing convergence</dt><dd>' + esc(U.delta(mk, m.convergence)) + '<small>|M0 − F| − |C − F|</small></dd></div>'
      + '<div><dt>Directional movement</dt><dd>' + esc(m.directional === null ? '—' : U.delta(mk, m.directional)) + '<small>sign(F − M0) × (C − M0)</small></dd></div></dl>'
      + (hz ? '<p class="mf-k"><small>Fixed horizons after publication — ' + hz + '</small></p>' : '')
      + '<p class="mf-k"><small>' + esc(U.CLASS[m.cls] || m.cls) + (m.overshoot ? ' · the close went past the forecast' : '') + (m.move && m.move.lo ? ' · <button type="button" class="mf-show" data-show="' + esc(u.unit_key) + '">Show the move on the timeline</button>' : '') + '</small></p></li>';
  };

  /* ================================================================ the timeline panels */
  /* Panels for one game: one per market that has a venue series or a
     forecast. Each carries its series (segments and gaps as stored), the
     forecasts drawn on it (the first eligible forecast and its revisions,
     from publication on) and the kickoff. */
  U.panelsFor = function (game, units) {
    var K = ms(game.kickoff), out = [];
    ['spread', 'total', 'moneyline'].forEach(function (mk) {
      var series = [];
      ['draftkings', 'kalshi'].forEach(function (v) {
        var s = game.series && game.series[v + ':' + mk];
        if (s && s.segments) series.push({ venue: v, segments: s.segments, gaps: s.gaps || [], close: s.close || null, quote: v === 'kalshi' ? 'kalshi_mid' : (mk === 'moneyline' ? 'devig_fair' : 'line') });
      });
      var seen = {}, fc = [];
      /* A forecast whose publication time was reconstructed from git is never
         placed on a time axis: its time is not known well enough to draw. The
         consensus is drawn as its mean only (the median is in the tables). */
      (units || []).filter(function (u) {
        return u.market === mk && u.forecast_value !== null && u.forecast_value !== undefined
          && u.exclusion_reason !== 'publication_time_reconstructed' && !(u.source === 'collective_consensus' && u.model_version !== 'equal_weight_mean');
      }).forEach(function (u) {
        var k = u.source + '|' + u.model_key + '|' + u.model_version;
        if (seen[k]) return;
        seen[k] = true;
        var marks = [{ at: u.published_at, value: u.forecast_value, first: true, eligible: u.status === 'measured' || ['no_fresh_baseline', 'baseline_unpriced', 'no_valid_close', 'no_market_contract', 'settlement_unverified', 'settlement_mismatch'].indexOf(u.exclusion_reason) >= 0 }];
        (u.revisions || []).forEach(function (r) { if (r.value !== null && r.value !== undefined && r.evidence !== 'reconstructed_from_git') marks.push({ at: r.published_at, value: r.value, first: false }); });
        marks = marks.filter(function (x) { return ms(x.at) !== null && ms(x.at) < K; }).sort(function (a, b) { return ms(a.at) - ms(b.at); });
        if (marks.length) fc.push({ key: k, label: u.model_label, source: u.source, version: u.model_version, marks: marks, consensus: u.source === 'collective_consensus' });
      });
      if (series.length || fc.length) out.push({ market: mk, axis: U.AXIS[mk], kickoff: K, series: series, forecasts: fc });
    });
    return out;
  };

  /* what every source showed at instant t: observed (with age), changing
     (inside a change interval), no observations (a gap), not yet observed */
  U.stateAt = function (panel, t) {
    var rows = [];
    panel.series.forEach(function (s) {
      var segs = s.segments, st = null;
      for (var i = 0; i < segs.length; i++) {
        var a = ms(segs[i].first_at), b = ms(segs[i].last_at);
        if (t >= a && t <= b) { st = { kind: 'observed', seg: segs[i], age: 0 }; break; }
        var nx = segs[i + 1];
        if (t > b && nx && t < ms(nx.first_at)) {
          var inGap = (s.gaps || []).some(function (g) { return ms(g.from) <= b && ms(g.to) >= ms(nx.first_at) && !g.trailing; });
          if (inGap) st = { kind: 'gap', from: segs[i].last_at, to: nx.first_at };
          else if (segs[i].value !== nx.value || segs[i].flag !== nx.flag || JSON.stringify(segs[i].raw) !== JSON.stringify(nx.raw)) st = { kind: 'changing', from: segs[i].last_at, to: nx.first_at, before: segs[i], after: nx };
          else st = { kind: 'observed', seg: segs[i], age: (t - b) / MIN };
          break;
        }
        if (t > b && !nx) {
          var tg = (s.gaps || []).some(function (g) { return g.trailing; });
          st = tg ? { kind: 'gap', from: segs[i].last_at, to: null } : { kind: 'observed', seg: segs[i], age: (t - b) / MIN };
          break;
        }
      }
      if (!st) st = { kind: 'before_first' };
      rows.push({ venue: s.venue, quote: s.quote, state: st });
    });
    var fcs = panel.forecasts.map(function (f) {
      var cur = null;
      f.marks.forEach(function (m) { if (ms(m.at) <= t) cur = m; });
      return { label: f.label, version: f.version, source: f.source, mark: cur };
    });
    return { t: t, venues: rows, forecasts: fcs };
  };
  U.stateLines = function (panel, s) {
    var mk = panel.market, out = [U.time(s.t)];
    s.venues.forEach(function (r) {
      var st = r.state, name = U.VENUE_SHORT[r.venue];
      if (st.kind === 'observed') {
        var g = st.seg, raw = g.raw || {}, v;
        if (g.value === null || g.value === undefined) v = 'observed, no comparable value (' + String(g.flag || '').replace(/_/g, ' ') + ')';
        else v = U.value(mk, g.value);
        var extra = '';
        if (r.venue === 'kalshi') extra = ' · bid ' + U.cents(raw.yes_bid) + ' / ask ' + U.cents(raw.yes_ask) + (raw.last_price !== null && raw.last_price !== undefined ? ' · last ' + U.cents(raw.last_price) + ' (' + (raw.last_trade || 'unknown') + ')' : '') + (raw.depth === 'missing' ? ' · depth missing' : ' · size ' + raw.yes_bid_size + ' × ' + raw.yes_ask_size);
        else if (mk === 'moneyline') extra = ' · prices ' + U.american(raw.price_home) + ' / ' + U.american(raw.price_away);
        else if (mk === 'spread') extra = ' · prices ' + U.american(raw.price_home) + ' / ' + U.american(raw.price_away) + (g.contract && g.contract.p !== undefined ? ' · P(home covers ' + U.line(g.contract.threshold) + ') ' + U.pct(g.contract.p) : '');
        else if (mk === 'total') extra = ' · over ' + U.american(raw.price_over) + ' / under ' + U.american(raw.price_under) + (g.contract && g.contract.p !== undefined ? ' · P(over ' + U.pts(g.contract.threshold) + ') ' + U.pct(g.contract.p) : '');
        out.push(name + ': ' + v + extra + ' · ' + (st.age > 0 ? 'last observed ' + U.dur(st.age) + ' earlier' : 'observed') + ' (' + g.n + ' reading' + (g.n === 1 ? '' : 's') + ', ' + U.time(g.first_at) + ' – ' + U.time(g.last_at) + ')');
      } else if (st.kind === 'changing') {
        if (st.before.value === st.after.value) out.push(name + ': ' + U.value(mk, st.before.value) + ' at both readings; its prices changed somewhere between ' + U.time(st.from) + ' and ' + U.time(st.to));
        else out.push(name + ': changed from ' + U.value(mk, st.before.value) + ' to ' + U.value(mk, st.after.value) + ' somewhere between ' + U.time(st.from) + ' and ' + U.time(st.to) + ' — the value here is unknown');
      }
      else if (st.kind === 'gap') out.push(name + ': no observations (coverage gap' + (st.to ? ' until ' + U.time(st.to) : ' to kickoff') + ') — unknown');
      else out.push(name + ': not observed yet');
    });
    s.forecasts.forEach(function (f) {
      if (f.mark) out.push('Forecast · ' + f.label + ': ' + U.value(mk, f.mark.value) + ' (published ' + U.time(f.mark.at) + ')');
    });
    out.push('Timestamps are EdgeDesk’s collector observation times; no provider update time is recorded.');
    return out;
  };

  function niceStep(span, n) {
    var raw = span / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  U.COLORS = { draftkings: '#d95926', kalshi: '#199e70', forecast: '#3987e5' };
  var CLIP = 0;

  /* the panel's x and y domains: from the earliest drawn thing (never more
     than 8 days before kickoff) to just past kickoff */
  U.domain = function (panel) {
    var K = panel.kickoff, t0 = K, vals = [];
    panel.series.forEach(function (s) {
      s.segments.forEach(function (g) {
        t0 = Math.min(t0, ms(g.first_at));
        if (isNum(g.value)) vals.push(g.value);
        if (s.venue === 'kalshi' && g.raw) { if (isNum(g.raw.yes_bid)) vals.push(g.raw.yes_bid); if (isNum(g.raw.yes_ask)) vals.push(g.raw.yes_ask); }
      });
    });
    panel.forecasts.forEach(function (f) { f.marks.forEach(function (m) { t0 = Math.min(t0, ms(m.at)); if (isNum(m.value)) vals.push(m.value); }); });
    t0 = Math.max(t0, K - 8 * 86400000);
    var span = K - t0 || 3600000, t1 = K + Math.max(span * 0.02, 20 * MIN);
    var lo = vals.length ? Math.min.apply(null, vals) : 0, hi = vals.length ? Math.max.apply(null, vals) : 1;
    var pad = panel.market === 'moneyline' ? Math.max(0.02, (hi - lo) * 0.12) : Math.max(0.5, (hi - lo) * 0.12);
    lo -= pad; hi += pad;
    if (panel.market === 'moneyline') { lo = Math.max(0, lo); hi = Math.min(1, hi); }
    var step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    return { t0: t0, t1: t1, lo: lo, hi: hi, step: step };
  };

  /* the step plot (SVG string). Interaction is the shell's: the whole plot
     is the hit target and the readout is U.stateAt. */
  /* one panel's geometry, shared by the drawing and the shell's interaction */
  U.geometry = function (panel, opts) {
    opts = opts || {};
    var W = opts.width || 960, H = opts.height || 250, L = 58, R = 18, T = 14, B = 36;
    var d = U.domain(panel), pw = W - L - R, ph = H - T - B;
    return { W: W, H: H, L: L, R: R, T: T, B: B, pw: pw, ph: ph, d: d,
      x: function (t) { return L + (ms(t) - d.t0) / (d.t1 - d.t0) * pw; },
      y: function (v) { return T + (d.hi - v) / (d.hi - d.lo) * ph; },
      t: function (px) { return d.t0 + (px - L) / pw * (d.t1 - d.t0); } };
  };
  U.timelineSVG = function (panel, opts) {
    var G = U.geometry(panel, opts);
    var W = G.W, H = G.H, L = G.L, R = G.R, T = G.T, d = G.d, ph = G.ph;
    var x = G.x, y = G.y;
    var f2 = function (n) { return Math.round(n * 10) / 10; };
    var o = ['<svg class="mf-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(U.MARKET[panel.market] + ' timeline: ' + panel.axis + '. The event table below lists every observation and forecast.') + '">'];
    /* y grid and ticks */
    for (var v = d.lo; v <= d.hi + 1e-9; v += d.step) {
      o.push('<line class="mf-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + f2(y(v)) + '" y2="' + f2(y(v)) + '"/>');
      o.push('<text class="mf-tick" x="' + (L - 6) + '" y="' + f2(y(v) + 3.5) + '" text-anchor="end">' + esc(U.value(panel.market, Math.round(v * 1e6) / 1e6)) + '</text>');
    }
    /* x ticks on Eastern hours (midnight carries the date), at most ~9 */
    var spanH = (d.t1 - d.t0) / 3600000, stepH = spanH <= 12 ? 2 : spanH <= 36 ? 6 : spanH <= 96 ? 12 : 24;
    for (var t = Math.ceil(d.t0 / 3600000) * 3600000; t <= d.t1; t += 3600000) {
      var hh = U.etHour(t);
      if (hh % stepH !== 0) continue;
      o.push('<line class="mf-xt" x1="' + f2(x(t)) + '" x2="' + f2(x(t)) + '" y1="' + (T + ph) + '" y2="' + (T + ph + 4) + '"/>');
      o.push('<text class="mf-tick" x="' + f2(x(t)) + '" y="' + (T + ph + 16) + '" text-anchor="middle">' + esc(hh === 0 ? U.day(t) : U.hourLabel(hh)) + '</text>');
    }
    o.push('<line class="mf-ax" x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ph) + '" y2="' + (T + ph) + '"/>');
    /* every data mark stays inside the plot: a line that began before the
       window is cut at its edge, never drawn over the axis */
    var cid = 'mfc-' + panel.market + '-' + (++CLIP);
    o.push('<defs><clipPath id="' + cid + '"><rect x="' + L + '" y="' + (T - 6) + '" width="' + G.pw + '" height="' + (ph + 6) + '"/></clipPath></defs><g clip-path="url(#' + cid + ')">');
    /* gaps: unknown, a grey band, nothing crosses it */
    panel.series.forEach(function (s) {
      (s.gaps || []).forEach(function (g) {
        var a = Math.max(x(g.from), L), b = Math.min(x(g.to || panel.kickoff), W - R);
        if (b - a < 0.5) return;
        o.push('<rect class="mf-gap mf-gap-' + s.venue + '" x="' + f2(a) + '" y="' + T + '" width="' + f2(b - a) + '" height="' + ph + '"><title>' + esc(U.VENUE_SHORT[s.venue] + ': no observations for ' + U.dur(g.minutes) + ' (expected within ' + U.dur(g.expected_max_minutes) + ')') + '</title></rect>');
        if (b - a > 70) o.push('<text class="mf-gapt" x="' + f2((a + b) / 2) + '" y="' + (T + 11) + '" text-anchor="middle">' + esc(U.VENUE_SHORT[s.venue]) + ' gap</text>');
      });
    });
    /* each venue: change bands, then steps */
    panel.series.forEach(function (s) {
      var col = U.COLORS[s.venue], segs = s.segments;
      var gapBetween = function (a, b) { return (s.gaps || []).some(function (g) { return !g.trailing && ms(g.from) <= a && ms(g.to) >= b; }); };
      for (var i = 0; i + 1 < segs.length; i++) {
        var A = segs[i], Bn = segs[i + 1];
        if (!isNum(A.value) || !isNum(Bn.value) || A.value === Bn.value || gapBetween(ms(A.last_at), ms(Bn.first_at))) continue;
        var x1 = x(A.last_at), x2 = Math.max(x(Bn.first_at), x1 + 1.5), y1 = y(Math.max(A.value, Bn.value)), y2 = y(Math.min(A.value, Bn.value));
        o.push('<rect class="mf-chg" fill="' + col + '" x="' + f2(x1) + '" y="' + f2(y1) + '" width="' + f2(x2 - x1) + '" height="' + f2(Math.max(y2 - y1, 1.5)) + '"><title>' + esc(U.VENUE_SHORT[s.venue] + ' changed from ' + U.value(panel.market, A.value) + ' to ' + U.value(panel.market, Bn.value) + ' somewhere between ' + U.time(A.last_at) + ' and ' + U.time(Bn.first_at)) + '</title></rect>');
      }
      segs.forEach(function (g) {
        var a = x(g.first_at), b = Math.max(x(g.last_at), a + 1.5);
        if (s.venue === 'kalshi' && g.raw && isNum(g.raw.yes_bid) && isNum(g.raw.yes_ask) && g.raw.yes_bid > 0 && g.raw.yes_ask < 1) {
          o.push('<rect class="mf-band" fill="' + col + '" x="' + f2(a) + '" y="' + f2(y(g.raw.yes_ask)) + '" width="' + f2(b - a) + '" height="' + f2(Math.max(y(g.raw.yes_bid) - y(g.raw.yes_ask), 1)) + '"/>');
        }
        if (!isNum(g.value)) {
          o.push('<text class="mf-unpriced" x="' + f2((a + b) / 2) + '" y="' + (T + ph - 4) + '" text-anchor="middle" fill="' + col + '">×<title>' + esc(U.VENUE_SHORT[s.venue] + ': observed without a comparable value (' + String(g.flag || '').replace(/_/g, ' ') + ')') + '</title></text>');
          return;
        }
        o.push('<line class="mf-step" stroke="' + col + '" x1="' + f2(a) + '" x2="' + f2(b) + '" y1="' + f2(y(g.value)) + '" y2="' + f2(y(g.value)) + '"/>');
        if (g.n === 1 && b - a < 3) o.push('<circle class="mf-obs" fill="' + col + '" cx="' + f2(a) + '" cy="' + f2(y(g.value)) + '" r="2.5"/>');
      });
      if (s.close && s.close.ok && isNum(s.close.value)) o.push('<circle class="mf-close" stroke="' + col + '" cx="' + f2(x(s.close.at)) + '" cy="' + f2(y(s.close.value)) + '" r="4.5"><title>' + esc(U.VENUE_SHORT[s.venue] + ' close: ' + U.value(panel.market, s.close.value) + ', observed ' + U.dur(s.close.minutes_before_kickoff) + ' before kickoff') + '</title></circle>');
    });
    /* the move highlight layer (filled by the shell when a finding is selected) */
    o.push('<g class="mf-hl"></g>');
    /* forecasts: from publication on, never before */
    var placed = [];
    /* a label that would sit on top of another is left to the legend and the readout */
    var free = function (lx, ly) { return !placed.some(function (p) { return Math.abs(p[0] - lx) < 14 && Math.abs(p[1] - ly) < 12; }); };
    panel.forecasts.forEach(function (f, i) {
      var col = U.COLORS.forecast, ms_ = f.marks;
      ms_.forEach(function (m, j) {
        var a = x(m.at), b = x(j + 1 < ms_.length ? ms_[j + 1].at : panel.kickoff), yy = y(m.value);
        o.push('<line class="mf-fline" stroke="' + col + '" x1="' + f2(a) + '" x2="' + f2(b) + '" y1="' + f2(yy) + '" y2="' + f2(yy) + '"/>');
        var s = 5;
        o.push('<path class="mf-fmark' + (f.consensus ? ' hollow' : '') + (m.first ? '' : ' rev') + '" fill="' + (f.consensus ? 'none' : col) + '" stroke="' + (f.consensus ? col : 'var(--surface)') + '" d="M' + f2(a) + ' ' + f2(yy - s) + 'L' + f2(a + s) + ' ' + f2(yy) + 'L' + f2(a) + ' ' + f2(yy + s) + 'L' + f2(a - s) + ' ' + f2(yy) + 'Z"><title>' + esc((m.first ? 'Forecast published' : 'Revision (shown, not measured)') + ' · ' + f.label + ': ' + U.value(panel.market, m.value) + ' at ' + U.time(m.at)) + '</title></path>');
        if (m.first && free(a + 7, yy - 7)) { placed.push([a + 7, yy - 7]); o.push('<text class="mf-flabel" x="' + f2(a + 7) + '" y="' + f2(yy - 7) + '">' + esc(String(i + 1)) + '</text>'); }
      });
    });
    o.push('</g>');
    /* kickoff */
    o.push('<line class="mf-kick" x1="' + f2(x(panel.kickoff)) + '" x2="' + f2(x(panel.kickoff)) + '" y1="' + T + '" y2="' + (T + ph) + '"/>');
    o.push('<text class="mf-tick mf-kickt" x="' + f2(x(panel.kickoff) - 4) + '" y="' + (T + ph + 28) + '" text-anchor="end">kickoff ▸</text>');
    o.push('<line class="mf-cross" x1="0" x2="0" y1="' + T + '" y2="' + (T + ph) + '" visibility="hidden"/>');
    o.push('</svg>');
    return o.join('');
  };
  U.legendHTML = function (panel) {
    var items = panel.series.map(function (s) {
      return '<span class="mf-lg"><i class="ln" style="background:' + U.COLORS[s.venue] + '"></i>' + esc(U.VENUE_SHORT[s.venue]) + ' · ' + esc(U.QUOTE[s.quote]) + (s.venue === 'kalshi' ? ' (band: bid–ask)' : '') + '</span>';
    });
    panel.forecasts.forEach(function (f, i) {
      items.push('<span class="mf-lg"><i class="dm' + (f.consensus ? ' hollow' : '') + '"></i>' + esc(String(i + 1)) + ' · ' + esc(f.label) + ' <small>' + esc(f.version) + '</small></span>');
    });
    items.push('<span class="mf-lg"><i class="chg"></i>changed somewhere in this interval</span>', '<span class="mf-lg"><i class="gp"></i>no observations (gap)</span>');
    return '<div class="mf-legend">' + items.join('') + '</div>';
  };

  /* the accessible alternative: every observation segment and forecast, in time order */
  U.eventTableHTML = function (game, panels) {
    var rows = [];
    panels.forEach(function (p) {
      p.series.forEach(function (s) {
        s.segments.forEach(function (g) {
          var raw = g.raw || {}, rawTxt;
          if (s.venue === 'kalshi') rawTxt = 'bid ' + U.cents(raw.yes_bid) + ' · ask ' + U.cents(raw.yes_ask) + ' · last ' + U.cents(raw.last_price) + (raw.last_trade ? ' (' + raw.last_trade + ')' : '') + ' · vol ' + (raw.volume === null || raw.volume === undefined ? '—' : raw.volume);
          else if (p.market === 'total') rawTxt = 'over ' + U.american(raw.price_over) + ' · under ' + U.american(raw.price_under);
          else rawTxt = U.american(raw.price_home) + ' / ' + U.american(raw.price_away);
          rows.push({ t: ms(g.first_at), cells: [U.time(g.first_at) + (g.n > 1 ? ' – ' + U.time(g.last_at) : ''), U.VENUE_SHORT[s.venue], U.MARKET[p.market], isNum(g.value) ? U.value(p.market, g.value) : 'no comparable value (' + String(g.flag || '').replace(/_/g, ' ') + ')',
            rawTxt, U.QUOTE[s.quote], g.n + ' reading' + (g.n === 1 ? '' : 's') + ' · collector observation time'] });
        });
        (s.gaps || []).forEach(function (g) { rows.push({ t: ms(g.from), cells: [U.time(g.from) + ' – ' + (g.to ? U.time(g.to) : 'kickoff'), U.VENUE_SHORT[s.venue], U.MARKET[p.market], 'no observations (' + U.dur(g.minutes) + ')', '—', 'coverage gap', 'expected within ' + U.dur(g.expected_max_minutes)] }); });
      });
      p.forecasts.forEach(function (f) {
        f.marks.forEach(function (m) { rows.push({ t: ms(m.at), cells: [U.time(m.at), f.label + ' (' + f.version + ')', U.MARKET[p.market], U.value(p.market, m.value), '—', m.first ? 'forecast (first eligible is measured)' : 'revision (shown, not measured)', 'publication time'] }); });
      });
    });
    rows.sort(function (a, b) { return a.t - b.t; });
    return '<div class="mf-tw"><table class="tbl mf-tbl mf-events"><caption>Every observation and forecast for ' + esc(game.away + ' at ' + game.home) + ', in time order (Eastern)</caption><thead><tr><th scope="col">When</th><th scope="col">Source</th><th scope="col">Market</th><th scope="col">Normalized value</th><th scope="col">Raw</th><th scope="col">Quote type</th><th scope="col">Timestamp</th></tr></thead><tbody>'
      + rows.map(function (r) { return '<tr>' + r.cells.map(function (c, i) { return i === 0 ? '<th scope="row">' + esc(c) + '</th>' : '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  };

  /* ================================================================ the model page */
  U.modelUnitsHTML = function (units, reasons) {
    if (!units || !units.length) return '<p class="mf-empty">No units yet.</p>';
    return '<div class="mf-tw"><table class="tbl mf-tbl"><caption class="mf-vh">Complete record</caption><thead><tr><th scope="col">Game</th><th scope="col">Market</th><th scope="col">Published</th><th scope="col">F</th><th scope="col">M0</th><th scope="col">C</th><th scope="col">Convergence</th><th scope="col">Outcome</th></tr></thead><tbody>'
      + units.map(function (u) {
        var m = u.metrics || {}, mk = u.market;
        return '<tr' + (u.status === 'measured' ? '' : ' class="ex"') + '><th scope="row"><a href="?game=' + encodeURIComponent(u.sport + ':' + u.event_id) + '">' + esc(u.away + ' at ' + u.home) + '</a><br><small>' + esc(U.time(u.kickoff)) + '</small></th>'
          + '<td>' + esc(U.MARKET[mk]) + '<br><small>vs ' + esc(U.VENUE_SHORT[u.venue]) + '</small></td><td><small>' + esc(U.time(u.published_at)) + '<br>' + esc(String(u.evidence || '').replace(/_/g, ' ')) + '</small></td>'
          + '<td>' + esc(U.value(mk, u.forecast_value)) + '</td><td>' + esc(u.status === 'measured' ? U.value(mk, m.M0) : '—') + '</td><td>' + esc(u.status === 'measured' ? U.value(mk, m.C) : '—') + '</td>'
          + '<td>' + esc(u.status === 'measured' ? U.delta(mk, m.convergence) : '—') + '</td>'
          + '<td><small>' + (u.status === 'measured' ? esc(U.CLASS[m.cls] || m.cls) + (m.move && m.move.precedence ? ' · ' + esc(m.move.precedence === 'PRECEDED' ? 'forecast preceded the observed move' : 'timing unresolved') : '') : 'Not measured: ' + esc(U.reason(u.exclusion_reason, reasons))) + '</small></td></tr>';
      }).join('') + '</tbody></table></div>';
  };
  U.embedSnippet = function (source, modelKey) {
    return '<div id="edgedesk-foresight"></div>\n<script src="https://edgedesksports.com/foresight/embed.js" data-source="' + esc(source) + '" data-model="' + esc(modelKey) + '" async></script>';
  };

  return U;
});
