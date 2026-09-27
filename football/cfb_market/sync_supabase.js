#!/usr/bin/env node
/* ============================================================================
   Market intelligence — the insert-only mirror of football/cfb_market/ledger/<season>/
   into supabase/cfb_market.sql's tables (docs/cfb-market/DELIVERABLE.md §39).

     snapshots.jsonl    -> cfb_market_consensus_snapshots (snapshot_id)
     events.jsonl       -> cfb_market_events              (event_id)
     conflicts.jsonl    -> cfb_market_provider_conflicts  (conflict_id)
     predictions.jsonl  -> cfb_market_predictions         (prediction_id)

   Every write goes through football/cfb_production/db.js (chunked, classified
   bounded retry, incidents), `on_conflict=<id>` + ignore-duplicates: a row
   already there is skipped, never updated, so a re-run is a no-op. Only the
   columns the table declares are sent (read from the migration itself).

   FAIL SOFT: supabase/cfb_market.sql is applied by a person. Until it is,
   PostgREST answers "no such table" (404 / PGRST205 / 42P01): the mirror warns
   and exits 0; the repository ledger is complete on its own and the next run
   sends everything. Any other error fails the step. Without SB_URL /
   SB_SERVICE_ROLE it logs and exits 0.

     node football/cfb_market/sync_supabase.js [--season 2026] [--dry-run]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const DB = require(path.join(REPO, 'football', 'cfb_production', 'db.js'));
const LOG = require(path.join(REPO, 'football', 'cfb_production', 'log.js'));
const LABSYNC = require(path.join(REPO, 'football', 'cfb_lab', 'sync_supabase.js'));
const RUN = require('./run.js');

function readJsonl(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

let COLS = null;
function columns() {
  if (COLS) return COLS;
  const sql = fs.readFileSync(path.join(REPO, 'supabase', 'cfb_market.sql'), 'utf8');
  COLS = {};
  const re = /create table if not exists public\.(cfb_[a-z0-9_]+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    COLS[m[1]] = m[2].split('\n').map((l) => /^\s+([a-z_][a-z0-9_]*)\s+(text|int|integer|smallint|bigint|numeric|boolean|timestamptz|jsonb|date|double|real)\b/.exec(l))
      .filter(Boolean).map((x) => x[1]).filter((c) => c !== 'constraint' && c !== 'recorded_at');
  }
  return COLS;
}
function shape(table, row, dropped) {
  const cols = columns()[table];
  if (!cols) throw new Error('supabase/cfb_market.sql has no table ' + table);
  const o = {};
  Object.keys(row).forEach((k) => { if (cols.includes(k)) o[k] = row[k]; else if (dropped) dropped[k] = (dropped[k] || 0) + 1; });
  return o;
}

function plan(season, dir) {
  const d = dir || path.join(__dirname, 'ledger', String(season));
  return Object.keys(RUN.FILES).map((k) => {
    const dropped = {};
    const rows = readJsonl(path.join(d, k + '.jsonl')).map((r) => shape(RUN.TABLES[k], r, dropped));
    return { table: RUN.TABLES[k], key: RUN.FILES[k], rows, dropped };
  });
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const P = plan(season, opts.dir);
  const log = opts.log || LOG.logger({ job: 'cfb_lab_hourly' }, { sink: opts.quiet ? () => {} : undefined });
  if (!url || !key || opts.dryRun) {
    P.forEach((p) => log.info('mirror', opts.dryRun ? 'dry_run' : 'no_credentials', { table: p.table, rows: p.rows.length }));
    return { skipped: true, plan: P.map((p) => ({ table: p.table, rows: p.rows.length })) };
  }
  const io = Object.assign({ log, fetch: opts.fetch, onIncident: DB.incidentSink({ url, key, log, fetch: opts.fetch }) }, opts.io || {});
  const out = {};
  for (const p of P) {
    if (!p.rows.length) { out[p.table] = { rows: 0 }; continue; }
    try { out[p.table] = await DB.postRows(url, key, p.table, p.key, p.rows, io); }
    catch (e) {
      if (!LABSYNC.tableMissing(e)) throw e;
      /* the migration is not applied yet: the ledger keeps the rows and the next run sends them */
      log.warn('mirror', 'optional_table_missing', { table: p.table, rows: p.rows.length, error_code: e.cfb_code || null, note: 'apply supabase/cfb_market.sql to mirror it' });
      out[p.table] = { skipped: 'table missing', rows: p.rows.length };
    }
  }
  return out;
}

module.exports = { sync, plan, columns, shape };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  /* the season the Model Lab writes (its config), never the calendar year: a January bowl belongs to the season before */
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'cfb_lab', 'config.json'), 'utf8'));
  sync(Number(arg('--season', cfg.season)), { dryRun: a.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
