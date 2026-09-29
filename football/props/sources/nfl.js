/* ============================================================================
   PLAYER PROPS — the NFL dataset (nflverse, public and keyless).

   Reads, per season:
     stats_player_week   the official box line per player-game (gsis id)
     play_by_play        what the box does not carry: red-zone and goal-line
                         carries, red-zone targets, dropbacks, scrambles vs
                         designed runs, the longest rush / reception /
                         completion, per-event yards, team pace, neutral pass
                         rate and pass rate over expected, and everything a
                         defence ALLOWED (by position, per play, explosive,
                         EPA, success, sacks + QB hits)
     snap_counts         offensive snaps and snap share (pfr id → gsis via
                         weekly rosters)
     roster_weekly       position, headshot, pfr/espn ids, roster status
     depth_charts        the latest snapshot per team (QB/RB/WR/TE order)
     pfr_advstats pass   times pressured per QB-game
     games.csv           schedule, kickoff (US Eastern), consensus spread and
                         total, roof, surface, weather, final scores
   and the committed official injury report (football/injuries/nfl_<s>.json).

   Nothing is inferred here: every field is a count or a measured rate from
   the feeds, keyed by the ids the feeds carry. The model reads this dataset;
   the board ships only the slice of it a reader needs.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./fetch.js');
const C = require('../config.js');

const REL = 'https://github.com/nflverse/nflverse-data/releases/download/';
const URLS = {
  stats: (s) => REL + 'stats_player/stats_player_week_' + s + '.csv',
  pbp: (s) => REL + 'pbp/play_by_play_' + s + '.csv.gz',
  snaps: (s) => REL + 'snap_counts/snap_counts_' + s + '.csv',
  roster: (s) => REL + 'weekly_rosters/roster_weekly_' + s + '.csv',
  depth: (s) => REL + 'depth_charts/depth_charts_' + s + '.csv',
  pressure: (s) => REL + 'pfr_advstats/advstats_week_pass_' + s + '.csv',
  games: () => 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
};
const TEAM_NAMES = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills', CAR: 'Carolina Panthers', CHI: 'Chicago Bears',
  CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns', DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs', LV: 'Las Vegas Raiders', LAC: 'Los Angeles Chargers',
  LA: 'Los Angeles Rams', MIA: 'Miami Dolphins', MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SF: 'San Francisco 49ers', SEA: 'Seattle Seahawks', TB: 'Tampa Bay Buccaneers',
  TEN: 'Tennessee Titans', WAS: 'Washington Commanders'
};
const N = F.NUM, S = F.STR;
const POS_GROUP = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', K: 'K', PK: 'K', P: 'P',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', OLB: 'LB', ILB: 'LB', MLB: 'LB', LB: 'LB', CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', DB: 'DB', SAF: 'DB' };
function posGroup(p) { return POS_GROUP[String(p || '').toUpperCase()] || null; }

/* US Eastern wall clock → UTC (DST: second Sunday of March to first Sunday of November) */
function etToUtc(day, hhmm) {
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number), [hh, mm] = String(hhmm || '13:00').split(':').map(Number);
  const nthSunday = (yr, mon, nth) => { const f = new Date(Date.UTC(yr, mon, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7 * (nth - 1); };
  const dstStart = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), dstEnd = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const off = (naive + 5 * 3600e3 >= dstStart && naive + 4 * 3600e3 < dstEnd) ? 4 : 5;
  return new Date(naive + off * 3600e3).toISOString();
}

async function fetchSeason(season, opts) {
  const o = Object.assign({ season: opts.current_season }, opts);
  const get = (k, name, u) => F.getText(u, name, o);
  const out = {};
  const want = opts.feeds || ['stats', 'pbp', 'snaps', 'roster', 'depth', 'pressure'];
  for (const k of want) {
    const u = URLS[k](season), name = 'nfl_' + k + '_' + season + (k === 'pbp' ? '.csv.gz' : '.csv');
    out[k] = await get(k, name, u);
  }
  return out;
}

/* ------------------------------------------------------------ schedule */
function parseGames(text) {
  const rows = F.readCsv(text, ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score',
    'result', 'total', 'overtime', 'spread_line', 'total_line', 'away_moneyline', 'home_moneyline', 'roof', 'surface', 'temp', 'wind', 'stadium', 'div_game', 'away_rest', 'home_rest', 'location']);
  return rows.map((g) => ({
    game_id: g.game_id, season: N(g.season), week: N(g.week), game_type: g.game_type, gameday: g.gameday, gametime: g.gametime,
    kickoff: etToUtc(g.gameday, g.gametime), away: g.away_team, home: g.home_team, away_score: N(g.away_score), home_score: N(g.home_score),
    overtime: N(g.overtime) === 1, neutral: g.location === 'Neutral',
    /* nflverse spread_line is the HOME margin the market expects (home favoured > 0) */
    spread_line: N(g.spread_line), total_line: N(g.total_line), away_ml: N(g.away_moneyline), home_ml: N(g.home_moneyline),
    roof: S(g.roof), surface: S(g.surface), temp: N(g.temp), wind: N(g.wind), stadium: S(g.stadium), div_game: N(g.div_game) === 1,
    away_rest: N(g.away_rest), home_rest: N(g.home_rest),
    status: N(g.home_score) != null && N(g.away_score) != null ? 'final' : 'scheduled'
  }));
}

/* ------------------------------------------------------------ one season */
function buildSeason(season, feeds, sched) {
  const games = {};
  sched.filter((g) => g.season === season).forEach((g) => { games[g.game_id] = g; });
  const players = {}, teamGames = {}, perEvent = { rush: {}, rec: {}, cmp: [] };
  const P = (id) => players[id] || (players[id] = { id, logs: {} });

  /* roster: positions, ids, headshots, status by week */
  const roster = feeds.roster && feeds.roster.ok ? F.readCsv(feeds.roster.text, ['season', 'team', 'position', 'depth_chart_position', 'status', 'full_name', 'gsis_id', 'espn_id', 'pfr_id', 'headshot_url', 'week', 'football_name', 'first_name', 'last_name']) : [];
  const pfr2gsis = {};
  roster.forEach((r) => {
    if (!r.gsis_id) return;
    const p = P(r.gsis_id), wk = N(r.week) || 0;
    if (!p._wk || wk >= p._wk) {
      p._wk = wk; p.name = r.full_name; p.pos = r.position; p.team = r.team; p.headshot = S(r.headshot_url); p.espn_id = S(r.espn_id); p.pfr_id = S(r.pfr_id);
      p.roster_status = r.status; p.football_name = S(r.football_name); p.first = S(r.first_name); p.last = S(r.last_name);
    }
    if (r.pfr_id) pfr2gsis[r.pfr_id] = r.gsis_id;
  });

  /* the box line */
  const stats = feeds.stats && feeds.stats.ok ? F.readCsv(feeds.stats.text) : [];
  stats.forEach((r) => {
    if (!r.player_id || !r.game_id) return;
    const p = P(r.player_id);
    if (!p.name) { p.name = r.player_display_name; p.pos = r.position; }
    if (!p.team) p.team = r.team;
    const g = games[r.game_id];
    const L = p.logs[r.game_id] = p.logs[r.game_id] || {};
    Object.assign(L, {
      gid: r.game_id, s: N(r.season), w: N(r.week), st: r.season_type, date: g ? g.gameday : null, tm: r.team, op: r.opponent_team,
      h: g ? (g.home === r.team ? 1 : 0) : null,
      att: N(r.attempts) || 0, cmp: N(r.completions) || 0, pyd: N(r.passing_yards) || 0, ptd: N(r.passing_tds) || 0, int: N(r.passing_interceptions) || 0,
      sk: N(r.sacks_suffered) || 0, car: N(r.carries) || 0, ryd: N(r.rushing_yards) || 0, rtd: N(r.rushing_tds) || 0,
      tgt: N(r.targets) || 0, rec: N(r.receptions) || 0, yd: N(r.receiving_yards) || 0, td: N(r.receiving_tds) || 0, ay: N(r.receiving_air_yards) || 0,
      tshare: N(r.target_share), st_td: N(r.special_teams_tds) || 0,
      fgm: N(r.fg_made) || 0, fga: N(r.fg_att) || 0, xpm: N(r.pat_made) || 0,
      tkl: N(r.def_tackles_solo) || 0, ast: N(r.def_tackle_assists) || 0, dsk: N(r.def_sacks) || 0, dint: N(r.def_interceptions) || 0,
      fp: N(r.fantasy_points_ppr)
    });
  });

  /* play by play */
  const pbpCols = ['game_id', 'season_type', 'week', 'posteam', 'defteam', 'yardline_100', 'down', 'half_seconds_remaining', 'play_type', 'yards_gained',
    'qb_dropback', 'qb_kneel', 'qb_spike', 'qb_scramble', 'air_yards', 'epa', 'wp', 'pass_attempt', 'rush_attempt', 'sack', 'qb_hit', 'complete_pass',
    'two_point_attempt', 'passer_player_id', 'receiver_player_id', 'rusher_player_id', 'xpass', 'pass_oe', 'success', 'touchdown', 'pass_touchdown', 'rush_touchdown', 'aborted_play', 'interception'];
  const pbp = feeds.pbp && feeds.pbp.ok ? F.readCsv(feeds.pbp.text, pbpCols) : [];
  const posOf = (id) => players[id] ? posGroup(players[id].pos) : null;
  const TG = (gid, tm) => {
    const k = gid + '|' + tm;
    return teamGames[k] || (teamGames[k] = { gid, tm, plays: 0, db: 0, dr: 0, sk: 0, qbh: 0, pyd_net: 0, ryd: 0, rz_plays: 0, rz_dr: 0, gl_dr: 0, rz_att: 0, int: 0, n_neutral: 0, db_neutral: 0, xpass_n: 0, proe_n: 0,
      rush_epa: 0, pass_epa: 0, rush_succ: 0, pass_succ: 0, expl_rush: 0, expl_pass: 0, cmp: 0, att: 0, pyd: 0, ptd: 0, rtd: 0,
      pos: { RB: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, WR: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, TE: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 }, QB: { car: 0, ryd: 0, tgt: 0, rec: 0, yd: 0 } } });
  };
  const PL = (id, gid) => { if (!id) return null; const p = P(id); return p.logs[gid] || (p.logs[gid] = { gid }); };
  const bump = (L, k, v) => { L[k] = (L[k] || 0) + v; };
  const maxTo = (L, k, v) => { if (L[k] == null || v > L[k]) L[k] = v; };
  pbp.forEach((r) => {
    if (!r.posteam || !r.game_id || N(r.two_point_attempt) === 1 || N(r.aborted_play) === 1) return;
    const pt = r.play_type;
    if (pt !== 'pass' && pt !== 'run' && pt !== 'qb_kneel' && pt !== 'qb_spike') return;
    if (pt === 'qb_kneel' || pt === 'qb_spike' || N(r.qb_kneel) === 1 || N(r.qb_spike) === 1) return;
    const T = TG(r.game_id, r.posteam), yds = N(r.yards_gained) || 0, yl = N(r.yardline_100), epa = N(r.epa), succ = N(r.success) === 1;
    const dropback = N(r.qb_dropback) === 1, scramble = N(r.qb_scramble) === 1;
    const designed = !dropback && N(r.rush_attempt) === 1;
    T.plays++;
    if (yl != null && yl <= 20) T.rz_plays++;
    const wp = N(r.wp), down = N(r.down), hs = N(r.half_seconds_remaining);
    const neutral = wp != null && wp >= 0.2 && wp <= 0.8 && down != null && down <= 2 && (hs == null || hs > 120);
    if (neutral) {
      T.n_neutral++; if (dropback) T.db_neutral++;
      const xp = N(r.xpass); if (xp != null) T.xpass_n += xp;
      const oe = N(r.pass_oe); if (oe != null) T.proe_n += oe / 100;
    }
    if (dropback) {
      T.db++; T.pyd_net += yds; if (epa != null) T.pass_epa += epa; if (succ) T.pass_succ++;
      if (N(r.sack) === 1) T.sk++;
      if (N(r.qb_hit) === 1 || N(r.sack) === 1) T.qbh++;
      if (yds >= 20) T.expl_pass++;
      const passer = r.passer_player_id;
      if (passer) { const L = PL(passer, r.game_id); bump(L, 'db', 1); if (N(r.sack) === 1) { /* box has sacks */ } }
      if (N(r.pass_attempt) === 1 && N(r.sack) !== 1 && !scramble) {
        T.att++;
        if (yl != null && yl <= 20) T.rz_att++;
        const rcv = r.receiver_player_id, pg = rcv ? posOf(rcv) : null;
        if (rcv) {
          const L = PL(rcv, r.game_id);
          if (yl != null && yl <= 20) bump(L, 'rzt', 1);
          if (pg && T.pos[pg]) T.pos[pg].tgt++;
          if (N(r.complete_pass) === 1) {
            maxTo(L, 'lng', yds);
            if (pg && T.pos[pg]) { T.pos[pg].rec++; T.pos[pg].yd += yds; }
            if (pg) (perEvent.rec[pg] = perEvent.rec[pg] || []).push(yds);
          }
        }
        if (N(r.complete_pass) === 1) {
          T.cmp++; T.pyd += yds; perEvent.cmp.push(yds);
          if (passer) maxTo(PL(passer, r.game_id), 'plng', yds);
        }
        if (N(r.pass_touchdown) === 1) T.ptd++;
        if (N(r.interception) === 1) T.int++;
      }
      if (scramble && r.rusher_player_id) { const L = PL(r.rusher_player_id, r.game_id); bump(L, 'scr', 1); maxTo(L, 'rlng', yds); }
    } else if (designed) {
      T.dr++; T.ryd += yds; if (epa != null) T.rush_epa += epa; if (succ) T.rush_succ++; if (yds >= 10) T.expl_rush++;
      if (N(r.rush_touchdown) === 1) T.rtd++;
      if (yl != null && yl <= 20) T.rz_dr++;
      if (yl != null && yl <= 5) T.gl_dr++;
      const rid = r.rusher_player_id, pg = rid ? posOf(rid) : null;
      if (rid) {
        const L = PL(rid, r.game_id);
        maxTo(L, 'rlng', yds);
        if (yl != null && yl <= 20) bump(L, 'rz', 1);
        if (yl != null && yl <= 5) bump(L, 'gl', 1);
        if (pg === 'QB') bump(L, 'dr', 1);
        if (pg && T.pos[pg]) { T.pos[pg].car++; T.pos[pg].ryd += yds; }
        if (pg) (perEvent.rush[pg] = perEvent.rush[pg] || []).push(yds);
      }
    }
  });

  /* snaps */
  const snaps = feeds.snaps && feeds.snaps.ok ? F.readCsv(feeds.snaps.text, ['game_id', 'player', 'pfr_player_id', 'position', 'team', 'offense_snaps', 'offense_pct', 'defense_snaps', 'defense_pct']) : [];
  snaps.forEach((r) => {
    const id = pfr2gsis[r.pfr_player_id]; if (!id) return;
    const L = PL(id, r.game_id);
    const off = N(r.offense_snaps), def = N(r.defense_snaps);
    if (off != null && off > 0) { L.snp = off; L.snp_pct = N(r.offense_pct); }
    else if (def != null && def > 0) { L.snp = def; L.snp_pct = N(r.defense_pct); }
    else if (L.snp == null) { L.snp = 0; L.snp_pct = 0; }
    L.snap_team = r.team;
  });
  /* pressure (QBs) */
  const adv = feeds.pressure && feeds.pressure.ok ? F.readCsv(feeds.pressure.text, ['game_id', 'pfr_player_id', 'times_pressured', 'times_pressured_pct']) : [];
  adv.forEach((r) => { const id = pfr2gsis[r.pfr_player_id]; if (!id) return; const L = PL(id, r.game_id); L.prs = N(r.times_pressured); });

  /* complete every log with its schedule context; drop pbp-only rows of
     players the box does not list (a lateral, a 2-pt) */
  Object.keys(players).forEach((id) => {
    const p = players[id];
    Object.keys(p.logs).forEach((gid) => {
      const L = p.logs[gid], g = games[gid];
      if (L.s == null) {
        if (!g) { delete p.logs[gid]; return; }
        const tm = L.snap_team || p.team; if (!tm) { delete p.logs[gid]; return; }
        Object.assign(L, { s: g.season, w: g.week, st: g.game_type === 'REG' ? 'REG' : 'POST', date: g.gameday, tm, op: g.home === tm ? g.away : g.home, h: g.home === tm ? 1 : 0 });
        ['att', 'cmp', 'pyd', 'ptd', 'int', 'sk', 'car', 'ryd', 'rtd', 'tgt', 'rec', 'yd', 'td', 'ay', 'st_td', 'fgm', 'fga', 'xpm', 'tkl', 'ast', 'dsk', 'dint'].forEach((k) => { if (L[k] == null) L[k] = 0; });
      }
      if (L.h == null && g) L.h = g.home === L.tm ? 1 : 0;
      if (!L.date && g) L.date = g.gameday;
      delete L.snap_team;
    });
    delete p._wk;
  });

  /* team rows get their points; opponents' rows are the defence allowed */
  Object.keys(teamGames).forEach((k) => {
    const T = teamGames[k], g = games[T.gid];
    if (!g) return;
    T.s = g.season; T.w = g.week; T.date = g.gameday; T.h = g.home === T.tm ? 1 : 0; T.op = T.h ? g.away : g.home;
    T.pts = T.h ? g.home_score : g.away_score; T.opp_pts = T.h ? g.away_score : g.home_score;
    T.rtd = T.rtd || 0;
  });
  return { season, players, teamGames, perEvent, feeds: summarizeFeeds(feeds) };
}
function summarizeFeeds(feeds) {
  const o = {};
  Object.keys(feeds).forEach((k) => { const f = feeds[k]; o[k] = f ? { ok: !!f.ok, from: f.from || null, retrieved_at: f.retrieved_at || null, url: f.url || null, error: f.error || null } : null; });
  return o;
}

/* the latest depth chart per team: order at QB / RB / WR / TE */
function parseDepth(text) {
  const rows = F.readCsv(text, ['dt', 'team', 'player_name', 'gsis_id', 'pos_abb', 'pos_rank']);
  const lastDt = {};
  rows.forEach((r) => { if (!lastDt[r.team] || r.dt > lastDt[r.team]) lastDt[r.team] = r.dt; });
  const out = {};
  rows.forEach((r) => {
    if (r.dt !== lastDt[r.team] || ['QB', 'RB', 'WR', 'TE', 'FB', 'PK'].indexOf(r.pos_abb) < 0) return;
    const t = out[r.team] || (out[r.team] = { as_of: r.dt, QB: [], RB: [], WR: [], TE: [], K: [] });
    const pos = r.pos_abb === 'FB' ? 'RB' : r.pos_abb === 'PK' ? 'K' : r.pos_abb;
    t[pos].push({ id: S(r.gsis_id), name: r.player_name, rank: N(r.pos_rank) });
  });
  Object.keys(out).forEach((t) => ['QB', 'RB', 'WR', 'TE', 'K'].forEach((p) => out[t][p].sort((a, b) => a.rank - b.rank)));
  return out;
}

function readInjuries(season) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(C.ROOT, 'football', 'injuries', 'nfl_' + season + '.json'), 'utf8'));
    const by = {};
    Object.keys(j.teams || {}).forEach((t) => (j.teams[t].players || []).forEach((p) => {
      if (p.gsis_id) by[p.gsis_id] = { status: p.status || null, practice: p.practice || null, injury: p.injury || null, team: t, week: j.teams[t].week };
    }));
    return { published: j.published !== false, retrieved_at: j.retrieved_at || null, latest_week: j.latest_week || null, by_player: by, teams: Object.keys(j.teams || {}) };
  } catch (e) { return { published: false, retrieved_at: null, by_player: {}, teams: [], error: e.message }; }
}
function readSlate() {
  try { return JSON.parse(fs.readFileSync(path.join(C.ROOT, 'football', 'nfl', 'slate.json'), 'utf8')); } catch (e) { return null; }
}

/* per-event yards → gamma parameters by position (method of moments on
   yards + shift, so a carry can lose yards) */
function fitEvents(list, shift) {
  const raw = (list || []).filter((v) => isFinite(v));
  const xs = raw.map((v) => Math.max(-shift + 0.5, v) + shift);
  if (xs.length < 30) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length, v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return { n: xs.length, mean: +(m - shift).toFixed(3), sd: +Math.sqrt(v).toFixed(3), a: +(m * m / v).toFixed(4), theta: +(v / m).toFixed(4), shift, shape: empiricalShape(raw) };
}
/* the empirical CDF of per-play yards at whole-yard steps (the table a
   'maxemp' longest-play distribution reads) */
function empiricalShape(raw) {
  const ys = raw.map((v) => Math.round(v)).sort((a, b) => a - b), n = ys.length;
  const x = [], p = [];
  let i = 0;
  while (i < n) { const v = ys[i]; let j = i; while (j < n && ys[j] === v) j++; x.push(v); p.push(+(j / n).toFixed(6)); i = j; }
  /* thin the far tail: keep every point up to 60 yards, then every 5 */
  const keepX = [], keepP = [];
  x.forEach((v, k) => { if (v <= 60 || k === x.length - 1 || v % 5 === 0) { keepX.push(v); keepP.push(p[k]); } });
  return { x: keepX, p: keepP, n, mean: +(raw.reduce((a, b) => a + b, 0) / n).toFixed(3) };
}
function mergeEvents(a, b) {
  const o = { rush: {}, rec: {}, cmp: (a.cmp || []).concat(b.cmp || []) };
  ['rush', 'rec'].forEach((k) => { const ks = new Set(Object.keys(a[k] || {}).concat(Object.keys(b[k] || {}))); ks.forEach((p) => { o[k][p] = ((a[k] || {})[p] || []).concat((b[k] || {})[p] || []); }); });
  return o;
}

/* ------------------------------------------------------------ the dataset */
async function load(opts) {
  opts = opts || {};
  const season = opts.season || C.seasonOf(opts.now);
  const prior = season - 1;
  const o = { offline: !!opts.offline, current_season: season, download: opts.download };
  const gamesFeed = await F.getText(URLS.games(), 'nfl_games.csv', Object.assign({}, o, { season: season }));
  if (!gamesFeed.ok) return { ok: false, league: 'nfl', season, error: 'schedule (games.csv) unavailable: ' + gamesFeed.error };
  const sched = parseGames(gamesFeed.text);
  const curFeeds = await fetchSeason(season, Object.assign({}, o, { feeds: opts.current_feeds || ['stats', 'pbp', 'snaps', 'roster', 'depth', 'pressure'] }));
  const priorFeeds = opts.no_prior ? {} : await fetchSeason(prior, Object.assign({}, o, { feeds: ['stats', 'pbp', 'snaps', 'roster'] }));
  const cur = buildSeason(season, curFeeds, sched);
  const pri = opts.no_prior ? { players: {}, teamGames: {}, perEvent: { rush: {}, rec: {}, cmp: [] }, feeds: {} } : buildSeason(prior, priorFeeds, sched);
  return assemble({ league: 'nfl', season, sched, cur, pri, depth: curFeeds.depth && curFeeds.depth.ok ? parseDepth(curFeeds.depth.text) : {},
    injuries: readInjuries(season), slate: readSlate(), feeds: { schedule: summarizeFeeds({ games: gamesFeed }).games, current: cur.feeds, prior: pri.feeds } });
}

/* both seasons into one dataset: a player's logs in date order, identity from
   the current season, teams' game rows, per-event fits */
function assemble(x) {
  const players = {};
  [x.pri, x.cur].forEach((part) => Object.keys(part.players).forEach((id) => {
    const src = part.players[id];
    const p = players[id] || (players[id] = { id, logs: [] });
    ['name', 'pos', 'team', 'headshot', 'espn_id', 'pfr_id', 'roster_status', 'football_name', 'first', 'last'].forEach((k) => { if (src[k] != null && (part === x.cur || p[k] == null)) p[k] = src[k]; });
    Object.keys(src.logs).forEach((gid) => p.logs.push(src.logs[gid]));
  }));
  Object.keys(players).forEach((id) => {
    const p = players[id];
    p.pg = posGroup(p.pos);
    p.logs.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.w || 0) - (b.w || 0));
    if (!p.logs.length || !p.pg) delete players[id];
  });
  const teams = {};
  [x.pri, x.cur].forEach((part) => Object.keys(part.teamGames).forEach((k) => { const T = part.teamGames[k]; if (T.s == null) return; (teams[T.tm] = teams[T.tm] || []).push(T); }));
  Object.keys(teams).forEach((t) => teams[t].sort((a, b) => (a.date || '').localeCompare(b.date || '')));
  const ev = mergeEvents(x.pri.perEvent, x.cur.perEvent);
  const fits = { rush: {}, rec: {}, cmp: fitEvents(ev.cmp, 0) };
  Object.keys(ev.rush).forEach((p) => { fits.rush[p] = fitEvents(ev.rush[p], 4); });
  Object.keys(ev.rec).forEach((p) => { fits.rec[p] = fitEvents(ev.rec[p], 1); });
  return { ok: true, league: 'nfl', season: x.season, built_at: new Date().toISOString(), schedule: x.sched.filter((g) => g.season >= x.season - 1),
    players, teams, depth: x.depth, injuries: x.injuries, slate: x.slate, event_fits: fits, feeds: x.feeds, team_names: TEAM_NAMES };
}

module.exports = { load, parseGames, buildSeason, parseDepth, assemble, fitEvents, etToUtc, posGroup, URLS, TEAM_NAMES, readInjuries };
