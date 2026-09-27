/* ============================================================================
   CFB personnel — mirror the personnel ledger into Postgres
   (supabase/cfb_personnel.sql), insert-only.

   Committed ledger (football/cfb_personnel/<season>/*.jsonl): unit states,
   game snapshots, player events, model versions, the registry and transfers.
   Bulky per-player rows (player-week state, depth charts, player-game
   performance) are written by the run to $CFB_V2_OUT/personnel/ledger/<season>/
   and mirrored from there with --state-dir (they are not committed: tens of
   thousands of rows a week).

   Every table is write-once (triggers refuse UPDATE, DELETE and TRUNCATE, the
   service role included). Each row is POSTed with its typed columns (read from
   the migration itself, so the mirror cannot drift from the schema) and the
   complete row in `payload`, with `on_conflict=<id>` and
   `resolution=ignore-duplicates`. Without SB_URL / SB_SERVICE_ROLE it logs and
   exits 0.

     node football/cfb_personnel/sync_supabase.js [--season 2026] [--state-dir DIR] [--dry-run]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SQL = path.join(REPO, 'supabase', 'cfb_personnel.sql');

/* ledger file -> table, id column */
const TABLES = [
  ['players.jsonl', 'cfb_players', 'player_row_id'],
  ['player_aliases.jsonl', 'cfb_player_aliases', 'alias_id'],
  ['transfers.jsonl', 'cfb_transfer_history', 'transfer_id'],
  ['model_versions.jsonl', 'cfb_personnel_model_versions', 'version_row_id'],
  ['player_events.jsonl', 'cfb_player_events', 'event_id'],
  ['unit_state.jsonl', 'cfb_personnel_unit_state', 'unit_state_id'],
  ['game_snapshots.jsonl', 'cfb_personnel_game_snapshot', 'snapshot_id'],
];
const STATE_TABLES = [
  ['player_performance.jsonl', 'cfb_player_performance', 'performance_id'],
  ['player_week_state.jsonl', 'cfb_player_week_state', 'player_week_state_id'],
  ['depth_chart_state.jsonl', 'cfb_depth_chart_state', 'depth_chart_state_id'],
];

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
const TEXT_IDS = new Set(['team_id', 'game_id', 'from_team', 'to_team']);
function shape(table, row) {
  const cols = columns()[table];
  if (!cols) throw new Error('supabase/cfb_personnel.sql has no table ' + table);
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
  const dir = path.join(opts.root || path.join(REPO, 'football', 'cfb_personnel'), String(season));
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
    if (!opts.quiet) p.forEach((x) => console.log('[cfb_personnel sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + x.table + ' ' + x.rows.length + ' rows'));
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
