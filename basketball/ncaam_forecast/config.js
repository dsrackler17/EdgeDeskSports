'use strict';
/* ===========================================================================
   EdgeDesk NCAAM forecast system — configuration.

   Scope: NCAA Division I MEN'S basketball only. Women's data (league `ncaaw`,
   basketball/data/ncaaw, wehoop) is never read here; every source URL below is
   a hoopR men's (`mbb`) file and a test greps this directory for `wbb`/`ncaaw`.

   Season label: the END year (2027 = the 2026-27 season), the convention of
   basketball/config.js. The season in progress is read from that file
   (currentSeason), never hardcoded.

   Naming: `cbb` already means COLLEGE BASEBALL in this repository (schema
   `cbb`, tools/cbb, college_baseball.sql). Everything here is `ncaam`.

   This system REUSES, it does not replace:
     basketball/ncaam_research/team_model.js + lib/additive.js  the validated
         opponent-adjusted efficiency/tempo engine (run here over 2010+ hoopR
         box scores instead of the pack's three seasons)
     basketball/ncaam_research/lib/calibration.js  the causal weekly calibrator
     basketball/walkforward.js + docs/model-loop/ncaam/versions.json  the
         served scores-only points model: the incumbent BASELINE
     simulator/src/core/*  the seeded Monte Carlo engine (tournaments)
     engine/lab/fetch.js, hockey/lib/io.js  the guarded downloader and the
         parquet reader
   =========================================================================== */
const path = require('path');
const BB = require('../config');

const ROOT = path.join(__dirname, '..', '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/hoopR-mbb-data/main/mbb';

const RULES = Object.freeze({
  competition: "NCAA Division I men's basketball",
  regulation_minutes: 40, halves: 2, half_minutes: 20, overtime_minutes: 5, shot_clock_seconds: 30,
});

const FIRST_SEASON = 2010;
/** the season in progress, from the repository's own calendar rule */
const currentSeason = (now) => BB.currentSeason('ncaam', now);
function seasons(now) { const out = []; for (let s = FIRST_SEASON; s <= currentSeason(now); s++) out.push(s); return out; }

const SOURCES = {
  schedule: (s) => `${RAW}/schedules/parquet/mbb_schedule_${s}.parquet`,
  team_box: (s) => `${RAW}/team_box/parquet/team_box_${s}.parquet`,
  license: BB.LICENSE,
};

/* the same timing assumptions as basketball/walkforward.js and the research
   engine: first-publication times do not exist in any source here */
const AVAILABLE_AFTER_MS = 4 * 3600e3;
const PREDICT_BEFORE_MS = 30 * 60e3;

const PATHS = {
  ROOT, BASE: __dirname,
  data: path.join(__dirname, 'data'),
  season: (s) => path.join(__dirname, 'data', 'games_' + s + '.csv.gz'),
  manifest: path.join(__dirname, 'data', 'manifest.json'),
  teams: path.join(__dirname, 'data', 'teams.json'),
  quarantine: path.join(__dirname, 'data', 'quarantine.json'),
  coverage: path.join(__dirname, 'data', 'coverage.json'),
  configDir: path.join(__dirname, 'config'),
  promotion: path.join(__dirname, 'config', 'promotion_v1.json'),
  upsetPolicy: path.join(__dirname, 'config', 'upset_policy.json'),
  liveConfig: path.join(__dirname, 'config', 'live.json'),
  tournamentConfig: path.join(__dirname, 'config', 'tournament_rules.json'),
  registry: path.join(__dirname, 'registry'),
  champion: path.join(__dirname, 'registry', 'champion.json'),
  artifacts: path.join(__dirname, 'registry', 'artifacts'),
  reports: path.join(__dirname, 'reports'),
  /* overridable so tests run against a temporary registry and report store */
  weeklyReports: () => process.env.NCAAM_REPORTS_DIR || path.join(__dirname, 'reports', 'weekly'),
  validation: path.join(__dirname, 'validation'),
  out: path.join(__dirname, 'out'),
};

module.exports = { ROOT, RULES, FIRST_SEASON, currentSeason, seasons, SOURCES, AVAILABLE_AFTER_MS, PREDICT_BEFORE_MS, PATHS };
