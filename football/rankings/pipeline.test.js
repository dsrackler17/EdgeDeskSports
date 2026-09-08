#!/usr/bin/env node
/* ============================================================================
   THE PIPELINE, END TO END, PROVEN.

   rankings.test.js holds the RULES (home field never in a team rating, talent
   never reacting to a result, an opponent adjustment that converges). This
   file holds the CHAIN: a game goes final, both teams' season statistics move,
   every rating rebuilds, the ranks re-sort, a weekly snapshot is written, the
   next week differences against the right one, and running the whole thing
   twice produces the same tree.

   It runs on a SYNTHETIC LEAGUE built here in memory — no feed, no network, no
   committed artifact — for everything that is a statement about mechanism, and
   against the real committed artifacts for everything that is a statement
   about coverage. A test that can only be run on a Saturday in September is
   not a test.

     node football/rankings/pipeline.test.js       # exit 0 = green
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = require('./config.js');
const PERF = require('./performance.js');
const ETSR = require('./etsr.js');
const SPECIAL = require('./special_teams.js');
const HIST = require('./history.js');
const BR = require('./build_rankings.js');
const REFRESH = require('./refresh.js');
const B = require('../players/build_players.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; extra = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { passed++; return; }
  failed++; fails.push(name + (extra ? ' — ' + extra : ''));
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function isNum(x) { return typeof x === 'number' && isFinite(x); }

/* ================================================================== */
/* A SYNTHETIC LEAGUE                                                  */
/* ------------------------------------------------------------------ */
/* Sixteen teams, each ranked by a hidden `strength` the fixture knows  */
/* and the engine does not. Every counter is a plausible whole number   */
/* so nothing here depends on a feed being up.                          */
/* ================================================================== */
const N_TEAMS = 16;
const TEAMS = [];
for (let i = 0; i < N_TEAMS; i++) TEAMS.push('team' + String(i).padStart(2, '0'));
const FBS = {};
for (const t of TEAMS) FBS[t] = true;

/* deterministic pseudo-random, so a failure is reproducible */
function rng(seed) {
  let x = seed >>> 0;
  return function () { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

/* one team-game aggregate at a given quality level (0 = worst, 1 = best) */
function makeAgg(quality, plays, r) {
  const a = B.blankTG();
  const rush = Math.round(plays * 0.5), pass = plays - rush;
  a.rush_att = rush; a.dropbacks = pass; a.pass_att = Math.round(pass * 0.9);
  a.plays = plays;
  a.rush_yds = Math.round(rush * (3.2 + 2.6 * quality + 0.4 * (r() - 0.5)));
  a.pass_yds = Math.round(a.pass_att * (5.5 + 4.5 * quality + 0.6 * (r() - 0.5)));
  a.rush_success = Math.round(rush * (0.32 + 0.24 * quality));
  a.pass_success = Math.round(a.pass_att * (0.34 + 0.24 * quality));
  a.rush_explosive = Math.round(rush * (0.04 + 0.10 * quality));
  a.pass_explosive = Math.round(a.pass_att * (0.06 + 0.14 * quality));
  a.rush_stuffed = Math.round(rush * (0.26 - 0.14 * quality));
  a.sacks_taken = Math.round(pass * (0.10 - 0.06 * quality));
  a.early_down_plays = Math.round(plays * 0.68);
  a.early_down_success = Math.round(a.early_down_plays * (0.34 + 0.24 * quality));
  a.third_plays = Math.round(plays * 0.18);
  a.third_success = Math.round(a.third_plays * (0.30 + 0.26 * quality));
  a.rz_plays = Math.round(plays * 0.12);
  a.rz_success = Math.round(a.rz_plays * (0.38 + 0.28 * quality));
  a.turnovers = Math.round(plays * (0.030 - 0.016 * quality));
  a.first_downs = Math.round(plays * (0.28 + 0.14 * quality));
  a.neutral_plays = a.early_down_plays; a.neutral_pass = Math.round(a.early_down_plays * 0.5);
  return a;
}
/* a special-teams aggregate at a given quality level, both halves joined */
function makeSt(quality, r, opts) {
  opts = opts || {};
  const st = B.blankST();
  const atts = opts.fg_att == null ? 2 : opts.fg_att;
  for (let i = 0; i < atts; i++) {
    const dist = 22 + Math.round(28 * r());
    st.fg_kicks.push([dist, r() < (0.55 + 0.35 * quality) ? 1 : 0]);
  }
  st.fg_att = st.fg_kicks.length;
  st.fg_made = st.fg_kicks.filter(k => k[1]).length;
  st.fg_blocked = 0;
  st.xp_att = opts.xp_att == null ? 4 : opts.xp_att;
  st.xp_made = Math.max(0, st.xp_att - (quality > 0.5 ? 0 : 1));
  st.punts = opts.punts == null ? 5 : opts.punts;
  st.punt_yds = Math.round(st.punts * (38 + 8 * quality));
  st.punts_in20 = Math.round(st.punts * (0.20 + 0.30 * quality));
  st.punt_touchbacks = Math.round(st.punts * (0.16 - 0.10 * quality));
  st.kr = 2; st.kr_yds = Math.round(st.kr * (17 + 12 * quality));
  st.pr = 2; st.pr_yds = Math.round(st.pr * (4 + 12 * quality));
  st.kr_allowed = 2; st.kr_yds_allowed = Math.round(2 * (28 - 10 * quality));
  st.punt_ret_yds_allowed = Math.round(st.punts * (1.2 * (1 - quality)));
  st.punt_ret_allowed = 2;
  st.box_joined = true;
  return st;
}

/* a full round-robin week: every team plays one game */
function makeWeek(week, strengths, r, opts) {
  opts = opts || {};
  const out = [];
  const order = TEAMS.slice();
  /* rotate so the pairings differ week to week and the opponent-adjustment
     graph is connected */
  for (let i = 0; i < order.length; i += 2) {
    const home = order[(i + week) % order.length];
    const away = order[(i + week + 1 + 2 * week) % order.length];
    if (home === away) continue;
    const gid = 'g' + week + '_' + i;
    const hq = strengths[home], aq = strengths[away];
    /* a team's offence is its own quality against the opponent's defence */
    out.push({ game_id: gid, week, team: home, opp: away,
      off: makeAgg(clamp01(hq - (aq - 0.5) * 0.5), opts.plays || 70, r),
      comp: null, garbage_plays: 0, st: makeSt(hq, r, opts.st) });
    out.push({ game_id: gid, week, team: away, opp: home,
      off: makeAgg(clamp01(aq - (hq - 0.5) * 0.5), opts.plays || 70, r),
      comp: null, garbage_plays: 0, st: makeSt(aq, r, opts.st) });
  }
  for (const tg of out) { tg.comp = JSON.parse(JSON.stringify(tg.off)); }
  return out;
}
function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

const STRENGTH = {};
(function () {
  const r = rng(7);
  for (let i = 0; i < TEAMS.length; i++) STRENGTH[TEAMS[i]] = i / (TEAMS.length - 1);
  void r;
})();

function league(weeks, opts) {
  opts = opts || {};
  const r = rng(opts.seed || 42);
  let games = [];
  for (let w = 1; w <= weeks; w++) games = games.concat(makeWeek(w, STRENGTH, r, opts));
  return games;
}

/* the whole board, from team-games to ranks — the same call order the real
   build makes, minus the feeds */
function board(teamGames, opts) {
  opts = opts || {};
  /* the same order the real build uses: the kicking half of special teams is
     attached to the team-games BEFORE the performance layer reads them, and
     the expected-FG curve is fitted across the WHOLE window rather than from
     whatever subset this board happens to be looking at */
  SPECIAL.attach(teamGames, null, { kick_source: opts.kick_source || teamGames });
  const perf = PERF.build(teamGames, { fbs: FBS });
  const teams = {};
  for (const k of TEAMS) {
    const p = perf.teams[k] || null;
    teams[k] = {
      key: k, team: k, conference: 'Test',
      etsr: p && isNum(p.net_z) ? Math.round(p.net_z * 7.5 * 100) / 100 : null,
      confidence: { value: opts.confidence == null ? 0.6 : opts.confidence },
      talent: { rating: 50 },
      weights: { performance: opts.w_perf == null ? 0.5 : opts.w_perf },
      performance: p ? {
        rating: p.rating, offense: p.offense.rating, defense: p.defense.rating,
        special_teams: p.special_teams.rating,
        run_offense: p.sub_units.run_offense.rating, pass_offense: p.sub_units.pass_offense.rating,
        run_defense: p.sub_units.run_defense.rating, pass_defense: p.sub_units.pass_defense.rating,
        opponent_delta: null, sample: p.sample
      } : { rating: null },
      special_teams: p ? p.special_teams : { rating: null, available: false },
      run_defence_power: { score: null },
      units: {}, depth: { rating: null }, continuity: { rating: null },
      scheme_fit: { rating: null }, availability: { rating: null }
    };
  }
  const ranks = ETSR.rankAll(teams);
  for (const k of Object.keys(teams)) {
    teams[k].rank = ranks.overall.ranks[k] ? ranks.overall.ranks[k].rank : null;
    teams[k].ranks = {};
    for (const cat of Object.keys(ranks)) {
      const rr = ranks[cat].ranks[k];
      teams[k].ranks[cat] = rr ? { rank: rr.rank, value: rr.value, unranked: !!rr.unranked } : null;
    }
  }
  return { perf, teams, ranks };
}

/* ================================================================== */
/* 1. A FINAL GAME MOVES BOTH TEAMS' SEASON STATISTICS                 */
/* ================================================================== */
(function finalGameMovesBothSides() {
  const before = league(2);
  const after = before.concat(makeWeek(3, STRENGTH, rng(99)));
  const bRows = PERF.gameRows(before, { fbs: FBS }).rows;
  const aRows = PERF.gameRows(after, { fbs: FBS }).rows;

  const newGame = after[after.length - 1];
  const sideA = newGame.team, sideB = newGame.opp;
  const plays = rows => {
    const out = {};
    for (const r of rows) out[r.team] = (out[r.team] || 0) + (PERF.field(r.agg, 'plays_all') || 0);
    return out;
  };
  const pb = plays(bRows), pa = plays(aRows);
  ok('1. a FINAL game adds observed plays for the HOME side', pa[sideA] > pb[sideA],
    sideA + ': ' + pb[sideA] + ' -> ' + pa[sideA]);
  ok('1. a FINAL game adds observed plays for the AWAY side too', pa[sideB] > pb[sideB],
    sideB + ': ' + pb[sideB] + ' -> ' + pa[sideB]);
  const bB = board(before), bA = board(after);
  ok('1. both teams’ game counts move',
    bA.teams[sideA].performance.sample.games > bB.teams[sideA].performance.sample.games
    && bA.teams[sideB].performance.sample.games > bB.teams[sideB].performance.sample.games);
  ok('1. every team on the board still has a sample',
    TEAMS.every(k => bA.teams[k].performance.sample.games > 0));
})();

/* ================================================================== */
/* 2-5. EVERY RATING REBUILDS WHEN NEW FOOTBALL ARRIVES                */
/* ================================================================== */
(function ratingsRebuild() {
  const before = league(2);
  /* a third week in which ONE team plays out of its mind on both sides and
     kicks like it: the rating that must move is that team's */
  const hero = TEAMS[3];
  const boosted = {};
  for (const k of TEAMS) boosted[k] = STRENGTH[k];
  boosted[hero] = 1;
  const w3 = makeWeek(3, boosted, rng(5), {});
  /* give the hero the best special-teams game in the league */
  for (const tg of w3) if (tg.team === hero) tg.st = makeSt(1, rng(11), {});
  const after = before.concat(w3);

  const bB = board(before), bA = board(after);
  ok('2. the board rebuilds: at least one team’s ETSR changes',
    TEAMS.some(k => bB.teams[k].etsr !== bA.teams[k].etsr));
  ok('3. OFFENSE updates for the team that played better',
    isNum(bB.teams[hero].performance.offense) && isNum(bA.teams[hero].performance.offense)
    && bA.teams[hero].performance.offense > bB.teams[hero].performance.offense,
    bB.teams[hero].performance.offense + ' -> ' + bA.teams[hero].performance.offense);
  ok('4. DEFENSE updates for the team that played better',
    isNum(bB.teams[hero].performance.defense) && isNum(bA.teams[hero].performance.defense)
    && bA.teams[hero].performance.defense > bB.teams[hero].performance.defense,
    bB.teams[hero].performance.defense + ' -> ' + bA.teams[hero].performance.defense);
  ok('5. SPECIAL TEAMS updates for the team that kicked better',
    isNum(bB.teams[hero].performance.special_teams) && isNum(bA.teams[hero].performance.special_teams)
    && bA.teams[hero].performance.special_teams > bB.teams[hero].performance.special_teams,
    bB.teams[hero].performance.special_teams + ' -> ' + bA.teams[hero].performance.special_teams);
  ok('3-5. offence, defence and special teams are three DIFFERENT numbers',
    new Set([bA.teams[hero].performance.offense, bA.teams[hero].performance.defense,
      bA.teams[hero].performance.special_teams]).size === 3);

  /* 6. national ranks re-sort when values change */
  ok('6. the national rank moves when the rating moves',
    bA.ranks.offense.ranks[hero].rank < bB.ranks.offense.ranks[hero].rank,
    'offense rank ' + bB.ranks.offense.ranks[hero].rank + ' -> ' + bA.ranks.offense.ranks[hero].rank);
  ok('6. the special-teams rank moves too',
    bA.ranks.special_teams.ranks[hero].rank <= bB.ranks.special_teams.ranks[hero].rank,
    'ST rank ' + bB.ranks.special_teams.ranks[hero].rank + ' -> ' + bA.ranks.special_teams.ranks[hero].rank);
  ok('6. ranks are dense and start at 1',
    Object.keys(bA.ranks.overall.ranks).map(k => bA.ranks.overall.ranks[k].rank)
      .filter(isNum).sort((a, b) => a - b).every((v, i) => v === i + 1));
})();

/* ================================================================== */
/* 9-10. IDEMPOTENCE, AND A DUPLICATE GAME COUNTED ONCE                */
/* ================================================================== */
(function idempotent() {
  const games = league(3);
  const a = board(games), b = board(games.slice());
  ok('9. re-running the same build produces identical ratings',
    JSON.stringify(TEAMS.map(k => [a.teams[k].etsr, a.teams[k].performance.offense,
      a.teams[k].performance.defense, a.teams[k].performance.special_teams]))
    === JSON.stringify(TEAMS.map(k => [b.teams[k].etsr, b.teams[k].performance.offense,
      b.teams[k].performance.defense, b.teams[k].performance.special_teams])));
  ok('9. and identical ranks',
    JSON.stringify(a.ranks.overall.ranks) === JSON.stringify(b.ranks.overall.ranks));

  /* THE SAME FINAL GAME INGESTED TWICE.
     It is stopped twice over. At INGESTION the play loader keys a team-game on
     (game_id, team) in a Map, so a feed that republishes a game overwrites the
     row rather than adding one; and at AGGREGATION gameRows drops any
     (team, game_id) it has already seen and names it. Both are checked. */
  const map = new Map();
  for (const g of games.concat(games)) map.set(g.game_id + '|' + g.team, g);
  eq('10. ingestion keys a team-game on (game_id, team), so a republished game overwrites',
    map.size, games.length);

  const doubled = games.concat(games.map(g => JSON.parse(JSON.stringify(g))));
  const G = PERF.gameRows(doubled, { fbs: FBS });
  eq('10. a duplicated team-game is dropped and named', G.duplicate_team_games.length, games.length);
  const c = board(doubled, { kick_source: games });
  ok('10. duplicate ingestion does not double-count the sample',
    TEAMS.every(k => c.teams[k].performance.sample.games === a.teams[k].performance.sample.games),
    'games: ' + a.teams[TEAMS[0]].performance.sample.games + ' vs ' + c.teams[TEAMS[0]].performance.sample.games);
  ok('10. duplicate ingestion does not move a single rating',
    TEAMS.every(k => c.teams[k].performance.offense === a.teams[k].performance.offense
      && c.teams[k].performance.defense === a.teams[k].performance.defense
      && c.teams[k].performance.special_teams === a.teams[k].performance.special_teams));
  ok('10. and does not move the plays observed',
    TEAMS.every(k => c.teams[k].performance.sample.plays === a.teams[k].performance.sample.plays));
})();

/* ================================================================== */
/* 11. ONE GAME IS A RATING WITH LOW CONFIDENCE, NOT A NULL            */
/* ================================================================== */
(function oneGameTeams() {
  const one = league(1);
  const b = board(one);
  const rated = TEAMS.filter(k => isNum(b.teams[k].performance.offense));
  ok('11. a one-game league still produces offence ratings', rated.length === TEAMS.length,
    rated.length + ' of ' + TEAMS.length);
  ok('11. and defence ratings',
    TEAMS.every(k => isNum(b.teams[k].performance.defense)));
  ok('11. and special-teams ratings',
    TEAMS.every(k => isNum(b.teams[k].performance.special_teams)));

  /* the shrink is what carries the doubt: one game must be pulled hard toward
     the league mean relative to six */
  const six = board(league(6));
  const spread = brd => {
    const v = TEAMS.map(k => brd.teams[k].performance.offense).filter(isNum);
    const m = v.reduce((x, y) => x + y, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length);
  };
  ok('11. one game is shrunk harder toward the mean than six games are',
    spread(b) < spread(six), 'sd ' + spread(b).toFixed(2) + ' vs ' + spread(six).toFixed(2));
  ok('11. reliability rises with the sample',
    b.perf.teams[TEAMS[0]].reliability < six.perf.teams[TEAMS[0]].reliability,
    b.perf.teams[TEAMS[0]].reliability + ' vs ' + six.perf.teams[TEAMS[0]].reliability);

  /* and a team below the confidence floor keeps its RATING and loses its RANK */
  const lowConf = board(one, { confidence: 0.05 });
  ok('11. below the confidence floor a team keeps its rating',
    TEAMS.every(k => isNum(lowConf.teams[k].performance.offense)));
  ok('11. and loses its rank rather than being given a fake one',
    TEAMS.every(k => lowConf.ranks.offense.ranks[k].unranked === true
      && lowConf.ranks.offense.ranks[k].rank === null));
})();

/* ================================================================== */
/* 12. MISSING SOURCE DATA STAYS MISSING                               */
/* ================================================================== */
(function missingStaysMissing() {
  /* a league where nobody's special-teams row was ever joined */
  const games = league(3).map(g => { const c = Object.assign({}, g); c.st = null; return c; });
  const b = board(games);
  ok('12. no special-teams feed means no special-teams rating, not a 50',
    TEAMS.every(k => b.teams[k].performance.special_teams == null));
  ok('12. and the reason is stated per team',
    TEAMS.every(k => typeof b.teams[k].special_teams.reason === 'string' && b.teams[k].special_teams.reason.length > 20));
  ok('12. offence and defence are unaffected by the missing kicking feed',
    TEAMS.every(k => isNum(b.teams[k].performance.offense) && isNum(b.teams[k].performance.defense)));

  /* net punting must refuse to score when the opponent's return row is absent,
     rather than reading the missing half as zero return yards */
  const st = B.blankST();
  st.punts = 5; st.punt_yds = 220; st.punt_touchbacks = 0; st.box_joined = true;
  ok('12. net punting with no opponent row is null, never a free average',
    PERF.field(st, 'punt_net_yds') === null);
  st.punt_ret_yds_allowed = 0;
  eq('12. and with a real zero-return row it scores', PERF.field(st, 'punt_net_yds'), 220);

  /* a metric below its observation floor is named, with the number it fell
     short by — one game, one punt, against a floor of two */
  const thin = league(1);
  for (const g of thin) if (g.team === TEAMS[0]) { g.st.punts = 1; g.st.punt_yds = 40; g.st.punts_in20 = 0; }
  const t = board(thin);
  const missRows = t.teams[TEAMS[0]].special_teams.missing || [];
  const missing = missRows.map(m => m.id);
  ok('12. a component below its observation floor is listed as missing',
    missing.indexOf('st_punt_net') >= 0, 'missing: ' + missing.join(','));
  const row = missRows.find(m => m.id === 'st_punt_net');
  ok('12. and the reason states the observations and the floor it fell short of',
    !!row && /observed/.test(row.why) && isNum(row.n_obs) && isNum(row.floor) && row.n_obs < row.floor,
    JSON.stringify(row));
  ok('12. a team below a component floor is not given the league average instead',
    t.teams[TEAMS[0]].special_teams.used.every(u => u.id !== 'st_punt_net'));

  /* nothing anywhere in the engine substitutes a league average for a gap */
  const src = ['performance.js', 'special_teams.js', 'etsr.js', 'history.js']
    .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
  ok('12. no module fills a missing rating with 50', !/=\s*50\s*;\s*\/\/\s*default/i.test(src));
})();

/* ================================================================== */
/* 7-8. WEEKLY HISTORY, AND THE Δ AGAINST THE RIGHT WEEK               */
/* ================================================================== */
(function weeklyHistory() {
  function snapOf(season, ordinal, label, teams, extra) {
    const t = {};
    for (const k of Object.keys(teams)) t[k] = HIST.snapshotTeam(teams[k]);
    return Object.assign({ season, week_ordinal: ordinal, week_label: label,
      season_type: 'regular', generated_at: '2026-01-0' + (ordinal + 1) + 'T00:00:00.000Z',
      versions: CFG.VERSIONS, teams: t }, extra || {});
  }
  const w1 = board(league(1));
  const w2 = board(league(2));
  const w4 = board(league(4));
  const s1 = snapOf(2026, 1, 'Week 1', w1.teams);
  const s2 = snapOf(2026, 2, 'Week 2', w2.teams);
  const s4 = snapOf(2026, 4, 'Week 4', w4.teams);

  ok('7. a snapshot carries every ranking category',
    HIST.categories().every(c => CFG.RANKINGS.some(r => r.id === c))
    && Object.keys(s2.teams[TEAMS[0]].cat).length >= 8,
    'categories on file: ' + Object.keys(s2.teams[TEAMS[0]].cat).join(','));
  ok('7. including special teams', 'special_teams' in s2.teams[TEAMS[0]].cat);
  ok('7. a snapshot stores value AND rank per category',
    Array.isArray(s2.teams[TEAMS[0]].cat.offense) && s2.teams[TEAMS[0]].cat.offense.length === 2);
  ok('7. the snapshot key is season, week, team and rating version',
    JSON.stringify(CFG.HISTORY.key) === JSON.stringify(['season', 'week_ordinal', 'team', 'rating_version']));

  const series = HIST.seriesFor(TEAMS[0], [s4, s1, s2]);
  eq('7. the series is ordered oldest first', series.map(r => r.week_ordinal).join(','), '1,2,4');
  ok('7. the first entry has no delta and says why',
    series[0].delta === null && /nothing before it/.test(series[0].first_entry_note));
  eq('8. week 2 is differenced against week 1', series[1].previous.week_ordinal, 1);
  eq('8. and week 4 against week 2 — the latest week ON FILE, not "week 3"',
    series[2].previous.week_ordinal, 2);
  eq('8. the gap between them is stated so a two-week move is not read as one',
    series[2].previous.weeks_between, 2);
  ok('8. a category delta is computed per category',
    'offense' in series[1].delta.categories && 'special_teams' in series[1].delta.categories);

  /* previousSnapshot is the ONE resolver, and it skips gaps */
  eq('8. previousSnapshot for week 4 is week 2',
    HIST.previousSnapshot([s1, s2, s4], 2026, 4).week_ordinal, 2);
  eq('8. previousSnapshot for week 2 is week 1',
    HIST.previousSnapshot([s1, s2, s4], 2026, 2).week_ordinal, 1);
  eq('8. previousSnapshot for the first week on file is nothing',
    HIST.previousSnapshot([s1, s2, s4], 2026, 1), null);
  eq('8. a snapshot never compares against ITSELF',
    HIST.previousSnapshot([s1, s2, s4], 2026, 2).week_ordinal !== 2, true);

  /* ETSR.movement reports which week it compared against */
  const mv = ETSR.movement(w2.teams[TEAMS[0]], s1.teams[TEAMS[0]],
    { season: 2026, week_ordinal: 1, week_label: 'Week 1', current_ordinal: 2, current_season: 2026 });
  ok('8. movement names the week it differenced against',
    mv.compared_against && mv.compared_against.week_ordinal === 1 && mv.compared_against.weeks_between === 1);
  ok('8. movement carries a per-category delta', !!mv.categories);
  ok('8. with nothing earlier, movement refuses rather than inventing a zero',
    ETSR.movement(w2.teams[TEAMS[0]], null).available === false);

  /* the assembled artifact */
  const built = HIST.build([s1, s2, s4], TEAMS);
  eq('7. the history artifact holds one series per team', Object.keys(built.teams).length, TEAMS.length);
  eq('7. and lists every snapshot it was assembled from', built.snapshots.length, 3);
  ok('7. the immutability rule ships with it',
    /refuses to touch it/.test(built.contract.immutability_basis)
    && built.contract.immutable_before_current_week === true);
  ok('8. the artifact states what Δ week is measured against',
    built.contract.delta_against === 'previous_snapshot' && /bye week/.test(built.contract.delta_basis));
})();

/* ================================================================== */
/* 13. ALL 138 FBS TEAMS ARE ACCOUNTED FOR (the real artifact)         */
/* ================================================================== */
(function realArtifact() {
  const f = path.join(__dirname, 'current.json');
  if (!fs.existsSync(f)) { ok('13. the rankings artifact exists', false, 'run npm run cfb:rankings'); return; }
  const D = JSON.parse(fs.readFileSync(f, 'utf8'));
  const H = fs.existsSync(BR.HEALTH_FILE) ? JSON.parse(fs.readFileSync(BR.HEALTH_FILE, 'utf8')) : null;

  ok('13. every FBS team in the schedule produced a rating row',
    !!H && H.teams_processed === H.fbs_teams_expected,
    H ? (H.teams_processed + ' of ' + H.fbs_teams_expected) : 'no health report');
  ok('13. and the board carries them all', Object.keys(D.teams).length === (H ? H.fbs_teams_expected : 0),
    Object.keys(D.teams).length + ' teams on the board');
  ok('13. every team on the board has a key, a name and an ETSR or a stated reason',
    Object.keys(D.teams).every(k => D.teams[k].key === k && D.teams[k].team
      && (isNum(D.teams[k].etsr) || D.teams[k].available === false)));
  ok('13. no team is a duplicate row',
    new Set(Object.keys(D.teams).map(k => D.teams[k].key)).size === Object.keys(D.teams).length);

  /* the health report is the deliverable the request named */
  ok('13. the health report states the FBS count, the processed count and every category',
    !!H && isNum(H.fbs_teams_expected) && isNum(H.teams_processed)
    && H.ratings && isNum(H.ratings.offense) && isNum(H.ratings.defense) && isNum(H.ratings.special_teams));
  ok('13. it names the teams whose data is genuinely unavailable, with a reason each',
    !!H && Array.isArray(H.genuinely_unavailable)
    && H.genuinely_unavailable.every(g => g.team && typeof g.reason === 'string' && g.reason.length > 10));
  ok('13. it records the last ingestion and the last build',
    !!H && !!H.ingestion && !!H.last_rankings_build && !!H.source_freshness);
  ok('13. and the build version', !!H && !!H.build_version && !!H.build_version.schema_version);

  /* a rating that exists is a rating with evidence behind it */
  const withOff = Object.keys(D.teams).filter(k => D.teams[k].performance.offense != null);
  ok('13. every published offence rating has at least one scored metric behind it',
    withOff.every(k => D.teams[k].performance.offense_detail.scored > 0));
  const withSt = Object.keys(D.teams).filter(k => D.teams[k].special_teams
    && D.teams[k].special_teams.rating != null);
  ok('13. every published special-teams rating cleared the coverage floor',
    withSt.every(k => D.teams[k].special_teams.coverage >= CFG.SPECIAL_TEAMS.coverage_floor),
    withSt.length + ' rated');
  ok('13. every UNRATED special-teams team says why in its own words',
    Object.keys(D.teams).filter(k => !D.teams[k].special_teams || D.teams[k].special_teams.rating == null)
      .every(k => typeof (D.teams[k].special_teams || {}).reason === 'string'));

  /* coverage must actually be better than "talent only" */
  ok('13. more than 90% of FBS teams hold an offence rating',
    withOff.length / Object.keys(D.teams).length > 0.9,
    withOff.length + '/' + Object.keys(D.teams).length);
  const withDef = Object.keys(D.teams).filter(k => D.teams[k].performance.defense != null);
  ok('13. and a defence rating', withDef.length / Object.keys(D.teams).length > 0.9,
    withDef.length + '/' + Object.keys(D.teams).length);
})();

/* ================================================================== */
/* 14. THE FRONTEND READS THE CANONICAL DATASET AND NOTHING ELSE       */
/* ================================================================== */
(function frontendIsGlue() {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.html'), 'utf8');
  const start = app.indexOf('/* ═══ EDGEDESK NATIONAL RANKINGS (ETSR)');
  const end = app.indexOf('function fbRenderBoard(host){', start);
  ok('14. the rankings renderer is where the tests expect it', start > 0 && end > start);
  const src = app.slice(start, end);

  ok('14. it fetches the committed board', /football\/rankings\/current\.json/.test(src));
  ok('14. and the committed weekly history', /football\/rankings\/history\.json/.test(src));
  ok('14. and the committed run record for its build stamp', /football\/rankings\/health\.json/.test(src));
  ok('14. it does not fetch a rating from any other origin',
    !/fetch\(\s*['"`]https?:/.test(src));
  ok('14. it calls no Edge Function', !/functions\/v1\/|supabase\.co\/functions/.test(src));
  ok('14. it calls no language model',
    !/\b(openai|anthropic|claude|gpt-|completions?\.create)\b/i.test(src));
  ok('14. it does not re-rank in the browser: no sort by a computed rating',
    !/\.sort\(function\([^)]*\)\{\s*return\s+[a-z]\.(etsr|rating)/i.test(src));
  ok('14. the ranks it renders come from the artifact’s own ranks block',
    /ranks\s*&&\s*[a-z]\.ranks\[/.test(src) || /t\.ranks\[cat\]/.test(src));
  ok('14. special teams is a tab like every other category',
    /\['special_teams','Special teams'\]/.test(src));
  ok('14. and it reads the rating off the artifact, not off the K room',
    /special_teams:function\(t\)\{return t\.special_teams&&t\.special_teams\.rating;\}/.test(src));
  ok('14. every category the request named has a tab',
    ['overall', 'talent', 'performance', 'offense', 'defense', 'special_teams', 'run_offense',
      'pass_offense', 'run_defense', 'pass_defense', 'qb', 'ol', 'wr', 'rb', 'dl', 'lb',
      'secondary', 'depth', 'continuity'].every(id => src.indexOf("['" + id + "',") >= 0));
  ok('14. the Δ week it shows is the build’s own, not a browser subtraction',
    /movement&&[a-z]\.movement/.test(src) || /fbRkCatMove/.test(src));

  /* and the categories on the page are the categories in the config */
  const m = src.match(/var FBRK_TABS=\[([\s\S]*?)\];/);
  ok('14. every tab on the page is a real ranking category in config.js', !!m && (function () {
    const ids = Array.from(m[1].matchAll(/\['([a-z_]+)'/g)).map(x => x[1]);
    return ids.every(id => CFG.RANKINGS.some(r => r.id === id));
  })());
})();

/* ================================================================== */
/* THE REFRESH DETECTOR                                                */
/* ================================================================== */
(function refreshDetector() {
  const sched = { games: [
    { game_id: 'a', week: 1, season_type: 'regular', completed: true, home_points: 20, start_date: '2026-08-30T00:00:00Z' },
    { game_id: 'b', week: 1, season_type: 'regular', completed: true, home_points: 17, start_date: '2026-08-31T00:00:00Z' },
    { game_id: 'c', week: 2, season_type: 'regular', completed: false, home_points: null, start_date: '2026-09-06T00:00:00Z' }
  ] };
  const now = REFRESH.finalGames(sched);
  eq('refresh: only FINAL games are counted', now.count, 2);
  const cur = { season: new Date().getMonth() <= 1 ? new Date().getFullYear() - 1 : new Date().getFullYear(),
    week_label: 'Week 1', week_ordinal: 1, generated_at: new Date().toISOString(),
    data_freshness: { completed_games: 2, completed_games_digest: now.digest } };
  const health = { last_rankings_build: new Date().toISOString() };

  return Promise.all([
    REFRESH.check({ schedule: sched, current: cur, health }),
    REFRESH.check({ schedule: sched, current: null, health: null }),
    REFRESH.check({ schedule: sched, health,
      current: Object.assign({}, cur, { data_freshness: { completed_games: 1, completed_games_digest: 'deadbeefdeadbeef' } }) }),
    REFRESH.check({ schedule: sched, current: cur,
      health: { last_rankings_build: '2020-01-01T00:00:00.000Z' } }),
    REFRESH.check({ schedule: sched, health,
      current: Object.assign({}, cur, { data_freshness: { completed_games: 2 } }) })
  ]).then(function (r) {
    ok('refresh: the same set of FINAL games and a fresh build means no rebuild', r[0].rebuild === false, r[0].reason);
    ok('refresh: no published board means rebuild', r[1].rebuild === true);
    ok('refresh: a changed digest means rebuild', r[2].rebuild === true, r[2].reason);
    ok('refresh: and it says how many games are new', r[2].new_games === 1);
    ok('refresh: a stale build means rebuild even with no new games', r[3].rebuild === true, r[3].reason);
    ok('refresh: a board with no digest means rebuild rather than a guess', r[4].rebuild === true, r[4].reason);
    ok('refresh: it fails toward rebuilding, never toward skipping',
      [r[1], r[2], r[3], r[4]].every(x => x.rebuild === true));
  });
})();

/* ================================================================== */
/* THE SAMPLE-FLOOR CONTRACT — the bug this pipeline was built to fix  */
/* ================================================================== */
(function sampleFloorContract() {
  eq('floor: the floor is asked of the OBSERVATIONS', CFG.SAMPLE.floor_on, 'observations');
  eq('floor: the shrink is asked of the WEIGHTED evidence', CFG.SAMPLE.reliability_on, 'weighted evidence');

  /* the exact shape of the original failure: one game against a non-FBS
     opponent, most of it a blowout. It must produce a rating. */
  const POOL = CFG.OPPONENT.fcs_pooled_key;
  const r = rng(3);
  const games = [];
  for (let i = 0; i < TEAMS.length; i++) {
    const k = TEAMS[i];
    const full = makeAgg(0.5 + 0.4 * (i / TEAMS.length), 70, r);
    const comp = makeAgg(0.5, 25, r);        /* only 25 competitive plays */
    games.push({ game_id: 'fcs' + i, week: 1, team: k, opp: 'fcs' + i,
      off: full, comp: comp, garbage_plays: 45, st: makeSt(0.5, r, {}) });
    games.push({ game_id: 'fcs' + i, week: 1, team: 'fcs' + i, opp: k,
      off: makeAgg(0.1, 55, r), comp: makeAgg(0.1, 20, r), garbage_plays: 35, st: null });
  }
  const perf = PERF.build(games, { fbs: FBS });
  const rated = TEAMS.filter(k => perf.teams[k] && perf.teams[k].offense.rating != null);
  ok('floor: a 73-6 win over an FCS side still produces an offence rating',
    rated.length === TEAMS.length, rated.length + ' of ' + TEAMS.length);
  ok('floor: the pooled non-FBS opponent is solved as one identity',
    perf.non_fbs_pool.key === POOL);
  const used = perf.teams[TEAMS[0]].offense.used[0];
  ok('floor: a scored metric ships BOTH its observations and its weighted evidence',
    isNum(used.n_obs) && isNum(used.n) && used.n_obs > used.n,
    JSON.stringify({ n_obs: used.n_obs, n: used.n }));
  ok('floor: and the reliability that was measured off the weighted half',
    used.reliability > 0 && used.reliability < 1);
  ok('floor: the confidence carries the doubt — reliability is well under one',
    perf.teams[TEAMS[0]].reliability < 0.5, String(perf.teams[TEAMS[0]].reliability));

  /* garbage time is discounted, not deleted */
  const s = perf.teams[TEAMS[0]].sample;
  ok('garbage: the full, competitive and scored play counts all ship',
    isNum(s.plays) && isNum(s.competitive_plays) && isNum(s.scored_plays));
  ok('garbage: the scored count is between the competitive and the full one',
    s.scored_plays > s.competitive_plays && s.scored_plays < s.plays,
    JSON.stringify({ comp: s.competitive_plays, scored: s.scored_plays, full: s.plays }));
  const expected = s.competitive_plays + CFG.GARBAGE.scored_weight * (s.plays - s.competitive_plays);
  ok('garbage: and it is exactly competitive + w x garbage, arithmetic anyone can redo',
    Math.abs(s.scored_plays - expected) < 1.0,
    s.scored_plays + ' vs ' + expected.toFixed(1));
  const blended = PERF.blendAggregate({ rush_att: 40, dropbacks: 30 }, { rush_att: 20, dropbacks: 10 });
  eq('garbage: the blend is applied to numerator and denominator alike',
    Math.round((blended.rush_att + blended.dropbacks) * 100) / 100,
    Math.round((30 + CFG.GARBAGE.scored_weight * 40) * 100) / 100);
})();

/* ================================================================== */
/* SPECIAL TEAMS — what feeds it, and what it refuses to invent        */
/* ================================================================== */
(function specialTeamsContract() {
  ok('ST: every component names the aggregate it reads',
    CFG.SPECIAL_TEAMS.metrics.every(m => m.src === 'st'));
  ok('ST: every component states its basis',
    CFG.SPECIAL_TEAMS.metrics.every(m => typeof m.basis === 'string' && m.basis.length > 20));
  ok('ST: the weights sum to one',
    Math.abs(CFG.SPECIAL_TEAMS.metrics.reduce((s, m) => s + m.w, 0) - 1) < 1e-9);
  ok('ST: place kicking, punting, returns and coverage are all in the contract',
    ['st_fg_over_expected', 'st_punt_net', 'st_kick_coverage', 'st_punt_return',
      'st_kick_return', 'st_punt_inside20', 'st_xp', 'st_kicks_blocked']
      .every(id => CFG.SPECIAL_TEAMS.metrics.some(m => m.id === id)));
  ok('ST: what nobody can see is written down',
    Object.keys(CFG.SPECIAL_TEAMS.unobservable).length >= 4);

  /* the expected-FG curve is fitted, monotone-ish, and never 0 or 1 */
  const r = rng(17);
  const kicks = [];
  for (let i = 0; i < 4000; i++) {
    const d = 18 + Math.floor(37 * r());
    const p = Math.max(0.15, Math.min(0.98, 1.25 - d * 0.011));
    kicks.push([d, r() < p ? 1 : 0]);
  }
  const curve = SPECIAL.fitFgCurve([kicks]);
  ok('ST: the curve is fitted from attempts this build read', curve.available && curve.attempts === kicks.length);
  ok('ST: a short kick is expected to be made more often than a long one',
    SPECIAL.expectedMake(curve, 22) > SPECIAL.expectedMake(curve, 52),
    SPECIAL.expectedMake(curve, 22) + ' vs ' + SPECIAL.expectedMake(curve, 52));
  ok('ST: no bucket is ever a certainty',
    Object.keys(curve.buckets).every(b => curve.buckets[b] > 0.01 && curve.buckets[b] < 0.999));
  ok('ST: a distance nobody has kicked from falls back to the nearest bucket, never to a guess',
    isNum(SPECIAL.expectedMake(curve, 70)));
  ok('ST: with no kicks at all the curve refuses rather than inventing one',
    SPECIAL.fitFgCurve([[]]).available === false);

  /* making a hard kick beats making an easy one */
  const tgHard = { game_id: 'x', team: 'a', opp: 'b', st: B.blankST() };
  tgHard.st.fg_kicks = [[52, 1]]; tgHard.st.fg_att = 1; tgHard.st.fg_made = 1;
  const tgEasy = { game_id: 'y', team: 'c', opp: 'd', st: B.blankST() };
  tgEasy.st.fg_kicks = [[22, 1]]; tgEasy.st.fg_att = 1; tgEasy.st.fg_made = 1;
  SPECIAL.attach([tgHard, tgEasy], null, { kick_source: [{ st: { fg_kicks: kicks } }] });
  ok('ST: a made 52-yarder is worth more than a made 22-yarder',
    tgHard.st.fg_over_expected > tgEasy.st.fg_over_expected,
    tgHard.st.fg_over_expected + ' vs ' + tgEasy.st.fg_over_expected);

  /* the box join, and the coverage that comes from the opponent's own row */
  const tgs = [
    { game_id: 'g1', team: 'a', opp: 'b', st: B.blankST() },
    { game_id: 'g1', team: 'b', opp: 'a', st: B.blankST() }
  ];
  const cols = ['fg_made', 'fg_att', 'xp_made', 'xp_att', 'punts', 'punt_yds', 'punts_in20',
    'touchbacks', 'kr', 'kr_yds', 'kr_td', 'pr', 'pr_yds', 'pr_td'];
  const box = { team_game_columns: cols, team_games: {
    'g1|a': [1, 2, 3, 3, 5, 210, 2, 1, 2, 40, 0, 1, 9, 0],
    'g1|b': [2, 2, 4, 4, 4, 150, 0, 0, 3, 90, 0, 2, 30, 0]
  } };
  const rep = SPECIAL.attach(tgs, box, { kick_source: [{ st: { fg_kicks: kicks } }] });
  eq('ST: both sides of the game joined the box', rep.box_joined, 2);
  eq('ST: A’s kickoff coverage is B’s kick-return yardage', tgs[0].st.kr_yds_allowed, 90);
  eq('ST: and B’s coverage is A’s', tgs[1].st.kr_yds_allowed, 40);
  eq('ST: A’s punt coverage is the yardage B gained returning punts', tgs[0].st.punt_ret_yds_allowed, 30);
  eq('ST: net punting subtracts the return and the touchback',
    PERF.field(tgs[0].st, 'punt_net_yds'), 210 - 30 - CFG.SPECIAL_TEAMS.touchback_yards);
  ok('ST: with no box artifact the join declares itself missing rather than guessing',
    SPECIAL.attach([{ game_id: 'z', team: 'a', opp: 'b', st: B.blankST() }], null, {}).box_available === false);
  /* the join is idempotent: it SETS fields rather than accumulating into them,
     so a rebuild that re-reads the same box does not double a punt */
  const firstPass = JSON.stringify(tgs[0].st);
  SPECIAL.attach(tgs, box, { kick_source: [{ st: { fg_kicks: kicks } }] });
  eq('10. re-joining the same box row changes nothing — the join sets, never accumulates',
    JSON.stringify(tgs[0].st), firstPass);
  const rep2 = SPECIAL.attach(tgs, box, { kick_source: [{ st: { fg_kicks: kicks } }] });
  eq('10. and the join report is the same the second time', rep2.box_joined, rep.box_joined);

  /* it is measured and ranked, and it is NOT an ETSR input */
  const f = path.join(__dirname, 'current.json');
  if (fs.existsSync(f)) {
    const D = JSON.parse(fs.readFileSync(f, 'utf8'));
    const k = Object.keys(D.teams).find(x => D.teams[x].special_teams && D.teams[x].special_teams.rating != null);
    ok('ST: the published rating states it is not an ETSR input',
      !!k && D.teams[k].special_teams.is_etsr_input === false);
    ok('ST: and names the feeds it came from',
      !!k && D.teams[k].special_teams.provenance.feeds.length === 2);
    ok('ST: the ranking category reads the measured rating, not the kicker room',
      CFG.RANKINGS.some(c => c.id === 'special_teams' && c.field === 'special_teams.rating'));
    ok('ST: the roster kicker room is still published, under its own name',
      CFG.RANKINGS.some(c => c.id === 'k_room' && c.field === 'units.K.rating'));
  }
})();

/* ================================================================== */
/* IDEMPOTENCE OF THE ARTIFACTS ON DISK                                */
/* ================================================================== */
(function artifactIdempotence() {
  const snapDir = BR.SNAP_DIR;
  if (!fs.existsSync(snapDir)) { ok('9. snapshots exist on disk', false, 'run npm run cfb:rankings'); return; }
  const files = fs.readdirSync(snapDir).filter(f => /^\d{4}-w\d{2}\.json$/.test(f));
  ok('9. every snapshot is addressed by season and week ordinal, so a rerun overwrites one file',
    files.length > 0 && files.every(f => /^\d{4}-w\d{2}\.json$/.test(f)));
  const seen = new Set();
  ok('9. no week is stored twice', files.every(f => { if (seen.has(f)) return false; seen.add(f); return true; }));
  const snaps = BR.loadSnapshots();
  ok('9. the snapshots load in week order',
    snaps.every((s, i) => i === 0 || s.week_ordinal > snaps[i - 1].week_ordinal || s.season > snaps[i - 1].season));
  ok('9. each one names the rating version that produced it',
    snaps.every(s => s.versions && s.versions.team_rating));
  ok('9. a reconstructed week is labelled as one',
    snaps.every(s => !s.reconstructed || typeof s.reconstructed_basis === 'string'));
  ok('9. and every snapshot names the player artifact its talent came from',
    snaps.every(s => s.built_on && 'player_artifact' in s.built_on),
    'a snapshot with no talent provenance cannot be compared on talent');

  /* TALENT MOVES WHEN THE PLAYER LAYER IS REBUILT, and that is not a collapse.
     Failing the build on it freezes the board every time the player job lands
     between two rankings runs, so it fires as a WARNING across two different
     player artifacts and as a FAILURE across the same one. */
  const now = { a: { key: 'a', etsr: 1, talent: { rating: 50 }, ranks: {}, confidence: { value: 0.5 } } };
  const was = { a: { etsr: 1, talent: { rating: 60 } } };
  const same = ETSR.anomalies(now, was, { player_artifact: 'abc', previous_player_artifact: 'abc' });
  const diff = ETSR.anomalies(now, was, { player_artifact: 'abc', previous_player_artifact: 'xyz' });
  const none = ETSR.anomalies(now, was, {});
  eq('9. a talent collapse on ONE player artifact fails the build',
    same.list.filter(x => x.id === 'TALENT_COLLAPSE' && x.severity === 'severe').length, 1);
  eq('9. across two player artifacts it warns instead',
    diff.list.filter(x => x.id === 'TALENT_COLLAPSE' && x.severity === 'warn').length, 1);
  ok('9. and it names both artifacts so the reader can check',
    /abc/.test(diff.list.find(x => x.id === 'TALENT_COLLAPSE').detail)
    && /xyz/.test(diff.list.find(x => x.id === 'TALENT_COLLAPSE').detail));
  eq('9. with no provenance recorded it stays severe — the safe direction',
    none.list.filter(x => x.id === 'TALENT_COLLAPSE' && x.severity === 'severe').length, 1);
  ok('9. it never stops firing altogether',
    [same, diff, none].every(r => r.list.some(x => x.id === 'TALENT_COLLAPSE')));

  if (fs.existsSync(BR.HISTORY_FILE)) {
    const h = JSON.parse(fs.readFileSync(BR.HISTORY_FILE, 'utf8'));
    ok('7. the history artifact holds every snapshot on disk', h.snapshots.length === snaps.length,
      h.snapshots.length + ' vs ' + snaps.length);
    const anyTeam = Object.keys(h.teams)[0];
    ok('7. and a per-team series in week order', !!anyTeam
      && h.teams[anyTeam].every((r, i) => i === 0 || r.week_ordinal > h.teams[anyTeam][i - 1].week_ordinal));
    ok('8. every entry after the first names the week it is a delta against',
      !!anyTeam && h.teams[anyTeam].every((r, i) => i === 0 ? r.previous === null : !!r.previous));
  }

  const cur = path.join(__dirname, 'current.json');
  if (fs.existsSync(cur)) {
    const D = JSON.parse(fs.readFileSync(cur, 'utf8'));
    /* THE PUBLISHED BOARD IS CONTENT-ADDRESSED. A rebuild that changed no
       number must leave it byte-identical, which means the two timestamps are
       the ONLY moving parts in it. Anything else that moved on its own — a
       run clock, a Date.now(), an unordered map — would show up here. */
    const strip = t => t.replace(/"(generated_at|data_as_of)":"[^"]*"/g, '');
    const raw = fs.readFileSync(cur, 'utf8');
    ok('9. the board carries no second clock that would make it differ from itself',
      !/"last_rankings_build":"20/.test(strip(raw)),
      'a run timestamp is embedded in the content-addressed artifact');
    ok('9. the run stamp lives in the run record and the board says so',
      D.pipeline_health && D.pipeline_health.run_record === 'football/rankings/health.json'
      && D.pipeline_health.last_rankings_build === null);
    ok('9. and the board carries a digest of the ratings it published',
      typeof D.digest === 'string' && D.digest.length >= 8);
    const anyK = Object.keys(D.teams)[0];
    ok('7. the board carries each team’s weekly series inline',
      Array.isArray(D.teams[anyK].history));
    ok('7. and points at the full history artifact',
      D.history && D.history.artifact === 'football/rankings/history.json');
    ok('9. the board records the exact set of FINAL games it stood on',
      !!(D.data_freshness && D.data_freshness.completed_games_digest));
  }
})();

/* ---------------------------------------------------------------- */
/* the refresh checks are async; everything else is not               */
setTimeout(function () {
  console.log((failed ? '\n' : '') + fails.map(f => '  FAIL  ' + f).join('\n'));
  console.log(`\npipeline end-to-end: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 50);
