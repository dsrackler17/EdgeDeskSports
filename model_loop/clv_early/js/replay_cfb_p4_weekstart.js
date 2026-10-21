#!/usr/bin/env node
/* ============================================================================
   CFB V1 (football/cfb_p4/engine.js, EDCfbP4.projectGame v1.0.1) priced at the
   OPENER, walk-forward. EXPERIMENTS.md E-003 / E-006.

   The cold replay of model_loop/adapters/cfb/baselines/replay_cfb_p4.js with
   one change: every game of a (season, season type, week) is projected from
   the rating state at the START of that week, before any of the week's games
   is absorbed (a Thursday result never reaches a Saturday projection). With
   lag = 1 the week's games are projected from the state at the start of the
   PREVIOUS week (ratings through week W-2), the opener-timing sensitivity.

   The engine has no QB or weather input in this path. Its constants were
   trained on 2001-2025 (in-sample for every season scored), stated in
   EXPERIMENTS.md before it ran. Read-only use of the engine.

     node replay_cfb_p4_weekstart.js <games.csv> <out.csv> [replay_from=2006] [lag=0]
   ============================================================================ */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
var E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
var P = global.window.EDCfbP4Params;

var IN = process.argv[2], OUT = process.argv[3];
var REPLAY_FROM = parseInt(process.argv[4] || '2006', 10);
var LAG = parseInt(process.argv[5] || '0', 10);

function readCsv(file) {
  var text = fs.readFileSync(file, 'utf8');
  var rows = [], row = [], cell = '', q = false, i, c;
  for (i = 0; i < text.length; i++) {
    c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  var head = rows.shift(), out = [], j;
  for (i = 0; i < rows.length; i++) { if (rows[i].length < 2) continue; var o = {}; for (j = 0; j < head.length; j++) o[head[j]] = rows[i][j]; out.push(o); }
  return out;
}
function num(v) { if (v == null || v === '' || v === 'NA' || v === 'NaN') return null; var n = +v; return isFinite(n) ? n : null; }

var games = readCsv(IN).map(function (r) {
  var hp = num(r.home_points), ap = num(r.away_points);
  return { game_id: r.game_id, season: num(r.season), week: num(r.week), stype: r.season_type, kick: Date.parse(r.start_date) || 0,
    home: r.home_team, away: r.away_team, home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
    home_conference: r.home_conference, away_conference: r.away_conference,
    neutral_site: String(r.neutral_site).toLowerCase() === 'true', home_points: hp, away_points: ap, completed: hp != null && ap != null };
}).filter(function (g) { return g.season >= REPLAY_FROM; });
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week); });

/* the week key: postseason games share one key per season after the regular season */
function wkey(g) { return g.season + '|' + (g.stype === 'postseason' ? 'post' : ('w' + String(g.week).padStart(2, '0'))); }
var byWeek = {}, order = [];
games.forEach(function (g) { var k = wkey(g); if (!byWeek[k]) { byWeek[k] = []; order.push(k); } byWeek[k].push(g); });

var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

function project(state, g) {
  var out = E.projectGame({ season: g.season, week: g.week, state: state,
    game: { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs, neutral_site: g.neutral_site },
    teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } } });
  return out.status === 'PREDICTED' ? out : null;
}

var lines = ['game_id,season,week,season_type,model_spread,model_total,model_line_raw,n_games'];
var opened = {}, prevStart = null, prevKeySeason = null, season = REPLAY_FROM, n = 0;
games.forEach(function (g) {
  if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; prevStart = null; }
  var k = wkey(g);
  if (!opened[k]) {
    opened[k] = true;
    var startNow = JSON.parse(JSON.stringify(st));
    var use = (LAG > 0 && prevStart) ? prevStart : startNow;
    byWeek[k].forEach(function (h) {
      if (!(h.home_fbs || h.away_fbs)) return;
      var s = JSON.parse(JSON.stringify(use));
      var out = project(s, h);
      if (!out) return;
      n++;
      /* fair_spread is the home margin (+ = home favoured), the harness's line space */
      lines.push([h.game_id, h.season, h.week, h.stype, (+out.model.fair_spread).toFixed(4), out.model.fair_total,
        out.model.fair_spread, Math.min(E.strength.games(s, E.normKey(h.home)), E.strength.games(s, E.normKey(h.away)))].join(','));
    });
    prevStart = startNow;
  }
  if (!g.completed) return;
  E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
    neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points, team_stats: null });
});
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.error('[replay_cfb_p4_weekstart] lag ' + LAG + ': ' + n + ' games projected -> ' + OUT);
