#!/usr/bin/env node
/* ============================================================================
   THE EDITION CLOCK — when a newsletter is owed, in a zone that changes its
   offset twice a year.

   TWO EDITIONS, BOTH AT 10:00 AMERICA/CHICAGO:

     CFB   Monday    — the college week ahead
     NFL   Tuesday   — the NFL week ahead, after Monday Night Football

   WHY THE ZONE IS THE HARD PART. 10:00 in Chicago is 15:00 UTC for most of
   the year and 16:00 UTC from November to March. A cron expression is a fixed
   UTC instant, so ANY single cron line is wrong for half the season, and a
   cron line per half is a thing somebody has to remember to change. The two
   failure modes are not symmetric either: firing an hour early sends a
   newsletter before Monday Night Football has finished being reconciled.

   SO THE CRON DOES NOT DECIDE. The scheduled job runs OFTEN (several times
   across the plausible hours on Monday and Tuesday) and this file decides
   whether an edition is actually owed, by converting the CHICAGO WALL CLOCK
   to an instant using the zone database the runtime already ships. The cron
   line is a heartbeat; `dueFor()` is the schedule.

   THE CONVERSION, stated once. Intl can tell you what the wall clock reads in
   a zone at a given instant; it cannot directly tell you the instant at which
   a given wall clock reads. The standard two-pass solve does:

     1  pretend the wall clock is UTC, which is wrong by the offset;
     2  ask the zone what its offset was at that wrong instant and subtract it;
     3  ask AGAIN at the corrected instant, because step 2's answer came from
        the wrong side of a DST boundary when the target is within an hour of
        one. The second pass is what makes the spring-forward Sunday correct.

   A RETRY WINDOW, NOT A CLIFF. An edition is due at 10:00 and stays sendable
   until `retry_window_minutes` later. That is what lets the NFL edition wait
   for a delayed Monday night result and still go out the same morning, and
   what stops a newsletter arriving at 9pm because a runner was wedged. Past
   the window the edition is STALE and is held with a reason rather than sent.

   NOTHING HERE READS A CLOCK IT WAS NOT GIVEN. Every function takes `now`, so
   the suite can stand on a spring-forward Sunday for as long as it likes.
   ========================================================================== */
'use strict';

const ZONE = 'America/Chicago';

/* The two editions. Adding a third sport is adding a row. `weekday` is the
   ISO-ish short name Intl emits, which is also what the rest of this
   repository compares against (featured.js easternParts). */
const EDITIONS = {
  CFB: {
    sport: 'CFB',
    label: 'College Football',
    title: 'College Football Week Ahead',
    weekday: 'Mon',
    hour: 10,
    minute: 0,
    zone: ZONE,
    /* Monday morning has nothing to wait for — Saturday's games settled two
       days ago — so the window exists only to survive a late runner. */
    retry_window_minutes: 240,
  },
  NFL: {
    sport: 'NFL',
    label: 'NFL',
    title: 'NFL Week Ahead',
    weekday: 'Tue',
    hour: 10,
    minute: 0,
    zone: ZONE,
    /* THIS ONE IS LOAD-BEARING. Tuesday at 10:00 Central is roughly thirteen
       hours after a Monday night kickoff, which is normally plenty — but a
       weather delay, a provider that has not published a box score, or a
       ratings build that has not absorbed the result yet all land inside the
       same morning. Four hours of retry is the difference between "send with
       yesterday's inputs" and "send with the week that just finished". */
    retry_window_minutes: 240,
  },
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/* ------------------------------------------------------------ zone maths */
/* What the wall clock reads in `zone` at instant `ms`. `exact` is false only
   when the runtime has no zone database at all, which is a stated
   approximation rather than a silent one — the same shape featured.js uses
   for Eastern. */
function zonedParts(ms, zone) {
  const d = new Date(ms);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone || ZONE, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    fmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
    let hour = +p.hour;
    if (hour === 24) hour = 0;                       /* some ICU builds emit 24 */
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour, minute: +p.minute, second: +p.second,
      weekday: p.weekday,
      date: p.year + '-' + p.month + '-' + p.day,
      exact: true,
    };
  } catch (_) {
    /* US Central without a zone database: −5 through the DST months, −6
       otherwise. Only ever an hour out, and it says so. */
    const m = d.getUTCMonth();
    const off = (m >= 2 && m <= 10) ? 5 : 6;
    const e = new Date(ms - off * 3600000);
    const pad = n => String(n).padStart(2, '0');
    return {
      year: e.getUTCFullYear(), month: e.getUTCMonth() + 1, day: e.getUTCDate(),
      hour: e.getUTCHours(), minute: e.getUTCMinutes(), second: e.getUTCSeconds(),
      weekday: DAYS[e.getUTCDay()],
      date: e.getUTCFullYear() + '-' + pad(e.getUTCMonth() + 1) + '-' + pad(e.getUTCDate()),
      exact: false,
    };
  }
}

/* The zone's offset from UTC at instant `ms`, in milliseconds. Positive west
   of Greenwich is NOT the convention here: this is (wall clock − UTC), so
   Chicago returns −18000000 in summer. */
function offsetAt(ms, zone) {
  const p = zonedParts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/* The instant at which the wall clock in `zone` reads the given date-time.
   Two passes — see the header. */
function instantOf(y, mo, d, hh, mm, zone) {
  const target = Date.UTC(y, mo - 1, d, hh || 0, mm || 0, 0);
  let ms = target - offsetAt(target, zone);
  ms = target - offsetAt(ms, zone);
  return ms;
}

/* Add whole DAYS to a wall-clock date. Deliberately calendar arithmetic and
   not `ms + 86400000`: across a DST boundary a day is 23 or 25 hours, and
   "the Monday before" must stay a Monday. */
function addDays(y, mo, d, n) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}
function isoDate(p) {
  const pad = n => String(n).padStart(2, '0');
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

/* ---------------------------------------------------------- the schedule */
function editionFor(sport) {
  const key = String(sport || '').toUpperCase();
  const e = EDITIONS[key];
  if (!e) throw new Error('no newsletter edition is defined for sport ' + JSON.stringify(sport));
  return e;
}
function sports() { return Object.keys(EDITIONS); }

/* The instant this sport's edition is scheduled for on a given local date. */
function scheduledAtFor(sport, localDate, overrides) {
  const e = Object.assign({}, editionFor(sport), overrides || {});
  const p = typeof localDate === 'string' ? parseIsoDate(localDate) : localDate;
  if (!p) throw new Error('scheduledAtFor needs a YYYY-MM-DD local date');
  return instantOf(p.year, p.month, p.day, e.hour, e.minute, e.zone);
}

/* Step back from `from` (a local date) to the most recent occurrence of the
   edition's weekday, inclusive. */
function weekdayOnOrBefore(fromDate, weekday, zone) {
  let p = { year: fromDate.year, month: fromDate.month, day: fromDate.day };
  for (let i = 0; i < 8; i++) {
    /* Midday avoids every DST edge when all we want is the day name. */
    const ms = instantOf(p.year, p.month, p.day, 12, 0, zone);
    if (zonedParts(ms, zone).weekday === weekday) return p;
    p = addDays(p.year, p.month, p.day, -1);
  }
  return null;
}

/* THE ANSWER THE PIPELINE ASKS FOR.

   Given a sport and an instant, which edition is current, was it due, is it
   still inside its retry window, and when is the next one?

   `edition_date` is the LOCAL date of the edition — the Monday or the Tuesday
   — and it is half of the edition's identity. Deriving it here rather than
   from a UTC date is what keeps a 10:00 Central send on 2026-11-03 from being
   filed under 2026-11-02 or 2026-11-04 depending on the season. */
function dueFor(sport, now, opts) {
  opts = opts || {};
  const e = Object.assign({}, editionFor(sport), opts.overrides || {});
  const nowMs = now == null ? Date.now() : (typeof now === 'number' ? now : Date.parse(now));
  if (!Number.isFinite(nowMs)) throw new Error('dueFor needs a resolvable `now`');
  const retry = num(opts.retry_window_minutes) != null
    ? num(opts.retry_window_minutes) : e.retry_window_minutes;

  const localNow = zonedParts(nowMs, e.zone);
  let day = weekdayOnOrBefore(localNow, e.weekday, e.zone);
  if (!day) throw new Error('could not locate ' + e.weekday + ' in ' + e.zone);

  let scheduledAt = scheduledAtFor(sport, day, opts.overrides);
  /* Today IS the edition weekday but it is still before 10:00: the current
     edition is last week's, not the one a few hours away. */
  if (scheduledAt > nowMs) {
    day = addDays(day.year, day.month, day.day, -7);
    scheduledAt = scheduledAtFor(sport, day, opts.overrides);
  }
  const deadlineAt = scheduledAt + retry * 60000;
  const nextDay = addDays(day.year, day.month, day.day, 7);
  const nextAt = scheduledAtFor(sport, nextDay, opts.overrides);

  const minutesLate = Math.round((nowMs - scheduledAt) / 60000);
  return {
    sport: e.sport,
    title: e.title,
    label: e.label,
    zone: e.zone,
    zone_exact: localNow.exact,
    weekday: e.weekday,
    local_time: String(e.hour).padStart(2, '0') + ':' + String(e.minute).padStart(2, '0'),
    edition_date: isoDate(day),
    scheduled_at: new Date(scheduledAt).toISOString(),
    deadline_at: new Date(deadlineAt).toISOString(),
    retry_window_minutes: retry,
    minutes_late: minutesLate,
    due: nowMs >= scheduledAt && nowMs <= deadlineAt,
    stale: nowMs > deadlineAt,
    next_edition_date: isoDate(nextDay),
    next_scheduled_at: new Date(nextAt).toISOString(),
    now: new Date(nowMs).toISOString(),
  };
}

/* Every sport's answer at once — what the operator console prints. */
function board(now, opts) {
  return sports().map(s => dueFor(s, now, opts));
}

/* A kickoff, rendered for a reader, in a named zone with its abbreviation.
   The abbreviation is read from the zone rather than hardcoded, so a November
   edition says CST and a September one says CDT without a branch here. */
function kickoffLabel(iso, zone) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const z = zone || ZONE;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: z, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    return fmt.format(new Date(ms)).replace(/,/g, '').replace(/\s+/g, ' ').trim();
  } catch (_) {
    const p = zonedParts(ms, z);
    return p.weekday + ' ' + p.month + '/' + p.day + ' '
      + String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0') + ' (US Central)';
  }
}

/* The zone abbreviation in force at an instant — CDT or CST — so the email
   can name the zone it is quoting rather than implying one. */
function zoneAbbrev(iso, zone) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone || ZONE, timeZoneName: 'short' })
      .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName');
    return part ? part.value : null;
  } catch (_) { return null; }
}

module.exports = {
  ZONE, EDITIONS, DAYS,
  zonedParts, offsetAt, instantOf, addDays, isoDate, parseIsoDate,
  editionFor, sports, scheduledAtFor, weekdayOnOrBefore,
  dueFor, board, kickoffLabel, zoneAbbrev,
};
