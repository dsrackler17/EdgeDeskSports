/* ===========================================================================
   EdgeDesk CROSS-SPORT BOARD — the strongest SUPPORTED opportunity across
   every sport, or PASS. Research, not picks.

   Browser + Node (UMD: window.EDXBOARD). Pure: it reads candidates the sport
   brains produced, the readiness registry (engine/registry.json) and the
   clock, and returns a ranked board. It never fetches, never stakes, never
   says a result will happen.

   WHY NOT JUST SORT BY EV. Across thousands of markets the largest raw EV is
   mostly the largest ERROR: the optimiser's curse (Smith & Winkler 2006).
   Every candidate therefore goes through, in order:
     1. PRICE      an executable quote: a valid American price, from a named
                   book, captured inside the freshness window, before the start,
                   for a market whose settlement matches the model's.
     2. VALUE GATE the sport's market must be MARKET_VALIDATED in the registry
                   (beat the no-vig close out of sample), or the candidate must
                   be MARKET_DEVIG against a fresh sharp reference. Outcome
                   calibration alone never licenses a value claim.
     3. SHRINKAGE  the model probability is pulled toward the no-vig market by
                   k = τ²/(τ² + σ²): τ is how large real edges plausibly are
                   (default 1.5 points of probability), σ the candidate's own
                   uncertainty (model spread, calibration interval, lineup).
     4. SELECTION  the conservative probability subtracts z_N·σ_post, where
                   z_N = Φ⁻¹(1 − α/N) for the N priced candidates looked at: the
                   more markets scanned, the higher the bar.
     5. EV         expected value per unit at the ACTUAL price, with pushes
                   (EV = p_win·d − (1 − p_push)); qualified only if the
                   conservative EV clears `min_ev`. A raw EV above the sanity
                   ceiling is a DATA CHECK, never a bet.
     6. CORRELATION at most one opportunity per event; other markets on the
                   same game are listed as correlated, not stacked.
   The board ranks QUALIFIED candidates by conservative EV; probabilities from
   different sports are never compared as "confidence" — only EV at a price,
   after each sport's own validation has been applied.

   PASS is a normal answer: it says what was evaluated, why nothing qualified,
   and the price at which the strongest candidate would.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDXBOARD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var VERSION = 'edgedesk_xboard_v1';
  var DEFAULTS = { max_quote_age_min: 60, min_ev: 0.02, alpha: 0.10, prior_edge_sd: 0.015, sane_ev: { moneyline: 0.15, spread: 0.10, total: 0.10, team_total: 0.10, regulation_3way: 0.15 }, sharp_books: ['pinnacle', 'circasports', 'circa', 'betcris', 'bookmaker'], lineup_sd: { CONFIRMED: 0, PROJECTED_LIKELY: 0.005, PROJECTED_UNCERTAIN: 0.012, UNKNOWN: 0.02 } };

  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000; }
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  /* inverse standard normal (Acklam) */
  function qnorm(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var pl = 0.02425, q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  function fairWithPush(pw, pp) { pp = pp || 0; var pl = 1 - pw - pp; if (!(pw > 0) || !(pl > 0)) return null; return decToAm(1 + pl / pw); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ('00000000' + (h >>> 0).toString(16)).slice(-8); }
  function marketText(m) {
    var side = m.side, k = m.kind;
    if (k === 'moneyline') return side + ' moneyline';
    if (k === 'spread') return side + ' ' + (m.line > 0 ? '+' : '') + m.line;
    if (k === 'total') return side + ' ' + m.line;
    if (k === 'team_total') return (m.team || side) + ' team total ' + m.line;
    if (k === 'regulation_3way') return side + ' (60 minutes)';
    return k + ' ' + side;
  }

  function valueGate(c, registry, cfg) {
    if (c.model && c.model.method === 'MARKET_DEVIG') {
      if (!c.market_ref || c.market_ref.method !== 'sharp') return { ok: false, code: 'NO_SHARP_REFERENCE', reason: 'a market-only price needs a fresh sharp no-vig reference' };
      if (c.quote && c.market_ref.book && String(c.quote.book).toLowerCase() === String(c.market_ref.book).toLowerCase()) return { ok: false, code: 'SAME_BOOK', reason: 'the quote is the reference itself' };
      return { ok: true, code: 'MARKET_DEVIG', reason: 'priced against a fresh sharp no-vig reference (model-free)' };
    }
    var s = registry && registry.sports ? registry.sports.filter(function (x) { return x.id === c.sport_id; })[0] : null;
    if (!s) return { ok: false, code: 'NO_REGISTRY', reason: 'no readiness record for this sport' };
    var m = s.readiness && s.readiness.markets ? s.readiness.markets[c.market.kind === 'regulation_3way' ? 'regulation_3way' : c.market.kind] : null;
    if (!m) return { ok: false, code: 'NO_MODEL', reason: s.label + ' has no validated ' + c.market.kind + ' model' };
    if (!m.value_claims) return { ok: false, code: 'VALUE_DISABLED', reason: s.label + ' ' + c.market.kind + ' is ' + m.state.replace(/_/g, ' ').toLowerCase() + ' — ' + m.reason };
    return { ok: true, code: 'MARKET_VALIDATED', reason: s.label + ' ' + c.market.kind + ' beat the no-vig close out of sample' };
  }

  /**
   * evaluate({ candidates, registry, now, config }) → board
   * candidate: { sport_id, sport_label, event_key, event:{home,away,start_utc,label}, market:{kind,line,side,team,settles},
   *   quote:{book,american,captured_at,source,verified}|null, model:{p_win,p_push,method,model_id,sd,calibration},
   *   market_ref:{p_novig,method,book,books,captured_at}|null, data:{state,lineup_certainty}, evidence:[], invalidators:[] }
   */
  function evaluate(o) {
    var cfg = Object.assign({}, DEFAULTS, (o && o.config) || {});
    var now = o && o.now != null ? o.now : Date.now();
    var reg = o && o.registry;
    var all = ((o && o.candidates) || []).map(function (c) { return Object.assign({}, c); });
    /* 1 · price validity, first, so N counts only candidates actually priced */
    all.forEach(function (c) {
      c.gates = []; c.id = c.id || hash([c.sport_id, c.event_key, c.market.kind, c.market.side, c.market.line, c.quote && c.quote.book, c.quote && c.quote.american, c.quote && c.quote.captured_at].join('|'));
      c.label = (c.event && c.event.label ? c.event.label + ' — ' : '') + marketText(c.market);
      var pw = num(c.model && c.model.p_win), pp = num(c.model && c.model.p_push) || 0;
      c.fair_american = pw != null ? fairWithPush(pw, pp) : null;
      var start = Date.parse(c.event && c.event.start_utc);
      if (isFinite(start) && start <= now) { c.status = 'STARTED'; c.gates.push({ gate: 'PRICE', ok: false, code: 'STARTED', reason: 'the event has started' }); return; }
      if (!c.quote) { c.priced = false; c.gates.push({ gate: 'PRICE', ok: false, code: 'NO_PRICE', reason: 'no captured or supplied price for this market' }); return; }
      var dec = amToDec(c.quote.american);
      if (!dec) { c.priced = false; c.gates.push({ gate: 'PRICE', ok: false, code: 'BAD_PRICE', reason: 'the quote is not a valid American price' }); return; }
      var age = (now - Date.parse(c.quote.captured_at)) / 60000;
      c.quote_age_min = isFinite(age) ? Math.round(age) : null;
      if (!isFinite(age) || age > cfg.max_quote_age_min || age < -5) { c.priced = false; c.gates.push({ gate: 'PRICE', ok: false, code: 'STALE', reason: 'the price was captured ' + (isFinite(age) ? Math.round(age) + ' min ago' : 'at an unknown time') + ' (limit ' + cfg.max_quote_age_min + ')' }); return; }
      if (c.market.settles_mismatch) { c.priced = false; c.gates.push({ gate: 'PRICE', ok: false, code: 'SETTLEMENT', reason: c.market.settles_mismatch }); return; }
      c.priced = true; c.dec = dec;
      c.gates.push({ gate: 'PRICE', ok: true, code: 'FRESH', reason: (c.quote.book || 'book') + ' at ' + (c.quote.american > 0 ? '+' : '') + c.quote.american + ', ' + c.quote_age_min + ' min old' });
    });
    var priced = all.filter(function (c) { return c.priced; });
    var N = Math.max(1, priced.length);
    var zN = qnorm(1 - cfg.alpha / N);
    all.forEach(function (c) {
      var pw = num(c.model && c.model.p_win), pp = num(c.model && c.model.p_push) || 0;
      if (pw == null) { c.status = c.status || 'NO_MODEL'; return; }
      /* uncertainty: model spread + calibration interval + lineup */
      var sdModel = num(c.model.sd) || 0.02;
      var cal = c.model.calibration;
      var sdCal = cal && cal.wilson95 ? Math.max(0, (cal.wilson95[1] - cal.wilson95[0]) / (2 * 1.96)) : 0.015;
      var sdLine = cfg.lineup_sd[(c.data && c.data.lineup_certainty) || 'UNKNOWN'];
      var sd = Math.sqrt(sdModel * sdModel + sdCal * sdCal + sdLine * sdLine);
      var ref = c.market_ref && num(c.market_ref.p_novig);
      var tau = cfg.prior_edge_sd;
      var k = ref != null ? (tau * tau) / (tau * tau + sd * sd) : 1;
      var pPost = ref != null ? ref + k * (pw - ref) : pw;
      var sdPost = ref != null ? Math.sqrt((tau * tau * sd * sd) / (tau * tau + sd * sd)) : sd;
      c.prob = { model: r4(pw), push: r4(pp), market_novig: ref != null ? r4(ref) : null, shrink_k: r4(k), posterior: r4(pPost), sd: r4(sdPost), conservative: null, components: { model_sd: r4(sdModel), calibration_sd: r4(sdCal), lineup_sd: r4(sdLine) } };
      var pCons = pPost - (c.priced ? zN : 1.2816) * sdPost; /* priced: the selection-adjusted bar; unpriced: a one-sided 90% bound */
      c.prob.conservative = r4(pCons);
      c.break_even = c.dec ? r4((1 - pp) / c.dec) : null;
      c.ev_raw = c.dec ? r4(pw * c.dec - (1 - pp)) : null;
      c.ev_posterior = c.dec ? r4(pPost * c.dec - (1 - pp)) : null;
      c.ev_conservative = c.dec ? r4(pCons * c.dec - (1 - pp)) : null;
      c.min_acceptable_american = pCons > 0 ? decToAm((1 - pp + cfg.min_ev) / pCons) : null;
      if (!c.priced) { c.status = c.status || 'RESEARCH'; c.gates.push({ gate: 'VALUE', ok: false, code: 'NEEDS_PRICE', reason: 'needs a price of ' + (c.min_acceptable_american == null ? '—' : (c.min_acceptable_american > 0 ? '+' : '') + c.min_acceptable_american) + ' or better to clear the bar (if value claims were enabled)' }); return; }
      var vg = valueGate(c, reg, cfg); c.gates.push({ gate: 'VALUE', ok: vg.ok, code: vg.code, reason: vg.reason });
      var dataOk = !c.data || c.data.state !== 'STALE';
      c.gates.push({ gate: 'DATA', ok: dataOk, code: dataOk ? 'FRESH' : 'STALE_DATA', reason: dataOk ? 'research inputs are current' : 'the research inputs are stale' });
      var sane = cfg.sane_ev[c.market.kind] || 0.10;
      if (c.ev_raw > sane) { c.status = 'DATA_CHECK'; c.gates.push({ gate: 'SANITY', ok: false, code: 'OUTLIER', reason: 'raw EV ' + Math.round(c.ev_raw * 1000) / 10 + '% exceeds the ' + Math.round(sane * 100) + '% ceiling: verify the price before anything else' }); return; }
      var evOk = c.ev_conservative >= cfg.min_ev;
      c.gates.push({ gate: 'EV', ok: evOk, code: evOk ? 'CLEARS' : 'BELOW_BAR', reason: 'conservative EV ' + Math.round(c.ev_conservative * 1000) / 10 + '% vs the ' + Math.round(cfg.min_ev * 100) + '% bar after shrinkage and the selection adjustment for ' + N + ' priced market' + (N === 1 ? '' : 's') });
      c.status = vg.ok && dataOk && evOk ? 'QUALIFIED' : c.ev_raw > 0 ? 'WATCH' : 'NO_VALUE';
    });
    /* correlation: one per event */
    var byEvent = {};
    all.filter(function (c) { return c.status === 'QUALIFIED'; }).sort(function (a, b) { return b.ev_conservative - a.ev_conservative; }).forEach(function (c) {
      if (byEvent[c.event_key]) { c.status = 'CORRELATED'; c.correlated_with = byEvent[c.event_key]; c.gates.push({ gate: 'CORRELATION', ok: false, code: 'SAME_EVENT', reason: 'another market on this game ranks higher; outcomes are correlated' }); }
      else byEvent[c.event_key] = c.id;
    });
    var order = { QUALIFIED: 0, WATCH: 1, DATA_CHECK: 2, CORRELATED: 3, RESEARCH: 4, NO_VALUE: 5, STARTED: 6, NO_MODEL: 7 };
    all.sort(function (a, b) { return (order[a.status] - order[b.status]) || ((b.ev_conservative == null ? -9 : b.ev_conservative) - (a.ev_conservative == null ? -9 : a.ev_conservative)) || ((b.prob ? b.prob.conservative - (b.break_even || 0.5) : 0) - (a.prob ? a.prob.conservative - (a.break_even || 0.5) : 0)); });
    var qualified = all.filter(function (c) { return c.status === 'QUALIFIED'; });
    var counts = {}; all.forEach(function (c) { counts[c.status] = (counts[c.status] || 0) + 1; });
    var gateFails = {}; all.forEach(function (c) { (c.gates || []).forEach(function (g) { if (!g.ok) gateFails[g.code] = (gateFails[g.code] || 0) + 1; }); });
    /* the strongest non-qualifying candidate: a priced WATCH first; otherwise the
       research candidate whose CONSERVATIVE probability sits furthest above its
       market reference. With no reference there is no basis to call one stronger,
       and none is named. */
    all.forEach(function (c) { c.disagreement = c.prob && c.prob.market_novig != null ? r4(c.prob.conservative - c.prob.market_novig) : null; });
    var strongest = all.filter(function (c) { return c.status === 'WATCH'; })[0]
      || all.filter(function (c) { return c.status === 'RESEARCH' && c.disagreement != null && c.disagreement > 0; }).sort(function (a, b) { return b.disagreement - a.disagreement; })[0] || null;
    var why = [];
    if (!qualified.length) {
      if (!priced.length) why.push('No market had a fresh executable price: ' + (gateFails.NO_PRICE || 0) + ' without a price, ' + (gateFails.STALE || 0) + ' stale.');
      if (gateFails.VALUE_DISABLED || gateFails.NO_MODEL) why.push('No evaluated sport-market has beaten the closing market out of sample, so no model price may be called an edge (' + ((gateFails.VALUE_DISABLED || 0) + (gateFails.NO_MODEL || 0)) + ' priced candidates held back).');
      if (gateFails.BELOW_BAR) why.push(gateFails.BELOW_BAR + ' priced candidate' + (gateFails.BELOW_BAR === 1 ? '' : 's') + ' did not clear ' + Math.round(cfg.min_ev * 100) + '% conservative EV after shrinkage and the selection adjustment.');
      if (gateFails.OUTLIER) why.push(gateFails.OUTLIER + ' price' + (gateFails.OUTLIER === 1 ? ' looks' : 's look') + ' wrong (EV above the sanity ceiling) and must be verified first.');
      if (!why.length) why.push('Nothing qualified.');
    }
    return {
      schema: 'edgedesk_xboard_v1', version: VERSION, evaluated_at: new Date(now).toISOString(),
      verdict: qualified.length ? 'BEST_SUPPORTED' : 'PASS',
      best: qualified[0] || null,
      why: why, strongest_candidate: qualified.length ? null : strongest,
      counts: counts, gate_failures: gateFails, n_candidates: all.length, n_priced: priced.length, selection_z: r4(zN),
      rules: cfg, candidates: all,
      disclaimer: 'Research, not picks. A qualified opportunity is a price that cleared EdgeDesk\'s published rules at the time shown; it is not a prediction that it will win, and nothing here is a recommendation to bet.'
    };
  }

  return { VERSION: VERSION, DEFAULTS: DEFAULTS, evaluate: evaluate, qnorm: qnorm, amToDec: amToDec, decToAm: decToAm, fairWithPush: fairWithPush, marketText: marketText };
});
