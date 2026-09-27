/* ============================================================================
   CFB Model Lab — mirror the repository ledger into Postgres (insert-only),
   and pull the per-sportsbook quotes the Supabase `capture` function wrote.

   Every table is write-once (supabase/cfb_lab.sql triggers refuse UPDATE,
   DELETE and TRUNCATE, the service role included). Rows are POSTed with
   `on_conflict=<id>` and `resolution=ignore-duplicates`, so a row already there
   is skipped, never updated. Without SB_URL / SB_SERVICE_ROLE it logs and
   exits 0 (the repository ledger is complete on its own).

     node football/cfb_lab/sync_supabase.js [--season 2026] [--dry-run]
   ========================================================================== */
'use strict';
const path = require('path');
const G = require('./ledger.js');
const L = require('./lab_core.js');

const U = L.util;
/* one write path for every CFB mirror: classified bounded retry, incidents (docs/cfb-production/OPERATIONS.md §1) */
const DB = require(path.join(G.REPO, 'football', 'cfb_production', 'db.js'));
const LOG = require(path.join(G.REPO, 'football', 'cfb_production', 'log.js'));
const TABLES = [
  ['cfb_lab_model_roles', 'model_roles', 'event_id', true],
  ['cfb_lab_experiments', 'experiments', 'event_id', true],
  ['cfb_lab_audit_log', 'audit_log', 'event_id', true],
  ['cfb_lab_partitions', 'partitions', 'event_id', true],
  ['cfb_lab_research_queue', 'research_queue', 'event_id', true],
  ['cfb_lab_predictions', 'predictions', 'prediction_id', false],
  ['cfb_lab_market_quotes', 'quotes', 'quote_id', false],
  ['cfb_lab_event_map', 'event_map', 'map_id', false],
  ['cfb_lab_market_lines', 'lines', 'line_id', false],
  ['cfb_lab_results', 'results', 'result_id', false],
  ['cfb_lab_evaluations', 'evaluations', 'evaluation_id', false],
  ['cfb_lab_miss_reviews', 'miss_reviews', 'review_id', false],
];

/* Only the columns the table has: PostgREST refuses a row carrying any other
   key. The column lists are read from the migration itself
   (supabase/cfb_lab.sql), so the mirror and the schema cannot drift apart;
   `recorded_at` is the server's own clock and is never sent. Keys the ledger
   keeps that the table does not (working fields) are counted, not sent. */
const fs = require('fs');
let COLS = null;
function columns() {
  if (COLS) return COLS;
  const sql = fs.readFileSync(path.join(G.REPO, 'supabase', 'cfb_lab.sql'), 'utf8');
  COLS = {};
  const re = /create table if not exists public\.(cfb_lab_[a-z0-9_]+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    COLS[m[1]] = m[2].split('\n').map((l) => /^\s+([a-z_][a-z0-9_]*)\s+(text|int|integer|smallint|bigint|numeric|boolean|timestamptz|jsonb|date|double|real)\b/.exec(l))
      .filter(Boolean).map((x) => x[1]).filter((c) => c !== 'constraint');
  }
  return COLS;
}
function shape(table, row, dropped) {
  const cols = columns()[table];
  if (!cols) throw new Error('supabase/cfb_lab.sql has no table ' + table);
  const o = {};
  for (const k of Object.keys(row)) {
    if (k !== 'recorded_at' && cols.includes(k)) o[k] = row[k];
    else if (dropped && k !== 'recorded_at') dropped[k] = (dropped[k] || 0) + 1;
  }
  return o;
}

/* insert-only, chunked; deadlock / lock-timeout / transient answers retried with bounded
   jitter, every other error raised at once with its class. The lab's copy used
   to have no retry at all: one 503 lost the whole hourly mirror. */
function post(url, key, table, onConflict, rows, opts) {
  return DB.postRows(url, key, table, onConflict, rows, opts);
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const store = opts.store || new G.Store(season);
  const plan = TABLES.map(([table, kind, id, gov]) => {
    let rows;
    if (kind === 'predictions') rows = store.predictions();
    /* odds_api quotes were written to Postgres by capture -> cfb_lab_ingest_quotes;
       the ledger's copy may carry a game_id the event map supplied later, so
       it is not copied back (it would be a second row for one observation) */
    else if (kind === 'quotes') rows = store.quotes().filter((q) => q.source !== 'odds_api');
    else rows = gov ? store.gov(kind) : G.readJsonl(store.f[kind]);
    const dropped = {};
    return { table, id, rows: rows.map((r) => shape(table, r, dropped)), dropped };
  });
  if (!url || !key || opts.dryRun) {
    if (!opts.quiet) plan.forEach((p) => console.log('[cfb_lab sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + p.table + ' ' + p.rows.length + ' rows'
      + (Object.keys(p.dropped).length ? ' (ledger-only keys not sent: ' + Object.keys(p.dropped).join(', ') + ')' : '')));
    return { skipped: true, plan: plan.map((p) => ({ table: p.table, rows: p.rows.length, dropped: p.dropped })) };
  }
  const log = opts.log || LOG.logger({ job: 'cfb_lab_hourly' }, { sink: opts.quiet ? () => {} : undefined });
  const io = Object.assign({ log, fetch: opts.fetch, onIncident: DB.incidentSink({ url, key, log, fetch: opts.fetch }) }, opts.io || {});
  const out = {};
  for (const p of plan) out[p.table] = await post(url, key, p.table, p.id, p.rows, io);
  return out;
}

/* Per-sportsbook quotes written by capture -> cfb_lab_ingest_quotes(); only
   rows newer than the newest odds_api quote already in the repository ledger. */
async function pullQuotes(season, now) {
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const store = new G.Store(season);
  const have = store.quotes().filter((q) => q.source === 'odds_api');
  const since = have.reduce((m, q) => Math.max(m, U.ms(q.retrieved_at) || 0), 0);
  const q = url + '/rest/v1/cfb_lab_market_quotes?select=*&source=eq.odds_api&season=eq.' + season +
    (since ? '&retrieved_at=gt.' + encodeURIComponent(new Date(since).toISOString()) : '') + '&order=observed_at.asc&limit=20000';
  const res = await DB.withRetry(() => DB.request(q, { headers: { apikey: key, authorization: 'Bearer ' + key } }), { label: 'pull cfb_lab_market_quotes' });
  const rows = await res.json();
  /* Postgres renders timestamps as "+00:00" and numerics as numbers or
     strings; the ledger's ids hash the canonical forms (SCHEMA.md rule 4) */
  const TS = ['observed_at', 'provider_updated_at', 'kickoff_ts', 'retrieved_at'];
  const NUM = ['home_line', 'total_points', 'price_home', 'price_away', 'price_over', 'price_under', 'season', 'week'];
  return rows.map((r) => {
    const o = Object.assign({}, r);
    delete o.recorded_at;
    TS.forEach((k) => { if (o[k] != null) o[k] = U.iso(o[k]); });
    NUM.forEach((k) => { if (o[k] != null) o[k] = Number(o[k]); });
    return o;
  });
}

module.exports = { sync, pullQuotes, TABLES, shape, columns };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  sync(Number(arg('--season', new Date().getUTCFullYear())), { dryRun: a.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
