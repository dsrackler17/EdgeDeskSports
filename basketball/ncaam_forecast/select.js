#!/usr/bin/env node
'use strict';
/* ===========================================================================
   Development-window selection of the champion candidate, then frozen.

     node basketball/ncaam_forecast/select.js            choose on 2012-2019, write config/selection_v1.json
     node basketball/ncaam_forecast/select.js --check    the frozen file's hash still matches its content

   The research engine's parameters were chosen on the 2025 season
   (basketball/ncaam_research/selection_frozen.json). 2025 lies inside this
   system's confirmation window, so those values are NOT reused blindly: the
   same coordinate-descent rule is rerun here on the DEVELOPMENT window only.
   Games after 2019 are removed before the engine runs, so no later season can
   influence a choice. Rule (fixed before running, the research engine's):
     margin parameters by D1-v-D1 margin CRPS (integer grid), tempo
     parameters by total CRPS; a value replaces the current one only if it
     improves by >= 0.002 (multiple-testing guard over ~35 configurations).
   The calibrator's variance law was compared on the same window
   (VARIANCE_EVIDENCE below, from the run recorded in CBB_MODEL_NOTES.md §5).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const DS = require('./dataset');
const MD = require('./model');
const M = require('./metrics');
const TM = require('../ncaam_research/team_model');

const PROTOCOL = Object.freeze({ burn_in: [2010, 2011], development: [2012, 2019], confirmation: [2020, 2026], tournament_holdout: [2024, 2025, 2026] });
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
const VARIANCE_EVIDENCE = 'development 2012-2019, research-engine parameters, D1-v-D1 n = 43,886: log loss v1 engine variance 0.51936, v1 stabilised 0.51907, v2 0.51921; margin CRPS 6.1850 / 6.1826 / 6.1834; total CRPS 9.6414 / 9.6395 / 9.6383 -> margin v1 stabilised, total v2';

function score(eg, params) {
  const cfg = { engine: 'research_team_model', params, calibration: MD.DEFAULT_CALIBRATION };
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
  const out = {
    schema: 'edgedesk_ncaam_fc_selection_v1', frozen_at: new Date().toISOString(), protocol: PROTOCOL,
    rule: 'coordinate descent over ' + SPACE.map((s) => s[0]).join(', ') + ' on development D1-v-D1 margin CRPS (integer grid), tempo on total CRPS; a value is taken only if it improves by >= ' + CHALLENGER + '; seasons after ' + PROTOCOL.development[1] + ' are removed before the engine runs',
    chosen: cur, calibration: MD.DEFAULT_CALIBRATION, variance_evidence: VARIANCE_EVIDENCE, development_score: best, configurations_evaluated: log.length, log,
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
