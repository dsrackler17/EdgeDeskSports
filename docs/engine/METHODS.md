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

## Basketball (NBA, WNBA, men's and women's college) — designed

- **Approach:** possessions-based offensive and defensive efficiency and pace,
  opponent-adjusted by regularised least squares (kubatko2007); availability
  priced through regularised adjusted plus-minus (sill2010); the margin is
  near-normal (stern1994), so cover and win probabilities come from a normal
  around the possession-based projection, with pace driving the total.
- **Why it fits:** basketball is high-scoring and possession-rich, so
  efficiency per possession is stable quickly; a star's absence moves a number
  by points, so player impact must be in the price.
- **Baselines:** Elo; efficiency without availability.
- **Blocked:** no basketball data source is wired in this repository.

## MLB and college baseball — MLB partial, college designed

- **Approach:** starter quality (xERA, FIP, K-BB%) with times-through-the-
  order decay; bullpen availability from the last three days' usage; lineup
  wOBA with platoon splits; park and weather run factors (tango2007); a
  negative-binomial run distribution per team (runs are overdispersed).
  College: opponent-adjusted run ratings with weekend-rotation starters.
- **Why it fits:** the starter dominates the first five innings and the
  bullpen the rest; scoring is overdispersed.
- **State:** MLB has a run model (`mlb/engine.js`) that has never been
  validated walk-forward; college baseball has data only.

## Soccer — designed

- **Approach:** time-weighted attack/defence Poisson with the Dixon-Coles
  low-score correction (dixoncoles1997, maher1982), xG-informed ratings where
  shot data exist, home advantage per league, lineup availability; three-way,
  Asian-handicap and total settlement. Elo as the baseline (hvattum2010);
  bivariate Poisson if draws are mispriced (karlis2003).
- **Why it fits:** it is the published, market-tested standard for football
  scores, and the draw is a priced outcome.
- **Blocked:** no results, xG or price source wired; league coverage undefined.

## Tennis — existing brain, product retired

- **Existing:** regularised logistic model on overall and surface Elo, ranking
  and form (outcome-validated: held-out log loss 0.6144 on 53,850 matches,
  beating Elo, surface Elo and ranking; `docs/tennis-lab-implementation-report.md`).
  Elo-type ratings are the strongest published pre-match predictors (kovalchik2016).
- **Designed extension:** serve/return point probabilities combined into
  match probabilities (barnett2005, klaassen2003) for surface and format.
- **State:** retired 2026-09-27; licence non-commercial; never tested vs market.

## UFC / MMA — designed

- **Approach:** opponent-adjusted per-minute rates (significant strikes
  landed/absorbed, takedowns, control time, submission attempts) driving a
  Markov chain of fight states to win, method (KO/TKO, submission, decision)
  and round probabilities (holmes2023); Glicko as the baseline (glickman1999).
- **Why it fits:** Holmes, McHale & Zychaluk report bookmaker-level accuracy
  from in-fight statistics, and method-of-victory markets need a process model.
- **Blocked:** no per-minute fight-statistics archive is wired.
