/* ===========================================================================
   EdgeDesk player props — CFB source adapter (SportsDataverse / cfbfastR,
   CC BY 4.0 release store; ESPN-derived).

   One season in, canonical rows out:
     games        espn_cfb_schedules/cfb_schedule_<y>.csv   (game_id = the ESPN
                  event id, the same id every CFB table in EdgeDesk keys on)
     playerGames  espn_cfb_player_box/player_box_<y>.csv    (one row per player,
                  game and stat CATEGORY upstream; merged here to one row per
                  player and game)
     teamGames    espn_cfb_team_box/team_box_<y>.csv        (plays, pass rate,
                  possession pace, and the rates each opponent allowed)
     rosters      cfbfastR-data rosters/csv/cfb_rosters_<y>.csv (position,
                  class year; keyed by the ESPN athlete id)

   THE BOX FORMAT CHANGED UPSTREAM. Older seasons publish passing as named
   columns (completions/passingAttempts, passingYards, …); recent seasons put
   the passing line in stat_1..stat_5 (C/ATT, YDS, AVG, TD, INT). A value is
   read from the named column first and the positional one second, and a row
   that parses to an impossible line (completions above attempts) is kept but
   carries source_quality 0 so QA quarantines it rather than a parser guessing.

   CFB CARRIES NO TARGETS, AIR YARDS, SNAPS OR ROUTES in this source. Those
   columns are null for CFB — never zero — and the feature layer reports them
   as unavailable for the league.
   =========================================================================== */
'use strict';
const io = require('../lib/io.js');
const teamsXw = require('../../../fbs_epa/teams.json');

const SDV = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
const CFBR = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const URL = {
  schedule: (y) => SDV + '/espn_cfb_schedules/cfb_schedule_' + y + '.csv',
  fullSchedule: (y) => CFBR + '/schedules/csv/cfb_schedules_' + y + '.csv',
  box: (y) => SDV + '/espn_cfb_player_box/player_box_' + y + '.csv',
  teamBox: (y) => SDV + '/espn_cfb_team_box/team_box_' + y + '.csv',
  rosters: (y) => CFBR + '/rosters/csv/cfb_rosters_' + y + '.csv'
};
const PROVIDER = 'sportsdataverse';

/* ESPN team id → {key, name, division by season} (the crosswalk the FBS EPA layer already maintains) */
const TEAM = new Map((Array.isArray(teamsXw.teams) ? teamsXw.teams : Object.values(teamsXw.teams || {})).map((t) => [String(t.espn_team_id), t]));
function divisionOf(teamId, season) { const t = TEAM.get(String(teamId)); const s = t && t.seasons && (t.seasons[season] || t.seasons[String(season)]); return s ? s.division : null; }
function conferenceOf(teamId, season) { const t = TEAM.get(String(teamId)); const s = t && t.seasons && (t.seasons[season] || t.seasons[String(season)]); return s ? s.conference : null; }
const POWER = new Set(['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12']);

const POS = { QB: 'QB', RB: 'RB', FB: 'RB', TB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE', PK: 'K', K: 'K', P: 'P' };
function posGroup(p) { const s = String(p || '').toUpperCase(); return POS[s] || (s ? 'OTHER' : null); }

async function get(url, name, opts) { return io.fetchCached(url, 'sportsdataverse', name, opts); }

function pair(s) { const m = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(String(s || '')); return m ? [Number(m[1]), Number(m[2])] : [null, null]; }
function pick(r, named, stat) { const a = io.num(r[named]); return a != null ? a : io.num(r[stat]); }
function pickStr(r, named, stat) { const a = io.str(r[named]); return a != null && a !== '--' ? a : io.str(r[stat]); }
function mmss(s) { const m = /^(\d+):(\d{2})$/.exec(String(s || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

/* The full season, upcoming games included: cfbfastR-data's schedule (the same
   file football/fbs/build_coverage.js reads). SportsDataverse's ESPN schedule
   lists only completed games, so it is the fallback, not the source. */
function scheduleRow(g, season, src) {
  const hd = io.str(g.home_division) || divisionOf(g.home_id, season), ad = io.str(g.away_division) || divisionOf(g.away_id, season);
  const hp = io.num(g.home_points != null ? g.home_points : g.home_score), ap = io.num(g.away_points != null ? g.away_points : g.away_score);
  const done = src === 'cfbfastr' ? io.bool(g.completed) === true : /FINAL/i.test(String(g.status || ''));
  const kickRaw = io.str(g.start_date) || io.str(g.game_date);
  return {
    game_id: String(g.game_id), league: 'CFB', source_game_id: String(g.game_id), espn_event_id: String(g.game_id),
    season: io.int(g.season), week: io.int(g.week), season_type: /post|^3$/i.test(String(g.season_type)) ? 'postseason' : 'regular',
    kickoff_utc: kickRaw ? new Date(kickRaw).toISOString() : null, kickoff_tbd: io.bool(g.start_time_tbd) === true,
    home_team_id: String(g.home_id), away_team_id: String(g.away_id),
    home_team_name: io.str(g.home_team), away_team_name: io.str(g.away_team), home_abbr: io.str(g.home_abbreviation), away_abbr: io.str(g.away_abbreviation),
    venue_id: io.str(g.venue_id), venue_name: io.str(g.venue), surface: null, roof: null, neutral_site: io.bool(g.neutral_site) === true,
    conference_game: io.bool(g.conference_game != null ? g.conference_game : g.conference_competition) === true,
    home_division: hd, away_division: ad, home_conference: io.str(g.home_conference) || conferenceOf(g.home_id, season), away_conference: io.str(g.away_conference) || conferenceOf(g.away_id, season),
    home_pregame_elo: io.num(g.home_pregame_elo), away_pregame_elo: io.num(g.away_pregame_elo),
    home_score: done ? hp : null, away_score: done ? ap : null, status: done && hp != null && ap != null ? 'final' : 'scheduled',
    source_provider: src === 'cfbfastr' ? 'cfbfastR' : PROVIDER
  };
}
async function loadSchedule(season, opts) {
  let f = await io.fetchCached(URL.fullSchedule(season), 'cfbfastr', 'cfb_schedules_' + season + '.csv', opts);
  let src = 'cfbfastr';
  if (!f) { f = await get(URL.schedule(season), 'cfb_schedule_' + season + '.csv', opts); src = 'sdv'; }
  if (!f) return [];
  const rows = await io.loadCsv(f.file);
  return rows.map((g) => scheduleRow(g, season, src)).filter((g) => g.game_id && g.kickoff_utc && g.season === season);
}

async function loadRosters(season, opts) {
  const f = await get(URL.rosters(season), 'cfb_rosters_' + season + '.csv', opts);
  const out = new Map();
  if (!f) return out;
  await io.readCsv(f.file, (r) => {
    const id = io.str(r.athlete_id);
    if (!id || Number(id) <= 0) return;             /* negative ids are not ESPN athletes */
    out.set(id, { athlete_id: id, name: [io.str(r.first_name), io.str(r.last_name)].filter(Boolean).join(' '), position: io.str(r.position),
      class_year: io.int(r.year), team: io.str(r.team), height: io.num(r.height), weight: io.num(r.weight), home_state: io.str(r.home_state), recruit_ids: io.str(r.recruit_ids) });
  });
  return out;
}

async function loadSeason(season, opts) {
  opts = opts || {};
  const coverage = { season, schedule: false, box: false, team_box: false, rosters: false, notes: [] };
  const games = await loadSchedule(season, opts);
  coverage.schedule = games.length > 0;
  const gameById = new Map(games.map((g) => [g.game_id, g]));
  const rosters = await loadRosters(season, opts);
  coverage.rosters = rosters.size > 0;
  if (!coverage.rosters) coverage.notes.push('no cfbfastR roster for ' + season + ': positions inferred from usage and marked');

  const bf = await get(URL.box(season), 'player_box_' + season + '.csv', opts);
  const rows = new Map();
  if (bf) {
    coverage.box = true;
    await io.readCsv(bf.file, (r) => {
      const gid = String(r.game_id || ''), aid = io.str(r.athlete_id), cat = r.category;
      const g = gameById.get(gid);
      if (!g || !aid) return;
      const k = gid + '|' + aid;
      let x = rows.get(k);
      if (!x) {
        const team = String(r.team_id || '');
        const home = team === g.home_team_id;
        x = { game_id: gid, source_player_id: aid, player_name: io.str(r.athlete_name), team_id: team, opponent_id: home ? g.away_team_id : g.home_team_id,
          season, week: g.week, kickoff_utc: g.kickoff_utc, is_home: home, jersey: io.str(r.jersey),
          attempts: null, completions: null, passing_yards: null, passing_tds: null, interceptions: null, qbr: null,
          carries: null, rushing_yards: null, rushing_tds: null, longest_rush: null,
          targets: null, receptions: null, receiving_yards: null, receiving_tds: null, longest_reception: null, longest_completion: null,
          air_yards: null, yac: null, snaps: null, snap_share: null, routes: null, target_share: null, air_yard_share: null,
          red_zone_touches: null, goal_line_touches: null, fumbles_lost: null,
          fg_made: null, fg_att: null, pat_made: null, kicking_points: null, def_interceptions: null, def_sacks: null, def_tackles_assists: null,
          active_status: 'active', starter: null, injury_status: null, source_provider: PROVIDER, source_updated_at: null, source_quality: 1, _cats: [] };
        rows.set(k, x);
      }
      x._cats.push(cat);
      if (cat === 'passing') {
        const ca = pair(pickStr(r, 'completions/passingAttempts', 'stat_1'));
        x.completions = ca[0]; x.attempts = ca[1];
        x.passing_yards = pick(r, 'passingYards', 'stat_2');
        x.passing_tds = pick(r, 'passingTouchdowns', 'stat_4');
        x.interceptions = pick(r, 'interceptions', 'stat_5');
        x.qbr = io.num(r.adjQBR);
      } else if (cat === 'rushing') {
        x.carries = pick(r, 'rushingAttempts', 'stat_1'); x.rushing_yards = pick(r, 'rushingYards', 'stat_2');
        x.rushing_tds = pick(r, 'rushingTouchdowns', 'stat_4'); x.longest_rush = pick(r, 'longRushing', 'stat_5');
      } else if (cat === 'receiving') {
        x.receptions = pick(r, 'receptions', 'stat_1'); x.receiving_yards = pick(r, 'receivingYards', 'stat_2');
        x.receiving_tds = pick(r, 'receivingTouchdowns', 'stat_4'); x.longest_reception = pick(r, 'longReception', 'stat_5');
      } else if (cat === 'fumbles') {
        x.fumbles_lost = io.int(r.fumblesLost);
      } else if (cat === 'kicking') {
        const fg = pair(pickStr(r, 'fieldGoalsMade/fieldGoalAttempts', 'stat_1')), xp = pair(pickStr(r, 'extraPointsMade/extraPointAttempts', 'stat_4'));
        x.fg_made = fg[0]; x.fg_att = fg[1]; x.pat_made = xp[0]; x.kicking_points = io.num(r.totalKickingPoints);
      } else if (cat === 'interceptions') {
        x.def_interceptions = pick(r, 'interceptions', 'stat_1');
      } else if (cat === 'defensive') {
        x.def_sacks = io.num(r.sacks);
        const tk = io.num(r.totalTackles); x.def_tackles_assists = tk;
      }
    });
  } else coverage.notes.push('no player box for ' + season);

  const playerGames = [];
  rows.forEach((x) => {
    const ro = rosters.get(x.source_player_id);
    let pos = ro ? ro.position : null;
    x.position_source = pos ? 'roster' : null;
    if (!pos) {
      /* usage-inferred position, labelled as such: the largest opportunity type */
      const pa = x.attempts || 0, ca = x.carries || 0, re = x.receptions || 0;
      if (pa >= 5 && pa >= ca) pos = 'QB'; else if (ca > re && ca > 0) pos = 'RB'; else if (re > 0) pos = 'WR';
      if (pos) x.position_source = 'usage_inferred';
    }
    x.position = pos; x.position_group = posGroup(pos);
    x.class_year = ro ? ro.class_year : null;
    /* the categories a player appeared in: an absent category is a measured zero
       for the counting stats of an ACTIVE player of that position group */
    const cats = new Set(x._cats); delete x._cats;
    if (!cats.has('rushing')) { x.carries = 0; x.rushing_yards = 0; x.rushing_tds = 0; }
    if (!cats.has('receiving')) { x.receptions = 0; x.receiving_yards = 0; x.receiving_tds = 0; }
    if (!cats.has('passing')) { x.attempts = 0; x.completions = 0; x.passing_yards = 0; x.passing_tds = 0; x.interceptions = 0; }
    if (x.completions != null && x.attempts != null && x.completions > x.attempts) x.source_quality = 0;
    playerGames.push(x);
  });

  /* team box → team-game context */
  const tf = await get(URL.teamBox(season), 'team_box_' + season + '.csv', opts);
  const teamGames = [];
  if (tf) {
    coverage.team_box = true;
    await io.readCsv(tf.file, (r) => {
      const gid = String(r.game_id || ''), g = gameById.get(gid);
      if (!g) return;
      const team = String(r.team_id);
      const ca = pair(r.completionAttempts);
      const passAtt = ca[1], rush = io.num(r.rushingAttempts);
      const plays = passAtt != null && rush != null ? passAtt + rush : null;
      const top = mmss(r.possessionTime);
      teamGames.push({ game_id: gid, team_id: team, opponent_id: team === g.home_team_id ? g.away_team_id : g.home_team_id, season, week: g.week, kickoff_utc: g.kickoff_utc,
        plays, dropbacks: passAtt, pass_attempts: passAtt, completions: ca[0], rushes: rush, pass_yards: io.num(r.netPassingYards), rush_yards: io.num(r.rushingYards),
        total_yards: io.num(r.totalYards), turnovers: io.num(r.turnovers), first_downs: io.num(r.firstDowns),
        seconds_per_play: top != null && plays ? top / plays : null, neutral_pass_rate: null, proe: null, epa_per_play: null,
        points: team === g.home_team_id ? g.home_score : g.away_score, source_provider: PROVIDER });
    });
  } else coverage.notes.push('no team box for ' + season);

  return { season, league: 'CFB', games, playerGames, teamGames, absences: [], rosters, coverage };
}

module.exports = { URL, PROVIDER, loadSchedule, loadRosters, loadSeason, divisionOf, conferenceOf, POWER, posGroup, TEAM };
