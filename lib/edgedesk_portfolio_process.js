/* ===========================================================================
   EDGEDESK PORTFOLIO — the Decision Grade and the Process Coach.
   docs/portfolio-journal.md

   TWO HALVES
   1. THE GRADE (mirrors supabase/portfolio_journal.sql exactly, value for
      value; tools/portfolio/journal_sql.test.js holds the two in parity).
      Seven process components, each 0–100 or null when its data was never
      recorded, combined by fixed weights renormalized over what exists:

        CLV 30 · model edge at entry 20 · price quality 15 · sizing 15 ·
        timing 10 · rule adherence 5 · market structure 5

      Profit and loss are not an input to any component. A position with no
      price-based component, or under 30 points of weight, is not graded.

   2. THE COACH. Statistics over the server's aggregates (portfolio_cells:
      counts, sums and sums of squares per dimension) — never over a
      downloaded lifetime. Every finding carries its sample, period,
      comparison group, calculation, confidence and the filter that lists
      its positions (the WHY). Nothing is said without evidence:

        OBSERVATION      n ≥ 10 in the cell and its comparison, effect noted
        DEVELOPING       n ≥ 30, p < 0.10
        SUPPORTED        n ≥ 30, Benjamini–Hochberg q < 0.10 across every
                         test run, |d| ≥ 0.2, same direction in both halves
                         of the period, and confirmed by a PROCESS metric
                         (CLV or process score) — P&L alone never qualifies
        STRONG EVIDENCE  SUPPORTED, n ≥ 100, q < 0.05, |d| ≥ 0.3, and the
                         most recent 30% (the holdout) agrees

      Below OBSERVATION there is no finding, only "NO RELIABLE LEAK
      DETECTED" and how much more data a test needs. The coach never
      recommends more betting, larger stakes, deposits, chasing a loss or a
      promotion, and never labels behaviour (the words it may not use are
      listed in BANNED_WORDS and enforced by test).

   Browser: window.EDPortfolioProcess.   Node: require('./edgedesk_portfolio_process.js').
   =========================================================================== */
(function (root, factory) {
  var E = root.EDPortfolio || (typeof require === 'function' ? require('./edgedesk_portfolio.js') : null);
  var api = factory(E);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EDPortfolioProcess = api;
}(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (E) {
  'use strict';
  var D = E.dec;
  function has(x) { return x !== null && x !== undefined && x !== '' && D.valid(x); }
  function num(x) { return has(x) ? Number(x) : null; }
  function lt(a, b) { return D.cmp(a, b) < 0; }
  function le(a, b) { return D.cmp(a, b) <= 0; }
  function gt(a, b) { return D.cmp(a, b) > 0; }
  function ge(a, b) { return D.cmp(a, b) >= 0; }
  function minD(list) { var m = null; list.forEach(function (x) { if (has(x) && (m === null || lt(x, m))) m = D.str(x); }); return m; }
  function maxD(list) { var m = null; list.forEach(function (x) { if (has(x) && (m === null || gt(x, m))) m = D.str(x); }); return m; }

  /* ═══ 1. VOCABULARY (portfolio_journal.sql § 1) ═══════════════════════ */
  function leadSeconds(placed, start) {
    var a = Date.parse(placed), b = Date.parse(start);
    return isFinite(a) && isFinite(b) && placed != null && start != null ? Math.trunc((b - a) / 1000) : null;
  }
  function timingBucket(lead) {
    if (lead == null) return 'UNKNOWN';
    if (lead <= 0) return 'LIVE';
    if (lead < 3600) return 'UNDER_1H';
    if (lead < 21600) return 'H1_6';
    if (lead < 86400) return 'H6_24';
    if (lead < 259200) return 'D1_3';
    if (lead < 604800) return 'D3_7';
    return 'D7_PLUS';
  }
  var TIMING_LABEL = { LIVE: 'Live (after the start)', UNDER_1H: 'Under 1 hour before', H1_6: '1–6 hours before', H6_24: '6–24 hours before',
    D1_3: '1–3 days before', D3_7: '3–7 days before', D7_PLUS: '7+ days before', UNKNOWN: 'Start time not recorded' };
  function oddsBand(dec) {
    if (!has(dec)) return 'UNKNOWN';
    if (lt(dec, '1.5')) return 'HEAVY_FAVOURITE';
    if (lt(dec, '1.91')) return 'FAVOURITE';
    if (le(dec, '2.1')) return 'NEAR_EVEN';
    if (lt(dec, '3')) return 'UNDERDOG';
    if (lt(dec, '5')) return 'LONG';
    return 'LONGSHOT';
  }
  function unitsBand(u) {
    if (!has(u)) return 'NO_UNIT';
    if (lt(u, '0.5')) return 'UNDER_HALF';
    if (le(u, '1')) return 'HALF_TO_ONE';
    if (le(u, '2')) return 'ONE_TO_TWO';
    return 'OVER_TWO';
  }
  function hourBand(h) { return h == null ? 'UNKNOWN' : h < 6 ? 'NIGHT' : h < 12 ? 'MORNING' : h < 18 ? 'AFTERNOON' : 'EVENING'; }
  function ouDirection(selection, side) {
    var sd = String(side || ''), se = String(selection || '');
    if (/^\s*over\b/i.test(sd) || /^\s*(over\b|o\s*\+?[0-9])/i.test(se)) return 'OVER';
    if (/^\s*under\b/i.test(sd) || /^\s*(under\b|u\s*\+?[0-9])/i.test(se)) return 'UNDER';
    return null;
  }
  function lineGain(dir, entry, ref) {
    if (!has(entry) || !has(ref)) return null;
    if (dir === 'OVER') return D.sub(ref, entry);
    return D.sub(entry, ref);
  }

  /* ═══ 2. THE COMPONENTS (portfolio_journal.sql § 2) ═══════════════════ */
  function clamp(x) {
    if (!has(x)) return null;
    var v = lt(x, '0') ? '0' : gt(x, '100') ? '100' : D.str(x);
    return D.round(v, 1);
  }
  function clvPct(type, entry, close) {
    if (!has(entry) || !has(close)) return null;
    if (type === 'PREDICTION_MARKET') return gt(entry, '0') && ge(close, '0') && le(close, '1') ? D.sub(D.divRound(close, entry, 6), '1') : null;
    return gt(entry, '1') && gt(close, '1') ? D.sub(D.divRound(entry, close, 6), '1') : null;
  }
  function scoreClv(pct, points) {
    if (has(points)) return clamp(D.add('50', D.mul('25', points)));
    if (has(pct)) return clamp(D.add('50', D.mul('1000', pct)));
    return null;
  }
  function modelEv(type, prob, entry) {
    if (!has(prob) || !has(entry) || le(prob, '0') || ge(prob, '1')) return null;
    if (type === 'PREDICTION_MARKET') return gt(entry, '0') ? D.sub(D.divRound(prob, entry, 6), '1') : null;
    return gt(entry, '1') ? D.sub(D.round(D.mul(prob, entry), 6), '1') : null;
  }
  function scoreModel(ev) { return has(ev) ? clamp(D.add('50', D.mul('1000', ev))) : null; }
  function priceSlip(type, entry, research) {
    if (!has(entry) || !has(research)) return null;
    if (type === 'PREDICTION_MARKET') return gt(entry, '0') && gt(research, '0') ? D.sub(D.divRound(research, entry, 6), '1') : null;
    return gt(entry, '1') && gt(research, '1') ? D.sub(D.divRound(entry, research, 6), '1') : null;
  }
  function scorePrice(slip, points) {
    if (has(points)) return clamp(D.add('100', D.mul('25', lt(points, '0') ? points : '0')));
    if (has(slip)) return clamp(D.add('100', D.mul('1000', lt(slip, '0') ? slip : '0')));
    return null;
  }
  function scoreTiming(type, entry, open, research, close) {
    if (!has(entry)) return null;
    var others = [open, research, close].filter(has);
    if (others.length < 2) return null;
    var all = [entry].concat(others), hi = maxD(all), lo = minD(all);
    if (D.cmp(hi, lo) === 0) return null;
    var span = D.sub(hi, lo);
    return type === 'PREDICTION_MARKET' ? D.divRound(D.mul('100', D.sub(hi, entry)), span, 1) : D.divRound(D.mul('100', D.sub(entry, lo)), span, 1);
  }
  function capScore(u, cap) {
    if (!has(u) || !has(cap) || le(cap, '0')) return null;
    return le(u, cap) ? '100' : D.sub('200', D.mul('100', D.divRound(u, cap, 6)));
  }
  function scoreSizing(units, maxSingle, dayUnits, maxDaily) {
    var a = capScore(units, maxSingle), b = capScore(dayUnits, maxDaily);
    var m = minD([a, b]);
    return m === null ? null : clamp(m);
  }
  var MARKET_TIER = { MONEYLINE: '80', SPREAD: '80', TOTAL: '80', PLAYER_PROP: '60', FUTURE: '40', PARLAY: '30', SAME_GAME_PARLAY: '20',
    EVENT_CONTRACT: '70', PREDICTION_MARKET: '70' };
  function scoreMarket(type, positionType) { return type === 'PREDICTION_MARKET' ? '70' : (MARKET_TIER[positionType] || null); }
  var WEIGHTS = { clv: 30, model: 20, price: 15, sizing: 15, timing: 10, rules: 5, market: 5 };
  var COMPONENTS = ['clv', 'model', 'price', 'sizing', 'timing', 'rules', 'market'];
  var COMPONENT_LABEL = { clv: 'Closing line value', model: 'Model edge at entry', price: 'Price quality', sizing: 'Sizing discipline',
    timing: 'Entry timing', rules: 'Rule adherence', market: 'Market structure' };
  function processWeight(c) {
    var w = 0;
    COMPONENTS.forEach(function (k) { if (has(c[k])) w += WEIGHTS[k]; });
    return w;
  }
  function processScore(c) {
    var w = processWeight(c);
    if (!(has(c.clv) || has(c.model) || has(c.price) || has(c.timing)) || w < 30) return null;
    var total = '0';
    COMPONENTS.forEach(function (k) { if (has(c[k])) total = D.add(total, D.mul(String(WEIGHTS[k]), c[k])); });
    return D.divRound(total, String(w), 1);
  }
  function gradeLetter(score) {
    if (!has(score)) return null;
    var s = Number(score);
    return s >= 90 ? 'A+' : s >= 84 ? 'A' : s >= 78 ? 'A-' : s >= 72 ? 'B+' : s >= 66 ? 'B' : s >= 60 ? 'B-' : s >= 55 ? 'C+'
      : s >= 45 ? 'C' : s >= 40 ? 'C-' : s >= 30 ? 'D' : 'F';
  }
  function confidence(n) { n = n || 0; return n < 10 ? 'BUILDING' : n < 30 ? 'LOW' : n < 100 ? 'MEDIUM' : 'HIGH'; }
  var CONFIDENCE_TEXT = { BUILDING: 'Building — fewer than 10 graded positions', LOW: 'Low — 10 to 29 graded positions',
    MEDIUM: 'Medium — 30 to 99 graded positions', HIGH: 'High — 100 or more graded positions' };
  function processBand(score) { return !has(score) ? 'UNGRADED' : ge(score, '66') ? 'GOOD' : ge(score, '45') ? 'AVERAGE' : 'POOR'; }

  /* one rule against one position (portfolio_rule_verdict) */
  function ruleVerdict(kind, params, x) {
    params = params || {};
    var n = function (k) { return params[k] == null ? null : String(params[k]); };
    switch (kind) {
      case 'MAX_STAKE_UNITS': return !has(x.units) || n('units') == null ? 'UNKNOWN' : le(x.units, n('units')) ? 'FOLLOWED' : 'BROKEN';
      case 'MAX_DAILY_UNITS': return !has(x.dayUnits) || n('units') == null ? 'UNKNOWN' : le(x.dayUnits, n('units')) ? 'FOLLOWED' : 'BROKEN';
      case 'MAX_POSITIONS_PER_DAY': return x.dayCount == null || n('count') == null ? 'UNKNOWN' : le(String(x.dayCount), n('count')) ? 'FOLLOWED' : 'BROKEN';
      case 'MIN_MODEL_EDGE': return !has(x.modelEv) || n('ev') == null ? 'UNKNOWN' : ge(x.modelEv, n('ev')) ? 'FOLLOWED' : 'BROKEN';
      case 'ODDS_BETWEEN': return !has(x.entryDec) ? 'UNKNOWN' : ge(x.entryDec, n('min') || '1') && le(x.entryDec, n('max') || '10001') ? 'FOLLOWED' : 'BROKEN';
      case 'NO_LIVE': return x.leadSeconds == null ? 'UNKNOWN' : x.leadSeconds > 0 ? 'FOLLOWED' : 'BROKEN';
      case 'MIN_LEAD_HOURS': return x.leadSeconds == null || n('hours') == null ? 'UNKNOWN' : x.leadSeconds >= Number(params.hours) * 3600 ? 'FOLLOWED' : 'BROKEN';
      case 'NO_PARLAYS': return x.positionType === 'PARLAY' || x.positionType === 'SAME_GAME_PARLAY' ? 'BROKEN' : 'FOLLOWED';
      case 'ONLY_SPORTS': return !x.sport || !Array.isArray(params.sports) ? 'UNKNOWN'
        : params.sports.map(function (s) { return String(s).toUpperCase(); }).indexOf(String(x.sport).toUpperCase()) >= 0 ? 'FOLLOWED' : 'BROKEN';
      case 'REQUIRE_PLANNED': return x.planned == null ? 'UNKNOWN' : x.planned ? 'FOLLOWED' : 'BROKEN';
      case 'REQUIRE_THESIS': return x.hasThesis ? 'FOLLOWED' : 'BROKEN';
      default: return 'UNKNOWN';
    }
  }
  var RULE_KINDS = {
    MAX_STAKE_UNITS: { label: 'No position larger than {units} units', params: ['units'] },
    MAX_DAILY_UNITS: { label: 'No more than {units} units placed in a day', params: ['units'] },
    MAX_POSITIONS_PER_DAY: { label: 'No more than {count} positions in a day', params: ['count'] },
    MIN_MODEL_EDGE: { label: 'Only enter with a model edge of at least {ev}', params: ['ev'] },
    ODDS_BETWEEN: { label: 'Only enter between decimal odds {min} and {max}', params: ['min', 'max'] },
    NO_LIVE: { label: 'No live positions (placed after the start)', params: [] },
    MIN_LEAD_HOURS: { label: 'Enter at least {hours} hours before the start', params: ['hours'] },
    NO_PARLAYS: { label: 'No parlays or same-game parlays', params: [] },
    ONLY_SPORTS: { label: 'Only these sports: {sports}', params: ['sports'] },
    REQUIRE_PLANNED: { label: 'Only positions tagged PLANNED', params: [] },
    REQUIRE_THESIS: { label: 'Write a thesis (10+ characters) before entering', params: [] }
  };
  var DECISION_TAGS = ['MODEL', 'LINE_VALUE', 'MATCHUP', 'INJURY', 'WEATHER', 'MARKET_MOVEMENT', 'PROMOTION', 'LIVE_READ', 'HEDGE', 'PERSONAL_READ', 'OTHER'];
  var TAG_LABEL = { MODEL: 'Model', LINE_VALUE: 'Line value', MATCHUP: 'Matchup', INJURY: 'Injury', WEATHER: 'Weather', MARKET_MOVEMENT: 'Market movement',
    PROMOTION: 'Promotion', LIVE_READ: 'Live read', HEDGE: 'Hedge', PERSONAL_READ: 'Personal read', OTHER: 'Other' };

  /* the whole grade of one position, from what was recorded (the SQL's
     facts row, computed here for previews and the pre-entry panel) */
  function gradePosition(x) {
    var type = x.platform_type, pm = type === 'PREDICTION_MARKET';
    var entry = pm ? x.average_entry_price : x.odds_decimal;
    var entryDec = pm ? (has(entry) && gt(entry, '0') ? D.divRound('1', entry, 6) : null) : entry;
    var j = x.journal || {};
    var cutoff = Math.min(isFinite(Date.parse(x.event_start_at)) ? Date.parse(x.event_start_at) : Infinity,
      isFinite(Date.parse(x.settled_at)) ? Date.parse(x.settled_at) : Infinity);
    var modelPre = j.model_recorded_at != null && Date.parse(j.model_recorded_at) < cutoff;
    var researchPre = j.research_recorded_at != null && Date.parse(j.research_recorded_at) < cutoff;
    var dir = ouDirection(x.selection, x.side);
    var closeMoved = has(x.line) && has(j.closing_line) && D.cmp(j.closing_line, x.line) !== 0;
    var researchMoved = has(x.line) && has(j.research_line) && D.cmp(j.research_line, x.line) !== 0;
    var c = {};
    var clvPoints = closeMoved ? lineGain(dir, x.line, j.closing_line) : null;
    var clv = closeMoved ? null : clvPct(type, entry, pm ? j.closing_price : j.closing_odds_decimal);
    c.clv = scoreClv(clv, clvPoints);
    var ev = modelPre ? modelEv(type, j.model_probability, entry) : null;
    c.model = scoreModel(ev);
    var pPoints = researchPre && researchMoved ? lineGain(dir, x.line, j.research_line) : null;
    var slip = !researchPre || researchMoved ? null : priceSlip(type, entry, pm ? j.research_price : j.research_odds_decimal);
    c.price = scorePrice(slip, pPoints);
    c.timing = pm ? scoreTiming(type, entry, j.opening_price, researchPre ? j.research_price : null, j.closing_price)
      : scoreTiming(type, entry, !has(x.line) || !has(j.opening_line) || D.cmp(j.opening_line, x.line) === 0 ? j.opening_odds_decimal : null,
        researchPre && !researchMoved ? j.research_odds_decimal : null, closeMoved ? null : j.closing_odds_decimal);
    var units = has(j.unit_size_at_entry) && gt(j.unit_size_at_entry, '0') && has(x.cost_basis) ? D.divRound(x.cost_basis, j.unit_size_at_entry, 4) : null;
    c.sizing = scoreSizing(units, j.max_single_units_at_entry, has(x.day_units) ? x.day_units : units, j.max_daily_units_at_entry);
    c.rules = x.rules_applicable > 0 ? D.divRound(String(100 * x.rules_followed), String(x.rules_applicable), 1) : null;
    c.market = scoreMarket(type, x.position_type);
    return { components: c, clv_pct: clv, clv_points: clvPoints, model_ev: ev, price_slip: slip, price_points: pPoints,
      entry_dec: entryDec, units: units, weight: processWeight(c), score: processScore(c), grade: gradeLetter(processScore(c)) };
  }

  /* ═══ 3. STATISTICS — small, exact enough, and tested ════════════════ */
  function moments(n, sum, sq) {
    n = Number(n) || 0; sum = Number(sum) || 0; sq = Number(sq) || 0;
    if (n < 1) return { n: 0, mean: null, sd: null, se: null };
    var mean = sum / n, v = n > 1 ? Math.max(0, (sq - n * mean * mean) / (n - 1)) : null;
    return { n: n, mean: mean, sd: v == null ? null : Math.sqrt(v), var: v, se: v == null ? null : Math.sqrt(v / n) };
  }
  /* log Γ (Lanczos) and the regularized incomplete beta, for Student's t */
  function lgamma(x) {
    var g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    var y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t);
    var s = 1.000000000190015;
    for (var i = 0; i < 6; i++) s += g[i] / ++y;
    return -t + Math.log(2.5066282746310005 * s / x);
  }
  function betacf(a, b, x) {
    var qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d; var h = d;
    for (var m = 1; m <= 200; m++) {
      var m2 = 2 * m, aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
      var del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-12) break;
    }
    return h;
  }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    var bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  /* two-sided p-value of t with df degrees of freedom */
  function tPValue(t, df) {
    if (!isFinite(t) || !(df > 0)) return null;
    return Math.min(1, Math.max(0, ibeta(df / (df + t * t), df / 2, 0.5)));
  }
  /* the t quantile for a two-sided interval, by bisection on the CDF */
  function tCrit(conf, df) {
    var target = 1 - conf, lo = 0, hi = 50;
    for (var i = 0; i < 80; i++) { var mid = (lo + hi) / 2; if (tPValue(mid, df) > target) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  /* Welch's two-sample test from moments; a = the cell, b = its comparison */
  function welch(a, b) {
    if (!a || !b || a.n < 2 || b.n < 2 || a.var == null || b.var == null) return null;
    var va = a.var / a.n, vb = b.var / b.n, se = Math.sqrt(va + vb);
    var diff = a.mean - b.mean;
    if (!(se > 0)) return { diff: diff, se: 0, t: null, df: null, p: diff === 0 ? 1 : null, ci95: [diff, diff], d: null };
    var df = (va + vb) * (va + vb) / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1));
    var t = diff / se, tc = tCrit(0.95, df);
    var pooled = Math.sqrt(((a.n - 1) * a.var + (b.n - 1) * b.var) / (a.n + b.n - 2));
    return { diff: diff, se: se, t: t, df: df, p: tPValue(t, df), ci95: [diff - tc * se, diff + tc * se], d: pooled > 0 ? diff / pooled : null };
  }
  /* Benjamini–Hochberg: the q-value of each p, across EVERY test run together */
  function bh(ps) {
    var idx = ps.map(function (p, i) { return { p: p == null ? 1 : p, i: i }; }).sort(function (x, y) { return x.p - y.p; });
    var m = idx.length, q = new Array(m), min = 1;
    for (var k = m - 1; k >= 0; k--) { min = Math.min(min, idx[k].p * m / (k + 1)); q[idx[k].i] = Math.min(1, min); }
    return q;
  }

  /* ═══ 4. THE COACH ════════════════════════════════════════════════════ */
  var BANNED_WORDS = ['tilt', 'tilted', 'fomo', 'chasing', 'chase', 'addict', 'addiction', 'degenerate', 'stay disciplined', 'lock', 'guaranteed',
    'bet more', 'deposit', 'hot streak', 'due for', 'can\'t lose'];
  var LEVELS = ['OBSERVATION', 'DEVELOPING', 'SUPPORTED', 'STRONG_EVIDENCE'];
  var LEVEL_LABEL = { OBSERVATION: 'Observation', DEVELOPING: 'Developing', SUPPORTED: 'Supported', STRONG_EVIDENCE: 'Strong evidence' };
  var MIN = { observation: 10, developing: 30, strong: 100 };
  var METRICS = {
    ps: { label: 'process score', unit: 'points', process: true, idx: 6 },
    clv: { label: 'closing line value', unit: 'pct', process: true, idx: 3 },
    ret: { label: 'return per $1 staked', unit: 'pct', process: false, idx: 0 }
  };
  var DIM_LABEL = { platform: 'Platform', platform_type: 'Kind', sport: 'Sport', league: 'League', position_type: 'Market type', source: 'How it was recorded',
    timing: 'Timing', placed_dow: 'Day placed', event_dow: 'Event day', hour: 'Time of day placed', odds: 'Price range', units: 'Stake size',
    decision_source: 'Decision source', planned: 'Planned or not', after: 'After the previous result', session: 'Position within a session',
    repeat: 'Would you make it again', tag: 'Decision tag', sport_type: 'Sport and market', timing_type: 'Timing and market',
    platform_type_pos: 'Platform and market', evidence: 'What EdgeDesk knows', stake_type: 'Cash or bonus' };
  var DOW = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var KEY_LABEL = {
    odds: { HEAVY_FAVOURITE: 'Heavy favourites (under 1.50)', FAVOURITE: 'Favourites (1.50–1.90)', NEAR_EVEN: 'Near even (1.91–2.10)',
      UNDERDOG: 'Underdogs (2.11–2.99)', LONG: 'Long prices (3.00–4.99)', LONGSHOT: 'Longshots (5.00+)', UNKNOWN: 'Price unknown' },
    units: { UNDER_HALF: 'Under ½ unit', HALF_TO_ONE: '½ to 1 unit', ONE_TO_TWO: '1 to 2 units', OVER_TWO: 'Over 2 units', NO_UNIT: 'No unit on file' },
    hour: { NIGHT: 'Night (midnight–6am)', MORNING: 'Morning', AFTERNOON: 'Afternoon', EVENING: 'Evening', UNKNOWN: 'Unknown' },
    after: { AFTER_LOSS: 'Within 24h of a settled loss', AFTER_WIN: 'Within 24h of a settled win', AFTER_OTHER: 'Within 24h of a push or void',
      NONE: 'Nothing settled in the prior 24h' },
    session: { FIRST: 'First position of a session', SECOND_THIRD: '2nd–3rd in a session', FOURTH_PLUS: '4th or later in a session' },
    planned: { PLANNED: 'Planned', UNPLANNED: 'Unplanned', UNTAGGED: 'Not tagged' },
    repeat: { YES: '"Would make it again"', NO: '"Would not make it again"', UNSURE: '"Unsure"', UNREVIEWED: 'Not reviewed' },
    evidence: { FULL_CONTEXT: 'Full context', PARTIAL_CONTEXT: 'Partial context', RESULT_ONLY: 'Result only' },
    stake_type: { CASH: 'Cash stakes', BONUS: 'Bonus bets' },
    timing: TIMING_LABEL
  };
  function keyLabel(dim, key) {
    if (dim === 'placed_dow' || dim === 'event_dow') return DOW[+key] || 'Unknown';
    if (dim === 'tag') return TAG_LABEL[key] || (key === 'UNTAGGED' ? 'Untagged' : key);
    if (dim === 'timing_type') { var p = String(key).split(' · '); return (TIMING_LABEL[p[0]] || p[0]) + ' · ' + (E.POSITION_TYPE_LABEL[p[1]] || p[1]); }
    if (dim === 'position_type') return E.POSITION_TYPE_LABEL[key] || key;
    if (dim === 'sport_type' || dim === 'platform_type_pos') { var q = String(key).split(' · '); return (dim === 'platform_type_pos' ? E.platformLabel(q[0], q[0]) : q[0]) + ' · ' + (E.POSITION_TYPE_LABEL[q[1]] || q[1]); }
    if (dim === 'platform') return E.platformLabel(key, key);
    if (dim === 'platform_type') return key === 'SPORTSBOOK' ? 'Sportsbook' : 'Prediction market';
    return (KEY_LABEL[dim] && KEY_LABEL[dim][key]) || key;
  }
  /* the dimensions tested — fixed in advance (never chosen after looking) */
  var TESTED_DIMS = ['platform', 'sport', 'position_type', 'timing', 'placed_dow', 'hour', 'odds', 'units', 'planned', 'tag', 'after',
    'session', 'decision_source', 'sport_type', 'timing_type', 'platform_type_pos'];

  function cellMoments(row, metric, seg) {
    if (!row) return null;
    if (seg) {
      var a = row.segs && row.segs[seg]; if (!a) return null;
      var i = METRICS[metric].idx; return moments(a[i], a[i + 1], a[i + 2]);
    }
    if (metric === 'ps') return moments(row.ps_n, row.ps_sum, row.ps_sq);
    if (metric === 'clv') return moments(row.clv_n, row.clv_sum, row.clv_sq);
    return moments(row.ret_n, row.ret_sum, row.ret_sq);
  }
  function minus(all, part) {
    if (!all || !part) return null;
    var n = all.n - part.n; if (n < 2) return null;
    var sum = all.mean * all.n - part.mean * part.n;
    var sqA = all.var == null ? null : all.var * (all.n - 1) + all.n * all.mean * all.mean;
    var sqP = part.var == null ? part.mean * part.mean * part.n : part.var * (part.n - 1) + part.n * part.mean * part.mean;
    if (sqA == null) return null;
    return moments(n, sum, sqA - sqP);
  }
  function rowsBy(cells) {
    var m = {};
    (cells || []).forEach(function (r) { m[r.dim + '|' + r.key] = r; });
    return m;
  }

  /* every pre-specified test: each cell vs everything else, on each metric */
  function analyze(cells, opts) {
    opts = opts || {};
    var by = rowsBy(cells), all = by['all|all'];
    var tests = [];
    if (!all) return { tests: [], findings: [], total: 0, tested: 0 };
    (cells || []).forEach(function (r) {
      if (TESTED_DIMS.indexOf(r.dim) < 0) return;
      Object.keys(METRICS).forEach(function (metric) {
        var a = cellMoments(r, metric), A = cellMoments(all, metric), b = minus(A, a);
        if (!a || !b || a.n < MIN.observation || b.n < MIN.observation) return;
        var w = welch(a, b); if (!w || w.p == null) return;
        tests.push({ dim: r.dim, key: r.key, metric: metric, cell: a, comp: b, w: w, row: r });
      });
    });
    var q = bh(tests.map(function (t) { return t.w.p; }));
    tests.forEach(function (t, i) {
      t.q = q[i];
      var sign = Math.sign(t.w.diff);
      var h1a = cellMoments(t.row, t.metric, 'h1'), h1b = minus(cellMoments(all, t.metric, 'h1'), h1a);
      var h2a = cellMoments(t.row, t.metric, 'h2'), h2b = minus(cellMoments(all, t.metric, 'h2'), h2a);
      t.stable = !!(h1a && h1b && h2a && h2b && h1a.n >= 3 && h2a.n >= 3 && Math.sign(h1a.mean - h1b.mean) === sign && Math.sign(h2a.mean - h2b.mean) === sign);
      var hoa = cellMoments(t.row, t.metric, 'ho'), hob = minus(cellMoments(all, t.metric, 'ho'), hoa);
      t.holdout = !!(hoa && hob && hoa.n >= 5 && hob.n >= 5 && Math.sign(hoa.mean - hob.mean) === sign);
      var n = t.cell.n, d = Math.abs(t.w.d || 0), proc = METRICS[t.metric].process;
      var lvl = 'OBSERVATION';
      if (n >= MIN.developing && t.w.p < 0.10) lvl = 'DEVELOPING';
      if (lvl === 'DEVELOPING' && proc && t.q < 0.10 && d >= 0.2 && t.stable) lvl = 'SUPPORTED';
      if (lvl === 'SUPPORTED' && n >= MIN.strong && t.q < 0.05 && d >= 0.3 && t.holdout) lvl = 'STRONG_EVIDENCE';
      t.level = lvl;
      /* an OBSERVATION is noted only when the effect itself is not trivial */
      t.notable = lvl !== 'OBSERVATION' || d >= 0.3;
      t.direction = sign < 0 ? 'WORSE' : 'BETTER';
      /* an estimate of dollars, labelled as one: the difference in return (or
         in price captured) applied to the money staked in the cell */
      var staked = Number(t.row.staked) || 0;
      t.impact = t.metric === 'ps' ? null : t.w.diff * staked;
    });
    var findings = tests.filter(function (t) { return t.notable; }).map(function (t) { return toFinding(t, opts); });
    /* one finding per cell: its strongest metric, process metrics first */
    var seen = {}, out = [];
    findings.sort(function (x, y) { return rankOf(y) - rankOf(x); }).forEach(function (f) {
      var k = f.dim + '|' + f.key + '|' + f.direction; if (seen[k]) return; seen[k] = 1; out.push(f);
    });
    return { tests: tests, findings: out, total: all.n, tested: tests.length };
  }
  function rankOf(f) {
    return LEVELS.indexOf(f.level) * 1000 + (f.process ? 100 : 0) + Math.min(99, Math.abs(f.effect || 0) * 50 + Math.log10(1 + f.cell.n) * 10);
  }
  function fmtMetric(metric, v) {
    if (v == null || !isFinite(v)) return '—';
    if (metric === 'ps') return (v >= 0 ? '' : '−') + Math.abs(v).toFixed(1);
    return (v >= 0 ? '+' : '−') + Math.abs(100 * v).toFixed(2) + '%';
  }
  function toFinding(t, opts) {
    var m = METRICS[t.metric], lab = keyLabel(t.dim, t.key);
    var f = {
      id: t.dim + ':' + t.key + ':' + t.metric, kind: t.direction === 'WORSE' ? 'LEAK' : 'STRENGTH', direction: t.direction,
      dim: t.dim, key: t.key, label: (DIM_LABEL[t.dim] || t.dim) + ': ' + lab, metric: t.metric, metric_label: m.label, process: m.process,
      level: t.level, level_label: LEVEL_LABEL[t.level], cell: { n: t.cell.n, mean: t.cell.mean }, comparison: { n: t.comp.n, mean: t.comp.mean },
      diff: t.w.diff, ci95: t.w.ci95, p: t.w.p, q: t.q, effect: t.w.d, stable: t.stable, holdout: t.holdout, impact: t.impact,
      results_only: !m.process, group: groupFigures(t.row),
      period: opts.period || null
    };
    f.headline = lab + (f.kind === 'LEAK' ? ' — weaker ' : ' — stronger ') + m.label;
    f.text = lab + ' (' + t.cell.n + ' positions) averaged ' + fmtMetric(t.metric, t.cell.mean) + ' ' + m.label + ' against '
      + fmtMetric(t.metric, t.comp.mean) + ' for your other ' + t.comp.n + '. Difference ' + fmtMetric(t.metric, t.w.diff)
      + ' (95% interval ' + fmtMetric(t.metric, t.w.ci95[0]) + ' to ' + fmtMetric(t.metric, t.w.ci95[1]) + ').'
      + (f.results_only ? ' Results only: a profit difference this size could be variance; no process metric confirms it.' : '')
      + (t.stable ? ' It holds in both halves of the period.' : ' It does not hold in both halves of the period.');
    f.why = why(f, opts);
    return f;
  }
  /* the group's own figures for its WHY, straight from its cell: CLV only
     over the positions that have a closing price, never filled in */
  function groupFigures(r) {
    var clvN = +r.clv_n || 0;
    return { positions: +r.n || 0, settled: +r.settled || 0, pnl: r.pnl == null ? null : String(r.pnl), staked: r.staked == null ? null : String(r.staked),
      clv_n: clvN, clv_mean: clvN ? Number(r.clv_sum) / clvN : null };
  }
  function why(f, opts) {
    return {
      data_used: 'Positions placed in the period, by ' + (DIM_LABEL[f.dim] || f.dim).toLowerCase() + '; ' + f.metric_label + ' per position.',
      sample: f.cell.n + ' positions in the group; ' + f.comparison.n + ' in the comparison',
      period: f.period, comparison: 'Every other position placed in the same period',
      calculation: 'Welch two-sample t-test on the per-position ' + f.metric_label + '; 95% interval of the difference; Benjamini–Hochberg '
        + 'correction across all ' + (opts.tested || 'the') + ' tests run together; effect size (Cohen\'s d) '
        + (f.effect == null ? 'n/a' : f.effect.toFixed(2)) + '; p = ' + (f.p == null ? 'n/a' : f.p.toFixed(3)) + ', q = ' + (f.q == null ? 'n/a' : f.q.toFixed(3)) + '.',
      confidence: f.level_label + (f.stable ? '; same direction in both halves' : '; direction not stable across the period')
        + (f.holdout ? '; confirmed in the most recent 30%' : ''),
      limitations: (f.results_only ? 'A difference in results alone, with no process metric agreeing. ' : '')
        + 'An association in your own history, not a cause. The groups are not randomized.',
      positions: { dim: f.dim, key: f.key }, group: f.group
    };
  }
  /* what the Overview shows: the strongest supported strengths and leaks, or
     plainly that nothing has enough evidence yet */
  function headlines(result, opts) {
    opts = opts || {};
    var good = result.findings.filter(function (f) { return f.kind === 'STRENGTH' && LEVELS.indexOf(f.level) >= LEVELS.indexOf(opts.minLevel || 'DEVELOPING'); });
    var bad = result.findings.filter(function (f) { return f.kind === 'LEAK' && LEVELS.indexOf(f.level) >= LEVELS.indexOf(opts.minLevel || 'DEVELOPING'); });
    var need = Math.max(0, MIN.developing * 2 - (result.total || 0));
    return {
      working: good.slice(0, opts.limit || 3), not_working: bad.slice(0, opts.limit || 3),
      none_text: 'NO RELIABLE LEAK DETECTED',
      none_detail: (result.total || 0) + ' positions analysed with ' + result.tested + ' pre-specified tests. '
        + (need > 0 ? 'A group needs at least ' + MIN.developing + ' positions to be tested properly; about ' + need + ' more positions would let most groups qualify.'
          : 'None cleared the evidence bar after correcting for the number of tests.')
    };
  }

  /* the process-vs-outcome matrix from portfolio_summary().matrix */
  function matrix(m) {
    var rows = ['GOOD', 'AVERAGE', 'POOR', 'UNGRADED'], cols = ['WIN', 'LOSS', 'OTHER', 'OPEN'], out = { rows: rows, cols: cols, cells: {} };
    rows.forEach(function (r) { cols.forEach(function (c) { var x = (m || {})[r + ':' + c]; out.cells[r + ':' + c] = { n: x ? +x.n : 0, pnl: x ? x.pnl : null }; }); });
    out.badWins = out.cells['POOR:WIN'].n; out.goodLosses = out.cells['GOOD:LOSS'].n;
    return out;
  }
  /* how lucky: actual wins against what the prices implied (1 / decimal) */
  function variance(v) {
    if (!v || !(+v.n > 0)) return null;
    var sd = Math.sqrt(+v.var || 0), diff = (+v.wins) - (+v.expected_wins), z = sd > 0 ? diff / sd : null;
    return { n: +v.n, wins: +v.wins, expected: +v.expected_wins, diff: diff, z: z,
      text: 'Over ' + v.n + ' settled wins and losses you won ' + v.wins + '; the prices you took implied ' + (+v.expected_wins).toFixed(1)
        + ' (implied probability includes the book\'s margin). '
        + (z == null ? '' : Math.abs(z) < 1 ? 'That is within ordinary variance (z = ' + z.toFixed(2) + ').'
          : Math.abs(z) < 2 ? 'That is a modest run of ' + (z > 0 ? 'good' : 'bad') + ' results (z = ' + z.toFixed(2) + '), well within what chance produces.'
          : 'That is an unusual run of ' + (z > 0 ? 'good' : 'bad') + ' results (z = ' + z.toFixed(2) + '); results this far from expectation regress over time.') };
  }
  /* period vs period, on the process metrics, with intervals */
  function compare(cur, prev) {
    function ms(s, k) { var p = s && s.process; if (!p) return null; return k === 'ps' ? moments(p.graded, p.ps_sum, p.ps_sq) : moments(p.clv && p.clv.n, p.clv && p.clv.sum, p.clv && p.clv.sq); }
    var out = {};
    ['ps', 'clv'].forEach(function (k) {
      var a = ms(cur, k), b = ms(prev, k), w = a && b ? welch(a, b) : null;
      out[k] = { current: a, previous: b, test: w, enough: !!(a && b && a.n >= MIN.observation && b.n >= MIN.observation) };
    });
    return out;
  }
  /* an experiment, judged against its pre-registered metric */
  function evaluateExperiment(exp, windowCells, baseCells) {
    var key = exp.metric === 'CLV' ? 'clv' : exp.metric === 'PROCESS' ? 'ps' : 'ret';
    var W = rowsBy(windowCells)['all|all'], B = rowsBy(baseCells)['all|all'];
    var a = cellMoments(W, key), b = cellMoments(B, key);
    var cond = exp.condition || {}, adherence = null;
    if (cond.dim && cond.key && W) {
      var c = rowsBy(windowCells)[cond.dim + '|' + cond.key];
      adherence = W.n > 0 ? (c ? +c.n : 0) / +W.n : null;
    }
    var min = exp.min_sample || 20, ended = exp.status !== 'ACTIVE' || Date.parse(exp.ends_at) <= Date.now();
    if (!a || !b || a.n < min || b.n < min) {
      return { status: 'INCONCLUSIVE', reason: 'NEEDS_DATA', needed: Math.max(0, min - (a ? a.n : 0)), current: a, baseline: b, adherence: adherence,
        text: 'Not enough positions yet: ' + (a ? a.n : 0) + ' in the experiment window and ' + (b ? b.n : 0) + ' in the baseline; each needs ' + min + '.' };
    }
    var w = welch(a, b);
    var status = w && w.ci95[0] > 0 ? 'SUPPORTED' : w && w.ci95[1] < 0 ? 'NOT_SUPPORTED' : ended && w && w.diff <= 0 ? 'NOT_SUPPORTED' : 'INCONCLUSIVE';
    return { status: status, current: a, baseline: b, test: w, adherence: adherence, ended: ended,
      text: METRICS[key].label + ' averaged ' + fmtMetric(key, a.mean) + ' during the experiment (' + a.n + ' positions) against '
        + fmtMetric(key, b.mean) + ' before it (' + b.n + '). Difference ' + fmtMetric(key, w ? w.diff : null)
        + (w ? ' (95% interval ' + fmtMetric(key, w.ci95[0]) + ' to ' + fmtMetric(key, w.ci95[1]) + ')' : '') + '.'
        + (adherence == null ? '' : ' ' + Math.round(100 * adherence) + '% of positions in the window followed the change.') };
  }
  /* a historical counterfactual over the server's aggregates — always labelled */
  var COUNTERFACTUAL_LABEL = 'HISTORICAL COUNTERFACTUAL — NOT A FORECAST';
  function counterfactualWithout(cells, dim, key) {
    var by = rowsBy(cells), all = by['all|all'], c = by[dim + '|' + key];
    if (!all || !c) return null;
    return { label: COUNTERFACTUAL_LABEL, actual: +all.pnl, without: (+all.pnl) - (+c.pnl), removed: +c.settled, group: keyLabel(dim, key),
      text: 'Without the ' + c.settled + ' settled positions in "' + keyLabel(dim, key) + '", your P&L over this period would have been '
        + E.money(String((+all.pnl) - (+c.pnl)), { sign: true }) + ' instead of ' + E.money(String(all.pnl), { sign: true }) + '.' };
  }
  function counterfactualFlat(cells, unit) {
    var all = rowsBy(cells)['all|all'];
    if (!all || !(+unit > 0) || !(+all.ret_n > 0)) return null;
    var flat = (+all.ret_sum) * (+unit);
    return { label: COUNTERFACTUAL_LABEL, actual: +all.pnl, flat: flat, n: +all.ret_n,
      text: 'Staking a flat ' + E.money(String(unit)) + ' on each of your ' + all.ret_n + ' settled positions would have returned '
        + E.money(String(Math.round(flat * 100) / 100), { sign: true }) + ', against your actual ' + E.money(String(all.pnl), { sign: true }) + '.' };
  }
  /* a sentence is shippable only if it carries data and no banned word */
  function clean(text) {
    var t = String(text || '').toLowerCase();
    return !BANNED_WORDS.some(function (w) { return new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&') + '([^a-z]|$)').test(t); });
  }

  /* the evidence handed to an explanation layer: structured, complete, and
     the only thing it may speak from (it may not compute anything new) */
  function evidencePacket(f) {
    return { finding: f.label, level: f.level, metric: f.metric_label, cell: f.cell, comparison: f.comparison, diff: f.diff, ci95: f.ci95,
      p: f.p, q: f.q, effect_size: f.effect, stable: f.stable, holdout: f.holdout, period: f.period, results_only: f.results_only,
      rules: ['Use only these numbers.', 'Do not claim a cause.', 'Do not describe the reader\'s feelings or label their behaviour.',
        'Never recommend betting more, larger stakes, deposits, or acting on a promotion.'] };
  }

  return {
    leadSeconds: leadSeconds, timingBucket: timingBucket, TIMING_LABEL: TIMING_LABEL, oddsBand: oddsBand, unitsBand: unitsBand, hourBand: hourBand,
    ouDirection: ouDirection, lineGain: lineGain, clamp: clamp, clvPct: clvPct, scoreClv: scoreClv, modelEv: modelEv, scoreModel: scoreModel,
    priceSlip: priceSlip, scorePrice: scorePrice, scoreTiming: scoreTiming, scoreSizing: scoreSizing, scoreMarket: scoreMarket,
    WEIGHTS: WEIGHTS, COMPONENTS: COMPONENTS, COMPONENT_LABEL: COMPONENT_LABEL, processWeight: processWeight, processScore: processScore,
    gradeLetter: gradeLetter, confidence: confidence, CONFIDENCE_TEXT: CONFIDENCE_TEXT, processBand: processBand, ruleVerdict: ruleVerdict,
    RULE_KINDS: RULE_KINDS, DECISION_TAGS: DECISION_TAGS, TAG_LABEL: TAG_LABEL, gradePosition: gradePosition,
    moments: moments, welch: welch, tPValue: tPValue, tCrit: tCrit, bh: bh,
    BANNED_WORDS: BANNED_WORDS, LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL, MIN: MIN, METRICS: METRICS, DIM_LABEL: DIM_LABEL, TESTED_DIMS: TESTED_DIMS,
    keyLabel: keyLabel, analyze: analyze, headlines: headlines, matrix: matrix, variance: variance, compare: compare,
    evaluateExperiment: evaluateExperiment, COUNTERFACTUAL_LABEL: COUNTERFACTUAL_LABEL, counterfactualWithout: counterfactualWithout,
    counterfactualFlat: counterfactualFlat, clean: clean, evidencePacket: evidencePacket, fmtMetric: fmtMetric
  };
}));
