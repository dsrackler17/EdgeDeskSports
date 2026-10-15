// deno-lint-ignore-file
/*__EDMKT_START__*/
/* ===========================================================================
   EdgeDesk MARKET COMPARISON ENGINE — the second half of the quant desk.

   ONE FILE, EVERY HOST. This exact block is inlined into
     - supabase/functions/edgedesk_ai/index.ts
   by tools/presentation/inline.js; presentation_sync.test.js fails when the
   copy drifts. Edit THIS file, then `node tools/presentation/inline.js`.

   THE ORDER IS THE ARCHITECTURE
     sports data → sport models → independent projections (EDPROJ, frozen and
     hashed) → THIS FILE → EV → audit.
   This engine never produces a probability. It receives a FROZEN independent
   projection (EDPROJ.freeze) and the market quotes that exist, and it says
   what the quotes are worth against the projection. It cannot change the
   projection: the snapshot is deep-frozen, its hash is re-checked after every
   comparison, and a comparison stamped before the projection was frozen is
   refused.

   WHAT A PRICE MAY BE CALLED (QUOTE_KINDS) — never interchangeable
     LIVE_SPORTSBOOK_QUOTE       a book's price read from a live feed inside
                                 the freshness window: executable
     CAPTURED_SPORTSBOOK_QUOTE   a book's price stored earlier (a scoreboard
                                 snapshot, capture's last read): executable
                                 only while fresh, and never "live"
     SHARP_MARKET_REFERENCE      a sharp book's de-vigged price: a reference
     CONSENSUS_REFERENCE         a consensus/schedule line: a reference, no book
     HISTORICAL_CLOSING_PRICE    a closing price: grading only
     INDEPENDENT_MODEL_PROJECTION  EdgeDesk's own number (EDPROJ), never a price
     ESTIMATED_FAIR_PRICE        a fair price derived from anything: never a price
   Only the first two can be bet into. A market-derived no-vig number is a
   reference, and it is never placed in a projection's slot.

   EXECUTION OUTCOMES (one per market compared)
     NO_CURRENT_ODDS               no executable quote for this event/market
     STALE_PRICE                   a quote exists but is past its limit, untimed
                                   or the event has started
     INSUFFICIENT_MODEL_RELIABILITY the projection may not price this market
                                   (not independent, tier below
                                   OUTCOME_VALIDATED, invalidated by a starter
                                   conflict or an expired build)
     NO_VERIFIED_EDGE              the price is worse than the modeled fair
     MARKET_WATCH                  positive at the point estimate, swallowed by
                                   the model's own uncertainty, or a data check
     CONDITIONAL_EDGE              clears the bar on the conservative probability
                                   but at least one execution gate is open
     VERIFIED_POSITIVE_EV          every execution gate passes
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDMKT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 'edgedesk_market_compare_v1';

  var QUOTE_KINDS = {
    LIVE_SPORTSBOOK_QUOTE: { executable: true, label: 'live sportsbook quote' },
    CAPTURED_SPORTSBOOK_QUOTE: { executable: true, label: 'previously captured sportsbook quote' },
    SHARP_MARKET_REFERENCE: { executable: false, label: 'sharp-market reference (de-vigged, not a price)' },
    CONSENSUS_REFERENCE: { executable: false, label: 'consensus line (a reference, not a price)' },
    HISTORICAL_CLOSING_PRICE: { executable: false, label: 'historical closing price (grading only)' },
    INDEPENDENT_MODEL_PROJECTION: { executable: false, label: 'EdgeDesk independent model projection (not a price)' },
    ESTIMATED_FAIR_PRICE: { executable: false, label: 'estimated fair price (not a price)' }
  };
  var OUTCOMES = ['VERIFIED_POSITIVE_EV', 'CONDITIONAL_EDGE', 'MARKET_WATCH', 'NO_VERIFIED_EDGE', 'STALE_PRICE', 'NO_CURRENT_ODDS', 'INSUFFICIENT_MODEL_RELIABILITY'];
  var OUTCOME_LABEL = {
    VERIFIED_POSITIVE_EV: 'VERIFIED POSITIVE EV', CONDITIONAL_EDGE: 'CONDITIONAL EDGE', MARKET_WATCH: 'MARKET WATCH', NO_VERIFIED_EDGE: 'NO VERIFIED EDGE',
    STALE_PRICE: 'STALE PRICE', NO_CURRENT_ODDS: 'NO CURRENT ODDS', INSUFFICIENT_MODEL_RELIABILITY: 'INSUFFICIENT MODEL RELIABILITY'
  };
  /* ranking order of outcomes (lower is stronger) */
  var OUTCOME_RANK = { VERIFIED_POSITIVE_EV: 0, CONDITIONAL_EDGE: 1, MARKET_WATCH: 2, NO_VERIFIED_EDGE: 3, STALE_PRICE: 4, INSUFFICIENT_MODEL_RELIABILITY: 5, NO_CURRENT_ODDS: 6 };
  /* tiers that may support an EV figure at all; value claims are a separate gate */
  var PRICING_TIERS = { MARKET_VALIDATED: true, OUTCOME_VALIDATED: true };
  var DEFAULTS = {
    max_quote_age_min: 60,        /* a captured price older than this is STALE */
    live_quote_age_min: 10,       /* a feed read younger than this may be called live */
    kickoff_guard_min: 2,         /* EDINTEL's kickoff guard: a price this close to the start is not actionable */
    identity_start_tolerance_min: 180,
    edge_bar: 0.02,               /* EDINTEL candidate_ev: conservative EV must reach this */
    ev_floor: 0.005,              /* EDINTEL ev_floor: the max entry price clears this on the conservative probability */
    alpha: 0.10,                  /* family-wise selection level (EDXBOARD's): z_N = Φ⁻¹(1 − α/N) */
    sane_ev: 0.15,                /* past this the price is a data question before it is a bet */
    min_books: 2
  };

  /* ------------------------------------------------------------ helpers */
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null ? '' : String(v); }
  function toMs(v) { if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null; var t = Date.parse(String(v)); return isFinite(t) ? t : null; }
  function iso(v) { var t = toMs(v); return t == null ? null : new Date(t).toISOString(); }
  function r4(v) { return v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000; }
  function r6(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6; }
  function P() { return root.EDPROJ || (typeof require === 'function' ? safeReq('./edgedesk_projections.js') : null); }
  function FAIR() { return root.EDFAIR || (typeof require === 'function' ? safeReq('./edgedesk_fairodds.js') : null); }
  function safeReq(p) { try { return require(p); } catch (_) { return null; } }
  function amToDec(a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function decToAm(d) { d = num(d); if (d == null || !(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)); }
  /* inverse standard normal (Acklam), the same as EDXBOARD's */
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
  function selectionZ(nCompared, alpha) { var n = Math.max(1, Number(nCompared) || 1); return qnorm(1 - (alpha || DEFAULTS.alpha) / n); }
  function normTeam(s) {
    var t = str(s).toLowerCase();
    t = t.normalize ? t.normalize('NFD').replace(/[̀-ͯ]/g, '') : t;
    /* "LA Clippers" is the Odds API's "Los Angeles Clippers"; "NY" the same for New York */
    return t.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^la /, 'los angeles ').replace(/^ny /, 'new york ');
  }
  /* words that name a DIFFERENT school or club when the longer name adds them: Texas is not Texas A&M,
     Michigan is not Central Michigan, Iowa is not Iowa State, Miami is not Miami (OH) */
  var QUALIFIER = { state: 1, st: 1, tech: 1, a: 1, m: 1, am: 1, central: 1, east: 1, eastern: 1, west: 1, western: 1, north: 1, northern: 1, south: 1, southern: 1, middle: 1, atlantic: 1, international: 1, christian: 1, oh: 1, monroe: 1, lafayette: 1 };
  function nameMatch(n, q) {
    if (!n || !q) return false;
    if (n === q) return true;
    var a = n.split(' '), b = q.split(' '), sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a;
    /* a short name (UAB, LSU) matches only as the longer name's first word; a longer one when every word is in the other */
    if (sh.join(' ').length < 4) { if (sh.length !== 1 || lo[0] !== sh[0]) return false; }
    else if (!sh.every(function (w) { return lo.indexOf(w) >= 0; })) return false;
    /* the longer name may add a mascot or a city, never a word that names another school */
    return !lo.some(function (w) { return sh.indexOf(w) < 0 && QUALIFIER[w]; });
  }
  /** Does a quote's team string name this projection's team? abbr exact, or the names agree word for word (nameMatch). */
  function sameTeam(t, quoteName) {
    if (!t) return false;
    var q = normTeam(quoteName); if (!q) return false;
    if (t.abbr && normTeam(t.abbr) === q) return true;
    var names = [t.name, t.short, t.location].filter(Boolean).map(normTeam);
    for (var i = 0; i < names.length; i++) if (nameMatch(names[i], q)) return true;
    return false;
  }
  /* one side of a projection against a quote's team: its own names, or the names the schedule join gave it */
  function sideMatch(t, aliasNames, quoteName) {
    if (sameTeam(t, quoteName)) return true;
    return (aliasNames || []).some(function (n) { return sameTeam({ name: n }, quoteName); });
  }

  /* ================================================================ */
  /* 1. QUOTES                                                         */
  /* ================================================================ */
  /**
   * Normalise one quote. q: { kind, book, american | decimal, captured_at, source, provider,
   *   event: {sport, home, away, start_utc, provider_event_id}, market: {kind, side, line}, other_side_american }
   * The kind is NEVER inferred upward: a quote with no kind is CAPTURED (it was stored), and only a
   * feed read younger than live_quote_age_min that says it is live may be called LIVE.
   */
  function normalizeQuote(q, now, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    q = q || {};
    var kind = QUOTE_KINDS[q.kind] ? q.kind : 'CAPTURED_SPORTSBOOK_QUOTE';
    var t = toMs(q.captured_at), n = toMs(now) != null ? toMs(now) : Date.now();
    var age = t == null ? null : Math.round((n - t) / 60000);
    if (kind === 'LIVE_SPORTSBOOK_QUOTE' && (age == null || age > cfg.live_quote_age_min)) kind = 'CAPTURED_SPORTSBOOK_QUOTE';
    var am = num(q.american); var dec = num(q.decimal);
    if (am == null && dec != null) am = decToAm(dec);
    if (dec == null && am != null) dec = amToDec(am);
    var m = q.market || {};
    return {
      kind: kind, kind_label: QUOTE_KINDS[kind].label, executable: QUOTE_KINDS[kind].executable,
      book: q.book || null, provider: q.provider || null, source: q.source || null,
      american: am != null && Math.abs(am) >= 100 ? Math.round(am) : null, decimal: dec != null && dec > 1 ? r6(dec) : null,
      captured_at: iso(q.captured_at), age_min: age,
      other_side_american: num(q.other_side_american),
      other_sides_american: Array.isArray(q.other_sides_american) ? q.other_sides_american.map(num).filter(function (x) { return x != null; }) : null,
      event: q.event || {}, market: { kind: str(m.kind).toLowerCase(), side: str(m.side).toLowerCase(), line: num(m.line) }
    };
  }
  /* a spread or total quote without a numeric line names no market: it is never priced (it would read as pick'em) */
  function usableQuote(q) { return !((q.market.kind === 'spread' || q.market.kind === 'total') && q.market.line == null); }

  /**
   * Identity: the quote names this event (sport, both teams on the right sides, start within tolerance).
   * alias (optional): { home: [names], away: [names] } — the schedule's names for this projection's teams,
   * from the discovery join, so "Bayern Munich" on the scoreboard is the engine's "FC Bayern München".
   */
  function verifyIdentity(proj, quote, cfg, alias) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    alias = alias || {};
    var ev = quote.event || {}, why = [];
    if (ev.sport && proj.sport && str(ev.sport) !== str(proj.sport) && str(ev.sport) !== str(proj.odds_key)) why.push('sport ' + ev.sport + ' is not ' + proj.sport);
    var hOk = sideMatch(proj.home, alias.home, ev.home), aOk = sideMatch(proj.away, alias.away, ev.away);
    if (!hOk || !aOk) {
      var swapped = sideMatch(proj.home, alias.home, ev.away) && sideMatch(proj.away, alias.away, ev.home);
      why.push(swapped ? 'the quote lists the teams the other way round (home/away swapped)' : 'the quote\'s teams (' + str(ev.away) + ' @ ' + str(ev.home) + ') are not ' + proj.away.name + ' @ ' + proj.home.name);
    }
    var ts = toMs(ev.start_utc), tp = toMs(proj.start_utc);
    if (ts != null && tp != null && Math.abs(ts - tp) > cfg.identity_start_tolerance_min * 60000) why.push('start times differ by ' + Math.round(Math.abs(ts - tp) / 60000) + ' minutes');
    if (ts == null) why.push('the quote carries no event start time');
    return { verified: !why.length, why: why };
  }

  /* ================================================================ */
  /* 2. ONE MARKET COMPARISON                                          */
  /* ================================================================ */
  function quoteFreshness(q, startMs, now, cfg) {
    if (!q.captured_at) return { status: 'UNTIMED', actionable: false, why: 'the quote has no capture time; it can never be called current' };
    if (q.age_min != null && q.age_min < -2) return { status: 'UNTIMED', actionable: false, why: 'the quote is timestamped in the future' };
    if (startMs != null && now >= startMs - cfg.kickoff_guard_min * 60000) return { status: 'STARTED', actionable: false, why: 'the event has started or starts inside the ' + cfg.kickoff_guard_min + '-minute guard' };
    if (q.age_min > cfg.max_quote_age_min) return { status: 'STALE', actionable: false, why: 'captured ' + q.age_min + ' min ago against a ' + cfg.max_quote_age_min + ' min limit' };
    return { status: q.kind === 'LIVE_SPORTSBOOK_QUOTE' ? 'LIVE' : 'CURRENT_CAPTURE', actionable: true, why: (q.kind === 'LIVE_SPORTSBOOK_QUOTE' ? 'live feed read ' : 'captured ') + q.age_min + ' min ago' };
  }
  /** Exact arithmetic through EDFAIR when it is loaded; the float formula otherwise (parity is tested). */
  function priceMath(pWin, pPush, american, otherAm, cfg) {
    var Fx = FAIR();
    var dec = amToDec(american);
    if (Fx && typeof Fx.evaluateWager === 'function') {
      var r = Fx.evaluateWager({ american: american, fair_probability: r6(pWin), push_probability: r6(pPush || 0), fair_source: { kind: 'MODEL', tier: 'VALIDATED', label: 'EdgeDesk independent projection' }, other_side_american: otherAm != null ? otherAm : undefined, thresholds: { ev_floor: cfg.ev_floor, candidate_ev: cfg.edge_bar } });
      if (r && r.ok) return { exact: true, decimal: num(r.entry_decimal), break_even: num(r.break_even_probability), ev: num(r.net_ev_per_dollar), no_vig_market: num(r.no_vig_market_probability), implied: num(r.market_probability), max_entry: r.maximum_entry_price, break_even_entry: r.break_even_entry_price };
    }
    if (dec == null) return null;
    var be = (1 - (pPush || 0)) / dec;
    var ev = pWin * (dec - 1) - (1 - pWin - (pPush || 0));
    return { exact: false, decimal: r6(dec), break_even: r6(be), ev: r6(ev), no_vig_market: null, implied: r6(1 / dec), max_entry: null, break_even_entry: null };
  }
  /**
   * The worst American price at which the conservative probability still clears the EDGE BAR (edge_bar, the
   * bar compareMarket classifies on): the "maximum acceptable price" and the "price to watch" are this one number.
   */
  function maxEntry(pCons, pPush, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    var Fx = FAIR();
    if (!(pCons > 0)) return null;
    if (Fx && typeof Fx.evaluateWager === 'function') {
      var r = Fx.evaluateWager({ american: 100, fair_probability: r6(Math.min(pCons, 0.999999)), push_probability: r6(pPush || 0), fair_source: { kind: 'MODEL', tier: 'VALIDATED' }, thresholds: { ev_floor: cfg.ev_floor, candidate_ev: cfg.edge_bar } });
      if (r && r.ok) return r.maximum_edge_entry_price != null ? num(r.maximum_edge_entry_price) : null;
    }
    var dmin = (1 - (pPush || 0) + cfg.edge_bar) / pCons;
    if (!(dmin > 1)) return null;
    var am = decToAm(dmin);
    return am == null ? null : (am > 0 ? Math.ceil(am) : Math.ceil(am));
  }

  /**
   * Compare ONE market of a frozen projection with the quotes offered for it.
   * frozen: one EDPROJ projection from a frozen snapshot. mk: { kind, side, line }.
   * quotes: normalised quotes for this event (any market). o: { now, n_compared, audit, cfg }
   */
  function compareMarket(frozen, mk, quotes, o) {
    o = o || {};
    var cfg = Object.assign({}, DEFAULTS, o.cfg || {});
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var Pj = P();
    var startMs = toMs(frozen.start_utc);
    var model = Pj ? Pj.probabilityAt(frozen, mk.kind, mk.side, mk.line) : null;
    var base = {
      projection_id: frozen.projection_id, projection_hash: frozen.projection_hash, frozen_at: frozen.frozen_at || null,
      sport: frozen.sport, event_id: frozen.event_id, event: frozen.away.name + ' @ ' + frozen.home.name, start_utc: frozen.start_utc,
      market: { kind: mk.kind, side: mk.side, line: mk.line == null ? null : mk.line }, selection: selectionText(frozen, mk),
      model: model ? { p_win: model.p_win, p_push: model.p_push, fair_american: model.fair_american, tier: model.tier, source: 'INDEPENDENT_MODEL_PROJECTION', model_id: frozen.model.id } : null,
      quote: null, books: [], market_reference: null, gates: [], outcome: null, reasons: [], compared_at: new Date(now).toISOString()
    };
    var tFrozen = toMs(frozen.frozen_at);
    if (tFrozen == null || now < tFrozen) return finish(base, 'INSUFFICIENT_MODEL_RELIABILITY', ['the projection was not frozen before this comparison; a price may not be compared with an unfrozen number']);
    /* the executable quotes for this exact market, identity-verified */
    var lined = mk.kind === 'spread' || mk.kind === 'total';
    var mine = (quotes || []).filter(function (q) { return usableQuote(q) && q.market.kind === mk.kind && q.market.side === mk.side && (lined ? mk.line != null && q.market.line === mk.line : true); });
    var idFail = [];
    var verified = mine.filter(function (q) { var v = verifyIdentity(frozen, q, cfg, o.alias); if (!v.verified) idFail.push(v.why.join('; ')); return v.verified; });
    var exec = verified.filter(function (q) { return q.executable && q.american != null; });
    var refs = verified.filter(function (q) { return !q.executable; });
    if (refs.length) base.market_reference = refs.map(function (r) { return { kind: r.kind, label: r.kind_label, american: r.american, line: r.market.line, source: r.source, captured_at: r.captured_at }; });
    if (!exec.length) return finish(base, 'NO_CURRENT_ODDS', [mine.length && !verified.length ? 'a quote was found but could not be matched to this event: ' + idFail[0] : refs.length ? 'only a reference line is on file (' + refs[0].kind_label + '); it is not a price' : 'no sportsbook quote for this market is on file']);
    /* freshness decides which quotes may be priced */
    exec.forEach(function (q) { q.freshness = quoteFreshness(q, startMs, now, cfg); });
    var fresh = exec.filter(function (q) { return q.freshness.actionable; });
    var bestAny = exec.slice().sort(function (a, b) { return b.decimal - a.decimal; })[0];
    if (!fresh.length) {
      base.quote = quoteView(bestAny);
      return finish(base, 'STALE_PRICE', [bestAny.freshness.why + ' — a stale price is never a current recommendation']);
    }
    fresh.sort(function (a, b) { return b.decimal - a.decimal; });
    var q = fresh[0];
    base.quote = quoteView(q);
    /* one entry per book (its best fresh price): two feeds reading the same book are one book */
    var seenBook = {};
    var perBook = fresh.filter(function (x) { var k = normTeam(x.book || '') || ('?' + x.source); if (seenBook[k]) return false; seenBook[k] = 1; return true; });
    base.books = perBook.map(function (x) { return { book: x.book, american: x.american, captured_at: x.captured_at, kind: x.kind, source: x.source }; });
    /* the model's eligibility to price: independent, a pricing tier, not invalidated */
    var elig = Pj ? Pj.pricingEligibility(frozen, mk.kind) : { ok: false, why: 'EDPROJ not loaded' };
    if (!model) return finish(base, 'INSUFFICIENT_MODEL_RELIABILITY', ['the projection\'s distribution does not cover ' + selectionText(frozen, mk) + '; no number is manufactured for an unsupported line']);
    if (!elig.ok) return finish(base, 'INSUFFICIENT_MODEL_RELIABILITY', [elig.why]);
    if (!PRICING_TIERS[model.tier]) return finish(base, 'INSUFFICIENT_MODEL_RELIABILITY', ['the engine\'s own validation calls ' + selectionText(frozen, mk) + ' ' + str(model.tier).toLowerCase().replace(/_/g, ' ') + ' — research only, no EV is quoted']);
    /* the numbers */
    var m = priceMath(model.p_win, model.p_push, q.american, q.other_side_american, cfg);
    if (!m) return finish(base, 'NO_CURRENT_ODDS', ['the quote\'s price could not be read']);
    var sd = Pj.marketSigma(frozen, mk.kind);
    var z = selectionZ(o.n_compared, cfg.alpha);
    var pCons = Math.max(0, model.p_win - z * sd.total);
    var evCons = pCons * (m.decimal - 1) - (1 - pCons - (model.p_push || 0));
    base.math = { decimal: m.decimal, implied_probability: m.implied, break_even_probability: m.break_even, ev_per_dollar: m.ev, exact_arithmetic: m.exact,
      sigma: sd, selection_z: r4(z), conservative_probability: r4(pCons), conservative_ev_per_dollar: r6(evCons),
      max_acceptable_american: maxEntry(pCons, model.p_push, cfg), break_even_american_at_model: m.break_even_entry,
      edge_bar: cfg.edge_bar, ev_floor: cfg.ev_floor };
    if (m.no_vig_market != null) base.market_reference = (base.market_reference || []).concat([{ kind: 'SHARP_MARKET_REFERENCE', label: 'this book\'s two sides, de-vigged (market-derived: a reference, never the model)', probability: r4(m.no_vig_market), book: q.book }]);
    /* a three-way market is de-vigged across all three outcomes (never as a two-way pair) */
    if (mk.kind === 'three_way' && q.other_sides_american && q.other_sides_american.length === 2) {
      var imps = [q.american].concat(q.other_sides_american).map(function (a) { var d = amToDec(a); return d ? 1 / d : null; });
      if (imps.every(function (x) { return x != null; })) base.market_reference = (base.market_reference || []).concat([{ kind: 'SHARP_MARKET_REFERENCE', label: 'this book\'s three outcomes, de-vigged (market-derived: a reference, never the model)', probability: r4(imps[0] / (imps[0] + imps[1] + imps[2])), book: q.book }]);
    }
    if (m.ev == null || m.ev <= 0) return finish(base, 'NO_VERIFIED_EDGE', ['at ' + fmtAm(q.american) + ' the price is worse than EdgeDesk\'s fair ' + fmtAm(model.fair_american) + ' (EV ' + pctS(m.ev) + ' per $1)']);
    if (m.ev > cfg.sane_ev) { base.data_check = true; return finish(base, 'MARKET_WATCH', ['DATA CHECK: EV ' + pctS(m.ev) + ' is past the ' + pctS(cfg.sane_ev) + ' sanity ceiling — a data or identity error is more likely than an edge; not ranked']); }
    if (evCons < cfg.edge_bar) return finish(base, 'MARKET_WATCH', ['positive at the point estimate (' + pctS(m.ev) + ') but ' + pctS(evCons) + ' on the conservative probability ' + pctS(pCons, 1) + ' (z ' + r4(z) + ' × σ ' + r4(sd.total) + '); the bar is ' + pctS(cfg.edge_bar) + (base.math.max_acceptable_american != null ? '; it clears at ' + fmtAm(base.math.max_acceptable_american) + ' or better' : '')]);
    /* execution gates — every one must pass for VERIFIED */
    var gates = [];
    var vc = Pj.valueClaims(frozen, mk.kind);
    gates.push({ gate: 'MODEL_MARKET_VALIDATED', ok: vc.ok, why: vc.why });
    var lu = Pj.lineupGate(frozen);
    gates.push({ gate: 'LINEUP_CONFIRMED', ok: lu.ok, why: lu.why });
    gates.push({ gate: 'LIVE_QUOTE', ok: q.kind === 'LIVE_SPORTSBOOK_QUOTE', why: q.kind === 'LIVE_SPORTSBOOK_QUOTE' ? 'read from a live feed ' + q.age_min + ' min ago' : 'a previously captured quote (' + (q.source || 'stored') + '), not a live read' });
    var clearing = perBook.filter(function (x) { var mm = priceMath(pCons, model.p_push, x.american, null, cfg); return mm && mm.ev != null && mm.ev >= cfg.ev_floor; });
    gates.push({ gate: 'BOOKS_CONFIRM', ok: clearing.length >= cfg.min_books, why: clearing.length + ' book' + (clearing.length === 1 ? '' : 's') + ' clear' + (clearing.length === 1 ? 's' : '') + ' the floor on the conservative probability (need ' + cfg.min_books + ' different books)' });
    var au = o.audit || null;
    gates.push({ gate: 'ADVERSARIAL_AUDIT', ok: !!(au && au.audit_execution === 'COMPLETED' && au.evidence_verification === 'VERIFIED'), why: au ? 'audit ' + str(au.audit_execution).toLowerCase() + ', evidence ' + str(au.evidence_verification).toLowerCase().replace(/_/g, ' ') : 'no adversarial audit was run on this market' });
    base.gates = gates;
    var open = gates.filter(function (g) { return !g.ok; });
    if (!open.length) return finish(base, 'VERIFIED_POSITIVE_EV', ['every execution gate passed']);
    return finish(base, 'CONDITIONAL_EDGE', open.map(function (g) { return g.gate.replace(/_/g, ' ').toLowerCase() + ': ' + g.why; }));
  }
  function quoteView(q) { return q ? { kind: q.kind, kind_label: q.kind_label, book: q.book, american: q.american, decimal: q.decimal, captured_at: q.captured_at, age_min: q.age_min, source: q.source, provider: q.provider, freshness: q.freshness || null } : null; }
  function finish(base, outcome, reasons) {
    base.outcome = outcome; base.outcome_label = OUTCOME_LABEL[outcome];
    base.reasons = (reasons || []).filter(Boolean);
    base.actionable = outcome === 'VERIFIED_POSITIVE_EV';
    return base;
  }
  function fmtAm(n) { n = num(n); return n == null ? '—' : (n > 0 ? '+' : '') + Math.round(n); }
  function pctS(x, d) { x = num(x); return x == null ? '—' : (x * 100).toFixed(d == null ? 2 : d) + '%'; }
  function selectionText(p, mk) {
    var side = mk.side === 'home' ? p.home.name : mk.side === 'away' ? p.away.name : mk.side === 'draw' ? 'Draw' : mk.side === 'over' ? 'Over' : mk.side === 'under' ? 'Under' : mk.side;
    if (mk.kind === 'moneyline') return side + ' moneyline';
    if (mk.kind === 'spread') return side + ' ' + (mk.line > 0 ? '+' : '') + mk.line;
    if (mk.kind === 'total') return side + ' ' + mk.line;
    if (mk.kind === 'three_way') return side + ' (90 minutes)';
    return side + ' ' + mk.kind;
  }

  /* ================================================================ */
  /* 3. THE WHOLE COMPARISON — frozen snapshot × quotes                */
  /* ================================================================ */
  /**
   * snapshot: EDPROJ.freeze(...) output. quotes: raw quotes (normalised here).
   * o: { now, cfg, audits: {projection_id|market: audit}, odds_disabled, aliases: {projection_id: {home: [names], away: [names]}} }
   * → { compared_at, snapshot_hash, snapshot_unchanged, rows, by_projection, counts }
   * Every market a projection supports is compared, priced or not, so "no odds" is a row, not a silence.
   */
  function compareSnapshot(snapshot, quotes, o) {
    o = o || {};
    var Pj = P();
    var now = toMs(o.now) != null ? toMs(o.now) : Date.now();
    var before = Pj ? Pj.snapshotHash(snapshot) : null;
    var qs = o.odds_disabled ? [] : (quotes || []).map(function (q) { return normalizeQuote(q, now, o.cfg); }).filter(usableQuote);
    var projections = (snapshot && snapshot.projections) || [];
    var tasks = [], matched = 0;
    projections.forEach(function (p) {
      if (!p || !Pj || !Pj.isIndependent(p)) return;
      var alias = o.aliases ? o.aliases[p.projection_id] || null : null;
      /* this event's quotes only: identity-verified, plus near misses (one team named, same day) so a mismatch is reported, not silent */
      var sameSport = qs.filter(function (q) { return q.event && (str(q.event.sport) === str(p.sport) || str(q.event.sport) === str(p.odds_key)); });
      var mine = sameSport.filter(function (q) { return verifyIdentity(p, q, o.cfg, alias).verified; });
      var evq = sameSport.filter(function (q) {
        if (mine.indexOf(q) >= 0) return true;
        var e = q.event || {}, ts = toMs(e.start_utc), tp = toMs(p.start_utc), al = alias || {};
        return ts != null && tp != null && Math.abs(ts - tp) < 86400000 && (sideMatch(p.home, al.home, e.home) || sideMatch(p.away, al.away, e.away) || sideMatch(p.home, al.home, e.away) || sideMatch(p.away, al.away, e.home));
      });
      matched += mine.filter(function (q) { return q.executable; }).length;
      Pj.comparableMarkets(p, mine).forEach(function (mk) { tasks.push({ p: p, mk: mk, quotes: evq, alias: alias }); });
    });
    /* N for the selection bar: the markets that actually have an executable quote */
    var nPriced = tasks.filter(function (t) { return t.quotes.some(function (q) { return q.executable && q.market.kind === t.mk.kind && q.market.side === t.mk.side && (t.mk.line == null || q.market.line === t.mk.line); }); }).length;
    var rows = tasks.map(function (t) { return compareMarket(t.p, t.mk, t.quotes, { now: now, n_compared: nPriced, alias: t.alias, audit: o.audits ? o.audits[t.p.projection_id + '|' + t.mk.kind + '|' + t.mk.side + '|' + (t.mk.line == null ? '' : t.mk.line)] : null, cfg: o.cfg }); });
    var after = Pj ? Pj.snapshotHash(snapshot) : null;
    var counts = {}; OUTCOMES.forEach(function (k) { counts[k] = 0; }); rows.forEach(function (r) { counts[r.outcome]++; });
    return {
      schema: VERSION, compared_at: new Date(now).toISOString(), odds_disabled: !!o.odds_disabled,
      snapshot_hash: before, snapshot_unchanged: before != null && before === after,
      quotes_in: qs.length, executable_quotes: qs.filter(function (q) { return q.executable; }).length, executable_quotes_matched: matched,
      priced_markets: nPriced, rows: rows, counts: counts, data_checks: rows.filter(function (r) { return r.data_check; }).length
    };
  }

  /* ================================================================ */
  /* 4. QUOTE SOURCES → the one quote shape                            */
  /* ================================================================ */
  /**
   * today/slate.json `markets` (the ESPN scoreboard snapshot of one book): a CAPTURED quote with the
   * book named, never live. events: today/slate.json events (to carry teams and start). sportOf: id → sport key.
   */
  function quotesFromScoreboard(today, sportOf) {
    var out = [];
    if (!today || !today.markets) return out;
    var byId = {}; (today.events || []).concat(today.upcoming || []).forEach(function (e) { byId[e.id] = e; });
    Object.keys(today.markets).forEach(function (id) {
      var m = today.markets[id], e = byId[id];
      if (!m || !e) return;
      var sport = sportOf ? sportOf(e) : e.sport;
      var ev = { sport: sport, home: e.home && e.home.name, away: e.away && e.away.name, start_utc: e.start_utc, provider_event_id: id };
      var b = { kind: 'CAPTURED_SPORTSBOOK_QUOTE', book: m.book || null, captured_at: m.captured_at || null, source: 'today/slate.json markets (' + (m.source || 'scoreboard') + ')', provider: m.source || 'espn_scoreboard', event: ev };
      var ml = m.moneyline || {};
      if (num(ml.draw) != null || sport === 'soccer') {
        /* a market with a draw is three-way (soccer's 1X2): each outcome against the other two, never a two-way pair */
        [['home', ml.home, [ml.draw, ml.away]], ['draw', ml.draw, [ml.home, ml.away]], ['away', ml.away, [ml.home, ml.draw]]].forEach(function (x) {
          if (num(x[1]) != null) out.push(Object.assign({}, b, { american: x[1], other_sides_american: x[2].every(function (y) { return num(y) != null; }) ? x[2] : null, market: { kind: 'three_way', side: x[0], line: null } }));
        });
      } else {
        if (num(ml.home) != null) out.push(Object.assign({}, b, { american: ml.home, other_side_american: ml.away, market: { kind: 'moneyline', side: 'home', line: null } }));
        if (num(ml.away) != null) out.push(Object.assign({}, b, { american: ml.away, other_side_american: ml.home, market: { kind: 'moneyline', side: 'away', line: null } }));
      }
      /* a spread or total without its point names no market, so it is not emitted */
      var sp = m.spread || {};
      if (sp.home && num(sp.home.price) != null && num(sp.home.point) != null) out.push(Object.assign({}, b, { american: sp.home.price, other_side_american: sp.away ? sp.away.price : null, market: { kind: 'spread', side: 'home', line: num(sp.home.point) } }));
      if (sp.away && num(sp.away.price) != null && num(sp.away.point) != null) out.push(Object.assign({}, b, { american: sp.away.price, other_side_american: sp.home ? sp.home.price : null, market: { kind: 'spread', side: 'away', line: num(sp.away.point) } }));
      var tt = m.total || {};
      if (num(tt.over) != null && num(tt.point) != null) out.push(Object.assign({}, b, { american: tt.over, other_side_american: tt.under, market: { kind: 'total', side: 'over', line: num(tt.point) } }));
      if (num(tt.under) != null && num(tt.point) != null) out.push(Object.assign({}, b, { american: tt.under, other_side_american: tt.over, market: { kind: 'total', side: 'under', line: num(tt.point) } }));
    });
    return out;
  }
  /**
   * The desk's captured `signals` rows (capture's best price per selection): CAPTURED quotes, the book named.
   * A row's sharp fair stays a SHARP_MARKET_REFERENCE beside it and is never handed to the model slot.
   */
  function quotesFromSignals(rows) {
    var out = [];
    (rows || []).forEach(function (r) {
      if (!r) return;
      /* soccer's h2h is the three-way 1X2 (the Odds API lists the Draw as a selection) */
      var soccer = /^soccer_/.test(str(r.sport_key));
      var mk = r.market === 'h2h' ? (soccer ? 'three_way' : 'moneyline') : r.market === 'spreads' ? 'spread' : r.market === 'totals' ? 'total' : null;
      if (!mk) return;
      var sel = str(r.selection).toLowerCase();
      var side = mk === 'total' ? (/^over/.test(sel) ? 'over' : /^under/.test(sel) ? 'under' : null)
        : mk === 'three_way' && normTeam(r.selection) === 'draw' ? 'draw'
          : (normTeam(r.selection) === normTeam(r.home_team) ? 'home' : normTeam(r.selection) === normTeam(r.away_team) ? 'away' : null);
      if (!side) return;
      if ((mk === 'spread' || mk === 'total') && num(r.point) == null) return;
      var ev = { sport: r.sport_key, home: r.home_team, away: r.away_team, start_utc: r.commence_time, provider_event_id: r.event_id };
      var dec = num(r.best_dec);
      if (dec != null && dec > 1) out.push({ kind: 'CAPTURED_SPORTSBOOK_QUOTE', book: r.best_book || null, decimal: dec, captured_at: r.last_seen_at || null, source: 'signals (capture)', provider: 'capture', event: ev, market: { kind: mk, side: side, line: num(r.point) } });
      var sf = num(r.sharp_fair);
      if (sf != null) out.push({ kind: 'SHARP_MARKET_REFERENCE', book: r.reference_book || 'sharp', american: sf > 0 && sf < 1 ? decToAm(1 / sf) : null, captured_at: r.last_seen_at || null, source: 'signals sharp_fair (market-derived)', provider: 'capture', event: ev, market: { kind: mk, side: side, line: num(r.point) } });
    });
    return out;
  }

  return {
    VERSION: VERSION, QUOTE_KINDS: QUOTE_KINDS, OUTCOMES: OUTCOMES, OUTCOME_LABEL: OUTCOME_LABEL, OUTCOME_RANK: OUTCOME_RANK, DEFAULTS: DEFAULTS, PRICING_TIERS: PRICING_TIERS,
    normalizeQuote: normalizeQuote, verifyIdentity: verifyIdentity, sameTeam: sameTeam, quoteFreshness: quoteFreshness, maxEntry: maxEntry,
    compareMarket: compareMarket, compareSnapshot: compareSnapshot, selectionZ: selectionZ, qnorm: qnorm,
    quotesFromScoreboard: quotesFromScoreboard, quotesFromSignals: quotesFromSignals, amToDec: amToDec, decToAm: decToAm
  };
});
/*__EDMKT_END__*/
