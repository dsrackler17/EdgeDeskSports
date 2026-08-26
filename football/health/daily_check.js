#!/usr/bin/env node
/* ============================================================================
   EdgeDesk Football — DAILY SELF-CHECK & LEARNING RUN.

   This is the scheduled job behind the app's "Model health" panel and its
   freshness stamp. Once a day (`.github/workflows/model-health.yml`) it
   re-runs the SAME runtime data path the app runs in the browser, headless:

     1. engine integrity   — both node test suites (python-parity goldens)
     2. learning           — fetch the live schedules, absorb every completed
                             game into the trained seeds, exactly as the
                             boards do on load; verify games actually absorb
     3. projections        — project the upcoming slate; every number must be
                             finite and inside sane bounds
     4. line guard         — compare model fair spreads to the joined market
                             numbers. A gap beyond the hard bound is treated
                             as a DATA FAULT (bad join, sign flip, stale
                             roster), never as an edge
     5. season window      — the engines' data-quality gate blocks seasons
                             beyond trained_through+1; this run says loudly
                             when a retrain is due instead of going dark

   It then writes football/health.json — generated_at, per-check pass/warn/
   fail, learning counts, line-guard summary, and pipeline_meta in the
   *_last_run/*_last_status convention the app's pipeline ledger renders.
   The app reads that file; a missed run surfaces as staleness, a failed
   check surfaces by name. Nothing is ever invented to look healthy.

   Sources (all the same ones the browser uses):
     nflverse games.csv + stats_team_week   public, keyless
     cfbfastR-data schedules                public, keyless
     Supabase cfb.games / cfb.lines        read-only anon key (the same
                                            public-safe key app.html ships;
                                            RLS allows select only)

   Usage:  node football/health/daily_check.js [--out PATH] [--skip-tests]
   Exit:   0 = report written, no check FAILED (warnings allowed)
           2 = report written, at least one check FAILED
           1 = crashed before a report could be written
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
require(path.join(REPO, 'football', 'params.js'));
const E = require(path.join(REPO, 'football', 'engine.js'));
const FP = global.window.EDFootballParams;
require(path.join(REPO, 'football', 'cfb_p4', 'params.js'));
const E4 = require(path.join(REPO, 'football', 'cfb_p4', 'engine.js'));
const P4 = global.window.EDCfbP4Params;

/* Read-only anon key — the identical public-safe key app.html already ships
   to every browser; RLS allows select only. Overridable for a fork. */
const SB_URL = process.env.EDGEDESK_SUPABASE_URL || 'https://iattxbkbufslbauoumga.supabase.co';
const SB_KEY = process.env.EDGEDESK_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhdHR4YmtidWZzbGJhdW91bWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2MzY4MDUsImV4cCI6MjA5NzIxMjgwNX0.Mly5G587o5IFRnEigU2wRp9buWEk3dFwH9RNPJK7Uo8';

const URL_GAMES = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';
const URL_STW = y => `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${y}.csv`;
const URL_CFB_SCHED = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`;
const URL_CFB_ROSTER = y => `https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/rosters/csv/cfb_rosters_${y}.csv`;

const LOOKAHEAD_D = 10;

/* Line-guard bounds. These detect DYSFUNCTION, not edges: a wrong roster
   join, a sign flip or an FCS team absorbed as FBS produces 20+ point gaps
   instantly, while the models' own held-out records say honest disagreement
   with the market stays single-digit on almost every slate. */
const GUARD = {
  nfl: { game: 14, outlier: 7, median: 5 },
  p4: { game: 21, outlier: 10, median: 7 },
  market: { spread: 60, total_lo: 20, total_hi: 100 }
};

/* ------------------------------------------------------------ utilities */
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const hd = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(hd.map((h, i) => [h, (r[i] === '' || r[i] === 'NA') ? null : r[i]])));
}
const num = x => { if (x == null || x === '') return null; const v = +x; return isFinite(v) ? v : null; };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

async function fetchText(url, headers) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, { headers: headers || {}, redirect: 'follow',
        signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.text();
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise(res => setTimeout(res, 3000));
    }
  }
  throw lastErr;
}
async function sbGet(q) {
  const t = await fetchText(`${SB_URL}/rest/v1/${q}`, {
    apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'accept-profile': 'cfb'
  });
  return JSON.parse(t);
}

/* ------------------------------------------------------------ the report */
const checks = [];
let overallFail = false;
function check(id, label, status, detail) {
  checks.push({ id, label, status, detail: detail == null ? '' : String(detail) });
  if (status === 'fail') overallFail = true;
  console.log(`${status.toUpperCase().padEnd(4)} | ${id} | ${label}${detail ? ' | ' + detail : ''}`);
}

function medianOf(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* Guarded market comparison for one slate. rows: {label, model, market}. */
function lineGuard(id, sportLabel, rows, lim) {
  const gaps = rows.map(r => ({ ...r, gap: Math.abs(r.model - r.market) }));
  const badMarket = rows.filter(r => Math.abs(r.market) > GUARD.market.spread);
  if (badMarket.length) {
    check(id + '_market', sportLabel + ': market lines plausible', 'fail',
      badMarket.map(r => `${r.label} market ${r.market}`).join('; '));
  } else {
    check(id + '_market', sportLabel + ': market lines plausible', 'pass',
      rows.length ? rows.length + ' lines inside plausible bounds' : 'no market lines to test');
  }
  if (!gaps.length) {
    check(id, sportLabel + ': model vs market line guard', 'pass',
      'no market number joined to any upcoming game — nothing to compare');
    return { compared: 0, median_gap: null, max_gap: null, outliers: [] };
  }
  const med = medianOf(gaps.map(g => g.gap));
  const max = Math.max(...gaps.map(g => g.gap));
  const outliers = gaps.filter(g => g.gap > lim.outlier)
    .sort((a, b) => b.gap - a.gap).slice(0, 8)
    .map(g => ({ game: g.label, gap: r2(g.gap), model: r2(g.model), market: r2(g.market) }));
  const broken = gaps.filter(g => g.gap > lim.game);
  if (broken.length) {
    check(id, sportLabel + ': model vs market line guard', 'fail',
      broken.map(g => `${g.label} gap ${r2(g.gap)} pts (model ${r2(g.model)} vs market ${r2(g.market)})`).join('; ')
      + ` — beyond the ${lim.game}-pt hard bound; treat as a data fault, not an edge`);
  } else if (med > lim.median || outliers.length) {
    check(id, sportLabel + ': model vs market line guard', 'warn',
      `median gap ${r2(med)} pts over ${gaps.length} games`
      + (outliers.length ? `; ${outliers.length} game(s) beyond ${lim.outlier} pts` : ''));
  } else {
    check(id, sportLabel + ': model vs market line guard', 'pass',
      `median gap ${r2(med)} pts over ${gaps.length} games, max ${r2(max)}`);
  }
  return { compared: gaps.length, median_gap: r2(med), max_gap: r2(max), outliers };
}

/* --------------------------------------------------------- engine tests */
function runEngineTests() {
  let ok = true;
  for (const rel of ['football/tests.js', 'football/cfb_p4/tests.js']) {
    const r = spawnSync(process.execPath, [path.join(REPO, rel)],
      { encoding: 'utf8', timeout: 180000 });
    const green = r.status === 0;
    if (!green) ok = false;
    check('engine_tests_' + (rel.includes('cfb_p4') ? 'p4' : 'nfl'),
      'engine test suite ' + rel + ' (incl. python-parity goldens)',
      green ? 'pass' : 'fail',
      green ? (String(r.stdout).trim().split('\n').pop() || '')
            : String((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-5).join(' · '));
  }
  return ok;
}

/* -------------------------------------------------------------- NFL path */
async function nflSection(out) {
  const games = parseCsv(await fetchText(URL_GAMES));
  check('nfl_schedule', 'NFL: nflverse games.csv reachable',
    games.length > 7000 ? 'pass' : 'fail', games.length + ' rows');
  const maxSeason = Math.max(...games.map(g => num(g.season) || 0));
  out.seasons.nfl = maxSeason;

  const st = E.nfl.newState();
  check('nfl_season_window', 'NFL: current season inside the trained window',
    maxSeason <= st.seededThrough + 1 ? 'pass' : 'fail',
    `season ${maxSeason} vs seeds through ${st.seededThrough}` +
    (maxSeason <= st.seededThrough + 1 ? '' : ' — the data-quality gate will BLOCK; a retrain is due (football/research/)'));
  for (let y = st.seededThrough; y < maxSeason; y++) E.nfl.seasonBreak(st);

  const toAbsorb = games.filter(g => {
    const s = num(g.season);
    return s && s > st.seededThrough && s <= maxSeason && g.home_score != null && g.away_score != null;
  });
  let absorbed = 0, joinMissed = 0, dataThrough = null;
  if (toAbsorb.length) {
    const byGame = {};
    for (const y of [...new Set(toAbsorb.map(g => num(g.season)))]) {
      try {
        parseCsv(await fetchText(URL_STW(y))).forEach(x =>
          (byGame[x.game_id] = byGame[x.game_id] || []).push(x));
      } catch (e) {
        check('nfl_stats_' + y, `NFL: stats_team_week_${y} reachable`, 'warn',
          `${(e && e.message) || 'fetch failed'} — ${y} results not absorbed (the app degrades the same way)`);
      }
    }
    toAbsorb.sort((a, b) => String(a.gameday).localeCompare(String(b.gameday)) || String(a.game_id).localeCompare(String(b.game_id)));
    for (const g of toAbsorb) {
      const pair = byGame[g.game_id];
      if (!pair || pair.length !== 2) { joinMissed++; continue; }
      const hRow = pair.find(x => x.team === g.home_team), aRow = pair.find(x => x.team === g.away_team);
      if (!hRow || !aRow) { joinMissed++; continue; }
      const hr = E.nfl.teamGameFromStw(hRow), ar = E.nfl.teamGameFromStw(aRow);
      hr.pts_for = num(g.home_score); hr.pts_against = num(g.away_score);
      ar.pts_for = num(g.away_score); ar.pts_against = num(g.home_score);
      E.nfl.absorbGame(st, [[g.home_team, hr], [g.away_team, ar]], []);
      absorbed++;
      if (!dataThrough || String(g.gameday) > dataThrough) dataThrough = String(g.gameday);
    }
  }
  out.learning.nfl = { completed_in_feed: toAbsorb.length, absorbed, join_missed: joinMissed,
    data_through: dataThrough, source: 'nflverse games.csv + stats_team_week' };
  if (toAbsorb.length && !absorbed) {
    check('nfl_ingest', 'NFL: completed games absorb into the ratings', 'fail',
      `${toAbsorb.length} completed post-seed games in the feed but 0 absorbed — the learning path is broken`);
  } else if (joinMissed > Math.max(2, toAbsorb.length * 0.1)) {
    check('nfl_ingest', 'NFL: completed games absorb into the ratings', 'warn',
      `${absorbed}/${toAbsorb.length} absorbed; ${joinMissed} missed the stats join`);
  } else {
    check('nfl_ingest', 'NFL: completed games absorb into the ratings', 'pass',
      toAbsorb.length ? `${absorbed}/${toAbsorb.length} absorbed, data through ${dataThrough}`
        : `no completed ${maxSeason} games in the feed yet — seeds + season carry-over is the correct state`);
  }

  /* upcoming slate: project and guard */
  const now = Date.now(), hi = now + LOOKAHEAD_D * 864e5;
  const up = games.filter(g => num(g.season) === maxSeason && g.home_score == null)
    .map(g => ({ g, t: Date.parse(`${g.gameday}T${g.gametime || '12:00'}:00`) }))
    .filter(u => isFinite(u.t) && u.t >= now - 6 * 3600e3 && u.t <= hi)
    .sort((a, b) => a.t - b.t).slice(0, 32);
  let predicted = 0, insane = [];
  const guardRows = [];
  for (const u of up) {
    const g = u.g;
    let p;
    try {
      p = E.predictGame({ sport: 'nfl', state: st, season: maxSeason,
        game: { home: g.home_team, away: g.away_team, week: num(g.week),
          home_rest: num(g.home_rest), away_rest: num(g.away_rest),
          roof: g.roof, surface: g.surface, div_game: num(g.div_game),
          temp: num(g.temp), wind: num(g.wind),
          home_qb_id: g.home_qb_id || null, away_qb_id: g.away_qb_id || null },
        market: { spread_line: num(g.spread_line), total_line: num(g.total_line) } });
    } catch (e) { insane.push(`${g.away_team} @ ${g.home_team}: engine threw (${(e && e.message) || 'error'})`); continue; }
    if (!p || p.status !== 'PREDICTED') continue;
    predicted++;
    const m = p.model;
    /* a null total is the engine DECLARING the number unavailable, which is
       its honest state — only a total that is present and outside bounds
       (or NaN) is insane. isFinite(null) is true in JS, so null must be
       excluded explicitly or it reads as a 0-point total. */
    if (!isFinite(m.fair_spread) || Math.abs(m.fair_spread) > 30
      || (m.fair_total != null && (!isFinite(m.fair_total) || m.fair_total < 20 || m.fair_total > 80))
      || !(m.home_win_prob >= 0) || !(m.home_win_prob <= 1)) {
      insane.push(`${g.away_team} @ ${g.home_team}: spread ${r2(m.fair_spread)}, total ${r2(m.fair_total)}, p ${r2(m.home_win_prob)}`);
    }
    if (num(g.spread_line) != null && isFinite(m.fair_spread)) {
      guardRows.push({ label: `${g.away_team} @ ${g.home_team}`, model: m.fair_spread, market: num(g.spread_line) });
    }
  }
  check('nfl_projections', 'NFL: upcoming slate projects to sane numbers',
    insane.length ? 'fail' : 'pass',
    insane.length ? insane.slice(0, 5).join('; ')
      : (up.length ? `${predicted}/${up.length} upcoming games PREDICTED, all inside bounds`
        : 'no NFL game inside the next ' + LOOKAHEAD_D + ' days'));
  out.lines.nfl = lineGuard('nfl_lines', 'NFL', guardRows, GUARD.nfl);
}

/* ------------------------------------------------------- CFB Power 4 path */
function p4IsFbs(division, teamName) {
  if (division === 'fbs') return true;
  if (division && division !== 'fbs') return false;
  const seeds = P4.rating && P4.rating.seed_ratings;
  if (!seeds) return true;
  return Object.prototype.hasOwnProperty.call(seeds, E4.normKey(teamName));
}
function p4NormSchedRow(r, fromSupabase) {
  return {
    game_id: r.game_id, season: num(r.season), week: num(r.week),
    start_date: r.start_date,
    completed: fromSupabase ? !!r.completed : String(r.completed).toUpperCase() === 'TRUE',
    neutral_site: fromSupabase ? !!r.neutral_site : String(r.neutral_site).toUpperCase() === 'TRUE',
    venue_id: fromSupabase ? null : num(r.venue_id), venue: r.venue,
    home_team: r.home_team, home_conference: r.home_conference,
    home_division: fromSupabase ? null : r.home_division,
    away_team: r.away_team, away_conference: r.away_conference,
    away_division: fromSupabase ? null : r.away_division,
    home_points: num(r.home_points), away_points: num(r.away_points)
  };
}
async function p4Schedule(season) {
  try {
    const rows = parseCsv(await fetchText(URL_CFB_SCHED(season)));
    return { src: `cfbfastR-data schedules ${season}`, rows: rows.map(r => p4NormSchedRow(r, false)) };
  } catch (mirrorErr) {
    const rows = await sbGet('games?select=game_id,season,week,start_date,completed,neutral_site,'
      + 'conference_game,venue,home_team,home_conference,home_points,away_team,away_conference,away_points'
      + `&season=eq.${season}&limit=2000`);
    return { src: `cfb.games (Supabase ingest) ${season}`, rows: (rows || []).map(r => p4NormSchedRow(r, true)),
      mirror_error: (mirrorErr && mirrorErr.message) || 'fetch failed' };
  }
}
async function p4Section(out) {
  const d = new Date();
  const cur = (d.getMonth() <= 1) ? d.getFullYear() - 1 : d.getFullYear();
  out.seasons.cfb = cur;
  check('p4_season_window', 'CFB P4: current season inside the trained window',
    cur <= P4.trained_through_season + 1 ? 'pass' : 'fail',
    `season ${cur} vs trained through ${P4.trained_through_season}` +
    (cur <= P4.trained_through_season + 1 ? '' : ' — the data-quality gate will BLOCK; a retrain is due (football/cfb_p4/research/)'));

  const st = E4.newState();
  let absorbed = 0, completedInFeed = 0, dataThrough = null, curSched = null, srcs = [], schedFailed = 0;
  for (let y = P4.trained_through_season + 1; y <= cur; y++) {
    E4.ingest.seasonBreak(st);
    let res;
    try { res = await p4Schedule(y); }
    catch (e) {
      schedFailed++;
      check('p4_schedule_' + y, `CFB P4: ${y} schedule reachable (mirror, then Supabase)`, y === cur ? 'fail' : 'warn',
        `${(e && e.message) || 'fetch failed'} — no matchup can be projected without a real schedule`);
      continue;
    }
    srcs.push(res.src);
    const rows = res.rows.slice().sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
    for (const r of rows) {
      if (!r.completed || r.home_points == null || r.away_points == null) continue;
      completedInFeed++;
      E4.ingest.absorbGame(st, { home: r.home_team, away: r.away_team,
        home_fbs: p4IsFbs(r.home_division, r.home_team),
        away_fbs: p4IsFbs(r.away_division, r.away_team),
        neutral_site: r.neutral_site, home_points: r.home_points, away_points: r.away_points });
      absorbed++;
      if (!dataThrough || String(r.start_date) > dataThrough) dataThrough = String(r.start_date).slice(0, 10);
    }
    if (y === cur) {
      curSched = res;
      check('p4_schedule', `CFB P4: ${y} schedule reachable`, 'pass', res.src + ` · ${res.rows.length} rows`);
    }
  }
  out.learning.p4 = { completed_in_feed: completedInFeed, absorbed,
    data_through: dataThrough, schedule_source: srcs.join(' · ') || null };
  if (completedInFeed && !absorbed) {
    check('p4_ingest', 'CFB P4: completed games absorb into the ratings', 'fail',
      `${completedInFeed} completed games in the feed but 0 absorbed — the learning path is broken`);
  } else if (schedFailed && !completedInFeed) {
    /* an unreachable feed already FAILED above; do not also claim "no games" */
    check('p4_ingest', 'CFB P4: completed games absorb into the ratings', 'warn',
      'no schedule loaded, so nothing could absorb — see the schedule check above');
  } else {
    check('p4_ingest', 'CFB P4: completed games absorb into the ratings', 'pass',
      completedInFeed ? `${absorbed}/${completedInFeed} absorbed, data through ${dataThrough}`
        : `no completed ${cur} games in the feed yet — seeds + season carry-over is the correct state`);
  }
  if (!curSched) return;

  /* roster availability is a widened-uncertainty note, not a failure */
  try {
    await fetchText(URL_CFB_ROSTER(cur));
    check('p4_roster', `CFB P4: ${cur} roster file published`, 'pass', 'talent/continuity layers have data');
  } catch (_) {
    check('p4_roster', `CFB P4: ${cur} roster file published`, 'warn',
      'not published yet — the engine widens its uncertainty instead of assuming last year’s roster (expected preseason)');
  }

  /* upcoming P4 slate: project and guard */
  const P4CONF = (P4.universe && P4.universe.p4_conferences) || ['SEC', 'Big Ten', 'Big 12', 'ACC'];
  const now = Date.now(), hi = now + LOOKAHEAD_D * 864e5;
  const up = curSched.rows.filter(r => {
    if (r.completed) return false;
    const t = Date.parse(r.start_date);
    if (!isFinite(t) || t < now - 6 * 3600e3 || t > hi) return false;
    return P4CONF.indexOf(r.home_conference) >= 0 || P4CONF.indexOf(r.away_conference) >= 0;
  }).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).slice(0, 30);

  let lines = {}, linesNote = null;
  const ids = up.map(u => u.game_id).filter(Boolean);
  if (ids.length) {
    try {
      const rows = await sbGet('lines?select=game_id,provider,spread,over_under'
        + `&game_id=in.(${ids.map(encodeURIComponent).join(',')})`);
      (rows || []).forEach(l => {
        const c = lines[l.game_id];
        if (!c || String(l.provider || '').toLowerCase().includes('consensus')) lines[l.game_id] = l;
      });
    } catch (e) { linesNote = (e && e.message) || 'fetch failed'; }
  }
  check('p4_lines_src', 'CFB P4: cfb.lines market source reachable',
    linesNote ? 'warn' : 'pass',
    linesNote ? `${linesNote} — the browser still joins live captured quotes; this run compares nothing`
      : `${Object.keys(lines).length} of ${ids.length} upcoming games have a book number`);

  const V = (P4.universe && P4.universe.venues) || {};
  let predicted = 0; const insane = [], guardRows = [];
  for (const g of up) {
    const hk = E4.normKey(g.home_team), ak = E4.normKey(g.away_team);
    const line = lines[g.game_id];
    const mkt = {};
    if (line && line.spread != null) mkt.spread_line = -(+line.spread);
    if (line && line.over_under != null) mkt.total_line = +line.over_under;
    let p;
    try {
      p = E4.projectGame({ season: cur, week: g.week, state: st,
        game: { home: g.home_team, away: g.away_team, neutral_site: g.neutral_site,
          venue_id: g.venue_id, kickoff: g.start_date,
          home_fbs: p4IsFbs(g.home_division, g.home_team), away_fbs: p4IsFbs(g.away_division, g.away_team) },
        teams: {
          home: { conference: g.home_conference, roster: null, qb: null, injuries: null, news: null, coaching: null, schedule: null },
          away: { conference: g.away_conference, roster: null, qb: null, injuries: null, news: null, coaching: null, schedule: null }
        },
        venue: { home: V[hk] || null, away: V[ak] || null },
        weather: null, market: mkt });
    } catch (e) { insane.push(`${g.away_team} @ ${g.home_team}: engine threw (${(e && e.message) || 'error'})`); continue; }
    if (!p || p.status !== 'PREDICTED') continue;
    predicted++;
    const m = p.model;
    /* Two honest cases the first run flagged as insane, wrongly:
       - fair_total is null for an FCS opponent (no scoring profile) — that
         is the engine declaring the number unavailable, not a bad number;
         and isFinite(null) is true in JS, so null must be excluded
         explicitly or it reads as a 0-point total.
       - the seeds span roughly +29 to the −28 FCS prior, so a real FCS
         blowout projects near 60 points; the bound has to sit above that
         (it catches NaN and sign flips, not honest mismatches). */
    if (!isFinite(m.fair_spread) || Math.abs(m.fair_spread) > 65
      || (m.fair_total != null && (!isFinite(m.fair_total) || m.fair_total < 20 || m.fair_total > 100))
      || !(m.home_win_prob >= 0) || !(m.home_win_prob <= 1)) {
      insane.push(`${g.away_team} @ ${g.home_team}: spread ${r2(m.fair_spread)}, total ${r2(m.fair_total)}, p ${r2(m.home_win_prob)}`);
    }
    if (mkt.spread_line != null && isFinite(m.fair_spread)) {
      guardRows.push({ label: `${g.away_team} @ ${g.home_team}`, model: m.fair_spread, market: mkt.spread_line });
    }
  }
  check('p4_projections', 'CFB P4: upcoming slate projects to sane numbers',
    insane.length ? 'fail' : 'pass',
    insane.length ? insane.slice(0, 5).join('; ')
      : (up.length ? `${predicted}/${up.length} upcoming P4 games PREDICTED, all inside bounds`
        : 'no P4 game inside the next ' + LOOKAHEAD_D + ' days'));
  out.lines.p4 = lineGuard('p4_lines', 'CFB P4', guardRows, GUARD.p4);
}

/* ------------------------------------------------------------------ main */
async function main() {
  const args = process.argv.slice(2);
  let outPath = path.join(REPO, 'football', 'health.json');
  let skipTests = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outPath = path.resolve(args[++i]);
    else if (args[i] === '--skip-tests') skipTests = true;
    else { console.error('unknown option: ' + args[i]); process.exit(1); }
  }

  const now = new Date().toISOString();
  const out = {
    schema: 'edgedesk_football_health_v1',
    generated_at: now,
    ok: false,
    last_ok_at: null,
    run: {
      trigger: process.env.GITHUB_EVENT_NAME || 'manual',
      runner: process.env.GITHUB_RUN_ID ? 'github-actions' : 'local',
      params_built_at: { football: FP.built_at || null, cfb_p4: P4.built_at || null },
      model_versions: { football: FP.model_version || null, cfb_p4: P4.model_version || null }
    },
    seasons: {},
    learning: {},
    lines: {},
    checks,
    pipeline_meta: {}
  };
  /* carry the last clean run forward so a failure never erases the record */
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    out.last_ok_at = prev.ok ? prev.generated_at : (prev.last_ok_at || null);
  } catch (_) { /* first run */ }

  let testsOk = true;
  if (skipTests) check('engine_tests', 'engine test suites', 'warn', 'skipped via --skip-tests');
  else testsOk = runEngineTests();

  try { await nflSection(out); }
  catch (e) { check('nfl_pipeline', 'NFL: data path ran to completion', 'fail', (e && e.message) || 'crashed'); }
  try { await p4Section(out); }
  catch (e) { check('p4_pipeline', 'CFB P4: data path ran to completion', 'fail', (e && e.message) || 'crashed'); }

  out.ok = !overallFail;
  if (out.ok) out.last_ok_at = now;

  const st = s => s ? 'ok' : 'error';
  const ln = out.lines;
  out.pipeline_meta = {
    daily_check_last_run: now, daily_check_last_status: st(out.ok),
    engine_tests_last_run: now, engine_tests_last_status: st(testsOk),
    nfl_ingest_last_run: now,
    nfl_ingest_last_status: st(!checks.some(c => c.id.startsWith('nfl_') && c.status === 'fail')),
    row_count_nfl_ingest: (out.learning.nfl && out.learning.nfl.absorbed) || 0,
    p4_ingest_last_run: now,
    p4_ingest_last_status: st(!checks.some(c => c.id.startsWith('p4_') && c.status === 'fail')),
    row_count_p4_ingest: (out.learning.p4 && out.learning.p4.absorbed) || 0,
    line_guard_last_run: now,
    line_guard_last_status: st(!checks.some(c => /_lines(_market)?$/.test(c.id) && c.status === 'fail')),
    row_count_line_guard: ((ln.nfl && ln.nfl.compared) || 0) + ((ln.p4 && ln.p4.compared) || 0)
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  console.log(`\n${out.ok ? 'HEALTHY' : 'UNHEALTHY'} | ${checks.length} checks, ${fails} failed, ${warns} warnings | wrote ${outPath}`);
  process.exit(out.ok ? 0 : 2);
}

main().catch(e => { console.error('daily_check crashed before a report could be written:', e); process.exit(1); });
