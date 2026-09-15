/* ============================================================================
   THE SHARED SNAPSHOT CONTRACT — one definition of "a quote" for every surface.

   THE FAILURE IT ENDS. Four surfaces printed a price and each described it
   differently, so the same game could carry three numbers and no reader could
   tell which was which:

     the terminal      a live captured quote, refreshed on the page
     the newsletter    a quote captured when the edition was ASSEMBLED
     an archived issue that same quote, months later, still printed as a price
     an export         a point with no book, no capture time and no price

   The committed newsletter snapshot carried `{point, book}` and a single
   `captured_at` for the whole game. It carried NO American odds at all, no
   market type, no model version, no input cutoff, and no freshness state — so
   "EdgeDesk -8.5 against the market's +2.5" could be a live disagreement or a
   two-day-old number beside a model rebuilt an hour ago, and nothing on the
   page distinguished them. In the 2026 week-3 file every quote was captured
   on 2026-09-13 and the editorial run that used them was 2026-09-15.

   SO A QUOTE IS THIS, EVERYWHERE:

     game_id, sport, model_version, model_generated_at, input_cutoff,
     book, market_type, selection, side, line, odds_american, odds_decimal,
     captured_at, observed_age_s, freshness, snapshot_kind, retrieved_at

   and three rules hold wherever it is printed:

     1  FRESHNESS IS DERIVED FROM THE CAPTURE TIME AND THE KICKOFF, never
        from the model's timestamp. A model rebuilt this hour does not make a
        two-day-old price fresh, and `model_generated_at` travels beside
        `captured_at` precisely so the gap is visible.
     2  AN ARCHIVED PRICE IS NOT A CURRENT ONE. `snapshot_kind` is LIVE,
        EDITION (what an edition was assembled from) or ARCHIVE (a published
        edition being re-read later), and an ARCHIVE quote can never be
        presented as the market.
     3  MOVEMENT NEEDS TWO COMPARABLE QUOTES. `movement()` returns a number
        only when the same book, the same market and the same selection were
        captured at two different times. A different book at a different
        minute is not a line move, it is two prices.

   Nothing here fetches anything and nothing here prices anything. It
   normalises, it states freshness, and it refuses to compare things that are
   not comparable.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDSNAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA = 'edgedesk_market_snapshot_v2';
  var VERSION = 2;

  var KINDS = ['LIVE', 'EDITION', 'ARCHIVE'];
  var FRESHNESS = ['LIVE', 'RECENT', 'STALE', 'ARCHIVED', 'UNKNOWN'];

  /* How old a quote may be before it stops being the market. Tight near
     kickoff because that is when the number actually moves. */
  var AGE = { live_minutes: 30, recent_minutes: 240, near_kickoff_hours: 6, near_kickoff_live_minutes: 10 };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function ms(v) { if (v == null) return null; var t = (typeof v === 'number') ? v : Date.parse(v); return isFinite(t) ? t : null; }
  function iso(v) { var t = ms(v); return t == null ? null : new Date(t).toISOString(); }

  /* American <-> decimal, so a snapshot can carry both however the source
     stored one. Neither is invented: a missing price stays missing. */
  function decToAmerican(d) {
    if (!isNum(d) || d <= 1) return null;
    return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1));
  }
  function americanToDec(a) {
    if (!isNum(a) || a === 0) return null;
    return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }

  var MARKET_TYPES = { spreads: 'spreads', spread: 'spreads', totals: 'totals', total: 'totals',
    h2h: 'moneyline', moneyline: 'moneyline', ml: 'moneyline' };
  function marketType(m) { return MARKET_TYPES[String(m || '').toLowerCase()] || null; }

  /* ------------------------------------------------------------- freshness */
  /* THE STATE, AND WHY. `why` is the sentence a page prints; there is one of
     them and every surface uses it, so a terminal and a newsletter cannot
     describe the same quote differently. */
  function freshness(o) {
    o = o || {};
    var now = ms(o.now) || Date.now();
    var cap = ms(o.captured_at);
    var kick = ms(o.kickoff);
    var kind = KINDS.indexOf(o.snapshot_kind) >= 0 ? o.snapshot_kind : 'LIVE';
    if (kind === 'ARCHIVE') {
      return { state: 'ARCHIVED', age_s: cap == null ? null : Math.round((now - cap) / 1000),
        why: 'this price is what a published edition was assembled from on ' + (iso(cap) || 'an unrecorded date')
          + '; it is a record of what the market was, not a price anybody is offering now' };
    }
    if (cap == null) {
      return { state: 'UNKNOWN', age_s: null,
        why: 'no capture time travels with this number, so its age cannot be stated and it may not be called current' };
    }
    var ageS = Math.round((now - cap) / 1000);
    var nearKick = kick != null && (kick - now) < AGE.near_kickoff_hours * 3600e3;
    var liveMin = nearKick ? AGE.near_kickoff_live_minutes : AGE.live_minutes;
    if (ageS < 0) {
      return { state: 'UNKNOWN', age_s: ageS,
        why: 'the capture time is in the future relative to this build, so the clocks disagree and the age cannot be trusted' };
    }
    if (ageS <= liveMin * 60) return { state: 'LIVE', age_s: ageS,
      why: 'captured ' + mins(ageS) + ' ago' + (nearKick ? ', inside the six hours before kickoff when the number moves fastest' : '') };
    if (ageS <= AGE.recent_minutes * 60) return { state: 'RECENT', age_s: ageS,
      why: 'captured ' + mins(ageS) + ' ago — recent enough to quote as a reference, not recent enough to call the current price' };
    return { state: 'STALE', age_s: ageS,
      why: 'captured ' + mins(ageS) + ' ago; the market has had time to move and nothing here has checked' };
  }
  function mins(s) {
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' minute' + (Math.round(s / 60) === 1 ? '' : 's');
    if (s < 86400) return Math.round(s / 360) / 10 + ' hours';
    return Math.round(s / 8640) / 10 + ' days';
  }

  /* ------------------------------------------------------------ normalise */
  /* One quote, from whatever a source happened to call its columns. Anything
     absent stays absent WITH a reason; nothing is defaulted to zero. */
  function quote(raw, o) {
    raw = raw || {}; o = o || {};
    var now = ms(o.now) || Date.now();
    var mt = marketType(raw.market_type || raw.market);
    var dec = isNum(raw.odds_decimal) ? raw.odds_decimal : (isNum(raw.best_dec) ? raw.best_dec : null);
    var am = isNum(raw.odds_american) ? raw.odds_american : decToAmerican(dec);
    if (dec == null && isNum(am)) dec = americanToDec(am);
    var cap = iso(raw.captured_at || raw.last_seen_at || raw.observed_at);
    var kind = KINDS.indexOf(o.snapshot_kind) >= 0 ? o.snapshot_kind : (KINDS.indexOf(raw.snapshot_kind) >= 0 ? raw.snapshot_kind : 'LIVE');
    var f = freshness({ captured_at: cap, kickoff: raw.kickoff || o.kickoff, now: now, snapshot_kind: kind });
    var missing = [];
    if (!mt) missing.push('market_type');
    if (!isNum(raw.line) && !isNum(raw.point)) missing.push('line');
    if (am == null) missing.push('odds — the source stored a handicap with no price, so no expected value can be computed from it');
    if (!cap) missing.push('captured_at');
    if (!raw.book && !raw.best_book) missing.push('book');
    return {
      schema: SCHEMA, version: VERSION,
      game_id: raw.game_id == null ? null : String(raw.game_id),
      sport: raw.sport || o.sport || null,
      model_version: o.model_version || raw.model_version || null,
      model_generated_at: iso(o.model_generated_at || raw.model_generated_at),
      input_cutoff: iso(o.input_cutoff || raw.input_cutoff),
      book: raw.book || raw.best_book || null,
      market_type: mt,
      selection: raw.selection || null,
      side: raw.side || null,
      line: isNum(raw.line) ? raw.line : (isNum(raw.point) ? raw.point : null),
      odds_american: am, odds_decimal: dec == null ? null : Math.round(dec * 1000) / 1000,
      captured_at: cap,
      observed_age_s: f.age_s,
      freshness: f.state, freshness_why: f.why,
      snapshot_kind: kind,
      retrieved_at: iso(o.retrieved_at) || new Date(now).toISOString(),
      source: raw.source || o.source || null,
      missing: missing,
      /* THE ONE SENTENCE every surface prints under a price. */
      label: label({ book: raw.book || raw.best_book, line: isNum(raw.line) ? raw.line : raw.point,
        selection: raw.selection, odds_american: am, freshness: f, kind: kind })
    };
  }

  function label(q) {
    var head = (q.selection ? q.selection + ' ' : '')
      + (isNum(q.line) ? (q.line > 0 ? '+' : '') + q.line : 'no line')
      + (q.odds_american == null ? '' : ' (' + (q.odds_american > 0 ? '+' : '') + q.odds_american + ')');
    var where = q.book ? ' at ' + q.book : ' at an unnamed book';
    var when = q.kind === 'ARCHIVE' ? ' — archived edition price' : ' — ' + q.freshness.why;
    return head + where + when;
  }

  /* ------------------------------------------------------------- movement */
  /* TWO COMPARABLE QUOTES OR NOTHING. Same book, same market, same selection,
     two different capture times. Anything else returns a refusal that says
     which of those conditions failed, because "the line moved" printed off two
     different books is the kind of claim that quietly destroys trust. */
  function movement(a, b) {
    if (!a || !b) return { comparable: false, why: 'two quotes are needed and only one was supplied' };
    var reasons = [];
    if (!a.book || !b.book || String(a.book).toLowerCase() !== String(b.book).toLowerCase())
      reasons.push('different books (' + (a.book || 'unnamed') + ' vs ' + (b.book || 'unnamed') + ')');
    if (a.market_type !== b.market_type) reasons.push('different markets (' + a.market_type + ' vs ' + b.market_type + ')');
    if (a.market_type === 'spreads' && String(a.selection || '') !== String(b.selection || ''))
      reasons.push('quoted from different sides (' + (a.selection || '?') + ' vs ' + (b.selection || '?') + ')');
    if (!isNum(a.line) || !isNum(b.line)) reasons.push('one of the two carries no line');
    var ta = ms(a.captured_at), tb = ms(b.captured_at);
    if (ta == null || tb == null) reasons.push('one of the two carries no capture time');
    else if (ta === tb) reasons.push('both were captured at the same moment, so there is no interval to measure');
    if (reasons.length) return { comparable: false, why: reasons.join('; ') };
    var from = ta < tb ? a : b, to = ta < tb ? b : a;
    return {
      comparable: true, from_line: from.line, to_line: to.line,
      points: Math.round((to.line - from.line) * 100) / 100,
      from_at: from.captured_at, to_at: to.captured_at,
      book: from.book, market_type: from.market_type, selection: from.selection,
      why: 'the same ' + from.market_type + ' quote at ' + from.book + ', captured twice'
    };
  }

  /* ----------------------------------------------------------- reconcile */
  /* WHEN TWO SURFACES HOLD DIFFERENT NUMBERS FOR ONE GAME. Answers the only
     question that matters — is this one market moving, or two surfaces
     disagreeing — and never silently prefers one. */
  function reconcile(quotes, o) {
    o = o || {};
    var list = (quotes || []).filter(Boolean);
    if (!list.length) return { state: 'NONE', why: 'no quote reached this game', quotes: [] };
    var live = list.filter(function (q) { return q.snapshot_kind !== 'ARCHIVE'; });
    var arch = list.filter(function (q) { return q.snapshot_kind === 'ARCHIVE'; });
    var byLine = {};
    live.forEach(function (q) { if (isNum(q.line)) (byLine[q.line] = byLine[q.line] || []).push(q); });
    var lines = Object.keys(byLine);
    var current = live.slice().sort(function (a, b) { return (ms(b.captured_at) || 0) - (ms(a.captured_at) || 0); })[0] || null;
    if (!live.length) return { state: 'ARCHIVE_ONLY', current: null, archived: arch,
      why: 'every number on file for this game is an archived edition price; there is no current quote to show', quotes: list };
    if (lines.length <= 1) return { state: 'AGREED', current: current, archived: arch,
      why: 'every current quote on file carries the same handicap', quotes: list };
    var mv = movement(live[0], live[1]);
    return {
      state: mv.comparable ? 'MOVED' : 'CONFLICTING',
      current: current, archived: arch, movement: mv.comparable ? mv : null,
      why: mv.comparable
        ? 'the same book’s number was captured twice and moved ' + mv.points + ' points'
        : 'two different current quotes are on file and they are not comparable (' + mv.why
          + '), so this is presented as a disagreement between sources, not as a line move',
      quotes: list
    };
  }

  /* -------------------------------------------------------------- summary */
  /* The freshness picture for a whole slate, so a page can say "12 of 47
     prices are older than four hours" instead of implying all of them are
     current. */
  function coverage(quotes, o) {
    o = o || {};
    var out = { total: 0, by_freshness: {}, by_kind: {}, with_odds: 0, without_odds: 0,
      oldest_capture: null, newest_capture: null, books: {} };
    FRESHNESS.forEach(function (f) { out.by_freshness[f] = 0; });
    KINDS.forEach(function (k) { out.by_kind[k] = 0; });
    (quotes || []).forEach(function (q) {
      if (!q) return;
      out.total++;
      out.by_freshness[q.freshness] = (out.by_freshness[q.freshness] || 0) + 1;
      out.by_kind[q.snapshot_kind] = (out.by_kind[q.snapshot_kind] || 0) + 1;
      if (q.odds_american == null) out.without_odds++; else out.with_odds++;
      if (q.book) out.books[q.book] = (out.books[q.book] || 0) + 1;
      var t = ms(q.captured_at);
      if (t != null) {
        if (out.oldest_capture == null || t < ms(out.oldest_capture)) out.oldest_capture = q.captured_at;
        if (out.newest_capture == null || t > ms(out.newest_capture)) out.newest_capture = q.captured_at;
      }
    });
    out.current_share = out.total ? Math.round(((out.by_freshness.LIVE + out.by_freshness.RECENT) / out.total) * 1000) / 1000 : null;
    /* THE SENTENCE THAT STOPS A FRESH MODEL IMPLYING A FRESH MARKET. */
    out.statement = out.total
      ? (out.by_freshness.LIVE + ' live, ' + out.by_freshness.RECENT + ' recent, ' + out.by_freshness.STALE
        + ' stale and ' + out.by_freshness.ARCHIVED + ' archived of ' + out.total + ' quote(s); oldest captured '
        + (out.oldest_capture || 'at an unrecorded time')
        + (o.model_generated_at ? ', model rebuilt ' + o.model_generated_at : '')
        + '. A model timestamp says nothing about a price’s age.')
      : 'no quote reached this slate.';
    return out;
  }

  return {
    SCHEMA: SCHEMA, VERSION: VERSION, KINDS: KINDS, FRESHNESS: FRESHNESS, AGE: AGE,
    MARKET_TYPES: MARKET_TYPES, marketType: marketType,
    decToAmerican: decToAmerican, americanToDec: americanToDec,
    freshness: freshness, quote: quote, label: label, movement: movement,
    reconcile: reconcile, coverage: coverage
  };
});
