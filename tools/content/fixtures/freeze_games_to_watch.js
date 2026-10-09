#!/usr/bin/env node
'use strict';
/* ===========================================================================
   FREEZE the five October 10, 2026 games as a HISTORICAL TEST FIXTURE
   (tools/content/games_to_watch.test.js, docs/content-engine/GAMES_TO_WATCH.md)

   The hourly artifacts move on after Saturday; the regression must not. This
   copies, once, exactly the committed inputs the matchup packets for these
   five games read — the terminal's game objects, packet.js's measured
   pairings, the official availability entries, verified finals, quarterback
   logs, team profiles and the league context — into one gzipped file.

   The broadcast listings in it are NOT real listings: they are the networks
   named in the owner's brief, wrapped as an ESPN-shaped payload with .test
   URLs, so the verification code path runs. The fixture is labelled, and an
   article built from it can never be published (EDIT.FIXTURE).

     node tools/content/fixtures/freeze_games_to_watch.js    (already run 2026-10-08)
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..', '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const PK = require(path.join(ROOT, 'football', 'matchup', 'packet.js'));
const M = require(path.join(ROOT, 'lib', 'edgedesk_matchup.js'));
const BP = require(path.join(ROOT, 'tools', 'content', 'build_packets.js'));

const OUT = path.join(__dirname, 'games_to_watch_2026_w6.json.gz');
const NOW = '2026-10-08T20:00:00.000Z';
const IDS = ['401856718', '401856716', '401856717', '401858484', '401856712'];

function main() {
  const art = BP.load({ season: 2026, broadcasts: null });
  const now = Date.parse(NOW);
  const T = art.terminal;
  const games = {}; IDS.forEach((id) => { games[id] = T.games[id]; });
  const teams = {}; IDS.forEach((id) => { const g = T.games[id].game; teams[M.key(g.home)] = g.home; teams[M.key(g.away)] = g.away; });
  const keys = Object.keys(teams);
  const qb = M.qbIndex(art.qb_epa);
  const qbTeams = {}; keys.forEach((k) => { qbTeams[k] = qb.by_team[k] || []; });
  const profiles = {}; keys.forEach((k) => { profiles[k] = art.profiles.teams[k]; });
  const oppNames = new Set(); keys.forEach((k) => (profiles[k].opponents || []).forEach((o) => oppNames.add(o.opponent)));
  const schedule = {}; keys.forEach((k) => (profiles[k].opponents || []).forEach((o) => { if (qb.games[o.game_id]) schedule[o.game_id] = qb.games[o.game_id]; }));
  const rk = {}; Object.keys(art.rankings.teams).forEach((k) => { const t = art.rankings.teams[k]; if (t && t.team) rk[k] = { team: t.team, rank: t.rank, conference: t.conference, etsr: t.etsr, movement: t.movement || null }; });
  const settled = Object.values(art.settled.games || {});
  const doc = {
    schema: 'edgedesk_games_to_watch_fixture_v1',
    kind: 'HISTORICAL TEST FIXTURE — the October 10, 2026 games as EdgeDesk saw them on October 8. Never publishable; its dates are never reused for live publishing.',
    frozen_at: new Date().toISOString(), now: NOW, season: 2026, week: 6, game_ids: IDS,
    sources: { terminal: T.generated_at, profiles: art.profiles.generated_at, personnel: art.personnel.generated_at, qb_epa: art.qb_epa.generated_at, rankings: art.rankings.data_as_of || art.rankings.generated_at },
    terminal: { schema: T.schema, generated_at: T.generated_at, season: T.season, contract: T.contract, decision: T.decision, operations: T.operations, games },
    rankings: { data_as_of: art.rankings.data_as_of || null, generated_at: art.rankings.generated_at, week: art.rankings.week, teams: rk },
    football: Object.fromEntries(IDS.map((id) => [id, PK.build({ context: art.context, game_id: id, now })])),
    personnel: Object.fromEntries(IDS.map((id) => [id, art.personnel.games[id] || null])),
    reports: (art.reports.reports || []).filter((r) => IDS.indexOf(String(r.game_id)) >= 0),
    record_rows: (art.record.rows || []).filter((r) => keys.indexOf(M.key(r.home)) >= 0 || keys.indexOf(M.key(r.away)) >= 0),
    settled: settled.filter((g) => oppNames.has(g.home) || oppNames.has(g.away) || true).filter((g) => {
      const c = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const want = keys.map((k) => c(teams[k])).concat(['MISSISSIPP']);
      return want.indexOf(c(g.home)) >= 0 || want.indexOf(c(g.away)) >= 0;
    }),
    qb: { by_team: qbTeams, league_epa: qb.league_epa, league_int_rate: qb.league_int_rate, league_attempts: qb.league_attempts, games: schedule, generated_at: qb.generated_at },
    profiles: { generated_at: art.profiles.generated_at, season: 2026, teams: profiles },
    league: M.leagueFromProfiles(art.profiles),
    team_names: Object.values(rk).map((t) => t.team).concat(Object.values(T.games).map((g) => g.game && g.game.home), Object.values(T.games).map((g) => g.game && g.game.away)).filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i).sort(),
    /* FIXTURE broadcasts: the networks the owner's brief names, not a captured listing */
    broadcast_fixture: {
      note: 'FIXTURE: the networks named in the owner’s brief, shaped like an ESPN scoreboard payload; URLs are .test and nothing here was retrieved from ESPN',
      retrieved_at: '2026-10-08T19:00:00.000Z', url: 'https://fixture.test/espn-scoreboard/2026-10-10',
      events: [['401856718', '2026-10-10T19:30Z', 'ESPN'], ['401856716', '2026-10-10T16:00Z', 'ABC'], ['401856717', '2026-10-10T19:30Z', 'ABC'], ['401858484', '2026-10-10T19:30Z', 'CBS'], ['401856712', '2026-10-10T23:30Z', 'ABC']]
        .map((e) => ({ id: e[0], date: e[1], competitions: [{ date: e[1], timeValid: true, status: { type: { name: 'STATUS_SCHEDULED', detail: 'Sat, October 10th' } },
          geoBroadcasts: [{ type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: e[2] } }], competitors: [] }] }))
    }
  };
  fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify(doc), { level: 9 }));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + fs.statSync(OUT).size + ' bytes)');
}
if (require.main === module) main();
module.exports = { OUT, NOW, IDS };
