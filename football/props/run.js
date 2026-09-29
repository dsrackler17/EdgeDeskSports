#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk player props — THE DATA FACTORY (config/pipeline_jobs.json).

     node football/props/run.js history  [--league nfl|cfb] [--offline] [--deep-cfb]
     node football/props/run.js train    [--league …] [--force]
     node football/props/run.js backtest [--league …] [--last-n 3] [--all-folds]
     node football/props/run.js score    [--league …] [--window-h 192] [--now ISO]
     node football/props/run.js capture  --network [--league …] [--alt] [--max-events 16]
     node football/props/run.js backfill --network [--league …] [--from 2023-09-01] [--to …] [--max-games 25]
     node football/props/run.js record   [--league …]
     node football/props/run.js sync     [--league …]            (needs SUPABASE_DB_URL)
     node football/props/run.js all      [--network]

   Every stage is idempotent: history reuses completed seasons, train never
   rewrites a model version that exists, score writes files only when their
   content changed, record never rewrites a frozen entry, sync loads on
   natural keys. Nothing here assumes a credential: a stage that needs one it
   does not have says so and does nothing.
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
const REC = require('./record.js');
const PUB = require('./publish.js');
const { writeIfChanged } = require('../../tools/football/write_if_changed.js');

const MODELS = path.join(__dirname, 'models');
const VALID = path.join(__dirname, 'validation');
const RECIPE = 'v1';

function log(m) { console.log('[props] ' + m); }
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
  io.writeJson(path.join(__dirname, 'identity', 'review_queue.json'), { schema: 'edgedesk_props_identity_review_v1', generated_at: wh.built_at,
    rule: 'A person reviews each row: link it in overrides.json (with the evidence), or leave it unlinked. Name-only rows are never linked automatically.',
    quarantined: wh.identity.quarantine, review: wh.identity.review,
    needs_review_links: wh.identity.bridge.filter((b) => b.needs_review) }, true);
  const coverage = { schema: 'edgedesk_props_coverage_v1', generated_at: wh.built_at, adapter_version: wh.adapter_version, identity: wh.identity.stats, leagues: {} };
  Object.keys(wh.leagues).forEach((lg) => { const L = wh.leagues[lg]; coverage.leagues[lg] = { seasons: L.coverage, qa: L.qa, games: L.games.length, player_games: L.playerGames.length, team_games: L.teamGames.length }; });
  coverage.quarantine_by_rule = wh.quarantine.reduce((m, q) => { m[q.rule_id] = (m[q.rule_id] || 0) + 1; return m; }, {});
  writeIfChanged(path.join(PUB.OUT, 'coverage.json'), coverage, { pretty: true, newline: true });
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
  /* the market folds: observed quotes only */
  const decisions = [];
  a.leagues.forEach((lg) => { const cur = io.currentSeason(a.now); for (let y = 2023; y <= cur; y++) { const rec = REC.load(lg, y); Object.values(rec.entries).forEach((e) => { if (e.grade && e.grade.status === 'GRADED') decisions.push({ quote: { lineage: e.lineage, sportsbook: e.sportsbook, american_price: e.american }, edge: e.edge, ev: e.ev, confidence: e.confidence, result: e.grade.result, units: e.grade.units_flat, stake: 1, clv: e.grade.clv_price, season: e.season, league: e.league, market_key: e.market_key, position_group: e.position, is_home: e.is_home, model_version: e.model_version }); }); } });
  const mk = BT.runMarket(decisions);
  writeIfChanged(path.join(VALID, 'market.json'), Object.assign({ schema: 'edgedesk_props_market_validation_v1', generated_at: new Date().toISOString() }, mk), { pretty: true, newline: true });
  return out;
}
function stripRel(m) { const o = Object.assign({}, m); if (o.reliability) o.reliability = o.reliability.map((b) => ({ lo: b.lo, n: b.n, p: b.mean_p, hit: b.hit_rate })); return o; }

function quotesFor(lg, a) {
  const cur = io.currentSeason(a.now);
  /* observed quotes only, from the capture ledger: there is deliberately no
     way to score the published board on a fixture (fixture_quotes.js serves the
     UI tests from memory and never writes here) */
  return O.readLedger(lg, cur);
}

async function stageScore(wh, a) {
  const res = {};
  for (const lg of a.leagues) {
    const models = loadModels(lg);
    if (!Object.keys(models.byKey).length) { log(lg + ': no champion models; run train first'); continue; }
    const quotes = quotesFor(lg, a);
    const listings = O.readListings(lg, io.currentSeason(a.now));
    const scored = S.scoreLeague(wh, lg, models, { now: a.now, windowH: a.windowH, quotes, listings, tiers: models.tiers });
    /* the immutable prediction ledger (mirrored to props.model_prediction by
       sync) is CHANGE-ONLY: a prediction identical to the latest one for the
       same game, player, market and model version keeps that prediction's id
       and as-of time instead of minting a copy every run */
    const ledger = path.join(io.CACHE, 'ledger', lg.toLowerCase(), String(scored.season), 'predictions.jsonl');
    const fresh = reconcilePredictions(scored, io.readJsonl(ledger));
    /* what the board states about capture covers the games on it, not the season */
    const onBoard = new Set(scored.games.map((g) => g.game_id));
    const shown = quotes.filter((q) => onBoard.has(q.game_id));
    const nQ = shown.length, lastQ = shown.reduce((m, q) => (q.snapshot_at > m ? q.snapshot_at : m), '');
    const w = PUB.writeBoard(scored, { quotes: { captured: nQ > 0, provider: 'the-odds-api', n_quotes: nQ, last_capture: lastQ || null,
      note: nQ ? 'Observed quotes from The Odds API; every price carries its book and capture time.' : 'No observed sportsbook prop quote has been captured for these games yet: every row shows the model only.' } });
    if (fresh.length) { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.appendFileSync(ledger, fresh.map((p) => JSON.stringify(p)).join('\n') + '\n'); }
    log(lg + ': scored ' + scored.props.length + ' props across ' + scored.games.length + ' games (' + nQ + ' observed quotes, ' + fresh.length + ' new predictions); board ' + w.board + ', ' + w.games + ' cards and ' + w.markets + ' market files written');
    res[lg] = scored;
  }
  return res;
}

function predFingerprint(p) { return sha([p.model_version, p.dist, p.sigma_mu == null ? null : p.sigma_mu]).slice(0, 20); }
function reconcilePredictions(scored, ledgerRows) {
  const key = (p) => p.game_id + '|' + p.player_id + '|' + p.market_key + '|' + p.model_version;
  const last = new Map();
  ledgerRows.forEach((x) => { const k = key(x), prev = last.get(k); if (!prev || x.asof_at > prev.asof_at) last.set(k, x); });
  const propById = new Map(scored.props.map((p) => [p.model.prediction_id, p]));
  const fresh = [];
  scored.predictions.forEach((p) => {
    p.fingerprint = predFingerprint(p);
    const prev = last.get(key(p));
    if (prev && (prev.fingerprint || predFingerprint(prev)) === p.fingerprint) {
      const prop = propById.get(p.prediction_id);
      p.prediction_id = prev.prediction_id; p.asof_at = prev.asof_at; p.scored_at = prev.scored_at;
      if (prop) { prop.model.prediction_id = prev.prediction_id; prop.model.scored_at = prev.scored_at; prop.as_of = prev.asof_at; }
    } else fresh.push(p);
  });
  return fresh;
}

async function stageCapture(wh, a) {
  const out = {};
  for (const lg of a.leagues) out[lg] = await O.capture(wh, lg, { key: a.network ? process.env.ODDS_API_KEY : null, alt: a.alt, max_events: a.maxEvents, force: a.force, now: a.now });
  Object.keys(out).forEach((lg) => { const s = Object.assign({}, out[lg]); delete s.fresh; log('capture ' + lg + ': ' + JSON.stringify(s)); });
  return out;
}

async function stageRecord(wh, scoredBy, a) {
  const cur = io.currentSeason(a.now);
  const recs = [];
  for (const lg of a.leagues) {
    const rec = REC.load(lg, cur);
    if (scoredBy && scoredBy[lg]) { const fr = REC.freeze(scoredBy[lg], { record: rec, now: a.now }); log(lg + ' record: froze ' + fr.added.length + ' new entries'); }
    const n = REC.settle(rec, wh, O.readLedger(lg, cur), { now: a.now });
    rec.generated_at = new Date().toISOString();
    if (Object.keys(rec.entries).length) REC.save(rec);
    log(lg + ' record: ' + Object.keys(rec.entries).length + ' entries, ' + n + ' graded this run');
    recs.push(rec);
  }
  /* every season on file for the summary */
  const all = [];
  if (fs.existsSync(REC.file('nfl', 2000).replace(/nfl_2000\.json$/, ''))) {
    fs.readdirSync(path.dirname(REC.file('nfl', 2000))).filter((n) => /^(nfl|cfb)_\d{4}\.json$/.test(n)).forEach((n) => all.push(io.readJson(path.join(path.dirname(REC.file('nfl', 2000)), n))));
  }
  REC.saveSummary(REC.summarize(all.length ? all : recs));
}

async function stageSync(wh, a) {
  const db = require('./db.js');
  return db.sync(wh, a);
}

/* ------------------------------------------------------------ main */
function parseArgs(argv) {
  const a = { stage: argv[0] || 'help' };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--league') { a.league = v; i++; } else if (k === '--offline') a.offline = true; else if (k === '--deep-cfb') a.deepCfb = true;
    else if (k === '--force') a.force = true; else if (k === '--network') a.network = true; else if (k === '--alt') a.alt = true;
    else if (k === '--last-n') { a.lastN = Number(v); i++; } else if (k === '--all-folds') a.allFolds = true;
    else if (k === '--window-h') { a.windowH = Number(v); i++; } else if (k === '--now') { a.now = Date.parse(v); i++; }
    else if (k === '--max-events') { a.maxEvents = Number(v); i++; } else if (k === '--from') { a.from = v; i++; } else if (k === '--to') { a.to = v; i++; }
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
  if (a.stage === 'help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n')); return; }
  if (a.stage === 'summarize') {
    a.leagues.forEach((lg) => {
      const f = path.join(VALID, 'outcome_' + lg.toLowerCase() + '.json');
      const doc = io.readJson(f); if (!doc) return;
      doc.summary = BT.summarize(doc.folds);
      writeIfChanged(f, doc, { pretty: true, newline: true });
      log(lg + ': re-summarised ' + doc.summary.length + ' models from ' + doc.folds.length + ' folds');
    });
    done('summarize'); PUB.writeStatus(status);
    return;
  }
  /* the warehouse is needed by every stage; identity needs both leagues' history */
  const whLeagues = a.stage === 'history' ? a.leagues : ['NFL', 'CFB'];
  const wh = a.stage === 'history' ? await stageHistory(Object.assign({}, a, { leagues: whLeagues })) : await warehouse.build({ leagues: whLeagues, offline: a.offline, log: () => {} });
  if (a.stage === 'history') { done('history', { leagues: a.leagues }); PUB.writeStatus(status); return; }
  if (a.stage === 'train' || a.stage === 'backtest' || a.stage === 'all') {
    a.hist = {};
    for (const lg of a.leagues) a.hist[lg] = F.buildHistorical(wh, lg);
  }
  if (a.stage === 'backtest' || (a.stage === 'all' && a.withBacktest)) { await stageBacktest(wh, a); done('backtest', { leagues: a.leagues, last_n: a.lastN || 3 }); }
  if (a.stage === 'train' || a.stage === 'all') { const reg = await stageTrain(wh, a); done('train', { champions: reg.models.filter((m) => m.status === 'CHAMPION').length }); }
  if (a.stage === 'capture' || (a.stage === 'all' && a.network)) { await stageCapture(wh, a); done('capture', { network: !!a.network }); }
  if (a.stage === 'backfill') { for (const lg of a.leagues) log('backfill ' + lg + ': ' + JSON.stringify(await O.backfillHistorical(wh, lg, { key: a.network ? process.env.ODDS_API_KEY : null, from: a.from, to: a.to, max_games: a.maxGames }))); done('backfill'); }
  let scored = null;
  if (a.stage === 'score' || a.stage === 'record' || a.stage === 'all') { scored = await stageScore(wh, a); done('score', { leagues: a.leagues }); }
  if (a.stage === 'record' || a.stage === 'all') { await stageRecord(wh, scored, a); done('record'); }
  if (a.stage === 'sync' || (a.stage === 'all' && process.env.SUPABASE_DB_URL)) { const s = await stageSync(wh, a); done('sync', s || {}); }
  PUB.writeStatus(Object.assign(status, { generated_at: new Date().toISOString() }));
  log('done in ' + Math.round((Date.now() - t0) / 1000) + 's');
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error('[props] failed: ' + (e && e.stack || e)); process.exit(1); });
module.exports = { main, parseArgs, loadModels, loadRegistry, stageTrain, stageBacktest, stageScore, stageRecord, reconcilePredictions, predFingerprint, RECIPE };
