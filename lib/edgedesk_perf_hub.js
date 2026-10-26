/* ===========================================================================
   EdgeDesk PERFORMANCE — two records on one page, never combined.
   docs/research-os/DESIGN.md §6

     EdgeDesk's models   every pregame forecast, locked before the start and
                         graded against the verified final: the public ledger's
                         own summary (performance/data/summary.json), with its
                         n and sample state, and nothing under its min_n
     Your record         the reader's own positions, as the server sums them
                         (portfolio_summary under their token: settled count,
                         staked, net, ROI) and their decision process (the
                         Process Coach's grade and closing-line record)

   The page adds no metric of its own. It never adds a model's record to a
   reader's, never prints a simulated result as money, and says plainly that
   forecast accuracy is not profit and that closing-line movement alone is
   not a realised result. Every figure links to the page that owns it.

   Browser: window.EDPerfHub. Node: require('./edgedesk_perf_hub.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDPerfHub = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var P = { VERSION: 'edgedesk_perf_hub/1', SUMMARY_URL: '/performance/data/summary.json' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  var SPORT = { nfl: 'NFL', cfb: 'College football', nba: 'NBA', nhl: 'NHL', wnba: 'WNBA', ncaam: 'Men’s college basketball', ncaaw: 'Women’s college basketball', mlb: 'MLB' };
  var STATE = { TOO_EARLY: 'too early', EARLY_SIGNAL: 'early signal', DEVELOPING: 'developing', MEANINGFUL: 'meaningful' };
  function pct1(p) { p = num(p); return p == null ? '—' : (p * 100).toFixed(1) + '%'; }

  /* ===================================================== MODEL RECORD (pure) */
  /* one row per sport from the ledger's summary: verified pregame forecasts only */
  P.modelRows = function (sum) {
    if (!sum || !sum.by_sport) return [];
    var min = num(sum.min_n) || 20;
    return Object.keys(sum.by_sport).map(function (k) {
      var v = (sum.by_sport[k] || {}).verified || {}, w = v.winner || {}, el = v.eligibility || {};
      var n = num(w.n) || 0;
      return { sport: k, label: SPORT[k] || k.toUpperCase(), graded: num(el.graded) != null ? num(el.graded) : n, n: n, enough: n >= min,
        pct: n >= min ? num(w.pct) : null, brier: n >= min ? num(w.brier) : null, state: w.sample_state || null, awaiting: num(el.awaiting_result) || 0, flagged: num(el.flagged_pregame) || 0 };
    }).sort(function (a, b) { return b.n - a.n || (a.sport < b.sport ? -1 : 1); });
  };
  P.modelHTML = function (sum, err, now) {
    var h = '<section class="pfh-sec" aria-labelledby="pfhMH"><div class="pfh-hd"><h3 id="pfhMH">EdgeDesk’s models</h3><span class="pfh-tag">Public record</span></div>'
      + '<p class="pfh-lede">Every eligible pregame forecast, locked before the start and graded against the verified final, misses included.</p>';
    if (err) return h + '<p class="pfh-empty">The model record could not be loaded just now (' + esc(err) + '). The public record is at <a href="/performance/">/performance/</a>.</p></section>';
    if (!sum) return h + '<p class="pfh-empty">Loading the model record…</p></section>';
    var hv = (sum.headline || {}).verified || {}, w = hv.winner || {}, min = num(sum.min_n) || 20;
    var built = sum.generated_at ? (root.EDShell && root.EDShell.ago ? root.EDShell.ago(sum.generated_at, now) : sum.generated_at) : null;
    h += '<div class="pfh-tiles">'
      + '<div class="pfh-tile"><div class="k">Graded, verified pregame</div><div class="v">' + esc(num(w.n) == null ? '—' : w.n) + '</div><div class="s">' + esc(STATE[w.sample_state] || '') + '</div></div>'
      + '<div class="pfh-tile"><div class="k">Right winner</div><div class="v">' + esc((num(w.n) || 0) >= min ? pct1(w.pct) : '—') + '</div><div class="s">' + esc((num(w.n) || 0) >= min ? (w.correct + ' of ' + w.called + ' called') : 'not printed under ' + min + ' games') + '</div></div>'
      + '<div class="pfh-tile"><div class="k">Brier score</div><div class="v">' + esc((num(w.n) || 0) >= min && num(w.brier) != null ? w.brier.toFixed(3) : '—') + '</div><div class="s">lower is better; 0.25 is a coin flip</div></div>'
      + '</div>';
    var rows = P.modelRows(sum);
    if (rows.length) h += '<div class="pfh-tw"><table class="pfh-tbl"><caption class="pfh-sr">Verified pregame forecasts by sport</caption><thead><tr><th scope="col">Sport</th><th scope="col">Graded</th><th scope="col">Right winner</th><th scope="col">Brier</th><th scope="col">Sample</th></tr></thead><tbody>'
      + rows.map(function (r) { return '<tr><th scope="row">' + esc(r.label) + '</th><td>' + esc(r.n) + '</td><td>' + esc(r.enough ? pct1(r.pct) : 'under ' + min) + '</td><td>' + esc(r.enough && r.brier != null ? r.brier.toFixed(3) : '—') + '</td><td>' + esc(STATE[r.state] || '—') + '</td></tr>'; }).join('')
      + '</tbody></table></div>';
    h += '<p class="pfh-note">Ledger summary built ' + esc(built || 'at an unknown time') + '. Forecasts imported from earlier records are kept apart as “recorded pregame” and are not in these figures. Accuracy is not profit: a model can call winners and still lose to the price.</p>'
      + '<div class="pfh-links"><a class="pfh-btn" href="#record">Model performance &amp; P&amp;L</a><a class="pfh-btn ghost" href="/performance/" target="_blank" rel="noopener">Every forecast, graded ↗</a>'
      + '<a class="pfh-btn ghost" href="/performance/grades/" target="_blank" rel="noopener">Research-grade record ↗</a><a class="pfh-btn ghost" href="#signals/dna">Model DNA</a><a class="pfh-btn ghost" href="#foresight">Market Foresight</a></div></section>';
    return h;
  };

  /* ====================================================== YOUR RECORD (pure) */
  /* s: portfolio_summary() for all time; state: 'signed_out'|'loading'|'not_deployed'|'error'|'ok' */
  P.mineHTML = function (st, s, fmt) {
    fmt = fmt || {};
    var money = fmt.money || function (x) { x = num(x); return x == null ? '—' : (x < 0 ? '−' : '') + '$' + Math.abs(x).toFixed(2); };
    var pct = fmt.pct || function (x) { x = num(x); return x == null ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(1) + '%'; };
    var h = '<section class="pfh-sec" aria-labelledby="pfhYH"><div class="pfh-hd"><h3 id="pfhYH">Your record</h3><span class="pfh-tag mine">Only you see this</span></div>'
      + '<p class="pfh-lede">The positions you recorded or imported in Portfolio, settled at their results, and how you decided. Nothing EdgeDesk simulated or recommended is counted here.</p>';
    if (st === 'signed_out') return h + '<p class="pfh-empty">Sign in to see your own record.</p></section>';
    if (st === 'not_deployed') return h + '<p class="pfh-empty">Your portfolio is not set up on this deployment yet.</p>' + P.mineLinks() + '</section>';
    if (st === 'error') return h + '<p class="pfh-empty">Your record could not be read just now. Portfolio has the full book.</p>' + P.mineLinks() + '</section>';
    if (st !== 'ok' || !s) return h + '<p class="pfh-empty">Loading your record…</p></section>';
    var t = s.settled || {}, pr = s.process || {}, clv = pr.clv || {};
    if (!num(t.n)) h += '<p class="pfh-empty">No settled positions yet. When you record or import positions in Portfolio, their results appear here.</p>';
    else h += '<div class="pfh-tiles">'
      + '<div class="pfh-tile"><div class="k">Settled positions</div><div class="v">' + esc(t.n) + '</div><div class="s">' + esc((t.wins || 0) + '–' + (t.losses || 0) + (t.pushes ? '–' + t.pushes : '') + ' (W–L' + (t.pushes ? '–P' : '') + ')') + '</div></div>'
      + '<div class="pfh-tile"><div class="k">Net result</div><div class="v ' + (num(t.pnl) > 0 ? 'pos' : num(t.pnl) < 0 ? 'neg' : '') + '">' + esc(money(t.pnl, { sign: true })) + '</div><div class="s">on ' + esc(money(t.staked)) + ' staked</div></div>'
      + '<div class="pfh-tile"><div class="k">Return on stakes</div><div class="v">' + esc(t.roi == null ? '—' : pct(t.roi)) + '</div><div class="s">net ÷ staked, settled positions</div></div>'
      + (num(pr.graded) ? '<div class="pfh-tile"><div class="k">Decision grade</div><div class="v">' + esc(pr.letter || '—') + '</div><div class="s">' + esc(pr.graded + ' graded · confidence ' + String(pr.confidence || '—').toLowerCase()) + '</div></div>' : '')
      + (num(clv.with_close) ? '<div class="pfh-tile"><div class="k">Beat the close</div><div class="v">' + esc(clv.beat + ' of ' + clv.with_close) + '</div><div class="s">positions with a recorded close</div></div>' : '')
      + '</div>';
    h += '<p class="pfh-note">All time, as the server sums your own rows. Beating the closing line is evidence about a decision, not a realised result.</p>' + P.mineLinks();
    return h + '</section>';
  };
  P.mineLinks = function () {
    return '<div class="pfh-links"><a class="pfh-btn" href="#portfolio/analytics">Portfolio analytics</a><a class="pfh-btn ghost" href="#process">Your decision process</a><a class="pfh-btn ghost" href="#portfolio/history">Position history</a></div>';
  };
  P.pageHTML = function () {
    return '<div class="pfh"><div class="pfh-top"><h2 id="pfhH">Performance</h2><p class="pfh-sub">Two records, never combined: how EdgeDesk’s models have done, and how your own positions have done.</p></div>'
      + '<div class="pfh-grid"><div id="pfhModel"></div><div id="pfhMine"></div></div>'
      + '<p class="pfh-foot">Research, not picks. Past results do not guarantee future results. 21+ · 1-800-GAMBLER.</p></div>';
  };

  /* ============================================================== BROWSER */
  var S = { host: null, sum: null, sumErr: null, mine: null, mineSt: null };
  function $(id) { return root.document.getElementById(id); }
  function X() { return root.EDShell || null; }
  function paint() {
    var m = $('pfhModel'); if (m) m.innerHTML = P.modelHTML(S.sum, S.sumErr, Date.now());
    var y = $('pfhMine'); if (y) y.innerHTML = P.mineHTML(S.mineSt, S.mine, root.EDPortfolio ? { money: root.EDPortfolio.money, pct: root.EDPortfolio.pct } : null);
  }
  P.open = function (host) {
    if (!host) return;
    if (S.host !== host) { S.host = host; host.innerHTML = P.pageHTML(); }
    paint();
    var x = X();
    var getSum = function () { return fetch(P.SUMMARY_URL, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('the record answered ' + r.status); return r.json(); }); };
    (x ? x.memo('pfh:summary', 10 * 60000, getSum) : getSum()).then(function (j) { S.sum = j; S.sumErr = null; paint(); }, function (e) { S.sumErr = String((e && e.message) || e); paint(); });
    if (!x || !x.signedIn()) { S.mineSt = 'signed_out'; paint(); return; }
    S.mineSt = S.mineSt || 'loading';
    x.memo('pfh:mine', 2 * 60000, function () {
      return x.rpc('portfolio_summary', { p_from: '2000-01-01T00:00:00Z', p_to: new Date(Date.now() + 86400000).toISOString(), p_tz: null, p_platform: null });
    }).then(function (s) { S.mine = s; S.mineSt = 'ok'; paint(); }, function (e) { S.mineSt = x.notDeployed(e) ? 'not_deployed' : 'error'; paint(); });
  };
  P._state = S;
  return P;
});
