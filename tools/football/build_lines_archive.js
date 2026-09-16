#!/usr/bin/env node
/* ===========================================================================
   THE CLOSING-LINE ARCHIVE — copies, never computes.

   Every NFL game since 1999 with the closing spread and total (moneylines
   from 2006) as nflverse/nfldata's games.csv carries them, plus the context
   a pricer needs to grade itself: the result, the roof, the temperature and
   wind, rest days, the division flag and the starting quarterbacks.

   This is the archive the pricing validation (tools/football/validate_pricing.js)
   and the closing-line-value scorecard read. Nothing here is a model.

   SIGN CONVENTION. games.csv's spread_line is the HOME team's margin the
   market expects (positive = home favoured). The desk quotes lines the way
   a book prints them: model_home_line -7 means the home side is laying 7.
   So close.home_line = -spread_line. The convention is written into the
   artifact so nothing downstream has to remember it.

   Usage
     node tools/football/build_lines_archive.js            # NFL, from the cached feed
     node tools/football/build_lines_archive.js --sport cfb   # CFB with OPENERS from the sportsdataverse archive (2006 on)
     node tools/football/build_lines_archive.js --fetch    # refresh the feed first
     node tools/football/build_lines_archive.js --check    # exit 1 if the artifact is stale
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));

const SCHEMA = 'edgedesk_lines_archive_v1';
const GAMES_URL = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache', GAMES_URL.replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const OUT = path.join(ROOT, 'football', 'pricing', 'lines_nfl.json');
const OPENERS = path.join(ROOT, 'football', 'pricing', 'openers_nfl.json');
const zlib = require('zlib');
const CFB_CACHE = path.join(ROOT, 'football', 'pricing', '.cache');
const CFB_RAW = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const CFB_OUT = path.join(ROOT, 'football', 'pricing', 'lines_cfb.json');
const CFB_OPENERS = path.join(ROOT, 'football', 'pricing', 'openers_cfb.json');
const CFB_FIRST = 2006;
const COLS = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'result', 'total', 'overtime',
  'away_rest', 'home_rest', 'away_moneyline', 'home_moneyline', 'spread_line', 'away_spread_odds', 'home_spread_odds', 'total_line', 'under_odds', 'over_odds',
  'div_game', 'roof', 'surface', 'temp', 'wind', 'away_qb_id', 'home_qb_id', 'stadium'];

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function neg(v) { const n = num(v); return n == null ? null : (n === 0 ? 0 : -n); }

/** Build the archive from games.csv text. Pure; the test hands in labelled rows. */
function build(text, opts) {
  opts = opts || {};
  const rows = R.parseCsv(String(text || ''), { columns: COLS });
  const games = [];
  const seasons = {};
  rows.forEach((r) => {
    const season = num(r.season); if (season == null) return;
    const s = (seasons[season] = seasons[season] || { games: 0, with_close: 0, with_moneyline: 0, played: 0 });
    s.games++;
    const spread = num(r.spread_line);
    if (spread == null) return; /* no close on file: not an archive row */
    s.with_close++;
    const margin = num(r.result);
    if (margin != null) s.played++;
    if (num(r.home_moneyline) != null) s.with_moneyline++;
    games.push({
      id: r.game_id, season, type: r.game_type || null, week: num(r.week), date: r.gameday || null, kickoff_local: r.gametime || null,
      away: r.away_team, home: r.home_team, away_score: num(r.away_score), home_score: num(r.home_score), margin, points: num(r.total), overtime: num(r.overtime) === 1,
      close: { home_line: neg(spread), home_spread_odds: num(r.home_spread_odds), away_spread_odds: num(r.away_spread_odds), total: num(r.total_line), over_odds: num(r.over_odds), under_odds: num(r.under_odds), home_moneyline: num(r.home_moneyline), away_moneyline: num(r.away_moneyline) },
      ctx: { roof: r.roof || null, surface: r.surface || null, temp: num(r.temp), wind: num(r.wind), home_rest: num(r.home_rest), away_rest: num(r.away_rest), divisional: num(r.div_game) === 1, home_qb_id: r.home_qb_id || null, away_qb_id: r.away_qb_id || null, stadium: r.stadium || null },
    });
  });
  games.sort((a, b) => a.season - b.season || (a.week || 0) - (b.week || 0) || String(a.id).localeCompare(String(b.id)));
  const played = games.filter((g) => g.margin != null);
  return {
    schema: SCHEMA, version: 1, sport: 'americanfootball_nfl', generated_at: opts.now || new Date().toISOString(),
    source: { url: GAMES_URL, path: path.relative(ROOT, CACHE), retrieved_at: opts.retrieved_at || null, basis: 'nflverse/nfldata games.csv; the spread, total and moneyline columns are the consensus close as nflverse carries them, no book, no capture time' },
    sign_convention: 'close.home_line is the line the HOME side lays (negative = home favoured), i.e. -spread_line; margin is home_score minus away_score; a spread cover for the home side is margin + home_line > 0',
    counts: { games: games.length, played: played.length, seasons: Object.keys(seasons).length, first_season: games.length ? games[0].season : null, last_season: games.length ? games[games.length - 1].season : null },
    seasons, games,
    note: 'A copy of the feed with the sign convention made explicit. It grades nothing and prices nothing; the validation and the scorecard read it.',
  };
}

/* ---------------------------------------------------------------- openers */
/** THE OPENER LEDGER, built by EdgeDesk itself: nflverse carries only a
    closing consensus, so the desk records the FIRST number it sees for every
    upcoming game and every later number until kickoff. Open-to-close value can
    then be graded on the desk's own captures. Nothing is backfilled: a game
    first seen with its result already posted gets no opener. */
function updateOpeners(ledger, art, nowIso) {
  ledger = ledger && ledger.games ? ledger : { schema: 'edgedesk_opener_ledger_v1', sport: 'americanfootball_nfl', started_at: nowIso, games: {} };
  let added = 0, moved = 0;
  art.games.forEach((g) => {
    const num0 = (v) => (v == null ? null : v);
    const snap = { home_line: num0(g.close.home_line), total: num0(g.close.total), home_moneyline: num0(g.close.home_moneyline), away_moneyline: num0(g.close.away_moneyline), seen_at: nowIso };
    const e = ledger.games[g.id];
    if (!e) { if (g.margin != null) return; /* result already posted: no opener can be claimed */ ledger.games[g.id] = { season: g.season, week: g.week, home: g.home, away: g.away, date: g.date, open: snap, latest: snap, moves: 0, closed: false }; added++; return; }
    if (e.closed) return;
    if (g.margin != null) { e.closed = true; e.close = e.latest; return; }
    if (e.latest.home_line !== snap.home_line || e.latest.total !== snap.total) { e.moves++; moved++; }
    e.latest = snap;
  });
  ledger.updated_at = nowIso; ledger.counts = { games: Object.keys(ledger.games).length, closed: Object.values(ledger.games).filter((x) => x.closed).length, added_this_run: added, moved_this_run: moved };
  ledger.note = 'EdgeDesk’s own opener capture from the nflverse consensus feed: open = the first number this build saw, latest = the last, close = the last before the result posted. Coverage starts at started_at; a game seen first with a result gets no opener. Per-book openers for captured signals live in book_quote_ticks.';
  return ledger;
}
function applyOpeners(art, ledger) {
  if (!ledger || !ledger.games) return art;
  art.games.forEach((g) => { const e = ledger.games[g.id]; if (e && e.open) g.open = { home_line: e.open.home_line, total: e.open.total, seen_at: e.open.seen_at, moves: e.moves, source: 'EdgeDesk opener ledger' }; });
  art.counts.with_opener = art.games.filter((g) => g.open).length;
  return art;
}

/* ------------------------------------------------------------------- CFB */
/** THE CFB ARCHIVE with OPENERS: sportsdataverse/cfbfastR-data's line archive
    (2006 on, opening and closing numbers, many books) joined to its schedules
    (result, week, neutral site, pregame Elo). A spread row is stated from ONE
    team's side and named by an abbreviation, so each side is resolved to a
    team id through the teams file, or by elimination when the other side of
    the same game resolved; a row that resolves to neither is dropped, never
    guessed. Duplicate rows are dropped before the medians. Pure. */
function median(a) { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
function buildCfb(texts, opts) {
  opts = opts || {};
  const abbrToId = {};
  R.parseCsv(texts.teams || '', { columns: ['team_id', 'abbreviation'] }).forEach((t) => { if (t.abbreviation && t.team_id) abbrToId[String(t.abbreviation).toUpperCase()] = String(t.team_id); });
  const sched = {};
  Object.keys(texts.schedules || {}).forEach((season) => {
    R.parseCsv(texts.schedules[season], { columns: ['game_id', 'season', 'week', 'season_type', 'start_date', 'completed', 'neutral_site', 'conference_game', 'home_id', 'home_team', 'home_division', 'home_conference', 'home_points', 'home_pregame_elo', 'away_id', 'away_team', 'away_division', 'away_conference', 'away_points', 'away_pregame_elo'] })
      .forEach((g) => { if (g.game_id) sched[String(g.game_id)] = g; });
  });
  const acc = {}; const seen = new Set(); let dupes = 0, unresolved = 0, rows = 0;
  const lineRows = R.parseCsv(texts.lines || '', { columns: ['game_id', 'season', 'market_type', 'abbr', 'lines', 'opening_lines', 'book', 'home_team_id', 'away_team_id'] });
  /* an abbreviation's vocabulary drifts across eras, so it is never string-matched to a school name: each abbreviation
     resolves to the ONE team id that appears in every game it appears in (the intersection), and only then to the teams file */
  const inter = {};
  lineRows.forEach((r) => { if (r.market_type !== 'spread' && r.market_type !== 'money_line') return; const ab = String(r.abbr || '').toUpperCase(); if (!ab) return; const ids = new Set([String(r.home_team_id || ''), String(r.away_team_id || '')]); if (!inter[ab]) inter[ab] = new Set(ids); else inter[ab] = new Set([...inter[ab]].filter((x) => ids.has(x))); });
  const resolved = {}; Object.keys(inter).forEach((ab) => { if (inter[ab].size === 1) resolved[ab] = [...inter[ab]][0]; else if (abbrToId[ab]) resolved[ab] = abbrToId[ab]; });
  lineRows.forEach((r) => {
    const gid = String(r.game_id || ''); if (!gid) return;
    const close = num(r.lines), open = num(r.opening_lines);
    if (close == null && open == null) return;
    const sig = gid + '|' + r.market_type + '|' + r.abbr + '|' + r.book + '|' + close + '|' + open;
    if (seen.has(sig)) { dupes++; return; } seen.add(sig);
    const a = (acc[gid] = acc[gid] || { home_id: String(r.home_team_id || ''), away_id: String(r.away_team_id || ''), sp_open: [], sp_close: [], tot_open: [], tot_close: [], books: new Set(), pending: [] });
    if (r.market_type === 'spread') {
      const ab = String(r.abbr || '').toUpperCase(); const tid = resolved[ab] || null;
      const side = tid === a.home_id ? 1 : tid === a.away_id ? -1 : null;
      if (side == null) { a.pending.push({ ab, close, open, book: r.book }); return; }
      a.books.add(r.book); a._abbr = a._abbr || {}; a._abbr[ab] = side;
      if (close != null) a.sp_close.push(side * close); if (open != null) a.sp_open.push(side * open); rows++;
    } else if (r.market_type === 'total') {
      const s2 = String(r.abbr || '').toLowerCase(); if (s2 !== 'over' && s2 !== 'under') return;
      if (close != null) a.tot_close.push(close); if (open != null) a.tot_open.push(open); rows++;
    }
  });
  /* resolve by elimination: an unresolved abbreviation in a game whose other side resolved is the other side */
  Object.keys(acc).forEach((gid) => { const a = acc[gid]; if (!a.pending.length) return; const known = a._abbr || {}; const knownAbbrs = Object.keys(known); a.pending.forEach((p) => { if (knownAbbrs.length === 1 && p.ab !== knownAbbrs[0]) { const side = -known[knownAbbrs[0]]; if (p.close != null) a.sp_close.push(side * p.close); if (p.open != null) a.sp_open.push(side * p.open); a.books.add(p.book); rows++; } else unresolved++; }); a.pending = []; });
  const games = []; const seasons = {};
  Object.keys(acc).forEach((gid) => {
    const a = acc[gid]; if (!a.sp_close.length && !a.sp_open.length) return;
    const g = sched[gid]; if (!g) { unresolved++; return; }
    const season = num(g.season); if (season == null) return;
    const s = (seasons[season] = seasons[season] || { games: 0, with_open: 0, with_close: 0, played: 0 });
    const hp = num(g.home_points), ap = num(g.away_points), margin = hp != null && ap != null ? hp - ap : null;
    const row = { id: gid, season, week: num(g.week), type: g.season_type || null, date: g.start_date ? String(g.start_date).slice(0, 10) : null, kickoff: g.start_date || null, neutral: /true/i.test(String(g.neutral_site)), conference_game: /true/i.test(String(g.conference_game)),
      home: g.home_team, away: g.away_team, home_id: String(g.home_id || a.home_id), away_id: String(g.away_id || a.away_id), home_division: g.home_division || null, away_division: g.away_division || null, home_points: hp, away_points: ap, margin, points: hp != null && ap != null ? hp + ap : null,
      open: { home_line: median(a.sp_open), total: median(a.tot_open), books: a.sp_open.length }, close: { home_line: median(a.sp_close), total: median(a.tot_close), books: a.sp_close.length },
      ctx: { home_pregame_elo: num(g.home_pregame_elo), away_pregame_elo: num(g.away_pregame_elo), home_conference: g.home_conference || null, away_conference: g.away_conference || null } };
    s.games++; if (row.open.home_line != null) s.with_open++; if (row.close.home_line != null) s.with_close++; if (margin != null) s.played++;
    games.push(row);
  });
  games.sort((x, y) => x.season - y.season || (x.week || 0) - (y.week || 0) || String(x.id).localeCompare(String(y.id)));
  const seasonList = Object.keys(seasons).map(Number);
  return { schema: SCHEMA, version: 1, sport: 'americanfootball_ncaaf', generated_at: opts.now || new Date().toISOString(),
    source: { lines: CFB_RAW + '/betting/csv/cfb_line_odds.csv.gz', schedules: CFB_RAW + '/schedules/csv/cfb_schedules_<season>.csv', teams: CFB_RAW + '/teams/teams_colors_logos.csv', retrieved_at: opts.retrieved_at || null, basis: 'sportsdataverse/cfbfastR-data: opening_lines and lines per book, medians across books per game after exact duplicates are dropped; a spread row is stated from the named side and resolved to home-relative by the abbreviation\u2019s data-derived team id (the one id present in every game it appears in), then the teams file, then elimination against the other side; schedules supply the result, week, neutral site and pregame Elo' },
    sign_convention: 'open.home_line and close.home_line are the line the HOME side lays (negative = home favoured); margin is home_points minus away_points; a home cover is margin + home_line > 0',
    counts: { games: games.length, with_open: games.filter((g) => g.open.home_line != null).length, with_close: games.filter((g) => g.close.home_line != null).length, played: games.filter((g) => g.margin != null).length, seasons: seasonList.length, first_season: seasonList.length ? Math.min(...seasonList) : null, last_season: seasonList.length ? Math.max(...seasonList) : null, line_rows: rows, duplicates_dropped: dupes, unresolved_dropped: unresolved },
    seasons, games, note: 'A copy of the archive with the sign convention explicit. It prices nothing; the movement validation and the scorecard read it.' };
}
async function ensureCfb(offline) {
  fs.mkdirSync(CFB_CACHE, { recursive: true });
  const get = async (name, url, maxAge) => { const p = path.join(CFB_CACHE, name); if (fs.existsSync(p) && (offline || (maxAge && Date.now() - fs.statSync(p).mtimeMs < maxAge))) return fs.readFileSync(p); if (offline) return null; try { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(p, b); return b; } catch (e) { console.error('could not fetch ' + name + ': ' + e.message + (fs.existsSync(p) ? ' (cached copy kept)' : '')); return fs.existsSync(p) ? fs.readFileSync(p) : null; } };
  const now = new Date().getUTCFullYear();
  const linesGz = await get('cfb_line_odds.csv.gz', CFB_RAW + '/betting/csv/cfb_line_odds.csv.gz', 6 * 3600000);
  const teams = await get('teams_colors_logos.csv', CFB_RAW + '/teams/teams_colors_logos.csv', 30 * 86400000);
  const schedules = {};
  for (let s = CFB_FIRST; s <= now; s++) { const b = await get('cfb_schedules_' + s + '.csv', CFB_RAW + '/schedules/csv/cfb_schedules_' + s + '.csv', s >= now - 1 ? 6 * 3600000 : 365 * 86400000); if (b) schedules[s] = b.toString('utf8'); }
  return { lines: linesGz ? zlib.gunzipSync(linesGz).toString('utf8') : '', teams: teams ? teams.toString('utf8') : '', schedules };
}
function cfbOpeners(art) {
  const season = art.counts.last_season; const games = {};
  art.games.filter((g) => g.season === season).forEach((g) => { games[g.id] = { home: g.home, away: g.away, week: g.week, kickoff: g.kickoff, open: g.open, close: g.margin != null ? g.close : null, latest: g.close, closed: g.margin != null }; });
  return { schema: 'edgedesk_opener_ledger_v1', sport: 'americanfootball_ncaaf', season, updated_at: art.generated_at, source: 'football/pricing/lines_cfb.json (sportsdataverse archive: opening and current numbers per game)', counts: { games: Object.keys(games).length, closed: Object.values(games).filter((x) => x.closed).length }, games, note: 'The current season’s openers from the archive, compact, so the edge function can read where a number opened without the whole archive. latest is the archive’s current number; close is set once the result is on file.' };
}
async function mainCfb(args) {
  const texts = await ensureCfb(args.includes('--offline'));
  const art = buildCfb(texts, { retrieved_at: new Date().toISOString() });
  const c = art.counts;
  console.log(`cfb lines archive: ${c.games} games (${c.with_open} with an opener, ${c.with_close} with a close, ${c.played} played), seasons ${c.first_season}-${c.last_season}; ${c.duplicates_dropped} duplicate rows and ${c.unresolved_dropped} unresolved rows dropped`);
  if (args.includes('--check')) { if (!fs.existsSync(CFB_OUT)) { console.error('CHECK: no artifact'); process.exit(1); } const prev = JSON.parse(fs.readFileSync(CFB_OUT, 'utf8')); const same = JSON.stringify(prev.games.filter((g) => g.season < c.last_season)) === JSON.stringify(art.games.filter((g) => g.season < c.last_season)); console.log(same ? 'CHECK: artifact is current (past seasons)' : 'CHECK: artifact differs from a fresh build'); process.exit(same ? 0 : 1); }
  fs.writeFileSync(CFB_OUT, JSON.stringify(art)); console.log('wrote ' + path.relative(ROOT, CFB_OUT) + ' (' + Math.round(fs.statSync(CFB_OUT).size / 1024) + ' KB)');
  fs.writeFileSync(CFB_OPENERS, JSON.stringify(cfbOpeners(art), null, 1)); console.log('wrote ' + path.relative(ROOT, CFB_OPENERS));
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--sport') && args[args.indexOf('--sport') + 1] === 'cfb') return mainCfb(args).catch((e) => { console.error(e.stack || e); process.exit(2); });
  if (!fs.existsSync(CACHE) || args.includes('--fetch')) {
    if (args.includes('--check')) { console.error('CHECK: the games.csv cache is absent; nothing to compare'); process.exit(1); }
    return fetch(GAMES_URL, { redirect: 'follow' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }).then((t) => { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, t); write(args); }).catch((e) => { console.error('fetch failed: ' + e.message); process.exit(1); });
  }
  write(args);
}
function write(args) {
  let art = build(fs.readFileSync(CACHE, 'utf8'), { retrieved_at: new Date(fs.statSync(CACHE).mtimeMs).toISOString() });
  let ledger = null; try { ledger = JSON.parse(fs.readFileSync(OPENERS, 'utf8')); } catch (_) { ledger = null; }
  if (!args.includes('--check')) { ledger = updateOpeners(ledger, art, new Date().toISOString()); fs.mkdirSync(path.dirname(OPENERS), { recursive: true }); fs.writeFileSync(OPENERS, JSON.stringify(ledger, null, 1)); console.log('opener ledger: ' + ledger.counts.games + ' games (' + ledger.counts.added_this_run + ' new, ' + ledger.counts.moved_this_run + ' moved, ' + ledger.counts.closed + ' closed)'); }
  art = applyOpeners(art, ledger);
  const c = art.counts;
  console.log(`lines archive: ${c.games} NFL games with a close, ${c.played} played, seasons ${c.first_season}-${c.last_season}`);
  if (args.includes('--check')) {
    if (!fs.existsSync(OUT)) { console.error('CHECK: no artifact on disk'); process.exit(1); }
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const strip = (gs) => JSON.stringify(gs.map((g) => Object.assign({}, g, { open: undefined })));
    const same = strip(prev.games) === strip(art.games);
    console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(art));
  console.log('wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}

module.exports = { build, buildCfb, cfbOpeners, updateOpeners, applyOpeners, SCHEMA, OUT, OPENERS, CFB_OUT, CFB_OPENERS, CACHE, GAMES_URL, COLS };
if (require.main === module) main();
