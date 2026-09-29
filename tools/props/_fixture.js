/* ===========================================================================
   The player-props test fixture: one NFL game (2026_04_LA_PHI, eight players)
   as the build published it, the registry entries for its two rosters, the
   board header it was published under, and an Odds API per-event response
   with INVENTED prices. Every test that needs a priced board builds it from
   these through the production code — capture.parseEvent / mergeGame, then
   build.reprice — so nothing here depends on the current week.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../../football/props/capture.js');
const B = require('../../football/props/build.js');
const REG = require('../../football/props/registry.js');

const DIR = path.join(__dirname, 'fixtures');
const GID = '2026_04_LA_PHI';
function read(f) { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
function load() {
  return { game: read('game_' + GID + '.json'), registry: read('registry_la_phi.json'), board: read('board_la_phi.json'), odds: read('odds_event_la_phi.json') };
}
const KICKOFF = Date.parse('2026-10-04T17:00:00Z');
/* the fixture's own "now": Saturday morning before the game */
const NOW = Date.parse('2026-10-03T15:00:00Z');

/* capture the fixture odds at observedAt; `edit(body)` may change prices */
function capture(F, observedAtMs, prevMarket, edit) {
  const body = JSON.parse(JSON.stringify(F.odds));
  if (edit) edit(body);
  const game = { game_id: GID, home: 'PHI', away: 'LA', kickoff: new Date(KICKOFF).toISOString() };
  const unmapped = [];
  const obs = new Date(observedAtMs).toISOString();
  const quotes = C.parseEvent(body, game, F.registry, {}, obs, 'nfl', unmapped);
  const m = C.mergeGame(prevMarket ? JSON.parse(JSON.stringify(prevMarket)) : null, quotes, game, obs);
  return { quotes, unmapped, file: m.market, fresh: m.fresh };
}
/* the market object build / record read, from one game's market file */
function marketOf(file, unmapped) {
  return { captured_at: file ? file.captured_at : null, props: file ? file.props : {}, history: file ? file.history : {}, open: file ? file.open : {}, close: file && file.close ? file.close : {}, unmapped: unmapped || [] };
}
/* the evaluated board for the fixture game at `now` against a market file */
function board(F, nowMs, file, unmapped) {
  return B.reprice('nfl', nowMs, { dry: true, board: F.board, gameFiles: { [GID]: F.game }, market: marketOf(file, unmapped), record: null });
}
function candidates(F, team) { return REG.candidatesFor(F.registry, team); }

module.exports = { DIR, GID, KICKOFF, NOW, load, capture, marketOf, board, candidates };
