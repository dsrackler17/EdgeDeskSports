'use strict';
/* ===========================================================================
   NCAAM-EARLY (edgedesk_ncaam_early_v1) — configuration of the DATA LAYER.

   The early-season men's college basketball research model. It is built ON
   the existing ratings engine (basketball/ncaam_research/team_model.js, the
   engine of NCAAM-FORECAST) and adds what that engine does not observe:
   roster continuity, transfer translation, departed production, coaching and
   the variance they carry (README.md). This file configures only the T0
   observations it needs.

   Naming: `cbb` is COLLEGE BASEBALL in this repository; everything here is
   `ncaam_early` / `ncaam_es_*`. Men's only: no women's source is read.

   Season label: the END year (2027 = the 2026-27 season), the convention of
   basketball/config.js. CBBD's `season` integer is checked against its own
   `seasonLabel` on every row (normalise.js seasonOf): a row whose label does
   not end in the season it claims is refused, so the convention is verified
   from the data, never assumed.

   Storage: CBBD's terms forbid publishing API data "as a standalone dataset
   or bulk download" (collegebasketballdata.com/terms §2, read 2026-11-01).
   This repository is public, so NO raw CBBD row is committed. Raw responses
   are cached under /.cache/ncaam_early (gitignored) and stored in Supabase
   tables only the service role can read (supabase/ncaam_early.sql). The
   repository holds metadata only: counts, hashes, fetch times and quota.
   =========================================================================== */
const path = require('path');
const BB = require('../config');

const ROOT = path.join(__dirname, '..', '..');
const MODEL_ID = 'edgedesk_ncaam_early_v1';
const MODEL_KEY = 'NCAAM-EARLY';

const currentSeason = (now) => BB.currentSeason('ncaam', now);

/* the seasons the data layer backfills: 2019 (2018-19) is the prior season of
   the first training season, 2020 (2019-20). The windows themselves are
   registered in research/registration.json, not here. */
const FIRST_SEASON = 2019;
function seasons(now) { const out = []; for (let s = FIRST_SEASON; s <= currentSeason(now); s++) out.push(s); return out; }

const CBBD = Object.freeze({
  base: 'https://api.collegebasketballdata.com',
  endpoints_file: path.join(__dirname, 'config', 'cbbd_endpoints.json'),
  timeout_ms: 30000,
  /* the quota is SHARED with CollegeFootballData (CFBD terms; the CFB SP+ job
     uses CFBD_API_KEY on the free tier). Every run has a hard call cap, and a
     run stops before a call when the provider says fewer than
     `quota_reserve` calls remain, so basketball never spends football's
     allowance. The provider's remaining count is read from its response
     headers when it sends them (X-CallLimit-Remaining) and recorded. */
  max_calls_per_run: 40,
  quota_reserve: 300,
  /* a date window that returns the documented cap is split in two and asked
     again, until every window is below it: nothing is silently truncated */
  min_window_days: 1,
});

/* which parts exist, what they call, and how often the scheduled job asks */
const PARTS = Object.freeze({
  teams:          { endpoint: '/teams',               per: 'season' },
  conferences:    { endpoint: '/conferences/history', per: 'once' },
  venues:         { endpoint: '/venues',              per: 'once' },
  games:          { endpoint: '/games',               per: 'season', windowed: true },
  box_team:       { endpoint: '/games/teams',         per: 'season', windowed: true },
  player_seasons: { endpoint: '/stats/player/season', per: 'season' },
  rosters:        { endpoint: '/teams/roster',        per: 'season' },
  portal:         { endpoint: '/recruiting/portal',   per: 'year' },
  recruits:       { endpoint: '/recruiting/players',  per: 'year' },
  lines:          { endpoint: '/lines',               per: 'season', windowed: true },
});

/* the possession estimate the NCAAM forecast dataset uses
   (basketball/ncaam_forecast/dataset.js POSS_FTA = 0.475) */
const POSS_FTA = 0.475;

/* a result is assumed known 4 h after tip; first-publication times exist in
   no source (the same assumption as basketball/ncaam_forecast/config.js) */
const AVAILABLE_AFTER_MS = 4 * 3600e3;

const PATHS = {
  ROOT, BASE: __dirname,
  cache: path.join(ROOT, '.cache', 'ncaam_early'),
  raw: (season, part) => path.join(ROOT, '.cache', 'ncaam_early', 'raw', String(season), part + '.json.gz'),
  manifest: path.join(__dirname, 'data', 'manifest.json'),
  manual: path.join(__dirname, 'manual'),
  coaches: path.join(__dirname, 'manual', 'coaches.json'),
  availability: path.join(__dirname, 'manual', 'availability.json'),
  schoolLevels: path.join(__dirname, 'manual', 'school_levels.json'),
};

module.exports = { ROOT, MODEL_ID, MODEL_KEY, currentSeason, FIRST_SEASON, seasons, CBBD, PARTS, POSS_FTA, AVAILABLE_AFTER_MS, PATHS };
