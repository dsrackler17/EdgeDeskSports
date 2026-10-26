/* ===========================================================================
   EdgeDesk MODEL INTEGRITY AUDIT — every published projection, checked
   against its own inputs and against the market at the time it was made.
   docs/system-integrity/MODEL_INTEGRITY.md is the narrative; this file is
   the contract.

   WHAT IT ANSWERS, PER GAME
     Is the number built on current, complete, correct inputs? How far is it
     from the market, measured against a quote taken before the projection?
     And what does the record say that distance is worth? It never changes a
     number, a label or a decision: it classifies, and callers show it.

   THE CLASSIFICATIONS, in precedence order (a game carries every one that
   applies; `status` is the first):
     INPUT_ERROR                 an input is wrong: a player on two teams, a
                                 priced starter who cannot play, a CONFIRMED
                                 label on an unconfirmed side
     STALE_DATA                  the projection, its roster or the market it is
                                 compared with is older than its limit
     MISSING_CRITICAL_INPUT      a decision-critical input is unknown: a starting
                                 QB or goalie unconfirmed, no injury feed in the
                                 price, a player whose status moves the number
                                 left unresolved
     CALIBRATION_WARNING         the model's measured record is off where this
                                 game sits (a probability bucket outside its
                                 interval), or the price leans on a prior
     LARGE_MARKET_DISAGREEMENT   the model is further from the market than the
                                 sport's review threshold. An investigation
                                 trigger, never proof of an error
     INSUFFICIENT_EVIDENCE       a large disagreement that no input check
                                 explains and no validated record supports
     VALIDATED_INDEPENDENT_SIGNAL a large disagreement on clean inputs in a
                                 market whose validation passed against the
                                 close AND whose disagreement record above the
                                 threshold beats the price's break-even at its
                                 lower 95% bound (MI.signalRule). Never a label
                                 for a gap alone.

   MARKET DISAGREEMENT IS NOT AN ERROR. The market is never treated as
   correct: a disagreement is classified, explained when an input explains it,
   and otherwise left as a question.

   TIMESTAMP-MATCHED. The market a projection is compared with is the latest
   quote captured at or before the projection's own predicted_at (and within
   quote.max_age_hours of it); the latest quote before the start is shown
   beside it. A projection with no quote before it is compared with nothing.

   Odds arithmetic is lib/edgedesk_calc.js (EDCalc), the canonical layer.
   Browser: window.EDModelIntegrity (load edgedesk_calc.js first).
   Node: require('./edgedesk_model_integrity.js').
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edgedesk_calc.js'));
  else root.EDModelIntegrity = factory(root.EDCalc);
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (CALC) {
  'use strict';
  if (!CALC) throw new Error('EDModelIntegrity needs EDCalc (lib/edgedesk_calc.js) loaded first');
  var MI = { VERSION: 'edgedesk_model_integrity/1', SCHEMA: 'edgedesk_model_integrity_v1' };

  MI.CODES = ['INPUT_ERROR', 'STALE_DATA', 'MISSING_CRITICAL_INPUT', 'CALIBRATION_WARNING', 'LARGE_MARKET_DISAGREEMENT', 'INSUFFICIENT_EVIDENCE', 'VALIDATED_INDEPENDENT_SIGNAL'];
  MI.LABEL = {
    INPUT_ERROR: 'Input error', STALE_DATA: 'Stale data', MISSING_CRITICAL_INPUT: 'Critical input missing',
    CALIBRATION_WARNING: 'Calibration under review', LARGE_MARKET_DISAGREEMENT: 'Major model-market disagreement',
    INSUFFICIENT_EVIDENCE: 'Disagreement unexplained, not validated', VALIDATED_INDEPENDENT_SIGNAL: 'Validated independent signal'
  };

  /* The review thresholds (engine/model_integrity_config.json carries the
     operating copy). Investigation triggers, not statistical proof. */
  MI.DEFAULTS = {
    thresholds: { nba: { spread_pts: 3 }, nfl: { spread_pts: 3 }, cfb: { spread_pts: 5 }, nhl: { ml_pp: 5, total_goals: 0.5 } },
    quote: { max_age_hours: 24 },
    signal: { states: ['MARKET_VALIDATED'], market_test: ['TESTED_AHEAD'], min_n: 200, break_even: 0.5238 }
  };

  function num(x) { return CALC.num(x); }
  function r(x, d) { x = num(x); if (x === null) return null; var k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; }
  function ms(t) { if (t === null || t === undefined || t === '') return null; var v = typeof t === 'number' ? t : Date.parse(t); return isFinite(v) ? v : null; }
  function iso(t) { var v = ms(t); return v === null ? null : new Date(v).toISOString(); }
  function merge(a, b) { var o = {}, k; for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k]; for (k in (b || {})) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; return o; }
  MI.config = function (c) {
    c = c || {};
    var th = {}, k;
    for (k in MI.DEFAULTS.thresholds) th[k] = merge(MI.DEFAULTS.thresholds[k], c.thresholds && c.thresholds[k]);
    return { thresholds: th, quote: merge(MI.DEFAULTS.quote, c.quote), signal: merge(MI.DEFAULTS.signal, c.signal) };
  };

  /* ---------------------------------------------------------------- the market
     One captured quote → the numbers a comparison needs, each from EDCalc:
     implied probability of each side (vig in), the multiplicative no-vig pair,
     and the overround. A side with no price is null, never filled. */
  MI.market = function (q) {
    if (!q) return null;
    var ml = q.moneyline || {}, sp = q.spread || {}, tot = q.total || {};
    var nv = CALC.noVigTwoWay(ml.home, ml.away);
    var homePt = num(sp.home_point != null ? sp.home_point : (sp.home && sp.home.point));
    return {
      source: q.source || null, book: q.book || null, captured_at: iso(q.captured_at), event_key: q.event_key || null,
      spread_home: homePt, total: num(tot.point),
      ml_home: num(ml.home), ml_away: num(ml.away),
      implied_home: r(CALC.impliedFromAmerican(ml.home), 4), implied_away: r(CALC.impliedFromAmerican(ml.away), 4),
      novig_home: nv ? r(nv.a, 4) : null, novig_away: nv ? r(nv.b, 4) : null, overround: nv ? r(nv.overround, 4) : null
    };
  };
  /* The quote a projection is compared with: the latest captured at or before
     predicted_at and no more than max_age_hours before it; the latest before
     the start beside it. Quotes captured after the start are never used. */
  MI.pickQuotes = function (quotes, predictedAt, startAt, cfg) {
    cfg = MI.config(cfg);
    var p = ms(predictedAt), s = ms(startAt), lim = cfg.quote.max_age_hours * 3600e3;
    var ok = (quotes || []).filter(function (q) { var t = ms(q && q.captured_at); return t !== null && (s === null || t < s); })
      .sort(function (a, b) { return ms(a.captured_at) - ms(b.captured_at); });
    var at = null, latest = ok.length ? ok[ok.length - 1] : null;
    if (p !== null) ok.forEach(function (q) { var t = ms(q.captured_at); if (t <= p && p - t <= lim) at = q; });
    return { at_prediction: MI.market(at), latest: MI.market(latest),
      basis: at ? 'the latest quote captured at or before the projection (' + r((p - ms(at.captured_at)) / 3600e3, 1) + ' h before it)'
        : (latest ? 'no quote within ' + cfg.quote.max_age_hours + ' h before the projection; the latest quote is shown, not compared' : 'no quote on file') };
  };

  /* --------------------------------------------------------- disagreement
     model − market on the market's own line. Home-line convention: negative
     is the home side favoured. Probability gaps are in percentage points. */
  /* the model's unrounded margin (projected_score.margin, + = home) where the
     contract carries it — never the half-point display line, whose rounding
     can carry a game across a threshold — else its fair home line */
  MI.modelHomeLine = function (proj) {
    var ps = proj && proj.projected_score, f = proj && proj.fair || {};
    if (ps && num(ps.margin) !== null) return -num(ps.margin);
    return num(f.spread && f.spread.home_line);
  };
  MI.disagreement = function (sport, proj, m) {
    if (!proj || !m) return null;
    var f = proj.fair || {}, o = proj.outcome || {};
    var mh = MI.modelHomeLine(proj), mt = num(f.total && (f.total.expected != null ? f.total.expected : f.total.line)), ph = num(o.p_home);
    return {
      spread_pts: mh !== null && m.spread_home !== null ? r(mh - m.spread_home, 2) : null,
      total_pts: mt !== null && m.total !== null ? r(mt - m.total, 2) : null,
      win_prob_pp: ph !== null && m.novig_home !== null ? r(100 * (ph - m.novig_home), 1) : null,
      model: { home_line: mh, total: mt, p_home: ph },
      market: { home_line: m.spread_home, total: m.total, novig_home: m.novig_home, captured_at: m.captured_at, book: m.book }
    };
  };
  /* is this disagreement past the sport's review threshold? → the reasons */
  MI.overThreshold = function (sport, d, cfg) {
    cfg = MI.config(cfg);
    var t = cfg.thresholds[sport], out = [];
    if (!t || !d) return out;
    if (t.spread_pts != null && d.spread_pts !== null && Math.abs(d.spread_pts) > t.spread_pts) out.push({ market: 'spread', gap: d.spread_pts, threshold: t.spread_pts, unit: 'points' });
    if (t.ml_pp != null && d.win_prob_pp !== null && Math.abs(d.win_prob_pp) > t.ml_pp) out.push({ market: 'moneyline', gap: d.win_prob_pp, threshold: t.ml_pp, unit: 'percentage points against the no-vig price' });
    if (t.total_goals != null && d.total_pts !== null && Math.abs(d.total_pts) > t.total_goals) out.push({ market: 'total', gap: d.total_pts, threshold: t.total_goals, unit: 'goals' });
    return out;
  };

  /* ------------------------------------------------- the signal rule
     VALIDATED_INDEPENDENT_SIGNAL only when ALL hold:
       1  the market's validation state is MARKET_VALIDATED and its test against
          the close is TESTED_AHEAD (engine/registry.json via the projection);
       2  the sport's measured record for disagreements above this threshold
          (thresholdRecord) has n ≥ min_n and its model-side cover rate's
          Wilson 95% lower bound is above the −110 break-even;
       3  nothing on the game is an INPUT_ERROR, STALE_DATA or
          MISSING_CRITICAL_INPUT.
     → { ok, reasons[] } — the reasons say which condition failed. */
  MI.signalRule = function (validation, record, blockers, cfg) {
    cfg = MI.config(cfg);
    var why = [];
    if (!validation || cfg.signal.states.indexOf(validation.state) < 0) why.push('the market is ' + ((validation && validation.state) || 'unvalidated') + ', not ' + cfg.signal.states.join('/'));
    if (!validation || cfg.signal.market_test.indexOf(validation.market_test) < 0) why.push('its test against the close is ' + ((validation && validation.market_test) || 'missing') + ', not ' + cfg.signal.market_test.join('/'));
    var rec = record && record.above ? record.above : record, side = rec ? rec.model_side_cover || rec.model_side_won || null : null;
    if (!rec || !(rec.n >= cfg.signal.min_n)) why.push('the disagreement record above the threshold has ' + (rec && rec.n != null ? rec.n : 0) + ' games (needs ' + cfg.signal.min_n + ')');
    else if (!(side && side.wilson95 && side.wilson95[0] > cfg.signal.break_even))
      why.push('the model side won ' + (side ? r(100 * side.rate, 1) + '%' : '—') + ' above the threshold, lower 95% bound not above ' + r(100 * cfg.signal.break_even, 2) + '%');
    if (blockers && blockers.length) why.push('the inputs are not clean (' + blockers.join(', ') + ')');
    return { ok: !why.length, reasons: why };
  };

  /* ------------------------------------------------------------ one game
     input = {
       sport, projection (EDPROJ contract row), quotes: [ledger / slate quotes],
       checks: [{ code, severity, component, message, evidence }] — the
               sport's own input checks (tools/model_integrity/build.js),
       assumptions: { … } — who and what the number assumed, for display,
       record: thresholdRecord for this sport's primary market (or null),
       now
     } → the audit record. */
  MI.auditGame = function (input, cfg) {
    cfg = MI.config(cfg);
    var p = input.projection || {}, sport = input.sport || p.sport, m = p.model || {}, now = ms(input.now) || Date.now();
    var cls = (input.checks || []).filter(function (c) { return c && MI.CODES.indexOf(c.code) >= 0; }).slice();
    var add = function (code, severity, component, message, evidence, chip) { cls.push({ code: code, severity: severity, component: component, message: message, evidence: evidence || null, chip: chip || MI.LABEL[code] }); };
    cls.forEach(function (c) { if (!c.chip) c.chip = MI.LABEL[c.code]; });

    /* the projection's own contract (lib/edgedesk_projections.js) */
    var fr = p.freshness || {};
    if (fr.state && fr.state !== 'FRESH') add('STALE_DATA', 'high', 'projection freshness (' + (m.artifact || 'artifact') + ')', 'The projection is ' + String(fr.state).toLowerCase() + ': ' + (fr.why || 'older than its limit') + '.', { artifact_generated_at: fr.artifact_generated_at || null, max_age_hours: fr.max_age_hours || null }, 'Projection stale');
    ((p.integrity && p.integrity.conflicts) || []).forEach(function (c) {
      add('MISSING_CRITICAL_INPUT', 'high', 'starter check (lib/edgedesk_projections.js)', c.detail || 'Sources disagree on a starter the projection priced.', { kind: c.kind || null, assumed: c.assumed || null, current: c.current || null },
        sport === 'nfl' || sport === 'cfb' ? 'Starting QB unconfirmed' : sport === 'nhl' ? 'Starting goalie unconfirmed' : 'Starter unconfirmed');
    });

    /* the market, timestamp-matched */
    var mk = MI.pickQuotes(input.quotes, m.predicted_at, p.start_utc, cfg);
    var ref = mk.at_prediction;
    var dis = ref ? MI.disagreement(sport, p, ref) : null;
    var over = MI.overThreshold(sport, dis, cfg);

    var blockers = cls.filter(function (c) { return c.code === 'INPUT_ERROR' || c.code === 'STALE_DATA' || c.code === 'MISSING_CRITICAL_INPUT'; }).map(function (c) { return c.code; });
    var signal = null;
    if (over.length) {
      over.forEach(function (o) {
        add('LARGE_MARKET_DISAGREEMENT', 'medium', 'model vs market (' + o.market + ')',
          'EdgeDesk is ' + Math.abs(o.gap) + ' ' + o.unit + ' from the market on the ' + o.market + ' (review threshold ' + o.threshold + '). An investigation trigger, not proof that either number is wrong.',
          { gap: o.gap, threshold: o.threshold, market_captured_at: ref.captured_at, book: ref.book }, 'Major model-market disagreement');
      });
      var v = p.validation && p.validation.markets ? p.validation.markets[over[0].market] || null : null;
      signal = MI.signalRule(v, input.record || null, blockers.filter(function (x, i, a) { return a.indexOf(x) === i; }), cfg);
      if (signal.ok) add('VALIDATED_INDEPENDENT_SIGNAL', 'info', 'signal rule (MI.signalRule)', 'A large disagreement on clean inputs, in a market validated against the close, where the record above the threshold beats the break-even.', { record: input.record || null });
      else if (!blockers.length) add('INSUFFICIENT_EVIDENCE', 'medium', 'signal rule (MI.signalRule)', 'No input check explains the disagreement, and no validated record says it is worth acting on: ' + signal.reasons.join('; ') + '.', { reasons: signal.reasons }, 'Disagreement not validated');
    }

    var rank = function (c) { return MI.CODES.indexOf(c.code); };
    var sev = { high: 0, medium: 1, warn: 1, low: 2, info: 3 };
    cls.sort(function (a, b) { return rank(a) - rank(b) || (sev[a.severity] == null ? 9 : sev[a.severity]) - (sev[b.severity] == null ? 9 : sev[b.severity]); });
    var codes = cls.map(function (c) { return c.code; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    var val = p.validation && p.validation.markets ? p.validation.markets : {};
    return {
      sport: sport, event_key: p.event_key || null, slate_id: input.slate_id || null, start_utc: iso(p.start_utc),
      home: p.home ? (p.home.abbr || p.home.name || null) : null, away: p.away ? (p.away.abbr || p.away.name || null) : null,
      status: codes.length ? codes[0] : 'OK', codes: codes, classifications: cls,
      /* the reader's chips: one per distinct label, in precedence order */
      chips: cls.map(function (c) { return { code: c.code, label: c.chip, severity: c.severity }; }).filter(function (c, i, a) { return a.map(function (x) { return x.label; }).indexOf(c.label) === i; }),
      model: { id: m.id || null, version: m.version || null, artifact: m.artifact || null, predicted_at: iso(m.predicted_at), data_cutoff: m.inputs_known_at || null,
        params_generated_at: m.params_generated_at || null, market_inputs: m.market_inputs || [],
        home_line: MI.modelHomeLine(p), display_home_line: num(p.fair && p.fair.spread && p.fair.spread.home_line), total: num(p.fair && p.fair.total && (p.fair.total.expected != null ? p.fair.total.expected : p.fair.total.line)),
        p_home: num(p.outcome && p.outcome.p_home), uncertainty: p.uncertainty ? { model_sd: num(p.uncertainty.model_sd), calibration_sd: num(p.uncertainty.calibration_sd), lineup_sd: num(p.uncertainty.lineup_sd), margin_sd: num(p.uncertainty.margin_sd) } : null },
      freshness: { state: fr.state || null, age_hours: num(fr.age_hours), max_age_hours: num(fr.max_age_hours), roster: input.roster_freshness || null, injury_feed: input.injury_feed || null },
      assumptions: input.assumptions || null,
      market: { compared: ref, latest: mk.latest, basis: mk.basis },
      disagreement: dis ? { spread_pts: dis.spread_pts, total_pts: dis.total_pts, win_prob_pp: dis.win_prob_pp, over_threshold: over } : null,
      calibration: Object.keys(val).map(function (k) { return { market: k, state: val[k].state || null, market_test: val[k].market_test || null, value_claims: val[k].value_claims === true }; }),
      signal_rule: signal,
      audited_at: new Date(now).toISOString()
    };
  };

  /* ------------------------------------------------- threshold validation
     rows: { model_home_line, market_home_line, final_margin } (spread sports),
     or { model_p_home, market_novig_home, home_won } / { model_total,
     market_total, final_total } (NHL). For each group (above / at-or-below
     the threshold): n, the model's and the market's MAE, how often the model
     was closer, and how often the model's side covered the market line
     (pushes out) with a Wilson 95% interval. Chronology is the caller's:
     every row is a projection made before its game, graded after it. */
  function wilson(k, n) { if (!n) return null; var z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r((c - w) / d, 4), r((c + w) / d, 4)]; }
  MI.wilson = wilson;
  MI.thresholdRecord = function (rows, kind, threshold) {
    var above = [], below = [];
    (rows || []).forEach(function (x) {
      var g = kind === 'spread' ? num(x.model_home_line) - num(x.market_home_line) : kind === 'total' ? num(x.model_total) - num(x.market_total) : 100 * (num(x.model_p_home) - num(x.market_novig_home));
      if (!isFinite(g)) return;
      (Math.abs(g) > threshold ? above : below).push({ x: x, g: g });
    });
    function stats(list) {
      var n = list.length, out = { n: n };
      if (!n) return out;
      if (kind === 'moneyline') {
        var bm = 0, bk = 0; list.forEach(function (o) { var y = o.x.home_won ? 1 : 0; bm += Math.pow(o.x.model_p_home - y, 2); bk += Math.pow(o.x.market_novig_home - y, 2); });
        out.brier_model = r(bm / n, 4); out.brier_market = r(bk / n, 4);
        var kk = 0; list.forEach(function (o) { var y = o.x.home_won ? 1 : 0; if ((o.g > 0 && y) || (o.g < 0 && !y)) kk++; });
        out.model_side_won = { k: kk, n: n, rate: r(kk / n, 4), wilson95: wilson(kk, n) };
        return out;
      }
      var em = 0, ek = 0, closer = 0, cov = 0, decided = 0;
      list.forEach(function (o) {
        var actual = kind === 'spread' ? num(o.x.final_margin) : num(o.x.final_total);
        var mod = kind === 'spread' ? -num(o.x.model_home_line) : num(o.x.model_total), mkt = kind === 'spread' ? -num(o.x.market_home_line) : num(o.x.market_total);
        em += Math.abs(actual - mod); ek += Math.abs(actual - mkt); if (Math.abs(actual - mod) < Math.abs(actual - mkt)) closer++;
        /* the model's side against the market line: home when the model's margin is above the market's (spread), over when its total is (total) */
        var res = actual - mkt; if (res === 0) return;
        decided++; if ((mod - mkt > 0) === (res > 0)) cov++;
      });
      out.mae_model = r(em / n, 3); out.mae_market = r(ek / n, 3); out.model_closer_share = r(closer / n, 4);
      out.model_side_cover = decided ? { k: cov, n: decided, rate: r(cov / decided, 4), wilson95: wilson(cov, decided) } : null;
      return out;
    }
    return { kind: kind, threshold: threshold, above: stats(above), at_or_below: stats(below) };
  };

  /* --------------------------------------------------------- the board */
  MI.summarize = function (audits) {
    var by = {}, sp = {};
    (audits || []).forEach(function (a) {
      by[a.status] = (by[a.status] || 0) + 1;
      var s = sp[a.sport] || (sp[a.sport] = { games: 0, by_status: {}, by_code: {} });
      s.games++; s.by_status[a.status] = (s.by_status[a.status] || 0) + 1;
      a.codes.forEach(function (c) { s.by_code[c] = (s.by_code[c] || 0) + 1; });
    });
    return { games: (audits || []).length, by_status: by, by_sport: sp };
  };
  return MI;
});
