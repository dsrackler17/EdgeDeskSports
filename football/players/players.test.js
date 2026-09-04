#!/usr/bin/env node
/* ============================================================================
   THE RULES OF THE PLAYER QUALITY LAYER, ENFORCED.

   Every check here is a rule the layer is not allowed to break: a missing input
   must never become a zero, a rating must never silently know the future, a
   simulation must be reproducible, the market must never reach a model number,
   and nothing anywhere may be produced by a language model.

     node football/players/players.test.js      # exit 0 = green
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = require('./config.js');
const EPIR = require('./epir.js');
const UNITS = require('./units.js');
const SCHEME = require('./scheme.js');
const MATCH = require('./matchup.js');
const SIM = require('./sim.js');
const REC = require('./recruiting_adapter.js');
const BUILD = require('./build_players.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; return; }
  failed++; fails.push(name + (extra ? ' — ' + extra : ''));
}
function eq(name, a, b) { ok(name, a === b, 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function close(name, a, b, tol) { ok(name, a != null && Math.abs(a - b) <= (tol || 1e-9), 'got ' + a + ', expected ~' + b); }

/* ---------------------------------------------------------------- */
/* 1. IDENTITY RESOLUTION                                            */
/* ---------------------------------------------------------------- */
(function identity() {
  const withId = { athlete_id: '4685699', name: 'Damari Alston', team: 'Auburn' };
  const noId = { athlete_id: null, name: 'Damari Alston', team: 'Auburn' };
  const noIdOther = { athlete_id: null, name: 'Damari Alston', team: 'Oregon' };
  eq('identity: an athlete id wins', EPIR.identity.key(withId), 'a:4685699');
  eq('identity: tier is athlete_id', EPIR.identity.tier(withId), 'athlete_id');
  eq('identity: NA is not an id', EPIR.identity.key({ athlete_id: 'NA', name: 'X Y', team: 'Auburn' }), 'n:auburn:x_y');
  eq('identity: a name join is scoped to the team', EPIR.identity.tier(noId), 'name_and_team');
  ok('identity: same name at two schools never collides', EPIR.identity.key(noId) !== EPIR.identity.key(noIdOther));
  eq('identity: a name with no team resolves to nothing', EPIR.identity.key({ name: 'Nobody' }), null);
  eq('identity: the team key is byte-identical to the Power 4 engine’s', EPIR.teamKey('Texas A&M'), 'texasam');
  eq('identity: accents fold', EPIR.teamKey('San José State'), 'sanjosestate');
  /* THE JOIN THE WHOLE FEATURE HANGS ON. app.html looks this layer up by
     EDCfbP4.normKey; a divergence loses a team silently instead of erroring. */
  try {
    require(path.join(__dirname, '..', 'cfb_p4', 'params.js'));
    const P4 = require(path.join(__dirname, '..', 'cfb_p4', 'engine.js'));
    const names = ['Texas A&M', 'San José State', 'Miami (OH)', 'Ohio State', 'Louisiana-Monroe',
      "Hawai'i", 'UMass', 'Southern Mississippi', 'UT San Antonio', 'Florida International'];
    let bad = [];
    for (const n of names) if (P4.normKey(n) !== EPIR.teamKey(n)) bad.push(n + ': ' + P4.normKey(n) + ' vs ' + EPIR.teamKey(n));
    ok('identity: the team key is byte-identical to EDCfbP4.normKey', bad.length === 0, bad.join('; '));
  } catch (e) { ok('identity: the Power 4 engine could be loaded for the key cross-check', false, e.message); }

  /* duplicate athletes and mid-season school changes */
  const rows = [
    { athlete_id: '9', name: 'A B', team: 'Utah', season: 2025, pos: 'RB', games: 3, first_week: 1, last_week: 4,
      stat: { rush_att: 30, rush_yds: 100, rush_success: 12 } },
    { athlete_id: '9', name: 'A B', team: 'UCLA', season: 2025, pos: 'WR', games: 5, first_week: 8, last_week: 12,
      stat: { rush_att: 10, rush_yds: 60, rush_success: 5 } }
  ];
  const merged = EPIR.identity.mergeSeason(rows);
  eq('duplicates: counting stats add', merged.stat.rush_att, 40);
  eq('duplicates: the latest week wins the team', merged.team_key, 'ucla');
  eq('duplicates: the latest week wins the position', merged.pos, 'WR');
  eq('duplicates: the merge is recorded', merged.duplicates, 2);
  ok('duplicates: a mid-season move is flagged', merged.mid_season_move === true);
  eq('duplicates: both teams are kept', merged.teams_this_season.length, 2);
  eq('duplicates: games add', merged.games, 8);
  eq('duplicates: first week is the earliest', merged.first_week, 1);

  /* a player who changes position between seasons is two group memberships,
     never one silently overwritten */
  const y1 = { athlete_id: '11', name: 'C D', team: 'Iowa', season: 2024, pos: 'ATH', group: CFG.group('ATH') };
  const y2 = { athlete_id: '11', name: 'C D', team: 'Iowa', season: 2025, pos: 'WR', group: CFG.group('WR') };
  eq('position change: same key across seasons', EPIR.identity.key(y1), EPIR.identity.key(y2));
  ok('position change: the group actually changes', y1.group !== y2.group);
})();

/* ---------------------------------------------------------------- */
/* 2. POSITION GROUPS                                                */
/* ---------------------------------------------------------------- */
(function groups() {
  eq('group: LT is OL', CFG.group('LT'), 'OL');
  eq('group: NT is DL', CFG.group('nt'), 'DL');
  eq('group: OLB is LB', CFG.group('OLB'), 'LB');
  eq('group: FS is S', CFG.group('FS'), 'S');
  eq('group: PK is K', CFG.group('PK'), 'K');
  eq('group: an unknown spelling resolves to nothing, not to ATH', CFG.group('ZZZ'), null);
  ok('group: the offensive line has an EMPTY measure contract on purpose', CFG.MEASURES.OL.length === 0);
  ok('group: and says why', !!CFG.NO_PRODUCTION_FEED.OL);
  /* CORRECTED BY THE DATA. This assertion used to read `observed === false`.
     The ESPN player box carries punts, punt yards and punts inside the twenty
     for every season checked, so punting is observable, is gated per season
     like everything else, and punters are rateable. The test now holds the
     new truth AND that it is gated rather than assumed. */
  eq('group: punting is observable, and gated', CFG.OBSERVABILITY.punting.observed, 'gated');
  ok('group: and names the feed that carries it', /player box/i.test(CFG.OBSERVABILITY.punting.source || ''));
  ok('group: a punter now has a measure contract', (CFG.measures('v2').P || []).length > 0);
  ok('group: but v1 is unchanged and still has none', (CFG.measures('v1').P || []).length === 0);
  ok('group: pressures short of a sack are observable and gated', CFG.OBSERVABILITY.pressures.observed === 'gated');
  ok('group: tackles are observable and gated', CFG.OBSERVABILITY.tackles.observed === 'gated');
  ok('group: a RUN STOP is still not observable, and says why', CFG.OBSERVABILITY.run_stops.observed === false
    && /line-to-gain|down and distance/i.test(CFG.OBSERVABILITY.run_stops.reason));
  ok('group: missed tackles are still not observable', CFG.OBSERVABILITY.missed_tackles.observed === false);
  ok('group: QBR is ingested but never an input to a rating',
    CFG.OBSERVABILITY.qbr.observed === true && CFG.OBSERVABILITY.qbr.used_in_rating === false);
  ok('group: snap share is declared unobservable', CFG.OBSERVABILITY.snap_share.observed === false);
  ok('group: EPA is declared not computed', CFG.OBSERVABILITY.epa.observed === false);
})();

/* ---------------------------------------------------------------- */
/* 3. RATES — a missing denominator is null, never zero              */
/* ---------------------------------------------------------------- */
(function rates() {
  const empty = EPIR.rates({ group: 'WR', stat: {} });
  eq('rates: no targets means NO catch rate', empty.catch_rate, null);
  eq('rates: no carries means NO yards per rush', empty.yards_per_rush, null);
  const wr = EPIR.rates({ group: 'WR', stat: { receptions: 40, rec_yds: 600, targets: 60, rec_success: 24, rec_explosive: 8 } });
  close('rates: catch rate', wr.catch_rate.v, 40 / 60);
  eq('rates: the denominator travels with the value', wr.catch_rate.n, 60);
  close('rates: yards per catch', wr.rec_yards_per_catch.v, 15);
  const qb = EPIR.rates({ group: 'QB', stat: { pass_att: 300, sacks_taken: 20, pass_success: 140, pass_cmp: 190, pass_yds: 2400 } });
  close('rates: a sack is a dropback', qb.pass_success_rate.v, 140 / 320);
  close('rates: a sack is NOT an attempt', qb.yards_per_attempt.v, 8);
  close('rates: sack rate is per dropback', qb.sack_rate_taken.v, 20 / 320);
  const dl = EPIR.rates({ group: 'DL', stat: { def_sacks: 9, team_def_games: 12 } });
  close('rates: defence is production per team game', dl.sacks_per_game.v, 0.75);
  eq('rates: and the denominator is games, not snaps', dl.sacks_per_game.n, 12);
})();

/* ---------------------------------------------------------------- */
/* 4. SUCCESS RATE                                                   */
/* ---------------------------------------------------------------- */
(function success() {
  eq('success: 5 yards on 1st and 10 is a success', BUILD.isSuccess(1, 10, 5), 1);
  eq('success: 4 yards on 1st and 10 is not', BUILD.isSuccess(1, 10, 4), 0);
  eq('success: 7 yards on 2nd and 10 is a success', BUILD.isSuccess(2, 10, 7), 1);
  eq('success: 9 yards on 3rd and 10 is not', BUILD.isSuccess(3, 10, 9), 0);
  eq('success: 10 yards on 4th and 10 is', BUILD.isSuccess(4, 10, 10), 1);
  eq('success: an unknown down is unknown, not a failure', BUILD.isSuccess(null, 10, 5), null);
})();

/* ---------------------------------------------------------------- */
/* 5. BASELINES, SHRINKAGE AND THE RATING                            */
/* ---------------------------------------------------------------- */
function rbPop(n, seed) {
  const out = [];
  let s = seed || 1;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const att = 60 + Math.floor(rnd() * 150);
    out.push({ athlete_id: String(1000 + i), name: 'RB ' + i, team: 'Team' + (i % 12), team_key: 'team' + (i % 12),
      season: 2025, pos: 'RB', group: 'RB', identity: 'athlete_id', games: 11,
      stat: { rush_att: att, rush_yds: Math.round(att * (3.5 + rnd() * 2.5)),
        rush_success: Math.round(att * (0.35 + rnd() * 0.2)),
        rush_explosive: Math.round(att * (0.03 + rnd() * 0.06)),
        rush_stuffed: Math.round(att * (0.12 + rnd() * 0.12)),
        receptions: 15, rec_yds: 130, fumbles: 1, team_group_volume: 400 } });
  }
  return out;
}
(function rating() {
  const pop = rbPop(60, 7);
  const base = EPIR.buildBaselines(pop, {});
  ok('baselines: a group with enough qualified players is usable', base.RB.measures.rush_success_rate.usable === true);
  ok('baselines: the population size ships', base.RB.measures.rush_success_rate.n >= 40);
  const thin = EPIR.buildBaselines(rbPop(6, 3), {});
  ok('baselines: a thin population is NOT standardised', thin.RB.measures.rush_success_rate.usable === false);
  ok('baselines: and says why', /too few/.test(thin.RB.measures.rush_success_rate.reason));

  const r = EPIR.ratePlayer(pop[0], { baselines: base, season: 2025, coverage: {}, params: null });
  ok('rating: EPIR is on the 0-100 scale', r.epir >= 1 && r.epir <= 99);
  ok('rating: confidence is a probability', r.confidence >= 0 && r.confidence <= 1);
  ok('rating: the sample size ships', r.sample_size > 0);
  ok('rating: every scored measure names its baseline', r.measures_used.every(m => m.baseline_n > 0));
  ok('rating: every missing measure names a reason', r.measures_missing.every(m => !!m.reason && !!m.kind));
  ok('rating: the shrinkage constant travels with the rating', r.components.quality.k > 0);
  ok('rating: recruiting is declared, not applied', r.components.recruiting_prior.applied === false);
  ok('rating: availability is NOT baked into EPIR', r.components.availability_adjustment.applied === false);
  ok('rating: the snap-share gap is named on every player', r.unmeasured.some(u => /snap count/.test(u)));

  /* a player with no production is not a bad player */
  const blank = { athlete_id: '99', name: 'Blank', team: 'Team0', team_key: 'team0', season: 2025,
    pos: 'RB', group: 'RB', identity: 'athlete_id', games: 0, stat: { team_group_volume: 400 } };
  const rb = EPIR.ratePlayer(blank, { baselines: base, season: 2025, coverage: {}, params: null });
  eq('empty: a player with no evidence sits at positional replacement', rb.epir, CFG.EPIR_SCALE.center);
  ok('empty: and his confidence is low', rb.confidence < 0.45);
  eq('empty: his role is UNKNOWN, not DEPTH', rb.role.expected_role, 'UNKNOWN');
  eq('empty: nothing was scored', rb.measures_used.length, 0);
  ok('empty: every measure says why it is missing', rb.measures_missing.length === CFG.MEASURES.RB.length);

  /* MORE EVIDENCE MUST BEAT PEDIGREE. A high recruiting prior with a long,
     bad college record has to end up below replacement. */
  const bad = JSON.parse(JSON.stringify(pop[0]));
  bad.stat.rush_success = Math.round(bad.stat.rush_att * 0.20);
  bad.stat.rush_yds = Math.round(bad.stat.rush_att * 2.2);
  bad.stat.rush_stuffed = Math.round(bad.stat.rush_att * 0.35);
  bad.stat.rush_explosive = 0;
  bad.recruiting = { z: 2.5, source: 'test' };
  const few = EPIR.ratePlayer(bad, { baselines: base, season: 2025, coverage: {}, params: null, career: [] });
  const many = EPIR.ratePlayer(bad, { baselines: base, season: 2025, coverage: {}, params: null,
    career: [{ season: 2024, z: -1.8, n: 900, dc: 1 }, { season: 2023, z: -1.7, n: 900, dc: 1 }] });
  ok('shrinkage: a five-star with a long bad record rates below one with a short bad record', many.epir < few.epir);
  ok('shrinkage: and the prior’s grip weakens as evidence accumulates', many.components.quality.shrink_weight > few.components.quality.shrink_weight);
  ok('shrinkage: the prior source is named', /recruiting/.test(many.components.quality.prior_source));

  /* a transfer pays in confidence, not in rating */
  const t1 = JSON.parse(JSON.stringify(pop[1])); t1.status = 'returning';
  const t2 = JSON.parse(JSON.stringify(pop[1])); t2.status = 'transfer';
  const a1 = EPIR.ratePlayer(t1, { baselines: base, season: 2025, coverage: {}, params: null });
  const a2 = EPIR.ratePlayer(t2, { baselines: base, season: 2025, coverage: {}, params: null });
  eq('transfer: changing schools does not change the rating', a1.epir, a2.epir);
  ok('transfer: changing schools lowers the confidence', a2.confidence < a1.confidence);

  /* recency: an old season counts for less than a new one */
  const oldOnly = EPIR.ratePlayer(blank, { baselines: base, season: 2025, coverage: {}, params: null,
    career: [{ season: 2021, z: 2, n: 500, dc: 1 }] });
  const newOnly = EPIR.ratePlayer(blank, { baselines: base, season: 2025, coverage: {}, params: null,
    career: [{ season: 2024, z: 2, n: 500, dc: 1 }] });
  ok('recency: recent evidence outweighs old evidence', newOnly.epir > oldOnly.epir);
})();

/* ---------------------------------------------------------------- */
/* 6. COVERAGE GATES — a broken feed column is missing, not zero     */
/* ---------------------------------------------------------------- */
(function gates() {
  const good = BUILD.coverageGates({ targets: 20000, interceptions: 2200, pass_breakups: 6000, forced_fumbles: 900, sacks: 3200 }, 2800);
  ok('gate: a healthy sack column is usable', good.sacks.usable === true);
  const bad = BUILD.coverageGates({ targets: 900, interceptions: 600, pass_breakups: 400, forced_fumbles: 10, sacks: 2700 }, 2800);
  ok('gate: a collapsed interception column is NOT usable', bad.interceptions.usable === false);
  ok('gate: and the reason names the observed rate', /per team-game/.test(bad.interceptions.reason));

  const pop = rbPop(40, 5);
  for (const p of pop) { p.group = 'CB'; p.pos = 'CB'; p.stat = { def_pbu: 5, def_int: 1, team_def_games: 12 }; }
  const blocked = EPIR.buildBaselines(pop, bad);
  ok('gate: a gated measure is not standardised at all', blocked.CB.measures.pbu_per_game.usable === false);
  const r = EPIR.ratePlayer(pop[0], { baselines: blocked, season: 2025, coverage: bad, params: null });
  ok('gate: a gated measure is DECLARED MISSING on the player', r.measures_missing.some(m => m.kind === 'coverage_gate'));
  ok('gate: and it is never scored as zero', r.measures_used.every(m => m.key !== 'pbu_per_game'));
})();

/* ---------------------------------------------------------------- */
/* 7. OPPONENT ADJUSTMENT                                            */
/* ---------------------------------------------------------------- */
(function opponent() {
  const ps = { stat: {}, opponent: { rush_success_rate: 0.50 } };
  const league = { rush_success_rate: 0.42 };
  const a = EPIR.adjustForOpponent('rush_success_rate', 0.50, ps, league, 1);
  ok('opponent: an easy schedule pulls the number down', a.v < 0.50);
  ok('opponent: and the adjustment is flagged', a.adjusted === true);
  const none = EPIR.adjustForOpponent('rush_success_rate', 0.50, { stat: {} }, league, 1);
  eq('opponent: with nothing to adjust against, the raw value stands', none.v, 0.50);
  eq('opponent: and it says it was not adjusted', none.adjusted, false);
  const neg = EPIR.adjustForOpponent('sack_rate_taken', 0.08, { opponent: { sack_rate_taken: 0.09 } }, { sack_rate_taken: 0.06 }, -1);
  ok('opponent: a lower-is-better rate adjusts the other way', neg.v > 0.08);
})();

/* ---------------------------------------------------------------- */
/* 8. POSITION-GROUP AGGREGATION                                     */
/* ---------------------------------------------------------------- */
function mkR(id, group, epir, conf, status, role) {
  return { key: 'a:' + id, name: 'P' + id, pos: group, group, epir, confidence: conf,
    status: status || 'returning', sample_size: 200, seasons_observed: 2,
    role: { expected_role: role || 'STARTER', share: 0.4 } };
}
(function aggregation() {
  const qb = UNITS.rateGroup('QB', [mkR(1, 'QB', 90, 0.9), mkR(2, 'QB', 40, 0.5), mkR(3, 'QB', 30, 0.3)], {});
  ok('group: a QB room is not the mean of its quarterbacks', Math.abs(qb.rating - (90 + 40 + 30) / 3) > 15);
  ok('group: QB1 carries the room', qb.rating > 75);
  eq('group: starter quality is QB1', qb.starter_quality, 90);
  ok('group: depth quality is separate and lower', qb.depth_quality < qb.starter_quality);

  const ol = UNITS.rateGroup('OL', [1, 2, 3, 4, 5, 6, 7].map(i => mkR(i, 'OL', 50 + i, 0.3)), {});
  ok('group: an offensive line has no production feed', ol.production_feed === false);
  ok('group: and says why on its face', /no public feed/i.test(ol.production_feed_reason));
  const sum = ol.projected.slice(0, 5).reduce((s, p) => s + p.depth_weight, 0);
  ok('group: five linemen carry the line', sum > 0.9);

  const dl = UNITS.rateGroup('DL', [1, 2, 3, 4, 5, 6].map(i => mkR(i, 'DL', 60, 0.6)), {});
  const top2 = dl.projected.slice(0, 2).reduce((s, p) => s + p.depth_weight, 0);
  ok('group: a defensive front rotates rather than starting two men', top2 < 0.6);

  /* availability: an OUT starter frees his snaps to the next man down */
  const avail = { 'a:1': { status: 'OUT', source: 'test' } };
  const hurt = UNITS.rateGroup('QB', [mkR(1, 'QB', 90, 0.9), mkR(2, 'QB', 40, 0.5)], { availability: avail });
  ok('availability: an OUT starter drops the room rating', hurt.rating < qb.rating);
  eq('availability: he takes no snaps', hurt.projected[0].effective_weight, 0);
  eq('availability: and the room reports him out', hurt.availability.starters_out, 1);
  const unknown = UNITS.rateGroup('QB', [mkR(1, 'QB', 90, 0.9), mkR(2, 'QB', 40, 0.5)], {});
  eq('availability: silence is UNKNOWN, not healthy', unknown.availability.unknown_share, 1);

  const none = UNITS.rateGroup('QB', [], {});
  eq('group: an empty room has NO rating', none.rating, null);
  ok('group: and is not scored as zero', none.available === false);

  /* team context: what the team's own play record says about a blind unit */
  const withCtx = UNITS.rateGroup('OL', [1, 2, 3, 4, 5].map(i => mkR(i, 'OL', 50, 0.3)),
    { teamContext: { OL_z: 1.5, OL_conf: 0.7, OL_basis: 'test' } });
  ok('team context: an observably good line rates above replacement', withCtx.rating > 55);
  ok('team context: and the blend is stated', withCtx.team_context.weight > 0);
})();

/* ---------------------------------------------------------------- */
/* 9. RETURNING VALUE AND TRANSFERS                                  */
/* ---------------------------------------------------------------- */
(function returning() {
  const prev = [mkR(1, 'QB', 88, 0.9), mkR(2, 'WR', 80, 0.8), mkR(3, 'OL', 50, 0.3), mkR(4, 'OL', 50, 0.3), mkR(5, 'RB', 50, 0.3)];
  const backGood = { 'a:1': 1, 'a:2': 1 };                 /* the two good ones */
  const backBad = { 'a:3': 1, 'a:4': 1, 'a:5': 1 };        /* the three replacement ones */
  const g = UNITS.returningValue(prev, backGood, { prior_season: 2025 });
  const b = UNITS.returningValue(prev, backBad, { prior_season: 2025 });
  ok('returning: returning the good players beats returning more bad ones', g.value_continuity > b.value_continuity);
  ok('returning: even though the head COUNT is the other way round', b.roster_continuity > g.roster_continuity);
  eq('returning: replacement-level players carry no value', b.value_continuity, 0);
  ok('returning: both numbers are published', g.value_continuity != null && g.roster_continuity != null);
  const noPrior = UNITS.returningValue([], {}, {});
  ok('returning: with no prior season it refuses rather than guessing', noPrior.available === false);

  const starters = [mkR(10, 'QB', 85, 0.8, 'transfer'), mkR(11, 'WR', 82, 0.8, 'transfer')];
  const backups = [];
  for (let i = 0; i < 30; i++) backups.push(mkR(100 + i, 'RB', 50, 0.6, 'transfer', 'DEPTH'));
  const five = UNITS.transferValue(starters, [], {});
  const thirty = UNITS.transferValue(backups, [], {});
  ok('transfers: five starters beat thirty backups', five.net_value > thirty.net_value);
  eq('transfers: the headcount says the opposite', thirty.in.count > five.in.count, true);
  const unknown = UNITS.transferValue([mkR(200, 'QB', 50, 0.1, 'transfer', 'UNKNOWN')], [], {});
  eq('transfers: an unknown transfer is bucketed as high uncertainty', unknown.in.high_uncertainty.length, 1);
  eq('transfers: and not counted as a starter', unknown.in.starter_level.length, 0);
})();

/* ---------------------------------------------------------------- */
/* 10. SCHEME                                                        */
/* ---------------------------------------------------------------- */
(function scheme() {
  const off = new Map(), def = new Map();
  for (let i = 0; i < 20; i++) {
    const a = BUILD.blankTG();
    a.games = 12; a.plays = 800 + i * 10; a.rush_att = 400 + i * 5; a.dropbacks = 400;
    a.pass_att = 380; a.pass_cmp = 230; a.pass_yds = 2800 + i * 40; a.pass_success = 170;
    a.rush_yds = 1800 + i * 30; a.rush_success = 180; a.rush_explosive = 30 + i;
    a.pass_explosive = 40 + i; a.rush_stuffed = 80; a.sacks_taken = 25; a.early_down_plays = 500;
    a.early_down_pass = 220; a.third_plays = 150; a.third_pass = 100; a.rz_plays = 90; a.rz_rush = 50;
    off.set('t' + i, a); def.set('t' + i, a);
  }
  const p = SCHEME.buildProfiles(off, def, { season: 2025, rosterPositions: {} });
  ok('scheme: a tendency is measured with a sample size', p.teams.t0.offense.rush_rate.n > 0);
  ok('scheme: and standardised against the league', p.teams.t0.offense.rush_rate.z != null);
  ok('scheme: personnel groupings are named as underivable', !!p.teams.t0.unknown.personnel);
  ok('scheme: so are coverage shells', !!p.teams.t0.unknown.coverage);
  ok('scheme: so is blitz rate', !!p.teams.t0.unknown.blitz_rate);
  ok('scheme: confidence is scaled by how much was measured', p.teams.t0.confidence.value <= 1);
  ok('scheme: and never counts the underivable dimensions as measured', p.teams.t0.confidence.undecidable_dimensions > 0);
  const fg = SCHEME.frontGuess(['EDGE', 'EDGE', 'OLB', 'DE', 'DT', 'DT', 'EDGE']);
  ok('scheme: the front is a GUESS with a capped confidence', fg.confidence <= CFG.SCHEME.front_guess.max_confidence);
  ok('scheme: and is labelled a guess', SCHEME.frontLabel(fg).guess === true);
  ok('scheme: too little to read means no guess at all', SCHEME.frontGuess(['DE', 'DT']).available === false);

  /* blending: week one is last season, week ten is this season */
  const cur = new Map([['t0', Object.assign(BUILD.blankTG(), { plays: 60, games: 1, rush_att: 30 })]]);
  const prev = new Map([['t0', Object.assign(BUILD.blankTG(), { plays: 800, games: 12, rush_att: 400 })]]);
  const early = SCHEME.blendAggregates(cur, prev, 600).get('t0');
  ok('scheme: a week-one profile is mostly last season', early._blend.lambda > 0.8);
  const late = SCHEME.blendAggregates(new Map([['t0', Object.assign(BUILD.blankTG(), { plays: 700, games: 9 })]]), prev, 600).get('t0');
  eq('scheme: a late-season profile is entirely this season', late._blend.lambda, 0);
})();

/* ---------------------------------------------------------------- */
/* 11. MATCHUP AND THE RUN DEFENCE GATE                              */
/* ---------------------------------------------------------------- */
function fakeTeam(name, level) {
  const groups = {};
  for (const g of CFG.OFFENSE_GROUPS.concat(CFG.DEFENSE_GROUPS)) {
    groups[g] = { rating: level, confidence: 0.6, starter_quality: level, depth_quality: level - 5,
      continuity: 0.6, experience: 0.5, roster_size: 10, production_feed: CFG.MEASURES[g].length > 0,
      availability: { starters_out: 0, unknown_share: 0.2 },
      projected: [1, 2, 3, 4, 5].map(i => ({ key: 'a:' + name + g + i, name: name + ' ' + g + i, pos: g,
        epir: level, confidence: 0.6, role: 'STARTER', availability: 'UNKNOWN' })) };
  }
  return { name, units: { groups, offense: { rating: level, confidence: 0.6 }, defense: { rating: level, confidence: 0.6 },
      overall: { rating: level, confidence: 0.6 },
      returning: { available: true, value_continuity: 0.6, roster_continuity: 0.7, by_group: { DL: { value_returning: 0.6 }, LB: { value_returning: 0.6 }, EDGE: { value_returning: 0.6 } } },
      transfers: null },
    scheme: { offense: { rush_rate: { available: true, value: 0.5, z: 0.2 }, plays_per_game: { available: true, value: 70, z: 0 },
        explosive_pass_rate: { available: true, value: 0.09, z: 0 } },
      defense: { def_rush_success_allowed: { available: true, value: 0.42, z: 0 },
        def_stuff_rate: { available: true, value: 0.2, z: 0 },
        def_explosive_rush_allowed: { available: true, value: 0.05, z: 0 },
        def_sack_rate: { available: true, value: 0.06, z: 0 },
        def_pass_success_allowed: { available: true, value: 0.44, z: 0 },
        def_explosive_pass_allowed: { available: true, value: 0.09, z: 0 } } } };
}
(function matchup() {
  const H = fakeTeam('Home', 70), A = fakeTeam('Away', 55);
  const m = MATCH.evaluate({ home: H, away: A });
  ok('matchup: the matrix has a row per group', m.matrix.length >= 8);
  ok('matchup: the better team takes the edges', m.matrix.filter(r => r.edge === 'HOME').length > m.matrix.filter(r => r.edge === 'AWAY').length);
  ok('matchup: every scheme edge is in MATCHUP POINTS, not spread', m.scheme_edges.every(e => !e.available || /MATCHUP POINTS/.test(e.units_note)));
  ok('matchup: the features say the same', /MATCHUP POINTS/.test(m.features.units_note));
  ok('matchup: a most-important matchup is named', !!m.most_important);
  ok('matchup: player edges declare how sure the assignment is',
    m.player_edges.every(e => ['DIRECT', 'LIKELY', 'UNIT-LEVEL'].indexOf(e.classification) >= 0));
  ok('matchup: and say why they are only that sure', m.player_edges.every(e => !!e.classification_why));
  ok('matchup: a coordinator change is declared unobservable',
    m.risk_gates.some(g => g.id === 'COORDINATOR_CHANGE' && g.unobservable === true));

  const gate = m.run_defence_gate.home;
  ok('gate: a run defence gate publishes a state', typeof gate.state === 'string');
  ok('gate: with the components that produced it', gate.components.length > 0);
  const blind = MATCH.runDefenceGate({ units: { groups: {} }, scheme: null }, A, { home: 'H', away: 'A' }, 'home');
  eq('gate: with nothing to read it says UNKNOWN', blind.state, CFG.RUN_GATE.unknown_state);
  ok('gate: and refuses to publish a score', blind.score === null);
  ok('gate: naming how little arrived', blind.completeness < CFG.RUN_GATE.min_completeness);

  /* an unrateable opponent must not crash or invent */
  const empty = { name: 'FCS', units: { groups: {}, offense: {}, defense: {}, overall: {} }, scheme: null };
  const m2 = MATCH.evaluate({ home: H, away: empty });
  ok('matchup: an unrated opponent yields declared-unavailable edges, not zeros',
    m2.scheme_edges.filter(e => e.available === false).length > 0);
  ok('matchup: and every one of them says why', m2.scheme_edges.filter(e => !e.available).every(e => !!e.reason));
  eq('matchup: the player-quality gap is null rather than invented', m2.features.player_quality_gap, null);
})();

/* ---------------------------------------------------------------- */
/* 12. THE SIMULATOR                                                 */
/* ---------------------------------------------------------------- */
(function simulation() {
  const req = { fair_spread: 17.5, sigma_margin: 16.4, fair_total: 48, sigma_total: 11, seed: 20260101, draws: 4000 };
  const a = SIM.simulate(req), b = SIM.simulate(req);
  eq('simulation: the same seed gives the same answer, bit for bit', JSON.stringify(a), JSON.stringify(b));
  const c = SIM.simulate(Object.assign({}, req, { seed: 99 }));
  ok('simulation: a different seed gives a different draw', JSON.stringify(a) !== JSON.stringify(c));
  ok('simulation: the median margin tracks the fair spread', Math.abs(a.margin.median - 17.5) < 2);
  ok('simulation: quantiles are ordered', a.margin.p10 <= a.margin.p25 && a.margin.p25 <= a.margin.p50
    && a.margin.p50 <= a.margin.p75 && a.margin.p75 <= a.margin.p90);
  ok('simulation: probabilities sum to one', Math.abs(a.home_win_prob + a.away_win_prob + a.tie_prob - 1) < 1e-9);
  ok('simulation: the favourite is the side the spread favours', a.favourite === 'home');
  ok('simulation: an upset probability is the underdog winning', Math.abs(a.upset_prob - a.away_win_prob) < 1e-9);
  ok('simulation: scores are non-negative', a.scores.home.p10 >= 0 && a.scores.away.p10 >= 0);
  const blocked = SIM.simulate({ fair_spread: 12 });
  eq('simulation: without a measured sigma it refuses to run', blocked.status, 'BLOCKED');
  ok('simulation: and says why', /will not invent/.test(blocked.reason));

  /* THE MARKET MUST NOT REACH THE PROJECTION */
  const noMkt = SIM.simulate(req);
  const withMkt = SIM.simulate(Object.assign({}, req, { market_spread: 3.5, market_total: 61 }));
  eq('market independence: the margin distribution is identical with and without a line',
    JSON.stringify(noMkt.margin), JSON.stringify(withMkt.margin));
  eq('market independence: so is the win probability', noMkt.home_win_prob, withMkt.home_win_prob);
  ok('market independence: the line only produces a cover probability', withMkt.cover != null && noMkt.cover == null);

  /* draws are bounded */
  eq('simulation: draws are clamped to the configured maximum',
    SIM.simulate(Object.assign({}, req, { draws: 1e9 })).draws, CFG.SIMULATION.max_draws);

  /* a supplied margin table is used in preference to a normal */
  const pmf = { 3: 0.5, 7: 0.5 };
  const t = SIM.simulate(Object.assign({}, req, { margin_pmf: pmf }));
  ok('simulation: a supplied margin table is used', /margin table/.test(t.distribution_source));
  ok('simulation: and nothing outside it is ever drawn', t.margin.p10 === 3 || t.margin.p10 === 7);
})();

/* ---------------------------------------------------------------- */
/* 13. THE LINE LADDER AND THE MARKET                                */
/* ---------------------------------------------------------------- */
(function ladder() {
  const notApplied = { calibration: { player_points_per_unit: { value: 0.3, points_applied: false, reason: 'did not clear the bar' },
    scheme_points_per_unit: { value: 1.4, points_applied: false, reason: 'did not clear the bar' } } };
  const l = SIM.ladder({ raw_model_spread: -19.7, player_quality_gap: 5, scheme_gap: 1, params: notApplied,
    simulation_spread: -19.7, market_spread: -16.5, data_quality: 0.7 });
  const player = l.steps.find(s => s.id === 'player_adjusted');
  eq('ladder: an uncalibrated scalar moves NOTHING', player.spread, -19.7);
  eq('ladder: and says it was not applied', player.applied, false);
  ok('ladder: with the reason on screen', l.notes.some(n => /points_applied:false/.test(n)));
  ok('ladder: the market is reported beside the ladder, never inside it', l.market != null);
  ok('ladder: and the agreement claim is explicitly not an edge claim', /NOT proof of an edge/.test(l.market.statement));
  ok('ladder: the fair range is a range, not an interval', /not a confidence interval|A range, not an interval/.test(l.fair_range.basis));

  const applied = { calibration: { player_points_per_unit: { value: 0.3, points_applied: true, basis: 'fitted' },
    scheme_points_per_unit: { value: 1.0, points_applied: true, basis: 'fitted' } } };
  const l2 = SIM.ladder({ raw_model_spread: -19.7, player_quality_gap: 5, scheme_gap: 1, params: applied });
  close('ladder: a calibrated scalar moves the line by exactly slope x gap',
    l2.steps.find(s => s.id === 'player_adjusted').spread, -19.7 + 5 * 0.3, 0.06);
  const l3 = SIM.ladder({});
  ok('ladder: with no raw model there is nothing to adjust', l3.available === false);

  const sens = SIM.sensitivity({ spread: -18.1, favourite: 'home', params: notApplied, groups: {} });
  ok('sensitivity: it runs', sens.available === true);
  ok('sensitivity: an uncalibrated scalar produces no invented spread', sens.probes.every(p => p.spread === null));
  ok('sensitivity: and says so rather than showing theatre', /theatre|does not restate/.test(sens.units_note));
})();

/* ---------------------------------------------------------------- */
/* 14. RECRUITING — architected, null, never fabricated              */
/* ---------------------------------------------------------------- */
(function recruiting() {
  const st = REC.status();
  eq('recruiting: nothing is wired in', st.wired, false);
  ok('recruiting: and the null fields are named', st.shipping_null.indexOf('recruiting_score') >= 0);
  eq('recruiting: with no store there is no prior', REC.priorFor('a:1', null), null);
  const store = REC.ingest([{ athlete_id: '1', recruiting_score: 0.95, source: 'test' }], { scale: '0_1', source: 'test' });
  eq('recruiting: an ingested row normalises to 0-100', store.by_key['a:1'].recruiting_score, 95);
  const p = REC.priorFor('a:1', store);
  eq('recruiting: without a population spread there is no z', p.z, null);
  ok('recruiting: and it says why', /population mean and spread/.test(p.reason));
  store.mean = 80; store.sd = 10;
  close('recruiting: with one, the z is arithmetic', REC.priorFor('a:1', store).z, 1.5);
  eq('recruiting: a star rating alone maps to its band midpoint', REC.normaliseScore(null, 5), 95);
  eq('recruiting: and nothing at all stays null', REC.normaliseScore(null, null), null);
  eq('recruiting: a row with no stable id is never joined by name', REC.ingest([{ name: 'A B' }], {}).count, 0);
})();

/* ---------------------------------------------------------------- */
/* 15. RELIABILITY — k is measured, not chosen                       */
/* ---------------------------------------------------------------- */
(function reliability() {
  const pairs = [];
  for (let i = 0; i < 200; i++) {
    const z = (i % 20) / 5 - 2;
    pairs.push({ group: 'QB', z1: z, z2: z * 0.5 + ((i % 7) - 3) / 10, n1: 300, n2: 300 });
  }
  const rel = EPIR.measureReliability(pairs, 40);
  ok('reliability: r is measured from consecutive seasons', rel.QB.r > 0);
  ok('reliability: k follows from r', rel.QB.k > 0);
  ok('reliability: with enough pairs it counts as measured', rel.QB.measured === true);
  const thin = EPIR.measureReliability(pairs.slice(0, 10).map(p => Object.assign({}, p, { group: 'RB' })), 40);
  ok('reliability: too few pairs is NOT measured', !thin.RB || thin.RB.measured === false);
  const pop = rbPop(40, 11);
  const base = EPIR.buildBaselines(pop, {});
  const r = EPIR.ratePlayer(pop[0], { baselines: base, season: 2025, coverage: {},
    params: { reliability: { RB: { k: 150, r: 0.4, pairs: 500 } } } });
  eq('reliability: a measured k is used and flagged as measured', r.components.quality.k_measured, true);
  eq('reliability: and the k that was used is published', r.components.quality.k, 150);
  const r2 = EPIR.ratePlayer(pop[0], { baselines: base, season: 2025, coverage: {}, params: null });
  eq('reliability: a fallback k is flagged as NOT measured', r2.components.quality.k_measured, false);
})();

/* ---------------------------------------------------------------- */
/* 16. THE COMMITTED DATASETS — shape, snapshots, no leakage          */
/* ---------------------------------------------------------------- */
(function datasets() {
  const cur = path.join(__dirname, 'current.json');
  if (!fs.existsSync(cur)) { ok('dataset: current.json exists (run build_players.js)', false); return; }
  const m = JSON.parse(fs.readFileSync(cur, 'utf8'));
  eq('dataset: schema', m.schema, 'edgedesk_player_quality_v1');
  ok('dataset: teams are present', Object.keys(m.teams).length > 100);
  ok('dataset: the observability contract ships with the data', !!m.observability.snap_share);
  ok('dataset: the recruiting dimension is zero, not omitted', m.quality.dimensions.recruiting.value === 0);
  ok('dataset: every quality dimension carries its basis',
    CFG.QUALITY_DIMENSIONS.every(d => m.quality.dimensions[d] && m.quality.dimensions[d].basis));
  ok('dataset: the underivable scheme dimensions are named', Object.keys(m.scheme_unknown).length >= 6);
  ok('dataset: it states that no model wrote any rating',
    m.notes.some(n => /No language model/i.test(n)));
  ok('dataset: baselines ship so a rating can be recomputed', !!m.baselines);

  const snapDir = path.join(__dirname, 'snapshots');
  const snaps = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter(f => f.endsWith('.json')) : [];
  ok('snapshots: at least one point-in-time snapshot exists', snaps.length > 0);
  if (snaps.length) {
    const s = JSON.parse(fs.readFileSync(path.join(snapDir, snaps[0]), 'utf8'));
    eq('snapshots: schema', s.schema, 'edgedesk_player_snapshot_v1');
    ok('snapshots: a snapshot is stamped with its own season and week', s.season != null && s.week != null);
    ok('snapshots: and carries the players as they stood then', Object.keys(s.players).length > 1000);
    ok('snapshots: the file name is the point in time', /^\d{4}-w\d{2}\.json$/.test(snaps[0]));
    ok('snapshots: each carries the config version it was built under', !!s.config_version);
    ok('snapshots: each carries a digest of the build that produced it', !!s.digest);
    /* history is not rewritten: the build only ever touches the CURRENT week */
    const B2 = fs.readFileSync(path.join(__dirname, 'run_build.js'), 'utf8');
    ok('snapshots: the build refuses to rewrite a finished week',
      /HISTORY IS NOT REWRITTEN/.test(B2) && /finished weeks are never rewritten/.test(B2));
  }

  const params = path.join(__dirname, 'params.js');
  if (fs.existsSync(params)) {
    const P = require(params);
    ok('params: a calibration block exists', !!P.calibration);
    ok('params: points_applied is an explicit boolean, never absent',
      typeof P.calibration.player_points_per_unit.points_applied === 'boolean');
    ok('params: an unapplied scalar carries its reason',
      P.calibration.player_points_per_unit.points_applied === true || !!P.calibration.player_points_per_unit.reason);
    ok('params: recruiting is declared unwired', P.recruiting_status.wired === false);
  }
})();

/* ---------------------------------------------------------------- */
/* 17. NO LLM ANYWHERE IN THE RATING PATH                            */
/* ---------------------------------------------------------------- */
(function noLlm() {
  const files = ['config.js', 'epir.js', 'units.js', 'scheme.js', 'matchup.js', 'sim.js',
    'build_players.js', 'run_build.js', 'recruiting_adapter.js', 'validate.js'];
  const banned = /\b(openai|anthropic|claude|gpt-|completions?\.create|generateText|llm\.)\b/i;
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    ok('no LLM: ' + f + ' contains no model call', !banned.test(src));
    ok('no LLM: ' + f + ' makes no network call outside the declared feeds',
      !/fetch\(/.test(src) || /cfbfastR-data|LINE_ARCHIVE|url, \{ redirect|get\(url/.test(src));
  }
  const sim = fs.readFileSync(path.join(__dirname, 'sim.js'), 'utf8');
  ok('no LLM: the narrative generator says it is templates over measurements', /No language model produced/.test(sim));
})();

/* ---------------------------------------------------------------- */
/* 18. NO LEAKAGE                                                    */
/* ---------------------------------------------------------------- */
(function leakage() {
  const pop = rbPop(40, 21);
  const base = EPIR.buildBaselines(pop, {});
  const future = EPIR.ratePlayer(pop[0], { baselines: base, season: 2024, coverage: {}, params: null,
    career: [{ season: 2025, z: 3, n: 900, dc: 1 }] });
  const without = EPIR.ratePlayer(pop[0], { baselines: base, season: 2024, coverage: {}, params: null, career: [] });
  eq('leakage: a LATER season in the career index is ignored', future.epir, without.epir);
  const past = EPIR.ratePlayer(pop[0], { baselines: base, season: 2024, coverage: {}, params: null,
    career: [{ season: 2023, z: 3, n: 900, dc: 1 }] });
  ok('leakage: an EARLIER season is used', past.epir !== without.epir);
  ok('leakage: the class column is never read for experience',
    !/class_year/.test(fs.readFileSync(path.join(__dirname, 'epir.js'), 'utf8').split('seasonsObserved')[0].split('function ratePlayer')[1] || ''));
  const V = fs.readFileSync(path.join(__dirname, 'validate.js'), 'utf8');
  ok('leakage: the validator rebuilds the layer per week rather than filtering finished ratings', /prefixPlayers/.test(V));
  ok('leakage: and refuses an overlapping tune and holdout window', /tune and holdout overlap/.test(V));
})();

/* ---------------------------------------------------------------- */
/* 19. BAD DATA AND EMPTY STATES                                     */
/* ---------------------------------------------------------------- */
(function badData() {
  ok('bad data: an empty roster does not throw', !!UNITS.rateTeam('x', 'X', [], {}));
  const t = UNITS.rateTeam('x', 'X', [], {});
  eq('bad data: an empty team has NO overall rating', t.overall.rating, null);
  ok('bad data: and names the groups it is missing', t.offense.missing_groups.length > 0);
  ok('bad data: a NaN never becomes a rating', EPIR.ratePlayer(
    { athlete_id: '1', name: 'N', team: 'T', season: 2025, pos: 'RB', group: 'RB', stat: { rush_att: NaN, rush_yds: 'x' } },
    { baselines: {}, season: 2025, coverage: {}, params: null }).epir === CFG.EPIR_SCALE.center);
  ok('bad data: a player with no position is carried unrated rather than guessed',
    EPIR.ratePlayer({ athlete_id: '2', name: 'M', team: 'T', season: 2025, pos: null, group: null, stat: {} },
      { baselines: {}, season: 2025, coverage: {}, params: null }).group == null);
  const s = SCHEME.buildProfiles(new Map(), new Map(), { season: 2025 });
  eq('bad data: no plays means no scheme profiles, not empty ones', Object.keys(s.teams).length, 0);
  eq('bad data: a null team name has no key', EPIR.teamKey(null), null);
  eq('bad data: an empty string has no key', EPIR.teamKey(''), null);
})();

/* ---------------------------------------------------------------- */
/* 20. FCS FALLBACK AND FUTURE DIVISIONS                             */
/* ---------------------------------------------------------------- */
(function fcs() {
  const src = fs.readFileSync(path.join(__dirname, 'build_players.js'), 'utf8');
  ok('FCS: non-FBS opponents share one pooled rating', /FCS_KEY/.test(src));
  ok('FCS: the scope filter is explicit and explained', /THE DATABASE IS FBS/.test(src));
  const H = fakeTeam('Home', 70);
  const fcsOpp = { name: 'Some FCS', units: { groups: {}, offense: {}, defense: {}, overall: {} }, scheme: null };
  const m = MATCH.evaluate({ home: H, away: fcsOpp });
  ok('FCS: an unrated opponent produces an evaluation that declares itself blind', !!m.matrix);
  ok('FCS: the run gate refuses rather than inventing', m.run_defence_gate.away.available === false);
})();

/* ---------------------------------------------------------------- */
/* 21. CONFIGURATION IS CENTRAL AND VERSIONED                        */
/* ---------------------------------------------------------------- */
(function config() {
  eq('config: the player rating is versioned', CFG.versions.player_rating, 'player_rating_v1');
  eq('config: the scheme engine is versioned separately', CFG.versions.scheme_matchup, 'scheme_matchup_v1');
  eq('config: the simulator is versioned separately', CFG.versions.simulation, 'simulation_v1');
  const files = ['epir.js', 'units.js', 'matchup.js', 'sim.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    /* no weight may be hard-coded outside config.js: a bare 0.NN assigned to
       something called a weight is the pattern this looks for */
    ok('config: ' + f + ' does not define its own weights', !/\bw(eight)?\s*[:=]\s*0\.\d+\s*[,;]/.test(src.replace(/CFG\.[A-Z_.]+/g, '')));
  }
  for (const g of Object.keys(CFG.MEASURES)) {
    ok('config: every ' + g + ' measure declares a basis', CFG.MEASURES[g].every(m => !!m.basis));
    ok('config: every ' + g + ' measure declares a minimum sample', CFG.MEASURES[g].every(m => m.min_n > 0));
  }
})();

/* ---------------------------------------------------------------- */
console.log((failed ? '\n' : '') + fails.map(f => '  FAIL  ' + f).join('\n'));
console.log(`\nplayers: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
