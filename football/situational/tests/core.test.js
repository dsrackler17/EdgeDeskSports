#!/usr/bin/env node
/* ============================================================================
   FSIE core: situation definitions, source normalization (both sports),
   quality gates, aggregation, the download door (retries, rate limits, stale
   cache), checkpointed ingestion (resume, failure isolation, idempotency,
   revision detection), the coverage inventory and point-in-time features.
   Offline: every network call goes through an injected transport serving
   fixtures. Run: node football/situational/tests/core.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const H = require('./_harness.js');
const S = require('../core/situations.js');
const QC = require('../core/quality.js');
const A = require('../core/aggregate.js');
const F = require('../core/fetch.js');
const NFL = require('../nfl/source.js');
const CFB = require('../cfb/source.js');
const FT = require('../core/features.js');
const COV = require('../core/coverage.js');
const T = H.kit('fsie core');
const chk = T.chk;

/* ------------------------------------------------------------ situations */
const base = { down: 1, distance: 10, yards_to_goal: 75, goal_to_go: false, period: 1, sec_left_period: 800, score_diff: 0 };
const sit = (o, sp) => S.classify(Object.assign({}, base, o), sp || 'nfl');
chk('early down: 1st and 2nd', sit({ down: 1 }).early_down && sit({ down: 2 }).early_down && !sit({ down: 3 }).early_down);
chk('passing down: 2nd & 8+, 3rd/4th & 5+', sit({ down: 2, distance: 8 }).passing_down && !sit({ down: 2, distance: 7 }).passing_down && sit({ down: 3, distance: 5 }).passing_down && !sit({ down: 3, distance: 4 }).passing_down);
chk('short yardage: 3rd/4th & <= 2', sit({ down: 3, distance: 2 }).short_yardage && sit({ down: 4, distance: 1 }).short_yardage && !sit({ down: 2, distance: 1 }).short_yardage);
chk('red zone at the 20, not the 21', sit({ yards_to_goal: 20 }).red_zone && !sit({ yards_to_goal: 21 }).red_zone);
chk('goal to go from the flag or distance >= yards to goal', sit({ goal_to_go: true, yards_to_goal: 8, distance: 8 }).goal_to_go && sit({ goal_to_go: null, distance: 4, yards_to_goal: 4 }).goal_to_go);
chk('goal line = goal to go inside the 5', sit({ goal_to_go: true, yards_to_goal: 3, distance: 3 }).goal_line && !sit({ goal_to_go: true, yards_to_goal: 8, distance: 8 }).goal_line);
chk('two-minute: either half', sit({ period: 2, sec_left_period: 110 }).two_minute && sit({ period: 4, sec_left_period: 90 }).two_minute && !sit({ period: 1, sec_left_period: 60 }).two_minute);
chk('NFL garbage: none before Q3; Q3 >= 28; Q4 >= 22', !sit({ period: 2, score_diff: 40 }).garbage_time && sit({ period: 3, score_diff: -28 }).garbage_time && !sit({ period: 3, score_diff: 27 }).garbage_time && sit({ period: 4, score_diff: 22 }).garbage_time);
chk('CFB garbage uses the college thresholds (Q1 43, Q2 37)', sit({ period: 1, score_diff: 43 }, 'cfb').garbage_time && !sit({ period: 1, score_diff: 42 }, 'cfb').garbage_time && sit({ period: 2, score_diff: 37 }, 'cfb').garbage_time);
chk('sport configs are isolated: a 9-point Q1 lead is neutral in CFB, not in the NFL', sit({ score_diff: 9 }, 'cfb').neutral && !sit({ score_diff: 9 }, 'nfl').neutral);
chk('neutral excludes two-minute and garbage, and Q4', !sit({ period: 2, sec_left_period: 60 }).neutral && !sit({ period: 4, sec_left_period: 800 }).neutral && sit({ period: 3, score_diff: -7 }).neutral);
chk('leading/trailing at 8 (NFL) and 11 (CFB)', sit({ score_diff: 8 }).leading && sit({ score_diff: -8 }).trailing && !sit({ score_diff: 10 }, 'cfb').leading && sit({ score_diff: 11 }, 'cfb').leading);
chk('late clock splits leading and trailing', sit({ period: 4, sec_left_period: 250, score_diff: 3 }).late_clock_leading && sit({ period: 4, sec_left_period: 250, score_diff: -3 }).late_clock_trailing);
chk('exactly one script state per play', ['competitive', 'leading', 'trailing', 'garbage', 'two_minute'].indexOf(S.scriptState(sit({ score_diff: 30, period: 4 }))) >= 0 && S.scriptState(sit({ period: 4, score_diff: 30 })) === 'garbage');
chk('an unknown sport is refused', () => { try { S.classify(base, 'xfl'); return false; } catch (_) { return true; } });

/* ---------------------------------------------------- NFL normalization */
const NROW = { game_id: '2026_01_A_B', play_id: '10', season: '2026', week: '1', season_type: 'REG', home_team: 'B', away_team: 'A', posteam: 'A', defteam: 'B', qtr: '1', down: '1', ydstogo: '10', yardline_100: '75', goal_to_go: '0',
  quarter_seconds_remaining: '880', half_seconds_remaining: '1780', game_seconds_remaining: '3580', posteam_score: '0', defteam_score: '0', score_differential: '0', play_type: 'pass', sack: '0', qb_scramble: '0', qb_kneel: '0', qb_spike: '0',
  two_point_attempt: '0', play_deleted: '0', passer_player_id: 'Q1', receiver_player_id: 'W1', rusher_player_id: '', complete_pass: '1', shotgun: '1', no_huddle: '0', fixed_drive: '1', order_sequence: '10' };
const nk = (o) => NFL.kindOf(Object.assign({}, NROW, o));
chk('NFL kinds: pass, sack, scramble, rush, kneel, spike', nk({}) === 'pass' && nk({ sack: '1' }) === 'sack' && nk({ play_type: 'run', qb_scramble: '1' }) === 'scramble' && nk({ play_type: 'run' }) === 'rush' && nk({ play_type: 'qb_kneel' }) === 'kneel' && nk({ play_type: 'qb_spike' }) === 'spike');
chk('NFL exclusions: two-point, deleted, no_play, special, admin', nk({ two_point_attempt: '1' }) === 'two_point' && nk({ play_deleted: '1' }) === 'deleted' && nk({ play_type: 'no_play' }) === 'no_play' && nk({ play_type: 'punt' }) === 'special' && nk({ play_type: '' }) === 'admin');
chk('NFL official counting: spikes are pass attempts, kneels and scrambles are rushes, sacks neither', (() => {
  const p = (o) => NFL.normalizePbpRow(Object.assign({}, NROW, o), 'src');
  const sp = p({ play_type: 'qb_spike' }), kn = p({ play_type: 'qb_kneel' }), sc = p({ play_type: 'run', qb_scramble: '1' }), sk = p({ sack: '1' });
  return sp.pass_attempt && !sp.dropback && kn.rush_attempt && sc.rush_attempt && sc.dropback && !sk.pass_attempt && !sk.rush_attempt && sk.sack && sk.dropback;
})());
chk('NFL franchise codes fold to the current code on teams and game ids', NFL.team('OAK') === 'LV' && NFL.team('SD') === 'LAC' && NFL.team('STL') === 'LA' && NFL.gid('2016_01_OAK_NO') === '2016_01_LV_NO' && NFL.gid('2017_03_SD_KC') === '2017_03_LAC_KC');
chk('nflverse kickoff (US Eastern) to UTC across DST', NFL.kickoffUtc('2026-09-13', '13:00') === '2026-09-13T17:00:00.000Z' && NFL.kickoffUtc('2026-11-15', '13:00') === '2026-11-15T18:00:00.000Z');
chk('personnel strings map to the standard code', NFL.personnelKey('1 RB, 1 TE, 3 WR') === '11' && NFL.personnelKey('1 RB, 2 TE, 2 WR') === '12' && NFL.personnelKey('1 K, 1 P, 1 LS') === null);

/* ---------------------------------------------------- CFB normalization */
const CROW = { game_id: '401', season: '2026', week: '3', seasonType: '2', id: '40100', game_play_number: '5', sequenceNumber: '99', pos_team_id: '1', def_pos_team_id: '2', homeTeamId: '1', awayTeamId: '2', period: '2',
  'clock.minutes': '1', 'clock.seconds': '30', 'start.TimeSecsRem': '90', 'start.adj_TimeSecsRem': '1890', 'start.down': '3', 'start.distance': '7', 'start.yardsToEndzone': '40', goal_to_go: 'False',
  'start.pos_team_score': '14', 'start.def_pos_team_score': '7', 'drive.id': '4019', 'type.text': 'Pass Reception', scrimmage_play: 'True', rush: 'False', pass: 'True', sack: 'False', kneel_down: 'False',
  passer_player_id: '11.0', receiver_player_id: '22', completion: 'True', text: '(1:30) No Huddle-Shotgun #3 J.Doe pass complete', homeTeamSpread: '7.5', homeFavorite: 'False', gameSpreadAvailable: 'True', overUnder: '55.5', status_type_completed: 'True' };
const cr = (o) => CFB.normalizeRow(Object.assign({}, CROW, o), 'src');
chk('CFB kinds: pass, sack, kneel, rush, conflict, unclassified', cr({}).kind === 'pass' && cr({ sack: 'True' }).kind === 'sack' && cr({ kneel_down: 'True' }).kind === 'kneel' && cr({ pass: 'False', rush: 'True' }).kind === 'rush' && cr({ rush: 'True' }).kind === 'conflict' && cr({ pass: 'False' }).kind === 'unclassified');
chk('CFB exclusions: two-point, penalty, kickoff, punt on a scrimmage row', cr({ 'type.text': 'Two Point Pass' }).kind === 'two_point' && cr({ scrimmage_play: 'False', 'type.text': 'Penalty' }).kind === 'no_play' && cr({ scrimmage_play: 'False', 'type.text': 'Kickoff' }).kind === 'special' && cr({ 'type.text': 'Punt (Safety)' }).kind === 'special');
chk('CFB clock, half and score fields', (() => { const p = cr({}); return p.sec_left_period === 90 && p.sec_left_half === 90 && p.score_diff === 7 && p.off_is_home === true && p.seq === 5; })());
chk('CFB ids lose a float suffix', cr({}).passer_id === '11');
chk('CFB spread sign: an away favourite is a negative home margin', cr({}).home_spread_margin === -7.5 && cr({ homeFavorite: 'True' }).home_spread_margin === 7.5);
chk('formation tokens are observed only where charted', cr({}).shotgun === true && cr({}).no_huddle === true && cr({ text: '(1:30) #3 J.Doe pass complete' }).shotgun === null && cr({ text: 'Pistol #3 rush' }).shotgun === false);

/* ------------------------------------------------------------- quality */
const Q = (o) => QC.checkPlay(Object.assign({ off: 'A', def: 'B', game_id: 'g', src: 's', period: 1, sec_left_period: 500, down: 1, distance: 10, yards_to_goal: 60, score_off: 0, score_def: 0, kind: 'pass', passer_id: 'q', target_id: 't' }, o), 'nfl');
chk('a clean play passes', Q({}).length === 0);
chk('impossible down, distance, yard line, clock are flagged', Q({ down: 5 }).includes('invalid_down') && Q({ distance: 0 }).includes('invalid_distance') && Q({ yards_to_goal: 100 }).includes('impossible_yardline') && Q({ sec_left_period: 901 }).includes('invalid_clock') && Q({ distance: 20, yards_to_goal: 10 }).includes('distance_exceeds_goal'));
chk('missing teams, score, source are flagged', Q({ off: null }).includes('missing_team') && Q({ score_off: null }).includes('missing_score') && Q({ src: null }).includes('missing_source_version'));
chk('missing passer/target is an attribution failure, not a situation failure', Q({ passer_id: null }).includes('missing_passer') && QC.situationValid(Q({ passer_id: null, target_id: null })));
chk('a situation failure voids the situational cells', !QC.situationValid(Q({ down: 0 })));
chk('schema change is detected by column', (() => { const r = QC.checkSchema(['game_id'], 'nfl_pbp'); return !r.ok && r.missing.includes('posteam'); })());
chk('score path: a lone impossible spike is the only flagged play', (() => {
  const mk = (i, h, a) => ({ play_id: String(i), off_is_home: true, score_off: h, score_def: a });
  const ps = [mk(1, 0, 0), mk(2, 7, 0), mk(3, 50, 0), mk(4, 7, 0), mk(5, 7, 3), mk(6, 14, 3)];
  const f = QC.scoreFlags(ps, 21, 3); return f.size === 1 && f.has('3');
})());
chk('score path: a value above the final score is impossible', QC.scoreFlags([{ play_id: 'x', off_is_home: false, score_off: 30, score_def: 0 }], 21, 24).has('x'));

/* synthetic game: 2 teams x 30 snaps with a drive structure */
function synthGame(o) {
  o = o || {};
  const plays = []; let seq = 0;
  ['H', 'V'].forEach((off, k) => {
    for (let i = 0; i < (o.n || 40); i++) {
      seq++;
      const pass = i % 2 === 0;
      plays.push({ sport: 'nfl', season: 2026, week: 1, season_type: 'REG', game_id: 'G1', play_id: String(seq), seq, home: 'H', away: 'V', off, def: off === 'H' ? 'V' : 'H', off_is_home: off === 'H',
        period: 1 + Math.floor(i / 8), sec_left_period: 800 - (i % 8) * 30, sec_left_half: null, sec_left_game: 3600 - k * 10 - i * 30, down: 1 + (i % 3), distance: 10, yards_to_goal: 60 - i, goal_to_go: false,
        score_off: 0, score_def: 0, score_diff: 0, drive_id: 'G1:' + (k * 10 + Math.floor(i / 6)), kind: pass ? 'pass' : 'rush', pass_attempt: pass, rush_attempt: !pass, sack: false, scramble: false, kneel: false, spike: false, dropback: pass,
        passer_id: pass ? off + 'QB' : null, passer_name: off + ' QB', rusher_id: pass ? null : off + 'RB', rusher_name: off + ' RB', target_id: pass ? off + 'WR' + (i % 3) : null, target_name: 'wr', complete: i % 4 === 0,
        shotgun: off === 'H' ? i % 3 !== 0 : null, no_huddle: off === 'H' ? false : null, final_home: 21, final_away: 14, src: 'srcref' });
    }
  });
  return plays;
}
const sched = { G1: { game_id: 'G1', home: 'H', away: 'V', completed: true, home_score: 21, away_score: 14, kickoff_at: '2026-09-13T17:00:00.000Z', home_spread_margin: 3, total_line: 44 } };
const agg = A.aggregateSeason('nfl', synthGame(), sched, {});
const rH = agg.team_games.find((r) => r.team === 'H'), rV = agg.team_games.find((r) => r.team === 'V');
chk('aggregation: counts reconcile (pass + sacks + rush = plays)', rH.counts.plays === 40 && rH.counts.pass_att + rH.counts.sacks + rH.counts.rush_att === rH.counts.plays);
chk('aggregation: drives counted from distinct drive ids', rH.counts.drives === 7);
chk('aggregation: situational cells only see callable, valid plays', rH.sit.early_down.n === synthGame().filter((p) => p.off === 'H' && p.down <= 2).length && rH.sit.early_down.db + rH.sit.early_down.rush === rH.sit.early_down.n);
chk('aggregation: formation counted only where observed', rH.form.charted === 40 && rV.form.charted === 0);
chk('aggregation: the market is carried from the team\'s side', rH.market.spread_margin === 3 && rV.market.spread_margin === -3);
chk('aggregation: player usage — starter, targets, receptions', (() => { const qb = agg.player_games.find((p) => p.player_id === 'HQB'); const wr = agg.player_games.filter((p) => p.team === 'H' && /WR/.test(p.player_id)); return qb.started && qb.pass_att === 20 && wr.reduce((s, p) => s + p.targets, 0) === 20; })());
chk('aggregation: the game passes its gates', agg.games.G1.status === 'accepted');
chk('a game whose final score disagrees with the schedule is rejected', (() => { const a2 = A.aggregateSeason('nfl', synthGame(), { G1: Object.assign({}, sched.G1, { home_score: 24 }) }, {}); return a2.games.G1.status === 'rejected' && a2.games.G1.reasons.includes('final_score_mismatch'); })());
chk('a play attributed to a third team is a bad mapping and rejects the game', (() => { const ps = synthGame(); ps[3].off = 'ZZ'; const a2 = A.aggregateSeason('nfl', ps, sched, {}); return a2.games.G1.reasons.some((r) => /invalid_team_mapping/.test(r)) && a2.games.G1.status === 'rejected'; })());
chk('duplicate plays reject the game', (() => { const ps = synthGame(); ps.push(Object.assign({}, ps[0])); const a2 = A.aggregateSeason('nfl', ps, sched, {}); return a2.games.G1.reasons.some((r) => /duplicate_plays/.test(r)); })());
chk('an incomplete game (no fourth quarter) is rejected', (() => { const a2 = A.aggregateSeason('nfl', synthGame({ n: 20 }), sched, {}); return a2.games.G1.reasons.some((r) => /incomplete_game/.test(r)); })());
chk('a box-score mismatch rejects that team-game only', (() => { const a2 = A.aggregateSeason('nfl', synthGame(), sched, { box: { 'G1|H': { pass_att: 30, rush_att: 20 }, 'G1|V': { pass_att: 20, rush_att: 20 } } }); return !a2.team_games.find((r) => r.team === 'H').quality.volume_ok && a2.team_games.find((r) => r.team === 'V').quality.volume_ok && a2.games.G1.status === 'partial'; })());
chk('missing passer ids fail the PLAYER gate and keep the volume label', (() => { const ps = synthGame(); ps.filter((p) => p.off === 'V' && p.kind === 'pass').forEach((p) => { p.passer_id = null; }); const a2 = A.aggregateSeason('nfl', ps, sched, {}); const q = a2.team_games.find((r) => r.team === 'V').quality; return q.volume_ok && !q.player_ok; })());
chk('bad down/distance on many plays fails the SITUATION gate and keeps the volume label', (() => { const ps = synthGame(); ps.filter((p) => p.off === 'V').slice(0, 5).forEach((p) => { p.down = 0; }); const a2 = A.aggregateSeason('nfl', ps, sched, {}); const q = a2.team_games.find((r) => r.team === 'V').quality; return q.volume_ok && !q.situation_ok; })());

/* ----------------------------------------------------- the download door */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsie-core-'));
  await T.achk('a 503 is retried with backoff, then served and recorded in the manifest', async () => {
    let calls = 0; const body = Buffer.from('x'.repeat(600));
    const r = await F.getFile('https://example.test/a.csv', 'a_2020.csv', { cache_dir: tmp, season: 2026, backoff_ms: 1, transport: async () => (++calls < 2 ? { status: 503 } : { status: 200, buf: body, last_modified: 'Mon' }) });
    const m = F.readManifest(tmp);
    return r.ok && r.attempts === 2 && r.from === 'network' && m.files['a_2020.csv'] && m.files['a_2020.csv'].sha256 === r.sha256 && m.files['a_2020.csv'].last_modified === 'Mon';
  });
  await T.achk('a 404 is an answer: no retry', async () => { let calls = 0; const r = await F.getFile('https://example.test/b.csv', 'b_2026.csv', { cache_dir: tmp, backoff_ms: 1, transport: async () => { calls++; return { status: 404 }; } }); return !r.ok && calls === 1 && r.status === 404; });
  await T.achk('a completed season is permanent in the cache (no network call)', async () => { let calls = 0; const r = await F.getFile('https://example.test/a.csv', 'a_2020.csv', { cache_dir: tmp, season: 2026, transport: async () => { calls++; return { status: 500 }; } }); return r.ok && r.from === 'cache' && calls === 0; });
  await T.achk('the season in progress refetches; a failed refetch serves the stale cache and says so', async () => {
    const body = Buffer.from('y'.repeat(600));
    await F.getFile('https://example.test/c.csv', 'c_2026.csv', { cache_dir: tmp, season: 2026, transport: async () => ({ status: 200, buf: body }) });
    /* a minute old, not "just written": mtimeMs has sub-millisecond precision and Date.now() does not, so a
       file read back within the millisecond it was written is 0 or less old, and fresh even at TTL 0 */
    const aMinuteAgo = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(tmp, 'raw', 'c_2026.csv'), aMinuteAgo, aMinuteAgo);
    process.env.EDP_CACHE_TTL_MS = '0';
    const r = await F.getFile('https://example.test/c.csv', 'c_2026.csv', { cache_dir: tmp, season: 2026, retries: 1, backoff_ms: 1, transport: async () => ({ status: 502 }) });
    delete process.env.EDP_CACHE_TTL_MS;
    return r.ok && r.from === 'stale-cache' && /HTTP 502/.test(r.error);
  });
  await T.achk('bounded concurrency never exceeds its limit', async () => { let live = 0, peak = 0; await F.mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; }); return peak <= 3; });

  /* ------------------------------------------- checkpointed NFL ingestion */
  const I = require('../core/ingest.js');
  const hdr = NFL.PBP_COLS;
  const csvOf = (rows) => hdr.join(',') + '\n' + rows.map((r) => hdr.map((h) => (r[h] == null ? '' : String(r[h]))).join(',')).join('\n') + '\n';
  function seasonFixture(season, scoreHome) {
    const rows = []; let seq = 0;
    ['A', 'B'].forEach((off) => {
      for (let i = 0; i < 40; i++) {
        seq++;
        rows.push(Object.assign({}, NROW, { game_id: season + '_01_A_B', play_id: String(seq), order_sequence: String(seq), season: String(season), posteam: off, defteam: off === 'A' ? 'B' : 'A', home_team: 'B', away_team: 'A',
          qtr: String(1 + Math.floor(i / 10)), quarter_seconds_remaining: String(800 - (i % 10) * 40), game_seconds_remaining: String(3500 - i * 60), play_type: i % 3 ? 'pass' : 'run', fixed_drive: String(Math.floor(i / 5) + (off === 'A' ? 0 : 20)),
          rusher_player_id: i % 3 ? '' : off + 'RB', receiver_player_id: i % 3 ? off + 'WR' : '', passer_player_id: i % 3 ? off + 'QB' : '', home_score: String(scoreHome), away_score: '10', yardline_100: '60', ydstogo: '10', down: String(1 + (i % 3)) }));
      }
    });
    return zlib.gzipSync(csvOf(rows));
  }
  const schedCsv = (season, hs) => 'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,spread_line,total_line,home_rest,away_rest,roof,div_game,home_coach,away_coach\n'
    + season + '_01_A_B,' + season + ',REG,1,' + season + '-09-13,13:00,A,10,B,' + hs + ',3,44,7,7,outdoors,0,X,Y\n';
  let failSeason = null; const served = {};
  const transport = async (url) => {
    const m = /play_by_play_(\d{4})/.exec(url);
    if (m) { if (+m[1] === failSeason) return { status: 500 }; served[m[1]] = (served[m[1]] || 0) + 1; return { status: 200, buf: seasonFixture(+m[1], 17) }; }
    if (/schedules\/games\.csv/.test(url)) return { status: 200, buf: Buffer.from(schedCsv(2018, 17) + schedCsv(2019, 17).split('\n')[1] + '\n' + schedCsv(2020, 17).split('\n')[1] + '\n') };
    return { status: 404 };
  };
  const ocache = fs.mkdtempSync(path.join(os.tmpdir(), 'fsie-ingest-'));
  const opts = { cache_dir: ocache, transport, retries: 0, backoff_ms: 1, quiet: true, current_season: 2026 };
  failSeason = 2019;
  const bf1 = await I.backfill('nfl', [2018, 2019, 2020], opts);
  chk('backfill isolates a failed season and builds the others', bf1.results.map((r) => r.status).join(',') === 'built,failed,built' && bf1.failed === 1);
  failSeason = null;
  const before2018 = served['2018'];
  const bf2 = await I.backfill('nfl', [2018, 2019, 2020], opts);
  chk('a resumed backfill skips finished seasons and retries only the failed one', bf2.results.map((r) => r.status).join(',') === 'skipped,built,skipped' && served['2018'] === before2018);
  const d2018 = I.loadDerived('nfl', 2018, opts);
  chk('ingested season: provenance on every source, a source_ref on every team-game', d2018.sources.every((s) => s.url && s.name) && d2018.team_games.every((r) => r.src && /@/.test(r.src)));
  chk('ingested season: the fixture game is accepted with its counts reconciled', d2018.games['2018_01_A_B'].status === 'accepted' && d2018.team_games.every((r) => r.counts.pass_att + r.counts.sacks + r.counts.rush_att === r.counts.plays));
  const sha1 = d2018.content_sha256;
  await I.ingestSeason('nfl', 2018, Object.assign({}, opts, { force: true }));
  chk('re-ingesting unchanged inputs is idempotent (same content hash)', I.loadDerived('nfl', 2018, opts).content_sha256 === sha1);
  chk('a schema change fails the load and publishes nothing', await (async () => {
    const junk = 'game_id,play_id\n' + Array.from({ length: 400 }, (_, i) => 'g' + i + ',' + (i * 7919 % 10007)).join('\n') + '\n';
    const bad = Object.assign({}, opts, { force: true, transport: async (url) => (/play_by_play/.test(url) ? { status: 200, buf: zlib.gzipSync(junk) } : transport(url)) });
    const r = await I.ingestSeason('nfl', 2020, bad); return !r.ok && r.stage === 'schema';
  })());

  /* ------------------------------------------------------------ coverage */
  const cov = COV.build('nfl', d2018, { now: '2018-12-01T00:00:00Z' });
  chk('coverage: every scheduled team appears, with games expected/available/accepted', cov.eligible_teams === 2 && cov.teams.every((t) => t.games_expected === 1 && t.games_available === 1 && t.games_accepted === 1));
  chk('coverage: a tier and missing fields for every team', cov.teams.every((t) => 'ABCD'.indexOf(t.tier) >= 0 && Array.isArray(t.missing_fields)));
  chk('coverage: latest complete week', cov.latest_complete_week === 1);

  /* -------------------------------------------- point-in-time features */
  const season = { team_games: [], schedule: [] };
  const mkRow = (gid, k, team, opp, plays, db) => {
    const r = JSON.parse(JSON.stringify(rH)); r.game_id = gid; r.team = team; r.opp = opp; r.kickoff_at = k; r.season_type = 'REG';
    r.counts.plays = plays; r.counts.dropbacks = db; r.counts.pass_att = db; r.counts.rush_att = plays - db; r.counts.sacks = 0;
    r.script.competitive = { n: plays, db, rush: plays - db }; ['leading', 'trailing', 'garbage', 'two_minute'].forEach((s) => { r.script[s] = { n: 0, db: 0, rush: 0 }; });
    r.quality = { volume_ok: true, situation_ok: true, player_ok: true, reasons: [] }; return r;
  };
  [['g1', '2026-09-10T00:00:00Z'], ['g2', '2026-09-17T00:00:00Z'], ['g3', '2026-09-24T00:00:00Z']].forEach(([gid, k], i) => {
    season.team_games.push(mkRow(gid, k, 'X', 'Y', 60 + i * 5, 35), mkRow(gid, k, 'Y', 'X', 62, 30));
  });
  const w1 = FT.walkSeason('nfl', season, null, {});
  const alt = JSON.parse(JSON.stringify(season)); alt.team_games.filter((r) => r.game_id !== 'g1').forEach((r) => { r.counts.plays = 99; r.script.competitive.n = 99; r.script.competitive.db = 90; });
  const w2 = FT.walkSeason('nfl', alt, null, {});
  chk('no leakage: a game\'s features ignore that game and every later one', JSON.stringify(w1.byTeamGame.get('g2|X').off.plays_pg) === JSON.stringify(w2.byTeamGame.get('g2|X').off.plays_pg));
  chk('features move after a game is absorbed', w1.byTeamGame.get('g3|X').off.plays_pg.raw !== w1.byTeamGame.get('g2|X').off.plays_pg.raw);
  chk('the defence\'s faced rates are its opponents\' offence', Math.abs(w1.final.Y.def.plays_pg.raw - (60 * Math.pow(0.5, 2 / 6) + 65 * Math.pow(0.5, 1 / 6) + 70) / (Math.pow(0.5, 2 / 6) + Math.pow(0.5, 1 / 6) + 1)) < 0.01);
  chk('every metric carries its sample and prior', ['pr_all', 'plays_pg', 'ppd'].every((m) => { const x = w1.final.X.off[m]; return x && x.n != null && x.prior != null; }));
  chk('a new head coach halves last season\'s carry-over', (() => {
    const prev = JSON.parse(JSON.stringify(season)); prev.team_games.forEach((r) => { r.kickoff_at = r.kickoff_at.replace('2026', '2025'); });
    const a = FT.walkSeason('nfl', season, prev, { coaches: { X: { new_hc: false } } }).byTeamGame.get('g1|X').meta.prior_games;
    const b = FT.walkSeason('nfl', season, prev, { coaches: { X: { new_hc: true } } }).byTeamGame.get('g1|X').meta.prior_games;
    return a === 3 && b === 1.5;
  })());
  chk('unobserved charting stays null (never imputed)', w1.final.X.off.motion_rate === null && w1.final.X.def.box_avg === null);

  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(ocache, { recursive: true, force: true });
  process.exit(T.done());
})();
