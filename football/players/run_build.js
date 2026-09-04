#!/usr/bin/env node
/* ============================================================================
   THE BUILD RUNNER — turns the raw public feeds into the materialised layers
   the research page reads, and writes a point-in-time snapshot every time.

   Called by build_players.js (which holds the loaders and the arithmetic) and
   kept separate from it so the tests and the walk-forward validator can
   require the pipeline without executing a build.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('./build_players.js');
const CFG = require('./config.js');
const EPIR = require('./epir.js');
const UNITS = require('./units.js');
const SCHEME = require('./scheme.js');

const DIR = __dirname;
const OUT_CUR = path.join(DIR, 'current.json');
const OUT_IX = path.join(DIR, 'index.json');
const OUT_TEAMS = path.join(DIR, 'teams');
const OUT_SNAP = path.join(DIR, 'snapshots');
const OUT_PARAMS = path.join(DIR, 'params.js');

const QUIET = process.argv.indexOf('--quiet') >= 0;
const DRY = process.argv.indexOf('--dry') >= 0;
function log(...a) { if (!QUIET) console.log(...a); }
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;
const r3 = v => v == null ? null : Math.round(v * 1000) / 1000;
const r4 = v => v == null ? null : Math.round(v * 10000) / 10000;

/* Availability, joined by NAME within a team because the availability dataset
   carries no athlete id. A name join is the weakest join this repo makes, so
   it is (a) scoped to one team, (b) refused when the report is stale, and
   (c) recorded on the player as a name join so the confidence pays for it. */
function loadAvailability() {
  const j = B.readJson(path.join(DIR, '..', 'availability', 'current.json'), null);
  if (!j || !j.teams) return { byTeamName: {}, meta: null, records: 0 };
  const byTeamName = {};
  let records = 0, stale = 0;
  for (const id of Object.keys(j.teams)) {
    const t = j.teams[id];
    const key = EPIR.teamKey(t.team_name || t.team_display);
    if (!key) continue;
    const m = byTeamName[key] = byTeamName[key] || {};
    for (const p of (t.players || [])) {
      /* HISTORICAL is the dataset's own word for "this report is old". An old
         report is not evidence about this week and is not used. */
      if (String(p.freshness || '').toUpperCase() === 'HISTORICAL') { stale++; continue; }
      const nk = EPIR.nameKey(p.player_name);
      if (!nk) continue;
      m[nk] = { status: p.availability_status, source: p.source_name,
        as_of: p.observed_at, confidence: p.confidence, impact: p.impact_level,
        join: 'name_within_team' };
      records++;
    }
  }
  return { byTeamName, records, stale, meta: { season: j.season, week: j.week, generated_at: j.generated_at, coverage: j.coverage } };
}

async function main() {
  const season = B.SEASON, back = B.SEASONS_BACK;
  const startedAt = new Date().toISOString();
  const seasons = [];
  for (let y = season - back + 1; y <= season; y++) seasons.push(y);
  log(`EdgeDesk player quality build — seasons ${seasons[0]}..${season}`);

  /* ---------------- load ---------------- */
  const sched = {}, roster = {}, play = {}, failed = [];
  for (const y of seasons) {
    try { sched[y] = await B.loadSchedule(y); } catch (e) { failed.push({ what: 'schedule ' + y, why: e.message }); }
  }
  for (const y of seasons.concat([seasons[0] - 1])) {
    try { roster[y] = await B.loadRoster(y); log(`  roster ${y}: ${roster[y].count} players (${roster[y].source || 'none'})`); }
    catch (e) { failed.push({ what: 'roster ' + y, why: e.message }); roster[y] = { players: {}, count: 0, source: null }; }
  }
  for (const y of seasons) {
    if (!sched[y]) continue;
    try {
      const t0 = Date.now();
      play[y] = await B.loadPlays(y, sched[y]);
      log(`  plays ${y}: ${play[y].counts.plays} rows, ${play[y].players.size} players, ${play[y].teamGameCount} team-games (${Date.now() - t0}ms)`);
    } catch (e) { failed.push({ what: 'player_stats ' + y, why: e.message }); }
  }
  const usable = seasons.filter(y => play[y] && sched[y]);
  if (!usable.length) {
    console.error('no season produced a usable play table — refusing to write anything');
    return 1;
  }

  /* ---------------- per-season normalise + rate, walking FORWARD ----------- */
  const careerIndex = {};          /* player key -> [{season, z, n}] from EARLIER seasons only */
  /* THE CANDIDATE GETS ITS OWN CHAIN. Rating 2026 under v2 off a career index
     built under v1 would be a hybrid of the two and would tell us nothing about
     either. Both variants are walked forward independently. */
  const careerIndexV2 = {};
  const boxBySeason = {};
  const bySeason = {};
  const coverageBySeason = {};
  const schemeBySeason = {};
  const teamAggBySeason = {};

  for (const y of usable) {
    /* the play-table gates, plus the box-score gates namespaced so the two
       feeds can disagree about coverage and both answers survive */
    const box = B.loadBox(y);
    const cov = Object.assign(B.coverageGates(play[y].counts, play[y].teamGameCount), box.coverage || {});
    coverageBySeason[y] = cov;
    boxBySeason[y] = box;
    const teamAgg = B.teamSeasonAggregates(play[y].teamGames, sched[y].fbs);
    teamAggBySeason[y] = teamAgg;
    const metrics = {};
    for (const met of B.ADJ_METRICS) {
      const a = B.opponentAdjust(play[y].teamGames, sched[y].fbs, met);
      if (a) metrics[met.id] = a;
    }
    const norm = B.normaliseSeason(y, play[y], roster[y] || { players: {}, count: 0 },
      roster[y - 1] || null, sched[y], { metrics, teamAgg, box });
    if (box.available) log(`  ${y}: box score joined to ${norm.players._box_joined || 0} players (${Object.keys(box.coverage).filter(k => box.coverage[k].usable).length} usable columns)`);
    else log(`  ${y}: ${box.reason}`);

    /* merge duplicate rows for one athlete (mid-season transfers, feed dupes) */
    const byKey = new Map();
    for (const rec of norm.players) {
      const k = EPIR.identity.key(rec);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(rec);
    }
    const merged = [];
    for (const [k, rows] of byKey) {
      if (rows.length === 1) { merged.push(rows[0]); continue; }
      const m = EPIR.identity.mergeSeason(rows);
      /* mergeSeason keeps counting stats only; carry the non-additive fields */
      m.pos_source = rows[rows.length - 1].pos_source;
      m.identity = rows[rows.length - 1].identity;
      m.sources = rows[rows.length - 1].sources;
      m.opponent = rows[rows.length - 1].opponent;
      m.stat.team_group_volume = rows[rows.length - 1].stat.team_group_volume;
      m.stat.team_def_games = rows[rows.length - 1].stat.team_def_games;
      merged.push(m);
    }

    const rated = EPIR.rateSeason(merged, {
      coverage: cov, leagueAllowed: norm.leagueAllowed, season: y,
      careerIndex, params: null, as_of: startedAt
    });
    bySeason[y] = { players: merged, ratings: rated.ratings, baselines: rated.baselines,
      leagueAllowed: norm.leagueAllowed, coverage: cov };

    /* extend the career index AFTER rating this season — a rating never sees
       its own future, which is what makes the historical replay honest */
    for (const r of rated.ratings) {
      if (!r.key) continue;
      (careerIndex[r.key] = careerIndex[r.key] || []).push({
        season: y, z: r.components.quality.z_raw, n: r.sample_size, dc: r.data_completeness
      });
    }
    /* the same walk, under the candidate contract */
    const ratedV2 = EPIR.rateSeason(merged, {
      coverage: cov, leagueAllowed: norm.leagueAllowed, season: y,
      careerIndex: careerIndexV2, params: null, as_of: startedAt, variant: 'v2'
    });
    bySeason[y].ratingsV2 = ratedV2.ratings;
    for (const r of ratedV2.ratings) {
      if (!r.key) continue;
      (careerIndexV2[r.key] = careerIndexV2[r.key] || []).push({
        season: y, z: r.components.quality.z_raw, n: r.sample_size, dc: r.data_completeness
      });
    }

    /* roster position spelling, for the front-family guess */
    const rosterPositions = {};
    for (const rec of merged) {
      if (!rec.team_key || !rec.pos) continue;
      (rosterPositions[rec.team_key] = rosterPositions[rec.team_key] || []).push(rec.pos);
    }
    /* a week-one profile is mostly last season's team, and says so */
    const prevAgg = teamAggBySeason[y - 1] || null;
    const offBlend = SCHEME.blendAggregates(teamAgg.off, prevAgg && prevAgg.off, null);
    const defBlend = SCHEME.blendAggregates(teamAgg.def, prevAgg && prevAgg.def, null);
    schemeBySeason[y] = SCHEME.buildProfiles(offBlend, defBlend, { season: y, rosterPositions });
    log(`  ${y}: rated ${rated.ratings.length} players, ${Object.keys(schemeBySeason[y].teams).length} scheme profiles`);
  }

  /* ---------------- measured reliability -> k ---------------- */
  const pairs = [];
  for (let i = 1; i < usable.length; i++) {
    const y0 = usable[i - 1], y1 = usable[i];
    const prev = new Map();
    for (const r of bySeason[y0].ratings) if (r.key) prev.set(r.key, r);
    for (const r of bySeason[y1].ratings) {
      const p = r.key && prev.get(r.key);
      if (!p) continue;
      if (p.components.quality.z_raw == null || r.components.quality.z_raw == null) continue;
      if (p.group !== r.group) continue;
      pairs.push({ group: r.group, z1: p.components.quality.z_raw, z2: r.components.quality.z_raw,
        n1: p.sample_size, n2: r.sample_size });
    }
  }
  const reliability = EPIR.measureReliability(pairs, CFG.SHRINK.min_pairs_to_measure);
  log(`  reliability measured over ${pairs.length} consecutive-season pairs`);

  /* ---------------- re-rate the CURRENT season with measured k ------------- */
  const cur = season;
  const params = {
    schema: 'edgedesk_player_params_v1',
    generated_at: startedAt,
    config_version: CFG.versions.player_rating,
    trained_through_season: usable[usable.length - 1],
    seasons_used: usable,
    reliability,
    reliability_pairs: pairs.length,
    coverage: coverageBySeason,
    provenance: {
      player_stats: 'sportsdataverse/cfbfastR-data player_stats/csv/player_stats_<season>.csv (public, keyless, CORS-open)',
      rosters: 'sportsdataverse/cfbfastR-data rosters/csv/cfb_rosters_<season>.csv, with football/rosters/ (EdgeDesk ESPN sync) as the fallback',
      schedules: 'sportsdataverse/cfbfastR-data schedules/csv/cfb_schedules_<season>.csv',
      availability: 'football/availability/current.json (EdgeDesk’s own evidence-ranked dataset)',
      recruiting: null
    },
    recruiting_status: {
      wired: false,
      reason: CFG.OBSERVABILITY.recruiting_rating.reason,
      adapter: 'football/players/recruiting_adapter.js — normalises any source into a 0-100 recruiting_score and a prior z. No source is wired in, and every recruiting field ships null.'
    }
  };

  /* previous usage, carried into this season's role projection where this
     season has not produced enough attributed volume yet */
  if (prevSeasonOf(usable)) {
    const py = prevSeasonOf(usable);
    const priorShare = new Map();
    for (const r of bySeason[py].ratings) {
      if (r.key && r.role && r.role.share != null) priorShare.set(r.key, r.role.share);
    }
    for (const rec of bySeason[cur].players) {
      const k = EPIR.identity.key(rec);
      if (!k) continue;
      const vol = EPIR.volume(rec);
      if (vol > 0 && rec.stat && rec.stat.team_group_volume > 0) continue;
      if (priorShare.has(k)) rec.prior_role = { share: priorShare.get(k), season: py };
    }
  }

  const curRated = EPIR.rateSeason(bySeason[cur].players, {
    coverage: bySeason[cur].coverage, leagueAllowed: bySeason[cur].leagueAllowed,
    season: cur, careerIndex: careerIndexBefore(careerIndex, cur), params, as_of: startedAt
  });
  bySeason[cur].ratings = curRated.ratings;
  bySeason[cur].baselines = curRated.baselines;

  /* ---------------- EPIR v2, THE CANDIDATE ----------------
     Built on every run, canonical on none of them. v2 is v1 plus the box-score
     columns; whether it ever replaces v1 is decided by the walk-forward in
     football/validation/ and by nothing else — not by it being newer, and not
     by it looking better on a Tuesday. */
  const v2Rated = EPIR.rateSeason(bySeason[cur].players, {
    coverage: bySeason[cur].coverage, leagueAllowed: bySeason[cur].leagueAllowed,
    season: cur, careerIndex: careerIndexBefore(careerIndexV2, cur), params, as_of: startedAt,
    variant: 'v2'
  });
  const v2ByKey = {};
  for (const r of v2Rated.ratings) if (r.key) v2ByKey[r.key] = r;
  let moved = 0, movedSum = 0, newlyRated = 0;
  for (const r of curRated.ratings) {
    const b = v2ByKey[r.key];
    if (!b) continue;
    const d = b.epir - r.epir;
    if (Math.abs(d) >= 0.05) { moved++; movedSum += Math.abs(d); }
    if (r.measures_used.length === 0 && b.measures_used.length > 0) newlyRated++;
  }
  log(`  EPIR v2 candidate: ${moved} players move by 0.05+ (mean |move| ${moved ? (movedSum / moved).toFixed(2) : '0'}), ${newlyRated} players rateable for the first time`);

  /* ---------------- availability ---------------- */
  const avail = loadAvailability();
  const availByKey = {};
  for (const r of curRated.ratings) {
    const t = avail.byTeamName[r.team_key];
    if (!t) continue;
    const rec = t[EPIR.nameKey(r.name)];
    if (rec) availByKey[r.key] = rec;
  }
  log(`  availability: ${avail.records} live records, ${avail.stale} stale reports ignored, ${Object.keys(availByKey).length} joined to a rated player`);

  /* ---------------- units, returning value, transfers ---------------- */
  const prevSeason = usable.length > 1 ? usable[usable.length - 2] : null;
  const byTeam = {};
  for (const r of curRated.ratings) {
    if (!r.team_key) continue;
    (byTeam[r.team_key] = byTeam[r.team_key] || []).push(r);
  }
  const prevByTeam = {};
  if (prevSeason) for (const r of bySeason[prevSeason].ratings) {
    if (!r.team_key) continue;
    (prevByTeam[r.team_key] = prevByTeam[r.team_key] || []).push(r);
  }
  const curKeys = {};
  for (const r of curRated.ratings) if (r.key) curKeys[r.key] = r.team_key;

  const scheme = schemeBySeason[cur];
  const teams = {}, teamFiles = {};
  const netValues = [];
  for (const key of Object.keys(byTeam)) {
    if (!sched[cur] || !sched[cur].fbs[key]) continue;
    const profile = scheme.teams[key] || null;
    const ctx = SCHEME.unitContext(profile);
    const teamName = sched[cur].name[key] || (byTeam[key][0] && byTeam[key][0].team) || key;
    const prevRatings = prevByTeam[key] || [];
    /* returning value asks: of the value THIS team produced last season, how
       much is still here — wherever "here" is judged by the CURRENT roster */
    const backKeys = {};
    for (const r of byTeam[key]) if (r.key) backKeys[r.key] = 1;
    const ret = UNITS.returningValue(prevRatings, backKeys, { prior_season: prevSeason });

    const incoming = byTeam[key].filter(r => r.status === 'transfer');
    const outgoing = prevRatings.filter(r => r.key && curKeys[r.key] && curKeys[r.key] !== key);
    const tv = UNITS.transferValue(incoming, outgoing, {});
    netValues.push(tv.net_value);

    const unit = UNITS.rateTeam(key, teamName, byTeam[key], {
      availability: availByKey, teamContext: ctx, conference: sched[cur].conf[key] || null,
      season: cur, returning: ret, transfers: tv, as_of: startedAt
    });
    teams[key] = unit;
    teamFiles[key] = byTeam[key];
  }
  /* normalise the transfer index against the league's own spread */
  const nvSd = EPIR.sd(netValues);
  for (const key of Object.keys(teams)) {
    const tv = teams[key].transfers;
    if (!tv) continue;
    const re = UNITS.transferValue(
      teamFiles[key].filter(r => r.status === 'transfer'),
      (prevByTeam[key] || []).filter(r => r.key && curKeys[r.key] && curKeys[r.key] !== key),
      { league_value_sd: nvSd });
    teams[key].transfers = re;
  }

  /* ---------------- data quality ---------------- */
  const quality = dataQuality(bySeason[cur], curRated.ratings, avail, scheme, roster[cur], coverageBySeason[cur]);

  /* ---------------- write ---------------- */
  const week = currentWeek(sched[cur]);
  const manifest = {
    schema: 'edgedesk_player_quality_v1',
    version: 1,
    versions: CFG.versions,
    season: cur, week,
    generated_at: startedAt,
    seasons_used: usable,
    prior_season: prevSeason,
    team_count: Object.keys(teams).length,
    player_count: curRated.ratings.length,
    rated_with_production: curRated.ratings.filter(r => r.components.quality.z_career != null).length,
    rated_with_production_this_season: curRated.ratings.filter(r => r.components.quality.z_raw != null).length,
    coverage: coverageBySeason[cur],
    coverage_by_season: coverageBySeason,
    reliability,
    reliability_pairs: pairs.length,
    quality,
    availability: avail.meta,
    availability_records_used: Object.keys(availByKey).length,
    availability_stale_ignored: avail.stale,
    observability: CFG.OBSERVABILITY,
    candidates: [{ variant: 'v2', version: CFG.versions.player_rating_candidate,
      file: `candidates/v2-${cur}.json`, status: 'RESEARCH_ONLY',
      basis: 'EPIR v1 remains canonical. The v2 candidate exists beside it and is promoted only by the walk-forward in football/validation/.' }],
    box_enrichment: (function () {
      const b = boxBySeason[cur];
      return b && b.available
        ? { available: true, source: b.source, generated_at: b.generated_at,
            usable_columns: Object.keys(b.coverage).filter(k => b.coverage[k].usable),
            failed_columns: Object.keys(b.coverage).filter(k => !b.coverage[k].usable),
            players_joined: bySeason[cur].players._box_joined || 0 }
        : { available: false, reason: b ? b.reason : 'not loaded' };
    })(),
    baselines: baselineTable(curRated.baselines, bySeason, usable),
    scheme_league: scheme.league,
    scheme_unknown: CFG.SCHEME.not_derivable,
    teams: unitSummaries(teams),
    scheme: schemeHeadlines(scheme.teams),
    detail_note: 'Per-player detail, the full scheme profile and each unit’s projected participants live in football/players/teams/<team key>.json and are loaded on demand. This manifest is the league-wide view and is deliberately small enough to load on every page open.',
    failed_sources: failed,
    notes: [
      'Every number here is arithmetic over counted events. No language model produced, adjusted or reviewed any rating in this file.',
      'Snap counts do not exist in any public college feed. Role and participation are derived from TOUCH share and are labelled as such everywhere.',
      'An offensive lineman cannot be rated individually by anything public. His unit is rated from the team’s own observed sack rate and stuff rate allowed, and the file says so.',
      'A missing input contributes nothing and lowers confidence. It is never replaced by a league average.'
    ],
    sources: [
      { name: 'cfbfastR-data player_stats', url: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/', tier: 'public, keyless, CORS-open' },
      { name: 'cfbfastR-data rosters', url: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/rosters/csv/', tier: 'public, keyless, CORS-open' },
      { name: 'cfbfastR-data schedules', url: 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/', tier: 'public, keyless, CORS-open' },
      { name: 'EdgeDesk availability', url: 'football/availability/current.json', tier: 'EdgeDesk’s own dataset' },
      { name: 'EdgeDesk roster sync', url: 'football/rosters/', tier: 'EdgeDesk’s own dataset' }
    ]
  };
  manifest.digest = B.digestOf({ t: teams, p: curRated.ratings.length, s: cur, w: week });

  const ROLE_CODE = { STARTER: 1, ROTATION: 2, DEPTH: 3, UNKNOWN: 0 };
  const STATUS_CODE = { returning: 1, transfer: 2, new: 3, unknown: 0 };
  const index = curRated.ratings.map(r => [
    r.key, r.name, r.team_key, r.pos, r.group, r.epir, r2(r.confidence), r.sample_size,
    ROLE_CODE[r.role.expected_role] || 0, STATUS_CODE[r.status] || 0, r.seasons_observed, r2(r.data_completeness)
  ]);

  if (DRY) { log('dry run — nothing written'); return 0; }

  fs.mkdirSync(OUT_TEAMS, { recursive: true });
  fs.mkdirSync(OUT_SNAP, { recursive: true });
  writeIfChanged(OUT_CUR, JSON.stringify(manifest));
  writeIfChanged(OUT_IX, JSON.stringify({ schema: 'edgedesk_player_index_v1', season: cur, week,
    generated_at: startedAt, count: index.length,
    columns: ['key', 'name', 'team_key', 'position', 'group', 'epir', 'confidence',
      'sample_size (attributed events, NOT snaps)', 'role_code', 'status_code', 'seasons_observed', 'data_completeness'],
    role_codes: { 0: 'UNKNOWN', 1: 'STARTER', 2: 'ROTATION', 3: 'DEPTH' },
    status_codes: { 0: 'unknown', 1: 'returning', 2: 'transfer', 3: 'new' },
    note: 'The searchable index for the Player Explorer. Rows are arrays to keep it loadable on a phone; the per-player provenance lives in teams/<team key>.json.',
    players: index }));

  /* per-team detail, written compactly but completely: every measure used,
     every measure missing and why, for every player on the roster */
  const legend = playerLegend(coverageBySeason[cur]);
  const existing = new Set(fs.readdirSync(OUT_TEAMS).filter(f => f.endsWith('.json')));
  for (const key of Object.keys(teamFiles)) {
    const file = key + '.json';
    existing.delete(file);
    const hist = ratingHistory(key, bySeason, usable, cur);
    writeIfChanged(path.join(OUT_TEAMS, file), JSON.stringify({
      schema: 'edgedesk_player_team_v1', season: cur, week, team: teams[key].team, key,
      generated_at: startedAt,
      units: teams[key],
      scheme: (scheme.teams[key] ? compactScheme({ x: scheme.teams[key] }).x : null),
      legend: legend,
      players: teamFiles[key].map(compactPlayer),
      history: hist
    }));
  }
  for (const gone of existing) { try { fs.unlinkSync(path.join(OUT_TEAMS, gone)); } catch (_) {} }

  /* POINT-IN-TIME. Never overwritten. A rating that was 72 in week 1 and 84 in
     week 10 is two facts, and a historical simulation must use the one that
     existed when the game was played. */
  const snapName = `${cur}-w${String(week == null ? 0 : week).padStart(2, '0')}.json`;
  const snapPath = path.join(OUT_SNAP, snapName);
  /* HISTORY IS NOT REWRITTEN. The CURRENT week's snapshot is refreshed as that
     week's games land — that is the week's state, still forming. An EARLIER
     week's snapshot is finished and is never touched again: a backtest that
     re-reads it must get the numbers that existed then, not today's numbers
     with an old filename. A run that would rewrite a finished week refuses and
     says so rather than doing it quietly. */
  const finished = fs.readdirSync(OUT_SNAP)
    .filter(f => /^\d{4}-w\d{2}\.json$/.test(f))
    .filter(f => {
      const m = f.match(/^(\d{4})-w(\d{2})\.json$/);
      return +m[1] === cur && +m[2] < (week == null ? 0 : week);
    });
  if (finished.length) log(`  ${finished.length} earlier snapshot${finished.length === 1 ? '' : 's'} left untouched (finished weeks are never rewritten)`);
  const snapPlayers = {};
  for (const r of curRated.ratings) if (r.key) snapPlayers[r.key] = [r.epir, r2(r.confidence), r.sample_size];
  const teamSnap = {};
  for (const key of Object.keys(teams)) {
    const u = teams[key], g = {};
    for (const gk of Object.keys(u.groups)) g[gk] = [u.groups[gk].rating, r2(u.groups[gk].confidence)];
    teamSnap[key] = { o: u.offense.rating, d: u.defense.rating, ov: u.overall.rating, g,
      vc: u.returning && u.returning.value_continuity, rc: u.returning && u.returning.roster_continuity,
      tx: u.transfers && u.transfers.net_index };
  }
  fs.writeFileSync(snapPath, JSON.stringify({
    schema: 'edgedesk_player_snapshot_v1', season: cur, week, generated_at: startedAt,
    config_version: CFG.versions.player_rating, digest: manifest.digest,
    legend: { players: '[epir, confidence, sample_size]', teams: 'o=offense d=defense ov=overall g=groups vc=value continuity rc=roster continuity tx=net transfer index' },
    quality, teams: teamSnap, players: snapPlayers
  }));
  log(`  snapshot written: ${snapName}`);

  /* the walk-forward calibration is written by validate.js and must SURVIVE a
     rebuild: the build measures reliability, the validator measures whether
     any of it is allowed to move a line, and neither may quietly erase the
     other. If the calibration is missing the params file says so explicitly
     rather than defaulting to "applied". */
  let priorCal = null, priorVal = null;
  try { const old = require(OUT_PARAMS); priorCal = old.calibration || null; priorVal = old.validation_summary || null; } catch (_) {}
  params.calibration = priorCal || {
    player_points_per_unit: { value: null, points_applied: false,
      reason: 'football/players/validate.js has not been run against this build, so no scalar is calibrated and the player layer moves no line' },
    scheme_points_per_unit: { value: null, points_applied: false,
      reason: 'football/players/validate.js has not been run against this build, so no scalar is calibrated and the scheme layer moves no line' }
  };
  params.validation_summary = priorVal || { ran: false,
    reason: 'no walk-forward validation has been run against this build' };
  /* the candidate artifact. Separate file, separate version string, and the
     canonical current.json only NAMES it — nothing downstream picks it up by
     accident. */
  fs.mkdirSync(path.join(DIR, 'candidates'), { recursive: true });
  const v2Players = {};
  for (const r of v2Rated.ratings) {
    if (!r.key) continue;
    const base = curRated.ratings.find ? null : null;
    v2Players[r.key] = [r.epir, r2(r.confidence), r.sample_size, r.measures_used.length];
  }
  const v1ByKey = {};
  for (const r of curRated.ratings) if (r.key) v1ByKey[r.key] = r;
  const byGroup = {};
  for (const r of v2Rated.ratings) {
    const a = v1ByKey[r.key];
    if (!a) continue;
    const g = r.group || 'ATH';
    const x = byGroup[g] = byGroup[g] || { n: 0, moved: 0, sum_abs: 0, newly_rated: 0, mean_v1: 0, mean_v2: 0 };
    x.n++; x.mean_v1 += a.epir; x.mean_v2 += r.epir;
    const d = r.epir - a.epir;
    if (Math.abs(d) >= 0.05) { x.moved++; x.sum_abs += Math.abs(d); }
    if (a.measures_used.length === 0 && r.measures_used.length > 0) x.newly_rated++;
  }
  for (const g of Object.keys(byGroup)) {
    const x = byGroup[g];
    x.mean_v1 = r1(x.mean_v1 / x.n); x.mean_v2 = r1(x.mean_v2 / x.n);
    x.mean_abs_move = x.moved ? r2(x.sum_abs / x.moved) : 0;
    delete x.sum_abs;
  }
  writeIfChanged(path.join(DIR, 'candidates', `v2-${cur}.json`), JSON.stringify({
    schema: 'edgedesk_player_candidate_v2',
    variant: 'v2', version: CFG.versions.player_rating_candidate,
    canonical_version: CFG.versions.player_rating,
    season: cur, week, generated_at: startedAt,
    status: 'RESEARCH_ONLY',
    status_basis: 'a candidate is research until football/validation/ promotes it. Being newer is not evidence.',
    what_changed: 'v1 plus the box-score columns the source audit found: tackles, tackles for loss, hurries, passes defended, interceptions and punting — all gated per season, all joined on the same athlete id. Offensive contracts are untouched; ESPN’s adjusted QBR is deliberately excluded because this repo does not build ratings on another organisation’s rating.',
    by_group: byGroup,
    coverage: bySeason[cur].coverage,
    legend: ['epir_v2', 'confidence_v2', 'sample_size', 'measures_scored'],
    players: v2Players
  }));
  log(`  candidate written: candidates/v2-${cur}.json`);

  writeIfChanged(OUT_PARAMS, paramsFile(params));

  log(`done — ${Object.keys(teams).length} teams, ${curRated.ratings.length} players, week ${week}`);
  return 0;
}

function prevSeasonOf(usable) { return usable.length > 1 ? usable[usable.length - 2] : null; }

function careerIndexBefore(idx, season) {
  const out = {};
  for (const k of Object.keys(idx)) {
    const rows = idx[k].filter(r => r.season < season);
    if (rows.length) out[k] = rows;
  }
  return out;
}

function ratingHistory(teamKey, bySeason, usable, cur) {
  const out = {};
  for (const y of usable) {
    if (!bySeason[y]) continue;
    for (const r of bySeason[y].ratings) {
      if (!r.key) continue;
      if (y === cur && r.team_key !== teamKey) continue;
      if (y !== cur && r.team_key !== teamKey) continue;
      (out[r.key] = out[r.key] || []).push([y, r.epir, r2(r.confidence), r.sample_size, r.team_key]);
    }
  }
  return out;
}

/* Compact, but complete BY REFERENCE. Every long reason string is replaced by
   a code whose full text ships once per file in `legend`, so a 26 MB dataset
   became a 5 MB one without a single fact being dropped: the reader still gets
   the measure, the sample, the baseline it was standardised against, and the
   named reason every missing measure is missing. */
const MISS_KIND = { no_denominator: 'D', below_min_sample: 'S', no_baseline: 'B', coverage_gate: 'G' };
const UNMEAS_CODE = (() => {
  const rows = [
    ['recruiting', CFG.OBSERVABILITY.recruiting_rating.reason],
    ['snap_share', CFG.OBSERVABILITY.snap_share.reason],
    ['ol_individual', CFG.OBSERVABILITY.ol_individual.reason],
    ['tackles', CFG.OBSERVABILITY.tackles.reason],
    ['coverage_targets', CFG.OBSERVABILITY.coverage_targets.reason]
  ];
  for (const g of Object.keys(CFG.NO_PRODUCTION_FEED)) rows.push(['nofeed:' + g, CFG.NO_PRODUCTION_FEED[g]]);
  return rows;
})();
function unmeasuredCodes(list) {
  const out = [];
  for (const txt of list) {
    let hit = null;
    for (const [code, t] of UNMEAS_CODE) if (t === txt) { hit = code; break; }
    if (hit) { if (out.indexOf(hit) < 0) out.push(hit); }
    else if (out.indexOf(txt) < 0) out.push(txt);   /* a group-specific note ships in full */
  }
  return out;
}
function compactPlayer(r) {
  const o = {
    k: r.key, id: r.athlete_id, n: r.name, t: r.team_key, c: r.conference,
    p: r.pos, g: r.group, ht: r.height_in, wt: r.weight_lb,
    ps: r.prior_school || undefined, st: r.status, mv: r.mid_season_move || undefined,
    e: r.epir, cf: r2(r.confidence), sn: r.sample_size, cn: r.career_sample,
    dc: r2(r.data_completeness), dcs: r.data_completeness_from_season, so: r.seasons_observed, gm: r.games,
    role: r.role.expected_role, share: r.role.share,
    cfwd: r.role.carried_forward ? 1 : undefined,
    q: [r4(r.components.quality.z_raw), r4(r.components.quality.z_career), r4(r.components.quality.z_shrunk),
        r4(r.components.quality.prior_z), r3(r.components.quality.shrink_weight), r1(r.components.quality.k),
        r.components.quality.k_measured ? 1 : 0, r.components.quality.k_reliability_r, r.components.quality.k_pairs,
        r.components.quality.points],
    rp: r.components.role_value.points, xp: r.components.experience_value.points,
    it: r.identity_tier, psrc: r.pos_source || undefined,
    oa: [r.opponent_adjustment.measures_adjusted, r.opponent_adjustment.measures_total]
  };
  if (r.measures_used.length) {
    /* [key, value, opponent-adjusted value, n, z, weight, adjusted?]
       The BASELINE each z was taken against is a league fact, not a player
       fact: it ships once per group and season in current.json `baselines`,
       which is both smaller and more correct than repeating it fifteen
       thousand times. */
    o.u = r.measures_used.map(m => [m.key, r4(m.value), r4(m.adjusted_value), m.n, r3(m.z), m.w,
      m.opponent_adjusted ? 1 : 0]);
  }
  if (r.measures_missing.length) {
    /* [key, kind code, n, min_n] — the full sentence is rebuilt from the legend */
    o.m = r.measures_missing.map(m => m.kind === 'below_min_sample'
      ? [m.key, 'S', m.n, m.min_n] : [m.key, MISS_KIND[m.kind] || m.kind]);
  }
  /* the unmeasured list is fully derivable from the position group and the
     season's coverage gates, so it is NOT repeated on every player; the reader
     rebuilds it with legend.unmeasured_rule. Anything group-specific that is
     not derivable would ship here, and today nothing is. */
  const um = unmeasuredCodes(r.unmeasured).filter(c => c.length > 40);
  if (um.length) o.um = um;
  return o;
}
function playerLegend(coverage) {
  const gates = {};
  for (const k of Object.keys(coverage || {})) if (coverage[k].reason) gates[k] = coverage[k].reason;
  const um = {};
  for (const [code, txt] of UNMEAS_CODE) um[code] = txt;
  return {
    fields: { k: 'player key', id: 'athlete id', n: 'name', t: 'team key', c: 'conference', p: 'position',
      g: 'position group', ht: 'height (in)', wt: 'weight (lb)', ps: 'prior school', st: 'roster status',
      mv: 'moved schools mid-season', e: 'EPIR', cf: 'confidence',
      sn: 'sample size this season (attributed events, NOT snaps)', cn: 'career sample, recency-decayed',
      dc: 'data completeness', so: 'seasons observed in this feed', gm: 'games with an attributed event',
      role: 'projected role', share: 'share of his group’s attributed volume (touch share, not snap share)',
      cfwd: 'role share carried forward from last season', rp: 'role points', xp: 'experience points',
      it: 'identity join tier', psrc: 'where the position came from', oa: '[measures opponent-adjusted, measures scored]' },
    q: ['z_raw (this season)', 'z_career', 'z_shrunk', 'prior_z', 'shrink weight n/(n+k)', 'k', 'k measured?', 'reliability r', 'pairs', 'points'],
    u: ['measure', 'value', 'opponent-adjusted value', 'n', 'z', 'weight', 'opponent-adjusted?'],
    baselines: 'the mean, spread and population each z was taken against ship once per position group and season in current.json `baselines` — a league fact, not a player fact',
    m: ['measure', 'kind', 'n', 'min_n'],
    missing_kinds: {
      D: 'the player has no denominator for this measure — he did not do the thing being measured. This is NOT a score of zero.',
      S: 'the player has a denominator but it is below the minimum this measure needs to be read at all.',
      B: 'the measure could not be standardised: too few players in his position group cleared the minimum sample this season.',
      G: 'the feed’s own attribution column for this measure failed its coverage floor this season, so the measure is declared missing league-wide.'
    },
    coverage_gate_reasons: gates,
    unmeasured_codes: um,
    unmeasured_rule: 'every player carries: recruiting (no feed is wired in) and snap_share (no feed carries snap counts); every offensive lineman also carries ol_individual; every defender also carries tackles; every corner, safety and nickel also carries coverage_targets; a group with an empty measure contract carries its own no-production-feed statement from config.js NO_PRODUCTION_FEED. Rebuilt by the reader rather than repeated 15,000 times.',
    statement: 'Every number in this file is arithmetic over counted events. No language model produced, adjusted or reviewed any rating here.'
  };
}
/* The league-wide view: every team's unit ratings without the per-player
   projection lists, which live in the team files. */
/* Every group-season baseline a z on any player was taken against, so a rating
   can be recomputed from the file rather than believed. */
function baselineTable(curBaselines, bySeason, usable) {
  const out = {};
  for (const y of usable) {
    const b = (y === usable[usable.length - 1]) ? curBaselines : (bySeason[y] && bySeason[y].baselines);
    if (!b) continue;
    const season = out[y] = {};
    for (const g of Object.keys(b)) {
      const ms = {};
      for (const k of Object.keys(b[g].measures || {})) {
        const x = b[g].measures[k];
        ms[k] = x.usable === false ? { usable: false, n: x.n, why: x.reason }
          : { mean: r4(x.mean), sd: r4(x.sd), n: x.n };
      }
      season[g] = { population: b[g].population, measures: ms };
    }
  }
  return out;
}

function unitSummaries(teams) {
  const out = {};
  for (const k of Object.keys(teams)) {
    const u = teams[k], g = {};
    for (const gk of Object.keys(u.groups)) {
      const x = u.groups[gk];
      g[gk] = { r: x.rating, c: r2(x.confidence), sq: x.starter_quality, dq: x.depth_quality,
        ct: x.continuity, ex: x.experience, n: x.roster_size,
        out: x.availability.starters_out, unk: x.availability.unknown_share,
        pf: x.production_feed ? 1 : 0, tc: x.team_context ? r3(x.team_context.weight) : null };
    }
    out[k] = {
      team: u.team, conference: u.conference, groups: g,
      offense: { r: u.offense.rating, c: r2(u.offense.confidence), miss: u.offense.missing_groups },
      defense: { r: u.defense.rating, c: r2(u.defense.confidence), miss: u.defense.missing_groups },
      special: { r: u.special_teams.rating, c: r2(u.special_teams.confidence) },
      overall: { r: u.overall.rating, c: r2(u.overall.confidence) },
      returning: u.returning && u.returning.available ? {
        value_continuity: u.returning.value_continuity, roster_continuity: u.returning.roster_continuity,
        players_returning: u.returning.players_returning, players_prior: u.returning.players_prior,
        by_group: u.returning.by_group, prior_season: u.returning.prior_season
      } : { available: false, reason: u.returning && u.returning.reason },
      transfers: u.transfers ? {
        in: u.transfers.in.count, out: u.transfers.out.count,
        value_in: u.transfers.in.value, value_out: u.transfers.out.value,
        net_value: u.transfers.net_value, net_index: u.transfers.net_index,
        starters_in: u.transfers.in.starter_level.length, starters_out: u.transfers.out.starter_level.length,
        unknown_in: u.transfers.in.high_uncertainty.length
      } : null,
      players_rated: u.players_rated
    };
  }
  return out;
}

/* Scheme headlines for the league view: labels, confidence and the z-scores the
   matchup engine actually reads. The full profile is in the team file. */
function schemeHeadlines(teamsScheme) {
  const keep = ['plays_per_game', 'rush_rate', 'early_down_pass_rate', 'explosive_pass_rate',
    'explosive_rush_rate', 'success_rate', 'sack_rate_allowed', 'stuff_rate_allowed'];
  const keepD = ['def_rush_success_allowed', 'def_pass_success_allowed', 'def_explosive_rush_allowed',
    'def_explosive_pass_allowed', 'def_stuff_rate', 'def_sack_rate', 'def_success_allowed'];
  const out = {};
  for (const k of Object.keys(teamsScheme)) {
    const t = teamsScheme[k], o = { labels: t.labels, confidence: t.confidence.value,
      measured: t.confidence.measured_tendencies, contracted: t.confidence.contracted_tendencies,
      blend: t.blend || null, offense: {}, defense: {} };
    for (const m of keep) { const x = t.offense[m]; if (x) o.offense[m] = x.available ? { v: r4(x.value), z: x.z, n: x.n } : { v: null, why: x.reason }; }
    for (const m of keepD) { const x = t.defense[m]; if (x) o.defense[m] = x.available ? { v: r4(x.value), z: x.z, n: x.n } : { v: null, why: x.reason }; }
    out[k] = o;
  }
  return out;
}

function compactScheme(teamsScheme) {
  const out = {};
  for (const k of Object.keys(teamsScheme)) {
    const t = teamsScheme[k], o = { labels: t.labels, confidence: t.confidence, offense: {}, defense: {},
      front: t.front && t.front.available ? { share: r3(t.front.value), n: t.front.n, confidence: t.front.confidence } : null };
    for (const m of Object.keys(t.offense)) {
      if (m.charAt(0) === '_') continue;
      const x = t.offense[m];
      o.offense[m] = x.available ? { v: r4(x.value), z: x.z, n: x.n, c: r2(x.confidence) } : { v: null, why: x.reason };
    }
    for (const m of Object.keys(t.defense)) {
      if (m.charAt(0) === '_') continue;
      const x = t.defense[m];
      o.defense[m] = x.available ? { v: r4(x.value), z: x.z, n: x.n, c: r2(x.confidence) } : { v: null, why: x.reason };
    }
    out[k] = o;
  }
  return out;
}

function dataQuality(seasonData, ratings, avail, scheme, roster, coverage) {
  const n = ratings.length || 1;
  /* "production" means the player has production evidence AT ALL, from any
     season this build read — not only from the current one. In week one nobody
     has current-season measures, and reporting that as 0% player data would be
     a true sentence that gives a false impression. Both numbers ship. */
  const withProd = ratings.filter(r => r.components.quality.z_career != null).length;
  const withProdNow = ratings.filter(r => r.components.quality.z_raw != null).length;
  const inRoster = ratings.filter(r => r.roster !== false).length;
  const schemeConf = [];
  for (const k of Object.keys(scheme.teams)) schemeConf.push(scheme.teams[k].confidence.value);
  const gates = Object.keys(coverage).filter(k => coverage[k].usable).length;
  const dims = {
    player_data: { value: r3(Math.min(1, (roster && roster.count ? 1 : 0.4) * 0.5 + (withProd / n) * 0.5)),
      basis: `${withProd} of ${n} rated players have production the feed attributed in some season this build read (${withProdNow} in the current season so far); the rest are on the roster with no attributed event anywhere, and are rated at positional replacement with a low confidence that says so` },
    recruiting: { value: 0,
      basis: CFG.OBSERVABILITY.recruiting_rating.reason },
    production: { value: r3(gates / Object.keys(coverage).length),
      basis: `${gates} of ${Object.keys(coverage).length} attribution columns cleared their coverage floor this season` },
    availability: { value: r3(Math.min(1, (avail.records || 0) / 400)),
      basis: `${avail.records || 0} live availability records across FBS after ${avail.stale || 0} stale reports were discarded. College football has no universal injury report and this number will never reach 1.` },
    scheme: { value: r3(schemeConf.length ? EPIR.mean(schemeConf) : 0),
      basis: 'measured tendencies only. Personnel, concepts, coverage shells, blitz rate and box counts are not carried by any public feed and are never counted as measured.' }
  };
  let s = 0, c = 0;
  for (const k of Object.keys(dims)) { s += dims[k].value; c++; }
  return { dimensions: dims, overall: r3(s / c),
    basis: 'the unweighted mean of the five dimensions. Recruiting sits at zero and drags the overall down on purpose: a research layer that scored itself only on what it happens to have would be marking its own homework.' };
}

function currentWeek(sched) {
  if (!sched) return null;
  let w = 0;
  for (const g of sched.games) if (g.completed && g.week != null && g.week > w) w = g.week;
  return w;
}

function paramsFile(p) {
  return `if(typeof window==='undefined'){globalThis.window=globalThis;}
/* EdgeDesk Player Quality — MEASURED constants.
   GENERATED FILE. Written by football/players/run_build.js from the public
   feeds named inside. Never edit by hand: the weights and contracts live in
   football/players/config.js, and everything here was measured from data.
   The reliability block is what turns the shrinkage constant k from a
   preference into a measurement — k = n_bar (1 - r) / r, with r the observed
   season-to-season correlation of each position group's own composite. */
window.EDPlayerParams = ${JSON.stringify(p)};
if(typeof module!=='undefined'&&module.exports)module.exports=window.EDPlayerParams;
`;
}

function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
  /* the generated_at stamp changes every run; compare with it stripped so a
     quiet day commits nothing */
  const strip = s => String(s).replace(/"generated_at":"[^"]*"/g, '').replace(/"as_of":"[^"]*"/g, '');
  if (old != null && strip(old) === strip(text)) return false;
  fs.writeFileSync(file, text);
  return true;
}

module.exports = { main, loadAvailability, compactPlayer, dataQuality, currentWeek };
