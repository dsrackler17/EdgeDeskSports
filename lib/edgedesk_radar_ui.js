/* ===========================================================================
   EdgeDesk PREDICTION RADAR — what a reader sees. EXPERIMENTAL.
   docs/prediction-radar.md

   Renders only. It fetches nothing and decides no access: every number comes
   from a database door (supabase/radar.sql) that already decided who may see
   it, and this module draws what it was given.
     the terminal (app.html, the Overview)  Smart Money Tonight, the trader page
                                            (window.radarData reads, as the reader)
     /radar/ (public, no login)             the leaderboard, the trader pages,
                                            a teaser of the first card
   Both show the Known limitations.

   THE RULES IT DRAWS BY
     - a card leads with one plain sentence ("7 top bettors, $84K, on Chiefs
       -3"), the numbers underneath
     - Experimental and Small sample are TEXT chips, never colour alone
     - the Radar Score is never shown without its components
     - a number the pipeline does not own is not drawn: no fair, no line;
       no price, no movement
     - no "bet now", no "copy trade", no affiliate link, no promise
       (tools/radar/radar_ui.test.js fails on any of them)

   Browser: window.EDRadarUI. Node: require('./edgedesk_radar_ui.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDRadarUI = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var U = { VERSION: 'edgedesk_radar_ui/1' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  U.esc = esc;

  /* ------------------------------------------------------------ formats */
  /* dollars: $640, $8.4K, $84K, $1.2M */
  U.money = function (x) {
    x = num(x); if (x == null) return '—';
    var a = Math.abs(x), s = x < 0 ? '−$' : '$';
    if (a >= 1e6) return s + trim((a / 1e6).toFixed(a >= 1e7 ? 0 : 1)) + 'M';
    if (a >= 1e3) return s + trim((a / 1e3).toFixed(a >= 1e4 ? 0 : 1)) + 'K';
    return s + Math.round(a);
  };
  function trim(t) { return t.replace(/\.0$/, ''); }
  /* a Polymarket price is cents on the dollar */
  U.cents = function (p) { p = num(p); return p == null ? '—' : Math.round(p * 100) + '¢'; };
  U.pct = function (x, digits) { x = num(x); if (x == null) return '—'; var v = (x * 100).toFixed(digits == null ? 1 : digits); return (x > 0 ? '+' : x < 0 ? '−' : '') + v.replace('-', '') + '%'; };
  U.pp = function (x) { x = num(x); if (x == null) return '—'; return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + ' pts'; };
  U.signed = function (pt) { pt = num(pt); if (pt == null) return ''; return (pt > 0 ? '+' : pt < 0 ? '-' : '') + trim(String(Math.abs(pt))); };
  var ETF = null;
  try { ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch (_) { ETF = null; }
  var EDF = null;
  try { EDF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { EDF = null; }
  U.when = function (t) { var x = Date.parse(t); return isFinite(x) ? (ETF ? ETF.format(new Date(x)) + ' ET' : new Date(x).toISOString().slice(0, 16).replace('T', ' ') + ' UTC') : ''; };
  U.day = function (t) { var x = Date.parse(t); return isFinite(x) ? (EDF ? EDF.format(new Date(x)) : new Date(x).toISOString().slice(0, 10)) : ''; };
  /* the name a page may show is the database's (radar_display): a public name or a shortened address */
  U.walletLabel = function (w) { return w && w.display ? w.display : (w && w.wallet ? w.wallet.slice(0, 6) + '…' + w.wallet.slice(-4) : 'unknown'); };
  U.polygonscan = function (tx) { return /^0x[0-9a-f]{64}$/.test(String(tx || '')) ? 'https://polygonscan.com/tx/' + tx : null; };

  /* the side, as a reader would say it: "Chiefs", "Chiefs -3", "Over 47.5" */
  function nick(c) {
    var o = String(c.outcome || '').trim(), s = String(c.selection || '').trim();
    if (o && !/^(yes|no)$/i.test(o)) return o;
    return s ? s.split(' ').slice(-1)[0] : 'this side';
  }
  U.sideLabel = function (c) {
    if (!c) return '';
    if (c.market_type === 'totals') return (String(c.selection || c.outcome || '').toLowerCase() === 'under' ? 'Under' : 'Over') + (num(c.point) != null ? ' ' + trim(String(num(c.point))) : '');
    if (c.market_type === 'spreads' && num(c.point) != null) return nick(c) + ' ' + U.signed(c.point);
    return nick(c);
  };
  /* THE SENTENCE every card leads with */
  U.sentence = function (c) {
    var n = num(c && c.n_wallets) || 0;
    return n + ' top bettor' + (n === 1 ? '' : 's') + ', ' + U.money(c && c.dollars) + ', on ' + U.sideLabel(c);
  };
  U.gameLabel = function (c) {
    if (!c || !c.home_team || !c.away_team) return '';
    return c.away_team + ' at ' + c.home_team + (c.commence_time ? ' · ' + U.when(c.commence_time) : '');
  };
  /* EdgeDesk's fair against the price, in one plain line, or why there is none */
  U.agreeLine = function (c) {
    if (c.agrees === true) return 'Smart money agrees with the sharp fair price';
    if (c.agrees === false) return 'Smart money disagrees with the sharp fair price';
    if (num(c.fair) != null && c.fair_current === false) return 'EdgeDesk’s fair price for this side is more than 90 minutes old, so there is no comparison';
    if (num(c.fair) != null && num(c.current_price) == null) return 'No current Polymarket price to compare with EdgeDesk’s fair price';
    return 'EdgeDesk has no fair price at this line, so there is no comparison';
  };
  U.movedLine = function (c) {
    var p = num(c.current_price), m = num(c.moved);
    if (p == null) return 'No current Polymarket price';
    if (m == null) return 'Now ' + U.cents(p) + ' on Polymarket';
    if (c.has_moved !== true) return 'Now ' + U.cents(p) + ' on Polymarket, about where they entered';
    return 'Now ' + U.cents(p) + ' on Polymarket, ' + (m > 0 ? 'up ' : 'down ') + Math.round(Math.abs(m) * 100) + '¢ since they entered';
  };
  function chip(text, cls) { return '<span class="rd-chip' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</span>'; }
  U.experimentalChip = function () { return chip('Experimental', 'exp'); };

  /* ------------------------------------------------------------ one card */
  U.cardHTML = function (c, o) {
    o = o || {};
    var hi = num(c.high_conviction) || 0, other = num(c.other_side_wallets) || 0;
    var ws = (c.wallets || []).map(function (w) {
      return '<li><button type="button" class="rd-w" data-radar-wallet="' + esc(w.wallet) + '">' + esc(U.walletLabel(w)) + '</button>'
        + '<span class="rd-wn">#' + esc(w.rank) + ' · ' + esc(U.money(w.cost)) + (num(w.avg_price) != null ? ' at ' + esc(U.cents(w.avg_price)) : '') + '</span>'
        + (w.high_conviction ? chip(trim(String(num(w.conviction))) + '× usual size', 'conv') : '') + '</li>';
    }).join('');
    return '<article class="rd-card" data-radar-event="' + esc(c.event_id) + '">'
      + '<div class="rd-meta">' + esc(U.gameLabel(c)) + '</div>'
      + '<h3 class="rd-sent">' + esc(U.sentence(c)) + '</h3>'
      + '<dl class="rd-nums">'
      + '<div><dt>Their average entry</dt><dd>' + esc(U.cents(c.avg_entry)) + '</dd></div>'
      + '<div><dt>Polymarket now</dt><dd>' + esc(U.cents(c.current_price)) + '</dd></div>'
      + '<div><dt>EdgeDesk fair</dt><dd>' + esc(num(c.fair) != null ? U.cents(c.fair) : '—') + '</dd></div>'
      + '</dl>'
      + '<p class="rd-line">' + esc(U.movedLine(c)) + '.</p>'
      + '<p class="rd-line rd-agree">' + esc(U.agreeLine(c)) + '.</p>'
      + (hi ? '<p class="rd-line">' + chip('High conviction') + ' ' + esc(hi + ' of them ' + (hi === 1 ? 'is' : 'are') + ' at ' + (o.conviction_x || 3) + '× or more their usual size.') + '</p>' : '')
      + (other ? '<p class="rd-line rd-dim">' + esc(other + ' top bettor' + (other === 1 ? '' : 's') + ' on the other side (' + U.money(c.other_side_dollars) + ').') + '</p>' : '')
      + (ws ? '<ul class="rd-ws" aria-label="The top bettors on this side">' + ws + '</ul>' : '')
      + '</article>';
  };

  /* ------------------------------------------------------------ Smart Money Tonight */
  U.tonightHTML = function (r) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered' || r.notDeployed) return '';   /* nothing is shown before Radar is on and registered */
    var head = '<div class="rd-head"><h2 class="rd-h2">Smart Money Tonight</h2>' + U.experimentalChip() + '</div>'
      + '<p class="rd-sub">Where the ' + esc(r.top_wallets || 25) + ' best-graded Polymarket sports bettors have real money on tonight\'s games, graded on skill, not just profit. Information, not a pick.</p>';
    var body;
    if (r.status === 'subscribers_only') body = '<p class="rd-empty">Smart Money Tonight is part of the Research Terminal.</p>';
    else if (r.status === 'error') body = '<p class="rd-empty">Smart Money Tonight could not be loaded just now.</p>';
    else if (!(r.cards || []).length) body = '<p class="rd-empty">No top-graded bettor holds a position on tonight\'s covered games yet.</p>';
    else body = '<div class="rd-cards">' + r.cards.map(function (c) { return U.cardHTML(c, { conviction_x: r.conviction_high_x }); }).join('') + '</div>';
    return '<section class="rd-sec" aria-labelledby="rdTonightH">' + head.replace('<h2 class="rd-h2">', '<h2 class="rd-h2" id="rdTonightH">') + body
      + '<p class="rd-foot">Graded ' + esc(r.graded_at ? U.day(r.graded_at) : '—') + '. Tap a bettor to see their record. ' + U.limitationsLink() + '</p></section>';
  };
  U.limitationsLink = function () { return '<a href="/radar/#limitations" class="rd-a">Known limitations</a>'; };

  /* ------------------------------------------------------------ the score and its parts, always together */
  U.scoreHTML = function (g) {
    if (!g || num(g.radar_score) == null) return '<span class="rd-dim">No Radar Score</span>';
    var p = g.score_parts || {};
    return '<span class="rd-score">' + esc(num(g.radar_score).toFixed(2)) + '</span> '
      + '<span class="rd-parts">= 0.5 × follow ROI ' + esc(U.pct(p.follow_roi)) + ' + 0.3 × CLV ' + esc(U.pct(p.clv_pct)) + ' + 0.2 × ROI ' + esc(U.pct(p.roi)) + ' (each shrunk toward zero by sample)</span>';
  };
  function sampleChip(g) { return g.sample === 'ranked' ? '' : chip('Small sample'); }
  function record(g) { return (num(g.wins) || 0) + '–' + (num(g.losses) || 0) + ((num(g.pushes) || 0) ? '–' + g.pushes : ''); }

  /* ------------------------------------------------------------ the leaderboard */
  U.leaderboardHTML = function (r) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered') return '<p class="rd-empty">Prediction Radar is not live yet. Nothing is shown until it is.</p>';
    if (r.status === 'not_graded') return '<p class="rd-empty">No grading run has finished yet.</p>';
    if (r.status !== 'ok') return '<p class="rd-empty">The leaderboard could not be loaded just now.</p>';
    var rows = (r.rows || []).map(function (g) {
      return '<tr><td class="rd-n">' + esc(g.rank == null ? '—' : g.rank) + '</td>'
        + '<td><button type="button" class="rd-w" data-radar-wallet="' + esc(g.wallet) + '">' + esc(U.walletLabel(g)) + '</button> ' + sampleChip(g) + '</td>'
        + '<td>' + esc(g.style) + '</td><td class="rd-n">' + esc(g.graded_bets) + '</td><td class="rd-n">' + esc(record(g)) + '</td>'
        + '<td class="rd-n">' + esc(U.pct(g.roi)) + '</td><td class="rd-n">' + esc(U.pp(g.clv_pp)) + '</td><td class="rd-n">' + esc(U.pct(g.follow5_roi)) + '</td>'
        + '<td>' + U.scoreHTML(g) + '</td></tr>';
    }).join('');
    return '<div class="rd-tablewrap"><table class="rd-table"><caption>Graded on sports game markets: ' + esc(r.min_graded || 50) + ' graded bets to be ranked. Radar Score ' + U.experimentalChip() + '</caption>'
      + '<thead><tr><th scope="col">Rank</th><th scope="col">Bettor</th><th scope="col">Style</th><th scope="col">Graded bets</th><th scope="col">Record</th><th scope="col">ROI</th>'
      + '<th scope="col">CLV</th><th scope="col">Follow ROI (5 min)</th><th scope="col">Radar Score and its parts</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  };

  /* ------------------------------------------------------------ one trader */
  U.traderHTML = function (r) {
    if (!r || r.status === 'disabled' || r.status === 'not_registered') return '<p class="rd-empty">Prediction Radar is not live yet.</p>';
    if (r.status === 'bad_wallet') return '<p class="rd-empty">That is not a Polymarket wallet address.</p>';
    if (r.status === 'not_graded') return '<p class="rd-empty">This wallet has no grade yet.</p>';
    if (r.status !== 'ok') return '<p class="rd-empty">This trader could not be loaded just now.</p>';
    var g = r.grade || {};
    var stat = function (k, v, note) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + (note ? '<small>' + esc(note) + '</small>' : '') + '</dd></div>'; };
    var hist = (r.history || []).map(function (b) {
      var txs = (b.txs || []).map(function (t, i) { var u = U.polygonscan(t); return u ? '<a class="rd-a" href="' + esc(u) + '" target="_blank" rel="noopener">tx' + (i + 1) + '</a>' : ''; }).join(' ');
      /* a spread's line belongs to one outcome (the market's question names it), so only a total's line is attached here */
      var side = b.market_type === 'totals' ? U.sideLabel({ market_type: 'totals', outcome: b.outcome, selection: b.outcome, point: b.line }) : String(b.outcome || '');
      return '<tr><td>' + esc(U.day(b.game_start_at)) + '</td><td>' + esc(b.question || '') + '</td><td>' + esc(side) + '</td>'
        + '<td class="rd-n">' + esc(U.cents(b.entry_price)) + '</td><td class="rd-n">' + esc(U.money(b.stake)) + '</td>'
        + '<td class="rd-n">' + esc(U.cents(b.follow5_price)) + '</td><td class="rd-n">' + esc(U.cents(b.close_price)) + '</td>'
        + '<td class="rd-n">' + esc(U.pp(b.clv_pp)) + '</td><td>' + esc(b.result) + '</td><td class="rd-n">' + esc(U.money(b.profit)) + '</td><td>' + txs + '</td></tr>';
    }).join('');
    var pos = r.positions_locked ? '<p class="rd-dim">Open positions on games that have not started are in the Research Terminal.</p>'
      : !(r.positions || []).length ? '<p class="rd-dim">No open position on an upcoming covered game.</p>'
        : '<ul class="rd-pos">' + r.positions.map(function (p) {
          return '<li>' + esc(p.question || '') + ' · ' + esc(p.outcome || '') + ' · ' + esc(U.money(p.cost)) + (num(p.avg_price) != null ? ' at ' + esc(U.cents(p.avg_price)) : '') + ' · ' + esc(U.when(p.game_start_at)) + '</li>';
        }).join('') + '</ul>';
    return '<article class="rd-trader">'
      + '<div class="rd-head"><h2 class="rd-h2">' + esc(g.display || U.walletLabel(g)) + '</h2>' + chip(g.style || 'Directional') + sampleChip(g) + '</div>'
      + '<p class="rd-sub rd-mono">' + esc(g.wallet || '') + '</p>'
      + '<dl class="rd-stats">'
      + stat('Record', record(g)) + stat('ROI', U.pct(g.roi)) + stat('CLV', U.pp(g.clv_pp), 'entry against the close')
      + stat('Follow ROI, 5 min', U.pct(g.follow5_roi), 'entering 5 minutes after them') + stat('Follow ROI, 15 min', U.pct(g.follow15_roi))
      + stat('Graded bets', String(g.graded_bets == null ? '—' : g.graded_bets), (g.sample === 'ranked' ? 'rank #' + g.rank : 'a small sample: under ' + (r.min_graded || 50)))
      + '</dl>'
      + '<p class="rd-line">Radar Score ' + U.experimentalChip() + ' ' + U.scoreHTML(g) + '</p>'
      + '<h3 class="rd-h3">Open positions</h3>' + pos
      + '<h3 class="rd-h3">Every graded bet</h3>'
      + (hist ? '<div class="rd-tablewrap"><table class="rd-table"><thead><tr><th scope="col">Game day</th><th scope="col">Market</th><th scope="col">Side</th><th scope="col">Entry</th><th scope="col">Stake</th>'
        + '<th scope="col">Follow (5 min)</th><th scope="col">Close</th><th scope="col">CLV</th><th scope="col">Result</th><th scope="col">P&amp;L</th><th scope="col">On Polygon</th></tr></thead><tbody>' + hist + '</tbody></table></div>'
        : '<p class="rd-dim">No graded bet yet.</p>')
      + '<p class="rd-foot">Every trade links to its transaction on Polygon, so anyone can check it. Public trading data only. ' + U.limitationsLink() + '</p>'
      + '</article>';
  };

  /* ------------------------------------------------------------ Known limitations */
  U.LIMITATIONS = [
    'Polymarket’s public data is its international platform. A US reader may not be able to trade the same markets.',
    'A follower never gets the bettor’s entry price. The record follows at the market price 5 minutes after their entry, which is not the ask, and fees are not modelled.',
    'Past results do not predict future results.',
    'Some large traders may have information others do not.',
    'Smart Money Tonight reads Polymarket’s top 100 holders of each side, at the board’s own lines, so a top bettor with a small position, or on an alternate line, may not appear.'
  ];
  U.limitationsHTML = function () {
    return '<section class="rd-lim" id="limitations" aria-labelledby="rdLimH"><h2 class="rd-h2" id="rdLimH">Known limitations</h2><ul>'
      + U.LIMITATIONS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></section>';
  };

  /* ------------------------------------------------------------ style (the terminal's tokens) */
  U.STYLE = [
    '.rd-sec{border:1px solid var(--border);background:var(--surface);border-radius:var(--rad,14px);padding:14px;margin:0 0 16px;min-width:0}',
    '.rd-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
    '.rd-h2{font-size:18px;font-weight:800;margin:0;letter-spacing:-.01em;text-transform:none}',
    '.rd-h3{font-size:15px;font-weight:800;margin:16px 0 6px}',
    '.rd-sub{color:var(--dim);font-size:13px;margin:6px 0 10px;line-height:1.45}',
    '.rd-mono{font-family:"JetBrains Mono",monospace;font-size:12px;overflow-wrap:anywhere}',
    '.rd-chip{display:inline-block;font-size:11px;font-weight:700;border:1px solid var(--border);border-radius:7px;padding:2px 7px;color:var(--dim);white-space:nowrap;vertical-align:middle}',
    '.rd-chip.exp{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 55%,var(--border))}',
    '.rd-chip.conv{color:var(--gold)}',
    '.rd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
    '.rd-card{border:1px solid var(--border);background:var(--surface2);border-radius:var(--rad-s,11px);padding:12px;min-width:0;overflow-wrap:anywhere}',
    '.rd-meta{font-size:12px;color:var(--dim)}',
    '.rd-sent{font-size:17px;font-weight:800;margin:4px 0 8px;line-height:1.3}',
    '.rd-nums{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0 0 8px}',
    '.rd-nums div,.rd-stats div{min-width:0}',
    '.rd-nums dt,.rd-stats dt{font-size:11px;color:var(--dim)}',
    '.rd-nums dd,.rd-stats dd{margin:0;font-weight:800;font-variant-numeric:tabular-nums}',
    '.rd-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:10px 0}',
    '.rd-stats small{display:block;font-weight:500;font-size:11px;color:var(--dim)}',
    '.rd-line{font-size:13px;margin:4px 0;line-height:1.45}',
    '.rd-dim,.rd-empty{color:var(--dim);font-size:13px}',
    '.rd-ws,.rd-pos{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:4px}',
    '.rd-ws li{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px}',
    '.rd-w{background:none;border:0;padding:6px 0;min-height:32px;color:var(--accent);font:inherit;font-weight:700;cursor:pointer;text-align:left}',
    '.rd-wn{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}',
    '.rd-a{color:var(--accent)}',
    '.rd-foot{font-size:12px;color:var(--dim);margin:10px 0 0}',
    '.rd-score{font-weight:800;font-variant-numeric:tabular-nums}',
    '.rd-parts{font-size:12px;color:var(--dim)}',
    '.rd-tablewrap{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}',
    '.rd-table{border-collapse:collapse;width:100%;font-size:13px}',
    '.rd-table caption{text-align:left;color:var(--dim);font-size:12px;padding:0 0 6px}',
    '.rd-table th,.rd-table td{border-bottom:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top}',
    '.rd-table th{font-size:11px;color:var(--dim);font-weight:700;white-space:nowrap}',
    '.rd-n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.rd-lim{border:1px solid var(--border);border-radius:var(--rad-s,11px);padding:12px 14px;margin:16px 0}',
    '.rd-lim ul{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.5;color:var(--dim)}',
    '.rd-sheet{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.6);display:flex;justify-content:center;align-items:flex-start;padding:24px 12px;overflow-y:auto}',
    '.rd-sheet-in{background:var(--bg);border:1px solid var(--border);border-radius:var(--rad,14px);padding:16px;max-width:980px;width:100%;min-width:0}',
    '.rd-close{float:right;min-height:40px;min-width:40px;background:var(--surface2);border:1px solid var(--border);border-radius:9px;color:var(--text);font:inherit;cursor:pointer}',
    '@media(max-width:520px){.rd-nums{grid-template-columns:repeat(3,minmax(0,1fr))}.rd-sent{font-size:16px}.rd-sheet{padding:8px}}'
  ].join('\n');
  U.injectStyle = function (doc) {
    try { if (!doc || doc.getElementById('edgedesk-radar-css')) return; var st = doc.createElement('style'); st.id = 'edgedesk-radar-css'; st.textContent = U.STYLE; doc.head.appendChild(st); } catch (_) { /* unstyled is still readable */ }
  };

  /* ------------------------------------------------------------ the trader sheet (the terminal) */
  /* open a trader in a sheet over the page; load(wallet) answers radar_trader */
  U.openTrader = function (doc, wallet, load) {
    if (!doc || !wallet) return;
    U.injectStyle(doc);
    var old = doc.getElementById('rdSheet'); if (old) old.remove();
    var el = doc.createElement('div');
    el.id = 'rdSheet'; el.className = 'rd-sheet'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Trader');
    el.innerHTML = '<div class="rd-sheet-in"><button type="button" class="rd-close" aria-label="Close">×</button><div class="rd-sheet-body"><p class="rd-dim">Loading…</p></div></div>';
    doc.body.appendChild(el);
    var close = function () { el.remove(); doc.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    doc.addEventListener('keydown', onKey);
    el.addEventListener('click', function (e) { if (e.target === el || (e.target.closest && e.target.closest('.rd-close'))) close(); });
    try { el.querySelector('.rd-close').focus(); } catch (_) { /* no focus */ }
    Promise.resolve(load(wallet)).then(function (r) { el.querySelector('.rd-sheet-body').innerHTML = U.traderHTML(r); })
      .catch(function () { el.querySelector('.rd-sheet-body').innerHTML = U.traderHTML({ status: 'error' }); });
  };

  return U;
}));
