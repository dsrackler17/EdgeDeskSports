// deno-lint-ignore-file
/*__EDAUDIT_START__*/
/* ===========================================================================
   EdgeDesk ADVERSARIAL AUDITOR — a second, separate verification of every
   high-ranked opportunity before it is published.

   ONE FILE, ONE HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   WHY IT IS SEPARATE
     The board's candidates are produced by the decision layer (EDINTEL) from
     the capture function's stored fair. Re-reading that same number and
     calling it "verified" would be the generator agreeing with itself. The
     auditor therefore:
       - works from a FRESH READ the host makes at audit time (the signal row
         again, the per-book quotes, the availability sources), not from the
         candidate's copy;
       - recomputes expected value with a DIFFERENT implementation (EDFAIR:
         exact decimals) and a DIFFERENT de-vig method (multiplicative on the
         sharp book's two sides, against capture's Shin fair), and asks
         whether the edge survives both;
       - can REJECT what the generator recommended, and says why.

   THE LOOP (bounded)
     AUDIT → (a correctable failure: a stale or moved price that the fresh
     read supersedes) CORRECT → RECALCULATE → RE-AUDIT, at most `max_rounds`
     times. Anything still failing ends in an explicit state — REJECTED or
     NEEDS_RECHECK — never a silent pass. Every step is written to the trail.
     Missing information is NOT_CHECKED with a reason; it is never filled in.

   STATUSES
     CONFIRMED      every critical check passed on fresh data
     DOWNGRADED     nothing failed, but a warning stands or a critical check
                    could not be run: a POTENTIAL edge at most
     NEEDS_RECHECK  news or a price arrived after the quote (re-quote first)
     REJECTED       an integrity failure: the recommendation is withdrawn
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDAUDIT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_audit_v1';
  var MAX_ROUNDS = 2;
  var TOL = {
    ev_disagreement: 0.005,       /* recomputed vs candidate EV per $1, beyond rounding */
    method_floor: 0.0,            /* the edge must stay positive under the other de-vig method */
    fair_conflict_pp: 0.03,       /* sharp vs consensus fair, probability points */
    off_market_pp: 0.04,          /* best book's implied probability vs the median book's */
    sharp_move_pp: 0.02,          /* the sharp fair moving against the selection since the candidate */
    model_gap_pp: 0.08,           /* model vs market probability: needs a written explanation */
    model_gap_points: 7,          /* EDINTEL disagreement_points_hard (read from it when loaded): EXTREME, refused */
    min_books_confirm: 2,         /* books that must clear the floor for A7 to pass */
    availability_stale_h: 72      /* EDINTEL AVAIL_STALE_H: an availability build older than this is stale */
  };
  /* the decision layer's own numbers where it has them, so the auditor never disagrees with it */
  function intelConfig() { var I = root.EDINTEL; try { return I ? (I.CONFIG || (typeof I.config === 'function' ? I.config() : null)) : null; } catch (_) { return null; } }

  function F() {
    if (root.EDFAIR) return root.EDFAIR;
    if (typeof require === 'function') { try { return require('../../../lib/edgedesk_fairodds.js'); } catch (_) { /* fall through */ } }
    throw new Error('lib/edgedesk_fairodds.js (EDFAIR) must be loaded before the auditor runs');
  }
  function A() {
    if (root.EDADAPT) return root.EDADAPT;
    if (typeof require === 'function') { try { return require('../../../lib/edgedesk_sport_adapters.js'); } catch (_) { return null; } }
    return null;
  }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function pct(x, d) { return x == null ? '—' : (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function normName(s) { return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sameTeam(a, b) { a = normName(a); b = normName(b); if (!a || !b) return false; return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0; }

  /* The checks, in the order they run. `critical` checks must PASS for a CONFIRMED verdict. */
  var CHECKS = [
    { id: 'A1_GAME_STATUS', label: 'Game has not started', critical: true },
    { id: 'A2_QUOTE_FRESH', label: 'Quote freshness at audit time', critical: true },
    { id: 'A3_STILL_OFFERED', label: 'Price still offered on a fresh read', critical: true },
    { id: 'A4_INDEPENDENT_EV', label: 'Independent recomputation of EV (exact arithmetic)', critical: true },
    { id: 'A5_METHOD_ROBUST', label: 'Edge survives a second de-vig method', critical: false },
    { id: 'A6_FAIR_CONSISTENCY', label: 'Sharp and consensus references agree', critical: false },
    { id: 'A7_CONFIRMATION', label: 'Independent books confirm the price', critical: false },
    { id: 'A8_AVAILABILITY', label: 'No availability news after the quote', critical: true },
    { id: 'A9_STARTER', label: 'Starter matches the one priced', critical: true },
    { id: 'A10_SETTLEMENT', label: 'Settlement terms match the fair reference', critical: true },
    { id: 'A11_FEES', label: 'Fee schedule known for the venue', critical: false },
    { id: 'A12_LIQUIDITY', label: 'Liquidity for the size', critical: false },
    { id: 'A13_MOVEMENT', label: 'Sharp market not moving against the selection', critical: false },
    { id: 'A14_MODEL_DISAGREEMENT', label: 'A large model-vs-market gap is explained', critical: false },
    { id: 'A15_SANITY', label: 'EV inside the sanity ceiling', critical: true }
  ];
  var CHECK_BY_ID = {}; CHECKS.forEach(function (c) { CHECK_BY_ID[c.id] = c; });

  function res(id, result, detail, extra) { var c = CHECK_BY_ID[id]; return Object.assign({ id: id, label: c ? c.label : id, critical: !!(c && c.critical), result: result, detail: detail }, extra || {}); }

  /* The corrected inputs a fresh read supplies: its price, its time, its book and its fair. */
  function freshQuote(fresh) {
    var sf = num(fresh.sharp_fair), fair = sf != null && sf > 0 && sf < 1 ? sf : null;
    /* no stored sharp fair: the sharp book's own two sides, de-vigged, are still a fresh fair */
    if (fair == null) { var pin = num(fresh.pin_dec), opp = num(fresh.pin_opp_dec); if (pin != null && opp != null && pin > 1 && opp > 1) { var nv = F().noVig([{ decimal: String(pin) }, { decimal: String(opp) }], 'multiplicative'); if (nv.ok) fair = Number(nv.probabilities[0]); } }
    return { captured_at: iso(fresh.last_seen_at), odds_decimal: num(fresh.best_dec), book: fresh.best_book || null, fair_probability: fair };
  }
  /* Which side of a market a selection is, from names alone. */
  function sideMatches(sel, other) { return sameTeam(sel, other) || (/^over/i.test(str(sel)) && /^over/i.test(str(other))) || (/^under/i.test(str(sel)) && /^under/i.test(str(other))); }

  /**
   * The independent recomputation. From the FRESH signal row: the offered
   * decimal price and two fairs — capture's stored sharp fair (Shin) and a
   * multiplicative de-vig of the sharp book's own two sides — each through
   * EDFAIR's exact arithmetic.
   */
  function recompute(c, fresh, now, ttl) {
    var Fx = F();
    var dec = num(fresh && fresh.best_dec != null ? fresh.best_dec : c.quote && c.quote.odds_decimal);
    var out = { offered_decimal: dec, fairs: [], evaluations: [] };
    if (dec == null || dec <= 1) return out;
    /* only the FRESH read's fair: falling back to the candidate's own copy would be the generator agreeing with itself */
    var storedFair = fresh ? num(fresh.sharp_fair) : null;
    if (storedFair != null && storedFair > 0 && storedFair < 1) out.fairs.push({ method: 'CAPTURE_SHIN', probability: storedFair, source: 'signals.sharp_fair (capture, Shin de-vig)' });
    var pin = num(fresh && fresh.pin_dec), pinOpp = num(fresh && fresh.pin_opp_dec);
    if (pin != null && pinOpp != null && pin > 1 && pinOpp > 1) {
      var nv = Fx.noVig([{ decimal: String(pin) }, { decimal: String(pinOpp) }], 'multiplicative');
      if (nv.ok) out.fairs.push({ method: 'SHARP_MULTIPLICATIVE', probability: Number(nv.probabilities[0]), source: 'the sharp book\'s two sides (' + pin + ' / ' + pinOpp + '), multiplicative de-vig, recomputed by the auditor', overround: nv.overround });
    }
    var cons = num(fresh && fresh.consensus_fair);
    if (cons != null && cons > 0 && cons < 1) out.consensus = cons;
    out.fairs.forEach(function (f) {
      var r = Fx.evaluateWager({ decimal: String(dec), fair_probability: String(f.probability), push_probability: c.fair && c.fair.push_probability != null ? String(c.fair.push_probability) : null, fair_source: { kind: 'SHARP_NO_VIG', label: f.source, observed_at: fresh && fresh.last_seen_at }, quote_observed_at: fresh && fresh.last_seen_at, now: now, ttl_min: ttl, audit: { status: 'CONFIRMED' }, settlement: { verified: true } });
      out.evaluations.push({ method: f.method, fair: f.probability, ev_per_dollar: r.ok ? Number(r.net_ev_per_dollar) : null, max_entry: r.ok ? r.maximum_entry_price : null, result: r });
    });
    return out;
  }

  /**
   * Audit ONE candidate against evidence the host gathered at audit time.
   * c: an EDBOARD candidate (or the same shape): sport, game_id, kickoff, market,
   *    side, selection, home, away, quote{book, odds_decimal, odds_american, captured_at},
   *    fair{method, probability, push_probability, validation}, edge{ev_per_unit},
   *    outlier, model_case, starters{home, away} (what the priced projection used),
   *    explanation (drivers, when a model disagrees).
   * e: { fresh: signal row re-read | null, fresh_error, books: [{book, dec, updated_at}] | null,
   *      availability: [{team, player, role, status, observed_at, source}] | null,
   *      starters_now: {home:{name, observed_at, source}, away:{...}} | null,
   *      settlement: {overtime, ...} (the priced contract's terms, for a contract) | null,
   *      contract: EDFAIR contract result | null }
   * o: { now, ttl_min, floor }
   */
  function auditCandidate(c, e, o) {
    o = o || {}; e = e || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var Fx = F();
    var floor = o.floor != null ? o.floor : Number(Fx.thresholds().ev_floor);
    var ttl = num(o.ttl_min) || 90;
    var checks = [];
    var corrections = [];
    var fresh = e.fresh || null;

    /* A1 game status */
    var kick = toMs(c.kickoff);
    var icfg = intelConfig();
    var minKick = icfg && num(icfg.min_minutes_to_kickoff) != null ? num(icfg.min_minutes_to_kickoff) : 2;
    if (kick != null && kick <= now) checks.push(res('A1_GAME_STATUS', 'FAIL', 'kickoff ' + iso(kick) + ' has passed; a pregame price cannot be audited', { severity: 'INTEGRITY' }));
    else if (kick == null) checks.push(res('A1_GAME_STATUS', 'WARN', 'no start time on file'));
    /* the decision layer's kickoff guard: inside it a pregame price is not reliably available */
    else if ((kick - now) / 60000 < minKick) checks.push(res('A1_GAME_STATUS', 'FAIL', 'kickoff ' + iso(kick) + ' is under ' + minKick + ' minutes away; a pregame price is not reliably available', { severity: 'MARKET' }));
    else checks.push(res('A1_GAME_STATUS', 'PASS', 'starts ' + iso(kick)));

    /* A2 freshness at audit time (the candidate's own capture time) */
    var capAt = c.quote && c.quote.captured_at;
    var I = root.EDINTEL;
    var qs = I && typeof I.quoteState === 'function' && capAt ? I.quoteState({ captured_at: capAt, market: c.market, kickoff: c.kickoff, now: now }) : null;
    var fr = qs ? { status: qs.status === 'CURRENT' ? 'LIVE' : qs.status, why: qs.why || qs.sentence || (qs.status + ' under the kickoff ladder') } : Fx.freshness(capAt, now, ttl, 'the candidate quote');
    var freshAt = fresh && fresh.last_seen_at;
    var freshFr = freshAt ? (I && typeof I.quoteState === 'function' ? (function () { var s = I.quoteState({ captured_at: freshAt, market: c.market, kickoff: c.kickoff, now: now }); return { status: s.status === 'CURRENT' ? 'LIVE' : s.status }; })() : Fx.freshness(freshAt, now, ttl)) : null;
    if (fr.status === 'LIVE' || fr.status === 'AGING') checks.push(res('A2_QUOTE_FRESH', fr.status === 'LIVE' ? 'PASS' : 'WARN', 'captured ' + iso(capAt) + ' (' + fr.status + ')'));
    else {
      var fix = freshFr && (freshFr.status === 'LIVE' || freshFr.status === 'AGING') && (toMs(capAt) == null || toMs(freshAt) > toMs(capAt)) && num(fresh.best_dec) != null;
      checks.push(res('A2_QUOTE_FRESH', 'FAIL', 'the candidate quote is ' + fr.status + ' (captured ' + (iso(capAt) || 'at an unrecorded time') + ')' + (fix ? '; a fresher read from ' + iso(freshAt) + ' supersedes it' : '; no fresher read is available'), { severity: 'FRESHNESS', correctable: fix ? { field: 'quote', to: freshQuote(fresh) } : null }));
    }

    /* A3 still offered: the fresh read has the selection, at the same or a better price */
    if (e.fresh_error) checks.push(res('A3_STILL_OFFERED', 'NOT_CHECKED', 'the fresh read failed: ' + str(e.fresh_error).slice(0, 120)));
    else if (!fresh) checks.push(res('A3_STILL_OFFERED', 'NOT_CHECKED', 'no fresh read was made for this candidate'));
    else if (fresh.suspended || fresh.removed) checks.push(res('A3_STILL_OFFERED', 'FAIL', 'the selection is no longer offered (' + (fresh.suspended ? 'suspended' : 'removed') + ')', { severity: 'MARKET' }));
    else {
      var was = num(c.quote && c.quote.odds_decimal), now_ = num(fresh.best_dec);
      if (now_ == null) checks.push(res('A3_STILL_OFFERED', 'FAIL', 'the fresh read carries no price for this selection', { severity: 'MARKET' }));
      else if (was != null && now_ + 1e-9 < was) checks.push(res('A3_STILL_OFFERED', 'FAIL', 'the price moved from ' + was + ' to ' + now_ + ' (decimal) at ' + (fresh.best_book || 'the best book'), { severity: 'PRICE', correctable: { field: 'quote', to: freshQuote(fresh) } }));
      else checks.push(res('A3_STILL_OFFERED', 'PASS', 'still offered at ' + now_ + (fresh.best_book ? ' (' + fresh.best_book + ')' : '') + (was != null && now_ > was + 1e-9 ? ', better than the candidate\'s ' + was : '')));
    }

    /* A4 independent EV, A5 method robustness */
    var rc = recompute(c, fresh, now, ttl);
    var primaryEv = num(c.edge && c.edge.ev_per_unit);
    var shin = rc.evaluations.filter(function (x) { return x.method === 'CAPTURE_SHIN'; })[0] || null;
    var mult = rc.evaluations.filter(function (x) { return x.method === 'SHARP_MULTIPLICATIVE'; })[0] || null;
    var priceSame = fresh && num(fresh.best_dec) != null && num(c.quote && c.quote.odds_decimal) != null && Math.abs(num(fresh.best_dec) - num(c.quote.odds_decimal)) < 1e-9;
    var ref = shin || mult;
    /* (i) arithmetic: the candidate's own price and fair, recomputed exactly — a pure calculation check */
    var arith = null;
    var cDec = num(c.quote && c.quote.odds_decimal), cFair = num(c.fair && c.fair.probability);
    if (primaryEv != null && cDec != null && cDec > 1 && cFair != null && cFair > 0 && cFair < 1) {
      var ar = Fx.evaluateWager({ decimal: String(cDec), fair_probability: String(cFair), push_probability: c.fair.push_probability != null ? String(c.fair.push_probability) : null });
      if (ar.ok) arith = Number(ar.net_ev_per_dollar);
    }
    if (arith != null && Math.abs(arith - primaryEv) > TOL.ev_disagreement) checks.push(res('A4_INDEPENDENT_EV', 'FAIL', 'calculation disagreement: the candidate says ' + pct(primaryEv, 2) + ' per $1; the exact recomputation at its own price (' + cDec + ') and fair (' + pct(cFair, 2) + ') says ' + pct(arith, 2), { severity: 'INTEGRITY', recomputed_ev: arith }));
    /* (ii) value on the fresh read */
    else if (!ref || ref.ev_per_dollar == null) checks.push(res('A4_INDEPENDENT_EV', arith != null ? 'WARN' : 'NOT_CHECKED', arith != null ? 'the candidate\'s arithmetic reproduces (' + pct(arith, 2) + ' per $1), but no fresh fair was read to re-price it' : 'no fair probability on the fresh read to recompute against', arith != null ? { recomputed_ev: arith } : null));
    else if (ref.ev_per_dollar < floor) checks.push(res('A4_INDEPENDENT_EV', 'FAIL', 'recomputed on the fresh read the EV is ' + pct(ref.ev_per_dollar, 2) + ' per $1, under the ' + pct(floor, 2) + ' floor' + (primaryEv != null ? ' (the candidate said ' + pct(primaryEv, 2) + ')' : ''), { severity: 'VALUE', recomputed_ev: ref.ev_per_dollar }));
    else checks.push(res('A4_INDEPENDENT_EV', 'PASS', 'recomputed ' + pct(ref.ev_per_dollar, 2) + ' per $1 on the fresh read (' + ref.method + ', exact)' + (arith != null ? '; the candidate\'s own arithmetic reproduces' : ''), { recomputed_ev: ref.ev_per_dollar }));
    if (shin && mult) {
      var minEv = Math.min(shin.ev_per_dollar, mult.ev_per_dollar);
      if (minEv < Math.max(TOL.method_floor, floor)) checks.push(res('A5_METHOD_ROBUST', 'WARN', 'the edge depends on the de-vig method: ' + pct(shin.ev_per_dollar, 2) + ' (Shin) vs ' + pct(mult.ev_per_dollar, 2) + ' (multiplicative), against the ' + pct(floor, 2) + ' floor'));
      else checks.push(res('A5_METHOD_ROBUST', 'PASS', 'clears the ' + pct(floor, 2) + ' floor under both: ' + pct(shin.ev_per_dollar, 2) + ' (Shin) and ' + pct(mult.ev_per_dollar, 2) + ' (multiplicative)'));
    } else checks.push(res('A5_METHOD_ROBUST', 'NOT_CHECKED', 'only one fair reference on the fresh read (the sharp book\'s two sides are needed for a second method)'));

    /* A6 sharp vs consensus */
    var sharpP = ref ? ref.fair : null;
    if (sharpP != null && rc.consensus != null) {
      var dd = rc.consensus - sharpP;
      var consEv = rc.offered_decimal != null ? rc.consensus * (rc.offered_decimal - 1) - (1 - rc.consensus) : null;
      if (Math.abs(dd) >= TOL.fair_conflict_pp || (consEv != null && consEv < 0 && ref.ev_per_dollar > 0)) checks.push(res('A6_FAIR_CONSISTENCY', 'WARN', 'contradictory references: sharp ' + pct(sharpP) + ' vs consensus ' + pct(rc.consensus) + (consEv != null ? ' (EV against the consensus ' + pct(consEv, 2) + ')' : '')));
      else checks.push(res('A6_FAIR_CONSISTENCY', 'PASS', 'sharp ' + pct(sharpP) + ' and consensus ' + pct(rc.consensus) + ' agree'));
    } else checks.push(res('A6_FAIR_CONSISTENCY', 'NOT_CHECKED', 'no consensus fair on the fresh read'));

    /* A7 independent books */
    if (Array.isArray(e.books) && e.books.length && sharpP != null) {
      var decs = e.books.map(function (b) { return num(b.dec); }).filter(function (d) { return d != null && d > 1; });
      var beating = decs.filter(function (d) { return sharpP * (d - 1) - (1 - sharpP) >= floor; }).length;
      var sorted = decs.slice().sort(function (a, b) { return a - b; });
      var med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      var best = sorted.length ? sorted[sorted.length - 1] : null;
      var offPp = med && best ? (1 / med - 1 / best) : null;
      if (decs.length < 2) checks.push(res('A7_CONFIRMATION', 'WARN', 'only ' + decs.length + ' book quote on file'));
      else if (beating <= 1 && offPp != null && offPp >= TOL.off_market_pp) checks.push(res('A7_CONFIRMATION', 'WARN', 'one off-market book: the best price implies ' + pct(1 / best) + ' against a median book at ' + pct(1 / med) + '; a lone outlier is often a stale or erroneous quote'));
      else if (beating < TOL.min_books_confirm) checks.push(res('A7_CONFIRMATION', 'WARN', 'only ' + beating + ' of ' + decs.length + ' books clear the floor against the sharp fair; ' + TOL.min_books_confirm + ' are needed to confirm the price'));
      else checks.push(res('A7_CONFIRMATION', 'PASS', beating + ' of ' + decs.length + ' books clear the floor against the sharp fair'));
    } else checks.push(res('A7_CONFIRMATION', 'NOT_CHECKED', 'no per-book quotes were read'));

    /* A8 availability news after the quote */
    var roles = A() ? A().keyRoles(c.sport) : [];
    var BAD_STATUS = /^(out|doubtful|scratched|ir|inactive|suspended|not starting)/i;
    var isKey = function (x) { return x.key === true || roles.indexOf(str(x.role).toUpperCase()) >= 0; };
    if (Array.isArray(e.availability)) {
      var cap = toMs(capAt);
      var mine = e.availability.filter(function (x) { return sameTeam(x.team, c.home) || sameTeam(x.team, c.away); });
      var hits = mine.filter(function (x) { var t = toMs(x.observed_at); return t != null && cap != null && t > cap; });
      var bad = hits.filter(function (x) { return BAD_STATUS.test(str(x.status)); });
      var keyBad = bad.filter(isKey);
      /* a key player ruled out with no time on the report cannot be placed before or after the quote */
      var untimed = mine.filter(function (x) { return toMs(x.observed_at) == null && BAD_STATUS.test(str(x.status)) && isKey(x); });
      var asOf = toMs(e.availability_as_of);
      mine.forEach(function (x) { var t = toMs(x.observed_at); if (t != null && (asOf == null || t > asOf)) asOf = t; });
      var ageH = asOf != null ? (now - asOf) / 3600000 : null;
      if (keyBad.length) checks.push(res('A8_AVAILABILITY', 'FAIL', 'news after the quote: ' + keyBad.map(function (x) { return x.player + ' (' + x.team + ', ' + (x.role || '?') + ') ' + x.status + ' at ' + iso(x.observed_at) + (x.source ? ' — ' + x.source : ''); }).join('; ') + '. The price predates it.', { severity: 'NEWS', invalidates: true }));
      else if (untimed.length) checks.push(res('A8_AVAILABILITY', 'NOT_CHECKED', untimed.map(function (x) { return x.player + ' (' + x.team + ', ' + (x.role || '?') + ') ' + x.status; }).join('; ') + ' carries no report time, so it cannot be placed before or after the quote'));
      else if (!e.availability.length && e.availability_complete !== true) checks.push(res('A8_AVAILABILITY', 'NOT_CHECKED', e.availability_why || 'no availability records were read for either team'));
      else if (ageH == null) checks.push(res('A8_AVAILABILITY', 'WARN', 'the availability report carries no time, so it may predate news'));
      else if (ageH > TOL.availability_stale_h) checks.push(res('A8_AVAILABILITY', 'WARN', 'the newest availability report is ' + Math.round(ageH) + ' hours old, past the ' + TOL.availability_stale_h + '-hour limit'));
      else if (bad.length) checks.push(res('A8_AVAILABILITY', 'WARN', bad.length + ' non-key availability change' + (bad.length === 1 ? '' : 's') + ' after the quote: ' + bad.slice(0, 3).map(function (x) { return x.player + ' ' + x.status; }).join('; ')));
      else checks.push(res('A8_AVAILABILITY', 'PASS', mine.length + ' availability record' + (mine.length === 1 ? '' : 's') + ' read (report ' + Math.round(ageH) + 'h old); none after the quote changes a key role'));
    } else checks.push(res('A8_AVAILABILITY', 'NOT_CHECKED', e.availability_why || 'no availability source is wired for ' + str(c.sport_label || c.sport)));

    /* A9 starter: the one priced vs the one now listed */
    var priced = c.starters || null, nowS = e.starters_now || null;
    if (priced && nowS) {
      var mism = [];
      ['home', 'away'].forEach(function (s) {
        var a = priced[s] && (priced[s].name || priced[s]), b = nowS[s] && nowS[s].name;
        if (a && b && normName(a) !== normName(b)) mism.push((s === 'home' ? c.home : c.away) + ': priced with ' + a + ', now ' + b + (nowS[s].source ? ' (' + nowS[s].source + (nowS[s].observed_at ? ', ' + iso(nowS[s].observed_at) : '') + ')' : ''));
      });
      if (mism.length) checks.push(res('A9_STARTER', 'FAIL', 'incorrect starter: ' + mism.join('; '), { severity: c.fair && c.fair.method === 'MODEL_BLEND' ? 'INTEGRITY' : 'NEWS', invalidates: true }));
      else checks.push(res('A9_STARTER', 'PASS', 'the starters priced are the starters listed now'));
    } else if (roles.indexOf('SP') >= 0 || roles.indexOf('G') >= 0 || roles.indexOf('QB') >= 0) checks.push(res('A9_STARTER', 'NOT_CHECKED', !priced ? 'the candidate does not record which starters its price assumed' : 'no current starter source was read'));
    else checks.push(res('A9_STARTER', 'PASS', 'no starter role applies to ' + str(c.sport_label || c.sport)));

    /* A10 settlement */
    if (e.settlement && A()) {
      var cmp = A().compareSettlement(c.sport, c.market, null, e.settlement);
      if (cmp.mismatch_severity === 'MATERIAL') checks.push(res('A10_SETTLEMENT', 'FAIL', cmp.mismatch, { severity: 'SETTLEMENT' }));
      else if (cmp.mismatch_severity === 'UNVERIFIED') checks.push(res('A10_SETTLEMENT', 'WARN', cmp.mismatch));
      else if (cmp.mismatch_severity === 'MINOR') checks.push(res('A10_SETTLEMENT', 'WARN', cmp.mismatch));
      else checks.push(res('A10_SETTLEMENT', 'PASS', 'the contract settles like the reference market'));
    } else checks.push(res('A10_SETTLEMENT', 'PASS', 'the price and its fair reference are the same sportsbook market type'));

    /* A11 fees, A12 liquidity (a contract carries its own evaluation) */
    var ct = e.contract || null;
    if (ct && ct.ok) {
      var fs = ct.expected_fees && ct.expected_fees.status;
      checks.push(res('A11_FEES', fs === 'VERIFIED' ? 'PASS' : fs === 'UNKNOWN' ? 'FAIL' : 'WARN', 'fee schedule ' + str(fs).toLowerCase() + ': ' + str(ct.expected_fees && ct.expected_fees.basis).slice(0, 160), fs === 'UNKNOWN' ? { severity: 'VALUE' } : null));
      var ls = ct.market_liquidity && ct.market_liquidity.status;
      checks.push(res('A12_LIQUIDITY', ls === 'ADEQUATE' ? 'PASS' : ls === 'INSUFFICIENT' ? 'FAIL' : 'WARN', str(ct.market_liquidity && ct.market_liquidity.note), ls === 'INSUFFICIENT' ? { severity: 'MARKET' } : null));
    } else {
      checks.push(res('A11_FEES', 'PASS', 'a sportsbook price carries no explicit fee'));
      var nb = fresh ? num(fresh.n_books) : null;
      checks.push(nb != null ? res('A12_LIQUIDITY', nb >= 2 ? 'PASS' : 'WARN', nb + ' book' + (nb === 1 ? '' : 's') + ' quoting this market') : res('A12_LIQUIDITY', 'NOT_CHECKED', 'no book count on the fresh read'));
    }

    /* A13 sharp movement since the candidate */
    var candFair = num(c.fair && c.fair.probability);
    if (candFair != null && sharpP != null) {
      var mv = sharpP - candFair;
      if (mv <= -TOL.sharp_move_pp) checks.push(res('A13_MOVEMENT', 'WARN', 'the sharp fair moved against the selection: ' + pct(candFair) + ' → ' + pct(sharpP)));
      else checks.push(res('A13_MOVEMENT', 'PASS', 'sharp fair ' + pct(candFair) + ' → ' + pct(sharpP)));
    } else checks.push(res('A13_MOVEMENT', 'NOT_CHECKED', 'no second sharp reading to compare'));

    /* A14 a large model-vs-market disagreement needs a written explanation */
    var mc = c.model_case || null;
    var gapPts = mc ? (num(mc.gap_points) != null ? num(mc.gap_points) : (num(mc.model_line) != null && num(c.line) != null && str(c.market) === 'spreads' ? Math.round((num(c.line) - num(mc.model_line)) * 10) / 10 : null)) : null;
    var modelP = mc ? num(mc.cover_at_market || mc.probability) : null;
    var gapPp = modelP != null && sharpP != null ? Math.abs(modelP - sharpP) : null;
    var hardPts = icfg && num(icfg.disagreement_points_hard) != null ? num(icfg.disagreement_points_hard) : TOL.model_gap_points;
    if (gapPts != null && Math.abs(gapPts) >= hardPts) checks.push(res('A14_MODEL_DISAGREEMENT', 'FAIL', 'the model is ' + Math.abs(gapPts) + ' points from the market, at or past the ' + hardPts + '-point EXTREME limit: the decision layer treats a gap this large as a suspected data fault, whatever the explanation', { severity: 'INTEGRITY' }));
    else if ((gapPp != null && gapPp >= TOL.model_gap_pp)) {
      var expl = c.explanation || (mc && mc.explanation) || null;
      if (expl && (Array.isArray(expl) ? expl.length : str(expl).length > 20)) checks.push(res('A14_MODEL_DISAGREEMENT', 'WARN', 'the model is ' + (gapPts != null ? Math.abs(gapPts) + ' points' : pct(gapPp) ) + ' from the market; the stated explanation: ' + (Array.isArray(expl) ? expl.slice(0, 3).join('; ') : str(expl)).slice(0, 240)));
      else checks.push(res('A14_MODEL_DISAGREEMENT', 'FAIL', 'the model is ' + (gapPts != null ? Math.abs(gapPts) + ' points' : pct(gapPp)) + ' from the market and no driver explains the difference: an unexplained disagreement is a data question, not an edge', { severity: 'INTEGRITY' }));
    } else checks.push(res('A14_MODEL_DISAGREEMENT', mc ? 'PASS' : 'NOT_CHECKED', mc ? 'the model and the market are within the disagreement threshold' : 'no model case on this candidate'));

    /* A15 sanity */
    var evNow = ref && ref.ev_per_dollar != null ? ref.ev_per_dollar : primaryEv;
    var sane = str(c.market) === 'h2h' ? 0.20 : 0.10;
    if (c.outlier || (evNow != null && evNow > sane)) checks.push(res('A15_SANITY', 'FAIL', c.outlier || ('EV ' + pct(evNow, 1) + ' is past the ' + pct(sane, 0) + ' sanity ceiling'), { severity: 'INTEGRITY' }));
    else checks.push(res('A15_SANITY', 'PASS', evNow != null ? 'EV ' + pct(evNow, 2) + ' is inside the ' + pct(sane, 0) + ' ceiling' : 'no EV to bound'));

    /* the verdict */
    var fails = checks.filter(function (x) { return x.result === 'FAIL'; });
    var correctable = fails.filter(function (x) { return x.correctable; });
    var hard = fails.filter(function (x) { return !x.correctable; });
    var warns = checks.filter(function (x) { return x.result === 'WARN'; });
    /* the starter check blocks confirmation only for a MODEL price, whose starter assumption is known;
       a market price's starter is the market's (capture records none), so its absence is reported, not blocking */
    var isModel = c.fair && c.fair.method === 'MODEL_BLEND';
    var unchecked = checks.filter(function (x) { return x.result === 'NOT_CHECKED' && x.critical && !(x.id === 'A9_STARTER' && !isModel); });
    var status, reason;
    /* a value failure measured at a price the same audit found superseded is re-judged after the correction */
    var deferred = correctable.length && hard.length && hard.every(function (x) { return x.severity === 'VALUE'; });
    if (deferred) { status = 'NEEDS_RECHECK'; reason = correctable[0].detail + ' (value is re-judged at the corrected price)'; }
    else if (hard.some(function (x) { return x.severity === 'INTEGRITY' || x.severity === 'MARKET' || x.severity === 'VALUE' || x.severity === 'SETTLEMENT'; })) { status = 'REJECTED'; reason = hard.filter(function (x) { return x.severity !== 'NEWS' && x.severity !== 'FRESHNESS'; })[0].detail; }
    else if (hard.length) { status = 'NEEDS_RECHECK'; reason = hard[0].detail; }
    else if (correctable.length) { status = 'NEEDS_RECHECK'; reason = correctable[0].detail; }
    else if (warns.length || unchecked.length) { status = 'DOWNGRADED'; reason = (warns[0] || unchecked[0]).detail; }
    else { status = 'CONFIRMED'; reason = 'every check passed on a fresh read'; }
    return {
      schema: VERSION, candidate_id: c.id || null, status: status, reason: reason,
      checks: checks, correctable: correctable.map(function (x) { return { check: x.id, field: x.correctable.field, to: x.correctable.to, why: x.detail }; }),
      recomputed: { offered_decimal: rc.offered_decimal, fairs: rc.fairs, evaluations: rc.evaluations.map(function (x) { return { method: x.method, fair: x.fair, ev_per_dollar: x.ev_per_dollar, max_entry: x.max_entry }; }), consensus: rc.consensus != null ? rc.consensus : null },
      independent_ev: ref ? ref.ev_per_dollar : null,
      /* the probability behind independent_ev: what the host prices the verdict on */
      independent_fair: ref ? ref.fair : null,
      independent_fair_method: ref ? ref.method : null,
      independent_fair_observed_at: ref && fresh ? iso(fresh.last_seen_at) : null,
      independent_price_decimal: ref ? rc.offered_decimal : null,
      max_entry_american: ref ? ref.max_entry : null,
      counts: { pass: checks.filter(function (x) { return x.result === 'PASS'; }).length, warn: warns.length, fail: fails.length, not_checked: checks.filter(function (x) { return x.result === 'NOT_CHECKED'; }).length },
      audited_at: iso(now)
    };
  }

  /** Apply the correctable findings to a COPY of the candidate and recompute its edge with EDFAIR. */
  function applyCorrections(c, audit, now) {
    var Fx = F();
    var out = JSON.parse(JSON.stringify(c));
    var applied = [];
    var held = [];
    (audit.correctable || []).forEach(function (k) {
      if (k.field === 'quote' && k.to) {
        /* the fair is re-read with the price: a corrected price is never priced against a stale fair.
           A fresher read with no fair is not a correction — the candidate is left as it was (NEEDS_RECHECK). */
        if (k.to.fair_probability == null || !out.fair) { held.push({ check: k.check, why: 'the fresher read carries no fair probability, so the corrected price cannot be re-priced' }); return; }
        var before = { odds_decimal: out.quote.odds_decimal, captured_at: out.quote.captured_at, book: out.quote.book, fair_probability: out.fair ? out.fair.probability : null, fair_method: out.fair ? out.fair.method : null };
        out.quote.odds_decimal = k.to.odds_decimal != null ? k.to.odds_decimal : out.quote.odds_decimal;
        out.quote.captured_at = k.to.captured_at || out.quote.captured_at;
        if (k.to.book) out.quote.book = k.to.book;
        /* the re-read fair is the MARKET's (capture's sharp no-vig), whatever the candidate's was: relabel it,
           so a market number is never shown as a model's */
        out.fair.probability = k.to.fair_probability; out.fair.reread = true;
        out.fair.method = 'SHARP_REREAD'; out.fair.label = 'sharp no-vig, re-read at audit time'; out.fair.validation = null;
        if (out.model_case) out.model_case = null;
        try { out.quote.odds_american = out.quote.odds_decimal ? Fx.wholeAmerican(Fx.decimalToAmerican(String(out.quote.odds_decimal))) : out.quote.odds_american; } catch (_) { /* keep */ }
        applied.push({ check: k.check, field: 'quote', from: before, to: k.to, why: k.why });
      }
    });
    /* recalculate the edge from the corrected price against the same fair */
    var fair = num(out.fair && out.fair.probability), dec = num(out.quote && out.quote.odds_decimal);
    if (fair != null && dec != null && dec > 1) {
      var r = Fx.evaluateWager({ decimal: String(dec), fair_probability: String(fair), push_probability: out.fair.push_probability != null ? String(out.fair.push_probability) : null, now: now, quote_observed_at: out.quote.captured_at });
      if (r.ok) { out.edge = Object.assign({}, out.edge, { ev_per_unit: Number(r.net_ev_per_dollar), probability_edge_pp: Number(r.probability_edge) * 100, recalculated_by: 'EDFAIR ' + Fx.CALC_VERSION, break_even: Number(r.break_even_probability) }); out.threshold = Object.assign({}, out.threshold, { price_limit_american: r.maximum_entry_price }); }
    }
    out.corrected = (out.corrected || []).concat(applied);
    return { candidate: out, applied: applied, held: held };
  }

  /**
   * The bounded loop over the top candidates.
   * o.candidates: ranked candidates (best first)
   * o.gather(candidate, round) → evidence (or a Promise of it). The host
   *   makes its fresh reads here and may cache them between rounds.
   * o.top (default 3), o.max_rounds (default 2, at most 3), o.now, o.ttl_min
   * → { audited:[{candidate, audit, rounds, history}], trail, verified, downgraded, rejected, rechecks }
   */
  function run(o) {
    o = o || {};
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var top = Math.max(0, Math.min(10, num(o.top) != null ? num(o.top) : 3));
    var maxRounds = Math.max(1, Math.min(3, num(o.max_rounds) || MAX_ROUNDS));
    var list = (o.candidates || []).slice(0, top);
    var trail = [];
    function log(round, id, step, detail) { trail.push({ round: round, candidate_id: id, step: step, detail: detail, at: iso(now) }); }
    function one(c0) {
      var c = c0, history = [], round = 0, audit = null;
      function step() {
        round++;
        log(round, c.id, round === 1 ? 'AUDIT' : 'RE-AUDIT', 'checking ' + (c.selection || c.id) + ' at ' + (c.quote && c.quote.odds_american != null ? c.quote.odds_american : c.quote && c.quote.odds_decimal));
        /* a read that throws is a read that failed: recorded, never a pass */
        var failed = function (err) { log(round, c.id, 'READ_FAILED', String(err && err.message || err).slice(0, 160)); return { fresh: null, fresh_error: 'the audit read failed: ' + String(err && err.message || err).slice(0, 120), availability: null, starters_now: null }; };
        var ev;
        try { ev = o.gather ? o.gather(c, round) : {}; } catch (err) { ev = failed(err); }
        if (ev && typeof ev.then === 'function') ev = ev.then(null, failed);
        var finish = function (e) {
          try { audit = auditCandidate(c, e || {}, { now: now, ttl_min: o.ttl_min }); }
          catch (err) { audit = { schema: VERSION, candidate_id: c.id, status: 'NEEDS_RECHECK', reason: 'the audit could not run: ' + String(err && err.message || err).slice(0, 160), checks: [], correctable: [], counts: {} }; }
          history.push({ round: round, status: audit.status, reason: audit.reason });
          log(round, c.id, 'VERDICT', audit.status + ': ' + audit.reason);
          if (audit.correctable.length && audit.status === 'NEEDS_RECHECK' && round < maxRounds && !audit.checks.some(function (x) { return x.result === 'FAIL' && !x.correctable && x.severity !== 'VALUE'; })) {
            var fx = applyCorrections(c, audit, now);
            if (!fx.applied.length) {
              (fx.held || []).forEach(function (h) { log(round, c.id, 'HOLD', h.check + ': ' + h.why + '; withheld'); });
              audit.correction_held = true;
              return { candidate: c, audit: audit, rounds: round, history: history };
            }
            fx.applied.forEach(function (a) { log(round, c.id, 'CORRECT', a.check + ': ' + a.why); });
            log(round, c.id, 'RECALCULATE', 'EV at the corrected price: ' + (fx.candidate.edge && fx.candidate.edge.ev_per_unit != null ? pct(fx.candidate.edge.ev_per_unit, 2) + ' per $1' : 'not computable'));
            c = fx.candidate;
            return step();
          }
          if (audit.status === 'NEEDS_RECHECK' && round >= maxRounds && audit.correctable.length) { log(round, c.id, 'EXHAUSTED', 'still failing after ' + round + ' rounds; withheld'); audit.exhausted = true; }
          return { candidate: c, audit: audit, rounds: round, history: history };
        };
        return ev && typeof ev.then === 'function' ? ev.then(finish) : finish(ev);
      }
      return step();
    }
    function summarise(results) {
      results.forEach(function (r) { if (r.candidate.corrected && r.candidate.corrected.length && r.audit.status === 'CONFIRMED') log(r.rounds, r.candidate.id, 'PUBLISH', 'published with corrected inputs'); });
      var by = function (s) { return results.filter(function (r) { return r.audit.status === s; }); };
      var verified = by('CONFIRMED').filter(function (r) { var ev = num(r.candidate.edge && r.candidate.edge.ev_per_unit); return ev != null && ev > 0; });
      verified.sort(function (a, b) { return (num(b.audit.independent_ev) || 0) - (num(a.audit.independent_ev) || 0); });
      return { schema: VERSION, audited: results, trail: trail, verified: verified, downgraded: by('DOWNGRADED'), rechecks: by('NEEDS_RECHECK'), rejected: by('REJECTED'), max_rounds: maxRounds, top: top, checks: CHECKS.map(function (c) { return { id: c.id, label: c.label, critical: c.critical }; }) };
    }
    var outs = list.map(one);
    if (outs.some(function (x) { return x && typeof x.then === 'function'; })) return Promise.all(outs).then(summarise);
    return summarise(outs);
  }

  return { VERSION: VERSION, MAX_ROUNDS: MAX_ROUNDS, TOL: TOL, CHECKS: CHECKS, auditCandidate: auditCandidate, applyCorrections: applyCorrections, recompute: recompute, run: run };
});
/*__EDAUDIT_END__*/
