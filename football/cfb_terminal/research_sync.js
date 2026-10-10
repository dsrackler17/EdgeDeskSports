/* ============================================================================
   Research snapshots — mirror the append-only research ledger into Postgres
   (supabase/research_snapshots.sql), insert-only.

     football/cfb_terminal/history/<season>/research_snapshots.jsonl → research_snapshots

   The table refuses UPDATE / DELETE / TRUNCATE for every role and a snapshot
   observed at or after kickoff. Rows go through research_snapshots_ingest()
   (idempotent on the content-hash id) via the one CFB write path
   (football/cfb_production/db.js). Without SB_URL / SB_SERVICE_ROLE, or before
   the SQL file is applied, it logs and exits 0: the committed ledger is the
   source of truth either way.

     node football/cfb_terminal/research_sync.js [--season 2026] [--dry-run]
   ========================================================================== */
'use strict';
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const RES = require('./resilience.js');
const DB = (() => { try { return require(path.join(REPO, 'football', 'cfb_production', 'db.js')); } catch (e) { return null; } })();

function plan(season) {
  const rows = [];
  RES.loadSnapshots(season).forEach((list) => list.forEach((r) => rows.push(r)));
  rows.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  return rows;
}
async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const rows = plan(season);
  if (!url || !key || opts.dryRun || !DB) {
    if (!opts.quiet) console.log('[research snapshots sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + rows.length + ' rows');
    return { skipped: true, rows: rows.length };
  }
  const out = { received: 0, inserted: 0, already_present: 0 };
  for (let i = 0; i < rows.length; i += 500) {
    try {
      const r = await DB.rpc(url, key, 'research_snapshots_ingest', { p_rows: rows.slice(i, i + 500) }, { fetch: opts.fetch });
      out.received += r.received || 0; out.inserted += r.inserted || 0; out.already_present += r.already_present || 0;
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 200);
      if (/PGRST202|42883|Could not find|does not exist/i.test(msg)) {
        if (!opts.quiet) console.log('[research snapshots sync] skipped: apply supabase/research_snapshots.sql (' + msg + ')');
        return { skipped: true, reason: msg, apply: 'supabase/research_snapshots.sql' };
      }
      throw e;
    }
  }
  return out;
}

module.exports = { sync, plan };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = new Date();
  const season = Number(arg('--season', now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()));
  sync(season, { dryRun: a.includes('--dry-run') }).then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
