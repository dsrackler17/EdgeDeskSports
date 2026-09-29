/* ===========================================================================
   PLAYER PROPS — the NFL dataset, assembled from nflverse, keyed by GSIS id.
   docs/player-props/DATA.md

   One normalised in-memory dataset per build:
     players      GSIS id → identity + every provider id nflverse carries
     games        game_id → schedule, kickoff (UTC), roof, weather, results
     playerGames  one row per player-game: box score + snaps + play-by-play
                  features (red-zone targets/carries, third-down targets,
                  scrambles vs designed runs, longest plays, air yards)
     teamGames    one row per team-game: plays, dropbacks, attempts, sacks,
                  scrambles, designed runs, neutral pass rate, points
     depth        team → timestamped depth-chart snapshots (QB/RB/WR/TE)
     injuries     season|week|team → gsis → official report status
     pools        league per-play gain distributions (receptions by
                  position × depth class, RB carries, QB designed runs,
                  scrambles) — the empirical tails the simulator draws from

   AS-OF DISCIPLINE. Nothing here decides what was knowable when: every row
   carries its game's kickoff, and football/props/model.js filters on it.
   Depth-chart snapshots keep their provider timestamp `dt`; a snapshot is
   usable for a game only when dt < kickoff. The injury report is the
   pregame official report for that week.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./sources.js');
const { n, s } = S;

const SKILL = { QB: 1, RB: 1, FB: 1, HB: 1, WR: 1, TE: 1 };

/* games.csv gameday + gametime are US/Eastern; UTC via the US DST rule */
function etToUtc(day, time) {
  if (!day) return null;
  const [Y, M, D] = day.split('-').map(Number);
  const [h, m] = String(time || '13:00').split(':').map(Number);
  const secondSunMar = nthSunday(Y, 2, 2), firstSunNov = nthSunday(Y, 10, 1);
  const t = Date.UTC(Y, M - 1, D, h, m);
  const dst = t >= Date.UTC(Y, 2, secondSunMar, 7) && t < Date.UTC(Y, 10, firstSunNov, 6);
  return new Date(t + (dst ? 4 : 5) * 3600000).toISOString();
}
function nthSunday(Y, month0, k) { const d = new Date(Date.UTC(Y, month0, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return first + 7 * (k - 1); }

function posGroup(p) {
  const x = String(p || '').toUpperCase();
  if (x === 'HB' || x === 'FB') return 'RB';
  return x;
}

async function loadPlayers(opts) {
  const f = await S.fetchToCache(S.NFL.players(), { maxAgeMin: opts.maxAgeMin == null ? 720 : opts.maxAgeMin, offline: opts.offline });
  const out = new Map();
  if (!f.file) return { players: out, source: { url: S.NFL.players(), error: f.error } };
  await S.readCsv(f.file, ['gsis_id', 'display_name', 'common_first_name', 'first_name', 'last_name', 'short_name', 'football_name', 'suffix', 'esb_id', 'nfl_id', 'pfr_id', 'pff_id', 'otc_id', 'espn_id', 'smart_id', 'birth_date', 'position_group', 'position', 'headshot', 'college_name', 'jersey_number', 'rookie_season', 'last_season', 'latest_team', 'status', 'years_of_experience', 'draft_year', 'draft_round', 'draft_pick', 'draft_team'], (r) => {
    const id = s(r.gsis_id);
    if (!id) return;
    out.set(id, { gsis: id, name: s(r.display_name), first: s(r.common_first_name) || s(r.first_name), last: s(r.last_name), short: s(r.short_name), football_name: s(r.football_name), suffix: s(r.suffix),
      position: s(r.position), pos_group: posGroup(s(r.position)), espn_id: s(r.espn_id), pfr_id: s(r.pfr_id), pff_id: s(r.pff_id), esb_id: s(r.esb_id), nfl_id: s(r.nfl_id), smart_id: s(r.smart_id), otc_id: s(r.otc_id),
      birth_date: s(r.birth_date), headshot: s(r.headshot), college: s(r.college_name), jersey: s(r.jersey_number), rookie_season: n(r.rookie_season), last_season: n(r.last_season),
      latest_team: s(r.latest_team), status: s(r.status), years_exp: n(r.years_of_experience), draft: s(r.draft_year) ? { year: n(r.draft_year), round: n(r.draft_round), pick: n(r.draft_pick), team: s(r.draft_team) } : null });
  });
  return { players: out, source: { url: S.NFL.players(), bytes: f.bytes, error: f.error } };
}

async function loadGames(opts) {
  const f = await S.fetchToCache(S.NFL.games(), { maxAgeMin: opts.maxAgeMin == null ? 60 : opts.maxAgeMin, offline: opts.offline });
  const out = new Map();
  if (!f.file) return { games: out, source: { url: S.NFL.games(), error: f.error } };
  await S.readCsv(f.file, ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'location', 'result', 'total', 'spread_line', 'total_line', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'away_qb_name', 'home_qb_name', 'div_game', 'away_rest', 'home_rest'], (r) => {
    const season = n(r.season);
    if (!season || season < 2023) return;
    out.set(r.game_id, { game_id: r.game_id, season, week: n(r.week), game_type: s(r.game_type), kickoff: etToUtc(r.gameday, r.gametime), gameday: r.gameday,
      home: normTeam(r.home_team), away: normTeam(r.away_team), home_score: n(r.home_score), away_score: n(r.away_score), neutral: s(r.location) === 'Neutral',
      spread_line: n(r.spread_line), total_line: n(r.total_line), roof: s(r.roof), surface: s(r.surface), temp: n(r.temp), wind: n(r.wind),
      home_qb: s(r.home_qb_id), away_qb: s(r.away_qb_id), home_qb_name: s(r.home_qb_name), away_qb_name: s(r.away_qb_name), div_game: r.div_game === '1' });
  });
  return { games: out, source: { url: S.NFL.games(), bytes: f.bytes, error: f.error } };
}
/* nflverse uses LA for the Rams everywhere in these feeds; keep it */
function normTeam(t) { const x = String(t || '').toUpperCase(); return x === 'LAR' ? 'LA' : x; }

async function loadStats(season, opts) {
  const url = S.NFL.stats_week(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 60 : opts.maxAgeMin, offline: opts.offline });
  const rows = [];
  if (!f.file) return { rows, source: { url, error: f.error } };
  await S.readCsv(f.file, ['player_id', 'player_display_name', 'position', 'season', 'week', 'season_type', 'game_id', 'team', 'opponent_team', 'completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'sacks_suffered', 'passing_air_yards', 'carries', 'rushing_yards', 'rushing_tds', 'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'receiving_air_yards', 'receiving_yards_after_catch', 'target_share', 'air_yards_share'], (r) => {
    const pos = posGroup(r.position);
    if (!SKILL[pos]) return;
    rows.push({ gsis: r.player_id, name: s(r.player_display_name), pos, season: n(r.season), week: n(r.week), season_type: s(r.season_type), game_id: s(r.game_id), team: normTeam(r.team), opp: normTeam(r.opponent_team),
      cmp: n(r.completions) || 0, att: n(r.attempts) || 0, pass_yds: n(r.passing_yards) || 0, pass_td: n(r.passing_tds) || 0, int: n(r.passing_interceptions) || 0, sacks: n(r.sacks_suffered) || 0, pass_air: n(r.passing_air_yards) || 0,
      car: n(r.carries) || 0, rush_yds: n(r.rushing_yards) || 0, rush_td: n(r.rushing_tds) || 0, rec: n(r.receptions) || 0, tgt: n(r.targets) || 0, rec_yds: n(r.receiving_yards) || 0, rec_td: n(r.receiving_tds) || 0,
      rec_air: n(r.receiving_air_yards) || 0, yac: n(r.receiving_yards_after_catch) || 0 });
  });
  return { rows, source: { url, bytes: f.bytes, error: f.error } };
}

async function loadSnaps(season, opts, pfrToGsis) {
  const url = S.NFL.snaps(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 60 : opts.maxAgeMin, offline: opts.offline });
  const out = new Map();
  let unmapped = 0;
  if (!f.file) return { snaps: out, unmapped, source: { url, error: f.error } };
  await S.readCsv(f.file, ['game_id', 'pfr_player_id', 'player', 'position', 'team', 'offense_snaps', 'offense_pct'], (r) => {
    const pos = posGroup(r.position);
    if (!SKILL[pos]) return;
    const g = pfrToGsis.get(r.pfr_player_id);
    if (!g) { unmapped++; return; }
    out.set(r.game_id + '|' + g, { snaps: n(r.offense_snaps) || 0, snap_pct: n(r.offense_pct) });
  });
  return { snaps: out, unmapped, source: { url, bytes: f.bytes, error: f.error } };
}

/* depth charts: keep QB/RB/WR/TE snapshots per team, ordered lists by
   pos_rank. The provider timestamp `dt` is the as-of key. */
async function loadDepth(season, opts) {
  const url = S.NFL.depth(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 180 : opts.maxAgeMin, offline: opts.offline });
  const byTeam = new Map();
  if (!f.file) return { depth: byTeam, source: { url, error: f.error } };
  const POS = { QB: 'QB', RB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', LWR: 'WR', RWR: 'WR', SWR: 'WR', SLWR: 'WR', WR1: 'WR', WR2: 'WR', WR3: 'WR' };
  const tmp = new Map();
  await S.readCsv(f.file, ['dt', 'team', 'gsis_id', 'pos_abb', 'pos_rank', 'pos_slot', 'pos_grp'], (r) => {
    const pg = POS[String(r.pos_abb || '').toUpperCase()];
    if (!pg || !r.gsis_id || r.gsis_id === 'NA') return;
    if (r.pos_grp && /special|defen|punt|kick|return/i.test(r.pos_grp)) return;
    const team = normTeam(r.team), dt = Date.parse(r.dt);
    if (!isFinite(dt)) return;
    const k = team + '|' + dt;
    let snap = tmp.get(k);
    if (!snap) { snap = { team, dt, entries: [] }; tmp.set(k, snap); }
    snap.entries.push({ g: r.gsis_id, pos: pg, rank: n(r.pos_rank) || 9, slot: n(r.pos_slot) || 0, abb: String(r.pos_abb) });
  });
  for (const snap of tmp.values()) {
    const ranks = { QB: [], RB: [], WR: [], TE: [] };
    const seen = {};
    snap.entries.sort((a, b) => a.rank - b.rank || a.slot - b.slot).forEach((e) => { const key = e.pos + e.g; if (seen[key]) return; seen[key] = 1; ranks[e.pos].push({ g: e.g, rank: e.rank, abb: e.abb }); });
    if (!byTeam.has(snap.team)) byTeam.set(snap.team, []);
    byTeam.get(snap.team).push({ dt: snap.dt, ranks });
  }
  for (const list of byTeam.values()) list.sort((a, b) => a.dt - b.dt);
  return { depth: byTeam, source: { url, bytes: f.bytes, error: f.error } };
}
/* the latest snapshot strictly before `asOfMs` (never one published after) */
function depthAsOf(depth, team, asOfMs) {
  const list = depth.get(team);
  if (!list || !list.length) return null;
  let lo = 0, hi = list.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].dt < asOfMs) { best = list[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best;
}

async function loadInjuries(season, opts) {
  const url = S.NFL.injuries(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 60 : opts.maxAgeMin, offline: opts.offline });
  const out = new Map();
  if (!f.file) return { injuries: out, source: { url, error: f.error } };
  await S.readCsv(f.file, ['season', 'game_type', 'team', 'week', 'gsis_id', 'position', 'full_name', 'report_primary_injury', 'report_status', 'practice_status'], (r) => {
    const k = n(r.season) + '|' + n(r.week) + '|' + normTeam(r.team);
    if (!out.has(k)) out.set(k, new Map());
    out.get(k).set(r.gsis_id, { status: s(r.report_status), practice: s(r.practice_status), injury: s(r.report_primary_injury), name: s(r.full_name), position: s(r.position) });
  });
  return { injuries: out, source: { url, bytes: f.bytes, error: f.error } };
}

async function loadRosterWeekly(season, opts) {
  const url = S.NFL.roster_weekly(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 180 : opts.maxAgeMin, offline: opts.offline });
  const out = new Map();
  if (!f.file) return { roster: out, source: { url, error: f.error } };
  await S.readCsv(f.file, ['season', 'team', 'position', 'depth_chart_position', 'status', 'full_name', 'gsis_id', 'week', 'game_type'], (r) => {
    const pos = posGroup(r.position);
    if (!SKILL[pos] || !r.gsis_id || r.gsis_id === 'NA') return;
    const k = n(r.season) + '|' + n(r.week) + '|' + normTeam(r.team);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ gsis: r.gsis_id, name: s(r.full_name), pos, status: s(r.status) });
  });
  return { roster: out, source: { url, bytes: f.bytes, error: f.error } };
}

/* play-by-play → player-game features, team-game features, gain pools */
async function loadPbp(season, opts, positions, games) {
  const url = S.NFL.pbp(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 120 : opts.maxAgeMin, offline: opts.offline });
  const pg = new Map(), tg = new Map();
  const pools = { rec: {}, rush_rb: [], rush_qb_designed: [], scramble: [], rush_wr: [] };
  if (!f.file) return { pg, tg, pools, source: { url, error: f.error } };
  const cols = ['play_id', 'game_id', 'posteam', 'defteam', 'week', 'season_type', 'yardline_100', 'qtr', 'down', 'play_type', 'yards_gained', 'qb_dropback', 'qb_kneel', 'qb_spike', 'qb_scramble', 'air_yards',
    'wp', 'two_point_attempt', 'pass_attempt', 'rush_attempt', 'sack', 'complete_pass', 'interception', 'pass_touchdown', 'rush_touchdown', 'passer_player_id', 'receiver_player_id', 'rusher_player_id', 'posteam_score_post', 'defteam_score_post'];
  function P(game, gsis) { const k = game + '|' + gsis; let o = pg.get(k); if (!o) { o = { rz_tgt: 0, rz_car: 0, gl_car: 0, third_tgt: 0, scr: 0, scr_yds: 0, des: 0, des_yds: 0, long_rec: null, long_rush: null, long_cmp: null, rec_list: [], neutral_tgt: 0, ez_tgt: 0 }; pg.set(k, o); } return o; }
  function T(game, team) { const k = game + '|' + team; let o = tg.get(k); if (!o) { o = { plays: 0, dropbacks: 0, att: 0, sacks: 0, scrambles: 0, designed: 0, neutral_plays: 0, neutral_db: 0, rz_plays: 0, rz_db: 0, rz_designed: 0, rz_targets: 0, third_targets: 0, targets: 0, pass_yds: 0, rush_yds: 0, pts: null, opp_pts: null, pass_td: 0, rush_td: 0, int: 0, cmp: 0 }; tg.set(k, o); } return o; }
  await S.readCsv(f.file, cols, (r) => {
    if (r.season_type && r.season_type !== 'REG' && r.season_type !== 'POST') return;
    const team = normTeam(r.posteam), game = r.game_id;
    if (!team || !game) return;
    const pt = r.play_type;
    const t = T(game, team);
    const gk = games && games.get(game);
    const kt = gk ? Date.parse(gk.kickoff) : null;
    const psp = n(r.posteam_score_post), dsp = n(r.defteam_score_post);
    if (psp != null) t.pts = Math.max(t.pts || 0, psp);
    if (dsp != null) t.opp_pts = Math.max(t.opp_pts || 0, dsp);
    if (pt !== 'pass' && pt !== 'run') return;
    if (r.two_point_attempt === '1') return;
    const yds = n(r.yards_gained) || 0, y100 = n(r.yardline_100), wp = n(r.wp), qtr = n(r.qtr), down = n(r.down);
    const db = r.qb_dropback === '1', scr = r.qb_scramble === '1', sack = r.sack === '1';
    const neutral = wp != null && wp >= 0.2 && wp <= 0.8 && qtr != null && qtr <= 3;
    const rz = y100 != null && y100 <= 20;
    t.plays++;
    if (neutral) { t.neutral_plays++; if (db) t.neutral_db++; }
    if (rz) { t.rz_plays++; if (db) t.rz_db++; }
    if (db) t.dropbacks++;
    if (sack) t.sacks++;
    if (scr) t.scrambles++;
    if (pt === 'run' && !scr) { t.designed++; if (rz) t.rz_designed++; }
    if (pt === 'pass' && !sack && r.pass_attempt === '1') {
      t.att++;
      if (r.interception === '1') t.int++;
      const rid = s(r.receiver_player_id);
      if (rid) {
        t.targets++;
        if (rz) t.rz_targets++;
        if (down === 3) t.third_targets++;
        const o = P(game, rid);
        if (rz) o.rz_tgt++;
        if (y100 != null && y100 <= 10) o.ez_tgt++;
        if (down === 3) o.third_tgt++;
        if (neutral) o.neutral_tgt++;
        if (r.complete_pass === '1') {
          t.cmp++; t.pass_yds += yds;
          if (o.long_rec == null || yds > o.long_rec) o.long_rec = yds;
          o.rec_list.push(yds);
          const q = s(r.passer_player_id);
          if (q) { const qo = P(game, q); if (qo.long_cmp == null || yds > qo.long_cmp) qo.long_cmp = yds; }
          const pos = positions.get(rid);
          if (pos && (pos === 'WR' || pos === 'TE' || pos === 'RB')) { (pools.rec[pos] = pools.rec[pos] || []).push([kt, yds]); }
        }
        if (r.pass_touchdown === '1') t.pass_td++;
      }
    }
    if (pt === 'run') {
      const rid = s(r.rusher_player_id);
      if (rid) {
        const o = P(game, rid);
        const pos = positions.get(rid);
        if (rz) o.rz_car++;
        if (y100 != null && y100 <= 5) o.gl_car++;
        if (o.long_rush == null || yds > o.long_rush) o.long_rush = yds;
        if (scr) { o.scr++; o.scr_yds += yds; pools.scramble.push([kt, yds]); }
        else {
          o.des++; o.des_yds += yds;
          if (pos === 'RB') pools.rush_rb.push([kt, yds]); else if (pos === 'QB') pools.rush_qb_designed.push([kt, yds]); else if (pos === 'WR') pools.rush_wr.push([kt, yds]);
        }
        t.rush_yds += yds;
        if (r.rush_touchdown === '1') t.rush_td++;
      }
    }
  });
  return { pg, tg, pools, source: { url, bytes: f.bytes, error: f.error } };
}

/* the league per-play gain pools as they stood before asOfMs: each play
   carries its game's kickoff, so a backtest never draws a future play */
function poolsAsOf(data, asOfMs, E) {
  const pick = (list) => list.filter((x) => x[0] != null && x[0] < asOfMs).map((x) => x[1]);
  const raw = { WR: E.buildPool(pick(data.pools.rec.WR || [])), TE: E.buildPool(pick(data.pools.rec.TE || [])), RB: E.buildPool(pick(data.pools.rec.RB || [])),
    rush_rb: E.buildPool(pick(data.pools.rush_rb)), rush_qb_designed: E.buildPool(pick(data.pools.rush_qb_designed)), scramble: E.buildPool(pick(data.pools.scramble)), rush_wr: E.buildPool(pick(data.pools.rush_wr)) };
  const summary = {};
  Object.keys(raw).forEach((k) => { summary[k] = { n: raw[k].n, mean: Math.round(raw[k].mean * 100) / 100 }; });
  return { raw, summary };
}

/* the whole dataset for a list of seasons (the last is the current one) */
async function load(opts) {
  opts = opts || {};
  const seasons = opts.seasons || [2025, 2026];
  const t0 = Date.now();
  const sources = [];
  const gaps = [];
  const pl = await loadPlayers(opts); sources.push(pl.source); if (pl.source.error) gaps.push({ source: 'players', error: pl.source.error });
  const players = pl.players;
  const pfrToGsis = new Map(), positions = new Map();
  for (const p of players.values()) { if (p.pfr_id) pfrToGsis.set(p.pfr_id, p.gsis); if (p.pos_group) positions.set(p.gsis, p.pos_group); }
  const gm = await loadGames(opts); sources.push(gm.source); if (gm.source.error) gaps.push({ source: 'games', error: gm.source.error });
  const games = gm.games;
  const playerGames = [], teamGames = new Map(), depth = new Map(), injuries = new Map(), roster = new Map();
  const pools = { rec: {}, rush_rb: [], rush_qb_designed: [], scramble: [], rush_wr: [] };
  for (const season of seasons) {
    const st = await loadStats(season, opts); sources.push(st.source); if (st.source.error) gaps.push({ source: 'stats_' + season, error: st.source.error });
    st.rows.forEach((r) => { if (!positions.has(r.gsis)) positions.set(r.gsis, r.pos); });
    const sn = await loadSnaps(season, opts, pfrToGsis); sources.push(sn.source); if (sn.source.error) gaps.push({ source: 'snaps_' + season, error: sn.source.error });
    const pb = opts.pbp === false ? { pg: new Map(), tg: new Map(), pools: null, source: { url: 'skipped' } } : await loadPbp(season, opts, positions, games);
    sources.push(pb.source); if (pb.source.error) gaps.push({ source: 'pbp_' + season, error: pb.source.error });
    if (pb.pools) { Object.keys(pb.pools.rec).forEach((k) => { pools.rec[k] = (pools.rec[k] || []).concat(pb.pools.rec[k]); }); ['rush_rb', 'rush_qb_designed', 'scramble', 'rush_wr'].forEach((k) => { pools[k] = pools[k].concat(pb.pools[k]); }); }
    st.rows.forEach((r) => {
      const sn1 = sn.snaps.get(r.game_id + '|' + r.gsis);
      const f = pb.pg.get(r.game_id + '|' + r.gsis) || null;
      const g = games.get(r.game_id);
      playerGames.push(Object.assign({}, r, { kickoff: g ? g.kickoff : null, home: g ? g.home === r.team : null,
        snaps: sn1 ? sn1.snaps : null, snap_pct: sn1 ? sn1.snap_pct : null,
        rz_tgt: f ? f.rz_tgt : null, rz_car: f ? f.rz_car : null, gl_car: f ? f.gl_car : null, ez_tgt: f ? f.ez_tgt : null, third_tgt: f ? f.third_tgt : null, neutral_tgt: f ? f.neutral_tgt : null,
        scr: f ? f.scr : null, scr_yds: f ? f.scr_yds : null, des: f ? f.des : null, des_yds: f ? f.des_yds : null,
        long_rec: f ? f.long_rec : null, long_rush: f ? f.long_rush : null, long_cmp: f ? f.long_cmp : null }));
    });
    for (const [k, t] of pb.tg) {
      const [gid, team] = k.split('|');
      const g = games.get(gid);
      teamGames.set(k, Object.assign({ game_id: gid, team, season, week: g ? g.week : null, kickoff: g ? g.kickoff : null, opp: g ? (g.home === team ? g.away : g.home) : null, home: g ? g.home === team : null,
        pts_final: g ? (g.home === team ? g.home_score : g.away_score) : null, opp_pts_final: g ? (g.home === team ? g.away_score : g.home_score) : null }, t));
    }
    const dp = await loadDepth(season, opts); sources.push(dp.source); if (dp.source.error) gaps.push({ source: 'depth_' + season, error: dp.source.error });
    for (const [team, list] of dp.depth) depth.set(team, (depth.get(team) || []).concat(list).sort((a, b) => a.dt - b.dt));
    const inj = await loadInjuries(season, opts); sources.push(inj.source); if (inj.source.error) gaps.push({ source: 'injuries_' + season, error: inj.source.error });
    for (const [k, v] of inj.injuries) injuries.set(k, v);
    if (opts.roster !== false) {
      const rw = await loadRosterWeekly(season, opts); sources.push(rw.source); if (rw.source.error) gaps.push({ source: 'roster_' + season, error: rw.source.error });
      for (const [k, v] of rw.roster) roster.set(k, v);
    }
  }
  return { league: 'NFL', seasons, players, games, playerGames, teamGames, depth, injuries, roster, pools, positions, sources, gaps, load_ms: Date.now() - t0 };
}

module.exports = { load, depthAsOf, poolsAsOf, etToUtc, normTeam, posGroup };
