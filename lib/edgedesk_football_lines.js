/* ===========================================================================
   EdgeDesk FOOTBALL LINES — how an NFL or college football projection is
   SHOWN: fair spreads and totals at the nearest half point, projected scores
   at whole points, and the model-versus-market gap from the unrounded
   numbers. docs/system-integrity/FOOTBALL_LINES.md

   TWO KINDS OF NUMBER, NEVER MIXED
     raw       the model's own projected margin, total, expected team points
               and probabilities. Every gap, EV, grade, calibration figure,
               record and decision reads these, exactly as the engine
               produced them. This file never changes one.
     display   what a reader sees: "Texas Tech −20.5", "52.5", "PK",
               "Projected score: Texas Tech 37, Arizona State 16". Derived
               from the raw numbers here, under one named policy, and used for
               nothing but printing.

   THE POLICY (POLICY below, id football_half_point_v1)
     1. A fair spread or total is shown at the nearest 0.5. Halves go away
        from zero, so a margin and its negation always print as the same
        line for opposite teams (20.25 → 20.5 and −20.25 → −20.5; 20.75 →
        21.0). The raw number is first read at hundredths, the precision
        every football artifact publishes, so a surface holding the engine's
        full-precision value and one holding the published value print the
        same line.
     2. A displayed spread of zero is "PK".
     3. Nothing is pulled toward 3, 7, 10 or 14. A projection of 6.6 shows
        6.5, never 7.
     4. Projected scores are whole points, each rounded on its own from the
        raw expected points. The fair spread and total come from their own
        raw outputs, never from the rounded scores, so the two may differ by
        a point; the details view says so.
     5. A model-versus-market gap is the raw model number against the
        sportsbook line, shown to 0.1 and computed in integer tenths exactly
        as lib/edgedesk_calc.js spreadComparison() computes it, so a printed
        gap is always the gap the research and decision layers classify. It
        is never the difference of the half-point display, so rounding can
        neither create nor inflate an edge. Where the printed lines and the
        printed gap look inconsistent, ROUNDING_NOTE says why.
     6. A sportsbook line or price is printed as received ("−6.75" stays
        −6.75); only the model's own number is rounded.

   KEY NUMBERS
     3 and 7 are the primary key margins; more can be configured per league
     (KEY_MARGINS.additional). keyContext() only DESCRIBES where the model's
     line and the market's line sit around them, crossing one or landing on
     one. It adjusts no probability: how often games land on a given margin
     differs between the NFL and college football, and nothing here claims a
     frequency for either.

   Browser: window.EDFootballLines. Node: require('./edgedesk_football_lines.js').
   ES5, no dependencies, the same code in both.
   =========================================================================== */
/*__EDFOOTBALLLINES_START__*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDFootballLines = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var F = { VERSION: 'edgedesk_football_lines/1' };

  F.POLICY = {
    id: 'football_half_point_v1',
    line_step: 0.5,
    input_dp: 2,
    mode: 'half_away_from_zero',
    score_dp: 0,
    gap_dp: 1,
    rule: 'Fair spreads and totals display at the nearest half point and projected scores at whole points; every gap, EV, grade and comparison uses the unrounded model numbers and the sportsbook line exactly as received.'
  };
  F.MINUS = '−';
  F.PK = 'PK';
  F.ROUNDING_NOTE = 'Fair lines rounded to nearest half-point; differences use unrounded projections.';
  F.SCORE_NOTE = 'Projected scores are rounded to whole points on their own; the fair spread and total are rounded from the unrounded projection, so they can differ by a point.';
  F.KEY_NOTE = 'Key margins are where football games often finish. How often differs between the NFL and college football; this note marks where the two lines sit and does not change any probability.';

  /* the key margins: 3 and 7 for both leagues; anything further per league */
  F.KEY_MARGINS = {
    primary: [3, 7],
    additional: { nfl: [], cfb: [] }
  };
  F.KEY_NAMES = { 3: 'a field goal', 7: 'a touchdown' };

  function num(x) { if (x === null || x === undefined || x === '') return null; var n = Number(x); return isFinite(n) ? n : null; }
  F.num = num;
  /* half away from zero at dp decimals, with the binary-residue guard
     lib/edgedesk_calc.js round() uses (9.45 is 9.4499… in binary) */
  function round(x, dp) {
    x = num(x);
    if (x === null) return null;
    var m = Math.pow(10, dp == null ? 1 : dp);
    var a = Math.floor(Math.abs(x) * m + 0.5 + 1e-9);
    var v = (x < 0 ? -a : a) / m;
    return v === 0 ? 0 : v;
  }
  F.round = round;

  /* ================================================================ ROUNDING */
  /* the nearest half point, halves away from zero, symmetric in sign */
  F.halfPoint = function (x) {
    x = num(x);
    if (x === null) return null;
    var h = Math.abs(round(x, F.POLICY.input_dp));
    var a = Math.floor(h * 2 + 0.5 + 1e-9) / 2;
    var v = x < 0 ? -a : a;
    return v === 0 ? 0 : v;
  };
  /* whole points, halves away from zero */
  F.wholePoint = function (x) { x = num(x); return x === null ? null : round(round(x, F.POLICY.input_dp), 0); };

  /* ============================================================== FORMATTING */
  function fixed1(v) { return Math.abs(v).toFixed(1); }
  /* a book line for one team: −20.5, +3.5, PK */
  F.lineText = function (line) {
    line = num(line);
    if (line === null) return '—';
    if (line === 0) return F.PK;
    return (line < 0 ? F.MINUS : '+') + fixed1(line);
  };
  /* a sportsbook number as received: never rounded, at least one decimal
     (−7 → −7.0, −6.5 → −6.5, −6.75 → −6.75) */
  function exactAbs(v) {
    var s = String(Math.round(Math.abs(v) * 1000) / 1000);
    return s.indexOf('.') < 0 ? s + '.0' : s;
  }
  F.exactLineText = function (line) {
    line = num(line);
    if (line === null) return '—';
    if (line === 0) return F.PK;
    return (line < 0 ? F.MINUS : '+') + exactAbs(line);
  };
  F.exactTotalText = function (t) { t = num(t); return t === null ? '—' : exactAbs(t); };
  F.ascii = function (text) { return String(text == null ? '' : text).replace(/−/g, '-'); };
  function pts(g) { return g.toFixed(1) + (g === 1 ? ' pt' : ' pts'); }
  function extend(o, x) { Object.keys(x).forEach(function (k) { o[k] = x[k]; }); return o; }
  /* integer tenths, the unit lib/edgedesk_calc.js computes every gap in */
  function tenths(x) { return Math.round(round(x, 1) * 10); }
  function fromTenths(t) { var v = t / 10; return v === 0 ? 0 : v; }

  /* ================================================================== SPREAD
     homeMargin: the RAW projected home margin (home points − away points).
     The display names the favourite and its half-point line; raw_* keep the
     model's own number beside it. */
  F.spread = function (homeMargin, names) {
    names = names || {};
    var home = names.home || 'Home', away = names.away || 'Away';
    var m = num(homeMargin);
    if (m === null) return { available: false, policy: F.POLICY.id, raw_home_margin: null, display_home_margin: null, home_line: null, favorite: null, favorite_team: null, line: null, line_text: '—', text: '—', raw_text: '—', reason: 'no projected margin' };
    var d = F.halfPoint(m), r1 = round(m, 1);
    var fav = d > 0 ? 'home' : (d < 0 ? 'away' : null);
    var team = fav === 'home' ? home : (fav === 'away' ? away : null);
    var line = d === 0 ? 0 : -Math.abs(d);
    var lean = m > 0 ? home : (m < 0 ? away : null);
    var rawTeam = r1 > 0 ? home : (r1 < 0 ? away : null);
    return {
      available: true,
      policy: F.POLICY.id,
      raw_home_margin: m,
      display_home_margin: d,
      home_line: d === 0 ? 0 : -d,          /* book convention for the home team */
      favorite: fav,
      favorite_team: team,
      line: line,                            /* the favourite's line, ≤ 0 */
      line_text: F.lineText(line),
      text: team ? team + ' ' + F.lineText(line) : F.PK,
      pk: d === 0,
      raw_text: rawTeam ? rawTeam + ' ' + F.MINUS + fixed1(r1) : F.PK,
      rounded: Math.abs(d - round(m, F.POLICY.input_dp)) > 1e-9,
      note: d === 0 && lean && round(m, 2) !== 0 ? 'Shown as PK; the unrounded projection leans ' + lean + ' by ' + Math.abs(round(m, 2)).toFixed(2) + '.' : null
    };
  };
  /* the same display, stated for one side ("home" | "away"): −20.5 / +20.5 */
  F.lineFor = function (sp, side) {
    if (!sp || !sp.available) return null;
    return side === 'home' ? sp.home_line : (sp.home_line === 0 ? 0 : -sp.home_line);
  };

  /* =================================================================== TOTAL */
  F.total = function (total) {
    var t = num(total);
    if (t === null) return { available: false, policy: F.POLICY.id, raw: null, display: null, text: '—', raw_text: '—', reason: 'no projected total' };
    var d = F.halfPoint(t);
    return { available: true, policy: F.POLICY.id, raw: t, display: d, text: d.toFixed(1), raw_text: round(t, 1).toFixed(1),
      rounded: Math.abs(d - round(t, F.POLICY.input_dp)) > 1e-9 };
  };

  /* ======================================================== PROJECTED SCORE
     x: { home, away, home_points, away_points } (the engine's own expected
     points) or { home, away, home_margin, total } (split from the raw margin
     and total: (total ± margin) / 2). Whole points for the headline; the
     expected points to two decimals for the details. */
  F.projectedScore = function (x) {
    x = x || {};
    var names = { home: x.home || 'Home', away: x.away || 'Away' };
    var hp = num(x.home_points), ap = num(x.away_points), m = num(x.home_margin), t = num(x.total);
    /* split at the published precision, so every surface splits alike */
    if ((hp === null || ap === null) && m !== null && t !== null) { var t2 = round(t, F.POLICY.input_dp), m2 = round(m, F.POLICY.input_dp); hp = (t2 + m2) / 2; ap = (t2 - m2) / 2; }
    if (hp === null || ap === null) return { available: false, label: 'Projected score', text: '—', reason: 'no projected points' };
    var h = F.wholePoint(hp), a = F.wholePoint(ap);
    var sp = F.spread(m !== null ? m : hp - ap, names), tt = F.total(t !== null ? t : hp + ap);
    var first = h > a ? 'home' : (a > h ? 'away' : (sp.favorite || 'away')), second = first === 'home' ? 'away' : 'home';
    var sc = { home: h, away: a };
    var diff = h - a, sum = h + a;
    var notes = [];
    if (Math.abs(diff - sp.display_home_margin) > 1e-9 || Math.abs(sum - tt.display) > 1e-9) notes.push(F.SCORE_NOTE);
    if (h === a && sp.favorite) notes.push('The whole-number scores round to a tie; unrounded, ' + sp.favorite_team + ' leads by ' + Math.abs(round(hp - ap, 2)).toFixed(2) + '.');
    return {
      available: true,
      policy: F.POLICY.id,
      label: 'Projected score',
      home: h, away: a,
      text: names[first] + ' ' + sc[first] + ', ' + names[second] + ' ' + sc[second],
      expected: { home: round(hp, 2), away: round(ap, 2) },
      expected_text: names[first] + ' ' + round(first === 'home' ? hp : ap, 2).toFixed(2) + ', ' + names[second] + ' ' + round(first === 'home' ? ap : hp, 2).toFixed(2),
      score_margin: diff, score_total: sum,
      note: notes.length ? notes.join(' ') : null
    };
  };

  /* =============================================================== THE GAP
     model: the RAW home margin; marketHomeLine: the sportsbook's line for the
     home team, exactly as received (negative = home favoured). */
  F.compareSpread = function (homeMargin, marketHomeLine, names, opts) {
    names = names || {};
    var home = names.home || 'Home', away = names.away || 'Away';
    var m = num(homeMargin), k = num(marketHomeLine);
    var sp = F.spread(m, names);
    var mkt = F.marketSpread(k, names);
    var out = { policy: F.POLICY.id, model: sp, market: mkt, available: sp.available && mkt.available };
    if (!out.available) { out.reason = !sp.available ? 'no EdgeDesk projection' : 'no market line'; out.gap = null; out.gap_exact = null; out.text = '—'; out.key = null; out.rounding_note = null; return out; }
    var km = k === 0 ? 0 : -k;                 /* the market's home margin */
    var exact = m - km;                        /* + = EdgeDesk likes HOME more than the market */
    var signed = fromTenths(tenths(m) - tenths(km));
    out.gap_exact = Math.abs(exact);
    out.signed = signed;
    out.gap = Math.abs(signed);
    out.toward = signed > 0 ? 'home' : (signed < 0 ? 'away' : null);
    out.toward_team = out.toward === 'home' ? home : (out.toward === 'away' ? away : null);
    out.favorite_differs = !!(sp.favorite && mkt.favorite && sp.favorite !== mkt.favorite);
    /* what a reader would compute from the two printed lines */
    out.displayed_difference = Math.abs(round(sp.display_home_margin - km, 2));
    out.rounding_note = Math.abs(out.displayed_difference - out.gap) > 1e-9 ? F.ROUNDING_NOTE : null;
    out.text = out.gap === 0 ? 'EdgeDesk and the market agree on the spread' : 'EdgeDesk’s number is ' + pts(out.gap) + ' more favourable to ' + out.toward_team;
    out.key = F.keyContext(m, k, names, opts);
    return out;
  };
  /* the market side of a spread, as received */
  F.marketSpread = function (homeLine, names) {
    names = names || {};
    var k = num(homeLine);
    if (k === null) return { available: false, home_line: null, favorite: null, text: '—' };
    var fav = k < 0 ? 'home' : (k > 0 ? 'away' : null);
    var team = fav === 'home' ? (names.home || 'Home') : (fav === 'away' ? (names.away || 'Away') : null);
    return { available: true, home_line: k, favorite: fav, favorite_team: team, line: k === 0 ? 0 : -Math.abs(k),
      text: team ? team + ' ' + F.exactLineText(-Math.abs(k)) : F.PK };
  };
  F.compareTotal = function (total, marketTotal) {
    var t = num(total), k = num(marketTotal), tt = F.total(t);
    var out = { policy: F.POLICY.id, model: tt, market: { available: k !== null, total: k, text: F.exactTotalText(k) }, available: tt.available && k !== null };
    if (!out.available) { out.gap = null; out.gap_exact = null; out.direction = null; out.text = '—'; out.rounding_note = null; return out; }
    var signed = fromTenths(tenths(t) - tenths(k));
    out.gap_exact = Math.abs(t - k);
    out.signed = signed;
    out.gap = Math.abs(signed);
    out.direction = signed > 0 ? 'higher' : (signed < 0 ? 'lower' : 'level');
    out.displayed_difference = Math.abs(round(tt.display - k, 2));
    out.rounding_note = Math.abs(out.displayed_difference - out.gap) > 1e-9 ? F.ROUNDING_NOTE : null;
    out.text = out.gap === 0 ? 'EdgeDesk and the market agree on the total' : 'EdgeDesk’s total is ' + pts(out.gap) + ' ' + out.direction + ' than the market’s';
    return out;
  };

  /* ============================================================ KEY NUMBERS
     Where the model's line and the market's line sit around 3, 7 (and any
     configured margin). Spoken for ONE team, both lines stated for it:
       - the team both favour (or the one favoured where the other is PK):
           "Market is below 7; model is above 7."
           "Market sits on 7; model is above 7."
       - when the favourite flips, the team the model favours:
           "Model favors Indiana outright; market gives Indiana more than a field goal."
     The model's position is read from its displayed half-point line, so the
     note agrees with the line on screen; the market's from its line as
     received. null when no key margin separates the two. Descriptive only. */
  F.keyMargins = function (league, opts) {
    opts = opts || {};
    var extra = opts.additional || (F.KEY_MARGINS.additional[String(league || '').toLowerCase()] || []);
    var all = F.KEY_MARGINS.primary.concat(extra).map(Number).filter(function (k) { return isFinite(k) && k > 0; });
    var seen = {};
    return all.filter(function (k) { if (seen[k]) return false; seen[k] = 1; return true; }).sort(function (a, b) { return a - b; });
  };
  function keyName(k) { return F.KEY_NAMES[k] || (k + ' points'); }
  F.keyContext = function (homeMargin, marketHomeLine, names, opts) {
    opts = opts || {};
    names = names || {};
    var m = num(homeMargin), k = num(marketHomeLine);
    if (m === null || k === null) return null;
    var keys = F.keyMargins(opts.league, opts);
    if (!keys.length) return null;
    var side = { home: names.home || 'Home', away: names.away || 'Away' };
    var model = F.halfPoint(m);                /* home margin as displayed */
    var market = k === 0 ? 0 : -k;             /* home margin as received */
    var mFav = model > 0 ? 'home' : (model < 0 ? 'away' : null), kFav = market > 0 ? 'home' : (market < 0 ? 'away' : null);
    var base = { policy: F.POLICY.id, keys: keys, note: F.KEY_NOTE, adjusts_probability: false };
    function lineOf(margin) { return margin === 0 ? 0 : -margin; }
    if (mFav && kFav && mFav !== kFav) {
      /* the favourite flips: speak for the team the model favours */
      var P = mFav, b = Math.abs(model), d = Math.abs(market);
      var under = keys.filter(function (x) { return x <= b; }), dog = keys.filter(function (x) { return x <= d; });
      if (!under.length && !dog.length) return null;
      var kb = under.length ? under[under.length - 1] : null, kd = dog.length ? dog[dog.length - 1] : null;
      var mc = kb === null ? 'Model favors ' + side[P] + ' outright' : (kb === b ? 'Model favors ' + side[P] + ' by ' + keyName(kb) : 'Model favors ' + side[P] + ' by more than ' + keyName(kb));
      var kc = kd === null ? 'market makes ' + side[P] + ' an underdog' : (kd === d ? 'market gives ' + side[P] + ' exactly ' + keyName(kd) : 'market gives ' + side[P] + ' more than ' + keyName(kd));
      var crossed = keys.filter(function (x) { return x < b; }).concat(keys.filter(function (x) { return x < d; }).map(function (x) { return -x; }));
      var on = [];
      if (kb !== null && kb === b) on.push({ key: kb, by: 'model' });
      if (kd !== null && kd === d) on.push({ key: -kd, by: 'market' });
      return extend(base, { kind: 'flip', side: P, team: side[P], crossed: crossed.sort(function (x, y) { return x - y; }), on: on,
        model_line: F.lineText(-b), market_line: F.exactLineText(d),
        text: mc + '; ' + kc + '.',
        detail: side[P] + ': model fair ' + F.lineText(-b) + ', market ' + F.exactLineText(d) + '.' });
    }
    /* one favourite (the other may be PK): speak for it */
    var Q = mFav || kFav;
    if (!Q) return null;
    var a = Math.abs(market), c = Math.abs(model);
    if (a === c) return null;
    var lo = Math.min(a, c), hi = Math.max(a, c);
    var S = keys.filter(function (x) { return x >= lo && x <= hi; });
    if (!S.length) return null;
    function clause(who, v, other) {
      if (v === 0) return who + ' is a pick’em';
      if (S.indexOf(v) >= 0) return who + ' sits on ' + v;
      return v < other ? who + ' is below ' + S[0] : who + ' is above ' + S[S.length - 1];
    }
    var on2 = [];
    if (S.indexOf(a) >= 0) on2.push({ key: a, by: 'market' });
    if (S.indexOf(c) >= 0) on2.push({ key: c, by: 'model' });
    var crossed2 = S.filter(function (x) { return x > lo && x < hi; });
    return extend(base, { kind: crossed2.length ? 'cross' : 'on', side: Q, team: side[Q], crossed: crossed2, on: on2,
      model_line: F.lineText(lineOf(c)), market_line: F.exactLineText(lineOf(a)),
      text: clause('Market', a, c) + '; ' + clause('model', c, a) + '.',
      detail: side[Q] + ': market ' + F.exactLineText(lineOf(a)) + ', model fair ' + F.lineText(lineOf(c)) + '.' });
  };

  /* ================================================================ BUNDLE
     Everything a surface prints for one projection, raw beside display.
     x: { home, away, home_margin, total, home_points?, away_points?,
          league?, market_home_line?, market_total? } */
  F.display = function (x) {
    x = x || {};
    var names = { home: x.home, away: x.away };
    var out = {
      policy: F.POLICY.id,
      version: F.VERSION,
      spread: F.spread(x.home_margin, names),
      total: F.total(x.total),
      score: F.projectedScore({ home: x.home, away: x.away, home_margin: x.home_margin, total: x.total, home_points: x.home_points, away_points: x.away_points })
    };
    out.rounded = !!((out.spread.available && out.spread.rounded) || (out.total.available && out.total.rounded));
    var rm = out.spread.available ? round(out.spread.raw_home_margin, 2) : null, rt = out.total.available ? round(out.total.raw, 2) : null;
    var by = rm === null ? null : (rm === 0 ? 'even' : (rm > 0 ? (x.home || 'Home') : (x.away || 'Away')) + ' by ' + Math.abs(rm).toFixed(2));
    out.rounding_note = out.rounded ? 'Fair spread and total are shown at the nearest half point; unrounded, the projection is ' + (by || '—') + (rt !== null ? ' with a total of ' + rt.toFixed(2) : '') + '.' : null;
    if (num(x.market_home_line) !== null) out.market_spread = F.compareSpread(x.home_margin, x.market_home_line, names, { league: x.league });
    if (num(x.market_total) !== null) out.market_total = F.compareTotal(x.total, x.market_total);
    return out;
  };

  return F;
});
/*__EDFOOTBALLLINES_END__*/
