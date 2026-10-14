'use strict';
/* ===========================================================================
   EdgeDesk college baseball — the one place sources, seasons, windows and
   paths are declared.

   THIS IS NOT THE MLB MODEL WITH COLLEGE NAMES. College baseball differs in
   every input that matters: run environment (~6.5-7 runs per team-game, not
   ~4.5), aluminium (BBCOR) bats, very unequal schedules, weekend rotations
   and midweek bullpen games, seven-inning doubleheader games, conference run
   rules, roster turnover of a third or more each year, and starting pitchers
   that are rarely published by a feed. Everything here is fitted on college
   data and evaluated on college data.

   SOURCE. sportsdataverse/baseballr-data (MIT-licensed code), a public
   GitHub repository compiled from stats.ncaa.org. The data itself is NCAA
   statistics; the NCAA's terms govern it and have NOT been verified for
   commercial redistribution (research/LICENSING.md). Until the owner signs
   that off, release gate G1 stays FAILED and nothing here is sold.

   WINDOWS were written down before any model was scored (research/
   PROTOCOL.md). They are not edited to suit a result.
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/baseballr-data/main';

const SOURCE = {
  id: 'baseballr_data',
  name: 'sportsdataverse/baseballr-data (stats.ncaa.org derived)',
  repo: 'https://github.com/sportsdataverse/baseballr-data',
  license_code: 'MIT (baseballr.data authors, 2026)',
  license_data: 'NCAA statistics compiled from stats.ncaa.org; NCAA terms of use govern the underlying data. Commercial use NOT verified.',
  urls: {
    lookup: `${RAW}/ncaa/teams_info/ncaa_team_lookup.csv`,
    seasonIds: `${RAW}/ncaa/seasons_info/ncaa_season_id_lu.csv`,
    schedule: (s) => `${RAW}/ncaa/schedule/parquet/ncaa_baseball_schedule_${s}.parquet`,
    teamSchedule: (s, orgId) => `${RAW}/ncaa/team_schedules/csv/${s}_${orgId}.csv`,
    games: (s) => `${RAW}/ncaa/games/parquet/ncaa_baseball_games_${s}.parquet`,
    linescore: (s) => `${RAW}/ncaa/linescore/parquet/ncaa_baseball_linescore_${s}.parquet`,
    playerStats: (s) => `${RAW}/ncaa/player_stats/parquet/ncaa_baseball_player_stats_${s}.parquet`,
    rosters: (s) => `${RAW}/ncaa/rosters/parquet/ncaa_baseball_rosters_${s}.parquet`,
    teams: (s) => `${RAW}/ncaa/teams/parquet/ncaa_baseball_teams_${s}.parquet`,
    pbp: (s) => `${RAW}/ncaa/pbp/parquet/ncaa_baseball_pbp_${s}.parquet`,
    qaFinals: (s) => `${RAW}/ncaa/qa/qa_pbp_finals_${s}.parquet`,
    manifest: (d) => `${RAW}/ncaa/${d}/manifest.csv`,
  },
};

/* What each season actually carries (measured 2026-10-13, research/SOURCES.md). */
const SEASONS = {
  first: 2012, last: 2026,
  results: [2012, 2026],            // schedule/results for every D-I contest
  box: [2024, 2026],                // player box scores (batting, pitching, fielding)
  linescore: [2024, 2026],          // inning-by-inning runs
  pbp: [2017, 2026],                // play-by-play (2023 partial)
  rosters: [2024, 2026],
  /* the 2023 season file stops on 05/27 with ~3.6k D-I contests; the
     per-team schedule files are unioned in to fill it (ingest/schedules.js) */
  team_file_union: [2023],
  covid: [2020],                    // the season stopped on 03/15/2020
};

/* WINDOWS — declared before scoring (research/PROTOCOL.md §2). */
const WINDOWS = {
  team: {        // results-only models, 2012-2026
    burn_in: [2012, 2013],
    selection: [2014, 2022],        // choose and tune
    validation: [2023, 2024],       // ensemble weights, calibration, promotion evidence
    holdout: [2025, 2026],          // reported once per model version; never tuned on
  },
  pitcher: {     // box-score models, 2024-2026
    burn_in: [2024, 2024],          // pitcher histories accumulate; fitted, never scored for selection
    selection: [2025, 2025],
    holdout: [2026, 2026],
  },
};

/* the game's prediction time: first pitch is rarely published, so a game is
   predicted at 12:00 local (16:00 UTC) on its date, and a game's result is
   assumed available from 06:00 UTC the next day. Results of earlier dates
   only ever enter a prediction (audited: lib/audit.js LEAKAGE). */
const TIME = { predict_hour_utc: 16, available_next_day_hour_utc: 6 };

const PATHS = {
  ROOT, BASE: __dirname,
  cacheSrc: path.join(ROOT, '.cache', 'cbase_src'),
  cacheWork: path.join(ROOT, '.cache', 'cbase_work'),
  pyHelper: path.join(ROOT, 'hockey', 'tools', 'parquet_select.py'),
  data: path.join(__dirname, 'data'),
  games: (s) => path.join(__dirname, 'data', 'games', s + '.csv'),
  teamSeasons: path.join(__dirname, 'data', 'teams', 'team_seasons.csv'),
  teams: path.join(__dirname, 'data', 'teams', 'teams.csv'),
  teamGames: (s) => path.join(__dirname, 'data', 'box', s + '_team_games.csv.gz'),
  pitchers: (s) => path.join(__dirname, 'data', 'box', s + '_pitchers.csv.gz'),
  innings: (s) => path.join(__dirname, 'data', 'innings', s + '.csv.gz'),
  pbpSummary: path.join(__dirname, 'data', 'pbp', 'run_environment.json'),
  provenance: (s) => path.join(__dirname, 'data', 'provenance', s + '.csv.gz'),
  quarantine: (s) => path.join(__dirname, 'data', 'quarantine', s + '.csv'),
  manifest: path.join(__dirname, 'data', 'manifest.json'),
  coverage: path.join(__dirname, 'validation', 'coverage.json'),
  quality: path.join(__dirname, 'validation', 'data_quality.json'),
  validation: path.join(__dirname, 'validation'),
  walkforward: path.join(__dirname, 'validation', 'walkforward.json'),
  pitcherEval: path.join(__dirname, 'validation', 'pitcher_walkforward.json'),
  starterEval: path.join(__dirname, 'validation', 'starter_projection.json'),
  distEval: path.join(__dirname, 'validation', 'run_distribution.json'),
  simEval: path.join(__dirname, 'validation', 'simulator.json'),
  audit: path.join(__dirname, 'validation', 'audit.json'),
  gates: path.join(__dirname, 'validation', 'release_gates.json'),
  errors: path.join(__dirname, 'validation', 'error_analysis.json'),
  params: path.join(__dirname, 'params'),
  production: path.join(__dirname, 'params', 'production.json'),
  slate: path.join(__dirname, 'slate.json'),
  research: path.join(__dirname, 'research'),
  registry: path.join(__dirname, 'research', 'experiments.jsonl'),
  ledger: path.join(__dirname, 'research', 'PROGRESS_LEDGER.md'),
};

const MODEL_VERSION = 'cbase_v1.0.0';
const SPORT_KEY = 'baseball_ncaa';

/* College baseball runs mid-February to late June: the season is the calendar year. */
function seasonOf(dateISO) { return Number(String(dateISO).slice(0, 4)); }
function inSeasonMonth(dateISO) { const m = Number(String(dateISO).slice(5, 7)); return m >= 2 && m <= 6; }
function currentSeason(now) { const d = new Date(now == null ? Date.now() : now); return d.getUTCFullYear(); }

module.exports = { SOURCE, SEASONS, WINDOWS, TIME, PATHS, MODEL_VERSION, SPORT_KEY, seasonOf, inSeasonMonth, currentSeason, RAW };
