/* ===========================================================================
   EdgeDesk LEAD-LAG — which venue's price moved first, measured honestly.

   Input: two venues' observations of the SAME selection (same side, same
   line, same market), each at its own source time, e.g. public.novig_history
   (Novig snapshots every 5 minutes; DraftKings as the odds capture read it,
   about hourly). Output: every meaningful move at one venue, and whether the
   other moved the same way within a window — with the timing uncertainty the
   sampling imposes, never more precision than the data has.

   THE RULES
   - A move is a change in implied probability of at least `min_move_pp`
     percentage points between two consecutive observations of one venue.
     It happened somewhere in (previous observation, this observation]: that
     interval is all that is known about when.
   - Venue A moved FIRST only when A's whole interval ends before B's
     interval for the same-direction move begins. Overlapping intervals are
     UNDETERMINED — with a 5-minute and a 60-minute sampler most are, and the
     study says so rather than crediting the faster sampler.
   - A move with no same-direction move at the other venue inside
     `window_minutes` is NO_FOLLOW.
   - Only pregame observations are used; nothing after the first move's
     window is consulted to classify it (no look-ahead past the window).
   - Shares are reported with Wilson 95% intervals and their sample sizes.
     "Moved first" is a sequence, not a cause: nothing here says one venue
     followed the other.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDLeadLag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = { min_move_pp: 1.0, window_minutes: 180 };

  function implied(o) {
    if (o.implied != null) return Number(o.implied);
    if (o.ask != null && o.ask !== '') return Number(o.ask);
    if (o.price_dec != null) return 1 / Number(o.price_dec);
    return null;
  }
  /** one venue's observations, time-ordered, pregame, usable */
  function series(rows) {
    return (rows || []).map(function (r) { return { t: Date.parse(r.at), p: implied(r), pregame: r.pregame !== false }; })
      .filter(function (x) { return isFinite(x.t) && x.p != null && isFinite(x.p) && x.p > 0 && x.p < 1 && x.pregame; })
      .sort(function (a, b) { return a.t - b.t; });
  }
  /** the meaningful moves of one series: {from, to (ms), dir, size_pp} */
  function moves(s, minPP) {
    var out = [];
    for (var i = 1; i < s.length; i++) {
      var d = (s[i].p - s[i - 1].p) * 100;
      if (Math.abs(d) >= minPP) out.push({ from: s[i - 1].t, to: s[i].t, dir: d > 0 ? 1 : -1, size_pp: d, level_before: s[i - 1].p, level_after: s[i].p });
    }
    return out;
  }
  function wilson(k, n) {
    if (!n) return { p: null, low: null, high: null, n: 0 };
    var z = 1.959964, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { p: p, low: Math.max(0, c - h), high: Math.min(1, c + h), n: n };
  }

  /** classify each move of `a` against `b` */
  function classify(movesA, movesB, windowMs) {
    return movesA.map(function (m) {
      var cand = movesB.filter(function (x) { return x.dir === m.dir && x.to > m.from - windowMs && x.from < m.to + windowMs; });
      if (!cand.length) return Object.assign({ verdict: 'NO_FOLLOW' }, m);
      /* the nearest same-direction move at the other venue */
      cand.sort(function (x, y) { return Math.abs((x.from + x.to) / 2 - (m.from + m.to) / 2) - Math.abs((y.from + y.to) / 2 - (m.from + m.to) / 2); });
      var o = cand[0];
      var verdict = m.to <= o.from ? 'THIS_FIRST' : o.to <= m.from ? 'OTHER_FIRST' : 'UNDETERMINED';
      return Object.assign({ verdict: verdict, other: { from: o.from, to: o.to, size_pp: o.size_pp } }, m);
    });
  }

  /** a whole study: rows from novig_history (both venues); groups by selection */
  function study(rows, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var groups = {};
    (rows || []).forEach(function (r) {
      var k = [r.book_market, r.line == null ? '' : r.line, r.side, r.point == null ? '' : r.point].join('|');
      (groups[k] = groups[k] || { key: k, book_market: r.book_market, side: r.side, point: r.point, novig: [], draftkings: [] })[r.venue === 'novig' ? 'novig' : 'draftkings'].push(r);
    });
    var W = o.window_minutes * 60000, per = [], tally = { novig_first: 0, dk_first: 0, undetermined: 0, no_follow_novig: 0, no_follow_dk: 0, moves_novig: 0, moves_dk: 0 };
    var span = [Infinity, -Infinity];
    Object.keys(groups).forEach(function (k) {
      var g = groups[k], sn = series(g.novig), sd = series(g.draftkings);
      if (!sn.length || !sd.length) { per.push({ key: k, side: g.side, point: g.point, book_market: g.book_market, excluded: 'one venue has no pregame observations' }); return; }
      span[0] = Math.min(span[0], sn[0].t, sd[0].t); span[1] = Math.max(span[1], sn[sn.length - 1].t, sd[sd.length - 1].t);
      var mn = moves(sn, o.min_move_pp), md = moves(sd, o.min_move_pp);
      var cn = classify(mn, md, W), cd = classify(md, mn, W);
      tally.moves_novig += mn.length; tally.moves_dk += md.length;
      cn.forEach(function (x) { if (x.verdict === 'THIS_FIRST') tally.novig_first++; else if (x.verdict === 'OTHER_FIRST') tally.dk_first++; else if (x.verdict === 'UNDETERMINED') tally.undetermined++; else tally.no_follow_novig++; });
      cd.forEach(function (x) { if (x.verdict === 'NO_FOLLOW') tally.no_follow_dk++; });
      var lastN = sn[sn.length - 1], lastD = sd[sd.length - 1];
      per.push({ key: k, side: g.side, point: g.point, book_market: g.book_market, observations: { novig: sn.length, draftkings: sd.length },
        sampling_minutes: { novig: medianGap(sn), draftkings: medianGap(sd) }, moves: { novig: cn, draftkings: cd },
        last: { novig: { at: new Date(lastN.t).toISOString(), implied: lastN.p }, draftkings: { at: new Date(lastD.t).toISOString(), implied: lastD.p }, gap_pp: (lastD.p - lastN.p) * 100 } });
    });
    var determined = tally.novig_first + tally.dk_first;
    return {
      rules: o, groups: per, tally: tally,
      novig_first_share: wilson(tally.novig_first, determined),
      determined: determined, undetermined: tally.undetermined,
      window: isFinite(span[0]) ? { from: new Date(span[0]).toISOString(), to: new Date(span[1]).toISOString() } : null,
      note: 'Sequence, not causation: a venue that moved first is not shown to have caused the other\'s move. Moves are timed only to their sampling intervals; overlapping intervals are undetermined. Pregame observations only.'
    };
  }
  function medianGap(s) {
    if (s.length < 2) return null;
    var g = []; for (var i = 1; i < s.length; i++) g.push((s[i].t - s[i - 1].t) / 60000);
    g.sort(function (a, b) { return a - b; }); var m = Math.floor(g.length / 2);
    return g.length % 2 ? g[m] : (g[m - 1] + g[m]) / 2;
  }

  return { DEFAULTS: DEFAULTS, series: series, moves: moves, classify: classify, study: study, wilson: wilson };
});
