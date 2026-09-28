/* ============================================================================
   Bettor decisions — mirror the append-only decision ledger into Postgres
   (supabase/bettor_decisions.sql), insert-only.

     football/cfb_terminal/decisions/<season>/snapshots.jsonl → bettor_decision_snapshots
     football/cfb_terminal/decisions/<season>/grades.jsonl    → bettor_decision_grades
     football/cfb_terminal/decisions/<season>/evaluations.jsonl → bettor_decision_evaluations
                                          (supabase/decision_validation.sql; skipped, never
                                          fatal, until that file is applied)

   Both tables are write-once (triggers refuse UPDATE and DELETE, the service
   role included) and a snapshot evaluated at or after kickoff is refused.
   Rows are POSTed with on_conflict=snapshot_id / ignore-duplicates through the
   one CFB write path (football/cfb_production/db.js). Without SB_URL /
   SB_SERVICE_ROLE it logs and exits 0.

     node football/cfb_terminal/decisions_sync.js [--season 2026] [--dry-run]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const DB = (() => { try { return require(path.join(REPO, 'football', 'cfb_production', 'db.js')); } catch (e) { return null; } })();

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/* the typed columns of bettor_decision_snapshots; the whole snapshot rides in `snapshot` */
function snapshotRow(s) {
  const bp = s.bet_price || s.reference_quote || null;
  return { snapshot_id: s.snapshot_id, sport: s.sport || 'CFB', game_id: String(s.game_id), market_key: s.market_key || 'CFB:spread', home_team: s.home || null, away_team: s.away || null,
    kickoff: s.kickoff || null, evaluated_at: s.evaluated_at, decision: s.decision, reason_code: s.action_reason_code || 'UNKNOWN',
    side: bp && (bp.side === 'home' || bp.side === 'away') ? bp.side : null, line: bp ? bp.line : null, odds: bp ? bp.odds : null, book: bp ? bp.book : null,
    units: s.decision === 'BET' ? s.recommended_units : 0, max_playable_line: s.max_playable_line, max_acceptable_odds: s.max_acceptable_odds,
    calibrated_ev_pct: s.calibrated_ev_pct, raw_ev_pct: s.raw_ev_pct, reliability_score: s.reliability_score, market_quality: s.market_quality,
    model_version: s.model_version, calibration_version: s.calibration_version, decision_engine_version: s.decision_engine_version, config_version: s.config_version,
    validation_state: s.validation_state, snapshot: s };
}
function gradeRow(g) {
  return { snapshot_id: g.snapshot_id, units: g.units, odds: g.odds, line: g.line, close_line: g.close_line, clv_points: g.clv_points, result: g.result,
    units_won: g.units_won, calibrated_cover: g.calibrated_cover, graded_at: g.graded_at };
}
/* every decision class, graded (lib/edgedesk_decision_track.js gradeEvaluation) */
const EVAL_COLS = ['snapshot_id', 'game_id', 'sport', 'market_type', 'evaluation_mode', 'decision', 'reason_code', 'units', 'side', 'evaluated_line', 'evaluated_odds', 'evaluated_book',
  'bet_line', 'bet_odds', 'open_line', 'close_line', 'close_sharp_line', 'close_captured_at', 'clv_points', 'clv_sharp_points', 'clv_price_pp', 'clv_ev', 'result', 'units_won',
  'flat_units_won_hypothetical', 'predicted', 'break_even', 'edge_pp', 'calibrated_ev', 'decision_ev', 'decision_confidence', 'probability_source', 'reliability', 'market_quality',
  'model_version', 'calibration_version', 'pricing_version', 'rules_version', 'engine_version', 'version_key', 'evaluated_at', 'kickoff', 'unit_of_analysis', 'graded_at'];
function evaluationRow(e) {
  const o = {};
  EVAL_COLS.forEach((k) => { o[k] = e[k] === undefined ? null : e[k]; });
  o.game_id = String(e.game_id); o.sport = e.sport || 'CFB'; o.market_type = e.market_type || 'spread'; o.evaluation_mode = e.evaluation_mode || 'LIVE';
  o.units = e.decision === 'BET' ? e.units : 0; o.unit_of_analysis = e.unit_of_analysis || 'first_per_class';
  o.evaluation = e;
  return o;
}
function plan(season, opts) {
  opts = opts || {};
  const dir = path.join(opts.root || path.join(REPO, 'football', 'cfb_terminal', 'decisions'), String(season));
  return [
    { table: 'bettor_decision_snapshots', id: 'snapshot_id', rows: readJsonl(path.join(dir, 'snapshots.jsonl')).map(snapshotRow) },
    { table: 'bettor_decision_grades', id: 'snapshot_id', rows: readJsonl(path.join(dir, 'grades.jsonl')).map(gradeRow) },
    { table: 'bettor_decision_evaluations', id: 'snapshot_id', rows: readJsonl(path.join(dir, 'evaluations.jsonl')).map(evaluationRow), optional: 'supabase/decision_validation.sql' }
  ];
}
async function sync(season, opts) {
  opts = opts || {};
  const url = process.env.SB_URL, key = process.env.SB_SERVICE_ROLE;
  const p = plan(season, opts);
  if (!url || !key || opts.dryRun || !DB) {
    if (!opts.quiet) p.forEach((x) => console.log('[bettor decisions sync] ' + (opts.dryRun ? 'dry-run' : 'no credentials') + ': ' + x.table + ' ' + x.rows.length + ' rows'));
    return { skipped: true, plan: p.map((x) => ({ table: x.table, rows: x.rows.length })) };
  }
  const out = {};
  for (const x of p) {
    if (!x.rows.length) { out[x.table] = 0; continue; }
    try { out[x.table] = await DB.postRows(url, key, x.table, x.id, x.rows, { fetch: opts.fetch }); }
    catch (e) {
      /* a table a newer SQL file adds is optional until that file is applied: the
         older tables still sync, and the log says exactly what to apply */
      if (!x.optional) throw e;
      out[x.table] = { skipped: true, reason: String(e && e.message || e).slice(0, 200), apply: x.optional };
      if (!opts.quiet) console.log('[bettor decisions sync] ' + x.table + ' skipped: apply ' + x.optional + ' (' + out[x.table].reason + ')');
    }
  }
  return out;
}

module.exports = { sync, plan, snapshotRow, gradeRow, evaluationRow, EVAL_COLS };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const now = new Date();
  const season = Number(arg('--season', now.getUTCMonth() <= 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear()));
  sync(season, { dryRun: a.includes('--dry-run') }).then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e.message); process.exit(1); });
}
