#!/usr/bin/env node
'use strict';
/* ===========================================================================
   NCAAM forecast dataset: hoopR men's schedules + team box scores in, one
   committed, hashed, quality-flagged game table per season out.

     node basketball/ncaam_forecast/ingest.js [--season 2010-2027|current|all] [--offline]

   Source: sportsdataverse hoopR-mbb-data (MIT; compiled from ESPN's public
   feeds — ESPN's terms govern the underlying data; basketball/config.js
   LICENSE). Read through the guarded downloader (engine/lab/fetch.js: cache,
   ETag revalidation, bounded retries) and the pyarrow column reader
   (hockey/lib/io.js). Nothing here calls an odds source.

   Output basketball/ncaam_forecast/data/games_<season>.csv.gz (schema
   edgedesk_ncaam_fc_games_v1), one row per game id, ALL rows kept:
     identity    game_id, season, season_type, start_utc, day (UTC - 10 h)
     status      FINAL | SCHEDULED | POSTPONED | CANCELED | FORFEIT | DELAYED | SUSPENDED | IN_PROGRESS | OTHER
     context     neutral, conf_game, event, tournament_id, headline,
                 ncaa_round (structural: FF R64 R32 S16 E8 F4 NC), ncaa_region,
                 venue_city, venue_state
     teams       home_id, away_id (ESPN ids), home_conf, away_conf (season-
                 specific conference ids), home_d1, away_d1 (quality.js rule),
                 home_seed, away_seed (NCAA tournament only, verified)
     result      hs, as, periods, n_ot
     box         h_/a_ fgm fga tpm tpa ftm fta orb drb tov pf
     quality     score_ok, box_ok, quarantine (reasons, '|'-separated)
     timing      assumed_available_at (start + 4 h; never a certified known_at),
                 pit = RETRO (retrieved after the fact from a revisable source)
   plus manifest.json (sources with sha256 and fetch time, counts, every
   exclusion by reason), teams.json (labels) and quarantine.json.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('./config');
const Q = require('./quality');
const { toCsv, readCsv } = require('../../engine/csv');

const COLS = ['game_id', 'season', 'season_type', 'status', 'start_utc', 'day', 'neutral', 'conf_game', 'event', 'tournament_id', 'headline', 'ncaa_round', 'ncaa_region',
  'home_id', 'away_id', 'home_conf', 'away_conf', 'home_d1', 'away_d1', 'home_seed', 'away_seed', 'hs', 'as', 'periods', 'n_ot', 'venue_city', 'venue_state']
  .concat(Q.BOX.map((k) => 'h_' + k), Q.BOX.map((k) => 'a_' + k), ['score_ok', 'box_ok', 'quarantine', 'assumed_available_at', 'pit']);
const SCHEMA = 'edgedesk_ncaam_fc_games_v1';

const SCHED_COLS = ['game_id', 'season', 'season_type', 'date', 'status_type_name', 'status_type_completed', 'status_period', 'neutral_site', 'conference_competition',
  'notes_headline', 'tournament_id', 'type_abbreviation', 'venue_address_city', 'venue_address_state', 'groups_id', 'groups_name', 'groups_is_conference',
  'home_id', 'home_display_name', 'home_abbreviation', 'home_conference_id', 'home_score', 'home_current_rank',
  'away_id', 'away_display_name', 'away_abbreviation', 'away_conference_id', 'away_score', 'away_current_rank'];
const BOX_COLS = ['game_id', 'team_id', 'opponent_team_id', 'team_score', 'field_goals_made', 'field_goals_attempted', 'three_point_field_goals_made', 'three_point_field_goals_attempted',
  'free_throws_made', 'free_throws_attempted', 'offensive_rebounds', 'defensive_rebounds', 'total_turnovers', 'fouls'];

const isoS = (t) => new Date(t).toISOString().replace(/\.000Z$/, 'Z');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'True';
const str = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const id = (v) => { const n = num(v); return n == null ? null : String(Math.round(n)); };
function parseStart(s) {
  if (!s) return NaN;
  const t = String(s).replace(/Z$/, ':00Z').replace(/:(\d\d):00Z$/, ':$1Z');
  const ms = Date.parse(/T\d\d:\d\d(:\d\d)?Z$/.test(t) ? t : s);
  return Number.isFinite(ms) ? ms : Date.parse(s);
}

/** raw schedule + box rows of one season -> dataset rows, stats, labels. Pure. */
function normalise(season, schedRows, boxRows) {
  const stats = { rows: schedRows.length, final: 0, scheduled: 0, not_played: {}, duplicate_ids: 0, duplicate_suspects: 0, score_ok: 0, box_ok: 0, quarantined: {}, box_rows: boxRows ? boxRows.length : 0 };
  const byId = new Map(); const names = {}; const confNames = {};
  for (const r of schedRows) {
    const gid = id(r.game_id); if (!gid) { stats.quarantined.NO_GAME_ID = (stats.quarantined.NO_GAME_ID || 0) + 1; continue; }
    if (byId.has(gid)) stats.duplicate_ids++;
    const start = parseStart(r.date);
    const status = Q.statusOf(r.status_type_name, r.status_type_completed === false || r.status_type_completed === 'false' ? false : bool(r.status_type_completed));
    const g = {
      game_id: gid, season, season_type: num(r.season_type), status, start_utc: Number.isFinite(start) ? isoS(start) : '', day: Number.isFinite(start) ? isoS(start - 10 * 3600e3).slice(0, 10) : '',
      neutral: bool(r.neutral_site) ? 1 : 0, conf_game: bool(r.conference_competition) ? 1 : 0, event: Q.classifyEvent(r), tournament_id: num(r.tournament_id), headline: str(r.notes_headline),
      home_id: id(r.home_id), away_id: id(r.away_id), home_conf: id(r.home_conference_id), away_conf: id(r.away_conference_id),
      hs: status === 'FINAL' ? num(r.home_score) : null, as: status === 'FINAL' ? num(r.away_score) : null, periods: status === 'FINAL' ? num(r.status_period) : null,
      home_rank: num(r.home_current_rank), away_rank: num(r.away_current_rank), venue_city: str(r.venue_address_city), venue_state: str(r.venue_address_state),
    };
    g.n_ot = g.periods != null && g.periods >= C.RULES.halves ? g.periods - C.RULES.halves : null;
    byId.set(gid, g);
    if (g.home_id) names[g.home_id] = { name: str(r.home_display_name), abbrev: str(r.home_abbreviation) };
    if (g.away_id) names[g.away_id] = { name: str(r.away_display_name), abbrev: str(r.away_abbreviation) };
    if (bool(r.groups_is_conference) && id(r.groups_id) && str(r.groups_name)) confNames[id(r.groups_id)] = str(r.groups_name);
  }
  const games = [...byId.values()].sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  /* membership, from this season's own conference ids */
  const mem = Q.membership(games.map((g) => Object.assign({ season }, g))).get(season) || new Map();
  /* box lines by game */
  const box = new Map();
  for (const b of boxRows || []) {
    const gid = id(b.game_id); if (!gid) continue;
    const l = { team_id: id(b.team_id), opp_id: id(b.opponent_team_id), pts: num(b.team_score), fgm: num(b.field_goals_made), fga: num(b.field_goals_attempted), tpm: num(b.three_point_field_goals_made),
      tpa: num(b.three_point_field_goals_attempted), ftm: num(b.free_throws_made), fta: num(b.free_throws_attempted), orb: num(b.offensive_rebounds), drb: num(b.defensive_rebounds), tov: num(b.total_turnovers), pf: num(b.fouls) };
    if (!box.has(gid)) box.set(gid, []);
    const arr = box.get(gid); const k = arr.findIndex((x) => x.team_id === l.team_id);
    if (k >= 0) arr[k] = l; else arr.push(l);
  }
  const dups = Q.duplicateSuspects(games);
  for (const g of games) {
    const reasons = [];
    const m1 = mem.get(g.home_id); const m2 = mem.get(g.away_id);
    g.home_d1 = m1 && m1.d1 ? 1 : 0; g.away_d1 = m2 && m2.d1 ? 1 : 0;
    if (g.status === 'FINAL') stats.final++; else if (g.status === 'SCHEDULED') stats.scheduled++; else stats.not_played[g.status] = (stats.not_played[g.status] || 0) + 1;
    if (g.status === 'FINAL' || g.status === 'SCHEDULED') reasons.push(...Q.scoreCheck(g));
    if (!g.start_utc) reasons.push('START_TIME_MISSING');
    const d = dups.get(g.game_id);
    if (d) { reasons.push('DUPLICATE_SUSPECT_OF_' + d.of); stats.duplicate_suspects++; }
    g.score_ok = g.status === 'FINAL' && !reasons.length ? 1 : 0;
    let bc = null;
    if (g.score_ok) { bc = Q.boxCheck(g, box.get(g.game_id)); if (!bc.ok) reasons.push(bc.reason); }
    g.box_ok = g.score_ok && bc && bc.ok ? 1 : 0;
    for (const k of Q.BOX) { g['h_' + k] = bc && bc.h ? bc.h[k] : (box.get(g.game_id) || []).filter((l) => l.team_id === g.home_id).map((l) => l[k])[0]; g['a_' + k] = bc && bc.a ? bc.a[k] : (box.get(g.game_id) || []).filter((l) => l.team_id === g.away_id).map((l) => l[k])[0]; }
    g.quarantine = reasons.join('|');
    for (const r of reasons) { const k = r.replace(/_OF_\d+$/, '').replace(/:.*$/, ''); stats.quarantined[k] = (stats.quarantined[k] || 0) + 1; }
    if (g.score_ok) stats.score_ok++; if (g.box_ok) stats.box_ok++;
    g.assumed_available_at = g.status === 'FINAL' && g.start_utc ? isoS(Date.parse(g.start_utc) + C.AVAILABLE_AFTER_MS) : '';
    g.pit = 'RETRO';
  }
  /* the NCAA tournament: structural rounds, regions, verified seeds */
  const nr = Q.ncaaRounds(games);
  const seeds = Q.ncaaSeeds(games, nr.rounds);
  for (const g of games) {
    g.ncaa_round = nr.rounds.get(g.game_id) || '';
    g.ncaa_region = g.ncaa_round && g.ncaa_round !== 'F4' && g.ncaa_round !== 'NC' ? Q.ncaaRegion(g.headline) || '' : '';
    g.home_seed = g.ncaa_round && seeds.ok ? seeds.seeds.get(g.home_id) : '';
    g.away_seed = g.ncaa_round && seeds.ok ? seeds.seeds.get(g.away_id) : '';
  }
  stats.ncaa = { games: nr.games, structural_issues: nr.issues, seeds_verified: seeds.ok, seeds_note: seeds.ok ? seeds.verified_by : seeds.reason };
  const quarantine = games.filter((g) => g.quarantine).map((g) => ({ game_id: g.game_id, season, day: g.day, status: g.status, home_id: g.home_id, away_id: g.away_id, reasons: g.quarantine.split('|') }));
  return { games, stats, names, confNames, quarantine };
}

/** the incumbent dataset (basketball/data/ncaam) agrees on every shared final? */
function reconcile(season, games) {
  const f = path.join(C.ROOT, 'basketball', 'data', 'ncaam', season + '.csv');
  if (!fs.existsSync(f)) return { checked: 0, mismatched: 0, only_incumbent: 0, note: 'no incumbent file' };
  const mine = new Map(games.filter((g) => g.status === 'FINAL').map((g) => [g.game_id, g]));
  let checked = 0, mismatched = 0, only = 0; const examples = [];
  for (const r of readCsv(f).rows) {
    if (r.status !== 'FINAL') continue;
    const g = mine.get(r.game_id);
    if (!g) { only++; continue; }
    checked++;
    if (Number(r.hs) !== g.hs || Number(r.as) !== g.as || r.home_id !== g.home_id) { mismatched++; if (examples.length < 5) examples.push(r.game_id); }
  }
  return { checked, mismatched, only_incumbent: only, examples };
}

function serialise(games) {
  return zlib.gzipSync(Buffer.from(toCsv(COLS, games.map((g) => { const o = {}; for (const k of COLS) o[k] = g[k] == null ? '' : g[k]; return o; }))), { level: 9 });
}

async function readSeason(season, o) {
  const { fetchFile } = require('../../engine/lab/fetch');
  const io = require('../../hockey/lib/io');
  const ttl = season >= C.currentSeason() - 1 ? 6 * 3600e3 : 30 * 86400e3;
  const s = await fetchFile(C.SOURCES.schedule(season), { offline: o.offline, ttlMs: ttl });
  if (!s.ok) return { season, error: s.not_found ? 'schedule not published' : JSON.stringify(s.error || s.status) };
  const sched = []; let missing = [];
  for await (const r of io.parquetRows(s.file, SCHED_COLS, (m) => { missing = m; })) sched.push(r);
  const b = await fetchFile(C.SOURCES.team_box(season), { offline: o.offline, ttlMs: ttl });
  const box = [];
  if (b.ok) for await (const r of io.parquetRows(b.file, BOX_COLS)) box.push(r);
  return { season, sched, box, missing, sources: { schedule: { url: s.url, sha256: s.sha256, bytes: s.bytes, fetched_at: s.fetched_at }, team_box: b.ok ? { url: b.url, sha256: b.sha256, bytes: b.bytes, fetched_at: b.fetched_at } : { url: C.SOURCES.team_box(season), unavailable: b.not_found ? 'not published by the source yet' : String(b.error || b.status) } } };
}

async function ingest(seasonsList, o) {
  o = o || {};
  fs.mkdirSync(C.PATHS.data, { recursive: true });
  const man = fs.existsSync(C.PATHS.manifest) ? JSON.parse(fs.readFileSync(C.PATHS.manifest, 'utf8')) : { seasons: {} };
  const teams = fs.existsSync(C.PATHS.teams) ? JSON.parse(fs.readFileSync(C.PATHS.teams, 'utf8')) : { teams: {}, conferences: {} };
  const quar = fs.existsSync(C.PATHS.quarantine) ? JSON.parse(fs.readFileSync(C.PATHS.quarantine, 'utf8')) : { seasons: {} };
  const results = [];
  for (const season of seasonsList) {
    const raw = await readSeason(season, o);
    if (raw.error) { results.push(raw); console.error('[ncaam ingest] ' + season + ': ' + raw.error); if (!/not published/.test(raw.error)) process.exitCode = 1; continue; }
    const n = normalise(season, raw.sched, raw.box);
    const rec = reconcile(season, n.games);
    const buf = serialise(n.games);
    const file = C.PATHS.season(season);
    const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!old || !old.equals(buf)) fs.writeFileSync(file, buf);
    man.seasons[season] = { file: path.relative(C.ROOT, file).split(path.sep).join('/'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), stats: n.stats, reconciliation_with_incumbent: rec, missing_source_columns: raw.missing, sources: raw.sources };
    Object.assign(teams.conferences, n.confNames);
    for (const [k, v] of Object.entries(n.names)) teams.teams[k] = v;
    quar.seasons[season] = n.quarantine;
    results.push({ season, stats: n.stats, rec, changed: !old || !old.equals(buf) });
    console.log('[ncaam ingest] ' + season + ': ' + n.stats.final + ' final (' + n.stats.score_ok + ' score_ok, ' + n.stats.box_ok + ' box_ok), ' + n.stats.scheduled + ' scheduled, quarantined ' + JSON.stringify(n.stats.quarantined) + ', NCAA ' + n.stats.ncaa.games + ' games seeds ' + (n.stats.ncaa.seeds_verified ? 'verified' : 'none') + ', incumbent mismatches ' + rec.mismatched + '/' + rec.checked);
  }
  Object.assign(man, { schema: SCHEMA, columns: COLS, scope: C.RULES.competition, license: C.SOURCES.license,
    temporal: { known_at: 'not recorded by any source (never backdated)', assumed_available_at: 'start + 4 h for a FINAL', pit: 'RETRO: retrieved after the fact; ESPN can revise box scores' },
    membership_rule: 'D1 in season S = the team\'s games list a conference for it (season-specific ESPN conference id); validated against the NCAA D1 reference 2024-2026 (0 missed; extras are reclassifying programmes)',
    seeds_rule: 'tournament-game rank accepted as seed only when every first-round pair sums to 17 and each team keeps one seed' });
  const sortObj = (o2) => Object.fromEntries(Object.keys(o2).sort((a, b) => Number(a) - Number(b)).map((k) => [k, o2[k]]));
  man.seasons = sortObj(man.seasons); teams.teams = sortObj(teams.teams); teams.conferences = sortObj(teams.conferences); quar.seasons = sortObj(quar.seasons);
  fs.writeFileSync(C.PATHS.manifest, JSON.stringify(man, null, 1) + '\n');
  fs.writeFileSync(C.PATHS.teams, JSON.stringify(teams) + '\n');
  fs.writeFileSync(C.PATHS.quarantine, JSON.stringify(quar) + '\n');
  return results;
}

module.exports = { normalise, reconcile, serialise, ingest, COLS, SCHEMA };

if (require.main === module) {
  const a = process.argv; const i = a.indexOf('--season');
  const spec = i >= 0 ? a[i + 1] : 'all';
  const cur = C.currentSeason();
  const list = spec === 'all' ? C.seasons() : spec === 'current' ? [cur] : spec.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const x = []; for (let y = +m[1]; y <= +m[2]; y++) x.push(y); return x; } return [+s]; });
  ingest(list, { offline: a.includes('--offline') }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
