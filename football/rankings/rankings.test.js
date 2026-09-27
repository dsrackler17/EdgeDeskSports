#!/usr/bin/env node
/* ============================================================================
   THE RULES OF THE NATIONAL RANKINGS AND THE ENRICHMENT LAYER, ENFORCED.

   Every check is a rule the system is not allowed to break: home field never
   in a team rating, talent never reacting to a result, a week ordinal that
   survives the postseason, an opponent adjustment that actually converges, a
   feature that cannot move a line without earning it, and a rating that stays
   point-in-time.

     node football/rankings/rankings.test.js      # exit 0 = green
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = require('./config.js');
const PERF = require('./performance.js');
const TAL = require('./talent.js');
const ETSR = require('./etsr.js');
const BR = require('./build_rankings.js');
const PROMOTE = require('../validation/promote.js');
const PCFG = require('../players/config.js');
const PEPIR = require('../players/epir.js');
const B = require('../players/build_players.js');
const BOX = require('../data/build_box.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; extra = String(e && e.stack || e).slice(0, 200); } }
  if (cond) { passed++; return; }
  failed++; fails.push(name + (extra ? ' — ' + extra : ''));
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function close(name, a, b, tol) { ok(name, a != null && Math.abs(a - b) <= (tol || 1e-9), 'got ' + a + ', expected ~' + b); }

/* ---------------------------------------------------------------- */
/* 1. WEEK RESOLUTION — never the calendar                           */
/* ---------------------------------------------------------------- */
(function weeks() {
  eq('week: a regular-season week keeps its number', BR.weekOrdinal('regular', 7), 7);
  eq('week: week 0 is a real week', BR.weekOrdinal('regular', 0), 0);
  ok('week: the postseason sorts AFTER the regular season',
    BR.weekOrdinal('postseason', 1) > BR.weekOrdinal('regular', 15));
  ok('week: conference championship week is still a regular week',
    BR.weekOrdinal('regular', 14) === 14);
  eq('week: a bowl is labelled', BR.weekLabel('postseason', 1, 'Cheez-It Bowl'), 'Bowls');
  eq('week: the playoff is labelled', BR.weekLabel('postseason', 1, 'College Football Playoff First Round Game'), 'Playoff');
  eq('week: a regular week is labelled', BR.weekLabel('regular', 5, null), 'Week 5');
  eq('week: week zero is labelled', BR.weekLabel('regular', 0, null), 'Week 0');
  const none = BR.resolveWeek({ games: [] });
  eq('week: with no completed game the board is a preseason board', none.label, 'Preseason');
  eq('week: and its ordinal is zero', none.ordinal, 0);
  const some = BR.resolveWeek({ games: [
    { completed: true, home_points: 20, week: 3, season_type: 'regular' },
    { completed: true, home_points: 20, week: 1, season_type: 'postseason' },
    { completed: false, home_points: null, week: 9, season_type: 'regular' }
  ] });
  eq('week: the latest COMPLETED game decides the board', some.ordinal, BR.weekOrdinal('postseason', 1));
  ok('week: an unplayed game never advances the board', some.ordinal < 29);
})();

/* ---------------------------------------------------------------- */
/* 2. GARBAGE TIME — filtered, and auditable                         */
/* ---------------------------------------------------------------- */
(function garbage() {
  ok('garbage: a first-quarter blowout is garbage time', B.isGarbage(1, 45));
  ok('garbage: a first-quarter two-score game is not', !B.isGarbage(1, 14));
  ok('garbage: the bar falls as the game goes on', B.isGarbage(4, 20) && !B.isGarbage(1, 20));
  ok('garbage: overtime uses the fourth-quarter bar', B.isGarbage(5, 20));
  ok('garbage: a null score is not garbage time', !B.isGarbage(1, null));
  ok('garbage: the rule is symmetric', B.isGarbage(2, 40) === B.isGarbage(2, -40));
  const t = B.blankTG();
  ok('garbage: the aggregate carries the fields the performance layer needs',
    'early_down_success' in t && 'third_success' in t && 'rz_success' in t && 'turnovers' in t);
})();

/* ---------------------------------------------------------------- */
/* 3. OPPONENT ADJUSTMENT — converges, and is stored three ways      */
/* ---------------------------------------------------------------- */
function fakeGames(n, strong, weeks) {
  /* a round-robin-ish schedule so the adjustment has something to solve */
  const out = [];
  const teams = [];
  const K = weeks == null ? 6 : weeks;
  for (let i = 0; i < n; i++) teams.push('t' + i);
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= K; k++) {
      const j = (i + k) % n;
      const a = B.blankTG();
      const skill = (strong[teams[i]] || 0) - (strong[teams[j]] || 0);
      a.plays = 70; a.rush_att = 35; a.dropbacks = 35; a.pass_att = 33;
      a.rush_success = Math.round(14 + skill * 6); a.pass_success = Math.round(14 + skill * 6);
      a.rush_yds = 150; a.pass_yds = 230; a.rush_explosive = 4; a.pass_explosive = 4;
      a.rush_stuffed = 6; a.sacks_taken = 2; a.first_downs = 20;
      a.early_down_plays = 45; a.early_down_pass = 20; a.early_down_success = Math.round(18 + skill * 6);
      a.third_plays = 14; a.third_success = 6; a.rz_plays = 8; a.rz_success = 4; a.turnovers = 1;
      out.push({ game_id: 'g' + i + '_' + j + '_' + k, week: k, team: teams[i], opp: teams[j],
        off: a, comp: a, garbage_plays: 0 });
    }
  }
  return out;
}
(function opponent() {
  const strong = {};
  for (let i = 0; i < 24; i++) strong['t' + i] = (12 - i) / 12;
  const tgs = fakeGames(24, strong);
  const fbs = {};
  for (let i = 0; i < 24; i++) fbs['t' + i] = true;
  const G = PERF.gameRows(tgs, { fbs });
  ok('opponent: every team-game becomes a row', G.rows.length === tgs.length);
  const a = PERF.adjust(G.rows, CFG.OFFENSE_METRICS[0], {});
  ok('opponent: the fixed point converges', a.converged === true, 'moved ' + a.final_movement);
  ok('opponent: within the iteration budget', a.iterations < CFG.OPPONENT.max_iterations);
  ok('opponent: the tolerance is relative to the metric', a.tolerance > 0 && a.tolerance < 1);
  const one = a.offense.t0;
  ok('opponent: raw, adjusted and delta are all stored', one && one.raw != null && one.adjusted != null && one.delta != null);
  close('opponent: delta is exactly adjusted minus raw', one.delta, one.adjusted - one.raw, 1e-9);
  ok('opponent: the strong team is adjusted above the weak one', a.offense.t0.adjusted > a.offense.t23.adjusted);
  const empty = PERF.adjust([], CFG.OFFENSE_METRICS[0], {});
  ok('opponent: with nothing to solve it refuses', empty.available === false);
  ok('opponent: and says why', !!empty.reason);

  /* circular inflation guard */
  ok('opponent: every pass pulls toward the mean, which bounds the feedback loop',
    CFG.OPPONENT.shrink_per_iteration > 0 && CFG.OPPONENT.shrink_per_iteration < 1);
})();

/* ---------------------------------------------------------------- */
/* 3b. SAMPLE RELIABILITY — week one is football too                 */
/*                                                                    */
/* min_n is the sample a metric is worth FULL CREDIT at, never a gate. */
/* Read as a gate it emptied the entire performance layer every        */
/* September: seventy plays is less than a hundred and fifty, so every */
/* team was dropped from every metric, offence and defence came back   */
/* null for all of them, and the board could not move on results it    */
/* had already read.                                                   */
/* ---------------------------------------------------------------- */
(function sampleReliability() {
  const m = CFG.OFFENSE_METRICS[0];                       /* success_rate, min_n 150 */
  ok('sample: the scoring floor is a stated fraction of the full-credit sample',
    CFG.SAMPLE.score_floor_fraction > 0 && CFG.SAMPLE.score_floor_fraction < 1);
  close('sample: and the floor is that fraction of min_n',
    PERF.scoreFloor(m), m.min_n * CFG.SAMPLE.score_floor_fraction, 1e-9);
  close('sample: the full sample is worth full credit', PERF.reliability(m.min_n, m), 1, 1e-9);
  close('sample: a bigger sample is never worth more than full credit',
    PERF.reliability(m.min_n * 4, m), 1, 1e-9);
  close('sample: half a sample is worth half', PERF.reliability(m.min_n / 2, m), 0.5, 1e-9);
  eq('sample: no sample is worth nothing', PERF.reliability(0, m), 0);

  ok('sample: ONE game of football, even against a non-FBS opponent, clears the floor',
    70 * CFG.NON_FBS.game_weight >= PERF.scoreFloor(m),
    'one discounted game is ' + (70 * CFG.NON_FBS.game_weight) + ', floor is ' + PERF.scoreFloor(m));

  /* the whole regression, end to end: one week played, a rating produced */
  const strong = {};
  for (let i = 0; i < 24; i++) strong['t' + i] = (12 - i) / 12;
  const fbs = {};
  for (let i = 0; i < 24; i++) fbs['t' + i] = true;
  const oneWeek = PERF.build(fakeGames(24, strong, 1), { fbs });
  const rated = Object.keys(oneWeek.teams).filter(k => oneWeek.teams[k].net_z != null);
  ok('sample: after ONE week the performance layer rates the league, not nobody',
    rated.length >= 20, 'only ' + rated.length + ' of 24 teams got a rating');
  ok('sample: and it still knows who is good',
    oneWeek.teams.t0.net_z > oneWeek.teams.t23.net_z);
  ok('sample: every rated team publishes the reliability its number was shrunk by',
    rated.every(k => oneWeek.teams[k].reliability > 0 && oneWeek.teams[k].reliability <= 1));

  /* the shrink has to survive the second standardisation, or it is decorative */
  const partial = rated.filter(k => oneWeek.teams[k].reliability < 0.999);
  ok('sample: a week-one sample IS partially reliable, not fully', partial.length > 0);
  const moved = partial.filter(k => Math.abs(oneWeek.teams[k].net_z_before_reliability) > 0.05);
  ok('sample: and the shrink survives the league re-standardisation',
    moved.length > 0 && moved.every(k => Math.abs(oneWeek.teams[k].net_z)
      < Math.abs(oneWeek.teams[k].net_z_before_reliability)),
    'a re-standardised z would rescale the shrink straight back out');
  ok('sample: a thin sample is shrunk TOWARD the league mean, never past it',
    partial.every(k => oneWeek.teams[k].net_z * oneWeek.teams[k].net_z_before_reliability >= 0));

  /* a full season must not be penalised for having been measured properly */
  const full = PERF.build(fakeGames(24, strong, 6), { fbs });
  ok('sample: a full sample reaches full credit and is not shrunk at all',
    full.teams.t0.reliability > 0.99, 'got ' + full.teams.t0.reliability);
  ok('sample: so a full-season number is published exactly as it was measured',
    Math.abs(full.teams.t0.net_z - full.teams.t0.net_z_before_reliability) < 0.01,
    'shrunk ' + full.teams.t0.net_z_before_reliability + ' to ' + full.teams.t0.net_z);

  /* the publish gate refuses a build whose adjustment stopped early, so the
     iteration budget has to cover the slowest metric in the contract on the
     thinnest sample of the year — or the weekly job simply never commits */
  ok('sample: the opponent adjustment converges on a single week of football',
    oneWeek.diagnostics.all_converged === true,
    (oneWeek.diagnostics.metrics.filter(d => d.available !== false && !d.converged)
      .map(d => d.metric + ' moved ' + d.final_movement + ' in ' + d.iterations).join('; ')));
  ok('sample: and on a full season',
    full.diagnostics.all_converged === true);
})();

/* ---------------------------------------------------------------- */
/* 3c. FEED FRESHNESS — a weekly rebuild has to read this week        */
/*                                                                    */
/* The raw feeds are cached between runs because a finished season is  */
/* tens of megabytes that will never change again. The season IN       */
/* PROGRESS is the entire point of the rebuild. Serving that one out   */
/* of the previous run's cache is how a scheduled job goes green every */
/* week while republishing last week's rankings: the build succeeds,   */
/* the commit is empty, and nothing on the board ever moves.           */
/* ---------------------------------------------------------------- */
(function feedFreshness() {
  const FC = require('../data/feed_cache.js');
  const os = require('os');

  eq('freshness: the season of a feed is read from its name', FC.seasonOf('pstats_2026.csv'), 2026);
  eq('freshness: parquet and gz names too', FC.seasonOf('player_box_2025.parquet'), 2025);
  eq('freshness: a whole-history file carries no season', FC.seasonOf('cfb_line_odds.csv.gz'), null);

  ok('freshness: a FINISHED season is permanent', FC.isVolatile('pstats_2025.csv', 2026) === false);
  ok('freshness: the season being built is volatile', FC.isVolatile('pstats_2026.csv', 2026) === true);
  ok('freshness: a future season is volatile too', FC.isVolatile('pstats_2027.csv', 2026) === true);
  ok('freshness: a whole-history file that grows every week is volatile',
    FC.isVolatile('cfb_line_odds.csv.gz', 2026) === true);
  ok('freshness: with no season stated, assume the worst',
    FC.isVolatile('pstats_2025.csv', null) === true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edfeed-'));
  try {
    const stale = path.join(dir, 'pstats_2026.csv');
    fs.writeFileSync(stale, 'x'.repeat(4096));
    const old = Date.now() - (FC.ttlMs() + 60000);
    fs.utimesSync(stale, old / 1000, old / 1000);
    ok('freshness: a stale in-progress feed is REFETCHED, not reused',
      FC.usable(stale, 'pstats_2026.csv', 2026, 64) === false);

    const now = Date.now();
    fs.utimesSync(stale, now / 1000, now / 1000);
    ok('freshness: one just downloaded is shared across the build’s processes',
      FC.usable(stale, 'pstats_2026.csv', 2026, 64) === true);

    const done = path.join(dir, 'pstats_2024.csv');
    fs.writeFileSync(done, 'x'.repeat(4096));
    fs.utimesSync(done, old / 1000, old / 1000);
    ok('freshness: a finished season is reused however old the file is',
      FC.usable(done, 'pstats_2024.csv', 2026, 64) === true);

    ok('freshness: a truncated cache file is never served',
      FC.usable(path.join(dir, 'nope_2024.csv'), 'nope_2024.csv', 2026, 64) === false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  /* and the fetchers must actually ask it — a cache read that skips this
     module is the bug this section exists to stop coming back */
  for (const f of ['../data/build_box.js', '../players/build_players.js', './build_rankings.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    ok('freshness: ' + f.replace(/^.*\//, '') + ' decides cache reuse through feed_cache',
      /FEEDCACHE\.usable\(/.test(src) && !/fs\.existsSync\((?:p|cached)\)\s*(?:&&|\))/.test(src));
  }
})();

/* ---------------------------------------------------------------- */
/* 3d. THE BUILD SAYS WHAT IT READ                                    */
/* ---------------------------------------------------------------- */
(function freshnessStamp() {
  const f = BR.dataFreshness(
    { games: [
      { completed: true, home_points: 21, start_date: '2026-09-05T23:00:00Z' },
      { completed: true, home_points: 3, start_date: '2026-08-29T16:00:00Z' },
      { completed: false, home_points: null, start_date: '2026-09-12T16:00:00Z' }
    ] },
    { teamGames: new Map([['a', 1], ['b', 2], ['c', 3]]) },
    { teams: { x: { net_z: 0.4 }, y: { net_z: null }, z: { net_z: -1.1 } } });
  eq('freshness stamp: only completed games are counted', f.completed_games, 2);
  eq('freshness stamp: the latest kickoff read is the latest COMPLETED one',
    f.latest_completed_kickoff, '2026-09-05T23:00:00Z');
  eq('freshness stamp: team-games are counted whether the loader hands back a map or an array',
    f.team_games_read, 3);
  eq('freshness stamp: and how many teams that was enough to rate',
    f.teams_with_a_performance_rating, 2);
  ok('freshness stamp: with nothing read it says nothing, rather than nothing at all',
    BR.dataFreshness(null, null, null).completed_games === 0);

  /* the shipped dataset has to carry it — the weekly job's publish gate reads
     this field to catch a build that read a stale cache */
  const cur = JSON.parse(fs.readFileSync(path.join(__dirname, 'current.json'), 'utf8'));
  ok('freshness stamp: the shipped rankings carry it', !!cur.data_freshness);
  ok('freshness stamp: and a board past week zero read at least one completed game',
    cur.week_ordinal === 0 || cur.data_freshness.completed_games > 0,
    cur.week_label + ' on ' + cur.data_freshness.completed_games + ' completed games');
})();

/* ---------------------------------------------------------------- */
/* 4. RECENCY AND NON-FBS WEIGHTING                                  */
/* ---------------------------------------------------------------- */
(function recency() {
  const tgs = [];
  for (let w = 1; w <= 10; w++) {
    const a = B.blankTG(); a.plays = 70; a.rush_att = 35; a.dropbacks = 35;
    tgs.push({ game_id: 'g' + w, week: w, team: 'a', opp: w === 3 ? 'fcs' : 'b', off: a, comp: a, garbage_plays: 0 });
  }
  const G = PERF.gameRows(tgs, { fbs: { a: true, b: true } });
  const rows = G.rows.filter(r => r.team === 'a').sort((x, y) => x.week - y.week);
  ok('recency: the most recent game carries the most weight',
    rows[rows.length - 1].recency > rows[0].recency);
  ok('recency: an old game never falls to zero', rows[0].recency >= CFG.RECENCY.floor);
  const fcsRow = rows.find(r => r.week === 3);
  ok('non-FBS: the pooled opponent is used', fcsRow.opp === CFG.OPPONENT.fcs_pooled_key);
  ok('non-FBS: and the game is worth less than an FBS game',
    fcsRow.weight < fcsRow.recency * 0.999);
  close('non-FBS: by exactly the configured factor', fcsRow.weight / fcsRow.recency, CFG.NON_FBS.game_weight, 1e-9);
  ok('non-FBS: a documented fallback prior exists for an unsolvable pool',
    typeof CFG.NON_FBS.fallback_prior_points === 'number' && !!CFG.NON_FBS.fallback_basis);

  /* duplicate games are dropped and named */
  const dupes = tgs.concat([tgs[0]]);
  const G2 = PERF.gameRows(dupes, { fbs: { a: true, b: true } });
  eq('duplicate games: the repeat is dropped', G2.rows.length, G.rows.length);
  ok('duplicate games: and it is named', G2.duplicate_team_games.length === 1);
})();

/* ---------------------------------------------------------------- */
/* 5. TALENT — never reacts to a result                              */
/* ---------------------------------------------------------------- */
function fakeUnits(level, opts) {
  opts = opts || {};
  const groups = {};
  for (const g of ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P']) {
    groups[g] = { r: level, c: 0.7, sq: level + 2, dq: level - 4, ct: 0.6, ex: 0.5, n: 10, out: 0, unk: 0.2 };
  }
  if (opts.noQb) delete groups.QB;
  return { team: 'T', conference: 'X', groups,
    offense: { r: level, c: 0.7 }, defense: { r: level, c: 0.7 }, overall: { r: level, c: 0.7 },
    returning: { value_continuity: opts.vc == null ? 0.6 : opts.vc, roster_continuity: 0.7,
      by_group: { DL: { value_returning: 0.6, starters_returning: 0.6 }, LB: { value_returning: 0.6, starters_returning: 0.5 },
        OL: { value_returning: 0.7, starters_returning: 0.8 } } },
    transfers: { in: 12, out: 10, net_index: 50, net_value: 0, starters_in: 2, starters_out: 1 } };
}
(function talent() {
  const league = {};
  for (let i = 0; i < 40; i++) league['t' + i] = fakeUnits(40 + i);
  const built = TAL.build(league, {});
  ok('talent: every team gets a rating', Object.keys(built.teams).length === 40);
  const hi = built.teams.t39, lo = built.teams.t0;
  ok('talent: a better roster rates higher', hi.rating > lo.rating);
  ok('talent: on the same 0-100 scale as EPIR', hi.rating <= 99 && lo.rating >= 1);
  ok('talent: every component names its basis', hi.components.every(c => !!c.basis));
  ok('talent: recruiting is declared, not applied', hi.recruiting.applied === false);
  ok('talent: and says why', /no legal|keyless/i.test(hi.recruiting.reason));
  ok('talent: the contract lists what may move it', hi.may_move.indexOf('availability change') >= 0);
  ok('talent: and what may NOT', hi.may_not_move.indexOf('a single bad game') >= 0
    && hi.may_not_move.indexOf('a blowout loss') >= 0);
  ok('talent: no week-to-week smoothing is imposed on top of a measured shrinkage',
    hi.smoothing.applied === false && /career-shrunk/i.test(hi.smoothing.basis));

  /* UNKNOWN AVAILABILITY MUST NEVER BECOME HEALTHY just because other teams
     have real reports. This bug only wakes up once league-wide availability
     has variance, which is exactly when official reports start arriving. */
  const availLeague = {};
  for (let i = 0; i < 20; i++) {
    const u = fakeUnits(50 + i / 10);
    for (const g of Object.keys(u.groups)) {
      u.groups[g].unk = 0;
      u.groups[g].unav = (i % 5) * 0.05;
    }
    availLeague['a' + i] = u;
  }
  const blind = fakeUnits(55);
  for (const g of Object.keys(blind.groups)) { blind.groups[g].unk = 1; blind.groups[g].unav = 0; }
  availLeague.blind = blind;
  const availBuilt = TAL.build(availLeague, {}).teams;
  ok('talent availability: a fully covered team can score availability',
    availBuilt.a0.availability.rating != null);
  eq('talent availability: an unknown roster has no availability rating',
    availBuilt.blind.availability.rating, null);
  ok('talent availability: unknown is explicitly missing, not a clean zero',
    availBuilt.blind.missing.some(x => x.id === 'availability'));

  /* A NAMED ABSENCE MUST NOT SURVIVE strip_availability.
     The whole chain, from a roster to the number the engine would price:
     players/units.js -> talent (league pass) -> ETSR -> the rating adapter's
     signed availability contribution -> football/cfb_p4 strip. Rotation
     quality used to read the availability-adjusted unit rating, so a named
     OUT starter moved talent inside the unit where the strip, which removes
     only the explicit availability component, could not reach it. */
  (function namedAbsenceIsStripped() {
    const UN = require('../players/units.js');
    const SYNC = require('../rating/sync_rankings.js');
    global.window = global.window || global;
    require('../cfb_p4/params.js');
    const ENG = require('../cfb_p4/engine.js');
    const SHAPE = { QB: 3, RB: 4, WR: 7, TE: 3, OL: 8, DL: 6, LB: 5, CB: 5, S: 4, K: 1, P: 1 };
    function roster(tk, lvl) {
      const out = [];
      Object.keys(SHAPE).forEach((g) => {
        for (let i = 0; i < SHAPE[g]; i++) {
          out.push({ key: tk + g + i, name: tk + ' ' + g + i, pos: g, group: g, epir: lvl + 14 - i * 2.5 + (tk.length % 3),
            confidence: 0.6, sample_size: 20, seasons_observed: 2, status: 'returning', role: { expected_role: i < 2 ? 'STARTER' : 'ROTATION' } });
        }
      });
      return out;
    }
    const TEAMS = []; for (let i = 0; i < 16; i++) TEAMS.push('team' + i);
    /* avail(tk) -> the availability map one team's units are built with */
    function league(avail) {
      const L = {};
      TEAMS.forEach((tk, i) => { L[tk] = UN.rateTeam(tk, tk, roster(tk, 44 + i), { availability: avail(tk) }); });
      return L;
    }
    const OL0 = 'team7OL0';
    function everyoneActive(tk) { const m = {}; roster(tk, 50).forEach((p) => { m[p.key] = { status: 'ACTIVE' }; }); return m; }

    /* 1. partial evidence: one named OUT starter and nothing else on file */
    const quiet = league(() => ({}));
    const named = league((tk) => (tk === 'team7' ? { [OL0]: { status: 'OUT' } } : {}));
    ok('the named absence is visible where it belongs: the unit EXPECTED to play is weaker',
      named.team7.groups.OL.rating < quiet.team7.groups.OL.rating);
    eq('but the unit’s ability is unchanged', named.team7.groups.OL.rating_ex_availability, quiet.team7.groups.OL.rating_ex_availability);
    const tq = TAL.build(quiet, {}).teams, tn = TAL.build(named, {}).teams;
    eq('rotation quality reads ability, so a named OUT starter does not move it', tn.team7.rotation_quality, tq.team7.rotation_quality);
    ok('and it says so', /availability-free/.test(tn.team7.rotation_basis));
    ok('partial evidence leaves the explicit availability component unscored', tn.team7.availability.rating === null
      && !tn.team7.components.some((c) => c.id === 'availability'));
    ok('so no team’s talent rating moves at all', TEAMS.every((tk) => tn[tk].rating === tq[tk].rating),
      TEAMS.filter((tk) => tn[tk].rating !== tq[tk].rating));

    /* 2. full coverage: every player on file, one team with one OUT starter.
       The explicit component now scores both rosters; after the strip the
       canonical ratings agree to the rating's own published precision. */
    const covered = league((tk) => { const m = everyoneActive(tk); if (+tk.slice(4) % 3 === 0 && tk !== 'team7') m[tk + 'WR0'] = { status: 'OUT' }; return m; });
    const coveredOut = league((tk) => { const m = everyoneActive(tk); if (+tk.slice(4) % 3 === 0 && tk !== 'team7') m[tk + 'WR0'] = { status: 'OUT' }; if (tk === 'team7') m[OL0] = { status: 'OUT' }; return m; });
    function canonical(L) {
      const talent = TAL.build(L, {}).teams;
      const rows = TEAMS.map((tk) => {
        const r = ETSR.rateTeam(tk, { talent: talent[tk], performance: null, continuity: null, prev_etsr: null, sample: { fbs_equivalent_games: 0 } }, {});
        const row = Object.assign({}, r, { talent: talent[tk] });
        return { canonical_key: tk, team: tk, rating: r.etsr_raw, confidence: 0.5,
          components: { availability: { points: Math.min(0, SYNC.availabilityPoints(row) || 0), contribution: SYNC.availabilityContribution(row) || 0 } } };
      });
      const st = ENG.newState();
      ENG.ingest.setCanonicalRatings(st, { source_schema: 'edgedesk_national_rankings_v1', season: 2026, calibration: { measured: true }, teams: rows }, { strip_availability: true });
      return { talent, rows, st };
    }
    const A = canonical(covered), B = canonical(coveredOut);
    ok('full coverage scores the explicit availability component', A.talent.team7.components.some((c) => c.id === 'availability')
      && B.talent.team7.components.some((c) => c.id === 'availability'));
    ok('before the strip the named absence moves the rating (it is priced as its own term)', B.rows[7].rating < A.rows[7].rating);
    ok('a healthy covered roster carries a signed contribution, not just penalties', A.rows.some((r) => r.components.availability.contribution > 0));
    const ppz = ETSR.rateTeam('x', { talent: A.talent.team7, sample: {} }, {}).scalars.talent_points_per_z;
    /* the published precision: the talent rating AND the components the
       strip is recomputed from are each published to 0.1 on the talent scale
       (two half-steps), and talent points, ETSR and the contribution to 0.01 */
    const tol = 2 * 0.05 / CFG.TALENT.scale.sd * ppz + 3 * 0.005 + 1e-9;
    ok('after strip_availability the same roster rates the same with and without the named OUT starter',
      Math.abs(B.st.canonicalRatings.team7.value - A.st.canonicalRatings.team7.value) <= tol,
      { with_out: B.st.canonicalRatings.team7.value, without: A.st.canonicalRatings.team7.value, tol });
    ok('and so does every other team in the league', TEAMS.every((tk) => Math.abs(B.st.canonicalRatings[tk].value - A.st.canonicalRatings[tk].value) <= tol),
      TEAMS.map((tk) => [tk, A.st.canonicalRatings[tk].value, B.st.canonicalRatings[tk].value, A.rows[TEAMS.indexOf(tk)].components.availability.contribution, B.rows[TEAMS.indexOf(tk)].components.availability.contribution]).filter((x) => Math.abs(x[1] - x[2]) > tol).concat([['tol', tol]]));
    ok('the strip removes a healthy bonus as well as a penalty', TEAMS.some((tk) => A.st.canonicalRatings[tk].availability_removed > 0));
    /* and the stripped rating is the rating with NO availability evidence:
       the same roster, built with nothing on file, unstripped */
    const Q = canonical(quiet);
    ok('the stripped rating equals the same roster’s rating with no availability evidence at all',
      TEAMS.every((tk) => Math.abs(B.st.canonicalRatings[tk].value - Q.rows[TEAMS.indexOf(tk)].rating) <= tol),
      TEAMS.map((tk) => [tk, B.st.canonicalRatings[tk].value, Q.rows[TEAMS.indexOf(tk)].rating]).filter((x) => Math.abs(x[1] - x[2]) > tol));
  })();

  /* a unit a roster does not SPELL is not a missing unit */
  const noEdge = TAL.build({ a: fakeUnits(50) }, {}).teams.a;
  ok('talent: an unspelled EDGE is not reported missing', (noEdge.missing_units || []).indexOf('EDGE') < 0);
  ok('talent: it is reported as covered by DL', (noEdge.covered_units || []).some(c => c.unit === 'EDGE' && c.by === 'DL'));

  /* a room with no players is not a room of zeros */
  const noQb = TAL.build({ a: fakeUnits(50, { noQb: true }) }, {}).teams.a;
  ok('talent: a missing QB room has no unit rating', noQb.units.QB.available === false);
  ok('talent: and says so rather than scoring zero', /not a rating of zero/.test(noQb.units.QB.reason));

  const cont = TAL.continuityRating(hi, league.t39);
  ok('continuity: it is computed from returning value and continuity', cont.value != null);
  ok('continuity: coordinator continuity is declared unavailable', cont.coordinator.available === false);
  ok('continuity: and says why', /no public|keyless/i.test(cont.coordinator.reason));

  const align = TAL.alignment(hi, null);
  ok('scheme fit: with no tendency profile it refuses', align.available === false);
  const align2 = TAL.alignment(hi, { offense: { rush_rate: { z: 1.2 }, explosive_pass_rate: { z: 0.4 } },
    defense: { def_sack_rate: { z: 0.8 } } });
  ok('scheme fit: with one it computes', align2.available === true);
  ok('scheme fit: and calls itself personnel-tendency alignment, not film',
    /NOT a film read/i.test(align2.basis));
})();

/* ---------------------------------------------------------------- */
/* 6. ETSR — neutral field, carryover, confidence                    */
/* ---------------------------------------------------------------- */
function ctxFor(talentRating, opts) {
  opts = opts || {};
  const league = { x: fakeUnits(talentRating) };
  const t = TAL.build(league, {}).teams.x;
  t.rating = talentRating;                        /* pin it for the arithmetic below */
  return {
    talent: t,
    performance: opts.perf === undefined ? { net_z: 1.0, rating: 62, sub_units: {} } : opts.perf,
    continuity: { value: opts.cont == null ? 0.6 : opts.cont },
    sample: { games: opts.games == null ? 8 : opts.games,
      fbs_equivalent_games: opts.games == null ? 8 : opts.games,
      distinct_opponents: 8, non_fbs_share: 0, offensive_plays: 600, defensive_plays: 600 },
    scheme_confidence: 0.7,
    prev_etsr: opts.prev === undefined ? 5 : opts.prev,
    league_slope: opts.slope === undefined ? 0.73 : opts.slope,
    coaching_program: opts.coaching_program || null
  };
}
(function etsr() {
  ok('ETSR: home field is NOT in the team rating', CFG.ETSR.home_field.in_base_rating === false);
  ok('ETSR: and the record says why', /neutral-field|double-count/i.test(CFG.ETSR.home_field.basis));

  const row = ETSR.rateTeam('x', ctxFor(70), null);
  ok('ETSR: a team with talent and performance gets a rating', row.available === true);
  ok('ETSR: the record carries the scalars it used', row.scalars.talent_points_per_z > 0);
  ok('ETSR: and whether they were measured', row.scalars.measured === false);
  ok('ETSR: the prior and performance weights sum to one',
    Math.abs(row.weights.performance + row.weights.prior - 1) < 1e-9);

  /* Step 7: Coaching / Program has a candidate translation but is not allowed
     to alter ETSR until the separate promotion switch is enabled. */
  ok('coaching config: candidate machinery is enabled', CFG.coachingProgram.enabled === true);
  eq('coaching config: the initial cap is 1.5 points', CFG.coachingProgram.maxPointAdjustment, 1.5);
  ok('coaching config: ETSR promotion is OFF by default', CFG.coachingProgram.affectsETSR === false);
  ok('coaching config: the adjustment belongs on the prior side', CFG.coachingProgram.applyTo === 'prior');

  const cpCtx = ctxFor(70, { coaching_program: { rating: 100, reliability: 1 } });
  const cpOff = ETSR.rateTeam('x', cpCtx, null);
  const cpBase = ETSR.rateTeam('x', ctxFor(70), null);
  eq('coaching candidate: +100 at full reliability produces the +1.5 cap',
    cpOff.coaching_program_adjustment.candidate_points, 1.5);
  eq('coaching candidate: default-off promotion applies exactly zero points',
    cpOff.coaching_program_adjustment.applied_points, 0);
  eq('coaching candidate: default-off leaves the prior unchanged',
    cpOff.prior.points, cpBase.prior.points);
  eq('coaching candidate: default-off leaves raw ETSR unchanged',
    cpOff.etsr_raw, cpBase.etsr_raw);

  const oldAffects = CFG.coachingProgram.affectsETSR;
  CFG.coachingProgram.affectsETSR = true;
  try {
    const cpOn = ETSR.rateTeam('x', cpCtx, null);
    eq('coaching promotion: when explicitly enabled it applies the capped prior adjustment',
      cpOn.coaching_program_adjustment.applied_points, 1.5);
    close('coaching promotion: the prior rises by the full prior-side adjustment',
      cpOn.prior.points - cpBase.prior.points, 1.5, 0.011);
    close('coaching promotion: current-season performance fades the ETSR contribution',
      cpOn.etsr_raw - cpBase.etsr_raw,
      1.5 * (1 - cpOn.weights.performance), 0.011);
    close('coaching promotion: the audit publishes that pre-recentre contribution',
      cpOn.coaching_program_adjustment.weighted_etsr_points_before_recentering,
      1.5 * (1 - cpOn.weights.performance), 0.002);
  } finally {
    CFG.coachingProgram.affectsETSR = oldAffects;
  }

  /* the ramp: more games means more weight on this season */
  const w0 = ETSR.rateTeam('x', ctxFor(70, { games: 0 }), null);
  const w12 = ETSR.rateTeam('x', ctxFor(70, { games: 12 }), null);
  eq('ETSR: week zero puts NO weight on this season', w0.weights.performance, 0);
  ok('ETSR: and by week twelve it dominates', w12.weights.performance > 0.7);
  ok('ETSR: the ramp is continuous, not a table of weeks', /g\/\(g\+k\)|continuous/i.test(row.weights.ramp_basis));

  /* carryover moves with continuity, and is clamped */
  const lowC = ETSR.carryover(0.1, 0.73), highC = ETSR.carryover(0.9, 0.73);
  ok('carryover: a team returning more carries more', highC.coefficient > lowC.coefficient);
  ok('carryover: it is clamped at both ends',
    lowC.coefficient >= CFG.CARRYOVER.min_coef && highC.coefficient <= CFG.CARRYOVER.max_coef);
  const noSlope = ETSR.carryover(0.6, null);
  ok('carryover: with no measured league slope it refuses to carry', noSlope.available === false);
  ok('carryover: and says why', /could not be measured/i.test(noSlope.reason));

  /* structural talent never fully disappears */
  ok('ETSR: a talent floor keeps roster ability in the prior all season',
    CFG.PRIORS.talent_floor_weight > 0);
  const late = ETSR.rateTeam('x', ctxFor(70, { games: 13, cont: 0.95 }), null);
  ok('ETSR: even a high-continuity team in December keeps some talent in its prior',
    late.prior.parts.coefficient <= 1 - CFG.PRIORS.talent_floor_weight + 1e-9);

  /* no prior season is a declared state, not a zero */
  const noPrev = ETSR.rateTeam('x', ctxFor(70, { prev: null }), null);
  ok('ETSR: with no prior season the prior is talent alone', noPrev.prior.parts.coefficient === 0);
  ok('ETSR: and a gate fires', noPrev.gates.some(g => g.id === 'PRIOR_SEASON_MISSING'));

  /* confidence follows what the rating leans on */
  const pre = ETSR.rateTeam('x', ctxFor(70, { games: 0 }), null);
  const mid = ETSR.rateTeam('x', ctxFor(70, { games: 10 }), null);
  ok('confidence: a preseason board is not scored as ignorant', pre.confidence.value > 0.2);
  ok('confidence: and a played season is more certain than a preseason one',
    mid.confidence.value > pre.confidence.value);
  ok('confidence: the mix is published', pre.confidence.mix && pre.confidence.mix.performance_weight === 0);
  ok('confidence: it is capped below certainty', mid.confidence.value <= 0.99);

  /* a gate that duplicates a confidence component must not charge twice */
  const dup = CFG.GATES.filter(g => g.duplicates_component);
  ok('gates: some gates duplicate a confidence component', dup.length > 0);
  ok('gates: and those cost no confidence', dup.every(g => g.confidence_cost === 0));
  ok('gates: while the others do', CFG.GATES.some(g => !g.duplicates_component && g.confidence_cost > 0));
  ok('gates: every gate names its basis', CFG.GATES.every(g => !!g.basis));
})();

/* ---------------------------------------------------------------- */
/* 7. RANKS, MOVEMENT, ACHIEVEMENT, MARKET                           */
/* ---------------------------------------------------------------- */
(function ranks() {
  const teams = {};
  for (let i = 0; i < 30; i++) {
    teams['t' + i] = { etsr: i - 15, confidence: { value: i < 3 ? 0.05 : 0.7 },
      talent: { rating: 40 + i }, performance: { rating: 40 + (29 - i) },
      units: { QB: { rating: 40 + i } }, run_defence_power: { score: 50 } };
  }
  const r = ETSR.rank(teams, { id: 'overall', field: 'etsr', dir: -1 });
  eq('ranks: the best rating is number one', r.ranks.t29.rank, 1);
  ok('ranks: a team below the confidence floor is UNRANKED', r.ranks.t0.unranked === true);
  ok('ranks: and keeps its rating', r.ranks.t0.value === -15);
  ok('ranks: and says why', /confidence/i.test(r.ranks.t0.reason));
  ok('ranks: unranked teams do not consume a rank number', r.ranked === 27);

  const all = ETSR.rankAll(teams);
  ok('ranks: every configured category is ranked', Object.keys(all).length === CFG.RANKINGS.length);

  const ach = ETSR.achievement('t29', all);
  ok('achievement: talent and performance ranks are compared', ach.state !== 'UNKNOWN');
  ok('achievement: and it is never called a betting signal', /never automatically/i.test(CFG.ACHIEVEMENT.basis));

  const mv = ETSR.movement({ etsr: 12, rank: 7, talent: { rating: 60 },
    performance: { rating: 70, offense: 72, defense: 68 }, weights: { performance: 0.6 },
    run_defence_power: { score: 60 }, availability: { rating: 50 } },
    { etsr: 10, rank: 10, talent: { rating: 60 },
      performance: { rating: 66, offense: 70, defense: 62 }, weights: { performance: 0.5 },
      run_defence_power: { score: 58 }, availability: { rating: 50 } });
  eq('movement: the rating delta is differenced', mv.etsr.delta, 2);
  eq('movement: a rank improvement is positive', mv.rank.delta, 3);
  ok('movement: the drivers are the components that actually moved', mv.drivers.length > 0);
  ok('movement: an unchanged component is not reported', !mv.drivers.some(d => d.id === 'talent'));
  ok('movement: it is differenced, never narrated', /differencing|arithmetic/i.test(mv.basis));
  const first = ETSR.movement({ etsr: 5 }, null);
  ok('movement: a first appearance says so rather than inventing a delta', first.available === false);

  const mk = ETSR.marketCompare(12.1, 9.4);
  close('market: the difference is arithmetic', mk.difference, 2.7, 1e-9);
  ok('market: it is labelled a disagreement', /DISAGREEMENT|IN LINE/.test(mk.label));
  ok('market: and never an edge', /never|not/i.test(CFG.MARKET.never_call_it) || CFG.MARKET.never_call_it.length > 0);
  ok('market: the market is declared not an input', CFG.MARKET.is_input === false && mk.is_input === false);
  const noMk = ETSR.marketCompare(12.1, null);
  ok('market: with no market number it refuses', noMk.available === false);
})();

/* ---------------------------------------------------------------- */
/* 8. RUN DEFENCE POWER                                              */
/* ---------------------------------------------------------------- */
(function runD() {
  const league = { a: fakeUnits(60) };
  const t = TAL.build(league, {}).teams.a;
  t._front_returning = 0.7;
  const perf = { sub_units: { run_defense: { used: [
    { id: 'rd_success', z: 1.2 }, { id: 'rd_stuffed', z: 0.8 },
    { id: 'rd_explosive', z: 0.6 }, { id: 'rd_ypc', z: 0.9 }] } } };
  const s = ETSR.runDefencePower(t, perf);
  ok('run defence: a full contract publishes a score', s.available === true);
  ok('run defence: with a band', ['ELITE', 'STRONG', 'SOLID', 'SOFT', 'FRAGILE'].indexOf(s.band) >= 0);
  ok('run defence: every component names its basis', s.components.every(c => !!c.basis));
  ok('run defence: what it cannot see is named', !!s.unobservable.missed_tackles && !!s.unobservable.run_stops);
  ok('run defence: QB rush defence is declared unseparable', s.qb_rush_defence.applied === false);

  /* a roster that spells its ends DL has not lost them */
  const noEdge = ETSR.runDefencePower(t, perf);
  ok('run defence: the DL component absorbs the edge weight when uncovered',
    noEdge.components.some(c => c.id === 'dl_unit' && c.absorbed === 'edge_unit'));

  const blind = ETSR.runDefencePower({ units: {}, returning: null }, null);
  ok('run defence: with nothing to read it refuses', blind.available === false);
  eq('run defence: and says UNKNOWN', blind.band, 'UNKNOWN');
  ok('run defence: naming how little arrived', blind.completeness < CFG.RUN_DEFENCE_POWER.min_completeness);
})();

/* ---------------------------------------------------------------- */
/* 9. STABILITY AND ANOMALIES — these FAIL a build                   */
/* ---------------------------------------------------------------- */
(function anomalies() {
  const now = {}, prev = {};
  for (let i = 0; i < 20; i++) {
    now['t' + i] = { etsr: i, rank: 20 - i, talent: { rating: 50 }, confidence: { value: 0.6 } };
    prev['t' + i] = { etsr: i, rank: 20 - i, talent: { rating: 50 } };
  }
  const calm = ETSR.stability(now, prev);
  eq('stability: an unchanged board has no failures', calm.failures.length, 0);
  const wild = JSON.parse(JSON.stringify(prev));
  for (let i = 0; i < 20; i++) wild['t' + i].rank = i;      /* every team inverted */
  const chaos = ETSR.stability(now, wild);
  ok('stability: a board that turned over fails', chaos.failures.length > 0);
  ok('stability: and it fails for real — the pool never changed', chaos.fails_build === true);

  /* A LONGER RANKED LIST IS NOT A MOVING BOARD, and this is the case that
     refused to publish a correct week-three rebuild. Twenty settled teams in
     exactly the same order, with twenty newly-confident teams interleaved
     between them: every one of the twenty is pushed down the page and not one
     of them passed another. The raw difference reads that as a turnover — on
     the real 2026 boards, 25.50 mean places and 56% moving fifteen or more,
     against 6.21 and 8.8% once the same teams are put on the same scale. */
  const grownPrev = {}, grownNow = {};
  for (let i = 0; i < 20; i++) {
    grownPrev['t' + i] = { etsr: 40 - i, rank: i + 1, talent: { rating: 50 } };
    grownNow['t' + i] = { etsr: 40 - i, rank: 2 * i + 1, talent: { rating: 50 }, confidence: { value: 0.6 } };
    grownNow['n' + i] = { etsr: 40 - i - 0.5, rank: 2 * i + 2, talent: { rating: 50 }, confidence: { value: 0.6 } };
  }
  const grown = ETSR.stability(grownNow, grownPrev);
  eq('stability: teams the ranked list grew underneath have not moved', grown.mean_rank_shift, 0);
  eq('stability: so a lengthening list raises no failure', grown.failures.length, 0);
  ok('stability: the raw renumbering is still published, never bounded',
    grown.whole_board.mean_rank_shift > 9);
  eq('stability: the ranked pool is published, before', grown.ranked_pool.previous, 20);
  eq('stability: and after', grown.ranked_pool.now, 40);
  ok('stability: a pool that doubled is not a like-for-like comparison', grown.comparable === false);
  ok('stability: and says so in words', grown.not_comparable_because.some(r => /ranked pool went from 20 teams to 40/.test(r)));
  eq('stability: an unchanged pool leaves the two measures identical',
    calm.whole_board.mean_rank_shift, calm.mean_rank_shift);

  const jump = { a: { etsr: 20, talent: { rating: 50 }, confidence: { value: 0.6 } } };
  const before = { a: { etsr: 2, talent: { rating: 50 } } };
  const an = ETSR.anomalies(jump, before, {});
  ok('anomaly: a big one-week rating jump is severe', an.list.some(x => x.id === 'RATING_JUMP' && x.severity === 'severe'));
  const collapse = ETSR.anomalies({ a: { etsr: 3, talent: { rating: 40 }, confidence: { value: 0.6 } } },
    { a: { etsr: 2, talent: { rating: 50 } } }, {});
  ok('anomaly: talent collapsing in a week is severe', collapse.list.some(x => x.id === 'TALENT_COLLAPSE'));
  ok('anomaly: because talent may not react to a result',
    collapse.list.find(x => x.id === 'TALENT_COLLAPSE').detail.indexOf('react to a result') > 0);
  const impossible = ETSR.anomalies({ a: { etsr: 99, talent: { rating: 50 }, confidence: { value: 0.6 } } }, null, {});
  ok('anomaly: an impossible rating is severe', impossible.list.some(x => x.id === 'IMPOSSIBLE_RATING'));
  const missing = ETSR.anomalies({ a: { etsr: 1, talent: { rating: 50 }, confidence: { value: 0.6 } } }, null,
    { expected_teams: ['a', 'b'] });
  ok('anomaly: an FBS team with no rating is severe', missing.list.some(x => x.id === 'MISSING_TEAM' && x.team === 'b'));
  const stray = ETSR.anomalies({ zzz: { etsr: 1, talent: { rating: 50 }, confidence: { value: 0.6 } } }, null,
    { expected_teams: ['a'] });
  ok('anomaly: a team key nothing recognises is a mapping fault', stray.list.some(x => x.id === 'TEAM_MAPPING'));
})();

/* ---------------------------------------------------------------- */
/* 10. THE FEATURE PROMOTION GATE                                    */
/* ---------------------------------------------------------------- */
(function promotion() {
  const base = { spread_mae: 12.5, brier: 0.178, n: 800 };
  function arm(o) {
    return Object.assign({ feature: 'f', spread_mae: 12.3, brier: 0.177, paired: { p: 0.01 },
      leakage_clean: true, per_season: [{ season: 2024, n: 800, mae_before: 12.6, mae_after: 12.4 },
        { season: 2025, n: 800, mae_before: 12.4, mae_after: 12.2 }] }, o);
  }
  eq('promotion: a feature that clears everything is VALIDATED', PROMOTE.evaluate(arm({}), base).status, 'VALIDATED');
  eq('promotion: one holdout season is never enough',
    PROMOTE.evaluate(arm({ per_season: [{ season: 2025, n: 800, mae_before: 12.5, mae_after: 12.3 }] }), base).status, 'CANDIDATE');
  eq('promotion: an insignificant improvement is not promoted',
    PROMOTE.evaluate(arm({ paired: { p: 0.4 } }), base).status, 'CANDIDATE');
  eq('promotion: a feature that makes things worse is REJECTED',
    PROMOTE.evaluate(arm({ spread_mae: 13.0 }), base).status, 'REJECTED');
  eq('promotion: worsening calibration blocks promotion',
    PROMOTE.evaluate(arm({ brier: 0.19 }), base).status, 'CANDIDATE');
  eq('promotion: an untested leakage arm is not promoted',
    PROMOTE.evaluate(arm({ leakage_clean: null }), base).status, 'CANDIDATE');
  /* AND A TESTED ONE THAT FAILED IS NOT A CANDIDATE AT ALL. "The test has not
     run" and "the test ran and the arm knows the result" are different
     statements, and only the first one leaves room for the arm to turn out
     clean. The second is the retrospective arm of the quarterback EPA
     experiment, which exists to be an upper bound and must never read as
     something that might one day price. */
  eq('promotion: an arm whose leakage test FAILED is never a candidate',
    PROMOTE.evaluate(arm({ leakage_clean: false }), base).status, 'RESEARCH_ONLY');
  ok('promotion: and it still may not move a line',
    PROMOTE.evaluate(arm({ leakage_clean: false }), base).may_move_lines === false);
  eq('promotion: a season it badly degrades blocks promotion',
    PROMOTE.evaluate(arm({ per_season: [{ season: 2024, n: 800, mae_before: 12.6, mae_after: 13.2 },
      { season: 2025, n: 800, mae_before: 12.4, mae_after: 11.9 }] }), base).status, 'CANDIDATE');

  ok('promotion: the default answer is NO', PROMOTE.mayMove('anything', null).allowed === false);
  ok('promotion: an unknown feature moves nothing', PROMOTE.mayMove('nope', { features: [] }).allowed === false);
  const reg = PROMOTE.registry([PROMOTE.evaluate(arm({}), base)], {});
  ok('promotion: a validated feature may move a line', PROMOTE.mayMove('f', reg).allowed === true);
  ok('promotion: and carries its fitted coefficient path', 'coefficient' in PROMOTE.mayMove('f', reg));
  ok('promotion: a rejected feature stays in the registry', PROMOTE.STATUSES.indexOf('REJECTED') >= 0);
})();

/* ---------------------------------------------------------------- */
/* 11. THE ENRICHMENT LAYER                                          */
/* ---------------------------------------------------------------- */
(function enrichment() {
  eq('box: made/attempts pairs are split, never guessed', JSON.stringify(BOX.pair('18/24')), JSON.stringify([18, 24]));
  eq('box: an empty pair is zeros', JSON.stringify(BOX.pair('')), JSON.stringify([0, 0]));
  eq('box: NA is zero, not NaN', BOX.numOf('NA'), 0);
  ok('box: every gate names a floor and a basis',
    Object.keys(BOX.GATES).every(k => BOX.GATES[k].per_team_game_min > 0 && !!BOX.GATES[k].basis));

  /* the observability contract was CORRECTED by the audit and must stay corrected */
  eq('observability: punting is observable', PCFG.OBSERVABILITY.punting.observed, 'gated');
  eq('observability: tackles are observable', PCFG.OBSERVABILITY.tackles.observed, 'gated');
  eq('observability: pressures short of a sack are observable', PCFG.OBSERVABILITY.pressures.observed, 'gated');
  eq('observability: a run STOP is still not', PCFG.OBSERVABILITY.run_stops.observed, false);
  eq('observability: missed tackles are still not', PCFG.OBSERVABILITY.missed_tackles.observed, false);
  eq('observability: an individual lineman is still not', PCFG.OBSERVABILITY.ol_individual.observed, false);
  ok('observability: QBR is ingested and never rates anybody',
    PCFG.OBSERVABILITY.qbr.observed === true && PCFG.OBSERVABILITY.qbr.used_in_rating === false);

  /* v1 must be provably unchanged by v2's existence */
  const v1 = PCFG.measures('v1'), v2 = PCFG.measures('v2');
  ok('v2: the offensive contracts are untouched',
    JSON.stringify(v1.QB) === JSON.stringify(v2.QB) && JSON.stringify(v1.RB) === JSON.stringify(v2.RB)
    && JSON.stringify(v1.WR) === JSON.stringify(v2.WR));
  ok('v2: the offensive line gains nothing, because the box carries nothing for it',
    v1.OL.length === 0 && v2.OL.length === 0);
  ok('v2: the defensive contracts do change', JSON.stringify(v1.LB) !== JSON.stringify(v2.LB));
  ok('v2: a punter becomes rateable', v1.P.length === 0 && v2.P.length > 0);
  ok('v2: every v2 measure is gated', ['EDGE', 'DL', 'LB', 'CB', 'S', 'DB', 'P'].every(
    g => v2[g].every(m => !!m.gate)));
  ok('v2: v2 keys are namespaced so provenance is visible',
    v2.LB.some(m => /^box_/.test(m.key)));
  ok('v2: QBR is not a measure anywhere',
    !Object.keys(v2).some(g => (v2[g] || []).some(m => /qbr/i.test(m.key))));

  /* participation is not a snap count and never claims to be */
  ok('participation: appearances and touches are combined, not conflated',
    PCFG.PARTICIPATION.appearance_weight > 0 && PCFG.PARTICIPATION.touch_weight > 0);
  ok('participation: and it says it is not a snap share', /NOT a snap share|not a snap/i.test(PCFG.PARTICIPATION.basis));
  ok('participation: the bands include HEAVY ROTATION',
    PCFG.PARTICIPATION.bands.some(b => b.role === 'HEAVY ROTATION'));
  ok('participation: UNKNOWN is still a band', PCFG.PARTICIPATION.bands.some(b => b.role === 'UNKNOWN'));

  /* a defender with only box evidence is rateable under v2 and not under v1 */
  const pop = [];
  for (let i = 0; i < 40; i++) {
    pop.push({ athlete_id: String(i), name: 'LB' + i, team: 'T', team_key: 't', season: 2025,
      pos: 'LB', group: 'LB', identity: 'athlete_id', games: 12,
      stat: { team_def_games: 12, team_games: 12, box_games: 12,
        box_tackles: 30 + i * 2, box_tfl: 2 + (i % 8), box_hurries: 1 + (i % 5),
        box_pbu: i % 4, box_sacks: i % 3, team_group_volume: 400 } });
  }
  const cov = { box_tackles: { usable: true }, box_tfl: { usable: true }, box_hurries: { usable: true },
    box_pbu: { usable: true }, box_int: { usable: true }, box_sacks: { usable: true },
    sacks: { usable: false, reason: 'the play table drops sacks' },
    pass_breakups: { usable: false, reason: 'collapsed' }, interceptions: { usable: false, reason: 'collapsed' } };
  const b1 = PEPIR.buildBaselines(pop, cov, 'v1');
  const b2 = PEPIR.buildBaselines(pop, cov, 'v2');
  const r1 = PEPIR.ratePlayer(pop[39], { baselines: b1, coverage: cov, season: 2025, variant: 'v1' });
  const r2 = PEPIR.ratePlayer(pop[39], { baselines: b2, coverage: cov, season: 2025, variant: 'v2' });
  eq('v2: v1 cannot score this linebacker at all', r1.measures_used.length, 0);
  ok('v2: v2 can', r2.measures_used.length >= 3);
  ok('v2: and the variant is stamped on the rating', r2.variant === 'v2' && r1.variant === 'v1');
  ok('v2: a productive linebacker rates above replacement under v2', r2.epir > 55);
  ok('participation: his role comes from appearances, not touches', r2.role.from_participation === true);
  ok('participation: and both shares are published', r2.role.participation_share != null);
})();

/* ---------------------------------------------------------------- */
/* 12. THE COMMITTED ARTIFACTS                                       */
/* ---------------------------------------------------------------- */
(function artifacts() {
  const cur = path.join(__dirname, 'current.json');
  if (!fs.existsSync(cur)) { ok('artifact: rankings current.json exists (run build_rankings.js)', false); return; }
  const m = JSON.parse(fs.readFileSync(cur, 'utf8'));
  eq('artifact: schema', m.schema, 'edgedesk_national_rankings_v1');
  ok('artifact: every version is stamped', !!m.versions.team_rating && !!m.versions.talent && !!m.versions.performance);
  ok('artifact: the data-as-of stamp is present', !!m.data_as_of);
  ok('artifact: the season and week are resolved, not calendar-derived', m.week_ordinal != null && !!m.week_label);
  ok('artifact: every FBS team is present', m.team_count > 120);
  ok('artifact: the carryover slope is measured', m.carryover.pairs.length > 0);
  ok('artifact: the market is declared not an input', m.market.is_input === false);
  ok('artifact: no severe anomalies were published', m.anomalies.severe === 0);
  ok('artifact: it states that home field is not in the rating',
    m.notes.some(n => /NEUTRAL-FIELD/i.test(n)));
  ok('artifact: and that no model wrote any of it', m.notes.some(n => /No language model/i.test(n)));
  ok('artifact: the opponent adjustment converged', m.performance_diagnostics.all_converged === true);

  const snaps = fs.existsSync(path.join(__dirname, 'snapshots'))
    ? fs.readdirSync(path.join(__dirname, 'snapshots')).filter(f => f.endsWith('.json')) : [];
  ok('snapshot: at least one point-in-time snapshot exists', snaps.length > 0);
  if (snaps.length) {
    const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'snapshots', snaps[0]), 'utf8'));
    ok('snapshot: it is stamped with its own week ordinal', s.week_ordinal != null);
    ok('snapshot: and the versions it was built under', !!s.versions);
    ok('snapshot: and carries every team', Object.keys(s.teams).length > 120);
    ok('snapshot: the filename IS the point in time', /^\d{4}-w\d{2}\.json$/.test(snaps[0]));
  }

  const fsPath = path.join(__dirname, '..', 'validation', 'feature-status.json');
  if (fs.existsSync(fsPath)) {
    const reg = JSON.parse(fs.readFileSync(fsPath, 'utf8'));
    ok('registry: every feature carries a status', reg.features.every(f => PROMOTE.STATUSES.indexOf(f.status) >= 0));
    ok('registry: a non-validated feature explains itself',
      reg.features.every(f => f.status === 'VALIDATED' || f.reasons.length > 0));
    ok('registry: it states plainly whether anything may move a line', !!reg.statement);
    ok('registry: and the rules are shipped with it', !!reg.rules && reg.rules.min_holdout_seasons >= 2);
  }

  const boxMan = path.join(__dirname, '..', 'data', 'box', 'manifest.json');
  if (fs.existsSync(boxMan)) {
    const bm = JSON.parse(fs.readFileSync(boxMan, 'utf8'));
    ok('box: the manifest records the correction it forced', /corrected/i.test(bm.correction));
    ok('box: and its limits', bm.limits.length >= 3);
    ok('box: at least one season is usable', Object.keys(bm.seasons).some(y => bm.seasons[y].available));
  }
})();

/* ---------------------------------------------------------------- */
/* 13. NO LLM, NO EDGE FUNCTION, NO BROWSER REBUILD                  */
/* ---------------------------------------------------------------- */
(function architecture() {
  const files = ['config.js', 'performance.js', 'talent.js', 'etsr.js', 'build_rankings.js'];
  const banned = /\b(openai|anthropic|claude|gpt-|completions?\.create|generateText)\b/i;
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    ok('architecture: ' + f + ' calls no language model', !banned.test(src));
    ok('architecture: ' + f + ' calls no Edge Function',
      !/functions\/v1\/|supabase\.co\/functions/.test(src));
  }
  const val = fs.readFileSync(path.join(__dirname, '..', 'validation', 'validate_features.js'), 'utf8');
  ok('architecture: the validator rebuilds layers per week rather than filtering finished ones',
    /prefixPlayers/.test(val));
  ok('architecture: and refuses an overlapping tune and holdout window',
    /tune and holdout overlap/.test(val));
})();

/* ---------------------------------------------------------------- */
console.log((failed ? '\n' : '') + fails.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\nrankings + enrichment: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
