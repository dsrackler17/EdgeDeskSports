#!/usr/bin/env node
/* ===========================================================================
   The frozen regression week for the football evidence pipeline.

     node tools/content/evidence_fixture.js [--now 2026-10-08T21:00:00Z]

   Writes tools/content/fixtures/evidence_2026_w6.json: the Content Engine's
   research packet (with its football evidence packet) for the five games the
   repair was judged on — Ole Miss at Vanderbilt (the publisher's complaint),
   Georgia at Alabama, Texas vs. Oklahoma, Texas A&M at Missouri and UCLA at
   Oregon — plus one NFL game, built from the artifacts committed at that
   moment. The research artifacts are rebuilt hourly by automation; the
   fixture keeps the regression tests about the PIPELINE, not about whatever
   the data says this hour. Regenerate only on purpose.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CE = require(path.join(ROOT, 'lib', 'content_engine.js'));
const ART = require(path.join(__dirname, 'artifacts.js'));

const OUT = path.join(__dirname, 'fixtures', 'evidence_2026_w6.json');
const CFB = ['401856718', '401856712', '401856717', '401856716', '401858484'];
const NFL_PICK = (g) => /Bengals/.test(g.away) && /Dolphins/.test(g.home);

function arg(name, d) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

if (require.main === module) {
  const now = Date.parse(arg('now', '2026-10-08T21:00:00Z'));
  const art = ART.load({ now });
  const snap = CE.research.fromArtifacts(art, { now });
  const cfb = snap.cfb.games.filter((p) => CFB.includes(String(p.game_id)));
  const nfl = snap.nfl.games.filter(NFL_PICK).slice(0, 1);
  if (cfb.length !== CFB.length) throw new Error('only ' + cfb.length + ' of the five regression games are in the current research');
  const ctx = (league) => { const L = snap[league]; return league === 'cfb'
    ? { league: 'cfb', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets, betting_enabled: L.betting_enabled, operations_status: L.operations_status, typical_games_played: L.typical_games_played, rankings_as_of: L.rankings.as_of, top10: L.rankings.top.slice(0, 10), generated_at: L.generated_at, team_names: L.team_names }
    : { league: 'nfl', season: L.season, week: L.week, games_total: L.games_total, fresh_markets: L.fresh_markets, injuries_as_of: L.injuries_as_of, generated_at: L.generated_at, team_names: L.team_names }; };
  const out = {
    schema: 'edgedesk_evidence_fixture_v1', frozen_at: new Date(now).toISOString(),
    why: 'The five regression games and one NFL game, frozen: research packet + football evidence packet each.',
    teamLists: ART.teamLists(art),
    cfb: { context: ctx('cfb'), as_of: snap.cfb.generated_at, games: cfb },
    nfl: { context: ctx('nfl'), as_of: snap.nfl.generated_at, games: nfl },
    sources: snap.sources
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB): ' + cfb.map((p) => p.away + ' at ' + p.home).join('; ') + '; ' + nfl.map((p) => p.away + ' at ' + p.home).join('; '));
}
module.exports = { OUT, CFB };
