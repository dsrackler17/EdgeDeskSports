/* ============================================================================
   CFB Model Lab — governance: who is champion, what is being tested, what
   changed and why. Append-only event logs in football/cfb_lab/governance/.

     model_roles.jsonl     champion / challenger / candidate / retired events
     experiments.jsonl     experiment registry (CREATED / STATUS / RESULT)
     audit_log.jsonl       every governed change (promotion, calibration,
                           thresholds, feature version, data source, rules)
     partitions.jsonl      live observation / development / future holdout pools
     research_queue.jsonl  evidence-backed research items (OPENED / EVIDENCE / CLOSED)

   Nothing here changes a model. Promotion is a person's command:

     node football/cfb_lab/governance.js roles
     node football/cfb_lab/governance.js promote --model <version> --reason "<why>" --actor <name> [--evidence <report>]
     node football/cfb_lab/governance.js retire  --model <version> --reason "<why>" --actor <name>
     node football/cfb_lab/governance.js experiment --id EXP-003 --name ... --baseline <v> --challenger <v>
            --hypothesis "..." --change "<one change>" --scope SINGLE_CHANGE --window "<weeks>" --metrics mae,brier
     node football/cfb_lab/governance.js experiment-status --id EXP-003 --status RUNNING --actor <name>
     node football/cfb_lab/governance.js release-partition --season 2026 --actor <name> --reason "<why>"
     node football/cfb_lab/governance.js seed        (idempotent: initial registry, experiments, partitions)
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./ledger.js');
const L = require('./lab_core.js');

const U = L.util;
const ROLES = ['champion', 'challenger', 'candidate', 'retired'];
const SCOPES = ['SINGLE_CHANGE', 'BUNDLE', 'ARCHITECTURE'];
const EXP_STATUS = ['PLANNED', 'RUNNING', 'EVALUATED', 'ABANDONED'];

function eventId(kind, obj) { return 'cfbg_' + G.h(kind, G.canonical(obj)); }
function withId(kind, obj) { const o = Object.assign({}, obj); o.event_id = eventId(kind, obj); return o; }

/* ---------------------------------------------------------------- roles */
function currentRoles(events) {
  const out = {};
  (events || []).slice().sort((a, b) => U.ms(a.effective_at) - U.ms(b.effective_at)).forEach((e) => {
    out[e.model_version] = { role: e.role, label: e.model_label, effective_at: e.effective_at, reason: e.reason, actor: e.actor };
  });
  return out;
}
function champion(events) {
  const r = currentRoles(events);
  const c = Object.keys(r).filter((k) => r[k].role === 'champion');
  return c.length === 1 ? c[0] : (c.length ? c : null);
}
function roleEvent(model, label, role, reason, actor, at, evidence) {
  if (!ROLES.includes(role)) throw new Error('role must be one of ' + ROLES.join(', '));
  return withId('role', { model_version: model, model_label: label || null, role, effective_at: U.iso(at || new Date()),
    reason: reason || null, evidence_ref: evidence || null, actor: actor || null, supersedes: null });
}
function auditEvent(type, subject, before, after, reason, actor, at) {
  return withId('audit', { event_type: type, subject, before: before == null ? null : before, after: after == null ? null : after,
    reason: reason || null, actor: actor || null, created_at: U.iso(at || new Date()) });
}
/* A person promotes a challenger. The old champion becomes challenger in the
   same act; both changes are audited. Refused without a reason and an actor. */
function promote(store, model, reason, actor, opts) {
  opts = opts || {};
  if (!reason || !actor) throw new Error('promotion needs --reason and --actor (a person, on the record)');
  const roles = currentRoles(store.gov('model_roles'));
  if (!roles[model]) throw new Error(model + ' is not registered');
  if (roles[model].role === 'champion') throw new Error(model + ' is already champion');
  const at = opts.at || new Date();
  const evs = [], aud = [];
  const old = Object.keys(roles).filter((k) => roles[k].role === 'champion');
  old.forEach((k) => {
    evs.push(roleEvent(k, roles[k].label, 'challenger', 'replaced as champion by ' + model + ': ' + reason, actor, at));
    aud.push(auditEvent('ROLE_CHANGED', k, { role: 'champion' }, { role: 'challenger' }, 'replaced by ' + model, actor, at));
  });
  evs.push(roleEvent(model, roles[model].label, 'champion', reason, actor, at, opts.evidence || null));
  aud.push(auditEvent('MODEL_PROMOTED', model, { role: roles[model].role }, { role: 'champion' }, reason, actor, at));
  store.append('model_roles', evs, 'event_id'); store.append('audit_log', aud, 'event_id');
  return { roles: evs, audit: aud };
}
function retire(store, model, reason, actor, opts) {
  opts = opts || {};
  if (!reason || !actor) throw new Error('retirement needs --reason and --actor');
  const roles = currentRoles(store.gov('model_roles'));
  if (!roles[model]) throw new Error(model + ' is not registered');
  if (roles[model].role === 'champion') throw new Error('promote another model first: the champion cannot be retired directly');
  const at = opts.at || new Date();
  const ev = roleEvent(model, roles[model].label, 'retired', reason, actor, at);
  const au = auditEvent('MODEL_RETIRED', model, { role: roles[model].role }, { role: 'retired' }, reason, actor, at);
  store.append('model_roles', [ev], 'event_id'); store.append('audit_log', [au], 'event_id');
  return { role: ev, audit: au };
}

/* ---------------------------------------------------------- experiments */
function experimentCreate(store, x, actor, at) {
  if (!x.id || !x.name || !x.baseline || !x.challenger || !x.hypothesis || !x.change) throw new Error('experiment needs id, name, baseline, challenger, hypothesis and change');
  const scope = x.scope || 'SINGLE_CHANGE';
  if (!SCOPES.includes(scope)) throw new Error('scope must be one of ' + SCOPES.join(', '));
  /* one change per experiment: a list of changes is only allowed when the
     scope says so explicitly, so a bundle can never pass as a single test */
  const changes = Array.isArray(x.change) ? x.change : [x.change];
  if (scope === 'SINGLE_CHANGE' && changes.length !== 1) throw new Error('a SINGLE_CHANGE experiment changes exactly one thing');
  const exist = store.gov('experiments').filter((e) => e.experiment_id === x.id && e.event === 'CREATED');
  if (exist.length) return null;
  const ev = withId('exp', { experiment_id: x.id, event: 'CREATED', experiment_name: x.name, baseline_model: x.baseline, challenger_model: x.challenger,
    hypothesis: x.hypothesis, change: changes.length === 1 ? changes[0] : changes, scope, start_date: x.start || U.iso(at || new Date()).slice(0, 10),
    evaluation_window: x.window || null, metrics: x.metrics || ['mae', 'rmse', 'brier', 'ece', 'coverage_80', 'p95_ae', 'clv'],
    status: x.status || 'PLANNED', result: null, actor: actor || null, created_at: U.iso(at || new Date()) });
  store.append('experiments', [ev], 'event_id');
  store.append('audit_log', [auditEvent('EXPERIMENT_CREATED', x.id, null, { name: x.name, scope, status: ev.status }, x.hypothesis, actor, at)], 'event_id');
  return ev;
}
function experimentStatus(store, id, status, actor, result, at) {
  if (!EXP_STATUS.includes(status)) throw new Error('status must be one of ' + EXP_STATUS.join(', '));
  const ex = experiments(store.gov('experiments'))[id];
  if (!ex) throw new Error('no experiment ' + id);
  const ev = withId('exp', { experiment_id: id, event: result ? 'RESULT' : 'STATUS', status, result: result || null, actor: actor || null, created_at: U.iso(at || new Date()) });
  store.append('experiments', [ev], 'event_id');
  store.append('audit_log', [auditEvent('EXPERIMENT_STATUS', id, { status: ex.status }, { status }, null, actor, at)], 'event_id');
  return ev;
}
function experiments(events) {
  const out = {};
  (events || []).slice().sort((a, b) => U.ms(a.created_at) - U.ms(b.created_at)).forEach((e) => {
    if (e.event === 'CREATED') out[e.experiment_id] = Object.assign({}, e, { history: [e] });
    else if (out[e.experiment_id]) { out[e.experiment_id].status = e.status; if (e.result) out[e.experiment_id].result = e.result; out[e.experiment_id].history.push(e); }
  });
  return out;
}

/* ----------------------------------------------------------- partitions */
function releasePartition(store, season, actor, reason, at) {
  if (!actor || !reason) throw new Error('a release needs --actor and --reason');
  const rep = path.join(G.LAB, 'reports', String(season), 'promotion.json');
  if (!fs.existsSync(rep)) throw new Error('no promotion evaluation recorded for ' + season + ': a live season is released only after it has been used for its promotion evaluation');
  const ev = withId('part', { pool: 'development_pool', season: Number(season), week_from: null, week_to: null, origin_scope: 'LIVE',
    effective_at: U.iso(at || new Date()), reason, actor });
  store.append('partitions', [ev], 'event_id');
  store.append('audit_log', [auditEvent('PARTITION_RELEASED', 'season ' + season, { pool: 'live_observation_pool' }, { pool: 'development_pool' }, reason, actor, at)], 'event_id');
  return ev;
}

/* --------------------------------------------- automatic change detection */
/* Compares the governed facts of each tracked model with the last recorded
   ones and appends an audit event for anything that changed. */
function governedFacts(models) {
  const out = {};
  (models || []).forEach((m) => {
    const any = [...m.projections.values()][0];
    if (!any) return;
    out[m.model_version] = { feature_version: any.feature_version || null, calibration_version: any.calibration_version || null,
      ensemble_version: any.ensemble_version || null, params_hash: any.params_hash || null, engine_id: any.engine_id || null, source: any.source || null };
  });
  return out;
}
function detectChanges(store, models, at) {
  const facts = governedFacts(models);
  const log = store.gov('audit_log');
  const last = {};
  log.filter((e) => e.event_type === 'SNAPSHOT_FACTS' || /_CHANGED$/.test(e.event_type) || e.event_type === 'MODEL_REGISTERED')
    .forEach((e) => { if (e.after && e.after.facts) last[e.subject] = e.after.facts; });
  const out = [];
  const typeFor = { feature_version: 'FEATURE_VERSION_CHANGED', calibration_version: 'CALIBRATION_CHANGED', ensemble_version: 'THRESHOLD_CHANGED', params_hash: 'THRESHOLD_CHANGED', source: 'DATA_SOURCE_CHANGED', engine_id: 'DATA_SOURCE_CHANGED' };
  Object.keys(facts).forEach((mv) => {
    const now = facts[mv], was = last[mv];
    if (!was) { out.push(auditEvent('MODEL_REGISTERED', mv, null, { facts: now }, 'first seen by the Model Lab', 'automation', at)); return; }
    const changed = Object.keys(now).filter((k) => now[k] !== was[k]);
    if (!changed.length) return;
    const type = changed.includes('feature_version') ? 'FEATURE_VERSION_CHANGED' : (changed.includes('calibration_version') ? 'CALIBRATION_CHANGED' : typeFor[changed[0]]);
    out.push(auditEvent(type, mv, { facts: was, changed }, { facts: now, changed }, 'detected by the hourly lab run (' + changed.join(', ') + ')', 'automation', at));
  });
  if (out.length) store.append('audit_log', out, 'event_id');
  return out;
}

/* ---------------------------------------------------------------- seed */
const SEED_AT = '2026-09-27T12:00:00.000Z';
function seed(store) {
  const at = SEED_AT;
  const roles = store.gov('model_roles');
  const out = { roles: 0, experiments: 0, partitions: 0 };
  if (!roles.length) {
    const evs = [
      roleEvent('edgedesk_cfb_p4_v1.0.0', 'V1', 'champion', 'the priced champion when the Model Lab started (docs/cfb-v2/REDTEAM.md §24)', 'cfb_lab seed', at),
      roleEvent('edgedesk_cfb_v2.1.0', 'V2.1 · hardened', 'challenger', 'hardened red-team successor of candidate 001, running in shadow; eligible on every backtest gate, promotion waits on live evidence', 'cfb_lab seed', at),
      roleEvent('edgedesk_cfb_v2.0.0', 'V2 · candidate 001', 'candidate', 'frozen baseline cfb_v2_candidate_001, tracked in shadow for comparison', 'cfb_lab seed', at),
    ];
    store.append('model_roles', evs, 'event_id');
    store.append('audit_log', evs.map((e) => auditEvent('ROLE_CHANGED', e.model_version, null, { role: e.role }, e.reason, 'cfb_lab seed', at)), 'event_id');
    out.roles = evs.length;
  }
  const exps = [
    { id: 'EXP-001', name: 'V2.1 hardened vs V1 champion', baseline: 'edgedesk_cfb_p4_v1.0.0', challenger: 'edgedesk_cfb_v2.1.0',
      hypothesis: 'The V2 architecture (opponent-adjusted play-by-play ensemble) predicts margins more accurately than V1 on live 2026 games, as it did on the 2024-25 holdout (-0.28 MAE).',
      change: 'V2 architecture (whole model generation)', scope: 'ARCHITECTURE', window: 'LIVE 2026, promotion evaluation at 150 common official games', status: 'RUNNING' },
    { id: 'EXP-002', name: 'V2.1 hardened vs candidate 001', baseline: 'edgedesk_cfb_v2.0.0', challenger: 'edgedesk_cfb_v2.1.0',
      hypothesis: 'The pre-registered hardening (two components, equal weights, havoc removed, QB level overlay) costs no accuracy live, as on the holdout (-0.012 MAE).',
      change: ['R2 components C+D', 'R3 equal weights', 'R4 havoc/sack group removed', 'R6 raw win / Platt cover', 'R8 QB level overlay'], scope: 'BUNDLE',
      window: 'LIVE 2026', status: 'RUNNING' },
    { id: 'EXP-003', name: 'Prior-by-week fade', baseline: 'edgedesk_cfb_v2.1.0', challenger: 'edgedesk_cfb_v2.2.0 (not built)',
      hypothesis: 'Letting preseason priors fade by week fixes under-use in weeks 0-2 and over-use in weeks 7-10 (development dMAE -0.023).',
      change: 'prior_fade interaction (one feature)', scope: 'SINGLE_CHANGE', window: 'next offseason release cycle, evaluated on 2027', status: 'PLANNED' },
    { id: 'EXP-004', name: 'P4 tier term', baseline: 'edgedesk_cfb_v2.1.0', challenger: 'edgedesk_cfb_v2.2.0 (not built)',
      hypothesis: 'A P4-tier term removes the systematic under-rating of the P4 side in P4-vs-G5 games (development dMAE -0.030).',
      change: 'p4_tier term (one feature)', scope: 'SINGLE_CHANGE', window: 'next offseason release cycle, evaluated on 2027', status: 'PLANNED' },
  ];
  exps.forEach((x) => { if (experimentCreate(store, x, 'cfb_lab seed', at)) out.experiments++; });
  if (!store.gov('partitions').length) {
    const parts = [
      withId('part', { pool: 'development_pool', season: 2023, week_from: null, week_to: null, origin_scope: '*', effective_at: at, reason: 'seasons 2016-2023: every tuning and ablation choice was made here', actor: 'cfb_lab seed' }),
      withId('part', { pool: 'live_observation_pool', season: 2026, week_from: null, week_to: null, origin_scope: 'LIVE', effective_at: at, reason: 'every LIVE prediction from the Model Lab start: evaluation only, never tuning, until released', actor: 'cfb_lab seed' }),
      withId('part', { pool: 'future_holdout_pool', season: 2027, week_from: null, week_to: null, origin_scope: '*', effective_at: at, reason: 'the next season, untouched until a pre-registered evaluation', actor: 'cfb_lab seed' }),
    ];
    for (let s = 2016; s <= 2022; s++) parts.push(withId('part', { pool: 'development_pool', season: s, week_from: null, week_to: null, origin_scope: '*', effective_at: at, reason: 'development seasons 2016-2023', actor: 'cfb_lab seed' }));
    store.append('partitions', parts, 'event_id');
    out.partitions = parts.length;
  }
  return out;
}

module.exports = { ROLES, SCOPES, currentRoles, champion, roleEvent, auditEvent, promote, retire, experimentCreate, experimentStatus, experiments,
  releasePartition, governedFacts, detectChanges, seed, eventId, withId };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  const store = new G.Store(Number(arg('--season', new Date().getUTCFullYear())));
  try {
    if (a[0] === 'roles') console.log(JSON.stringify(currentRoles(store.gov('model_roles')), null, 1));
    else if (a[0] === 'promote') console.log(JSON.stringify(promote(store, arg('--model'), arg('--reason'), arg('--actor'), { evidence: arg('--evidence', null) }), null, 1));
    else if (a[0] === 'retire') console.log(JSON.stringify(retire(store, arg('--model'), arg('--reason'), arg('--actor')), null, 1));
    else if (a[0] === 'experiment') console.log(JSON.stringify(experimentCreate(store, { id: arg('--id'), name: arg('--name'), baseline: arg('--baseline'), challenger: arg('--challenger'),
      hypothesis: arg('--hypothesis'), change: arg('--change'), scope: arg('--scope', 'SINGLE_CHANGE'), window: arg('--window', null), metrics: (arg('--metrics', '') || '').split(',').filter(Boolean) }, arg('--actor', null)), null, 1));
    else if (a[0] === 'experiment-status') console.log(JSON.stringify(experimentStatus(store, arg('--id'), arg('--status'), arg('--actor', null)), null, 1));
    else if (a[0] === 'release-partition') console.log(JSON.stringify(releasePartition(store, arg('--season'), arg('--actor'), arg('--reason')), null, 1));
    else if (a[0] === 'seed') console.log(JSON.stringify(seed(store)));
    else console.log('usage: see the header of football/cfb_lab/governance.js');
  } catch (e) { console.error('refused: ' + e.message); process.exit(1); }
}
