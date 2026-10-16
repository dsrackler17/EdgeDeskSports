#!/usr/bin/env node
'use strict';
/* ===========================================================================
   MIRROR THE PERFORMANCE LEDGER TO SUPABASE (optional hardening).

     node tools/performance/sync.js            send every ledger row the database lacks
     node tools/performance/sync.js --dry      say what would be sent, send nothing

   The committed ledger (performance/ledger/*.jsonl) is the source of truth;
   this copies it, insert-only, through perf_ingest() (supabase/
   model_performance.sql), which stamps each row with the server's own clock,
   refuses a row that does not follow the stored chain, refuses any UPDATE,
   DELETE or TRUNCATE, and logs every call. It asks perf_heads() where each
   file stands and sends only what is beyond it, oldest first, so a run sends
   nothing twice and a re-run after a failure picks up where it stopped.

   Credentials: SB_URL / SB_SERVICE_ROLE as EDGD_SB_URL / EDGD_SB_SERVICE
   (tools/lib/pgrest.js). Without them it says so and exits 0: the page reads
   the committed files. With them but no schema, it exits 3 and names the file
   to apply; on a refused row, exit 4.
   =========================================================================== */
const path = require('path');
const fs = require('fs');
const L = require('./ledger.js');
const REST = require('../lib/pgrest.js');

const ROOT = path.join(__dirname, '..', '..');
const BATCH = 200;

function shout(level, title, msg) {
  console.log('::' + level + ' title=' + title + '::' + msg);
  if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '- **' + title + '**: ' + msg + '\n'); } catch (_) { /* best effort */ } }
}

/** The rows to send for one stream, given where the database stands (heads: { 'stream|file': maxSeq }). */
function pending(root, stream, heads) {
  const out = [];
  L.listFiles(root, stream).forEach((f) => {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const have = heads[stream + '|' + rel] || 0;
    L.readRows(f).forEach((r) => {
      if (r.__bad || r.seq <= have) return;
      out.push({ hash: r.hash, ledger_file: rel, seq: r.seq, prev: r.prev, event_key: r.event_key, sport: r.sport, start_utc: r.start_utc || null, row: r });
    });
  });
  return out;
}

async function sync(o) {
  o = o || {};
  const root = o.root || ROOT;
  const cfg = o.cfg !== undefined ? o.cfg : REST.config();
  if (!cfg) { console.log('[performance sync] SB_URL / SB_SERVICE_ROLE are not set: nothing sent (the page reads the committed ledger)'); return { code: 0, sent: 0, skipped: 'no credentials' }; }
  const db = REST.client(cfg, o.fetchImpl, { retries: 2 });
  let heads;
  try { heads = await db.rpc('public', 'perf_heads', {}); }
  catch (e) {
    if (REST.refused(e) && (e.status === 404 || /PGRST202|42883|42P01/.test(String(e.code) + String(e.message)))) {
      shout('error', 'performance mirror not applied', 'perf_heads() is missing: apply supabase/model_performance.sql (docs/model-performance/RUNBOOK.md) — the committed ledger is unaffected');
      return { code: 3, sent: 0 };
    }
    throw e;
  }
  const report = { code: 0, sent: 0, inserted: 0, already: 0, streams: {} };
  for (const stream of L.STREAMS) {
    const rows = pending(root, stream, heads || {});
    report.streams[stream] = { pending: rows.length, inserted: 0 };
    if (o.dry) continue;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      try {
        const r = await db.rpc('public', 'perf_ingest', { p_kind: stream, p_rows: batch, p_run: o.run || null, p_git_sha: o.git_sha || null });
        report.sent += batch.length; report.inserted += r.inserted || 0; report.already += r.already_present || 0;
        report.streams[stream].inserted += r.inserted || 0;
      } catch (e) {
        if (REST.refused(e)) { shout('error', 'performance mirror refused a row', String(e.message).slice(0, 400)); report.code = 4; return report; }
        throw e;
      }
    }
  }
  console.log('[performance sync] ' + JSON.stringify(report));
  return report;
}

module.exports = { sync, pending };
if (require.main === module) {
  sync({ dry: process.argv.includes('--dry'), run: process.env.GITHUB_RUN_ID ? 'gh:' + process.env.GITHUB_RUN_ID : null, git_sha: process.env.GITHUB_SHA || null })
    .then((r) => process.exit(r.code || 0))
    .catch((e) => { shout('error', 'performance mirror failed', String(e && e.message || e).slice(0, 400)); process.exit(2); });
}
