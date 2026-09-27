/* ============================================================================
   CFB decisions — mirror the decision ledger into Postgres
   (supabase/cfb_decision.sql), insert-only.

   Committed ledger (football/cfb_decision/<season>/*.jsonl): every decision
   snapshot (current and challenger engines), its eligibility checks, graded
   results, exposure, policies, calibration and model versions, experiments,
   and people's own wagers (stored apart, never official).

   Every table is write-once (triggers refuse UPDATE, DELETE and TRUNCATE, the
   service role included). Each row is POSTed with its typed columns (read from
   the migration itself, so the mirror cannot drift from the schema) and the
   complete row in `payload`, with `on_conflict=<id>` and
   `resolution=ignore-duplicates`. Without SB_URL / SB_SERVICE_ROLE it logs and
   exits 0.

     node football/cfb_decision/sync_supabase.js [--season 2026] [--state-dir DIR] [--dry-run]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SQL = path.join(REPO, 'supabase', 'cfb_decision.sql');

/* ledger file -> table, id column (football/cfb_decision/<season>/) */
const TABLES = [
  ['model_versions.jsonl', 'cfb_decision_model_versions', 'version_row_id'],
  ['probability_calibration.jsonl', 'cfb_probability_calibration', 'calibration_row_id'],
  ['ev_calibration.jsonl', 'cfb_ev_calibration', 'ev_calibration_id'],
  ['policies.jsonl', 'cfb_decision_policies', 'policy_row_id'],
  ['bankroll_policy.jsonl', 'cfb_bankroll_policy', 'bankroll_row_id'],
  ['decisions.jsonl', 'cfb_decision_snapshots', 'decision_id'],
  ['eligibility.jsonl', 'cfb_bet_eligibility', 'eligibility_id'],
  ['exposure.jsonl', 'cfb_portfolio_exposure', 'exposure_id'],
  ['results.jsonl', 'cfb_decision_results', 'result_id'],
  ['experiments.jsonl', 'cfb_decision_experiments', 'experiment_id'],
  ['manual_decisions.jsonl', 'cfb_manual_decisions', 'manual_id'],
];
const STATE_TABLES = [];

let COLS = null;
function columns() {
  if (COLS) return COLS;
  const sql = fs.readFileSync(SQL, 'utf8');
  COLS = {};
  const re = /create table if not exists public\.(cfb_[a-z0-9_]+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    COLS[m[1]] = m[2].split('\n').map((l) => /^\s+([a-z_][a-z0-9_]*)\s+(text|int|integer|numeric|boolean|timestamptz|jsonb|bigint)\b/.exec(l))
      .filter(Boolean).map((x) => x[1]).filter((c) => c !== 'constraint' && c !== 'primary');
  }
  return COLS;
}

/* typed columns from the row (ids as text: the ledger may hold numbers), the whole row as payload */
const TEXT_IDS = new Set(['game_id']);
function shape(table, row) {
  const cols = columns()[table];
  if (!cols) throw new Error('supabase/cfb_decision.sql has no table ' + table);
  const o = {};
  for (const c of cols) {
    if (c === 'recorded_at') continue;
    if (c === 'payload') o.payload = row;
    else if (row[c] !== undefined && row[c] !== null) o[c] = TEXT_IDS.has(c) ? String(row[c]) : row[c];
    else if (row[c] === null) o[c] = null;
  }
  return o;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function plan(season, opts) {
  opts = opts || {};
  const dir = path.join(opts.root || path.join(REPO, 'football', 'cfb_decision'), String(season));
  const out = TABLES.map(([file, table, id]) => ({ table, id, rows: readJsonl(path.join(dir, file)).map((r) => shape(table, r)) }));
  if (opts.stateDir) {
    const sd = path.join(opts.stateDir, String(season));
    for (const [file, table, id] of STATE_TABLES) out.push({ table, id, rows: readJsonl(path.join(sd, file)).map((r) => shape(table, r)) });
  }
  return out;
}

async function post(url, key, table, onConflict, rows) {
  let sent = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    let res, attempt = 0;
    for (;;) {
      res = await fetch(url + '/rest/v1/' + table + '?on_conflict=' + onConflict, {
        method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json',
          prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(chunk) });
      /* bounded retry for transient/rate-limit answers only; a 4xx schema error is permanent */
      if (res.ok || ![408, 425, 429, 500, 502, 503, 504].includes(res.status) || ++attempt > 3) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    if (!res.ok) throw new Error(table + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
    sent += chunk.length;
  }
  return sent;
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const p = plan(season, opts);
  if (!url || !key || opts.dryRun) {
    if (!opts.quiet) p.forEach((x) => console.log('[cfb_decision sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + x.table + ' ' + x.rows.length + ' rows'));
    return { skipped: true, plan: p.map((x) => ({ table: x.table, rows: x.rows.length })) };
  }
  const out = {};
  for (const x of p) out[x.table] = await post(url, key, x.table, x.id, x.rows);
  return out;
}

module.exports = { sync, plan, shape, columns, TABLES, STATE_TABLES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = new Date();
  const season = Number(arg('--season', now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()));
  sync(season, { dryRun: a.includes('--dry-run'), stateDir: arg('--state-dir', null) })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
