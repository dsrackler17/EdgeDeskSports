#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — hyperparameters, chosen on the SELECTION window only.

     node nba/model/tune.js --family elo|glicko|adj|kalman|players|ml [--write]
     node nba/model/tune.js --family ml --part i/n          (parallel parts)
     node nba/model/tune.js --family ml --merge n --write   (then combine)

   Each family is tuned on its own signal with the walk-forward's calibration
   rule: for each selection season S, a logistic win curve a + b·signal is
   fitted on seasons S−3..S−1 and scored on S; the grid point with the lowest
   mean selection log loss wins. No test-window season is read: the pass is
   stopped at the end of the selection window (upTo). The chosen values and
   the whole grid are written to nba/params/tuning.json under the family's key.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const PASS = require('./pass');
const ML = require('./ml');
const S = require('../../engine/stats');
const V = require('../../engine/validation');
const L = require('./learn');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const TUNING = path.join(C.PATHS.params, 'tuning.json');
const SEL = C.WINDOWS.selection;

function selectionLL(rows, signal) {
  let ll = 0, n = 0;
  for (let s = SEL[0]; s <= SEL[1]; s++) {
    const prior = rows.filter((r) => r.y && r.season >= s - 3 && r.season < s && signal(r) != null);
    const test = rows.filter((r) => r.y && r.season === s && signal(r) != null);
    if (prior.length < 500 || !test.length) continue;
    const f = S.logistic(prior.map((r) => [1, signal(r)]), prior.map((r) => r.y.hw), { l2: 1e-6 });
    for (const r of test) { ll += V.logLoss(S.sigmoid(f.beta[0] + f.beta[1] * signal(r)), r.y.hw); n++; }
  }
  return n ? ll / n : Infinity;
}

const GRIDS = {
  elo: { only: ['elo'], signal: (r) => L.qnorm(r.f.elo_p), grid: () => { const g = []; for (const k of [12, 16, 20, 24]) for (const hfa of [30, 60, 90, 120]) for (const revert of [0.45, 0.6, 0.75, 0.9]) g.push({ elo: { k, hfa, revert } }); return g; } },
  glicko: { only: ['glicko'], signal: (r) => L.qnorm(r.f.gl_p), grid: () => { const g = []; for (const c of [3, 6, 10]) for (const summer of [50, 80, 140]) for (const scale of [0.4, 0.55, 0.7, 1]) for (const hfa of [90]) g.push({ glicko: { c, summer, scale, hfa, revert: 0.75 } }); return g; } },
  adj: { only: ['adj'], signal: (r) => r.f.eff_m, grid: () => { const g = []; for (const half_life_days of [120, 240, 480]) for (const prior_games of [16, 32]) for (const carry of [0.7, 0.85]) g.push({ adj: { half_life_days, prior_games, carry } }); return g; } },
  kalman: { only: ['kalman'], signal: (r) => r.f.kal_m, grid: () => { const g = []; for (const q of [0.005, 0.01, 0.02]) for (const summer of [1, 2, 4]) for (const carry of [0.7, 0.85]) for (const R of [16000, 30000]) g.push({ kalman: { q, summer, carry, R } }); return g; } },
  players: { only: ['players', 'kalman'], use_players: true, signal: (r) => r.f.plr_m_conf, grid: () => { const g = []; for (const lambda of [500, 1000, 3000]) for (const half_life_days of [180, 365]) for (const pr of [0]) g.push({ players: { lambda, half_life_days, prior_o: pr / 2, prior_d: pr / 2 } }); return g; } },
};

async function tuneFamily(fam) {
  const G = GRIDS[fam]; const base = readTuning();
  const results = [];
  const part = arg('part', null); /* 'i/n': this process runs every n-th grid point from i (parallel tuning) */
  const grid = G.grid().filter((_, i) => !part || i % Number(part.split('/')[1]) === Number(part.split('/')[0]));
  for (const point of grid) {
    const params = Object.assign({}, base.pass, point, { use_players: !!G.use_players });
    const t0 = Date.now();
    const r = await PASS.run(params, { only: G.only, upTo: SEL[1] });
    const ll = selectionLL(r.rows, G.signal);
    results.push(Object.assign({ selection_ll: Math.round(ll * 1e6) / 1e6 }, point[fam]));
    console.log('[nba tune] ' + fam + ' ' + JSON.stringify(point[fam]) + ' → ' + ll.toFixed(5) + ' (' + ((Date.now() - t0) / 1000).toFixed(0) + ' s)');
  }
  results.sort((a, b) => a.selection_ll - b.selection_ll);
  const best = Object.assign({}, results[0]); delete best.selection_ll;
  return { chosen: best, grid: results };
}

/* ML: depth / learning rate / leaf size and the ridge penalties, on a subset
   of selection seasons (every third), with the team and player params fixed */
const ML_PART = (i) => path.join(C.PATHS.cacheWork, 'tune_ml_part_' + i + '.json');
async function tuneMl() {
  const base = readTuning();
  /* --part i/n: this process runs the ridge grid (part 0 only) and every n-th
     tree point from i, and leaves its results in the work cache; --merge n
     reads the n parts and chooses exactly as one sequential run would */
  const part = arg('part', null), merge = arg('merge', null);
  if (merge) {
    const out = { ridge: [], gbdt: [] };
    for (let i = 0; i < Number(merge); i++) { const p = JSON.parse(fs.readFileSync(ML_PART(i), 'utf8')); out.ridge.push(...p.ridge); out.gbdt.push(...p.gbdt); }
    return chooseMl(out, [2010, 2013, 2016]);
  }
  const [pi, pn] = part ? part.split('/').map(Number) : [0, 1];
  const WF = require('./walkforward');
  const rows = (await WF.buildRows(base)).filter((r) => r.season <= SEL[1]);
  const seasons = [2010, 2013, 2016];
  const scoreP = (tag, key) => { let ll = 0, n = 0; for (const r of rows) if (seasons.includes(r.season) && r.f[tag + key] != null) { ll += V.logLoss(r.f[tag + key], r.y.hw); n++; } return n ? ll / n : Infinity; };
  const out = { ridge: [], gbdt: [] };
  for (const l2 of pi === 0 ? [3, 30, 300] : []) {
    ML.fitPredict(rows, 'P', { ridge_l2: l2, logit_l2: l2, learners: ['logit'], seasons, tag: 'T' });
    out.ridge.push({ l2, selection_ll: Math.round(scoreP('mlPT', '_logit_p') * 1e6) / 1e6 });
    console.log('[nba tune] logit l2 ' + l2 + ' → ' + out.ridge[out.ridge.length - 1].selection_ll);
  }
  let k = 0;
  for (const depth of [2, 3, 4]) for (const lr of [0.03, 0.08]) for (const minLeaf of [60, 150]) {
    if ((k++) % pn !== pi) continue;
    const g = Object.assign({}, ML.DEFAULT_CFG.gbdt, { depth, lr, minLeaf });
    ML.fitPredict(rows, 'P', { gbdt: g, learners: ['gbdt'], seasons, tag: 'T' });
    out.gbdt.push({ depth, lr, minLeaf, selection_ll: Math.round(scoreP('mlPT', '_gbdt_p') * 1e6) / 1e6 });
    console.log('[nba tune] gbdt ' + JSON.stringify({ depth, lr, minLeaf }) + ' → ' + out.gbdt[out.gbdt.length - 1].selection_ll);
  }
  if (part) { fs.mkdirSync(C.PATHS.cacheWork, { recursive: true }); fs.writeFileSync(ML_PART(pi), JSON.stringify(out)); return null; }
  return chooseMl(out, seasons);
}
function chooseMl(out, seasons) {
  out.ridge.sort((a, b) => a.selection_ll - b.selection_ll); out.gbdt.sort((a, b) => a.selection_ll - b.selection_ll);
  const bg = out.gbdt[0];
  return { chosen: { ridge_l2: out.ridge[0].l2, logit_l2: out.ridge[0].l2, gbdt: Object.assign({}, ML.DEFAULT_CFG.gbdt, { depth: bg.depth, lr: bg.lr, minLeaf: bg.minLeaf }) }, grid: out, seasons };
}

function readTuning() { try { return JSON.parse(fs.readFileSync(TUNING, 'utf8')); } catch (_) { return { schema: 'edgedesk_nba_tuning_v1', pass: {}, ml: {}, grids: {} }; } }

async function main() {
  const fam = arg('family', 'elo');
  const res = fam === 'ml' ? await tuneMl() : await tuneFamily(fam);
  if (!res) { console.log('[nba tune] ' + fam + ' part ' + arg('part') + ' written to the work cache; run --merge n --write once every part is done'); return; }
  console.log('[nba tune] ' + fam + ' chosen ' + JSON.stringify(res.chosen));
  if (flag('write')) {
    const t = readTuning();
    t.schema = 'edgedesk_nba_tuning_v1'; t.rule = 'each family chosen by SELECTION-window (' + SEL.join('-') + ') log loss of its own signal under the walk-forward calibration; no later season is read';
    if (fam === 'ml') t.ml = res.chosen; else t.pass[fam] = res.chosen;
    t.grids = t.grids || {}; t.grids[fam] = { at: new Date().toISOString(), grid: res.grid };
    fs.mkdirSync(path.dirname(TUNING), { recursive: true });
    fs.writeFileSync(TUNING, JSON.stringify(t, null, 1) + '\n');
  }
}

module.exports = { selectionLL, GRIDS };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
