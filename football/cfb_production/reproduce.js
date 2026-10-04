#!/usr/bin/env node
/* ============================================================================
   CFB production — reproducibility (brief §66-67; docs/cfb-production/CANONICAL.md §8).

   Re-runs preserved historical predictions from the exact inputs they were
   made from and requires the same numbers:

     snapshots   every LIVE Model Lab snapshot of V2.1 / V2.0 names the
                 current.json it read (inputs_ref.current_sha256) and every V1
                 snapshot the slate it read (slate_sha256). The file with that
                 hash is found (the working tree, then git history), the row is
                 re-run through the canonical pathway (V2) or the record's
                 reading of the slate (V1), and margin, probability, sigma and
                 intervals must equal the stored ones at the ledger's precision.
     settlement  every committed evaluation is re-graded from the committed
                 predictions, results and lines (settle.gradeAll): the same ids
                 and the same graded fields (evaluated_at aside).

   Deterministic: no clock, no randomness, no network. A snapshot whose input
   file is not reachable (a shallow clone) is counted as NO_SOURCE, never as a
   pass.

     node football/cfb_production/reproduce.js [--season 2026] [--git-depth 400] [--json]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const CANON = require('./canonical.js');

const REPO = path.resolve(__dirname, '..', '..');
const LAB = path.join(REPO, 'football', 'cfb_lab');
const V2 = 'football/cfb_v2/current.json', SLATE = 'football/fbs/slate.json';

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJsonl(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
function listJsonl(d) { try { return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readJsonl(path.join(d, f))); } catch (e) { return []; } }
function git(args) { try { return cp.execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); } catch (e) { return null; } }

/* sha256 -> parsed content of every version of `rel` reachable (working tree + history) */
function versions(rel, depth) {
  const out = new Map();
  try { const b = fs.readFileSync(path.join(REPO, rel)); out.set(sha(b), JSON.parse(b)); } catch (e) { /* none */ }
  const log = git(['log', '--format=%H', '-n', String(depth || 400), '--', rel]);
  for (const c of String(log || '').split('\n').filter(Boolean)) {
    const b = git(['show', c + ':' + rel]);
    if (!b) continue;
    const h = sha(b);
    if (!out.has(h)) { try { out.set(h, JSON.parse(b)); } catch (e) { /* not JSON */ } }
  }
  return out;
}

const r3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
const p5 = (p) => Math.min(0.99999, Math.max(0.00001, Math.round(p * 1e5) / 1e5));

function snapshots(season, opts) {
  opts = opts || {};
  const preds = opts.predictions || listJsonl(path.join(LAB, 'ledger', String(season), 'predictions')).filter((p) => p.origin === 'LIVE');
  const cur = versions(V2, opts.depth), slates = versions(SLATE, opts.depth);
  const M = require(path.join(LAB, 'models.js'));
  const v1Cache = new Map();
  const res = { checked: 0, reproduced: 0, mismatched: [], no_source: 0, by_model: {} };
  const tally = (mv, k) => { res.by_model[mv] = res.by_model[mv] || { reproduced: 0, mismatched: 0, no_source: 0 }; res.by_model[mv][k]++; };
  for (const p of preds) {
    let want = null;
    const ir = p.inputs_ref || {};
    if (p.engine_id === 'edgedesk_cfb_v2') {
      const c = ir.current_sha256 && cur.get(ir.current_sha256);
      const row0 = c && (c.rows || []).find((r) => String(r.game_id) === String(p.game_id));
      if (!row0) { res.no_source++; tally(p.model_version, 'no_source'); continue; }
      let row = row0, eng;
      if (p.model_version === 'edgedesk_cfb_v2.1.0' || p.model_version === (c.model_version || '')) eng = CANON.loadEngine();
      else {
        const s = row0.shadow && row0.shadow.candidate_001;
        if (!s) { res.no_source++; tally(p.model_version, 'no_source'); continue; }
        row = Object.assign({}, row0, { ens_pred: s.ens_pred, sigma: s.sigma, components: s.components || null, ens_sd: s.ens_sd != null ? s.ens_sd : null, model_version: s.model_version });
        eng = CANON.loadEngine(path.join(REPO, 'football', 'cfb_v2', 'candidates', 'cfb_v2_candidate_001', 'params.js'));
      }
      const pure = CANON.pure(row, { engine: eng.engine, params: eng.params });
      if (pure.status !== 'PREDICTED') { res.mismatched.push({ prediction_id: p.prediction_id, why: 'now ' + pure.status + ': ' + (pure.reason || '') }); tally(p.model_version, 'mismatched'); res.checked++; continue; }
      want = { pure_home_margin: r3(pure.projected_margin), home_win_probability: p5(pure.home_win_prob), prediction_sigma: r3(pure.sigma),
        interval_80_low: pure.intervals.p80[0], interval_80_high: pure.intervals.p80[1], football_confidence_raw: Math.round(pure.football_prediction_confidence) };
    } else if (p.engine_id === 'edgedesk_cfb_p4') {
      const s = ir.slate_sha256 && slates.get(ir.slate_sha256);
      if (!s) { res.no_source++; tally(p.model_version, 'no_source'); continue; }
      if (!v1Cache.has(ir.slate_sha256)) v1Cache.set(ir.slate_sha256, M.v1Adapter({ slate: s, slateHash: ir.slate_sha256 }).projections);
      const q = v1Cache.get(ir.slate_sha256).get(String(p.game_id));
      if (!q) { res.mismatched.push({ prediction_id: p.prediction_id, why: 'the slate no longer yields this game' }); tally(p.model_version, 'mismatched'); res.checked++; continue; }
      want = { pure_home_margin: r3(q.pure.margin), home_win_probability: typeof q.pure.p_home === 'number' ? p5(q.pure.p_home) : null };
    } else continue;
    res.checked++;
    const diff = Object.keys(want).filter((k) => want[k] !== p[k] && !(want[k] == null && p[k] == null));
    if (diff.length) { res.mismatched.push({ prediction_id: p.prediction_id, model_version: p.model_version, fields: diff.map((k) => k + ' stored ' + p[k] + ' now ' + want[k]) }); tally(p.model_version, 'mismatched'); }
    else { res.reproduced++; tally(p.model_version, 'reproduced'); }
  }
  return res;
}

/* every committed evaluation re-graded from the committed ledger */
function settlement(season) {
  const ST = require(path.join(LAB, 'settle.js'));
  const d = path.join(LAB, 'ledger', String(season));
  const preds = listJsonl(path.join(d, 'predictions'));
  const results = readJsonl(path.join(d, 'results.jsonl')), lines = readJsonl(path.join(d, 'lines.jsonl'));
  const stored = readJsonl(path.join(d, 'evaluations.jsonl'));
  /* re-grade at the moment each stored evaluation was made: its evaluated_at */
  const byId = new Map(stored.map((e) => [e.evaluation_id, e]));
  const nows = [...new Set(stored.map((e) => e.evaluated_at))].sort();
  const regraded = new Map();
  for (const now of nows) ST.gradeAll(preds, results, lines, [], now).forEach((e) => { if (!regraded.has(e.evaluation_id)) regraded.set(e.evaluation_id, e); });
  const out = { stored: stored.length, reproduced: 0, missing: [], mismatched: [] };
  for (const [id, e] of byId) {
    const g = regraded.get(id);
    if (!g) { out.missing.push(id); continue; }
    const keys = Object.keys(e).filter((k) => k !== 'evaluated_at' && k !== 'recorded_at');
    const bad = keys.filter((k) => JSON.stringify(e[k]) !== JSON.stringify(g[k]));
    if (bad.length) out.mismatched.push({ evaluation_id: id, fields: bad.slice(0, 5) });
    else out.reproduced++;
  }
  return out;
}

module.exports = { snapshots, settlement, versions };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const cfg = JSON.parse(fs.readFileSync(path.join(LAB, 'config.json'), 'utf8'));
  const season = Number(arg('--season', cfg.season));
  const s = snapshots(season, { depth: Number(arg('--git-depth', 400)) });
  const t = settlement(season);
  const out = { season, snapshots: Object.assign({}, s, { mismatched: s.mismatched.slice(0, 20) }), settlement: Object.assign({}, t, { missing: t.missing.slice(0, 20), mismatched: t.mismatched.slice(0, 20) }) };
  console.log(JSON.stringify(out, null, a.includes('--json') ? 1 : 0));
  process.exit(s.mismatched.length || t.mismatched.length ? 1 : 0);
}
