/* ===========================================================================
   EdgeDesk RESEARCH COMPARE — one comparison path for the Research Queue, the
   Smart Money Tonight cards and anything else that sets an EdgeDesk number
   beside a price. docs/research-compare/README.md

   It computes no probability and selects no wallet. It takes numbers other
   layers already published (the slate's model block, EDNHLCompare's view, a
   captured book price, a Polymarket price from radar_tonight()) and answers,
   for one exact contract: may these two numbers be compared, are both still
   current, and if so, by how much do they differ, in which direction.

   THE RULES
     1. Like for like or nothing. Two sides are compared only when the sport,
        the canonical event, the side, the market type, the period, the line
        and the settlement rules all match (compatible()). A moneyline is never
        set against a spread or puck line; NCAAM and NCAAW are different
        sports; a settlement rule that is not stated is not assumed.
     2. Unknown is not zero. A missing number stays null and the result says
        which one is missing and why. No 50%, no zero fee, no unlimited depth.
     3. Four clocks, never merged: when the source observed a price
        (observed_at), when EdgeDesk read it (ingested_at), when the model ran
        (generated_at) and how current its inputs were (inputs). Re-running a
        model or re-reading a cache does not make old inputs new. Each source
        has its own written limit (POLICY), not one global timeout.
     4. A pregame comparison stops being current at the start. There is no
        live model here, so a started game's comparison is PREGAME_ONLY.
     5. One rounding. A price is shown in cents to the tenth when it is not a
        whole cent; every difference printed is the difference of the two
        printed numbers, so "50¢ → 54¢" can never read "up 3¢".
     6. Signed one way. diff_cents = price − model fair, for the side named:
        positive means the price is ABOVE the model's fair value. Percentage
        points (pp) are probability differences; % is a return; ¢ is a price.
     7. Agreement is not evidence. Wallets and the model favouring the same
        side changes no status here, and no number is boosted for it.
     8. EV only when it is computable: an executable ask, a stated fee (zero
        only when the venue says zero), and a size the book can fill.

   Every result carries calc: RC.VERSION, so a published snapshot can be
   recomputed by the same rules.

   Browser: window.EDResearchCompare. Node: require('./edgedesk_research_compare.js').
   ES5, no dependencies (reads EDGames, EDNHLCompare, EDNHLMarket when present).
   =========================================================================== */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.EDResearchCompare = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  var RC = { VERSION: 'edgedesk_research_compare/1' };
  var MIN = 60000, H = 3600000;

  function req(name, file) {
    if (root && root[name]) return root[name];
    try { return typeof require === 'function' ? require(file) : null; } catch (_) { return null; }
  }
  function G() { return req('EDGames', './edgedesk_games.js'); }
  function NHLC() { return req('EDNHLCompare', './edgedesk_nhl_compare.js'); }
  function num(v) { if (v === null || v === undefined || v === '') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function ms(t) {
    if (typeof t === 'number') return isFinite(t) ? t : null;
    if (t == null || t === '') return null;
    var s = String(t).trim();
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;   /* an instant without a zone is refused (edgedesk_games rule 2) */
    var x = Date.parse(s);
    return isFinite(x) ? x : null;
  }
  function iso(t) { var x = ms(t); return x == null ? null : new Date(x).toISOString(); }
  RC.ms = ms;

  /* ================================================================ FLAG
     The rollout switch, terminal-side (app.html loads no EDFlags: tools/site/
     free_access.test.js). ON by default; ?rc=0 on the URL turns it off for that
     page view, ?rc=1 on. Rollback without a revert: set on:false here. */
  RC.FLAG = { name: 'research_compare', on: true };
  RC.enabled = function (search) {
    var s = search;
    if (s == null) { try { s = root && root.location ? root.location.search : ''; } catch (_) { s = ''; } }
    var m = /[?&]rc=([01])(?:&|#|$)/.exec(String(s || ''));
    return m ? m[1] === '1' : !!RC.FLAG.on;
  };

  /* ============================================================== POLICY
     Each limit is the source's own written rule or twice its schedule (one
     missed run is tolerated, two are not). Minutes. */
  RC.POLICY = {
    quotes: {
      /* ESPN's public scoreboard republishes one named book's line; it carries
         no observation time, so the clock is EdgeDesk's read (ingested_at).
         The board's past-price rule: lib/edgedesk_games.js CONFIG.market_limit_min */
      espn_scoreboard: { kind: 'indicative', max_age_min: 90, clock: 'ingested_at', label: 'scoreboard line (reference, not a quote)' },
      odds_api: { kind: 'indicative', max_age_min: 90, clock: 'observed_at', label: 'captured book price' },
      /* poly_price_snapshots (gamma outcome price, CLOB midpoint or CLOB price):
         radar_tonight() returns one only inside holders_fresh_min (supabase/radar.sql) */
      polymarket_price: { kind: 'indicative', max_age_min: 30, clock: 'ingested_at', label: 'Polymarket displayed price (not an ask)' },
      /* an order-book best ask: the SHARP-LAG registration's kalshi_max_age_min for an ask */
      polymarket_ask: { kind: 'executable_ask', max_age_min: 15, clock: 'observed_at', label: 'Polymarket best ask' }
    },
    references: {
      /* signals.sharp_fair: Pinnacle de-vigged (Shin). radar_rules() fair_max_age_min */
      pinnacle_devig: { max_age_min: 90, label: 'Pinnacle de-vigged reference' }
    },
    /* model artifacts: built by their workflow on a schedule (cron in brackets) */
    models: {
      'hockey/slate.json': { max_age_min: 6 * 60, label: 'EdgeDesk NHL model', cadence: 'every 3 h (nhl-build.yml)' },
      'nba/slate.json': { max_age_min: 6 * 60, label: 'EdgeDesk NBA model', cadence: 'every 3 h (nba-build.yml)' },
      'basketball/slate.json': { max_age_min: 30 * 60, label: 'EdgeDesk basketball lab model', cadence: 'daily (lab-build.yml)' },
      'football/nfl/slate.json': { max_age_min: 12 * 60, label: 'EdgeDesk NFL model', cadence: 'every 6 h (starter-context.yml)' },
      'football/cfb_terminal/board.json': { max_age_min: 30 * 60, label: 'EdgeDesk college football model', cadence: 'daily' }
    },
    /* "near fair value": the shown difference rounds to 0.0¢ (rule 5). Nothing wider is claimed. */
    near_cents: 0.05
  };

  /* ========================================================== SETTLEMENT
     How each side settles, as each source states it. 'incl_ot': the final
     result including overtime/shootout, no draw. 'incl_ot_tie_push': a tie
     voids (a two-way book's NFL moneyline). 'incl_ot_tie_half': a tie settles
     at 50¢ (Polymarket's NFL game markets). null: not stated, so never compared. */
  var OT = { moneyline: 'incl_ot', spread: 'incl_ot', total: 'incl_ot' };
  RC.SETTLE = {
    model: {
      'hockey/slate.json': OT,              /* lib/edgedesk_nhl_compare.js rule 4 */
      'nba/slate.json': OT,
      'basketball/slate.json': OT,
      'football/nfl/slate.json': { moneyline: null, spread: 'incl_ot', total: 'incl_ot' },  /* tie handling of home_win not stated */
      'football/cfb_terminal/board.json': OT
    },
    venue: {
      sportsbook: { _default: OT, nfl: { moneyline: 'incl_ot_tie_push', spread: 'incl_ot', total: 'incl_ot' } },
      polymarket: { _default: OT, nfl: { moneyline: 'incl_ot_tie_half', spread: 'incl_ot', total: 'incl_ot' } }
    }
  };
  function venueSettle(venue, sport, market) {
    var v = RC.SETTLE.venue[venue]; if (!v) return null;
    var s = v[sport] || v._default;
    return s && s[market] !== undefined ? s[market] : null;
  }
  RC.venueSettle = venueSettle;

  /* ============================================================== STATUS */
  RC.STATUS = {
    BELOW_FAIR: { label: 'Below model fair value', tone: 'ok', active: true },
    ABOVE_FAIR: { label: 'Above model fair value', tone: 'mute', active: true },
    NEAR_FAIR: { label: 'Near model fair value', tone: 'mute', active: true },
    COMPARED: { label: 'Model and price compared', tone: '', active: true },
    MODEL_STALE: { label: 'Model refresh needed', tone: 'warn', active: false },
    MODEL_AGE_UNKNOWN: { label: 'Model time not recorded', tone: 'warn', active: false },
    PRICE_STALE: { label: 'Price refresh needed', tone: 'warn', active: false },
    PRICE_MISSING: { label: 'No current price', tone: 'mute', active: false },
    MODEL_UNAVAILABLE: { label: 'Comparable model unavailable', tone: 'mute', active: false },
    INCOMPATIBLE: { label: 'Not comparable', tone: 'mute', active: false },
    PREGAME_ONLY: { label: 'Pregame comparison (game started)', tone: 'mute', active: false }
  };
  RC.label = function (status) { return (RC.STATUS[status] || {}).label || String(status || ''); };

  /* ============================================================ SPORTS */
  /* a slate sport id from a slate id, a radar/Odds API sport_key, or a league word */
  RC.sportOf = function (x) {
    var g = G(), s = String(x || '').toLowerCase();
    if (!s) return null;
    if (g && g.sport(s)) return s;
    if (g) for (var i = 0; i < g.SPORTS.length; i++) if ((g.SPORTS[i].odds || []).indexOf(s) >= 0) return g.SPORTS[i].id;
    var alias = { ncaaf: 'cfb', ncaab: 'ncaam', wncaab: 'ncaaw' };
    return alias[s] || null;
  };

  /* ============================================================ PRICES */
  RC.amToProb = function (a) { a = num(a); if (a == null || Math.abs(a) < 100) return null; return a > 0 ? 100 / (a + 100) : -a / (-a + 100); };
  /* proportional no-vig of a two-way pair; null unless both sides are priced */
  RC.noVig = function (a, b) {
    var pa = RC.amToProb(a), pb = RC.amToProb(b);
    if (pa == null || pb == null) return null;
    var s = pa + pb; return { a: pa / s, b: pb / s, overround: s - 1 };
  };
  /* a probability as the cents a reader sees: one decimal unless whole (rule 5) */
  RC.shownCents = function (p) {
    p = num(p); if (p == null) return null;
    var c = Math.round(p * 1000) / 10;
    return Math.abs(c - Math.round(c)) < 1e-9 ? Math.round(c) : c;
  };
  RC.centsText = function (p) { var c = RC.shownCents(p); return c == null ? '—' : String(c) + '¢'; };
  /* the difference of two shown prices, in cents, signed (a − b) */
  RC.shownDiff = function (a, b) {
    var x = RC.shownCents(a), y = RC.shownCents(b);
    return x == null || y == null ? null : Math.round((x - y) * 10) / 10;
  };
  function centsAbs(d) { var a = Math.abs(d); return (Math.abs(a - Math.round(a)) < 1e-9 ? String(Math.round(a)) : a.toFixed(1)) + '¢'; }
  RC.signedCents = function (d) { d = num(d); return d == null ? '—' : (d > 0 ? '+' : d < 0 ? '−' : '±') + centsAbs(d); };
  RC.ppText = function (v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1) + ' pp'; };
  RC.pctText = function (v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v * 100).toFixed(1) + '%'; };

  /* ========================================================= FRESHNESS */
  function ageMin(t, now) { var x = ms(t); return x == null ? null : Math.max(0, (now - x) / MIN); }
  RC.ageMin = ageMin;
  /* a quote: { source, kind, price, observed_at, ingested_at, size } */
  RC.quoteFreshness = function (q, now) {
    if (!q) return { state: 'missing', reason: 'no price on file' };
    var pol = RC.POLICY.quotes[q.source] || null;
    if (!pol) return { state: 'unknown', reason: 'no freshness rule for source ' + (q.source || 'unknown') };
    var t = pol.clock === 'observed_at' ? (q.observed_at || null) : (q.ingested_at || q.observed_at || null);
    var age = ageMin(t, now);
    if (age == null) return { state: 'unknown', reason: 'the price carries no time', max_age_min: pol.max_age_min };
    return { state: age <= pol.max_age_min ? 'fresh' : 'stale', age_min: Math.round(age), max_age_min: pol.max_age_min, clock: pol.clock, at: iso(t),
      reason: age <= pol.max_age_min ? null : 'price read ' + Math.round(age) + ' min ago (limit ' + pol.max_age_min + ')' };
  };
  /* a model block from the slate: { source, generated_at, data_quality, view:{data_state, goalie_certainty} }.
     sourceTimes: { 'hockey/slate.json': iso } from the slate's own sources list, when the block has no stamp */
  RC.modelFreshness = function (m, now, sourceTimes) {
    if (!m) return { state: 'missing', reason: 'no model projection for this game' };
    var pol = RC.POLICY.models[m.source] || null;
    var gen = m.generated_at || (sourceTimes && sourceTimes[m.source]) || null;
    var out = { generated_at: iso(gen), source: m.source || null, label: pol ? pol.label : (m.source ? 'model (' + m.source + ')' : 'model'), inputs: null };
    var v = m.view || {};
    /* inputs: what the model itself says about them; a fresh run on stale inputs is not fresh */
    if (m.data_quality && m.data_quality !== 'OK') out.inputs = { state: 'limited', reason: 'model inputs ' + String(m.data_quality).toLowerCase() };
    else if (v.data_state && v.data_state !== 'FRESH') out.inputs = { state: 'stale', reason: 'model inputs ' + String(v.data_state).toLowerCase() };
    else if (v.goalie_certainty && /UNCERTAIN|UNKNOWN/.test(v.goalie_certainty)) out.inputs = { state: 'ok', note: 'starting goalies not confirmed' };
    else out.inputs = { state: 'ok' };
    if (m.frozen_at) { out.state = 'frozen'; out.frozen_at = iso(m.frozen_at); out.reason = 'frozen before the start'; return out; }
    if (!pol) { out.state = 'unknown'; out.reason = 'no freshness rule for ' + (m.source || 'this model'); return out; }
    var age = ageMin(gen, now);
    out.max_age_min = pol.max_age_min;
    if (age == null) { out.state = 'unknown'; out.reason = 'the model block carries no generation time'; return out; }
    out.age_min = Math.round(age);
    if (out.inputs.state !== 'ok') { out.state = 'stale'; out.reason = out.inputs.reason; return out; }
    out.state = age <= pol.max_age_min ? 'fresh' : 'stale';
    out.reason = out.state === 'fresh' ? null : 'model built ' + Math.round(age / 60) + ' h ago (rebuilt ' + pol.cadence + ')';
    return out;
  };

  /* ===================================================== COMPATIBILITY
     a contract: { sport, event, side, market, period, line, settlement } */
  var FIELDS = [['sport', 'SPORT_MISMATCH', 'different sports'], ['event', 'EVENT_MISMATCH', 'different games'], ['market', 'MARKET_MISMATCH', 'different market types'],
    ['period', 'PERIOD_MISMATCH', 'different periods'], ['side', 'SIDE_MISMATCH', 'different sides']];
  RC.compatible = function (a, b) {
    if (!a || !b) return { ok: false, code: 'MISSING', reason: 'one side of the comparison is missing' };
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i][0];
      if (a[f] == null || b[f] == null) return { ok: false, code: FIELDS[i][1], reason: f + ' not stated' };
      if (String(a[f]) !== String(b[f])) return { ok: false, code: FIELDS[i][1], reason: FIELDS[i][2] + ' (' + a[f] + ' vs ' + b[f] + ')' };
    }
    var la = num(a.line), lb = num(b.line);
    if ((la == null) !== (lb == null) || (la != null && Math.abs(la - lb) > 1e-9)) return { ok: false, code: 'LINE_MISMATCH', reason: 'different lines (' + (la == null ? 'none' : la) + ' vs ' + (lb == null ? 'none' : lb) + ')' };
    if (!a.settlement || !b.settlement) return { ok: false, code: 'SETTLEMENT_UNKNOWN', reason: 'settlement rules not stated for ' + (!a.settlement ? 'the model' : 'the price') };
    if (a.settlement !== b.settlement) return { ok: false, code: 'SETTLEMENT_MISMATCH', reason: 'settlement differs (' + a.settlement + ' vs ' + b.settlement + ')' };
    return { ok: true, code: null, reason: null };
  };

  /* ============================================== EXECUTION AND EV (rule 8) */
  /* how much of `shares` the stated depth can fill. levels: [{price, size}] best first, or one {price, size} */
  RC.fill = function (levels, shares) {
    var L = Array.isArray(levels) ? levels : (levels ? [levels] : []);
    shares = num(shares);
    if (shares == null || shares <= 0) return { state: 'no_size', filled: null, reason: 'no size asked' };
    var have = 0, cost = 0, known = true;
    for (var i = 0; i < L.length && have < shares; i++) {
      var p = num(L[i].price), s = num(L[i].size);
      if (p == null) continue;
      if (s == null) { known = false; break; }
      var take = Math.min(s, shares - have); have += take; cost += take * p;
    }
    if (!known) return { state: 'depth_unknown', filled: null, reason: 'the size at the ask is not recorded' };
    if (have <= 0) return { state: 'insufficient', filled: 0, reason: 'no depth at the ask' };
    if (have < shares) return { state: 'partial', filled: have, avg_price: cost / have, reason: 'only ' + Math.floor(have) + ' of ' + shares + ' shares at the recorded depth' };
    return { state: 'full', filled: shares, avg_price: cost / shares, reason: null };
  };
  /* EV per $1 at the ask, held to settlement: p / (ask + fee) − 1. null with why, never a guess */
  RC.ev = function (p, quote) {
    p = num(p);
    if (p == null) return { value: null, reason: 'no model probability' };
    if (!quote || quote.kind !== 'executable_ask') return { value: null, reason: 'no executable ask (the price shown is indicative)' };
    var ask = num(quote.price), fee = num(quote.fee_per_share);
    if (ask == null || ask <= 0 || ask >= 1) return { value: null, reason: 'no valid ask' };
    if (fee == null) return { value: null, reason: 'the market’s fee is not recorded' };
    return { value: p / (ask + fee) - 1, reason: null, basis: 'one share at the best ask plus the market’s fee, held to settlement; top of book only' };
  };

  /* =========================================================== COMPARE
     o: { model: { contract, prob, line?, freshness }, quote: { contract, price, kind, source, ... },
          started, now, unit: 'prob'|'line' } */
  RC.compare = function (o) {
    var now = o.now == null ? Date.now() : o.now;
    var out = { calc: RC.VERSION, status: null, reason: null, contract: (o.quote && o.quote.contract) || (o.model && o.model.contract) || null,
      model: o.model || null, quote: o.quote || null, diff: null, ev: null, fill: null };
    function done(st, why) { out.status = st; out.reason = why || null; out.active = !!(RC.STATUS[st] || {}).active; return out; }
    if (!o.model || (num(o.model.prob) == null && num(o.model.line) == null)) return done('MODEL_UNAVAILABLE', (o.model && o.model.reason) || 'EdgeDesk has no number for this contract');
    if (!o.quote || (num(o.quote.price) == null && num(o.quote.prob) == null && num(o.quote.line) == null)) return done('PRICE_MISSING', (o.quote && o.quote.reason) || 'no price on file for this contract');
    var cmp = RC.compatible(o.model.contract, o.quote.contract);
    if (!cmp.ok) { out.incompatible = cmp.code; return done('INCOMPATIBLE', cmp.reason); }
    out.quote.freshness = out.quote.freshness || RC.quoteFreshness(o.quote, now);
    var mf = o.model.freshness || { state: 'unknown', reason: 'model freshness not checked' };
    if (o.started) return done('PREGAME_ONLY', 'the game has started; this pregame comparison is history, not a current one');
    if (mf.state === 'stale') return done('MODEL_STALE', mf.reason);
    if (mf.state === 'unknown') return done('MODEL_AGE_UNKNOWN', mf.reason);
    if (out.quote.freshness.state === 'stale') return done('PRICE_STALE', out.quote.freshness.reason);
    if (out.quote.freshness.state !== 'fresh') return done('PRICE_STALE', out.quote.freshness.reason || 'price time unknown');
    if (o.unit === 'line') {
      var d = Math.round((num(o.model.line) - num(o.quote.line)) * 10) / 10;
      out.diff = { value: d, abs: Math.abs(d), unit: 'pts' };
      return done('COMPARED');
    }
    if (o.unit === 'novig') {
      var pp = Math.round(o.model.prob * 1000) / 10 - Math.round(o.quote.prob * 1000) / 10;
      pp = Math.round(pp * 10) / 10;
      out.diff = { value: pp, abs: Math.abs(pp), unit: 'pp' };
      return done('COMPARED');
    }
    /* a contract price against the model's fair value, both in cents */
    var dc = RC.shownDiff(o.quote.price, o.model.prob);
    out.diff = { value: dc, abs: Math.abs(dc), unit: 'cents', price_cents: RC.shownCents(o.quote.price), fair_cents: RC.shownCents(o.model.prob) };
    out.ev = RC.ev(o.model.prob, o.quote);
    if (o.quote.kind === 'executable_ask') out.fill = o.stake_shares != null ? RC.fill([{ price: o.quote.price, size: o.quote.size }], o.stake_shares) : null;
    if (Math.abs(dc) <= RC.POLICY.near_cents) return done('NEAR_FAIR');
    return done(dc > 0 ? 'ABOVE_FAIR' : 'BELOW_FAIR');
  };
  /* a result that stops before any number is compared */
  RC.result = function (status, reason) { return { calc: RC.VERSION, status: status, reason: reason || null, active: !!(RC.STATUS[status] || {}).active, diff: null, ev: null, fill: null, model: null, quote: null }; };
  /* the sentence for a cents comparison (rule 6) */
  RC.sentence = function (r) {
    if (!r) return '';
    if (!r.active) return RC.label(r.status) + (r.reason ? ': ' + r.reason : '');
    if (!r.diff) return RC.label(r.status);
    if (r.diff.unit === 'cents') {
      var what = r.quote && r.quote.kind === 'executable_ask' ? 'Current ask' : 'Polymarket’s displayed price';
      if (r.status === 'NEAR_FAIR') return what + ' is at model fair value (0¢ apart' + (r.quote.kind === 'executable_ask' ? ', before fees' : '') + ').';
      return what + ' is ' + centsAbs(r.diff.value) + ' ' + (r.diff.value > 0 ? 'above' : 'below') + ' model fair value' + (r.quote.kind === 'executable_ask' ? ' before fees' : '') + '.';
    }
    return RC.label(r.status);
  };

  /* movement from a consistent reference: the same rounding on both ends */
  RC.movement = function (from, to) {
    var d = RC.shownDiff(to, from);
    if (d == null) return null;
    return { from: RC.shownCents(from), to: RC.shownCents(to), diff: d,
      text: RC.centsText(from) + ' → ' + RC.centsText(to) + ' (' + (d === 0 ? 'unchanged' : (d > 0 ? 'up ' : 'down ') + centsAbs(d)) + ')' };
  };

  /* never let an older observation replace a newer one: the held value stays
     unless the incoming one is at least as new (by `field`, else as_of) */
  RC.newer = function (held, incoming, field) {
    if (!incoming) return held || null;
    if (!held) return incoming;
    var f = field || 'as_of', a = ms(held[f]), b = ms(incoming[f]);
    if (a == null || b == null) return incoming;
    return b >= a ? incoming : held;
  };

  /* ===================================================== THE SLATE (queue)
     One game of today/slate.json: its model block and its captured book price,
     the first market both price, compared like for like. */
  function side(sp, mk) {
    return { sport: sp, event: null, side: 'home', market: mk, period: 'full_game', line: null, settlement: null };
  }
  RC.fromSlate = function (e, market, o) {
    o = o || {};
    var g = G(), now = o.now == null ? Date.now() : o.now;
    var sp = e && e.sport, S = g ? g.sport(sp) : null;
    var m = (e && e.research && e.research.model) || null, f = (m && m.fair) || {};
    var eff = g && g.effective ? g.effective(e, now) : e;
    var grp = g ? g.statusGroup(eff.status) : null;
    var started = grp === 'live' || grp === 'final';
    var mf = RC.modelFreshness(m, now, o.sourceTimes);
    var src = market ? (market.source === 'odds_api' ? 'odds_api' : 'espn_scoreboard') : null;
    var qbase = market ? { source: src, kind: 'indicative', venue: market.book || null, ingested_at: iso(market.captured_at), observed_at: src === 'odds_api' ? iso(market.captured_at) : null } : null;
    var mSettle = m ? (RC.SETTLE.model[m.source] || {}) : {};
    var tried = [];
    function pack(mk, model, quote, unit) {
      model.contract = Object.assign(side(sp, mk), { event: e.id, settlement: mSettle[mk] || null, line: model.cline != null ? model.cline : null });
      quote.contract = Object.assign(side(sp, mk), { event: e.id, settlement: venueSettle('sportsbook', sp, mk), line: quote.cline != null ? quote.cline : null });
      model.freshness = mf;
      var r = RC.compare({ model: model, quote: Object.assign({}, qbase, quote), started: started, now: now, unit: unit });
      r.market = mk; return r;
    }
    if (!m) return RC.result('MODEL_UNAVAILABLE', 'EdgeDesk has no model projection for this game');
    if (!market) return RC.result('PRICE_MISSING', 'no captured price on file for this game');
    var mkSp = market.spread && market.spread.home ? num(market.spread.home.point) : null;
    var nv = market.moneyline ? RC.noVig(market.moneyline.home, market.moneyline.away) : null;
    /* points sports: EdgeDesk's fair home spread against the book's home spread (lines, in points) */
    if (S && S.unit === 'points' && num(f.spread_home) != null && mkSp != null) {
      return pack('spread', { line: num(f.spread_home), text: num(f.spread_home) }, { line: mkSp }, 'line');
    }
    if (S && S.unit === 'points' && num(f.spread_home) != null) tried.push('spread (no book spread)');
    /* NHL: the matchup page's own like-for-like comparison (EDNHLCompare), its moneyline */
    if (sp === 'nhl' && m.view && NHLC() && nv) {
      var c = NHLC().compare(m.view, market, { now: now });
      var mlm = c && c.ok ? (c.markets || []).filter(function (x) { return x.kind === 'moneyline'; })[0] : null;
      var hs = mlm ? mlm.sides.filter(function (x) { return x.key === 'home'; })[0] : null;
      if (hs && hs.edgedesk_pct != null && hs.book_pct != null) {
        var r = pack('moneyline', { prob: hs.edgedesk_pct / 100 }, { prob: hs.book_pct / 100, price: null, american: hs.american }, 'novig');
        if (r.diff) r.diff.value = hs.gap_pp, r.diff.abs = Math.abs(hs.gap_pp);   /* the matchup page's gap, exactly */
        r.via = 'EDNHLCompare'; return r;
      }
    }
    /* moneyline: the model's home win probability against the book's no-vig home probability */
    var hp = num(f.home_win);
    if (hp == null && m.view && m.view.moneyline) hp = num(m.view.moneyline.home);
    if (hp != null && nv) return pack('moneyline', { prob: hp }, { prob: nv.a, american: num(market.moneyline.home) }, 'novig');
    if (hp != null) tried.push('moneyline (no two-sided book moneyline)');
    else if (market.moneyline) tried.push('moneyline (no model win probability)');
    var why = 'EdgeDesk has no number for the markets this price covers' + (tried.length ? ': ' + tried.join('; ') : '');
    return Object.assign(RC.compare({ model: null, quote: qbase, now: now }), { reason: why });
  };

  /* ======================================================= RADAR CARDS */
  /* the slate event a radar card is about: same sport, both clubs, within 6 h */
  RC.matchEvent = function (card, events) {
    var g = G(); if (!g || !card) return { event: null, reason: 'no schedule to match against' };
    var sp = RC.sportOf(card.sport_key);
    if (!sp) return { event: null, reason: 'sport not on EdgeDesk’s schedule (' + (card.sport_key || 'unknown') + ')' };
    var probe = { sport: sp, start_utc: card.commence_time, home: { name: card.home_team }, away: { name: card.away_team } };
    var hits = (events || []).filter(function (e) { return e && e.sport === sp && g.sameEvent(probe, e, 6); });
    if (!hits.length) return { event: null, reason: 'no matching game on EdgeDesk’s schedule' };
    if (hits.length > 1) return { event: null, reason: 'more than one matching game (doubleheader or duplicate); not guessed' };
    var e = hits[0];
    var flipped = !(g.sameSide(sp, probe.home, e.home) && g.sameSide(sp, probe.away, e.away));
    return { event: e, flipped: flipped, reason: null };
  };
  /* which side of the slate event the card's outcome is */
  function cardSide(card, e, sp) {
    var g = G(), o = { name: card.selection || card.outcome };
    if (card.market_type === 'totals') { var t = String(card.selection || card.outcome || '').toLowerCase(); return t === 'over' || t === 'under' ? t : null; }
    if (g.sameSide(sp, o, e.home)) return 'home';
    if (g.sameSide(sp, o, e.away)) return 'away';
    return null;
  }
  var RMK = { moneyline: 'moneyline', spreads: 'spread', totals: 'total' };
  /* EdgeDesk's probability for that exact contract, or why there is none */
  function modelProb(m, mk, sd, line) {
    var f = (m && m.fair) || {}, v = (m && m.view) || null;
    if (mk === 'moneyline') {
      var hp = v && v.moneyline ? num(v.moneyline.home) : num(f.home_win);
      if (hp == null) return { prob: null, reason: 'the model publishes no win probability for this game' };
      return { prob: sd === 'home' ? hp : 1 - hp };
    }
    if (mk === 'spread' && v && v.puck_line) {
      var homeLine = sd === 'home' ? line : -line;
      var pl = v.puck_line.filter(function (x) { return Math.abs(num(x.home_line) - homeLine) < 1e-9; })[0];
      if (!pl) return { prob: null, reason: 'the model prices no puck line at ' + line };
      if (num(pl.push)) return { prob: null, reason: 'a push is possible at this line; not compared as a binary price' };
      return { prob: sd === 'home' ? num(pl.home) : num(pl.away) };
    }
    if (mk === 'total' && v && v.total && v.total.lines) {
      var tl = v.total.lines.filter(function (x) { return Math.abs(num(x.line) - line) < 1e-9; })[0];
      if (!tl) return { prob: null, reason: 'the model prices no total at ' + line };
      if (num(tl.push)) return { prob: null, reason: 'a push is possible at this line; not compared as a binary price' };
      return { prob: sd === 'over' ? num(tl.over) : num(tl.under) };
    }
    return { prob: null, reason: 'the model publishes no probability for this ' + mk + ' line (a projected margin is not a win probability)' };
  }
  /* card: one radar_tonight() card. o: { events, now, sourceTimes, stake_shares } */
  RC.fromRadarCard = function (card, o) {
    o = o || {};
    var now = o.now == null ? Date.now() : o.now;
    var sp = RC.sportOf(card.sport_key), mk = RMK[card.market_type] || null, line = num(card.point);
    var start = ms(card.commence_time);
    var started = start != null && now >= start;
    var match = RC.matchEvent(card, o.events || []);
    var e = match.event, sd = e ? cardSide(card, e, sp) : null;
    var evId = e ? e.id : null;
    /* the price: an executable ask when the door carries one, else the displayed price */
    var ask = num(card.ask_price), quote;
    if (ask != null) quote = { source: 'polymarket_ask', kind: 'executable_ask', venue: 'Polymarket', price: ask, size: num(card.ask_size), observed_at: iso(card.ask_at || card.quoted_at), ingested_at: iso(card.ask_at || card.quoted_at), fee_per_share: num(card.fee_per_share), market_id: card.condition_id || null, token_id: card.token_id || null };
    else if (num(card.current_price) != null) quote = { source: 'polymarket_price', kind: 'indicative', venue: 'Polymarket', price: num(card.current_price), size: null, observed_at: null, ingested_at: iso(card.price_at), fee_per_share: null, market_id: card.condition_id || null, token_id: card.token_id || null };
    else quote = null;
    if (quote) quote.contract = { sport: sp, event: evId, side: sd, market: mk, period: 'full_game', line: mk === 'moneyline' ? null : line, settlement: venueSettle('polymarket', sp, mk) };
    var m = e && e.research ? e.research.model : null, model = null;
    if (!e) model = { prob: null, reason: 'Comparable model unavailable: ' + match.reason };
    else if (!m) model = { prob: null, reason: 'Comparable model unavailable: EdgeDesk has no model for this game' };
    else if (!sd) model = { prob: null, reason: 'Comparable model unavailable: the card’s side could not be matched to a club' };
    else {
      var mp = modelProb(m, mk, sd, line);
      var label = (RC.POLICY.models[m.source] || {}).label || 'EdgeDesk model';
      model = { prob: mp.prob, reason: mp.reason ? 'Comparable model unavailable: ' + mp.reason : null, source: m.source, label: label, tier: m.tier || null,
        validation: m.view && m.view.moneyline ? m.view.moneyline.market_status || null : null, note: m.note || null,
        freshness: RC.modelFreshness(m, now, o.sourceTimes),
        contract: { sport: sp, event: evId, side: sd, market: mk, period: 'full_game', line: mk === 'moneyline' ? null : line, settlement: (RC.SETTLE.model[m.source] || {})[mk] || null } };
    }
    var cmp = RC.compare({ model: model.prob == null ? Object.assign({}, model, { prob: null }) : model, quote: quote, started: started, now: now, stake_shares: o.stake_shares });
    if (cmp.status === 'MODEL_UNAVAILABLE' && model.reason) cmp.reason = model.reason.replace(/^Comparable model unavailable: /, '');
    /* the sharp reference (signals.sharp_fair), apart: never in the model's slot */
    var ref = null;
    if (num(card.fair) != null) {
      var age = ageMin(card.fair_seen_at, now), pol = RC.POLICY.references.pinnacle_devig;
      ref = { label: pol.label, price: num(card.fair), seen_at: iso(card.fair_seen_at), age_min: age == null ? null : Math.round(age),
        state: age == null ? 'unknown' : age <= pol.max_age_min ? 'fresh' : 'stale', max_age_min: pol.max_age_min };
    }
    /* what the wallets hold, as the door states it: the latest holders snapshot (holders_at), cost basis */
    var wallets = { n: num(card.n_wallets), cost_basis: num(card.dollars), avg_entry: num(card.avg_entry), holders_at: iso(card.holders_at),
      holders_age_min: card.holders_at ? Math.round(ageMin(card.holders_at, now)) : null, other_n: num(card.other_side_wallets), other_cost_basis: num(card.other_side_dollars) };
    var move = quote ? RC.movement(wallets.avg_entry, quote.price) : null;
    return { calc: RC.VERSION, event_id: card.event_id, slate_event: evId, sport: sp, market: mk, side: sd, line: line, started: started,
      wallets: wallets, model: model, quote: quote, reference: ref, comparison: cmp, movement: move, match: match };
  };

  /* ====================================================== ORDERING */
  var GRP = { live: 0, upcoming: 1, final: 2, off: 3 };
  /* Starting soon: what is on now, then by start; a time-TBD game after the
     timed games of its day; ties by id. Watchlist and completeness never move a row. */
  RC.compareSoon = function (a, b) {
    var x = (GRP[a.group] == null ? 4 : GRP[a.group]) - (GRP[b.group] == null ? 4 : GRP[b.group]); if (x) return x;
    var ka = a.sortKey != null ? a.sortKey : (a.start == null ? Infinity : a.start), kb = b.sortKey != null ? b.sortKey : (b.start == null ? Infinity : b.start);
    if (ka !== kb) return ka - kb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  RC.orderSoon = function (rows) { return (rows || []).slice().sort(RC.compareSoon); };

  /* Research priority: only active comparisons are ranked, and only within a
     group of like units (sport × market): a point is not a percentage point and
     an NFL point is not an NBA point. Within a group: the larger disagreement,
     then the earlier start, then the id. Everything else is listed apart with
     its reason. It is research priority, never a ranked recommendation. */
  RC.priority = function (rows) {
    var g = G(), groups = {}, order = [], out = [];
    (rows || []).forEach(function (r) {
      var c = r.cmp;
      if (!c || !c.active || !c.diff || c.diff.abs == null || c.diff.abs === 0 || r.group !== 'upcoming') { out.push(r); return; }
      var k = r.sport + '|' + c.market;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    var sportIx = function (s) { var i = g ? g.SPORTS.map(function (x) { return x.id; }).indexOf(s) : -1; return i < 0 ? 99 : i; };
    order.sort(function (a, b) { var pa = a.split('|'), pb = b.split('|'); return (sportIx(pa[0]) - sportIx(pb[0])) || (pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0); });
    return {
      groups: order.map(function (k) {
        var rs = groups[k].slice().sort(function (a, b) {
          return (b.cmp.diff.abs - a.cmp.diff.abs) || ((a.start == null ? Infinity : a.start) - (b.start == null ? Infinity : b.start)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        var p = k.split('|'), S = g ? g.sport(p[0]) : null;
        return { key: k, sport: p[0], market: p[1], unit: rs[0].cmp.diff.unit, label: (S ? S.label : p[0].toUpperCase()) + ' · ' + (p[1] === 'spread' ? (S && S.spread) || 'Spread' : p[1] === 'moneyline' ? 'Moneyline' : 'Total'), rows: rs };
      }),
      excluded: RC.orderSoon(out)
    };
  };

  /* =================================================== DIAGNOSTICS
     counts for the internal monitor (never the subscriber's flow) */
  RC.diagnostics = function (results) {
    var d = { calc: RC.VERSION, total: 0, by_status: {}, by_reason: {}, quote_age_min: [], model_age_min: [] };
    (results || []).forEach(function (r) {
      if (!r) return; d.total++;
      d.by_status[r.status] = (d.by_status[r.status] || 0) + 1;
      if (!r.active && r.reason) { var k = String(r.reason).replace(/\d+/g, 'N'); d.by_reason[k] = (d.by_reason[k] || 0) + 1; }
      if (r.quote && r.quote.freshness && r.quote.freshness.age_min != null) d.quote_age_min.push(r.quote.freshness.age_min);
      if (r.model && r.model.freshness && r.model.freshness.age_min != null) d.model_age_min.push(r.model.freshness.age_min);
    });
    return d;
  };

  /* ================================================== SNAPSHOT
     What a card showed when it was published, frozen: a refresh never edits it. */
  RC.snapshot = function (res, at) {
    var s = JSON.parse(JSON.stringify({ calc: RC.VERSION, published_at: iso(at), event_id: res.event_id || null, market: res.market || null, side: res.side || null,
      model: res.model ? { label: res.model.label || null, source: res.model.source || null, prob: res.model.prob, generated_at: res.model.freshness ? res.model.freshness.generated_at : null } : null,
      quote: res.quote ? { venue: res.quote.venue || null, kind: res.quote.kind, price: res.quote.price, size: res.quote.size == null ? null : res.quote.size,
        observed_at: res.quote.observed_at || null, ingested_at: res.quote.ingested_at || null, fee_per_share: res.quote.fee_per_share == null ? null : res.quote.fee_per_share,
        market_id: res.quote.market_id || null } : null,
      comparison: res.comparison ? { status: res.comparison.status, reason: res.comparison.reason, diff: res.comparison.diff, calc: res.comparison.calc } : null }));
    return deepFreeze(s);
  };
  function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { deepFreeze(o[k]); }); } return o; }

  return RC;
});
