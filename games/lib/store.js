/* ===========================================================================
   EdgeDesk Games — anonymous-first persistence.

   A visitor plays before they are anybody. Everything a player earns lives in
   localStorage under one key, in one versioned envelope, so that:

     * the first game needs no account and no network;
     * a later sign-up can hand the WHOLE envelope to the account in one call
       (see `exportForAccount`) rather than needing a migration system;
     * a browser that blocks storage still plays — every read and write is
       wrapped, and the game degrades to "this session only" instead of
       breaking.

   NOTHING SENSITIVE GOES IN HERE. No email, no name, no token: a display name
   only exists once the player has typed one for a leaderboard.
   =========================================================================== */
(function (root) {
  'use strict';

  var KEY = 'edgedesk_games_v1';
  var VERSION = 1;
  var W = root.EDGamesWeek || (typeof require === 'function' ? require('./week.js') : null);

  function blank() {
    return {
      v: VERSION,
      created_at: new Date().toISOString(),
      display_name: null,
      streak: { current: 0, best: 0, last_day: null },
      /* results are kept per week so a weekly score and a weekly leaderboard
         are reads, not recomputations */
      weeks: {},
      price_it: { played: 0, score_total: 0, distance_total: 0, results: [] },
      pick5: { cards: {}, correct: 0, decided: 0 },
      attribution: null,
      seen: {}
    };
  }

  var memory = null;   /* the fallback when localStorage throws */

  function read() {
    var raw = null;
    try { raw = root.localStorage && root.localStorage.getItem(KEY); }
    catch (_) { raw = null; }
    if (!raw) return memory ? memory : (memory = blank());
    try {
      var o = JSON.parse(raw);
      if (!o || o.v !== VERSION) return memory ? memory : (memory = blank());
      /* defend against a hand-edited or truncated envelope */
      var b = blank(), k;
      for (k in b) if (b.hasOwnProperty(k) && o[k] == null) o[k] = b[k];
      return o;
    } catch (_) { return memory ? memory : (memory = blank()); }
  }

  function write(state) {
    memory = state;
    try { root.localStorage.setItem(KEY, JSON.stringify(state)); return true; }
    catch (_) { return false; }          /* private mode: play on, just unsaved */
  }

  /* `fn` may return a value to hand back to the caller. Returning undefined
     means "no particular result" and yields the whole state; returning null
     means "there was nothing to act on" and is passed through as null. */
  function update(fn) { var s = read(); var r = fn(s); write(s); return r === undefined ? s : r; }

  function storageWorks() {
    try {
      root.localStorage.setItem(KEY + '_t', '1');
      root.localStorage.removeItem(KEY + '_t');
      return true;
    } catch (_) { return false; }
  }

  /* ── the week bucket ───────────────────────────────────────────────────── */
  function weekBucket(s, ms) {
    var k = W ? W.weekKey(ms) : 'all';
    if (!s.weeks[k]) s.weeks[k] = { key: k, score: 0, price_it: 0, pick5_cards: 0, started_at: new Date().toISOString() };
    return s.weeks[k];
  }

  /* ── the daily streak ──────────────────────────────────────────────────────
     A streak counts CONSECUTIVE DAYS on which the player finished at least one
     challenge, in the same zone the weekly boundary uses. Playing twice in a
     day does not advance it; missing a day resets it to 1 on the next play. */
  function touchStreak(s, ms) {
    if (!W) return s.streak;
    var today = W.dayKey(ms), last = s.streak.last_day;
    if (last === today) return s.streak;
    var gap = last ? W.dayDiff(last, today) : null;
    s.streak.current = (gap === 1) ? (s.streak.current + 1) : 1;
    s.streak.last_day = today;
    if (s.streak.current > s.streak.best) s.streak.best = s.streak.current;
    return s.streak;
  }

  /* The streak as it should be DISPLAYED: a streak whose last play was before
     yesterday is already broken, and showing it as live would be a small lie. */
  function liveStreak(s, ms) {
    s = s || read();
    if (!W || !s.streak.last_day) return 0;
    var gap = W.dayDiff(s.streak.last_day, W.dayKey(ms));
    if (gap == null || gap > 1) return 0;
    return s.streak.current;
  }

  /* ── Price It ──────────────────────────────────────────────────────────── */

  /* Has this player already locked a price on this challenge?
     Repeat play is prevented per challenge so a score cannot be farmed by
     reloading; the stored result is replayed instead. */
  function priceItResult(gameId) {
    var s = read(), i, R = s.price_it.results;
    for (i = R.length - 1; i >= 0; i--) if (String(R[i].game_id) === String(gameId)) return R[i];
    return null;
  }

  /* Record one completed Price It. Returns the stored result — and if one was
     already stored for this challenge, returns THAT and records nothing, so
     the number a player was shown can never change under them. */
  function recordPriceIt(entry, ms) {
    var existing = priceItResult(entry.game_id);
    if (existing) return existing;
    return update(function (s) {
      var rec = {
        game_id: String(entry.game_id),
        slug: entry.slug || null,
        home_team: entry.home_team, away_team: entry.away_team,
        user_spread: entry.user_spread,
        edgedesk_spread: entry.edgedesk_spread,
        market_spread: entry.market_spread == null ? null : entry.market_spread,
        distance: entry.distance,
        /* the distance to the OTHER benchmark travels with the result too:
           the reveal shows "you are N points from the current market", and a
           replayed result must be able to say the same thing rather than
           quietly dropping a line the first view had */
        distance_to_market: entry.distance_to_market == null ? null : entry.distance_to_market,
        score: entry.score,
        benchmark: entry.benchmark,
        scoring_version: entry.scoring_version,
        research_state: entry.research_state || null,
        at: new Date(ms == null ? Date.now() : ms).toISOString(),
        week: W ? W.weekKey(ms) : null
      };
      s.price_it.results.push(rec);
      /* keep the tail bounded: a year of daily play is ~365 rows, and an
         unbounded array in localStorage eventually throws QuotaExceeded */
      if (s.price_it.results.length > 400) s.price_it.results = s.price_it.results.slice(-400);
      s.price_it.played++;
      s.price_it.score_total += rec.score || 0;
      s.price_it.distance_total += rec.distance || 0;
      var wk = weekBucket(s, ms);
      wk.score += rec.score || 0;
      wk.price_it++;
      touchStreak(s, ms);
      return rec;
    });
  }

  /* "12 games · average difference 2.7 pts" */
  function priceItRecord() {
    var s = read(), p = s.price_it;
    return {
      played: p.played,
      avg_score: p.played ? Math.round(p.score_total / p.played) : null,
      avg_distance: p.played ? Math.round((p.distance_total / p.played) * 10) / 10 : null
    };
  }

  /* ── Pick 5 ────────────────────────────────────────────────────────────── */

  function pick5Card(weekKey) { return read().pick5.cards[weekKey] || null; }

  /* A card is locked once submitted: five selections, one card per week. */
  function submitPick5(weekKey, selections, ms) {
    var existing = pick5Card(weekKey);
    if (existing && existing.submitted_at) return existing;
    return update(function (s) {
      var card = {
        week: weekKey,
        selections: selections,           /* [{game_id, slug, pick, home_team, away_team, market_spread}] */
        submitted_at: new Date(ms == null ? Date.now() : ms).toISOString(),
        settled: false, correct: null
      };
      s.pick5.cards[weekKey] = card;
      var wk = weekBucket(s, ms);
      wk.pick5_cards++;
      touchStreak(s, ms);
      return card;
    });
  }

  /* Settlement is applied from RESULTS the caller supplies, never guessed
     locally. `outcomes` maps game_id -> 'home' | 'away' | 'push'.

     INCREMENTAL AND IDEMPOTENT. Games finish at different times, so a card is
     settled repeatedly as results land. Only selections that do NOT already
     carry a decided result are graded and counted, which is what stops the
     all-time record from inflating every time the page is opened. A push is
     recorded but never counted as a decision, and a pushed game stays open in
     case the caller later supplies a real outcome for it. */
  function settlePick5(weekKey, outcomes) {
    return update(function (s) {
      var card = s.pick5.cards[weekKey];
      if (!card) return null;
      var newCorrect = 0, newDecided = 0;
      card.selections.forEach(function (sel) {
        if (sel.result === 'win' || sel.result === 'loss') return;   /* already counted */
        var o = outcomes[String(sel.game_id)];
        if (!o) return;
        if (o === 'push') { sel.result = 'push'; return; }
        newDecided++;
        sel.result = (o === sel.pick) ? 'win' : 'loss';
        if (sel.result === 'win') newCorrect++;
      });
      /* the card's own totals are RECOUNTED from its selections rather than
         accumulated, so they cannot drift */
      var decided = 0, correct = 0;
      card.selections.forEach(function (sel) {
        if (sel.result === 'win' || sel.result === 'loss') decided++;
        if (sel.result === 'win') correct++;
      });
      card.correct = correct; card.decided = decided;
      card.settled = decided === card.selections.length;
      if (!newDecided) return card;
      s.pick5.correct += newCorrect;
      s.pick5.decided += newDecided;
      if (s.weeks[weekKey]) s.weeks[weekKey].score += newCorrect;
      return card;
    });
  }

  function pick5Record() {
    var s = read();
    return { correct: s.pick5.correct, decided: s.pick5.decided,
      label: s.pick5.decided ? (s.pick5.correct + '–' + (s.pick5.decided - s.pick5.correct)) : null };
  }

  /* ── weekly score and history ──────────────────────────────────────────── */
  function weeklyScore(ms) {
    var s = read(), k = W ? W.weekKey(ms) : 'all';
    return (s.weeks[k] && s.weeks[k].score) || 0;
  }

  function weekHistory() {
    var s = read(), out = [], k;
    for (k in s.weeks) if (s.weeks.hasOwnProperty(k)) out.push(s.weeks[k]);
    out.sort(function (a, b) { return String(b.key).localeCompare(String(a.key)); });
    return out;
  }

  /* ── attribution ──────────────────────────────────────────────────────────
     GAMES DOES NOT KEEP ITS OWN ATTRIBUTION LEDGER. The landing page already
     runs one — `edgedesk_attribution`, mirrored to an `ed_ref` cookie, handed
     to the database when a subscription is created — and localStorage is
     per-origin, so /games and / genuinely share it.

     games/lib/attribution.js writes that same record under that same credit
     rule. These two functions are the seam: everything in Games that wants to
     know where a visitor came from asks here, and gets the answer the rest of
     the business will use. */
  var ATTR = root.EDGamesAttribution
    || (typeof require === 'function' ? require('./attribution.js') : null);

  function captureAttribution(search, referrer, ms) {
    if (!ATTR) return null;
    var loc = root.location || {};
    var r = ATTR.capture(search, referrer, loc.pathname || '/games/',
      new Date(ms == null ? Date.now() : ms).toISOString());
    return (r && r.first) || null;
  }

  function attribution() { return ATTR ? ATTR.first() : null; }

  /* ── one-time UI moments ───────────────────────────────────────────────── */
  function seen(k) { return !!read().seen[k]; }
  function markSeen(k) { return update(function (s) { s.seen[k] = true; }); }

  function displayName() { return read().display_name; }
  function setDisplayName(n) {
    return update(function (s) {
      s.display_name = n ? String(n).slice(0, 24).replace(/[<>]/g, '') : null;
    });
  }

  /* Has this player done enough that asking for an account is fair?
     Deliberately not on the first game: the ask comes after value. */
  function engaged() {
    var s = read();
    return (s.price_it.played + Object.keys(s.pick5.cards).length) >= 2;
  }

  /* Everything an account should inherit, in one object. Whatever accepts it
     later — an edge function, a table write — receives the whole anonymous
     history rather than needing a bespoke migration. */
  function exportForAccount() {
    var s = read();
    return { v: s.v, created_at: s.created_at, streak: s.streak, weeks: s.weeks,
      price_it: s.price_it, pick5: s.pick5, attribution: s.attribution };
  }

  function reset() {
    memory = blank();
    try { root.localStorage.removeItem(KEY); } catch (_) {}
    return memory;
  }

  var API = {
    KEY: KEY, VERSION: VERSION,
    read: read, write: write, reset: reset, storageWorks: storageWorks,
    liveStreak: liveStreak, touchStreak: touchStreak,
    priceItResult: priceItResult, recordPriceIt: recordPriceIt, priceItRecord: priceItRecord,
    pick5Card: pick5Card, submitPick5: submitPick5, settlePick5: settlePick5, pick5Record: pick5Record,
    weeklyScore: weeklyScore, weekHistory: weekHistory,
    captureAttribution: captureAttribution, attribution: attribution,
    seen: seen, markSeen: markSeen, displayName: displayName, setDisplayName: setDisplayName,
    engaged: engaged, exportForAccount: exportForAccount
  };
  root.EDGamesStore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
