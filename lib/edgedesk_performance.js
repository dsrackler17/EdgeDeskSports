/* ===========================================================================
   EdgeDesk PERFORMANCE — the public record of every eligible pregame forecast,
   graded against the verified final. docs/model-performance/DESIGN.md

   ONE FILE, Node and browser (UMD, root.EDPERF). Pure: no clock, no network,
   no file. The hourly job (tools/performance/) builds the ledger and the
   public summary with it, and the public page (/performance/) filters with
   the same functions, so the page can never print a number the record does
   not support.

   WHAT IT DOES
     snapshot      one projection (lib/edgedesk_projections.js contract) → one
                   ledger row: the forecast, its model, its timestamps, its
                   readiness flags, and the named-book quote it was compared
                   with (only a quote captured before the start)
     designate     every revision of a game → the ONE snapshot graded in public:
                   the last one the ledger captured before the actual start
     resolve       every source's reading of a game → FINAL / VOID / CONFLICT /
                   PENDING (a final needs integer scores every source agrees on)
     grade         snapshot + verified final → winner, margin, total, and the
                   market comparison where a captured quote exists
     metrics       graded games → accuracy, Brier, log loss, calibration,
                   errors, market comparison, pick records, CLV, trend — each
                   with its n and its sample state

   WHAT IT REFUSES
     - A forecast captured or predicted at or after the start is never a
       pregame forecast. A snapshot taken for a start that later moved by more
       than 36 hours is not the forecast for the game that was played.
     - A price is never assumed. No captured price, no units; no legitimate
       close (same source family), no CLV.
     - A percentage from a tiny sample. Below MIN_N the rate is null and the
       counts are shown instead; every figure carries EDCALIB's sample state.
   =========================================================================== */
(function (root, factory) {
  var CAL = null;
  if (typeof module === 'object' && module && module.exports) {
    try { CAL = require('./edgedesk_calibration.js'); } catch (_) { CAL = null; }
    module.exports = factory(CAL);
  } else {
    root.EDPERF = factory(root.EDCALIB || null);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CAL) {
  'use strict';

  var VERSION = 'edgedesk_performance_v1';
  /* bump when the grading arithmetic changes: every game is then regraded as
     a new grade revision with reason "method_change", and the old one kept */
  var GRADER_VERSION = 'perf_grader_v1';
  var SNAPSHOT_SCHEMA = 'edgedesk_perf_forecast_v1';
  var QUOTE_SCHEMA = 'edgedesk_perf_quote_v1';
  var RESULT_SCHEMA = 'edgedesk_perf_result_v1';
  var GRADE_SCHEMA = 'edgedesk_perf_grade_v1';
  /* the CFB Lab's rescheduling rule (football/cfb_lab/integrity.js) */
  var RESCHEDULE_HOURS = 36;
  /* a postponed game with no new date for this long is void (revisable) */
  var POSTPONED_VOID_DAYS = 14;
  /* below this many observations a rate is not printed, only the counts */
  var MIN_N = 20;
  var EPS = 1e-6;
  var TIERS = {
    VERIFIED: { id: 'VERIFIED', label: 'Verified pregame', means: 'Captured by the performance ledger from a public, committed EdgeDesk artifact before the game started, hash-chained and committed.' },
    RECORDED: { id: 'RECORDED', label: 'Recorded pregame (pre-ledger)', means: 'Imported from an earlier EdgeDesk pregame-only record. Its own timestamp is before the start, but the performance ledger did not lock it, so it is never counted in the verified headline.' }
  };
  var TYPES = ['winner', 'spread', 'total', 'market'];
  var PICK_GAPS = [0, 1.5, 3];
  var CONF_BANDS = [[0.5, 0.55], [0.55, 0.6], [0.6, 0.65], [0.65, 0.7], [0.7, 0.8], [0.8, 1.0000001]];
  var CAL_EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
  var Z95 = 1.959964;

  /* ------------------------------------------------------------- helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function isoOf(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function r(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k == null ? 4 : k); return Math.round(v * f) / f; }
  function str(v) { return v == null ? '' : String(v); }
  function obj(v) { return v && typeof v === 'object' ? v : {}; }
  function clip(p) { return Math.min(1 - EPS, Math.max(EPS, p)); }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function sampleState(n) {
    if (CAL && CAL.sampleState) return CAL.sampleState(n);
    return n >= 500 ? 'MEANINGFUL' : n >= 200 ? 'DEVELOPING' : n >= 50 ? 'EARLY_SIGNAL' : 'TOO_EARLY';
  }
  function wilson(k, n) {
    if (CAL && CAL.wilson) return CAL.wilson(k, n);
    if (!n) return { low: null, high: null };
    var p = k / n, z2 = Z95 * Z95, den = 1 + z2 / n, c = (p + z2 / (2 * n)) / den, h = Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
    return { low: r(Math.max(0, c - h)), high: r(Math.min(1, c + h)) };
  }
  /* American odds → profit per unit staked */
  function profitPerUnit(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? a / 100 : 100 / -a; }
  function impliedOf(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); }
  /* the ISO week a UTC instant falls in: '2026-W42' */
  function isoWeek(v) {
    var t = toMs(v); if (t == null) return null;
    var d = new Date(t); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - day);
    var y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    var wk = Math.ceil(((d - y0) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + (wk < 10 ? '0' : '') + wk;
  }
  function monthOf(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString().slice(0, 7); }
  function normName(s) {
    var t = str(s).toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function sportOfKey(k) { return str(k).split('|')[0].toLowerCase(); }

  /* ------------------------------------------------------------ snapshot */
  /** A named-book quote as the slate captured it (today/slate.json markets). */
  function quoteFromSlate(m) {
    if (!m || typeof m !== 'object') return null;
    var sp = obj(m.spread), tot = obj(m.total), ml = obj(m.moneyline);
    var q = {
      book: m.book || null, source: m.source || null, captured_at: isoOf(m.captured_at),
      moneyline: num(ml.home) != null || num(ml.away) != null ? { home: num(ml.home), away: num(ml.away) } : null,
      spread: sp.home && num(sp.home.point) != null ? { home_point: num(sp.home.point), home_price: num(sp.home.price), away_point: sp.away ? num(sp.away.point) : -num(sp.home.point), away_price: sp.away ? num(sp.away.price) : null } : null,
      total: num(tot.point) != null ? { point: num(tot.point), over: num(tot.over), under: num(tot.under) } : null
    };
    if (!q.captured_at || (!q.moneyline && !q.spread && !q.total)) return null;
    return q;
  }
  /** The fields that make a forecast a forecast: a change in any is a revision. */
  function signatureOf(s) {
    var f = obj(s.forecast), m = obj(s.model);
    return JSON.stringify([s.event_key, m.id || null, m.version || null, r(num(f.p_home), 3), r(num(f.p_draw), 3), r(num(f.fair_home_line), 1),
      r(num(f.fair_total), 1), r(num(f.expected_total), 1), r(num(obj(f.projected_score).margin), 1)]);
  }
  /**
   * One projection contract record → one ledger row (chain fields are added
   * by the writer). ctx: { captured_at, method, run, git_sha, quote }
   */
  function snapshotFromProjection(p, ctx) {
    ctx = ctx || {};
    if (!p || !p.event_key || !p.start_utc) return null;
    var o = obj(p.outcome), fair = obj(p.fair), ps = obj(p.projected_score), m = obj(p.model), sp = obj(fair.spread), tot = obj(fair.total);
    var val = {};
    Object.keys(obj(obj(p.validation).markets)).forEach(function (k) { var v = p.validation.markets[k] || {}; val[k] = { state: v.state || null, market_test: v.market_test || null, value_claims: !!v.value_claims, n: num(v.n) }; });
    var unc = obj(p.uncertainty);
    var row = {
      schema: SNAPSHOT_SCHEMA,
      event_key: p.event_key, sport: p.sport, league: p.league || null, event_id: str(p.event_id),
      home: { name: obj(p.home).name || null, abbr: obj(p.home).abbr || null }, away: { name: obj(p.away).name || null, abbr: obj(p.away).abbr || null },
      neutral: !!p.neutral, start_utc: isoOf(p.start_utc),
      model: { id: m.id || null, version: m.version || null, artifact: m.artifact || null, predicted_at: isoOf(m.predicted_at), artifact_generated_at: isoOf(m.artifact_generated_at),
        params_generated_at: isoOf(m.params_generated_at), inputs_known_at: m.inputs_known_at || null, market_inputs: Array.isArray(m.market_inputs) ? m.market_inputs : [] },
      forecast: {
        p_home: r(num(o.p_home)), p_away: r(num(o.p_away)), p_draw: r(num(o.p_draw)), p_overtime: r(num(o.p_overtime)), settles: o.settles || null,
        fair_ml: obj(fair.moneyline).home != null ? { home: num(fair.moneyline.home), away: num(fair.moneyline.away) } : null,
        fair_home_line: r(num(sp.home_line), 2), fair_total: r(num(tot.line), 2), expected_total: r(num(tot.expected), 2),
        projected_score: (num(ps.home) != null || num(ps.margin) != null) ? { home: r(num(ps.home), 2), away: r(num(ps.away), 2), margin: r(num(ps.margin), 2), total: r(num(ps.total), 2), basis: ps.basis || null } : null,
        margin_sd: r(num(unc.margin_sd), 2)
      },
      readiness: {
        research: obj(p.research).outcome || null, reasons: (obj(p.research).reasons || []).slice(0, 6),
        freshness: obj(p.freshness).state || null, age_hours: r(num(obj(p.freshness).age_hours), 1),
        invalidated: !!obj(p.integrity).invalidated, availability: obj(p.availability).certainty || null,
        validation: val, limitations: (p.limitations || []).slice(0, 4)
      },
      quote: ctx.quote && toMs(ctx.quote.captured_at) != null && toMs(ctx.quote.captured_at) < toMs(p.start_utc) ? ctx.quote : null,
      capture: { method: ctx.method || 'ledger_capture', captured_at: isoOf(ctx.captured_at), run: ctx.run || null, git_sha: ctx.git_sha || null,
        source: ctx.source || 'engine/build_projections.js', source_ref: ctx.source_ref || null,
        projection_id: p.projection_id || null, projection_hash: p.projection_hash || null }
    };
    row.signature = signatureOf(row);
    return row;
  }
  /** Is this snapshot admissible as a pregame forecast at all? */
  function pregameProblem(s, nowMs) {
    var st = toMs(s.start_utc);
    if (st == null) return 'NO_START';
    var cap = toMs(obj(s.capture).captured_at), pred = toMs(obj(s.model).predicted_at), rec = toMs(obj(s.capture).recorded_at);
    if (obj(s.capture).method === 'ledger_capture') {
      if (cap == null) return 'NO_CAPTURE_TIME';
      if (cap >= st) return 'CAPTURED_AFTER_START';
    } else if (rec == null && pred == null) return 'NO_PREGAME_TIME';
    if (pred != null && pred >= st) return 'PREDICTED_AFTER_START';
    if (rec != null && rec >= st) return 'RECORDED_AFTER_START';
    if (nowMs != null && obj(s.capture).method === 'ledger_capture' && nowMs >= st) return 'CAPTURED_AFTER_START';
    return null;
  }
  function tierOf(s) { return obj(s.capture).method === 'ledger_capture' ? 'VERIFIED' : 'RECORDED'; }
  function timeOf(s) { var c = obj(s.capture); return toMs(c.captured_at) != null ? toMs(c.captured_at) : toMs(c.recorded_at) != null ? toMs(c.recorded_at) : toMs(obj(s.model).predicted_at); }

  /**
   * The ONE snapshot graded in public. Verified snapshots outrank recorded
   * ones; within a tier, the latest before the actual start. A snapshot whose
   * recorded start differs from the actual start by more than 36 hours was a
   * forecast for a different date (a postponement) and is not eligible.
   */
  function designate(snaps, actualStart) {
    var st = toMs(actualStart);
    var ok = [], out = [];
    (snaps || []).forEach(function (s) {
      var start = st != null ? st : toMs(s.start_utc);
      var why = pregameProblem(Object.assign({}, s, { start_utc: new Date(start).toISOString() }), null);
      if (!why && st != null && toMs(s.start_utc) != null && Math.abs(toMs(s.start_utc) - st) > RESCHEDULE_HOURS * 3600e3) why = 'RESCHEDULED';
      if (why) out.push({ hash: s.hash || null, why: why }); else ok.push(s);
    });
    var pick = function (tier) { return ok.filter(function (s) { return tierOf(s) === tier; }).sort(function (a, b) { return timeOf(a) - timeOf(b) || (a.seq || 0) - (b.seq || 0); }).pop() || null; };
    var s = pick('VERIFIED') || pick('RECORDED');
    return { snapshot: s, tier: s ? tierOf(s) : null, revisions: ok.length, ineligible: out };
  }

  /* -------------------------------------------------------------- results */
  /** A slate (ESPN) event's status, with the forfeit kept apart: the slate maps
      a forfeit to FINAL, but a forfeit is no contest for a forecast. */
  function slateStatus(e) {
    var s = str(e && e.status).toUpperCase(), d = str(e && e.status_detail);
    if (/forfeit/i.test(d)) return 'FORFEIT';
    if (s === 'FINAL') return 'FINAL';
    if (s === 'CANCELED' || s === 'CANCELLED') return 'CANCELED';
    if (s === 'POSTPONED') return 'POSTPONED';
    if (s === 'SUSPENDED') return 'SUSPENDED';
    if (s === 'LIVE' || s === 'STARTED' || s === 'DELAYED') return 'LIVE';
    return 'SCHEDULED';
  }
  function intScore(v) { var n = num(v); return n != null && Number.isInteger(n) && n >= 0 && n <= 400 ? n : null; }
  /**
   * Every source's reading → one verdict.
   * cand: { source, status, home_score, away_score, start_utc, decided, read_at }
   *   status ∈ FINAL / CANCELED / POSTPONED / SUSPENDED / FORFEIT / LIVE / SCHEDULED
   * A final needs integer scores (0-0 is a placeholder) and every source that
   * has a final must agree; a disagreement is CONFLICT and settles nothing.
   */
  function resolveResult(cands, opts) {
    opts = opts || {};
    var nowMs = toMs(opts.now);
    var list = (cands || []).filter(Boolean);
    var finals = list.filter(function (c) { return c.status === 'FINAL' && intScore(c.home_score) != null && intScore(c.away_score) != null && !(+c.home_score === 0 && +c.away_score === 0); });
    var start = null;
    list.forEach(function (c) { var t = toMs(c.start_utc); if (t != null && (start == null || c.status === 'FINAL')) start = t; });
    var srcs = list.map(function (c) { return { source: c.source, status: c.status, home_score: intScore(c.home_score), away_score: intScore(c.away_score), read_at: isoOf(c.read_at) }; })
      .sort(function (a, b) { return a.source < b.source ? -1 : a.source > b.source ? 1 : 0; });
    if (list.some(function (c) { return c.status === 'FORFEIT'; })) return { state: 'VOID', void_reason: 'FORFEIT', sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
    if (finals.length) {
      var a = finals[0];
      var disagree = finals.some(function (c) { return +c.home_score !== +a.home_score || +c.away_score !== +a.away_score; });
      if (disagree) return { state: 'CONFLICT', sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
      var dec = null; finals.forEach(function (c) { if (c.decided) dec = c.decided; });
      return { state: 'FINAL', home_score: +a.home_score, away_score: +a.away_score, decided: dec, sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
    }
    if (list.some(function (c) { return c.status === 'CANCELED'; })) return { state: 'VOID', void_reason: 'CANCELED', sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
    var post = list.filter(function (c) { return c.status === 'POSTPONED' || c.status === 'SUSPENDED'; });
    if (post.length) {
      var since = toMs(opts.scheduled_start) != null ? toMs(opts.scheduled_start) : start;
      if (nowMs != null && since != null && nowMs - since > POSTPONED_VOID_DAYS * 86400e3) return { state: 'VOID', void_reason: 'POSTPONED_UNRESOLVED', sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
      return { state: 'PENDING', pending: post[0].status, sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
    }
    return { state: 'PENDING', pending: list.length ? 'NOT_FINAL' : 'NO_SOURCE', sources: srcs, start_utc: start != null ? new Date(start).toISOString() : null };
  }
  /** The fields that make a result a result: a change is a correction. */
  function resultSignature(res) {
    return JSON.stringify([res.event_key, res.state, res.void_reason || null, res.home_score == null ? null : res.home_score, res.away_score == null ? null : res.away_score]);
  }

  /* -------------------------------------------------------------- grading */
  function projectedMargin(f) {
    if (num(f.fair_home_line) != null) return -num(f.fair_home_line);
    var ps = obj(f.projected_score);
    if (num(ps.margin) != null) return num(ps.margin);
    return null;
  }
  /* the model's expected total. A hockey fair total is a priced half-goal line
     (6.5), not the expectation (6.47): for the NHL only an expectation counts */
  function projectedTotal(f, sport) {
    if (num(f.expected_total) != null) return num(f.expected_total);
    var ps = obj(f.projected_score);
    if (sport === 'nhl') return num(ps.total);
    if (num(f.fair_total) != null) return num(f.fair_total);
    return num(ps.total);
  }
  function sideResult(diff) { if (diff == null) return null; if (Math.abs(diff) < 1e-9) return 'push'; return diff > 0 ? 'win' : 'loss'; }
  function units(result, price) {
    /* no captured price, no units — a push included: it is not a priced bet either */
    var pp = profitPerUnit(price);
    if (pp == null) return null;
    if (result === 'push') return 0;
    return result === 'win' ? r(pp, 4) : result === 'loss' ? -1 : null;
  }
  function sourceFamily(s) { s = str(s).toLowerCase(); if (/nflverse/.test(s)) return 'nflverse'; if (/espn/.test(s)) return 'espn'; return s.split(/[\s:·_]/)[0] || null; }

  /**
   * One snapshot + one verified result → the grade. opts.close: a legitimate
   * closing line { home_line, total, source } (NFL/CFB football record only).
   */
  function gradeGame(s, res, opts) {
    opts = opts || {};
    var f = obj(s.forecast), rd = obj(s.readiness);
    var g = { schema: GRADE_SCHEMA, grader: GRADER_VERSION, event_key: s.event_key, sport: s.sport, forecast_hash: s.hash || null, forecast_tier: tierOf(s),
      result_hash: res.hash || null, eligible: true, why: null };
    if (res.state === 'VOID') { g.eligible = false; g.why = 'VOID_' + (res.void_reason || 'GAME'); return g; }
    if (rd.invalidated) { g.eligible = false; g.why = 'FLAGGED_PREGAME_INVALIDATED'; return g; }
    if (rd.research === 'DATA_INSUFFICIENT') { g.eligible = false; g.why = 'FLAGGED_PREGAME_DATA_INSUFFICIENT'; return g; }
    var hs = res.home_score, as = res.away_score, margin = hs - as, total = hs + as;
    g.final = { home_score: hs, away_score: as, margin: margin, total: total, decided: res.decided || null };
    var p = num(f.p_home);
    if (p != null) {
      var y = margin > 0 ? 1 : margin < 0 ? 0 : 'push';
      var fav = p > 0.5 + 1e-9 ? 'home' : p < 0.5 - 1e-9 ? 'away' : null;
      g.winner = { p_home: p, outcome: y, favourite: fav, favourite_p: fav ? r(Math.max(p, 1 - p)) : 0.5,
        correct: y === 'push' || !fav ? null : (fav === 'home') === (y === 1),
        brier: y === 'push' ? null : r((p - y) * (p - y), 6), log_loss: y === 'push' ? null : r(-(y * Math.log(clip(p)) + (1 - y) * Math.log(1 - clip(p))), 6) };
    }
    var pm = projectedMargin(f);
    if (pm != null) g.spread = { projected_margin: r(pm, 2), actual_margin: margin, error: r(margin - pm, 2), abs_error: r(Math.abs(margin - pm), 2) };
    var pt = projectedTotal(f, s.sport);
    if (pt != null) g.total = { projected_total: r(pt, 2), actual_total: total, error: r(total - pt, 2), abs_error: r(Math.abs(total - pt), 2) };

    /* THE MARKET — only a quote captured before the start, at or before the
       designated forecast (the snapshot carries the one it was compared with) */
    var q = s.quote;
    if (q && toMs(q.captured_at) != null && toMs(q.captured_at) < toMs(res.start_utc || s.start_utc)) {
      var mk = { book: q.book || null, source: q.source || null, captured_at: q.captured_at };
      if (q.spread && num(q.spread.home_point) != null) {
        var mline = num(q.spread.home_point), mm = -mline;
        mk.spread = { line: mline, market_margin: mm, market_abs_error: r(Math.abs(margin - mm), 2) };
        if (num(f.fair_home_line) != null) {
          var gap = r(mline - num(f.fair_home_line), 2);
          if (Math.abs(gap) > 1e-9) {
            var side = gap > 0 ? 'home' : 'away';
            var cover = side === 'home' ? margin + mline : -(margin + mline);
            var res1 = sideResult(cover);
            var price = side === 'home' ? q.spread.home_price : q.spread.away_price;
            mk.spread.pick = { side: side, gap: r(Math.abs(gap), 2), result: res1, price: num(price), units: units(res1, price) };
          }
        }
      }
      if (q.total && num(q.total.point) != null) {
        var mt = num(q.total.point), ft = s.sport === 'nhl' ? pt : num(f.fair_total) != null ? num(f.fair_total) : pt;
        mk.total = { line: mt, market_abs_error: r(Math.abs(total - mt), 2) };
        if (ft != null && Math.abs(ft - mt) > 1e-9) {
          var tside = ft > mt ? 'over' : 'under';
          var tres = sideResult(tside === 'over' ? total - mt : mt - total);
          var tprice = tside === 'over' ? q.total.over : q.total.under;
          mk.total.pick = { side: tside, gap: r(Math.abs(ft - mt), 2), result: tres, price: num(tprice), units: units(tres, tprice) };
        }
      }
      if (q.moneyline) {
        var ih = impliedOf(q.moneyline.home), ia = impliedOf(q.moneyline.away);
        if (ih != null && ia != null && margin !== 0) {
          var mp = ih / (ih + ia), yy = margin > 0 ? 1 : 0;
          mk.moneyline = { market_p_home: r(mp), market_brier: r((mp - yy) * (mp - yy), 6) };
        }
      }
      /* CLV: only against a legitimate close from the same source family */
      var c = opts.close;
      if (c && sourceFamily(c.source) && sourceFamily(c.source) === sourceFamily(q.source)) {
        mk.clv = { close_source: c.source || null };
        if (mk.spread && mk.spread.pick && num(c.home_line) != null) mk.clv.spread_pts = r(mk.spread.pick.side === 'home' ? mk.spread.line - num(c.home_line) : num(c.home_line) - mk.spread.line, 2);
        if (mk.total && mk.total.pick && num(c.total) != null) mk.clv.total_pts = r(mk.total.pick.side === 'over' ? num(c.total) - mk.total.line : mk.total.line - num(c.total), 2);
      }
      g.market = mk;
    }
    return g;
  }
  function gradeSignature(g) {
    return JSON.stringify([g.event_key, g.grader, g.forecast_hash, g.result_hash, g.eligible, g.why]);
  }

  /* -------------------------------------------------------- public row */
  /** The compact public row for one game (performance/data/games.json). */
  function publicRow(s, res, g, extra) {
    extra = extra || {};
    var f = obj(s.forecast), m = obj(s.model), c = obj(s.capture);
    return {
      event_key: s.event_key, sport: s.sport, league: s.league, home: obj(s.home).name || obj(s.home).abbr, away: obj(s.away).name || obj(s.away).abbr,
      start_utc: (res && res.start_utc) || s.start_utc, week: isoWeek((res && res.start_utc) || s.start_utc),
      model_version: m.id || m.version || null, tier: tierOf(s), revisions: extra.revisions || 1,
      forecast: { hash: s.hash || null, captured_at: c.captured_at || null, recorded_at: c.recorded_at || null, predicted_at: m.predicted_at || null, method: c.method || null, source: c.source || null,
        p_home: num(f.p_home), fair_home_line: num(f.fair_home_line), fair_total: num(f.fair_total), expected_total: num(f.expected_total),
        projected_score: f.projected_score ? { home: f.projected_score.home, away: f.projected_score.away } : null, research: obj(s.readiness).research || null },
      result: res ? { state: res.state, home_score: res.home_score == null ? null : res.home_score, away_score: res.away_score == null ? null : res.away_score, decided: res.decided || null,
        void_reason: res.void_reason || null, verified_at: res.verified_at || null, sources: (res.sources || []).map(function (x) { return x.source; }), revision: res.revision || 1 } : null,
      grade: g ? { eligible: g.eligible, why: g.why, winner: g.winner || null, spread: g.spread || null, total: g.total || null, market: g.market || null, revision: g.revision || 1 } : null
    };
  }

  /** Drop null and undefined members at every depth (0, false and '' stay): the public files carry only what is known. */
  function compact(v) {
    if (Array.isArray(v)) return v.map(compact);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { if (v[k] === null || v[k] === undefined) return; o[k] = compact(v[k]); }); return o; }
    return v;
  }

  /* -------------------------------------------------------------- metrics */
  function rate(k, n) { return n >= MIN_N ? r(k / n, 4) : null; }
  function errStats(list) {
    var n = list.length;
    if (n < MIN_N) return { n: n, mae: null, bias: null, rmse: null, sample_state: sampleState(n) };
    return { n: n, mae: r(mean(list.map(Math.abs)), 2), bias: r(mean(list), 2), rmse: r(Math.sqrt(mean(list.map(function (x) { return x * x; }))), 2), sample_state: sampleState(n) };
  }
  function calBuckets(list) {
    var out = [];
    for (var i = 0; i < CAL_EDGES.length - 1; i++) {
      var lo = CAL_EDGES[i], hi = CAL_EDGES[i + 1];
      var b = list.filter(function (x) { return x.p >= lo && x.p < hi; });
      if (!b.length) continue;
      var k = b.reduce(function (s, x) { return s + x.y; }, 0), mp = mean(b.map(function (x) { return x.p; }));
      var w = wilson(k, b.length);
      out.push({ from: r(lo, 2), to: r(Math.min(1, hi), 2), n: b.length, mean_predicted: r(mp), observed: r(k / b.length), wilson_low: w.low, wilson_high: w.high,
        inside_interval: w.low != null && mp >= w.low - 1e-9 && mp <= w.high + 1e-9 });
    }
    return out;
  }
  function pickRec(list) {
    var o = { n: 0, w: 0, l: 0, p: 0, pct: null, priced: 0, units: 0, roi: null, sample_state: null };
    list.forEach(function (x) { o.n++; if (x.result === 'win') o.w++; else if (x.result === 'loss') o.l++; else if (x.result === 'push') o.p++; if (x.units != null) { o.priced++; o.units += x.units; } });
    o.pct = rate(o.w, o.w + o.l);
    o.units = r(o.units, 3);
    o.roi = o.priced >= MIN_N ? r(o.units / o.priced, 4) : null;
    o.sample_state = sampleState(o.w + o.l);
    return o;
  }
  /**
   * rows: public rows (publicRow). Only eligible graded games count; the
   * eligibility counts say how many of what exists that is.
   */
  function metrics(rows, opts) {
    opts = opts || {};
    rows = rows || [];
    var elig = { games: rows.length, graded: 0, void: 0, flagged_pregame: 0, awaiting_result: 0, conflict: 0, by_why: {} };
    var g = [];
    rows.forEach(function (x) {
      var st = x.result && x.result.state;
      if (!x.grade) { if (st === 'CONFLICT') elig.conflict++; else if (st === 'VOID') elig.void++; else elig.awaiting_result++; return; }
      if (!x.grade.eligible) {
        if (/^VOID/.test(x.grade.why || '')) elig.void++; else elig.flagged_pregame++;
        elig.by_why[x.grade.why] = (elig.by_why[x.grade.why] || 0) + 1; return;
      }
      elig.graded++; g.push(x);
    });
    /* WINNER */
    var W = g.filter(function (x) { return x.grade.winner; });
    var scored = W.filter(function (x) { return x.grade.winner.outcome !== 'push'; }).map(function (x) { return { p: x.grade.winner.p_home, y: x.grade.winner.outcome }; });
    var picked = W.filter(function (x) { return x.grade.winner.correct != null; });
    var correct = picked.filter(function (x) { return x.grade.winner.correct; }).length;
    var winner = { n: W.length, called: picked.length, correct: correct, pct: rate(correct, picked.length), ties: W.length - scored.length,
      scored: scored.length,
      brier: scored.length >= MIN_N ? r(mean(scored.map(function (x) { return (x.p - x.y) * (x.p - x.y); })), 4) : null,
      log_loss: scored.length >= MIN_N ? r(mean(scored.map(function (x) { return -(x.y * Math.log(clip(x.p)) + (1 - x.y) * Math.log(1 - clip(x.p))); })), 4) : null,
      sample_state: sampleState(scored.length), calibration: scored.length >= MIN_N ? calBuckets(scored) : [],
      bands: CONF_BANDS.map(function (b) {
        var L = picked.filter(function (x) { var fp = x.grade.winner.favourite_p; return fp >= b[0] && fp < b[1]; });
        var k = L.filter(function (x) { return x.grade.winner.correct; }).length;
        return { from: b[0], to: Math.min(1, b[1]), n: L.length, correct: k, pct: rate(k, L.length), mean_p: L.length ? r(mean(L.map(function (x) { return x.grade.winner.favourite_p; })), 4) : null };
      }) };
    /* ERRORS */
    var margin = errStats(g.filter(function (x) { return x.grade.spread; }).map(function (x) { return x.grade.spread.error; }));
    var total = errStats(g.filter(function (x) { return x.grade.total; }).map(function (x) { return x.grade.total.error; }));
    /* MARKET — same games only */
    var MS = g.filter(function (x) { return x.grade.market && x.grade.market.spread && x.grade.spread; });
    var MT = g.filter(function (x) { return x.grade.market && x.grade.market.total && x.grade.total; });
    var MM = g.filter(function (x) { return x.grade.market && x.grade.market.moneyline && x.grade.winner && x.grade.winner.brier != null; });
    var near = function (L, a, b) { return L.filter(function (x) { return a(x) < b(x) - 1e-9; }).length; };
    var market = {
      spread: { n: MS.length, model_mae: MS.length >= MIN_N ? r(mean(MS.map(function (x) { return x.grade.spread.abs_error; })), 2) : null, market_mae: MS.length >= MIN_N ? r(mean(MS.map(function (x) { return x.grade.market.spread.market_abs_error; })), 2) : null,
        model_nearer: near(MS, function (x) { return x.grade.spread.abs_error; }, function (x) { return x.grade.market.spread.market_abs_error; }),
        market_nearer: near(MS, function (x) { return x.grade.market.spread.market_abs_error; }, function (x) { return x.grade.spread.abs_error; }), sample_state: sampleState(MS.length) },
      total: { n: MT.length, model_mae: MT.length >= MIN_N ? r(mean(MT.map(function (x) { return x.grade.total.abs_error; })), 2) : null, market_mae: MT.length >= MIN_N ? r(mean(MT.map(function (x) { return x.grade.market.total.market_abs_error; })), 2) : null,
        model_nearer: near(MT, function (x) { return x.grade.total.abs_error; }, function (x) { return x.grade.market.total.market_abs_error; }),
        market_nearer: near(MT, function (x) { return x.grade.market.total.market_abs_error; }, function (x) { return x.grade.total.abs_error; }), sample_state: sampleState(MT.length) },
      moneyline: { n: MM.length, model_brier: MM.length >= MIN_N ? r(mean(MM.map(function (x) { return x.grade.winner.brier; })), 4) : null, market_brier: MM.length >= MIN_N ? r(mean(MM.map(function (x) { return x.grade.market.moneyline.market_brier; })), 4) : null, sample_state: sampleState(MM.length) }
    };
    /* PICK RECORDS at the captured market line */
    var picks = { spread: [], total: [] };
    ['spread', 'total'].forEach(function (k) {
      var all = g.filter(function (x) { return x.grade.market && x.grade.market[k] && x.grade.market[k].pick; }).map(function (x) { return x.grade.market[k].pick; });
      PICK_GAPS.forEach(function (gap) { var o = pickRec(all.filter(function (p) { return p.gap >= gap - 1e-9 && p.gap > 0; })); o.min_gap = gap; picks[k].push(o); });
    });
    /* CLV in points, where a legitimate close exists */
    var clvAgg = function (key) {
      var v = g.map(function (x) { return x.grade.market && x.grade.market.clv ? x.grade.market.clv[key] : null; }).filter(function (x) { return x != null; });
      return { n: v.length, avg_pts: v.length >= MIN_N ? r(mean(v), 2) : null, beat: v.filter(function (x) { return x > 0; }).length, flat: v.filter(function (x) { return x === 0; }).length, lost: v.filter(function (x) { return x < 0; }).length, sample_state: sampleState(v.length) };
    };
    /* TREND by ISO week (or month). Each period prints its own counts; the
       rates are CUMULATIVE through the period, so a thin week never prints a
       percentage of its own (a rate needs MIN_N observations behind it). */
    var by = {};
    var periodOf = opts.period === 'month' ? monthOf : isoWeek;
    g.forEach(function (x) { var k = periodOf(x.start_utc); if (!k) return; (by[k] = by[k] || []).push(x); });
    var cum = { called: 0, correct: 0, b: [], m: [], t: [] };
    var trend = Object.keys(by).sort().map(function (k) {
      var L = by[k];
      var Wp = L.filter(function (x) { return x.grade.winner && x.grade.winner.correct != null; });
      var Wb = L.filter(function (x) { return x.grade.winner && x.grade.winner.brier != null; });
      var Sm = L.filter(function (x) { return x.grade.spread; }), Tt = L.filter(function (x) { return x.grade.total; });
      var c = Wp.filter(function (x) { return x.grade.winner.correct; }).length;
      cum.called += Wp.length; cum.correct += c;
      Wb.forEach(function (x) { cum.b.push(x.grade.winner.brier); });
      Sm.forEach(function (x) { cum.m.push(x.grade.spread.abs_error); });
      Tt.forEach(function (x) { cum.t.push(x.grade.total.abs_error); });
      return { period: k, n: L.length, called: Wp.length, correct: c,
        margin_n: Sm.length, margin_mae: Sm.length ? r(mean(Sm.map(function (x) { return x.grade.spread.abs_error; })), 2) : null,
        total_n: Tt.length, total_mae: Tt.length ? r(mean(Tt.map(function (x) { return x.grade.total.abs_error; })), 2) : null,
        cum_called: cum.called, cum_correct: cum.correct, cum_pct: rate(cum.correct, cum.called),
        cum_brier: cum.b.length >= MIN_N ? r(mean(cum.b), 4) : null, cum_margin_mae: cum.m.length >= MIN_N ? r(mean(cum.m), 2) : null, cum_total_mae: cum.t.length >= MIN_N ? r(mean(cum.t), 2) : null };
    });
    return { schema: VERSION + ':metrics', min_n: MIN_N, eligibility: elig, winner: winner, margin: margin, total: total, market: market, picks: picks,
      clv: { spread: clvAgg('spread_pts'), total: clvAgg('total_pts') }, trend: trend };
  }

  /** Filter public rows the way the page's controls do. */
  function filterRows(rows, f) {
    f = f || {};
    var from = toMs(f.from), to = toMs(f.to);
    return (rows || []).filter(function (x) {
      if (f.sport && f.sport !== 'all' && x.sport !== f.sport) return false;
      if (f.tier && f.tier !== 'all' && x.tier !== f.tier) return false;
      if (f.model && f.model !== 'all' && x.model_version !== f.model) return false;
      var t = toMs(x.start_utc);
      if (from != null && (t == null || t < from)) return false;
      if (to != null && (t == null || t >= to)) return false;
      if (f.type && f.type !== 'all' && x.grade && x.grade.eligible) {
        if (f.type === 'winner' && !x.grade.winner) return false;
        if (f.type === 'spread' && !x.grade.spread) return false;
        if (f.type === 'total' && !x.grade.total) return false;
        if (f.type === 'market' && !x.grade.market) return false;
      }
      if (f.q) {
        var q = normName(f.q);
        if (normName([x.home, x.away, x.event_key, x.league].join(' ')).indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  /** Sample-state wording the page prints next to a figure. */
  var STATE_LABEL = { TOO_EARLY: 'Too early to read', EARLY_SIGNAL: 'Early signal', DEVELOPING: 'Developing', MEANINGFUL: 'Meaningful sample' };

  return {
    VERSION: VERSION, GRADER_VERSION: GRADER_VERSION, SNAPSHOT_SCHEMA: SNAPSHOT_SCHEMA, QUOTE_SCHEMA: QUOTE_SCHEMA, RESULT_SCHEMA: RESULT_SCHEMA, GRADE_SCHEMA: GRADE_SCHEMA,
    RESCHEDULE_HOURS: RESCHEDULE_HOURS, POSTPONED_VOID_DAYS: POSTPONED_VOID_DAYS, MIN_N: MIN_N, TIERS: TIERS, TYPES: TYPES, PICK_GAPS: PICK_GAPS, CONF_BANDS: CONF_BANDS, STATE_LABEL: STATE_LABEL,
    num: num, toMs: toMs, isoOf: isoOf, isoWeek: isoWeek, monthOf: monthOf, normName: normName, sportOfKey: sportOfKey, sampleState: sampleState, profitPerUnit: profitPerUnit, sourceFamily: sourceFamily,
    quoteFromSlate: quoteFromSlate, signatureOf: signatureOf, snapshotFromProjection: snapshotFromProjection, pregameProblem: pregameProblem, tierOf: tierOf, designate: designate,
    slateStatus: slateStatus, resolveResult: resolveResult, resultSignature: resultSignature,
    projectedMargin: projectedMargin, projectedTotal: projectedTotal, gradeGame: gradeGame, gradeSignature: gradeSignature,
    publicRow: publicRow, compact: compact, metrics: metrics, filterRows: filterRows
  };
});
