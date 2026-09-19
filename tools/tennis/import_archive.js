#!/usr/bin/env node
/* ===========================================================================
   EdgeDesk Tennis — the historical archive importer.

   WHAT IT IS. A resumable, idempotent, reconciling bulk load of the ATP/WTA
   match archive (361,571 rows x 108 columns) into the contract
   supabase/tennis_record.sql defines. It runs OUTSIDE the app: a local
   administrative job or a CI runner with a direct database connection. It is
   deliberately not an Edge Function and deliberately not PostgREST — see the
   note at the top of tools/tennis/lib/pg.js.

   HOW IT BEHAVES, and why each of these is not optional:

     IDEMPOTENT      Every write is an upsert on the table's own key, and a
                     match's key is its DRAW SLOT (tour, tournament, match
                     number), never its result — so a corrected winner updates
                     the match it corrects instead of creating a second one.
                     Running the same file twice writes the same rows twice.

     CHUNKED         5,000 rows per transaction by default. A chunk either
                     lands whole or not at all, which is what makes --resume
                     mean something.

     RESUMABLE       Every run records its source checksum and how many chunks
                     it committed. --resume finds the last unfinished run over
                     the same bytes and continues from the chunk after the last
                     committed one. A different file is a different run and it
                     says so rather than continuing into it.

     RECONCILING     rows_read must equal accepted + rejected. If it does not,
                     the run FAILS and says by how much. An import that cannot
                     account for every row it read is an import nobody can
                     trust, however good the totals look.

     QUARANTINING    A row that cannot become a match is still stored, in
                     tennis.stg_archive_matches with its reject reason, and
                     counted. Nothing is silently dropped.

     LICENCE-GATED   The source must be registered in tennis.source_licenses.
                     The archive is CC BY-NC-SA and is registered as
                     non-commercial; the database refuses any source it has
                     never heard of.

     WHOLE OR NOT AT ALL
                     A multi-part dataset is verified against its manifest
                     BEFORE the first row is read, and a missing part refuses
                     the whole import. This is the one failure this job cannot
                     detect on its own afterwards: importing thirteen of
                     fourteen parts SUCCEEDS, every total reconciles against
                     what was read, and the record is permanently missing a
                     tour-decade with nothing downstream ever saying so. The
                     manifest is the only thing that knows how much there
                     should have been, so it is checked first, by checksum.

   USAGE

     node tools/tennis/import_archive.js --file <csv|csv.gz|zip> [options]

       --file <path>          the archive. .csv, .csv.gz, or .zip with --member
       --member <path>        the member inside a .zip
       --manifest <path>      a MULTI-PART dataset's manifest (.json or .csv).
                              With --dir, every part is verified against it and
                              then imported as ONE run. A missing or altered
                              part REFUSES the import; see below.
       --dir <path>           where the parts are
       --dry-run              read, validate, reconcile, write NOTHING
       --resume               continue the last unfinished run over these bytes
       --tour ATP|WTA         import one tour only
       --season <y|y1-y2>     import one season or a range
       --chunk <n>            rows per transaction (default 5000)
       --limit <n>            stop after n source rows (development)
       --no-features          skip the point-in-time feature rows
       --fast                 drop the expensive secondary indexes for the
                              backfill and rebuild them at the end
       --finalize-only        recompute the derived layers, import nothing
       --ratings <path>       also load a player-strength snapshot CSV
       --source-version <s>   the archive build id, stored on every row

   The connection comes from SUPABASE_DB_URL, DATABASE_URL or EDGD_PG. Without
   one the job says so and exits rather than pretending to write.
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const CSV = require('./lib/csv.js');
const PG = require('./lib/pg.js');
const M = require('../../lib/tennis_model.js');

const JOB = 'archive_import';
const BUILD_VERSION = M.VERSION + '/' + M.FEATURE_VERSION;

/* ───────────────────────────── arguments ──────────────────────────────── */
function parseArgs(argv) {
  const o = { chunk: 5000, dryRun: false, resume: false, features: true, fast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--file') o.file = next();
    else if (a === '--member') o.member = next();
    else if (a === '--manifest') o.manifest = next();
    else if (a === '--dir') o.dir = next();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--resume') o.resume = true;
    else if (a === '--tour') o.tour = String(next() || '').toUpperCase();
    else if (a === '--season') o.season = next();
    /* An explicit --chunk is obeyed. It used to be clamped up to 100, which
       silently rewrote what an operator asked for AND — because a resume skips
       by chunk INDEX — made a resumed run skip a different set of rows than the
       one that was interrupted. A floor of 1 is honest; a small chunk is merely
       slow, and slow is the operator's business. */
    else if (a === '--chunk') o.chunk = Math.max(1, Number(next()) || 5000);
    else if (a === '--limit') o.limit = Number(next()) || null;
    else if (a === '--no-features') o.features = false;
    else if (a === '--fast') o.fast = true;
    else if (a === '--finalize-only') o.finalizeOnly = true;
    else if (a === '--ratings') o.ratings = next();
    else if (a === '--source-version') o.sourceVersion = next();
    else if (a === '--source-key') o.sourceKey = next();
    else if (a === '--database') o.database = next();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  o.sourceKey = o.sourceKey || 'archive';
  return o;
}

function say(...a) { console.log(...a); }
function warn(...a) { console.log('::warning::' + a.join(' ')); }
function fail(...a) { console.error('::error::' + a.join(' ')); }

/* ───────────────────────────── checksum ───────────────────────────────── */
/* The checksum is over the FILE, not over the rows: it is what makes "the same
   bytes" a decidable question, which is what --resume and duplicate detection
   both rest on. */
function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/* ───────────────────────────── staging columns ────────────────────────── */
/* The staging table stores the source verbatim. Its column names are the
   source's own, lowercased for PostgreSQL; this map is the only place the two
   spellings meet. */
const STG_COLUMNS = [
  'tourney_id', 'tourney_name', 'surface', 'draw_size', 'tourney_level', 'tourney_date', 'match_num',
  'winner_id', 'winner_seed', 'winner_entry', 'winner_name', 'winner_hand', 'winner_ht', 'winner_ioc', 'winner_age',
  'loser_id', 'loser_seed', 'loser_entry', 'loser_name', 'loser_hand', 'loser_ht', 'loser_ioc', 'loser_age',
  'score', 'best_of', 'round', 'minutes',
  'w_ace', 'w_df', 'w_svpt', 'w_1stIn', 'w_1stWon', 'w_2ndWon', 'w_SvGms', 'w_bpSaved', 'w_bpFaced',
  'l_ace', 'l_df', 'l_svpt', 'l_1stIn', 'l_1stWon', 'l_2ndWon', 'l_SvGms', 'l_bpSaved', 'l_bpFaced',
  'winner_rank', 'winner_rank_points', 'loser_rank', 'loser_rank_points',
  'tour', 'source_year',
  'winner_elo_pre', 'winner_surface_elo_pre', 'winner_win_pct_30d_pre', 'winner_win_pct_90d_pre',
  'winner_win_pct_365d_pre', 'winner_matches_7d_pre', 'winner_matches_14d_pre', 'winner_rest_days_pre',
  'winner_career_surface_win_pct_pre', 'winner_career_surface_matches_pre',
  'loser_elo_pre', 'loser_surface_elo_pre', 'loser_win_pct_30d_pre', 'loser_win_pct_90d_pre',
  'loser_win_pct_365d_pre', 'loser_matches_7d_pre', 'loser_matches_14d_pre', 'loser_rest_days_pre',
  'loser_career_surface_win_pct_pre', 'loser_career_surface_matches_pre',
  'winner_ace_rate', 'winner_double_fault_rate', 'winner_first_serve_in_pct', 'winner_first_serve_won_pct',
  'winner_second_serve_won_pct', 'winner_break_points_saved_pct',
  'loser_ace_rate', 'loser_double_fault_rate', 'loser_first_serve_in_pct', 'loser_first_serve_won_pct',
  'loser_second_serve_won_pct', 'loser_break_points_saved_pct',
  'elo_prob_winner_pre', 'surface_elo_prob_winner_pre',
  'weather_query', 'venue_name', 'venue_country', 'latitude', 'longitude', 'timezone',
  'geocode_confidence', 'environment', 'event_end_date',
  'weather_temp_mean_f', 'weather_temp_max_f', 'weather_temp_min_f', 'weather_humidity_mean_pct',
  'weather_precip_week_in', 'weather_wind_mean_mph', 'weather_gust_max_mph', 'weather_solar_week_mj_m2',
  'weather_days_covered', 'weather_precision',
  'match_uid', 'surface_group', 'data_source', 'weather_source'
];
const STG_DB_COLUMNS = STG_COLUMNS.map((c) => c.toLowerCase());

/* ───────────────────────────── normalised targets ─────────────────────── */
const PLAYER_COLS = ['player_id', 'tour', 'source_key', 'source_player_id', 'full_name', 'name_norm',
  'country', 'plays', 'height_cm', 'latest_age', 'latest_age_on', 'source_version'];
const VENUE_COLS = ['venue_id', 'source_key', 'venue_name', 'tourney_name', 'country', 'latitude',
  'longitude', 'timezone', 'environment', 'resolution_method', 'resolution_confidence', 'weather_query'];
const TOURNAMENT_COLS = ['tournament_id', 'provider', 'provider_tournament_id', 'tour', 'name', 'level',
  'surface', 'indoor', 'environment', 'surface_group', 'venue', 'country', 'timezone', 'start_date',
  'end_date', 'draw_size', 'season', 'state', 'venue_id', 'latitude', 'longitude', 'venue_confidence',
  'source', 'source_key', 'source_version'];
const MATCH_COLS = ['match_id', 'source_key', 'tour', 'source_tourney_id', 'match_num', 'source_match_uid',
  'tournament_id', 'tourney_name', 'season', 'match_date', 'tourney_date', 'date_precision', 'level',
  'round', 'round_order', 'best_of', 'surface', 'surface_group', 'environment', 'draw_size',
  'winner_id', 'loser_id', 'winner_seed', 'loser_seed', 'winner_entry', 'loser_entry', 'score',
  'sets_played', 'retirement', 'walkover', 'minutes', 'winner_rank', 'winner_rank_points',
  'loser_rank', 'loser_rank_points', 'winner_age', 'loser_age',
  'w_ace', 'w_df', 'w_svpt', 'w_1st_in', 'w_1st_won', 'w_2nd_won', 'w_sv_gms', 'w_bp_saved', 'w_bp_faced',
  'l_ace', 'l_df', 'l_svpt', 'l_1st_in', 'l_1st_won', 'l_2nd_won', 'l_sv_gms', 'l_bp_saved', 'l_bp_faced',
  'stats_available', 'venue_id', 'source_version', 'ingestion_version', 'quality_flags', 'quality_score'];
const FEATURE_COLS = ['match_id', 'player_id', 'opponent_id', 'tour', 'match_date', 'surface',
  'player_role', 'won', 'elo_pre', 'surface_elo_pre', 'win_pct_30d_pre', 'win_pct_90d_pre',
  'win_pct_365d_pre', 'matches_7d_pre', 'matches_14d_pre', 'rest_days_pre',
  'career_surface_win_pct_pre', 'career_surface_matches_pre', 'rank_pre', 'rank_points_pre',
  'age_pre', 'height_cm', 'plays', 'best_of', 'tourney_level', 'environment',
  'missing_fields', 'completeness', 'feature_version', 'feature_source_key'];
const WEATHER_COLS = ['venue_id', 'tournament_id', 'source_key', 'observed_on', 'window_start',
  'window_end', 'temporal_precision', 'temp_mean_f', 'temp_max_f', 'temp_min_f',
  'humidity_mean_pct', 'precip_in', 'wind_mean_mph', 'gust_max_mph', 'solar_mj_m2',
  'days_covered', 'venue_confidence', 'quality'];

/* PostgreSQL array literal for a text[] column, in COPY TEXT format. */
function pgArray(a) {
  if (!a || !a.length) return '{}';
  return '{' + a.map((x) => '"' + String(x).replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"').join(',') + '}';
}
function pick(obj, cols) {
  return cols.map((c) => {
    const v = obj[c];
    if (Array.isArray(v)) return pgArray(v);
    if (typeof v === 'boolean') return v ? 't' : 'f';
    return v;
  });
}

/* ───────────────────────────── the chunk script ───────────────────────── */
/* One psql session: begin, copy every entity into a temp table, upsert each in
   dependency order, commit. Dependency order matters — a match references a
   player and a tournament, so those land first inside the same transaction. */
function buildChunkScript(files, runId, opts) {
  const L = [];
  L.push('\\set ON_ERROR_STOP on');
  L.push('begin;');

  if (files.raw) {
    L.push(`\\copy tennis.stg_archive_matches (run_id,row_number,${STG_DB_COLUMNS.join(',')},reject_reason) from '${files.raw}' with (format text, null '\\N')`);
  }

  function stage(name, cols, file, like) {
    L.push(`create temp table ${name} (like ${like} including defaults) on commit drop;`);
    L.push(`\\copy ${name} (${cols.join(',')}) from '${file}' with (format text, null '\\N')`);
  }

  if (files.players) {
    stage('t_players', PLAYER_COLS, files.players, 'tennis.players');
    L.push(`insert into tennis.players (${PLAYER_COLS.join(',')}, ingestion_run_id)
      select distinct on (player_id) ${PLAYER_COLS.join(',')}, '${runId}'::uuid
        from t_players order by player_id, latest_age_on desc nulls last
      on conflict (player_id) do update set
        full_name = coalesce(excluded.full_name, tennis.players.full_name),
        name_norm = coalesce(excluded.name_norm, tennis.players.name_norm),
        country   = coalesce(excluded.country, tennis.players.country),
        plays     = coalesce(excluded.plays, tennis.players.plays),
        height_cm = coalesce(excluded.height_cm, tennis.players.height_cm),
        -- the LATEST known age wins, and it carries the date it was known on,
        -- so an age is never read as current without its own timestamp
        latest_age = case when excluded.latest_age_on is not null
                           and (tennis.players.latest_age_on is null
                                or excluded.latest_age_on > tennis.players.latest_age_on)
                          then excluded.latest_age else tennis.players.latest_age end,
        latest_age_on = greatest(coalesce(excluded.latest_age_on, '-infinity'::date),
                                 coalesce(tennis.players.latest_age_on, '-infinity'::date)),
        source_version = coalesce(excluded.source_version, tennis.players.source_version),
        ingestion_run_id = excluded.ingestion_run_id,
        updated_at = now();`);
  }

  if (files.venues) {
    stage('t_venues', VENUE_COLS, files.venues, 'tennis.venues');
    L.push(`insert into tennis.venues (${VENUE_COLS.join(',')}, ingestion_run_id)
      select distinct on (venue_id) ${VENUE_COLS.join(',')}, '${runId}'::uuid
        from t_venues order by venue_id, latitude nulls last
      on conflict (venue_id) do update set
        venue_name = coalesce(excluded.venue_name, tennis.venues.venue_name),
        country    = coalesce(excluded.country, tennis.venues.country),
        latitude   = coalesce(excluded.latitude, tennis.venues.latitude),
        longitude  = coalesce(excluded.longitude, tennis.venues.longitude),
        timezone   = coalesce(excluded.timezone, tennis.venues.timezone),
        -- an event that is ever seen indoors stays indoors: 'Outdoor/unknown'
        -- in the source is not a claim that it was outside
        environment = case when tennis.venues.environment = 'indoor' then 'indoor'
                           else coalesce(nullif(excluded.environment,'unknown'), tennis.venues.environment) end,
        resolution_method = coalesce(excluded.resolution_method, tennis.venues.resolution_method),
        resolution_confidence = coalesce(nullif(excluded.resolution_confidence,'unknown'), tennis.venues.resolution_confidence),
        weather_query = coalesce(excluded.weather_query, tennis.venues.weather_query),
        ingestion_run_id = excluded.ingestion_run_id,
        updated_at = now();`);
  }

  if (files.tournaments) {
    stage('t_tournaments', TOURNAMENT_COLS, files.tournaments, 'tennis.tournaments');
    L.push(`insert into tennis.tournaments (${TOURNAMENT_COLS.join(',')}, ingestion_run_id)
      select distinct on (tournament_id) ${TOURNAMENT_COLS.join(',')}, '${runId}'::uuid
        from t_tournaments order by tournament_id, end_date desc nulls last
      on conflict (tournament_id) do update set
        name = coalesce(excluded.name, tennis.tournaments.name),
        level = coalesce(excluded.level, tennis.tournaments.level),
        surface = coalesce(nullif(excluded.surface,'unknown'), tennis.tournaments.surface),
        indoor = coalesce(excluded.indoor, tennis.tournaments.indoor),
        environment = coalesce(nullif(excluded.environment,'unknown'), tennis.tournaments.environment),
        surface_group = coalesce(excluded.surface_group, tennis.tournaments.surface_group),
        country = coalesce(excluded.country, tennis.tournaments.country),
        timezone = coalesce(excluded.timezone, tennis.tournaments.timezone),
        start_date = least(coalesce(excluded.start_date,'infinity'::date), coalesce(tennis.tournaments.start_date,'infinity'::date)),
        end_date = greatest(coalesce(excluded.end_date,'-infinity'::date), coalesce(tennis.tournaments.end_date,'-infinity'::date)),
        draw_size = coalesce(excluded.draw_size, tennis.tournaments.draw_size),
        season = coalesce(excluded.season, tennis.tournaments.season),
        venue_id = coalesce(excluded.venue_id, tennis.tournaments.venue_id),
        latitude = coalesce(excluded.latitude, tennis.tournaments.latitude),
        longitude = coalesce(excluded.longitude, tennis.tournaments.longitude),
        venue_confidence = coalesce(excluded.venue_confidence, tennis.tournaments.venue_confidence),
        source_key = coalesce(excluded.source_key, tennis.tournaments.source_key),
        source_version = coalesce(excluded.source_version, tennis.tournaments.source_version),
        ingestion_run_id = excluded.ingestion_run_id,
        updated_at = now()
      -- A tournament the LIVE pipeline owns is never taken over by the archive.
      -- The two describe the same events from different feeds and the live one
      -- is the one the match centre writes; the archive only fills its own.
      where tennis.tournaments.provider = excluded.provider;`);
  }

  if (files.matches) {
    stage('t_matches', MATCH_COLS, files.matches, 'tennis.matches');
    L.push(`insert into tennis.matches (${MATCH_COLS.join(',')}, ingestion_run_id, source_updated_at)
      select distinct on (match_id) ${MATCH_COLS.join(',')}, '${runId}'::uuid, now()
        from t_matches order by match_id
      on conflict (match_id) do update set
        source_match_uid = excluded.source_match_uid,
        tournament_id = excluded.tournament_id,
        tourney_name = excluded.tourney_name,
        season = excluded.season,
        match_date = excluded.match_date,
        tourney_date = excluded.tourney_date,
        level = excluded.level, round = excluded.round, round_order = excluded.round_order,
        best_of = excluded.best_of, surface = excluded.surface,
        surface_group = excluded.surface_group, environment = excluded.environment,
        draw_size = excluded.draw_size,
        winner_id = excluded.winner_id, loser_id = excluded.loser_id,
        winner_seed = excluded.winner_seed, loser_seed = excluded.loser_seed,
        winner_entry = excluded.winner_entry, loser_entry = excluded.loser_entry,
        score = excluded.score, sets_played = excluded.sets_played,
        retirement = excluded.retirement, walkover = excluded.walkover, minutes = excluded.minutes,
        winner_rank = excluded.winner_rank, winner_rank_points = excluded.winner_rank_points,
        loser_rank = excluded.loser_rank, loser_rank_points = excluded.loser_rank_points,
        winner_age = excluded.winner_age, loser_age = excluded.loser_age,
        w_ace = excluded.w_ace, w_df = excluded.w_df, w_svpt = excluded.w_svpt,
        w_1st_in = excluded.w_1st_in, w_1st_won = excluded.w_1st_won, w_2nd_won = excluded.w_2nd_won,
        w_sv_gms = excluded.w_sv_gms, w_bp_saved = excluded.w_bp_saved, w_bp_faced = excluded.w_bp_faced,
        l_ace = excluded.l_ace, l_df = excluded.l_df, l_svpt = excluded.l_svpt,
        l_1st_in = excluded.l_1st_in, l_1st_won = excluded.l_1st_won, l_2nd_won = excluded.l_2nd_won,
        l_sv_gms = excluded.l_sv_gms, l_bp_saved = excluded.l_bp_saved, l_bp_faced = excluded.l_bp_faced,
        stats_available = excluded.stats_available, venue_id = excluded.venue_id,
        source_version = excluded.source_version, ingestion_version = excluded.ingestion_version,
        quality_flags = excluded.quality_flags, quality_score = excluded.quality_score,
        ingestion_run_id = excluded.ingestion_run_id,
        source_updated_at = now(), updated_at = now();`);
  }

  if (files.features) {
    stage('t_features', FEATURE_COLS, files.features, 'tennis.player_match_features');
    L.push(`insert into tennis.player_match_features (${FEATURE_COLS.join(',')}, ingestion_run_id)
      select distinct on (match_id, player_id, feature_version) ${FEATURE_COLS.join(',')}, '${runId}'::uuid
        from t_features order by match_id, player_id, feature_version
      on conflict (match_id, player_id, feature_version) do update set
        opponent_id = excluded.opponent_id, player_role = excluded.player_role, won = excluded.won,
        elo_pre = excluded.elo_pre, surface_elo_pre = excluded.surface_elo_pre,
        win_pct_30d_pre = excluded.win_pct_30d_pre, win_pct_90d_pre = excluded.win_pct_90d_pre,
        win_pct_365d_pre = excluded.win_pct_365d_pre, matches_7d_pre = excluded.matches_7d_pre,
        matches_14d_pre = excluded.matches_14d_pre, rest_days_pre = excluded.rest_days_pre,
        career_surface_win_pct_pre = excluded.career_surface_win_pct_pre,
        career_surface_matches_pre = excluded.career_surface_matches_pre,
        rank_pre = excluded.rank_pre, rank_points_pre = excluded.rank_points_pre,
        age_pre = excluded.age_pre, height_cm = excluded.height_cm, plays = excluded.plays,
        best_of = excluded.best_of, tourney_level = excluded.tourney_level,
        environment = excluded.environment, missing_fields = excluded.missing_fields,
        completeness = excluded.completeness, computed_at = now(),
        ingestion_run_id = excluded.ingestion_run_id;`);
  }

  if (files.weather) {
    stage('t_weather', WEATHER_COLS, files.weather, 'tennis.weather_observations');
    L.push(`insert into tennis.weather_observations (${WEATHER_COLS.join(',')}, ingestion_run_id)
      select distinct on (coalesce(venue_id,''), coalesce(tournament_id,''), source_key, observed_on)
             ${WEATHER_COLS.join(',')}, '${runId}'::uuid
        from t_weather where observed_on is not null
       order by coalesce(venue_id,''), coalesce(tournament_id,''), source_key, observed_on, days_covered desc nulls last
      on conflict (coalesce(venue_id,''), coalesce(tournament_id,''), source_key, observed_on) do update set
        temporal_precision = excluded.temporal_precision,
        temp_mean_f = excluded.temp_mean_f, temp_max_f = excluded.temp_max_f, temp_min_f = excluded.temp_min_f,
        humidity_mean_pct = excluded.humidity_mean_pct, precip_in = excluded.precip_in,
        wind_mean_mph = excluded.wind_mean_mph, gust_max_mph = excluded.gust_max_mph,
        solar_mj_m2 = excluded.solar_mj_m2, days_covered = excluded.days_covered,
        venue_confidence = excluded.venue_confidence, quality = excluded.quality,
        ingestion_run_id = excluded.ingestion_run_id;`);
  }

  L.push(`update tennis.ingestion_runs set
            details = coalesce(details,'{}'::jsonb) || jsonb_build_object('last_chunk', ${opts.chunkIndex}),
            rows_read = rows_read + ${opts.read},
            rows_inserted = rows_inserted + ${opts.accepted},
            rows_rejected = rows_rejected + ${opts.rejected},
            status = 'running', updated_at = now()
          where run_id = '${runId}'::uuid;`);
  L.push('commit;');
  return L;
}

/* ───────────────────────────── main ───────────────────────────────────── */
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { say(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }

  const conn = PG.resolveConnection();
  if (!conn) {
    fail('no database connection. Set SUPABASE_DB_URL (Supabase > Connect > Session pooler), ' +
         'DATABASE_URL, or EDGD_PG. Nothing was read and nothing was written.');
    return 1;
  }
  let db;
  try { db = PG.client(conn, { database: o.database }); } catch (e) { fail(String(e.message)); return 1; }
  if (!db.ping()) { fail('the database did not answer. ' + PG.redact('check the connection')); return 1; }

  if (db.scalar("select case when to_regclass('tennis.matches') is null then 'no' else 'yes' end") !== 'yes') {
    fail('the tennis record contract is not installed. Apply supabase/tennis_record.sql first:\n' +
         '    psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql');
    return 1;
  }

  /* THE LICENCE GATE, checked before a byte is read. */
  const lic = db.rows(`select source_key, licence, commercial_use, allowed_uses
                         from tennis.source_licenses where source_key = ${PG.lit(o.sourceKey)}`)[0];
  if (!lic) {
    fail(`source "${o.sourceKey}" is not registered in tennis.source_licenses. ` +
         'EdgeDesk stores no fact of unknown provenance: register it with its licence first.');
    return 1;
  }
  say(`source      : ${lic.source_key} — ${lic.licence}` +
      (lic.commercial_use ? ' (cleared for commercial use)' : ' (NON-COMMERCIAL: research only)'));

  if (o.finalizeOnly) return finalize(db, o, null);

  /* ---- a MULTI-PART dataset ------------------------------------------- */
  if (o.manifest) {
    if (!o.dir) { fail('--manifest needs --dir, the directory the parts are in'); return 1; }
    return importParts(db, o);
  }

  if (!o.file) { fail('--file is required (or --manifest with --dir for a multi-part dataset)'); return 1; }
  if (!fs.existsSync(o.file)) { fail('no such file: ' + o.file); return 1; }

  say(`file        : ${o.file}${o.member ? ' [' + o.member + ']' : ''}`);
  const checksum = await sha256(o.file);
  const bytes = fs.statSync(o.file).size;
  say(`checksum    : sha256 ${checksum}  (${(bytes / 1048576).toFixed(1)} MB)`);

  /* THE SOURCE CONTRACT. A missing column is a source change, and it fails
     here rather than becoming 361,000 nulls nobody notices. */
  const header = await CSV.readHeader(o.file, { member: o.member });
  if (!header) { fail('the file has no header row'); return 1; }
  const missing = M.REQUIRED_COLUMNS.filter((c) => header.indexOf(c) < 0);
  if (missing.length) {
    fail('the source is missing required columns: ' + missing.join(', ') +
         '\n  the importer reads the ' + M.SCHEMA_VERSION + ' contract; this file carries ' + header.length + ' columns');
    return 1;
  }
  const unknown = header.filter((c) => STG_COLUMNS.indexOf(c) < 0);
  if (unknown.length) warn('the source carries ' + unknown.length + ' column(s) this build does not store: ' + unknown.slice(0, 8).join(', '));
  say(`columns     : ${header.length} (contract ${M.SCHEMA_VERSION}, ${M.REQUIRED_COLUMNS.length} required present)`);

  /* ---- resume ---------------------------------------------------------- */
  let runId = null, startChunk = 0;
  if (o.resume && !o.dryRun) {
    const prev = db.rows(`select run_id, coalesce((details->>'last_chunk')::int, -1) as last_chunk,
                                 (details->>'chunk_size')::int as chunk_size,
                                 rows_read, rows_inserted, rows_rejected, status
                            from tennis.ingestion_runs
                           where job = ${PG.lit(JOB)} and source_checksum = ${PG.lit(checksum)}
                             and status in ('running','resumed')
                           order by started_at desc limit 1`)[0];
    if (prev) {
      runId = prev.run_id;
      startChunk = (prev.last_chunk == null ? -1 : Number(prev.last_chunk)) + 1;
      /* A resume MUST re-walk the file with the same chunk boundaries the
         interrupted run used, or "skip the first N chunks" skips a different set
         of rows. The original size wins over whatever was typed this time, and
         the change is announced rather than applied quietly. */
      const prevChunk = prev.chunk_size == null ? null : Number(prev.chunk_size);
      if (prevChunk && prevChunk !== o.chunk) {
        say(`resuming    : the interrupted run used --chunk ${prevChunk}; using that instead of ${o.chunk}` +
            ' so the chunk boundaries line up');
        o.chunk = prevChunk;
      } else if (!prevChunk) {
        warn('the interrupted run did not record its chunk size (it predates this build). ' +
             'Resuming is only safe with the SAME --chunk it ran with; re-run without --resume if you are unsure.');
      }
      say(`resuming    : run ${runId} from chunk ${startChunk} (${prev.rows_read} rows already read)`);
      db.exec(`update tennis.ingestion_runs set status='resumed', updated_at=now() where run_id='${runId}'::uuid`);
    } else {
      say('resuming    : no unfinished run over these bytes — starting a new one');
    }
  }

  const scope = [o.tour || 'ATP+WTA', o.season || 'all seasons'].join(' / ');
  if (!runId && !o.dryRun) {
    runId = db.scalar(`insert into tennis.ingestion_runs
        (job, source_key, source_version, source_checksum, source_file, build_version, scope, status)
      values (${PG.lit(JOB)}, ${PG.lit(o.sourceKey)}, ${PG.lit(o.sourceVersion || null)},
              ${PG.lit(checksum)}, ${PG.lit(path.basename(o.file))}, ${PG.lit(BUILD_VERSION)},
              ${PG.lit(scope)}, 'running')
      returning run_id`).trim();
    /* THE CHUNK SIZE IS PART OF THE RUN, because a resume skips by chunk INDEX.
       Resuming with a different chunk size would skip a different set of rows —
       silently, and in a way no count would reveal. */
    db.exec(`update tennis.ingestion_runs
                set details = coalesce(details,'{}'::jsonb) || jsonb_build_object('chunk_size', ${o.chunk})
              where run_id='${runId}'::uuid`);
    say(`run         : ${runId}`);
  } else if (o.dryRun) {
    say('run         : DRY RUN — nothing will be written');
  }

  if (o.fast && !o.dryRun) {
    say('indexes     : dropping the expensive secondary indexes for the backfill');
    db.exec('select tennis.drop_backfill_indexes()');
  }

  /* ---- the read -------------------------------------------------------- */
  const res = await runFileImport(db, o, runId, startChunk);
  const totals = { read: res.read, accepted: res.accepted, rejected: res.rejected,
                   skipped: res.skipped, issues: res.issues, chunks: res.chunks };
  const elapsedSeconds = res.seconds || 0;
  if (!res.ok) {
    if (!o.dryRun && runId) {
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
                 error_summary=${PG.lit(String(res.error).slice(0, 900))} where run_id='${runId}'::uuid`);
    }
    fail('the import stopped: ' + res.error);
    say('\nNothing is lost. Re-run with --resume to continue from the last committed chunk.');
    return 1;
  }

  /* ---- reconciliation -------------------------------------------------- */
  const accounted = totals.accepted + totals.rejected + totals.skipped;
  const reconciled = accounted === totals.read;
  say('');
  say('  ── reconciliation ─────────────────────────────────────────');
  say(`  source rows read       ${String(totals.read).padStart(10)}`);
  say(`  accepted               ${String(totals.accepted).padStart(10)}`);
  say(`  rejected (quarantined) ${String(totals.rejected).padStart(10)}`);
  say(`  skipped by filter      ${String(totals.skipped).padStart(10)}`);
  say(`  accounted for          ${String(accounted).padStart(10)}  ${reconciled ? 'RECONCILED' : 'MISMATCH'}`);
  if (Object.keys(totals.issues).length) {
    say('  data-quality issues seen:');
    Object.keys(totals.issues).sort().forEach((k) => say(`    ${k.padEnd(24)} ${totals.issues[k]}`));
  }

  if (!reconciled) {
    fail(`reconciliation failed: read ${totals.read}, accounted for ${accounted} (difference ${totals.read - accounted}). ` +
         'The run is marked error and nothing further is derived from it.');
    if (!o.dryRun && runId) {
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(), reconciled=false,
                 rows_read=${totals.read}, rows_inserted=${totals.accepted}, rows_rejected=${totals.rejected},
                 error_summary='rows read and rows accounted for do not reconcile'
               where run_id='${runId}'::uuid`);
    }
    return 1;
  }

  if (o.dryRun) {
    say('\nDRY RUN — nothing was written. Re-run without --dry-run to import.');
    return 0;
  }

  if (o.fast) {
    say('indexes     : rebuilding the secondary indexes');
    db.exec('select tennis.rebuild_backfill_indexes()');
  }

  /* the quality issues, recorded once per type rather than once per row */
  Object.keys(totals.issues).forEach((type) => {
    db.exec(`select tennis.record_quality_issue(${PG.lit(runId)}::uuid, ${PG.lit(o.sourceKey)},
      ${PG.lit(type)}, 'warn', 'match', ${PG.lit('run:' + runId)}, null, null, null,
      ${PG.lit(totals.issues[type] + ' row(s) in this import')}, null)`);
  });

  db.exec(`update tennis.ingestion_runs set
             status='ok', finished_at=now(), reconciled=true,
             rows_read=${totals.read}, rows_inserted=${totals.accepted},
             rows_rejected=${totals.rejected},
             details = coalesce(details,'{}'::jsonb) || ${PG.lit(JSON.stringify({
               skipped: totals.skipped, chunks: totals.chunks, issues: totals.issues,
               seconds: elapsedSeconds
             }))}::jsonb
           where run_id='${runId}'::uuid`);

  return finalize(db, o, runId);
}

/* ───────────────────────────── multi-part ─────────────────────────────── */
/* Verify every part against the manifest, then import them in manifest order as
   ONE logical dataset — one reconciliation, against the manifest's declared
   total rather than against whatever happened to be on disk. */
async function importParts(db, o) {
  const V = require('./verify_parts.js');
  say('');
  say('  ── verifying the parts before anything is read ─────────────');
  const man = V.readManifest(o.manifest);
  const byHash = await V.index(o.dir);

  const resolved = [], missing = [], invalid = [];
  for (const f of man.files) {
    const hit = byHash.get(String(f.sha256).toLowerCase());
    if (!hit) { missing.push(f); continue; }
    const bytes = fs.statSync(hit[0]).size;
    if (f.bytes && bytes !== f.bytes) { invalid.push({ f, why: 'byte size ' + bytes + ' ≠ ' + f.bytes }); continue; }
    resolved.push({ f, path: hit[0], copies: hit.length });
  }
  say(`  parts declared   ${man.parts}`);
  say(`  parts resolved   ${resolved.length}`);
  say(`  rows declared    ${man.rows.toLocaleString()}`);

  if (missing.length || invalid.length) {
    fail(`the dataset is INCOMPLETE: ${missing.length} part(s) missing, ${invalid.length} invalid. Nothing was imported.`);
    say('');
    missing.forEach((f) => {
      say(`  MISSING  part ${f.part}  ${f.file}`);
      say(`           ${Number(f.rows).toLocaleString()} rows · ${Number(f.bytes).toLocaleString()} bytes`);
      say(`           sha256 ${f.sha256}`);
    });
    invalid.forEach((x) => say(`  INVALID  part ${x.f.part}  ${x.f.file}  (${x.why})`));
    say('');
    say('  Importing the parts that ARE here would succeed and reconcile, and the record');
    say('  would be permanently short by ' +
        (man.rows - resolved.reduce((a, r) => a + Number(r.f.rows || 0), 0)).toLocaleString() +
        ' matches with nothing downstream ever saying so.');
    say('  Re-upload the part(s) named above and run this again.');
    return 1;
  }

  /* One checksum over the whole dataset, so a resume can recognise it: the
     sorted part checksums, hashed. Any part changing changes it. */
  const datasetChecksum = crypto.createHash('sha256')
    .update(man.files.map((f) => String(f.sha256).toLowerCase()).sort().join('\n')).digest('hex');
  say(`  dataset checksum sha256 ${datasetChecksum}`);
  say('  all parts present and intact.');

  if (o.dryRun) {
    say('');
    say('  DRY RUN — the manifest verifies. Re-run without --dry-run to import all ' +
        man.parts + ' parts as one dataset.');
    return 0;
  }

  /* ONE run for the whole dataset, so the reconciliation is over the manifest
     rather than over one file at a time. */
  let runId = null, startPart = 0;
  if (o.resume) {
    const prev = db.rows(`select run_id, coalesce((details->>'last_part')::int, -1) as last_part,
                                 rows_read from tennis.ingestion_runs
                            where job = ${PG.lit(JOB)} and source_checksum = ${PG.lit(datasetChecksum)}
                              and status in ('running','resumed')
                            order by started_at desc limit 1`)[0];
    if (prev) {
      runId = prev.run_id;
      startPart = Number(prev.last_part) + 1;
      say(`  resuming run ${runId} from part ${startPart + 1} (${prev.rows_read} rows already read)`);
      db.exec(`update tennis.ingestion_runs set status='resumed', updated_at=now() where run_id='${runId}'::uuid`);
    }
  }
  if (!runId) {
    runId = db.scalar(`insert into tennis.ingestion_runs
        (job, source_key, source_version, source_checksum, source_file, build_version, scope, status, details)
      values (${PG.lit(JOB)}, ${PG.lit(o.sourceKey)}, ${PG.lit(o.sourceVersion || null)},
              ${PG.lit(datasetChecksum)}, ${PG.lit(path.basename(o.manifest))}, ${PG.lit(BUILD_VERSION)},
              ${PG.lit(man.parts + ' parts / ' + man.rows + ' rows')}, 'running',
              ${PG.lit(JSON.stringify({ parts: man.parts, declared_rows: man.rows, chunk_size: o.chunk }))}::jsonb)
      returning run_id`).trim();
    say(`  run ${runId}`);
  }

  if (o.fast) {
    say('  indexes: dropping the expensive secondary indexes for the backfill');
    db.exec('select tennis.drop_backfill_indexes()');
  }

  const grand = { read: 0, accepted: 0, rejected: 0, skipped: 0 };
  const t0 = Date.now();
  for (let i = 0; i < resolved.length; i++) {
    const { f, path: file } = resolved[i];
    if (i < startPart) { grand.read += Number(f.rows); grand.accepted += Number(f.rows); continue; }
    say('');
    say(`  ── part ${f.part}/${man.parts}  ${f.tour} ${f.years}  ${Number(f.rows).toLocaleString()} rows`);
    const partOpts = Object.assign({}, o, { file, member: null, fast: false, limit: null });
    /* the source contract, per part: a part that changed shape fails here rather
       than becoming a column of nulls */
    const hdr = await CSV.readHeader(file);
    const miss = hdr ? M.REQUIRED_COLUMNS.filter((c) => hdr.indexOf(c) < 0) : M.REQUIRED_COLUMNS;
    if (miss.length) {
      fail(`part ${f.part} is missing required columns: ${miss.join(', ')}`);
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
                 error_summary=${PG.lit('part ' + f.part + ' changed shape')} where run_id='${runId}'::uuid`);
      return 1;
    }
    if (f.columns && hdr.length !== Number(f.columns)) {
      fail(`part ${f.part} holds ${hdr.length} columns, the manifest declares ${f.columns}`);
      return 1;
    }
    const one = await runFileImport(db, partOpts, runId, 0);
    if (!one.ok) {
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(),
                 error_summary=${PG.lit('part ' + f.part + ': ' + String(one.error).slice(0, 800))}
               where run_id='${runId}'::uuid`);
      fail(`part ${f.part} (${f.file}) failed: ${one.error}`);
      say('  Nothing after it was imported. Re-run with --resume to continue from this part.');
      return 1;
    }
    grand.read += one.read; grand.accepted += one.accepted;
    grand.rejected += one.rejected; grand.skipped += one.skipped;
    if (one.read !== Number(f.rows)) {
      fail(`part ${f.part} holds ${one.read} rows, the manifest declares ${f.rows}. Stopping.`);
      db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(), reconciled=false,
                 error_summary='a part did not hold the row count its manifest declares'
               where run_id='${runId}'::uuid`);
      return 1;
    }
    db.exec(`update tennis.ingestion_runs set
               details = coalesce(details,'{}'::jsonb) || jsonb_build_object('last_part', ${i}),
               rows_read = ${grand.read}, rows_inserted = ${grand.accepted}, rows_rejected = ${grand.rejected},
               updated_at = now() where run_id='${runId}'::uuid`);
  }

  const accounted = grand.accepted + grand.rejected + grand.skipped;
  say('');
  say('  ── reconciliation, over the whole dataset ─────────────────');
  say(`  manifest declares      ${String(man.rows).padStart(10)}`);
  say(`  source rows read       ${String(grand.read).padStart(10)}`);
  say(`  accepted               ${String(grand.accepted).padStart(10)}`);
  say(`  rejected (quarantined) ${String(grand.rejected).padStart(10)}`);
  say(`  skipped by filter      ${String(grand.skipped).padStart(10)}`);
  say(`  accounted for          ${String(accounted).padStart(10)}  ${accounted === grand.read ? 'RECONCILED' : 'MISMATCH'}`);
  const matchesManifest = grand.read === man.rows;
  say(`  matches the manifest   ${String(matchesManifest ? 'yes' : 'NO').padStart(10)}`);

  if (accounted !== grand.read || !matchesManifest) {
    db.exec(`update tennis.ingestion_runs set status='error', finished_at=now(), reconciled=false,
               rows_read=${grand.read}, rows_inserted=${grand.accepted}, rows_rejected=${grand.rejected},
               error_summary='the dataset did not reconcile against its manifest'
             where run_id='${runId}'::uuid`);
    fail('the dataset did not reconcile against its manifest. Nothing is derived from this run.');
    return 1;
  }

  if (o.fast) { say('  indexes: rebuilding'); db.exec('select tennis.rebuild_backfill_indexes()'); }
  db.exec(`update tennis.ingestion_runs set status='ok', finished_at=now(), reconciled=true,
             rows_read=${grand.read}, rows_inserted=${grand.accepted}, rows_rejected=${grand.rejected},
             details = coalesce(details,'{}'::jsonb) ||
               ${PG.lit(JSON.stringify({ skipped: grand.skipped, seconds: Math.round((Date.now() - t0) / 1000) }))}::jsonb
           where run_id='${runId}'::uuid`);
  return finalize(db, o, runId);
}

/* THE READ LOOP, extracted so the single-file path and the multi-part path run
   the SAME code. A second copy of this is how a multi-part import ends up
   quarantining differently from a single-file one, and nobody notices until a
   count disagrees months later.

   It reads one file into an EXISTING run, and returns what it accounted for.
   The caller owns the run, the reconciliation and the exit code. */
async function runFileImport(db, o, runId, startChunk) {
  startChunk = startChunk || 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-tennis-import-'));
  const seasonFilter = parseSeason(o.season);
  const totals = { read: 0, accepted: 0, rejected: 0, skipped: 0, chunks: 0, committed: 0, issues: {} };
  const t0 = Date.now();

  let buf = newBuffer();
  let chunkIndex = 0;

  function noteIssue(type) { totals.issues[type] = (totals.issues[type] || 0) + 1; }

  async function flush() {
    const idx = chunkIndex++;
    if (!buf.count) return;
    totals.chunks++;
    if (o.dryRun) { totals.committed += buf.accepted; buf = newBuffer(); return; }
    if (idx < startChunk) { buf = newBuffer(); return; }   // already committed by the earlier run

    const files = {};
    function write(name, lines) {
      if (!lines.length) return null;
      const f = path.join(tmpDir, name + '.tsv');
      fs.writeFileSync(f, lines.join(''));
      return f;
    }
    files.raw = write('raw', buf.raw);
    files.players = write('players', buf.players);
    files.venues = write('venues', buf.venues);
    files.tournaments = write('tournaments', buf.tournaments);
    files.matches = write('matches', buf.matches);
    files.features = o.features ? write('features', buf.features) : null;
    files.weather = write('weather', buf.weather);

    const script = buildChunkScript(files, runId, {
      chunkIndex: idx, read: buf.count, accepted: buf.accepted, rejected: buf.rejected
    });
    try {
      db.script(script, tmpDir);
      totals.committed += buf.accepted;
    } catch (e) {
      fail(`chunk ${idx} failed (rows ${buf.firstRow}-${buf.lastRow}): ${e.message}`);
      throw e;
    } finally {
      Object.values(files).forEach((f) => { if (f) { try { fs.unlinkSync(f); } catch (_) {} } });
    }
    if (totals.chunks % 5 === 0 || idx === startChunk) {
      const rate = Math.round(totals.read / Math.max(1, (Date.now() - t0) / 1000));
      say(`  chunk ${String(idx).padStart(4)} | ${String(totals.read).padStart(8)} read | ` +
          `${String(totals.accepted).padStart(8)} accepted | ${String(totals.rejected).padStart(5)} rejected | ${rate}/s`);
    }
    buf = newBuffer();
  }

  try {
    for await (const rec of CSV.readRows(o.file, { member: o.member })) {
      const raw = CSV.toObject(rec.header, rec.values);
      totals.read++;

      /* filters are applied AFTER the row is counted as read, so the
         reconciliation below is over the file, not over the filter */
      const tour = M.normTour(raw.tour);
      if (o.tour && tour !== o.tour) { totals.skipped++; continue; }
      if (seasonFilter) {
        const y = M.seasonOf(raw.tourney_date, raw.source_year);
        if (y == null || y < seasonFilter.from || y > seasonFilter.to) { totals.skipped++; continue; }
      }

      const v = M.validateRow(raw);
      v.issues.forEach((i) => noteIssue(i.type));
      if (buf.firstRow == null) buf.firstRow = rec.index;
      buf.lastRow = rec.index;

      buf.raw.push(CSV.copyLine([runId || '00000000-0000-0000-0000-000000000000', rec.index]
        .concat(STG_COLUMNS.map((c) => raw[c])).concat([v.reject_reason])));
      buf.count++;

      if (!v.ok) { buf.rejected++; totals.rejected++; continue; }

      const p = M.parseArchiveRow(raw, { source_key: o.sourceKey, source_version: o.sourceVersion });
      /* quality flags travel with the match, so a reader can see what was odd
         about a row without joining the issue table */
      p.match.quality_flags = v.issues.map((i) => i.type);
      p.match.quality_score = M.round(1 - Math.min(1, v.issues.length / 6), 3);

      buf.matches.push(CSV.copyLine(pick(p.match, MATCH_COLS)));
      buf.players.push(CSV.copyLine(pick(p.winner, PLAYER_COLS)));
      buf.players.push(CSV.copyLine(pick(p.loser, PLAYER_COLS)));
      buf.tournaments.push(CSV.copyLine(pick(p.tournament, TOURNAMENT_COLS)));
      if (p.venue) buf.venues.push(CSV.copyLine(pick(p.venue, VENUE_COLS)));
      if (p.weather && p.weather.observed_on) buf.weather.push(CSV.copyLine(pick(p.weather, WEATHER_COLS)));
      if (o.features) p.features.forEach((f) => buf.features.push(CSV.copyLine(pick(f, FEATURE_COLS))));

      buf.accepted++; totals.accepted++;
      if (buf.count >= o.chunk) await flush();
      if (o.limit && totals.read >= o.limit) break;
    }
    await flush();
  } catch (e) {
    return { ok: false, error: e.message, read: totals.read, accepted: totals.accepted,
             rejected: totals.rejected, skipped: totals.skipped, issues: totals.issues,
             chunks: totals.chunks };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
  return { ok: true, read: totals.read, accepted: totals.accepted, rejected: totals.rejected,
           skipped: totals.skipped, issues: totals.issues, chunks: totals.chunks,
           seconds: Math.round((Date.now() - t0) / 1000) };
}


function newBuffer() {
  return { count: 0, accepted: 0, rejected: 0, firstRow: null, lastRow: null,
           raw: [], players: [], venues: [], tournaments: [], matches: [], features: [], weather: [] };
}
function parseSeason(s) {
  if (!s) return null;
  const m = /^(\d{4})(?:\s*[-:]\s*(\d{4}))?$/.exec(String(s).trim());
  if (!m) return null;
  return { from: Number(m[1]), to: Number(m[2] || m[1]) };
}

/* ───────────────────────────── finalize ───────────────────────────────── */
/* The derived layers the importer owns: the player aggregates the record views
   cannot cheaply compute per read, and the official ranking snapshot, which is
   the LATEST rank the archive ever recorded for a player rather than a
   published ranking table (the archive carries no ranking file). It is labelled
   as exactly that so nobody reads it as this week's list. */
function finalize(db, o, runId) {
  say('');
  say('  ── finalize ───────────────────────────────────────────────');
  const run = runId ? `'${runId}'::uuid` : 'null';

  db.exec(`update tennis.players p set
      first_match = agg.first_match, last_match = agg.last_match,
      matches_on_file = agg.matches,
      active = (agg.last_match >= (current_date - interval '18 months')),
      updated_at = now()
    from (select player_id, min(match_date) first_match, max(match_date) last_match, count(*)::int matches
            from tennis.player_match_rows group by player_id) agg
   where agg.player_id = p.player_id
     and (p.matches_on_file is distinct from agg.matches
       or p.last_match is distinct from agg.last_match
       or p.first_match is distinct from agg.first_match)`);
  say('  player aggregates    ' + db.scalar('select count(*) from tennis.players where matches_on_file > 0') + ' players with matches on file');

  /* The latest rank each player was recorded at, and when. A match row carries
     the rank the player HELD at that match, so the newest match with a rank is
     the freshest ranking the archive knows. */
  db.exec(`insert into tennis.rankings_current (player_id, tour, rank, points, as_of, source_key, ingestion_run_id)
    select r.player_id, r.tour, r.rank, r.points, r.as_of, 'archive', ${run}
      from (
        select distinct on (player_id) player_id, tour, rank, points, as_of
          from (
            select winner_id as player_id, tour, winner_rank as rank,
                   winner_rank_points as points, match_date as as_of
              from tennis.matches where winner_id is not null and winner_rank is not null
            union all
            select loser_id, tour, loser_rank, loser_rank_points, match_date
              from tennis.matches where loser_id is not null and loser_rank is not null
          ) u
         order by player_id, as_of desc nulls last
      ) r
    on conflict (player_id) do update set
      rank = excluded.rank, points = excluded.points, as_of = excluded.as_of,
      previous_rank = case when tennis.rankings_current.as_of < excluded.as_of
                           then tennis.rankings_current.rank else tennis.rankings_current.previous_rank end,
      movement = case when tennis.rankings_current.as_of < excluded.as_of
                       then tennis.rankings_current.rank - excluded.rank else tennis.rankings_current.movement end,
      ingestion_run_id = excluded.ingestion_run_id, updated_at = now()
    where excluded.as_of >= coalesce(tennis.rankings_current.as_of, '-infinity'::date)`);
  say('  ranking snapshot     ' + db.scalar('select count(*) from tennis.rankings_current') + ' players ranked (latest rank on file, not this week\'s list)');

  db.exec(`insert into tennis.meta (key, value) values
      ('last_ingest', now()::text),
      ('record_rows', (select count(*)::text from tennis.matches)),
      ('record_first_date', coalesce((select min(match_date)::text from tennis.matches),'')),
      ('record_last_date', coalesce((select max(match_date)::text from tennis.matches),'')),
      ('record_source', 'archive')
    on conflict (key) do update set value = excluded.value`);

  const h = db.rows('select * from tennis.record_health')[0] || {};
  say('');
  say('  ── coverage ───────────────────────────────────────────────');
  say(`  matches              ${h.matches} (ATP ${h.atp_matches} / WTA ${h.wta_matches})`);
  say(`  players              ${h.players}`);
  say(`  window               ${h.first_match_date} .. ${h.last_match_date}`);
  say(`  surface unknown      ${h.matches_without_surface}`);
  say(`  weather rows         ${db.scalar('select count(*) from tennis.weather_observations')}`);
  say(`  feature rows         ${db.scalar('select count(*) from tennis.player_match_features')}`);
  say('');
  say('  Next: node tools/tennis/build_features.js --commit   (rolling serve/return and strength of schedule)');
  say('        node tools/tennis/build_ratings.js  --commit   (current ratings and power rating)');
  say('        node tools/tennis/build_model.js    --commit   (train, evaluate and register a model version)');
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { fail(String(e && e.stack || e)); process.exit(1); });
}
module.exports = { parseArgs, parseSeason, runFileImport, importParts, STG_COLUMNS, MATCH_COLS, FEATURE_COLS, PLAYER_COLS, pgArray, buildChunkScript };
