/* ===========================================================================
   EdgeDesk CALC — the one calculation layer for every number a reader sees
   beside another number. docs/system-integrity/DATA_CONTRACT.md §4

   WHY IT EXISTS (docs/system-integrity/AUDIT.md §1)
     The same game used to show three different arithmetics:
       - the board printed a near pick'em at the engine's one-point DISPLAY
         FLOOR ("Ole Miss -1.0") beside a gap measured from the RAW margin
         (-0.18), so "-1.0 vs -9.5 = 9.3" could not be reproduced by a reader;
       - the terminal rounded the fair line, the consensus and the full-
         precision gap independently, so 11 of 70 priced rows showed a gap
         that differed from their displayed inputs by 0.1;
       - projected scores were rounded on their own, so 65 of 114 score lines
         did not add up to the fair margin they sat beside.

   THE POLICY (POLICY below, id display_rounding_v1)
     1. Every value is rounded to its display precision ONCE, half away from
        zero, by round() here.
     2. Every displayed difference (a model-market gap, a total gap, a
        probability edge) is the difference OF THE DISPLAYED INPUTS, computed
        in integer tenths so no float residue can leak into the last digit.
        A reader can always reproduce it from the two numbers beside it.
     3. The full-precision value is kept beside the display (gap_exact) for
        ranking-free analytics. It never replaces the model's number and it is
        never printed as the gap.
     4. The model's number is never moved toward or away from the market to
        make a comparison look cleaner. A near pick'em is shown at its real
        value ("Ole Miss -0.2") with a NEAR PICK'EM tag — the engine's one-point
        floor (football/cfb_p4/engine.js fairLine.normalize) is a presentation
        convention, kept in the engine's output, and never used as a
        comparison input.
     5. Projected scores always sum exactly to the displayed total and differ
        by exactly the displayed margin. When both cannot be exact at one
        decimal (the total's and the margin's last digits have different
        parity), the scores are shown to two decimals rather than rounded
        into a contradiction.

   CONVENTIONS
     home margin   home points minus away points (+ = home favoured). The CFB
                   engine's fair_spread and the board's market spread_line both
                   use it.
     book line     what a sportsbook prints for a side: -margin for that side
                   (negative = favoured).

   WHAT THIS FILE NEVER DOES
     - compute a projection, a probability distribution or a calibration;
     - fill a missing value: a null input gives a null output with a reason;
     - decide a research status or a bet (lib/edgedesk_canon.js and
       lib/edgedesk_decision.js do; they read the gap from here).

   Browser: window.EDCalc. Node: require('./edgedesk_calc.js'). ES5, no
   dependencies, the same code in both.
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCalc = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var C = { VERSION: 'edgedesk_calc/1' };

  C.POLICY = {
    id: 'display_rounding_v1',
    mode: 'half_away_from_zero',
    spread_dp: 1, total_dp: 1, score_dp: 1, gap_dp: 1, prob_dp: 1, ev_dp: 1, pp_dp: 1, odds_dp: 0,
    rule: 'Each input is rounded to its display precision once; every displayed difference is the difference of the displayed inputs; the full-precision value is kept beside it and never replaces the model’s number.'
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  C.num = num;

  /* half away from zero at dp decimals. The 1e-9 guard absorbs the binary
     residue of a decimal that is meant to sit exactly on a half (9.45 is
     9.4499999… in binary and must display 9.5). */
  function round(x, dp) {
    x = num(x);
    if (x === null) return null;
    var m = Math.pow(10, dp == null ? 1 : dp);
    var a = Math.floor(Math.abs(x) * m + 0.5 + 1e-9);
    var v = (x < 0 ? -a : a) / m;
    return v === 0 ? 0 : v;
  }
  C.round = round;
  /* integer tenths: the unit every displayed difference is computed in */
  function tenths(x) { return Math.round(round(x, 1) * 10); }
  function fromTenths(t) { var v = t / 10; return v === 0 ? 0 : v; }

  function fixed(x, dp) { return isNum(x) ? x.toFixed(dp == null ? 1 : dp) : '—'; }
  function pts(x) { var a = Math.abs(x); return fixed(a, 1) + (a === 1 ? ' pt' : ' pts'); }

  /* ================================================================ SPREADS
     One side of a spread comparison: the full-precision home margin, its
     display value, the side it names and the line text a reader sees. */
  C.NEAR_PICKEM = 1;
  C.spread = function (homeMargin, names, opts) {
    names = names || {};
    opts = opts || {};
    var home = names.home || 'Home', away = names.away || 'Away';
    var m = num(homeMargin);
    if (m === null) return { available: false, exact: null, display: null, favorite: null, favorite_team: null, text: '—', reason: opts.missing || 'no number on file' };
    var d = round(m, C.POLICY.spread_dp);
    var fav = d > 0 ? 'home' : (d < 0 ? 'away' : null);
    var team = fav === 'home' ? home : (fav === 'away' ? away : null);
    /* an exact display zero: the side the raw number still leans to, said
       in words, never as a manufactured line */
    var lean = m > 0 ? home : (m < 0 ? away : null);
    var text = team ? team + ' -' + fixed(Math.abs(d), 1) : 'Pick’em';
    return {
      available: true,
      exact: m,
      display: d,
      book_line_home: d === 0 ? 0 : -d,
      favorite: fav,
      favorite_team: team,
      lean_team: d === 0 ? lean : team,
      near_pickem: Math.abs(m) < C.NEAR_PICKEM,
      text: text,
      note: d === 0 && lean ? 'rounds to a pick’em; the raw number leans ' + lean + ' by ' + fixed(Math.abs(m), 2) : null
    };
  };
  /* a sportsbook line for a named team ("Ole Miss -9.5") as a home margin */
  C.marginFromLine = function (team, line, names) {
    var l = num(line);
    if (l === null || !names) return null;
    var t = String(team || '').toLowerCase(), h = String(names.home || '').toLowerCase(), a = String(names.away || '').toLowerCase();
    if (t && t === h) return l === 0 ? 0 : -l;
    if (t && t === a) return l;
    return null;
  };

  /* THE SPREAD COMPARISON. model and market as home margins (full precision
     or already displayed; the result is the same either way, because the
     comparison is made on the displayed values). */
  C.spreadComparison = function (x) {
    x = x || {};
    var names = { home: x.home || 'Home', away: x.away || 'Away' };
    var model = C.spread(x.model_home_margin, names, { missing: 'no EdgeDesk projection' });
    var market = C.spread(x.market_home_margin, names, { missing: 'no market line' });
    var out = {
      calc_version: C.VERSION, policy: C.POLICY.id, market_type: 'spread',
      model: model, market: market,
      model_snapshot_id: x.model_snapshot_id || null, market_snapshot_id: x.market_snapshot_id || null,
      available: model.available && market.available
    };
    if (!out.available) {
      out.reason = !model.available ? model.reason : market.reason;
      out.gap = null; out.gap_exact = null; out.signed = null; out.toward = null; out.toward_team = null;
      out.text = '—';
      return out;
    }
    var st = tenths(model.display) - tenths(market.display);
    var signed = fromTenths(st);
    out.signed = signed;                         /* + = EdgeDesk likes HOME more than the market */
    out.gap = Math.abs(signed);
    out.gap_exact = Math.abs(model.exact - market.exact);
    out.toward = st > 0 ? 'home' : (st < 0 ? 'away' : null);
    out.toward_team = out.toward === 'home' ? names.home : (out.toward === 'away' ? names.away : null);
    out.favorite_differs = !!(model.favorite && market.favorite && model.favorite !== market.favorite);
    out.text = st === 0 ? '0.0 pts — EdgeDesk matches the market' : pts(out.gap) + ' toward ' + out.toward_team;
    out.reconcile = {
      formula: '|' + fixed(model.display, 1) + ' − ' + fixed(market.display, 1) + '| = ' + fixed(out.gap, 1),
      inputs: [model.text, market.text],
      convention: 'home margin (home points minus away points)'
    };
    return out;
  };

  /* Comparison of two DISPLAYED book lines, each named for a team — the case
     where the figures on screen are the authoritative comparison inputs
     ("Ole Miss -1.0" vs "Ole Miss -9.5" is 8.5 points). */
  C.compareLines = function (modelLine, marketLine, names) {
    var mm = C.marginFromLine(modelLine && modelLine.team, modelLine && modelLine.line, names);
    var km = C.marginFromLine(marketLine && marketLine.team, marketLine && marketLine.line, names);
    return C.spreadComparison({ home: names && names.home, away: names && names.away, model_home_margin: mm, market_home_margin: km });
  };

  /* ================================================================= TOTALS */
  C.totalComparison = function (x) {
    x = x || {};
    var m = num(x.model_total), k = num(x.market_total);
    var out = { calc_version: C.VERSION, policy: C.POLICY.id, market_type: 'total',
      model_exact: m, market_exact: k, model: round(m, C.POLICY.total_dp), market: round(k, C.POLICY.total_dp),
      model_snapshot_id: x.model_snapshot_id || null, market_snapshot_id: x.market_snapshot_id || null };
    out.available = m !== null && k !== null;
    if (!out.available) { out.gap = null; out.direction = null; out.text = '—'; out.reason = m === null ? 'no EdgeDesk total' : 'no market total'; return out; }
    var st = tenths(m) - tenths(k);
    out.signed = fromTenths(st);
    out.gap = Math.abs(out.signed);
    out.gap_exact = Math.abs(m - k);
    out.direction = st > 0 ? 'over' : (st < 0 ? 'under' : null);
    out.text = st === 0 ? 'EdgeDesk matches the market total' : 'EdgeDesk is ' + pts(out.gap) + ' ' + (st > 0 ? 'above' : 'below') + ' the market total';
    out.reconcile = { formula: '|' + fixed(out.model, 1) + ' − ' + fixed(out.market, 1) + '| = ' + fixed(out.gap, 1) };
    return out;
  };

  /* ======================================================= PROJECTED SCORES
     The score line, the fair margin and the fair total always agree. */
  C.projectedScores = function (x) {
    x = x || {};
    var names = { home: x.home || 'Home', away: x.away || 'Away' };
    var m = num(x.home_margin), t = num(x.total);
    if (m === null || t === null) return { available: false, text: '—', reason: m === null ? 'no projected margin' : 'no projected total' };
    var T = tenths(t), M = tenths(m);
    var aM = Math.abs(M);
    var dp = ((T + aM) % 2 === 0) ? 1 : 2;
    /* in twentieths when needed: (T ± |M|) / 2 tenths is exact in hundredths */
    var favH = (T + aM) / 2, dogH = (T - aM) / 2;     /* tenths, possibly .5 */
    var fav = favH / 10, dog = dogH / 10;
    var favSide = M > 0 ? 'home' : (M < 0 ? 'away' : null);
    var homeS = favSide === 'away' ? dog : fav, awayS = favSide === 'away' ? fav : dog;
    function s(v) { return v.toFixed(dp); }
    var first = favSide === 'home' ? 'home' : 'away';
    var second = first === 'home' ? 'away' : 'home';
    var sc = { home: homeS, away: awayS };
    return {
      available: true, calc_version: C.VERSION, policy: C.POLICY.id,
      home: homeS, away: awayS, decimals: dp,
      margin_display: fromTenths(M), total_display: fromTenths(T),
      text: names[first] + ' ' + s(sc[first]) + ' — ' + names[second] + ' ' + s(sc[second]),
      reconcile: { sum: s(fromTenths(T)), difference: s(aM / 10) },
      note: dp === 2 ? 'shown to two decimals so the scores add to the total and differ by the margin exactly' : null
    };
  };
  /* does a score line agree with the margin and total printed beside it?
     tolerance: the display unit of the scores themselves */
  C.scoresReconcile = function (homeScore, awayScore, homeMargin, total, decimals) {
    var h = num(homeScore), a = num(awayScore), m = num(homeMargin), t = num(total);
    if (h === null || a === null || m === null || t === null) return { ok: null, reason: 'missing input' };
    var unit = Math.pow(10, -(decimals == null ? 1 : decimals)) / 2 + 1e-9;
    var dM = Math.abs((h - a) - round(m, 1)), dT = Math.abs((h + a) - round(t, 1));
    var sideOk = round(m, 1) === 0 || ((h - a) > 0) === (m > 0);
    var ok = dM <= unit && dT <= unit && sideOk;
    return { ok: ok, margin_difference: round(dM, 3), total_difference: round(dT, 3), side_agrees: sideOk,
      reason: ok ? null : (!sideOk ? 'the score line names a different winner from the fair line'
        : 'the score line differs from the ' + (dM > unit ? 'margin by ' + round(dM, 2) : 'total by ' + round(dT, 2)) + ' points') };
  };

  /* ========================================================= PROBABILITIES
     The same formulas EDQuoteEV and research_core use; tools/integrity
     pins the parity, so a second copy cannot drift silently. */
  C.decimalFromAmerican = function (a) { a = num(a); if (a === null || (a > -100 && a < 100)) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a); };
  C.impliedFromAmerican = function (a) { var d = C.decimalFromAmerican(a); return d ? 1 / d : null; };
  C.breakEven = function (decimal) { decimal = num(decimal); return decimal !== null && decimal > 1 ? 1 / decimal : null; };
  /* multiplicative no-vig for a two-way market; null when the pair cannot be a market */
  C.noVigTwoWay = function (aAm, bAm) {
    var pa = C.impliedFromAmerican(aAm), pb = C.impliedFromAmerican(bAm);
    if (pa === null || pb === null) return null;
    var s = pa + pb;
    if (!(s > 0)) return null;
    return { a: pa / s, b: pb / s, overround: s - 1 };
  };
  /* EV per unit staked: P(win)(d−1) − P(loss); a push returns the stake */
  C.expectedValue = function (win, push, loss, decimal) {
    win = num(win); push = num(push) === null ? 0 : num(push); decimal = num(decimal);
    if (win === null || decimal === null || decimal <= 1) return null;
    loss = num(loss) === null ? 1 - win - push : num(loss);
    if (Math.abs(win + push + loss - 1) > 1e-6 || win < 0 || loss < 0 || push < 0) return null;
    return win * (decimal - 1) - loss;
  };

  /* A SELECTION is one exact bet: market, side, line, price, book, capture.
     Raw and calibrated EV are only comparable for the same selection. */
  function isoOrEmpty(t) { var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? new Date(v).toISOString() : ''; }
  C.selectionKey = function (s) {
    if (!s) return null;
    var line = num(s.line);
    return [String(s.market_type || 'spread').toLowerCase(), String(s.side || s.team || '').toLowerCase(),
      line === null ? '' : String(round(line, 1)), num(s.american) === null ? '' : String(Math.round(num(s.american))),
      String(s.book || '').toLowerCase(), isoOrEmpty(s.captured_at)].join('|');
  };
  C.evPair = function (raw, cal) {
    var kr = raw ? C.selectionKey(raw.selection) : null, kc = cal ? C.selectionKey(cal.selection) : null;
    var out = { calc_version: C.VERSION, raw_key: kr, calibrated_key: kc };
    if (!raw || num(raw.ev) === null) { out.comparable = false; out.reason = 'no raw EV'; return out; }
    if (!cal || num(cal.ev) === null) { out.comparable = false; out.reason = 'no calibrated EV'; out.raw_ev = raw.ev; return out; }
    if (kr !== kc) {
      out.comparable = false;
      out.reason = 'raw EV and calibrated EV were computed for different selections (' + (kr || '?') + ' vs ' + (kc || '?') + '); they cannot be shown as one bet';
      return out;
    }
    out.comparable = true;
    out.raw_ev = raw.ev; out.calibrated_ev = cal.ev;
    out.shrink = raw.ev - cal.ev;
    return out;
  };

  /* ============================================================ FORMATTING
     The canonical formatters every surface and every export uses. */
  C.fmt = {
    spread: function (team, line) { var l = round(line, 1); if (l === null) return '—'; if (l === 0) return 'Pick’em'; return team + ' ' + (l > 0 ? '+' : '-') + fixed(Math.abs(l), 1); },
    total: function (t) { var v = round(t, 1); return v === null ? '—' : fixed(v, 1); },
    gap: function (g) { var v = round(g, 1); return v === null ? '—' : pts(v); },
    prob: function (p, dp) { p = num(p); return p === null ? '—' : fixed(round(100 * p, dp == null ? 1 : dp), dp == null ? 1 : dp) + '%'; },
    ev: function (e, dp) { e = num(e); if (e === null) return '—'; var v = round(100 * e, dp == null ? 1 : dp); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fixed(Math.abs(v), dp == null ? 1 : dp) + '%'; },
    pp: function (x) { x = num(x); if (x === null) return '—'; var v = round(x, 1); return (v > 0 ? '+' : (v < 0 ? '−' : '')) + fixed(Math.abs(v), 1) + ' pp'; },
    american: function (a) { a = num(a); return a === null ? '—' : (a > 0 ? '+' : '') + String(Math.round(a)); },
    rank: function (n) { n = num(n); return n === null ? '—' : '#' + Math.round(n); },
    score100: function (s, what) { s = num(s); return s === null ? 'unavailable' : Math.round(s) + '/100' + (what ? ' (' + what + ')' : ''); },
    age: function (minutes) {
      minutes = num(minutes);
      if (minutes === null) return 'age unknown';
      if (minutes < 1) return 'under a minute old';
      if (minutes < 90) return Math.round(minutes) + ' min old';
      if (minutes < 48 * 60) return round(minutes / 60, 1) + ' h old';
      return Math.round(minutes / 1440) + ' days old';
    }
  };

  /* a fingerprint of the numbers a document may print, so an export can be
     checked against the snapshot it was approved on (FNV-1a over canonical JSON) */
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; }).map(function (k) { return JSON.stringify(k) + ':' + canonicalJson(v[k]); }).join(',') + '}';
  }
  C.canonicalJson = canonicalJson;
  C.fingerprint = function (v) {
    var s = canonicalJson(v), h1 = 0x811c9dc5, h2 = 0x01000193, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 ^= c; h2 = Math.imul(h2 ^ (h1 >>> 7), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  };

  return C;
});
