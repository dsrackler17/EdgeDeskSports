'use strict';
/* ===========================================================================
   EdgeDesk NBA — the warehouse tables, loaded and typed.

     games(seasons)          committed nba/data/games/<season>.csv
     teamGames(seasons)      committed nba/data/team_games/<season>.csv
     playerGames(season)     .cache/nba_work (rebuilt by nba/ingest/season.js)
     stints(season)          .cache/nba_work
     shots(season)           .cache/nba_work

   Every numeric column is a Number or null (a blank is never 0).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const { readCsv } = require('../../engine/csv');
const io = require('./io');

const GAME_NUM = ['season', 'neutral', 'bubble', 'hs', 'as', 'ot', 'h_q1', 'h_q2', 'h_q3', 'h_q4', 'h_ot', 'a_q1', 'a_q2', 'a_q3', 'a_q4', 'a_ot', 'attendance', 'ref_line_home', 'pbp'];
const TG_STR = new Set(['game_id', 'date', 'start_utc', 'team_id', 'opp_id', 'city', 'assumed_available_at']);
const n = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function seasonList(from, to) { const o = []; for (let s = from; s <= to; s++) o.push(s); return o; }

function games(seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(C.PATHS.games, s + '.csv'); if (!fs.existsSync(f)) continue;
    for (const r of readCsv(f).rows) {
      for (const k of GAME_NUM) r[k] = n(r[k]);
      r.start_ms = Date.parse(r.start_utc); r.avail_ms = r.assumed_available_at ? Date.parse(r.assumed_available_at) : null;
      /* regulation margin and total: from the period scores, or the final when no overtime was played */
      const q = ['h_q1', 'h_q2', 'h_q3', 'h_q4', 'a_q1', 'a_q2', 'a_q3', 'a_q4'].every((k) => r[k] != null);
      if (q) { r.reg_h = r.h_q1 + r.h_q2 + r.h_q3 + r.h_q4; r.reg_a = r.a_q1 + r.a_q2 + r.a_q3 + r.a_q4; }
      else if (r.status === 'FINAL' && r.ot === 0) { r.reg_h = r.hs; r.reg_a = r.as; }
      else { r.reg_h = null; r.reg_a = null; }
      out.push(r);
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms || (a.game_id < b.game_id ? -1 : 1));
  return out;
}

function teamGames(seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(C.PATHS.teamGames, s + '.csv'); if (!fs.existsSync(f)) continue;
    for (const r of readCsv(f).rows) { for (const k of Object.keys(r)) if (!TG_STR.has(k)) r[k] = n(r[k]); out.push(r); }
  }
  return out;
}

function playerGames(season) { const w = io.readWork('player_games_' + season + '.json.gz'); return w ? w.rows : []; }
function stints(season) { return io.readWork('stints_' + season + '.json.gz'); }
function shots(season) { return io.readWork('shots_' + season + '.json.gz'); }
function teamsMap() { try { return JSON.parse(fs.readFileSync(C.PATHS.teams, 'utf8')); } catch (_) { return {}; } }
function playersMap() { try { return JSON.parse(fs.readFileSync(path.join(C.NBA, 'data', 'players.json'), 'utf8')); } catch (_) { return {}; } }

module.exports = { games, teamGames, playerGames, stints, shots, teamsMap, playersMap, seasonList };
