/* ============================================================================
   WHAT THE PROVIDER'S EPA ACTUALLY IS — the semantic audit, as data.

   WHY THIS FILE EXISTS AND WHY IT IS NOT A COMMENT. The engine's college QB
   layer prices `epa_per_dropback`:

       valPts = params.qb.points_per_epa_db * shrunk_epa_per_dropback

   and a per-game EPA series now exists for college football. The tempting
   move is to divide EPA by attempts+sacks, watch it agree with the published
   rounded rate, and wire it into that input. Numerical agreement on a
   denominator is evidence about ONE of the four things that have to match,
   and the other three do not.

   So this file records what was actually established about the provider's
   series, with the evidence for each finding, and exposes ONE verdict the
   rest of the repository reads instead of re-deciding:

       COMPATIBILITY.priced_input === false

   Nothing here is an opinion about whether quarterbacks matter. It is an
   answer to a narrower question: is the number the provider publishes the
   same measurement the shipped coefficient was fitted against? It is not, and
   the two reasons are specific, measured and fixable — which is why they are
   written down rather than rounded off.

   ------------------------------------------------------------------ SOURCES
   Every claim below was read from a primary artifact, not from prose:

     A  sportsdataverse/cfbfastR-cfb-data DATASETS.md, the `adv_passing`
        grain and column table (one row per passer per game; `EPA` = "Total
        Expected Points Added summed over this passer's plays").
     B  sportsdataverse/cfbfastR R/create_epa.R, the EP model's own feature
        selection — the list of columns handed to the model.
     C  the published model bundle `cfb_model_artifacts` MANIFEST.json and
        ep_model.card.json (github.com/sportsdataverse/sportsdataverse-data,
        release tag cfb_model_artifacts), which carry every shipped model's
        feature list, the EP model's training seasons and its training date.
     D  football/cfb_p4/research/build_team_game.py, the play set and garbage
        filter the SHIPPED coefficient was fitted against.
     E  the assembled corpus itself, measured (the league rate and its drift).
   ========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.EDFbsEpaContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var SCHEMA = 'edgedesk_fbs_epa_contract_v1';

  /* The model bundle that produced every EPA value in this corpus. One
     artifact, scored onto every season — which is the whole of finding 3. */
  var PROVIDER_MODEL = {
    bundle: 'cfb_model_artifacts',
    model_version: '2026.09.09',
    manifest: 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_model_artifacts/MANIFEST.json',
    ep_model: {
      asset: 'ep_model.ubj',
      objective: 'multi:softprob',
      classes: 7,
      label: 'next_score_label',
      features: ['TimeSecsRem', 'yards_to_goal', 'distance', 'down_1', 'down_2', 'down_3', 'down_4',
        'pos_score_diff_start'],
      training_seasons: [2004, 2025],
      n_training_rows: 2219971,
      trained_date: '2026-08-02',
      card: 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfb_model_artifacts/ep_model.card.json'
    },
    /* the sibling models in the same bundle, listed because three of them DO
       read the market and their outputs sit in the same source file */
    market_reading_models: {
      qbr_model: ['qbr_epa', 'sack_epa', 'pass_epa', 'rush_epa', 'pen_epa', 'spread', 'era0', 'era1', 'era2', 'era3'],
      wp_spread: ['pos_team_receives_2H_kickoff', 'spread_time', 'TimeSecsRem', 'adj_TimeSecsRem',
        'ExpScoreDiff_Time_Ratio', 'pos_score_diff_start', 'down', 'distance', 'yards_to_goal', 'is_home',
        'pos_team_timeouts_rem_before', 'def_pos_team_timeouts_rem_before', 'period'],
      fd_model: ['down', 'distance', 'yards_to_goal', 'posteam_total', 'posteam_spread', 'era0', 'era1', 'era2', 'era3'],
      two_pt_model: ['posteam_spread', 'posteam_total', 'pos_score_diff', 'era']
    }
  };

  /* -------------------------------------------------------------- findings */
  /* `status` is one of ESTABLISHED (read from a primary artifact),
     RECONCILED (measured numerically and consistent) or OPEN (not settled).
     `blocks_pricing` says whether this finding on its own prevents the
     provider series from entering the priced QB input. */
  var FINDINGS = [
    {
      id: 'denominator',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'What is the play set the provider divides EPA by?',
      answer: 'Attempts plus sacks. The provider publishes EPA summed over the passer’s plays and a mean per '
        + 'play; EPA divided by (Att + Sck) reproduces the published rounded rate to within 0.011 on 32,390 of '
        + '32,450 rows, and the 60 that do not reconcile carry no derived rate at all.',
      evidence: 'A (grain and column definitions) + E (recomputed on every row)',
      matches_shipped_coefficient: true,
      matches_why: 'football/cfb_p4/research/build_team_game.py defines is_dropback as completions, '
        + 'incompletions, sacks and interceptions — the same set. This one agrees.'
    },
    {
      id: 'scrambles',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Are quarterback scrambles in the numerator or the denominator?',
      answer: 'Neither. A scramble is a rush play in the source and is not attributed to the passer row, so the '
        + 'series is passing EPA per dropback, not total quarterback EPA. A running quarterback’s value is '
        + 'measured here only through what he does from the pocket.',
      evidence: 'A (the passer grain) + E (the denominator reconciles to Att+Sck, which leaves no room for a '
        + 'scramble to be inside it)',
      matches_shipped_coefficient: true,
      matches_why: 'the shipped coefficient excludes scrambles the same way — is_rush is explicitly '
        + '`rush & ~is_pass`, and the QB table aggregates dropbacks only.'
    },
    {
      id: 'spikes_and_kneels',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Are clock-stopping spikes counted?',
      answer: 'Yes. A spike is an incomplete pass in the source, so it enters both the attempt count and the EPA '
        + 'sum with its (large, negative) expected-points cost. It is not separable at this grain, in this corpus '
        + 'or in the corpus the shipped coefficient was fitted against.',
      evidence: 'A',
      matches_shipped_coefficient: true,
      matches_why: 'the same play is an incompletion in the training corpus and is counted the same way there.'
    },
    {
      id: 'penalties',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Is penalty EPA charged to the passer?',
      answer: 'No. Penalty expected points travel in a separate QBR component column (pen_epa) and not in the '
        + 'passer’s EPA total — if they did, the denominator would not reconcile to attempts plus sacks. '
        + 'Team-charged passing rows (the provider writes the literal name "TEAM" for intentional grounding and '
        + 'the like) are excluded from the corpus rather than attributed to a player.',
      evidence: 'A (pen_epa is documented as a QBR split) + E (1,390 team-or-unnamed rows excluded)',
      matches_shipped_coefficient: true
    },
    {
      id: 'market_information',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Does market information enter the EPA series?',
      answer: 'No. The expected-points model reads eight columns — seconds remaining, yards to goal, distance, '
        + 'the four down indicators and the pre-play score difference — and no spread, total or price is among '
        + 'them. That is read from the model bundle’s own feature list and from the package’s feature '
        + 'selection, not inferred. The source FILE does carry a `spread` column, and three sibling models in the '
        + 'same bundle do read it: QBR (exp_qbr), the spread-conditioned win-probability model (WPA) and the '
        + 'first-down and two-point models. Those outputs are market-contaminated for EdgeDesk’s purposes and '
        + 'are excluded from the independent fundamental feature set.',
      evidence: 'B (R/create_epa.R feature selection) + C (MANIFEST.json feature lists for every shipped model)',
      matches_shipped_coefficient: true,
      excluded_fields: ['exp_qbr', 'WPA', 'qbr_epa', 'sack_epa', 'pass_epa', 'rush_epa', 'pen_epa', 'spread']
    },
    {
      id: 'garbage_time',
      status: 'ESTABLISHED',
      blocks_pricing: true,
      question: 'Is garbage time filtered out of the provider’s passer EPA?',
      answer: 'No. The provider filters garbage time only for its season-level summary tables; the per-game passer '
        + 'rows are every play the passer took, blowout included.',
      evidence: 'A (the garbage-time note attaches to the season-level summaries alone) + D',
      matches_shipped_coefficient: false,
      matches_why: 'the shipped coefficient was fitted on a corpus with garbage time REMOVED — '
        + 'build_team_game.py drops plays whose pre-play margin exceeds a period-dependent threshold before the '
        + 'quarterback table is aggregated. Points per unit of a garbage-excluded series is not points per unit '
        + 'of a garbage-included one, and the difference is largest exactly for the quarterbacks who play the '
        + 'most one-sided games.'
    },
    {
      id: 'ep_model_identity',
      status: 'ESTABLISHED',
      blocks_pricing: true,
      question: 'Is this the same expected-points model the shipped coefficient was fitted against?',
      answer: 'No. The provider’s EPA comes from the published cfb_model_artifacts XGBoost expected-points '
        + 'model (version 2026.09.09). EdgeDesk’s coefficient was fitted against EPA from its own '
        + 'reconstructed expected-points surface in football/cfb_p4/research/ep_surface.py. Two different models '
        + 'produce two different scales, and a slope in points per unit is only valid on the scale it was '
        + 'measured on.',
      evidence: 'C + D',
      matches_shipped_coefficient: false,
      measured: {
        provider_league_epa_per_dropback: 0.0606,
        provider_league_basis: '679,182 reconciled dropbacks, 2014–2026',
        engine_replacement_prior: 0.0,
        engine_prior_basis: 'params.qb.prior_epa_per_db, the value an unmeasured passer is shrunk toward',
        note: 'the provider’s league average is +0.061, not zero. Shrinking this series toward a zero prior '
          + 'treats an average college quarterback as above replacement by construction.'
      }
    },
    {
      id: 'ep_model_vintage',
      status: 'ESTABLISHED',
      blocks_pricing: true,
      question: 'Was each season’s EPA available, as published, at that season’s kickoffs?',
      answer: 'No. One model trained on seasons 2004–2025 (2,219,971 rows, trained 2026-08-02) is scored onto '
        + 'every season in the corpus. A 2014 play’s EPA is therefore computed by a model that has seen '
        + '2015–2025 football. This is a look-ahead in the METRIC’S DEFINITION rather than in any '
        + 'outcome, and it does not put the result of the game being predicted into its own features — but it '
        + 'does mean a historical backtest on this series is not vintage-correct, and the bundle is republished, '
        + 'so historical values are not frozen either.',
      evidence: 'C (ep_model.card.json: training_seasons, trained_date, n_training_rows)',
      matches_shipped_coefficient: false,
      matches_why: 'the same objection applies to the shipped coefficient’s own surface, so this is a '
        + 'property of both and a reason to report historical results as exploratory rather than as a clean '
        + 'out-of-sample record.'
    },
    {
      id: 'league_drift',
      status: 'RECONCILED',
      blocks_pricing: true,
      question: 'Is the series stationary enough for a career-to-date mean to be comparable across eras?',
      answer: 'No. League EPA per dropback runs +0.030 in 2014 and +0.077 in 2026 — a drift of nearly five '
        + 'hundredths, which is around an eighth of the p10-to-p90 spread of a single game. A career-to-date mean '
        + 'that begins in 2014 is therefore not on the same scale as one that begins in 2024, and any feature '
        + 'built from it has to be centred on its own season rather than on a fixed prior.',
      evidence: 'E (measured on the corpus, season by season)',
      matches_shipped_coefficient: false,
      measured: {
        by_season: { 2014: 0.0299, 2015: 0.0414, 2016: 0.0463, 2017: 0.0380, 2018: 0.0545, 2019: 0.0662,
          2020: 0.0826, 2021: 0.0848, 2022: 0.0675, 2023: 0.0804, 2024: 0.0679, 2025: 0.0732, 2026: 0.0774 }
      }
    },
    {
      id: 'success_rate_definition',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Is the provider’s success rate EdgeDesk’s success rate?',
      answer: 'No. The provider’s SR is the share of the passer’s plays with positive EPA. EdgeDesk’s '
        + 'own success definition is a down-and-distance yardage rule. They are different measurements with the '
        + 'same name and are never presented as interchangeable.',
      evidence: 'A',
      matches_shipped_coefficient: false
    },
    {
      id: 'cpoe_definition',
      status: 'ESTABLISHED',
      blocks_pricing: false,
      question: 'Can CPOE stand in for EPA?',
      answer: 'No. CPOE is a completion-probability residual from a separate model (down, distance, yards to goal, '
        + 'score difference, seconds remaining, home flag, period, passing-down flag). It carries no market '
        + 'information, and it is not expected points. It is carried as a provider output and is labelled as '
        + 'itself.',
      evidence: 'C (cfb_cp_model.ubj feature list)',
      matches_shipped_coefficient: false
    }
  ];

  /* ------------------------------------------------------------- the verdict */
  var COMPATIBILITY = {
    /* THE ONE FLAG EVERYTHING ELSE READS. */
    priced_input: false,
    decided_at: '2026-09-15',
    summary: 'The provider’s passing EPA is genuinely expected-points added, genuinely free of market '
      + 'information, and genuinely divided by attempts plus sacks. It is NOT the same measurement the shipped '
      + 'points_per_epa_db coefficient was fitted against: that coefficient was estimated on a different '
      + 'expected-points model, over a corpus with garbage time removed, against a replacement prior of zero that '
      + 'this series’ own league average (+0.061, drifting +0.047 across the window) does not sit at. Two of '
      + 'those three gaps are scale gaps, and a slope carries no meaning off its own scale. So the measurements '
      + 'ship as labelled research and the QB layer keeps contributing zero points.',
    blocking_findings: ['garbage_time', 'ep_model_identity', 'ep_model_vintage', 'league_drift'],
    what_would_settle_it: [
      'A coefficient re-estimated ON THIS SERIES, inside a training fold, rather than the one fitted against '
        + 'EdgeDesk’s own expected-points surface.',
      'Season-centred features, so the +0.047 league drift across 2014–2026 cannot masquerade as quarterback '
        + 'quality.',
      'Either a garbage-time filter applied to the provider series (which needs play-level rows this per-game '
        + 'table does not carry), or a demonstration that the contamination does not change the fitted slope.',
      'A pass of the predeclared promotion rule in football/validation/, on evidence that is not the seasons the '
        + 'feature was chosen on.'
    ],
    /* What may be shown and said regardless of the above. These are
       measurements with sources; the flag governs whether they can reach a
       PRICE, not whether they can be reported. */
    research_use_permitted: true,
    research_basis: 'these are observed measurements with a source, a timestamp, a sample size and a stated '
      + 'history boundary. Showing them and explaining them is exactly what the research module is for. Pricing '
      + 'from them is a separate decision with a separate gate.'
  };

  /* Field-by-field labelling rules, so nothing downstream can rename one of
     these into another. The keys are the names this repository uses. */
  var FIELD_LABELS = {
    epa_per_dropback: {
      label: 'Passing EPA per dropback',
      is_epa: true,
      definition: 'expected points added on this passer’s attempts and sacks, divided by attempts plus sacks',
      may_price: false,
      excludes: ['scrambles', 'designed quarterback runs'],
      includes: ['sacks', 'spikes', 'garbage time']
    },
    provider_success_rate: {
      label: 'Success rate (provider, EPA-based)',
      is_epa: false,
      definition: 'the share of this passer’s plays with positive EPA — NOT EdgeDesk’s '
        + 'down-and-distance success rule',
      may_price: false
    },
    provider_cpoe: {
      label: 'Completion percentage over expected',
      is_epa: false,
      definition: 'a completion-probability residual, not expected points',
      may_price: false
    },
    yards_per_attempt: {
      label: 'Yards per attempt',
      is_epa: false,
      definition: 'passing yards divided by attempts',
      may_price: false
    },
    sack_rate: {
      label: 'Sack rate',
      is_epa: false,
      definition: 'sacks divided by attempts plus sacks — a joint measurement of the passer, the line and '
        + 'the opponent, never of the passer alone',
      may_price: false
    },
    interception_rate: {
      label: 'Interception rate',
      is_epa: false,
      definition: 'interceptions divided by attempts',
      may_price: false
    }
  };

  /* Anything a caller might mistake for EPA. Asserted in the tests: if one of
     these ever comes back with is_epa true, the labelling has drifted. */
  function isEpa(field) {
    var f = FIELD_LABELS[field];
    return !!(f && f.is_epa === true);
  }

  function mayPrice(field) {
    if (COMPATIBILITY.priced_input !== true) return false;
    var f = FIELD_LABELS[field];
    return !!(f && f.may_price === true);
  }

  /* One sentence per measurement, for the surfaces that show it. Deliberately
     says the same thing everywhere so the card, the packet and the AI cannot
     describe the same number differently. */
  function pricingStatement(field) {
    var f = FIELD_LABELS[field];
    if (!f) return 'this measurement is research context and does not affect the fair line';
    if (mayPrice(field)) return f.label + ' is priced into the fair line';
    return f.label + ' is research context and does not affect the fair line'
      + (COMPATIBILITY.priced_input === false
        ? ' — the provider’s EPA is not on the same scale as the coefficient the engine carries'
        : '');
  }

  function findingsBlockingPricing() {
    return FINDINGS.filter(function (f) { return f.blocks_pricing === true; });
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA,
    PROVIDER_MODEL: PROVIDER_MODEL,
    FINDINGS: FINDINGS,
    COMPATIBILITY: COMPATIBILITY,
    FIELD_LABELS: FIELD_LABELS,
    isEpa: isEpa, mayPrice: mayPrice, pricingStatement: pricingStatement,
    findingsBlockingPricing: findingsBlockingPricing
  };
});
