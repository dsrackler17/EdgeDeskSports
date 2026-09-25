#!/usr/bin/env node
/* ============================================================================
   THE ENRICHMENT BUILD — runs BEFORE reliability is scored.

     RAW SOURCES          provider adapters (providers/*.js), each with its own
                          health, none trusted blindly
       -> NORMALIZATION   one availability vocabulary, one QB evidence shape,
                          one market quote shape
       -> IDENTITY        every player to an ESPN athlete id on the current
                          roster, every team to the engine's key
       -> SOURCE AGREEMENT  the availability hierarchy, the QB hierarchy,
                          conflicts detected and resolved only where the
                          hierarchy permits
       -> FRESHNESS       each value on its own clock; last-known values
                          carried and marked STALE, never passed off as fresh
       -> EVIDENCE        coverage classes, confirmation levels, importance
                          and impact status, market quality, FCS bridge
       -> GAME PACKAGE    football/enrichment/current.json games[id]
                          (lib/game_evidence.js reads it)
       -> PROJECTION      untouched: nothing here is an engine input
       -> RELIABILITY     football/fbs/build_coverage.js scores each game from
                          its package

   A provider can fail without breaking the build: its failure is recorded,
   the other providers are used, certainty drops, and nothing it would have
   said is replaced by a default.

   GAMES THAT HAVE KICKED OFF ARE FROZEN. Their package is carried forward
   exactly as it was last published before kickoff and never recomputed, so
   the pregame ledger cannot be rewritten by a later refresh.

   Usage
     node football/enrichment/build_enrichment.js [--offline] [--dry] [--season 2026] [--now ISO] [--lookahead 10]
   Writes football/enrichment/current.json (the packages the board and the
   build read), current.full.json (every evidence record, for the admin
   views) and cache/evidence_cache.json.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const CTX = require('./context.js');
const C = require('./config.js');
const K = require('./core/cache.js');
const SCH = require('./core/scheduler.js');
const { Ledger } = require('./core/provider.js');
const PA = require('./providers/availability.js');
const PQ = require('./providers/qb.js');
const PM = require('./providers/market.js');
const AG = require('./availability/aggregator.js');
const RES = require('./qb/resolver.js');
const IMP = require('./impact/player_impact.js');
const STARTERS = require('./impact/starters.js');
const GE = require('../../lib/game_evidence.js');
const MC = require('../../lib/market_consensus.js');

const ROOT = CTX.ROOT;
const HERE = __dirname;
const POL = require(path.join(ROOT, 'football', 'availability', 'policy.js'));
const QBC = require(path.join(ROOT, 'football', 'matchup', 'qb_context.js'));
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

function args(argv) {
  const a = { offline: false, dry: false, season: null, now: null, lookahead: 10, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--offline') a.offline = true;
    else if (v === '--dry') a.dry = true;
    else if (v === '--season') a.season = +argv[++i];
    else if (v === '--now') a.now = Date.parse(argv[++i]);
    else if (v === '--lookahead') a.lookahead = +argv[++i];
    else if (v === '--quiet') a.quiet = true;
  }
  return a;
}
const round = (x, d) => x == null || !isFinite(x) ? null : Math.round(x * Math.pow(10, d || 1)) / Math.pow(10, d || 1);

function qbCompact(q, refresh) {
  return {
    player_id: q.player_id, player_name: q.player_name, status: q.status, status_basis: q.status_basis,
    status_fresh: q.status_fresh, status_confirmed: q.status_confirmed,
    starter_probability: q.starter_probability, probability_basis: q.probability_basis,
    confirmation_level: q.confirmation_level, contested: q.contested,
    conflict: q.conflict, conflict_resolved: q.conflict_resolved, resolution: q.resolution, resolution_text: q.resolution_text,
    agreement: q.agreement, sources_n: q.sources.length,
    sources: q.sources.slice(0, 4).map((s) => ({ kind: s.kind, tier: s.tier, player_name: s.player_name, fresh: s.fresh, agrees: s.agrees,
      observed_at: s.observed_at, detail: s.detail ? String(s.detail).slice(0, 90) : null })),
    conflicting_sources: q.conflicting_sources.map((s) => ({ player_name: s.player_name, kind: s.kind, tier: s.tier, observed_at: s.observed_at })),
    backup: q.backup ? { player_id: q.backup.player_id, player_name: q.backup.player_name, status: q.backup.status, basis: q.backup.basis } : null,
    handed_from: q.handed_from, last_known: q.last_known ? { player_name: q.last_known.player_name, observed_at: q.last_known.observed_at, why: q.last_known.why } : null,
    reasoning_codes: q.reasoning_codes, last_updated: q.last_updated, refresh
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const log = (...x) => { if (!a.quiet) console.error(...x); };
  const now = a.now || Date.now();
  const nowIso = new Date(now).toISOString();
  const ctx = await CTX.load({ now, season: a.season, offline: a.offline, lookahead: a.lookahead });
  if (!ctx.ok) { console.error('[enrichment] ' + ctx.why + ' — nothing written rather than an empty evidence file'); return 2; }
  const cache = K.open(path.join(HERE, 'cache', 'evidence_cache.json'));
  const live = !a.offline;
  const ledger = new Ledger({ live });

  /* ---------------------------------------------------------- RAW SOURCES */
  const fixtures = [];
  ctx.slate.forEach((g) => ['home', 'away'].forEach((s) => fixtures.push({ game_id: g.game_id, side: s, key: g[s].key, name: g[s].name })));
  const av = await PA.collect({ now, ledger, cache, live, fixtures, espnToKey: ctx.espnToKey, teamKeyByName: ctx.teamKeyByName, resolveName: ctx.resolveName });
  const qb = await PQ.collect({ now, ledger, cache, live, season: ctx.season, teamKeyByName: ctx.teamKeyByName, resolveName: ctx.resolveName });
  const mk = await PM.collect({ now, ledger, cache, live, slate: ctx.slate, season: ctx.season });
  const fcsArt = readJson(path.join(HERE, 'fcs_ratings.json'), null);
  const personnel = readJson(path.join(ROOT, 'football', 'personnel', 'current.json'), null);

  const healthAvail = ledger.summary(PA.PROVIDERS, nowIso);
  const healthQb = ledger.summary(PQ.PROVIDERS, nowIso);
  const healthMk = ledger.summary(PM.PROVIDERS, nowIso);
  const healthFcs = (fcsArt && fcsArt.provider_health) || {};
  if (fcsArt) {
    const age = (now - Date.parse(fcsArt.generated_at)) / 3600e3;
    healthFcs.fcs_bridge_build = { provider: 'fcs_bridge_build', label: 'FCS rating bridge build', kind: 'fcs_ratings',
      state: age > C.CACHE.fcs_ratings.ttl ? 'STALE' : 'HEALTHY', reason: 'built ' + Math.round(age) + 'h ago' + (age > C.CACHE.fcs_ratings.ttl ? ', past its ' + C.CACHE.fcs_ratings.ttl + 'h window' : ''),
      certainty: age > C.CACHE.fcs_ratings.ttl ? 0.5 : 1, checked_at: nowIso };
  }
  /* PROVIDER HEALTH IS EVIDENCE TOO. A live run records each provider's
     verdict in the evidence cache; a run that did not check one carries the
     last verdict actually observed, with when it was observed, rather than
     calling an unasked provider DOWN or HEALTHY */
  [healthAvail, healthQb, healthMk].forEach((H) => Object.keys(H).forEach((k) => {
    const h = H[k], key = 'health:' + k;
    if (h.state === 'NOT_CHECKED') {
      const back = K.recall(cache, key, now);
      if (back.found && back.value) H[k] = Object.assign({}, back.value, { carried: true, checked_at: back.retrieved_at,
        reason: back.value.reason + ' [carried from the check at ' + back.retrieved_at + (back.stale ? ', STALE' : '') + '; not checked this run]' });
    } else if (h.state !== 'NOT_CONFIGURED') {
      K.put(cache, key, 'provider_health', { value: { provider: h.provider, label: h.label, kind: h.kind, source_type: h.source_type, role: h.role,
        state: h.state, reason: h.reason, attributable_to: h.attributable_to, certainty: h.certainty, by_outcome: h.by_outcome }, source: 'enrichment run',
        observed_at: now, retrieved_at: now }, now);
    }
  }));
  const shortHealth = (H) => { const o = {}; Object.keys(H).forEach((k) => { o[k] = H[k].state; }); return o; };

  /* ----------------------------------------- per game: the evidence package */
  const persistence = qb.persistence;
  const games = {}, full = { players: {}, qb: {}, impact: {}, evidence: {} };
  const personnelFor = (gid, key) => {
    const pg = personnel && personnel.games ? personnel.games[String(gid)] : null;
    if (!pg) return null;
    return [pg.home, pg.away].find((t) => t && String(t.team_id) === String(key)) || null;
  };
  for (const g of ctx.slate) {
    const hrs = SCH.hoursToKick(g.kickoff, now);
    const w = SCH.windowFor(hrs);
    const pkg = { schema: GE.SCHEMA, game_id: g.game_id, kickoff: g.kickoff, built_at: nowIso,
      window: { key: w.key, priority: w.priority, label: w.label, hours_to_kickoff: round(hrs, 1) }, frozen: false,
      teams: { home: g.home.name, away: g.away.name },
      team_data: {}, quarterback: {}, availability: {}, impact: {}, player_quality: {}, market: null,
      /* provider health is the same for every game in a run: it is published
         ONCE (artifact.source_health) and lib/game_evidence.js forGame()
         attaches it to each package */
      conflicts: [], missing: [], stale: [], refresh: {} };
    ['injuries', 'qb_status', 'market', 'weather'].forEach((kind) => {
      const last = kind === 'market' ? (K.recall(cache, 'market:' + g.game_id, now).retrieved_at || null) : null;
      const d = SCH.due(kind, { now, kickoff: g.kickoff, last_retrieved_at: last });
      pkg.refresh[kind] = { due: d.due, next_due_at: d.next_due_at };
    });
    const pqTeams = {};
    for (const side of ['home', 'away']) {
      const t = g[side];
      const policy = POL.forGame({ home_conference: g.home.conference, away_conference: g.away.conference, is_conference_game: g.is_conference_game, kickoff: g.kickoff }, side, now);
      const proj = ctx.projected[t.key] || null;
      const provs = {}; PA.PROVIDERS.forEach((p) => { provs[p.name] = healthAvail[p.name]; });
      const agg = AG.aggregate({ fixture: { game_id: g.game_id, kickoff: g.kickoff, side, team_key: t.key, team_name: t.name, is_fbs: t.is_fbs },
        policy, evidence: av.evidence[t.key] || [], official: av.official[g.game_id + '|' + t.key] || null,
        starters: proj ? proj.starters : [], contributors: proj ? proj.contributors : [], providers: provs, now });
      const byId = {}; agg.players.forEach((p) => { if (p.player_id) byId[p.player_id] = p; });
      const S = agg.summary;
      pkg.availability[side] = {
        coverage_class: S.coverage_class, coverage_score: S.coverage_score, coverage_reason: S.coverage_reason,
        state: GE.CLASS_TO_STATE[S.coverage_class], official: S.official, policy: S.policy, as_of: S.as_of,
        stale: S.stale, provider_failure: S.provider_failure, listed: S.listed, players_listed: S.players_listed, refused: S.refused,
        providers: S.providers.filter((p) => p.relevant).map((p) => [p.provider, p.verdict]),
        starters: { total: S.starters.total, known: S.starters.known, unknown: S.starters.unknown, known_pct: S.starters.known_pct,
          unknown_top: S.starters.unknown_list.slice(0, 3).map((p) => ({ name: p.name, pos: p.pos, slot: p.slot })),
          out_top: S.starters.out_list.slice(0, 5), doubt_top: S.starters.doubt_list.slice(0, 5) },
        key_contributors: { total: S.key_contributors.total, known: S.key_contributors.known, known_pct: S.key_contributors.known_pct }
      };
      /* the quarterback */
      const qg = ctx.playerFiles[t.key] && ctx.playerFiles[t.key].units && ctx.playerFiles[t.key].units.groups && ctx.playerFiles[t.key].units.groups.QB;
      const q = RES.resolve({ team_key: t.key, team_name: t.name, game_id: g.game_id, kickoff: g.kickoff, now,
        record: qb.records[t.key] || null, operator: qb.operator[t.key] || [], availability: { byId, summary: S },
        quality: qg ? qg.projected : [], persistence, qbc: QBC });
      const qa = q.player_id ? byId[q.player_id] : null;
      q.status_fresh = qa ? qa.freshness === 'FRESH' : (S.comprehensive ? true : null);
      /* a fresh comprehensive official report for this game clears a starter
         it does not list */
      if (q.player_id && !qa && S.comprehensive) { q.status = 'AVAILABLE'; q.status_basis = 'COMPREHENSIVE_SILENCE: the official report for this game does not list him'; q.status_confirmed = true; q.status_fresh = true; }
      const qd = SCH.due('qb_status', { now, kickoff: g.kickoff, last_retrieved_at: q.last_updated });
      pkg.quarterback[side] = qbCompact(q, { window: qd.window, next_due_at: qd.next_due_at });
      full.qb[g.game_id + '|' + side] = q;
      /* impact of the non-QB absences */
      const roles = {};
      (proj ? proj.contributors : []).forEach((p) => { roles[p.player_id] = p; });
      const onFile = {};
      ((ctx.playerFiles[t.key] || {}).players || []).forEach((p) => { if (p && p.id) onFile[String(p.id)] = true; });
      const im = IMP.assessTeam({ players: agg.players, roster_roles: roles, personnel: personnelFor(g.game_id, t.key), on_file: onFile });
      pkg.impact[side] = Object.assign({}, im.summary, { top: im.summary.top });
      full.impact[g.game_id + '|' + side] = im.absences;
      /* player-quality coverage */
      const cov = STARTERS.coverage(proj);
      pqTeams[side] = cov;
      pkg.player_quality[side] = cov.available ? { offense_pct: cov.offense.pct, defense_pct: cov.defense.pct, special_pct: cov.special.pct,
        starters_pct: cov.starters.pct, key_pct: cov.key_contributors.pct, starters: cov.starters.total, rated: cov.starters.rated,
        unrated_starters_top: cov.starters.unrated.slice(0, 3).map((u) => u.slot + ' ' + u.name) } : { available: false, why: cov.why };
      /* team data: the FCS bridge for a side the engine prices from the floor */
      const fcs = !t.is_fbs && fcsArt && fcsArt.teams ? fcsArt.teams[t.key] || null : null;
      pkg.team_data[side] = { key: t.key, name: t.name, is_fbs: t.is_fbs,
        fcs: !t.is_fbs ? (fcs ? { team_rating: fcs.fcs_team_rating, rating_sd: fcs.rating_sd, confidence: fcs.fcs_rating_confidence,
          games_sample: fcs.fcs_games_sample, bridge_sample: fcs.fcs_fbs_bridge_sample, completeness: fcs.data_completeness,
          floor: fcsArt.floor, floor_gap: fcs.floor_gap, source: fcs.fcs_rating_source, last_updated: fcs.last_updated,
          status: fcsArt.status } : { team_rating: null, confidence: 'NONE', floor: fcsArt ? fcsArt.floor : -28,
          why: fcsArt ? 'the bridge has no result for this programme' : 'the FCS bridge has not been built' }) : null };
      /* the lists */
      if (q.conflict) pkg.conflicts.push({ kind: 'QB', side, resolved: !!q.conflict_resolved, detail: q.resolution_text });
      agg.players.filter((p) => p.conflict).forEach((p) => pkg.conflicts.push({ kind: 'AVAILABILITY', side, resolved: false,
        detail: p.player_name + ': ' + p.conflicts.map((c) => c.status + ' (' + c.source + ')').join(' vs ') }));
      if (S.coverage_class === 'PROVIDER_FAILED' || S.coverage_class === 'NO_SOURCE') pkg.missing.push('availability:' + side);
      if (q.confirmation_level === 'UNKNOWN') pkg.missing.push('qb_identity:' + side);
      if (q.player_id && (!q.status || q.status === 'UNKNOWN')) pkg.missing.push('qb_status:' + side);
      if (!t.is_fbs && (!fcs || fcs.fcs_rating_confidence !== 'STRONG')) pkg.missing.push('fcs_rating:' + side);
      if (S.stale) pkg.stale.push('availability:' + side);
      if (q.reasoning_codes.indexOf('STALE_EVIDENCE_ONLY') >= 0) pkg.stale.push('qb_evidence:' + side);
      full.players[g.game_id + '|' + side] = agg.players;
      full.evidence[t.key] = av.evidence[t.key] || [];
    }
    const both = ['home', 'away'].map((s) => pqTeams[s]).filter((c) => c && c.available);
    const sum = (f) => both.reduce((x, c) => ({ r: x.r + f(c).rated, t: x.t + f(c).total }), { r: 0, t: 0 });
    const p1 = (o) => o.t ? Math.round(1000 * o.r / o.t) / 10 : null;
    pkg.player_quality.game = both.length ? { offense_pct: p1(sum((c) => c.offense)), defense_pct: p1(sum((c) => c.defense)),
      starters_pct: p1(sum((c) => c.starters)), key_pct: p1(sum((c) => c.key_contributors)), teams_measured: both.length } : null;
    /* the market, as comparison evidence */
    pkg.market = mk.byGame[g.game_id] ? GE.marketCompact(mk.byGame[g.game_id]) : null;
    if (!pkg.market) pkg.missing.push('market');
    else if (pkg.market.stale) pkg.stale.push('market');
    games[g.game_id] = pkg;
  }

  /* ------------------------------------------------ the frozen pregame ledger */
  const OUT = path.join(HERE, 'current.json');
  const prev = readJson(OUT, null);
  const frozen = {};
  if (prev && prev.games) {
    Object.keys(prev.games).concat(Object.keys(prev.frozen || {})).forEach((gid) => {
      const p = (prev.games && prev.games[gid]) || (prev.frozen && prev.frozen[gid]);
      if (!p || games[gid]) return;
      const k = Date.parse(p.kickoff);
      if (!isFinite(k) || k > now || now - k > 7 * 86400e3) return;
      frozen[gid] = Object.assign({}, p, { frozen: true, frozen_reason: 'kicked off ' + new Date(k).toISOString()
        + ': this is the evidence exactly as last published before kickoff, never recomputed' });
    });
  }

  /* -------------------------------------------------------------- summary */
  const pk = Object.values(games);
  const sides = [];
  pk.forEach((p) => ['home', 'away'].forEach((s) => sides.push({ p, s })));
  const tally = (f) => { const o = {}; sides.forEach(({ p, s }) => { const k = f(p, s); if (k != null) o[k] = (o[k] || 0) + 1; }); return o; };
  const fbsSides = sides.filter(({ p, s }) => p.team_data[s].is_fbs);
  const covered = new Set(), fresh = new Set(), staleT = new Set(), unav = new Set(), fbsTeams = new Set();
  fbsSides.forEach(({ p, s }) => {
    const a = p.availability[s], key = p.team_data[s].key;
    fbsTeams.add(key);
    if (['COMPREHENSIVE_OFFICIAL', 'OFFICIAL_THIS_GAME', 'OFFICIAL_ABSENCE_ONLY', 'MULTI_SOURCE_CURRENT', 'STRUCTURED_CURRENT'].indexOf(a.coverage_class) >= 0) { covered.add(key); fresh.add(key); }
    else if (a.coverage_class === 'STALE_CARRIED') { covered.add(key); staleT.add(key); }
    else if (a.coverage_class === 'PROVIDER_FAILED' || a.coverage_class === 'NO_SOURCE') unav.add(key);
  });
  let sKnown = 0, sTot = 0, sRated = 0, sRtot = 0, kRated = 0, kTot = 0;
  fbsSides.forEach(({ p, s }) => {
    const a = p.availability[s]; sKnown += a.starters.known; sTot += a.starters.total;
    const q = p.player_quality[s]; if (q && q.starters) { sRated += q.rated; sRtot += q.starters; }
  });
  Object.values(pqTeamsAll(pk)).forEach((c) => { kRated += c.r; kTot += c.t; });
  const mkGames = pk.filter((p) => p.market);
  const booksAvg = mkGames.length ? round(mkGames.reduce((s, p) => s + p.market.books_reporting, 0) / mkGames.length, 2) : null;
  const allHealth = Object.assign({}, healthAvail, healthQb, healthMk, healthFcs);
  const summary = {
    games: pk.length, frozen_games: Object.keys(frozen).length,
    qb: { by_confirmation: tally((p, s) => p.quarterback[s].confirmation_level),
      conflicts_detected: sides.filter(({ p, s }) => p.quarterback[s].conflict).length,
      conflicts_resolved: sides.filter(({ p, s }) => p.quarterback[s].conflict && p.quarterback[s].conflict_resolved).length,
      conflicts_open: sides.filter(({ p, s }) => p.quarterback[s].conflict && !p.quarterback[s].conflict_resolved).length,
      status_known: sides.filter(({ p, s }) => p.quarterback[s].status && p.quarterback[s].status !== 'UNKNOWN').length,
      sides: sides.length },
    availability: { by_class: tally((p, s) => p.availability[s].coverage_class),
      fbs_teams_on_slate: fbsTeams.size, teams_covered: covered.size, fresh: fresh.size, stale: staleT.size, unavailable: unav.size,
      starters_known_pct: sTot ? round(100 * sKnown / sTot, 1) : null, starters_known: sKnown, starters_total: sTot,
      historical_rows_refused: sides.reduce((x, { p, s }) => x + ((p.availability[s].refused || {}).HISTORICAL || 0), 0) },
    player_quality: { projected_starters_rated_pct: sRtot ? round(100 * sRated / sRtot, 1) : null, starters_rated: sRated, starters_total: sRtot,
      key_contributors_rated_pct: kTot ? round(100 * kRated / kTot, 1) : null,
      unrated_meaningful_absences: sides.reduce((x, { p, s }) => x + ((p.impact[s] || {}).unknown_impact || 0), 0),
      unrated_critical_or_major_absences: sides.reduce((x, { p, s }) => x + ((p.impact[s] || {}).unknown_impact_important || 0), 0) },
    fcs: { rated_teams: fcsArt ? Object.keys(fcsArt.teams || {}).length : 0,
      by_confidence: fcsArt ? fcsArt.counts.by_confidence : {}, bridge_validation: fcsArt ? fcsArt.validation.verdict : null,
      bridge: fcsArt ? { base_season: fcsArt.bridge.base_season, this_season: fcsArt.bridge.this_season, fcs_level: fcsArt.bridge.fcs_level } : null,
      fcs_sides_on_slate: sides.filter(({ p, s }) => !p.team_data[s].is_fbs).length,
      fcs_sides_strong: sides.filter(({ p, s }) => !p.team_data[s].is_fbs && p.team_data[s].fcs && p.team_data[s].fcs.confidence === 'STRONG').length },
    market: { games_with_market: mkGames.length, average_books_per_game: booksAvg,
      one_book_games: mkGames.filter((p) => p.market.books_reporting === 1).length,
      three_plus_book_games: mkGames.filter((p) => p.market.books_reporting >= 3).length,
      under_two_sources: pk.length - mkGames.filter((p) => p.market.books_reporting >= 2).length,
      stale_markets: mkGames.filter((p) => p.market.stale).length, no_market: pk.length - mkGames.length },
    providers: Object.keys(allHealth).sort().map((k) => ({ provider: k, label: allHealth[k].label || k, kind: allHealth[k].kind || null,
      state: allHealth[k].state, reason: allHealth[k].reason, attributable_to: allHealth[k].attributable_to || null })),
    provider_failures: Object.keys(allHealth).filter((k) => ['AUTH_FAILURE', 'DOWN', 'RATE_LIMITED'].indexOf(allHealth[k].state) >= 0).length,
    stale_evidence_records: K.stats(cache, now).stale,
    conflicts: pk.reduce((x, p) => x + p.conflicts.length, 0)
  };
  function pqTeamsAll(list) {
    const o = {};
    list.forEach((p) => ['home', 'away'].forEach((s) => {
      const key = p.team_data[s].key, proj = ctx.projected[key];
      if (!proj || o[key]) return;
      const c = STARTERS.coverage(proj);
      if (c.available) o[key] = { r: c.key_contributors.rated, t: c.key_contributors.total };
    }));
    return o;
  }

  const artifact = {
    schema: GE.ARTIFACT_SCHEMA, version: C.version, season: ctx.season, generated_at: nowIso,
    run: { live, environment: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
      note: live ? 'live provider checks were attempted; a refusal by this run’s own network policy is recorded as EGRESS_BLOCKED and attributed to the run, not the provider'
        : '--offline: no provider was called; evidence comes from the committed artifacts and the evidence cache' },
    basis: 'The evidence each reliability score is calculated from, interpreted once: availability, quarterback, player impact and '
      + 'quality coverage, FCS bridge, market consensus, provider health. It moves no projection.',
    providers: allHealth,
    source_health: { availability: shortHealth(healthAvail), qb: shortHealth(healthQb), market: shortHealth(healthMk), fcs: shortHealth(healthFcs) },
    schedule: SCH.describe(),
    summary,
    games,
    frozen
  };
  if (!a.dry) {
    /* compact, like every artifact the board fetches (personnel, slate) */
    fs.writeFileSync(OUT, JSON.stringify(artifact) + '\n');
    fs.writeFileSync(path.join(HERE, 'current.full.json'), JSON.stringify({ schema: 'edgedesk_enrichment_full_v1', generated_at: nowIso,
      why: 'every normalized evidence record behind football/enrichment/current.json: injury_evidence by team, player_availability and '
        + 'impact by fixture side, and the full QB resolution with every source', injury_evidence: full.evidence,
      player_availability: full.players, absences: full.impact, quarterback: full.qb, providers: allHealth }) + '\n');
    K.prune(cache, now, 120);
    K.save(cache, now);
  }
  log('[enrichment] ' + pk.length + ' games, ' + Object.keys(frozen).length + ' frozen; QB ' + JSON.stringify(summary.qb.by_confirmation)
    + '; availability ' + JSON.stringify(summary.availability.by_class));
  log('[enrichment] providers: ' + summary.providers.map((p) => p.provider + ' ' + p.state).join(', '));
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('[enrichment] ' + (e && e.stack || e)); process.exit(2); });
module.exports = { main };
