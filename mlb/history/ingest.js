#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk MLB — regular-season game logs in, a committed game table out.

     node mlb/history/ingest.js [--season 2010-2025|all] [--offline]

   Sources, by season:
     Retrosheet game logs (chadwickbureau/retrosheet, seasons/<Y>/GL<Y>.TXT):
       every regular-season game with its starting pitchers, park, day/night
       and length in outs. Terms: "The information used here was obtained
       free of charge from and is copyrighted by Retrosheet. Interested
       parties may contact Retrosheet at www.retrosheet.org."
     2024: Retrosheet's 2024 log is not reachable here, so the season comes
       from the data pack's MLB StatsAPI table (datapack/quant_v1/data/mlb/
       games_2024.csv, game_type R). It has NO starting pitchers: sp_home and
       sp_away are blank for 2024 and the model prices those games without a
       starter term. Nothing is filled in.

   mlb/history/data/<season>.csv (schema edgedesk_mlb_games_v1):
     game_id, season, date, game_no, dn (D/N), home, away (franchise keys),
     hs, as, outs, park, sp_home, sp_away, source, known_at (blank),
     assumed_available_at (08:00 UTC the next day: every game of a date has
     ended by then), pit (RETRO)
   Pitcher names: mlb/history/data/pitchers.json.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const { fetchFile } = require('../../engine/lab/fetch');
const { parseCsv, readCsv, toCsv } = require('../../engine/csv');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(__dirname, 'data');
const URL = (y) => `https://raw.githubusercontent.com/chadwickbureau/retrosheet/master/seasons/${y}/GL${y}.TXT`;
const FIRST = 2010, LAST = 2025;
const COLS = ['game_id', 'season', 'date', 'game_no', 'dn', 'home', 'away', 'hs', 'as', 'outs', 'park', 'sp_home', 'sp_away', 'source', 'known_at', 'assumed_available_at', 'pit'];
const LICENSE = 'Retrosheet: "The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at www.retrosheet.org." 2024 from the data pack\'s MLB StatsAPI retrieval (MLB terms apply).';

/* franchise keys: a move keeps the franchise (FLO -> MIA, OAK -> ATH as OAK) */
const FRANCHISE = { FLO: 'MIA', ATH: 'OAK' };
const NAME_TO_KEY = {
  'Los Angeles Angels': 'ANA', 'Arizona Diamondbacks': 'ARI', 'Oakland Athletics': 'OAK', Athletics: 'OAK', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL', 'Boston Red Sox': 'BOS',
  'Chicago White Sox': 'CHA', 'Chicago Cubs': 'CHN', 'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Cleveland Indians': 'CLE', 'Colorado Rockies': 'COL', 'Detroit Tigers': 'DET',
  'Houston Astros': 'HOU', 'Kansas City Royals': 'KCA', 'Los Angeles Dodgers': 'LAN', 'Miami Marlins': 'MIA', 'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Yankees': 'NYA',
  'New York Mets': 'NYN', 'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SDN', 'Seattle Mariners': 'SEA', 'San Francisco Giants': 'SFN', 'St. Louis Cardinals': 'SLN',
  'Tampa Bay Rays': 'TBA', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR', 'Washington Nationals': 'WAS',
};
const fk = (code) => FRANCHISE[code] || code;
function nextDay8(date) { const t = Date.parse(date + 'T08:00:00Z') + 864e5; return new Date(t).toISOString().replace(/\.000Z$/, 'Z'); }
const iso = (yyyymmdd) => yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);

/** Retrosheet game log text -> rows (field positions per the Retrosheet game log guide); pure */
function parseGameLog(text, season) {
  const rows = []; const pitchers = {}; const stats = { lines: 0, kept: 0, forfeits: 0, no_score: 0 };
  for (const f of parseCsv(text)) {
    if (f.length < 105) continue;
    stats.lines++;
    const date = iso(f[0]); const gameNo = f[1];
    const away = fk(f[3]), home = fk(f[6]);
    const as = Number(f[9]), hs = Number(f[10]);
    if (f[14]) { stats.forfeits++; continue; }
    if (!Number.isFinite(as) || !Number.isFinite(hs)) { stats.no_score++; continue; }
    const spA = f[101] || '', spH = f[103] || '';
    if (spA) pitchers[spA] = f[102]; if (spH) pitchers[spH] = f[104];
    rows.push({ game_id: home + f[0] + gameNo, season, date, game_no: Number(gameNo), dn: f[12] || '', home, away, hs, as, outs: Number(f[11]) || '', park: f[16] || '', sp_home: spH, sp_away: spA, source: 'retrosheet', known_at: '', assumed_available_at: nextDay8(date), pit: 'RETRO' });
    stats.kept++;
  }
  return { rows, pitchers, stats };
}

/** the data pack's 2024 StatsAPI games -> rows (regular season, final); no starters */
function fromPack2024() {
  const f = path.join(ROOT, 'datapack', 'quant_v1', 'data', 'mlb', 'games_2024.csv');
  const stats = { rows: 0, kept: 0, not_regular: 0, not_final: 0, unknown_team: 0 };
  const rows = []; const seen = new Map();
  for (const r of readCsv(f).rows) {
    stats.rows++;
    if (r.game_type !== 'R') { stats.not_regular++; continue; }
    if (r.status !== 'Final' && r.status !== 'Completed Early') { stats.not_final++; continue; }
    const h = NAME_TO_KEY[r.home_name], a = NAME_TO_KEY[r.away_name];
    if (!h || !a) { stats.unknown_team++; continue; }
    const t = Date.parse(r.start_time); const date = new Date(t - 10 * 3600e3).toISOString().slice(0, 10);
    const k = h + date.replace(/-/g, ''); const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    rows.push({ game_id: k + (n === 1 ? '0' : String(n)), season: 2024, date, game_no: n === 1 ? 0 : n, dn: '', home: h, away: a, hs: Number(r.home_score), as: Number(r.away_score), outs: '', park: '', sp_home: '', sp_away: '', source: 'pack_statsapi:' + r.game_id, known_at: '', assumed_available_at: nextDay8(date), pit: 'RETRO' });
    stats.kept++;
  }
  /* a doubleheader's two games share a date: number them 1 and 2 like Retrosheet */
  for (const r of rows) if (seen.get(r.home + r.date.replace(/-/g, '')) > 1 && r.game_no === 0) { r.game_no = 1; r.game_id = r.game_id.slice(0, -1) + '1'; }
  return { rows, stats };
}

async function ingest(season, o) {
  let rows, pitchers = {}, stats, source;
  if (season === 2024) { const p = fromPack2024(); rows = p.rows; stats = p.stats; source = { file: 'datapack/quant_v1/data/mlb/games_2024.csv', note: 'no starting pitchers' }; }
  else {
    const src = await fetchFile(URL(season), { offline: o && o.offline, ttlMs: 30 * 86400e3 });
    if (!src.ok) return { season, not_published: !!src.not_found, error: src.not_found ? null : src.error };
    const p = parseGameLog(fs.readFileSync(src.file, 'utf8'), season); rows = p.rows; pitchers = p.pitchers; stats = p.stats;
    source = { url: src.url, sha256: src.sha256, fetched_at: src.fetched_at };
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.game_id < b.game_id ? -1 : 1));
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, season + '.csv');
  const text = toCsv(COLS, rows);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  return { season, rows: rows.length, stats, pitchers, source };
}

function loadGames(seasons) {
  const out = [];
  for (const s of seasons) {
    const f = path.join(DATA, s + '.csv'); if (!fs.existsSync(f)) continue;
    for (const r of readCsv(f).rows) out.push(Object.assign(r, { season: Number(r.season), hs: Number(r.hs), as: Number(r.as), game_no: Number(r.game_no) }));
  }
  return out;
}

module.exports = { parseGameLog, fromPack2024, ingest, loadGames, FIRST, LAST, LICENSE, DATA, FRANCHISE };

if (require.main === module) {
  const i = process.argv.indexOf('--season'); const spec = i >= 0 ? process.argv[i + 1] : 'all';
  const seasons = spec.replace(/^all$/, FIRST + '-' + LAST).split(',').flatMap((s) => { const m = /^(\d{4})-(\d{4})$/.exec(s); if (m) { const a = []; for (let y = +m[1]; y <= +m[2]; y++) a.push(y); return a; } return [+s]; });
  (async () => {
    const manP = path.join(DATA, 'manifest.json'); let man = {}; try { man = JSON.parse(fs.readFileSync(manP, 'utf8')); } catch (_) {}
    const pP = path.join(DATA, 'pitchers.json'); let names = {}; try { names = JSON.parse(fs.readFileSync(pP, 'utf8')); } catch (_) {}
    man.schema = 'edgedesk_mlb_games_v1'; man.columns = COLS; man.license = LICENSE; man.seasons = man.seasons || {};
    man.temporal = { known_at: 'blank (never backdated)', assumed_available_at: '08:00 UTC the day after the game date', pit: 'RETRO' };
    for (const s of seasons) {
      const r = await ingest(s, { offline: process.argv.includes('--offline') });
      if (r.not_published || r.error) { console.log('[mlb ingest] ' + s + ': ' + (r.not_published ? 'not published' : 'unavailable ' + JSON.stringify(r.error))); continue; }
      Object.assign(names, r.pitchers);
      man.seasons[s] = { games: r.rows, stats: r.stats, source: r.source };
      console.log('[mlb ingest] ' + s + ': ' + r.rows + ' games ' + JSON.stringify(r.stats));
    }
    fs.writeFileSync(manP, JSON.stringify(man, null, 1) + '\n');
    const sorted = {}; for (const k of Object.keys(names).sort()) sorted[k] = names[k];
    fs.writeFileSync(pP, JSON.stringify(sorted) + '\n');
  })().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
}
