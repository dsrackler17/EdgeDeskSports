/* ===========================================================================
   EdgeDesk player props — THE DATABASE SYNC (Supabase, props schema).

   The warehouse, the models, the predictions, the observed quotes and the
   record, loaded into supabase/props_factory.sql through the direct database
   door the tennis archive already uses (tools/tennis/lib/pg.js: psql + COPY,
   credential from SUPABASE_DB_URL / DATABASE_URL / EDGD_PG, redacted from
   every error). A REST round trip per row is neither fast enough nor kind
   enough for 700,000 player-games.

   IDEMPOTENT BY CONSTRUCTION. Dimensions upsert on their keys; facts go
   COPY → props.stg_player_game → props.promote_player_games(run_id), which logs
   a changed value in props.fact_corrections before updating it; predictions
   and records insert-on-conflict-do-nothing (the tables refuse rewrites
   anyway); quotes go through props.ingest_prop_quotes(), which quarantines
   what fails a gate and ignores what it already holds. Loading twice is
   loading once.
   =========================================================================== */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pg = require('../../../tools/tennis/lib/pg.js');
const { copyLine, copyEscape } = require('../../../tools/tennis/lib/csv.js');
const io = require('./lib/io.js');
const REG = require('./config/feature_registry.json');

const FPG_COLS = ['game_id', 'player_id', 'team_id', 'opponent_id', 'player_name', 'position', 'position_group', 'season', 'week', 'kickoff_utc', 'is_home', 'starter',
  'active_status', 'injury_status', 'snaps', 'snap_share', 'routes', 'attempts', 'completions', 'passing_yards', 'passing_tds', 'interceptions', 'sacks_taken',
  'passing_air_yards', 'passing_epa', 'passing_cpoe', 'dropbacks', 'scrambles', 'designed_rushes', 'carries', 'rushing_yards', 'rushing_tds', 'rushing_epa',
  'targets', 'receptions', 'receiving_yards', 'receiving_tds', 'receiving_epa', 'air_yards', 'yac', 'target_share', 'air_yard_share', 'red_zone_touches',
  'goal_line_touches', 'rz_targets', 'rz_carries', 'gl_carries', 'explosive_rec', 'explosive_rush', 'longest_completion', 'longest_rush', 'longest_reception',
  'fumbles_lost', 'special_teams_tds', 'fg_made', 'fg_att', 'pat_made', 'kicking_points', 'def_interceptions', 'def_sacks', 'def_tackles_assists',
  'source_quality', 'source_provider', 'source_detail', 'source_updated_at'];
const INT_COLS = new Set(['season', 'week', 'snaps', 'routes', 'attempts', 'completions', 'passing_tds', 'interceptions', 'sacks_taken', 'dropbacks', 'scrambles', 'designed_rushes',
  'carries', 'rushing_tds', 'targets', 'receptions', 'receiving_tds', 'red_zone_touches', 'goal_line_touches', 'rz_targets', 'rz_carries', 'gl_carries', 'explosive_rec',
  'explosive_rush', 'fumbles_lost', 'special_teams_tds', 'fg_made', 'fg_att', 'pat_made', 'def_interceptions', 'def_tackles_assists']);
function cell(k, v) { if (v === undefined || v === null) return null; if (INT_COLS.has(k) && typeof v === 'number') return Math.round(v); if (typeof v === 'boolean') return v ? 't' : 'f'; return v; }
function runId(job) { return job + '_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex'); }

function connect(env) {
  const conn = pg.resolveConnection(env || process.env);
  if (!conn) return null;
  return pg.client(conn);
}

/* many rows of JSON through one psql session: temp table ← \copy, then SQL */
function jsonThrough(c, rows, sql) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edgd-props-'));
  const data = path.join(dir, 'rows.tsv');
  fs.writeFileSync(data, rows.map((r) => copyEscape(JSON.stringify(r)) + '\n').join(''));
  try {
    return c.script(['create temp table _j (j jsonb);', "\\copy _j (j) from '" + data + "' with (format text, null '\\N')", sql]);
  } finally { try { fs.unlinkSync(data); fs.rmdirSync(dir); } catch (_) {} }
}

function syncCatalog(c) {
  const rows = REG.features.map((f) => ({ feature_key: f.feature, feature_group: f.group, positions: f.positions, league: f.league, time_window: f.window,
    definition: f.definition, source: f.source, leakage_rule: f.leakage_rule, priority: f.priority }));
  jsonThrough(c, rows, "insert into props.feature_registry (feature_key, feature_group, positions, league, time_window, definition, source, leakage_rule, priority) " +
    "select j->>'feature_key', j->>'feature_group', array(select jsonb_array_elements_text(j->'positions')), j->>'league', j->>'time_window', j->>'definition', j->>'source', j->>'leakage_rule', j->>'priority' from _j on conflict (feature_key) do nothing;");
}

function syncEntities(c, wh) {
  const teams = new Map();
  Object.keys(wh.leagues).forEach((lg) => wh.leagues[lg].games.forEach((g) => {
    teams.set(lg + '|' + g.home_team_id, { league: lg, team_id: String(g.home_team_id), name: g.home_team_name || g.home_team_id, division: g.home_division || null, conference: g.home_conference || null });
    teams.set(lg + '|' + g.away_team_id, { league: lg, team_id: String(g.away_team_id), name: g.away_team_name || g.away_team_id, division: g.away_division || null, conference: g.away_conference || null });
  }));
  jsonThrough(c, Array.from(teams.values()), "insert into props.dim_team (league, team_id, name, division, conference) select j->>'league', j->>'team_id', j->>'name', j->>'division', j->>'conference' from _j " +
    "on conflict (league, team_id) do update set name = excluded.name, division = coalesce(excluded.division, props.dim_team.division), conference = coalesce(excluded.conference, props.dim_team.conference);");
  const players = wh.identity.players.map((p) => ({ player_id: p.player_id, full_name: p.full_name || p.player_id, birth_date: p.birth_date || null, position: p.position || null,
    college_last: p.college_last || null, college_last_name: p.college_last_name || null, nfl_gsis_id: p.nfl_gsis_id || null, nfl_espn_id: p.nfl_espn_id || null, cfb_espn_id: p.cfb_espn_id || null,
    pfr_id: p.pfr_id || null, identity_confidence: p.identity_confidence == null ? 1 : p.identity_confidence, identity_status: p.identity_status || 'cfb_only',
    first_seen_season: p.first_seen_season, last_seen_season: p.last_seen_season, cfb_first_season: p.cfb_first_season, cfb_last_season: p.cfb_last_season,
    nfl_first_season: p.nfl_first_season, nfl_last_season: p.nfl_last_season, draft_year: p.draft_year, draft_round: p.draft_round, draft_pick: p.draft_pick, headshot: p.headshot || null }));
  jsonThrough(c, players, "insert into props.dim_player select (jsonb_populate_record(null::props.dim_player, j || jsonb_build_object('created_at', now(), 'updated_at', now()))).* from _j " +
    "on conflict (player_id) do update set full_name = excluded.full_name, position = excluded.position, college_last = excluded.college_last, college_last_name = excluded.college_last_name, " +
    "nfl_gsis_id = excluded.nfl_gsis_id, nfl_espn_id = excluded.nfl_espn_id, pfr_id = excluded.pfr_id, identity_confidence = excluded.identity_confidence, identity_status = excluded.identity_status, " +
    "first_seen_season = excluded.first_seen_season, last_seen_season = excluded.last_seen_season, cfb_last_season = excluded.cfb_last_season, nfl_last_season = excluded.nfl_last_season, " +
    "draft_year = excluded.draft_year, draft_round = excluded.draft_round, draft_pick = excluded.draft_pick, headshot = excluded.headshot, updated_at = now();");
  jsonThrough(c, wh.identity.idMap, "insert into props.player_id_map (source, source_id, player_id, method, confidence) select j->>'source', j->>'source_id', j->>'player_id', j->>'method', (j->>'confidence')::numeric " +
    "from _j where exists (select 1 from props.dim_player p where p.player_id = j->>'player_id') on conflict (source, source_id) do update set player_id = excluded.player_id, method = excluded.method, confidence = excluded.confidence;");
  const bridge = wh.identity.bridge.map((b) => Object.assign({ bridge_id: 'br_' + crypto.createHash('sha256').update([b.player_id, b.cfb_espn_id, b.nfl_gsis_id].join('|')).digest('hex').slice(0, 24) }, b));
  jsonThrough(c, bridge, "insert into props.bridge_cfb_nfl_player (bridge_id, player_id, cfb_espn_id, nfl_gsis_id, college_team, college_name, draft_year, draft_round, draft_pick, match_method, match_confidence, manual_reviewed, needs_review, name_variant) " +
    "select j->>'bridge_id', j->>'player_id', j->>'cfb_espn_id', j->>'nfl_gsis_id', j->>'college_team', j->>'college_name', (j->>'draft_year')::int, (j->>'draft_round')::int, (j->>'draft_pick')::int, j->>'match_method', " +
    "(j->>'match_confidence')::numeric, coalesce((j->>'manual_reviewed')::boolean, false), coalesce((j->>'needs_review')::boolean, false), j->>'name_variant' from _j " +
    "where exists (select 1 from props.dim_player p where p.player_id = j->>'player_id') on conflict (bridge_id) do nothing;");
  const reviews = wh.identity.review.map((r) => Object.assign({ review_id: 'rv_' + crypto.createHash('sha256').update([r.gsis_id, r.reason].join('|')).digest('hex').slice(0, 24) }, r));
  jsonThrough(c, reviews, "insert into props.identity_review (review_id, gsis_id, name, college, reason, candidates) select j->>'review_id', j->>'gsis_id', j->>'name', j->>'college', j->>'reason', " +
    "array(select jsonb_array_elements_text(j->'candidates')) from _j on conflict (review_id) do nothing;");
  return { teams: teams.size, players: players.length, bridge: bridge.length, reviews: reviews.length };
}

function syncGames(c, wh) {
  const rows = [];
  Object.keys(wh.leagues).forEach((lg) => wh.leagues[lg].games.forEach((g) => rows.push({ game_id: g.game_id, league: lg, source_game_id: g.source_game_id, espn_event_id: g.espn_event_id || null,
    season: g.season, week: g.week, season_type: g.season_type, kickoff_utc: g.kickoff_utc, home_team_id: String(g.home_team_id), away_team_id: String(g.away_team_id),
    venue_id: g.venue_id || null, venue_name: g.venue_name || null, surface: g.surface || null, roof: g.roof || null, neutral_site: !!g.neutral_site,
    home_division: g.home_division || null, away_division: g.away_division || null, status: g.status, home_score: g.home_score, away_score: g.away_score,
    weather_temp_f: g.weather_temp_f == null ? null : g.weather_temp_f, weather_wind_mph: g.weather_wind_mph == null ? null : g.weather_wind_mph,
    market_home_line: g.market ? g.market.home_line : null, market_total: g.market ? g.market.total : null, market_basis: g.market ? g.market.basis : null, market_source: g.market ? g.market.source : null,
    source_provider: g.source_provider })));
  jsonThrough(c, rows, "insert into props.dim_game select (jsonb_populate_record(null::props.dim_game, j)).* from _j on conflict (game_id) do update set " +
    "kickoff_utc = excluded.kickoff_utc, status = excluded.status, home_score = excluded.home_score, away_score = excluded.away_score, weather_temp_f = excluded.weather_temp_f, " +
    "weather_wind_mph = excluded.weather_wind_mph, market_home_line = excluded.market_home_line, market_total = excluded.market_total, market_basis = excluded.market_basis, market_source = excluded.market_source;");
  return rows.length;
}

/* player-games by season (COPY → staging → promote); seasons defaults to the
   current one plus any season the database does not hold yet */
function syncFacts(c, wh, opts) {
  opts = opts || {};
  const out = {};
  const have = new Map((c.rows("select season, count(*)::int as n from props.fact_player_game group by season") || []).map((r) => [r.season, r.n]));
  const cur = io.currentSeason();
  Object.keys(wh.leagues).forEach((lg) => {
    const bySeason = new Map();
    wh.leagues[lg].playerGames.forEach((r) => { if (!r.player_id) return; let a = bySeason.get(r.season); if (!a) { a = []; bySeason.set(r.season, a); } a.push(r); });
    bySeason.forEach((rows, season) => {
      if (!opts.all && season !== cur && have.get(season)) return;
      const rid = runId('fpg_' + lg.toLowerCase() + '_' + season);
      c.exec("insert into props.ingestion_runs (run_id, job, league, season, source, status) values (" + [rid, 'build_player_game_fact', lg, season, lg === 'NFL' ? 'nflverse' : 'sportsdataverse', 'running'].map(pg.lit).join(',') + ")");
      for (let i = 0; i < rows.length; i += 25000) {
        const lines = rows.slice(i, i + 25000).map((r) => copyLine(FPG_COLS.map((k) => cell(k, r[k])).concat([rid]))).join('');
        c.copyFrom('props.stg_player_game', FPG_COLS.concat(['run_id']), lines);
      }
      const res = JSON.parse(c.scalar("select props.promote_player_games(" + pg.lit(rid) + ")::text") || '{}');
      c.exec("update props.ingestion_runs set finished_at = now(), status = 'ok', rows_read = " + rows.length + ", rows_loaded = " + (res.upserted || 0) + ", rows_quarantined = " + (res.quarantined || 0) +
        ", notes = " + pg.lit(JSON.stringify(res)) + "::jsonb where run_id = " + pg.lit(rid));
      out[lg + ' ' + season] = res;
    });
  });
  return out;
}

function syncTeamGames(c, wh) {
  const rows = [];
  Object.keys(wh.leagues).forEach((lg) => wh.leagues[lg].teamGames.forEach((t) => rows.push(t)));
  const cur = io.currentSeason();
  const want = rows.filter((t) => t.season >= cur - 1);
  jsonThrough(c, want, "insert into props.fact_team_game select (jsonb_populate_record(null::props.fact_team_game, j)).* from _j where exists (select 1 from props.dim_game g where g.game_id = j->>'game_id') " +
    "on conflict (game_id, team_id) do nothing;");
  return want.length;
}

function syncModels(c) {
  const reg = io.readJson(path.join(__dirname, 'models', 'registry.json'), { models: [] });
  const rows = reg.models.map((m) => {
    const art = io.readJson(path.join(__dirname, 'models', m.league.toLowerCase(), m.model_version + '.json'));
    return art ? { model_version: m.model_version, model_name: m.model_name, league: m.league, position_group: m.position_group, market_key: m.market_key, family: m.family, algorithm: m.algorithm,
      feature_version: m.feature_version, training_from: m.training_seasons[0], training_to: m.training_seasons[1], training_cutoff: m.training_cutoff, trained_at: m.trained_at, n_rows: m.n_rows,
      sha256: m.sha256, outcome_tier: m.outcome_tier || 'RESEARCH', use_recalibration: m.use_recalibration !== false, walk_forward: m.walk_forward || null, artifact: art, status: m.status } : null;
  }).filter(Boolean);
  jsonThrough(c, rows, "insert into props.model_registry (model_version, model_name, league, position_group, market_key, family, algorithm, feature_version, training_from, training_to, training_cutoff, trained_at, n_rows, sha256, outcome_tier, use_recalibration, walk_forward, artifact) " +
    "select j->>'model_version', j->>'model_name', j->>'league', j->>'position_group', j->>'market_key', j->>'family', j->>'algorithm', j->>'feature_version', (j->>'training_from')::int, (j->>'training_to')::int, " +
    "(j->>'training_cutoff')::timestamptz, (j->>'trained_at')::timestamptz, (j->>'n_rows')::int, j->>'sha256', j->>'outcome_tier', (j->>'use_recalibration')::boolean, j->'walk_forward', j->'artifact' from _j on conflict (model_version) do nothing; " +
    "insert into props.model_status_events (model_version, status, reason, actor) select j->>'model_version', j->>'status', 'registry sync', 'football/props/factory/db.js' from _j " +
    "where (select s.status from props.v_model_status s where s.model_version = j->>'model_version') is distinct from j->>'status';");
  return rows.length;
}

function syncPredictions(c, opts) {
  const cur = io.currentSeason();
  let n = 0;
  ['nfl', 'cfb'].forEach((lg) => {
    const rows = io.readJsonl(path.join(io.CACHE, 'ledger', lg, String(cur), 'predictions.jsonl'));
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 5000) {
      jsonThrough(c, rows.slice(i, i + 5000), "insert into props.model_prediction (prediction_id, game_id, player_id, market_key, league, asof_at, scored_at, model_version, feature_version, training_cutoff, " +
        "projected_mean, projected_median, projected_p10, projected_p25, projected_p75, projected_p90, projected_sd, uncertainty, sigma_mu, feature_completeness, imputed, source_max_timestamp, dist) " +
        "select j->>'prediction_id', j->>'game_id', j->>'player_id', j->>'market_key', j->>'league', (j->>'asof_at')::timestamptz, (j->>'scored_at')::timestamptz, j->>'model_version', j->>'feature_version', " +
        "(j->>'training_cutoff')::timestamptz, (j->>'projected_mean')::numeric, (j->>'projected_median')::numeric, (j->>'projected_p10')::numeric, (j->>'projected_p25')::numeric, (j->>'projected_p75')::numeric, " +
        "(j->>'projected_p90')::numeric, (j->>'projected_sd')::numeric, (j->>'uncertainty')::numeric, (j->>'sigma_mu')::numeric, (j->>'feature_completeness')::numeric, " +
        "array(select jsonb_array_elements_text(coalesce(j->'imputed','[]'::jsonb))), (j->>'source_max_timestamp')::timestamptz, j->'dist' from _j " +
        "where exists (select 1 from props.dim_game g where g.game_id = j->>'game_id' and g.kickoff_utc > (j->>'asof_at')::timestamptz) " +
        "and exists (select 1 from props.model_registry m where m.model_version = j->>'model_version') and exists (select 1 from props.dim_player p where p.player_id = j->>'player_id') " +
        "on conflict do nothing;");
      n += Math.min(5000, rows.length - i);
    }
  });
  return n;
}

function syncQuotes(c) {
  const cur = io.currentSeason();
  const out = {};
  ['nfl', 'cfb'].forEach((lg) => {
    for (let y = 2023; y <= cur; y++) {
      const rows = io.readJsonl(path.join(io.CACHE, 'ledger', lg, String(y), 'quotes.jsonl'));
      if (!rows.length) continue;
      let ins = 0;
      for (let i = 0; i < rows.length; i += 2000) {
        const o = jsonThrough(c, rows.slice(i, i + 2000), "select props.ingest_prop_quotes(jsonb_agg(j))::text from _j;");
        const m = /"inserted"\s*:\s*(\d+)/.exec(o || ''); if (m) ins += Number(m[1]);
      }
      out[lg + ' ' + y] = { read: rows.length, inserted: ins };
    }
  });
  return out;
}

function syncListings(c) {
  const cur = io.currentSeason();
  let n = 0;
  ['nfl', 'cfb'].forEach((lg) => {
    for (let y = 2023; y <= cur; y++) {
      const rows = io.readJsonl(path.join(io.CACHE, 'ledger', lg, String(y), 'listings.jsonl'));
      for (let i = 0; i < rows.length; i += 5000) {
        jsonThrough(c, rows.slice(i, i + 5000), "insert into props.fact_prop_listing (listing_id, league, game_id, player_id, market_key, sportsbook, snapshot_at, keys) " +
          "select j->>'listing_id', j->>'league', j->>'game_id', j->>'player_id', j->>'market_key', j->>'sportsbook', (j->>'snapshot_at')::timestamptz, array(select jsonb_array_elements_text(j->'keys')) from _j " +
          "where exists (select 1 from props.dim_game g where g.game_id = j->>'game_id') and exists (select 1 from props.dim_player p where p.player_id = j->>'player_id') on conflict (listing_id) do nothing;");
        n += Math.min(5000, rows.length - i);
      }
    }
  });
  return n;
}


/* the contract's first and last tables, as psql prints a boolean ('t' / 'f'):
   the string 'f' is truthy, so the answer is compared, never just tested */
const CONTRACT_TABLES = ['props.feature_registry', 'props.fact_prop_quote'];
function contractApplied(c) {
  return c.scalar('select ' + CONTRACT_TABLES.map((t) => 'to_regclass(' + pg.lit(t) + ') is not null').join(' and ')) === 't';
}

async function sync(wh, a) {
  a = a || {};
  const c = a.client || connect();
  if (!c) return { skipped: 'no SUPABASE_DB_URL / DATABASE_URL / EDGD_PG: nothing written to the database' };
  if (!c.ping()) return { skipped: 'the database did not answer' };
  if (!contractApplied(c)) return { skipped: 'supabase/props_factory.sql is not applied to this database: run the Props factory workflow once with mode apply_sql', not_applied: true };
  const out = {};
  syncCatalog(c);
  out.entities = syncEntities(c, wh);
  out.games = syncGames(c, wh);
  out.facts = syncFacts(c, wh, { all: a.allSeasons });
  out.team_games = syncTeamGames(c, wh);
  out.models = syncModels(c);
  out.predictions = syncPredictions(c);
  out.quotes = syncQuotes(c);
  out.listings = syncListings(c);
  out.quality = c.rows('select rule_id, violations, status from props.v_quality');
  console.log('[props sync] ' + JSON.stringify(out));
  return out;
}

module.exports = { sync, connect, jsonThrough, syncCatalog, syncEntities, syncGames, syncFacts, syncTeamGames, syncModels, syncPredictions, syncQuotes, syncListings, FPG_COLS };
