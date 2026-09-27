# EdgeDesk CFB hostile audit: phase 1 findings (the frozen core model)

- **Auditor:** an independent agent instructed to try to prove EdgeDesk is *not* good.
- **Scope:** `edgedesk_cfb_v2.1.0`:
  - the artifact, `params.js` and `engine.js`;
  - the research pipeline `football/cfb_v2/research/v2/`;
  - the weekly engine;
  - the Model Lab.
- **Snapshot:** [SNAPSHOT.json](SNAPSHOT.json) (`EDGEDESK_CFB_FINAL_AUDIT_CANDIDATE`, taken at commit `e22ff36d`, `champion_selection: NOT_RUN`).
- **Evidence:** every number comes from the audit modules in `football/cfb_v2/research/v2/audit/`. Each re-runs with `python3 -m v2.audit.<name>`, or `node` for `.js`. Outputs are in `football/cfb_v2/research/out_h/audit/` (git-ignored).
- **Phase 2** covers personnel, matchup, market intelligence, the decision policy and infrastructure, plus the final A/B/C/D classification.
- **Authorship:** the sub-agent's environment refused report files, so the orchestrator wrote this file from its report.

## Verdict (phase 1)

**The model is soundly built but does not beat the market.**
- **Soundly built:**
  - it rebuilds bit-for-bit from raw data;
  - no data leak was found;
  - it beats V1 and simple Elo;
  - its win probabilities are calibrated.
- **Does not beat the market:**
  - it is worse than both the opening and the closing line;
  - it shows no betting edge;
  - its cover probability has no skill.
- **One genuine bug:** in-progress games are treated as final (F-01).
- **No clean out-of-sample evidence remains:** 2024–25 has been inspected repeatedly.

## Accuracy

FBS vs FBS, same games for every predictor, 95% paired-bootstrap CIs. The holdout table has n = 1,534.

| predictor | holdout 2024–25 MAE | V2 − X (holdout) | V2 − X (dev 2016–23, n 4,299) | seasons V2 better / worse |
|---|---|---|---|---|
| **V2.1** | **12.376** | — | — | — |
| V1 champion | 12.652 | −0.276 [−0.466, −0.070] | −0.440 [−0.577, −0.301] | 2/0 holdout, 6/0 dev |
| 8-feature ridge (audit-built) | 12.433 | −0.057 [−0.136, +0.023] | −0.122 | 2/0 |
| 3-feature ridge on adjusted EPA | 12.763 | −0.387 | −0.520 | 2/0 |
| Ridge C alone / GBM D alone | 12.427 / 12.398 | −0.051 / −0.022 (CIs include 0) | | |
| Median of components A–E | 12.401 | −0.025 [−0.094, +0.041] | | |
| V2's own Elo / CFBD Elo | 13.177 / 13.033 | −0.801 / −0.657 | | |
| opening line | 12.097 | **+0.279 [+0.101, +0.459]** | +0.229 | 0/2 |
| closing line | 12.013 | **+0.363 [+0.175, +0.556]** | +0.382 | 0/2 (0/6 dev) |

**Win probability (holdout, n 1,607).**
- Brier is 0.1829 [0.1746, 0.1919]. The difference to V1 is −0.0033 [−0.0070, +0.0007], which is not significant.
- Calibration: ECE 0.020, slope 1.056 [0.94, 1.20], and all 10 buckets fall inside their CIs.
- Brier is worse than the close-implied probability by +0.0035 [+0.0002, +0.0066].

**Intervals (holdout).** Coverage at 50 / 80 / 95 % is 0.508 / 0.814 / 0.951.

**Market movement toward V2 (holdout, moved lines, n 1,385).**

| predictor | line moved toward it |
|---|---|
| V2.1 | 54.7% [52.1, 57.3], mean +0.26 pts [0.16, 0.37] |
| V1 | 53.4% |
| audit ridges | 50.6–51.9% |
| placebo | 50.0% |

**Betting the V2 side of every holdout game.**

| priced at | ATS | ROI at −110 | test |
|---|---|---|---|
| opener | 51.0% [48.5, 53.4] | −2.6% [−7.1, +2.0] | p = 0.87 vs break-even; within-week permutation p = 0.14 |
| close | 49.97% (n 1,573) | | |

**Cover probability (holdout).** Log loss 0.6932, against 0.6931 for a coin flip.

## Findings, by severity

### HIGH

**F-01 (genuine bug): in-progress and cancelled games are treated as FINAL.**
- **Cause:** `v2/games.py` sets `status = 'FINAL'` whenever both scores are present. It never reads the provider's `completed` / `status`.
- **2026:** the 2026 schedule file (fetched 07:21 UTC, about 7 h stale) holds 13 FBS games with partial scores that the provider marks `STATUS_IN_PROGRESS` / `completed = False`.
  - V2 marks them FINAL. Examples:
    - Alabama–South Carolina recorded 21–3 (actual 49–18);
    - UL Monroe–FAU 0–0 (actual 17–45);
    - North Texas–Houston Christian 14–14 (actual 63–14).
  - Five more in-progress games are labelled `NOT_PLAYED`.
- **2024:** the cancelled App State–Liberty game (hurricane, 0–0 in the provider file) is a 0–0 FINAL. It is inside the holdout and inside the production artifact's training window (`trained_through: 2025`).
- **Earlier seasons are not affected.** 2014–2023 hold 169 scored-but-not-completed rows, all 0–0 cancellations or postponements. None reaches stage 2: their division fields are empty, so the FBS filter drops them. This was checked by the orchestrator.
- **Damage to the published live-2026 replay:** 11 of 208 games are graded against partial scores.
  - V2 MAE goes from 11.607 to **12.118** against the true finals.
  - The opener goes from 10.844 to 11.161, and the close from 10.649 to 10.983.
  - V2 − close goes from +0.958 to **+1.135**.
- **Production exposure:** the weekly engine's `VERIFY_COMPLETED_GAMES` only warns, and `build_ratings` reads the naive stage-2 table.
- **Reproduce:** `python3 -m v2.audit.immutability`.
- **Status:** being fixed as patch version `edgedesk_cfb_v2.1.1`. See [PATCH_v2.1.1.md](PATCH_v2.1.1.md) once written.

**F-04: 2024–25 is not a holdout.** The core scored it at least five times:
1. the first v2.0.0 run, which had an intercept bug; the fix in `models.py:147-150` was made after seeing that holdout result;
2. the final v2.0.0 run;
3. the candidate-001 reproduction;
4. the red-team phases (thresholds, bankroll, champion–challenger);
5. V2.1 itself.

Downstream layers read the same window: the personnel QB layer, and policy v1 on already-inspected predictions. Gates G1–G7 rest entirely on it.
- It should be labelled *inspected development data*.
- No untouched historical season remains.

**F-03: no prospective V2 prediction exists yet.**
- `snapshots/2026/` holds only the replay.
- V2.0.0 and V2.1.0 were built after 2026 weeks 0–4 had been played, and the red team examined 2026 results before freezing.
- The first clean test is the Tuesday 2026-09-29 12:00 UTC freeze.

### MEDIUM

**F-11: market-data orientation errors in V1's `build_market.py`, which V2's evaluation reuses.**
- **Swapped team ids:** in 12 games (2020–24) the archive's home/away ids are swapped relative to the schedule. Examples: Army–Navy 2021, with an opener of −8.5 against a close of +7; UTSA–Coastal 2024.
- **Opposite-sign book lines:** 158 games have one book's line with the opposite sign to the others (for example `intertops` and Sports Interaction in 2014, ESPN Bet openers in 2023–25). The per-game median keeps them.
- **Effect on evaluation:** these games flatter V2.
  - Holdout V2 − opener goes from +0.263 to **+0.294** once they are removed.
  - CLV goes from 0.363 to 0.350.
  - The 22 flagged holdout games have a CLV of 1.30.
- The existing flip/jump flags are never applied to evaluation.

**F-05: the complexity earns very little.**
- An 8-feature ridge is within 0.057 [−0.136, +0.023] on the holdout, which is not significant.
- Ridge C alone and GBM D alone are each within 0.05 of the ensemble.
- The practical gain is 0.46% of MAE.

**F-06: V2.1 is worse than the market** in every window and on every metric.

**F-12: sigma and the reliability score carry no information.**
- Sigma vs |error|: Spearman −0.007 on dev (n 5,194) and 0.002 on the holdout. RMSE is flat across sigma quintiles.
- Reliability vs |error|: Spearman −0.010 (p 0.68).
- The 90+ reliability bucket's 80% interval covers only 0.743 on the holdout (n 303).
- Brief item 39 says to remove or redesign such a score before the freeze.

**F-08: play-by-play is incomplete for 3–6% of games since 2021.**
- The play-by-play final score disagrees with the schedule in 53 / 39 / 29 / 29 / 35 games (2021–25).
- 250 FINAL games have no play-by-play at all.
- Nothing in stages 1–3 checks completeness.

**F-09 / F-13: point-in-time correctness of provider data is untestable.**
- No provider file hash exists from before 2026-09-27; the clone is shallow and nothing is pinned.
- The provider's EP model was fitted on 2004–2025.
- `retprod.def_returning` is missing for 100% of teams in 2009–16 and for 0% in 2026.
- Coaching fields were verified to be preseason. Two schedule sources agree on 2014–25 scores.

**F-14: every Model Lab close is a single book, provider-declared.**
- All 231 closes are DraftKings via ESPN; the 180-minute consensus rule never fired.
- The quotes were observed 3–289 h after kickoff, and only 37 spread quotes carry a price.
- So Lab CLV cannot be verified as pre-kickoff, and it rests on one book.

**F-02 (attribution bug): replay results are published under the wrong version.**
- `learn_week.py` publishes v2.0.0 replay rows (built from `out/`) under `model_version = v2.1.0`.
- The committed `learning/2026_summary.json` MAE of 11.6120 is v2.0.0's; V2.1 scores 11.6070 on the same games.
- Rows carry no per-row version.

**F-15: the leakage guard checks column names, not content.**
- An outcome disguised under an allowed feature name passes and drops MAE from 12.55 to 7.54.
- The audit's outcome scan catches it (correlation 0.73 with the result against the close).
- Recommendation: make that scan a standing test.

**F-16: intervals under-cover in some groups.**

| group | coverage |
|---|---|
| weeks 0–2 | 80%: 0.791 [0.763, 0.816] |
| week-1 unknown QB | 80%: 0.774 [0.735, 0.808] |
| postseason | 50%: 0.454 [0.403, 0.506] |
| FBS vs FCS 2026 | 80%: 0.733 [0.646, 0.805] (these games are not priced) |

**F-17: subgroup biases (documented only).**

| subgroup | V2 error (points) | the close |
|---|---|---|
| P4 home vs G5 | under-projected by 2.83 [1.73, 3.94] | |
| favourites of 28+ | under-projected by 4.04 [2.49, 5.59] | off by 0.44 |
| first career QB start | 1.85 worse (dev) / 3.29 worse (holdout) | −0.33 / −2.05 |

- The live QB overlay caps near −1.0.
- At team level, 1 of 134 teams is significant after Bonferroni correction.

### LOW

- **F-07:** gate G3 (Brier vs V1) passes on a point estimate whose CI includes 0.
- **F-10:** the stale `research/out/` (the v2.0.0 build) is still the default in `config.OUT` and `run_all.sh`. `out/personnel/*`, a weekly-engine lock file and the replay were produced from it.
- **F-18:** the shipped push probability at 7 (0.058) sits at or below the empirical 95% interval at the close (0.066–0.131). At 3 it is inside.
- **F-19:** the Lab's "moved toward model" counts unmoved lines as "not toward". This is conservative, but defined differently from the backtest.
- **Dev tuning:** Elo, prior scales, ridge alpha, GBM settings, feature families and dropped features were all tuned on dev, so dev results are in-sample for the configuration.

## What survived

- **Rebuild:** stages 1–5 rebuilt in isolation for 2016, 2024 and 2026 match `out_h` bit-for-bit. A stage-7 refit reproduces all 11,262 stored predictions.
- **Point in time:**
  - All 63,851 rating rows count exactly the games before their freeze.
  - An independent week-5 re-solve matches to ≤ 1e-8, and a deliberately leaky whole-season solve differs by 0.10–0.28 SD, so the check has power.
  - QB expected starters are point-in-time in 55,499 of 55,499 rows.
  - An independent Elo reproduces stage 4 exactly.
- **No leak detected:**
  - no input's r² with the margin exceeds the close's (0.446);
  - no input correlates with the result against the close beyond |0.053|;
  - a walk-forward GBM on that residual has out-of-sample R² −0.033;
  - shuffled labels collapse to baseline;
  - placebo features rank 34–36 of 46;
  - end-of-season ratings drop MAE to 10.40, so the leak tests have power.
- **Pure model isolated from the market:**
  - 46,920 `engine.decide()` calls with extreme markets never changed `pure()`;
  - 14 injected market columns leave the Python scorer unchanged;
  - the production scorer equals research stage 7 within 7e-15;
  - `engine.js` win probability matches Python within 5e-5.
- **Signs, mapping, arithmetic:**
  - Five hand-computed games agree across longhand, the stored values and the engine.
  - The numeric-id joins have no collisions.
  - `identity.js` resolves all 66 collision probes.
  - 28 textbook odds, vig, EV and push checks pass.
- **Model Lab:**
  - All 510 evaluations recompute exactly.
  - The V1 public record re-grades exactly: 231 games, 104-125-2 (45.4%).
  - The Lab's public record claims nothing (0 official predictions).
  - The ledger has append-only triggers and revokes.

## What did not survive

- Any claim of beating the market.
- Any betting edge.
- Cover-probability skill.
- Reliability and sigma as difficulty signals.
- A complexity premium over a simple ridge.
- 2024–25 as a holdout.
- The 2026 replay as live evidence.
- The published live-2026 numbers (F-01, F-02).
