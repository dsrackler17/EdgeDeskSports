/* ============================================================================
   EDGEDESK NATIONAL TEAM RANKINGS — VERSIONED CONFIGURATION.

   Every weight, band, threshold and metric contract the rankings use lives
   HERE, under a version string, with a `basis` on each one saying why it is
   what it is. Nothing that changes a rating is allowed to live in a build
   script, in a test, or — least of all — in the frontend.

   Anything that had to be MEASURED rather than chosen lives in the GENERATED
   sibling `params.js`, written by `validate_rankings.js`: the points-per-z
   scalars that turn an efficiency z-score into points of spread, the ramp
   constant that decides how fast current-season play overtakes the preseason
   prior, the league carryover slope, and the walk-forward record that says
   whether any of it beats what EdgeDesk already ships.

   FOUR INDEPENDENT VERSIONS, deliberately not one:
     talent_v1        how much football ability is on the roster
     performance_v1   how well it has actually played, opponent-adjusted
     team_rating_v1   how the two combine into points versus an average FBS team
     run_defence_power_v1   the run-defence unit ranking, which is its own thing

   Runs in the browser (window.EDRankConfig) and in node (module.exports).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDRankConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSIONS = {
    talent: 'talent_v1',
    performance: 'performance_v1',
    team_rating: 'team_rating_v1',
    run_defence_power: 'run_defence_power_v1',
    /* the layers underneath, restated so every artifact says what it was built
       on rather than leaving the reader to guess */
    player_rating: 'player_rating_v1',
    scheme_matchup: 'scheme_matchup_v1',
    simulation: 'simulation_v1'
  };
  var SCHEMA_VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * WHAT THE PERFORMANCE LAYER MEASURES                                 *
   * ------------------------------------------------------------------ *
   * EPA IS NOT ONE OF THEM, and that is a data fact rather than a choice.
   * The public play table carries down, distance, field position and who
   * touched the ball; it carries no next-score information, and the expected-
   * points surface this repo once fitted is no longer reproducible from public
   * files (see football/players/README.md). Success rate, explosive rate,
   * yards per play, conversion rate and sack rate ARE all directly countable
   * from the same rows, they are what EPA is mostly made of, and they are used
   * instead of an EPA being invented.
   *
   * Each metric declares:
   *   id      the field on the team-game aggregate pair {num, den}
   *   w       its weight inside the composite
   *   dir     +1 if higher is better FOR THE TEAM THE METRIC IS ABOUT
   *   min_n   below this denominator the metric is not scored at all
   *   regress how much of the team's deviation from league mean is shrunk away
   *           before it counts (0 = none). Used for statistics this repo has
   *           MEASURED not to repeat.
   * ------------------------------------------------------------------ */
  var OFFENSE_METRICS = [
    { id: 'success_rate',        num: 'success_all',        den: 'plays_all',   w: 0.22, dir: 1,  min_n: 150, basis: 'the down-by-down measure of whether the offence worked. The most repeatable single thing an offence does.' },
    { id: 'early_down_success',  num: 'early_down_success', den: 'early_down_plays', w: 0.16, dir: 1, min_n: 90, basis: 'first and second down are the downs a team CHOOSES; third down is largely the consequence. Weighted accordingly.' },
    { id: 'explosive_pass_rate', num: 'pass_explosive',     den: 'pass_att',    w: 0.12, dir: 1,  min_n: 60,  basis: 'explosive passing is where college scoring margin actually comes from' },
    { id: 'yards_per_attempt',   num: 'pass_yds',           den: 'pass_att',    w: 0.10, dir: 1,  min_n: 60,  basis: 'the classic volume-free passing rate' },
    { id: 'explosive_rush_rate', num: 'rush_explosive',     den: 'rush_att',    w: 0.09, dir: 1,  min_n: 60,  basis: 'breakaway running' },
    { id: 'sack_rate_allowed',   num: 'sacks_taken',        den: 'dropbacks',   w: 0.08, dir: -1, min_n: 60,  basis: 'protection and quarterback pocket management together; the stable half of the disruption pair this repo trusts' },
    { id: 'yards_per_rush',      num: 'rush_yds',           den: 'rush_att',    w: 0.07, dir: 1,  min_n: 60,  basis: 'the headline rushing rate' },
    { id: 'third_success',       num: 'third_success',      den: 'third_plays', w: 0.06, dir: 1,  min_n: 35,  basis: 'third-down conversion. Real, but noisier than early-down work and weighted below it.' },
    { id: 'stuff_rate',          num: 'rush_stuffed',       den: 'rush_att',    w: 0.06, dir: -1, min_n: 60,  basis: 'carries stopped at or behind the line' },
    { id: 'rz_success',          num: 'rz_success',         den: 'rz_plays',    w: 0.04, dir: 1,  min_n: 25,  basis: 'red-zone efficiency. Small samples, small weight, and regressed.', regress: 0.5 },
    { id: 'turnover_rate',       num: 'turnovers',          den: 'plays_all',   w: 0.03, dir: -1, min_n: 150, basis: 'interceptions thrown plus fumbles. This repo MEASURED turnover margin to repeat at r = 0.077 — anyone reading it as skill is reading noise — so 85% of the deviation is regressed away before it counts at all.', regress: 0.85 }
  ];
  var DEFENSE_METRICS = [
    { id: 'def_success_allowed',       num: 'success_all',        den: 'plays_all',        w: 0.22, dir: -1, min_n: 150, basis: 'as the offensive mirror' },
    { id: 'def_early_down_allowed',    num: 'early_down_success', den: 'early_down_plays', w: 0.16, dir: -1, min_n: 90,  basis: 'as the offensive mirror' },
    { id: 'def_explosive_pass_allowed',num: 'pass_explosive',     den: 'pass_att',         w: 0.12, dir: -1, min_n: 60,  basis: 'explosive passes allowed — the single loudest secondary failure' },
    { id: 'def_yards_per_attempt',     num: 'pass_yds',           den: 'pass_att',         w: 0.10, dir: -1, min_n: 60,  basis: 'as the offensive mirror' },
    { id: 'def_explosive_rush_allowed',num: 'rush_explosive',     den: 'rush_att',         w: 0.09, dir: -1, min_n: 60,  basis: 'explosive runs allowed' },
    { id: 'def_sack_rate',             num: 'sacks_taken',        den: 'dropbacks',        w: 0.08, dir: 1,  min_n: 60,  basis: 'sacks GENERATED. Pressure short of a sack is unobserved in every public feed, so this is the pass rush’s only measurable output.' },
    { id: 'def_yards_per_rush',        num: 'rush_yds',           den: 'rush_att',         w: 0.07, dir: -1, min_n: 60,  basis: 'as the offensive mirror' },
    { id: 'def_third_allowed',         num: 'third_success',      den: 'third_plays',      w: 0.06, dir: -1, min_n: 35,  basis: 'third downs allowed to convert' },
    { id: 'def_stuff_rate',            num: 'rush_stuffed',       den: 'rush_att',         w: 0.06, dir: 1,  min_n: 60,  basis: 'opponent carries stopped at or behind the line' },
    { id: 'def_rz_allowed',            num: 'rz_success',         den: 'rz_plays',         w: 0.04, dir: -1, min_n: 25,  basis: 'red-zone defence, regressed', regress: 0.5 },
    { id: 'def_turnovers_forced',      num: 'turnovers',          den: 'plays_all',        w: 0.03, dir: 1,  min_n: 150, basis: 'as the offensive mirror, and regressed for the same measured reason', regress: 0.85 }
  ];

  /* Sub-unit performance ratings. Each is a subset of the metrics above,
     renormalised over whatever was actually measurable. */
  /* Sub-unit performance ratings. Each carries its OWN metric list rather than
     borrowing ids from the tables above, because "success rate" means the
     rushing success rate inside the run game and the dropback success rate
     inside the pass game, and quietly reusing the all-plays version would put
     the wrong number under the right label. */
  var SUB_UNITS = {
    run_offense: { side: 'offense', label: 'Run offense',
      basis: 'the run game on its own: down-by-down success on carries, yards per carry, breakaways, and how often it is stopped at the line',
      metrics: [
        { id: 'ro_success',   num: 'rush_success',   den: 'rush_att', w: 0.34, dir: 1,  min_n: 60 },
        { id: 'ro_explosive', num: 'rush_explosive', den: 'rush_att', w: 0.24, dir: 1,  min_n: 60 },
        { id: 'ro_ypc',       num: 'rush_yds',       den: 'rush_att', w: 0.24, dir: 1,  min_n: 60 },
        { id: 'ro_stuffed',   num: 'rush_stuffed',   den: 'rush_att', w: 0.18, dir: -1, min_n: 60 }
      ] },
    pass_offense: { side: 'offense', label: 'Pass offense',
      basis: 'the pass game on its own, with sacks taken charged to it because a sack is a failed dropback',
      metrics: [
        { id: 'po_success',   num: 'pass_success',   den: 'dropbacks', w: 0.32, dir: 1,  min_n: 60 },
        { id: 'po_explosive', num: 'pass_explosive', den: 'pass_att',  w: 0.26, dir: 1,  min_n: 60 },
        { id: 'po_ypa',       num: 'pass_yds',       den: 'pass_att',  w: 0.24, dir: 1,  min_n: 60 },
        { id: 'po_sacks',     num: 'sacks_taken',    den: 'dropbacks', w: 0.18, dir: -1, min_n: 60 }
      ] },
    run_defense: { side: 'defense', label: 'Run defense',
      basis: 'the run defence on its own — the unit whose collapse most often kills a favourite-side handicap',
      metrics: [
        { id: 'rd_success',   num: 'rush_success',   den: 'rush_att', w: 0.32, dir: -1, min_n: 60 },
        { id: 'rd_explosive', num: 'rush_explosive', den: 'rush_att', w: 0.24, dir: -1, min_n: 60 },
        { id: 'rd_ypc',       num: 'rush_yds',       den: 'rush_att', w: 0.22, dir: -1, min_n: 60 },
        { id: 'rd_stuffed',   num: 'rush_stuffed',   den: 'rush_att', w: 0.22, dir: 1,  min_n: 60 }
      ] },
    pass_defense: { side: 'defense', label: 'Pass defense',
      basis: 'the pass defence on its own',
      metrics: [
        { id: 'pd_success',   num: 'pass_success',   den: 'dropbacks', w: 0.30, dir: -1, min_n: 60 },
        { id: 'pd_explosive', num: 'pass_explosive', den: 'pass_att',  w: 0.26, dir: -1, min_n: 60 },
        { id: 'pd_ypa',       num: 'pass_yds',       den: 'pass_att',  w: 0.22, dir: -1, min_n: 60 },
        { id: 'pd_sacks',     num: 'sacks_taken',    den: 'dropbacks', w: 0.22, dir: 1,  min_n: 60 }
      ] }
  };

  /* Offence and defence weigh equally in the net efficiency that feeds ETSR.
     Stated rather than assumed: there is no measured reason in this data to
     prefer one, and asserting one without a measurement is exactly the kind of
     unexplained constant this file exists to prevent. */
  var NET = { offense_weight: 0.5, defense_weight: 0.5,
    basis: 'equal, because nothing measured here justifies preferring one side, and an unmeasured preference is a thumb on the scale.' };

  /* ------------------------------------------------------------------ *
   * OPPONENT ADJUSTMENT                                                 *
   * ------------------------------------------------------------------ */
  var OPPONENT = {
    max_iterations: 800,
    tolerance: 1e-6,
    tolerance_is_relative: true,
    convergence_basis: 'the 2% pull toward the mean on every pass is what makes this a contraction, and it is also what makes it a SLOW one — the tail decays like 0.98^k, so a success rate needs roughly 430 passes to settle. The bar is set at one part in a million of the metric’s own league mean, which is three orders of magnitude finer than anything this system publishes, and the iteration count and final movement ship with the dataset so a build that stopped early is visible rather than assumed.',
    tolerance_basis: 'the tolerance is RELATIVE to the metric’s own league mean. A success rate lives near 0.42 and yards per carry near 4.5; one absolute epsilon cannot mean the same thing to both, and using one would declare convergence on the second while still moving on the first.',
    basis: 'a fixed point: each side of every game is the denominator-weighted mean of (what it did − how far the other side is from league average at allowing it). Iterated to convergence rather than to a round number of passes, and the iteration count and final movement ship with the dataset.',
    /* Circular inflation guard. Without it, two teams that only play each other
       can drift arbitrarily far apart. */
    shrink_per_iteration: 0.98,
    shrink_basis: 'each pass pulls every rating 2% back toward the league mean. It costs almost nothing at convergence and it bounds the feedback loop that lets an isolated pair of teams inflate each other.',
    fcs_pooled_key: '__nonfbs__',
    fcs_basis: 'every non-FBS opponent shares ONE pooled identity that is solved for like any other team, so beating an FCS side is worth what the data says it is worth rather than a number somebody chose.'
  };

  /* ------------------------------------------------------------------ *
   * RECENCY                                                             *
   * ------------------------------------------------------------------ */
  var RECENCY = {
    half_life_games: 5.0,
    basis: 'a game’s weight halves every five games played. The last game is worth ~1.0, a game five back ~0.5, a game ten back ~0.25 — recent form matters more without a single Saturday being allowed to rewrite a season.',
    floor: 0.12,
    floor_basis: 'no game ever falls below 12% weight. A season is evidence even when it is old evidence, and a decay that reaches zero throws away the opponent adjustment’s own connectivity.',
    prior_season_weight: 0.0,
    prior_season_basis: 'prior-season PLAY data is not blended into the current-season performance rating. Last season enters through the PRIOR term of ETSR, where it is carried by a measured coefficient and can be argued with, rather than being smuggled in as if it were this season’s football.'
  };

  /* ------------------------------------------------------------------ *
   * FCS AND NON-FBS OPPONENTS                                           *
   * ------------------------------------------------------------------ */
  var NON_FBS = {
    game_weight: 0.45,
    game_weight_basis: 'a non-FBS game is real football and is not thrown away, but it is worth less than half an FBS game as evidence: the opponent pool is solved as ONE team, so a single result carries far less information about where a team sits among FBS teams.',
    confidence_penalty_per_share: 0.35,
    confidence_basis: 'a team whose sample is mostly non-FBS opponents has its confidence cut in proportion to that share, and the FCS_DOMINATED_SAMPLE gate fires.',
    fallback_prior_points: -28.0,
    fallback_basis: 'when the pooled non-FBS rating cannot be solved (too few such games in the season), a documented fallback of −28 points versus an average FBS team is used and LABELLED as a fallback. It is the same figure the Power 4 engine ships as its own FCS seed, so the two do not disagree with each other.'
  };

  /* ------------------------------------------------------------------ *
   * DYNAMIC PRIORS — how fast this season overtakes last season         *
   * ------------------------------------------------------------------ *
   * w_performance = g / (g + k), where g is FBS-equivalent games played and k
   * is FITTED on a tune window (params.js `prior_ramp_k`) by choosing the k
   * that minimises out-of-sample margin error. It is NOT a table of week
   * numbers somebody liked the look of, and the ramp it implies is published
   * so it can be read as one:
   *
   *     k = 3   ->  week 1: 25%   week 3: 50%   week 6: 67%   week 12: 80%
   *
   * FALLBACK_K is used only until the fit has been run, and any rating built
   * on it says `ramp_measured: false`.
   * ------------------------------------------------------------------ */
  var PRIORS = {
    fallback_ramp_k: 3.0,
    ramp_basis: 'w_performance = g/(g+k) with g in FBS-equivalent games. Continuous, so there is no cliff between week 4 and week 5, and week 0 falls out of it correctly with w_performance = 0.',
    min_games_for_performance: 1,
    /* structural talent never fully disappears, however long the season runs */
    talent_floor_weight: 0.15,
    talent_floor_basis: 'even in December, 15% of the PRIOR term stays with roster talent rather than last season’s result. A team that lost its quarterback in October is not the team that played in September, and a rating built only on results cannot see that.'
  };

  /* ------------------------------------------------------------------ *
   * PORTAL-ERA CARRYOVER                                                *
   * ------------------------------------------------------------------ *
   * How much of LAST season's rating a team is allowed to carry. The league
   * slope is MEASURED every build (the same arithmetic football/rating/ already
   * uses to answer the NIL/portal argument); this block decides how each team
   * moves around that league number on its own continuity.
   * ------------------------------------------------------------------ */
  var CARRYOVER = {
    inputs: [
      { id: 'value_continuity',  w: 0.34, basis: 'share of last season’s PRODUCTION VALUE still on the roster — not the headcount, which is a different and much weaker statement' },
      { id: 'qb_continuity',     w: 0.24, basis: 'whether the quarterback room’s projected starter was on last season’s roster. The single largest source of year-over-year change in college football.' },
      { id: 'ol_continuity',     w: 0.16, basis: 'offensive-line continuity, which this repo’s own Power 4 engine already treats as a first-class variable' },
      { id: 'starts_continuity', w: 0.14, basis: 'share of last season’s projected STARTERS still on the roster' },
      { id: 'transfer_churn',    w: 0.12, dir: -1, basis: 'net transfer volume as a share of the roster. High churn cuts carryover; it does not by itself cut the rating.' }
    ],
    /* the team coefficient is the league slope scaled by how a team's own
       continuity compares to the league */
    span: 0.55,
    span_basis: 'a team at the top of the continuity distribution carries up to 55% MORE of the league slope than a team at the bottom carries less. The league slope itself is measured, not chosen; this only decides who is above and below it.',
    min_coef: 0.15, max_coef: 0.95,
    clamp_basis: 'no team carries nothing (it is the same programme, the same staff, the same league) and no team carries everything (nobody returns a whole roster any more).',
    coordinator_continuity: {
      available: false,
      reason: 'no public, keyless feed carries coordinator hires. The input is contracted for and stays absent rather than being guessed; when a licensed feed is wired in it takes a weight from the same block.'
    }
  };

  /* ------------------------------------------------------------------ *
   * TALENT                                                              *
   * ------------------------------------------------------------------ */
  var TALENT = {
    components: [
      { id: 'starter_quality', w: 0.44, basis: 'the projected starters, weighted by position value. Who actually plays most of the snaps.' },
      { id: 'rotation_quality', w: 0.18, basis: 'the players behind them who still take real snaps — a defensive front rotates, a receiver room rotates' },
      { id: 'depth_quality',   w: 0.12, basis: 'what happens when somebody goes down. Mostly a variance story, but it belongs in ability.' },
      { id: 'returning_value', w: 0.12, basis: 'share of last season’s production value still here. Continuity of ABILITY, not of bodies.' },
      { id: 'transfer_value',  w: 0.09, basis: 'what the portal actually added or lost, valued the same way every other player is valued' },
      { id: 'availability',    w: 0.05, basis: 'who is expected to be able to play. Reversible, and small, because an injury is not a talent change — it is an availability change, and the two are published apart.' }
    ],
    recruiting: {
      applied: false,
      weight_if_wired: 0.10,
      reason: 'no legal, public, keyless recruiting feed is wired in. football/players/recruiting_adapter.js is built and every field ships null; the day a licensed source is supplied, recruiting enters HERE with this weight and through the player layer’s shrinkage prior, and nowhere else.'
    },
    scale: { center: 50, sd: 12, floor: 1, ceiling: 99 },
    scale_basis: 'the same 0-100 scale the player layer uses, so a talent rating and an EPIR mean the same thing: 50 is replacement, 12 points is one standard deviation.',
    smoothing: {
      alpha: 1.0, applied: false,
      basis: 'no week-to-week smoothing is applied, because EPIR is already career-shrunk with a MEASURED k in the hundreds — one game moves a player rating by a fraction of a point and cannot move a roster. The observed week-over-week talent volatility ships in the dataset so this decision can be revisited with evidence rather than with a feeling.'
    },
    /* what is allowed to move talent, restated as a contract the tests hold */
    may_move: ['availability change', 'depth-chart change', 'transfer eligibility', 'accumulated player evidence changing EPIR'],
    may_not_move: ['a single bad game', 'a turnover-filled game', 'a blowout loss', 'a poll', 'the market']
  };

  /* ------------------------------------------------------------------ *
   * ETSR — the team rating, in points versus an average FBS team        *
   * ------------------------------------------------------------------ */
  var ETSR = {
    /* points per standard deviation of net efficiency and of talent are
       MEASURED (params.js). These are the fallbacks used before the fit has
       been run, and any rating built on them says `scalars_measured: false`. */
    fallback_performance_points_per_z: 7.5,
    fallback_talent_points_per_z: 4.0,
    scalar_basis: 'both are fitted by least squares of actual game margin on the rating difference, on a tune window, and scored on a holdout the fit never saw. Until that has been run they are declared fallbacks and the dataset says so.',
    centre_on: 'fbs_mean',
    centre_basis: 'ETSR is re-centred every build so the mean FBS team is exactly 0.0. The ratings are a ladder; the rung the average team stands on is a convention, and fixing it at zero is what makes "+17.2" mean something.',
    home_field: {
      in_base_rating: false,
      basis: 'HOME FIELD IS NOT IN THE TEAM RATING. ETSR is a neutral-field number so that ETSR(A) − ETSR(B) is a neutral-field spread; home field, travel, rest, injuries, quarterback and the scheme matchup are applied by the MATCHUP layer to produce a game line. Baking it in would make every rating wrong by the same few points and quietly double-count it at kickoff.'
    },
    max_abs_rating: 45,
    max_abs_basis: 'no FBS team has ever been 45 points better than average over a season. A rating outside this is a data fault, not a great team, and the anomaly gate fires.'
  };

  /* ------------------------------------------------------------------ *
   * RUN DEFENCE POWER                                                   *
   * ------------------------------------------------------------------ */
  var RUN_DEFENCE_POWER = {
    components: [
      { id: 'dl_unit',                w: 0.16, basis: 'defensive-line unit rating from the player layer' },
      { id: 'lb_unit',                w: 0.11, basis: 'linebacker unit rating from the player layer' },
      { id: 'edge_unit',              w: 0.07, basis: 'edge unit rating, where the roster spells one' },
      { id: 'front_returning_value',  w: 0.10, basis: 'share of last season’s front-seven production value still on the roster' },
      { id: 'rush_success_allowed',   w: 0.20, basis: 'opponent-adjusted rushing success rate allowed — the most observable single fact about a run defence' },
      { id: 'stuff_rate',             w: 0.13, basis: 'opponent carries stopped at or behind the line' },
      { id: 'explosive_rush_allowed', w: 0.13, basis: 'opponent carries of 15+ yards' },
      { id: 'yards_per_rush_allowed', w: 0.10, basis: 'opponent yards per carry' }
    ],
    unobservable: {
      missed_tackles: 'no public feed carries a missed tackle',
      yards_before_contact: 'not carried in any public college feed',
      run_stops: 'no tackle column exists at all, so a run stop cannot be attributed to a defender',
      box_count: 'not recorded anywhere public',
      edge_containment: 'not separable from the rest of the run defence without charting; the stuff rate and explosive-run rate carry what can be seen of it'
    },
    qb_rush_defence: {
      applied: false,
      reason: 'a rushing quarterback’s carries are attributed to him, so the OFFENCE side of this matchup is fully observed and the matchup engine already reads it. The DEFENCE side — whether a front is specifically vulnerable to quarterback running — cannot be separated from its general run defence in this feed, and is not invented.'
    },
    min_completeness: 0.40,
    min_completeness_basis: 'the ROSTER half of this contract — the two front units, the edge unit where a roster spells one, and the front’s returning value — comes to 0.44 on its own. That is a real, publishable read on a run defence before a snap has been played, and the completeness figure on the record says it is roster-only. Below 0.40 there is not enough of either half and the score refuses to publish rather than guessing.',
    bands: [
      { min: 80, label: 'ELITE' }, { min: 65, label: 'STRONG' }, { min: 50, label: 'SOLID' },
      { min: 35, label: 'SOFT' }, { min: 0, label: 'FRAGILE' }
    ]
  };

  /* ------------------------------------------------------------------ *
   * CONFIDENCE                                                          *
   * ------------------------------------------------------------------ */
  var CONFIDENCE = {
    /* CONFIDENCE IN A RATING IS CONFIDENCE IN THE INPUTS THAT RATING ACTUALLY
       USES, IN THE PROPORTION IT USES THEM.

       This is not a detail. A preseason board leans entirely on the roster and
       last season, and both of those are known; scoring it as 5% confident
       because no games have been played would be measuring the calendar, not
       the evidence. Equally, a December rating leans almost entirely on what
       happened on the field, and how well we know the two-deep matters much
       less there.

       So the season-data components are weighted by w_performance and the
       roster components by (1 − w_performance) — the very same split ETSR
       itself uses — and only the two that always matter are fixed. */
    prior_side: {
      player_data: 0.42,
      starter_certainty: 0.34,
      returning_production: 0.24
    },
    performance_side: {
      game_sample: 0.62,
      opponent_sample: 0.38
    },
    always: {
      availability: 0.10,
      scheme_data: 0.06
    },
    split_basis: 'the prior-side and performance-side blocks are each internally normalised, then mixed by (1 − w_performance) and w_performance respectively. The `always` block sits on top at its stated weight because availability and tendency data are relevant to a rating whatever it leans on.',
    game_sample_k: 2.0,
    game_sample_basis: 'games/(games+2): three games is halfway, six is 75%, a full twelve-game season is 86%. It was games/(games+4), which topped out at 75% after a whole season and had the perverse effect of making a played season read as LESS certain than a preseason board — knowing more must never lower confidence, and rankings.test.js now holds that property.',
    basis: 'confidence is about how much EdgeDesk actually knows, and is orthogonal to the rating. A +8.1 at 61% and a +8.1 at 92% are different statements and nothing in this system merges them.'
  };

  /* ------------------------------------------------------------------ *
   * DATA-QUALITY GATES                                                  *
   * ------------------------------------------------------------------ *
   * A gate LOWERS CONFIDENCE. It never silently moves the rating: the only
   * things that move a rating are the metric contract and the priors above.
   * ------------------------------------------------------------------ */
  /* A gate is a WARNING. Some gates tell the confidence score something it
     does not already know; those cost confidence. Others restate a component
     the score has ALREADY priced — a one-week-old season is exactly what
     `game_sample` measures — and charging for it a second time is double-
     counting, which is how every team in week one ended up pinned at the 5%
     floor and nothing on the board was rankable. A gate that duplicates a
     component declares which one and costs nothing; it still fires, is still
     shown, and is still the reason a reader sees for the low number. */
  var GATES = [
    { id: 'LOW_SAMPLE_SIZE',          severity: 'high',   confidence_cost: 0,    duplicates_component: 'game_sample',
      basis: 'fewer FBS-equivalent games than a performance rating needs. Costs no confidence directly because `game_sample` already prices exactly this; it fires as the WARNING that explains the low number.' },
    { id: 'QB_UNKNOWN',               severity: 'high',   confidence_cost: 0.14, basis: 'the quarterback room produced no rateable player, or its confidence is below the floor. Priced separately because a thin quarterback room is worse than its share of the roster suggests.' },
    { id: 'INJURY_UNCERTAINTY',       severity: 'medium', confidence_cost: 0,    duplicates_component: 'availability',
      basis: 'most projected starters have no availability record at all. UNKNOWN is not healthy — and the `availability` component already prices it, so this fires as the explanation rather than as a second charge.' },
    { id: 'EXTREME_TRANSFER_TURNOVER',severity: 'medium', confidence_cost: 0.10, basis: 'most of last season’s production value has left, so the prior term is standing on much less than usual' },
    { id: 'THIN_DEFENSIVE_DATA',      severity: 'medium', confidence_cost: 0.06, basis: 'too few defensive snaps faced to score the defensive contract' },
    { id: 'THIN_OFFENSIVE_DATA',      severity: 'medium', confidence_cost: 0.06, basis: 'too few offensive snaps to score the offensive contract' },
    { id: 'FCS_DOMINATED_SAMPLE',     severity: 'high',   confidence_cost: 0.16, basis: 'most of the games played are against a pooled non-FBS opponent, so the sample says far less about where this team sits among FBS teams than its size suggests' },
    { id: 'SCHEME_DATA_LOW_CONFIDENCE', severity: 'low',  confidence_cost: 0,    duplicates_component: 'scheme_data',
      basis: 'the tendency profile is mostly last season’s, or is thin. Already priced by the `scheme_data` component.' },
    { id: 'PRIOR_SEASON_MISSING',     severity: 'medium', confidence_cost: 0.10, basis: 'no prior-season rating exists (an FBS newcomer, or a season the feed never published), so the PRIOR term rests on talent alone' }
  ];
  var GATE_THRESHOLDS = {
    low_sample_games: 3,
    qb_confidence_floor: 0.35,
    injury_unknown_share: 0.75,
    transfer_turnover_share: 0.55,
    thin_side_plays: 250,
    fcs_share: 0.5,
    scheme_confidence_floor: 0.35
  };

  /* ------------------------------------------------------------------ *
   * RANKING CATEGORIES                                                  *
   * ------------------------------------------------------------------ */
  var RANKINGS = [
    { id: 'overall',      label: 'Overall',      field: 'etsr',                   dir: -1 },
    { id: 'talent',       label: 'Talent',       field: 'talent.rating',          dir: -1 },
    { id: 'performance',  label: 'Performance',  field: 'performance.rating',     dir: -1 },
    { id: 'offense',      label: 'Offense',      field: 'performance.offense',    dir: -1 },
    { id: 'defense',      label: 'Defense',      field: 'performance.defense',    dir: -1 },
    { id: 'run_offense',  label: 'Run offense',  field: 'performance.run_offense',dir: -1 },
    { id: 'pass_offense', label: 'Pass offense', field: 'performance.pass_offense',dir: -1 },
    { id: 'run_defense',  label: 'Run defense',  field: 'run_defence_power.score',dir: -1 },
    { id: 'pass_defense', label: 'Pass defense', field: 'performance.pass_defense',dir: -1 },
    { id: 'special_teams',label: 'Special teams',field: 'units.K.rating',                dir: -1 },
    { id: 'qb',           label: 'QB room',      field: 'units.QB.rating',               dir: -1 },
    { id: 'ol',           label: 'OL',           field: 'units.OL.rating',               dir: -1 },
    { id: 'wr',           label: 'WR / TE',      field: 'units.WR.rating',               dir: -1 },
    { id: 'rb',           label: 'RB',           field: 'units.RB.rating',               dir: -1 },
    { id: 'dl',           label: 'DL',           field: 'units.DL.rating',               dir: -1 },
    { id: 'edge',         label: 'EDGE',         field: 'units.EDGE.rating',             dir: -1 },
    { id: 'lb',           label: 'LB',           field: 'units.LB.rating',               dir: -1 },
    { id: 'secondary',    label: 'Secondary',    field: 'units.SECONDARY.rating',        dir: -1 },
    { id: 'depth',        label: 'Depth',        field: 'depth.rating',           dir: -1 },
    { id: 'continuity',   label: 'Continuity',   field: 'continuity.rating',      dir: -1 },
    { id: 'scheme_fit',   label: 'Scheme fit',   field: 'scheme_fit.rating',      dir: -1 },
    { id: 'availability', label: 'Availability', field: 'availability.rating',    dir: -1 }
  ];
  var RANK_MIN_CONFIDENCE = 0.22;
  var RANK_MIN_CONFIDENCE_BASIS = 'below this a team is listed UNRANKED / LOW CONFIDENCE in that category rather than given a number that looks like the others. It keeps its rating; it does not keep its rank.';

  /* ------------------------------------------------------------------ *
   * MOVEMENT, STABILITY AND ANOMALIES                                   *
   * ------------------------------------------------------------------ */
  var MOVEMENT = {
    explain_components: ['talent', 'performance', 'offense', 'defense', 'run_offense', 'pass_offense',
      'run_defense', 'pass_defense', 'opponent_adjustment', 'prior_weight', 'availability'],
    min_reportable_points: 0.05,
    basis: 'movement is explained by DIFFERENCING the components between two snapshots and reporting the ones that actually moved. No model is asked why a rating changed, because the answer is arithmetic and the arithmetic is available.'
  };
  var STABILITY = {
    max_mean_rank_shift: 6.0,
    max_share_moving_15: 0.15,
    max_rating_shift_points: 6.0,
    basis: 'if forty teams move fifteen spots in a week, the system is broken, not perceptive. These are diagnostics that FAIL a build, not scores.'
  };
  var ANOMALIES = [
    { id: 'RATING_JUMP',        severity: 'severe', basis: 'a week-over-week ETSR move beyond the configured bound' },
    { id: 'TALENT_COLLAPSE',    severity: 'severe', basis: 'talent falling more than the bound in a week — talent is not allowed to react to a result' },
    { id: 'IMPOSSIBLE_RATING',  severity: 'severe', basis: 'a rating outside the physically plausible band, or not a number' },
    { id: 'MISSING_TEAM',       severity: 'severe', basis: 'an FBS team in the schedule that produced no rating' },
    { id: 'DUPLICATE_TEAM',     severity: 'severe', basis: 'two rating rows for one team key' },
    { id: 'DUPLICATE_GAME',     severity: 'severe', basis: 'the same game id counted twice for one team' },
    { id: 'TEAM_MAPPING',       severity: 'severe', basis: 'a team key that no schedule, roster or player file recognises' },
    { id: 'MISSING_SNAPSHOT',   severity: 'severe', basis: 'a completed week with no snapshot on file' },
    { id: 'ZERO_SNAP_STARTER',  severity: 'warn',   basis: 'a projected starter with no attributed volume in any season read' },
    { id: 'MISSING_PLAYER_DATA',severity: 'warn',   basis: 'a team whose roster produced no rateable player at a high-value position' },
    { id: 'MISSING_GAMES',      severity: 'warn',   basis: 'a team with fewer completed games than the schedule says it played' },
    { id: 'STABILITY',          severity: 'severe', basis: 'the whole board moved more than the stability bounds allow' }
  ];
  var ANOMALY_THRESHOLDS = {
    rating_jump_points: 9.0,
    talent_drop_points: 5.0,
    rating_abs_max: 45,
    talent_abs_min: 1, talent_abs_max: 99
  };

  /* ------------------------------------------------------------------ *
   * MARKET COMPARISON — displayed beside, never fed in                  *
   * ------------------------------------------------------------------ */
  var MARKET = {
    is_input: false,
    basis: 'the market NEVER determines ETSR. A market-implied power number is derived separately from the same games’ closing lines and shown in its own column so the two can be seen disagreeing.',
    labels: [
      { min: 7.0, label: 'MAJOR RESEARCH DISAGREEMENT' },
      { min: 3.5, label: 'RESEARCH DISAGREEMENT' },
      { min: 1.5, label: 'MILD DISAGREEMENT' },
      { min: 0,   label: 'IN LINE' }
    ],
    never_call_it: 'edge — nothing here is an edge until this system’s own graded record against the close says so'
  };

  /* Overachiever / underachiever views. Ranks, not ratings, because the two
     scales are different things. */
  var ACHIEVEMENT = {
    threshold_ranks: 25,
    basis: 'a team whose performance rank is at least twenty-five places better than its talent rank is OVERPERFORMING TALENT, and vice versa. It is a research view and it is never automatically a betting signal.'
  };

  /* Manual overrides: allowed for identity only, never for strength. */
  var OVERRIDES = {
    allowed_kinds: ['player_identity', 'team_mapping', 'eligibility', 'availability'],
    forbidden_kinds: ['team_strength', 'rank', 'rating', 'talent', 'performance'],
    required_fields: ['kind', 'target', 'reason', 'source', 'timestamp', 'operator'],
    basis: 'an override may fix WHO somebody is. It may never change HOW GOOD a team is. "The ranking looks wrong" is not a reason, it is a hypothesis, and the way to act on it is to fix the input or change a versioned weight.'
  };

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    VERSIONS: VERSIONS,
    OFFENSE_METRICS: OFFENSE_METRICS,
    DEFENSE_METRICS: DEFENSE_METRICS,
    SUB_UNITS: SUB_UNITS,
    NET: NET,
    OPPONENT: OPPONENT,
    RECENCY: RECENCY,
    NON_FBS: NON_FBS,
    PRIORS: PRIORS,
    CARRYOVER: CARRYOVER,
    TALENT: TALENT,
    ETSR: ETSR,
    RUN_DEFENCE_POWER: RUN_DEFENCE_POWER,
    CONFIDENCE: CONFIDENCE,
    GATES: GATES,
    GATE_THRESHOLDS: GATE_THRESHOLDS,
    RANKINGS: RANKINGS,
    RANK_MIN_CONFIDENCE: RANK_MIN_CONFIDENCE,
    RANK_MIN_CONFIDENCE_BASIS: RANK_MIN_CONFIDENCE_BASIS,
    MOVEMENT: MOVEMENT,
    STABILITY: STABILITY,
    ANOMALIES: ANOMALIES,
    ANOMALY_THRESHOLDS: ANOMALY_THRESHOLDS,
    MARKET: MARKET,
    ACHIEVEMENT: ACHIEVEMENT,
    OVERRIDES: OVERRIDES,
    gate: function (id) { for (var i = 0; i < GATES.length; i++) if (GATES[i].id === id) return GATES[i]; return null; }
  };
});
