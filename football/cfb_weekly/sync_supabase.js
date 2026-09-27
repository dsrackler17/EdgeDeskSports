/* ============================================================================
   CFB weekly engine — mirror football/cfb_weekly/<season>/*.jsonl into Postgres
   (supabase/cfb_weekly.sql), insert-only.

   Every table is write-once (triggers refuse UPDATE, DELETE and TRUNCATE, the
   service role included). Each row is POSTed with its typed columns (read from
   the migration itself, so the mirror cannot drift from the schema) and the
   complete ledger row in `payload`, with `on_conflict=<id>` and
   `resolution=ignore-duplicates`: a row already there is skipped, never
   updated. Without SB_URL / SB_SERVICE_ROLE it logs and exits 0; the
   repository is complete on its own.

   PRODUCTION RULES (docs/cfb-production/OPERATIONS.md §1):
     - the run row is the COMMIT MARKER and is written LAST: a mirror cut short
       leaves state whose run row is absent, which the published views
       (cfb_team_week_state_published, supabase/cfb_production.sql) hide until
       the next sync completes it;
     - the upcoming-game feature snapshots are mirrored before the projections
       that name them, so the database can answer "which inputs produced this
       projection";
     - every chunk is one short transaction with classified, bounded, jittered
       retries (deadlock 40P01, lock timeout 55P03, transient) and an incident
       per deadlock (football/cfb_production/db.js);
     - the writes run under the weekly job lock cfb_job_lock('cfb_weekly_refresh',
       <season>): a second refresh exits cleanly instead of writing beside it.

     node football/cfb_weekly/sync_supabase.js [--season 2026] [--dry-run]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SQL = path.join(REPO, 'supabase', 'cfb_weekly.sql');
const DB = require(path.join(REPO, 'football', 'cfb_production', 'db.js'));
const LOG = require(path.join(REPO, 'football', 'cfb_production', 'log.js'));
const LOCKS = require(path.join(REPO, 'football', 'cfb_production', 'locks.js'));

/* ledger file -> table, id column. The stage log is expanded from the run manifests. */
const TABLES = [
  ['runs.jsonl', 'cfb_pipeline_runs', 'run_id'],
  ['game_validation.jsonl', 'cfb_game_validation', 'validation_id'],
  ['game_performance.jsonl', 'cfb_game_performance', 'performance_id'],
  ['team_week_state.jsonl', 'cfb_team_week_state', 'state_id'],
  ['qb_week_state.jsonl', 'cfb_qb_week_state', 'qb_state_id'],
  ['unit_week_state.jsonl', 'cfb_unit_week_state', 'unit_state_id'],
  ['qb_events.jsonl', 'cfb_qb_events', 'event_id'],
  ['projections.jsonl', 'cfb_weekly_projections', 'projection_id'],
  ['projection_changes.jsonl', 'cfb_projection_changes', 'change_id'],
  ['research.jsonl', 'cfb_weekly_research', 'item_id'],
  ['misses.jsonl', 'cfb_weekly_misses', 'miss_id'],
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

/* typed columns from the row, the whole row as payload */
function shape(table, row) {
  const cols = columns()[table];
  if (!cols) throw new Error('supabase/cfb_weekly.sql has no table ' + table);
  const o = {};
  for (const c of cols) {
    if (c === 'recorded_at') continue;
    if (c === 'payload') o.payload = row;
    else if (row[c] !== undefined) o[c] = row[c];
  }
  return o;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function plan(season, root) {
  const dir = path.join(root || path.join(REPO, 'football', 'cfb_weekly'), String(season));
  const out = TABLES.map(([file, table, id]) => ({ table, id, rows: readJsonl(path.join(dir, file)).map((r) => shape(table, r)) }));
  /* the model-input snapshots (upcoming_game_features/week_NN.jsonl), before the projections that name them */
  const fdir = path.join(dir, 'upcoming_game_features');
  const feats = fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readJsonl(path.join(fdir, f))).map((r) => shape('cfb_upcoming_game_features', r)) : [];
  out.splice(out.findIndex((x) => x.table === 'cfb_weekly_projections'), 0, { table: 'cfb_upcoming_game_features', id: 'feature_snapshot_id', rows: feats });
  /* the stage log, one row per (run, stage), from the run manifests */
  const stages = [];
  const rdir = path.join(dir, 'runs');
  if (fs.existsSync(rdir)) {
    for (const f of fs.readdirSync(rdir).filter((x) => x.endsWith('.json')).sort()) {
      const run = JSON.parse(fs.readFileSync(path.join(rdir, f), 'utf8'));
      for (const s of run.stages || []) {
        stages.push({ run_id: run.run_id, stage: s.stage, status: s.status, started_at: s.started_at, finished_at: s.finished_at,
          ms: s.ms, error_class: s.error_class, error: s.error, counts: s.counts });
      }
    }
  }
  out.push({ table: 'cfb_pipeline_stage_log', id: 'run_id,stage', rows: stages });
  /* source health, one row per (run, source) */
  const sh = path.join(dir, 'source_health.json');
  if (fs.existsSync(sh)) {
    const h = JSON.parse(fs.readFileSync(sh, 'utf8'));
    const crypto = require('crypto');
    out.push({ table: 'cfb_source_health', id: 'health_id', rows: (h.sources || []).map((s) => shape('cfb_source_health', Object.assign({
      health_id: 'cfbh_' + crypto.createHash('sha256').update([h.season, h.as_of, s.source].join('|')).digest('hex').slice(0, 24),
      season: h.season, as_of: h.as_of }, s))) });
  }
  /* the run rows last: a run row is the commit marker of everything it wrote */
  const runs = out.findIndex((x) => x.table === 'cfb_pipeline_runs');
  out.push(out.splice(runs, 1)[0]);
  return out;
}

/* insert-only, chunked, classified bounded retry (football/cfb_production/db.js) */
function post(url, key, table, onConflict, rows, opts) {
  return DB.postRows(url, key, table, onConflict, rows, opts);
}

async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const p = plan(season, opts.root);
  if (!url || !key || opts.dryRun) {
    if (!opts.quiet) p.forEach((x) => console.log('[cfb_weekly sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + x.table + ' ' + x.rows.length + ' rows'));
    return { skipped: true, plan: p.map((x) => ({ table: x.table, rows: x.rows.length })) };
  }
  const log = opts.log || LOG.logger({ job: 'cfb_weekly_refresh' }, { sink: opts.quiet ? () => {} : undefined });
  const io = Object.assign({ log, onIncident: DB.incidentSink({ url, key, log, fetch: opts.fetch }) }, opts.io || {});
  const locked = await LOCKS.withJobLock({ url, key, log, job: 'cfb_weekly_refresh', lockKey: season, ttl: 1800,
    required: process.env.CFB_REQUIRE_JOB_LOCK === '1', fetch: opts.fetch }, async () => {
    const out = {};
    for (const x of p) out[x.table] = await post(url, key, x.table, x.id, x.rows, Object.assign({ fetch: opts.fetch }, io));
    return out;
  });
  if (!locked.ran) return { skipped: 'PIPELINE_CONFLICT', holder: locked.holder };
  return locked.result;
}

module.exports = { sync, plan, shape, columns, TABLES };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = new Date();
  const season = Number(arg('--season', now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()));
  sync(season, { dryRun: a.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
