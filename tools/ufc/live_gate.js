#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk UFC — the live gate.

   A GitHub schedule cannot poll every twenty seconds, and it should not try:
   the scheduled run's only job is to answer "is a card inside its live window
   right now?" from the events the sync job keeps on file, and hand the
   event id to the long-running poller job when the answer is yes. It reads
   the database; it does not need the source. A manual dispatch can name an
   event directly, which is the recovery path when the gate's own reading is
   wrong or a card was rebooked minutes before the bell.

   The window: from 45 minutes before the scheduled start (early prelims are
   routinely earlier than the card's headline time) to nine hours after it,
   and only for an event that is scheduled or live — never one already final
   or stale.

     node tools/ufc/live_gate.js                 # prints the decision
     node tools/ufc/live_gate.js --event espn:600052001
   Writes event_id and found to $GITHUB_OUTPUT when that file is set.
   =========================================================================== */
'use strict';

const fs = require('fs');
const D = require('./db.js');

const BEFORE_MS = 45 * 60 * 1000;
const AFTER_MS = 9 * 3600 * 1000;

function parseArgs(argv) {
  const o = { event: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--event') o.event = next();
    else if (a === '--now') o.now = next();
  }
  return o;
}

/* Pure: which event, if any, is in its live window. */
function pick(events, nowMs) {
  const inWindow = (events || []).filter(e => {
    if (!['scheduled', 'live'].includes(e.event_state)) return false;
    const t = Date.parse(e.scheduled_at);
    if (!isFinite(t)) return false;
    return nowMs >= t - BEFORE_MS && nowMs <= t + AFTER_MS;
  }).sort((a, b) => {
    /* a card already live beats one about to start; then the nearest start */
    if (a.event_state !== b.event_state) return a.event_state === 'live' ? -1 : 1;
    return Math.abs(Date.parse(a.scheduled_at) - nowMs) - Math.abs(Date.parse(b.scheduled_at) - nowMs);
  });
  return inWindow[0] || null;
}

function output(kv) {
  const f = process.env.GITHUB_OUTPUT;
  const lines = Object.keys(kv).map(k => `${k}=${kv[k]}`);
  lines.forEach(l => console.log('[ufc-gate] ' + l));
  if (f) fs.appendFileSync(f, lines.join('\n') + '\n');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const nowMs = o.now ? Date.parse(o.now) : Date.now();
  const cfg = D.config();
  if (!cfg) { console.error('No service credential (EDGD_SB_SERVICE + EDGD_SB_URL).'); output({ found: 'false', event_id: '' }); process.exit(1); }
  const db = D.client(cfg);
  let chosen = null, reason = '';
  if (o.event) {
    const rows = await db.select('ufc', 'events', `select=event_id,name,scheduled_at,event_state&event_id=eq.${encodeURIComponent(o.event)}`);
    chosen = rows[0] || null;
    reason = chosen ? 'named by dispatch' : `event ${o.event} is not on file — run the sync first`;
    if (chosen && ['final', 'cancelled'].includes(chosen.event_state)) { reason = `event ${o.event} is ${chosen.event_state}`; chosen = null; }
  } else {
    const from = new Date(nowMs - AFTER_MS - 3600000).toISOString(), to = new Date(nowMs + BEFORE_MS + 3600000).toISOString();
    const rows = await db.select('ufc', 'events', `select=event_id,name,scheduled_at,event_state&scheduled_at=gte.${from}&scheduled_at=lte.${to}&order=scheduled_at.asc&limit=20`);
    chosen = pick(rows, nowMs);
    reason = chosen ? `in window (${chosen.event_state})` : `no scheduled or live card within -45m/+9h of ${new Date(nowMs).toISOString()}`;
  }
  const ledger = D.runLedger(db, 'ufc_gate', { eventId: chosen ? chosen.event_id : null });
  await ledger.start({ decision: chosen ? 'poll' : 'idle', reason });
  await ledger.finish('ok', chosen ? `poll ${chosen.event_id} — ${reason}` : reason, { last_success_at: new Date().toISOString() });
  output({ found: chosen ? 'true' : 'false', event_id: chosen ? chosen.event_id : '', event_name: chosen ? String(chosen.name || '').replace(/\n/g, ' ') : '' });
  console.log('[ufc-gate] ' + reason);
}

module.exports = { pick, parseArgs, BEFORE_MS, AFTER_MS };
if (require.main === module) main().catch(e => { console.error('[ufc-gate] failed: ' + (e && e.stack || e)); output({ found: 'false', event_id: '' }); process.exit(1); });
