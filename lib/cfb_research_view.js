/* ===========================================================================
   EdgeDesk CFB research view — ONE presentation object per college game.

   The question it answers is "what does a reader need to see first?", and it
   answers it ONLY from numbers the engine and the board have already
   produced. It is a presentation layer, nothing more:

     - it computes no projection. The raw margin, the win probability, the
       confidence, the cover probability and every stored number are the
       engine's (football/cfb_p4/engine.js projectGame) and are read, never
       recomputed or written back;
     - it fills nothing in. A value the game does not carry stays null and the
       view says it is unavailable; nothing is estimated to make a cell full;
     - every threshold lives in CONFIG below, each one either an existing
       EdgeDesk threshold (named where it comes from) or a presentation
       threshold of this layer (said so). The UI reads the result; it never
       re-derives a label, a gap or a side of its own.

   Browser: window.EDCfbResearchView. Node: require('./cfb_research_view.js').
   The adapter that assembles the input from page state lives in app.html
   (fbP4ViewFor), so this file never reads the page.

   CONVENTIONS
     margin      home perspective, + = home favoured by (engine fair_spread and
                 the board's market spread_line both use it)
     book line   what a sportsbook prints for a side: negative = favoured
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EDCfbResearchView = factory();
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var V = { version: 'cfb_research_view/1' };

  function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : null; }
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    if (b) for (k in b) if (Object.prototype.hasOwnProperty.call(b, k) && b[k] != null) o[k] = b[k];
    return o;
  }

  /* ------------------------------------------------------------ the rules */
  V.CONFIG = {
    /* football/cfb_p4/engine.js fairLine.FLOOR — the engine decides the floor;
       this copy only lets a caller check the engine's display against it */
    near_pickem_floor: 1
  };
  V.config = function (over) { return merge(V.CONFIG, over); };

  /* --------------------------------------------------------- formatting */
  /* "Ole Miss -6.5": a side and the book line it lays */
  function laying(team, pts, dp) { return team + ' -' + Math.abs(pts).toFixed(dp == null ? 1 : dp); }
  V.format = { laying: laying };

  /* ================================================ STEP 1: THE FAIR LINE
     The engine publishes the raw margin (model.fair_spread) and, beside it,
     the line a reader is shown (model.display_fair_spread): the same number,
     except that a near pick'em (|raw| < 1) is shown at a one-point floor on
     the side the model measurably favours, with an exact tie broken by the
     engine's own deterministic hierarchy (fairLine.tiebreak). This reads
     those fields; it does not re-derive them. A model that publishes no
     display line shows its raw number, exactly as fbFairDisp() does. */
  V.fairLine = function (p, game) {
    if (!p || p.status !== 'PREDICTED' || !p.model || num(p.model.fair_spread) == null) return null;
    var m = p.model, raw = m.fair_spread;
    var home = (game && game.home) || (p.game && p.game.home) || 'Home';
    var away = (game && game.away) || (p.game && p.game.away) || 'Away';
    var disp = num(m.display_fair_spread) != null ? m.display_fair_spread : raw;
    var side = (m.display_side === 'home' || m.display_side === 'away') ? m.display_side
      : (disp > 0 ? 'home' : (disp < 0 ? 'away' : null));
    var near = m.is_near_pickem === true;
    var fav = side === 'home' ? home : (side === 'away' ? away : null);
    var dog = side === 'home' ? away : (side === 'away' ? home : null);
    /* the RAW margin, stated for the side the display names (>= 0 unless the
       engine's tiebreak named a side on an exact tie, where it is 0) */
    var favMargin = side === 'away' ? -raw : raw;
    if (favMargin === 0) favMargin = 0;           /* no "-0" */
    return {
      raw_projected_margin: raw,
      display_fair_spread: disp,
      display_side: side,
      favorite_team: fav,
      underdog_team: dog,
      is_near_pickem: near,
      raw_favorite_margin: favMargin,
      fair_line_text: fav ? laying(fav, disp) : (home + ' ' + (disp === 0 ? '0.0' : (-disp > 0 ? '+' : '') + (-disp).toFixed(1))),
      raw_line_text: fav ? (favMargin === 0 ? fav + ' ±0.00 (an exact tie before the tiebreak)' : laying(fav, favMargin, 2)) : null,
      basis: m.display_basis || null
    };
  };

  /* ============================================================ THE BUILD
     input = {
       game:        {game_id, home, away, kickoff}
       projection:  the engine's projectGame output, unmodified
     } */
  V.build = function (input, over) {
    input = input || {};
    var game = input.game || {}, p = input.projection || null;
    var fl = V.fairLine(p, game);
    return {
      contract: V.version,
      game_id: game.game_id == null ? null : String(game.game_id),
      home: game.home || null, away: game.away || null,
      projected: !!fl,
      projection_status: p ? (p.status || null) : null,
      fair: fl,
      raw_projected_margin: fl ? fl.raw_projected_margin : null,
      display_fair_spread: fl ? fl.display_fair_spread : null,
      favorite_team: fl ? fl.favorite_team : null,
      underdog_team: fl ? fl.underdog_team : null,
      is_near_pickem: fl ? fl.is_near_pickem : false
    };
  };

  return V;
});
