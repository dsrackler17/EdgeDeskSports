#!/usr/bin/env node
/* ===========================================================================
   The slate fixture of tools/football/game_context.test.js:
   tools/football/fixtures/game_context_2026_wk07.json.gz.

   The real inputs tools/football/build_game_research.js read on 2026-10-22,
   as committed at REV, trimmed to the games the test asserts on: the NFL's
   Thursday game (NE at CHI: its referee, its trip, its consensus line) and
   two FBS games that between them carry every edge signal the test looks
   for (Colorado State v San Diego State: altitude, QB play, coaching change;
   Michigan v Indiana: QB play, coaching change, model agreement), each with
   its crew and its trip. Nothing is edited: a game is kept or left out
   whole, and every keyed table keeps the kept games' and teams' rows.

   The live slates roll forward every week (NE at CHI left football/nfl/slate.json
   once it was played), so the test reads this file instead of them.

     node tools/football/game_context_fixture.js [--rev 0743e51f]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'fixtures', 'game_context_2026_wk07.json.gz');
/* football/nfl/slate.json generated 2026-10-22T18:00Z, the last commit before NE at CHI kicked off */
const REV_DEFAULT = '0743e51f';
const NFL_GAMES = ['2026_07_NE_CHI'];
const CFB_GAMES = ['401860905', '401858496'];

function atRev(rev, rel) {
  return JSON.parse(execFileSync('git', ['show', rev + ':' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 << 20 }));
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj && Object.prototype.hasOwnProperty.call(obj, k)).map((k) => [k, obj[k]]));

function build(rev) {
  const nfl = atRev(rev, 'football/nfl/slate.json');
  const fbs = atRev(rev, 'football/fbs/slate.json');
  const term = atRev(rev, 'football/cfb_terminal/games.json');
  const rk = atRev(rev, 'football/rankings/current.json');
  const today = atRev(rev, 'today/slate.json');
  const forecasts = atRev(rev, 'football/venues/forecasts.json');
  const identity = atRev(rev, 'football/game_research/identity_cfb.json');

  const nflGames = nfl.games.filter((g) => NFL_GAMES.includes(g.game_id));
  const cfbGames = fbs.games.filter((g) => CFB_GAMES.includes(String(g.game_id)));
  if (nflGames.length !== NFL_GAMES.length || cfbGames.length !== CFB_GAMES.length) throw new Error('a fixture game is missing at ' + rev);
  const nflTeams = [...new Set(nflGames.flatMap((g) => [g.home_code, g.away_code]))];
  const cfbTeams = [...new Set(cfbGames.flatMap((g) => [g.home_team_id, g.away_team_id]))];
  const keys = new Set(NFL_GAMES.map((k) => 'nfl|' + k).concat(CFB_GAMES.map((k) => 'cfb|' + k)));

  /* pricing (the board's market table) is not read by build_game_research.js: left out */
  const { pricing, ...nflRest } = nfl;
  return {
    schema: 'edgedesk_game_context_fixture_v1',
    source: { rev, now: '2026-10-22T13:00:00Z', built_by: 'tools/football/game_context_fixture.js', nfl_games: NFL_GAMES, cfb_games: CFB_GAMES },
    nfl: { ...nflRest, games: nflGames, teams: pick(nfl.teams, nflTeams) },
    fbs: { ...fbs, games: cfbGames },
    terminal: { ...term, games: pick(term.games, CFB_GAMES) },
    rankings: { ...rk, teams: pick(rk.teams, cfbTeams) },
    today: { ...today, events: today.events.filter((e) => e.research && keys.has(e.research.game_key)), upcoming: [], markets: [], buckets: [] },
    forecasts: { ...forecasts, by_game: pick(forecasts.by_game, CFB_GAMES) },
    identity
  };
}

/** the fixture as build_game_research.js build() takes it (featured: none; the test reads no landing page) */
function load() {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT)).toString('utf8'));
  const { schema, source, ...inputs } = fx;
  return { source, inputs: { ...inputs, featured: null } };
}

if (require.main === module) {
  const i = process.argv.indexOf('--rev');
  const fx = build(i >= 0 ? process.argv[i + 1] : REV_DEFAULT);
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(fx) + '\n', { level: 9 }));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
}
module.exports = { build, load, OUT, NFL_GAMES, CFB_GAMES };
