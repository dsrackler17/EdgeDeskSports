#!/usr/bin/env node
/* ============================================================================
   THE INDEPENDENT PROJECTIONS — engine/projections.json and its ledger.

   Every operational sport engine already publishes its own slate (hockey/,
   nba/, basketball/, soccer/, football/). This job reads those artifacts
   through EDPROJ (lib/edgedesk_projections.js) — the same code the quant desk
   inlines — into ONE contract per event, freezes them (a SHA-256 per
   projection and per snapshot), and writes:

     engine/projections.json                 the current frozen snapshot, the
                                             per-sport build summary and the
                                             capability matrix (every sport,
                                             what actually ran)
     engine/projections_ledger/<YYYY-MM>.jsonl  append-only: one line per new
                                             projection hash, so every model
                                             output is on record BEFORE any
                                             price is compared with it

   NO PRICE IS READ. The reader below refuses any path that is not one of the
   engine artifacts EDPROJ declares (EDPROJ.artifactsNeeded) — no quotes file,
   no signals, no scoreboard prices — and the run reports exactly what it read.

   Usage
     node engine/build_projections.js            write both
     node engine/build_projections.js --check    build, compare, write nothing
     node engine/build_projections.js --now ISO  build as of a time (replays)
   Exit 0 = written or current; 1 = differs (--check); 2 = nothing could be built.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const EDPROJ = require(path.join(ROOT, 'lib', 'edgedesk_projections.js'));
const OUT = path.join(ROOT, 'engine', 'projections.json');
const LEDGER_DIR = path.join(ROOT, 'engine', 'projections_ledger');
const SCHEMA = 'edgedesk_projections_artifact_v1';

/** Read exactly the engine artifacts EDPROJ declares; anything else (a quotes file, a market file) is refused. */
function makeReader(root, readFile) {
  const allowed = new Set(EDPROJ.artifactsNeeded());
  const read = [];
  const rf = readFile || ((p) => fs.readFileSync(path.join(root, p), 'utf8'));
  return {
    read: (rel) => {
      if (!allowed.has(rel)) throw new Error('refused: ' + rel + ' is not an engine artifact (the projection build reads no price)');
      try { const j = JSON.parse(rf(rel)); read.push({ path: rel, ok: true, generated_at: j && j.generated_at || null }); return j; }
      catch (e) { read.push({ path: rel, ok: false, error: String(e && e.message || e).slice(0, 160) }); return null; }
    },
    log: read
  };
}
/** Compact ledger line: what was projected, by which model, when it was frozen. */
function ledgerLine(p) {
  return { projection_id: p.projection_id, projection_hash: p.projection_hash, frozen_at: p.frozen_at, sport: p.sport, league: p.league, event_id: p.event_id, start_utc: p.start_utc,
    home: p.home.name, away: p.away.name, model_id: p.model.id, model_built_at: p.model.artifact_generated_at, p_home: p.outcome.p_home, p_away: p.outcome.p_away, p_draw: p.outcome.p_draw,
    fair_home_ml: p.fair.moneyline.home, fair_away_ml: p.fair.moneyline.away, fair_home_line: p.fair.spread ? p.fair.spread.home_line : null, fair_total: p.fair.total ? p.fair.total.line : null,
    research_outcome: p.research.outcome, invalidated: !!(p.integrity && p.integrity.invalidated), market_inputs: p.model.market_inputs };
}
function build(o) {
  o = o || {};
  const now = o.now != null ? (typeof o.now === 'number' ? o.now : Date.parse(o.now)) : Date.now();
  const R = makeReader(o.root || ROOT, o.readFile);
  const A = {};
  EDPROJ.artifactsNeeded().forEach((rel) => { A[rel] = R.read(rel); });
  const b = EDPROJ.buildAll(A, { now, registry: A['engine/registry.json'] || null });
  /* only events that have not started: a finished game is not a projection to compare a price with */
  const live = b.projections.filter((p) => { const t = Date.parse(p.start_utc || ''); return !Number.isFinite(t) || t > now - 3 * 3600e3; });
  const snap = EDPROJ.freeze(live, now);
  const bySport = {};
  snap.projections.forEach((p) => { const s = bySport[p.sport] || (bySport[p.sport] = { projections: 0, outcomes: {} }); s.projections++; s.outcomes[p.research.outcome] = (s.outcomes[p.research.outcome] || 0) + 1; });
  return {
    artifact: {
      schema: SCHEMA, version: EDPROJ.VERSION, contract: EDPROJ.CONTRACT, built_at: new Date(now).toISOString(),
      note: 'Independent projections only: every engine artifact read, no price read. Frozen and hashed here; the quant desk compares prices with them later (lib/edgedesk_market_compare.js) and never changes them.',
      snapshot: { frozen_at: snap.frozen_at, snapshot_hash: snap.snapshot_hash, count: snap.count },
      inputs: R.log, by_sport: bySport, build_summary: b.sports,
      capability_matrix: EDPROJ.capabilityMatrix(b, { now, captured_sports: ['americanfootball_nfl', 'americanfootball_ncaaf', 'mma_mixed_martial_arts', 'baseball_mlb'] }),
      projections: snap.projections
    },
    ledger: snap.projections.map(ledgerLine)
  };
}
/** Append the lines whose projection hash is not already in this month's ledger. */
function appendLedger(lines, now, dir) {
  dir = dir || LEDGER_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, new Date(now).toISOString().slice(0, 7) + '.jsonl');
  const have = new Set();
  if (fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach((l) => { if (!l.trim()) return; try { have.add(JSON.parse(l).projection_hash); } catch (_) { /* a bad line stays, it is not rewritten */ } });
  const add = lines.filter((x) => !have.has(x.projection_hash));
  if (add.length) fs.appendFileSync(file, add.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { file: path.relative(ROOT, file), appended: add.length, already: lines.length - add.length };
}

function main() {
  const args = process.argv.slice(2);
  const ni = args.indexOf('--now');
  const now = ni >= 0 ? Date.parse(args[ni + 1]) : Date.now();
  const r = build({ now });
  const a = r.artifact;
  if (!a.snapshot.count && a.inputs.every((x) => !x.ok)) { console.error('no engine artifact could be read: nothing built'); process.exit(2); }
  console.log('projections: ' + a.snapshot.count + ' frozen (' + Object.entries(a.by_sport).map(([k, v]) => k + ' ' + v.projections).join(', ') + '), snapshot ' + a.snapshot.snapshot_hash.slice(0, 16));
  Object.entries(a.build_summary).forEach(([k, v]) => { if (v.blocker) console.log('  ' + k + ': ' + v.blocker); });
  if (args.includes('--check')) {
    if (!fs.existsSync(OUT)) { console.log('CHECK: engine/projections.json not present'); process.exit(1); }
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const same = cur.snapshot && cur.snapshot.count === a.snapshot.count && JSON.stringify(cur.projections.map((p) => p.projection_id)) === JSON.stringify(a.projections.map((p) => p.projection_id));
    console.log(same ? 'CHECK: the same projections are on file' : 'CHECK: the projections differ from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(OUT, JSON.stringify(a) + '\n');
  const l = appendLedger(r.ledger, now);
  console.log('wrote engine/projections.json (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB); ledger ' + l.file + ': ' + l.appended + ' new, ' + l.already + ' already on record');
}
module.exports = { build, appendLedger, makeReader, ledgerLine, SCHEMA, OUT };
if (require.main === module) main();
