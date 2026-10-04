/* Model Collective — which week is CURRENT, decided in one place.
 *
 * WHAT WENT WRONG
 *
 * "Current" used to mean: the week of the earliest game kicking off at or
 * after (now minus 36 hours). The grace was there so a week stayed current
 * through its Monday night game — but it was applied to the EARLIEST game
 * found rather than to the week's LAST one, so any game played inside the
 * last 36 hours pinned Current to its week. A Monday night college game
 * (SMU @ Florida State, Sep 7) therefore kept the front page on Week 1 all
 * through Sep 8, with the Week 2 slate already loaded, already priced, and
 * invisible. A finished game was the lead card on a page called Current.
 *
 * It was also the wrong QUESTION. A week is not current because of a clock
 * offset; it is current because it still has football left in it.
 *
 * THE RULE, once, here
 *
 *   Current is the EARLIEST week that still has a game to be played.
 *   When no week does, it is the LAST week that has games at all.
 *
 * That is the whole thing. It rolls forward the moment a slate is complete
 * and the next one exists, it stays put while a slate is being played, and
 * it never moves a settled game to a different week because it never writes
 * a week number at all — it only READS the one the schedule provider gave.
 *
 * WHERE THE WEEK NUMBER COMES FROM
 *
 * The provider. ESPN states the season, the season type and the week for
 * every fixture; tools/collective/sync_schedule.js loads them unchanged and
 * the Collective stores them on the game. Nothing here derives a week from a
 * date, and nothing here may: college football has a Week 0, Thursday and
 * Friday games, Tuesday MACtion in November, conference championships, bowls
 * and four playoff rounds, and (current_date - season_start) / 7 gets every
 * one of them wrong. This file sorts and groups the provider's numbers. It
 * does not invent one.
 *
 * THE ONE JUDGEMENT CALL
 *
 * A game that kicked off hours ago and still carries no final is either in
 * progress or a settlement that has not landed. Treating both as "still to be
 * played" would let one ungraded game pin Current forever — the failure this
 * file exists to end, wearing a different hat. So a kicked-off game holds its
 * week open for IN_PLAY_MS and no longer. Nothing is invented either way: the
 * game keeps its real status everywhere else on the site, and appears on its
 * own week's slate whether or not it holds that week open.
 *
 * Used by collective/index.html (the wall, the board and the counts on both),
 * tools/collective/sync_schedule.js (which weeks to load), and mirrored —
 * under a marked block, pinned by tools/collective/week_resolution.test.js —
 * in supabase/functions/collective_public/index.ts, which cannot import from
 * this repository because the dashboard bundles one folder.
 */
(function (global) {
  'use strict';

  var MCWeek = {};

  /* How long a kicked-off game with no final on file still counts as being
     played. Long enough for a full game plus overtime plus the settle job's
     hourly sweep; short enough that one game nobody ever settles cannot hold
     a whole season on its week. */
  var IN_PLAY_MS = 8 * 3600 * 1000;
  MCWeek.IN_PLAY_MS = IN_PLAY_MS;

  function ms(v) {
    if (v == null || v === '') return NaN;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : NaN;
  }

  /* HAS THIS GAME BEEN PLAYED? In any of the shapes this repository moves
     games around in: the board payload's nested result, a game_detail row's
     flat columns, or a status the settler has already written.

     A 0-0 settlement is a placeholder everywhere else on this site and is set
     aside from every grade — but it is NOT set aside here, because the
     question this file asks is not "is the score trustworthy", it is "is
     there still football to be played". A game somebody settled 0-0 has been
     played. Holding a whole week's Current open on a bad score would be the
     original bug with a different cause. */
  function hasFinal(g) {
    if (!g) return false;
    var r = g.result;
    if (r && r.home_score != null && r.away_score != null) return true;
    if (g.home_score != null && g.away_score != null) return true;
    return String(g.status || '').toLowerCase() === 'final';
  }
  MCWeek.hasFinal = hasFinal;

  /* Where a game stands, for the one purpose of deciding whether its week
     still has football in it.

       upcoming  not played yet
       live      kicked off inside the in-play window, no final on file
       final     a real final score, or the provider says final
       void      canceled, or postponed with a kickoff already in the past —
                 a postponement is re-scheduled with a new kickoff, and until
                 it is, its stale date must not hold a week open
       stale     kicked off long ago with no final: being settled, or a hole
                 in the data. Either way it stops holding its week open.  */
  function gameState(g, now) {
    if (!g) return 'void';
    now = now == null ? Date.now() : Number(now);
    var st = String(g.status || '').toLowerCase();
    if (st === 'canceled' || st === 'cancelled') return 'void';
    if (hasFinal(g)) return 'final';
    var k = ms(g.kickoff_at != null ? g.kickoff_at : g.start_date);
    if (st === 'postponed') return (isFinite(k) && k > now) ? 'upcoming' : 'void';
    /* No kickoff on file is a game that has not been played. It is on the
       slate and it holds its week — a schedule short of a date is exactly
       the state a sync is about to fix. */
    if (!isFinite(k)) return 'upcoming';
    if (k > now) return 'upcoming';
    if (now - k < IN_PLAY_MS) return 'live';
    return 'stale';
  }
  MCWeek.gameState = gameState;

  /* Does this game still have to be played? Only these two states hold a
     week open, and a week with one of them is the current week. */
  function isPending(g, now) {
    var s = gameState(g, now);
    return s === 'upcoming' || s === 'live';
  }
  MCWeek.isPending = isPending;

  function weekOf(g) {
    if (!g) return null;
    var w = g.week;
    if (w == null || w === '') return null;
    w = Number(w);
    return (isFinite(w) && Math.floor(w) === w && w >= 0) ? w : null;
  }
  MCWeek.weekOf = weekOf;

  /* THE WEEK A PAGE OF GAMES BELONGS TO, when the rows do not say.

     /v1/games is asked for one week at a time, so every game on a page
     fetched with ?week=2 IS a Week 2 game whether or not the row carries a
     `week` field -- and the deployed edge function did not carry one until
     the same day this resolver was written. Without this the forward scan
     asked for Week 2, received the whole Week 2 slate, found no row that
     said "2", counted the week as empty of football and left Current on the
     finished week: the bug this file exists to end, surviving in the one
     place that could not see it. A row that names its own week keeps it;
     nothing here overrides a provider's number. Copies, never the caller's
     rows -- the page normalises its own wire in one place (api()). */
  function withWeek(games, week) {
    var w = Number(week);
    if (week == null || !isFinite(w)) return (games || []).slice();
    return (games || []).map(function (g) {
      if (!g || (g.week != null && g.week !== '')) return g;
      var c = {};
      for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) c[k] = g[k];
      c.week = w;
      return c;
    });
  }
  MCWeek.withWeek = withWeek;

  /* Every week the given games actually carry, ascending. Week 0 is a week. */
  function weekNumbers(games) {
    var seen = {}, out = [];
    (games || []).forEach(function (g) {
      var w = weekOf(g);
      if (w == null || seen[w]) return;
      seen[w] = 1; out.push(w);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  MCWeek.weekNumbers = weekNumbers;

  /* A week is ACTIVE while any of its games is still to be played. An empty
     week is not active: there is nothing in it to be current about. */
  function weekIsActive(games, week, now) {
    var w = Number(week);
    return (games || []).some(function (g) {
      return weekOf(g) === w && isPending(g, now);
    });
  }
  MCWeek.weekIsActive = weekIsActive;

  /* Is this whole week done — it has games, and none of them is still to be
     played? The question a rollover asks, stated positively so a caller does
     not have to remember that "not active" also covers "empty". */
  function weekIsComplete(games, week, now) {
    var w = Number(week);
    var mine = (games || []).filter(function (g) { return weekOf(g) === w; });
    return mine.length > 0 && !mine.some(function (g) { return isPending(g, now); });
  }
  MCWeek.weekIsComplete = weekIsComplete;

  /* THE RULE, first half: the earliest week with football left in it, or null
     when none of the games given has any. Separate from the fallback because
     a caller holding only PART of a season — the server reads a window of
     weeks, not all of them — can use this half and supply the other half from
     a query it can actually answer. */
  function firstActiveWeek(games, now) {
    var weeks = weekNumbers(games);
    for (var i = 0; i < weeks.length; i++) {
      if (weekIsActive(games, weeks[i], now)) return weeks[i];
    }
    return null;
  }
  MCWeek.firstActiveWeek = firstActiveWeek;

  /* THE RULE. Earliest week with football left in it; failing that, the last
     week that has games; failing that, nothing — and nothing is null, never a
     guessed 1, because a board that invents a week shows an empty slate and
     blames the schedule. */
  function resolveCurrentWeek(games, now) {
    var weeks = weekNumbers(games);
    if (!weeks.length) return null;
    var active = firstActiveWeek(games, now);
    return active == null ? weeks[weeks.length - 1] : active;
  }
  MCWeek.resolveCurrentWeek = resolveCurrentWeek;

  /* ------------------------------------------------------------------ *
   * The same rule for a caller that can only see ONE WEEK AT A TIME.
   *
   * /v1/games serves a week per request, so the browser cannot hold the
   * season up to the rule above. It does not need to. The server's own
   * week-less answer is never AHEAD of the true current week — it is the week
   * of the earliest game still near the present — so the current week is that
   * week or a later one, and a forward scan finds it.
   *
   * Cost, in requests, in the state that matters: none. While a slate is
   * being played the first answer is already active and nothing else is
   * asked for. The scan runs on the days a week has just finished, which is
   * exactly when the page was wrong before.
   * ------------------------------------------------------------------ */

  /* How far forward to look, and when to stop looking. A schedule is loaded
     contiguously, so two empty weeks in a row means there is no more of it —
     which keeps the out-of-season case (nothing after the last week ever) to
     two extra requests rather than a scan of the whole calendar. Six weeks of
     reach covers a regular season rolling into a postseason whose earlier
     rounds are not loaded yet. */
  var SCAN_MAX = 6;
  var SCAN_EMPTY_STOP = 2;
  MCWeek.SCAN_MAX = SCAN_MAX;
  MCWeek.SCAN_EMPTY_STOP = SCAN_EMPTY_STOP;

  /* fetchWeek(week)  -> Promise of { week, games } | null   (null = week absent)
   *                     called with null for "whatever the server calls current"
   * maxWeek          -> the sport's last week, from the sport registry. Absent
   *                     means unbounded, which the scan caps anyway.
   *
   * Resolves to { week, payload, games, scanned, from } where `from` is
   * 'server' when the server's own answer stood and 'scan' when this rolled
   * it forward — the page prints that distinction nowhere, but a test and a
   * log both want it.  */
  async function resolveCurrentSlate(opts) {
    opts = opts || {};
    var fetchWeek = opts.fetchWeek;
    var now = opts.now == null ? Date.now() : Number(opts.now);
    var maxWeek = (opts.maxWeek == null || !isFinite(Number(opts.maxWeek)) ||
      Number(opts.maxWeek) <= 0) ? null : Number(opts.maxWeek);
    var scanned = [];

    var head = await fetchWeek(null);
    var headGames = (head && head.games) || [];
    var anchor = (head && head.week != null) ? Number(head.week)
      : resolveCurrentWeek(headGames, now);
    if (anchor == null || !isFinite(anchor)) {
      return { week: null, payload: head, games: headGames, scanned: scanned, from: 'server' };
    }
    /* The server named the week its rows belong to; rows that do not say so
       themselves are that week's. */
    headGames = withWeek(headGames, anchor);

    /* The server's answer stands whenever it still has football in it. This
       is the ordinary case and it costs nothing. */
    if (weekIsActive(headGames, anchor, now)) {
      return { week: anchor, payload: head, games: headGames, scanned: scanned, from: 'server' };
    }

    /* It does not. Walk forward to the first week that does. A later week
       that is ALSO complete is not the answer either — that is a reader two
       weeks behind, and the scan simply keeps going. */
    var empties = 0;
    for (var i = 1; i <= SCAN_MAX; i++) {
      var w = anchor + i;
      if (maxWeek != null && w > maxWeek) break;
      var page = null;
      try { page = await fetchWeek(w); } catch (e) { page = null; }
      /* Asked for by number, so this is week w's slate whatever the rows
         carry; a page that names its own week is trusted over the request. */
      var games = withWeek((page && page.games) || [],
        (page && page.week != null && isFinite(Number(page.week))) ? Number(page.week) : w);
      scanned.push(w);
      if (!games.length) {
        if (++empties >= SCAN_EMPTY_STOP) break;
        continue;
      }
      empties = 0;
      if (weekIsActive(games, w, now)) {
        return { week: w, payload: page, games: games, scanned: scanned, from: 'scan' };
      }
    }

    /* Nothing within reach has football left in it: the season is over, or
       the next slate is not loaded yet. THE ANCHOR STANDS. Rolling forward
       onto another finished week gains a reader nothing — both are history —
       and a scan that has not found football has not found the end of the
       season either, so it is in no position to name one. The whole-season
       rule's own fallback, the last week that has games, is exactly what the
       server's week-less answer already is. */
    return { week: anchor, payload: head, games: headGames, scanned: scanned, from: 'server' };
  }
  MCWeek.resolveCurrentSlate = resolveCurrentSlate;

  if (typeof module !== 'undefined' && module.exports) module.exports = MCWeek;
  global.MCWeek = MCWeek;
})(typeof window !== 'undefined' ? window : this);
