'use strict';
/* ===========================================================================
   What the public record says, what EdgeDesk chose, and what is unknown.

   The source review (docs/ncaam/METHODOLOGY_SOURCES.md) tags every claim by
   how it was obtained: most original pages could not be fetched from the
   build environment (egress blocked kenpom.com, barttorvik.com, evanmiya.com
   and others), so those claims rest on search excerpts of the authors' own
   pages and are marked as such. Sill (2010) was read in full.

   build.js publishes this as published/methodology.json for the research
   pages. Nothing here claims to reproduce a private formula.
   =========================================================================== */

const TOPICS = [
  {
    topic: 'Opponent adjustment',
    public: 'KenPom: originally multiplicative and game-by-game, changed (about 2016) to additive offense and defense measured against the national average on the game date [search excerpt]. Torvik T-Rank: multiplicative, iterated until stable [search excerpt].',
    choice: 'Additive weighted least squares (lib/additive.js): points per 100 = mu + offense + defense allowed + home edge, weighted by possessions, solved by warm-started Gauss-Seidel. The multiplicative alternative was fitted too (log scale) and was not better on 2025 or 2026 (CI includes zero).',
    unknown: 'KenPom\'s and Torvik\'s current weights, iteration details and any per-game importance function.',
  },
  {
    topic: 'Preseason prior and its fade',
    public: 'KenPom: preseason weight reaches zero after a team\'s 27th D-I game; prior models use returning players, transfers, recruits [search excerpt]. Torvik: prior gone after 13 "adjusted games" [search excerpt]. EvanMiya: team projection from projected player ratings and minutes [search excerpt].',
    choice: 'Last season\'s final rating as a ridge prior worth lambda possessions (lambda chosen on 2025: 150 possessions, about two games), so its weight fades as games accumulate; carry-over 1.0 chosen on 2025. Roster continuity and transfer value were tested: continuity did not help; the transfer term won on 2025 but not on 2026 (experimental).',
    unknown: 'Recruiting rankings, class year and enrollment are not in the data, so no freshman or recruit prior exists here.',
  },
  {
    topic: 'Recency',
    public: 'Torvik: 100% weight for 40 days, -1% a day to 60% at 80 days [search excerpt]. KenPom: recency "less important than it used to be" after 2016 [search excerpt].',
    choice: 'Half-lives of 365, 180 and 90 days and none were compared on 2025; none was chosen. A 30-day "current form" fit is shown beside the rating, labelled as less predictive.',
    unknown: 'Whether a Torvik-style piecewise schedule would beat no decay on this data (not tested).',
  },
  {
    topic: 'Blowouts and garbage time',
    public: 'KenPom 2.0 down-weighted expected lopsided wins; Torvik (2018) stops counting at a "safe" lead; KenPom reports rematch margins stop predicting at about an 18-point lead with 5:00 left [search excerpts]. EvanMiya keeps garbage time for player ratings because removing it was slightly less accurate [search excerpt].',
    choice: 'Down-weighting games decided by more than 30 points was tested on 2025 (weights 0.7 and 0.4): not chosen. Player ratings keep garbage time; removing it changes impact estimates little (correlation 0.99 with the primary fit).',
    unknown: 'A possession-level safe-lead rule for team ratings (2026 possessions carry a publisher garbage flag; earlier seasons do not).',
  },
  {
    topic: 'Possessions',
    public: 'KenPom: FGA - ORB + TO + 0.475 FTA, the coefficient derived from play-by-play [search excerpt]; 0.44 is an NBA estimate.',
    choice: 'The coefficient is fitted inside each fold on the publisher\'s parsed possession counts: 0.489 (2024) and 0.491 (2024-25). On 2026 it tracks the parsed counts better (RMSE 1.53) than 0.475 (1.59) or 0.44 (1.93).',
    unknown: 'Whether the parsed counts are themselves right: the publisher\'s possession table matches official finals exactly in 86% of games.',
  },
  {
    topic: 'Win probability and score distributions',
    public: 'KenPom derives win probability from the predicted margin (no SD stated) [search excerpt]; spread errors are roughly normal with SD about 10.9 (Wolfers 2006) or about 10 (other sources) [search excerpts].',
    choice: 'Margin and total are normal with mean and width recalibrated weekly on earlier out-of-sample games; the width grows with the ratings\' parameter variance, so early-season games are wider. P(win) includes overtime.',
    unknown: 'Tail behaviour for heavy favourites (a t or logistic layer was not tested).',
  },
  {
    topic: 'Player impact (RAPM)',
    public: 'Rosenbaum (2004) adjusted plus-minus; Sill (2010) ridge regression with the penalty chosen out of sample [read in full]; box-score priors in xRAPM/RPM, BPM 2.0 and EvanMiya\'s BPR [search excerpts].',
    choice: 'Possession-level ridge RAPM over the ten NCAA ids on the floor, with each player shrunk toward a box-score prior (rates per 100 possessions from the NCAA player box) plus last season\'s publisher RAPM where the publisher id chain links him. Penalty and variant chosen chronologically inside 2026 (fit before 15 Jan, score 15 Jan - 15 Feb): lambda 2000 with both priors.',
    unknown: 'EvanMiya\'s coefficients, shrinkage and multi-season windows; whether more seasons of possession data would help (only 2026 has it).',
  },
  {
    topic: 'Lineups',
    public: 'EvanMiya: lineup projections lean on observed results more as possessions grow [search excerpt]; L-RAPM uses player-informed priors for lineups [abstract].',
    choice: 'Lineup = sum of its players\' impacts + its own adjusted residual shrunk by an empirical-Bayes weight. The between-lineup residual variance is estimated at zero and residuals did not repeat across season halves (r = -0.09), so pooled lineup ratings equal their players\' sum; observed and adjusted results are shown beside them.',
    unknown: 'Real substitution logs: lineups come from the publisher\'s possession reconstruction (opening fives match ESPN starters 99.3%).',
  },
  {
    topic: 'Four factors and style',
    public: 'Dean Oliver\'s four factors; the 40/25/20/15 weights are described as approximate [search excerpt].',
    choice: 'Weights are a regression of points per 100 on eFG%, TOV%, ORB% and FTA/FGA (2024-25 team-games). Every rate is opponent-adjusted and shrunk by its measured split-half reliability (for example 3-point percentage allowed has reliability 0.24: mostly noise).',
    unknown: 'Shot quality, defender distance, coverage and spacing: there is no tracking data, so none of it is claimed.',
  },
  {
    topic: 'Market comparison',
    public: '-',
    choice: 'A separate layer prices exact quotes (with pushes and overtime rules) against the independent projection and returns PASS unless every gate holds, including confirmed availability and market validation, neither of which exists today.',
    unknown: 'How the model compares with closing prices: no timestamped price archive is available.',
  },
];

module.exports = { TOPICS };
