/* ===========================================================================
   EDGEDESK SIMULATOR — college baseball's Road to Omaha (registered with
   EDSimUI.registerSport).

   College baseball publishes one competition, "road-to-omaha": the season
   from where it stands (its preseason before a game is played) to the
   national champion, through a committee proxy (every number Estimated).
   Three tabs, all from the published run (supabase/simulator.sql sim_*):
     Road to Omaha  every Division I team's chance to make the field, host a
                    regional, be a national seed, win a regional, reach
                    Omaha, the final and the title (with the Monte Carlo ±
                    and fair decimal and American odds for the title)
     Conferences    each conference's expected bids, hosts and Omaha teams,
                    and one conference's teams with their automatic-bid
                    chance (a picker)
     Model Health   the tournament backtest (every NCAA tournament the
                    warehouse holds whole, from its first pitch), the single
                    tournament games against a coin, the season backtest
                    from the preseason and four in-season checkpoints, and
                    what the model does not know

   The season's state rides in the run's validation_summary.sport_summary
   (simulator/src/sports/college_baseball/run.ts readerSummary); each team's
   record (conference, rating) in sim_entity_summary. Every value reaches
   the page through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('college_baseball', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, cell = U.cell, isNum = U.isNum;
  var LEVELS = [['make_field', 'Field'], ['host_regional', 'Host'], ['national_seed', 'Top 8'], ['win_regional', 'Regional'], ['reach_omaha', 'Omaha'], ['reach_final', 'Final'], ['win_title', 'Title']];
  var SHOW = 40;
  var CP_LABEL = { preseason: 'Preseason', d70: '10 weeks out', d42: '6 weeks out', d21: '3 weeks out', d7: '1 week out' };

  /* ------------------------------------------------------------ helpers */
  function pct(x, d) { return isNum(x) ? (x * 100).toFixed(d == null ? 1 : d) + '%' : '—'; }
  function american(p) { return U.fairAmerican(p); }
  function decimal(p) { return U.fairOdds(p); }
  function odds(p) { return isNum(p) && p > 0 && p < 1 ? decimal(p) + ' · ' + american(p) : '—'; }
  function f3(v) { return isNum(v) ? v.toFixed(3) : '—'; }
  function f4(v) { return isNum(v) ? v.toFixed(4) : '—'; }
  function ci(x, f) { f = f || f3; return x && x.ci95 ? esc(f(x.mean)) + ' (' + esc(f(x.ci95[0])) + ' to ' + esc(f(x.ci95[1])) + ')' : '—'; }
  function summary(x) { return (x && x.run && x.run.validation_summary && x.run.validation_summary.sport_summary) || null; }
  function byEntity(x) { var by = {}; ((x && x.results) || []).forEach(function (r) { (by[r.entity_id] = by[r.entity_id] || {})[r.outcome] = r; }); return by; }
  function prob(o, k) { return o && o[k] && isNum(o[k].probability) ? o[k].probability : 0; }
  function day(iso) { var t = Date.parse(iso || ''); if (!isFinite(t)) return '—'; try { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); } catch (_) { return String(iso).slice(0, 10); } }
  function confName(c) { return /^none_/.test(c || '') ? 'No conference' : c; }
  function phaseText(S) {
    if (S.phase === 'preseason') return S.season + ' preseason: no ' + S.season + ' game played yet. Ratings as of ' + day(S.as_of) + ' (the served model’s priors: last season’s strength, regressed toward each conference).';
    return S.season + ' season through ' + day(S.last_game) + ': the served model’s ratings after every game so far, ' + S.days_to_regionals + ' days before the regionals.';
  }

  /* ------------------------------------------------------------ Road to Omaha */
  function renderRoad(x, c) {
    var S = summary(x);
    if (!S || S.kind !== 'cbase_road') return '<div class="sm-card sm-empty">This run carries no season summary.</div>';
    var O = byEntity(x);
    var teams = (S.teams || []).slice().sort(function (a, b) { return prob(O[b.id], 'win_title') - prob(O[a.id], 'win_title') || prob(O[b.id], 'make_field') - prob(O[a.id], 'make_field') || a.rank - b.rank; });
    var all = !!(c && c.showAll), shown = all ? teams : teams.slice(0, SHOW);
    var head = '<div class="sm-card"><div class="sm-h">The Road to Omaha ' + esc(S.season) + ' <span class="sm-dim sm-small">' + esc(S.teams.length) + ' Division I teams · ' + esc((S.conferences || []).filter(function (k) { return k.aq; }).length) + ' automatic bids · regionals ' + esc(day(S.regionals_start)) + '</span></div>'
      + '<p class="sm-small">' + badge('Estimated') + ' ' + esc(phaseText(S)) + ' Each simulated season moves every rating as past seasons moved by Selection Monday, picks the field and the 16 hosts with a committee proxy fitted on 2014-2026 fields, then plays the NCAA tournament (double-elimination regionals, best-of-three super regionals, the College World Series) game by game with the served model.</p></div>';
    var table = '<div class="sm-card"><div class="sm-h">Who gets to Omaha ' + badge('Estimated') + '</div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Team</th><th title="The served model’s rating rank among Division I teams">Rank</th>' + LEVELS.map(function (l) { return '<th>' + esc(l[1]) + '</th>'; }).join('') + '<th title="Fair odds for the title: decimal · American, no margin">Title odds</th></tr></thead><tbody>'
      + shown.map(function (t) {
        var o = O[t.id] || {};
        return '<tr><td><b>' + esc(t.name) + '</b> <span class="sm-dim sm-small">' + esc(confName(t.conf)) + '</span></td><td class="sm-num">' + esc(t.rank) + '</td>' + LEVELS.map(function (l) { return cell(o[l[0]]); }).join('') + '<td class="sm-num">' + esc(o.win_title ? odds(o.win_title.probability) : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + (teams.length > SHOW ? '<button type="button" class="sm-sport" data-sim-act="all" data-sim-val="' + (all ? '0' : '1') + '">' + (all ? 'Show the first ' + SHOW : 'Show all ' + esc(teams.length) + ' teams') + '</button>' : '')
      + '<div class="sm-foot">Field: make the 64-team tournament. Host: one of the 16 regional hosts. Top 8: a national seed (hosts a super regional if it gets there). Regional: win a regional. Omaha: win a super regional. Fair odds: decimal · American, no margin. Every chance passes through the committee proxy.</div></div>';
    return head + table;
  }

  /* ------------------------------------------------------------ Conferences */
  function confStats(S, O) {
    var by = {};
    (S.teams || []).forEach(function (t) {
      var k = by[t.conf] = by[t.conf] || { name: t.conf, teams: [], bids: 0, hosts: 0, omaha: 0, title: 0 };
      var o = O[t.id] || {};
      k.teams.push(t); k.bids += prob(o, 'make_field'); k.hosts += prob(o, 'host_regional'); k.omaha += prob(o, 'reach_omaha'); k.title += prob(o, 'win_title');
    });
    (S.conferences || []).forEach(function (c) { if (by[c.name]) by[c.name].aq = c.aq; });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.bids - a.bids || (a.name < b.name ? -1 : 1); });
  }
  function renderConferences(x, c) {
    var S = summary(x);
    if (!S || S.kind !== 'cbase_road') return '<div class="sm-card sm-empty">This run carries no season summary.</div>';
    var O = byEntity(x), cs = confStats(S, O);
    var sel = (c && c.conf && cs.some(function (k) { return k.name === c.conf; })) ? c.conf : (cs[0] && cs[0].name);
    var list = '<div class="sm-card"><div class="sm-h">Conferences ' + badge('Estimated') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Conference</th><th>Teams</th><th title="Expected teams in the 64-team field">Bids</th><th title="Expected regional hosts">Hosts</th><th title="Expected teams in Omaha">Omaha</th><th>Title</th></tr></thead><tbody>'
      + cs.map(function (k) {
        return '<tr><td><button type="button" class="sm-link" data-sim-act="conf" data-sim-val="' + esc(k.name) + '"' + (k.name === sel ? ' aria-current="true"' : '') + '>' + esc(confName(k.name)) + '</button>' + (k.aq ? '' : ' <span class="sm-dim sm-small">(no automatic bid)</span>') + '</td><td class="sm-num">' + esc(k.teams.length) + '</td><td class="sm-num">' + esc(k.bids.toFixed(1)) + '</td><td class="sm-num">' + esc(k.hosts.toFixed(1)) + '</td><td class="sm-num">' + esc(k.omaha.toFixed(2)) + '</td><td class="sm-num">' + esc(pct(k.title)) + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="sm-foot">Expected counts: the average number of the conference’s teams across the simulated seasons. A conference with an automatic bid always sends at least one team.</div></div>';
    var k = cs.filter(function (z) { return z.name === sel; })[0];
    var detail = k ? '<div class="sm-card"><div class="sm-h">' + esc(confName(k.name)) + ' ' + badge('Estimated') + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Team</th><th>Rank</th>' + (k.aq ? '<th title="Win the conference’s automatic bid (its tournament, or its regular season where there is none)">Auto bid</th>' : '') + '<th>Field</th><th>Host</th><th>Omaha</th><th>Title</th></tr></thead><tbody>'
      + k.teams.slice().sort(function (a, b) { return prob(O[b.id], 'make_field') - prob(O[a.id], 'make_field') || a.rank - b.rank; }).map(function (t) {
        var o = O[t.id] || {};
        return '<tr><td><b>' + esc(t.name) + '</b></td><td class="sm-num">' + esc(t.rank) + '</td>' + (k.aq ? cell(o.auto_bid) : '') + cell(o.make_field) + cell(o.host_regional) + cell(o.reach_omaha) + cell(o.win_title) + '</tr>';
      }).join('') + '</tbody></table></div><div class="sm-foot">The automatic bid goes to one team per conference, drawn by strength (measured on the one-bid conferences, whose only team in the field is certainly the winner).</div></div>' : '';
    return list + detail;
  }

  /* ------------------------------------------------------------ Model Health */
  function renderHealth(x) {
    var S = summary(x);
    if (!S || !S.model_health) return '<div class="sm-card sm-empty">This run carries no model record.</div>';
    var H = S.model_health, T = H.tournament, R = H.road;
    var rg = T.regional, om = T.omaha, ch = T.champion;
    var t = '<div class="sm-card"><div class="sm-h">Does the model call NCAA tournaments? ' + badge('Observed') + '</div>'
      + '<p class="sm-small">Every NCAA tournament the warehouse holds whole (' + esc(T.seasons.join(', ')) + '; ' + esc((T.refused || []).map(function (r) { return r.season + ': ' + r.reason; }).join('; ')) + '), simulated ' + esc(U.int(T.sims)) + ' times from the morning of its first regional game with the served model as it stood then. The model’s settings were chosen on 2014-2022 games; 2023-2026 were not used to choose them.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>What</th><th title="Lower is better">Model</th><th>Every team equal</th><th title="The host, its first opponent and the other two, at their past rates">Seed lines</th><th>Model − equal (95% interval)</th><th>Model − seed lines (95% interval)</th></tr></thead><tbody>'
      + '<tr><td>Regional winner (log loss, ' + esc(rg.pods) + ' regionals)</td><td class="sm-num"><b>' + esc(f3(rg.model)) + '</b></td><td class="sm-num">' + esc(f3(rg.uniform)) + '</td><td class="sm-num">' + esc(f3(rg.seed_lines)) + '</td><td class="sm-num">' + ci(rg.diff_vs_uniform) + '</td><td class="sm-num">' + ci(rg.diff_vs_seed_lines) + '</td></tr>'
      + '<tr><td>Reaching Omaha (Brier, every team)</td><td class="sm-num"><b>' + esc(f4(om.brier.model)) + '</b></td><td class="sm-num">' + esc(f4(om.brier.uniform)) + '</td><td class="sm-num">' + esc(f4(om.brier.seed_lines)) + '</td><td class="sm-num">' + ci(om.log_loss_diff_vs_uniform, f4) + ' <span class="sm-dim">log loss</span></td><td class="sm-num">' + ci(om.log_loss_diff_vs_seed_lines, f4) + '</td></tr>'
      + '<tr><td>The champion (log loss, ' + esc(T.seasons.length) + ' tournaments)</td><td class="sm-num"><b>' + esc(f3(ch.log_loss.model)) + '</b></td><td class="sm-num">' + esc(f3(ch.log_loss.uniform)) + '</td><td class="sm-num">' + esc(f3(ch.log_loss.seed_lines)) + '</td><td class="sm-num">' + ci(ch.diff_vs_uniform) + '</td><td class="sm-num">' + ci(ch.diff_vs_seed_lines) + '</td></tr>'
      + '<tr><td>The champion once Omaha opens (among 8)</td><td class="sm-num"><b>' + esc(f3(ch.omaha_open.model)) + '</b></td><td class="sm-num">' + esc(f3(ch.omaha_open.uniform)) + '</td><td class="sm-num">—</td><td class="sm-num">' + ci(ch.omaha_open.diff_vs_uniform) + '</td><td class="sm-num">—</td></tr>'
      + '</tbody></table></div>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Season</th><th>Champion</th><th title="Its chance before the first regional game">Its chance</th><th title="Its place among the 64 by that chance">Rank</th><th>The model’s favourite</th></tr></thead><tbody>'
      + (T.per_season || []).map(function (s) { return '<tr><td>' + esc(s.season) + (s.window !== 'SELECTION' ? ' <span class="sm-dim sm-small">' + esc(s.window === 'HOLDOUT' ? 'holdout' : 'validation') + '</span>' : '') + '</td><td>' + esc(s.champion.name) + '</td><td class="sm-num">' + esc(pct(s.champion.p)) + '</td><td class="sm-num">' + esc(s.champion.rank) + '</td><td>' + esc(s.favourite ? s.favourite.name + ' ' + pct(s.favourite.p) : '—') + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + '<div class="sm-foot">In plain words: it picks regional winners and Omaha teams clearly better than the seeds alone. The title is a long way off: a favourite at 15% still loses it about six times in seven, eleven tournaments cannot prove the title call beats chance, and in Omaha the eight are close enough that the model is no better than a coin. The super-regional host, before it is known, is taken from the seeds and ratings: that rule named the actual host in ' + esc(T.super_host_proxy.agree) + ' of ' + esc(T.super_host_proxy.n) + ' past super regionals.</div></div>';
    var G = T.games;
    var g = '<div class="sm-card"><div class="sm-h">The single tournament games ' + badge('Observed') + '</div>'
      + '<p class="sm-small">' + esc(U.int(G.n)) + ' tournament games, each priced the morning of its date (the model had every earlier game): log loss ' + esc(f3(G.log_loss)) + ' against a coin’s 0.693, difference ' + ci(G.vs_coin) + '. Regionals ' + esc(f3(G.by_round.regional.log_loss)) + ', super regionals ' + esc(f3(G.by_round.super.log_loss)) + ', Omaha ' + esc(f3(G.by_round.omaha.log_loss)) + '.</p>'
      + '<div class="sm-small">' + (G.favourites || []).filter(function (b) { return b.n; }).map(function (b) { return 'favourite at ' + esc(b.bin.replace('-', '–')) + ': said ' + esc(pct(b.mean_chance)) + ', won ' + esc(pct(b.favourite_won)) + ' (' + esc(U.int(b.n)) + ')'; }).join(' · ') + '</div></div>';
    var cps = (R.checkpoints || []).map(function (k) { return k.checkpoint; });
    var lv = function (cp, l) { return R.summary[cp] && R.summary[cp].levels[l]; };
    var r = '<div class="sm-card"><div class="sm-h">Does the Road to Omaha call a season before it is played? ' + badge('Observed') + '</div>'
      + '<p class="sm-small">Walk-forward over ' + esc(R.targets.join(', ')) + ': each season simulated from its preseason ratings and from four points in the season, every setting measured on earlier seasons only. Log loss per Division I team (lower is better) against the base rate and against last season (how far teams went the year before).</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>From</th><th>Make the field</th><th>Base rate</th><th>Last season</th><th>Model − last season (95% interval)</th><th>Reach Omaha</th><th>Last season</th><th>Model − last season (95% interval)</th></tr></thead><tbody>'
      + cps.map(function (cp) { var f = lv(cp, 'field'), o = lv(cp, 'omaha'); if (!f || !o) return ''; return '<tr><td>' + esc(CP_LABEL[cp] || cp) + '</td><td class="sm-num"><b>' + esc(f3(f.model)) + '</b></td><td class="sm-num">' + esc(f3(f.base_rate)) + '</td><td class="sm-num">' + esc(f3(f.last_season)) + '</td><td class="sm-num">' + ci(f.diff_vs_last_season) + '</td><td class="sm-num"><b>' + esc(f4(o.model)) + '</b></td><td class="sm-num">' + esc(f4(o.last_season)) + '</td><td class="sm-num">' + ci(o.diff_vs_last_season, f4) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + (R.summary.preseason ? '<div class="sm-small"><b>From the preseason, the field chance</b>: ' + R.summary.preseason.field_calibration.filter(function (b) { return b.n; }).map(function (b) { return esc(b.bin.replace('-', '–')) + ': said ' + esc(pct(b.mean_chance)) + ', made it ' + esc(pct(b.made_field)) + ' (' + esc(U.int(b.n)) + ')'; }).join(' · ') + '</div>' : '')
      + '<div class="sm-foot">In plain words: from the preseason it knows more than last season’s results about who makes the field, hosts and reaches Omaha, and it sharpens as the season is played; it runs a little hot near the bubble. The title from the preseason beats the base rate but not clearly last season.</div></div>';
    var unknown = '<div class="sm-card"><div class="sm-h">What the model does not know</div><ul class="sm-list">' + (S.not_modelled || []).map(function (s) { return '<li>' + esc(s.charAt(0).toUpperCase() + s.slice(1)) + '.</li>'; }).join('') + '</ul></div>';
    return t + g + r + unknown;
  }

  /* ------------------------------------------------------------ the adapter */
  var adapter = {
    defaultTab: 'tournament',
    tabLabels: { tournament: 'Road to Omaha', conference: 'Conferences', model_health: 'Model Health' },
    load: async function (get, c) {
      var x = await U.loadPublished(get, 'college_baseball', U.seasonOf('college_baseball'));
      c.status = x.status; c.entitled = x.entitled;
      if (x.run) { c.run = x.run; c.results = x.results; c.entities = x.entities; c.edges = x.edges; }
    },
    onAction: function (act, val, c) {
      if (act === 'all') { c.showAll = val === '1'; return 'paint'; }
      if (act === 'conf' && typeof val === 'string' && val) { c.conf = val; return 'paint'; }
      return null;
    },
    paint: function (ctx) {
      var c = ctx.cache || {}, s = ctx.sport, now = ctx.nowMs || Date.now();
      var gate = U.gateHtml(s, c, now); if (gate) return gate;
      var st = U.deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: now });
      var v = ctx.tab === 'conference' ? renderConferences(c, c) : ctx.tab === 'model_health' ? renderHealth(c) : renderRoad(c, c);
      return U.renderMeta(s, c.run, st, now).replace('simulated seasons', 'simulated seasons to Omaha') + v;
    }
  };
  return { adapter: adapter, renderRoad: renderRoad, renderConferences: renderConferences, renderHealth: renderHealth, american: american, decimal: decimal };
});
