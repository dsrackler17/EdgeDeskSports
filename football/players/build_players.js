#!/usr/bin/env node
/* ============================================================================
   THE PLAYER QUALITY BUILD — every active FBS player, rated, with provenance.

   Reads only public, keyless, CORS-open feeds this repo already trusts, plus
   two datasets EdgeDesk commits itself, and writes the materialised layers the
   research page reads:

     cfbfastR-data player_stats/csv/player_stats_<season>.csv
                          one row per play, naming the players credited with
                          the events on it, with down / distance / yards-to-goal
                          on every row. The only public per-player production
                          feed in college football.
     cfbfastR-data rosters/csv/cfb_rosters_<season>.csv
                          athlete_id, position, measurables. Identity backbone.
     cfbfastR-data schedules/csv/cfb_schedules_<season>.csv
                          FBS membership, results, and which games count.
     football/rosters/    EdgeDesk's own weekly ESPN roster sync — the fallback
                          when cfbfastR has not published a season yet.
     football/availability/current.json
                          EdgeDesk's own evidence-ranked availability dataset.

   THE PIPELINE, in the order it runs and the order it is cached:

     RAW  ->  NORMALISED PLAYER-SEASONS  ->  PLAYER RATINGS  ->  POSITION GROUPS
          ->  TEAM UNITS  ->  SCHEME PROFILES  ->  (matchup + simulation at read time)

   Nothing downstream of PLAYER RATINGS recomputes anything upstream of it, and
   the research page recomputes none of it: it reads the committed artifacts.

   POINT-IN-TIME IS MANDATORY. Every build writes a dated snapshot beside the
   current file and never overwrites an old one. A rating that was 72 in week 1
   and 84 in week 10 is two facts, not one, and a backtest that uses the week-10
   number to price a week-1 game is a lie about what was known.

     node football/players/build_players.js [--season 2026] [--seasons 4]
                                            [--cache DIR] [--dry] [--quiet]

   Exit 0 = written or unchanged. Exit 1 = could not run at all.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = require('./config.js');
const EPIR = require('./epir.js');
const UNITS = require('./units.js');
const SCHEME = require('./scheme.js');

const DIR = __dirname;
const REPO = path.join(DIR, '..', '..');
const ROSTER_DIR = path.join(DIR, '..', 'rosters');
const AVAIL_FILE = path.join(DIR, '..', 'availability', 'current.json');
const BOX_DIR = path.join(DIR, '..', 'data', 'box');
const B = 'https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main';
const URL_PSTATS = y => `${B}/player_stats/csv/player_stats_${y}.csv`;
const URL_ROSTER = y => `${B}/rosters/csv/cfb_rosters_${y}.csv`;
const URL_SCHED  = y => `${B}/schedules/csv/cfb_schedules_${y}.csv`;

const FCS_KEY = '__nonfbs__';

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */
function arg(name, fb) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fb;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? true : v;
}
const QUIET = !!arg('quiet', false);
const DRY = !!arg('dry', false);
function log(...a) { if (!QUIET) console.log(...a); }
function defaultSeason() { const d = new Date(); return (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear(); }

const SEASON = +(arg('season', defaultSeason()));
const SEASONS_BACK = +(arg('seasons', 4));
const CACHE = arg('cache', process.env.EDP_CACHE || '');

/* ------------------------------------------------------------------ */
/* io                                                                  */
/* ------------------------------------------------------------------ */
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } }
function digestOf(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 16); }

async function fetchText(url, cacheName) {
  if (CACHE && cacheName) {
    const p = path.join(CACHE, cacheName);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return fs.readFileSync(p, 'utf8');
  }
  let last = null;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (CACHE && cacheName) {
        try { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, cacheName), t); } catch (_) {}
      }
      return t;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 1000 * Math.pow(2, a))); }
  }
  throw new Error(`${url}: ${last && last.message}`);
}

/* Split one CSV line honouring quotes. Column count is fixed by the header, so
   this is the whole parser the pipeline needs and it never builds an object per
   row for the 200k-row play tables. */
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function headerIndex(line) {
  const h = splitLine(line), ix = {};
  h.forEach((k, i) => { ix[k.trim()] = i; });
  return ix;
}
function cell(row, i) {
  if (i == null || i < 0 || i >= row.length) return null;
  const v = row[i];
  return (v === '' || v === 'NA' || v === 'NULL') ? null : v;
}
function cellNum(row, i) { const v = cell(row, i); if (v == null) return null; const n = +v; return isFinite(n) ? n : null; }
/* Rows to objects — used only for the small tables (rosters, schedules). */
function parseCsvObjects(text) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const head = splitLine(lines[0]).map(s => s.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const r = splitLine(lines[i]);
    if (r.length < 2) continue;
    const o = {};
    for (let k = 0; k < head.length; k++) { const v = r[k]; o[head[k]] = (v === '' || v === 'NA') ? null : v; }
    out.push(o);
  }
  return out;
}

const tk = EPIR.teamKey;
const TRUE = v => /^(true|1|t|yes)$/i.test(String(v == null ? '' : v).trim());

/* ------------------------------------------------------------------ */
/* schedules: FBS membership, conference, results                       */
/* ------------------------------------------------------------------ */
async function loadSchedule(season) {
  const text = await fetchText(URL_SCHED(season), `sched_${season}.csv`);
  const rows = parseCsvObjects(text);
  const fbs = {}, conf = {}, name = {}, games = [];
  for (const r of rows) {
    const hk = tk(r.home_team), ak = tk(r.away_team);
    if (hk) { name[hk] = r.home_team; if (/^fbs$/i.test(String(r.home_division || ''))) fbs[hk] = true; if (r.home_conference) conf[hk] = r.home_conference; }
    if (ak) { name[ak] = r.away_team; if (/^fbs$/i.test(String(r.away_division || ''))) fbs[ak] = true; if (r.away_conference) conf[ak] = r.away_conference; }
    const hp = r.home_points == null ? null : +r.home_points, ap = r.away_points == null ? null : +r.away_points;
    games.push({
      game_id: r.game_id, week: r.week == null ? null : +r.week,
      home: hk, away: ak, home_name: r.home_team, away_name: r.away_team,
      home_points: isFinite(hp) ? hp : null, away_points: isFinite(ap) ? ap : null,
      completed: TRUE(r.completed), neutral: TRUE(r.neutral_site),
      home_fbs: /^fbs$/i.test(String(r.home_division || '')), away_fbs: /^fbs$/i.test(String(r.away_division || '')),
      start_date: r.start_date || null
    });
  }
  return { fbs, conf, name, games, season };
}

/* ------------------------------------------------------------------ */
/* rosters: identity, position, measurables, continuity                 */
/* ------------------------------------------------------------------ */
/* Position granularity is a real property of the feed, not a detail. cfbfastR
   and ESPN agree on the athlete id (cfbfastR's rosters ARE ESPN's), but they do
   not always agree on how specific a position is: one team's secondary is
   spelled DB, another's is spelled CB and S, and the same is true of DL versus
   DE/DT/EDGE and OL versus OT/G/C. EdgeDesk commits its own ESPN roster sync
   weekly, so where that sync carries a MORE SPECIFIC spelling for the same
   athlete id, it wins — and the player records say which feed the position came
   from. Where neither feed is specific, the coarse group is used and the
   matchup engine reads it as the coarse group rather than inventing an EDGE. */
const SPECIFIC = { S: 1, CB: 1, NB: 1, FS: 1, SS: 1, DE: 1, DT: 1, NT: 1, EDGE: 1, RUSH: 1,
  OT: 1, OG: 1, G: 1, C: 1, LT: 1, LG: 1, RG: 1, RT: 1, OLB: 1, ILB: 1, MLB: 1, PK: 1, K: 1, FB: 1 };
const COARSE = { DB: 1, DL: 1, OL: 1, LB: 1, ATH: 1, '': 1 };
function espnRosterPositions(season) {
  const f = path.join(ROSTER_DIR, `fbs_${season}_espn.json`);
  const j = readJson(f, null);
  const out = {};
  if (!j || !j.teams) return { by_id: out, source: null };
  for (const t of (j.teams || [])) {
    for (const p of (t.players || t.athletes || [])) {
      const id = p.espn_id || p.espn_player_id || p.id;
      const pos = p.position || p.pos;
      if (!id || !pos) continue;
      out[String(id)] = { pos: pos, prior_school: p.previous_school || null, class_year: p.class || null };
    }
  }
  return { by_id: out, source: `football/rosters/fbs_${season}_espn.json` };
}
function refinePositions(roster, espn) {
  if (!roster || !roster.players || !espn || !espn.by_id) return roster;
  let refined = 0, classes = 0;
  for (const id of Object.keys(roster.players)) {
    const r = roster.players[id], e = espn.by_id[id];
    if (!e) continue;
    if (e.class_year && !r.class_year) { r.class_year = e.class_year; classes++; }
    if (!e.pos) continue;
    const cur = String(r.pos || '').toUpperCase().replace(/[^A-Z]/g, '');
    const cand = String(e.pos).toUpperCase().replace(/[^A-Z]/g, '');
    if (SPECIFIC[cand] && (COARSE[cur] || !cur)) { r.pos = e.pos; r.pos_source = 'espn_sync_refined'; refined++; }
  }
  roster.refined_positions = refined;
  roster.espn_source = espn.source;
  return roster;
}

async function loadRoster(season) {
  /* cfbfastR first; EdgeDesk's own ESPN sync when cfbfastR has not published */
  try {
    const text = await fetchText(URL_ROSTER(season), `roster_${season}.csv`);
    const rows = parseCsvObjects(text);
    if (rows.length > 3000) {
      const out = {};
      for (const r of rows) {
        const id = r.athlete_id && String(r.athlete_id).trim();
        if (!id) continue;
        const team = r.team, key = tk(team);
        if (!key) continue;
        out[id] = {
          athlete_id: id,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null,
          team, team_key: key,
          pos: r.position || null,
          height_in: r.height == null ? null : +r.height,
          weight_lb: r.weight == null ? null : +r.weight,
          jersey: r.jersey || null
        };
      }
      const base = { players: out, source: 'cfbfastR-data rosters/csv/cfb_rosters_' + season + '.csv', season, count: Object.keys(out).length };
      return refinePositions(base, espnRosterPositions(season));
    }
  } catch (e) { log(`  roster ${season}: cfbfastR unavailable (${e.message})`); }

  const f = path.join(ROSTER_DIR, `fbs_${season}_espn.json`);
  const j = readJson(f, null);
  if (j && j.teams) {
    const out = {};
    for (const t of j.teams) {
      const key = tk(t.display_name || t.team || t.location || t.name);
      for (const p of (t.players || t.athletes || [])) {
        const id = p.espn_id || p.espn_player_id || p.id;
        if (!id) continue;
        out[String(id)] = {
          athlete_id: String(id), name: p.name || p.player || p.fullName || p.displayName || null,
          team: t.display_name || t.team || t.location, team_key: key, pos: p.position || null,
          height_in: null, weight_lb: null, jersey: p.jersey || null,
          class_year: p.class || null, prior_school: p.previous_school || null
        };
      }
    }
    if (Object.keys(out).length) {
      return { players: out, source: `football/rosters/fbs_${season}_espn.json (EdgeDesk ESPN sync)`, season, count: Object.keys(out).length };
    }
  }
  return { players: {}, source: null, season, count: 0,
    reason: `no roster published for ${season} in either cfbfastR or EdgeDesk's own sync` };
}

/* ------------------------------------------------------------------ */
/* the box-score enrichment (football/data/build_box.js)                */
/* ------------------------------------------------------------------ *
 * Optional by design: a season with no box artifact simply has no box
 * measures, every one of them is DECLARED MISSING on the player, and v1 is
 * bit-identical to what it was before this feed existed.
 * ------------------------------------------------------------------ */
const BOX_COLS = ['games', 'tackles', 'solo', 'tfl', 'sacks', 'pbu', 'hurries', 'ints',
  'punts', 'punt_yds', 'punts_in20', 'fg_made', 'fg_att', 'qbr', 'qbr_games', 'fum_lost', 'def_td'];
function loadBox(season) {
  const j = readJson(path.join(BOX_DIR, `${season}.json`), null);
  if (!j || !j.players) return { available: false, byKey: {}, coverage: {}, teams: {},
    reason: `no box-score artifact for ${season} — run football/data/build_box.js. Every box measure is declared missing and v1 is unaffected.` };
  const byKey = {};
  for (const k of Object.keys(j.players)) {
    const row = j.players[k], o = {};
    for (let i = 0; i < BOX_COLS.length; i++) o[BOX_COLS[i]] = row[i];
    o.team_key = row[BOX_COLS.length] || null;
    byKey[k] = o;
  }
  /* the box gates are namespaced so they can never collide with the play
     table's gates of the same name — the two feeds disagree about coverage
     and both answers have to survive */
  const coverage = {};
  const map = { tackles: 'box_tackles', tackles_for_loss: 'box_tfl', hurries: 'box_hurries',
    sacks: 'box_sacks', passes_defended: 'box_pbu', interceptions: 'box_int', punting: 'box_punting' };
  for (const src of Object.keys(map)) {
    if (j.coverage && j.coverage[src]) coverage[map[src]] = j.coverage[src];
  }
  return { available: true, byKey, coverage, teams: j.teams || {},
    source: j.source, season: j.season, generated_at: j.generated_at };
}

/* ------------------------------------------------------------------ */
/* the play table                                                       */
/* ------------------------------------------------------------------ */
const SUC = CFG.SUCCESS, EXP = CFG.EXPLOSIVE;
function isSuccess(down, distance, gained) {
  if (down == null || distance == null || gained == null) return null;
  const need = down === 1 ? SUC.first * distance : down === 2 ? SUC.second * distance : distance;
  return gained >= need ? 1 : 0;
}

/* GARBAGE TIME.
   The conventional score-differential-by-period rule. A play is competitive
   unless the game is already decided by this much:

     Q1 > 38    Q2 > 28    Q3 > 22    Q4 (and OT) > 16

   ONE IMPRECISION, STATED RATHER THAN HIDDEN: the play table's score columns
   are the score AFTER the play, so a play that itself scores is judged on the
   state it created. Over a season that moves a handful of plays per team and it
   is not worth inventing a pre-play score to fix.

   NOTHING IS DELETED. Every team-game carries BOTH the full aggregate and the
   competitive-only one, so the effect of the filter is auditable and the
   dataset can be re-read either way. */
var GARBAGE_BY_PERIOD = { 1: 38, 2: 28, 3: 22, 4: 16 };
function isGarbage(period, scoreDiff) {
  if (period == null || scoreDiff == null) return false;
  var lim = GARBAGE_BY_PERIOD[period];
  if (lim == null) lim = GARBAGE_BY_PERIOD[4];      /* overtime uses the fourth-quarter bar */
  return Math.abs(scoreDiff) > lim;
}

function blankTG() {
  return {
    plays: 0, rush_att: 0, rush_yds: 0, rush_success: 0, rush_explosive: 0, rush_stuffed: 0,
    pass_att: 0, pass_cmp: 0, pass_yds: 0, pass_success: 0, pass_explosive: 0,
    sacks_taken: 0, sack_yds: 0, int_thrown: 0, fumbles: 0,
    dropbacks: 0, first_downs: 0,
    early_down_plays: 0, early_down_pass: 0, neutral_plays: 0, neutral_pass: 0,
    rz_plays: 0, rz_rush: 0, third_plays: 0, third_pass: 0,
    /* ADDED for the team-rankings performance layer. Additive on purpose: the
       player layer reads named fields and is unaffected by new ones. */
    early_down_success: 0,      /* first and second down, the downs a team chooses */
    third_success: 0,           /* a third down gained the distance — a conversion */
    rz_success: 0,              /* success inside the opponent 20 */
    turnovers: 0                /* interceptions thrown + fumbles. See the note in
                                   performance.js: recoveries are not attributable
                                   to a side in this feed, so this is a proxy and
                                   is regressed hard because it barely repeats. */
  };
}

async function loadPlays(season, sched, opts) {
  opts = opts || {};
  const byWeek = !!opts.byWeek;
  const text = await fetchText(URL_PSTATS(season), `pstats_${season}.csv`);
  const nl = text.indexOf('\n');
  const ix = headerIndex(text.slice(0, nl));
  const need = ['team', 'opponent', 'conference', 'game_id', 'week', 'down', 'distance', 'yards_to_goal',
    'rush_player_id', 'rush_player', 'rush_yds',
    'completion_player_id', 'completion_player', 'completion_yds',
    'incompletion_player_id', 'incompletion_player',
    'reception_player_id', 'reception_player', 'reception_yds',
    'target_player_id', 'target_player',
    'interception_thrown_player_id', 'interception_player_id', 'interception_player',
    'sack_player_id', 'sack_player', 'sack_taken_player_id', 'sack_taken_player', 'sack_taken_stat',
    'pass_breakup_player_id', 'pass_breakup_player',
    'fumble_player_id', 'fumble_player', 'fumble_forced_player_id', 'fumble_forced_player',
    'fumble_recovered_player_id', 'fumble_recovered_player',
    'field_goal_attempt_player_id', 'field_goal_attempt_player', 'field_goal_attempt_stat',
    'field_goal_made_player_id', 'field_goal_made_stat'];
  const missingCols = need.filter(k => ix[k] == null);

  const players = new Map();     /* athlete_id -> accumulator */
  const teamGames = new Map();   /* gameKey -> {team, opp, off} */
  const counts = { plays: 0, targets: 0, interceptions: 0, pass_breakups: 0, forced_fumbles: 0, sacks: 0 };
  const teamGameSet = new Set();

  function P(id, nm, team, week) {
    let p = players.get(id);
    if (!p) {
      p = { athlete_id: id, name: nm, team, first_week: week, last_week: week,
        weeks: new Set(), stat: {}, oppAcc: {}, teams: new Set(), byWeek: byWeek ? {} : null };
      players.set(id, p);
    }
    if (nm && !p.name) p.name = nm;
    if (team) { p.team = team; p.teams.add(team); }
    if (week != null) { p.weeks.add(week); if (p.first_week == null || week < p.first_week) p.first_week = week; if (p.last_week == null || week > p.last_week) p.last_week = week; }
    p._w = week == null ? 0 : week;
    return p;
  }
  /* `add` also keeps a per-week split when the caller asked for one. The
     walk-forward validator needs to rebuild a player's record as it stood
     BEFORE a given week, and prefix-summing weeks is the only way to do that
     without re-parsing a sixty-megabyte table once per week. */
  function add(p, k, v) {
    p.stat[k] = (p.stat[k] || 0) + (v || 0);
    if (byWeek) {
      const w = p._w == null ? 0 : p._w;
      const bucket = p.byWeek[w] || (p.byWeek[w] = {});
      bucket[k] = (bucket[k] || 0) + (v || 0);
    }
  }
  /* remember which defence each unit of a player's volume was earned against,
     so the opponent adjustment is plays-weighted rather than game-weighted */
  function oppTag(p, metric, oppKey, w) {
    const m = p.oppAcc[metric] || (p.oppAcc[metric] = new Map());
    m.set(oppKey, (m.get(oppKey) || 0) + w);
  }

  let pos = nl + 1;
  const N = text.length;
  while (pos < N) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = N;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(pos, end - 1) : text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    const r = splitLine(line);
    const offName = cell(r, ix.team), defName = cell(r, ix.opponent);
    const off = tk(offName), def = tk(defName);
    if (!off || !def) continue;
    const week = cellNum(r, ix.week);
    const gid = cell(r, ix.game_id);
    const down = cellNum(r, ix.down), dist = cellNum(r, ix.distance);
    counts.plays++;

    const gkey = gid + '|' + off;
    let tg = teamGames.get(gkey);
    if (!tg) {
      tg = { game_id: gid, week, team: off, team_name: offName, opp: def, opp_name: defName,
        conference: cell(r, ix.conference), off: blankTG(), comp: blankTG(), garbage_plays: 0 };
      teamGames.set(gkey, tg);
    }
    teamGameSet.add(gkey);

    /* Every counter is written to the FULL aggregate and, when the game is not
       already decided, to the COMPETITIVE one as well. `T` keeps the existing
       call sites unchanged; `T2` is the competitive twin, or a throwaway when
       this play is garbage time. */
    const period = cellNum(r, ix.period);
    const diff = (cellNum(r, ix.team_score) == null || cellNum(r, ix.opponent_score) == null)
      ? null : (cellNum(r, ix.team_score) - cellNum(r, ix.opponent_score));
    const garbage = isGarbage(period, diff);
    if (garbage) tg.garbage_plays++;
    const T = tg.off;
    const T2 = garbage ? blankTG() : tg.comp;
    T.plays++; T2.plays++;

    const rushId = cell(r, ix.rush_player_id);
    const cmpId = cell(r, ix.completion_player_id);
    const incId = cell(r, ix.incompletion_player_id);
    const intThrownId = cell(r, ix.interception_thrown_player_id);
    const sackTakenId = cell(r, ix.sack_taken_player_id);

    if (rushId) {
      const yds = cellNum(r, ix.rush_yds) || 0;
      const suc = isSuccess(down, dist, yds);
      const expl = yds >= EXP.rush ? 1 : 0;
      const stuff = yds <= 0 ? 1 : 0;
      const fd = (dist != null && yds >= dist) ? 1 : 0;
      for (const X of [T, T2]) {
        X.rush_att++; X.rush_yds += yds; X.rush_success += suc || 0; X.rush_explosive += expl;
        X.rush_stuffed += stuff; X.first_downs += fd;
        if (down === 1 || down === 2) { X.early_down_plays++; X.early_down_success += suc || 0; }
        if (cellNum(r, ix.yards_to_goal) != null && cellNum(r, ix.yards_to_goal) <= 20) {
          X.rz_plays++; X.rz_rush++; X.rz_success += suc || 0;
        }
        if (down === 3) { X.third_plays++; X.third_success += fd; }
      }
      const p = P(rushId, cell(r, ix.rush_player), off, week);
      add(p, 'rush_att', 1); add(p, 'rush_yds', yds); add(p, 'rush_success', suc || 0);
      add(p, 'rush_explosive', expl); add(p, 'rush_stuffed', stuff); add(p, 'rush_first_downs', fd);
      oppTag(p, 'rush', def, 1);
    }

    if (cmpId || incId || intThrownId || sackTakenId) {
      for (const X of [T, T2]) {
        X.dropbacks++;
        if (down === 1 || down === 2) { X.early_down_plays++; X.early_down_pass++; }
        if (down === 3) { X.third_plays++; X.third_pass++; }
        if (cellNum(r, ix.yards_to_goal) != null && cellNum(r, ix.yards_to_goal) <= 20) X.rz_plays++;
      }
    }

    if (cmpId) {
      const yds = cellNum(r, ix.completion_yds) || 0;
      const suc = isSuccess(down, dist, yds);
      const expl = yds >= EXP.pass ? 1 : 0;
      const fd = (dist != null && yds >= dist) ? 1 : 0;
      for (const X of [T, T2]) {
        X.pass_att++; X.pass_cmp++; X.pass_yds += yds; X.pass_success += suc || 0;
        X.pass_explosive += expl; X.first_downs += fd;
        if (down === 1 || down === 2) X.early_down_success += suc || 0;
        if (down === 3) X.third_success += fd;
        if (cellNum(r, ix.yards_to_goal) != null && cellNum(r, ix.yards_to_goal) <= 20) X.rz_success += suc || 0;
      }
      const q = P(cmpId, cell(r, ix.completion_player), off, week);
      add(q, 'pass_att', 1); add(q, 'pass_cmp', 1); add(q, 'pass_yds', yds);
      add(q, 'pass_success', suc || 0); add(q, 'pass_explosive', expl);
      oppTag(q, 'pass', def, 1);
      const recId = cell(r, ix.reception_player_id);
      if (recId) {
        const ry = cellNum(r, ix.reception_yds);
        const w = P(recId, cell(r, ix.reception_player), off, week);
        add(w, 'receptions', 1); add(w, 'rec_yds', ry == null ? yds : ry);
        add(w, 'rec_success', suc || 0); add(w, 'rec_explosive', expl); add(w, 'rec_first_downs', fd);
        add(w, 'targets', 1);
        oppTag(w, 'recv', def, 1);
      }
    }
    if (incId) {
      T.pass_att++; T2.pass_att++;
      const q = P(incId, cell(r, ix.incompletion_player), off, week);
      add(q, 'pass_att', 1); add(q, 'pass_success', 0);
      oppTag(q, 'pass', def, 1);
      const tgtId = cell(r, ix.target_player_id);
      if (tgtId) {
        counts.targets++;
        const w = P(tgtId, cell(r, ix.target_player), off, week);
        add(w, 'targets', 1);
      }
    }
    if (intThrownId) {
      T.pass_att++; T.int_thrown++; T.turnovers++;
      T2.pass_att++; T2.int_thrown++; T2.turnovers++;
      const q = P(intThrownId, cell(r, ix.interception_thrown_player), off, week);
      add(q, 'pass_att', 1); add(q, 'int_thrown', 1); add(q, 'pass_success', 0);
      oppTag(q, 'pass', def, 1);
    }
    if (sackTakenId) {
      const lost = cellNum(r, ix.sack_taken_stat) || 0;
      T.sacks_taken++; T.sack_yds += lost;
      T2.sacks_taken++; T2.sack_yds += lost;
      const q = P(sackTakenId, cell(r, ix.sack_taken_player), off, week);
      add(q, 'sacks_taken', 1); add(q, 'sack_yds_taken', lost);
      oppTag(q, 'pass', def, 1);
    }
    const fumId = cell(r, ix.fumble_player_id);
    if (fumId) { T.fumbles++; T.turnovers++; T2.fumbles++; T2.turnovers++; add(P(fumId, cell(r, ix.fumble_player), off, week), 'fumbles', 1); }

    /* --- defenders. They belong to `opponent`, not `team`. --- */
    const sackId = cell(r, ix.sack_player_id);
    if (sackId) { counts.sacks++; add(P(sackId, cell(r, ix.sack_player), def, week), 'def_sacks', 1); }
    const intId = cell(r, ix.interception_player_id);
    if (intId) { counts.interceptions++; add(P(intId, cell(r, ix.interception_player), def, week), 'def_int', 1); }
    const pbuId = cell(r, ix.pass_breakup_player_id);
    if (pbuId) { counts.pass_breakups++; add(P(pbuId, cell(r, ix.pass_breakup_player), def, week), 'def_pbu', 1); }
    const ffId = cell(r, ix.fumble_forced_player_id);
    if (ffId) { counts.forced_fumbles++; add(P(ffId, cell(r, ix.fumble_forced_player), def, week), 'def_ff', 1); }
    const frId = cell(r, ix.fumble_recovered_player_id);
    if (frId) add(P(frId, cell(r, ix.fumble_recovered_player), off, week), 'def_fr', 1);

    /* --- kicking --- */
    const fgaId = cell(r, ix.field_goal_attempt_player_id);
    if (fgaId) {
      const dist2 = cellNum(r, ix.field_goal_attempt_stat);
      const k = P(fgaId, cell(r, ix.field_goal_attempt_player), off, week);
      add(k, 'fg_att', 1);
      if (dist2 != null && dist2 >= 40) add(k, 'fg_att_long', 1);
      if (cell(r, ix.field_goal_made_player_id) === fgaId) {
        add(k, 'fg_made', 1);
        if (dist2 != null && dist2 >= 40) add(k, 'fg_made_long', 1);
      }
    }
  }

  /* neutral-situation pass rate: first and second down, outside the red zone.
     The play table carries no game clock state we can trust for garbage time,
     so "neutral" here is a DOWN definition and is labelled as one. */
  for (const tg of teamGames.values()) {
    tg.off.neutral_plays = tg.off.early_down_plays;
    tg.off.neutral_pass = tg.off.early_down_pass;
    if (tg.comp) { tg.comp.neutral_plays = tg.comp.early_down_plays; tg.comp.neutral_pass = tg.comp.early_down_pass; }
  }

  return { players, teamGames, counts, missingCols, teamGameCount: teamGameSet.size, season };
}

/* ------------------------------------------------------------------ */
/* coverage gates                                                       */
/* ------------------------------------------------------------------ */
function coverageGates(counts, teamGameCount) {
  const out = {};
  const G = CFG.COVERAGE_GATES;
  for (const k of Object.keys(G)) {
    const n = counts[k] || 0;
    const per = teamGameCount > 0 ? n / teamGameCount : 0;
    const usable = per >= G[k].per_team_game_min;
    out[k] = {
      usable, observed: n, per_team_game: Math.round(per * 1000) / 1000,
      floor: G[k].per_team_game_min, basis: G[k].basis,
      reason: usable ? null
        : `the ${k.replace(/_/g, ' ')} column is attributing only ${(Math.round(per * 100) / 100)} events per team-game this season, below the ${G[k].per_team_game_min} floor — the feed is dropping events, so every measure that depends on it is DECLARED MISSING rather than scored as if the events did not happen`
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* team season aggregates + opponent-adjusted rates                     */
/* ------------------------------------------------------------------ */
const ADJ_METRICS = [
  { id: 'rush_success_rate',  num: 'rush_success',  den: 'rush_att',  phase: 'rush' },
  { id: 'yards_per_rush',     num: 'rush_yds',      den: 'rush_att',  phase: 'rush' },
  { id: 'explosive_rush_rate',num: 'rush_explosive',den: 'rush_att',  phase: 'rush' },
  { id: 'stuff_rate',         num: 'rush_stuffed',  den: 'rush_att',  phase: 'rush' },
  { id: 'pass_success_rate',  num: 'pass_success',  den: 'dropbacks', phase: 'pass' },
  { id: 'yards_per_attempt',  num: 'pass_yds',      den: 'pass_att',  phase: 'pass' },
  { id: 'explosive_pass_rate',num: 'pass_explosive',den: 'pass_att',  phase: 'pass' },
  { id: 'completion_pct',     num: 'pass_cmp',      den: 'pass_att',  phase: 'pass' },
  { id: 'sack_rate_taken',    num: 'sacks_taken',   den: 'dropbacks', phase: 'pass' }
];
/* receiving reuses the passing surface: a receiver's opponent is the same
   secondary his quarterback faced, and the feed gives no separate denominator */
const RECV_MAP = {
  rec_success_rate: 'pass_success_rate',
  rec_yards_per_catch: 'yards_per_attempt',
  explosive_rec_rate: 'explosive_pass_rate',
  first_down_rate_rec: 'pass_success_rate',
  catch_rate: 'completion_pct'
};
const QBRUSH_MAP = { qb_rush_success_rate: 'rush_success_rate', qb_yards_per_rush: 'yards_per_rush' };

function teamSeasonAggregates(teamGames, fbs) {
  const off = new Map(), def = new Map(), games = new Map();
  function acc(map, key, src) {
    let a = map.get(key);
    if (!a) { a = blankTG(); a.games = 0; map.set(key, a); }
    for (const k of Object.keys(src)) if (typeof src[k] === 'number') a[k] = (a[k] || 0) + src[k];
    a.games++;
    return a;
  }
  for (const tg of teamGames.values()) {
    const o = fbs[tg.team] ? tg.team : FCS_KEY;
    const d = fbs[tg.opp] ? tg.opp : FCS_KEY;
    acc(off, o, tg.off);
    acc(def, d, tg.off);
    games.set(o, (games.get(o) || new Set()));
    games.get(o).add(tg.game_id);
  }
  return { off, def, games };
}

/* Additive opponent adjustment, solved as a fixed point over the team-game
   table. off_i and def_j are each the mean of (observed − the other side's
   deviation from the league mean), weighted by that game's own denominator.
   Non-FBS teams share ONE pooled identity, so beating an FCS team is worth
   what the data says it is worth rather than a number somebody chose. */
function opponentAdjust(teamGames, fbs, metric) {
  const rows = [];
  let sumN = 0, sumD = 0;
  for (const tg of teamGames.values()) {
    const n = tg.off[metric.num], d = tg.off[metric.den];
    if (!(d > 0)) continue;
    rows.push({ off: fbs[tg.team] ? tg.team : FCS_KEY, def: fbs[tg.opp] ? tg.opp : FCS_KEY, n, d, r: n / d });
    sumN += n; sumD += d;
  }
  if (!rows.length || !(sumD > 0)) return null;
  const league = sumN / sumD;
  const O = new Map(), D = new Map();
  for (const r of rows) { O.set(r.off, league); D.set(r.def, league); }
  for (let it = 0; it < 15; it++) {
    const on = new Map(), ow = new Map(), dn = new Map(), dw = new Map();
    for (const r of rows) {
      const dAdj = (D.get(r.def) || league) - league;
      const oAdj = (O.get(r.off) || league) - league;
      on.set(r.off, (on.get(r.off) || 0) + (r.r - dAdj) * r.d); ow.set(r.off, (ow.get(r.off) || 0) + r.d);
      dn.set(r.def, (dn.get(r.def) || 0) + (r.r - oAdj) * r.d); dw.set(r.def, (dw.get(r.def) || 0) + r.d);
    }
    for (const k of on.keys()) if (ow.get(k) > 0) O.set(k, on.get(k) / ow.get(k));
    for (const k of dn.keys()) if (dw.get(k) > 0) D.set(k, dn.get(k) / dw.get(k));
  }
  return { league, offense: O, defense: D, rows: rows.length, metric: metric.id };
}

/* ------------------------------------------------------------------ */
/* build one season's normalised player-seasons                         */
/* ------------------------------------------------------------------ */
function normaliseSeason(season, play, roster, prevRoster, sched, adj) {
  const box = (adj && adj.box) || { available: false, byKey: {} };
  const out = [];
  const teamGroupVolume = new Map();   /* teamKey|group -> volume */
  const teamDefGames = new Map();
  for (const tg of play.teamGames.values()) {
    const d = tg.opp;
    if (!teamDefGames.has(d)) teamDefGames.set(d, new Set());
    teamDefGames.get(d).add(tg.game_id);
  }
  const teamOffGames = new Map();
  for (const tg of play.teamGames.values()) {
    if (!teamOffGames.has(tg.team)) teamOffGames.set(tg.team, new Set());
    teamOffGames.get(tg.team).add(tg.game_id);
  }

  const rosterPlayers = roster.players || {};
  const prevPlayers = (prevRoster && prevRoster.players) || {};
  const seen = new Set();

  function inferGroup(st) {
    const db = (st.pass_att || 0) + (st.sacks_taken || 0);
    if (db >= 20) return { group: 'QB', why: 'twenty or more dropbacks attributed' };
    if ((st.rush_att || 0) >= 20 && (st.rush_att || 0) > (st.receptions || 0)) return { group: 'RB', why: 'twenty or more carries and more carries than catches' };
    if ((st.receptions || 0) >= 8) return { group: 'WR', why: 'eight or more receptions; the feed cannot tell a receiver from a tight end' };
    if ((st.def_sacks || 0) >= 2) return { group: 'DL', why: 'two or more sacks; the feed cannot tell an interior lineman from an edge' };
    if ((st.def_pbu || 0) + (st.def_int || 0) >= 2) return { group: 'DB', why: 'coverage events attributed; the feed cannot tell a corner from a safety' };
    return null;
  }

  function mk(id, base) {
    const r = rosterPlayers[id] || null;
    const prev = prevPlayers[id] || null;
    const teamName = (r && r.team) || base.teamName || null;
    const key = tk((r && r.team_key) || teamName);
    let pos = r ? r.pos : null;
    let group = CFG.group(pos);
    let posSource = r ? (r.pos_source || 'roster') : null;
    if (!group) {
      const inf = inferGroup(base.stat);
      if (inf) { group = inf.group; pos = pos || inf.group; posSource = 'inferred_from_usage:' + inf.why; }
    }
    let status = 'unknown', prior_school = null;
    if (prevRoster && prevRoster.count > 0) {
      if (prev) {
        if (prev.team_key === key) status = 'returning';
        else { status = 'transfer'; prior_school = prev.team; }
      } else status = 'new';
    }
    return { id, r, teamName, key, pos, group, posSource, status, prior_school };
  }

  for (const [id, p] of play.players) {
    const m = mk(id, { teamName: p.team, stat: p.stat });
    if (!m.key) continue;
    /* THE DATABASE IS FBS. An FCS player is not rated — he is not worse, he is
       out of scope, and the two are different statements. The structure takes
       a division the day a feed covers one: nothing below this line assumes
       FBS except this filter. */
    if (!sched.fbs[m.key]) continue;
    seen.add(id);
    const st = Object.assign({}, p.stat);
    /* a quarterback's carries are a quarterback's carries, and are scored on
       the quarterback contract rather than against running backs */
    if (m.group === 'QB') {
      st.qb_rush_att = st.rush_att || 0; st.qb_rush_yds = st.rush_yds || 0;
      st.qb_rush_success = st.rush_success || 0;
    }
    st.team_def_games = (teamDefGames.get(m.key) || new Set()).size;
    st.team_games = st.team_def_games;      /* a team's defence is on the field in every game it plays */
    st.def_plays_faced = 0; st.def_dropbacks_faced = 0;
    const dagg = adj.teamAgg.def.get(m.key);
    if (dagg) { st.def_plays_faced = dagg.plays; st.def_dropbacks_faced = dagg.dropbacks; }

    const rec = {
      athlete_id: id, name: p.name || (m.r && m.r.name) || null,
      team: m.teamName, team_key: m.key,
      conference: sched.conf[m.key] || null,
      season, pos: m.pos, group: m.group, pos_source: m.posSource,
      class_year: (m.r && m.r.class_year) || null,
      height_in: m.r ? m.r.height_in : null, weight_lb: m.r ? m.r.weight_lb : null,
      prior_school: m.prior_school || (m.r && m.r.prior_school) || null,
      status: m.status,
      identity: 'athlete_id',
      roster: { source: roster.source, in_roster: !!m.r },
      games: p.weeks.size, first_week: p.first_week, last_week: p.last_week,
      stat: st, opponent: null, opp_raw: p.oppAcc, prior_role: null,
      sources: [
        { name: 'cfbfastR-data player_stats', tier: 'public, keyless', detail: `player_stats_${season}.csv` },
        { name: roster.source || 'no roster', tier: 'public, keyless', detail: 'position, measurables, continuity' }
      ]
    };
    out.push(rec);
  }

  /* rostered players the play table never attributed an event to. They are
     REAL and they are on the team, so they are carried with zero production
     and a confidence that says exactly that — a roster of eighty-five with
     only the forty who touched the ball would misread every depth question. */
  for (const id of Object.keys(rosterPlayers)) {
    if (seen.has(id)) continue;
    const r = rosterPlayers[id];
    if (!sched.fbs[r.team_key]) continue;
    const m = mk(id, { teamName: r.team, stat: {} });
    if (!m.group) continue;
    out.push({
      athlete_id: id, name: r.name, team: r.team, team_key: r.team_key,
      conference: sched.conf[r.team_key] || null,
      season, pos: r.pos, group: m.group, pos_source: r.pos_source || 'roster',
      class_year: r.class_year || null, height_in: r.height_in, weight_lb: r.weight_lb,
      prior_school: m.prior_school || r.prior_school || null, status: m.status,
      identity: 'athlete_id',
      roster: { source: roster.source, in_roster: true },
      games: 0, first_week: null, last_week: null,
      stat: { team_def_games: (teamDefGames.get(r.team_key) || new Set()).size,
        team_games: (teamDefGames.get(r.team_key) || new Set()).size },
      opponent: null, opp_raw: {}, prior_role: null,
      no_attributed_events: true,
      sources: [{ name: roster.source || 'roster', tier: 'public, keyless', detail: 'on the roster; the play table attributed no event to him' }]
    });
  }

  /* box-score enrichment, joined on the SAME stable athlete id the rest of the
     layer joins on. Nothing here is name-matched. */
  let boxJoined = 0;
  for (const rec of out) {
    const b = box.byKey['a:' + rec.athlete_id];
    if (!b) continue;
    boxJoined++;
    rec.stat.box_games = b.games || 0;
    rec.stat.box_tackles = b.tackles || 0;
    rec.stat.box_solo = b.solo || 0;
    rec.stat.box_tfl = b.tfl || 0;
    rec.stat.box_sacks = b.sacks || 0;
    rec.stat.box_pbu = b.pbu || 0;
    rec.stat.box_hurries = b.hurries || 0;
    rec.stat.box_ints = b.ints || 0;
    rec.stat.box_punts = b.punts || 0;
    rec.stat.box_punt_yds = b.punt_yds || 0;
    rec.stat.box_punts_in20 = b.punts_in20 || 0;
    rec.stat.box_fg_made = b.fg_made || 0;
    rec.stat.box_fg_att = b.fg_att || 0;
    rec.stat.box_fum_lost = b.fum_lost || 0;
    /* CONTEXT ONLY. ESPN's adjusted QBR is another organisation's model output
       and is deliberately not an input to any EdgeDesk rating. */
    rec.qbr = (b.qbr_games > 0) ? { value: b.qbr, games: b.qbr_games, source: 'ESPN adjusted QBR',
      used_in_rating: false, basis: 'shown as context. This repo does not build its ratings on another organisation’s rating.' } : null;
    if (rec.sources) rec.sources.push({ name: 'sportsdataverse ESPN player box', tier: 'public, keyless',
      detail: 'tackles, TFL, hurries, passes defended, interceptions, punting and appearances, joined on athlete id' });
  }
  if (box.available) out._box_joined = boxJoined;

  /* group volume shares, for role projection */
  for (const rec of out) {
    if (!rec.group) continue;
    const k = rec.team_key + '|' + rec.group;
    teamGroupVolume.set(k, (teamGroupVolume.get(k) || 0) + EPIR.volume(rec));
  }
  for (const rec of out) {
    if (!rec.group) continue;
    rec.stat.team_group_volume = teamGroupVolume.get(rec.team_key + '|' + rec.group) || 0;
  }

  /* opponent-adjustment offsets: for each measure, the plays-weighted mean of
     what the defences this player actually faced allowed. */
  const leagueAllowed = {};
  for (const met of ADJ_METRICS) {
    const a = adj.metrics[met.id];
    if (a) leagueAllowed[met.id] = a.league;
  }
  for (const k of Object.keys(RECV_MAP)) if (leagueAllowed[RECV_MAP[k]] != null) leagueAllowed[k] = leagueAllowed[RECV_MAP[k]];
  for (const k of Object.keys(QBRUSH_MAP)) if (leagueAllowed[QBRUSH_MAP[k]] != null) leagueAllowed[k] = leagueAllowed[QBRUSH_MAP[k]];

  for (const rec of out) {
    const acc = rec.opp_raw || {};
    const opp = {};
    function faced(phase, metricId) {
      const m = acc[phase];
      const a = adj.metrics[metricId];
      if (!m || !a) return null;
      let s = 0, w = 0;
      for (const [oppKey, n] of m) {
        const dk = sched.fbs[oppKey] ? oppKey : FCS_KEY;
        const v = a.defense.get(dk);
        if (v == null) continue;
        s += v * n; w += n;
      }
      return w > 0 ? s / w : null;
    }
    for (const met of ADJ_METRICS) {
      const v = faced(met.phase, met.id);
      if (v != null) opp[met.id] = v;
    }
    for (const k of Object.keys(RECV_MAP)) { const v = faced('recv', RECV_MAP[k]); if (v != null) opp[k] = v; }
    for (const k of Object.keys(QBRUSH_MAP)) { const v = faced('rush', QBRUSH_MAP[k]); if (v != null) opp[k] = v; }
    rec.opponent = Object.keys(opp).length ? opp : null;
    delete rec.opp_raw;
  }

  return { players: out, leagueAllowed, teamDefGames, teamOffGames };
}

module.exports = {
  SEASON, SEASONS_BACK, FCS_KEY,
  splitLine, headerIndex, parseCsvObjects, isSuccess, blankTG, isGarbage, GARBAGE_BY_PERIOD,
  loadSchedule, loadRoster, loadPlays, coverageGates, espnRosterPositions, refinePositions, loadBox, BOX_COLS,
  teamSeasonAggregates, opponentAdjust, normaliseSeason,
  ADJ_METRICS, RECV_MAP, QBRUSH_MAP, fetchText, digestOf, readJson
};

/* the runner lives in run_build.js so this file can be require()d by the tests
   and by the walk-forward validator without executing a build */
if (require.main === module) {
  require('./run_build.js').main().then(code => process.exit(code)).catch(e => {
    console.error('BUILD FAILED:', e && e.stack || e);
    process.exit(1);
  });
}
