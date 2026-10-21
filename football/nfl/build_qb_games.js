#!/usr/bin/env node
/* ===========================================================================
   THE QUARTERBACK GAME LOG the NFL ratings absorb every game
   (football/nfl/qb_games_<season>.csv).

   Training credits each team-game to the club's quarterback with the most
   dropbacks and moves his value by his EPA per dropback
   (football/research/train_nfl.py sequential_pass, from nflverse
   stats_player_week). The live board used to absorb no quarterback at all, so
   every quarterback value stayed at its 2025 seed all season
   (audit_report.md §0.3). This writes the rows that rule reads: every
   position-QB line of the season, in the feed's own order (the order breaks
   a tie in dropbacks, exactly as training does), with only the columns the
   engine uses. engine.js nfl.qbStarts picks the passer; nothing is chosen here.

   Source: nflverse-data releases stats_player/stats_player_week_<season>.csv,
   the feed nflverse builds from its play-by-play.

   Usage
     node football/nfl/build_qb_games.js [--season 2026] [--from local.csv] [--out dir]
   Exit 0 = written or unchanged; 1 = the feed could not be read or was refused.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./build_team_week.js');

const URL = (s) => `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${s}.csv`;
const COLS = ['season', 'week', 'season_type', 'game_id', 'team', 'player_id', 'player_display_name', 'position', 'attempts', 'sacks_suffered', 'passing_epa'];
function seasonNow() { const d = new Date(); return d.getMonth() <= 1 ? d.getFullYear() - 1 : d.getFullYear(); }

function qbRows(text, season) {
  const p = parseCsv(text);
  const miss = COLS.filter((c) => !p.header.includes(c));
  if (miss.length) throw new Error('missing columns: ' + miss.join(', '));
  const rows = p.rows.filter((r) => String(r.season) === String(season) && r.position === 'QB' && r.game_id && r.team && r.player_id);
  const teams = new Set(rows.map((r) => r.team)), games = new Set(rows.map((r) => r.game_id));
  if (rows.length && (teams.size < 2 || games.size < 1)) throw new Error(`implausible data: ${rows.length} rows / ${teams.size} teams`);
  return rows;
}
function toCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return COLS.join(',') + '\n' + rows.map((r) => COLS.map((c) => esc(r[c])).join(',')).join('\n') + (rows.length ? '\n' : '');
}

async function main() {
  const a = process.argv.slice(2), v = (k, d) => { const i = a.indexOf(k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const season = parseInt(v('--season', String(seasonNow())), 10), out = v('--out', __dirname), from = v('--from', null);
  const file = path.join(out, `qb_games_${season}.csv`);
  let text;
  try {
    if (from) text = fs.readFileSync(from, 'utf8');
    else { const r = await fetch(URL(season), { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); text = await r.text(); }
  } catch (e) { console.error('qb game log fetch failed: ' + e.message); process.exit(1); }
  let rows;
  try { rows = qbRows(text, season); } catch (e) { console.error('qb game log refused: ' + e.message); process.exit(1); }
  const csv = toCsv(rows);
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === csv) { console.log(`qb game log unchanged: ${rows.length} QB lines`); return; }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file, csv);
  console.log(`qb game log wrote ${file}: ${rows.length} QB lines over ${new Set(rows.map((r) => r.game_id)).size} games`);
}
if (require.main === module) main();
module.exports = { URL, COLS, qbRows, toCsv };
