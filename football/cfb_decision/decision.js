/* ============================================================================
   EdgeDesk CFB — the wagering decision engine (browser + node, ES5, no deps).
   docs/cfb-decision/DESIGN.md

   The football model says what a game is worth (engine.js pure()). The market
   says what is offered. The calibration artifact says how much to trust the
   model's probability. This engine decides whether the difference is large
   enough to justify risk — per sportsbook quote, because price matters — and
   it FAILS CLOSED: a missing or mismatched calibration artifact, a missing or
   stale price, or any failed computation means NO BET. Predictions still
   display; recommendations do not.

     decideQuote(pure, quote, ctx)    one book's quote -> status, reasons, numbers
     decideGame(pure, market, ctx)    every book -> per-book statuses, the best
                                      validated quote, BETTABLE TO, one summary
     priceTargets(...)                ideal / acceptable / minimum-EV / do-not-bet
     stake(...), applyExposure(...)   the risk layer: runs AFTER selection and
                                      never changes which bets qualify
     explain(d), auditLanguage(t, d)  words come from numbers, never the reverse
     manualDecision(...)              a person's wager: stored apart, never official

   It never writes into the pure projection, and nothing here can move a
   football number. An LLM may explain a decision; it cannot change one.

   SIGN CONVENTION (engine.js): internal margin > 0 = home wins by that many;
   book home line -7 = home laying 7 (margin = -line).
   ========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDCfbDecision = api;
}(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var ENGINE_ID = 'edgedesk_cfb_decision';
  var ENGINE_VERSION = 'cfb_decision_engine_v1';

  /* status and reason vocabulary (docs/cfb-decision/DESIGN.md) */
  var STATUS = ['BET', 'LEAN', 'RESEARCH', 'PASS', 'NO_BET'];
  var TIMING = ['BET_NOW', 'WAIT', 'NONE'];
  var REASON = {
    PASS_PRICE: 'the price does not clear break-even by the validated margin, or no price was captured',
    PASS_MODEL_UNCERTAINTY: 'the football projection is too uncertain for a wager',
    PASS_QB_UNCERTAINTY: 'a starting quarterback is unknown or unresolved',
    PASS_MARKET_STALE: 'the market quote is too old to act on',
    PASS_MODEL_DISAGREEMENT: 'the submodels disagree too much relative to the apparent edge',
    PASS_INSUFFICIENT_EV: 'expected value after calibration is below the validated threshold',
    PASS_LINE_MOVED: 'the line has moved through the bettable threshold',
    PASS_DATA_QUALITY: 'a data-integrity check failed',
    PASS_MARKET_DISPERSION: 'books disagree too much to trust one number',
    PASS_MARKET_INVALID: 'the quote failed market validation (impossible number, odds, timestamp or game) or is quarantined',
    PASS_MARKET_DEGRADED: 'the market consensus is degraded (too few valid books, too many stale, or unresolved disagreement)',
    NO_BET_CALIBRATION: 'the decision calibration artifact is missing or invalid (fail closed)',
    NO_BET_VERSION_MISMATCH: 'the calibration was validated for a different football model version (fail closed)',
    NO_BET_COMPUTATION: 'a probability or value could not be computed (fail closed)',
    NO_BET_POLICY: 'no validated decision policy is loaded (fail closed)',
    NO_BET_BETTING_DISABLED: 'betting is disabled until the decision policy passes its promotion gate',
    RESEARCH_QB: 'a potential edge exists but a quarterback status is unresolved',
    RESEARCH_MARKET_IMMATURE: 'a potential edge exists but the market is immature (few books or an early line)',
    RESEARCH_DATA_INCOMPLETE: 'a potential edge exists but inputs are incomplete',
    RESEARCH_EXTREME_EDGE: 'the apparent edge is extreme: it needs the integrity checks and a second look',
    LEAN_DIRECTIONAL: 'the model leans this side at this price, below the betting threshold',
    BET_VALIDATED: 'the price clears every validated threshold',
    HELD_BY_HYSTERESIS: 'kept from the previous snapshot: within the decision buffer, nothing else changed'
  };
  var BANNED_ALWAYS = [/guarantee/i, /\block\b/i, /risk[- ]?free/i, /can'?t lose/i, /sure thing/i, /free money/i,
                       /consistent(ly)? win/i];
  var BET_ONLY = [/strong bet/i, /best bet/i, /great value/i, /hammer/i, /max play/i, /must bet/i, /\bplay of the/i];

  /* ----------------------------------------------------------- helpers */
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function r(x, k) { if (!isNum(x)) return null; var m = Math.pow(10, k == null ? 4 : k); return Math.round(x * m) / m; }
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  function logit(p) { p = clamp(p, 1e-4, 1 - 1e-4); return Math.log(p / (1 - p)); }
  function sigm(x) { return 1 / (1 + Math.exp(-x)); }
  function interp(xs, ys, v) {
    if (!xs || !xs.length) return v;
    if (v <= xs[0]) return ys[0];
    if (v >= xs[xs.length - 1]) return ys[ys.length - 1];
    for (var i = 1; i < xs.length; i++) {
      if (v <= xs[i]) {
        var t = (v - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
        return ys[i - 1] + t * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1];
  }

  /* ------------------------------------------ Student-t CDF (engine.js) */
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
  /* standardized t: unit variance, df > 2 (the pure model's error distribution) */
  function tCdf(z, df) {
    if (!isNum(df) || df > 1e6) df = 1e6;
    var s = Math.sqrt((df - 2) / df), x = z / s;
    var p = 0.5 * ibeta(df / 2, 0.5, df / (df + x * x));
    return x > 0 ? 1 - p : p;
  }

  /* ------------------------------------------------------------- prices */
  function americanToPayout(a) { if (!isNum(a) || a === 0 || (a > -100 && a < 100)) return null; return a > 0 ? a / 100 : 100 / (-a); }
  function payoutToAmerican(b) { if (!isNum(b) || b <= 0) return null; return b >= 1 ? Math.round(100 * b) : -Math.round(100 / b); }
  function breakEven(a) { var b = americanToPayout(a); return b == null ? null : 1 / (1 + b); }
  /* vig removal, two-sided: proportional (multiplicative) de-vig; the overround is reported */
  function devig(priceA, priceB) {
    var qa = breakEven(priceA), qb = breakEven(priceB);
    if (qa == null || qb == null) return null;
    var s = qa + qb;
    return { p_a: qa / s, p_b: qb / s, overround: s - 1, hold: 1 - 1 / s };
  }
  /* P(margin lands exactly on the line), from the calibration table by |line| */
  function pushProb(line, table) {
    if (!isNum(line) || Math.abs(line - Math.round(line)) > 1e-9) return 0;
    var a = Math.abs(line), k, lo, hi;
    for (k in (table || {})) if (Object.prototype.hasOwnProperty.call(table, k)) {
      lo = parseFloat(k.split('-')[0]); hi = parseFloat(k.split('-')[1]);
      if (a >= lo && a <= hi) return table[k];
    }
    return 0.02;
  }
  /* EV per unit risked: win p(1-pp) * payout, lose (1-p)(1-pp), push returns the stake */
  function expectedValue(p, pp, price) {
    var b = americanToPayout(price);
    if (b == null || !isNum(p)) return null;
    pp = isNum(pp) ? pp : 0;
    return p * (1 - pp) * b - (1 - p) * (1 - pp);
  }
  /* the worst price at which a probability still clears an EV floor */
  function minimumPrice(p, pp, minEv) {
    if (!isNum(p) || p <= 0) return null;
    pp = isNum(pp) ? pp : 0;
    var need = ((minEv || 0) / Math.max(1e-9, 1 - pp) + (1 - p)) / p;     /* payout b with EV == minEv */
    return payoutToAmerican(need);
  }
  function priceBetterOrEqual(a, b) {        /* is price a at least as good for the bettor as price b? */
    var pa = americanToPayout(a), pb = americanToPayout(b);
    return pa != null && pb != null && pa >= pb - 1e-12;
  }
  function nextBetterPrice(a) { return a < 0 ? (a + 1 > -100 ? 101 : a + 1) : a + 1; }   /* one cent better */
  /* the smallest decision EV whose calibrated (curve-mapped) EV reaches minEv, through the curve
     sideNumbers reads: -Infinity when every decision EV does, null when none does */
  function decisionEvFloor(A, minEv) {
    var cT = A.ev_curve && A.ev_curve.input === 'theoretical_ev' ? A.ev_curve : null;
    var c = A.ev_curve_decision || (A.ev_curve && !cT ? A.ev_curve : null);
    if (!c) return cT ? null : minEv;
    var xs = c.x, ys = c.y, i;
    if (!xs || !xs.length) return minEv;
    if (ys[0] >= minEv) return -Infinity;
    for (i = 1; i < xs.length; i++) {
      if (ys[i] >= minEv) return xs[i - 1] + (minEv - ys[i - 1]) / ((ys[i] - ys[i - 1]) || 1) * (xs[i] - xs[i - 1]);
    }
    return null;
  }

  /* --------------------------------------- the calibration artifact (D1) */
  function applyMap(map, p) {
    if (!map || map.method === 'identity') return p;
    switch (map.method) {
      case 'platt': return sigm(map.a + map.b * logit(p));
      case 'beta': { var q = clamp(p, 1e-4, 1 - 1e-4); return sigm(map.c + map.a * Math.log(q) - map.b * Math.log(1 - q)); }
      case 'isotonic': return clamp(interp(map.x, map.y, p), 1e-4, 1 - 1e-4);
      case 'logit_pwl': return sigm(interp(map.x, map.y, logit(p)));
      default: throw new Error('unknown probability map ' + map.method);
    }
  }
  function binOf(edges, v) {
    for (var i = 0; i < edges.length; i++) if (v < edges[i]) return i;
    return edges.length;
  }
  function calibrate(cal, p, feats) {
    if (cal && cal.conditional && cal.conditional.maps) {
      var v = feats[cal.conditional.by];
      if (isNum(v)) return applyMap(cal.conditional.maps[binOf(cal.conditional.bins, v)], p);
    }
    return applyMap(cal && (cal.map || cal), p);
  }
  function evalModel(spec, feats) {
    if (!spec) return null;
    var z = isNum(spec.intercept) ? spec.intercept : 0, k, x, mu, sd;
    for (k in spec.coef) if (Object.prototype.hasOwnProperty.call(spec.coef, k)) {
      x = feats[k];
      if (!isNum(x)) x = spec.fill && isNum(spec.fill[k]) ? spec.fill[k] : null;
      if (!isNum(x)) return null;                              /* a missing input: no number, never a guess */
      mu = spec.mu && isNum(spec.mu[k]) ? spec.mu[k] : 0;
      sd = spec.sd && isNum(spec.sd[k]) && spec.sd[k] !== 0 ? spec.sd[k] : 1;
      z += spec.coef[k] * (x - mu) / sd;
    }
    return spec.type === 'logistic' ? sigm(z) : z;
  }
  function validateArtifact(A, modelVersion) {
    if (!A || typeof A !== 'object') return { ok: false, code: 'NO_BET_CALIBRATION', detail: 'no calibration artifact loaded' };
    if (A.schema !== 'cfb_decision_calibration_schema_v1') return { ok: false, code: 'NO_BET_CALIBRATION', detail: 'unknown artifact schema ' + A.schema };
    if (!A.cover_calibration) return { ok: false, code: 'NO_BET_CALIBRATION', detail: 'artifact has no cover calibration' };
    if (A.ev_curve && A.ev_curve.input === 'theoretical_ev' && !A.ev_curve_decision) {
      return { ok: false, code: 'NO_BET_CALIBRATION', detail: 'artifact has no EV curve for the decision EV (ev_curve maps the theoretical EV)' };
    }
    if (!A.base_model_version || A.base_model_version !== modelVersion) {
      return { ok: false, code: 'NO_BET_VERSION_MISMATCH',
        detail: 'artifact validated for ' + A.base_model_version + ', projection from ' + modelVersion };
    }
    return { ok: true };
  }
  function validatePolicy(P) {
    if (!P || typeof P !== 'object' || !P.version) return { ok: false, code: 'NO_BET_POLICY', detail: 'no decision policy' };
    var need = ['min_probability_edge', 'min_ev', 'stale_minutes', 'max_price'];
    for (var i = 0; i < need.length; i++) if (!(need[i] in P)) return { ok: false, code: 'NO_BET_POLICY', detail: 'policy lacks ' + need[i] };
    return { ok: true };
  }

  /* ------------------------------------------------------- probabilities */
  /* P(the side covers | no push) from the pure distribution at a book home line */
  function pureCover(pure, homeLine, side) {
    var mu = pure.projected_margin, sd = pure.sigma, df = pure.t_df;
    if (!isNum(mu) || !isNum(sd) || sd <= 0 || !isNum(homeLine)) return null;
    var pHome = 1 - tCdf((-homeLine - mu) / sd, df);
    return side === 'HOME' ? pHome : 1 - pHome;
  }
  function decisionProbability(pPure, marketP, feats, A) {
    var pc = calibrate(A.cover_calibration, pPure, feats);
    var sh = A.market_shrinkage;
    if (!sh || !isNum(marketP)) return { calibrated: pc, decision: pc, w_model: 1 };
    var w = isNum(sh.w_model) ? sh.w_model : 1;
    if (sh.by && sh.w_by && isNum(feats[sh.by])) w = interp(sh.w_by.x, sh.w_by.y, feats[sh.by]);
    w = clamp(w, 0, 1);
    var d = sh.space === 'prob' ? w * pc + (1 - w) * marketP : sigm(w * logit(pc) + (1 - w) * logit(marketP));
    return { calibrated: pc, decision: d, w_model: w };
  }

  /* ------------------------------------------------------- confidences */
  /* football: expected absolute error of the projection (points), on the displayed scale */
  function footballConfidence(pure, A) {
    var score = pure.football_prediction_confidence;
    var scale = A && A.reliability_scale && A.reliability_scale.expected_abs_error;
    var eae = scale && isNum(score) ? interp(scale.x, scale.y, score) : (isNum(pure.sigma) ? pure.sigma * Math.sqrt(2 / Math.PI) : null);
    return { score: isNum(score) ? score : null, expected_abs_error_pts: r(eae, 2),
             label: !isNum(score) ? 'UNKNOWN' : score >= 70 ? 'HIGH' : score >= 45 ? 'MEDIUM' : 'LOW' };
  }
  /* ------------------------------------------ production integrity hooks
     (docs/cfb-production/MARKET_INTEGRITY.md). The rules live in
     football/cfb_lab/integrity.js and the identity master in
     football/cfb_lab/identity.js; in node they are required, in a browser they
     are read from window.EDCfbIntegrity. Without them the minimal built-in
     bounds below still refuse the impossible (never a silent pass). */
  var INTEG = null, SAME_TEAM = null;
  function integ() {
    if (INTEG) return INTEG;
    if (root && root.EDCfbIntegrity) INTEG = root.EDCfbIntegrity;
    else if (typeof require === 'function') { try { INTEG = require('../cfb_lab/integrity.js'); } catch (e) { INTEG = null; } }
    return INTEG;
  }
  function sameTeam(a, b) {
    if (SAME_TEAM === null) {
      SAME_TEAM = false;
      if (root && typeof root.EDCfbSameTeam === 'function') SAME_TEAM = root.EDCfbSameTeam;
      else if (typeof require === 'function') { try { SAME_TEAM = require('../cfb_lab/identity.js').sameTeam; } catch (e) { SAME_TEAM = false; } }
    }
    if (SAME_TEAM) { try { return SAME_TEAM(a, b); } catch (e) { return null; } }
    return String(a).toLowerCase() === String(b).toLowerCase() ? true : null;
  }
  /* is this quote a possible market at all? (a +450 spread, odds of 0, a
     price inside (-100, +100), a two-way price below fair, a timestamp from the
     future: never decided on) */
  function quoteProblems(quote, now) {
    var I = integ();
    var q = { market_type: 'spread', home_line: quote.home_line, price_home: quote.price_home, price_away: quote.price_away,
      observed_at: quote.observed_at, provider_updated_at: quote.provider_updated_at };
    if (I) return I.validateQuote(q, { now: new Date(now).toISOString() }).reasons;
    var out = [], hl = quote.home_line;
    if (isNum(hl) && Math.abs(hl) > 70) out.push('SPREAD_OUT_OF_BOUNDS');
    [quote.price_home, quote.price_away].forEach(function (a) { if (isNum(a) && (a === 0 || Math.abs(a) < 100 || Math.abs(a) > 1000)) out.push('PRICE_INVALID'); });
    var o = quote.observed_at ? Date.parse(quote.observed_at) : NaN;
    if (isNum(o) && o > now + 5 * 60000) out.push('OBSERVED_IN_FUTURE');
    return out;
  }
  /* a quote's identity for the integrity verdict: its id, else its book and time */
  function quoteKey(q) { return q.quote_id != null ? String(q.quote_id) : 'book:' + q.book + '|' + q.observed_at; }
  /* the quote's TRUE age: the provider's own last update when it is older than
     our observation (a heartbeat of a book that stopped moving is not fresh) */
  function quoteAgeMinutes(quote, now) {
    var o = quote.observed_at ? Date.parse(quote.observed_at) : NaN;
    if (!isNum(o)) return null;
    var u = quote.provider_updated_at ? Date.parse(quote.provider_updated_at) : NaN;
    var base = isNum(u) && u < o ? u : o;
    return (now - base) / 60000;
  }

  /* market: freshness, depth, agreement — how trustworthy the offered number is right now */
  function marketConfidence(quote, market, now, P) {
    var age = quoteAgeMinutes(quote, now);
    var books = market && isNum(market.books) ? market.books : null, iqr = market && isNum(market.dispersion_iqr) ? market.dispersion_iqr : null;
    var s = 100, basis = [];
    if (!isNum(age)) { s = 0; basis.push('quote time unknown'); }
    else if (age > P.stale_minutes) { s = 0; basis.push('stale: ' + Math.round(age) + ' min'); }
    else if (age > P.stale_minutes / 2) { s -= 25; basis.push('aging quote'); }
    if (books == null) { s -= 30; basis.push('book count unknown'); } else if (books < (P.min_books || 3)) { s -= 30; basis.push(books + ' book(s)'); }
    if (iqr != null && iqr > (P.max_dispersion_iqr || 1.5)) { s -= 40; basis.push('books disagree by ' + iqr + ' pts'); }
    if (!isNum(quote.price_home) || !isNum(quote.price_away)) { s -= 20; basis.push('one-sided or missing prices'); }
    s = clamp(s, 0, 100);
    return { score: s, age_minutes: r(age, 1), books: books, dispersion_iqr: iqr,
             label: s >= 70 ? 'HIGH' : s >= 40 ? 'MEDIUM' : 'LOW', basis: basis };
  }
  function betConfidence(feats, A) {
    var p = A && A.bet_confidence ? evalModel(A.bet_confidence, feats) : null;
    var pclv = A && A.p_positive_clv ? evalModel(A.p_positive_clv, feats) : null;
    var base = isNum(p) ? p : pclv;
    return { p_positive_clv: r(pclv, 4), score: isNum(base) ? Math.round(100 * base) : null,
             label: !isNum(base) ? 'UNKNOWN' : base >= 0.58 ? 'HIGH' : base >= 0.52 ? 'MEDIUM' : 'LOW' };
  }

  /* --------------------------------------------------------- integrity */
  /* an unusually large apparent edge is checked before it is believed */
  /* EXTREME_COVER_PROBABILITY (§114): cfb_decision_calibration_v1's own
     evidence (cover_buckets_decision) shows no decision cover probability
     above 0.60 in 3,633 walk-forward development decisions. Beyond it the
     number is historically unobserved, so the same player-status and
     freshness checks an extreme edge gets must pass — a diagnostic trigger,
     not a cap: passing them changes nothing. A policy may set its own. */
  var EXTREME_COVER_PROBABILITY = 0.60;
  function integrityCheck(pure, quote, ctx, gapPts, ev, pCover) {
    var P = ctx.policy, failures = [], now = ctx.now;
    var extreme = Math.abs(gapPts) >= (P.extreme_gap_pts || 10) || (isNum(ev) && ev >= (P.extreme_ev || 0.12));
    var xp = isNum(P.extreme_cover_probability) ? P.extreme_cover_probability : EXTREME_COVER_PROBABILITY;
    var extremeP = isNum(pCover) && (pCover >= xp || pCover <= 1 - xp);
    var mkt = -quote.home_line;
    if (Math.abs(gapPts) > (P.orientation_gap || 21) && Math.abs(pure.projected_margin + mkt) <= (P.orientation_reconcile || 7)) {
      failures.push('sign: the market number looks flipped relative to the model');
    }
    if (String(quote.game_id) !== String(pure.game_id)) failures.push('mapping: quote game ' + quote.game_id + ' is not projection game ' + pure.game_id);
    /* the team join goes through the identity master ("Texas Longhorns" is
       Texas; "Miami" is never "Miami (OH)"); a pair it cannot verify fails */
    if (quote.home_team && pure.home && sameTeam(quote.home_team, pure.home) !== true) {
      failures.push('join: quote home team ' + quote.home_team + ' is not ' + pure.home);
    }
    var ko = pure.kickoff ? Date.parse(pure.kickoff) : NaN;
    if (!isNum(ko) || now >= ko) failures.push('schedule: the game has kicked off or has no kickoff time');
    else if (ko - now > 10 * 86400000) failures.push('schedule: kickoff more than 10 days away');
    if (ctx.expected_model_version && pure.model_version !== ctx.expected_model_version) failures.push('model version: ' + pure.model_version);
    if (extreme || extremeP) {
      var row = ctx.row || {};
      if (row.qb_missing_any || row.qb_unsettled_any) failures.push('player status: a starting quarterback is unresolved');
      var age = quoteAgeMinutes(quote, now);
      if (!isNum(age)) age = Infinity;
      if (!(age <= (P.extreme_max_age_minutes || 60))) failures.push('freshness: an extreme edge needs a quote under ' + (P.extreme_max_age_minutes || 60) + ' min old');
    }
    return { extreme: extreme, extreme_probability: extremeP, ok: failures.length === 0, failures: failures };
  }

  /* -------------------------------------------------------- features */
  function features(pure, quote, side, pPure, gapSide, ctx, mc) {
    var row = ctx.row || {}, wk = isNum(pure.week) ? pure.week : row.week;
    return {
      pure_cover_prob: pPure, gap_pts: gapSide, abs_gap_pts: Math.abs(gapSide),
      sigma: pure.sigma, ens_sd: isNum(pure.ensemble_sd) ? pure.ensemble_sd : row.ens_sd,
      reliability: pure.football_prediction_confidence, week: wk,
      /* an explicit 0 is an answer, not a missing value: postseason games carry schedule week 1 */
      early_season: row.early_season != null ? (row.early_season ? 1 : 0) : (isNum(wk) && wk <= 3 ? 1 : 0),
      qb_unsettled: row.qb_unsettled_any ? 1 : 0, qb_missing: row.qb_missing_any ? 1 : 0,
      dispersion: mc && isNum(mc.dispersion_iqr) ? mc.dispersion_iqr : null, books: mc ? mc.books : null,
      quote_age_min: mc ? mc.age_minutes : null, is_home_side: side === 'HOME' ? 1 : 0,
      abs_line: Math.abs(quote.home_line)
    };
  }

  /* ------------------------------------------------------- one quote */
  function sideNumbers(pure, quote, side, ctx) {
    var P = ctx.policy, A = ctx.artifact;
    var price = side === 'HOME' ? quote.price_home : quote.price_away;
    var other = side === 'HOME' ? quote.price_away : quote.price_home;
    var pPure = pureCover(pure, quote.home_line, side);
    var mktMargin = -quote.home_line, gap = pure.projected_margin - mktMargin;
    var gapSide = side === 'HOME' ? gap : -gap;
    var dv = devig(price, other);
    var marketP = dv ? dv.p_a : 0.5;
    var mc = ctx._mc;
    var feats = features(pure, quote, side, pPure, gapSide, ctx, mc);
    var dp = decisionProbability(pPure, marketP, feats, A);
    feats.decision_cover_prob = dp.decision;
    var pp = pushProb(quote.home_line, A.push_table || P.push_table);
    var be = breakEven(price);
    var ev = expectedValue(dp.decision, pp, price);
    var evTheory = expectedValue(pPure, pp, price);
    // Empirical EV is the one the thresholds read. A curve declares its input: ev_curve_decision maps the
    // decision EV; ev_curve with input 'theoretical_ev' maps the pure model's EV and is reported only.
    // An ev_curve without an input declaration predates the schema field and maps the decision EV.
    var cT = A.ev_curve && A.ev_curve.input === 'theoretical_ev' ? A.ev_curve : null;
    var cD = A.ev_curve_decision || (A.ev_curve && !cT ? A.ev_curve : null);
    var evEmp = isNum(ev) ? (cD ? interp(cD.x, cD.y, ev) : (cT ? null : ev)) : ev;
    var evEmpT = isNum(evTheory) && cT ? interp(cT.x, cT.y, evTheory) : null;
    var expClv = A.clv_magnitude ? evalModel(A.clv_magnitude, feats) : null;
    return { side: side, price: isNum(price) ? price : null, pure_cover_probability: pPure,
      calibrated_cover_probability: dp.calibrated, decision_cover_probability: dp.decision, w_model: dp.w_model,
      market_implied_probability: marketP, devig: dv, push_probability: pp, break_even_probability: be,
      probability_edge: isNum(be) ? dp.decision - be : null, theoretical_ev: evTheory, decision_ev: ev,
      empirical_ev: evEmp, empirical_ev_theoretical: evEmpT, expected_clv_pts: expClv, gap_pts: gapSide, features: feats };
  }

  function decideQuote(pure, quote, ctx) {
    ctx = ctx || {};
    var P = ctx.policy, A = ctx.artifact, now = isNum(ctx.now) ? ctx.now : (ctx.now ? Date.parse(ctx.now) : Date.now());
    var out = { engine: ENGINE_ID, engine_version: ENGINE_VERSION, layer: 'wager_decision',
      game_id: pure && pure.game_id, book: quote && quote.book, quote_id: quote && quote.quote_id,
      observed_at: quote && quote.observed_at, home_line: quote && quote.home_line,
      decided_at: new Date(now).toISOString(), model_version: pure && pure.model_version,
      policy_version: P && P.version, artifact_version: A && A.version,
      status: 'NO_BET', timing: 'NONE', reason_codes: [], reasons: [] };
    function fin(status, codes) {
      out.status = status;
      (codes || []).forEach(function (c) { if (out.reason_codes.indexOf(c) < 0) { out.reason_codes.push(c); out.reasons.push(REASON[c] || c); } });
      if (status !== 'BET') { out.timing = 'NONE'; out.stake_u = 0; }
      return deepFreeze(out);
    }
    /* fail closed: nothing below runs without a projection, a policy and a matching artifact */
    if (!pure || pure.status !== 'PREDICTED') return fin('NO_BET', ['NO_BET_COMPUTATION']);
    var pv = validatePolicy(P);
    if (!pv.ok) { out.detail = pv.detail; return fin('NO_BET', [pv.code]); }
    var av = validateArtifact(A, pure.model_version);
    if (!av.ok) { out.detail = av.detail; return fin('NO_BET', [av.code]); }
    if (!quote || !isNum(quote.home_line)) return fin('NO_BET', ['NO_BET_COMPUTATION']);
    /* an impossible quote is not a market: PASS, never a number computed from it */
    var qp = quoteProblems(quote, now);
    if (qp.length) { out.detail = 'invalid quote: ' + qp.join(', '); return fin('PASS', ['PASS_MARKET_INVALID']); }
    var mi = ctx.market && ctx.market.integrity;
    if (mi && mi.quarantined_quote_ids && mi.quarantined_quote_ids.indexOf(quoteKey(quote)) >= 0) { out.detail = 'the quote is quarantined or a cross-book outlier'; return fin('PASS', ['PASS_MARKET_INVALID']); }
    ctx.now = now;
    var mc = marketConfidence(quote, ctx.market || {}, now, P);
    ctx._mc = mc;
    var h, a;
    try {
      h = sideNumbers(pure, quote, 'HOME', ctx);
      a = sideNumbers(pure, quote, 'AWAY', ctx);
    } catch (e) {
      out.detail = String(e && e.message || e);
      return fin('NO_BET', ['NO_BET_COMPUTATION']);
    }
    /* the side: the larger decision probability edge where both are priced, else the model's side */
    var s = (isNum(h.probability_edge) && isNum(a.probability_edge))
      ? (h.probability_edge >= a.probability_edge ? h : a)
      : (h.decision_cover_probability >= a.decision_cover_probability ? h : a);
    if (!isNum(s.pure_cover_probability) || !isNum(s.decision_cover_probability)) return fin('NO_BET', ['NO_BET_COMPUTATION']);
    out.side = s.side;
    out.line_for_side = s.side === 'HOME' ? quote.home_line : -quote.home_line;
    out.price = s.price;
    out.pure_cover_probability = r(s.pure_cover_probability);
    out.calibrated_cover_probability = r(s.calibrated_cover_probability);
    out.decision_cover_probability = r(s.decision_cover_probability);
    out.market_implied_probability = r(s.market_implied_probability);
    out.model_weight = r(s.w_model, 3);
    out.push_probability = r(s.push_probability);
    out.break_even_probability = r(s.break_even_probability);
    out.probability_edge = r(s.probability_edge);
    out.theoretical_ev = r(s.theoretical_ev);
    out.decision_ev = r(s.decision_ev);
    out.empirical_ev = r(s.empirical_ev);
    out.expected_clv_pts = r(s.expected_clv_pts, 2);
    out.model_market_gap_pts = r(s.gap_pts, 2);
    out.vig = s.devig ? { overround: r(s.devig.overround), hold: r(s.devig.hold) } : null;
    out.football_confidence = footballConfidence(pure, A);
    out.market_confidence = mc;
    out.bet_confidence = betConfidence(s.features, A);
    out.price_targets = priceTargets(pure, quote, s.side, ctx);
    var ev = s.empirical_ev, pe = s.probability_edge, row = ctx.row || {};
    var integ = integrityCheck(pure, quote, ctx, s.gap_pts, s.decision_ev, s.decision_cover_probability);
    out.integrity = integ;
    /* ------------------------------------------------ the gates, in order */
    if (!integ.ok) return fin('PASS', ['PASS_DATA_QUALITY']);
    if (mc.age_minutes == null || mc.age_minutes > P.stale_minutes) return fin('PASS', ['PASS_MARKET_STALE']);
    if (!isNum(s.price)) return fin('PASS', ['PASS_PRICE']);
    if (isNum(P.max_price) && !priceBetterOrEqual(s.price, P.max_price)) { out.detail = 'price ' + s.price + ' is worse than the ' + P.max_price + ' limit'; return fin('PASS', ['PASS_PRICE']); }
    if (isNum(mc.dispersion_iqr) && mc.dispersion_iqr > (P.max_dispersion_iqr || 1.5)) return fin('PASS', ['PASS_MARKET_DISPERSION']);
    if (!isNum(ev) || !isNum(pe)) return fin('NO_BET', ['NO_BET_COMPUTATION']);
    /* the line moved through what was bettable (ctx.previous carries the last decision) */
    var prev = ctx.previous;
    if (prev && prev.side === s.side && prev.price_targets && isNum(prev.price_targets.bettable_to_line)
        && out.line_for_side < prev.price_targets.bettable_to_line - 1e-9 && pe < P.min_probability_edge) {
      out.detail = 'line ' + out.line_for_side + ' is past the previous bettable-to ' + prev.price_targets.bettable_to_line;
      return fin('PASS', ['PASS_LINE_MOVED']);
    }
    var clears = pe >= P.min_probability_edge && ev >= P.min_ev;
    var held = false;
    if (!clears && prev && prev.status === 'BET' && prev.side === s.side && P.hysteresis
        && pe >= P.min_probability_edge - (P.hysteresis.edge_buffer || 0) && ev >= P.min_ev - (P.hysteresis.ev_buffer || 0)) {
      clears = true; held = true;
    }
    /* uncertainty that turns a potential edge into RESEARCH (monitor, never bet now) */
    var research = [];
    if (row.qb_missing_any || row.qb_unsettled_any) research.push('RESEARCH_QB');
    if (isNum(mc.books) && mc.books < (P.min_books || 3)) research.push('RESEARCH_MARKET_IMMATURE');
    if (row.data_incomplete) research.push('RESEARCH_DATA_INCOMPLETE');
    if (integ.extreme) research.push('RESEARCH_EXTREME_EDGE');
    var fc = out.football_confidence, bc = out.bet_confidence;
    var uncertain = isNum(P.min_football_confidence) && isNum(fc.score) && fc.score < P.min_football_confidence;
    var disagree = isNum(P.max_ensemble_sd) && isNum(s.features.ens_sd) && s.features.ens_sd > P.max_ensemble_sd;
    var weakBet = isNum(P.min_bet_confidence) && (!isNum(bc.score) || bc.score < P.min_bet_confidence);
    if (clears) {
      if (research.length) return fin('RESEARCH', research);
      if (uncertain) return fin('PASS', ['PASS_MODEL_UNCERTAINTY']);
      if (disagree) return fin('PASS', ['PASS_MODEL_DISAGREEMENT']);
      if (weakBet) return fin('LEAN', ['LEAN_DIRECTIONAL']);
      if (!P.bet_enabled) return fin('LEAN', ['NO_BET_BETTING_DISABLED']);
      /* fail closed (§13, §24, §46): a BET needs an ACTIONABLE consensus when one was assessed */
      if (mi && mi.actionable_status && mi.actionable_status !== 'ACTIONABLE') {
        out.detail = 'market ' + mi.actionable_status + (mi.reasons && mi.reasons.length ? ': ' + mi.reasons.join('; ') : '');
        return fin('PASS', [mi.actionable_status === 'MARKET_STALE' ? 'PASS_MARKET_STALE' : (mi.actionable_status === 'MARKET_INVALID' ? 'PASS_MARKET_INVALID' : 'PASS_MARKET_DEGRADED')]);
      }
      out.timing = timing(out, s, ctx);
      if (held) { out.reason_codes.push('HELD_BY_HYSTERESIS'); out.reasons.push(REASON.HELD_BY_HYSTERESIS); }
      out.stake_u = stake(out, P);
      return fin('BET', ['BET_VALIDATED']);
    }
    /* LEAN is quantitative: a positive decision edge over break-even and a real line disagreement */
    var L = P.lean || {};
    if (pe > (L.min_probability_edge || 0) && Math.abs(s.gap_pts) >= (L.min_gap_pts || 1) && !research.length) {
      return fin('LEAN', ['LEAN_DIRECTIONAL']);
    }
    if (research.length && s.pure_cover_probability - s.break_even_probability >= P.min_probability_edge) return fin('RESEARCH', research);
    return fin('PASS', [pe <= 0 ? 'PASS_PRICE' : 'PASS_INSUFFICIENT_EV']);
  }

  /* ------------------------------------------------------ BET NOW / WAIT */
  /* WAIT only when the policy has validated evidence that waiting pays: the
     expected EV at the expected later price beats betting now by a margin
     larger than the chance the edge disappears. Otherwise BET NOW. */
  function timing(out, s, ctx) {
    var W = ctx.policy.wait;
    if (!W || !W.enabled || !isNum(out.expected_clv_pts)) return 'BET_NOW';
    /* negative expected CLV = the line is expected to move toward our side (a better number later) */
    if (out.expected_clv_pts >= 0) return 'BET_NOW';
    var gain = -out.expected_clv_pts * (W.ev_per_point || 0.03);
    var loss = (W.p_disappear || 0.3) * (out.empirical_ev || 0);
    return gain - loss > (W.min_benefit_ev || 0.01) ? 'WAIT' : 'BET_NOW';
  }

  /* ------------------------------------------------------ price targets */
  /* For the chosen side: the price floor at this line (BETTABLE TO price),
     the worst line at the reference price that still clears the thresholds
     (BETTABLE TO line), and the entry ladder. Recomputed every snapshot. */
  function priceTargets(pure, quote, side, ctx) {
    var P = ctx.policy, A = ctx.artifact, ref = isNum(P.reference_price) ? P.reference_price : -110;
    var sgn = side === 'HOME' ? 1 : -1, lineSide = sgn * quote.home_line;
    function atLine(lineForSide, price) {
      var q = { game_id: quote.game_id, home_line: sgn * lineForSide, price_home: side === 'HOME' ? price : null,
                price_away: side === 'AWAY' ? price : null, observed_at: quote.observed_at, book: quote.book };
      return sideNumbers(pure, q, side, ctx);
    }
    function clears(n) { return isNum(n.probability_edge) && isNum(n.empirical_ev) && n.probability_edge >= P.min_probability_edge && n.empirical_ev >= P.min_ev; }
    var curPrice = side === 'HOME' ? quote.price_home : quote.price_away;
    var cur = atLine(lineSide, isNum(curPrice) ? curPrice : ref);
    /* the price floor at this line reads the SAME gates decideQuote does: the probability edge and
       the calibrated (curve-mapped) EV. null when no price clears (e.g. an EV curve that never
       reaches min_ev): a bettable-to price is never shown for a quote no price could make a BET */
    var evFloor = decisionEvFloor(A, P.min_ev), pc = cur.decision_cover_probability, pp = cur.push_probability;
    var minPrice = evFloor === null || !isNum(pc) ? null : (evFloor === -Infinity ? null : minimumPrice(pc, pp, evFloor));
    var cands = [], floorOk = evFloor !== null && isNum(pc);
    if (floorOk && evFloor !== -Infinity) { if (isNum(minPrice)) cands.push(minPrice); else floorOk = false; }
    var beMax = isNum(pc) ? pc - P.min_probability_edge : null;
    if (floorOk) { if (isNum(beMax) && beMax > 0 && beMax < 1) cands.push(payoutToAmerican((1 - beMax) / beMax)); else floorOk = false; }
    var cand = null, k;
    for (k = 0; floorOk && k < cands.length; k++) if (cand === null || priceBetterOrEqual(cands[k], cand)) cand = cands[k];
    for (k = 0; cand !== null && k < 5 && !clears(atLine(lineSide, cand)); k++) cand = nextBetterPrice(cand);   /* rounding */
    if (cand !== null && !clears(atLine(lineSide, cand))) cand = null;
    /* the edge only shrinks as the line worsens for our side (a lower line-for-side), so the
       WORST line that still clears is found by walking down from ten points better */
    function worst(pred) {
      var found = null, L, n;
      for (L = lineSide + 10; L >= lineSide - 10 - 1e-9; L -= 0.5) {
        n = atLine(L, ref);
        if (pred(n)) found = L; else if (found != null) break;
      }
      return found;
    }
    var bettable = worst(clears);
    var idealEdge = isNum(P.ideal_probability_edge) ? P.ideal_probability_edge : 2 * P.min_probability_edge;
    var ideal = worst(function (n) { return isNum(n.probability_edge) && n.probability_edge >= idealEdge && clears(n); });
    var worstAllowed = P.max_price;
    var floor = cand === null ? null : (!isNum(worstAllowed) || priceBetterOrEqual(cand, worstAllowed) ? cand : worstAllowed);
    return { side: side, current_line: lineSide, reference_price: ref,
      bettable_to_price: floor, bettable_to_line: bettable, ideal_entry_line: ideal,
      acceptable_entry: bettable != null ? { line: bettable, price: ref } : null,
      minimum_ev_entry: isNum(minPrice) ? { line: lineSide, price: minPrice } : null,
      do_not_bet: bettable != null ? { worse_than_line: bettable, or_price_worse_than: floor } : { any: true } };
  }

  /* ------------------------------------------------------------ staking */
  /* Runs AFTER selection. Flat is the baseline; fractional Kelly only when the
     policy says the calibration validated. The Kelly input is the decision
     probability, capped at the edge-saturation probability, and the stake is
     hard-capped. Full Kelly is never allowed. */
  function kellyFraction(p, price) {
    var b = americanToPayout(price);
    if (b == null || !isNum(p)) return 0;
    return Math.max(0, (b * p - (1 - p)) / b);
  }
  function stake(d, P) {
    var S = P.stake || {}, unit = isNum(S.unit_u) ? S.unit_u : 1;
    if (S.method !== 'fractional_kelly' || !S.kelly_validated) return Math.min(unit, isNum(S.max_stake_u) ? S.max_stake_u : unit);
    var frac = clamp(isNum(S.kelly_fraction) ? S.kelly_fraction : 0.1, 0, 0.25);      /* never above quarter Kelly */
    var pSat = isNum(S.saturation_probability) ? S.saturation_probability : 0.6;
    var p = Math.min(d.decision_cover_probability, pSat);
    var f = kellyFraction(p, d.price) * frac * (isNum(S.bankroll_u) ? S.bankroll_u : 100);
    return r(Math.min(f, isNum(S.max_stake_u) ? S.max_stake_u : 1), 2);
  }
  /* Game and slate exposure: every position on one game counts together
     (spread, moneyline, alternates, team totals, game total), weighted by the
     policy's correlation assumptions; the slate and any conference cluster are
     capped. Stakes are scaled down, never up, and eligibility never changes. */
  function applyExposure(positions, P) {
    var E = P.exposure || {}, byGame = {}, i, k;
    var list = positions.map(function (x) { return Object.assign({}, x, { stake_u: x.stake_u || 0, scaled_by: [] }); });
    list.forEach(function (x) { (byGame[x.game_id] = byGame[x.game_id] || []).push(x); });
    for (k in byGame) if (Object.prototype.hasOwnProperty.call(byGame, k)) {
      var g = byGame[k], tot = 0, rho = isNum(E.same_game_correlation) ? E.same_game_correlation : 1, v = 0;
      for (i = 0; i < g.length; i++) tot += g[i].stake_u;
      /* correlated sum: sqrt(sum s_i^2 + 2 rho sum_{i<j} s_i s_j) (rho = 1 -> the plain sum) */
      for (i = 0; i < g.length; i++) { v += g[i].stake_u * g[i].stake_u; for (var j = i + 1; j < g.length; j++) v += 2 * rho * g[i].stake_u * g[j].stake_u; }
      var eff = Math.sqrt(Math.max(0, v)), cap = isNum(E.max_game_u) ? E.max_game_u : 1.5;
      if (eff > cap && eff > 0) g.forEach(function (x) { x.stake_u = r(x.stake_u * cap / eff, 3); x.scaled_by.push('game cap ' + cap + 'u'); });
    }
    function capGroup(key, capU, label) {
      if (!isNum(capU)) return;
      var groups = {};
      list.forEach(function (x) { var g = key(x); if (g != null) (groups[g] = groups[g] || []).push(x); });
      Object.keys(groups).forEach(function (g) {
        var s = groups[g].reduce(function (a, x) { return a + x.stake_u; }, 0);
        if (s > capU) groups[g].forEach(function (x) { x.stake_u = r(x.stake_u * capU / s, 3); x.scaled_by.push(label + ' ' + capU + 'u'); });
      });
    }
    capGroup(function (x) { return x.conference_cluster || null; }, E.max_cluster_u, 'cluster cap');
    capGroup(function () { return 'slate'; }, E.max_slate_u, 'slate cap');
    return { positions: list, total_u: r(list.reduce(function (a, x) { return a + x.stake_u; }, 0), 3) };
  }

  /* ---------------------------------------------------------- the game */
  function decideGame(pure, market, ctx) {
    ctx = ctx || {};
    var quotes = (market && market.quotes) || [];
    /* the consensus integrity of the main-line quotes (integrity.assessMarket),
       unless the caller assessed it already: a BET needs it ACTIONABLE */
    var I = integ(), mk = market;
    if (market && !market.integrity && I && quotes.length) {
      var nowMs = isNum(ctx.now) ? ctx.now : (ctx.now ? Date.parse(ctx.now) : Date.now());
      var main = quotes.filter(function (q) { return q && q.market_type !== 'total' && q.market_type !== 'moneyline' && !q.alternate; })
        .map(function (q) { return { source: q.source || 'book', book: q.book, market_type: 'spread', home_line: q.home_line, price_home: q.price_home, price_away: q.price_away,
          observed_at: q.observed_at, provider_updated_at: q.provider_updated_at, is_pregame: true, quote_id: quoteKey(q) }; });
      mk = Object.assign({}, market, { integrity: I.assessMarket(main, new Date(nowMs).toISOString(), { kickoff: pure && pure.kickoff, maxAgeH: ctx.policy && isNum(ctx.policy.stale_minutes) ? ctx.policy.stale_minutes / 60 : undefined }) });
    }
    var per = quotes.filter(function (q) { return q && q.market_type !== 'total' && !q.alternate; })
      .map(function (q) {
        var prev = ctx.previous_by_book ? ctx.previous_by_book[q.book] : null;
        return decideQuote(pure, q, Object.assign({}, ctx, { market: mk, previous: prev }));
      });
    var bets = per.filter(function (d) { return d.status === 'BET'; });
    var rank = function (d) { return isNum(d.empirical_ev) ? d.empirical_ev : -1; };
    var best = bets.sort(function (x, y) { return rank(y) - rank(x); })[0] || null;
    var order = { BET: 5, RESEARCH: 4, LEAN: 3, PASS: 2, NO_BET: 1 };
    var top = per.slice().sort(function (x, y) { return (order[y.status] - order[x.status]) || (rank(y) - rank(x)); })[0] || null;
    var out = { engine: ENGINE_ID, engine_version: ENGINE_VERSION, game_id: pure && pure.game_id,
      status: best ? 'BET' : (top ? top.status : 'NO_BET'),
      best_quote: best ? { book: best.book, side: best.side, line: best.line_for_side, price: best.price,
                           bettable_to_line: best.price_targets.bettable_to_line, bettable_to_price: best.price_targets.bettable_to_price } : null,
      reason_codes: best ? best.reason_codes : (top ? top.reason_codes : ['NO_BET_COMPUTATION']),
      by_book: per.map(function (d) { return { book: d.book, status: d.status, side: d.side, line: d.line_for_side, price: d.price,
        probability_edge: d.probability_edge, empirical_ev: d.empirical_ev, reason_codes: d.reason_codes }; }),
      decisions: per };
    if (!per.length) out.reason_codes = ['PASS_PRICE'];
    return deepFreeze(out);
  }

  /* ------------------------------------------------------ explanations */
  function pct(x, k) { return isNum(x) ? (100 * x).toFixed(k == null ? 1 : k) + '%' : 'n/a'; }
  function explain(d) {
    if (!d) return '';
    var s = d.status, c = d.reason_codes || [];
    if (s === 'BET') {
      return 'Decision cover probability ' + pct(d.decision_cover_probability) + ' against break-even ' + pct(d.break_even_probability)
        + ' at ' + d.price + ' (edge ' + (isNum(d.probability_edge) ? '+' + (100 * d.probability_edge).toFixed(1) + ' pp' : 'n/a')
        + ', calibrated EV ' + pct(d.empirical_ev) + '); the price clears the validated thresholds'
        + (d.price_targets && d.price_targets.bettable_to_line != null ? '; bettable to ' + d.price_targets.bettable_to_line : '') + '.';
    }
    var first = c[0];
    var why = REASON[first] || 'no qualifying price';
    if (first === 'PASS_MODEL_DISAGREEMENT' && d.market_confidence) why = 'model disagreement is too high relative to the apparent price edge';
    var nums = isNum(d.probability_edge) ? ' (edge ' + (d.probability_edge >= 0 ? '+' : '') + (100 * d.probability_edge).toFixed(1) + ' pp, calibrated EV ' + pct(d.empirical_ev) + ')' : '';
    return s + ': ' + why + nums + '.';
  }
  /* audit any text shown beside a decision: numbers first, no hype, no promises */
  function auditLanguage(text, d) {
    var problems = [], t = String(text || '');
    BANNED_ALWAYS.forEach(function (re) { if (re.test(t)) problems.push('forbidden claim: ' + re); });
    if (!d || d.status !== 'BET') BET_ONLY.forEach(function (re) { if (re.test(t)) problems.push('"' + re.source + '" on a ' + (d ? d.status : 'missing') + ' decision'); });
    if (/value|edge|advantage/i.test(t) && !/\d/.test(t)) problems.push('claims value without a supporting number');
    if (d && d.status !== 'BET' && /\b(bet|play|take)\b.*\bnow\b/i.test(t)) problems.push('tells the reader to bet on a ' + d.status);
    return { ok: problems.length === 0, problems: problems };
  }
  /* LLM boundary: narrative text is attached AFTER the decision and cannot change it */
  function attachNarrative(d, narrative) {
    var a = auditLanguage(narrative, d);
    return deepFreeze({ decision: d, narrative: a.ok ? String(narrative) : null, narrative_refused: a.ok ? null : a.problems,
      note: 'the narrative explains the decision; the quantitative engine alone sets status, price and stake' });
  }
  /* a person's wager: kept apart, never official, never counted in the model record */
  function manualDecision(x) {
    return deepFreeze({ manual_decision: true, official: false, game_id: x.game_id, book: x.book, side: x.side,
      line: x.line, price: x.price, stake_u: x.stake_u, decided_by: x.decided_by || null, note: x.note || null,
      decided_at: x.decided_at || new Date().toISOString(), model_decision_at_the_time: x.model_status || null });
  }
  function assertOfficial(rec) {
    if (!rec || rec.manual_decision || rec.official === false) throw new Error('manual decisions never enter the official record');
    if (rec.engine !== ENGINE_ID) throw new Error('only the decision engine writes official decisions');
    return true;
  }

  /* ------------------------------------------------------ public output */
  function publicCard(pure, g, names) {
    var d = g && g.status === 'BET' ? g.decisions.filter(function (x) { return x.status === 'BET' && x.book === g.best_quote.book; })[0]
      : (g && g.decisions && g.decisions[0]);
    var team = function (side) { return side === 'HOME' ? (names && names.home) || pure.home : (names && names.away) || pure.away; };
    var fmtLine = function (l) { return l > 0 ? '+' + l : String(l); };
    var conf = d && d.bet_confidence ? d.bet_confidence.label : 'UNKNOWN';
    return {
      fair_line: pure.fair_spread_display,
      best_market: d && isNum(d.line_for_side) ? team(d.side) + ' ' + fmtLine(d.line_for_side) + (isNum(d.price) ? ' ' + d.price : '') : null,
      cover_probability: d ? pct(d.decision_cover_probability, 0) : null,
      break_even: d ? pct(d.break_even_probability, 1) : null,
      edge: d && isNum(d.probability_edge) ? (d.probability_edge >= 0 ? '+' : '') + (100 * d.probability_edge).toFixed(1) + ' percentage points' : null,
      decision: g ? (g.status === 'NO_BET' ? 'NO BET' : g.status) : 'NO BET',
      bettable_to: g && g.best_quote && g.best_quote.bettable_to_line != null ? fmtLine(g.best_quote.bettable_to_line) : null,
      confidence: conf.charAt(0) + conf.slice(1).toLowerCase(),
      why: explain(d),
      note: 'Probabilities, not promises: an edge is an expected value, and any single game can lose.'
    };
  }

  return {
    ENGINE_ID: ENGINE_ID, ENGINE_VERSION: ENGINE_VERSION, STATUS: STATUS, TIMING: TIMING, REASON: REASON,
    tCdf: tCdf, americanToPayout: americanToPayout, payoutToAmerican: payoutToAmerican, breakEven: breakEven,
    devig: devig, pushProb: pushProb, expectedValue: expectedValue, minimumPrice: minimumPrice,
    applyMap: applyMap, calibrate: calibrate, evalModel: evalModel, validateArtifact: validateArtifact,
    validatePolicy: validatePolicy, pureCover: pureCover, decisionProbability: decisionProbability,
    footballConfidence: footballConfidence, marketConfidence: marketConfidence, betConfidence: betConfidence,
    integrityCheck: integrityCheck, sideNumbers: sideNumbers, decideQuote: decideQuote, decideGame: decideGame, priceTargets: priceTargets,
    kellyFraction: kellyFraction, stake: stake, applyExposure: applyExposure, explain: explain,
    auditLanguage: auditLanguage, attachNarrative: attachNarrative, manualDecision: manualDecision,
    assertOfficial: assertOfficial, publicCard: publicCard, timing: timing
  };
}));
