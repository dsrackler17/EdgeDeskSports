'use strict';
/* ===========================================================================
   EdgeDesk NCAAW forecast system — configuration.

   Scope: NCAA Division I WOMEN'S basketball only. Men's data (league `ncaam`,
   hoopR `mbb`) is never read here; every source URL below is a wehoop women's
   (`wbb`) file and a test greps this directory for men's sources. The men's
   system is basketball/ncaam_forecast/ and shares no file with this one except
   the research engine both call (basketball/ncaam_research/team_model.js:
   opponent-adjusted efficiency and tempo from box scores, league-neutral: it
   reads possessions, points and minutes, never a men's constant).

   Season label: the END year (2027 = the 2026-27 season), the convention of
   basketball/config.js. The season in progress is read from that file
   (currentSeason), never hardcoded.

   Naming: `cbb` already means COLLEGE BASEBALL in this repository. Everything
   here is `ncaaw`.

   HOW THE WOMEN'S GAME DIFFERS, AND WHERE IT IS HANDLED
     periods     two 20-minute halves through 2014-15; four 10-minute quarters
                 from 2015-16 (season 2016). Regulation is 40 minutes either
                 way; an overtime is 5 minutes. n_ot = periods - regulation
                 periods of that season (RULES.regulationPeriods).
     free throws from 2015-16 the bonus is two shots on a team's fifth foul of
                 each quarter: no one-and-one. The possession estimate's
                 free-throw-trip constant is therefore Dean Oliver's 0.44 (the
                 two-shot-bonus constant, as in the NBA), not the men's college
                 0.475, which counts one-and-ones. An external constant: never
                 fitted on an outcome (dataset.js POSS_FTA).
     box scores  the source's team box scores cover 13-33% of finals in
                 2010-2016 and 93-100% from 2017 (measured, data/manifest.json).
                 The possession-based engine therefore starts in 2017
                 (MODEL_FIRST_SEASON, a burn-in season); the scores-only
                 incumbent reads every season from 2010.
     NCAA        the tournament's first two rounds are played on the campuses of
                 the top 16 seeds: those games are not neutral, and the source's
                 neutral flag says so from 2022 (16 of 32 first-round games are a
                 host's home game). Earlier seasons' flags are taken as the
                 source gives them and undercount host games (a limitation,
                 NCAAW_MODEL_NOTES.md §2).

   This system REUSES, it does not replace:
     basketball/ncaam_research/team_model.js + lib/additive.js  the validated
         opponent-adjusted efficiency/tempo engine (league-neutral)
     basketball/walkforward.js + docs/model-loop/ncaaw/versions.json  the
         served women's scores-only points model: the incumbent BASELINE
     engine/lab/fetch.js, hockey/lib/io.js  the guarded downloader and the
         parquet reader
   =========================================================================== */
const path = require('path');
const BB = require('../config');

const ROOT = path.join(__dirname, '..', '..');
const RAW = 'https://raw.githubusercontent.com/sportsdataverse/wehoop-wbb-data/main/wbb';

/* the season (end year) from which regulation is four quarters */
const QUARTERS_FROM = 2016;
const RULES = Object.freeze({
  competition: "NCAA Division I women's basketball",
  regulation_minutes: 40, overtime_minutes: 5, shot_clock_seconds: 30,
  quarters_from_season: QUARTERS_FROM,
  /** regulation periods in a season: 2 halves through 2015, 4 quarters from 2016 */
  regulationPeriods: (season) => (Number(season) >= QUARTERS_FROM ? 4 : 2),
});

const FIRST_SEASON = 2010;
/* the possession-based engine's first season (a burn-in season): the first
   season whose team box scores cover more than 90% of finals */
const MODEL_FIRST_SEASON = 2017;
/** the season in progress, from the repository's own calendar rule */
const currentSeason = (now) => BB.currentSeason('ncaaw', now);
function seasons(now) { const out = []; for (let s = FIRST_SEASON; s <= currentSeason(now); s++) out.push(s); return out; }
function modelSeasons(now) { return seasons(now).filter((s) => s >= MODEL_FIRST_SEASON); }

const SOURCES = {
  schedule: (s) => `${RAW}/schedules/parquet/wbb_schedule_${s}.parquet`,
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
  registry: path.join(__dirname, 'registry'),
  champion: path.join(__dirname, 'registry', 'champion.json'),
  artifacts: path.join(__dirname, 'registry', 'artifacts'),
  reports: path.join(__dirname, 'reports'),
  /* overridable so tests run against a temporary registry and report store */
  weeklyReports: () => process.env.NCAAW_REPORTS_DIR || path.join(__dirname, 'reports', 'weekly'),
  validation: path.join(__dirname, 'validation'),
  out: path.join(__dirname, 'out'),
};

module.exports = { ROOT, RULES, QUARTERS_FROM, FIRST_SEASON, MODEL_FIRST_SEASON, currentSeason, seasons, modelSeasons, SOURCES, AVAILABLE_AFTER_MS, PREDICT_BEFORE_MS, PATHS };
