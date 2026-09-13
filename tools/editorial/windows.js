#!/usr/bin/env node
/* ============================================================================
   THE PUBLICATION WINDOW — how close to kickoff an article may still go out.

   WHAT THIS REPLACES. A single line in the pregame phase:

       if (leadH * 60 < (cfg.pregame_min_lead_minutes || 90)) { ...refuse... }

   Ninety minutes was a cliff. An article that was complete, factually clean
   and scored 100 was refused at 89 minutes exactly as it would have been at
   one minute, and the refusal was recorded as a FAILURE. That is wrong twice
   over: the article was not defective, and forty-five minutes before kickoff
   is a perfectly ordinary time to read pregame research.

   THE REPLACEMENT IS THREE WINDOWS, not one floor.

     normal        more than `pregame_normal_lead_minutes` (90) to kickoff.
                   Publish on the existing rules; nothing else changes.

     late_window   between the minimum (20) and the normal lead. Still
                   legitimate pregame research, and still publishable — but
                   only AFTER the time-sensitive data is refreshed and
                   revalidated, because a line captured two hours ago is the
                   part that goes stale this close in. Recorded internally as
                   late_window. Nothing on the page apologises for the hour:
                   the reader is getting fresher numbers, not worse ones.

     final_window  inside the minimum lead. Not published automatically. This
                   is NOT an error — it is a held article with a stated
                   reason, and an operator may still force it.

     after_kickoff a new pregame article is never published once the game has
                   started. Not late — impossible. A preview published after
                   its own game is not research, and back-dating published_at
                   to pretend otherwise would corrupt the one record the
                   postgame audit exists to grade.

   THE GAME IS STILL OWED AN AUDIT EITHER WAY. A pregame article that never
   went public keeps its research snapshot, so the postgame half can still
   audit what EdgeDesk actually believed beforehand. Publication and
   commitment are different things and only one of them is optional.
   ========================================================================== */
'use strict';

const WINDOW = {
  NOT_DUE: 'not_due',
  NORMAL: 'normal',
  LATE: 'late_window',
  FINAL: 'final_window',
  AFTER_KICKOFF: 'after_kickoff',
  /* not a window a clock produces — an operator overrode the final window */
  FORCED: 'forced',
};

/* The windows a pregame article may be published in without a person. */
const AUTO_PUBLISHABLE = [WINDOW.NORMAL, WINDOW.LATE];

const DEFAULTS = {
  pregame_normal_lead_minutes: 90,
  pregame_minimum_publish_lead_minutes: 20,
};

function num(v) { if (v == null || v === '') return null; const n = +v; return isFinite(n) ? n : null; }

/* ------------------------------------------------------------ the settings */
/* ONE CANONICAL SOURCE. Every caller — the pregame phase, the dispatcher, the
   backfill, the health panel and the admin page — resolves the policy through
   here, so there is no second copy of "90" anywhere to drift.

   The old `pregame_min_lead_minutes` is still honoured as the minimum when the
   new key is absent, so a store written before this change keeps behaving the
   way its operator configured it rather than silently adopting a new number. */
function policy(cfg) {
  cfg = cfg || {};
  const normal = num(cfg.pregame_normal_lead_minutes);
  const minimum = num(cfg.pregame_minimum_publish_lead_minutes);
  const legacy = num(cfg.pregame_min_lead_minutes);
  /* A KEY THAT IS PRESENT BUT UNREADABLE IS NOT AN ABSENT KEY. Falling back
     to the default on `"soon"` would silently run a policy the operator did
     not write and did not ask for — the same class of bug as a control that
     saves nowhere. Absent is fine and takes the default; garbage is an error. */
  const unreadable = [];
  [['pregame_normal_lead_minutes', normal], ['pregame_minimum_publish_lead_minutes', minimum],
   ['pregame_min_lead_minutes', legacy]].forEach(([k, parsed]) => {
    const raw = cfg[k];
    if (raw !== undefined && raw !== null && raw !== '' && parsed == null) unreadable.push(k);
  });
  return {
    normal_lead_minutes: normal != null ? normal : DEFAULTS.pregame_normal_lead_minutes,
    minimum_lead_minutes: minimum != null ? minimum
      : (legacy != null ? legacy : DEFAULTS.pregame_minimum_publish_lead_minutes),
    /* recorded so the health panel can say which key it actually read */
    from_legacy_key: minimum == null && legacy != null,
    unreadable,
  };
}

/* BAD CONFIGURATION FAILS SAFELY AND LOUDLY. A minimum above the normal lead
   would make the late window negative — every article would fall through to
   "final window" and nothing would ever publish automatically, which is a
   silent outage. It is refused here and surfaced to the operator instead. */
function validate(cfg) {
  const p = policy(cfg);
  const errors = [];
  if (!(p.minimum_lead_minutes >= 0)) {
    errors.push({ id: 'minimum_lead_negative',
      why: 'the minimum publish lead must be zero or more minutes',
      detail: String(p.minimum_lead_minutes) });
  }
  if (!(p.normal_lead_minutes > p.minimum_lead_minutes)) {
    errors.push({ id: 'normal_not_above_minimum',
      why: 'the normal lead must be greater than the minimum publish lead, or there is no late window and nothing can publish automatically',
      detail: 'normal ' + p.normal_lead_minutes + ' vs minimum ' + p.minimum_lead_minutes });
  }
  if ((p.unreadable || []).length) {
    errors.push({ id: 'not_a_number',
      why: 'a configured lead time is not a number, so the policy it names cannot be applied',
      detail: p.unreadable.join(', ') });
  }
  return { ok: !errors.length, errors, policy: p };
}

/* --------------------------------------------------------- classification */
/* Which window a game is in right now.

   `due_at_minutes` is the per-window lead the selection engine already
   applies (a Sunday early game opens sixteen hours out, Monday night seven);
   a game further out than that is NOT_DUE, which means "not yet", not "late". */
function classify(opts) {
  opts = opts || {};
  const v = validate(opts.settings);
  const p = v.policy;
  const kick = opts.kickoff_ms != null ? Number(opts.kickoff_ms) : Date.parse(opts.kickoff);
  const now = opts.now_ms != null ? Number(opts.now_ms) : Date.parse(opts.now || new Date().toISOString());

  if (!isFinite(kick)) {
    return { window: null, ok: false, minutes_before_kickoff: null,
      reason: 'no usable kickoff time', config_ok: v.ok, config_errors: v.errors, policy: p };
  }
  const minutes = (kick - now) / 60000;
  const base = {
    minutes_before_kickoff: Math.round(minutes),
    scheduled_kickoff: isFinite(kick) ? new Date(kick).toISOString() : null,
    config_ok: v.ok, config_errors: v.errors, policy: p,
  };

  /* A BROKEN POLICY PUBLISHES NOTHING. Refusing every article is the safe
     direction: the alternative is publishing under a rule nobody wrote. */
  if (!v.ok) {
    return Object.assign({ window: null, ok: false,
      reason: 'the publication-window configuration is invalid: '
        + v.errors.map(e => e.id).join(', ') }, base);
  }

  if (minutes <= 0) {
    return Object.assign({ window: WINDOW.AFTER_KICKOFF, ok: false,
      reason: 'the game has already started — a pregame article is never published after kickoff' }, base);
  }
  if (minutes < p.minimum_lead_minutes) {
    return Object.assign({ window: WINDOW.FINAL, ok: false,
      reason: 'inside final pregame publication floor ('
        + Math.round(minutes) + ' minutes to kickoff, the floor is '
        + p.minimum_lead_minutes + ')' }, base);
  }
  const due = num(opts.due_at_minutes);
  if (due != null && minutes > due) {
    return Object.assign({ window: WINDOW.NOT_DUE, ok: false,
      reason: 'not due yet: ' + (minutes / 60).toFixed(1) + 'h out, this window publishes at '
        + (due / 60).toFixed(0) + 'h' }, base);
  }
  if (minutes < p.normal_lead_minutes) {
    return Object.assign({ window: WINDOW.LATE, ok: true, needs_refresh: true,
      reason: 'late window: ' + Math.round(minutes)
        + ' minutes to kickoff — publishable once the time-sensitive data is refreshed' }, base);
  }
  return Object.assign({ window: WINDOW.NORMAL, ok: true, needs_refresh: false,
    reason: 'normal window: ' + Math.round(minutes) + ' minutes to kickoff' }, base);
}

/* May an operator force this one? The final window is a policy hold, so yes.
   After kickoff is a statement about reality, so no — there is no such thing
   as pregame research published after the game began. */
function forcible(window) { return window === WINDOW.FINAL || window === WINDOW.NOT_DUE; }

/* The timing block stored on a published record, for the analytics that come
   later (does research published closer to kickoff carry better information?). */
function timingFor(cls, opts) {
  opts = opts || {};
  const forced = !!opts.forced;
  return {
    publication_window: forced ? WINDOW.FORCED : (cls && cls.window) || null,
    classified_window: (cls && cls.window) || null,
    scheduled_kickoff: (cls && cls.scheduled_kickoff) || null,
    minutes_before_kickoff: cls ? cls.minutes_before_kickoff : null,
    published_at: opts.published_at || null,
    refreshed: !!opts.refreshed,
    at: opts.now || null,
  };
}

/* WHEN A GAME'S WINDOW OPENS, in minutes before kickoff. Each broadcast window
   has its own lead — a Sunday early game opens sixteen hours out, Monday night
   seven — configurable per sport in featured.json without touching code.

   It lives here rather than in run.js because the health panel needs the same
   answer to say "publish at 14:30", and two copies of a scheduling rule is how
   a panel starts disagreeing with the pipeline it is describing. */
function leadMinutesFor(cfg, game) {
  const byWindow = ((cfg || {}).pregame_lead_hours || {})[game && game.sport] || {};
  const hours = byWindow[game && game.window_key] != null ? byWindow[game.window_key]
    : (byWindow.default != null ? byWindow.default : 12);
  return hours * 60;
}

module.exports = { WINDOW, AUTO_PUBLISHABLE, DEFAULTS, policy, validate, classify,
  forcible, timingFor, leadMinutesFor };
