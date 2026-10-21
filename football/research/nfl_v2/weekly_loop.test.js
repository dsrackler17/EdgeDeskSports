#!/usr/bin/env node
/* ===========================================================================
   THE NFL WEEKLY LOOP'S RULES (weekly_loop.js, preregistration.json weekly_loop).

     1  the statistics: mean and slope t-values on known data
     2  patterns: a planted repeat pattern is found, noise is not
     3  candidates: only the preregistered families, neighbours of the served
        configuration, never the served configuration itself, at most six
     4  the gate: MAE AND log loss on the full window, the 2025 holdout and
        2010-2025 — winning two of three is a rejection
     5  the bookkeeping, end to end on a scratch copy: a passing candidate is
        promoted to the next version, archived, registered with every
        candidate's result; a failing week promotes nothing; rollback restores
        the archived params byte for byte
     6  the real backtest (only where the nflverse cache exists): the served
        model's walk-forward record from evaluateCfg is the one its params ship

   Run: node football/research/nfl_v2/weekly_loop.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./weekly_loop.js');
const ROOT = path.join(__dirname, '..', '..', '..');

let pass = 0, fail = 0;
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS | ' + name); }
  else { fail++; console.log('FAIL | ' + name + (detail !== undefined ? ' | ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
const near = (a, b, t) => Math.abs(a - b) <= (t || 1e-9);

/* a seeded generator, so the noise is the same every run */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function normal(r) { const u = Math.max(1e-12, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/* 1 */
{
  const m = L.meanT([1, 2, 3, 4, 5]);
  chk('meanT: mean 3, se sqrt(2.5/5), t = 3/se', near(m.estimate, 3) && near(m.se, Math.sqrt(2.5 / 5)) && near(m.t, 3 / Math.sqrt(0.5)), m);
  const s = L.slopeT([1, 2, 3, 4, 5], [2.1, 3.9, 6.2, 7.8, 10.1]);
  chk('slopeT: the least-squares slope (1.99) with its t', near(s.estimate, 1.99, 1e-9) && s.t > 20, s);
  chk('slopeT: no variation in x is no estimate', L.slopeT([1, 1, 1], [1, 2, 3]).estimate === null);
}

/* 2: residual = -0.4 x base strength + noise; nothing else in the residual */
const R = rng(7);
function rows(planted) {
  const out = [];
  for (let w = 1; w <= 6; w++) for (let i = 0; i < 16; i++) {
    const card = { base_strength: 8 * normal(R), passing: normal(R), rushing: normal(R), quarterback: normal(R), home_field: 3, context: 0.5 * normal(R), rest_travel: i % 3 ? 0 : normal(R) };
    const res = (planted ? -0.4 * card.base_strength : 0) + 11 * normal(R);
    out.push({ week: w, neutral: false, residual: res, model: card.base_strength + 3, close: card.base_strength + 2, card, base_prior: card.base_strength * 0.7, base_current: card.base_strength * 0.3 });
  }
  return out;
}
const planted = L.patterns(rows(true)), noise = L.patterns(rows(false));
const bs = planted.find((p) => p.id === 'component:base_strength');
chk('a planted over-weighted base strength is a repeat pattern, read as over-weighted', bs.repeat && bs.direction < 0 && /over-weighted/.test(bs.meaning), bs);
chk('pure noise repeats nowhere (or almost nowhere: at most one false alarm in 11 tests)', noise.filter((p) => p.repeat).length <= 1, noise.filter((p) => p.repeat).map((p) => p.id));
chk('every pattern carries n, its estimate, t and its weekly agreement', planted.every((p) => p.n > 0 && 'estimate' in p && 't' in p));
chk('a pattern on fewer than 30 games never repeats, whatever its t',
  L.patterns(rows(true).slice(0, 29)).every((p) => !p.repeat));

/* 3 */
const PV = L.loadParams();
const cfg = PV.cfg;
const PRE = JSON.parse(fs.readFileSync(path.join(__dirname, 'preregistration.json'), 'utf8'));
const FAMILIES = new Set(['H1_season_hfa', 'P0_wide_geometric', 'P1_hyperbolic', 'ridge_strength', 'T1_split_od', 'qb_layer', 'H2_travel_tz', 'H3_venue_terms', 'P3_market']);
chk('the weekly loop\'s pattern rule and families are preregistered', PRE.weekly_loop && /\|t\| >= 2 on at least 30 games/.test(PRE.weekly_loop.pattern_rule)
  && Object.keys(PRE.weekly_loop.candidate_families).length === 8);
const all = ['home_lean', 'component:base_strength', 'component:passing', 'component:quarterback', 'component:rest_travel', 'component:context', 'prior:current', 'market_gap']
  .map((id) => ({ id, repeat: true, direction: id === 'prior:current' ? 1 : -1 }));
const cands = L.candidatesFor(all, cfg);
chk('every pattern repeating at once: at most six candidates', cands.length === 6, cands.map((c) => c.id));
chk('candidates come only from the preregistered families', cands.every((c) => FAMILIES.has(c.family)), cands.map((c) => c.family));
chk('no candidate is the served configuration, and no two are the same', cands.every((c) => JSON.stringify(c.cfg) !== JSON.stringify(cfg)) && new Set(cands.map((c) => JSON.stringify(c.cfg))).size === cands.length);
chk('the served configuration is not mutated by generating candidates', JSON.stringify(cfg) === JSON.stringify(L.loadParams().cfg));
const sticky = L.candidatesFor([{ id: 'prior:current', repeat: true, direction: 1 }], cfg);
chk('a sticky prior makes it decay faster (alpha up) and carry less', sticky.some((c) => c.cfg.prior.alpha > cfg.prior.alpha) && sticky.some((c) => c.cfg.carry < cfg.carry), sticky.map((c) => c.label));
chk('an over-weighted base strength doubles the strength ridge', L.candidatesFor([{ id: 'component:base_strength', repeat: true, direction: -1 }], cfg)[0].cfg.ridge.strength === cfg.ridge.strength * 2);
chk('no repeat pattern, no candidate', L.candidatesFor(all.map((p) => Object.assign({}, p, { repeat: false })), cfg).length === 0);

/* 4 */
const met = (mae, ll) => ({ mae, logloss: ll });
const inc = { full: met(10.4, 0.635), holdout: met(10.17, 0.634), through_holdout: met(10.35, 0.631) };
const win = { full: met(10.3, 0.633), holdout: met(10.16, 0.633), through_holdout: met(10.34, 0.630) };
chk('the gate: better on all three windows on both metrics passes', L.gate(win, inc).passed === true);
chk('the gate: worse on the holdout\'s log loss alone is a rejection', L.gate(Object.assign({}, win, { holdout: met(10.16, 0.6345) }), inc).passed === false);
chk('the gate: better on 2026 only (the full window) and worse without it is a rejection', L.gate(Object.assign({}, win, { through_holdout: met(10.36, 0.632) }), inc).passed === false);
chk('the gate: a tie is not a win', L.gate(Object.assign({}, win, { full: met(10.4, 0.633) }), inc).passed === false);
chk('the rejection names the window that failed', /holdout_2025/.test(L.gate(Object.assign({}, win, { holdout: met(10.18, 0.633) }), inc).why));
chk('versions: v2.0.0 -> v2.1.0 -> v2.2.0', L.nextVersion('edgedesk_nfl_v2.0.0') === 'edgedesk_nfl_v2.1.0' && L.nextVersion('edgedesk_nfl_v2.1.0') === 'edgedesk_nfl_v2.2.0');

/* 5: the bookkeeping on a scratch copy */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nflloop-'));
  const real = Object.assign({}, L.PATHS);
  const paths = { reg: path.join(dir, 'registry.json'), versions: path.join(ROOT, 'football', 'research', 'nfl_v2', '.cache', 'test_versions_' + process.pid), weekly: path.join(dir, 'weekly'), params: path.join(dir, 'nfl_params_v2.js') };
  fs.copyFileSync(real.params, paths.params);
  fs.copyFileSync(real.reg, paths.reg);
  const before = fs.readFileSync(paths.params, 'utf8');
  L.setPaths(paths);
  try {
    /* an evaluation file whose rows plant an under-weighted rest/travel term */
    const r = rng(11), evRows = [];
    for (let w = 1; w <= 6; w++) for (let i = 0; i < 14; i++) { const rt = normal(r); evRows.push({ week: w, neutral: false, residual: 3 * rt + 4 * normal(r), model: 1, close: 1, card: { rest_travel: rt, base_strength: normal(r) }, base_prior: 0, base_current: 0 }); }
    const evFile = path.join(dir, 'eval.json');
    fs.writeFileSync(evFile, JSON.stringify({ season: 2026, week: 6, season_to_date: { rows: evRows } }));
    /* a stand-in backtest: travel on wins everywhere; a stand-in trainer: writes a params file */
    const fake = (c) => (c.ctx.travel ? { full: met(10.30, 0.630), holdout: met(10.10, 0.630), through_holdout: met(10.30, 0.629), close: { holdout: met(9.67, 0.607) } }
      : { full: met(10.36, 0.631), holdout: met(10.17, 0.634), through_holdout: met(10.36, 0.631), close: { holdout: met(9.67, 0.607) } });
    const writes = [];
    const fakeWrite = (o) => { writes.push(o); const doc = Object.assign({}, PV, { model_version: o.version, cfg: o.cfg, config_sha: 'test' + writes.length, parent_version: o.parent });
      fs.writeFileSync(o.out, "window.EDNflParamsV2 = " + JSON.stringify(doc) + ";\n"); return { doc }; };
    const rep = L.run({ evalFile: evFile, evaluate: fake, writeParams: fakeWrite, log: false });
    const reg = JSON.parse(fs.readFileSync(paths.reg, 'utf8'));
    chk('a planted rest/travel pattern yields the travel candidate, which passes and is promoted to the next version',
      rep.patterns.find((p) => p.id === 'component:rest_travel').repeat && rep.promoted && rep.promoted.model_version === L.nextVersion(PV.model_version) && rep.promoted.candidate === 'H2_travel_tz:travel and time zones on', rep.promoted);
    chk('…trained through the last completed season, written where the board reads its params, marked active', writes.length === 1 && writes[0].through === 2025 && writes[0].active === true && writes[0].out === paths.params);
    chk('…the registry serves it, supersedes the old version, archives it and records the promotion event',
      reg.current === rep.promoted.model_version && reg.versions.find((v) => v.model_version === PV.model_version).status === 'superseded'
      && reg.versions.find((v) => v.model_version === rep.promoted.model_version).status === 'served' && fs.existsSync(path.join(ROOT, reg.versions.find((v) => v.model_version === rep.promoted.model_version).archive))
      && reg.events.slice(-1)[0].kind === 'promote');
    chk('…and every candidate\'s result is in the registry with its gate checks', reg.results.filter((x) => x.run === 'weekly 2026_w06').length === rep.candidates.length && rep.candidates.length >= 1
      && reg.results.filter((x) => x.run === 'weekly 2026_w06').every((x) => x.checks && 'holdout_2025' in x.checks));
    chk('…and the run\'s report is written', fs.existsSync(path.join(paths.weekly, '2026_w06.json')));
    const back = L.rollback(PV.model_version);
    const reg2 = JSON.parse(fs.readFileSync(paths.reg, 'utf8'));
    chk('rollback restores the archived params byte for byte and serves the old version again',
      fs.readFileSync(paths.params, 'utf8') === fs.readFileSync(path.join(ROOT, reg2.versions.find((v) => v.model_version === PV.model_version).archive), 'utf8')
      && reg2.current === PV.model_version && reg2.versions.find((v) => v.model_version === back.from).status === 'rolled_back' && reg2.events.slice(-1)[0].kind === 'rollback');
    chk('…which is the params the board served before the promotion', fs.readFileSync(paths.params, 'utf8') === before);
    /* a week where the candidate loses the holdout: nothing is promoted */
    fs.copyFileSync(real.reg, paths.reg); fs.copyFileSync(real.params, paths.params);
    const loses = (c) => Object.assign(fake(c), c.ctx.travel ? { holdout: met(10.18, 0.630) } : {});
    const rep2 = L.run({ evalFile: evFile, evaluate: loses, writeParams: fakeWrite, log: false });
    chk('a candidate that loses the 2025 holdout is rejected and nothing changes', !rep2.promoted && rep2.candidates.every((c) => !c.gate.passed)
      && fs.readFileSync(paths.params, 'utf8') === before && JSON.parse(fs.readFileSync(paths.reg, 'utf8')).current === PV.model_version);
    const rep3 = L.run({ evalFile: evFile, evaluate: fake, writeParams: fakeWrite, log: false, dry: true });
    chk('--dry evaluates and reports but promotes nothing', rep3.candidates.some((c) => c.gate.passed) && !rep3.promoted && fs.readFileSync(paths.params, 'utf8') === before);
  } finally {
    L.setPaths(real);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(paths.versions, { recursive: true, force: true });
  }
}
chk('the committed registry serves the committed params', JSON.parse(fs.readFileSync(L.PATHS.reg, 'utf8')).current === PV.model_version);

/* 6 */
if (fs.existsSync(path.join(__dirname, '.cache', 'raw', 'games.csv')) && fs.existsSync(path.join(__dirname, '.cache', 'raw', 'stw_2025.csv'))) {
  const B = require('./backtest.js');
  const m = L.evaluateCfg(B, cfg);
  chk('the real backtest: the served model\'s 2025 holdout MAE is the one its params ship', near(m.holdout.mae, PV.validation.holdout_2025.mae, 2e-4), [m.holdout.mae, PV.validation.holdout_2025.mae]);
  chk('…the full window covers 2010 through the season being played, and 2010-2025 excludes it', m.full.n > m.through_holdout.n && m.through_holdout.n === m.valid.n + m.holdout.n, [m.full.n, m.through_holdout.n, m.valid.n, m.holdout.n]);
} else console.log('NOTE | no nflverse cache (football/research/nfl_v2/fetch_history.sh): the real-backtest checks did not run');

console.log(fail ? `FAILURES ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
