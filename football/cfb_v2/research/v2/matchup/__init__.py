"""EdgeDesk CFB scheme and matchup intelligence (docs/cfb-matchup/).

General team strength (V2.1, edgedesk_cfb_v2.1.0) stays the foundation. This package
describes HOW each team plays (continuous, game-state- and opponent-adjusted style
vectors, point in time), builds offense x defense interaction features, finds
statistically similar past opponents, and tests -- strictly walk-forward on the
development seasons, the holdout scored once -- whether any matchup interaction
predicts V2.1's out-of-fold residual. A family enters the correction only if it proves
out-of-sample incremental value; otherwise the correction is zero.

Modules
  audit        scheme-data coverage by season (what the play-by-play can and cannot support)
  style        team-game style sums, league expected-pass / expected-go models, opponent-
               adjusted point-in-time style ratings (the team_week_style table)
  interactions offense x defense matchup features per game (home-minus-away)
  similar      similar-opponent engine, matchup familiarity, the similar-matchups table
  changes      coordinator continuity and statistical style change-point events
  residual     walk-forward residual models (ridge families, shallow GBM), shrinkage,
               variance model, the frozen artifact
  backtest     the evaluation: dev walk-forward, ablation, buckets, narratives, holdout once
  hook         weekly integration at the freeze T, explanations, Model Lab monitoring
  tests_matchup  --fast synthetic checks and real-data checks

Nothing here reads market data, provider win probability, or any provider column whose
model reads the pregame spread (see audit.FORBIDDEN).
"""

STYLE_VERSION = 'cfb_style_v1'                 # style sums + league expectation models + ratings
MATCHUP_FEATURE_VERSION = 'cfb_matchup_fv1'    # interaction feature definitions
SIMILARITY_VERSION = 'cfb_similarity_v1'       # style-space distance + kernel
RESIDUAL_MODEL_VERSION = 'cfb_matchup_resid_v1'
PLAYSEL_VERSION = 'cfb_playsel_v1'             # expected play selection (additive joint model)
CLUSTER_VERSION = 'cfb_style_cluster_v1'       # descriptive only; never a production input
CHANGE_RULE_VERSION = 'cfb_style_change_v1'
BASE_MODEL_VERSION = 'edgedesk_cfb_v2.1.0'
