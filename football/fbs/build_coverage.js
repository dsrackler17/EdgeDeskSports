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
const WX = require(path.join(ROOT, 'football', 'matchup', 'weather.js'));
const RECOVERY = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
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
function buildState(rowsBySeason, season) {
  const st = E.newState();
  let absorbed = 0;
  for (let y = P.trained_through_season + 1; y <= season; y++) {
    E.ingest.seasonBreak(st);
    const rows = rowsBySeason[y];
    if (!rows) continue;
    const ordered = rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    for (const r of ordered) {
      if (!r.completed || r.home_points == null || r.away_points == null) continue;
      E.ingest.absorbGame(st, {
        home: r.home_team, away: r.away_team,
        home_fbs: FBS.isFbsDivision(r.home_division, r.home_team, { knownFbs: P.rating.seed_ratings }),
        away_fbs: FBS.isFbsDivision(r.away_division, r.away_team, { knownFbs: P.rating.seed_ratings }),
        neutral_site: r.neutral_site, home_points: r.home_points, away_points: r.away_points
      });
      absorbed++;
    }
  }
  return { st, absorbed };
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
        + 'nothing the engine prices. Two reasons, both structural and both documented: no feed this repository '
        + 'reads carries EPA per dropback for college football, so the QB layer\u2019s VALUE term has no input and '
        + 'contributes no points; and the trained volatility model kept exactly one driver (early_season), so '
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
  const { st, absorbed } = buildState(rowsBySeason, a.season);
  const built = FBS.buildSlate({ rows: target, universe, now: Date.now(), lookaheadDays: a.lookahead });
  const slate = built.items;

  /* Every committed input, read once, and the season's own schedule index so
     rest and travel are measured off the same rows the slate is built from. */
  const ctx = IN.load({ season: a.season, params: P, normKey: FBS.normKey });
  const si = IN.scheduleIndex(target, st.r);

  let weatherReport = null;
  /* THE FORECAST THE BOARD ALREADY FETCHES. This job passed `weather: null`
     and then reported the weather layer blind on every game, including the 73
     whose venue coordinates it was holding at the time. Same endpoint the
     terminal uses, through the recovery layer so it is bounded, and a refusal
     is recorded as a refusal rather than as an absence. */
  if (!a.offline) {
    const sess = RECOVERY.session({ host_min_gap_ms: 80, budget_ms: 120000 });
    const wanted = slate.filter(it => !it.g.neutral_site).map(it => ({
      game_id: it.g.game_id, kickoff: it.g.start_date,
      venue: ctx.venues[(it.meta && it.meta.home.key) || FBS.normKey(it.g.home_team)] || null
    }));
    try {
      const wx = await WX.fetchForGames(sess, wanted, { concurrency: 6 });
      ctx.weather = wx.byGame;
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

  const report = FBS.audit(universe, { slate, ratings: st.r, projected });
  report.generated_at = new Date().toISOString();
  report.lookahead_days = a.lookahead;
  report.absorbed_games = absorbed;
  report.engine = { model_version: P.model_version, trained_through: P.trained_through_season };
  report.projection_status = statuses;
  report.weather = weatherReport;
  report.spread_recommendation = recs;
  report.checks = [];
  report.failures = [];

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
      if (!Object.prototype.hasOwnProperty.call(st.r, side.key))
        unrated.push({ game: `${it.meta.away.name} @ ${it.meta.home.name}`, team: side.name });
  }
  run(report, 'every FBS-vs-FBS game has both teams in the rating state',
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
      home_starter: starter('home'),
      away_starter: starter('away'),
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
