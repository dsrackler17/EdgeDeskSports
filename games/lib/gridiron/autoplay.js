/* ===========================================================================
   GRIDIRON — playing a game without a pair of hands on it.

   One function: take a game the engine created and advance it, asking the AI
   for every call neither the player is making nor the rules decide. It is the
   same door the player's taps go through — step() — so a simulated game and a
   played game are the same game.

   Used by: quick play, Coach Mode's opposing sideline, "play it out" when the
   result is no longer in doubt, and the ten-thousand-game test that keeps the
   football honest.
   =========================================================================== */
(function (root) {
  'use strict';

  var G = root.EDGridiron || (typeof require === 'function' ? require('./engine.js') : null);
  var AI = root.EDGridironAI || (typeof require === 'function' ? require('./ai.js') : null);
  var F = root.EDFootball || (typeof require === 'function' ? require('./football.js') : null);

  /* THE CALL FOR ONE SNAP, from whichever coach owns it. */
  function callFor(g, opts) {
    opts = opts || {};
    var sit = G.situation(g), off = sit.offense, def = sit.defense;
    var offT = G.teamOf(g, off), defT = G.teamOf(g, def);
    /* THE TIER BELONGS TO THE COACH, NOT TO THE SNAP. Both sides of a snap are
       called here, and giving them the same tier makes a difficulty test
       measure nothing — so each side is asked at its own level. */
    function tierFor(side) {
      return (opts.tiers && opts.tiers[side]) || opts.difficulty || g.cfg.difficulty;
    }
    var diff = tierFor(off), diffDef = tierFor(def);

    if (sit.phase === 'kickoff') return { type: 'kickoff' };
    if (sit.phase === 'halftime') return { type: 'halftime_done' };
    var ai = g.aiRand || g.rand;
    if (sit.phase === 'pat') {
      /* two points when the score says to, and not otherwise */
      var d = g.score[g.pendingScore.side] - g.score[G.other(g.pendingScore.side)];
      var late = g.quarter >= g.cfg.quarters;
      var want = late && (d === -2 || d === -5 || d === 1 || d === -10);
      return { type: want ? 'two' : 'pat', play: 'power', formation: 'goalline', def: 'goal_line_d' };
    }

    var tempo = AI.tempoFor(sit);
    if (AI.shouldKneel(sit) && g.timeouts[def] === 0) {
      return { type: 'play', play: 'kneel', formation: 'i_form', def: 'base_3', tempo: 'grind' };
    }

    var defCall = AI.callDefense({
      sit: sit, difficulty: diffDef, rand: ai,
      oppOffense: offT.offense, oppMem: g.mem[off], mem: g.defMem[def]
    });

    if (sit.down === 4) {
      var d4 = AI.fourthDown({ sit: sit, difficulty: diff, rand: ai });
      if (d4.type !== 'play') return { type: d4.type };
    }

    var oc = AI.callOffense({
      sit: sit, team: offT, difficulty: diff, rand: ai,
      mem: g.mem[off], defMem: g.defMem[def], tempo: tempo
    });
    oc.def = defCall.key;
    return oc;
  }

  /* Advance the game until it is over, or until `until` says stop. */
  function playOut(g, opts) {
    opts = opts || {};
    var guard = 0, until = opts.until;
    while (!g.over && guard++ < 2000) {
      if (until && until(g)) break;
      var call = opts.call ? opts.call(g) : callFor(g, opts);
      var r = G.step(g, call);
      if (!r.ok) break;
      if (opts.each) opts.each(g, r);
    }
    return g;
  }

  /* One whole game, from nothing, for a test or a quick result. */
  function simulate(o) {
    var g = G.createGame(o);
    playOut(g, o);
    return { game: g, box: G.boxScore(g), score: { home: g.score.home, away: g.score.away } };
  }

  var API = { callFor: callFor, playOut: playOut, simulate: simulate };
  root.EDGridironAuto = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
