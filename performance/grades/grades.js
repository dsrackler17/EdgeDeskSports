/* ===========================================================================
   /performance/grades/ — EdgeDesk Grade Performance.

   Reads only public, committed files: /performance/data/grades/summary.json
   and the per-sport game files it lists (started games only: the grade locked
   before kickoff and its settled outcome). Every figure is computed in the
   browser by lib/edgedesk_research_grade.js (EDGRADE.performance), the same
   code the hourly job used to build the summary, so a filter can never print
   a number the record does not support. No account, no database, no price.

   Charts are hand-drawn SVG in one hue (the site's validated chart blue,
   #3987e5, on EdgeDesk's dark surface): one measure per chart, one axis, and
   small multiples instead of five colours for five grades. Every mark has a
   hover and focus tooltip and every chart a table twin.
   =========================================================================== */
(function () {
  'use strict';
  var G = window.EDGRADE, P = window.EDPERF;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = '/performance/data/grades/';
  var LETTERS = ['A', 'B', 'C', 'D', 'F'];
  var INS = 'INSUFFICIENT';
  var S = { summary: null, rows: [], f: { sport: 'all', league: 'all', season: 'all', from: '', to: '', model: 'all', grade_version: 'all', market: 'all' }, loaded: false };
  var SPORT = { nfl: 'NFL', cfb: 'College football', nba: 'NBA', nhl: 'NHL', wnba: 'WNBA', ncaab_m: 'Men’s college basketball', ncaab_w: 'Women’s college basketball' };
  var STATE_LABEL = { TOO_EARLY: 'Too early to read', EARLY_SIGNAL: 'Early signal', DEVELOPING: 'Developing', MEANINGFUL: 'Meaningful sample' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function f(v, d) { return v == null || !isFinite(v) ? null : Number(v).toFixed(d == null ? 1 : d); }
  function pct(v) { return v == null ? null : (v * 100).toFixed(1) + '%'; }
  function day(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  function when(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function letterName(l) { return l === INS ? 'Not graded' : l; }
  function chip(state) { return state ? '<span class="gp-chip ' + esc(state) + '" title="' + esc(STATE_LABEL[state] || state) + '">' + esc(STATE_LABEL[state] || state) + '</span>' : ''; }
  function tile(k, v, s, dim) { return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (dim ? ' dim' : '') + '">' + v + '</div><div class="s">' + (s || '') + '</div></div>'; }
  function need(n) { return 'n=' + n + ' · needs ' + G.MIN_N + ' to print'; }
  function lbadge(l) { return '<span class="edg-badge edg-l-' + (l === INS ? 'INS' : l) + '"><b>' + (l === INS ? '—' : esc(l)) + '</b></span>'; }

  /* ----------------------------------------------------------- the marks */
  /* a column with a 4px rounded data end, square at the baseline */
  function column(x, y, w, base) {
    var h = base - y;
    if (h <= 0) return '';
    var r = Math.min(4, h, w / 2);
    return 'M' + x + ' ' + base + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + base + 'Z';
  }
  function tipAttr(text) { return ' tabindex="0" data-tip="' + esc(text) + '" aria-label="' + esc(text) + '"'; }
  function tableTwin(caption, head, rows) {
    return '<details class="gp-twin"><summary>Table view</summary><div class="tblwrap"><table class="tbl"><caption class="gp-vh">' + esc(caption) + '</caption><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="n"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div></details>';
  }
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  /* ------------------------------------------------- distribution & volume */
  function distSVG(dist) {
    var cats = LETTERS.concat([INS]), vals = cats.map(function (k) { return dist[k] || 0; });
    var total = vals.reduce(function (s, v) { return s + v; }, 0);
    if (!total) return '<h3 class="gp-ch">Grade distribution</h3><div class="gp-empty">No started game in this selection carried a research grade yet. Grades are locked hourly before kickoff; this chart fills as games are played.</div>';
    var W = 360, H = 220, L = 34, R = 10, T = 22, B = 34, iw = W - L - R, ih = H - T - B, mx = niceMax(Math.max.apply(null, vals));
    var band = iw / cats.length, bw = Math.min(24, band * 0.6);
    var y = function (v) { return T + ih - v / mx * ih; };
    var s = '<h3 class="gp-ch">Started games by grade at kickoff <small>n=' + total + '</small></h3><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Started games by research grade at kickoff">';
    [0, 0.5, 1].forEach(function (g) { var yy = y(mx * g); s += '<line class="gp-grid" x1="' + L + '" x2="' + (L + iw) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + Math.round(mx * g) + '</text>'; });
    cats.forEach(function (k, i) {
      var cx = L + band * i + band / 2, v = vals[i];
      if (v) s += '<path class="gp-bar" d="' + column(cx - bw / 2, y(v), bw, T + ih) + '"' + tipAttr(letterName(k) + ': ' + v + ' game' + (v === 1 ? '' : 's') + ' (' + Math.round(v / total * 100) + '%)') + '/>';
      s += '<text class="gp-val" x="' + cx + '" y="' + (y(v) - 6) + '" text-anchor="middle">' + v + '</text>';
      s += '<text x="' + cx + '" y="' + (H - 14) + '" text-anchor="middle">' + esc(k === INS ? 'None' : k) + '</text>';
    });
    s += '<line class="gp-ax" x1="' + L + '" x2="' + (L + iw) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '"/></svg>';
    return s + tableTwin('Started games by grade', ['Grade', 'Games', 'Share'], cats.map(function (k, i) { return [letterName(k), String(vals[i]), Math.round(vals[i] / total * 100) + '%']; }));
  }
  function volumeSVG(trend) {
    var t = (trend || []).filter(function (w) { return w.games; });
    if (!t.length) return '<h3 class="gp-ch">Graded games per week</h3><div class="gp-empty">No graded week yet.</div>';
    var vals = t.map(function (w) { return w.games - (w.counts[INS] || 0); });
    var W = 360, H = 220, L = 34, R = 10, T = 22, B = 34, iw = W - L - R, ih = H - T - B, mx = niceMax(Math.max.apply(null, vals.concat([1])));
    var band = iw / t.length, bw = Math.min(24, band * 0.6);
    var y = function (v) { return T + ih - v / mx * ih; };
    var s = '<h3 class="gp-ch">Graded games per week <small>' + esc(t[0].period) + ' to ' + esc(t[t.length - 1].period) + '</small></h3><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Graded games per week">';
    [0, 0.5, 1].forEach(function (g) { var yy = y(mx * g); s += '<line class="gp-grid" x1="' + L + '" x2="' + (L + iw) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + Math.round(mx * g) + '</text>'; });
    var step = Math.ceil(t.length / 6);
    t.forEach(function (w, i) {
      var cx = L + band * i + band / 2;
      if (vals[i]) s += '<path class="gp-bar" d="' + column(cx - bw / 2, y(vals[i]), bw, T + ih) + '"' + tipAttr(w.period + ': ' + vals[i] + ' graded game' + (vals[i] === 1 ? '' : 's') + ', ' + w.settled + ' settled') + '/>';
      if (i % step === 0 || i === t.length - 1) s += '<text x="' + cx + '" y="' + (H - 14) + '" text-anchor="middle">' + esc(String(w.period).replace(/^\d{4}-/, '')) + '</text>';
    });
    var li = t.length - 1;
    s += '<text class="gp-val" x="' + (L + band * li + band / 2) + '" y="' + (y(vals[li]) - 6) + '" text-anchor="middle">' + vals[li] + '</text>';
    s += '<line class="gp-ax" x1="' + L + '" x2="' + (L + iw) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '"/></svg>';
    return s + tableTwin('Graded games per week', ['Week', 'Graded', 'Settled'], t.map(function (w, i) { return [w.period, String(vals[i]), String(w.settled)]; }));
  }

  /* ---------------------------------------------- accuracy by grade (dots) */
  function dotSVG(title, perf, get, opts) {
    opts = opts || {};
    var pts = LETTERS.map(function (l) { var ci = get(perf.by_letter[l]); return { l: l, ci: ci }; });
    var shown = pts.filter(function (p) { return p.ci && p.ci.mean != null; });
    var hiv = shown.map(function (p) { return p.ci.high != null ? p.ci.high : p.ci.mean; });
    var mx = opts.max || niceMax(Math.max.apply(null, hiv.concat([opts.ref || 0, 0.0001])) * 1.1);
    var W = 300, H = 210, L = 40, R = 10, T = 14, B = 44, iw = W - L - R, ih = H - T - B;
    var y = function (v) { return T + ih - Math.min(v, mx) / mx * ih; };
    var band = iw / LETTERS.length;
    var s = '<h3 class="gp-ch">' + esc(title) + '</h3><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(title + ' by research grade') + '">';
    [0, 0.5, 1].forEach(function (g) { var yy = y(mx * g); s += '<line class="gp-grid" x1="' + L + '" x2="' + (L + iw) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + f(mx * g, opts.dp == null ? 1 : opts.dp) + '</text>'; });
    if (opts.ref != null) s += '<line class="gp-ref" x1="' + L + '" x2="' + (L + iw) + '" y1="' + y(opts.ref) + '" y2="' + y(opts.ref) + '"/><text x="' + (L + iw) + '" y="' + (y(opts.ref) - 4) + '" text-anchor="end">' + esc(opts.refLabel || '') + '</text>';
    pts.forEach(function (p, i) {
      var cx = L + band * i + band / 2, n = p.ci ? p.ci.n : 0;
      if (p.ci && p.ci.mean != null) {
        if (p.ci.low != null) s += '<line class="gp-ci" x1="' + cx + '" x2="' + cx + '" y1="' + y(p.ci.low) + '" y2="' + y(p.ci.high) + '"/>';
        s += '<circle class="gp-dot" cx="' + cx + '" cy="' + y(p.ci.mean) + '" r="5"' + tipAttr('Grade ' + p.l + ': ' + f(p.ci.mean, opts.dp == null ? 2 : opts.dp) + (p.ci.low != null ? ' (95% interval ' + f(p.ci.low, opts.dp == null ? 2 : opts.dp) + ' to ' + f(p.ci.high, opts.dp == null ? 2 : opts.dp) + ')' : ' (interval from 50 games)') + ', n=' + n) + '/>';
      }
      s += '<text x="' + cx + '" y="' + (H - 26) + '" text-anchor="middle" class="gp-cat">' + p.l + '</text><text x="' + cx + '" y="' + (H - 12) + '" text-anchor="middle">n=' + n + '</text>';
    });
    s += '</svg>';
    if (!shown.length) s += '<p class="gp-empty">Too few settled games for any grade (' + G.MIN_N + ' needed to print).</p>';
    return s + tableTwin(title + ' by grade', ['Grade', 'Average', '95% low', '95% high', 'n'], pts.map(function (p) { var c = p.ci || {}; return [p.l, c.mean == null ? 'too few' : f(c.mean, opts.dp == null ? 2 : opts.dp), c.low == null ? '—' : f(c.low, opts.dp == null ? 2 : opts.dp), c.high == null ? '—' : f(c.high, opts.dp == null ? 2 : opts.dp), String(c.n || 0)]; }));
  }

  /* ------------------------------------------------ calibration multiples */
  function calPanel(l, m) {
    var W = 200, H = 200, L = 30, R = 8, T = 10, B = 28, iw = W - L - R, ih = H - T - B;
    var x = function (p) { return L + p * iw; }, y = function (p) { return T + (1 - p) * ih; };
    var w = m && m.winner, b = w && w.calibration || [];
    var h = '<figure class="gp-panel"><figcaption>' + lbadge(l) + ' <span>Grade ' + l + '</span> <small>n=' + (w ? w.scored : 0) + '</small></figcaption>';
    if (!b.length) return h + '<div class="gp-empty sm">Too few settled games to draw (' + G.MIN_N + ' needed).</div></figure>';
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Calibration for grade ' + l + '">';
    [0, 0.5, 1].forEach(function (g) { s += '<line class="gp-grid" x1="' + x(0) + '" x2="' + x(1) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text x="' + (L - 4) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + Math.round(g * 100) + '</text><text x="' + x(g) + '" y="' + (H - 12) + '" text-anchor="middle">' + Math.round(g * 100) + '</text>'; });
    s += '<line class="gp-diag" x1="' + x(0) + '" y1="' + y(0) + '" x2="' + x(1) + '" y2="' + y(1) + '"/>';
    b.forEach(function (k) {
      if (k.wilson_low != null) s += '<line class="gp-ci" x1="' + x(k.mean_predicted) + '" x2="' + x(k.mean_predicted) + '" y1="' + y(k.wilson_low) + '" y2="' + y(k.wilson_high) + '"/>';
      s += '<circle class="gp-dot" cx="' + x(k.mean_predicted) + '" cy="' + y(k.observed) + '" r="' + Math.max(4, Math.min(8, Math.sqrt(k.n))).toFixed(1) + '"' + tipAttr('Grade ' + l + ', ' + Math.round(k.from * 100) + '–' + Math.round(k.to * 100) + '%: said ' + pct(k.mean_predicted) + ', happened ' + pct(k.observed) + ' (n=' + k.n + ')') + '/>';
    });
    return h + s + '</svg></figure>';
  }
  function calHTML(perf) {
    return LETTERS.map(function (l) { return calPanel(l, perf.by_letter[l].metrics); }).join('')
      + '<p class="note gp-axisnote">Across: EdgeDesk’s home win probability (%). Up: how often the home side won (%). Dot size grows with the games in the group.</p>';
  }

  /* --------------------------------------------------- trend multiples */
  function trendHTML(trend) {
    var t = trend || [];
    return LETTERS.map(function (l) {
      var vals = t.map(function (w) { return w.cum_brier ? w.cum_brier[l] : null; });
      var n = t.length ? (t[t.length - 1].cum_n || {})[l] || 0 : 0;
      var h = '<figure class="gp-panel"><figcaption>' + lbadge(l) + ' <span>Grade ' + l + '</span> <small>n=' + n + '</small></figcaption>';
      if (!vals.some(function (v) { return v != null; })) return h + '<div class="gp-empty sm">The line starts at ' + G.MIN_N + ' settled games.</div></figure>';
      var W = 200, H = 140, L = 34, R = 8, T = 10, B = 24, iw = W - L - R, ih = H - T - B, lo = 0.1, hi = 0.3;
      var xc = function (i) { return L + (t.length === 1 ? iw / 2 : i * iw / (t.length - 1)); }, y = function (v) { return T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * ih; };
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative Brier score, grade ' + l + '">';
      [lo, 0.2, hi].forEach(function (g) { s += '<line class="gp-grid" x1="' + L + '" x2="' + (L + iw) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text x="' + (L - 4) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g.toFixed(2) + '</text>'; });
      s += '<line class="gp-ref" x1="' + L + '" x2="' + (L + iw) + '" y1="' + y(0.25) + '" y2="' + y(0.25) + '"/>';
      var d = '', on = false, last = null;
      vals.forEach(function (v, i) { if (v == null) { on = false; return; } d += (on ? 'L' : 'M') + xc(i).toFixed(1) + ' ' + y(v).toFixed(1); on = true; last = i; });
      s += '<path class="gp-line" d="' + d + '"/>';
      if (last != null) s += '<circle class="gp-dot" cx="' + xc(last) + '" cy="' + y(vals[last]) + '" r="4"' + tipAttr('Grade ' + l + ', through ' + t[last].period + ': cumulative Brier ' + f(vals[last], 3)) + '/>';
      s += '<text x="' + L + '" y="' + (H - 6) + '">' + esc(String(t[0].period).replace(/^\d{4}-/, '')) + '</text><text x="' + (L + iw) + '" y="' + (H - 6) + '" text-anchor="end">' + esc(String(t[t.length - 1].period).replace(/^\d{4}-/, '')) + '</text>';
      return h + s + '</svg></figure>';
    }).join('') + '<p class="note gp-axisnote">The flat line is 0.250, the score of always saying 50%. Lower is better.</p>';
  }

  /* -------------------------------------------------------- the big table */
  function rec(p) {
    if (!p || !p.n) return '<span class="dimt">none saved</span>';
    return p.w + '-' + p.l + (p.p ? '-' + p.p : '') + (p.pct != null ? ' · ' + pct(p.pct) : ' <span class="dimt">(' + (p.w + p.l) + ' decided)</span>');
  }
  function ciText(ci, dp) {
    if (!ci || ci.mean == null) return '<span class="dimt">' + (ci && ci.n ? need(ci.n) : 'none') + '</span>';
    return f(ci.mean, dp) + (ci.low != null ? ' <span class="dimt">(' + f(ci.low, dp) + '–' + f(ci.high, dp) + ')</span>' : ' <span class="dimt">n=' + ci.n + '</span>');
  }
  function cmpTable(perf) {
    var head = ['Grade', 'Settled games', 'Average score', 'Brier (95% interval)', 'Calibration', 'Margin MAE / RMSE', 'Total MAE / RMSE', 'Model agreement', 'Data completeness', 'Against the spread', 'Over/under', 'CLV', 'Sample'];
    var rows = LETTERS.concat([INS]).map(function (l) {
      var b = perf.by_letter[l], m = b.metrics, W = m.winner;
      var cal = W.calibration && W.calibration.length ? W.calibration.filter(function (k) { return k.inside_interval; }).length + ' of ' + W.calibration.length + ' groups inside' : '<span class="dimt">' + (W.scored ? need(W.scored) : 'none') + '</span>';
      var mm = m.margin.mae != null ? f(m.margin.mae) + ' / ' + f(m.margin.rmse) : '<span class="dimt">' + (m.margin.n ? need(m.margin.n) : 'none') + '</span>';
      var tm = m.total.mae != null ? f(m.total.mae) + ' / ' + f(m.total.rmse) : '<span class="dimt">' + (m.total.n ? need(m.total.n) : 'none') + '</span>';
      var clv = m.clv.spread.n ? (m.clv.spread.avg_pts != null ? (m.clv.spread.avg_pts > 0 ? '+' : '') + f(m.clv.spread.avg_pts, 2) + ' pts' : '<span class="dimt">n=' + m.clv.spread.n + '</span>') : '<span class="dimt">not measured</span>';
      return '<tr><th scope="row">' + lbadge(l) + ' <span class="gp-rl">' + esc(letterName(l)) + '</span></th><td class="n">' + b.settled + ' <span class="dimt">of ' + b.games + '</span></td><td class="n">' + (b.avg_score == null ? '—' : f(b.avg_score)) + '</td><td class="n">' + ciText(b.brier_ci, 3) + '</td><td>' + cal + '</td><td class="n">' + mm + '</td><td class="n">' + tm + '</td>'
        + '<td class="n">' + (b.avg_dimensions.market == null ? '—' : f(b.avg_dimensions.market, 0)) + ' <span class="dimt">· line on ' + b.market_n + '</span></td><td class="n">' + (b.avg_dimensions.completeness == null ? '—' : f(b.avg_dimensions.completeness, 0)) + '</td>'
        + '<td class="n">' + rec(m.picks.spread[0]) + '</td><td class="n">' + rec(m.picks.total[0]) + '</td><td class="n">' + clv + '</td><td>' + chip(b.sample_state) + '</td></tr>';
    }).join('');
    return '<caption class="gp-vh">Performance of the forecasts behind each research grade</caption><thead><tr>' + head.map(function (h) { return '<th scope="col">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody>';
  }
  function orderText(perf) {
    var o = perf.ordering, ev = o.pairs.filter(function (p) { return p.brier.evidence || p.margin_mae.evidence; });
    var s = '<b>Do higher grades perform better?</b> ' + esc(o.statement);
    if (ev.length) s += ' ' + ev.map(function (p) { return esc(p.higher + ' vs ' + p.lower + ': Brier ' + (p.brier.diff == null ? 'n/a' : (p.brier.diff > 0 ? p.higher + ' lower by ' : p.lower + ' lower by ') + f(Math.abs(p.brier.diff), 3) + ' (95% ' + f(p.brier.low, 3) + ' to ' + f(p.brier.high, 3) + ')')); }).join('; ') + '.';
    return s;
  }
  function sportsTable(rows) {
    var by = {};
    rows.forEach(function (x) { (by[x.sport] = by[x.sport] || []).push(x); });
    var ids = Object.keys(by).sort();
    if (!ids.length) return '<tbody><tr><td>No started game with a research grade in this selection yet.</td></tr></tbody>';
    var h = '<thead><tr><th>Sport</th><th>Grade</th><th>Settled</th><th>Brier</th><th>Margin MAE</th><th>Total MAE</th><th>Sample</th></tr></thead><tbody>';
    ids.forEach(function (id) {
      var perf = G.performance(by[id]);
      LETTERS.concat([INS]).forEach(function (l) {
        var b = perf.by_letter[l];
        if (!b.games) return;
        var m = b.metrics;
        h += '<tr><td>' + esc(SPORT[id] || id) + '</td><td>' + lbadge(l) + '</td><td class="n">' + b.settled + ' <span class="dimt">of ' + b.games + '</span></td><td class="n">' + (m.winner.brier != null ? f(m.winner.brier, 3) : '<span class="dimt">' + need(m.winner.scored) + '</span>') + '</td><td class="n">' + (m.margin.mae != null ? f(m.margin.mae) : '<span class="dimt">n=' + m.margin.n + '</span>') + '</td><td class="n">' + (m.total.mae != null ? f(m.total.mae) : '<span class="dimt">n=' + m.total.n + '</span>') + '</td><td>' + chip(b.sample_state) + '</td></tr>';
      });
    });
    return h + '</tbody>';
  }

  /* --------------------------------------------------------------- render */
  function filtered() {
    var fr = /^\d{4}-\d{2}-\d{2}$/.test(S.f.from) ? S.f.from + 'T00:00:00Z' : null, to = /^\d{4}-\d{2}-\d{2}$/.test(S.f.to) ? new Date(Date.parse(S.f.to + 'T00:00:00Z') + 86400e3).toISOString() : null;
    return G.filterRows(S.rows, { sport: S.f.sport, league: S.f.league, season: S.f.season, model: S.f.model, grade_version: S.f.grade_version, market: S.f.market, from: fr, to: to });
  }
  function filteredTiles(perf, rows) {
    var t = perf.totals;
    /* every lettered game together (the per-grade split is the table below) */
    var M = P ? P.metrics(rows.filter(function (x) { return x.letter !== INS; }).map(G.asPerfRow)) : null;
    var h = tile('Games in this selection', String(t.games), t.graded + ' graded · ' + t.ungraded + ' not graded');
    h += tile('Settled graded games', String(t.settled_graded), chip(t.sample_state) + (t.void ? ' · ' + t.void + ' void' : '') + (t.unsettled ? ' · ' + t.unsettled + ' awaiting a final' : ''));
    if (M) {
      h += M.winner.brier != null ? tile('Brier, all graded', f(M.winner.brier, 3), 'n=' + M.winner.scored + ' · 0.250 = coin flip') : tile('Brier, all graded', 'Insufficient data', need(M.winner.scored || 0), true);
      h += M.margin.mae != null ? tile('Margin MAE, all graded', f(M.margin.mae) + ' pts', 'n=' + M.margin.n + ' · RMSE ' + f(M.margin.rmse)) : tile('Margin MAE, all graded', 'Insufficient data', need(M.margin.n), true);
    }
    return h;
  }
  function render() {
    if (!S.loaded) return;
    var rows = filtered(), perf = G.performance(rows);
    $('gp-filtered').innerHTML = filteredTiles(perf, rows);
    $('gp-dist').innerHTML = distSVG(perf.distribution);
    $('gp-vol').innerHTML = volumeSVG(perf.trend);
    $('gp-cmp').innerHTML = cmpTable(perf);
    $('gp-order').innerHTML = orderText(perf);
    $('gp-brier').innerHTML = dotSVG('Brier score', perf, function (b) { return b.brier_ci; }, { dp: 3, max: 0.3, ref: 0.25, refLabel: 'coin flip 0.250' });
    $('gp-mae').innerHTML = dotSVG('Margin error (MAE, points)', perf, function (b) { return b.margin_mae_ci; }, { dp: 1 });
    $('gp-tmae').innerHTML = dotSVG('Total error (MAE, points)', perf, function (b) { return b.total_mae_ci; }, { dp: 1 });
    $('gp-cal').innerHTML = calHTML(perf);
    $('gp-trend').innerHTML = trendHTML(perf.trend);
    $('gp-sports').innerHTML = '<caption class="gp-vh">Settled games, Brier score and margin error by sport and grade</caption>' + sportsTable(rows);
  }
  function renderStatic(s) {
    var o = s.overall.totals, ep = s.ledger && s.ledger.epoch;
    var st = $('gp-status');
    var eligible = (s.coverage || []).reduce(function (a, c) { return a + c.eligible_games; }, 0), withGrade = (s.coverage || []).reduce(function (a, c) { return a + c.with_pregame_grade; }, 0);
    if (s.insufficient) {
      st.className = 'gp-status warn';
      st.innerHTML = '<b>Insufficient Historical Data.</b> ' + (ep ? 'EdgeDesk began locking research grades before kickoff on ' + esc(day(ep)) + '. ' : 'The grade ledger has not locked its first grade yet. ')
        + o.settled_graded + ' completed game' + (o.settled_graded === 1 ? ' has' : 's have') + ' a settled pregame grade so far; figures appear once ' + G.MIN_N + ' stand behind them, and an interval from 50. Until then, no grade is claimed to predict anything. Games played before the ledger began have no pregame grade and are never given one afterwards.';
    } else {
      st.className = 'gp-status';
      st.innerHTML = '<b>' + o.settled_graded + ' completed games with a settled pregame grade</b>' + (s.evaluation_period ? ', ' + esc(day(s.evaluation_period.from)) + ' to ' + esc(day(s.evaluation_period.to)) : '') + '. Updated ' + esc(when(s.generated_at)) + '. ' + esc(s.overall.ordering.statement);
    }
    var d = s.overall.distribution;
    $('gp-headline').innerHTML = tile('Total eligible games', String(eligible), 'started games forecast since the grade ledger began')
      + tile('Historically graded games', String(o.settled_graded), 'settled, with a grade locked before kickoff · ' + chip(o.sample_state))
      + tile('Grade distribution', LETTERS.map(function (l) { return l + ' ' + (d[l] || 0); }).join(' · '), (d[INS] || 0) + ' not graded · at kickoff')
      + tile('Research data coverage', eligible ? Math.round(withGrade / eligible * 100) + '%' : '—', withGrade + ' of ' + eligible + ' eligible games had a pregame grade · ' + o.graded + ' with a letter')
      + tile('Evaluation period', s.evaluation_period ? esc(day(s.evaluation_period.from)) + ' – ' + esc(day(s.evaluation_period.to)) : 'None yet', ep ? 'grade ledger since ' + esc(day(ep)) + ' · ' + (s.ledger.snapshots || 0) + ' grade revisions locked' : 'no grades locked yet', !s.evaluation_period);
    var F = s.filters || {};
    var opt = function (id, all, list, lab) { $(id).innerHTML = '<option value="all">' + esc(all) + '</option>' + (list || []).map(function (v) { var val = typeof v === 'object' ? v.id : v; return '<option value="' + esc(val) + '">' + esc(lab ? lab(v) : typeof v === 'object' ? v.label : v) + '</option>'; }).join(''); };
    opt('gp-sport', 'All sports', F.sports, function (v) { return SPORT[v] || v; });
    opt('gp-league', 'All leagues', F.leagues);
    opt('gp-season', 'All seasons', F.seasons);
    opt('gp-model', 'All model versions', F.models);
    opt('gp-gver', 'All grade versions', F.grade_versions);
    opt('gp-market', 'All market types', F.markets);
    $('gp-coverage').innerHTML = '<caption class="gp-vh">Grade coverage by sport</caption><thead><tr><th>Sport</th><th>Eligible games</th><th>Pregame grade</th><th>Lettered</th><th>Not graded</th><th>Settled</th><th>Void</th><th>Awaiting</th></tr></thead><tbody>'
      + ((s.coverage || []).length ? s.coverage.map(function (c) { return '<tr><td>' + esc(SPORT[c.sport] || c.sport) + '</td><td class="n">' + c.eligible_games + '</td><td class="n">' + c.with_pregame_grade + '</td><td class="n">' + c.graded + '</td><td class="n">' + c.ungraded + '</td><td class="n">' + c.settled + '</td><td class="n">' + c.void + '</td><td class="n">' + c.awaiting + '</td></tr>'; }).join('')
        : '<tr><td colspan="8">No started game since the grade ledger began yet.</td></tr>') + '</tbody>';
    var x = s.exclusions || {};
    var whys = Object.keys(x.by_why || {}).map(function (k) { return k.replace(/^VOID_/, 'void: ').toLowerCase().replace(/_/g, ' ') + ' ' + x.by_why[k]; });
    $('gp-excl').innerHTML = '<li><b>' + (x.no_pregame_grade || 0) + '</b> completed game' + (x.no_pregame_grade === 1 ? '' : 's') + ' had no grade locked before kickoff. ' + esc(x.no_pregame_grade_note || '') + '</li>'
      + '<li><b>' + (x.void || 0) + '</b> void (canceled, forfeited or postponed past 14 days): never counted as a hit or a miss' + (whys.length ? ' (' + esc(whys.join(', ')) + ')' : '') + '.</li>'
      + '<li><b>' + (x.result_conflicts || 0) + '</b> game' + (x.result_conflicts === 1 ? '' : 's') + ' whose result sources disagree, and <b>' + (x.missing_finals || 0) + '</b> still waiting on a verified final: nothing is settled until the sources agree.</li>';
    $('gp-rules').innerHTML = (s.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('');
    $('gp-letters').innerHTML = LETTERS.concat([INS]).map(function (l) { return '<dt>' + lbadge(l) + '</dt><dd>' + esc((s.letters || {})[l] || '') + '</dd>'; }).join('');
  }

  /* ------------------------------------------------------------- tooltip */
  function tooltips() {
    var tip = document.createElement('div');
    tip.className = 'gp-tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
    document.body.appendChild(tip);
    var cur = null;
    function show(el, x, y) {
      if (cur && cur !== el) cur.classList.remove('on');
      cur = el;
      tip.textContent = el.getAttribute('data-tip');
      tip.hidden = false;
      var r = tip.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      tip.style.left = Math.max(8, Math.min(vw - r.width - 8, x - r.width / 2)) + 'px';
      tip.style.top = Math.max(8, y - r.height - 12) + 'px';
      el.classList.add('on');
    }
    /* only the element that owns the tooltip hides it: leaving a hovered mark never hides one keyboard focus has since claimed */
    function hide(el) { if (el) el.classList.remove('on'); if (el !== cur) return; tip.hidden = true; cur = null; }
    document.addEventListener('pointerover', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) show(el, e.clientX, e.clientY); });
    document.addEventListener('pointermove', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el && !tip.hidden) show(el, e.clientX, e.clientY); });
    document.addEventListener('pointerout', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) hide(el); });
    document.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (!el) return; var r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
    document.addEventListener('focusout', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) hide(el); });
  }

  /* --------------------------------------------------------------- events */
  function wire() {
    [['gp-sport', 'sport'], ['gp-league', 'league'], ['gp-season', 'season'], ['gp-model', 'model'], ['gp-gver', 'grade_version'], ['gp-market', 'market']].forEach(function (p) {
      $(p[0]).addEventListener('change', function (e) { S.f[p[1]] = e.target.value; render(); });
    });
    [['gp-from', 'from'], ['gp-to', 'to']].forEach(function (p) { $(p[0]).addEventListener('input', function (e) { S.f[p[1]] = e.target.value.trim(); render(); }); });
    tooltips();
  }
  function getJson(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); }); }
  function boot() {
    if (!G) { $('gp-status').textContent = 'The grade record could not load (the research grade library is missing).'; return; }
    wire();
    getJson(BASE + 'summary.json').then(function (s) {
      S.summary = s;
      renderStatic(s);
      var files = (s.games || []).map(function (g) { return getJson(g.path).then(function (d) { return d.rows || []; }).catch(function () { return []; }); });
      return Promise.all(files).then(function (parts) {
        S.rows = [].concat.apply([], parts);
        S.loaded = true;
        render();
      });
    }).catch(function (e) {
      $('gp-status').className = 'gp-status warn';
      $('gp-status').textContent = 'The grade record could not load right now (' + (e && e.message || 'network') + '). Nothing is shown rather than a stale or partial record.';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
