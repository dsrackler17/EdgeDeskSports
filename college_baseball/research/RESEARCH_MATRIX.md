# Research matrix — what is tested, and why

Classification:

- **A** implementable with the authorised data on file
- **B** implementable after acquiring additional authorised data
- **C** methodologically interesting, not practical here
- **D** rejected (weak evidence, poor data, or complexity without payoff)

"Tested" means the method is a candidate in a walk-forward experiment whose
result is in `experiments.jsonl`. Methods are reviewed from their published
descriptions; several rating sites (WarrenNolan, College Baseball Ratings,
Boyd's World archive) are unreachable from the build environment, so their
exact current formulas could not be re-read and only their published concepts
are used.

Nothing below transfers from MLB by assumption. Every constant (home
advantage, Pythagorean exponent, linear weights, dispersion, run-environment,
starter length) is fitted on college data.

## Team strength

| Method | Class | Tested as | Notes |
|---|---|---|---|
| RPI / winning percentage | D | — | describes schedule-weighted results; not a forecast of runs or of a single game. Never used as a model. |
| WarrenNolan strength of schedule | C | — | site unreachable; SOS is an RPI component. Opponent adjustment is done directly in the run models instead. |
| Boyd's World ISR (iterative strength rating) | A | `elo`-family baseline and the iterative opponent-adjusted run ratings | ISR iterates win% against opponents' ratings; the run-based ratings below subsume it. |
| Massey least-squares (run differential) | A | `massey` | ridge-regularised least squares on run margin, home advantage, recency weights. |
| Bradley-Terry / logistic on results | A | `bt` | win/loss only; discards run information, kept as a challenger. |
| Elo (results only) | A | baseline 3 | K, home advantage and between-season regression tuned on SELECTION. |
| Maher-style Poisson attack/defence | A | `poisson_ratings` (Model 1) | log-linear runs for/against with opponent, home, park; partial pooling to conference via ridge priors. |
| Hierarchical Bayesian (team ⊂ conference ⊂ division) | A | `hier` (Model 3) | MAP with Gaussian priors at each level and a Laplace (Hessian) approximation for each team's posterior sd: the uncertainty for weakly connected schedules is the inverse-Hessian variance, not a guess. |
| Dynamic / state-space ratings (Glickman–Stern) | A | recency-weighted refits + between-season regression | full Kalman smoother judged not worth its complexity before the simpler decay is beaten (re-open if residual drift is found). |
| Roster-transition priors (returning production) | A (2025–26 only) | `prior_returning` | needs two box-score seasons; tested on 2025→2026 only. |

## Run production

| Method | Class | Tested as | Notes |
|---|---|---|---|
| Pythagorean / Pythagenpat | A | baseline 2 | exponent fitted to college run environment (≈ 13 runs per game, not ≈ 9). |
| Linear weights (regression of team-game runs on events) | A | `linear_weights` | fitted on 2024–2026 box scores and 2017–2023 play-by-play event counts; compared with BaseRuns. |
| BaseRuns (Smyth) | A | `baseruns` | B-multiplier fitted to college data. |
| Run expectancy by base-out state (RE24) | B | — | needs base-state reconstruction from free-text runner movements; outs-only RE is computed (A) and reported. |
| Opponent-adjusted component offense (OBP, ISO, K%, BB%) | A | Model 2 | regressed per team on opponents' pitching components. |
| Park-adjusted power | A | park factor applied to HR / ISO | park factors shrunk by games observed. |

## Pitching and defence

| Method | Class | Tested as | Notes |
|---|---|---|---|
| ERA | D (as the pitcher metric) | — | noisy, defence- and sequence-dependent; reported, never the input. |
| DIPS / FIP-style components (K, BB, HBP, HR per BF) | A | starter engine | college constant fitted; components shrunk to the population with BF-based reliability. |
| Hierarchical pitcher talent (empirical Bayes per component) | A | starter engine | beta-binomial shrinkage per rate. |
| Starter outing length | A | starter engine | historical BF/outs per start; uncertainty from the pitcher's own variance shrunk to the role mean. |
| Pitch-count fatigue | B | — | pitch counts are not in the source; workload is BF-based with stated uncertainty. |
| Bullpen availability from recent usage | A | bullpen engine | appearances and BF over the last 1/2/3 days, series context. |
| Handedness / platoon | B | — | no pitcher handedness in the source. |
| Fielding: errors, unearned runs, DP, catcher SB control | A | defence engine | each tested by ablation for predictive value. |
| Defensive range / batted-ball quality | C | — | needs tracking data (proprietary). Not claimed. |

## Distributions and simulation

| Method | Class | Tested as | Notes |
|---|---|---|---|
| Poisson team runs | A | Model 4 baseline | expected to be overdispersed (tested). |
| Negative binomial | A | Model 4 | dispersion fitted by season. |
| Mixture / zero-adjusted NB | A | Model 4 challenger | for blowout tails. |
| Correlated scores (shared gamma frailty / bivariate) | A | Model 4 challenger | correlation of the two teams' runs measured first. |
| Weibull runs (Miller 2007) | C | — | a derivation of Pythagoras; NB is the more flexible fitted family. |
| Inning-level Monte Carlo | A | Model 5 | half-inning run distributions from play-by-play, starter/bullpen innings, home-half rules, extra innings, walk-offs, scheduled length mixture, measured run-rule probability. |

## Learning and combining

| Method | Class | Tested as | Notes |
|---|---|---|---|
| Regularised logistic / Poisson GLM | A | Model 6 | engine/stats.js. |
| Gradient boosting (depth-2 trees) | A | Model 6 challenger | small, deterministic, in-repo implementation; must beat the GLM by the protocol margin. |
| Pitcher-aware hybrid | A (2025–26 scored) | Model 7 | team ratings + starter scenario + bullpen state. |
| Stacked ensemble | A | Model 8 | adopted only with a paired-bootstrap interval below zero on VALIDATION. |

## Environment

| Method | Class | Tested as | Notes |
|---|---|---|---|
| Home-field advantage | A | every model | fitted; separate from park effect (home team at own park vs neutral). |
| Park factors (shrunk) | A | `park` feature group | estimated from home and road scoring, shrunk by games; ablation-tested. |
| Neutral sites, travel days, rest | A | `context` group | rest from schedule gaps; travel distance is B (no venue coordinates). |
| Altitude | B | — | needs venue elevations; captured by the park factor meanwhile. |
| Temperature, wind, humidity, air density | B | — | needs an authorised archive of forecasts as of prediction time; using realised weather would leak. |

## Markets

| Method | Class | Notes |
|---|---|---|
| Fair moneyline / run line / totals from the run distribution | A | `lib/pricing.js`. |
| Comparison with sportsbook prices, EV | B | no authorised `baseball_ncaa` feed; every game reads MARKET UNAVAILABLE. |
| First-five / inning markets | A (priced) | validated against inning lines from play-by-play/linescore before they are shown as more than PROVISIONAL. |

## Key references

Maher (1982) *Modelling association football scores*; Bradley & Terry (1952);
Elo (1978); Glickman & Stern (1998) *A state-space model for NFL scores*;
Dixon & Coles (1997); Karlis & Ntzoufras (2003) bivariate Poisson; Smyth
(BaseRuns); Davenport & Smyth (Pythagenpat); Miller (2007) *A derivation of the
Pythagorean won-loss formula in baseball*; McCracken (2001) DIPS; Tango,
Lichtman & Dolphin (2007) *The Book*; Brown (2008) empirical Bayes batting
averages; Efron & Morris (1975); Gneiting & Raftery (2007) proper scoring
rules; Nation, Boyd's World ISR (archived descriptions).
