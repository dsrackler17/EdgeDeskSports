/*__EDDISAGREE_START__*/
/* ===========================================================================
   EdgeDesk MODEL DISAGREEMENT ENGINE — why EdgeDesk and the market differ.

   ONE FILE, TWO HOSTS (Node requires it; tools/presentation/inline.js copies
   the block into supabase/functions/edgedesk_ai/index.ts).

   A large gap between EdgeDesk's number and the no-vig market is a reason to
   investigate, never proof of value. For every disagreement this engine
   assesses each candidate cause from the evidence it is handed and says
   which ones are LIKELY, POSSIBLE, RULED_OUT or NOT_ASSESSED:

     DATA_QUALITY          a stale or faulted quote, a failed verification, a
                           cross-model outlier, a gap at the EXTREME size
     INJURY_INFORMATION    a key player's status the model does not carry
     LINEUP_ASSUMPTIONS    the starter the model priced is not the one listed
     STATISTICAL_METHODOLOGY  an unvalidated model, or a known mechanical
                           piece of it (home field, prior weight) that the
                           market prices differently
     RECENT_WEIGHTING      recent form differs from the season the model weighs
     VENUE_WEATHER         a weather hazard (totals most of all)
     MARKET_MOVEMENT       the market moved away from the model since it was set
     MODEL_UNCERTAINTY     the gap is inside the model's own uncertainty
     POTENTIAL_MISPRICING  only when the model is validated for the market,
                           data quality is ruled out, availability and lineups
                           were checked, nothing else is LIKELY and the audit
                           did not reject it — and even then it is POSSIBLE,
                           not proof

   It never assumes EdgeDesk is right. It produces no probability.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDDISAGREE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_disagreement_v1';
  var CAUSES = ['DATA_QUALITY', 'INJURY_INFORMATION', 'LINEUP_ASSUMPTIONS', 'STATISTICAL_METHODOLOGY', 'RECENT_WEIGHTING', 'VENUE_WEATHER', 'MARKET_MOVEMENT', 'MODEL_UNCERTAINTY', 'POTENTIAL_MISPRICING'];
  var LABEL = { DATA_QUALITY: 'a data-quality problem', INJURY_INFORMATION: 'injury information the model does not carry', LINEUP_ASSUMPTIONS: 'a lineup or starter assumption',
    STATISTICAL_METHODOLOGY: 'the model\'s methodology', RECENT_WEIGHTING: 'how recent form is weighted', VENUE_WEATHER: 'venue or weather', MARKET_MOVEMENT: 'market movement since the model was set',
    MODEL_UNCERTAINTY: 'the model\'s own uncertainty', POTENTIAL_MISPRICING: 'a potential mispricing' };
  var BAD_STATUS = /^(out|doubtful|ir|inactive|suspended|scratched|not starting)/i;

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r1(x) { return Math.round(x * 10) / 10; }
  function thresholds() {
    var I = root.EDINTEL, c = null; try { c = I ? (I.CONFIG || (typeof I.config === 'function' ? I.config() : null)) : null; } catch (_) { c = null; }
    return { large_points: c && num(c.disagreement_points) != null ? num(c.disagreement_points) : 3, extreme_points: c && num(c.disagreement_points_hard) != null ? num(c.disagreement_points_hard) : 7, large_pp: 0.04, extreme_pp: 0.10 };
  }

  /**
   * o.model   { available, tier ('VALIDATED'|'LEAN'|'PROBABILITY'|'RESEARCH'|null), line, probability,
   *             line_uncertainty_points, interval: {low, high}, model_version, as_of,
   *             starters: {home, away}, mechanical: {explained_points, parts:[{key, label, points}]} }
   * o.market  { line, probability (no-vig, the selection), open_line, open_probability, captured_at, stale }
   * o.others  [{ name, line, probability, validated }]
   * o.claims  researcher claims: { topic, team, player, role, key, status, reliability, speculative, in_model }
   * o.gaps    researcher model gaps: [{ kind: 'STARTER_MISMATCH'|'ABSENCE_NOT_IN_MODEL', ... }]
   * o.conflicts unresolved researcher conflicts
   * o.quality { flags: [], faults: [] }   o.weather { hazard, dome, text }   o.form { recent_vs_season_points }
   * o.audit   { status }                  o.market_type 'spreads'|'h2h'|'totals'
   */
  function diagnose(o) {
    o = o || {};
    var T = thresholds();
    var m = o.model || {}, k = o.market || {};
    var gapPts = num(m.line) != null && num(k.line) != null ? r1(num(k.line) - num(m.line)) : null;      /* + = the market gives the selection more points than the model says it needs */
    var gapPp = num(m.probability) != null && num(k.probability) != null ? Math.round((num(m.probability) - num(k.probability)) * 1000) / 1000 : null;
    var size = 'UNKNOWN';
    if (gapPts != null) size = Math.abs(gapPts) >= T.extreme_points ? 'EXTREME' : Math.abs(gapPts) >= T.large_points ? 'LARGE' : 'ORDINARY';
    else if (gapPp != null) size = Math.abs(gapPp) >= T.extreme_pp ? 'EXTREME' : Math.abs(gapPp) >= T.large_pp ? 'LARGE' : 'ORDINARY';
    var causes = {};
    function set(c, a, ev) { causes[c] = { cause: c, label: LABEL[c], assessment: a, evidence: (ev || []).filter(Boolean) }; }
    var claims = o.claims || [], gaps = o.gaps || [], q = o.quality || {};

    /* DATA_QUALITY */
    var dq = [].concat(q.flags || [], q.faults || []).map(str).filter(Boolean);
    if (k.stale) dq.push('the market quote is stale');
    if (size === 'EXTREME') dq.push('a gap of ' + (gapPts != null ? Math.abs(gapPts) + ' points' : Math.round(Math.abs(gapPp) * 100) + ' probability points') + ' is at the EXTREME size the decision layer treats as a suspected data fault');
    set('DATA_QUALITY', dq.length ? 'LIKELY' : (q.checked === false ? 'NOT_ASSESSED' : 'RULED_OUT'), dq.length ? dq : ['no stale quote, fault or outlier flag on file']);

    /* INJURY_INFORMATION */
    var avail = claims.filter(function (c) { return c.topic === 'availability'; });
    var absentNotIn = gaps.filter(function (g) { return g.kind === 'ABSENCE_NOT_IN_MODEL'; });
    var availConf = (o.conflicts || []).filter(function (c) { return c.topic === 'availability'; });
    if (absentNotIn.length) set('INJURY_INFORMATION', 'LIKELY', absentNotIn.map(function (g) { return g.detail; }));
    else if (availConf.length) set('INJURY_INFORMATION', 'POSSIBLE', availConf.map(function (c) { return 'sources disagree on ' + c.subject + ': ' + c.detail; }));
    else if (avail.length) {
      var keyBad = avail.filter(function (c) { return c.key && BAD_STATUS.test(str(c.status)); });
      set('INJURY_INFORMATION', keyBad.length ? 'POSSIBLE' : 'RULED_OUT', keyBad.length ? keyBad.map(function (c) { return c.player + ' ' + c.status + ' (' + (c.in_model ? 'in the model' : 'model treatment unknown') + ')'; }) : [avail.length + ' availability record' + (avail.length === 1 ? '' : 's') + ' read; no key player\'s status is outside the model']);
    } else set('INJURY_INFORMATION', 'NOT_ASSESSED', ['no availability source was read for this game']);

    /* LINEUP_ASSUMPTIONS */
    var mism = gaps.filter(function (g) { return g.kind === 'STARTER_MISMATCH'; });
    var startClaims = claims.filter(function (c) { return c.topic === 'starter'; });
    if (mism.length) set('LINEUP_ASSUMPTIONS', 'LIKELY', mism.map(function (g) { return g.detail; }));
    else if (startClaims.length && m.starters) set('LINEUP_ASSUMPTIONS', 'RULED_OUT', ['the starters the model priced are the ones listed']);
    else set('LINEUP_ASSUMPTIONS', 'NOT_ASSESSED', [m.starters ? 'no current starter source was read' : 'the model does not record which starters it assumed']);

    /* STATISTICAL_METHODOLOGY */
    var tier = str(m.tier).toUpperCase();
    var validated = tier === 'VALIDATED';
    var mech = m.mechanical && (m.mechanical.parts || []).slice().sort(function (a, b) { return Math.abs(num(b.points) || 0) - Math.abs(num(a.points) || 0); })[0];
    var mechShare = m.mechanical && num(m.mechanical.explained_points) != null && gapPts ? Math.abs(num(m.mechanical.explained_points)) / Math.abs(gapPts) : null;
    if (!m.available) set('STATISTICAL_METHODOLOGY', 'NOT_ASSESSED', ['no independent model for this market']);
    else if (mech && mechShare != null && mechShare >= 0.5) set('STATISTICAL_METHODOLOGY', 'LIKELY', ['most of the gap traces to ' + (mech.label || mech.key) + ' (' + r1(num(mech.points)) + ' points), a modelling choice the market weighs differently']);
    else if (!validated && (size === 'LARGE' || size === 'EXTREME')) set('STATISTICAL_METHODOLOGY', tier === 'LEAN' ? 'POSSIBLE' : 'LIKELY', ['the model is ' + (tier || 'unvalidated') + ' for this market' + (tier === 'LEAN' ? ' (break-even history, not a calibrated probability)' : ' — research only, not calibrated')]);
    else set('STATISTICAL_METHODOLOGY', validated ? 'RULED_OUT' : 'POSSIBLE', [validated ? 'the model is validated for this market' : 'the model is ' + (tier || 'unvalidated') + ' for this market']);

    /* RECENT_WEIGHTING */
    var f = o.form && num(o.form.recent_vs_season_points);
    if (f == null) set('RECENT_WEIGHTING', 'NOT_ASSESSED', ['no recent-versus-season comparison on file']);
    else set('RECENT_WEIGHTING', Math.abs(f) >= 3 ? 'POSSIBLE' : 'RULED_OUT', ['recent form differs from the season by ' + r1(f) + ' points per game']);

    /* VENUE_WEATHER */
    var w = o.weather || null;
    if (!w) set('VENUE_WEATHER', 'NOT_ASSESSED', ['no forecast on file']);
    else if (w.dome) set('VENUE_WEATHER', 'RULED_OUT', ['indoor venue']);
    else if (w.hazard) set('VENUE_WEATHER', str(o.market_type) === 'totals' ? 'LIKELY' : 'POSSIBLE', [str(w.text) || 'a weather hazard at kickoff']);
    else set('VENUE_WEATHER', 'RULED_OUT', [str(w.text) || 'no weather hazard at kickoff']);

    /* MARKET_MOVEMENT: did the market move since the open, and which way relative to the model? */
    var moved = num(k.open_line) != null && num(k.line) != null ? r1(num(k.line) - num(k.open_line)) : (num(k.open_probability) != null && num(k.probability) != null ? Math.round((num(k.probability) - num(k.open_probability)) * 1000) / 1000 : null);
    var unit = num(k.open_line) != null ? 'points' : 'pp';
    if (moved == null) set('MARKET_MOVEMENT', 'NOT_ASSESSED', ['no opening price on file']);
    else {
      var big = unit === 'points' ? Math.abs(moved) >= 1 : Math.abs(moved) >= 0.02;
      /* away from the model: the gap grew because the market moved, i.e. the market is pricing something new */
      var away = unit === 'points' ? (gapPts != null && moved !== 0 && Math.sign(moved) === Math.sign(gapPts)) : (gapPp != null && moved !== 0 && Math.sign(moved) === -Math.sign(gapPp));
      var mv = (unit === 'points' ? (moved > 0 ? '+' : '') + moved + ' points' : (moved > 0 ? '+' : '') + Math.round(moved * 1000) / 10 + ' pp') + ' since the open';
      set('MARKET_MOVEMENT', big ? (away ? 'LIKELY' : 'POSSIBLE') : 'RULED_OUT', [big ? 'the market moved ' + mv + (away ? ', away from the model: it may be pricing information the model does not have' : ', toward the model') : 'the market barely moved (' + mv + ')']);
    }

    /* MODEL_UNCERTAINTY */
    var lu = num(m.line_uncertainty_points);
    if (gapPts != null && lu != null) set('MODEL_UNCERTAINTY', Math.abs(gapPts) <= lu ? 'LIKELY' : 'RULED_OUT', ['the gap (' + Math.abs(gapPts) + ' points) is ' + (Math.abs(gapPts) <= lu ? 'inside' : 'outside') + ' the model\'s ±' + lu + '-point uncertainty']);
    else if (m.interval && num(m.interval.low) != null && num(k.probability) != null) {
      var inside = num(k.probability) >= num(m.interval.low) && num(k.probability) <= num(m.interval.high);
      set('MODEL_UNCERTAINTY', inside ? 'LIKELY' : 'RULED_OUT', ['the market\'s ' + Math.round(num(k.probability) * 1000) / 10 + '% is ' + (inside ? 'inside' : 'outside') + ' the model\'s interval']);
    } else set('MODEL_UNCERTAINTY', 'NOT_ASSESSED', ['the model publishes no uncertainty for this number']);

    /* POTENTIAL_MISPRICING — the last explanation, and only a possibility */
    var otherLikely = CAUSES.filter(function (c) { return c !== 'POTENTIAL_MISPRICING' && causes[c] && causes[c].assessment === 'LIKELY'; });
    var checked = causes.INJURY_INFORMATION.assessment !== 'NOT_ASSESSED' && causes.DATA_QUALITY.assessment === 'RULED_OUT';
    var auditOk = !o.audit || o.audit.status === 'CONFIRMED';
    var othersAgree = (o.others || []).filter(function (x) { return x.validated; });
    if (!m.available) set('POTENTIAL_MISPRICING', 'NOT_ASSESSED', ['with no independent model there is no disagreement to call a mispricing']);
    else if (k.executable === false) set('POTENTIAL_MISPRICING', 'RULED_OUT', ['the market number is a reference line with no book, odds or capture time: there is no price to be mispriced']);
    else if (otherLikely.length) set('POTENTIAL_MISPRICING', 'RULED_OUT', ['explained first by ' + otherLikely.map(function (c) { return LABEL[c]; }).join(', ')]);
    else if (!(validated || tier === 'LEAN')) set('POTENTIAL_MISPRICING', 'RULED_OUT', ['the model is not validated for this market, so its disagreement is research, not evidence of value']);
    else if (!checked) set('POTENTIAL_MISPRICING', 'NOT_ASSESSED', ['availability or data quality was not checked, so the alternatives are not ruled out']);
    else if (!auditOk) set('POTENTIAL_MISPRICING', 'RULED_OUT', ['the adversarial audit did not confirm the price (' + o.audit.status + ')']);
    else set('POTENTIAL_MISPRICING', 'POSSIBLE', ['the model is ' + (validated ? 'validated' : 'LEAN (break-even history)') + ' for this market, the data checks out and nothing else explains the gap' + (othersAgree.length ? '; ' + othersAgree.length + ' other validated model' + (othersAgree.length === 1 ? '' : 's') + ' on file' : '')]);

    var list = CAUSES.map(function (c) { return causes[c]; });
    var order = { LIKELY: 0, POSSIBLE: 1, NOT_ASSESSED: 2, RULED_OUT: 3 };
    var ranked = list.slice().sort(function (a, b) { return order[a.assessment] - order[b.assessment] || CAUSES.indexOf(a.cause) - CAUSES.indexOf(b.cause); });
    var verdict = causes.DATA_QUALITY.assessment === 'LIKELY' ? 'DATA_FAULT'
      : !m.available ? 'NO_MODEL'
      : otherLikely.length ? 'EXPLAINED'
        : causes.POTENTIAL_MISPRICING.assessment === 'POSSIBLE' ? 'POTENTIAL_MISPRICING' : 'INVESTIGATE';
    var primary = ranked[0] && ranked[0].assessment !== 'RULED_OUT' && ranked[0].assessment !== 'NOT_ASSESSED' ? ranked[0].cause : null;
    var gapText = gapPts != null ? Math.abs(gapPts) + ' points' : gapPp != null ? Math.round(Math.abs(gapPp) * 1000) / 10 + ' probability points' : 'an unmeasured amount';
    var explanation = verdict === 'NO_MODEL' ? 'EdgeDesk has no independent model for this market, so there is no model-versus-market disagreement to explain: the comparison is this price against the sharp no-vig market, and nothing more.'
      : verdict === 'DATA_FAULT' ? 'EdgeDesk and the market differ by ' + gapText + ', but the first explanation is ' + LABEL.DATA_QUALITY + ': ' + causes.DATA_QUALITY.evidence[0] + '.'
      : verdict === 'EXPLAINED' ? 'EdgeDesk and the market differ by ' + gapText + '; the likeliest reason is ' + LABEL[primary] + ': ' + causes[primary].evidence[0] + '. That explains the gap; it is not evidence of value.'
        : verdict === 'POTENTIAL_MISPRICING' ? 'EdgeDesk and the market differ by ' + gapText + ' and nothing checked explains it, so a mispricing is possible — not proven.'
          : 'EdgeDesk and the market differ by ' + gapText + '; the cause is not established (' + ranked.filter(function (c) { return c.assessment === 'NOT_ASSESSED'; }).map(function (c) { return c.label; }).slice(0, 3).join(', ') + ' not assessed). It is a question for research.';
    return { schema: VERSION, gap: { points: gapPts, probability_pp: gapPp }, size: size, causes: ranked, primary: primary, verdict: verdict, is_edge_evidence: verdict === 'POTENTIAL_MISPRICING', explanation: explanation };
  }

  return { VERSION: VERSION, CAUSES: CAUSES, LABEL: LABEL, diagnose: diagnose };
});
/*__EDDISAGREE_END__*/
