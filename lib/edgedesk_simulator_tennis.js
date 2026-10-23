/* ===========================================================================
   EDGEDESK SIMULATOR — tennis draws and matches (registered with
   EDSimUI.registerSport).

   Tennis publishes one competition per singles main draw (atp-<ESPN
   tournament id>, wta-<id>) and one for the day's matches ("matches"); the
   reader lists every draw published tonight and lets the reader switch.
   Three tabs, all from the published runs (supabase/simulator.sql sim_*):
     Draws         the selected draw: who wins the title, reaches the final,
                   the semifinals and the quarterfinals, and wins their next
                   match (with the Monte Carlo ± and fair decimal and
                   American odds); the next matches priced; the results so
                   far; where the draw's order comes from
     Matches       every scheduled singles match with both players known
                   (main draws and qualifying), each player's chance and
                   fair odds, by tournament
     Model Health  the match rating's holdout record against a coin and
                   FiveThirtyEight's tennis Elo, its calibration, the draw
                   backtest (title chances before the first round against
                   every entrant equally likely), and what it does not know

   A draw's state rides in its run's validation_summary.sport_summary
   (simulator/src/sports/tennis/run.ts readerSummary); each player's record
   (seed, rating, matches on file, line) in sim_entity_summary. Every value
   reaches the page through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('tennis', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, cell = U.cell, isNum = U.isNum;
  var LEVELS = [['win_title', 'Title'], ['reach_final', 'Final'], ['reach_semifinal', 'Semis'], ['reach_quarterfinal', 'Quarters']];

  /* ------------------------------------------------------------ helpers */
  function pct(x, d) { return isNum(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function american(p) { return U.fairAmerican(p); }
  function decimal(p) { return U.fairOdds(p); }
  function odds(p) { return isNum(p) && p > 0 && p < 1 ? decimal(p) + ' · ' + american(p) : '—'; }
  function summary(x) { return (x && x.run && x.run.validation_summary && x.run.validation_summary.sport_summary) || null; }
  function byEntity(x) { var by = {}; ((x && x.results) || []).forEach(function (r) { (by[r.entity_id] = by[r.entity_id] || {})[r.outcome] = r; }); return by; }
  function records(x) { var by = {}; ((x && x.entities) || []).forEach(function (e) { by[e.entity_id] = e.record || {}; }); return by; }
  function day(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }); } catch (_) { return String(iso).slice(0, 16); } }
  function tag(p) { var s = p.seed ? '[' + p.seed + ']' : p.entry ? '(' + p.entry + ')' : ''; return s ? ' <span class="sm-dim">' + esc(s) + '</span>' : ''; }
  function drawLabel(d) { return (d.tour || String(d.competition).split('-')[0].toUpperCase()) + ' · ' + (d.name || d.competition); }
  /* the round the draw is in: the lowest round with a match ready to play */
  function stage(S) {
    var lv = (S.scheduled || []).map(function (m) { return m.level; });
    if (!lv.length) return 'in progress';
    var lo = Math.min.apply(null, lv);
    return Object.keys(S.rounds || {}).filter(function (k) { return S.rounds[k] === lo; })[0] || 'in progress';
  }

  function drawPicker(c) {
    var ds = c.draws || [];
    if (ds.length < 2) return '';
    return '<nav class="sm-sports" aria-label="Draw">' + ds.map(function (d) {
      var on = d.competition === c.comp;
      return '<button type="button" class="sm-sport' + (on ? ' on' : '') + '" data-sim-act="draw" data-sim-val="' + esc(d.competition) + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(drawLabel(d)) + '</button>';
    }).join('') + '</nav>';
  }

  /* ------------------------------------------------------------ Draws */
  function renderDraw(x) {
    var S = summary(x);
    if (!S || S.kind !== 'tennis_draw') return '<div class="sm-card sm-empty">This run carries no draw summary.</div>';
    var O = byEntity(x), R = records(x);
    var src = S.order.source === 'wikipedia'
      ? 'Draw order: Wikipedia’s draw article' + (S.order.article ? ' (' + esc(S.order.article.title) + ')' : '') + ', confirmed line by line against ' + esc(S.order.matched) + ' of ESPN’s players and every result' + (S.order.filled_from_espn && S.order.filled_from_espn.length ? '; placed from ESPN: ' + esc(S.order.filled_from_espn.join(', ')) : '') + '.'
      : 'Draw order: ESPN’s semifinals on (no draw article could be confirmed for the earlier rounds).';
    var head = '<div class="sm-card"><div class="sm-h">' + esc(S.tournament.name) + ' <span class="sm-dim sm-small">' + esc(S.tour_label) + ' · singles · best of ' + esc(S.best_of) + ' · ' + esc(stage(S)) + '</span></div>'
      + '<p class="sm-small">' + badge('Observed') + ' Results from ESPN (scoreboard read ' + esc(day(S.as_of)) + '). ' + badge('Research') + ' Every match left is drawn from the rating, the draw played forward to its champion.</p>'
      + '<p class="sm-dim sm-small">' + src + '</p></div>';
    var levels = LEVELS.filter(function (l) { return (x.results || []).some(function (r) { return r.outcome === l[0] && r.outcome_count > 0 && r.outcome_count < r.n_sims; }); });
    var alive = (S.players || []).filter(function (p) { return !p.out; }).sort(function (a, b) {
      var pa = O[a.id] && O[a.id].win_title ? O[a.id].win_title.probability : 0, pb = O[b.id] && O[b.id].win_title ? O[b.id].win_title.probability : 0;
      return pb - pa || a.line - b.line;
    });
    var table = '<div class="sm-card"><div class="sm-h">Who wins the title ' + badge('Research') + '</div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Player</th><th title="ESPN ranking">Rank</th>' + levels.map(function (l) { return '<th>' + esc(l[1]) + '</th>'; }).join('') + '<th title="Their next match">Next match</th><th title="Fair odds for the title: decimal · American, no margin">Title odds</th></tr></thead><tbody>'
      + alive.map(function (p) {
        var o = O[p.id] || {}, t = o.win_title;
        return '<tr><td><b>' + esc(p.name) + '</b>' + tag(p) + '</td><td class="sm-num">' + esc(isNum(p.rank) ? p.rank : '—') + '</td>' + levels.map(function (l) { return cell(o[l[0]]); }).join('') + cell(o.win_next_match)
          + '<td class="sm-num">' + esc(t ? odds(t.probability) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="sm-foot">Players still in the draw. A round already reached shows “all”: it happened. Seeds in brackets; Q qualifier, WC wild card, LL lucky loser. Fair odds: decimal · American, no margin.</div></div>';
    var next = (S.scheduled || []).length ? '<div class="sm-card"><div class="sm-h">The next matches ' + badge('Research') + '</div>' + S.scheduled.map(function (m) {
      return '<div class="sm-club"><div class="sm-small sm-dim">' + esc(m.round) + (m.at ? ' · ' + esc(day(m.at)) : '') + '</div>'
        + '<div><b>' + esc(m.a_name) + '</b> ' + esc(pct(m.p_a)) + ' <span class="sm-dim">(' + esc(odds(m.p_a)) + ')</span> · <b>' + esc(m.b_name) + '</b> ' + esc(pct(1 - m.p_a)) + ' <span class="sm-dim">(' + esc(odds(1 - m.p_a)) + ')</span></div></div>';
    }).join('') + '<div class="sm-foot">The rating’s price for each match (best of ' + esc(S.best_of) + '); a match in progress is priced from before its first ball.</div></div>' : '';
    var byRound = {};
    (S.results || []).forEach(function (r) { (byRound[r.level] = byRound[r.level] || []).push(r); });
    var hist = Object.keys(byRound).length ? '<details class="sm-lim"><summary>Results so far ' + badge('Observed') + '</summary>' + Object.keys(byRound).map(Number).sort(function (a, b) { return b - a; }).map(function (lv) {
      return '<div class="sm-small"><b>' + esc(byRound[lv][0].round) + '</b>: ' + byRound[lv].map(function (r) { return esc(r.winner_name) + (r.loser_name ? ' d. ' + esc(r.loser_name) : '') + (r.walkover ? ' (walkover)' : r.retired ? ' (ret.)' : ''); }).join('; ') + '</div>';
    }).join('') + '</details>' : '';
    var outList = (S.players || []).filter(function (p) { return p.out; }).length;
    return head + table + next + hist + (outList ? '<p class="sm-dim sm-small">' + esc(outList) + ' players are out of the draw.</p>' : '');
  }

  /* ------------------------------------------------------------ Matches */
  function renderMatches(x) {
    var S = summary(x);
    if (!S || S.kind !== 'tennis_matches') return '<div class="sm-card sm-empty">No match prices are published right now.</div>';
    var O = byEntity(x);
    var byT = {};
    S.matches.forEach(function (m) { (byT[m.tour + ' · ' + m.tournament] = byT[m.tour + ' · ' + m.tournament] || []).push(m); });
    return '<div class="sm-card"><div class="sm-h">Every scheduled singles match ' + badge('Research') + '</div><p class="sm-dim sm-small">Main draws and qualifying, both players known, in the next three days (scoreboard read ' + esc(day(S.as_of)) + '). Each player’s chance to win from the rating, with fair decimal and American odds; a men’s Grand Slam main-draw match is best of five.</p></div>'
      + Object.keys(byT).sort().map(function (k) {
        return '<div class="sm-card"><div class="sm-h">' + esc(k) + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Round</th><th>When (UTC)</th><th>Player</th><th>Win</th><th>Fair odds</th><th>Player</th><th>Win</th><th>Fair odds</th></tr></thead><tbody>'
          + byT[k].map(function (m) {
            var oa = (O['m' + m.id + ':' + m.a.id] || {}).win_match, ob = (O['m' + m.id + ':' + m.b.id] || {}).win_match;
            return '<tr><td>' + esc(m.round) + '</td><td class="sm-small">' + esc(day(m.at)) + '</td><td><b>' + esc(m.a.name) + '</b>' + tag(m.a) + '</td>' + cell(oa) + '<td class="sm-num">' + esc(odds(m.p_a)) + '</td>'
              + '<td><b>' + esc(m.b.name) + '</b>' + tag(m.b) + '</td>' + cell(ob) + '<td class="sm-num">' + esc(odds(1 - m.p_a)) + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';
      }).join('');
  }

  /* ------------------------------------------------------------ Model Health */
  function renderHealth(x) {
    var S = summary(x);
    if (!S || !S.model_health) return '<div class="sm-card sm-empty">This run carries no model record.</div>';
    var H = S.model_health, f3 = function (v) { return isNum(v) ? v.toFixed(3) : '—'; };
    var tours = ['ATP', 'WTA'].filter(function (t) { return H.holdout && H.holdout[t]; });
    var m = '<div class="sm-card"><div class="sm-h">Does the match rating work? ' + badge('Observed') + '</div>'
      + '<p class="sm-small">Each match is priced from the ratings before it, then the rating learns from the result. The rating’s settings were chosen on ' + esc(H.tune) + '; the matches below (' + esc(H.holdout_window) + ') were scored once, afterwards.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Tour</th><th>Matches</th><th title="Lower is better">Log loss</th><th title="FiveThirtyEight’s published tennis Elo">FiveThirtyEight Elo</th><th>A coin</th></tr></thead><tbody>'
      + tours.map(function (t) { var h = H.holdout[t]; return '<tr><td>' + esc(t) + '</td><td class="sm-num">' + esc(U.int(h.n)) + '</td><td class="sm-num"><b>' + esc(f3(h.log_loss)) + '</b></td><td class="sm-num">' + esc(f3(h.elo_538)) + '</td><td class="sm-num">' + esc(f3(h.coin)) + '</td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">In plain words: better than a coin and than FiveThirtyEight’s published tennis Elo, but tennis is hard to call — favourites lose about a third of the time. Calibration: when the rating says 70%, the player wins about 70% of the time (average gap ' + esc(pct(H.ece, 1)) + '). It has never been compared with closing prices.</div></div>';
    var bt = H.backtest || {};
    var d = '<div class="sm-card"><div class="sm-h">Does the draw simulation call tournaments? ' + badge('Observed') + '</div>'
      + '<p class="sm-small">Every completed draw of the same period, replayed from its first round with the ratings frozen at the start: the champion’s chance before a ball was struck, against every entrant being equally likely.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Tour</th><th>Draws</th><th title="−ln(the champion’s chance), lower is better">Champion log loss</th><th>Everyone equal</th><th>Difference (95% interval)</th><th title="The model’s favourite won the title">Favourite won</th></tr></thead><tbody>'
      + tours.map(function (t) { var b = bt[t]; if (!b) return ''; var c = b.champion_log_loss; return '<tr><td>' + esc(t) + '</td><td class="sm-num">' + esc(b.draws) + '</td><td class="sm-num"><b>' + esc(f3(c.model)) + '</b></td><td class="sm-num">' + esc(f3(c.field_size)) + '</td><td class="sm-num">' + esc(f3(c.diff_vs_field_size.mean)) + ' (' + esc(f3(c.diff_vs_field_size.ci95[0])) + ' to ' + esc(f3(c.diff_vs_field_size.ci95[1])) + ')</td><td class="sm-num">' + esc(b.favourite_won) + ' of ' + esc(b.draws) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + tours.map(function (t) { var b = bt[t]; if (!b || !b.calibration) return ''; return '<div class="sm-small"><b>' + esc(t) + ' title chances</b>: ' + b.calibration.filter(function (r) { return r.n; }).map(function (r) { return esc(pct(r.from, 0)) + '–' + esc(pct(r.to, 0)) + ': said ' + esc(pct(r.mean_chance)) + ', won ' + esc(pct(r.share_won)) + ' (' + esc(U.int(r.n)) + ')'; }).join(' · ') + '</div>'; }).join('')
      + '<div class="sm-foot">A favourite at 30% still loses the title seven times in ten: a draw is long.</div></div>';
    var unknown = '<div class="sm-card"><div class="sm-h">What the model does not know</div><ul class="sm-list"><li>The court surface: ESPN does not carry it, so one rating covers clay, grass and hard courts.</li><li>Injuries, fitness, travel and withdrawals after the scoreboard was read.</li><li>The score of a match in progress: it is priced from before its first ball.</li><li>Sets and games: only who wins is simulated (independent sets would predict far more three-setters than happen).</li><li>Players with few matches on file (juniors, newcomers) start at the average and move fast.</li></ul></div>';
    return m + d + unknown;
  }

  /* ------------------------------------------------------------ the adapter */
  function apply(c, x) { c.status = x.status; c.entitled = x.entitled; c.run = x.run; c.results = x.results; c.entities = x.entities; c.edges = []; }
  var adapter = {
    defaultTab: 'draws',
    tabLabels: { draws: 'Draws', matches: 'Matches', model_health: 'Model Health' },
    /* every draw published tonight (one request for their names), then the selected draw and the day's matches */
    load: async function (get, c) {
      var season = U.seasonOf('tennis');
      var stat = ((await get('rpc/sim_public_status')) || []).filter(function (x) { return x.sport === 'tennis' && (!season || x.season === season); });
      var entitled = await get('rpc/sim_viewer_entitled');
      var names = {};
      if (entitled === true && stat.some(function (x) { return x.published_run_id; })) {
        var runs = (await get('sim_current_runs?sport=eq.tennis' + (season ? '&season=eq.' + encodeURIComponent(season) : '') + '&select=competition,validation_summary')) || [];
        runs.forEach(function (r) { var s = r.validation_summary && r.validation_summary.sport_summary; if (s && s.tournament) names[r.competition] = { name: s.tournament.name, tour: s.tour }; });
      }
      c.draws = stat.filter(function (x) { return /^(atp|wta)-/.test(String(x.competition || '')) && x.published_run_id; }).map(function (x) {
        return { competition: x.competition, name: names[x.competition] ? names[x.competition].name : null, tour: names[x.competition] ? names[x.competition].tour : null, row: x };
      }).sort(function (a, b) { return drawLabel(a) < drawLabel(b) ? -1 : 1; });
      c.byComp = c.byComp || {};
      if (!c.comp || !c.draws.some(function (d) { return d.competition === c.comp; })) c.comp = c.draws.length ? c.draws[0].competition : null;
      var drawStatus = stat.filter(function (x) { return /^(atp|wta)-/.test(String(x.competition || '')); });
      if (c.comp) { var x = await U.loadPublished(get, 'tennis', season, c.comp); c.byComp[c.comp] = x; apply(c, x); }
      else { c.status = drawStatus[0] || stat[0] || null; c.entitled = entitled; c.run = null; }
      c.matches = stat.some(function (x) { return x.competition === 'matches'; }) ? await U.loadPublished(get, 'tennis', season, 'matches') : { status: null, entitled: entitled, run: null };
    },
    onAction: function (act, val, c) {
      if (act === 'draw' && (c.draws || []).some(function (d) { return d.competition === val; })) {
        c.comp = val;
        var x = c.byComp && c.byComp[val];
        if (x) { apply(c, x); return 'paint'; }
        return 'load';
      }
      return null;
    },
    paint: function (ctx) {
      var c = ctx.cache || {}, s = ctx.sport, now = ctx.nowMs || Date.now();
      if (ctx.tab === 'matches') {
        var mc = c.matches || {};
        var g = U.gateHtml(s, { status: mc.status, entitled: mc.entitled, run: mc.run, error: c.error, loading: c.loading }, now);
        if (g) return g.replace('No simulation has been published for ' + s.label, 'No match prices have been published for ' + s.label);
        var stm = U.deriveState({ sport: s, status: mc.status, entitled: mc.entitled, run: mc.run, loadError: c.error, nowMs: now });
        return U.renderMeta(s, mc.run, stm, now).replace('simulated seasons', 'runs of every match') + renderMatches(mc);
      }
      var gate = U.gateHtml(s, c, now);
      if (gate) return drawPicker(c) + (c.run || c.comp ? gate : gate.replace('No simulation has been published for ' + s.label + ' yet', 'No draw simulation has been published for ' + s.label + ' yet: a draw is simulated only once its order is known'));
      var st = U.deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: now });
      var v = ctx.tab === 'model_health' ? renderHealth(c) : renderDraw(c);
      return drawPicker(c) + U.renderMeta(s, c.run, st, now).replace('simulated seasons', 'simulated draws') + v;
    }
  };
  return { adapter: adapter, renderDraw: renderDraw, renderMatches: renderMatches, renderHealth: renderHealth, american: american, decimal: decimal };
});
