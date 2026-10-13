'use strict';
/* ===========================================================================
   EdgeDesk soccer — five leagues, five separately fitted brains.

   The Premier League, Bundesliga, La Liga, Serie A and Ligue 1 share one
   METHOD (Dixon-Coles, soccer/model.js) and never one fit: each league has its
   own ratings, home advantage, low-score correction, hyperparameters and
   validation record.

   Source: openfootball/football.json — fixtures and results, released to the
   public domain (CC0). Dates and local kick-off times only (no time zone), so
   the walk-forward works by match day: a match on day D is predicted from
   matches on days before D. The data pack's ESPN retrieval of the 2024-25
   Premier League is reconciled against it (soccer/crosscheck.js).
   =========================================================================== */
const path = require('path');

const RAW = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const LEAGUES = {
  epl: { label: 'Premier League', code: 'en.1', sport_key: 'soccer_epl', teams: 20 },
  bundesliga: { label: 'Bundesliga', code: 'de.1', sport_key: 'soccer_germany_bundesliga', teams: 18 },
  laliga: { label: 'La Liga', code: 'es.1', sport_key: 'soccer_spain_la_liga', teams: 20 },
  seriea: { label: 'Serie A', code: 'it.1', sport_key: 'soccer_italy_serie_a', teams: 20 },
  ligue1: { label: 'Ligue 1', code: 'fr.1', sport_key: 'soccer_france_ligue_one', teams: 18 },
};
const FIRST = 2011; /* 2010-11 */
const WINDOWS = { burn_in: [2011, 2012], selection: [2013, 2018], confirmation: [2019, null] };

/* a season is labelled by the year it ends: 2024-25 -> 2025 */
function currentSeason(now) { const d = new Date(now == null ? Date.now() : now); return d.getUTCMonth() + 1 >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); }
const seasonPath = (s) => (s - 1) + '-' + String(s).slice(2);
const url = (league, s) => RAW + '/' + seasonPath(s) + '/' + LEAGUES[league].code + '.json';

const LICENSE = 'openfootball/football.json: public domain (CC0 1.0); no attribution required. Match facts only.';

const PATHS = {
  data: (league) => path.join(__dirname, 'data', league),
  validation: (league) => path.join(__dirname, 'validation', league + '_walkforward.json'),
  params: (league) => path.join(__dirname, 'params', league + '_live.json'),
  tuning: (league) => path.join(__dirname, 'params', league + '_tuning.json'),
  slate: path.join(__dirname, 'slate.json'),
  crosscheck: path.join(__dirname, 'validation', 'crosscheck_pack.json'),
};

module.exports = { LEAGUES, FIRST, WINDOWS, currentSeason, seasonPath, url, LICENSE, PATHS, ROOT: path.join(__dirname, '..') };
