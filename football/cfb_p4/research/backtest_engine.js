#!/usr/bin/env node
/* ============================================================================
   EdgeDesk CFB Power 4 — backtest the ENGINE, not a proxy for it.

   The python training run scores `blended_margin`: the opponent-adjusted rating
   difference plus home-field advantage, blended with the fresh in-season track.
   That is the model's core, but it is NOT what the engine publishes. The engine
   publishes a nine-term sum — rating, HFA, quarterback, stylistic matchup,
   travel, schedule stress, injuries, rivalry and conference — and a headline
   accuracy number that describes a different quantity than the one the product
   outputs is not a headline, it is a coincidence.

   So this replays the SHIPPED engine.js over the held-out seasons, cold, in
   kickoff order, and records `model.fair_spread` exactly as a user would have
   seen it, from state that contains only games that had already kicked off.

     node football/cfb_p4/research/backtest_engine.js \
          --data /home/user/cfbdata --from 2022 --to 2025

   Every game is projected from the PREGAME state and only then absorbed. The
   replay starts eight seasons before the window with the rating state zeroed,
   because the shipped seeds already contain the results being projected.
   ============================================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
global.window = global.window || global;
require(path.join(HERE, '..', 'params.js'));
var E = require(path.join(HERE, '..', 'engine.js'));
var P = global.window.EDCfbP4Params;

function arg(name, dflt) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  var v = process.argv[i + 1];
  return (v == null || v.slice(0, 2) === '--') ? true : v;
}
var DATA = String(arg('data', '/home/user/cfbdata'));
var FROM = parseInt(arg('from', 2022), 10);
var TO = parseInt(arg('to', 2025), 10);
var REPLAY_FROM = parseInt(arg('replay-from', FROM - 8), 10);

/* ---------- a CSV reader that survives quoted commas ---------------------- */
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

/* ---------- inputs -------------------------------------------------------- */
var games = [];
for (var y = REPLAY_FROM; y <= TO; y++) {
  var f = path.join(DATA, 'sched', 'sched_' + y + '.csv');
  if (!fs.existsSync(f)) continue;
  readCsv(f).forEach(function (r) {
    var hp = num(r.home_points), ap = num(r.away_points);
    games.push({
      game_id: r.game_id, season: num(r.season), week: num(r.week),
      kick: Date.parse(r.start_date) || 0,
      home: r.home_team, away: r.away_team,
      home_fbs: r.home_division === 'fbs', away_fbs: r.away_division === 'fbs',
      home_conference: r.home_conference, away_conference: r.away_conference,
      neutral_site: String(r.neutral_site).toLowerCase() === 'true',
      home_points: hp, away_points: ap,
      completed: hp != null && ap != null
    });
  });
}
games.sort(function (a, b) { return (a.kick - b.kick) || (a.season - b.season) || (a.week - b.week); });

/* closing lines, one row per game */
var market = {};
(function () {
  var f = path.join(DATA, 'out', 'market.csv');
  if (!fs.existsSync(f)) { console.error('[warn] no market.csv — market comparison skipped'); return; }
  readCsv(f).forEach(function (r) {
    market[r.game_id] = { spread_close: num(r.spread_close), total_close: num(r.total_close) };
  });
})();

/* team-game efficiency, so the matchup layer is live rather than frozen on the
   shipped seed. Absent, the replay still runs and the matchup term reports
   itself unavailable — which is the correct behaviour, not a silent zero. */
var effByGame = {};
var EFF_FEATS = (P.efficiency && P.efficiency.feats) || [];
(function () {
  var f = path.join(DATA, 'out', 'team_game.csv');
  if (!fs.existsSync(f)) { console.error('[warn] no team_game.csv — matchup layer stays on the shipped seed'); return; }
  readCsv(f).forEach(function (r) {
    var o = {}, k;
    for (k = 0; k < EFF_FEATS.length; k++) {
      var v = num(r[EFF_FEATS[k]]);
      if (v != null) o[EFF_FEATS[k]] = v;
    }
    (effByGame[r.game_id] = effByGame[r.game_id] || {})[E.normKey(r.team_key || r.team)] = o;
  });
})();

/* ---------- cold replay --------------------------------------------------- */
var st = E.strength.newState();
st.r = {}; st.r0 = {}; st.rf = {}; st.n = {};
st.scoring = {}; st.gamesThisSeason = {}; st.eff = {}; st.effMean = {};
st.lmeanPts = P.rating.league_mean_pts;
st.season = REPLAY_FROM;

var rows = [], season = REPLAY_FROM, projected = 0, refused = 0, refusals = {};
games.forEach(function (g) {
  if (g.season !== season) { E.ingest.seasonBreak(st); season = g.season; }
  if (!g.completed) return;

  if (g.season >= FROM && g.season <= TO && g.home_fbs && g.away_fbs) {
    var out = E.projectGame({
      season: g.season, week: g.week, state: st,
      game: { home: g.home, away: g.away, home_fbs: true, away_fbs: true,
              neutral_site: g.neutral_site },
      teams: { home: { conference: g.home_conference },
               away: { conference: g.away_conference } }
    });
    if (out.status === 'PREDICTED') {
      projected++;
      var mk = market[g.game_id] || {};
      rows.push({
        season: g.season, week: g.week,
        fair_spread: out.model.fair_spread,
        fair_total: out.model.fair_total,
        home_win_prob: out.model.home_win_prob,
        margin: g.home_points - g.away_points,
        total_pts: g.home_points + g.away_points,
        spread_close: mk.spread_close, total_close: mk.total_close,
        n_games: Math.min(E.strength.games(st, E.normKey(g.home)),
                          E.strength.games(st, E.normKey(g.away)))
      });
    } else {
      refused++;
      refusals[out.status] = (refusals[out.status] || 0) + 1;
    }
  }

  var ts = effByGame[g.game_id];
  E.ingest.absorbGame(st, {
    home: g.home, away: g.away, home_fbs: g.home_fbs, away_fbs: g.away_fbs,
    neutral_site: g.neutral_site, home_points: g.home_points, away_points: g.away_points,
    team_stats: ts ? { home: ts[E.normKey(g.home)] || null, away: ts[E.normKey(g.away)] || null } : null
  });
});

/* ---------- score it ------------------------------------------------------ */
function mean(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : null; }
function mae(a, b) {
  var d = [], i;
  for (i = 0; i < a.length; i++) if (a[i] != null && b[i] != null) d.push(Math.abs(a[i] - b[i]));
  return { n: d.length, mae: mean(d) };
}
function binomP(k, n, p) {                       /* one-sided, normal approx with continuity */
  if (!n) return null;
  var z = (k - n * p - 0.5) / Math.sqrt(n * p * (1 - p));
  return 0.5 * (1 - erf(z / Math.SQRT2));
}
function erf(x) {
  var s = x < 0 ? -1 : 1; x = Math.abs(x);
  var t = 1 / (1 + 0.3275911 * x);
  var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

var withSpread = rows.filter(function (r) { return r.spread_close != null; });
/* the engine states the HOME side's fair spread as points the home team is
   expected to win by; the book states the home line with the opposite sign */
var mSpreadModel = mae(withSpread.map(function (r) { return r.fair_spread; }),
                       withSpread.map(function (r) { return r.margin; }));
var mSpreadMkt = mae(withSpread.map(function (r) { return r.spread_close; }),
                     withSpread.map(function (r) { return r.margin; }));
var withTotal = rows.filter(function (r) { return r.total_close != null && r.fair_total != null; });
var mTotalModel = mae(withTotal.map(function (r) { return r.fair_total; }),
                      withTotal.map(function (r) { return r.total_pts; }));
var mTotalMkt = mae(withTotal.map(function (r) { return r.total_close; }),
                    withTotal.map(function (r) { return r.total_pts; }));

var ats = {};
[0.5, 1, 1.5, 2, 3, 4, 6].forEach(function (th) {
  var s = withSpread.filter(function (r) {
    return Math.abs(r.fair_spread - r.spread_close) >= th && r.margin !== r.spread_close;
  });
  if (s.length < 40) return;
  var wins = s.filter(function (r) {
    return Math.sign(r.margin - r.spread_close) === Math.sign(r.fair_spread - r.spread_close);
  }).length;
  ats[th] = { n: s.length, wins: wins, win_pct: +(100 * wins / s.length).toFixed(2),
              binom_p_one_sided: +binomP(wins, s.length, 0.5).toFixed(4) };
});

/* win-probability calibration on what the engine actually published */
var wp = rows.filter(function (r) { return r.margin !== 0; });
var brier = mean(wp.map(function (r) {
  var y = r.margin > 0 ? 1 : 0;
  return Math.pow(r.home_win_prob - y, 2);
}));
var logloss = mean(wp.map(function (r) {
  var y = r.margin > 0 ? 1 : 0, p = Math.min(1 - 1e-6, Math.max(1e-6, r.home_win_prob));
  return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
}));

var result = {
  what: 'model.fair_spread as published by football/cfb_p4/engine.js',
  window: FROM + '-' + TO,
  replay_from: REPLAY_FROM,
  n_projected: projected,
  n_refused: refused,
  refusal_status: refusals,
  spread: { n: mSpreadModel.n,
            mae_model: +mSpreadModel.mae.toFixed(3),
            mae_market: +mSpreadMkt.mae.toFixed(3),
            delta: +(mSpreadModel.mae - mSpreadMkt.mae).toFixed(3) },
  total: withTotal.length ? { n: mTotalModel.n,
            mae_model: +mTotalModel.mae.toFixed(3),
            mae_market: +mTotalMkt.mae.toFixed(3),
            delta: +(mTotalModel.mae - mTotalMkt.mae).toFixed(3) } : null,
  ats_vs_close: ats,
  winprob: { n: wp.length, brier: +brier.toFixed(5), log_loss: +logloss.toFixed(5) }
};

console.log(JSON.stringify(result, null, 2));
var dest = path.join(DATA, 'out', 'backtest_engine.json');
try { fs.writeFileSync(dest, JSON.stringify(result, null, 2)); console.error('[write] ' + dest); }
catch (e) { console.error('[warn] could not write ' + dest + ': ' + e.message); }
