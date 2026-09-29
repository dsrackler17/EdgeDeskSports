/* ===========================================================================
   EdgeDesk player props — THE SERVING LAYER (Phase I, the committed half).

   The website never reads raw provider payloads and never receives history
   it has to crunch. Per league it reads prepared, PACKED artifacts (the
   kernel's wire format, lib/player_props.js › wire, which also unpacks them):

     football/props/published/board_<league>.json
        the board: one short array per player-market (projection, reference
        probability, market consensus, best price, EV, confidence, data
        quality, decision, movement) plus lookup tables for the games,
        players, markets and model versions — what the table needs, no more
     football/props/published/<league>/<game_id>.json
        the research CARD, opened on demand: the model half of every prop in
        the game (distribution, drivers, confidence and data-quality inputs,
        versions) with each player's context stored once. It changes only
        when a model input changes, so a quote refresh does not rewrite it.
     football/props/published/<league>/<game_id>.market.json
        only when a quote exists: the observed quotes each book currently
        lists for the game and each prop's movement summary. The card's
        prices, ladders, EV, decision and explanation are re-derived from it
        by the kernel's reprice(), in the page and in the AI desk alike.

   plus football/props/published/status.json (what ran, when, with what).
   The same records are served from Supabase by props.v_player_props_board and
   the props.ai_* functions when the database is configured; the page falls
   back to these files, which is how the static site has always worked.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const io = require('./lib/io.js');
const EDP = require('../../lib/player_props.js');
const { writeIfChanged, strip } = require('../../tools/football/write_if_changed.js');

const OUT = path.join(io.ROOT, 'football', 'props', 'published');
const BOARD_SCHEMA = 'edgedesk_props_board_v1';
const GAME_SCHEMA = 'edgedesk_props_game_v1';
const MARKET_SCHEMA = 'edgedesk_props_market_v1';
const STATUS_SCHEMA = 'edgedesk_props_status_v1';

/* one array element (or object entry) per line: a changed prop is a changed
   line, which keeps the history of a busy artifact readable and small */
function linesJson(obj, listKeys) {
  const parts = Object.keys(obj).map((k) => {
    const v = obj[k];
    if (listKeys.indexOf(k) >= 0 && Array.isArray(v)) return JSON.stringify(k) + ':[' + (v.length ? '\n' + v.map((x) => JSON.stringify(x)).join(',\n') + '\n' : '') + ']';
    if (listKeys.indexOf(k) >= 0 && v && typeof v === 'object') { const ks = Object.keys(v); return JSON.stringify(k) + ':{' + (ks.length ? '\n' + ks.map((x) => JSON.stringify(x) + ':' + JSON.stringify(v[x])).join(',\n') + '\n' : '') + '}'; }
    return JSON.stringify(k) + ':' + JSON.stringify(v);
  });
  return '{' + parts.join(',') + '}\n';
}
function writeLines(file, obj, listKeys) {
  try { if (fs.existsSync(file) && JSON.stringify(strip(JSON.parse(fs.readFileSync(file, 'utf8')))) === JSON.stringify(strip(obj))) return 'unchanged'; } catch (_) { /* unreadable: write */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, linesJson(obj, listKeys));
  return 'written';
}

function gameIndex(g) {
  return { game_id: g.game_id, kickoff: g.kickoff_utc, home: g.home_name, away: g.away_name, home_id: g.home, away_id: g.away, n_props: g.n_props,
    spread_home: g.market_context ? g.market_context.home_line : null, total: g.market_context ? g.market_context.total : null,
    market_basis: g.market_context ? g.market_context.basis : null, wind_mph: g.forecast ? g.forecast.wind_mph : null, temp_f: g.forecast ? g.forecast.temp_f : null,
    roof: g.roof || (g.forecast && g.forecast.dome ? 'closed' : null) };
}

function writeBoard(scored, meta) {
  const league = scored.league.toLowerCase();
  const props = scored.props.slice().sort((a, b) => (a.kickoff_utc < b.kickoff_utc ? -1 : a.kickoff_utc > b.kickoff_utc ? 1 : 0) || String(a.player).localeCompare(String(b.player)) || String(a.market_key).localeCompare(String(b.market_key)));
  const board = EDP.wire.packBoard({
    schema: BOARD_SCHEMA, league: scored.league, season: scored.season, generated_at: scored.generated_at, as_of: scored.generated_at,
    rule: 'Research, not picks. MODEL is EdgeDesk\'s distribution; MARKET is the observed sportsbook consensus; EDGE is their difference at an exact price. Only observed quotes are ever priced.',
    quotes: meta.quotes || { captured: false, provider: 'the-odds-api', note: 'No observed sportsbook prop quote has been captured for these games yet: every row shows the model only.' },
    model_versions: Array.from(new Set(scored.props.map((p) => p.model.model_version))).sort(),
    feature_version: scored.props.length ? scored.props[0].model.feature_version : null,
    games: scored.games.map(gameIndex), sources: scored.sources,
    wire: 'Packed rows: lib/player_props.js › EDProps.wire.expandBoard(board) returns one object per row.'
  }, props);
  const written = { board: writeLines(path.join(OUT, 'board_' + league + '.json'), board, ['rows', 'players']), games: 0, markets: 0 };
  /* per game: the card, and the market file only while a quote exists; files
     for games no longer upcoming are removed */
  const dir = path.join(OUT, league);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  const byGame = new Map();
  props.forEach((p) => { let a = byGame.get(p.game_id); if (!a) { a = []; byGame.set(p.game_id, a); } a.push(p); });
  scored.games.forEach((g) => {
    const gp = byGame.get(g.game_id) || [];
    const cardF = path.join(dir, g.game_id + '.json'), mktF = path.join(dir, g.game_id + '.market.json');
    keep.add(path.basename(cardF));
    const card = EDP.wire.packCard(gp, g, { league: scored.league, generated_at: scored.generated_at });
    if (writeLines(cardF, card, ['props', 'players']) === 'written') written.games++;
    const mk = EDP.wire.packMarket(gp, { league: scored.league, game_id: g.game_id, as_of: scored.generated_at });
    if (mk) { keep.add(path.basename(mktF)); if (writeLines(mktF, mk, ['props']) === 'written') written.markets++; }
  });
  fs.readdirSync(dir).forEach((n) => { if (/\.json$/.test(n) && !keep.has(n)) fs.unlinkSync(path.join(dir, n)); });
  return written;
}

function writeStatus(status) {
  const f = path.join(OUT, 'status.json');
  const prev = io.readJson(f, { schema: STATUS_SCHEMA, stages: {} });
  const merged = Object.assign({}, prev, status, { schema: STATUS_SCHEMA, stages: Object.assign({}, prev.stages || {}, status.stages || {}) });
  return writeIfChanged(f, merged, { pretty: true, newline: true });
}

module.exports = { OUT, BOARD_SCHEMA, GAME_SCHEMA, MARKET_SCHEMA, STATUS_SCHEMA, writeBoard, writeStatus, linesJson };
