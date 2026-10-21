#!/usr/bin/env node
/* ============================================================================
   The CURRENT CFB card engine (football/cfb_p4/engine.js, EDCfbP4.projectGame,
   v1.0.1 with its one home field of 2.8 from home_field.js), replayed cold and
   walk-forward over every game with an FBS side, so the model loop compares
   against it on the SAME games, paired.

   Read-only use of the engine: this file loads params.js and engine.js exactly
   as football/cfb_p4/research/backtest_engine.js does and changes nothing in
   them. Differences from that script, all stated:
     * FBS-vs-FCS games are projected too (the engine prices them; FCS sides sit
       on its single fcs_rating floor), not only FBS-vs-FBS;
     * every projected game is written out per game (game_id, fair spread,
       fair total, home win probability, games played), not only aggregated;
     * no team-game efficiency feed is supplied (football/cfb_p4/research
       build_team_game.py output is not rebuilt here), so the matchup term is
       unavailable and contributes 0, as backtest_engine.js does without it.
   The regime-change cut needs coaching flags that exist only for 2026 and is
   not applied; the QB and injury terms are 0 in production as well.

   The replay starts from a zeroed rating state (the shipped seeds already
   contain the results being projected) and absorbs each game only after
   projecting it. The engine's TRAINED coefficients (k, carry, blend curve,
   conference weight, sigma) were fitted on 2001-2025 in layers, so before
   2026 this replay has the same in-sample advantage as "v1 as shipped" does
   in the NFL comparison.

     node model_loop/adapters/cfb/baselines/replay_cfb_p4.js <games.csv> <out.csv> [replay_from]
   games.csv: game_id,season,week,start_date,home_team,away_team,home_division,
              away_division,home_conference,away_conference,neutral_site,
              home_points,away_points  (the cfbfastR CSV schedule columns)
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
var E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
var P = global.window.EDCfbP4Params;

var IN = process.argv[2], OUT = process.argv[3];
var REPLAY_FROM = parseInt(process.argv[4] || '2006', 10);

function readCsv(file) {
  var text = fs.readFileSync(file, 'utf8');
  var rows = [], row = [], cell = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  var head = rows.shift(), out = [], j;
  for (i = 0; i < rows.length; i++) {
    if (rows[i].length < 2) continue;
    var o = {};
    for (j = 0; j < head.length; j++) o[head[j]] = rows[i][j];
    out.push(o);
  }
  return out;
}
function num(v) {
  if (v == null || v === '' || v === 'NA' || v === 'NaN') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}

var games = readCsv(IN).map(function (r) {
  var hp = num(r.home_points), ap = num(r.away_points);
  return {
    game_id: r.game_id, season: num(r.season), week: num(r.week),
    kick: Date.parse(r.start_date) || 0,
    home: r.home_team, away: r.away_team,
    home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
    home_conference: r.home_conference, away_conference: r.away_conference,
    neutral_site: String(r.neutral_site).toLowerCase() === 'true',
    home_points: hp, away_points: ap, completed: hp != null && ap != null
  };
}).filter(function (g) { return g.season >= REPLAY_FROM; });
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week); });

var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var lines = ['game_id,season,week,status,fair_spread,fair_total,home_win_prob,n_games,model_version'];
var season = REPLAY_FROM, n = 0;
games.forEach(function (g) {
  if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
  if (!g.completed) return;
  if (g.home_fbs || g.away_fbs) {
    var out = E.projectGame({
      season: g.season, week: g.week, state: st,
      game: { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral_site },
      teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } }
    });
    if (out.status === 'PREDICTED') {
      n++;
      lines.push([g.game_id, g.season, g.week, out.status, out.model.fair_spread, out.model.fair_total,
        out.model.home_win_prob,
        Math.min(E.strength.games(st, E.normKey(g.home)), E.strength.games(st, E.normKey(g.away))),
        out.model_version || ''].join(','));
    } else {
      lines.push([g.game_id, g.season, g.week, out.status, '', '', '', '', ''].join(','));
    }
  }
  E.ingest.absorbGame(st, {
    home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
    neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points, team_stats: null
  });
});
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.error('[replay_cfb_p4] ' + n + ' games projected -> ' + OUT);
