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
     node tools/football/build_lines_archive.js            # from the cached feed
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

function main() {
  const args = process.argv.slice(2);
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

module.exports = { build, updateOpeners, applyOpeners, SCHEMA, OUT, OPENERS, CACHE, GAMES_URL, COLS };
if (require.main === module) main();
