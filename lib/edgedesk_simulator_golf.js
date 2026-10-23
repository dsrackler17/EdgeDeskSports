/* ===========================================================================
   EDGEDESK SIMULATOR — golf tournaments (registered with EDSimUI.registerSport).

   Golf publishes one competition per tour event (pga-<id>, lpga-<id>,
   eur-<id>); the reader lists each tour's latest and lets the reader switch
   tour. Three tabs, all from the published run (supabase/simulator.sql sim_*):
     Leaderboard   the event as it stands (Observed: positions, scores,
                   rounds, the cut), then each player's chance to win, finish
                   top 5 / 10 / 20 and make the cut, with the Monte Carlo ±,
                   fair odds and how many simulated tournaments each won;
                   sortable
     Finishes      the most likely winners, where every player finishes
                   (places in bands, missed cut, the most likely band, median
                   and mean place), fair decimal AND American odds for every
                   market, the projected winning score; dead heats explained
     Model Health  the walk-forward backtest in plain words (2025-2026 holdout
                   against honest baselines), calibration, the skill model's
                   own record, and what the model does not know

   The tournament's state rides in the run's validation_summary.sport_summary
   (simulator/src/sports/golf/run.ts readerSummary); each player's finishing
   histogram in the player's sim_entity_summary record. Every value reaches the page
   through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('golf', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, cell = U.cell, isNum = U.isNum;
  var TOURS = ['pga', 'lpga', 'eur'];
  var TOUR_LABEL = { pga: 'PGA Tour', lpga: 'LPGA Tour', eur: 'DP World Tour' };
  var KEYS = ['win', 'top_5', 'top_10', 'top_20', 'make_cut'];
  var KEY_LABEL = { win: 'Win', top_5: 'Top 5', top_10: 'Top 10', top_20: 'Top 20', make_cut: 'Make cut' };

  /* ------------------------------------------------------------ helpers */
  function pct(x, d) { return isNum(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
  /* fair American odds from a probability (no margin): -150 for 60%, +150 for 40% */
  function american(p) {
    if (!isNum(p) || p <= 0 || p >= 1) return '—';
    var v = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return (v > 0 ? '+' : '') + Math.round(v);
  }
  function decimal(p) { return U.fairOdds(p); }
  function toPar(x) { return !isNum(x) ? '—' : x === 0 ? 'E' : x > 0 ? '+' + x : String(x); }
  function summary(c) { return (c.run && c.run.validation_summary && c.run.validation_summary.sport_summary) || null; }
  function byEntity(c) { var by = {}; (c.results || []).forEach(function (r) { (by[r.entity_id] = by[r.entity_id] || {})[r.outcome] = r; }); return by; }
  function records(c) { var by = {}; (c.entities || []).forEach(function (e) { by[e.entity_id] = e.record || {}; }); return by; }
  function prob(O, id, k) { var o = O[id] && O[id][k]; return o && isNum(o.probability) ? o.probability : null; }
  function has(c, k) { return (c.results || []).some(function (r) { return r.outcome === k; }); }
  function provOf(c, k) { var r = (c.results || []).filter(function (x) { return x.outcome === k; })[0]; return r ? r.provenance : null; }
  function thru(p, S) {
    if (p.status === 'cut') return 'MC'; if (p.status === 'wd') return 'WD'; if (p.status === 'dq') return 'DQ'; if (p.status === 'mdf') return 'MDF';
    if (p.partial && p.partial.holes) return 'thru ' + p.partial.holes;
    return p.rounds && S && S.event && p.rounds.length >= S.event.n_rounds ? 'F' : 'after R' + ((p.rounds || []).length);
  }
  function stage(S) {
    var e = S.event, lv = S.levels || [];
    var part = lv.filter(function (l) { return l.state === 'partial'; })[0];
    if (part) return 'Round ' + part.r + ' of ' + e.n_rounds + ' in progress';
    var done = lv.filter(function (l) { return l.state === 'complete'; }).length;
    return done ? 'After round ' + done + ' of ' + e.n_rounds : 'Before round 1 (' + e.n_rounds + ' rounds)';
  }
  /* the share of runs at or below each value of a histogram [{to_par, count}] */
  function quantile(h, q) { var n = 0; h.forEach(function (x) { n += x.count; }); var acc = 0; for (var i = 0; i < h.length; i++) { acc += h[i].count; if (acc >= q * n) return h[i].to_par; } return null; }
  function players(c) {
    var S = summary(c), O = byEntity(c), R = records(c);
    return ((S && S.leaderboard) || []).map(function (p) {
      var r = { p: p, rec: R[p.id] || {}, o: O[p.id] || {}, active: p.status === 'active' };
      KEYS.forEach(function (k) { r[k] = prob(O, p.id, k); });
      r.pos = p.status === 'active' ? (isNum(p.to_par) ? p.to_par : 999) : 1000 + (p.status === 'cut' ? 0 : 1);
      r.skill = p.skill && isNum(p.skill.theta) ? p.skill.theta : null;
      r.mean_place = r.rec.finish && isNum(r.rec.finish.mean_place_if_finished) ? r.rec.finish.mean_place_if_finished : null;
      return r;
    });
  }

  /* ------------------------------------------------------------ the tour picker and the event card */
  function tourPicker(c) {
    var ev = c.events || {};
    var ks = TOURS.filter(function (t) { return ev[t]; });
    if (ks.length < 2) return '';
    return '<nav class="sm-sports" aria-label="Tour">' + ks.map(function (t) {
      var on = t === c.tour;
      return '<button type="button" class="sm-sport' + (on ? ' on' : '') + '" data-sim-act="tour" data-sim-val="' + esc(t) + '"' + (on ? ' aria-current="page"' : '') + '>' + esc(TOUR_LABEL[t] || t) + '</button>';
    }).join('') + '</nav>';
  }
  function eventCard(c) {
    var S = summary(c), e = S.event, cut = S.cut || {};
    var cutLine = '';
    if (cut.state === 'made') cutLine = badge('Observed') + ' The cut has been made.';
    else if (cut.state === 'none') cutLine = (cut.provenance ? badge(cut.provenance) + ' ' : '') + 'No cut: ' + esc(cut.source);
    else if (cut.state === 'pending') {
      var pl = (cut.projected_line || []), n = 0; pl.forEach(function (x) { n += x.count; });
      cutLine = badge(cut.provenance || 'Research') + ' Cut after round ' + esc(cut.round) + ': top ' + esc(cut.n) + ' and ties' + (cut.within ? ' and anyone within ' + esc(cut.within) + ' strokes of the lead' : '') + '. <span class="sm-dim">' + esc(cut.source) + '</span>'
        + (pl.length ? '<div class="sm-small">Projected cut line: ' + pl.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 4).map(function (x) { return '<b>' + esc(toPar(x.to_par)) + '</b> ' + esc(pct(x.count / n)); }).join(' · ') + '</div>' : '');
    }
    var ws = S.winning_score || [];
    var win = ws.length ? 'Winning score: <b>' + esc(toPar(quantile(ws, 0.5))) + '</b> <span class="sm-dim">(80% of simulated tournaments between ' + esc(toPar(quantile(ws, 0.1))) + ' and ' + esc(toPar(quantile(ws, 0.9))) + ')</span>' : '';
    var po = S.playoff ? ' · a playoff in ' + esc(pct(S.playoff.share)) + ' of them' : '';
    return '<div class="sm-card"><div class="sm-h">' + esc(e.name) + ' ' + badge('Observed') + '</div>'
      + '<div class="sm-small">' + esc(S.tour_label) + (e.course ? ' · ' + esc(e.course) : '') + ' · par ' + esc(e.par) + ' · <b>' + esc(stage(S)) + '</b> · leaderboard read ' + esc(U.when(S.as_of)) + '</div>'
      + '<div class="sm-small" style="margin-top:6px">' + cutLine + '</div>'
      + (win ? '<div class="sm-small" style="margin-top:6px">' + badge('Research') + ' ' + win + po + '</div>' : '') + '</div>';
  }

  /* ------------------------------------------------------------ Leaderboard */
  function sortHead(c, key, label, title) {
    var s = c.sort || { key: 'win', dir: 'desc' }, on = s.key === key;
    return '<th class="sm-num"' + (title ? ' title="' + esc(title) + '"' : '') + '><button type="button" class="sm-sort' + (on ? ' on' : '') + '" data-sim-act="sort" data-sim-val="' + esc(key) + '">' + esc(label) + (on ? (s.dir === 'desc' ? ' ▾' : ' ▴') : '') + '</button></th>';
  }
  function renderLeaderboard(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no tournament summary.</div>';
    var s = c.sort || { key: 'win', dir: 'desc' };
    var rows = players(c);
    var act = U.sortRows(rows.filter(function (r) { return r.active; }), s.key, s.key === 'pos' || s.key === 'skill' || s.key === 'mean_place' ? (s.dir === 'desc' ? 'asc' : 'desc') : s.dir);
    var out = rows.filter(function (r) { return !r.active; }).sort(function (a, b) { return a.pos - b.pos || (a.p.to_par || 0) - (b.p.to_par || 0); });
    var ks = KEYS.filter(function (k) { return has(c, k); });
    var n = c.run.n_sims;
    var head = '<tr><th>Player</th><th class="sm-num"><button type="button" class="sm-sort' + (s.key === 'pos' ? ' on' : '') + '" data-sim-act="sort" data-sim-val="pos">To par</button></th>'
      + ks.map(function (k) { return sortHead(c, k, KEY_LABEL[k], k === 'win' ? 'Share of simulated tournaments won' : k === 'make_cut' ? 'Share of simulated tournaments in which the player makes the cut' : 'Ties for the last place broken at random: the dead-heat expectation'); }).join('')
      + '<th class="sm-num" title="Fair odds to win: no margin">Win fair</th><th class="sm-num" title="Simulated tournaments won, of all simulated">Won</th>'
      + sortHead(c, 'mean_place', 'Avg place', 'Average finishing place in the simulated tournaments the player finished') + sortHead(c, 'skill', 'Skill', 'Strokes per round against an average round on the tour, before the event (negative is better)') + '</tr>';
    var line = function (r) {
      var p = r.p, won = r.o.win ? r.o.win.outcome_count : null;
      return '<tr><td><span class="sm-dim">' + esc(p.position || (r.active ? '' : '—')) + '</span> <b>' + esc(p.name) + '</b>' + (p.skill && p.skill.on_prior ? '<span class="sm-tag" title="No round in the history: the newcomer prior">new</span>' : '') + '<span class="sm-sub sm-dim">' + esc(thru(p, S)) + '</span></td>'
        + '<td class="sm-num">' + esc(toPar(p.to_par)) + '</td>'
        + ks.map(function (k) { return r.o[k] ? cell(r.o[k]) : '<td class="sm-num na">—</td>'; }).join('')
        + '<td class="sm-num">' + (r.active && isNum(r.win) && r.win > 0 ? esc(decimal(r.win)) + '<span class="sm-pm">' + esc(american(r.win)) + '</span>' : '—') + '</td>'
        + '<td class="sm-num">' + (won != null ? esc(U.int(won)) : '—') + '</td>'
        + '<td class="sm-num">' + (r.mean_place != null ? esc(r.mean_place.toFixed(1)) : '—') + '</td>'
        + '<td class="sm-num">' + (r.skill != null ? esc((r.skill > 0 ? '+' : '') + r.skill.toFixed(2)) : '—') + '</td></tr>';
    };
    var prov = ks.map(function (k) { return KEY_LABEL[k] + ' ' + badge(provOf(c, k) || 'Research'); }).join(' ');
    return eventCard(c)
      + '<div class="sm-card"><div class="sm-h">The field, ' + esc(U.int(n)) + ' simulated tournaments</div><div class="sm-small sm-dim" style="margin-bottom:6px">' + prov + '</div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead>' + head + '</thead><tbody>' + act.map(line).join('') + out.map(line).join('') + '</tbody></table></div>'
      + '<div class="sm-foot">± is the 95% Monte Carlo half-width: simulation noise, not model error. Top 5, 10 and 20 break a tie for the last place at random, so a player tied for 10th with three others is in the top 10 a quarter of the times it happens: the dead-heat expectation. Fair odds carry no bookmaker margin; remove a book’s margin before comparing. “Won” counts the simulated tournaments each player won. Players out of the event (MC, WD) are listed last.</div></div>';
  }

  /* ------------------------------------------------------------ Finishes */
  var BANDS = [[1, 1, 'Win'], [2, 5, '2–5'], [6, 10, '6–10'], [11, 20, '11–20'], [21, 30, '21–30'], [31, 9999, '31+']];
  function bands(rec, n) {
    var f = rec.finish || {}, pl = f.places || [];
    var out = BANDS.map(function (b) { var s = 0; for (var i = b[0]; i <= Math.min(b[1], pl.length); i++) s += pl[i - 1] || 0; return s / n; });
    out.push((f.missed_cut || 0) / n);
    return out;
  }
  function renderFinishes(c) {
    var S = summary(c); if (!S) return '<div class="sm-card sm-empty">This run carries no tournament summary.</div>';
    var n = c.run.n_sims, rows = players(c).filter(function (r) { return r.active; });
    var top = rows.slice().sort(function (a, b) { return (b.win || 0) - (a.win || 0); }).slice(0, 6);
    var cards = '<div class="sm-h">Most likely winners ' + badge(provOf(c, 'win') || 'Research') + '</div><div class="sm-cards">' + top.map(function (r) {
      var o = r.o.win, f = U.fmtProb(o);
      return '<div class="sm-club"><div class="sm-club-h"><b>' + esc(r.p.name) + '</b> <span class="sm-dim">' + esc(r.p.position || '') + ' ' + esc(toPar(r.p.to_par)) + '</span></div><div class="sm-big" title="' + esc(f.title) + '">' + esc(f.text) + ' <span class="sm-pm">' + esc(U.fmtPm(o)) + '</span></div>'
        + '<div class="sm-dim">fair ' + esc(decimal(r.win)) + ' (' + esc(american(r.win)) + ') · won ' + esc(U.int(o ? o.outcome_count : 0)) + ' of ' + esc(U.int(n)) + '</div></div>';
    }).join('') + '</div>';
    var hasCut = has(c, 'make_cut');
    /* ordered by the expected place over every simulated tournament, a missed cut counting as last (so a player who
       rarely makes the cut is not ranked by the few times they do) */
    var F = (S.leaderboard || []).length;
    var expPlace = function (r) { var f = r.rec.finish || {}, pl = f.places || [], s = 0; pl.forEach(function (cnt, i) { s += cnt * (i + 1); }); return (s + ((f.missed_cut || 0) + (f.withdrawn || 0)) * (F + 1)) / n; };
    var dist = rows.slice().sort(function (a, b) { return expPlace(a) - expPlace(b); });
    var labels = BANDS.map(function (b) { return b[2]; }).concat(hasCut ? ['MC'] : []);
    var table = '<div class="sm-card"><div class="sm-h">Where each player finishes ' + badge('Research') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Player</th>' + labels.map(function (l) { return '<th class="sm-num">' + esc(l) + '</th>'; }).join('')
      + '<th title="The band the player lands in most often">Most likely</th><th class="sm-num" title="Half the simulated tournaments end at this place or better (MC: the player misses the cut in more than half)">Median</th><th class="sm-num" title="Average place in the simulated tournaments the player finished">Avg place</th></tr></thead><tbody>'
      + dist.map(function (r) {
        var b = bands(r.rec, n).slice(0, labels.length), mx = 0; b.forEach(function (v, i) { if (v > b[mx]) mx = i; });
        var f = r.rec.finish || {};
        return '<tr><td><b>' + esc(r.p.name) + '</b><span class="sm-sub sm-dim">' + esc(r.p.position || '') + ' ' + esc(toPar(r.p.to_par)) + '</span></td>'
          + b.map(function (v, i) { return '<td class="sm-num' + (v === 0 ? ' zero' : '') + '"' + (i === mx ? ' style="font-weight:800"' : '') + '>' + esc(v === 0 ? '—' : v < 0.0005 ? '<0.1%' : pct(v)) + '</td>'; }).join('')
          + '<td>' + esc(labels[mx]) + '</td><td class="sm-num">' + esc(f.median_place == null ? '—' : f.median_place) + '</td><td class="sm-num">' + esc(isNum(f.mean_place_if_finished) ? f.mean_place_if_finished.toFixed(1) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="sm-foot">Each row sums to 100% across the bands' + (hasCut ? ' and the missed cut' : '') + '. Places break ties at random in each simulated tournament, so a band holds the dead-heat share of a tie that straddles it. Bold: where the player lands most often — “where the numbers line up”.</div></div>';
    var odds = rows.slice().sort(function (a, b) { return (b.win || 0) - (a.win || 0); }).slice(0, 30);
    var oks = KEYS.filter(function (k) { return has(c, k) && k !== 'make_cut'; });
    var fair = '<div class="sm-card"><div class="sm-h">Fair odds ' + badge('Research') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Player</th>' + oks.map(function (k) { return '<th class="sm-num">' + esc(KEY_LABEL[k]) + ' decimal</th><th class="sm-num">' + esc(KEY_LABEL[k]) + ' American</th>'; }).join('') + '</tr></thead><tbody>'
      + odds.map(function (r) { return '<tr><td><b>' + esc(r.p.name) + '</b></td>' + oks.map(function (k) { return '<td class="sm-num">' + esc(r[k] > 0 ? decimal(r[k]) : '—') + '</td><td class="sm-num">' + esc(american(r[k])) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">Fair odds are 1 ÷ the simulated share (decimal) and its American equivalent, with no margin. A book settles a top-10 tie by dead heat (two spots shared by four players pays a half stake at full odds): the simulation’s random tie-break has the same expected value, so these odds compare with a dead-heat price.</div></div>';
    var ws = S.winning_score || [], wn = 0, wm = 0; ws.forEach(function (x) { wn += x.count; wm = Math.max(wm, x.count); });
    var lo = quantile(ws, 0.01), hi = quantile(ws, 0.99);
    var score = ws.length ? '<div class="sm-card"><div class="sm-h">The winning score ' + badge('Research') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>To par</th><th class="sm-num">Share</th><th>&nbsp;</th></tr></thead><tbody>'
      + ws.filter(function (x) { return x.to_par >= lo && x.to_par <= hi; }).map(function (x) { var w = Math.round(100 * x.count / wm); return '<tr><td>' + esc(toPar(x.to_par)) + '</td><td class="sm-num">' + esc(pct(x.count / wn)) + '</td><td style="min-width:120px"><div style="height:8px;border-radius:4px;background:var(--accent,#2fa79a);width:' + esc(w) + '%"></div></td></tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">The winner’s total to par in the simulated tournaments (the middle 98% shown). Each future round’s course level is drawn once per simulated tournament and shared by the whole field: it moves the scores, never who beats whom.</div></div>' : '';
    return cards + table + fair + score;
  }

  /* ------------------------------------------------------------ Model Health */
  function f4(x) { return isNum(x) ? x.toFixed(4) : '—'; }
  function verdict(d) {
    if (!d) return 'no comparison';
    var iv = d.ci95 ? ' (95% interval ' + f4(d.ci95[0]) + ' to ' + f4(d.ci95[1]) + ')' : '';
    return d.ci95 && d.ci95[1] < 0 ? 'better' + iv : d.ci95 && d.ci95[0] > 0 ? 'worse' + iv : (d.log_loss < 0 ? 'better on average, within noise' : 'not better') + iv;
  }
  function renderHealth(c) {
    var S = summary(c), H = S && S.model_health;
    if (!H || !H.holdout) return '<div class="sm-card sm-empty">This run carries no backtest record.</div>';
    var pre = H.holdout.pre, r2 = H.holdout.r2, seasons = (H.holdout.seasons || []).join('–');
    var m = pre.metrics || {}, w = m.win || {}, t10 = m.top_10 || {};
    var words = '<div class="sm-card"><div class="sm-h">Does it work? The ' + esc(seasons) + ' holdout ' + badge('Observed') + '</div><p class="sm-small">Every '
      + esc(H.label || S.tour_label) + ' event of ' + esc(seasons) + ' was replayed as if it were about to start, with skills fitted only on rounds played before it, and simulated '
      + esc(U.int(H.runs_per_event)) + ' times; then again after round 2. The forecasts were scored against what happened (' + esc(U.int(pre.events)) + ' events, ' + esc(U.int(pre.player_events)) + ' player-events before round 1). Lower log loss is better.</p><ul class="sm-list">'
      + '<li>Picking the winner before round 1: log loss ' + esc(f4(w.model && w.model.log_loss)) + ' against ' + esc(f4(w.uniform && w.uniform.log_loss)) + ' for an equal chance for everyone in the field: ' + esc(verdict(w.diff_vs_uniform)) + '.</li>'
      + '<li>A top-10 finish before round 1: ' + esc(f4(t10.model && t10.model.log_loss)) + ' against ' + esc(f4(t10.uniform && t10.uniform.log_loss)) + ': ' + esc(verdict(t10.diff_vs_uniform)) + '.</li>'
      + (r2 && r2.metrics && r2.metrics.win ? '<li>After round 2, against the leaderboard alone (every player equally skilled, only the scores differ): the winner ' + esc(verdict(r2.metrics.win.diff_vs_scores_only)) + '; top 10 ' + esc(verdict((r2.metrics.top_10 || {}).diff_vs_scores_only)) + '.</li>' : '')
      + '<li>The week-to-week uncertainty (each player’s offset drawn once per tournament) against skill as a point: the winner ' + esc(verdict(w.diff_vs_point)) + '.</li></ul></div>';
    var tbl = function (title, M, cols) {
      return '<div class="sm-card"><div class="sm-h">' + esc(title) + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Outcome</th>' + cols.map(function (x) { return '<th class="sm-num">' + esc(x[1]) + '</th>'; }).join('') + '<th>Model against the first baseline</th></tr></thead><tbody>'
        + Object.keys(M).map(function (k) { var x = M[k]; return '<tr><td>' + esc(KEY_LABEL[k] || k) + '</td>' + cols.map(function (cn) { return '<td class="sm-num">' + esc(f4(x[cn[0]] && x[cn[0]].log_loss)) + '<span class="sm-pm">Brier ' + esc(f4(x[cn[0]] && x[cn[0]].brier)) + '</span></td>'; }).join('') + '<td>' + esc(verdict(x[cols[1] ? 'diff_vs_' + cols[1][0] : ''])) + '</td></tr>'; }).join('')
        + '</tbody></table></div></div>';
    };
    var t1 = tbl('Before round 1: log loss (Brier below)', m, [['model', 'Model'], ['uniform', 'Field size'], ['point', 'Skill as a point']]);
    var t2 = r2 && r2.metrics ? tbl('After round 2 (' + U.int(r2.events) + ' events): log loss (Brier below)', r2.metrics, [['model', 'Model'], ['scores_only', 'Scores only'], ['point', 'Skill as a point'], ['uniform', 'Field size']]) : '';
    var cal = ['top_10', 'make_cut', 'win'].filter(function (k) { return m[k] && m[k].calibration; }).map(function (k) {
      return '<div class="sm-card"><div class="sm-h">Calibration: ' + esc(KEY_LABEL[k]) + ', before round 1</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Model chance</th><th class="sm-num">Player-events</th><th class="sm-num">Average forecast</th><th class="sm-num">Happened</th></tr></thead><tbody>'
        + m[k].calibration.map(function (b) { return '<tr><td>' + esc(b.bin) + '</td><td class="sm-num">' + esc(U.int(b.n)) + '</td><td class="sm-num">' + esc(pct(b.mean_p, 2)) + '</td><td class="sm-num">' + esc(pct(b.observed, 2)) + '</td></tr>'; }).join('')
        + '</tbody></table></div><div class="sm-foot">A calibrated forecast’s two right-hand columns match; top 10 counts a tie at its dead-heat share.</div></div>';
    }).join('');
    var st = H.study || {}, oos = st.out_of_sample || {};
    var model = '<div class="sm-card"><div class="sm-h">The skill model ' + badge('Research') + '</div><ul class="sm-list">'
      + (oos.holdout ? '<li>Predicting a round against the field before the event (' + esc(seasons) + ', ' + esc(U.int(oos.holdout.rounds)) + ' rounds): mean squared error ' + esc(f4(oos.holdout.mse)) + ' strokes² against ' + esc(f4(oos.holdout.mse_no_skill)) + ' with every player equal.</li>' : '')
      + (st.joint && st.joint.length ? '<li>The PGA Tour and the DP World Tour are fitted on one scale: their shared players link the fields, and it predicted both tours’ rounds better than separate fits.</li>' : '')
      + (S.model ? '<li>Recent rounds count most (half-life ' + esc(S.model.params.half_life_days) + ' days); a player with few rounds is pulled toward a measured prior (worse than the average player for newcomers); the per-tournament draw has variance ' + esc(f4(S.model.tournament.c2)) + ' × the skill’s own uncertainty, plus ' + esc(f4(S.model.tournament.W1)) + ' shared by rounds 1–2 (scale ' + esc(S.model.tournament.scale) + ').</li>' : '')
      + (H.playoffs ? '<li>Playoffs: ' + esc(pct(H.playoffs.simulated_share_mean)) + ' of simulated holdout tournaments ended in one; the feed shows ' + esc(H.playoffs.events_with_playoff_in_feed) + ' of ' + esc(H.playoffs.events) + ' events with one (it records playoffs reliably only for the PGA Tour).</li>' : '')
      + '</ul></div>';
    var unknown = '<div class="sm-card"><div class="sm-h">What the model does not know</div><ul class="sm-list"><li>Course fit and course history: every course is the same test, apart from its overall difficulty.</li><li>The weather and the morning or afternoon tee-time wave: only their average effect on the first two rounds is in each player’s draw.</li><li>Injuries, illness, equipment or swing changes, and news: the skill moves only with scores.</li><li>Withdrawals after the leaderboard was read, and aggregate-format playoffs (treated as sudden death).</li><li>Golf played outside the PGA Tour, LPGA and DP World Tour (LIV Golf, the Korn Ferry Tour, the Asian Tour, college): such players start near the newcomer level.</li></ul></div>';
    return words + t1 + t2 + cal + model + unknown;
  }

  /* ------------------------------------------------------------ the adapter */
  var adapter = {
    defaultTab: 'leaderboard',
    tabLabels: { leaderboard: 'Leaderboard', finishes: 'Finishes', model_health: 'Model Health' },
    /* every tour's latest published event, then the selected tour's run */
    load: async function (get, c) {
      var season = U.seasonOf('golf');
      var stat = (await get('rpc/sim_public_status')) || [];
      var ev = {};
      stat.filter(function (x) { return x.sport === 'golf' && (!season || x.season === season) && /^[a-z]+-/.test(String(x.competition || '')); }).forEach(function (x) {
        var t = String(x.competition).split('-')[0], cur = ev[t];
        var at = Date.parse(x.input_snapshot_at || x.last_attempt_at || '') || 0, cat = cur ? (Date.parse(cur.row.input_snapshot_at || cur.row.last_attempt_at || '') || 0) : -1;
        if (!cur || (x.published_run_id && !cur.row.published_run_id) || (!!x.published_run_id === !!cur.row.published_run_id && at > cat)) ev[t] = { competition: x.competition, row: x };
      });
      c.events = ev;
      if (!c.tour || !ev[c.tour]) c.tour = TOURS.filter(function (t) { return ev[t]; })[0] || null;
      c.byComp = c.byComp || {};
      var pick = c.tour ? ev[c.tour] : null;
      if (!pick) { c.status = null; c.entitled = await get('rpc/sim_viewer_entitled'); c.run = null; return; }
      var x = await U.loadPublished(get, 'golf', season, pick.competition);
      c.byComp[pick.competition] = x;
      c.status = x.status; c.entitled = x.entitled; c.run = x.run; c.results = x.results; c.entities = x.entities; c.edges = [];
    },
    onAction: function (act, val, c) {
      if (act === 'tour' && TOURS.indexOf(val) >= 0 && c.events && c.events[val]) {
        c.tour = val;
        var x = c.byComp && c.byComp[c.events[val].competition];
        if (x) { c.status = x.status; c.entitled = x.entitled; c.run = x.run; c.results = x.results; c.entities = x.entities; return 'paint'; }
        return 'load';
      }
      if (act === 'sort' && /^(win|top_5|top_10|top_20|make_cut|pos|skill|mean_place)$/.test(val || '')) {
        var s = c.sort || { key: 'win', dir: 'desc' };
        c.sort = { key: val, dir: s.key === val && s.dir === 'desc' ? 'asc' : 'desc' };
        return 'paint';
      }
      return null;
    },
    paint: function (ctx) {
      var c = ctx.cache || {}, s = ctx.sport, now = ctx.nowMs || Date.now();
      var gate = U.gateHtml(s, c, now); if (gate) return tourPicker(c) + gate;
      var st = U.deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: now });
      var v = ctx.tab === 'finishes' ? renderFinishes(c) : ctx.tab === 'model_health' ? renderHealth(c) : renderLeaderboard(c);
      return tourPicker(c) + U.renderMeta(s, c.run, st, now).replace('simulated seasons', 'simulated tournaments') + v;
    }
  };
  return { adapter: adapter, renderLeaderboard: renderLeaderboard, renderFinishes: renderFinishes, renderHealth: renderHealth, american: american, bands: bands };
});
