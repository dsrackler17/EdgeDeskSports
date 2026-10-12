/*__EDQVERIFY_START__*/
/* ===========================================================================
   EdgeDesk QUANTITATIVE VERIFICATION (EDQVERIFY) — every number an answer
   prints, as a calculation record that can be checked.
   docs/research-engine/ARCHITECTURE.md §3

   ONE RECORD PER CALCULATION
     name        IMPLIED_PROBABILITY · NO_VIG · FAIR_ODDS · BREAK_EVEN ·
                 EXPECTED_VALUE · PROBABILITY_EDGE · MAXIMUM_ENTRY_PRICE ·
                 LINE_DISCREPANCY · MARKET_FRESHNESS · CALIBRATION · SENSITIVITY
     version     <name>@<semver> — a change to a formula changes its version
     formula     the formula, written out
     inputs      each input by name, value, unit and SOURCE (an evidence id, a
                 dataset id, or the calculation it came from)
     assumptions what the number takes for granted (push refunded, no fee, the
                 normal residual, the fair's own error not quantified …)
     output      the value the engine computed (EDFAIR's exact decimal arithmetic)
     check       an independent recomputation in floating point from the same
                 inputs, and whether the two agree within the stated tolerance
     status      COMPUTED · UNAVAILABLE (with why) — never a substituted number

   WHAT IT WILL NOT DO
     It never invents a price or a probability. Without a verified quote the
     market comparison is UNAVAILABLE and says why; the research continues.
     A model-versus-market gap is reported as a gap, with the model's measured
     record beside it — never as proof of positive expected value.

   NUMBER VERIFIER
     checkNumbers(text, ledgers) finds every probability, American price and
     dollar EV in an answer and checks each against the calculation records
     (and any numbers the caller names as known). A labelled number ("break-even
     51.2%") must match that calculation; an unlabelled one must match some
     record. Anything else is UNSUPPORTED.

   Browser/Node/Deno: UMD, ES5. Reads EDFAIR (lib/edgedesk_fairodds.js) when it
   is loaded; inlined into supabase/functions/edgedesk_ai/index.ts.
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDQVERIFY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var VERSION = 'edgedesk_quant_verify_v1';
  var CALCS = {
    IMPLIED_PROBABILITY: { version: '1.0.0', unit: 'probability', formula: 'p_implied = 1 / D, where D = 1 + A/100 for A > 0 and D = 1 + 100/|A| for A < 0 (A American, D decimal odds)' },
    NO_VIG: { version: '1.0.0', unit: 'probability', formula: 'multiplicative: p_i = (1/D_i) / Σ_j (1/D_j) over every outcome at one book; overround = Σ_j (1/D_j) − 1' },
    FAIR_ODDS: { version: '1.0.0', unit: 'american', formula: 'q = p / (1 − push); fair A = −100·q/(1 − q) when q ≥ 0.5, else 100·(1 − q)/q; fair D = (1 − push) / p' },
    BREAK_EVEN: { version: '1.0.0', unit: 'probability', formula: 'p_break_even = (1 − push) / D (a push refunds the stake)' },
    EXPECTED_VALUE: { version: '1.0.0', unit: 'dollars per $1 risked', formula: 'EV = p·(D − 1) − (1 − p − push)' },
    PROBABILITY_EDGE: { version: '1.0.0', unit: 'probability', formula: 'edge = p_fair − p_break_even' },
    MAXIMUM_ENTRY_PRICE: { version: '1.0.0', unit: 'american', formula: 'D_min = (1 − push + EV floor) / p; the worst whole American price at or above D_min' },
    LINE_DISCREPANCY: { version: '1.0.0', unit: 'points', formula: 'gap = model line − market line (selection lines; totals: model total − market total); P(cover at the market line) ≈ Φ((market line − model line)/σ) for a side, Φ((model total − market total)/σ) for the over' },
    MARKET_FRESHNESS: { version: '1.0.0', unit: 'minutes', formula: 'age = now − captured_at; FRESH while age ≤ TTL' },
    CALIBRATION: { version: '1.0.0', unit: 'brier', formula: 'held-out Brier = mean((p − outcome)²), compared with the base-rate Brier; record against the close = wins / (n − pushes) with a one-sided binomial p-value (from the validation artifact)' },
    SENSITIVITY: { version: '1.0.0', unit: 'dollars per $1 risked', formula: 'EV recomputed at fair ± k percentage points; robust when EV > 0 at fair − 1 pp' }
  };
  /* the engine prints probabilities to 6 dp and EV to 8: the check catches a wrong formula or input, not the last digit */
  var TOL = { probability: 1e-5, ev: 1e-5, american: 1, points: 1e-9, minutes: 1 };

  function F() { return root && root.EDFAIR ? root.EDFAIR : null; }
  function str(v) { return v == null ? '' : String(v); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function r(v, k) { if (v == null || !isFinite(v)) return null; var f = Math.pow(10, k == null ? 6 : k); return Math.round(v * f) / f; }
  function hash(s) { var h = 0x811c9dc5; s = str(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
  /* float conversions, written independently of EDFAIR so the check is a second computation */
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function probToAm(q) { if (!(q > 0 && q < 1)) return null; return q >= 0.5 ? -100 * q / (1 - q) : 100 * (1 - q) / q; }
  function decToAm(d) { if (!(d > 1)) return null; return d >= 2 ? (d - 1) * 100 : -100 / (d - 1); }
  function phi(z) { var t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
  function pct(p, k) { return p == null ? null : (Math.round(p * Math.pow(10, 2 + (k == null ? 1 : k))) / Math.pow(10, k == null ? 1 : k)).toFixed(k == null ? 1 : k) + '%'; }
  function am(a) { return a == null ? null : (a > 0 ? '+' : '') + Math.round(a); }

  function input(name, value, unit, source) { return { name: name, value: value == null ? null : value, unit: unit || null, source: source || null }; }
  function record(name, o) {
    var c = CALCS[name];
    var out = {
      id: 'calc_' + name.toLowerCase() + '_' + hash(JSON.stringify([o.inputs, o.output && o.output.value])),
      name: name, version: name.toLowerCase() + '@' + c.version, formula: c.formula, engine: o.engine || VERSION,
      inputs: o.inputs || [], assumptions: o.assumptions || [],
      output: o.output || null, status: o.status || (o.output && o.output.value != null ? 'COMPUTED' : 'UNAVAILABLE'), why: o.why || null,
      check: o.check || null
    };
    if (out.status === 'UNAVAILABLE' && !out.why) out.why = 'an input is missing';
    return out;
  }
  function check(engineVal, recomputed, tol, method) {
    var e = num(engineVal), x = num(recomputed);
    if (e == null || x == null) return { method: method || 'independent float recomputation', value: x, agrees: null, tolerance: tol, note: e == null ? 'no engine value to check' : 'could not recompute' };
    return { method: method || 'independent float recomputation', value: r(x, 8), agrees: Math.abs(e - x) <= tol, tolerance: tol, difference: r(e - x, 10) };
  }
  function unavailable(name, why, inputs) { return record(name, { status: 'UNAVAILABLE', why: why, inputs: inputs || [] }); }

  /* ---------------- single calculations ---------------- */
  /** o: { american | decimal, source, engine_value } */
  function implied(o) {
    o = o || {};
    var d = num(o.decimal) != null ? num(o.decimal) : amToDec(o.american);
    var ins = [input('price', o.american != null ? am(num(o.american)) : o.decimal, o.american != null ? 'american' : 'decimal', o.source)];
    if (d == null || d <= 1) return unavailable('IMPLIED_PROBABILITY', 'no verified price: the market comparison is unavailable', ins);
    var x = 1 / d, ev = num(o.engine_value);
    return record('IMPLIED_PROBABILITY', { engine: ev != null ? 'EDFAIR ' + (o.calc_version || '') : VERSION, inputs: ins, assumptions: ['the quoted price includes the book\'s margin; this is not a fair probability'],
      output: { value: ev != null ? ev : r(x, 6), unit: 'probability', display: pct(ev != null ? ev : x) }, check: check(ev != null ? ev : r(x, 6), x, TOL.probability) });
  }
  /** o: { prices: [{american|decimal, label}], index (the selection), source } — every outcome at ONE book */
  function noVig(o) {
    o = o || {};
    var ps = o.prices || [];
    var ins = ps.map(function (p, i) { return input('price ' + (p.label || 'outcome ' + (i + 1)), p.american != null ? am(num(p.american)) : p.decimal, p.american != null ? 'american' : 'decimal', o.source); });
    if (ps.length < 2) return unavailable('NO_VIG', o.why || 'a no-vig probability needs every outcome of the market priced at the same book; ' + (ps.length ? 'only one side is on file' : 'no prices are on file'), ins);
    var imp = ps.map(function (p) { var d = num(p.decimal) != null ? num(p.decimal) : amToDec(p.american); return d ? 1 / d : null; });
    if (imp.some(function (x) { return x == null; })) return unavailable('NO_VIG', 'an outcome has no usable price', ins);
    var tot = imp.reduce(function (a, b) { return a + b; }, 0), i = num(o.index) || 0, x = imp[i] / tot;
    var Fx = F(), eng = Fx ? Fx.noVig(ps.map(function (p) { return p.decimal != null ? { decimal: String(p.decimal) } : { american: p.american }; }), 'multiplicative') : null;
    var val = eng && eng.ok ? num(eng.probabilities[i]) : r(x, 6);
    return record('NO_VIG', { engine: eng && eng.ok ? 'EDFAIR ' + Fx.CALC_VERSION : VERSION, inputs: ins, assumptions: ['multiplicative margin removal (the board\'s method)', 'the error of a de-vigged price is largest on heavy favourites and long shots'],
      output: { value: val, unit: 'probability', display: pct(val), overround: eng && eng.ok ? num(eng.overround) : r(tot - 1, 6) }, check: check(val, x, TOL.probability) });
  }

  /* ---------------- the ledger for one priced candidate ---------------- */
  /**
   * ev: the EDFAIR evaluation the scan published (evaluateWager result, with priced_on).
   * o: { quote: { american, decimal, book, captured_at, source }, fair: { method, label, source }, other_side: { american } (same book),
   *      model_line: { market: 'spreads'|'totals', side, selection, model_line, market_line, sigma, sigma_basis, source, tier },
   *      validation: (EDPRICE.validationFor), sensitivity: (EDAGENTS.sensitivity), now, ttl_min }
   */
  function forCandidate(ev, o) {
    o = o || {}; var q = o.quote || {}, recs = [];
    var priced = !!(ev && ev.ok);
    /* the price as quoted (the engine's entry_decimal is a 4-dp display): decimal when the quote carries it, else the American price */
    var qSrc = q.source || null, d = num(q.decimal) != null ? num(q.decimal) : q.american != null ? amToDec(q.american) : priced ? amToDec(ev.entry_price) : null;
    var market = priced && d != null ? { status: 'AVAILABLE', why: null } : { status: 'UNAVAILABLE', why: !q.captured_at && q.american == null && q.decimal == null ? 'no verified price is on file for this selection; the research continues, and no market comparison or expected value is computed' : ev && ev.ok === false ? 'the price did not evaluate: ' + str(ev.error && ev.error.message || ev.why || ev.code) : 'no verified price' };
    /* 1. implied */
    recs.push(implied({ american: q.decimal == null ? (q.american != null ? q.american : priced ? ev.entry_price : null) : null, decimal: q.decimal, source: qSrc, engine_value: priced ? ev.market_probability : null, calc_version: ev && ev.calc_version }));
    /* 2. no-vig at the same book */
    if (o.other_side && o.other_side.american != null && d != null) recs.push(noVig({ prices: [{ decimal: d, label: 'selection' }, { american: o.other_side.american, label: 'other side' }], index: 0, source: qSrc }));
    else recs.push(unavailable('NO_VIG', 'the other side\'s price at ' + (q.book || 'the same book') + ' is not on the candidate' + (o.fair && o.fair.method === 'MARKET_DEVIG' ? '; the fair used below is ' + (o.fair.label || 'a de-vigged sharp reference') + ', carried as the board computed it' : ''), [input('selection price', priced ? am(num(ev.entry_price)) : null, 'american', qSrc)]));
    if (!priced) {
      ['FAIR_ODDS', 'BREAK_EVEN', 'EXPECTED_VALUE', 'PROBABILITY_EDGE', 'MAXIMUM_ENTRY_PRICE'].forEach(function (n) { recs.push(unavailable(n, market.why)); });
    } else {
      var p = num(ev.fair_probability), push = num(ev.push_probability) || 0, fs = ev.fair_source || {};
      var fairIn = input('fair probability', p, 'probability', (o.fair && o.fair.source) || (fs.kind ? fs.kind + (fs.label ? ' — ' + fs.label : '') : null));
      var pushIn = input('push probability', push, 'probability', push ? 'the board\'s push model for this line' : 'no push on this line');
      var decIn = input('decimal odds', d, 'decimal', qSrc);
      var fairAssume = fs.kind === 'MODEL' ? 'the fair is EdgeDesk\'s ' + (fs.tier || ev.model_tier || 'unvalidated') + '-tier model; its error is not in the number (see CALIBRATION)' : 'the fair is a de-vigged market price; it carries no confidence interval';
      /* 3. fair odds */
      if (p != null && p > 0 && p < 1) {
        var qq = p / (1 - push);
        recs.push(record('FAIR_ODDS', { engine: 'EDFAIR ' + ev.calc_version, inputs: [fairIn, pushIn], assumptions: [fairAssume, 'a push refunds the stake'],
          output: { value: num(ev.fair_american_odds), unit: 'american', display: am(num(ev.fair_american_odds)), decimal: num(ev.fair_decimal_odds) }, check: check(ev.fair_american_odds, Math.round(probToAm(qq)), TOL.american, 'independent float recomputation, rounded to a whole American price') }));
      } else recs.push(unavailable('FAIR_ODDS', 'no fair probability for this selection', [fairIn]));
      /* 4. break-even */
      recs.push(record('BREAK_EVEN', { engine: 'EDFAIR ' + ev.calc_version, inputs: [decIn, pushIn], assumptions: ['a push refunds the stake', 'no explicit fee (a fixed-odds sportsbook)'],
        output: { value: num(ev.break_even_probability), unit: 'probability', display: pct(num(ev.break_even_probability)) }, check: check(ev.break_even_probability, (1 - push) / d, TOL.probability) }));
      /* 5. expected value */
      var evv = ev.net_ev_per_dollar != null ? num(ev.net_ev_per_dollar) : num(ev.gross_expected_value);
      if (p != null) recs.push(record('EXPECTED_VALUE', { engine: 'EDFAIR ' + ev.calc_version, inputs: [fairIn, decIn, pushIn], assumptions: [fairAssume, ev.net_ev_per_dollar != null ? 'no fee (a fixed-odds sportsbook)' : 'gross: the venue may charge a fee that is not on file', 'priced on ' + str(ev.priced_on || (fs.kind || 'the fair')).toLowerCase()],
        output: { value: evv, unit: 'dollars per $1 risked', display: evv == null ? null : (evv >= 0 ? '+' : '−') + '$' + Math.abs(evv).toFixed(4) + ' per $1', net: ev.net_ev_per_dollar != null }, check: check(evv, p * (d - 1) - (1 - p - push), TOL.ev) }));
      else recs.push(unavailable('EXPECTED_VALUE', 'no fair probability, so no expected value'));
      /* 6. edge */
      if (p != null && ev.probability_edge != null) recs.push(record('PROBABILITY_EDGE', { engine: 'EDFAIR ' + ev.calc_version, inputs: [fairIn, input('break-even probability', num(ev.break_even_probability), 'probability', 'BREAK_EVEN')], assumptions: [fairAssume],
        output: { value: num(ev.probability_edge), unit: 'probability', display: pct(num(ev.probability_edge), 2) }, check: check(ev.probability_edge, p - (1 - push) / d, TOL.probability) }));
      else recs.push(unavailable('PROBABILITY_EDGE', p == null ? 'no fair probability' : 'the fee is unknown, so the edge after fees is not computed'));
      /* 7. maximum entry price */
      var floor = num(ev.thresholds && ev.thresholds.ev_floor);
      if (p != null && ev.maximum_entry_price != null && floor != null) {
        var dmin = (1 - push + floor) / p, amMin = decToAm(dmin), cl = amMin == null ? null : Math.ceil(amMin - 1e-9);
        if (cl != null && cl < 0 && cl >= -100) cl = 100; if (cl != null && cl > 0 && cl < 100) cl = 100;
        recs.push(record('MAXIMUM_ENTRY_PRICE', { engine: 'EDFAIR ' + ev.calc_version, inputs: [fairIn, pushIn, input('EV floor', floor, 'dollars per $1', 'EDFAIR thresholds (operator setting)')], assumptions: [fairAssume, 'the price is rounded to the conservative whole American price'],
          output: { value: num(ev.maximum_entry_price), unit: 'american', display: am(num(ev.maximum_entry_price)) }, check: check(ev.maximum_entry_price, cl, TOL.american, 'independent float recomputation, ceiling to a whole American price') }));
      } else recs.push(unavailable('MAXIMUM_ENTRY_PRICE', p == null ? 'no fair probability' : 'not computed by the engine for this venue'));
    }
    /* 8. line discrepancy (the projection against the market line) */
    recs.push(lineDiscrepancy(o.model_line));
    /* 9. market freshness */
    recs.push(marketFreshness({ captured_at: q.captured_at, now: o.now, ttl_min: o.ttl_min != null ? o.ttl_min : priced && ev.data_freshness && ev.data_freshness.quote ? ev.data_freshness.quote.ttl_min : null, engine: priced && ev.data_freshness ? ev.data_freshness.quote : null, source: qSrc }));
    /* 10. calibration and the model's measured record */
    recs.push(calibration({ validation: o.validation, market: o.model_line ? o.model_line.market : (o.market || null), gap_points: o.model_line ? gapOf(o.model_line) : null, calibration_status: priced ? ev.calibration_status : null, fair_kind: priced && ev.fair_source ? ev.fair_source.kind : null }));
    /* 11. sensitivity */
    recs.push(sensitivity(o.sensitivity, priced ? ev : null));
    return finish(recs, market);
  }
  /** The ledger for one game: the projection against the market line, its record, and the price when one is verified. */
  function forGame(g, o) {
    g = g || {}; o = o || {};
    var recs = [], hasPrice = !!(o.quote && (o.quote.american != null || o.quote.decimal != null) && o.quote.captured_at);
    var market = hasPrice ? { status: 'AVAILABLE', why: null } : { status: 'UNAVAILABLE', why: g.market_line != null ? 'only a reference line is on file (no captured price): the line can be compared, but no implied probability or expected value is computed' : 'no market number is on file for this game' };
    if (hasPrice) recs.push(implied({ american: o.quote.american, decimal: o.quote.decimal, source: o.quote.source }));
    recs.push(lineDiscrepancy(o.model_line));
    if (hasPrice) recs.push(marketFreshness({ captured_at: o.quote.captured_at, now: o.now, ttl_min: o.ttl_min, source: o.quote.source }));
    recs.push(calibration({ validation: o.validation, market: 'spreads', gap_points: o.model_line ? gapOf(o.model_line) : null }));
    return finish(recs, market);
  }
  function gapOf(m) { return m && num(m.model_line) != null && num(m.market_line) != null ? r(num(m.model_line) - num(m.market_line), 4) : null; }
  /** m: { market 'spreads'|'totals', side ('home'|'away'|'over'|'under'), selection, model_line, market_line (selection lines; totals as totals), sigma, sigma_basis, source, market_source, tier, model_cover: { probability, label, source } } */
  function lineDiscrepancy(m) {
    if (!m) return unavailable('LINE_DISCREPANCY', 'no projection is on file for this market');
    var ml = num(m.model_line), kl = num(m.market_line), sg = num(m.sigma), tot = m.market === 'totals';
    var ins = [input(tot ? 'model total' : 'model line (' + (m.selection || m.side || 'selection') + ')', ml, 'points', m.source), input(tot ? 'market total' : 'market line (' + (m.selection || m.side || 'selection') + ')', kl, 'points', m.market_source), input('residual sigma', sg, 'points', m.sigma_basis)];
    /* the board's own cover probability at the market line (the validated blend of projection and market), as it was computed */
    if (m.model_cover && num(m.model_cover.probability) != null) ins.push(input('model cover probability at the market line (' + (m.model_cover.label || 'the board\'s blend') + ')', num(m.model_cover.probability), 'probability', m.model_cover.source || m.source));
    if (ml == null || kl == null) return unavailable('LINE_DISCREPANCY', ml == null ? 'no projection is on file for this market' : 'no market line is on file', ins);
    var gap = r(ml - kl, 4), z = sg ? (tot ? (ml - kl) / sg : (kl - ml) / sg) : null, pc = z == null ? null : tot && m.side === 'under' ? 1 - phi(z) : phi(z);
    return record('LINE_DISCREPANCY', { inputs: ins,
      assumptions: ['the margin (or total) is normal around the projection with the residual sigma', 'pushes ignored in the cover probability', 'the raw projection, not the blend the board prices on: the market carries most of the weight in the blend', m.tier ? 'the model is ' + m.tier + ' tier for this market' : 'the model tier is not on file'],
      output: { value: gap, unit: 'points', display: (gap > 0 ? '+' : '') + gap + ' points', cover_probability: r(pc, 4), cover_display: pc == null ? null : pct(pc), is_edge_evidence: false,
        note: 'A gap between the projection and the market is a disagreement to explain, not proof of positive expected value.' },
      check: check(gap, ml - kl, TOL.points) });
  }
  function marketFreshness(o) {
    o = o || {};
    var t = toMs(o.captured_at), n = toMs(o.now) != null ? toMs(o.now) : Date.now(), ttl = num(o.ttl_min);
    var ins = [input('captured at', o.captured_at || null, 'time', o.source), input('now', new Date(n).toISOString(), 'time', 'the request'), input('TTL', ttl, 'minutes', 'EDINTEL quote-state limit for this market and time to kickoff')];
    if (t == null) return unavailable('MARKET_FRESHNESS', 'no capture time: the price cannot be treated as current', ins);
    var age = Math.max(0, Math.round((n - t) / 60000)), eng = o.engine && o.engine.age_min != null ? num(o.engine.age_min) : null;
    var status = ttl == null ? 'UNKNOWN' : age <= ttl ? 'FRESH' : 'STALE';
    return record('MARKET_FRESHNESS', { engine: eng != null ? 'EDFAIR freshness' : VERSION, inputs: ins, assumptions: ['the book has not moved since the capture (unverifiable without a new capture)'],
      output: { value: eng != null ? eng : age, unit: 'minutes', display: (eng != null ? eng : age) + ' min old', status: o.engine && o.engine.status ? o.engine.status : status }, check: check(eng != null ? eng : age, (n - t) / 60000, TOL.minutes) });
  }
  /** The model's measured record for this market: held-out Brier against the base rate, and the record against the close near this gap. */
  function calibration(o) {
    o = o || {}; var v = o.validation || null;
    var ins = [input('validation artifact', v && v.loaded ? (v.generated_at || 'loaded') : null, 'time', v && v.frame ? str(v.frame.engine) : 'football/validation/pricing_<sport>.json')];
    if (o.fair_kind && o.fair_kind !== 'MODEL') ins.push(input('fair source', o.fair_kind, null, 'the evaluation'));
    if (!v || !v.loaded) return record('CALIBRATION', { status: 'UNAVAILABLE', why: 'no validation is loaded for this sport and market: the projection is unvalidated, and its probabilities are not betting probabilities', inputs: ins, output: { value: null, unit: 'brier', tier: (v && v.tier) || 'RESEARCH', calibration_status: o.calibration_status || 'UNCALIBRATED', display: null } });
    var cal = v.calibration || null, held = cal && (cal.blend_held_out || cal.raw_model_held_out) || null;
    var atsRow = null, gap = num(o.gap_points);
    if (v.ats && gap != null) {
      var ks = Object.keys(v.ats).map(Number).filter(function (k) { return isFinite(k) && k <= Math.abs(gap); }).sort(function (a, b) { return b - a; });
      if (ks.length) { var a = v.ats[String(ks[0])]; atsRow = { threshold_points: ks[0], n: a.n, wins: a.wins, pushes: a.pushes, win_pct: a.win_pct, p_one_sided: a.p_one_sided }; }
    }
    if (held) ins.push(input('held-out sample', held.n, 'games', 'the validation artifact'));
    var beats = held && num(held.brier) != null && num(held.brier_base_rate) != null ? num(held.brier) < num(held.brier_base_rate) : null;
    return record('CALIBRATION', { engine: 'validation artifact (offline replay, no look-ahead: each game projected from the state before it)', inputs: ins,
      assumptions: ['the replay\'s seasons resemble this one', atsRow ? 'the record is for gaps of at least ' + atsRow.threshold_points + ' points, measured against the close' : 'no record against the close at this gap'],
      output: { value: held ? num(held.brier) : null, unit: 'brier', tier: v.tier, basis: v.basis || null, base_rate_brier: held ? num(held.brier_base_rate) : null, held_out_n: held ? held.n : null, beats_base_rate: beats,
        record_vs_close: atsRow, calibration_status: o.calibration_status || null,
        display: held ? 'held-out Brier ' + num(held.brier) + ' vs ' + num(held.brier_base_rate) + ' base rate (n ' + held.n + ')' + (beats === false ? ': no better than the base rate' : '') : v.tier + ' tier' },
      status: held || atsRow ? 'COMPUTED' : 'UNAVAILABLE', why: held || atsRow ? null : 'the validation carries no calibration table for this market' });
  }
  function sensitivity(s, ev) {
    if (!s || !s.available || !ev) return unavailable('SENSITIVITY', !ev ? 'no priced evaluation to perturb' : 'not computed for this candidate');
    var rows = (s.rows || []).map(function (x) { return { shift_pp: x.shift_pp, fair: x.fair, net_ev_per_dollar: x.net_ev_per_dollar }; });
    var p = num(ev.fair_probability), d = num(ev.entry_decimal), push = num(ev.push_probability) || 0;
    var bad = rows.filter(function (x) { return x.net_ev_per_dollar != null && x.fair != null && d && Math.abs(x.fair * (d - 1) - (1 - x.fair - push) - x.net_ev_per_dollar) > 1e-4; });
    return record('SENSITIVITY', { engine: 'EDAGENTS sensitivity over EDFAIR', inputs: [input('fair probability', p, 'probability', 'EXPECTED_VALUE'), input('decimal odds', d, 'decimal', 'IMPLIED_PROBABILITY')], assumptions: ['only the fair moves; the price is held'],
      output: { value: s.cushion_pp != null ? s.cushion_pp : null, unit: 'percentage points of cushion', rows: rows, robust: !!s.robust, display: s.note || null },
      check: { method: 'each row\'s EV recomputed in floating point', value: rows.length - bad.length, agrees: bad.length === 0, tolerance: 1e-4, disagreeing_rows: bad.map(function (x) { return x.shift_pp; }) } });
  }
  function finish(recs, market) {
    var checked = recs.filter(function (x) { return x.check && x.check.agrees != null; });
    var bad = checked.filter(function (x) { return x.check.agrees === false; });
    return {
      schema: VERSION, records: recs, market_comparison: market,
      verification: { computed: recs.filter(function (x) { return x.status === 'COMPUTED'; }).length, unavailable: recs.filter(function (x) { return x.status === 'UNAVAILABLE'; }).map(function (x) { return { name: x.name, why: x.why }; }),
        checked: checked.length, agreed: checked.length - bad.length, mismatches: bad.map(function (x) { return { name: x.name, engine: x.output && x.output.value, recomputed: x.check.value, difference: x.check.difference }; }),
        verdict: bad.length ? 'MISMATCH' : 'VERIFIED' }
    };
  }
  function byName(ledger, name) { return ledger && ledger.records ? ledger.records.filter(function (x) { return x.name === name; })[0] || null : null; }

  /* ---------------- the number verifier ---------------- */
  var LABELS = [
    ['BREAK_EVEN', /break[- ]even(?: probability)?/i, 'probability'],
    ['IMPLIED_PROBABILITY', /implied(?: probability)?/i, 'probability'],
    ['NO_VIG', /no[- ]vig(?: (?:market )?probability)?/i, 'probability'],
    ['EXPECTED_VALUE', /(?:net |estimated |gross )*(?:expected value|EV)\b/i, 'ev'],
    ['MAXIMUM_ENTRY_PRICE', /maximum (?:acceptable |entry )?price|worst price/i, 'american'],
    ['FAIR_ODDS', /fair (?:american )?(?:odds|price)/i, 'american']
  ];
  /** Every quantitative token in text: percentages, signed American prices, dollar EVs. */
  function tokens(text) {
    var t = str(text), out = [], m;
    var rx = /([+\u2212-]?\$\d+(?:\.\d+)?)|([+\u2212-]?\d+(?:\.\d+)?)\s?%|(^|[^\w.$/:-])([+\u2212-]\d{3,4})(?!\d|\.\d|%)/g;
    while ((m = rx.exec(t))) {
      var raw = m[1] || (m[2] != null ? m[2] + '%' : m[4]), kind = m[1] ? 'usd' : m[2] != null ? 'pct' : 'american';
      var at = m.index + (m[3] ? m[3].length : 0), ctx = t.slice(Math.max(0, at - 48), at);
      if (kind === 'usd' && /\bper\s*$/i.test(ctx)) continue; /* "per $1" is a unit, not a number */
      var v = Number(String(m[1] || m[2] || m[4]).replace('$', '').replace('\u2212', '-'));
      out.push({ token: raw, kind: kind, value: v, context: ctx.replace(/\s+/g, ' ') });
    }
    return out;
  }
  function near(a, b, tol) { return a != null && b != null && Math.abs(a - b) <= tol; }
  /** Known values from the ledgers: probabilities (as %), American prices, EVs per $1, points, plus the caller's known numbers. */
  function knownOf(ledgers, extra) {
    var k = { pct: [], american: [], usd: [] };
    (ledgers || []).forEach(function (L) {
      (L && L.records || []).forEach(function (x) {
        var o = x.output || {};
        if (o.unit === 'probability' && o.value != null) k.pct.push(o.value * 100);
        if (o.cover_probability != null) k.pct.push(o.cover_probability * 100);
        if (o.unit === 'american' && o.value != null) k.american.push(o.value);
        if (o.unit === 'dollars per $1 risked' && o.value != null) { k.usd.push(o.value); k.pct.push(o.value * 100); }
        if (o.record_vs_close && o.record_vs_close.win_pct != null) k.pct.push(o.record_vs_close.win_pct * 100);
        (o.rows || []).forEach(function (row) { if (row.fair != null) k.pct.push(row.fair * 100); if (row.net_ev_per_dollar != null) { k.usd.push(row.net_ev_per_dollar); k.pct.push(row.net_ev_per_dollar * 100); } });
        (x.inputs || []).forEach(function (i) { var v = num(String(i.value).replace('+', '')); if (v == null) return; if (i.unit === 'probability') k.pct.push(v * 100); if (i.unit === 'american') k.american.push(v); });
      });
    });
    (extra && extra.pct || []).forEach(function (v) { k.pct.push(num(v)); });
    (extra && extra.american || []).forEach(function (v) { k.american.push(num(v)); });
    (extra && extra.usd || []).forEach(function (v) { k.usd.push(num(v)); });
    return k;
  }
  /**
   * → { verdict PASS|FAIL, checked, supported, unsupported[{token, context}], mismatched[{label, token, expected}] }
   * A labelled number must match its calculation (to the printed precision); an unlabelled one must match some record or a known number.
   */
  function checkNumbers(text, ledgers, extra) {
    var K = knownOf(ledgers, extra), toks = tokens(text), uns = [], mis = [], sup = 0;
    toks.forEach(function (tk) {
      var dp = (String(tk.token).split('.')[1] || '').replace(/\D/g, '').length, tolP = 0.5 * Math.pow(10, -dp) + 1e-9;
      var lab = LABELS.filter(function (L) { return L[1].test(tk.context.slice(-40)); })[0];
      if (lab) {
        var expected = (ledgers || []).map(function (L) { return byName(L, lab[0]); }).filter(function (x) { return x && x.output && x.output.value != null; });
        if (expected.length) {
          var hit = expected.some(function (x) { var v = x.output.value; return tk.kind === 'pct' ? near(tk.value, v * 100, tolP) : tk.kind === 'american' ? near(tk.value, v, 0.5) : near(tk.value, v, tolP); });
          if (hit) { sup++; return; }
          mis.push({ label: lab[0], token: tk.token, expected: expected.map(function (x) { return x.output.display; }) }); return;
        }
      }
      var pool = tk.kind === 'pct' ? K.pct : tk.kind === 'american' ? K.american : K.usd;
      if (pool.some(function (v) { return near(tk.value, v, tk.kind === 'american' ? 0.5 : tolP); })) sup++;
      else uns.push({ token: tk.token, kind: tk.kind, context: tk.context });
    });
    return { verdict: uns.length || mis.length ? 'FAIL' : 'PASS', checked: toks.length, supported: sup, unsupported: uns, mismatched: mis };
  }

  return { VERSION: VERSION, CALCS: CALCS, implied: implied, noVig: noVig, lineDiscrepancy: lineDiscrepancy, marketFreshness: marketFreshness, calibration: calibration, sensitivity: sensitivity,
    forCandidate: forCandidate, forGame: forGame, byName: byName, tokens: tokens, checkNumbers: checkNumbers, _f: { amToDec: amToDec, probToAm: probToAm, decToAm: decToAm, phi: phi } };
});
/*__EDQVERIFY_END__*/
