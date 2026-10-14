'use strict';
/* ===========================================================================
   EdgeDesk college baseball — read the committed warehouse.

   Every model reads games through here, so the eligibility rule lives in one
   place: a game informs ratings and is scored only if it is FINAL, has both
   scores, is not CONFLICT (quarantined), and both programs are identified.
   Numbers are numbers here and blanks stay null.
   =========================================================================== */
const fs = require('fs');
const C = require('../config');
const { readCsv } = require('../../engine/csv');

const NUM = new Set(['season', 'dh', 'weekday', 'home_div', 'away_div', 'conf_game', 'neutral', 'home_runs', 'away_runs', 'innings_marker', 'innings_played',
  'scheduled_innings', 'ended_early', 'ncaa_tourney_inferred', 'conf_tourney_window', 'n_observations', 'seq', 'starter', 'outs']);

function typed(header, rows, numeric) {
  return rows.map((r) => {
    const o = {};
    header.forEach((h, i) => {
      const v = Array.isArray(r) ? r[i] : r[h];
      if (v === '' || v === undefined) o[h] = null;
      else if (numeric === true || (numeric && numeric.has(h))) { const n = Number(v); o[h] = Number.isFinite(n) ? n : v; }
      else o[h] = v;
    });
    return o;
  });
}

const cache = new Map();
function load(file, numeric) {
  if (cache.has(file)) return cache.get(file);
  if (!fs.existsSync(file)) { cache.set(file, null); return null; }
  const { header, rows } = readCsv(file);
  const out = typed(header, rows, numeric);
  cache.set(file, out);
  return out;
}

/** all D-I contests of a season (every status) */
function games(season) { return load(C.PATHS.games(season), NUM) || []; }

/** a game usable for rating and scoring */
function usable(g) {
  return g.status === 'FINAL' && g.home_runs != null && g.away_runs != null && g.quality !== 'CONFLICT' && !!g.home_id && !!g.away_id && g.home_id !== g.away_id;
}

/** usable games across seasons, chronological */
function results(fromSeason, toSeason) {
  const out = [];
  for (let s = fromSeason; s <= toSeason; s++) for (const g of games(s)) if (usable(g)) out.push(g);
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  return out;
}

const NUMERIC_BOX = { has: (h) => !['game_id', 'date', 'team_id', 'team_name', 'side', 'opp_id', 'opp_name', 'starter_person', 'total_checks', 'box_quality', 'name', 'person_id', 'roster_id', 'class', 'ip_raw', 'position'].includes(h) };
function teamGames(season) { return load(C.PATHS.teamGames(season), NUMERIC_BOX) || []; }
function pitchers(season) { return load(C.PATHS.pitchers(season), NUMERIC_BOX) || []; }
function batters(season) { return load(C.PATHS.teamGames(season).replace('_team_games', '_batters'), NUMERIC_BOX) || []; }
function innings(season) { return load(C.PATHS.innings(season), { has: (h) => !['pbp_key', 'date', 'location', 'away_name', 'home_name', 'away_line', 'home_line'].includes(h) }) || []; }
function teamSeasons() { return load(C.PATHS.teamSeasons, new Set(['season', 'division'])) || []; }
function report(season) { const f = require('path').join(C.PATHS.data, 'reports', season + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }

function clear() { cache.clear(); }

module.exports = { games, usable, results, teamGames, pitchers, batters, innings, teamSeasons, report, clear, typed };
