'use strict';
/* ===========================================================================
   EdgeDesk men's college basketball RESEARCH ENGINE — configuration.

   This is the research product: team strength, player impact, lineups,
   matchups and availability scenarios, built from the college basketball data
   pack (datapack/ncaam_v1). It runs without any sportsbook price. The older
   scores-only points model (basketball/model.js, league `ncaam`) stays as it
   is and is used here as a benchmark.

   Season label: the END year (2026 = the 2025-26 season). Men's games are two
   20-minute halves; each overtime is 5 minutes. Periods 1-2 are halves and
   3+ are overtimes in every table this engine reads.

   Windows (fixed before any holdout number was looked at; see
   docs/ncaam/VALIDATION.md):
     2024  burn-in: earliest season, used for priors and calibration only
     2025  selection: every hyperparameter and model choice is made here
     2026  holdout: evaluated once with the frozen selection
   =========================================================================== */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PACK = path.join(ROOT, 'datapack', 'ncaam_v1');

const RULES = Object.freeze({
  regulation_minutes: 40,
  halves: 2,
  half_minutes: 20,
  overtime_minutes: 5,
  shot_clock_seconds: 30,
  players_on_floor: 5,
});

const SEASONS = [2024, 2025, 2026];
const WINDOWS = Object.freeze({ burn_in: [2024], selection: [2025], holdout: [2026] });

const PATHS = {
  ROOT, PACK,
  data: (f) => path.join(PACK, 'data', f + '.parquet'),
  packFile: (f) => path.join(PACK, f),
  helper: path.join(ROOT, 'hockey', 'tools', 'parquet_select.py'),
  BASE: __dirname,
  out: path.join(__dirname, 'published'),
  outFile: (f) => path.join(__dirname, 'published', f),
  frozen: path.join(__dirname, 'selection_frozen.json'),
  quotes: path.join(__dirname, 'market', 'quotes.json'),
};

/* minimal time a finished game takes to become an input: tip + 4 h, the same
   assumption basketball/walkforward.js uses. First-publication times are not in
   the pack, so this is an assumption, never a certified known_at. */
const AVAILABLE_AFTER_MS = 4 * 3600e3;
const PREDICT_BEFORE_MS = 30 * 60e3;

module.exports = { ROOT, PACK, RULES, SEASONS, WINDOWS, PATHS, AVAILABLE_AFTER_MS, PREDICT_BEFORE_MS };
