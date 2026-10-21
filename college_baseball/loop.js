#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the weekly learning loop for the served run
   model (hier_cal), the same contract as the other loops (docs/model-loop/
   README.md), inside this engine's own protocol (research/PROTOCOL.md,
   amendment 2026-10-21).

     node college_baseball/loop.js research [--only a,b] [--max 8]
     node college_baseball/loop.js report
     node college_baseball/loop.js release          (owner: the one holdout look, then serve)
     node college_baseball/loop.js all              (research + report)

   WHAT IT LEARNS ON. SELECTION + VALIDATION (2014-2024, about 78,000 games):
   the seasons the protocol allows for tuning and promotion evidence. Each
   candidate is walked forward exactly as the record is (walkforward.js
   runAll: the hierarchical fit date by date, the run-space calibration of
   season S fitted on S-3..S-1). The HOLDOUT (2025-2026) is never read here.

   THE RULE. A candidate from the catalogue (the five tuned parameters, the
   five the hierarchy has never tuned, the run distribution's dispersion) is
   STAGED only if, over SELECTION + VALIDATION, it lowers log loss by
   >= 0.0002 with the date-blocked 95% interval below zero, leaves the Brier
   score no worse, and is no worse on VALIDATION. One week never decides
   anything; every candidate, pass or fail, is logged.

   STAGED, NOT SERVED. The protocol reports the HOLDOUT once per model
   version and never tunes on it, and more than three looks per family fails
   the audit. So a staged version waits for `release`, run by the owner: the
   version becomes the served one, walkforward.js --holdout takes its one
   look (kept by configuration in validation/holdout_looks.json), and the
   record says what the holdout said. A rollback (point `current` back)
   finds the earlier version's own look and spends none.

   Writes docs/model-loop/college_baseball/versions.json (current = served,
   staged = waiting), candidates.jsonl, weekly/<date>.json and
   weekly_model_report.md.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const WF = require('./walkforward');
const TQ = require('./lib/team_quality');
const P = require('../engine/lab/protocol');
const V = require('../engine/validation');
const K = require('./ingest/common');

const ROOT = path.join(__dirname, '..');
const DOCS_DEFAULT = path.join(ROOT, 'docs', 'model-loop', 'college_baseball');
const MIN_GAIN = { logloss: 0.0002 };
const MAX_CANDIDATES = 8;
const MODEL = 'hier_cal';

/* [id, 'tq.<param>' | 'dist.r', [kind, value], patterns it answers, data it needs]. sigma_div, sigma_park,
   carry_conf, carry_div and carry_park have never been tuned (lib/team_quality.js DEFAULTS) */
const CATALOGUE = [
  ['team_spread_tighter', 'tq.sigma_team', ['mul', 0.75], ['first_3_weeks', 'favourites']],
  ['team_spread_looser', 'tq.sigma_team', ['mul', 1.33], ['first_3_weeks', 'favourites']],
  ['conf_spread_tighter', 'tq.sigma_conf', ['mul', 0.6], ['conference', 'non_conference']],
  ['conf_spread_looser', 'tq.sigma_conf', ['mul', 1.6], ['conference', 'non_conference']],
  ['div_spread_tighter', 'tq.sigma_div', ['mul', 0.5], ['vs_non_d1']],
  ['div_spread_looser', 'tq.sigma_div', ['mul', 2], ['vs_non_d1']],
  ['park_spread_tighter', 'tq.sigma_park', ['mul', 0.5], ['home', 'neutral']],
  ['park_spread_looser', 'tq.sigma_park', ['mul', 2], ['home', 'neutral']],
  ['conf_carry_lower', 'tq.carry_conf', ['add', -0.15], ['first_3_weeks', 'non_conference']],
  ['div_carry_lower', 'tq.carry_div', ['add', -0.15], ['vs_non_d1', 'first_3_weeks']],
  ['park_carry_lower', 'tq.carry_park', ['add', -0.15], ['home']],
  ['team_carry_lower', 'tq.carry_team', ['add', -0.05], ['first_3_weeks']],
  ['dispersion_lower', 'tq.phi', ['mul', 0.85], ['favourites']],
  ['dispersion_higher', 'tq.phi', ['mul', 1.2], ['favourites']],
  ['recency_faster', 'tq.halflife_days', ['mul', 0.67], ['later', 'midweek']],
  ['recency_slower', 'tq.halflife_days', ['mul', 1.5], ['later']],
  ['runs_tails_heavier', 'dist.r', ['mul', 0.8], ['favourites']],
  ['runs_tails_lighter', 'dist.r', ['mul', 1.25], ['favourites']],
  /* roster continuity (lib/continuity.js, from the collegiate collector): inactive until the rosters cover Division I */
  ['roster_continuity_carry', 'tq.cont_k', ['set', 0.5], ['first_3_weeks'], 'continuity'],
  ['roster_continuity_stronger', 'tq.cont_k', ['mul', 1.6], ['first_3_weeks'], 'continuity'],
  ['roster_continuity_weaker', 'tq.cont_k', ['mul', 0.6], ['first_3_weeks'], 'continuity'],
];
/* what a data-dependent candidate needs before it is tried: the share of D-I team-seasons it can see */
const MIN_COVERAGE = 0.8;
function inactiveCandidates() {
  const off = new Map();
  const needs = new Set(CATALOGUE.filter((c) => c[4]).map((c) => c[4]));
  if (needs.has('continuity')) {
    const W = require('./lib/warehouse');
    const C = require('./lib/continuity').load();
    const ts = W.teamSeasons().filter((t) => +t.division === 1 && +t.season >= WF.WIN.selection[0] && +t.season <= WF.WIN.validation[1]).map((t) => [t.season, t.team_id]);
    const cov = C.coverage(ts);
    if (cov < MIN_COVERAGE) for (const c of CATALOGUE.filter((x) => x[4] === 'continuity')) off.set(c[0], 'INACTIVE: roster continuity covers ' + (100 * cov).toFixed(1) + '% of D-I team-seasons ' + WF.WIN.selection[0] + '-' + WF.WIN.validation[1] + ' (needs ' + 100 * MIN_COVERAGE + '%); the collegiate roster backfill (collegiate/plan.json) fills it');
  }
  return off;
}

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

/* ------------------------------------------------------------ versions */
function loadVersions(docs) { const p = path.join(docs, 'versions.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function saveVersions(docs, doc) { fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, 'versions.json'), JSON.stringify(doc, null, 1) + '\n'); }
const byVersion = (doc, v) => doc.versions.find((x) => x.version === v);
/** the configuration research starts from: the newest staged version, else the served one */
function base(doc) { return byVersion(doc, doc.staged || doc.current); }

function ensureVersions(docs, cfg, evidence) {
  let doc = loadVersions(docs);
  if (doc) return doc;
  doc = { schema: 'edgedesk_model_loop_versions_v1', sport: 'College baseball', league: 'college_baseball', current: '1.0.0', staged: null,
    versions: [{ version: '1.0.0', parent: null, config: cfg, config_sha256: WF.configHash(cfg), status: 'SERVED', promoted_by: 'selection-window tuning',
      promoted_at: nowIso(), reason: 'The configuration college_baseball/walkforward.js served when the loop started: params/team_tuning.json (hier cfg and dist), chosen on SELECTION 2014-2022.', evidence }] };
  saveVersions(docs, doc);
  return doc;
}
function stage(docs, doc, cfg, reason, evidence) {
  const [maj, min] = (doc.staged || doc.current).split('.').map(Number);
  let m = min + 1; const taken = new Set(doc.versions.map((v) => v.version));
  while (taken.has(maj + '.' + m + '.0')) m++;
  const v = { version: maj + '.' + m + '.0', parent: doc.staged || doc.current, config: cfg, config_sha256: WF.configHash(cfg), status: 'STAGED (awaiting its holdout look: node college_baseball/loop.js release)',
    promoted_by: 'weekly-loop', promoted_at: nowIso(), reason, evidence };
  doc.versions.push(v); doc.staged = v.version;
  saveVersions(docs, doc);
  return v;
}

/* ------------------------------------------------------------ evaluation */
function applyChange(cfg, key, how) {
  const [grp, param] = key.split('.');
  const cur0 = grp === 'tq' ? (cfg.tq[param] != null ? cfg.tq[param] : TQ.DEFAULTS[param]) : (cfg.dist || {})[param];
  const [kind, v] = how; let nv;
  if (cur0 == null) return null;
  if (kind === 'mul') nv = +(cur0 * v).toFixed(6);
  else if (kind === 'add') nv = +Math.min(1, Math.max(0, cur0 + v)).toFixed(4);
  else nv = v;
  if (nv === cur0) return null;
  const out = { tq: Object.assign({}, cfg.tq), dist: Object.assign({}, cfg.dist || {}) };
  if (grp === 'tq') out.tq[param] = nv; else out.dist[param] = nv;
  return out;
}

/** a configuration's out-of-sample rows over SELECTION + VALIDATION (the holdout is never loaded) */
function scoreConfig(cfg) {
  const run = WF.runAll(['hier'], { hier: cfg }, { until: WF.WIN.validation[1], quiet: true, noEnsemble: true });
  return run.rows.filter((x) => x.p[MODEL] != null && (x.window === 'SELECTION' || x.window === 'VALIDATION'));
}

function metrics(rows) {
  if (!rows.length) return { n: 0 };
  let ll = 0, br = 0;
  for (const x of rows) { ll += V.logLoss(x.p[MODEL], x.y); br += Math.pow(x.p[MODEL] - x.y, 2); }
  return { n: rows.length, logloss: V.r(ll / rows.length, 6), brier: V.r(br / rows.length, 6) };
}

/** (wins - priced) / sqrt(sum p(1-p)) */
function binomialZ(ps, ys) {
  let w = 0, s = 0, v = 0; for (let i = 0; i < ps.length; i++) { w += ys[i]; s += ps[i]; v += ps[i] * (1 - ps[i]); }
  return v > 0 ? (w - s) / Math.sqrt(v) : null;
}
/** where the misses concentrate on VALIDATION (the most recent seasons the loop may read) */
function errorAnalysis(rows) {
  const d = rows.filter((x) => x.window === 'VALIDATION');
  const phase = (x) => { const k = K.daysBetween(x.season + '-02-10', x.date); return k < 21 ? 'first_3_weeks' : k < 60 ? 'weeks_4_8' : 'later'; };
  const groups = [
    ['home', (x) => !x.neutral, 'home games: home wins minus the priced home win'],
    ['neutral', (x) => !!x.neutral, 'neutral sites (listed home side)'],
    ['conference', (x) => !!x.conf_game, 'conference games'],
    ['non_conference', (x) => !x.conf_game, 'non-conference games'],
    ['vs_non_d1', (x) => !x.d1_both, 'a non-Division I opponent'],
    ['first_3_weeks', (x) => phase(x) === 'first_3_weeks', 'the first three weeks (ratings carried over the winter)'],
    ['later', (x) => phase(x) === 'later', 'after week 8'],
    ['midweek', (x) => !(x.weekday === 5 || x.weekday === 6 || x.weekday === 0), 'midweek (weaker starters, not in the model)'],
  ];
  const out = [];
  for (const [name, f, note] of groups) {
    const x = d.filter(f); if (x.length < 200) continue;
    const ps = x.map((r) => r.p[MODEL]), ys = x.map((r) => r.y);
    out.push({ pattern: name, n: x.length, note, outcome_bias: V.r(ys.reduce((a, b) => a + b, 0) / ys.length - ps.reduce((a, b) => a + b, 0) / ps.length, 4), t: V.r(binomialZ(ps, ys), 2), stat: 'z' });
  }
  /* favourites, read from the favourite */
  const fav = d.filter((x) => Math.max(x.p[MODEL], 1 - x.p[MODEL]) >= 0.7);
  if (fav.length >= 200) {
    const ps = fav.map((x) => Math.max(x.p[MODEL], 1 - x.p[MODEL])), ys = fav.map((x) => (x.p[MODEL] >= 0.5 ? x.y : 1 - x.y));
    out.push({ pattern: 'favourites', n: fav.length, note: 'priced 70%+ either way, read from the favourite', outcome_bias: V.r(ys.reduce((a, b) => a + b, 0) / ys.length - ps.reduce((a, b) => a + b, 0) / ps.length, 4), t: V.r(binomialZ(ps, ys), 2), stat: 'z' });
  }
  return out;
}

function rankCandidates(patterns, weekIndex, n, exclude) {
  n = n || MAX_CANDIDATES;
  const CAT = CATALOGUE.filter((c) => !(exclude && exclude.has(c[0])));
  const sig = patterns.map((p) => [Math.abs(p.t || 0), p.pattern]).sort((a, b) => b[0] - a[0]);
  let top = [];
  for (const [t, name] of sig) {
    if (t < 2 || top.length >= n - 2) break;
    top = top.concat(CAT.filter((c) => c[3].includes(name) && !top.includes(c[0])).map((c) => c[0]).slice(0, 2));
  }
  top = top.slice(0, n - 2);
  const rest = CAT.map((c) => c[0]).filter((c) => !top.includes(c));
  const k = weekIndex % Math.max(1, rest.length);
  return top.concat(rest.slice(k).concat(rest.slice(0, k)).slice(0, n - top.length));
}

/* ------------------------------------------------------------ research */
function research(opts) {
  opts = opts || {};
  const docs = opts.docs || DOCS_DEFAULT;
  const score = opts.score || scoreConfig;
  const doc0 = loadVersions(docs);
  const cf = WF.cfgsFromTuning();
  const start = doc0 ? base(doc0).config : { tq: Object.assign({}, cf.hier.tq), dist: Object.assign({}, cf.hier.dist) };
  const rows0 = score(start);
  const sel0 = metrics(rows0), val0 = metrics(rows0.filter((x) => x.window === 'VALIDATION'));
  const doc = ensureVersions(docs, start, { selection_plus_validation: sel0, validation: val0 });
  const from = base(doc);
  const patterns = errorAnalysis(rows0);
  const today = (opts.today || nowIso()).slice(0, 10);
  const weekIndex = Math.floor(Date.parse(today) / (7 * 864e5));
  const off = opts.inactive || inactiveCandidates();
  const order = opts.only ? opts.only.filter((c) => CATALOGUE.some((x) => x[0] === c)) : rankCandidates(patterns, weekIndex, opts.max, off);
  const byId = new Map(rows0.map((x) => [x.game_id, x]));
  const results = [];
  for (const cid of order) {
    const [, key, how, answers] = CATALOGUE.find((c) => c[0] === cid);
    const rec = { at: nowIso(), from_version: from.version, candidate: cid, change: { param: key, how }, answers_patterns: answers };
    if (off.has(cid)) { results.push(Object.assign(rec, { decision: 'SKIPPED', reason: off.get(cid) })); continue; }
    const cfg = applyChange(from.config, key, how);
    if (!cfg) { results.push(Object.assign(rec, { decision: 'SKIPPED', reason: 'no change from the configuration' })); continue; }
    const rows = score(cfg).filter((x) => byId.has(x.game_id));
    const full = metrics(rows), val = metrics(rows.filter((x) => x.window === 'VALIDATION'));
    const d = { logloss: V.r(full.logloss - sel0.logloss, 6), brier: V.r(full.brier - sel0.brier, 6), validation_logloss: V.r(val.logloss - val0.logloss, 6) };
    const ci = P.compare(rows, (x) => V.logLoss(x.p[MODEL], x.y), (x) => V.logLoss(byId.get(x.game_id).p[MODEL], x.y));
    const reasons = [];
    if (d.logloss > -MIN_GAIN.logloss) reasons.push('log loss change ' + d.logloss + ' does not clear -' + MIN_GAIN.logloss);
    if (!(ci.ci95 && ci.ci95[1] < 0)) reasons.push('95% interval ' + JSON.stringify(ci.ci95) + ' is not below zero');
    if (d.brier > 0) reasons.push('Brier worse (' + d.brier + ')');
    if (d.validation_logloss > 0) reasons.push('worse on VALIDATION (' + d.validation_logloss + ')');
    Object.assign(rec, { config: cfg, selection_plus_validation: full, validation: val, ci95: ci.ci95, delta: d,
      decision: reasons.length ? 'FAIL' : 'PASS', reason: reasons.join('; ') || 'clears every condition' });
    results.push(rec);
    console.error('[cbase loop] ' + cid + ': ' + rec.decision + ' (dLL ' + d.logloss + ' ci ' + JSON.stringify(ci.ci95) + ', VALIDATION dLL ' + d.validation_logloss + ')');
  }
  fs.mkdirSync(docs, { recursive: true });
  fs.appendFileSync(path.join(docs, 'candidates.jsonl'), results.map((r) => { const o = Object.assign({}, r); delete o.config; return JSON.stringify(o); }).join('\n') + (results.length ? '\n' : ''));
  const passed = results.filter((r) => r.decision === 'PASS');
  let staged = null;
  if (passed.length) {
    const best = passed.reduce((a, b) => (b.delta.logloss < a.delta.logloss ? b : a));
    staged = stage(docs, doc, best.config, 'weekly loop ' + today + ': candidate ' + best.candidate + ' (' + best.change.param + ' ' + JSON.stringify(best.change.how) + ') cleared the SELECTION + VALIDATION rule',
      { selection_plus_validation: best.selection_plus_validation, validation: best.validation, delta: best.delta, ci95: best.ci95, previous: { selection_plus_validation: sel0, validation: val0 } });
  }
  const wpath = path.join(docs, 'weekly', today + '.json');
  const earlier = fs.existsSync(wpath) ? JSON.parse(fs.readFileSync(wpath, 'utf8')) : null;
  const summary = { schema: 'edgedesk_cbase_loop_week_v1', at: nowIso(), label: 'College baseball (hier_cal)', date: today,
    served: doc.current, staged_before: earlier ? earlier.staged_before : (doc0 && doc0.staged) || null, staged_after: doc.staged, runs: earlier ? (earlier.runs || 1) + 1 : 1,
    promoted: staged ? staged.version : (earlier && earlier.promoted) || null,
    window: { learns_on: [WF.WIN.selection[0], WF.WIN.validation[1]], validation: WF.WIN.validation, holdout_untouched: WF.WIN.holdout },
    baseline: { from_version: from.version, selection_plus_validation: sel0, validation: val0 },
    patterns, inactive: [...off].map(([candidate, reason]) => ({ candidate, reason })),
    candidates: (earlier ? earlier.candidates : []).concat(results.map((r) => { const o = Object.assign({}, r); delete o.config; return o; })) };
  fs.mkdirSync(path.dirname(wpath), { recursive: true });
  fs.writeFileSync(wpath, JSON.stringify(summary, null, 1) + '\n');
  return summary;
}

/* ------------------------------------------------------------ release (owner) */
function release(opts) {
  opts = opts || {};
  const docs = opts.docs || DOCS_DEFAULT;
  const doc = loadVersions(docs);
  if (!doc || !doc.staged) { console.error('[cbase loop] nothing is staged'); return null; }
  const v = byVersion(doc, doc.staged); const prev = doc.current;
  for (const o of doc.versions) if (String(o.status).startsWith('SERVED')) o.status = 'RETIRED (rollback target)';
  v.status = 'SERVED'; v.released_at = nowIso(); doc.current = v.version; doc.staged = null;
  saveVersions(docs, doc);
  /* the protocol's one look for this version, registered and kept by configuration */
  const run = opts.runWalkforward || (() => cp.execFileSync(process.execPath, ['--max-old-space-size=6000', path.join(__dirname, 'walkforward.js'), '--holdout'], { stdio: 'inherit' }));
  run();
  const rep = JSON.parse(fs.readFileSync(opts.walkforwardPath || path.join(__dirname, 'validation', 'walkforward.json'), 'utf8'));
  v.holdout = { evaluated_at: rep.holdout_evaluated_at, status: rep.status, config_sha256: rep.config_sha256 };
  if (!rep.status || rep.status.moneyline.status !== 'OUTCOME_VALIDATED') v.note = 'released; its holdout look did not validate (' + ((rep.status && rep.status.moneyline.failed) || []).join('; ') + '). Roll back: point current at ' + prev + ' (its own look is kept and carried, no new look).';
  saveVersions(docs, doc);
  console.error('[cbase loop] released ' + v.version + ' (was ' + prev + '): holdout ' + (rep.status ? rep.status.moneyline.status : 'not evaluated'));
  return v;
}

/* ------------------------------------------------------------ report */
function report(opts) {
  opts = opts || {};
  const docs = opts.docs || DOCS_DEFAULT;
  const dir = path.join(docs, 'weekly');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  if (!files.length) { console.error('[cbase loop] no research run yet'); return null; }
  const s = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const doc = loadVersions(docs); const cur = byVersion(doc, doc.current);
  const tested = s.candidates.filter((c) => c.decision !== 'SKIPPED').length;
  const lw = s.window.learns_on.join('–');
  const md = ['# College baseball weekly model report: ' + s.date + '\n',
    'Served version **' + cur.version + '** (' + cur.status + ', ' + cur.promoted_by + ').' + (doc.staged ? ' Staged: **' + doc.staged + '**, awaiting its one holdout look (`node college_baseball/loop.js release`).' : '')
      + ' The loop learns on SELECTION + VALIDATION (' + lw + '); the HOLDOUT (' + s.window.holdout_untouched.join('–') + ') is never read here (research/PROTOCOL.md). Outcome-graded only: no college baseball prices are archived.\n',
    '## What changed\n'];
  if (s.promoted) {
    const v = byVersion(doc, s.promoted); const e = v.evidence;
    md.push('**Staged ' + s.promoted + '.** ' + v.reason + '.\n');
    md.push('- ' + lw + ': log loss ' + e.previous.selection_plus_validation.logloss + ' → ' + e.selection_plus_validation.logloss + ' (95% interval of the change ' + JSON.stringify(e.ci95) + ')');
    md.push('- VALIDATION ' + s.window.validation.join('–') + ': log loss ' + e.previous.validation.logloss + ' → ' + e.validation.logloss);
    md.push('- It is served only after `release` takes its holdout look; until then v' + cur.version + ' prices.\n');
  } else {
    md.push('**Nothing staged.** ' + tested + ' candidate' + (tested === 1 ? ' was' : 's were') + ' tested' + (s.runs > 1 ? ' over ' + s.runs + ' runs' : '') + '; none cleared the rule (over ' + lw
      + ': log loss ≤ −' + MIN_GAIN.logloss + ' with its 95% interval below zero, Brier no worse, VALIDATION no worse).\n');
  }
  md.push('## Accuracy (walk-forward, out of sample), from v' + s.baseline.from_version + '\n');
  md.push('| Window | n | Log loss | Brier |\n|---|---|---|---|');
  md.push('| SELECTION + VALIDATION ' + lw + ' | ' + s.baseline.selection_plus_validation.n + ' | ' + s.baseline.selection_plus_validation.logloss + ' | ' + s.baseline.selection_plus_validation.brier + ' |');
  md.push('| VALIDATION ' + s.window.validation.join('–') + ' | ' + s.baseline.validation.n + ' | ' + s.baseline.validation.logloss + ' | ' + s.baseline.validation.brier + ' |');
  md.push('\n## Where the misses concentrate (VALIDATION)\n');
  md.push('Wins minus priced; z = (wins − Σp) / √Σp(1−p). |z| ≥ 2 pulls the matching candidates forward.\n');
  md.push('| Pattern | n | Bias | z | What it covers |\n|---|---|---|---|---|');
  for (const p of s.patterns) md.push('| ' + p.pattern + ' | ' + p.n + ' | ' + (p.outcome_bias > 0 ? '+' : '') + p.outcome_bias + ' | ' + p.t + ' | ' + p.note + ' |');
  md.push('\n## Every candidate tried this week\n');
  md.push('| Candidate | Change | Δlog loss | 95% interval | ΔBrier | VALIDATION Δlog loss | Decision |\n|---|---|---|---|---|---|---|');
  const f = (v) => (v == null ? '—' : v);
  for (const c of s.candidates) { const d = c.delta || {}; md.push('| ' + c.candidate + ' | `' + c.change.param + '` ' + JSON.stringify(c.change.how) + ' | ' + f(d.logloss) + ' | ' + (c.ci95 ? JSON.stringify(c.ci95) : '—') + ' | ' + f(d.brier) + ' | ' + f(d.validation_logloss) + ' | ' + c.decision + ': ' + c.reason + ' |'); }
  if ((s.inactive || []).length) {
    md.push('\n## Waiting on data we do not hold yet\n');
    md.push('These changes need inputs the record does not cover yet; they are not tried, and nothing stands in for the missing data.\n');
    for (const c of s.inactive) md.push('- **' + c.candidate + '**: ' + c.reason.replace(/^INACTIVE: /, ''));
  }
  md.push('\nEvery candidate ever tried: `docs/model-loop/college_baseball/candidates.jsonl`. Versions: `docs/model-loop/college_baseball/versions.json`.');
  const text = md.join('\n') + '\n';
  fs.writeFileSync(path.join(docs, 'weekly_model_report.md'), text);
  fs.writeFileSync(path.join(dir, files[files.length - 1].replace('.json', '.md')), text);
  console.error('[cbase loop] wrote ' + path.relative(ROOT, path.join(docs, 'weekly_model_report.md')));
  return text;
}

module.exports = { CATALOGUE, MIN_GAIN, MIN_COVERAGE, inactiveCandidates, applyChange, rankCandidates, errorAnalysis, binomialZ, metrics, research, release, report, scoreConfig };

if (require.main === module) {
  const cmd = process.argv[2];
  const only = arg('only') ? arg('only').split(',') : null;
  const max = arg('max') ? +arg('max') : MAX_CANDIDATES;
  if (!['research', 'report', 'release', 'all'].includes(cmd)) { console.error('usage: node college_baseball/loop.js research|report|release|all [--only a,b] [--max 8]'); process.exit(2); }
  if (cmd === 'release') { release(); process.exit(0); }
  let s = null;
  if (cmd !== 'report') s = research({ only, max });
  report();
  if (s && s.staged_after && s.staged_after !== s.staged_before) console.log('STAGED ' + s.staged_after);
}
