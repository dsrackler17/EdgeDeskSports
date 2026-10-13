#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — my tables in the data pack's canonical contracts.

     node hockey/contracts/canonical.js [--season 2026] [--write]

   Maps three of my NHL tables onto the pack's contracts
   (datapack/quant_v1/schemas) with explicit units and quality flags, checks
   every row with engine/contracts.js, and writes the result — row counts,
   errors, and how often each field is missing, with the reason a field is
   always empty — to hockey/validation/nhl_contracts.json.

     hockey/shots          <- the ingested unblocked attempts (.cache/nhl_work)
     hockey/goalie_game    <- the team-game table's goalie columns
     shared/event_context  <- the schedule as the team-game table records it

   TIME. known_at is null on every row (first publication was never recorded);
   quality_status always carries RETRO. retrieved_at is the source file's
   fetch time from the ingest manifest — never the game time. Units follow
   the contract: seconds, feet (fastRhockey's x_fixed / y_fixed are feet from
   centre ice, the NHL's rink convention), degrees.

   Not mapped (stated, not filled): hockey/shifts — published by the source
   (≈ 12 MB a season) but not ingested; hockey/skater_game — the lineup
   ingest keeps only who dressed and their TOI; hockey/tracking — no source.
   --write also saves the canonical CSVs to .cache/nhl_work/canonical/.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../config');
const K = require('../../engine/contracts');
const { toCsv } = require('../../engine/csv');
const TG = require('../ingest/team_games');
const X = require('../xg/model');

const OUT = path.join(C.PATHS.validation, 'nhl_contracts.json');
const SOURCE = { pbp: 'sportsdataverse_fastrhockey_pbp_lite', goalie: 'sportsdataverse_fastrhockey_goalie_box+pbp_lite', schedule: 'sportsdataverse_fastrhockey_schedule+pbp_lite' };

const STATE = { ev5: 'EV_5V5', evo: 'EV_OTHER', pp: 'PP', sh: 'SH', enf: 'EN_OPPONENT_NET_EMPTY', ena: 'EN_OWN_NET_EMPTY' };
const RULES = {
  R: 'NHL regular season: 60 min; tied -> 5 min 3-on-3 sudden death (4-on-4 before 2015-16), then a shootout; the shootout winner is credited one goal',
  P: 'NHL playoffs: 60 min; tied -> 20-min 5-on-5 sudden-death periods until a goal; no shootout',
};

/* why a contract field is always empty in my mapping */
const REASONS = {
  'hockey/shots': {
    occurred_at: 'the feed gives game seconds, not wall-clock time',
    source_record_id: 'the compact shot record keeps no source event id; record_id is game id + ordinal',
    shooter_team_skaters: 'known exactly only at 5v5 (5); other states keep the state class, not counts',
    defending_team_skaters: 'as shooter_team_skaters',
    home_score_before: 'the shot record keeps the shooter\'s score difference, not both scores',
    away_score_before: 'as home_score_before',
    assisting_player_1_id: 'not kept in the compact shot record (present in the source play-by-play)',
    assisting_player_2_id: 'as assisting_player_1_id',
    shooting_side: 'not recorded (handedness is in the source rosters; not joined)',
    release_x: 'no tracking source', release_y: 'no tracking source',
    previous_shot_angle_change: 'computed inside the xG features, not stored',
    is_penalty_shot: 'not recorded in the compact shot record',
    is_missed: 'the compact record keeps unblocked attempts without the on-goal / wide split',
    is_one_timer: 'no source records it', is_deflected: 'the shot type keeps tips and deflections as one class',
    known_at: 'first publication was never recorded (retrospective data)',
  },
  'hockey/goalie_game': {
    toi_seconds: 'the team-game table keeps attempts faced, not goalie TOI (in the source goalie box; not joined)',
    shots_faced: 'the ledger counts unblocked attempts faced, which is not shots on goal — left empty rather than mislabelled',
    saves: 'needs shots on goal (above)',
    low_danger_shots: 'no danger-zone split is defined in my model', medium_danger_shots: 'as low_danger_shots', high_danger_shots: 'as low_danger_shots',
    rebounds_allowed: 'not aggregated per goalie',
    confirmed_starter: 'no confirmed-starter feed: the historical starter is known after the game only',
    starter_confirmed_at: 'as confirmed_starter',
    occurred_at: 'the game\'s scheduled start is the closest time recorded; left empty rather than implying the stat existed then',
    source_record_id: 'the goalie box row has no id of its own',
    known_at: 'first publication was never recorded (retrospective data)',
  },
  'shared/event_context': {
    venue_id: 'no arena table is wired', venue_surface: 'ice (not a variable)', roof_status: 'indoor (not a variable)', timezone: 'no arena table is wired',
    home_travel_km: 'no arena coordinates are wired', away_travel_km: 'as home_travel_km',
    home_timezone_shift_hours: 'no arena table', away_timezone_shift_hours: 'no arena table',
    venue_altitude: 'no arena table', temperature: 'indoor', wind_speed: 'indoor', wind_gust: 'indoor', humidity: 'indoor', precipitation_probability: 'indoor',
    neutral_site: 'the feed does not flag neutral sites (global-series games are home games in the schedule)',
    rivalry_game: 'no rivalry definition', context_asof: 'the schedule was retrieved after the fact; no as-of version exists',
    entity_id: 'a game-level row has no entity', source_record_id: 'the game id is the source record',
    known_at: 'first publication was never recorded (retrospective data)',
  },
};

function iso(ms) { return new Date(ms).toISOString(); }

function shotsFromRecord(rec, meta) {
  const g = rec.game; const out = []; let i = 0;
  for (const s of rec.shots) {
    i++;
    const r = K.blank('hockey', 'shots');
    const pIdx = s.period || null;
    Object.assign(r, {
      record_id: 'nhl:' + g.game_id + ':shot:' + i, event_id: 'nhl:' + g.game_id, entity_id: s.shooter != null ? 'nhl_player:' + s.shooter : null,
      source_id: SOURCE.pbp, retrieved_at: meta.retrieved_at, revision: 1,
      quality_status: ['RETRO', s.X == null ? 'NO_XY' : null, 'XG=' + meta.xg_model].filter(Boolean).join(';'),
      period: pIdx, shooter_team_skaters: s.state === 'ev5' ? 5 : null, defending_team_skaters: s.state === 'ev5' ? 5 : null,
      game_seconds: Number.isInteger(s.gs) ? s.gs : null,
      period_seconds: Number.isInteger(s.gs) && pIdx ? s.gs - (Math.min(pIdx, g.season_type === 'P' ? 99 : 4) - 1) * 1200 : null,
      time_since_previous_event_seconds: Number.isInteger(s.since_prev) ? s.since_prev : null,
      shooter_id: s.shooter != null ? String(s.shooter) : null, goalie_id: s.goalie != null ? String(s.goalie) : null,
      strength_state: s.state ? STATE[s.state] : null, shot_type: s.type || null, event_type: s.goal ? 'GOAL' : 'UNBLOCKED_NON_GOAL',
      previous_event_type: s.prev_type || null, game_type: g.season_type,
      rink_coordinate_convention: 'NHL feed x_fixed/y_fixed: feet from centre ice, attacking toward +x',
      x: typeof s.X === 'number' ? s.X : null, y: typeof s.Y === 'number' ? s.Y : null,
      distance: typeof s.dist === 'number' ? +s.dist.toFixed(2) : null, angle: typeof s.angle === 'number' ? +s.angle.toFixed(2) : null,
      is_goal: !!s.goal, is_rebound: !!s.rebound, is_rush: !!s.rush, is_empty_net: !!s.empty_net, is_blocked: false,
      provider_xg: typeof s.xg === 'number' ? +s.xg.toFixed(5) : null, provider_xg_model_version: typeof s.xg === 'number' ? 'edgedesk:' + meta.xg_model : null,
    });
    out.push(r);
  }
  return out;
}

function goalieGames(rows, retrievedAt) {
  const out = [];
  for (const t of rows) for (const i of [1, 2]) {
    const id = t['g' + i + '_id']; if (id == null || id === '') continue;
    const r = K.blank('hockey', 'goalie_game');
    Object.assign(r, {
      record_id: 'nhl:' + t.game_id + ':goalie:' + id, event_id: 'nhl:' + t.game_id, entity_id: 'nhl_player:' + id,
      source_id: SOURCE.goalie, retrieved_at: retrievedAt[t.season], revision: 1,
      quality_status: 'RETRO;XGA=' + (t.xg_model || 'none') + ';ALL_SITUATIONS_NON_EMPTY_NET',
      strength_state: 'ALL', goals_allowed: t['g' + i + '_ga'],
      expected_goals_against: t['g' + i + '_xga'] == null ? null : t['g' + i + '_xga'],
      started: t.g_start == null ? null : Number(t.g_start) === Number(id),
    });
    out.push(r);
  }
  return out;
}

function eventContext(teamRows, retrievedAt) {
  const games = new Map();
  for (const r of teamRows) { if (!games.has(r.game_id)) games.set(r.game_id, {}); games.get(r.game_id)[r.home ? 'h' : 'a'] = r; }
  const list = [...games.values()].filter((x) => x.h && x.a).sort((a, b) => (a.h.date < b.h.date ? -1 : a.h.date > b.h.date ? 1 : a.h.game_id - b.h.game_id));
  const played = new Map(); /* team -> [dates] */
  const day = (d) => Math.floor(Date.parse(d + 'T12:00:00Z') / 864e5);
  const out = [];
  for (const x of list) {
    const ctx = {};
    for (const [side, t] of [['home', x.h], ['away', x.a]]) {
      const ds = played.get(t.team) || [];
      const last = ds.length ? ds[ds.length - 1] : null;
      ctx[side + '_rest_days'] = last == null ? null : day(t.date) - last - 1;
      ctx[side + '_games_last_7_days'] = ds.filter((d) => day(t.date) - d <= 7).length;
      ctx['back_to_back_' + side] = last == null ? null : day(t.date) - last === 1;
    }
    const r = K.blank('shared', 'event_context');
    Object.assign(r, {
      record_id: 'nhl:' + x.h.game_id + ':context', event_id: 'nhl:' + x.h.game_id,
      source_id: SOURCE.schedule, retrieved_at: retrievedAt[x.h.season], revision: 1, quality_status: 'RETRO;SCHEDULE_FACTS_ONLY',
      occurred_at: x.h.start_utc || null, home_id: x.h.team, away_id: x.a.team, competition_id: 'NHL', season_id: String(x.h.season),
      scheduled_start: x.h.start_utc || null, season_type: x.h.type === 'P' ? 'POSTSEASON' : 'REGULAR', competition_rules: RULES[x.h.type] || null,
      home_rest_days: ctx.home_rest_days, away_rest_days: ctx.away_rest_days,
      home_games_last_7_days: ctx.home_games_last_7_days, away_games_last_7_days: ctx.away_games_last_7_days,
      postseason: x.h.type === 'P', back_to_back_home: ctx.back_to_back_home, back_to_back_away: ctx.back_to_back_away,
    });
    out.push(r);
    for (const t of [x.h, x.a]) { if (!played.has(t.team)) played.set(t.team, []); played.get(t.team).push(day(t.date)); }
  }
  return out;
}

function manifestFor(season) {
  try { return JSON.parse(fs.readFileSync(path.join(C.PATHS.cacheWork, 'games_' + season + '.manifest.json'), 'utf8')); } catch (_) { return null; }
}

function summarise(v, reasons) {
  const always = Object.entries(v.missing).filter(([, s]) => s === 1).map(([f]) => f);
  const partly = Object.fromEntries(Object.entries(v.missing).filter(([, s]) => s > 0 && s < 1));
  return { table: v.table, grain: v.grain, priority: v.priority, rows: v.rows, ok: v.ok, error_count: v.error_count, errors: v.errors.slice(0, 5),
    always_missing: always.map((f) => ({ field: f, reason: (reasons || {})[f] || 'not supplied by the source' })), partly_missing: partly };
}

function run(o) {
  o = o || {};
  const season = o.season || C.CURRENT_SEASON - 1;
  const man = manifestFor(season);
  const tables = [];
  const teamRows = TG.loadTeamGames([season]);
  const retrievedAt = { [season]: man && man.sources && man.sources.pbp && man.sources.pbp.fetched_at ? man.sources.pbp.fetched_at : null };
  const retrievedGoalie = { [season]: man && man.sources && man.sources.goalie_box && man.sources.goalie_box.fetched_at ? man.sources.goalie_box.fetched_at : retrievedAt[season] };
  const written = {};

  /* hockey/shots: needs the ingest cache and the season's xG model */
  const gz = path.join(C.PATHS.cacheWork, 'games_' + season + '.jsonl.gz');
  const mp = path.join(C.PATHS.xgModels, 'xg_for_' + season + '.json');
  if (fs.existsSync(gz) && fs.existsSync(mp) && retrievedAt[season]) {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')); const xg = X.predictor(m, m.id);
    const { applyXg } = require('../ingest/game');
    const shots = [];
    for (const line of zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8').split('\n')) {
      if (!line) continue;
      const rec = applyXg(JSON.parse(line), xg);
      shots.push(...shotsFromRecord(rec, { retrieved_at: retrievedAt[season], xg_model: xg.id }));
    }
    const v = K.validate('hockey', 'shots', shots);
    tables.push(summarise(v, REASONS['hockey/shots']));
    written.shots = shots;
  } else tables.push({ table: 'hockey/shots', rows: 0, ok: null, skipped: 'the ingest cache or the season\'s xG model is absent (run npm run nhl:backfill)' });

  if (retrievedAt[season]) {
    const gg = goalieGames(teamRows, retrievedGoalie);
    tables.push(summarise(K.validate('hockey', 'goalie_game', gg), REASONS['hockey/goalie_game']));
    const ec = eventContext(teamRows, retrievedAt);
    tables.push(summarise(K.validate('shared', 'event_context', ec), REASONS['shared/event_context']));
    written.goalie_game = gg; written.event_context = ec;
  } else tables.push({ table: 'hockey/goalie_game + shared/event_context', rows: 0, ok: null, skipped: 'no ingest manifest with the source retrieval time for season ' + season });

  const report = {
    schema: 'edgedesk_nhl_contracts_v1', season, contract: 'datapack/quant_v1/schemas/table_catalog.json',
    temporal: 'known_at null on every row; quality_status carries RETRO; retrieved_at is the source file\'s fetch time',
    tables,
    not_mapped: [
      { table: 'hockey/shifts', priority: 'P0', state: 'AVAILABLE_NOT_INGESTED', note: 'the source publishes shift charts (≈ 12 MB a season); on-ice player models would need them' },
      { table: 'hockey/skater_game', priority: 'P1', state: 'PARTIAL', note: 'the lineup ingest keeps who dressed and TOI only; the source box score has goals, shots, hits, blocks' },
      { table: 'hockey/tracking', priority: 'P2', state: 'UNAVAILABLE', note: 'no tracking source' },
      { table: 'shared/availability', priority: 'P0', state: 'UNAVAILABLE', note: 'no timestamped injury or lineup report feed; the dressed lineup is known only from the box score after the game' },
      { table: 'shared/market_quotes', priority: 'P0', state: 'GATED', note: 'NHL prices only through the odds gateway, disabled until authorised (hockey/market/quotes.json)' },
    ],
  };
  if (o.write) {
    const dir = path.join(C.PATHS.cacheWork, 'canonical'); fs.mkdirSync(dir, { recursive: true });
    for (const [name, rows] of Object.entries(written)) if (rows.length) fs.writeFileSync(path.join(dir, name + '_' + season + '.csv'), toCsv(Object.keys(rows[0]), rows));
  }
  return report;
}

module.exports = { shotsFromRecord, goalieGames, eventContext, run, REASONS, STATE };

if (require.main === module) {
  const i = process.argv.indexOf('--season');
  const r = run({ season: i >= 0 ? Number(process.argv[i + 1]) : undefined, write: process.argv.includes('--write') });
  for (const t of r.tables) console.log('[nhl contracts] ' + t.table + ': ' + (t.skipped ? 'skipped — ' + t.skipped : t.rows + ' rows, ' + (t.ok ? 'valid' : t.error_count + ' errors ' + JSON.stringify(t.errors)) + ', always missing ' + t.always_missing.length));
  if (process.argv.includes('--check')) {
    const bad = r.tables.filter((t) => t.ok === false);
    if (bad.length) { console.error('[nhl contracts --check] FAILED'); process.exit(1); }
    console.log('[nhl contracts --check] ok');
  } else fs.writeFileSync(OUT, JSON.stringify(r, null, 1) + '\n');
}
