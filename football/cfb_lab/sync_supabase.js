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

/* Only the columns the table has (SCHEMA.md); extra working fields stay in the ledger. */
const DROP = { cfb_lab_market_lines: ['kickoff_ts'], cfb_lab_evaluations: [], cfb_lab_predictions: [] };
function shape(table, row) {
  const o = Object.assign({}, row);
  (DROP[table] || []).forEach((k) => delete o[k]);
  return o;
}

async function post(url, key, table, onConflict, rows) {
  let sent = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(url + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
      method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(table + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    sent += chunk.length;
  }
  return sent;
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const store = new G.Store(season);
  const plan = TABLES.map(([table, kind, id, gov]) => {
    let rows;
    if (kind === 'predictions') rows = store.predictions();
    /* odds_api quotes were written to Postgres by capture -> cfb_lab_ingest_quotes;
       the ledger's copy may carry a game_id the event map supplied later, so
       it is not copied back (it would be a second row for one observation) */
    else if (kind === 'quotes') rows = store.quotes().filter((q) => q.source !== 'odds_api');
    else rows = gov ? store.gov(kind) : G.readJsonl(store.f[kind]);
    return { table, id, rows: rows.map((r) => shape(table, r)) };
  });
  if (!url || !key || opts.dryRun) {
    plan.forEach((p) => console.log('[cfb_lab sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + p.table + ' ' + p.rows.length + ' rows'));
    return { skipped: true };
  }
  const out = {};
  for (const p of plan) out[p.table] = await post(url, key, p.table, p.id, p.rows);
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
  const res = await fetch(q, { headers: { apikey: key, authorization: 'Bearer ' + key } });
  if (!res.ok) throw new Error('pull cfb_lab_market_quotes: HTTP ' + res.status);
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

module.exports = { sync, pullQuotes, TABLES, shape };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  sync(Number(arg('--season', new Date().getUTCFullYear())), { dryRun: a.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
