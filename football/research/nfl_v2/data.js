'use strict';
/* ===========================================================================
   NFL v2 DATA — every game 1999-2026 with what the model reads about it, from
   the cached nflverse history (fetch_history.sh, build_pbp_team_games.py).

     games      schedule + scores + closing consensus (spread_line = home
                margin, positive = home favoured; moneylines) + rest, roof,
                surface, QB ids, location, stadium; franchise-mapped codes
     teamRows   per game, the two team-week rows IN FILE ORDER (the order
                training absorbs them in), from stats_team_week or from a
                play-by-play filter (pbp_G0 / pbp_G1 / pbp_G2)
     qbRows     per game, every position-QB stats_player_week line
     travel     per game (football/nfl_model.js travelFor)
     personnel  per season, per club: the offseason deltas the personnel prior
                reads (RB rushing EPA and WR/TE receiving EPA carried in or out,
                OL share of last season's snaps returning), 2013+

   Nothing here is invented: a value the feeds do not carry stays null and
   the model treats it as absent.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const RAW = path.join(__dirname, '.cache', 'raw');
const PBP = path.join(__dirname, '.cache', 'pbp');
const M = require(path.join(ROOT, 'football', 'nfl_model.js'));
const FRANCHISE = { STL: 'LA', SD: 'LAC', OAK: 'LV' };
const fr = (t) => FRANCHISE[t] || t;

function splitQuoted(line) {
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(f); f = ''; } else f += c;
  }
  out.push(f); return out;
}
/* rows as objects; '' and NA become null; keep: only these columns */
function readCsv(file, keep) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const head = splitQuoted(lines[0]);
  const idx = keep ? keep.map((k) => head.indexOf(k)) : head.map((_, i) => i);
  const names = keep || head;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]; if (!l) continue;
    const c = l.indexOf('"') >= 0 ? splitQuoted(l) : l.split(',');
    const o = {};
    for (let j = 0; j < names.length; j++) { const v = idx[j] >= 0 ? c[idx[j]] : undefined; o[names[j]] = (v === '' || v === 'NA' || v === undefined) ? null : v; }
    rows.push(o);
  }
  return rows;
}
const num = (x) => (x == null || x === '' ? null : (Number.isFinite(+x) ? +x : null));

let GAMES = null;
function games() {
  if (GAMES) return GAMES;
  const rows = readCsv(path.join(RAW, 'games.csv'));
  const stad = M.indexStadiums(JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'venues', 'nfl_stadiums.json'), 'utf8')));
  GAMES = rows.filter((r) => num(r.season) >= 1999).map((r) => {
    const g = {
      id: r.game_id, season: num(r.season), week: num(r.week), type: r.game_type, gameday: r.gameday, gametime: r.gametime,
      home_raw: r.home_team, away_raw: r.away_team, home: fr(r.home_team), away: fr(r.away_team),
      home_score: num(r.home_score), away_score: num(r.away_score),
      close_home_margin: num(r.spread_line), close_total: num(r.total_line), home_ml: num(r.home_moneyline), away_ml: num(r.away_moneyline),
      home_rest: num(r.home_rest), away_rest: num(r.away_rest), roof: r.roof, surface: r.surface, div_game: num(r.div_game),
      temp: num(r.temp), wind: num(r.wind), home_qb_id: r.home_qb_id, away_qb_id: r.away_qb_id,
      neutral: r.location === 'Neutral', stadium: r.stadium,
    };
    g.done = g.home_score != null && g.away_score != null;
    g.travel = M.travelFor(stad, g);
    return g;
  });
  GAMES.sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.id).localeCompare(String(b.id)));
  return GAMES;
}

const TEAM_COLS = ['game_id', 'team', 'attempts', 'carries', 'sacks_suffered', 'passing_epa', 'rushing_epa', 'passing_20', 'rushing_10'];
const ROWS_MEMO = {};
/* source: 'stw' (nflverse stats_team_week) or 'pbp_G0' / 'pbp_G1' / 'pbp_G2' */
function teamRows(source) {
  if (ROWS_MEMO[source]) return ROWS_MEMO[source];
  const out = {};
  for (let y = 1999; y <= 2026; y++) {
    const file = source === 'stw' ? path.join(RAW, `stw_${y}.csv`) : path.join(PBP, `pbp_${source.slice(4)}_${y}.csv`);
    const rows = readCsv(file, TEAM_COLS);
    if (!rows) continue;
    rows.forEach((r) => { (out[r.game_id] = out[r.game_id] || []).push(r); });
  }
  ROWS_MEMO[source] = out;
  return out;
}

let QB = null;
function qbRows() {
  if (QB) return QB;
  QB = {};
  for (let y = 1999; y <= 2026; y++) {
    const rows = readCsv(path.join(RAW, `spw_${y}.csv`), ['game_id', 'team', 'player_id', 'position', 'attempts', 'sacks_suffered', 'passing_epa']);
    if (!rows) continue;
    rows.forEach((r) => { if (r.position === 'QB' && r.game_id) (QB[r.game_id] = QB[r.game_id] || []).push(r); });
  }
  return QB;
}

/* ---------------------------------------------------------- personnel */
const OL_POS = { T: 1, G: 1, C: 1, OL: 1, OT: 1, OG: 1 };
/* a player's name as both feeds can agree on it (the weekly roster leaves pfr_id empty
   for many players, so the snap join falls back to the name within the same club) */
const normName = (n) => String(n || '').toLowerCase().replace(/[.'’`-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
let PERS = null;
function personnel() {
  if (PERS) return PERS;
  const cache = path.join(__dirname, '.cache', 'personnel.json');
  if (fs.existsSync(cache)) { PERS = JSON.parse(fs.readFileSync(cache, 'utf8')); return PERS; }
  const out = {};
  for (let S = 2013; S <= 2026; y = 0, S++) {
    var y;
    const prevSnaps = readCsv(path.join(RAW, `snaps_${S - 1}.csv`), ['game_type', 'pfr_player_id', 'player', 'position', 'team', 'offense_snaps']);
    const roster = readCsv(path.join(RAW, `rosterw_${S}.csv`), ['team', 'position', 'gsis_id', 'pfr_id', 'full_name', 'week', 'game_type']);
    const prevStats = readCsv(path.join(RAW, `spw_${S - 1}.csv`), ['player_id', 'position', 'team', 'season_type', 'carries', 'rushing_epa', 'receiving_epa', 'targets']);
    if (!prevSnaps || !roster || !prevStats) continue;
    /* week-1 roster: the earliest regular-season week each club lists (known before its first game) */
    const firstWeek = {};
    roster.forEach((r) => { if (r.game_type && r.game_type !== 'REG') return; const w = num(r.week); const t = fr(r.team); if (w != null && (firstWeek[t] == null || w < firstWeek[t])) firstWeek[t] = w; });
    const onTeam = {}, onTeamName = {}, onTeamGsis = {};
    roster.forEach((r) => { const t = fr(r.team); if (num(r.week) !== firstWeek[t] || (r.game_type && r.game_type !== 'REG')) return;
      if (r.pfr_id) (onTeam[t] = onTeam[t] || new Set()).add(r.pfr_id);
      if (r.full_name) (onTeamName[t] = onTeamName[t] || new Set()).add(normName(r.full_name));
      if (r.gsis_id) (onTeamGsis[t] = onTeamGsis[t] || new Set()).add(r.gsis_id); });
    const returning = (t, r) => !!((onTeam[t] && onTeam[t].has(r.pfr_player_id)) || (onTeamName[t] && onTeamName[t].has(normName(r.player))));
    /* OL: share of last season's OL snaps (same club) by players on this season's week-1 roster */
    const olTot = {}, olRet = {};
    prevSnaps.forEach((r) => { if (r.game_type !== 'REG' || !OL_POS[r.position]) return; const t = fr(r.team), s = num(r.offense_snaps) || 0;
      olTot[t] = (olTot[t] || 0) + s; if (returning(t, r)) olRet[t] = (olRet[t] || 0) + s; });
    /* RB and WR/TE EFFICIENCY carried in or out: the week-1 roster's last-season
       rushing EPA per carry (receiving EPA per target), weighted by its volume and
       shrunk toward the league rate with 100 pseudo-carries (targets) — a rookie or a
       player with no NFL volume reads as league average, never as a number — minus
       the club's own last-season rate at the position. */
    const byPlayer = {}, club = {}, lg = { rb_epa: 0, rb_car: 0, wr_epa: 0, wr_tgt: 0 };
    prevStats.forEach((r) => {
      if (r.season_type && r.season_type !== 'REG') return;
      const t = fr(r.team), id = r.player_id, p = byPlayer[id] || (byPlayer[id] = { rush: 0, car: 0, rec: 0, tgt: 0, pos: r.position });
      const c = club[t] || (club[t] = { rb_epa: 0, rb_car: 0, wr_epa: 0, wr_tgt: 0 });
      if (r.position === 'RB' || r.position === 'FB') { const e = num(r.rushing_epa) || 0, k = num(r.carries) || 0; p.rush += e; p.car += k; c.rb_epa += e; c.rb_car += k; lg.rb_epa += e; lg.rb_car += k; }
      if (r.position === 'WR' || r.position === 'TE') { const e = num(r.receiving_epa) || 0, k = num(r.targets) || 0; p.rec += e; p.tgt += k; c.wr_epa += e; c.wr_tgt += k; lg.wr_epa += e; lg.wr_tgt += k; }
    });
    const muRb = lg.rb_car > 0 ? lg.rb_epa / lg.rb_car : 0, muWr = lg.wr_tgt > 0 ? lg.wr_epa / lg.wr_tgt : 0, PSEUDO = 100;
    const S_out = {}, olShares = [];
    for (const t of Object.keys(club)) {
      const inc = { rb_epa: 0, rb_car: 0, wr_epa: 0, wr_tgt: 0 };
      (onTeamGsis[t] || new Set()).forEach((id) => { const p = byPlayer[id]; if (!p) return;
        if (p.pos === 'RB' || p.pos === 'FB') { inc.rb_epa += p.rush; inc.rb_car += p.car; }
        if (p.pos === 'WR' || p.pos === 'TE') { inc.wr_epa += p.rec; inc.wr_tgt += p.tgt; } });
      const c = club[t];
      const incRb = (inc.rb_epa + PSEUDO * muRb) / (inc.rb_car + PSEUDO), clubRb = c.rb_car > 0 ? c.rb_epa / c.rb_car : muRb;
      const incWr = (inc.wr_epa + PSEUDO * muWr) / (inc.wr_tgt + PSEUDO), clubWr = c.wr_tgt > 0 ? c.wr_epa / c.wr_tgt : muWr;
      S_out[t] = { rb: incRb - clubRb, wr: incWr - clubWr, ol_share: olTot[t] > 0 ? (olRet[t] || 0) / olTot[t] : null,
        rb_in_carries: inc.rb_car, wr_in_targets: inc.wr_tgt };
      if (S_out[t].ol_share != null) olShares.push(S_out[t].ol_share);
    }
    /* OL enters as continuity above the league's average that offseason */
    const mOl = olShares.length ? olShares.reduce((a, b) => a + b, 0) / olShares.length : 0;
    for (const t of Object.keys(S_out)) S_out[t].ol = S_out[t].ol_share == null ? 0 : S_out[t].ol_share - mOl;
    out[S] = S_out;
  }
  fs.writeFileSync(cache, JSON.stringify(out));
  PERS = out;
  return out;
}

module.exports = { games, teamRows, qbRows, personnel, readCsv, num, fr, RAW, PBP };
