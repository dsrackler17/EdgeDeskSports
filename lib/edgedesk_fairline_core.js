/* ===========================================================================
   EdgeDesk FAIRLINE — the page's arithmetic and words, with no DOM.
   docs/fairline.md

   Not lib/edgedesk_fairline.js, which is the Linemaker's fair-line sheet and
   only shares the word.

   Every label, bucket and gate is supabase/fairline.sql's, from its one
   constant, public.fairline_rules(). This file says, in plain words, what the
   database already decided, and refuses to say more than it knows: a small
   sample says so and carries no label, a slice with no captured close says it
   is read on P/L alone, a price past its freshness limit says it is stale.

     slice words   sliceName, verdict, numbersLine, teaserLine, labelView
     board words   boardRow (fair, best, edge, Kalshi, age), kalshiWords
     the rules     oddsBucket / leadBucket / stakeBucket / classify: the same
                   rules as the SQL, read from the rules object the database
                   returns, and held equal to it by
                   tools/fairline/fairline_sql.test.js. The page uses them to
                   explain a label, never to decide one.

   Browser: window.EDFairlineCore. Node: require('./edgedesk_fairline_core.js').
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.EDFairlineCore = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var X = { VERSION: 'edgedesk_fairline_core/1' };

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  X.num = num;
  var MINUS = '−';
  function sign(v) { return v > 0 ? '+' : v < 0 ? MINUS : ''; }

  /* ── numbers ──────────────────────────────────────────────────────────── */
  X.fmtOdds = function (a) { a = num(a); if (a == null) return '—'; a = Math.round(a); return a > 0 ? '+' + a : a < 0 ? MINUS + Math.abs(a) : '0'; };
  X.fmtPct = function (v, d) { v = num(v); if (v == null) return '—'; return sign(v) + Math.abs(v).toFixed(d == null ? 1 : d) + '%'; };
  X.fmtPts = function (v) { v = num(v); if (v == null) return '—'; return sign(v) + Math.abs(v).toFixed(2) + ' pts'; };
  X.fmtProb = function (p) { p = num(p); if (p == null) return '—'; return (100 * p).toFixed(1) + '%'; };
  X.fmtCents = function (p) { p = num(p); if (p == null) return '—'; var c = Math.round(p * 1000) / 10; return (c % 1 === 0 ? c.toFixed(0) : c.toFixed(1)) + '¢'; };
  /* dollars: whole dollars from $100, cents below */
  X.fmtMoney = function (v, signed) {
    v = num(v); if (v == null) return '—';
    var a = Math.abs(v), s = a >= 100 ? Math.round(a).toLocaleString('en-US') : a.toFixed(2);
    return (signed ? sign(v) : (v < 0 ? MINUS : '')) + '$' + s;
  };
  X.fmtUnits = function (v, signed) {
    v = num(v); if (v == null) return '—';
    return (signed ? sign(v) : (v < 0 ? MINUS : '')) + Math.abs(v).toFixed(2) + 'u';
  };
  X.fmtAge = function (min) {
    min = num(min); if (min == null) return '—';
    if (min < 1) return 'under a minute';
    if (min < 60) return Math.round(min) + ' min';
    var h = Math.floor(min / 60), m = Math.round(min - 60 * h);
    if (m === 60) { h += 1; m = 0; }
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  };
  X.fmtLine = function (market, line) {
    line = num(line);
    if (market === 'moneyline' || line == null) return '';
    if (market === 'total') return String(line);
    return (line > 0 ? '+' : line < 0 ? MINUS : '') + String(Math.abs(line));
  };

  /* ── the rules (mirrors of supabase/fairline.sql) ─────────────────────── */
  function inRange(e, x, toInclusive) {
    var f = e && typeof e.from === 'number' ? e.from : null, t = e && typeof e.to === 'number' ? e.to : null;
    return (f == null || x >= f) && (t == null || (toInclusive ? x <= t : x < t));
  }
  /* American odds, both ends inclusive, after rounding; -100 and +100 are one price */
  X.oddsBucket = function (american, rules) {
    var a = num(american); if (a == null || Math.abs(a) < 100) return null;
    a = Math.round(a);
    var list = (rules && rules.odds_buckets) || [];
    for (var i = 0; i < list.length; i++) if (inRange(list[i], a, true)) return list[i].key;
    return null;
  };
  function rangeBucket(list, x) {
    if (x == null) return null;
    for (var i = 0; i < (list || []).length; i++) if (inRange(list[i], x, false)) return list[i].key;
    return null;
  }
  X.leadBucket = function (placedAt, startsAt, rules) {
    var p = placedAt == null ? NaN : Date.parse(placedAt), s = startsAt == null ? NaN : Date.parse(startsAt);
    if (!isFinite(p) || !isFinite(s)) return 'unknown';
    if (p >= s) return 'live';
    return rangeBucket(rules && rules.lead_buckets, (s - p) / 3600000);
  };
  X.stakeBucket = function (ratio, rules) { return rangeBucket(rules && rules.stake_buckets, num(ratio)) || 'unknown'; };
  /* THE LABEL: losing is a negative return; beating the close is an average
     CLV above zero. Below the minimum sample: none. Without enough captured
     closes: P/L only. */
  X.classify = function (bets, clvBets, ret, avgClv, rules) {
    var min = num(rules && rules.min_sample_bets), minClv = num(rules && rules.min_clv_bets);
    bets = num(bets) || 0; clvBets = num(clvBets) || 0; ret = num(ret); avgClv = num(avgClv);
    if (min == null || minClv == null || bets < min || ret == null) return null;
    if (clvBets < minClv || avgClv == null) return ret < 0 ? 'losing' : 'winning';
    if (ret < 0 && avgClv <= 0) return 'real_leak';
    if (ret < 0) return 'bad_luck';
    if (avgClv <= 0) return 'running_hot';
    return 'real_edge';
  };

  /* ── the labels, as chips (always text, never colour alone) ───────────── */
  X.LABELS = {
    real_leak: { chip: 'Real leak', cls: 'leak', about: 'Losing money and not beating the close. The bets are the problem.' },
    bad_luck: { chip: 'Bad luck', cls: 'luck', about: 'Losing money while beating the close. That is variance; the prices were good.' },
    running_hot: { chip: 'Running hot', cls: 'hot', about: 'Making money while the close beats you. Results are ahead of the prices; expect them to come back.' },
    real_edge: { chip: 'Real edge', cls: 'edge', about: 'Making money and beating the close. The prices back the results up.' },
    losing: { chip: 'Losing (P/L only)', cls: 'plonly', about: 'Losing money, with too few captured closes to say whether it is the bets or luck.' },
    winning: { chip: 'Winning (P/L only)', cls: 'plonly', about: 'Making money, with too few captured closes to say whether it is skill or luck.' }
  };
  X.labelView = function (s) {
    if (!s) return null;
    if (s.small_sample || !s.label) return { chip: 'Small sample', cls: 'small', about: 'Too few settled bets to read yet.' };
    return X.LABELS[s.label] || null;
  };

  /* ── slice names ──────────────────────────────────────────────────────── */
  X.DIMS = [
    { key: 'market', label: 'Market' }, { key: 'sport', label: 'Sport' }, { key: 'bet_type', label: 'Bet type' },
    { key: 'odds', label: 'Odds range' }, { key: 'lead', label: 'Lead time before start' }, { key: 'book', label: 'Book / platform' },
    { key: 'stake', label: 'Stake size vs your median' }
  ];
  var MARKETS = { spread: 'Spreads', total: 'Totals', moneyline: 'Moneylines', props: 'Props', parlay: 'Parlays', other: 'Other markets' };
  var BET_TYPES = { straight: 'Straight bets', parlay: 'Parlays' };
  function oddsName(key, rules) {
    var list = (rules && rules.odds_buckets) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key !== key) continue;
      var f = list[i].from, t = list[i].to;
      if (typeof f !== 'number' && typeof t === 'number') return 'Odds ' + X.fmtOdds(t) + ' or shorter';
      if (typeof t !== 'number' && typeof f === 'number') return 'Odds longer than ' + X.fmtOdds(f - 1);
      return 'Odds ' + X.fmtOdds(f) + ' to ' + X.fmtOdds(t);
    }
    return key === 'unknown' ? 'Odds unknown' : 'Odds ' + key;
  }
  function hoursName(key, rules) {
    if (key === 'live') return 'Live bets';
    if (key === 'unknown') return 'Start time unknown';
    var list = (rules && rules.lead_buckets) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].key !== key) continue;
      var f = list[i].from, t = list[i].to;
      if (typeof t !== 'number') return 'Bet ' + f + 'h+ before the start';
      if (!f) return 'Bet under ' + t + 'h before the start';
      return 'Bet ' + f + '–' + t + 'h before the start';
    }
    return key;
  }
  function stakeName(key, rules) {
    if (key === 'unknown') return 'Stake unknown';
    var list = (rules && rules.stake_buckets) || [];
    var nm = { small: 'Small stakes', typical: 'Typical stakes', large: 'Large stakes', oversized: 'Oversized stakes' }[key] || key;
    for (var i = 0; i < list.length; i++) {
      if (list[i].key !== key) continue;
      var f = list[i].from, t = list[i].to;
      if (typeof f !== 'number') return nm + ' (under ' + t + '× your median)';
      if (typeof t !== 'number') return nm + ' (' + f + '× your median or more)';
      return nm + ' (' + f + '–' + t + '× your median)';
    }
    return nm;
  }
  function sportName(v) {
    var s = String(v == null ? '' : v);
    if (!s) return 'Other';
    return s.length <= 5 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  X.sliceName = function (dim, val, rules) {
    if (dim === 'all') return 'All your bets';
    if (dim === 'market') return MARKETS[val] || String(val);
    if (dim === 'bet_type') return BET_TYPES[val] || String(val);
    if (dim === 'odds') return oddsName(val, rules);
    if (dim === 'lead') return hoursName(val, rules);
    if (dim === 'stake') return stakeName(val, rules);
    if (dim === 'sport') return sportName(val);
    return String(val == null ? '' : val);
  };

  /* ── money, in the slice's own measure ────────────────────────────────── */
  /* the P/L a verdict speaks in: dollars when the slice has them for every
     settled bet, else units, else flat units (one unit a bet) */
  X.plWords = function (s) {
    var b = s && s.roi_basis;
    var v = b === 'dollars' ? num(s.pl_dollars) : b === 'units' ? num(s.pl_units) : b === 'flat' ? num(s.pl_basis_value) : null;
    if (v == null) return null;
    var amt = b === 'dollars' ? X.fmtMoney(Math.abs(v)) : Math.abs(v).toFixed(2) + ' units' + (b === 'flat' ? ' (one unit a bet)' : '');
    return { up: v >= 0, even: v === 0, amount: amt, text: v === 0 ? 'even' : (v > 0 ? 'up ' : 'down ') + amt };
  };
  function betsWord(n) { return n + (n === 1 ? ' bet' : ' bets'); }

  /* THE VERDICT: one plain sentence, from what the database decided */
  X.verdict = function (s, rules) {
    if (!s) return '';
    var name = X.sliceName(s.dim, s.val, rules), n = num(s.bets) || 0;
    if (n === 0) return name + ': no settled bets yet.';
    var min = num(rules && rules.min_sample_bets);
    if (s.small_sample || !s.label) {
      return name + ': ' + betsWord(n) + ' settled. Too few to read yet' + (min ? ' — a label needs ' + min + '.' : '.');
    }
    var pl = X.plWords(s);
    var head = name + ': ' + (pl ? pl.text : 'no P/L') + ' over ' + betsWord(n);
    var clv = X.fmtPct(s.avg_clv_pct, 1);
    switch (s.label) {
      case 'real_leak': return head + ', and you’re not beating the close. This one’s real.';
      case 'bad_luck': return head + ', but you’re beating the close (' + clv + ' average CLV). That’s variance, not a leak.';
      case 'running_hot': return head + ', but the close is beating you (' + clv + ' average CLV). Don’t count on it lasting.';
      case 'real_edge': return head + ', and you’re beating the close (' + clv + ' average CLV). This one’s real.';
      case 'losing': return head + '. Too few captured closes to say whether it’s the bets or bad luck.';
      case 'winning': return head + '. Too few captured closes to say whether it’s skill or luck.';
    }
    return head + '.';
  };

  X.record = function (s) {
    if (!s) return '—';
    var r = (s.wins || 0) + '–' + (s.losses || 0) + ((s.pushes || 0) ? '–' + s.pushes : '');
    return r + ((s.cashouts || 0) ? ' · ' + s.cashouts + ' cashed out' : '');
  };
  /* the numbers under a verdict */
  X.numbersLine = function (s) {
    if (!s) return [];
    var out = [];
    out.push({ k: 'Bets', v: String(s.bets || 0) + ((s.pending || 0) ? ' (+' + s.pending + ' open)' : '') });
    out.push({ k: 'Record', v: X.record(s) });
    out.push({ k: 'Dollars', v: s.dollars_bets && s.dollars_bets === s.bets ? X.fmtMoney(s.pl_dollars, true)
      : s.dollars_bets ? X.fmtMoney(s.pl_dollars, true) + ' (' + s.dollars_bets + ' of ' + s.bets + ' bets)' : '—' });
    out.push({ k: 'Units', v: s.units_bets && s.units_bets === s.bets ? X.fmtUnits(s.pl_units, true)
      : s.units_bets ? X.fmtUnits(s.pl_units, true) + ' (' + s.units_bets + ' of ' + s.bets + ' bets)' : '—' });
    out.push({ k: 'ROI', v: s.roi_pct == null ? '—' : X.fmtPct(s.roi_pct, 1) + (s.roi_basis === 'units' ? ' (units)' : s.roi_basis === 'flat' ? ' (flat)' : '') });
    out.push({ k: 'Avg CLV', v: s.clv_bets ? X.fmtPct(s.avg_clv_pct, 2) + ' (' + s.clv_bets + ' closes)' : 'No close captured' });
    out.push({ k: 'Beat close', v: s.clv_bets ? Math.round(num(s.beat_close_pct)) + '% (' + s.beat_close + ' of ' + s.clv_bets + ')' : '—' });
    return out;
  };

  /* the free teaser: the slice's name, nothing else */
  X.teaserLine = function (t, rules) {
    if (!t) return '';
    if (t.state === 'leak') return 'Your biggest leak is in ' + X.sliceName(t.dim, t.val, rules) + '.';
    if (t.state === 'no_leak') return 'No real leak in your bets so far.';
    return 'Not enough settled bets yet to find a leak.';
  };

  /* ── The Board ────────────────────────────────────────────────────────── */
  X.KALSHI_STATES = { OK: 'OK', STALE: 'Stale', WIDE_SPREAD: 'Spread too wide', NO_TWO_SIDED_QUOTE: 'One-sided', NO_SNAPSHOT: 'No snapshot' };
  X.kalshiWords = function (r) {
    if (!r || !r.kalshi_state) return { text: '—', title: 'No Kalshi market is linked to this line.' };
    if (r.kalshi_state === 'OK') return { text: X.fmtCents(r.kalshi_mid), sub: r.kalshi_ask != null ? 'ask ' + X.fmtCents(r.kalshi_ask) : '',
      title: 'Kalshi YES mid, before Kalshi’s fees.' };
    return { text: X.KALSHI_STATES[r.kalshi_state] || r.kalshi_state, title: 'No Kalshi price is shown for this market right now.' };
  };
  X.sideWords = function (r) {
    if (!r) return '';
    if (r.market === 'total') return r.selection + ' ' + X.fmtLine('total', r.point);
    if (r.market === 'moneyline') return r.selection + ' ML';
    return r.selection + ' ' + X.fmtLine('spread', r.point);
  };
  X.MARKET_WORDS = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' };
  X.boardRow = function (r) {
    if (!r) return null;
    var priced = num(r.best_dec) != null;
    return {
      key: r.sig_key,
      game: (r.away_team || 'Away') + ' at ' + (r.home_team || 'Home'),
      league: [r.sport, X.MARKET_WORDS[r.market] || r.market].filter(Boolean).join(' · '),
      side: X.sideWords(r),
      fair: X.fmtProb(r.fair_prob) + ' · ' + X.fmtOdds(r.fair_american),
      fairProb: X.fmtProb(r.fair_prob),
      fairOdds: 'fair ' + X.fmtOdds(r.fair_american),
      best: priced ? X.fmtOdds(r.best_american) : 'No price captured',
      book: priced ? (r.best_book || '') : '',
      edge: priced ? X.fmtPts(r.edge_pts) : '—',
      edgeCls: !priced || num(r.edge_pts) == null ? '' : num(r.edge_pts) > 0 ? 'pos' : num(r.edge_pts) < 0 ? 'neg' : '',
      age: priced ? X.fmtAge(r.quote_age_min) : '—',
      fresh: r.fresh === true,
      stale: r.fresh !== true,
      staleWhy: r.fresh === true ? '' : priced ? 'Older than its ' + X.fmtAge(r.fresh_limit_min) + ' limit' : 'No price captured',
      kalshi: X.kalshiWords(r)
    };
  };

  return X;
}));
