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
      seen: {},
      /* ── the Dynasty layer (games/lib/dynasty.js reads these; nothing here
         computes XP) ──────────────────────────────────────────────────────
         events    one row per REAL thing that happened, keyed kind:key and
                   written once — a replayed page cannot write it twice
         research  the matchups this player has opened the research for,
                   one row per game, so "reviewed 10 unique games" is a read
         drill     Two-Minute Drill runs: one daily run per day (replayed,
                   never rescored) plus free-play history and a best
         visits    when this browser was last here, per football week, so a
                   "returned for another week" is a fact and not a guess
         dynasty   the last summary the player was SHOWN, so a level-up or an
                   achievement is celebrated exactly once */
      events: {},
      research: { opens: {} },
      drill: { runs: 0, best: 0, daily: {}, history: [] },
      visits: { first_at: null, last_at: null, last_day: null, days: 0, weeks: {} },
      dynasty: { seen: null },
      /* ── the franchise (games/lib/franchise.js) ───────────────────────
         snapshot   the last home read model the server returned, so the HQ
                    paints instantly and honestly says how old it is
         user_id    whose snapshot it is — a different account signing in
                    on this browser must never see the previous owner's
         queue      rewards the server has not confirmed yet (offline, or a
                    request that failed): each is replayed on the next
                    boot, and every one is idempotent on the server */
      franchise: { snapshot: null, fetched_at: null, user_id: null, queue: [] }
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
      var b = blank(), k, j;
      for (k in b) if (b.hasOwnProperty(k) && o[k] == null) o[k] = b[k];
      /* an envelope written before a nested key existed gets that key's
         default too, so a page never reads `undefined.opens` */
      ['research', 'drill', 'visits', 'dynasty', 'streak', 'price_it', 'pick5', 'franchise'].forEach(function (grp) {
        if (!o[grp] || typeof o[grp] !== 'object') o[grp] = b[grp];
        for (j in b[grp]) if (b[grp].hasOwnProperty(j) && o[grp][j] == null) o[grp][j] = b[grp][j];
      });
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


  /* ── the event ledger ────────────────────────────────────────────────────
     ONE row per real thing that happened, keyed `kind:key`, written ONCE.
     The Dynasty layer derives XP, missions and achievements by READING this
     ledger, so the only way to earn anything is for something real to be
     recorded here — and recording the same thing twice is a no-op, which is
     what makes a reload, a double-click or a replayed request worth nothing.

     `meta` is small, public-safe context (an opponent's display name, a mode).
     Returns { recorded: true|false, event }. */
  function recordEvent(kind, key, meta, ms) {
    if (!kind || key == null) return { recorded: false, event: null };
    var id = String(kind) + ':' + String(key);
    var s = read();
    if (s.events[id]) return { recorded: false, event: s.events[id] };
    return update(function (st) {
      var ev = {
        kind: String(kind), key: String(key),
        at: new Date(ms == null ? Date.now() : ms).toISOString(),
        week: W ? W.weekKey(ms) : null,
        day: W ? W.dayKey(ms) : null,
        meta: meta && typeof meta === 'object' ? meta : null
      };
      st.events[id] = ev;
      /* bounded: the ledger only grows with real activity, but localStorage
         has a ceiling and an old H2H row is worth less than the room */
      var ids = Object.keys(st.events);
      if (ids.length > 1500) {
        ids.sort(function (a, b) { return String(st.events[a].at).localeCompare(String(st.events[b].at)); });
        ids.slice(0, ids.length - 1500).forEach(function (old) { delete st.events[old]; });
      }
      return { recorded: true, event: ev };
    });
  }

  function hasEvent(kind, key) { return !!read().events[String(kind) + ':' + String(key)]; }

  /* Every event of one kind, oldest first. */
  function eventsOf(kind, s) {
    s = s || read();
    var out = [], id;
    for (id in s.events) if (s.events.hasOwnProperty(id) && s.events[id].kind === kind) out.push(s.events[id]);
    out.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    return out;
  }

  /* ── research opens ──────────────────────────────────────────────────────
     One row per matchup whose research this player opened. Unique per game,
     so opening the same page fifty times is one row — "reviewed 10 unique
     games" cannot be clicked into existence. Returns { first, rec }. */
  function recordResearchOpen(ch, ms) {
    if (!ch || ch.game_id == null) return { first: false, rec: null };
    var gid = String(ch.game_id);
    var s = read();
    if (s.research.opens[gid]) return { first: false, rec: s.research.opens[gid] };
    return update(function (st) {
      var rec = {
        game_id: gid, slug: ch.slug || null,
        home_team: ch.home_team || null, away_team: ch.away_team || null,
        research_state: ch.research_state || null,
        at: new Date(ms == null ? Date.now() : ms).toISOString(),
        week: W ? W.weekKey(ms) : null
      };
      st.research.opens[gid] = rec;
      return { first: true, rec: rec };
    });
  }

  function researchOpens(s) {
    s = s || read();
    var out = [], k;
    for (k in s.research.opens) if (s.research.opens.hasOwnProperty(k)) out.push(s.research.opens[k]);
    out.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
    return out;
  }

  /* ── the Two-Minute Drill ────────────────────────────────────────────────
     A DAILY run is one per day and is replayed, never rescored — the same
     rule Price It applies per challenge. A FREE run is always recorded (it
     counts toward the run total and the best) but never toward the weekly
     score, so the leaderboard number cannot be farmed by playing all night. */
  function drillDaily(dayKey) { return read().drill.daily[dayKey] || null; }

  function recordDrill(res, ms) {
    if (!res) return null;
    var day = res.day || (W ? W.dayKey(ms) : 'all');
    if (res.mode === 'daily') {
      var existing = drillDaily(day);
      if (existing) return existing;
    }
    return update(function (s) {
      var rec = {
        mode: res.mode === 'daily' ? 'daily' : 'free',
        day: day,
        seed: res.seed || null,
        rounds: res.rounds | 0, correct: res.correct | 0,
        points: res.points | 0, clock_points: res.clock_points | 0, total: res.total | 0,
        lives_left: res.lives_left == null ? null : (res.lives_left | 0),
        clock_left: res.clock_left == null ? null : Math.round(res.clock_left * 10) / 10,
        ended: res.ended || null,
        scoring_version: res.scoring_version || null,
        /* which matchups were in the run, so the reveal can be rebuilt and
           the research links resolved after a reload */
        game_ids: Array.isArray(res.game_ids) ? res.game_ids.map(String) : [],
        misses: Array.isArray(res.misses) ? res.misses.map(String) : [],
        at: new Date(ms == null ? Date.now() : ms).toISOString(),
        week: W ? W.weekKey(ms) : null
      };
      s.drill.runs++;
      if (rec.total > (s.drill.best || 0)) s.drill.best = rec.total;
      if (rec.mode === 'daily') {
        s.drill.daily[day] = rec;
        var wk = weekBucket(s, ms);
        /* ten points per correct answer, so a perfect daily drill is worth
           one dead-on Price It — comparable, not dominant */
        wk.drill = (wk.drill || 0) + rec.correct * 10;
        wk.score += rec.correct * 10;
        touchStreak(s, ms);
      } else {
        s.drill.history.push(rec);
        if (s.drill.history.length > 100) s.drill.history = s.drill.history.slice(-100);
      }
      return rec;
    });
  }

  function drillRecord() {
    var s = read(), days = Object.keys(s.drill.daily).length;
    return { runs: s.drill.runs, best: s.drill.best, daily_played: days };
  }

  /* ── visits ──────────────────────────────────────────────────────────────
     Called once per page view. Records the fact of the visit per football
     week and per day, and returns what KIND of return this is so the funnel
     can count real retention (return_1d, return_7d, a new football week)
     rather than page views. Nothing here awards anything by itself. */
  function touchVisit(ms) {
    var now = ms == null ? Date.now() : ms;
    var s = read(), prev = s.visits.last_at ? Date.parse(s.visits.last_at) : null;
    var prevDay = s.visits.last_day, today = W ? W.dayKey(now) : 'all';
    var wk = W ? W.weekKey(now) : 'all';
    var out = {
      first: !prev,
      new_day: prevDay !== today,
      new_week: !s.visits.weeks[wk],
      gap_days: (prevDay && W) ? W.dayDiff(prevDay, today) : null,
      return_1d: false, return_7d: false, return_week: false
    };
    if (out.gap_days != null) {
      out.return_1d = out.gap_days >= 1;
      out.return_7d = out.gap_days >= 7;
    }
    /* a new football week is a return only if an EARLIER week saw play */
    if (out.new_week) {
      var k, played = false;
      for (k in s.weeks) if (s.weeks.hasOwnProperty(k) && k < wk
        && ((s.weeks[k].price_it | 0) + (s.weeks[k].pick5_cards | 0) + (s.weeks[k].drill | 0)) > 0) played = true;
      out.return_week = played;
    }
    update(function (st) {
      var iso = new Date(now).toISOString();
      if (!st.visits.first_at) st.visits.first_at = iso;
      st.visits.last_at = iso;
      if (st.visits.last_day !== today) { st.visits.last_day = today; st.visits.days = (st.visits.days | 0) + 1; }
      if (!st.visits.weeks[wk]) st.visits.weeks[wk] = { first_at: iso, returned: out.return_week };
    });
    return out;
  }

  /* ── the Dynasty "seen" marker ───────────────────────────────────────────
     The summary the player was last shown. games.js compares the live summary
     against it to decide what to celebrate, then writes the new one — so a
     level-up is announced once, on whichever page first notices it. */
  function dynastySeen() { return read().dynasty.seen; }
  function markDynastySeen(summary) {
    return update(function (s) { s.dynasty.seen = summary || null; });
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
    return (s.price_it.played + Object.keys(s.pick5.cards).length
      + Object.keys(s.drill.daily).length) >= 2;
  }

  /* Everything an account should inherit, in one object. Whatever accepts it
     later — an edge function, a table write — receives the whole anonymous
     history rather than needing a bespoke migration. */
  function exportForAccount() {
    var s = read();
    return { v: s.v, created_at: s.created_at, streak: s.streak, weeks: s.weeks,
      price_it: s.price_it, pick5: s.pick5, attribution: s.attribution,
      events: s.events, research: s.research, drill: s.drill, visits: s.visits };
  }

  /* ── the franchise cache and the reward queue ─────────────────────────
     The server is the source of truth for a franchise; this is the copy the
     page paints before the network answers. A snapshot belongs to ONE
     account: reading it for a different (or no) signed-in user returns
     nothing, so a shared phone never shows the last owner's HQ. */
  function franchiseSnapshot(userId) {
    var f = read().franchise;
    if (!f || !f.snapshot) return null;
    if (userId && f.user_id && f.user_id !== userId) return null;
    if (!userId) return null;
    return f.snapshot;
  }
  function franchiseFetchedAt() { return read().franchise.fetched_at || null; }
  function setFranchiseSnapshot(snapshot, userId, ms) {
    return update(function (s) {
      s.franchise.snapshot = snapshot || null;
      s.franchise.user_id = userId || null;
      s.franchise.fetched_at = snapshot ? new Date(ms == null ? Date.now() : ms).toISOString() : null;
    });
  }
  function clearFranchise() {
    return update(function (s) { s.franchise = blank().franchise; });
  }
  /* one queued reward per key: a replayed page cannot queue the same thing
     twice, and the server would refuse it anyway */
  function queueFranchise(item) {
    if (!item || !item.key) return false;
    return update(function (s) {
      var i, q = s.franchise.queue;
      for (i = 0; i < q.length; i++) if (q[i].key === item.key) return false;
      q.push({ key: item.key, fn: item.fn, args: item.args, at: new Date().toISOString() });
      if (q.length > 200) s.franchise.queue = q.slice(-200);
      return true;
    });
  }
  function franchiseQueue() { return read().franchise.queue.slice(); }
  function dequeueFranchise(key) {
    return update(function (s) {
      s.franchise.queue = s.franchise.queue.filter(function (q) { return q.key !== key; });
    });
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
    engaged: engaged, exportForAccount: exportForAccount,
    recordEvent: recordEvent, hasEvent: hasEvent, eventsOf: eventsOf,
    recordResearchOpen: recordResearchOpen, researchOpens: researchOpens,
    drillDaily: drillDaily, recordDrill: recordDrill, drillRecord: drillRecord,
    touchVisit: touchVisit, dynastySeen: dynastySeen, markDynastySeen: markDynastySeen,
    franchiseSnapshot: franchiseSnapshot, franchiseFetchedAt: franchiseFetchedAt,
    setFranchiseSnapshot: setFranchiseSnapshot, clearFranchise: clearFranchise,
    queueFranchise: queueFranchise, franchiseQueue: franchiseQueue, dequeueFranchise: dequeueFranchise
  };
  root.EDGamesStore = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
