/* EdgeDesk men's college basketball research — the page.
   Reads /basketball/ncaam_research/published/*.json; recomputes matchups and
   scenarios with window.NCAAMResearch (lib/ncaam_research.js), the code the
   build used. Four kinds of number are kept visibly apart:
     DESCRIPTIVE  what happened (records, raw rates, on/off, raw lineup net)
     ESTIMATED    opponent-adjusted, shrunk skill (ratings, sustainable rates, impact)
     PROJECTED    forecasts with calibrated uncertainty (matchups, openers)
     CONDITIONAL  "if this player is out" scenarios: not availability, not causal proof */
(function () {
  'use strict';
  var DATA = '/basketball/ncaam_research/published/';
  var NR = window.NCAAMResearch;
  var cache = {};
  var $view = document.getElementById('view');
  var $tip = document.getElementById('tip');

  function get(name) {
    if (!cache[name]) cache[name] = fetch(DATA + name, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(name + ' ' + r.status); return r.json(); });
    return cache[name];
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function f(v, k) { if (v == null || !isFinite(v)) return '—'; return Number(v).toFixed(k == null ? 1 : k); }
  function sg(v, k) { if (v == null || !isFinite(v)) return '—'; var s = Number(v).toFixed(k == null ? 1 : k); return (v > 0 ? '+' : '') + s; }
  function pct(v, k) { if (v == null || !isFinite(v)) return '—'; return (100 * v).toFixed(k == null ? 1 : k) + '%'; }
  function pm(v, sd, k) { return f(v, k) + (sd != null ? ' <span class="mut">± ' + f(sd, k) + '</span>' : ''); }
  function chip(cls, text) { return '<span class="st ' + cls + '"><i></i>' + esc(text) + '</span>'; }
  function kindTag(k) { var m = { d: ['DESCRIPTIVE', ''], e: ['ESTIMATED', ''], p: ['PROJECTED', ''], c: ['CONDITIONAL', 'warn'] }[k]; return '<span class="tag ' + m[1] + '">' + m[0] + '</span>'; }
  function table(head, rows, opts) {
    opts = opts || {};
    return '<div class="tbl-wrap"><table><thead><tr>' + head.map(function (h) { var r = h.charAt(0) === '>'; return '<th' + (r ? ' class="r"' : '') + '>' + esc(r ? h.slice(1) : h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr' + (r.href ? ' class="click" data-href="' + esc(r.href) + '"' : '') + '>' + r.cells.map(function (c, i) { var right = head[i] && head[i].charAt(0) === '>'; return '<td' + (right ? ' class="r num"' : (c && c.wrap ? ' class="wrapcell"' : '')) + '>' + (c && c.html != null ? c.html : esc(c)) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>' + (opts.note ? '<div class="note">' + opts.note + '</div>' : '');
  }
  function bindRows() { Array.prototype.forEach.call($view.querySelectorAll('tr[data-href]'), function (tr) { tr.addEventListener('click', function () { location.hash = tr.getAttribute('data-href'); }); }); }
  function tipOn(el, html) {
    el.addEventListener('mousemove', function (e) { $tip.innerHTML = html; $tip.style.display = 'block'; $tip.style.left = Math.min(window.innerWidth - 290, e.clientX + 12) + 'px'; $tip.style.top = (e.clientY + 12) + 'px'; });
    el.addEventListener('mouseleave', function () { $tip.style.display = 'none'; });
  }
  /* diverging bars: polarity around zero (blue helps, red hurts), value at the tip */
  function divBars(items, scale) {
    var max = scale || Math.max.apply(null, items.map(function (i) { return Math.abs(i.v); }).concat([1]));
    return '<div class="bars">' + items.map(function (i, k) {
      var w = Math.min(50, 50 * Math.abs(i.v) / max);
      return '<div class="bar-row" data-bar="' + k + '"><div>' + esc(i.label) + '</div><div class="bar-track"><span class="mid"></span><span class="b ' + (i.v >= 0 ? 'p' : 'n') + '" style="' + (i.v >= 0 ? 'left:50%;' : 'left:' + (50 - w) + '%;') + 'width:' + w + '%"></span></div><div class="num r">' + sg(i.v) + '</div></div>';
    }).join('') + '</div>';
  }
  function bindBarTips(items) { Array.prototype.forEach.call($view.querySelectorAll('.bar-row[data-bar]'), function (el) { var i = items[+el.getAttribute('data-bar')]; if (i && i.tip) tipOn(el, i.tip); }); }

  /* ---------------------------------------------------------------- freshness */
  function freshness(idx) {
    var el = document.getElementById('fresh');
    el.innerHTML = '<span><b>Season</b> 2025-26 (complete)</span><span><b>Data through</b> ' + esc(idx.data_through.slice(0, 10)) + '</span><span><b>Teams</b> ' + idx.teams.length + ' D1</span><span><b>Source</b> datapack/ncaam_v1, hash-verified</span><span><b>Market</b> ' + (idx.status.market.indexOf('UNAVAILABLE') === 0 ? 'unavailable' : esc(idx.status.market)) + '</span>';
  }
  function statusChips(idx) {
    var s = idx.status; var c = function (text) { return text.indexOf('VALIDATED') === 0 ? 'ok' : text.indexOf('MODEST') === 0 ? 'mod' : text.indexOf('NOT') === 0 ? 'no' : text.indexOf('UNAVAILABLE') === 0 ? 'na' : 'exp'; };
    return '<div class="chips">' + [['Team model', s.team_model], ['Player impact', s.player_impact], ['Scenarios', s.scenarios], ['Lineups', s.lineups], ['Style interactions', s.interactions], ['Market', s.market]].map(function (p) { return '<span title="' + esc(p[1]) + '">' + chip(c(p[1]), p[0] + ': ' + p[1].split(':')[0]) + '</span>'; }).join('') + '</div>';
  }

  /* ---------------------------------------------------------------- teams */
  function viewTeams(idx) {
    var confs = Array.from(new Set(idx.teams.map(function (t) { return t.conference; }))).filter(Boolean).sort();
    $view.innerHTML = '<h1>Team strength, 2025-26</h1><p class="lede">Opponent-adjusted points per 100 possessions against an average D1 team at a neutral site (' + kindTag('e') + '), with the posterior standard deviation. Ratings are the frozen, validated model as of the season\'s last game; the 2026-27 season has not started and its rosters are not in the data.</p>' + statusChips(idx) +
      '<div class="controls"><input id="q" placeholder="Search team" aria-label="Search team"><select id="conf" aria-label="Conference"><option value="">All conferences</option>' + confs.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('') + '</select><span class="note">Click a team for its research.</span></div><div id="tt"></div>';
    var draw = function () {
      var q = document.getElementById('q').value.toLowerCase(); var cf = document.getElementById('conf').value;
      var rows = idx.teams.filter(function (t) { return (!q || t.name.toLowerCase().indexOf(q) >= 0) && (!cf || t.conference === cf); });
      document.getElementById('tt').innerHTML = table(['>Rank', 'Team', 'Conf', '>W-L', '>Net', '>Adj O', '>Adj D', '>Tempo', 'Best player (est.)'], rows.map(function (t) {
        return { href: '#/team/' + t.id, cells: [t.rank, { html: '<b>' + esc(t.short) + '</b>' }, t.conference || '—', t.w + '-' + t.l, { html: pm(t.net, t.sd_net) }, { html: f(t.adj_o) + ' <span class="mut">#' + t.rank_o + '</span>' }, { html: f(t.adj_d) + ' <span class="mut">#' + t.rank_d + '</span>' }, f(t.tempo), t.best_player || '—'] };
      }), { note: 'Net = Adj O − Adj D. ± is one posterior SD of the net rating. Tempo = possessions per 40 minutes against an average-tempo opponent.' });
      bindRows();
    };
    document.getElementById('q').addEventListener('input', draw); document.getElementById('conf').addEventListener('change', draw); draw();
  }

  /* ---------------------------------------------------------------- team */
  function viewTeam(id) {
    Promise.all([get('teams/' + id + '.json'), get('league.json')]).then(function (r) {
      var d = r[0]; var lg = r[1]; var t = d.team; var rt = d.rating;
      var h = '<h1>' + esc(t.name) + '</h1><p class="lede">' + esc(t.conference || '') + ' · ' + d.record.w + '-' + d.record.l + ' (' + d.record.conf_w + '-' + d.record.conf_l + ' conference) · as of ' + esc(String(d.as_of).slice(0, 10)) + ' · <a href="#/matchup?h=' + t.id + '">Build a matchup →</a></p>';
      h += '<div class="grid g4">' +
        tile('Net rating ' + kindTag('e'), sg(rt.net), '± ' + f(rt.sd_net, 2) + ' · #' + rt.rank_net + ' of ' + rt.of) +
        tile('Adjusted offense', f(rt.adj_o), '#' + rt.rank_o + ' · ± ' + f(rt.sd_o, 2)) +
        tile('Adjusted defense', f(rt.adj_d), '#' + rt.rank_d + ' (lower is better) · ± ' + f(rt.sd_d, 2)) +
        tile('Tempo', f(rt.tempo), '#' + rt.rank_tempo + ' fastest · possessions per 40') + '</div>';
      h += '<div class="grid g2"><div class="card"><h3>Current form vs the season</h3>' + (rt.current_form ? '<p>30-day-weighted net <b>' + sg(rt.current_form.net) + '</b> (' + sg(rt.current_form.difference_from_season) + ' vs season-long).</p><p class="note">' + esc(rt.current_form.note) + '</p>' : '—') +
        '<h3>Earlier seasons</h3>' + (rt.previous.length ? rt.previous.map(function (p) { return '<div>' + p.season + ': net ' + sg(p.net) + ' (#' + p.rank_net + ') · O ' + f(p.adj_o) + ' / D ' + f(p.adj_d) + '</div>'; }).join('') : '<span class="mut">not D1 or not rated</span>') + '</div>' +
        '<div class="card"><h3>Schedule and venue ' + kindTag('d') + '</h3><dl class="kv"><dt>Opponents\' mean net</dt><dd>' + sg(rt.schedule.opponents_mean_net) + ' (' + rt.schedule.d1_games + ' D1 games)</dd><dt>Non-conference opponents</dt><dd>' + sg(rt.schedule.nonconference_opponents_mean_net) + '</dd>' +
        ['home', 'away', 'neutral'].map(function (k) { var v = rt.venue_splits_observed[k]; return '<dt>' + k + ' raw net</dt><dd>' + (v.games ? sg(v.raw_net_per_100) + ' in ' + v.games : '—') + '</dd>'; }).join('') + '</dl><p class="note">' + esc(rt.venue_splits_observed.note) + '. D1-wide home edge: ' + f(lg.home_court_points_per_100, 1) + ' per 100.</p></div></div>';
      // why they are good
      var ex = d.explanation;
      var items = ex.contributions.map(function (c) { return { label: (c.side === 'offense' ? 'Off: ' : 'Def: ') + c.label, v: c.points_per_100, tip: esc(c.side) + ' ' + esc(c.label) + ': ' + pct(c.value) + ' vs D1 ' + pct(c.league) + '<br>' + sg(c.points_per_100) + ' points per 100' }; });
      h += '<h2>What makes them effective</h2><div class="card"><p>' + (ex.strengths.length ? '<b>Strengths:</b> ' + ex.strengths.map(esc).join('; ') : 'No four-factor strength beyond half a point per 100.') + '</p><p>' + (ex.weaknesses.length ? '<b>Weaknesses:</b> ' + ex.weaknesses.map(esc).join('; ') : '') + '</p>' +
        '<h3>Four factors in points per 100 vs a D1-average team ' + kindTag('e') + '</h3>' + divBars(items) + '<p class="note">' + esc(ex.note) + '</p></div>';
      // style table
      var groups = { shooting: 'Shooting', shot_mix: 'Shot mix', ball_security: 'Ball security', rebounding: 'Rebounding', free_throws: 'Free throws & fouls', creation: 'Creation', transition: 'Transition', tempo: 'Possession length' };
      var srows = []; Object.keys(d.style).forEach(function (k) { var s = d.style[k]; srows.push({ cells: [{ html: esc(s.label) + ' <span class="mut">' + esc(groups[s.group] || s.group) + '</span>' }, fmtRate(k, s.off && s.off.observed), fmtRate(k, s.off && s.off.sustainable), s.off && s.off.rank_good ? '#' + s.off.rank_good : '—', fmtRate(k, s.def && s.def.observed), fmtRate(k, s.def && s.def.sustainable), s.def && s.def.rank_good ? '#' + s.def.rank_good : '—', fmtRate(k, s.league), s.reliability ? f(s.reliability.off, 2) + ' / ' + f(s.reliability.def, 2) : '—'] }); });
      h += '<h2>Style and skill profile</h2><p class="lede">Observed = the plain season rate ' + kindTag('d') + '. Sustainable = opponent-adjusted and shrunk by the rate\'s measured reliability ' + kindTag('e') + ': a rate that is mostly noise (3-point % allowed) is pulled hard toward average. Rank is by what is good for this team (1 = best); shot-mix shares have no "good" direction.</p>' +
        table(['Rate', '>Off observed', '>Off sustainable', '>Off rank', '>Def allowed obs.', '>Def sustainable', '>Def rank', '>D1 avg', '>Reliability O/D'], srows, { note: 'Rim and mid-range rates come from the publisher\'s NCAA shot classification (used only where its totals match the official box). Transition rows: 2026 publisher possession classification. No tracking data: shot quality, coverages and spacing are not measured.' });
      var sv = d.style_variance;
      h += '<div class="card"><h3>Shooting variance ' + kindTag('d') + '</h3><p>Game-to-game SD of 3P%: ' + pct(sv.three_pct_game_sd) + ' (opponents ' + pct(sv.opponent_three_pct_game_sd) + ').' + (sv.luck ? ' 3-point shooting above its sustainable level: ' + sg(sv.luck.team_three_pct_vs_sustainable_points_per_game, 2) + ' pts/game; opponents\': ' + sg(sv.luck.opponent_three_pct_vs_sustainable_points_per_game, 2) + ' pts/game.' : '') + '</p><p class="note">' + esc(sv.note) + '</p></div>';
      // three questions
      var q = d.questions;
      h += '<h2>Who makes them good</h2><div class="grid g4">' +
        tile('Best player (per possession) ' + kindTag('e'), q.best_player ? esc(q.best_player.name) : '—', q.best_player ? sg(q.best_player.impact_net) + ' ± ' + f(q.best_player.sd) + ' per 100' : 'no player with 500+ possessions') +
        tile('Most productive (impact × minutes)', q.most_productive ? esc(q.most_productive.name) : '—', q.most_productive ? sg(q.most_productive.points_per_game, 1) + ' pts/game vs average' : '') +
        tile('Hardest to replace ' + kindTag('c'), q.hardest_to_replace ? esc(q.hardest_to_replace.name) : '—', q.hardest_to_replace ? sg(q.hardest_to_replace.points_per_game, 1) + ' ± ' + f(q.hardest_to_replace.sd) + ' pts/game if out' : '') +
        tile('Rotation', d.rotation_summary.players_10_plus_mpg + ' players 10+ mpg', 'bench ' + pct(d.rotation_summary.bench_minutes_share, 0) + ' of minutes · returning ' + (d.rotation_summary.returning_minutes_share == null ? '—' : pct(d.rotation_summary.returning_minutes_share, 0)) + ' of 2024-25 minutes') + '</div>';
      if (d.rotation_summary.transfers_in.length) h += '<p class="note">Transfers in (played D1 elsewhere in 2024-25): ' + d.rotation_summary.transfers_in.map(esc).join(', ') + '.</p>';
      h += table(['Player', 'Pos', '>Exp. min', '>Appear', '>Impact O', '>Impact D', '>Net ± SD', '>Contrib. pts/g', '>If out pts/g', 'Roles', 'Notes'], d.players.filter(function (p) { return p.minutes || p.impact.off_poss > 100; }).map(function (p) {
        var notes = []; if (p.transfer_in) notes.push('<span class="tag">transfer</span>'); if (p.separability && !p.separability.separable) notes.push('<span class="tag warn" title="' + esc(sepText(p.separability)) + '">not separable</span>'); if (p.impact.off_poss < 300) notes.push('<span class="tag warn">small sample</span>'); if (!p.athlete) notes.push('<span class="tag">no ESPN link</span>');
        return { href: '#/player/' + t.id + '/' + p.id, cells: [{ html: '<b>' + esc(p.name) + '</b>' }, p.pos || '—', p.minutes ? f(p.minutes.expected) : '—', p.minutes ? pct(p.minutes.appearance_rate, 0) : '—', sg(p.impact.o), sg(p.impact.d), { html: sg(p.impact.net) + ' <span class="mut">± ' + f(p.impact.sd_net) + '</span>' }, p.contribution ? sg(p.contribution.points_per_game) : '—', p.replacement ? sg(p.replacement.points_per_game) : '—', { html: (p.roles || []).map(function (x) { return '<span class="tag">' + esc(x.replace('_', ' ')) + '</span>'; }).join('') }, { html: notes.join('') }] };
      }), { note: 'Impact: points per 100 possessions against an average D1 player with teammates and opponents held fixed (RAPM with a box-score and prior-season prior). Contribution = impact × share of the game played. "If out" = conditional estimate after his minutes go to the teammates who would take them. Click a player for the evidence.' });
      // scenario tool
      h += '<h2>Availability and minutes scenarios ' + kindTag('c') + '</h2><div class="card" id="scen"></div>';
      // lineups
      h += '<h2>Lineups</h2><p class="lede">Most-used fives. Raw = points per 100 scored minus allowed ' + kindTag('d') + '. Adjusted = against the opponents actually faced. Pooled = the five players\' impact sum plus the lineup\'s own adjusted result shrunk toward it ' + kindTag('e') + '. This season the lineups\' extra results did not repeat across the season halves, so the pooled value equals the player sum.</p>' +
        table(['Five', '>Min', '>Poss', '>Raw net', '>Adjusted', '>Player sum', '>Pooled', '>Own-result weight'], d.lineups.map(function (l) { return { cells: [{ html: l.players.map(esc).join(', '), wrap: true }, f(l.minutes, 0), l.off_poss + l.def_poss, sg(l.raw_net), sg(l.adjusted_net), sg(l.player_sum), { html: '<b>' + sg(l.pooled_net) + '</b>' }, f(l.weight_on_own_results, 2)] }; }));
      // games
      h += '<h2>Games, with what the model said before tip</h2>' + table(['Date', 'Opponent', 'Venue', 'Result', '>Off eff', '>Def eff', '>Pregame margin', '>Pregame win %'], d.games.map(function (g) {
        return { href: '#/team/' + g.opp, cells: [g.date, g.opp_name, g.venue, { html: '<span class="' + (g.result === 'W' ? 'pos' : 'neg') + '">' + g.result + '</span> ' + g.pts + '-' + g.opp_pts + (g.ot ? ' (' + g.ot + 'OT)' : '') }, f(g.off_eff), f(g.def_eff), g.pregame ? sg(g.pregame.margin) : '—', g.pregame ? pct(g.pregame.win_prob, 0) : '—'] };
      }), { note: 'Pregame numbers are out-of-sample: predicted 30 minutes before tip from games finished by then (assumed available 4 hours after tip; first-publication times are not in the data).' });
      $view.innerHTML = h; bindRows(); bindBarTips(items);
      scenarioTool(document.getElementById('scen'), d);
    }).catch(fail);
  }
  function sepText(s) { return s.shared_share > 0.85 ? 'On the floor with ' + s.top_teammate + ' for ' + Math.round(100 * s.shared_share) + '% of his possessions: their individual effects cannot be reliably separated; their combined effect is better determined than either alone.' : 'His estimate and ' + s.top_teammate + '\'s are strongly confounded (posterior correlation ' + f(s.posterior_corr, 2) + '): read them together.'; }
  function tile(lab, val, sub) { return '<div class="tile"><div class="lab">' + lab + '</div><div class="val">' + val + '</div><div class="sub">' + (sub || '') + '</div></div>'; }
  function fmtRate(k, v) { if (v == null) return '—'; if (k === 'fast_break_100') return f(v, 1); if (k === 'sec_per_poss') return f(v, 1) + 's'; if (k === 'transition_ppp' || k === 'halfcourt_ppp') return f(v, 3); return pct(v); }

  /* scenario controls: who is out, minute caps, the five who close, starter minutes to the bench, a player added
     from another team (a transfer, or anyone) with his own impact and minutes */
  function scenarioTool(el, d, opts) {
    opts = opts || {};
    var rot = d.scenario_rotation.slice().sort(function (a, b) { return b.baseline - a.baseline; });
    if (rot.length < 6) { el.innerHTML = '<p class="mut">Not enough linked rotation players to run scenarios.</p>'; return null; }
    var shown = opts.limit ? rot.slice(0, opts.limit) : rot; // every rotation player still takes minutes; only the rows are limited
    var usual = {}; NR.redistribute(rot, {}).players.forEach(function (p) { usual[p.id] = p.minutes; });
    var pre = opts.prefix || 's'; var added = [];
    el.innerHTML = (opts.compact ? '' : '<p class="note">Choose who is out, cap minutes (foul trouble or a restriction), pick the five who close games, shift starter minutes to the bench, or add a player from another team (a transfer). Minutes are redistributed to the players who usually take them (positional similarity, each capped at his season high) and priced with on-court impact. These are conditional estimates: there is no confirmed availability feed, and in validation such adjustments did not improve game predictions.</p>') +
      '<div class="tbl-wrap"><table><thead><tr><th>Player</th><th class="r" title="recent minutes when available, scaled so the rotation plays 200 player-minutes">Usual min</th><th>Out</th><th class="r">Cap</th><th title="the five on the floor for the final five minutes">Closer</th><th class="r">Scenario min</th><th class="r">Effect /100</th></tr></thead><tbody id="' + pre + 'rows">' + shown.map(function (p, i) {
        return '<tr><td>' + esc(p.name) + ' <span class="mut">' + esc(p.pos || '') + '</span></td><td class="r num">' + f(usual[p.id]) + '</td><td><input type="checkbox" data-out="' + i + '" aria-label="' + esc(p.name) + ' out"></td><td class="r"><input type="number" min="0" max="40" step="1" style="width:64px" data-cap="' + i + '" aria-label="' + esc(p.name) + ' minutes cap"></td><td><input type="checkbox" data-close="' + i + '" aria-label="' + esc(p.name) + ' closes"></td><td class="r num" data-sm="' + i + '">—</td><td class="r num" data-se="' + i + '">—</td></tr>';
      }).join('') + '</tbody></table></div>' + (shown.length < rot.length ? '<p class="note">Showing the ' + shown.length + ' players with the most minutes; the other ' + (rot.length - shown.length) + ' still take minutes.</p>' : '') +
      '<div class="controls"><label class="ck">Starter minutes to the bench <input type="range" min="0" max="0.3" step="0.05" value="0" data-bench="1"> <span data-benchv="1">0%</span></label></div>' +
      '<div class="controls"><span class="note">Add a player:</span><select data-addteam="1" aria-label="Team to add a player from"><option value="">team…</option></select><select data-addplayer="1" aria-label="Player to add" disabled><option value="">player…</option></select><input type="number" min="1" max="38" step="1" style="width:70px" placeholder="min" data-addmin="1" aria-label="Minutes for the added player"><button type="button" data-add="1">Add</button><span data-added="1"></span></div>' +
      '<div class="banner" data-out-summary="1"></div>';
    var q = function (sel) { return el.querySelector(sel); };
    get('index.json').then(function (idx) {
      q('[data-addteam]').innerHTML = '<option value="">team…</option>' + idx.teams.slice().sort(function (a, b) { return a.short < b.short ? -1 : 1; }).filter(function (t) { return t.id !== d.team.id; }).map(function (t) { return '<option value="' + t.id + '">' + esc(t.short) + '</option>'; }).join('');
    });
    q('[data-addteam]').addEventListener('change', function () {
      var tid = this.value; var ps = q('[data-addplayer]'); ps.disabled = true; if (!tid) return;
      get('teams/' + tid + '.json').then(function (td) {
        ps.innerHTML = '<option value="">player…</option>' + td.players.filter(function (p) { return p.minutes && p.minutes.expected > 0; }).map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + ' (' + sg(p.impact.net) + ', ' + f(p.minutes.expected, 0) + ' min)</option>'; }).join('');
        ps.disabled = false; ps._doc = td;
      });
    });
    q('[data-add]').addEventListener('click', function () {
      var ps = q('[data-addplayer]'); var td = ps._doc; if (!td || !ps.value) return;
      var p = td.players.find(function (x) { return String(x.id) === ps.value; }); if (!p || added.some(function (a) { return a.id === 'add:' + p.id; })) return;
      var mins = Number(q('[data-addmin]').value) || p.minutes.expected;
      added.push({ id: 'add:' + p.id, name: p.name + ' (from ' + td.team.short + ')', pos: p.pos, expected: mins, cap: Math.max(mins, p.minutes.cap || mins), o: p.impact.o, d: p.impact.d, sd_o: p.impact.sd_o, sd_d: p.impact.sd_d });
      run();
    });
    el.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('[data-remove]'); if (!b) return; added = added.filter(function (a) { return a.id !== b.getAttribute('data-remove'); }); run(); });
    var state = { delta: null };
    var run = function () {
      var out = []; var cap = {}; var closing = [];
      shown.forEach(function (p, i) { if (q('[data-out="' + i + '"]').checked) out.push(p.id); var c = q('[data-cap="' + i + '"]').value; if (c !== '') cap[p.id] = Number(c); if (q('[data-close="' + i + '"]').checked) closing.push(p.id); });
      var bench = Number(q('[data-bench]').value); q('[data-benchv]').textContent = Math.round(bench * 100) + '%';
      var tooMany = closing.length > 5; if (tooMany) closing = closing.slice(0, 5);
      var sc = NR.scenario(rot, { out: out, cap: cap, bench_share: bench, closing: closing, add: added }); var dv = sc.delta_vs_usual;
      sc.minutes.players.forEach(function (p) { var i = shown.findIndex(function (x) { return x.id === p.id; }); if (i < 0) return; q('[data-sm="' + i + '"]').textContent = f(p.minutes); var c = dv.contributions.find(function (x) { return x.id === p.id; }); q('[data-se="' + i + '"]').textContent = c ? sg(c.net_effect, 2) : '0.00'; });
      q('[data-added]').innerHTML = added.map(function (a) { var m = sc.minutes.players.find(function (x) { return x.id === a.id; }); var c = dv.contributions.find(function (x) { return x.id === a.id; }); return ' <span class="tag">' + esc(a.name) + ' · ' + f(m ? m.minutes : 0) + ' min · ' + sg(c ? c.net_effect : 0, 2) + '/100 <button type="button" data-remove="' + esc(a.id) + '" aria-label="Remove ' + esc(a.name) + '">×</button></span>'; }).join('');
      var any = out.length || Object.keys(cap).length || bench || closing.length || added.length;
      var poss = d.rating.tempo; var fs = sc.full_strength_vs_rating.net;
      var drift = opts.compact ? '' : '<p class="note">For reference: the usual rotation with everyone available differs from the season-average minutes inside the published rating by ' + sg(fs, 2) + ' per 100 (players who missed games or changed roles). That difference is not added to the rating: with availability known after the fact it did not improve predictions.</p>';
      q('[data-out-summary]').innerHTML = (any ? '<b>Conditional change in net rating: ' + sg(dv.net, 2) + ' per 100</b> (± ' + f(dv.sd_net, 2) + ') against the usual rotation, about ' + sg(dv.net * poss / 100, 1) + ' points per game at their tempo. Offense ' + sg(dv.off, 2) + ', defense ' + sg(dv.def, 2) + '.' + (Math.abs(sc.minutes.unassigned) > 0.5 ? ' <span class="neg">' + f(sc.minutes.unassigned) + ' minutes could not be placed within players\' caps.</span>' : '') + (tooMany ? ' <span class="neg">Only the first five closers are used.</span>' : '') : 'No change selected: the team rating as published.') + drift;
      state.delta = any ? dv : null; state.label = any ? describe(out, cap, closing, bench, added, rot) : null;
      if (opts.onChange) opts.onChange(state);
    };
    el.addEventListener('input', run); run();
    return state;
  }
  function describe(out, cap, closing, bench, added, rot) {
    var nm = function (id) { var p = rot.find(function (x) { return x.id === id; }); return p ? p.name : id; }; var parts = [];
    if (out.length) parts.push(out.map(nm).join(', ') + ' out');
    Object.keys(cap).forEach(function (id) { parts.push(nm(isNaN(+id) ? id : +id) + ' capped at ' + cap[id] + ' min'); });
    if (closing.length) parts.push('closing five: ' + closing.map(nm).join(', '));
    if (bench) parts.push(Math.round(bench * 100) + '% of starter minutes to the bench');
    if (added.length) parts.push(added.map(function (a) { return a.name + ' added'; }).join(', '));
    return parts.join('; ');
  }

  /* ---------------------------------------------------------------- player */
  function viewPlayer(teamId, pid) {
    Promise.all([get('teams/' + teamId + '.json')]).then(function (r) {
      var d = r[0]; var p = d.players.find(function (x) { return String(x.id) === String(pid); });
      if (!p) { $view.innerHTML = '<div class="empty">Player not found.</div>'; return; }
      var im = p.impact; var b = p.box; var m = p.minutes;
      var h = '<h1>' + esc(p.name) + '</h1><p class="lede"><a href="#/team/' + d.team.id + '">' + esc(d.team.name) + '</a> · ' + esc(p.pos || 'position unknown') + (p.transfer_in ? ' · transfer in' : p.returning ? ' · returning' : '') + ' · NCAA id ' + p.identity.ncaa_player_id + ' · ESPN id ' + (p.identity.espn_athlete_id || '—') + ' <span class="mut">(' + (p.identity.link === 'fingerprint' ? 'linked by box-score fingerprints' : 'no fingerprint link: no minutes history') + ')</span></p>';
      h += '<div class="grid g4">' + tile('Impact per 100 ' + kindTag('e'), sg(im.net, 2), '± ' + f(im.sd_net, 2) + ' · O ' + sg(im.o) + ' / D ' + sg(im.d)) +
        tile('Expected minutes', m ? f(m.expected) : '—', m ? 'appears in ' + pct(m.appearance_rate, 0) + ' of team games · starts ' + pct(m.start_rate, 0) : '') +
        tile('Total contribution', p.contribution ? sg(p.contribution.points_per_game, 2) + ' pts/g' : '—', 'impact × share of the game played') +
        tile('If out ' + kindTag('c'), p.replacement ? sg(p.replacement.points_per_game, 2) + ' pts/g' : '—', p.replacement ? '± ' + f(p.replacement.sd, 2) + ' per 100 vs the usual rotation · minutes to ' + p.replacement.minutes_to.map(function (x) { return esc(x.name) + ' (+' + f(x.extra_minutes) + ')'; }).join(', ') : '') + '</div>';
      h += '<div class="grid g2"><div class="card"><h3>How the impact estimate is built</h3><dl class="kv"><dt>Box-score prior</dt><dd>' + (im.prior ? sg(im.prior.net, 2) + ' (O ' + sg(im.prior.o) + ', D ' + sg(im.prior.d) + ')' : '—') + '</dd><dt>Possessions on floor</dt><dd>' + im.off_poss + ' offense / ' + im.def_poss + ' defense</dd><dt>Estimate</dt><dd>' + sg(im.net, 2) + ' ± ' + f(im.sd_net, 2) + '</dd>' +
        (p.publisher_rapm ? '<dt>Publisher RAPM (benchmark)</dt><dd>' + sg(p.publisher_rapm.net, 2) + ' <span class="mut">publisher full-season fit; benchmark only</span></dd>' : '') + '</dl><p class="note">The estimate starts at the box-score prior and moves toward what happened with him on the floor, with teammates and opponents held fixed; the more possessions, the further it can move.</p></div>' +
        '<div class="card"><h3>Raw on/off ' + kindTag('d') + '</h3><dl class="kv"><dt>Team net with him</dt><dd>' + sg(p.on_off.on_net) + ' per 100 (' + p.on_off.on_poss + ' poss)</dd><dt>Without him</dt><dd>' + sg(p.on_off.off_net) + ' per 100 (' + p.on_off.off_poss + ' poss)</dd><dt>Difference</dt><dd>' + sg(p.on_off.difference) + '</dd></dl><p class="note">Descriptive: who else was on the floor is not held fixed. Not evidence of causal impact.</p>' +
        (p.separability ? '<h3>Separability</h3><p>' + (p.separability.separable ? 'Separable from teammates: his most-shared teammate (' + esc(p.separability.top_teammate) + ') was with him for ' + pct(p.separability.shared_share, 0) + ' of his possessions.' : '<span class="neg">' + esc(sepText(p.separability)) + '</span>') + ' Posterior correlation of their estimates: ' + f(p.separability.posterior_corr, 2) + '.</p>' : '') + '</div></div>';
      if (b) h += '<h2>Role and evidence ' + kindTag('d') + '</h2><div class="grid g2"><div class="card"><h3>Usage and efficiency</h3><dl class="kv"><dt>Usage (per 100 poss)</dt><dd>' + f(b.usage) + '</dd><dt>True shooting</dt><dd>' + pct(b.ts_pct) + '</dd><dt>eFG</dt><dd>' + pct(b.efg) + '</dd><dt>Points / 100</dt><dd>' + f(b.per100.pts) + '</dd><dt>Unassisted share of makes</dt><dd>' + pct(b.unassisted_share_of_makes) + ' <span class="mut">(self-creation)</span></dd><dt>Assists / turnovers per 100</dt><dd>' + f(b.per100.ast) + ' / ' + f(b.per100.tov) + '</dd></dl></div>' +
        '<div class="card"><h3>Shot profile and finishing</h3><dl class="kv"><dt>Rim share / FG%</dt><dd>' + pct(b.rim_share) + ' / ' + pct(b.rim_pct) + '</dd><dt>Mid-range share / FG%</dt><dd>' + pct(b.mid_share) + ' / ' + pct(b.mid_pct) + '</dd><dt>3PA share / 3P%</dt><dd>' + pct(b.three_rate) + ' / ' + pct(b.three_pct) + ' on ' + b.three_attempts + '</dd><dt>FT rate / FT%</dt><dd>' + pct(b.ft_rate) + ' / ' + pct(b.ft_pct) + '</dd><dt>Transition share of FGA</dt><dd>' + pct(b.transition_share_of_fga) + '</dd><dt>Putback attempts</dt><dd>' + b.putback_attempts + '</dd></dl>' + (b.sample_note ? '<p class="note">' + esc(b.sample_note) + '</p>' : '') + '</div>' +
        '<div class="card"><h3>Rebounding and defense</h3><dl class="kv"><dt>Off / def rebounds per 100</dt><dd>' + f(b.per100.orb) + ' / ' + f(b.per100.drb) + '</dd><dt>Steals / blocks per 100</dt><dd>' + f(b.per100.stl) + ' / ' + f(b.per100.blk) + '</dd><dt>Fouls per 100</dt><dd>' + f(b.per100.pf) + '</dd><dt>Fouls per 40 / foul-outs</dt><dd>' + (m ? f(m.fouls_per_40) + ' / ' + m.foul_outs : '—') + '</dd><dt>Defensive impact (est.)</dt><dd>' + sg(im.d) + ' ± ' + f(im.sd_d) + '</dd></dl><p class="note">Box-score defense is thin evidence; the impact estimate carries most of what is known.</p></div>' +
        '<div class="card"><h3>Minutes and participation</h3>' + (m ? '<dl class="kv"><dt>Games / team games</dt><dd>' + m.games + ' / ' + m.team_games + '</dd><dt>Season mpg / last 5</dt><dd>' + f(m.season_mpg) + ' / ' + f(m.last5_mpg) + '</dd><dt>Expected minutes when available</dt><dd>' + f(m.expected) + '</dd><dt>Season high</dt><dd>' + f(m.cap) + '</dd></dl><p class="note">Participation is read from box scores (appeared or not); it is not an injury or eligibility record.</p>' : '<p class="mut">No ESPN link for this player, so no minutes history.</p>') + '</div></div>';
      if (p.history && p.history.length) h += '<h3>Career in the data (ESPN)</h3>' + table(['Season', 'Team', '>Games', '>MPG', '>PPG'], p.history.map(function (x) { return { cells: [(x.season - 1) + '-' + String(x.season).slice(2), x.team_name, x.games, f(x.mpg), f(x.ppg)] }; }));
      $view.innerHTML = h;
    }).catch(fail);
  }

  /* ---------------------------------------------------------------- matchup */
  function viewMatchup(params) {
    Promise.all([get('index.json'), get('league.json')]).then(function (r) {
      var idx = r[0]; var lg = r[1];
      var opts = idx.teams.slice().sort(function (a, b) { return a.short < b.short ? -1 : 1; }).map(function (t) { return '<option value="' + t.id + '">' + esc(t.short) + '</option>'; }).join('');
      $view.innerHTML = '<h1>Matchup research</h1><p class="lede">Any two D1 teams on end-of-season 2025-26 ratings. The projection needs no market price; style comparisons are shown as descriptions because no style interaction passed validation.</p>' +
        '<div class="controls"><select id="mh" aria-label="Home team">' + opts + '</select><span class="mut">vs</span><select id="ma" aria-label="Away team">' + opts + '</select><label class="ck"><input type="checkbox" id="mn"> Neutral site</label><button class="primary" id="go">Build report</button></div><div id="mrep"></div>';
      var mh = document.getElementById('mh'); var ma = document.getElementById('ma'); var mn = document.getElementById('mn');
      mh.value = params.h || idx.teams[0].id; ma.value = params.a || idx.teams[1].id; mn.checked = params.n === '1' || !params.h;
      var go = function () {
        location.replace('#/matchup?h=' + mh.value + '&a=' + ma.value + '&n=' + (mn.checked ? 1 : 0));
        Promise.all([get('teams/' + mh.value + '.json'), get('teams/' + ma.value + '.json')]).then(function (t) {
          var box = document.getElementById('mrep');
          box.innerHTML = '<details class="card" id="mscen"><summary>Scenarios for this game ' + kindTag('c') + ' (who is out, minute caps, closers, a player added)</summary><div class="grid g2"><div><h3>' + esc(t[0].team.short) + '</h3><div id="mscenh"></div></div><div><h3>' + esc(t[1].team.short) + '</h3><div id="mscena"></div></div></div></details><div id="mbody"></div>';
          var sh = { delta: null }; var sa = { delta: null };
          var draw = function () {
            var rep = NR.matchupReport(t[0], t[1], lg, { neutral: mn.checked, delta_home: sh.delta || undefined, delta_away: sa.delta || undefined });
            rep.scenario_text = [sh.label ? t[0].team.short + ': ' + sh.label : null, sa.label ? t[1].team.short + ': ' + sa.label : null].filter(Boolean).join(' · ');
            rep.market = NR.compareMarket(null, [], { unavailable_reason: 'No men\'s college basketball odds source is configured; hypothetical matchups have no market.' });
            document.getElementById('mbody').innerHTML = renderReport(rep, t[0], t[1]); bindRows();
          };
          sh = scenarioTool(document.getElementById('mscenh'), t[0], { compact: true, limit: 10, prefix: 'h', onChange: function (st) { sh = st; if (document.getElementById('mbody')) draw(); } }) || sh;
          sa = scenarioTool(document.getElementById('mscena'), t[1], { compact: true, limit: 10, prefix: 'a', onChange: function (st) { sa = st; if (document.getElementById('mbody')) draw(); } }) || sa;
          draw();
        }).catch(fail);
      };
      document.getElementById('go').addEventListener('click', go); if (params.h) go();
    }).catch(fail);
  }

  function renderReport(rep, home, away) {
    var P = rep.projection; var B = rep.baseline; var hs = rep.teams.home.short; var as = rep.teams.away.short;
    var h = '<h2>' + esc(as) + ' at ' + esc(hs) + (rep.teams.venue === 'neutral' ? ' (neutral)' : '') + '</h2>' + (rep.result && rep.as_of ? '<p class="note">As of ' + esc(rep.as_of) + ' (30 minutes before tip): only games finished before this moment were used.</p>' : '<p class="note">End-of-season 2025-26 ratings, players and lineups (data through ' + esc(String(rep.as_of || '').slice(0, 10)) + ').</p>');
    h += '<div class="grid g4">' + tile('Projected score ' + kindTag('p'), esc(hs) + ' ' + f(P.points_home, 0) + ' – ' + f(P.points_away, 0) + ' ' + esc(as), f(P.possessions) + ' possessions') +
      tile('Margin (' + esc(hs) + ')', sg(P.margin_home.mean), '80%: ' + sg(P.margin_home.p10, 0) + ' to ' + sg(P.margin_home.p90, 0) + ' · SD ' + f(P.margin_home.sd)) +
      tile('Win probability', pct(P.win_home, 0) + ' / ' + pct(P.win_away, 0), esc(hs) + ' / ' + esc(as) + ' (overtime included)') +
      tile('Total', f(P.total.mean), '80%: ' + f(P.total.p10, 0) + ' to ' + f(P.total.p90, 0) + ' · fair spread ' + esc(hs) + ' ' + sg(P.fair_spread_home) + ', fair total ' + f(P.fair_total)) + '</div>';
    if (P.scenario_applied) h += '<div class="banner warn"><b>Conditional scenario applied</b> (' + esc(rep.scenario_text || '') + '): ' + esc(hs) + ' margin ' + sg(P.margin_home.mean) + ' vs ' + sg(P.baseline_without_scenario.margin_home) + ' without it; win ' + pct(P.win_home, 0) + ' vs ' + pct(P.baseline_without_scenario.win_home, 0) + '. Not confirmed availability.</div>';
    var mp = P.margin_probabilities;
    var items = [{ label: hs + ' by 10+', v: mp.home_by_10_plus }, { label: hs + ' by 1-9', v: mp.home_by_1_9 }, { label: as + ' by 1-9', v: mp.away_by_1_9 }, { label: as + ' by 10+', v: mp.away_by_10_plus }];
    h += '<div class="card"><h3>Margin distribution ' + kindTag('p') + '</h3><div class="bars">' + items.map(function (i) { return '<div class="bar-row"><div>' + esc(i.label) + '</div><div class="bar-track"><span class="b p" style="left:0;width:' + (100 * i.v) + '%;border-radius:0 4px 4px 0"></span></div><div class="num r">' + pct(i.v, 0) + '</div></div>'; }).join('') + '</div></div>';
    h += '<h3>Baseline strength ' + kindTag('e') + '</h3>' + table(['Team', '>Net', '>Adj O', '>Adj D', '>Tempo', '>Rank'], [[hs, B.home], [as, B.away]].map(function (x) { return { cells: [x[0], { html: pm(x[1].net, x[1].sd_net) }, f(x[1].adj_o), f(x[1].adj_d), f(x[1].tempo), '#' + x[1].rank_net] }; }), { note: 'Net difference ' + sg(B.net_difference) + ' ± ' + f(B.net_difference_sd) + ' per 100; venue worth ' + f(B.venue_points) + ' points here.' });
    [['home_offense_vs_away_defense', hs + ' offense vs ' + as + ' defense'], ['away_offense_vs_home_defense', as + ' offense vs ' + hs + ' defense']].forEach(function (k) {
      var dir = rep[k[0]];
      h += '<h3>' + esc(k[1]) + '</h3><p class="note">Projected ' + f(dir.projected_points_per_100) + ' points per 100. Four-factor view: ' + sg(dir.factor_implied_points_per_100_vs_league) + ' per 100 vs a D1-average offense.</p>' +
        table(['Factor', '>Offense', '>Defense allows', '>D1 avg', '>Projected', '>Pts/100 vs avg'], dir.four_factors.map(function (l) { return { cells: [l.label, pct(l.offense), pct(l.defense_allows), pct(l.league), { html: '<b>' + pct(l.projected) + '</b>' }, sg(l.points_per_100_vs_league)] }; })) +
        '<details><summary>Shot profile and style (hypotheses, no points added)</summary>' + table(['Rate', '>Offense', '>Defense allows', '>D1 avg', '>Projected', 'Interaction status'], dir.shot_and_style_profile.map(function (l) { var fm = function (v) { return l.key === 'sec_per_poss' ? f(v) + 's' : pct(v); }; return { cells: [l.label, fm(l.offense), fm(l.defense_allows), fm(l.league), fm(l.projected), { html: '<span class="tag' + (l.interaction === 'MODEL_SUPPORTED' ? '' : ' warn') + '">' + esc(String(l.interaction).replace(/_/g, ' ').toLowerCase()) + '</span>' }] }; })) + '</details>';
    });
    h += '<h3>Tempo</h3><p>' + esc(hs) + ' plays at ' + f(rep.tempo.home.tempo) + ' (' + f(rep.tempo.home.sec_per_poss_off) + 's per offensive possession), ' + esc(as) + ' at ' + f(rep.tempo.away.tempo) + ' (' + f(rep.tempo.away.sec_per_poss_off) + 's). Projected possessions: ' + f(rep.tempo.projected_possessions) + '.</p>';
    ['home', 'away'].forEach(function (s) {
      var tm = s === 'home' ? hs : as; var tid = s === 'home' ? rep.teams.home.id : rep.teams.away.id;
      h += '<h3>' + esc(tm) + ': players who matter most</h3>' + table(['Player', '>Exp. min', '>Impact ± SD', '>Contrib. pts/g', '>If out pts/g', 'Roles'], rep.players[s].map(function (p) { return { href: '#/player/' + tid + '/' + p.id, cells: [{ html: '<b>' + esc(p.name) + '</b>' + (p.separable === false ? ' <span class="tag warn">not separable</span>' : '') }, f(p.expected_minutes), { html: sg(p.impact_net) + ' <span class="mut">± ' + f(p.impact_sd) + '</span>' }, sg(p.contribution_ppg), sg(p.replacement_cost_ppg), { html: (p.roles || []).map(function (x) { return '<span class="tag">' + esc(x.replace('_', ' ')) + '</span>'; }).join('') }] }; })) +
        (rep.lineups[s].length ? table(['Most-used five', '>Poss', '>Raw net', '>Pooled'], rep.lineups[s].map(function (l) { return { cells: [{ html: l.players.map(esc).join(', '), wrap: true }, l.off_poss + l.def_poss, sg(l.raw_net), sg(l.pooled_net)] }; })) : '');
    });
    var cx = rep.context;
    h += '<h3>Context</h3><dl class="kv"><dt>Venue</dt><dd>' + esc(cx.venue) + '</dd>' + (cx.rest_days ? '<dt>Rest days</dt><dd>' + esc(hs) + ' ' + f(cx.rest_days.home) + ', ' + esc(as) + ' ' + f(cx.rest_days.away) + ' <span class="mut">(rest showed no measurable effect in validation)</span></dd>' : '') +
      '<dt>Depth</dt><dd>' + esc(hs) + ': ' + (cx.depth.home ? cx.depth.home.players_10_plus_mpg + ' players 10+ mpg, bench ' + pct(cx.depth.home.bench_minutes_share, 0) : '—') + '; ' + esc(as) + ': ' + (cx.depth.away ? cx.depth.away.players_10_plus_mpg + ' players 10+ mpg, bench ' + pct(cx.depth.away.bench_minutes_share, 0) : '—') + '</dd><dt>Personnel</dt><dd>' + esc(cx.personnel) + '</dd></dl>';
    h += '<h3>What would change the projection ' + kindTag('c') + '</h3>' + table(['Condition', '>Effect'], rep.conditions.map(function (c) {
      if (c.kind === 'player_out') return { cells: [c.team + ': ' + c.player + ' out', { html: 'margin ' + sg(c.margin_change_home) + ' (' + esc(hs) + '), ' + esc(hs) + ' win ' + pct(c.win_home_after, 0) }] };
      if (c.kind === 'foul_trouble') return { cells: [c.team + ': ' + c.player + ' limited to ' + c.minutes_cap + ' min', { html: 'margin ' + sg(c.margin_change_home) + ', ' + esc(hs) + ' win ' + pct(c.win_home_after, 0) }] };
      if (c.kind === 'pace') return { cells: ['Pace: ' + c.detail, { html: 'total ± ' + f(c.total_change) }] };
      return { cells: [c.team + ': ' + c.detail, { html: '± ' + f(c.points) + ' points' }] };
    }), { note: 'Player conditions are conditional estimates (minutes redistributed, priced with impact); none is a statement about availability.' });
    h += '<h3>Assumptions</h3><ul class="note">' + rep.assumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>';
    h += '<h2>Market comparison</h2>' + renderMarket(rep.market);
    if (rep.result) h += '<div class="banner"><b>Result (after the report):</b> ' + esc(hs) + ' ' + rep.result.home_points + ', ' + esc(as) + ' ' + rep.result.away_points + (rep.result.overtime ? ' (OT)' : '') + ' — margin ' + sg(rep.result.margin_home, 0) + ' vs projected ' + sg(P.margin_home.mean) + '; total ' + rep.result.total + ' vs ' + f(P.total.mean) + '.</div>';
    return h;
  }
  function renderMarket(m) {
    if (!m || m.status === 'UNAVAILABLE') return '<div class="banner">' + chip('na', 'MARKET COMPARISON UNAVAILABLE') + ' <span>' + esc(m ? m.reason : '') + '</span><p class="note">Every section above is complete without a price. A fair spread or total exists without a sportsbook line.</p></div>';
    return table(['Book', 'Market', 'Side', '>Line', '>Price', '>Model win/push/lose', '>Return/unit', 'Decision', 'Gates'], m.rows.map(function (r) { return { cells: [r.book, r.market, r.side, r.line == null ? '—' : r.line, f(r.decimal, 2), r.model ? pct(r.model.win, 1) + ' / ' + pct(r.model.push, 1) + ' / ' + pct(r.model.lose, 1) : '—', sg(r.expected_return_per_unit, 3), r.decision, { html: r.gates.map(esc).join('<br>'), wrap: true }] }; }));
  }

  /* ---------------------------------------------------------------- reports, openers */
  function viewReports(idx) {
    $view.innerHTML = '<h1>Pregame reports, as of the moment before tip</h1><p class="lede">Each report was rebuilt from only the games finished before tip (ratings, styles, player impacts and minutes all as of then), then the result is shown beneath it.</p>' +
      table(['Date', 'Event', 'Game'], idx.matchups.map(function (m) { return { href: '#/report/' + m.file.replace('matchups/', '').replace('.json', ''), cells: [m.date, { html: esc(m.event || ''), wrap: true }, m.away + ' vs ' + m.home] }; }));
    bindRows();
  }
  function viewReport(id) { get('matchups/' + id + '.json').then(function (rep) { $view.innerHTML = '<p class="lede">' + esc(rep.event || '') + ' · ' + esc(rep.date) + '</p>' + renderReport(rep); bindRows(); }).catch(fail); }
  function viewUpcoming() {
    get('upcoming.json').then(function (u) {
      $view.innerHTML = '<h1>2026-27 opening games</h1><div class="banner warn"><b>Preseason carry-forward, not a roster projection.</b> ' + esc(u.basis) + '</div>' +
        table(['Tip (UTC)', 'Game', 'Regime', '>Margin (home)', '>SD', '>Home win', '>Total', 'Market'], u.games.map(function (g) { return { href: '#/matchup?h=' + g.home + '&a=' + g.away + '&n=' + (g.neutral ? 1 : 0), cells: [g.start_utc.slice(0, 16).replace('T', ' '), g.away_name + (g.neutral ? ' vs ' : ' at ') + g.home_name, g.regime === 'D1_D1' ? 'D1' : 'vs non-D1/unknown', sg(g.projection.margin_home), f(g.projection.margin_sd), pct(g.projection.win_home, 0), f(g.projection.total), g.market === 'UNAVAILABLE' ? 'unavailable' : g.market] }; }), { note: 'Source: ' + esc(u.schedule_source) + '. Clicking a game opens the matchup tool on the same ratings (with each team\'s 2025-26 players, who may have left).' });
      bindRows();
    }).catch(fail);
  }

  /* ---------------------------------------------------------------- validation */
  function viewValidation() {
    Promise.all([get('validation_team.json'), get('validation_player.json'), get('validation_interactions.json'), get('audit.json')]).then(function (r) {
      var vt = r[0]; var vp = r[1]; var vi = r[2]; var au = r[3];
      var names = { frozen: 'EdgeDesk adjusted efficiency (frozen)', no_roster_prior: '− transfer/roster prior', no_recency: '− recency', league_average_prior: 'no preseason prior', other_scale: 'multiplicative (log) form', no_blowout_damping: 'no blowout damping', constant_sd: 'constant uncertainty', incumbent_points_model: 'Incumbent EdgeDesk points model (scores only)', pack_unadjusted_prior10: 'Unadjusted prior-10-game efficiency', home_advantage_only: 'Home advantage only' };
      var h = '<h1>What the validation shows</h1><p class="lede">Chronological walk-forward. Hyperparameters were chosen on 2025 and frozen (hash ' + esc(vt.frozen_hash) + ') before 2026 was scored once. Calibration is refitted weekly on earlier out-of-sample games. Intervals are bootstrap 95%, clustered by game day. No external rating archive and no bookmaker archive is on file, so neither is a benchmark.</p>';
      [2026, 2025].forEach(function (s) {
        var c = vt.candidates[s];
        h += '<h2>' + (s === 2026 ? 'Holdout: 2025-26' : 'Selection: 2024-25') + ' (D1 vs D1, n = ' + c.frozen.n + ')</h2>' + table(['Model', '>Log loss', '>Brier', '>Margin MAE', '>Margin CRPS', '>Total CRPS', '>80% cover (margin)'], Object.keys(c).filter(function (k) { return c[k].margin; }).map(function (k) { var x = c[k]; return { cells: [{ html: (k === 'frozen' ? '<b>' : '') + esc(names[k] || k) + (k === 'frozen' ? '</b>' : '') }, f(x.win.log_loss, 4), f(x.win.brier, 4), f(x.margin.mae, 2), f(x.margin.crps, 3), f(x.total.crps, 3), pct(x.margin.coverage.c80, 1)] }; }).concat([{ cells: ['Incumbent Elo (win probability only)', f(c.incumbent_elo_win_only.log_loss, 4), f(c.incumbent_elo_win_only.brier, 4), '—', '—', '—', '—'] }]));
        var cmp = vt.comparisons[s];
        h += table(['Frozen minus …', '>Margin CRPS (95% CI)', '>Log loss (95% CI)', '>Total CRPS (95% CI)'], Object.keys(cmp).map(function (k) { var x = cmp[k]; var cell = function (y) { var good = y.ci95[1] < 0; var bad = y.ci95[0] > 0; return { html: '<span class="' + (good ? 'pos' : bad ? 'neg' : '') + '">' + sg(y.mean_diff, 4) + ' [' + f(y.ci95[0], 4) + ', ' + f(y.ci95[1], 4) + ']</span>' }; }; return { cells: [names[k.replace('frozen_vs_', '')] || k, cell(x.margin_crps), cell(x.log_loss), cell(x.total_crps)] }; }), { note: 'Negative = the frozen model is better. Green: the interval excludes zero in its favour; red: against it.' });
      });
      // reliability chart
      h += '<h2>Win-probability calibration, 2025-26 holdout</h2><div class="card">' + reliabilityChart(vt.reliability[2026]) + '<p class="note">Each dot is a probability band: mean forecast (x) against the observed home-win rate (y); the diagonal is perfect calibration. Hover for counts.</p></div>';
      var bd = vt.breakdowns;
      h += '<h2>Where it is weaker (2025-26 holdout)</h2>' + Object.keys(bd).map(function (k) { return '<h3>' + esc(k.replace(/_/g, ' ')) + '</h3>' + table(['Group', '>n', '>Log loss', '>Margin MAE', '>Margin CRPS', '>80% cover'], Object.keys(bd[k]).map(function (g) { var x = bd[k][g]; return { cells: [g, x.n, f(x.log_loss, 4), f(x.margin_mae, 2), f(x.margin_crps, 3), pct(x.margin_cov80, 1)] }; })); }).join('') +
        '<p class="note">November intervals cover 77% where 80% is intended: early-season uncertainty is understated. Rest days: ' + esc(JSON.stringify(vt.rest_check[2026].points_per_rest_day)) + ' points per day of rest difference (SE ' + vt.rest_check[2026].se + '), not in the model. Non-D1 regime (scored separately): log loss ' + f(vt.non_d1_regime[2026].win.log_loss, 3) + ', margin MAE ' + f(vt.non_d1_regime[2026].margin.mae, 1) + ' over ' + vt.non_d1_regime[2026].n + ' games.</p>';
      // player layer
      var pl = vp.possession_level; var hc = pl.holdout_comparisons;
      h += '<h2>Does the player layer add anything?</h2><p class="lede">Possession data exists for 2025-26 only, so this test is chronological within it: choose on 15 Jan – 15 Feb, score 15 Feb – season end (' + pl.test_possessions.holdout + ' possessions) from the ten players actually on the floor.</p>' +
        table(['Comparison', '>Squared error per possession (95% CI)'], [['Pure RAPM (prior zero) − team ratings', hc.rapm_zero_minus_team_only], ['RAPM + box-score prior − team ratings', hc.rapm_box_minus_team_only], ['RAPM + box + prior-season prior − team ratings', hc.rapm_box_prev_minus_team_only], ['Box prior − pure RAPM', hc.rapm_box_minus_rapm_zero], ['Prior-season prior − box only', hc.rapm_box_prev_minus_rapm_box]].map(function (x) { var y = x[1]; return { cells: [x[0], { html: '<span class="' + (y.ci95[1] < 0 ? 'pos' : y.ci95[0] > 0 ? 'neg' : '') + '">' + sg(y.mean_diff_per_possession, 2) + ' [' + f(y.ci95[0], 2) + ', ' + f(y.ci95[1], 2) + ']</span>' }] }; }), { note: 'Negative = better. Per-possession noise is enormous (points per 100 squared ≈ 13,500), so real signal shows up as small differences; the intervals say which are distinguishable from zero.' });
      var av = vp.game_level_availability;
      h += '<h3>Game level: absences with availability known after the fact</h3>' + table(['Games', '>Team model CRPS', '>+ scenario adjustment', '>Naive PPG subtraction', '>Scenario − team (95% CI)'], [['All after 15 Feb (' + av.all_games.n + ')', av.all_games], ['With an absent rotation player (' + av.games_with_absent_rotation_player.n + ')', av.games_with_absent_rotation_player]].map(function (x) { var y = x[1]; return { cells: [x[0], f(y.team_model.crps, 3), f(y.with_scenario_adjustment.crps, 3), f(y.naive_ppg_subtraction.crps, 3), sg(y.scenario_minus_team_crps.mean_diff, 3) + ' [' + f(y.scenario_minus_team_crps.ci95[0], 3) + ', ' + f(y.scenario_minus_team_crps.ci95[1], 3) + ']'] }; }), { note: esc(av.caveat) + ' Redistributed minutes: MAE ' + f(av.redistribution_minutes.mae_redistribute_with_positions, 2) + ' vs ' + f(av.redistribution_minutes.mae_no_redistribution, 2) + ' without redistribution.' });
      h += '<h3>Stability and sensitivity of impact estimates</h3><p>Split-half (odd vs even games) correlation of net impact: ' + f(vp.stability.rapm_box.split_half_r_net, 2) + ' with the box prior, ' + f(vp.stability.rapm_zero.split_half_r_net, 2) + ' without (' + vp.stability.rapm_box.players + ' players). Publisher full-season RAPM year-to-year: ' + f(au.rapm_tables.year_over_year['2025_to_2026_min500'].corr, 2) + '.</p>' +
        table(['Refit', '>Correlation with primary', '>Top-50 overlap'], vp.sensitivity.map(function (s) { return { cells: [s.name.replace(/_/g, ' '), f(s.corr_net_with_primary, 3), s.top50_overlap + ' / 50'] }; }));
      var mr = vp.minutes_and_rates.scores.holdout_2026;
      h += '<h3>Player minutes and production forecasts (2025-26, chosen on 2024-25)</h3>' + table(['Forecast', '>MAE', '>n'], Object.keys(mr).map(function (k) { return { cells: [k.replace(':', ' — ').replace(/_/g, ' '), f(mr[k].mae, 3), mr[k].n] }; }));
      var lv = au.lineups_validation;
      h += '<h2>Lineups and matchup interactions</h2><p>Lineup results beyond their players\' impacts, first half vs second half: r = ' + f(lv.persistence.corr_residual_first_vs_second_half, 2) + ' over ' + lv.persistence.lineups + ' lineups. Role composition: ' + Object.keys(lv.role_composition.coefficients).map(function (k) { var c = lv.role_composition.coefficients[k]; return esc(k.replace(/_/g, ' ')) + ' ' + sg(c.points_per_100, 2) + ' (z ' + f(c.z, 2) + (c.supported ? ', supported' : ', not supported') + ')'; }).join('; ') + '.</p><p class="note">' + esc(lv.role_composition.multiple_testing) + '</p>' +
        table(['Style interaction', '>2025 coef. (pts/100)', '>SE', 'Status'], Object.keys(vi.coefficients_2025).map(function (k) { var c = vi.coefficients_2025[k]; return { cells: [c.label, sg(c.points_per_100_per_sd2, 3), f(c.se, 3), vi.status[k].replace(/_/g, ' ').toLowerCase()] }; }), { note: '2026 squared error with minus without the terms: ' + sg(vi.holdout_2026_squared_error_with_minus_without.mean_diff, 3) + ' [' + f(vi.holdout_2026_squared_error_with_minus_without.ci95[0], 3) + ', ' + f(vi.holdout_2026_squared_error_with_minus_without.ci95[1], 3) + ']. ' + esc(vi.rule) });
      $view.innerHTML = h; bindReliabilityTips(vt.reliability[2026]);
    }).catch(fail);
  }
  function reliabilityChart(bins) {
    var W = 320; var H = 260; var pad = 34; var sx = function (v) { return pad + v * (W - pad - 10); }; var sy = function (v) { return H - pad - v * (H - pad - 10); };
    var pts = bins.filter(function (b) { return b.n; });
    var ticks = [0, 0.25, 0.5, 0.75, 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:420px" role="img" aria-label="Reliability diagram">' +
      ticks.map(function (t) { return '<line x1="' + sx(0) + '" x2="' + sx(1) + '" y1="' + sy(t) + '" y2="' + sy(t) + '" stroke="#2a2217" stroke-width="1"/><text x="' + (pad - 6) + '" y="' + (sy(t) + 3) + '" text-anchor="end">' + t + '</text><text x="' + sx(t) + '" y="' + (H - pad + 14) + '" text-anchor="middle">' + t + '</text>'; }).join('') +
      '<line x1="' + sx(0) + '" y1="' + sy(0) + '" x2="' + sx(1) + '" y2="' + sy(1) + '" stroke="#887e70" stroke-width="1"/>' +
      '<polyline fill="none" stroke="#3987e5" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="' + pts.map(function (b) { return sx(b.mean_forecast) + ',' + sy(b.observed); }).join(' ') + '"/>' +
      pts.map(function (b, i) { return '<circle data-rel="' + i + '" cx="' + sx(b.mean_forecast) + '" cy="' + sy(b.observed) + '" r="5" fill="#3987e5" stroke="#191510" stroke-width="2"/><circle data-relhit="' + i + '" cx="' + sx(b.mean_forecast) + '" cy="' + sy(b.observed) + '" r="12" fill="transparent"/>'; }).join('') +
      '<text x="' + (W / 2) + '" y="' + (H - 4) + '" text-anchor="middle">forecast home-win probability</text></svg>';
  }
  function bindReliabilityTips(bins) { var pts = bins.filter(function (b) { return b.n; }); Array.prototype.forEach.call($view.querySelectorAll('[data-relhit]'), function (el) { var b = pts[+el.getAttribute('data-relhit')]; tipOn(el, 'Band ' + esc(b.band) + '<br>forecast ' + pct(b.mean_forecast) + ' · observed ' + pct(b.observed) + '<br>' + b.n + ' games'); }); }

  /* ---------------------------------------------------------------- data and method */
  function viewData() {
    get('audit.json').then(function (a) {
      var p = a.possessions; var lo = a.lineups.opening_five_vs_espn_starters; var sh = a.shots; var pe = a.possession_estimator; var idn = a.identity;
      var h = '<h1>Data and diagnostics</h1><p class="lede">What the pack\'s tables can and cannot be trusted for. Null QA flags are unknown, never passes; source values are kept and contradictions are flagged, not overwritten.</p>';
      h += '<h2>Findings that changed how the data is used</h2><div class="card"><ul>' +
        '<li><b>Publisher lineup table quarantined.</b> Its opening five matches ESPN\'s starters in ' + pct(lo.publisher_lineup_table.all_five_share) + ' of team-games (mean ' + f(lo.publisher_lineup_table.mean_overlap, 2) + ' of 5); the possession table\'s matches in ' + pct(lo.possession_table.all_five_share) + '. Lineups are built from the possession table. Its player_count_error flag is null on all ' + a.lineups.publisher_lineup_table.rows + ' rows.</li>' +
        '<li><b>Possession points vs official finals:</b> exact in ' + p.reconciliation.exact + ' of ' + (p.reconciliation.games - p.reconciliation.no_box) + ' games with an official box; ' + p.reconciliation.within_3 + ' within 3 points (' + p.reconciliation.swapped_two + ' are a 2-point basket credited to the wrong team); ' + p.reconciliation.larger + ' larger. Player models drop the larger ones and are refitted on exact games only as a sensitivity.</li>' +
        '<li><b>Shot archive:</b> ' + sh.counts.missed_with_positive_score_value + ' missed shots carry a positive score_value, and ' + sh.counts.free_throw_type_on_miss + ' missed free throws are typed "MadeFreeThrow". scoring_play is the only made/missed gate; with it, made field goals match the box in ' + pct(sh.team_box_agreement.fgm_rate) + ' of team-games.</li>' +
        '<li><b>Possession estimate:</b> FTA coefficient fitted at ' + pe.c_fitted + ' (2024-25); on 2026 its error against parsed possession counts is ' + pe.compare[String(pe.c_fitted)].vs_publisher_2026.rmse + ' vs ' + pe.compare['0.44'].vs_publisher_2026.rmse + ' for the generic 0.44.</li>' +
        '<li><b>Player identity:</b> ' + idn.player_crosswalk_2026.linked + ' of ' + idn.player_crosswalk_2026.ncaa_players + ' NCAA ids linked to ESPN athletes by box-score fingerprints (name agreement among them ' + pct(idn.player_crosswalk_2026.linked_name_agreement) + ', the rest nicknames); ' + idn.player_crosswalk_2026.quarantined + ' quarantined. Exact-name links for earlier-season publisher persons agreed with fingerprints ' + idn.name_based_person_links_2026.verified_against_fingerprints.agree + ' times and disagreed ' + idn.name_based_person_links_2026.verified_against_fingerprints.disagree + '.</li>' +
        '<li><b>Full-season RAPM is never a same-season predictor.</b> The publisher\'s 2025 RAPM is used only as a prior for 2026 players, linked through publisher ids.</li>' +
        '<li><b>Division membership:</b> D1 per season from the explicit-ID bridge plus ' + a.membership.overrides + ' reviewed overrides; anything else is unknown membership and a separate regime.</li></ul></div>';
      h += '<h2>Games and boxes</h2>' + table(['Season', '>Final', '>Postponed', '>Canceled', '>NCAA detail rows joined', '>Discrepant (quarantined)'], [2024, 2025, 2026].map(function (s) { var g = a.games.stats[s]; var b = a.boxes.by_season[s]; return { cells: [s, g.final, g.postponed, g.canceled, b.joined, b.discrepant] }; }), { note: 'Overtime from native period counts (2 halves of 20 minutes, 5-minute overtimes): ' + Object.keys(a.games.overtime_by_season).map(function (k) { return k + ' OT: ' + a.games.overtime_by_season[k]; }).join(', ') });
      h += '<h2>Provenance</h2>' + table(['Table', '>Rows', 'SHA-256', 'Source release'], a.provenance.map(function (r) { return { cells: [r.table, r.rows, { html: '<span class="mono">' + esc(r.sha256.slice(0, 12)) + '…</span>' }, { html: r.source.url ? '<a href="' + esc(r.source.url) + '" rel="noopener">' + esc(r.source.release_tag) + '</a> <span class="mut">updated ' + esc(String(r.source.published_updated_at).slice(0, 10)) + '</span>' : esc(r.source.derived_by), wrap: true }] }; }), { note: 'observed_at: the date this repository imported the pack. known_at is blank throughout: first publication of each game is not in the data, so every backtest assumes a result is known 4 hours after tip.' });
      h += '<h2>Missing data that would improve this most</h2><div class="card"><ul>' +
        '<li><b>Confirmed availability and starting fives</b> (effective-dated, with publish times): turns scenarios from conditional to forecastable and allows a real pregame test.</li>' +
        '<li><b>Rosters, eligibility and transfer dates for 2026-27</b> (athlete ids, effective dates): without them the openers are a carry-forward.</li>' +
        '<li><b>Recruiting rankings and class year</b>: the freshman prior, which public systems rely on.</li>' +
        '<li><b>More seasons of possession data</b> (2024 and 2025): multi-season player priors and a player-layer test across seasons.</li>' +
        '<li><b>Timestamped executable odds with book rules</b>, and a closing-price archive: the only way to test the model against the market.</li>' +
        '<li><b>Raw play-by-play with substitutions and parser QA flags</b>: to verify lineups and possessions directly.</li>' +
        '<li><b>Tracking</b> (shot quality, defender distance, coverages): nothing about them is claimed now.</li></ul></div>';
      $view.innerHTML = h;
    }).catch(fail);
  }
  function viewMethod() {
    get('methodology.json').then(function (m) {
      $view.innerHTML = '<h1>Method: what is public, what EdgeDesk chose, what is unknown</h1><p class="lede">This engine implements defensible public approaches in its own way and validates them; it does not reproduce KenPom, Torvik or EvanMiya, whose exact formulas are private. Most of their pages could not be fetched from the build environment, so those claims rest on search excerpts of the authors\' own pages and are tagged as such in <span class="mono">' + esc(m.sources) + '</span>.</p>' +
        m.topics.map(function (t) { return '<div class="card"><h2 style="margin-top:0">' + esc(t.topic) + '</h2><dl class="kv"><dt>Public</dt><dd>' + esc(t.public) + '</dd><dt>EdgeDesk</dt><dd>' + esc(t.choice) + '</dd><dt>Unknown</dt><dd>' + esc(t.unknown) + '</dd></dl></div>'; }).join('');
    }).catch(fail);
  }

  /* ---------------------------------------------------------------- router */
  function fail(e) { $view.innerHTML = '<div class="banner warn"><b>Could not load research data.</b> ' + esc(e && e.message) + '</div>'; }
  function route() {
    var hash = location.hash.replace(/^#/, '') || '/'; var parts = hash.split('?'); var seg = parts[0].split('/').filter(Boolean);
    var params = {}; (parts[1] || '').split('&').forEach(function (kv) { var p = kv.split('='); if (p[0]) params[p[0]] = decodeURIComponent(p[1] || ''); });
    var r = seg[0] || 'teams';
    Array.prototype.forEach.call(document.querySelectorAll('#nav a'), function (a) { a.classList.toggle('on', a.getAttribute('data-r') === (r === 'team' || r === 'player' ? 'teams' : r === 'report' ? 'reports' : r)); });
    $view.innerHTML = '<div class="empty">Loading…</div>'; window.scrollTo(0, 0);
    get('index.json').then(function (idx) {
      freshness(idx);
      if (r === 'team') return viewTeam(seg[1]);
      if (r === 'player') return viewPlayer(seg[1], seg[2]);
      if (r === 'matchup') return viewMatchup(params);
      if (r === 'reports') return viewReports(idx);
      if (r === 'report') return viewReport(seg[1]);
      if (r === 'upcoming') return viewUpcoming();
      if (r === 'validation') return viewValidation();
      if (r === 'data') return viewData();
      if (r === 'method') return viewMethod();
      return viewTeams(idx);
    }).catch(fail);
  }
  window.addEventListener('hashchange', route); route();
})();
