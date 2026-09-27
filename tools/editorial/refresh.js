#!/usr/bin/env node
/* ============================================================================
   THE LATE-WINDOW REFRESH — what has to be re-verified before an article
   forty-five minutes from kickoff is allowed to go public.

   WHY IT EXISTS. Publishing inside the late window without this would be
   publishing two-hour-old numbers under a fresh timestamp. The parts of a
   pregame article that actually rot near kickoff are few and identifiable:
   the market, the availability report, and whether the game is still
   happening at the time and place it was scheduled. Everything else — the
   ratings, the schedule strength, the season form — does not move between
   two o'clock and three.

   SO IT REFRESHES ONLY WHAT CAN MATERIALLY CHANGE:

     the market      spread, total, moneyline, and the book behind them
     availability    injuries, inactives, the starting quarterback
     the fixture     kickoff time, venue, postponement or cancellation

   and leaves the stable research alone. Regenerating everything would be
   slower, would churn the diff, and would risk moving numbers that had no
   business moving.

   WHAT IT MUST NOT DO — and this is the part that matters. The original
   research snapshot is the analytical commitment the postgame audit grades.
   It is content-addressed and immutable, and this never writes to it. A
   refresh produces a SECOND snapshot, roled `publication`, which records what
   was actually known when the article went live. Two artefacts, two
   questions: "what did EdgeDesk believe?" and "what was true when it
   published?" — and closing-line value needs both.

   A REFRESH THAT CANNOT VERIFY ANYTHING IS NOT A REFRESH. With no live
   research available the answer is `stale`, and the caller holds the article
   rather than publishing old numbers with a new date on them.
   ========================================================================== */
'use strict';

const SNAP = require('./snapshot.js');

function num(v) { if (v == null || v === '') return null; const n = +v; return isFinite(n) ? n : null; }
function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }

/* The fields a late-window refresh is allowed to consider changed. Anything
   outside this list is stable research and is carried through untouched. */
const VOLATILE = [
  'market.available', 'market.line', 'market.total', 'market.book',
  'availability', 'kickoff', 'venue', 'status',
];

/* ------------------------------------------------------------- comparison */
/* What actually moved between the committed research and the live research.
   Reported field by field so the run log can say "the line moved from -3 to
   -4" rather than "something changed". */
/* THE MARKET AS THE RESEARCH PAYLOAD ACTUALLY CARRIES IT.

   Not as I first assumed. research.market is not {spread, total}; it is the
   shape the terminal builds for a reader:

     market        "Minnesota Vikings -2.5"    the quoted line, as text
     total_market  "46.5"                      the quoted total
     model         "Minnesota Vikings -0.8"    EdgeDesk's own number
     book          "nflverse reference"        where the quote came from

   So the line is compared as TEXT — which is the honest comparison, because
   "Vikings -2.5" becoming "Packers -1" is a move the raw number alone would
   misreport — and a signed number is extracted alongside it purely so the run
   log can say "-2.5 → -4" rather than printing two sentences. */
function numberIn(v) {
  const m = /(-?\d+(?:\.\d+)?)/.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
}
function marketOf(research) {
  const m = (research && research.market) || {};
  return {
    available: m.available !== false,
    line: txt(m.market),
    line_number: numberIn(m.market),
    total: num(m.total_market),
    model_line: txt(m.model),
    book: txt(m.book || m.source),
  };
}

function diff(before, after) {
  const a = marketOf(before), b = marketOf(after);
  const changes = [];
  function moved(field, x, y) {
    if (x == null && y == null) return;
    if (x !== y) changes.push({ field, from: x, to: y });
  }
  moved('market.available', a.available, b.available);
  moved('market.line', a.line, b.line);
  moved('market.total', a.total, b.total);
  moved('market.book', a.book, b.book);
  return changes;
}

/* --------------------------------------------------------------- fixture */
/* Is the game still the game? A postponement, a cancellation or a kickoff that
   has moved all invalidate the window that was computed from the old time. */
function fixtureCheck(entry, live) {
  const out = { ok: true, postponed: false, kickoff_changed: false, reasons: [] };
  const status = txt(live && (live.status || live.game_status)) || '';
  if (/postpon|cancel|suspend/i.test(status)) {
    out.ok = false; out.postponed = true;
    out.reasons.push('the fixture is ' + status.toLowerCase() + ' — no pregame article is published for it');
    return out;
  }
  const wasKick = Date.parse(entry && entry.kickoff);
  const nowKick = Date.parse(live && (live.kickoff || live.game_time));
  if (isFinite(wasKick) && isFinite(nowKick) && Math.abs(nowKick - wasKick) >= 60000) {
    out.kickoff_changed = true;
    out.new_kickoff = new Date(nowKick).toISOString();
    out.reasons.push('kickoff moved from ' + new Date(wasKick).toISOString()
      + ' to ' + out.new_kickoff + ' — the window is recalculated from the new time');
  }
  const wasVenue = txt(entry && entry.venue), nowVenue = txt(live && live.venue);
  if (wasVenue && nowVenue && wasVenue !== nowVenue) {
    out.venue_changed = true;
    out.reasons.push('venue moved from ' + wasVenue + ' to ' + nowVenue);
  }
  return out;
}

/* ------------------------------------------------------------ the refresh */
/* `liveResearch` is the research payload as the terminal reports it NOW —
   the caller fetches it the same way the pregame phase does, so this module
   opens no socket and can be driven entirely from fixtures in a test.

   Returns:
     ok            the article may proceed to the publisher
     stale         nothing live could be read; do not publish old numbers
     blocked       the fixture itself says no (postponed, cancelled)
     changes       what moved, field by field
     snapshot      the PUBLICATION snapshot to store, when anything moved */
function refresh(opts) {
  opts = opts || {};
  const committed = opts.committed_research || (opts.snapshot && opts.snapshot.research) || null;
  const live = opts.live_research || null;
  const entry = opts.game || (opts.snapshot && opts.snapshot.game) || {};
  const now = opts.now ? new Date(opts.now).toISOString() : new Date().toISOString();

  if (!committed) {
    return { ok: false, state: 'stale', changes: [], reasons: ['there is no committed research to refresh against'] };
  }
  if (!live || !live.kind) {
    /* NOT AN ERROR, AND NOT A PASS. The provider could not be reached this
       run; the honest answer is to hold and try again, not to publish
       two-hour-old prices under a fresh timestamp. */
    return { ok: false, state: 'stale', changes: [],
      reasons: ['the research terminal returned no live payload, so the time-sensitive data could not be re-verified'] };
  }

  const fixture = fixtureCheck(entry, opts.live_game || live.game || {});
  if (!fixture.ok) {
    return { ok: false, state: 'blocked', changes: [], fixture, reasons: fixture.reasons };
  }

  const changes = diff(committed, live);

  /* THE PUBLICATION SNAPSHOT. Captured from the LIVE research, so it records
     what was actually true at publication — and roled so that nothing
     downstream mistakes it for the original commitment. */
  const game = Object.assign({}, entry);
  if (fixture.kickoff_changed && fixture.new_kickoff) game.kickoff = fixture.new_kickoff;
  let snapshot = null;
  try {
    snapshot = SNAP.capture(live, game, {
      now, article_id: opts.article_id,
      generation_version: opts.generation_version || 'editorial_late_window',
      market_source: opts.market_source,
      sources: opts.sources,
    });
    snapshot.role = 'publication';
    snapshot.refreshed_from = (opts.snapshot && opts.snapshot.snapshot_id) || null;
    snapshot.refresh_changes = changes;
  } catch (e) {
    return { ok: false, state: 'stale', changes,
      reasons: ['the refreshed research could not be captured: ' + (e && e.message)] };
  }

  return {
    ok: true, state: changes.length ? 'refreshed' : 'unchanged',
    changes, fixture, snapshot, live_research: live,
    reasons: changes.length
      ? changes.map(c => c.field + ' ' + c.from + ' → ' + c.to)
      : ['the time-sensitive data was re-verified and had not moved'],
  };
}

module.exports = { VOLATILE, marketOf, diff, fixtureCheck, refresh };
