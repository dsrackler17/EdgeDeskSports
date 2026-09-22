#!/usr/bin/env node
/* ============================================================================
   THE FBS COVERAGE GATE.

   The board claims to cover every game involving an active FBS team. This is
   the job that has to be able to FAIL that claim, in CI, before a reader ever
   sees it — because "we expanded the board" is the kind of statement that is
   true the week it ships and quietly false the week a conference realigns, a
   program moves up from the FCS, or a feed renames a league.

   It rebuilds the universe from the season's own schedule feed, replays the
   completed games into the engine's rating state exactly as the browser does,
   builds the canonical slate, projects every eligible game, and then asks the
   questions that would catch a regression:

     1  every active FBS team resolves to a canonical identity
     2  every active FBS team has a conference or Independent classification
     3  every FBS-vs-FBS game has BOTH teams in the rating state
     4  no canonical game is duplicated
     5  no eligible game is dropped because neither side is Power 4
     6  cross-conference games classify correctly
     7  conference games classify correctly
     8  FBS-vs-FCS games stay visible and are held at thin data
     9  a missing quote stays NO MARKET rather than becoming a zero line
    10  stale quotes stay distinguishable from live ones
    11  the UI's totals reconcile with the export's totals
    12  selecting several conferences never duplicates a game
    13  historical conference attribution is season-correct
    14  the active FBS count is DERIVED, not stored

   It writes two artifacts:
     football/fbs/coverage.json   the machine-readable diagnostic
     football/fbs/slate.json      the canonical slate, every stable field on it

   Usage
     node football/fbs/build_coverage.js                 # current season
     node football/fbs/build_coverage.js --season 2026
     node football/fbs/build_coverage.js --check         # fail, write nothing
     node football/fbs/build_coverage.js --offline       # use the cached feeds
     node football/fbs/build_coverage.js --lookahead 10

   Exit 0 = every check passed. Exit 1 = a real coverage regression. Exit 2 =
   the job could not run at all (no schedule feed), which is reported as an
   inability to check rather than as a pass.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const CACHE = path.join(HERE, '.cache');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FBS = require(path.join(HERE, 'fbs.js'));
const IN = require(path.join(ROOT, 'football', 'matchup', 'inputs.js'));
const CONF = require(path.join(ROOT, 'football', 'matchup', 'confidence.js'));
const WX = require(path.join(ROOT, 'football', 'matchup', 'weather.js'));
const RECOVERY = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
const EPA = require(path.join(ROOT, 'football', 'fbs_epa', 'fbs_epa.js'));
const P = global.EDCfbP4Params;

const SCHED = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;
const LOOKAHEAD_DEFAULT = 10;

/* ------------------------------------------------------------------ args */
function parseArgs(argv) {
  const a = { season: null, check: false, offline: false, lookahead: LOOKAHEAD_DEFAULT, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--season') a.season = parseInt(argv[++i], 10);
    else if (v === '--check') a.check = true;
    else if (v === '--offline') a.offline = true;
    else if (v === '--quiet') a.quiet = true;
    else if (v === '--lookahead') a.lookahead = parseInt(argv[++i], 10);
  }
  if (!a.season) { const d = new Date(); a.season = (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
  return a;
}

/* ------------------------------------------------------------------- io */
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.length > 1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
const TRUE = v => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const NUM = v => { if (v == null || v === '') return null; const x = +v; return isFinite(x) ? x : null; };

async function loadSeason(season, offline) {
  const cached = path.join(CACHE, `cfb_schedules_${season}.csv`);
  if (offline && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  try {
    const r = await fetch(SCHED(season), { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cached, t); } catch (_) { /* cache is a convenience */ }
    return t;
  } catch (e) {
    if (fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
    throw e;
  }
}

/* the same row shape the browser builds from this feed */
function normRows(raw) {
  return raw.map(r => ({
    game_id: r.game_id, season: NUM(r.season), week: NUM(r.week), start_date: r.start_date,
    completed: TRUE(r.completed), neutral_site: TRUE(r.neutral_site),
    conference_game: TRUE(r.conference_game),
    venue_id: NUM(r.venue_id), venue: r.venue,
    home_id: r.home_id, home_team: r.home_team, home_conference: r.home_conference, home_division: r.home_division,
    away_id: r.away_id, away_team: r.away_team, away_conference: r.away_conference, away_division: r.away_division,
    home_points: NUM(r.home_points), away_points: NUM(r.away_points)
  }));
}

/* ------------------------------------------------------- the rating state
   The browser seeds from the trained table and absorbs every completed game
   in kickoff order. Replayed identically here: a coverage report built off a
   different state than the board's would be measuring the wrong thing. */
function buildState(rowsBySeason, season, efficiency) {
  const st = E.newState();
  let absorbed = 0, efficiencyGames = 0, efficiencyTeamRows = 0;
  const efficiencyMissingFinalGames = [];
  for (let y = P.trained_through_season + 1; y <= season; y++) {
    E.ingest.seasonBreak(st);
    const rows = rowsBySeason[y];
    if (!rows) continue;
    const ordered = rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    for (const r of ordered) {
      if (!r.completed || r.home_points == null || r.away_points == null) continue;
      const eg = efficiency && efficiency.games && efficiency.games[String(r.game_id)];
      const hKey = FBS.normKey(r.home_team), aKey = FBS.normKey(r.away_team);
      E.ingest.absorbGame(st, {
        home: r.home_team, away: r.away_team,
        home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: P.rating.seed_ratings }),
        away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: P.rating.seed_ratings }),
        neutral_site: r.neutral_site, home_points: r.home_points, away_points: r.away_points,
        team_stats: eg && eg.teams ? {
          home: eg.teams[hKey] || null,
          away: eg.teams[aKey] || null
        } : null
      });
      absorbed++;
    }
  }
  return { st, absorbed, efficiency_games_absorbed: efficiencyGames,
    efficiency_team_rows_absorbed: efficiencyTeamRows,
    efficiency_missing_final_games: efficiencyMissingFinalGames };
}

/* PROJECT A GAME THE WAY THE TERMINAL DOES.

   This used to hand the engine a request with every optional input hard-coded
   null — no roster, no injuries, no schedule context, no weather — which is
   why football/fbs/slate.json published `data_completeness: 0` on all 75
   games while the board on screen was pricing the same games with four of
   those inputs present. The artifact was not measuring EdgeDesk's coverage;
   it was measuring this function's own nulls.

   The assembly now lives in football/matchup/inputs.js, shared with the
   board, and returns two requests: the BASELINE (what the published number
   is priced from) and the ENRICHED one (baseline + the new starter context),
   whose output is published under `shadow_` names and priced nowhere. */
function project(st, item, season, ctx, si) {
  const g = item.g, m = item.meta;
  let asm;
  try {
    asm = IN.buildRequest(ctx, { game: g, meta: m, state: st, schedule_index: si, now: Date.now() });
  } catch (e) { return { status: 'THREW', reason: 'input assembly: ' + String(e && e.message) }; }
  let base, shadow = null;
  try { base = E.projectGame(asm.baseline); } catch (e) { return { status: 'THREW', reason: String(e && e.message), assembly: asm }; }
  try { shadow = E.projectGame(asm.enriched); } catch (e) { shadow = { status: 'THREW', reason: String(e && e.message) }; }
  base.assembly = asm;
  base.shadow = shadow;
  return base;
}


/* The difference the starter context made, in the engine's own terms. */
function shadowEffect(base, sh, asm) {
  if (!asm || !sh || sh.status !== 'PREDICTED' || !base || base.status !== 'PREDICTED') return null;
  const st = (p, side) => {
    const q = p && p.layers && p.layers.qb && p.layers.qb[side];
    return q && q.stability && q.stability.available ? q.stability.value : null;
  };
  const line = Math.round((-sh.model.fair_spread - -base.model.fair_spread) * 100) / 100;
  const sig = Math.round((sh.model.sigma_margin - base.model.sigma_margin) * 1000) / 1000;
  const lam = (P.volatility && P.volatility.lambda) || {};
  const qbLambda = lam.qb_uncertainty;
  return {
    line_change: line, sigma_change: sig,
    qb_stability: { home: { baseline: st(base, 'home'), shadow: st(sh, 'home') },
      away: { baseline: st(base, 'away'), shadow: st(sh, 'away') } },
    why: (line === 0 && sig === 0)
      ? 'The resolved starter moved the engine\u2019s QB stability term off its "unknown starter" floor and moved '
        + 'nothing the engine prices. Two reasons, both structural and both documented. The QB layer\u2019s VALUE '
        + 'term prices EPA per dropback, and while that measurement now EXISTS for college football \u2014 '
        + 'football/fbs_epa carries it for every FBS quarterback from 2014 \u2014 the audit in '
        + 'football/fbs_epa/epa_contract.js establishes that the provider\u2019s series is not on the scale the '
        + 'shipped coefficient was fitted against, so it is published as research and the term still contributes '
        + 'no points. And the trained volatility model kept exactly one driver (early_season), so '
        + 'qb_uncertainty carries '
        + (qbLambda == null ? 'no coefficient at all' : ('a coefficient of ' + qbLambda))
        + ' and cannot widen or narrow the distribution either. The starter context is therefore research '
        + 'evidence and explanation today, not a model input, and this field says so instead of letting two '
        + 'identical numbers imply the starter was weighed and dismissed.'
      : 'The resolved starter changed the shadow line by ' + line + ' points and sigma by ' + sig
        + '. Research only until the starter layer has an out-of-sample record.'
  };
}

/* A NUMBER OR NOTHING, never a zero standing in for a null. */
function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }
function r2n(v, scale) { return isFiniteNum(v) ? Math.round(v * scale) / scale : null; }

/* ------------------------------------------------------------- the checks */
function run(report, name, detail, ok) {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) report.failures.push({ name, detail });
  return ok;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const log = (...x) => { if (!a.quiet) console.error(...x); };

  const rowsBySeason = {};
  let target = null;
  for (let y = P.trained_through_season + 1; y <= a.season; y++) {
    let text = null;
    try { text = await loadSeason(y, a.offline); } catch (e) { log(`[fbs] ${y}: ${e.message}`); }
    if (!text) { log(`[fbs] ${y}: schedule not published`); continue; }
    rowsBySeason[y] = normRows(parseCsv(text));
    if (y === a.season) target = rowsBySeason[y];
  }
  /* the PRIOR season, read for one purpose only: proving that conference
     attribution is season-correct. It is never absorbed into the state and
     never contributes a game to the slate — a historical alignment leaking
     into this season's classification is the exact bug this check exists to
     catch. */
  if (!rowsBySeason[a.season - 1]) {
    try {
      const t = await loadSeason(a.season - 1, a.offline);
      if (t) rowsBySeason[a.season - 1] = normRows(parseCsv(t));
    } catch (e) { log(`[fbs] ${a.season - 1} (season-awareness comparison): ${e.message}`); }
  }
  if (!target) {
    console.error(`[fbs] the ${a.season} schedule could not be read from either the network or the cache.`);
    console.error('[fbs] nothing is checked rather than a pass being reported on no data.');
    return 2;
  }

  const universe = FBS.buildUniverse({ rows: target, season: a.season,
    source: `cfbfastR-data schedules ${a.season}`, params: P,
    knownFbs: (P.rating && P.rating.seed_ratings) || null });
  const engineEfficiency = readJson(path.join(ROOT, 'football', 'rankings', 'engine_efficiency.json'), null);
  let engineEfficiencyProblem = null;
  if (!engineEfficiency) {
    engineEfficiencyProblem = 'football/rankings/engine_efficiency.json is missing';
  } else if (engineEfficiency.schema !== 'edgedesk_cfb_engine_efficiency_v1') {
    engineEfficiencyProblem = 'unexpected engine-efficiency schema';
  } else if (+engineEfficiency.season !== +a.season) {
    engineEfficiencyProblem = 'engine-efficiency artifact is for season ' + engineEfficiency.season + ', not ' + a.season;
  }

  const { st, absorbed } = buildState(rowsBySeason, a.season,
    engineEfficiencyProblem ? null : engineEfficiency);

  /* THE TEAM-STRENGTH BACKBONE. Historical replay above still owns game
     counts, scoring, efficiency and uncertainty. The current neutral-field
     mean comes from the richer national ETSR artifact, installed only AFTER
     replay so it cannot leak backwards into historical updates. Current
     availability is stripped here because the matchup layer prices the actual
     missing athlete separately for this fixture. */
  const canonicalRatingData = readJson(path.join(ROOT, 'football', 'rating', 'current.json'), null);
  let canonicalRatingProblem = null;
  if (!canonicalRatingData) {
    canonicalRatingProblem = 'football/rating/current.json is missing';
  } else if (canonicalRatingData.source_schema !== 'edgedesk_national_rankings_v1') {
    canonicalRatingProblem = 'rating artifact is not sourced from national ETSR';
  } else if (+canonicalRatingData.season !== +a.season) {
    canonicalRatingProblem = 'rating artifact is for season ' + canonicalRatingData.season + ', not ' + a.season;
  } else {
    E.ingest.setCanonicalRatings(st, canonicalRatingData, {
      strip_availability: true,
      source: 'EdgeDesk national ETSR · neutral-field pricing backbone'
    });
  }

  const built = FBS.buildSlate({ rows: target, universe, now: Date.now(), lookaheadDays: a.lookahead });
  const slate = built.items;

  /* Every committed input, read once, and the season's own schedule index so
     rest and travel are measured off the same rows the slate is built from. */
  const ctx = IN.load({ season: a.season, params: P, normKey: FBS.normKey });
  const ratingIndex = Object.assign({}, st.r);
  Object.keys(st.canonicalRatings || {}).forEach(k => { ratingIndex[k] = st.canonicalRatings[k].value; });
  const si = IN.scheduleIndex(target, ratingIndex);

  let weatherReport = null;
  /* THE FORECAST THE BOARD ALREADY FETCHES. This job passed `weather: null`
     and then reported the weather layer blind on every game, including the 73
     whose venue coordinates it was holding at the time. Same endpoint the
     terminal uses, through the recovery layer so it is bounded, and a refusal
     is recorded as a refusal rather than as an absence. */
  /* WHAT THE LAST SUCCESSFUL BUILD OBSERVED, so a build that cannot reach the
     provider publishes what EdgeDesk knew rather than less than it knew. */
  const FORECAST_STORE = path.join(ROOT, 'football', 'venues', 'forecasts.json');
  const prevForecast = readJson(FORECAST_STORE, null);
  if (!a.offline) {
    const sess = RECOVERY.session({ host_min_gap_ms: 80, budget_ms: 120000 });
    const wanted = slate.filter(it => !it.g.neutral_site).map(it => ({
      game_id: it.g.game_id, kickoff: it.g.start_date,
      venue: ctx.venues[(it.meta && it.meta.home.key) || FBS.normKey(it.g.home_team)] || null
    }));
    try {
      const wx = await WX.fetchForGames(sess, wanted, { concurrency: 6,
        previous: (prevForecast && prevForecast.by_game) || {} });
      ctx.weather = wx.byGame;
      ctx.weather_read_at = new Date().toISOString();
      /* committed only when something was actually observed: a build that
         answered nothing must not overwrite the store with its own emptiness */
      if (wx.report.answered > 0 || wx.report.dome > 0) {
        try {
          fs.writeFileSync(FORECAST_STORE, JSON.stringify({
            schema: 'edgedesk_forecast_store_v1',
            why: 'the last forecast EdgeDesk actually observed for each game, so a build that cannot reach the '
              + 'provider carries it forward at its real observation time instead of publishing a refusal. Only '
              + 'observed forecasts are written here; a carried one is never re-committed as a fresh one.',
            generated_at: new Date().toISOString(),
            source: 'open-meteo forecast (keyless), joined on the trained venue coordinates',
            by_game: WX.forCommit(wx.byGame, wanted)
          }, null, 1) + '\n');
        } catch (e) { log('[fbs] forecast store not written: ' + ((e && e.message) || e)); }
      }
      ctx.weather_attempted = true;
      ctx.weather_source = 'open-meteo forecast (keyless), joined on the trained venue coordinates';
      ctx.weather_failure = wx.report.failed
        ? Object.keys(wx.report.failures).map(k => k + ' x' + wx.report.failures[k]).join(', ')
        : null;
      weatherReport = wx.report;
      log('[fbs] weather: ' + wx.report.summary);
    } catch (e) {
      ctx.weather_attempted = true;
      ctx.weather_failure = String((e && e.message) || e).slice(0, 160);
      weatherReport = { error: ctx.weather_failure };
      log('[fbs] weather: ' + ctx.weather_failure);
    }
  } else {
    weatherReport = { skipped: '--offline: no forecast was requested' };
  }
  ctx.problems.forEach(x => log('[fbs] input: ' + x));

  const projected = {};
  const statuses = {};
  const recs = {};
  for (const it of slate) {
    const p = project(st, it, a.season, ctx, si);
    projected[it.meta.id] = p;
    statuses[p.status] = (statuses[p.status] || 0) + 1;
    const rec = (p.edge && p.edge.spread && p.edge.spread.recommendation) || 'NO_PROJECTION';
    recs[rec] = (recs[rec] || 0) + 1;
  }

  const auditRatings = Object.assign({}, st.r);
  Object.keys(st.canonicalRatings || {}).forEach(k => { auditRatings[k] = st.canonicalRatings[k].value; });
  const report = FBS.audit(universe, { slate, ratings: auditRatings, projected });
  report.generated_at = new Date().toISOString();
  report.lookahead_days = a.lookahead;
  report.absorbed_games = absorbed;
  report.engine = {
    model_version: P.model_version,
    trained_through: P.trained_through_season,
    rating_backbone: {
      source: st.canonicalRatingMeta && st.canonicalRatingMeta.schema,
      season: st.canonicalRatingMeta && st.canonicalRatingMeta.season,
      teams: st.canonicalRatingCount || 0,
      availability_stripped_before_matchup: !!(st.canonicalRatingMeta && st.canonicalRatingMeta.strip_availability),
      problem: canonicalRatingProblem
    },
    efficiency_replay: {
      source_schema: engineEfficiency && engineEfficiency.schema || null,
      season: engineEfficiency && engineEfficiency.season != null ? engineEfficiency.season : null,
      artifact_games_with_stats: engineEfficiency && engineEfficiency.games_with_stats || 0,
      artifact_team_game_rows: engineEfficiency && engineEfficiency.team_game_rows || 0,
      games_absorbed_with_stats: stateBuild.efficiency_games_absorbed,
      team_rows_absorbed: stateBuild.efficiency_team_rows_absorbed,
      final_games_without_play_stats: stateBuild.efficiency_missing_final_games.length,
      missing_game_ids: stateBuild.efficiency_missing_final_games.slice(0, 20),
      measured_features: engineEfficiency && engineEfficiency.measured_features || [],
      unavailable_features: engineEfficiency && engineEfficiency.unavailable_features || [],
      basis: 'score/margin is absorbed for every completed game; play-level efficiency is additionally absorbed only where the public rankings play feed has a real team-game row'
    }
  };
  report.projection_status = statuses;
  report.weather = weatherReport;
  report.spread_recommendation = recs;
  report.checks = [];
  report.failures = [];

  /* 0 — the richer neutral-field rating really is the pricing backbone. */
  const canonicalMissing = [];
  for (const k of universe.order) {
    const t = universe.teams[k];
    if (t.division === 'fbs' && !(st.canonicalRatings && st.canonicalRatings[k]))
      canonicalMissing.push(t.name);
  }
  run(report, 'canonical neutral-field ETSR covers every active FBS program',
    { source: report.engine.rating_backbone.source, teams: st.canonicalRatingCount || 0,
      expected: universe.counts.fbs_teams, problem: canonicalRatingProblem,
      missing: canonicalMissing.slice(0, 12) },
    !canonicalRatingProblem && canonicalMissing.length === 0
      && st.canonicalRatingCount === universe.counts.fbs_teams);

  /* 1 — canonical identity for every active FBS team */
  run(report, 'every active FBS team resolves to a canonical identity',
    { unmapped: report.unmapped_teams.length, fbs_teams: universe.counts.fbs_teams },
    report.unmapped_teams.length === 0 && universe.counts.fbs_teams > 0);

  /* 2 — a conference or Independent classification for every one of them */
  const noConf = [];
  for (const k of universe.order) {
    const t = universe.teams[k];
    if (t.division !== 'fbs') continue;
    if (!t.conference.id || !t.group) noConf.push(t.name);
  }
  run(report, 'every active FBS team carries a conference or Independent classification',
    { without: noConf }, noConf.length === 0);

  /* 3 — both teams of every FBS-vs-FBS game are in the rating state */
  const unrated = [];
  for (const it of slate) {
    if (it.meta.fbs_sides !== 2) continue;
    for (const side of [it.meta.home, it.meta.away])
      if (!(st.canonicalRatings && st.canonicalRatings[side.key]))
        unrated.push({ game: `${it.meta.away.name} @ ${it.meta.home.name}`, team: side.name });
  }
  run(report, 'every FBS-vs-FBS game has both teams in the canonical rating state',
    { unrated }, unrated.length === 0);

  /* 4 — no duplicate canonical games */
  run(report, 'no canonical game appears twice on the slate',
    { duplicates: report.duplicate_games, dropped_as_duplicate: built.dropped.duplicate },
    report.duplicate_games.length === 0);

  /* 5 — nothing dropped for not being Power 4. Computed by rebuilding the OLD
         predicate and proving those games are present, not by assertion. */
  const p4Ids = universe.p4.ids;
  const nonP4 = slate.filter(it => !it.meta.conference_ids.some(c => p4Ids.indexOf(c) >= 0));
  run(report, 'games with no Power 4 participant are on the slate',
    { non_power_games: nonP4.length, total: slate.length,
      example: nonP4.slice(0, 3).map(it => `${it.meta.away.name} @ ${it.meta.home.name}`) },
    slate.length > 0 && nonP4.length > 0);

  /* 6 — cross-conference games classify correctly */
  const crossBad = slate.filter(it => it.meta.fbs_sides === 2
    && it.meta.conference_ids.length === 2 && it.meta.is_conference_game);
  run(report, 'a game between two different conferences is never a conference game',
    { wrong: crossBad.map(it => `${it.meta.away.name} @ ${it.meta.home.name}`) }, crossBad.length === 0);

  /* 7 — conference games classify correctly */
  const confBad = slate.filter(it => it.meta.is_conference_game
    && (it.meta.conference_ids.length !== 1 || it.meta.conference_ids[0] === 'independents'));
  const confGames = slate.filter(it => it.meta.matchup_type === 'conference');
  run(report, 'every conference game has exactly one shared, non-independent conference',
    { conference_games: confGames.length, wrong: confBad.length }, confBad.length === 0);

  /* 8 — FBS-vs-FCS stays visible and stays thin */
  const fcsGames = slate.filter(it => it.meta.matchup_type === 'fbs_fcs');
  const fcsGraded = fcsGames.filter(it => {
    const p = projected[it.meta.id];
    return p && p.status === 'PREDICTED' && p.edge && p.edge.spread
      && p.edge.spread.recommendation !== 'PASS_LOW_CONFIDENCE'
      && p.edge.spread.recommendation !== 'NO_MARKET';
  });
  run(report, 'FBS-vs-FCS games stay on the slate and are never graded as a normal projection',
    { fbs_fcs_games: fcsGames.length, graded: fcsGraded.map(it => `${it.meta.away.name} @ ${it.meta.home.name}`) },
    fcsGames.length > 0 && fcsGraded.length === 0);

  /* 9 — a missing quote is NO MARKET, never a zero line. Proven on the
         engine's own contract: with no market supplied there is no gap and
         no spread edge, so nothing downstream can read a 0. */
  const zeroLine = [];
  for (const it of slate) {
    const p = projected[it.meta.id];
    if (!p || p.status !== 'PREDICTED') continue;
    if (p.market && p.market.spread_line === 0) zeroLine.push(`${it.meta.away.name} @ ${it.meta.home.name}`);
    if (p.market && p.market.spread_gap != null) zeroLine.push(`${it.meta.away.name} @ ${it.meta.home.name} (gap without a quote)`);
    if (p.edge && p.edge.spread && p.edge.spread.recommendation !== 'NO_MARKET'
      && p.edge.spread.recommendation !== 'PASS_LOW_CONFIDENCE')
      zeroLine.push(`${it.meta.away.name} @ ${it.meta.home.name} (edge without a quote)`);
  }
  run(report, 'a game with no quote produces no line, no gap and no spread edge',
    { offenders: zeroLine.slice(0, 6), n: zeroLine.length }, zeroLine.length === 0);

  /* 10 — the staleness distinction survives. The engine's own quote-age
          contract is what the board reads, so it is exercised here directly. */
  const fresh = E.market && typeof E.market.orientationFault === 'function';
  const staleProbe = (() => {
    const it = slate.find(x => x.meta.fbs_sides === 2);
    if (!it) return null;
    const live = project(st, it, a.season, ctx, si);
    return live && live.status === 'PREDICTED';
  })();
  run(report, 'the market layer is present and able to separate a live quote from a stale one',
    { orientation_guard: fresh, projects: staleProbe }, fresh && staleProbe !== false);

  /* 11 — UI totals reconcile with export totals: one slate, one count */
  run(report, 'the slate the board renders and the slate the export writes are the same list',
    { slate: slate.length, audit_total: report.slate.total }, slate.length === report.slate.total);

  /* 12 — multi-conference selection never duplicates */
  const dupCheck = (() => {
    const ids = universe.conferences.map(c => c.id);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const sel = FBS.filterSlate(slate, { conferences: [ids[i], ids[j]] });
      const seen = {};
      for (const it of sel) { if (seen[it.meta.id]) return { pair: [ids[i], ids[j]], id: it.meta.id }; seen[it.meta.id] = 1; }
      const a1 = FBS.filterSlate(slate, { conferences: [ids[i]] }).length;
      const b1 = FBS.filterSlate(slate, { conferences: [ids[j]] }).length;
      if (sel.length > a1 + b1) return { pair: [ids[i], ids[j]], union: sel.length, a: a1, b: b1 };
    }
    return null;
  })();
  run(report, 'selecting two conferences never duplicates a game',
    { pairs_tested: (universe.conferences.length * (universe.conferences.length - 1)) / 2, problem: dupCheck },
    dupCheck === null);

  /* 13 — historical conference attribution is season-correct. The prior
          season's own feed is read and a program that MOVED must come back
          with its old conference, not this year's. */
  const prior = rowsBySeason[a.season - 1];
  let seasonAware = { tested: false };
  if (prior) {
    const old = FBS.buildUniverse({ rows: prior, season: a.season - 1, params: P });
    const moved = [];
    for (const k of universe.order) {
      const now = universe.teams[k], then = old.teams[k];
      if (!now || !then || now.division !== 'fbs' || then.division !== 'fbs') continue;
      if (now.conference.id && then.conference.id && now.conference.id !== then.conference.id)
        moved.push({ team: now.name, from: then.conference.label, to: now.conference.label });
    }
    seasonAware = { tested: true, prior_season: a.season - 1, realigned: moved.length, moves: moved.slice(0, 12) };
    run(report, 'a program that changed conference reads its OWN season in each season\'s universe',
      seasonAware, old.season === a.season - 1 && universe.season === a.season);
  } else {
    run(report, 'a program that changed conference reads its OWN season in each season\'s universe',
      { tested: false, why: `the ${a.season - 1} feed was not available to compare against` }, true);
  }
  report.season_aware = seasonAware;

  /* 14 — the active FBS count is derived, not stored */
  const srcFbs = new Set();
  for (const r of target) {
    if (FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: P.rating.seed_ratings })) srcFbs.add(FBS.normKey(r.home_team));
    if (FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: P.rating.seed_ratings })) srcFbs.add(FBS.normKey(r.away_team));
  }
  run(report, 'the active FBS count comes from the feed, not from a stored number',
    { derived: srcFbs.size, universe: universe.counts.fbs_teams },
    srcFbs.size === universe.counts.fbs_teams);

  report.ok = report.failures.length === 0;

  /* ------------------------------------------------------- the artifacts */
  const slateRows = slate.map(it => {
    const m = it.meta, g = it.g, p = projected[m.id];
    const unc = (p && p.layers && p.layers.uncertainty && p.layers.uncertainty.context) || null;
    const asm = (p && p.assembly) || null;
    const sh = (p && p.shadow) || null;
    const qbEpaCard = (side) => {
      const pk = asm && asm.qb_epa && asm.qb_epa[side];
      return pk ? EPA.cardForm(pk) : null;
    };
    const starter = (side) => {
      const r = asm && asm.starters && asm.starters[side];
      if (!r) return null;
      return { status: r.status, confirmed: r.confirmed === true, player_id: r.player_id,
        player_name: r.player_name, label: r.label, source: r.source, source_url: r.source_url,
        published_at: r.published_at, retrieved_at: r.retrieved_at,
        availability: r.availability ? { state: r.availability.state, evidence: r.availability.evidence,
          why: r.availability.why, source_url: r.availability.source_url } : null,
        conflicts: (r.conflicts || []).length, priced: false,
        priced_why: asm.qb_pricing && asm.qb_pricing[side] ? asm.qb_pricing[side].why : null };
    };
    return {
      game_id: m.id, season: g.season, week: g.week, kickoff: g.start_date,
      neutral_site: !!g.neutral_site, venue: g.venue || null,
      home_team: g.home_team, away_team: g.away_team,
      home_team_id: m.home.key, away_team_id: m.away.key,
      home_conference: m.home.conference, away_conference: m.away.conference,
      home_conference_id: m.home.conference_id, away_conference_id: m.away.conference_id,
      home_fbs_group: m.home.group, away_fbs_group: m.away.group,
      home_division: m.home.is_fbs ? 'fbs' : 'non-fbs', away_division: m.away.is_fbs ? 'fbs' : 'non-fbs',
      matchup_type: m.matchup_type, is_conference_game: !!m.is_conference_game,
      model_status: (p && p.status) || 'NO_PREDICTION',
      /* `Math.round(null * 10) / 10` IS ZERO, and that is how eighteen
         FBS-vs-FCS games came to publish a projected total of 0.0. The engine
         had said the total was UNAVAILABLE for them — an FCS opponent has no
         scoring profile to build one from — and the rounding turned a declared
         absence into a number the AI, the newsletter and every export then
         read as EdgeDesk's projection. Guarded explicitly, the same way the
         board's own CSV writer guards it. */
      model_home_margin: r2n(p && p.status === 'PREDICTED' ? p.model.fair_spread : null, 100),
      model_home_line: r2n((p && p.status === 'PREDICTED' && isFiniteNum(p.model.fair_spread)) ? -p.model.fair_spread : null, 100),
      model_fair_total: r2n(p && p.status === 'PREDICTED' ? p.model.fair_total : null, 10),
      /* THE WIN PROBABILITY, AND THE TEXT THAT REFUSES TO ROUND IT INTO A
         CERTAINTY. Oregon at 0.9977 printed "100% / 0%" on the board, which
         is the one thing a projection built on a continuous margin
         distribution can never mean. The raw number is published for anything
         that computes with it and the bounded text for anything that shows
         it, so no surface has to remember the rule. */
      model_home_win_prob: (p && p.status === 'PREDICTED' && isFiniteNum(p.model.home_win_prob))
        ? p.model.home_win_prob : null,
      model_home_win_text: (p && p.status === 'PREDICTED' && isFiniteNum(p.model.home_win_prob))
        ? CONF.outcomeLabel(p.model.home_win_prob).text : null,
      model_away_win_text: (p && p.status === 'PREDICTED' && isFiniteNum(p.model.home_win_prob))
        ? CONF.outcomeLabel(1 - p.model.home_win_prob).text : null,
      data_completeness: (unc && unc.information_missing != null) ? Math.round((1 - unc.information_missing) * 1000) / 1000 : null,
      /* THE CONTRACT, IN THE SEVEN STATES THAT ARE NOT THE SAME THING. The
         engine's own `data_completeness` is its internal probe count and is
         kept exactly as it was; these are the fields EdgeDesk went and got,
         with what does not apply to this game excluded from the denominator
         rather than counted as a hole. */
      input_coverage: asm ? asm.summary.input_coverage : null,
      priced_input_coverage: asm ? asm.summary.priced_coverage : null,
      input_contract: asm ? asm.contract : null,
      input_contract_summary: asm ? asm.summary : null,
      /* THE LEDGER: every contract field, what it feeds, and the exact number
         of points it is costing the displayed score — computed by the one
         module every consumer reads (football/matchup/confidence.js) rather
         than by each surface guessing at the arithmetic. It also publishes the
         five different numbers this card shows under their own names, so a
         reader comparing 73% with "11 of 17" can see they are different
         questions instead of concluding the page contradicts itself. */
      confidence_ledger: (asm && p && p.status === 'PREDICTED')
        ? CONF.ledger({
          contract: asm.contract,
          information: (p.layers && p.layers.uncertainty && p.layers.uncertainty.information) || {},
          weights: (P.confidence && P.confidence.weights) || {},
          summary: asm.summary,
          confidence: p.scores.confidence,
          confidence_priced: p.scores.confidence_priced,
          engine_completeness: (unc && unc.information_missing != null) ? (1 - unc.information_missing) : null,
          home_win_prob: p.model.home_win_prob,
          weight_total: Object.keys((P.confidence && P.confidence.weights) || {})
            .reduce((x, k) => x + P.confidence.weights[k], 0),
          home: g.home_team, away: g.away_team, now: Date.now()
        })
        : null,
      /* TWO CLOCKS, PUBLISHED SEPARATELY. A model rebuild does not refresh a
         price and a re-read does not renew an observation; conflating either
         pair is how a 57-hour-old quote came to sit under a live badge. */
      freshness: asm ? {
        model_built_at: report.generated_at,
        inputs: asm.contract.filter(r => r.as_of || r.observed_at).map(r => ({
          field: r.field + (r.side ? ':' + r.side : ''),
          observed_at: r.observed_at || r.as_of,
          retrieved_at: r.as_of,
          age_hours: r.age_hours, state: r.state })),
        market: { state: 'NOT JOINED IN THIS BUILD',
          why: 'the board and the exports carry the live quote; this artifact joins none, so it publishes no '
            + 'price age rather than the model build time in place of one' },
        note: 'model_built_at is when this artifact was written. It is NOT the age of any field in it: each input '
          + 'carries its own observation time, and a field re-read without changing keeps the observation time it '
          + 'already had.'
      } : null,
      home_starter: starter('home'),
      away_starter: starter('away'),
      /* THE MEASURED QUARTERBACK, in the compact form every surface renders.
         The board, the research card, the newsletter and the AI all read
         these two objects rather than each computing a rate from somewhere
         else, and `qb_epa_legend` on the artifact carries the prose once so
         152 of these do not each carry a paragraph. Research context: none of
         it is inside the projection above. */
      home_qb_epa: qbEpaCard('home'),
      away_qb_epa: qbEpaCard('away'),
      /* the unvalidated experiment, kept apart from the priced number and
         never published as one */
      shadow_model_version: sh && sh.status === 'PREDICTED' ? 'edgedesk_cfb_p4_v1.0.0+starter_context_v1' : null,
      shadow_home_line: r2n((sh && sh.status === 'PREDICTED' && isFiniteNum(sh.model.fair_spread)) ? -sh.model.fair_spread : null, 100),
      shadow_fair_total: r2n(sh && sh.status === 'PREDICTED' ? sh.model.fair_total : null, 10),
      shadow_delta_vs_model: (sh && sh.status === 'PREDICTED' && p && p.status === 'PREDICTED'
        && isFiniteNum(sh.model.fair_spread) && isFiniteNum(p.model.fair_spread))
        ? Math.round((-sh.model.fair_spread - -p.model.fair_spread) * 100) / 100 : null,
      shadow_status: 'RESEARCH ONLY — unvalidated, priced nowhere, graded on its own record',
      /* WHAT THE SHADOW ACTUALLY CHANGED, stated rather than left for a reader
         to infer from two identical numbers. Publishing a shadow line beside
         an unchanged model line with no explanation invites exactly the wrong
         conclusion — that the starter was considered and found irrelevant —
         when the truth is more specific and more useful than that. */
      shadow_effect: shadowEffect(p, sh, asm),
      spread_recommendation: (p && p.edge && p.edge.spread) ? p.edge.spread.recommendation : null,
      /* no market is joined in this offline job — the board and the exports
         carry the live quote. Stated, never faked as a number. */
      market_status: 'NOT JOINED IN THIS BUILD',
      quote_timestamp: null
    };
  });
  const artifact = {
    schema: 'edgedesk_fbs_slate_v1', version: FBS.VERSION,
    season: a.season, generated_at: report.generated_at,
    source: universe.source, lookahead_days: a.lookahead,
    window: built.window,
    counts: {
      slate: slate.length,
      fbs_teams: universe.counts.fbs_teams,
      conferences: universe.conferences.length,
      by_matchup: report.slate.by_matchup,
      by_group: report.slate.by_group,
      by_conference: report.slate.by_conference
    },
    p4_scope: universe.p4,
    conferences: universe.conferences,
    /* the sentences that belong to the quarterback cards, carried ONCE */
    qb_epa_legend: EPA.LEGEND,
    qb_epa_source: (() => {
      const ix = readJson(path.join(ROOT, 'football', 'fbs_epa', 'index.json'), null);
      if (!ix) return { state: 'ABSENT', why: 'football/fbs_epa has published no artifact' };
      return { season: ix.season, generated_at: ix.generated_at,
        freshness: EPA.freshness(ix, Date.now()),
        source_commit: ix.source ? ix.source.commit : null,
        coverage: { completed_games: ix.coverage.completed_by_cutoff,
          with_passing_data: ix.coverage.completed_games_with_passing_data,
          passer_rows: ix.coverage.passer_rows,
          passer_rows_with_athlete_id: ix.coverage.passer_rows_with_athlete_id,
          starters: ix.coverage.starters || null },
        priced_input: ix.contract.priced_input,
        why_not_priced: ix.contract.summary };
    })(),
    market_note: 'Market quotes are joined live in the browser from captured signals and cfb.lines. '
      + 'This offline artifact carries the slate, the identities and the model states only; it never '
      + 'invents a line, and a game with no quote is NO MARKET on the board rather than a zero here.',
    games: slateRows
  };

  if (!a.check) {
    fs.writeFileSync(path.join(HERE, 'coverage.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(HERE, 'slate.json'), JSON.stringify(artifact, null, 1) + '\n');
  }

  log(`[fbs] ${a.season}: ${universe.counts.fbs_teams} active FBS programs, `
    + `${universe.conferences.length} conferences, ${slate.length} games in the next ${a.lookahead} days`);
  log(`[fbs] matchups: ${JSON.stringify(report.slate.by_matchup)}`);
  log(`[fbs] groups:   ${JSON.stringify(report.slate.by_group)}`);
  log(`[fbs] non-power games on the slate: ${nonP4.length}`);
  for (const c of report.checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
  if (report.failures.length) {
    console.error(`[fbs] ${report.failures.length} coverage check(s) failed:`);
    for (const f of report.failures) console.error('   - ' + f.name + '  ' + JSON.stringify(f.detail).slice(0, 400));
    return 1;
  }
  log('[fbs] every coverage check passed');
  return 0;
}

if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => {
    console.error('[fbs] ' + (e && e.stack || e));
    process.exit(2);
  });
}
module.exports = { parseCsv, normRows, buildState, loadSeason };
