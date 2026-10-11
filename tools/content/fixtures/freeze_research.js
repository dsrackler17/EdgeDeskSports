#!/usr/bin/env node
'use strict';
/* ===========================================================================
   FREEZE the Content Engine's research for CFB Week 6 and NFL Week 5 as a
   HISTORICAL TEST FIXTURE (tools/content/fixtures/research_2026_w6.json.gz,
   read by ART.frozen() in tools/content/artifacts.js)

   content.test.js, run.test.js, content_engine_fn.test.js,
   content_engine.e2e.js and tools/editorial/features.test.js hold the engine
   to what that week's research said: Georgia at Alabama, the unexplained gaps
   the preview is blocked on, the graded Week 5 weekend, a Thursday clock. The
   hourly artifacts move on: on October 10 the market captures passed the
   suites' Thursday clock, on October 11 the slate rolled to Week 7, and every
   suite that read the live files went red. This file does not move.

   It copies, once, the files ART.load() reads (CE.ARTIFACTS) from a checkout
   of the research committed at 14:54 UTC on October 9 (COMMIT), the last state
   every suite passed on, with the football evidence packets built at AT the
   way ART.load() builds them. Two files are trimmed, and the trim is checked:
   the research the engine builds from the fixture is byte for byte the
   research it builds from the full files, at every moment the suites read it.

     football/cfb_terminal/games.json   Week 6 games keep every key the
                                        research reads; Week 7's keep their
                                        season, week and teams (the league's
                                        team list)
     football/rankings/current.json     each team's name, conference, rank,
                                        rating and rank movement
     football/evidence/packets.json     the packets ART.load() builds at AT
     football/content/packets.json      not copied: the hourly matchup packets
                                        move with the week, and Five Games to
                                        Watch has its own frozen fixture

     git archive 9dc69f670a lib tools/content football record articles/data | tar -x -C /tmp/w6
     node tools/content/fixtures/freeze_research.js --root /tmp/w6    (already run 2026-10-11)
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'research_2026_w6.json.gz');
const COMMIT = '9dc69f670af775a660c831e1c19ec06c2a2888b6';
const AT = '2026-10-09T15:00:00.000Z';
/* every moment a suite reads this research at: features.test.js's slots from
   Monday, October 5 to Wednesday, October 14, the Thursday the others pin,
   and content.test.js's kicked-off and end-of-season checks */
const READ_AT = ['2026-10-05T13:30:00Z', '2026-10-07T13:30:00Z', '2026-10-07T14:30:00Z', '2026-10-08T15:00:00Z', '2026-10-08T17:30:00Z', '2026-10-09T08:00:00Z',
  '2026-10-09T10:30:00Z', '2026-10-09T13:30:00Z', '2026-10-09T14:00:00Z', '2026-10-09T14:30:00Z', '2026-10-11T12:00:00Z', '2026-10-12T13:30:00Z',
  '2026-10-12T15:00:00Z', '2026-10-14T13:30:00Z', '2026-11-30T12:00:00Z'];
const RANKING_KEYS = ['team', 'conference', 'rank', 'etsr'];

function arg(name, d) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const clone = (x) => JSON.parse(JSON.stringify(x));

function main() {
  const root = path.resolve(arg('root', path.join(__dirname, '..', '..', '..')));
  const CE = require(path.join(root, 'lib', 'content_engine.js'));
  const ART = require(path.join(root, 'tools', 'content', 'artifacts.js'));
  const A = CE.ARTIFACTS;
  const art = ART.load({ now: Date.parse(AT) });
  art.packets = null;
  const research = (a) => { try { return READ_AT.map((t) => JSON.stringify(CE.research.fromArtifacts(a, { now: Date.parse(t) }))).join('\n'); } catch (e) { return 'threw: ' + e.message; } };
  const want = research(art);
  const week = art.cfbBrief.week, season = art.nflSlate.season;

  /* the rankings: what the research reads of each team */
  const rankings = { schema: art.rankings.schema, season: art.rankings.season, week: art.rankings.week, data_as_of: art.rankings.data_as_of, generated_at: art.rankings.generated_at, teams: {} };
  Object.keys(art.rankings.teams).forEach((k) => { const t = art.rankings.teams[k]; if (!t) return;
    const row = {}; RANKING_KEYS.forEach((x) => { if (t[x] !== undefined) row[x] = t[x]; });
    if (t.movement && t.movement.rank) row.movement = { rank: t.movement.rank };
    rankings.teams[k] = row; });
  /* the terminal: other weeks name their teams; this week's games drop, one
     key at a time, only what the research does not change without */
  const games = clone(art.cfbGames);
  Object.keys(games.games).forEach((k) => { const g = games.games[k]; if (g.week !== week) games.games[k] = { season: g.season, week: g.week, game: { home: g.game.home, away: g.game.away } }; });
  const ours = Object.keys(games.games).filter((k) => games.games[k].week === week);
  const keys = [...new Set([].concat(...ours.map((k) => Object.keys(games.games[k]))))]
    .sort((x, y) => ours.reduce((n, k) => n + JSON.stringify(games.games[k][y] || '').length, 0) - ours.reduce((n, k) => n + JSON.stringify(games.games[k][x] || '').length, 0));
  const trial = Object.assign({}, art, { rankings, cfbGames: games });
  if (research(trial) !== want) throw new Error('the trimmed rankings or the other weeks change the research');
  const dropped = [];
  keys.forEach((key) => {
    const kept = ours.map((k) => games.games[k][key]);
    ours.forEach((k) => { delete games.games[k][key]; });
    if (research(trial) === want) dropped.push(key);
    else ours.forEach((k, i) => { if (kept[i] !== undefined) games.games[k][key] = kept[i]; });
  });
  if (research(trial) !== want) throw new Error('the trimmed terminal changes the research');

  const files = {};
  files[A.cfb_games] = games;
  files[A.cfb_brief] = art.cfbBrief;
  files[A.rankings] = rankings;
  files[A.nfl_slate] = art.nflSlate;
  files[A.nfl_injuries] = art.nflInjuries;
  files[A.published] = art.published;
  files[A.performance] = art.performance;
  files[A.forecasts] = art.forecasts;
  files[A.evidence] = art.evidence;
  ['cfb', 'nfl'].forEach((lg) => { files[A.record.replace('{league}', lg).replace('{season}', season)] = art.records[lg]; });
  const mdir = path.dirname(A.market);
  fs.readdirSync(path.join(root, mdir)).filter((f) => new RegExp('^' + season + '-week-\\d+\\.json$').test(f)).sort()
    .forEach((f) => { files[mdir + '/' + f] = JSON.parse(fs.readFileSync(path.join(root, mdir, f), 'utf8')); });
  Object.keys(files).forEach((f) => { if (files[f] == null) delete files[f]; });

  const doc = {
    schema: 'edgedesk_research_fixture_v1',
    kind: 'HISTORICAL TEST FIXTURE — the research EdgeDesk committed for CFB Week 6 and NFL Week 5, as it stood at 14:54 UTC on October 9, 2026. Never publishable; its dates are never reused for live publishing.',
    frozen_at: new Date().toISOString(), commit: COMMIT, at: AT, season, cfb_week: week,
    trimmed: { [A.cfb_games]: 'Week ' + week + ' games without ' + dropped.join(', ') + '; other weeks: season, week and teams only', [A.rankings]: 'each team’s ' + RANKING_KEYS.join(', ') + ' and rank movement',
      [A.evidence]: 'built by tools/content/evidence.js at ' + AT + ' from the commit’s inputs (what ART.load() builds)' },
    files
  };
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  console.log('wrote ' + path.relative(path.join(__dirname, '..', '..', '..'), OUT) + ' (' + fs.statSync(OUT).size + ' bytes): ' + Object.keys(files).length + ' files; Week ' + week + ' games without ' + dropped.length + ' of ' + keys.length + ' keys');
}
if (require.main === module) main();
module.exports = { OUT, COMMIT, AT, READ_AT };
