/* ===========================================================================
   THE HAND-OFF TO THE PLAYER PROPS TERMINAL.

   The factory's champion models project every upcoming player and market
   (score.js). This file writes those distributions where the terminal's
   board build (football/props/build_board.js) reads them:

     football/props/factory/<league>/projections.json

   keyed exactly as the terminal keys a prop — its game id, its player id
   (nflverse GSIS for the NFL, the ESPN athlete id for college) and its
   market key — so the join is by id, never by name. The terminal prices the
   distribution with its own kernel (lib/edgedesk_props.js, family 'stored')
   and shows it beside its engine as a second, walk-forward-validated
   opinion. The terminal's decision is not changed by it.

   Compact: a count keeps its probability mass function, a yardage up to 29
   CDF knots taken on its own curve (every 5% of probability, denser in the tails), a yes/no its probability; plus the model version, its
   walk-forward tier and evidence, and the three features that moved it most.
   =========================================================================== */
'use strict';
const path = require('path');
const EDP = require('./dist.js');
const { writeIfChanged } = require('../../../tools/football/write_if_changed.js');

const SCHEMA = 'edgedesk_props_factory_projections_v1';
const OUT = path.join(__dirname);
/* factory market → terminal market (lib/edgedesk_props.js MARKETS); the two
   factory combos the terminal does not list are not exported */
const TO_TERMINAL = {
  pass_yards: 'pass_yds', pass_attempts: 'pass_att', pass_completions: 'pass_cmp', pass_tds: 'pass_tds', pass_interceptions: 'pass_ints',
  pass_longest_completion: 'pass_long', rush_yards: 'rush_yds', rush_attempts: 'rush_att', rush_tds: 'rush_tds', longest_rush: 'rush_long',
  receiving_yards: 'rec_yds', receptions: 'receptions', targets: 'targets', receiving_tds: 'rec_tds', longest_reception: 'rec_long',
  rush_rec_yards: 'rush_rec_yds', pass_rush_yards: 'pass_rush_yds', anytime_td: 'anytime_td'
};
/* knots at fixed probabilities, dense in the tails where alternate lines
   live, each ON the factory's own CDF (exact interpolated quantiles) */
const KNOTS = [0.005, 0.01, 0.025, 0.05, 0.075].concat([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9], [0.925, 0.95, 0.975, 0.99, 0.995]);
function quantileKnots(d) {
  const xs = [d.x[0]], ps = [d.p[0]];
  KNOTS.forEach((t) => {
    if (t <= ps[ps.length - 1] + 1e-9) return;
    let j = 1; while (j < d.p.length && d.p[j] < t) j++;
    if (j >= d.p.length) return;
    const p0 = d.p[j - 1], p1 = d.p[j], x0 = d.x[j - 1], x1 = d.x[j];
    const x = p1 > p0 ? x0 + (x1 - x0) * (t - p0) / (p1 - p0) : x1;
    if (x > xs[xs.length - 1] + 1e-9) { xs.push(x); ps.push(t); }
  });
  if (d.x[d.x.length - 1] > xs[xs.length - 1]) { xs.push(d.x[d.x.length - 1]); ps.push(1); } else ps[ps.length - 1] = 1;
  return { t: 'cdf', x: xs, p: ps, int: !!d.int };
}
function r(x, d) { return typeof x === 'number' && isFinite(x) ? Math.round(x * Math.pow(10, d)) / Math.pow(10, d) : null; }
function terminalPid(league, p) { return league === 'NFL' ? p.gsis_id : p.espn_id; }
function compactDist(d) {
  if (!d) return null;
  if (d.t === 'pmf') { const v = d.v.map((x) => r(x, 5)); while (v.length > 1 && v[v.length - 1] === 0) v.pop(); return { t: 'pmf', v, tail: r(d.tail || 0, 5) }; }
  if (d.t === 'cdf') { const c = d.x.length > KNOTS.length + 2 ? quantileKnots(d) : d; return { t: 'cdf', x: c.x.map((x) => r(x, 1)), p: c.p.map((x) => r(x, 4)), int: !!c.int }; }
  if (d.t === 'bern') return { t: 'bern', p: r(d.p, 5) };
  return null;
}

/* scored: score.js output; registry: models/registry.json; terminalBoard:
   the terminal's current board for the league (optional) — when present,
   only players it shows are exported */
function build(scored, registry, terminalBoard) {
  const league = scored.league;
  const onBoard = terminalBoard && Array.isArray(terminalBoard.props) ? new Set(terminalBoard.props.filter((x) => x.p).map((x) => x.g + '|' + x.p)) : null;
  const reg = new Map(((registry && registry.models) || []).map((m) => [m.model_version, m]));
  const models = [], mi = new Map(), rows = {};
  let skippedId = 0, skippedBoard = 0, skippedMarket = 0;
  scored.props.forEach((p) => {
    const tm = TO_TERMINAL[p.market_key]; if (!tm) { skippedMarket++; return; }
    const pid = terminalPid(league, p); if (!pid) { skippedId++; return; }
    if (onBoard && !onBoard.has(p.game_id + '|' + pid)) { skippedBoard++; return; }
    if (!mi.has(p.model_version)) {
      const e = reg.get(p.model_version) || {}, wf = e.walk_forward || {};
      mi.set(p.model_version, models.length);
      models.push([p.model_version, e.outcome_tier || p.outcome_tier || 'RESEARCH', r(wf.mean_mae_skill, 3), r(wf.mean_pit_max_abs_dev, 3), wf.folds || 0]);
    }
    rows[p.game_id + '|' + pid + '|' + tm] = [mi.get(p.model_version), compactDist(p.dist), r(p.mean, 2), r(p.median, 2), r(p.p10, 1), r(p.p90, 1), p.as_of, p.drivers || []];
  });
  return {
    schema: SCHEMA, league, season: scored.season, generated_at: scored.generated_at, as_of: scored.generated_at,
    feature_version: scored.props.length ? scored.props[0].feature_version : null,
    rule: 'The factory\'s walk-forward-validated distributions (football/props/factory), keyed by the terminal\'s own game, player and market ids. Evidence beside the terminal\'s engine; it never sets a price and does not change a decision.',
    cols: ['model', 'dist', 'mean', 'median', 'p10', 'p90', 'as_of', 'drivers'],
    model_cols: ['model_version', 'outcome_tier', 'walk_forward_mae_skill', 'walk_forward_pit_dev', 'folds'],
    models, n: Object.keys(rows).length, skipped: { no_terminal_id: skippedId, not_on_board: skippedBoard, market_not_listed: skippedMarket }, rows
  };
}
function write(doc) { return writeIfChanged(path.join(OUT, doc.league.toLowerCase(), 'projections.json'), doc); }

module.exports = { SCHEMA, TO_TERMINAL, build, write, compactDist, terminalPid };
