/* ============================================================================
   FSIE — the season simulators' SHADOW.

   EdgeDesk's NFL and CFB Monte Carlo simulators (simulator/src/sports/{nfl,cfb})
   draw a margin per game and nothing else: no possessions, no plays. This
   module takes the SAME per-game input contract they take — the published
   model's fair home margin, its sigma and its fair total, read from the slate
   artifacts the simulators' input builders read (football/nfl/slate.json,
   football/fbs/slate.json) — and runs the situational engine's correlated
   two-team simulation CONDITIONED ON THAT MARGIN MODEL: the game script is
   driven by the simulator's margin distribution, possessions are shared and
   coherent, and each team's dropbacks, sacks and rushes reconcile to its plays.

   What it gives a simulator: possessions, offensive pace and script-dependent
   play distribution per game, and the uncertainty of each. What it never
   does: change a simulator draw. The simulators' code and outputs are not
   touched; this writes its own artifact (data/simulator_shadow_<sport>.json).
   The spread, total and EPA the simulator already uses are inputs here, not
   added on top, so nothing is counted twice.

   Mode comes from config/integration.json (nfl_simulator / cfb_simulator):
   OFF writes nothing; SHADOW writes the artifact; ACTIVE is refused unless
   the adapter's three locks are open, and even then this module only reports.
   ========================================================================== */
'use strict';
const path = require('path');
const U = require(path.join(__dirname, 'core', 'util.js'));
const VM = require(path.join(__dirname, 'core', 'volume_model.js'));
const A = require(path.join(__dirname, 'adapter.js'));

const ROOT = path.join(__dirname, '..', '..');

/* the simulators' input contract, from the artifacts their builders read */
function simulatorInputs(sport) {
  const out = {};
  if (sport === 'nfl') {
    const s = U.readJson(path.join(ROOT, 'football', 'nfl', 'slate.json'));
    ((s && s.games) || []).forEach((g) => {
      if (g.model_status && g.model_status !== 'PREDICTED') return;
      const sigma = g.outcome_range && U.isNum(g.outcome_range.sigma) ? g.outcome_range.sigma : null;
      if (U.isNum(g.model_home_margin)) out[String(g.game_id)] = { fair_margin: g.model_home_margin, fair_total: g.model_fair_total, sigma, source: 'football/nfl/slate.json' };
    });
  } else {
    const s = U.readJson(path.join(ROOT, 'football', 'fbs', 'slate.json'));
    ((s && s.games) || []).forEach((g) => {
      if (U.isNum(g.model_home_margin)) out[String(g.game_id)] = { fair_margin: g.model_home_margin, fair_total: g.model_fair_total, sigma: null, source: 'football/fbs/slate.json' };
    });
  }
  return out;
}

/* rows: the live pipeline's upcoming rows by game (home row, away row) */
function run(sport, P, rowsByGame, opts) {
  opts = opts || {};
  const target = sport === 'nfl' ? 'nfl_simulator' : 'cfb_simulator';
  const mode = A.mode(target, opts);
  if (mode === 'OFF') return { mode, target, games: {}, note: 'OFF: nothing computed' };
  const inputs = opts.inputs || simulatorInputs(sport);
  const games = {};
  Object.keys(rowsByGame).forEach((gid) => {
    const inp = inputs[gid]; const pair = rowsByGame[gid];
    if (!inp || !pair || !pair.home || !pair.away) return;
    const h = Object.assign({}, pair.home, { m: inp.fair_margin, total: U.isNum(inp.fair_total) ? inp.fair_total : pair.home.total, m_source: 'line' });
    const a = Object.assign({}, pair.away, { m: -inp.fair_margin, total: h.total, m_source: 'line' });
    const sim = VM.simulateGame(P.team, h, a, { variant: P.primary_variant, draws: opts.draws || 2000, seed: 'simshadow|' + gid, phi: P.team.phi, sigma_margin: U.isNum(inp.sigma) ? inp.sigma : undefined });
    const pick = (s) => ({ plays: [s.p10.plays, s.p50.plays, s.p90.plays], pass_att: [s.p10.pass_att, s.p50.pass_att, s.p90.pass_att], rush_att: [s.p10.rush_att, s.p50.rush_att, s.p90.rush_att], drives: [s.p10.drives, s.p50.drives, s.p90.drives], mean_plays: s.mean.plays, script: s.script });
    games[gid] = { conditioned_on: { fair_home_margin: inp.fair_margin, sigma: U.isNum(inp.sigma) ? U.round(inp.sigma, 2) : 'situational default ' + P.team.residual.sigma_margin, fair_total: inp.fair_total, source: inp.source },
      home: pick(sim.a), away: pick(sim.b), game_possessions_mean: U.round(sim.a.mean.drives + sim.b.mean.drives, 2),
      simulator_draws_changed: 0 };
  });
  return { schema: 'edgedesk_fsie_simulator_shadow_v1', sport, target, mode: mode === 'ACTIVE' ? 'ACTIVE (reporting only)' : mode, model_version: P.model_version, built_at: opts.now || null,
    note: 'Conditioned on the simulator\'s own per-game margin model; the simulator\'s draws and results are unchanged.', games };
}

module.exports = { run, simulatorInputs };
