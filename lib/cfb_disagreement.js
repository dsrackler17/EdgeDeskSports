/* ===========================================================================
   EdgeDesk CFB — the MAJOR-DISAGREEMENT INTEGRITY GATE.

   A 7-point disagreement between EdgeDesk and the market is, far more often
   than not, missing information, stale information, a scaling error, a
   roster/QB problem, a cross-conference translation issue, an
   over-adjustment or a market-data problem — not a 10-point betting edge.
   The forensic replay (football/cfb_p4/research/disagreement_forensics.js,
   docs/cfb-disagreement/FORENSICS.md) measured it: at 7+ points the engine
   was closer to the final margin than the opener 40% of the time.

   So a raw 7+ gap is never shown as a major disagreement. It is shown as
   INVESTIGATE until it has passed every check this file runs, and only then
   as VERIFIED MAJOR DISAGREEMENT. The checks get STRICTER as the gap grows:
   a 2-point gap is mundane, a 15-point gap means either the market missed
   something enormous or EdgeDesk did.

   What this file is NOT:
     - it never changes the pure fair spread, the projected score, the win
       probability or any model state. It reads them;
     - it never uses the market as an input to football. The market is the
       thing being compared against, and its own integrity is checked;
     - it is not a bet. VERIFIED means "the model genuinely disagrees and the
       disagreement survived integrity checks". Bet eligibility is the
       decision layer's (calibrated cover probability, price, EV,
       uncertainty, CLV evidence), and nothing here can override it;
     - it is not a quota. There is no maximum number of verified gaps per
       week. The slate circuit breaker compares the COUNT of raw gaps with
       their historical frequency and raises MODEL_SCALE_ALERT for
       investigation; it never suppresses a gap.

   FAIL CLOSED. A check that cannot be run is INCOMPLETE, never PASS. Any
   exception inside verification returns INVESTIGATE — VERIFICATION
   INCOMPLETE. Nothing is ever VERIFIED by default.

   Browser: window.EDCfbDisagreement. Node: require('./cfb_disagreement.js').

   CONVENTIONS
     margin   home perspective, + = home favoured by (engine fair_spread, the
              board's market spread_line, V2 projections)
     gap      raw_market_gap = pure fair margin - market margin: + = EdgeDesk
              likes the HOME side more than the market does
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.EDCfbDisagreement = factory(root);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';
  var D = { version: 'cfb_disagreement/1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function abs(x) { return Math.abs(x); }
  function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (has(a, k)) o[k] = a[k];
    if (b) for (k in b) if (has(b, k) && b[k] != null) o[k] = b[k];
    return o;
  }
  function normTeam(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[‘’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  }

  /* ------------------------------------------------------------ THE RULES
     Every threshold is here, with the evidence it rests on. The generated
     football/cfb_p4/disagreement_params.js (window.EDCfbDisagreementParams)
     overrides the MEASURED parts — component percentiles, the calibrator,
     the historical gap frequencies — from the forensic replay; the policy
     parts (which tier needs what) are declared here and changed only here. */
  D.DEFAULTS = {
    research_gap: 2,                   /* EDCfbP4Params.market.min_research_gap */
    tiers: [
      { id: 'MAJOR_7', min: 7 },
      { id: 'MAJOR_10', min: 10 },
      { id: 'MAJOR_15', min: 15 }
    ],
    /* past it an unverified gap is read as a data fault, as the board always
       has (FB_GUARD.p4.game). A gap past it that passes EVERY check is still
       shown — as extraordinary, with a manual review queued. */
    guard_gap: 21,
    market: {
      /* books behind the current consensus. The forensic replay found
         single-book openers carrying sign flips and garbage values (UCF v
         Maryland 2016 opened -9 at one book and closed +10.5 at seventeen) */
      min_books: { MAJOR_7: 2, MAJOR_10: 2, MAJOR_15: 3 },
      /* hours since the quote was captured */
      max_age_hours: { MAJOR_7: 24, MAJOR_10: 12, MAJOR_15: 12 },
      /* cross-book dispersion: p99 of the archive's closing-line SD / range */
      max_dispersion_sd: 2.31,
      max_range: 5,
      max_abs_line: 60
    },
    team_state: {
      /* current-season games behind BOTH ratings. At 0 games played the
         replay's 7+ gaps moved toward EdgeDesk 47.8% of the time (a coin
         flip); at 3+ they moved toward it 61-66% */
      min_games: { MAJOR_7: 3, MAJOR_10: 4, MAJOR_15: 4 },
      /* |long-term state - current-season form| in rating points, beyond
         which the pricing state is judged stale for the higher tiers */
      max_long_term_delta: { MAJOR_10: 10, MAJOR_15: 10 }
    },
    components: {
      /* non-base additive adjustments. The rating term is the model's
         football content and is audited against the market separately
         (base_rating_gap); these are corrections to it */
      keys: ['hfa', 'qb', 'matchup', 'travel', 'schedule', 'injury', 'rivalry', 'conference'],
      /* validated |points| distributions — replaced by the generated params */
      pct: {
        hfa: { p95: 4.08, p99: 4.08 }, matchup: { p95: 3.42, p99: 4.56 },
        conference: { p95: 7.03, p99: 11.55 }, schedule: { p95: 0.01, p99: 0.02 },
        qb: { p95: 0, p99: 0 }, injury: { p95: 3.9, p99: 3.9 }, travel: { p95: 0, p99: 0 }, rivalry: { p95: 0, p99: 0 }
      },
      /* what happens when ONE non-base component is all that lifts the gap
         over its tier. Measured: conference-driven 7+ gaps moved toward
         EdgeDesk 53% of the time with +0.1 pts CLV (noise), matchup-driven
         ones 67% with +0.9 (signal) — so the first fails, the second is
         flagged for scrutiny. Anything else fails at 10+. */
      dominance_policy: { conference: 'FAIL', matchup: 'WARN', schedule: 'FAIL_10',
        injury: 'FAIL_10', qb: 'FAIL_10', travel: 'FAIL_10', rivalry: 'FAIL_10' },
      /* home field is priced by the market too, so "the gap without it" is
         not a counterfactual anyone can read. Its SIZE is judged by the
         calibration check (the fitted home field) instead. */
      no_dominance: ['hfa'],
      /* the range check's tolerance, for components that are constants */
      range_tolerance: 0.05,
      /* a term must be at least this large to be called the one that carries
         the gap: a half-point term nudging a gap over a tier line is not a
         large single component */
      dominance_min_points: 2
    },
    /* the football-only margin calibrator (fitted on FINAL MARGINS, never on
       the market). Not promoted to the priced number — its walk-forward gain
       (-0.041 MAE) is under the repo's 0.05 bar — but a raw gap that
       vanishes once the engine's measured over-dispersion and home-field
       over-application are removed is not a disagreement the model can
       defend. Replaced by the generated params. */
    calibration: { slope: 0.964, hfa: 2.58, league_hfa: 4.082, version: 'cfb_margin_cal_v1', required: true },
    cross_model: {
      /* a submodel SUPPORTS EdgeDesk when it sits on EdgeDesk's side of the
         market by at least this many points */
      support_margin: 2,
      /* the independent ensemble's own gap to the market, same direction */
      min_ensemble_gap: { MAJOR_7: 0, MAJOR_10: 3, MAJOR_15: 5 },
      /* the ensemble's internal disagreement (SD across its submodels) */
      max_ensemble_sd: { MAJOR_10: 6, MAJOR_15: 5 }
    },
    model: { min_confidence: 35, min_reliability: 60, sigma_min: 3, sigma_max: 40 },
    qb: {
      resolved: ['ANNOUNCED', 'EXPECTED', 'DEPTH_CHART', 'PREVIOUS_GAME'],
      unresolved: ['COMPETITION', 'UNKNOWN'],
      doubtful: ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'GAME_TIME_DECISION'],
      /* starts in the team's recent games after which the rating already
         reflects a new quarterback (no starter-loss penalty on top) */
      reflected_after_starts: 3
    },
    /* a VERIFIED gap the market then moves further AWAY from by this much
       triggers RECHECK_REQUIRED */
    recheck_move: 1.5,
    /* slate circuit breaker: historical per-game rate of raw gaps, by week
       bucket — replaced by the generated params */
    circuit: {
      rate: { '0_2': { g7: 0.247, g10: 0.08, g15: 0.012 }, '3_5': { g7: 0.16, g10: 0.05, g15: 0.008 },
        '6p': { g7: 0.115, g10: 0.035, g15: 0.005 } },
      alert_p: 0.01
    }
  };
  function loadedParams() {
    var gp = root && root.EDCfbDisagreementParams;
    if (!gp && typeof require === 'function') {
      try { gp = require('../football/cfb_p4/disagreement_params.js'); } catch (_) { gp = null; }
    }
    return gp || null;
  }
  /* deep enough merge for the two-level param blocks */
  D.params = function (over) {
    var base = D.DEFAULTS, gp = loadedParams(), out = {}, k;
    function layer(src) {
      if (!src) return;
      for (k in src) if (has(src, k)) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]))
          out[k] = merge(out[k], src[k]);
        else out[k] = src[k];
      }
    }
    layer(base);
    if (gp && gp.gate) layer(gp.gate);
    layer(over || null);
    return out;
  };

  D.STATUS = {
    MARKET_ALIGNED: { label: 'MARKET ALIGNED', tone: 'ok', rank: 0 },
    WORTH_RESEARCHING: { label: 'WORTH RESEARCHING', tone: 'accent', rank: 1 },
    INVESTIGATE: { label: 'INVESTIGATE', tone: 'warn', rank: 2 },
    MARKET_FAULT: { label: 'MARKET FAULT', tone: 'dim', rank: 2 },
    DATA_FAULT: { label: 'DATA FAULT', tone: 'neg', rank: 2 },
    VERIFIED_MAJOR_DISAGREEMENT: { label: 'VERIFIED MAJOR DISAGREEMENT', tone: 'verified', rank: 3 }
  };

  D.ROOT_CAUSES = ['VALID_MODEL_DISAGREEMENT', 'TEAM_RATING_ERROR', 'OPPONENT_ADJUSTMENT_ERROR',
    'EARLY_SEASON_PRIOR_ERROR', 'RECENT_FORM_OVERREACTION', 'QB_STATUS_ERROR', 'PLAYER_AVAILABILITY_ERROR',
    'ROSTER_DOUBLE_COUNT', 'MATCHUP_OVERADJUSTMENT', 'HFA_ERROR', 'TRAVEL_OR_REST_ERROR',
    'WEATHER_OVERADJUSTMENT', 'SPECIAL_TEAMS_OVERADJUSTMENT', 'CROSS_CONFERENCE_SCALE_ERROR',
    'FCS_TRANSLATION_ERROR', 'EXTREME_FAVORITE_NONLINEARITY', 'GAME_MAPPING_ERROR', 'HOME_AWAY_ERROR',
    'MARKET_JOIN_ERROR', 'STALE_MARKET', 'THIN_MARKET', 'UNKNOWN'];

  /* ================================================ normalising the inputs */
  var COMP_KEYS = ['rating', 'hfa', 'qb', 'matchup', 'travel', 'schedule', 'injury', 'rivalry', 'conference'];

  /* the engine's projectGame output -> the projection block this gate reads.
     Only reads; returns null for anything that is not a priced projection. */
  D.fromEngine = function (p) {
    if (!p || p.status !== 'PREDICTED' || !p.model || num(p.model.fair_spread) == null) return null;
    var c = {}, avail = {};
    (p.contributions || []).forEach(function (x) {
      if (!x || COMP_KEYS.indexOf(x.key) < 0) return;
      c[x.key] = x.available && num(x.points) != null ? x.points : 0;
      avail[x.key] = !!x.available;
    });
    var pb = p.layers && p.layers.strength && p.layers.strength.preseason_blend || {};
    var mc = p.model.margin_calibration || null;
    return {
      status: 'PREDICTED', fair: p.model.fair_spread, sigma: num(p.model.sigma_margin),
      home_win_prob: num(p.model.home_win_prob),
      confidence: p.scores ? num(p.scores.confidence) : null,
      components: c, component_available: avail,
      rating_detail: {
        home_carried: num(pb.home_carried), home_fresh: num(pb.home_this_season),
        away_carried: num(pb.away_carried), away_fresh: num(pb.away_this_season),
        prior_weight: num(pb.prior_weight),
        home_gp: num(pb.home_games_played) != null ? pb.home_games_played : null,
        away_gp: num(pb.away_games_played) != null ? pb.away_games_played : null,
        games_played: num(pb.games_played)
      },
      calibration: mc ? { calibrated: num(mc.calibrated_margin), slope: num(mc.slope), hfa: num(mc.hfa), version: mc.version || null } : null,
      season: p.game ? p.game.season : null, week: p.game ? p.game.week : null,
      home_conference: p.game ? p.game.home_conference : null, away_conference: p.game ? p.game.away_conference : null,
      model_version: p.model_version || null, prediction_ts: p.prediction_timestamp || null
    };
  };

  /* the football-only calibrated margin: slope x (raw - applied home field)
     + fitted home field. Antisymmetric in the teams at a neutral site, so a
     pick'em stays a pick'em and no side is favoured by the arithmetic. */
  D.calibratedMargin = function (proj, isNeutral, P) {
    if (!proj || num(proj.fair) == null) return null;
    if (proj.calibration && num(proj.calibration.calibrated) != null) return proj.calibration.calibrated;
    var cal = (P || D.params()).calibration;
    var h = num(proj.components && proj.components.hfa) || 0;
    var neutralPart = proj.fair - h;
    var home = isNeutral === true ? 0 : (h !== 0 ? 1 : (isNeutral === false ? 1 : 0));
    return cal.slope * neutralPart + cal.hfa * home;
  };

  /* ================================================ the tier of a gap */
  function tierOf(gapAbs, P) {
    var t = null;
    P.tiers.forEach(function (x) { if (gapAbs >= x.min) t = x; });
    return t;
  }
  function tierMin(id, P) {
    for (var i = 0; i < P.tiers.length; i++) if (P.tiers[i].id === id) return P.tiers[i].min;
    return null;
  }
  /* a per-tier requirement: the value for the gap's tier, else the nearest
     lower tier that states one */
  function req(map, tierId, P) {
    if (!map) return null;
    if (has(map, tierId)) return map[tierId];
    var best = null;
    P.tiers.forEach(function (t) { if (has(map, t.id) && t.min <= tierMin(tierId, P)) best = map[t.id]; });
    return best;
  }

  /* ================================================ the checks
     Each item: { id, group, status: PASS | FAIL | WARN | INCOMPLETE |
     NOT_APPLICABLE | NOT_EVALUATED, detail, cause (a ROOT_CAUSES key when it
     fails) }. A group passes only when every item in it is PASS, WARN,
     NOT_APPLICABLE or (historical replay only) NOT_EVALUATED. */
  function item(group, id, status, detail, cause) {
    return { group: group, id: id, status: status, detail: detail, cause: cause || null };
  }

  function gameChecks(x, P, out) {
    var g = x.game || {}, m = x.market || {}, map = x.mapping || null;
    var home = g.home, away = g.away;
    out.push(item('GAME', 'teams_resolved',
      (home && away && x.projection) ? 'PASS' : 'FAIL',
      (home && away && x.projection) ? 'both teams resolve to rated programs' : 'a team did not resolve to a rated program',
      'GAME_MAPPING_ERROR'));
    if (map && map.teams_resolved === false)
      out.push(item('GAME', 'identity_join', 'FAIL', 'the schedule/rating identity join reported a failure: ' + (map.warnings || []).join('; '), 'GAME_MAPPING_ERROR'));
    /* the market row names its own teams: they must be this game's, the
       same way round */
    if (m.home_team && m.away_team) {
      var hOk = normTeam(m.home_team) === normTeam(home) || (map && map.home_alias_ok === true);
      var aOk = normTeam(m.away_team) === normTeam(away) || (map && map.away_alias_ok === true);
      var swapped = normTeam(m.home_team) === normTeam(away) && normTeam(m.away_team) === normTeam(home);
      out.push(item('GAME', 'home_away', swapped ? 'FAIL' : ((hOk && aOk) ? 'PASS' : (map && map.teams_resolved ? 'PASS' : 'WARN')),
        swapped ? 'the market row names the teams the other way round (home/away swapped)'
          : ((hOk && aOk) ? 'the market row names this game’s home and away teams' : 'the market row’s team names differ from the schedule’s spelling; resolved by the alias join'),
        swapped ? 'HOME_AWAY_ERROR' : 'MARKET_JOIN_ERROR'));
    } else {
      out.push(item('GAME', 'home_away', map && map.teams_resolved ? 'PASS' : 'INCOMPLETE',
        map && map.teams_resolved ? 'both sides of the quote resolved to this game’s own teams (alias join)'
          : 'the quote carries no team names to check the orientation against', 'MARKET_JOIN_ERROR'));
    }
    if (m.fault)
      out.push(item('GAME', 'orientation', 'FAIL', 'the joined line only reconciles with the model once negated: one row in the opposite spread convention', 'HOME_AWAY_ERROR'));
    out.push(item('GAME', 'venue', g.neutral_site === true || g.neutral_site === false ? 'PASS' : 'INCOMPLETE',
      g.neutral_site === true ? 'neutral site, declared by the schedule feed'
        : (g.neutral_site === false ? 'home venue' + (g.venue ? ' (' + g.venue + ')' : '') + ', declared by the schedule feed'
          : 'the schedule does not say whether the site is neutral'), 'GAME_MAPPING_ERROR'));
    var k = Date.parse(g.kickoff || '');
    var now = num(x.now_ms);
    if (!isFinite(k)) out.push(item('GAME', 'kickoff', 'INCOMPLETE', 'no kickoff time on the game', 'GAME_MAPPING_ERROR'));
    else if (now != null && now >= k) out.push(item('GAME', 'kickoff', 'FAIL', 'the game has kicked off; a pregame disagreement cannot be verified after it', 'GAME_MAPPING_ERROR'));
    else {
      var mk = Date.parse(m.kickoff || '');
      if (isFinite(mk) && abs(mk - k) > 36 * 3600e3)
        out.push(item('GAME', 'kickoff', 'FAIL', 'the quote’s kickoff is ' + Math.round(abs(mk - k) / 3600e3) + ' h from the schedule’s: a different game', 'MARKET_JOIN_ERROR'));
      else out.push(item('GAME', 'kickoff', 'PASS', 'kickoff ' + new Date(k).toISOString() + (isFinite(mk) ? ', agrees with the quote' : ''), null));
    }
  }

  function marketChecks(x, P, tierId, out) {
    var m = x.market || {};
    var line = num(m.spread);
    out.push(item('MARKET', 'quote_present', line != null ? 'PASS' : 'FAIL',
      line != null ? 'a current consensus spread is on file' : 'no current spread quote', 'MARKET_JOIN_ERROR'));
    if (line == null) return;
    if (abs(line) > P.market.max_abs_line)
      out.push(item('MARKET', 'consensus_valid', 'FAIL', 'a spread of ' + line + ' is not a plausible college line', 'MARKET_JOIN_ERROR'));
    else out.push(item('MARKET', 'consensus_valid', 'PASS', 'plausible spread', null));
    if (x.historical) {
      out.push(item('MARKET', 'quote_fresh', 'NOT_EVALUATED', 'historical replay: the quote is the one on file at the freeze', null));
    } else {
      var asOf = Date.parse(m.as_of || ''), now = num(x.now_ms);
      var maxAge = req(P.market.max_age_hours, tierId, P);
      if (m.stale) out.push(item('MARKET', 'quote_fresh', 'FAIL', 'the only quote on file is marked stale', 'STALE_MARKET'));
      else if (!isFinite(asOf) || now == null) out.push(item('MARKET', 'quote_fresh', 'INCOMPLETE', 'the quote carries no capture time to judge its freshness by', 'STALE_MARKET'));
      else {
        var ageH = (now - asOf) / 3600e3;
        out.push(item('MARKET', 'quote_fresh', ageH <= maxAge ? 'PASS' : 'FAIL',
          'captured ' + r1(ageH) + ' h ago (limit ' + maxAge + ' h at this size)', 'STALE_MARKET'));
      }
    }
    var books = num(m.books), minB = req(P.market.min_books, tierId, P);
    if (books == null) out.push(item('MARKET', 'book_count', x.historical ? 'NOT_EVALUATED' : 'INCOMPLETE',
      x.historical ? 'historical replay: the archive does not carry a reliable book count for this quote' : 'the number of books behind the consensus is not reported', 'THIN_MARKET'));
    else out.push(item('MARKET', 'book_count', books >= minB ? 'PASS' : 'FAIL',
      books + ' book' + (books === 1 ? '' : 's') + ' behind the consensus (at least ' + minB + ' required at this size)', 'THIN_MARKET'));
    var disp = num(m.dispersion), rng = num(m.range);
    if (disp == null && rng == null) {
      out.push(item('MARKET', 'dispersion', books != null && books < 2 ? 'NOT_APPLICABLE' : (x.historical ? 'NOT_EVALUATED' : 'INCOMPLETE'),
        books != null && books < 2 ? 'one book: no dispersion to measure' : 'cross-book dispersion is not reported', 'THIN_MARKET'));
    } else {
      var bad = (disp != null && disp > P.market.max_dispersion_sd) || (rng != null && rng > P.market.max_range);
      out.push(item('MARKET', 'dispersion', bad ? 'FAIL' : 'PASS',
        'books disagree by ' + (rng != null ? r1(rng) + ' pts (range)' : 'SD ' + r2(disp)) + (bad ? ' — past the archive’s p99: an outlier or stale book is driving the consensus' : ''),
        'STALE_MARKET'));
    }
  }

  function teamStateChecks(x, P, tierId, flip, out) {
    var pr = x.projection || {}, rd = pr.rating_detail || {}, g = x.game || {};
    var gp = [num(rd.home_gp), num(rd.away_gp)];
    var minGp = (gp[0] == null || gp[1] == null) ? null : Math.min(gp[0], gp[1]);
    var need = req(P.team_state.min_games, flip ? 'MAJOR_10' : tierId, P);
    if (flip && tierMin(tierId, P) > tierMin('MAJOR_10', P)) need = req(P.team_state.min_games, tierId, P);
    if (minGp == null) out.push(item('TEAM_STATE', 'current_sample', 'INCOMPLETE', 'games played this season are not reported for both teams', 'EARLY_SEASON_PRIOR_ERROR'));
    else out.push(item('TEAM_STATE', 'current_sample', minGp >= need ? 'PASS' : 'FAIL',
      'fewest current-season games behind a rating: ' + minGp + ' (at least ' + need + ' required at this size)'
        + (minGp < need ? ' — the number is still mostly the preseason prior' : ''), 'EARLY_SEASON_PRIOR_ERROR'));
    if (g.home_fbs === false || g.away_fbs === false)
      out.push(item('TEAM_STATE', 'fbs_scale', tierMin(tierId, P) >= 10 ? 'FAIL' : 'WARN',
        'an FCS opponent is priced from a pooled FCS rating, not its own', 'FCS_TRANSLATION_ERROR'));
    var ltd = x.long_term_vs_current_delta;
    var lim = req(P.team_state.max_long_term_delta, tierId, P);
    if (ltd == null) out.push(item('TEAM_STATE', 'state_stability', 'NOT_EVALUATED', 'long-term vs current-season split not available', null));
    else if (lim == null) out.push(item('TEAM_STATE', 'state_stability', abs(ltd) > 10 ? 'WARN' : 'PASS',
      'long-term state and current-season form differ by ' + r1(abs(ltd)) + ' rating pts', 'TEAM_RATING_ERROR'));
    else out.push(item('TEAM_STATE', 'state_stability', abs(ltd) <= lim ? 'PASS' : 'FAIL',
      'long-term state and current-season form differ by ' + r1(abs(ltd)) + ' rating pts (limit ' + lim + ')', 'TEAM_RATING_ERROR'));
    /* V1's pricing state is a sequential Elo, not an iterative fixed point:
       there is no convergence to fail. A caller pricing from an iterative
       rating passes its convergence record. */
    if (x.state && x.state.converged === false)
      out.push(item('TEAM_STATE', 'opponent_adjustment', 'FAIL', 'the opponent adjustment did not converge', 'OPPONENT_ADJUSTMENT_ERROR'));
    else if (x.state && x.state.converged === true)
      out.push(item('TEAM_STATE', 'opponent_adjustment', 'PASS', 'the opponent adjustment converged', null));
    else out.push(item('TEAM_STATE', 'opponent_adjustment', 'NOT_APPLICABLE',
      'the pricing state is a sequential (Elo-type) update with no iterative solve to converge', null));
    if (x.state && x.state.season != null && pr.season != null && +x.state.season !== +pr.season)
      out.push(item('TEAM_STATE', 'season', 'FAIL', 'the rating state is from ' + x.state.season + ', the game from ' + pr.season, 'TEAM_RATING_ERROR'));
    if (x.state && x.state.fresh === false)
      out.push(item('TEAM_STATE', 'freshness', 'FAIL', 'the rating state has not absorbed the latest completed games', 'TEAM_RATING_ERROR'));
  }

  function qbChecks(x, P, tierId, flip, out) {
    if (x.historical) { out.push(item('QB', 'starter', 'NOT_EVALUATED', 'no historical starter/availability record exists for the replay window', null)); return; }
    var q = x.qb;
    if (!q || !q.home || !q.away) { out.push(item('QB', 'starter', 'INCOMPLETE', 'no starter context reached this game', 'QB_STATUS_ERROR')); return; }
    var strict = flip || tierMin(tierId, P) >= 10;
    ['home', 'away'].forEach(function (side) {
      var s = q[side] || {}, st = String(s.status || 'UNKNOWN').toUpperCase(), av = String(s.availability || 'UNKNOWN').toUpperCase();
      var team = side === 'home' ? (x.game || {}).home : (x.game || {}).away;
      if (P.qb.doubtful.indexOf(av) >= 0) {
        var priced = num(((x.projection || {}).components || {}).injury);
        out.push(item('QB', side + '_availability', priced ? 'WARN' : 'FAIL',
          team + ' quarterback ' + (s.player || '') + ' is ' + av.toLowerCase().replace(/_/g, ' ')
            + (priced ? ' — priced through the absence term' : ' — not reflected in the number'), 'QB_STATUS_ERROR'));
      }
      if (P.qb.resolved.indexOf(st) >= 0) {
        /* a starter who has not started the team's recent games is NOT in
           the rating: the model is pricing someone else */
        var recent = num(s.recent_starts), change = s.change === true;
        if (change && recent != null && recent < P.qb.reflected_after_starts && !num(((x.projection || {}).components || {}).injury))
          out.push(item('QB', side + '_starter', 'FAIL', team + ': new starter ' + (s.player || '') + ' with ' + recent
            + ' recent start(s) — the team rating does not reflect him and the number does not price the change', 'QB_STATUS_ERROR'));
        else out.push(item('QB', side + '_starter', 'PASS', team + ': ' + (s.player || 'starter') + ' (' + st.toLowerCase().replace(/_/g, ' ') + ')'
          + (change && recent != null && recent >= P.qb.reflected_after_starts ? ' — a change the rating already reflects (' + recent + ' starts); no penalty stacked on it' : ''), null));
      } else {
        out.push(item('QB', side + '_starter', strict ? 'FAIL' : 'WARN',
          team + ': starter unresolved (' + st.toLowerCase() + ')' + (strict ? ' — must be resolved or scenario-weighted at this size' : ''), 'QB_STATUS_ERROR'));
      }
    });
  }

  function rosterChecks(x, P, tierId, out) {
    if (x.historical) { out.push(item('ROSTER', 'availability', 'NOT_EVALUATED', 'no historical availability record exists for the replay window', null)); return; }
    var r = x.roster;
    if (!r) { out.push(item('ROSTER', 'availability', 'INCOMPLETE', 'no availability state reached this game', 'PLAYER_AVAILABILITY_ERROR')); return; }
    ['home', 'away'].forEach(function (side) {
      var s = r[side] || {}, st = String(s.feed_state || 'UNKNOWN').toUpperCase();
      var team = side === 'home' ? (x.game || {}).home : (x.game || {}).away;
      var abnormal = st === 'FETCH_FAILED' || st === 'STALE' || st === 'CONFLICTING';
      out.push(item('ROSTER', side + '_availability', abnormal ? 'FAIL' : 'PASS',
        team + ': availability ' + (abnormal ? 'feed ' + st.toLowerCase().replace(/_/g, ' ') + ' — abnormal missing data'
          : (st === 'REPORTED' ? 'report on file' : 'sources checked, nothing filed')), 'PLAYER_AVAILABILITY_ERROR'));
      if (s.double_count === true)
        out.push(item('ROSTER', side + '_double_count', 'FAIL', team + ': an absence the rating already reflects is also priced as a penalty', 'ROSTER_DOUBLE_COUNT'));
    });
  }

  /* the gap's component story: which additive term, if any, is what lifts it
     over its tier, and which terms sit outside their validated range */
  function componentChecks(x, P, tierId, gap, out, warnings) {
    var c = (x.projection || {}).components || {}, s = sign(gap), minT = tierMin(tierId, P);
    P.components.keys.forEach(function (k) {
      var v = num(c[k]);
      if (v == null || v === 0) return;
      var pc = P.components.pct[k] || null;
      var tol = num(P.components.range_tolerance) || 0;
      if (pc && num(pc.p99) != null && abs(v) > pc.p99 + tol) {
        out.push(item('COMPONENT', k + '_range', 'FAIL', k + ' contributes ' + r1(v) + ' pts, outside its validated range (p99 ' + r1(pc.p99) + ')',
          k === 'matchup' ? 'MATCHUP_OVERADJUSTMENT' : (k === 'conference' ? 'CROSS_CONFERENCE_SCALE_ERROR' : (k === 'hfa' ? 'HFA_ERROR' : 'UNKNOWN'))));
      } else if (pc && num(pc.p95) != null && abs(v) > pc.p95 + tol) {
        warnings.push(k + ' is past its p95 (' + r1(v) + ' pts)');
      }
      /* LARGE SINGLE-COMPONENT: without this one term the gap falls under
         its tier */
      if ((P.components.no_dominance || []).indexOf(k) < 0 && sign(v) === s && abs(gap - v) < minT
        && abs(v) >= (num(P.components.dominance_min_points) || 0)) {
        var pol = P.components.dominance_policy[k] || 'FAIL_10';
        var fail = pol === 'FAIL' || (pol === 'FAIL_10' && minT >= 10);
        var cause = k === 'conference' ? 'CROSS_CONFERENCE_SCALE_ERROR' : (k === 'matchup' ? 'MATCHUP_OVERADJUSTMENT'
          : (k === 'hfa' ? 'HFA_ERROR' : (k === 'schedule' || k === 'travel' ? 'TRAVEL_OR_REST_ERROR'
            : (k === 'injury' ? 'PLAYER_AVAILABILITY_ERROR' : (k === 'qb' ? 'QB_STATUS_ERROR' : 'UNKNOWN')))));
        out.push(item('COMPONENT', k + '_dominance', fail ? 'FAIL' : 'WARN',
          'the ' + k + ' term alone (' + r1(v) + ' pts) lifts the gap over ' + minT + ': without it the gap is ' + r1(abs(gap - v))
            + (fail ? '' : ' — historically informative, flagged for scrutiny'), cause));
      }
    });
    if (!out.some(function (i) { return i.group === 'COMPONENT'; }))
      out.push(item('COMPONENT', 'bounds', 'PASS', 'every adjustment inside its validated range; no single adjustment carries the gap', null));
  }

  function calibrationCheck(x, P, tierId, out, cal) {
    if (!P.calibration || P.calibration.required === false) return;
    if (cal.gap == null) { out.push(item('MODEL', 'calibration', 'INCOMPLETE', 'the calibrated margin could not be formed', 'UNKNOWN')); return; }
    var minT = P.tiers[0].min;
    var survives = abs(cal.gap) >= minT && sign(cal.gap) === sign(cal.raw_gap);
    var fav = abs(num((x.projection || {}).fair) || 0);
    out.push(item('MODEL', 'calibration', survives ? 'PASS' : 'FAIL',
      'football-only calibration (slope ' + P.calibration.slope + ', home field ' + P.calibration.hfa + ') puts the gap at ' + r1(abs(cal.gap))
        + (survives ? '' : ' — the extreme is not supported by how margins of this size have actually finished'),
      survives ? null : (fav >= 21 ? 'EXTREME_FAVORITE_NONLINEARITY' : ((num(((x.projection || {}).components || {}).hfa) || 0) !== 0 && sign(cal.raw_gap) > 0 ? 'HFA_ERROR' : 'EXTREME_FAVORITE_NONLINEARITY'))));
  }

  function crossModel(x, P, gap, marketLine) {
    var sm = x.submodels;
    var out = { available: false, n: 0, supporting: 0, opposing: 0, neutral: 0, projections: [], ensemble: null,
      ensemble_gap: null, ensemble_sd: null, same_direction: null, same_favorite: null, text: null };
    if (!sm || !sm.projections) return out;
    var s = sign(gap), names = Object.keys(sm.projections);
    names.forEach(function (k) {
      var v = num(sm.projections[k]);
      if (v == null) return;
      var d = v - marketLine;
      var st = (sign(d) === s && abs(d) >= P.cross_model.support_margin) ? 'supports'
        : ((sign(d) === -s && abs(d) >= P.cross_model.support_margin) ? 'opposes' : 'neutral');
      out.projections.push({ model: k, margin: r2(v), gap: r2(d), stance: st });
      out.n++;
      if (st === 'supports') out.supporting++; else if (st === 'opposes') out.opposing++; else out.neutral++;
    });
    out.available = out.n > 0;
    out.ensemble = num(sm.ensemble);
    out.ensemble_sd = num(sm.ensemble_sd);
    if (out.ensemble != null) {
      out.ensemble_gap = r2(out.ensemble - marketLine);
      out.same_direction = sign(out.ensemble - marketLine) === s;
      out.same_favorite = sign(out.ensemble) === sign((x.projection || {}).fair);
    }
    out.source = sm.source || null;
    return out;
  }
  function modelChecks(x, P, tierId, flip, cm, out) {
    var pr = x.projection || {};
    var sig = num(pr.sigma), wp = num(pr.home_win_prob);
    var valid = num(pr.fair) != null && sig != null && sig > P.model.sigma_min && sig < P.model.sigma_max && (wp == null || (wp > 0 && wp < 1));
    out.push(item('MODEL', 'distribution', valid ? 'PASS' : 'FAIL',
      valid ? 'prediction distribution valid (sigma ' + r1(sig) + ')' : 'the prediction distribution is not valid', 'UNKNOWN'));
    var conf = num(pr.confidence);
    if (conf == null) out.push(item('MODEL', 'confidence', x.historical ? 'NOT_EVALUATED' : 'INCOMPLETE', 'information confidence not measured', null));
    else out.push(item('MODEL', 'confidence', conf >= P.model.min_confidence ? 'PASS' : 'FAIL',
      'information confidence ' + Math.round(conf) + ' (floor ' + P.model.min_confidence + ')', 'UNKNOWN'));
    var rel = num(x.reliability);
    if (rel != null) out.push(item('MODEL', 'reliability', rel >= P.model.min_reliability ? 'PASS' : 'FAIL',
      'reliability ' + Math.round(rel) + ' (floor ' + P.model.min_reliability + ')', 'UNKNOWN'));
    else if (!x.historical) out.push(item('MODEL', 'reliability', 'INCOMPLETE', 'no reliability score reached this game', null));
    /* CROSS-MODEL: independent football submodels, never the market */
    if (!cm.available) {
      out.push(item('MODEL', 'submodels', 'INCOMPLETE', 'no independent submodel projections are available for this game', 'UNKNOWN'));
      return;
    }
    var tierReq = flip && tierMin(tierId, P) < 10 ? 'MAJOR_10' : tierId;
    var majority = Math.ceil(cm.n / 2);
    if (tierMin(tierId, P) >= 15) majority = Math.max(majority, cm.n - 1);
    var okSupport = cm.supporting >= majority && cm.supporting > cm.opposing;
    out.push(item('MODEL', 'submodel_support', okSupport ? 'PASS' : 'FAIL',
      cm.supporting + ' of ' + cm.n + ' independent submodels sit on EdgeDesk’s side of the market by ' + P.cross_model.support_margin + '+ pts ('
        + cm.opposing + ' on the market’s side; ' + majority + ' required)', 'TEAM_RATING_ERROR'));
    if (cm.ensemble != null) {
      var needG = req(P.cross_model.min_ensemble_gap, tierReq, P) || 0;
      var okE = cm.same_direction && abs(cm.ensemble_gap) >= needG;
      out.push(item('MODEL', 'ensemble_direction', okE ? 'PASS' : 'FAIL',
        'the independent ensemble is ' + r1(abs(cm.ensemble_gap)) + ' pts ' + (cm.same_direction ? 'on EdgeDesk’s side' : 'on the market’s side')
          + (needG ? ' (at least ' + needG + ' on EdgeDesk’s side required)' : ''), 'TEAM_RATING_ERROR'));
      if (flip) out.push(item('MODEL', 'ensemble_favorite', cm.same_favorite ? 'PASS' : 'FAIL',
        'favorite flip: the independent ensemble ' + (cm.same_favorite ? 'also' : 'does not') + ' favour EdgeDesk’s team', 'TEAM_RATING_ERROR'));
      var maxSd = req(P.cross_model.max_ensemble_sd, tierReq, P);
      if (maxSd != null && cm.ensemble_sd != null)
        out.push(item('MODEL', 'ensemble_disagreement', cm.ensemble_sd <= maxSd ? 'PASS' : 'FAIL',
          'the submodels disagree with each other by SD ' + r1(cm.ensemble_sd) + ' (limit ' + maxSd + ')', 'UNKNOWN'));
    } else {
      out.push(item('MODEL', 'ensemble_direction', 'INCOMPLETE', 'no independent ensemble number', 'UNKNOWN'));
    }
  }

  /* ================================================ decomposition */
  D.decompose = function (x, marketLine) {
    var pr = x.projection || {}, c = pr.components || {}, rd = pr.rating_detail || {};
    var rating = num(c.rating) || 0;
    var ltDiff = (num(rd.home_carried) != null && num(rd.away_carried) != null) ? rd.home_carried - rd.away_carried : null;
    var fresh = (num(rd.home_fresh) != null && num(rd.away_fresh) != null) ? rd.home_fresh - rd.away_fresh : null;
    var w = num(rd.prior_weight);
    var out = {
      neutral_strength: r2(rating),
      long_term_state: ltDiff == null || w == null ? null : r2(w * ltDiff),
      current_form: ltDiff == null || w == null ? null : r2(rating - w * ltDiff),
      prior_weight: w,
      home_field: r2(num(c.hfa) || 0),
      qb: r2(num(c.qb) || 0),
      injuries: r2(num(c.injury) || 0),
      matchup: r2(num(c.matchup) || 0),
      conference: r2(num(c.conference) || 0),
      rest_travel: r2((num(c.schedule) || 0) + (num(c.travel) || 0)),
      weather: 0,
      special_teams: 0,
      other: r2(num(c.rivalry) || 0),
      raw_margin: r2(num(pr.fair)),
      reconciles: null
    };
    var sum = rating + (num(c.hfa) || 0) + (num(c.qb) || 0) + (num(c.injury) || 0) + (num(c.matchup) || 0)
      + (num(c.conference) || 0) + (num(c.schedule) || 0) + (num(c.travel) || 0) + (num(c.rivalry) || 0);
    out.reconciles = num(pr.fair) != null && abs(sum - pr.fair) < 0.01;
    out.unexplained = num(pr.fair) == null ? null : r2(pr.fair - sum);
    if (marketLine != null) {
      /* BASE RATING GAP: does raw team strength plus home field already
         disagree with the market, before any game-specific adjustment? */
      out.base_rating_gap = r2(rating + (num(c.hfa) || 0) - marketLine);
      out.adjustments_gap = r2((num(pr.fair) || 0) - rating - (num(c.hfa) || 0));
    }
    return out;
  };

  /* ================================================ the gate */
  function groupStatus(items, group, historical) {
    var g = items.filter(function (i) { return i.group === group; });
    if (!g.length) return 'NOT_RUN';
    if (g.some(function (i) { return i.status === 'FAIL'; })) return 'FAIL';
    if (g.some(function (i) { return i.status === 'INCOMPLETE'; })) return 'INCOMPLETE';
    return 'PASS';
  }
  var CAUSE_PRIORITY = ['GAME_MAPPING_ERROR', 'HOME_AWAY_ERROR', 'MARKET_JOIN_ERROR', 'STALE_MARKET', 'THIN_MARKET',
    'QB_STATUS_ERROR', 'PLAYER_AVAILABILITY_ERROR', 'ROSTER_DOUBLE_COUNT', 'FCS_TRANSLATION_ERROR',
    'EARLY_SEASON_PRIOR_ERROR', 'OPPONENT_ADJUSTMENT_ERROR', 'CROSS_CONFERENCE_SCALE_ERROR', 'MATCHUP_OVERADJUSTMENT',
    'HFA_ERROR', 'TRAVEL_OR_REST_ERROR', 'EXTREME_FAVORITE_NONLINEARITY', 'TEAM_RATING_ERROR', 'RECENT_FORM_OVERREACTION', 'UNKNOWN'];

  D.evaluate = function (x, over) {
    var P;
    try { P = D.params(over); } catch (e) { P = D.DEFAULTS; }
    try { return evaluateInner(x || {}, P); }
    catch (e) {
      return failSafe(x || {}, 'verification threw: ' + String(e && e.message || e));
    }
  };
  function failSafe(x, why) {
    var raw = null;
    try {
      var f = num(x.projection && x.projection.fair), m = num(x.market && x.market.spread);
      raw = (f != null && m != null) ? f - m : null;
    } catch (_) { raw = null; }
    return { version: D.version, available: raw != null, raw_market_gap: raw == null ? null : r2(raw),
      raw_gap_abs: raw == null ? null : r2(abs(raw)), verified: false, verified_market_gap: null,
      status: 'INVESTIGATE', status_label: 'INVESTIGATE — VERIFICATION INCOMPLETE',
      tone: D.STATUS.INVESTIGATE.tone, verification: 'INCOMPLETE', fail_safe: true, reason: why,
      checks: [], root_cause: { primary: 'UNKNOWN', candidates: [] } };
  }

  function evaluateInner(x, P) {
    var pr = x.projection, m = x.market || {};
    var fair = pr ? num(pr.fair) : null, line = num(m.spread);
    var base = { version: D.version, contract: 'raw_market_gap = pure fair margin - market margin (home perspective); the pure fair spread is never altered' };
    if (fair == null) return merge(base, { available: false, status: null, reason: 'no priced projection' });
    if (line == null) return merge(base, { available: false, status: m.fault ? 'DATA_FAULT' : null,
      status_label: m.fault ? D.STATUS.DATA_FAULT.label : null, tone: m.fault ? D.STATUS.DATA_FAULT.tone : null,
      reason: m.fault ? 'the joined line was dropped for pointing the opposite way' : 'no market line to compare' });

    var gap = fair - line, g = abs(gap);
    var tier = tierOf(g, P);
    var flip = sign(fair) !== 0 && sign(line) !== 0 && sign(fair) !== sign(line);
    var isNeutral = x.game ? x.game.neutral_site : null;
    var calM = D.calibratedMargin(pr, isNeutral, P);
    var cal = { margin: r2(calM), gap: calM == null ? null : r2(calM - line), raw_gap: gap,
      version: P.calibration && P.calibration.version, slope: P.calibration && P.calibration.slope, hfa: P.calibration && P.calibration.hfa };
    var dec = D.decompose(x, line);
    var home = (x.game || {}).home || 'Home', away = (x.game || {}).away || 'Away';
    var out = merge(base, {
      available: true,
      raw_market_gap: r2(gap), raw_gap_abs: r2(g),
      direction: gap > 0 ? 'home' : (gap < 0 ? 'away' : null),
      toward_team: gap > 0 ? home : (gap < 0 ? away : null),
      tier: tier ? tier.id : (g >= P.research_gap ? 'RESEARCH' : 'NONE'),
      favorite_flip: flip,
      edgedesk_favorite: fair > 0 ? home : (fair < 0 ? away : null),
      market_favorite: line > 0 ? home : (line < 0 ? away : null),
      calibrated: { margin: cal.margin, gap: cal.gap,
        survives: cal.gap == null ? null : (tier ? abs(cal.gap) >= P.tiers[0].min && sign(cal.gap) === sign(gap) : null),
        tier: cal.gap == null || sign(cal.gap) !== sign(gap) ? null : ((tierOf(abs(cal.gap), P) || {}).id || null),
        version: cal.version, slope: cal.slope, hfa: cal.hfa, basis: 'football-only: fitted to final margins, never to the market; shadow, not the priced number' },
      decomposition: dec,
      checks: [], warnings: [], manual_review: false
    });
    /* set outright: merge() skips nulls by design, and an unverified gap must
       carry an explicit null, never an absent field */
    out.verified = false;
    out.verified_market_gap = null;

    /* ---- under 7: the ordinary labels ---- */
    if (!tier) {
      var items0 = [];
      if (m.fault) items0.push(item('GAME', 'orientation', 'FAIL', 'the joined line only reconciles once negated', 'HOME_AWAY_ERROR'));
      out.checks = items0;
      if (m.fault) return finish(out, 'DATA_FAULT', 'DATA FAULT', P);
      if (m.stale) { out.market_note = 'stale quote'; }
      return finish(out, g >= P.research_gap ? 'WORTH_RESEARCHING' : 'MARKET_ALIGNED', null, P);
    }

    /* ---- 7+: every check, stricter by tier ---- */
    var items = [], warnings = [];
    var effTier = tier.id;
    gameChecks(x, P, items);
    marketChecks(x, P, effTier, items);
    teamStateChecks(x, P, effTier, flip, items);
    qbChecks(x, P, effTier, flip, items);
    rosterChecks(x, P, effTier, items);
    componentChecks(x, P, effTier, gap, items, warnings);
    var cm = crossModel(x, P, gap, line);
    calibrationCheck(x, P, effTier, items, cal);
    modelChecks(x, P, effTier, flip, cm, items);
    out.checks = items;
    out.warnings = warnings;
    out.cross_model = cm;
    out.groups = {};
    ['GAME', 'MARKET', 'TEAM_STATE', 'QB', 'ROSTER', 'COMPONENT', 'MODEL'].forEach(function (gr) {
      out.groups[gr] = groupStatus(items, gr, x.historical);
    });
    var fails = items.filter(function (i) { return i.status === 'FAIL'; });
    var incompl = items.filter(function (i) { return i.status === 'INCOMPLETE'; });
    out.failed = fails.map(function (i) { return i.group + '.' + i.id; });
    out.incomplete = incompl.map(function (i) { return i.group + '.' + i.id; });
    var causes = [];
    fails.forEach(function (i) { if (i.cause && causes.indexOf(i.cause) < 0) causes.push(i.cause); });
    causes.sort(function (a, b) { return CAUSE_PRIORITY.indexOf(a) - CAUSE_PRIORITY.indexOf(b); });
    out.root_cause = { primary: fails.length ? (causes[0] || 'UNKNOWN') : (incompl.length ? 'UNKNOWN' : 'VALID_MODEL_DISAGREEMENT'),
      candidates: causes, basis: fails.length ? 'the first failing integrity check, in fixed priority order'
        : (incompl.length ? 'verification incomplete: a cause cannot be named, so none is invented' : 'every integrity check passed') };
    out.flags = [];
    if (flip) out.flags.push('FAVORITE_FLIP');
    if (tier.id === 'MAJOR_15') { out.manual_review = true; out.flags.push('MANUAL_REVIEW'); }
    if (g > P.guard_gap) out.flags.push('PAST_GUARD');
    if (tier.min >= 10) out.flags.push('GATE_' + tier.min);
    out.explanation = explain(out, x, P);

    var dataFail = fails.some(function (i) { return i.group === 'GAME' || (i.group === 'MODEL' && i.id === 'distribution'); });
    var marketFail = fails.some(function (i) { return i.group === 'MARKET'; });
    if (dataFail) return finish(out, 'DATA_FAULT', null, P);
    if (marketFail) return finish(out, 'MARKET_FAULT', null, P);
    if (fails.length) {
      if (g > P.guard_gap) return finish(out, 'DATA_FAULT', 'DATA FAULT — ' + r1(g) + ' pts past the guard and not verified', P);
      return finish(out, 'INVESTIGATE', 'INVESTIGATE — ' + humanCause(out.root_cause.primary), P);
    }
    if (incompl.length) return finish(out, 'INVESTIGATE', 'INVESTIGATE — VERIFICATION INCOMPLETE', P);
    out.verified = true;
    out.verified_market_gap = r2(gap);
    /* the checks ran at the RAW gap's tier (larger gaps, stricter checks);
       the label claims only the size the calibrated gap supports */
    var shown = tierOf(Math.min(g, out.calibrated && out.calibrated.gap != null ? abs(out.calibrated.gap) : g), P) || tier;
    out.verified_tier = shown.id;
    var lab = 'VERIFIED MAJOR DISAGREEMENT' + (shown.min >= 15 ? ' · EXTRAORDINARY ' + shown.min + '+'
      : (shown.min >= 10 ? ' · ' + shown.min + '+' : '')) + (out.manual_review ? ' · MANUAL REVIEW QUEUED' : '');
    return finish(out, 'VERIFIED_MAJOR_DISAGREEMENT', lab, P);
  }
  function humanCause(c) {
    return String(c || 'UNKNOWN').replace(/_/g, ' ');
  }
  function finish(out, status, label, P) {
    out.status = status;
    out.status_label = label || D.STATUS[status].label;
    out.tone = D.STATUS[status].tone;
    out.verification = out.tier && /^MAJOR/.test(out.tier) ? (out.verified ? 'PASSED' : (status === 'INVESTIGATE' && out.incomplete && out.incomplete.length && !(out.failed || []).length ? 'INCOMPLETE' : 'FAILED')) : 'NOT_REQUIRED';
    out.not_a_bet = 'Verification says the model genuinely disagrees and the disagreement survived integrity checks. It is not a bet: '
      + 'bet eligibility still needs a calibrated cover probability, a positive expected value at a valid, fresh price, acceptable uncertainty and the decision layer’s threshold.';
    return out;
  }

  /* ================================================ explanation */
  function sideText(v, home, away) {
    if (v == null) return null;
    if (abs(v) < 0.05) return '0.0';
    return (v > 0 ? '+' : '-') + abs(v).toFixed(1) + ' ' + (v > 0 ? home : away);
  }
  function lineText(margin, home, away) {
    if (margin == null) return null;
    if (abs(margin) < 0.05) return 'Pick’em';
    return (margin > 0 ? home : away) + ' -' + abs(margin).toFixed(1);
  }
  function explain(o, x, P) {
    var home = (x.game || {}).home || 'Home', away = (x.game || {}).away || 'Away';
    var d = o.decomposition || {}, m = x.market || {};
    var srcs = [
      ['Base team strength', d.neutral_strength], ['  of which long-term state', d.long_term_state],
      ['  of which current-season form', d.current_form], ['Home field', d.home_field],
      ['QB', d.qb], ['Injuries', d.injuries], ['Matchup', d.matchup], ['Conference strength', d.conference],
      ['Rest/travel', d.rest_travel], ['Weather', d.weather], ['Other', d.other]
    ].filter(function (r) { return r[1] != null; }).map(function (r) { return { label: r[0], points: r[1], text: r[0] + ': ' + sideText(r[1], home, away) }; });
    var cm = o.cross_model || {};
    var ens = cm.available ? (cm.ensemble_sd == null ? 'available' : (cm.ensemble_sd <= 3 ? 'tight' : (cm.ensemble_sd <= 6 ? 'moderate' : 'wide'))
      + ' (SD ' + r1(cm.ensemble_sd) + ')') : 'unavailable';
    return {
      edgedesk: lineText(num((x.projection || {}).fair), home, away),
      market: lineText(num(m.spread), home, away),
      raw_gap: r1(o.raw_gap_abs),
      calibrated_gap: o.calibrated && o.calibrated.gap != null ? r1(abs(o.calibrated.gap)) : null,
      toward: o.toward_team,
      favorite_flip: !!o.favorite_flip,
      base_rating_gap: d.base_rating_gap == null ? null : sideText(d.base_rating_gap, home, away),
      sources: srcs,
      equation: 'raw game margin ' + (d.raw_margin == null ? '—' : d.raw_margin.toFixed(2)) + ' = the sum of the terms above'
        + (d.reconciles ? ' (reconciles)' : ' (DOES NOT RECONCILE: ' + d.unexplained + ')')
        + '; football-only calibrated ' + (o.calibrated && o.calibrated.margin != null ? o.calibrated.margin.toFixed(2) : '—')
        + ' (shadow); the priced fair spread is the raw margin',
      market_summary: (num(m.books) != null ? m.books + ' book' + (m.books === 1 ? '' : 's') : 'book count unknown')
        + (m.as_of ? ', captured ' + m.as_of : '') + (m.stale ? ' (stale)' : ''),
      ensemble: ens,
      submodels: (cm.projections || []).map(function (p) { return p.model + ': ' + lineText(p.margin, home, away) + ' (' + p.stance + ')'; })
    };
  }

  /* ================================================ market movement after a verified gap */
  /* prev: the evaluation when the gap was verified; now: the current market
     {spread, books, as_of}. Returns MOVED_TOWARD | UNCHANGED | MOVED_AWAY,
     and RECHECK_REQUIRED when a verified gap widens by the recheck bound on
     a multi-book market. It never changes the pure projection. */
  D.movement = function (prev, nowMarket, over) {
    var P = D.params(over);
    if (!prev || prev.raw_market_gap == null || !nowMarket || num(nowMarket.spread) == null || num(prev.market_line) == null && num(prev.market_spread) == null)
      return { state: 'UNKNOWN', recheck: false };
    var from = num(prev.market_line) != null ? prev.market_line : prev.market_spread;
    var mv = nowMarket.spread - from, s = sign(prev.raw_market_gap);
    var toward = sign(mv) === s ? mv : -abs(mv);
    var st = abs(mv) < 0.25 ? 'UNCHANGED' : (sign(mv) === s ? 'MOVED_TOWARD' : 'MOVED_AWAY');
    var recheck = prev.verified === true && st === 'MOVED_AWAY' && abs(mv) >= P.recheck_move
      && (num(nowMarket.books) == null || nowMarket.books >= 2);
    return { state: st, points: r2(abs(mv)), toward_points: r2(toward), recheck: recheck,
      action: recheck ? 'RECHECK_REQUIRED: revalidate QB, injuries, roster, news and source freshness. The pure projection is NOT changed by the move.' : null };
  };

  /* ================================================ the slate circuit breaker */
  function poissonTail(k, lam) {        /* P(X >= k) */
    if (k <= 0) return 1;
    var p = Math.exp(-lam), c = p, i;
    for (i = 1; i < k; i++) { p *= lam / i; c += p; }
    return Math.max(0, 1 - c);
  }
  function weekBucket(w) { return w == null ? '6p' : (w <= 2 ? '0_2' : (w <= 5 ? '3_5' : '6p')); }
  D.weekBucket = weekBucket;
  /* evals: gate results for one slate, each with .raw_gap_abs and .week (the
     caller copies the week on). Counts the raw gaps against their historical
     frequency; MODEL_SCALE_ALERT when the slate is improbably extreme. It
     investigates, it never suppresses. */
  D.circuitBreaker = function (evals, over) {
    var P = D.params(over), R = P.circuit.rate;
    var withGap = (evals || []).filter(function (e) { return e && e.available && num(e.raw_gap_abs) != null; });
    var obs = { g7: 0, g10: 0, g15: 0 }, exp = { g7: 0, g10: 0, g15: 0 };
    var signed = [], homeS = [];
    withGap.forEach(function (e) {
      var b = R[weekBucket(e.week)] || R['6p'];
      exp.g7 += b.g7; exp.g10 += b.g10; exp.g15 += b.g15;
      if (e.raw_gap_abs >= 7) obs.g7++;
      if (e.raw_gap_abs >= 10) obs.g10++;
      if (e.raw_gap_abs >= 15) obs.g15++;
      signed.push(e.raw_market_gap);
    });
    var tails = { g7: poissonTail(obs.g7, exp.g7), g10: poissonTail(obs.g10, exp.g10), g15: poissonTail(obs.g15, exp.g15) };
    var alert = withGap.length >= 10 && (tails.g7 < P.circuit.alert_p || tails.g10 < P.circuit.alert_p || tails.g15 < P.circuit.alert_p);
    var mean = signed.length ? signed.reduce(function (s, v) { return s + v; }, 0) / signed.length : null;
    var sd = signed.length > 1 ? Math.sqrt(signed.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / (signed.length - 1)) : null;
    var zc = (mean != null && sd != null && signed.length >= 10) ? mean / (sd / Math.sqrt(signed.length)) : null;
    return {
      games: withGap.length, observed: obs,
      expected: { g7: r1(exp.g7), g10: r1(exp.g10), g15: r1(exp.g15) },
      p_at_least: { g7: r2(tails.g7), g10: r2(tails.g10), g15: r2(tails.g15) },
      alert: alert ? 'MODEL_SCALE_ALERT' : null,
      alert_why: alert ? 'this slate carries more large raw gaps than history makes plausible (Poisson tail < ' + P.circuit.alert_p
        + '). Investigate the rating scale, conference scale, the latest update and the market join. Nothing is suppressed.' : null,
      mean_signed_gap: r2(mean), zero_center_z: r2(zc),
      zero_center_alert: zc != null && abs(zc) > 3 ? 'the slate’s gaps lean ' + (mean > 0 ? 'toward home teams' : 'toward road teams') + ' (z ' + r1(zc) + ')' : null
    };
  };

  /* ================================================ historical grading
     The FALSE-EXTREME definition, stated once. A raw 7+ gap is a false
     extreme when BOTH hold: the closing market did not move toward EdgeDesk
     (it held or moved away), AND the final margin landed on the market's
     side of the disagreement or within its first quarter. A losing ticket is
     not enough — a game that lost ATS after the market moved toward
     EdgeDesk had a good price and is not counted. */
  D.falseExtreme = function (o) {
    var f = num(o.fair), open = num(o.open), close = num(o.close), y = num(o.final_margin);
    if (f == null || open == null || close == null || y == null) return null;
    var gap = f - open;
    if (abs(gap) < 7) return null;
    var s = sign(gap), moved = (close - open) * s;
    var landing = (y - open) * s;           /* 0 at the market, |gap| at EdgeDesk */
    return moved <= 0 && landing <= abs(gap) / 4;
  };

  return D;
});
