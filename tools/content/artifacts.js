'use strict';
/* ===========================================================================
   The content engine's research inputs, read from the repository.

   Every file here is an artifact another EdgeDesk pipeline already builds and
   commits (football/cfb_terminal, football/rankings, football/nfl,
   football/injuries, articles/data, record/football). Nothing is fetched and nothing is
   recomputed: lib/content_engine.js normalises what these files say.

   The admin page reads the same files over HTTPS from the site, which is
   served from this repository (admin/content/content.js, loadArtifacts).

   frozen() is the same research as committed for CFB Week 6 and NFL Week 5
   (fixtures/research_2026_w6.json.gz, written by fixtures/freeze_research.js):
   the suites that assert what that week said read it, so they do not move
   when the hourly artifacts do.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));

function readJson(rel) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

/* every captured-market snapshot for the season (NFL quotes live there),
   from the file names a directory listing gives */
function marketSnapshots(season, names, read) {
  return names.filter((f) => new RegExp('^' + season + '-week-\\d+\\.json$').test(f))
    .map((f) => read(path.posix.join('articles', 'data', 'market', f))).filter(Boolean);
}

/* opts.now: the moment the evidence packets are judged at (a test pins it).
   The packets are built fresh from the committed artifacts (tools/content/
   evidence.js); the browser reads the committed football/evidence/packets.json. */
function load(opts) {
  opts = opts || {};
  let evidence = null;
  if (opts.evidence !== false) {
    try { evidence = require(path.join(ROOT, 'tools', 'content', 'evidence.js')).build({ now: typeof opts.now === 'number' ? opts.now : Date.now() }); }
    catch (e) { evidence = readJson(CE.ARTIFACTS.evidence); }
  }
  const dir = path.join(ROOT, 'articles', 'data', 'market');
  return assemble(readJson, fs.existsSync(dir) ? fs.readdirSync(dir) : [], evidence);
}

/* the frozen week: { files: { repository path: its JSON }, at, commit, … }
   (fixtures/freeze_research.js) */
const FROZEN = path.join(__dirname, 'fixtures', 'research_2026_w6.json.gz');
function frozenFiles() { return JSON.parse(zlib.gunzipSync(fs.readFileSync(FROZEN)).toString('utf8')); }
/* the same shape as load(), from the frozen week; a fresh copy on every call.
   It carries no matchup packets: those move with the week, and Five Games to
   Watch is tested from its own fixture (games_to_watch.test.js) */
function frozen() {
  const fx = frozenFiles();
  const read = (rel) => (fx.files[rel] === undefined ? null : fx.files[rel]);
  const names = Object.keys(fx.files).filter((k) => path.posix.dirname(k) === 'articles/data/market').map((k) => path.posix.basename(k));
  return assemble(read, names, read(CE.ARTIFACTS.evidence));
}

function assemble(read, marketNames, evidence) {
  const A = CE.ARTIFACTS;
  const nflSlate = read(A.nfl_slate);
  const season = (nflSlate && nflSlate.season) || 2026;
  return {
    evidence,
    cfbGames: read(A.cfb_games),
    cfbBrief: read(A.cfb_brief),
    rankings: read(A.rankings),
    nflSlate,
    nflInjuries: read(A.nfl_injuries),
    marketSnapshots: marketSnapshots(season, marketNames, read),
    published: read(A.published),
    performance: read(A.performance),
    perfWeekly: A.perf_weekly ? read(A.perf_weekly) : null,
    forecasts: read(A.forecasts),
    records: { cfb: read(A.record.replace('{league}', 'cfb').replace('{season}', season)), nfl: read(A.record.replace('{league}', 'nfl').replace('{season}', season)) },
    /* the editorial matchup packets (tools/content/build_packets.js) */
    packets: read(A.packets)
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

module.exports = { load, frozen, frozenFiles, FROZEN, teamLists, readJson, ROOT };
