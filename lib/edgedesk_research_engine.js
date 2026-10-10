/* ===========================================================================
   EDGEDESK INDEPENDENT RESEARCH ENGINE — the football answer for one game,
   with or without a sportsbook. docs/market-resilience/README.md

   EdgeDesk is a research terminal. Its football work — the projection, the
   matchup, the explanation, the uncertainty — is built from EdgeDesk's own
   models and data, and none of it needs an odds quote. This file assembles
   that work into the six sections every game page shows, and keeps three
   questions apart that one label used to answer together:

     RESEARCH VISIBILITY   can the game be opened, analysed and published?
                           (AVAILABLE / LIMITED / UNAVAILABLE — never decided
                           by the market)
     MARKET INTEGRITY      can the captured quote be trusted?
                           (VERIFIED / UNVERIFIED / FAULT / UNAVAILABLE)
     BETTING VALIDATION    may a specific price receive a betting-related
                           decision at all? (ELIGIBLE / BLOCKED, with every
                           blocker named; ELIGIBLE only hands the price to the
                           decision engine, it never says BET)

   A large model-market disagreement is research, not an error: it is kept,
   labelled INVESTIGATE when it has not been verified, and explained by the
   sensitivity panel. It is never hidden and never promoted to an edge.

     sections:  1 EdgeDesk Projection · 2 Football Matchup Research ·
                3 Model Explanation · 4 Uncertainty and Limitations ·
                5 Market Comparison · 6 Research Verdict

   Inputs are the research terminal's per-game object (football/cfb_terminal/
   games.json → games[id], built by lib/cfb_terminal.js), a market snapshot
   from lib/edgedesk_market_state.js, and a small context. Nothing here
   computes a new projection: every number is the model's own, or a scenario
   that is labelled as one and never replaces the official fair line.

   Browser: window.EDResearchEngine. Node: require('./edgedesk_research_engine.js').
   ES5, no dependencies (uses EDMarketState / EDCanon / EDCalc when present).
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDResearchEngine = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = 'edgedesk_research_engine_v1';

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function r1(x) { return num(x) == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return num(x) == null ? null : Math.round(x * 100) / 100; }
  function r3(x) { return num(x) == null ? null : Math.round(x * 1000) / 1000; }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function ms(t) { if (t == null) return null; var x = typeof t === 'number' ? t : Date.parse(t); return isFinite(x) ? x : null; }
  function iso(t) { var x = ms(t); return x == null ? null : new Date(x).toISOString(); }
  function pct(p) { return num(p) == null ? '—' : Math.round(100 * p) + '%'; }
  function freeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); }
    return o;
  }
  function lib(name, file) {
    var G = typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null);
    var K = (G && G[name]) || null;
    if (!K && typeof require === 'function') { try { K = require(file); } catch (e) { K = null; } }
    return K;
  }
  function MS() { return lib('EDMarketState', './edgedesk_market_state.js'); }
  function Canon() { return lib('EDCanon', './edgedesk_canon.js'); }
  function Calc() { return lib('EDCalc', './edgedesk_calc.js'); }
  /* the margin convention everywhere: home points minus away points */
  function marginText(m, home, away, dp) {
    if (num(m) == null) return '—';
    var K = Calc();
    if (K && K.spread) { try { return K.spread(m, { home: home, away: away }).text; } catch (e) { /* fall through */ } }
    var v = Math.abs(m).toFixed(dp == null ? 1 : dp);
    return m === 0 ? 'Pick’em' : (m > 0 ? home + ' -' + v : away + ' -' + v);
  }
  function normCdf(z) { var t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }

  var T = {
    research_gap: 2,       /* lib/edgedesk_canon.js THRESHOLDS.research_gap */
    major_gap: 7,          /* THRESHOLDS.major_gap */
    sensitivity_gap: 4,    /* a disagreement this large gets the sensitivity panel */
    min_confidence: 35, min_reliability: 60
  };

  /* ================================================================ AXES */
  var AXES = {
    research_visibility: {
      AVAILABLE: 'The full research page opens: projection, matchup, explanation and uncertainty. The market does not decide this.',
      LIMITED: 'The page opens with the football research on file, but EdgeDesk has no usable projection for this game.',
      UNAVAILABLE: 'No projection and no football research is on file for this game.'
    },
    market_integrity: {
      VERIFIED: 'A live quote corroborated by several fresh books, with every integrity check passed.',
      UNVERIFIED: 'A quote exists but is not verified: one book, a cached or manual number, a historical line, or books that disagree.',
      FAULT: 'The captured quote failed an integrity check and is withheld from every comparison.',
      UNAVAILABLE: 'No market information to judge.'
    },
    betting_validation: {
      ELIGIBLE: 'The exact price may be evaluated by the decision engine. This is eligibility, not a recommendation.',
      BLOCKED: 'No betting-related decision may be made on this game’s price; the blockers are listed.'
    }
  };
  function axes(o, snap, dis, ctx) {
    ctx = ctx || {};
    var A = o.edgedesk || {}, conf = A.football_confidence ? num(A.football_confidence.score) : null;
    var rel = o.data_quality ? num(o.data_quality.reliability) : null;
    var hasResearch = !!((o.matchup && o.matchup.available) || (o.why && o.why.available) || o.qb);
    /* 1 — research visibility: projection and football data only */
    var rv = { key: A.available ? 'AVAILABLE' : (hasResearch ? 'LIMITED' : 'UNAVAILABLE'), caveats: [] };
    if (!A.available) rv.caveats.push(A.reason || A.unavailable_reason || 'EdgeDesk has no projection for this game.');
    if (A.available && conf != null && conf < T.min_confidence) rv.caveats.push('Football confidence ' + conf + ' is under ' + T.min_confidence + ': read the projection as low-information.');
    if (A.available && (rel == null || rel < T.min_reliability)) rv.caveats.push(rel == null ? 'Input reliability is unmeasured.' : 'Input reliability ' + rel + ' is under ' + T.min_reliability + '.');
    rv.label = rv.key; rv.means = AXES.research_visibility[rv.key];
    rv.market_independent = true;
    /* 2 — market integrity: the quote itself */
    var st = snap ? snap.state : 'UNAVAILABLE', mi;
    if (ctx.mode === 'RESEARCH_ONLY') mi = { key: 'UNAVAILABLE', reasons: ['Research-only mode: no market is read.'] };
    else if (st === 'FAULT') mi = { key: 'FAULT', reasons: [snap.reason] };
    else if (st === 'UNAVAILABLE') mi = { key: 'UNAVAILABLE', reasons: [snap.reason] };
    else if (snap.verified) mi = { key: 'VERIFIED', reasons: [snap.spread.books + ' fresh books within ' + (snap.spread.dispersion == null ? '—' : snap.spread.dispersion) + ' pts, every integrity check passed'] };
    else {
      var why = [];
      if (st === 'CACHED') why.push('cached capture (' + (snap.age_text || 'age unknown') + '): not a current price');
      if (st === 'MANUAL') why.push('manually entered number: not a verified sportsbook quote');
      if (st === 'HISTORICAL') why.push('historical capture: trusted only as line-movement context');
      if (st === 'LIVE' && snap.spread && snap.spread.available && snap.spread.books < 2) why.push('only ' + snap.spread.books + ' fresh book' + (snap.spread.books === 1 ? '' : 's') + (snap.spread.provider_consensus_only ? ' (a provider consensus, not a book)' : '') + ': not corroborated');
      if (snap.integrity && snap.integrity.warnings && snap.integrity.warnings.length) why = why.concat(snap.integrity.warnings);
      if (snap.integrity && snap.integrity.failures && snap.integrity.failures.length) why.push(snap.integrity.failures.length + ' captured quote' + (snap.integrity.failures.length === 1 ? '' : 's') + ' failed an integrity check and ' + (snap.integrity.failures.length === 1 ? 'was' : 'were') + ' excluded');
      if (!why.length) why.push('not corroborated by enough fresh books');
      mi = { key: 'UNVERIFIED', reasons: why };
    }
    mi.label = mi.key; mi.means = AXES.market_integrity[mi.key]; mi.state = st;
    /* 3 — betting validation: every blocker named, in order */
    var block = [];
    if (ctx.mode === 'RESEARCH_ONLY') block.push({ code: 'RESEARCH_ONLY', text: 'Research-only mode: no price is evaluated.' });
    if (rv.key !== 'AVAILABLE') block.push({ code: 'NO_PROJECTION', text: 'EdgeDesk has no usable projection.' });
    if (st !== 'LIVE') block.push({ code: 'MARKET_' + st, text: st === 'CACHED' ? 'The market is a cached capture (' + (snap.age_text || '') + '); an old price is never a betting opportunity.'
      : (st === 'MANUAL' ? 'A manually entered number is never a verified price.' : (st === 'HISTORICAL' ? 'Only a historical line is on file.' : (st === 'FAULT' ? 'The market failed an integrity check.' : 'No market is available.'))) });
    if (st === 'LIVE' && !snap.verified) block.push({ code: 'MARKET_UNVERIFIED', text: 'The live quote is not verified (' + mi.reasons[0] + ').' });
    if (dis && dis.key === 'INVESTIGATE') block.push({ code: 'INVESTIGATE', text: 'The disagreement is under investigation (' + dis.reason + ').' });
    var ds = o.decision_status ? o.decision_status.key : null;
    if (ds == null || ds === 'NO_DECISION') block.push({ code: 'NO_DECISION', text: 'The decision engine did not evaluate a price' + (o.decision_status && o.decision_status.reason ? ' (' + o.decision_status.reason + ')' : '') + '.' });
    if (!ctx.betting_enabled) block.push({ code: 'BETTING_DISABLED', text: 'Betting is disabled by the frozen decision policy until it passes its promotion gate.' });
    var bv = { key: block.length ? 'BLOCKED' : 'ELIGIBLE', blockers: block };
    bv.label = bv.key; bv.means = AXES.betting_validation[bv.key];
    return { research_visibility: rv, market_integrity: mi, betting_validation: bv };
  }

  /* ======================================================== DISAGREEMENT
     Measured against the comparison market only (LIVE, CACHED or MANUAL),
     with the gap the reader sees (lib/edgedesk_calc.js display rounding). */
  function regimeBlocks(A, g) {
    var C = Canon(), reg = A && A.regime, names = g ? { home: g.home, away: g.away } : null;
    if (C && C.regimeBlocks) return C.regimeBlocks(reg, names);
    var out = [];
    ['home', 'away'].forEach(function (s) { var r = reg && reg[s]; if (r && r.regime_change === true && !(num(r.games_played) >= num(r.min_games_for_research))) out.push({ team: names ? names[s] : s, side: s, games_played: r.games_played, min_games: r.min_games_for_research, reason: r.reason }); });
    return out;
  }
  /* PROJECTION UNCERTAINTY without the market: lib/cfb_terminal.js uncertainty
     minus its thin-market term, so the research priority never reads a book */
  function footballUncertainty(o) {
    var s = 0, why = [], g = o.game || {}, A = o.edgedesk || {};
    ['home', 'away'].forEach(function (k) { var q = o.qb && o.qb[k]; if (!q || q.contested) { s += 20; why.push((k === 'home' ? g.home : g.away) + ' QB ' + (q ? 'contested' : 'unknown')); } });
    if (o.consensus && o.consensus.available && num(o.consensus.sd) != null && o.consensus.sd >= 3) { s += 20; why.push('models disagree (SD ' + o.consensus.sd.toFixed(1) + ')'); }
    if (A.available && A.interval_80 && num(A.interval_80.hi) != null && (A.interval_80.hi - A.interval_80.lo) >= 42) { s += 15; why.push('wide outcome range (80% range ' + (A.interval_80.hi - A.interval_80.lo).toFixed(0) + ' pts)'); }
    if (o.games_played && num(o.games_played.min) != null && o.games_played.min < 3) { s += 15; why.push('thin current-season data'); }
    if (g.fcs) { s += 20; why.push('FCS opponent'); }
    if (o.data_quality && num(o.data_quality.reliability) != null && o.data_quality.reliability < 60) { s += 10; why.push('low reliability'); }
    var av = o.risks && o.risks.items ? o.risks.items.filter(function (r) { return /^availability_/.test(r.key || r.id || '') && /fetch failed|stale|conflicting/i.test(r.text || ''); }) : [];
    if (av.length) { s += 10; why.push('roster / availability feed problem'); }
    if (o.rating_divergence && o.rating_divergence.available && o.rating_divergence.band === 'LARGE') { s += 15; why.push('large rating-state divergence'); }
    return { score: Math.min(100, s), why: why };
  }
  function disagreement(o, snap, cmp, ctx) {
    ctx = ctx || {};
    var g = o.game || {}, A = o.edgedesk || {};
    if (ctx.mode === 'RESEARCH_ONLY') return { available: false, key: 'NONE', reason: 'research-only mode: no market comparison' };
    if (!A.available) return { available: false, key: 'NONE', reason: 'no EdgeDesk projection' };
    if (!cmp || !cmp.spread || !cmp.spread.available) return { available: false, key: 'NONE', reason: snap ? (snap.state === 'FAULT' ? 'the market failed an integrity check' : (snap.state === 'HISTORICAL' ? 'only a historical line (not compared)' : 'no market to compare with')) : 'no market' };
    var gap = cmp.spread.gap, blocks = regimeBlocks(A, g);
    var gateVerified = !!(o.disagreement && o.disagreement.verified);
    var key, reason, basis = cmp.spread.market_basis;
    if (gap >= T.major_gap) {
      if (snap.state === 'LIVE' && snap.verified && gateVerified && !blocks.length) { key = 'VERIFIED_MAJOR'; reason = 'a ' + gap.toFixed(1) + '-point gap that passed every integrity check (still not a bet)'; }
      else {
        key = 'INVESTIGATE';
        reason = 'a ' + gap.toFixed(1) + '-point gap that has not been verified' + (!snap.verified ? ' (the market is ' + (snap.state === 'LIVE' ? 'not corroborated' : snap.state.toLowerCase()) + ')' : '')
          + (!gateVerified && snap.state === 'LIVE' && snap.verified ? ' (the integrity gate has not passed it)' : '')
          + (blocks.length ? '; ' + regimeShort(blocks) : '');
      }
    } else if (gap >= T.research_gap) {
      if (blocks.length) { key = 'INVESTIGATE'; reason = regimeShort(blocks) + ': the long-run rating describes a programme that turned over'; }
      else { key = 'RESEARCH'; reason = 'a ' + gap.toFixed(1) + '-point disagreement worth researching' + (basis !== 'LIVE' ? ' (against a ' + String(basis).toLowerCase() + ' line)' : ''); }
    } else { key = 'ALIGNED'; reason = 'EdgeDesk and the market are ' + gap.toFixed(1) + ' pts apart, inside the ' + T.research_gap + '-point research threshold'; }
    return { available: true, key: key, label: key === 'VERIFIED_MAJOR' ? 'VERIFIED MAJOR DISAGREEMENT' : key, points: gap, points_exact: cmp.spread.gap_exact,
      toward_team: cmp.spread.toward_team, model_text: cmp.spread.model_text, market_text: cmp.spread.market_text, market_basis: basis,
      favorite_differs: cmp.spread.favorite_differs, formula: cmp.spread.formula, reason: reason, regime: blocks,
      verified: key === 'VERIFIED_MAJOR', not_a_bet: true };
  }
  function regimeShort(blocks) {
    return 'REGIME CHANGE — ' + blocks.map(function (b) { return (b.team || 'a team') + ' (' + (b.reason || 'new head coach and roster turnover') + '; ' + (b.games_played == null ? '?' : b.games_played) + ' of ' + (b.min_games == null ? '?' : b.min_games) + ' games needed)'; }).join('; ');
  }

  /* ========================================================= SENSITIVITY
     For a significant disagreement: does it survive reasonable alternative
     assumptions? Every row says whether it is SUPPORTED (a validated
     component of the model, applied as the model applies it) or HYPOTHETICAL
     (outside what has been validated). No row changes the official fair line.

     ctx.carryover (from the build, out of the slate's own rating_detail):
       { home:{carried, this_season, weight, standard_weight, games_played, regime},
         away:{…}, curve_floor, rating_term, reconstructed } */
  function blendDelta(side, w2) {
    if (!side || num(side.carried) == null || num(side.this_season) == null || num(side.weight) == null) return null;
    return (w2 - side.weight) * (side.carried - side.this_season);
  }
  function sensitivity(o, snap, cmp, dis, ctx) {
    ctx = ctx || {};
    var A = o.edgedesk || {}, g = o.game || {};
    if (!A.available) return { available: false, reason: 'no EdgeDesk projection' };
    var base = num(A.home_margin), mkt = cmp && cmp.spread && cmp.spread.available ? -cmp.spread.market_home_line : null;
    var significant = dis && dis.available && dis.points >= T.sensitivity_gap;
    var rows = [];
    function row(group, key, label, margin, status, basis, extra) {
      var r = { group: group, key: key, label: label, home_margin: r2(margin), fair_text: marginText(margin, g.home, g.away, 1),
        change: r2(margin - base), status: status, basis: basis, official: false };
      if (mkt != null) { var K = Calc(); var c = K ? K.spreadComparison({ model_home_margin: margin, market_home_margin: mkt }) : null;
        r.gap = c ? c.gap : r2(Math.abs(margin - mkt)); r.toward_team = c ? c.toward_team : null; r.same_side = c ? c.toward === (dis && dis.toward_team === g.home ? 'home' : 'away') : null; }
      if (extra) for (var k in extra) if (has(extra, k)) r[k] = extra[k];
      rows.push(r); return r;
    }
    row('base', 'base', 'Base projection (the official fair line)', base, 'OFFICIAL', A.model_version + ' · published ' + (A.prediction_ts || '—'), { official: true });

    /* current-season emphasis: the learned prior-weight curve, advanced to its own floor */
    var co = ctx.carryover || null, carry = { available: false };
    if (co && co.home && co.away) {
      var floor = num(co.curve_floor) != null ? co.curve_floor : 0.6;
      var dh = blendDelta(co.home, Math.min(floor, co.home.weight)), da = blendDelta(co.away, Math.min(floor, co.away.weight));
      var exact = co.reconstructed != null && co.rating_term != null && Math.abs(co.reconstructed - co.rating_term) <= 0.25;
      carry = { available: true, home: shareOf(co.home, g.home), away: shareOf(co.away, g.away), curve_floor: floor, reconstructs: exact,
        text: [shareOf(co.home, g.home).text, shareOf(co.away, g.away).text].join(' ') };
      if (dh != null && da != null && (Math.abs(dh) > 1e-9 || Math.abs(da) > 1e-9))
        row('current_season', 'curve_floor', 'Current-season emphasis: both prior-season weights at the learned curve’s floor (' + Math.round(100 * floor) + '%)', base + dh - da,
          exact ? 'SUPPORTED' : 'HYPOTHETICAL', 'the engine’s own blend (w·carried + (1−w)·this season) re-weighted inside the validated prior-weight curve (football/cfb_p4/params.js blend.prior_weight_by_week), this season’s ratings held where they are'
            + (exact ? '' : '; the published components do not reconstruct the rating term within 0.25 pts, so this is an approximation'));
      var dh0 = blendDelta(co.home, 0), da0 = blendDelta(co.away, 0);
      if (dh0 != null && da0 != null)
        row('current_season', 'this_season_only', 'This season only: no prior-season carryover at all', base + dh0 - da0, 'HYPOTHETICAL',
          'outside the validated curve (its floor is ' + Math.round(100 * floor) + '%): the engine has never priced a team on this season alone');
      /* roster adjustment: the regime curve's cut, shown by removing it */
      ['home', 'away'].forEach(function (s) {
        var sd = co[s];
        if (!sd || !sd.regime || num(sd.standard_weight) == null || num(sd.weight) == null || Math.abs(sd.standard_weight - sd.weight) < 1e-6) return;
        var d = blendDelta(sd, sd.standard_weight);
        if (d == null) return;
        var team = s === 'home' ? g.home : g.away;
        row('roster', 'no_regime_' + s, 'Roster adjustment removed: ' + team + ' at the standard prior weight (' + Math.round(100 * sd.standard_weight) + '% instead of ' + Math.round(100 * sd.weight) + '%)',
          base + (s === 'home' ? d : -d), 'SUPPORTED', 'the regime curve (cfb_regime_curve_v1) is the model’s validated turnover adjustment; this row shows how much of the number it moves (' + (sd.regime_reason || 'roster turnover') + ')');
      });
    }
    /* the explainer's turnover term, at the close's historical discount (descriptive fit) */
    var X = o.disagreement_explainer;
    if (X && X.available && X.parts) X.parts.forEach(function (p) {
      if (p.key !== 'turnover' || num(p.term_points) == null || num(p.discount) == null || Math.abs(p.term_points) < 0.25) return;
      row('roster', 'turnover_discount', 'Turnover share discounted as the closing market historically has (' + Math.round(100 * p.discount) + '% of ' + Math.abs(p.term_points).toFixed(1) + ' pts)',
        base - p.discount * p.term_points, 'HYPOTHETICAL', 'the disagreement explainer’s descriptive fit (' + (X.caveat || 'it explains, it never prices') + ')');
    });
    /* availability: the terminal's measured QB rows and its variance-only rows */
    var SE = o.sensitivity;
    if (SE && SE.available) SE.rows.forEach(function (r) {
      if (r.kind === 'qb') row('availability', r.key, r.label, r.home_margin, 'SUPPORTED', r.basis);
      else if (r.kind === 'mean') row('ratings', r.key, r.label, r.home_margin, 'SUPPORTED', r.basis);
    });
    var variance = SE && SE.available ? SE.rows.filter(function (r) { return r.kind === 'variance'; }).map(function (r) { return { label: r.label, sigma_delta: r.sigma_delta, basis: r.basis }; }) : [];
    /* the independent submodels: alternative reasonable model assumptions */
    var K2 = o.consensus;
    if (K2 && K2.available) K2.rows.forEach(function (r) {
      if (r.key === 'v1' || num(r.home_margin) == null) return;
      row('models', 'model_' + r.key, r.label, r.home_margin, 'MODEL', (r.family || '') + (r.independent ? ' · independent' : ' · not independent') + (r.role ? ' · ' + r.role : ''));
    });

    /* uncertainty range */
    var sigma = num(A.sigma), q = A.quantiles || {};
    var range = { interval_80: A.interval_80 || null, quantiles: q, sigma: sigma, typical_miss: o.reconcile && o.reconcile.baseline ? o.reconcile.baseline.typical_miss : null };
    if (mkt != null && sigma != null && base != null) {
      var z = (mkt - base) / sigma;
      range.market_percentile = r3(normCdf(z));
      range.market_text = 'The market’s number (' + marginText(mkt, g.home, g.away, 1) + ') sits at about the ' + Math.round(100 * normCdf(z)) + 'th percentile of EdgeDesk’s margin distribution (normal approximation, σ ' + sigma.toFixed(1) + '): '
        + (Math.abs(z) < 1.28 ? 'inside the model’s 80% range.' : 'outside the model’s 80% range.');
    }
    /* persistence: does the disagreement survive every SUPPORTED/MODEL alternative? */
    var persists = null;
    if (mkt != null && dis && dis.available) {
      var alt = rows.filter(function (r) { return r.status === 'SUPPORTED' || r.status === 'MODEL'; });
      var narrow = alt.filter(function (r) { return r.gap != null && r.gap < T.research_gap; });
      var flipped = alt.filter(function (r) { return r.same_side === false && r.gap >= T.research_gap; });
      var minGap = alt.length ? Math.min.apply(null, alt.map(function (r) { return r.gap == null ? Infinity : r.gap; })) : null;
      persists = { key: narrow.length || flipped.length ? 'SENSITIVE' : 'PERSISTS', alternatives: alt.length, min_gap: minGap === Infinity ? null : r1(minGap),
        closes_under: narrow.map(function (r) { return r.label; }), reverses_under: flipped.map(function (r) { return r.label; }) };
      persists.text = persists.key === 'PERSISTS'
        ? 'The disagreement persists under all ' + alt.length + ' supported alternatives and independent models (smallest remaining gap ' + (persists.min_gap == null ? '—' : persists.min_gap.toFixed(1)) + ' pts).'
        : 'The disagreement narrows below ' + T.research_gap + ' pts under: ' + persists.closes_under.concat(persists.reverses_under).join('; ') + '.';
      var hypo = rows.filter(function (r) { return r.status === 'HYPOTHETICAL' && r.gap != null; });
      if (hypo.length) persists.hypothetical_text = 'Hypothetical rows (not validated): ' + hypo.map(function (r) { return r.label + ' → ' + r.fair_text + ' (gap ' + r.gap.toFixed(1) + ')'; }).join('; ') + '.';
    }
    return { available: true, significant: !!significant, base: { home_margin: base, fair_text: A.fair_text, model_version: A.model_version },
      market: mkt == null ? null : { home_margin: mkt, text: marginText(mkt, g.home, g.away, 1), basis: cmp.spread.market_basis },
      carryover: carry, rows: rows, variance_only: variance, range: range, persistence: persists,
      reconcile: o.reconcile && o.reconcile.available ? o.reconcile.rows.map(function (r) { return { text: r.text, points_needed: r.points_needed, sds_needed: r.sds_needed, covers_share: r.covers_share, source: r.source }; }) : [],
      reconcile_note: o.reconcile && o.reconcile.available ? o.reconcile.note : null,
      rule: 'No scenario changes the official fair line. SUPPORTED rows apply a validated model component as the model applies it; HYPOTHETICAL rows are outside what has been validated; MODEL rows are EdgeDesk’s other models.' };
  }
  function shareOf(side, team) {
    if (!side || num(side.weight) == null) return { team: team, weight: null, text: team + ': prior-season share not reported.' };
    var w = side.weight;
    return { team: team, weight: r3(w), standard_weight: num(side.standard_weight) != null ? r3(side.standard_weight) : null, games_played: side.games_played,
      carried: r2(side.carried), this_season: r2(side.this_season),
      text: team + ': ' + Math.round(100 * w) + '% of the rating is carried from prior seasons at ' + (side.games_played == null ? '?' : side.games_played) + ' games played'
        + (side.regime ? ' (cut from ' + Math.round(100 * side.standard_weight) + '% by the regime curve)' : '')
        + (num(side.carried) != null && num(side.this_season) != null ? '; carried ' + side.carried.toFixed(1) + ' vs this season ' + side.this_season.toFixed(1) + '.' : '.') };
  }

  /* ================================================== RESEARCH PRIORITY
     How much there is to investigate in a game, from EdgeDesk's own data
     only. It never reads a sportsbook number and it is never a ranking of
     bets: a coin-flip game with contested quarterbacks ranks high because
     there is a lot to learn, not because there is a price. */
  var PRIORITY_KEYS = ['uncertainty', 'mismatch', 'rating_divergence', 'roster_turnover', 'injury', 'stability', 'game_script', 'relevance'];
  var PRIORITY_LABEL = { uncertainty: 'Projection uncertainty', mismatch: 'Position-group mismatch', rating_divergence: 'Unusual power-rating difference',
    roster_turnover: 'Roster turnover', injury: 'Injury / availability uncertainty', stability: 'Model stability', game_script: 'Game script', relevance: 'Research relevance' };
  var PRIORITY_W = { uncertainty: 0.18, mismatch: 0.16, rating_divergence: 0.10, roster_turnover: 0.14, injury: 0.12, stability: 0.10, game_script: 0.10, relevance: 0.10 };
  function researchPriority(o) {
    var A = o.edgedesk || {}, g = o.game || {}, c = {}, why = {};
    var U = footballUncertainty(o);
    c.uncertainty = clamp(U.score / 60, 0, 1);
    why.uncertainty = (U.why && U.why.length ? U.why.join(', ') : 'no flagged uncertainty');
    var cards = (o.matchup && o.matchup.cards) || [];
    var best = null;
    cards.forEach(function (k) { var v = Math.abs(num(k.net_sd) || 0) * (k.confidence === 'LOW' ? 0.5 : 1); if (!best || v > best.v) best = { v: v, card: k }; });
    c.mismatch = best ? clamp(best.v / 0.8, 0, 1) : 0;
    why.mismatch = best && best.card.favors ? best.card.label + ' favours ' + best.card.favors + ' (' + Math.abs(best.card.net_sd).toFixed(2) + ' SD)' : 'no measured unit mismatch';
    var RD = o.rating_divergence;
    c.rating_divergence = RD && RD.available ? (RD.band === 'LARGE' ? 1 : (RD.band === 'ELEVATED' ? 0.6 : clamp(Math.abs(RD.divergence) / 4, 0, 0.5))) : 0;
    why.rating_divergence = RD && RD.available ? RD.text : 'not supplied';
    var blocks = regimeBlocks(A, g), reg = A.regime || {};
    var turnoverFlag = ((o.risks && o.risks.items) || []).some(function (r) { return /turnover/i.test(r.text || ''); });
    c.roster_turnover = (reg.home && reg.home.regime_change) || (reg.away && reg.away.regime_change) ? 1 : (turnoverFlag ? 0.5 : 0);
    why.roster_turnover = c.roster_turnover === 1 ? ['home', 'away'].filter(function (s) { return reg[s] && reg[s].regime_change; }).map(function (s) { return (s === 'home' ? g.home : g.away) + ': ' + reg[s].reason; }).join('; ')
      : (turnoverFlag ? 'V2.1 flags turnover-dependent teams' : 'no regime change flagged');
    if (blocks.length) why.roster_turnover += ' (research gate: ' + blocks.length + ' team' + (blocks.length === 1 ? '' : 's') + ' under the games-played minimum)';
    var qb = o.qb || {}, inj = 0, injWhy = [];
    ['home', 'away'].forEach(function (s) { var q = qb[s]; if (!q || q.contested) { inj += 0.5; injWhy.push((s === 'home' ? g.home : g.away) + ' QB ' + (q ? 'contested' : 'unknown')); }
      else if (q.status && /QUESTIONABLE|DOUBTFUL|OUT/i.test(q.status)) { inj += 0.5; injWhy.push((s === 'home' ? g.home : g.away) + ' QB ' + String(q.status).toLowerCase()); } });
    var dq = o.data_quality || {}, av = (dq.rows || []).filter(function (r) { return r.key === 'availability'; })[0];
    if (av && num(av.value) != null && av.value < 90) { inj += 0.3; injWhy.push('availability known for ' + av.value + '% of projected starters'); }
    if (dq.main_deduction && /UNKNOWN impact|critical or major/i.test(dq.main_deduction)) { inj += 0.3; injWhy.push('absences with unmeasured impact'); }
    c.injury = clamp(inj, 0, 1); why.injury = injWhy.length ? injWhy.join('; ') : 'no availability uncertainty flagged';
    var K2 = o.consensus;
    c.stability = K2 && K2.available && num(K2.sd) != null ? clamp(K2.sd / 4, 0, 1) : 0;
    why.stability = K2 && K2.available && num(K2.sd) != null ? 'EdgeDesk’s independent models differ by SD ' + K2.sd.toFixed(1) + ' pts (' + (K2.agreement ? K2.agreement.tier.toLowerCase() : '—') + ' agreement)' : 'model agreement not measured';
    var m = num(A.home_margin), tot = num(A.fair_total), gs = 0, gw = [];
    if (m != null) { if (Math.abs(m) < 3) { gs += 0.8; gw.push('a projected one-possession game (' + Math.abs(m).toFixed(1) + ' pts)'); } else if (Math.abs(m) < 7) { gs += 0.4; gw.push('a projected one-score game'); } }
    if (tot != null && (tot >= 62 || tot <= 42)) { gs += 0.3; gw.push(tot >= 62 ? 'a high-scoring script (fair total ' + tot + ')' : 'a low-scoring script (fair total ' + tot + ')'); }
    c.game_script = clamp(gs, 0, 1); why.game_script = gw.length ? gw.join('; ') : 'no distinctive script';
    var conf = A.football_confidence ? num(A.football_confidence.score) : null, rel = 0;
    if (g.matchup_type === 'conference') rel += 0.4;
    if (conf != null) rel += 0.4 * clamp(conf / 100, 0, 1);
    if (o.week_scope !== 'FUTURE_WEEK') rel += 0.2;
    c.relevance = clamp(rel, 0, 1); why.relevance = (g.matchup_type === 'conference' ? 'conference game' : (g.matchup_type || 'non-conference')) + (conf != null ? ', football confidence ' + conf : '') + (o.week_scope === 'FUTURE_WEEK' ? ', look-ahead week' : ', this week');
    var score = 0; PRIORITY_KEYS.forEach(function (k) { score += PRIORITY_W[k] * c[k]; });
    if (!A.available) score *= 0.4;
    var top = PRIORITY_KEYS.slice().sort(function (a, b) { return PRIORITY_W[b] * c[b] - PRIORITY_W[a] * c[a]; }).filter(function (k) { return c[k] > 0; }).slice(0, 3);
    return { score: Math.round(100 * score), components: (function () { var x = {}; PRIORITY_KEYS.forEach(function (k) { x[k] = r2(c[k]); }); return x; })(),
      reasons: top.map(function (k) { return { key: k, label: PRIORITY_LABEL[k], text: why[k] }; }), detail: why,
      basis: '100 × Σ weight × component over ' + PRIORITY_KEYS.map(function (k) { return PRIORITY_LABEL[k].toLowerCase() + ' ' + PRIORITY_W[k]; }).join(', '),
      market_independent: true, note: 'Model-only research priority: how much there is to investigate. It reads no sportsbook number and is not a ranking of bets.' };
  }

  /* ============================================================ SECTIONS */
  function outcomeBands(m, sigma, home, away) {
    if (num(m) == null || num(sigma) == null || sigma <= 0) return [];
    var P = function (x) { return normCdf((x - m) / sigma); };
    var bands = [
      { key: 'home_big', label: home + ' by 14+', p: 1 - P(13.5) },
      { key: 'home_mid', label: home + ' by 7–13', p: P(13.5) - P(6.5) },
      { key: 'one_score', label: 'One-score game (either side by 6 or fewer)', p: P(6.5) - P(-6.5) },
      { key: 'away_mid', label: away + ' by 7–13', p: P(-6.5) - P(-13.5) },
      { key: 'away_big', label: away + ' by 14+', p: P(-13.5) }
    ];
    return bands.map(function (b) { b.p = r3(b.p); return b; });
  }
  function gameScripts(o) {
    var A = o.edgedesk || {}, g = o.game || {}, m = num(A.home_margin), s = num(A.sigma), out = [];
    if (m == null || s == null) return out;
    var fav = m >= 0 ? g.home : g.away, dog = m >= 0 ? g.away : g.home, am = Math.abs(m);
    var pFav = m >= 0 ? A.home_win_prob : A.away_win_prob;
    var cards = ((o.matchup && o.matchup.cards) || []).filter(function (c) { return c.favors; });
    var edges = function (team) { return cards.filter(function (c) { return c.favors === team; }).map(function (c) { return c.label.toLowerCase(); }); };
    out.push({ key: 'expected', label: 'Expected script', prob: null,
      text: fav + ' by about ' + am.toFixed(1) + (num(A.fair_total) != null ? ' in a game totalling about ' + A.fair_total : '') + (edges(fav).length ? ', leaning on ' + edges(fav).join(', ') : '') + '.' });
    out.push({ key: 'favorite_controls', label: fav + ' controls', prob: r3(1 - normCdf((13.5 - am) / s)), text: fav + ' wins by two scores or more.' });
    out.push({ key: 'one_score', label: 'One-score finish', prob: r3(normCdf((6.5 - m) / s) - normCdf((-6.5 - m) / s)), text: 'Either side within a score late.' });
    out.push({ key: 'underdog_wins', label: dog + ' wins outright', prob: num(pFav) != null ? r3(1 - pFav) : null,
      text: dog + ' wins' + (edges(dog).length ? ', most plausibly through ' + edges(dog).join(', ') : '') + '.' });
    return out;
  }
  function stripMarketRows(rows) { return (rows || []).filter(function (r) { return r.key !== 'market'; }); }
  function sections(o, snap, cmp, dis, sens, ax, ctx) {
    ctx = ctx || {};
    var A = o.edgedesk || {}, g = o.game || {};
    /* 1 · EdgeDesk Projection */
    var proj = A.available ? {
      available: true, fair_text: A.fair_text, home_margin: A.home_margin, fair_home_line: A.fair_home_line,
      projected_score: A.projected_score || null, fair_total: num(A.fair_total), win_prob: { home: A.home_win_prob, away: A.away_win_prob, favorite: A.favorite || null },
      interval_80: A.interval_80 || null, quantiles: A.quantiles || null, sigma: A.sigma, sigma_basis: A.sigma_basis || null,
      outcome_bands: outcomeBands(A.home_margin, A.sigma, g.home, g.away), outcome_basis: 'normal approximation to EdgeDesk’s margin distribution (σ ' + (num(A.sigma) == null ? '—' : A.sigma.toFixed(1)) + ')',
      power: { team_strength: (o.why && o.why.rows || []).filter(function (r) { return r.key === 'rating'; }).map(function (r) { return { text: r.text, label: r.label, points: r.points }; })[0] || null,
        rating_divergence: o.rating_divergence && o.rating_divergence.available ? { current_gap: o.rating_divergence.current_gap, state_gap: o.rating_divergence.state_gap, band: o.rating_divergence.band, text: o.rating_divergence.text } : null },
      football_confidence: A.football_confidence || null, reliability: o.data_quality ? o.data_quality.reliability : null,
      model_version: A.model_version, prediction_ts: A.prediction_ts, source: A.source || null,
      requires_market: false
    } : { available: false, reason: A.reason || A.unavailable_reason || 'EdgeDesk has no projection for this game.', requires_market: false };
    /* 2 · Football Matchup Research */
    var reg = A.regime || {};
    var matchup = {
      cards: o.matchup && o.matchup.available ? o.matchup.cards : [], not_measured: o.matchup ? o.matchup.not_measured || [] : [], basis: o.matchup ? o.matchup.basis || null : null,
      qb: o.qb || null,
      availability: (function () { var dq = o.data_quality || {}; var av = (dq.rows || []).filter(function (r) { return r.key === 'availability' || r.key === 'qb' || r.key === 'player_quality'; });
        return { rows: av, main_deduction: dq.main_deduction || null, risks: ((o.risks && o.risks.items) || []).filter(function (r) { return /^qb_|^availability_|injur/i.test(r.key || ''); }) }; })(),
      roster_continuity: ['home', 'away'].map(function (s) { var r = reg[s]; var team = s === 'home' ? g.home : g.away;
        return r && r.regime_change ? { team: team, regime_change: true, reason: r.reason, games_played: r.games_played, min_games: r.min_games_for_research, prior_weight: r.weight, standard_weight: r.standard_weight, text: r.why || r.reason }
          : { team: team, regime_change: false, text: team + ': no regime change flagged (no new head coach with extreme roster turnover on file).' }; }),
      coaching: ['home', 'away'].map(function (s) { var r = reg[s]; var team = s === 'home' ? g.home : g.away;
        return { team: team, change: !!(r && r.regime_change && /head coach/i.test(r.reason || '')), text: r && /head coach/i.test(r.reason || '') ? team + ': new head coach this season (the model cuts its long-run weight with the validated regime curve).' : team + ': no head-coaching change on file.' }; }),
      schedule: (o.why && o.why.rows || []).filter(function (r) { return r.key === 'rating' || r.key === 'schedule'; }).map(function (r) { return { label: r.label, text: r.text }; }),
      schedule_note: 'Team strength is opponent-adjusted: every result is read against the quality of the opponent that produced it.',
      historical: o.historical || null,
      game_scripts: gameScripts(o),
      requires_market: false
    };
    /* 3 · Model Explanation */
    var W = o.why || {};
    var explanation = {
      drivers: W.available ? W.rows : [], raw_margin: W.raw_margin, reconciles: W.reconciles, basis: W.basis || null,
      v2_drivers: W.v2_drivers || null, unpriced: W.unpriced || [], calibration: W.calibration || null,
      models: o.consensus && o.consensus.available ? { rows: o.consensus.rows.map(function (r) { return { key: r.key, label: r.label, family: r.family, role: r.role, independent: r.independent, home_margin: r.home_margin, text: r.text }; }),
        sd: o.consensus.sd, agreement: o.consensus.agreement, why_disagree: o.consensus.why_disagree || [] } : null,
      prior_season: sens && sens.carryover && sens.carryover.available ? sens.carryover : null,
      explainer: o.disagreement_explainer && o.disagreement_explainer.available ? { parts: o.disagreement_explainer.parts, caveat: o.disagreement_explainer.caveat } : null,
      pricing_inputs: o.pricing_inputs || null, requires_market: false
    };
    /* 4 · Uncertainty and Limitations */
    var wrong = [];
    if (o.reconcile && o.reconcile.baseline && o.reconcile.baseline.typical_miss != null) wrong.push('EdgeDesk’s typical miss on a game like this is ' + o.reconcile.baseline.typical_miss.toFixed(1) + ' pts.');
    else if (A.interval_80) wrong.push('EdgeDesk’s 80% range is ' + A.interval_80.text + '.');
    ['home', 'away'].forEach(function (s) { var r = reg[s]; if (r && r.regime_change) wrong.push((s === 'home' ? g.home : g.away) + ': ' + r.reason + ' — the long-run rating may describe a programme that no longer exists.'); });
    (W.unpriced || []).forEach(function (u) { wrong.push(u + ' is shown but not priced.'); });
    ((o.risks && o.risks.items) || []).forEach(function (r) { if (r.key !== 'model_uncertainty') wrong.push(r.text); });
    if (o.consensus && o.consensus.available && o.consensus.sd >= 1.5) wrong.push('EdgeDesk’s own models disagree (SD ' + o.consensus.sd.toFixed(1) + ' pts).');
    if (o.games_played && num(o.games_played.min) != null && o.games_played.min < 4) wrong.push('Only ' + o.games_played.min + ' games of current-season data for the thinner side.');
    var dq = o.data_quality || {};
    var uncertainty = {
      score: footballUncertainty(o).score, why: footballUncertainty(o).why,
      reasons_could_be_wrong: wrong, football_confidence: A.football_confidence || null,
      data_completeness: { reliability: dq.reliability, grade: dq.grade, main_deduction: dq.main_deduction, rows: stripMarketRows(dq.rows), separate: dq.separate || null },
      caveats: ax.research_visibility.caveats, requires_market: false
    };
    /* 5 · Market Comparison */
    var M = MS();
    var market = {
      state: ctx.mode === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : (snap ? snap.state : 'UNAVAILABLE'),
      label: ctx.mode === 'RESEARCH_ONLY' ? 'RESEARCH ONLY' : (snap ? snap.label : 'MARKET UNAVAILABLE'),
      basis_label: ctx.mode === 'RESEARCH_ONLY' ? 'Research-only mode: market comparison is switched off' : (M ? M.basisLabel(snap) : '—'),
      reason: ctx.mode === 'RESEARCH_ONLY' ? 'No live odds connection is required or read in research-only mode.' : (snap ? snap.reason : 'no market snapshot'),
      captured_at: snap && ctx.mode !== 'RESEARCH_ONLY' ? snap.captured_at : null, age_text: snap && ctx.mode !== 'RESEARCH_ONLY' ? snap.age_text : null,
      sources: snap && ctx.mode !== 'RESEARCH_ONLY' ? snap.sources : [], provider: snap ? snap.provider : null,
      spread: ctx.mode === 'RESEARCH_ONLY' ? null : (cmp ? cmp.spread : null), total: ctx.mode === 'RESEARCH_ONLY' ? null : (cmp ? cmp.total : null),
      no_vig: ctx.mode === 'RESEARCH_ONLY' ? null : (cmp ? cmp.no_vig : null), break_even: ctx.mode === 'RESEARCH_ONLY' ? null : (cmp ? cmp.break_even : null),
      unavailable: ctx.mode === 'RESEARCH_ONLY' ? [{ key: 'all', reason: 'Unavailable: research-only mode' }] : (cmp ? cmp.unavailable : []),
      integrity: snap ? { status: snap.integrity.status, failures: snap.integrity.failures, held: snap.integrity.held, warnings: snap.integrity.warnings, references: snap.integrity.references, duplicates_merged: snap.integrity.duplicates_merged } : null,
      agreement: dis && dis.available ? { key: dis.key, text: dis.key === 'ALIGNED' ? 'EdgeDesk and the market agree within ' + T.research_gap + ' pts.' : dis.points.toFixed(1) + ' pts toward ' + dis.toward_team + ' (' + dis.key + ')' } : null,
      decision: ctx.mode === 'RESEARCH_ONLY' || !snap || snap.state !== 'LIVE' ? { shown: false, text: 'Price-specific decisions need a live, checked quote: Unavailable.' }
        : { shown: true, key: o.decision_status ? o.decision_status.key : null, text: o.decision_status ? o.decision_status.label + ': ' + (o.decision_status.reason || o.decision_status.means || '') : '—' },
      requires_market: true
    };
    return { projection: proj, matchup: matchup, explanation: explanation, uncertainty: uncertainty, market: market };
  }

  /* ============================================================= VERDICT */
  function verdict(o, snap, cmp, dis, sens, ax, ctx) {
    ctx = ctx || {};
    var A = o.edgedesk || {}, g = o.game || {};
    if (!A.available) return { key: 'RESEARCH_LIMITED', tone: 'quiet', headline: 'RESEARCH LIMITED — NO PROJECTION',
      text: 'EdgeDesk has no usable projection for ' + g.away + ' @ ' + g.home + ' (' + (A.reason || A.unavailable_reason || 'not projected') + '). The football research on file remains accessible.', not_a_bet: true };
    var proj = 'EdgeDesk projects ' + A.fair_text + '.';
    if (ctx.mode === 'RESEARCH_ONLY') return { key: 'RESEARCH_ONLY', tone: 'research', headline: 'RESEARCH ONLY',
      text: proj + ' Market comparison is switched off; independent football analysis remains fully accessible.', not_a_bet: true };
    var st = snap ? snap.state : 'UNAVAILABLE';
    if (st === 'UNAVAILABLE') return { key: snap && snap.provider && snap.provider.down ? 'MARKET_OFFLINE' : 'MARKET_UNAVAILABLE', tone: 'quiet',
      headline: snap && snap.provider && snap.provider.down ? 'RESEARCH AVAILABLE — MARKET OFFLINE' : 'RESEARCH AVAILABLE — MARKET UNAVAILABLE',
      text: proj + ' No verified current sportsbook market is available' + (snap && snap.provider && snap.provider.down ? ' (' + snap.provider.text.replace(/\.$/, '') + ')' : '') + '. Independent football analysis remains accessible.', not_a_bet: true };
    if (st === 'FAULT') return { key: 'MARKET_FAULT', tone: 'fault', headline: 'RESEARCH AVAILABLE — MARKET FAULT',
      text: proj + ' The captured market failed an integrity check (' + snap.reason + ') and is withheld from every comparison. Independent football analysis remains accessible.', not_a_bet: true };
    if (st === 'HISTORICAL') return { key: 'NO_CURRENT_MARKET', tone: 'quiet', headline: 'RESEARCH AVAILABLE — NO CURRENT MARKET',
      text: proj + ' Only a historical line is on file (' + (snap.age_text || '') + '); it is kept for line-movement context and is not a current price.', not_a_bet: true };
    var lbl = st === 'LIVE' ? 'market' : (st === 'CACHED' ? 'captured market' : 'manually entered market');
    if (!dis || !dis.available) return { key: 'RESEARCH_AVAILABLE', tone: 'research', headline: 'RESEARCH AVAILABLE',
      text: proj + ' ' + (dis ? 'No spread comparison: ' + dis.reason + '.' : ''), not_a_bet: true };
    var mkt = cmp.spread.market_text.replace(/^.*?(-|\+)/, '$1');
    var vs = proj.replace(/\.$/, '') + ' against a ' + lbl + ' of ' + (cmp.spread.market_text.indexOf(A.favorite || '\u0000') === 0 ? mkt : cmp.spread.market_text) + (st === 'CACHED' ? ' (captured ' + snap.age_text + ', not a current price)' : (st === 'MANUAL' ? ' (entered by hand)' : '')) + '.';
    var noEdge = ' No validated betting edge has been established.';
    if (dis.key === 'INVESTIGATE') {
      var cav;
      if (dis.regime && dis.regime.length) cav = 'Major roster turnover (' + dis.regime.map(function (b) { return b.team + ': ' + (b.reason || 'regime change'); }).join('; ') + ') limits confidence in the discrepancy.';
      else if (st !== 'LIVE') cav = 'The market number is ' + (st === 'CACHED' ? 'a cached capture' : 'a manual entry') + ', so the discrepancy cannot be verified.';
      else if (!snap.verified) cav = 'The market quote is not corroborated by enough fresh books, so the discrepancy is unverified.';
      else cav = 'The discrepancy has not passed the integrity gate.';
      var per = sens && sens.persistence ? ' ' + sens.persistence.text : '';
      return { key: 'INVESTIGATE', tone: 'investigate', headline: 'INVESTIGATE — ' + dis.points.toFixed(1) + '-POINT DISAGREEMENT', text: vs + ' ' + cav + per + noEdge, not_a_bet: true };
    }
    if (dis.key === 'VERIFIED_MAJOR') return { key: 'VERIFIED_MAJOR', tone: 'verified', headline: 'VERIFIED MAJOR DISAGREEMENT — ' + dis.points.toFixed(1) + ' POINTS',
      text: vs + ' The disagreement passed every integrity check. It is a research finding, not a bet: the decision engine’s answer is separate.', not_a_bet: true };
    if (dis.key === 'RESEARCH') return { key: 'RESEARCH', tone: 'research', headline: 'RESEARCH — ' + dis.points.toFixed(1) + '-POINT DISAGREEMENT' + (st !== 'LIVE' ? ' (' + st + ' MARKET)' : ''),
      text: vs + ' Worth opening; the football sections say why the model differs.' + noEdge, not_a_bet: true };
    return { key: 'ALIGNED', tone: 'aligned', headline: 'RESEARCH AVAILABLE — MODEL AND MARKET ALIGNED',
      text: vs + ' EdgeDesk and the ' + lbl + ' agree within ' + T.research_gap + ' pts.', not_a_bet: true };
  }

  /* =============================================================== BUILD
     o     the terminal research object (games.json games[id])
     snap  lib/edgedesk_market_state.js classify() result (or null)
     ctx   { now, mode: 'FULL' | 'RESEARCH_ONLY', betting_enabled, carryover } */
  function build(o, snap, ctx) {
    o = o || {};
    ctx = ctx || {};
    var M = MS(), g = o.game || {}, A = o.edgedesk || {};
    var cmp = snap && M && ctx.mode !== 'RESEARCH_ONLY' ? M.compare(snap, { home_margin: A.available ? A.home_margin : null, fair_total: A.available ? A.fair_total : null }, { home: g.home, away: g.away }) : null;
    var dis = disagreement(o, snap, cmp, ctx);
    var ax = axes(o, snap, dis, ctx);
    var sens = sensitivity(o, snap, cmp, dis, ctx);
    var sec = sections(o, snap, cmp, dis, sens, ax, ctx);
    sec.verdict = verdict(o, snap, cmp, dis, sens, ax, ctx);
    return freeze({
      version: VERSION, game_id: o.game_id || null, generated_at: iso(ctx.now) || o.built_at || null,
      mode: ctx.mode === 'RESEARCH_ONLY' ? 'RESEARCH_ONLY' : 'FULL',
      matchup: { home: g.home, away: g.away, kickoff: o.kickoff || null },
      axes: ax, disagreement: dis, sensitivity: sens, sections: sec,
      research_priority: researchPriority(o),
      market_state: snap ? { state: snap.state, label: snap.label, reason: snap.reason, captured_at: snap.captured_at, age_minutes: snap.age_minutes, age_text: snap.age_text,
        sources: snap.sources, verified: snap.verified, integrity: snap.integrity.status, provider: snap.provider ? snap.provider.status : null } : null,
      rules: ['Research visibility never depends on the market.', 'A market number is never fabricated, and a model number never stands in for one.',
        'A cached or historical price is never a live betting opportunity.', 'An unverified disagreement is INVESTIGATE, never an edge.',
        'Scenarios never change the official fair line.']
    });
  }

  /* THE RESEARCH ASSISTANT'S DETERMINISTIC ANSWERS for the questions the
     market layer owns. Reads only the built research (R) and the research
     object (o); works with the odds provider down. Returns null for any
     other question, so the page's own assistant answers it. */
  function ask(q, o, R) {
    q = String(q || '').toLowerCase();
    if (!R || !o) return null;
    var g = o.game || {}, M = R.sections.market, V = R.sections.verdict, D = R.disagreement, S = R.sensitivity, A = o.edgedesk || {};
    var src = function (claim, source) { return { claim: claim, source: source, updated: R.generated_at, confidence: 'deterministic' }; };
    if (/(market|odds|line|price|book)s?\b.*\b(unavailable|offline|down|missing|stale|cached|old|gone)|no (market|odds|line|price)|odds api|quota|provider|research.only|without (the )?(odds|market)/.test(q)) {
      var t = 'Market state: ' + M.label + '. ' + M.reason + '. ' + (M.provider && M.provider.status && M.provider.status !== 'UNKNOWN' ? 'Provider: ' + M.provider.text + ' ' : '')
        + 'None of the football research depends on it: the projection (' + (A.available ? A.fair_text : 'not available') + '), the matchup, the explanation and the uncertainty are EdgeDesk’s own. '
        + 'What needs a market: ' + (M.unavailable && M.unavailable.length ? M.unavailable.map(function (u) { return u.key.replace(/_/g, ' ') + ' (' + u.reason.replace(/^Unavailable: /, '') + ')'; }).join('; ') : 'nothing is missing') + '.';
      return { intent: 'market_state', text: t, facts: [src('market state ' + M.state, 'lib/edgedesk_market_state.js · games.json market_state'), src('research visibility ' + R.axes.research_visibility.key, 'lib/edgedesk_research_engine.js')] };
    }
    if (/sensitiv|carryover|carry.over|prior.season|last season|roster|turnover|transfer|current.season|alternative|assumption|reconcile/.test(q) && S && S.available) {
      var rows = S.rows.filter(function (r) { return r.status !== 'OFFICIAL'; });
      var t2 = 'Official fair line: ' + S.base.fair_text + '. ' + (S.carryover && S.carryover.available ? S.carryover.text + ' ' : '')
        + rows.slice(0, 6).map(function (r) { return r.label + ' → ' + r.fair_text + ' [' + r.status + ']'; }).join('; ') + '. '
        + (S.persistence ? S.persistence.text + ' ' + (S.persistence.hypothetical_text || '') : '') + ' No scenario changes the official fair line.';
      return { intent: 'sensitivity', text: t2, facts: rows.slice(0, 6).map(function (r) { return src(r.label + ' ' + r.fair_text, r.basis); }) };
    }
    if (/why.*(disagree|differ|different|gap)|disagreement|investigate/.test(q)) {
      if (!D || !D.available) return { intent: 'disagreement', text: 'No model–market comparison: ' + (D ? D.reason : 'no market') + '. EdgeDesk projects ' + (A.fair_text || '—') + '; the explanation section lists the terms that build it.', facts: [] };
      var lead = (R.sections.explanation.drivers || []).slice().sort(function (a, b) { return Math.abs(b.points) - Math.abs(a.points); }).slice(0, 3);
      var t3 = D.label + ': EdgeDesk ' + D.model_text + ' vs ' + (D.market_basis === 'LIVE' ? 'market' : D.market_basis.toLowerCase() + ' market') + ' ' + D.market_text + ' (' + D.points.toFixed(1) + ' pts toward ' + D.toward_team + '). ' + D.reason + '. '
        + (lead.length ? 'Largest model terms: ' + lead.map(function (r) { return r.label + ' ' + r.text; }).join('; ') + '. ' : '')
        + (S && S.persistence ? S.persistence.text + ' ' : '') + 'It is research, not a validated edge.';
      return { intent: 'disagreement', text: t3, facts: [src('gap ' + D.formula, 'lib/edgedesk_calc.js'), src('verdict ' + V.key, 'lib/edgedesk_research_engine.js')] };
    }
    if (/verdict|can i bet|should i bet|is (this|it) a bet|bet(ting)? (edge|value)|\bedge\b|playable/.test(q)) {
      var bl = R.axes.betting_validation.blockers;
      return { intent: 'verdict', text: V.headline + '. ' + V.text + (bl.length ? ' Betting validation BLOCKED: ' + bl.map(function (b) { return b.text; }).join(' ') : ''),
        facts: [src('betting validation ' + R.axes.betting_validation.key, 'lib/edgedesk_research_engine.js')] };
    }
    if (/\btotal\b|over.?under/.test(q)) {
      var tc = M.total;
      return { intent: 'total', text: 'EdgeDesk’s fair total is ' + (num(A.fair_total) == null ? 'not available' : A.fair_total) + '. '
        + (tc && tc.available ? 'Market total ' + tc.market + ' (' + tc.market_basis.toLowerCase() + '): ' + tc.text + '.' : 'Market total: ' + ((M.unavailable || []).filter(function (u) { return u.key === 'total_difference'; }).map(function (u) { return u.reason; })[0] || 'Unavailable') + '.'),
        facts: [src('fair total ' + A.fair_total, A.model_version || 'EdgeDesk')] };
    }
    return null;
  }

  /* MODEL-ONLY RESEARCH QUEUE: every projected game, by research priority
     (or one component), each with its reasons. Never a ranking of bets. */
  function queue(list, key) {
    key = key && PRIORITY_KEYS.indexOf(key) >= 0 ? key : 'score';
    return (list || []).filter(function (r) { return r && r.research_priority; }).slice().sort(function (a, b) {
      var x = key === 'score' ? a.research_priority.score : a.research_priority.components[key];
      var y = key === 'score' ? b.research_priority.score : b.research_priority.components[key];
      if (y !== x) return y - x;
      return String(a.game_id).localeCompare(String(b.game_id));
    });
  }

  return freeze({
    VERSION: VERSION, THRESHOLDS: T, AXES: AXES, PRIORITY_KEYS: PRIORITY_KEYS, PRIORITY_LABEL: PRIORITY_LABEL, PRIORITY_W: PRIORITY_W,
    build: build, axes: axes, disagreement: disagreement, sensitivity: sensitivity, researchPriority: researchPriority,
    sections: sections, verdict: verdict, queue: queue, ask: ask, outcomeBands: outcomeBands, gameScripts: gameScripts, footballUncertainty: footballUncertainty
  });
}));
