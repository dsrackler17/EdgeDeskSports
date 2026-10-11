/* ===========================================================================
   EdgeDesk FAIR LINE — one game's full price sheet from one projection.

   WHAT IT DOES
     Given a game's projection (the engine's fair home margin and fair total)
     and the walk-forward calibration record for its league
     (football/validation/linemaker_<league>.json, written by
     tools/football/linemaker_calibrate.js), it returns the probability
     distribution of every market EdgeDesk prices, and from those
     distributions:
       - the fair spread, moneyline, total and both team totals;
       - alternate spread, total and team-total ladders (win / push / lose
         and the no-vig fair price at every half point);
       - a price check: for any line and any American price, the cover
         probability, the break-even, the probability edge and the expected
         return per unit, with the held-out calibration interval beside them;
       - a ranking of several quoted prices that may be empty.

   WHERE THE DISTRIBUTIONS COME FROM (never chosen here)
     The calibration tool scores every candidate on held-out seasons and
     records, per market, the method that won under a rule written down
     before the scores were read. The candidates:
       NORMAL_RAW     a normal on the engine's own number, the training residual sd
       NORMAL_CAL     a normal on the recalibrated number (y = a + b·x, fitted
                      on seasons before the one scored)
       KERNEL_JOINT   each team's points as a kernel-weighted empirical
                      distribution of real scores given its projected points,
                      the two teams independent (their residual correlation is
                      measured in the record), convolved into margin and total
       ENGINE         the shipped engine's own distribution (the incumbent;
                      kept unless a challenger beats it)
     This module computes NORMAL_* and KERNEL_JOINT itself. ENGINE needs the
     engine, so the Node builder passes it in as a hook; the published sheet
     stores the resulting distributions, so the browser never needs either.

   THE RULES
     - Every probability carries its market's calibration status (CALIBRATED /
       PROVISIONAL / UNCALIBRATED, from the record) and the market's validation
       tier against the closing line (football/validation/pricing_<league>.json).
       "Calibrated against outcomes" is NOT "beats the market".
     - A price check never says BET or PLAY. Its verdicts are VALUE / THIN /
       NO_VALUE / CANNOT_EVALUATE. VALUE needs a CALIBRATED market, a positive
       expected return, AND a positive edge at the bottom of the held-out
       calibration interval.
     - EV is computed only from an explicit model probability for that exact
       line, never from a points gap (lib/research_core.js priceAssessment).
     - No odds arithmetic lives here: conversions, break-even, no-vig and
       expected return are lib/research_core.js (EDResearch).

   Browser: window.EDFairLine (load lib/research_core.js first; it reads
   window.EDResearchCore, the library's collision-free name).
   Node:    require('./edgedesk_fairline.js').
   =========================================================================== */
/*__EDFAIRLINE_START__*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDFairLine = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '1.0.0';
  var SCHEMA = 'edgedesk_fairline_v1';
  var MARKETS = ['spread', 'moneyline', 'total', 'team_total'];
  var METHODS = ['NORMAL_RAW', 'NORMAL_CAL', 'KERNEL_JOINT', 'ENGINE'];
  var STATUSES = ['CALIBRATED', 'PROVISIONAL', 'UNCALIBRATED'];
  var VERDICTS = ['VALUE', 'THIN', 'NO_VALUE', 'CANNOT_EVALUATE'];
  var EPS = 1e-12;

  /* ------------------------------------------------------------ odds */
  var R_ = null;
  function R() {
    if (R_) return R_;
    /* EDResearchCore is the collision-free name: app.html's AI desk publishes
       its own window.EDResearch (tool primitives) over the library's */
    var r = root && root.EDResearchCore && root.EDResearchCore.odds ? root.EDResearchCore : (root && root.EDResearch && root.EDResearch.odds ? root.EDResearch : null);
    if (!r && typeof require === 'function') { try { r = require('./research_core.js'); } catch (_) { r = null; } }
    if (!r || !r.odds) throw new Error('lib/research_core.js (EDResearch) must be loaded before EDFairLine prices anything');
    return (R_ = r);
  }

  /* ------------------------------------------------------------ util */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function r1(v) { return v == null ? null : Math.round(v * 10) / 10; }
  function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
  function half(v) { return Math.round(v * 2) / 2; }
  function erf(x) { var t = 1 / (1 + 0.3275911 * Math.abs(x)); var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
  function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }

  /* ------------------------------------------------------------- PMFs
     A PMF over integers is {lo, p}: p[i] = P(X = lo + i). Every function
     returns a new object and leaves its inputs alone. */
  function pmf(lo, p) { return { lo: lo, p: p }; }
  function total(a) { var s = 0; for (var i = 0; i < a.p.length; i++) s += a.p[i]; return s; }
  function normalize(a) { var s = total(a); if (!(s > 0)) return null; return pmf(a.lo, a.p.map(function (x) { return x / s; })); }

  /** a normal discretised onto the integers lo..hi (each integer owns [k-½, k+½]) */
  function normalPmf(mu, sd, lo, hi) {
    if (num(mu) == null || !(sd > 0)) return null;
    lo = Math.floor(lo); hi = Math.ceil(hi);
    var p = [];
    for (var k = lo; k <= hi; k++) p.push(normCdf((k + 0.5 - mu) / sd) - normCdf((k - 0.5 - mu) / sd));
    return normalize(pmf(lo, p));
  }
  /** (1-w)·a + w·b */
  function mix(a, b, w) {
    if (!a) return b; if (!b || !(w > 0)) return a;
    var lo = Math.min(a.lo, b.lo), hi = Math.max(a.lo + a.p.length, b.lo + b.p.length) - 1, p = [];
    for (var k = lo; k <= hi; k++) p.push((1 - w) * at(a, k) + w * at(b, k));
    return normalize(pmf(lo, p));
  }
  function at(a, k) { var i = k - a.lo; return i >= 0 && i < a.p.length ? a.p[i] : 0; }
  /** the margin (h − a) and total (h + a) of two independent team PMFs */
  function convolve(h, a) {
    if (!h || !a) return null;
    var hn = h.p.length, an = a.p.length;
    var mLo = h.lo - (a.lo + an - 1), tLo = h.lo + a.lo;
    var m = new Array(hn + an - 1), t = new Array(hn + an - 1), i, j, x;
    for (i = 0; i < m.length; i++) { m[i] = 0; t[i] = 0; }
    for (i = 0; i < hn; i++) {
      if (!h.p[i]) continue;
      for (j = 0; j < an; j++) {
        x = h.p[i] * a.p[j];
        if (!x) continue;
        m[(h.lo + i) - (a.lo + j) - mLo] += x;
        t[i + j] += x;
      }
    }
    return { margin: pmf(mLo, m), total: pmf(tLo, t) };
  }
  /** P(X > line), P(X = line), P(X < line) */
  function tail(a, line) {
    if (!a || num(line) == null) return null;
    var over = 0, push = 0, under = 0;
    for (var i = 0; i < a.p.length; i++) {
      var k = a.lo + i;
      if (Math.abs(k - line) < 1e-9) push += a.p[i]; else if (k > line) over += a.p[i]; else under += a.p[i];
    }
    var s = over + push + under; if (!(s > 0)) return null;
    return { over: over / s, push: push / s, under: under / s };
  }
  function mean(a) { var s = 0, w = 0; for (var i = 0; i < a.p.length; i++) { s += (a.lo + i) * a.p[i]; w += a.p[i]; } return w > 0 ? s / w : null; }
  function sd(a) { var m = mean(a), s = 0, w = 0; for (var i = 0; i < a.p.length; i++) { s += Math.pow(a.lo + i - m, 2) * a.p[i]; w += a.p[i]; } return w > 0 ? Math.sqrt(s / w) : null; }
  /** a quantile, each integer's mass spread evenly over [k-½, k+½] */
  function quantile(a, q) {
    var s = total(a), c = 0;
    for (var i = 0; i < a.p.length; i++) {
      var x = a.p[i] / s;
      if (c + x >= q && x > 0) return a.lo + i - 0.5 + (q - c) / x;
      c += x;
    }
    return a.lo + a.p.length - 0.5;
  }
  /** a compact copy: mass under `floor` trimmed from both ends, values rounded */
  function compact(a, floor, decimals) {
    floor = floor == null ? 1e-6 : floor;
    var f = Math.pow(10, decimals == null ? 6 : decimals);
    var i0 = 0, i1 = a.p.length - 1;
    while (i0 < i1 && a.p[i0] < floor) i0++;
    while (i1 > i0 && a.p[i1] < floor) i1--;
    var p = a.p.slice(i0, i1 + 1).map(function (x) { return Math.round(x * f) / f; });
    return normalize(pmf(a.lo + i0, p));
  }

  /* -------------------------------------------- the team-points grid
     The calibration record ships, per league, the kernel team-points PMF at
     every grid value of projected points (fitted on every completed season
     up to the record's cut). Between grid values the two neighbours are
     blended linearly; outside the grid the edge row is used and flagged. */
  function gridPmf(grid, p) {
    if (!grid || !grid.rows || !grid.rows.length || num(p) == null) return null;
    var x = (p - grid.p0) / grid.step, n = grid.rows.length, clamped = false;
    if (x <= 0) { x = 0; clamped = p < grid.p0; }
    if (x >= n - 1) { x = n - 1; clamped = p > grid.p0 + (n - 1) * grid.step; }
    var i = Math.floor(x), w = x - i;
    var A = grid.rows[i], B = grid.rows[Math.min(n - 1, i + 1)];
    var a = pmf(A.lo, A.p), b = pmf(B.lo, B.p);
    var out = w > 1e-9 ? mix(a, b, w) : normalize(a);
    if (out) out.clamped = clamped;
    return out;
  }

  /* --------------------------------------------------- the centres */
  function centres(raw, model) {
    var m = num(raw && raw.home_margin), t = num(raw && raw.total);
    var c = (model && model.centres) || {};
    var lin = function (x, f) { return x == null || !f ? null : f.a + f.b * x; };
    var mc = lin(m, c.margin), tc = lin(t, c.total);
    return {
      raw: { home_margin: m, total: t, home_points: m != null && t != null ? (t + m) / 2 : null, away_points: m != null && t != null ? (t - m) / 2 : null },
      calibrated: { home_margin: mc, total: tc, home_points: mc != null && tc != null ? (tc + mc) / 2 : null, away_points: mc != null && tc != null ? (tc - mc) / 2 : null }
    };
  }

  /* ---------------------------------------------- the distributions
     raw:    { home_margin, total, sigma?, sigma_base? }   (engine conventions: + = home ahead)
     model:  the `live` block of a calibration record
     Returns PMFs for every market whose method this module computes
     (NORMAL_RAW, NORMAL_CAL, KERNEL_JOINT). A market whose method is ENGINE
     is left null and listed in `engine`: the shipped engine answers it line by
     line through hooks (see sheet()), because the college engine borrows a
     different learned row for each line and cannot be reduced to one PMF.
     Returns { centres, margin, total, home, away, moneyline:{home, tie, away}|null, method, engine:[...], notes } */
  function distributions(raw, model) {
    if (!model || !model.markets) return { error: 'no calibration record for this league' };
    var C = centres(raw, model);
    if (C.raw.home_margin == null || C.raw.total == null) return { error: 'the projection carries no fair margin or no fair total' };
    var M = model.markets, notes = [], engine = [];
    var MW = model.margin_range || [-90, 90], TW = model.total_range || [0, 160], PW = model.points_range || [0, 90];
    var joint = null;
    function needJoint() {
      if (joint) return joint;
      var h = gridPmf(model.team_grid, C.calibrated.home_points), a = gridPmf(model.team_grid, C.calibrated.away_points);
      if (!h || !a) return null;
      if (h.clamped || a.clamped) notes.push('a projected team score lies outside the fitted grid; the edge row of the grid is used');
      var mixw = num(model.team_grid.normal_mix) || 0;
      if (mixw > 0) { h = mix(h, normalPmf(C.calibrated.home_points, model.team_grid.sd, PW[0], PW[1]), mixw); a = mix(a, normalPmf(C.calibrated.away_points, model.team_grid.sd, PW[0], PW[1]), mixw); }
      var j = convolve(h, a);
      joint = { home: h, away: a, margin: j.margin, total: j.total };
      return joint;
    }
    function forMarket(key, kind) {
      var spec = M[key]; if (!spec) return null;
      var method = spec.method;
      if (method === 'ENGINE') { if (engine.indexOf(key) < 0) engine.push(key); return null; }
      if (method === 'KERNEL_JOINT') { var J = needJoint(); return J ? J[kind] : null; }
      var centre = method === 'NORMAL_CAL' ? C.calibrated : C.raw;
      var mu = kind === 'margin' ? centre.home_margin : kind === 'total' ? centre.total : kind === 'home' ? centre.home_points : centre.away_points;
      var rng = kind === 'margin' ? MW : kind === 'total' ? TW : PW;
      return normalPmf(mu, spec.sd, rng[0], rng[1]);
    }
    var out = {
      centres: C,
      margin: forMarket('spread', 'margin'),
      total: forMarket('total', 'total'),
      home: forMarket('team_total', 'home'),
      away: forMarket('team_total', 'away'),
      method: { spread: M.spread && M.spread.method, moneyline: M.moneyline && M.moneyline.method, total: M.total && M.total.method, team_total: M.team_total && M.team_total.method },
      engine: engine, notes: notes
    };
    /* MONEYLINE: P(home ahead) from the moneyline's own method, with a tie
       carried at the league's measured tie rate (NFL ties happen; college
       football has none since overtime). A discretised normal puts ~3% on a
       zero margin, which is not a tie rate, so the tie mass is never read
       off the distribution. An ENGINE moneyline is filled in by sheet(). */
    var mlDist = M.moneyline ? forMarket('moneyline', 'margin') : null;
    var tie = num(model.tie_rate) || 0;
    if (mlDist) { var tt = tail(mlDist, 0); var pn = tt && (tt.over + tt.under) > 0 ? tt.over / (tt.over + tt.under) : null; out.moneyline = pn == null ? null : moneylineFrom(pn, tie); }
    else out.moneyline = null;
    out.tie_rate = tie;
    return out;
  }
  function moneylineFrom(pHomeNoTie, tie) { return { home: (1 - tie) * pHomeNoTie, tie: tie, away: (1 - tie) * (1 - pHomeNoTie) }; }

  /* ------------------------------------------------- fair prices */
  /** the no-vig fair American price for a side that wins with `win` and pushes with `push` */
  function fairAmerican(win, push) {
    var w = num(win), q = num(push) || 0;
    if (w == null || !(w > EPS) || q < 0 || w + q > 1 + 1e-9) return null;
    if (w >= 1 - q - 1e-12) return null; /* a certainty has no price */
    return R().odds.decToAm((1 - q) / w);
  }
  function rung(t, line) {
    if (!t) return null;
    return { line: line, over: r4(t.over), push: r4(t.push), under: r4(t.under), over_fair: fairAmerican(t.over, t.push), under_fair: fairAmerican(t.under, t.push) };
  }
  /** home spread ladder: a home line L covers when margin + L > 0, i.e. margin > -L.
      tailAt(threshold) -> {over, push, under} of the home margin. */
  function spreadLadder(tailAt, centreMargin, width) {
    var rows = [], c = half(-centreMargin);
    for (var L = c - width; L <= c + width + 1e-9; L += 0.5) {
      var t = tailAt(-L); if (!t) continue;
      rows.push({ home_line: L, home: r4(t.over), push: r4(t.push), away: r4(t.under), home_fair: fairAmerican(t.over, t.push), away_fair: fairAmerican(t.under, t.push) });
    }
    return rows;
  }
  function overUnderLadder(tailAt, centre, width) {
    var rows = [], c = half(centre);
    for (var L = c - width; L <= c + width + 1e-9; L += 0.5) { if (L <= 0) continue; var r = rung(tailAt(L), L); if (r) rows.push(r); }
    return rows;
  }

  /** a sheet's ladder, read back with fair prices: from the published rows
      where the sheet carries them (ENGINE markets), otherwise rebuilt from
      the published distribution. key: spread | total | home_team_total | away_team_total */
  var LADDER_DIST = { spread: 'margin', total: 'total', home_team_total: 'home', away_team_total: 'away' };
  function ladder(sh, key, opts) {
    opts = opts || {};
    if (!sh || !LADDER_DIST[key]) return [];
    var rows = sh.ladders && sh.ladders[key];
    if (rows && rows.length) {
      return rows.map(function (r) {
        var o = Object.assign({}, r);
        if (key === 'spread') { if (o.home_fair === undefined) o.home_fair = fairAmerican(o.home, o.push); if (o.away_fair === undefined) o.away_fair = fairAmerican(o.away, o.push); }
        else { if (o.over_fair === undefined) o.over_fair = fairAmerican(o.over, o.push); if (o.under_fair === undefined) o.under_fair = fairAmerican(o.under, o.push); }
        return o;
      });
    }
    var D = sh.dist && sh.dist[LADDER_DIST[key]];
    if (!D) return [];
    var m = sh.markets || {};
    if (key === 'spread') return spreadLadder(function (thr) { return tail(D, thr); }, quantile(D, 0.5), opts.width || 10);
    var centre = key === 'total' ? (m.total && m.total.fair_total) : key === 'home_team_total' ? (m.team_total && m.team_total.home_fair) : (m.team_total && m.team_total.away_fair);
    if (centre == null) centre = quantile(D, 0.5);
    return overUnderLadder(function (L) { return tail(D, L); }, centre, opts.width || (key === 'total' ? 10 : 7));
  }

  /* --------------------------------------------- calibration bands
     model.bands[market] = [{lo, hi, n, mean_p, observed, wilson_lo, wilson_hi}]
     built from held-out predictions only. band() returns the interval for the
     bin a probability falls in, or null with the reason. */
  function band(model, market, p, which) {
    var key = which === 'at_market' ? 'bands_at_market' : 'bands';
    var b = model && model[key] && model[key][market];
    if (!b || num(p) == null) return { available: false, kind: which || 'all_lines', reason: which === 'at_market' ? 'this market has never been tested at numbers the market posted (no closing line is archived for it)' : 'no held-out calibration table for this market' };
    for (var i = 0; i < b.length; i++) {
      var x = b[i];
      if (p >= x.lo && (p < x.hi || (i === b.length - 1 && p <= x.hi))) {
        if (!(x.n >= (model.band_min_n || 100))) return { available: false, kind: which || 'all_lines', reason: 'only ' + (x.n || 0) + ' held-out events in this probability range' + (which === 'at_market' ? ' at market numbers' : ''), n: x.n || 0 };
        return { available: true, kind: which || 'all_lines', lo: x.lo, hi: x.hi, n: x.n, mean_p: x.mean_p, observed: x.observed, wilson_lo: x.wilson_lo, wilson_hi: x.wilson_hi,
          /* how far reality sat from the model, at worst and at best, for probabilities like this one */
          shift_lo: r4(x.wilson_lo - x.mean_p), shift_hi: r4(x.wilson_hi - x.mean_p) };
      }
    }
    return { available: false, kind: which || 'all_lines', reason: 'probability outside the calibration table' };
  }

  /* ---------------------------------------------------- the sheet
     input: { sport, game_id, home, away, kickoff, raw:{home_margin,total,sigma?,sigma_base?}, reference? }
     model: the `live` block of the calibration record (status and tier per market)
     hooks: ENGINE answers, line by line (the Node builder supplies them):
       { cover(raw, threshold) -> {over, push, under} of the home margin,
         over(raw, threshold)  -> {over, push, under} of the game total,
         winProb(raw)          -> P(home ahead), no tie }
     Without hooks an ENGINE market is omitted and says why. */
  function sheet(input, model, hooks, opts) {
    opts = opts || {};
    var d = distributions(input.raw, model);
    if (d.error) return { ok: false, game_id: input.game_id, error: d.error };
    var C = d.centres, raw = input.raw;
    var mk = model.markets;
    var H = hooks || null;
    function meta(key) { var s = mk[key] || {}; return { method: s.method || null, status: s.status || 'UNCALIBRATED', status_reasons: s.status_reasons || [], tier: s.tier || null, tier_basis: s.tier_basis || null }; }
    var out = {
      ok: true, schema: SCHEMA, version: VERSION, sport: input.sport, game_id: input.game_id,
      home: input.home, away: input.away, kickoff: input.kickoff || null,
      centres: { raw: roundObj(C.raw), calibrated: roundObj(C.calibrated) },
      markets: {}, ladders: {}, notes: d.notes.slice(), dist: {}
    };
    var SW = opts.spread_width || 10, TW = opts.total_width || 10, KW = opts.team_width || 7;
    /* SPREAD: the fair home line is minus the margin median */
    if (d.margin) {
      var med = quantile(d.margin, 0.5);
      var fl = -med, at0 = tail(d.margin, -half(fl));
      out.markets.spread = Object.assign(meta('spread'), {
        fair_home_line: r1(fl), fair_home_line_half: half(fl),
        at_fair: at0 ? { home: r4(at0.over), push: r4(at0.push), away: r4(at0.under) } : null,
        margin_p10: r1(quantile(d.margin, 0.1)), margin_p90: r1(quantile(d.margin, 0.9)), margin_sd: r1(sd(d.margin))
      });
      out.ladders.spread = spreadLadder(function (thr) { return tail(d.margin, thr); }, med, SW);
      out.dist.margin = compact(d.margin);
    } else if (d.engine.indexOf('spread') >= 0) {
      if (H && typeof H.cover === 'function') {
        var em = C.raw.home_margin, ea = H.cover(raw, -half(-em));
        out.markets.spread = Object.assign(meta('spread'), { fair_home_line: r1(-em), fair_home_line_half: half(-em),
          at_fair: ea ? { home: r4(ea.over), push: r4(ea.push), away: r4(ea.under) } : null, margin_p10: null, margin_p90: null, margin_sd: null });
        out.ladders.spread = spreadLadder(function (thr) { return H.cover(raw, thr); }, em, SW);
      } else out.notes.push('the spread is priced by the shipped engine and no engine was supplied');
    }
    /* MONEYLINE */
    var ml = d.moneyline;
    if (!ml && d.engine.indexOf('moneyline') >= 0 && H && typeof H.winProb === 'function') { var wp = num(H.winProb(raw)); if (wp != null) ml = moneylineFrom(wp, d.tie_rate); }
    if (ml) {
      out.markets.moneyline = Object.assign(meta('moneyline'), {
        home_win: r4(ml.home), away_win: r4(ml.away), tie: r4(ml.tie),
        home_fair: fairAmerican(ml.home, ml.tie), away_fair: fairAmerican(ml.away, ml.tie)
      });
    }
    /* TOTAL */
    if (d.total) {
      var tm = quantile(d.total, 0.5);
      out.markets.total = Object.assign(meta('total'), { fair_total: r1(tm), fair_total_half: half(tm), total_p10: r1(quantile(d.total, 0.1)), total_p90: r1(quantile(d.total, 0.9)), total_sd: r1(sd(d.total)) });
      out.ladders.total = overUnderLadder(function (L) { return tail(d.total, L); }, tm, TW);
      out.dist.total = compact(d.total);
    } else if (d.engine.indexOf('total') >= 0) {
      if (H && typeof H.over === 'function') {
        var et = C.raw.total;
        out.markets.total = Object.assign(meta('total'), { fair_total: r1(et), fair_total_half: half(et), total_p10: null, total_p90: null, total_sd: null });
        out.ladders.total = overUnderLadder(function (L) { return H.over(raw, L); }, et, TW);
      } else out.notes.push('the total is priced by the shipped engine and no engine was supplied');
    }
    /* TEAM TOTALS */
    if (d.home && d.away) {
      var hm = quantile(d.home, 0.5), am = quantile(d.away, 0.5);
      out.markets.team_total = Object.assign(meta('team_total'), {
        home_fair: r1(hm), away_fair: r1(am), home_fair_half: half(hm), away_fair_half: half(am),
        home_p10: r1(quantile(d.home, 0.1)), home_p90: r1(quantile(d.home, 0.9)),
        away_p10: r1(quantile(d.away, 0.1)), away_p90: r1(quantile(d.away, 0.9))
      });
      out.ladders.home_team_total = overUnderLadder(function (L) { return tail(d.home, L); }, hm, KW);
      out.ladders.away_team_total = overUnderLadder(function (L) { return tail(d.away, L); }, am, KW);
      out.dist.home = compact(d.home); out.dist.away = compact(d.away);
    }
    out.method = d.method;
    if (input.reference) out.reference = input.reference;
    return out;
  }
  function roundObj(o) { var x = {}; Object.keys(o).forEach(function (k) { x[k] = o[k] == null ? null : Math.round(o[k] * 100) / 100; }); return x; }

  /* -------------------------------------------------- price check
     q: { market: 'spread'|'total'|'team_total'|'moneyline', side, line, american, team?: 'home'|'away' }
       spread    side 'home'|'away', line = that side's line (home -3.5 / away +3.5)
       total     side 'over'|'under', line = the total
       team_total side 'over'|'under', team 'home'|'away', line
       moneyline side 'home'|'away' (line ignored)
     Reads the stored distributions of a published sheet, or of distributions(). */
  function probabilities(sh, q) {
    if (!sh) return { error: 'no sheet' };
    var D = sh.dist || {}, Lg = sh.ladders || {};
    var line = num(q.line);
    if (q.market === 'moneyline') {
      var ml = sh.markets && sh.markets.moneyline;
      if (!ml) return { error: 'no moneyline on this sheet' };
      if (q.side === 'home') return { win: ml.home_win, push: ml.tie, lose: ml.away_win };
      if (q.side === 'away') return { win: ml.away_win, push: ml.tie, lose: ml.home_win };
      return { error: 'moneyline side must be home or away' };
    }
    if (line == null) return { error: 'a line is required for this market' };
    if (Math.abs(line * 2 - Math.round(line * 2)) > 1e-9) return { error: 'lines are priced in half points' };
    var t;
    if (q.market === 'spread') {
      if (q.side !== 'home' && q.side !== 'away') return { error: 'spread side must be home or away' };
      var homeLine = q.side === 'home' ? line : -line;
      if (D.margin) t = tail(D.margin, -homeLine);
      else t = fromLadder(Lg.spread, 'home_line', homeLine, 'home', 'away');
      if (!t) return { error: 'that line is outside the published ladder' };
      return q.side === 'home' ? { win: t.over, push: t.push, lose: t.under } : { win: t.under, push: t.push, lose: t.over };
    }
    if (q.market !== 'total' && q.market !== 'team_total') return { error: 'unknown market ' + q.market };
    if (q.market === 'team_total' && q.team !== 'home' && q.team !== 'away') return { error: 'team total needs team home or away' };
    if (!(line > 0)) return { error: 'a total line must be positive' };
    if (q.side !== 'over' && q.side !== 'under') return { error: 'side must be over or under' };
    var dist = q.market === 'total' ? D.total : (q.team === 'home' ? D.home : D.away);
    var lad = q.market === 'total' ? Lg.total : (q.team === 'home' ? Lg.home_team_total : Lg.away_team_total);
    t = dist ? tail(dist, line) : fromLadder(lad, 'line', line, 'over', 'under');
    if (!t) return { error: 'that line is outside the published ladder' };
    return q.side === 'over' ? { win: t.over, push: t.push, lose: t.under } : { win: t.under, push: t.push, lose: t.over };
  }
  /** a published ladder row read back as {over, push, under} (ENGINE markets ship no PMF) */
  function fromLadder(rows, key, value, a, b) {
    if (!rows) return null;
    for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i][key] - value) < 1e-9) return { over: rows[i][a], push: rows[i].push, under: rows[i][b] };
    return null;
  }

  var VALUE_MIN_ROI = 0.02; /* VALUE needs at least +2% expected return per unit at the quoted price */

  function priceCheck(sh, q, model) {
    var out = { market: q.market, side: q.side, line: num(q.line), american: num(q.american), team: q.team || null,
      verdict: 'CANNOT_EVALUATE', why: [], status: null, tier: null };
    var mkKey = q.market;
    var M = sh && sh.markets && sh.markets[mkKey];
    if (!M) { out.why.push('this sheet has no ' + mkKey + ' market'); return out; }
    out.status = M.status; out.tier = M.tier;
    var p = probabilities(sh, q);
    if (!p || p.error) { out.why.push(p ? p.error : 'the line is outside the distribution'); return out; }
    var pa = R().priceAssessment(q.american, p.win, p.push);
    if (pa.reason) { out.why.push(pa.reason); out.probs = { win: r4(p.win), push: r4(p.push), lose: r4(p.lose) }; return out; }
    out.probs = { win: r4(p.win), push: r4(p.push), lose: r4(p.lose) };
    out.cover_prob = r4(pa.cover_prob);
    out.break_even = r4(pa.break_even);
    out.prob_edge = r4(pa.prob_edge);
    out.expected_roi = r4(pa.expected_roi);
    out.fair_american = fairAmerican(p.win, p.push);
    /* Two held-out tables (football/validation/linemaker_<league>.json):
       - all_lines: how often probabilities like this one came true across
         every line scored. It describes the sheet.
       - at_market: how often they came true at the number the market
         actually closed at. A price check IS a market number, so this is the
         table the verdict reads. On the held-out seasons the model's
         probabilities at market numbers had almost no resolution: when it
         said two in three, it was about one in two. */
    var mdl = model || sh.model || null;
    out.band_all_lines = band(mdl, mkKey, pa.cover_prob);
    var bd = band(mdl, mkKey, pa.cover_prob, 'at_market');
    out.band = bd;
    if (bd.available) {
      var lo = Math.max(0, Math.min(1, pa.cover_prob + bd.shift_lo));
      out.market_tested_cover = r4(bd.observed);
      out.conservative_cover = r4(lo);
      out.conservative_edge = r4(lo - pa.break_even);
      /* expected return at the conservative probability, with the same push */
      out.conservative_roi = r4(R().expectedRoi(lo * (1 - (p.push || 0)), q.american, p.push || 0));
    }
    if (!(pa.expected_roi > 0)) { out.verdict = 'NO_VALUE'; out.why.push('at ' + fmtAm(q.american) + ' the price needs ' + pct(pa.break_even) + ' and EdgeDesk gives ' + pct(pa.cover_prob)); return out; }
    if (M.status !== 'CALIBRATED') { out.verdict = 'THIN'; out.why.push('positive at this price, but the ' + mkKey.replace('_', ' ') + ' probabilities are ' + String(M.status).toLowerCase() + ' on held-out seasons'); }
    else if (!bd.available) { out.verdict = 'THIN'; out.why.push('positive at this price, but ' + bd.reason); }
    else if (!(out.conservative_edge > 0)) { out.verdict = 'THIN'; out.why.push('positive at this price, but at numbers the market posted, held-out probabilities like ' + pct(pa.cover_prob) + ' came true ' + pct(bd.observed) + ' of the time (n ' + bd.n + '), and the low end of that, ' + pct(out.conservative_cover) + ', does not clear the ' + pct(pa.break_even) + ' the price needs'); }
    else if (!(pa.expected_roi >= VALUE_MIN_ROI)) { out.verdict = 'THIN'; out.why.push('positive but under the ' + Math.round(VALUE_MIN_ROI * 100) + '% expected-return floor'); }
    else { out.verdict = 'VALUE'; out.why.push('clears break-even at this price even at the low end of what probabilities like this one did at market numbers, held out'); }
    if (out.verdict !== 'NO_VALUE' && M.tier !== 'VALIDATED') out.why.push('the model has not shown it beats the closing line in this market (tier ' + (M.tier || 'RESEARCH') + '): this is arithmetic on a probability, not a betting record');
    return out;
  }
  function fmtAm(v) { var n = num(v); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function pct(v) { return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }

  /** the no-vig market probability when both sides of the same line are quoted */
  function noVig(americanA, americanB) {
    var nv = R().noVigTwoWay(americanA, americanB);
    return nv ? { a: r4(nv.a), b: r4(nv.b), overround: r4(nv.overround) } : null;
  }

  /* ----------------------------------------------------- ranking
     quotes: [{ game_id, market, side, line, american, team?, book?, observed_at? }]
     sheets: { game_id: sheet }
     Every quote is priced; only VALUE survives; the list may be empty.
     Ordered by the conservative expected return, then the plain one. A quote
     older than maxAgeMin (when it carries observed_at) is STALE and never ranks. */
  function rankQuotes(sheets, quotes, models, opts) {
    opts = opts || {};
    var now = num(opts.now) || Date.now(), maxAge = num(opts.maxAgeMin) || 90;
    var evaluated = (quotes || []).map(function (q) {
      var sh = sheets && sheets[q.game_id];
      var model = models && sh ? models[sh.sport] : null;
      var r = sh ? priceCheck(sh, q, model) : { verdict: 'CANNOT_EVALUATE', why: ['no sheet for game ' + q.game_id] };
      r.game_id = q.game_id; r.book = q.book || null; r.observed_at = q.observed_at || null;
      if (q.observed_at) {
        var age = (now - Date.parse(q.observed_at)) / 60000;
        r.age_min = Number.isFinite(age) ? Math.round(age) : null;
        if (!(age <= maxAge)) { r.stale = true; if (r.verdict === 'VALUE') { r.verdict = 'THIN'; r.why.push('the quote is ' + (Number.isFinite(age) ? Math.round(age) + ' minutes old' : 'of unknown age') + '; a stale price is never an opportunity'); } }
      }
      return r;
    });
    var ranked = evaluated.filter(function (r) { return r.verdict === 'VALUE'; }).sort(function (a, b) {
      return (b.conservative_roi - a.conservative_roi) || (b.expected_roi - a.expected_roi);
    });
    return { ranked: ranked, evaluated: evaluated, qualified: ranked.length };
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, MARKETS: MARKETS, METHODS: METHODS, STATUSES: STATUSES, VERDICTS: VERDICTS, VALUE_MIN_ROI: VALUE_MIN_ROI,
    pmf: { normal: normalPmf, mix: mix, convolve: convolve, tail: tail, mean: mean, sd: sd, quantile: quantile, compact: compact, at: at, normalize: normalize },
    gridPmf: gridPmf, centres: centres, distributions: distributions, sheet: sheet, ladder: ladder,
    fairAmerican: fairAmerican, band: band, probabilities: probabilities, priceCheck: priceCheck, noVig: noVig, rankQuotes: rankQuotes,
    _normCdf: normCdf
  };
});
/*__EDFAIRLINE_END__*/
