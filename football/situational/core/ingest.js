/* ============================================================================
   FSIE — ingestion: one sport-season at a time, checkpointed.

   ingestSeason(sport, season)  download (cached by the feed_cache rule) ->
                                schema gate -> normalize -> quality gates ->
                                team-game + player-game aggregation ->
                                .cache/derived/<sport>_<season>.json
   backfill(sport, seasons)     ingestSeason over a range with a checkpoint
                                file: a season already built from the same
                                source fingerprint is skipped, a failed season
                                is recorded and the run moves on, so one bad
                                season never restarts a multi-season backfill.

   Idempotency: the derived file is a pure function of (source sha256,
   situations version, quality version, code version). Re-running with the
   same inputs rewrites byte-identical content. Each game carries a fingerprint
   of its own normalized plays, so a later source revision of one game is
   detected and logged as a revision, never silently overwritten.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require(path.join(__dirname, 'util.js'));
const QC = require(path.join(__dirname, 'quality.js'));
const S = require(path.join(__dirname, 'situations.js'));
const A = require(path.join(__dirname, 'aggregate.js'));
const F = require(path.join(__dirname, 'fetch.js'));
const io = require(path.join(__dirname, '..', '..', 'props', 'factory', 'lib', 'io.js'));

const CODE_VERSION = 'fsie_ingest_v3';   /* v3: NFL franchise-code normalization (v2: quality split, play-level score gate) */
function derivedDir(o) { return path.join((o && o.cache_dir) || F.CACHE, 'derived'); }
function stateFile(sport, o) { return path.join((o && o.cache_dir) || F.CACHE, 'state', sport + '_ingest.json'); }
function source(sport) { return require(path.join(__dirname, '..', sport, 'source.js')); }

function log(o, ev, data) {
  const line = Object.assign({ at: new Date().toISOString(), component: 'fsie.ingest', event: ev }, data || {});
  if (o && o.logs) o.logs.push(line);
  if (!(o && o.quiet)) process.stderr.write(JSON.stringify(line) + '\n');
}

function gameFingerprint(plays) {
  return U.sha256(plays.map((p) => [p.play_id, p.kind, p.off, p.down, p.distance, p.yards_to_goal, p.period, p.sec_left_period, p.score_off, p.score_def, p.passer_id, p.rusher_id, p.target_id].join(',')).join('\n')).slice(0, 16);
}

async function nflBox(season, opts) {
  const url = (process.env.EDGEDESK_NFLVERSE_RELEASES || 'https://github.com/nflverse/nflverse-data/releases/download').replace(/\/+$/, '') + `/stats_team/stats_team_week_${season}.csv`;
  const got = await F.getFile(url, `nfl_stats_team_week_${season}.csv`, Object.assign({ season: opts.current_season }, opts));
  if (!got.ok) return { ok: false, reason: got.error, map: null };
  const rows = await io.loadCsv(got.file, { columns: ['game_id', 'team', 'attempts', 'carries', 'sacks_suffered'] });
  const N = require(path.join(__dirname, '..', 'nfl', 'source.js'));
  const map = {}; rows.forEach((r) => { map[N.gid(r.game_id) + '|' + N.team(r.team)] = { pass_att: +r.attempts, rush_att: +r.carries, sacks: +r.sacks_suffered }; });
  return { ok: true, map, source: { name: 'nflverse stats_team_week (box score)', url: got.url, sha256: got.sha256, pulled_at: got.retrieved_at || null } };
}

async function ingestSeason(sport, season, opts) {
  opts = Object.assign({ current_season: season }, opts || {});
  const t0 = Date.now();
  const SRC = source(sport);
  const sources = [];
  const sch = await SRC.loadSchedule(season, opts);
  if (!sch.ok) return { ok: false, sport, season, stage: 'schedule', error: sch.error };
  sources.push(sch.source);
  const sched = {};
  sch.games.forEach((g) => { if (sport === 'nfl') g.home_spread_margin = g.spread_line; sched[g.game_id] = g; });
  const pbp = await SRC.loadSeason(season, opts);
  if (!pbp.ok) return { ok: false, sport, season, stage: 'pbp', error: pbp.error, sources };
  sources.push(pbp.source);
  const schema = QC.checkSchema(pbp.header, sport === 'nfl' ? 'nfl_pbp' : 'cfb_pbp');
  if (!schema.ok) {
    log(opts, 'schema_change', { sport, season, missing: schema.missing });
    return { ok: false, sport, season, stage: 'schema', error: 'source schema changed: missing ' + schema.missing.join(','), schema, sources };
  }
  const extra = { ftn: null, part: null, box: null };
  const charting = {};
  if (sport === 'nfl') {
    const ftn = await SRC.loadFtn(season, opts);
    charting.ftn = ftn.ok ? { available: true, plays: ftn.by_play.size, source: ftn.source } : { available: false, reason: ftn.reason };
    if (ftn.ok) { extra.ftn = ftn.by_play; sources.push(ftn.source); }
    const part = opts.current_season === season && opts.skip_participation_current ? { ok: false, reason: 'skipped' } : await SRC.loadParticipation(season, opts);
    charting.participation = part.ok ? { available: true, plays: part.by_play.size, source: part.source } : { available: false, reason: part.reason };
    if (part.ok) { extra.part = part.by_play; sources.push(part.source); }
    const box = await nflBox(season, opts);
    charting.box_check = box.ok ? { available: true } : { available: false, reason: box.reason };
    if (box.ok) { extra.box = box.map; sources.push(box.source); }
  } else {
    charting.formation_text = { available: true, note: 'stadium stat crew tokens in the play text (Shotgun / No Huddle / Pistol); game-level charting detection' };
    charting.ftn = { available: false, reason: 'no college charting feed exists in any public source this repository can use' };
    charting.participation = { available: false, reason: 'no public college participation / personnel feed' };
  }
  const agg = A.aggregateSeason(sport, pbp.plays, sched, extra);
  /* per-game fingerprints for revision detection */
  const byGame = {};
  pbp.plays.forEach((p) => { (byGame[p.game_id] = byGame[p.game_id] || []).push(p); });
  Object.keys(agg.games).forEach((gid) => { agg.games[gid].fingerprint = gameFingerprint((byGame[gid] || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))); });
  const prevFile = path.join(derivedDir(opts), `${sport}_${season}.json`);
  const prev = U.readJson(prevFile);
  const revisions = [];
  if (prev && prev.games) Object.keys(agg.games).forEach((gid) => { const a = prev.games[gid]; if (a && a.fingerprint && a.fingerprint !== agg.games[gid].fingerprint) revisions.push({ game_id: gid, from: a.fingerprint, to: agg.games[gid].fingerprint }); });
  const out = {
    schema: 'edgedesk_fsie_season_v1', sport, season, code_version: CODE_VERSION,
    situations_version: S.VERSION, quality_version: QC.VERSION,
    sources, source_ref: pbp.source_ref, charting,
    schedule: sch.games.map((g) => ({ game_id: g.game_id, week: g.week, season_type: g.season_type || g.game_type, kickoff_at: g.kickoff_at, home: g.home, away: g.away, completed: !!g.completed,
      home_division: g.home_division || null, away_division: g.away_division || null, home_conference: g.home_conference || null, away_conference: g.away_conference || null,
      home_name: g.home_name || null, away_name: g.away_name || null, home_score: g.home_score, away_score: g.away_score,
      home_spread_margin: g.home_spread_margin != null ? g.home_spread_margin : null, total_line: g.total_line != null ? g.total_line : null,
      neutral_site: !!g.neutral_site, conference_game: g.conference_game != null ? !!g.conference_game : (g.div_game || null),
      home_rest: g.home_rest != null ? g.home_rest : null, away_rest: g.away_rest != null ? g.away_rest : null, roof: g.roof || null,
      home_coach: g.home_coach || null, away_coach: g.away_coach || null })),
    excluded_play_kinds: pbp.excluded, play_failures: agg.play_failures,
    games: agg.games, team_games: agg.team_games, player_games: agg.player_games,
    low_volume_flags: agg.low_volume_flags, revisions,
    duration_ms: Date.now() - t0
  };
  /* the content hash covers the data and each source's fingerprint, not when a
     file was pulled: re-ingesting unchanged inputs reproduces it exactly */
  out.content_sha256 = U.sha256({ code: CODE_VERSION, sv: out.situations_version, qv: out.quality_version, src: sources.map((x) => x && x.sha256), schedule: out.schedule, games: out.games,
    team_games: out.team_games, player_games: out.player_games, failures: out.play_failures, excluded: out.excluded_play_kinds });
  fs.mkdirSync(derivedDir(opts), { recursive: true });
  U.writeJson(prevFile, out, { compact: true });
  const acc = Object.values(agg.games).filter((g) => g.status === 'accepted').length;
  log(opts, 'season_ingested', { sport, season, games: Object.keys(agg.games).length, accepted: acc, team_games: agg.team_games.length, player_games: agg.player_games.length, revisions: revisions.length, ms: out.duration_ms });
  return { ok: true, sport, season, file: prevFile, data: out };
}

function readState(sport, o) { return U.readJson(stateFile(sport, o), { schema: 'edgedesk_fsie_ingest_state_v1', sport, seasons: {} }); }
function writeState(sport, st, o) { fs.mkdirSync(path.dirname(stateFile(sport, o)), { recursive: true }); U.writeJson(stateFile(sport, o), st); }

/* resumable multi-season backfill */
async function backfill(sport, seasons, opts) {
  opts = opts || {};
  const st = readState(sport, opts);
  const results = [];
  for (const season of seasons) {
    const key = String(season);
    const done = st.seasons[key];
    const file = path.join(derivedDir(opts), `${sport}_${season}.json`);
    const current = season === opts.current_season;
    if (!opts.force && !current && done && done.status === 'done' && fs.existsSync(file) && done.code_version === CODE_VERSION) {
      results.push({ season, status: 'skipped', reason: 'already built from ' + done.source_ref });
      continue;
    }
    st.seasons[key] = Object.assign({}, done || {}, { status: 'running', started_at: new Date().toISOString() });
    writeState(sport, st, opts);
    let r;
    try { r = await ingestSeason(sport, season, opts); } catch (e) { r = { ok: false, error: String(e && e.stack || e).slice(0, 400) }; }
    st.seasons[key] = r.ok
      ? { status: 'done', source_ref: r.data.source_ref, content_sha256: r.data.content_sha256, code_version: CODE_VERSION, finished_at: new Date().toISOString(), games: Object.keys(r.data.games).length }
      : { status: 'failed', error: r.error, stage: r.stage || null, failed_at: new Date().toISOString() };
    writeState(sport, st, opts);
    results.push({ season, status: r.ok ? 'built' : 'failed', error: r.ok ? null : r.error });
  }
  return { sport, results, failed: results.filter((r) => r.status === 'failed').length };
}

function loadDerived(sport, season, o) { return U.readJson(path.join(derivedDir(o), `${sport}_${season}.json`)); }

module.exports = { ingestSeason, backfill, loadDerived, readState, gameFingerprint, CODE_VERSION, derivedDir };
