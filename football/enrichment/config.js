/* ============================================================================
   EdgeDesk FOOTBALL DATA ENRICHMENT — every rule in one place.

   The enrichment layer exists to make EdgeDesk KNOW MORE before it scores how
   much it trusts a projection. It never moves a projection: nothing in this
   directory is read by the engine, the input contract or the pricing request
   (tools/football/page_build_parity.test.js holds that line). It feeds
   lib/cfb_reliability.js, the research card and the diagnostics only.

   Every threshold below is named, and says where it comes from. A number that
   is this layer's own choice says so; a number read from another layer names
   that layer. Nothing here was tuned to raise a reliability score.

   Node and browser (UMD), so the board and the build read the same rules.
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.EDEnrichmentConfig = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var C = { version: 'enrichment_config/1' };

  /* ------------------------------------------------ availability vocabulary
     The ten states every availability record is normalized into. UNKNOWN is a
     state, not an absence of one, and it is NEVER read as AVAILABLE. */
  C.STATUS = ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'SEASON_OUT',
    'SUSPENDED', 'TRANSFERRED', 'NOT_WITH_TEAM', 'UNKNOWN'];
  /* the probability the player does NOT play, per state. Read from the
     personnel impact layer (football/personnel/config.js STATUS) where it
     defines one; the four roster-departure states are certain absences.
     UNKNOWN has no probability: it is not 0 and it is not 0.5. */
  C.P_ABSENT = { AVAILABLE: 0, PROBABLE: 0.15, QUESTIONABLE: 0.5, DOUBTFUL: 0.75, OUT: 1,
    SEASON_OUT: 1, SUSPENDED: 1, TRANSFERRED: 1, NOT_WITH_TEAM: 1, UNKNOWN: null };
  /* the states that mean "will not play in this game" */
  C.ABSENT = ['OUT', 'SEASON_OUT', 'SUSPENDED', 'TRANSFERRED', 'NOT_WITH_TEAM'];
  /* the states that are a designation of doubt, known but unresolved */
  C.DOUBT = ['PROBABLE', 'QUESTIONABLE', 'DOUBTFUL'];

  /* ------------------------------------------------------- source types
     Five kinds of availability source, and the one a person supplies. The
     tier is the availability hierarchy: a lower number outranks a higher one
     for the same player, whatever the timestamps say, UNLESS the higher-tier
     record is stale (then the fresher lower-tier one is used and the conflict
     is published). */
  C.SOURCE_TYPES = {
    MANUAL_VERIFIED_OVERRIDE: { tier: 0, label: 'manual verified override', weight: 1.0 },
    PRIMARY_STRUCTURED: { tier: 1, label: 'official conference availability report', weight: 1.0 },
    TEAM_OFFICIAL: { tier: 1, label: 'official team release', weight: 1.0 },
    NEWS_REPORTING: { tier: 2, label: 'trusted beat reporting', weight: 0.7 },
    SECONDARY_STRUCTURED: { tier: 3, label: 'structured sports-data provider', weight: 0.5 },
    DERIVED_PARTICIPATION: { tier: 4, label: 'derived from game participation (inference)', weight: 0.25 }
  };

  /* ---------------------------------------------------- QB evidence tiers
     The quarterback hierarchy (configurable). Tier 5 never overrides fresh
     Tier 1; within a tier the fresher item wins only when both are fresh.
     `sub` orders two kinds inside one tier: an OBSERVED start outranks
     EdgeDesk's own quality ranking, which is an inference about who is
     better, not evidence about who starts. */
  C.QB_TIERS = {
    OFFICIAL_ANNOUNCEMENT: { tier: 1, sub: 0, label: 'official team announcement' },
    OFFICIAL_DEPTH_CHART: { tier: 1, sub: 1, label: 'official depth chart' },
    COACH_ANNOUNCEMENT: { tier: 1, sub: 0, label: 'coach announcement' },
    BEAT_REPORT: { tier: 2, sub: 0, label: 'trusted beat reporting' },
    CONFERENCE_REPORT: { tier: 2, sub: 1, label: 'conference/team availability report' },
    PROVIDER_DEPTH_CHART: { tier: 3, sub: 0, label: 'major sports-data provider depth chart' },
    AGGREGATOR_DEPTH_CHART: { tier: 4, sub: 0, label: 'depth-chart aggregator' },
    PREVIOUS_GAME_START: { tier: 5, sub: 0, label: 'observed start in the previous game (inference)' },
    MODEL_PROJECTION: { tier: 5, sub: 1, label: 'EdgeDesk player-quality ranking (inference, not a source)' }
  };
  /* the weight each tier carries in the source-agreement measure (how much
     of the evidence on file names the resolved starter). This layer's own
     choice: halving per tier from official to provider, a model inference
     counted at half an observed start */
  C.QB_TIER_WEIGHT = { 1: 1.0, 2: 0.7, 3: 0.5, 4: 0.35, 5: 0.25 };
  C.QB_MODEL_WEIGHT_FACTOR = 0.5;
  /* how long each kind stays fresh, in hours (the starters layer's own
     staleness rules, football/starters/starters.js STALE: reports 96h, depth
     charts 168h, usage two weeks) */
  C.QB_FRESH_HOURS = { OFFICIAL_ANNOUNCEMENT: 96, COACH_ANNOUNCEMENT: 96, OFFICIAL_DEPTH_CHART: 168,
    BEAT_REPORT: 96, CONFERENCE_REPORT: 96, PROVIDER_DEPTH_CHART: 168, AGGREGATOR_DEPTH_CHART: 168,
    PREVIOUS_GAME_START: 336, MODEL_PROJECTION: 336 };
  /* an observed start resolves a disagreement with EdgeDesk's own quality
     ranking ONLY when the start was decisive: the opener took at least the
     "clear" share band of football/starters/persistence.json (0.65 of the
     dropbacks), whose calibrated hold rate is 0.767 or better */
  C.QB_DECISIVE_SHARE = 0.65;
  C.CONFIRMATION = ['CONFIRMED', 'STRONGLY_EXPECTED', 'EXPECTED', 'UNCERTAIN', 'CONFLICTED', 'UNKNOWN'];

  /* ----------------------------------------------------- provider health */
  /* NOT_CHECKED: an offline run did not call it and holds no earlier check;
     a provider nobody asked is not a provider that is down */
  C.HEALTH = ['HEALTHY', 'DEGRADED', 'RATE_LIMITED', 'AUTH_FAILURE', 'DOWN', 'STALE', 'NOT_CONFIGURED', 'NOT_CHECKED'];
  /* how much of a provider's evidence survives each state when certainty is
     reduced proportionally. STALE evidence is carried, not trusted as fresh */
  C.HEALTH_CERTAINTY = { HEALTHY: 1, DEGRADED: null /* 1 - failed share */, STALE: 0.5,
    RATE_LIMITED: 0, AUTH_FAILURE: 0, DOWN: 0, NOT_CONFIGURED: 0, NOT_CHECKED: 0 };

  /* ------------------------------------------------------ evidence cache
     TTL: how long a value stays FRESH. max_carry: how long a last-known value
     may still be carried (marked STALE) when a refresh fails. Past max_carry
     it is dropped as HISTORICAL — yesterday's injury report is evidence,
     last month's is not. Hours. */
  C.CACHE = {
    injuries: { ttl: 12, max_carry: 96 },
    qb_status: { ttl: 24, max_carry: 168 },
    depth_chart: { ttl: 72, max_carry: 336 },
    roster: { ttl: 168, max_carry: 720 },
    team_stats: { ttl: 24, max_carry: 168 },
    power_ratings: { ttl: 24, max_carry: 168 },
    weather: { ttl: 6, max_carry: 24 },
    market: { ttl: 1, max_carry: 24 },
    fcs_results: { ttl: 24, max_carry: 2160 },
    fcs_ratings: { ttl: 168, max_carry: 2160 },
    provider_health: { ttl: 6, max_carry: 168 }
  };

  /* ------------------------------------------------- refresh windows
     QB and availability certainty change fastest approaching kickoff. The
     window is chosen by hours to kickoff; every kind has its own cadence in
     each window (minutes between refreshes). null = do not call the provider
     in this window at all (a game weeks away does not need its forecast). */
  C.WINDOWS = [
    { key: 'FROZEN', max: 0, priority: 0, label: 'after kickoff — the pregame ledger is frozen' },
    { key: 'FINAL', max: 1.5, priority: 5, label: 'final starter/inactive confirmation pass (under 90 minutes)' },
    { key: 'VERY_HIGH', max: 6, priority: 4, label: 'under 6 hours' },
    { key: 'HIGH', max: 24, priority: 3, label: '6-24 hours' },
    { key: 'ELEVATED', max: 72, priority: 2, label: '24-72 hours' },
    { key: 'NORMAL', max: 1e9, priority: 1, label: 'more than 72 hours' }
  ];
  C.CADENCE = {
    /*                 NORMAL ELEVATED HIGH VERY_HIGH FINAL   horizon (days) */
    injuries:      { NORMAL: 1440, ELEVATED: 360, HIGH: 120, VERY_HIGH: 60, FINAL: 20, horizon_days: 8 },
    qb_status:     { NORMAL: 1440, ELEVATED: 360, HIGH: 120, VERY_HIGH: 60, FINAL: 20, horizon_days: 10 },
    depth_chart:   { NORMAL: 4320, ELEVATED: 1440, HIGH: 720, VERY_HIGH: 360, FINAL: 60, horizon_days: 10 },
    weather:       { NORMAL: null, ELEVATED: 720, HIGH: 180, VERY_HIGH: 60, FINAL: 30, horizon_days: 7 },
    market:        { NORMAL: 360, ELEVATED: 120, HIGH: 60, VERY_HIGH: 30, FINAL: 15, horizon_days: 14 },
    team_stats:    { NORMAL: 1440, ELEVATED: 1440, HIGH: 1440, VERY_HIGH: 1440, FINAL: 1440, horizon_days: 30 },
    power_ratings: { NORMAL: 1440, ELEVATED: 1440, HIGH: 1440, VERY_HIGH: 1440, FINAL: 1440, horizon_days: 30 },
    roster:        { NORMAL: 10080, ELEVATED: 4320, HIGH: 4320, VERY_HIGH: 4320, FINAL: 4320, horizon_days: 30 },
    fcs_results:   { NORMAL: 1440, ELEVATED: 1440, HIGH: 1440, VERY_HIGH: 1440, FINAL: 1440, horizon_days: 30 }
  };

  /* ------------------------------------ availability coverage scale (0..1)
     ONE interpretation of what an availability read is worth, so no other
     part of the codebase invents its own. The values reproduce exactly what
     lib/cfb_reliability.js v2 already paid for each contract state (its
     coverage half of the non-QB item, out of 1.5), so identical evidence is
     scored identically; only NEW evidence classes earn new credit. */
  C.AVAIL_COVERAGE = {
    COMPREHENSIVE_OFFICIAL: 1.0,      /* 1.5 / 1.5  a comprehensive official report for this fixture */
    OFFICIAL_THIS_GAME: 1.25 / 1.5,   /* an official report for this fixture that is not comprehensive */
    MULTI_SOURCE_CURRENT: 1.0 / 1.5,  /* two or more independent current sources, none official */
    OFFICIAL_ABSENCE_ONLY: 1.0 / 1.5, /* RESEARCH_ONLY: an official read that lists absences only */
    STRUCTURED_CURRENT: 1.0 / 1.5,    /* one current structured read (USABLE, not comprehensive) */
    NOT_DUE_YET: 0.75 / 1.5,
    STALE_CARRIED: 0.5 / 1.5,
    NOT_REQUIRED: 0.5 / 1.5,
    PROVIDER_FAILED: 0,
    NO_SOURCE: 0,
    NOT_APPLICABLE: null
  };

  /* --------------------------------------------- player impact categories
     absence_importance_score (0-100) answers "how much does this role
     matter", from what is known WITHOUT a quality rating: position
     leverage (football/personnel/config.js POSITIONS priors), whether the
     player is a projected starter, and his usage share. The category is read
     off it. Impact (how much WORSE the replacement is) needs a rating; with
     none, impact_status is UNKNOWN — never zero. */
  C.IMPORTANCE = [
    { key: 'CRITICAL', min: 70 }, { key: 'MAJOR', min: 50 }, { key: 'MEANINGFUL', min: 30 },
    { key: 'MINOR', min: 15 }, { key: 'DEPTH', min: 0 }
  ];
  /* position leverage, the personnel layer's priors (config.js POSITIONS),
     normalized so the most leveraged non-QB slot (OT 1.30) reads 100 */
  C.POSITION_LEVERAGE = { OT: 1.30, IOL: 1.10, OL: 1.20, EDGE: 1.25, DT: 1.10, DL: 1.15, LB: 1.00, OLB: 1.10,
    CB: 1.20, S: 0.95, DB: 1.05, WR: 1.15, TE: 0.975, RB: 0.825, K: 0.60, P: 0.60, LS: 0.60, QB: 2.0 };
  C.LEVERAGE_MAX = 1.30;
  /* role multipliers: a projected starter carries his full leverage; a
     rotation player the share of snaps a rotation role implies */
  C.ROLE_FACTOR = { STARTER: 1.0, 'HEAVY ROTATION': 0.75, ROTATION: 0.5, DEPTH: 0.2, UNKNOWN: 0.35 };
  /* the canonical formation projected starters are counted against. The
     units layer's own starter counts disagree with the personnel layer's
     (DL 2 vs 4, CB 3 vs 2); a 4-3-4 / 11-personnel base is used for both
     sides so coverage is comparable across teams */
  C.FORMATION = {
    offense: [['QB', 1], ['RB', 1], ['WR', 3], ['TE', 1], ['OL', 5]],
    defense: [['FRONT', 4], ['LB', 3], ['SECONDARY', 4]],
    special: [['K', 1], ['P', 1]]
  };
  C.FRONT_GROUPS = ['EDGE', 'DL'];
  C.SECONDARY_GROUPS = ['CB', 'S', 'DB'];
  /* key contributors: projected starters plus anyone whose projected role
     is STARTER or HEAVY ROTATION */
  C.KEY_ROLES = ['STARTER', 'HEAVY ROTATION'];

  /* -------------------------------------------------------- FCS bridge
     Engine constants are READ (football/cfb_p4/params.js hyperparams): the
     margin cap (35), home field (3.2), season carry (0.75) and the FCS floor
     (-28). The game-level noise is estimated from the data. */
  C.FCS = {
    /* STRONG: a real rating of this team, on EdgeDesk's scale, tight enough
       that its own 1-SD is inside the MODERATE stability band's edge
       (lib/cfb_reliability.js stability tiers: 4.0 pts) plus one field goal
       of slack is NOT granted — the edge is used as is */
    strong_sd: 4.0, moderate_sd: 6.0,
    strong_min_games: 8, strong_min_bridge: 1,
    /* the priced floor is CORROBORATED when it sits inside one of the
       team's own standard deviations of the bridged rating */
    corroborate_sd: 1.0,
    seasons_back: 1,
    min_team_games: 3
  };

  /* ------------------------------------------------------ market quality
     lib/market_consensus.js CONFIG is the single home of the market-quality
     rules, because the board computes the consensus live from the same
     library; nothing is duplicated here. */

  /* --------------------------------------------- enrichment ROI costs
     Implementation/data cost of recovering each bottleneck family, 1 (a
     configuration change) to 5 (a new licensed feed or a research project).
     This layer's own engineering estimate, published with its reason so it
     can be argued with. `feasible` is the share of the currently lost points
     a realistic integration could recover. */
  C.ROI = {
    availability: { cost: 3, feasible: 0.6, label: 'Availability feed',
      how: 'official conference reports cover conference games in the SEC, Big Ten, ACC and Big 12; the rest need a structured injury feed or team releases',
      recover: 'games whose availability read is missing, refused or not comprehensive' },
    qb_status: { cost: 2, feasible: 0.7, label: 'QB status (can he play)',
      how: 'the same availability read, matched to the resolved starter; a comprehensive official report clears him',
      recover: 'resolved starters with no statement about their fitness' },
    qb_identity: { cost: 3, feasible: 0.5, label: 'QB confirmation',
      how: 'official announcements, a provider depth chart, or trusted beat reporting above the observed previous start',
      recover: 'starters resolved only from the previous game' },
    qb_conflict: { cost: 2, feasible: 0.8, label: 'QB conflicts',
      how: 'the source hierarchy resolves a disagreement when the evidence permits; an independent source settles the rest',
      recover: 'sides whose starter evidence disagrees' },
    fcs_rating: { cost: 3, feasible: 0.5, label: 'FCS ratings',
      how: 'the bridge rates FCS teams on EdgeDesk’s scale; FCS-vs-FCS results tighten it; pricing on it is a promotion decision',
      recover: 'FCS opponents priced from the shared floor' },
    attribution: { cost: 4, feasible: 0.3, label: 'Player-quality gaps',
      how: 'measured production for linemen needs charting data no public feed carries',
      recover: 'absent starters with no measured player quality' },
    market_sources: { cost: 1, feasible: 0.9, label: 'Market-source depth',
      how: 'every provider cfb.lines already returns, instead of one',
      recover: 'games priced against one book' },
    market_quote: { cost: 1, feasible: 0.9, label: 'Market quote freshness',
      how: 'the capture cadence tightens approaching kickoff', recover: 'games whose quote is stale or missing' },
    stability: { cost: 5, feasible: 0.1, label: 'Projection stability',
      how: 'dispersion is the engine’s own uncertainty; it shrinks as in-season samples grow, not through data integration',
      recover: 'little: this is model uncertainty, not missing data' },
    rating_sample: { cost: 5, feasible: 0.0, label: 'In-season rating sample',
      how: 'only more games played shrink it', recover: 'nothing a feed can supply' },
    starters: { cost: 1, feasible: 0.9, label: 'Starter evidence staleness',
      how: 'the starter job re-reads on the refresh windows', recover: 'stale starter records' },
    matchup_profile: { cost: 4, feasible: 0.3, label: 'Matchup profile (FCS side)',
      how: 'play-level data for FCS teams', recover: 'FBS-vs-FCS games' }
  };

  /* a shallow override for tests and what-if runs; the shipped object is
     never mutated */
  C.config = function (over) {
    if (!over) return C;
    var o = {}, k;
    for (k in C) if (Object.prototype.hasOwnProperty.call(C, k)) o[k] = C[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k];
    return o;
  };
  return C;
});
