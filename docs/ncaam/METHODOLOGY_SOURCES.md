# Public Methodology Review: Men's College Basketball Ratings, Player Impact, Lineups, Win Probability

Compiled 2026-10-14 for a men's college basketball research engine (team ratings, player impact/RAPM, lineups, matchups).

---

## 0. Read this first: how the sources were accessed

**Most original pages could not be fetched from this environment.** The session's egress policy blocks direct HTTP access to almost every target host. WebFetch returned `getaddrinfo ENOTFOUND` and curl got a proxy `403 CONNECT rejected`. Blocked hosts include kenpom.com, barttorvik.com, adamcwisports.blogspot.com, evanmiya.com, blog.evanmiya.com, basketball-reference.com, sports-reference.com, arxiv.org, ar5iv, web.archive.org, 82games.com, sloansportsconference.com, stat.berkeley.edu, natesilver.net, tothemean.com, substack.com and Wikipedia. Only github.com, raw.githubusercontent.com and package registries were reachable.

Because of that, each claim below carries an evidence tag:

| Tag | Meaning |
|---|---|
| **[FULL]** | I read the full primary text myself. |
| **[SNIPPET]** | From the web-search tool's excerpts of the named original page (the author's own page), not a full read. Quoted phrases are as the search tool reported them and may be truncated or lightly paraphrased. Check them against the live page before treating them as verbatim. |
| **[SECONDARY]** | From a third-party write-up, forum post or wrapper library, not the methodology author. |
| **unverified** | Plausible or commonly repeated, but I could not confirm it in any source I could access. |

Full-text primary sources I read:
- Sill (2010) Sloan paper. Read as a PDF mirror on GitHub raw; the original Sloan host was blocked.
- toRvik R package source and README on GitHub. These are third-party wrappers around Torvik data.

Everything else is [SNIPPET] or [SECONDARY]. **Before you hard-code any constant, re-read the cited page in a browser.** Many of the KenPom and Torvik pages are 8 to 20 years old, and the authors themselves flag later changes.

---

## 1. KenPom (Ken Pomeroy, kenpom.com)

### 1(a). What is publicly documented

**Purpose of the ratings**
- The ratings are "designed to be purely predictive... to show how strong a team would be if it played tonight, independent of injuries or emotional factors." [SNIPPET, https://kenpom.com/blog/ratings-explanation/]
- "Adjusted" means "how a team would perform against average competition at a neutral site." [SNIPPET, same page]

**Original (pre-2016) opponent adjustment: multiplicative, game by game, recency-weighted**
- Old Ratings Explanation: "I compute an adjusted offensive efficiency for each game by multiplying the team's raw offensive efficiency by the national average efficiency and dividing by the opponent's adjusted defensive efficiency. The adjusted game efficiencies are then averaged (with more weighting to recent games) to produce the final adjusted offensive efficiency." [SNIPPET, https://kenpom.com/blog/ratings-explanation/]
- The page carries a header note: "[The ratings methodology was given a tweak before the 2014 season...]". [SNIPPET]
- The team-page help says the adjustment covers "the quality of opposing defenses, the site of each game, and when each game was played (recent games get more weight)." [SNIPPET, https://kenpom.com/blog/help-with-team-page/]
- The old home-court treatment was multiplicative: "I add 1.4% to the home team's OE and visiting team's DE, and subtract the same amount from the opposite parameters." [SNIPPET, ratings-explanation]
- The even older margin-based "Pomeroy Ratings FAQ" says: "This system applies a fixed home advantage for all teams... a home site advantage that I have calculated from previous seasons." [SNIPPET, https://kenpom.com/blog/pomeroy-ratings-faq/]
  - That page predates the efficiency ratings. Per the snippets, it describes the only inputs as margin and game site, and mentions a margin cap of about 16 points by season end. It is historical only.

**Pomeroy Ratings "version 2.0": game weighting and blowouts** (date unverified; old blog engine URL)
- The 2.0 change was introduced to handle "runaway scoring margins."
- Game weights depend on "how close the game was expected to be, how close the game actually was, and when the game was played."
- Effect: "games perceived by the system as big upsets get the most weight, while the influence of expected lopsided wins is minimized." His example is that a blowout of Grambling makes little difference to the rating whether the margin is 30 or 60.
- "Offense and defense ranges are narrower resulting from the decreased impact of outlier performances."
- [SNIPPET, https://kenpom.com/blog/pomeroy-ratings-version-2.0/ (also /pomeroy-ratings-version-2-0/)]

**Ratings methodology update** (appears in the October 2016 archive; exact date unverified)
- **The model became additive.** "In the new system, the effects of the two competing teams are considered to be additive rather than multiplicative."
  - His illustration: a 10% offensive edge and a 10% defensive edge combine to roughly a 20% expected advantage.
  - "Offense and defense are still rated independently, with each evaluated against the national average on the game date."
  - Per the snippets, offense and defense were weighted equally that season.
- **Recency and importance were softened.** "The weighting coefficients to handle recency and game importance have been changed. Essentially, recency is less important than it used to be and game importance is less sensitive to margin and opponent than it used to be."
- **AdjEM replaced Pyth.** "The Pyth column has been changed to AdjEM (adjusted efficiency margin)." AdjEM is the expected margin per 100 possessions against an average D-I team, and he calls it linear. He adds that it "also makes the SOS and average conference strength numbers less mysterious."
- **log5 was retired.** "dropping the pythagorean winning percentage as the team measure means that the days of estimating win probabilities using log5 are over." Win probabilities are now derived directly from the predicted margin of victory.
- **SOS uses WIN50.** SOS became an implementation of Jeff Sagarin's WIN50: "The SOS figure represents the strength of team that would be expected to win half its games against the team's schedule." He says this minimizes the effect of outliers and puts every team's SOS on the same scale.
- [SNIPPET, https://kenpom.com/blog/ratings-methodology-update/]

**Pythagorean exponent and log5 (historical)**
- The old explanation said the best exponent for adjusted efficiencies was between 11 and 12, and 11.5 was used at first. "Beginning with the 2012 season," the exponent became **10.25**, chosen by applying log5 to every game of the prior season and fitting expected winning percentages. [SNIPPET, ratings-explanation]
- The glossary formula is still `AdjO^11.5 / (AdjO^11.5 + AdjD^11.5)`. [SNIPPET, https://kenpom.com/blog/ratings-glossary/]
- One snippet said version 2.0 "raised the pythagorean exponent back to 11.5" to recalibrate log5. **The sequence of exponents is unverified.**
- Since about 2016, Pyth/log5 is not the stated win-probability engine (see above).

**Preseason ratings and how they phase out**
- **Current FAQ:** "The weight of the preseason ratings decreases through the season, going to zero after a team's 27th D-I game. The proper weighting has been determined from historical testing," and is designed so the prior neither holds a team back nor props it up. The same FAQ calls the ratings a proprietary algorithm. [SNIPPET, https://kenpom.com/contact.php]
- **Older rule (about 2010):** the preseason rating was worth "a little less than five games," dropped daily, and reached zero on January 23. [SNIPPET, https://kenpom.com/blog/what-happens-to-preseason-ratings-when-its-not-preseason-anymore/]
- **"Preseason ratings: Why weight?":** even after about 10 games the sample is too small, so preseason expectations still carry predictive value. "If the preseason ratings are weighted properly, then there shouldn't be a pattern to how these teams will trend from December 24 through the rest of the season." [SNIPPET, https://kenpom.com/blog/preseason-ratings-why-weight/]
- **2016 preseason model:** components and weights came from "a regression of the past nine seasons." It was calibrated on end-of-season ratings. Returning players are weighted by quality ("A low-usage inefficient role player that returns can actually hurt"). Per the snippets, all but 5-star recruits were "virtually ignored." [SNIPPET, https://kenpom.com/blog/2016-preseason-ratings/]
- **October 2016 update:** added transfers and injured players with prior D-I experience. His goal "evolved from trying to project end of season ratings to trying to predict how good a team is right now." [SNIPPET, https://kenpom.com/blog/preseason-ratings-now-with-transfers/]
- **2015 post:** a "team baseline + personnel" framing. The baseline uses the past five seasons plus the men's basketball budget for the two most recent seasons. [SNIPPET, https://kenpom.com/blog/preseason-ratings-2015/]
- **kPOY post:** the defensive value of departing players was estimated with a Dean Oliver "stops" share. [SNIPPET, https://kenpom.com/blog/introducing-the-kpoy/]

**Definitions**
- **AdjO / AdjD:** points scored or allowed per 100 possessions against an average D-I defense or offense. [SNIPPET, ratings-glossary]
- **AdjT:** possessions per 40 minutes "against the team that wants to play at an average D-I tempo." [SNIPPET, ratings-glossary]
- **Possessions:** "FGA-OR+TO+0.475xFTA"; the .475 "has been derived using play-by-play data." Possessions are counted for both the team and its opponent, then averaged. [SNIPPET, ratings-glossary / help-with-team-page / stats-explained]
- **Luck:** "the deviation between a team's actual winning percentage and what one would expect from its game-by-game efficiencies."
  - The old explanation names the "correlated gaussian method" and says Luck does not feed into the rating.
  - He describes the switch from a Pythagorean expectation to a Gaussian over game-level efficiencies as more accurate because teams "play to the level of the competition." [SNIPPET, ratings-glossary; ratings-explanation; https://kenpom.com/blog/?p=650]
- **Consistency:** "basically the standard deviation of scoring difference by game for a team," and not used in the ratings. [SNIPPET, ratings-explanation]
- **Old SOS:** opponents' average offensive and defensive ratings passed through the Pythagorean formula. This was superseded by WIN50. [SNIPPET]

**Home-court advantage research**
- Site-specific series: "the average team had a 'home-court advantage' of 3.75 points per game" over roughly 2002–2009. Team HCA estimates use the past six seasons to predict the next two, and the model includes elevation plus home edges in non-steal turnovers and blocks. He advises reading HCA rankings "in groups of three." [SNIPPET, https://kenpom.com/blog/how-to-measure-home-court-advantage/ and https://kenpom.com/blog/how-to-measure-site-specific-home-court-advantage-part-two/]
- A points-per-possession post lists season HCA of about 3.4 (2014) and 3.6 (2015). [SNIPPET, https://kenpom.com/blog/offense-vs-defense-points-per-possession/]
- **Unverified:** which HCA value or structure the current ratings use.

**Margin, blowouts and garbage time (evidence posts)**
- **Margin carries signal:** in same-season rematches, the relationship between first-game margin and second-game margin is "remarkably linear." [SNIPPET, https://kenpom.com/blog/evidence-that-scoring-margin-matters/]
- **Garbage time is measurable:** using last-5-minute margin to predict rematches, games tied with 5:00 left give a correlation of about 0.11 (about 0.15 for 0–5 point margins), and "by the time you get to 18 points the correlation is zero." [SNIPPET, https://kenpom.com/blog/the-simplest-proof-that-overtime-data-is-useful-and-that-garbage-time-exists/]
- **Overtime margin is weaker but real:** rematch correlation of about 0.16; each extra point of home regulation margin raises the expected road margin by about 0.36 points. [SNIPPET, https://kenpom.com/blog/the-predictive-value-of-overtime-margin/]

**Plus/minus in college**
- KenPom is "more than a little uncomfortable with using plus/minus data in college basketball analysis."
- In a simulated 20-game season, a zero-impact player showed −5.7 points per 40 minutes purely from randomness.
- [SNIPPET, https://kenpom.com/blog/a-treatise-on-plusminus/]

**Accuracy and calibration**
- The Model Diagnostics page reports MAE of predicted margin and totals, bias, and a reliability table for win probabilities. [SNIPPET, https://kenpom.com/blog/model-diagnostics/]
- An older prediction tracker said "The percentages given to winning in my system are a little too aggressive." [SNIPPET, https://kenpom.com/blog/prediction-tracker/]

### 1(b). What is not public or unknown
- The exact recency-weight function and how fast it decays, both before and after 2016.
- The "game importance" function: how weight depends on expected and actual margin and on the opponent.
- The current HCA used in the ratings: constant or team-specific, additive points or a percentage.
- The exact preseason weight path (only "zero after the 27th D-I game" is stated) and the current preseason regression coefficients.
- How a predicted margin is turned into a win probability: the distribution and the SD/scale. KenPom has not stated an SD in anything I could access.
- The current Luck formula (whether "correlated gaussian" still applies after 2016).
- The predicted-score formula. Combining expected efficiencies with predicted tempo is my inference, not a documented formula.
- How the iterative fit is solved (fixed-point or least squares) and its convergence details. The FAQ says the algorithm is proprietary.

### 1(c). Defensible implementation choices

**Model form: additive, as in KenPom's 2016 update**
- For each team-game, regress observed per-100 efficiency:
  `OE_obs(i vs j) = μ_date + O_i − D_j + h·site + ε`
  - Here μ_date is the national average for that date, and D_j is defined so that higher means better defense.
- Solve by weighted least squares. A ridge penalty toward preseason priors is mathematically equivalent to adding prior pseudo-games.
- This replaces KenPom's undocumented iteration with a transparent equivalent.

**Preseason prior**
- Treat it as pseudo-games whose weight declines to 0 by about the 27th D-I game (current KenPom FAQ).
- Tune the decay curve by backtest, using KenPom's "no trend after Dec 24" diagnostic as the target: residual movement should be unpredictable from prior-minus-current.

**Recency**
- Start with Torvik's public schedule (Section 2) or a mild exponential decay. KenPom says recency became *less* important after 2016, so test a light decay.

**Blowouts (option A or B, backtest both)**
- A: downweight games by expected-vs-actual margin, which is KenPom 2.0 in spirit.
- B: a garbage-time filter. KenPom's data shows remaining-margin predictiveness reaches about 0 at an 18-point lead with 5:00 left.

**Home-court advantage**
- Fit one league-wide HCA in the model. KenPom posts put it at about 3.4–3.75 points historically, but estimate it yourself by season.
- Add team-specific HCA only with heavy shrinkage. KenPom himself says the rankings are only meaningful in groups of three.

**Possessions:** use PBP-counted possessions where available. Otherwise use `FGA − OR + TO + 0.475·FTA`, averaged over both teams.

**Other outputs**
- **SOS:** WIN50, i.e. solve for the rating that gives an expected 0.500 record against the schedule. Optionally also report average opponent AdjEM.
- **Win probability:** from predicted margin with a Normal/probit link, σ fitted on your own residuals (see Section 6). Use Pythag (exponent of about 10–11.5) only as a display "vs average team" number.
- **Luck:** actual wins minus the sum of per-game win probabilities implied by each game's realized efficiencies. This follows KenPom's definition in spirit; the exact formula is unverified.

---

## 2. Bart Torvik / T-Rank (barttorvik.com; blog adamcwisports.blogspot.com)

### 2(a). What is publicly documented

**Core algorithm: multiplicative, iterated to convergence** (T-Rank FAQ, undated, about 2014–2018)
- Worked example: "assume the average PPP league wide is 100, and Team A scores 110 PPP against Team B, which has an Adj. DE of 90.0. Team A's Adj. OE for that game will be: 110 / (90 / 100) = 122.2."
- **Home court:** "If it's a home game, each team's Adj. OE and DE are adjusted by 1.4%." The snippets give 120.5 for the home case and 124.0 for the road case.
- **Iteration:** "you just keep doing it and doing it until the numbers stop changing"; then each team's per-game Adj. OE and Adj. DE are averaged.
- **Recency:** "all games in the last 40 days count 100%, then degrade 1% per day until they're 80 days old, after which all games count 60%." (A 2014 post gives the same schedule.)
- **Preseason prior:** phased out once a team has played 13 "adjusted games," so it "typically sticks around for 15 or 16 games, since not all games count as a full game." The partial-game wording implies mismatch games are down-weighted.
- **Mismatches:** T-Rank "discounts the effect of mismatches too, but obviously not as aggressively" as KenPom. A later post says KenPom "much more aggressively caps margin of victory and the effect of blowouts in mismatches than T-Rank does."
- **Barthag:** a Pythagorean expectation from AdjOE/AdjDE, "an estimate of what a team's chance of winning would be against the average DI team"; "an exponent of 11.5 gives the best results from a predictive standpoint."
- [SNIPPET, http://adamcwisports.blogspot.com/p/every-possession-counts.html; http://adamcwisports.blogspot.com/2014/12/t-rank-note.html; http://adamcwisports.blogspot.com/2016/03/is-kenpom-biased-in-favor-of.html]

**Exponent history**
- Jan 2015: exponent lowered to 9.0 from 10.25 because favorites were winning less often than projected. "Changing the exponent doesn't change the rank order of teams, but does change the projected certainty." [SNIPPET, http://adamcwisports.blogspot.com/2015/01/technical-t-rank-note.html]
- Sept 2018: raised "from 10.25 to 11.5" because "the new ratings have a narrower spread in adjusted efficiencies." [SNIPPET, 2018 update below]

**2018 Methodology Update: GameScript and garbage time** (Sept 17, 2018)
- Described as the first significant change since 2014; the outputs stay the same but the inputs change.
- Adds a play-by-play "GameScript +/-" that stops counting once the winner's lead becomes "safe," unless a comeback happens.
- Each team gets a derived score: the average of both final scores, plus or minus the GameScript. "Where a team won but had a negative GameScript, I divide the GameScript in half."
- Backtests were "slightly better."
- [SNIPPET, http://adamcwisports.blogspot.com/2018/09/t-rank-methodology-update.html]
- A later interview says garbage time is still excluded. [SECONDARY, https://247sports.com/college/rutgers/Article/analytics-expert-bart-torvik-talks-rutgers-basketball-ncaa-tournament-chances-142645897/]

**Preseason projections**
- **2015 ("T-Rank 2016 Preview: Nuts and Bolts"):**
  - The base is a program rating from the last three seasons of efficiency.
  - Returning minutes drive projected defense ("defense depends heavily on team cohesion").
  - Offense comes from returners' ORtg and usage, weighted by minutes ("Opts"), then adjusted for class.
  - Top-100 recruits are included; the #1 recruit is roughly a returning All-American-level player, tapering quickly.
  - Transfers are added at a discount, with a separate defensive calculation.
  - In-post edits: class bumps of 50/30/10%, later changed for 2017 to about 40/15/10%. Recruiting points were made "more top heavy" but "discounted less."
  - [SNIPPET, http://adamcwisports.blogspot.com/2015/09/t-rank-2016-preview-nuts-and-bolts.html]
- **2017:** preseason projections were "totally revamped" for 2017-18. [SNIPPET, http://adamcwisports.blogspot.com/2017/10/t-rank-new-stuff-for-2017-18-icymi.html]
- **Current "Roster Cast" tool:** described by third parties as returning-player stats plus transfers plus recruits, with recruits "weighted for projected minutes." [SECONDARY, forum and press: https://www.tapatalk.com/groups/bigwest/fwiw-bart-torvik-roster-cast-t30117.html, https://www.thedailyhoosier.com/iu-basketball-torvik-posts-first-analytical-look-at-preseason-rankings-for-2026-27/]

**Player metric PRPG! / PORPAGATU!**
- The name expands to "Points Over Replacement Per Adjusted Game At That Usage."
- It is built on PORPAG: `(OffRtg − 88) × %Poss × Min% × 65`.
- Torvik's change is a usage-sliding replacement level: below 10% usage the replacement level is 93; between 10% and 30% it slides from 93 down to 83, expressed as `O-Rating + ((Usage − 20) × 1.25)`.
- The page's wording is ambiguous about exactly where the adjustment applies.
- It is adjusted for opponent strength and pace. A defensive analog (D-PRPG) exists, and "Total PRPG = O-PRPG + D-PRPG" appears in third-party usage.
- [SNIPPET, https://barttorvik.com/porpagatu.html; SECONDARY, https://mgoblog.com/diaries/enhanced-porpag, https://x.com/HidalgoMuse/status/2025926260082552853]

**BPM, OBPM, DBPM, D-PRPG on barttorvik**
- These are exposed as data columns (for example, toRvik lists `bpm`, `obpm`, `dbpm`).
- **I found no Torvik-authored formula** for player BPM, D-PRPG or any "D-Rating." [SECONDARY, https://torvik.sportsdataverse.org/]

**WAB (Wins Above Bubble)**
- "The number of wins above or below the expected total from a bubble team against the same schedule." [FULL, toRvik roxygen docs, https://raw.githubusercontent.com/andreweatherman/toRvik/main/R/bart_ratings.R; SECONDARY formula Σ(result − P(bubble team wins)), https://blessyourchart.substack.com/p/075-introducing-wabstick]
- The NCAA added T-Rank and WAB to selection team sheets; the NCAA's WAB is derived from NET. [SECONDARY, https://www.insidethehall.com/?p=113161]

**Time-window and other splits**
- The toRvik wrapper (third party) exposes T-Rank and four-factor splits by venue (home/away/neutral/road), game type (non-conference, conference, regular season, postseason, NCAA), quadrant, top-N opponents, and start and end date. [FULL, https://raw.githubusercontent.com/andreweatherman/toRvik/main/R/bart_factors.R]
- SOS variants: `elite_sos`, the percentage of games an "elite" team would project to lose against the schedule; `cur_sos`, the current average opponent Barthag; and `fut_sos`, the projected average opponent Barthag. [FULL, toRvik bart_ratings.R]
- These describe the data interface, not Torvik's internal method.
- A Covers guide repeats the 40-day and 80-day recency schedule. [SECONDARY, https://www.covers.com/ncaab/what-are-torvik-ratings]

### 2(b). Not public or unknown
- Whether the 40/80/60% recency schedule and the 1.4% HCA are still current. The FAQ is undated (about 2014–2018).
- The exact "safe lead" rule inside GameScript and how the derived score enters the efficiency calculation.
- The mismatch discount formula and how games become "partial games."
- The current preseason projection model (revamped in 2017; later details not published in anything I could reach).
- Formulas for player BPM, D-PRPG and any "D-Rating."
- How game predictions turn into win probabilities: Barthag/log5 versus margin plus SD.

### 2(c). Defensible implementation choices
- **Recency:** Torvik's public piecewise schedule (100% for 40 days, −1%/day, 60% floor after 80 days) is a reasonable documented default. Re-tune the floor and knee by backtest.
- **Two efficiency views:** compute both "all possessions" and "competitive possessions only." For the latter, use a safe-lead rule (lead ≥ k·√(possessions remaining)-style, or KenPom's empirical "about 18 pts at 5:00" as a starting threshold) and choose by out-of-sample prediction. Torvik reports a small gain from excluding garbage time. EvanMiya reports filtering *hurt* player ratings (Section 3).
- **Splits:** support date windows, venue, game type, quadrant and opponent rank. These are cheap filters over a game-level adjusted-efficiency table, and they mirror T-Rank's split UI.
- **Barthag:** expose a Pythag "vs average team" number as display only. For pairwise matchups, use the margin-based Normal model, which follows KenPom's post-2016 approach.
- **PRPG-like value metric:** if you build one, document your own replacement levels. Torvik's 93→83 usage-sliding replacement idea is public; his current coefficients are unverified.

---

## 3. EvanMiya (evanmiya.com, blog.evanmiya.com; Dr. Evan Miyakawa)

### 3(a). What is publicly documented

**BPR (Bayesian Performance Rating)**
- **Definition:** "the number of points per 100 possessions better than the opponent the player's team is expected to be if the player were on the court with 9 other average players." BPR = OBPR + DBPR. [SNIPPET, https://evanmiya.com/ glossary]
- **Core architecture:** "At its core, Bayesian Performance Rating is a Regularized Adjusted Plus-Minus model."
  - A hierarchical Bayesian structure combines a **preseason prior** with **Box BPR** to form a final prior that feeds the RAPM model.
  - Giving each player "a starting value that's a best guess of their coefficient, both in terms of specifying the mean and the a[mount of uncertainty]" makes the model more informed.
  - [SNIPPET, https://blog.evanmiya.com/p/bayesian-performance-rating]
- **Box BPR:** "a linear regression is performed to determine which box score statistics are most predictive of a good RAPM coefficient," trained on D-I data. "This rating is an estimate of a player's overall value, based only on his individual box stats." [SNIPPET, same post; evanmiya.com glossary]
- **No team re-centering:** he does *not* shift team Box BPR totals to match team efficiency ("Doing this skews the final BPR output in undesirable ways"). Note that BPM 2.0 *does* make this adjustment (Section 4). [SNIPPET, BPR post]
- **Inputs:** individual efficiency stats, play-by-play on-court impact, prior career, high-school recruiting profile, and opponent and teammate adjustments.
- **Tuning:** "every part of the formula was optimized for out-of-sample predictions" via cross-validation. [SNIPPET, BPR post]
- **Data needs:** season-level RAPM alone needs "a pretty large sample size," so it isn't useful until well into the season, hence the priors. [SNIPPET, BPR post]
- **2025 model update** (a full technical explainer was listed for Oct 20, 2025; I could not read it):
  - Moved to a 4-year college RAPM training set ("several 4-year stints").
  - Updated shrinkage parameters, Box BPR stat weights, and the box-versus-PBP weighting.
  - Now "leans a little more heavily on the box score statistics."
  - Better handles minutes and usage ("not as biased against players who carry a big load").
  - Data back to 2009-10.
  - [SNIPPET, https://blog.evanmiya.com/p/bayesian-performance-rating and its comments page]
- **Garbage time:** the site no longer filters garbage-time possessions for player ratings, because filtering "led to slightly less accurate player ratings." A "Non-Garbage" team efficiency view still exists. [SNIPPET, https://evanmiya.com/ "What's New" and glossary]

**Preseason player priors**
- "Instead of every player starting a new season at a value of 0 (representing a D1 average player), each player begins the year with a preseason 'prior distribution'"; the shown projection is the prior mean.
- **Inputs:** previous-season BPR and Box BPR. For freshmen, composite HS recruiting rankings are the main signal ("the most accurate indication of college ability for players who haven't played college basketball").
- **Uncertainty:** each prior has an SD; freshmen get wider priors, so their ratings move faster.
- **Transfers:** a transfer's projection becomes his preseason BPR.
- [SNIPPET, https://blog.evanmiya.com/p/preseason-player-projections-with]

**Team ratings from player ratings**
- **Preseason:** each player's projected BPR is combined with a **minutes-prediction model** to estimate roster strength.
  - Smaller adjustments: carryover of prior-season team performance, and roster continuity ("doesn't play a huge role").
  - The 2025 update added the share of minutes expected from returners.
  - [SNIPPET, https://blog.evanmiya.com/p/2025-team-preseason-projections; https://blog.evanmiya.com/p/team-preseason-projection-notes-and]
- **Everything downstream uses BPR:** game predictions, lineup metrics, team ratings and injury adjustments all use BPR "as a key part of their internal formulation." "Injury rank" is the team's ranking after removing currently injured players. [SNIPPET, evanmiya.com]

**Relative Ratings** (introduced Feb 28, 2024)
- Teams are ordered by predicted head-to-head outcomes, so #35 is predicted to beat everyone ranked #36 and below. This replaces ordering by margin against an average team.
- Team Net Relative Rating = O-Rate + D-Rate.
- Includes a "Game Pace Adjustment" (performance in faster or slower than usual games), which is less predictive than the opponent-strength adjustments and so moves predictions less.
- Other variables: opponent strength, recent form, and consistency (which mostly affects uncertainty).
- Backtested each season back to 2015-16.
- The Matchup Preview shows a line-by-line "Score Calculation."
- [SNIPPET, https://blog.evanmiya.com/p/introducing-relative-ratings-and]

**Kill Shots**
- A "kill shot" is any time a team scores **10 or more unanswered points**. The site tracks kill shots made and allowed, plus an adjusted version. [SNIPPET, https://blog.evanmiya.com/p/the-power-of-the-10-0-run; evanmiya.com glossary]

**Lineup metrics** (Dec 3, 2024)
- The problem: a team's 10th most-used lineup plays only about 45 possessions a season.
- Lineup projections combine three things:
  - individual player skill projections (shooting, rebounding, playmaking and so on);
  - observed on-court lineup performance, weighted more as possessions accumulate;
  - position and role balance adjustments that penalize extreme imbalance.
- [SNIPPET, https://blog.evanmiya.com/p/lineup-data-just-got-a-whole-lot]

**Game predictions**
- Inputs: team offensive and defensive strength, HCA, expected possessions from tempo, uncertainty in team performance, and injury adjustments. [SNIPPET, https://blog.evanmiya.com/p/evanmiyacom-game-predictions-strategy]
- His own comparison post claims EvanMiya and KenPom are nearly identical in accuracy, with Torvik third. This is self-reported. [SNIPPET, https://blog.evanmiya.com/p/which-cbb-supercomputer-should-you]

**Talks:** I found no public talk or paper describing BPR. The author's PhD (Baylor, 2022) was on Bayesian survival analysis. [SECONDARY, https://statistics.artsandsciences.baylor.edu/news/story/2022/congratulations-dr-evan-miyakawa]

### 3(b). Not public or unknown
- The Box BPR coefficients and the set of box stats used.
- The RAPM shrinkage (λ or prior variances), the prior SDs, and how the preseason prior and Box BPR are combined (the weights of the "hierarchical" combination).
- Whether possessions are weighted by recency, and how multi-season data enters in-season fits.
- The team-rating aggregation formula, the Relative Rating formula, the pace-adjustment function and the injury-adjustment weights.
- The lineup model's functional form and shrinkage.
- How win probability is derived from predicted margin.
- The 2025 technical explainer content. It is listed, but I could not read it.

### 3(c). Defensible implementation choices
- **Player model (BPR-like):** possession-level RAPM with a non-zero prior mean, i.e. ridge toward prior μ_p:
  `minimize Σ_i w_i (y_i − x_i·β)² + λ Σ_p (β_p − μ_p)²`
  - Implement it by fitting on `y − x·μ` and then adding μ back. This mechanic is described in APBR and tothemean posts.
  - Allow player-specific λ_p (equivalently prior variance), larger for freshmen and unknown transfers.
- **Prior mean μ_p:** a regression of multi-year college RAPM on box-score rates (Box BPR / BPM-style), blended with last-season rating and recruiting composite for players with little college data.
  - Fit the blend weights by cross-validation against out-of-sample RAPM or next-season outcomes.
- **Separate O and D:** model points per offensive possession, with offensive players as +1 and defenders as −1 in separate O and D coefficient blocks.
- **Team rating from players:** Σ(projected minutes share × BPR) × 5, plus HCA and a pace model. Blend with the game-based team rating (Section 1); the in-season blend weight is learned by backtest.
- **Lineups:** use partial pooling (Section 4).
- **Kill shots and runs:** compute directly from PBP as maximal unanswered runs of 10 points or more. This is the public definition.

---

## 4. RAPM lineage and Bayesian player and lineup models

### 4(a). What is publicly documented

**Rosenbaum (2004), "Measuring How NBA Players Help Their Teams Win"** (82games.com, April 30, 2004)
- Regression of per-100 point differential on player on-court indicators (+1/−1/0). [SECONDARY, description in https://arxiv.org/pdf/2007.10550]
- Used 2002-03 and 2003-04 combined, with 2003-04 counting double. The regression was weighted by minutes, and players under 250 minutes were pooled into an aggregate row.
- Also built "statistical plus/minus," an "Overall Rating" blending pure APM and statistical plus/minus, and reported standard errors.
- [SNIPPET, https://www.82games.com/comm30.htm]

**Sill (2010), "Improved NBA Adjusted +/- Using Regularization and Out-of-Sample Testing"** (MIT Sloan SAC, March 6, 2010) **[FULL]**
- **Data unit:** "each data point in the dataset is a game snippet during which there were no player substitutions."
- **Evaluation:** predict snippet efficiency difference, scale by possessions, sum to a game margin, and compare to the actual margin by RMSE on held-out games.
- **Protocol:** 10-fold CV on 2008-09 games through February to tune meta-parameters; the March–April games were a pure test set. 2006-07 and 2007-08 data were optionally included with weight D^k for data k years old.
- **Baselines:** test-set margin SD was 12.58 (so RMSE 12.58 is R² = 0), and the mean home margin was 3.61. Unregularized 1-season APM (minutes cutoff M=1200) gave RMSE 12.76, *worse than the trivial model*. 3-season unregularized (M=800, D=0.75) gave 12.01.
- **Objective (his Eq. 1):** minimize `Σ_i p_i (t_i − w·x_i)² + λ‖w‖²`, where:
  - p_i = possessions in the snippet;
  - t_i = home-minus-road efficiency difference;
  - x has +1 for home players, −1 for road players, plus a constant for home court.
- **Bayesian reading:** λ is "the ratio of the variance of the inherent, unpredictable noise to the variance of this gaussian prior."
- **Results:**
  - 3 seasons: λ=3000, M=1200, D=0.25 gave test RMSE 11.47 (R² 0.169).
  - 1 season with M=0: λ=2000 gave 11.54 (R² 0.159).
  - "When using regularization, the benefit of additional years of data and the use of a minutes cutoff turns out to be modest."
  - λ=3000 corresponds to a prior SD of 2.71 and λ=2000 to 3.32, so about 95% of players fall a priori within ±6.
- Mentions four-factor RAPM breakdowns.
- Source: https://supermariogiacomazzo.github.io/STOR538_WEBSITE/Articles/Basketball/Basketball_Sill.pdf, read via the raw.githubusercontent.com mirror. Abstract at https://sloansportsconference.com/research-papers/improved-nba-adjusted-using-regularization-and-out-of-sample-testing (not fetched).

**Engelmann / Ilardi: RPM and xRAPM**
- Engelmann (2014 forum post): his standard RAPM used ridge "with a prior of 0 for everyone." [SNIPPET, https://www.apbr.org/metrics/viewtopic.php?f=2&start=15&t=8485]
- **xRAPM / RPM:** gives each player a non-zero prior that "tries to predict what his RAPM should be." [SECONDARY, https://cornerthreehoops.wordpress.com/2014/04/17/explaining-espns-real-plus-minus/]
- ESPN describes RPM (April 2014) as giving the regression "a head start based on more stable measures of player performance from the box score," weighted like BPM by how well box stats predict APM. [SNIPPET, https://www.espn.com/nba/story/_/id/28309836]
- DunksAndThrees says RPM used "a SPM model as a Bayesian prior in a one-season RAPM calculation called xRAPM." [SECONDARY, https://dunksandthrees.com/about/epm]
- Engelmann's Jan 2026 Substack guide "NBA Adjusted Plus-Minus: How to Build It" includes code and discusses per-player priors. **Not read.** [https://jeremiasengelmann.substack.com/p/nba-adjusted-plus-minus-how-to-build]
- Book chapter: Engelmann (2017), "Possession-based player performance analysis in basketball," cited in Terner & Franks. Not read.

**BPM 2.0 (Daniel Myers, Basketball-Reference)**
- The regression target is RAPM from "four 5-year long RAPM regressions (covering 1996-97 to 2015-16)." [SNIPPET, https://www.basketball-reference.com/about/bpm2.html]
- The prior is "based only on team quality and minutes per game," which also removes the need for an aging adjustment and keeps low-minute players from regressing to average. [SNIPPET, same]
- Inputs are per-100 team possession rates. [SNIPPET, same]
- **Team adjustment:** sum the minutes-weighted raw BPM, compare it to the team's adjusted rating (corrected for leading and trailing effects), and add a constant to every player so the team total matches. [SNIPPET, same]
- College BPM was added to Sports-Reference in Feb 2015 for seasons from 2010-11 onward, and BPM 2.0 came to CBB in May 2020. The original BPM was regressed on "a 14-year-long sample of historical RAPM." [SNIPPET, https://www.sports-reference.com/blog/2015/02/adding-box-plusminus-bpm-to-college-basketball/; https://www.sports-reference.com/blog/2020/05/bpm-2-0-on-college-basketball-reference/]
- **The college-specific adaptation details are unverified.**

**Bayesian or box-prior RAPM for college**
- tothemean.com (2019) "Bayesian Adjusted RAPM" for NCAA: each player gets a prior from "playing time, team strength, box score stats, previous year performance, high school rank," and "everyone is regressed towards their own player specific prior." It includes a team-based prior so that low-minute players differ by team quality. [SNIPPET, https://www.tothemean.com/2019/04/27/ncaa-rapm.html; also https://www.tothemean.com/2018/10/05/ncaa-rapm.html]
- APBR forum mechanic: subtract the prior from observed lineup results, run ridge, then add the prior back. [SNIPPET, https://apbr.org/metrics/viewtopic.php?t=9522]
- Royce Webb's 2025 college APM piece says improved NCAA lineup data now makes college RAPM feasible. Methodology not read. [SNIPPET, https://www.roycewebb.com/p/introducing-adjusted-plus-minus-for]

**Luck-adjusted RAPM**
- Common approach (Ryan Davis LA-RAPM): replace 3PT outcomes with expected points from the shooter's career 3P% by shot location, and FT outcomes with the shooter's career FT%. [SECONDARY, https://apbr.org/metrics/viewtopic.php?f=2&t=9029, https://apbr.org/metrics/viewtopic.php?t=10072]
- Nylon Calculus treats opponent 3P% as largely outside a defender's control and regresses it. [SECONDARY, https://fansided.com/2018/01/08/nylon-calculus-calculating-luck-adjusted-ratings/]
- Hoop Explorer (a college on/off and RAPM tool) uses lineup-weighted 3P% luck adjustments. [SECONDARY, https://hoop-explorer.blogspot.com/p/blog-page.html]
- **No single authoritative spec exists.**

**Win-probability-based player impact: Deshpande & Jensen (2016, JQAS; arXiv:1604.03186)**
- Two steps:
  1. A win-probability model as a function of time remaining and score difference.
  2. A Bayesian linear regression of the per-shift *change in home win probability* on signed indicators for the 10 players on court.
- Shrinkage is used for stability. Posterior summaries give within-team and league-wide rankings. Seven NBA seasons.
- [SNIPPET, https://arxiv.org/abs/1604.03186; https://ar5iv.labs.arxiv.org/html/1604.03186]
- **The exact prior form is unverified.**

**Lineups and partial pooling**
- **L-RAPM** (Petridis & Pelechrinis, arXiv:2601.15000, Jan 2026):
  - NBA teams use over 600 lineups a season, averaging about 25–30 possessions each.
  - A regression that controls for opposition and uses informed priors from the players in the lineup.
  - Beats the baseline, with larger gains at smaller lineup samples.
  - [SNIPPET, https://arxiv.org/abs/2601.15000v1]
- **Dummy RAPM** (Watts, Pipping-Gamón, Wyner, arXiv:2608.19454, 2026):
  - Rather than dropping low-minute players, add five indicators counting excluded players on each side.
  - Chronological validation picked a 10 min/appearance threshold and a dummy-to-player penalty ratio of 2.2.
  - Held-out March–April RMSE improved 12.897 → 12.856 (small but consistent, 13 of 16 seasons).
  - [SNIPPET, https://arxiv.org/pdf/2608.19454]
- **Survey:** Terner & Franks (2020), "Modeling Player and Team Performance in Basketball" (Annual Review of Statistics). It covers APM, regularization and multicollinearity, and notes that playing time could inform priors. [SNIPPET, https://arxiv.org/abs/2007.10550]
- **Early Bayesian APM discussion:** Gelman blog (2007), Josh Menke. [SNIPPET, https://statmodeling.stat.columbia.edu/2007/11/12/bayesian_adjust/]

### 4(b). Not public or unknown
- No public college-specific λ or prior-SD values from KenPom, Torvik or EvanMiya.
- **Sill's λ is not on a college scale.** His λ values (2000–3000) are for NBA snippet-level per-100 data weighted by possessions; scale depends on data units and season length.
- Exact xRAPM and RPM prior construction.
- EvanMiya's "hierarchical" combination weights.

### 4(c). Defensible implementation choices
- **Data unit:** stints (or possessions) from PBP. Response is points per 100 possessions, weighted by possessions (Sill Eq. 1). Use separate O and D designs.
- **Regularization:** ridge toward a player-specific prior mean, with λ (or per-player prior variance) chosen by **chronological** CV. Train on earlier dates, test on later games' margins, matching Sill's held-out-games protocol.
  - Report RMSE against the trivial HCA-only model, which is Sill's sanity check.
- **Prior mean:** box-score SPM regressed on multi-season college RAPM. EvanMiya now uses 4-year windows; BPM uses multiple 5-year windows.
  - Add last-season rating, recruiting composite for newcomers, and a team-quality × minutes term (BPM 2.0 and tothemean both use team quality and playing time).
- **Team constraint:** decide explicitly whether to re-center player box priors to the team rating. BPM 2.0 does; EvanMiya says it does not. Treat this as a hyperparameter to evaluate.
- **Low-minute players:** use Dummy-RAPM style excluded-player count indicators, or pool them into a replacement bucket, and tune by CV.
- **Luck:** optionally replace FT points with the shooter's expected FT% (low-controversy). Regressing opponent 3P% is more debatable, so test it.
- **Lineups (partial pooling):** `lineup_effect = Σ player β (from RAPM) + γ_lineup`, with `γ_lineup ~ N(0, τ²)` and τ estimated from data (empirical Bayes).
  - The posterior lineup estimate is then the player-sum prior plus a shrunk observed residual, so it leans on observed data as possessions grow. This matches EvanMiya's described behavior and L-RAPM's idea.
  - Add role and position balance features only if they improve CV.

---

## 5. Possession estimation and the Four Factors

### 5(a). What is publicly documented

**Free-throw coefficients**
- **KenPom (NCAA):** possessions ≈ `FGA − OR + TO + 0.475·FTA`; "The .475 multiplier estimates how many FTA's represent one possession. This figure has been derived using play-by-play data." [SNIPPET, https://kenpom.com/blog/ratings-glossary/]
- **History of the coefficient:** an older KenPom post used .42 ("I use .475 for the free throw multiplier now") and cites Hollinger using .44 and Dean Oliver using .40 in *Basketball on Paper*. [SNIPPET, https://kenpom.com/blog/the-possession/ and https://kenpom.com/blog/national-efficiency/]
- **Why less than 0.5:** and-ones, technicals, missed front ends of 1-and-1s, and 3-shot fouls. [SNIPPET, https://kenpom.com/blog/the-possession/]
- **Academic source for 0.44 and 0.475:** "Dean Oliver's Four Factors Revisited" (arXiv:2305.13032) says:
  - 0.44 was estimated from NBA 2003–06 PBP;
  - 2022-23 NBA PBP suggests about 0.42;
  - for NCAA, "Zimmermann (2016) estimates μ as 0.475."
  - [SNIPPET, https://arxiv.org/pdf/2305.13032]
  - **Zimmermann (2016) itself was not located and is unverified.**
- **CBB stats help page:** the .44 / .40 / .42 versus .475 choice makes about a 1% difference in efficiency. [SECONDARY, https://cbbstatshelp.com/efficiency/possessions/]
- **Basketball-Reference team possessions formula:** reported to use 0.4·FTA with a 1.07 × ORB% term, averaged with the opponent. The NBA's own formula is reported as 0.96 × (FGA + TOV + 0.44·FTA − ORB). **I did not see the B-R glossary text directly.** [SECONDARY, https://apbr.org/metrics/viewtopic.php?p=30026]

**Four Factors (Oliver)**
- Weights of shooting (eFG%) 40%, turnovers 25%, rebounding 20%, free throws 15%, described as approximate. [SNIPPET, https://www.basketball-reference.com/about/factors.html]
- arXiv:2305.13032 calls the weighting "somewhat ad hoc." It cites a regression-based alternative (Jacobs 2017: 46/35/12/7), which I have not verified.
- Oliver's turnover rate uses `TOV / (FGA + 0.44·FTA + TOV)`. [SNIPPET, B-R factors and glossary]

### 5(b). Not public or unknown
- KenPom's exact PBP derivation of .475 (sample and seasons).
- Whether .475 is still optimal under current NCAA rules (bonus changes, the 30-second clock since 2015-16). This needs re-estimation.
- Zimmermann (2016): not verified.

### 5(c). Defensible implementation choices
- **Count possessions from PBP** (possession-ending events) wherever PBP exists. Use the box-score estimate only as a fallback.
- **Re-estimate the FT coefficient** on your own PBP by season: regress counted possessions on (FGA − OR + TO) and FTA. Expect a value near 0.47–0.48 for NCAA men if KenPom's estimate still holds; treat this as unverified until you fit it.
- **Use the average of both teams' possession estimates** per game, as KenPom does.
- **Four factors:** report them, but do not hard-code Oliver's weights into ratings. Learn weights by regression on adjusted efficiency if a composite is needed.

---

## 6. Win probability from a point spread or predicted margin

### 6(a). What is publicly documented
- **Wolfers (2006), "Point Shaving: Corruption in NCAA Basketball,"** AER P&P 96(2):279–283.
  - Sample: 44,120 NCAA D-I games, 1989–2005.
  - Deviations of the outcome from the spread are "roughly normally distributed with zero mean and a standard deviation of 10.9 points."
  - Strong favorites (spread above 12) cover slightly less than 50%, and the right tail departs from normal.
  - [SNIPPET, https://www.stat.berkeley.edu/~aldous/157/Papers/PointShaving.pdf; NBER copy https://users.nber.org/~jwolfers/Papers/PointShaving.pdf]
- **The Only Colors (2020):** a fit of college results against prediction-tracker data (2004–2018) gives an SD of about 10.0–10.3 points. The SD "increases a bit as the spread get larger." [SECONDARY, https://www.theonlycolors.com/2020/4/27/21226073/the-variance-of-college-basketball-how-big-is-it-and-where-does-it-come-from]
- **Bayesian in-game win-probability paper for college basketball** (arXiv:2204.11777): point differential "commonly modeled using a normal distribution with a standard deviation of 10 points." [SNIPPET, https://arxiv.org/pdf/2204.11777]
- **Silver Bulletin SBCB/COOPER:** per snippets, uses about a ±10-point game SD. It is Elo-like, weights evenly matched games more, and has preseason priors from polls, last year's rating and conference. [SNIPPET, https://www.natesilver.net/p/sbcb-methodology; https://www.natesilver.net/p/introducing-cooper-silver-bulletins]
- **Boyd's Bets:** college basketball ATS-margin volatility rises with the game total (correlation 0.46), and the spread–SD correlation is reported as −0.33. Tables not read. [SNIPPET, https://www.boydsbets.com/standard-deviations-ats-margins-totals/; https://www.boydsbets.com/ats-margin-standard-deviations-by-point-spread/]
- **KenPom** derives win probability "directly from the predicted margin of victory" (post-2016), but **no SD is stated in any source I could access.**
  - An old prediction-tracker post said his probabilities were "a little too aggressive."
  - His rematch post reports first-to-second-game margin SDs of about 11.7–12.4 across buckets. This is not a spread-error SD.
  - [SNIPPET]
- **Sill (2010), NBA reference point:** the test-set SD of the margin itself is 12.58, and the best model RMSE was 11.47. **[FULL]**

### 6(b). Not public or unknown
- The σ (or link function) that KenPom, Torvik and EvanMiya use.
- Whether σ is conditioned on tempo, total or spread size. The public evidence suggests it should be.

### 6(c). Defensible implementation choices
- **Basic model:** `P(win) = Φ((pred_margin + HCA_adj) / σ)`. **σ ≈ 10.5–11 is a defensible prior** given the documented range: about 10.0–10.3 (TOC), 10.9 (Wolfers, against market spreads), and 10 (academic convention).
  - **Fit σ on your own out-of-sample residuals.** A model's own residual SD will be at least the market's 10.9 unless the model is as sharp as the closing line.
- **Heteroskedastic option:** `σ_game = a + b·sqrt(expected total possessions)` or a function of the expected total. Boyd's Bets reports total-dependent volatility, and Silver notes that higher-scoring games are more variable. Estimate a and b by maximum likelihood.
- **Tails:** check calibration in the tails (strong favorites). Wolfers documents non-normality there, and KenPom reports over-aggressive probabilities. If needed, consider a t-distribution or a calibrated logistic layer (Platt/isotonic) on top of the Normal.
- **Pythag/log5 (exponent of about 10.25–11.5):** keep only as a legacy display metric. KenPom abandoned it for matchups in about 2016.

---

## 7. Cross-cutting summary for implementers

| Component | Best-documented public anchor | Status |
|---|---|---|
| Opponent adjustment | KenPom 2016: additive, vs national avg on game date; Torvik FAQ: multiplicative, iterated | [SNIPPET] |
| Home court | Old KenPom and Torvik: ±1.4% multiplicative; KenPom research: about 3.4–3.75 pts avg | [SNIPPET]; current value unverified |
| Recency | Torvik: 100% ≤40d, −1%/day, 60% floor ≥80d; KenPom: weighted, details private, "less important" after 2016 | [SNIPPET] |
| Blowouts | KenPom 2.0: downweight expected lopsided wins, upweight upsets; Torvik 2018: GameScript stops at "safe" lead; KenPom: remaining-margin signal about 0 at 18-pt lead with 5:00 left | [SNIPPET] |
| Preseason prior | KenPom: weight → 0 after 27th D-I game; Torvik: phased out after 13 "adjusted games" | [SNIPPET] |
| SOS | KenPom: Sagarin WIN50; Torvik: Barthag-based current, future and elite SOS | [SNIPPET] / [FULL wrapper docs] |
| Possessions | FGA − OR + TO + 0.475·FTA (KenPom, NCAA) | [SNIPPET] |
| Player impact | Sill ridge (λ by out-of-sample CV, prior SD about 3 for the NBA); box-prior RAPM (xRAPM, BPM 2.0, EvanMiya BPR) | [FULL] Sill; others [SNIPPET] |
| Lineups | Shrink to player-sum prior (EvanMiya tool, L-RAPM) | [SNIPPET] |
| Win prob σ | 10–11 pts (Wolfers 10.9 vs spread; TOC about 10.0–10.3; academic 10) | [SNIPPET] / [SECONDARY] |

---

## References and fetch status

"Fetched = No (blocked)" means the host was unreachable because of the session's egress policy (WebFetch DNS failure or proxy 403). Content for those rows comes from web-search excerpts.

### KenPom
| URL | Fetched? |
|---|---|
| https://kenpom.com/blog/ratings-explanation/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/ratings-methodology-update/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/pomeroy-ratings-version-2.0/ (alt: /pomeroy-ratings-version-2-0/) | No (blocked); search excerpts only |
| https://kenpom.com/blog/ratings-glossary/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/help-with-team-page/ | No (blocked); search excerpts only |
| https://kenpom.com/contact.php (FAQ) | No (blocked); search excerpts only |
| https://kenpom.com/blog/pomeroy-ratings-faq/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/preseason-ratings-why-weight/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/what-happens-to-preseason-ratings-when-its-not-preseason-anymore/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/2016-preseason-ratings/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/preseason-ratings-now-with-transfers/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/preseason-ratings-2015/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/introducing-the-kpoy/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/the-possession/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/national-efficiency/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/stats-explained/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/how-to-measure-home-court-advantage/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/how-to-measure-site-specific-home-court-advantage-part-two/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/offense-vs-defense-points-per-possession/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/mining-point-spread-data-home-court-advantage/ | No (blocked); listed in search, content not confirmed |
| https://kenpom.com/blog/evidence-that-scoring-margin-matters/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/the-simplest-proof-that-overtime-data-is-useful-and-that-garbage-time-exists/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/the-predictive-value-of-overtime-margin/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/a-treatise-on-plusminus/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/model-diagnostics/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/prediction-tracker/ | No (blocked); search excerpts only |
| https://kenpom.com/blog/?p=650 (luck / correlated Gaussian) | No (blocked); search excerpts only |

### Torvik
| URL | Fetched? |
|---|---|
| http://adamcwisports.blogspot.com/p/every-possession-counts.html (T-Rank FAQ) | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2018/09/t-rank-methodology-update.html | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2015/01/technical-t-rank-note.html | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2014/12/t-rank-note.html | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2016/03/is-kenpom-biased-in-favor-of.html | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2015/09/t-rank-2016-preview-nuts-and-bolts.html | No (blocked); search excerpts only |
| http://adamcwisports.blogspot.com/2017/10/t-rank-new-stuff-for-2017-18-icymi.html | No (blocked); search excerpts only |
| https://barttorvik.com/porpagatu.html | No (blocked); search excerpts only |
| https://barttorvik.com/ | No (blocked) |
| https://github.com/andreweatherman/toRvik (README, third-party wrapper) | **Yes** (WebFetch) |
| https://raw.githubusercontent.com/andreweatherman/toRvik/main/R/bart_factors.R | **Yes** (curl; full text) |
| https://raw.githubusercontent.com/andreweatherman/toRvik/main/R/bart_ratings.R | **Yes** (curl; full text) |
| https://torvik.sportsdataverse.org/ | No; search excerpts only |
| https://www.covers.com/ncaab/what-are-torvik-ratings | No (blocked); search excerpts only (secondary) |
| https://mgoblog.com/diaries/enhanced-porpag | No; search excerpts only (secondary) |
| https://247sports.com/college/rutgers/Article/analytics-expert-bart-torvik-talks-rutgers-basketball-ncaa-tournament-chances-142645897/ | No; search excerpts only (secondary) |
| https://www.insidethehall.com/?p=113161 | No; search excerpts only (secondary) |
| https://blessyourchart.substack.com/p/075-introducing-wabstick | No; search excerpts only (secondary) |

### EvanMiya
| URL | Fetched? |
|---|---|
| https://blog.evanmiya.com/p/bayesian-performance-rating | No (blocked; WebFetch DNS failure); search excerpts only |
| https://blog.evanmiya.com/p/bayesian-performance-rating/comments | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/preseason-player-projections-with | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/2025-team-preseason-projections | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/team-preseason-projection-notes-and | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/introducing-relative-ratings-and | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/the-power-of-the-10-0-run | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/lineup-data-just-got-a-whole-lot | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/evanmiyacom-game-predictions-strategy | No (blocked); search excerpts only |
| https://blog.evanmiya.com/p/which-cbb-supercomputer-should-you | No (blocked); search excerpts only |
| https://evanmiya.com/ (glossary, What's New) | No (blocked); search excerpts only |
| https://statistics.artsandsciences.baylor.edu/news/story/2022/congratulations-dr-evan-miyakawa | No; search excerpts only |

### RAPM, player models and lineups
| URL | Fetched? |
|---|---|
| https://supermariogiacomazzo.github.io/STOR538_WEBSITE/Articles/Basketball/Basketball_Sill.pdf (Sill 2010) | **Yes**, full text via mirror https://raw.githubusercontent.com/supermariogiacomazzo/STOR538_WEBSITE/master/Articles/Basketball/Basketball_Sill.pdf |
| https://sloansportsconference.com/research-papers/improved-nba-adjusted-using-regularization-and-out-of-sample-testing | No (blocked); abstract via search |
| https://www.82games.com/comm30.htm (Rosenbaum 2004) | No (blocked); search excerpts only |
| https://www.apbr.org/metrics/viewtopic.php?f=2&start=15&t=8485 (Engelmann) | No (blocked); search excerpts only |
| https://jeremiasengelmann.substack.com/p/nba-adjusted-plus-minus-how-to-build | No (blocked); intro only via search |
| https://www.espn.com/nba/story/_/id/28309836 (RPM) | No; search excerpts only |
| https://cornerthreehoops.wordpress.com/2014/04/17/explaining-espns-real-plus-minus/ | No; search excerpts only (secondary) |
| https://dunksandthrees.com/about/epm | No (blocked); search excerpts only (secondary) |
| https://www.basketball-reference.com/about/bpm2.html | No (blocked); search excerpts only |
| https://www.sports-reference.com/blog/2015/02/adding-box-plusminus-bpm-to-college-basketball/ | No (blocked); search excerpts only |
| https://www.sports-reference.com/blog/2020/05/bpm-2-0-on-college-basketball-reference/ | No (blocked); listed in search only |
| https://www.tothemean.com/2019/04/27/ncaa-rapm.html | No (blocked); search excerpts only |
| https://apbr.org/metrics/viewtopic.php?t=9522 (Bayesian RAPM mechanics) | No (blocked); search excerpts only |
| https://www.roycewebb.com/p/introducing-adjusted-plus-minus-for | No (blocked); search excerpts only |
| https://apbr.org/metrics/viewtopic.php?f=2&t=9029 and https://apbr.org/metrics/viewtopic.php?t=10072 (luck-adjusted RAPM) | No (blocked); search excerpts only |
| https://fansided.com/2018/01/08/nylon-calculus-calculating-luck-adjusted-ratings/ | No; search excerpts only |
| https://hoop-explorer.blogspot.com/p/blog-page.html | No (blocked); search excerpts only |
| https://arxiv.org/abs/1604.03186 (Deshpande & Jensen 2016) | No (blocked); abstract and ar5iv excerpts via search |
| https://arxiv.org/abs/2601.15000v1 (L-RAPM) | No (blocked); abstract via search |
| https://arxiv.org/pdf/2608.19454 (Dummy RAPM) | No (blocked); abstract via search |
| https://arxiv.org/abs/2007.10550 (Terner & Franks survey) | No (blocked); excerpts via search |
| https://statmodeling.stat.columbia.edu/2007/11/12/bayesian_adjust/ | No; listed in search only |

### Possessions and Four Factors
| URL | Fetched? |
|---|---|
| https://arxiv.org/pdf/2305.13032 (Four Factors Revisited; 0.44 vs 0.475) | No (blocked); search excerpts only |
| https://www.basketball-reference.com/about/factors.html | No (blocked); search excerpts only |
| https://apbr.org/metrics/viewtopic.php?p=30026 (B-R and NBA possession formulas) | No (blocked); search excerpts only |
| https://cbbstatshelp.com/efficiency/possessions/ | No; search excerpts only |

### Win probability and margin SD
| URL | Fetched? |
|---|---|
| https://www.stat.berkeley.edu/~aldous/157/Papers/PointShaving.pdf (Wolfers 2006) | No (blocked); search excerpts only |
| https://users.nber.org/~jwolfers/Papers/PointShaving.pdf | No; listed in search |
| https://www.theonlycolors.com/2020/4/27/21226073/the-variance-of-college-basketball-how-big-is-it-and-where-does-it-come-from | No; search excerpts only (secondary) |
| https://arxiv.org/pdf/2204.11777 (Bayesian in-game WP, college basketball) | No (blocked); search excerpts only |
| https://www.natesilver.net/p/introducing-cooper-silver-bulletins and https://www.natesilver.net/p/sbcb-methodology | No (blocked); search excerpts only |
| https://www.boydsbets.com/ats-margin-standard-deviations-by-point-spread/ and https://www.boydsbets.com/standard-deviations-ats-margins-totals/ | No; search excerpts only |
| https://www2.isye.gatech.edu/~jsokol/ncaa.pdf (Kvam & Sokol LRMC, an alternative rating approach) | No (blocked); listed in search |
