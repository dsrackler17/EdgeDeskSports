#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM-EARLY — the Phase 5 backtest: the registered selection on the
   TRAINING windows only (research/registration.json selection_rule).

     node basketball/ncaam_early/backtest.js --select [--out <model_v1 candidate>] [--report <file>]
     node basketball/ncaam_early/backtest.js --holdout      refused until v0.2.0

   What it does, in the registered order:
     1. Windows. Each training season's early-season window: from 1 November
        to 15 December inclusive, US Eastern dates (the first regular-season
        game is inside it; only D-I v D-I finals are scored). Training END
        years 2020, 2022, 2023, 2024, 2025; 2021 is excluded, as registered.
        No 2026 or 2027 game is read: the loader refuses them in --select.
     2. Point in time. Every window game is projected from the finals known
        30 minutes before its tip (project.js, the same code as the live
        record), its preseason prior built from the season before it.
     3. Score. Margin CRPS of the normal N(margin, sd), sd = sqrt(base^2 +
        rating variance). The base margin sd is fitted by maximum likelihood
        on the OTHER training seasons (leave-one-season-out), so no season is
        scored with a constant fitted on itself. The LOSO score of a
        configuration is the mean of the five held-out season means.
     4. Select. Coordinate descent over the `selectable` values of
        config/model_v0.json in the order listed there, two sweeps; a
        candidate replaces the current value only if it lowers the LOSO score
        by >= 0.01. Every configuration scored is kept, in order (the
        registration's forking_paths.candidates_tried). Conviction thresholds
        are not touched.
     5. Fit. Base margin and total sd by maximum likelihood on all five
        training windows with the chosen values.
     6. Write a model_v1 CANDIDATE and a report of aggregate numbers only (no
        CBBD row). Freezing it is a separate, reviewed step: the candidate is
        copied to config/model_v1.json and its sha256 registered as version
        0.2.0, BEFORE the retrospective holdout is scored, once.

   The CBBD data of every training season must be in the raw cache
   (.cache/ncaam_early/raw, filled by the backfill); nothing here calls CBBD.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const FE = require('./features');
const PJ = require('./project');

const TRAINING_SEASONS = [2020, 2022, 2023, 2024, 2025];
const EXCLUDED_SEASONS = [2021];
const FORBIDDEN_IN_SELECTION = [2026, 2027];
const MIN_IMPROVEMENT = 0.01;
const SWEEPS = 2;

/* ── windows ────────────────────────────────────────────────────────────────
   midnight of a US Eastern date, as a UTC instant (DST from the zone rules) */
function easternMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 5);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asUtc - Date.UTC(y, m - 1, d, 0));
}
/** [from, to) of season S's early-season window (S = END year) */
function earlyWindow(S) { return [easternMidnight(S - 1, 11, 1), easternMidnight(S - 1, 12, 16)]; }

/* ── scores ─────────────────────────────────────────────────────────────── */
const SQRT_PI = Math.sqrt(Math.PI);
const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
function Phi(z) {
  const s = z < 0 ? -1 : 1, x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + s * y);
}
/** CRPS of N(mu, sd) at y (Gneiting & Raftery 2007) */
function crpsNormal(y, mu, sd) { const z = (y - mu) / sd; return sd * (z * (2 * Phi(z) - 1) + 2 * phi(z) - 1 / SQRT_PI); }

/** maximum-likelihood base sd: residuals r_i with rating variances v_i,
    sd_i^2 = b^2 + v_i; golden-section search on [lo, hi] */
function fitBaseSd(recs, key, lo, hi) {
  lo = lo == null ? 2 : lo; hi = hi == null ? 40 : hi;
  const nll = (b) => recs.reduce((a, r) => { const s2 = b * b + (r.rating_var || 0); return a + 0.5 * Math.log(s2) + (r[key] * r[key]) / (2 * s2); }, 0);
  const g = (Math.sqrt(5) - 1) / 2; let a = lo, c = hi, x1 = c - g * (c - a), x2 = a + g * (c - a), f1 = nll(x1), f2 = nll(x2);
  for (let i = 0; i < 80; i++) { if (f1 < f2) { c = x2; x2 = x1; f2 = f1; x1 = c - g * (c - a); f1 = nll(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (c - a); f2 = nll(x2); } }
  return (a + c) / 2;
}

/* ── configurations ────────────────────────────────────────────────────── */
/** the selectable values of a config, in the order the file lists them */
function selectables(cfg) {
  const out = [];
  (function walk(o, p) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    if (Array.isArray(o.selectable) && 'value' in o) { out.push({ path: p, value: o.value, candidates: o.selectable.slice() }); return; }
    for (const k of Object.keys(o)) if (k !== '_sha256') walk(o[k], p ? p + '.' + k : k);
  })(cfg, '');
  return out;
}
function withValues(cfg, values) {
  const c = JSON.parse(JSON.stringify(cfg));
  for (const [p, val] of Object.entries(values)) {
    const node = p.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
    if (!node || !Array.isArray(node.selectable) || !node.selectable.includes(val)) throw new Error('not a registered candidate: ' + p + ' = ' + val);
    node.value = val;
  }
  c._sha256 = cfg._sha256;
  return c;
}
const keyOf = (values) => JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]]));

/* ── one season, one configuration: point-in-time records ────────────────
   load(S, cfg) -> { priors, features, finals, league } (seasonInputs) */
function seasonRecords(S, cfg, load) {
  if (!TRAINING_SEASONS.includes(S)) throw new Error('season ' + S + ' is not a training season');
  const x = load(S, cfg);
  const [from, to] = earlyWindow(S);
  const targets = x.finals.filter((f) => f.start_ms >= from && f.start_ms < to)
    .map((f) => ({ game_id: String(f.game_id), season: S, home_team_id: f.home, away_team_id: f.away, neutral: f.neutral === true, start_utc: new Date(f.start_ms).toISOString(), _f: f }));
  const byId = new Map(targets.map((t) => [t.game_id, t._f]));
  const rows = PJ.projectGames(targets, { priors: x.priors, finals: x.finals, league: x.league, features: x.features }, cfg, { projection: true });
  const recs = [];
  let notProjected = 0;
  for (const r of rows) {
    if (r.status !== 'PROJECTED') { notProjected++; continue; }
    const f = byId.get(String(r.game_id)), p = r._projection;
    const actualMargin = f.hs != null ? f.hs - f.as : ((f.yH - f.yA) * f.poss) / 100;
    const actualTotal = f.hs != null ? f.hs + f.as : ((f.yH + f.yA) * f.poss) / 100;
    recs.push({ season: S, game_id: String(r.game_id), margin: p.margin, total: p.total, rating_var: p.rating_var || 0, resid_margin: actualMargin - p.margin, resid_total: actualTotal - p.total,
      finals_used: r.finals_used, start_ms: Date.parse(r.start_utc) });
  }
  return { recs, games: targets.length, not_projected: notProjected };
}

/** LOSO margin CRPS of a configuration */
function losoScore(bySeason) {
  const per = {};
  for (const h of Object.keys(bySeason)) {
    const train = Object.keys(bySeason).filter((s) => s !== h).flatMap((s) => bySeason[s].recs);
    const b = fitBaseSd(train, 'resid_margin');
    const test = bySeason[h].recs;
    per[h] = { n: test.length, base_margin_sd: b, crps: test.length ? test.reduce((a, r) => a + crpsNormal(r.resid_margin, 0, Math.sqrt(b * b + r.rating_var)), 0) / test.length : null };
  }
  const vals = Object.values(per).map((p) => p.crps).filter((x) => x != null);
  return { score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, per_season: per };
}

/** the registered selection. load(S, cfg) gives a season's inputs; it is
    never asked for a season outside the training list */
function select(baseCfg, load, o) {
  o = o || {};
  const seasons = o.seasons || TRAINING_SEASONS;
  for (const S of seasons) if (!TRAINING_SEASONS.includes(S)) throw new Error('selection reads training seasons only; ' + S + ' is not one');
  const guarded = (S, cfg) => { if (!TRAINING_SEASONS.includes(S) || FORBIDDEN_IN_SELECTION.includes(S)) throw new Error('selection may not read season ' + S); return load(S, cfg); };
  const sel = selectables(baseCfg);
  const cur = Object.fromEntries(sel.map((s) => [s.path, s.value]));
  const tried = []; const cache = new Map();
  const evaluate = (values) => {
    const k = keyOf(values);
    if (cache.has(k)) return cache.get(k);
    const cfg = withValues(baseCfg, values);
    const bySeason = {};
    for (const S of seasons) bySeason[S] = seasonRecords(S, cfg, guarded);
    const L = losoScore(bySeason);
    const res = { values: Object.assign({}, values), score: L.score, per_season: L.per_season, bySeason };
    cache.set(k, res);
    tried.push({ order: tried.length + 1, values: Object.assign({}, values), loso_margin_crps: L.score,
      per_season: Object.fromEntries(Object.entries(L.per_season).map(([s, p]) => [s, { n: p.n, crps: p.crps, base_margin_sd: p.base_margin_sd }])) });
    return res;
  };
  let best = evaluate(cur);
  const steps = [];
  for (let sweep = 1; sweep <= SWEEPS; sweep++) {
    for (const s of sel) {
      let cand = null;
      for (const v of s.candidates) {
        if (v === best.values[s.path]) continue;
        const r = evaluate(Object.assign({}, best.values, { [s.path]: v }));
        if (r.score != null && (cand == null || r.score < cand.score)) cand = r;
      }
      const accepted = !!(cand && best.score != null && best.score - cand.score >= MIN_IMPROVEMENT);
      steps.push({ sweep, path: s.path, from: best.values[s.path], best_candidate: cand ? cand.values[s.path] : null, current_score: best.score, candidate_score: cand ? cand.score : null, accepted });
      if (accepted) best = cand;
    }
  }
  /* the base sds with the chosen values, on all training windows */
  const all = seasons.flatMap((S) => best.bySeason[S].recs);
  const baseMargin = fitBaseSd(all, 'resid_margin'), baseTotal = fitBaseSd(all, 'resid_total');
  return { chosen: best.values, loso_margin_crps: best.score, per_season: best.per_season, steps, candidates_tried: tried,
    fitted: { base_margin_sd: baseMargin, base_total_sd: baseTotal, games: all.length },
    games_by_season: Object.fromEntries(seasons.map((S) => [S, { scored: best.bySeason[S].recs.length, in_window: best.bySeason[S].games, not_projected: best.bySeason[S].not_projected }])) };
}

/** the model_v1 candidate: model_v0 with the chosen values and fitted sds */
function candidateConfig(v0, result, meta) {
  const c = withValues(v0, result.chosen);
  delete c._sha256;
  c.config_version = '1.0.0-candidate';
  c.game_projection.base_margin_sd.value = Math.round(result.fitted.base_margin_sd * 1000) / 1000;
  c.game_projection.base_total_sd.value = Math.round(result.fitted.base_total_sd * 1000) / 1000;
  c.selection = { from_config_sha256: v0._sha256, rule: 'research/registration.json selection_rule', training_seasons: TRAINING_SEASONS, excluded_seasons: EXCLUDED_SEASONS,
    chosen: result.chosen, loso_margin_crps: result.loso_margin_crps, games: result.fitted.games, candidates_tried: result.candidates_tried.length,
    note: 'A CANDIDATE: freezing it means copying it to config/model_v1.json and registering its sha256 as version 0.2.0 in a reviewed pull request, before the retrospective holdout is scored once.',
    ran_at: meta && meta.ran_at, code_sha: meta && meta.code_sha };
  return c;
}

/** the retrospective holdout: only with a frozen, registered model_v1 */
function holdoutAllowed(reg, v1Path) {
  const why = [];
  const [maj, min] = String(reg.version || '0.0.0').split('.').map(Number);
  if (!(maj > 0 || min >= 2)) why.push('the registration is version ' + reg.version + '; the holdout needs 0.2.0 with config/model_v1.json registered');
  if (!fs.existsSync(v1Path)) why.push('config/model_v1.json does not exist (the selection is not frozen)');
  else {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(v1Path)).digest('hex');
    const regSha = reg.spec && (reg.spec.config_v1_sha256 || reg.spec.frozen_config_sha256);
    if (!regSha || regSha !== sha) why.push('config/model_v1.json is not the registered configuration (sha256 ' + sha.slice(0, 12) + ')');
  }
  if (reg.retrospective_holdout_scored_at) why.push('the retrospective holdout was already scored at ' + reg.retrospective_holdout_scored_at + '; it is scored once');
  return { allowed: why.length === 0, why };
}

/* the report: aggregate numbers only, never a data row */
function report(result, meta) {
  return { schema: 'edgedesk_ncaam_early_selection_report_v1', model_id: C.MODEL_ID, kind: 'TRAINING WINDOWS ONLY (no holdout season was read)', ran_at: meta.ran_at, code_sha: meta.code_sha,
    config_v0_sha256: meta.config_sha256, training_seasons: TRAINING_SEASONS, excluded_seasons: EXCLUDED_SEASONS, windows: Object.fromEntries(TRAINING_SEASONS.map((S) => [S, earlyWindow(S).map((x) => new Date(x).toISOString())])),
    score: 'leave-one-season-out mean margin CRPS (points); base margin sd fitted by maximum likelihood on the other seasons', min_improvement: MIN_IMPROVEMENT, sweeps: SWEEPS,
    chosen: result.chosen, loso_margin_crps: result.loso_margin_crps, per_season: result.per_season, fitted: result.fitted, games_by_season: result.games_by_season, steps: result.steps,
    candidates_tried: result.candidates_tried };
}

module.exports = { TRAINING_SEASONS, EXCLUDED_SEASONS, MIN_IMPROVEMENT, easternMidnight, earlyWindow, crpsNormal, fitBaseSd, selectables, withValues, seasonRecords, losoScore, select, candidateConfig, holdoutAllowed, report };

if (require.main === module) {
  const a = process.argv.slice(2); const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const reg = JSON.parse(fs.readFileSync(path.join(C.PATHS.BASE, 'research', 'registration.json'), 'utf8'));
  if (a.includes('--holdout')) {
    const h = holdoutAllowed(reg, path.join(C.PATHS.BASE, 'config', 'model_v1.json'));
    if (!h.allowed) { console.error('[ncaam_early backtest] the retrospective holdout is REFUSED:\n  - ' + h.why.join('\n  - ')); process.exit(2); }
    console.error('[ncaam_early backtest] the holdout scorer is built in a later pull request'); process.exit(2);
  }
  if (!a.includes('--select')) { console.error('usage: backtest.js --select [--out file] [--report file] | --holdout'); process.exit(2); }
  const ING = require('./ingest');
  const v0 = FE.loadConfig();
  const ctx = { now: new Date().toISOString(), games: new Map(), offline: true, ratingStates: null, dataset: null };
  /* the engine's season-end states through the last training season's prior
     season (a sequential walk: a season's state reads no later season) */
  ctx.states = require('./ratings').seasonStates(Array.from({ length: Math.max(...TRAINING_SEASONS) - 1 - 2010 + 1 }, (_, i) => 2010 + i));
  const load = (S, cfg) => ING.seasonInputs(S, ctx, cfg);
  let code = null; try { code = require('child_process').execSync('git rev-parse HEAD', { cwd: C.ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (_) { /* no git */ }
  const meta = { ran_at: ctx.now, code_sha: code, config_sha256: v0._sha256 };
  const t0 = Date.now();
  const res = select(v0, load);
  const out = val('--out') || path.join(C.PATHS.cache, 'backtest', 'model_v1.candidate.json');
  const rep = val('--report') || path.join(C.PATHS.cache, 'backtest', 'selection_report.json');
  for (const f of [out, rep]) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(candidateConfig(v0, res, meta), null, 2) + '\n');
  fs.writeFileSync(rep, JSON.stringify(report(res, meta), null, 1) + '\n');
  console.log('[ncaam_early backtest] ' + res.candidates_tried.length + ' configurations scored in ' + Math.round((Date.now() - t0) / 1000) + ' s; chosen ' + JSON.stringify(res.chosen)
    + '; LOSO margin CRPS ' + (res.loso_margin_crps == null ? 'n/a' : res.loso_margin_crps.toFixed(4)) + '; base sd margin ' + res.fitted.base_margin_sd.toFixed(2) + ', total ' + res.fitted.base_total_sd.toFixed(2)
    + '\n  candidate ' + path.relative(C.ROOT, out) + '\n  report    ' + path.relative(C.ROOT, rep));
}
