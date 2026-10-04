#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB — ONE ROW PER GAME from a cold replay of the SHIPPED engine,
   for the validations that need the pregame number beside the market:
   the EV plausibility bound (tools/football/ev_plausibility.js) and the
   closing-line-value report (tools/football/clv_report.js).

   Same replay as research/backtest_engine.js and the regime backtests: the
   rating state starts at zero in REPLAY_FROM (the shipped seeds contain the
   results being scored), every game is projected from the state BEFORE it and
   absorbed after, in kickoff order. Each row carries what the engine published
   at kickoff — the fair home margin and the game's σ — and the archive's
   opening and closing home margin (research/build_market.py, EdgeDesk's
   convention: + = the home side favoured). The market is never passed to the
   projection; it is read into the row for the comparisons only.

   One caveat is stated wherever the rows are used for an OPENER comparison:
   the state is the one at kickoff, which also holds the other games played
   between the opener and kickoff (the two teams' own state is the same — they
   do not play in between).

     node football/cfb_p4/research/replay_rows.js --data D --from 2021 --to 2025 --out rows.json
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;

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
  if (v == null || v === '' || v === 'NA' || v === 'NaN' || v === 'nan') return null;
  var n = +v;
  return isFinite(n) ? n : null;
}

function bool(v) { var s = String(v).toLowerCase(); return s === 'true' ? true : (s === 'false' ? false : null); }
/* THE TURNOVER INPUTS at a kickoff, for the explainer's terms: the v2 magnitude
   features from research/build_regime_history.py's tables (regime_history.csv,
   qb_starts.csv), with the QB change read from the team's LAST COMPLETED game
   (before its first, from the roster) — the same definition as
   research/regime_magnitude_backtest.js and football/coaching/build_regime.js */
function regimeInputs(DATA) {
  var RS = require(path.join(HERE, '..', '..', 'coaching', 'regime_signal.js'));
  var hist = {}, starter = {}, last = {};
  var fr = path.join(DATA, 'out', 'regime_history.csv'), fq = path.join(DATA, 'out', 'qb_starts.csv');
  if (!fs.existsSync(fr) || !fs.existsSync(fq)) throw new Error('missing regime_history.csv / qb_starts.csv under ' + path.join(DATA, 'out') + ' — run build_regime_history.py');
  readCsv(fr).forEach(function (r) {
    if (String(r.fbs).toLowerCase() !== 'true' || !r.team) return;
    hist[r.season + '|' + E.normKey(r.team)] = { new_hc: bool(r.new_hc), returning_production_pct: num(r.returning_production_pct),
      incoming_production_pct: num(r.incoming_production_pct), prev: num(r.prev_primary_qb_id) != null ? String(num(r.prev_primary_qb_id)) : null, returning_qb: bool(r.returning_qb) };
  });
  readCsv(fq).forEach(function (r) { starter[r.season + '|' + String(r.game_id) + '|' + r.team_key] = String(num(r.starter_id)); });
  return {
    side: function (season, name) {
      var k = E.normKey(name), h = hist[season + '|' + k];
      if (!h) return null;
      var l = last[season + '|' + k], qb = !h.prev ? null : (l ? l !== h.prev : (h.returning_qb == null ? null : !h.returning_qb));
      return { features: RS.magnitudeFeatures({ new_hc: h.new_hc, returning_production_pct: h.returning_production_pct, incoming_production_pct: h.incoming_production_pct, qb_change: qb }),
        qb_change: qb };
    },
    played: function (season, gameId, names) {
      names.forEach(function (nm) { var k = E.normKey(nm), s = starter[season + '|' + gameId + '|' + k]; if (s) last[season + '|' + k] = s; });
    }
  };
}

/* THE V1 REGIME FLAG per team-season: the signal the shipped regime curve
   fires on (football/coaching/regime_signal.js, its default definition, as
   research/regime_backtest.js reads it), from research/build_regime_history.py's
   regime_history.csv. A team-season with no row is null (unknown), never false.
   For reports that split by it (tools/football/clv_report.js); nothing prices
   from it here. */
function regimeFlags(DATA) {
  var RS = require(path.join(HERE, '..', '..', 'coaching', 'regime_signal.js'));
  var fr = path.join(DATA, 'out', 'regime_history.csv'), flag = {};
  if (!fs.existsSync(fr)) throw new Error('missing ' + fr + ' — run build_regime_history.py');
  readCsv(fr).forEach(function (r) {
    if (String(r.fbs).toLowerCase() !== 'true' || !r.team) return;
    flag[r.season + '|' + E.normKey(r.team)] = RS.fires({ new_hc: bool(r.new_hc), returning_share_pct: num(r.returning_share_pct),
      returning_production_pct: num(r.returning_production_pct), transfers_out_pct: num(r.transfers_out_pct) }, RS.DEFAULT).fires === true;
  });
  return function (season, name) { var v = flag[season + '|' + E.normKey(name)]; return v == null ? null : v; };
}

/* each side's games played this season before the game, as the projection counted them */
function gamesPlayed(out) {
  var pb = out && out.layers && out.layers.strength && out.layers.strength.preseason_blend;
  return pb ? { home: num(pb.home_games_played), away: num(pb.away_games_played) } : { home: null, away: null };
}

/* opts = { data, from, to, replayFrom, explainer, regime } -> { rows, refused }.
   explainer: also carry each game's explainer terms (lib/edgedesk_explainer.js
   termsFromProjection — the function the live board uses)
   regime: also carry each side's v1 regime flag and its games played this
   season before the game (the projection's own count) */
function replayRows(opts) {
  var DATA = path.resolve(String(opts.data)), FROM = opts.from, TO = opts.to, REPLAY_FROM = opts.replayFrom || 2004;
  var games = [];
  for (var y = REPLAY_FROM; y <= TO; y++) {
    var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
    if (!fs.existsSync(f)) continue;
    readCsv(f).forEach(function (r) {
      var hp = num(r.home_points), ap = num(r.away_points);
      games.push({ game_id: String(r.game_id), season: num(r.season), week: num(r.week), kick: Date.parse(r.start_date) || 0,
        home: r.home_team, away: r.away_team, home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
        home_conference: r.home_conference, away_conference: r.away_conference,
        neutral_site: String(r.neutral_site).toLowerCase() === 'true', home_points: hp, away_points: ap, completed: hp != null && ap != null });
    });
  }
  games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week) || String(a.game_id).localeCompare(String(b.game_id)); });
  var market = {}, fm = path.join(DATA, 'out', 'market.csv');
  if (!fs.existsSync(fm)) throw new Error('missing ' + fm + ' — run research/build_market.py');
  readCsv(fm).forEach(function (r) { market[r.game_id] = { open: num(r.spread_open), close: num(r.spread_close) }; });

  var st = E.strength.newState();
  st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
  st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
  st.lmeanPts = P.rating.league_mean_pts;
  st.season = REPLAY_FROM;
  var rows = [], season = REPLAY_FROM, refused = 0;
  var X = opts.explainer ? require(path.join(HERE, '..', '..', '..', 'lib', 'edgedesk_explainer.js')) : null;
  var RI = opts.explainer ? regimeInputs(DATA) : null;
  var RF = opts.regime ? regimeFlags(DATA) : null;
  games.forEach(function (g) {
    if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
    if (!g.completed) return;
    if (g.season >= FROM && g.home_fbs && g.away_fbs) {
      var out = E.projectGame({ season: g.season, week: g.week, state: st,
        game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true, neutral_site: g.neutral_site },
        teams: { home: { conference: g.home_conference }, away: { conference: g.away_conference } } });
      if (out.status === 'PREDICTED') {
        var unc = (out.layers && out.layers.uncertainty) || {}, mk = market[g.game_id] || {};
        rows.push({ game_id: g.game_id, season: g.season, week: g.week, kick: g.kick, home: g.home, away: g.away,
          fair: out.model.fair_spread, sigma: num(unc.sigma), sigma_base: num(unc.sigma_base),
          open: mk.open != null ? mk.open : null, close: mk.close != null ? mk.close : null,
          margin: g.home_points - g.away_points,
          terms: X ? X.termsFromProjection(out, { home: RI.side(g.season, g.home), away: RI.side(g.season, g.away) }) : undefined,
          regime: RF ? { home: RF(g.season, g.home), away: RF(g.season, g.away) } : undefined,
          games_played: RF ? gamesPlayed(out) : undefined });
      } else refused++;
    }
    E.ingest.absorbGame(st, { home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
      neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points });
    if (RI) RI.played(g.season, g.game_id, [g.home, g.away]);
  });
  return { rows: rows, refused: refused, replay_from: REPLAY_FROM, model_version: P.model_version };
}

module.exports = { replayRows: replayRows, readCsv: readCsv };

if (require.main === module) {
  var arg = function (name, dflt) { var i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1]; };
  var res = replayRows({ data: arg('data', path.join(HERE, '.cache')), from: +arg('from', 2021), to: +arg('to', 2025), explainer: process.argv.indexOf('--explainer') >= 0 });
  var out = arg('out', null);
  if (out) fs.writeFileSync(out, JSON.stringify(res));
  console.error('[replay] ' + res.rows.length + ' rows; refused ' + res.refused);
}
