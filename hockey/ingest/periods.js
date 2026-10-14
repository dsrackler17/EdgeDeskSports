#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — goals by period (schema edgedesk_nhl_game_periods_v1).

     node hockey/ingest/periods.js --season 2011-2027

   One row per completed game, from the processed play-by-play
   (.cache/nhl_work/games_<season>.jsonl.gz, hockey/ingest/season.js):
     game_id, season, type, date, home, away, decided,
     h1, a1, h2, a2, h3, a3   goals in each regulation period
     hot, aot                 overtime goals (0 or 1 in the regular season)
     h_en, a_en               regulation empty-net goals (the defending net empty)
     h_late, a_late           regulation goals in the last 5 minutes
     check                    OK, or why the periods do not sum to the game's
                              regulation score (the row is kept and counted)
   written to hockey/data/game_periods/<season>.csv. Small (≈30 bytes a game)
   and committed, so the period markets can be validated without the cache.

   Shootout attempts never appear (the ingest drops them). Time is the same
   RETRO rule as the team-game table: these facts are taken as available four
   hours after the scheduled start (hockey/ingest/team_games.js).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');

const DIR = path.join(C.HOCKEY, 'data', 'game_periods');
const COLS = ['game_id', 'season', 'type', 'date', 'home', 'away', 'decided', 'h1', 'a1', 'h2', 'a2', 'h3', 'a3', 'hot', 'aot', 'h_en', 'a_en', 'h_late', 'a_late', 'check'];

/** one processed game record → its period row (pure) */
function periodRow(rec) {
  const g = rec.game;
  const r = { game_id: g.game_id, season: g.season, type: g.season_type, date: g.date, home: g.home, away: g.away, decided: g.decided, h1: 0, a1: 0, h2: 0, a2: 0, h3: 0, a3: 0, hot: 0, aot: 0, h_en: 0, a_en: 0, h_late: 0, a_late: 0 };
  for (const s of rec.shots) {
    if (!s.goal) continue;
    const k = s.side === 'home' ? 'h' : 'a';
    if (s.period >= 1 && s.period <= 3) {
      r[k + s.period]++;
      if (s.empty_net) r[k + '_en']++;
      if (s.gs >= 3300 && s.gs < 3600) r[k + '_late']++;
    } else if (s.period >= 4) r[k + 'ot']++;
  }
  const regH = r.h1 + r.h2 + r.h3, regA = r.a1 + r.a2 + r.a3;
  r.check = regH === g.reg_home && regA === g.reg_away ? 'OK' : 'periods ' + regH + '-' + regA + ' vs regulation ' + g.reg_home + '-' + g.reg_away;
  return r;
}

function toCsv(rows) { return COLS.join(',') + '\n' + rows.map((r) => COLS.map((c) => (r[c] == null ? '' : String(r[c]).replace(/,/g, ';'))).join(',')).join('\n') + '\n'; }
function parseCsv(text) {
  const lines = text.split('\n').filter(Boolean); const head = lines[0].split(',');
  const str = new Set(['type', 'date', 'home', 'away', 'decided', 'check']);
  return lines.slice(1).map((l) => { const f = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = str.has(h) ? f[i] : Number(f[i]); }); return o; });
}

function buildSeason(season) {
  const { readSeason } = require('./season');
  const rows = []; let bad = 0;
  for (const rec of readSeason(season)) { const r = periodRow(rec); if (r.check !== 'OK') bad++; rows.push(r); }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id - b.game_id));
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, season + '.csv'); const text = toCsv(rows);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old !== text) fs.writeFileSync(file, text);
  return { season, games: rows.length, mismatched: bad, changed: old !== text };
}

/** game_id → period row, for the seasons on disk */
function loadPeriods(seasons) {
  const m = new Map();
  for (const s of seasons) { const f = path.join(DIR, s + '.csv'); if (!fs.existsSync(f)) continue; for (const r of parseCsv(fs.readFileSync(f, 'utf8'))) m.set(r.game_id, r); }
  return m;
}

module.exports = { COLS, periodRow, buildSeason, loadPeriods, parseCsv, DIR };

if (require.main === module) {
  const i = process.argv.indexOf('--season');
  const spec = (i >= 0 ? process.argv[i + 1] : String(C.CURRENT_SEASON)).replace(/^current$/, String(C.CURRENT_SEASON)).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON);
  const seasons = spec.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  for (const s of seasons) {
    try { const r = buildSeason(s); console.log('[nhl periods] ' + s + ': ' + r.games + ' games, ' + r.mismatched + ' whose periods do not sum to the regulation score' + (r.changed ? '' : ' (unchanged)')); }
    catch (e) { console.log('[nhl periods] ' + s + ': no ingest cache (' + String(e.message).slice(0, 80) + ')'); }
  }
}
