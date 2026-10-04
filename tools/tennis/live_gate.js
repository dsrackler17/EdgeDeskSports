#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the live gate.

   A GitHub schedule cannot poll every twenty seconds, and it should not try.
   The scheduled run's only job is to answer "is any tour on court right
   now?" from the draw the sync job keeps on file, and hand the tour-days
   that are to the long-running poller. It reads the database; it does not
   need the source.

   WHY A TOUR-DAY AND NOT A TOURNAMENT. The provider's tennis scoreboard is
   one document per tour per day carrying every tournament's live matches at
   once. One poller therefore covers a whole tour-day, and the lock is keyed
   the same way ('atp:2026-05-28') so two runners can never both drive it.

   THE WINDOW is deliberately wide in one direction. A tennis order of play
   is "not before 11:00, third match on Court 3": a match scheduled nine
   hours ago can still be waiting to start. So a tour-day is polled from 90
   minutes before its earliest scheduled match until 14 hours after the
   latest one — and any match already live opens the window regardless.

     node tools/tennis/live_gate.js                     # prints the decision
     node tools/tennis/live_gate.js --tour atp          # force one tour, today
     node tools/tennis/live_gate.js --tour wta --day 2026-05-28
   Writes found / matrix / summary to $GITHUB_OUTPUT when that file is set.
   =========================================================================== */
'use strict';

const fs = require('fs');
const D = require('./db.js');
const E = require('./espn.js');

const AHEAD_MS = 90 * 60 * 1000;        /* start polling this long before the first match */
const LATE_MS = 14 * 3600 * 1000;       /* keep polling this long after the last one is due */
const MAX_TOUR_DAYS = 4;                /* a runner each; more than this is a broken draw, not a busy day */

function parseArgs(argv) {
  const o = { tour: null, day: null, now: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--tour') o.tour = String(next()).toLowerCase();
    else if (a === '--day') o.day = next();
    else if (a === '--now') o.now = next();
    else if (a === '--json') o.json = true;
  }
  return o;
}

function dayOf(iso, fallbackMs) {
  const t = iso ? Date.parse(iso) : NaN;
  return new Date(isFinite(t) ? t : fallbackMs).toISOString().slice(0, 10);
}
function lockKey(tour, day) { return String(tour).toLowerCase() + ':' + day; }

/* Pure: the matches on file -> the tour-days worth a runner right now.
   A tour-day qualifies when something on it is live, or when now sits inside
   [earliest scheduled - 90m, latest scheduled + 14h]. Ordered so a tour-day
   with live matches is always first. */
function pick(matches, nowMs) {
  const groups = {};
  (matches || []).forEach(m => {
    if (!['scheduled', 'live'].includes(m.status)) return;
    /* the tour that OWNS the row, not the label on it: a mixed-doubles match
       carries tour MIXED and is driven by exactly one poller */
    const tour = String(E.ownerTour(m.tour) || '').toLowerCase();
    if (!tour) return;
    const day = dayOf(m.scheduled_at, nowMs);
    const k = lockKey(tour, day);
    const g = groups[k] || (groups[k] = { tour, day, lock_key: k, matches: 0, live: 0, first: null, last: null, tournaments: {} });
    g.matches++;
    if (m.status === 'live') g.live++;
    if (m.tournament_id) g.tournaments[m.tournament_id] = true;
    const t = Date.parse(m.scheduled_at);
    if (isFinite(t)) {
      if (g.first == null || t < g.first) g.first = t;
      if (g.last == null || t > g.last) g.last = t;
    }
  });
  const out = [];
  Object.keys(groups).forEach(k => {
    const g = groups[k];
    g.tournaments = Object.keys(g.tournaments).length;
    const open = g.first != null ? g.first - AHEAD_MS : Date.parse(g.day + 'T00:00:00Z') - AHEAD_MS;
    const close = (g.last != null ? g.last : Date.parse(g.day + 'T23:59:00Z')) + LATE_MS;
    g.opens_at = new Date(open).toISOString();
    g.closes_at = new Date(close).toISOString();
    if (g.live > 0) { g.reason = `${g.live} match(es) live`; out.push(g); return; }
    if (nowMs >= open && nowMs <= close) { g.reason = `${g.matches} scheduled, window ${g.opens_at} → ${g.closes_at}`; out.push(g); }
  });
  out.sort((a, b) => {
    if ((b.live > 0) !== (a.live > 0)) return b.live - a.live;
    if (b.live !== a.live) return b.live - a.live;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return a.tour < b.tour ? -1 : 1;
  });
  return out.slice(0, MAX_TOUR_DAYS);
}

function output(kv) {
  const f = process.env.GITHUB_OUTPUT;
  const lines = Object.keys(kv).map(k => `${k}=${kv[k]}`);
  lines.forEach(l => console.log('[tennis-gate] ' + l.slice(0, 400)));
  if (f) fs.appendFileSync(f, lines.join('\n') + '\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const nowMs = o.now ? Date.parse(o.now) : Date.now();
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); output({ found: 'false', matrix: '{"include":[]}' }); process.exit(1); }
  const db = D.client(cfg);

  let chosen = [], reason = '';
  if (o.tour) {
    const day = o.day || new Date(nowMs).toISOString().slice(0, 10);
    chosen = [{ tour: o.tour, day, lock_key: lockKey(o.tour, day), matches: null, live: null, reason: 'named by dispatch' }];
    reason = `dispatch named ${chosen[0].lock_key}`;
  } else {
    const from = new Date(nowMs - LATE_MS - 86400000).toISOString(), to = new Date(nowMs + AHEAD_MS + 2 * 86400000).toISOString();
    const rows = await db.selectAll('tennis', 'live_matches',
      `select=match_id,tournament_id,tour,status,scheduled_at&status=in.(scheduled,live)&scheduled_at=gte.${from}&scheduled_at=lte.${to}&order=scheduled_at.asc`);
    chosen = pick(rows, nowMs);
    reason = chosen.length
      ? chosen.map(g => `${g.lock_key} (${g.reason})`).join('; ')
      : `no tour-day on court or inside its window at ${new Date(nowMs).toISOString()} — ${rows.length} scheduled/live match(es) read`;
  }

  const ledger = D.runLedger(db, 'tennis_gate', { scope: chosen.length ? chosen.map(c => c.lock_key).join(',') : null });
  await ledger.start({ decision: chosen.length ? 'poll' : 'idle', reason, tour_days: chosen });
  await ledger.finish('ok', reason.slice(0, 400), { last_success_at: new Date().toISOString(), details: { tour_days: chosen } });

  output({ found: chosen.length ? 'true' : 'false',
    matrix: JSON.stringify({ include: chosen.map(c => ({ tour: c.tour, day: c.day, lock_key: c.lock_key })) }),
    summary: chosen.length ? chosen.map(c => c.lock_key).join(' ') : 'idle' });
  console.log('[tennis-gate] ' + reason);
  if (o.json) console.log(JSON.stringify(chosen, null, 2));
}

module.exports = { pick, parseArgs, lockKey, dayOf, AHEAD_MS, LATE_MS, MAX_TOUR_DAYS };
if (require.main === module) main().catch(e => {
  D.reportFailure('tennis-gate', e);
  console.error('[tennis-gate] failed: ' + (e && e.stack || e));
  output({ found: 'false', matrix: '{"include":[]}' });
  process.exit(1);
});
