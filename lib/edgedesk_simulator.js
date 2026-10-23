/* ===========================================================================
   EDGEDESK SIMULATOR — the reader (the Simulator seat of the terminal).

   Shows the published Monte Carlo season simulation of each ACTIVE sport:
   division, conference, title and Kalshi futures comparisons, every number
   labelled with its provenance (Observed / Research / Estimated), every
   probability with its Monte Carlo sampling error, the run's inputs and time,
   and the sport's known limitations. A sport that is not ACTIVE shows its
   status and the exact blockers — never a number.

   DATA. Everything is read with the reader's own token through
   supabase/simulator.sql: sim_public_status() (anyone; no probability),
   sim_viewer_entitled(), and the sim_current_* views, which row-level
   security answers only for a subscriber. Results are kept in memory for
   this session only (never localStorage). A failed refresh keeps the last
   good results on screen, marked stale.

   THE NUMBERS. probability = count / N. The "±" beside a probability is the
   half-width of its 95% Monte Carlo interval (1.96 x MCSE, MCSE =
   sqrt(p(1-p)/N)): simulation sampling error ONLY, never model accuracy. A
   zero count is shown as "0 in N" with its Wilson upper bound, never as
   impossible; a dash means not applicable, which is not zero.

   SPORTS. Each sport has its own outcome set: the NFL (seeds 1-7, the Super
   Bowl, W-L-T and projected wins), the NHL (division top three and two wild
   cards, round advancement, the Stanley Cup, W-L-OTL, points and projected
   points), college football (conference title games and the CFP: its own
   views below) and college basketball (its adapter, lib/edgedesk_simulator_ncaam.js).
   The NHL's regular-season honours (Presidents' Trophy, best
   record in the conference) are shown apart from its playoff titles.

   Browser: window.EDSimUI (needs window.EDSimSports, lib/edgedesk_simulator_sports.js).
   Node:    require('./edgedesk_simulator.js') — the pure functions, for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDSimUI = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var STALE_HOURS = 36;
  var LEGEND = '± = half-width of the 95% Monte Carlo interval (1.96 × sampling SE). It measures simulation noise only, not model accuracy or total uncertainty.';

  /* ------------------------------------------------------------ pure helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]; });
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function int(n) { return isNum(n) ? Math.round(n).toLocaleString('en-US') : '—'; }
  /* one probability, as text and tooltip; o = {applicable, outcome_count, n_sims, probability, mcse, wilson_lo, wilson_hi} */
  function fmtProb(o) {
    if (!o || o.applicable === false || !isNum(o.probability)) return { text: '—', title: 'not applicable', cls: 'na' };
    var p = o.probability, n = o.n_sims, k = o.outcome_count;
    var iv = isNum(o.wilson_lo) && isNum(o.wilson_hi) ? ' · 95% Wilson interval ' + pct(o.wilson_lo, 3) + '–' + pct(o.wilson_hi, 3) : '';
    var base = int(k) + ' of ' + int(n) + ' simulated seasons' + iv;
    if (k === 0) return { text: '0 in ' + int(n), title: base + ' (zero runs is not impossible: the true rate is below the upper bound)', cls: 'zero' };
    if (k === n) return { text: 'all ' + int(n), title: base + ' (every run, not a certainty)', cls: 'all' };
    if (p * 100 < 0.05) return { text: '<0.1%', title: base, cls: 'tiny' };
    if (p * 100 > 99.95) return { text: '>99.9%', title: base, cls: 'huge' };
    return { text: (p * 100).toFixed(1) + '%', title: base, cls: '' };
  }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  /* the ± in points: 1.96 x MCSE, one decimal (two under 0.1) */
  function fmtPm(o) {
    if (!o || o.applicable === false || !isNum(o.mcse) || !(o.outcome_count > 0) || o.outcome_count === o.n_sims) return '';
    var h = 1.96 * o.mcse * 100;
    return '±' + (h < 0.1 ? h.toFixed(2) : h.toFixed(1));
  }
  /* model fair decimal odds = 1/p: undefined at p = 0, 1.00 at p = 1 */
  function fairOdds(p) {
    if (!isNum(p) || p <= 0) return '—';
    var d = 1 / p;
    return d >= 1000 ? Math.round(d).toLocaleString('en-US') : d.toFixed(2);
  }
  /* numeric sort with missing values LAST in either direction */
  function sortRows(rows, key, dir) {
    var s = dir === 'asc' ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var x = a[key], y = b[key], xm = x == null || (typeof x === 'number' && !isFinite(x)), ym = y == null || (typeof y === 'number' && !isFinite(y));
      if (xm && ym) return 0; if (xm) return 1; if (ym) return -1;
      if (typeof x === 'number' && typeof y === 'number') return s * (x - y);
      return s * String(x).localeCompare(String(y));
    });
  }
  function ago(iso, nowMs) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    var m = Math.max(0, Math.round(((nowMs || Date.now()) - t) / 60000));
    if (m < 60) return m + ' min ago'; if (m < 48 * 60) return Math.round(m / 60) + ' h ago'; return Math.round(m / 1440) + ' days ago';
  }
  function when(iso) {
    var t = Date.parse(iso || ''); if (!isFinite(t)) return '—';
    try { return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch (_) { return new Date(t).toISOString(); }
  }

  /* what the page should say, from what the database answered */
  function deriveState(x) {
    /* x = {sport (registry entry), status (sim_public_status row or null), entitled, run, loadError, nowMs} */
    if (!x.sport) return { kind: 'error', text: 'Unknown sport.' };
    if (x.sport.status !== 'ACTIVE') return { kind: x.sport.status === 'BLOCKED' ? 'blocked' : 'coming_soon' };
    if (x.loadError && !x.run) return { kind: 'error', text: x.loadError };
    if (!x.status || !x.status.published_run_id) return { kind: 'no_data', lastAttempt: x.status ? x.status.last_attempt_status : null };
    if (!x.entitled) return { kind: 'unauthorized' };
    if (!x.run) return { kind: x.loadError ? 'error' : 'no_data', text: x.loadError || '' };
    var st = { kind: 'ok', stale: false, notes: [] };
    var inAge = (x.nowMs - Date.parse(x.run.input_snapshot_at)) / 3600000;
    if (isFinite(inAge) && inAge > STALE_HOURS) { st.stale = true; st.notes.push('Inputs are ' + Math.round(inAge) + ' hours old (captured ' + when(x.run.input_snapshot_at) + ').'); }
    var la = x.status.last_attempt_at ? Date.parse(x.status.last_attempt_at) : NaN, pa = Date.parse(x.status.published_at || '');
    if (x.status.last_attempt_status === 'failed' && isFinite(la) && (!isFinite(pa) || la > pa)) { st.stale = true; st.notes.push('The latest refresh failed (' + when(x.status.last_attempt_at) + '); showing the last successful run.'); }
    if (x.loadError) { st.stale = true; st.notes.push('Refresh failed just now (' + x.loadError + '); showing the results loaded earlier.'); }
    return st;
  }
  function marketState(status, run, edges) {
    if (!run || !run.comparison_id) {
      if (status && status.comparison_status === 'failed') return { kind: 'failed', text: 'The latest Kalshi refresh failed (' + when(status.comparison_at) + '). No quote is shown as current.' };
      return { kind: 'unavailable', text: 'No Kalshi futures comparison for this run: no market is mapped to a simulated outcome yet, or the mapping is unverified. Unavailable is not zero.' };
    }
    if (!edges || !edges.length) return { kind: 'unavailable', text: 'The comparison holds no market.' };
    return { kind: 'ok' };
  }

  /* the published rows -> one model the views render */
  function buildModel(run, results, entities, edges) {
    var by = {};
    (entities || []).forEach(function (e) { by[e.entity_id] = { id: e.entity_id, name: e.entity_name, groups: e.entity_groups || {}, record: e.record || null, mean_wins: e.mean_wins, math: e.math_status || {}, outcomes: {}, edges: [] }; });
    (results || []).forEach(function (r) {
      var c = by[r.entity_id] || (by[r.entity_id] = { id: r.entity_id, name: r.entity_name, groups: r.entity_groups || {}, record: null, mean_wins: null, math: {}, outcomes: {}, edges: [] });
      c.outcomes[r.outcome] = r;
    });
    (edges || []).forEach(function (e) { if (by[e.entity_id]) by[e.entity_id].edges.push(e); });
    var clubs = Object.keys(by).map(function (k) { return by[k]; });
    var group = function (g) { var o = {}; clubs.forEach(function (c) { var k = c.groups[g] || '—'; (o[k] = o[k] || []).push(c); }); return o; };
    return { sport: (run && run.sport) || 'nfl', run: run, clubs: clubs, divisions: group('division'), conferences: group('conference'), edges: edges || [] };
  }
  /* what differs between the sports' views */
  var VIEW = {
    nfl: { title: 'win_super_bowl', titleName: 'Super Bowl', recHead: 'W-L-T', projHead: 'Proj. wins', projTitle: 'Research: mean simulated regular-season wins' },
    nhl: { title: 'win_stanley_cup', titleName: 'Stanley Cup', recHead: 'W-L-OTL', projHead: 'Proj. pts', projTitle: 'Research: mean simulated regular-season points' }
  };
  function viewOf(M) { return VIEW[M && M.sport] || VIEW.nfl; }
  /* the projection column: NFL mean wins; NHL mean points (published inside the entity record) */
  function proj(M, c) { var v = M.sport === 'nhl' ? c.record && c.record.mean_points : c.mean_wins; return isNum(v) ? v.toFixed(1) : '—'; }
  function p(c, k) { var o = c.outcomes[k]; return o && o.applicable !== false && isNum(o.probability) ? o.probability : null; }
  function rec(c) { var r = c.record; return r ? r.w + '-' + r.l + (isNum(r.otl) ? '-' + r.otl : r.t ? '-' + r.t : '') : '—'; }

  /* ------------------------------------------------------------ rendering (strings, escaped) */
  function badge(kind) { return '<span class="sm-badge sm-' + esc(kind.toLowerCase()) + '" title="' + esc(PROV[kind]) + '">' + esc(kind) + '</span>'; }
  var PROV = { Observed: 'Observed: recorded results and timestamped market quotes', Research: 'Research: simulated by EdgeDesk’s experimental model', Estimated: 'Estimated: an input derived from the format or a supporting model, not observed' };
  function cell(o) { var f = fmtProb(o), pm = fmtPm(o); return '<td class="sm-num ' + esc(f.cls) + '" title="' + esc(f.title) + '">' + esc(f.text) + (pm ? '<span class="sm-pm">' + esc(pm) + '</span>' : '') + '</td>'; }
  function mathTag(c, k) { var s = c.math && c.math[k]; return s === 'clinched' ? ' <span class="sm-tag sm-clinch">clinched</span>' : s === 'eliminated' ? ' <span class="sm-tag sm-elim">eliminated</span>' : ''; }

  function renderDivision(M) {
    var V = viewOf(M), nhl = M.sport === 'nhl';
    return Object.keys(M.divisions).sort().map(function (d) {
      var rows = sortRows(M.divisions[d].map(function (c) { return { c: c, v: p(c, 'win_division') }; }), 'v', 'desc');
      return '<div class="sm-card"><div class="sm-h">' + esc(d) + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Club</th><th title="Observed">' + esc(V.recHead) + '</th>' + (nhl ? '<th title="Observed: 2 a win, 1 an overtime or shootout loss">Pts</th>' : '') + '<th title="' + esc(V.projTitle) + '">' + esc(V.projHead) + '</th><th>Win division</th><th>Make playoffs</th></tr></thead><tbody>'
        + rows.map(function (r) { var c = r.c; return '<tr><td><b>' + esc(c.id) + '</b> <span class="sm-dim">' + esc(c.name) + '</span>' + mathTag(c, 'division') + '</td><td class="sm-num">' + esc(rec(c)) + '</td>' + (nhl ? '<td class="sm-num">' + esc(c.record && isNum(c.record.pts) ? c.record.pts : '—') + '</td>' : '') + '<td class="sm-num">' + esc(proj(M, c)) + '</td>' + cell(c.outcomes.win_division) + cell(c.outcomes.make_playoffs) + '</tr>'; }).join('')
        + '</tbody></table></div></div>';
    }).join('');
  }
  /* NHL: the bracket positions (D1-D3 per division, WC1-WC2 per conference), then the playoff rounds */
  var NHL_POS = [['win_division', 'D1'], ['bracket_d2', 'D2'], ['bracket_d3', 'D3'], ['bracket_wc1', 'WC1'], ['bracket_wc2', 'WC2']];
  var NHL_ROUNDS = [['reach_round_2', 'Round 2'], ['reach_conference_final', 'Conf. final']];
  function renderConferenceNhl(M) {
    return Object.keys(M.conferences).sort().map(function (cf) {
      var rows = sortRows(M.conferences[cf].map(function (c) { return { c: c, v: p(c, 'make_playoffs') }; }), 'v', 'desc');
      return '<div class="sm-card"><div class="sm-h">' + esc(cf) + ' Conference</div><div class="sm-scroll"><table class="sm-tbl sm-seeds"><thead><tr><th>Club</th><th>Playoffs</th>'
        + NHL_POS.map(function (x) { return '<th>' + esc(x[1]) + '</th>'; }).join('') + NHL_ROUNDS.map(function (x) { return '<th>' + esc(x[1]) + '</th>'; }).join('') + '<th title="Playoffs: reach the Stanley Cup Final">Win ' + esc(cf) + '</th></tr></thead><tbody>'
        + rows.map(function (r) { var c = r.c; return '<tr><td><b>' + esc(c.id) + '</b>' + mathTag(c, 'playoffs') + '</td>' + cell(c.outcomes.make_playoffs) + NHL_POS.map(function (x) { return cell(c.outcomes[x[0]]); }).join('') + NHL_ROUNDS.map(function (x) { return cell(c.outcomes[x[0]]); }).join('') + cell(c.outcomes.win_conference) + '</tr>'; }).join('')
        + '</tbody></table></div><div class="sm-foot">D1–D3 each sum to 100% within a division and WC1, WC2 within the conference; a club’s D1–WC2 sum to its playoff probability. The division winner with the better record meets WC2, the other meets WC1; D2 meets D3. “Win ' + esc(cf) + '” is the playoff conference title.</div></div>';
    }).join('');
  }
  function renderConference(M) {
    if (M.sport === 'nhl') return renderConferenceNhl(M);
    return Object.keys(M.conferences).sort().map(function (cf) {
      var rows = sortRows(M.conferences[cf].map(function (c) { return { c: c, v: p(c, 'make_playoffs') }; }), 'v', 'desc');
      return '<div class="sm-card"><div class="sm-h">' + esc(cf) + ' seeds</div><div class="sm-scroll"><table class="sm-tbl sm-seeds"><thead><tr><th>Club</th><th>Playoffs</th>'
        + [1, 2, 3, 4, 5, 6, 7].map(function (k) { return '<th>' + k + (k === 1 ? ' (bye)' : '') + '</th>'; }).join('') + '<th>Win ' + esc(cf) + '</th></tr></thead><tbody>'
        + rows.map(function (r) { var c = r.c; return '<tr><td><b>' + esc(c.id) + '</b>' + mathTag(c, 'playoffs') + '</td>' + cell(c.outcomes.make_playoffs) + [1, 2, 3, 4, 5, 6, 7].map(function (k) { return cell(c.outcomes['seed_' + k]); }).join('') + cell(c.outcomes.win_conference) + '</tr>'; }).join('')
        + '</tbody></table></div><div class="sm-foot">Each seed column sums to 100% across the conference; a club’s seeds sum to its playoff probability.</div></div>';
    }).join('');
  }
  function edgeOf(c, key) { var e = c.edges.filter(function (x) { return x.outcome === key; })[0]; return e || null; }
  function renderTitle(M, ms) {
    var V = viewOf(M), T = V.title;
    var rows = sortRows(M.clubs.map(function (c) { return { c: c, v: p(c, T) }; }), 'v', 'desc');
    return '<div class="sm-cards">' + rows.map(function (r) {
      var c = r.c, o = c.outcomes[T], f = fmtProb(o), e = edgeOf(c, T);
      var mk = ms.kind !== 'ok' ? '<div class="sm-mk sm-dim">Market: unavailable</div>'
        : !e ? '<div class="sm-mk sm-dim">Market: not mapped</div>'
        : '<div class="sm-mk">' + badge('Observed') + ' Kalshi ' + (isNum(e.reference_prob) ? esc(pct(e.reference_prob)) + ' <span class="sm-dim">(YES mid)</span>' : '<span class="sm-dim">no reference (' + esc((e.block_reasons || []).filter(function (b) { return /reference/.test(b); })[0] || 'n/a') + ')</span>')
          + '<br><span class="sm-dim">quote ' + esc(ago(e.quote_at)) + (e.stale ? ' · <b class="sm-stale">stale</b>' : '') + '</span>'
          + '<br>Reference edge ' + (isNum(e.reference_edge_pp) ? esc(e.reference_edge_pp.toFixed(1)) + ' pts' : '—') + ' · Executable edge ' + (isNum(e.exec_edge_pp) ? esc(e.exec_edge_pp.toFixed(1)) + ' pts' + (e.fee_verified ? '' : ' <span class="sm-dim">(pre-fee)</span>') : '—') + '</div>';
      return '<div class="sm-club"><div class="sm-club-h"><b>' + esc(c.id) + '</b> <span class="sm-dim">' + esc(c.name) + '</span></div>'
        + '<div class="sm-big" title="' + esc(f.title) + '">' + esc(f.text) + ' <span class="sm-pm">' + esc(fmtPm(o)) + '</span></div>'
        + '<div class="sm-dim">' + badge('Research') + ' win ' + esc(V.titleName) + ' · fair odds ' + esc(fairOdds(p(c, T))) + '</div>'
        + '<div class="sm-dim">Conference ' + esc(fmtProb(c.outcomes.win_conference).text) + ' · Playoffs ' + esc(fmtProb(c.outcomes.make_playoffs).text) + '</div>'
        + (M.sport === 'nhl' ? '<div class="sm-dim" title="Regular-season honours, separate from the playoff titles">Regular season: Presidents’ Trophy ' + esc(fmtProb(c.outcomes.presidents_trophy).text) + ' · best ' + esc(c.groups.conference || 'conference') + ' record ' + esc(fmtProb(c.outcomes.conference_best_record).text) + '</div>' : '') + mk + '</div>';
    }).join('') + '</div>';
  }
  /* ---- college football: conference title games (conference tab) and the CFP (title tab) ---- */
  var NO_CONF = 'FBS Independents';
  function wl(c) { var r = c.record; return r ? r.w + '-' + r.l : '—'; }
  function ccgTag(c) {
    var s = c.math && c.math.ccg;
    return s === 'clinched' ? ' <span class="sm-tag sm-clinch">clinched title game</span>' : s === 'eliminated' ? ' <span class="sm-tag sm-elim">eliminated</span>' : s === 'ineligible' ? ' <span class="sm-tag sm-elim">ineligible</span>' : '';
  }
  function cfbRun(run) { return (run && run.validation_summary && run.validation_summary.cfb) || {}; }
  /* the provenance the rows of an outcome carry (one per outcome: the module sets it) */
  function provOf(clubs, k) { for (var i = 0; i < clubs.length; i++) { var o = clubs[i].outcomes[k]; if (o && o.provenance) return o.provenance; } return null; }
  function cfbConfNote(run, cf) {
    var x = (cfbRun(run).conferences || []).filter(function (c) { return c.conference === cf; })[0];
    if (!x) return '';
    var est = x.runs_decided_by_estimated_ranking, draw = x.runs_decided_by_draw, out = [];
    if (isNum(est) && est > 0) out.push(badge('Estimated') + ' ' + esc(pct(est, est < 0.001 ? 3 : 1)) + ' of simulated seasons had a title-game berth decided by a tiebreaker step that names an outside ranking (SportSource, CFP or computer rankings), resolved with the simulation’s own team strength' + (x.leans_on_estimated_ranking ? '; this conference’s numbers lean on that estimate' : '') + '.');
    if (isNum(draw) && draw > 0) out.push(esc(pct(draw, 3)) + ' reached the league’s random draw.');
    return out.length ? '<div class="sm-foot">' + out.join(' ') + '</div>' : '';
  }
  function renderCfbConference(M) {
    var hasCfp = !!provOf(M.clubs, 'cfp_field');
    return Object.keys(M.conferences).filter(function (cf) { return cf !== NO_CONF; }).sort().map(function (cf) {
      var rows = sortRows(M.conferences[cf].map(function (c) { return { c: c, v: p(c, 'conf_champion'), w: p(c, 'ccg_appearance') }; }), 'v', 'desc');
      return '<div class="sm-card"><div class="sm-h">' + esc(cf) + '</div><div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Team</th><th title="Observed: completed games">W-L</th><th title="Research: mean simulated regular-season wins">Proj. wins</th>'
        + '<th title="Research: reaches the conference championship game">Title game</th><th title="Research: the title game’s No. 1 seed (its host where the higher seed hosts)">No. 1 seed</th><th>Win ' + esc(cf) + '</th>'
        + (hasCfp ? '<th title="' + esc(provOf(M.clubs, 'cfp_field')) + ': selected for the College Football Playoff">Make CFP</th>' : '') + '</tr></thead><tbody>'
        + rows.map(function (r) {
          var c = r.c, dv = c.groups && c.groups.division && c.groups.division !== '-' ? ' <span class="sm-dim">' + esc(c.groups.division) + '</span>' : '';
          return '<tr><td><b>' + esc(c.name) + '</b>' + dv + ccgTag(c) + '</td><td class="sm-num">' + esc(wl(c)) + '</td><td class="sm-num">' + (isNum(c.mean_wins) ? esc(c.mean_wins.toFixed(1)) : '—') + '</td>'
            + cell(c.outcomes.ccg_appearance) + cell(c.outcomes.ccg_seed_1) + cell(c.outcomes.conf_champion) + (hasCfp ? cell(c.outcomes.cfp_field) : '') + '</tr>';
        }).join('')
        + '</tbody></table></div>' + cfbConfNote(M.run, cf) + '</div>';
    }).join('');
  }
  var CFB_ROUNDS = [['cfp_field', 'Make CFP'], ['cfp_bye', 'Bye (seeds 1-4)'], ['cfp_host_first_round', 'Host R1 (5-8)'], ['reach_qf', 'Quarterfinal'], ['reach_sf', 'Semifinal'], ['reach_final', 'Final'], ['national_champion', 'Champion']];
  function renderCfbPlayoff(M) {
    var info = cfbRun(M.run), sel = provOf(M.clubs, 'cfp_field'), play = provOf(M.clubs, 'national_champion');
    if (!sel) return '<div class="sm-card sm-empty">No CFP or national-title probability is published for this run' + (info.cfp_mode_reason ? ': ' + esc(info.cfp_mode_reason) : '') + '. The conference tab holds the title-game forecasts.</div>';
    var rows = sortRows(M.clubs.filter(function (c) { var o = c.outcomes.cfp_field; return o && o.outcome_count > 0; }).map(function (c) { return { c: c, v: p(c, 'national_champion'), f: p(c, 'cfp_field') }; }), 'f', 'desc');
    rows = sortRows(rows, 'v', 'desc');
    var how = sel === 'Estimated'
      ? 'Selection and seeding come from an <b>Estimated</b> committee proxy: a model of the committee’s final rankings 2014-2025, validated season by season on later years. It is not the committee. Each simulated season redraws the proxy’s parameters and the committee’s own variation, so a team’s simulated record never fixes its ranking by itself. Game results are simulated by EdgeDesk’s model.'
      : sel === 'Observed' ? 'The field and seeds are the announced bracket (<b>Observed</b>); completed playoff games are kept as played, and the rest are simulated.'
      : 'Selection follows the stated rules.';
    return '<div class="sm-card"><div class="sm-h">College Football Playoff ' + badge(sel) + (play && play !== sel ? ' games ' + badge(play) : '') + '</div><p class="sm-dim sm-small">' + how + '</p>'
      + '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>Team</th><th title="Observed: completed games">W-L</th>' + CFB_ROUNDS.map(function (x) { return '<th>' + esc(x[1]) + '</th>'; }).join('') + '<th>Fair odds</th></tr></thead><tbody>'
      + rows.map(function (r) {
        var c = r.c;
        return '<tr><td><b>' + esc(c.name) + '</b> <span class="sm-dim">' + esc(c.groups && c.groups.conference || '') + '</span></td><td class="sm-num">' + esc(wl(c)) + '</td>'
          + CFB_ROUNDS.map(function (x) { return cell(c.outcomes[x[0]]); }).join('') + '<td class="sm-num">' + esc(fairOdds(p(c, 'national_champion'))) + '</td></tr>';
      }).join('')
      + '</tbody></table></div><div class="sm-foot">Teams selected in at least one simulated season, by national-title probability. Each round column sums to its number of places (12, 4, 4, 8, 4, 2, 1). The ± is simulation noise only: it does not include the committee’s or the model’s uncertainty.</div></div>';
  }
  var EDGE_COLS = [
    { k: 'entity_id', t: 'Club' }, { k: 'outcome', t: 'Outcome' }, { k: 'research_prob', t: 'Research p', num: true }, { k: 'research_fair_decimal', t: 'Fair odds', num: true },
    { k: 'reference_prob', t: 'Kalshi ref (mid)', num: true }, { k: 'normalized_ref_prob', t: 'Normalised ref', num: true }, { k: 'reference_edge_pp', t: 'Ref edge (pts)', num: true },
    { k: 'exec_price', t: 'Buy-YES ask', num: true }, { k: 'exec_cost_prob', t: 'Exec cost', num: true }, { k: 'exec_edge_pp', t: 'Exec edge (pts)', num: true },
    { k: 'quote_age_minutes', t: 'Quote age (min)', num: true }, { k: 'status_text', t: 'Status' }];
  var OUTCOME_LABEL = { make_playoffs: 'Make playoffs', win_division: 'Win division', reach_divisional: 'Reach divisional round', reach_conference_final: 'Reach conference final',
    win_conference: 'Win conference', win_super_bowl: 'Win Super Bowl', seed_1: 'Seed 1', seed_2: 'Seed 2', seed_3: 'Seed 3', seed_4: 'Seed 4', seed_5: 'Seed 5', seed_6: 'Seed 6', seed_7: 'Seed 7',
    win_stanley_cup: 'Win Stanley Cup', presidents_trophy: 'Presidents’ Trophy', conference_best_record: 'Best conference record', reach_round_2: 'Reach round 2',
    bracket_d2: 'Division 2nd', bracket_d3: 'Division 3rd', bracket_wc1: 'First wild card', bracket_wc2: 'Second wild card' };
  function edgeRows(M) {
    return M.edges.map(function (e) {
      return { entity_id: e.entity_id, outcome: OUTCOME_LABEL[e.outcome] || e.outcome, research_prob: e.research_prob, research_mcse: e.research_mcse, research_fair_decimal: e.research_fair_decimal, reference_prob: e.reference_prob,
        normalized_ref_prob: e.normalized_ref_prob, reference_edge_pp: e.reference_edge_pp, exec_price: e.exec_price, exec_cost_prob: e.exec_cost_prob, exec_edge_pp: e.exec_edge_pp,
        quote_age_minutes: e.quote_age_minutes, fee_verified: e.fee_verified, stale: e.stale, actionable: e.actionable, block_reasons: e.block_reasons || [], normalization_note: e.normalization_note,
        status_text: e.actionable ? 'FLAGGED (research)' : (e.stale ? 'stale' : 'not flagged') };
    });
  }
  function renderFutures(M, ms, sort) {
    if (ms.kind !== 'ok') return '<div class="sm-card sm-empty">' + esc(ms.text) + '</div>';
    var rows = sortRows(edgeRows(M), sort.key, sort.dir);
    var fmt = function (k, v) {
      if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
      if (/prob$|price$/.test(k)) return pct(v);
      if (k === 'research_fair_decimal') return v.toFixed(2);
      if (/_pp$/.test(k)) return (v > 0 ? '+' : '') + v.toFixed(1);
      if (k === 'quote_age_minutes') return Math.round(v);
      return v;
    };
    return '<div class="sm-card"><div class="sm-h">Kalshi futures ' + badge('Observed') + ' vs simulation ' + badge('Research') + '</div>'
      + '<p class="sm-dim sm-small">Reference = the YES mid of a two-sided quote (never an executable price). Executable = buying YES at the ask for the stated quantity' + (rows.some(function (r) { return !r.fee_verified; }) ? ', <b>before fees</b> (fee schedule unverified: nothing is flagged)' : ', after verified fees') + '. Edges are shown as components; there is no combined score.</p>'
      + '<div class="sm-scroll"><table class="sm-tbl sm-sortable"><thead><tr>' + EDGE_COLS.map(function (c) {
        var on = sort.key === c.k; return '<th><button type="button" class="sm-sort' + (on ? ' on' : '') + '" data-sim-sort="' + esc(c.k) + '" aria-sort="' + (on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">' + esc(c.t) + (on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '') + '</button></th>';
      }).join('') + '</tr></thead><tbody>'
      + rows.map(function (r) { return '<tr' + (r.actionable ? ' class="sm-flag"' : '') + ' title="' + esc((r.block_reasons || []).join(' · ') || r.normalization_note || '') + '">' + EDGE_COLS.map(function (c) { return '<td class="' + (c.num ? 'sm-num' : '') + '">' + esc(fmt(c.k, r[c.k])) + (c.k === 'research_prob' && isNum(r.research_mcse) ? '<span class="sm-pm">±' + esc((196 * r.research_mcse).toFixed(1)) + '</span>' : '') + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div><div class="sm-foot">Missing values sort last in either direction. A flag is research, never a recommendation or an order.</div></div>';
  }
  function renderBlocked(s) {
    return '<div class="sm-card sm-blocked"><div class="sm-h">' + esc(s.label) + ' — ' + (s.status === 'BLOCKED' ? 'Blocked' : 'Coming Soon') + '</div>'
      + '<p class="sm-dim">No simulated number is shown for this sport. ' + (s.status === 'BLOCKED' ? 'It can be built, and is waiting on:' : 'Why:') + '</p><ul class="sm-list">'
      + (s.blockers || []).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>'
      + (s.activation_path ? '<p class="sm-dim sm-small"><b>Path to activation:</b> ' + esc(s.activation_path) + '</p>' : '')
      + ((s.limitations || []).length ? '<details class="sm-lim"><summary>Known limitations once active</summary><ul class="sm-list">' + s.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>' : '') + '</div>';
  }
  function renderMeta(s, run, st, nowMs) {
    if (!run) return '';
    var d = run.validation_summary && run.validation_summary.flags || {};
    return '<div class="sm-meta"><span class="sm-badge sm-exp" title="A T3 research model: never a recommendation">EXPERIMENTAL</span> '
      + '<span>' + esc(int(run.n_sims)) + ' simulated seasons</span> · <span title="' + esc(run.input_snapshot_at) + '">inputs ' + esc(when(run.input_snapshot_at)) + '</span> · <span>published ' + esc(ago(run.published_at || run.completed_at, nowMs)) + '</span>'
      + ' · <span class="sm-dim">model ' + esc(run.model_version) + ' · rules ' + esc(run.rules_version) + ' · seed ' + esc(run.seed) + '</span>'
      + (st.stale ? '<div class="sm-stalebar">' + st.notes.map(esc).join(' ') + '</div>' : '')
      + (s.key === 'cfb' && run.validation_summary && run.validation_summary.cfb ? '<div class="sm-dim sm-small">' + (run.validation_summary.cfb.cfp_mode === 'proxy' ? badge('Estimated') + ' CFP selection and seeding: committee proxy' : run.validation_summary.cfb.cfp_mode === 'observed' ? badge('Observed') + ' CFP field: the announced bracket' : 'No CFP probabilities in this run') + '</div>' : '')
      + (s && s.key === 'nhl'
        ? ((d.tiebreak_goals || d.tiebreak_coin) ? '<div class="sm-dim sm-small">' + esc(int(d.tiebreak_goals || 0)) + ' run' + ((d.tiebreak_goals || 0) === 1 ? '' : 's') + ' reached goal differential or goals for (simulated games’ scores drawn from the model); ' + esc(int(d.tiebreak_coin || 0)) + ' needed the seeded coin toss beyond goals for.</div>' : '')
        : ((d.tiebreak_estimated_points || d.tiebreak_unsupported_input) ? '<div class="sm-dim sm-small">' + badge('Estimated') + ' ' + esc(int(d.tiebreak_estimated_points || 0)) + ' run' + ((d.tiebreak_estimated_points || 0) === 1 ? '' : 's') + ' used Estimated scores for a points-ranking tiebreak; ' + esc(int(d.tiebreak_unsupported_input || 0)) + ' reached a step with no model input (resolved by the seeded coin toss).</div>' : ''))
      + '<div class="sm-dim sm-small">' + esc(LEGEND) + '</div></div>';
  }
  function renderLimits(s) {
    var est = (root && root.EDSimSports && root.EDSimSports.nfl && root.EDSimSports.nfl.estimated_inputs) || [];
    return '<details class="sm-lim"><summary>Known limitations · ' + esc(s.label) + '</summary><ul class="sm-list">' + (s.limitations || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>'
      + (est.length && s.key === 'nfl' ? '<p class="sm-small">' + badge('Estimated') + ' inputs: ' + est.map(esc).join('; ') + '.</p>' : '') + '</details>';
  }

  /* ------------------------------------------------------------ sport adapters
     A sport with its own data and views (college basketball: Games, Upset
     Watch, Tournament, Model Health, read from supabase/ncaam_forecast.sql
     as well as the sim_* tables) registers an adapter:
       { defaultTab, tabLabels, load(get, cache, ctx) (async), paint(ctx) -> html }
     It renders every tab itself, including its blocked and not-entitled
     states, because its game forecasts can be published while its tournament
     simulation is still blocked. Every other sport keeps the views below. */
  var ADAPTERS = {};
  function registerSport(key, a) { if (!key || !a || typeof a.paint !== 'function' || typeof a.load !== 'function') throw new Error('registerSport: an adapter needs load and paint'); ADAPTERS[key] = a; }
  /* the adapter's own default, else the title view where a sport has one, else its first */
  function defaultTab(s) { var a = s && ADAPTERS[s.key]; if (a && a.defaultTab) return a.defaultTab; var t = tabsFor(s); return t.indexOf('title') >= 0 ? 'title' : t[0] || null; }

  /* ------------------------------------------------------------ the page */
  var S = { sport: null, tab: null, sort: { key: 'exec_edge_pp', dir: 'desc' }, cache: {}, host: null, busy: false };
  function sports() { return (root && root.EDSimSports && root.EDSimSports.sports) || []; }
  function sportEntry(k) { return sports().filter(function (s) { return s.key === k; })[0] || null; }
  function tabsFor(s) { return (s && s.tabs) || []; }
  var TAB_LABEL = { division: 'Division', conference: 'Conference', title: 'Title', futures: 'Futures Edges', tournament: 'Tournament', games: 'Games', upset_watch: 'Upset Watch', model_health: 'Model Health' };
  function tabLabel(s, t) { return s && s.key === 'cfb' && t === 'title' ? 'CFP & Title' : TAB_LABEL[t] || t; }

  function shell() {
    var s = sportEntry(S.sport);
    var picker = '<nav class="sm-sports" aria-label="Sport">' + sports().map(function (x) {
      return '<button type="button" class="sm-sport' + (x.key === S.sport ? ' on' : '') + (x.status !== 'ACTIVE' ? ' off' : '') + '" data-sim-sport="' + esc(x.key) + '"' + (x.key === S.sport ? ' aria-current="page"' : '') + '>' + esc(x.label)
        + (x.status !== 'ACTIVE' ? '<span class="sm-soon">' + (x.status === 'BLOCKED' ? 'Blocked' : 'Coming Soon') + '</span>' : '') + '</button>';
    }).join('') + '</nav>';
    var tabs = s && (s.status === 'ACTIVE' || ADAPTERS[s.key]) ? '<nav class="stseg sm-tabs" aria-label="View">' + tabsFor(s).map(function (t) { return '<button type="button" data-sim-tab="' + esc(t) + '" class="' + (t === S.tab ? 'on' : '') + '"' + (t === S.tab ? ' aria-current="page"' : '') + '>' + esc(tabLabel(s, t)) + '</button>'; }).join('') + '</nav>' : '';
    return '<div class="row-between"><h2 style="margin:0">Simulator</h2><span class="spacer"></span><button class="refreshbtn" type="button" title="Refresh" aria-label="Refresh the simulator" data-sim-refresh="1">&#8635;</button></div>'
      + '<p class="lede">Correlated Monte Carlo seasons from EdgeDesk’s own game models: division, conference and title probabilities, beside Kalshi futures where a market is mapped exactly. Research, never a recommendation.</p>'
      + picker + tabs + '<div id="simBody" aria-live="polite"></div>';
  }
  /* PostgREST answers at most the project's max-rows (1,000 by default) per request: read until a short page
     (college football publishes about 3,200 result rows) */
  var PAGE = 1000;
  async function getAll(get, q) {
    var out = [];
    for (var off = 0; off <= 100000; off += PAGE) { var b = (await get(q + '&limit=' + PAGE + '&offset=' + off)) || []; out = out.concat(b); if (b.length < PAGE) break; }
    return out;
  }
  function body(html) { var b = S.host && S.host.querySelector('#simBody'); if (b) b.innerHTML = html; }
  function paint() {
    var s = sportEntry(S.sport);
    if (!s) { body('<div class="empty">Unknown sport.</div>'); return; }
    var c = S.cache[S.sport] || {};
    if (ADAPTERS[s.key]) { body(ADAPTERS[s.key].paint({ sport: s, cache: c, tab: S.tab, nowMs: Date.now() }) + renderLimits(s)); return; }
    var st = deriveState({ sport: s, status: c.status, entitled: c.entitled, run: c.run, loadError: c.error, nowMs: Date.now() });
    if (st.kind === 'blocked' || st.kind === 'coming_soon') { body(renderBlocked(s)); return; }
    if (c.loading && !c.run) { body('<div class="empty">Loading the latest published simulation…</div>'); return; }
    if (st.kind === 'error') { body('<div class="sm-card sm-err">The simulator could not be read: ' + esc(st.text) + '</div>' + renderLimits(s)); return; }
    if (st.kind === 'no_data') { body('<div class="sm-card sm-empty">No simulation has been published for ' + esc(s.label) + ' yet' + (st.lastAttempt === 'failed' ? ' (the latest attempt failed and published nothing)' : '') + '.</div>' + renderLimits(s)); return; }
    if (st.kind === 'unauthorized') { body('<div class="sm-card sm-lock"><div class="sm-h">Full Access</div><p>The Simulator’s probabilities are part of Full Access. A simulation is published (' + esc(when(c.status && c.status.published_at)) + ').</p><p><a href="/#pricing">See plans</a> · or sign in from More → Account.</p></div>' + renderLimits(s)); return; }
    var M = buildModel(c.run, c.results, c.entities, c.edges);
    var ms = marketState(c.status, c.run, c.edges);
    var v = S.tab === 'futures' ? renderFutures(M, ms, S.sort)
      : s.key === 'cfb' ? (S.tab === 'conference' ? renderCfbConference(M) : renderCfbPlayoff(M))
      : S.tab === 'division' ? renderDivision(M) : S.tab === 'conference' ? renderConference(M) : renderTitle(M, ms);
    body(renderMeta(s, c.run, st, Date.now()) + v + renderLimits(s));
  }
  async function load(force) {
    var s = sportEntry(S.sport);
    if (s && ADAPTERS[s.key]) return loadAdapter(s, force);
    if (!s || s.status !== 'ACTIVE') { paint(); return; }
    var c = S.cache[S.sport] || (S.cache[S.sport] = {});
    if (S.busy) return; if (c.run && !force) { paint(); return; }
    var get = root.sbGet; if (typeof get !== 'function') { c.error = 'the database client is not loaded'; paint(); return; }
    S.busy = true; c.loading = true; paint();
    try {
      var season = (root.EDSimSports && root.EDSimSports[S.sport] && root.EDSimSports[S.sport].season) || '';
      var stat = await get('rpc/sim_public_status');
      c.status = (stat || []).filter(function (x) { return x.sport === S.sport && (!season || x.season === season); })[0] || null;
      c.entitled = await get('rpc/sim_viewer_entitled');
      if (c.status && c.status.published_run_id && c.entitled === true) {
        var runs = await get('sim_current_runs?sport=eq.' + encodeURIComponent(S.sport) + (season ? '&season=eq.' + encodeURIComponent(season) : '') + '&select=run_id,sport,season,n_sims,seed,model_version,rules_version,engine_version,input_snapshot_at,completed_at,published_at,comparison_id,limitations,validation_summary');
        var run = (runs || [])[0] || null;
        if (run) {
          var id = encodeURIComponent(run.run_id);
          var res = await getAll(get, 'sim_current_results?run_id=eq.' + id + '&select=entity_id,entity_name,entity_groups,outcome,category,applicable,outcome_count,n_sims,probability,mcse,wilson_lo,wilson_hi,fair_decimal,provenance&order=entity_id,outcome');
          var ents = await getAll(get, 'sim_current_entities?run_id=eq.' + id + '&select=entity_id,entity_name,entity_groups,record,mean_wins,math_status&order=entity_id');
          var edges = run.comparison_id ? await get('sim_current_edges?run_id=eq.' + id + '&select=*') : [];
          c.run = run; c.results = res; c.entities = ents; c.edges = edges || [];
        }
      }
      c.error = null;
    } catch (e) {
      c.error = String(e && (e.message || e)).slice(0, 160);   /* the last good results stay; deriveState marks them stale */
    } finally { c.loading = false; S.busy = false; paint(); }
  }
  async function loadAdapter(s, force) {
    var c = S.cache[s.key] || (S.cache[s.key] = {});
    if (c.loading || (c.loaded && !force)) { paint(); return; }
    var get = root.sbGet; if (typeof get !== 'function') { c.error = 'the database client is not loaded'; paint(); return; }
    c.loading = true; paint();
    try { await ADAPTERS[s.key].load(get, c, { sport: s }); c.error = null; c.loaded = true; }
    catch (e) { c.error = String(e && (e.message || e)).slice(0, 160); }   /* the last good data stay; the adapter marks them stale */
    finally { c.loading = false; paint(); }
  }
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-sim-sport],[data-sim-tab],[data-sim-sort],[data-sim-refresh]') : null;
    if (!t) return;
    if (t.hasAttribute('data-sim-sport')) { S.sport = t.getAttribute('data-sim-sport'); S.tab = defaultTab(sportEntry(S.sport)); render(); load(false); try { history.replaceState(null, '', location.pathname + location.search + '#simulator/' + S.sport); } catch (_) {} }
    else if (t.hasAttribute('data-sim-tab')) { S.tab = t.getAttribute('data-sim-tab'); render(); }
    else if (t.hasAttribute('data-sim-sort')) { var k = t.getAttribute('data-sim-sort'); S.sort = { key: k, dir: S.sort.key === k && S.sort.dir === 'desc' ? 'asc' : 'desc' }; paint(); }
    else if (t.hasAttribute('data-sim-refresh')) load(true);
  }
  function render() { if (!S.host) return; S.host.innerHTML = shell(); paint(); }
  function open(host, opts) {
    if (!host) return;
    opts = opts || {};
    if (S.host !== host) { S.host = host; host.addEventListener('click', onClick); }
    var want = opts.sport && sportEntry(opts.sport) ? opts.sport : (S.sport || ((sports().filter(function (s) { return s.status === 'ACTIVE'; })[0] || sports()[0] || {}).key));
    if (want !== S.sport) { S.sport = want; S.tab = defaultTab(sportEntry(want)); }
    render(); load(!!opts.force);
  }
  return {
    open: open, LEGEND: LEGEND, STALE_HOURS: STALE_HOURS,
    /* pure, for tests */
    esc: esc, fmtProb: fmtProb, fmtPm: fmtPm, fairOdds: fairOdds, sortRows: sortRows, deriveState: deriveState, marketState: marketState, buildModel: buildModel,
    renderDivision: renderDivision, renderConference: renderConference, renderTitle: renderTitle, renderFutures: renderFutures, renderBlocked: renderBlocked, renderMeta: renderMeta, edgeRows: edgeRows,
    renderCfbConference: renderCfbConference, renderCfbPlayoff: renderCfbPlayoff, defaultTab: defaultTab, getAll: getAll,
    /* shared with sport adapters */
    registerSport: registerSport, badge: badge, cell: cell, pct: pct, when: when, ago: ago, int: int, PROV: PROV,
    _state: S, _adapters: ADAPTERS
  };
});
