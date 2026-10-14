# NBA — research review (section 1 of the brief)

Compiled 2026-10-13 for the NBA engine (`docs/engine/NBA.md`). Scope: public
methodology only. Nothing proprietary was copied, no prohibited resource was
scraped, and no claim below is used as evidence that any model is profitable.
The engine's own numbers are in `nba/validation/` and in the model card.

## How this review shaped the build

| Finding (section below) | Where it went in the engine |
|---|---|
| AnzaAbbasi's random split, same-fold calibration and unused line-shopping constant (§1) | Chronological walk-forward only; calibration fitted on the three seasons *before* each scored season; the test window is sealed and every unsealing is logged (`nba/validation/holdout_log.json`); ROI is never computed from untimestamped prices |
| Mirrored team rows leak labels in a random split (§1, §5.1) | One row per game in `nba/data/games`; the team-perspective table (`team_games`) is never split at random and never used as a training row set |
| Rithmm's methodology is not disclosed and could not be fetched (§2) | Nothing from Rithmm is used. Only its product concept (model vs market difference) is mirrored, and here it is gated: value claims stay off until the model is tested against timestamped prices |
| nba_api's MIT licence covers the client, not NBA.com data; NBA.com terms restrict commercial use (§3) | stats.nba.com is not used. Data comes from sportsdataverse `hoopR-nba-data` (public ESPN-derived parquet); its licence notice is printed on every artifact and commercial use is listed as an owner decision (`nba/config.js` LICENSE) |
| One canonical possession estimator (§4) | The BBRef team/opponent average, used everywhere (`nba/ingest/season.js possEst`) |
| Four Factors weights are ad hoc (§4) | Factor ratings are features; their weights are learned in the walk-forward, never hard-coded |
| Elo / Glicko as baselines (§5.1) | Candidate A (`nba/model/ratings.js` Elo, Glicko), tuned on the selection window |
| Opponent-adjusted possession efficiency (§5.2) | Candidate B (`Adjusted`: recency-weighted least squares for offence, defence, pace and each factor) |
| RAPM with out-of-sample-tuned ridge (§5.3) | Candidate C (`nba/model/players.js`: ridge on stints by conjugate gradient, λ chosen on the selection window; availability × minutes give the team number) |
| State-space strength with uncertainty (§5.4) | Candidate F (`Kalman`: dynamic linear model with full covariance and between-season carry) |
| Brownian / normal margin, endgame fouling fattens tails (§5.5) | `nba/model/distribution.js`: discretised normal reshaped by fitted end-game weights, a heteroscedastic σ, an overtime mixture; candidate D is a possession simulation |
| Calibration beats accuracy for selection; market is the hard benchmark (§5.6, §5.9) | Model choice by log loss with a margin rule; calibration reported by bins and slope; markets are reported as NOT TESTED until timestamped prices exist |
| Shot quality / shooting luck regresses (§5.7) | Location-only expected eFG from play-by-play shot zones; luck terms (actual − expected) are features |
| Props: minutes × rate, NB counts, correlated combos (§5.8) | `nba/props/model.js`: ridge minutes, Poisson rates with a log-minutes offset, NB dispersion, residual correlations for PRA/PR/PA/RA, a Gaussian copula for double/triple doubles |


Evidence labels used below:
- **[FETCHED]**: I read the primary text myself (raw file or page).
- **[SEARCH-EXTRACT]**: The primary page could not be fetched. The content comes from search-engine extracts or summaries of that page, so it may be paraphrased, truncated or out of date.
- **[KNOWLEDGE]**: Background knowledge that I could not re-verify in this session. Check it before relying on it.

---

## 0. Access notes (read first)

The sandbox allowed only a few hosts: github.com, raw.githubusercontent.com and pypi.org. Every other host failed, either with `getaddrinfo ENOTFOUND` in the fetch tool or with `CONNECT 403` at the egress proxy. Hosts that failed include:

- rithmm.com (both posts)
- nba.com and cdn.nba.com (glossary and terms of use)
- basketball-reference.com
- fivethirtyeight.com
- wikipedia.org
- arxiv.org
- sciencedirect.com
- sloansportsconference.com
- kenpom.com
- glicko.net
- web.archive.org

As a result:
- **Rithmm posts: NOT fetched.** Section 2 relies only on search extracts.
- **NBA.com glossary and terms of use: NOT fetched.** Formulas in section 4 come from Basketball-Reference glossary and NBA.com text as surfaced by search extracts. Each one is labelled.
- Literature citations were checked through search extracts of publisher, RePEc or university records, not full texts. Exact numbers are quoted only where an extract gave them, and they are labelled.

---

## 1. AnzaAbbasi/Sports-Betting-Model [FETCHED]

**Sources:** https://github.com/AnzaAbbasi/Sports-Betting-Model and raw files from `raw.githubusercontent.com/AnzaAbbasi/Sports-Betting-Model/main/` (`README.md`, `Model_training.py`, `Profit_testing.py`, `LICENSE`).

### What is in the repo
- **Files:** README, LICENSE, two Python fragments and five PNG plots (calibration curve, logistic-regression summary, model vs. Pinnacle scatter, cumulative-profit plot).
- **Activity:** 2 commits, 0 stars, 0 forks at fetch time.
- **README title:** "Profitable-Sports-Betting-Model-Results".
- **Licence:** MIT, "Copyright (c) 2025 throwawayhub25". The copyright handle differs from the repo owner's name.
- **Scope of the licence:** It covers only the code fragments. No data is included.

### Model disclosed
- **Model class:** None. The README says "Hyperparameters and model specifics are not disclosed", and the code calls an undefined `my_classifier_model`.
- **Market:** NBA full-game moneyline.
- **Languages:** The README says "R and Python".

### Features
- **None disclosed.** The README says it shows "ONLY THE RESULTS of the model NOT THE FEATURE ENGINEERING PROCESS".
- The code uses anonymised columns: target `col_1`, and `col_39` as the sportsbook implied probability, which is dropped from the features.
- The README claims "All feature engineering processes generated lagged variables … to prevent data leakage." This cannot be checked.

### Train/test split
- **Random, not chronological.** The code calls `train_test_split(X, y, test_size=0.2)` with no `random_state` and the default `shuffle=True`.
- The README states: "All of the analysis and backtesting was performed on a randomly selected 20% subset (test data)."
- **Test-set size is inconsistent.** The README gives "roughly 1700-2500 games". A code comment gives "approximately 3550 samples".
  - Inference (not confirmed): 3550 rows ≈ 2 × 1775 games. That would fit one row per team per game, and the README's "test set is indeed balanced at approx 50% win/lose teams" fits the same pattern.
  - If the data does have mirrored rows, a random split can place a game's mirror row, with the label flipped, in the training set. That is direct label leakage.
- **Calibration, significance testing and profit testing all use the same 20% test set.**
  - The plotted probabilities are named `model_fitted_calibrated`. The calibration procedure, and the data it was fitted on, are not shown.
  - The "logistic regression of the model's predictions … against the true outcome" is run on the test set itself.

### Odds and line-shopping assumptions
- **Odds source:** Historical Pinnacle moneylines "scraped from the oddsportal website". Whether these are opening or closing prices is not stated, and there are no timestamps.
- **Bet filter:** `model_predicted_prob > pinnacle_implied_probability`. The implied probability still includes the vig.
- **Payouts:** Computed by `my_odds_to_payout_function(pinnacle_implied_probability)`, which is not shown.
- **Line shopping:** The README says it "made a small (but significant) adjustment to the odds by accounting for … 'line shopping'" across Circa, Westgate, MGM, Caesars, William Hill and STN.
  - In the code, `line_shopped_value = .02` is assigned but **never used** in the filter or the payout.
  - The README also says bets are considered where the model beats "the implied probability of **any** sportsbook". Picking the best of many books is a selection effect, and there is no historical multi-book data to back it.
- **Staking:** Flat 1 unit. No limits, delays or rejected bets are modelled.

### Claimed results (quoted from the README)
- "This model consistently achieves around 10% ROI."
- "63% raw accuracy", with the coefficient p-value reported as ".000".
- "Positive ROI of between 9-12% is obtained after ~1500 bets."
- "Repeated testing on different subsets of randomly selected test data returns similar results!"
- **Self-undermining admission:** "pinnacle's implied probabilities do indeed obtain a lower log loss than my model."
  - So by the README's own account, the model is a worse probability forecaster than the price it claims to beat by about 10%.
  - The README attributes the gap to vig. Vig does not lower the market's log loss, and normalised (de-vigged) probabilities would score even better.

### Why the claims cannot be independently verified
1. No data, no features, no model class and no hyperparameters are disclosed. The scripts are fragments that reference undefined objects: `df`, `my_classifier_model`, `x_test_`, `model_fitted_calibrated` and `my_odds_to_payout_function`.
2. The split is random rather than walk-forward, so information from later in a season leaks into training. Possible mirror-row leakage is described above.
3. Calibration, evaluation and bet selection happen on the same sample. "Repeated testing on different subsets" is a forking-paths problem.
4. The line-shopping uplift the README describes does not appear in the shown backtest. Multi-book "any sportsbook" pricing has no historical data behind it.
5. Odds timing (open or close) is unknown, there is no CLV analysis, and there is no confidence interval.
   - Illustrative arithmetic (mine, not from the repo): flat bets near even money have a per-bet return SD of about 1 unit. Over 1,500 bets the SE of ROI is therefore about 1/√1500 ≈ 2.6 percentage points.
   - That makes 10% about 4 SE, but only under independence and no selection. Neither holds here.
6. Scraping OddsPortal raises its own terms-of-use and data-quality questions.

**Evidence strength: very weak (anecdotal).** Use it only as a list of anti-patterns.

---

## 2. Rithmm: "Building an NBA Betting Model" and "How our NBA model works…" [NOT FETCHED; SEARCH-EXTRACT only]

**URLs:**
- https://www.rithmm.com/post/building-an-nba-betting-model
- https://www.rithmm.com/post/how-our-nba-model-works-see-metrics-that-drive-edge-and-test-them

Both failed with DNS errors in the fetch tool and 403 at the egress proxy, and no archive mirror was reachable. Everything below is second-hand. A search extract states that **the second post was not found in search results at all**, so I have no content for it.

### What search extracts attribute to Rithmm (marketing, not evidence)
- **"Building an NBA Betting Model"** (search extract dates it Oct 21, 2024) is an app-workflow tutorial: open the NBA section, then "Models", then "Personalize a Model", pick variables, and backtest. The app "automatically compares your model's predictions to actual game results".
- **Inputs mentioned on Rithmm pages:**
  - Weighting factors such as "pace, defensive rating, usage, foul rate".
  - "Recent team form, matchup-based metrics, home/away splits, pace of play, and shooting efficiency".
  - "Player stats, matchups, line movement, and historical trends".
  - "NBA player impact adjustments" (Premium tier).
- **"Edge" / "DTM (Difference to Market)":** The gap between model win probability and the probability implied by the current sportsbook price. EV is calculated against the user's default sportsbook odds.
- **Simulation:** Rithmm's MLB pages describe simulating each game "thousands of times". No equivalent NBA statement was confirmed.
- **Third-party:** BetSmart review (https://www.betsmart.co/tool-reviews/rithmm). Pricing figures differ between sources. A review aggregator reports users complaining about losses on "Smart Signals". This is anecdotal.

### Not disclosed, as far as I could determine (absence cannot be fully confirmed without the pages)
- Model class (regression, GBM, simulation).
- How user-chosen "weights" map to probabilities.
- Training window.
- Whether backtests are walk-forward or in-sample.
- Calibration metrics (log loss, Brier, ECE, reliability plots).
- Vig-removal method.
- Odds timestamps (open, bet-time or close).
- CLV.
- Sample sizes and confidence intervals.
- Injury and lineup handling details.

**Classification:** marketing. The feature lists match standard practice (pace, efficiency, rest, injuries), but there is no evidence of out-of-sample performance.

**Action:** If Rithmm matters for competitive positioning, fetch the two posts from an unrestricted network and update this section.

---

## 3. Data access and licensing: swar/nba_api, NBA.com, Basketball-Reference

### swar/nba_api [FETCHED]
- **README:** "`nba_api` is an API Client for `www.nba.com`."
- **Requirements:** Python 3.10+, `requests` and `numpy`. Pandas is optional.
- **Latest release on PyPI:** 1.11.4, released 2026-02-20 (fetched from pypi.org).
- **Licence:** MIT, "Copyright (c) 2018 Swar Patel".
- **The README itself separates the client from the data:**
  > "## API Client Package — The `nba_api` package is Open Source with an MIT License."
  > "## NBA.com — NBA.com has a Terms of Use (https://www.nba.com/termsofuse) regarding the use of the NBA's digital platforms."

  The MIT licence covers the wrapper code only. **It grants no rights to NBA.com data.**
- **Endpoints are undocumented and can change:** "NBA.com does not provide information regarding new, changed, or removed endpoints."
- **Operational risk [SEARCH-EXTRACT]:**
  - Several community clients (abresler/nba, bttmly/nba) report that stats.nba.com silently drops or hangs requests from cloud (AWS/GCP/Azure) IP ranges and uses Akamai bot protection.
  - nba_api issue #176 is titled with a stats.nba.com read-timeout error.
  - A cloud-hosted production pipeline should not rely on it.

### NBA.com Terms of Use [NOT FETCHED; SEARCH-EXTRACT]
- Search extracts of the "NBA Statistics" clause say NBA statistics may only be used for **"legitimate news reporting or private, non-commercial purposes"**. They also say the statistics may not be used with any fantasy game, commercial product or service, or with a site or product featuring a comprehensive, regularly updated statistics database **without express prior consent**, and that prominent attribution to NBA.com is required.
- The WNBA.com copy of the same section reportedly also lists **gambling** among prohibited uses. I could not confirm whether the current NBA.com text says this.
- A separate passage limits downloads to personal, non-commercial use.

**Implication:** A commercial pricing engine needs a licensed data feed (for example an official league data distributor) or legal sign-off. The exact text must be read from an unrestricted network. This is not legal advice.

### Basketball-Reference / Sports-Reference [SEARCH-EXTRACT]
- **Bot-traffic page** (https://www.sports-reference.com/bot-traffic.html, header dated 2024-05-29): requests to Basketball-Reference faster than **20 per minute** get the session "in jail for up to a day". The limit is 10 per minute for FBref and Stathead.
- The same page says much of the data is licensed from third parties, which is why bulk downloads are not offered.
- A separate Data Use policy exists. I could not read its commercial-use terms.

---

## 4. Box-score efficiency formulas

The NBA.com glossary was unreachable. The **primary source used is the Basketball-Reference glossary** (https://www.basketball-reference.com/about/glossary.html) and its Four Factors page (https://www.basketball-reference.com/about/factors.html), as surfaced by search extracts. NBA.com wording is noted where an extract gave it.

| Stat | Formula | Source / status |
|---|---|---|
| Possessions (team, BBRef) | `0.5 * ((Tm FGA + 0.4*Tm FTA − 1.07*(Tm ORB/(Tm ORB + Opp DRB))*(Tm FGA − Tm FG) + Tm TOV) + (Opp FGA + 0.4*Opp FTA − 1.07*(Opp ORB/(Opp ORB + Tm DRB))*(Opp FGA − Opp FG) + Opp TOV))` | BBRef glossary. Search extract confirmed the terms and the averaging of the team and opponent estimates. Exact layout is from [KNOWLEDGE]. |
| POSS (NBA.com) | Defined in words: "the number of possessions played by a team or player". The glossary notes an offensive rebound does not create a new possession. No estimator formula appeared in the extract. | NBA.com glossary [SEARCH-EXTRACT]. NBA.com possession counts will not exactly match box-score estimators. |
| Possessions (simple, KenPom/college) | `FGA − OR + TO + 0.475*FTA` | kenpom.com glossary [SEARCH-EXTRACT]. The 0.44 vs 0.475 FTA coefficient differs by source and league. |
| PACE | `48 * ((Tm Poss + Opp Poss) / (2 * (Tm MP / 5)))` | BBRef glossary, confirmed [SEARCH-EXTRACT]. NBA.com defines PACE in words as possessions per 48 minutes. |
| OFFRTG (team) | `100 * PTS / POSS` | NBA.com glossary [SEARCH-EXTRACT]. BBRef's *individual* ORtg is Oliver's points-produced metric (https://www.basketball-reference.com/about/ratings.html), which is a different quantity. |
| DEFRTG (team) | `100 * Opp PTS / Opp POSS` | NBA.com glossary [SEARCH-EXTRACT]. |
| NETRTG | `OFFRTG − DEFRTG` | NBA.com glossary [SEARCH-EXTRACT]. |
| eFG% | `(FG + 0.5 * 3P) / FGA` | BBRef Four Factors page [SEARCH-EXTRACT]. |
| TS% | `PTS / (2 * TSA)`, where `TSA = FGA + 0.44 * FTA` | BBRef glossary and BBR blog. NBA.com reportedly matches: `PTS / [2*(FGA + 0.44*FTA)]` [SEARCH-EXTRACT]. |
| TOV% | `100 * TOV / (FGA + 0.44*FTA + TOV)` | BBRef glossary [SEARCH-EXTRACT]. NBA.com also reports a different "TO Ratio": `(TOV*100) / (FGA + 0.44*FTA + AST + TOV)` (NBA.com FAQ [SEARCH-EXTRACT]). Do not mix the two. |
| ORB% (player) | `100 * (ORB * (Tm MP/5)) / (MP * (Tm ORB + Opp DRB))` | BBRef glossary [SEARCH-EXTRACT]. Team version: `ORB / (ORB + Opp DRB)` (Four Factors). |
| DRB% (player) | `100 * (DRB * (Tm MP/5)) / (MP * (Tm DRB + Opp ORB))` | BBRef glossary [SEARCH-EXTRACT]. Team version: `DRB / (Opp ORB + DRB)` (Four Factors page). |
| TRB% / REB% (player) | `100 * (TRB * (Tm MP/5)) / (MP * (Tm TRB + Opp TRB))` | BBRef glossary [KNOWLEDGE, not re-verified]. |
| FTA rate (FTr) | `FTA / FGA` | BBRef glossary [KNOWLEDGE]. Note that BBRef's Four Factors page uses **`FT / FGA`** (made FTs) as the free-throw factor [KNOWLEDGE]. Choose one and document it. |
| USG% | `100 * ((FGA + 0.44*FTA + TOV) * (Tm MP/5)) / (MP * (Tm FGA + 0.44*Tm FTA + Tm TOV))` | BBRef glossary [SEARCH-EXTRACT]. |
| AST% | `100 * AST / (((MP / (Tm MP/5)) * Tm FG) − FG)` | BBRef glossary [SEARCH-EXTRACT]. An extract claimed NBA.com uses a simpler form; unverified. |
| PIE (NBA.com) | `(PTS + FGM + FTM − FGA − FTA + DREB + 0.5*OREB + AST + STL + 0.5*BLK − PF − TO) / (GmPTS + GmFGM + GmFTM − GmFGA − GmFTA + GmDREB + 0.5*GmOREB + GmAST + GmSTL + 0.5*GmBLK − GmPF − GmTO)` | NBA.com glossary, formula matched by search extract. PIE is a share of game events and is descriptive, not a predictive impact metric. |

### Four Factors weights
Oliver's approximate weights: shooting 40%, turnovers 25%, rebounding 20%, free throws 15% (BBRef Four Factors page [SEARCH-EXTRACT]).

They are ad hoc. arXiv:2305.13032, "Dean Oliver's Four Factors Revisited" (2023; authors not verified), calls them "somewhat ad hoc" and cites a regression by Jacobs giving 46/35/12/7. **Fit weights empirically; do not hard-code 40/25/20/15.**

**Recommendation:** Pick one canonical possession estimator for the whole engine, version it, and use it consistently for pace, ratings and per-100 player rates. Never mix NBA.com-reported possessions with box-score estimates inside a single feature.

---

## 5. Literature summary

### 5.1 Elo / Glicko rating systems

**FiveThirtyEight NBA Elo** (Silver & Fischer-Baum, 2015, "How We Calculate NBA Elo Ratings", FiveThirtyEight, https://fivethirtyeight.com/features/how-we-calculate-nba-elo-ratings/). Not fetched. Parameters come from replications [SEARCH-EXTRACT] and [KNOWLEDGE].
- **Parameters:**
  - K = 20.
  - Home court = +100 Elo.
  - MOV multiplier `((MOV+3)^0.8) / (7.5 + 0.006 × EloDiff_winner)`.
  - Between seasons a team keeps 75% of its rating and regresses 25% toward 1505. One replication says it regresses toward the conference mean instead, so this is unresolved.
  - The Elo-to-point-spread divisor (commonly cited as 28) was **not confirmed**.
- **Data:** Game results and margins only.
- **Limitations:**
  - Team-level only, so it cannot see injuries, rest, trades or load management. A replication blog argues +100 home court is too high for recent eras.
  - FiveThirtyEight itself later moved to player-based ratings (CARMELO, then RAPTOR) for NBA forecasts [KNOWLEDGE; dates unverified].
- **Deprecation:**
  - FiveThirtyEight stopped sports coverage in 2023 when Nate Silver left and Disney cut staff (Front Office Sports, FlowingData, Nieman Lab per [SEARCH-EXTRACT]). The brand was later shut down by ABC News; the exact date was not confirmed here.
  - Neil Paine's GitHub archive (https://github.com/Neil-Paine-1/NBA-elo) [FETCHED] calls RAPTOR "formerly found at FiveThirtyEight.com". It publishes "Estimated RAPTOR", a box-score regression onto full RAPTOR: for players with 1,000+ minutes, correlations with full RAPTOR over 2014–2023 were 0.913 offense, 0.784 defense and 0.890 overall.
  - FiveThirtyEight's data repos (`fivethirtyeight/data/nba-elo`, `fivethirtyeight/nba-player-advanced-metrics`) remain on GitHub [FETCHED]. The Elo CSV has one row per team per game with an `_iscopy` flag, the same mirror-row structure that causes leakage in naive random splits.
- **Evidence strength:** Moderate. A widely used, transparent baseline, but not peer-reviewed. Expect it to be beaten by player-aware models and by the market.

**Glicko** (Glickman, M.E., 1999, "Parameter estimation in large dynamic paired comparison experiments", *JRSS Series C (Applied Statistics)* 48(3):377–394, doi:10.1111/1467-9876.00159; https://ideas.repec.org/a/bla/jorssc/v48y1999i3p377-394.html) [SEARCH-EXTRACT].
- **Core idea:** Adds a rating deviation (RD), an uncertainty term, to Elo. Updates are larger when uncertain, and RD grows during inactivity.
- **Glicko-2:** Adds rating volatility (Glickman 2001, *J. Applied Statistics* 28(6) [KNOWLEDGE]).
- **Data:** Results only.
- **Use for EdgeDesk:** A principled way to widen early-season and post-trade uncertainty.
- **Limitations:** Designed for large chess-style pools. The NBA has only 30 teams with dense schedules, so the gain over a well-tuned Elo or state-space model is modest.
- **Evidence strength:** Strong as statistics; NBA-specific evidence is limited.

### 5.2 Possession-based efficiency

**Oliver, D. (2004), *Basketball on Paper: Rules and Tools for Performance Analysis*, Potomac Books** [KNOWLEDGE for publisher; one secondary source misdates it to 2002].
- **Core idea:** Evaluate teams per possession. Four Factors (shooting, turnovers, offensive rebounding, free throws) for offense and defense.
- **Data:** Team box scores.
- **Limitations:** Descriptive; the weights are ad hoc (see section 4).
- **Evidence strength:** Foundational and widely adopted. The weights are weak evidence.

**Kubatko, J., Oliver, D., Pelton, K., Rosenbaum, D.T. (2007), "A starting point for analyzing basketball statistics", *JQAS* 3(3)** (doi 10.2202/1559-0410.1070 [KNOWLEDGE]; record at https://sponet.de/sponet/Record/4013456) [SEARCH-EXTRACT].
- **Core idea:** Brings possession estimation, ratings, pace adjustment, Four Factors and plus/minus into a peer-reviewed venue. Shows that most earlier possession formulas are special cases of a general form, and derives the 0.44 FTA coefficient.
- **Limitations:** A later critique, cited in an extract, argues the regression-based possession formula may be mis-specified in its treatment of offensive rebounds.
- **Evidence strength:** Strong as a definitional reference.

**KenPom-style adjusted efficiency** (Pomeroy, kenpom.com "Ratings methodology" and glossary, https://kenpom.com/blog/ratings-methodology/ and https://kenpom.com/blog/ratings-glossary/) [SEARCH-EXTRACT].
- **Core idea:** Iterative opponent adjustment of points per 100 possessions, adjusted for site and recency-weighted. The current version treats team effects as additive rather than multiplicative. Adjusted tempo is handled the same way. The older Pythagorean exponent was 11.5 (college).
- **Data:** Box scores and schedule.
- **Limitations:**
  - Built for NCAA, where schedules are unbalanced. NBA schedules are near-balanced, so schedule adjustment matters less, while lineup and injury variation matters more.
  - Team-level only.
- **Evidence strength:** Strong practitioner track record in college basketball, but proprietary details.

**Directly usable formulation:**
- Expected points = pace × efficiency, with
  - `E[Poss] ≈ f(pace_A, pace_B, league pace)`
  - `E[PPP_A] ≈ league + off_A − def_B (+ home)`
- Spread and total follow from these. Opponent adjustment can be done by ridge or least squares on game-level points per 100 possessions.

### 5.3 Adjusted plus-minus family

**Rosenbaum, D.T. (2004), "Measuring How NBA Players Help Their Teams Win", 82games.com, https://www.82games.com/comm30.htm** [SEARCH-EXTRACT].
- **Core idea:** APM. Least-squares regression of stint-level point margin per 100 possessions on indicators for players on court (home +1, away −1).
- **Data:** Play-by-play with lineups (stints).
- **Limitations:** Severe multicollinearity and high variance; estimates are unusable on a single season without regularisation.
- **Evidence strength:** Foundational.

**Sill, J. (2010), "Improved NBA Adjusted +/- Using Regularization and Out-of-Sample Testing", MIT Sloan Sports Analytics Conference** (https://www.sloansportsconference.com/research-papers/improved-nba-adjusted-using-regularization-and-out-of-sample-testing) [SEARCH-EXTRACT].
- **Core idea:** RAPM, meaning ridge regression (a Gaussian prior centred on 0), with the penalty tuned by **out-of-sample prediction of future games**. The abstract (per extract) says regularisation "nearly doubles" accuracy; the exact metric was not verified.
- **Why it matters here:** Sill's evaluation principle, judging by out-of-sample predictive accuracy, is the same discipline EdgeDesk needs.
- **Reference implementation:** Ryan Davis, https://github.com/rd11490/NBA_Tutorials/tree/master/rapm (MIT) [FETCHED]. It builds a sparse design matrix with one offence and one defence column per player, a target of points per 100 for each possession, and `RidgeCV`.
- **Evidence strength:** Strong. It is the standard method and is replicated.

**Engelmann's xRAPM, ESPN RPM, box-score-prior RAPM** [SEARCH-EXTRACT]:
- **Core idea:** Instead of shrinking toward 0, shrink toward a prior built from box-score and play-by-play stats (a statistical plus-minus regressed on long-run RAPM), often with multi-year data.
- **History:** ESPN's Real Plus-Minus was developed by Jeremias Engelmann with Steve Ilardi from xRAPM, and was later regenerated by ESPN Analytics with tracking data ("RPM 2.0").
- **Limitations:** The prior specifications are **not public**; FanSided (2016) notes the RPM prior factors are undisclosed.
- **Evidence strength:** Moderate. Practitioner consensus that priors improve prediction, but the details are proprietary.

**Box Plus/Minus 2.0** (Daniel Myers; Basketball-Reference, https://www.basketball-reference.com/about/bpm2.html; Sports-Reference blog, Feb 2020) [SEARCH-EXTRACT].
- **Core idea:** Box-score-only estimate of a player's points per 100 possessions relative to average, using position and team adjustment. The coefficients are fit to long-run RAPM data, which forum sources describe as built on NBA RAPM; I could not read Myers's full explainer.
- **Data:** Box score, position and team rating. Available back to 1973-74.
- **Limitations:**
  - Box scores capture defence poorly.
  - Being descriptive, it has no aging or regression to the mean.
- **Evidence strength:** Moderate. Transparent, but in-sample-fit to RAPM.

**EPM (Estimated Plus-Minus)**, Taylor Snarr, Dunks & Threes (https://dunksandthrees.com/epm) [SEARCH-EXTRACT; methodology page not read].
- **Core idea:** A predictive blend of a custom RAPM with statistical plus-minus (box score plus tracking and play-by-play), described as optimised for prediction.
- **Limitations:** Proprietary details; commercial data terms.
- **Evidence strength:** Moderate. It has a good public reputation, but I saw no peer-reviewed validation.

**Use for EdgeDesk:** Player ratings (RAPM with a box prior) × projected minutes give lineup-adjusted team ratings. This is the main route to pricing injuries and rest, which Elo cannot do.

### 5.4 Bayesian and state-space team strength

**Glickman, M.E. & Stern, H.S. (1998), "A state-space model for National Football League scores", *JASA* 93(441):25–35** [volume and pages from KNOWLEDGE; title and model confirmed by SEARCH-EXTRACT].
- **Core idea:** Team strengths evolve as an AR(1)-type random walk within and between seasons, with a normal model for point differential. Fit by MCMC.
- **Data:** Scores and home/away.
- **Evidence strength:** Strong, peer-reviewed. NFL rather than NBA, but the structure transfers.

**Baio, G. & Blangiardo, M. (2010), "Bayesian hierarchical model for the prediction of football results", *J. Applied Statistics* 37(2):253–264, doi:10.1080/02664760802684177** [SEARCH-EXTRACT].
- **Core idea:** Hierarchical Poisson model of attack and defence, with partial pooling and a mixture to counter overshrinkage.
- **Relevance:** Soccer. The overshrinkage lesson applies to extreme NBA teams.
- **Evidence strength:** Strong for its domain.

**NBA-specific papers:**
- **Manner, H. (2016), "Modeling and forecasting the outcomes of NBA basketball games", *JQAS* 12(1):31–41, doi:10.1515/jqas-2015-0088** [SEARCH-EXTRACT].
  - Adds heteroscedasticity and dynamic state-space team strengths.
  - Finds "forecasts struggle to beat the betting market", while a combination of model forecasts with betting odds gives "slight improvements".
  - **Directly relevant evidence: the market is a hard benchmark.**
- **Lopez, M.J., Matthews, G.J., Baumer, B.S. (2018), "How often does the best team win? A unified approach to understanding randomness in North American sport", *Annals of Applied Statistics* 12(4):2483–2516; arXiv:1701.05976** [SEARCH-EXTRACT].
  - Bayesian state-space model fit to **betting-market moneylines**.
  - Finds the NBA has the largest spread in team talent and the largest home advantage among the NFL, NHL, NBA and MLB, studied over a decade.
- **Higgs, N. & Stavness, I. (2021), "Bayesian analysis of home advantage in North American professional sports before and during COVID-19", *Scientific Reports* 11:14521, doi:10.1038/s41598-021-93533-w** [SEARCH-EXTRACT].
  - Multilevel model; finds NBA home advantage dropped in the restricted-attendance (bubble) period.
  - Search extracts conflicted on whether NBA scores showed overdispersion (Poisson vs NB); check the paper.
  - **Implication:** Home advantage is time-varying and should be estimated, not fixed.
- **Attard, Suda & Sammut (2023)**, "Bayesian Hierarchical Modelling of Basketball Team Performance: An NBA Regular Season Case Study", SCITEPRESS (https://www.scitepress.org/Papers/2023/121591/121591.pdf) [SEARCH-EXTRACT].
  - Models FT, 2P and 3P scoring separately; reports that a negative binomial fit better than Poisson on 2008/09 data.
  - **Evidence strength:** Weak-moderate (conference paper, single season).

**Use for EdgeDesk:** A dynamic Bayesian model gives calibrated *uncertainty* on team strength, useful early in the season and after trades, and a clean way to blend priors such as preseason market win totals.

### 5.5 Game and possession simulation

**Stern, H.S. (1994), "A Brownian motion model for the progress of sports scores", *JASA* 89(427):1128–1134** (https://www.stat.berkeley.edu/~aldous/157/Papers/stern.pdf) [SEARCH-EXTRACT].
- **Core idea:** The home-minus-away score difference follows a Brownian motion with drift. This gives a closed-form in-game win probability from the current lead and the time remaining.
- **Data:** Fit to 493 NBA games from 1991–92.
- **Implications:** Supports a **normal approximation for final margin** and the conversion spread ↔ win probability via Φ(μ/σ).
- **Limitations:** Ignores possession discreteness, endgame strategy (fouling, timeouts) and score-dependent pace.
- **Follow-ups:** Polson & Stern (2015), market-implied volatility from lines [KNOWLEDGE for the year].
- **Evidence strength:** Strong, classic.

**Štrumbelj, E. & Vračar, P. (2012), "Simulating a basketball match with a homogeneous Markov model and forecasting the outcome", *Int. J. Forecasting* 28(2):532–542** [SEARCH-EXTRACT].
- **Core idea:** A possession-based Markov chain of game events. The transition matrix is estimated from play-by-play, or indirectly from team summary stats.
- **Findings (per extract):**
  - Forecasts are "comparable" to logit regression and latent-strength methods.
  - **"Bookmaker odds were the best probabilistic forecasts."**
- **Follow-up:** Vračar, Štrumbelj & Kononenko (2016), "Modeling basketball play-by-play data", *Expert Systems with Applications* 44:58–66, which adds game-clock dependence.
- **Data:** Play-by-play.
- **Evidence strength:** Strong (IJF). Notably, it shows the market beating the model.

**Late-game fouling and endgame:**
- **Kenter, F.H.J. (2015)**, "An analysis of the basketball endgame: When to foul when trailing and leading", 9th MIT Sloan SAC (https://www.stat.berkeley.edu/~aldous/157/Papers/kenter.pdf) [SEARCH-EXTRACT]. Uses combinatorial-game and play-by-play analysis (2007–2014); suggests teams should foul earlier and more often.
- **"Evaluating NBA end-of-game decision-making"**, *J. Sports Analytics* 5(1):17–22 (2019), doi:10.3233/JSA-180231 (authors not verified). Proposes the End-of-game Tactics Metric, built on a logistic win-probability model.
- **Relevance to EdgeDesk:** Endgame fouling inflates **totals and margins in close games**, through extra free throws and extended possessions, and fattens the tails of the margin distribution. A pure Brownian or normal model under-represents this, which matters for totals, alternate lines and live markets.
- **Evidence strength:** Moderate.

### 5.6 Gradient boosting / calibrated classifiers and betting evaluation

**Walsh, C. & Joshi, A. (2024), "Machine learning for sports betting: should model selection be based on accuracy or calibration?", *Machine Learning with Applications* 16:100539, doi:10.1016/j.mlwa.2024.100539; arXiv:2303.06021; code https://github.com/conorwalsh99/ml-for-sports-betting (MIT, archived 2025-02-12)** [README and config FETCHED; paper SEARCH-EXTRACT].
- **Features (from `config.toml`):** Team box-score and advanced stats (FG, FG%, 3P, 3P%, FT, FT%, ORB, DRB, AST, STL, BLK, TOV, PF, TS%, eFG%, 3PAr, FTr, ORB%, DRB%, TRB%, AST%, STL%, BLK%, TOV%, ORtg, DRtg) plus `previous_win_pct`; target `home_victory`.
- **Original claim:** Selecting by calibration rather than accuracy gave average ROI +34.69% vs −35.17%, and best case +36.93% vs +5.56%.
- **A corrigendum exists.** The repo README cites doi:10.1016/j.mlwa.2025.100627; ScienceDirect PII is S2666827025000106. Per extract, it revises:
  - Average ROI to **−9.77% (calibration) vs −26.78% (accuracy)**.
  - Best case to +23.13% vs +10.9%.
  - The best calibration-selected model to an MLP with classwise-ECE 3.52%.
  - It also states Kelly betting can fail even with a well-calibrated model.
- **Takeaways:**
  1. Calibration beats accuracy as a selection criterion.
  2. Even calibration-selected models **lost money on average** after correction.
  3. Headline ROI figures in this literature are fragile; this one was revised after unit testing.
- **Evidence strength:** Moderate for "prefer calibration". Weak for any profitability claim (single test season, corrected).

**Hubáček, O., Šourek, G., Železný, F. (2019), "Exploiting sports-betting market using machine learning", *Int. J. Forecasting* 35(2):783–796, doi:10.1016/j.ijforecast.2019.01.001; PDF http://ida.felk.cvut.cz/zelezny/pubs/ijf.2019.pdf** [SEARCH-EXTRACT].
- **Core idea:** Uses NBA data. Accuracy-optimised models converge toward the bookmaker's view, so the authors add a **decorrelation penalty** against bookmaker odds and bet only where model and market diverge, with a portfolio-style bet allocation.
- **Limitations:** I could not verify the reported profit figures. Results depend on the odds source and timing.
- **Evidence strength:** Moderate (peer-reviewed IJF), but profitability is period-specific.

**Wunderlich, F. & Memmert, D. (2020), "Are betting returns a useful measure of accuracy in (sports) forecasting?", *Int. J. Forecasting* 36(2):713–722, doi:10.1016/j.ijforecast.2019.08.009** [SEARCH-EXTRACT].
- **Finding:** Betting returns are **not** a valid measure of forecast accuracy, since profit can arise from inaccurate models and vice versa.
- **Implication:** Evaluate EdgeDesk by proper scoring rules (log loss, Brier) against de-vigged market probabilities, not by backtest ROI alone.
- **Evidence strength:** Strong methodological argument.

**General guidance:**
- Gradient boosting (XGBoost/LightGBM) on lagged team and player features works as a residual or market-adjustment learner.
- Calibrate with isotonic or Platt scaling on a **chronologically later** validation fold.
- Logistic regression on a few well-constructed ratings is a strong, hard-to-beat baseline.

### 5.7 Shot quality and expected points

**Chang, Y.-H., Maheswaran, R., Su, J., Kwok, S., Levy, T., Wexler, A., Squire, K. (2014), "Quantifying Shot Quality in the NBA", 8th MIT Sloan SAC** (2014 Best Paper per USC Viterbi) [SEARCH-EXTRACT].
- **Core idea:**
  - ESQ (Effective Shot Quality) is the expected eFG of a shot for a league-average shooter, from a regression on shot location and defender proximity (tracking data).
  - EFG+ = EFG − ESQ isolates shot-making from shot selection.
- **Second Spectrum commercial versions:** qSQ (quantified shot quality: per-shot make probability from shooter, defender and ball positions and velocities) and qSI (shooter impact) [SEARCH-EXTRACT; no official methodology page found].
- **Data:** Player-tracking data (SportVU from 2013-14, then Second Spectrum, now Hawk-Eye [KNOWLEDGE]). It is **not publicly licensed for commercial use**.
- **Use for EdgeDesk:**
  - Shooting luck (actual − expected eFG) regresses toward the mean, which is useful for team and player shooting regression.
  - Without tracking data, a location-only proxy can be built from play-by-play shot coordinates where licensed.
- **Limitations:** Proprietary data; defender-distance features are not public at shot level.
- **Evidence strength:** Moderate (conference paper; widely adopted in industry).

### 5.8 Player prop modelling

I found **no peer-reviewed paper** specifically on NBA player-prop pricing. Search returned blogs and vendor pages only. The following is standard practice, labelled by source.

- **Decomposition: stat = minutes × per-minute (or per-possession) rate × pace/context.**
  - Minutes are the dominant source of variance. They depend on role, injuries, blowout risk (game script ↔ spread), foul trouble, rest and back-to-backs.
  - Model minutes separately, for example with a mixture of "normal game" and "early exit", conditional on the spread.
  - Rates come from shrunken (empirical-Bayes) per-36 or per-100 rates, adjusted for opponent and pace.
  - [Engineering practice; consistent with the Stan model at https://medium.com/@BinomialBasketball/predicting-sensational-stats-pt-2-57c3628d6e1b using minutes as a Poisson offset [SEARCH-EXTRACT].]
- **Count distributions:**
  - Rebounds, assists, threes, steals and blocks are counts. Poisson is the baseline, and **negative binomial** handles overdispersion.
  - Practitioner reports: Poisson "never produced extreme lines" (BinomialBasketball pt 3); season-level makes are overdispersed (Squared Statistics, https://squared2020.com/2017/08/20/basics-in-negative-binomial-regression-predicting-three-point-field-goal-percentages/).
  - Points are a sum of 2P, 3P and FT made. Simulate components rather than fitting a single NB to points.
  - The dominant overdispersion source is uncertainty in minutes; mixing over minutes is often more correct than a fixed NB dispersion.
- **Correlation for same-game combos:**
  - Teammates' stats are positively correlated through pace and overtime, and negatively correlated through shared usage.
  - Player stats correlate with team total and margin.
  - The principled approach is a **joint game simulation**: sample pace, minutes and usage shares per simulation, then player events.
  - Copulas are an alternative, but simulation keeps everything consistent.
  - Vendor and blog sources claim books charge large margins on same-game parlays (figures of roughly 15–30% are cited without data [SEARCH-EXTRACT]). Treat these as unverified.
- **Evidence strength:** Weak (no peer-reviewed NBA prop literature found).
- **Validation:** Evaluate by CRPS or log score on the full distribution, and by calibration of over/under probabilities at the posted line, walk-forward.

### 5.9 Market efficiency of NBA betting lines

- **Gandar, J., Zuber, R., O'Brien, T., Russo, B. (1988), "Testing rationality in the point spread betting market", *Journal of Finance* 43(4):995–1008** [bibliographic data SEARCH-EXTRACT; co-authors KNOWLEDGE].
  - Studies the **NFL**, not the NBA [KNOWLEDGE]; cite it for method only.
- **Gandar, J.M., Dare, W.H., Brown, C.R., Zuber, R.A. (1998), "Informed traders and price variations in the betting market for professional basketball games", *Journal of Finance* 53(1):385–401** [SEARCH-EXTRACT].
  - NBA opening-to-closing line moves "significantly improve the accuracy of betting lines".
  - The size of line changes is proportional to biases in the opening line, and the moves are large enough to remove them by the close.
  - **Supports using the closing line as the efficiency benchmark.**
- **Paul, R.J. & Weinbach, A.P. (2005), "Bettor misperceptions in the NBA: The overbetting of large favorites and the 'hot hand'", *Journal of Sports Economics* 6(4):390–400** [SEARCH-EXTRACT].
  - Covers 1995-96 to 2001-02; finds overbetting of favourites.
  - Betting big home underdogs rejected the null of no profitability in that sample. Betting against winning streaks was also profitable.
  - Old sample, likely arbitraged since.
- **Paul, R.J., Weinbach, A.P., Wilson, M. (2004), "Efficient markets, fair bets, and profitability in NBA totals 1995-96 to 2001-02", *Quarterly Review of Economics and Finance* 44(4):624–632** [SEARCH-EXTRACT].
  - The public over-bets overs, increasingly at high totals, but this is **not profitable after commission**.
- **Paul & Weinbach (2008), "Price setting in the NBA gambling market: Tests of the Levitt model of sportsbook behavior", *International Journal of Sport Finance* 3(3):137–145** [SEARCH-EXTRACT]. Uses actual betting-percentage data; the public over-bias is not exploitable.
- **"Player absence and betting lines in the NBA", *Finance Research Letters* 13 (2015):130–136, doi:10.1016/j.frl.2015.02.004** (authors and findings not retrieved).
  - Directly relevant to injury pricing; read it in full.
- **Closing line / CLV:**
  - Practitioner analyses by Joseph Buchdahl (football-data.co.uk, https://football-data.co.uk/blog/pinnacle_efficiency.php) show realised yield tracking the closing-price-implied expected value with a slope of about 1 (one sample: about 20,000 bets, 3.4% realised vs 4.0% expected [SEARCH-EXTRACT]).
  - This is **practitioner evidence, mostly soccer, not peer-reviewed**.
  - Academic support for the close as the best forecast: Štrumbelj & Vračar (2012), where bookmaker odds were the best forecasts, and Manner (2016), where models struggle to beat the market.
- **Evidence strength:**
  - Strong that NBA closing lines are efficient forecasts and that historical anomalies are small or not exploitable after vig.
  - Moderate that CLV predicts long-run profit.

---

## 6. Decision-relevant implications for EdgeDesk

1. **The benchmark is the de-vigged closing line, not ROI.**
   - Report log loss and Brier score versus de-vigged close (strip the margin with proportional, Shin or power methods; document which).
   - Report CLV, measured as bet price vs closing price, as the primary edge metric.
   - Treat backtest ROI as secondary, with confidence intervals (Wunderlich & Memmert 2020).
2. **Walk-forward only.**
   - Use strictly chronological splits with features computed as of bet time. That includes injury-report timestamps and the odds snapshot time.
   - Deduplicate mirrored team-perspective rows; FiveThirtyEight's `_iscopy` and the AnzaAbbasi repo's apparent row count both point to this trap.
   - Never calibrate and evaluate on the same fold.
3. **Expect the market to win most of the time.** IJF and JQAS evidence (Štrumbelj & Vračar 2012; Manner 2016) shows bookmaker odds as the best or hard-to-beat forecasts. A realistic architecture uses the market as a prior or feature and models *deviations*: injury news before line moves, minutes changes, stale props. This is consistent with Hubáček et al. (2019) on decorrelation.
4. **Recommended model stack**, from the literature above:
   - Opponent-adjusted possession-based team ratings (off/def per 100, pace) via ridge or Bayesian state-space (5.2, 5.4).
   - Player ratings from RAPM with a box-score prior (5.3), with lineup-adjusted team strength = Σ(player rating × projected minutes share).
   - Margin modelled as approximately normal (Stern 1994), plus endgame-foul tail adjustments for totals and alternate lines (5.5).
   - A small calibrated GBM or logistic layer for residual effects (rest, travel, back-to-back, altitude), calibrated on a later fold (5.6).
   - Elo or Glicko as a sanity baseline only.
5. **Props:**
   - Model minutes first, then shrunken rates.
   - Use NB or simulation for counts.
   - Price combos only from a joint simulation that shares pace, minutes and overtime draws. No peer-reviewed NBA prop literature exists, so validation evidence has to be generated in-house.
6. **Data licensing is a blocker for a commercial product.**
   - nba_api's MIT licence covers the code only.
   - The NBA.com terms (per search extracts) restrict statistics to non-commercial use and require consent for commercial or database uses.
   - Basketball-Reference rate-limits (20 requests/min) and licenses data from third parties.
   - Plan for a licensed feed and confirm terms with counsel.
7. **Treat vendor and GitHub ROI claims as unverified marketing.** This covers the AnzaAbbasi repo (random split, undisclosed features, model worse than Pinnacle on log loss by its own admission) and Rithmm (no disclosed validation).

---

## 7. Open items to verify from an unrestricted network
- Rithmm posts (both): full text and any disclosed metrics.
- NBA.com glossary (exact formulas for POSS, OREB%, AST%, USG%, REB%) and NBA.com Terms of Use (exact NBA Statistics clause and any gambling clause).
- Basketball-Reference glossary: TRB% and FTr wording; BPM 2.0 explainer (fitting procedure).
- FiveThirtyEight Elo article: carryover target (1505 vs conference mean) and the Elo-to-spread divisor.
- Hubáček et al. 2019: seasons used and reported profit figures.
- "Player absence and betting lines in the NBA" (FRL 2015): authors and findings.
- Walsh & Joshi corrigendum text; the confirmed DOI is in the repo README.
