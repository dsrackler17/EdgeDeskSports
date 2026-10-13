#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NHL — ingest one season's play-by-play into cached game records.

     node hockey/ingest/season.js --season 2026 [--offline] [--ttl-hours 6]

   Reads three files of the season (sportsdataverse fastRhockey, compiled from
   the NHL's own game feeds) through the guarded client:
     schedule   start time (UTC), game type, official final, state
     goalie box the official starting goalie of each team
     pbp_lite   every event, for shots, strength, score state, penalties
   and writes .cache/nhl_work/games_<season>.jsonl.gz: one processed record
   per completed game (hockey/ingest/game.js), plus a provenance block.

   DEDUPLICATION. A game id seen twice in the play-by-play is processed once
   (the source occasionally repeats a game after a correction; the later
   block wins and the duplicate is counted). Preseason and all-star games are
   dropped. A game whose play-by-play final disagrees with the official final
   is kept, flagged, and counted in the manifest's `issues`.

   MISSING DATA. A column the season's file lacks is listed in `missing`; a
   game with no shot coordinates keeps its goals and strength time but its
   shots carry null geometry, and the xG step scores them as missing (not 0).
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../config');
const io = require('../lib/io');
const { processGame } = require('./game');

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }

async function getFile(kind, season, offline, ttlH) {
  const url = C.SOURCES[kind](season);
  const name = path.basename(new URL(url).pathname);
  const local = path.join(C.PATHS.cacheSrc, name);
  if (offline) {
    if (!fs.existsSync(local)) return { ok: false, url, error: { code: 'OFFLINE_MISSING', message: 'no cached copy of ' + name } };
    const buf = fs.readFileSync(local);
    return { ok: true, url, file: local, sha256: require('crypto').createHash('sha256').update(buf).digest('hex'), bytes: buf.length, fetched_at: fs.statSync(local).mtime.toISOString(), from_cache: true, offline: true };
  }
  return io.fetchSource(url, { ttlMs: ttlH * 3600e3 });
}

async function ingestSeason(season, o) {
  o = o || {};
  const offline = !!o.offline; const ttlH = o.ttlHours == null ? 6 : o.ttlHours;
  const prov = {};
  const sched = await getFile('schedule', season, offline, ttlH);
  const gbox = await getFile('goalie_box', season, offline, ttlH);
  const pbp = await getFile('pbp', season, offline, ttlH);
  for (const [k, v] of Object.entries({ schedule: sched, goalie_box: gbox, pbp })) prov[k] = v.ok ? { url: v.url, sha256: v.sha256, bytes: v.bytes, fetched_at: v.fetched_at, stale: !!v.stale } : { url: v.url, error: v.error };
  if (!pbp.ok) {
    /* a season the source has not published yet (the off-season) is not a failure: nothing to ingest */
    if (pbp.status === 404 || (pbp.error && pbp.error.code === 'HTTP_404')) return { season, not_published: true, sources: prov, stats: { games: 0 } };
    throw new Error('season ' + season + ': play-by-play unavailable — ' + JSON.stringify(pbp.error));
  }

  /* schedule: start time, type, official final */
  const schedById = new Map(); const future = [];
  if (sched.ok) {
    const { rows } = await io.parquetAll(sched.file, C.SCHEDULE_COLUMNS);
    for (const r of rows) {
      const id = io.num(r.game_id); if (id == null) continue;
      schedById.set(id, r);
      if (r.game_state === 'FUT' || r.game_state === 'PRE') future.push(r);
    }
  }
  /* official starters */
  const starters = new Map(); const goalieNames = {};
  if (gbox.ok) {
    const { rows } = await io.parquetAll(gbox.file, C.GOALIE_COLUMNS);
    for (const r of rows) {
      const id = io.num(r.game_id), pid = io.num(r.player_id);
      if (pid != null && r.player_name) goalieNames[pid] = r.player_name;
      if (id == null || pid == null || !io.bool(r.starter)) continue;
      const s = starters.get(id) || {}; s[r.home_away] = pid; starters.set(id, s);
    }
  }

  fs.mkdirSync(C.PATHS.cacheWork, { recursive: true });
  const outPath = path.join(C.PATHS.cacheWork, 'games_' + season + '.jsonl.gz');
  const tmp = outPath + '.tmp';
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const stats = { season, games: 0, regular: 0, playoff: 0, dropped_type: 0, duplicates: 0, shots: 0, shots_no_xy: 0, issues: 0, issue_examples: [] };
  const seen = new Set();
  let missing = [];
  let cur = null, buf = [];

  const flush = () => {
    if (!cur || !buf.length) return;
    const first = buf[0];
    const id = io.num(first.game_id);
    const type = first.season_type || (schedById.get(id) || {}).game_type;
    if (type !== 'R' && type !== 'P') { stats.dropped_type++; return; }
    if (seen.has(id)) { stats.duplicates++; return; }
    seen.add(id);
    const sc = schedById.get(id) || {};
    const st = starters.get(id) || {};
    const meta = {
      game_id: id, season, season_type: type, date: first.game_date || sc.game_date, start_utc: sc.game_time || null,
      home: first.home_abbr || sc.home_team_abbr, away: first.away_abbr || sc.away_team_abbr,
      final_home: io.num(sc.home_score), final_away: io.num(sc.away_score),
      starter_home: st.home != null ? st.home : null, starter_away: st.away != null ? st.away : null,
    };
    const rec = processGame(meta, buf);
    stats.games++; stats[type === 'R' ? 'regular' : 'playoff']++;
    stats.shots += rec.shots.length; stats.shots_no_xy += rec.shots.filter((s) => s.dist == null).length;
    if (rec.issues.length) { stats.issues++; if (stats.issue_examples.length < 10) stats.issue_examples.push({ game_id: id, issues: rec.issues }); }
    gz.write(JSON.stringify(rec) + '\n');
  };

  for await (const r of io.parquetRows(pbp.file, C.PBP_COLUMNS, (m) => { missing = m; })) {
    const id = r.game_id;
    if (id !== cur) { flush(); cur = id; buf = []; }
    buf.push(r);
  }
  flush();
  gz.end();
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  fs.renameSync(tmp, outPath);

  const manifest = {
    season, generated_at: new Date().toISOString(), out: path.relative(C.ROOT, outPath), sources: prov, missing_columns: missing, stats,
    future_games: future.length, goalie_names: Object.keys(goalieNames).length,
  };
  fs.writeFileSync(path.join(C.PATHS.cacheWork, 'games_' + season + '.manifest.json'), JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(C.PATHS.cacheWork, 'goalie_names_' + season + '.json'), JSON.stringify(goalieNames));
  return manifest;
}

/* read back a season's cached records */
function* readSeason(season) {
  const p = path.join(C.PATHS.cacheWork, 'games_' + season + '.jsonl.gz');
  const text = zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('\n', i); const line = text.slice(i, j < 0 ? text.length : j); i = j < 0 ? text.length : j + 1;
    if (line) yield JSON.parse(line);
  }
}

module.exports = { ingestSeason, readSeason };

if (require.main === module) {
  const spec = String(arg('season', '')).replace(/^current$/, String(C.CURRENT_SEASON)).replace(/^all$/, C.FIRST_SEASON + '-' + C.CURRENT_SEASON);
  const seasons = spec.split(',').filter(Boolean).flatMap((s) => {
    const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s];
  });
  if (!seasons.length) { console.error('usage: season.js --season 2026 | 2011-2027 [--offline]'); process.exit(2); }
  (async () => {
    for (const s of seasons) {
      const t0 = Date.now();
      const m = await ingestSeason(s, { offline: flag('offline'), ttlHours: Number(arg('ttl-hours', 6)) });
      if (m.not_published) { console.log('[nhl ingest] ' + s + ': not published by the source yet — nothing to ingest'); continue; }
      console.log('[nhl ingest] ' + s + ': ' + m.stats.games + ' games (' + m.stats.regular + ' R, ' + m.stats.playoff + ' P), ' + m.stats.shots + ' unblocked shots, ' + m.stats.issues + ' flagged, dup ' + m.stats.duplicates + ', missing cols [' + m.missing_columns.join(',') + '] in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    }
  })().catch((e) => { console.error(e.stack || e); process.exit(1); });
}
