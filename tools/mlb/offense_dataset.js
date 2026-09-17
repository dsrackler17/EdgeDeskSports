#!/usr/bin/env node
/* ===========================================================================
   THE PACKAGED MLB OFFENSIVE DATASET — loaded, and RE-DERIVED BEFORE IT IS
   TRUSTED.

   This does not check that the CSVs parse. It recomputes every published rate
   and every rating from the raw counting fields in the same file, checks the
   two player grains against each other, checks the club totals against their
   own games, and checks the package's counts against build_report.json. A
   dataset that disagrees with itself never reaches staging, let alone the
   live tables.

   WHY THE INDEX TOLERANCE IS NOT ZERO. The package is built in Python, which
   rounds half to even; this runs in JavaScript, where Math.round is half-up
   and the scaling multiply introduces its own representation error. On this
   dataset 282 of 8,166 rated rows land exactly on that boundary and differ by
   EXACTLY 0.001 — one unit in the last published place, in both directions.
   That is a rounding artefact, not a disagreement about the formula, and
   chasing it by replicating Python's float behaviour bit-for-bit would be a
   worse test than allowing one unit. The tolerance is one unit in the last
   PUBLISHED place and no more, so a genuinely wrong rating — which would be
   wrong by far more than a thousandth — still fails.

   Run: node tools/mlb/offense_dataset.js            (validate the committed copy)
        node tools/mlb/offense_dataset.js --dir <d>  (validate another build)
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const M = require('../../lib/mlb_offense_history.js');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DIR = path.join(ROOT, 'mlb', 'batters', 'dataset');

/* One unit in the last published place for each kind of field, and no more.
   Rates are published to six decimals, the index to three. */
const TOL = { rate: 1.0000001e-6, index: 1.0000001e-3, ratio: 1e-6 };

/* The 19 offensive counting fields the package reconciles player by player
   between the team splits and the separately fetched all-team totals. The two
   player grains must agree on every one of them. */
const RECONCILE_FIELDS = ['plate_appearances', 'at_bats', 'runs', 'hits', 'doubles', 'triples',
  'home_runs', 'rbi', 'walks', 'intentional_walks', 'strikeouts', 'hit_by_pitch', 'stolen_bases',
  'caught_stealing', 'total_bases', 'sacrifice_bunts', 'sacrifice_flies',
  'grounded_into_double_play', 'catcher_interference'];

const INT_FIELDS = ['season', 'player_id', 'team_id', 'age', 'games', 'team_split_games_sum',
  'plate_appearances', 'at_bats', 'runs', 'hits', 'singles', 'doubles', 'triples', 'home_runs', 'rbi',
  'walks', 'intentional_walks', 'strikeouts', 'hit_by_pitch', 'stolen_bases', 'caught_stealing',
  'total_bases', 'sacrifice_bunts', 'sacrifice_flies', 'grounded_into_double_play',
  'catcher_interference', 'pitches_seen', 'team_count', 'first_observed_season', 'last_observed_season',
  'seasons_with_records', 'seasons_with_PA', 'rated_plate_appearances', 'best_season_by_index',
  'observed_run_number', 'player_games_sum', 'players_with_records', 'team_games', 'teams', 'players',
  'player_team_rows', 'counting_fields_reconciled', 'previous_team_rows', 'replacement_team_rows',
  'official_games'];

const FLOAT_FIELDS = ['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'k_pct', 'bb_pct', 'hr_pct',
  'sb_success_pct', 'league_obp', 'league_slg', 'rating_sample_weight', 'offensive_index',
  'weighted_offensive_index', 'latest_observed_offensive_index', 'runs_per_game'];

const BOOL_FIELDS = ['boundary_start', 'boundary_end', 'player_totals_reconcile', 'team_totals_reconcile'];

/* The table files, and the build_report key each one's count is checked
   against. `teams` is deliberately absent: the offensive package ships a
   teams.csv identical to the pitching archive's, and the importer reuses the
   one already in mlbhist rather than writing a second copy. */
const TABLES = [
  { name: 'batter_seasons', report: 'batter_seasons' },
  { name: 'batter_team_seasons', report: 'batter_team_seasons' },
  { name: 'batter_overview', report: 'batter_overview' },
  { name: 'batter_team_history', report: 'batter_team_history' },
  { name: 'observed_team_runs', report: 'observed_team_runs' },
  { name: 'team_offense_seasons', report: 'team_offense_seasons' },
  { name: 'team_offense_overview', report: 'team_offense_overview' },
  { name: 'league_seasons', report: 'league_seasons' }
];

/* What the importer DERIVES rather than reads, and why. Recorded on the import
   run so an auditor can see every place the shipped file and the live table
   differ, and check the reasoning. */
const TRANSFORMATIONS = [
  { field: 'name_key',
    tables: ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
      'observed_batter_team_runs'],
    reason: 'Accent-folded player name, derived from player_name for resolution. The package ships no '
      + 'folded key, and MLB ids remain the join key — this is only for name lookup.' },
  { field: 'teams / team_count (batter_overview only)',
    tables: ['batter_overview'],
    reason: 'The package ships both blank on all 3,097 overview rows while carrying the clubs correctly at '
      + 'the team grain. The importer rebuilds them from batter_team_history IN THE SAME PACKAGE, ordered by '
      + 'plate appearances. Nothing is inferred from outside the dataset, and the per-club rows are the '
      + 'authority either way.' },
  { field: 'provisional',
    tables: ['batter_seasons', 'batter_team_seasons', 'team_offense_seasons', 'league_offense_seasons'],
    reason: 'True for any season imported before its regular season finished. Not a source field.' }
];

/* ---- reading ---------------------------------------------------------- */

function readMaybeGzip(file) {
  if (fs.existsSync(file + '.gz')) return zlib.gunzipSync(fs.readFileSync(file + '.gz')).toString('utf8');
  return fs.readFileSync(file, 'utf8');
}
function readText(dir, name) { return readMaybeGzip(path.join(dir, name)); }
function readJson(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p) && fs.existsSync(p + '.gz')) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(p + '.gz')).toString('utf8'));
  }
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* A CSV reader that handles what these files actually are: UTF-8 WITH BOM for
   Excel, CRLF line endings, and quoted fields containing commas. Getting the
   BOM or the CR wrong does not fail loudly — it silently renames the first and
   last columns, and every lookup against them returns undefined. That is
   exactly the bug this parser exists to prevent. */
function parseCsv(text) {
  const t = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.length && r.some((v) => v !== '')).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i] === undefined || r[i] === '' ? null : r[i]; });
    return o;
  });
}

/* Blank stays null. A zero substituted for an undefined rate is the single
   most damaging thing this loader could do. */
function coerce(row) {
  const o = {};
  Object.keys(row).forEach((k) => {
    const v = row[k];
    if (v === null) { o[k] = null; return; }
    if (BOOL_FIELDS.indexOf(k) >= 0) { o[k] = /^(true|1|t|yes)$/i.test(String(v)); return; }
    if (INT_FIELDS.indexOf(k) >= 0) { const n = Number(v); o[k] = isFinite(n) ? Math.round(n) : null; return; }
    if (FLOAT_FIELDS.indexOf(k) >= 0) { const n = Number(v); o[k] = isFinite(n) ? n : null; return; }
    o[k] = String(v);
  });
  return o;
}
function loadTable(dir, name) {
  const file = path.join(dir, name + '.csv');
  if (!fs.existsSync(file) && !fs.existsSync(file + '.gz')) {
    throw new Error('missing table file: ' + name + '.csv[.gz] in ' + dir);
  }
  return parseCsv(readText(dir, name + '.csv')).map(coerce);
}

function loadDataset(dir, opts) {
  opts = opts || {};
  dir = dir || DEFAULT_DIR;
  const report = readJson(dir, 'build_report.json');
  if (!report) throw new Error('missing build_report.json in ' + dir);

  const tables = {};
  TABLES.forEach((t) => { tables[t.name] = loadTable(dir, t.name); });

  const validation = parseCsv(readText(dir, 'validation.csv')).map(coerce);
  const repairs = readJson(dir, 'source_repairs.json') || [];
  const gamesRecon = readJson(dir, 'games_reconciliation_notes.json') || [];
  const dictionary = readJson(dir, 'data_dictionary.json') || null;
  let manifest = null;
  try { manifest = readJson(dir, 'source_manifest.json'); } catch (e) { manifest = null; }

  const coverage = {
    start: report.start_season != null ? Number(report.start_season)
      : Math.min.apply(null, tables.batter_seasons.map((r) => r.season)),
    end: report.end_season != null ? Number(report.end_season)
      : Math.max.apply(null, tables.batter_seasons.map((r) => r.season))
  };
  const provisional = (opts.provisionalSeasons || []).map(Number).filter((n) => isFinite(n));

  return {
    dir: dir,
    tables: tables,
    validation: validation,
    repairs: repairs,
    games_reconciliation: gamesRecon,
    dictionary: dictionary,
    manifest: manifest,
    report: report,
    coverage: coverage,
    provisional_seasons: provisional,
    rating_version: M.RATING_VERSION,
    source: 'MLB Stats API (statsapi.mlb.com/api/v1), regular season, sport 1, game type R, player pool ALL',
    built_at: report.built_at_utc || null,
    import_id: opts.importId || null,
    transformations: TRANSFORMATIONS
  };
}

/* ---- validating -------------------------------------------------------- */

function problem(list, code, detail, sample) {
  list.push({ code: code, detail: detail, sample: sample === undefined ? null : sample });
}
function near(a, b, tol) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

function validateDataset(ds, opts) {
  opts = opts || {};
  const problems = [];
  const checks = {};
  const T = ds.tables;

  /* 1 — the package's own counts. */
  const countsOk = [];
  TABLES.forEach((t) => {
    const want = ds.report.tables ? ds.report.tables[t.report] : null;
    const got = T[t.name].length;
    checks['count_' + t.name] = got;
    if (want != null && Number(want) !== got) {
      problem(problems, 'COUNT_MISMATCH', t.name + ': build_report says ' + want + ', file has ' + got);
    } else countsOk.push(t.name);
  });
  checks.counts_agreeing = countsOk.length;

  /* 2 — the keys the record depends on. */
  function dupes(rows, keyFn) {
    const seen = Object.create(null); const out = [];
    rows.forEach((r) => { const k = keyFn(r); if (seen[k]) out.push(k); else seen[k] = 1; });
    return out;
  }
  const dupSeason = dupes(T.batter_seasons, (r) => r.player_id + '|' + r.season);
  const dupTeamSeason = dupes(T.batter_team_seasons, (r) => r.player_id + '|' + r.season + '|' + r.team_id);
  const dupOverview = dupes(T.batter_overview, (r) => String(r.player_id));
  const dupTeamHistory = dupes(T.batter_team_history, (r) => r.player_id + '|' + r.team_id);
  const dupTeamOffense = dupes(T.team_offense_seasons, (r) => r.season + '|' + r.team_id);
  const dupLeague = dupes(T.league_seasons, (r) => String(r.season));
  if (dupSeason.length) problem(problems, 'DUPLICATE_KEY', dupSeason.length + ' duplicate (player_id, season)', dupSeason.slice(0, 3));
  if (dupTeamSeason.length) problem(problems, 'DUPLICATE_KEY', dupTeamSeason.length + ' duplicate (player_id, season, team_id)', dupTeamSeason.slice(0, 3));
  if (dupOverview.length) problem(problems, 'DUPLICATE_KEY', dupOverview.length + ' duplicate player_id in batter_overview', dupOverview.slice(0, 3));
  if (dupTeamHistory.length) problem(problems, 'DUPLICATE_KEY', dupTeamHistory.length + ' duplicate (player_id, team_id)', dupTeamHistory.slice(0, 3));
  if (dupTeamOffense.length) problem(problems, 'DUPLICATE_KEY', dupTeamOffense.length + ' duplicate (season, team_id)', dupTeamOffense.slice(0, 3));
  if (dupLeague.length) problem(problems, 'DUPLICATE_KEY', dupLeague.length + ' duplicate season in league_seasons', dupLeague.slice(0, 3));
  checks.unique_keys = !dupSeason.length && !dupTeamSeason.length && !dupOverview.length
    && !dupTeamHistory.length && !dupTeamOffense.length && !dupLeague.length;

  /* 3 — EVERY RATE, RE-DERIVED from the counting fields in the same row. */
  const rateBad = {};
  const RATE_CHECKS = [
    ['avg', (r) => M.avgOf(r.hits, r.at_bats), TOL.rate],
    ['obp', (r) => M.obpOf(r), TOL.rate],
    ['slg', (r) => M.slgOf(r.total_bases, r.at_bats), TOL.rate],
    ['ops', (r) => M.opsOf(r), TOL.rate],
    ['iso', (r) => M.isoOf(r.total_bases, r.hits, r.at_bats), TOL.rate],
    ['babip', (r) => M.babipOf(r), TOL.rate],
    ['k_pct', (r) => M.kPct(r.strikeouts, r.plate_appearances), TOL.rate],
    ['bb_pct', (r) => M.bbPct(r.walks, r.plate_appearances), TOL.rate],
    ['hr_pct', (r) => M.hrPct(r.home_runs, r.plate_appearances), TOL.rate],
    ['sb_success_pct', (r) => M.sbSuccess(r.stolen_bases, r.caught_stealing), TOL.rate]
  ];
  let rateRows = 0;
  ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
    'observed_team_runs', 'team_offense_seasons', 'team_offense_overview', 'league_seasons'].forEach((tbl) => {
    T[tbl].forEach((r) => {
      rateRows++;
      RATE_CHECKS.forEach((c) => {
        if (!near(c[1](r), r[c[0]], c[2])) rateBad[tbl + '.' + c[0]] = (rateBad[tbl + '.' + c[0]] || 0) + 1;
      });
    });
  });
  checks.rate_rows_rederived = rateRows;
  Object.keys(rateBad).forEach((k) => {
    problem(problems, 'RATE_MISMATCH', k + ': ' + rateBad[k] + ' row(s) do not re-derive from their own counts');
  });

  /* 4 — the identities the counting fields must satisfy. */
  let tbBad = 0, singlesBad = 0;
  ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'team_offense_seasons'].forEach((tbl) => {
    T[tbl].forEach((r) => {
      const s = M.singlesOf(r);
      if (r.singles != null && s != null && r.singles !== s) singlesBad++;
      const tb = M.totalBasesOf(r);
      if (r.total_bases != null && tb != null && r.total_bases !== tb) tbBad++;
    });
  });
  if (singlesBad) problem(problems, 'IDENTITY_MISMATCH', singlesBad + ' row(s) where singles <> H - 2B - 3B - HR');
  if (tbBad) problem(problems, 'IDENTITY_MISMATCH', tbBad + ' row(s) where total_bases <> 1B + 2*2B + 3*3B + 4*HR');
  checks.total_base_identity = !tbBad && !singlesBad;

  /* 5 — THE RATING, re-derived, and the shrinkage that produced it. */
  let idxBad = 0, idxOff = 0, wBad = 0, flagBad = 0, rated = 0;
  ['batter_seasons', 'batter_team_seasons', 'team_offense_seasons'].forEach((tbl) => {
    T[tbl].forEach((r) => {
      if (!near(M.sampleWeight(r.plate_appearances), r.rating_sample_weight, TOL.rate)) wBad++;
      if (r.rating_version && r.rating_version !== M.RATING_VERSION) idxOff++;
      const want = r.offensive_index;
      const got = M.offensiveIndex(r);
      if (want != null) rated++;
      if (!near(got, want, TOL.index)) idxBad++;
    });
  });
  ['batter_seasons', 'batter_team_seasons', 'batter_overview', 'batter_team_history',
    'observed_team_runs', 'team_offense_seasons'].forEach((tbl) => {
    T[tbl].forEach((r) => {
      if (r.plate_appearances != null && M.sampleFlagOf(r.plate_appearances) !== r.sample_flag) flagBad++;
    });
  });
  if (idxBad) problem(problems, 'RATING_MISMATCH', idxBad + ' rating(s) do not re-derive within one unit in the last published place');
  if (wBad) problem(problems, 'RATING_MISMATCH', wBad + ' shrinkage weight(s) are not PA/(PA+200)');
  if (idxOff) problem(problems, 'RATING_VERSION', idxOff + ' row(s) carry a rating_version other than ' + M.RATING_VERSION);
  if (flagBad) problem(problems, 'SAMPLE_FLAG', flagBad + ' row(s) carry a sample_flag that does not match their plate appearances');
  checks.ratings_rederived = rated;

  /* 6 — NULL MEANS UNDEFINED. A zero-PA row has no rates and no rating; a
         walk-only row has an OBP and no SLG, OPS or rating. Both are real
         shapes in this dataset and both are load-bearing. */
  let zeroPaBad = 0, zeroPa = 0, walkOnly = 0, walkOnlyBad = 0;
  T.batter_seasons.forEach((r) => {
    if (r.plate_appearances === 0) {
      zeroPa++;
      if (r.avg != null || r.obp != null || r.slg != null || r.ops != null || r.offensive_index != null) zeroPaBad++;
      if (r.sample_flag !== 'zero_PA') zeroPaBad++;
    }
    if (r.at_bats === 0 && r.walks > 0) {
      walkOnly++;
      if (r.obp == null) walkOnlyBad++;              /* OBP is DEFINED here */
      if (r.slg != null || r.ops != null || r.offensive_index != null) walkOnlyBad++;
    }
  });
  if (zeroPaBad) problem(problems, 'UNDEFINED_AS_ZERO', zeroPaBad + ' zero-PA row(s) carry a rate or rating that should be undefined');
  if (walkOnlyBad) problem(problems, 'UNDEFINED_AS_ZERO', walkOnlyBad + ' walk-only row(s) have the wrong defined/undefined shape');
  checks.zero_pa_rows = zeroPa;
  checks.walk_only_rows = walkOnly;

  /* 7 — THE TWO GRAINS. batter_seasons is the combined total and
         batter_team_seasons is the same performance split by club. They must
         agree on every reconciled counting field, and they must NEVER be
         added together. This is the check that catches a lost traded club. */
  const splitBy = Object.create(null);
  T.batter_team_seasons.forEach((r) => {
    const k = r.player_id + '|' + r.season;
    const acc = splitBy[k] || (splitBy[k] = { n: 0, games: 0 });
    acc.n++;
    RECONCILE_FIELDS.forEach((f) => { acc[f] = (acc[f] || 0) + (r[f] == null ? 0 : r[f]); });
    acc.games += (r.games == null ? 0 : r.games);
  });
  const grainBad = {}; let grainRows = 0, tradedRows = 0;
  T.batter_seasons.forEach((r) => {
    const acc = splitBy[r.player_id + '|' + r.season];
    if (!acc) { problem(problems, 'GRAIN_MISSING', 'player-season ' + r.player_id + '/' + r.season + ' has no team splits'); return; }
    grainRows++;
    if (acc.n > 1) tradedRows++;
    RECONCILE_FIELDS.forEach((f) => {
      const want = r[f] == null ? 0 : r[f];
      if (want !== acc[f]) grainBad[f] = (grainBad[f] || 0) + 1;
    });
    /* team_count and team_ids must describe the splits that actually exist. */
    if (r.team_count != null && r.team_count !== acc.n) {
      grainBad.team_count = (grainBad.team_count || 0) + 1;
    }
  });
  Object.keys(grainBad).forEach((f) => {
    problem(problems, 'GRAIN_MISMATCH', f + ': ' + grainBad[f] + ' player-season(s) disagree with the sum of their own team splits');
  });
  checks.player_seasons_with_splits = grainRows;
  checks.traded_player_seasons = tradedRows;

  /* 8 — THE THREE GAME COUNTS, kept distinct. games is MLB's official
         player-season count; team_split_games_sum is the sum of the splits;
         the documented differences between them are preserved rather than
         reconciled away. */
  const gamesDiff = [];
  T.batter_seasons.forEach((r) => {
    const acc = splitBy[r.player_id + '|' + r.season];
    if (!acc) return;
    if (r.team_split_games_sum != null && r.team_split_games_sum !== acc.games) {
      problem(problems, 'GAMES_SUM_MISMATCH',
        'player-season ' + r.player_id + '/' + r.season + ' team_split_games_sum does not equal the sum of its splits');
    }
    if (r.games != null && r.team_split_games_sum != null && r.games !== r.team_split_games_sum) {
      gamesDiff.push({ season: r.season, player_id: r.player_id,
        official_games: r.games, team_split_games_sum: r.team_split_games_sum });
    }
  });
  checks.games_field_differences = gamesDiff.length;
  const declaredDiffs = ds.report.games_field_differences;
  if (declaredDiffs != null && Number(declaredDiffs) !== gamesDiff.length) {
    problem(problems, 'GAMES_DIFF_COUNT',
      'build_report declares ' + declaredDiffs + ' games-field difference(s), the data has ' + gamesDiff.length);
  }
  /* And the note file must describe exactly those rows. */
  const noteKeys = (ds.games_reconciliation || []).map((n) => n.season + '|' + n.player_id).sort();
  const foundKeys = gamesDiff.map((n) => n.season + '|' + n.player_id).sort();
  if (noteKeys.join(',') !== foundKeys.join(',')) {
    problem(problems, 'GAMES_DIFF_NOTES',
      'games_reconciliation_notes.json does not describe the same rows the data disagrees on',
      { notes: noteKeys.slice(0, 4), found: foundKeys.slice(0, 4) });
  }
  (ds.games_reconciliation || []).forEach((n) => {
    const hit = gamesDiff.filter((g) => g.season === Number(n.season) && g.player_id === Number(n.player_id))[0];
    if (hit && (hit.official_games !== Number(n.official_games)
      || hit.team_split_games_sum !== Number(n.team_split_games_sum))) {
      problem(problems, 'GAMES_DIFF_VALUES', 'the note for ' + n.player_id + '/' + n.season + ' disagrees with the data');
    }
  });

  /* 9 — THE LEAGUE BASELINE every rating was computed against. The value
         stamped on a season row must be the league row for that same season,
         and the league row's own rates must re-derive. */
  const lg = Object.create(null);
  T.league_seasons.forEach((r) => { lg[r.season] = r; });
  let baselineBad = 0;
  T.batter_seasons.forEach((r) => {
    const l = lg[r.season];
    if (!l) { baselineBad++; return; }
    if (!near(r.league_obp, l.obp, TOL.ratio) || !near(r.league_slg, l.slg, TOL.ratio)) baselineBad++;
  });
  if (baselineBad) {
    problem(problems, 'BASELINE_MISMATCH',
      baselineBad + ' season row(s) carry a league baseline that is not their own season’s league row');
  }
  checks.league_seasons = T.league_seasons.length;

  /* 10 — CLUB TOTALS. runs_per_game uses the club's ACTUAL games, and
          player_games_sum is emphatically not that. */
  let rpgBad = 0, pgsEqTg = 0;
  T.team_offense_seasons.forEach((r) => {
    if (r.team_games != null && r.team_games > 0 && r.runs != null) {
      if (!near(r.runs / r.team_games, r.runs_per_game, TOL.ratio)) rpgBad++;
    }
    if (r.player_games_sum != null && r.team_games != null && r.player_games_sum === r.team_games) pgsEqTg++;
  });
  if (rpgBad) problem(problems, 'RPG_MISMATCH', rpgBad + ' club-season(s) where runs_per_game <> runs / team_games');
  checks.club_seasons = T.team_offense_seasons.length;
  /* Not a failure, but recorded: if these two were ever equal it would mean the
     package had conflated them, and every runs-per-game on the site would be
     wrong in a way nobody would notice. */
  checks.player_games_sum_equals_team_games = pgsEqTg;
  if (pgsEqTg > 0) {
    problem(problems, 'GAME_COUNT_CONFLATED',
      pgsEqTg + ' club-season(s) have player_games_sum equal to team_games, which suggests the two were conflated');
  }

  /* 11 — every club-season present for every covered season, and the club
          identity resolvable. */
  const seasons = Object.keys(lg).map(Number).sort();
  const perSeason = Object.create(null);
  T.team_offense_seasons.forEach((r) => { perSeason[r.season] = (perSeason[r.season] || 0) + 1; });
  seasons.forEach((s) => {
    if (perSeason[s] !== 30) {
      problem(problems, 'CLUB_COVERAGE', s + ' has ' + (perSeason[s] || 0) + ' club-seasons, expected 30');
    }
  });
  checks.seasons_covered = seasons.length;

  /* 12 — the package's own per-season verification must PASS, at both grains. */
  let vBadPlayers = 0, vBadTeams = 0, vFields = 0;
  ds.validation.forEach((v) => {
    if (v.player_totals_reconcile !== true) vBadPlayers++;
    if (v.team_totals_reconcile !== true) vBadTeams++;
    if (v.counting_fields_reconciled != null && Number(v.counting_fields_reconciled) !== RECONCILE_FIELDS.length) vFields++;
  });
  if (vBadPlayers) problem(problems, 'VALIDATION_FAILED', vBadPlayers + ' season(s) failed the package player reconciliation');
  if (vBadTeams) problem(problems, 'VALIDATION_FAILED', vBadTeams + ' season(s) failed the package team reconciliation');
  if (vFields) {
    problem(problems, 'VALIDATION_FIELDS',
      vFields + ' season(s) reconciled a different number of counting fields than the ' + RECONCILE_FIELDS.length + ' this loader checks');
  }
  checks.validation_seasons = ds.validation.length;

  /* 13 — the validation table's own counts must match the data it describes. */
  const playersPerSeason = Object.create(null), rowsPerSeason = Object.create(null);
  T.batter_seasons.forEach((r) => { playersPerSeason[r.season] = (playersPerSeason[r.season] || 0) + 1; });
  T.batter_team_seasons.forEach((r) => { rowsPerSeason[r.season] = (rowsPerSeason[r.season] || 0) + 1; });
  ds.validation.forEach((v) => {
    if (v.players != null && playersPerSeason[v.season] !== v.players) {
      problem(problems, 'VALIDATION_COUNT', v.season + ': validation says ' + v.players + ' players, data has ' + (playersPerSeason[v.season] || 0));
    }
    if (v.player_team_rows != null && rowsPerSeason[v.season] !== v.player_team_rows) {
      problem(problems, 'VALIDATION_COUNT', v.season + ': validation says ' + v.player_team_rows + ' player-team rows, data has ' + (rowsPerSeason[v.season] || 0));
    }
  });

  /* 14 — the source repairs are declared, counted, and point at real rows. */
  const declaredRepairs = ds.report.individual_history_repairs;
  if (declaredRepairs != null && Number(declaredRepairs) !== ds.repairs.length) {
    problem(problems, 'REPAIR_COUNT', 'build_report declares ' + declaredRepairs + ' repairs, source_repairs.json has ' + ds.repairs.length);
  }
  let repairMissing = 0;
  ds.repairs.forEach((r) => {
    const hit = T.batter_seasons.filter((x) => x.player_id === Number(r.player_id) && x.season === Number(r.season))[0];
    if (!hit) { repairMissing++; return; }
    const acc = splitBy[r.player_id + '|' + r.season];
    if (acc && r.replacement_team_rows != null && acc.n !== Number(r.replacement_team_rows)) {
      problem(problems, 'REPAIR_ROWS',
        'repair for ' + r.player_id + '/' + r.season + ' says ' + r.replacement_team_rows
        + ' team rows, the data has ' + acc.n);
    }
  });
  if (repairMissing) problem(problems, 'REPAIR_MISSING', repairMissing + ' repaired player-season(s) are not in the data');
  checks.source_repairs = ds.repairs.length;

  /* 15 — the overview grain, checked against the seasons it summarises. */
  const seasonBy = Object.create(null);
  T.batter_seasons.forEach((r) => { (seasonBy[r.player_id] = seasonBy[r.player_id] || []).push(r); });
  let ovBad = 0, ovWindowBad = 0;
  T.batter_overview.forEach((r) => {
    const list = seasonBy[r.player_id];
    if (!list) { ovBad++; return; }
    RECONCILE_FIELDS.forEach((f) => {
      const sum = list.reduce((a, x) => a + (x[f] == null ? 0 : x[f]), 0);
      if ((r[f] == null ? 0 : r[f]) !== sum) ovBad++;
    });
    const first = Math.min.apply(null, list.map((x) => x.season));
    const last = Math.max.apply(null, list.map((x) => x.season));
    if (r.first_observed_season !== first || r.last_observed_season !== last) ovWindowBad++;
    const withPa = list.filter((x) => x.plate_appearances > 0).length;
    if (r.seasons_with_PA != null && r.seasons_with_PA !== withPa) ovWindowBad++;
    if (r.seasons_with_records != null && r.seasons_with_records !== list.length) ovWindowBad++;
  });
  if (ovBad) problem(problems, 'OVERVIEW_MISMATCH', ovBad + ' overview field(s) disagree with the sum of that player’s seasons');
  if (ovWindowBad) problem(problems, 'OVERVIEW_WINDOW', ovWindowBad + ' overview window field(s) disagree with the seasons present');
  checks.batters = T.batter_overview.length;
  checks.batters_with_pa = T.batter_overview.filter((r) => r.plate_appearances > 0).length;

  /* 16 — the counts build_report advertises about the player universe. */
  if (ds.report.unique_players != null && Number(ds.report.unique_players) !== T.batter_overview.length) {
    problem(problems, 'UNIVERSE_COUNT', 'build_report says ' + ds.report.unique_players + ' players, overview has ' + T.batter_overview.length);
  }
  if (ds.report.players_with_PA != null && Number(ds.report.players_with_PA) !== checks.batters_with_pa) {
    problem(problems, 'UNIVERSE_COUNT', 'build_report says ' + ds.report.players_with_PA + ' players with PA, data has ' + checks.batters_with_pa);
  }

  /* 17 — THE DEFECT THIS PACKAGE SHIPS, recorded rather than silently fixed.
          batter_overview.teams and .team_count are blank on every row while
          batter_team_history carries the clubs correctly. The importer rebuilds
          them; this records that it had to. */
  const blankTeams = T.batter_overview.filter((r) => !r.teams).length;
  const zeroTeamCount = T.batter_overview.filter((r) => !r.team_count).length;
  checks.overview_blank_teams = blankTeams;
  checks.overview_zero_team_count = zeroTeamCount;
  if (blankTeams || zeroTeamCount) {
    checks.overview_clubs_derived = true;
    /* Not a failure: the information is in the package at the team grain and the
       importer rebuilds it from there. It IS a finding, and it is reported. */
  }
  const historyBy = Object.create(null);
  T.batter_team_history.forEach((r) => { (historyBy[r.player_id] = historyBy[r.player_id] || []).push(r); });
  let noHistory = 0;
  T.batter_overview.forEach((r) => { if (!historyBy[r.player_id]) noHistory++; });
  if (noHistory) {
    problem(problems, 'OVERVIEW_NO_CLUBS',
      noHistory + ' player(s) have an overview row but no club rows, so their club list cannot be rebuilt');
  }

  const ok = problems.length === 0;
  return { ok: ok, problems: problems, checks: checks, coverage: ds.coverage,
    rating_version: ds.rating_version, transformations: ds.transformations };
}

/* ---- the manifest fingerprint ------------------------------------------ */

function manifestFingerprint(manifest) {
  if (!manifest) return null;
  const crypto = require('crypto');
  const entries = Array.isArray(manifest) ? manifest : (manifest.sources || manifest.files || []);
  const text = JSON.stringify(entries);
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  DEFAULT_DIR, TABLES, TOL, RECONCILE_FIELDS, TRANSFORMATIONS,
  parseCsv, coerce, loadTable, loadDataset, validateDataset, manifestFingerprint
};

/* ---- cli --------------------------------------------------------------- */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const dirAt = argv.indexOf('--dir');
  const dir = dirAt >= 0 ? argv[dirAt + 1] : DEFAULT_DIR;
  let ds;
  try { ds = loadDataset(dir); }
  catch (e) { console.log('FAIL | offensive dataset | ' + e.message); process.exit(1); }
  const v = validateDataset(ds);
  const c = v.checks;
  console.log('MLB offensive dataset ' + ds.coverage.start + '–' + ds.coverage.end
    + '  (' + ds.rating_version + ', built ' + (ds.built_at || 'unknown') + ')');
  console.log('  batter-seasons        ' + c.count_batter_seasons);
  console.log('  batter-team-seasons   ' + c.count_batter_team_seasons
    + '   (' + c.traded_player_seasons + ' player-seasons with more than one club)');
  console.log('  batters               ' + c.batters + '   (' + c.batters_with_pa + ' with a plate appearance)');
  console.log('  club-seasons          ' + c.club_seasons + '   league seasons ' + c.league_seasons);
  console.log('  rates re-derived      ' + c.rate_rows_rederived + ' rows');
  console.log('  ratings re-derived    ' + c.ratings_rederived);
  console.log('  zero-PA rows          ' + c.zero_pa_rows + '   walk-only rows ' + c.walk_only_rows);
  console.log('  games-field diffs     ' + c.games_field_differences + '   source repairs ' + c.source_repairs);
  if (c.overview_clubs_derived) {
    console.log('  NOTE: batter_overview ships teams blank on ' + c.overview_blank_teams
      + ' row(s) and team_count zero on ' + c.overview_zero_team_count
      + '; the importer rebuilds both from batter_team_history in the same package.');
  }
  if (!v.ok) {
    console.log('\nFAIL | offensive dataset | ' + v.problems.length + ' problem(s)');
    v.problems.slice(0, 20).forEach((p) => console.log('  ✗ ' + p.code + ' — ' + p.detail));
    process.exit(1);
  }
  console.log('\nPASS | offensive dataset | re-derived from its own numbers, every check clean');
}
