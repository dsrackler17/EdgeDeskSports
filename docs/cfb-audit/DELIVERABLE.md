# EdgeDesk CFB hostile audit: required final deliverable (item 127, 47 parts)

> **Status after this audit.**
> - **F-30 and F-31 are fixed** in the same pull request (PR #391):
>   - `football/cfb_production/projections.js` `officialFor()` publishes no official decision at fallback level 3. It refuses a BET that breaks the governed policy (betting off, or no side/line/price): the result is NO_DECISION with the alarm.
>   - `supabase/functions/edgedesk_ai/_cfb_explain.js` `cfbFacts()` lets a BET through only when the decision says betting is on.
>   - Tests: `canonical.test.js` 124, `explain_guard.test.js` 52.
> - **The item-81 wording is corrected:** the V2 panel now says the 2024–25 data informed development and is inspected, not an untouched holdout.
> - **Unchanged:** the classification (B); the other findings keep the status given below.
> - The text is the auditor's own, kept as plain text.

```text
EDGEDESK CFB HOSTILE AUDIT - REQUIRED FINAL DELIVERABLE (brief item 127, 47 parts)
===================================================================================

How to read this file
- Each part gives WHERE the evidence is, a STATUS, and the exact REASON it supports or blocks approval.
- Documents:
  FINDINGS.md         docs/cfb-audit/FINDINGS.md: phases 1-2, committed by the orchestrator.
  FINDINGS_PHASE3.txt the H3 pathway attack, findings F-30 to F-38 and the classification.
  TECHNICAL.txt       the technical audit; section numbers are given as §n.
  EXECUTIVE.txt       the executive audit.
  SNAPSHOT.json       docs/cfb-audit/SNAPSHOT.json.
  PATCH_v2.1.1.md, PATCH_v2.1.2.md  docs/cfb-audit/.
- Code and outputs:
  Audit code          football/cfb_v2/research/v2/audit/*.py|js. Run with `python3 -m v2.audit.<name>` from
                      football/cfb_v2/research, with CFB_V2_OUT=out_h and single-threaded BLAS.
  Audit outputs       football/cfb_v2/research/out_h/audit/*.json|csv|parquet (git-ignored).
  Phase-3 scripts     attack.js, failclosed.js and betattack.js, kept in the audit scratch folder. They call the
                      canonical service directly, so placing them in football/ would trip the repository's scan
                      for engine calls. If they are moved, put them under a test allowlist.
- Status words:
  PASSED              the attack failed to break it.
  FAILED              the evidence contradicts the claim.
  PARTIAL             some parts passed and some failed.
  DELIVERED           a document or an analysis with no pass/fail sense.
  RESEARCH ONLY       nothing in production reads it.
  NOT ISSUED          withheld because approval was not given.
- Audited states:
  Core model          the frozen snapshot EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE, commit e22ff36d.
  Pipeline            b6eae62e9 (PR #391).
- Re-checked on the current HEAD 765002ec6. Its only change since b6eae62e9 is two test fixes.
  - params.js sha 35845306... and engine.js sha 745c1c3c... are identical to the snapshot.
  - The v2.1.0 artifact MANIFEST (356bd0f9...) is identical.
  - These suites pass: cfb_lab 275/275, cfb_decision 101/101, canonical 117/117, sports_config 66/66 and
    cfb_terminal 113/113.
  - The three sync dry-runs (cfb_lab, cfb_v2, cfb_decision) exit cleanly. The cfb_v2 dry-run reports 0 frozen V2
    files and the cfb_decision dry-run reports 0 decision rows.
- Governance throughout:
  - No Model Championship was run (champion_selection NOT_RUN).
  - The champion is V1, edgedesk_cfb_p4_v1.0.0.
  - V2.1.0 is ELIGIBLE_FOR_PROMOTION.
  - Betting is disabled.
- Rules kept: no holdout was re-scored in phase 3, and nothing in production was modified.

CLASSIFICATION: B - APPROVED FOR SHADOW MODE ONLY.

-------------------------------------------------------------------------------------------------
1. AUDIT SNAPSHOT
-------------------------------------------------------------------------------------------------
WHERE:  SNAPSHOT.json, produced by v2.audit.snapshot. TECHNICAL.txt §1.
STATUS: DELIVERED.
RECORDS:
- commit e22ff36d;
- the artifact MANIFEST, 3/3 files verified;
- the params.js, engine.js and candidate-001 hashes;
- 209 raw-data hashes;
- the cfb_*.sql DDL hashes and the hash of the 51-input feature schema;
- the calibration, uncertainty, ensemble, market and decision-policy settings;
- the environment: Python 3.11.15, LightGBM 4.7.0, numpy 2.4.6, pandas 3.0.6, scipy 1.17.1, sklearn 1.9.1;
- governance: champion_selection NOT_RUN.
REASON: It gives a fixed reference. Every later check re-verified the core against it, and the core is unchanged at
765002ec6. Gaps:
- The clone is shallow, with its first commit on 2026-09-26.
- The database has no schema_version column.
- fetch_v2.sh pins no data hash.
These do not block shadow approval. They make provider history unverifiable (part 3).

-------------------------------------------------------------------------------------------------
2. REPRODUCTION RESULTS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §2. v2.audit.reproduce; football/cfb_production/reproduce.js; replay_week.js.
STATUS: PASSED.
RESULTS:
- Stages 1-5 were rebuilt from raw data for 2016, 2024 and 2026. The output is value-identical; the only
  differences are how nulls are represented.
- The stage-7 refit reproduces 11,262 of 11,262 predictions exactly (max |diff| 0.0).
- The production scorer matches research stage 7 on 2026 to within 7e-15.
- engine.js matches the Python t-CDF to within 4.9e-5.
- reproduce.js re-derives 174/174 stored Lab snapshots and 510/510 settlements.
- The week-3 replay is deterministic.
REASON: Reproducibility is a precondition for any approval, and it is met.

-------------------------------------------------------------------------------------------------
3. HISTORICAL DATA INTEGRITY RESULTS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §3. v2.audit.immutability. FINDINGS.md F-01, F-08, F-09.
STATUS: PARTIAL.
PASSED:
- 225 recorded hashes match the local files.
- Two schedule sources (sportsdataverse and cfbfastR) agree on 2014-2025 with 0 mismatches in score, id, date or
  neutral site.
- Coaching fields hold the preseason coach.
FAILED OR OPEN:
- F-01 (HIGH): in-progress and cancelled games were counted as FINAL. Fixed in v2.1.1 and in the pipeline rule.
  On true finals, 2026 V2 minus the close moves from +0.958 to +1.135.
- F-08 (MEDIUM, open): play-by-play is incomplete for 3-6% of games from 2021 (53 / 39 / 29 / 29 / 35 score
  mismatches). 250 FINAL games have no play-by-play.
- F-09 (MEDIUM, open): definitions drift. retprod def_returning is missing for 100% of teams in 2009-16 and 0% in
  2026. The provider's EP model was fitted on 2004-2025.
- Provider point-in-time immutability cannot be tested: every hash dates from 2026-09-27.
REASON: Nothing here corrupts the frozen model beyond what was fixed. It does block any claim that the provider
history is point-in-time.

-------------------------------------------------------------------------------------------------
4. TEMPORAL LEAKAGE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §4 A-F. v2.audit.leakage.
STATUS: PASSED (no leak found).
RESULTS:
- Across 63,851 rating rows, n_obs equals the team's FINAL games before the freeze every time: 0 mismatches for
  offence and 0 for defence.
- An independent re-solve matches to within 1e-8 in 5 seasons. The leaky whole-season solve differs by 0.10-0.28 SD.
- In 12,950 snapshot rows, feature_ts = prediction_ts < kickoff.
- The expected QB is the latest prior starter in 55,499 of 55,499 rows.
- An independent Elo implementation reproduces all 15,378 games exactly.
- Outcome scan: the largest r^2 of any input with the margin is 0.402, against 0.446 for the close. A detector
  for margin minus close has R^2 -0.033 (n 7,263).
REASON: Point-in-time construction is verified. The one leak by definition is the provider EP model, fitted through
2025. It is disclosed and cannot be removed.

-------------------------------------------------------------------------------------------------
5. PREPROCESSING LEAKAGE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §4 "Preprocessing".
STATUS: PASSED for fitted objects.
RESULTS:
- Every scaler, imputer, calibrator, conformal quantile, reliability range and prior model is fitted on seasons
  before S.
- Metric scales come from seasons S-3 to S-1.
- Talent is standardised within the preseason.
REASON: No fitted object sees its own season. The hyperparameters, however, were tuned on 2016-23, so dev
results are in-sample for the configuration (part 8).

-------------------------------------------------------------------------------------------------
6. MARKET LEAKAGE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §4 "Market leakage", §8. purity.py/purity.js.
STATUS: PASSED.
RESULTS:
- The opener is used at the Tuesday freeze. The close is used only for evaluation.
- The pure table and the artifact contain no market column.
- The decision dataset's arm masks never read the close.
- WAIT is disabled.
- The CLV models are fitted walk-forward on dev.
REASON: The pure number cannot see the market. Historical closes have no timestamps, but they are used only to
evaluate, never as inputs.

-------------------------------------------------------------------------------------------------
7. DUPLICATE / SURVIVORSHIP ANALYSIS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §5. v2.audit.samples.
STATUS: PASSED, with a disclosure.
RESULTS:
- Every table has 0 duplicate game keys.
- The 72 same-pair same-season games are genuine rematches.
- Training is unweighted.
- Books are aggregated by median.
SELECTION: 929 dev FBS-vs-FBS finals are left out of the published common set. They are harder: V2's MAE on them is
13.24, against 12.72 on the games kept. The same applies to the 540 games without an opener (13.07 against 12.60).
FCS games are not priced. 2020 has no openers.
REASON: Predictors are compared on the same games, so the comparisons are fair. The absolute MAE is optimistic
because harder games are excluded, and that must be disclosed.

-------------------------------------------------------------------------------------------------
8. HOLDOUT CONTAMINATION ANALYSIS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §6. FINDINGS.md F-04/F-29.
STATUS: FAILED, permanently.
RESULTS:
- 2024-25 was read at least 13 times.
- About 250 model configurations and about 1,200 threshold rules were counted.
- There is no untouched season: 2009-11 is burn-in, 2012-15 training, 2016-23 tuning, 2024-25 inspected, and 2026
  weeks 0-4 inspected.
REASON: This is the main blocker for A. Every accuracy number is conditional on data that shaped the model. The
first clean evidence is the 2026-09-29 freeze onward.

-------------------------------------------------------------------------------------------------
9. SIMPLE BASELINE CHALLENGE
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §7. v2.audit.baselines. FINDINGS.md F-05.
STATUS: PARTIAL.
HOLDOUT (V2 minus X, n 1,534, paired bootstrap; negative means V2 is better):
- V1: -0.276 [-0.466, -0.070], significant.
- V2's own Elo: -0.801.
- 3-feature ridge: -0.387 [-0.573, -0.202], significant.
- 8-feature ridge: -0.057 [-0.136, +0.023], NOT significant.
- C alone: -0.051 [-0.108, +0.004], NOT significant.
- D alone: -0.022 [-0.077, +0.033], NOT significant.
REASON: V2 beats the champion and naive models, but only on inspected data. It does not beat a simple ridge, so the
extra complexity is unproven.

-------------------------------------------------------------------------------------------------
10. MARKET BASELINE CHALLENGE
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §7. FINDINGS.md F-06.
STATUS: FAILED.
RESULTS (V2 minus the market; positive means the market is better):
- Holdout MAE vs the opener: +0.279 [+0.101, +0.459].
- Holdout MAE vs the close: +0.363 [+0.175, +0.556].
- Brier vs the close: +0.0035 [+0.0002, +0.0066].
- 2026 true finals vs the close: +1.135 (n 208).
- By season, V2 beat the close in 0 of 8 and the opener in 1 of 8.
REASON: V2 is less accurate than the market in every window. That blocks any claim to beat the market and any
betting use. It does not block shadow, which claims nothing.

-------------------------------------------------------------------------------------------------
11. PURE-MODEL ISOLATION TEST
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §8. purity.js/purity.py; attack.js.
STATUS: PASSED.
RESULTS:
- 46,920 fuzzed decide() calls (391 rows x 3 overlay sets x 40 wild markets) left pure() unchanged.
- Smuggled market fields were ignored, and decide() never mutates its input.
- 14 injected market columns in Python changed nothing.
- In H3, canonical.pure() is the only caller of engine.pure.
REASON: The pure projection cannot be moved by the market.

-------------------------------------------------------------------------------------------------
12. DOUBLE-COUNT AUDITS
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md phase-2 items 20-23. TECHNICAL.txt §15.
STATUS: PARTIAL.
PER LAYER:
- Players: no double count. The QB is under-counted instead (F-24).
- Matchup: adds nothing. The artifact is NO_ADJUSTMENT, and match_mix_edge correlates 0.93 with edge_epa.
- Priors: no inflated early certainty. Early predictions are too timid (slope 1.21).
- Market: a double count is CONFIRMED. |gap|, the theoretical EV and the pure cover probability have Spearman
  0.998-1.0 (dev n 8,246), so one signal is counted three times.
REASON: The market triple count cannot create a BET while betting is disabled. It does mean that "several signals
agree" is really one signal, so it must not be presented as confirmation.

-------------------------------------------------------------------------------------------------
13. SIGN / MAPPING AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §10. v2.audit.mapping; attack.js. FINDINGS_PHASE3.txt F-32.
STATUS: PASSED for the core and the stored data. A LOW gap remains in the row contract.
RESULTS:
- Five hand-computed games agree with the stored values and the engine: a home favourite, a road favourite, a
  neutral site, an integer push and the model on the underdog.
- 66 collision probes (Miami / Miami (OH), USC / South Carolina, ...) resolve correctly.
- F-11 (12 games with home/away ids swapped, 158 opposite-sign book lines) is fixed in v2.1.1.
- F-32: canonical.pure does not check identity. A row with the home and away names swapped but the ids kept is
  published with the fair line on the wrong team.
REASON: The pipeline that produces rows is correct. The service would not catch a row corrupted outside it, and
that is a defence-in-depth gap.

-------------------------------------------------------------------------------------------------
14. ODDS / EV MATH AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §10. oddsmath.js.
STATUS: PASSED, 28/28 textbook checks across engine.js, decision.js and lab_core.js:
- break-even;
- devig;
- EV with push mass;
- minimum-price rounding;
- a push pays 0 units;
- CLV orientation.
LOW (F-18): the shipped push probability at 7 (0.058; 0.0655 in policy v1's table) sits at or below the interval
measured at the close: 9.3% [6.6, 13.1].
REASON: The arithmetic is correct.

-------------------------------------------------------------------------------------------------
15. CLV AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §10-11. v2.audit.lab_record. FINDINGS.md F-14, F-19.
STATUS: Arithmetic PASSED. Evidence quality FAILED.
RESULTS:
- 510 of 510 Lab evaluations recompute with 0 mismatches across 10 fields.
- All 231 Lab closes are one book (DraftKings via ESPN), provider-declared, and observed 3-289 hours after kickoff.
- The 180-minute consensus rule has never fired.
- Historical closes have no timestamps.
REASON: CLV cannot be used as evidence of an edge until a multi-book, timestamped, pre-kickoff close exists.

-------------------------------------------------------------------------------------------------
16. EXECUTION REALISM AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §11. phase2.py. FINDINGS.md F-25.
STATUS: FAILED, and not testable.
HISTORY: The simulation fills at an untimestamped opener at an assumed -110, and there are no prices after 2019.
LINE SHOPPING (F-25; dev 2016-19, n 2,736):
- consensus ROI: -7.0% [-10.5, -3.4];
- best of about 20 books: -1.9% [-5.6, +1.7];
- best within 1.5 points of consensus: -3.6%;
- 19.2% of "best" lines are at least 1.5 points off consensus.
LIVE: one book, and only 37 priced spread quotes. Latency cannot be measured.
REASON: No execution claim is supported. This blocks any betting approval.

-------------------------------------------------------------------------------------------------
17. CALIBRATION REPRODUCTION
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §12. v2.audit.accuracy. failclosed.js (F-34).
STATUS: PASSED for win probability. FAILED for cover probability.
WIN (holdout n 1,607):
- Brier 0.1829 [0.1746, 0.1919];
- ECE 0.020;
- slope 1.056 [0.937, 1.198];
- the mean prediction of all 10 buckets falls inside the bucket's Wilson CI.
COVER: log loss 0.6932 on the holdout, against 0.6931 for a coin; slope CI [-0.72, 2.01].
F-34 (LOW): if the calibration block is removed, the service silently falls back to raw probabilities.
REASON: The win probability is calibrated on average. The cover probability has no skill and should not be shown.

-------------------------------------------------------------------------------------------------
18. RELIABILITY AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §12. FINDINGS.md F-12.
STATUS: FAILED (decorative).
RESULTS:
- Spearman of reliability against |error|: +0.009 on dev and -0.010 on the holdout (p 0.68).
- The 90+ bucket's 80% coverage is 0.743 (n 303).
- RMSE is flat across sigma quintiles (15.8-16.2).
REASON: The score does not rank precision. It must not be presented as precision; replace it with a constant width
per week bucket (part 37).

-------------------------------------------------------------------------------------------------
19. EDGE-QUALITY AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §15, item 40. FINDINGS.md F-23. CANONICAL.md §12.
STATUS: FAILED as named. Fixed in labelling (H3).
RESULTS:
- The tiers rank CLV: 0.11 / 0.22 / 0.84.
- Close-implied EV is at or below 0 in every tier: -0.039 / -0.033 / -0.001.
- Holdout ROI is not monotone: -2.4% / -6.0% / +2.3%.
- H3 shows the tier as "closing-line tendency", and the explanation audit refuses "edge quality" wording.
REASON: This is a closing-line-movement indicator, not a measure of bet quality.

-------------------------------------------------------------------------------------------------
20. MARKET-MOVEMENT AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §13. v2.audit.market_move.
STATUS: SOME EVIDENCE.
RESULTS:
- Share of moved lines that moved toward the predictor (holdout, n 1,385 moved lines):
  - V2: 54.7% [52.1, 57.3];
  - V1: 53.4%;
  - ridge: 50-54%;
  - random placebo: 50-52.5%.
- The mean move is +0.26 points.
- Permutation within season-week: CLV p < 0.001.
REASON: A small signal that the market later absorbs. It is measured on the inspected holdout with untimestamped
closes, and it is smaller than the vig. It is not an edge.

-------------------------------------------------------------------------------------------------
21. LUCK / RANDOMIZATION TESTS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §13.
STATUS: DELIVERED. The result is negative for an edge.
RESULTS:
- ATS at the opener: 51.0% [48.5, 53.4], p = 0.87 against break-even.
- ROI: -2.6% [-7.1, +2.0].
- ATS at the close: 49.97%.
- Permutation ATS p = 0.14 on the holdout. Dev gives p = 0.001, but that is in-sample.
REASON: The historical results are consistent with no betting edge.

-------------------------------------------------------------------------------------------------
22. PLACEBO / LEAKAGE TESTS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §4 (items 47-50). v2.audit.placebo.
STATUS: PASSED. The tests have power.
RESULTS:
- Noise columns take 0.6% of the gain and change MAE by at most +0.005.
- Shuffled labels give MAE 15.55 / 15.65, near the mean predictor's.
- Time reversal changes MAE by at most 0.004.
- Injecting end-of-season ratings (a planted leak) drops MAE to 10.40 / 10.17, so the tests detect a real leak.
- F-15, a guard that checked names only, is fixed in v2.1.1 with a standing outcome scan.
REASON: No leak was found, and the tests are shown to detect one.

-------------------------------------------------------------------------------------------------
23. PAIRED BOOTSTRAP MODEL COMPARISONS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §7 and §15 (patch deltas). v2.audit.baselines.
STATUS: DELIVERED.
METHOD: game-level paired bootstrap (2,000 resamples, seed 20260928), with a season-week cluster bootstrap beside it
for every comparison in parts 9-10.
PATCH DELTAS (true finals, holdout n 1,606):
- v2.1.1 minus v2.1.0: +0.0028 [-0.003, +0.009];
- v2.1.2 minus v2.1.1: -0.0020 [-0.007, +0.003].
REASON: Every comparison carries its uncertainty. The patches are accuracy-neutral.

-------------------------------------------------------------------------------------------------
24. PRACTICAL SIGNIFICANCE ANALYSIS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §7. FINDINGS.md §112.
STATUS: DELIVERED.
RESULTS:
- The gain over V1 is 0.276 points (2.2% of MAE), on inspected data.
- The gain over the best simple baseline is 0.057 points (0.46%) and is not significant.
- The per-game SD of V2 minus V1 is about 3.8 points, so a CI of +/-0.2 needs about 1,400 games.
REASON: The practical value of the complexity over a simple ridge is not established.

-------------------------------------------------------------------------------------------------
25. SUBGROUP ROBUSTNESS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §14. v2.audit.accuracy. FINDINGS.md F-17.
STATUS: PARTIAL.
BIASES (dev + holdout unless stated):
- P4 home vs G5: +2.83 [1.73, 3.94].
- Favourites of 28+ at the close: +4.04 [2.49, 5.59]; the close is off by +0.44.
- First-career-start QB: -1.85 [-3.15, -0.55] on dev and -3.29 [-5.75, -0.83] on the holdout.
- FBS vs FCS: +6 to +9.
ROBUST:
- Teams: 0 of 133 are Bonferroni-significant (1 of 134 on the holdout).
- V2 beats V1 in 6 of 6 dev seasons and 2 of 2 holdout seasons.
REASON: V2 has structural biases the market does not share. Document them. They must not be corrected in-season
(brief items 116-117).

-------------------------------------------------------------------------------------------------
26. QB / PERSONNEL AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md phase-2 items 20, 62-65. TECHNICAL.txt §15. FINDINGS.md F-24.
STATUS: FAILED for QB identity. Personnel is RESEARCH ONLY.
RESULTS:
- Replacing the expected starter with a first-timer moves the snapshot by -0.013 on average.
- The live overlay (-0.99 for OUT) is dormant and not keyed to the player.
- Non-QB units failed the holdout. Live absence deltas are at most 0.71 points. No adjustments are absurd.
REASON: The model is blind to QB changes, which the market prices. That is acceptable in shadow and disqualifying
for betting.

-------------------------------------------------------------------------------------------------
27. MATCHUP AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md phase-2 items 21, 66-68. TECHNICAL.txt §15. FINDINGS_PHASE3.txt F-38.
STATUS: RESEARCH ONLY. It adds nothing.
RESULTS:
- The production artifact is NO_ADJUSTMENT.
- The best dev correction is -0.0045 [-0.022, +0.013].
- Shadow corrections are capped at +/-3.
- 62,243 similar-opponent pairs show 0 look-ahead.
- Archetypes are measured k-means clusters.
- MATCHUP_SHADOW skips on a fresh build.
REASON: Nothing in production depends on it, so it neither supports nor blocks approval.

-------------------------------------------------------------------------------------------------
28. UNCERTAINTY COVERAGE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §12. FINDINGS.md F-16. FINDINGS_PHASE3.txt F-33.
STATUS: PASSED on average. FAILED conditionally.
AVERAGE: 0.508 / 0.814 / 0.951 on the holdout (n 1,607).
UNDER-COVERAGE:
- Weeks 0-2, 80% range: 0.791 [0.763, 0.816].
- Week-1 QB unknown, 80% range: 0.774 [0.735, 0.808].
- Postseason, 50% range: 0.454 [0.403, 0.506].
- FCS 2026, 80% range: 0.733 [0.646, 0.805].
- The early-season slope is 1.21.
F-33: the row contract accepts any sigma in [3, 40]. A sigma of 8 passes and moves p_home from 0.454 to 0.409.
REASON: The ranges are honest on average but too narrow early in the season and in bowls. Label them as
unconditional.

-------------------------------------------------------------------------------------------------
29. WORST 50 PREDICTIONS
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §14. out_h/audit/worst50.csv and best50.csv (v2.audit.accuracy).
STATUS: DELIVERED.
RESULTS:
- Mean |error| is 51.1, against the close's 47.7.
- Classes: 34 ordinary variance, 10 QB different from expected, 3 data (incomplete play-by-play), 3 model.
- Tails match Normal(sigma): 21.1% of misses exceed 20 points (22.0% expected); 6.2% exceed 30 (6.6% expected).
REASON: The worst misses are mostly variance and QB changes. No hidden data bug was found beyond F-01 and F-08.

-------------------------------------------------------------------------------------------------
30. FALSE-EDGE ANALYSIS
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md item 75 table. TECHNICAL.txt §15, items 75-77.
STATUS: DELIVERED.
FALSE EDGES (|gap| >= 7, n 443): compared with correct edges, the failed ones over-represent:
- early season: 66% vs 58%;
- week-1 QB unknown: 21.5% vs 15.2%;
- P4 vs G5: 37% vs 30%;
- a close that moved toward V2 is less common: 27% vs 44%.
MISSED EDGES: n 305.
MARKET MOVED AWAY: n 34. The close was nearer the result 61.8% of the time.
REASON: Large gaps concentrate where V2 is weakest (early season, QB, P4 vs G5). They are not evidence of edge.

-------------------------------------------------------------------------------------------------
31. PRODUCTION / BACKTEST CONSISTENCY
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §2, §8, §16. reproduce.js; attack.js. FINDINGS.md F-02.
STATUS: PASSED for the numbers.
RESULTS:
- The production scorer equals research to within 7e-15.
- projections.build is byte-identical at a fixed as_of.
- F-02 (the replay was published under the wrong version) is fixed in v2.1.1 with per-row versions.
CAVEATS:
- Production still runs v2.1.0, and the recommended v2.1.2 needs the governed switch.
- The week replay covers only v2.0.0 rows (F-38).
REASON: Backtest and production produce the same number.

-------------------------------------------------------------------------------------------------
32. EXPLANATION-LAYER AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md items 83-84. FINDINGS_PHASE3.txt F-30, F-31.
        supabase/functions/edgedesk_ai/_cfb_explain.js cfbFacts().
STATUS: PARTIAL.
PASSED:
- The fact-boundary guard refuses invented numbers, status words and reversed sides.
- It refuses "edge quality" wording.
- A non-governed status is stated as NO BET.
OPEN:
- cfbFacts carries official_decision without the betting-switch check (F-30).
- At fallback level 3 it would state an OFFICIAL V2 status with no V2 numbers and no fallback mode (F-31).
NOT TESTED: live AI output was not sampled, and no newsletter consumes V2. V1 editorial issues are in F-28.
REASON: The guard is sound on numbers. The decision field it trusts needs a consumer-side guard.

-------------------------------------------------------------------------------------------------
33. INFRASTRUCTURE FAILURE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS_PHASE3.txt §C (items 81-82, 86-94). TECHNICAL.txt §16. attack.js, failclosed.js, betattack.js.
STATUS: PASSED with findings.
ATTACKS:
- 19 of 26 attacks behaved as required.
- 9 of 11 artifact corruptions fail closed. The other 2 soft-fail to raw calibration (F-34).
- A missing input contract stops the service from starting.
- No BET could be produced from decision.js, even with a hacked policy.
RETRIES AND RUNTIME:
- Retries are bounded and classified: a deadlock gets 5 attempts with waits of 150/300/600/1200 ms.
- A real two-session deadlock on Postgres is handled.
- The pipeline is idempotent, and the week-3 replay is deterministic (0 after-kickoff snapshots, 0 bets).
SUITES: about 1,158 assertions across 13 suites, all green at b6eae62e9. The key suites and the sync dry-runs are
also green at 765002ec6.
OPEN:
- F-30 and F-31 (MEDIUM).
- F-32 to F-36 (LOW).
- Single points of failure:
  - CRITICAL: the sportsdataverse assets, GitHub Actions, the frozen artifact;
  - HIGH: the single sportsbook feed, Supabase.
REASON: No wrong V2 number and no false BET came from producer-written data. The decision-field guards must be
fixed before production (part 47).

-------------------------------------------------------------------------------------------------
34. GOVERNANCE AUDIT
-------------------------------------------------------------------------------------------------
WHERE:  TECHNICAL.txt §17. FINDINGS.md items 95-99. football/cfb_production/promotion.js.
STATUS: PASSED in design. It has never been exercised.
RESULTS:
- champion_selection is NOT_RUN, and the champion is V1.
- A retrain produces a challenger only.
- Thresholds are versioned (policy sha cb9019a2...).
- Postgres enforces append-only storage. The git ledgers can be rewritten by any commit.
- The public V1 record re-grades exactly: 231 graded, 104-125-2.
- F-37: the promotion floor of 150 live pairs cannot confirm a 0.28-point gain.
REASON: Governance is sound enough for shadow. Its promotion floor is below what the audit requires (part 47).

-------------------------------------------------------------------------------------------------
35. EVIDENCE MATRIX (final; this supersedes FINDINGS.md §100 by adding the sample size, the uncertainty and H3)
-------------------------------------------------------------------------------------------------
Format: COMPONENT | HYPOTHESIS | FOR | AGAINST | N | UNCERTAINTY | STATUS
Point-in-time pipeline | no look-ahead | bit-exact rebuild; re-solve 1e-8; n_obs check; timestamps; outcome scan;
  planted-leak power test | provider EP fit through 2025; provider revisions untestable; F-08 | 63,851 rating rows;
  12,950 snapshots | exact checks | STRONG (architecture)
Pure/market isolation | the market never moves the pure number | fuzzed decide(); injected columns; one engine.pure
  caller | none | 46,920 calls | exact | STRONG
Reproducibility | the same inputs give the same numbers | 11,262/11,262; 174/174; 510/510; deterministic replay |
  replay covers only v2.0.0 rows | as listed | exact | STRONG
V2 accuracy vs V1 | V2 beats V1 | -0.276 points; 6/6 dev and 2/2 holdout seasons | holdout inspected >= 13 times;
  no prospective row | 1,534 | [-0.466, -0.070] | SUPPORTED (inspected data only)
V2 vs simple ridge | the complexity earns its keep | -0.057 points | CI includes 0; C alone -0.051 | 1,534 |
  [-0.136, +0.023] | TENTATIVE
V2 vs market | adds accuracy beyond the line | none | opener +0.279, close +0.363, 2026 +1.135; ATS at the close
  49.97% | 1,534 / 208 | [+0.101, +0.459] / [+0.175, +0.556] | FAILS
Market movement toward V2 | the market later moves toward V2 | 54.7% of moved lines (baselines 50-53%); CLV
  permutation p < 0.001 | inspected; untimestamped close; about 0.26 points, below the vig | 1,385 moved |
  [52.1, 57.3] | TENTATIVE
Win probability | calibrated | ECE 0.020; slope 1.056 | Brier worse than the close's by 0.0035 | 1,607 |
  slope [0.937, 1.198] | SUPPORTED
Cover probability | has skill | none | log loss 0.6932 vs 0.6931 for a coin | 1,607 | slope [-0.72, 2.01] |
  NOT SUPPORTED
Intervals (average) | nominal coverage | 0.508 / 0.814 / 0.951 | none | 1,607 | about +/-0.02 | SUPPORTED
Intervals (conditional) | nominal in every group | dev weeks 5+ | weeks 0-2 0.791; postseason 50% 0.454; FCS 0.733 |
  subgroups (n in out_h/audit/accuracy.json) | [0.763, 0.816], [0.403, 0.506], [0.646, 0.805] | TENTATIVE
Sigma / reliability score | a higher score means a lower error | none | Spearman -0.010; 90+ bucket covers 0.743 |
  1,607 / 303 | p 0.68 | NOT SUPPORTED (decorative)
QB handling | V2 reacts to the starter | direction measured on dev | snapshot -0.013; first-start bias -1.85 / -3.29 |
  dev and holdout QB groups | [-3.15, -0.55] / [-5.75, -0.83] | NOT SUPPORTED; overlay RESEARCH ONLY (dormant)
Injury / weather overlays | honest widening | declared | not fitted; dormant | none | none | RESEARCH ONLY
Personnel units | improve the line | QB oracle direction | non-QB failed the holdout | their evidence | none |
  RESEARCH ONLY
Matchup residual | improves the line | none | dev -0.0045 | dev out-of-fold | [-0.022, +0.013] | RESEARCH ONLY
Line shopping / market intelligence | improves the price | best of 20 books -1.9% | consensus -7.0%; 19.2% of best
  lines off-market | 2,736 | [-5.6, +1.7] / [-10.5, -3.4] | RESEARCH ONLY (push model TENTATIVE)
Decision policy v1 | finds +EV bets | LEAN CLV 0.60 vs PASS 0.11 (stage-8 dev) | calibrated EV -0.0317 at every
  price; LEAN ATS at the close 50.7% | 1,641 / 2,000 | none | no BET, correctly disabled; decision value UNPROVEN
Closing-line tendency tiers | rank bet quality | monotone in CLV | close-implied EV <= 0 in every tier; ROI not
  monotone | dev tiers | none | a CLV indicator only (label fixed in H3)
Model Lab settlement | correct math | 510/510; 0 mismatches over 10 fields | closes single-book, observed after
  kickoff | 510 / 231 closes | exact | arithmetic STRONG; CLV evidence TENTATIVE
Canonical service (H3) | fails closed, no wrong number, no false BET | 19/26 attacks behaved; 9/11 corruptions
  refused; no BET reachable; about 1,158 suite assertions | F-30, F-31 decision-field guards; F-32 to F-36 |
  26 attacks, 11 corruptions | none | SUPPORTED (with required fixes)
Governance / promotion | nothing unvalidated is promoted | guard requires ELIGIBLE, compatibility and tests |
  never exercised; floor of 150 pairs (F-37) | 0 promotions | none | SUPPORTED in design, UNTESTED in operation

-------------------------------------------------------------------------------------------------
36. STRONG / SOME / UNKNOWN EVIDENCE SUMMARY (final)
-------------------------------------------------------------------------------------------------
WE HAVE STRONG EVIDENCE
- The pipeline is point-in-time and reproduces exactly.
- The pure number is isolated from the market.
- Signs, odds and push math, settlement, CLV arithmetic and the public-record math are correct.
- Average interval coverage is nominal.
- V2 is LESS accurate than the opening and the closing line in every window.
- No historical betting rule survives out of sample, and no betting edge exists at the close.
- The sigma, reliability and cover-probability outputs carry no discriminating information.
- The canonical service refuses bad inputs and damaged artifacts, and it cannot produce a BET from producer data.
WE HAVE SOME EVIDENCE
- V2 beats V1 and simple Elo, but only on inspected data.
- Win probabilities are calibrated on average.
- The close moves toward V2 slightly more often than toward the baselines.
- LEAN gains more CLV than PASS.
- The key-number push model beats the bucket table.
- The F-21 fix is accuracy-neutral: -0.0020 [-0.0070, +0.0030].
- Retries and deadlock handling work on a real Postgres.
WE DO NOT YET KNOW
- Any prospective accuracy. The cfb_v2 sync dry-run at 765002ec6 finds 0 frozen V2 files, and the first freeze is
  2026-09-29.
- Whether V2 beats a simple ridge.
- How V2 handles live QB changes, transfers and freshmen.
- CLV at a real multi-book, pre-kickoff close.
- Any price-level edge.
- Whether provider data is point-in-time.
- How the H3 service behaves over a full season. Today 2 of 60 games are FULL and 0 governed decisions exist.
- Behaviour during a week-long play-by-play outage, end to end.
- Whether the decision layer adds value.

-------------------------------------------------------------------------------------------------
37. FINAL SIMPLIFICATION DECISIONS
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md §104. CANONICAL.md §12 (H3 relabelling).
STATUS: DELIVERED as recommendations. The audit applied none.
WHY NONE WERE APPLIED: brief item 104 permits a removal only with evidence from a completed championship, and none
was run. The owner decides through the governed process.
ALREADY DONE (H3):
- The stage-8 engine.decide() status is relabelled RESEARCH, so there is one official decision engine (F-22).
- "Edge quality" is renamed "closing-line tendency" (F-23).
REMOVE OR MARK RESEARCH ONLY (removing them would not make performance materially worse):
- The reliability score and the heteroscedastic sigma model. Replace them with a constant width per week bucket
  (F-12: Spearman about 0).
- The displayed cover probability (no skill).
- ens_sd as a sigma input (F-26: wrong sign, about 0).
- The dormant QB, injury and weather overlays, unless they are keyed to qb_id and validated.
DECIDED LATER, FROM PROSPECTIVE DATA:
- D (the GBM). C alone is worse by only +0.051 [-0.004, +0.108]. Track C-only in shadow, and do not remove D without
  prospective evidence.
KEEP:
- V1 as champion.
- The C+D ensemble as the shadow model.
- The governed decision policy with betting disabled.

-------------------------------------------------------------------------------------------------
38. FINAL FEATURE MANIFEST
-------------------------------------------------------------------------------------------------
WHERE:
- FINDINGS.md §105: the 51 C/D inputs by family, with source, timing, transform and null handling.
- football/cfb_production/contract/input_contract.json (cfb_input_contract_1): 60 model inputs.
  - Consumers: 32 used by C and D, 9 by C only, 8 by D only, 2 by D and sigma, 5 by sigma, 2 by sigma and
    reliability, 1 by TotalE, 1 context.
  - Each input has a type, a HARD range (training min/max widened by half the span) and a SOFT range (p01-p99).
  - Null policy: REFUSE for 56 inputs and ALLOWED_BEFORE_FIRST_GAME for 4.
  - Each input records the model's null behaviour.
- football/cfb_production/contract/feature_reference_edgedesk_cfb_v2.1.0.json.
STATUS: PARTIAL.
- Name, source, timing, transform and null policy are documented.
- The per-feature definition lives only in the stage-5 code.
- "Reason retained" is not documented per feature, and the evidence is weak for several:
  - in v2.1.0, three C/D inputs (edge_expl_pass, edge_st_net, edge_fg_value) and the sigma input to_dependence
    (built from to_rate, snapshots.py:163) read prior-only ratings (F-21, fixed in v2.1.2);
  - 8 QB inputs have near-zero influence (F-24);
  - 17 input pairs have |r| >= 0.95.
REASON: No feature was removed, because no championship evidence exists (part 37). The manifest is sufficient for
shadow. A production release needs a per-feature "reason retained" column.

-------------------------------------------------------------------------------------------------
39. FINAL PRODUCTION ARCHITECTURE
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md §106 (updated here for H3). docs/cfb-production/CANONICAL.md and ARCHITECTURE.md.
STATUS: DELIVERED.
THE PIPELINE:
1. TEAM STATE: stages 1-2 (play-by-play to team-game; games and market, with the F-01 finality rule and the F-11
   orientation fix).
2. Stage 3: joint Gaussian opponent-adjusted ratings at each Tuesday 12:00 UTC freeze (F-21 fixed in v2.1.2).
3. Stage 4: QB state and Elo.
4. Stage 5: the frozen snapshot, with no market columns.
5. MODEL C (ridge, alpha 30) and MODEL D (LightGBM).
6. ENSEMBLE: 0.5 / 0.5.
7. UNCERTAINTY: a Gamma GLM sigma, a Student-t with df 100, and conformal |z| quantiles. The reliability score is
   decorative.
8. CALIBRATION: raw for the win probability. Cover uses Platt but has no skill.
9. PURE PROJECTION FREEZE: write-once current.json and snapshots, each row carrying its model_version.
10. CANONICAL SERVICE: the input contract, then canonical.pure() (the only engine.pure caller), then numeric
    checks, then modes, then the fallback resolve (1 FULL, 2 DEGRADED, 3 FALLBACK_MODEL (V1), 4 UNAVAILABLE),
    then reports/projections.json, then display (app panel, debug view, AI facts).
11. MARKET ENGINE: Model Lab quotes and a market-integrity verdict. The stage-8 engine.decide() is stored only as a
    labelled research field.
12. DECISION ENGINE: decision.js cfb_decision_engine_v1 with policy v1, in shadow, betting disabled.
13. MODEL LAB: write-once hourly snapshots, settlement, CLV, and the promotion evaluation.
IN PRODUCTION TODAY: edgedesk_cfb_v2.1.0.
RECOMMENDED: edgedesk_cfb_v2.1.2, via the governed switch.
OPEN AT STEP 10: F-30 and F-31.

-------------------------------------------------------------------------------------------------
40. FINAL DECISION POLICY
-------------------------------------------------------------------------------------------------
WHERE:
- football/cfb_v2/artifacts/decision/cfb_decision_policy_v1/policy.json (sha cb9019a29de2..., SHADOW,
  bet_enabled false, prereg sha bd279336...).
- football/cfb_decision/decision.js lines 448-553 (per book) and 690-705 (per game).
- projections.officialDecision.
STATUS: DELIVERED. BET is correctly unreachable. Two guards are required (F-30, F-31).
PER BOOK QUOTE, in order:
- NO_BET: the pure number is not PREDICTED; the policy or the calibration artifact is invalid or built for another
  model version; the quote is missing; or a computation fails. Each fails closed.
- PASS:
  - PASS_MARKET_INVALID: the quote is invalid or quarantined.
  - PASS_DATA_QUALITY: the integrity check fails.
  - PASS_MARKET_STALE: the market is older than 180 minutes, or its age is unknown.
  - PASS_PRICE: there is no price, or it is worse than -125.
  - PASS_MARKET_DISPERSION: the book IQR is above 1.5.
  - PASS_LINE_MOVED: the line moved past the previous bettable-to line.
- "Clears" means a probability edge of at least 0.01 AND a calibrated EV of at least 0.00. A previous BET on the
  same side is held within a 0.003 buffer.
- If it clears:
  - RESEARCH if the QB is missing or unsettled, there are fewer than 3 books, data are incomplete, or the edge is
    extreme (gap 10 points, EV 0.12 or cover probability 0.60);
  - otherwise PASS if football confidence is below 40 or the ensemble SD is above 6;
  - otherwise LEAN with NO_BET_BETTING_DISABLED while bet_enabled is false;
  - otherwise PASS if the market is not ACTIONABLE;
  - otherwise BET: flat 1 unit, at most 1 unit per game, 10 per slate.
- If it does not clear:
  - LEAN if the probability edge is above 0, |gap| is at least 0.5 points, and there is no research flag;
  - RESEARCH if the same conditions hold with a research flag;
  - otherwise PASS (PASS_PRICE when the edge is at or below 0, PASS_INSUFFICIENT_EV otherwise).
- WAIT: disabled (wait.enabled false).
- BET: unreachable. bet_enabled is false, and the calibrated EV is -0.0317 at every price.
PER GAME: BET if any book says BET; otherwise the highest of RESEARCH > LEAN > PASS > NO_BET.
OFFICIAL STATUS: the newest governed CHALLENGER decision (engine v1, policy v1) per book at as_of. It is
NO_DECISION when there is none and UNAVAILABLE at level 4.
REQUIRED BEFORE PRODUCTION:
- F-30: never publish BET while the policy's bet_enabled is false. Run numeric.policyConsistency in
  officialDecision and in cfbFacts.
- F-31: at level 3 the official decision is FALLBACK or NO_DECISION.

-------------------------------------------------------------------------------------------------
41. FINAL DATA REQUIREMENTS
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md §106-108 (updated here). CANONICAL.md §11. input_contract.json. FINDINGS_PHASE3.txt item 94.
STATUS: DELIVERED.
CRITICAL
- Schedule (with the completed flag and the provider status) and play-by-play, both from sportsdataverse. If they
  are missing or not final, the game is not scored. A CRITICAL contract violation withholds the game: it is not
  inferred, not published and not decided. The weekly gate holds the week.
- The frozen artifact and params.js. If they are missing or corrupt, the result is UNAVAILABLE, or the service
  refuses to start.
- The input contract. If it is missing, the service refuses to start.
IMPORTANT
- Market quotes. If they are missing or not OK, the mode is MARKET_DEGRADED: the football number is unchanged and
  the game is not actionable.
- The V1 board. If it is missing, a game whose V2.1 row is refused goes to level 4 UNAVAILABLE instead of level 3.
  The failure is reported (sources.v1_error), not hidden.
- Priors. If they are missing, missingness flags are set and the prior widens.
OPTIONAL
- Availability, the QB report and injuries. If they are missing, the mode is NO_PLAYER_DATA or QB_UNCERTAIN: the
  mode is labelled in words and the confidence score is hidden.
- Weather. It is not an input, and its overlay is dormant.
- PBP completeness below 0.9 gives the mode NO_ADVANCED_PBP.
GAP (F-35): a stale current.json has no mode. health.js warns only after 8 days.
TODAY: 55 of 60 games are degraded (F-38).

-------------------------------------------------------------------------------------------------
42. FINAL KNOWN LIMITATIONS
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md §119 (updated here).
STATUS: DELIVERED.
EVIDENCE
- There is no untouched history. 2024-25 was inspected at least 13 times, and 2026 weeks 0-4 were inspected.
- No prospective V2 row has settled.
- Provider immutability cannot be tested, and the EP model was fitted through 2025.
DATA
- Historical prices end in 2019, and openers carry no timestamps.
- The live market is one book: closes are provider-declared and observed after kickoff, and only 37 quotes carry a
  price.
- Play-by-play is incomplete for 3-6% of games since 2021.
- There is no historical injury, weather or depth-chart data.
MODEL
- The snapshot ignores QB identity (F-24).
- Non-QB personnel, transfers and freshmen are unvalidated.
- Biases: P4 vs G5 +2.8, favourites of 28+ +4.0, FBS vs FCS +6 to +9.
- Intervals under-cover early in the season, in week 1 and in bowls.
- The sigma, reliability and cover-probability outputs are decorative.
- F-21 is still present in production v2.1.0; the governed switch has not happened.
SERVICE
- 55 of 60 games are degraded.
- The decision-field guards are missing (F-30, F-31).
- There is no row provenance or identity check (F-32).
- The sigma row range is loose (F-33).
- Calibration fails soft (F-34).
- A stale current.json has no mode (F-35).
- HTTP 503 is not retried (F-36).
- The replay covers only v2.0.0 rows.
GOVERNANCE
- No promotion has ever run, and the floor of 150 pairs is low (F-37).
- The git ledgers can be rewritten; Postgres is the enforcement point.

-------------------------------------------------------------------------------------------------
43. FINAL RESEARCH BACKLOG (evidence-cited; not implemented)
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS.md §121 (updated here: F-21 and F-22 are closed).
STATUS: DELIVERED.
REQUIRED FIXES (defects, not research; the orchestrator's queue):
- F-30 and F-31 (MEDIUM).
- F-32, F-33, F-34, F-35 and F-36 (LOW).
- The governed switch to v2.1.2.
HIGH
- A snapshot that knows QB identity, or a game-day overlay keyed to qb_id. Evidence (F-24): the first-start bias is
  -1.85 [-3.15, -0.55] on dev and -3.29 [-5.75, -0.83] on the holdout, and the snapshot moves only -0.013.
- Multi-book, timestamped, pre-kickoff capture. Evidence (F-14, F-25): 231 of 231 closes are single-book and
  observed after kickoff, and 19.2% of "best" lines are off-market.
MEDIUM
- The shape of the prior fade. Evidence: the slope is 1.21 [1.12, 1.30] in weeks 0-2 and 0.92 [0.86, 0.98] in weeks
  5-9.
- The P4-vs-G5 (+2.83) and 28+ favourite (+4.04) biases.
- Conditional under-coverage (F-16).
- Replacing sigma and the reliability score with a constant width per week bucket (F-12).
- A play-by-play completeness gate for 2021 on (F-08).
- The key-number push table at 7 (F-18).
- C-only against C+D, decided on prospective data (F-05).
LOW
- The sign of ens_sd (F-26).
- V1 editorial naming (F-28).
- An FCS model (+6 to +9; not priced).
- Raising the promotion floor toward about 700 pairs (F-37).

-------------------------------------------------------------------------------------------------
44. RELEASE MANIFEST
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS_PHASE3.txt item 110. football/cfb_production/manifest.json. SNAPSHOT.json.
STATUS: NOT ISSUED, because no release is approved. The components exist and verify:
- Code:
  - b6eae62e9 (PR #391), plus 765002ec6 (tests only);
  - params.js sha 35845306...;
  - engine.js sha 745c1c3c....
- Models:
  - v2.1.0 MANIFEST 356bd0f9...;
  - v2.1.1 MANIFEST 5081956d...;
  - v2.1.2 MANIFEST 38a0d952....
- Calibration and uncertainty, from manifest.json: calibration edgedesk_cfb_v2.1.0:97cadb764756; uncertainty
  edgedesk_cfb_v2.1.0:87ab0a945da9.
- Feature definitions: the feature schema hash in SNAPSHOT.json, input contract cfb_input_contract_1, and
  feature_version cfb_v2_fv2.
- DB schema: the cfb_*.sql DDL hashes in SNAPSHOT.json. There is no schema_version column.
- Decision policy: cfb_decision_policy_v1, sha cb9019a29de20cefd96ac7dbb95b9a5f79381dfb5c2df469d7cb33992c9142fe;
  calibration cfb_decision_calibration_v1.
REASON: A release manifest certifies an approved release. When A is reached, issue it for v2.1.2 with the hashes
above, the v2.1.2 calibration and uncertainty hashes, and a DB schema version.

-------------------------------------------------------------------------------------------------
45. FINAL MODEL VERSION
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS_PHASE3.txt item 109. PATCH_v2.1.2.md §9.
STATUS: NONE ASSIGNED.
- The governance champion remains V1, edgedesk_cfb_p4_v1.0.0.
- The recommended SHADOW version is edgedesk_cfb_v2.1.2: v2.1.0 plus the F-01, F-02, F-10, F-11, F-15 and F-21
  fixes. Its accuracy is indistinguishable (-0.0020 [-0.007, +0.003] against v2.1.1).
- It is switched through the governed four-part change.
REASON: Brief item 109 assigns a final version only "if the audit passes". It passed for shadow, not for
production.

-------------------------------------------------------------------------------------------------
46. APPROVAL CLASSIFICATION
-------------------------------------------------------------------------------------------------
WHERE:  FINDINGS_PHASE3.txt §D. EXECUTIVE.txt.
STATUS: B - APPROVED FOR SHADOW MODE ONLY.

-------------------------------------------------------------------------------------------------
47. EXACT REASONS FOR APPROVAL OR NON-APPROVAL
-------------------------------------------------------------------------------------------------
APPROVED FOR SHADOW because:
- a1 The data are point-in-time as far as can be tested, and no leak was found (parts 4-6, 22).
- a2 Everything reproduces exactly: 11,262/11,262, 174/174, 510/510 (parts 2, 31).
- a3 The pure number is isolated from the market (part 11).
- a4 Signs, odds, settlement and CLV arithmetic are correct (parts 13-15).
- a5 V2 is more accurate than the V1 champion on the 2024-25 data: -0.276 [-0.466, -0.070], on inspected data
  (part 9).
- a6 Win probability is calibrated (ECE 0.020), and average coverage is nominal (parts 17, 28).
- a7 The canonical service fails closed, and no wrong V2 number or false BET came from producer data (part 33).
- a8 Betting is disabled, and the governed policy cannot reach BET (part 40).
- a9 Every defect found in phases 1-2 was fixed and versioned with no change in accuracy (part 23).
NOT C (technical failure): no path produced a wrong number from the canonical service. F-30 and F-31 are
consumer-side guards on the decision field, and neither is reachable by the producer.
NOT D (validation failure): nothing that failed validation is shipped as validated. Every failed component is
disabled, relabelled or research-only (parts 17-19, 26-27, 37).
NOT APPROVED FOR PRODUCTION (A) because:
- n1 No prospective V2 prediction has settled. There are 0 frozen files, and the first freeze is 2026-09-29
  (part 36).
- n2 Every historical window was used in development, and the holdout was read at least 13 times (part 8).
- n3 V2 is less accurate than the opener and the close in every window (+0.28 / +0.36 on the holdout; +1.13 in 2026)
  and has no edge at the close (49.97% ATS) (parts 10, 21).
- n4 Its gain over a simple 8-feature ridge is not significant: -0.057 [-0.136, +0.023] (parts 9, 24).
- n5 Sigma, reliability and cover probability are decorative, and the snapshot ignores QB identity (parts 18, 26).
- n6 No Model Championship was run, and the governance champion is V1 (part 34).
- n7 The service runs degraded on 55 of 60 games (part 41), and F-30 and F-31 are open (part 40).
NOT APPROVED FOR BETTING because:
- the calibrated EV is -0.0317 at every price;
- execution cannot be tested (one book, 37 priced quotes, closes observed after kickoff);
- line-shopping value is inflated (parts 15, 16, 40).
REQUIRED FOR A (do not weaken):
- >= 700 settled, prospectively frozen FBS-vs-FBS V2 games, with the V2-V1 MAE CI below 0 and calibration and
  coverage in band;
- F-30 and F-31 fixed;
- one governed switch off v2.1.0, to v2.1.2.
REQUIRED FOR ANY BETTING: >= 200 settled, priced, multi-book shadow decisions with a calibrated EV above 0.
```
