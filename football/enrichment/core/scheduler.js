/* ============================================================================
   THE FRESHNESS SCHEDULER — how often each kind of data deserves a call.

   Starter certainty and availability change fastest approaching kickoff; a
   game three weeks out does not need its forecast, its injury report or its
   quote re-read every hour. Every (kind, game) pair is placed in a window by
   hours to kickoff, and each kind has its own cadence per window
   (config.js WINDOWS / CADENCE):

     > 72h      NORMAL      normal refresh
     24-72h     ELEVATED    raised priority
     6-24h      HIGH        high priority
     < 6h       VERY_HIGH   very high priority
     < 90 min   FINAL       the final starter/inactive confirmation pass
     kicked off FROZEN      nothing is refreshed: the pregame ledger is kept
                            exactly as it was published

   `due()` answers one pair; `plan()` orders a run's work by priority so a
   bounded run spends its budget on the games about to kick off.
   ========================================================================== */
'use strict';

const C = require('../config.js');
const { ms, iso } = require('./lineage.js');

function hoursToKick(kickoff, now) {
  const k = ms(kickoff), n = ms(now);
  return (k == null || n == null) ? null : (k - n) / 3600e3;
}

function windowFor(h) {
  if (h == null) return C.WINDOWS[C.WINDOWS.length - 1];
  if (h <= 0) return C.WINDOWS[0];
  for (let i = 1; i < C.WINDOWS.length; i++) if (h <= C.WINDOWS[i].max) return C.WINDOWS[i];
  return C.WINDOWS[C.WINDOWS.length - 1];
}

/* o: {now, kickoff, last_retrieved_at} -> {due, window, priority, cadence_minutes, next_due_at, reason} */
function due(kind, o) {
  const cad = C.CADENCE[kind];
  const h = hoursToKick(o.kickoff, o.now);
  const w = windowFor(h);
  if (!cad) return { due: true, window: w.key, priority: w.priority, cadence_minutes: null, next_due_at: null, reason: 'no cadence registered for ' + kind + ' — always refreshed' };
  if (w.key === 'FROZEN') return { due: false, window: w.key, priority: 0, cadence_minutes: null, next_due_at: null,
    reason: 'kicked off — the pregame evidence is frozen and never re-read into a published prediction' };
  if (h != null && h > cad.horizon_days * 24) return { due: false, window: w.key, priority: w.priority, cadence_minutes: null,
    next_due_at: iso(ms(o.kickoff) - cad.horizon_days * 86400e3),
    reason: 'kickoff is ' + Math.round(h / 24) + ' days out, beyond the ' + cad.horizon_days + '-day horizon where ' + kind + ' is worth a call' };
  const every = cad[w.key];
  if (every == null) return { due: false, window: w.key, priority: w.priority, cadence_minutes: null, next_due_at: null,
    reason: kind + ' is not read in the ' + w.key + ' window' };
  const last = ms(o.last_retrieved_at);
  if (last == null) return { due: true, window: w.key, priority: w.priority, cadence_minutes: every, next_due_at: iso(o.now),
    reason: 'never read' };
  const next = last + every * 60e3;
  const isDue = ms(o.now) >= next;
  return { due: isDue, window: w.key, priority: w.priority, cadence_minutes: every, next_due_at: iso(next),
    reason: isDue ? 'last read ' + Math.round((ms(o.now) - last) / 60e3) + ' min ago; the ' + w.key + ' cadence is every ' + every + ' min'
      : 'read ' + Math.round((ms(o.now) - last) / 60e3) + ' min ago; next due in ' + Math.round((next - ms(o.now)) / 60e3) + ' min' };
}

/* plan(tasks) tasks: [{kind, key, kickoff, last_retrieved_at}] -> sorted with verdicts */
function plan(tasks, now) {
  return tasks.map((t) => Object.assign({}, t, { verdict: due(t.kind, { now, kickoff: t.kickoff, last_retrieved_at: t.last_retrieved_at }) }))
    .sort((a, b) => (b.verdict.priority - a.verdict.priority) || String(a.kickoff).localeCompare(String(b.kickoff)));
}

/* the published schedule: every kind's cadence per window, for the docs and
   the health page */
function describe() {
  return Object.keys(C.CADENCE).map((k) => {
    const c = C.CADENCE[k];
    return { kind: k, horizon_days: c.horizon_days,
      minutes: C.WINDOWS.filter((w) => w.key !== 'FROZEN').reduce((o, w) => { o[w.key] = c[w.key]; return o; }, {}) };
  });
}

module.exports = { hoursToKick, windowFor, due, plan, describe };
