/* ===========================================================================
   PLAYER PROPS — the CFB dataset, in the SAME shape as nfl_data.js, keyed
   by the ESPN athlete id. docs/player-props/CFB.md

   Sources (public, keyless): cfbfastR-data per-play player stats (every
   play's participants with their ESPN athlete ids), schedules and rosters;
   EdgeDesk's own official-availability report ledger
   (football/availability/reports.bundle.json, each report with its
   published_at).

   WHAT CFB DOES NOT HAVE, SAID PLAINLY
     - snap counts and route participation: none published. Shares are of
       targets and carries only; the opportunity panel says so.
     - a provider depth chart: roles come from usage order in recent games.
     - scramble vs designed-run split: every QB rush is a rush.
     - complete injury reporting: official reports exist for some
       conferences' conference games only. A player on no report is
       UNKNOWN, never "healthy", and reliability pays for it.
   The field named `gsis` in the dataset rows is the league's ANCHOR id
   (here: the ESPN athlete id) so model.js reads both leagues unchanged.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const S = require('./sources.js');
const { n, s } = S;

function fold(x) { return String(x == null ? '' : x).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
/* the FBS team key every EdgeDesk CFB artifact uses (football/players/epir.js teamKey) */
function teamKey(x) { if (x == null) return null; return fold(x).toLowerCase().replace(/[^a-z0-9]/g, '') || null; }
function posGroup(p) { const x = String(p || '').toUpperCase(); if (x === 'HB' || x === 'FB' || x === 'TB') return 'RB'; if (x === 'SB' || x === 'FL') return 'WR'; return x; }
const SKILL = { QB: 1, RB: 1, WR: 1, TE: 1 };

async function loadRosters(season, opts, players, positions) {
  const url = S.CFB.rosters(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 720 : opts.maxAgeMin, offline: opts.offline });
  if (!f.file) return { source: { url, error: f.error } };
  await S.readCsv(f.file, ['athlete_id', 'first_name', 'last_name', 'team', 'position', 'jersey', 'year', 'headshot_url', 'season'], (r) => {
    const id = s(r.athlete_id); if (!id) return;
    const pos = posGroup(r.position);
    const prev = players.get(id);
    const rec = { gsis: id, name: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' '), pos_group: pos, position: s(r.position), espn_id: id, team: teamKey(r.team), team_name: s(r.team), jersey: s(r.jersey), class_year: n(r.year), headshot: s(r.headshot_url), season: n(r.season) };
    if (!prev || (prev.season || 0) <= rec.season) players.set(id, rec);
    if (SKILL[pos]) positions.set(id, pos);
  });
  return { source: { url, bytes: f.bytes, error: f.error } };
}
async function loadSchedule(season, opts, games) {
  const url = S.CFB.schedules(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 60 : opts.maxAgeMin, offline: opts.offline });
  if (!f.file) return { source: { url, error: f.error } };
  await S.readCsv(f.file, ['game_id', 'season', 'week', 'season_type', 'start_date', 'neutral_site', 'home_team', 'home_division', 'home_points', 'away_team', 'away_division', 'away_points', 'completed'], (r) => {
    games.set(s(r.game_id), { game_id: s(r.game_id), season: n(r.season), week: n(r.week), game_type: r.season_type === 'postseason' ? 'POST' : 'REG', kickoff: s(r.start_date) ? new Date(Date.parse(r.start_date)).toISOString() : null,
      home: teamKey(r.home_team), away: teamKey(r.away_team), home_name: s(r.home_team), away_name: s(r.away_team), home_division: s(r.home_division), away_division: s(r.away_division),
      home_score: r.completed === 'TRUE' ? n(r.home_points) : null, away_score: r.completed === 'TRUE' ? n(r.away_points) : null, neutral: r.neutral_site === 'TRUE', roof: null, wind: null });
  });
  return { source: { url, bytes: f.bytes, error: f.error } };
}

/* per-play participants → player-game and team-game rows + gain pools */
async function loadPlays(season, opts, games, positions, pg, tg, pools) {
  const url = S.CFB.plays(season);
  const f = await S.fetchToCache(url, { maxAgeMin: opts.maxAgeMin == null ? 120 : opts.maxAgeMin, offline: opts.offline });
  if (!f.file) return { source: { url, error: f.error } };
  const cols = ['game_id', 'week', 'team', 'opponent', 'team_score', 'opponent_score', 'play_id', 'period', 'yards_to_goal', 'down',
    'reception_player_id', 'reception_yds', 'completion_player_id', 'completion_yds', 'rush_player_id', 'rush_yds', 'interception_thrown_player_id',
    'touchdown_player_id', 'incompletion_player_id', 'target_player_id', 'sack_taken_player_id'];
  function P(game, id, team) { const k = game + '|' + id; let o = pg.get(k); if (!o) { o = { gsis: id, game_id: game, team, cmp: 0, att: 0, pass_yds: 0, pass_td: 0, int: 0, sacks: 0, pass_air: 0, car: 0, rush_yds: 0, rush_td: 0, rec: 0, tgt: 0, rec_yds: 0, rec_td: 0, rec_air: 0, yac: 0,
    rz_tgt: 0, rz_car: 0, gl_car: 0, ez_tgt: 0, third_tgt: 0, neutral_tgt: 0, scr: 0, scr_yds: 0, des: 0, des_yds: 0, long_rec: null, long_rush: null, long_cmp: null }; pg.set(k, o); } return o; }
  function T(game, team) { const k = game + '|' + team; let o = tg.get(k); if (!o) { o = { game_id: game, team, plays: 0, dropbacks: 0, att: 0, sacks: 0, scrambles: 0, designed: 0, neutral_plays: 0, neutral_db: 0, rz_plays: 0, rz_db: 0, rz_designed: 0, rz_targets: 0, third_targets: 0, targets: 0, pass_yds: 0, rush_yds: 0, pass_td: 0, rush_td: 0, int: 0, cmp: 0 }; tg.set(k, o); } return o; }
  /* ONE PLAY, SEVERAL ROWS: the file writes a completion and its reception
     (and the target, the touchdown …) on separate rows of the same play_id.
     Rows are merged per play — the union of their non-empty fields — and
     only then scored. */
  let cur = null;
  const flush = () => { if (cur) scorePlay(cur); cur = null; };
  await S.readCsv(f.file, cols, (r) => {
    const pk = s(r.game_id) + '|' + s(r.play_id);
    if (cur && cur._k !== pk) flush();
    if (!cur) { cur = Object.assign({ _k: pk }, r); return; }
    Object.keys(r).forEach((k) => { if (s(cur[k]) == null && s(r[k]) != null) cur[k] = r[k]; });
  });
  flush();
  function scorePlay(r) {
    const game = s(r.game_id), team = teamKey(r.team);
    if (!game || !team) return;
    const g = games.get(game);
    const kt = g && g.kickoff ? Date.parse(g.kickoff) : null;
    const t = T(game, team);
    const y100 = n(r.yards_to_goal), down = n(r.down), per = n(r.period);
    const diff = (n(r.team_score) || 0) - (n(r.opponent_score) || 0);
    const neutral = per != null && per <= 3 && Math.abs(diff) <= 14;
    const rz = y100 != null && y100 <= 20;
    const qb = s(r.completion_player_id) || s(r.incompletion_player_id) || s(r.interception_thrown_player_id);
    const sack = s(r.sack_taken_player_id);
    const rush = s(r.rush_player_id);
    const td = s(r.touchdown_player_id);
    if (qb || sack) {
      t.plays++; t.dropbacks++;
      if (neutral) { t.neutral_plays++; t.neutral_db++; }
      if (rz) { t.rz_plays++; t.rz_db++; }
      if (sack) { t.sacks++; P(game, sack, team).sacks++; }
      if (qb) {
        t.att++;
        const q = P(game, qb, team);
        q.att++;
        const tgt = s(r.target_player_id) || s(r.reception_player_id);
        if (s(r.interception_thrown_player_id)) { q.int++; t.int++; }
        if (tgt) {
          t.targets++; if (rz) t.rz_targets++; if (down === 3) t.third_targets++;
          const o = P(game, tgt, team);
          o.tgt++; if (rz) o.rz_tgt++; if (y100 != null && y100 <= 10) o.ez_tgt++; if (down === 3) o.third_tgt++; if (neutral) o.neutral_tgt++;
        }
        const rec = s(r.reception_player_id);
        if (rec && s(r.completion_player_id)) {
          const yds = n(r.reception_yds) != null ? n(r.reception_yds) : (n(r.completion_yds) || 0);
          const o = P(game, rec, team);
          o.rec++; o.rec_yds += yds; if (o.long_rec == null || yds > o.long_rec) o.long_rec = yds;
          q.cmp++; q.pass_yds += yds; if (q.long_cmp == null || yds > q.long_cmp) q.long_cmp = yds;
          t.cmp++; t.pass_yds += yds;
          if (td && td === rec) { o.rec_td++; q.pass_td++; t.pass_td++; }
          const pos = positions.get(rec);
          if (pos === 'WR' || pos === 'TE' || pos === 'RB') (pools.rec[pos] = pools.rec[pos] || []).push([kt, yds]);
        }
      }
    } else if (rush) {
      t.plays++; t.designed++;
      if (neutral) t.neutral_plays++;
      if (rz) { t.rz_plays++; t.rz_designed++; }
      const yds = n(r.rush_yds) || 0;
      const o = P(game, rush, team);
      o.car++; o.rush_yds += yds; o.des++; o.des_yds += yds;
      if (rz) o.rz_car++; if (y100 != null && y100 <= 5) o.gl_car++;
      if (o.long_rush == null || yds > o.long_rush) o.long_rush = yds;
      t.rush_yds += yds;
      if (td && td === rush) { o.rush_td++; t.rush_td++; }
      const pos = positions.get(rush);
      if (pos === 'RB') pools.rush_rb.push([kt, yds]); else if (pos === 'QB') pools.rush_qb_designed.push([kt, yds]); else if (pos === 'WR') pools.rush_wr.push([kt, yds]);
    }
  }
  return { source: { url, bytes: f.bytes, error: f.error } };
}

/* the official conference reports EdgeDesk has ingested, as pregame
   designations keyed season|week|team (a report's rows carry ESPN ids) */
function loadReports(games) {
  const out = new Map();
  let b = null;
  try { b = JSON.parse(fs.readFileSync(path.join(S.ROOT, 'football', 'availability', 'reports.bundle.json'), 'utf8')); } catch (_) { return { injuries: out, n: 0 }; }
  let nRows = 0;
  (b.reports || []).forEach((rep) => {
    const g = games.get(String(rep.game_id));
    if (!g || !rep.ok) return;
    const team = teamKey(rep.team);
    const side = g.home === team ? team : (g.away === team ? team : null);
    if (!side) return;
    const k = g.season + '|' + g.week + '|' + side;
    if (!out.has(k)) out.set(k, new Map());
    (rep.rows || []).forEach((row) => {
      if (!row.player_id) return;
      const st = String(row.status || '').toUpperCase();
      out.get(k).set(String(row.player_id), { status: st === 'OUT' || st === 'OUT_FIRST_HALF' ? (st === 'OUT' ? 'Out' : 'Questionable') : (st === 'QUESTIONABLE' ? 'Questionable' : (st === 'DOUBTFUL' ? 'Doubtful' : null)), practice: null, injury: null, name: row.player_name, position: row.position, published_at: rep.published_at, source_url: rep.source_url });
      nRows++;
    });
  });
  return { injuries: out, n: nRows, reports: (b.reports || []).length };
}

async function load(opts) {
  opts = opts || {};
  const seasons = opts.seasons || [2025, 2026];
  const t0 = Date.now();
  const players = new Map(), positions = new Map(), games = new Map(), pgMap = new Map(), tg = new Map();
  const pools = { rec: {}, rush_rb: [], rush_qb_designed: [], scramble: [], rush_wr: [] };
  const sources = [], gaps = [];
  for (const season of seasons) {
    const ro = await loadRosters(season, opts, players, positions); sources.push(ro.source); if (ro.source.error) gaps.push({ source: 'cfb_rosters_' + season, error: ro.source.error });
    const sc = await loadSchedule(season, opts, games); sources.push(sc.source); if (sc.source.error) gaps.push({ source: 'cfb_schedules_' + season, error: sc.source.error });
  }
  for (const season of seasons) {
    const pl = await loadPlays(season, opts, games, positions, pgMap, tg, pools); sources.push(pl.source); if (pl.source.error) gaps.push({ source: 'cfb_plays_' + season, error: pl.source.error });
  }
  const playerGames = [];
  for (const o of pgMap.values()) {
    const g = games.get(o.game_id);
    if (!g) continue;
    const pos = positions.get(o.gsis) || (o.att > 2 ? 'QB' : null);
    if (!SKILL[pos]) continue;
    const pl = players.get(o.gsis);
    playerGames.push(Object.assign(o, { name: pl ? pl.name : null, pos, season: g.season, week: g.week, season_type: g.game_type, opp: g.home === o.team ? g.away : g.home, kickoff: g.kickoff, home: g.home === o.team, snaps: null, snap_pct: null }));
  }
  const teamGames = new Map();
  for (const [k, t] of tg) {
    const g = games.get(t.game_id);
    if (!g) continue;
    const home = g.home === t.team;
    teamGames.set(k, Object.assign(t, { season: g.season, week: g.week, kickoff: g.kickoff, opp: home ? g.away : g.home, home, pts_final: home ? g.home_score : g.away_score, opp_pts_final: home ? g.away_score : g.home_score, pts: home ? g.home_score : g.away_score, opp_pts: home ? g.away_score : g.home_score }));
  }
  /* SOURCE FAULTS: a team-game with pass attempts but no recorded
     completion is missing its reception rows at the source. It is excluded
     (team and player rows alike) and named, never used as a real game. */
  const faults = [...teamGames.values()].filter((t) => t.att > 10 && t.cmp === 0).map((t) => t.game_id + '|' + t.team);
  const faultSet = new Set(faults);
  faults.forEach((k) => teamGames.delete(k));
  for (let i = playerGames.length - 1; i >= 0; i--) if (faultSet.has(playerGames[i].game_id + '|' + playerGames[i].team)) playerGames.splice(i, 1);
  if (faults.length) gaps.push({ source: 'cfb_plays', error: faults.length + ' team-game(s) excluded: pass attempts with no recorded completions at the source', items: faults });
  const rep = loadReports(games);
  sources.push({ url: 'football/availability/reports.bundle.json', rows: rep.n, reports: rep.reports });
  if (!rep.n) gaps.push({ source: 'cfb_availability_reports', error: 'no official availability rows on file' });
  gaps.push({ source: 'cfb_snaps', error: 'no snap or route participation is published for college football' }, { source: 'cfb_depth_chart', error: 'no provider depth chart (roles come from usage order)' });
  return { league: 'CFB', seasons, players, games, playerGames, teamGames, depth: new Map(), injuries: rep.injuries, roster: null, pools, positions, sources, gaps, load_ms: Date.now() - t0 };
}

module.exports = { load, teamKey, posGroup };
