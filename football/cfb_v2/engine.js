/* ============================================================================
   EdgeDesk CFB V2 — production inference (browser + node, ES5, no deps).

   Two outputs, never merged:

     pure(row, overlays)          -> PURE MODEL PROJECTION
        what EdgeDesk believes from football information alone. The row is a
        FROZEN pregame snapshot written by the weekly pipeline
        (football/cfb_v2/research); this function only applies the live
        overlays it is allowed to apply (quarterback status, availability,
        forecast) and turns the calibrated error model into probabilities and
        intervals. It never reads a sportsbook number.

     decide(pure, market, opts)   -> MARKET DECISION PROJECTION
        reads the frozen pure projection and the market, and answers whether
        the price is far enough from the calibrated distribution to act.
        It never writes into `pure` (the pure object is deep-frozen).

   SIGN CONVENTION (critical infrastructure):
     internal margin  > 0  = HOME projected to win by that many points
     book home line   -7   = home laying 7        (margin = -line)
   Conversion happens ONCE, in bookToMargin/marginToBook, at this boundary.
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbV2 = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var ENGINE_ID = 'edgedesk_cfb_v2';

  function params() {
    var P = root.EDCfbV2Params || null;
    if (!P && typeof require === 'function') {
      try { require('./params.js'); P = root.EDCfbV2Params || null; } catch (e) { P = null; }
    }
    return P;
  }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  function r2(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 2 : k); return Math.round(x * m) / m; }

  /* ------------------------------------------------------ sign boundary */
  var conv = {
    bookToMargin: function (homeLine) { return isNum(homeLine) ? -homeLine : null; },
    marginToBook: function (margin) { return isNum(margin) ? -margin : null; },
    /* display: "ALA -7.5" for the favourite, from an internal margin */
    display: function (margin, homeName, awayName) {
      if (!isNum(margin)) return null;
      var half = Math.round(Math.abs(margin) * 2) / 2;
      if (half === 0) return 'PICK';
      return (margin > 0 ? homeName : awayName) + ' -' + half.toFixed(1);
    }
  };

  /* --------------------------------------------- Student-t CDF (exact) */
  function lgamma(x) {
    var c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
             -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, t = x + 5.5, s = 1.000000000190015, j;
    t -= (x + 0.5) * Math.log(t);
    for (j = 0; j < 6; j++) s += c[j] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  function betacf(a, b, x) {
    var MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300, m, m2, aa, c = 1, d, del, h, qab = a + b, qap = a + 1, qam = a - 1;
    d = 1 - qab * x / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; h = d;
    for (m = 1; m <= MAXIT; m++) {
      m2 = 2 * m;
      aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function ibeta(a, b, x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  /* standardized t: unit variance, df > 2 */
  function tCdf(z, df) {
    var s = Math.sqrt((df - 2) / df), x = z / s;
    var p = 0.5 * ibeta(df / 2, 0.5, df / (df + x * x));
    return x > 0 ? 1 - p : p;
  }

  /* ---------------------------------------------------------- helpers */
  function logit(p) { p = clamp(p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); }
  function sigm(x) { return 1 / (1 + Math.exp(-x)); }
  function americanToPayout(a) { return a > 0 ? a / 100 : 100 / (-a); }
  function breakEven(a) { return isNum(a) ? 1 / (1 + americanToPayout(a)) : null; }
  function calibrateWin(p, C) {
    if (!C || C.method === 'raw') return p;
    if (C.method === 'platt') return sigm(C.platt[0] + C.platt[1] * logit(p));
    if (C.method === 'iso') {                  /* piecewise-linear through the isotonic knots */
      var xs = C.iso.x, ys = C.iso.y, i;
      if (p <= xs[0]) return ys[0];
      for (i = 1; i < xs.length; i++) if (p <= xs[i]) {
        var w = (p - xs[i - 1]) / Math.max(1e-12, xs[i] - xs[i - 1]);
        return ys[i - 1] + w * (ys[i] - ys[i - 1]);
      }
      return ys[ys.length - 1];
    }
    return p;
  }

  /* ------------------------------------------------ live overlays: QB */
  var STATUS_KEYS = { CONFIRMED: 'confirmed', ACTIVE: 'confirmed', PROBABLE: 'probable',
    QUESTIONABLE: 'questionable', GTD: 'gtd', 'GAME-TIME DECISION': 'gtd', GAME_TIME_DECISION: 'gtd',
    DOUBTFUL: 'doubtful', OUT: 'out' };

  function qbOverlay(side, snap, status, P) {
    /* expected value AND uncertainty. The frozen projection assumes the
       expected starter (the team's most recent starter). A status report
       moves the mean by (1-p) x the starter->backup drop-off in points and
       adds p(1-p) x drop^2 of variance. With no report at all, p is the
       measured historical probability that the most recent starter starts
       again — never assumed to be 1. */
    var Q = P.qb || {}, key = status ? STATUS_KEYS[String(status).toUpperCase()] : null;
    var p = key ? Q.status_start_prob[key] : Q.same_starter_prob;
    var drop = (snap && isNum(snap.exp_rating) && isNum(snap.backup_rating))
      ? snap.backup_rating - snap.exp_rating : null;       /* EPA/dropback, usually < 0 */
    if (!isNum(p) || drop === null) {
      return { side: side, status: key || 'unknown', start_prob: isNum(p) ? p : null, mean_pts: 0,
        var_pts: isNum(Q.unknown_var_pts) ? Q.unknown_var_pts : 0,
        basis: drop === null ? 'no quarterback history for this team this season: variance only'
          : 'no start probability for this status' };
    }
    var dropPts = (Q.points_per_epa_db || 0) * drop;
    return { side: side, status: key || 'unknown', start_prob: p,
      mean_pts: Q.applied ? (1 - p) * dropPts : 0,
      var_pts: p * (1 - p) * dropPts * dropPts,
      drop_pts: r2(dropPts, 2), applied: !!Q.applied,
      basis: (key ? 'reported status ' + key : 'no status report: measured same-starter rate')
        + (Q.applied ? '' : ' — mean shift NOT applied (coefficient not validated); variance only') };
  }

  /* ---------------------------------------- live overlays: availability */
  var UNITS = ['OL', 'SKILL', 'FRONT7', 'SECONDARY'];
  var OUT_PROB = { OUT: 1, DOUBTFUL: 0.8, QUESTIONABLE: 0.5, GTD: 0.5, PROBABLE: 0.15, ACTIVE: 0 };
  function injuryOverlay(list, P) {
    /* Value lost per unit = sum(usage_share x P(out)), CAPPED per unit and
       across the whole team so three missing linemen are one weakened line,
       not three independent penalties plus a rushing penalty plus a
       pressure penalty. No position coefficient was trainable from public
       data, so the mean moves 0 points and the capped value WIDENS the
       distribution (params.injury.points_applied === false). */
    /* Diminishing marginal effect (red-team hardening): within a unit the
       expected lost usage x is mapped through cap * (1 - exp(-x / cap)), so
       every additional absence costs less than the one before and the unit
       can never exceed its cap; the team total uses the same saturating form.
       replacement_quality (0 = no usable backup .. 1 = like-for-like backup)
       shrinks a player's contribution when depth information is supplied. */
    var I = P.injury || {}, caps = I.unit_caps || {}, raw = {}, lost = {}, total = 0, u;
    UNITS.forEach(function (k) { raw[k] = 0; lost[k] = 0; });
    (list || []).forEach(function (x) {
      var unit = String(x.unit || '').toUpperCase();
      if (raw[unit] == null) return;
      var po = OUT_PROB[String(x.status || '').toUpperCase()];
      if (!isNum(po)) po = 0.5;              /* unknown status: a coin flip, never assumed active */
      var rq = isNum(x.replacement_quality) ? clamp(x.replacement_quality, 0, 1) : 0;
      raw[unit] += clamp(isNum(x.usage_share) ? x.usage_share : 0, 0, 1) * po * (1 - rq);
    });
    for (u in raw) if (raw.hasOwnProperty(u)) {
      var cu = isNum(caps[u]) ? caps[u] : 1;
      lost[u] = cu * (1 - Math.exp(-raw[u] / cu));
      total += lost[u];
    }
    var tc = isNum(I.team_cap) ? I.team_cap : 1.5;
    total = tc * (1 - Math.exp(-total / tc));
    var sdPts = (I.var_pts_per_unit || 0) * total;
    return { units: lost, capped_total: r2(total, 3), mean_pts: 0, var_pts: sdPts * sdPts,
      supplied: !!(list && list.length), points_applied: !!I.points_applied };
  }

  function weatherOverlay(wx, P) {
    var W = P.weather || {};
    if (!wx) return { supplied: false, var_pts: 0, mean_pts: 0 };
    if (wx.dome) return { supplied: true, var_pts: 0, mean_pts: 0, basis: 'indoor' };
    var wind = isNum(wx.wind_mph) ? wx.wind_mph : 0;
    var over = Math.max(0, wind - (W.wind_threshold_mph || 15));
    var sd = (W.var_pts_per_wind_mph || 0) * over;
    return { supplied: true, var_pts: sd * sd, mean_pts: 0, wind_mph: wind,
      points_applied: !!W.points_applied, basis: 'forecast widens the interval only' };
  }

  /* ======================================================== PURE MODEL */
  function pure(row, overlays) {
    var P = params();
    if (!P) return { status: 'BLOCKED', reason: 'EDCfbV2Params not loaded' };
    if (row && row.priced === false) {
      return { status: 'NOT_PRICED', reason: row.not_priced_reason || 'not priced by V2',
        model_version: P.model_version, game_id: row.game_id };
    }
    if (!row || !isNum(row.ens_pred) || !isNum(row.sigma)) {
      return { status: 'INSUFFICIENT_DATA', reason: 'no frozen V2 snapshot for this game',
        model_version: P.model_version };
    }
    overlays = overlays || {};
    /* hindsight guard: a status report stamped at/after kickoff (a final
       inactive list, a postgame injury report) is refused, never applied */
    var refused = null;
    if (overlays.as_of && row.kickoff && Date.parse(overlays.as_of) >= Date.parse(row.kickoff)) {
      refused = 'overlays stamped ' + overlays.as_of + ' are at/after kickoff: refused (hindsight)';
      overlays = {};
    }
    var qH = qbOverlay('home', row.qb && row.qb.home, overlays.qb_status && overlays.qb_status.home, P);
    var qA = qbOverlay('away', row.qb && row.qb.away, overlays.qb_status && overlays.qb_status.away, P);
    var iH = injuryOverlay(overlays.injuries && overlays.injuries.home, P);
    var iA = injuryOverlay(overlays.injuries && overlays.injuries.away, P);
    var wx = weatherOverlay(overlays.weather, P);
    var mu = row.ens_pred + qH.mean_pts - qA.mean_pts;
    var sigma = Math.sqrt(row.sigma * row.sigma + qH.var_pts + qA.var_pts + iH.var_pts + iA.var_pts + wx.var_pts);
    var df = P.distribution.t_df, zq = P.distribution.abs_z_quantiles;
    var pRaw = 1 - tCdf(-mu / sigma, df);
    var pHome = calibrateWin(pRaw, P.calibration && P.calibration.win);
    var rel = reliability(row, sigma, qH, qA, iH, iA, P);
    var out = {
      status: 'PREDICTED', engine: ENGINE_ID, layer: 'pure_model_projection',
      model_version: P.model_version, feature_version: P.feature_version,
      game_id: row.game_id, season: row.season, week: row.week,
      home: row.home, away: row.away, neutral_site: !!row.neutral_site,
      prediction_ts: row.prediction_ts, feature_ts: row.feature_ts, kickoff: row.kickoff,
      projected_margin: r2(mu, 2),                  /* + = home */
      fair_spread_home_line: r2(conv.marginToBook(mu), 2),
      fair_spread_display: conv.display(mu, row.home, row.away),
      fair_total: r2(row.fair_total, 1),
      home_win_prob: r2(pHome, 4), away_win_prob: r2(1 - pHome, 4), home_win_prob_raw: r2(pRaw, 4),
      sigma: r2(sigma, 3), sigma_frozen: r2(row.sigma, 3), t_df: df,
      intervals: {
        p50: [r2(mu - zq['0.5'] * sigma, 1), r2(mu + zq['0.5'] * sigma, 1)],
        p80: [r2(mu - zq['0.8'] * sigma, 1), r2(mu + zq['0.8'] * sigma, 1)],
        p95: [r2(mu - zq['0.95'] * sigma, 1), r2(mu + zq['0.95'] * sigma, 1)]
      },
      components: row.components || null, stack_weights: row.stack_weights || null,
      ensemble_sd: r2(row.ens_sd, 2),
      football_prediction_confidence: rel.score, confidence_basis: rel.basis,
      drivers: row.drivers || [], uncertainty_drivers: row.uncertainty_drivers || [],
      overlays: { qb_home: qH, qb_away: qA, injuries_home: iH, injuries_away: iA, weather: wx },
      data_quality: row.data_quality || null,
      overlay_refused: refused
    };
    return deepFreeze(out);
  }

  function reliability(row, sigma, qH, qA, iH, iA, P) {
    var R = P.reliability, caps = R.caps, basis = [];
    var s = 100 * clamp((R.sigma_hi - sigma) / Math.max(1e-6, R.sigma_hi - R.sigma_lo), 0, 1);
    var cap = 100;
    if (row.fcs_game) { cap = Math.min(cap, caps.fcs); basis.push('FCS participant'); }
    if (isNum(row.min_games) && row.min_games < 1) { cap = Math.min(cap, caps.no_games); basis.push('a team has no game this season'); }
    if (row.qb_unsettled_any) { cap = Math.min(cap, caps.qb_unsettled); basis.push('quarterback unsettled'); }
    if (row.qb_missing_any) { cap = Math.min(cap, caps.qb_unknown); basis.push('quarterback unknown'); }
    [qH, qA].forEach(function (q) {
      if (q.status === 'questionable' || q.status === 'gtd' || q.status === 'doubtful') {
        cap = Math.min(cap, caps.qb_unsettled); basis.push(q.side + ' QB ' + q.status);
      }
    });
    return { score: Math.round(Math.min(s, cap)), basis: basis.length ? basis : ['error model only'] };
  }

  /* ================================================== MARKET DECISION */
  function consensus(books) {
    /* main lines only: an alternate spread is a different bet, never a consensus input */
    var xs = (books || []).filter(function (b) { return b && !b.alternate; })
      .map(function (b) { return b.home_line; }).filter(isNum).sort(function (a, b) { return a - b; });
    if (!xs.length) return null;
    var mid = Math.floor(xs.length / 2);
    var med = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    var q1 = xs[Math.floor((xs.length - 1) * 0.25)], q3 = xs[Math.ceil((xs.length - 1) * 0.75)];
    return { home_line: med, n: xs.length, iqr: q3 - q1 };
  }

  function pushProb(line, table) {
    if (!isNum(line) || Math.abs(line - Math.round(line)) > 1e-9) return 0;
    var a = Math.abs(line), k, lo, hi;
    for (k in table) if (table.hasOwnProperty(k)) {
      lo = parseFloat(k.split('-')[0]); hi = parseFloat(k.split('-')[1]);
      if (a >= lo && a <= hi) return table[k];
    }
    return 0.02;
  }

  function coverDesign(pure, row, pRaw) {
    var x = logit(pRaw);
    var ensSd = ((row && isNum(row.ens_sd)) ? row.ens_sd : 3) - 3;
    var fill = (params().cover && isNum(params().cover.rsd_fill)) ? params().cover.rsd_fill : 1;
    var rsd = ((row && isNum(row.rating_sd_sum)) ? row.rating_sd_sum : fill) - 1;
    var early = row && row.early_season ? 1 : 0;
    var qbu = (row && row.qb_unsettled_any ? 1 : 0) + (row && row.qb_missing_any ? 1 : 0);
    return [1, x, x * ensSd / 2, x * rsd, x * early, x * qbu];
  }

  function decide(pureProj, market, opts) {
    var P = params(), M = P.market, now = (opts && opts.now) ? Date.parse(opts.now) : Date.now();
    var row = (opts && opts.row) || {};
    var out = { layer: 'market_decision_projection', model_version: P.model_version,
      game_id: pureProj && pureProj.game_id, decided_at: new Date(now).toISOString(),
      pure_fair_margin: pureProj ? pureProj.projected_margin : null, status: 'PASS', reasons: [] };
    if (!pureProj || pureProj.status !== 'PREDICTED') {
      out.reasons.push('no pure projection'); return deepFreeze(out);
    }
    market = market || {};
    var books = market.books || [];
    var cons = consensus(books);
    var cur = market.current || (cons ? { home_line: cons.home_line, ts: market.ts } : null);
    if (!cur || !isNum(cur.home_line)) { out.reasons.push('no market line'); return deepFreeze(out); }
    var ageMin = cur.ts ? (now - Date.parse(cur.ts)) / 60000 : null;
    if (!isNum(ageMin)) { out.reasons.push('market timestamp unknown — not actionable'); out.stale = true; }
    else if (ageMin > (M.stale_minutes || 180)) { out.reasons.push('stale market (' + Math.round(ageMin) + ' min old)'); out.stale = true; }
    var mktMargin = conv.bookToMargin(cur.home_line);
    out.current_home_line = cur.home_line;
    out.current_market_margin = mktMargin;
    if (market.open && isNum(market.open.home_line)) {
      out.open_home_line = market.open.home_line;
      out.line_move_home_pts = r2(conv.bookToMargin(cur.home_line) - conv.bookToMargin(market.open.home_line), 2);
    }
    out.market_dispersion_iqr = cons ? cons.iqr : null;
    out.books = cons ? cons.n : (market.current ? 1 : 0);
    var gap = pureProj.projected_margin - mktMargin;            /* + = model likes HOME */
    out.raw_gap_pts = r2(gap, 2);
    /* the same orientation guard V1 runs: a disagreement that collapses when
       the market sign is flipped is a convention fault, not an edge */
    if (Math.abs(gap) > (M.orientation_gap || 21) && Math.abs(pureProj.projected_margin + mktMargin) <= (M.orientation_reconcile || 7)) {
      out.status = 'REVIEW'; out.data_fault = 'orientation';
      out.reasons.push('market number looks sign-flipped relative to the model — data check, never an edge');
      return deepFreeze(out);
    }
    var pRaw = 1 - tCdf((mktMargin - pureProj.projected_margin) / pureProj.sigma, pureProj.t_df);
    var A = coverDesign(pureProj, row, pRaw), b = P.cover.coef, z = 0, i;
    for (i = 0; i < b.length; i++) z += b[i] * A[i];
    var pcHome = sigm(z);
    var sideHome = pcHome >= 0.5;
    var pSide = sideHome ? pcHome : 1 - pcHome;
    var price = sideHome ? market.price_home : market.price_away;
    var pp = pushProb(cur.home_line, P.cover.push_table || {});
    out.side = sideHome ? 'HOME' : 'AWAY';
    out.cover_probability_raw = r2(sideHome ? pRaw : 1 - pRaw, 4);
    out.cover_probability = r2(pSide, 4);
    out.push_probability = r2(pp, 4);
    out.price_american = isNum(price) ? price : null;
    out.break_even_probability = isNum(price) ? r2(breakEven(price), 4) : null;
    out.expected_value_per_unit = isNum(price)
      ? r2(pSide * (1 - pp) * americanToPayout(price) - (1 - pSide) * (1 - pp), 4) : null;
    if (!isNum(price)) out.reasons.push('no price captured: EV not computable (never assumed -110)');
    out.clv_opportunity_pts = isNum(P.clv && P.clv.beta) ? r2(P.clv.beta * gap * (sideHome ? 1 : -1), 2) : null;
    if (isNum(out.line_move_home_pts) && out.line_move_home_pts !== 0) {
      out.market_moved = (out.line_move_home_pts > 0) === sideHome ? 'toward EdgeDesk' : 'away from EdgeDesk';
    }
    out.edge_reliability = pureProj.football_prediction_confidence;
    out.betting_edge_strength = isNum(out.expected_value_per_unit)
      ? Math.round(100 * clamp(out.expected_value_per_unit / 0.10, 0, 1)) : null;
    /* ------------------------------------------------ status, frozen rule */
    var R = M.rule, ev = out.expected_value_per_unit, ag = Math.abs(gap);
    if (out.stale || !isNum(ev)) { out.status = 'PASS'; return deepFreeze(out); }
    if (isNum(cons && cons.iqr) && cons.iqr > (M.dispersion_max || 1.5)) {
      out.reasons.push('books disagree by ' + cons.iqr + ' pts'); out.status = 'PASS'; return deepFreeze(out);
    }
    if (ag >= R.review_gap) {
      out.status = 'REVIEW';
      out.reasons.push('disagreement of ' + r2(ag, 1) + ' pts: historically a data or news gap more often than an edge');
      return deepFreeze(out);
    }
    if (ev <= R.lean_ev) { out.status = 'PASS'; out.reasons.push('insufficient edge after calibration and vig'); return deepFreeze(out); }
    var betOk = ev > R.bet_ev && ag >= R.bet_gap && pureProj.football_prediction_confidence >= R.bet_min_rel
      && !(R.exclude_early && row.early_season);
    if (betOk && M.bet_enabled) { out.status = 'BET'; out.reasons.push('meets the development-window rule'); }
    else {
      out.status = 'LEAN';
      out.reasons.push(betOk ? 'meets the rule, but BET is disabled: the rule did not validate out of sample'
        : 'positive calibrated EV below the BET rule');
    }
    return deepFreeze(out);
  }

  /* ============================================== the research card */
  var DRIVER_TEXT = {
    match_pass_edge: 'pass offense vs pass defense', match_rush_edge: 'rush offense vs rush defense',
    match_mix_edge: 'play-mix-weighted efficiency', match_trench_edge: 'line play (line yards, stuffs)',
    match_havoc_edge: 'disruption (sacks + run TFLs)', match_sack_edge: 'pass protection vs pass rush',
    match_explosive_edge: 'explosive plays', match_early_down_edge: 'early-down success',
    match_passing_down_edge: 'passing-down success', match_finishing_edge: 'finishing drives',
    match_field_pos_edge: 'field position', match_st_edge: 'special teams', edge_epa: 'overall efficiency',
    edge_ppd: 'points per drive', elo_diff: 'results-based strength', qb_delta_edge: 'quarterback change'
  };
  function card(p, d) {
    var why = (p.drivers || []).slice(0, 2).map(function (x) {
      return { label: DRIVER_TEXT[x.feature] || x.feature, favours: x.points > 0 ? p.home : p.away,
        points: r2(Math.abs(x.points), 1) };
    });
    var unc = (p.uncertainty_drivers || [])[0] || null;
    return {
      pure: { fair_spread: p.fair_spread_display, win_probability: p.home_win_prob,
        projected_margin: p.projected_margin, prediction_range_80: p.intervals.p80,
        model_confidence: p.football_prediction_confidence },
      why: { primary_matchup_edge: why[0] || null, secondary_matchup_edge: why[1] || null,
        main_uncertainty: unc },
      market: d ? { current_spread: d.current_home_line, edgedesk_disagreement_pts: d.raw_gap_pts,
        cover_probability: d.cover_probability, market_movement: d.market_moved || null,
        bet_quality: d.betting_edge_strength } : null,
      research_status: d ? d.status : 'PASS',
      reasons: d ? d.reasons : ['no market decision'],
      language: 'Research, not picks. Probabilities are estimates with measured error; nothing here is certain.'
    };
  }

  function meta() {
    var P = params();
    return P ? { model_version: P.model_version, feature_version: P.feature_version,
      trained_through: P.trained_through, promotion: P.promotion, generated_at: P.generated_at } : null;
  }

  return { ENGINE_ID: ENGINE_ID, conv: conv, tCdf: tCdf, breakEven: breakEven,
    pure: pure, decide: decide, card: card, meta: meta,
    _internal: { qbOverlay: qbOverlay, injuryOverlay: injuryOverlay, weatherOverlay: weatherOverlay,
      consensus: consensus, pushProb: pushProb, calibrateWin: calibrateWin, deepFreeze: deepFreeze } };
}));
