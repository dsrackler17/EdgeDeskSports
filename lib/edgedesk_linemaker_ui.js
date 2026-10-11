/* ===========================================================================
   EDGEDESK FAIR LINES — the linemaker's research panel (Research → Other →
   Lines, #research/lines[/<game_id>]).

   Reads football/linemaker/fair_lines.json (tools/football/build_fair_lines.js)
   and prices with lib/edgedesk_fairline.js over lib/research_core.js, which
   app.html loads first. Nothing here computes a probability of its own.

   What a reader can do, and every control does something:
     - switch NFL / CFB, search a team, sort by kickoff or by the gap to the
       reference line;
     - open a game: the fair spread, moneyline, total and both team totals,
       each with its calibration status (against outcomes, held out) and its
       tier (against the closing line), and the alternate ladders;
     - check a price: any line and any American price, optionally the other
       side for the no-vig split; add more books and see which (if any)
       clear — "none" is a normal answer;
     - read the accountability: how each market's probabilities held up on
       seasons the model never saw, at every line and at market numbers, and
       the graded record of what this page published;
     - ask the desk about the game on screen.
   States: loading, error (with retry), empty, stale (sheets older than 18 h),
   and an integrity refusal when the feed does not carry what this page needs.

   Browser: window.EDLinemakerUI.show(host[, gameId]).
   =========================================================================== */
(function (W) {
  'use strict';
  var FEED = '/football/linemaker/fair_lines.json';
  var GRADES = '/football/linemaker/grades.json';
  var CAL = { americanfootball_nfl: '/football/validation/linemaker_nfl.json', americanfootball_ncaaf: '/football/validation/linemaker_cfb.json' };
  var STALE_H = 18;
  var S = { host: null, data: null, err: null, loading: false, league: 'NFL', q: '', sort: 'kickoff', open: null, tab: 'spread', quotes: [], cal: {}, grades: null, accOpen: false, loadedAt: null };

  function FL() { return W.EDFairLine; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pct(v, d) { var n = num(v); return n == null ? '—' : (Math.round(n * Math.pow(10, 2 + (d == null ? 1 : d))) / Math.pow(10, d == null ? 1 : d)) + '%'; }
  function am(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function ln(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + n; }
  function hrs(ms) { return Math.round(ms / 36e5 * 10) / 10; }
  function $(id) { return document.getElementById(id); }

  function kickText(g) {
    var t = Date.parse(g.kickoff); if (!isFinite(t)) return 'Kickoff unknown';
    var d = new Date(t);
    try {
      if (g.kickoff_tbd) return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · time TBA';
      return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function statusChip(m) {
    if (!m) return '';
    var st = m.status || 'UNCALIBRATED', cls = st === 'CALIBRATED' ? 'ok' : st === 'PROVISIONAL' ? 'warn' : 'none';
    return '<span class="lm-chip ' + cls + '" title="' + esc((m.status_reasons || []).join('; ') || 'Held-out calibration against outcomes') + '">' + esc(st.toLowerCase()) + '</span>';
  }
  function tierChip(m) { return m && m.tier ? '<span class="lm-chip tier" title="' + esc(m.tier_basis || '') + '">vs close: ' + esc(m.tier.toLowerCase()) + '</span>' : ''; }

  /* ------------------------------------------------------------ data */
  function feedUrl() { var d = new Date(); return FEED + '?v=' + d.getUTCFullYear() + (d.getUTCMonth() + 1) + d.getUTCDate() + d.getUTCHours(); }
  function integrity(d) {
    if (!d || d.schema !== 'edgedesk_fair_lines_v1') return 'the feed is not a fair-line sheet set (schema ' + (d && d.schema) + ')';
    if (!d.models || !Array.isArray(d.games)) return 'the feed carries no calibration models or no games';
    if (!FL() || !(W.EDResearchCore || (W.EDResearch && W.EDResearch.odds))) return 'the pricing library did not load';
    return null;
  }
  function load(force) {
    if (S.loading) return S.loading;
    if (S.data && !force) { render(); return Promise.resolve(); }
    S.err = null;
    S.loading = fetch(feedUrl(), { cache: force ? 'no-cache' : 'default' }).then(function (r) {
      if (!r.ok) throw new Error('the fair-line feed answered HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      var bad = integrity(d);
      if (bad) { S.err = { kind: 'integrity', text: bad }; S.data = null; }
      else { S.data = d; S.loadedAt = Date.now(); }
    }).catch(function (e) { S.err = { kind: 'fetch', text: (e && e.message) || 'the fair-line feed could not be read' }; })
      .then(function () { S.loading = false; render(); });
    render();
    return S.loading;
  }
  function loadCal(sport) {
    if (S.cal[sport]) return Promise.resolve(S.cal[sport]);
    return fetch(CAL[sport]).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { S.cal[sport] = d; return d; }, function (e) { S.cal[sport] = { error: (e && e.message) || 'unreadable' }; return S.cal[sport]; });
  }
  function loadGrades() {
    if (S.grades) return Promise.resolve(S.grades);
    return fetch(GRADES).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { S.grades = d; return d; }, function (e) { S.grades = { error: (e && e.message) || 'unreadable' }; return S.grades; });
  }

  function games() {
    if (!S.data) return [];
    var q = S.q.trim().toLowerCase();
    var list = S.data.games.filter(function (g) { return g.league === S.league && (!q || (String(g.home) + ' ' + String(g.away)).toLowerCase().indexOf(q) >= 0); });
    if (S.sort === 'gap') list = list.slice().sort(function (a, b) { return gapOf(b) - gapOf(a); });
    return list;
  }
  function gapOf(g) { var s = g.reference_versus && g.reference_versus.spread; return s && num(s.gap_points) != null ? Math.abs(s.gap_points) : -1; }
  function byId(id) { if (!S.data) return null; for (var i = 0; i < S.data.games.length; i++) if (String(S.data.games[i].game_id) === String(id)) return S.data.games[i]; return null; }
  function model(g) { return S.data && g ? S.data.models[g.sport] : null; }

  /* ---------------------------------------------------------- screen */
  function setScreen(g) {
    if (typeof W.edScreenSet !== 'function') return;
    try { W.edScreenSet(g ? { panel: 'lines', sport: g.sport, game_id: g.game_id, home: g.home, away: g.away, market: S.tab } : { panel: 'lines' }); } catch (e) { /* the desk is optional here */ }
  }

  /* ---------------------------------------------------------- render */
  function render() {
    var h = S.host; if (!h) return;
    if (S.open && S.data) { var g = byId(S.open); if (g) { h.innerHTML = detailHTML(g); wireDetail(g); setScreen(g); return; } S.open = null; }
    setScreen(null);
    h.innerHTML = listHTML();
    wireList();
  }
  function headHTML() {
    var d = S.data, built = d ? Date.parse(d.generated_at) : null;
    var upd = built ? 'Built ' + new Date(built).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    return '<div class="lm-head"><div class="lm-title"><h3>Fair lines</h3><small>EdgeDesk’s own price for every market, before it looks at a book. Research, not picks.</small></div>'
      + '<span class="lm-grow"></span><span class="lm-upd">' + esc(upd) + '</span>'
      + '<button class="lm-btn ghost" data-act="refresh" aria-label="Refresh the fair lines">Refresh</button></div>';
  }
  function staleHTML() {
    var d = S.data; if (!d) return '';
    var age = Date.now() - Date.parse(d.generated_at);
    if (!(age > STALE_H * 36e5)) return '';
    return '<div class="lm-banner warn" role="status"><b>Stale.</b> These sheets were built ' + hrs(age) + ' hours ago. The projections behind them may have moved since; nothing here updates itself.</div>';
  }
  function listHTML() {
    var out = headHTML();
    if (S.loading && !S.data) return out + '<div class="lm-empty" role="status">Loading the fair lines…</div>';
    if (S.err) {
      return out + '<div class="lm-banner err" role="alert"><b>' + (S.err.kind === 'integrity' ? 'Fair lines are unavailable.' : 'The fair lines could not be loaded.') + '</b> ' + esc(S.err.text) + '. Nothing is shown in their place.'
        + ' <button class="lm-btn" data-act="retry">Try again</button></div>';
    }
    if (!S.data) return out;
    var nfl = S.data.counts.nfl, cfb = S.data.counts.cfb;
    out += staleHTML();
    out += '<div class="lm-ctl"><div class="lm-seg" role="tablist" aria-label="League">'
      + '<button role="tab" data-league="NFL" class="' + (S.league === 'NFL' ? 'on' : '') + '" aria-selected="' + (S.league === 'NFL') + '">NFL <span class="lm-n">' + nfl + '</span></button>'
      + '<button role="tab" data-league="CFB" class="' + (S.league === 'CFB' ? 'on' : '') + '" aria-selected="' + (S.league === 'CFB') + '">CFB <span class="lm-n">' + cfb + '</span></button></div>'
      + '<input class="lm-in" id="lmSearch" type="search" placeholder="Team" aria-label="Search a team" value="' + esc(S.q) + '">'
      + '<label class="lm-lab">Sort <select class="lm-in" id="lmSort" aria-label="Sort games"><option value="kickoff"' + (S.sort === 'kickoff' ? ' selected' : '') + '>Kickoff</option><option value="gap"' + (S.sort === 'gap' ? ' selected' : '') + '>Gap to reference</option></select></label></div>';
    var list = games();
    if (!list.length) {
      var ref = (S.data.refused || []).filter(function (r) { return (S.league === 'NFL' ? r.sport === 'americanfootball_nfl' : r.sport === 'americanfootball_ncaaf'); }).length;
      out += '<div class="lm-empty">' + (S.q ? 'No ' + S.league + ' game matches “' + esc(S.q) + '”.' : 'No upcoming ' + S.league + ' game is priced right now.') + (ref ? ' ' + ref + ' game' + (ref === 1 ? ' was' : 's were') + ' refused for missing inputs.' : '') + '</div>';
      return out + footHTML();
    }
    out += '<div class="lm-list" role="list">' + list.map(cardHTML).join('') + '</div>';
    return out + footHTML();
  }
  function cardHTML(g) {
    var m = g.markets, rv = g.reference_versus;
    var sp = m.spread ? esc(g.home) + ' ' + ln(m.spread.fair_home_line_half) : '—';
    var ref = rv && rv.spread ? '<span class="lm-ref" title="' + esc(rv.source) + '">ref ' + ln(rv.spread.home_line) + ' · gap ' + ln(rv.spread.gap_points) + '</span>' : '<span class="lm-ref none">no reference line</span>';
    return '<button class="lm-card" role="listitem" data-game="' + esc(g.game_id) + '" aria-label="' + esc(g.away + ' at ' + g.home) + '">'
      + '<div class="lm-mu"><b>' + esc(g.away) + '</b> @ <b>' + esc(g.home) + '</b>' + (g.neutral_site ? ' <span class="lm-chip none">neutral</span>' : '') + '</div>'
      + '<div class="lm-ko">' + esc(kickText(g)) + '</div>'
      + '<div class="lm-row"><span class="k">Spread</span><span class="v num">' + sp + '</span>' + statusChip(m.spread) + ref + '</div>'
      + '<div class="lm-row"><span class="k">Total</span><span class="v num">' + (m.total ? m.total.fair_total_half : '—') + '</span>' + statusChip(m.total)
      + '<span class="k">Team</span><span class="v num">' + (m.team_total ? m.team_total.away_fair_half + ' – ' + m.team_total.home_fair_half : '—') + '</span></div>'
      + '<div class="lm-row"><span class="k">Moneyline</span><span class="v num">' + (m.moneyline ? am(m.moneyline.away_fair) + ' / ' + am(m.moneyline.home_fair) : '—') + '</span>' + statusChip(m.moneyline) + '</div></button>';
  }
  function footHTML() {
    return '<p class="lm-foot">A fair line is EdgeDesk’s own number from its projection; a reference line is shown beside it for comparison and is never a price. “Calibrated” means the probabilities matched outcomes on seasons the model never saw. It does not mean they beat the closing line, which is a separate record shown as “vs close”. No surface here places or recommends a bet.</p>';
  }

  /* -------------------------------------------------------- detail */
  function detailHTML(g) {
    var m = g.markets, md = model(g), rv = g.reference_versus;
    var out = '<div class="lm-dhead"><button class="lm-btn ghost" data-act="back" aria-label="Back to the game list">← Games</button>'
      + '<div class="lm-mu big"><b>' + esc(g.away) + '</b> @ <b>' + esc(g.home) + '</b></div><div class="lm-ko">' + esc(g.league + ' · ' + kickText(g)) + (g.neutral_site ? ' · neutral site' : '') + '</div>'
      + '<button class="lm-btn acc" data-act="ask">Ask EdgeDesk about this game</button></div>';
    out += staleHTML();
    out += '<div class="lm-scroll"><table class="lm-tab main"><thead><tr><th>Market</th><th>Fair</th><th>Probability</th><th>Fair price</th><th>Calibration</th><th>Vs close</th></tr></thead><tbody>';
    if (m.spread) out += '<tr><td>Spread</td><td class="num">' + esc(g.home) + ' ' + ln(m.spread.fair_home_line_half) + '</td><td class="num">' + (m.spread.at_fair ? pct(m.spread.at_fair.home) + ' / ' + pct(m.spread.at_fair.away) + (m.spread.at_fair.push > 0.001 ? ' (push ' + pct(m.spread.at_fair.push) + ')' : '') : '—') + '</td><td class="num">at ' + ln(m.spread.fair_home_line_half) + '</td><td>' + statusChip(m.spread) + '</td><td>' + tierChip(m.spread) + '</td></tr>';
    if (m.moneyline) out += '<tr><td>Moneyline</td><td class="num">' + esc(g.home) + ' ' + pct(m.moneyline.home_win) + '</td><td class="num">' + pct(m.moneyline.home_win) + ' / ' + pct(m.moneyline.away_win) + (m.moneyline.tie > 0 ? ' (tie ' + pct(m.moneyline.tie) + ')' : '') + '</td><td class="num">' + am(m.moneyline.home_fair) + ' / ' + am(m.moneyline.away_fair) + '</td><td>' + statusChip(m.moneyline) + '</td><td>' + tierChip(m.moneyline) + '</td></tr>';
    if (m.total) out += '<tr><td>Total</td><td class="num">' + m.total.fair_total_half + '</td><td class="num">range ' + (m.total.total_p10 != null ? m.total.total_p10 + '–' + m.total.total_p90 : '—') + '</td><td class="num">—</td><td>' + statusChip(m.total) + '</td><td>' + tierChip(m.total) + '</td></tr>';
    if (m.team_total) out += '<tr><td>Team totals</td><td class="num">' + esc(g.away) + ' ' + m.team_total.away_fair_half + ' · ' + esc(g.home) + ' ' + m.team_total.home_fair_half + '</td><td class="num">' + m.team_total.away_p10 + '–' + m.team_total.away_p90 + ' · ' + m.team_total.home_p10 + '–' + m.team_total.home_p90 + '</td><td class="num">—</td><td>' + statusChip(m.team_total) + '</td><td>' + tierChip(m.team_total) + '</td></tr>';
    out += '</tbody></table></div>';
    out += '<p class="lm-note">Ranges are the 10th to 90th percentile of EdgeDesk’s own distribution. The probability on a spread is at the fair half point, so it is close to an even split by construction.</p>';
    if (rv) {
      out += '<div class="lm-ref-box"><b>Reference line</b> <span class="lm-dim">' + esc(rv.source) + (rv.observed_at ? ', observed ' + esc(new Date(rv.observed_at).toLocaleString()) : '') + '. A comparison, not a price: no expected value is computed against it.</span><ul>';
      if (rv.spread) out += '<li>Spread ' + esc(g.home) + ' ' + ln(rv.spread.home_line) + ': EdgeDesk’s fair line is ' + ln(m.spread && m.spread.fair_home_line) + ' (gap ' + ln(rv.spread.gap_points) + '). At that number EdgeDesk gives ' + esc(g.home) + ' ' + pct(rv.spread.home_cover) + ' to cover' + (rv.spread.push > 0.001 ? ', push ' + pct(rv.spread.push) : '') + '.</li>';
      if (rv.total) out += '<li>Total ' + rv.total.line + ': fair ' + (m.total && m.total.fair_total) + ' (gap ' + ln(rv.total.gap_points) + '); over ' + pct(rv.total.over) + '.</li>';
      if (rv.moneyline) out += '<li>Moneyline ' + am(rv.moneyline.away_ml) + ' / ' + am(rv.moneyline.home_ml) + ': no-vig ' + esc(g.home) + ' ' + pct(rv.moneyline.no_vig && rv.moneyline.no_vig.a) + ' against EdgeDesk’s ' + pct(m.moneyline && m.moneyline.home_win) + '.</li>';
      out += '</ul></div>';
    }
    /* the ladders */
    var tabs = [['spread', 'Alt spreads'], ['total', 'Alt totals'], ['away_team_total', g.away + ' total'], ['home_team_total', g.home + ' total']];
    out += '<div class="lm-tabs" role="tablist" aria-label="Alternate lines">' + tabs.map(function (t) { return '<button role="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '" aria-selected="' + (S.tab === t[0]) + '">' + esc(t[1]) + '</button>'; }).join('') + '</div>';
    out += '<div class="lm-scroll" id="lmLadder">' + ladderHTML(g, S.tab) + '</div>';
    out += checkHTML(g);
    out += '<details class="lm-acc" id="lmAcc"' + (S.accOpen ? ' open' : '') + '><summary>How these numbers have held up</summary><div id="lmAccBody">' + (S.accOpen ? accHTML(g) : '') + '</div></details>';
    out += footHTML();
    return out;
  }
  function ladderHTML(g, key) {
    var rows = FL().ladder(g, key);
    if (!rows.length) return '<div class="lm-empty">This ladder is not available for this game.</div>';
    var m = g.markets, fairKey, refKey = null;
    if (key === 'spread') {
      fairKey = m.spread && m.spread.fair_home_line_half; refKey = g.reference_versus && g.reference_versus.spread ? g.reference_versus.spread.home_line : null;
      return '<table class="lm-tab"><thead><tr><th>' + esc(g.home) + ' line</th><th>' + esc(g.home) + ' covers</th><th>Push</th><th>' + esc(g.away) + ' covers</th><th>Fair ' + esc(g.home) + '</th><th>Fair ' + esc(g.away) + '</th></tr></thead><tbody>'
        + rows.map(function (r) { var cls = r.home_line === fairKey ? ' class="fair"' : r.home_line === refKey ? ' class="ref"' : ''; return '<tr' + cls + '><td class="num">' + ln(r.home_line) + '</td><td class="num">' + pct(r.home) + '</td><td class="num">' + (r.push > 0.0005 ? pct(r.push) : '—') + '</td><td class="num">' + pct(r.away) + '</td><td class="num">' + am(r.home_fair) + '</td><td class="num">' + am(r.away_fair) + '</td></tr>'; }).join('')
        + '</tbody></table>' + legend(refKey != null);
    }
    fairKey = key === 'total' ? (m.total && m.total.fair_total_half) : key === 'home_team_total' ? (m.team_total && m.team_total.home_fair_half) : (m.team_total && m.team_total.away_fair_half);
    if (key === 'total' && g.reference_versus && g.reference_versus.total) refKey = g.reference_versus.total.line;
    return '<table class="lm-tab"><thead><tr><th>Line</th><th>Over</th><th>Push</th><th>Under</th><th>Fair over</th><th>Fair under</th></tr></thead><tbody>'
      + rows.map(function (r) { var cls = r.line === fairKey ? ' class="fair"' : r.line === refKey ? ' class="ref"' : ''; return '<tr' + cls + '><td class="num">' + r.line + '</td><td class="num">' + pct(r.over) + '</td><td class="num">' + (r.push > 0.0005 ? pct(r.push) : '—') + '</td><td class="num">' + pct(r.under) + '</td><td class="num">' + am(r.over_fair) + '</td><td class="num">' + am(r.under_fair) + '</td></tr>'; }).join('')
      + '</tbody></table>' + legend(refKey != null);
  }
  function legend(hasRef) { return '<p class="lm-note"><span class="lm-key fair"></span> EdgeDesk’s fair number' + (hasRef ? ' · <span class="lm-key ref"></span> the reference line' : '') + '. Fair prices carry no vig.</p>'; }

  /* ------------------------------------------------------ price check */
  function sideOptions(market, g) {
    if (market === 'spread' || market === 'moneyline') return [['home', g.home], ['away', g.away]];
    return [['over', 'Over'], ['under', 'Under']];
  }
  function checkHTML(g) {
    var out = '<section class="lm-check" aria-label="Check a price"><h4>Check a price</h4><p class="lm-dim">Enter what a book offers. EdgeDesk prices that exact line with its own probability; the verdict reads how probabilities like this one did at numbers the market actually posted, on seasons the model never saw.</p>'
      + '<div class="lm-form"><label>Market <select class="lm-in" id="lmMk"><option value="spread">Spread</option><option value="total">Total</option><option value="tt_away">' + esc(g.away) + ' team total</option><option value="tt_home">' + esc(g.home) + ' team total</option><option value="moneyline">Moneyline</option></select></label>'
      + '<label>Side <select class="lm-in" id="lmSide"></select></label>'
      + '<label id="lmLineL">Line <input class="lm-in num" id="lmLine" type="number" step="0.5" inputmode="decimal"></label>'
      + '<label>Price <input class="lm-in num" id="lmOdds" type="number" step="1" inputmode="numeric" placeholder="-110"></label>'
      + '<label>Other side <input class="lm-in num" id="lmOther" type="number" step="1" inputmode="numeric" placeholder="optional"></label>'
      + '<label>Book <input class="lm-in" id="lmBook" type="text" maxlength="24" placeholder="optional"></label>'
      + '<div class="lm-fbtn"><button class="lm-btn acc" data-act="check">Check</button><button class="lm-btn" data-act="add">Add to comparison</button></div></div>'
      + '<div id="lmResult" aria-live="polite"></div><div id="lmCompare"></div></section>';
    return out;
  }
  function readForm(g) {
    var mk = $('lmMk').value, side = $('lmSide').value;
    var q = { game_id: g.game_id, market: mk.indexOf('tt_') === 0 ? 'team_total' : mk, side: side, line: num($('lmLine').value), american: num($('lmOdds').value), book: ($('lmBook').value || '').trim().slice(0, 24) || null };
    if (mk === 'tt_home') q.team = 'home'; if (mk === 'tt_away') q.team = 'away';
    q.other = num($('lmOther').value);
    return q;
  }
  function verdictHTML(g, r, q) {
    var cls = r.verdict === 'VALUE' ? 'ok' : r.verdict === 'THIN' ? 'warn' : r.verdict === 'NO_VALUE' ? 'neg' : 'none';
    var out = '<div class="lm-res"><div class="lm-res-h"><span class="lm-verdict ' + cls + '">' + esc(r.verdict.replace('_', ' ')) + '</span> <b>' + esc(describe(g, q)) + '</b></div>';
    if (r.verdict === 'CANNOT_EVALUATE') return out + '<p>' + esc(r.why.join(' ')) + '</p></div>';
    out += '<dl class="lm-dl"><div><dt>EdgeDesk</dt><dd class="num">' + pct(r.cover_prob) + (r.probs && r.probs.push > 0.0005 ? ' <small>(push ' + pct(r.probs.push) + ')</small>' : '') + '</dd></div>'
      + '<div><dt>Break-even</dt><dd class="num">' + pct(r.break_even) + '</dd></div>'
      + '<div><dt>Expected return</dt><dd class="num">' + (r.expected_roi == null ? '—' : (r.expected_roi > 0 ? '+' : '') + pct(r.expected_roi)) + ' <small>per unit</small></dd></div>'
      + '<div><dt>Fair price</dt><dd class="num">' + am(r.fair_american) + '</dd></div>';
    if (r.market_tested_cover != null) out += '<div><dt>At market numbers</dt><dd class="num">' + pct(r.market_tested_cover) + ' <small>held out, n ' + r.band.n + '</small></dd></div>';
    if (q.other != null && q.market !== 'team_total') {
      var nv = FL().noVig(q.american, q.other);
      if (nv) out += '<div><dt>No-vig market</dt><dd class="num">' + pct(nv.a) + ' <small>overround ' + pct(nv.overround) + '</small></dd></div>';
    }
    out += '</dl><ul class="lm-why">' + r.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    return out;
  }
  function describe(g, q) {
    if (q.market === 'moneyline') return (q.side === 'home' ? g.home : g.away) + ' moneyline ' + am(q.american);
    if (q.market === 'spread') return (q.side === 'home' ? g.home : g.away) + ' ' + ln(q.line) + ' at ' + am(q.american);
    var who = q.market === 'team_total' ? (q.team === 'home' ? g.home : g.away) + ' team total ' : 'Total ';
    return who + (q.side === 'over' ? 'over ' : 'under ') + q.line + ' at ' + am(q.american);
  }
  function compareHTML(g) {
    if (!S.quotes.length) return '';
    var map = {}; map[g.game_id] = g;
    var models = {}; models[g.sport] = model(g);
    var rk = FL().rankQuotes(map, S.quotes, models);
    var out = '<div class="lm-cmp"><div class="lm-cmp-h"><b>Comparison</b> <span class="lm-dim">' + rk.qualified + ' of ' + rk.evaluated.length + ' clear' + (rk.qualified === 1 ? 's' : '') + '.' + (rk.qualified ? '' : ' None qualifying is a normal answer.') + '</span> <button class="lm-btn ghost" data-act="clear">Clear</button></div><ol>';
    rk.evaluated.slice().sort(function (a, b) { var o = { VALUE: 0, THIN: 1, NO_VALUE: 2, CANNOT_EVALUATE: 3 }; return (o[a.verdict] - o[b.verdict]) || ((b.conservative_roi || -9) - (a.conservative_roi || -9)); })
      .forEach(function (r, i) { var q = S.quotes[rk.evaluated.indexOf(r)] || {}; out += '<li><span class="lm-verdict ' + (r.verdict === 'VALUE' ? 'ok' : r.verdict === 'THIN' ? 'warn' : r.verdict === 'NO_VALUE' ? 'neg' : 'none') + '">' + esc(r.verdict.replace('_', ' ')) + '</span> ' + esc(describe(g, q)) + (r.book ? ' <span class="lm-dim">' + esc(r.book) + '</span>' : '') + (r.expected_roi != null ? ' <span class="num">' + (r.expected_roi > 0 ? '+' : '') + pct(r.expected_roi) + '</span>' : '') + '</li>'; });
    return out + '</ol></div>';
  }

  /* ---------------------------------------------------- accountability */
  function accHTML(g) {
    var c = S.cal[g.sport];
    if (!c) return '<div class="lm-empty" role="status">Loading the calibration record…</div>';
    if (c.error) return '<div class="lm-banner err" role="alert">The calibration record could not be read (' + esc(c.error) + ').</div>';
    var out = '<p class="lm-dim">Replay: ' + esc(c.frame.replay) + '. Seasons ' + esc(c.frame.windows.selection.join('–')) + ' chose each method; ' + esc(c.frame.windows.confirmation.join('–')) + ' confirmed it; ' + esc(c.frame.windows.live) + ' is the live season. ' + esc(c.frame.caveat) + '</p>';
    out += '<div class="lm-scroll"><table class="lm-tab"><thead><tr><th>Market</th><th>Method</th><th>Status</th><th>Log loss (confirm)</th><th>Next best</th><th>At market numbers</th></tr></thead><tbody>';
    ['spread', 'moneyline', 'total', 'team_total'].forEach(function (mk) {
      var m = c.markets[mk]; if (!m) return;
      var ch = m.candidates.filter(function (x) { return x.method === m.chosen; })[0] || {};
      var rest = m.candidates.filter(function (x) { return x.method !== m.chosen && x.confirmation.log_loss != null; }).sort(function (a, b) { return a.confirmation.log_loss - b.confirmation.log_loss; })[0];
      var am_ = m.at_market;
      out += '<tr><td>' + esc(mk.replace('_', ' ')) + '</td><td>' + esc(m.chosen) + '</td><td>' + statusChip({ status: m.status, status_reasons: m.status_reasons }) + '</td><td class="num">' + (ch.confirmation ? ch.confirmation.log_loss : '—') + ' <small>n ' + (ch.confirmation ? ch.confirmation.n : 0) + '</small></td><td class="num">' + (rest ? esc(rest.method) + ' ' + rest.confirmation.log_loss : '—') + '</td><td class="num">' + (am_ ? 'slope ' + am_.slope + ' <small>n ' + am_.n + '</small>' : 'never tested') + '</td></tr>';
    });
    out += '</tbody></table></div><p class="lm-note">A calibration slope near 1 means the probabilities separate outcomes as much as they claim; near 0 means they barely separate them at all. At the numbers the market posted, EdgeDesk’s slope is far below 1: when it disagrees with a market number, the market has usually been right.</p>';
    var gr = S.grades;
    if (gr && !gr.error) {
      var key = g.league, x = gr.groups && gr.groups[key];
      out += '<h5>What this page published, graded</h5>';
      if (!x) out += '<p class="lm-dim">' + (gr.counts ? gr.counts.graded : 0) + ' published sheets have a result so far; nothing to grade for the ' + esc(g.league) + ' yet.</p>';
      else out += '<ul class="lm-why"><li>Moneyline: Brier ' + (x.moneyline.brier == null ? '—' : x.moneyline.brier) + ' over ' + x.moneyline.n + ' games (' + esc(x.moneyline.sample_state) + ').</li><li>Spread at the closing number: Brier ' + (x.spread_at_close.brier == null ? '—' : x.spread_at_close.brier) + ', n ' + x.spread_at_close.n + ' (' + esc(x.spread_at_close.sample_state) + ').</li><li>Fair margin error: MAE ' + (x.margin_error.mae == null ? '—' : x.margin_error.mae) + ' points, n ' + x.margin_error.n + '.</li><li>The market moved toward EdgeDesk’s spread ' + (x.movement_spread.n ? pct(x.movement_spread.share_toward) + ' of the time, n ' + x.movement_spread.n + ' (' + esc(x.movement_spread.sample_state) + ')' : '— no reference and close on file yet') + '.</li></ul>';
    } else if (gr && gr.error) out += '<p class="lm-dim">The graded record could not be read (' + esc(gr.error) + ').</p>';
    return out;
  }

  /* ----------------------------------------------------------- wiring */
  function wireList() {
    var h = S.host;
    h.onclick = function (e) {
      var t = e.target.closest ? e.target.closest('[data-act],[data-league],[data-game]') : null; if (!t) return;
      if (t.dataset.act === 'refresh' || t.dataset.act === 'retry') { load(true); return; }
      if (t.dataset.league) { S.league = t.dataset.league; render(); return; }
      if (t.dataset.game) { openGame(t.dataset.game, true); }
    };
    var s = $('lmSearch'); if (s) s.oninput = function () { S.q = s.value; var pos = s.selectionStart; render(); var n = $('lmSearch'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (er) { /* type=search */ } } };
    var so = $('lmSort'); if (so) so.onchange = function () { S.sort = so.value; render(); };
  }
  function wireDetail(g) {
    var h = S.host;
    h.onclick = function (e) {
      var t = e.target.closest ? e.target.closest('[data-act],[data-tab]') : null; if (!t) return;
      if (t.dataset.tab) { S.tab = t.dataset.tab; var L = $('lmLadder'); if (L) L.innerHTML = ladderHTML(g, S.tab); var bs = h.querySelectorAll('.lm-tabs button'); for (var i = 0; i < bs.length; i++) { var on = bs[i].dataset.tab === S.tab; bs[i].classList.toggle('on', on); bs[i].setAttribute('aria-selected', on ? 'true' : 'false'); } setScreen(g); return; }
      var a = t.dataset.act;
      if (a === 'back') { closeGame(true); return; }
      if (a === 'ask') { if (typeof W.edAsk === 'function') W.edAsk('What is EdgeDesk’s fair price for ' + g.away + ' at ' + g.home + ', and why?', 'lines'); return; }
      if (a === 'check' || a === 'add') {
        var q = readForm(g), r = FL().priceCheck(g, q, model(g));
        $('lmResult').innerHTML = verdictHTML(g, r, q);
        if (a === 'add' && r.verdict !== 'CANNOT_EVALUATE') { S.quotes.push(q); $('lmCompare').innerHTML = compareHTML(g); }
        return;
      }
      if (a === 'clear') { S.quotes = []; $('lmCompare').innerHTML = ''; }
    };
    var mk = $('lmMk'), side = $('lmSide'), line = $('lmLine');
    function syncSides() {
      var market = mk.value.indexOf('tt_') === 0 ? 'team_total' : mk.value;
      side.innerHTML = sideOptions(market, g).map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join('');
      var lab = $('lmLineL'); if (lab) lab.classList.toggle('hide', market === 'moneyline');
      var m = g.markets;
      line.value = market === 'spread' ? (m.spread ? m.spread.fair_home_line_half : '') : market === 'total' ? (m.total ? m.total.fair_total_half : '') : market === 'team_total' ? (m.team_total ? (mk.value === 'tt_home' ? m.team_total.home_fair_half : m.team_total.away_fair_half) : '') : '';
    }
    mk.onchange = function () { syncSides(); };
    side.onchange = function () { if ((mk.value === 'spread') && line.value !== '') line.value = String(-num(line.value)); };
    syncSides();
    var acc = $('lmAcc');
    if (acc) acc.addEventListener('toggle', function () {
      S.accOpen = acc.open;
      if (!acc.open) return;
      Promise.all([loadCal(g.sport), loadGrades()]).then(function () { var b = $('lmAccBody'); if (b && S.open === g.game_id) b.innerHTML = accHTML(g); });
      var b = $('lmAccBody'); if (b) b.innerHTML = accHTML(g);
    });
    if (S.quotes.length) $('lmCompare').innerHTML = compareHTML(g);
  }
  function openGame(id, push) {
    var g = byId(id); if (!g) return;
    if (S.open !== String(id)) { S.quotes = []; S.tab = 'spread'; }
    S.open = String(id);
    S.league = g.league;
    render();
    try { if (push && typeof W.researchSetHash === 'function') W.researchSetHash('lines', id, true); else if (push) location.hash = '#research/lines/' + encodeURIComponent(id); } catch (e) { /* hash routing is optional */ }
    try { window.scrollTo(0, 0); } catch (e) { /* no window */ }
  }
  function closeGame(push) {
    S.open = null; S.quotes = []; render();
    try { if (push) history.replaceState(null, '', location.pathname + location.search + '#research/lines'); } catch (e) { /* ignore */ }
  }

  W.EDLinemakerUI = {
    show: function (host, gameId) {
      if (!host) return;
      S.host = host;
      if (gameId) S.open = String(gameId);
      return load(false);
    },
    refresh: function () { return load(true); },
    openGame: function (id) { if (!S.data) { S.open = String(id); return load(false); } openGame(id, false); },
    closeGame: function () { closeGame(false); },
    entityOpen: function () { return !!S.open; },
    entityKey: function () { return S.open; },
    hasData: function () { return !!S.data; },
    freshness: function () { return { loadedAt: S.loadedAt, builtAt: S.data ? Date.parse(S.data.generated_at) : null }; },
    _state: S
  };
})(typeof window !== 'undefined' ? window : this);
