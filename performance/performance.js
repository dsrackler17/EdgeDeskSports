/* ===========================================================================
   /performance/ — the public model performance page.

   Reads only public, committed files: /performance/data/summary.json and the
   per-sport game files it lists. Every figure is computed in the browser by
   lib/edgedesk_performance.js (EDPERF), the same code the hourly job used to
   build the summary, so a filter can never print a number the record does
   not support. No account, no database, no price.
   =========================================================================== */
(function () {
  'use strict';
  var P = window.EDPERF;
  var $ = function (id) { return document.getElementById(id); };
  var BASE = '/performance/data/';
  var PAGE_SIZE = 50;
  var S = { summary: null, rows: [], tier: 'VERIFIED', sport: 'all', model: 'all', type: 'all', from: '', to: '', q: '', page: 0, open: null, loaded: false };
  var LABEL = {};

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pct(v) { return v == null ? null : (v * 100).toFixed(1) + '%'; }
  function f(v, d) { return v == null || !isFinite(v) ? null : Number(v).toFixed(d == null ? 1 : d); }
  function sgn(v, d) { if (v == null || !isFinite(v)) return '—'; var s = Number(v).toFixed(d == null ? 1 : d); return v > 0 ? '+' + s : s; }
  function chip(state) { return state ? '<span class="pf-chip ' + esc(state) + '" title="' + esc(P.STATE_LABEL[state] || state) + '">' + esc(P.STATE_LABEL[state] || state) + '</span>' : ''; }
  function tierChip(t) { return '<span class="pf-chip ' + esc(t) + '">' + (t === 'VERIFIED' ? 'Verified' : 'Recorded') + '</span>'; }
  function when(iso) { if (!iso) return '—'; var d = new Date(iso); if (isNaN(d)) return '—'; return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function day(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  function tile(k, v, s, dim) { return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v' + (dim ? ' dim' : '') + '">' + v + '</div><div class="s">' + (s || '') + '</div></div>'; }
  function need(n) { return 'n=' + n + ' · needs ' + P.MIN_N + ' to print'; }
  function sportName(id) { return LABEL[id] || String(id || '').toUpperCase(); }
  function lineText(home, hl) { if (hl == null) return null; var v = Math.round(hl * 10) / 10; return v === 0 ? 'Pick’em' : home + ' ' + (v > 0 ? '+' : '') + v.toFixed(1); }

  /* --------------------------------------------------------------- tiles */
  function tilesFor(m, label) {
    var W = m.winner, h = '';
    h += tile(label || 'Graded games', String(m.eligibility.graded), m.eligibility.games + ' on record · ' + m.eligibility.void + ' void · ' + m.eligibility.flagged_pregame + ' flagged pregame' + (m.eligibility.awaiting_result ? ' · ' + m.eligibility.awaiting_result + ' awaiting a final' : ''));
    h += W.pct != null ? tile('Right winner', pct(W.pct), W.correct + ' of ' + W.called + ' ' + chip(W.sample_state)) : tile('Right winner', 'Insufficient data', W.called ? W.correct + ' of ' + W.called + ' · ' + need(W.called) : 'no win probabilities graded yet', true);
    h += W.brier != null ? tile('Brier score', f(W.brier, 3), 'n=' + W.scored + ' · lower is better · 0.250 = coin flip') : tile('Brier score', 'Insufficient data', need(W.scored || 0), true);
    h += W.log_loss != null ? tile('Log loss', f(W.log_loss, 3), 'n=' + W.scored + ' · 0.693 = coin flip') : tile('Log loss', 'Insufficient data', need(W.scored || 0), true);
    h += m.margin.mae != null ? tile('Margin error (MAE)', f(m.margin.mae) + ' pts', 'n=' + m.margin.n + ' · bias ' + sgn(m.margin.bias) + ' ' + chip(m.margin.sample_state)) : tile('Margin error (MAE)', 'Insufficient data', need(m.margin.n), true);
    h += m.total.mae != null ? tile('Total error (MAE)', f(m.total.mae) + ' pts', 'n=' + m.total.n + ' · bias ' + sgn(m.total.bias) + ' ' + chip(m.total.sample_state)) : tile('Total error (MAE)', 'Insufficient data', need(m.total.n), true);
    return h;
  }

  /* --------------------------------------------------------------- charts */
  function calibrationSVG(b) {
    if (!b || !b.length) return '<div class="pf-empty">Not enough graded win probabilities to draw a calibration chart (' + P.MIN_N + ' needed).</div>';
    var W = 360, H = 260, L = 42, R = 12, T = 12, B = 34, iw = W - L - R, ih = H - T - B;
    var x = function (p) { return L + p * iw; }, y = function (p) { return T + (1 - p) * ih; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Calibration: forecast probability against how often the home side won">';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (g) { s += '<line class="grid" x1="' + x(0) + '" x2="' + x(1) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + Math.round(g * 100) + '</text><text x="' + x(g) + '" y="' + (H - 16) + '" text-anchor="middle">' + Math.round(g * 100) + '</text>'; });
    s += '<line class="diag" x1="' + x(0) + '" y1="' + y(0) + '" x2="' + x(1) + '" y2="' + y(1) + '"/>';
    s += '<text x="' + (L + iw / 2) + '" y="' + (H - 2) + '" text-anchor="middle">EdgeDesk said (home win %)</text>';
    b.forEach(function (k) {
      if (k.wilson_low != null) s += '<line class="ci" x1="' + x(k.mean_predicted) + '" x2="' + x(k.mean_predicted) + '" y1="' + y(k.wilson_low) + '" y2="' + y(k.wilson_high) + '"/>';
      var rad = Math.max(3, Math.min(9, Math.sqrt(k.n)));
      s += '<circle class="ed" cx="' + x(k.mean_predicted) + '" cy="' + y(k.observed) + '" r="' + rad.toFixed(1) + '"><title>' + esc(Math.round(k.from * 100) + '–' + Math.round(k.to * 100) + '%: said ' + pct(k.mean_predicted) + ', happened ' + pct(k.observed) + ' (n=' + k.n + ')') + '</title></circle>';
    });
    return s + '</svg><p class="note">Vertical axis: how often the home side actually won. Dot size grows with the number of games.</p>';
  }
  function trendSVG(t) {
    if (!t || !t.length) return '<div class="pf-empty">No graded weeks yet.</div>';
    var W = 720, H = 220, L = 42, R = 46, T = 14, B = 30, iw = W - L - R, ih = H - T - B;
    var n = t.length, bw = Math.max(2, iw / n * 0.6), maxN = Math.max.apply(null, t.map(function (x) { return x.n; })) || 1;
    var xc = function (i) { return L + (n === 1 ? iw / 2 : i * iw / (n - 1)); };
    var acc = t.map(function (x) { return x.cum_pct; }), mae = t.map(function (x) { return x.cum_margin_mae; });
    var maxM = Math.max.apply(null, mae.filter(function (v) { return v != null; }).concat([1]));
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cumulative right-winner rate and margin error by week, with each week\'s graded games">';
    [0, 0.5, 1].forEach(function (g) { var yy = T + (1 - g) * ih; s += '<line class="grid" x1="' + L + '" x2="' + (L + iw) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (L - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + Math.round(g * 100) + '%</text><text x="' + (L + iw + 6) + '" y="' + (yy + 4) + '">' + (maxM * g).toFixed(0) + '</text>'; });
    t.forEach(function (x, i) { var h = x.n / maxN * ih * 0.45; s += '<rect class="bar" x="' + (xc(i) - bw / 2) + '" y="' + (T + ih - h) + '" width="' + bw + '" height="' + h + '"><title>' + esc(x.period + ': ' + x.n + ' graded') + '</title></rect>'; });
    var path = function (vals, scale, cls) {
      var d = '', on = false;
      vals.forEach(function (v, i) { if (v == null) { on = false; return; } var yy = T + (1 - v / scale) * ih; d += (on ? 'L' : 'M') + xc(i).toFixed(1) + ' ' + yy.toFixed(1); on = true; });
      return d ? '<path class="' + cls + '" d="' + d + '" fill="none" stroke-width="2"/>' : '';
    };
    s += path(acc, 1, 'ln-ed') + path(mae, maxM, 'ln-mkt');
    var step = Math.ceil(n / 8);
    t.forEach(function (x, i) { if (i % step === 0 || i === n - 1) s += '<text x="' + xc(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(x.period.replace(/^\d{4}-/, '')) + '</text>'; });
    s += '</svg><div class="pf-legend"><span><i style="background:#3987e5"></i>Right winner, cumulative (left axis)</span><span><i style="background:#d95926"></i>Margin error, cumulative, points (right axis)</span><span><i style="background:var(--surface2);border:1px solid var(--border2)"></i>Graded games that week</span></div>';
    return s;
  }

  /* --------------------------------------------------------------- market */
  function pickTable(list, what) {
    var rows = list.map(function (p) {
      return '<tr><td>' + (p.min_gap ? p.min_gap + '+ pts' : 'Any gap') + '</td><td class="n">' + p.n + '</td><td class="n">' + p.w + '-' + p.l + (p.p ? '-' + p.p : '') + '</td><td class="n">' + (p.pct != null ? pct(p.pct) : '<span class="dimt">' + need(p.w + p.l) + '</span>') + '</td><td class="n">' + (p.priced ? p.priced + ' priced · ' + (p.units > 0 ? '+' : '') + f(p.units, 2) + 'u' + (p.roi != null ? ' · ROI ' + pct(p.roi) : '') : '<span class="dimt">no captured price</span>') + '</td><td>' + chip(p.sample_state) + '</td></tr>';
    }).join('');
    return '<div class="tblwrap"><table class="tbl"><caption class="pf-vh">' + esc(what) + ' at the captured market line</caption><thead><tr><th>Disagreement</th><th>Games</th><th>W-L-P</th><th>Win rate</th><th>At the captured price</th><th>Sample</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function marketHTML(m) {
    var M = m.market;
    if (!M.spread.n && !M.total.n && !M.moneyline.n) return '<div class="pf-empty">None of the selected games has a market line captured with its forecast. Nothing is compared rather than compared with an assumed line.</div>';
    var h = '<div class="pf-tiles">';
    h += M.spread.model_mae != null ? tile('Margin error: EdgeDesk vs line', f(M.spread.model_mae) + ' vs ' + f(M.spread.market_mae), 'n=' + M.spread.n + ' · EdgeDesk nearer in ' + M.spread.model_nearer + ', the line in ' + M.spread.market_nearer + ' ' + chip(M.spread.sample_state)) : tile('Margin error: EdgeDesk vs line', 'Insufficient data', need(M.spread.n), true);
    h += M.total.model_mae != null ? tile('Total error: EdgeDesk vs line', f(M.total.model_mae) + ' vs ' + f(M.total.market_mae), 'n=' + M.total.n + ' · EdgeDesk nearer in ' + M.total.model_nearer + ' ' + chip(M.total.sample_state)) : tile('Total error: EdgeDesk vs line', 'Insufficient data', need(M.total.n), true);
    h += M.moneyline.model_brier != null ? tile('Brier: EdgeDesk vs no-vig price', f(M.moneyline.model_brier, 3) + ' vs ' + f(M.moneyline.market_brier, 3), 'n=' + M.moneyline.n + ' ' + chip(M.moneyline.sample_state)) : tile('Brier: EdgeDesk vs no-vig price', 'Insufficient data', need(M.moneyline.n) + (M.moneyline.n ? '' : ' · needs captured moneyline prices'), true);
    var c = m.clv;
    h += c.spread.n ? tile('Line moved toward EdgeDesk (spread)', c.spread.avg_pts != null ? sgn(c.spread.avg_pts, 2) + ' pts avg' : 'Insufficient data', 'n=' + c.spread.n + ' · toward ' + c.spread.beat + ', away ' + c.spread.lost + ', flat ' + c.spread.flat + ' · same-source close only', c.spread.avg_pts == null)
      : tile('Closing-line value', 'Not measured', 'needs a legitimate close from the same source as the captured line (NFL and college football only)', true);
    h += '</div>';
    h += '<h3>The side EdgeDesk’s number favoured, graded at the captured spread</h3>' + pickTable(m.picks.spread, 'Spread record');
    h += '<h3>…and at the captured total</h3>' + pickTable(m.picks.total, 'Total record');
    h += '<p class="note">A record of how a fair number read against a line, not a betting record. Units appear only where EdgeDesk captured the price for that exact side; a ROI needs ' + P.MIN_N + ' priced games.</p>';
    return h;
  }

  /* --------------------------------------------------------------- tables */
  function sportsTable(rows) {
    var by = {};
    rows.forEach(function (x) { (by[x.sport] = by[x.sport] || []).push(x); });
    var ids = Object.keys(by).sort();
    if (!ids.length) return '<tbody><tr><td>No games for these filters.</td></tr></tbody>';
    var h = '<thead><tr><th>Sport</th><th>Graded</th><th>Right winner</th><th>Brier</th><th>Margin MAE</th><th>Total MAE</th><th>Sample</th></tr></thead><tbody>';
    ids.forEach(function (id) {
      var m = P.metrics(by[id]), W = m.winner;
      h += '<tr><td>' + esc(sportName(id)) + '</td><td class="n">' + m.eligibility.graded + '</td><td class="n">' + (W.pct != null ? pct(W.pct) + ' <span class="dimt">(' + W.correct + '/' + W.called + ')</span>' : '<span class="dimt">' + W.correct + '/' + W.called + '</span>')
        + '</td><td class="n">' + (W.brier != null ? f(W.brier, 3) : '<span class="dimt">n=' + W.scored + '</span>') + '</td><td class="n">' + (m.margin.mae != null ? f(m.margin.mae) : '<span class="dimt">n=' + m.margin.n + '</span>')
        + '</td><td class="n">' + (m.total.mae != null ? f(m.total.mae) : '<span class="dimt">n=' + m.total.n + '</span>') + '</td><td>' + chip(m.winner.sample_state) + '</td></tr>';
    });
    return h + '</tbody>';
  }
  function bandsTable(m) {
    var b = m.winner.bands.filter(function (x) { return x.n; });
    if (!b.length) return '<tbody><tr><td>No called winners yet.</td></tr></tbody>';
    return '<thead><tr><th>Favourite’s chance</th><th>Games</th><th>Won</th><th>Rate</th><th>Said (avg)</th></tr></thead><tbody>' + b.map(function (x) {
      return '<tr><td>' + Math.round(x.from * 100) + '–' + Math.round(x.to * 100) + '%</td><td class="n">' + x.n + '</td><td class="n">' + x.correct + '</td><td class="n">' + (x.pct != null ? pct(x.pct) : '<span class="dimt">n&lt;' + P.MIN_N + '</span>') + '</td><td class="n">' + (x.mean_p != null ? pct(x.mean_p) : '—') + '</td></tr>';
    }).join('') + '</tbody>';
  }
  function forecastCell(x) {
    var fc = x.forecast || {}, out = [];
    var lt = lineText(x.home, fc.fair_home_line); if (lt) out.push(esc(lt));
    var tot = fc.expected_total != null ? fc.expected_total : fc.fair_total; if (tot != null && x.sport !== 'nhl') out.push('Total ' + f(tot));
    if (x.sport === 'nhl' && fc.expected_total != null) out.push('Total ' + f(fc.expected_total, 2));
    if (fc.p_home != null) out.push(esc(x.home) + ' ' + Math.round(fc.p_home * 100) + '%');
    return out.join('<br>') || '—';
  }
  function resultCell(x) {
    var r = x.result;
    if (!r) return '<span class="dimt">Awaiting a verified final</span>';
    if (r.state === 'VOID') return '<span class="dimt">Void · ' + esc(String(r.void_reason || '').toLowerCase().replace(/_/g, ' ')) + '</span>';
    if (r.state !== 'FINAL') return '<span class="dimt">' + esc(r.state) + '</span>';
    return esc(x.away) + ' ' + r.away_score + ', ' + esc(x.home) + ' ' + r.home_score + (r.decided && r.decided !== 'REG' ? ' <span class="dimt">(' + esc(r.decided) + ')</span>' : '');
  }
  function errorCell(x) {
    var g = x.grade;
    if (!g) return '—';
    if (!g.eligible) return '<span class="dimt">' + esc(String(g.why || '').replace(/_/g, ' ').toLowerCase()) + '</span>';
    var out = [];
    if (g.winner && g.winner.correct != null) out.push(g.winner.correct ? '<span class="pos">Right winner</span>' : '<span class="neg">Wrong winner</span>');
    else if (g.winner && g.winner.outcome === 'push') out.push('<span class="dimt">Tie</span>');
    if (g.spread) out.push('Margin off ' + f(g.spread.abs_error));
    if (g.total) out.push('Total off ' + f(g.total.abs_error, x.sport === 'nhl' ? 2 : 1));
    return out.join('<br>') || '—';
  }
  function detail(x) {
    var fc = x.forecast || {}, r = x.result || {}, g = x.grade || {}, mk = fc.market;
    var d = '<div class="pf-detail"><dl>';
    d += '<dt>Game</dt><dd>' + esc(x.away + ' at ' + x.home) + ' · ' + esc(sportName(x.sport)) + ' · ' + when(x.start_utc) + '</dd>';
    d += '<dt>Model</dt><dd>' + esc(x.model_version || '—') + '</dd>';
    d += '<dt>Graded forecast</dt><dd>' + tierChip(x.tier) + ' ' + (fc.captured_at ? 'captured ' + when(fc.captured_at) : fc.recorded_at ? 'recorded ' + when(fc.recorded_at) + ' (' + esc(fc.source || fc.method || '') + ')' : '') + (fc.predicted_at ? ' · model built ' + when(fc.predicted_at) : '') + ' · ' + (x.revisions || 1) + ' pregame revision' + ((x.revisions || 1) === 1 ? '' : 's') + ' on record</dd>';
    d += '<dt>Forecast</dt><dd>' + forecastCell(x).replace(/<br>/g, ' · ') + (fc.projected_score && fc.projected_score.home != null && x.sport !== 'nhl' ? ' · projected ' + esc(x.away) + ' ' + f(fc.projected_score.away) + ', ' + esc(x.home) + ' ' + f(fc.projected_score.home) : '') + (fc.research ? ' · readiness ' + esc(String(fc.research).toLowerCase().replace(/_/g, ' ')) : '') + '</dd>';
    if (mk) d += '<dt>Market line</dt><dd>' + esc(mk.book || mk.source || 'book') + (mk.home_line != null ? ' ' + esc(lineText(x.home, mk.home_line)) : '') + (mk.total != null ? ' · total ' + f(mk.total) : '') + ' · captured ' + when(mk.captured_at) + '</dd>';
    if (x.last_pregame_quote) d += '<dt>Last line before start</dt><dd>' + esc(x.last_pregame_quote.book || '') + (x.last_pregame_quote.home_line != null ? ' ' + esc(lineText(x.home, x.last_pregame_quote.home_line)) : '') + (x.last_pregame_quote.total != null ? ' · total ' + f(x.last_pregame_quote.total) : '') + ' · ' + when(x.last_pregame_quote.captured_at) + ' (context, not a close)</dd>';
    d += '<dt>Result</dt><dd>' + resultCell(x) + (r.verified_at ? ' · verified ' + when(r.verified_at) : '') + (r.sources && r.sources.length ? ' · ' + esc(r.sources.join(' + ')) : '') + (r.revision > 1 ? ' · revision ' + r.revision + ' (a source corrected it; the earlier one is kept)' : '') + '</dd>';
    if (g.spread) d += '<dt>Margin</dt><dd>projected ' + sgn(g.spread.projected_margin) + ', actual ' + sgn(g.spread.actual_margin, 0) + ' (home minus away): off by ' + f(g.spread.abs_error) + '</dd>';
    if (g.total) d += '<dt>Total</dt><dd>projected ' + f(g.total.projected_total, 2) + ', actual ' + g.total.actual_total + ': off by ' + f(g.total.abs_error, 2) + '</dd>';
    if (g.winner && g.winner.brier != null) d += '<dt>Probability</dt><dd>' + esc(x.home) + ' ' + pct(g.winner.p_home) + ' · Brier ' + f(g.winner.brier, 3) + ' · log loss ' + f(g.winner.log_loss, 3) + '</dd>';
    if (g.market && g.market.spread && g.market.spread.pick) { var sp = g.market.spread.pick; d += '<dt>At the line</dt><dd>EdgeDesk’s number favoured ' + esc(sp.side === 'home' ? x.home : x.away) + ' by ' + f(sp.gap) + ' pts against ' + esc(lineText(x.home, g.market.spread.line)) + ': ' + esc(sp.result) + (sp.units != null ? ' (' + (sp.units > 0 ? '+' : '') + f(sp.units, 2) + 'u at ' + sp.price + ')' : ' (no captured price)') + '</dd>'; }
    if (g.market && g.market.clv && g.market.clv.spread_pts != null) d += '<dt>Line movement</dt><dd>' + sgn(g.market.clv.spread_pts, 1) + ' pts toward EdgeDesk’s side by the close (' + esc(g.market.clv.close_source || '') + ')</dd>';
    d += '<dt>Fingerprint</dt><dd><code>' + esc(fc.hash || '—') + '</code></dd>';
    return d + '</dl></div>';
  }
  function ledgerHTML(rows) {
    var list = rows.slice().sort(function (a, b) { return Date.parse(b.start_utc) - Date.parse(a.start_utc); });
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (S.page >= pages) S.page = pages - 1;
    var slice = list.slice(S.page * PAGE_SIZE, S.page * PAGE_SIZE + PAGE_SIZE);
    var h = '<thead><tr><th>Date</th><th>Game</th><th>Forecast</th><th>Final</th><th>How it did</th><th>Forecast locked</th><th aria-label="Details"></th></tr></thead><tbody>';
    if (!slice.length) h += '<tr><td colspan="7">No games match.</td></tr>';
    slice.forEach(function (x) {
      var open = S.open === x.event_key;
      h += '<tr' + (open ? ' class="pf-open"' : '') + '><td class="n">' + day(x.start_utc) + '</td><td class="m">' + esc(x.away) + ' at ' + esc(x.home) + '<br><span class="dimt">' + esc(sportName(x.sport)) + '</span> ' + tierChip(x.tier) + '</td><td class="n">' + forecastCell(x) + '</td><td class="m">' + resultCell(x) + '</td><td>' + errorCell(x) + '</td><td class="n">' + when((x.forecast || {}).captured_at || (x.forecast || {}).recorded_at) + '</td>'
        + '<td><button type="button" class="pf-x" aria-expanded="' + open + '" data-k="' + esc(x.event_key) + '">' + (open ? 'Hide' : 'Open') + '</button></td></tr>';
      if (open) h += '<tr class="pf-open"><td colspan="7">' + detail(x) + '</td></tr>';
    });
    h += '</tbody>';
    $('pf-pager').innerHTML = pages > 1 ? '<button type="button" class="btn ghost" data-p="-1"' + (S.page ? '' : ' disabled') + '>Newer</button><span>Page ' + (S.page + 1) + ' of ' + pages + ' · ' + list.length + ' games</span><button type="button" class="btn ghost" data-p="1"' + (S.page < pages - 1 ? '' : ' disabled') + '>Older</button>' : '<span>' + list.length + ' game' + (list.length === 1 ? '' : 's') + '</span>';
    return h;
  }

  /* --------------------------------------------------------------- render */
  function filtered() {
    var fr = /^\d{4}-\d{2}-\d{2}$/.test(S.from) ? S.from + 'T00:00:00Z' : null, to = /^\d{4}-\d{2}-\d{2}$/.test(S.to) ? new Date(Date.parse(S.to + 'T00:00:00Z') + 86400e3).toISOString() : null;
    return P.filterRows(S.rows, { tier: S.tier, sport: S.sport, model: S.model, type: S.type, from: fr, to: to });
  }
  function render() {
    if (!S.loaded) return;
    var rows = filtered();
    var m = P.metrics(rows);
    $('pf-filtered').innerHTML = tilesFor(m, 'Graded (these filters)');
    $('pf-tier-note').textContent = S.tier === 'VERIFIED' ? P.TIERS.VERIFIED.means : S.tier === 'RECORDED' ? P.TIERS.RECORDED.means : 'Both tiers, each game labelled. The verified headline above never includes recorded forecasts.';
    $('pf-sports').innerHTML = '<caption class="pf-vh">Performance by sport for the selected forecasts</caption>' + sportsTable(rows);
    $('pf-cal').innerHTML = calibrationSVG(m.winner.calibration);
    $('pf-bands').innerHTML = '<caption class="pf-vh">Right-winner rate by how confident the forecast was</caption>' + bandsTable(m);
    $('pf-trend').innerHTML = trendSVG(m.trend);
    $('pf-mkt').innerHTML = marketHTML(m);
    var q = S.q ? P.filterRows(rows, { q: S.q }) : rows;
    $('pf-ledger').innerHTML = '<caption class="pf-vh">Every graded game for the selected forecasts</caption>' + ledgerHTML(q);
  }
  function renderStatic(s) {
    (s.coverage || []).forEach(function (c) { LABEL[c.sport] = c.label; });
    var V = s.headline.verified, R = s.headline.recorded, ep = s.ledger.epoch;
    var st = $('pf-status');
    if (V.eligibility.graded < P.MIN_N) {
      st.className = 'pf-status warn';
      st.innerHTML = '<b>Verified pregame record: insufficient data.</b> ' + (ep ? 'The performance ledger began locking forecasts on ' + esc(day(ep)) + '. ' : 'The performance ledger has not locked its first forecast yet. ') + V.eligibility.graded + ' verified forecast' + (V.eligibility.graded === 1 ? ' has' : 's have') + ' been graded so far; a rate is printed once ' + P.MIN_N + ' stand behind it. '
        + (R.eligibility.graded ? R.eligibility.graded + ' earlier forecasts from EdgeDesk’s pregame records are graded below and labelled <i>recorded pregame</i>: real pregame numbers, but not locked by this ledger, so they never count in the verified headline.' : '');
    } else {
      st.innerHTML = '<b>' + V.eligibility.graded + ' verified pregame forecasts graded</b>' + (ep ? ' since ' + esc(day(ep)) : '') + '. Updated ' + esc(when(s.generated_at)) + '. Every one is below, misses included.';
    }
    $('pf-headline').innerHTML = tilesFor(V, 'Verified forecasts graded');
    /* selects */
    var sports = (s.coverage || []).filter(function (c) { return c.games; });
    $('pf-sport').innerHTML = '<option value="all">All sports</option>' + sports.map(function (c) { return '<option value="' + esc(c.sport) + '">' + esc(c.label) + '</option>'; }).join('');
    var models = []; (s.coverage || []).forEach(function (c) { c.models.forEach(function (mv) { models.push({ v: mv, l: c.league + ' · ' + mv }); }); });
    $('pf-model').innerHTML = '<option value="all">All versions</option>' + models.map(function (o) { return '<option value="' + esc(o.v) + '">' + esc(o.l) + '</option>'; }).join('');
    /* coverage */
    var ST = { GRADED: 'Graded (verified)', RECORDED_ONLY: 'Recorded pregame only so far', AWAITING_GAMES: 'No graded games yet', NO_FORECAST: 'Not graded' };
    $('pf-coverage').innerHTML = '<caption class="pf-vh">Each sport EdgeDesk researches and whether its forecasts are graded</caption><thead><tr><th>Sport</th><th>Status</th><th>Graded (verified / recorded)</th><th>Why</th></tr></thead><tbody>' + (s.coverage || []).map(function (c) {
      return '<tr><td>' + esc(c.label) + '</td><td>' + esc(ST[c.status] || c.status) + '</td><td class="n">' + c.verified_graded + ' / ' + c.recorded_graded + '</td><td style="white-space:normal;min-width:240px">' + esc(c.why || (c.models.length ? 'Models: ' + c.models.join(', ') : 'Its engine is in the projection contract; no forecast for a game that has started is on record yet.')) + '</td></tr>';
    }).join('') + '</tbody>';
    /* retrospective */
    $('pf-retro').innerHTML = (s.retrospective || []).length ? '<div class="tblwrap"><table class="tbl"><caption class="pf-vh">Walk-forward evaluations on past seasons</caption><thead><tr><th>Sport</th><th>Market</th><th>State</th><th>Held-out games</th><th>What the test found</th></tr></thead><tbody>' + s.retrospective.map(function (sp) {
      return sp.markets.map(function (mk) { return '<tr><td>' + esc(sp.label) + '</td><td>' + esc(mk.market) + '</td><td>' + esc(String(mk.state || '').toLowerCase().replace(/_/g, ' ')) + '</td><td class="n">' + (mk.n == null ? '—' : mk.n) + '</td><td style="white-space:normal;min-width:280px">' + esc(mk.headline || '') + (mk.file ? ' <span class="dimt">(' + esc(mk.file) + ')</span>' : '') + '</td></tr>'; }).join('');
    }).join('') + '</tbody></table></div>' : '<div class="pf-empty">No retrospective evaluations on file.</div>';
    $('pf-rules').innerHTML = (s.rules || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('');
  }

  /* --------------------------------------------------------------- events */
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('.pf-tier button'), function (b) {
      b.addEventListener('click', function () {
        S.tier = b.getAttribute('data-tier'); S.page = 0;
        Array.prototype.forEach.call(document.querySelectorAll('.pf-tier button'), function (x) { var on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
        render();
      });
    });
    [['pf-sport', 'sport'], ['pf-model', 'model'], ['pf-type', 'type']].forEach(function (p) { $(p[0]).addEventListener('change', function (e) { S[p[1]] = e.target.value; S.page = 0; render(); }); });
    [['pf-from', 'from'], ['pf-to', 'to']].forEach(function (p) { $(p[0]).addEventListener('input', function (e) { S[p[1]] = e.target.value.trim(); S.page = 0; render(); }); });
    $('pf-q').addEventListener('input', function (e) { S.q = e.target.value.trim(); S.page = 0; render(); });
    $('pf-ledger').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button.pf-x'); if (!b) return;
      var k = b.getAttribute('data-k'); S.open = S.open === k ? null : k; render();
      var nb = document.querySelector('button.pf-x[data-k="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"]'); if (nb) nb.focus();
    });
    $('pf-pager').addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('button[data-p]'); if (!b || b.disabled) return; S.page += +b.getAttribute('data-p'); render(); $('pf-ledger-h').scrollIntoView({ block: 'start' }); });
  }
  function getJson(u) { return fetch(u, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); }); }

  function boot() {
    if (!P) { $('pf-status').textContent = 'The record could not load (the performance library is missing).'; return; }
    wire();
    getJson(BASE + 'summary.json').then(function (s) {
      S.summary = s;
      renderStatic(s);
      var files = (s.games || []).map(function (g) { return getJson(g.path).then(function (d) { return d.rows || []; }).catch(function () { return []; }); });
      return Promise.all(files).then(function (parts) {
        S.rows = [].concat.apply([], parts);
        S.loaded = true;
        /* a link to one game: ?g=<event key> opens it, in whichever tier holds it */
        var g = new URLSearchParams(location.search).get('g');
        if (g) {
          var hit = S.rows.filter(function (x) { return x.event_key === g; })[0];
          if (hit) {
            S.tier = hit.tier; S.open = g; S.q = (hit.home || '');
            $('pf-q').value = S.q;
            Array.prototype.forEach.call(document.querySelectorAll('.pf-tier button'), function (x) { var on = x.getAttribute('data-tier') === S.tier; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
          }
        }
        render();
        if (g && S.open) $('pf-ledger-h').scrollIntoView({ block: 'start' });
      });
    }).catch(function (e) {
      $('pf-status').className = 'pf-status warn';
      $('pf-status').textContent = 'The record could not load right now (' + (e && e.message || 'network') + '). Nothing is shown rather than a stale or partial record.';
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
