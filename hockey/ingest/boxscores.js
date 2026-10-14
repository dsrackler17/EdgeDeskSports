#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — the official box scores, as the source published them.

     node hockey/ingest/boxscores.js --season 2011-2027 [--offline] [--ttl-hours 6]

   Three per-game tables of the public sportsdataverse mirror (compiled from
   the NHL's own boxscore endpoint — a different endpoint from the
   play-by-play the models are built on):
     skater_box  goals, assists, points, shots on goal, power-play goals, PIM,
                 hits, blocked shots, time on ice, shifts
     goalie_box  starter flag, time on ice, shots against, saves, goals
                 against, and shots/saves by strength ("saves/shots" strings)
     team_box    goals, shots on goal, power-play goals, PIM, hits, blocks, saves
   written to .cache/nhl_work/box_<season>.json.gz with the source URL, its
   sha256 and retrieval time. Values are kept exactly as published (a TOI is
   parsed to seconds; an unparsable one is null and counted, never 0). Two
   uses: the reconciliation against the play-by-play
   (hockey/crosscheck/boxscore.js) and the player research (hockey/props/).

   Time: like every historical row here, `known_at` was never recorded; a box
   score is taken as available four hours after the scheduled start (RETRO).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('../config');
const io = require('../lib/io');
const { toiSeconds } = require('./lineups');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
const outFile = (s) => path.join(C.PATHS.cacheWork, 'box_' + s + '.json.gz');
const n = (v) => io.num(v);

async function getFile(kind, season, offline, ttlH) {
  const url = C.SOURCES[kind](season);
  const local = path.join(C.PATHS.cacheSrc, path.basename(new URL(url).pathname));
  if (offline) {
    if (!fs.existsSync(local)) return { ok: false, url, error: { code: 'OFFLINE_MISSING' } };
    const buf = fs.readFileSync(local);
    return { ok: true, url, file: local, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length, fetched_at: fs.statSync(local).mtime.toISOString(), offline: true };
  }
  return io.fetchSource(url, { ttlMs: ttlH * 3600e3 });
}
/** "27/29" → [saves, shots] (null when absent or malformed) */
function fraction(v) { const m = /^(\d+)\/(\d+)$/.exec(String(v == null ? '' : v).trim()); return m ? [Number(m[1]), Number(m[2])] : null; }

/** pure: rows of the three tables → the per-game structure, with counts of what did not parse */
function buildBox(sk, gl, tm) {
  const games = {}; const names = {}; const stats = { skater_rows: sk.length, goalie_rows: gl.length, team_rows: tm.length, toi_unparsed: 0, duplicates: 0 };
  const G = (id, date) => games[id] || (games[id] = { date: date ? String(date).slice(0, 10) : null, skaters: { home: [], away: [] }, goalies: { home: [], away: [] }, teams: {} });
  for (const r of sk) {
    const side = r.home_away === 'home' || r.home_away === 'away' ? r.home_away : null; const id = n(r.game_id), pid = n(r.player_id);
    if (!side || id == null || pid == null) continue;
    const g = G(id, r.game_date); if (r.player_name) names[pid] = String(r.player_name);
    if (g.skaters[side].some((x) => x[0] === pid)) { stats.duplicates++; continue; }
    const toi = toiSeconds(r.toi); if (toi == null) stats.toi_unparsed++;
    /* [player, toi_s, goals, assists, shots_on_goal, pp_goals, position, pim, hits, blocks, shifts] */
    g.skaters[side].push([pid, toi, n(r.goals), n(r.assists), n(r.shots_on_goal), n(r.power_play_goals), r.position || null, n(r.pim), n(r.hits), n(r.blocked_shots), n(r.shifts)]);
  }
  for (const r of gl) {
    const side = r.home_away === 'home' || r.home_away === 'away' ? r.home_away : null; const id = n(r.game_id), pid = n(r.player_id);
    if (!side || id == null || pid == null) continue;
    const g = G(id, r.game_date); if (r.player_name) names[pid] = String(r.player_name);
    if (g.goalies[side].some((x) => x[0] === pid)) { stats.duplicates++; continue; }
    const toi = toiSeconds(r.toi); if (toi == null) stats.toi_unparsed++;
    const ev = fraction(r.even_strength_shots_against), pp = fraction(r.power_play_shots_against), sh = fraction(r.shorthanded_shots_against);
    /* [goalie, starter, toi_s, shots_against, saves, goals_against, ev [saves, shots], pp, sh, decision] */
    g.goalies[side].push([pid, io.bool(r.starter) ? 1 : 0, toi, n(r.shots_against), n(r.saves), n(r.goals_against), ev, pp, sh, r.decision || null]);
  }
  for (const r of tm) {
    const side = r.home_away === 'home' || r.home_away === 'away' ? r.home_away : null; const id = n(r.game_id);
    if (!side || id == null) continue;
    G(id, r.game_date).teams[side] = { team: r.team_abbrev || null, goals: n(r.goals), sog: n(r.shots_on_goal), ppg: n(r.power_play_goals), pim: n(r.pim), hits: n(r.hits), blocks: n(r.blocked_shots), saves: n(r.saves), ga: n(r.goals_against) };
  }
  return { games, names, stats };
}

async function ingestBox(season, o) {
  o = o || {};
  const ttl = o.ttlHours == null ? 6 : o.ttlHours;
  const src = {}; const rows = {};
  for (const [kind, cols] of [['skater_box', C.SKATER_BOX_COLUMNS], ['goalie_box', C.GOALIE_BOX_COLUMNS], ['team_box', C.TEAM_BOX_COLUMNS]]) {
    const f = await getFile(kind, season, !!o.offline, ttl);
    if (!f.ok) {
      if (f.status === 404 || (f.error && f.error.code === 'HTTP_404')) return { season, not_published: true };
      return { season, error: { kind, error: f.error || f.status } };
    }
    src[kind] = { url: f.url, sha256: f.sha256, bytes: f.bytes, fetched_at: f.fetched_at };
    const { rows: r, missing } = await io.parquetAll(f.file, cols); rows[kind] = r; src[kind].missing_columns = missing;
  }
  const b = buildBox(rows.skater_box, rows.goalie_box, rows.team_box);
  fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
  fs.writeFileSync(outFile(season), zlib.gzipSync(JSON.stringify({ schema: 'edgedesk_nhl_box_v1', season, sources: src, stats: b.stats, names: b.names, games: b.games, known_at: null, pit: 'RETRO' })));
  return { season, games: Object.keys(b.games).length, stats: b.stats, sources: src };
}

function loadBox(season) {
  const f = outFile(season); if (!fs.existsSync(f)) return null;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
}

module.exports = { buildBox, ingestBox, loadBox, fraction };

if (require.main === module) {
  const spec = arg('season', String(C.CURRENT_SEASON)).replace(/^current$/, String(C.CURRENT_SEASON)).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON);
  const seasons = spec.split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  (async () => {
    for (const s of seasons) {
      const r = await ingestBox(s, { offline: flag('offline'), ttlHours: Number(arg('ttl-hours', 6)) });
      if (r.not_published) { console.log('[nhl box] ' + s + ': not published yet'); continue; }
      if (r.error) { console.log('[nhl box] ' + s + ': unavailable — ' + JSON.stringify(r.error)); process.exitCode = 1; continue; }
      console.log('[nhl box] ' + s + ': ' + r.games + ' games; ' + r.stats.skater_rows + ' skater, ' + r.stats.goalie_rows + ' goalie, ' + r.stats.team_rows + ' team rows; TOI unparsed ' + r.stats.toi_unparsed + '; duplicates ' + r.stats.duplicates);
    }
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
