/* ===========================================================================
   EdgeDesk player props — THE WAREHOUSE BUILD (Phase A + B).

   historical source files → per-season canonical rows (cached) → identity
   (dim_player, bridge) → QA gates → curated facts, with market context and
   pregame availability joined by the canonical game id.

     NFL 2011–present  (nflverse)                    CORE
     CFB 2014–present  (SportsDataverse / cfbfastR)  CORE
     CFB 2004–2013     only with --deep-cfb          OPTIONAL: research only;
                                                     never in a production fold

   IDEMPOTENT AND RESUMABLE. Every completed season is normalised once into
   .cache/props/work/<league>/season_<y>.json.gz with the adapter version in the
   file; a second run reads it back, a changed adapter rebuilds it, the season
   in progress is always rebuilt. Nothing here writes to the database: the sync
   job (db.js) loads what this produces, with natural keys, so loading twice is
   loading once.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const io = require('./lib/io.js');
const nflSrc = require('./sources/nfl.js');
const cfbSrc = require('./sources/cfb.js');
const identity = require('./identity.js');
const qa = require('./qa.js');

const ADAPTER_VERSION = 'wh3';
const WINDOWS = { NFL: { start: 2011 }, CFB: { start: 2014, deep_start: 2004 } };
const WORK = path.join(io.CACHE, 'work');

function seasonsFor(league, opts) {
  const cur = opts.currentSeason || io.currentSeason();
  const start = opts.from || (league === 'CFB' && opts.deepCfb ? WINDOWS.CFB.deep_start : WINDOWS[league].start);
  const end = opts.to || cur;
  const out = []; for (let y = start; y <= end; y++) out.push(y);
  return out;
}

function cachePath(league, season) { return path.join(WORK, league.toLowerCase(), 'season_' + season + '.json.gz'); }
function readCache(league, season) {
  try { const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath(league, season))).toString('utf8')); return o.adapter_version === ADAPTER_VERSION ? o : null; } catch (_) { return null; }
}
function writeCache(league, season, obj) {
  const f = cachePath(league, season);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const o = Object.assign({ adapter_version: ADAPTER_VERSION, built_at: new Date().toISOString() }, obj);
  if (o.rosters instanceof Map) o.rosters = Array.from(o.rosters.values());
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(o)));
}

async function loadLeagueSeasons(league, opts) {
  opts = opts || {};
  const cur = opts.currentSeason || io.currentSeason();
  const seasons = seasonsFor(league, opts);
  const out = [];
  let schedule = null, pfrByGsis = opts.pfrByGsis || null;
  for (const y of seasons) {
    let s = y < cur && !opts.rebuild ? readCache(league, y) : null;
    if (!s) {
      if (league === 'NFL') {
        if (!schedule) schedule = await nflSrc.loadSchedule(opts);
        s = await nflSrc.loadSeason(y, { schedule, pfrByGsis, offline: opts.offline, currentSeason: cur });
      } else s = await cfbSrc.loadSeason(y, { offline: opts.offline, currentSeason: cur });
      writeCache(league, y, s);
      s = readCache(league, y) || s;
    }
    if (opts.log) opts.log('[props warehouse] ' + league + ' ' + y + ': ' + s.games.length + ' games, ' + s.playerGames.length + ' player-games, ' + s.teamGames.length + ' team-games');
    out.push(s);
  }
  return out;
}

/* ------------------------------------------------------ market context
   The pregame spread and total per game, from the line archives EdgeDesk
   already maintains. Each value carries where it came from and when it was
   known; a model number standing in for a missing market is labelled so. */
function marketContext(opts) {
  opts = opts || {};
  const out = new Map();
  const put = (gid, v) => { if (!out.has(String(gid))) out.set(String(gid), v); };
  const nfl = io.readJson(path.join(io.ROOT, 'football', 'pricing', 'lines_nfl.json'), { games: [] });
  (nfl.games || []).forEach((g) => {
    const c = g.close || {};
    if (c.home_line == null && c.total == null) return;
    put(g.id, { home_line: num(c.home_line), total: num(c.total), open_home_line: g.open ? num(g.open.home_line) : null, open_total: g.open ? num(g.open.total) : null,
      source: 'football/pricing/lines_nfl.json (nflverse consensus close)', basis: 'close' });
  });
  const cfb = io.readJson(path.join(io.ROOT, 'football', 'pricing', 'lines_cfb.json'), { games: [] });
  (cfb.games || []).forEach((g) => {
    const c = g.close || {};
    if (c.home_line == null && c.total == null) return;
    put(g.id, { home_line: num(c.home_line), total: num(c.total), open_home_line: g.open ? num(g.open.home_line) : null, open_total: g.open ? num(g.open.total) : null,
      source: 'football/pricing/lines_cfb.json (cfbfastR per-book median close)', basis: 'close' });
  });
  /* the CFB Model Lab's own consensus opens and closes for the season in progress */
  const labDir = path.join(io.ROOT, 'football', 'cfb_lab', 'ledger');
  if (fs.existsSync(labDir)) fs.readdirSync(labDir).forEach((season) => {
    const rows = io.readJsonl(path.join(labDir, season, 'lines.jsonl'));
    const by = new Map();
    rows.forEach((l) => {
      if (l.book !== 'CONSENSUS') return;
      const x = by.get(l.game_id) || {};
      if (l.kind === 'CLOSE' && l.market_type === 'spread' && l.home_line != null) x.home_line = l.home_line;
      if (l.kind === 'CLOSE' && l.market_type === 'total' && l.total_points != null) x.total = l.total_points;
      if (l.kind === 'OPEN' && l.market_type === 'spread' && l.home_line != null) x.open_home_line = l.home_line;
      if (l.kind === 'OPEN' && l.market_type === 'total' && l.total_points != null) x.open_total = l.total_points;
      by.set(l.game_id, x);
    });
    by.forEach((x, gid) => { if (x.home_line != null || x.total != null) put(gid, Object.assign({ source: 'football/cfb_lab/ledger (consensus close)', basis: 'close' }, x)); });
  });
  /* upcoming CFB games without a captured market: EdgeDesk's own fair line and
     total, LABELLED as the model — a feature that is a model number is never
     presented as a market */
  const term = io.readJson(path.join(io.ROOT, 'football', 'cfb_terminal', 'games.json'), { games: {} });
  Object.keys(term.games || {}).forEach((gid) => {
    const g = term.games[gid], e = g && g.edgedesk;
    if (!e || !e.available) return;
    const m = g.market || {};
    if (m.available && m.consensus_home_line != null) put(gid, { home_line: num(m.consensus_home_line), total: null, source: 'football/cfb_terminal/games.json (captured consensus)', basis: 'current' });
    else put(gid, { home_line: num(e.fair_home_line), total: num(e.fair_total), source: 'EdgeDesk CFB model fair line (no market captured)', basis: 'model' });
  });
  return out;
}
function num(x) { return x == null || x === '' || !isFinite(Number(x)) ? null : Number(x); }

/* ------------------------------------------------------ the build */
async function build(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const leagues = opts.leagues || ['NFL', 'CFB'];
  const cur = opts.currentSeason || io.currentSeason();
  const nflPlayers = await nflSrc.loadPlayers({ offline: opts.offline, currentSeason: cur });
  const pfrByGsis = new Map(nflPlayers.filter((p) => p.pfr_id).map((p) => [p.gsis_id, p.pfr_id]));
  const seasons = {};
  for (const lg of leagues) seasons[lg] = await loadLeagueSeasons(lg, Object.assign({}, opts, { pfrByGsis, log, currentSeason: cur }));
  /* identity needs college history even when only the NFL is being built */
  let cfbForIdentity = seasons.CFB;
  if (!cfbForIdentity && opts.identityCfb !== false) cfbForIdentity = await loadLeagueSeasons('CFB', Object.assign({}, opts, { log, currentSeason: cur }));
  const nflSeen = new Set();
  (seasons.NFL || []).forEach((s) => s.playerGames.forEach((r) => nflSeen.add(r.source_player_id)));
  const id = identity.build({ cfbSeasons: cfbForIdentity || [], nflPlayers, nflSeen });
  const resolve = identity.resolver(id.idMap);
  log('[props warehouse] identity: ' + JSON.stringify(id.stats));

  const result = { built_at: new Date().toISOString(), adapter_version: ADAPTER_VERSION, current_season: cur, identity: id, leagues: {}, quarantine: [] };
  const market = marketContext();
  for (const lg of leagues) {
    const games = [], pg = [], tg = [], absences = [], coverage = [];
    seasons[lg].forEach((s) => {
      s.games.forEach((g) => games.push(g));
      s.playerGames.forEach((r) => { r.player_id = lg === 'NFL' ? resolve.nfl(r.source_player_id) : resolve.cfb(r.source_player_id); pg.push(r); });
      s.teamGames.forEach((t) => tg.push(t));
      (s.absences || []).forEach((a) => { a.player_id = resolve.nfl(a.source_player_id); absences.push(a); });
      coverage.push(s.coverage);
    });
    const G = qa.gate(games, qa.checkGame, 'dim_game', (g) => g.game_id);
    const gameIds = new Set(G.kept.map((g) => g.game_id));
    const P = qa.gate(pg.filter((r) => gameIds.has(r.game_id)), qa.checkPlayerGame, 'fact_player_game', (r) => r.game_id + '|' + (r.player_id || r.source_player_id));
    G.kept.forEach((g) => { const m = market.get(g.game_id); g.market = m || null; });
    result.quarantine.push(...G.quarantined, ...P.quarantined);
    result.leagues[lg] = { games: G.kept, playerGames: P.kept, teamGames: tg.filter((t) => gameIds.has(t.game_id)), absences, coverage,
      qa: { games: { kept: G.kept.length, quarantined: G.quarantined.length, counts: G.counts }, player_games: { kept: P.kept.length, quarantined: P.quarantined.length, flagged: P.flagged, counts: P.counts } } };
    log('[props warehouse] ' + lg + ' QA: ' + JSON.stringify(result.leagues[lg].qa));
  }
  return result;
}

module.exports = { build, loadLeagueSeasons, marketContext, seasonsFor, ADAPTER_VERSION, WINDOWS };
