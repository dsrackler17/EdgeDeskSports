#!/usr/bin/env node
/* ============================================================================
   FSIE — the one command line for the Football Situational Intelligence Engine.

     node football/situational/run.js ingest      [--sport nfl|cfb|all] [--season Y] [--backfill A-B] [--force] [--offline]
     node football/situational/run.js walkforward --sport nfl|cfb          validation folds only; never the holdout
     node football/situational/run.js freeze                               freeze research/preregistration.json (once)
     node football/situational/run.js holdout     --sport nfl|cfb          the one-look holdout (refuses a second look)
     node football/situational/run.js fit         --sport nfl|cfb          production parameters (after the holdout)
     node football/situational/run.js posthoc     --sport nfl|cfb          labelled post-hoc diagnostics (after the holdout)
     node football/situational/run.js study       --sport nfl|cfb [--season Y]   prop-market study and CLV
     node football/situational/run.js build       [--sport all] [--season Y] [--now ISO] [--offline]
                                                  ingest -> quality -> tendencies -> projections -> market ->
                                                  shadow -> cards; writes football/situational/data/
   Every stage logs one JSON line per event to stderr; `build` records its
   stage timings, freshness and errors in data/state.json.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('./core/util.js');
const I = require('./core/ingest.js');
const R = require('./core/research.js');
const PL = require('./core/pipeline.js');
const MS = require('./core/market_study.js');
const SS = require('./simulator_shadow.js');
const CARDS = require('./core/cards.js');

const DIR = __dirname;
const DATA = path.join(DIR, 'data');

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) { const k = x.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; a[k] = v; }
    else a._.push(x);
  }
  return a;
}
function sports(a) { return !a.sport || a.sport === 'all' ? ['nfl', 'cfb'] : [a.sport]; }
function currentSeason(now) { const d = new Date(now || Date.now()); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
function log(ev, data) { process.stderr.write(JSON.stringify(Object.assign({ at: new Date().toISOString(), component: 'fsie.run', event: ev }, data || {})) + '\n'); }

/* write-once JSONL: append rows whose key is not already present */
function appendOnce(file, rows, keyFn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seen = new Set();
  if (fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach((l) => { if (!l.trim()) return; try { seen.add(keyFn(JSON.parse(l))); } catch (_) { /* a bad line is left for verify to report */ } });
  const add = rows.filter((r) => { const k = keyFn(r); if (seen.has(k)) return false; seen.add(k); return true; });
  if (add.length) fs.appendFileSync(file, add.map((r) => JSON.stringify(U.sortKeys(r))).join('\n') + '\n');
  return add.length;
}

async function cmdIngest(a) {
  const season = +a.season || currentSeason(a.now);
  let failed = 0;
  for (const sp of sports(a)) {
    let seasons = [season];
    if (a.backfill) { const [x, y] = String(a.backfill).split('-').map(Number); seasons = []; for (let s = x; s <= y; s++) seasons.push(s); }
    const r = await I.backfill(sp, seasons, { current_season: currentSeason(a.now), force: !!a.force, offline: !!a.offline });
    log('ingest_done', r); failed += r.failed;
  }
  return failed ? 1 : 0;
}

async function cmdWalkForward(a) {
  for (const sp of sports(a)) {
    const w = await R.walkForward(sp, { draws: +a.draws || 600, player_draws: +a.player_draws || 300 });
    w.code = R.codeFingerprint();
    U.writeJson(path.join(DIR, 'research', 'walkforward_' + sp + '.json'), w);
    log('walkforward_written', { sport: sp, rows: w.n_rows, phi: w.interval.chosen_phi, kappa: w.player_interval.chosen });
  }
  return 0;
}

function cmdFreeze() {
  const p = R.prereg();
  if (p.status === 'frozen') { log('freeze_refused', { why: 'already frozen at ' + p.frozen_at }); return 1; }
  p.code_fingerprint = R.codeFingerprint();
  p.frozen_at = new Date().toISOString();
  p.status = 'frozen';
  p.content_sha256 = R.preregContentSha(p);
  U.writeJson(R.PREREG, p);
  log('frozen', { content_sha256: p.content_sha256, code_sha256: p.code_fingerprint.sha256 });
  return 0;
}

async function cmdHoldout(a) {
  for (const sp of sports(a)) {
    const r = await R.holdout(sp, { draws: +a.draws || 1000 });
    log('holdout_written', { sport: sp, team_passed: r.criteria.team_passed, player_passed: r.criteria.player_passed });
  }
  return 0;
}
async function cmdFit(a) {
  for (const sp of sports(a)) { const p = await R.productionFit(sp, { now: a.now }); log('params_written', { sport: sp, model_version: p.model_version, fitted_on: p.fitted_on }); }
  return 0;
}
async function cmdPosthoc(a) {
  const PH = require('./core/posthoc.js');
  for (const sp of sports(a)) {
    const r = await PH.intervalVariant(sp, { now: a.now, draws: +a.draws || 1000 });
    log('posthoc_written', { sport: sp, reproduces_record: r.recorded_reproduced_by_the_formation_column });
  }
  return 0;
}
async function cmdStudy(a) {
  const season = +a.season || currentSeason(a.now);
  for (const sp of sports(a)) {
    const P = U.readJson(path.join(DIR, 'research', 'params_' + sp + '.json'));
    if (!P) { log('study_refused', { sport: sp, why: 'no production parameters' }); return 1; }
    const s = await MS.study(sp, season, P, { now: a.now, draws: +a.draws || 1500 });
    U.writeJson(path.join(DATA, 'market', sp + '_' + season + '_study.json'), s);
    log('study_written', { sport: sp, comparisons: s.comparisons, exclusions: s.exclusions });
  }
  return 0;
}

/* ------------------------------------------------------------------ build */
async function cmdBuild(a) {
  const now = a.now || new Date().toISOString();
  const season = +a.season || currentSeason(now);
  const state = U.readJson(path.join(DATA, 'state.json'), { schema: 'edgedesk_fsie_state_v1', runs: [] });
  const run = { run_id: 'fsie_' + now.replace(/[^0-9]/g, '').slice(0, 14), started_at: now, season, stages: {}, errors: [] };
  const built = {}; const coverage = {};
  for (const sp of sports(a)) {
    let r;
    try { r = await PL.buildSport(sp, { season, now, offline: !!a.offline, draws: +a.draws || 4000 }); }
    catch (e) { run.errors.push({ sport: sp, error: String(e && e.stack || e).slice(0, 500) }); log('build_failed', { sport: sp, error: String(e && e.message || e) }); continue; }
    if (!r.ok) { run.errors.push({ sport: sp, stage: r.stage, error: r.error }); continue; }
    built[sp] = r; coverage[sp] = r.coverage;
    run.stages[sp] = Object.assign({}, r.timings, { projections: r.projections.filter((x) => !x.skipped).length, player_projections: r.player_projections.filter((x) => !x.skipped).length, comparisons: r.comparisons.length });
    const sd = path.join(DATA, sp, String(season));
    U.writeJson(path.join(sd, 'tendencies.json'), CARDS.tendencies(sp, r));
    U.writeJson(path.join(sd, 'observations.json'), CARDS.observations(sp, r), { compact: true });
    const keyP = (x) => [x.game_id, x.team, x.model_version, x.inputs_sha256].join('|');
    run.stages[sp].projection_snapshots_added = r.params_present ? appendOnce(path.join(sd, 'projections.jsonl'), r.projections.filter((x) => !x.skipped), keyP) : 0;
    const keyPP = (x) => [x.game_id, x.player_id, x.model_version, U.sha256(x.markets).slice(0, 16), (x.availability || {}).status].join('|');
    run.stages[sp].player_snapshots_added = r.params_present ? appendOnce(path.join(sd, 'player_projections.jsonl'), r.player_projections.filter((x) => !x.skipped).map((x) => { const o = Object.assign({}, x); delete o.share; return o; }), keyPP) : 0;
    const keyC = (x) => [x.game_id, x.player_id, x.market, x.model_version, x.market_at, x.market_line].join('|');
    run.stages[sp].comparisons_added = appendOnce(path.join(sd, 'comparisons.jsonl'), r.comparisons, keyC);
    if (r.params_present) {
      const shadow = CARDS.shadowArtifact(sp, r);
      U.writeJson(path.join(DATA, 'shadow', sp + '.json'), shadow);
      const P = U.readJson(path.join(DIR, 'research', 'params_' + sp + '.json'));
      const ss = SS.run(sp, P, CARDS.rowsByGame(sp, r), { now });
      U.writeJson(path.join(DATA, 'simulator_shadow_' + sp + '.json'), ss);
      run.stages[sp].simulator_shadow_games = Object.keys(ss.games || {}).length;
    }
  }
  U.writeJson(path.join(DATA, 'coverage.json'), CARDS.coverageArtifact(coverage, now));
  U.writeJson(path.join(DATA, 'cards.json'), CARDS.cards(built, { now }), { compact: true });
  run.finished_at = new Date().toISOString();
  run.status = run.errors.length ? (Object.keys(built).length ? 'partial' : 'failed') : 'ok';
  state.runs = (state.runs || []).concat([{ run_id: run.run_id, started_at: run.started_at, status: run.status, stages: run.stages, errors: run.errors }]).slice(-30);
  state.last = { run_id: run.run_id, status: run.status, at: now };
  U.writeJson(path.join(DATA, 'state.json'), state);
  log('build_done', { status: run.status, stages: run.stages, errors: run.errors.length });
  return run.status === 'failed' ? 1 : 0;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const map = { ingest: cmdIngest, walkforward: cmdWalkForward, freeze: cmdFreeze, holdout: cmdHoldout, fit: cmdFit, posthoc: cmdPosthoc, study: cmdStudy, build: cmdBuild };
  if (!map[cmd]) { process.stderr.write('usage: run.js ingest|walkforward|freeze|holdout|fit|posthoc|study|build [options] (see the header)\n'); return 2; }
  return map[cmd](a);
}
if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 1; });
module.exports = { appendOnce, currentSeason, args };
