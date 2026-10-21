# Final report — do EdgeDesk's football models find early-line edge?

Study dates: 2026-10-21. Companion files: [DATA_AUDIT.md](DATA_AUDIT.md) (what data exists and when
each input is knowable) and [EXPERIMENTS.md](EXPERIMENTS.md) (every pre-registration and result, the
variant ledger). Code: `model_loop/clv_early/`. Scorecards: `docs/model-loop/clv_early/results/`.

## Verdict

**Yes, there is closing-line value, but not yet betting profit.** On seasons it never saw (2025 and
2026 to date), three rules beat the early line by a statistically clear margin after correcting for
the five holdout tests:

| rule | holdout bets | mean CLV | one-sided 99% lower bound | CLV in probability | expected ROI at the price offered |
|---|---|---|---|---|---|
| **NFL totals**: board model v2.1.0 vs the early-week total, edge ≥ 2 | 114 | **+0.50 pts** | +0.23 | +1.24% | −2.1% |
| **CFB spreads**: Loop v2.0.0 (week W−2 inputs) vs the opener, edge ≥ 3 | 460 | **+0.26 pts** | +0.07 | +0.64% | −3.3% |
| **CFB totals**: Loop v2.0.0 (week W−2 inputs) vs the opener, edge ≥ 3 | 426 | **+0.42 pts** | +0.14 | +1.02% | −2.6% |

**NFL spreads did not pass.** Both the board model (+0.32 pts) and the Loop (+0.23) point the right
way, but on about 140 bets neither clears the corrected permutation bar.

**Read the last column before anything else.** The lines do move toward these models, by about
0.6–1.2% of win probability per bet. A standard −110 bet needs about +2.4% just to break even. If
the close is taken as the truth, every rule loses 2–4% at the prices that were actually on offer.
In plain words: the models know something the opening number doesn't, but not enough to pay a
normal vig. On the holdout's CLV the break-even price is about −105 for NFL totals, −104 for CFB
totals and −103 for CFB spreads (assuming a fair opener). Reaching it would take line shopping,
reduced-juice books, or bigger edges.

## What was measured, and how it was protected

* **The metric.** For every eligible game, the model's number is compared with the early line. Bets
  go on the model's side when they disagree by at least a threshold. Each bet is scored by how far the
  line moved toward it by the close: in points, and in no-vig probability (key-number aware, using
  real prices where the data has them). MAE against the final score was kept as a diagnostic only.
* **No leakage.** Every input had to be knowable when the early line was up:
  * ratings from completed weeks only, priced from the week-start state;
  * each team's **previous-game** starting QB, never the game-day starter (the existing prediction
    files used the game-day starter, and 10% of NFL / 15% of CFB starts differ);
  * no game-time weather.
  NFL early lines have provable timestamps, recovered from the commit history of nflverse's
  `games.csv`. CFB openers have none, so every CFB rule had to survive with nothing from the previous
  week (ratings and QB frozen at week W−2).
* **Holdout locked in code.** 2025 and 2026 could not be scored without a flag, used once in Phase 6.
* **Pre-registration.** Every experiment was committed before it was run. The git history shows
  each pre-registration commit ahead of its results commit. Thresholds were never changed after a
  result.

## What was tried

| phase | what | outcome |
|---|---|---|
| 1 | Data audit | NFL early-week lines 2020–2026 (timestamped, with prices); CFB openers 2012–19 and 2021–25 (no timestamps); **no NFL early lines 2015–2019, no team totals, no 1H lines, no CFB injury history, no weather forecasts anywhere reachable** |
| 2 | Harness | CLV in points and probability, direction hit rate, edge buckets, week-clustered bootstrap, permutation null, ROI at the bet price; 23 synthetic tests |
| 3 | Baselines (2015–2024 development) | NFL v2.1.0 +0.37 pts spreads / +0.45 totals; NFL Loop +0.40 / +0.42; CFB Loop +0.55 / +0.90 (+0.25 / +0.71 with W−2 inputs); **CFB V1 (cfb_p4): its CLV is entirely last week's information and vanishes at W−2, so it was not called** |
| 4 | Market-residual model (predict close − open) | **Failed everywhere.** NFL: fitting the move was worse than betting the disagreement. CFB: adding rest (which the opener under-prices) beat the base residual model but only tied the plain rule; interactions added nothing |
| 5 | Backup-QB NFL games | **Failed**: only 66 games in five seasons; +0.21 pts with an interval spanning 0 |
| 5 | CFB non-power games | **Failed**, and the opposite of the hypothesis: −0.28 pts *less* CLV than power-involved games |
| 5 | NFL totals with venue climatology | **Failed**: +0.04 better than neutral weather, inside the noise |
| 5 | Team totals, 1H | **Skipped**: no line data exists |
| 6 | Holdout, 5 candidates | **3 pass** (NFL totals, CFB spreads, CFB totals), **2 fail** (both NFL spread rules) |

## Holdout detail (2025 + 2026 to date, read once)

| id | rule | bets | CLV pts | 99% lower | CLV prob | perm p | per season (bets, CLV pts) | gate |
|---|---|---|---|---|---|---|---|---|
| H-1 | NFL v2.1.0 spread, ≥2 | 138 | +0.319 | +0.086 | +0.56% | 0.016 | 2025: 112, +0.37 · 2026: 26, +0.12 | FAIL |
| H-2 | NFL Loop spread, ≥2 | 142 | +0.229 | −0.155 | +0.30% | 0.028 | 2025: 115, +0.34 · 2026: 27, −0.22 | FAIL |
| H-3 | NFL v2.1.0 total, ≥2 | 114 | +0.504 | +0.234 | +1.24% | 0.0015 | 2025: 96, +0.59 · 2026: 18, +0.06 | **PASS** |
| H-4 | CFB Loop W−2 spread, ≥3 | 460 | +0.259 | +0.068 | +0.64% | 0.0045 | 2025: 359, +0.26 · 2026: 101, +0.26 | **PASS** |
| H-5 | CFB Loop W−2 total, ≥3 | 426 | +0.418 | +0.135 | +1.02% | 0.0005 | 2025: 328, +0.35 · 2026: 98, +0.65 | **PASS** |

Pass rule, fixed before unlocking:
* at least 50 bets;
* the one-sided 99% lower bound of mean CLV above 0, from a week-cluster bootstrap (Bonferroni
  α = 0.05/5);
* permutation p ≤ 0.01;
* mean probability CLV > 0.

## How many things were tried

* **Development:** 96 distinct configurations scored (143 scoring runs including re-scorings; 32 at
  a pre-registered primary threshold), every one in the ledger in EXPERIMENTS.md, failures included.
* **Holdout:** 5 tests. The Bonferroni correction above is for those 5, and it is the correction
  that matters: the holdout was read once, after the choice.
* The development search was wide. That is why only the holdout result is the claim.

## Wiring (as pre-registered; nothing is served)

* **CFB spreads and totals**: registered in the CFB Model Lab as **EXP-006** and **EXP-007**,
  status RUNNING, metric CLV (`football/cfb_lab/governance/experiments.jsonl`).
  * No model role was registered, because the lab's auto-promotion considers challenger and
    candidate roles.
  * The champion and every served number are unchanged; the lab's test suites pass.
* **NFL totals**: an event `clv_live_tracking` with status `CANDIDATE (CLV live tracking)` in
  `football/research/nfl_v2/registry.json`.
  * `current` stays `edgedesk_nfl_v2.1.0`.
  * The registry's consumers (registry SQL builder and its check, weekly loop tests) pass unchanged.

## Caveats, stated plainly

1. **NFL development covers 2020–2024 only.** No early NFL lines for 2015–2019 exist in any source
   this environment could reach (SBR, AusSportsBetting and CollegeFootballData are blocked by the
   network policy). That leaves about 1,300 NFL games, and is why NFL spreads cannot separate a
   real ~0.3-point edge from noise yet.
2. **CFB timing is unprovable before 2026.** The archive's openers carry no timestamps, so CFB rules
   were held to week-W−2 inputs. With last week's information the CFB Loop showed twice the CLV
   (+0.55 vs +0.25 on spreads), but that can't be told apart from a lookahead artefact. CFB V1's
   development CLV disappeared entirely under this rule.
3. **CFB 2026 holdout lines come from a different book.** They are EdgeDesk's own hourly DraftKings
   captures (weeks 5–8), not Bovada. The result held there too (+0.26 spreads, +0.65 totals).
4. **CFB totals are decaying.** Development CLV fell from +1.66 (2015) to +0.14 (2024) at W−2, and
   the holdout sits at +0.42. Expect less going forward.
5. **The NFL feed's early line is one feed's number.** nflverse's source book is unnamed. 12% of
   week-start values were stale lookahead numbers; those games were excluded from Phase 4 on (rule
   R-1), and the holdout used the same exclusion.
6. **A second, independent CLV study** (different session, multi-sport, NFL openers from SBR 2011–2019)
   landed on `main` while this one ran. To keep both records intact, this study moved to
   `research/clv_early_week/` and `model_loop/clv_early/`. The two share no data files or IDs, and
   their attempt counts are separate.

## Recommended next steps

1. **Capture CFB lines with timestamps every week.** The lab already does this from 2026.
   * This removes the W−2 handicap that halves the CFB Loop's measured edge.
   * It is the single largest lever in the evidence.
2. **Price-shop before anything else.** The CLV exists, but standard juice eats it. On the holdout
   numbers the rules break even at about −105 (NFL totals), −104 (CFB totals) and −103 (CFB
   spreads). That is a book-access question, not a modelling one.
3. **Track bigger edges live.** CLV rises with edge size in every passing rule. Holdout CFB totals by
   edge 0–1 / 1–2 / 2–3 / 3+: −0.14 / −0.08 / +0.08 / +0.42 pts. On development, CFB totals at ≥5
   were the only rule with positive ROI (+0.77%).
   * That threshold was not pre-registered for the holdout, so it is not a claim.
   * Pre-register it as a live-tracking variant if wanted.
4. **Keep NFL spreads in live tracking, not on the board.** The holdout point estimate (+0.32 for
   the board model) is close to development (+0.30). Another season of CLV would settle it.
5. **Don't build more market-residual models on this data.** Phase 4's failure says the
   disagreement itself is the signal. Re-weighting it on 1–4 seasons of movement data adds noise.
