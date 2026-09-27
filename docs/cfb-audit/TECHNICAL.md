# EdgeDesk CFB hostile audit: technical audit (item 126)

> **Status after this audit.**
> - **F-30 and F-31 are fixed** in the same pull request (PR #391):
>   - `football/cfb_production/projections.js` `officialFor()` publishes no official decision at fallback level 3. It refuses a BET that breaks the governed policy (betting off, or no side/line/price): the result is NO_DECISION with the alarm.
>   - `supabase/functions/edgedesk_ai/_cfb_explain.js` `cfbFacts()` lets a BET through only when the decision says betting is on.
>   - Tests: `canonical.test.js` 124, `explain_guard.test.js` 52.
> - **The item-81 wording is corrected:** the V2 panel now says the 2024–25 data informed development and is inspected, not an untouched holdout.
> - **Unchanged:** the classification (B); the other findings keep the status given below.
> - The text is the auditor's own, kept as plain text.

```text
EDGEDESK CFB - TECHNICAL AUDIT (item 126): every test, metric, issue and reproduction result
============================================================================================

Scope and conventions
- Core model audited on the frozen snapshot EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE (docs/cfb-audit/SNAPSHOT.json:
  commit e22ff36d; artifact edgedesk_cfb_v2.1.0, MANIFEST 356bd0f9...; params.js and engine.js hashed; 209 raw data
  files hashed; champion_selection NOT_RUN). Pipeline audited on b6eae62e9 (PR #391).
- Build directories: out_h (v2.1.0), out_p (v2.1.1), out_p2 (v2.1.2). Stage-7 out-of-fold predictions:
  out_h/stage7/backtest_predictions.parquet (11,262 games).
- Scope for accuracy: FBS vs FBS FINAL games. Windows: dev 2016-2023 (tuned on), "holdout" 2024-2025 (inspected at
  least 13 times: F-04/F-29), 2026 replay (inspected; not prospective).
- Uncertainty: 95% game-level paired bootstrap (2,000 resamples, audit seed 20260928) unless stated; cluster
  (season-week) bootstrap reported beside it; Wilson intervals for rates.
- Reproduction: football/cfb_v2/research/v2/audit/*.py (python3 -m v2.audit.<name>, CFB_V2_OUT=out_h),
  purity.js and oddsmath.js (node), phase 3 scratch scripts attack.js, failclosed.js, betattack.js. Outputs in
  $CFB_V2_OUT/audit/*.json|csv|parquet (git-ignored).

-------------------------------------------------------------------------------------------------
1. SNAPSHOT (item 1)                                                     v2.audit.snapshot
-------------------------------------------------------------------------------------------------
Recorded: git commit, branch, shallow clone (first commit 2026-09-26), 22 uncommitted paths; model/feature versions;
artifact MANIFEST check (3/3 files match); params.js/engine.js/candidate-001 manifest hashes; every cfb_*.sql DDL
hash (no schema_version column exists); the 51-input feature schema hash; stage-5/7 training table hashes and 209
raw data file hashes (all identical to candidate 001's manifest); calibration (win raw, cover Platt [-0.0105,
0.1870], push table); uncertainty (t df 100, |z| quantiles 0.662/1.284/1.946, sigma coefficients); ensemble (C/D
0.5/0.5); market engine and decision policy (rule review 14 / gap 3 / EV 0.06 / exclude early, bet disabled);
thresholds; source configuration (fetch_v2.sh pins no hash); environment (Python 3.11.15, LightGBM 4.7.0, numpy
2.4.6, pandas 3.0.6, scipy 1.17.1, sklearn 1.9.1). Governance: champion_selection NOT_RUN; champion V1; V2.1
ELIGIBLE_FOR_PROMOTION. The stale build research/out (v2.0.0, cfb_v2_fv1) was identified (F-10).

-------------------------------------------------------------------------------------------------
2. REPRODUCTION FROM RAW DATA (item 3)                                   v2.audit.reproduce
-------------------------------------------------------------------------------------------------
- Stages 1-5 rebuilt for 2016, 2024 and 2026 in an isolated directory (out_h/audit/repro) with the production stage
  code (build 191 s): team-game, QB-game, games, market, varcomp, final data-only ratings, priors, ratings, league,
  QB state, Elo and the snapshot tables are identical to out_h; the only differences are null representation in
  text columns (notes, venue, conference/division), verified value-identical after null normalisation.
- Stage 7 refit from the stored snapshots: 11,262 of 11,262 predictions (ens_pred, sigma, p_home_raw, C, D) match
  exactly (max |diff| 0.0). Refit of 2016/2024/2026 from the rebuilt rows: exact.
- Production scorer (predict_live with the v2.1.0 artifact) vs research stage 7 on 2026: max |diff| 7e-15
  (margin), 1e-14 (sigma), 2e-16 (p). engine.js win probability vs Python t-CDF: max |diff| 4.9e-5.
- H3: reproduce.js 174/174 stored Lab snapshots (V1 60, V2.1 57, V2.0 57) and 510/510 settlements re-derived.

-------------------------------------------------------------------------------------------------
3. DATA IMMUTABILITY (item 4)                                            v2.audit.immutability
-------------------------------------------------------------------------------------------------
- 225 recorded hashes (candidate 001 manifest, weekly expected-margin artifact) match the local files; the
  earliest recorded hash is 2026-09-27 07:38 UTC; all data files were fetched 07:21 UTC that day. Nothing older
  exists (shallow clone), so point-in-time immutability of 2009-2025 provider data is NOT testable.
- Cross-source: sportsdataverse schedules vs V1's cfbfastR copy, 2014-2025: 0 score, id, date or neutral-site
  mismatches.
- Play-by-play last score vs schedule final (F-08): mismatches 17/18/17/11/7/3/6/9/7/10/7/9 (2009-2020), then
  53 (2021), 39, 29, 29, 35 (2025); 250 FINAL games have no PBP (FBS-FBS: 28 in 2021, 29 in 2022).
- Lab 2026 results vs the 2026 schedule file: 13 score mismatches -> F-01 (partial in-progress scores).
- Definition drift (F-09): retprod def_returning missing 100% 2009-16, 35-80% 2017-24, 3% 2025, 0% 2026; talent
  n_recruits median 68-86 (2009-13) vs 19-42 (2014+). Coaching fields verified preseason (Arkansas 2019, USC 2021,
  Nebraska 2022 keep the fired coach).
- The provider EP model was fitted on 2004-2025 (definition-level look-ahead; disclosed, not removable).

-------------------------------------------------------------------------------------------------
4. LEAKAGE (items 5-10)                                                  v2.audit.leakage, v2.audit.placebo
-------------------------------------------------------------------------------------------------
A Information set: 63,851 (season, freeze, team) epa rating rows: n_obs equals the team's FINAL games before the
  freeze in every row (0 offence and 0 defence mismatches).
B Independent dense re-solve of week-5 ratings (2016, 2019, 2022, 2024, 2025; epa, epa_pass, sr, ppd) from weeks
  0-4: max |diff| <= 1e-8 vs stored; the whole-season solve (the leak) differs by 0.10-0.28 rating SDs on average.
C Stage-5 timestamps: feature_ts == prediction_ts < kickoff for all 12,950 rows (lead 5-161 h); 0 duplicate rows.
D QB: expected starter = starter of the latest game before the freeze in 55,499/55,499 rows (23 rows flagged
  QB-missing although the team had played - teams without passer rows; conservative).
E Elo: an independent implementation reproduces stage 4 exactly (15,378 games).
F Outcome scan: max single-input r^2 with the margin 0.402 vs the close's 0.446; max |corr(input, margin - close)|
  0.052 (edge_stuff, z 4.8 - modest); a walk-forward GBM on all inputs predicting margin - close has
  out-of-sample R^2 -0.033 (n 7,263).
G No market or evaluation column in the pure table or the artifact; 0 unknown-layer columns.
Preprocessing (item 6): every scaler, imputer, calibrator, conformal quantile, reliability range and prior model
  is fit on seasons < S; metric scales from S-3..S-1; talent standardised within the (preseason) season. Hyper-
  parameters (Elo grid, rating prior scales, ridge alpha, GBM, families, dropped features) were tuned on dev, so
  dev results are in-sample for the configuration.
Placebo (item 47): five noise columns rank 34-36/46 in the ridge and 19-20/47 in GBM, total gain share 0.6%;
  ensemble MAE changes <= +0.005.
Label shuffle (item 48): MAE 15.55 / 15.65 (2024/2025) vs a train-mean predictor 15.69 / 15.89 (real 12.55/12.10).
Future injection (item 49): named close_margin and unknown names are rejected by the name contract; the outcome
  disguised as an allowed feature passed the name contract (MAE 12.55 -> 7.54) -> F-15; the outcome scan catches
  it (corr with margin - close 0.73), and since v2.1.1 the scan is a standing test (all 51 inputs pass; the
  disguised table fails).
Time reversal (item 50): training on future seasons changes MAE by <= 0.004; end-of-season ratings as features
  (the leak) drop MAE to 10.40 / 10.17 - the tests have power.
Market leakage (item 9): the opener is used at the Tuesday freeze, the close only for evaluation; the decision
  dataset's arm masks never read the close (market-intel test); WAIT is disabled; CLV models are fit walk-forward
  on DEV (decision calibration).

-------------------------------------------------------------------------------------------------
5. GRAIN, SURVIVORSHIP, SELECTION (items 11-13)                          v2.audit.samples
-------------------------------------------------------------------------------------------------
- One row per game in every training/scoring table (0 duplicate keys); training is unweighted per game; books are
  aggregated by median before V2 sees them; the raw line archive has exact duplicate rows handled in build_market.
- 72 same-pair-same-season games are legitimate rematches (conference championships).
- Dev: 929 FBS-FBS finals excluded from the published common set (no opener 922, no V1 271, no close 297); V2 MAE
  on them 13.24 vs 12.72 included (harder games excluded). Holdout: 3 excluded. FCS games MAE 14.75 / 13.93 /
  17.35 (dev/holdout/2026) - not priced. Games without an opener (excluding 2020): 540, V2 MAE 13.07 vs 12.60, 52%
  with a G5 home team. 2020 has no openers. Historical ROI assumes -110 (no prices after 2019).

-------------------------------------------------------------------------------------------------
6. RESEARCHER DEGREES OF FREEDOM AND HOLDOUT CONTAMINATION (items 14-16)
-------------------------------------------------------------------------------------------------
Counted configurations: rating prior scale 6 x 8 metrics + 4 half-lives + 4 tie-break runs; Elo 36; ridge alpha 5;
GBM 8; family ablation 10 x 2 models + 18 red-team groups + 5 prior rebuilds; ensembles 5 drop-one, 12 subsets,
6 methods; calibration 4 win + 4 cover methods (twice); betting rules 297 + 341 + 522 (~1,160); 9 full variant
rebuilds; decision tournament 9 candidates; personnel, matchup (18 families) and market-intel arms on top. Order:
~250 model configurations and ~1,200 threshold rules.
Holdout reads (2024-2025): the core model >= 5 (v2.0.0 with an intercept bug fixed after seeing it; candidate 001;
red-team phases 9-19; v2.1.0); v2.1.1 and v2.1.2 patch comparisons; decision policy v1 (read 16:30 + a documented
re-evaluation); personnel QB (first run in out/, relocated) and units; matchup; market intelligence -> at least
13. No untouched historical season exists (2009-11 burn-in, 2012-15 training, 2016-23 tuned, 2024-25 inspected,
2026 weeks 0-4 inspected). The first clean test is the 2026-09-29 freeze onward.

-------------------------------------------------------------------------------------------------
7. BASELINES, MARKET, PAIRED BOOTSTRAP (items 17-18, 51-53)              v2.audit.baselines
-------------------------------------------------------------------------------------------------
Holdout, n 1,534 common games (V2 - X; negative = V2 better; cluster CI in parentheses):
  V1 12.652            -0.276 [-0.466, -0.070] (-0.459, -0.088); RMSE -0.298; Brier -0.0033 [-0.0070, +0.0007]
  ridge 8 features     12.433  -0.057 [-0.136, +0.023]; Brier +0.0003
  ridge 3 features     12.763  -0.387 [-0.573, -0.202]
  C ridge / D GBM      12.427 / 12.398  -0.051 [-0.108, +0.004] / -0.022 [-0.077, +0.033]
  median A-E           12.401  -0.025 [-0.094, +0.041]
  V2 Elo / CFBD Elo    13.177 / 13.033  -0.801 / -0.657
  home field           15.944  -3.568
  opener               12.097  +0.279 [+0.101, +0.459]; Brier +0.0039 [+0.0008, +0.0070]
  close                12.013  +0.363 [+0.175, +0.556]; Brier +0.0035 [+0.0002, +0.0066]
  V2.1 MAE 12.376, RMSE 15.694, bias -0.518.
Dev (n 4,299; in-sample for tuning): V1 -0.440; ridge 8 -0.122; opener +0.229; close +0.382. Seasons V2 better /
  worse: vs V1 6/0 dev, 2/0 holdout; vs opener 1/5, 0/2; vs close 0/6, 0/2.
2026 replay (n 208; true finals after F-01): V2 12.118, opener 11.161, close 10.983; V2 - close +1.135.
Practical significance: the gain over the best simple baseline is 0.46% of MAE and not significant.
Patch deltas (true finals, holdout n 1,606): v2.1.0 12.3269, v2.1.1 12.3297 (+0.0028 [-0.003, +0.009]), v2.1.2
  12.3277 (-0.0020 [-0.007, +0.003] vs v2.1.1).

-------------------------------------------------------------------------------------------------
8. PURE-MODEL ISOLATION AND CONSISTENCY (items 19, 79-80)                purity.js, v2.audit.purity
-------------------------------------------------------------------------------------------------
engine.js: 391 rows x 3 overlay sets x 40 wild markets = 46,920 decide() calls; pure() unchanged every time; smuggled
market fields ignored; decide() never mutates its input. Python: 14 injected market columns change nothing.
Version attribution (item 79): the learning summary labelled v2.0.0 replay MAE (11.6120) as v2.1.0 -> F-02 (fixed
in v2.1.1 pipeline: per-row model_version and build provenance). H3: canonical.checkRow refuses a row declaring
another version; a row with no version is labelled with the engine's version (F-32 note).

-------------------------------------------------------------------------------------------------
9. FEATURES (items 24-25)                                                v2.audit.features
-------------------------------------------------------------------------------------------------
17 input pairs with |r| >= 0.95 and 40 >= 0.90 (season vs recent edges 0.99; prior edges 0.96-0.99;
edge_expl_pass vs edge_prior_sr 0.97 - explained by F-21); C design condition number 214, first eigenvector 52%.
Robust-z > 8 values: rest_diff (spiky distribution, not errors), qb_delta_edge (0.51, a QB change), strength x
weakness products (expected tails), altitude (Wyoming). Stage-3 EPA ratings beyond 4 robust SDs: 58 of 112,046
rows. No data errors traced beyond F-01/F-08/F-11.

-------------------------------------------------------------------------------------------------
10. MAPPING, SIGNS, ODDS, PUSH, KEY NUMBERS, CLV (items 26-31)           v2.audit.mapping, oddsmath.js, samples
-------------------------------------------------------------------------------------------------
- V2 joins on numeric ids; no name maps to two ids or id to two names; the Lab identity master resolves 66
  collision probes (Miami/Miami (OH), USC/South Carolina, UTSA/Texas, ...) and refuses id/name conflicts.
- Line archive orientation (F-11): 12 games with home/away ids swapped vs the schedule; 158 games with a book's
  line of opposite sign; holdout V2 - opener +0.263 -> +0.294 without them, CLV 0.363 -> 0.350; fixed in v2.1.1
  (orientation by team id, sign rule; 54 fields in 41 games changed).
- Five hand-computed games (home favourite, road favourite, neutral site, integer push, the model on the dog):
  margin, book conversion, display, cover result and CLV agree longhand = stored = engine.
- Odds math: 28/28 textbook checks across engine.js, decision.js and lab_core.js (break-even, devig, EV with push
  mass, minimum price rounding, pushes = 0 units, CLV orientation).
- Push/key numbers (FBS-FBS at the close, 2016-25): P(push | 3) 7.2% [5.1, 10.1], | 7 9.3% [6.6, 13.1], | 10 6.2%,
  | 14 4.3%; overtime games end by 3/7/8 68% of the time; the shipped push table (3: 9.3%, 7: 5.8%) is fitted on
  integer openers - its 7 value sits below the close-based interval (LOW).
- CLV (item 31): 510 Lab evaluations recomputed independently - 0 mismatches over 10 fields; the Lab's "moved
  toward" counts no-move games as "not toward" (conservative).

-------------------------------------------------------------------------------------------------
11. CLOSING LINE, EXECUTION, SHOPPING, LATENCY (items 32-35)             lab_record, phase2
-------------------------------------------------------------------------------------------------
- Historical archive closes carry no timestamps: live/post-kickoff contamination cannot be excluded.
- Lab closes: all 231 are provider-declared single-book (DraftKings via ESPN) fallbacks, observed 3-289 h after
  kickoff by backfill; the 180-minute consensus rule has never fired. Only 37 spread quotes carry a price.
- Execution: historical simulation fills at the archive opener at the Tuesday freeze at -110; openers have no
  timestamp; the pessimistic grading at the close is the honest bound (holdout ATS 49.97%).
- Line shopping (F-25; dev 2016-19, V2 side vs consensus close, n 2,736): consensus ATS 48.6%, ROI -7.0%
  [-10.5, -3.4]; best of ~20 books 51.4%, -1.9% [-5.6, +1.7]; best within 1.5 pts of consensus -3.6%; within 0.5
  -4.2%; Pinnacle alone -7.0%. 19.2% of "best" lines are >= 1.5 pts off consensus.
- Latency: not measurable (no timestamped historical path).

-------------------------------------------------------------------------------------------------
12. CALIBRATION, RELIABILITY, INTERVALS (items 36-39, 58, 71)            v2.audit.accuracy
-------------------------------------------------------------------------------------------------
Win probability (holdout n 1,607): Brier 0.1829 [0.1746, 0.1919]; log loss 0.538; ECE 0.020 [0.019, 0.050];
  slope 1.056 [0.937, 1.198]; intercept 0.035 [-0.094, 0.140]; all 10 buckets' mean prediction inside the Wilson
  CI of the observed rate (e.g. 0.9-1.0: 0.952 vs 0.977 [0.942, 0.991], n 173).
Cover probability: log loss 0.6926 dev / 0.6932 holdout / 0.6899 2026 vs coin 0.6931; slope CI [-0.72, 2.01]
  (holdout); calibrated side probability never >= 0.60 on the holdout; raw >= 0.70 in 52 games (won 63%).
Reliability (item 39): Spearman(reliability, |error|) +0.009 dev, -0.010 holdout (p 0.68); holdout 90+ bucket
  80% coverage 0.743 (n 303); sigma quintiles have flat RMSE (15.8-16.2 dev) - decorative (F-12).
Intervals: holdout 0.508 / 0.814 / 0.951; dev 0.501 / 0.811 / 0.955; 2026 0.543 / 0.846 / 0.952. Weeks 0-2 80%
  0.791 [0.763, 0.816]; week-1 QB unknown 0.774 [0.735, 0.808]; postseason 50% 0.454 [0.403, 0.506]; FBS-FCS
  2026 80% 0.733 [0.646, 0.805].
Early season (item 58): calibration slope of the margin on the prediction, dev weeks 0-2 1.206 [1.115, 1.297]
  (the close 1.039) - predictions too compressed early; weeks 5-9 0.918 [0.858, 0.977]; postseason 0.72.

-------------------------------------------------------------------------------------------------
13. MARKET MOVEMENT, LUCK, RANDOMISATION (items 43-46)                   v2.audit.market_move
-------------------------------------------------------------------------------------------------
Share of moved lines that moved toward the predictor (holdout, n moved 1,385), gap >= 0/1/2/3/4:
  V2.1 0.547 [0.521, 0.573] / 0.550 / 0.559 / 0.569 / 0.548; mean move +0.26 / +0.32 / +0.43 / +0.50 / +0.56 pts
  V1 0.534 / 0.540 / 0.539 / 0.547 / 0.548; ridge 3 0.519-0.541; ridge 8 0.503-0.517; random placebo 0.500-0.525.
  Dev (in-sample): V2 0.608-0.687. 2026: V2 0.582-0.626 (n 91-194).
CLV x outcome (holdout, every game at the opener): +CLV win 417 / loss 345; -CLV win 278 / loss 326 (win rate 54.7%
  vs 46.0%).
Luck: ATS at the opener 51.0% [48.5, 53.4], p = 0.87 vs break-even; ROI -2.6% [-7.1, +2.0]; at the close 49.97%.
Permutation within season-week (2,000): holdout ATS p = 0.14; CLV p < 0.001 (real 0.36 vs null 0.09 [-0.01, 0.18]);
  dev ATS p = 0.001 (in-sample).

-------------------------------------------------------------------------------------------------
14. SUBGROUPS, TAILS, BEST/WORST (items 54-61, 72-74)                    v2.audit.accuracy
-------------------------------------------------------------------------------------------------
Residual r = margin - V2 (+ = home beat the projection). Dev + holdout:
  P4 home vs G5 +2.83 [1.73, 3.94] (holdout +3.38); G5 home vs P4 -1.69; neutral -0.87; postseason -0.84;
  favourite side by close size: 28+ +4.04 [2.49, 5.59] (close +0.44); 14-21 +1.18; 7-14 +1.00.
  Conferences (team-oriented): MAC -1.11 (t -2.6), C-USA -0.91, Big 12 +0.84, Big Ten +0.71 (multiple testing).
  Teams: 0 of 133 Bonferroni-significant (dev+holdout); 1 of 134 on the holdout (Indiana 2024-25, n 27).
  QB state (team-oriented): first career start -1.85 [-3.15, -0.55] dev, -3.29 [-5.75, -0.83] holdout (close
  -0.33 / -2.05); new this season +0.12 / -3.13; returning -0.50 / -0.05.
Tails: 20+ misses 1,639 (21.1%) vs 22.0% expected under Normal(sigma); 30+ 481 (6.2%) vs 6.6%. Classes (20+):
  ordinary variance 1,168, QB different from expected 377, incomplete PBP 66, model issue (close >= 10 closer) 27,
  a completed=False game 1. The close also missed by 20+ in 1,271 of 1,567.
Worst 50 (worst50.csv): mean |error| 51.1 vs the close's 47.7; 34 ordinary variance, 10 QB, 3 data, 3 model.
Best 50 (best50.csv): 30% were 14+ favourites (base 32%) - not just easy favourites; mean close error 2.7.

-------------------------------------------------------------------------------------------------
15. LAYERS (items 20-23, 40-42, 62-70, 75-78)                            v2.audit.phase2
-------------------------------------------------------------------------------------------------
20 QB: replacing the expected starter with a first-timer moves the snapshot by -0.013 mean (p10 -0.21, p90 +0.20;
   range -0.51..+0.64) - F-24; the live overlay (-0.99 for OUT) is dormant and not keyed to a player.
21 Matchup: artifact NO_ADJUSTMENT; shadow ridge dev -0.0045 [-0.022, +0.013]; shadow corrections capped at +/-3
   (raw up to 10.45), mean |adj| 0.50.
22 Market signals: |gap|, theoretical EV and pure cover probability Spearman 0.998-1.0 (one signal); dispersion
   independent (~0.06).
23 Priors: talent vs lag-1 net rating 0.72, vs lag-2 0.72, lag-1 vs lag-2 0.70; returning production 0.06; new
   head coach -0.14; no inflated early certainty (item 58 slope 1.21).
40 Edge-quality tiers: dev CLV 0.11 / 0.22 / 0.84, close-implied EV -0.039 / -0.033 / -0.001; holdout ROI -2.4% /
   -6.0% / +2.3% (not monotone) - F-23 (renamed "closing-line tendency" in H3).
41 Two decision engines (F-22; resolved in H3: one official status from the governed policy, stage-8 labelled
   research).
42 Stage-8 statuses dev: LEAN n 1,641 ATS 52.7% open / 50.7% close, CLV 0.60; PASS n 2,000 52.1% / 51.8%, CLV 0.11.
62-63 Personnel: live absence deltas <= 0.71 pts; OL variance inflation <= 5.5 pt^2; research only.
64-65 Transfer QB persistence 72% [24%, 120%]; freshmen shrink to replacement (k ~ 150 dropbacks).
66-68 Similar-opponent pairs 62,243, 0 at/after the freeze; archetypes are k-means on measured style.
69 Weather: not a model input; the overlay only widens and is dormant.
70 ens_sd: Spearman with |error| -0.011 dev (p 0.39), +0.098 2026 (p 0.16); sigma coefficient -0.018 (F-26).
75 False edges (|gap| >= 7, dev + 2026, n 443; V2 side covered 54.9%): early season 66% vs 58% in correct edges;
   week-1 QB unknown 21.5% vs 15.2%; P4 vs G5 37% vs 30%; close moved toward V2 27% vs 44%.
76 Missed edges n 305 (18.6% of near-market games); QB change 27.5% vs base 24.4%.
77 Market moved further away (|gap| >= 7, n 34): V2 side covered 58.8%, close nearer the result 61.8%.
78 No news timeline can be reconstructed (V1 checkpoints reconstructed from git; quotes observed after games).
F-21: expl_pass, fg_value, st_net, to_rate (and sack_rate defence) never left their prior for FBS teams 2015-2026
   (posterior variance at the 1.5e-9 floor, build_ratings.py:256/:559); fixed in v2.1.2 (0 pinned sides; MAE
   -0.0013 dev, -0.0020 holdout).

-------------------------------------------------------------------------------------------------
16. PRODUCTION PATHWAY ATTACK (items 81-94; phase 3)                     attack.js, failclosed.js, betattack.js
-------------------------------------------------------------------------------------------------
26 attacks: 19 behaved as required, 7 did not (F-30, F-31, F-32 x3, F-33, F-35):
  refused correctly: ens_pred tampered alone; sigma 0.5; kickoff before the freeze; naive timestamp; row of
  another version; NaN; string numbers; duplicate rows for a game (falls to V1); a 60-point consistent row
  predicts with a note; projections.build idempotent; degraded rows hide the score (55/55).
  not refused: consistent tamper of margin + components; name swap with ids kept; full home/away swap; sigma 8;
  a BET row in the decision ledger (published as official BET); a V2-based official decision beside the V1
  fallback number; a 12-day-old current.json.
Fail-closed (11 artifact corruptions): 9 refuse or stop; 2 (calibration block removed, unknown method) silently use
  raw probabilities (F-34). The input contract missing -> the service refuses to start.
BET attack: decision.js with policy v1, with bet_enabled forced true, and with min_ev -1: no BET (PASS_DATA_QUALITY;
  calibrated EV -0.0317); decision.js:534 returns LEAN when betting is disabled.
Retries (runtime): deadlock 40P01 -> 5 attempts, waits 150/300/600/1200 ms, recovers on attempt 3 when transient;
  23505 and HTTP 503 not retried (F-36). Real deadlock in sql.test.js on Postgres: one victim, retried, incident.
Suites on b6eae62e9: canonical 117, final_hardening 23, replay 7, security 55, debug_ui 32, cfb_production 120,
  sql 133, ui 40, cfb_lab 275, chaos 50, cfb_decision 101, cfb_v2_panel 20, fbs_board_ui 185 assertions - all green.
Replay (replay_week.js 2026 week 3): 75 games, 455 snapshots, 0 duplicates, 0 after kickoff, 0 bets, deterministic
  ledger hash; v2.0.0 rows only.
Projections: 60 games; levels 1: 2, 2: 55, NOT_PRICED 3; modes MARKET_DEGRADED 57, NO_PLAYER_DATA 53,
  QB_UNCERTAIN 19, NO_ADVANCED_PBP 3; official decision NO_DECISION 60; build 0.6 s.

-------------------------------------------------------------------------------------------------
17. GOVERNANCE AND RECORDS (items 95-99)
-------------------------------------------------------------------------------------------------
95 research -> challenger -> shadow -> promotion: promotion.js requires an explicit version, a registered
   non-champion role, a COMPATIBLE entry, a verified artifact, schema/calibration compatibility, passing tests and
   a Model Lab promotion evaluation ELIGIBLE on >= 150 live pairs with MAE CI < 0 (F-37: too few to confirm a
   0.3-point gain). No promotion has been exercised.
96 Retraining writes edgedesk_cfb_challenger_<run>, never params.js of production; export.py refuses a manifested
   artifact.
97 Thresholds versioned in the artifact, params and policy.json (sha cb9019a2...); changes logged
   (post_freeze_changes.jsonl, Lab audit_log with RULE_CHANGED).
98 Records: append-only triggers and revokes in Postgres; git ledgers are rewritable by any commit (the database is
   the enforcement point).
99 Public records: the Model Lab public record claims nothing (0 official predictions); the V1 football record
   re-grades exactly (231 graded, 104-125-2, 45.4% ATS vs the close); denominators and pushes consistent.

-------------------------------------------------------------------------------------------------
18. ALL FINDINGS
-------------------------------------------------------------------------------------------------
HIGH   F-01 in-progress/cancelled games counted as FINAL (FIXED v2.1.1 + pipeline rule; live 2026 V2 - close
         +0.958 -> +1.135 on true finals)
HIGH   F-03 no prospective V2 prediction existed (first freeze 2026-09-29) - OPEN (time)
HIGH   F-04/F-29 2024-25 is not a holdout (>= 13 reads) - PERMANENT
MED    F-02 replay published under the wrong version (FIXED v2.1.1)
MED    F-05 complexity vs simple ridge not significant - OPEN (evidence)
MED    F-06 worse than the market everywhere - OPEN (performance)
MED    F-08 incomplete PBP 3-6% of games since 2021 - OPEN
MED    F-09 prior-input definition drift; provider point-in-time untestable - OPEN
MED    F-11 market orientation errors (FIXED v2.1.1)
MED    F-12 reliability/sigma decorative - OPEN (recommend constant week-bucket width)
MED    F-14 Lab closes single-book, provider-declared, observed after kickoff - OPEN (multi-book capture)
MED    F-15 name-only leakage guard (FIXED v2.1.1: outcome scan standing test)
MED    F-16 under-coverage early season / week 1 / postseason / FCS - OPEN
MED    F-17 P4-vs-G5, big-favourite, first-start-QB biases - OPEN (research)
MED    F-21 four ratings pinned to their prior (FIXED v2.1.2)
MED    F-22 two decision engines (FIXED H3)
MED    F-23 "edge quality" misleading (FIXED H3: "closing-line tendency")
MED    F-24 snapshot ignores QB identity; overlay dormant and unkeyed - OPEN
MED    F-25 line-shopping value inflated by off-market quotes - OPEN (label as upper bound)
MED    F-30 official decision does not re-check bet_enabled - OPEN
MED    F-31 fallback level 3 keeps a V2 decision - OPEN
LOW    F-07 G3 Brier gate on a point estimate; F-10 stale default build (FIXED: build stamps); F-18 push table at 7;
       F-19 Lab "moved toward" definition; F-26 ens_sd sign; F-27 statuses add CLV not results; F-28 editorial field
       naming/process credit; F-32 row provenance/identity; F-33 sigma row range; F-34 soft calibration
       fail-closed; F-35 stale current.json not a mode; F-36 503 not retried; F-37 promotion n 150; F-38 degraded
       operation (limitation).
```
