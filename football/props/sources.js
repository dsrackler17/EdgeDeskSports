/* ===========================================================================
   PLAYER PROPS — public, keyless sources and the one CSV reader they share.
   docs/player-props/DATA.md

   NFL   nflverse-data releases (players, weekly rosters, weekly player stats,
         snap counts, timestamped depth charts, the official injury report,
         play-by-play) and nflverse/nfldata games.csv (the schedule).
   CFB   cfbfastR-data per-play player stats (one row per play with the
         ESPN athlete id of every participant) and EdgeDesk's own committed
         FBS artifacts (football/fbs/slate.json, football/rosters/,
         football/availability/).

   Everything is cached under football/props/.cache (gitignored). A failed
   fetch keeps the cached copy and SAYS so; a source with no copy at all is
   a named gap the build reports — nothing is ever estimated in its place.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');
const CACHE = process.env.PROPS_CACHE_DIR || path.join(ROOT, 'football', 'props', '.cache');
const NFLV = 'https://github.com/nflverse/nflverse-data/releases/download/';
const CFBV = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/';

const NFL = {
  players: () => NFLV + 'players/players.csv',
  roster_weekly: (s) => NFLV + 'weekly_rosters/roster_weekly_' + s + '.csv',
  stats_week: (s) => NFLV + 'stats_player/stats_player_week_' + s + '.csv',
  snaps: (s) => NFLV + 'snap_counts/snap_counts_' + s + '.csv',
  depth: (s) => NFLV + 'depth_charts/depth_charts_' + s + '.csv',
  injuries: (s) => NFLV + 'injuries/injuries_' + s + '.csv',
  pbp: (s) => NFLV + 'pbp/play_by_play_' + s + '.csv.gz',
  games: () => 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'
};
const CFB = {
  plays: (s) => CFBV + 'player_stats/csv/player_stats_' + s + '.csv',
  schedules: (s) => CFBV + 'schedules/csv/cfb_schedules_' + s + '.csv',
  rosters: (s) => CFBV + 'rosters/csv/cfb_rosters_' + s + '.csv'
};

function cachePath(url) { return path.join(CACHE, url.replace(/^https?:\/\//, '').replace(/[^a-z0-9.]+/gi, '_').slice(-140)); }

/* fetch to the cache. maxAgeMin: reuse a cached copy younger than this.
   Returns {file, fresh, bytes, error} — error set when only a stale copy (or
   nothing) could be used. */
async function fetchToCache(url, opts) {
  opts = opts || {};
  fs.mkdirSync(CACHE, { recursive: true });
  const file = cachePath(url);
  const maxAge = opts.maxAgeMin == null ? 60 : opts.maxAgeMin;
  if (fs.existsSync(file)) {
    const age = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
    if (age <= maxAge || opts.offline) return { file, fresh: age <= maxAge, bytes: fs.statSync(file).size, cached: true, error: null };
  }
  if (opts.offline) return { file: null, fresh: false, bytes: 0, error: 'offline and no cached copy' };
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) throw new Error('empty body');
    fs.writeFileSync(file + '.part', buf);
    fs.renameSync(file + '.part', file);
    return { file, fresh: true, bytes: buf.length, cached: false, error: null };
  } catch (e) {
    if (fs.existsSync(file)) return { file, fresh: false, bytes: fs.statSync(file).size, cached: true, error: 'fetch failed (' + e.message + '); using the cached copy' };
    return { file: null, fresh: false, bytes: 0, error: 'fetch failed (' + e.message + ') and no cached copy' };
  }
}

/* RFC-4180 line splitter: quoted fields, doubled quotes; "NA" stays a string */
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (q) {
      if (c === 34) { if (line.charCodeAt(i + 1) === 34) { cur += '"'; i++; } else q = false; }
      else cur += line[i];
    } else if (c === 44) { out.push(cur); cur = ''; }
    else if (c === 34) q = true;
    else cur += line[i];
  }
  out.push(cur);
  return out;
}
function quoteBalanced(s) { let n = 0; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 34) n++; return n % 2 === 0; }

/* stream a (possibly gzipped) CSV; onRow(obj) for each row with only the
   wanted columns. Returns {rows, header, missing}. */
async function readCsv(file, cols, onRow) {
  const input = fs.createReadStream(file);
  const stream = /\.gz$/.test(file) || isGzip(file) ? input.pipe(zlib.createGunzip()) : input;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null, idx = null, pending = '', rows = 0, missing = [];
  for await (const raw of rl) {
    let line = pending ? pending + '\n' + raw : raw;
    if (!quoteBalanced(line)) { pending = line; continue; }
    pending = '';
    if (!header) {
      header = splitCsv(line.replace(/^﻿/, ''));
      const want = cols || header;
      idx = want.map((c) => [c, header.indexOf(c)]);
      missing = idx.filter((x) => x[1] < 0).map((x) => x[0]);
      continue;
    }
    if (!line) continue;
    const f = splitCsv(line);
    const o = {};
    for (let i = 0; i < idx.length; i++) { const j = idx[i][1]; o[idx[i][0]] = j >= 0 ? f[j] : undefined; }
    rows++;
    if (onRow(o) === false) { rl.close(); break; }
  }
  return { rows, header, missing };
}
function isGzip(file) { try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b[0] === 0x1f && b[1] === 0x8b; } catch (_) { return false; } }

function n(v) { if (v === undefined || v === null || v === '' || v === 'NA') return null; const x = Number(v); return isFinite(x) ? x : null; }
function s(v) { return v === undefined || v === null || v === '' || v === 'NA' ? null : String(v); }
function b(v) { return v === '1' || v === 'TRUE' || v === 'true' || v === 1 || v === true; }

module.exports = { ROOT, CACHE, NFL, CFB, cachePath, fetchToCache, readCsv, splitCsv, n, s, b };
