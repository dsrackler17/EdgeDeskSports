/* ============================================================================
   EDGEDESK PLAYER QUALITY + SCHEME MATCHUP ENGINE — VERSIONED CONFIGURATION.

   Every weight, threshold, band and position contract this layer uses lives
   HERE, in one file, under a version string. Nothing that changes a number is
   allowed to live in the frontend, in a build script, or in an engine's inline
   constant. That is the whole point: a weight you cannot find is a weight you
   cannot argue with, and a weight you cannot argue with is not a model, it is
   a preference.

   THIS FILE IS HAND-MAINTAINED AND CONTAINS NO MEASUREMENTS.
   Anything that had to be MEASURED from data — how repeatable each position's
   production actually is, what the FBS baseline for a rate statistic is, how
   many points of spread a unit of player-quality edge is worth — lives in the
   GENERATED sibling `params.js`, written by build_players.js, and ships with
   its own provenance and out-of-sample record. If params.js is missing the
   engine says so and refuses to invent the constant.

   THREE INDEPENDENT VERSIONS, deliberately not one:
     player_rating_v1    what a player is worth
     scheme_matchup_v1   how two teams interact
     simulation_v1       how a game is simulated
   They are versioned apart so one can be recalibrated without silently
   restating the others.

   Runs in the browser (window.EDPlayerConfig) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDPlayerConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * POSITION GROUPS                                                     *
   * The same spelling the roster sync, the Power 4 engine's talent layer *
   * and app.html's roster board already use, so one position is one      *
   * position across the whole repo.                                      *
   * ------------------------------------------------------------------ */
  var POS_GROUP = {
    QB: 'QB',
    RB: 'RB', FB: 'RB', HB: 'RB', TB: 'RB',
    WR: 'WR', SE: 'WR', FL: 'WR',
    TE: 'TE',
    OL: 'OL', OT: 'OL', OG: 'OL', G: 'OL', C: 'OL', T: 'OL', LT: 'OL', LG: 'OL',
    RG: 'OL', RT: 'OL', OC: 'OL',
    DL: 'DL', DT: 'DL', NT: 'DL', DE: 'DL',
    EDGE: 'EDGE', RUSH: 'EDGE',
    LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB', WLB: 'LB', SLB: 'LB',
    CB: 'CB', DB: 'DB', NB: 'CB',
    S: 'S', FS: 'S', SS: 'S', SAF: 'S',
    PK: 'K', K: 'K', P: 'P', LS: 'LS',
    PR: 'RET', KR: 'RET', RET: 'RET',
    ATH: 'ATH'
  };

  /* Display/aggregation order. LS and RET are carried on the roster but are
     never graded — nothing in any public feed measures them. */
  var GROUP_ORDER = ['QB', 'RB', 'WR', 'TE', 'OL', 'EDGE', 'DL', 'LB', 'CB', 'S', 'DB', 'K', 'P', 'LS', 'RET', 'ATH'];
  var OFFENSE_GROUPS = ['QB', 'RB', 'WR', 'TE', 'OL'];
  var DEFENSE_GROUPS = ['EDGE', 'DL', 'LB', 'CB', 'S', 'DB'];
  var SPECIAL_GROUPS = ['K', 'P'];

  /* ------------------------------------------------------------------ *
   * WHAT THE PUBLIC FEED ACTUALLY CARRIES                               *
   * ------------------------------------------------------------------ *
   * This block is the honesty contract of the whole layer. cfbfastR's
   * `player_stats` is a PLAY-ATTRIBUTION table: one row per play, naming the
   * players credited with the events on it. It therefore observes offensive
   * skill work in detail and almost nothing else. Every claim below was
   * established by counting rows, not by assumption — build_players.js
   * re-counts them on every run and writes the counts into the dataset, so
   * the day the feed changes, the dataset says so instead of the code lying.
   *
   *   OBSERVED, stable       rushes, receptions, completions, incompletions,
   *                          sacks taken, sacks made, field-goal attempts and
   *                          makes, fumbles — each with down, distance and
   *                          yards-to-goal on every row.
   *   OBSERVED, unstable     targets, interceptions, pass break-ups, forced
   *                          fumbles. Season-scale coverage collapses (2023
   *                          carries 695 interceptions across 1,473 games —
   *                          0.47 a game, which is not football). Each is
   *                          coverage-gated at runtime and declared missing
   *                          for a season that fails the gate.
   *   NOT OBSERVED AT ALL    snap counts, tackles, tackles for loss, run
   *                          stops, missed tackles, pressures short of a
   *                          sack, coverage targets and completions allowed,
   *                          route participation, blocking, alignment,
   *                          personnel groupings, punts, recruiting ratings.
   *
   * The consequence is stated everywhere it matters rather than hidden: THIS
   * LAYER CANNOT RATE AN INDIVIDUAL OFFENSIVE LINEMAN, LINEBACKER OR DEFENSIVE
   * BACK ON PRODUCTION, because no public feed observes what they do. Those
   * players get a rating built from role, experience and continuity with a low
   * confidence that says exactly why, and their UNIT rating leans on
   * opponent-adjusted team defence, which IS observable.
   * ------------------------------------------------------------------ */
  var OBSERVABILITY = {
    /* metric -> how it is obtained and whether it may drive a rating */
    snap_share:        { observed: false, reason: 'no public college feed publishes snap counts; touch share within the position group is used instead and is labelled as such' },
    pressures:         { observed: false, reason: 'only completed sacks are attributed; pressures short of a sack are unobserved' },
    tackles:           { observed: false, reason: 'the play-attribution table carries no tackle, TFL, run-stop or missed-tackle column' },
    coverage_targets:  { observed: false, reason: 'no defender is attributed to a target, so completion rate allowed cannot be computed per player' },
    ol_individual:     { observed: false, reason: 'no public feed attributes a block, a pressure allowed or a run lane to a named lineman' },
    yards_after_contact:{ observed: false, reason: 'not carried in any public college feed' },
    recruiting_rating: { observed: false, reason: 'no legal, public, keyless recruiting feed is wired in — the adapter exists and the fields stay null rather than being invented' },
    epa:               { observed: false, reason: 'the play table carries no next-score information, and the expected-points surface this repo once fit is no longer reproducible from public files. Success rate, explosive rate and yards per play are measured directly instead of an EPA being invented' },
    punting:           { observed: false, reason: 'no punt attribution column exists' },
    targets:           { observed: 'gated', reason: 'target attribution has season-scale coverage collapses; gated per season' },
    interceptions:     { observed: 'gated', reason: 'interception attribution has season-scale coverage collapses; gated per season' },
    pass_breakups:     { observed: 'gated', reason: 'pass-break-up attribution has season-scale coverage collapses; gated per season' },
    forced_fumbles:    { observed: 'gated', reason: 'forced-fumble attribution has season-scale coverage collapses; gated per season' }
  };

  /* Coverage gates. A season's metric is USABLE only if its observed rate per
     team-game clears the floor. These floors are deliberately generous — they
     catch a feed that dropped a column, not a quiet year. */
  var COVERAGE_GATES = {
    targets:        { per_team_game_min: 8.0,  basis: 'a college team throws ~30 passes a game; fewer than 8 attributed targets is a broken column, not a run-heavy season' },
    interceptions:  { per_team_game_min: 0.55, basis: 'FBS interception rate is ~0.8 per team-game; below 0.55 the column is dropping events' },
    pass_breakups:  { per_team_game_min: 1.50, basis: 'FBS break-up rate is ~3 per team-game; below 1.5 the column is dropping events' },
    forced_fumbles: { per_team_game_min: 0.25, basis: 'FBS forced-fumble rate is ~0.5 per team-game' },
    sacks:          { per_team_game_min: 1.00, basis: 'FBS sack rate is ~2 per team-game; sacks are the stable defensive column and rarely fail this' }
  };

  /* ------------------------------------------------------------------ *
   * SUCCESS RATE                                                        *
   * The standard definition, stated once so nothing re-implements it.   *
   * ------------------------------------------------------------------ */
  var SUCCESS = {
    first: 0.5, second: 0.7, third: 1.0, fourth: 1.0,
    basis: 'the conventional down-by-down share of the distance needed; used unchanged so the number means what it means everywhere else'
  };
  /* Explosive thresholds, in yards. */
  var EXPLOSIVE = { rush: 15, pass: 20, basis: 'the conventional FBS thresholds' };

  /* ------------------------------------------------------------------ *
   * PLAYER RATING v1 — the measure contract per position group           *
   * ------------------------------------------------------------------ *
   * Each measure declares:
   *   key       the field on the normalized player-season record
   *   den       the denominator field (the sample size for THIS measure)
   *   w         its weight inside the group composite
   *   dir       +1 if higher is better, -1 if lower is better
   *   min_n     below this the measure is not scored at all (not scored as 0)
   *   gate      the coverage gate it depends on, if any
   *   basis     why it is in the composite
   * A measure that is absent contributes NOTHING and the remaining weights
   * renormalize. It is never replaced by a league average.
   * ------------------------------------------------------------------ */
  var MEASURES = {
    QB: [
      { key: 'pass_success_rate',  den: 'dropbacks', w: 0.30, dir: 1,  min_n: 40, basis: 'down-by-down efficiency is the most repeatable thing a quarterback does' },
      { key: 'yards_per_attempt',  den: 'pass_att',  w: 0.18, dir: 1,  min_n: 40, basis: 'the classic volume-free passing rate' },
      { key: 'explosive_pass_rate',den: 'pass_att',  w: 0.12, dir: 1,  min_n: 40, basis: 'explosives are where college margin comes from' },
      { key: 'completion_pct',     den: 'pass_att',  w: 0.08, dir: 1,  min_n: 40, basis: 'accuracy, with the caveat that it is depth-confounded' },
      { key: 'sack_rate_taken',    den: 'dropbacks', w: 0.12, dir: -1, min_n: 40, basis: 'sack avoidance is a quarterback skill AND a line signal; it is charged here and again to the line, which the unit layer notes' },
      { key: 'int_rate',           den: 'pass_att',  w: 0.08, dir: -1, min_n: 60, gate: 'interceptions', basis: 'turnover-worthy play is unobserved; thrown interceptions are the only proxy and they are noisy' },
      { key: 'qb_rush_success_rate',den:'qb_rush_att',w: 0.07, dir: 1,  min_n: 25, basis: 'designed and scramble rushing is a real part of the position and is fully observed' },
      { key: 'qb_yards_per_rush',  den: 'qb_rush_att',w: 0.05, dir: 1,  min_n: 25, basis: 'as above, on a per-carry basis' }
    ],
    RB: [
      { key: 'rush_success_rate',  den: 'rush_att',  w: 0.34, dir: 1,  min_n: 30, basis: 'the down-by-down measure of whether the run game worked' },
      { key: 'yards_per_rush',     den: 'rush_att',  w: 0.22, dir: 1,  min_n: 30, basis: 'the headline rate' },
      { key: 'explosive_rush_rate',den: 'rush_att',  w: 0.16, dir: 1,  min_n: 30, basis: 'breakaway ability' },
      { key: 'stuff_rate',         den: 'rush_att',  w: 0.14, dir: -1, min_n: 30, basis: 'runs stopped at or behind the line; the stable half of the front-disruption pair this repo already trusts' },
      { key: 'rec_yards_per_catch',den: 'receptions',w: 0.08, dir: 1,  min_n: 12, basis: 'receiving work, when there is enough of it to read' },
      { key: 'fumble_rate',        den: 'touches',   w: 0.06, dir: -1, min_n: 60, basis: 'ball security, heavily shrunk because fumbles barely repeat' }
    ],
    WR: [
      { key: 'rec_success_rate',   den: 'receptions',w: 0.28, dir: 1,  min_n: 15, basis: 'whether the catch actually moved the sticks' },
      { key: 'rec_yards_per_catch',den: 'receptions',w: 0.22, dir: 1,  min_n: 15, basis: 'the per-reception rate' },
      { key: 'explosive_rec_rate', den: 'receptions',w: 0.20, dir: 1,  min_n: 15, basis: 'explosive receiving is the position’s highest-leverage output' },
      { key: 'first_down_rate_rec',den: 'receptions',w: 0.16, dir: 1,  min_n: 15, basis: 'conversion work' },
      { key: 'catch_rate',         den: 'targets',   w: 0.14, dir: 1,  min_n: 20, gate: 'targets', basis: 'catch rate needs targets, which the feed drops in some seasons; gated' }
    ],
    /* TE shares the receiving contract. Blocking is unobserved and the group's
       confidence is capped for it — see CONFIDENCE.blind_role_cap. */
    TE: [
      { key: 'rec_success_rate',   den: 'receptions',w: 0.30, dir: 1,  min_n: 10, basis: 'as WR' },
      { key: 'rec_yards_per_catch',den: 'receptions',w: 0.24, dir: 1,  min_n: 10, basis: 'as WR' },
      { key: 'explosive_rec_rate', den: 'receptions',w: 0.18, dir: 1,  min_n: 10, basis: 'as WR' },
      { key: 'first_down_rate_rec',den: 'receptions',w: 0.16, dir: 1,  min_n: 10, basis: 'as WR' },
      { key: 'catch_rate',         den: 'targets',   w: 0.12, dir: 1,  min_n: 15, gate: 'targets', basis: 'as WR' }
    ],
    /* OL: deliberately EMPTY. There is no individual measure to put here and
       an empty contract is the honest statement of that. */
    OL: [],
    /* DEFENCE. Read the denominator carefully: it is TEAM DEFENSIVE GAMES, not
       snaps, because no public feed publishes a defensive snap count. These are
       therefore PRODUCTION-PER-GAME measures, not per-snap efficiency, and a
       defender who did not play is indistinguishable from one who played and did
       nothing. Both rate low, and both say why on their face. The defensive UNIT
       rating leans mostly on the team's own opponent-adjusted play-level record,
       which IS observable — see units.js team_context. */
    EDGE: [
      { key: 'sacks_per_game',     den: 'team_def_games', w: 0.82, dir: 1, min_n: 6, gate: 'sacks', basis: 'the only individually attributed pass-rush event in the feed' },
      { key: 'ff_per_game',        den: 'team_def_games', w: 0.18, dir: 1, min_n: 8, gate: 'forced_fumbles', basis: 'rare, gated, and shrunk almost to nothing' }
    ],
    DL: [
      { key: 'sacks_per_game',     den: 'team_def_games', w: 0.82, dir: 1, min_n: 6, gate: 'sacks', basis: 'as EDGE. Interior sack rates are naturally lower and the baseline is per-group, so that is handled rather than penalised' },
      { key: 'ff_per_game',        den: 'team_def_games', w: 0.18, dir: 1, min_n: 8, gate: 'forced_fumbles', basis: 'as EDGE' }
    ],
    LB: [
      { key: 'sacks_per_game',     den: 'team_def_games', w: 0.50, dir: 1, min_n: 6, gate: 'sacks', basis: 'blitz production, the only linebacker pass-rush event the feed attributes' },
      { key: 'pbu_per_game',       den: 'team_def_games', w: 0.28, dir: 1, min_n: 6, gate: 'pass_breakups', basis: 'coverage contribution, gated hard' },
      { key: 'int_per_game',       den: 'team_def_games', w: 0.22, dir: 1, min_n: 8, gate: 'interceptions', basis: 'ball production, gated hard' }
    ],
    CB: [
      { key: 'pbu_per_game',       den: 'team_def_games', w: 0.58, dir: 1, min_n: 6, gate: 'pass_breakups', basis: 'the only coverage event attributed to a defender anywhere public' },
      { key: 'int_per_game',       den: 'team_def_games', w: 0.42, dir: 1, min_n: 8, gate: 'interceptions', basis: 'ball production' }
    ],
    S: [
      { key: 'pbu_per_game',       den: 'team_def_games', w: 0.46, dir: 1, min_n: 6, gate: 'pass_breakups', basis: 'as CB' },
      { key: 'int_per_game',       den: 'team_def_games', w: 0.36, dir: 1, min_n: 8, gate: 'interceptions', basis: 'as CB' },
      { key: 'sacks_per_game',     den: 'team_def_games', w: 0.18, dir: 1, min_n: 8, gate: 'sacks', basis: 'safety pressure, rare' }
    ],
    DB: [
      { key: 'pbu_per_game',       den: 'team_def_games', w: 0.58, dir: 1, min_n: 6, gate: 'pass_breakups', basis: 'as CB' },
      { key: 'int_per_game',       den: 'team_def_games', w: 0.42, dir: 1, min_n: 8, gate: 'interceptions', basis: 'as CB' }
    ],
    K: [
      { key: 'fg_pct',             den: 'fg_att',    w: 0.60, dir: 1, min_n: 8, basis: 'fully observed, and shrunk hard because a season of kicking is a tiny sample' },
      { key: 'fg_pct_long',        den: 'fg_att_long',w: 0.40, dir: 1, min_n: 5, basis: 'attempts of 40+ yards, where kickers actually separate' }
    ],
    P: [],
    LS: [], RET: [], ATH: []
  };

  /* Groups with an empty measure contract, and why. Surfaced verbatim in the
     UI so a zero-information rating never looks like a low rating. */
  var NO_PRODUCTION_FEED = {
    OL:  'No public feed attributes a block, a pressure allowed or a run lane to a named lineman. This line’s players are rated on role, experience and continuity only; the OL UNIT rating additionally reads the team’s own observed sack rate allowed and stuff rate allowed, which are real.',
    P:   'No public feed attributes a punt to a punter.',
    LS:  'Long snapping is unobserved in every public feed.',
    RET: 'Return attribution is not carried in this feed.',
    ATH: 'An athlete listed without a settled position has no measure contract; the player is carried, unrated, until the roster resolves the position.'
  };

  /* ------------------------------------------------------------------ *
   * SHRINKAGE                                                           *
   * ------------------------------------------------------------------ *
   * z_hat = z_raw * n/(n+k) + z_prior * k/(n+k)
   *
   * k is NOT a preference. It is derived from each group's own MEASURED
   * season-to-season reliability r of the composite:
   *      k = n_bar * (1 - r) / r
   * build_players.js measures r over consecutive-season pairs and writes it,
   * with its sample size, into params.js. FALLBACK_K below is used only when
   * a group has too few pairs to measure, and every rating built on a
   * fallback says `k_measured: false` so it can never be quoted as measured.
   * ------------------------------------------------------------------ */
  var SHRINK = {
    fallback_k: { QB: 250, RB: 160, WR: 90, TE: 70, OL: 1e9, EDGE: 14, DL: 14, LB: 16, CB: 16, S: 16, DB: 16, K: 30, P: 1e9, LS: 1e9, RET: 1e9, ATH: 1e9 },
    min_pairs_to_measure: 40,
    /* An early-career player has little of his own evidence, so the prior does
       most of the work — which is exactly what the shrinkage above already
       does, without a separate "freshman rule". The prior is the recruiting
       z-score when one exists and 0 (positional replacement) when it does not. */
    prior_basis: 'recruiting z when a recruiting feed is wired in; positional replacement (z=0) otherwise',
    career_decay: 0.55,
    career_decay_basis: 'weight on each season of career evidence, most recent = 1.0, decaying by 0.55 a season. Shape, not strength: the strength is the measured k above.'
  };

  /* z -> EPIR. 50 is positional replacement; 12 points of EPIR is one SD of
     the group’s own qualified population. Both are display conventions and
     change no relative ordering. */
  var EPIR_SCALE = { center: 50, sd: 12, floor: 1, ceiling: 99 };

  /* Small, separable additions to the quality core. Each declares whether it
     is applied, so a component that has not earned its keep is visible rather
     than deleted. */
  var EPIR_COMPONENTS = {
    quality:      { applied: true,  basis: 'the shrunk, opponent-adjusted, position-specific composite. The bulk of the rating.' },
    role_value:   { applied: true,  max_points: 4.0, basis: 'coaches play better players: a confirmed heavy usage share is weak independent evidence of quality. Capped at 4 EPIR points and derived from touch share, which is NOT snap share and is labelled as such.' },
    experience_value: { applied: true, max_points: 3.0, basis: 'career seasons OBSERVED IN THIS FEED (never the roster feed’s class column, which carries a player’s eventual class and would leak the future — established in cfb_p4/README.md).' },
    recruiting_prior: { applied: false, basis: 'the adapter exists and no legal public keyless feed is wired in. The field is null, never a guess.' },
    availability_adjustment: { applied: false, basis: 'availability changes WHO PLAYS, not how good a player is. It is applied in the unit aggregation instead, so PLAYER QUALITY and AVAILABILITY stay separable and a player is not silently downgraded for being hurt.' },
    scheme_fit_adjustment:   { applied: false, basis: 'scheme fit is published as its own measurement and does not move EPIR until a walk-forward test says it should.' },
    transfer_adjustment:     { applied: false, basis: 'a transfer’s production is his own production. Changing schools widens the CONFIDENCE band (see CONFIDENCE.transfer_penalty) rather than moving the mean.' }
  };

  /* ------------------------------------------------------------------ *
   * CONFIDENCE                                                          *
   * Orthogonal to the rating: a 75 at 95% and a 75 at 25% are different  *
   * statements and the UI must never merge them.                         *
   * ------------------------------------------------------------------ */
  var CONFIDENCE = {
    weights: { identity: 0.15, sample: 0.40, completeness: 0.25, recency: 0.20 },
    identity: { athlete_id: 1.0, name_and_team: 0.55, name_only: 0.0 },
    recency_decay: 0.6,       /* per season of age, applied to the newest season observed */
    transfer_penalty: 0.85,   /* multiplier: new system, new coaching, same player */
    blind_role_cap: 0.35,     /* a group with no production feed cannot exceed this */
    unknown_role_cap: 0.60,   /* an unconfirmed starter cannot be quoted as confirmed */
    basis: 'sample = the shrinkage weight n/(n+k); completeness = share of the position’s measure contract that was populated; recency = how old the newest observation is; identity = how the player was joined across feeds.'
  };

  /* ------------------------------------------------------------------ *
   * ROLE / PARTICIPATION PROJECTION                                     *
   * ------------------------------------------------------------------ *
   * Snap share is not observable. What IS observable is the share of a
   * group's touches (or, on defence, attributed events) a player took, and
   * whether he is still on the roster. UNKNOWN IS A ROLE. A player the feed
   * has never seen play is UNKNOWN, never a starter and never a scrub.
   * ------------------------------------------------------------------ */
  var ROLE = {
    bands: [
      { role: 'STARTER',  min_share: 0.45 },
      { role: 'ROTATION', min_share: 0.15 },
      { role: 'DEPTH',    min_share: 0.01 },
      { role: 'UNKNOWN',  min_share: null }
    ],
    /* Expected share of a unit's snaps by depth slot, used to weight the group
       rating. These are PLAYING-TIME SHAPES, not quality weights, and they are
       the shapes of the position as it is actually rotated. */
    depth_curve: {
      QB:   [0.80, 0.15, 0.05],
      RB:   [0.45, 0.30, 0.15, 0.10],
      WR:   [0.22, 0.20, 0.18, 0.14, 0.12, 0.08, 0.06],
      TE:   [0.45, 0.30, 0.15, 0.10],
      OL:   [0.185, 0.185, 0.185, 0.185, 0.185, 0.045, 0.02, 0.01],
      EDGE: [0.30, 0.26, 0.20, 0.14, 0.10],
      DL:   [0.26, 0.24, 0.20, 0.16, 0.09, 0.05],
      LB:   [0.32, 0.28, 0.20, 0.12, 0.08],
      CB:   [0.28, 0.26, 0.20, 0.14, 0.07, 0.05],
      S:    [0.32, 0.28, 0.20, 0.12, 0.08],
      DB:   [0.30, 0.26, 0.20, 0.14, 0.10],
      K:    [1.0], P: [1.0], LS: [1.0], RET: [1.0], ATH: [1.0]
    },
    depth_curve_basis: 'the rotation shape of each position group. The OL curve puts 92.5% of the weight on five men because five men play; the DL curve is flat across six because a defensive front rotates. Playing time, never quality.',
    /* How much of a UNIT rating comes from the team's own observable
       play-level record rather than from its individual players. This exists
       because the two halves of the evidence are genuinely different: what a
       named player did (thin on defence, absent on the line) and what the
       team's defence or line actually allowed (fully observed, opponent-
       adjustable, and real). Blending them is stated on screen, never silent. */
    team_context_weight: { blind: 0.60, with_production: 0.45 },
    team_context_basis: 'a group with no individual production feed leans mostly on the team’s own opponent-adjusted play-level record; a group that has one still leans on it substantially, because production-per-game cannot see a snap count.',
    /* How much a group's DEPTH (beyond the projected starters) counts toward
       the group rating in the point estimate. Depth mostly changes VARIANCE,
       which the simulator reads, not the mean. */
    depth_weight_in_mean: 0.25
  };

  /* Position value: how much a position group moves a football game. Used to
     roll groups up into offence / defence / roster ratings and to order the
     key-matchup board. Declared as an EDGEDESK VIEW, not a trained parameter —
     the same status app.html already gives its roster-board weights. */
  var POSITION_VALUE = {
    QB: 1.00, OL: 0.62, EDGE: 0.55, WR: 0.52, DL: 0.50, CB: 0.48,
    LB: 0.38, S: 0.36, RB: 0.32, TE: 0.28, DB: 0.34, K: 0.12, P: 0.08, LS: 0.03, RET: 0.05, ATH: 0.15,
    basis: 'EdgeDesk view weights, not trained parameters. They order and roll up; they never price a line on their own.'
  };

  /* ------------------------------------------------------------------ *
   * SCHEME MATCHUP v1                                                   *
   * ------------------------------------------------------------------ */
  var SCHEME = {
    version: 'scheme_matchup_v1',
    /* Tendencies that ARE derivable from a play-attribution table with down,
       distance and yards-to-goal on every row. */
    derivable: ['neutral_pass_rate', 'early_down_pass_rate', 'rush_rate', 'explosive_pass_rate',
      'explosive_rush_rate', 'success_rate', 'stuff_rate_allowed', 'sack_rate_allowed',
      'sack_rate_generated', 'red_zone_rush_rate', 'third_down_pass_rate', 'plays_per_game',
      'run_success_allowed', 'pass_success_allowed', 'explosive_rush_allowed', 'explosive_pass_allowed'],
    /* Tendencies that are NOT. Named so the UI can say "unknown" instead of
       showing a confident-looking label with nothing behind it. */
    not_derivable: {
      personnel:  'personnel groupings (11, 12, 21) are not in any public play table',
      concepts:   'inside zone / outside zone / power / counter / duo / option are not labelled in any public feed',
      pass_concepts: 'RPO, play-action, screen, dropback and quick-game are not labelled',
      motion:     'pre-snap motion is not recorded',
      front:      'defensive front (4-2-5 / 3-3-5 / 3-4) is not recorded; it can be guessed from a roster’s position spelling and that guess is published as a GUESS with its own confidence',
      coverage:   'man / zone / single-high / two-high / Cover 1-4 rates are not recorded anywhere public',
      blitz_rate: 'blitzes are not labelled; only completed sacks are attributed',
      box_count:  'box counts are not recorded'
    },
    /* Front family inferred from the ROSTER's own position spelling. This is a
       weak signal and is published with a low ceiling on its confidence. */
    front_guess: { max_confidence: 0.35,
      basis: 'the share of a roster’s front seven spelled EDGE/OLB versus DE/DT. A program that spells its ends EDGE more often plays an odd front more often. It is a naming convention, not a film study, and it is labelled as a guess.' },
    /* Tempo, in plays per game, relative to the FBS mean. */
    pace: { fast_z: 0.75, slow_z: -0.75 },
    /* The matchup pairs the engine evaluates. Each is a UNIT-vs-UNIT read
       built from observable quantities on both sides. */
    pairs: [
      { id: 'run_off_vs_run_def',   off: ['OL', 'RB'], def: ['DL', 'LB'],   label: 'Run game vs run defence',            w: 1.00 },
      { id: 'pass_pro_vs_rush',     off: ['OL'],       def: ['EDGE', 'DL'], label: 'Pass protection vs pass rush',       w: 1.00 },
      { id: 'receivers_vs_cover',   off: ['WR', 'TE'], def: ['CB', 'S', 'DB'], label: 'Receivers vs coverage',           w: 0.95 },
      { id: 'qb_vs_pressure',       off: ['QB'],       def: ['EDGE', 'DL'], label: 'Quarterback under pressure',         w: 0.85 },
      { id: 'qb_rush_vs_edge',      off: ['QB'],       def: ['EDGE', 'LB'], label: 'Quarterback rushing vs edge contain', w: 0.55 },
      { id: 'explosive_vs_deep',    off: ['WR'],       def: ['S', 'CB'],    label: 'Explosive passing vs deep coverage', w: 0.70 }
    ],
    /* Style interactions on top of the raw unit gap. Each is a MULTIPLIER on
       the pair's magnitude and is only applied when BOTH sides' tendencies are
       actually measured. */
    style: {
      run_heavy_vs_weak_run_def:  { max: 0.35, basis: 'a team that runs more gets more from a run-defence edge, and vice versa' },
      pass_heavy_vs_weak_rush:    { max: 0.30, basis: 'a team that drops back more is exposed more to a pass-rush edge' },
      vertical_vs_explosive_allowed:{ max: 0.30, basis: 'an offence that hits explosives meeting a defence that allows them' },
      pace_amplifier:             { max: 0.20, basis: 'more plays means more chances for a structural edge to show up' }
    },
    /* Bands for the magnitude label. Units are MATCHUP POINTS on a 0-100
       unit-rating scale, NOT points of spread. Nothing converts one to the
       other except the calibrated scalar in params.js. */
    magnitude_bands: [
      { min: 12, label: 'DECISIVE' }, { min: 7, label: 'CLEAR' },
      { min: 3.5, label: 'MODEST' }, { min: 0, label: 'MARGINAL' }
    ]
  };

  /* ------------------------------------------------------------------ *
   * RUN DEFENCE GATE — a first-class feature                            *
   * ------------------------------------------------------------------ */
  var RUN_GATE = {
    version: 'run_defence_gate_v1',
    /* Components of the 0-100 stability score. Anything unavailable drops out
       and the remaining weights renormalize; the score reports how much of its
       own contract it actually got. */
    components: {
      dl_unit:              { w: 0.20, basis: 'defensive-line unit rating' },
      lb_unit:              { w: 0.14, basis: 'linebacker unit rating' },
      returning_front_value:{ w: 0.16, basis: 'share of last season’s front-seven production value still on the roster' },
      rush_success_allowed: { w: 0.20, basis: 'opponent-adjusted rushing success rate allowed — the single most observable thing about a run defence' },
      stuff_rate:           { w: 0.14, basis: 'share of opponent carries stopped at or behind the line' },
      explosive_rush_allowed:{ w: 0.16, basis: 'share of opponent carries of 15+ yards' }
    },
    /* Warning states, on the 0-100 score AFTER the opponent's rushing threat
       has been folded in. */
    bands: [
      { min: 78, state: 'STRONG' },
      { min: 60, state: 'STABLE' },
      { min: 45, state: 'QUESTIONABLE' },
      { min: 30, state: 'FRAGILE' },
      { min: 0,  state: 'SEVERE MISMATCH' }
    ],
    /* How far the opponent's rushing matchup edge can move the gate. */
    opponent_swing: 22,
    unknown_state: 'UNKNOWN',
    unknown_basis: 'below this much of its own component contract the gate refuses to publish a state rather than publishing a confident-looking guess',
    min_completeness: 0.45
  };

  /* ------------------------------------------------------------------ *
   * RISK GATES — explicit reasons to trust a research signal LESS        *
   * ------------------------------------------------------------------ */
  var RISK_GATES = [
    { id: 'RUN_DEFENCE_FRAGILITY', label: 'Run defence fragility', severity: 'high' },
    { id: 'NEW_QB',                label: 'New or unconfirmed quarterback', severity: 'high' },
    { id: 'OL_MISMATCH',           label: 'Offensive line mismatch', severity: 'high' },
    { id: 'SECONDARY_EXPLOSIVE_RISK', label: 'Secondary explosive-play risk', severity: 'medium' },
    { id: 'EXTREME_TRANSFER_TURNOVER', label: 'Extreme transfer turnover', severity: 'medium' },
    { id: 'LOW_DEPTH',             label: 'Thin depth at a high-value group', severity: 'medium' },
    { id: 'INJURY_UNCERTAINTY',    label: 'Injury / availability uncertainty', severity: 'medium' },
    { id: 'SCHEME_CHANGE',         label: 'Scheme change', severity: 'low' },
    { id: 'COORDINATOR_CHANGE',    label: 'Coordinator change', severity: 'low' },
    { id: 'LOW_PLAYER_DATA_CONFIDENCE', label: 'Low player-data confidence', severity: 'high' },
    { id: 'MODEL_MARKET_EXTREME_DISAGREEMENT', label: 'Model / market extreme disagreement', severity: 'high' }
  ];
  var RISK_THRESHOLDS = {
    run_gate_states: ['FRAGILE', 'SEVERE MISMATCH'],
    new_qb_confidence: 0.35,
    ol_mismatch_points: 9,
    secondary_explosive_z: 0.9,
    transfer_turnover_share: 0.42,
    depth_quality_floor: 34,
    availability_unknown_share: 0.5,
    player_confidence_floor: 0.45,
    model_market_points: 10
  };

  /* ------------------------------------------------------------------ *
   * SIMULATION v1                                                       *
   * ------------------------------------------------------------------ */
  var SIMULATION = {
    version: 'simulation_v1',
    default_draws: 10000,
    max_draws: 40000,
    default_seed: 20260101,
    /* The simulator draws a game margin and total from the SAME distribution
       family the Power 4 engine already ships (its measured sigma and its
       spread-conditioned key-number mass), then splits the total into two
       scores. It does NOT invent a new distribution. */
    score_split_basis: 'margin and total are drawn jointly; the two team scores are recovered as (total ± margin)/2 and rounded to the football scoring lattice',
    /* Correlation between margin and total. Measured value ships in params.js;
       this is the fallback when it has not been measured. */
    fallback_margin_total_corr: 0.0,
    /* Which quantiles the simulator reports. */
    quantiles: [0.10, 0.25, 0.50, 0.75, 0.90],
    one_score: 8,
    blowout: 21,
    /* Sensitivity probes for "WHAT BREAKS THE PROJECTION?". Each shifts ONE
       input by one standard deviation of its own measured spread and re-runs
       the deterministic mean, never the whole Monte Carlo, so the answer is
       exact rather than noisy. */
    sensitivity: [
      { id: 'underdog_qb_up',       label: 'underdog quarterback performs +1 SD', target: 'qb', side: 'dog',   sd: 1 },
      { id: 'favourite_run_down',   label: 'favourite run efficiency −1 SD',  target: 'run_off', side: 'fav', sd: -1 },
      { id: 'underdog_rush_up',     label: 'underdog rush success +1 SD',          target: 'run_off', side: 'dog', sd: 1 },
      { id: 'favourite_ol_injury',  label: 'favourite loses an offensive-line starter', target: 'ol_starter_out', side: 'fav', sd: null },
      { id: 'underdog_ol_injury',   label: 'underdog loses an offensive-line starter',  target: 'ol_starter_out', side: 'dog', sd: null },
      { id: 'favourite_qb_out',     label: 'favourite loses its projected quarterback',  target: 'qb_out', side: 'fav', sd: null },
      { id: 'pace_up',              label: 'game is played 1 SD faster',           target: 'pace', side: 'both', sd: 1 }
    ]
  };

  /* ------------------------------------------------------------------ *
   * THE LINE LADDER                                                     *
   * ------------------------------------------------------------------ *
   * RAW MODEL -> PLAYER-ADJUSTED -> SCHEME-ADJUSTED -> SIMULATION, each a
   * separate published number, and the MARKET kept outside all of them.
   * The two scalars that turn a unit-rating edge into points are MEASURED,
   * ship in params.js with their own walk-forward record, and carry
   * `points_applied`. If the walk-forward says a layer does not earn its
   * keep, points_applied is false and the ladder shows the step as flat with
   * the reason on screen — the same discipline this repo already applied to
   * travel and rivalry.
   * ------------------------------------------------------------------ */
  var LINE_LADDER = {
    steps: ['raw_model', 'player_adjusted', 'scheme_adjusted', 'simulation'],
    /* The conservative range published to a human. It is the spread of the
       ladder's own steps, widened by the layer's data-quality shortfall, and
       it is deliberately NOT a confidence interval. */
    fair_range: {
      min_half_width: 0.5, max_half_width: 4.0,
      quality_widening: 2.5,
      basis: 'half-width = half the spread of the ladder’s steps, plus (1 - overall data quality) x 2.5 points, clamped. A range, not an interval: it says how much the model’s own layers disagree, not how uncertain the outcome is.'
    }
  };

  /* Data-quality dimensions reported on every game. */
  var QUALITY_DIMENSIONS = ['player_data', 'recruiting', 'production', 'availability', 'scheme'];

  return {
    version: 'player_rating_v1',
    versions: {
      player_rating: 'player_rating_v1',
      scheme_matchup: 'scheme_matchup_v1',
      simulation: 'simulation_v1',
      run_gate: 'run_defence_gate_v1'
    },
    POS_GROUP: POS_GROUP,
    GROUP_ORDER: GROUP_ORDER,
    OFFENSE_GROUPS: OFFENSE_GROUPS,
    DEFENSE_GROUPS: DEFENSE_GROUPS,
    SPECIAL_GROUPS: SPECIAL_GROUPS,
    OBSERVABILITY: OBSERVABILITY,
    COVERAGE_GATES: COVERAGE_GATES,
    SUCCESS: SUCCESS,
    EXPLOSIVE: EXPLOSIVE,
    MEASURES: MEASURES,
    NO_PRODUCTION_FEED: NO_PRODUCTION_FEED,
    SHRINK: SHRINK,
    EPIR_SCALE: EPIR_SCALE,
    EPIR_COMPONENTS: EPIR_COMPONENTS,
    CONFIDENCE: CONFIDENCE,
    ROLE: ROLE,
    POSITION_VALUE: POSITION_VALUE,
    SCHEME: SCHEME,
    RUN_GATE: RUN_GATE,
    RISK_GATES: RISK_GATES,
    RISK_THRESHOLDS: RISK_THRESHOLDS,
    SIMULATION: SIMULATION,
    LINE_LADDER: LINE_LADDER,
    QUALITY_DIMENSIONS: QUALITY_DIMENSIONS,
    group: function (pos) {
      if (pos == null) return null;
      var p = String(pos).toUpperCase().replace(/[^A-Z]/g, '');
      return POS_GROUP[p] || null;
    }
  };
});
