'use strict';
/* ===========================================================================
   The content engine's research inputs, read from the repository.

   Every file here is an artifact another EdgeDesk pipeline already builds and
   commits (football/cfb_terminal, football/rankings, football/nfl,
   football/injuries, articles/data). Nothing is fetched and nothing is
   recomputed: lib/content_engine.js normalises what these files say.

   The admin page reads the same files over HTTPS from the site, which is
   served from this repository (admin/content/content.js, loadArtifacts).
   =========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));

function readJson(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

/* every captured-market snapshot for the season (NFL quotes live there) */
function marketSnapshots(season) {
  const dir = path.join(ROOT, 'articles', 'data', 'market');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => new RegExp('^' + season + '-week-\\d+\\.json$').test(f))
    .map((f) => readJson(path.join('articles', 'data', 'market', f))).filter(Boolean);
}

/* opts.now: the moment the evidence packets are judged at (a test pins it).
   The packets are built fresh from the committed artifacts (tools/content/
   evidence.js); the browser reads the committed football/evidence/packets.json. */
function load(opts) {
  opts = opts || {};
  const A = CE.ARTIFACTS;
  const nflSlate = readJson(A.nfl_slate);
  const season = (nflSlate && nflSlate.season) || 2026;
  let evidence = null;
  if (opts.evidence !== false) {
    try { evidence = require(path.join(ROOT, 'tools', 'content', 'evidence.js')).build({ now: typeof opts.now === 'number' ? opts.now : Date.now() }); }
    catch (e) { evidence = readJson(A.evidence); }
  }
  return {
    evidence,
    cfbGames: readJson(A.cfb_games),
    cfbBrief: readJson(A.cfb_brief),
    rankings: readJson(A.rankings),
    nflSlate,
    nflInjuries: readJson(A.nfl_injuries),
    marketSnapshots: marketSnapshots(season),
    published: readJson(A.published)
  };
}

/* the season's full team lists, so the validator can catch a team the
   article's research never mentions */
function teamLists(art) {
  const cfb = new Set(), nfl = new Set();
  if (art.rankings && art.rankings.teams) Object.values(art.rankings.teams).forEach((t) => t && t.team && cfb.add(t.team));
  if (art.cfbGames && art.cfbGames.games) Object.values(art.cfbGames.games).forEach((g) => { if (g.game) { cfb.add(g.game.home); cfb.add(g.game.away); } });
  if (art.nflSlate && art.nflSlate.games) art.nflSlate.games.forEach((g) => { nfl.add(g.home_team); nfl.add(g.away_team); });
  return { cfb: [...cfb].filter(Boolean), nfl: [...nfl].filter(Boolean) };
}

module.exports = { load, teamLists, readJson, ROOT };
