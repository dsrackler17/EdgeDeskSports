#!/usr/bin/env node
'use strict';
/* ===========================================================================
   EdgeDesk NBA — one season's sources in, the warehouse tables out.

     node nba/ingest/season.js --season 2003-2026|current|all [--offline]

   Sources (nba/config.js SOURCES, sportsdataverse hoopR-nba-data from ESPN's
   public feeds): the season schedule, team box scores, player box scores and
   play-by-play. Output:

     COMMITTED (small, read by the slate and the record)
       nba/data/games/<season>.csv        edgedesk_nba_games_v2, one row per game (scope: regular_season · nba_cup_final · play_in · playoffs)
       nba/data/team_games/<season>.csv   edgedesk_nba_team_games_v1, two rows per game
       nba/data/manifest.json             per season: provenance (url, sha256,
                                          bytes, fetched_at), counts, drops and
                                          every integrity check below
       nba/data/players.json              id → name, position, last team/season
     REBUILT, NOT COMMITTED (.cache/nba_work, large)
       player_games_<season>.json.gz      edgedesk_nba_player_games_v2
       stints_<season>.json.gz            edgedesk_nba_stints_v1 (lineup stints)
       shots_<season>.json.gz             edgedesk_nba_shots_v1

   TIME. `known_at` is blank on every row: when ESPN first published a result
   was never recorded, and nothing is backdated. `assumed_available_at` is the
   scheduled start plus 4 hours, and `pit` is RETRO: a retrospective dataset
   retrieved after the fact from a source that can revise. Every model reads a
   game's facts only after its assumed availability (engine/validation
   leakageAudit enforces it).

   NEUTRAL SITES. The source flags international and NBA Cup knockout games,
   but not the 2020 Orlando restart: every 2019-20 game from 30 July 2020 is
   set neutral here (`bubble` = 1), because the source names a nominal home
   team for games played without one.

   INTEGRITY, measured and written to the manifest (never silently patched):
   schedule final vs team box points, play-by-play final vs official final,
   stint seconds vs game length, the share of game time with a valid five on
   each side, five box-score starters per team, and the agreement of each
   player's reconstructed floor time with his box-score minutes.
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const C = require('../config');
const io = require('../lib/io');
const PBP = require('./pbp');
const VEN = require('../lib/venues');
const { toCsv } = require('../../engine/csv');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; }
const flag = (n) => process.argv.includes('--' + n);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const truthy = (v) => v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1';
const isoS = (t) => new Date(t).toISOString().replace(/\.000Z$/, 'Z');
const EXHIBITION = /all-star|all star|rising stars|celebrity|skills challenge|exhibition/i;
const BUBBLE_FROM = Date.parse('2020-07-29T00:00:00Z');

const GAME_COLS = ['game_id', 'season', 'type', 'date', 'start_utc', 'neutral', 'bubble', 'home_id', 'away_id', 'hs', 'as', 'ot',
  'h_q1', 'h_q2', 'h_q3', 'h_q4', 'h_ot', 'a_q1', 'a_q2', 'a_q3', 'a_q4', 'a_ot', 'venue', 'city', 'state', 'attendance',
  'ref_line_home', 'pbp', 'status', 'src', 'known_at', 'assumed_available_at', 'pit', 'scope'];
const TG_COLS = ['game_id', 'season', 'date', 'start_utc', 'team_id', 'opp_id', 'home', 'neutral', 'pts', 'opp_pts', 'min',
  'fgm', 'fga', 'fg3m', 'fg3a', 'ftm', 'fta', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf', 'paint_pts', 'fb_pts', 'pts_off_tov', 'poss',
  'rim_a', 'rim_m', 'paint_a', 'paint_m', 'mid_a', 'mid_m', 'c3_a', 'c3_m', 'ab3_a', 'ab3_m', 'tr_a', 'tr_pts', 'heave',
  'city', 'travel_km', 'tz_shift', 'alt', 'rest_days', 'b2b', 'games_7d', 'road_streak', 'home_streak', 'assumed_available_at'];

/* DNP reason → a category (only read when did_not_play is true: the source
   fills "COACH'S DECISION" on rows of players who played) */
function reasonCat(r) {
  const s = String(r || '').toUpperCase();
  if (!s) return 'UNKNOWN';
  if (/COACH/.test(s)) return 'COACH';
  if (/SUSPEND/.test(s)) return 'SUSPENSION';
  if (/G LEAGUE|G-LEAGUE|ASSIGN|TWO-WAY/.test(s)) return 'ASSIGNMENT';
  if (/PERSONAL|NOT WITH TEAM|FAMILY|BEREAVE|BIRTH/.test(s)) return 'PERSONAL';
  if (/^REST$|REST\b|LOAD MANAGEMENT/.test(s) && !/INJURY|SORE|SPRAIN|STRAIN/.test(s)) return 'REST';
  if (/ILLNESS|SICK|PROTOCOL|COVID|HEALTH AND SAFETY/.test(s)) return 'ILLNESS';
  return 'INJURY';
}

/* the possessions estimator (Basketball-Reference / Oliver form), averaged over both teams */
function possEst(t, o) {
  const one = (a, b) => a.fga + 0.4 * a.fta - 1.07 * (a.oreb / Math.max(1, a.oreb + b.dreb)) * (a.fga - a.fgm) + a.tov;
  return 0.5 * (one(t, o) + one(o, t));
}

function linescore(v) {
  if (v == null) return null;
  /* pyarrow writes the source's list<struct> as text; three layouts occur across
     seasons ({value} in period order; {displayValue, period, value};
     {value, displayValue, period}). Each {...} is one period. */
  const out = []; const objs = String(v).match(/\{[^}]*\}/g) || [];
  objs.forEach((o, i) => {
    const val = /'value':\s*(-?[\d.]+)/.exec(o); const per = /'period':\s*([\d.]+)/.exec(o);
    if (val) out.push({ p: per ? Number(per[1]) : i + 1, v: Number(val[1]) });
  });
  return out.length ? out : null;
}

async function readSource(kind, season, offline) {
  const src = await io.fetchSource(C.SOURCES[kind](season), { offline, ttlMs: season >= C.currentSeason() - 1 ? 6 * 3600e3 : 30 * 86400e3 });
  return src;
}

async function ingest(season, o) {
  o = o || {};
  const cur = C.currentSeason();
  const report = { season, sources: {}, counts: {}, dropped: {}, integrity: {}, missing_columns: {} };
  const prov = (kind, s) => { report.sources[kind] = s.ok ? { url: s.url, sha256: s.sha256, bytes: s.bytes, fetched_at: s.fetched_at, stale: !!s.stale } : { url: s.url, error: s.not_found ? 'NOT_PUBLISHED' : String(s.error) }; };

  /* ---------- schedule → games */
  const sch = await readSource('schedule', season, o.offline); prov('schedule', sch);
  if (!sch.ok) return { season, ok: false, report };
  const { rows: srows, missing: smiss } = await io.parquetAll(sch.file, C.COLUMNS.schedule);
  report.missing_columns.schedule = smiss;
  const drop = { preseason: 0, other_type: 0, exhibition: 0, not_played: 0, missing_score: 0, duplicates: 0, non_club: 0 };
  const games = new Map(); const names = {}; const abbrs = {};
  for (const r of srows) {
    const st = num(r.season_type);
    if (st === 1) { drop.preseason++; continue; }
    if (st !== 2 && st !== 3 && st !== 5) { drop.other_type++; continue; }
    if (EXHIBITION.test(String(r.notes_headline || '')) || /^Team /.test(String(r.home_display_name || ''))) { drop.exhibition++; continue; }
    /* club games only (the NBA Data Pack's rule): both team ids are franchises 1-30. This drops an All-Star game the
       source left without a note (2003: East vs West) and the Cup knockout placeholders whose teams are TBD (−1/−2;
       they return under the same game id once ESPN fills in the clubs). */
    const club = (id) => { const n = Number(id); return Number.isInteger(n) && n >= 1 && n <= 30; };
    if (!club(r.home_id) || !club(r.away_id)) { drop.non_club++; continue; }
    const start = String(r.date || '').replace(/Z$/, ':00Z').replace(/:00:00Z$/, ':00Z');
    const t = Date.parse(start);
    const done = truthy(r.status_type_completed), nm = String(r.status_type_name || '');
    let status;
    if (done && nm === 'STATUS_FINAL') status = 'FINAL';
    else if (!done && /SCHEDULED|STATUS_TBD/.test(nm) && season >= cur) status = 'SCHEDULED';
    else { drop.not_played++; continue; }
    const hs = num(r.home_score), as = num(r.away_score);
    if (status === 'FINAL' && (hs == null || as == null)) { drop.missing_score++; continue; }
    const gid = String(r.game_id);
    if (games.has(gid)) drop.duplicates++;
    const per = num(r.status_period), reg = num(r.format_regulation_periods) || 4;
    const bubble = season === 2020 && isFinite(t) && t >= BUBBLE_FROM ? 1 : 0;
    const hl = linescore(r.home_linescores), al = linescore(r.away_linescores);
    games.set(gid, {
      game_id: gid, season, type: st === 2 ? 'R' : st === 5 ? 'I' : 'P', date: isFinite(t) ? isoS(t - 10 * 3600e3).slice(0, 10) : '', start_utc: isFinite(t) ? isoS(t) : '',
      neutral: truthy(r.neutral_site) || bubble ? 1 : 0, bubble, home_id: String(r.home_id), away_id: String(r.away_id),
      hs: status === 'FINAL' ? hs : '', as: status === 'FINAL' ? as : '', ot: status === 'FINAL' && per != null ? Math.max(0, per - reg) : '',
      _hl: hl, _al: al, venue: r.venue_full_name || '', city: r.venue_address_city || '', state: r.venue_address_state || '', attendance: num(r.attendance) == null ? '' : num(r.attendance),
      ref_line_home: '', pbp: 0, status, src: 'S', known_at: '', assumed_available_at: status === 'FINAL' && isFinite(t) ? isoS(t + 4 * 3600e3) : '', pit: 'RETRO',
      /* the competition scope (the NBA Data Pack's rule): the NBA Cup final is season type 2 but its native competition type is CC (id 39) and it does not
         count toward the regular season; Cup group, quarter- and semi-final games do. Every scope is a real game for the ratings. */
      scope: st === 3 ? 'playoffs' : st === 5 ? 'play_in' : (String(r.type_abbreviation || '') === 'CC' || String(r.type_id || '') === '39') ? 'nba_cup_final' : 'regular_season',
    });
    names[String(r.home_id)] = r.home_display_name || names[String(r.home_id)];
    names[String(r.away_id)] = r.away_display_name || names[String(r.away_id)];
    if (r.home_abbreviation) abbrs[String(r.home_id)] = r.home_abbreviation;
    if (r.away_abbreviation) abbrs[String(r.away_id)] = r.away_abbreviation;
  }
  report.dropped = drop;

  const finals = [...games.values()].filter((g) => g.status === 'FINAL');
  report.counts.games_final = finals.length;
  report.counts.games_scheduled = games.size - finals.length;
  report.counts.by_scope = Object.fromEntries(['regular_season', 'nba_cup_final', 'play_in', 'playoffs'].map((k) => [k, finals.filter((g) => g.scope === k).length]));
  if (!finals.length) {
    /* the season in progress before its first game: schedule only */
    return finish(season, games, [], [], [], [], {}, names, report, o, null, abbrs);
  }

  /* ---------- team box */
  const tb = await readSource('team_box', season, o.offline); prov('team_box', tb);
  const box = new Map(); /* game → team → stats */
  if (tb.ok) {
    const { rows, missing } = await io.parquetAll(tb.file, C.COLUMNS.team_box);
    report.missing_columns.team_box = missing;
    for (const r of rows) {
      const gid = String(r.game_id); if (!games.has(gid)) continue;
      const tov = num(r.total_turnovers) != null ? num(r.total_turnovers) : num(r.turnovers);
      if (!box.has(gid)) box.set(gid, {});
      box.get(gid)[String(r.team_id)] = {
        pts: num(r.team_score), fgm: num(r.field_goals_made), fga: num(r.field_goals_attempted), fg3m: num(r.three_point_field_goals_made), fg3a: num(r.three_point_field_goals_attempted),
        ftm: num(r.free_throws_made), fta: num(r.free_throws_attempted), oreb: num(r.offensive_rebounds), dreb: num(r.defensive_rebounds), ast: num(r.assists), stl: num(r.steals),
        blk: num(r.blocks), tov, pf: num(r.fouls), paint_pts: num(r.points_in_paint), fb_pts: num(r.fast_break_points), pts_off_tov: num(r.turnover_points),
      };
    }
  }

  /* ---------- player box */
  const pb = await readSource('player_box', season, o.offline); prov('player_box', pb);
  const pgames = []; const roster = new Map(); /* game → Map(pid → team) */ const startersBy = new Map(); const minsBy = new Map();
  const zeroMin = new Map(); /* game|player → pgames index: listed with 0 minutes, not flagged DNP, no stat — the play-by-play decides */
  const players = {};
  if (pb.ok) {
    const { rows, missing } = await io.parquetAll(pb.file, C.COLUMNS.player_box);
    report.missing_columns.player_box = missing;
    for (const r of rows) {
      const gid = String(r.game_id); if (!games.has(gid)) continue;
      const pid = String(r.athlete_id), tid = String(r.team_id);
      if (!pid || pid === 'null') continue;
      const mins = num(r.minutes);
      const dnp = truthy(r.did_not_play) || mins == null || mins === 0;
      /* played: minutes, or (listed with 0 minutes and not flagged DNP) a counted stat; the play-by-play below adds the
         zero-minute entries it finds on court. A 0:10 garbage-time appearance is an appearance (a prop on him has action). */
      const anyStat = ['points', 'field_goals_attempted', 'free_throws_attempted', 'offensive_rebounds', 'defensive_rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fouls'].some((k) => (num(r[k]) || 0) > 0);
      const played = (mins != null && mins > 0) || (mins === 0 && !truthy(r.did_not_play) && anyStat) ? 1 : 0;
      if (!roster.has(gid)) { roster.set(gid, new Map()); startersBy.set(gid, {}); minsBy.set(gid, new Map()); }
      roster.get(gid).set(pid, tid);
      minsBy.get(gid).set(pid, mins || 0);
      const st = truthy(r.starter) && played ? 1 : 0;
      if (st) { const s = startersBy.get(gid); (s[tid] = s[tid] || []).push(pid); }
      if (mins === 0 && !played && !truthy(r.did_not_play)) zeroMin.set(gid + '|' + pid, pgames.length);
      pgames.push({ g: gid, tm: tid, p: pid, st, pl: played, dnp: dnp && !played ? 1 : 0, rc: dnp && !played && truthy(r.did_not_play) ? reasonCat(r.reason) : (played ? '' : 'UNLISTED'),
        min: mins || 0, pts: num(r.points) || 0, fgm: num(r.field_goals_made) || 0, fga: num(r.field_goals_attempted) || 0, f3m: num(r.three_point_field_goals_made) || 0, f3a: num(r.three_point_field_goals_attempted) || 0,
        ftm: num(r.free_throws_made) || 0, fta: num(r.free_throws_attempted) || 0, or: num(r.offensive_rebounds) || 0, dr: num(r.defensive_rebounds) || 0,
        ast: num(r.assists) || 0, stl: num(r.steals) || 0, blk: num(r.blocks) || 0, tov: num(r.turnovers) || 0, pf: num(r.fouls) || 0, pm: num(r.plus_minus), ej: truthy(r.ejected) ? 1 : 0 });
      const cur0 = players[pid];
      if (!cur0 || played) players[pid] = { name: r.athlete_display_name || (cur0 && cur0.name) || null, pos: r.athlete_position_abbreviation || (cur0 && cur0.pos) || null, team: tid, season };
    }
  }

  /* ---------- play-by-play: stints, shots, period scores, PBP team counts */
  const pp = await readSource('pbp', season, o.offline); prov('pbp', pp);
  const stints = [], shots = [], pteam = {};
  const integ = { pbp_games: 0, pbp_final_mismatch: 0, pbp_final_examples: [], stint_seconds_off: 0, bad_lineup_seconds: 0, total_seconds: 0, sub_errors: 0, starters_bad: 0,
    minutes_abs_err: 0, minutes_n: 0, minutes_big_err: 0, fragmented: 0, zero_minute_appearances: 0 };
  if (pp.ok) {
    let curId = null, buf = [];
    const done = new Set();
    const flush = () => {
      if (!curId) return;
      const g = games.get(curId);
      if (g && g.status === 'FINAL') {
        if (done.has(curId)) integ.fragmented++;
        done.add(curId);
        const ros = roster.get(curId) || new Map();
        const r = PBP.processGame(buf, { home: g.home_id, away: g.away_id, roster: ros, starters: startersBy.get(curId) || {}, minutes: minsBy.get(curId) || new Map() });
        integ.pbp_games++;
        g.pbp = 1;
        if (r.final.h !== g.hs || r.final.a !== g.as) { integ.pbp_final_mismatch++; if (integ.pbp_final_examples.length < 5) integ.pbp_final_examples.push({ game_id: curId, pbp: r.final, official: { h: g.hs, a: g.as } }); }
        if (r.spread.available) g.ref_line_home = r.spread.line_home;
        g._pbpPeriods = r.periods;
        const len = PBP.REG + PBP.OT * (Number(g.ot) || 0);
        integ.total_seconds += r.issues.total_seconds; integ.bad_lineup_seconds += r.issues.bad_lineup_seconds; integ.sub_errors += r.issues.sub_errors; integ.starters_bad += r.issues.starters_bad;
        if (Math.abs(r.issues.total_seconds - len) > 1) integ.stint_seconds_off++;
        for (const [pid, m] of minsBy.get(curId) || new Map()) {
          const sec = r.onCourt.get(pid) || 0;
          const zi = zeroMin.get(curId + '|' + pid);
          if (zi != null && sec > 0) { const x = pgames[zi]; x.pl = 1; x.dnp = 0; x.rc = ''; integ.zero_minute_appearances++; }
          if (m > 0 || sec > 0) { const e = Math.abs(sec / 60 - m); integ.minutes_abs_err += e; integ.minutes_n++; if (e > 3) integ.minutes_big_err++; }
        }
        stints.push({ g: curId, s: r.stints.map((s) => [s.t0, s.t1, s.h5.join(' '), s.a5.join(' '), s.hp, s.ap, s.hfga, s.afga, s.hfta, s.afta, s.hor, s.aor, s.htov, s.atov, s.ok]) });
        for (const s of r.shots) shots.push([curId, s.per, s.t, s.tm, s.sh, s.mk, s.v, s.ast, s.blk, s.x, s.y, s.d, s.ty, s.tr, s.lead, s.clk]);
        pteam[curId] = r.team;
      }
      buf = [];
    };
    let missingP = [];
    for await (const r of io.parquetRows(pp.file, C.COLUMNS.pbp, (m) => { missingP = m; })) {
      const gid = String(r.game_id);
      if (gid !== curId) { flush(); curId = gid; }
      buf.push(r);
    }
    flush();
    report.missing_columns.pbp = missingP;
  }
  report.integrity = integ;
  return finish(season, games, box, pgames, stints, shots, pteam, names, report, o, players, abbrs);
}

function finish(season, games, box, pgames, stints, shots, pteam, names, report, o, players, abbrs) {
  const list = [...games.values()].filter((g) => g.date).sort((a, b) => (a.start_utc < b.start_utc ? -1 : a.start_utc > b.start_utc ? 1 : a.game_id < b.game_id ? -1 : 1));
  /* period scores: the schedule's linescores (2019-20 on), else the play-by-play's */
  let lsrc = { schedule: 0, pbp: 0, none: 0 }, lsMismatch = 0;
  for (const g of list) {
    if (g.status !== 'FINAL') { delete g._hl; delete g._al; delete g._pbpPeriods; continue; }
    let per = null;
    if (g._hl && g._al && g._hl.length >= 4) { per = g._hl.map((x, i) => ({ p: x.p, h: x.v, a: g._al[i] ? g._al[i].v : null })); lsrc.schedule++; }
    else if (g._pbpPeriods && g._pbpPeriods.length >= 4) { per = g._pbpPeriods; lsrc.pbp++; }
    else lsrc.none++;
    if (per) {
      const sumH = per.reduce((a, x) => a + (x.h || 0), 0), sumA = per.reduce((a, x) => a + (x.a || 0), 0);
      if (sumH !== g.hs || sumA !== g.as) { lsMismatch++; per = null; }
    }
    for (let q = 1; q <= 4; q++) { const x = per && per.find((y) => y.p === q); g['h_q' + q] = x ? x.h : ''; g['a_q' + q] = x ? x.a : ''; }
    g.h_ot = per ? per.filter((y) => y.p > 4).reduce((a, y) => a + y.h, 0) : ''; g.a_ot = per ? per.filter((y) => y.p > 4).reduce((a, y) => a + y.a, 0) : '';
    delete g._hl; delete g._al; delete g._pbpPeriods;
  }
  report.integrity.period_scores = Object.assign(lsrc, { sum_mismatch_dropped: lsMismatch });

  /* team-game rows, with schedule context computed in start order */
  const tg = [];
  const finals = list.filter((g) => g.status === 'FINAL');
  let boxMismatch = 0, boxMissing = 0;
  const homeCity = {}; /* team → most common home city this season (fallback for a missing city) */
  for (const g of list) if (!g.neutral && g.city) { const m = (homeCity[g.home_id] = homeCity[g.home_id] || {}); m[g.city] = (m[g.city] || 0) + 1; }
  const cityOf = (g) => g.city || (() => { const m = homeCity[g.home_id] || {}; return Object.keys(m).sort((a, b) => m[b] - m[a])[0] || ''; })();
  const last = {}; /* team → { t, city, home } */
  const recent = {}; /* team → [start ms] */
  const streak = {};
  /* THE SCHEDULE CONTEXT ADVANCES OVER EVERY GAME THAT IS OR WILL BE PLAYED
     (audit_report.md §8.3 N1). It used to advance over FINAL games only, so the
     second leg of a back-to-back whose first leg was not yet played was served
     rest 3, b2b 0, games_7d 0 and no travel — values no training row (all
     final) ever had. A SCHEDULED game counts when it is still ahead (started
     no more than 6 hours ago): a past-dated game that never went final was
     postponed, and it never counts. Box-score fields stay FINAL-only. */
  const nowMs = o && o.now != null ? Date.parse(o.now) : Date.now();
  const playedOrAhead = (g, t) => g.status === 'FINAL' || (g.status === 'SCHEDULED' && isFinite(t) && t >= nowMs - 6 * 3600e3);
  for (const g of list) {
    const t = Date.parse(g.start_utc); const city = cityOf(g); const here = VEN.geo(city);
    for (const side of ['h', 'a']) {
      const tid = side === 'h' ? g.home_id : g.away_id, oid = side === 'h' ? g.away_id : g.home_id;
      const L = last[tid];
      const prev = L ? VEN.geo(L.city) : null;
      const rest = L ? Math.round((t - L.t) / 864e5 * 10) / 10 : '';
      const r7 = (recent[tid] || []).filter((x) => t - x <= 7 * 864e5).length;
      const st = streak[tid] || { road: 0, home: 0 };
      const isHome = side === 'h' && !g.neutral ? 1 : 0, isRoad = side === 'a' && !g.neutral ? 1 : 0;
      const row = { game_id: g.game_id, season, date: g.date, start_utc: g.start_utc, team_id: tid, opp_id: oid, home: side === 'h' ? 1 : 0, neutral: g.neutral,
        city, travel_km: prev && here ? Math.round(VEN.km(prev, here)) : '', tz_shift: prev && here ? here.tz - prev.tz : '', alt: here ? here.alt : '',
        rest_days: rest, b2b: L && t - L.t <= 30 * 3600e3 ? 1 : 0, games_7d: r7, road_streak: isRoad ? st.road + 1 : 0, home_streak: isHome ? st.home + 1 : 0,
        assumed_available_at: g.assumed_available_at };
      if (g.status === 'FINAL') {
        const b = box && box.get ? (box.get(g.game_id) || {})[tid] : null, ob = box && box.get ? (box.get(g.game_id) || {})[oid] : null;
        const P = (pteam[g.game_id] || {})[tid] || null;
        Object.assign(row, { pts: side === 'h' ? g.hs : g.as, opp_pts: side === 'h' ? g.as : g.hs, min: 48 + 5 * (Number(g.ot) || 0) });
        if (b && ob && b.fga != null) {
          if (b.pts != null && b.pts !== row.pts) boxMismatch++;
          Object.assign(row, { fgm: b.fgm, fga: b.fga, fg3m: b.fg3m, fg3a: b.fg3a, ftm: b.ftm, fta: b.fta, oreb: b.oreb, dreb: b.dreb, ast: b.ast, stl: b.stl, blk: b.blk, tov: b.tov, pf: b.pf,
            paint_pts: b.paint_pts == null ? '' : b.paint_pts, fb_pts: b.fb_pts == null ? '' : b.fb_pts, pts_off_tov: b.pts_off_tov == null ? '' : b.pts_off_tov,
            poss: Math.round(possEst(b, ob) * 10) / 10 });
        } else boxMissing++;
        if (P) for (const k of ['rim_a', 'rim_m', 'paint_a', 'paint_m', 'mid_a', 'mid_m', 'c3_a', 'c3_m', 'ab3_a', 'ab3_m', 'tr_a', 'tr_pts', 'heave']) row[k] = P[k];
      }
      if (playedOrAhead(g, t)) {
        last[tid] = { t, city };
        (recent[tid] = recent[tid] || []).push(t);
        streak[tid] = { road: isRoad ? st.road + 1 : 0, home: isHome ? st.home + 1 : 0 };
      }
      tg.push(row);
    }
  }
  report.integrity.team_box_points_mismatch = boxMismatch;
  report.integrity.team_box_missing = boxMissing;
  report.counts.team_games = tg.filter((r) => r.pts != null && r.pts !== '').length;
  report.counts.player_games = pgames.length;
  report.counts.player_games_played = pgames.filter((x) => x.pl).length;
  report.counts.stint_games = stints.length;
  report.counts.stints = stints.reduce((a, x) => a + x.s.length, 0);
  report.counts.shots = shots.length;
  const I = report.integrity;
  if (I.minutes_n) { I.minutes_mae = Math.round(I.minutes_abs_err / I.minutes_n * 1000) / 1000; I.minutes_share_off_3 = Math.round(I.minutes_big_err / I.minutes_n * 10000) / 10000; delete I.minutes_abs_err; delete I.minutes_big_err; }
  if (I.total_seconds) I.valid_lineup_share = Math.round((1 - I.bad_lineup_seconds / I.total_seconds) * 10000) / 10000;
  report.counts.ref_line_games = finals.filter((g) => g.ref_line_home !== '').length;

  if (!o.dryRun) {
    fs.mkdirSync(C.PATHS.games, { recursive: true }); fs.mkdirSync(C.PATHS.teamGames, { recursive: true });
    fs.writeFileSync(path.join(C.PATHS.games, season + '.csv'), toCsv(GAME_COLS, list));
    if (tg.length) fs.writeFileSync(path.join(C.PATHS.teamGames, season + '.csv'), toCsv(TG_COLS, tg));
    if (pgames.length) io.writeWork('player_games_' + season + '.json.gz', { schema: C.SCHEMA.player_games, season, rows: pgames });
    if (stints.length) io.writeWork('stints_' + season + '.json.gz', { schema: C.SCHEMA.stints, season, cols: ['t0', 't1', 'h5', 'a5', 'hp', 'ap', 'hfga', 'afga', 'hfta', 'afta', 'hor', 'aor', 'htov', 'atov', 'ok'], games: stints });
    if (shots.length) io.writeWork('shots_' + season + '.json.gz', { schema: C.SCHEMA.shots, season, cols: ['g', 'per', 't', 'tm', 'sh', 'mk', 'v', 'ast', 'blk', 'x', 'y', 'd', 'ty', 'tr', 'lead', 'clk'], rows: shots });
    /* the manifest, merged */
    let man = {}; try { man = JSON.parse(fs.readFileSync(C.PATHS.manifest, 'utf8')); } catch (_) {}
    man.schema = 'edgedesk_nba_manifest_v1';
    man.license = C.LICENSE;
    man.tables = { games: C.SCHEMA.games + ' (' + GAME_COLS.join(', ') + ')', team_games: C.SCHEMA.team_games + ' (' + TG_COLS.join(', ') + ')' };
    man.temporal = { known_at: 'blank on every row: first publication was never recorded; nothing is backdated', assumed_available_at: 'scheduled start + 4 h', pit: 'RETRO (retrieved after the fact from a source that can revise)' };
    man.seasons = man.seasons || {};
    man.seasons[season] = Object.assign({ updated_at: new Date().toISOString() }, report);
    fs.writeFileSync(C.PATHS.manifest, JSON.stringify(man, null, 1) + '\n');
    /* team names and players (merged across seasons) */
    let teams = {}; try { teams = JSON.parse(fs.readFileSync(C.PATHS.teams, 'utf8')); } catch (_) {}
    for (const [k, v] of Object.entries(names)) if (v && !/^Team /.test(v)) teams[k] = v;
    /* the 30 franchises only: an All-Star side or a TBD placeholder is never a team */
    for (const k of Object.keys(teams)) if (!(Number(k) >= 1 && Number(k) <= 30)) delete teams[k];
    fs.writeFileSync(C.PATHS.teams, JSON.stringify(teams, Object.keys(teams).sort((a, b) => a - b), 0) + '\n');
    const af = path.join(C.NBA, 'data', 'team_abbr.json');
    let ab = {}; try { ab = JSON.parse(fs.readFileSync(af, 'utf8')); } catch (_) {}
    for (const [k, v] of Object.entries(abbrs || {})) if (v && teams[k]) ab[k] = v;
    for (const k of Object.keys(ab)) if (!teams[k]) delete ab[k];
    fs.writeFileSync(af, JSON.stringify(ab, Object.keys(ab).sort((a, b) => a - b), 0) + '\n');
    if (players) {
      const pf = path.join(C.NBA, 'data', 'players.json');
      let all = {}; try { all = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) {}
      for (const [k, v] of Object.entries(players)) if (!all[k] || all[k].season <= v.season) all[k] = v;
      const keys = Object.keys(all).sort((a, b) => a - b); const out = {}; for (const k of keys) out[k] = all[k];
      fs.writeFileSync(pf, JSON.stringify(out) + '\n');
    }
  }
  return { season, ok: true, games: list, teamGames: tg, playerGames: pgames, stints, shots, report };
}

function seasons(spec) {
  const cur = C.currentSeason();
  if (!spec || spec === 'all') { const o = []; for (let s = C.FIRST_SEASON; s <= cur; s++) o.push(s); return o; }
  if (spec === 'current') return [cur];
  const m = /^(\d{4})-(\d{4})$/.exec(spec); if (m) { const o = []; for (let s = +m[1]; s <= +m[2]; s++) o.push(s); return o; }
  return String(spec).split(',').map(Number);
}

module.exports = { ingest, finish, reasonCat, possEst, linescore, GAME_COLS, TG_COLS, seasons };

if (require.main === module) {
  (async () => {
    const failed = [];
    for (const s of seasons(arg('season', 'current'))) {
      const t0 = Date.now();
      const r = await ingest(s, { offline: flag('offline') });
      const errs = Object.values((r.report && r.report.sources) || {}).map((x) => x && x.error).filter(Boolean);
      if (!r.ok && !(errs.length && errs.every((e) => e === 'NOT_PUBLISHED'))) failed.push(s);
      const I = r.report.integrity || {};
      console.log('[nba ingest] ' + s + ': ' + (r.ok ? (r.report.counts.games_final + ' final, ' + (r.report.counts.games_scheduled || 0) + ' scheduled, ' + (r.report.counts.player_games || 0) + ' player-games, ' + (r.report.counts.stints || 0) + ' stints, ' + (r.report.counts.shots || 0) + ' shots | pbp ' + (I.pbp_games || 0) + ' games, final mismatch ' + (I.pbp_final_mismatch || 0) + ', valid lineups ' + (I.valid_lineup_share == null ? '—' : I.valid_lineup_share) + ', minutes MAE ' + (I.minutes_mae == null ? '—' : I.minutes_mae) + ', box mismatch ' + (I.team_box_points_mismatch || 0)) : 'FAILED ' + JSON.stringify(r.report.sources)) + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
    }
    /* a failed season exits non-zero (a source not yet published upstream is not a failure): CI's
       `--offline || online` fallback depends on it, and a build must never go on to price with a season
       silently missing (a cold cache once did exactly that) */
    if (failed.length) { console.error('[nba ingest] FAILED for season(s) ' + failed.join(', ')); process.exit(1); }
  })().catch((e) => { console.error(e); process.exit(1); });
}
