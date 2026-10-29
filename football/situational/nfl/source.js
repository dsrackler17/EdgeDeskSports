/* ============================================================================
   FSIE — NFL source adapter (nflverse release assets, keyless).

   One normalized play per scrimmage snap, with the counting definitions that
   reproduce nflverse's own team box score exactly (2026 weeks 1-7: 214 of 214
   team-games match on attempts, carries and sacks):
     pass_attempt  = a non-sack pass play, plus a spike        (official ATT)
     rush_attempt  = a run (designed or scramble), plus a kneel (official CAR)
     sack          = a sack
     plays         = pass_attempt + sack + rush_attempt
   Two-point tries, nullified (no_play) snaps, deleted plays and special teams
   are excluded and counted, never silently dropped.

   Charting the engine may use, and only where it exists:
     shotgun / no_huddle   pbp (the league's own play description), every season
     FTN charting          2022+, weekly in season (box count, motion, play
                           action, RPO, screen, pass rushers, blitzers)
     participation         2016+, published after the season ends (formation,
                           personnel, defenders in box, coverage 2023+). Never
                           treated as weekly real-time information.
   ========================================================================== */
'use strict';
const path = require('path');
const io = require(path.join(__dirname, '..', '..', 'props', 'factory', 'lib', 'io.js'));
const F = require(path.join(__dirname, '..', 'core', 'fetch.js'));

const BASE = (process.env.EDGEDESK_NFLVERSE_RELEASES || 'https://github.com/nflverse/nflverse-data/releases/download').replace(/\/+$/, '');
const URLS = {
  pbp: (y) => `${BASE}/pbp/play_by_play_${y}.csv.gz`,
  ftn: (y) => `${BASE}/ftn_charting/ftn_charting_${y}.csv`,
  participation: (y) => `${BASE}/pbp_participation/pbp_participation_${y}.csv`,
  schedules: () => `${BASE}/schedules/games.csv`,
  injuries: (y) => `${BASE}/injuries/injuries_${y}.csv`,
  rosters: (y) => `${BASE}/weekly_rosters/roster_weekly_${y}.csv`
};
const FIRST_SEASON = { pbp: 1999, ftn: 2022, participation: 2016 };

const PBP_COLS = ['game_id', 'old_game_id', 'play_id', 'season', 'week', 'season_type', 'game_date', 'home_team', 'away_team',
  'posteam', 'defteam', 'qtr', 'down', 'ydstogo', 'yardline_100', 'goal_to_go', 'quarter_seconds_remaining',
  'half_seconds_remaining', 'game_seconds_remaining', 'posteam_score', 'defteam_score', 'score_differential',
  'play_type', 'pass_attempt', 'rush_attempt', 'sack', 'qb_scramble', 'qb_kneel', 'qb_spike', 'qb_dropback',
  'two_point_attempt', 'play_deleted', 'passer_player_id', 'passer_player_name', 'rusher_player_id', 'rusher_player_name',
  'receiver_player_id', 'receiver_player_name', 'complete_pass', 'shotgun', 'no_huddle', 'fixed_drive', 'drive',
  'home_score', 'away_score', 'total_home_score', 'total_away_score', 'wp', 'spread_line', 'total_line', 'yards_gained',
  'penalty', 'aborted_play', 'start_time', 'time_of_day', 'order_sequence', 'home_coach', 'away_coach'];
const FTN_COLS = ['nflverse_game_id', 'nflverse_play_id', 'week', 'qb_location', 'n_offense_backfield', 'n_defense_box',
  'is_no_huddle', 'is_motion', 'is_play_action', 'is_screen_pass', 'is_rpo', 'is_trick_play', 'n_blitzers', 'n_pass_rushers', 'date_pulled'];
const PART_COLS = ['nflverse_game_id', 'play_id', 'possession_team', 'offense_formation', 'offense_personnel', 'defenders_in_box',
  'defense_personnel', 'number_of_pass_rushers', 'defense_man_zone_type', 'defense_coverage_type'];

/* franchise codes: nflverse's play-by-play carries the current franchise code
   in every season while its schedule and box score keep the historical one
   (OAK/SD/STL in 2016-2019). One map, the one football/props/factory uses. */
const ALIAS = { LAR: 'LA', SD: 'LAC', OAK: 'LV', STL: 'LA', WSH: 'WAS', JAC: 'JAX' };
function team(code) { if (code == null || code === '' || code === 'NA') return null; return ALIAS[code] || code; }
function gid(id) { if (!id) return id; return String(id).replace(/_(OAK|SD|STL|LAR|WSH|JAC)(?=_|$)/g, (m, c) => '_' + ALIAS[c]); }

const num = io.num;
function b01(v) { return v === '1' || v === 'TRUE' || v === 'true' ? true : (v === '0' || v === 'FALSE' || v === 'false' ? false : null); }
function str(v) { return v == null || v === '' || v === 'NA' ? null : String(v); }

/* play_type + flags -> one kind */
function kindOf(r) {
  if (r.play_deleted === '1') return 'deleted';
  if (r.two_point_attempt === '1') return 'two_point';
  const pt = r.play_type;
  if (pt === 'qb_kneel') return 'kneel';
  if (pt === 'qb_spike') return 'spike';
  if (pt === 'pass' || pt === 'run') {
    if (r.sack === '1') return 'sack';
    if (r.qb_scramble === '1') return 'scramble';
    return pt === 'pass' ? 'pass' : 'rush';
  }
  if (pt === 'no_play') return 'no_play';
  if (pt === 'punt' || pt === 'kickoff' || pt === 'field_goal' || pt === 'extra_point') return 'special';
  return 'admin';                         /* timeouts, quarter ends, game start */
}

function normalizePbpRow(r, src) {
  const kind = kindOf(r);
  const off = team(r.posteam), def = team(r.defteam);
  const per = num(r.qtr);
  return {
    sport: 'nfl', season: num(r.season), week: num(r.week), season_type: str(r.season_type),
    game_id: gid(str(r.game_id)), play_id: str(r.play_id), seq: num(r.order_sequence), game_date: str(r.game_date),
    home: team(r.home_team), away: team(r.away_team), off, def, off_is_home: off ? off === team(r.home_team) : null,
    period: per, sec_left_period: num(r.quarter_seconds_remaining), sec_left_half: num(r.half_seconds_remaining),
    sec_left_game: num(r.game_seconds_remaining),
    down: num(r.down), distance: num(r.ydstogo), yards_to_goal: num(r.yardline_100),
    goal_to_go: b01(r.goal_to_go),
    score_off: num(r.posteam_score), score_def: num(r.defteam_score), score_diff: num(r.score_differential),
    drive_id: r.fixed_drive ? r.game_id + ':' + r.fixed_drive : null,
    kind,
    pass_attempt: kind === 'pass' || kind === 'spike', rush_attempt: kind === 'rush' || kind === 'scramble' || kind === 'kneel',
    sack: kind === 'sack', scramble: kind === 'scramble', kneel: kind === 'kneel', spike: kind === 'spike',
    dropback: kind === 'pass' || kind === 'sack' || kind === 'scramble',
    passer_id: str(r.passer_player_id), passer_name: str(r.passer_player_name),
    rusher_id: str(r.rusher_player_id), rusher_name: str(r.rusher_player_name),
    target_id: str(r.receiver_player_id), target_name: str(r.receiver_player_name),
    complete: r.complete_pass === '1', yards: num(r.yards_gained),
    shotgun: b01(r.shotgun), no_huddle: b01(r.no_huddle),
    wp: num(r.wp),
    final_home: num(r.home_score), final_away: num(r.away_score),
    run_home: num(r.total_home_score), run_away: num(r.total_away_score),
    spread_line: num(r.spread_line), total_line: num(r.total_line),
    home_coach: str(r.home_coach), away_coach: str(r.away_coach),
    src
  };
}

async function download(kind, season, opts) {
  const url = kind === 'schedules' ? URLS.schedules() : URLS[kind](season);
  const name = kind === 'schedules' ? 'nfl_schedules_games.csv' : `nfl_${kind}_${season}${kind === 'pbp' ? '.csv.gz' : '.csv'}`;
  return F.getFile(url, name, Object.assign({ season: opts && opts.current_season }, opts || {}));
}

/* -> { ok, plays[], games{}, source{}, excluded{kind:count}, header[] } */
async function loadSeason(season, opts) {
  opts = opts || {};
  const got = await download('pbp', season, opts);
  if (!got.ok) return { ok: false, error: got.error, source: { name: 'nflverse play_by_play', url: got.url } };
  const src = { name: 'nflverse play_by_play', url: got.url, sha256: got.sha256, bytes: got.bytes, last_modified: got.last_modified || null, pulled_at: got.retrieved_at || null, from: got.from };
  const srcRef = 'nflverse_pbp_' + season + '@' + String(got.sha256).slice(0, 16);
  const plays = []; const excluded = {}; const games = {};
  const res = await io.readCsv(got.file, (r) => {
    if (opts.weeks && opts.weeks.indexOf(+r.week) < 0) return;
    const p = normalizePbpRow(r, srcRef);
    if (p.game_id && !games[p.game_id]) games[p.game_id] = { game_id: p.game_id, season: p.season, week: p.week, season_type: p.season_type, home: p.home, away: p.away, game_date: p.game_date, final_home: p.final_home, final_away: p.final_away, spread_line: p.spread_line, total_line: p.total_line, home_coach: p.home_coach, away_coach: p.away_coach };
    if (p.kind === 'admin' || p.kind === 'deleted' || p.kind === 'two_point' || p.kind === 'no_play' || p.kind === 'special') { excluded[p.kind] = (excluded[p.kind] || 0) + 1; return; }
    plays.push(p);
  }, { columns: PBP_COLS });
  return { ok: true, plays, games, source: src, source_ref: srcRef, excluded, header: res.header };
}

/* FTN charting keyed by game|play; null when the season has none */
async function loadFtn(season, opts) {
  if (season < FIRST_SEASON.ftn) return { ok: false, reason: 'FTN charting begins in ' + FIRST_SEASON.ftn, by_play: null };
  const got = await download('ftn', season, opts || {});
  if (!got.ok) return { ok: false, reason: got.error, by_play: null, url: got.url };
  const by = new Map();
  await io.readCsv(got.file, (r) => {
    by.set(gid(r.nflverse_game_id) + '|' + r.nflverse_play_id, {
      qb_location: str(r.qb_location), n_backfield: num(r.n_offense_backfield), n_box: num(r.n_defense_box),
      no_huddle: b01(r.is_no_huddle), motion: b01(r.is_motion), play_action: b01(r.is_play_action),
      screen: b01(r.is_screen_pass), rpo: b01(r.is_rpo), n_blitzers: num(r.n_blitzers), n_rushers: num(r.n_pass_rushers)
    });
  }, { columns: FTN_COLS });
  return { ok: true, by_play: by, source: { name: 'nflverse ftn_charting', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

/* Participation: published after the postseason. A 404 for the season in
   progress is the expected state and is reported as "not yet published". */
async function loadParticipation(season, opts) {
  if (season < FIRST_SEASON.participation) return { ok: false, reason: 'participation begins in ' + FIRST_SEASON.participation, by_play: null };
  const got = await download('participation', season, opts || {});
  if (!got.ok) return { ok: false, reason: got.status === 404 ? 'not yet published for ' + season + ' (nflverse releases it after the postseason)' : got.error, by_play: null, url: got.url };
  const by = new Map();
  await io.readCsv(got.file, (r) => {
    by.set(gid(r.nflverse_game_id) + '|' + r.play_id, {
      formation: str(r.offense_formation), off_personnel: personnelKey(str(r.offense_personnel)), box: num(r.defenders_in_box),
      def_personnel: str(r.defense_personnel), rushers: num(r.number_of_pass_rushers),
      man_zone: str(r.defense_man_zone_type), coverage: str(r.defense_coverage_type)
    });
  }, { columns: PART_COLS });
  return { ok: true, by_play: by, source: { name: 'nflverse pbp_participation', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

/* "1 RB, 1 TE, 3 WR" -> "11"; anything else (QB/OL extras, special teams) is kept verbatim-null */
function personnelKey(s) {
  if (!s) return null;
  const m = {}; s.split(',').forEach((x) => { const t = x.trim().split(/\s+/); if (t.length === 2) m[t[1]] = +t[0]; });
  if (m.K || m.P || m.LS) return null;
  if (!('RB' in m) && !('TE' in m) && !('WR' in m)) return null;
  const rb = (m.RB || 0) + (m.FB || 0); const te = m.TE || 0;
  return String(rb) + String(te);
}

/* the season's schedule: every game, completed or not */
async function loadSchedule(season, opts) {
  const got = await download('schedules', season, Object.assign({ current_season: season }, opts || {}));
  if (!got.ok) return { ok: false, error: got.error };
  const rows = await io.loadCsv(got.file);
  const games = rows.filter((r) => +r.season === season).map((r) => ({
    game_id: gid(r.game_id), season: +r.season, week: +r.week, game_type: r.game_type, gameday: r.gameday, gametime: r.gametime,
    kickoff_at: kickoffUtc(r.gameday, r.gametime), home: team(r.home_team), away: team(r.away_team),
    home_score: num(r.home_score), away_score: num(r.away_score), completed: num(r.home_score) != null && num(r.away_score) != null,
    spread_line: num(r.spread_line), total_line: num(r.total_line), home_rest: num(r.home_rest), away_rest: num(r.away_rest),
    roof: str(r.roof), div_game: r.div_game === '1', home_coach: str(r.home_coach), away_coach: str(r.away_coach),
    home_qb_id: str(r.home_qb_id), away_qb_id: str(r.away_qb_id)
  }));
  return { ok: true, games, source: { name: 'nflverse schedules games.csv', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

/* nflverse gameday/gametime are US Eastern. Convert with the DST rule
   (second Sunday of March to first Sunday of November). */
function kickoffUtc(day, time) {
  if (!day) return null;
  const [y, mo, d] = day.split('-').map(Number); const [hh, mm] = String(time || '13:00').split(':').map(Number);
  const dstStart = nthSunday(y, 2, 2), dstEnd = nthSunday(y, 10, 1);
  const t = Date.UTC(y, mo - 1, d);
  const edt = t >= dstStart && t < dstEnd;
  return new Date(Date.UTC(y, mo - 1, d, hh + (edt ? 4 : 5), mm || 0)).toISOString();
}
function nthSunday(y, monthIdx, n) { const first = new Date(Date.UTC(y, monthIdx, 1)); const off = (7 - first.getUTCDay()) % 7; return Date.UTC(y, monthIdx, 1 + off + 7 * (n - 1)); }

/* Injury report, latest status per player for a week */
async function loadInjuries(season, opts) {
  const got = await download('injuries', season, opts || {});
  if (!got.ok) return { ok: false, reason: got.error, rows: [] };
  const rows = (await io.loadCsv(got.file, { columns: ['season', 'week', 'gsis_id', 'team', 'full_name', 'position', 'report_status', 'practice_status', 'date_modified'] })).map((x) => Object.assign(x, { team: team(x.team) }));
  return { ok: true, rows, source: { name: 'nflverse injuries', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}
async function loadRosters(season, opts) {
  const got = await download('rosters', season, opts || {});
  if (!got.ok) return { ok: false, reason: got.error, rows: [] };
  const rows = (await io.loadCsv(got.file, { columns: ['season', 'week', 'team', 'position', 'depth_chart_position', 'status', 'full_name', 'gsis_id'] })).map((x) => Object.assign(x, { team: team(x.team) }));
  return { ok: true, rows, source: { name: 'nflverse roster_weekly', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

module.exports = { team, gid, ALIAS, loadSeason, loadFtn, loadParticipation, loadSchedule, loadInjuries, loadRosters, normalizePbpRow, kindOf, personnelKey, kickoffUtc, URLS, FIRST_SEASON, PBP_COLS };
