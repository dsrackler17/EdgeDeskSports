#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — who dressed: per-game skater lineups with time on ice.

     node hockey/ingest/lineups.js --season 2011-2027 [--offline] [--ttl-hours 6]

   Reads each season's skater box score (sportsdataverse fastRhockey, from the
   NHL's own game feeds; ≈ 0.4 MB a season) through the guarded client and
   writes .cache/nhl_work/lineups_<season>.json.gz:
     { names: { player_id: name }, games: { game_id: { date, home: [[player_id, toi_seconds, pos], ...], away: [...] } } }

   WHAT IT IS AND IS NOT. A box score lists the skaters who played, after the
   game. It is the lineup a reader could have seen at warmups (about 30
   minutes before puck drop), so the walk-forward treats it as the CONFIRMED
   lineup at that time — the same assumption as the confirmed goalie. The
   PROJECTED lineup, known before warmups, is the team's previous game's.
   No injury report or line-rush feed is used or implied.

   Dedupe: a player listed twice for one game counts once (the larger TOI).
   A TOI that does not parse is null and counted, never 0. A team-game with
   fewer than 16 or more than 20 skaters is kept and flagged.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('../config');
const io = require('../lib/io');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
const outFile = (s) => path.join(C.PATHS.cacheWork, 'lineups_' + s + '.json.gz');

function toiSeconds(v) {
  const m = /^(\d{1,3}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

async function getFile(season, offline, ttlH) {
  const url = C.SOURCES.skater_box(season);
  const local = path.join(C.PATHS.cacheSrc, path.basename(new URL(url).pathname));
  if (offline) {
    if (!fs.existsSync(local)) return { ok: false, url, error: { code: 'OFFLINE_MISSING' } };
    const buf = fs.readFileSync(local);
    return { ok: true, url, file: local, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, fetched_at: fs.statSync(local).mtime.toISOString(), offline: true };
  }
  return io.fetchSource(url, { ttlMs: ttlH * 3600e3 });
}

/** group box-score rows into lineups; pure (tested offline) */
function buildLineups(rows) {
  const games = {}; const names = {}; const stats = { rows: 0, duplicates: 0, toi_unparsed: 0, team_games: 0, flagged: [] };
  for (const r of rows) {
    stats.rows++;
    const side = r.home_away === 'home' ? 'home' : r.home_away === 'away' ? 'away' : null;
    if (!side || r.game_id == null || r.player_id == null) continue;
    const id = Number(r.game_id);
    const g = games[id] || (games[id] = { date: r.game_date ? String(r.game_date).slice(0, 10) : null, home: [], away: [] });
    const toi = toiSeconds(r.toi);
    if (toi == null) stats.toi_unparsed++;
    const pid = Number(r.player_id);
    if (r.player_name) names[pid] = String(r.player_name);
    const prev = g[side].find((x) => x[0] === pid);
    if (prev) { stats.duplicates++; if (toi != null && (prev[1] == null || toi > prev[1])) prev[1] = toi; continue; }
    g[side].push([pid, toi, r.position || null]);
  }
  for (const [id, g] of Object.entries(games)) for (const side of ['home', 'away']) {
    stats.team_games++;
    if (g[side].length < 16 || g[side].length > 20) stats.flagged.push({ game_id: Number(id), side, skaters: g[side].length });
  }
  return { games, names, stats };
}

async function ingestLineups(season, o) {
  o = o || {};
  const src = await getFile(season, !!o.offline, o.ttlHours == null ? 6 : o.ttlHours);
  if (!src.ok) {
    if (src.status === 404 || (src.error && src.error.code === 'HTTP_404')) return { season, not_published: true };
    return { season, error: src.error || src.status };
  }
  const rows = [];
  let missing = [];
  for await (const r of io.parquetRows(src.file, C.SKATER_COLUMNS, (m) => { missing = m; })) rows.push(r);
  const { games, names, stats } = buildLineups(rows);
  fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
  fs.writeFileSync(outFile(season), zlib.gzipSync(JSON.stringify({ schema: 'edgedesk_nhl_lineups_v1', season, source: { url: src.url, sha256: src.sha256, fetched_at: src.fetched_at }, missing, stats, names, games })));
  return { season, games: Object.keys(games).length, stats, missing };
}

/** game_id -> { date, home, away } for the seasons on disk; absent seasons are listed, not guessed */
function loadLineups(seasons) {
  const map = new Map(); const absent = []; const names = {};
  for (const s of seasons) {
    const f = outFile(s);
    if (!fs.existsSync(f)) { absent.push(s); continue; }
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
    for (const [id, g] of Object.entries(j.games)) map.set(Number(id), g);
    Object.assign(names, j.names || {});
  }
  return { map, absent, names };
}

module.exports = { toiSeconds, buildLineups, ingestLineups, loadLineups };

if (require.main === module) {
  const spec = arg('season', String(C.CURRENT_SEASON));
  const seasons = spec.replace(/^current$/, String(C.CURRENT_SEASON)).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON).split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  (async () => {
    for (const s of seasons) {
      const r = await ingestLineups(s, { offline: flag('offline'), ttlHours: Number(arg('ttl-hours', 6)) });
      if (r.not_published) { console.log('[nhl lineups] ' + s + ': not published by the source yet'); continue; }
      if (r.error) { console.log('[nhl lineups] ' + s + ': unavailable — ' + JSON.stringify(r.error)); process.exitCode = 1; continue; }
      console.log('[nhl lineups] ' + s + ': ' + r.games + ' games, ' + r.stats.rows + ' rows, ' + r.stats.duplicates + ' duplicates, ' + r.stats.toi_unparsed + ' TOI unparsed, ' + r.stats.flagged.length + ' team-games flagged' + (r.missing.length ? ', missing columns ' + r.missing.join(',') : ''));
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
