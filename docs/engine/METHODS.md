# Methods — what each sport's brain is, and why

Every sport gets its own brain. A model built for one sport is never
registered as another sport's integration. Methods are adapted from
published, reproducible work; no proprietary bookmaker or bettor model is
claimed. Source keys refer to `SOURCES` in `lib/edgedesk_sport_brains.js`,
where each has its full citation and, where public, its link.

Selection follows one rule everywhere: **the method with the better
out-of-sample proper score (log loss / Brier, Gneiting & Raftery 2007) on a
chronological hold-out wins, against simple baselines first and the no-vig
closing market second.** Calibration matters more than accuracy for pricing
(Walsh & Joshi 2024), so every record reports it.

## Shared machinery

| Piece | Method | Source |
|---|---|---|
| De-vig | multiplicative (two-way); Shin differs by < 0.5 pp at NHL margins | strumbelj2014, shin1993 |
| Walk-forward | ratings in one chronological pass; fits on earlier seasons only; a leakage audit on every scored prediction | — |
| Scoring | log loss, Brier, ranked probability score, calibration slope/intercept, Wilson intervals, block bootstrap by date | gneiting2007 |
| Market test | no-vig close on the same games, ROI with pushes, CLV of entry vs close | `lib/edgedesk_calibration.js` |
| Board | shrinkage toward the no-vig market (k = τ²/(τ²+σ²)), a selection-adjusted bar Φ⁻¹(1 − α/N), one opportunity per event | smithwinkler2006 |

## NHL — built

See [`NHL.md`](NHL.md). xG ratings (macdonald2012, evolving_xg), score
adjustment (tulsky2012), goalie pulls and score effects by simulation
(beaudoin2010), attack/defence Poisson (maher1982, dixoncoles1997), Elo
baseline (fte_nhl); bivariate Poisson tested and rejected (karlis2003).
**Why it fits:** goals are rare and noisy; shot quality is the stable signal;
the puck line and totals depend on late-game dynamics a plain Poisson misses.

## NFL and college football — existing brains, kept

Opponent-adjusted EPA and success rate (yurko2019) with QB, injury, rest,
weather and roof context; margin and total distributions with key-number
structure (glickman1998). The linemaker and pricing records are read as
evidence; nothing in them was changed.

## The shared protocol for every new brain (`engine/lab/protocol.js`)

One chronological pass per league; every parameter that turns ratings into
probabilities is fitted on earlier seasons' out-of-sample predictions;
hyperparameters are tuned on a SELECTION window and never on a later one; a
challenger replaces the incumbent only if it beats it by 0.001 log loss on
selection; CONFIRMATION is reported, never used to choose. A market is
OUTCOME_VALIDATED only with n ≥ 1000 **over at least two confirmation seasons**
(one season cannot show stability), calibration in the large within 0.02, a
calibration slope in 0.85–1.15 and — for the headline market — a block
bootstrap 95% interval wholly in its favour against the best baseline.
Distribution markets (margin, total) are scored by CRPS (gneiting2007) and
need 80% intervals that cover 77–83% of outcomes. Every record says it is
RETROSPECTIVE and that the market is NOT_TESTED.

## Basketball (NBA, WNBA, men's and women's college) — built (`basketball/`)

- **Approach:** offence and defence points ratings per team (Massey's
  least-squares rating split into offence and defence — massey1997,
  kubatko2007), refitted by Gauss-Seidel sweeps whenever a result becomes
  available, with exponentially decaying weights, a ridge pull toward last
  season's rating carried at a tuned rate, and a fitted league scoring level
  and home advantage. The win curve, the margin and total recalibration, their
  out-of-sample spreads (margins are close to normal — stern1994) and a
  back-to-back effect are fitted on the three earlier seasons. Four leagues,
  four separate fits.
- **Causality:** a game is predicted 30 minutes before its start from the
  results available by then (start + 4 h) — a late Hawaii tip is not yet
  known to a 6 a.m. tip-off marathon game (the leakage audit found exactly
  that in a first, day-grouped version, and it was fixed before any record
  was kept).
- **Baselines:** Elo in FiveThirtyEight's NBA form, tuned on selection
  (fte_nba); home-advantage-only.
- **Result (confirmation):**

| League | Games scored | Chosen | ML log loss | vs Elo (95%) | Margin CRPS (baseline) | Total CRPS (baseline) | Status |
|---|---|---|---|---|---|---|---|
| NBA 2018-2026 | 11,546 | points + back-to-back | 0.6223 | −0.0023 (−0.0043 to −0.0003) | 7.67 (8.40) | 10.60 (11.82) | moneyline, spread, total validated vs outcomes |
| WNBA 2018-2025 | 1,873 | points | 0.6132 | −0.0012 (−0.0081 to +0.0054) | 7.06 (7.91) | 9.38 (9.92) | spread, total validated; moneyline provisional |
| Men's college 2019-2026 | 47,123 | points | 0.5058 | −0.0329 (−0.0367 to −0.0295) | 7.00 (9.43) | 9.53 (10.78) | all three validated vs outcomes |
| Women's college 2019-2026 | 44,014 | points | 0.4608 | −0.0493 (−0.0527 to −0.0457) | 7.48 (11.03) | 9.23 (10.76) | all three validated vs outcomes |

- **Not modelled:** player availability (the pack's P0 gap: no injury or
  lineup archive), travel, possessions and pace.

## Soccer — built (`soccer/`, five leagues fitted separately)

- **Approach:** time-decayed Poisson attack/defence ratings (maher1982) with
  the Dixon-Coles low-score correction (dixoncoles1997) and an optional pair
  recalibration of the two goal rates; four candidates chosen per league by
  the selection rule. A promoted club starts at the mean rating of the clubs
  relegated the season before. Markets come from the score matrix: 1X2, totals,
  both teams to score, and Asian handicaps with quarter lines settled as two
  half stakes.
- **Baselines:** a goal-difference Elo whose draw curve is fitted on earlier
  seasons (hvattum2010); the league's base rates. 1X2 is scored by the ranked
  probability score (constantinou2012).
- **Result (confirmation 2018-19 to 2025-26):** the model is at best level
  with Elo. RPS difference vs Elo: Premier League −0.0016 (−0.0036 to
  +0.0004), Bundesliga −0.0007, La Liga +0.0002, Serie A −0.0025 (−0.0043 to
  −0.0008; but the draw is under-predicted by 2.4 points), Ligue 1 −0.0004.
  Independent Poisson won the selection window in every league (the
  low-score correction did not earn its place). Totals and both-to-score are
  over-confident (calibration slopes 0.45–0.75). Only the home −1.5 Asian line
  passes (Premier League, Bundesliga, Ligue 1). **1X2 stays provisional
  everywhere.**
- **Not modelled:** xG, lineups, cup and European fixtures, congestion. The
  source lags: missing results are listed (RESULT_MISSING), never guessed, and
  a league with recent gaps is STALE on the board.

## MLB — built (`mlb/history/`) beside the browser run model

- **Approach:** a log-linear run model — team offence and run prevention, a
  decayed park factor (keyed by the home franchise) and a starting-pitcher
  effect — refitted every game date by coordinate Newton steps on weighted
  Poisson likelihood, each block shrunk toward average; negative-binomial
  overdispersion and the extra-inning home rate fitted on earlier seasons;
  candidates `team`, `team + park`, `team + park + starter` chosen by the
  selection rule. Tuning showed the starter effect needs heavy shrinkage
  (a 64-start prior beat 32, 16, 8 and 4) — a few starts say little.
- **Data:** Retrosheet game logs 2010-2023 and 2025 (starters, parks); 2024
  from the data pack's StatsAPI table, which has no starters, so 2024 is
  priced without the starter term and reported separately.
- **Result (confirmation 2018-2025, n 17,909):** the full model won the
  selection window (−0.0027 vs team-only) but **does not beat Elo out of
  sample** — it is worse by 0.0016 log loss (95% +0.0004 to +0.0028) — and
  the starter term adds nothing measurable on confirmation (+0.0002,
  −0.0010 to +0.0013). Calibration is good (slope 0.98); the run line passes
  the binary rules; totals are over-confident (slope 0.65). So the MLB
  moneyline is PROVISIONAL and the model is not trusted over a simple Elo. It
  was not re-tuned after this was seen: that would be fitting the
  confirmation window. Likely gaps: no bullpen, lineup or platoon input, and
  team ratings that are too sticky for a sport whose rosters churn.
  College baseball has no model: the pack holds a 313-game sample.

## Tennis — existing brain, product retired

- **Existing:** regularised logistic model on overall and surface Elo, ranking
  and form (outcome-validated: held-out log loss 0.6144 on 53,850 matches,
  beating Elo, surface Elo and ranking; `docs/tennis-lab-implementation-report.md`).
  Elo-type ratings are the strongest published pre-match predictors (kovalchik2016).
- **Designed extension:** serve/return point probabilities combined into
  match probabilities (barnett2005, klaassen2003) for surface and format.
- **State:** retired 2026-09-27; licence non-commercial; never tested vs market.

## UFC / MMA — measured, not built

- **Designed:** opponent-adjusted per-minute rates driving a Markov chain of
  fight states (holmes2023), Glicko as the baseline (glickman1999).
- **Measured (`engine/lab/ufc_elo.json`):** an Elo over the data pack's 2024
  bouts (566). Only 138 bouts had both fighters with an earlier 2024 fight;
  Elo vs a coin flip −0.004 log loss (95% −0.012 to +0.004). One year cannot
  meet the protocol, so UFC stays RESEARCH_ONLY and no fight probability is
  published.
- **Blocked:** round-level statistics — UFCStats refuses automated access and
  is not bypassed — and a multi-year results archive.
