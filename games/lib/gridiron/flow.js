/* ===========================================================================
   GRIDIRON — THE FLOW.

   ONE AUTHORITATIVE PRESENTATION STATE for a game on the page.

   The engine (engine.js) owns the football: score, clock, down, possession.
   The stage (stage.js) owns the picture. What neither of them owns is WHERE
   THE PLAYER IS in the ritual of a snap — reading the call sheet, lined up
   and waiting on the snap, watching the play, reading the result, sitting
   through the half — and until this file that lived in a handful of booleans
   and timers spread across the page: `busy`, `pendingCall`, an auto-snap
   timer, a whistle watchdog. Two of those disagreeing is how a game locks up
   on a down it cannot leave.

   So the page has one state, named, with the legal moves between the states
   written down. A UI component asks the flow whether it may act; it does not
   keep a flag of its own. The debug panel and the tests read the same word.

   The states, in the order a snap moves through them:

     LOADING      the page is booting
     PRE_GAME     the matchup card, before kick off
     KICKOFF      a kick is about to be taken or is being shown
     PLAY_SELECT  the call sheet is open, nothing is lined up to snap
     PRE_SNAP     the eleven are set; the snap is the next thing that happens
     LIVE_PLAY    the ball is live
     PLAY_ENDING  the whistle has gone; the picture is settling
     RESULT       the play is booked; the result card is on the screen
     TRANSITION   between one down and the next call
     PAT          the try after a touchdown
     QUARTER_END  the quarter break banner
     HALFTIME     the halftime report
     GAME_OVER    the final

   Nothing here draws, decides a yard, or knows about a franchise.
   =========================================================================== */
(function (root) {
  'use strict';

  var STATES = ['LOADING', 'PRE_GAME', 'KICKOFF', 'PLAY_SELECT', 'PRE_SNAP', 'LIVE_PLAY',
    'PLAY_ENDING', 'RESULT', 'TRANSITION', 'PAT', 'QUARTER_END', 'HALFTIME', 'GAME_OVER'];

  /* the legal moves. A move not listed here is a bug, and is reported as one
     (and then allowed, because a game that refuses to continue is a worse bug
     than a game that continued from the wrong place). */
  var EDGES = {
    LOADING:     ['PRE_GAME', 'KICKOFF', 'PLAY_SELECT', 'GAME_OVER'],
    PRE_GAME:    ['TRANSITION', 'KICKOFF', 'PLAY_SELECT', 'PAT', 'HALFTIME', 'GAME_OVER', 'LOADING'],
    KICKOFF:     ['TRANSITION', 'PLAY_SELECT', 'GAME_OVER', 'PRE_GAME'],
    PLAY_SELECT: ['PRE_SNAP', 'TRANSITION', 'KICKOFF', 'PAT', 'HALFTIME', 'GAME_OVER', 'PRE_GAME', 'QUARTER_END'],
    PRE_SNAP:    ['LIVE_PLAY', 'PLAY_SELECT', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    LIVE_PLAY:   ['PLAY_ENDING', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    PLAY_ENDING: ['RESULT', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    RESULT:      ['TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    TRANSITION:  ['PLAY_SELECT', 'KICKOFF', 'PAT', 'QUARTER_END', 'HALFTIME', 'GAME_OVER', 'PRE_GAME'],
    PAT:         ['TRANSITION', 'KICKOFF', 'GAME_OVER', 'PRE_GAME'],
    QUARTER_END: ['PLAY_SELECT', 'KICKOFF', 'PAT', 'HALFTIME', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    HALFTIME:    ['KICKOFF', 'TRANSITION', 'GAME_OVER', 'PRE_GAME'],
    GAME_OVER:   ['PRE_GAME', 'LOADING', 'KICKOFF']
  };

  /* in these states the page is between plays and may accept a call, a snap
     or a menu; in every other state the controls are the football's */
  var IDLE = { PRE_GAME: 1, PLAY_SELECT: 1, PRE_SNAP: 1, GAME_OVER: 1, HALFTIME: 1, PAT: 1, KICKOFF: 1 };

  function create(opts) {
    opts = opts || {};
    var state = 'LOADING', since = now(), history = [], listeners = [];
    var warn = opts.warn || function (msg) { try { if (root.console) root.console.warn(msg); } catch (_) {} };
    function now() { return (root.performance && root.performance.now) ? root.performance.now() : Date.now(); }
    var self = {
      STATES: STATES,
      get: function () { return state; },
      is: function () {
        var i; for (i = 0; i < arguments.length; i++) if (arguments[i] === state) return true;
        return false;
      },
      /* between plays: the call sheet, the snap button and the menus may act */
      idle: function () { return !!IDLE[state]; },
      /* a play is in progress or being booked: nothing else may move the game */
      busy: function () { return state === 'LIVE_PLAY' || state === 'PLAY_ENDING' || state === 'RESULT' || state === 'TRANSITION'; },
      /* how long the page has sat in the current state, in ms */
      age: function () { return now() - since; },
      history: function () { return history.slice(); },
      on: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
      set: function (to, why) {
        if (STATES.indexOf(to) < 0) { warn('flow: unknown state ' + to); return state; }
        if (to === state) return state;
        var legal = (EDGES[state] || []).indexOf(to) >= 0;
        if (!legal) warn('flow: ' + state + ' -> ' + to + ' is not a listed move' + (why ? ' (' + why + ')' : ''));
        var from = state;
        state = to; since = now();
        history.push({ from: from, to: to, why: why || null, at: since });
        if (history.length > 200) history.shift();
        listeners.forEach(function (fn) { try { fn(to, from, why); } catch (_) {} });
        return state;
      },
      /* the same test a UI component would otherwise keep as its own flag */
      can: function (action) {
        switch (action) {
          case 'call':   return state === 'PLAY_SELECT' || state === 'PRE_SNAP';
          case 'snap':   return state === 'PRE_SNAP';
          case 'input':  return state === 'LIVE_PLAY';
          case 'menu':   return !!IDLE[state] || state === 'LOADING';
          case 'kick':   return state === 'KICKOFF';
          case 'pat':    return state === 'PAT';
          default:       return false;
        }
      }
    };
    return self;
  }

  var API = { STATES: STATES, EDGES: EDGES, create: create };
  root.EDGridironFlow = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
