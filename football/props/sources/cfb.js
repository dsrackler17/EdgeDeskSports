/* ============================================================================
   PLAYER PROPS — the college dataset (public, keyless).

     sportsdataverse ESPN player box   per player-game passing, rushing,
                                       receiving, kicking and defensive lines
                                       (.csv.gz for a finished season, .parquet
                                       in season), keyed by ESPN athlete id
     cfbfastR schedules                kickoff, home/away, neutral site, final
                                       scores, ESPN team ids
     football/rosters/fbs_<s>_espn.json positions by ESPN athlete id
     football/fbs/slate.json           upcoming FBS games with EdgeDesk's own
                                       fair margin and total, QB starters
     football/venues/forecasts.json    kickoff weather by ESPN game id
     football/props/nfl/shapes.json    per-play yard shapes (borrowed — no
                                       public college per-play feed is wired in;
                                       disclosed on every college prop)

   What college does NOT have publicly, and the model therefore does without
   (and says so): targets (reception share of team completions is used),
   snaps, red-zone usage, sacks as their own column (NCAA counts sack yardage
   as QB rushing), an official injury report and depth charts.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./fetch.js');
const C = require('../config.js');

const N = F.NUM, S = F.STR;
const BOX = (s, ext) => 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box/player_box_' + s + ext;
const SCHED = (s) => 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_' + s + '.csv';
function key(name) { return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function keyAscii(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
const POS = { QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', PK: 'K', K: 'K', P: 'P', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB', DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', CB: 'DB', S: 'DB', SAF: 'DB', DB: 'DB' };

function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(C.ROOT, p), 'utf8')); } catch (e) { return null; } }

async function boxRows(season, o) {
  const gz = await F.getBuffer(BOX(season, '.csv.gz'), 'cfb_box_' + season + '.csv.gz', Object.assign({ min_bytes: 1000 }, o));
  if (gz.ok) { const text = require('zlib').gunzipSync(gz.buf).toString('utf8'); return { ok: true, rows: F.readCsv(text), from: gz.from, retrieved_at: gz.retrieved_at, url: gz.url, format: 'csv.gz' }; }
  const pq = await F.getBuffer(BOX(season, '.parquet'), 'cfb_box_' + season + '.parquet', Object.assign({ min_bytes: 1000 }, o));
  if (!pq.ok) return { ok: false, rows: [], error: pq.error, url: pq.url };
  try { return { ok: true, rows: F.parquetRows(pq.buf, 'cfb_box_' + season + '.parquet'), from: pq.from, retrieved_at: pq.retrieved_at, url: pq.url, format: 'parquet (pyarrow)' }; }
  catch (e) { return { ok: false, rows: [], error: 'parquet read failed (pip install pyarrow): ' + e.message, url: pq.url }; }
}

function parseSchedule(text) {
  return F.readCsv(text, ['game_id', 'season', 'week', 'season_type', 'start_date', 'neutral_site', 'completed', 'venue', 'home_id', 'home_team', 'home_division', 'home_points', 'away_id', 'away_team', 'away_division', 'away_points'])
    .map((g) => ({ game_id: g.game_id, season: N(g.season), week: N(g.week), game_type: g.season_type === 'postseason' ? 'POST' : 'REG', kickoff: S(g.start_date), gameday: (g.start_date || '').slice(0, 10),
      home: key(g.home_team), away: key(g.away_team), home_name: g.home_team, away_name: g.away_team, home_id: g.home_id, away_id: g.away_id, home_division: g.home_division, away_division: g.away_division,
      home_score: N(g.home_points), away_score: N(g.away_points), neutral: String(g.neutral_site).toUpperCase() === 'TRUE', venue: S(g.venue),
      status: String(g.completed).toUpperCase() === 'TRUE' ? 'final' : 'scheduled' }));
}

function num1(v) { const x = N(v); return x == null ? 0 : x; }
function split(v) { const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(v || '')); return m ? [+m[1], +m[2]] : [null, null]; }

function buildSeason(season, box, sched, positions, teamOfId) {
  const games = {}; sched.filter((g) => g.season === season).forEach((g) => { games[g.game_id] = g; });
  const players = {}, teamGames = {};
  const TG = (gid, tm) => teamGames[gid + '|' + tm] || (teamGames[gid + '|' + tm] = { gid, tm, plays: 0, db: 0, dr: 0, att: 0, cmp: 0, pyd: 0, pyd_net: 0, ryd: 0, rtd: 0, ptd: 0, int: 0, sk: 0, qbh: 0,
    rz_plays: 0, rz_dr: 0, gl_dr: 0, rz_att: 0, n_neutral: 0, db_neutral: 0, xpass_n: 0, proe_n: 0, rush_epa: 0, pass_epa: 0, rush_succ: 0, pass_succ: 0, expl_rush: 0, expl_pass: 0,
    pos: { RB: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, WR: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, TE: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, QB: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 } } });
  box.forEach((r) => {
    const gid = String(r.game_id || ''), id = String(r.athlete_id || ''), g = games[gid];
    if (!gid || !id || !g) return;
    const tm = teamOfId[String(r.team_id)] || null; if (!tm) return;
    const p = players[id] || (players[id] = { id, name: r.athlete_name, pos: positions[id] || null, team: tm, logs: {} });
    p.team = tm;
    const L = p.logs[gid] || (p.logs[gid] = { gid, s: season, w: g.week, st: g.game_type, date: g.gameday, tm, op: g.home === tm ? g.away : g.home, h: g.neutral ? null : (g.home === tm ? 1 : 0),
      att: 0, cmp: 0, pyd: 0, ptd: 0, int: 0, sk: 0, car: 0, ryd: 0, rtd: 0, tgt: 0, rec: 0, yd: 0, td: 0, ay: 0, st_td: 0, fgm: 0, fga: 0, xpm: 0, tkl: 0, ast: 0, dsk: 0, dint: 0 });
    const cat = r.category, T = TG(gid, tm), pg = POS[String(p.pos || '').toUpperCase()] || null;
    if (cat === 'passing') {
      const ca = split(r['completions/passingAttempts'] || r.stat_1);
      const yds = N(r.passingYards != null && r.passingYards !== '' ? r.passingYards : r.stat_2), td = N(r.passingTouchdowns !== '' && r.passingTouchdowns != null ? r.passingTouchdowns : r.stat_4), it = N(r.interceptions !== '' && r.interceptions != null ? r.interceptions : r.stat_5);
      L.cmp = ca[0] || 0; L.att = ca[1] || 0; L.pyd = yds || 0; L.ptd = td || 0; L.int = it || 0;
      T.att += L.att; T.cmp += L.cmp; T.pyd += L.pyd; T.pyd_net += L.pyd; T.ptd += L.ptd; T.int += L.int; T.db += L.att; T.plays += L.att;
    } else if (cat === 'rushing') {
      L.car = num1(r.rushingAttempts); L.ryd = num1(r.rushingYards); L.rtd = num1(r.rushingTouchdowns); L.rlng = N(r.longRushing);
      T.dr += L.car; T.ryd += L.ryd; T.rtd += L.rtd; T.plays += L.car;
      if (pg && T.pos[pg]) { T.pos[pg].car += L.car; T.pos[pg].ryd += L.ryd; }
    } else if (cat === 'receiving') {
      L.rec = num1(r.receptions); L.yd = num1(r.receivingYards); L.td = num1(r.receivingTouchdowns); L.lng = N(r.longReception);
      L.tgt = L.rec;                                  /* no targets in the college box: reception share stands in */
      if (pg && T.pos[pg]) { T.pos[pg].rec += L.rec; T.pos[pg].tgt += L.rec; T.pos[pg].yd += L.yd; }
    } else if (cat === 'kicking') {
      const fg = split(r['fieldGoalsMade/fieldGoalAttempts']), xp = split(r['extraPointsMade/extraPointAttempts']);
      L.fgm = fg[0] || 0; L.fga = fg[1] || 0; L.xpm = xp[0] || 0;
    } else if (cat === 'defensive') {
      L.tkl = num1(r.soloTackles); L.ast = Math.max(0, num1(r.totalTackles) - num1(r.soloTackles)); L.dsk = num1(r.sacks);
    } else if (cat === 'interceptions') { L.dint = num1(r.interceptions); }
    else if (cat === 'kickReturns' || cat === 'puntReturns') { L.st_td += num1(r.kickReturnTouchdowns || r.puntReturnTouchdowns); }
  });
  /* the team's attempt count is the offence's completions stand-in for share */
  Object.keys(teamGames).forEach((k) => {
    const T = teamGames[k], g = games[T.gid];
    T.s = season; T.w = g.week; T.date = g.gameday; T.h = g.neutral ? null : (g.home === T.tm ? 1 : 0); T.op = g.home === T.tm ? g.away : g.home;
    T.pts = g.home === T.tm ? g.home_score : g.away_score; T.opp_pts = g.home === T.tm ? g.away_score : g.home_score;
    T.tgt_den = T.cmp;                               /* no targets: reception share of completions */
    T.n_neutral = T.plays; T.db_neutral = T.db;
  });
  Object.keys(players).forEach((id) => { players[id].logs = Object.values(players[id].logs); });
  return { players, teamGames };
}

async function load(opts) {
  opts = opts || {};
  const season = opts.season || C.seasonOf(opts.now);
  const o = { offline: !!opts.offline, season };
  const feeds = {};
  const sched = [];
  for (const s of [season - 1, season]) {
    const r = await F.getText(SCHED(s), 'cfb_sched_' + s + '.csv', Object.assign({}, o, { min_bytes: 1000 }));
    feeds['schedule_' + s] = { ok: r.ok, from: r.from, retrieved_at: r.retrieved_at, url: r.url, error: r.error || null };
    if (r.ok) parseSchedule(r.text).forEach((g) => sched.push(g));
  }
  if (!sched.length) return { ok: false, league: 'cfb', season, error: 'no college schedule feed' };
  const teamOfId = {}, names = {};
  sched.forEach((g) => { teamOfId[g.home_id] = g.home; teamOfId[g.away_id] = g.away; names[g.home] = g.home_name; names[g.away] = g.away_name; });
  const positions = {};
  const rosters = readJson('football/rosters/fbs_' + season + '_espn.json');
  ((rosters && rosters.teams) || []).forEach((t) => (t.players || []).forEach((p) => { if (p.espn_id) positions[String(p.espn_id)] = p.position; }));
  const seasons = {};
  for (const s of [season - 1, season]) {
    const b = await boxRows(s, o);
    feeds['player_box_' + s] = { ok: b.ok, from: b.from || null, retrieved_at: b.retrieved_at || null, url: b.url || null, format: b.format || null, error: b.error || null };
    seasons[s] = buildSeason(s, b.rows || [], sched, positions, teamOfId);
  }
  const players = {};
  [season - 1, season].forEach((s) => Object.keys(seasons[s].players).forEach((id) => {
    const src = seasons[s].players[id], p = players[id] || (players[id] = { id, logs: [] });
    ['name', 'pos', 'team'].forEach((k) => { if (src[k] != null && (s === season || p[k] == null)) p[k] = src[k]; });
    src.logs.forEach((l) => p.logs.push(l));
  }));
  Object.keys(players).forEach((id) => {
    const p = players[id];
    p.pg = POS[String(p.pos || '').toUpperCase()] || null;
    p.logs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    if (!p.pg || !p.logs.length) delete players[id];
  });
  const teams = {};
  [season - 1, season].forEach((s) => Object.values(seasons[s].teamGames).forEach((T) => { (teams[T.tm] = teams[T.tm] || []).push(T); }));
  Object.keys(teams).forEach((t) => teams[t].sort((a, b) => (a.date || '').localeCompare(b.date || '')));
  /* upcoming FBS games with EdgeDesk's own numbers and the forecast */
  const slate = readJson('football/fbs/slate.json'), fc = readJson('football/venues/forecasts.json');
  const byGame = {}; ((slate && slate.games) || []).forEach((g) => { byGame[String(g.game_id)] = g; });
  sched.forEach((g) => {
    const sg = byGame[g.game_id];
    if (sg) {
      g.edgedesk = { home_margin: sg.model_home_margin != null ? sg.model_home_margin : null, total: sg.model_fair_total != null ? sg.model_fair_total : null, source: 'EdgeDesk FBS model (football/fbs/slate.json)' };
      g.starters = {};
      if (sg.home_starter && sg.home_starter.player_id) g.starters[g.home] = { id: String(sg.home_starter.player_id).replace(/^a:/, ''), name: sg.home_starter.player_name || null, confirmed: /CONFIRMED|DEPTH/.test(String(sg.home_starter.status || '')) };
      if (sg.away_starter && sg.away_starter.player_id) g.starters[g.away] = { id: String(sg.away_starter.player_id).replace(/^a:/, ''), name: sg.away_starter.player_name || null, confirmed: /CONFIRMED|DEPTH/.test(String(sg.away_starter.status || '')) };
      if (sg.kickoff) g.kickoff = sg.kickoff;
    }
    const f = fc && fc.by_game ? fc.by_game[g.game_id] : null;
    if (f) g.forecast = f;
  });
  const shapes = readJson('football/props/nfl/shapes.json');
  /* each programme's regime-change record (football/coaching/regime.json,
     audit 2026-09-30 #1/#7d): read by model.js prepare (the usage and volume
     priors) and carried to each prop (the REGIME_CHANGE cap) */
  const rg = readJson('football/coaching/regime.json');
  const regime = rg && rg.season === season && rg.by_team ? rg.by_team : null;
  return {
    ok: true, league: 'cfb', season, built_at: new Date().toISOString(), schedule: sched, players, teams, depth: {}, regime,
    injuries: { published: false, by_player: {}, note: 'no official college availability feed exists (football/availability/current.json)' },
    slate: null, event_fits: shapes && shapes.fits ? shapes.fits : {}, shape_league: 'nfl', shapes_borrowed: !!(shapes && shapes.fits),
    caps: { targets: false, snaps: false, pbp: false, injuries: false, depth: false }, feeds, team_names: names
  };
}

module.exports = { load, parseSchedule, buildSeason, key, keyAscii, BOX, SCHED };
