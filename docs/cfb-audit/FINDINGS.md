# EdgeDesk CFB hostile audit: findings (phase 1, the frozen core model; phase 2, components, evidence and approval)

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

---

# Phase 2: personnel, matchup, market intelligence, decision layer, evidence and governance

Audited on main at dbbf9ec0d or later.
- **Production** runs `edgedesk_cfb_v2.1.0`.
- **`edgedesk_cfb_v2.1.1`** is a challenger that has not been switched in. It fixes F-01, F-02, F-10, F-11 and F-15 ([PATCH_v2.1.1.md](PATCH_v2.1.1.md)), and its 2016–23 predictions are identical to v2.1.0's.
- **Governance:** no Model Championship was ever run; V1 (`edgedesk_cfb_p4_v1.0.0`) is the governance champion.

**Reproduction:** `python3 -m v2.audit.phase2` from `football/cfb_v2/research` (with `CFB_V2_OUT` pointing at a V2.1 build). Its outputs are git-ignored:
- `out_h/audit/phase2.json`;
- `false_edges.csv`;
- `missed_edges.csv`.

**Holdout discipline:** no holdout was re-scored. New evaluations use the development seasons 2016–23 and the 2026 replay, and each layer's holdout numbers are read from its own frozen evidence files.

**Status of this phase:**
- The pipeline and infrastructure items (81 main board, 82, 86–94, 109–110) are **PENDING_H3**. H3, the pipeline-correctness hardening, is still running.
- The classification below is provisional until those items are audited.

## Phase 2 verdict (provisional): **B — APPROVED FOR SHADOW MODE ONLY**

**Why not A:**
- **No clean evidence.** There is no prospective V2 prediction yet; the first freeze is 2026-09-29. Every historical window was used in development.
- **The market is better.** V2 trails both the opening and the closing line in every window.
- **Unfixed defects.** A genuine defect (F-21) and a design gap (F-24) are unfixed.
- **Two decision definitions.** Two engines coexist (F-22).
- **Unverified pieces.** The reliability and uncertainty structure is decorative, and the infrastructure is not yet audited (H3).
- **Governance.** V1 remains champion.

**Why not C:** no open technical failure in the core remains. F-01, F-02, F-10, F-11 and F-15 are fixed in v2.1.1, and the F-01 pipeline fix already protects production v2.1.0.

**Why not D:** betting is disabled, so no validation failure is being shipped. The decision layer correctly issues no BET.

**Missing evidence for A** (do not weaken these criteria):
1. At least one season (≥ 700 games) of frozen, settled 2026+ V2 predictions. V2 − V1 must have a CI below 0, with nominal calibration and coverage.
2. The F-21 and F-22 resolutions, made through governance.
3. The H3 audit: items 81–82 and 86–94.
4. For any betting: at least 200 settled, priced, multi-book shadow decisions with calibrated EV above 0 (gates G7 and G8).

## New findings, by severity

### MEDIUM

**F-21. Four stage-3 ratings never leave their preseason prior (genuine bug).**
- **What:** `expl_pass`, `fg_value`, `st_net` and `to_rate` are frozen at their prior for every FBS team, in every season 2015–2026 (three of them in 2014). This holds in both v2.1.0 and v2.1.1.
- **Evidence:** at the final freeze of 2024, all 134 FBS teams have |off − prior| ≤ 5e-9 and posterior variance at the 1.5e-9 floor.
- **Cause:**
  - `build_ratings.py:256` floors the burn-in between-team variance at 1e-8 when the between-team spread minus the estimation noise is negative.
  - `build_ratings.py:559` then sets the prior variance to max(residual variance − target noise, 0.15 × 1e-8) = 1.5e-9.
  - The result is a prior with effectively infinite precision. The tuned prior-scale grid (0.25–8) cannot free it.
- **Effect:**
  - Three model inputs are preseason priors wearing in-season names: `edge_expl_pass` (models C and D), and `edge_st_net` and `edge_fg_value` (D).
  - The sigma input `to_dependence` is prior-only too.
  - This explains phase 1's 0.97 correlation between `edge_expl_pass` and `edge_prior_sr`.
- **What it is not:** it is not a leak. It is lost information, plus labels that overstate what the model knows in-season.
- **Unknown:** the accuracy impact is unmeasured.
- **Reproduce:** key `core_prior_pinned_metrics`.
- The personnel audit found the same for `fg_value` and `st_net` (`docs/cfb-personnel/DELIVERABLE.md`, remaining limitations).

**F-22. Two decision engines and two "edge quality" definitions run side by side.**
- **The Lab's rule:** the Model Lab grades V2's LEAN/PASS/REVIEW from `engine.decide()` (`cfb_lab/models.js:51`). That is the stage-8 rule, where LEAN means positive theoretical EV at a captured price.
- **The governed policy:** the frozen `cfb_decision_policy_v1` (`cfb_decision/decision.js`) defines LEAN differently: decision edge above 0 and |gap| of at least 0.5 under the market-shrunk calibration.
- **The Lab's `edge_quality`:** it is `engine.decide().betting_edge_strength`, which is uncalibrated theoretical EV divided by 10%.
  - The decision study measured that theoretical EV at +9.6% on average against −1.7% realized.
  - The Lab's own admin page flags it `DOES_NOT_SORT`.
- **Policy v1's "edge quality tiers"** are a different quantity: P(positive CLV) cut at 0.52 and 0.58.
- **Result:** the same game can carry two statuses and two edge-quality numbers. The hardening brief (items 41, 80, 107) requires one decision definition.

**F-23. The "edge quality" tiers rank closing-line movement, not bet quality.**
- The tiers are displayed (`policy.json` `display.edge_quality_tiers: true`).
- **Dev:** monotone in CLV (0.11 / 0.22 / 0.84 points) and in close-implied EV, but the close-implied EV is ≤ 0 in every tier (−0.039 / −0.033 / −0.0008).
- **Holdout** (the policy's own evidence file):
  - ROI is −2.4% / −6.0% / +2.3% and cover rate is 51.1% / 49.2% / 53.6%; neither rises steadily across the tiers.
  - CLV is 0.12 / 0.34 / 0.80.
- The name implies an edge that no tier has. Rename it to "closing-line tendency" or hide it.

**F-24. V2's snapshot barely responds to who starts at quarterback, so a QB change is under-counted, not double-counted.**
- **The test:** on 2026 rows, the home team's expected starter was replaced with a first-time starter (replacement-level rating, no career dropbacks, flagged as a change) and re-scored with the v2.1.0 artifact.
- **Result:** the projection moved by −0.013 points on average (median −0.021; 10th–90th percentile −0.21 to +0.20; range −0.51 to +0.64). Some games moved toward the weaker team, so GBM D's response is not monotone.
- **The cost in reality:** teams starting a QB for the first time do 1.85 points worse than V2 projects on dev and 3.29 worse on the holdout. The close is off by −0.33 and −2.05.
- **The only QB mechanism is the engine overlay** (−0.99 points for OUT).
  - It is dormant: every production caller passes empty overlays (`app.html`, `cfb_lab/models.js`, `cfb_decision/shadow.js`, `sync_supabase.js`, `shadow_decisions.js`).
  - It is not keyed to the player: `engine.qbOverlay` never checks that the reported player is the snapshot's expected starter (`row.qb[side].qb_id`). Once wired, a report about a starter who already missed the last game would be subtracted a second time.

**F-25. Line-shopping value is overstated by off-market quotes and depends on execution that cannot be checked.**
- **The setup:** dev 2016–19, taking V2's side against the consensus close, graded at close lines (n 2,736, median 20 books per game).

| pricing | ATS [95% CI] | ROI at −110 [95% CI] |
|---|---|---|
| consensus close | 48.6% [46.8, 50.5] | −7.0% [−10.5, −3.4] |
| single book (Pinnacle alone) | 48.7% | −7.0% |
| best of all books | 51.4% [49.5, 53.3] | −1.9% [−5.6, +1.7] |
| best of books within 1.5 points of consensus | 50.5% | −3.6% [−7.2, −0.0] |
| best of books within 0.5 points of consensus | 50.1% | −4.2% |

- 19.2% of the "best" lines are quotes at least 1.5 points off consensus: stale or erroneous books such as JUSTBET and intertops, which F-11 already found carrying sign errors. Removing them cuts the shopping gain by about a third.
- The archive has no timestamps, so simultaneous availability cannot be verified.
- Even with perfect shopping, V2's side at the close loses money.
- Read the market-intel headline (+6.3 points of EV, +7.5% ROI from best-of-20) as an upper bound.

### LOW

**F-26. Model disagreement is wired into sigma with a negative coefficient and no demonstrated signal.**
- Spearman correlation of `ens_sd` with |error| is −0.011 on dev (p 0.39, n 5,954) and +0.098 on the 2026 replay (p 0.16, n 208).
- The sigma coefficient on `ens_sd` is −0.018: more disagreement gives a slightly narrower interval.
- This is decorative, like F-12.

**F-27. The stage-8 statuses on dev show no filtering value at the close.** These are in-sample for the rule.
- LEAN (n 1,641): 52.7% ATS [50.3, 55.2] at the opener, 50.7% at the close, CLV 0.60.
- PASS (n 2,000): 52.1% at the opener, 51.8% at the close, CLV 0.11.
- Filtering buys CLV but not results at the close. Policy v1 shows the same pattern: LEAN − PASS CLV is +0.52 (dev) and +0.42 (holdout), and neither beats the vig.

**F-28. The V1 editorial audit records use one field name for two opposite signs.**
- In `articles/data/editorial/audits/CFB_401856881.json`, `grading.implied_side.model_home_margin` is −9.1 and `market_home_margin` is −1.5. Both are book lines.
- In the same record, `model_accuracy.projected_home_margin` is +9.1.
- The explanation grades the process "SOUND / wrong for the right reason" on one graded claim, while the number missed by 26.1 points, outside its own 80% range, and both market claims failed.

**F-29. The "holdout read once" labels are true per layer but misleading overall.** By the evening of 2026-09-27, 2024–25 had been read at least 12 times across the project:

| read by | reads |
|---|---|
| core model | at least 5 (phase 1) |
| v2.1.1 patch comparison | 1 |
| decision policy v1 | 1, plus a documented re-evaluation after the patch |
| personnel QB | at least 1 |
| personnel units | 1 |
| matchup | 1 |
| market intelligence | 1 |

It is inspected development data.

## Item-by-item status (phase 2)

"Survived" means verified by the auditor. "Research-only" means nothing in production reads it.

| item | result |
|---|---|
| 20 player double count | **No double count found. The QB is under-counted (F-24).** The model's QB features carry about 0 weight, the overlay is dormant and not keyed to the player, and the personnel layer's naive delta double-counted on the holdout, so it was rejected (their evidence). |
| 21 matchup double count | **Survived as "adds nothing".** The matchup artifact is `NO_ADJUSTMENT`. The best dev correction is −0.0045 MAE [−0.022, +0.013]. The core's matchup inputs are near-duplicates of the adjusted ratings (`match_mix_edge` correlates 0.93 with `edge_epa`). |
| 22 market double count | **Confirmed.** Among the decision inputs, \|gap\|, theoretical EV and pure cover probability correlate at 0.998–1.0 (Spearman, dev n 8,246): one signal counted three times. Dispersion is independent (about 0.06). Book-quality weights are inactive. |
| 23 prior double count | **No inflated early certainty; early predictions are too timid instead.** Talent correlates 0.72 with each of the last two seasons' net ratings; returning production 0.06; new head coach −0.14. Calibration slopes are in the table below. |
| 40 edge quality | **Misleading** (F-22, F-23). |
| 41 bet status | **Statuses match their code, but two engines exist (F-22).** The frontend cannot override it: the V2 panel only displays `engine.card()` and checks the sign contract. BET is unreachable. |
| 42 PASS counterfactual | LEAN does no better than PASS at the close (F-27). |
| 62 OL injury | **No absurd adjustments.** Uncertainty-only: up to 5 listed OL out adds +5.5 pt² of variance (sigma 16.0 to 16.17), and it never moves the mean. Research-only. |
| 63 non-QB injury | **No star-name overreaction.** Live 2026 absence deltas are at most 0.71 points and research-only. The one dev signal failed the holdout (their evidence). |
| 64 transfer | QB persistence is 72% [24%, 120%], used to widen uncertainty only. **Unknown.** |
| 65 freshman | Low-sample QBs shrink to replacement (k about 150 dropbacks). The mean bias on first-career starts is real (F-24). Coverage is adequate (0.81). |
| 66 matchup adjustments | The largest shadow correction is capped at ±3.0 points (the raw ridge reaches 10.45). Mean \|adj\| is 0.50 and the 99th percentile 2.46 (dev out-of-fold). The production correction is 0. |
| 67 similar opponents | **Survived.** 62,243 stored pairs: 0 comparison games at or after the freeze, 0 self-matches, 0 after the target's kickoff. |
| 68 scheme labels | **Survived.** Archetypes are k-means clusters of measured style features, descriptive only. No subjective labels were found. |
| 69 weather | **Not in the model.** No V2 feature uses weather. The engine overlay only widens intervals, is not fitted, and is dormant. |
| 70 model disagreement | Wired into sigma, but decorative and wrong-signed (F-26). |
| 75 false edges | See the table below. |
| 76 missed edges | n 305, or 18.6% of near-market games. Only QB change is modestly over-represented (27.5% against a 24.4% base); the rest looks like variance. |
| 77 market moved away | n 34 (\|gap\| ≥ 7 and the close moved 2+ points away). V2's side covered 58.8% at the opener, but the close was nearer the result in 61.8% of these games. The sample is too small to act on. |
| 78 information timeline | **Not reconstructable yet.** There are no V2 prospective rows and no news timeline. |
| 81 frontend display | The V2 shadow panel **survived**: pure and market layers are kept apart, the sign contract is checked, nothing is recomputed. It says "beats V1 on the 2024–25 holdout" without saying that holdout was inspected (LOW). Main board: **PENDING_H3**. |
| 82 API | **PENDING_H3.** |
| 83 newsletter | No CFB V2 consumer was found. V1 editorial spot-check: F-28. |
| 84 AI explanation | The fact-boundary guard refuses invented numbers, status words and reversed sides, and passes its tests. Live output was not sampled. **Some evidence.** |
| 85 security | Committed JWTs decode to `anon` only (the other token is a test fixture). Append-only triggers and revokes exist. Open recommendations: a scoped database role instead of the service role, and a per-isolate AI rate limiter. **Some evidence.** |
| 86–88 failure modes, fail-closed, fallback | **PENDING_H3.** |
| 89 retry | H2 `db.js` has bounded, classified, jittered retries. Runtime stress: **PENDING_H3.** |
| 90 deadlock | H2 `locks.js` uses advisory-lock leases. Code reviewed; runtime: **PENDING_H3.** |
| 91–94 idempotency, replay, cost, single points of failure | **PENDING_H3.** |
| 95 governance | Survived in design: research → challenger → shadow → promotion. No promotion has ever been exercised. |
| 96 retraining | Survived. The retrain mode writes `edgedesk_cfb_challenger_<run>`, and its results are never committed or promoted automatically. |

**Calibration slope by week** (item 23; a slope above 1 means the predictions are too compressed):

| window | V2.1 slope [95% CI] |
|---|---|
| dev weeks 0–2 | 1.206 [1.115, 1.297] (the close: 1.039 [0.967, 1.110]) |
| dev weeks 3–4 | 1.035 |
| dev weeks 5–9 | 0.918 [0.858, 0.977] |
| dev weeks 10+ | 0.979 |
| dev postseason | 0.72 [0.49, 0.96] |
| 2026 weeks 0–2 | 1.03 [0.79, 1.27] |

**False edges, |gap| ≥ 7** (item 75; dev plus 2026, n 443; V2's side covered 54.9% at the opener, partly in-sample):

| tag | failed edges | correct edges |
|---|---|---|
| early season (weeks 0–4) | 66% | 58% |
| week-1 QB unknown | 21.5% | 15.2% |
| P4 vs G5 | 37% | 30% |
| favourite of 21+ | 34.5% | 31.3% |
| close moved 2+ points toward V2 | 27% | 44% |

## 100. Evidence matrix

"Holdout (inspected)" means the 2024–25 window, which has been read repeatedly.

| component | hypothesis | for | against | status |
|---|---|---|---|---|
| point-in-time pipeline | no look-ahead | bit-exact rebuild; independent re-solve to 1e-8; outcome scan clean; poison test | provider EP model fit through 2025; provider revisions untestable | **STRONG** (architecture) |
| pure/market isolation | the market never moves the pure model | 46,920 fuzzed `decide` calls; engine = Python | — | **STRONG** |
| V2 accuracy vs V1 | V2 beats V1 | holdout (inspected) −0.276 [−0.466, −0.070]; 6 of 6 dev seasons | holdout inspected; no prospective data | **SUPPORTED** |
| V2 vs simple ridge | the complexity earns its keep | −0.057 [−0.136, +0.023] | CI includes 0 | **TENTATIVE** |
| V2 vs market | adds information beyond the line | the close moves toward V2 54.7% [52.1, 57.3], against 50–53% for baselines | worse than the opener (+0.27) and the close (+0.36) everywhere; ATS at the close 49.97% | beating the market: **fails**; informing its direction: **TENTATIVE** |
| win probability | calibrated | ECE 0.020; slope 1.06 [0.94, 1.20] | worse than the close-implied Brier | **SUPPORTED** |
| intervals | honest on average | coverage 0.51 / 0.81 / 0.95 | weeks 0–2, week-1 QB unknown, postseason and FCS under-cover; sigma has no discriminative power | average **SUPPORTED**; conditional **TENTATIVE** |
| reliability score | a higher score means a lower error | — | Spearman ≈ 0 | **not supported (decorative)** |
| cover probability | has skill | — | log loss equals a coin flip's | **not supported** |
| QB overlay | captures starter changes | direction measured on dev | dormant; not keyed to the player | **RESEARCH ONLY (dormant)** |
| injury / weather overlays | honest widening | declared | not validated; dormant | **RESEARCH ONLY** |
| personnel units | improve the line | QB oracle direction | non-QB failed the holdout | **RESEARCH ONLY** |
| matchup residual | improves the line | shadow −0.012 [−0.032, +0.007] | nothing passed | **RESEARCH ONLY** |
| market intelligence | improves decisions | key-number push model; opener beats close | the challenger does not beat the opener; selection fails the holdout; shopping inflated (F-25) | **RESEARCH ONLY** (push model **TENTATIVE**) |
| decision policy v1 | finds +EV bets | LEAN has higher CLV | calibrated EV −0.0317 everywhere; BET region empty | **no BET: correctly disabled** |
| edge-quality tiers | rank bet quality | monotone in CLV | close-implied EV ≤ 0 in every tier | **misleading (F-23)** |
| Model Lab and settlement | correct math | 510 evaluations recompute exactly | closes are single-book and observed after kickoff | arithmetic **STRONG**; CLV evidence **TENTATIVE** |
| infrastructure (H2/H3) | fails safe | H2 tests green | — | **PENDING_H3** |

## 101. What we actually know

**Strong evidence:**
- The pipeline is point-in-time, reproducible and leak-free as far as tests can tell.
- The pure model is isolated from the market.
- Signs, odds math and Lab arithmetic are correct.
- Average interval coverage is nominal.
- V2 is less accurate than the opening and closing lines.
- No historical betting rule survives out of sample.

**Some evidence:**
- V2 beats V1 and simple Elo (on the inspected holdout).
- Win probabilities are calibrated.
- The close moves toward V2 slightly more than toward baselines.
- LEAN gains more CLV than PASS.
- The key-number push model beats the bucket table.

**Unknown:**
- Any prospective accuracy.
- Whether V2 beats a simple ridge.
- The effect of fixing F-21.
- Live QB-change handling.
- Transfer and freshman value.
- CLV at a real multi-book close.
- Any price-level edge.
- Provider data's point-in-time correctness.
- Infrastructure behaviour under failure (H3).

## 102. Architectural claims vs performance claims

**Architectural claims, verified:**
- point-in-time opponent-adjusted efficiency (except F-21);
- write-once frozen rows, with per-row version attribution from v2.1.1;
- pure/market separation;
- append-only ledgers enforced by triggers;
- a retrain produces a challenger, never a promotion;
- a one-book market can never be a BET.

**Performance claims:** only these have support:
- "more accurate than V1 on inspected 2024–25 data";
- "probabilities calibrated on average".

"Market-beating", "edge", "sharp" and "high edge quality" do not.

## 104. Simplification (recommendations; none applied during the audit)

**Remove or mark research-only:**
- the reliability score and the heteroscedastic sigma model (a constant width by week bucket is equally good);
- the displayed cover probability;
- the `ens_sd` sigma input;
- the stage-8 `engine.decide()` status rule, in favour of one decision engine (F-22);
- the "edge quality" name (F-23);
- the dormant overlays, unless they are wired and keyed to the player.

**Keep:**
- the C+D ensemble (ridge C alone is within 0.051, not significant);
- V1 as champion.

## 105. Final feature manifest (51 inputs; C = ridge, D = LightGBM)

- **Source:** sportsdataverse play-by-play and schedules (2009–2026), plus the prior inputs.
- **Timing:** every input is as of the Tuesday 12:00 UTC freeze and uses only games that kicked off earlier.
- **Transforms:**
  - C standardizes with the training mean and SD and fills missing values with the training mean;
  - D is untransformed and handles missing values natively.

| family | model | inputs | notes |
|---|---|---|---|
| base (7) | C, D | `home_field`, `elo_diff`, `edge_prior_{epa, epa_pass, epa_rush, sr, ppd}` | prior from the last two seasons' data-only ratings, returning production, talent and coaching |
| adj_eff (7) | C, D | `edge_{epa, epa_pass, epa_rush, sr, sr_pass, sr_rush}`, `eff_pts_raw` | `eff_pts_raw` about 2% missing |
| trench (3) | C | `edge_{line_yds, stuff, opp_rate}` | rushing-yardage based |
| matchup (11) | C, D | `match_mix_edge`, `edge_{sr_early, sr_pd, sr_3rd, expl, expl_pass, expl_rush}`, `x_{pass, rush}_{h, a}` | **`edge_expl_pass` is prior-only (F-21)** |
| form (7) | C, D | `edge_rec_{epa, epa_pass, epa_rush, sr, ppd}`, `l4_edge_epa`, `l2_edge_epa` | correlates 0.99 with the season edges |
| context (6) | C | `rest_diff`, `travel_miles_log`, `tz_shift`, `altitude_kft`, `conference_game_f`, `is_postseason_f` | schedule-derived |
| special teams (2) | D | `edge_st_net`, `edge_fg_value` | **prior-only (F-21)** |
| qb (8) | D | `qb_delta_edge`, `qb_exp_edge`, `{h, a}_qb_exp_db_log`, `{h, a}_qb_changed`, `qb_missing_any`, `qb_unsettled_any` | near-zero influence (F-24) |
| sigma (11) | error model | `early_season`, `inv_games`, `rating_sd_sum`, `ens_sd`, `abs_pred`, `exp_total_z`, `fcs_game_f`, `qb_missing_any`, `qb_unsettled_any`, `vol_sum`, `to_dependence` | decorative (F-12) |
| total (1) | TotalE | `drive_total_raw` | — |

## 106–108. Final architecture, decision policy and data requirements

**Architecture:**
1. Stages 1–2 under the F-01 finality rule and F-11 orientation.
2. Stage-3 joint opponent-adjusted posteriors (the F-21 defect).
3. Stage-4 QB state and Elo.
4. Stage-5 frozen snapshot with no market columns.
5. The C+D equal-weight mean.
6. Sigma and Student-t (df 100) with conformal quantiles; the reliability score is decorative.
7. Win probability.
8. The write-once Tuesday freeze.
9. **Two** market layers: `engine.decide`, and `decision.js` policy v1 (F-22).
10. Model Lab settlement.

**Decision policy:** `cfb_decision_policy_v1` as frozen.

| status | rule |
|---|---|
| BET | never (`bet_enabled` false; calibrated EV below 0 at every price) |
| WAIT | disabled |
| LEAN | decision edge above 0 and \|gap\| of at least 0.5 |
| RESEARCH | a LEAN-level edge with an unresolved QB, fewer than 3 books, incomplete inputs, or an extreme edge |
| PASS | everything else |

**Required before freeze:** retire the stage-8 status rule or re-label it RESEARCH-only (F-22).

**Data requirements:**

| class | sources | if missing |
|---|---|---|
| CRITICAL | schedule (with the completed flag and provider status), play-by-play, the frozen artifact | refuse or withhold per game |
| IMPORTANT | market quotes | DEGRADED_MARKET, no decision |
| IMPORTANT | priors | missingness flags and a wider prior |
| OPTIONAL | injury, QB status, weather | dormant |

Degraded-mode behaviour: **PENDING_H3**.

## 109–110. Version and release manifest

- **No final release version is assigned.**
- The shadow candidate is `edgedesk_cfb_v2.1.1`, through the governed switch in PATCH_v2.1.1 §9.
- The F-21 fix follows the audit brief's bug rule: fix, a new patch version, re-run all affected evaluations, document the difference. It is not a production switch. Promotion stays with the owner.
- Release manifest: **PENDING_H3**.

## 111–118. Policies

**111. Freeze.** No architecture changes after the version switch. Defects go through a patch or challenger version only.

**112. Minimum evidence before a structural change:**
- ≥ 700 prospectively frozen FBS-vs-FBS games, a paired-bootstrap CI excluding 0, and the same sign in both halves of the season;
- or a confirmed technical flaw with a reproduction.
- Never one game, week or upset.
- For scale: the per-game SD of V2 − V1 is about 3.8 points, so a ±0.2 CI needs about 1,400 games.

**113. Live 2026 plan.** Only frozen Tuesday rows count, carrying the per-row `model_version` and graded on true finals. Report:
- MAE and RMSE;
- V2 − opener and V2 − close, with CIs;
- market movement toward V2 by gap bucket, beside V1, ridge and placebo;
- Brier with bucketed calibration (Wilson CIs);
- 50/80/95% coverage by week bucket and QB state;
- CLV at the Lab close, with the provider-declared share;
- statuses from one decision engine;
- priced shadow decisions toward G7 (at least 200).

**114. Weekly report, evidence only:**
- n and the metrics above, with CIs;
- the week's MAE against its expected band (SD about 16 × 0.8 / √n);
- misses of 20+ classified as data bug, information unavailable, model issue or variance;
- repeated-pattern counters.
- No model change from it.

**115. Research triggers:**

| trigger | threshold |
|---|---|
| calibration drift | ECE above 0.05, or slope CI excluding 1, over 300+ games |
| coverage | 80% coverage outside [0.75, 0.85] over 300+ games |
| CLV | mean CLV below 0 with its CI below 0 over 300+ settled quotes |
| QB change | first-start residual below −3 with CI excluding 0 over 60+ games |
| feature drift | PSI above 0.25 |
| data | stage-2 finality violations above 0; PBP-vs-schedule mismatch above 5% in a week; single-book close share above 80% |

**116–117.** No weight, threshold or feature changes after a losing Saturday, and no looser thresholds or bigger stakes after a hot week.

**118. Frozen definitions:**
- **ATS:** W / (W + L), pushes excluded.
- **ROI:** units / stakes at the captured price; −110 only when labelled ASSUMED.
- **CLV:** (L_snapshot − L_close) × side, in points. Close = the consensus of the last pregame quotes within 180 minutes of kickoff, with provider-declared closes flagged.
- **MAE:** |home margin − prediction| on FBS-vs-FBS true finals.
- **Brier:** on home win.
- **Calibration:** 10 buckets with Wilson CIs.
- **Positive CLV:** more than 0 points, or a better price at the same number.
- **Drawdown:** peak to trough in units.
- **Official cutoff:** the Tuesday 12:00 UTC frozen row for V2; the Lab's T24 row for the champion record.

## 119. Known limitations

- 2024–25 inspected at least 12 times; no untouched history.
- No prospective V2 row yet.
- Provider immutability untestable; EP model fit through 2025.
- F-21 (four prior-pinned ratings).
- F-24 (the snapshot ignores QB identity).
- Interval and reliability structure decorative.
- No historical injury, weather or depth data.
- Non-QB personnel unvalidated.
- Historical prices end in 2019, and openers have no timestamps.
- One live book, with closes provider-declared and observed after kickoff.
- FBS-vs-FCS bias of +6 to +9 points.
- PBP incomplete for 3–6% of games from 2021.
- P4-vs-G5 and big-favourite bias.

## 120. Do-not-claim list

Do not claim:
- beating the market, an edge, "sharp", or profitability;
- "high edge quality";
- "reliability" as precision;
- cover probabilities;
- a +7.5% line-shopping gain (F-25);
- QB, injury or weather adjustments;
- matchup or personnel improvements;
- any holdout as untouched;
- "live" results before frozen rows settle.

**Allowed:**
- "more accurate than our previous model on 2024–25 data that informed development";
- "win probabilities calibrated on average";
- "80% ranges contained 81% of results".

## 121. Research backlog (evidence-cited, not implemented)

**HIGH:**
- F-21 (being patched as v2.1.2, see above);
- a QB-identity-aware snapshot or a game-day overlay keyed to `qb_id` (F-24: −1.85 / −3.29 first-start bias);
- multi-book, timestamped live capture (F-14, F-25);
- one decision engine (F-22).

**MEDIUM:**
- prior fade shape (early slope 1.21; weeks 5–9 slope 0.92);
- P4-vs-G5 (+2.8) and 28+ favourite (+4.0) biases;
- early-season and postseason under-coverage;
- replace the reliability score and sigma with an honest week-bucket width;
- a PBP completeness gate for 2021+;
- the key-number push distribution.

**LOW:**
- F-26;
- F-28;
- the FCS model.
