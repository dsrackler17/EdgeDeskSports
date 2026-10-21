#!/usr/bin/env node
/* ===========================================================================
   THE NFL WEEKLY IMPROVEMENT LOOP (Tuesdays, after the week settles).

     1  re-absorb the completed week through the corrected pipeline and score
        it (tools/record/nfl_weekly_eval.js: published / replayed / close)
     2  find REPEAT patterns in the season-to-date residuals of the served
        model: a home lean, a card component that is over- or under-weighted,
        a prior that is too sticky or too loose, residuals the closing line
        saw coming
     3  map each repeat pattern to candidate fixes drawn ONLY from the
        preregistered families (preregistration.json), as neighbours of the
        served configuration — never a free search, never a game-specific fix
     4  walk-forward backtest every candidate and the served configuration on
        every season (2010 through the season being played), the 2025 holdout
        and 2010-2025 without the season being played
     5  PROMOTE a candidate only if it beats the served model on margin MAE AND
        log loss on all three: the full backtest, the 2025 holdout, and the
        backtest without the current season (so nothing that only helps 2026,
        or one game, can pass). The promoted configuration is trained, written
        to football/nfl_params_v2.js as a new version, archived under
        versions/ for rollback, and recorded in registry.json (which
        tools/football/build_nfl_registry_sql.js turns into the
        research_model_versions / research_model_results rows)
     6  the workflow then rebuilds next week's slate and cards and
        tools/record/nfl_weekly_report.js writes weekly_model_report.md

   Every evaluation is appended to results/variants.jsonl with its holdout
   look flagged, as every Step 2-4 evaluation was.

   Usage
     node football/research/nfl_v2/weekly_loop.js --eval record/football/weekly/nfl_2026_w06.json [--dry]
     node football/research/nfl_v2/weekly_loop.js --latest        # the newest evaluation in record/football/weekly/index.json
     node football/research/nfl_v2/weekly_loop.js --seed          # the registry from Steps 1-4 (once)
     node football/research/nfl_v2/weekly_loop.js --rollback edgedesk_nfl_v2.0.0
   --dry evaluates and reports but promotes nothing and writes no registry.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..', '..');

/* where the loop reads and writes (the tests point these at a scratch copy) */
const P = {
  reg: path.join(__dirname, 'registry.json'),
  versions: path.join(__dirname, 'versions'),
  weekly: path.join(__dirname, 'results', 'weekly'),
  params: path.join(ROOT, 'football', 'nfl_params_v2.js'),
};
function setPaths(o) { Object.assign(P, o || {}); return P; }
const MODEL_KEY = 'edgedesk-nfl-margin';
const CANDIDATES_KEY = 'edgedesk-nfl-margin-candidates';
const MAX_CANDIDATES = 6;
/* a pattern REPEATS when it holds season to date at |t| >= 2 on at least 30
   games and points the same way in at least 60% of the weeks it can be read in */
const PATTERN = { t: 2.0, min_n: 30, min_week_share: 0.6 };

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function merge(base, over) {
  const c = clone(base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && c[k] && typeof c[k] === 'object') Object.assign(c[k], over[k]);
    else c[k] = over[k];
  }
  return c;
}

/* ------------------------------------------------------------ statistics */
function meanT(v) {
  const n = v.length; if (n < 2) return { n, estimate: n ? v[0] : null, se: null, t: null };
  const m = v.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, estimate: m, se, t: se > 0 ? m / se : null };
}
/* y = a + b x, ordinary least squares; the slope's t */
function slopeT(x, y) {
  const n = x.length; if (n < 3) return { n, estimate: null, se: null, t: null };
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) * (x[i] - mx); sxy += (x[i] - mx) * (y[i] - my); }
  if (!(sxx > 1e-12)) return { n, estimate: null, se: null, t: null };
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0; for (let i = 0; i < n; i++) { const e = y[i] - a - b * x[i]; sse += e * e; }
  const se = Math.sqrt(sse / (n - 2) / sxx);
  return { n, estimate: b, se, t: se > 0 ? b / se : null };
}
/* how often each week's own reading points the same way as the season's */
function weekShare(rows, statFn, sign) {
  const weeks = [...new Set(rows.map((r) => r.week))];
  let k = 0, same = 0;
  weeks.forEach((w) => { const s = statFn(rows.filter((r) => r.week === w)); if (s.estimate == null) return; k++; if (Math.sign(s.estimate) === sign) same++; });
  return { weeks: k, same, share: k ? same / k : null };
}

/* ------------------------------------------------------------ 2. patterns */
const COMPONENTS = ['base_strength', 'passing', 'rushing', 'quarterback', 'rest_travel', 'context'];
function patterns(rows) {
  const out = [];
  const add = (id, what, sub, statFn, meaning) => {
    const s = statFn(sub);
    if (s.estimate == null || s.t == null) { out.push({ id, what, n: s.n, estimate: null, t: null, repeat: false, meaning: null }); return; }
    const ws = weekShare(sub, statFn, Math.sign(s.estimate));
    const repeat = s.n >= PATTERN.min_n && Math.abs(s.t) >= PATTERN.t && ws.share != null && ws.share >= PATTERN.min_week_share;
    out.push({ id, what, n: s.n, estimate: r4(s.estimate), se: r4(s.se), t: r4(s.t), weeks: ws, repeat, direction: Math.sign(s.estimate), meaning: meaning(Math.sign(s.estimate)) });
  };
  const nn = rows.filter((r) => !r.neutral);
  add('home_lean', 'mean residual (final - model home margin) at home sites', nn, (rs) => meanT(rs.map((r) => r.residual)),
    (d) => (d > 0 ? 'home sides beat the model: home field under-rated' : 'home sides fell short of the model: home field over-rated'));
  COMPONENTS.forEach((k) => {
    const sub = rows.filter((r) => r.card && r.card[k] != null && r.card[k] !== 0);
    add('component:' + k, `slope of the residual on the card's ${k} points`, sub, (rs) => slopeT(rs.map((r) => r.card[k]), rs.map((r) => r.residual)),
      (d) => (d < 0 ? `${k} over-weighted: the bigger its points, the more the result fell short of them` : `${k} under-weighted: results went further than its points`));
  });
  const bs = rows.filter((r) => r.base_current != null && r.base_prior != null);
  add('prior:current', 'slope of the residual on the base strength\'s in-season (current) part', bs, (rs) => slopeT(rs.map((r) => r.base_current), rs.map((r) => r.residual)),
    (d) => (d > 0 ? 'this season\'s evidence under-weighted: the prior is too sticky' : 'this season\'s evidence over-weighted: the prior lets go too fast'));
  add('prior:prior', 'slope of the residual on the base strength\'s prior part', bs, (rs) => slopeT(rs.map((r) => r.base_prior), rs.map((r) => r.residual)),
    (d) => (d < 0 ? 'the prior over-weighted: last season carried too far' : 'the prior under-weighted'));
  const mk = rows.filter((r) => r.close != null);
  add('market_gap', 'slope of the residual on (close - model)', mk, (rs) => slopeT(rs.map((r) => r.close - r.model), rs.map((r) => r.residual)),
    (d) => (d > 0 ? 'the closing line saw what the model missed: information in prices the model lacks' : 'the close moved the wrong way'));
  add('scale', 'slope of the residual on the model home margin', rows, (rs) => slopeT(rs.map((r) => r.model), rs.map((r) => r.residual)),
    (d) => (d < 0 ? 'margins too extreme: the model over-states its edges' : 'margins too timid'));
  return out;
}

/* ------------------------------------------------------------ 3. candidates
   Only the preregistered families, as neighbours of the served configuration. */
function candidatesFor(pats, cfg) {
  const C = [];
  const add = (family, label, over, why) => {
    const c = merge(cfg, over);
    if (sha(c) === sha(cfg) || C.some((x) => sha(x.cfg) === sha(c))) return;
    C.push({ id: family + ':' + label, family, label, cfg: c, why });
  };
  const rep = (id) => pats.find((p) => p.id === id && p.repeat);
  const scaleRidge = (f) => ({ ridge: { strength: Math.round(cfg.ridge.strength * f), context: cfg.ridge.context, total: cfg.ridge.total } });
  let p;
  if ((p = rep('home_lean'))) {
    add('H1_season_hfa', 'season home field rho 0.7 m 250', { hfa: { kind: 'season', rho: 0.7, m: 250 } }, p.id);
    add('H1_season_hfa', 'season home field rho 0.85 m 500', { hfa: { kind: 'season', rho: 0.85, m: 500 } }, p.id);
  }
  if ((p = rep('prior:current')) || (p = rep('prior:prior'))) {
    const sticky = (p.id === 'prior:current' && p.direction > 0) || (p.id === 'prior:prior' && p.direction < 0);
    if (cfg.prior.kind === 'geometric') {
      const f = sticky ? 1.4 : 1 / 1.4;
      add('P0_wide_geometric', `alpha x${f.toFixed(2)}`, { prior: { kind: 'geometric', alpha: r4(cfg.prior.alpha * f), alpha_pts: r4(cfg.prior.alpha_pts * f), k: null, k_pts: null } }, p.id);
      add('P0_wide_geometric', `carry ${sticky ? '-' : '+'}0.05`, { carry: r4(Math.min(0.95, Math.max(0.3, cfg.carry + (sticky ? -0.05 : 0.05)))) }, p.id);
    } else {
      const f = sticky ? 0.67 : 1.5;
      add('P1_hyperbolic', `k x${f}`, { prior: { kind: 'hyperbolic', k: r4(cfg.prior.k * f), k_pts: r4(cfg.prior.k_pts * f) } }, p.id);
    }
  }
  if ((p = rep('component:base_strength')) || (p = rep('scale'))) add('ridge_strength', p.direction < 0 ? 'strength lambda x2' : 'strength lambda x0.5', scaleRidge(p.direction < 0 ? 2 : 0.5), p.id);
  if ((p = rep('component:passing')) || (p = rep('component:rushing'))) add('T1_split_od', 'split offence and defence', { features: { split_od: true } }, p.id);
  if ((p = rep('component:quarterback'))) add('qb_layer', p.direction < 0 ? 'qb shrink x1.5' : 'qb shrink x0.67', { qb: { qb_shrink: r4(cfg.qb.qb_shrink * (p.direction < 0 ? 1.5 : 0.67)) } }, p.id);
  if ((p = rep('component:rest_travel'))) add('H2_travel_tz', 'travel and time zones on', { ctx: { travel: true } }, p.id);
  if ((p = rep('component:context'))) add('H3_venue_terms', 'drop the dome and grass terms', { ctx: { venue: false } }, p.id);
  if ((p = rep('market_gap'))) add('P3_market', 'market rating beta 0.2 carry 0.8', { market: { on: true, beta: 0.2, carry_m: 0.8 } }, p.id);
  return C.slice(0, MAX_CANDIDATES);
}

/* ------------------------------------------------------------ 4. evaluation */
function evaluateCfg(B, cfg) {
  const r = B.evaluate(cfg, { keepPreds: true });
  const live = B.LIVE;
  const full = B.score(r.preds, B.range(B.VALID[0], live)), exLive = B.score(r.preds, B.range(B.VALID[0], B.HOLDOUT));
  return { valid: B.slim(r.valid), holdout: B.slim(r.holdout), live: B.slim(r.live), full: B.slim(full), through_holdout: B.slim(exLive),
    close: { full: full ? { mae: r4(full.close.mae), logloss: r4(full.close.logloss) } : null, holdout: r.holdout ? { mae: r4(r.holdout.close.mae), logloss: r4(r.holdout.close.logloss) } : null } };
}
/* 5. the promotion gate: MAE AND log loss, on all three windows */
function gate(c, inc) {
  const beats = (a, b) => !!(a && b && a.mae < b.mae && a.logloss < b.logloss);
  const checks = { full: beats(c.full, inc.full), holdout_2025: beats(c.holdout, inc.holdout), without_current_season: beats(c.through_holdout, inc.through_holdout) };
  const passed = checks.full && checks.holdout_2025 && checks.without_current_season;
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  return { passed, checks, why: passed ? 'beats the served model on margin MAE and log loss on the full backtest, the 2025 holdout and 2010-2025'
    : 'does not beat the served model on margin MAE and log loss on: ' + failed.join(', ') };
}

/* ------------------------------------------------------------ registry */
function readRegistry() { return fs.existsSync(P.reg) ? JSON.parse(fs.readFileSync(P.reg, 'utf8')) : null; }
function writeRegistry(reg) { reg.updated_at = new Date().toISOString(); fs.writeFileSync(P.reg, JSON.stringify(reg, null, 1) + '\n'); }
function loadParams(file) {
  const src = fs.readFileSync(file || P.params, 'utf8');
  const m = /window\.EDNflParamsV2 = (\{.*\});\n/.exec(src);
  if (!m) throw new Error('cannot read ' + (file || P.params));
  return JSON.parse(m[1]);
}
function archive(version) {
  fs.mkdirSync(P.versions, { recursive: true });
  const f = path.join(P.versions, version + '.js');
  fs.copyFileSync(P.params, f);
  return path.relative(ROOT, f);
}
function nextVersion(v) {
  const m = /^(.*v)(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error('unversioned model ' + v);
  return `${m[1]}${m[2]}.${+m[3] + 1}.0`;
}

/* the registry, seeded once from Steps 1-4 */
function seed() {
  if (readRegistry()) throw new Error('registry.json exists: --seed writes it once');
  const RES = path.join(__dirname, 'results');
  const step = (n) => JSON.parse(fs.readFileSync(path.join(RES, `step${n}.json`), 'utf8'));
  const PV = loadParams();
  const s1 = step(1);
  const reg = {
    schema: 'edgedesk_nfl_model_registry_v1', model_key: MODEL_KEY, candidates_key: CANDIDATES_KEY,
    what: 'Every version of the NFL margin model the board has served or could serve, every candidate the walk-forward backtest judged, and every promotion and rollback. The served version is `current`; its trained params are football/nfl_params_v2.js and every version is archived under football/research/nfl_v2/versions/.',
    gate: { promotion: 'beats the served model on margin MAE AND log loss on the full walk-forward backtest (2010 through the season being played), on the 2025 holdout, and on 2010-2025 without the season being played', preregistration: 'football/research/nfl_v2/preregistration.json' },
    current: PV.model_version,
    versions: [
      { model_version: 'edgedesk_football_v1.0.0', status: 'superseded', role: 'served before the Step 1 correctness fixes (frozen defence, frozen QB layer, dropped context term, two distributions)',
        cfg: null, config_sha: null, parent: null, created_at: null, archive: 'football/params.js (v1 engine)',
        metrics: { valid: s1.served ? s1.served.valid : null, holdout: s1.served ? s1.served.holdout : null } },
      { model_version: 'edgedesk_football_v1.0.0+fixes', status: 'superseded', role: 'the incumbent for Steps 2-4: v1 with the Step 1 correctness fixes, refitted walk-forward',
        cfg: s1.fixed ? s1.fixed.cfg || null : null, config_sha: null, parent: 'edgedesk_football_v1.0.0', created_at: s1.generated_at || null, archive: null,
        metrics: { valid: s1.fixed ? s1.fixed.valid : null, holdout: s1.fixed ? s1.fixed.holdout : null } },
      { model_version: PV.model_version, status: 'served', role: 'Step 4 promotion: the net_pts sign fix (T5)', cfg: PV.cfg, config_sha: PV.config_sha,
        parent: 'edgedesk_football_v1.0.0+fixes', created_at: PV.built_at, archive: archive(PV.model_version),
        metrics: { valid: PV.validation.valid_2010_2024, holdout: PV.validation.holdout_2025, close: { valid: PV.validation.close_valid, holdout: PV.validation.close_holdout },
          beats_closing_line: PV.validation.beats_closing_line } },
    ],
    results: [], events: [{ at: PV.built_at, kind: 'promote', from: 'edgedesk_football_v1.0.0+fixes', to: PV.model_version, run: 'step4' }],
  };
  [2, 3, 4].forEach((n) => {
    const S = step(n);
    /* step 2's family winners that are not themselves a decision row (the hyperbolic prior) */
    Object.keys(S.family_winners || {}).forEach((fam) => {
      const w = S.family_winners[fam];
      if ((S.decisions || []).some((d) => d.label === w.label)) return;
      const inc = S.incumbent_valid;
      reg.results.push({ run: 'step' + n, candidate: fam + ':' + w.label, family: fam, model_key: CANDIDATES_KEY, evaluated_at: S.generated_at, cfg_sha: sha(w.cfg), passed: false,
        metrics: { valid: w.valid, holdout: null }, incumbent: { valid: inc, holdout: null },
        why: w.valid.mae < inc.mae && w.valid.logloss < inc.logloss ? 'family winner, not selected' : 'family winner; did not beat the incumbent on 2010-2024 validation (MAE and log loss)' });
    });
    (S.decisions || []).concat(S.combinations || []).forEach((d) => {
      reg.results.push({ run: 'step' + n, candidate: (d.family || 'combination') + ':' + d.label, family: d.family || 'combination', model_key: CANDIDATES_KEY,
        evaluated_at: S.generated_at, cfg_sha: d.cfg ? sha(d.cfg) : null, passed: !!(d.promoted || d.promoted_alone),
        metrics: { valid: d.valid || null, holdout: d.holdout || null }, incumbent: { valid: S.incumbent_valid || d.incumbent_valid || null, holdout: S.incumbent_holdout || d.incumbent_holdout || null },
        why: d.why || null });
    });
  });
  writeRegistry(reg);
  return reg;
}

function rollback(version) {
  const reg = readRegistry(); if (!reg) throw new Error('no registry.json');
  const v = reg.versions.find((x) => x.model_version === version);
  if (!v || !v.archive || !/\.js$/.test(v.archive)) throw new Error('no archived params for ' + version);
  const src = fs.readFileSync(path.join(ROOT, v.archive), 'utf8');
  fs.writeFileSync(P.params, src);
  const from = reg.current;
  reg.versions.forEach((x) => { if (x.model_version === from) x.status = 'rolled_back'; if (x.model_version === version) x.status = 'served'; });
  reg.current = version;
  reg.events.push({ at: new Date().toISOString(), kind: 'rollback', from, to: version });
  writeRegistry(reg);
  return { from, to: version };
}

/* ------------------------------------------------------------ the loop */
function run(o) {
  const B = require('./backtest.js');
  const T = require('./train.js');
  /* the tests replace the backtest and the trainer to exercise the bookkeeping */
  const evalOf = o.evaluate || ((cfg) => evaluateCfg(B, cfg));
  const writeParams = o.writeParams || T.writeParams;
  const log = o.log === false ? () => {} : B.logVariant;
  const ev = JSON.parse(fs.readFileSync(o.evalFile, 'utf8'));
  const rows = (ev.season_to_date && ev.season_to_date.rows) || [];
  const PV = loadParams();
  const runId = `${ev.season}_w${String(ev.week).padStart(2, '0')}`;
  const pats = patterns(rows);
  const cands = candidatesFor(pats, PV.cfg);
  const report = { schema: 'edgedesk_nfl_weekly_loop_v1', run: runId, season: ev.season, week: ev.week, generated_at: new Date().toISOString(),
    served: { model_version: PV.model_version, config_sha: PV.config_sha }, pattern_rule: PATTERN, patterns: pats,
    candidates: [], promoted: null, dry: !!o.dry };
  if (cands.length) {
    const inc = evalOf(PV.cfg);
    report.incumbent = inc;
    log({ step: 'weekly ' + runId, family: 'served', label: PV.model_version, cfg: PV.cfg, valid: inc.valid, holdout: inc.holdout, live: inc.live, holdout_looked: true });
    for (const c of cands) {
      const m = evalOf(c.cfg);
      const g = gate(m, inc);
      log({ step: 'weekly ' + runId, family: c.family, label: c.label, cfg: c.cfg, valid: m.valid, holdout: m.holdout, live: m.live, holdout_looked: true, passed: g.passed });
      report.candidates.push({ id: c.id, family: c.family, label: c.label, from_pattern: c.why, cfg_sha: sha(c.cfg), cfg: c.cfg, metrics: m, gate: g });
    }
  }
  const passing = report.candidates.filter((c) => c.gate.passed).sort((a, b) => a.metrics.full.mae - b.metrics.full.mae);
  if (passing.length && !o.dry) {
    const best = passing[0];
    const version = nextVersion(PV.model_version);
    const { doc } = writeParams({ cfg: best.cfg, through: B.HOLDOUT, version, active: true, parent: PV.model_version, source: `weekly_loop ${runId}: ${best.id}`, out: P.params });
    report.promoted = { model_version: version, config_sha: doc.config_sha, candidate: best.id, from_pattern: best.from_pattern, parent: PV.model_version };
  }
  if (!o.dry) {
    const reg = readRegistry() || seed();
    report.candidates.forEach((c) => reg.results.push({ run: 'weekly ' + runId, candidate: c.id, family: c.family, model_key: CANDIDATES_KEY, evaluated_at: report.generated_at,
      cfg_sha: c.cfg_sha, passed: c.gate.passed, checks: c.gate.checks, metrics: { full: c.metrics.full, holdout: c.metrics.holdout, without_current_season: c.metrics.through_holdout, live: c.metrics.live },
      incumbent: report.incumbent ? { model_version: PV.model_version, full: report.incumbent.full, holdout: report.incumbent.holdout, without_current_season: report.incumbent.through_holdout } : null,
      why: c.gate.why, from_pattern: c.from_pattern }));
    if (report.promoted) {
      const P = report.promoted;
      reg.versions.forEach((x) => { if (x.model_version === PV.model_version) x.status = 'superseded'; });
      const best = report.candidates.find((c) => c.id === P.candidate);
      reg.versions.push({ model_version: P.model_version, status: 'served', role: `weekly loop ${runId}: ${P.candidate} (pattern ${P.from_pattern})`, cfg: best.cfg, config_sha: P.config_sha,
        parent: P.parent, created_at: report.generated_at, archive: archive(P.model_version), metrics: { full: best.metrics.full, holdout: best.metrics.holdout, without_current_season: best.metrics.through_holdout,
          close: best.metrics.close, beats_closing_line: !!(best.metrics.close.holdout && best.metrics.holdout.mae < best.metrics.close.holdout.mae && best.metrics.holdout.logloss < best.metrics.close.holdout.logloss) } });
      reg.current = P.model_version;
      reg.events.push({ at: report.generated_at, kind: 'promote', from: P.parent, to: P.model_version, run: 'weekly ' + runId });
    }
    writeRegistry(reg);
    fs.mkdirSync(P.weekly, { recursive: true });
    fs.writeFileSync(path.join(P.weekly, runId + '.json'), JSON.stringify(report, null, 1) + '\n');
  }
  return report;
}

function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  if (a.includes('--seed')) { const r = seed(); console.log(`registry seeded: current ${r.current}, ${r.versions.length} versions, ${r.results.length} candidate results`); return; }
  if (a.includes('--rollback')) { const r = rollback(v('--rollback')); console.log(`rolled back ${r.from} -> ${r.to}`); return; }
  let evalFile = v('--eval', null);
  if (!evalFile && a.includes('--latest')) {
    const dir = path.join(ROOT, 'record', 'football', 'weekly');
    const idx = fs.existsSync(path.join(dir, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) : null;
    if (idx && idx.latest) evalFile = path.join(dir, idx.latest.file);
  }
  if (!evalFile) { console.error('--eval <weekly evaluation json> (or --latest) is required'); process.exit(2); }
  const r = run({ evalFile: path.resolve(evalFile), dry: a.includes('--dry') });
  const rep = r.patterns.filter((p) => p.repeat);
  console.log(`weekly loop ${r.run}: ${rep.length} repeat pattern(s) [${rep.map((p) => p.id).join(', ')}]; ${r.candidates.length} candidate(s); `
    + (r.promoted ? `PROMOTED ${r.promoted.model_version} (${r.promoted.candidate})` : 'nothing promoted'));
  r.candidates.forEach((c) => console.log(`  ${c.gate.passed ? 'PASS' : 'reject'} ${c.id}: full MAE ${c.metrics.full.mae} LL ${c.metrics.full.logloss}; 2025 MAE ${c.metrics.holdout.mae} LL ${c.metrics.holdout.logloss} — ${c.gate.why}`));
}
if (require.main === module) main();
module.exports = { patterns, candidatesFor, gate, evaluateCfg, nextVersion, seed, rollback, run, loadParams, meanT, slopeT, setPaths, PATTERN, MODEL_KEY, CANDIDATES_KEY, PATHS: P };
