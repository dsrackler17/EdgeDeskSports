/* ===========================================================================
   EDGEDESK SIMULATOR — WNBA postseason (registered with EDSimUI.registerSport).

   Three tabs, all from the published run (supabase/simulator.sql sim_*):
     Finals        the series as it stands (Observed), each finalist's title
                   chance, every exact result (Atlanta in 5, in 6, ...) with
                   fair decimal and American odds, and the bracket so far
     Games         every remaining game: how often it is played, the home
                   side's chance when it is, beside the served board price;
                   then every played playoff game with the model's pre-game
                   probability (Observed results)
     Model Health  the served model's own record: Brier and log loss on
                   this postseason, this season and every postseason since
                   2010, beside a coin and the home-win rate; calibration;
                   the shared series offset and its holdout

   The per-game numbers ride in the run's validation_summary.sport_summary
   (simulator/src/sports/wnba/run.ts readerSummary). Every value reaches the
   page through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('wnba', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, cell = U.cell, when = U.when, isNum = U.isNum;
  var ROUND = { 1: 'First round', 2: 'Semifinals', 3: 'Finals' };

  /* ------------------------------------------------------------ helpers */
  function pct(x, d) { return isNum(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
  /* fair American odds from a probability (no margin): -150 for 60%, +150 for 40% */
  function american(p) {
    if (!isNum(p) || p <= 0 || p >= 1) return '—';
    var v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return (v > 0 ? '+' : '') + Math.round(v);
  }
  function decimal(p) { return isNum(p) && p > 0 ? (1 / p).toFixed(2) : '—'; }
  function summary(c) { return (c.run && c.run.validation_summary && c.run.validation_summary.sport_summary) || null; }
  function teamName(c, id) { var e = (c.entities || []).filter(function (x) { return x.entity_id === id; })[0]; return e ? e.entity_name : id; }
  function outcomes(c) {
    var by = {};
    (c.results || []).forEach(function (r) { (by[r.entity_id] = by[r.entity_id] || {})[r.outcome] = r; });
    return by;
  }
  /* a club's nickname, the last word of its name (Dream, Valkyries, Aces): every WNBA club's is distinct; the full name rides in the tooltip */
  function nick(c, id) { var n = teamName(c, id); var w = String(n).trim().split(/\s+/); return '<span title="' + esc(n) + '">' + esc(w[w.length - 1] || n) + '</span>'; }
  function score(g) { return isNum(g.hs) && isNum(g.as) ? g.as + '–' + g.hs + (g.ot ? ' OT' : '') : ''; }
  function shortDate(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch (_) { return iso.slice(0, 10); } }

  /* ------------------------------------------------------------ Finals */
  function seriesLine(c, s) {
    var a = s.teams[0], b = s.teams[1], wa = s.wins[a] || 0, wb = s.wins[b] || 0;
    var lead = wa === wb ? 'Series tied ' + wa + '–' + wb : (wa > wb ? teamName(c, a) : teamName(c, b)) + (s.winner ? ' won ' : ' leads ') + Math.max(wa, wb) + '–' + Math.min(wa, wb);
    return lead + (s.winner ? '' : ' · first to ' + s.wins_needed);
  }
  function renderFinals(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no series summary.</div>';
    var fin = S.series.filter(function (s) { return s.key === S.final_series; })[0];
    var O = outcomes(c);
    var ids = fin.teams.slice().sort(function (x, y) { var px = O[x] && O[x].win_title ? O[x].win_title.probability : 0, py = O[y] && O[y].win_title ? O[y].win_title.probability : 0; return py - px; });
    var next = (S.remaining || [])[0];
    var head = '<div class="sm-card"><div class="sm-h">' + esc(ROUND[fin.round] || 'Final round') + ' ' + badge('Observed') + '</div><div class="sm-big" style="font-size:18px">' + esc(seriesLine(c, fin)) + '</div>'
      + '<div class="sm-dim sm-small">' + fin.games.filter(function (g) { return g.status === 'FINAL'; }).map(function (g) { return 'G' + g.n + ' ' + esc(teamName(c, g.away)) + ' ' + esc(score(g)) + ' ' + esc(teamName(c, g.home)); }).join(' · ') + '</div>'
      + (next ? '<div class="sm-small" style="margin-top:6px">Next: game ' + esc(next.n) + ', ' + esc(shortDate(next.start_utc)) + ' at ' + esc(teamName(c, next.home)) + '</div>' : '') + '</div>';
    var cards = '<div class="sm-cards">' + ids.map(function (id) {
      var o = (O[id] || {}).win_title, f = U.fmtProb(o);
      return '<div class="sm-club"><div class="sm-club-h"><b>' + esc(teamName(c, id)) + '</b></div><div class="sm-big" title="' + esc(f.title) + '">' + esc(f.text) + ' <span class="sm-pm">' + esc(U.fmtPm(o)) + '</span></div>'
        + '<div class="sm-dim">' + badge('Research') + ' win the title · fair ' + esc(decimal(o && o.probability)) + ' (' + esc(american(o && o.probability)) + ')</div></div>';
    }).join('') + '</div>';
    var rows = [];
    ids.forEach(function (id) { for (var k = fin.wins_needed; k <= fin.best_of; k++) { var o = (O[id] || {})['title_in_' + k]; if (o && o.outcome_count > 0) rows.push({ id: id, k: k, o: o }); } });
    rows.sort(function (x, y) { return y.o.probability - x.o.probability; });
    var exact = '<div class="sm-card"><div class="sm-h">Exact series result ' + badge('Research') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Result</th><th>Chance</th><th>Fair decimal</th><th>Fair American</th></tr></thead><tbody>'
      + rows.map(function (r) { return '<tr><td><b>' + esc(teamName(c, r.id)) + '</b> in ' + esc(r.k) + '</td>' + cell(r.o) + '<td class="sm-num">' + esc(decimal(r.o.probability)) + '</td><td class="sm-num">' + esc(american(r.o.probability)) + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">Each result sums with the others to 100%. Fair odds carry no bookmaker margin: compare them with a price after removing its vig.</div></div>';
    var bracket = '<div class="sm-card"><div class="sm-h">The bracket so far ' + badge('Observed') + '</div><ul class="sm-list">'
      + S.series.slice().sort(function (x, y) { return x.round - y.round; }).map(function (s) { return '<li><b>' + esc(ROUND[s.round] || 'Round ' + s.round) + ':</b> ' + esc(s.names.join(' v ')) + ' — ' + esc(seriesLine(c, s)) + '</li>'; }).join('') + '</ul></div>';
    return head + cards + exact + bracket;
  }

  /* ------------------------------------------------------------ Games */
  function renderGames(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no game summary.</div>';
    var rem = S.remaining || [];
    var up = '<div class="sm-card"><div class="sm-h">Games left ' + badge('Research') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Game</th><th>Matchup</th><th title="Share of simulated series in which this game is played">Played</th><th title="The home side wins, in the simulated series where the game is played">Home wins if played</th><th title="The served model\'s price of the game today, as on the basketball board">Board price (home)</th><th>Fair (home)</th><th>Date</th></tr></thead><tbody>'
      + rem.map(function (g) {
        return '<tr><td>G' + esc(g.n) + '</td><td>' + nick(c, g.away) + ' <span class="sm-dim">at</span> <b>' + nick(c, g.home) + '</b></td>'
          + '<td class="sm-num">' + esc(pct(g.p_played)) + '</td><td class="sm-num">' + esc(pct(g.p_home_given_played)) + '</td><td class="sm-num">' + esc(pct(g.served_p_home)) + '</td><td class="sm-num">' + esc(american(g.served_p_home)) + '</td><td>' + esc(shortDate(g.start_utc)) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="sm-foot">“Board price” is the served model’s chance for the home side today, as on the basketball board. “Home wins if played” can differ from it: a game 6 or 7 is reached only in some series paths, and reaching it says something about the two clubs (the shared series offset). Fair odds are the board price with no margin.</div></div>';
    var played = [];
    S.series.forEach(function (s) { s.games.forEach(function (g) { if (g.status === 'FINAL') played.push({ s: s, g: g }); }); });
    played.sort(function (x, y) { return x.g.start_utc < y.g.start_utc ? 1 : -1; });
    var past = '<div class="sm-card"><div class="sm-h">Played ' + badge('Observed') + ' with the model’s pre-game chance</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Game</th><th>Matchup</th><th>Score</th><th title="The served model’s point-in-time chance for the home side before tip-off">Model: home</th><th>Favourite won</th><th>Date</th></tr></thead><tbody>'
      + played.map(function (x) {
        var g = x.g, p = g.p_home_pregame, hw = g.hs > g.as;
        var fav = isNum(p) ? ((p >= 0.5) === hw ? 'yes' : 'no') : '—';
        return '<tr><td>' + esc((ROUND[x.s.round] || 'R' + x.s.round) + ' G' + g.n) + '</td><td>' + nick(c, g.away) + ' <span class="sm-dim">at</span> ' + nick(c, g.home) + '</td><td class="sm-num">' + esc(score(g)) + '</td><td class="sm-num">' + esc(pct(p)) + '</td><td>' + esc(fav) + '</td><td>' + esc(shortDate(g.start_utc)) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
    return up + past;
  }

  /* ------------------------------------------------------------ Model Health */
  function renderHealth(c) {
    var S = summary(c); if (!S || !S.model_health) return '<div class="sm-card sm-empty">This run carries no model record.</div>';
    var H = S.model_health, t = S.shared_offset || {};
    var f3 = function (x) { return isNum(x) ? x.toFixed(3) : '—'; };
    var w = '<div class="sm-card"><div class="sm-h">The served model’s record ' + badge('Observed') + '</div><p class="sm-dim sm-small">Every forecast below was made before tip-off from data available then (the basketball walk-forward), and scored against the result. Lower Brier and log loss are better; a coin scores a log loss of 0.693.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Games</th><th>N</th><th>Brier</th><th>Log loss</th><th title="Always 50%">Coin</th><th title="The home-win rate of the three seasons before">Home-win rate</th><th>Favourite won</th></tr></thead><tbody>'
      + H.windows.map(function (x) { return '<tr><td>' + esc(x.label) + '</td><td class="sm-num">' + esc(U.int(x.n)) + '</td><td class="sm-num">' + esc(f3(x.brier)) + '</td><td class="sm-num">' + esc(f3(x.log_loss)) + '</td><td class="sm-num">' + esc(f3(x.coin_log_loss)) + '</td><td class="sm-num">' + esc(f3(x.home_rate_log_loss)) + '</td><td class="sm-num">' + esc(pct(x.accuracy)) + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">A handful of playoff games says little on its own: the long windows carry the evidence. The model has never been compared with closing prices.</div></div>';
    var cal = '<div class="sm-card"><div class="sm-h">Calibration, playoff games since 2010</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Model chance (home)</th><th>Games</th><th>Average forecast</th><th>Home side won</th></tr></thead><tbody>'
      + (H.playoff_calibration || []).map(function (b) { return '<tr><td>' + esc(b.bin) + '</td><td class="sm-num">' + esc(b.n) + '</td><td class="sm-num">' + esc(pct(b.mean_p)) + '</td><td class="sm-num">' + esc(pct(b.won)) + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">A calibrated model’s two right-hand columns match; with a few dozen games per row, gaps of several points are within chance.</div></div>';
    var off = '<div class="sm-card"><div class="sm-h">How the games of a series move together ' + badge('Research') + '</div><p class="sm-small">Each simulated series draws one shared offset (about ' + esc(isNum(t.tau_points) ? t.tau_points.toFixed(1) : '—') + ' points of margin; 95% interval ' + esc((t.ci95 || []).map(function (x) { return isNum(x) ? x.toFixed(1) : '—'; }).join('–')) + '), the size of the error in the two clubs’ ratings measured on 2010–2024 late-season games. It is carved out of the model’s game-to-game spread, so each game keeps the board’s probability on average; it only makes a club that is better than its rating likelier to win several games of the same series. The 2025 season, held out, was more volatile (' + esc(isNum(t.holdout_tau_points) ? t.holdout_tau_points.toFixed(1) : '—') + ' points): the series numbers may be somewhat too confident.</p></div>';
    return w + cal + off;
  }

  /* ------------------------------------------------------------ the adapter */
  var adapter = {
    defaultTab: 'title',
    tabLabels: { title: 'Finals', games: 'Games', model_health: 'Model Health' },
    load: async function (get, c, ctx) {
      var x = await U.loadPublished(get, 'wnba', U.seasonOf('wnba'));
      c.status = x.status; c.entitled = x.entitled;
      if (x.run) { c.run = x.run; c.results = x.results; c.entities = x.entities; c.edges = x.edges; }
    },
    paint: function (ctx) {
      var c = ctx.cache || {}, s = ctx.sport, now = ctx.nowMs || Date.now();
      var gate = U.gateHtml(s, c, now); if (gate) return gate;
      var st = U.deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: now });
      var v = ctx.tab === 'games' ? renderGames(c) : ctx.tab === 'model_health' ? renderHealth(c) : renderFinals(c);
      return U.renderMeta(s, c.run, st, now).replace('simulated seasons', 'simulated postseasons') + v;
    }
  };
  return { adapter: adapter, renderFinals: renderFinals, renderGames: renderGames, renderHealth: renderHealth, american: american };
});
