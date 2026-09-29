#!/usr/bin/env node
/* ===========================================================================
   THE PLAYER-PROP DATA FACTORY — the history, identity, features and
   validated models under the Player Props terminal (docs/player-props/
   FACTORY.md). config/pipeline_jobs.json lists the jobs.

     node football/props/factory/run.js history   [--league nfl|cfb] [--offline] [--deep-cfb]
     node football/props/factory/run.js backtest  [--league …] [--last-n 3] [--all-folds]
     node football/props/factory/run.js summarize [--league …]
     node football/props/factory/run.js train     [--league …] [--force]
     node football/props/factory/run.js project   [--league …] [--window-h 192] [--now ISO]
     node football/props/factory/run.js backfill  --network [--league …] [--from 2023-09-01] [--to …] [--max-games 25]
     node football/props/factory/run.js sync      [--league …]            (needs SUPABASE_DB_URL)

   `project` is the hand-off: the champion models' distributions for every
   upcoming game → football/props/factory/<league>/projections.json, which
   the terminal's board build joins by its own ids. Live prices, decisions,
   grading and the page are the terminal's (football/props/*.js); the factory
   never captures a live quote and never publishes a price.

   Every stage is idempotent: history reuses completed seasons, train never
   rewrites a model version that exists, project writes only when a
   projection changed (the prediction ledger is change-only), sync loads on
   natural keys. Nothing here assumes a credential.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const io = require('./lib/io.js');
const warehouse = require('./warehouse.js');
const identity = require('./identity.js');
const F = require('./features.js');
const M = require('./model.js');
const BT = require('./backtest.js');
const S = require('./score.js');
const O = require('./odds.js');
const X = require('./export.js');
const { writeIfChanged } = require('../../../tools/football/write_if_changed.js');

const MODELS = path.join(__dirname, 'models');
const VALID = path.join(__dirname, 'validation');
const RECIPE = 'v1';

function log(m) { console.log('[props factory] ' + m); }
const STATUS_SCHEMA = 'edgedesk_props_factory_status_v1';
function writeStatus(status) {
  const f = path.join(__dirname, 'status.json');
  const prev = io.readJson(f, { schema: STATUS_SCHEMA, stages: {} });
  return writeIfChanged(f, Object.assign({}, prev, status, { schema: STATUS_SCHEMA, stages: Object.assign({}, prev.stages || {}, status.stages || {}) }), { pretty: true, newline: true });
}
function leaguesOf(a) { const l = a.league ? [String(a.league).toUpperCase()] : ['NFL', 'CFB']; l.forEach((x) => { if (x !== 'NFL' && x !== 'CFB') throw new Error('league must be nfl or cfb'); }); return l; }
function sha(o) { return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex'); }

/* ------------------------------------------------------------ registry */
function registryPath() { return path.join(MODELS, 'registry.json'); }
function loadRegistry() { return io.readJson(registryPath(), { schema: 'edgedesk_props_model_registry_v1', models: [] }); }
function loadModels(league) {
  const reg = loadRegistry();
  const byKey = {};
  const tiers = {};
  reg.models.filter((m) => m.league === league && m.status === 'CHAMPION').forEach((m) => {
    const mod = io.readJson(path.join(MODELS, league.toLowerCase(), m.model_version + '.json'));
    if (!mod) return;
    mod.use_recalibration = m.use_recalibration !== false;
    byKey[m.position_group + '|' + m.market_key] = mod;
    tiers[m.position_group + '|' + m.market_key] = { outcome_tier: m.outcome_tier || 'RESEARCH', market_tier: m.market_tier || 'RESEARCH', calibration_score: m.calibration_score == null ? null : m.calibration_score };
  });
  return { byKey, tiers, registry: reg };
}

/* ------------------------------------------------------------ stages */
async function stageHistory(a) {
  const wh = await warehouse.build({ leagues: a.leagues, offline: a.offline, deepCfb: a.deepCfb, log });
  identity.savePins(wh.identity.pins, wh.identity.merges);
  writeIfChanged(path.join(__dirname, 'identity', 'review_queue.json'), { schema: 'edgedesk_props_identity_review_v1', generated_at: wh.built_at,
    rule: 'A person reviews each row: link it in overrides.json (with the evidence), or leave it unlinked. Name-only rows are never linked automatically.',
    quarantined: wh.identity.quarantine, review: wh.identity.review,
    needs_review_links: wh.identity.bridge.filter((b) => b.needs_review) }, { pretty: true, newline: true });
  const coverage = { schema: 'edgedesk_props_coverage_v1', generated_at: wh.built_at, adapter_version: wh.adapter_version, identity: wh.identity.stats, leagues: {} };
  Object.keys(wh.leagues).forEach((lg) => { const L = wh.leagues[lg]; coverage.leagues[lg] = { seasons: L.coverage, qa: L.qa, games: L.games.length, player_games: L.playerGames.length, team_games: L.teamGames.length }; });
  coverage.quarantine_by_rule = wh.quarantine.reduce((m, q) => { m[q.rule_id] = (m[q.rule_id] || 0) + 1; return m; }, {});
  writeIfChanged(path.join(__dirname, 'coverage.json'), coverage, { pretty: true, newline: true });
  return wh;
}

async function stageTrain(wh, a) {
  const reg = loadRegistry();
  const cur = io.currentSeason(a.now);
  const bt = {};
  a.leagues.forEach((lg) => { bt[lg] = io.readJson(path.join(VALID, 'outcome_' + lg.toLowerCase() + '.json')); });
  for (const lg of a.leagues) {
    const hist = a.hist && a.hist[lg] ? a.hist[lg] : F.buildHistorical(wh, lg);
    /* the live season is the holdout: production trains through the last completed season */
    const trainTo = cur - 1;
    const rows = hist.rows.filter((x) => x.season <= trainTo);
    const summary = bt[lg] && bt[lg].summary ? new Map(bt[lg].summary.map((s) => [s.position_group + '|' + s.market_key, s])) : new Map();
    for (const pg of ['QB', 'RB', 'WR', 'TE']) {
      for (const market of M.marketsFor(lg, pg)) {
        const version = M.modelName(lg, pg, market, RECIPE) + '.' + trainTo;
        const fileP = path.join(MODELS, lg.toLowerCase(), version + '.json');
        const exists = fs.existsSync(fileP);
        let mod = exists && !a.force ? io.readJson(fileP) : null;
        if (!mod) {
          const t0 = Date.now();
          const res = M.trainOne(rows, { league: lg, pg, market, version: RECIPE + '.' + trainTo, now: new Date().toISOString() });
          if (res.skipped) { log(lg + ' ' + pg + ' ' + market + ': skipped (' + res.skipped + ')'); continue; }
          mod = res.model; mod.model_version = version;
          io.writeJson(fileP, mod);
          log('trained ' + version + ' n=' + mod.training.n_rows + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
        }
        const s = summary.get(pg + '|' + market) || {};
        /* GOVERNANCE: a model that lost to the naive composite out of sample in
           the walk-forward is registered as a CANDIDATE and never scored; with no
           walk-forward on file at all it is a CANDIDATE too */
        const beatsBaseline = s.folds > 0 && s.mean_mae_skill != null && s.mean_mae_skill > 0;
        const entry = { model_version: version, model_name: mod.model_name, league: lg, position_group: pg, market_key: market, family: mod.family, algorithm: mod.algorithm,
          feature_version: mod.feature_version, training_seasons: mod.training.seasons, training_cutoff: mod.training.cutoff, trained_at: mod.training.trained_at, n_rows: mod.training.n_rows,
          sha256: sha(mod), status: beatsBaseline ? 'CHAMPION' : 'CANDIDATE',
          status_reason: beatsBaseline ? 'positive out-of-sample skill in the walk-forward' : (s.folds ? 'lost to the naive composite out of sample (mean skill ' + s.mean_mae_skill + ')' : 'no walk-forward validation on file'),
          use_recalibration: s.use_recalibration !== false, outcome_tier: s.outcome_tier || 'RESEARCH', market_tier: 'RESEARCH',
          calibration_score: s.mean_pit_max_abs_dev != null ? Math.max(0, Math.min(1, 1 - s.mean_pit_max_abs_dev / 0.08)) : null,
          walk_forward: s.folds ? { folds: s.folds, mean_mae_skill: s.mean_mae_skill, min_mae_skill: s.min_mae_skill, mean_coverage_80: s.mean_coverage_80, mean_pit_max_abs_dev: s.mean_pit_max_abs_dev, mean_brier: s.mean_brier } : null };
        /* a model version is immutable: an older champion for the same slot is retired, never rewritten */
        if (entry.status === 'CHAMPION') reg.models.forEach((m) => { if (m.league === lg && m.position_group === pg && m.market_key === market && m.model_version !== version && m.status === 'CHAMPION') { m.status = 'RETIRED'; m.retired_at = new Date().toISOString(); } });
        const i = reg.models.findIndex((m) => m.model_version === version);
        if (i >= 0) { const prev = reg.models[i]; if (prev.sha256 !== entry.sha256 && !a.force) throw new Error('model ' + version + ' changed on disk: versions are immutable'); reg.models[i] = Object.assign({}, prev, entry); }
        else reg.models.push(entry);
      }
    }
  }
  reg.models.sort((x, y) => (x.model_version < y.model_version ? -1 : 1));
  reg.generated_at = new Date().toISOString();
  reg.rule = 'One model per league x position x market. A version is immutable; a retrain is a new version and the old one is RETIRED, never rewritten. Predictions name the version that produced them.';
  io.writeJson(registryPath(), reg, true);
  return reg;
}

async function stageBacktest(wh, a) {
  const out = {};
  for (const lg of a.leagues) {
    const hist = a.hist && a.hist[lg] ? a.hist[lg] : F.buildHistorical(wh, lg);
    const res = BT.runOutcome(hist.rows, lg, { lastN: a.allFolds ? null : (a.lastN || 3), log });
    const doc = { schema: 'edgedesk_props_outcome_validation_v1', league: lg, generated_at: new Date().toISOString(), recipe: RECIPE, feature_version: F.FEATURE_VERSION,
      rule: 'Chronological walk-forward folds only. Thresholds used for Brier / log loss are evaluation probes (the player\'s pregame composite, rounded to the half point), never sportsbook lines.',
      summary: res.summary, folds: res.folds.map((f) => Object.assign({}, f, { models: f.models.map((m) => Object.assign({}, m, { raw: m.raw ? stripRel(m.raw) : null, recalibrated: m.recalibrated ? stripRel(m.recalibrated) : null })) })) };
    writeIfChanged(path.join(VALID, 'outcome_' + lg.toLowerCase() + '.json'), doc, { pretty: true, newline: true });
    out[lg] = doc;
  }
  /* the market side (edge, CLV, calibration against prices) is the terminal's
     live grading (football/props/grade.js → performance.json, EDProps.stageOf) */
  return out;
}
function stripRel(m) { const o = Object.assign({}, m); if (o.reliability) o.reliability = o.reliability.map((b) => ({ lo: b.lo, n: b.n, p: b.mean_p, hit: b.hit_rate })); return o; }

/* the players the terminal already shows (a posted price or a depth role),
   as factory ids, so each is projected past the factory's own role cap */
function terminalInclude(wh, lg, board) {
  const inc = new Map();
  if (!board || !Array.isArray(board.props)) return inc;
  const res = identity.resolver(wh.identity.idMap);
  board.props.forEach((x) => {
    if (!x.p) return;
    const pid = lg === 'NFL' ? res.nfl(x.p) : 'espn:' + x.p;
    if (!pid) return;
    let st = inc.get(x.g); if (!st) { st = new Set(); inc.set(x.g, st); } st.add(pid);
  });
  return inc;
}
function terminalBoard(lg) { return io.readJson(path.join(__dirname, '..', lg.toLowerCase(), 'board.json')); }

async function stageProject(wh, a) {
  const res = {};
  for (const lg of a.leagues) {
    const models = loadModels(lg);
    if (!Object.keys(models.byKey).length) { log(lg + ': no champion models; run train first'); continue; }
    const board = terminalBoard(lg);
    const scored = S.scoreLeague(wh, lg, models, { now: a.now, windowH: a.windowH, tiers: models.tiers, include: terminalInclude(wh, lg, board) });
    /* the immutable prediction ledger (mirrored to props.model_prediction by
       sync) is CHANGE-ONLY: a prediction identical to the latest one for the
       same game, player, market and model version keeps that prediction's id
       and as-of time instead of minting a copy every run */
    const ledger = path.join(io.CACHE, 'ledger', lg.toLowerCase(), String(scored.season), 'predictions.jsonl');
    const fresh = reconcilePredictions(scored, io.readJsonl(ledger));
    const doc = X.build(scored, models.registry, board);
    const w = X.write(doc);
    if (fresh.length) { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.appendFileSync(ledger, fresh.map((p) => JSON.stringify(p)).join('\n') + '\n'); }
    log(lg + ': projected ' + scored.props.length + ' player-markets across ' + scored.games.length + ' games (' + fresh.length + ' new predictions); ' + doc.n + ' exported for the terminal' + (board ? '' : ' (no terminal board on file: every projection exported)') + ', ' + w);
    res[lg] = scored;
  }
  return res;
}

function predFingerprint(p) { return sha([p.model_version, p.dist, p.sigma_mu == null ? null : p.sigma_mu]).slice(0, 20); }
function reconcilePredictions(scored, ledgerRows) {
  const key = (p) => p.game_id + '|' + p.player_id + '|' + p.market_key + '|' + p.model_version;
  const last = new Map();
  ledgerRows.forEach((x) => { const k = key(x), prev = last.get(k); if (!prev || x.asof_at > prev.asof_at) last.set(k, x); });
  const propById = new Map(scored.props.map((p) => [p.prediction_id, p]));
  const fresh = [];
  scored.predictions.forEach((p) => {
    p.fingerprint = predFingerprint(p);
    const prev = last.get(key(p));
    if (prev && (prev.fingerprint || predFingerprint(prev)) === p.fingerprint) {
      const prop = propById.get(p.prediction_id);
      p.prediction_id = prev.prediction_id; p.asof_at = prev.asof_at; p.scored_at = prev.scored_at;
      if (prop) { prop.prediction_id = prev.prediction_id; prop.as_of = prev.asof_at; }
    } else fresh.push(p);
  });
  return fresh;
}

async function stageSync(wh, a) {
  const db = require('./db.js');
  const s = await db.sync(wh, a);
  /* a skipped mirror is said where the run is read (the log, an annotation,
     the step summary), not failed: the projections are already published */
  if (s && s.skipped) {
    log('database mirror skipped: ' + s.skipped);
    if (process.env.GITHUB_ACTIONS) console.log('::warning title=Props factory database mirror skipped::' + s.skipped);
    if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'Database mirror skipped: ' + s.skipped + '\n'); } catch (_) {} }
  }
  return s;
}

/* ------------------------------------------------------------ main */
function parseArgs(argv) {
  const a = { stage: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--league') { a.league = v; i++; } else if (k === '--offline') a.offline = true; else if (k === '--deep-cfb') a.deepCfb = true;
    else if (k === '--force') a.force = true; else if (k === '--network') a.network = true;
    else if (k === '--last-n') { a.lastN = Number(v); i++; } else if (k === '--all-folds') a.allFolds = true;
    else if (k === '--window-h') { a.windowH = Number(v); i++; } else if (k === '--now') { a.now = Date.parse(v); i++; }
    else if (k === '--from') { a.from = v; i++; } else if (k === '--to') { a.to = v; i++; }
    else if (k === '--max-games') { a.maxGames = Number(v); i++; }
  }
  a.leagues = leaguesOf(a);
  return a;
}

async function main(argv) {
  const a = parseArgs(argv);
  const t0 = Date.now();
  const status = { stages: {} };
  const done = (k, extra) => { status.stages[k] = Object.assign({ at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) }, extra || {}); };
  const STAGES = ['history', 'backtest', 'summarize', 'train', 'project', 'backfill', 'sync', 'all'];
  if (STAGES.indexOf(a.stage) < 0) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n')); if (a.stage !== 'help') process.exitCode = 2; return; }
  if (a.stage === 'summarize') {
    a.leagues.forEach((lg) => {
      const f = path.join(VALID, 'outcome_' + lg.toLowerCase() + '.json');
      const doc = io.readJson(f); if (!doc) return;
      doc.summary = BT.summarize(doc.folds);
      writeIfChanged(f, doc, { pretty: true, newline: true });
      log(lg + ': re-summarised ' + doc.summary.length + ' models from ' + doc.folds.length + ' folds');
    });
    done('summarize'); writeStatus(status);
    return;
  }
  /* the warehouse is needed by every stage; identity needs both leagues' history */
  const whLeagues = a.stage === 'history' ? a.leagues : ['NFL', 'CFB'];
  const wh = a.stage === 'history' ? await stageHistory(Object.assign({}, a, { leagues: whLeagues })) : await warehouse.build({ leagues: whLeagues, offline: a.offline, log: () => {} });
  if (a.stage === 'history') { done('history', { leagues: a.leagues }); writeStatus(status); return; }
  if (a.stage === 'train' || a.stage === 'backtest' || a.stage === 'all') {
    a.hist = {};
    for (const lg of a.leagues) a.hist[lg] = F.buildHistorical(wh, lg);
  }
  if (a.stage === 'backtest') { await stageBacktest(wh, a); done('backtest', { leagues: a.leagues, last_n: a.lastN || 3 }); }
  if (a.stage === 'train' || a.stage === 'all') { const reg = await stageTrain(wh, a); done('train', { champions: reg.models.filter((m) => m.status === 'CHAMPION').length }); }
  if (a.stage === 'backfill') { for (const lg of a.leagues) log('backfill ' + lg + ': ' + JSON.stringify(await O.backfillHistorical(wh, lg, { key: a.network ? process.env.ODDS_API_KEY : null, from: a.from, to: a.to, max_games: a.maxGames }))); done('backfill'); }
  if (a.stage === 'project' || a.stage === 'all') { await stageProject(wh, a); done('project', { leagues: a.leagues }); }
  if (a.stage === 'sync' || (a.stage === 'all' && process.env.SUPABASE_DB_URL)) { const s = await stageSync(wh, a); done('sync', s || {}); }
  writeStatus(Object.assign(status, { generated_at: new Date().toISOString() }));
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('[props factory] failed: ' + (e && e.stack || e)); process.exit(1); });
module.exports = { main, parseArgs, loadModels, loadRegistry, stageTrain, stageBacktest, stageProject, terminalInclude, reconcilePredictions, predFingerprint, RECIPE };
