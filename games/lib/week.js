/* ===========================================================================
   EdgeDesk Games — the football week boundary.

   ONE documented boundary, shared by the leaderboard reset, the weekly score,
   the streak and the Pick 5 card. It is deliberately a pure function of a
   timestamp so that a browser in any zone, a Node test and a CI build all
   agree on which week a result belongs to.

   THE BOUNDARY: Tuesday 07:00 UTC (03:00 US Eastern).

   Why there: college football's week finishes with Monday night, and the
   repository's own football build already runs Tuesday morning UTC. Resetting
   a few hours before that build means a week's leaderboard closes on settled
   results and never straddles a ratings rebuild.

   A week is identified by the ISO date of its Tuesday start, e.g. "2026-09-01".
   That key sorts lexicographically, is stable forever, and is what historical
   weekly results are filed under.
   =========================================================================== */
(function (root) {
  'use strict';

  var BOUNDARY_DOW = 2;      /* Tuesday, per Date#getUTCDay */
  var BOUNDARY_HOUR = 7;     /* 07:00 UTC */
  var DAY = 86400000;

  /* The instant the week containing `ms` began. */
  function weekStart(ms) {
    var t = (ms == null ? Date.now() : ms);
    var d = new Date(t);
    /* step back to the most recent Tuesday 07:00 UTC */
    var anchor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), BOUNDARY_HOUR, 0, 0, 0);
    if (t < anchor) anchor -= DAY;              /* before 07:00 -> still yesterday's day */
    var dow = new Date(anchor).getUTCDay();
    var back = (dow - BOUNDARY_DOW + 7) % 7;
    return anchor - back * DAY;
  }

  /* "2026-09-01" — the key a week's results are filed under. */
  function weekKey(ms) {
    return new Date(weekStart(ms)).toISOString().slice(0, 10);
  }

  function weekEnd(ms) { return weekStart(ms) + 7 * DAY; }

  /* Whole days from `ms` to the next boundary — for "resets in 3 days". */
  function daysLeft(ms) {
    var t = (ms == null ? Date.now() : ms);
    return Math.max(0, Math.ceil((weekEnd(t) - t) / DAY));
  }

  /* Two timestamps in the same week? */
  function sameWeek(a, b) { return weekKey(a) === weekKey(b); }

  /* Calendar-day key in the boundary's own zone, used by the daily streak so
     that "yesterday" means the same thing everywhere. */
  function dayKey(ms) {
    var t = (ms == null ? Date.now() : ms);
    return new Date(t - BOUNDARY_HOUR * 3600000).toISOString().slice(0, 10);
  }

  /* Whole days between two day keys (b - a). */
  function dayDiff(a, b) {
    var pa = Date.parse(a + 'T00:00:00Z'), pb = Date.parse(b + 'T00:00:00Z');
    if (!isFinite(pa) || !isFinite(pb)) return null;
    return Math.round((pb - pa) / DAY);
  }

  var API = {
    BOUNDARY: { dow: BOUNDARY_DOW, hour_utc: BOUNDARY_HOUR,
      label: 'Tuesday 07:00 UTC (03:00 ET)' },
    weekStart: weekStart, weekEnd: weekEnd, weekKey: weekKey,
    daysLeft: daysLeft, sameWeek: sameWeek, dayKey: dayKey, dayDiff: dayDiff
  };
  root.EDGamesWeek = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
