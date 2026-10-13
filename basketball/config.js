'use strict';
/* ===========================================================================
   EdgeDesk basketball — four leagues, four separately fitted brains.

   NBA, WNBA, men's and women's college basketball share one METHOD (points
   ratings, basketball/model.js) but never one fit: each league has its own
   history, its own hyperparameters chosen on its own selection window, its
   own calibration and its own validation record. Game length (48 / 40 min),
   scoring level, home advantage and season calendar all differ.

   Source: sportsdataverse hoopR / wehoop season schedules (public GitHub
   repositories compiled from ESPN's public scoreboard feeds). The data pack
   (datapack/quant_v1) holds an independent ESPN retrieval of one season per
   league; basketball/crosscheck.js reconciles the two.
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse';

/* season label: the year the season ends (NBA / college), the calendar year (WNBA) */
function currentSeason(league, now) {
  const d = new Date(now == null ? Date.now() : now);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (LEAGUES[league].calendar === 'summer') return y;
  return m >= 8 ? y + 1 : y;
}

const LEAGUES = {
  nba: {
    label: 'NBA', sport_key: 'basketball_nba', registry: 'nba', calendar: 'winter', minutes: 48,
    url: (s) => `${RAW}/hoopR-nba-data/main/nba/schedules/parquet/nba_schedule_${s}.parquet`,
    first: 2008, windows: { burn_in: [2008, 2009], selection: [2010, 2017], confirmation: [2018, null] },
    pack: 'nba', pack_season: 2025,
  },
  wnba: {
    label: 'WNBA', sport_key: 'basketball_wnba', registry: 'wnba', calendar: 'summer', minutes: 40,
    url: (s) => `${RAW}/wehoop-wnba-data/main/wnba/schedules/parquet/wnba_schedule_${s}.parquet`,
    first: 2008, windows: { burn_in: [2008, 2009], selection: [2010, 2017], confirmation: [2018, null] },
    pack: 'wnba', pack_season: 2024,
  },
  ncaam: {
    label: "Men's college basketball", sport_key: 'basketball_ncaab', registry: 'ncaab_m', calendar: 'winter', minutes: 40,
    url: (s) => `${RAW}/hoopR-mbb-data/main/mbb/schedules/parquet/mbb_schedule_${s}.parquet`,
    first: 2010, windows: { burn_in: [2010, 2011], selection: [2012, 2018], confirmation: [2019, null] },
    pack: 'cbb_men', pack_season: 2025,
  },
  ncaaw: {
    label: "Women's college basketball", sport_key: 'basketball_wncaab', registry: 'ncaab_w', calendar: 'winter', minutes: 40,
    url: (s) => `${RAW}/wehoop-wbb-data/main/wbb/schedules/parquet/wbb_schedule_${s}.parquet`,
    first: 2010, windows: { burn_in: [2010, 2011], selection: [2012, 2018], confirmation: [2019, null] },
    pack: 'cbb_women', pack_season: 2025,
  },
};

const COLUMNS = ['game_id', 'date', 'season', 'season_type', 'neutral_site', 'status_type_name', 'status_type_completed', 'status_period', 'format_regulation_periods',
  'home_id', 'home_display_name', 'home_abbreviation', 'home_score', 'away_id', 'away_display_name', 'away_abbreviation', 'away_score', 'notes_headline'];

const LICENSE = 'sportsdataverse hoopR-*-data / wehoop-*-data: MIT-licensed repositories of data compiled from ESPN\'s public feeds. ESPN\'s terms govern the underlying data; the owner must review before basketball output is sold in a paid tier.';

const PATHS = {
  ROOT, BASE: __dirname,
  data: (league) => path.join(__dirname, 'data', league),
  validation: (league) => path.join(__dirname, 'validation', league + '_walkforward.json'),
  params: (league) => path.join(__dirname, 'params', league + '_live.json'),
  tuning: (league) => path.join(__dirname, 'params', league + '_tuning.json'),
  slate: path.join(__dirname, 'slate.json'),
  crosscheck: path.join(__dirname, 'validation', 'crosscheck_pack.json'),
};

module.exports = { LEAGUES, COLUMNS, LICENSE, PATHS, currentSeason, ROOT };
