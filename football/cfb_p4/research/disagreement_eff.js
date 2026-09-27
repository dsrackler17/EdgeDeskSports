#!/usr/bin/env node
/* ============================================================================
   The PRODUCTION efficiency inputs, rebuilt for past seasons, so the forensic
   replay (disagreement_replay.js) prices the stylistic-matchup layer exactly
   as the board does: football/rankings/engine_efficiency.js over the SAME
   play table loader the rankings pipeline uses (football/players/build_players.js
   loadSchedule / loadPlays). Nothing is re-derived here.

     node football/cfb_p4/research/disagreement_eff.js --data DIR 2014 2015 ... 2026
   Writes DIR/eff_<season>.json and caches the raw feeds in DIR/cache.
   ============================================================================ */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const i = process.argv.indexOf('--data');
const DATA = i > 0 ? process.argv[i + 1] : path.join(ROOT, '.cache', 'cfbdata');
/* build_players.js reads its cache directory from argv at load */
process.argv.push('--cache', path.join(DATA, 'cache'), '--quiet');
const B = require(path.join(ROOT, 'football', 'players', 'build_players.js'));
const EFF = require(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.js'));

(async () => {
  const seasons = process.argv.slice(2).filter(x => /^\d{4}$/.test(x)).map(Number);
  fs.mkdirSync(DATA, { recursive: true });
  for (const y of seasons) {
    const out = path.join(DATA, 'eff_' + y + '.json');
    if (fs.existsSync(out)) { console.error('[eff] ' + y + ' already built'); continue; }
    const sched = await B.loadSchedule(y);
    const play = await B.loadPlays(y, sched);
    const eff = EFF.build(play.teamGames, { fbs: sched.fbs, season: y, generated_at: 'historical rebuild' });
    fs.writeFileSync(out, JSON.stringify(eff));
    console.error('[eff] ' + y + ': ' + eff.games_with_stats + ' games, ' + eff.team_game_rows + ' team-games');
  }
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
