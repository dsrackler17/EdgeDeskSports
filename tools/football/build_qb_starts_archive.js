#!/usr/bin/env node
/* ===========================================================================
   THE QUARTERBACK-START ARCHIVE — who started each NFL game (2006 on) and
   what he did with the ball, so the replays can feed the engine's
   quarterback layer (football/engine.js nfl.absorbGame qbStarts) instead of
   an empty list.

   Per played game, per side:
     the LISTED STARTER   nflverse/nfldata games.csv home_qb_id / away_qb_id
                          (GSIS ids), the id the engine already predicts with
     his passing line     that player's stats_player_week row for the game
                          (position QB): [id, attempts, sacks_suffered,
                          passing_epa]; [id] alone when he has no QB line
     the TOP PASSER       only when it is someone else: the QB with the most
                          dropbacks for the club in that game, the passer
                          research/train_nfl.py credits (ht / at)
   The pass deviation itself is NOT stored: it is measured against the
   league mean at the moment the game is absorbed, which is replay state
   (football/engine.js nfl.qbPassDev, mirroring train_nfl.py).

   A CONFIRMED-STARTER SCENARIO, NOT A PREGAME FACT. nflverse records the
   starter after the game and carries no announcement time, so a replay that
   reads this archive measures what the layer is worth when the starter is
   known. It does not certify that the starter was known before kickoff.

   Usage
     node tools/football/build_qb_starts_archive.js            # fetches games.csv and missing / current seasons
     node tools/football/build_qb_starts_archive.js --offline  # cache and committed copy only
     node tools/football/build_qb_starts_archive.js --fetch    # refresh games.csv first
     node tools/football/build_qb_starts_archive.js --check
   A past season with no cached player-week file keeps its committed records
   when they already hold every game of it that was played, so a fresh
   checkout downloads only the season in progress.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'football', 'data', 'recovery.js'));
const LINES = require(path.join(__dirname, 'build_lines_archive.js'));
const { writeIfChanged } = require(path.join(__dirname, 'write_if_changed.js'));

const SCHEMA = 'edgedesk_nfl_qb_starts_v1';
const CACHE = path.join(ROOT, 'football', 'nfl', '.cache');
const URL = (s) => 'https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_' + s + '.csv';
const FILE = (s) => path.join(CACHE, URL(s).replace(/[^a-z0-9.]+/gi, '_').slice(-120));
const OUT = path.join(ROOT, 'football', 'pricing', 'qb_starts_nfl.json');
const FIRST = 2006;
const CURRENT_MAX_AGE_MS = 6 * 3600e3;
const GAME_COLS = ['game_id', 'season', 'home_team', 'away_team', 'home_score', 'away_score', 'home_qb_id', 'away_qb_id'];
const SPW_COLS = ['player_id', 'position', 'game_id', 'team', 'attempts', 'sacks_suffered', 'passing_epa'];
/* franchise continuity, as research/build_features.py maps it: the player feed
   carries today's code for every season, games.csv the code of the day */
const FRANCHISE = { STL: 'LA', SD: 'LAC', OAK: 'LV' };
const franchise = (t) => FRANCHISE[t] || t;

/** The passer lines of one season's stats_player_week text, by game: QB rows with a dropback, file order kept. */
function passerLines(text) {
  const byGame = {};
  R.parseCsv(text, { columns: SPW_COLS }).forEach((r) => {
    if (r.position !== 'QB' || !r.game_id || !r.player_id) return;
    const att = R.NUM(r.attempts), sk = R.NUM(r.sacks_suffered);
    if (att == null || sk == null || !(att + sk > 0)) return;
    (byGame[r.game_id] = byGame[r.game_id] || []).push({ id: r.player_id, team: franchise(r.team), line: [r.player_id, att, sk, R.NUM(r.passing_epa)] });
  });
  return byGame;
}

/** Build from games.csv text and {season: stats_player_week text}. Seasons in opts.keep come from opts.prev untouched. Pure. */
function build(gamesText, spwTexts, opts) {
  opts = opts || {};
  const keep = new Set((opts.keep || []).map(Number));
  const lines = {};
  Object.keys(spwTexts).forEach((s) => Object.assign(lines, passerLines(spwTexts[s])));
  const games = {}; const seasons = {};
  const count = { sides: 0, listed: 0, with_line: 0, under_10_dropbacks: 0, not_top_passer: 0 };
  const tally = (rec) => ['h', 'a'].forEach((k) => {
    count.sides++; const l = rec[k]; if (!l) return; count.listed++;
    if (l.length >= 4) { count.with_line++; if (l[1] + l[2] < 10) count.under_10_dropbacks++; }
    if (rec[k + 't']) count.not_top_passer++;
  });
  const prevGames = (opts.prev && opts.prev.games) || {};
  Object.keys(prevGames).forEach((id) => {
    const s = Number(id.slice(0, 4)); if (!keep.has(s)) return;
    games[id] = prevGames[id]; seasons[s] = (seasons[s] || 0) + 1; tally(prevGames[id]);
  });
  R.parseCsv(String(gamesText || ''), { columns: GAME_COLS }).forEach((g) => {
    const s = R.NUM(g.season);
    if (s == null || s < FIRST || keep.has(s) || spwTexts[s] == null) return;
    if (R.NUM(g.home_score) == null || R.NUM(g.away_score) == null) return; /* the archive is of games that were played */
    const passers = lines[g.game_id] || [];
    const rec = {};
    [['h', g.home_team, g.home_qb_id], ['a', g.away_team, g.away_qb_id]].forEach(([k, team, qbId]) => {
      const listed = qbId && qbId !== 'NA' ? qbId : null;
      const own = listed ? passers.find((p) => p.id === listed) : null;
      rec[k] = listed ? (own ? own.line : [listed]) : null;
      /* train_nfl.py's choice: the club's QB with the most dropbacks, the first on a tie */
      let top = null; passers.forEach((p) => { if (p.team === franchise(team) && (!top || p.line[1] + p.line[2] > top.line[1] + top.line[2])) top = p; });
      if (top && top.id !== listed) rec[k + 't'] = top.line;
    });
    games[g.game_id] = rec; seasons[s] = (seasons[s] || 0) + 1; tally(rec);
  });
  const ordered = {}; Object.keys(games).sort().forEach((id) => { ordered[id] = games[id]; });
  const list = Object.keys(seasons).map(Number).sort((a, b) => a - b);
  return {
    schema: SCHEMA, version: 1, sport: 'americanfootball_nfl', generated_at: opts.now || new Date().toISOString(),
    source: { games: { url: LINES.GAMES_URL, columns: 'home_qb_id / away_qb_id (GSIS)', retrieved_at: opts.retrieved_at || null }, player_week: { url_pattern: URL('<season>'), columns: SPW_COLS.join(', ') } },
    scenario: 'CONFIRMED_STARTER',
    scenario_basis: 'nflverse records the starting quarterback after the game and carries no announcement time. A replay that reads this archive measures the quarterback layer as if the starter were known; it does not certify that he was known before kickoff.',
    rule: { line: '[player_id, attempts, sacks_suffered, passing_epa] from stats_player_week, position QB; [player_id] alone when the listed starter has no QB line in the game; null when games.csv lists no starter',
      top_passer: 'h/a is the LISTED starter; ht/at, present only when it is someone else, is the club QB with the most dropbacks in the game, the passer research/train_nfl.py credits',
      pass_dev: 'computed at absorb time, not stored: passing_epa / (attempts + sacks_suffered) minus the league pass_epa_db mean before the game, none under 10 dropbacks (football/engine.js nfl.qbPassDev, mirroring research/train_nfl.py)' },
    counts: Object.assign({ games: Object.keys(ordered).length, first_season: list.length ? list[0] : null, last_season: list.length ? list[list.length - 1] : null }, count),
    seasons, games: ordered,
    note: 'Who started and what he threw for, copied. The replays read it to exercise the quarterback layer; whether that layer earns a place in a published number is decided by football/validation/pricing_nfl.json (qb_layer), not here.',
  };
}

/** qbStarts for E.nfl.absorbGame from one archive record, home first. rule 'top_passer' credits train_nfl.py's passer instead of the listed starter. */
function startsFor(E, st, rec, home, away, rule) {
  if (!rec) return [];
  const out = [];
  [[home, 'h'], [away, 'a']].forEach(([team, k]) => {
    const line = rule === 'top_passer' && rec[k + 't'] ? rec[k + 't'] : rec[k];
    if (!line || !line[0]) return;
    out.push([team, line[0], line.length >= 4 ? E.nfl.qbPassDev(st, line[3], line[1] + line[2]) : null]);
  });
  return out;
}

function readArchive(file) { try { return JSON.parse(fs.readFileSync(file || OUT, 'utf8')); } catch (_) { return null; } }

async function fetchTo(url, file) {
  const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status);
  const t = await r.text(); if (t.length < 100) throw new Error('empty body');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, t); return t;
}

async function main() {
  const args = process.argv.slice(2); const offline = args.includes('--offline');
  if (!offline && (args.includes('--fetch') || !fs.existsSync(LINES.CACHE))) {
    try { await fetchTo(LINES.GAMES_URL, LINES.CACHE); console.log('fetched games.csv'); } catch (e) { console.error('could not fetch games.csv: ' + e.message); }
  }
  if (!fs.existsSync(LINES.CACHE)) { console.error('no games.csv in ' + path.relative(ROOT, LINES.CACHE) + '; nothing built'); process.exit(3); }
  const gamesText = fs.readFileSync(LINES.CACHE, 'utf8');
  const played = {}; R.parseCsv(gamesText, { columns: ['season', 'home_score'] }).forEach((g) => { const s = R.NUM(g.season); if (s != null && R.NUM(g.home_score) != null) played[s] = (played[s] || 0) + 1; });
  const last = Math.max(...Object.keys(played).map(Number));
  /* a past season is kept from the committed copy only when that copy already has every game of it that was played */
  const prev = readArchive(); const prevSeasons = new Set(Object.keys((prev && prev.seasons) || {}).map(Number).filter((s) => prev.seasons[s] >= (played[s] || 0)));
  const texts = {}; const keep = []; const missing = [];
  for (let s = FIRST; s <= last; s++) {
    const f = FILE(s); const stale = s === last && fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs > CURRENT_MAX_AGE_MS;
    if (!offline && (!fs.existsSync(f) ? (s === last || !prevSeasons.has(s)) : stale)) {
      try { await fetchTo(URL(s), f); console.log('fetched stats_player_week_' + s + '.csv'); } catch (e) { console.error('stats_player_week_' + s + '.csv: ' + e.message); }
    }
    if (fs.existsSync(f)) texts[s] = fs.readFileSync(f, 'utf8');
    else if (prevSeasons.has(s)) keep.push(s);
    else missing.push(s);
  }
  if (missing.length) console.error('no player-week file and no committed records for ' + missing.join(', ') + ': those seasons are absent from the archive');
  const art = build(gamesText, texts, { prev, keep, retrieved_at: new Date(fs.statSync(LINES.CACHE).mtimeMs).toISOString() });
  const c = art.counts;
  console.log(`qb-start archive: ${c.first_season}-${c.last_season}, ${c.games} games; ${c.with_line}/${c.sides} sides with the listed starter's line, ${c.under_10_dropbacks} under 10 dropbacks, ${c.not_top_passer} where he was not the top passer` + (keep.length ? '; kept from the committed copy: ' + keep.join(', ') : ''));
  if (args.includes('--check')) {
    if (!prev) { console.error('CHECK: no artifact'); process.exit(1); }
    const same = JSON.stringify(prev.games) === JSON.stringify(art.games); console.log(same ? 'CHECK: artifact is current' : 'CHECK: artifact differs from a fresh build'); process.exit(same ? 0 : 1);
  }
  console.log(writeIfChanged(OUT, art) + ' ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
}

module.exports = { build, passerLines, startsFor, readArchive, franchise, SCHEMA, OUT, FILE, URL, FIRST };
if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(2); });
