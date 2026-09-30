/* ============================================================================
   THE NFL REGIME SIGNAL (audit 2026-09-30 follow-up #4) — one definition, for
   the fit (tools/football/nfl_regime.js), the board (app.html fbNflGameReq)
   and, through the board's module, the published NFL slate.

   Per team-game, from nflverse games.csv rows (the head coach and the starting
   QB of every game), every input known before kickoff:
     coach    the game's head coach is not the one who coached the team's last
              game of the previous season (a first-year head coach)
     new_qb   the game's starter is not last season's primary QB (most starts)
     qb_out   the team has started a QB this season and this game's starter is
              not its established starter (most starts this season so far;
              ties to the most recent)

   The price, per side, in points (the fitted coefficients ship in
   football/validation/nfl_regime.json `shipped.coef`):
        shift = (b_coach·coach + b_new_qb·new_qb)·exp(−λ·games this season) + b_qb_out·qb_out
   football/engine.js adds shift_home − shift_away to the fair spread as its
   own term, ONLY when the record says it is priced (the walk-forward
   promotion rule in the fit).

   Node and browser (UMD). No dependencies.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDNflRegime = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'edgedesk_nfl_regime_v1';
  function num(v) { if (v == null || v === '' || v === 'NA') return null; var n = Number(v); return isFinite(n) ? n : null; }
  function str(v) { return v == null || v === '' || v === 'NA' ? null : String(v); }

  function mode(counts, recent) {
    var best = null, bn = -1, k;
    for (k in counts) if (Object.prototype.hasOwnProperty.call(counts, k)) {
      if (counts[k] > bn || (counts[k] === bn && recent && recent[k] > recent[best])) { best = k; bn = counts[k]; }
    }
    return best;
  }

  /* rows: games.csv objects (game_id, season, week, gameday, home_team,
     away_team, result or home_score, home_qb_id, away_qb_id, home_qb_name,
     away_qb_name, home_coach, away_coach). Returns { 'game_id|home': sig, ... } */
  function signals(rows) {
    var games = (rows || []).map(function (g) {
      var played = num(g.result) != null || (num(g.home_score) != null && num(g.away_score) != null);
      return { id: str(g.game_id), season: num(g.season), date: str(g.gameday) || '', home: str(g.home_team), away: str(g.away_team), played: played,
        home_qb: str(g.home_qb_id), away_qb: str(g.away_qb_id), home_qb_name: str(g.home_qb_name), away_qb_name: str(g.away_qb_name),
        home_coach: str(g.home_coach), away_coach: str(g.away_coach) };
    }).filter(function (g) { return g.id && g.season != null && g.home && g.away; });
    games.sort(function (a, b) { return a.season - b.season || a.date.localeCompare(b.date) || a.id.localeCompare(b.id); });
    var lastCoach = {}, starts = {}, recent = {}, primaryPrev = {}, coachPrev = {}, played = {}, out = {}, season = null, seq = 0;
    function close(s) {
      var t;
      for (t in starts) if (starts[t][s]) primaryPrev[t + '|' + (s + 1)] = mode(starts[t][s], recent[t] && recent[t][s]);
      for (t in lastCoach) if (lastCoach[t][s]) coachPrev[t + '|' + (s + 1)] = lastCoach[t][s];
    }
    games.forEach(function (g) {
      if (season != null && g.season !== season) close(season);
      season = g.season;
      ['home', 'away'].forEach(function (side) {
        var t = g[side], qb = g[side + '_qb'], coach = g[side + '_coach'];
        var st = (starts[t] && starts[t][g.season]) || null, est = st ? mode(st, recent[t] && recent[t][g.season]) : null;
        var pc = coachPrev[t + '|' + g.season] || null, pq = primaryPrev[t + '|' + g.season] || null;
        out[g.id + '|' + side] = { team: t, coach: coach, prev_coach: pc, starter: qb, starter_name: g[side + '_qb_name'],
          prev_primary_qb: pq, established_qb: est, games_this_season: (played[t] && played[t][g.season]) || 0,
          f: { coach: coach && pc ? (coach !== pc ? 1 : 0) : 0, new_qb: qb && pq ? (qb !== pq ? 1 : 0) : 0, qb_out: qb && est ? (qb !== est ? 1 : 0) : 0 } };
      });
      if (!g.played) return;
      ['home', 'away'].forEach(function (side) {
        var t = g[side], qb = g[side + '_qb'], coach = g[side + '_coach'];
        played[t] = played[t] || {}; played[t][g.season] = (played[t][g.season] || 0) + 1;
        if (coach) { lastCoach[t] = lastCoach[t] || {}; lastCoach[t][g.season] = coach; }
        if (qb) {
          starts[t] = starts[t] || {}; starts[t][g.season] = starts[t][g.season] || {}; starts[t][g.season][qb] = (starts[t][g.season][qb] || 0) + 1;
          recent[t] = recent[t] || {}; recent[t][g.season] = recent[t][g.season] || {}; recent[t][g.season][qb] = ++seq;
        }
      });
    });
    return out;
  }

  function shiftOf(f, gp, b) {
    if (!f || !b) return 0;
    return ((b.coach || 0) * f.coach + (b.new_qb || 0) * f.new_qb) * Math.exp(-(b.lambda || 0) * (gp || 0)) + (b.qb_out || 0) * f.qb_out;
  }
  function whyOf(s) {
    var w = [];
    if (s.f.coach) w.push('first-year head coach (' + s.coach + (s.prev_coach ? '; ' + s.prev_coach + ' last season' : '') + ')');
    if (s.f.qb_out) w.push('starting QB out: ' + (s.starter_name || s.starter) + ' starts in place of the established starter');
    else if (s.f.new_qb) w.push('new starting QB: ' + (s.starter_name || s.starter) + ' (not last season’s primary starter)');
    return w.join('; ') || null;
  }
  /* the engine's request field for one game: { home, away, priced, version }.
     fit = football/validation/nfl_regime.json ({promoted, shipped: {coef}}) */
  function forGame(sig, gameId, fit) {
    if (!sig || !gameId) return null;
    var h = sig[gameId + '|home'], a = sig[gameId + '|away'];
    if (!h || !a) return null;
    var coef = fit && fit.shipped ? fit.shipped.coef : null, priced = !!(fit && fit.promoted === true && coef);
    function side(s) {
      var flagged = !!(s.f.coach || s.f.new_qb || s.f.qb_out);
      return { team: s.team, flags: s.f, games_this_season: s.games_this_season, flagged: flagged,
        shift_points: coef ? Math.round(shiftOf(s.f, s.games_this_season, coef) * 1000) / 1000 : null, why: whyOf(s) };
    }
    return { version: VERSION, priced: priced, home: side(h), away: side(a) };
  }

  return { VERSION: VERSION, signals: signals, shiftOf: shiftOf, forGame: forGame, whyOf: whyOf };
});
