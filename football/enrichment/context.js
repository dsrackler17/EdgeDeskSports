/* ============================================================================
   THE ENRICHMENT CONTEXT — the slate, the teams and the identities, built the
   way football/fbs/build_coverage.js builds them, so every game id and team
   key the enrichment publishes is the one the reliability build looks up.

   One schedule feed (cfbfastR-data, the same URL and cache), one universe,
   one slate. Team identity:
     slate key      FBS.normKey(cfbfastR team name)   the engine's key
     ESPN team id   the feed's home_id / away_id       the availability and
                                                      roster files' key
     player id      the ESPN athlete id                rosters, players,
                                                      reports, starters
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const FBS = require(path.join(ROOT, 'football', 'fbs', 'fbs.js'));
const BC = require(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'));
const AV = require(path.join(ROOT, 'football', 'availability', 'availability.js'));
const STARTERS = require('./impact/starters.js');

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const nk = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function load(o) {
  o = o || {};
  const now = o.now != null ? o.now : Date.now();
  const season = o.season || (() => { const d = new Date(now); return d.getMonth() <= 1 ? d.getFullYear() - 1 : d.getFullYear(); })();
  let text = null, scheduleError = null;
  try { text = await BC.loadSeason(season, !!o.offline); } catch (e) { scheduleError = String((e && e.message) || e); }
  if (!text) return { ok: false, why: 'the ' + season + ' schedule feed could not be read' + (scheduleError ? ': ' + scheduleError : ''), season, now };
  const rows = BC.normRows(BC.parseCsv(text));
  const universe = FBS.buildUniverse({ rows, season, source: 'cfbfastR-data schedules ' + season, params: P,
    knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const built = FBS.buildSlate({ rows, universe, now, lookaheadDays: o.lookahead == null ? 10 : o.lookahead });

  const teams = {}, espnToKey = {}, teamKeyByName = {};
  rows.forEach((r) => {
    [['home', r.home_id, r.home_team, r.home_division, r.home_conference], ['away', r.away_id, r.away_team, r.away_division, r.away_conference]]
      .forEach(([, id, name, div, conf]) => {
        const key = FBS.normKey(name);
        if (!key) return;
        const isFbs = FBS.isFbsDivision(div, name, { knownFbs: P.rating.seed_ratings });
        if (!teams[key]) teams[key] = { key, name, espn_id: id ? String(id) : null, is_fbs: isFbs, conference: conf || null };
        if (id) espnToKey[String(id)] = key;
        teamKeyByName[nk(name)] = key;
      });
  });

  /* rosters, by slate key (ESPN team id is the join) */
  const rosterFile = readJson(path.join(ROOT, 'football', 'rosters', 'fbs_' + season + '_espn.json'), null);
  const rosterByKey = {};
  ((rosterFile && rosterFile.teams) || []).forEach((t) => {
    const key = espnToKey[String(t.espn_id)] || teamKeyByName[nk(t.location)] || teamKeyByName[nk(t.display_name)];
    if (key) { rosterByKey[key] = t.players || []; teamKeyByName[nk(t.location)] = teamKeyByName[nk(t.location)] || key; }
  });

  /* the players layer, by slate key */
  const playersDir = path.join(ROOT, 'football', 'players', 'teams');
  const playerFiles = {}, projected = {};
  const need = new Set();
  built.items.forEach((it) => { need.add(it.meta.home.key); need.add(it.meta.away.key); });
  need.forEach((key) => {
    const f = readJson(path.join(playersDir, key + '.json'), null);
    if (f) { playerFiles[key] = f; projected[key] = STARTERS.project(f); }
  });

  function resolveName(key, name, pos) {
    const roster = rosterByKey[key];
    if (!roster || !name) return null;
    const r = AV.resolvePlayer({ player_name: name, position: pos || null }, roster);
    if (!r.player || ['EXACT', 'HIGH'].indexOf(r.match_confidence) < 0) return null;
    return { player_id: String(r.player.espn_id), basis: 'roster ' + r.match, confidence: r.match_confidence };
  }

  const slate = built.items.map((it) => ({
    game_id: String(it.meta.id), kickoff: it.g.start_date, week: it.g.week, neutral_site: !!it.g.neutral_site, venue: it.g.venue || null,
    is_conference_game: !!it.meta.is_conference_game, matchup_type: it.meta.matchup_type,
    home: { key: it.meta.home.key, name: it.g.home_team, espn_id: it.g.home_id ? String(it.g.home_id) : null, is_fbs: it.meta.home.is_fbs !== false,
      conference: it.meta.home.conference || it.g.home_conference || null },
    away: { key: it.meta.away.key, name: it.g.away_team, espn_id: it.g.away_id ? String(it.g.away_id) : null, is_fbs: it.meta.away.is_fbs !== false,
      conference: it.meta.away.conference || it.g.away_conference || null },
    g: it.g, meta: it.meta
  }));
  return { ok: true, season, now, rows, universe, slate, teams, espnToKey, teamKeyByName, rosterByKey, playerFiles, projected, resolveName, params: P };
}

module.exports = { load, ROOT };
