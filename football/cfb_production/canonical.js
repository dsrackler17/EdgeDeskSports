/* ============================================================================
   CFB production — THE canonical prediction service
   (docs/cfb-production/CANONICAL.md).

   One pathway turns a stored V2 row into the numbers anyone may show:

     pure(row, opts)        the ONLY call of engine.pure() on the production
                            pathway. The row passes the input contract first
                            (football/cfb_production/contract/input_contract.json
                            row_inputs); the engine's projection then passes the
                            numeric sanity and consistency checks (numeric.js).
                            Either failing returns UNAVAILABLE with the reason:
                            never a repaired or default number.
     snapshot(row, opts)    generateCfbPredictionSnapshot(game, model, as_of_ts):
                            the canonical projection record — versions, the
                            engine's numbers, the input and projection hashes,
                            the contract and numeric verdicts, the degraded
                            modes, the fallback level and the public display
                            policy. as_of_ts is required (no clock inside).
     modes(row, ctx)        the degraded modes (brief §47): FULL, NO_PLAYER_DATA,
                            NO_ADVANCED_PBP, QB_UNCERTAIN, MARKET_DEGRADED,
                            FALLBACK_MODEL, from the row's own flags, the weekly
                            engine's modes and the snapshot's evidence.
     resolve(snap, v1)      the declared fallback order of the manifest
                            (fallback_hierarchy): 1 FULL -> 2 DEGRADED ->
                            3 FALLBACK_MODEL (V1) -> 4 UNAVAILABLE.
     display(snap)          what a public page may say (brief §48): a degraded
                            projection shows its mode in words and never its
                            confidence score.

   Every consumer (the Model Lab adapters, the decision shadow, the V2 mirror,
   the V1 board's v2_shadow block, the stored projections report, the app page,
   the AI explanation) reads what this module produced or stored. None of them
   may call engine.pure() / engine.decide() on its own: canonical.test.js scans
   the repository and fails when one does.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const N = require('./numeric.js');

const REPO = path.resolve(__dirname, '..', '..');
const V2DIR = path.join(REPO, 'football', 'cfb_v2');
const CONTRACT_FILE = path.join(__dirname, 'contract', 'input_contract.json');
const SCHEMA = 'cfb_canonical_projection_v1';
const MODES = ['FULL', 'NO_PLAYER_DATA', 'NO_ADVANCED_PBP', 'QB_UNCERTAIN', 'MARKET_DEGRADED', 'FALLBACK_MODEL'];
/* the weekly engine's per-game modes (v2/weekly/project.py MODE_CAPS) -> the canonical names */
const ENGINE_MODE = { DEGRADED_PBP: 'NO_ADVANCED_PBP', DEGRADED_AVAILABILITY: 'NO_PLAYER_DATA', DEGRADED_MARKET: 'MARKET_DEGRADED', FALLBACK: 'FALLBACK_MODEL' };
/* the evidence thresholds are the ones the integrity review already uses
   (football/cfb_lab/integrity.js extremeReview: QB certainty < 70, injury
   certainty < 60) and the weekly engine's PBP quality bound (project.py: 0.9) */
const QB_CERTAIN_MIN = 70, INJURY_CERTAIN_MIN = 60, PBP_QUALITY_MIN = 0.9;
const PUBLIC_LABEL = {
  NO_PLAYER_DATA: 'Limited availability data',
  NO_ADVANCED_PBP: 'Limited play-by-play data',
  QB_UNCERTAIN: 'Quarterback not confirmed',
  MARKET_DEGRADED: 'Market data limited',
  FALLBACK_MODEL: 'Fallback model',
};

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function canonicalJson(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o === undefined ? null : o);
  if (Array.isArray(o)) return '[' + o.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

let CONTRACT = null;
function loadContract(p) {
  if (!p && CONTRACT) return CONTRACT;
  const c = readJson(p || CONTRACT_FILE);
  if (!c || !Array.isArray(c.row_inputs)) throw new Error('no input contract at ' + (p || CONTRACT_FILE) + ': the canonical service refuses to run unchecked');
  if (!p) CONTRACT = c;
  return c;
}

/* An engine with its OWN params in an isolated context (a candidate must never
   see the production params). The default is the production engine. */
const ENGINES = {};
function loadEngine(paramsFile) {
  const pf = paramsFile || path.join(V2DIR, 'params.js');
  if (ENGINES[pf]) return ENGINES[pf];
  const ctx = { console, Math, Date, JSON, isFinite, Number, Object, Array, String, parseFloat };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(pf, 'utf8'), ctx, { filename: pf });
  vm.runInContext(fs.readFileSync(path.join(V2DIR, 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
  ENGINES[pf] = { engine: ctx.EDCfbV2, params: ctx.EDCfbV2Params, params_file: pf, params_sha256: sha(fs.readFileSync(pf)) };
  return ENGINES[pf];
}

/* the production model's stack weights (the artifact, not params.js, which carries none) */
let WEIGHTS = null;
function stackWeights(modelVersion) {
  const c = loadContract();
  if (modelVersion && modelVersion !== c.model_version) return null;
  if (WEIGHTS) return WEIGHTS;
  const A = readJson(path.join(V2DIR, 'artifacts', c.model_version, 'models.json'));
  WEIGHTS = A && A.stack_weights ? A.stack_weights : null;
  return WEIGHTS;
}

/* ------------------------------------------------------------ the row contract */
function kindOk(v, type) {
  if (type === 'number') return isNum(v);
  if (type === 'boolean') return typeof v === 'boolean';
  if (type === 'binary') return v === 0 || v === 1 || v === true || v === false;
  if (type === 'id') return (typeof v === 'string' && v.length > 0) || (isNum(v) && Number.isInteger(v));
  if (type === 'text') return typeof v === 'string' && v.length > 0;
  if (type === 'utc_timestamp') return N.utc(v) !== null;
  if (type === 'object') return v !== null && typeof v === 'object';
  return true;
}
/* returns { version, ok, critical: [...], degrade: [...], decision_inputs_complete } */
function checkRow(row, opts) {
  opts = opts || {};
  const c = opts.contract || loadContract();
  const critical = [], degrade = [];
  if (!row || typeof row !== 'object') return { version: c.version, ok: false, critical: ['no row'], degrade, decision_inputs_complete: false };
  let decisionComplete = true;
  const engMv = opts.model_version || null;
  const foreign = !!(engMv && engMv !== c.model_version);
  for (const f of c.row_inputs) {
    if (f.model_specific && foreign) continue;
    const v = row[f.field];
    const absent = v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
    const add = (msg) => {
      if (f.critical) critical.push(f.field + ': ' + msg);
      else if (f.null_policy === 'ALLOWED' && absent) { /* declared nullable */ }
      else { degrade.push(f.field + ': ' + msg); if (f.decision_input) decisionComplete = false; }
    };
    if (absent) {
      if (f.null_policy === 'ALLOWED') continue;
      add(v === undefined ? 'absent' : 'null');
      continue;
    }
    if (!kindOk(v, f.type)) { add('not ' + f.type + ' (' + JSON.stringify(v).slice(0, 40) + ')'); continue; }
    if (f.range && isNum(v) && (v < f.range[0] || v > f.range[1])) add(v + ' outside [' + f.range[0] + ', ' + f.range[1] + ']');
  }
  /* cross-field rules */
  if (row.home_id != null && String(row.home_id) === String(row.away_id)) critical.push('home_id equals away_id');
  const ko = N.utc(row.kickoff);
  if (ko && N.utc(row.prediction_ts) && Date.parse(row.prediction_ts) > Date.parse(ko)) critical.push('prediction_ts is after kickoff');
  if (ko && N.utc(row.feature_ts) && Date.parse(row.feature_ts) > Date.parse(ko)) critical.push('feature_ts is after kickoff');
  const declared = row.model_version || opts.row_model_version || null;
  if (engMv && declared && declared !== engMv) critical.push('row model_version ' + declared + ' is not ' + engMv + ' (another version\'s row is never run through this engine)');
  const qb = row.qb || {};
  if ((qb.home === null || qb.away === null) && row.qb_missing_any !== 1 && row.qb_missing_any !== true) degrade.push('qb_missing_any: 0 while a quarterback is missing');
  const W = opts.stack_weights === undefined ? stackWeights(engMv) : opts.stack_weights;
  if (W && row.components && isNum(row.ens_pred)) {
    const miss = Object.keys(W).filter((k) => !isNum(row.components[k]));
    if (miss.length) critical.push('components: missing ' + miss.join(', '));
    else {
      const s = Object.keys(W).reduce((a, k) => a + W[k] * row.components[k], 0);
      if (Math.abs(s - row.ens_pred) > N.TOL.ensemble) critical.push('ensemble ' + row.ens_pred + ' is not the weighted components ' + s.toFixed(4));
    }
  }
  return { version: c.version, ok: critical.length === 0, critical, degrade, decision_inputs_complete: decisionComplete };
}

/* what the engine reads from a row (the shadow block, the publication state
   and the build provenance are not inputs): its hash names the inputs */
function inputHash(row, overlays) {
  const r = {};
  Object.keys(row || {}).forEach((k) => { if (k !== 'shadow' && k !== 'state' && k !== 'build' && k !== 'model_mode' && k !== 'model_modes') r[k] = row[k]; });
  return sha(canonicalJson({ row: r, overlays: overlays || {} }));
}

/* ------------------------------------------------------------ pure */
function unavailable(reason, extra) {
  return Object.assign({ status: 'UNAVAILABLE', layer: 'pure_model_projection', reason }, extra || {});
}
function pure(row, opts) {
  opts = opts || {};
  const E = opts.engine ? { engine: opts.engine, params: opts.params || (opts.engine.meta && opts.engine.meta()) } : loadEngine(opts.params_file);
  const mv = (E.params && E.params.model_version) || (opts.engine && opts.engine.meta && (opts.engine.meta() || {}).model_version) || null;
  const contract = checkRow(row, { model_version: mv, stack_weights: opts.stack_weights, row_model_version: opts.row_model_version });
  if (!contract.ok) return unavailable('input contract: ' + contract.critical.slice(0, 3).join('; '), { model_version: mv, game_id: row && row.game_id, contract });
  let p;
  try { p = E.engine.pure(row, opts.overlays || {}); }
  catch (e) { return unavailable('engine threw: ' + String(e && e.message).slice(0, 160), { model_version: mv, game_id: row.game_id, contract }); }
  if (!p || p.status !== 'PREDICTED') return p;
  const problems = N.sanity(p).concat(N.consistency(p, { row, stack_weights: null }));
  if (problems.length) return unavailable('numeric checks: ' + problems.slice(0, 3).join('; '), { model_version: mv, game_id: row.game_id, contract, numeric: problems });
  return p;
}

/* ------------------------------------------------------------ modes */
/* row: the V2 row; ctx: { market_integrity: {status}, qb_certainty, injury_certainty,
   pbp_completeness, availability_status, served: 'V2'|'V1' } */
function modes(row, ctx) {
  ctx = ctx || {};
  const out = [], why = {};
  const add = (m, reason) => { if (out.indexOf(m) < 0) out.push(m); (why[m] = why[m] || []).push(reason); };
  (row && row.model_modes || []).forEach((m) => { if (ENGINE_MODE[m]) add(ENGINE_MODE[m], 'weekly engine mode ' + m); });
  if (row) {
    const qb = row.qb || {};
    if (row.qb_missing_any === 1 || row.qb_missing_any === true || qb.home === null || qb.away === null) add('QB_UNCERTAIN', 'a starting quarterback is unknown to the model');
    else if (row.qb_unsettled_any === 1 || row.qb_unsettled_any === true) add('QB_UNCERTAIN', 'a starting quarterback is unsettled');
  }
  if (isNum(ctx.qb_certainty) && ctx.qb_certainty < QB_CERTAIN_MIN) add('QB_UNCERTAIN', 'quarterback certainty ' + ctx.qb_certainty + ' < ' + QB_CERTAIN_MIN);
  if (isNum(ctx.injury_certainty) && ctx.injury_certainty < INJURY_CERTAIN_MIN) add('NO_PLAYER_DATA', 'availability certainty ' + ctx.injury_certainty + ' < ' + INJURY_CERTAIN_MIN);
  if (ctx.availability_status && ['STALE', 'MISSING', 'DEGRADED', 'DOWN'].indexOf(String(ctx.availability_status)) >= 0) add('NO_PLAYER_DATA', 'availability source ' + ctx.availability_status);
  if (isNum(ctx.pbp_completeness) && ctx.pbp_completeness < PBP_QUALITY_MIN) add('NO_ADVANCED_PBP', 'play-by-play completeness ' + ctx.pbp_completeness + ' < ' + PBP_QUALITY_MIN);
  const mi = ctx.market_integrity;
  if (mi && mi.status && mi.status !== 'OK') add('MARKET_DEGRADED', 'market ' + mi.status + (mi.actionable_status ? ' (' + mi.actionable_status + ')' : ''));
  else if (ctx.market_integrity === null) add('MARKET_DEGRADED', 'no market captured');
  if (ctx.served === 'V1') add('FALLBACK_MODEL', 'V2.1 unavailable: served by the fallback model');
  return shape(out, why);
}
/* ordered, FULL only when nothing else; `football` leaves out MARKET_DEGRADED,
   which never touches the pure number (it gates actionability, not the level) */
function shape(list, why) {
  const ordered = MODES.filter((m) => m !== 'FULL' && list.indexOf(m) >= 0);
  const football = ordered.filter((m) => m !== 'MARKET_DEGRADED');
  return { modes: ordered.length ? ordered : ['FULL'], primary: ordered.length ? ordered[0] : 'FULL', football, reasons: why || {} };
}
function mergeModes(a, b) {
  const all = [].concat(a || [], b || []).filter((m) => m !== 'FULL');
  return shape(all, null);
}

/* ------------------------------------------------------------ display (public) */
function display(snap) {
  if (!snap || snap.status === 'UNAVAILABLE') return { label: 'Prediction unavailable', show_numbers: false, show_confidence_score: false, notes: [] };
  if (snap.status === 'NOT_PRICED') return { label: 'Projected, not priced', show_numbers: true, show_confidence_score: false, notes: [] };
  const ms = (snap.degraded && snap.degraded.modes) || ['FULL'];
  const notes = ms.filter((m) => PUBLIC_LABEL[m]).map((m) => PUBLIC_LABEL[m]);
  const full = !((snap.degraded && snap.degraded.football) || []).length;
  const p = snap.projection || {};
  const pw = isNum(p.home_win_prob) ? Math.max(p.home_win_prob, 1 - p.home_win_prob) : null;
  return {
    label: notes.length ? notes[0] : null,
    notes,
    show_numbers: true,
    /* a degraded projection never shows its confidence score: the words say why (brief §48) */
    show_confidence_score: full,
    /* whole percent at most; a degraded favourite above 85% is said in words, not as a precise number */
    win_probability_text: pw === null ? null : (!full && pw >= 0.85 ? 'strong favourite (' + notes.join(', ').toLowerCase() + ')' : (pw >= 0.995 ? '>99%' : Math.round(100 * pw) + '%')),
  };
}

/* ------------------------------------------------------------ snapshot */
/* generateCfbPredictionSnapshot(row, { as_of_ts (required), engine?, params_file?,
   overlays?, context (modes ctx), source?, model_version? }) */
function snapshot(row, opts) {
  opts = opts || {};
  const asOf = N.requireAsOf(opts);
  const E = opts.engine ? { engine: opts.engine, params: opts.params || null, params_sha256: opts.params_sha256 || null } : loadEngine(opts.params_file);
  const P = E.params || (E.engine.meta && E.engine.meta()) || {};
  const mv = P.model_version || null;
  if (opts.model_version && mv && opts.model_version !== mv) throw new Error('snapshot asked for ' + opts.model_version + ' but the engine is ' + mv);
  const contract = checkRow(row, { model_version: mv, stack_weights: opts.stack_weights, row_model_version: opts.row_model_version });
  const p = pure(row, { engine: E.engine, params: P, overlays: opts.overlays, stack_weights: opts.stack_weights, row_model_version: opts.row_model_version });
  const status = p.status === 'PREDICTED' ? 'PREDICTED' : (p.status === 'NOT_PRICED' ? 'NOT_PRICED' : 'UNAVAILABLE');
  const proj = p.status === 'PREDICTED' ? {
    projected_margin: p.projected_margin, fair_spread_home_line: p.fair_spread_home_line, fair_spread_display: p.fair_spread_display,
    fair_total: p.fair_total, home_win_prob: p.home_win_prob, away_win_prob: p.away_win_prob, home_win_prob_raw: p.home_win_prob_raw,
    sigma: p.sigma, t_df: p.t_df, intervals: p.intervals, football_prediction_confidence: p.football_prediction_confidence,
    confidence_basis: p.confidence_basis, components: p.components, ensemble_sd: p.ensemble_sd, drivers: p.drivers,
    uncertainty_drivers: p.uncertainty_drivers,
    /* the engine's own wording of its drivers (engine.card: text only, no number is made there) */
    why: typeof E.engine.card === 'function' ? E.engine.card(p, null).why : null,
  } : null;
  const dm = status === 'PREDICTED' ? modes(row, opts.context) : { modes: [], primary: null, football: [], reasons: {} };
  const snap = {
    schema: SCHEMA, as_of_ts: asOf, game_id: row && row.game_id != null ? String(row.game_id) : null,
    season: row && row.season, week: row && row.week, home: row && row.home, away: row && row.away,
    home_id: row && row.home_id != null ? String(row.home_id) : null, away_id: row && row.away_id != null ? String(row.away_id) : null,
    kickoff: row && N.utc(row.kickoff), neutral_site: !!(row && row.neutral_site),
    model_version: mv, feature_version: P.feature_version || null, params_sha256: E.params_sha256 || null,
    prediction_ts: row && row.prediction_ts, feature_ts: row && row.feature_ts, row_state: row && row.state || null,
    source: opts.source || null,
    status, reason: status === 'PREDICTED' ? null : (p.reason || null),
    projection: proj,
    contract: { version: contract.version, ok: contract.ok, critical: contract.critical, degrade: contract.degrade, decision_inputs_complete: contract.decision_inputs_complete },
    numeric: { version: N.VERSION, ok: !(p.numeric && p.numeric.length), problems: p.numeric || [], notes: p.status === 'PREDICTED' ? N.roundingNotes(p) : [] },
    degraded: dm,
    fallback_level: status === 'PREDICTED' ? (dm.football.length ? 2 : 1) : (status === 'NOT_PRICED' ? null : 4),
    input_hash: inputHash(row, opts.overlays),
  };
  snap.projection_hash = proj ? sha(canonicalJson(proj)) : null;
  snap.snapshot_id = 'cfbcs_' + sha([snap.game_id, mv, asOf, snap.input_hash].join('|')).slice(0, 24);
  snap.display = display(snap);
  return snap;
}

/* ------------------------------------------------------------ fallback */
function hierarchy() {
  const m = readJson(path.join(__dirname, 'manifest.json'));
  return (m && m.fallback_hierarchy) || null;
}
/* snap: the V2.1 canonical snapshot (or null); v1: { status, margin, p_home,
   model_version } from the V1 board (or null). The manifest's order, level by
   level; a fallback never borrows the other model's number. */
function resolve(snap, v1, H) {
  H = H || hierarchy();
  const lv = (n) => (H || []).find((x) => x.level === n) || { level: n };
  if (snap && snap.status === 'PREDICTED') {
    const l = snap.fallback_level === 1 ? lv(1) : lv(2);
    return { level: l.level, mode: snap.fallback_level === 1 ? 'FULL' : 'DEGRADED', model_version: snap.model_version,
      modes: snap.degraded.modes, source: 'V2.1 canonical projection' };
  }
  if (snap && snap.status === 'NOT_PRICED') return { level: null, mode: 'NOT_PRICED', model_version: snap.model_version, modes: [], source: 'V2.1 canonical projection (FBS-vs-FCS: projected, never priced)' };
  if (v1 && v1.status === 'PREDICTED' && isNum(v1.margin)) {
    return { level: lv(3).level || 3, mode: 'FALLBACK_MODEL', model_version: v1.model_version, modes: ['FALLBACK_MODEL'],
      source: 'V1 board (football/fbs/slate.json)', reason: snap ? snap.reason : 'no V2.1 row for this game' };
  }
  return { level: lv(4).level || 4, mode: 'UNAVAILABLE', model_version: null, modes: [], reason: (snap && snap.reason) || 'no model can produce a trustworthy projection' };
}

module.exports = { SCHEMA, MODES, ENGINE_MODE, PUBLIC_LABEL, QB_CERTAIN_MIN, INJURY_CERTAIN_MIN, PBP_QUALITY_MIN,
  loadContract, loadEngine, stackWeights, checkRow, inputHash, pure, modes, mergeModes, display, snapshot, hierarchy, resolve, canonicalJson,
  generateCfbPredictionSnapshot: snapshot };
