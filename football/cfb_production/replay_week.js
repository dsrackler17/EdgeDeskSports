#!/usr/bin/env node
/* ============================================================================
   CFB production — replay a full historical week, schedule to settlement
   (brief §104-105; docs/cfb-production/CANONICAL.md §8).

   The production pathway of the hourly job, run hour by hour through a week
   that has been played, into a throwaway ledger:

     schedule    the week's games (the preserved pregame rows), each through the
                 team identity master; duplicate pairs detected
     projection  the preserved pregame rows through the canonical service (the
                 input contract, the engine of the rows' own version)
     market      the quotes the Model Lab captured for those games, integrity
                 screened at each snapshot
     snapshots   checkpoint.run every hour from the first freeze to the last
                 kickoff: one row per window, nothing back-filled
     settlement  results from the committed settlement, openers and closes
                 derived, every snapshot graded (settle.run, offline)

   Deterministic: the same inputs give byte-identical ledger files (the report
   carries their hash). The committed replay rows are v2.0.0 (candidate 001:
   football/cfb_v2/snapshots/<season>/replay_to_date.json); V2.1 has no
   preserved per-row history for a played week yet, so the replay runs the
   pathway on the version whose rows exist, through that version's own engine.

     node football/cfb_production/replay_week.js --season 2026 --week 3 [--weeks 1-4] [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
const LAB = path.join(REPO, 'football', 'cfb_lab');
const L = require(path.join(LAB, 'lab_core.js'));
const G = require(path.join(LAB, 'ledger.js'));
const M = require(path.join(LAB, 'models.js'));
const CP = require(path.join(LAB, 'checkpoint.js'));
const ST = require(path.join(LAB, 'settle.js'));
const ID = require(path.join(LAB, 'identity.js'));
const CANON = require('./canonical.js');

const U = L.util;
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function listJsonl(d) { try { return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(d, f))); } catch (e) { return []; } }
function hashDir(d) {
  const h = crypto.createHash('sha256');
  const walk = (x) => fs.readdirSync(x).sort().forEach((f) => { const p = path.join(x, f); if (fs.statSync(p).isDirectory()) walk(p); else { h.update(path.relative(d, p)); h.update(fs.readFileSync(p)); } });
  if (fs.existsSync(d)) walk(d);
  return h.digest('hex');
}

async function replay(season, weeks, opts) {
  opts = opts || {};
  weeks = [].concat(weeks);
  const rep = JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'cfb_v2', 'snapshots', String(season), 'replay_to_date.json'), 'utf8'));
  const rows = rep.rows.filter((r) => weeks.includes(r.week)).map((r) => { const o = Object.assign({}, r); delete o.shadow; return o; });
  const gids = new Set(rows.map((r) => String(r.game_id)));
  const dir = path.join(REPO, 'football', 'cfb_lab', 'ledger', String(season));
  const quotes = listJsonl(path.join(dir, 'quotes')).filter((q) => gids.has(String(q.game_id)));
  const results = readJsonl(path.join(dir, 'results.jsonl')).filter((r) => gids.has(String(r.game_id)));
  const out = { season, weeks, model_version: rep.model_version, games: rows.length, schedule: {}, projection: {}, snapshots: {}, settlement: {} };
  /* schedule: identity and duplicates */
  const idv = rows.map((r) => ID.validateGame({ home_team: r.home, away_team: r.away, home_id: r.home_id, away_id: r.away_id }));
  const pairs = new Map(); rows.forEach((r) => { const k = ID.pairKey(r.home, r.away, r.home_id, r.away_id); pairs.set(k, (pairs.get(k) || 0) + 1); });
  out.schedule = { validated: idv.filter((v) => v.ok).length, problems: idv.filter((v) => !v.ok).map((v) => v.problems.join('; ')).slice(0, 5), duplicate_pairs: [...pairs.values()].filter((n) => n > 1).length };
  /* projection: the canonical service, the rows' own engine */
  const eng = CANON.loadEngine(path.join(REPO, 'football', 'cfb_v2', 'candidates', 'cfb_v2_candidate_001', 'params.js'));
  const snaps = rows.map((r) => CANON.snapshot(r, { as_of_ts: U.iso(r.prediction_ts), engine: eng.engine, params: eng.params, row_model_version: rep.model_version }));
  out.projection = snaps.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
  /* snapshots: the hourly job, hour by hour, into a throwaway ledger */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfb-replay-'));
  try {
    const so = { root: path.join(tmp, 'ledger'), govRoot: path.join(tmp, 'gov') };
    const store = new G.Store(season, so);
    store.appendQuotes(quotes);
    const models = [M.v2Adapter('candidate_001_direct', { current: { rows, generated_at: rep.generated_at, model_version: rep.model_version }, slate: { games: [] }, currentHash: 'replay' })];
    const t0 = Math.min.apply(null, rows.map((r) => U.ms(r.prediction_ts)));
    const t1 = Math.max.apply(null, rows.map((r) => U.ms(r.kickoff)));
    let hours = 0, taken = 0;
    for (let t = t0; t <= t1; t += 3600000) { const r = CP.run({ now: U.iso(t), season, models, storeOpts: so, schedule: {} }); hours++; taken += r.taken; }
    const preds = store.predictions();
    const perSlot = new Map(); preds.forEach((p) => { const k = p.game_id + '|' + p.checkpoint_type; perSlot.set(k, (perSlot.get(k) || 0) + 1); });
    out.snapshots = { hours, taken, rows: preds.length, by_checkpoint: preds.reduce((a, p) => { a[p.checkpoint_type] = (a[p.checkpoint_type] || 0) + 1; return a; }, {}),
      duplicate_windows: [...perSlot.values()].filter((n) => n > 1).length, games_snapshotted: new Set(preds.map((p) => p.game_id)).size,
      bets: preds.filter((p) => p.decision_class === 'BET').length, after_kickoff: preds.filter((p) => U.ms(p.prediction_ts) >= U.ms(p.kickoff_ts)).length };
    /* settlement: the committed results as the readings, offline */
    const readings = {};
    results.forEach((r) => { readings[String(r.game_id)] = { source: 'replay', status: r.status, home_points: r.home_points, away_points: r.away_points, overtime: r.overtime }; });
    const settleAt = U.iso(t1 + 6 * 3600000);
    const s1 = await ST.run({ now: settleAt, season, offline: true, readings: [readings], useRecord: false, storeOpts: so });
    const s2 = await ST.run({ now: settleAt, season, offline: true, readings: [readings], useRecord: false, storeOpts: so });
    const ev = store.evaluations();
    const ats = ev.reduce((a, e) => { a[e.ats_result || 'NONE'] = (a[e.ats_result || 'NONE'] || 0) + 1; return a; }, {});
    const mae = ev.filter((e) => e.checkpoint_type !== 'OPEN' && U.isNum(e.abs_margin_error));
    out.settlement = { results: store.results().length, evaluations: ev.length, second_run_added: (s2.results || 0) + (s2.evaluations || 0), ats,
      graded_games: new Set(ev.map((e) => e.game_id)).size, never_final_graded: ev.filter((e) => e.result_status !== 'FINAL' && e.ats_result && e.ats_result !== 'VOID').length,
      mae_all_windows: mae.length ? U.r(mae.reduce((a, e) => a + e.abs_margin_error, 0) / mae.length, 3) : null, first_run: { results: s1.results, evaluations: s1.evaluations } };
    out.ledger_verify = G.verify({ roots: [so.root, so.govRoot], base: null });
    out.ledger_sha256 = hashDir(so.root);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

module.exports = { replay };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const season = Number(arg('--season', 2026));
  const w = arg('--weeks', arg('--week', '3'));
  const weeks = /-/.test(w) ? (() => { const [x, y] = w.split('-').map(Number); const o = []; for (let i = x; i <= y; i++) o.push(i); return o; })() : [Number(w)];
  (async () => {
    const r1 = await replay(season, weeks), r2 = await replay(season, weeks);
    const out = Object.assign({}, r1, { deterministic: r1.ledger_sha256 === r2.ledger_sha256 });
    console.log(JSON.stringify(out, null, a.includes('--json') ? 1 : 0));
    process.exit(out.deterministic && !r1.ledger_verify.length ? 0 : 1);
  })();
}
