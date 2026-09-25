/* ===========================================================================
   EdgeDesk GAME EVIDENCE PACKAGE — the one normalized object reliability is
   calculated from.

     game_evidence = {
       team_data, quarterback, availability, impact, player_quality,
       market, environment, source_health, conflicts, missing, stale
     }

   WHY ONE OBJECT. Before this, every consumer interpreted missing data its
   own way: the contract called a team USABLE because it had a report for a
   different game, the starter layer read a 2022 ESPN row as today's fitness,
   the reliability scorer counted an offensive lineman at depth 3 as a
   reserve. The enrichment build (football/enrichment/) interprets each
   source ONCE — normalization, identity, source agreement, freshness — and
   publishes the result here. Nothing downstream needs to know which vendor
   said what; it reads the package.

   Built by football/enrichment/build_enrichment.js (the evidence), completed
   at scoring time with what only the scorer holds (the input contract's
   venue and weather lineage, a live market join), and read by
   lib/cfb_reliability.js. The same file runs in the build and on the board,
   so both score from the same interpretation.

   NEVER FAKE COVERAGE, in one place:
     a provider failure is PROVIDER_FAILED, never "no injuries";
     a player nobody listed is UNKNOWN unless a comprehensive official report
       for THIS fixture says the rest are available;
     a starter with no conflicting source is EXPECTED, not CONFIRMED;
     one quote is one quote, not a consensus;
     an unrated player's impact is UNKNOWN, not zero;
     an FCS team's missing rating is the shared floor, not an average team.

   Browser: window.EDGameEvidence.  Node: require('./game_evidence.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDGameEvidence = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var G = { version: 'game_evidence/1', SCHEMA: 'edgedesk_game_evidence_v1', ARTIFACT_SCHEMA: 'edgedesk_enrichment_v1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function ms(t) { if (t == null || t === '') return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : null; }

  /* the availability evidence class, in the input contract's vocabulary, so
     every existing reader of a contract state reads the same answer */
  G.CLASS_TO_STATE = {
    COMPREHENSIVE_OFFICIAL: 'USABLE', OFFICIAL_THIS_GAME: 'USABLE', MULTI_SOURCE_CURRENT: 'USABLE',
    STRUCTURED_CURRENT: 'USABLE', OFFICIAL_ABSENCE_ONLY: 'RESEARCH_ONLY', STALE_CARRIED: 'STALE',
    NOT_DUE_YET: 'NOT_DUE_YET', NOT_REQUIRED: 'NOT_REQUIRED', PROVIDER_FAILED: 'FETCH_FAILED', NO_SOURCE: 'UNAVAILABLE'
  };

  /* one game's package out of the published artifact
     (football/enrichment/current.json) */
  G.forGame = function (art, gameId) {
    if (!art || art.schema !== G.ARTIFACT_SCHEMA || !art.games || gameId == null) return null;
    var p = art.games[String(gameId)];
    if (!p) return null;
    var out = clone(p);
    out.artifact_generated_at = art.generated_at || null;
    /* provider health is published once per run and belongs to every package */
    if (!out.source_health && art.source_health) out.source_health = clone(art.source_health);
    return out;
  };

  /* completed at scoring time: the environment lineage the input contract
     carries, and a live market consensus when the caller joined one */
  G.complete = function (pkg, o) {
    if (!pkg) return null;
    o = o || {};
    var p = clone(pkg);
    var rows = o.contract || [];
    function row(f, s) { for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].field === f && (rows[i].side || null) === (s || null)) return rows[i]; return null; }
    function lin(r) { return r ? { value: r.detail || r.state, state: r.state, source: r.source || null, observed_at: r.observed_at || r.as_of || null,
      retrieved_at: r.as_of || null, provenance: (r.source && (r.observed_at || r.as_of)) ? 'COMPLETE' : 'INCOMPLETE' } : null; }
    p.environment = { venue: lin(row('venue_geography', 'home')), travel: lin(row('venue_geography', 'away')), weather: lin(row('weather', null)) };
    p.team_data = p.team_data || {};
    ['home', 'away'].forEach(function (s) {
      p.team_data[s] = p.team_data[s] || {};
      p.team_data[s].rating_lineage = lin(row('team_rating', s));
    });
    if (o.market) {
      p.market = G.marketCompact(o.market);
      p.market.joined_live = true;
    }
    p.missing = (p.missing || []).slice();
    p.stale = (p.stale || []).slice();
    if (p.environment.weather && p.environment.weather.state === 'STALE') p.stale.push('weather');
    return p;
  };

  G.marketCompact = function (c) {
    if (!c) return null;
    return { books_reporting: c.books_reporting || 0, consensus_spread: num(c.consensus_spread), median_spread: num(c.median_spread),
      modal_spread: num(c.modal_spread), dispersion: c.market_dispersion ? c.market_dispersion.level : null,
      range: c.market_dispersion ? c.market_dispersion.range : null,
      best_home: c.best_available && c.best_available.home ? c.best_available.home : null,
      best_away: c.best_available && c.best_available.away ? c.best_available.away : null,
      outliers: (c.outlier_books || []).length, freshness_minutes: c.market_freshness ? c.market_freshness.age_minutes : null,
      quality_score: c.market_quality_score, quality_grade: c.market_quality_grade, is_consensus: !!c.is_consensus,
      summary: c.summary || null, basis: c.basis || null, carried: !!c.carried, stale: !!c.stale };
  };

  /* the availability read of one side as an input-contract row */
  G.availabilityRow = function (pkg, side) {
    var a = pkg && pkg.availability && pkg.availability[side];
    if (!a || !a.coverage_class) return null;
    var st = G.CLASS_TO_STATE[a.coverage_class] || 'UNAVAILABLE';
    return { field: 'availability', side: side, state: st, source: 'enrichment: ' + a.coverage_class,
      as_of: a.as_of || (a.official && a.official.published_at) || null,
      observed_at: (a.official && a.official.published_at) || a.as_of || null,
      detail: a.coverage_reason, evidence_class: a.coverage_class,
      comprehensive: a.coverage_class === 'COMPREHENSIVE_OFFICIAL',
      official: a.coverage_class === 'COMPREHENSIVE_OFFICIAL' || a.coverage_class === 'OFFICIAL_THIS_GAME' || a.coverage_class === 'OFFICIAL_ABSENCE_ONLY',
      coverage_score: num(a.coverage_score) };
  };
  /* whether one side's resolved starter can play, as an input-contract row */
  G.qbStatusRow = function (pkg, side) {
    var q = pkg && pkg.quarterback && pkg.quarterback[side];
    var a = pkg && pkg.availability && pkg.availability[side];
    if (!q) return null;
    var st;
    if (q.status && q.status !== 'UNKNOWN') st = q.status_fresh === false ? 'STALE' : 'USABLE';
    else if (a && a.coverage_class === 'NOT_DUE_YET') st = 'NOT_DUE_YET';
    else if (a && a.coverage_class === 'NOT_REQUIRED') st = 'NOT_REQUIRED';
    else st = 'UNAVAILABLE';
    return { field: 'qb_availability', side: side, state: st, source: 'enrichment: QB resolver',
      detail: q.status && q.status !== 'UNKNOWN' ? (q.player_name + ' ' + q.status + (q.status_basis ? ' — ' + q.status_basis : '')) : (a ? a.coverage_reason : null),
      designation: q.status || 'UNKNOWN' };
  };

  /* ------------------------------------------------------------ the view
     DATA COVERAGE for one game, from its package and its reliability. Every
     number is a count of what is known over what is asked; nothing here is a
     probability. `rel` is a lib/cfb_reliability.js score() result. */
  var QB_RANK = { CONFIRMED: 0, STRONGLY_EXPECTED: 1, EXPECTED: 2, UNCERTAIN: 3, CONFLICTED: 4, UNKNOWN: 5 };
  G.view = function (pkg, rel, names) {
    names = names || {};
    var v = { rows: [], uncertainty: [], potential: null, score: rel ? rel.score : null, grade: rel ? rel.grade_label : null };
    function compPct(k) { var c = rel && rel.components && rel.components[k]; return c && c.max ? Math.round(100 * c.score / c.max) : null; }
    v.rows.push({ key: 'team_data', label: 'Team data', value: compPct('team_data'), unit: '%' });
    /* the quarterback: the weaker side decides the headline */
    var qh = pkg && pkg.quarterback ? pkg.quarterback.home : null, qa = pkg && pkg.quarterback ? pkg.quarterback.away : null;
    var worst = [qh, qa].filter(Boolean).sort(function (a, b) { return (QB_RANK[b.confirmation_level] || 5) - (QB_RANK[a.confirmation_level] || 5); })[0];
    var qbText = worst ? ((qh && qa && qh.confirmation_level === qa.confirmation_level) ? worst.confirmation_level.replace(/_/g, ' ')
      : worst.confirmation_level.replace(/_/g, ' ') + ' (' + (worst === qh ? names.home || 'home' : names.away || 'away') + ')') : 'NOT ASSESSED';
    v.rows.push({ key: 'qb', label: 'QB', value: qbText, unit: null,
      detail: [qa, qh].filter(Boolean).map(function (q) { return (q.player_name || 'unknown') + ' — ' + q.confirmation_level.replace(/_/g, ' ').toLowerCase(); }).join('; ') });
    /* availability: projected starters whose status is known */
    var ah = pkg && pkg.availability ? pkg.availability.home : null, aa = pkg && pkg.availability ? pkg.availability.away : null;
    var kn = 0, tot = 0;
    [ah, aa].forEach(function (a) { if (a && a.starters) { kn += a.starters.known || 0; tot += a.starters.total || 0; } });
    v.rows.push({ key: 'availability', label: 'Availability', value: tot ? pct(kn, tot) : null, unit: '%',
      detail: tot ? kn + ' of ' + tot + ' projected starters with a known status' : 'no availability evidence' });
    var pq = pkg && pkg.player_quality && pkg.player_quality.game;
    v.rows.push({ key: 'player_quality', label: 'Player quality', value: pq ? pq.starters_pct : null, unit: '%',
      detail: pq ? 'projected starters with a measured rating: offense ' + pq.offense_pct + '%, defense ' + pq.defense_pct + '%, key contributors ' + pq.key_pct + '%' : null });
    v.rows.push({ key: 'environment', label: 'Environment', value: compPct('environment'), unit: '%' });
    var mk = pkg && pkg.market;
    v.rows.push({ key: 'market', label: 'Market', value: mk ? mk.books_reporting + ' book' + (mk.books_reporting === 1 ? '' : 's') : 'not joined',
      unit: null, detail: mk ? mk.summary : 'no market is joined to this read' });
    var st = rel && rel.stability;
    v.rows.push({ key: 'stability', label: 'Projection stability', value: st && st.tier_label ? st.tier_label : (st && st.tier ? st.tier : 'not measured'), unit: null });
    /* what remains uncertain, most important first */
    var U = [];
    [['away', aa, qa], ['home', ah, qh]].forEach(function (x) {
      var nm = names[x[0]] || x[0], a = x[1], q = x[2];
      if (q && (q.confirmation_level === 'CONFLICTED')) U.push({ w: 90, text: nm + ' QB conflicted: ' + (q.resolution_text || 'sources disagree') });
      else if (q && q.confirmation_level === 'UNKNOWN') U.push({ w: 88, text: nm + ' starting QB unknown' + (q.last_known ? ' (last known: ' + q.last_known.player_name + ')' : '') });
      else if (q && q.status && q.status !== 'UNKNOWN' && q.status !== 'AVAILABLE' && q.status !== 'PROBABLE') U.push({ w: 86, text: nm + ' QB ' + q.player_name + ' ' + q.status.toLowerCase() });
      else if (q && (!q.status || q.status === 'UNKNOWN')) U.push({ w: 60, text: nm + ' QB ' + (q.player_name || '') + ' — no source states he can play' });
      if (a && (a.coverage_class === 'PROVIDER_FAILED' || a.coverage_class === 'NO_SOURCE')) U.push({ w: 70, text: nm + ' availability unknown: ' + a.coverage_reason });
      (a && a.starters && a.starters.doubt_top || []).forEach(function (p) { U.push({ w: 75, text: nm + ' starting ' + (p.pos || '') + ' ' + p.name + ' ' + String(p.status || '').toLowerCase() }); });
      if (a && a.starters && a.starters.unknown && a.coverage_class !== 'PROVIDER_FAILED' && a.coverage_class !== 'NO_SOURCE' && a.coverage_class !== 'NOT_DUE_YET')
        U.push({ w: 40, text: nm + ': ' + a.starters.unknown + ' projected starter' + (a.starters.unknown === 1 ? '' : 's') + ' with no stated status' });
      var fcs = pkg && pkg.team_data && pkg.team_data[x[0]] && pkg.team_data[x[0]].fcs;
      if (fcs) U.push({ w: 80, text: nm + ' priced from the shared FCS floor (' + fcs.floor + '); bridged rating ' + fcs.team_rating + ' ± ' + fcs.rating_sd + ' (' + String(fcs.confidence || '').toLowerCase() + ')' });
      var im = pkg && pkg.impact && pkg.impact[x[0]];
      (im && im.top || []).filter(function (t) { return t.impact_status === 'UNKNOWN' && (t.category === 'CRITICAL' || t.category === 'MAJOR'); }).slice(0, 2)
        .forEach(function (t) { U.push({ w: 72, text: nm + ' ' + (t.position || '') + ' ' + t.player_name + ' ' + String(t.status || '').toLowerCase() + ' — ' + t.category.toLowerCase() + ' role, impact unknown (unrated)' }); });
    });
    if (mk && mk.books_reporting < 2) U.push({ w: 30, text: 'market: ' + (mk.books_reporting ? 'one quote, not a consensus' : 'no quote') });
    U.sort(function (a, b) { return b.w - a.w; });
    v.uncertainty = U.slice(0, 5).map(function (u) { return u.text; });
    v.potential = rel && rel.potential ? rel.potential : null;
    return v;
  };

  /* the plain-text block the card and the brief print */
  G.viewText = function (v) {
    if (!v) return [];
    var L = [];
    if (v.score != null) L.push('RELIABILITY ' + v.score + ' — ' + (v.grade || ''));
    L.push('DATA COVERAGE');
    v.rows.forEach(function (r) { L.push(r.label + ' ' + (r.value == null ? '—' : r.value + (r.unit || ''))); });
    if (v.uncertainty.length) { L.push('Remaining uncertainty:'); v.uncertainty.forEach(function (u) { L.push('• ' + u); }); }
    if (v.potential && v.potential.score != null) L.push('Potential reliability: ' + v.potential.score + ' (if the unresolved evidence were resolved; not a probability)');
    return L;
  };

  return G;
});
