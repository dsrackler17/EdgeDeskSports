#!/usr/bin/env node
/* ===========================================================================
   THE CLOSING-LINE ARCHIVE — copies, never computes.

   Every NFL game since 1999 with the closing spread and total (moneylines
   from 2006) as nflverse/nfldata's games.csv carries them, plus the context
   a pricer needs to grade itself: the result, the roof, the temperature and
   wind, rest days, the division flag and the starting quarterbacks.

   This is the archive the pricing validation (tools/football/validate_pricing.js)
   and the closing-line-value scorecard read. Nothing here is a model.

   SIGN CONVENTION. games.csv's spread_line is the HOME team's margin the
   market expects (positive = home favoured). The desk quotes lines the way
   a book prints them: model_home_line -7 means the home side is laying 7.
   So close.home_line = -spread_line. The convention is written into the
   artifact so nothing downstream has to remember it.

   Usage
     node tools/football/build_lines_archive.js            # from the cached feed
     node tools/football/build_lines_archive.js --fetch    # refresh the feed first
     node tools/football/build_lines_archive.js --check    # exit 1 if the artifact is stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));

const SCHEMA = 'edgedesk_lines_archive_v1';
const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const OUT = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
const COLS = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'result', 'total', 'overtime',
  'away_rest', 'home_rest', 'away_moneyline', 'home_moneyline', 'spread_line', 'away_spread_odds', 'home_spread_odds', 'total_line', 'under_odds', 'over_odds',
  'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'stadium'];

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function neg(v) { const n = num(v); return n == null ? null : (n === 0 ? 0 : -n); }

/** Build the archive from games.csv text. Pure; the test hands in labelled rows. */
function build(text, opts) {
  opts = opts || {};
  const rows = R.parseCsv(String(text || ''), { columns: COLS });
  const games = [];
  const seasons = {};
  rows.forEach((r) => {
    const season = num(r.season); if (season == null) return;
    const s = (seasons[season] = seasons[season] || { games: 0, with_close: 0, with_moneyline: 0, played: 0 });
    s.games++;
    const spread = num(r.spread_line);
    if (spread == null) return; /* no close on file: not an archive row */
    s.with_close++;
    const margin = num(r.result);
    if (margin != null) s.played++;
    if (num(r.home_moneyline) != null) s.with_moneyline++;
    games.push({
      id: r.game_id, season, type: r.game_type || null, week: num(r.week), date: r.gameday || null, kickoff_local: r.gametime || null,
      away: r.away_team, home: r.home_team, away_score: num(r.away_score), home_score: num(r.home_score), margin, points: num(r.total), overtime: num(r.overtime) === 1,
      close: { home_line: neg(spread), home_spread_odds: num(r.home_spread_odds), away_spread_odds: num(r.away_spread_odds), total: num(r.total_line), over_odds: num(r.over_odds), under_odds: num(r.under_odds), home_moneyline: num(r.home_moneyline), away_moneyline: num(r.away_moneyline) },
      ctx: { roof: r.roof || null, surface: r.surface || null, temp: num(r.temp), wind: num(r.wind), home_rest: num(r.home_rest), away_rest: num(r.away_rest), divisional: num(r.div_game) === 1, home_qb_id: r.home_qb_id || null, away_qb_id: r.away_qb_id || null, stadium: r.stadium || null },
    });
  });
  games.sort((a, b) => a.season - b.season || (a.week || 0) - (b.week || 0) || String(a.id).localeCompare(String(b.id)));
  const played = games.filter((g) => g.margin != null);
  return {
    schema: SCHEMA, version: 1, sport: 'americanfootball_nfl', generated_at: opts.now || new Date().toISOString(),
    source: { url: GAMES_URL, path: path.relative(ROOT, CACHE), retrieved_at: opts.retrieved_at || null, basis: 'nflverse/nfldata games.csv; the spread, total and moneyline columns are the consensus close as nflverse carries them, no book, no capture time' },
    sign_convention: 'close.home_line is the line the HOME side lays (negative = home favoured), i.e. -spread_line; margin is home_score minus away_score; a spread cover for the home side is margin + home_line > 0',
    counts: { games: games.length, played: played.length, seasons: Object.keys(seasons).length, first_season: games.length ? games[0].season : null, last_season: games.length ? games[games.length - 1].season : null },
    seasons, games,
    note: 'A copy of the feed with the sign convention made explicit. It grades nothing and prices nothing; the validation and the scorecard read it.',
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!fs.existsSync(CACHE) || args.includes('--fetch')) {
    if (args.includes('--check')) { console.error('CHECK: the games.csv cache is absent; nothing to compare'); process.exit(1); }
    return fetch(GAMES_URL, { redirect: 'follow' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then((t) => { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, t); write(args); }).catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
  }
  write(args);
}
function write(args) {
  const art = build(fs.readFileSync(CACHE, 'utf8'), { retrieved_at: new Date(fs.statSync(CACHE).mtimeMs).toISOString() });
  const c = art.counts;
  console.log(`lines archive: ${c.games} NFL games with a close, ${c.played} played, seasons ${c.first_season}-${c.last_season}`);
  if (args.includes('--check')) {
    if (!fs.existsSync(OUT)) { console.error('CHECK: no artifact on disk'); process.exit(1); }
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const same = JSON.stringify(prev.games) === JSON.stringify(art.games);
    console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(art));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}

module.exports = { build, SCHEMA, OUT, CACHE, GAMES_URL, COLS };
if (require.main === module) main();
