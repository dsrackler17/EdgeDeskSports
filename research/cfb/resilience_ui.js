/* ============================================================================
   EdgeDesk CFB research terminal — THE SIX SECTIONS, in every market state.
   docs/market-resilience/README.md

     1 EdgeDesk Projection · 2 Football Matchup Research · 3 Model Explanation
     4 Uncertainty and Limitations · 5 Market Comparison · 6 Research Verdict

   Sections 1–4 are EdgeDesk's own football work and render the same whatever
   the market is doing. Section 5 says what market exists (LIVE / CACHED /
   HISTORICAL / MANUAL / UNAVAILABLE / FAULT) and prints "Unavailable" with
   the reason for every value it cannot support — never a blank, never a zero.
   Section 6 is a research verdict, never a betting verdict.

   RESEARCH ONLY mode (the header toggle, or ?mode=research) reads no market
   at all: market values read "Unavailable — research-only mode", the
   price-specific cards are not drawn, and the queue ranks by the model-only
   research priority.

   Everything is rebuilt here from the stored research object with the same
   engine the build used (lib/edgedesk_research_engine.js): nothing is fetched,
   nothing is priced, and no number is computed that the build did not have.

   Browser only: window.EDResilienceUI. ES5.
   ========================================================================== */
(function () {
  'use strict';
  var RE = window.EDResearchEngine, MSX = window.EDMarketState;
  var MODE_K = 'edgedesk.cfb.research_mode';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(x) { return typeof x === 'number' && isFinite(x); }
  function pct(p, dp) { return num(p) ? (100 * p).toFixed(dp == null ? 0 : dp) + '%' : '—'; }
  function f1(x) { return num(x) ? x.toFixed(1) : '—'; }
  function sgn(x) { return num(x) ? (x > 0 ? '+' : (x < 0 ? '−' : '')) + Math.abs(x).toFixed(1) : '—'; }
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; } return null; }

  /* --------------------------------------------------------------- mode */
  function mode() {
    if (/[?&]mode=research/.test(location.search)) return 'RESEARCH_ONLY';
    if (/[?&]mode=full/.test(location.search)) return 'FULL';
    return store(MODE_K) === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : 'FULL';
  }
  function setMode(m) { store(MODE_K, m === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : 'FULL'); }
  function modeButton() {
    var on = mode() === 'RESEARCH_ONLY';
    return '<button class="btn sm modebtn' + (on ? ' on' : '') + '" id="modeBtn" title="Research only: no market is read; every football section stays available">'
      + (on ? 'MODE: RESEARCH ONLY' : 'Research only: off') + '</button>';
  }

  function build(o, board, now) {
    if (!RE || !o) return null;
    try {
      return RE.build(o, o.market_state || null, { now: now, mode: mode(), carryover: o.carryover || null,
        betting_enabled: !!(board && board.decision && board.decision.bet_enabled) });
    } catch (e) { return null; }
  }

  /* --------------------------------------------------------- the pieces */
  function chip(text, tone, tip) { return '<span class="rz-chip ' + esc(tone || '') + '"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(text) + '</span>'; }
  var TONE = { AVAILABLE: 'ok', LIMITED: 'warn', UNAVAILABLE: 'off', VERIFIED: 'ok', UNVERIFIED: 'warn', FAULT: 'bad', ELIGIBLE: 'ok', BLOCKED: 'off',
    LIVE: 'ok', CACHED: 'warn', MANUAL: 'warn', HISTORICAL: 'off', RESEARCH_ONLY: 'off',
    OFFICIAL: 'ok', SUPPORTED: 'ok', HYPOTHETICAL: 'warn', MODEL: 'info' };
  function kv(items) { return '<div class="kv">' + items.filter(Boolean).map(function (x) { return '<div class="c"><div class="l">' + esc(x[0]) + '</div><div class="v">' + x[1] + '</div>' + (x[2] ? '<div class="n">' + x[2] + '</div>' : '') + '</div>'; }).join('') + '</div>'; }
  function sec(n, id, title, teaser, body, open) {
    return '<details class="sec rz-sec" id="rz-' + id + '"' + (open ? ' open' : '') + ' data-sec="rz_' + id + '"><summary><span class="caret">▶</span><span class="t">' + n + ' · ' + esc(title) + '</span><span class="x">' + esc(teaser || '') + '</span></summary><div class="b">' + body + '</div></details>';
  }
  function bars(list) {
    if (!list || !list.length) return '';
    return '<div class="rz-bars" role="img" aria-label="Outcome distribution">' + list.map(function (b) {
      return '<div class="rz-bar"><span class="l">' + esc(b.label) + '</span><span class="track"><i style="width:' + Math.max(1, Math.round(100 * (b.p || 0))) + '%"></i></span><span class="v mono">' + pct(b.p, 0) + '</span></div>';
    }).join('') + '</div>';
  }
  function unavailable(text) { return '<span class="rz-na">' + esc(text || 'Unavailable') + '</span>'; }

  /* ----------------------------------------------------------- sections */
  function s1(o, R) {
    var P = R.sections.projection, g = o.game;
    if (!P.available) return sec(1, 'projection', 'EdgeDesk Projection', 'not projected', '<div class="empty">' + esc(P.reason) + '</div>', true);
    var b = kv([
      ['Fair spread', esc(P.fair_text), 'home line ' + sgn(P.fair_home_line)],
      P.projected_score ? ['Projected score', esc(g.away + ' ' + f1(P.projected_score.away) + ' – ' + g.home + ' ' + f1(P.projected_score.home)), null] : null,
      ['Fair total', num(P.fair_total) ? P.fair_total.toFixed(1) : unavailable('not projected'), null],
      ['Win probability', esc(g.home) + ' ' + pct(P.win_prob.home) + ' · ' + esc(g.away) + ' ' + pct(P.win_prob.away), null],
      ['80% range', esc(P.interval_80 ? P.interval_80.text : '—'), 'σ ' + f1(P.sigma)],
      ['Football confidence', P.football_confidence ? esc((P.football_confidence.score == null ? '—' : P.football_confidence.score) + ' · ' + (P.football_confidence.label || '')) : '—', 'information quality, not a probability'],
      ['Data completeness', P.reliability == null ? '—' : esc(String(P.reliability)), 'input reliability 0–100'],
      P.power.team_strength ? ['Power-rating edge', esc(P.power.team_strength.text), 'neutral field, opponent-adjusted'] : null
    ]);
    b += '<div class="sub"><h3>Outcome distribution</h3>' + bars(P.outcome_bands) + '<div class="note">' + esc(P.outcome_basis) + '.</div></div>';
    if (P.power.rating_divergence) b += '<div class="note">' + esc(P.power.rating_divergence.text) + '</div>';
    b += '<div class="note">' + esc(P.model_version) + ' · published ' + esc(P.prediction_ts || '—') + ' · no sportsbook number enters this projection.</div>';
    return sec(1, 'projection', 'EdgeDesk Projection', P.fair_text + (P.projected_score ? ' · ' + f1(P.projected_score.away) + '–' + f1(P.projected_score.home) : ''), b, true);
  }
  function s2(o, R) {
    var M = R.sections.matchup, g = o.game, b = '';
    b += '<div class="sub" style="margin-top:0"><h3>Position-group and unit matchups</h3>' + (M.cards.length ? '<table class="t"><tr><th>Unit</th><th>Edge</th><th class="n">Net SD</th><th>Confidence</th><th>Measured</th></tr>' + M.cards.map(function (c) {
      return '<tr><td>' + esc(c.label) + '</td><td>' + esc(c.favors ? c.favors + ' (' + c.magnitude + ')' : 'even') + '</td><td class="n">' + sgn(c.net_sd) + '</td><td>' + esc(c.confidence) + '</td><td class="mut">'
        + esc((c.values || []).slice(0, 4).map(function (v) { return v.team + ' ' + v.metric + ' ' + v.value; }).join(' · ')) + '</td></tr>'; }).join('') + '</table>' : '<div class="empty">No unit data on file.</div>')
      + (M.not_measured && M.not_measured.length ? '<div class="note">Not measured: ' + esc(M.not_measured.map(function (x) { return x.label || x; }).join(', ')) + '.</div>' : '') + '</div>';
    b += '<div class="sub"><h3>Quarterbacks and availability</h3><ul class="l">' + ['home', 'away'].map(function (s) { var q = M.qb && M.qb[s]; return '<li>' + esc((s === 'home' ? g.home : g.away) + ': ' + (q ? (q.player || 'unknown') + ' (' + String(q.status || '—').toLowerCase().replace(/_/g, ' ') + ')' : 'unknown')) + '</li>'; }).join('')
      + (M.availability.main_deduction ? '<li>' + esc(M.availability.main_deduction) + '</li>' : '') + '</ul></div>';
    b += '<div class="sub"><h3>Roster continuity and coaching</h3><ul class="l">' + M.roster_continuity.map(function (r) { return '<li>' + (r.regime_change ? '<span class="sev moderate">turnover</span>' : '') + esc(r.text) + '</li>'; }).join('')
      + M.coaching.filter(function (c) { return c.change; }).map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul></div>';
    b += '<div class="sub"><h3>Strength of schedule</h3><div>' + esc(M.schedule_note) + '</div>' + (M.schedule.length ? '<ul class="l">' + M.schedule.map(function (x) { return '<li>' + esc(x.label + ': ' + x.text) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    b += '<div class="sub"><h3>Game scripts</h3><table class="t">' + M.game_scripts.map(function (x) { return '<tr><td><b>' + esc(x.label) + '</b></td><td class="n">' + (x.prob == null ? '' : pct(x.prob)) + '</td><td>' + esc(x.text) + '</td></tr>'; }).join('') + '</table><div class="note">Probabilities from EdgeDesk’s margin distribution (normal approximation). Scenarios, not forecasts of how the game unfolds.</div></div>';
    if (M.historical && M.historical.available) b += '<div class="sub"><h3>Historical performance</h3><table class="t"><tr><th>Comparable set</th><th class="n">W–L</th><th class="n">Rate</th><th class="n">n</th></tr>' + M.historical.sets.map(function (x) { return '<tr><td>' + esc(x.label) + '</td><td class="n">' + x.w + '–' + x.l + '</td><td class="n">' + (x.n >= (M.historical.min_n || 30) ? x.pct + '%' : 'n too small') + '</td><td class="n">' + x.n + '</td></tr>'; }).join('') + '</table><div class="note">' + esc(M.historical.note || '') + '</div></div>';
    return sec(2, 'matchup', 'Football Matchup Research', M.cards.filter(function (c) { return c.favors; }).length + ' measured unit edges', b, true);
  }
  function s3(o, R) {
    var X = R.sections.explanation, b = '';
    b += '<div class="sub" style="margin-top:0"><h3>What builds the number</h3>' + (X.drivers.length ? '<table class="t">' + X.drivers.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + esc(r.text) + '</td></tr>'; }).join('')
      + '<tr class="cur"><td><b>EdgeDesk margin</b></td><td class="n"><b>' + sgn(X.raw_margin) + '</b></td></tr></table><div class="note">' + esc(X.basis || '') + (X.reconciles ? ' · the terms sum exactly to the margin.' : '') + '</div>' : '<div class="empty">No term breakdown on file.</div>') + '</div>';
    if (X.prior_season) b += '<div class="sub"><h3>How much comes from prior seasons</h3><div>' + esc(X.prior_season.text) + '</div></div>';
    if (X.models) b += '<div class="sub"><h3>EdgeDesk’s independent models · ' + esc(X.models.agreement ? X.models.agreement.tier : '—') + ' agreement (SD ' + f1(X.models.sd) + ')</h3><table class="t">' + X.models.rows.map(function (r) { return '<tr><td>' + esc(r.label) + (r.independent ? '' : ' <span class="mut">(not independent)</span>') + '</td><td class="n">' + esc(r.text) + '</td></tr>'; }).join('') + '</table>'
      + (X.models.why_disagree || []).map(function (t) { return '<div class="note">' + esc(t) + '</div>'; }).join('') + '</div>';
    if (X.unpriced.length) b += '<div class="note">Shown but not priced: ' + esc(X.unpriced.join(', ')) + '.</div>';
    return sec(3, 'explanation', 'Model Explanation', X.drivers.length + ' priced terms', b, false);
  }
  function s4(o, R) {
    var U = R.sections.uncertainty, b = '';
    b += kv([['Uncertainty', String(U.score), U.why.join(', ') || 'nothing flagged'], U.football_confidence ? ['Football confidence', esc(String(U.football_confidence.score)), esc(U.football_confidence.label)] : null,
      ['Reliability', U.data_completeness.reliability == null ? '—' : esc(String(U.data_completeness.reliability)), esc(U.data_completeness.grade || '')]]);
    b += '<div class="sub"><h3>Reasons the projection could be wrong</h3><ul class="l">' + U.reasons_could_be_wrong.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
    if (U.data_completeness.rows && U.data_completeness.rows.length) b += '<div class="sub"><h3>Data completeness</h3><table class="t">' + U.data_completeness.rows.map(function (r) { return '<tr><td>' + esc(r.label) + '</td><td class="n">' + esc(r.value) + esc(r.unit || '') + '</td><td class="mut">' + esc(r.detail || '') + '</td></tr>'; }).join('') + '</table>'
      + (U.data_completeness.separate ? '<div class="note">' + esc(U.data_completeness.separate) + '</div>' : '') + '</div>';
    return sec(4, 'uncertainty', 'Uncertainty and Limitations', 'uncertainty ' + U.score + ' · ' + U.reasons_could_be_wrong.length + ' caveats', b, false);
  }
  function sensitivityHTML(R) {
    var S = R.sensitivity;
    if (!S || !S.available || !S.market) return '';
    var b = '<div class="sub"><h3>Sensitivity: does the disagreement survive other reasonable assumptions?</h3>'
      + (S.carryover && S.carryover.available ? '<div class="note" style="margin:0 0 6px">' + esc(S.carryover.text) + '</div>' : '')
      + '<table class="t"><tr><th>Scenario</th><th>EdgeDesk</th><th class="n">Change</th><th class="n">Gap vs market</th><th>Status</th></tr>'
      + S.rows.map(function (r) { return '<tr' + (r.official ? ' class="cur"' : '') + '><td>' + esc(r.label) + '<div class="mut" style="font-size:11px">' + esc(r.basis || '') + '</div></td><td class="n">' + esc(r.fair_text) + '</td><td class="n">' + (r.official ? '—' : sgn(r.change)) + '</td><td class="n">' + (r.gap == null ? '—' : f1(r.gap)) + '</td><td>' + chip(r.status, TONE[r.status]) + '</td></tr>'; }).join('')
      + '</table>' + (S.variance_only.length ? '<div class="note">Widen the range only (the mean is not moved): ' + esc(S.variance_only.map(function (v) { return v.label; }).join('; ')) + '.</div>' : '')
      + (S.persistence ? '<div class="banner"><b>' + esc(S.persistence.key) + '.</b> ' + esc(S.persistence.text) + (S.persistence.hypothetical_text ? ' ' + esc(S.persistence.hypothetical_text) : '') + '</div>' : '')
      + (S.range && S.range.market_text ? '<div class="note">' + esc(S.range.market_text) + '</div>' : '')
      + (S.reconcile.length ? '<div class="sub"><h3>What would need to change to reconcile</h3><ul class="l">' + S.reconcile.map(function (r) { return '<li>' + esc(r.text) + (r.sds_needed != null ? ' <span class="mut">(' + r.sds_needed.toFixed(1) + ' SD of its own uncertainty)</span>' : '') + '</li>'; }).join('') + '</ul>' + (S.reconcile_note ? '<div class="note">' + esc(S.reconcile_note) + '</div>' : '') + '</div>' : '')
      + '<div class="note">' + esc(S.rule) + '</div></div>';
    return b;
  }
  function s5(o, R) {
    var M = R.sections.market, b = '';
    b += '<div class="rz-mstate">' + chip(M.label, TONE[M.state]) + ' <span>' + esc(M.basis_label) + '</span></div><div class="note" style="margin-top:4px">' + esc(M.reason) + '</div>';
    if (M.provider && M.provider.status && M.provider.status !== 'OK' && M.provider.status !== 'UNKNOWN') b += '<div class="banner warn"><b>Odds provider: ' + esc(M.provider.status.replace(/_/g, ' ')) + '.</b> ' + esc(M.provider.text) + (M.provider.detail ? ' (' + esc(M.provider.detail) + ')' : '') + ' The football sections above are unaffected.</div>';
    var na = {}; (M.unavailable || []).forEach(function (u) { na[u.key] = u.reason; });
    var sp = M.spread, tt = M.total;
    b += kv([
      ['Spread', sp ? esc(sp.model_text) + ' vs ' + esc(sp.market_text) : unavailable(na.spread_difference || na.all), sp ? esc(sp.formula || '') + (sp.research_only ? ' · research context (' + esc(String(sp.market_basis).toLowerCase()) + ')' : '') : null],
      ['Spread difference', sp ? f1(sp.gap) + ' pts toward ' + esc(sp.toward_team || '—') : unavailable(na.spread_difference || na.all), null],
      ['Total', tt ? 'EdgeDesk ' + f1(tt.model) + ' vs ' + f1(tt.market) : unavailable(na.total_difference || na.all), tt ? esc(tt.text) : null],
      ['No-vig (home / away)', M.no_vig ? pct(M.no_vig.home, 1) + ' / ' + pct(M.no_vig.away, 1) : unavailable(na.no_vig || na.all), M.no_vig ? esc(M.no_vig.book || '') + ' · overround ' + pct(M.no_vig.overround, 1) : null],
      ['Break-even (home / away)', M.break_even ? pct(M.break_even.home, 1) + ' / ' + pct(M.break_even.away, 1) : unavailable(na.break_even || na.all), null],
      ['Quote age', M.age_text ? esc(M.age_text) : unavailable('no capture'), M.captured_at ? esc(M.captured_at) : null],
      ['Sources', M.sources && M.sources.length ? esc(M.sources.join(', ')) : unavailable('none'), null],
      ['Price-specific decision', M.decision.shown ? esc(M.decision.text) : unavailable(M.decision.text), null]
    ]);
    if (M.integrity) {
      if (M.integrity.failures.length) b += '<div class="sub"><h3>Integrity failures (excluded from every comparison)</h3><ul class="l">' + M.integrity.failures.map(function (f) { return '<li><span class="sev high">' + esc(f.codes.join(', ')) + '</span>' + esc((f.source || '') + ':' + (f.book || '') + ' — ' + f.reasons.join('; ')) + '</li>'; }).join('') + '</ul></div>';
      if (M.integrity.held.length) b += '<div class="sub"><h3>Held for verification</h3><ul class="l">' + M.integrity.held.map(function (h) { return '<li>' + esc(h.reasons.join('; ')) + '</li>'; }).join('') + '</ul></div>';
      if (M.integrity.warnings.length) b += '<div class="note">' + esc(M.integrity.warnings.join(' · ')) + '</div>';
    }
    b += sensitivityHTML(R);
    return sec(5, 'market', 'Market Comparison', M.label + (sp ? ' · ' + f1(sp.gap) + ' pts' : ''), b, R.disagreement && R.disagreement.available && R.disagreement.key === 'INVESTIGATE');
  }
  function s6(o, R) {
    var V = R.sections.verdict, A = R.axes;
    var b = '<div class="rz-verdict ' + esc(V.tone) + '"><div class="h">' + esc(V.headline) + '</div><div class="t">' + esc(V.text) + '</div></div>'
      + '<table class="t"><tr><th>Research visibility</th><td>' + chip(A.research_visibility.key, TONE[A.research_visibility.key]) + ' ' + esc(A.research_visibility.means) + (A.research_visibility.caveats.length ? '<div class="mut">' + esc(A.research_visibility.caveats.join(' ')) + '</div>' : '') + '</td></tr>'
      + '<tr><th>Market integrity</th><td>' + chip(A.market_integrity.key, TONE[A.market_integrity.key]) + ' ' + esc(A.market_integrity.reasons.join('; ')) + '</td></tr>'
      + '<tr><th>Betting validation</th><td>' + chip(A.betting_validation.key, TONE[A.betting_validation.key]) + ' ' + (A.betting_validation.blockers.length ? '<ul class="l">' + A.betting_validation.blockers.map(function (x) { return '<li><span class="mono mut">' + esc(x.code) + '</span> ' + esc(x.text) + '</li>'; }).join('') + '</ul>' : esc(A.betting_validation.means)) + '</td></tr></table>'
      + '<div class="note">A research verdict, not a betting verdict. ELIGIBLE only hands an exact price to the decision engine; it never says bet.</div>';
    return sec(6, 'verdict', 'Research Verdict', V.headline, b, true);
  }

  /* the panel: the verdict up top, then the six sections */
  function html(o, R) {
    if (!R) return '<div class="banner warn"><b>The research layer did not load on this page.</b> The sections below still read from the stored research object.</div>';
    var V = R.sections.verdict, A = R.axes;
    return '<div class="rz">'
      + '<div class="rz-top ' + esc(V.tone) + '"><div class="h">' + esc(V.headline) + '</div><div class="t">' + esc(V.text) + '</div>'
      + '<div class="ax">' + chip('Research: ' + A.research_visibility.key, TONE[A.research_visibility.key], A.research_visibility.means)
      + chip('Market integrity: ' + A.market_integrity.key, TONE[A.market_integrity.key], A.market_integrity.means)
      + chip('Betting: ' + A.betting_validation.key, TONE[A.betting_validation.key], A.betting_validation.means)
      + chip('Market: ' + R.sections.market.label, TONE[R.sections.market.state], R.sections.market.basis_label) + '</div></div>'
      + '<nav class="secnav">' + [['projection', '1 · Projection'], ['matchup', '2 · Matchup'], ['explanation', '3 · Explanation'], ['uncertainty', '4 · Uncertainty'], ['market', '5 · Market'], ['verdict', '6 · Verdict']]
        .map(function (x) { return '<a href="#/game/' + esc(o.game_id) + '" data-jump="rz-' + x[0] + '">' + x[1] + '</a>'; }).join('') + '</nav>'
      + s1(o, R) + s2(o, R) + s3(o, R) + s4(o, R) + s5(o, R) + s6(o, R) + '</div>';
  }

  /* ------------------------------------------------- research brief export */
  function brief(o, R) {
    if (!R) return '';
    var g = o.game, P = R.sections.projection, M = R.sections.market, V = R.sections.verdict, U = R.sections.uncertainty, X = R.sections.explanation, MU = R.sections.matchup;
    var L = [];
    L.push('# ' + g.away + ' @ ' + g.home + ' — EdgeDesk research brief');
    L.push('');
    L.push('**' + V.headline + '** — ' + V.text);
    L.push('');
    L.push('## 1. EdgeDesk Projection');
    if (P.available) {
      L.push('- Fair spread: ' + P.fair_text + (P.projected_score ? ' · projected score ' + g.away + ' ' + f1(P.projected_score.away) + ' – ' + g.home + ' ' + f1(P.projected_score.home) : ''));
      L.push('- Fair total: ' + (num(P.fair_total) ? P.fair_total.toFixed(1) : 'not projected') + ' · win probability ' + g.home + ' ' + pct(P.win_prob.home) + ' / ' + g.away + ' ' + pct(P.win_prob.away));
      L.push('- 80% range: ' + (P.interval_80 ? P.interval_80.text : '—') + ' · model ' + P.model_version + ' (published ' + (P.prediction_ts || '—') + ')');
    } else L.push('- ' + P.reason);
    L.push('');
    L.push('## 2. Football Matchup Research');
    MU.cards.filter(function (c) { return c.favors; }).forEach(function (c) { L.push('- ' + c.label + ': ' + c.favors + ' (' + c.magnitude + ', ' + sgn(c.net_sd) + ' SD, ' + c.confidence + ' confidence)'); });
    MU.roster_continuity.forEach(function (r) { L.push('- ' + r.text); });
    MU.game_scripts.forEach(function (x) { L.push('- ' + x.label + (x.prob == null ? '' : ' (' + pct(x.prob) + ')') + ': ' + x.text); });
    L.push('');
    L.push('## 3. Model Explanation');
    X.drivers.forEach(function (r) { L.push('- ' + r.label + ': ' + r.text); });
    if (X.prior_season) L.push('- ' + X.prior_season.text);
    L.push('');
    L.push('## 4. Uncertainty and Limitations');
    U.reasons_could_be_wrong.forEach(function (t) { L.push('- ' + t); });
    L.push('');
    L.push('## 5. Market Comparison');
    L.push('- Market: ' + M.label + ' — ' + M.basis_label + '. ' + M.reason);
    (M.unavailable || []).forEach(function (u) { L.push('- ' + u.key.replace(/_/g, ' ') + ': ' + u.reason); });
    if (M.spread) L.push('- Spread: ' + M.spread.model_text + ' vs ' + M.spread.market_text + ' (' + M.spread.formula + ')');
    if (M.total) L.push('- Total: ' + M.total.text);
    if (R.sensitivity && R.sensitivity.persistence) L.push('- Sensitivity: ' + R.sensitivity.persistence.text + (R.sensitivity.persistence.hypothetical_text ? ' ' + R.sensitivity.persistence.hypothetical_text : ''));
    L.push('');
    L.push('## 6. Research Verdict');
    L.push('- ' + V.headline + '. Research visibility ' + R.axes.research_visibility.key + ' · market integrity ' + R.axes.market_integrity.key + ' · betting validation ' + R.axes.betting_validation.key + '.');
    L.push('');
    L.push('_Research, not picks. No validated betting edge is implied. Generated ' + (R.generated_at || '') + ' (' + R.version + ', mode ' + R.mode + ')._');
    return L.join('\n');
  }

  /* ------------------------------------- the model-only research priority */
  function priorityHTML(board, key) {
    var rows = (board.rows || []).filter(function (r) { return r.research_priority; });
    var keys = (board.resilience && board.resilience.priority_keys) || [];
    key = key || 'score';
    rows.sort(function (a, b) { var x = key === 'score' ? a.research_priority.score : (a.research_priority.components || {})[key] || 0, y = key === 'score' ? b.research_priority.score : (b.research_priority.components || {})[key] || 0; return y - x; });
    var h = '<div class="banner"><b>Model-only research priority.</b> How much there is to investigate in each game, from EdgeDesk’s own football data. It reads no sportsbook number and it is not a ranking of bets.</div>'
      + '<div class="sortbar">Rank by <select id="prioSort"><option value="score"' + (key === 'score' ? ' selected' : '') + '>Overall research priority</option>'
      + keys.map(function (k) { return '<option value="' + esc(k.key) + '"' + (key === k.key ? ' selected' : '') + '>' + esc(k.label) + '</option>'; }).join('') + '</select><span>' + rows.length + ' games</span></div>';
    h += '<div class="board">' + rows.map(function (r) {
      var v = r.verdict || {}, m = r.market_state || {};
      return '<div class="row"><div class="rh"><div class="g"><div class="m">' + esc(r.away) + ' @ ' + esc(r.home) + '</div><div class="k">' + esc(r.kickoff || '') + (r.week_scope === 'FUTURE_WEEK' ? ' · LOOK-AHEAD' : '') + '</div></div>'
        + '<div class="c ed"><div class="l">EdgeDesk</div><div class="v">' + esc(r.fair || '—') + '</div></div>'
        + '<div class="c"><div class="l">Priority</div><div class="v">' + esc(String(r.research_priority.score)) + '</div></div>'
        + '<div class="s">' + chip(v.headline || '—', v.tone === 'investigate' ? 'warn' : '') + (mode() === 'RESEARCH_ONLY' ? '' : chip('Market: ' + (m.label || '—'), TONE[m.state])) + '</div></div>'
        + '<div class="rx" style="display:block">' + (r.research_priority.reasons || []).map(function (t) { return '<div class="ln"><span class="l">Why</span><span>' + esc(t) + '</span></div>'; }).join('')
        + '<div class="act"><a class="btn pri" href="#/game/' + esc(r.game_id) + '">Open research page →</a></div></div></div>';
    }).join('') + '</div>';
    return h;
  }

  window.EDResilienceUI = { mode: mode, setMode: setMode, modeButton: modeButton, build: build, html: html, brief: brief, priorityHTML: priorityHTML,
    ask: function (q, o, R) { return RE && RE.ask ? RE.ask(q, o, R) : null; } };
})();
