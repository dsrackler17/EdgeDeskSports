#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk MLB — reading the packaged pitcher dataset, and checking it.

   The package (mlb/pitchers/dataset) ships eight CSVs, a build report, a
   per-season validation table, a repair log and a source manifest. This module
   turns those into database rows and, before anything is written anywhere,
   RE-DERIVES the numbers it can from the counting statistics and compares
   them with what the file says.

   That distinction matters. The package's own `validation.csv` records that
   MLB's team splits reconciled with MLB's player totals at BUILD time. It says
   nothing about whether the file in this repository is the file that was
   built, or whether it survived compression, transfer and parsing intact. So
   this checks, from the bytes on disk:

     keys          (player_id, season) and (player_id, season, team_id) unique
     counts        every table's row count against build_report.json
     coverage      thirty clubs every season, ten seasons, no gaps
     innings       innings_display is exactly outs in baseball notation
     grains        the team splits SUM to the season row across 14 counting
                   fields — the check that catches a double-counted trade
     rates         ERA, WHIP, K/9, BB/9, HR/9, K%, BB%, K-BB% recomputed from
                   counting stats and outs
     rating        FIP and performance_index recomputed under ED_PITCH_PERF_V1
     baseline      each season's league ERA and FIP constant re-derived from
                   the league totals
     nulls         a zero-out record has NO ERA, FIP, WHIP or index — a blank
                   is undefined and is never read as a zero
     repairs       every player-season in source_repairs.json still carries the
                   number of club rows the repair says it should

   Nothing here contacts a network and nothing here writes. It reads files and
   returns rows plus a verdict, so the importer can refuse to publish and the
   tests can drive the same path with a fixture.
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const M = require('../../lib/mlb_pitcher_history.js');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DIR = path.join(ROOT, 'mlb', 'pitchers', 'dataset');

/* Tolerances, and why they are the size they are.

   The package publishes rates rounded to SIX decimal places, computed in
   Python. Re-deriving them here from the same integers reproduces the exact
   value — right up to a tie. Python rounds a half to even and JavaScript's
   Math.round rounds it up, so a rate whose seventh decimal is exactly 5
   (0.0703125 -> 0.070312 there, 0.070313 here) differs by one unit in the last
   published place. Three rows in the committed dataset do this.

   So the rate tolerance is ONE unit in the last published decimal, not zero.
   That is the largest disagreement a rounding convention can produce, and it
   is small enough that a genuinely wrong rate — a mis-parsed column, a
   truncated file, a swapped field — cannot hide behind it: those are wrong in
   the second or third decimal, thousands of times over, not in the sixth once.

   The index tolerance is looser again because performance_index compounds two
   already-rounded inputs through the shrinkage weight. The baseline is derived
   from raw league integers with no intermediate rounding, so it is exact. */
const TOL = { rate: 1.0000001e-6, index: 1e-3, baseline: 1e-6 };

/* The 14 counting fields MLB's own reconciliation covers. The team splits must
   sum to the season row across every one of them: this is the single check
   that would catch a traded pitcher's pre-trade club going missing, or his
   innings being counted twice. */
const RECONCILE_FIELDS = ['games', 'starts', 'outs', 'hits', 'runs', 'earned_runs', 'home_runs',
  'strikeouts', 'walks', 'intentional_walks', 'hit_batters', 'batters_faced', 'wild_pitches', 'balks'];

const INT_FIELDS = ['season', 'player_id', 'team_id', 'age', 'games', 'starts', 'outs', 'wins', 'losses',
  'saves', 'save_opportunities', 'holds', 'blown_saves', 'hits', 'runs', 'earned_runs', 'home_runs',
  'strikeouts', 'walks', 'intentional_walks', 'hit_batters', 'batters_faced', 'pitches', 'complete_games',
  'shutouts', 'inherited_runners', 'inherited_runners_scored', 'wild_pitches', 'balks', 'team_count',
  'first_observed_season', 'last_observed_season', 'seasons_with_appearances', 'observed_run_number',
  'best_season_by_index', 'pitchers', 'pitcher_team_rows', 'teams_count'];

const FLOAT_FIELDS = ['innings_decimal', 'era', 'whip', 'k_per_9', 'bb_per_9', 'hr_per_9', 'k_pct', 'bb_pct',
  'k_minus_bb_pct', 'fip', 'fip_constant', 'league_era', 'performance_index', 'rating_sample_weight',
  'weighted_performance_index', 'latest_observed_performance_index'];

const BOOL_FIELDS = ['boundary_start', 'boundary_end', 'player_totals_reconcile'];

/* ------------------------------------------------------------------ files */

function readMaybeGzip(file) {
  const gz = file + '.gz';
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz));
  return null;
}

function readText(dir, name) {
  const buf = readMaybeGzip(path.join(dir, name));
  if (buf == null) return null;
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);   // the CSVs carry a BOM for Excel
  return s;
}

function readJson(dir, name) {
  const s = readText(dir, name);
  if (s == null) return null;
  try { return JSON.parse(s); } catch (e) { throw new Error(`${name} is not valid JSON: ${e.message}`); }
}

/* ------------------------------------------------------------------- CSV */

/** RFC4180-ish: quoted fields, doubled quotes inside them, CRLF or LF. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  /* A blank means undefined or unavailable, NEVER an invented zero. This is
     the single most important line in the parser: substituting 0 for a blank
     ERA would turn "he recorded no outs" into "he was unhittable". */
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== '')).map(r => {
    const o = {};
    head.forEach((h, i) => {
      const raw = r[i];
      o[h] = (raw === undefined || raw === '') ? null : raw;
    });
    return o;
  });
}

function coerce(row) {
  const o = {};
  Object.keys(row).forEach(k => {
    const v = row[k];
    if (v == null) { o[k] = null; return; }
    if (INT_FIELDS.indexOf(k) >= 0) { const n = Number(v); o[k] = Number.isFinite(n) ? Math.round(n) : null; return; }
    if (FLOAT_FIELDS.indexOf(k) >= 0) { const n = Number(v); o[k] = Number.isFinite(n) ? n : null; return; }
    if (BOOL_FIELDS.indexOf(k) >= 0) { o[k] = /^(true|t|1|yes)$/i.test(String(v)); return; }
    o[k] = String(v);
  });
  return o;
}

function loadTable(dir, name) {
  const text = readText(dir, name + '.csv');
  if (text == null) return null;
  return parseCsv(text).map(coerce);
}

/* -------------------------------------------------------------- transform
   The transformations this import applies, recorded so they can be reported
   rather than discovered. Nothing here changes a measured value. */

const TRANSFORMATIONS = [
  { id: 'name_key', detail: 'A folded name key (lower case, accents stripped, punctuation and Jr./Sr./III removed) is '
    + 'added to every player-bearing table so a reader can find "Luis Garcia" when the record says "Luis García". '
    + 'The reported name is stored unchanged beside it and MLB ids remain the only join key.' },
  { id: 'team_ids_array', detail: 'pitcher_seasons.team_ids arrives as a semicolon-separated string and is stored as an '
    + 'integer array. No order is implied by either form.' },
  { id: 'booleans', detail: 'boundary_start / boundary_end / player_totals_reconcile arrive as the strings True/False '
    + 'and are stored as booleans.' },
  { id: 'blanks_are_null', detail: 'An empty CSV field is stored as NULL. No blank is replaced with zero, so a zero-out '
    + 'appearance keeps its counting statistics and has no ERA, FIP, WHIP or rating.' },
  { id: 'rating_version_stamped', detail: 'rating_version is stamped onto the summary tables (overview, team history, '
    + 'observed runs, league seasons), which carry ratings but not the version column, so no rated row can travel '
    + 'without the methodology that produced it.' },
  { id: 'provisional_flag', detail: 'A season imported before its regular season completed is flagged provisional, so a '
    + 'partial year can never be shown as a finished one.' }
];

/* ------------------------------------------------------------------ build */

/**
 * Read a dataset directory into database-shaped rows.
 *
 * opts.provisionalSeasons  seasons to mark provisional (default: none)
 * opts.importId            stamped onto every row
 */
function loadDataset(dir, opts) {
  opts = opts || {};
  const d = dir || DEFAULT_DIR;
  if (!fs.existsSync(d)) throw new Error(`no dataset directory at ${d}`);

  const report = readJson(d, 'build_report.json');
  const repairs = readJson(d, 'source_repairs.json') || [];
  const dictionary = readJson(d, 'data_dictionary.json');
  const manifest = readJson(d, 'source_manifest.json');

  const raw = {
    pitcher_seasons: loadTable(d, 'pitcher_seasons'),
    pitcher_team_seasons: loadTable(d, 'pitcher_team_seasons'),
    pitcher_overview: loadTable(d, 'pitcher_overview'),
    pitcher_team_history: loadTable(d, 'pitcher_team_history'),
    observed_team_runs: loadTable(d, 'observed_team_runs'),
    league_seasons: loadTable(d, 'league_seasons'),
    teams: loadTable(d, 'teams'),
    validation: loadTable(d, 'validation')
  };
  Object.keys(raw).forEach(k => { if (raw[k] == null) throw new Error(`${k}.csv is missing from ${d}`); });

  const importId = opts.importId || null;
  const provisional = new Set((opts.provisionalSeasons || []).map(Number));
  const ratingVersion = (raw.pitcher_seasons[0] && raw.pitcher_seasons[0].rating_version) || M.RATING_VERSION;

  const seasonsCovered = raw.pitcher_seasons.map(r => r.season).filter(s => s != null);
  const coverage = {
    start: report && report.start_season != null ? Number(report.start_season) : Math.min.apply(null, seasonsCovered),
    end: report && report.end_season != null ? Number(report.end_season) : Math.max.apply(null, seasonsCovered)
  };

  const stamp = (r, extra) => Object.assign({}, r, { import_id: importId }, extra || {});
  const withName = r => ({ name_key: M.nameKey(r.player_name) });

  const rows = {
    pitcher_seasons: raw.pitcher_seasons.map(r => stamp(r, Object.assign(withName(r), {
      team_ids: M.parseIdList(r.team_ids),
      rating_version: r.rating_version || ratingVersion,
      provisional: provisional.has(Number(r.season))
    }))),
    pitcher_team_seasons: raw.pitcher_team_seasons.map(r => stamp(r, Object.assign(withName(r), {
      rating_version: r.rating_version || ratingVersion,
      provisional: provisional.has(Number(r.season))
    }))),
    pitcher_overview: raw.pitcher_overview.map(r => stamp(r, Object.assign(withName(r), { rating_version: ratingVersion }))),
    pitcher_team_history: raw.pitcher_team_history.map(r => stamp(r, Object.assign(withName(r), { rating_version: ratingVersion }))),
    observed_team_runs: raw.observed_team_runs.map(r => stamp(r, Object.assign(withName(r), { rating_version: ratingVersion }))),
    league_seasons: raw.league_seasons.map(r => stamp(r, {
      rating_version: ratingVersion, provisional: provisional.has(Number(r.season))
    })),
    teams: raw.teams.map(r => stamp(r)),
    validation: raw.validation.map(r => stamp(r)),
    source_repairs: repairs.map(r => stamp({
      season: Number(r.season), player_id: Number(r.player_id),
      previous_team_rows: r.previous_team_rows == null ? null : Number(r.previous_team_rows),
      replacement_team_rows: r.replacement_team_rows == null ? null : Number(r.replacement_team_rows),
      source_url: r.source_url || null
    }))
  };

  /* pitcher_overview carries `teams` as a name list, and pitcher_team_history
     carries team_names_observed; both arrive as strings and stay strings. The
     column the record joins on is team_id, which is already an integer. */

  return {
    dir: d, report, dictionary, manifest, repairs, coverage,
    rating_version: ratingVersion,
    provisional_seasons: Array.from(provisional).sort(),
    transformations: TRANSFORMATIONS,
    counts: Object.keys(rows).reduce((a, k) => { a[k] = rows[k].length; return a; }, {}),
    rows
  };
}

/* --------------------------------------------------------------- validate */

function problem(list, code, detail, sample) {
  list.push({ code, detail, sample: sample === undefined ? null : sample });
}

/**
 * Check a loaded dataset from its own numbers. Returns
 *   { ok, checks: [{name, ok, detail}], problems: [...] }
 * `ok` false means DO NOT PUBLISH.
 */
function validateDataset(ds, opts) {
  opts = opts || {};
  const problems = [];
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || null }); return ok; };
  const seasons = ds.rows.pitcher_seasons;
  const teamSeasons = ds.rows.pitcher_team_seasons;

  /* 1. the package's declared counts ------------------------------------- */
  const expected = (ds.report && ds.report.tables) || {};
  const countMismatch = [];
  Object.keys(expected).forEach(k => {
    const got = ds.counts[k];
    if (got == null) return;
    if (Number(expected[k]) !== got) countMismatch.push(`${k}: report says ${expected[k]}, file holds ${got}`);
  });
  if (!add('row counts match build_report.json', countMismatch.length === 0, countMismatch.join('; ') || null)) {
    problem(problems, 'COUNT_MISMATCH', countMismatch.join('; '));
  }

  /* 2. unique keys -------------------------------------------------------- */
  const seenSeason = new Set(), dupSeason = [];
  seasons.forEach(r => {
    const k = `${r.player_id}|${r.season}`;
    if (seenSeason.has(k)) dupSeason.push(k); else seenSeason.add(k);
  });
  const seenTs = new Set(), dupTs = [];
  teamSeasons.forEach(r => {
    const k = `${r.player_id}|${r.season}|${r.team_id}`;
    if (seenTs.has(k)) dupTs.push(k); else seenTs.add(k);
  });
  if (!add('player-season and player-team-season keys are unique',
    dupSeason.length === 0 && dupTs.length === 0,
    dupSeason.length || dupTs.length ? `${dupSeason.length} duplicate player-seasons, ${dupTs.length} duplicate player-team-seasons` : null)) {
    problem(problems, 'DUPLICATE_KEY', `${dupSeason.length} player-season, ${dupTs.length} player-team-season`,
      dupSeason.slice(0, 3).concat(dupTs.slice(0, 3)));
  }

  /* 3. league coverage ---------------------------------------------------- */
  const teamsBySeason = {};
  ds.rows.teams.forEach(r => { (teamsBySeason[r.season] = teamsBySeason[r.season] || new Set()).add(r.team_id); });
  const shortSeasons = Object.keys(teamsBySeason).filter(s => teamsBySeason[s].size !== 30);
  if (!add('thirty clubs in every covered season', shortSeasons.length === 0,
    shortSeasons.length ? shortSeasons.map(s => `${s}: ${teamsBySeason[s].size}`).join(', ') : null)) {
    problem(problems, 'CLUB_COVERAGE', shortSeasons.join(', '));
  }
  const yearsPresent = Object.keys(teamsBySeason).map(Number).sort((a, b) => a - b);
  const expectedYears = [];
  for (let y = ds.coverage.start; y <= ds.coverage.end; y++) expectedYears.push(y);
  const missingYears = expectedYears.filter(y => yearsPresent.indexOf(y) < 0);
  if (!add('no missing season in the coverage window', missingYears.length === 0, missingYears.join(', ') || null)) {
    problem(problems, 'SEASON_GAP', missingYears.join(', '));
  }

  /* 4. innings notation --------------------------------------------------- */
  const ipBad = [];
  const checkIp = (r, label) => {
    if (r.outs == null) return;
    const want = M.inningsDisplay(r.outs);
    if (r.innings_display != null && String(r.innings_display) !== want) {
      ipBad.push(`${label} ${r.player_id}${r.season != null ? '/' + r.season : ''}: ${r.innings_display} vs ${want} from ${r.outs} outs`);
    }
    if (r.innings_decimal != null && Math.abs(r.innings_decimal - r.outs / 3) > 1e-5) {
      ipBad.push(`${label} ${r.player_id}: innings_decimal ${r.innings_decimal} vs ${r.outs / 3}`);
    }
  };
  seasons.forEach(r => checkIp(r, 'season'));
  teamSeasons.forEach(r => checkIp(r, 'team-season'));
  ds.rows.pitcher_overview.forEach(r => checkIp(r, 'overview'));
  if (!add('innings_display is exactly outs in baseball notation', ipBad.length === 0,
    ipBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'INNINGS_NOTATION', `${ipBad.length} rows disagree`, ipBad.slice(0, 5));
  }

  /* 5. the two grains reconcile ------------------------------------------ */
  const byKey = {};
  teamSeasons.forEach(r => {
    const k = `${r.player_id}|${r.season}`;
    const acc = byKey[k] || (byKey[k] = { n: 0 });
    acc.n++;
    RECONCILE_FIELDS.forEach(f => { acc[f] = (acc[f] || 0) + (r[f] == null ? 0 : r[f]); });
  });
  const grainBad = [];
  seasons.forEach(r => {
    const k = `${r.player_id}|${r.season}`;
    const acc = byKey[k];
    if (!acc) { grainBad.push(`${k}: season row with no club rows`); return; }
    RECONCILE_FIELDS.forEach(f => {
      const want = r[f] == null ? 0 : r[f];
      if (acc[f] !== want) grainBad.push(`${k}.${f}: season ${want} vs club sum ${acc[f]}`);
    });
  });
  const orphanClubs = Object.keys(byKey).filter(k => !seenSeason.has(k));
  orphanClubs.forEach(k => grainBad.push(`${k}: club rows with no season row`));
  if (!add('team splits sum exactly to the season row across 14 counting fields',
    grainBad.length === 0, grainBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'GRAIN_MISMATCH', `${grainBad.length} disagreements`, grainBad.slice(0, 5));
  }

  /* 6. rates recomputed from counting stats ------------------------------- */
  const rateBad = [];
  const checkRates = (r, label) => {
    const near = (got, want, field) => {
      if (got == null && want == null) return;
      if (got == null || want == null) { rateBad.push(`${label} ${r.player_id}/${r.season}: ${field} ${got} vs ${want}`); return; }
      if (Math.abs(got - want) > TOL.rate) rateBad.push(`${label} ${r.player_id}/${r.season}: ${field} ${got} vs ${want}`);
    };
    near(r.era, M.eraOf(r.earned_runs, r.outs), 'era');
    near(r.whip, M.whipOf(r.walks, r.hits, r.outs), 'whip');
    near(r.k_per_9, M.kPer9(r.strikeouts, r.outs), 'k_per_9');
    near(r.bb_per_9, M.bbPer9(r.walks, r.outs), 'bb_per_9');
    near(r.hr_per_9, M.hrPer9(r.home_runs, r.outs), 'hr_per_9');
    near(r.k_pct, M.kPct(r.strikeouts, r.batters_faced), 'k_pct');
    near(r.bb_pct, M.bbPct(r.walks, r.batters_faced), 'bb_pct');
    near(r.k_minus_bb_pct, M.kMinusBbPct(r.strikeouts, r.walks, r.batters_faced), 'k_minus_bb_pct');
  };
  seasons.forEach(r => checkRates(r, 'season'));
  teamSeasons.forEach(r => checkRates(r, 'team-season'));
  if (!add('ERA, WHIP, K/9, BB/9, HR/9, K%, BB% and K-BB% recompute from the counting stats',
    rateBad.length === 0, rateBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'RATE_MISMATCH', `${rateBad.length} rates disagree`, rateBad.slice(0, 5));
  }

  /* 7. the rating, under its own published formula ------------------------ */
  const ratingBad = [];
  const lgBySeason = {};
  ds.rows.league_seasons.forEach(r => { lgBySeason[r.season] = r; });
  const checkRating = (r, label) => {
    const lg = lgBySeason[r.season];
    if (!lg) { ratingBad.push(`${label} ${r.player_id}/${r.season}: no league baseline row`); return; }
    const wantFip = M.fipOf(r, lg.fip_constant);
    if ((r.fip == null) !== (wantFip == null) || (r.fip != null && Math.abs(r.fip - wantFip) > TOL.rate)) {
      ratingBad.push(`${label} ${r.player_id}/${r.season}: fip ${r.fip} vs ${wantFip}`);
    }
    const wantIdx = M.performanceIndex({ fip: r.fip, era: r.era, league_era: lg.league_era, outs: r.outs });
    if ((r.performance_index == null) !== (wantIdx == null)
      || (r.performance_index != null && Math.abs(r.performance_index - wantIdx) > TOL.index)) {
      ratingBad.push(`${label} ${r.player_id}/${r.season}: index ${r.performance_index} vs ${wantIdx}`);
    }
    const wantW = M.sampleWeight(r.outs);
    if (r.rating_sample_weight != null && wantW != null && Math.abs(r.rating_sample_weight - wantW) > TOL.rate) {
      ratingBad.push(`${label} ${r.player_id}/${r.season}: sample weight ${r.rating_sample_weight} vs ${wantW}`);
    }
    if (r.rating_version && r.rating_version !== M.RATING_VERSION) {
      ratingBad.push(`${label} ${r.player_id}/${r.season}: rating_version ${r.rating_version}`);
    }
  };
  seasons.forEach(r => checkRating(r, 'season'));
  teamSeasons.forEach(r => checkRating(r, 'team-season'));
  if (!add(`FIP and performance_index recompute under ${M.RATING_VERSION}`,
    ratingBad.length === 0, ratingBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'RATING_MISMATCH', `${ratingBad.length} ratings disagree`, ratingBad.slice(0, 5));
  }

  /* 8. the annual baseline itself ----------------------------------------- */
  const baselineBad = [];
  ds.rows.league_seasons.forEach(lg => {
    const ip = lg.outs / 3;
    const era = 9 * lg.earned_runs / ip;
    if (Math.abs(era - lg.league_era) > TOL.baseline) baselineBad.push(`${lg.season}: league_era ${lg.league_era} vs ${era}`);
    const k = era - (13 * lg.home_runs + 3 * (lg.walks + lg.hit_batters) - 2 * lg.strikeouts) / ip;
    if (Math.abs(k - lg.fip_constant) > TOL.baseline) baselineBad.push(`${lg.season}: fip_constant ${lg.fip_constant} vs ${k}`);
  });
  if (!add('each season’s league ERA and FIP constant re-derive from the league totals',
    baselineBad.length === 0, baselineBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'BASELINE_MISMATCH', baselineBad.join('; '));
  }

  /* 9. nulls preserved ---------------------------------------------------- */
  const nullBad = [];
  seasons.concat(teamSeasons).forEach(r => {
    if (r.outs === 0) {
      ['era', 'whip', 'fip', 'performance_index'].forEach(f => {
        if (r[f] != null) nullBad.push(`${r.player_id}/${r.season}: ${f} is ${r[f]} on a zero-out record`);
      });
      if (r.sample_flag !== 'zero_outs') nullBad.push(`${r.player_id}/${r.season}: sample_flag ${r.sample_flag} on zero outs`);
    }
  });
  if (!add('a zero-out record has no ERA, FIP, WHIP or rating', nullBad.length === 0, nullBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'NULL_NOT_PRESERVED', nullBad.join('; '));
  }

  /* 10. the package's own per-season reconciliation ------------------------ */
  const unreconciled = ds.rows.validation.filter(r => r.player_totals_reconcile !== true).map(r => r.season);
  if (!add('every season reconciled to MLB’s player totals at build time', unreconciled.length === 0,
    unreconciled.join(', ') || null)) {
    problem(problems, 'VALIDATION_FAILED', `seasons ${unreconciled.join(', ')}`);
  }
  /* validation.csv also states per-season pitcher and row counts; they must
     match what the tables actually hold, or the validation is describing a
     different build than the one in this folder. */
  const vBad = [];
  ds.rows.validation.forEach(v => {
    const nP = new Set(seasons.filter(r => r.season === v.season).map(r => r.player_id)).size;
    const nR = teamSeasons.filter(r => r.season === v.season).length;
    if (v.pitchers != null && v.pitchers !== nP) vBad.push(`${v.season}: validation says ${v.pitchers} pitchers, tables hold ${nP}`);
    if (v.pitcher_team_rows != null && v.pitcher_team_rows !== nR) vBad.push(`${v.season}: validation says ${v.pitcher_team_rows} club rows, tables hold ${nR}`);
  });
  if (!add('validation.csv per-season counts match the tables', vBad.length === 0, vBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'VALIDATION_COUNTS', vBad.join('; '));
  }

  /* 11. the source repairs survived -------------------------------------- */
  const repairBad = [];
  (ds.repairs || []).forEach(rep => {
    const n = teamSeasons.filter(r => r.player_id === Number(rep.player_id) && r.season === Number(rep.season)).length;
    if (rep.replacement_team_rows != null && n !== Number(rep.replacement_team_rows)) {
      repairBad.push(`${rep.player_id}/${rep.season}: repair expects ${rep.replacement_team_rows} club rows, tables hold ${n}`);
    }
  });
  if (!add('every repaired player-season still carries its replaced club rows',
    repairBad.length === 0, repairBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'REPAIR_LOST', repairBad.join('; '));
  }

  /* 12. overview agrees with the seasons it summarises --------------------- */
  const ovBad = [];
  const seasonsByPlayer = {};
  seasons.forEach(r => { (seasonsByPlayer[r.player_id] = seasonsByPlayer[r.player_id] || []).push(r); });
  ds.rows.pitcher_overview.forEach(ov => {
    const list = seasonsByPlayer[ov.player_id] || [];
    if (!list.length) { ovBad.push(`${ov.player_id}: overview row with no seasons`); return; }
    const outs = list.reduce((a, r) => a + (r.outs || 0), 0);
    if (ov.outs !== outs) ovBad.push(`${ov.player_id}: overview outs ${ov.outs} vs season sum ${outs}`);
    const years = list.map(r => r.season).sort((a, b) => a - b);
    if (ov.first_observed_season !== years[0]) ovBad.push(`${ov.player_id}: first season ${ov.first_observed_season} vs ${years[0]}`);
    if (ov.last_observed_season !== years[years.length - 1]) ovBad.push(`${ov.player_id}: last season ${ov.last_observed_season} vs ${years[years.length - 1]}`);
    if (ov.seasons_with_appearances !== new Set(years).size) {
      ovBad.push(`${ov.player_id}: seasons_with_appearances ${ov.seasons_with_appearances} vs ${new Set(years).size}`);
    }
  });
  if (!add('the career overview agrees with the seasons underneath it', ovBad.length === 0,
    ovBad.slice(0, 3).join('; ') || null)) {
    problem(problems, 'OVERVIEW_MISMATCH', `${ovBad.length} disagreements`, ovBad.slice(0, 5));
  }

  return {
    ok: problems.length === 0,
    checks,
    problems,
    summary: `${checks.filter(c => c.ok).length}/${checks.length} checks passed`
      + (problems.length ? `; ${problems.length} problem(s)` : '')
  };
}

/* The source snapshot this package was built from, as one stable fingerprint.
   The manifest lists every request with its retrieval time and SHA-256; the
   digest of that list is what gets stored, so a re-import from a different
   snapshot is visible in the ledger. */
function manifestFingerprint(manifest) {
  if (!manifest) return null;
  const crypto = require('crypto');
  const entries = Array.isArray(manifest) ? manifest : (manifest.requests || manifest.sources || []);
  const body = JSON.stringify(entries);
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

module.exports = {
  DEFAULT_DIR, TOL, RECONCILE_FIELDS, TRANSFORMATIONS,
  parseCsv, coerce, loadTable, readText, readJson, readMaybeGzip,
  loadDataset, validateDataset, manifestFingerprint
};

/* Run directly: read the committed dataset, check it, print the verdict. */
if (require.main === module) {
  const dirArg = process.argv.indexOf('--dir');
  const dir = dirArg > 0 ? process.argv[dirArg + 1] : DEFAULT_DIR;
  const ds = loadDataset(dir);
  const v = validateDataset(ds);
  console.log(`dataset: ${ds.dir}`);
  console.log(`coverage: ${ds.coverage.start}–${ds.coverage.end}   rating: ${ds.rating_version}`);
  Object.keys(ds.counts).forEach(k => console.log(`  ${k}: ${ds.counts[k]}`));
  console.log('');
  v.checks.forEach(c => console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`));
  console.log('');
  console.log(v.ok ? `ALL GREEN ${v.summary}` : `FAILED ${v.summary}`);
  process.exit(v.ok ? 0 : 1);
}
