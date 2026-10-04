#!/usr/bin/env node
/* ===========================================================================
   FETCH THE NFL FEEDS the offline builders read from football/nfl/.cache:
   games.csv (schedule, results, the closing consensus), the current season's
   stats_team_week (club rates) and stats_player_week (per-quarterback EPA).
   All public and keyless; a failed fetch keeps the cached copy and says so.

   Run: node tools/football/fetch_nfl_feeds.js [--season 2026]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
const key = (url) => path.join(CACHE, url.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const FEEDS = (season) => [
  'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv',
  'https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_' + season + '.csv',
  'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_' + season + '.csv',
];
async function main() {
  const args = process.argv.slice(2);
  const season = args.includes('--season') ? Number(args[args.indexOf('--season') + 1]) : new Date().getUTCFullYear();
  fs.mkdirSync(CACHE, { recursive: true });
  let failed = 0;
  for (const url of FEEDS(season)) {
    try { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); const t = await r.text(); if (t.length < 100) throw new Error('empty body'); fs.writeFileSync(key(url), t); console.log('fetched ' + url.split('/').pop() + ' (' + Math.round(t.length / 1024) + ' KB)'); }
    catch (e) { failed++; console.error('could not fetch ' + url + ': ' + e.message + (fs.existsSync(key(url)) ? ' (cached copy kept)' : ' (no cached copy)')); }
  }
  process.exit(failed && !fs.existsSync(key(FEEDS(season)[0])) ? 1 : 0);
}
module.exports = { FEEDS, CACHE, key };
if (require.main === module) main();
