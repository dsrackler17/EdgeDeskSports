/* ===========================================================================
   EdgeDesk RESEARCH GRADE — an A–F letter for the QUALITY and RELIABILITY of
   EdgeDesk's pregame research on one game. docs/research-grade/METHODOLOGY.md

   ONE FILE, Node and browser (UMD, root.EDGRADE). Pure: no clock, no network,
   no file. The hourly performance job (tools/performance/) grades every
   upcoming game with it and locks each grade in an append-only ledger before
   kickoff; the research boards, the game view and /performance/grades/ read
   what it wrote and filter with the same functions.

   WHAT A GRADE IS
     A deterministic 0–100 score from five dimensions, each built from named
     sub-factors whose every point is earned from data on file before kickoff:
       reliability   30   the model's own pregame track record (Brier skill,
                          calibration) and its walk-forward validation state
       completeness  25   model outputs present, build freshness, the engine's
                          own input-quality measure, source authority
       market        20   a named-book line captured before kickoff, its age,
                          and how far EdgeDesk's number sits from it
       clarity       15   key-role availability, how far one absence moves the
                          number, itemised matchup factors, a confirmed start
       uncertainty   10   game-specific model spread, calibration band,
                          season stage
     The weights are PROVISIONAL (WEIGHTS_VERSION). They are a starting
     configuration, not a validated finding: no claim is made that a higher
     grade wins more often until /performance/grades/ shows it.

   WHAT A GRADE IS NOT
     Not a win probability, not a prediction of who wins, not a pick and not
     a betting recommendation. Research, not picks.

   THE RULES IT ENFORCES
     - Nothing missing earns credit. A sub-factor with no data scores 0 and is
       listed with the reason; only a question that does not arise for the
       sport (a puck line is not a margin) leaves the denominator.
     - Two kinds of evidence are EXCLUDED AND CAPPED rather than zeroed, as the
       methodology specifies: an unvalidated live track record (its two
       sub-factors leave the reliability denominator; the grade is capped at
       C) and a missing pregame market line (the market dimension leaves the
       total; the grade is capped at B). Excluded is never credited: the
       breakdown shows it as excluded, and the cap is the price.
     - Caps that no weight can lift: an unvalidated live track record caps the
       grade at C, an early one at B; no pregame market line caps it at B; an
       unknown key-role availability caps it at C.
     - Gates: no model output, a model built or seen after kickoff, an expired
       build, an invalidated projection, a market-fed model, a research state
       of DATA_INSUFFICIENT or a completeness below the floor → INSUFFICIENT
       DATA, no letter.
     - No look-ahead. The track record is read as of the grade's own time
       (games started and graded before it); a quote captured at or after the
       start, or after the grade's time, is dropped.
     - Reproducible. A snapshot stores its normalised inputs; score(inputs,
       its version's config) returns the same grade, byte for byte.
   =========================================================================== */
(function (root, factory) {
  var PERF = null;
  if (typeof module === 'object' && module && module.exports) {
    try { PERF = require('./edgedesk_performance.js'); } catch (_) { PERF = null; }
    module.exports = factory(PERF);
  } else {
    root.EDGRADE = factory(root.EDPERF || null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PERF) {
  'use strict';

  var VERSION = 'edgedesk_research_grade_v1';
  var SNAPSHOT_SCHEMA = 'edgedesk_research_grade_snapshot_v1';
  var OUTCOME_SCHEMA = 'edgedesk_research_grade_outcome_v1';
  /* the A–F scale, inclusive lower bounds on the rounded integer score */
  var LETTERS = [['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]];
  var LETTER_IDS = ['A', 'B', 'C', 'D', 'F'];
  var INSUFFICIENT = 'INSUFFICIENT';
  var RESCHEDULE_HOURS = 36;
  var MIN_N = PERF ? PERF.MIN_N : 20;
  var Z95 = 1.959964;

  /* ------------------------------------------------------- configuration */
  /* One config per grade version. A scoring change is a NEW version, never an
     edit: every stored snapshot names its version and must still reproduce. */
  var CONFIGS = {
    rg_v1: {
      grade_version: 'rg_v1',
      weights_version: 'w1-provisional-2026-10',
      weights: { reliability: 30, completeness: 25, market: 20, clarity: 15, uncertainty: 10 },
      sub: {
        reliability: { live_skill: 0.45, live_calibration: 0.25, walk_forward: 0.30 },
        completeness: { model_outputs: 0.30, build_freshness: 0.25, input_data: 0.30, provenance: 0.15 },
        market: { quote_age: 0.20, spread_agreement: 0.35, total_agreement: 0.20, moneyline_agreement: 0.25 },
        clarity: { key_role: 0.40, sensitivity: 0.25, explanation: 0.20, start_time: 0.15 },
        uncertainty: { model_spread: 0.40, calibration_band: 0.35, season_stage: 0.25 }
      },
      caps: { CALIBRATION_UNVALIDATED: 79, CALIBRATION_EARLY_SIGNAL: 89, NO_PREGAME_MARKET: 89, KEY_ROLE_UNKNOWN: 79 },
      completeness_floor: 40,
      /* at least this much of the weight must stand on evidence (only the market dimension can leave the total) */
      min_included_weight: 60,
      /* the live track record needs this many scored games (EDCALIB's EARLY_SIGNAL band) */
      track_min_n: 50, track_full_n: 200,
      /* the coin-flip Brier score: the "no skill" end of every sport's band */
      brier_none: 0.25, ece_zero: 0.05
    }
  };
  var DEFAULT_VERSION = 'rg_v1';
  function configFor(v) { return CONFIGS[v || DEFAULT_VERSION] || null; }

  var DIMENSIONS = [
    { id: 'reliability', label: 'Model reliability & calibration' },
    { id: 'completeness', label: 'Data completeness' },
    { id: 'market', label: 'Model–market comparison' },
    { id: 'clarity', label: 'Matchup clarity' },
    { id: 'uncertainty', label: 'Uncertainty' }
  ];
  var SUB_LABEL = {
    live_skill: 'Live pregame record: Brier skill', live_calibration: 'Live pregame record: calibration', walk_forward: 'Walk-forward validation (retrospective)',
    model_outputs: 'Model outputs present', build_freshness: 'Model build freshness', input_data: 'Engine input quality', provenance: 'Source authority',
    quote_age: 'Market line age', spread_agreement: 'Spread vs market', total_agreement: 'Total vs market', moneyline_agreement: 'Win probability vs market',
    key_role: 'Key-role availability', sensitivity: 'Sensitivity to one absence', explanation: 'Itemised matchup factors', start_time: 'Start time confirmed',
    model_spread: 'Model disagreement / stability', calibration_band: 'Calibration band', season_stage: 'Season stage'
  };

  /* ----------------------------------------------------- sport adapters */
  /* Each sport says which model outputs it is expected to publish, the
     scale on which a model–market gap is judged (tol: a gap this small is
     agreement; scale: a gap this large earns nothing), the Brier score a
     liquid closing market roughly achieves in the sport (brier_good — a
     provisional reference point, not a validated benchmark), whether key-role
     availability is modelled at all, and how to read the engine's own
     input-quality measure. A null scale means the comparison does not arise. */
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  var SPORTS = {
    nfl: { label: 'NFL', outputs: ['p_home', 'margin', 'total'], brier_good: 0.205, spread: [1, 7], total: [1.5, 8], ml: [0.02, 0.15], availability_modelled: true, data: 'nfl' },
    cfb: { label: 'College football (FBS)', outputs: ['p_home', 'margin', 'total'], brier_good: 0.145, spread: [1.5, 10], total: [2, 10], ml: [0.02, 0.15], availability_modelled: true, data: 'cfb' },
    nba: { label: 'NBA', outputs: ['p_home', 'margin', 'total', 'margin_sd'], brier_good: 0.205, spread: [1, 7], total: [2, 10], ml: [0.02, 0.15], availability_modelled: true, data: 'nba' },
    /* the NHL publishes no margin: its "spread" is a priced ±1.5 puck line, not EdgeDesk's margin */
    nhl: { label: 'NHL', outputs: ['p_home', 'total'], brier_good: 0.235, spread: null, total: [0.25, 1.0], ml: [0.02, 0.12], availability_modelled: true, data: 'nhl' },
    wnba: { label: 'WNBA', outputs: ['p_home', 'margin', 'total'], brier_good: 0.205, spread: [1, 7], total: [2, 10], ml: [0.02, 0.15], availability_modelled: false, data: 'lab' },
    ncaab_m: { label: 'Men\'s college basketball', outputs: ['p_home', 'margin', 'total'], brier_good: 0.175, spread: [1.5, 9], total: [2.5, 12], ml: [0.02, 0.15], availability_modelled: false, data: 'lab' },
    ncaab_w: { label: 'Women\'s college basketball', outputs: ['p_home', 'margin', 'total'], brier_good: 0.175, spread: [1.5, 9], total: [2.5, 12], ml: [0.02, 0.15], availability_modelled: false, data: 'lab' }
  };

  /* Per-sport readers. Each reads the projection (p) and, where the job hands
     it in, the sport's own artifact row for the game (x: football/fbs/slate.json,
     football/nfl/slate.json or hockey/slate.json) — measures the cross-sport
     contract does not carry. Each returns null when the sport publishes no
     such measure: null is "missing" (no credit), never a default.
       data(p, x)      the engine's own input-quality measure → { score 0–100, kind, detail }
       stability(p, x) a game-specific stability measure in points → { sd_pts, tier, flip_rate }
       early(p, x)     whether ratings are early-season → true | false | null */
  function weekOf(p, x) {
    var w = num(obj(x).week);
    if (w != null) return w;
    var m = /^\d{4}_(\d{2})_/.exec(str(p.event_id));
    return m ? +m[1] : null;
  }
  function flagEarly(p) {
    var u = obj(p.uncertainty);
    if (u.early_season === true || u.early_season === false) return u.early_season;
    return (p.limitations || []).some(function (x) { return /early season/i.test(String(x)); }) ? true : null;
  }
  var READERS = {
    /* CFB: lib/cfb_reliability.js's per-game 0–100 score (team data, roster, stability, freshness,
       source integrity, environment), the engine's published data_completeness as a fallback;
       stability from the slate's own perturbation of the projection (cfb_reliability.stability) */
    cfb: {
      data: function (p) {
        var m = obj(obj(p.matchup).metrics), rs = num(m.reliability_score);
        if (rs != null) return { score: r1(Math.max(0, Math.min(100, rs))), kind: 'cfb_reliability', detail: 'CFB reliability ' + Math.round(rs) + '/100' + (m.reliability_grade ? ' (' + String(m.reliability_grade).toLowerCase().replace(/_/g, ' ') + ')' : '') };
        var dc = num(obj(p.freshness).data_completeness);
        if (dc != null) return { score: r1(clamp01(dc) * 100), kind: 'data_completeness', detail: 'engine data completeness ' + Math.round(dc * 100) + '%' };
        return null;
      },
      stability: function (p, x) {
        var s = obj(obj(x).projection_stability);
        return num(s.projection_stability_sd) == null ? null : { sd_pts: num(s.projection_stability_sd), tier: s.tier || null, flip_rate: num(s.favorite_flip_rate) };
      },
      early: function (p, x) { var w = weekOf(p, x); return w == null ? null : w <= 3; }
    },
    /* NFL: the slate's own data-quality block (missing inputs and warnings) */
    nfl: {
      data: function (p, x) {
        var dq = obj(obj(x).data_quality);
        var w = Array.isArray(dq.warnings) || Array.isArray(dq.missing) ? (dq.warnings || []).length + (dq.missing || []).length
          : (p.invalidators || []).filter(function (y) { return !/^A quarterback change/i.test(String(y)); }).length;
        return { score: Math.max(0, 100 - 20 * w), kind: 'data_quality', detail: w ? w + ' data-quality warning' + (w > 1 ? 's' : '') + ' on the slate' : 'no data-quality warnings on the slate' };
      },
      stability: function () { return null; },
      early: function (p, x) { var w = weekOf(p, x); return w == null ? null : w <= 3; }
    },
    /* NHL: the input data state (results feed current or lagging); early season from the slate */
    nhl: {
      data: function (p) {
        var ds = obj(p.freshness).data_state;
        if (!ds) return null;
        return { score: ds === 'FRESH' ? 100 : 30, kind: 'data_state', detail: 'results feed ' + String(ds).toLowerCase() };
      },
      stability: function () { return null; },
      early: function (p, x) { var e = obj(obj(x).data_quality).early_season; return e === true || e === false ? e : flagEarly(p); }
    },
    /* NBA: a rotation carried from an old game is the largest known input gap */
    nba: {
      data: function (p) {
        var u = obj(p.uncertainty);
        if (u.rotation_stale == null) return null;
        return { score: u.rotation_stale ? 55 : 100, kind: 'rotation', detail: u.rotation_stale ? 'rotation carried from an old game (no confirmed lineup)' : 'rotation from a recent game' };
      },
      stability: function () { return null; },
      early: function (p) { return flagEarly(p); }
    },
    /* the lab engine (WNBA, college basketball) publishes no input-quality measure; early season
       when either side has played fewer than 10 games (the NBA engine's own definition) */
    lab: {
      data: function () { return null; },
      stability: function () { return null; },
      early: function (p) {
        var g = obj(obj(obj(p.matchup).metrics).games_this_season), h = num(g.home), a = num(g.away);
        if (h == null || a == null) return flagEarly(p);
        return Math.min(h, a) < 10;
      }
    }
  };

  /* ------------------------------------------------------------ helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function isoOf(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function obj(v) { return v && typeof v === 'object' ? v : {}; }
  function str(v) { return v == null ? '' : String(v); }
  function rk(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k); return Math.round(v * f) / f; }
  function r1(v) { return rk(v, 1); }
  function r4(v) { return rk(v, 4); }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function impliedOf(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  function profitPerUnit(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? a / 100 : 100 / -a; }
  function wilson(k, n) {
    if (PERF && PERF.wilson) return PERF.wilson(k, n);
    if (!n) return { low: null, high: null };
    var p = k / n, z2 = Z95 * Z95, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den, h = Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
  }
  function sampleState(n) { return PERF ? PERF.sampleState(n) : n >= 500 ? 'MEANINGFUL' : n >= 200 ? 'DEVELOPING' : n >= 50 ? 'EARLY_SIGNAL' : 'TOO_EARLY'; }
  function familyOf(id) { return id == null ? null : String(id).split(':')[0]; }
  /* gap ≤ tol → 100, gap ≥ scale → 0, linear between */
  function agreement(gap, band) { if (gap == null || !band) return null; var tol = band[0], sc = band[1]; return r1(100 * clamp01(1 - (gap - tol) / (sc - tol))); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function fmtPts(v) { return v == null ? '?' : (Math.round(v * 10) / 10).toString(); }
  function hrs(h) { if (h == null) return 'an unknown time'; if (h < 1) return Math.max(1, Math.round(h * 60)) + ' min'; if (h < 48) return (Math.round(h * 10) / 10) + ' h'; return (Math.round(h / 24 * 10) / 10) + ' days'; }

  /** The integer score: the raw score to the nearest integer, half up, once (89.5 → 90, 89.49 → 89).
      The 1e-6 pre-rounding only absorbs floating-point drift (79.9499999999 is 79.95), never a real decimal. */
  function roundScore(raw) { var x = num(raw); if (x == null) return null; return Math.round(Math.round(x * 1e6) / 1e6); }
  function letterOf(score) {
    var s = num(score);
    if (s == null) return null;
    for (var i = 0; i < LETTERS.length; i++) if (s >= LETTERS[i][1]) return LETTERS[i][0];
    return 'F';
  }
  function capLetter(cap) { return letterOf(cap); }

  /* ------------------------------------------------------- track record */
  /**
   * The model family's own live pregame record AS OF a moment: only games
   * that started before it and whose grade was written at or before it.
   * rows: [{ event_key, sport, family, start_utc, graded_at, revision, eligible, p_home, outcome (1 | 0 | 'push'), tier }]
   * A game regraded later counts once, as its latest revision written by then.
   */
  function trackRecord(rows, q) {
    q = q || {};
    var asOf = toMs(q.as_of);
    /* one row per game: its latest grade revision written by the as-of moment */
    var latestBy = {};
    (rows || []).forEach(function (x) {
      if (!x || x.sport !== q.sport) return;
      if (q.family != null && x.family !== q.family) return;
      var st = toMs(x.start_utc), ga = toMs(x.graded_at);
      if (asOf == null || st == null || ga == null || st >= asOf || ga > asOf) return;
      var k = x.event_key || (x.sport + '|' + x.start_utc + '|' + x.p_home);
      var prev = latestBy[k];
      if (!prev || toMs(prev.graded_at) < ga || (toMs(prev.graded_at) === ga && (prev.revision || 0) < (x.revision || 0))) latestBy[k] = x;
    });
    var list = Object.keys(latestBy).sort().map(function (k) { return latestBy[k]; })
      .filter(function (x) { return x.eligible !== false && num(x.p_home) != null && (x.outcome === 1 || x.outcome === 0); });
    var n = list.length;
    var out = { sport: q.sport, family: q.family || null, as_of: isoOf(asOf), n: n, sample_state: sampleState(n), brier: null, ece: null, ece_excess: null,
      verified_n: list.filter(function (x) { return x.tier === 'VERIFIED'; }).length, recorded_n: list.filter(function (x) { return x.tier !== 'VERIFIED'; }).length, through: null };
    if (!n) return out;
    out.brier = r4(mean(list.map(function (x) { var p = num(x.p_home); return (p - x.outcome) * (p - x.outcome); })));
    /* calibration over the ten buckets /performance/ charts. ece: the mean gap between
       predicted and observed, weighted by count. ece_excess: only the part of each gap
       that falls OUTSIDE the bucket's Wilson 95% interval — what sampling noise in a
       small bucket cannot explain. The grade reads the excess; both are stored. */
    var ece = 0, excess = 0;
    for (var b = 0; b < 10; b++) {
      var lo = b / 10, hi = b === 9 ? 1.0000001 : (b + 1) / 10;
      var B = list.filter(function (x) { var p = num(x.p_home); return p >= lo && p < hi; });
      if (!B.length) continue;
      var mp = mean(B.map(function (x) { return num(x.p_home); })), k = B.reduce(function (s0, x) { return s0 + x.outcome; }, 0);
      ece += (B.length / n) * Math.abs(mp - k / B.length);
      var w = wilson(k, B.length);
      excess += (B.length / n) * (mp < w.low ? w.low - mp : mp > w.high ? mp - w.high : 0);
    }
    out.ece = r4(ece);
    out.ece_excess = r4(excess);
    out.through = isoOf(Math.max.apply(null, list.map(function (x) { return toMs(x.start_utc); })));
    return out;
  }

  /* ---------------------------------------------------------- normalise */
  /**
   * One projection (lib/edgedesk_projections.js contract) + context → the
   * normalised inputs every score is computed from (and stored with it).
   * ctx: { as_of, quote (EDPERF.quoteFromSlate shape) | null, quote_status,
   *        time_tbd (from the scoreboard) | null, track (trackRecord()) | null }
   */
  function normalize(p, ctx) {
    ctx = ctx || {};
    p = p || {};
    var sp = SPORTS[p.sport] || null;
    var asOf = toMs(ctx.as_of), start = toMs(p.start_utc);
    var m = obj(p.model), o = obj(p.outcome), fair = obj(p.fair), ps = obj(p.projected_score), u = obj(p.uncertainty), fr = obj(p.freshness), av = obj(p.availability);
    var margin = num(obj(fair.spread).home_line) != null ? -num(fair.spread.home_line) : num(ps.margin);
    var total = num(obj(fair.total).expected) != null ? num(fair.total.expected) : p.sport === 'nhl' ? num(ps.total) : num(obj(fair.total).line) != null ? num(fair.total.line) : num(ps.total);
    var flags = [];

    /* the market line: only one captured before the start AND by the grade's own time */
    var q = ctx.quote || null, qStatus = ctx.quote_status || (q ? 'CAPTURED' : 'NO_QUOTE');
    if (q) {
      var qc = toMs(q.captured_at);
      if (qc == null || start == null || qc >= start || (asOf != null && qc > asOf)) { q = null; qStatus = 'REFUSED_NOT_PREGAME'; flags.push('LEAKAGE_GUARD_QUOTE_DROPPED'); }
    }
    var quote = { status: q ? 'CAPTURED' : qStatus };
    if (q) {
      var spq = obj(q.spread), tq = obj(q.total), mlq = obj(q.moneyline);
      quote.book = q.book || null; quote.source = q.source || null; quote.captured_at = isoOf(q.captured_at);
      quote.age_hours = asOf != null ? r1((asOf - toMs(q.captured_at)) / 3600e3) : null;
      quote.spread_home = num(spq.home_point); quote.spread_home_price = num(spq.home_price); quote.spread_away_price = num(spq.away_price);
      quote.total = num(tq.point); quote.over = num(tq.over); quote.under = num(tq.under);
      quote.ml_home = num(mlq.home); quote.ml_away = num(mlq.away);
    }

    var sens = (p.sensitivity || []).map(function (x) {
      if (num(x.delta_p_home) != null) return Math.abs(num(x.delta_p_home));
      if (Array.isArray(x.range_p_home) && x.range_p_home.length === 2) return Math.abs(num(x.range_p_home[1]) - num(x.range_p_home[0]));
      if (num(x.p_home) != null && num(o.p_home) != null) return Math.abs(num(x.p_home) - num(o.p_home));
      return null;
    }).filter(function (x) { return x != null; });
    var basis = str(u.basis);
    var sdMeasured = num(u.model_sd) != null && !/model_sd:\s*the board default|board defaults/i.test(basis);
    var auths = (p.provenance || []).filter(function (x) { return x && x.authority && x.authority !== 'EDGEDESK_MODEL'; }).map(function (x) { return x.authority; });
    var RANK = { OFFICIAL: 0, THIRD_PARTY_MIRROR: 1, THIRD_PARTY: 2, UNVERIFIED_SOURCE: 3 };
    var weakest = auths.length ? auths.slice().sort(function (a, b) { return (RANK[b] == null ? 9 : RANK[b]) - (RANK[a] == null ? 9 : RANK[a]); })[0] : null;
    var val = obj(obj(obj(p.validation).markets).moneyline);
    var RD = sp ? READERS[sp.data] : null, x = ctx.extra || null;
    var dataRead = RD ? RD.data(p, x) : null;
    var stab = RD ? RD.stability(p, x) : null;
    var early = RD ? RD.early(p, x) : null;
    /* the start time: to be announced if either the scoreboard or the sport's own slate says so */
    var tbds = [ctx.time_tbd, x ? x.kickoff_tbd : null].filter(function (v) { return v === true || v === false; });
    var tbd = tbds.length ? tbds.indexOf(true) >= 0 : null;
    var factors = (obj(p.matchup).factors || []).length, metrics = Object.keys(obj(obj(p.matchup).metrics)).length;
    var track = ctx.track || null;

    return {
      v: 1, sport: p.sport || null, event_key: p.event_key || null, start_utc: isoOf(p.start_utc), as_of: isoOf(asOf),
      model: { id: m.id || null, family: familyOf(m.id), version: m.version || null, predicted_at: isoOf(m.predicted_at), inputs_known_at: m.inputs_known_at || null,
        independent: m.kind === 'INDEPENDENT' && Array.isArray(m.market_inputs) && m.market_inputs.length === 0 },
      research: { outcome: obj(p.research).outcome || null, reasons: (obj(p.research).reasons || []).slice(0, 1).map(function (x) { return str(x).slice(0, 160); }) },
      integrity: { invalidated: !!obj(p.integrity).invalidated, conflicts: (obj(p.integrity).conflicts || []).length },
      freshness: { state: fr.state || null, age_hours: num(fr.age_hours), max_age_hours: num(fr.max_age_hours), data_state: fr.data_state || null },
      outputs: { p_home: num(o.p_home), margin: margin == null ? null : rk(margin, 2), total: total == null ? null : rk(total, 2), margin_sd: num(u.margin_sd),
        fair_total: num(obj(fair.total).line) },
      data: dataRead,
      provenance: { authority: weakest, sources: auths.length },
      validation: { market: 'moneyline', state: val.state || null, n: num(val.n) },
      track: track ? { n: track.n, brier: track.brier, ece: track.ece, ece_excess: track.ece_excess, sample_state: track.sample_state, family: track.family, verified_n: track.verified_n, recorded_n: track.recorded_n, through: track.through } : null,
      quote: quote,
      availability: { key_role: av.key_role || null, certainty: av.certainty || null, modelled: sp ? !!sp.availability_modelled : false },
      sensitivity: { n: sens.length, max_dp: sens.length ? r4(Math.max.apply(null, sens)) : null },
      matchup: { factors: factors, metrics: metrics },
      schedule: { time_tbd: tbd },
      uncertainty: { model_sd: num(u.model_sd), model_sd_measured: !!sdMeasured, calibration_sd: num(u.calibration_sd), early_season: early,
        stability: stab ? { sd_pts: r4(stab.sd_pts), tier: stab.tier, flip_rate: stab.flip_rate == null ? null : r4(stab.flip_rate) } : null },
      flags: flags
    };
  }

  /* -------------------------------------------------------------- score */
  function sub(id, status, score, detail) { return { id: id, label: SUB_LABEL[id], status: status, score: score == null ? null : r1(score), detail: detail }; }
  function ok(id, score, detail) { return sub(id, 'ok', score, detail); }
  function missing(id, detail, status) { return sub(id, status || 'unavailable', null, detail); }
  function na(id, detail) { return sub(id, 'n/a', null, detail); }

  function dimReliability(I, cfg, sp) {
    var t = I.track, out = [];
    var enough = t && t.n >= cfg.track_min_n;
    var tierNote = t ? ' (' + t.verified_n + ' ledger-verified, ' + t.recorded_n + ' recorded pregame)' : '';
    if (!t || !t.n) {
      out.push(missing('live_skill', 'no graded pregame forecasts from this model yet', 'unvalidated'));
      out.push(missing('live_calibration', 'no graded pregame forecasts from this model yet', 'unvalidated'));
    } else if (!enough) {
      out.push(missing('live_skill', plural(t.n, 'graded pregame game') + tierNote + '; ' + cfg.track_min_n + ' are needed before its record counts', 'unvalidated'));
      out.push(missing('live_calibration', 'calibration is unvalidated below ' + cfg.track_min_n + ' graded games', 'unvalidated'));
    } else {
      var good = sp ? sp.brier_good : 0.2;
      var skill = 100 * clamp01((cfg.brier_none - t.brier) / (cfg.brier_none - good));
      out.push(ok('live_skill', skill, 'Brier ' + t.brier + ' over ' + plural(t.n, 'graded pregame game') + tierNote + ' (0.25 is a coin flip; about ' + good + ' is a liquid market)'));
      out.push(ok('live_calibration', 100 * clamp01(1 - t.ece_excess / cfg.ece_zero), t.ece_excess > 0 ? 'probabilities sit ' + rk(t.ece_excess * 100, 1) + ' points outside the observed rates\' 95% intervals on average (' + rk(t.ece * 100, 1) + ' points off in all)' : 'every probability bucket sits inside its observed rate\'s 95% interval (' + rk(t.ece * 100, 1) + ' points off on average, within sampling noise)'));
    }
    var WF = { MARKET_VALIDATED: 100, OUTCOME_VALIDATED: 75, EXPERIMENTAL: 40, RESEARCH_ONLY: 15 };
    var st = I.validation.state;
    if (st && WF[st] != null) out.push(ok('walk_forward', WF[st], 'moneyline ' + st.toLowerCase().replace(/_/g, ' ') + ' in walk-forward testing' + (I.validation.n ? ' (n=' + I.validation.n + ')' : '') + ' — retrospective, not the live record'));
    else out.push(missing('walk_forward', 'no walk-forward validation record for the moneyline'));
    return { items: out, status: !t || !t.n || !enough ? 'partial' : null };
  }

  function dimCompleteness(I, cfg, sp) {
    var out = [];
    var need = sp ? sp.outputs : ['p_home'];
    var have = need.filter(function (k) { return I.outputs[k] != null; });
    var lacking = need.filter(function (k) { return I.outputs[k] == null; });
    out.push(ok('model_outputs', 100 * have.length / need.length, have.length === need.length ? 'every expected output published (' + need.join(', ').replace(/_/g, ' ') + ')' : 'missing ' + lacking.join(', ').replace(/_/g, ' ')));
    var a = I.freshness.age_hours, mx = I.freshness.max_age_hours;
    if (a == null || mx == null || !(mx > 0)) out.push(missing('build_freshness', 'the model build time is unknown'));
    else {
      var ratio = a / mx;
      var s = ratio <= 0.25 ? 100 : ratio <= 0.5 ? 80 : ratio <= 0.75 ? 55 : ratio <= 1 ? 30 : 0;
      out.push(ok('build_freshness', s, 'model built ' + hrs(a) + ' ago (limit ' + mx + ' h)'));
    }
    if (I.data && I.data.score != null) out.push(ok('input_data', I.data.score, I.data.detail));
    else out.push(missing('input_data', 'the engine publishes no input-quality measure for this sport'));
    var AU = { OFFICIAL: 100, THIRD_PARTY_MIRROR: 90, THIRD_PARTY: 80, UNVERIFIED_SOURCE: 40 };
    if (I.provenance.authority && AU[I.provenance.authority] != null) out.push(ok('provenance', AU[I.provenance.authority], 'weakest data source: ' + I.provenance.authority.toLowerCase().replace(/_/g, ' ')));
    else out.push(missing('provenance', 'no data source is named for the inputs'));
    return { items: out };
  }

  var QUOTE_WHY = {
    NO_SLATE: 'the scoreboard feed that carries the sportsbook line could not be read (odds provider unavailable)',
    SLATE_STALE: 'the scoreboard feed that carries the sportsbook line is stale (odds provider not updating)',
    NOT_ON_SLATE: 'the game is not on the scoreboard feed that carries sportsbook lines',
    UNMATCHED: 'the game could not be matched to the scoreboard feed',
    AMBIGUOUS: 'the game matched more than one scoreboard event, so no line is attached',
    SWAPPED_HOME_AWAY: 'the scoreboard lists home and away the other way round, so no line is attached',
    NO_QUOTE: 'no named-book line has been captured for this game',
    REFUSED_NOT_PREGAME: 'the only line on file was captured after the start or after this grade, so it is not used'
  };
  function quoteWhy(s) { return QUOTE_WHY[s] || 'no named-book line was captured before kickoff (' + String(s).toLowerCase().replace(/_/g, ' ') + ')'; }

  function dimMarket(I, cfg, sp) {
    var q = I.quote, out = [];
    if (q.status !== 'CAPTURED') {
      var why = quoteWhy(q.status);
      ['quote_age', 'spread_agreement', 'total_agreement', 'moneyline_agreement'].forEach(function (k) {
        if (k === 'spread_agreement' && sp && !sp.spread) out.push(na(k, 'this sport publishes no margin to compare with a spread'));
        else out.push(missing(k, why, 'excluded'));
      });
      return { items: out, status: 'excluded' };
    }
    if (!sp) {
      ['quote_age', 'spread_agreement', 'total_agreement', 'moneyline_agreement'].forEach(function (k) { out.push(missing(k, 'no grading adapter for this sport')); });
      return { items: out };
    }
    var a = q.age_hours;
    out.push(a == null ? missing('quote_age', 'the line has no capture time') : ok('quote_age', a <= 3 ? 100 : a <= 8 ? 80 : a <= 24 ? 50 : a <= 48 ? 20 : 0, q.book + ' line captured ' + hrs(a) + ' before this grade'));
    if (sp && !sp.spread) out.push(na('spread_agreement', 'this sport publishes no margin (the puck line is a priced ±1.5, not a margin)'));
    else if (I.outputs.margin == null) out.push(missing('spread_agreement', 'EdgeDesk published no margin for this game'));
    else if (q.spread_home == null) out.push(missing('spread_agreement', 'the captured line carries no spread'));
    else {
      var gap = Math.abs(I.outputs.margin - (-q.spread_home));
      out.push(ok('spread_agreement', agreement(gap, sp.spread), 'EdgeDesk\'s margin sits ' + fmtPts(gap) + ' pts from the ' + q.book + ' spread'));
    }
    if (sp && !sp.total) out.push(na('total_agreement', 'no total comparison for this sport'));
    else if (I.outputs.total == null) out.push(missing('total_agreement', 'EdgeDesk published no total for this game'));
    else if (q.total == null) out.push(missing('total_agreement', 'the captured line carries no total'));
    else {
      var tg = Math.abs(I.outputs.total - q.total);
      out.push(ok('total_agreement', agreement(tg, sp.total), 'EdgeDesk\'s total sits ' + fmtPts(tg) + ' from the ' + q.book + ' total'));
    }
    var ih = impliedOf(q.ml_home), ia = impliedOf(q.ml_away);
    if (I.outputs.p_home == null) out.push(missing('moneyline_agreement', 'EdgeDesk published no win probability'));
    else if (ih == null || ia == null) out.push(missing('moneyline_agreement', 'the captured line carries no two-sided moneyline'));
    else {
      var mp = ih / (ih + ia), pg = Math.abs(I.outputs.p_home - mp);
      out.push(ok('moneyline_agreement', agreement(pg, sp ? sp.ml : [0.02, 0.15]), 'win probability ' + Math.round(pg * 1000) / 10 + ' points from the no-vig moneyline'));
    }
    return { items: out };
  }

  var CERT = { CONFIRMED: 100, PROJECTED_LIKELY: 70, PROJECTED_UNCERTAIN: 40, UNKNOWN: 0, CONFLICTING: 0 };
  var ROLE = { QB: 'starting quarterbacks', G: 'starting goalies', STAR: 'key players' };
  function dimClarity(I) {
    var out = [], av = I.availability;
    if (!av.key_role) out.push(na('key_role', 'no single role dominates this sport\'s number'));
    else if (!av.modelled) out.push(missing('key_role', 'player availability is not modelled for this sport (no injury or lineup feed)'));
    else if (av.certainty && CERT[av.certainty] != null) out.push(ok('key_role', CERT[av.certainty], (ROLE[av.key_role] || 'key roles') + ': ' + String(av.certainty).toLowerCase().replace(/_/g, ' ')));
    else out.push(missing('key_role', 'key-role availability is not reported'));
    if (!I.sensitivity.n) out.push(missing('sensitivity', 'the engine publishes no what-if for a key absence'));
    else out.push(ok('sensitivity', 100 * clamp01(1 - (I.sensitivity.max_dp - 0.01) / (0.10 - 0.01)), 'one absence moves the win probability by up to ' + Math.round(I.sensitivity.max_dp * 1000) / 10 + ' points'));
    if (I.matchup.factors > 0) out.push(ok('explanation', Math.min(100, I.matchup.factors * 20), plural(I.matchup.factors, 'itemised factor') + ' explain the number'));
    else if (I.matchup.metrics >= 2) out.push(ok('explanation', 40, 'matchup metrics published, but no itemised factor breakdown'));
    else out.push(missing('explanation', 'no matchup factors or metrics are published'));
    if (I.schedule.time_tbd === false) out.push(ok('start_time', 100, 'start time confirmed by the scoreboard'));
    else if (I.schedule.time_tbd === true) out.push(ok('start_time', 0, 'start time to be announced'));
    else out.push(missing('start_time', 'the scoreboard does not confirm the start time'));
    return { items: out };
  }

  function dimUncertainty(I) {
    var out = [], u = I.uncertainty;
    if (u.model_sd != null && u.model_sd_measured) out.push(ok('model_spread', 100 * clamp01(1 - (u.model_sd - 0.005) / (0.06 - 0.005)), 'model variants disagree by ' + Math.round(u.model_sd * 1000) / 10 + ' points of win probability'));
    else if (u.stability && u.stability.sd_pts != null) out.push(ok('model_spread', 100 * clamp01(1 - (u.stability.sd_pts - 1.5) / (6 - 1.5)), 'projected margin moves ' + fmtPts(u.stability.sd_pts) + ' pts (sd) under perturbation of its inputs' + (u.stability.tier ? ' (' + String(u.stability.tier).toLowerCase().replace(/_/g, ' ') + ')' : '')));
    else out.push(missing('model_spread', 'no game-specific model disagreement or stability measure is published (a board default is not a measurement)'));
    if (u.calibration_sd != null) out.push(ok('calibration_band', 100 * clamp01(1 - (u.calibration_sd - 0.01) / (0.06 - 0.01)), 'calibration band ±' + Math.round(u.calibration_sd * 1000) / 10 + ' points'));
    else out.push(missing('calibration_band', 'no calibration band is published'));
    if (u.early_season === true) out.push(ok('season_stage', 40, 'early season: ratings lean on last season'));
    else if (u.early_season === false) out.push(ok('season_stage', 100, 'in-season ratings'));
    else out.push(missing('season_stage', 'the engine does not say whether ratings are early-season'));
    return { items: out };
  }

  /* n/a: the question does not arise; unvalidated / excluded: evidence the
     methodology excludes and caps (see the header). None is in a denominator. */
  function outOfDenominator(x) { return x.status === 'n/a' || x.status === 'unvalidated' || x.status === 'excluded'; }
  /** Dimension score: weighted mean over the sub-factors in its denominator; a missing one counts as 0. */
  function rollup(id, items, cfg, statusOverride) {
    var w = cfg.sub[id], tot = 0, got = 0;
    items.forEach(function (x) { x.weight = w[x.id]; if (outOfDenominator(x)) return; tot += w[x.id]; got += w[x.id] * (x.score == null ? 0 : x.score); });
    var score = tot > 0 ? got / tot : null;
    var app = items.filter(function (x) { return !outOfDenominator(x); });
    var avail = app.filter(function (x) { return x.status === 'ok'; });
    var status = statusOverride || (!items.some(function (x) { return x.status !== 'n/a'; }) ? 'n/a' : !app.length ? 'excluded' : avail.length === app.length && app.length === items.filter(function (x) { return x.status !== 'n/a'; }).length ? 'ok' : avail.length ? 'partial' : 'unavailable');
    return { id: id, weight: cfg.weights[id], score: score == null ? null : r1(score), points: 0, status: status, items: items, _tot: tot };
  }
  /** The dimensions' points, renormalised over the dimensions that are in the total (only an excluded market leaves it). */
  function totalOf(dims) {
    var inW = 0;
    DIMENSIONS.forEach(function (d) { if (dims[d.id].score != null) inW += dims[d.id].weight; });
    var raw = 0;
    DIMENSIONS.forEach(function (d) {
      var D = dims[d.id], share = D.score == null || !inW ? 0 : D.weight * 100 / inW;
      D.points = r4(share * (D.score == null ? 0 : D.score) / 100);
      raw += D.points;
      D.items.forEach(function (x) { x.points = outOfDenominator(x) || !D._tot ? 0 : r4(share * (x.weight / D._tot) * ((x.score == null ? 0 : x.score) / 100)); });
      delete D._tot;
    });
    return { raw: raw, included_weight: inW };
  }

  /**
   * The grade from normalised inputs. Deterministic: the same inputs and the
   * same version always give the same grade.
   */
  function score(I, cfg) {
    cfg = typeof cfg === 'string' ? configFor(cfg) : cfg || configFor(DEFAULT_VERSION);
    var sp = SPORTS[I.sport] || null;
    var rel = dimReliability(I, cfg, sp), mk = dimMarket(I, cfg, sp);
    var dims = {
      reliability: rollup('reliability', rel.items, cfg, rel.status),
      completeness: rollup('completeness', dimCompleteness(I, cfg, sp).items, cfg),
      market: rollup('market', mk.items, cfg, mk.status),
      clarity: rollup('clarity', dimClarity(I).items, cfg),
      uncertainty: rollup('uncertainty', dimUncertainty(I).items, cfg)
    };
    var tot = totalOf(dims);
    var raw = rk(tot.raw, 2);

    /* GATES: any failure → INSUFFICIENT DATA, no letter */
    var start = toMs(I.start_utc), asOf = toMs(I.as_of);
    var gates = [
      { id: 'SPORT_SUPPORTED', pass: !!sp, detail: sp ? sp.label + ' has a grading adapter' : 'no grading adapter for this sport' },
      { id: 'MODEL_OUTPUT', pass: I.outputs.p_home != null, detail: I.outputs.p_home != null ? 'win probability published' : 'no model win probability for this game' },
      { id: 'PREGAME', pass: start != null && asOf != null && asOf < start && (toMs(I.model.predicted_at) == null || toMs(I.model.predicted_at) < start) && (toMs(I.model.inputs_known_at) == null || toMs(I.model.inputs_known_at) < start),
        detail: start == null ? 'no start time' : asOf == null ? 'no grading time' : asOf >= start ? 'the game had started: a grade is never made after kickoff' : toMs(I.model.predicted_at) != null && toMs(I.model.predicted_at) >= start ? 'the model number was produced after the start' : 'graded before kickoff on pregame inputs only' },
      { id: 'INDEPENDENT_MODEL', pass: !!I.model.independent, detail: I.model.independent ? 'the model reads no market price' : 'the projection is not independent of the market' },
      { id: 'RESEARCH_STATE', pass: I.research.outcome === 'RESEARCH_READY' || I.research.outcome === 'RESEARCH_CONDITIONAL', detail: I.research.outcome === 'RESEARCH_READY' || I.research.outcome === 'RESEARCH_CONDITIONAL' ? 'research ' + String(I.research.outcome).toLowerCase().replace(/_/g, ' ') : 'research state ' + str(I.research.outcome || 'unknown').toLowerCase().replace(/_/g, ' ') + (I.research.reasons[0] ? ': ' + I.research.reasons[0] : '') },
      { id: 'INTEGRITY', pass: !I.integrity.invalidated, detail: I.integrity.invalidated ? 'the projection is invalidated pregame (' + plural(I.integrity.conflicts, 'conflict') + ', e.g. a starter conflict)' : 'no integrity conflict' },
      { id: 'FRESH_BUILD', pass: I.freshness.state === 'FRESH', detail: I.freshness.state === 'FRESH' ? 'model build within its age limit' : 'model build ' + str(I.freshness.state || 'unknown').toLowerCase() },
      { id: 'COMPLETENESS_FLOOR', pass: dims.completeness.score != null && dims.completeness.score >= cfg.completeness_floor, detail: 'data completeness ' + Math.round(dims.completeness.score || 0) + ' (floor ' + cfg.completeness_floor + ')' },
      { id: 'MIN_EVIDENCE', pass: tot.included_weight >= cfg.min_included_weight, detail: tot.included_weight + ' of 100 weight points have evidence (minimum ' + cfg.min_included_weight + ')' }
    ];
    var failed = gates.filter(function (g) { return !g.pass; });

    /* CAPS: weight-independent ceilings */
    var caps = [], C = cfg.caps, t = I.track;
    if (!t || t.n < cfg.track_min_n) caps.push({ id: 'CALIBRATION_UNVALIDATED', max: C.CALIBRATION_UNVALIDATED, letter: capLetter(C.CALIBRATION_UNVALIDATED), why: 'the model\'s live pregame record is unvalidated (' + (t ? t.n : 0) + ' of ' + cfg.track_min_n + ' graded games needed)' });
    else if (t.n < cfg.track_full_n) caps.push({ id: 'CALIBRATION_EARLY_SIGNAL', max: C.CALIBRATION_EARLY_SIGNAL, letter: capLetter(C.CALIBRATION_EARLY_SIGNAL), why: 'the model\'s live pregame record is an early signal (' + t.n + ' graded games; ' + cfg.track_full_n + ' lift this cap)' });
    if (I.quote.status !== 'CAPTURED') caps.push({ id: 'NO_PREGAME_MARKET', max: C.NO_PREGAME_MARKET, letter: capLetter(C.NO_PREGAME_MARKET), why: 'no market cross-check: ' + quoteWhy(I.quote.status) });
    var av = I.availability;
    if (av.key_role && (!av.modelled || !av.certainty || av.certainty === 'UNKNOWN')) caps.push({ id: 'KEY_ROLE_UNKNOWN', max: C.KEY_ROLE_UNKNOWN, letter: capLetter(C.KEY_ROLE_UNKNOWN), why: (ROLE[av.key_role] || 'key-role') + ' availability is unknown' });
    var capMax = caps.length ? Math.min.apply(null, caps.map(function (c) { return c.max; })) : 100;
    var rounded = roundScore(tot.raw);
    var final = Math.min(rounded, capMax);
    var binding = caps.filter(function (c) { return c.max === capMax && rounded > capMax; });

    /* FLAGS a reader should see */
    var flags = (I.flags || []).slice();
    if (I.quote.status !== 'CAPTURED') flags.push(/NO_SLATE|SLATE_STALE/.test(I.quote.status) ? 'ODDS_PROVIDER_UNAVAILABLE' : 'NO_PREGAME_MARKET');
    var bigGap = dims.market.items.filter(function (x) { return /agreement$/.test(x.id) && x.status === 'ok' && x.score === 0; });
    if (bigGap.length) flags.push('LARGE_MODEL_MARKET_GAP');
    if (I.quote.status === 'CAPTURED' && I.quote.age_hours != null && I.quote.age_hours > 24) flags.push('STALE_MARKET_LINE');
    if (I.freshness.age_hours != null && I.freshness.max_age_hours && I.freshness.age_hours > 0.75 * I.freshness.max_age_hours && I.freshness.state === 'FRESH') flags.push('BUILD_NEAR_AGE_LIMIT');
    if (I.schedule.time_tbd === true) flags.push('START_TIME_TBA');
    if (I.uncertainty.early_season === true) flags.push('EARLY_SEASON');

    var g = {
      grade_version: cfg.grade_version, weights_version: cfg.weights_version, kernel: VERSION,
      state: failed.length ? INSUFFICIENT : 'GRADED',
      letter: failed.length ? null : letterOf(final),
      score: failed.length ? null : final,
      raw_score: raw, rounded_score: rounded, included_weight: tot.included_weight,
      cap: binding.length ? { max: capMax, letter: capLetter(capMax), ids: binding.map(function (c) { return c.id; }) } : null,
      caps: caps, gates: gates, failed_gates: failed.map(function (x) { return x.id; }),
      dimensions: dims, flags: flags
    };
    g.missing = [];
    DIMENSIONS.forEach(function (d) { dims[d.id].items.forEach(function (x) { if (x.status === 'unavailable' || x.status === 'unvalidated' || x.status === 'excluded') g.missing.push({ dimension: d.id, factor: x.id, label: x.label, status: x.status, why: x.detail }); }); });
    g.explanation = explain(g);
    return g;
  }

  /** A short plain-English account of the grade: what earned it, what held it back, any cap. */
  function explain(g) {
    if (g.state !== 'GRADED') {
      var f = g.gates.filter(function (x) { return !x.pass; })[0];
      return 'Not graded — insufficient data: ' + (f ? f.detail : 'a prerequisite failed') + '. The research is shown, but no letter is given.';
    }
    var all = [];
    DIMENSIONS.forEach(function (d) { g.dimensions[d.id].items.forEach(function (x) { if (!outOfDenominator(x)) all.push({ x: x, max: g.dimensions[d.id].weight * x.weight, dim: d.id }); }); });
    var strong = all.filter(function (a) { return a.x.status === 'ok' && a.x.score >= 80; }).sort(function (a, b) { return b.max - a.max || (a.x.id < b.x.id ? -1 : 1); }).slice(0, 2);
    var seen = {};
    var weak = all.map(function (a) { return { a: a, lost: a.max * (1 - (a.x.score == null ? 0 : a.x.score) / 100) }; }).filter(function (w) { return w.lost > 0.5; })
      .sort(function (a, b) { return b.lost - a.lost || (a.a.x.id < b.a.x.id ? -1 : 1); })
      .filter(function (w) { if (seen[w.a.x.detail]) return false; seen[w.a.x.detail] = 1; return true; }).slice(0, 2);
    var s = g.letter + ' (' + g.score + '/100).';
    if (strong.length) s += ' Strengths: ' + strong.map(function (a) { return a.x.detail; }).join('; ') + '.';
    if (weak.length) s += ' Holding it back: ' + weak.map(function (w) { return w.a.x.detail; }).join('; ') + '.';
    if (g.cap) s += ' Capped at ' + g.cap.letter + ': ' + g.caps.filter(function (c) { return c.max === g.cap.max; }).map(function (c) { return c.why; }).join('; ') + '.';
    return s;
  }

  /* ---------------------------------------------------------- evaluated */
  /**
   * The side EdgeDesk's number sat on against the captured line, decided
   * BEFORE kickoff from pregame numbers only and stored with the snapshot.
   * It is a research comparison, never a recommendation; the dashboard
   * records it against the line only because it was saved before the start.
   */
  function evaluatedSides(I) {
    var q = I.quote, out = { spread: null, total: null };
    if (!q || q.status !== 'CAPTURED') return out;
    var sp = SPORTS[I.sport] || {};
    if (sp.spread && I.outputs.margin != null && q.spread_home != null) {
      var fairHome = -I.outputs.margin, gap = rk(q.spread_home - fairHome, 2);
      if (Math.abs(gap) > 1e-9) {
        var side = gap > 0 ? 'home' : 'away';
        /* the book and its capture time are the snapshot's market block's */
        out.spread = { side: side, home_line: q.spread_home, line: side === 'home' ? q.spread_home : -q.spread_home, price: side === 'home' ? q.spread_home_price : q.spread_away_price,
          gap: rk(Math.abs(gap), 2), model_home_line: rk(fairHome, 2) };
      }
    }
    /* the total EdgeDesk prices: a priced fair line where one is published, the expectation in the NHL (as EDPERF grades it) */
    var ft = I.sport === 'nhl' ? I.outputs.total : I.outputs.fair_total != null ? I.outputs.fair_total : I.outputs.total;
    if (sp.total && ft != null && q.total != null && Math.abs(ft - q.total) > 1e-9) {
      var ts = ft > q.total ? 'over' : 'under';
      out.total = { side: ts, line: q.total, price: ts === 'over' ? q.over : q.under, gap: rk(Math.abs(ft - q.total), 2), model_total: rk(ft, 2) };
    }
    return out;
  }

  /* ----------------------------------------------------------- snapshot */
  /**
   * One ledger row (chain fields are added by the writer). ctx: { as_of,
   * forecast_hash, run, git_sha, slate_id, league, season }
   */
  function snapshotRow(p, I, g, ctx) {
    ctx = ctx || {};
    var dims = {};
    DIMENSIONS.forEach(function (d) {
      var D = g.dimensions[d.id], s = {};
      D.items.forEach(function (x) { s[x.id] = [x.score, x.status]; });
      dims[d.id] = { score: D.score, points: rk(D.points, 2), status: D.status, sub: s };
    });
    var ev = evaluatedSides(I);
    var row = {
      schema: SNAPSHOT_SCHEMA,
      event_key: p.event_key, sport: p.sport, league: p.league || null, season: ctx.season == null ? null : ctx.season, event_id: str(p.event_id),
      home: { name: obj(p.home).name || null, abbr: obj(p.home).abbr || null }, away: { name: obj(p.away).name || null, abbr: obj(p.away).abbr || null },
      start_utc: isoOf(p.start_utc), captured_at: I.as_of,
      versions: { grade: g.grade_version, weights: g.weights_version, kernel: g.kernel, model_id: I.model.id, model_version: I.model.version },
      forecast: { hash: ctx.forecast_hash || null, projection_hash: p.projection_hash || null, predicted_at: I.model.predicted_at,
        p_home: I.outputs.p_home, p_away: I.outputs.p_home == null ? null : r4(1 - I.outputs.p_home), projected_margin: I.outputs.margin, projected_total: I.outputs.total,
        fair_home_line: num(obj(obj(p.fair).spread).home_line), fair_total: I.outputs.fair_total },
      market: I.quote.status === 'CAPTURED' ? { status: 'CAPTURED', book: I.quote.book, provider: I.quote.source, captured_at: I.quote.captured_at, age_hours: I.quote.age_hours,
        spread: I.quote.spread_home == null ? null : { home_point: I.quote.spread_home, home_price: I.quote.spread_home_price, away_price: I.quote.spread_away_price },
        total: I.quote.total == null ? null : { point: I.quote.total, over: I.quote.over, under: I.quote.under },
        moneyline: I.quote.ml_home == null && I.quote.ml_away == null ? null : { home: I.quote.ml_home, away: I.quote.ml_away } } : { status: I.quote.status },
      evaluated: ev,
      grade: { state: g.state, letter: g.letter, score: g.score, raw_score: g.raw_score, included_weight: g.included_weight, cap: g.cap, caps: g.caps.map(function (c) { return c.id; }), failed_gates: g.failed_gates,
        dimensions: dims, flags: g.flags, explanation: g.explanation },
      inputs: I,
      capture: { method: 'ledger_capture', run: ctx.run || null, git_sha: ctx.git_sha || null, slate_id: ctx.slate_id || null }
    };
    row.signature = snapshotSignature(row);
    return row;
  }
  /* FNV-1a over a string, twice with different seeds: a short, deterministic digest (Node and browser alike) */
  function fnv(str0, seed) { var h = seed >>> 0; for (var i = 0; i < str0.length; i++) { h ^= str0.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  /**
   * What makes a grade a new revision: the letter, the score, each part's
   * whole-number score, the caps and gates, the forecast it graded, whether a
   * line was on file and which side EdgeDesk's number sat on. A line that moves
   * without moving any of these is not a new grade (the quote ledger keeps every
   * line move). Stored as a short digest.
   */
  function snapshotSignature(s) {
    var g = obj(s.grade), d = obj(g.dimensions), ev = obj(s.evaluated);
    var key = JSON.stringify([s.event_key, obj(s.versions).grade, obj(s.versions).model_id, g.state, g.letter, g.score,
      DIMENSIONS.map(function (x) { return d[x.id] ? Math.round(d[x.id].score == null ? -1 : d[x.id].score) : null; }),
      g.caps || [], g.failed_gates || [], obj(s.forecast).hash || null, obj(s.market).status || null,
      ev.spread ? ev.spread.side : null, ev.total ? ev.total.side : null]);
    return 'rgs1:' + fnv(key, 2166136261) + fnv(key, 3735928559);
  }
  /** Recompute a stored snapshot from its own inputs and version: the stored grade must come back unchanged. */
  function reproduce(s) {
    var cfg = configFor(obj(s.versions).grade);
    if (!cfg) return { ok: false, why: 'unknown grade version ' + obj(s.versions).grade };
    var g = score(s.inputs, cfg);
    var diffs = [];
    var G = obj(s.grade);
    if (g.state !== G.state) diffs.push('state');
    if (g.letter !== G.letter) diffs.push('letter');
    if (g.score !== G.score) diffs.push('score');
    if (g.raw_score !== G.raw_score) diffs.push('raw_score');
    if (G.included_weight != null && g.included_weight !== G.included_weight) diffs.push('included_weight');
    if (g.explanation !== G.explanation) diffs.push('explanation');
    DIMENSIONS.forEach(function (d) { var a = g.dimensions[d.id], b = obj(obj(G.dimensions)[d.id]); if (a.score !== b.score || a.status !== b.status) diffs.push(d.id); });
    return { ok: !diffs.length, diffs: diffs, grade: g };
  }

  /* ---------------------------------------------------------- designate */
  /**
   * The ONE grade snapshot a game is judged by: the latest valid pregame one,
   * i.e. the last captured strictly before the actual start. A snapshot taken
   * for a start that moved by more than 36 hours graded a different date and
   * is not eligible. No snapshot → the game had no pregame grade, and none is
   * ever made up afterwards.
   */
  function designate(snaps, actualStart) {
    var st = toMs(actualStart), ok2 = [], out = [];
    (snaps || []).forEach(function (s) {
      var cap = toMs(s.captured_at), sched = toMs(s.start_utc), start = st != null ? st : sched;
      var why = null;
      if (cap == null) why = 'NO_CAPTURE_TIME';
      else if (start == null) why = 'NO_START';
      else if (cap >= start) why = 'CAPTURED_AFTER_START';
      else if (sched != null && cap >= sched) why = 'CAPTURED_AFTER_SCHEDULED_START';
      else if (st != null && sched != null && Math.abs(sched - st) > RESCHEDULE_HOURS * 3600e3) why = 'RESCHEDULED';
      if (why) out.push({ hash: s.hash || null, why: why }); else ok2.push(s);
    });
    ok2.sort(function (a, b) { return toMs(a.captured_at) - toMs(b.captured_at) || (a.seq || 0) - (b.seq || 0); });
    var pick = ok2.length ? ok2[ok2.length - 1] : null;
    return { snapshot: pick, revisions: ok2.length, ineligible: out };
  }

  /* ------------------------------------------------------------- settle */
  function sideResult(diff) { if (diff == null) return null; if (Math.abs(diff) < 1e-9) return 'push'; return diff > 0 ? 'win' : 'loss'; }
  function units(res, price) { var pp = profitPerUnit(price); if (pp == null) return null; if (res === 'push') return 0; return res === 'win' ? rk(pp, 4) : res === 'loss' ? -1 : null; }
  function sourceFamily(s) { return PERF ? PERF.sourceFamily(s) : str(s).toLowerCase().split(/[\s:·_]/)[0] || null; }

  /**
   * The designated snapshot + the verified result → one outcome. Winner,
   * margin and total use EDPERF's own grading arithmetic on the numbers the
   * snapshot froze. The spread and total records use ONLY the evaluated side
   * and line stored before kickoff; nothing is chosen from the final.
   * opts: { close: { home_line, total, source } } — a legitimate close (the
   * football record), used for CLV only when it is the quote's own source family.
   */
  function settle(s, res, opts) {
    opts = opts || {};
    var g = obj(s.grade), f = obj(s.forecast), mk = obj(s.market);
    var o = { schema: OUTCOME_SCHEMA, event_key: s.event_key, sport: s.sport, league: s.league || null, season: s.season == null ? null : s.season,
      start_utc: res.start_utc || s.start_utc, snapshot_hash: s.hash || null, snapshot_captured_at: s.captured_at || null,
      grade_state: g.state || null, letter: g.letter || null, score: g.score == null ? null : g.score, grade_version: obj(s.versions).grade || null,
      model_id: obj(s.versions).model_id || null, model_version: obj(s.versions).model_version || null,
      result_hash: res.hash || null,
      settlement: { state: res.state === 'FINAL' ? 'SETTLED' : res.state === 'VOID' ? 'VOID' : 'UNSETTLED', void_reason: res.void_reason || null,
        home_score: res.home_score == null ? null : res.home_score, away_score: res.away_score == null ? null : res.away_score, decided: res.decided || null,
        overtime: res.decided ? res.decided !== 'REG' : null, verified_at: res.verified_at || null, result_revision: res.revision || 1 },
      eligible: true, why: null };
    if (res.state !== 'FINAL') { o.eligible = false; o.why = res.state === 'VOID' ? 'VOID_' + (res.void_reason || 'GAME') : 'NOT_SETTLED'; return o; }
    var pseudo = { event_key: s.event_key, sport: s.sport, start_utc: s.start_utc, hash: s.hash || null,
      forecast: { p_home: f.p_home, fair_home_line: f.fair_home_line, fair_total: f.fair_total, expected_total: s.sport === 'nhl' ? f.projected_total : null,
        projected_score: f.projected_margin != null || f.projected_total != null ? { margin: f.projected_margin, total: f.projected_total } : null },
      readiness: {}, quote: null };
    var base = PERF ? PERF.gradeGame(pseudo, res, {}) : {};
    var hs = res.home_score, as = res.away_score, margin = hs - as, total = hs + as;
    o.final = { home_score: hs, away_score: as, margin: margin, total: total, decided: res.decided || null };
    o.winner = base.winner || null; o.spread = base.spread || null; o.total = base.total || null;
    /* the market, as the snapshot saw it before kickoff */
    var market = null, ev = obj(s.evaluated);
    if (mk.status === 'CAPTURED') {
      market = { book: mk.book || null, provider: mk.provider || null, captured_at: mk.captured_at || null };
      if (mk.spread && num(mk.spread.home_point) != null) {
        var mm = -num(mk.spread.home_point);
        market.spread = { line: num(mk.spread.home_point), market_margin: mm, market_abs_error: rk(Math.abs(margin - mm), 2) };
        if (ev.spread) {
          var cover = ev.spread.side === 'home' ? margin + ev.spread.home_line : -(margin + ev.spread.home_line);
          var sr = sideResult(cover);
          market.spread.pick = { side: ev.spread.side, gap: ev.spread.gap, result: sr, price: num(ev.spread.price), units: units(sr, ev.spread.price), evaluated_pregame: true };
        }
      }
      if (mk.total && num(mk.total.point) != null) {
        market.total = { line: num(mk.total.point), market_abs_error: rk(Math.abs(total - num(mk.total.point)), 2) };
        if (ev.total) {
          var tr = sideResult(ev.total.side === 'over' ? total - ev.total.line : ev.total.line - total);
          market.total.pick = { side: ev.total.side, gap: ev.total.gap, result: tr, price: num(ev.total.price), units: units(tr, ev.total.price), evaluated_pregame: true };
        }
      }
      if (mk.moneyline) {
        var ih = impliedOf(mk.moneyline.home), ia = impliedOf(mk.moneyline.away);
        if (ih != null && ia != null && margin !== 0) { var mp = ih / (ih + ia), y = margin > 0 ? 1 : 0; market.moneyline = { market_p_home: r4(mp), market_brier: rk((mp - y) * (mp - y), 6) }; }
      }
      var c = opts.close;
      market.close_available = !!(c && (num(c.home_line) != null || num(c.total) != null));
      if (c && sourceFamily(c.source) && sourceFamily(c.source) === sourceFamily(mk.provider)) {
        market.clv = { close_source: c.source || null };
        if (market.spread && market.spread.pick && num(c.home_line) != null) market.clv.spread_pts = rk(market.spread.pick.side === 'home' ? market.spread.line - num(c.home_line) : num(c.home_line) - market.spread.line, 2);
        if (market.total && market.total.pick && num(c.total) != null) market.clv.total_pts = rk(market.total.pick.side === 'over' ? num(c.total) - market.total.line : market.total.line - num(c.total), 2);
      }
    }
    o.market = market;
    o.closing_line = { available: !!(opts.close && (num(opts.close.home_line) != null || num(opts.close.total) != null)), source: opts.close ? opts.close.source || null : null };
    return o;
  }
  function outcomeSignature(o) {
    return JSON.stringify([o.event_key, o.snapshot_hash, o.result_hash, o.eligible, o.why, o.letter, o.score, obj(o.market).clv || null]);
  }

  /* --------------------------------------------------------- public row */
  /** The compact public row for one started game (performance/data/grades/games/*.json). */
  function publicRow(s, o, extra) {
    extra = extra || {};
    var g = obj(s.grade), d = obj(g.dimensions), dims = {};
    DIMENSIONS.forEach(function (x) { if (d[x.id]) dims[x.id] = d[x.id].score; });
    var row = {
      event_key: s.event_key, sport: s.sport, league: s.league || null, season: s.season == null ? null : s.season,
      home: obj(s.home).name || obj(s.home).abbr, away: obj(s.away).name || obj(s.away).abbr,
      start_utc: (o && o.start_utc) || s.start_utc,
      letter: g.state === 'GRADED' ? g.letter : INSUFFICIENT, score: g.score == null ? null : g.score, grade_state: g.state,
      grade_version: obj(s.versions).grade, model_id: obj(s.versions).model_id, model_version: obj(s.versions).model_version,
      dims: dims, caps: g.caps || [], failed_gates: g.failed_gates || [], flags: g.flags || [], explanation: g.explanation || null,
      market_status: obj(s.market).status || null, market_book: obj(s.market).book || null,
      evaluated: { spread: !!obj(s.evaluated).spread, total: !!obj(s.evaluated).total },
      snapshot: { hash: s.hash || null, captured_at: s.captured_at, revisions: extra.revisions || 1 },
      history: extra.history || null,
      outcome: null
    };
    if (o) {
      row.outcome = { eligible: o.eligible, why: o.why, settlement: o.settlement, winner: o.winner || null, spread: o.spread || null, total: o.total || null, market: o.market || null,
        revision: o.revision || 1 };
    }
    return compact(row);
  }
  function compact(v) {
    if (Array.isArray(v)) return v.map(compact);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { if (v[k] === null || v[k] === undefined) return; o[k] = compact(v[k]); }); return o; }
    return v;
  }

  /* ------------------------------------------------------- performance */
  function sd(a) { if (a.length < 2) return null; var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
  /** Mean with a normal-approximation 95% interval — only from 50 observations (EDCALIB's EARLY_SIGNAL band). */
  function meanCI(list, k) {
    var n = list.length, m = mean(list), s = sd(list);
    if (n < 50 || s == null) return { n: n, mean: n >= MIN_N ? rk(m, k == null ? 4 : k) : null, low: null, high: null };
    var h = Z95 * s / Math.sqrt(n);
    return { n: n, mean: rk(m, k == null ? 4 : k), low: rk(m - h, k == null ? 4 : k), high: rk(m + h, k == null ? 4 : k) };
  }
  /** The difference of two means and its 95% interval (Welch, normal approximation): evidence only when it excludes 0. */
  function diffCI(a, b, k) {
    if (a.length < 50 || b.length < 50) return { n_a: a.length, n_b: b.length, diff: null, low: null, high: null, evidence: false, why: 'each group needs 50 settled games' };
    var d = mean(a) - mean(b), se = Math.sqrt(Math.pow(sd(a), 2) / a.length + Math.pow(sd(b), 2) / b.length);
    var lo = d - Z95 * se, hi = d + Z95 * se;
    return { n_a: a.length, n_b: b.length, diff: rk(d, k == null ? 4 : k), low: rk(lo, k == null ? 4 : k), high: rk(hi, k == null ? 4 : k), evidence: lo > 0 || hi < 0, why: lo > 0 || hi < 0 ? 'the 95% interval excludes zero' : 'the 95% interval includes zero' };
  }
  function asPerfRow(x) {
    /* the shape EDPERF.metrics reads: its own grade object */
    var o = x.outcome;
    return { start_utc: x.start_utc, result: o && o.settlement ? { state: o.settlement.state === 'SETTLED' ? 'FINAL' : o.settlement.state === 'VOID' ? 'VOID' : null } : null,
      grade: o ? { eligible: o.eligible, why: o.why, winner: o.winner || null, spread: o.spread || null, total: o.total || null, market: o.market || null } : null };
  }
  function groupStats(list) {
    var settled = list.filter(function (x) { return x.outcome && x.outcome.eligible; });
    var m = PERF ? PERF.metrics(list.map(asPerfRow)) : null;
    var briers = settled.filter(function (x) { return x.outcome.winner && x.outcome.winner.brier != null; }).map(function (x) { return x.outcome.winner.brier; });
    var mErr = settled.filter(function (x) { return x.outcome.spread; }).map(function (x) { return x.outcome.spread.abs_error; });
    var tErr = settled.filter(function (x) { return x.outcome.total; }).map(function (x) { return x.outcome.total.abs_error; });
    var scores = list.filter(function (x) { return x.score != null; }).map(function (x) { return x.score; });
    var dimAvg = {};
    DIMENSIONS.forEach(function (d) { var v = list.map(function (x) { return x.dims ? x.dims[d.id] : null; }).filter(function (v2) { return v2 != null; }); dimAvg[d.id] = v.length ? r1(mean(v)) : null; });
    var mkt = list.filter(function (x) { return x.market_status === 'CAPTURED'; }).length;
    return {
      games: list.length, settled: settled.length, sample_state: sampleState(settled.length),
      avg_score: scores.length ? r1(mean(scores)) : null,
      avg_dimensions: dimAvg,
      market_coverage: list.length ? r4(mkt / list.length) : null, market_n: mkt,
      brier_ci: meanCI(briers, 4), margin_mae_ci: meanCI(mErr, 2), total_mae_ci: meanCI(tErr, 2),
      metrics: m
    };
  }
  /**
   * rows: public rows (publicRow). → the dashboard: totals, the grade
   * distribution, one block per letter (and the ungraded), and whether the
   * data show any ordering between adjacent letters. Nothing is assumed:
   * "higher grades perform better" is printed only where an interval says so.
   */
  function performance(rows, opts) {
    opts = opts || {};
    rows = rows || [];
    var groups = LETTER_IDS.concat([INSUFFICIENT]);
    var dist = {}; groups.forEach(function (k) { dist[k] = 0; });
    rows.forEach(function (x) { dist[x.letter] = (dist[x.letter] || 0) + 1; });
    var by = {};
    groups.forEach(function (k) { by[k] = groupStats(rows.filter(function (x) { return x.letter === k; })); });
    var excl = { void: 0, unsettled: 0, by_why: {} };
    rows.forEach(function (x) {
      var o = x.outcome;
      if (!o) { excl.unsettled++; return; }
      if (!o.eligible) { if (/^VOID/.test(o.why || '')) excl.void++; else excl.unsettled++; excl.by_why[o.why] = (excl.by_why[o.why] || 0) + 1; }
    });
    var briersOf = function (k) { return rows.filter(function (x) { return x.letter === k && x.outcome && x.outcome.eligible && x.outcome.winner && x.outcome.winner.brier != null; }).map(function (x) { return x.outcome.winner.brier; }); };
    var maeOf = function (k) { return rows.filter(function (x) { return x.letter === k && x.outcome && x.outcome.eligible && x.outcome.spread; }).map(function (x) { return x.outcome.spread.abs_error; }); };
    var ordering = [];
    for (var i = 0; i < LETTER_IDS.length - 1; i++) {
      var hi = LETTER_IDS[i], lo = LETTER_IDS[i + 1];
      /* a lower Brier (and a lower error) is better: diff = lower letter − higher letter > 0 means the higher letter did better */
      ordering.push({ higher: hi, lower: lo, brier: diffCI(briersOf(lo), briersOf(hi), 4), margin_mae: diffCI(maeOf(lo), maeOf(hi), 2) });
    }
    var anyEvidence = ordering.some(function (o) { return o.brier.evidence || o.margin_mae.evidence; });
    var graded = rows.filter(function (x) { return x.letter !== INSUFFICIENT; });
    var settledGraded = graded.filter(function (x) { return x.outcome && x.outcome.eligible; });
    return {
      schema: VERSION + ':performance', min_n: MIN_N,
      totals: { games: rows.length, graded: graded.length, ungraded: dist[INSUFFICIENT], settled_graded: settledGraded.length, void: excl.void, unsettled: excl.unsettled,
        sample_state: sampleState(settledGraded.length), research_coverage: rows.length ? r4(graded.length / rows.length) : null },
      exclusions: excl,
      distribution: dist,
      by_letter: by,
      ordering: { pairs: ordering, any_evidence: anyEvidence,
        statement: anyEvidence ? 'At least one adjacent pair of grades differs with a 95% interval that excludes zero; read each pair, not the letters, as the finding.'
          : 'No evidence yet that higher grades perform better or worse than lower ones. A grade measures research quality; this page will say so only when settled games show it.' },
      trend: trend(rows, opts.period)
    };
  }
  /** Weekly (or monthly) volume by letter, and the cumulative Brier by letter (printed only from MIN_N). */
  function trend(rows, period) {
    var key = period === 'month' ? (PERF ? PERF.monthOf : function (v) { return isoOf(v).slice(0, 7); }) : (PERF ? PERF.isoWeek : function (v) { return isoOf(v).slice(0, 10); });
    var by = {};
    rows.forEach(function (x) { var k = key(x.start_utc); if (!k) return; (by[k] = by[k] || []).push(x); });
    var cum = {}; LETTER_IDS.forEach(function (l) { cum[l] = []; });
    return Object.keys(by).sort().map(function (k) {
      var L = by[k], counts = {}, cumBrier = {};
      LETTER_IDS.concat([INSUFFICIENT]).forEach(function (l) { counts[l] = L.filter(function (x) { return x.letter === l; }).length; });
      LETTER_IDS.forEach(function (l) {
        L.filter(function (x) { return x.letter === l && x.outcome && x.outcome.eligible && x.outcome.winner && x.outcome.winner.brier != null; }).forEach(function (x) { cum[l].push(x.outcome.winner.brier); });
        cumBrier[l] = cum[l].length >= MIN_N ? r4(mean(cum[l])) : null;
      });
      return { period: k, games: L.length, settled: L.filter(function (x) { return x.outcome && x.outcome.eligible; }).length, counts: counts, cum_brier: cumBrier,
        cum_n: LETTER_IDS.reduce(function (o, l) { o[l] = cum[l].length; return o; }, {}) };
    });
  }
  /** Filter public rows the way the dashboard's controls do. */
  function filterRows(rows, f) {
    f = f || {};
    var from = toMs(f.from), to = toMs(f.to);
    return (rows || []).filter(function (x) {
      if (f.sport && f.sport !== 'all' && x.sport !== f.sport) return false;
      if (f.league && f.league !== 'all' && x.league !== f.league) return false;
      if (f.season && f.season !== 'all' && String(x.season) !== String(f.season)) return false;
      if (f.model && f.model !== 'all' && x.model_id !== f.model) return false;
      if (f.grade_version && f.grade_version !== 'all' && x.grade_version !== f.grade_version) return false;
      if (f.letter && f.letter !== 'all' && x.letter !== f.letter) return false;
      var t = toMs(x.start_utc);
      if (from != null && (t == null || t < from)) return false;
      if (to != null && (t == null || t >= to)) return false;
      if (f.market && f.market !== 'all') {
        var o = x.outcome;
        if (f.market === 'winner' && !(o && o.winner)) return false;
        if (f.market === 'spread' && !(o && o.spread)) return false;
        if (f.market === 'total' && !(o && o.total)) return false;
        if (f.market === 'ats' && !(x.evaluated && x.evaluated.spread)) return false;
        if (f.market === 'ou' && !(x.evaluated && x.evaluated.total)) return false;
      }
      return true;
    });
  }

  /* ---------------------------------------------------------------- copy */
  var TOOLTIP = 'Research Grade rates the quality and reliability of EdgeDesk\'s pregame research on this game: the model\'s track record, data completeness, a check against a sportsbook line, matchup clarity and uncertainty. It is not a win probability, not a prediction of who wins and not a betting recommendation. Research, not picks.';
  var LETTER_MEANING = {
    A: 'Research is complete, current, cross-checked against a captured market line and backed by a validated live track record.',
    B: 'Solid research with one or two gaps, or a track record still building.',
    C: 'Usable research with clear gaps: an unvalidated track record, unknown availability or no market cross-check.',
    D: 'Thin research: several inputs are missing, stale or uncertain.',
    F: 'Weak research: most of what a reliable read needs is missing or uncertain.',
    INSUFFICIENT: 'Not graded: a prerequisite failed (no model number, an expired or invalidated build, or too little data).'
  };

  /** Grade one projection end to end. ctx as in normalize(). */
  function gradeProjection(p, ctx, cfg) {
    var I = normalize(p, ctx);
    return { inputs: I, grade: score(I, cfg) };
  }

  return {
    VERSION: VERSION, SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA, OUTCOME_SCHEMA: OUTCOME_SCHEMA, DEFAULT_VERSION: DEFAULT_VERSION, CONFIGS: CONFIGS,
    LETTERS: LETTERS, LETTER_IDS: LETTER_IDS, INSUFFICIENT: INSUFFICIENT, DIMENSIONS: DIMENSIONS, SUB_LABEL: SUB_LABEL, SPORTS: SPORTS,
    TOOLTIP: TOOLTIP, LETTER_MEANING: LETTER_MEANING, RESCHEDULE_HOURS: RESCHEDULE_HOURS, MIN_N: MIN_N,
    configFor: configFor, roundScore: roundScore, letterOf: letterOf, familyOf: familyOf, trackRecord: trackRecord,
    normalize: normalize, score: score, explain: explain, gradeProjection: gradeProjection, evaluatedSides: evaluatedSides,
    snapshotRow: snapshotRow, snapshotSignature: snapshotSignature, reproduce: reproduce, designate: designate,
    settle: settle, outcomeSignature: outcomeSignature, publicRow: publicRow, compact: compact,
    meanCI: meanCI, diffCI: diffCI, performance: performance, trend: trend, filterRows: filterRows, asPerfRow: asPerfRow, quoteWhy: quoteWhy
  };
});
