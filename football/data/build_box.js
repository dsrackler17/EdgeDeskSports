#!/usr/bin/env node
/* ============================================================================
   THE BOX-SCORE ENRICHMENT INGEST.

   WHAT THIS ADDS THAT EDGEDESK DID NOT HAVE, AND A CORRECTION.

   football/players/config.js shipped asserting that tackles, tackles for loss,
   run stops, pressures short of a sack and punting were "not observed at all"
   in any public feed. That was an assumption, it was not checked hard enough,
   and it is WRONG. The sportsdataverse ESPN player-box release is public,
   keyless, and keyed on the same ESPN `athlete_id` this repo already uses as
   its identity backbone, and it carries per player, per game:

       totalTackles  soloTackles  tacklesForLoss  sacks
       passesDefended  hurries  interceptions
       punts / puntYards / puntsInside20 / touchbacks
       field goals, kick and punt returns, and ESPN's adjusted QBR

   `hurries` in particular is a PRESSURE SHORT OF A SACK, which the player
   layer explicitly declared unobservable. It is observable. This file ingests
   it, and the observability contract has been corrected to match.

   THE CATCH, MEASURED RATHER THAN ASSUMED. The defensive columns have the same
   season-scale coverage ramp the play-attribution table has. Counted per
   team-game against what an FBS team really produces:

       season  tackles   TFL   sacks   PBU  hurries  punts
       2019       1.71  0.16    0.05  0.08     0.05   4.76
       2022       5.17  0.50    0.20  0.29     0.18   4.51
       2023      33.76  2.89    1.10  1.69     1.35   4.35
       2024      62.39  5.30    1.94  2.98     2.43   4.16
       2025      64.69  5.32    1.95  3.13     2.71   4.14
       2026      63.13  4.92    1.71  2.79     2.47   4.79

   So the defensive columns are usable from 2024 and are NOT usable before it,
   while punting has been usable throughout. Every season is gated against a
   floor on every run, the counts ship inside the artifact, and a season that
   fails a gate has that metric DECLARED MISSING rather than read as a league
   of defences that never made a tackle.

     node football/data/build_box.js [--season 2026] [--seasons 3] [--cache DIR]
                                     [--dry] [--quiet]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const B = require('../players/build_players.js');
const EPIR = require('../players/epir.js');

const DIR = __dirname;
const OUT = path.join(DIR, 'box');
const PY_HELPER = path.join(DIR, 'tools', 'parquet_to_csv.py');
const REL = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box';
const TEAMS_CSV = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/teams/teams_colors_logos.csv';

function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const DRY = !!arg('dry', false);
const CACHE = arg('cache', process.env.EDP_CACHE || '') || null;
function log(...a) { if (!QUIET) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }
const SEASON = +(arg('season', defaultSeason()));
const SEASONS_BACK = +(arg('seasons', 3));

/* ------------------------------------------------------------------ *
 * COVERAGE GATES — per team-game, against what football actually is.  *
 * Deliberately generous: they catch a feed that has not filled a       *
 * column in, not a quiet season.                                      *
 * ------------------------------------------------------------------ */
const GATES = {
  tackles:        { field: 'tackles',    per_team_game_min: 40.0, basis: 'an FBS team makes 60-70 tackles a game. Below 40 the column is being filled in for some games and not others.' },
  solo_tackles:   { field: 'solo',       per_team_game_min: 20.0, basis: 'roughly half of all tackles are solo' },
  tackles_for_loss:{ field: 'tfl',       per_team_game_min: 3.0,  basis: 'an FBS team records 5-6 tackles for loss a game' },
  sacks:          { field: 'sacks',      per_team_game_min: 1.2,  basis: 'an FBS team records about 2 sacks a game' },
  passes_defended:{ field: 'pbu',        per_team_game_min: 1.8,  basis: 'an FBS team records about 3 passes defended a game' },
  hurries:        { field: 'hurries',    per_team_game_min: 1.2,  basis: 'hurries run 2-3 per team-game where the column is filled. This is a PRESSURE SHORT OF A SACK — the thing the player layer used to declare unobservable.' },
  interceptions:  { field: 'ints',       per_team_game_min: 0.55, basis: 'FBS interception rate is around 0.8 per team-game' },
  punting:        { field: 'punts',      per_team_game_min: 2.5,  basis: 'an FBS team punts 4-5 times a game' },
  field_goals:    { field: 'fg_att',     per_team_game_min: 0.8,  basis: 'an FBS team attempts about 1.5 field goals a game' },
  qbr:            { field: 'qbr_games',  per_team_game_min: 0.5,  basis: 'one rated quarterback per team-game is the most there can be' }
};

/* ------------------------------------------------------------------ */
async function fetchBuf(url, cacheName) {
  if (CACHE && cacheName) {
    const p = path.join(CACHE, cacheName);
    if (fs.existsSync(p) && fs.statSync(p).size > 64) return fs.readFileSync(p);
  }
  let last = null;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (CACHE && cacheName) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, cacheName), buf); }
      return buf;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 800 * Math.pow(2, a))); }
  }
  throw new Error(`${url}: ${last && last.message}`);
}

/* A season arrives as .csv.gz once it is complete and as .parquet while it is
   in progress. The season in progress is the one the ratings most need, so
   both are supported — CSV first because it needs nothing installed. */
async function loadSeasonCsv(season) {
  try {
    const gz = await fetchBuf(`${REL}/player_box_${season}.csv.gz`, `player_box_${season}.csv.gz`);
    return { text: zlib.gunzipSync(gz).toString('utf8'), format: 'csv.gz' };
  } catch (e) {
    log(`    ${season}: no csv.gz (${e.message.slice(0, 60)}) — trying parquet`);
  }
  try {
    const pq = await fetchBuf(`${REL}/player_box_${season}.parquet`, `player_box_${season}.parquet`);
    const tmp = path.join(CACHE || require('os').tmpdir(), `player_box_${season}.parquet`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, pq);
    const text = execFileSync('python3', [PY_HELPER, tmp], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
    return { text, format: 'parquet (converted with pyarrow)' };
  } catch (e) {
    return { text: null, format: null, error: e.message };
  }
}

function numOf(v) {
  if (v == null || v === '' || v === 'NA' || v === 'null') return 0;
  const n = +v;
  return isFinite(n) ? n : 0;
}
/* ESPN publishes some box fields as "made/attempts". Split, never guessed. */
function pair(v) {
  if (v == null || v === '' || v === 'NA') return [0, 0];
  const s = String(v).split('/');
  return [numOf(s[0]), numOf(s[1])];
}

function blank() {
  return { games: {}, tackles: 0, solo: 0, tfl: 0, sacks: 0, pbu: 0, hurries: 0, ints: 0,
    int_yds: 0, def_td: 0, fum_lost: 0, fum_rec: 0,
    punts: 0, punt_yds: 0, punts_in20: 0, touchbacks: 0, long_punt: 0,
    fg_made: 0, fg_att: 0, xp_made: 0, xp_att: 0, kick_points: 0,
    qbr_sum: 0, qbr_games: 0,
    rush_att: 0, rec: 0, pass_att: 0 };
}

async function ingestSeason(season, teamName) {
  const got = await loadSeasonCsv(season);
  if (!got.text) return { season, available: false, reason: 'neither a csv.gz nor a parquet player box loaded for ' + season + ': ' + got.error };
  const text = got.text;
  const nl = text.indexOf('\n');
  const ix = B.headerIndex(text.slice(0, nl));
  const need = ['athlete_id', 'game_id', 'team_id', 'season'];
  for (const k of need) if (ix[k] == null) return { season, available: false, reason: 'player box is missing column ' + k };

  const players = new Map(), teams = new Map(), teamGames = new Set();
  const names = new Map();
  let rows = 0;
  let pos = nl + 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos); if (end < 0) end = text.length;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    const r = B.splitLine(line);
    const aid = r[ix.athlete_id], gid = r[ix.game_id], tid = r[ix.team_id];
    if (!aid || !gid || !tid) continue;
    rows++;
    teamGames.add(gid + '|' + tid);
    if (!names.has(aid) && ix.athlete_name != null) names.set(aid, r[ix.athlete_name]);

    const targets = [];
    let P = players.get(aid);
    if (!P) { P = blank(); P.team_id = tid; players.set(aid, P); }
    P.team_id = tid;
    targets.push(P);
    let T = teams.get(tid);
    if (!T) { T = blank(); teams.set(tid, T); }
    targets.push(T);

    const fg = pair(r[ix['fieldGoalsMade/fieldGoalAttempts']]);
    const xp = pair(r[ix['extraPointsMade/extraPointAttempts']]);
    const cmp = pair(r[ix['completions/passingAttempts']]);
    for (const X of targets) {
      X.games[gid] = 1;
      X.tackles += numOf(r[ix.totalTackles]);
      X.solo += numOf(r[ix.soloTackles]);
      X.tfl += numOf(r[ix.tacklesForLoss]);
      X.sacks += numOf(r[ix.sacks]);
      X.pbu += numOf(r[ix.passesDefended]);
      X.hurries += numOf(r[ix.hurries]);
      X.ints += numOf(r[ix.interceptions]);
      X.int_yds += numOf(r[ix.interceptionYards]);
      X.def_td += numOf(r[ix.defensiveTouchdowns]);
      X.fum_lost += numOf(r[ix.fumblesLost]);
      X.fum_rec += numOf(r[ix.fumblesRecovered]);
      X.punts += numOf(r[ix.punts]);
      X.punt_yds += numOf(r[ix.puntYards]);
      X.punts_in20 += numOf(r[ix.puntsInside20]);
      X.touchbacks += numOf(r[ix.touchbacks]);
      X.long_punt = Math.max(X.long_punt, numOf(r[ix.longPunt]));
      X.fg_made += fg[0]; X.fg_att += fg[1];
      X.xp_made += xp[0]; X.xp_att += xp[1];
      X.kick_points += numOf(r[ix.totalKickingPoints]);
      X.rush_att += numOf(r[ix.rushingAttempts]);
      X.rec += numOf(r[ix.receptions]);
      X.pass_att += cmp[1];
      const q = r[ix.adjQBR];
      if (q != null && q !== '' && q !== 'NA' && isFinite(+q)) { X.qbr_sum += +q; X.qbr_games += 1; }
    }
  }

  const tgCount = teamGames.size;
  const teamTotals = blank();
  for (const T of teams.values()) {
    for (const k of Object.keys(teamTotals)) {
      if (k === 'games' || k === 'team_id') continue;
      teamTotals[k] += T[k] || 0;
    }
  }
  const coverage = {};
  for (const id of Object.keys(GATES)) {
    const g = GATES[id];
    const total = teamTotals[g.field] || 0;
    const per = tgCount > 0 ? total / tgCount : 0;
    const usable = per >= g.per_team_game_min;
    coverage[id] = {
      usable, observed: Math.round(total), per_team_game: Math.round(per * 1000) / 1000,
      floor: g.per_team_game_min, basis: g.basis,
      reason: usable ? null
        : `the ${id.replace(/_/g, ' ')} column is producing only ${(Math.round(per * 100) / 100)} per team-game in ${season}, below the ${g.per_team_game_min} floor. The feed has not filled this column in for this season, so every measure that depends on it is DECLARED MISSING rather than read as a league that never did it.`
    };
  }
  return { season, available: true, format: got.format, rows, team_games: tgCount,
    coverage, players, teams, names };
}

/* ------------------------------------------------------------------ */
async function main() {
  const seasons = [];
  for (let y = SEASON - SEASONS_BACK + 1; y <= SEASON; y++) seasons.push(y);
  log(`EdgeDesk box-score enrichment — seasons ${seasons[0]}..${SEASON}`);

  /* ESPN team ids to the team key the rest of the repo joins on */
  let idToKey = {}, idToName = {};
  try {
    const t = (await fetchBuf(TEAMS_CSV, 'teams_colors_logos.csv')).toString('utf8');
    for (const row of B.parseCsvObjects(t)) {
      if (!row.team_id || !row.school) continue;
      idToKey[String(row.team_id)] = EPIR.teamKey(row.school);
      idToName[String(row.team_id)] = row.school;
    }
  } catch (e) {
    console.error('could not load the team id map: ' + e.message);
    return 1;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  const summary = {};
  for (const y of seasons) {
    const s = await ingestSeason(y, idToName);
    if (!s.available) { log(`  ${y}: ${s.reason}`); summary[y] = { available: false, reason: s.reason }; continue; }
    const usable = Object.keys(s.coverage).filter(k => s.coverage[k].usable);
    log(`  ${y}: ${s.rows} box rows, ${s.team_games} team-games, ${s.players.size} players (${s.format})`);
    log(`      usable columns: ${usable.join(', ') || 'none'}`);
    const failed = Object.keys(s.coverage).filter(k => !s.coverage[k].usable);
    if (failed.length) log(`      DECLARED MISSING: ${failed.join(', ')}`);

    /* compact per-player rows keyed on the SAME player key the player layer
       uses, so the join is by stable athlete id and nothing is name-matched */
    const players = {};
    for (const [aid, P] of s.players) {
      const key = 'a:' + aid;
      const games = Object.keys(P.games).length;
      const row = [games, P.tackles, P.solo, P.tfl, P.sacks, P.pbu, P.hurries, P.ints,
        P.punts, P.punt_yds, P.punts_in20, P.fg_made, P.fg_att,
        P.qbr_games ? Math.round((P.qbr_sum / P.qbr_games) * 10) / 10 : null, P.qbr_games,
        P.fum_lost, P.def_td];
      /* a row of nothing but an appearance is still information — it is
         PARTICIPATION, which this repo previously had no direct measure of */
      players[key] = row;
      if (idToKey[P.team_id]) players[key].push(idToKey[P.team_id]);
    }
    const teams = {};
    for (const [tid, T] of s.teams) {
      const key = idToKey[tid];
      if (!key) continue;
      teams[key] = { team_games: Object.keys(T.games).length,
        tackles: T.tackles, solo: T.solo, tfl: T.tfl, sacks: T.sacks, pbu: T.pbu,
        hurries: T.hurries, ints: T.ints, punts: T.punts, punt_yds: T.punt_yds,
        punts_in20: T.punts_in20, fg_made: T.fg_made, fg_att: T.fg_att, def_td: T.def_td };
    }
    const artifact = {
      schema: 'edgedesk_box_enrichment_v1',
      season: y, generated_at: new Date().toISOString(),
      source: {
        name: 'sportsdataverse-data ESPN college-football player box',
        url: `${REL}/player_box_${y}.csv.gz`,
        format: s.format, tier: 'public, keyless, GitHub release asset',
        identity: 'ESPN athlete_id — the same backbone football/players/ already joins on, so nothing here is name-matched'
      },
      rows: s.rows, team_games: s.team_games, player_count: Object.keys(players).length,
      coverage: s.coverage,
      columns: ['games', 'tackles', 'solo_tackles', 'tackles_for_loss', 'sacks', 'passes_defended',
        'hurries', 'interceptions', 'punts', 'punt_yards', 'punts_inside_20', 'fg_made', 'fg_att',
        'qbr_mean', 'qbr_games', 'fumbles_lost', 'defensive_touchdowns', 'team_key'],
      note: 'games is the count of distinct games this player appeared in the box score for. It is DIRECT PARTICIPATION evidence — not a snap count, which no public feed carries, but a far better role signal than touch share alone.',
      players, teams
    };
    const file = path.join(OUT, `${y}.json`);
    if (!DRY) writeIfChanged(file, JSON.stringify(artifact));
    written.push(file);
    summary[y] = { available: true, format: s.format, rows: s.rows, team_games: s.team_games,
      players: Object.keys(players).length,
      usable_columns: usable, failed_columns: failed };
  }

  const manifest = {
    schema: 'edgedesk_box_enrichment_manifest_v1',
    generated_at: new Date().toISOString(),
    seasons: summary, current_season: SEASON,
    gates: GATES,
    correction: 'football/players/config.js previously asserted that tackles, tackles for loss, run stops, pressures short of a sack and punting were not observed in any public feed. They are, in this one, keyed on the same athlete id. That contract has been corrected rather than left standing.',
    limits: [
      'The defensive columns are only usable from 2024 onward — earlier seasons are measured, fail their gate, and are declared missing.',
      'MISSED TACKLES are still not carried anywhere public, so a tackling-efficiency measure remains impossible.',
      'A hurry is ESPN’s own charting judgement, not a tracked event, so it is a pressure PROXY and is labelled one.',
      'The box has no snap counts. Appearances are participation evidence; they are not snaps and are never called snaps.'
    ]
  };
  if (!DRY) writeIfChanged(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  log(DRY ? '\ndry run — nothing written' : `\nwrote ${written.length} season files + manifest.json`);
  return 0;
}

function writeIfChanged(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (_) {}
  const strip = s => String(s).replace(/"generated_at":"[^"]*"/g, '');
  if (old != null && strip(old) === strip(text)) return false;
  fs.writeFileSync(file, text);
  return true;
}

module.exports = { main, ingestSeason, GATES, blank, pair, numOf };
if (require.main === module) {
  main().then(c => process.exit(c)).catch(e => { console.error('BOX INGEST FAILED:', e && e.stack || e); process.exit(1); });
}
