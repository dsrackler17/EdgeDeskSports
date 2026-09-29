/* ===========================================================================
   EdgeDesk player props — NFL source adapter (nflverse, CC BY 4.0).

   One season in, canonical rows out:
     games        dim_game rows      (schedules/games.csv; kickoff ET → UTC by
                                      the same etToIso the NFL slate uses)
     playerGames  fact_player_game   (stats_player_week_<y>.csv: the box, plus
                                      play-by-play aggregates for longest plays,
                                      red-zone / goal-line work, dropbacks,
                                      scrambles and designed runs; snap counts;
                                      the final injury-report status)
     teamGames    fact_team_game     (play-by-play: pace, neutral pass rate,
                                      PROE, and the defensive rates each
                                      opponent allowed)
   Plus the whole-history identity files (players.csv, draft_picks.csv).

   NOTHING HERE IS IMPUTED. A column the source does not carry for a season
   (snaps before 2012, cpoe before the model existed) is null, and the season's
   coverage block says which columns were present.
   =========================================================================== */
'use strict';
const path = require('path');
const io = require('../lib/io.js');
const { etToIso } = require('../../../../tools/football/build_nfl_slate.js');

const NFLV = process.env.EDGEDESK_NFLVERSE_RELEASES || 'https://github.com/nflverse/nflverse-data/releases/download';
const URL = {
  schedule: NFLV + '/schedules/games.csv',
  players: NFLV + '/players/players.csv',
  draft: NFLV + '/draft_picks/draft_picks.csv',
  weekly: (y) => NFLV + '/stats_player/stats_player_week_' + y + '.csv',
  pbp: (y) => NFLV + '/pbp/play_by_play_' + y + '.csv.gz',
  snaps: (y) => NFLV + '/snap_counts/snap_counts_' + y + '.csv',
  injuries: (y) => NFLV + '/injuries/injuries_' + y + '.csv'
};
const PROVIDER = 'nflverse';
/* nflverse spells the Rams LA; every other feed's alias folds onto its code */
const CODE_ALIAS = { LAR: 'LA', SD: 'LAC', OAK: 'LV', STL: 'LA', WSH: 'WAS', JAC: 'JAX' };
function code(t) { const c = String(t || '').trim().toUpperCase(); return CODE_ALIAS[c] || c || null; }
const SKILL = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', K: 'K', P: 'P' };
function posGroup(p) { const s = String(p || '').toUpperCase(); return SKILL[s] || (s ? 'OTHER' : null); }

async function get(url, name, opts) { return io.fetchCached(url, 'nflverse', name, opts); }

/* ------------------------------------------------------------ schedule */
function roofOf(r) { const s = String(r || '').toLowerCase(); return s === 'dome' || s === 'closed' ? 'closed' : s === 'outdoors' ? 'open' : s === 'open' ? 'retractable_open' : (s || null); }
async function loadSchedule(opts) {
  const f = await get(URL.schedule, 'games.csv', opts);
  if (!f) throw new Error('nflverse schedule unavailable');
  const rows = await io.loadCsv(f.file);
  return rows.map((g) => {
    const kick = etToIso(g.gameday, g.gametime);
    const st = g.game_type === 'REG' ? 'regular' : (g.game_type ? 'postseason' : null);
    return {
      game_id: g.game_id, league: 'NFL', source_game_id: g.game_id, espn_event_id: io.str(g.espn),
      season: io.int(g.season), week: io.int(g.week), season_type: st, game_type: g.game_type,
      kickoff_utc: kick, home_team_id: code(g.home_team), away_team_id: code(g.away_team),
      venue_id: io.str(g.stadium_id), venue_name: io.str(g.stadium), surface: io.str(g.surface), roof: roofOf(g.roof),
      neutral_site: g.location === 'Neutral',
      home_score: io.num(g.home_score), away_score: io.num(g.away_score),
      status: io.num(g.home_score) != null && io.num(g.away_score) != null ? 'final' : 'scheduled',
      weather_temp_f: io.num(g.temp), weather_wind_mph: io.num(g.wind),
      home_rest: io.int(g.home_rest), away_rest: io.int(g.away_rest),
      home_qb_id: io.str(g.home_qb_id), away_qb_id: io.str(g.away_qb_id), div_game: g.div_game === '1',
      source_provider: PROVIDER
    };
  }).filter((g) => g.game_id && g.kickoff_utc);
}

/* ------------------------------------------------------------ identity files */
async function loadPlayers(opts) {
  const f = await get(URL.players, 'players.csv', opts);
  if (!f) throw new Error('nflverse players unavailable');
  return (await io.loadCsv(f.file)).map((p) => ({
    gsis_id: io.str(p.gsis_id), display_name: io.str(p.display_name), first_name: io.str(p.first_name), last_name: io.str(p.last_name),
    suffix: io.str(p.suffix), espn_id: io.str(p.espn_id), pfr_id: io.str(p.pfr_id), birth_date: io.str(p.birth_date),
    position: io.str(p.position), position_group: io.str(p.position_group), college: io.str(p.college_name),
    rookie_season: io.int(p.rookie_season), last_season: io.int(p.last_season), latest_team: code(p.latest_team),
    draft_year: io.int(p.draft_year), draft_round: io.int(p.draft_round), draft_pick: io.int(p.draft_pick), draft_team: code(p.draft_team),
    years_of_experience: io.int(p.years_of_experience), status: io.str(p.status), headshot: io.str(p.headshot)
  })).filter((p) => p.gsis_id);
}
async function loadDraft(opts) {
  const f = await get(URL.draft, 'draft_picks.csv', opts);
  if (!f) return [];
  return (await io.loadCsv(f.file)).map((d) => ({ season: io.int(d.season), round: io.int(d.round), pick: io.int(d.pick), team: code(d.team),
    gsis_id: io.str(d.gsis_id), pfr_id: io.str(d.pfr_player_id), cfb_ref_id: io.str(d.cfb_player_id), name: io.str(d.pfr_player_name),
    position: io.str(d.position), college: io.str(d.college) }));
}

/* ------------------------------------------------------------ one season */
const PBP_COLS = ['game_id', 'season_type', 'posteam', 'defteam', 'yardline_100', 'play_type', 'yards_gained', 'qb_dropback', 'qb_scramble', 'qb_kneel', 'qb_spike',
  'air_yards', 'yards_after_catch', 'pass_attempt', 'rush_attempt', 'sack', 'qb_hit', 'complete_pass', 'interception', 'touchdown', 'pass_touchdown', 'rush_touchdown',
  'two_point_attempt', 'passer_player_id', 'receiver_player_id', 'rusher_player_id', 'td_player_id', 'epa', 'cpoe', 'wp', 'down', 'half_seconds_remaining',
  'game_seconds_remaining', 'drive', 'xpass', 'pass_oe', 'score_differential', 'penalty', 'aborted_play', 'play_deleted'];

function blankTeam(game_id, team, opp) {
  return { game_id, team_id: team, opponent_id: opp, plays: 0, dropbacks: 0, pass_attempts: 0, rushes: 0, sacks: 0, qb_hits: 0, scrambles: 0,
    neutral_plays: 0, neutral_dropbacks: 0, proe_sum: 0, proe_n: 0, epa_sum: 0, epa_n: 0, pass_epa_sum: 0, rush_epa_sum: 0,
    pass_yards: 0, rush_yards: 0, completions: 0, air_yards: 0, explosive_pass: 0, explosive_rush: 0, rz_plays: 0, gl_plays: 0,
    tgt_rb: 0, tgt_wr: 0, tgt_te: 0, recyds_rb: 0, recyds_wr: 0, recyds_te: 0, rec_rb: 0, rec_wr: 0, rec_te: 0,
    _secs: 0, _secs_n: 0, _last: null };
}
function blankPbpPlayer() {
  return { longest_completion: null, longest_rush: null, longest_reception: null, red_zone_touches: 0, goal_line_touches: 0, rz_targets: 0, rz_carries: 0, gl_carries: 0,
    dropbacks: 0, scrambles: 0, designed_rushes: 0, explosive_rec: 0, explosive_rush: 0, sacks_taken: 0, pbp_targets: 0 };
}
function maxOf(a, b) { return a == null ? b : (b == null ? a : Math.max(a, b)); }

async function loadSeason(season, opts) {
  opts = opts || {};
  const schedule = opts.schedule || await loadSchedule(opts);
  const games = schedule.filter((g) => g.season === season);
  const gameById = new Map(games.map((g) => [g.game_id, g]));
  const coverage = { season, weekly: false, pbp: false, snaps: false, injuries: false, notes: [] };

  /* 1. the weekly box: one row per player per game */
  const wf = await get(URL.weekly(season), 'stats_player_week_' + season + '.csv', opts);
  const players = new Map();                                    /* game|gsis -> row */
  const positions = new Map();                                  /* gsis -> position */
  if (wf) {
    coverage.weekly = true;
    await io.readCsv(wf.file, (r) => {
      const gid = r.game_id || null;
      if (!gid || !gameById.has(gid)) return;
      const g = gameById.get(gid);
      const pos = io.str(r.position);
      const team = code(r.team), opp = code(r.opponent_team);
      positions.set(r.player_id, pos);
      players.set(gid + '|' + r.player_id, {
        game_id: gid, source_player_id: r.player_id, player_name: io.str(r.player_display_name) || io.str(r.player_name), team_id: team, opponent_id: opp,
        position: pos, position_group: posGroup(pos), season, week: io.int(r.week), kickoff_utc: g.kickoff_utc, is_home: team === g.home_team_id,
        attempts: io.int(r.attempts), completions: io.int(r.completions), passing_yards: io.num(r.passing_yards), passing_tds: io.int(r.passing_tds),
        interceptions: io.int(r.passing_interceptions != null ? r.passing_interceptions : r.interceptions), sacks_taken: io.int(r.sacks_suffered != null ? r.sacks_suffered : r.sacks),
        passing_air_yards: io.num(r.passing_air_yards), passing_epa: io.num(r.passing_epa), passing_cpoe: io.num(r.passing_cpoe),
        carries: io.int(r.carries), rushing_yards: io.num(r.rushing_yards), rushing_tds: io.int(r.rushing_tds), rushing_epa: io.num(r.rushing_epa),
        targets: io.int(r.targets), receptions: io.int(r.receptions), receiving_yards: io.num(r.receiving_yards), receiving_tds: io.int(r.receiving_tds),
        air_yards: io.num(r.receiving_air_yards), yac: io.num(r.receiving_yards_after_catch), receiving_epa: io.num(r.receiving_epa),
        target_share: io.num(r.target_share), air_yard_share: io.num(r.air_yards_share),
        fumbles_lost: (io.int(r.rushing_fumbles_lost) || 0) + (io.int(r.receiving_fumbles_lost) || 0) + (io.int(r.sack_fumbles_lost) || 0),
        special_teams_tds: io.int(r.special_teams_tds),
        fg_made: io.int(r.fg_made), fg_att: io.int(r.fg_att), pat_made: io.int(r.pat_made),
        def_interceptions: io.int(r.def_interceptions), def_sacks: io.num(r.def_sacks),
        def_tackles_assists: (io.int(r.def_tackles_solo) || 0) + (io.int(r.def_tackle_assists) || 0) + (io.int(r.def_tackles_with_assist) || 0) || null,
        snaps: null, snap_share: null, routes: null, active_status: 'active', starter: null, injury_status: null,
        source_provider: PROVIDER, source_updated_at: null, source_quality: 1
      });
    });
  } else coverage.notes.push('no weekly player stats for ' + season);

  /* 2. play-by-play aggregates */
  const pf = await get(URL.pbp(season), 'play_by_play_' + season + '.csv.gz', opts);
  const pbpP = new Map();                                       /* game|gsis -> aggregates */
  const teams = new Map();                                      /* game|team -> team aggregates */
  function P(gid, id) { const k = gid + '|' + id; let x = pbpP.get(k); if (!x) { x = blankPbpPlayer(); pbpP.set(k, x); } return x; }
  function T(gid, team, opp) { const k = gid + '|' + team; let x = teams.get(k); if (!x) { x = blankTeam(gid, team, opp); teams.set(k, x); } return x; }
  if (pf) {
    coverage.pbp = true;
    await io.readCsv(pf.file, (r) => {
      const gid = r.game_id;
      if (!gameById.has(gid) || r.play_deleted === '1' || r.aborted_play === '1') return;
      const off = code(r.posteam), def = code(r.defteam);
      if (!off || !def) return;
      const pt = r.play_type;
      if (pt !== 'pass' && pt !== 'run' && pt !== 'qb_kneel' && pt !== 'qb_spike') return;
      if (r.two_point_attempt === '1') return;
      const t = T(gid, off, def);
      const yl = io.num(r.yardline_100), yds = io.num(r.yards_gained), epa = io.num(r.epa);
      const isPass = r.pass_attempt === '1' || r.qb_dropback === '1' || r.sack === '1';
      const isRush = r.rush_attempt === '1' && r.qb_scramble !== '1' && pt === 'run';
      const scramble = r.qb_scramble === '1';
      if (pt === 'qb_kneel' || pt === 'qb_spike') return;
      t.plays++;
      /* pace: seconds between consecutive snaps inside the same drive */
      const gs = io.num(r.game_seconds_remaining), dr = r.drive;
      if (t._last && t._last.drive === dr && gs != null && t._last.gs != null) { const d = t._last.gs - gs; if (d > 0 && d < 60) { t._secs += d; t._secs_n++; } }
      t._last = { drive: dr, gs };
      if (isPass) { t.dropbacks++; if (r.pass_attempt === '1' && r.sack !== '1') t.pass_attempts++; }
      if (isRush) t.rushes++;
      if (r.sack === '1') t.sacks++;
      if (r.qb_hit === '1') t.qb_hits++;
      if (scramble) t.scrambles++;
      if (epa != null) { t.epa_sum += epa; t.epa_n++; if (isPass) t.pass_epa_sum += epa; else t.rush_epa_sum += epa; }
      if (yl != null && yl <= 20) t.rz_plays++;
      if (yl != null && yl <= 5) t.gl_plays++;
      /* neutral situation: downs 1-2, win probability 20-80%, not the last two minutes of a half */
      const wp = io.num(r.wp), dn = io.int(r.down), hs = io.num(r.half_seconds_remaining);
      if (wp != null && wp >= 0.2 && wp <= 0.8 && (dn === 1 || dn === 2) && (hs == null || hs > 120)) { t.neutral_plays++; if (isPass) t.neutral_dropbacks++; }
      const poe = io.num(r.pass_oe);
      if (poe != null) { t.proe_sum += poe; t.proe_n++; }
      if (r.complete_pass === '1') { t.completions++; t.pass_yards += yds || 0; t.air_yards += io.num(r.air_yards) || 0; if ((yds || 0) >= 20) t.explosive_pass++; }
      if (pt === 'run' && r.rush_attempt === '1') { t.rush_yards += yds || 0; if ((yds || 0) >= 12) t.explosive_rush++; }
      /* players */
      const passer = r.passer_player_id, rec = r.receiver_player_id, rush = r.rusher_player_id;
      if (passer && isPass) {
        const p = P(gid, passer);
        p.dropbacks++;
        if (r.sack === '1') p.sacks_taken++;
        if (r.complete_pass === '1' && yds != null) p.longest_completion = maxOf(p.longest_completion, yds);
      }
      if (rec && r.pass_attempt === '1' && r.sack !== '1') {
        const p = P(gid, rec);
        p.pbp_targets++;
        if (yl != null && yl <= 20) { p.red_zone_touches++; p.rz_targets++; }
        if (yl != null && yl <= 5) p.goal_line_touches++;
        if (r.complete_pass === '1' && yds != null) { p.longest_reception = maxOf(p.longest_reception, yds); if (yds >= 20) p.explosive_rec++; }
        /* what the defence allowed, by the receiver's position */
        const rp = posGroup(positions.get(rec));
        const key = rp === 'RB' ? 'rb' : rp === 'TE' ? 'te' : rp === 'WR' ? 'wr' : null;
        if (key) { t['tgt_' + key]++; if (r.complete_pass === '1') { t['rec_' + key]++; t['recyds_' + key] += yds || 0; } }
      }
      if (rush && pt === 'run' && r.rush_attempt === '1') {
        const p = P(gid, rush);
        if (yds != null) p.longest_rush = maxOf(p.longest_rush, yds);
        if (scramble) p.scrambles++; else p.designed_rushes++;
        if (yl != null && yl <= 20) { p.red_zone_touches++; p.rz_carries++; }
        if (yl != null && yl <= 5) { p.goal_line_touches++; p.gl_carries++; }
        if ((yds || 0) >= 12) p.explosive_rush++;
      }
    }, { columns: PBP_COLS });
  } else coverage.notes.push('no play-by-play for ' + season);

  /* 3. snaps (2012+), keyed by pfr id → gsis via players.csv */
  const sf = season >= 2012 ? await get(URL.snaps(season), 'snap_counts_' + season + '.csv', opts) : null;
  const snapByPfr = new Map();
  const snapRows = [];
  if (sf) {
    coverage.snaps = true;
    await io.readCsv(sf.file, (r) => {
      if (!r.pfr_player_id || !r.game_id) return;
      const v = { snaps: io.int(r.offense_snaps), pct: io.num(r.offense_pct) };
      snapByPfr.set(r.game_id + '|' + r.pfr_player_id, v);
      snapRows.push({ game_id: r.game_id, pfr: r.pfr_player_id, name: io.str(r.player), position: io.str(r.position), team: code(r.team), opp: code(r.opponent), snaps: v.snaps, pct: v.pct });
    });
  } else coverage.notes.push('no snap counts for ' + season + (season < 2012 ? ' (nflverse snap counts begin in 2012)' : ''));

  /* 4. the final injury report (a pregame fact: designations are final before kickoff) */
  const inf = await get(URL.injuries(season), 'injuries_' + season + '.csv', opts);
  const injury = new Map();                                     /* season|week|team|gsis -> status */
  if (inf) {
    coverage.injuries = true;
    await io.readCsv(inf.file, (r) => { const st = io.str(r.report_status); if (!st || !r.gsis_id) return; injury.set([io.int(r.week), code(r.team), r.gsis_id].join('|'), { status: st, injury: io.str(r.report_primary_injury), position: io.str(r.position), name: io.str(r.full_name) }); });
  } else coverage.notes.push('no injury report for ' + season);

  const pfrOf = opts.pfrByGsis || new Map();
  const playerGames = [];
  players.forEach((row, k) => {
    const agg = pbpP.get(k);
    if (agg) {
      row.longest_completion = agg.longest_completion; row.longest_rush = agg.longest_rush; row.longest_reception = agg.longest_reception;
      row.red_zone_touches = agg.red_zone_touches; row.goal_line_touches = agg.goal_line_touches; row.rz_targets = agg.rz_targets; row.rz_carries = agg.rz_carries;
      row.gl_carries = agg.gl_carries; row.dropbacks = agg.dropbacks; row.scrambles = agg.scrambles; row.designed_rushes = agg.designed_rushes;
      row.explosive_rec = agg.explosive_rec; row.explosive_rush = agg.explosive_rush;
    } else if (coverage.pbp) {
      /* the player is in the box but touched no qualifying play: zeros are measurements here */
      row.red_zone_touches = 0; row.goal_line_touches = 0; row.rz_targets = 0; row.rz_carries = 0; row.gl_carries = 0; row.dropbacks = 0; row.scrambles = 0;
      row.designed_rushes = 0; row.explosive_rec = 0; row.explosive_rush = 0;
    }
    /* a longest-play stat with no play of that kind is absent, not zero */
    if (row.longest_reception == null && (row.receptions || 0) > 0 && coverage.pbp) row.source_quality = Math.min(row.source_quality, 0.9);
    const pfr = pfrOf.get(row.source_player_id);
    const sn = pfr ? snapByPfr.get(row.game_id + '|' + pfr) : null;
    if (sn) { row.snaps = sn.snaps; row.snap_share = sn.pct; }
    const inj = injury.get([row.week, row.team_id, row.source_player_id].join('|'));
    row.injury_status = inj ? inj.status : null;
    playerGames.push(row);
  });

  /* ZERO-FILL. A skill player who took offensive snaps and recorded no stat is
     missing from the weekly box. Dropping him would teach every model that a
     game with zero receptions never happens. With snap counts (2012+) he is
     added back with MEASURED zeros (not imputed): he played, nothing came. */
  const gsisByPfr = new Map(); pfrOf.forEach((pfr, gsis) => gsisByPfr.set(pfr, gsis));
  let zeroFilled = 0;
  snapRows.forEach((sr) => {
    const pg = posGroup(sr.position);
    if (!(pg === 'QB' || pg === 'RB' || pg === 'WR' || pg === 'TE') || !(sr.snaps > 0)) return;
    const gsis = gsisByPfr.get(sr.pfr), g = gameById.get(sr.game_id);
    if (!gsis || !g || players.has(sr.game_id + '|' + gsis)) return;
    const inj = injury.get([g.week, sr.team, gsis].join('|'));
    playerGames.push({ game_id: sr.game_id, source_player_id: gsis, player_name: sr.name, team_id: sr.team, opponent_id: sr.opp, position: sr.position, position_group: pg,
      season, week: g.week, kickoff_utc: g.kickoff_utc, is_home: sr.team === g.home_team_id,
      attempts: 0, completions: 0, passing_yards: 0, passing_tds: 0, interceptions: 0, sacks_taken: 0, passing_air_yards: 0, passing_epa: null, passing_cpoe: null,
      carries: 0, rushing_yards: 0, rushing_tds: 0, rushing_epa: null, targets: 0, receptions: 0, receiving_yards: 0, receiving_tds: 0, air_yards: 0, yac: 0,
      receiving_epa: null, target_share: 0, air_yard_share: 0, fumbles_lost: 0, special_teams_tds: 0, fg_made: null, fg_att: null, pat_made: null,
      def_interceptions: null, def_sacks: null, def_tackles_assists: null, snaps: sr.snaps, snap_share: sr.pct, routes: null, active_status: 'active', starter: null,
      injury_status: inj ? inj.status : null, longest_completion: null, longest_rush: null, longest_reception: null, red_zone_touches: 0, goal_line_touches: 0,
      rz_targets: 0, rz_carries: 0, gl_carries: 0, dropbacks: 0, scrambles: 0, designed_rushes: 0, explosive_rec: 0, explosive_rush: 0,
      source_provider: PROVIDER, source_detail: 'snap_counts_zero_fill', source_updated_at: null, source_quality: 0.95 });
    zeroFilled++;
  });
  coverage.zero_filled = zeroFilled;

  /* injury rows for players with NO box row: the absences (vacated opportunity) */
  const absences = [];
  injury.forEach((v, k) => {
    const [wk, team, gsis] = k.split('|');
    const g = games.find((x) => x.week === Number(wk) && (x.home_team_id === team || x.away_team_id === team));
    if (!g) return;
    if (/^(out|doubtful)$/i.test(v.status) && !players.has(g.game_id + '|' + gsis) && !playerGames.some((x) => x.game_id === g.game_id && x.source_player_id === gsis)) absences.push({ game_id: g.game_id, team_id: team, source_player_id: gsis, status: v.status, position: v.position, name: v.name });
  });

  const teamGames = [];
  teams.forEach((t) => {
    const secs = t._secs_n ? t._secs / t._secs_n : null;
    delete t._secs; delete t._secs_n; delete t._last;
    const g = gameById.get(t.game_id);
    t.season = season; t.week = g.week; t.kickoff_utc = g.kickoff_utc;
    t.seconds_per_play = secs;
    t.neutral_pass_rate = t.neutral_plays ? t.neutral_dropbacks / t.neutral_plays : null;
    t.proe = t.proe_n ? t.proe_sum / t.proe_n : null;
    t.epa_per_play = t.epa_n ? t.epa_sum / t.epa_n : null;
    t.points = g.home_team_id === t.team_id ? g.home_score : g.away_score;
    t.source_provider = PROVIDER;
    delete t.proe_sum; delete t.proe_n; delete t.epa_sum; delete t.epa_n;
    teamGames.push(t);
  });
  return { season, league: 'NFL', games, playerGames, teamGames, absences, coverage };
}

module.exports = { URL, PROVIDER, loadSchedule, loadPlayers, loadDraft, loadSeason, code, posGroup, CODE_ALIAS };
