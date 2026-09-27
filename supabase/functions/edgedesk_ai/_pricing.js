// deno-lint-ignore-file
/*__EDPRICE_START__*/
/* ===========================================================================
   EdgeDesk PRICING KERNEL — the desk's own price, and the price at which a
   side is worth betting, from the validation record and nothing else.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHAT IT DOES
     1. FAIR LINE. The projection and the market are blended with the
        coefficients the pricing validation fitted on seasons BEFORE the one
        it scored (football/validation/pricing_<sport>.json). The market
        carries most of the weight because that is what the data said; the
        projection's coefficient is its measured incremental information.
        With no market on file the fair line is the projection and says so.
     2. COVER PROBABILITY at any line, from the blend's held-out residual
        sigma (a normal on the margin, with a one-point push mass on whole
        numbers). Labelled by the market's validation tier.
     3. BET-TO. The selection line at which the cover probability equals the
        break-even the quoted price requires, and the price at which the
        market line is worth taking. Both are arithmetic on the fair line,
        the sigma and the price; neither is a recommendation until the tier
        allows one.
     4. STATUS per side: PLAY (VALIDATED tier, disagreement at or past the
        required edge, price at or better than bet-to), LEAN_PLAY (LEAN
        tier: the graded record cleared break-even, not a profit),
        PASS (eligible tier, but the number or the price is not there),
        PROBABILITY (calibrated probabilities, no bet-to), CONDITIONAL
        (RESEARCH tier: the arithmetic is shown, labelled as conditional on
        an unvalidated projection, and is not a recommendation).
     5. RANKING across a slate: edge (cover probability minus break-even, in
        percentage points) times data completeness, with the status beside
        every row, so the strongest number on the board is the first thing
        the desk shows and a PASS is never sorted above a PLAY.
     6. SIZING only for a VALIDATED tier: a quarter-Kelly fraction capped at
        two percent, from the same cover probability. Otherwise null with
        the reason.
     7. MOVEMENT (Slice 6). From the opener, the current number and the fair
        line, and the validated movement tendency
        (football/validation/movement_<sport>.json): where the number tends
        to go, and BET NOW / WAIT per side. Only a LEAN or VALIDATED movement
        tier may say either; otherwise NO READ, with the reason. The size of
        a move is quoted only when the regression beat the no-move baseline.

   THE RULES
     - Nothing here claims a betting record. The tiers and their basis
       sentences come from the validation artifact and are quoted verbatim.
     - A RESEARCH market never emits PLAY or a sizing fraction, whatever the
       arithmetic says.
     - The critic extras fail an answer that says "bet to", "worth betting",
       "play" with a number, "EV" or "profitable" where the block did not.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPRICE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_pricing_v1';
  var CFB = 'americanfootball_ncaaf', NFL = 'americanfootball_nfl';
  var TIER_RANK = { VALIDATED: 3, LEAN: 2, PROBABILITY: 1, RESEARCH: 0 };
  var DEFAULT_SIGMA = { americanfootball_nfl: { spread: 13.2, total: 13.5 }, americanfootball_ncaaf: { spread: 16.3, total: 17 } };
  var KELLY_FRACTION = 0.25, KELLY_CAP = 0.02;
  var VALIDATION = {};
  var MOVEMENT = {};

  /* ---------------------------------------------------------------- util */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function r1(v) { var n = num(v); return n == null ? null : Math.round(n * 10) / 10; }
  function r2(v) { var n = num(v); return n == null ? null : Math.round(n * 100) / 100; }
  function r4(v) { var n = num(v); return n == null ? null : Math.round(n * 10000) / 10000; }
  function half(v) { var n = num(v); return n == null ? null : Math.round(n * 2) / 2; }
  function R() { return root.EDRESEARCH || null; }
  function I() { return root.EDINTEL || null; }
  function val(f) { var r = R(); if (r && typeof r.val === 'function') return r.val(f); return f && typeof f === 'object' && 'value' in f ? (f.missing ? null : f.value) : (f === undefined ? null : f); }
  function fmtLine(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + n; }
  function fmtAm(v) { var n = num(v); if (n == null) return '—'; return (n > 0 ? '+' : '') + Math.round(n); }
  function erf(x) { var t = 1 / (1 + 0.3275911 * Math.abs(x)); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
  /** inverse normal cdf (Acklam), good to ~1e-9 */
  function normInv(p) {
    if (!(p > 0 && p < 1)) return null;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var pl = 0.02425, ph = 1 - pl, q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > ph) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  /* Odds arithmetic: ONE copy, lib/research_core.js R.odds (the edge-kernel
     convention; see docs/odds-helpers-audit.md). Inlined ahead of the request
     path in index.ts; required directly under Node. */
  var ODDS_ = null;
  function ODDS() {
    if (ODDS_) return ODDS_;
    var rc = root.EDResearch && root.EDResearch.odds ? root.EDResearch : null;
    if (!rc && typeof require === 'function') { try { rc = require('../../../lib/research_core.js'); } catch (_) { rc = null; } }
    if (!rc || !rc.odds) throw new Error('lib/research_core.js (R.odds) must be loaded before this kernel prices anything');
    return (ODDS_ = rc.odds);
  }
  function amToDec(am) { return ODDS().amToDec(am); }
  function decToAm(dec) { return ODDS().decToAm(dec); }
  function logit(p) { p = Math.min(0.999, Math.max(0.001, p)); return Math.log(p / (1 - p)); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function devig2(amA, amB) { return ODDS().devig2(amA, amB); }

  /* -------------------------------------------------------- validation */
  /** Register football/validation/pricing_<sport>.json for a sport. */
  function loadValidation(sport, json) {
    if (!sport || !json || !json.markets) return false;
    VALIDATION[sport] = json; return true;
  }
  function validationFor(sport, market) {
    var v = VALIDATION[sport]; var m = v && v.markets ? v.markets[market] : null;
    if (!m) return { tier: 'RESEARCH', required_edge_points: null, basis: 'no pricing validation is loaded for ' + (sport || 'this sport') + ' ' + market + '; the arithmetic below is conditional on an unvalidated projection', blend: null, frame: null, loaded: false };
    var blend = m.blend && m.blend.latest_coef ? { intercept: num(m.blend.latest_coef.intercept), close: num(m.blend.latest_coef.close), model_minus_close: num(m.blend.latest_coef.model_minus_close), sigma: num(m.blend.latest_sigma), held_out: m.blend.pooled_holdout || null, information: m.blend.incremental_information || null } : null;
    if (market === 'moneyline' && m.holdouts && m.holdouts.length) { var h = m.holdouts[m.holdouts.length - 1]; blend = { market: num(h.coef.market), model_minus_market: num(h.coef.model_minus_market), brier: m.brier || null }; }
    return { tier: m.tier || 'RESEARCH', required_edge_points: num(m.required_edge_points), basis: str(m.tier_basis), blend: blend, frame: v.frame || null, pooled: m.pooled || null, ats: m.ats_vs_close ? (m.ats_vs_close.raw_model_oos || m.ats_vs_close.raw_model || null) : null, loaded: true, generated_at: v.generated_at || null };
  }
  /** Register football/validation/movement_<sport>.json for a sport. */
  function loadMovement(sport, json) { if (!sport || !json || !json.result) return false; MOVEMENT[sport] = json; return true; }
  function movementFor(sport) {
    var m = MOVEMENT[sport]; var r = m && m.result ? m.result : null;
    if (!r) return { tier: 'RESEARCH', required_gap_points: null, basis: 'no movement validation is loaded for ' + (sport || 'this sport'), move_per_gap_point: null, toward_rate: null, magnitude_read: false, loaded: false };
    var t = r.required_gap_points != null && r.toward_rating_by_gap ? r.toward_rating_by_gap[String(r.required_gap_points)] : null;
    var mag = !!(r.regression && r.regression.pooled_mae_pred != null && r.regression.pooled_mae_no_move != null && r.regression.pooled_mae_pred < r.regression.pooled_mae_no_move);
    return { tier: r.tier || 'RESEARCH', required_gap_points: num(r.required_gap_points), basis: str(r.tier_basis), move_per_gap_point: r.latest ? num(r.latest.move_per_gap_point) : null, magnitude_read: mag, toward_rate: t ? num(t.toward_rate) : null, toward_n: t ? num(t.n) : null, open_vs_close: r.open_vs_close_by_gap && r.required_gap_points != null ? r.open_vs_close_by_gap[String(r.required_gap_points)] || null : null, loaded: true, generated_at: m.generated_at || null };
  }
  /** TIMING: where the number is likely to go from here, from the validated movement tendency, and what that means for each side. Home-line units throughout. */
  function movement(o) {
    o = o || {};
    var sport = o.sport || null, v = o.validation || movementFor(sport);
    var open = num(o.open_home_line), cur = num(o.market_home_line), fair = num(o.fair_home_line);
    if (open == null) return { ok: false, status: 'NO_OPENER', tier: v.tier, why: 'no opening number is on file for this game; movement cannot be read', required_gap_points: v.required_gap_points, tier_basis: v.basis };
    if (fair == null) return { ok: false, status: 'NO_FAIR_LINE', tier: v.tier, why: 'no fair line to compare the opener against', open_home_line: open, tier_basis: v.basis };
    var gap = r2(fair - open); /* negative: the fair line has the home side MORE favoured than the opener */
    var moved = cur != null ? r2(cur - open) : null;
    var remaining = cur != null ? r2(fair - cur) : gap;
    var expectedClose = v.magnitude_read && v.move_per_gap_point != null ? r2(open + v.move_per_gap_point * gap) : null;
    var favoured = gap < 0 ? 'home' : gap > 0 ? 'away' : null; /* the side the fair line likes better than the opener did */
    var sides = { home: null, away: null };
    var status, why;
    if (v.tier === 'RESEARCH') { status = 'NO_READ'; why = 'the movement validation is RESEARCH for this league: ' + v.basis; }
    else if (v.required_gap_points != null && Math.abs(gap) < v.required_gap_points) { status = 'NO_READ'; why = 'the fair line disagrees with the opener by ' + Math.abs(gap) + ' points, below the ' + v.required_gap_points + '-point threshold the tendency was graded on'; }
    else if (cur != null && remaining !== 0 && Math.sign(remaining) !== Math.sign(gap)) { status = 'MOVED_PAST'; why = 'the number opened ' + fmtLine(open) + ' and has already moved to ' + fmtLine(cur) + ', past the fair line ' + fmtLine(fair) + '; the tendency has played out'; }
    else {
      status = v.tier === 'VALIDATED' ? 'READ' : 'LEAN_READ';
      why = 'the number opened ' + fmtLine(open) + (cur != null && cur !== open ? ', is now ' + fmtLine(cur) : '') + ' and the fair line is ' + fmtLine(fair) + '; when a rating disagreed with the opener by ' + v.required_gap_points + '+ points the number moved toward the rating ' + r1(v.toward_rate * 100) + '% of the time (n ' + v.toward_n + ')' + (v.tier === 'LEAN' ? ' — a tendency, not a record' : '') + (v.magnitude_read ? '' : '; the size of the move is not predictable beyond the direction');
      sides.home = favoured === 'home' ? { verdict: 'BET_NOW', why: 'the number tends to move toward the home side; the current number is likely the best available' } : favoured === 'away' ? { verdict: 'WAIT', why: 'the number tends to move toward the away side, so the home line should improve' } : null;
      sides.away = favoured === 'away' ? { verdict: 'BET_NOW', why: 'the number tends to move toward the away side; the current number is likely the best available' } : favoured === 'home' ? { verdict: 'WAIT', why: 'the number tends to move toward the home side, so the away line should improve' } : null;
    }
    return { ok: true, status: status, tier: v.tier, required_gap_points: v.required_gap_points, open_home_line: open, market_home_line: cur, fair_home_line: fair, gap_at_open: gap, moved_points: moved, remaining_points: remaining, favoured_by_fair: favoured, expected_close: status === 'READ' || status === 'LEAN_READ' ? expectedClose : null, toward_rate: v.toward_rate, open_vs_close: v.open_vs_close, sides: sides, why: why, tier_basis: v.basis,
      note: 'A movement read says where a number tends to go, not whether a side wins; BET NOW and WAIT are statements about the number, and only a LEAN or VALIDATED tier may make them.' };
  }
  function sigmaFor(sport, market, v) {
    if (v && v.blend && num(v.blend.sigma) != null) return { sigma: v.blend.sigma, basis: 'held-out residual sigma of the validated blend' };
    var Ik = I();
    if (market === 'spread' && Ik && typeof Ik.distribution === 'function') { try { var d = Ik.distribution(sport + '|margin_resid'); if (d && num(d.sigma) != null) return { sigma: num(d.sigma), basis: 'pooled residual sigma ' + (d.key || '') + ' (the projection alone)' }; } catch (_) { /* fall through */ } }
    var dflt = DEFAULT_SIGMA[sport] || DEFAULT_SIGMA[NFL];
    return { sigma: dflt[market === 'total' ? 'total' : 'spread'], basis: 'default residual sigma for ' + (sport || 'football') + ' ' + market + ' (no validation loaded)' };
  }

  /* ------------------------------------------------------ fair lines */
  /** The fair home line: the validated blend of projection and market, or whichever exists. Lines are betting lines (negative = home favoured). */
  function fairSpread(o) {
    o = o || {};
    var sport = o.sport || null, v = o.validation || validationFor(sport, 'spread');
    var mhl = num(o.model_home_line), khl = num(o.market_home_line);
    var sig = sigmaFor(sport, 'spread', v);
    if (mhl == null && khl == null) return { ok: false, error: 'neither a projection nor a market line is on file', tier: v.tier };
    var fairMargin, basis, weights = null, status;
    if (mhl != null && khl != null && v.blend && num(v.blend.model_minus_close) != null) {
      var mm = -mhl, km = -khl;
      fairMargin = v.blend.intercept + v.blend.close * km + v.blend.model_minus_close * (mm - km);
      weights = { intercept: r4(v.blend.intercept), market: r4(v.blend.close), projection_minus_market: r4(v.blend.model_minus_close) };
      basis = 'blend fitted on seasons before the held-out season: margin = ' + r2(v.blend.intercept) + ' + ' + r2(v.blend.close) + '×market + ' + r2(v.blend.model_minus_close) + '×(projection − market)';
      status = 'BLENDED';
    } else if (khl != null && mhl != null) { fairMargin = -khl; basis = 'no validated blend for this sport: the market is the fair price and the projection is a research disagreement of ' + r1(Math.abs(mhl - khl)) + ' points'; status = 'MARKET_ANCHORED'; }
    else if (khl != null) { fairMargin = -khl; basis = 'no projection on file: the market is the fair price'; status = 'MARKET_ONLY'; }
    else { fairMargin = -mhl; basis = 'no market on file: the projection stands alone and its tier is ' + v.tier; status = 'MODEL_ONLY'; }
    return { ok: true, sport: sport, fair_home_line: r2(-fairMargin), fair_home_margin: r2(fairMargin), model_home_line: mhl, market_home_line: khl, gap_points: mhl != null && khl != null ? r2(Math.abs(mhl - khl)) : null, status: status, weights: weights, sigma: r2(sig.sigma), sigma_basis: sig.basis, basis: basis, tier: v.tier, required_edge_points: v.required_edge_points, tier_basis: v.basis };
  }
  function fairTotal(o) {
    o = o || {};
    var sport = o.sport || null, v = o.validation || validationFor(sport, 'total');
    var mt = num(o.model_total), kt = num(o.market_total);
    var sig = sigmaFor(sport, 'total', v);
    if (mt == null && kt == null) return { ok: false, error: 'neither a projected nor a market total is on file', tier: v.tier };
    var fair, basis, status, weights = null;
    if (mt != null && kt != null && v.blend && num(v.blend.model_minus_close) != null) { fair = v.blend.intercept + v.blend.close * kt + v.blend.model_minus_close * (mt - kt); weights = { intercept: r4(v.blend.intercept), market: r4(v.blend.close), projection_minus_market: r4(v.blend.model_minus_close) }; basis = 'blend fitted on seasons before the held-out season'; status = 'BLENDED'; }
    else if (kt != null) { fair = kt; basis = mt != null ? 'no validated blend: the market total is the fair total; the projection disagrees by ' + r1(Math.abs(mt - kt)) : 'no projected total on file'; status = mt != null ? 'MARKET_ANCHORED' : 'MARKET_ONLY'; }
    else { fair = mt; basis = 'no market total on file: the projection stands alone'; status = 'MODEL_ONLY'; }
    return { ok: true, sport: sport, fair_total: r2(fair), model_total: mt, market_total: kt, gap_points: mt != null && kt != null ? r2(Math.abs(mt - kt)) : null, status: status, weights: weights, sigma: r2(sig.sigma), sigma_basis: sig.basis, basis: basis, tier: v.tier, required_edge_points: v.required_edge_points, tier_basis: v.basis };
  }
  function fairMoneyline(o) {
    o = o || {};
    var sport = o.sport || null, v = o.validation || validationFor(sport, 'moneyline');
    var pm = num(o.model_home_win_prob), dv = devig2(o.market_home_ml, o.market_away_ml);
    if (pm == null && !dv) return { ok: false, error: 'neither a projected win probability nor a two-way moneyline is on file', tier: v.tier };
    var p, basis, status;
    if (pm != null && dv && v.blend && num(v.blend.model_minus_market) != null) { p = sigmoid(v.blend.market * logit(dv.a) + v.blend.model_minus_market * (logit(pm) - logit(dv.a))); basis = 'logit blend fitted on seasons before the held-out season'; status = 'BLENDED'; }
    else if (dv) { p = dv.a; basis = 'the de-vigged two-way market is the fair probability' + (pm != null ? '; the projection says ' + r2(pm * 100) + '%' : ''); status = pm != null ? 'MARKET_ANCHORED' : 'MARKET_ONLY'; }
    else { p = pm; basis = 'no moneyline on file: the projection stands alone'; status = 'MODEL_ONLY'; }
    return { ok: true, sport: sport, fair_home_win_prob: r4(p), fair_home_ml: decToAm(1 / p), fair_away_ml: decToAm(1 / (1 - p)), market_home_ml: num(o.market_home_ml), market_away_ml: num(o.market_away_ml), overround: dv ? dv.overround : null, model_home_win_prob: pm, status: status, basis: basis, tier: v.tier, tier_basis: v.basis };
  }

  /* --------------------------------------------------- probabilities */
  /** P(selection covers) at selection line L given the fair selection line and sigma; whole numbers carry a one-point push mass. */
  function coverAt(fairSelLine, selLine, sigma) {
    var f = num(fairSelLine), L = num(selLine), s = num(sigma);
    if (f == null || L == null || !s) return null;
    var z = (L - f) / s;
    var whole = Math.abs(L - Math.round(L)) < 1e-9;
    var push = whole ? Math.min(0.2, normPdf(z) / s) : 0;
    var cover = normCdf(z) - push / 2;
    return { cover: r4(Math.max(0, Math.min(1, cover))), push: r4(push), lose: r4(Math.max(0, 1 - cover - push)) };
  }
  function breakEven(oddsAmerican, push) { return ODDS().breakEven(oddsAmerican, push); }

  /** One side of a spread, priced. sel line is the selection's own line (positive = getting points). */
  function priceSpreadSide(o) {
    o = o || {};
    var F = o.fair; if (!F || !F.ok) return null;
    var side = o.side === 'away' ? 'away' : 'home', sgn = side === 'home' ? 1 : -1;
    var fairSel = r2(sgn * F.fair_home_line);
    var mktSel = num(o.market_selection_line) != null ? num(o.market_selection_line) : (F.market_home_line != null ? r2(sgn * F.market_home_line) : null);
    var modelSel = F.model_home_line != null ? r2(sgn * F.model_home_line) : null;
    var odds = num(o.odds_american) != null ? num(o.odds_american) : -110, oddsAssumed = num(o.odds_american) == null;
    var at = mktSel != null ? coverAt(fairSel, mktSel, F.sigma) : null;
    var be = at ? breakEven(odds, at.push) : breakEven(odds, 0);
    var edge = at && be != null ? r2((at.cover - be) * 100) : null;
    /* bet-to: the selection line where cover equals break-even (push ignored for the solve, then reported at that line) */
    var z = be != null ? normInv(be) : null;
    var betTo = z != null ? half(fairSel + F.sigma * z) : null; /* rounded to the half point the book prints */
    var betToAt = betTo != null ? coverAt(fairSel, betTo, F.sigma) : null;
    var priceAtMarket = at && at.cover > 0 && at.cover < 1 ? decToAm((1 - at.push) / at.cover) : null; /* the price that makes the market line break-even */
    var tier = F.tier, req = F.required_edge_points, gap = F.gap_points;
    var status, why;
    if (mktSel == null) { status = 'NO_MARKET'; why = 'no market line on file for this side; the fair line is stated, nothing is priced'; }
    else if (tier === 'RESEARCH') { status = 'CONDITIONAL'; why = 'the ' + (F.sport === CFB ? 'CFB' : 'NFL') + ' spread is RESEARCH tier: ' + F.tier_basis + '. The numbers are arithmetic on the fair line; they are not a recommendation'; }
    else if (tier === 'PROBABILITY') { status = 'PROBABILITY'; why = 'the cover probability is calibrated but no disagreement threshold cleared break-even; no bet-to line is quoted'; }
    else if (req != null && (gap == null || gap < req)) { status = 'PASS'; why = 'the projection disagrees with the market by ' + (gap == null ? 'an unknown amount' : gap + ' points') + ', below the ' + req + '-point threshold the ' + tier + ' record was graded on'; }
    else if (modelSel != null && mktSel != null && modelSel > mktSel) { status = 'PASS'; why = 'the graded pick rule takes the side the projection favours, and the projection favours the other side here (' + fmtLine(modelSel) + ' vs the market’s ' + fmtLine(mktSel) + ')'; }
    else if (edge != null && edge >= 0) { status = tier === 'VALIDATED' ? 'PLAY' : 'LEAN_PLAY'; why = tier === 'VALIDATED' ? 'VALIDATED tier, disagreement ' + gap + ' ≥ ' + req + ' points, and the market line is at or better than the bet-to line' : 'LEAN tier: the graded record cleared break-even at this disagreement, not a profit. The market line is at or better than the bet-to line, so this side is not the losing side of the number; it is not yet an edge'; }
    else { status = 'PASS'; why = 'the disagreement clears the threshold, but at ' + fmtLine(mktSel) + ' ' + fmtAm(odds) + ' the price requires ' + r1(be * 100) + '% and the fair line gives ' + r1(at.cover * 100) + '%; it becomes a number at ' + fmtLine(betTo) + ' or better'; }
    return {
      market: 'spread', side: side, selection: o.selection || side, fair_line: fairSel, model_line: modelSel, market_line: mktSel, odds_american: odds, odds_assumed: oddsAssumed, book: o.book || null, observed_at: o.observed_at || null,
      cover_at_market: at ? at.cover : null, push_at_market: at ? at.push : null, break_even: be, edge_pp: edge,
      bet_to_line: betTo, bet_to_note: betTo != null ? 'the selection line at which the fair line’s cover probability meets the ' + fmtAm(odds) + ' break-even (' + r1(be * 100) + '%); ' + (betToAt ? r1(betToAt.cover * 100) + '% there' : '') : null,
      price_at_market_line: priceAtMarket, price_note: priceAtMarket != null ? 'the price at which ' + fmtLine(mktSel) + ' is break-even on the fair line' : null,
      status: status, why: why, tier: tier, required_edge_points: req, gap_points: gap, sigma: F.sigma,
    };
  }
  function priceTotalSide(o) {
    o = o || {};
    var F = o.fair; if (!F || !F.ok) return null;
    var side = o.side === 'under' ? 'under' : 'over';
    var mkt = num(o.market_total) != null ? num(o.market_total) : F.market_total;
    var odds = num(o.odds_american) != null ? num(o.odds_american) : -110, oddsAssumed = num(o.odds_american) == null;
    var at = null;
    if (mkt != null) { var z0 = (mkt - F.fair_total) / F.sigma; var whole = Math.abs(mkt - Math.round(mkt)) < 1e-9; var push = whole ? Math.min(0.2, normPdf(z0) / F.sigma) : 0; var pOver = 1 - normCdf(z0) - push / 2; at = { cover: r4(side === 'over' ? pOver : 1 - pOver - push), push: r4(push) }; }
    var be = breakEven(odds, at ? at.push : 0);
    var edge = at && be != null ? r2((at.cover - be) * 100) : null;
    var z = be != null ? normInv(be) : null;
    var betTo = z != null ? half(side === 'over' ? F.fair_total - F.sigma * z : F.fair_total + F.sigma * z) : null;
    var tier = F.tier, req = F.required_edge_points, gap = F.gap_points;
    var status, why;
    if (mkt == null) { status = 'NO_MARKET'; why = 'no market total on file'; }
    else if (tier === 'RESEARCH') { status = 'CONDITIONAL'; why = 'the total is RESEARCH tier: ' + F.tier_basis + '. Arithmetic, not a recommendation'; }
    else if (tier === 'PROBABILITY') { status = 'PROBABILITY'; why = 'calibrated probability, no bet-to'; }
    else if (req != null && (gap == null || gap < req)) { status = 'PASS'; why = 'disagreement ' + gap + ' below the ' + req + '-point threshold'; }
    else if (F.model_total != null && ((side === 'over' && F.model_total < mkt) || (side === 'under' && F.model_total > mkt))) { status = 'PASS'; why = 'the projection favours the other side of this total'; }
    else if (edge != null && edge >= 0) { status = tier === 'VALIDATED' ? 'PLAY' : 'LEAN_PLAY'; why = tier + ' tier and the market total is at or better than the bet-to number'; }
    else { status = 'PASS'; why = 'the price requires ' + r1(be * 100) + '% and the fair total gives ' + r1(at.cover * 100) + '%; it becomes a number at ' + betTo + ' or better'; }
    return { market: 'total', side: side, selection: side, fair_total: F.fair_total, model_total: F.model_total, market_total: mkt, odds_american: odds, odds_assumed: oddsAssumed, cover_at_market: at ? at.cover : null, push_at_market: at ? at.push : null, break_even: be, edge_pp: edge, bet_to_total: betTo, status: status, why: why, tier: tier, required_edge_points: req, gap_points: gap, sigma: F.sigma };
  }
  function priceMoneylineSide(o) {
    o = o || {};
    var F = o.fair; if (!F || !F.ok) return null;
    var side = o.side === 'away' ? 'away' : 'home';
    var p = side === 'home' ? F.fair_home_win_prob : 1 - F.fair_home_win_prob;
    var am = side === 'home' ? F.market_home_ml : F.market_away_ml;
    var be = am != null ? breakEven(am, 0) : null;
    var edge = be != null ? r2((p - be) * 100) : null;
    var status, why;
    if (am == null) { status = 'NO_MARKET'; why = 'no moneyline on file'; }
    else if (F.tier === 'RESEARCH') { status = 'CONDITIONAL'; why = 'the moneyline is RESEARCH tier: ' + F.tier_basis; }
    else if (edge != null && edge >= 0) { status = 'PROBABILITY'; why = 'the blended probability beats the price; the moneyline tier permits a probability, not a bet-to'; }
    else { status = 'PASS'; why = 'the price requires ' + r1(be * 100) + '% and the fair probability is ' + r1(p * 100) + '%'; }
    return { market: 'moneyline', side: side, selection: o.selection || side, fair_win_prob: r4(p), fair_price: decToAm(1 / p), market_price: am, break_even: be, edge_pp: edge, status: status, why: why, tier: F.tier };
  }
  function sizing(side) {
    if (!side) return null;
    if (side.tier !== 'VALIDATED' || side.status !== 'PLAY') return { fraction: null, reason: side.tier === 'VALIDATED' ? 'the side is not a PLAY at this price' : 'sizing is produced only for a VALIDATED tier; this market is ' + side.tier };
    var d = amToDec(side.odds_american), p = side.cover_at_market, q = 1 - p - (side.push_at_market || 0);
    if (!d || p == null) return { fraction: null, reason: 'no price or probability to size on' };
    var k = (p * (d - 1) - q) / (d - 1);
    return { fraction: r4(Math.max(0, Math.min(KELLY_CAP, KELLY_FRACTION * k))), basis: 'quarter Kelly on the fair cover probability at the quoted price, capped at ' + (KELLY_CAP * 100) + '% of bankroll', full_kelly: r4(k) };
  }

  /* ------------------------------------------------------ the packet */
  /** Price one research packet: spread both sides, total both sides, moneyline both sides, the best number, and the sizing rule. */
  function price(o) {
    o = o || {};
    var p = o.packet || null; if (!p || !p.game) return null;
    var sport = p.game.sport, home = p.game.home, away = p.game.away;
    var m = p.model || {}, mk = p.market || {}, prim = mk.primary || null, cons = mk.consensus || null, orient = p.comparison && p.comparison.orientation;
    var mhl = m.home_line && !m.home_line.missing ? val(m.home_line) : null;
    var mt = m.fair_total && !m.fair_total.missing ? val(m.fair_total) : null;
    var mwp = m.home_win_probability && !m.home_win_probability.missing ? val(m.home_win_probability) : null;
    /* the market home line: the captured spread when there is one, else the consensus */
    var khl = null, kOdds = null, kBook = null, kAt = null, kSide = null, kSel = null;
    if (prim && prim.market === 'spreads' && orient && orient.side && orient.market_selection_line != null) { kSide = orient.side; kSel = orient.selection; khl = r2((kSide === 'home' ? 1 : -1) * orient.market_selection_line); kOdds = num(prim.odds_american) != null ? num(prim.odds_american) : (num(prim.odds_decimal) ? decToAm(prim.odds_decimal) : null); kBook = prim.book || null; kAt = prim.captured_at || null; }
    else if (cons && num(cons.spread_home) != null) { khl = num(cons.spread_home); kBook = 'consensus'; }
    var kt = prim && prim.market === 'totals' && num(prim.handicap) != null ? num(prim.handicap) : (cons ? num(cons.total) : null);
    var kml = cons ? { home: num(cons.home_moneyline), away: num(cons.away_moneyline) } : { home: null, away: null };
    if (prim && prim.market === 'h2h' && prim.side && num(prim.odds_american) != null) kml[prim.side] = num(prim.odds_american);
    var FS = fairSpread({ sport: sport, model_home_line: mhl, market_home_line: khl });
    var MV = FS.ok ? movement({ sport: sport, open_home_line: o.open_home_line, market_home_line: khl, fair_home_line: FS.fair_home_line }) : null;
    var FT = fairTotal({ sport: sport, model_total: mt, market_total: kt });
    var FM = fairMoneyline({ sport: sport, model_home_win_prob: mwp, market_home_ml: kml.home, market_away_ml: kml.away });
    var sides = [];
    if (FS.ok) { ['home', 'away'].forEach(function (s) { var r = priceSpreadSide({ fair: FS, side: s, selection: s === 'home' ? home : away, odds_american: kSide === s ? kOdds : null, book: kSide === s ? kBook : (khl != null ? kBook : null), observed_at: kSide === s ? kAt : null }); if (r) sides.push(r); }); }
    if (FT.ok) { ['over', 'under'].forEach(function (s) { var r = priceTotalSide({ fair: FT, side: s, odds_american: prim && prim.market === 'totals' && prim.side === s ? num(prim.odds_american) : null }); if (r) sides.push(r); }); }
    if (FM.ok) { ['home', 'away'].forEach(function (s) { var r = priceMoneylineSide({ fair: FM, side: s, selection: s === 'home' ? home : away }); if (r) sides.push(r); }); }
    var rank = { PLAY: 5, LEAN_PLAY: 4, PROBABILITY: 3, PASS: 2, CONDITIONAL: 1, NO_MARKET: 0 };
    var ordered = sides.slice().sort(function (a, b) { return (rank[b.status] - rank[a.status]) || ((b.edge_pp || -99) - (a.edge_pp || -99)); });
    var best = ordered.length ? ordered[0] : null;
    var quoted = sides.filter(function (s) { return s.market === 'spread' && s.side === kSide; })[0] || null;
    var headline = headlineFor(best, quoted, FS, home, away);
    return {
      schema: SCHEMA, version: VERSION, built_at: new Date(o.now || Date.now()).toISOString(), sport: sport, game: { home: home, away: away },
      fair: { spread: FS, total: FT, moneyline: FM },
      movement: MV,
      sides: sides, best: best, quoted_side: quoted, sizing: sizing(best),
      headline: headline,
      validation: { spread: validationFor(sport, 'spread'), total: validationFor(sport, 'total'), moneyline: validationFor(sport, 'moneyline') },
      note: 'Every number is arithmetic on the fair line, the residual sigma and the price. The status is the only word that may be read as a recommendation, and a RESEARCH market never carries PLAY.',
    };
  }
  function headlineFor(best, quoted, FS, home, away) {
    if (!FS || !FS.ok) return 'No fair line: neither a projection nor a market number is on file.';
    var fairTxt = 'Fair line ' + home + ' ' + fmtLine(FS.fair_home_line) + (FS.market_home_line != null ? ' against a market of ' + fmtLine(FS.market_home_line) : '') + (FS.status === 'BLENDED' ? ' (validated blend)' : FS.status === 'MODEL_ONLY' ? ' (projection alone; no market on file)' : ' (market-anchored)') + '.';
    var s = quoted || best;
    if (!s) return fairTxt;
    if (s.market === 'spread') {
      var who = s.side === 'home' ? home : away;
      if (s.status === 'PLAY') return fairTxt + ' ' + who + ' ' + fmtLine(s.market_line) + ' at ' + fmtAm(s.odds_american) + ' is a PLAY down to ' + fmtLine(s.bet_to_line) + ' (VALIDATED tier).';
      if (s.status === 'LEAN_PLAY') return fairTxt + ' ' + who + ' ' + fmtLine(s.market_line) + ' at ' + fmtAm(s.odds_american) + ' is on the right side of the number, to ' + fmtLine(s.bet_to_line) + ' — LEAN tier: break-even history, not an edge.';
      if (s.status === 'PASS') return fairTxt + ' ' + who + ' ' + fmtLine(s.market_line) + ' is a PASS: ' + s.why + '.';
      if (s.status === 'CONDITIONAL') return fairTxt + ' ' + who + ' ' + fmtLine(s.market_line) + ': conditional arithmetic only (RESEARCH tier); it would need ' + fmtLine(s.bet_to_line) + ' to meet ' + fmtAm(s.odds_american) + ' IF the projection were right, and the validation says it is not a betting edge.';
      if (s.status === 'NO_MARKET') return fairTxt + ' No market line to price against.';
    }
    return fairTxt;
  }

  /* ------------------------------------------------------- the slate */
  /** Rank a slate: each game priced from its reference market at -110, both sides, ordered by edge times completeness with the status beside it. */
  function rankSlate(o) {
    o = o || {};
    var sport = o.sport, games = Array.isArray(o.games) ? o.games : [];
    var rows = [];
    games.forEach(function (g) {
      var FS = fairSpread({ sport: sport, model_home_line: num(g.model_home_line), market_home_line: num(g.market_home_line) });
      var completeness = num(g.completeness) != null ? Math.max(0, Math.min(1, num(g.completeness))) : 0.5;
      if (!FS.ok) { rows.push({ game_id: g.game_id, home: g.home, away: g.away, kickoff: g.kickoff || null, status: 'NO_NUMBER', why: FS.error, rank_score: -1, completeness: completeness }); return; }
      ['home', 'away'].forEach(function (s) {
        var r = priceSpreadSide({ fair: FS, side: s, selection: s === 'home' ? g.home : g.away, odds_american: num(g.odds_american) });
        if (!r) return;
        var score = r.edge_pp != null ? r.edge_pp * completeness : -99;
        rows.push({ game_id: g.game_id, home: g.home, away: g.away, kickoff: g.kickoff || null, side: s, selection: r.selection, market_line: r.market_line, fair_line: r.fair_line, model_line: r.model_line, gap_points: r.gap_points, cover_at_market: r.cover_at_market, break_even: r.break_even, edge_pp: r.edge_pp, bet_to_line: r.bet_to_line, status: r.status, why: r.why, tier: r.tier, completeness: completeness, rank_score: r2(score), market_source: g.market_source || null });
      });
    });
    var rank = { PLAY: 5, LEAN_PLAY: 4, PROBABILITY: 3, PASS: 2, CONDITIONAL: 1, NO_MARKET: 0, NO_NUMBER: -1 };
    rows.sort(function (a, b) { return (rank[b.status] - rank[a.status]) || (b.rank_score - a.rank_score); });
    var plays = rows.filter(function (r) { return r.status === 'PLAY' || r.status === 'LEAN_PLAY'; });
    var v = validationFor(sport, 'spread');
    return { schema: 'edgedesk_ranked_slate_v1', sport: sport, built_at: new Date(o.now || Date.now()).toISOString(), games: games.length, rows: rows, top: rows.slice(0, num(o.top) || 5), plays: plays.length, tier: v.tier, required_edge_points: v.required_edge_points, tier_basis: v.basis,
      note: plays.length ? (v.tier === 'VALIDATED' ? plays.length + ' side(s) clear the validated rule.' : plays.length + ' side(s) are on the right side of the number under a LEAN record (break-even history, not an edge).') : 'Nothing on this board clears the graded rule; the ranking shows how close each number is, and a RESEARCH market shows conditional arithmetic only.' };
  }

  /* ------------------------------------------------------- the prose */
  function promptBlock(P) {
    if (!P) return '';
    var L = [];
    L.push('PRICING LAYER (' + P.schema + ') — EdgeDesk’s fair price and the price a side is worth. Quote it; do not extend it. The STATUS word is the only recommendation language allowed.');
    L.push('HEADLINE: ' + P.headline);
    var FS = P.fair.spread;
    if (FS && FS.ok) L.push('FAIR SPREAD: ' + P.game.home + ' ' + fmtLine(FS.fair_home_line) + ' [' + FS.status + '; projection ' + fmtLine(FS.model_home_line) + ', market ' + fmtLine(FS.market_home_line) + ', gap ' + (FS.gap_points == null ? '—' : FS.gap_points) + ' pts; sigma ' + FS.sigma + '; tier ' + FS.tier + (FS.required_edge_points != null ? ', graded threshold ' + FS.required_edge_points + ' pts' : '') + ']. Basis: ' + FS.basis + '. Tier basis: ' + FS.tier_basis);
    var FT = P.fair.total; if (FT && FT.ok) L.push('FAIR TOTAL: ' + FT.fair_total + ' [' + FT.status + '; projection ' + (FT.model_total == null ? '—' : FT.model_total) + ', market ' + (FT.market_total == null ? '—' : FT.market_total) + '; tier ' + FT.tier + ']');
    var FM = P.fair.moneyline; if (FM && FM.ok) L.push('FAIR MONEYLINE: ' + P.game.home + ' ' + r1(FM.fair_home_win_prob * 100) + '% (' + fmtAm(FM.fair_home_ml) + ') [' + FM.status + '; tier ' + FM.tier + ']');
    var MV2 = P.movement;
    if (MV2) L.push('MOVEMENT: ' + (MV2.ok ? MV2.status + ' [tier ' + MV2.tier + ']. Opened ' + fmtLine(MV2.open_home_line) + (MV2.market_home_line != null ? ', now ' + fmtLine(MV2.market_home_line) : '') + ', fair ' + fmtLine(MV2.fair_home_line) + ' (gap at open ' + MV2.gap_at_open + ')' + (MV2.expected_close != null ? ', expected close ' + fmtLine(MV2.expected_close) : '') + '. ' + (MV2.sides && MV2.sides.home ? P.game.home + ': ' + MV2.sides.home.verdict.replace('_', ' ') + '; ' + P.game.away + ': ' + MV2.sides.away.verdict.replace('_', ' ') + '. ' : '') + MV2.why : MV2.status + ': ' + MV2.why));
    L.push('SIDES (status — what the price requires vs what the fair line gives):');
    P.sides.forEach(function (s) {
      if (s.market === 'spread') L.push('  ' + s.selection + ' ' + fmtLine(s.market_line) + ' ' + fmtAm(s.odds_american) + (s.odds_assumed ? ' (price assumed)' : '') + ': ' + s.status + '. requires ' + (s.break_even == null ? '—' : r1(s.break_even * 100) + '%') + ', fair line gives ' + (s.cover_at_market == null ? '—' : r1(s.cover_at_market * 100) + '%') + (s.edge_pp != null ? ' (' + (s.edge_pp >= 0 ? '+' : '') + s.edge_pp + ' pp)' : '') + '; bet-to ' + fmtLine(s.bet_to_line) + '; price that makes ' + fmtLine(s.market_line) + ' break-even ' + fmtAm(s.price_at_market_line) + '. Why: ' + s.why);
      else if (s.market === 'total') L.push('  ' + s.side + ' ' + (s.market_total == null ? '—' : s.market_total) + ' ' + fmtAm(s.odds_american) + (s.odds_assumed ? ' (price assumed)' : '') + ': ' + s.status + '. requires ' + (s.break_even == null ? '—' : r1(s.break_even * 100) + '%') + ', fair total gives ' + (s.cover_at_market == null ? '—' : r1(s.cover_at_market * 100) + '%') + '; bet-to ' + (s.bet_to_total == null ? '—' : s.bet_to_total) + '. Why: ' + s.why);
      else L.push('  ' + s.selection + ' ML ' + fmtAm(s.market_price) + ': ' + s.status + '. requires ' + (s.break_even == null ? '—' : r1(s.break_even * 100) + '%') + ', fair ' + r1(s.fair_win_prob * 100) + '% (' + fmtAm(s.fair_price) + '). Why: ' + s.why);
    });
    L.push('SIZING: ' + (P.sizing && P.sizing.fraction != null ? (P.sizing.fraction * 100) + '% of bankroll (' + P.sizing.basis + ')' : 'none — ' + (P.sizing ? P.sizing.reason : 'no side')));
    L.push('RULES: never say "bet", "play", "worth betting", "bet to" or a bankroll fraction unless the status above is PLAY or LEAN_PLAY, and say "LEAN" when it is LEAN_PLAY. Never state an EV, ROI or profit; none is produced. A CONDITIONAL status is arithmetic on an unvalidated projection and must be called that. Say "bet now" or "wait" only when MOVEMENT above is READ or LEAN_READ and gives that verdict for the side; a movement read is about the number, never about the result.');
    return L.join('\n');
  }
  function criticExtras(o) {
    o = o || {};
    var a = str(o.answer), P = o.pricing || null, issues = [];
    if (!P) return issues;
    var plays = P.sides.filter(function (s) { return s.status === 'PLAY' || s.status === 'LEAN_PLAY'; });
    var anyPlay = plays.length > 0;
    if (!anyPlay && /\b(bet to|worth (a )?bet(ting)?|is a play|a play (down|up) to|play it|lay it|take it|fire on|hammer)\b/i.test(a)) issues.push({ code: 'BET_TO_UNSUPPORTED', severity: 'FAIL', detail: 'the answer recommends a bet and no side carries PLAY or LEAN_PLAY (statuses: ' + P.sides.map(function (s) { return s.status; }).join(', ') + ')' });
    if (/\b(\+?\d+(\.\d+)?\s*%\s*(ev|edge|roi)|expected value of|positive ev|\+ev|long[- ]term profit|profitable)\b/i.test(a)) issues.push({ code: 'EV_CLAIM', severity: 'FAIL', detail: 'the answer states an EV, ROI or profit; the pricing layer produces none' });
    if (P.sizing && P.sizing.fraction == null && /\b(\d+(\.\d+)?\s*%\s*of (your )?bankroll|units? on|\d+\s*units?\b)/i.test(a)) issues.push({ code: 'SIZING_UNSUPPORTED', severity: 'FAIL', detail: 'the answer sizes a bet; no sizing fraction was produced (' + P.sizing.reason + ')' });
    var mv = P.movement; var timingOk = !!(mv && mv.ok && (mv.status === 'READ' || mv.status === 'LEAN_READ'));
    if (!timingOk && /\b(bet (it )?now|get (it|in) now|before (it|the number|the line) moves|the number is going away|wait for (a )?better (number|line)|wait (on|for) (it|this)|hold off (on|for) (a )?better)\b/i.test(a)) issues.push({ code: 'TIMING_UNSUPPORTED', severity: 'FAIL', detail: 'the answer makes a timing call (bet now / wait) and the movement layer has no read (' + (mv ? mv.status : 'no movement') + ')' });
    var leanOnly = anyPlay && plays.every(function (s) { return s.status === 'LEAN_PLAY'; });
    if (leanOnly && /\b(edge|profitable|\+ev|value bet)\b/i.test(a) && !/\blean\b/i.test(a)) issues.push({ code: 'LEAN_STATED_AS_EDGE', severity: 'WARN', detail: 'the only playable status is LEAN_PLAY (break-even history) and the answer calls it an edge without saying LEAN' });
    return issues;
  }
  function registerTools() {
    var Rk = R(); if (!Rk || !Rk.TOOLS || !Rk.T) return false;
    var T = Rk.T;
    function tool(name, description, input, run) { Rk.TOOLS[name] = { name: name, llm: true, category: 'data', description: description, input: input, output: T.any(), run: run }; }
    function P(ctx) { return ctx && ctx.packet && ctx.packet.pricing ? ctx.packet.pricing : null; }
    tool('get_price_ranges', 'EdgeDesk’s fair line for this game and, per side and market, what the price requires vs what the fair line gives, the bet-to line, the price at which the market line breaks even, and the STATUS (PLAY / LEAN_PLAY / PASS / PROBABILITY / CONDITIONAL). Optional market: spread | total | moneyline.',
      T.obj({ market: T.opt(T.enm(['spread', 'total', 'moneyline'])) }), function (i, ctx) { var p = P(ctx); if (!p) return { ok: false, error: 'no pricing on this turn', missing: ['pricing'] }; var sides = i && i.market ? p.sides.filter(function (s) { return s.market === i.market; }) : p.sides; return { ok: true, headline: p.headline, fair: p.fair, movement: p.movement || null, sides: sides, best: p.best, sizing: p.sizing, note: p.note }; });
    tool('get_ranked_slate', 'The board ranked by the pricing layer: every side’s fair line, market line, cover probability vs break-even, bet-to line and status, best first. Sizes nothing. Input: {sport?, top?}.',
      T.obj({ sport: T.opt(T.str({ max: 40 })), top: T.opt(T.num()) }), function (i, ctx) { var s = ctx && ctx.slate_pricing ? ctx.slate_pricing : null; if (!s) return { ok: false, error: 'no ranked slate on this turn', missing: ['slate_pricing'] }; return { ok: true, sport: s.sport, tier: s.tier, tier_basis: s.tier_basis, plays: s.plays, top: s.rows.slice(0, num(i && i.top) || 8), note: s.note }; });
    return true;
  }
  var TOOL_NAMES = ['get_price_ranges', 'get_ranked_slate'];

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, TIER_RANK: TIER_RANK, TOOL_NAMES: TOOL_NAMES, DEFAULT_SIGMA: DEFAULT_SIGMA,
    loadValidation: loadValidation, validationFor: validationFor, sigmaFor: sigmaFor, loadMovement: loadMovement, movementFor: movementFor, movement: movement,
    fairSpread: fairSpread, fairTotal: fairTotal, fairMoneyline: fairMoneyline,
    coverAt: coverAt, breakEven: breakEven, normInv: normInv, devig2: devig2,
    priceSpreadSide: priceSpreadSide, priceTotalSide: priceTotalSide, priceMoneylineSide: priceMoneylineSide, sizing: sizing,
    price: price, rankSlate: rankSlate, promptBlock: promptBlock, criticExtras: criticExtras, registerTools: registerTools
  };
});
/*__EDPRICE_END__*/
