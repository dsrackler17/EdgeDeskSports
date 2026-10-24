#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Development-window selection of the champion candidate, then frozen.

     node basketball/ncaaw_forecast/select.js            choose on 2018-2022, write config/selection_v1.json
     node basketball/ncaaw_forecast/select.js --check    the frozen file's hash still matches its content

   The research engine's parameters were chosen on MEN'S data (the 2025 men's
   season, and the men's forecast's 2012-2019 development window). Nothing is
   carried over: the same coordinate-descent rule is rerun here on the WOMEN'S
   development window only, from the engine's defaults.

   Windows, fixed 2026-10-24 before any women's model number was computed, and
   set by the data: the source's women's box scores cover 13-33% of finals in
   2010-2016 and 93-100% from 2017 (data/manifest.json), so
     burn-in       2017 (the engine's first season: priors and the first
                   residual variance only, never scored)
     development   2018-2022 (every choice is made here)
     confirmation  2023-2026 (scored once, after the choices)
     tournament    the NCAA tournament games of 2024-2026, never used to choose
     holdout       anything (the men's holdout seasons, and the only seasons
                   whose seeds the source carries)
   Games after 2022 are removed before the engine runs, so no later season can
   influence a choice. Rule (fixed before running, the research engine's):
     margin parameters by D1-v-D1 margin CRPS (integer grid), tempo
     parameters by total CRPS; a value replaces the current one only if it
     improves by >= 0.002 (multiple-testing guard over ~35 configurations).
   The calibrator's variance law is then compared on the same window with the
   chosen parameters (run() below; the file records every run as
   variance_runs and the decision as variance_evidence).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const M = require('./metrics');
const TM = require('../ncaam_research/team_model');

const PROTOCOL = Object.freeze({ burn_in: [2017, 2017], development: [2018, 2022], confirmation: [2023, 2026], tournament_holdout: [2024, 2025, 2026] });
const CHALLENGER = 0.002;
const SPACE = [
  ['lambda', [50, 100, 150, 300, 600]],
  ['carry', [0.6, 0.7, 0.8, 0.9, 1.0]],
  ['half_life', [null, 365, 180, 90]],
  ['blowout_weight', [1, 0.7, 0.4]],
  ['new_program_quantile', [0.1, 0.25, 0.4]],
  ['scale', ['additive', 'log']],
];
const TEMPO_SPACE = [['lambda_tempo', [2, 4, 8, 16]], ['carry_tempo', [0.5, 0.7, 0.9]]];
/* no roster input exists before 2024 in any owned source: the roster terms stay off */
const START = Object.freeze(Object.assign({}, TM.DEFAULT_PARAMS, { continuity_slope: 0, transfer_beta: 0, poss_coef: null }));
const FILE = path.join(C.PATHS.configDir, 'selection_v1.json');

function score(eg, params, calibration) {
  const cfg = { engine: 'research_team_model', params, calibration: calibration || MD.DEFAULT_CALIBRATION };
  const R = MD.researchRows(eg, cfg);
  MD.calibrateCausal(R.rows, cfg.calibration);
  const rows = R.rows.filter((r) => r.regime === 'D1_D1' && r.s && r.season >= PROTOCOL.development[0] && r.season <= PROTOCOL.development[1]);
  const s = M.summarize(rows, { reliability: false });
  return { margin_crps: s.margin.crps, total_crps: s.total.crps, log_loss: s.win.log_loss, n: s.n };
}

function selectionHash(f) { return MD.hash({ chosen: f.chosen, calibration: f.calibration, rule: f.rule, protocol: f.protocol }); }

function run() {
  const games = DS.load(C.seasons().filter((s) => s <= PROTOCOL.development[1]));
  const eg = DS.engineGames(games);
  if (eg.some((g) => g.season > PROTOCOL.development[1])) throw new Error('a post-development season reached the selection');
  const log = []; let cur = Object.assign({}, START);
  let best = score(eg, cur); log.push({ params: Object.assign({}, cur), score: best, step: 'start' });
  console.log('start', JSON.stringify(best));
  const descend = (space, key) => {
    for (const [name, values] of space) for (const v of values) {
      if (cur[name] === v) continue;
      const cand = Object.assign({}, cur, { [name]: v }); const sc = score(eg, cand);
      log.push({ params: { [name]: v }, score: sc });
      const taken = sc[key] < best[key] - CHALLENGER;
      console.log('  ' + name + '=' + v + ' ' + key + ' ' + sc[key] + ' (best ' + best[key] + ')' + (taken ? ' -> taken' : ''));
      if (taken) { cur = cand; best = sc; }
    }
  };
  descend(SPACE, 'margin_crps');
  descend(SPACE.slice(0, 3), 'margin_crps');
  descend(TEMPO_SPACE, 'total_crps');
  /* the calibrator's variance law, on the same window with the chosen
     parameters. Rule (fixed before running): start from the men's champion's
     law (margin v1 with the stabilised parameter variance, total v2); a margin
     variant replaces it only if it improves development margin CRPS by
     >= CHALLENGER, the total variant only if it improves total CRPS by as much */
  let cal = Object.assign({}, MD.DEFAULT_CALIBRATION, { variance: Object.assign({}, MD.DEFAULT_CALIBRATION.variance) });
  const base = score(eg, cur, cal); const variance = { default: base };
  console.log('variance default', JSON.stringify(base));
  let bestM = base;
  for (const [id, change] of [['margin_v2', { variance: { margin: 'v2', total: cal.variance.total } }], ['engine_parameter_variance', { parameter_variance: 'engine' }]]) {
    const c = Object.assign({}, cal, change); const sc = score(eg, cur, c); variance[id] = sc;
    const taken = sc.margin_crps < bestM.margin_crps - CHALLENGER;
    console.log('variance ' + id + ' margin_crps ' + sc.margin_crps + (taken ? ' -> taken' : ''));
    if (taken) { cal = c; bestM = sc; }
  }
  { const c = Object.assign({}, cal, { variance: { margin: cal.variance.margin, total: 'v1' } }); const sc = score(eg, cur, c); variance.total_v1 = sc;
    const taken = sc.total_crps < bestM.total_crps - CHALLENGER;
    console.log('variance total_v1 total_crps ' + sc.total_crps + (taken ? ' -> taken' : ''));
    if (taken) { cal = c; bestM = sc; } }
  const fmt = (x) => x.log_loss.toFixed(5) + ' / ' + x.margin_crps.toFixed(4) + ' / ' + x.total_crps.toFixed(4);
  const evidence = 'development ' + PROTOCOL.development.join('-') + ', the chosen engine parameters, D1-v-D1 n = ' + base.n + ' (log loss / margin CRPS / total CRPS): default (margin v1 stabilised, total v2) ' + fmt(base)
    + '; margin v2 ' + fmt(variance.margin_v2) + '; engine parameter variance ' + fmt(variance.engine_parameter_variance) + '; total v1 ' + fmt(variance.total_v1)
    + ' -> margin ' + cal.variance.margin + (cal.parameter_variance === 'engine' ? ' engine variance' : ' stabilised') + ', total ' + cal.variance.total;
  best = bestM;
  const out = {
    schema: 'edgedesk_ncaaw_fc_selection_v1', frozen_at: new Date().toISOString(), protocol: PROTOCOL,
    rule: 'coordinate descent over ' + SPACE.map((s) => s[0]).join(', ') + ' on development D1-v-D1 margin CRPS (integer grid), tempo on total CRPS; a value is taken only if it improves by >= ' + CHALLENGER + '; seasons after ' + PROTOCOL.development[1] + ' are removed before the engine runs',
    chosen: cur, calibration: cal, variance_evidence: evidence, variance_runs: variance, development_score: best, configurations_evaluated: log.length + 4, log,
  };
  out.hash = selectionHash(out);
  fs.mkdirSync(C.PATHS.configDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1) + '\n');
  console.log('frozen ' + out.hash.slice(0, 16) + ' ' + JSON.stringify(cur));
}

function check() {
  const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (selectionHash(f) !== f.hash) { console.error('config/selection_v1.json was edited after freezing'); process.exit(1); }
  console.log('selection_v1.json frozen ' + f.hash.slice(0, 16) + ' (' + f.configurations_evaluated + ' configurations on ' + f.protocol.development.join('-') + ')');
}

module.exports = { PROTOCOL, SPACE, TEMPO_SPACE, START, FILE, selectionHash, score };
if (require.main === module) { if (process.argv.includes('--check')) check(); else run(); }
