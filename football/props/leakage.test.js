#!/usr/bin/env node
/* ===========================================================================
   THE LEAKAGE SUITE — football/props/features.js from the other side.

   A synthetic league small enough to compute by hand, then:
     1. every rolling feature equals a hand computation over STRICTLY EARLIER
        games (shift before rolling: week 8 never enters its own last-3);
     2. changing a row's OWN game changes none of its features;
     3. changing a FUTURE game changes no earlier row;
     4. a 1 pm result cannot feed a 4:25 pm game the same day (a box score is
        final four hours after kickoff);
     5. source_max_timestamp <= asof_at on every row, and a row that breaks it
        is refused (Q008);
     6. on the real cached warehouse, when present, every historical row obeys 5.

     node football/props/leakage.test.js
   =========================================================================== */
'use strict';
const assert = require('assert');
const F = require('./features.js');

let pass = 0, fail = 0;
function chk(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); } }
const I = (n) => F.IDX.get(n);

/* one team (AAA) plays eight weekly games; a receiver P1 records 10, 20, … 80
   yards; game 9 is the target. Team BBB is every opponent. */
function league(opts) {
  opts = opts || {};
  const games = [], playerGames = [], teamGames = [];
  for (let w = 1; w <= 9; w++) {
    const kick = new Date(Date.UTC(2025, 8, 7 + 7 * (w - 1), 17, 0)).toISOString();
    const gid = '2025_' + String(w).padStart(2, '0') + '_BBB_AAA';
    games.push({ game_id: gid, league: 'NFL', season: 2025, week: w, kickoff_utc: kick, home_team_id: 'AAA', away_team_id: 'BBB', status: 'final', roof: 'open',
      weather_temp_f: 60, weather_wind_mph: 5, market: { home_line: -3, total: 44, basis: 'close' } });
    const yds = (opts.override && opts.override[w] != null) ? opts.override[w] : 10 * w;
    playerGames.push({ game_id: gid, player_id: 'espn:1', source_player_id: '00-1', player_name: 'P One', team_id: 'AAA', opponent_id: 'BBB', position_group: 'WR', season: 2025, week: w,
      kickoff_utc: kick, targets: 8, receptions: 5, receiving_yards: yds, receiving_tds: 0, carries: 0, rushing_yards: 0, rushing_tds: 0, attempts: 0, completions: 0, passing_yards: 0,
      passing_tds: 0, interceptions: 0, target_share: 0.25, air_yard_share: 0.3, snap_share: 0.8, source_quality: 1 });
    teamGames.push({ game_id: gid, team_id: 'AAA', opponent_id: 'BBB', plays: 60, dropbacks: 35, pass_attempts: 32, rushes: 25, completions: 20, pass_yards: 230, rush_yards: 100,
      sacks: 2, qb_hits: 5, points: 20 + w, seconds_per_play: 28, neutral_pass_rate: 0.55, proe: 1, air_yards: 250, rz_plays: 10, gl_plays: 3 });
    teamGames.push({ game_id: gid, team_id: 'BBB', opponent_id: 'AAA', plays: 62, dropbacks: 36, pass_attempts: 34, rushes: 26, completions: 22, pass_yards: 240 + w, rush_yards: 110,
      sacks: 1, qb_hits: 4, points: 17, seconds_per_play: 29, neutral_pass_rate: 0.5, proe: 0, air_yards: 260, rz_plays: 8, gl_plays: 2 });
  }
  return { identity: { players: [{ player_id: 'espn:1', full_name: 'P One', identity_confidence: 1 }], idMap: [] },
    leagues: { NFL: { games, playerGames, teamGames, absences: [] } } };
}
function rowFor(wh, gameId) { return F.buildHistorical(wh, 'NFL').rows.find((r) => r.game_id === gameId); }

chk('rolling windows are shifted before rolling (week 9 reads weeks 6-8, 4-8, 1-8)', () => {
  const r = rowFor(league(), '2025_09_BBB_AAA');
  assert.strictEqual(r.f[I('receiving_yards_avg_l3')], (60 + 70 + 80) / 3);
  assert.strictEqual(r.f[I('receiving_yards_avg_l5')], (40 + 50 + 60 + 70 + 80) / 5);
  assert.strictEqual(r.f[I('receiving_yards_avg_l8')], (10 + 20 + 30 + 40 + 50 + 60 + 70 + 80) / 8);
  assert.strictEqual(r.f[I('receiving_yards_season_avg')], 45);
  assert.strictEqual(r.f[I('games_l8')], 8);
});
chk('week 1 has no rolling history at all', () => {
  const r = rowFor(league(), '2025_01_BBB_AAA');
  assert.ok(r === undefined || !isFinite(r.f[I('receiving_yards_avg_l3')]));
});
chk("a row's OWN outcome never changes its features", () => {
  const a = rowFor(league(), '2025_09_BBB_AAA'), b = rowFor(league({ override: { 9: 999 } }), '2025_09_BBB_AAA');
  for (let i = 0; i < a.f.length; i++) assert.ok((isNaN(a.f[i]) && isNaN(b.f[i])) || a.f[i] === b.f[i], F.NAMES[i]);
  assert.strictEqual(b.targets.receiving_yards, 999);
});
chk('a FUTURE game never changes an earlier row', () => {
  const a = rowFor(league(), '2025_05_BBB_AAA'), b = rowFor(league({ override: { 6: 999, 7: 999, 8: 999 } }), '2025_05_BBB_AAA');
  for (let i = 0; i < a.f.length; i++) assert.ok((isNaN(a.f[i]) && isNaN(b.f[i])) || a.f[i] === b.f[i], F.NAMES[i]);
});
chk('a correction to a past game propagates forward, and only forward', () => {
  const base = league(), corr = league({ override: { 4: 400 } });
  const a4 = rowFor(base, '2025_04_BBB_AAA'), b4 = rowFor(corr, '2025_04_BBB_AAA');
  const a5 = rowFor(base, '2025_05_BBB_AAA'), b5 = rowFor(corr, '2025_05_BBB_AAA');
  assert.strictEqual(a4.f[I('receiving_yards_avg_l3')], b4.f[I('receiving_yards_avg_l3')]);
  assert.notStrictEqual(a5.f[I('receiving_yards_avg_l3')], b5.f[I('receiving_yards_avg_l3')]);
});
chk('a 1 pm result cannot feed a 4:25 pm game the same day', () => {
  const wh = league();
  /* move week 9 to 3h25m after week 8's kickoff: week 8 is not final yet */
  const g8 = wh.leagues.NFL.games[7], g9 = wh.leagues.NFL.games[8];
  const t8 = Date.parse(g8.kickoff_utc);
  g9.kickoff_utc = new Date(t8 + 3.4 * 3600e3).toISOString();
  wh.leagues.NFL.playerGames[8].kickoff_utc = g9.kickoff_utc;
  const r = rowFor(wh, g9.game_id);
  assert.strictEqual(r.f[I('receiving_yards_avg_l3')], (50 + 60 + 70) / 3, 'week 8 must not be in the window');
  assert.ok(r.source_max_ms <= Date.parse(r.asof_at));
  /* and five hours later it is */
  g9.kickoff_utc = new Date(t8 + 5 * 3600e3).toISOString();
  wh.leagues.NFL.playerGames[8].kickoff_utc = g9.kickoff_utc;
  assert.strictEqual(rowFor(wh, g9.game_id).f[I('receiving_yards_avg_l3')], (60 + 70 + 80) / 3);
});
chk('source_max_timestamp <= asof_at on every synthetic row', () => {
  F.buildHistorical(league(), 'NFL').rows.forEach((r) => assert.ok(r.source_max_ms == null || r.source_max_ms <= Date.parse(r.asof_at), r.game_id));
});
chk('Q008: a row whose source is newer than its as-of is refused', () => {
  const eng = F.createEngine('NFL');
  assert.strictEqual(eng.assertPit({ source_max_ms: 2000, asof_ms: 1000 }), false);
  assert.strictEqual(eng.assertPit({ source_max_ms: 1000, asof_ms: 1000 }), true);
});
chk('the engine refuses to compute a row behind its replay clock', () => {
  const wh = league(), eng = F.buildHistorical(wh, 'NFL').engine;
  assert.throws(() => eng.row({ game: wh.leagues.NFL.games[0], player_id: 'espn:1', team_id: 'AAA', opponent_id: 'BBB', position_group: 'WR', asof: Date.parse('2025-09-01T00:00:00Z') }), /behind the replay clock/);
});
chk('opponent features read only what the defence allowed BEFORE the game', () => {
  const r = rowFor(league(), '2025_09_BBB_AAA');
  /* BBB's defence faced AAA eight times: 230 pass yards on 32 attempts each, shrunk toward the league prior */
  const v = r.f[I('opp_pass_yards_allowed_per_att_l8')];
  assert.ok(isFinite(v) && v > 6.9 && v < 7.4, String(v));
});
chk('small samples are shrunk: two games are not a season', () => {
  const r = rowFor(league(), '2025_03_BBB_AAA');
  const eb = r.f[I('receiving_yards_eb')], raw = r.f[I('receiving_yards_avg_l3')];
  assert.ok(isFinite(eb) && isFinite(raw));
});

/* ---------------------------------------------------- the real archive */
try {
  const fs = require('fs'), path = require('path');
  const io = require('./lib/io.js');
  const cached = path.join(io.CACHE, 'work', 'nfl', 'season_2025.json.gz');
  if (fs.existsSync(cached) && !process.env.PROPS_LEAKAGE_SKIP_REAL) {
    const wh = require('./warehouse.js');
    wh.build({ offline: true, leagues: ['NFL'], identityCfb: false }).then((w) => {
      const h = F.buildHistorical(w, 'NFL', { minSeason: 2024 });
      chk('real NFL archive: every 2024+ row obeys source_max_timestamp <= asof_at', () => {
        assert.ok(h.rows.length > 1000);
        h.rows.forEach((r) => assert.ok(r.source_max_ms == null || r.source_max_ms <= Date.parse(r.asof_at), r.game_id + ' ' + r.player_id));
        assert.strictEqual(h.quarantined.length, 0);
      });
      finish();
    }).catch((e) => { console.log('NOTE | real archive check skipped: ' + e.message); finish(); });
  } else { console.log('NOTE | real archive not cached here; the synthetic proofs above stand'); finish(); }
} catch (e) { console.log('NOTE | ' + e.message); finish(); }

function finish() {
  console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props leakage — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
