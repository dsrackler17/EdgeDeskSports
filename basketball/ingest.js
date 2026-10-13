#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk basketball — season schedules in, a committed game table out.

     node basketball/ingest.js --league nba|wnba|ncaam|ncaaw|all [--season 2010-2027|current|all] [--offline]

   One file per league-season: basketball/data/<league>/<season>.csv
   (schema edgedesk_bb_games_v1), one row per game:

     game_id, season, type (R regular | P postseason incl. play-in),
     date (the North American game day: the UTC start minus 10 h, so a late
     tip that starts after midnight UTC keeps its evening's date), start_utc,
     neutral (0/1),
     home_id, away_id (ESPN team ids; names in teams.json), hs, as, ot (0/1),
     status (FINAL | SCHEDULED), src (S = sportsdataverse, P = the data pack),
     known_at (blank: first publication unknown — never backdated),
     assumed_available_at (start + 4 h, FINAL only), pit (RETRO)

   THE DATA PACK. For the season the pack retrieved (config pack_season), a
   FINAL pack game the source lacks is added with src = P — its season type
   from the pack's own raw scoreboards; a pack game whose type is unknown or
   preseason is not added. (The 2024-25 women's college source misses ~200
   games, most of them the March tournaments.) Overtime is unknown for pack
   rows (blank). Where both have a game, the source row is kept and the two
   finals are compared by tools/datapack/crosscheck.js.

   Dropped and counted, never silently: preseason, all-star and exhibition
   events, canceled and postponed games, a FINAL with a missing score. A
   SCHEDULED row is kept only for the season in progress (the slate's input).
   Dedupe: one row per game id (the last occurrence wins, counted).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const { fetchFile } = require('../engine/lab/fetch');
const io = require('../hockey/lib/io');
const { toCsv } = require('../engine/csv');

const COLS = ['game_id', 'season', 'type', 'date', 'start_utc', 'neutral', 'home_id', 'away_id', 'hs', 'as', 'ot', 'status', 'src', 'known_at', 'assumed_available_at', 'pit'];
const isoS = (t) => new Date(t).toISOString().replace(/\.000Z$/, 'Z');
const EXHIBITION = /all-star|all star|rising stars|celebrity|skills challenge|exhibition/i;

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** native rows -> canonical game rows; pure (tested offline) */
function normalise(rows, season, keepScheduled) {
  const stats = { rows: rows.length, kept: 0, scheduled: 0, preseason: 0, exhibition: 0, not_played: 0, missing_score: 0, duplicates: 0, other_type: 0 };
  const byId = new Map();
  for (const r of rows) {
    const st = Number(r.season_type);
    if (st === 1) { stats.preseason++; continue; }
    if (st !== 2 && st !== 3 && st !== 5) { stats.other_type++; continue; }
    if (EXHIBITION.test(String(r.notes_headline || '')) || /^Team /.test(String(r.home_display_name || ''))) { stats.exhibition++; continue; }
    const start = String(r.date || '').replace(/Z$/, ':00Z').replace(/:00:00Z$/, ':00Z');
    const t = Date.parse(start);
    const completed = r.status_type_completed === true || r.status_type_completed === 'true';
    const name = String(r.status_type_name || '');
    let status;
    if (completed && name === 'STATUS_FINAL') status = 'FINAL';
    else if (!completed && /SCHEDULED|STATUS_TBD/.test(name)) status = 'SCHEDULED';
    else { stats.not_played++; continue; }
    if (status === 'SCHEDULED' && !keepScheduled) { stats.not_played++; continue; }
    const hs = num(r.home_score), as = num(r.away_score);
    if (status === 'FINAL' && (hs == null || as == null)) { stats.missing_score++; continue; }
    const id = String(r.game_id);
    if (byId.has(id)) stats.duplicates++;
    const per = num(r.status_period), reg = num(r.format_regulation_periods);
    byId.set(id, {
      game_id: id, season, type: st === 2 ? 'R' : 'P', date: isFinite(t) ? isoS(t - 10 * 3600e3).slice(0, 10) : '', start_utc: isFinite(t) ? isoS(t) : '',
      neutral: r.neutral_site === true || r.neutral_site === 'true' ? 1 : 0,
      home_id: String(r.home_id), away_id: String(r.away_id),
      _names: [[String(r.home_id), r.home_display_name || r.home_abbreviation || null], [String(r.away_id), r.away_display_name || r.away_abbreviation || null]],
      hs: status === 'FINAL' ? hs : '', as: status === 'FINAL' ? as : '', ot: status === 'FINAL' && per != null && reg != null ? (per > reg ? 1 : 0) : '',
      status, src: 'S', known_at: '', assumed_available_at: status === 'FINAL' && isFinite(t) ? isoS(t + 4 * 3600e3) : '', pit: 'RETRO',
    });
  }
  const out = [...byId.values()].filter((g) => g.date).sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  stats.kept = out.filter((g) => g.status === 'FINAL').length; stats.scheduled = out.filter((g) => g.status === 'SCHEDULED').length;
  const names = {};
  for (const g of out) { for (const [id, n] of g._names) if (n) names[id] = n; delete g._names; }
  return { games: out, stats, names };
}

/** pack games the source lacks, for the pack's season */
function packAdditions(league, season, have) {
  const L = C.LEAGUES[league];
  if (!L.pack || L.pack_season !== season) return { rows: [], stats: null };
  const zlib = require('zlib');
  const dir = path.join(C.ROOT, 'datapack', 'quant_v1', 'data', L.pack);
  const type = new Map();
  for (const f of fs.readdirSync(path.join(dir, 'raw')).filter((x) => /^scoreboard_.*\.json\.gz$/.test(x))) {
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'raw', f))).toString('utf8'));
    for (const e of j.events || []) type.set(String(e.id), e.season && e.season.type);
  }
  const { readCsv } = require('../engine/csv');
  const stats = { pack_final: 0, already_in_source: 0, added: 0, preseason_or_unknown_type: 0 };
  const rows = [];
  for (const g of readCsv(path.join(dir, 'games_historical.csv')).rows) {
    if (g.status !== 'STATUS_FINAL') continue;
    stats.pack_final++;
    if (have.has(String(g.game_id))) { stats.already_in_source++; continue; }
    const st = Number(type.get(String(g.game_id)));
    if (st !== 2 && st !== 3) { stats.preseason_or_unknown_type++; continue; }
    const t = Date.parse(g.start_time.replace(/Z$/, ':00Z'));
    rows.push({ game_id: String(g.game_id), season, type: st === 2 ? 'R' : 'P', date: isoS(t - 10 * 3600e3).slice(0, 10), start_utc: isoS(t), neutral: g.neutral_site === 'True' ? 1 : 0,
      home_id: String(g.home_id), away_id: String(g.away_id), hs: Number(g.home_score), as: Number(g.away_score), ot: '', status: 'FINAL', src: 'P', known_at: '', assumed_available_at: isoS(t + 4 * 3600e3), pit: 'RETRO',
      _names: [[String(g.home_id), g.home_name], [String(g.away_id), g.away_name]] });
    stats.added++;
  }
  return { rows, stats };
}

async function ingest(league, season, o) {
  const L = C.LEAGUES[league];
  const src = await fetchFile(L.url(season), { offline: o && o.offline, ttlMs: season >= C.currentSeason(league) - 1 ? 6 * 3600e3 : 30 * 86400e3 });
  if (!src.ok) return { league, season, not_published: !!src.not_found, error: src.not_found ? null : src.error };
  let missing = [];
  const rows = [];
  for await (const r of io.parquetRows(src.file, C.COLUMNS, (m) => { missing = m; })) rows.push(r);
  const { games, stats, names } = normalise(rows, season, season === C.currentSeason(league));
  const add = packAdditions(league, season, new Set(games.map((g) => g.game_id)));
  for (const g of add.rows) { for (const [id, n] of g._names) if (n && !names[id]) names[id] = n; delete g._names; games.push(g); }
  if (add.stats) { stats.pack = add.stats; stats.kept += add.stats.added; games.sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1)); }
  const dir = C.PATHS.data(league); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, season + '.csv');
  const text = toCsv(COLS, games);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old !== text) fs.writeFileSync(file, text);
  return { league, season, file: path.relative(C.ROOT, file), changed: old !== text, stats, names, missing, source: { url: src.url, sha256: src.sha256, bytes: src.bytes, fetched_at: src.fetched_at } };
}

function updateManifest(league, results) {
  const p = path.join(C.PATHS.data(league), 'manifest.json');
  let man = {}; try { man = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  man.schema = 'edgedesk_bb_games_v1'; man.league = league; man.columns = COLS; man.license = C.LICENSE; man.seasons = man.seasons || {};
  man.temporal = { known_at: 'blank: first publication was never recorded (never backdated)', assumed_available_at: 'start + 4 h for a FINAL', pit: 'RETRO: retrieved after the fact from a source that can revise' };
  for (const r of results) if (!r.error && !r.not_published) man.seasons[r.season] = { games: r.stats.kept, scheduled: r.stats.scheduled, dropped: { preseason: r.stats.preseason, exhibition: r.stats.exhibition, not_played: r.stats.not_played, missing_score: r.stats.missing_score, other_type: r.stats.other_type }, duplicates: r.stats.duplicates, missing_columns: r.missing, source: r.source, pack: r.stats.pack || null };
  fs.writeFileSync(p, JSON.stringify(man, null, 1) + '\n');
  /* team names: the newest season's spelling wins */
  const tp = path.join(C.PATHS.data(league), 'teams.json');
  let teams = {}; try { teams = JSON.parse(fs.readFileSync(tp, 'utf8')); } catch (_) {}
  for (const r of results.slice().sort((a, b) => a.season - b.season)) if (r.names) Object.assign(teams, r.names);
  const sorted = {}; for (const k of Object.keys(teams).sort((a, b) => Number(a) - Number(b))) sorted[k] = teams[k];
  fs.writeFileSync(tp, JSON.stringify(sorted, null, 0) + '\n');
}

/** the committed games of a league for the given seasons, typed */
function loadGames(league, seasons) {
  const { readCsv } = require('../engine/csv');
  const out = [];
  for (const s of seasons) {
    const f = path.join(C.PATHS.data(league), s + '.csv');
    if (!fs.existsSync(f)) continue;
    for (const r of readCsv(f).rows) out.push(Object.assign(r, { season: Number(r.season), neutral: Number(r.neutral), hs: r.hs === '' ? null : Number(r.hs), as: r.as === '' ? null : Number(r.as), ot: r.ot === '' ? null : Number(r.ot) }));
  }
  return out;
}

module.exports = { normalise, ingest, loadGames, COLS };

if (require.main === module) {
  const lg = arg('league', 'all');
  const leagues = lg === 'all' ? Object.keys(C.LEAGUES) : lg.split(',');
  (async () => {
    for (const league of leagues) {
      const cur = C.currentSeason(league);
      const spec = arg('season', 'all').replace(/^current$/, String(cur)).replace(/^all$/, C.LEAGUES[league].first + '-' + cur);
      const seasons = spec.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
      const results = [];
      for (const s of seasons) {
        const r = await ingest(league, s, { offline: process.argv.includes('--offline') });
        results.push(r);
        if (r.not_published) console.log('[bb ingest] ' + league + ' ' + s + ': not published by the source');
        else if (r.error) { console.log('[bb ingest] ' + league + ' ' + s + ': unavailable — ' + JSON.stringify(r.error)); process.exitCode = 1; }
        else console.log('[bb ingest] ' + league + ' ' + s + ': ' + r.stats.kept + ' final' + (r.stats.scheduled ? ', ' + r.stats.scheduled + ' scheduled' : '') + ' (dropped: ' + r.stats.preseason + ' preseason, ' + r.stats.exhibition + ' exhibition, ' + r.stats.not_played + ' not played)' + (r.missing.length ? ' missing ' + r.missing.join(',') : '') + (r.changed ? '' : ' — unchanged'));
      }
      updateManifest(league, results);
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
