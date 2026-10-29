/* ============================================================================
   FSIE — college football source adapter.

   Plays: sportsdataverse `espn_cfb_pbp/play_by_play_<Y>.parquet` (ESPN's own
   play-by-play, 2014 → the season in progress, refreshed daily). Read
   column-selectively through the repository's pyarrow helper
   (hockey/tools/parquet_select.py); pyarrow is what 26 workflows already
   install. No CFBD call: its terms forbid the committed mirror this repository
   keeps, and it is blocked in the build container besides.

   Schedule / team universe: cfbfastR-data `cfb_schedules_<Y>.csv` — the same
   file football/fbs reads — so the eligible team set is the season's own
   schedule (`*_division == 'fbs'`), never a stored list.

   Counting definitions (NFL-style, so the two sports' outputs mean the same):
     pass_attempt = a non-sack pass play       rush_attempt = a rush or a kneel
     sack         = a sack (NCAA box scores count sacks as rushes; the NCAA
                    convention is published beside it as rush_attempts_ncaa)
   Scrambles are NOT distinguishable in ESPN's college feed; a QB scramble is a
   rush here, and the output says so.

   Formation: ESPN's play text carries "Shotgun" / "No Huddle" / "Pistol" when
   the stadium stat crew charts it. That is observed detail, but only for games
   whose crew charts it: a game with no token on any play is UNCHARTED (null),
   never "under center".
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const io = require(path.join(__dirname, '..', '..', 'props', 'factory', 'lib', 'io.js'));
const F = require(path.join(__dirname, '..', 'core', 'fetch.js'));

const PBP_BASE = (process.env.EDGEDESK_SDV_RELEASES || 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download').replace(/\/+$/, '');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const URLS = {
  pbp: (y) => `${PBP_BASE}/espn_cfb_pbp/play_by_play_${y}.parquet`,
  schedule: (y) => `${RAW}/schedules/csv/cfb_schedules_${y}.csv`,
  coaches: (y) => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-cfb-data/main/cfb/coach_tendencies/parquet/coach_tendencies_${y}.parquet`
};
const FIRST_SEASON = 2014;
const SELECT = path.join(F.ROOT, 'hockey', 'tools', 'parquet_select.py');
const COLS = ['game_id', 'season', 'week', 'seasonType', 'id', 'sequenceNumber', 'game_play_number', 'pos_team_id', 'def_pos_team_id',
  'homeTeamId', 'awayTeamId', 'period', 'clock.minutes', 'clock.seconds', 'start.TimeSecsRem', 'start.adj_TimeSecsRem',
  'start.down', 'start.distance', 'start.yardsToEndzone', 'goal_to_go', 'start.pos_team_score', 'start.def_pos_team_score',
  'drive.id', 'type.text', 'scrimmage_play', 'rush', 'pass', 'sack', 'kneel_down', 'pass_attempt', 'completion', 'target',
  'penalty_no_play', 'rusher_player_id', 'rusher_player_name', 'passer_player_id', 'passer_player_name',
  'receiver_player_id', 'receiver_player_name', 'statYardage', 'homeFinalScore', 'awayFinalScore', 'end.homeScore', 'end.awayScore',
  'homeTeamSpread', 'homeFavorite', 'gameSpreadAvailable', 'overUnder', 'status_type_completed', 'wallclock', 'text'];

const num = io.num;
function bool(v) { return v === 'true' || v === 'True' || v === 'TRUE' || v === '1' ? true : (v === 'false' || v === 'False' || v === 'FALSE' || v === '0' ? false : null); }
function str(v) { return v == null || v === '' || v === 'NA' || v === 'None' ? null : String(v); }
function idStr(v) { const s = str(v); if (s == null) return null; return /^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s; }

const TWO_POINT = /^(Two Point (Pass|Rush)|Defensive 2pt Conversion)$/;
const SPECIAL = /^(Kickoff|Kickoff Return|Kickoff Return Touchdown|Kickoff Team Fumble Recovery|Kickoff Team Fumble Recovery Touchdown|Kickoff Return \(Offense\)|Punt|Punt Return|Punt Return Touchdown|Blocked Punt|Blocked Punt Touchdown|Punt Team Fumble Recovery|Field Goal Good|Field Goal Missed|Blocked Field Goal|Blocked Field Goal Touchdown|Missed Field Goal Return|Extra Point Good|Extra Point Missed)/;

function kindOf(r) {
  const tt = r['type.text'] || '';
  if (TWO_POINT.test(tt)) return 'two_point';
  const scrim = bool(r.scrimmage_play);
  if (!scrim) {
    if (tt === 'Penalty') return 'no_play';
    if (SPECIAL.test(tt) || /Punt|Kickoff|Field Goal/.test(tt)) return 'special';
    return 'admin';
  }
  if (/^Punt/.test(tt) || /Field Goal/.test(tt)) return 'special';      /* "Punt (Safety)" etc. */
  const isPass = bool(r.pass), isRush = bool(r.rush);
  if (bool(r.sack)) return 'sack';
  if (bool(r.kneel_down)) return 'kneel';
  if (isPass && isRush) return 'conflict';
  if (isPass) return 'pass';
  if (isRush) return 'rush';
  return 'unclassified';
}

function formationOf(text) {
  if (!text) return { shotgun: null, no_huddle: null, pistol: null, token: false };
  const sg = /shotgun/i.test(text), nh = /no huddle/i.test(text), pi = /pistol/i.test(text);
  return { shotgun: sg, no_huddle: nh, pistol: pi, token: sg || nh || pi };
}

function normalizeRow(r, srcRef) {
  const kind = kindOf(r);
  const per = num(r.period);
  const cm = num(r['clock.minutes']), cs = num(r['clock.seconds']);
  const secPeriod = cm != null && cs != null ? cm * 60 + cs : null;
  const off = idStr(r.pos_team_id), def = idStr(r.def_pos_team_id), home = idStr(r.homeTeamId), away = idStr(r.awayTeamId);
  const so = num(r['start.pos_team_score']), sdf = num(r['start.def_pos_team_score']);
  const fm = formationOf(r.text);
  const homeFav = bool(r.homeFavorite), hs = num(r.homeTeamSpread);
  const spreadOk = bool(r.gameSpreadAvailable) !== false && hs != null;
  return {
    sport: 'cfb', season: num(r.season), week: num(r.week), season_type: num(r.seasonType) === 3 ? 'POST' : 'REG',
    game_id: idStr(r.game_id), play_id: idStr(r.id), seq: num(r.game_play_number) != null ? num(r.game_play_number) : num(r.sequenceNumber),   /* ESPN's sequenceNumber is out of order in some games; game_play_number is not */
    home, away, off, def, off_is_home: off != null && home != null ? off === home : null,
    period: per, sec_left_period: secPeriod, sec_left_half: num(r['start.TimeSecsRem']), sec_left_game: num(r['start.adj_TimeSecsRem']),
    down: num(r['start.down']), distance: num(r['start.distance']), yards_to_goal: num(r['start.yardsToEndzone']),
    goal_to_go: bool(r.goal_to_go),
    score_off: so, score_def: sdf, score_diff: so != null && sdf != null ? so - sdf : null,
    drive_id: str(r['drive.id']),
    kind, type_text: r['type.text'] || null,
    pass_attempt: kind === 'pass', rush_attempt: kind === 'rush' || kind === 'kneel', sack: kind === 'sack',
    scramble: null, kneel: kind === 'kneel', spike: kind === 'pass' && /spike/i.test(r.text || ''),
    dropback: kind === 'pass' || kind === 'sack',
    passer_id: idStr(r.passer_player_id), passer_name: str(r.passer_player_name),
    rusher_id: idStr(r.rusher_player_id), rusher_name: str(r.rusher_player_name),
    target_id: idStr(r.receiver_player_id), target_name: str(r.receiver_player_name),
    complete: bool(r.completion) === true, yards: num(r.statYardage),
    shotgun: fm.token ? fm.shotgun : null, no_huddle: fm.token ? fm.no_huddle : null, formation_token: fm.token,
    final_home: num(r.homeFinalScore), final_away: num(r.awayFinalScore),
    run_home: num(r['end.homeScore']), run_away: num(r['end.awayScore']),
    home_spread_margin: spreadOk ? (homeFav === false ? -Math.abs(hs) : Math.abs(hs)) : null,
    total_line: num(r.overUnder), completed: bool(r.status_type_completed), wallclock: str(r.wallclock),
    src: srcRef
  };
}

/* parquet -> selected-column CSV in the cache (one pyarrow pass per file version) */
function selectToCsv(parquetFile, sha) {
  const out = parquetFile.replace(/\.parquet$/, '') + '.' + String(sha).slice(0, 12) + '.sel.csv';
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  const tmp = out + '.part-' + process.pid;
  cp.execFileSync('python3', ['-I', SELECT, parquetFile, tmp, COLS.join(',')], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1 << 26 });
  fs.renameSync(tmp, out);
  return out;
}

async function loadSeason(season, opts) {
  opts = opts || {};
  if (season < FIRST_SEASON) return { ok: false, error: 'ESPN college play-by-play mirror begins in ' + FIRST_SEASON };
  const got = await F.getFile(URLS.pbp(season), `cfb_pbp_${season}.parquet`, Object.assign({ season: opts.current_season, min_bytes: 4096 }, opts));
  if (!got.ok) return { ok: false, error: got.error, source: { name: 'sportsdataverse espn_cfb_pbp', url: got.url } };
  let csv;
  try { csv = selectToCsv(got.file, got.sha256); } catch (e) { return { ok: false, error: 'parquet read failed (pyarrow required): ' + String(e.stderr || e.message).slice(0, 200) }; }
  const srcRef = 'espn_cfb_pbp_' + season + '@' + String(got.sha256).slice(0, 16);
  const src = { name: 'sportsdataverse espn_cfb_pbp', url: got.url, sha256: got.sha256, bytes: got.bytes, last_modified: got.last_modified || null, pulled_at: got.retrieved_at || null, from: got.from };
  const plays = []; const excluded = {}; const games = {}; let header = null;
  const res = await io.readCsv(csv, (r) => {
    if (opts.weeks && opts.weeks.indexOf(+r.week) < 0) return;
    const p = normalizeRow(r, srcRef);
    if (p.game_id && !games[p.game_id]) games[p.game_id] = { game_id: p.game_id, season: p.season, week: p.week, season_type: p.season_type, home: p.home, away: p.away, final_home: p.final_home, final_away: p.final_away, home_spread_margin: p.home_spread_margin, total_line: p.total_line, completed: p.completed, first_wallclock: p.wallclock };
    if (p.kind === 'admin' || p.kind === 'two_point' || p.kind === 'no_play' || p.kind === 'special') { excluded[p.kind] = (excluded[p.kind] || 0) + 1; return; }
    plays.push(p);
  });
  header = res.header;
  return { ok: true, plays, games, source: src, source_ref: srcRef, excluded, header };
}

/* The season's schedule (cfbfastR-data, the same file football/fbs reads) */
async function loadSchedule(season, opts) {
  const got = await F.getFile(URLS.schedule(season), `cfb_schedule_${season}.csv`, Object.assign({ season: (opts && opts.current_season) || season, min_bytes: 1024 }, opts || {}));
  if (!got.ok) return { ok: false, error: got.error };
  const rows = await io.loadCsv(got.file);
  const games = rows.map((r) => ({
    game_id: idStr(r.game_id), season: +r.season, week: +r.week, season_type: r.season_type === 'postseason' ? 'POST' : 'REG',
    kickoff_at: str(r.start_date), completed: r.completed === 'TRUE' || r.completed === 'true', neutral_site: r.neutral_site === 'TRUE',
    conference_game: r.conference_game === 'TRUE',
    home: idStr(r.home_id), home_name: str(r.home_team), home_division: str(r.home_division), home_conference: str(r.home_conference),
    away: idStr(r.away_id), away_name: str(r.away_team), away_division: str(r.away_division), away_conference: str(r.away_conference),
    home_score: num(r.home_points), away_score: num(r.away_points), venue_id: str(r.venue_id)
  })).filter((g) => g.game_id && g.season === season);
  return { ok: true, games, source: { name: 'cfbfastR-data cfb_schedules', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

/* Head coach per programme per season (cfbfastR coach table, HC rows only;
   the same file football/coaching reads). The coach with the most games is
   the season's head coach; coordinators are not in this feed. */
async function loadCoaches(season, opts) {
  const got = await F.getFile(URLS.coaches(season), `cfb_coaches_${season}.parquet`, Object.assign({ season: (opts && opts.current_season) || season, min_bytes: 1024 }, opts || {}));
  if (!got.ok) return { ok: false, reason: got.error, by_team: {} };
  const out = got.file.replace(/\.parquet$/, '') + '.' + String(got.sha256).slice(0, 12) + '.sel.csv';
  try {
    if (!fs.existsSync(out)) { const tmp = out + '.part-' + process.pid; cp.execFileSync('python3', ['-I', SELECT, got.file, tmp, 'season,pos_team_id,coach,role,games'], { stdio: ['ignore', 'ignore', 'pipe'] }); fs.renameSync(tmp, out); }
  } catch (e) { return { ok: false, reason: 'parquet read failed: ' + String(e.message).slice(0, 120), by_team: {} }; }
  const rows = await io.loadCsv(out);
  const by = {};
  rows.forEach((r) => { if (r.role && r.role !== 'HC') return; const t = idStr(r.pos_team_id); const g = num(r.games) || 0; if (!by[t] || g > by[t].games) by[t] = { coach: str(r.coach), games: g }; });
  return { ok: true, by_team: by, source: { name: 'cfbfastR-cfb-data coach_tendencies', url: got.url, sha256: got.sha256 } };
}

module.exports = { loadSeason, loadSchedule, loadCoaches, normalizeRow, kindOf, formationOf, URLS, COLS, FIRST_SEASON };
