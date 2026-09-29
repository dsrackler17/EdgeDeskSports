/* ===========================================================================
   PLAYER PROPS — the league priors a projection is shrunk toward, as of a
   timestamp: model.js leaguePriors() (role shares, dispersion, status
   play-through rates, the weather factor, the volume regression, outcome
   scales) plus the empirical per-play gain pools, both built only from games
   strictly before asOf. The live build and the backtest call this one
   function, so a prior is never fitted on the future it predicts.
   =========================================================================== */
'use strict';
const M = require('./model.js');
const E = require('./engine.js');

function priorsAsOf(data, asOfMs, season, poolsAsOf) {
  const pools = poolsAsOf(data, asOfMs, E);
  const lg = M.leaguePriors(data, asOfMs, season);
  lg.pools = pools.summary;
  lg.pools_raw = pools.raw;
  return lg;
}
/* the compact, publishable view of a prior (no pools, no big arrays) */
function publishable(lg) {
  const o = {};
  ['season', 'as_of', 'n_team_games', 'n_player_games', 'plays', 'pass_rate', 'neutral_pass_rate', 'sack_rate', 'scramble_rate', 'untargeted_rate', 'int_rate', 'pts_mean', 'td_per_point', 'pass_td_share', 'yards_per_game', 'scramble_ypc', 'hfa'].forEach((k) => { o[k] = typeof lg[k] === 'number' ? Math.round(lg[k] * 10000) / 10000 : lg[k]; });
  o.pos = lg.pos; o.role = lg.role; o.alpha = lg.alpha; o.status_play = lg.status_play; o.wind = lg.wind; o.env = lg.env; o.volume = lg.volume; o.pools = lg.pools;
  return o;
}
module.exports = { priorsAsOf, publishable };
