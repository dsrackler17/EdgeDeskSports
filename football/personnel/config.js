/* ============================================================================
   EDGEDESK NON-QB PERSONNEL AVAILABILITY — VERSIONED CONFIGURATION.

   Every multiplier, probability, band and weight the injury-impact score uses
   lives HERE, under one version string. Nothing that changes a number may live
   in the scoring core, a build script, the desk or the page.

   EVERYTHING IN THIS FILE IS AN INITIAL PRIOR. None of it was fitted to game
   outcomes. The position leverages, the concentration table, the status
   probabilities and the normalisation scales are the starting values the
   brief set (or EdgeDesk extensions of them, marked as such), chosen so that
   the 0-100 score orders absences sensibly. They are subject to empirical
   calibration against frozen pregame residuals once enough history exists —
   see TRAINING below and football/personnel/README.md.

   THE SCORE IS NOT POINTS. `PROJECTION.adjustment_points` is 0 and the core
   does not read it: the scoring core hard-locks the projection adjustment to
   zero whatever this file says, so an edit here cannot move a line.

   Node (module.exports) and browser (window.EDPersonnelConfig).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  root.EDPersonnelConfig = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var VERSION = 'personnel_impact_v1';

  /* ------------------------------------------------------------------ *
   * THE PROJECTION CONTRACT                                             *
   * ------------------------------------------------------------------ */
  var PROJECTION = {
    adjustment_points: 0,
    coefficient_trained: false,
    points_per_impact: null,
    status: 'NOT_ENABLED',
    statement: 'Measurement only — coefficient not trained',
    basis: 'the injury-impact score is a structured measurement of how much worse a team is with the '
      + 'expected replacement playing. No coefficient converting it to points has been trained or '
      + 'validated, so it moves no projection anywhere in EdgeDesk. football/personnel/impact.js '
      + 'returns 0 for the projection adjustment unconditionally.'
  };

  /* ------------------------------------------------------------------ *
   * RATING SCALES                                                       *
   * Player quality is read on a declared scale. EPIR is the only scale   *
   * wired today (football/players). `replacement_level` is a property of *
   * the SCALE — EPIR is anchored so that 50 is positional replacement —  *
   * and is used only as the bound when a replacement's own quality is    *
   * unmeasured. It is never written into a player's quality field.       *
   * ------------------------------------------------------------------ */
  var RATING_SCALES = {
    EPIR: {
      min: 0, max: 100, sd: 12, replacement_level: 50,
      source: 'football/players EPIR (EdgeDesk Player Impact Rating)',
      basis: '0-100, 50 is positional replacement by construction, 12 points is one standard deviation '
        + 'of the position group’s own qualified population (football/players/README.md)'
    }
  };

  /* Quality bases the core accepts as a measurement. Anything else — a
     prior-only rating, a role guess, a recruiting grade alone — is carried as
     evidence and leaves player_quality null. */
  var QUALITY_BASES = {
    MEASURED_PRODUCTION: { accepted: true,
      basis: 'rating built from the player’s own attributed production, opponent-adjusted and shrunk' },
    NO_MEASURED_PRODUCTION: { accepted: false,
      basis: 'no production was measured for this player; a rating on file is the scale prior plus role '
        + 'and experience points, which is not a measurement of how well he plays' },
    NO_PLAYER_RATING_FEED: { accepted: false,
      basis: 'no player-quality feed is wired in for this league' }
  };

  /* ------------------------------------------------------------------ *
   * AVAILABILITY STATES                                                 *
   * p = probability_of_absence. It is kept beside impact_if_absent and   *
   * never merged into it silently. Probabilities match the status        *
   * scalars football/cfb_p4 already declares (out 1, doubtful .75,       *
   * questionable .5, probable .15) so the two layers read a designation  *
   * the same way. `clarity` is how much the designation itself resolves  *
   * (it feeds confidence, not impact).                                   *
   * ------------------------------------------------------------------ */
  var STATUS = {
    OUT:                { p: 1.00, clarity: 1.00, label: 'Out' },
    OUT_FIRST_HALF:     { p: 0.50, clarity: 0.90, label: 'Out (first half)',
      basis: 'half-game unavailability: half the game is played without him' },
    DOUBTFUL:           { p: 0.75, clarity: 0.85, label: 'Doubtful' },
    QUESTIONABLE:       { p: 0.50, clarity: 0.60, label: 'Questionable' },
    GAME_TIME_DECISION: { p: 0.50, clarity: 0.45, label: 'Game-time decision' },
    LIMITED:            { p: 0.35, clarity: 0.60, label: 'Limited',
      basis: 'expected to play on a limited role; 0.35 is the expected share of his normal participation '
        + 'lost, not a chance he misses the game' },
    PROBABLE:           { p: 0.15, clarity: 0.80, label: 'Probable' },
    EXPECTED:           { p: 0.15, clarity: 0.80, label: 'Expected to play' },
    UNKNOWN:            { p: null, clarity: 0.20, label: 'Unknown',
      basis: 'a source named the player without a designation; the probability is not known and is left '
        + 'null rather than guessed' },
    AVAILABLE:          { p: 0.00, clarity: 1.00, label: 'Available' }
  };
  var STATUS_ALIASES = {
    OUT: 'OUT', INACTIVE: 'OUT', SUSPENDED: 'OUT', IR: 'OUT', INJUREDRESERVE: 'OUT', PUP: 'OUT', NFI: 'OUT',
    OUTFORSEASON: 'OUT', OUTFORTHESEASON: 'OUT',
    OUTFIRSTHALF: 'OUT_FIRST_HALF', OUT1STHALF: 'OUT_FIRST_HALF',
    DOUBTFUL: 'DOUBTFUL',
    QUESTIONABLE: 'QUESTIONABLE', DAYTODAY: 'QUESTIONABLE',
    GAMETIMEDECISION: 'GAME_TIME_DECISION', GTD: 'GAME_TIME_DECISION',
    LIMITED: 'LIMITED',
    PROBABLE: 'PROBABLE',
    EXPECTED: 'EXPECTED', PROBABLEEXPECTED: 'PROBABLE',
    UNKNOWN: 'UNKNOWN',
    AVAILABLE: 'AVAILABLE', ACTIVE: 'AVAILABLE', CLEARED: 'AVAILABLE'
  };

  /* ------------------------------------------------------------------ *
   * USAGE                                                               *
   * usage_factor is 0-1. The bands are the brief’s; the basis says     *
   * what the number actually is, and a proxy costs confidence.           *
   * ------------------------------------------------------------------ */
  var USAGE = {
    bands: [
      { min: 0.90, label: 'Nearly every snap / central player' },
      { min: 0.70, label: 'Major starter' },
      { min: 0.50, label: 'Rotational starter' },
      { min: 0.25, label: 'Important rotation' },
      { min: 0.00, label: 'Limited role' }
    ],
    bases: {
      SNAP_SHARE:          { confidence: 1.00, basis: 'share of the team’s snaps he played' },
      ROUTE_PARTICIPATION: { confidence: 1.00, basis: 'share of dropbacks on which he ran a route' },
      PARTICIPATION_SHARE: { confidence: 0.60,
        basis: 'EdgeDesk participation estimate (box-score appearances + touch share). NOT a snap share, '
          + 'and every record says so' },
      TOUCH_SHARE:         { confidence: 0.50, basis: 'share of his group’s touches; a volume proxy' }
    }
  };

  /* ------------------------------------------------------------------ *
   * POSITIONS                                                           *
   * Canonical slots, the unit each belongs to, the brief’s leverage     *
   * range with the point prior used (the midpoint), and the measurable   *
   * matchup drivers read from the OPPONENT’s published unit metrics.    *
   * Leverage is a relative-importance multiplier inside the score. It is *
   * NOT a point value.                                                   *
   *                                                                     *
   * `resolved:false` slots are a roster spelling that does not say which *
   * of two slots the player occupies (a college roster lists "OL", not  *
   * LT or RG). They take a range spanning both and cost confidence.      *
   * Entries marked `extension` are EdgeDesk additions the brief did not  *
   * specify; they sit below the primary slot they sit beside.            *
   *                                                                     *
   * Matchup drivers: `metric` is an id the adapter supplies from the     *
   * opponent’s published unit metrics, where a z above zero is BETTER   *
   * FOR THE OPPONENT’S UNIT (football/matchup/metrics.json convention). *
   * `sign` +1 means a better opponent unit raises this absence’s        *
   * leverage; -1 means a WEAKER opponent unit raises it (a WR1 is worth  *
   * more against a secondary he would have exploited).                  *
   * ------------------------------------------------------------------ */
  var POSITIONS = {
    OT:   { unit: 'OFFENSIVE_LINE', label: 'OT', leverage: { range: [1.20, 1.40], prior: 1.30 },
      matchup: [{ metric: 'def_sack_rate', sign: 1, w: 1 }],
      matchup_basis: 'a tackle is protection first: the opponent’s measured pass rush (sack rate generated)' },
    IOL:  { unit: 'OFFENSIVE_LINE', label: 'IOL', leverage: { range: [1.00, 1.20], prior: 1.10 },
      matchup: [{ metric: 'def_stuff_rate', sign: 1, w: 0.5 }, { metric: 'def_sack_rate', sign: 1, w: 0.5 }],
      matchup_basis: 'interior line: the opponent’s run stuffing and pass rush, equally' },
    OL:   { unit: 'OFFENSIVE_LINE', label: 'OL', resolved: false, leverage: { range: [1.00, 1.40], prior: 1.20 },
      matchup: [{ metric: 'def_sack_rate', sign: 1, w: 0.6 }, { metric: 'def_stuff_rate', sign: 1, w: 0.4 }],
      matchup_basis: 'lineman whose slot the roster does not name: tackle and interior drivers blended' },
    EDGE: { unit: 'DEFENSIVE_FRONT', label: 'EDGE', leverage: { range: [1.15, 1.35], prior: 1.25 },
      matchup: [{ metric: 'sack_rate_allowed', sign: -1, w: 1 }],
      matchup_basis: 'the opponent’s pass protection: an edge rusher is missed most against a line he would have beaten' },
    DT:   { unit: 'DEFENSIVE_FRONT', label: 'DT', leverage: { range: [1.00, 1.20], prior: 1.10 },
      matchup: [{ metric: 'run_offense', sign: 1, w: 1 }],
      matchup_basis: 'the opponent’s measured rushing offense' },
    DL:   { unit: 'DEFENSIVE_FRONT', label: 'DL', resolved: false, leverage: { range: [1.00, 1.35], prior: 1.15 },
      matchup: [{ metric: 'run_offense', sign: 1, w: 0.5 }, { metric: 'sack_rate_allowed', sign: -1, w: 0.5 }],
      matchup_basis: 'lineman whose slot the roster does not name: interior and edge drivers blended' },
    LB:   { unit: 'LINEBACKERS', label: 'LB', leverage: { range: [0.90, 1.10], prior: 1.00 },
      matchup: [{ metric: 'run_offense', sign: 1, w: 1 }],
      matchup_basis: 'the opponent’s measured rushing offense' },
    OLB:  { unit: 'LINEBACKERS', label: 'OLB', resolved: false, leverage: { range: [0.90, 1.35], prior: 1.10 },
      matchup: [{ metric: 'run_offense', sign: 1, w: 0.5 }, { metric: 'sack_rate_allowed', sign: -1, w: 0.5 }],
      matchup_basis: 'an outside linebacker is an edge rusher in some fronts and off-ball in others: both drivers blended' },
    CB1:  { unit: 'SECONDARY', label: 'CB', leverage: { range: [1.10, 1.30], prior: 1.20 },
      matchup: [{ metric: 'pass_offense', sign: 1, w: 1 }],
      matchup_basis: 'the opponent’s measured passing offense' },
    CB:   { unit: 'SECONDARY', label: 'CB', extension: true, leverage: { range: [1.00, 1.15], prior: 1.05 },
      matchup: [{ metric: 'pass_offense', sign: 1, w: 1 }],
      matchup_basis: 'the opponent’s measured passing offense' },
    S:    { unit: 'SECONDARY', label: 'S', leverage: { range: [0.85, 1.05], prior: 0.95 },
      matchup: [{ metric: 'explosive_pass_rate', sign: 1, w: 1 }],
      matchup_basis: 'the opponent’s explosive passing rate' },
    DB:   { unit: 'SECONDARY', label: 'DB', resolved: false, leverage: { range: [0.85, 1.30], prior: 1.05 },
      matchup: [{ metric: 'pass_offense', sign: 1, w: 1 }],
      matchup_basis: 'defensive back whose slot the roster does not name: the opponent’s passing offense' },
    WR1:  { unit: 'RECEIVING', label: 'WR', leverage: { range: [1.05, 1.25], prior: 1.15 },
      matchup: [{ metric: 'pass_defense', sign: -1, w: 1 }],
      matchup_basis: 'the opponent’s pass defense: a weak secondary raises what the primary receiver was worth' },
    WR:   { unit: 'RECEIVING', label: 'WR', extension: true, leverage: { range: [0.90, 1.05], prior: 0.975 },
      matchup: [{ metric: 'pass_defense', sign: -1, w: 1 }],
      matchup_basis: 'the opponent’s pass defense' },
    TE:   { unit: 'RECEIVING', label: 'TE', leverage: { range: [0.85, 1.10], prior: 0.975 },
      matchup: [{ metric: 'pass_defense', sign: -1, w: 1 }],
      matchup_basis: 'the opponent’s pass defense' },
    RB:   { unit: 'BACKFIELD', label: 'RB', leverage: { range: [0.70, 0.95], prior: 0.825 },
      matchup: [{ metric: 'run_defense', sign: -1, w: 1 }],
      matchup_basis: 'the opponent’s run defense: a weak one raises what the lead back was worth' },
    K:    { unit: 'SPECIALISTS', label: 'K', leverage: { range: [0.40, 0.80], prior: 0.60 }, matchup: [],
      matchup_basis: 'no measurable opponent driver for a kicker; matchup leverage is not applicable' },
    P:    { unit: 'SPECIALISTS', label: 'P', leverage: { range: [0.40, 0.80], prior: 0.60 }, matchup: [],
      matchup_basis: 'no measurable opponent driver for a punter; matchup leverage is not applicable' },
    LS:   { unit: 'SPECIALISTS', label: 'LS', extension: true, leverage: { range: [0.40, 0.80], prior: 0.60 }, matchup: [],
      matchup_basis: 'no measurable opponent driver for a long snapper; matchup leverage is not applicable' }
  };

  /* raw roster / report spellings -> base slot (before WR1/CB1 resolution) */
  var POSITION_ALIASES = {
    OT: 'OT', T: 'OT', LT: 'OT', RT: 'OT',
    G: 'IOL', OG: 'IOL', LG: 'IOL', RG: 'IOL', C: 'IOL', OC: 'IOL', IOL: 'IOL',
    OL: 'OL',
    EDGE: 'EDGE', DE: 'EDGE', RUSH: 'EDGE',
    DT: 'DT', NT: 'DT', IDL: 'DT',
    DL: 'DL',
    LB: 'LB', ILB: 'LB', MLB: 'LB', WLB: 'LB', SLB: 'LB',
    OLB: 'OLB',
    CB: 'CB', NB: 'CB', NICKEL: 'CB',
    S: 'S', FS: 'S', SS: 'S', SAF: 'S',
    DB: 'DB',
    WR: 'WR', SE: 'WR', FL: 'WR', SLOT: 'WR',
    TE: 'TE',
    RB: 'RB', HB: 'RB', TB: 'RB', FB: 'RB',
    K: 'K', PK: 'K', P: 'P', LS: 'LS',
    QB: 'QB'
  };
  /* the base slots that have a primary variant, taken by depth rank 1 */
  var PRIMARY_SLOT = { WR: 'WR1', CB: 'CB1' };

  var UNITS = {
    OFFENSIVE_LINE:  { label: 'Offensive line' },
    RECEIVING:       { label: 'Receivers' },
    BACKFIELD:       { label: 'Backfield' },
    DEFENSIVE_FRONT: { label: 'Defensive front' },
    LINEBACKERS:     { label: 'Linebackers' },
    SECONDARY:       { label: 'Secondary' },
    SPECIALISTS:     { label: 'Specialists' }
  };

  /* The quarterback is priced elsewhere: football/cfb_p4 params.injury carries
     a trained primary-QB absence coefficient and football/starters resolves
     who plays. Scoring him here too would count one absence twice. */
  var EXCLUDED_POSITIONS = {
    QB: 'the quarterback is priced by the trained QB layer and the starter layer; this system is non-QB '
      + 'by design, so scoring him here would double-count the absence'
  };

  /* ------------------------------------------------------------------ *
   * MATCHUP LEVERAGE                                                    *
   * leverage = clamp(1 + slope * sum(w * sign * z) / sum(w), range)      *
   * z is capped before combining so one extreme metric cannot pin the    *
   * range on its own. Missing drivers leave the field NULL and the core  *
   * applies no matchup multiplier (the identity), at a confidence cost.  *
   * ------------------------------------------------------------------ */
  var MATCHUP = {
    range: [0.75, 1.25],
    slope_per_sd: 0.10,
    z_cap: 2.5,
    basis: 'measured opponent unit metrics only (opponent-adjusted z against the league). No reputation, '
      + 'no ranking, no name. A 1 SD stronger opposing unit moves leverage by 0.10.'
  };

  /* ------------------------------------------------------------------ *
   * UNIT CONCENTRATION                                                  *
   * The count for one absence is 1 + the sum of the OTHER same-unit      *
   * absences’ probability_of_absence, so two questionable guards count  *
   * as one more expected absence, not two. Integer counts reproduce the  *
   * table; fractional counts interpolate linearly; 4+ caps. The          *
   * multiplier is applied once per absence, so a unit’s summed raw       *
   * impact is scaled by the table value — it never compounds.            *
   * ------------------------------------------------------------------ */
  var CONCENTRATION = {
    table: [
      { count: 1, multiplier: 1.00 },
      { count: 2, multiplier: 1.08 },
      { count: 3, multiplier: 1.18 },
      { count: 4, multiplier: 1.30 }
    ],
    basis: 'multiple absences in one unit are nonlinear: continuity and communication break down faster '
      + 'than the sum of the individual losses. Initial priors; overlapping replacements are handled '
      + 'separately by the replacement chain (a second absence is replaced from deeper on the depth chart).'
  };

  /* ------------------------------------------------------------------ *
   * REPLACEMENT                                                         *
   * The likely replacement is the highest-ordered player in the same     *
   * depth group below the starting slots (or below the absent player, if *
   * he is himself depth) who is not absent and not already replacing     *
   * someone else. The ordering’s basis sets the identification         *
   * confidence.                                                          *
   * ------------------------------------------------------------------ */
  var REPLACEMENT = {
    starter_slots: { OL: 5, OT: 2, IOL: 3, DL: 4, EDGE: 2, DT: 2, LB: 3, OLB: 2, CB: 2, S: 2, DB: 4,
      WR: 3, TE: 1, RB: 1, K: 1, P: 1, LS: 1 },
    basis_confidence: {
      SUPPLIED: 0.85,
      DEPTH_CHART: 0.85,
      ROSTER_PARTICIPATION_RANK: 0.55,
      ROSTER_RATING_RANK: 0.35
    },
    /* a candidate whose own probability of absence is at least this cannot
       be the replacement */
    blocking_probability: 0.50,
    /* identification confidence is scaled by this when the candidate has no
       measured usage of his own */
    unmeasured_candidate_factor: 0.75,
    /* When the replacement is unknown, or his quality is unmeasured, the gap
       is taken against the SCALE’s declared replacement level and
       replacement_quality stays null. 'NULL' would leave the gap and the
       impact null instead. */
    unknown_gap_policy: 'SCALE_REPLACEMENT_LEVEL'
  };

  /* ------------------------------------------------------------------ *
   * NORMALISATION                                                       *
   * raw = max(0, gap / scale_sd) * usage * position * matchup * concentration
   * score = round(100 * (1 - exp(-raw / scale)))                         *
   * Saturating, monotonic, never clipped. The team scale is wider: one   *
   * severe absence is a High team exposure, not a Severe one.            *
   * ------------------------------------------------------------------ */
  var NORMALIZATION = {
    player: { scale: 2.5 },
    unit: { scale: 2.5 },
    team: { scale: 4.0 },
    method: '100 * (1 - exp(-raw / scale))',
    basis: 'raw is in standard deviations of player quality, weighted; the scales are initial priors chosen '
      + 'so a one-SD drop at full usage and neutral leverage lands in Low-Moderate'
  };

  var CLASSIFICATION = [
    { min: 80, label: 'Severe' },
    { min: 60, label: 'High' },
    { min: 40, label: 'Moderate' },
    { min: 20, label: 'Low' },
    { min: 0, label: 'Minimal' }
  ];

  /* ------------------------------------------------------------------ *
   * CONFIDENCE (0-100)                                                  *
   * A weighted sum over the six things that can be missing. Missing      *
   * evidence scores zero on its dimension; nothing is filled.            *
   * ------------------------------------------------------------------ */
  var CONFIDENCE = {
    weights: { status: 0.20, player_quality: 0.25, replacement: 0.25, usage: 0.15, matchup: 0.10, position: 0.05 },
    source_tier: { 1: 1.00, 2: 0.75, 3: 0.50 },
    source_tier_unknown: 0.40,
    freshness: { LIVE: 1.00, CURRENT: 1.00, AGING: 0.85, STALE: 0.50, HISTORICAL: 0.00 },
    unresolved_position: 0.50,
    /* replacement dimension when the replacement is identified but his quality is unmeasured */
    replacement_unmeasured: 0.35,
    team: {
      coverage_grade: { OFFICIAL: 1.00, STRONG: 0.85, PARTIAL: 0.60, LIMITED: 0.30, NONE: 0.20 },
      /* a graded read listing nobody is not proof of health unless it was a comprehensive filing */
      no_absences_comprehensive: 0.90,
      no_absences_partial: 0.45,
      unrated_penalty: 0.50
    },
    basis: 'confidence falls when the replacement is unknown, the depth order is inferred, the designation '
      + 'is uncertain, player metrics are unavailable, usage is a proxy or missing, or the source is weak'
  };

  var TEAM = {
    unit_concern: {
      high: { expected_count: 3, impact: 60 },
      moderate: { expected_count: 2, impact: 40 }
    },
    key_losses: 3,
    basis: 'team impact aggregates the rated absences’ expected raw impact (raw x probability) and '
      + 'normalises it on the team scale; unrated absences are listed, never scored as zero'
  };

  var COMPARISON = {
    material_difference: 15,
    min_confidence: 40,
    basis: 'a difference is called material only when it is at least 15 points on the 0-100 scale and both '
      + 'sides were assessed at 40% confidence or better'
  };

  /* ------------------------------------------------------------------ *
   * TRAINING — what has to exist before any coefficient is fitted.      *
   * Estimates, stated with their assumptions; see README.md.             *
   * ------------------------------------------------------------------ */
  var TRAINING = {
    target: 'actual_margin - frozen_pregame_projected_margin (home perspective)',
    features: ['team impact differential', 'position', 'replacement_gap', 'matchup_leverage',
      'unit_concentration', 'probability_of_absence'],
    first_coefficient: 'one pooled coefficient on the home-minus-away expected impact differential',
    minimum_games: { cfb: 3600, nfl: 2400 },
    minimum_basis: 'n >= (sigma / (sd_x * beta / 2.8))^2: detecting 0.5 points per 10 impact points '
      + '(beta) with residual SD sigma ~16 CFB / ~13 NFL (1.25 x the published model MAE) and an '
      + 'impact-differential SD of ~15 (sd_x = 1.5 in tens) at 80% power, alpha 0.05 two-sided, counting '
      + 'only games where BOTH sides had a graded availability read frozen before kickoff',
    minimum_seasons: { train: 2, holdout: 2 },
    promotion_bar: ['lower pooled holdout margin MAE than the frozen projection',
      'paired test over per-game absolute errors at p < 0.05',
      'lower MAE in every holdout season separately'],
    per_position: 'per-position coefficients need roughly 300+ graded absences of Moderate impact or above '
      + 'per position group before they are estimable; they come after the pooled coefficient, not before'
  };

  return {
    VERSION: VERSION,
    PROJECTION: PROJECTION,
    RATING_SCALES: RATING_SCALES,
    QUALITY_BASES: QUALITY_BASES,
    STATUS: STATUS,
    STATUS_ALIASES: STATUS_ALIASES,
    USAGE: USAGE,
    POSITIONS: POSITIONS,
    POSITION_ALIASES: POSITION_ALIASES,
    PRIMARY_SLOT: PRIMARY_SLOT,
    UNITS: UNITS,
    EXCLUDED_POSITIONS: EXCLUDED_POSITIONS,
    MATCHUP: MATCHUP,
    CONCENTRATION: CONCENTRATION,
    REPLACEMENT: REPLACEMENT,
    NORMALIZATION: NORMALIZATION,
    CLASSIFICATION: CLASSIFICATION,
    CONFIDENCE: CONFIDENCE,
    TEAM: TEAM,
    COMPARISON: COMPARISON,
    TRAINING: TRAINING
  };
});
