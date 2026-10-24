/* ===========================================================================
   EDGEDESK SIMULATOR — Women's College Basketball (NCAA Division I).

   Four tabs inside the Simulator seat, registered with EDSimUI.registerSport:
     Games         the published pregame forecasts: win probability (overtime
                   included), expected score, 80% margin and total intervals,
                   overtime chance, data-quality flags, availability assumption
     Upset Watch   three SEPARATE signals, never one score: high upset
                   probability, disagreement with a synchronized market
                   (unavailable: no women's college basketball price is
                   captured), high uncertainty; the underdog's basis (market,
                   seed or model) is always shown
     Tournament    exactly why no women's NCAA tournament simulation is shown:
                   none is built (the first two rounds are played on the top 16
                   seeds' campuses) and the 2027 field is not verified. This tab
                   never reads a sim_* table.
     Model Health  the champion model, every weekly challenger decision with
                   the gates that failed, live-forecast status (not built).
                   "Retrained" is never shown as "improved".

   The men's views are lib/edgedesk_simulator_ncaam.js; the two share no data
   (ncaaw_fc_* here, ncaam_fc_* there) and no champion.

   DATA (reader's own token; row-level security answers only a subscriber):
   rpc/ncaaw_fc_public_status (anyone: versions and times, never a number),
   rpc/sim_viewer_entitled, ncaaw_fc_current_forecasts, ncaaw_fc_model_health
   (supabase/ncaaw_forecast.sql). In memory only. Every value reaches the page
   through EDSimUI.esc.

   Browser: registers itself on window.EDSimUI. Node: require() for tests.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.EDSimUI && root.EDSimUI.registerSport) root.EDSimUI.registerSport('ncaaw', api.adapter);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var U = (root && root.EDSimUI) || (typeof require === 'function' ? require('./edgedesk_simulator.js') : null);
  var esc = U.esc, badge = U.badge, when = U.when, ago = U.ago;
  var STALE_HOURS = 36;
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function pct(x) { return isNum(x) ? (x * 100).toFixed(1) + '%' : '—'; }
  function sgn(x) { return isNum(x) ? (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(0) : '—'; }
  function meta() { return (root && root.EDSimSports && root.EDSimSports.ncaaw) || {}; }

  var DEFS = [
    ['Win probability', 'chance the team wins, overtime included; read from the same score distribution as the margin, so the two always agree'],
    ['80% interval', 'the middle 80% of the forecast distribution: one game in five is expected to land outside it'],
    ['Overtime chance', 'chance regulation ends tied; the model’s endgame factor is fitted on observed overtime games'],
    ['Research', 'model output: EdgeDesk’s experimental forecast, never a recommendation']
  ];

  /* ------------------------------------------------------------ state */
  function forecastState(c, nowMs) {
    var st = { stale: false, notes: [] };
    var s = c.fc_status;
    if (!s || !s.published_run_id) return { kind: 'no_data', note: s && s.champion_key && /^ncaaw_points@/.test(s.champion_key) ? 'The current champion is the incumbent points model, which is served on the slate; this view fills once a challenger passes the weekly gates.' : '' };
    if (c.entitled !== true) return { kind: 'unauthorized' };
    if (c.error && !c.forecasts) return { kind: 'error', text: c.error };
    var asOf = c.forecasts && c.forecasts[0] && c.forecasts[0].as_of || s.published_as_of;
    var age = (nowMs - Date.parse(asOf)) / 3600000;
    if (isFinite(age) && age > STALE_HOURS) { st.stale = true; st.notes.push('Forecast inputs are ' + Math.round(age) + ' hours old (' + when(asOf) + ').'); }
    var la = Date.parse(s.last_attempt_at || ''), pa = Date.parse(s.published_at || '');
    if (s.last_attempt_status === 'failed' && isFinite(la) && (!isFinite(pa) || la > pa)) { st.stale = true; st.notes.push('The latest refresh failed (' + when(s.last_attempt_at) + '); showing the last published forecasts.'); }
    if (c.error) { st.stale = true; st.notes.push('Refresh failed just now (' + c.error + '); showing what was loaded earlier.'); }
    st.kind = 'ok'; st.as_of = asOf; return st;
  }

  /* ------------------------------------------------------------ pieces */
  function lock(c) {
    var s = c.fc_status || {};
    return '<div class="sm-card sm-lock"><div class="sm-h">Full Access</div><p>Women\u2019s college basketball forecasts and Upset Watch are part of Full Access.'
      + (s.published_at ? ' Forecasts were published ' + esc(when(s.published_at)) + '.' : '') + '</p><p><a href="/#pricing">See plans</a> · or sign in from More → Account.</p></div>';
  }
  function header(c, st) {
    var s = c.fc_status || {};
    return '<div class="sm-meta"><span class="sm-badge sm-exp" title="An experimental research model: never a recommendation">EXPERIMENTAL</span> '
      + '<span>model ' + esc(s.champion_key || '—') + '</span> · <span>forecasts as of ' + esc(when(st.as_of)) + '</span> · <span>published ' + esc(ago(s.published_at)) + '</span>'
      + (st.stale ? '<div class="sm-stalebar">' + st.notes.map(esc).join(' ') + '</div>' : '') + '</div>';
  }
  function defs() {
    return '<details class="sm-lim"><summary>How to read these numbers</summary><ul class="sm-list">' + DEFS.map(function (d) { return '<li><b>' + esc(d[0]) + ':</b> ' + esc(d[1]) + '</li>'; }).join('')
      + '<li><b>Availability:</b> not modelled. No owned women\u2019s college-basketball injury or lineup feed exists, so an absence announced before tip is not in these numbers.</li></ul></details>';
  }
  function matchup(f) { return esc(f.away_name) + (f.neutral ? ' <span class="sm-dim">vs</span> ' : ' <span class="sm-dim">at</span> ') + esc(f.home_name) + (f.neutral ? ' <span class="sm-tag">neutral</span>' : ''); }
  function dq(f) { var q = f.data_quality || []; return q.length ? q.map(function (x) { return '<span class="sm-tag sm-dq" title="data-quality flag">' + esc(String(x).toLowerCase().replace(/_/g, ' ')) + '</span>'; }).join(' ') : ''; }

  /* one game as a card: every number of the row comes from the same distribution */
  function wpBar(pHome) { var h = Math.round(1000 * pHome) / 10; return '<div class="sm-wp" aria-hidden="true"><i class="sm-wp-a" style="width:' + esc((100 - h).toFixed(1)) + '%"></i><i class="sm-wp-h" style="width:' + esc(h.toFixed(1)) + '%"></i></div>'; }
  function gameCard(f) {
    var top = '<div class="sm-gc-top"><span class="sm-dim">' + esc(when(f.start_utc)) + '</span> ' + dq(f) + '</div>';
    if (!f.available) return '<div class="sm-club sm-gc">' + top + '<div class="sm-gc-m">' + matchup(f) + '</div><div class="sm-dim">No forecast: ' + esc(f.unavailable_reason || 'unavailable') + '</div></div>';
    var m = f.margin || {}, t = f.total || {};
    return '<div class="sm-club sm-gc">' + top + '<div class="sm-gc-m">' + matchup(f) + '</div>'
      + '<div class="sm-gc-p"><span><span class="sm-dim">' + esc(f.away_name) + '</span> <b>' + esc(pct(1 - f.p_home)) + '</b></span><span><b>' + esc(pct(f.p_home)) + '</b> <span class="sm-dim">' + esc(f.home_name) + '</span></span></div>' + wpBar(f.p_home)
      + '<dl class="sm-gc-d"><dt>Expected score</dt><dd>' + (isNum(f.pts_away) ? esc(f.pts_away.toFixed(0) + '–' + f.pts_home.toFixed(0)) : '—') + '</dd>'
      + '<dt title="80% interval of the home team\u2019s margin, overtime included">Home margin, 80%</dt><dd>' + esc(sgn(m.q10)) + ' to ' + esc(sgn(m.q90)) + '</dd>'
      + '<dt title="80% interval of total points">Total, 80%</dt><dd>' + (isNum(t.q10) ? esc(t.q10.toFixed(0) + '–' + t.q90.toFixed(0)) : '—') + '</dd>'
      + '<dt>Overtime</dt><dd>' + esc(pct(f.p_ot)) + '</dd></dl></div>';
  }
  function renderGames(c) {
    var F = (c.forecasts || []).slice().sort(function (a, b) { return String(a.start_utc).localeCompare(String(b.start_utc)); });
    if (!F.length) return '<div class="sm-card sm-empty">No game is scheduled in the published window.</div>';
    return '<div class="sm-h">Pregame forecasts ' + badge('Research') + ' <span class="sm-dim sm-small">' + esc(F.length) + ' games</span></div><div class="sm-cards sm-glist">' + F.map(gameCard).join('') + '</div>'
      + '<div class="sm-foot">Away team listed first. The margin is the home team\u2019s points minus the away team\u2019s. One distribution gives every number on a card.</div>';
  }

  var BASIS = { market: 'Market underdog (synchronized pregame quote)', seed: 'Lower seed (verified NCAA tournament seeds)', model: 'Model underdog (no market or seed basis)' };
  function upsetCard(f) {
    var dog = f.underdog === 'home' ? f.home_name : f.away_name, fav = f.underdog === 'home' ? f.away_name : f.home_name;
    var fac = f.factors ? '<details class="sm-fac"><summary>Matchup factors (descriptive)</summary><ul class="sm-list">' + Object.keys(f.factors).map(function (k) { return '<li>' + esc(k.replace(/_/g, ' ')) + ': ' + esc(isNum(f.factors[k]) ? f.factors[k].toFixed(3) : '—') + '</li>'; }).join('') + '</ul><p class="sm-small sm-dim">Hypotheses tested on the development seasons; none changes the probability.</p></details>' : '';
    return '<div class="sm-club sm-gc"><div class="sm-gc-top"><span class="sm-dim">' + esc(when(f.start_utc)) + '</span> ' + dq(f) + '</div><div class="sm-gc-m">' + matchup(f) + '</div>'
      + '<div class="sm-big">' + esc(pct(f.p_underdog)) + '</div><div><b>' + esc(dog) + '</b> wins <span class="sm-dim" title="' + esc(BASIS[f.basis] || '') + '">(' + esc(f.basis) + ' basis)</span></div>'
      + '<dl class="sm-gc-d"><dt>Favourite</dt><dd>' + esc(fav) + ' ' + esc(pct(1 - f.p_underdog)) + '</dd>'
      + '<dt>Market, same time</dt><dd>' + (isNum(f.p_market_underdog) ? esc(pct(f.p_market_underdog)) + ' (' + esc((f.disagreement > 0 ? '+' : '') + (100 * f.disagreement).toFixed(1)) + ' pts)' : '<span class="sm-dim">unavailable</span>') + '</dd>'
      + '<dt title="sd of the final-margin forecast, points">Margin sd</dt><dd>±' + esc(isNum(f.margin && f.margin.sd) ? f.margin.sd.toFixed(1) : '—') + '</dd></dl>' + fac + '</div>';
  }
  function renderUpset(c) {
    var F = (c.forecasts || []).filter(function (f) { return f.available && f.underdog; });
    var sig = function (k) { return F.filter(function (f) { return (f.signals || []).indexOf(k) >= 0; }).sort(function (a, b) { return b.p_underdog - a.p_underdog; }); };
    var pol = F[0] && F[0].upset_policy || {};
    var section = function (title, rows, note, collapse) {
      var body = rows.length ? '<div class="sm-cards sm-glist">' + rows.map(upsetCard).join('') + '</div>' : '<p class="sm-dim">None in the published window.</p>';
      return '<div class="sm-card"><div class="sm-h">' + esc(title) + ' ' + badge('Research') + ' <span class="sm-dim sm-small">' + esc(rows.length) + '</span></div>' + (note ? '<p class="sm-dim sm-small">' + esc(note) + '</p>' : '')
        + (collapse && rows.length ? '<details class="sm-lim"><summary>Show ' + esc(rows.length) + ' games</summary>' + body + '</details>' : body) + '</div>';
    };
    var theta = pol.theta;
    return '<p class="sm-dim sm-small">Three separate signals, never blended. The underdog is the market underdog when a synchronized pregame quote exists, the lower seed in an NCAA tournament game with verified seeds, otherwise the model underdog — the basis is shown on every card. No boost is added for March, momentum, reputation or being "due".</p>'
      + section('High upset probability', sig('upset_probability'), isNum(theta) ? 'The underdog wins at least ' + pct(theta) + ' of the time (and under 45%: closer is a toss-up). Threshold chosen on the 2018-2022 development games and frozen before later seasons were scored.' : 'Policy threshold not published.')
      + section('Large disagreement with the market', sig('market_disagreement'), 'Unavailable: no women\u2019s college basketball price is captured (the odds gateway does not carry it). Closing prices are not used as a same-time benchmark.')
      + section('High uncertainty', sig('high_uncertainty'), 'A wide margin forecast, or a team with fewer than five games this season. High uncertainty is not a prediction of an upset.', true)
      + section('Toss-ups and model-favoured underdogs', sig('toss_up').concat(sig('model_favours_underdog')), 'Toss-up: the underdog wins 45-50% of the time. Model-favoured: the market or seed underdog is the model\u2019s favourite (a disagreement, not an upset call).', true);
  }

  /* no women's tournament simulation is built: the tab states why, from the registry, and reads nothing */
  function renderTournament(c, s) {
    var m = meta();
    var off = '<ul class="sm-list"><li><b>Before Selection Sunday:</b> ' + esc((m.pre_selection && m.pre_selection.reason) || 'disabled') + '</li><li><b>Conference tournaments:</b> ' + esc((m.conference_tournaments && m.conference_tournaments.reason) || 'disabled') + '</li></ul>';
    return U.renderBlocked(Object.assign({}, s, { label: 'NCAA tournament simulation' })) + '<div class="sm-card"><div class="sm-h">What is switched off, and why</div>' + off
      + '<p class="sm-dim sm-small">The pregame game forecasts (Games, Upset Watch) are a separate product and are published whether or not a tournament simulation exists.</p></div>';
  }

  function renderHealth(c) {
    var s = c.fc_status || {}; var m = meta();
    var live = m.live || { enabled: false, blockers: [] };
    var pub = '<div class="sm-card"><div class="sm-h">Champion model</div><p><b>' + esc(s.champion_key || 'not yet published') + '</b>' + (s.champion_since ? ' since ' + esc(when(s.champion_since)) + ' (' + esc(String(s.champion_decision || '').toLowerCase()) + ')' : '') + '</p>'
      + '<p class="sm-small">Latest weekly decision: <b>' + esc(s.last_weekly_decision || 'none yet') + '</b>' + (s.last_weekly_at ? ' · ' + esc(when(s.last_weekly_at)) : '') + '</p>'
      + '<p class="sm-dim sm-small">Every week challengers are retrained and scored against the champion on the same games. A challenger replaces the champion only if every predefined gate passes (sample size, log loss with its interval below zero, Brier, margin accuracy, calibration, no regression in key groups, data integrity, run time). Finishing a training run is not an improvement: RETAIN and INSUFFICIENT EVIDENCE are normal outcomes.</p></div>'
      + '<div class="sm-card"><div class="sm-h">Live forecasts</div><p>' + (live.enabled ? 'Enabled.' : '<b>Disabled.</b>') + '</p>' + (live.blockers && live.blockers.length ? '<ul class="sm-list">' + live.blockers.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    if (c.entitled !== true) return pub;
    var h = c.health; var reps = (h && h.recent_reports) || [];
    var rows = reps.map(function (r) {
      var failed = (r.gates || []).filter(function (g) { return !g.pass; }).map(function (g) { return g.id + ': ' + g.detail; });
      var sm = r.summary || {}; var ch = sm.challenger || {};
      return '<tr><td class="sm-dim">' + esc(when(r.created_at)) + '</td><td>' + esc(r.candidate) + '<div class="sm-dim sm-small">' + esc(r.challenger) + '</div></td><td><b class="sm-dec sm-dec-' + esc(String(r.decision).toLowerCase()) + '">' + esc(r.decision) + '</b></td>'
        + '<td class="sm-num">' + esc(isNum(ch.log_loss) ? ch.log_loss.toFixed(4) : '—') + '</td><td class="sm-num">' + esc(isNum(ch.slope) ? ch.slope.toFixed(2) : '—') + '</td><td class="sm-num">' + esc(isNum(ch.margin_c80) ? pct(ch.margin_c80) : '—') + '</td>'
        + '<td class="sm-small">' + (failed.length ? failed.map(esc).join('<br>') : '<span class="sm-dim">every gate passed</span>') + '</td></tr>';
    }).join('');
    return pub + '<div class="sm-card"><div class="sm-h">Weekly challengers</div>' + (rows ? '<div class="sm-scroll"><table class="sm-tbl"><thead><tr><th>When</th><th>Candidate</th><th>Decision</th><th title="challenger, evaluation window">Log loss</th><th title="logistic recalibration slope; 1 = well spread">Slope</th><th title="share of games inside the 80% margin interval">80% coverage</th><th>Gates not passed</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<p class="sm-dim">No weekly evaluation has been published yet.</p>') + '</div>';
  }

  /* ------------------------------------------------------------ the adapter */
  var adapter = {
    defaultTab: 'games',
    load: async function (get, c) {
      var st = await get('rpc/ncaaw_fc_public_status');
      c.fc_status = (st || [])[0] || null;
      c.entitled = await get('rpc/sim_viewer_entitled');
      if (c.entitled === true) {
        if (c.fc_status && c.fc_status.published_run_id) c.forecasts = await get('ncaaw_fc_current_forecasts?select=game_id,start_utc,home_id,away_id,home_name,away_name,neutral,event,regime,available,unavailable_reason,p_home,p_ot,margin,total,pts_home,pts_away,games_played,data_quality,availability_assumption,provenance,underdog,basis,p_underdog,signals,p_market_underdog,disagreement,factors,model_key,as_of,upset_policy,published_at&order=start_utc.asc&limit=600');
        var h = await get('ncaaw_fc_model_health?select=*'); c.health = (h || [])[0] || null;
      }
      (c.forecasts || []).forEach(function (f) { if (f.upset_policy && f.upset_policy.theta == null && f.upset_policy.signals) f.upset_policy.theta = f.upset_policy.signals.upset_probability && f.upset_policy.signals.upset_probability.theta; });
    },
    paint: function (ctx) {
      var c = ctx.cache || {}; var tab = ctx.tab || 'games';
      if (c.loading && !c.fc_status) return '<div class="empty">Loading the latest published women\u2019s college basketball forecasts…</div>';
      if (tab === 'tournament') return renderTournament(c, ctx.sport);
      if (tab === 'model_health') return c.error && !c.fc_status ? '<div class="sm-card sm-err">The model health could not be read: ' + esc(c.error) + '</div>' : renderHealth(c);
      var nowMs = ctx.nowMs || Date.now();
      var st = forecastState(c, nowMs);
      /* before opening day (and while the forecasts on screen were made then): the preseason card */
      var pre = U.renderPreseason(ctx.sport, c.forecasts, nowMs);
      if (st.kind === 'no_data') return pre + '<div class="sm-card sm-empty">No women\u2019s college basketball forecast has been published yet. ' + esc(st.note || '') + '</div>' + defs();
      if (st.kind === 'unauthorized') return pre + lock(c) + defs();
      if (st.kind === 'error') return '<div class="sm-card sm-err">The forecasts could not be read: ' + esc(st.text) + '</div>';
      return header(c, st) + pre + (tab === 'upset_watch' ? renderUpset(c) : renderGames(c)) + defs();
    },
  };

  return { adapter: adapter, forecastState: forecastState, renderGames: renderGames, renderUpset: renderUpset, renderTournament: renderTournament, renderHealth: renderHealth, STALE_HOURS: STALE_HOURS };
});
