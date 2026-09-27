# Patch `edgedesk_cfb_v2.1.1`: fixes for audit findings F-01, F-02, F-10, F-11 and F-15

- **Parent:** `edgedesk_cfb_v2.1.0`, which is unchanged and is still production.
- **What the patch is:**
  - the same code recipe and the same hyper-parameters, with corrected data;
  - trained through 2025, with feature schema `cfb_v2_fv2`.
- **Artifact:** `football/cfb_v2/artifacts/edgedesk_cfb_v2.1.1/`, written by `export.py`'s normal path. Its MANIFEST records:
  - the parent version;
  - the bug ids fixed;
  - the data diff.
- **Build:** `football/cfb_v2/research/out_p` (git-ignored). The v2.1.0 build `out_h` was left untouched.
- **Evidence:**
  - every number below comes from `python3 -m v2.audit.patch_v211`, written to `out_p/audit/patch_v211.json`;
  - the tests are listed in §6.
- **Audit:** [FINDINGS.md](FINDINGS.md).
- **Status:** a CHALLENGER that has **not** been switched in.
  - `params.js`, the compatibility matrix and governance were left alone.
  - §9 lists exactly what a switch would change.
  - The orchestrator and the owner decide.

## 0. Summary

| | v2.1.0 | v2.1.1 |
|---|---|---|
| Games counted as results that were not | 25 (24 in 2026, 1 in 2024) | 0 |
| Predictions 2016–2023 | — | identical, bit for bit |
| Holdout MAE, true finals (n 1,606) | 12.3269 | 12.3297 (+0.0028 [−0.0032, +0.0089]) |
| Holdout Brier | 0.18291 | 0.18286 (−0.00005 [−0.00016, +0.00006]) |
| Holdout V2 − opener | +0.263 | +0.273: F-11 +0.007, F-01 +0.003 |
| Holdout V2 − close | +0.371 | +0.386 |
| Holdout CLV (every game) | 0.363 | 0.357 |
| Holdout ATS at the opener | 50.98% | 50.98% |
| Live 2026 MAE on true finals, published 208 games | 12.118 | 12.115 |
| Live 2026 V2 − close on true finals | +1.135 | +1.132 |
| Promotion gates G1–G7 | all pass | all pass |
| Dev-selected market rule | review 14 / gap 3 / EV 0.06 / exclude early, BET disabled | identical |
| Decision calibration `w_model` (frozen procedure) | 0.227829 | 0.220978 [0.066, 0.377] (recompute only) |
| Policy v1 holdout (frozen policy) | LEAN 210 / PASS 1,255 / RESEARCH 136 / 0 bets | LEAN 206 / PASS 1,258 / RESEARCH 136 / 0 bets |

**Recommendation.** Yes, switch to v2.1.1, but only as the governed four-part change in §9. The switch does not change any conclusion. See §10.

**Most of the protection lands without a switch.** The F-01 code fix protects production v2.1.0:
- it was committed as 4a23908f7 and is on PR #374;
- from the Monday 10:05 UTC run on, no in-progress, cancelled or postponed game can reach the ratings, Elo, QB state or grading;
- v2.1.0 was trained through 2025, so it never saw a 2026 in-progress game. Its only training defect is the one cancelled 2024 game.

**Recommend-yes rests on correctness, not on accuracy.** The v2.1.1 fit removes one false training row (a 0–0 "final") and uses a corrected market. Its accuracy is statistically indistinguishable from v2.1.0.

---

## 1. The bugs and their fixes

### F-01 (HIGH): in-progress and cancelled games were treated as FINAL

**Cause.** `v2/games.py` set `status = 'FINAL'` whenever both scores were present.

**Fix: rule `cfb_v2_finality_v2`.**

A game is a result (FINAL, with margin and total set) only when all four hold:
1. the provider marks it `completed == True`;
2. both scores are present;
3. nothing contradicts the claim, meaning neither an in-progress provider status (`STATUS_IN_PROGRESS`, `STATUS_HALFTIME`, …) nor a play-by-play with `status_type_completed == False`;
4. the score is not a tie. College football has had overtime since 1996, so a completed tie is a placeholder.

Every other row gets its own status and is never a result:

| status | when |
|---|---|
| `IN_PROGRESS` | a partial score, or a contradicted completed flag |
| `CANCELED` | provider status CANCELED, a forfeit, or "cancel" in the notes |
| `POSTPONED` | provider status POSTPONED, or "postpon" in the notes |
| `DATA_ERROR` | completed without a score, or a completed tie |
| `NOT_PLAYED` / `SCHEDULED` | no score, by kickoff time |

For all of these, margin and total are NaN, and nothing downstream reads them: stage-3 ratings, the QB state and Elo all filter on `status == 'FINAL'`, and so do the pipeline, grading, learn_week, shadow and monitor.

A cancelled or postponed game also no longer counts as a team's previous game when rest days are computed.

| where | what |
|---|---|
| `football/cfb_v2/research/v2/games.py:49` | `FINALITY_RULE` and the provider-status sets; the weekly validator imports them. |
| `v2/games.py:86` | `classify_result()`: the one classifier. |
| `v2/games.py:139` | `finality_inputs()`: the provider status and the PBP completion flag, read from the raw files exactly as the validator reads them (stage 1 keeps neither). |
| `v2/games.py:164` | `assign_status()`. |
| `v2/games.py:248` | the classifier applied to stage 2. |
| `v2/games.py:258` | rest days skip CANCELED and POSTPONED. |
| `v2/games.py:306` | `check_finality()`: stage-2 invariants, asserted every build (FINAL ⇒ completed and a decided margin; non-FINAL ⇒ no result). |
| `v2/weekly/validate.py:177` | `finality()` now calls `games.classify_result`, so the weekly engine and stage 2 cannot disagree. |
| `v2/weekly/validate.py:559` | a completed tie is DATA_ERROR, but its PBP diagnostics still run. |
| `v2/weekly/validate.py:594` | `stage2_final_violations()`. |
| `v2/weekly/run.py:192` | `VERIFY_COMPLETED_GAMES` **refuses** (a StageError, not a warning) any stage-2 FINAL game the validator does not accept as final with the same score. Every stage that reads ratings depends on it. |

**Tests.** `v2/tests_finality.py` (new, 11 tests). The synthetic ones also run in the production `tests_weekly --fast`:
- one per case: in-progress with a partial score, in-progress 0–0, halftime with the completed flag, completed but PBP not, cancelled 0–0, cancelled 7–0 (Iowa State–South Dakota State 2018), postponed, postponed in the notes, forfeit, real final, real final with no provider status, completed 0–0 and 14–14 ties, provider FINAL without the completed flag, missing flag, and completed without a score;
- only FINAL carries a margin;
- the invariant refuses a smuggled result;
- the weekly validator agrees with stage 2;
- VERIFY refuses the pre-fix table;
- Elo never absorbs a non-result.

Real data:
- the classifier and the validator agree on all 14,821 FBS games of 2009–2026 kicked off before the fetch;
- the 169 scored-but-uncompleted rows of 2014–2023 never reach stage 2;
- the 2014–2023 (and 2009–2023) stage-2 rows are **byte-identical** to v2.1.0. This is a pinned content digest: 8,520 rows, `2f09e0a9…`. They were also compared frame for frame against `out_h`;
- the market table does not read finality;
- the named games are not results.

**The 169 rows of 2014–2023, re-examined:**
- 163 have empty division fields and 6 are Division II (Alderson-Broaddus 2023, whose provider status is missing). None has an FBS side, so the FBS filter drops all of them.
- 168 are 0–0 and one is 7–0 (Iowa State–South Dakota State 2018, an abandoned game).
- Under the new rule, none of them would be a result even if it had an FBS side.
- 2009–2013 add 4 more rows of the same kind (all postponed, no FBS side).

**Weekly-engine proof.** I ran the real weekly engine, `python3 -m v2.weekly.run --mode daily --no-fetch`, on a **fresh** `CFB_V2_OUT` in a scratch copy of the repo:
- the run was PUBLISHED with 0 errors;
- VERIFY reported `stage2_final_violations = 0`;
- LEAKAGE_TESTS passed 29/29.

`node football/cfb_production/gate.js start --job cfb_lab_hourly` still prints `decisions=true`.

### F-02 (MEDIUM): the replay and the learning summary were published under the wrong version

**What happened:**
- `snapshots/2026/replay_to_date.json` was written by hand (`predict_live --replay-history`) from the stale `research/out`, which is v2.0.0. Its header correctly says `edgedesk_cfb_v2.0.0`.
- The production bot runs `v2.learn_week` in GRADE_PREVIOUS (`v2/weekly/run.py`). It stamped whatever it graded with `C.MODEL_VERSION`, which is v2.1.0.
- The published "v2.1.0" live MAE of 11.612 is v2.0.0's. v2.1.0 scores 11.607 on the same 208 games (§5.2).

**Fix:**

| where | what |
|---|---|
| `v2/predict_live.py:323` | `build_rows` requires a current build stamp and feature rows of the artifact's schema. |
| `v2/predict_live.py:333` | every published, frozen or replayed row carries `model_version` and a deterministic `build` block: model version, feature version, finality rule, market-orientation rule and the artifact MANIFEST sha. It has no timestamps and no paths, so a write-once row's hash is stable. |
| `v2/predict_live.py:374` | the replay writer refuses rows of another version. |
| `v2/learn_week.py:39` | every row is graded under the version that **produced** it: the row's own `model_version`, else its snapshot file's. There is one row per version and game, and frozen beats replay. |
| `v2/learn_week.py:129` | grading requires a current stage-2 stamp. |
| `v2/learn_week.py:177-181` | the headline is the production version's rows only. Other versions are reported under `by_model_version`. |
| `v2/monitor.py:264` | `monitoring.json.learning` carries `model_version` and `by_model_version`. |
| `v2/tests_leakage.py:415` | `artifact_live_path_reproduces_backtest` compares `current.json` with a build only when both are the same model version and finality rule. |

**Tests.** `tests_weekly --fast` adds 8 checks:
- the stamp refusals (four kinds), and that a current build passes;
- provenance has no timestamp or path;
- replay and frozen rows keep their producing version;
- a replay of another version's rows is refused.

**What the next bot run changes.** I did not hand-edit any bot-owned file.
- `current.json` rows and new frozen rows gain `model_version` and `build`. The first freeze, Tuesday 2026-09-29 12:00 UTC, will be the first frozen file with per-row attribution.
- `learning/2026_summary.json`:
  - keeps `model_version: edgedesk_cfb_v2.1.0` with `games_scored: 0` until frozen v2.1.0 rows are graded;
  - moves the stale replay under `by_model_version["edgedesk_cfb_v2.0.0"]`: 188 games in the dry run on this morning's data, and about 208 once the Monday fetch finalises week 4.
- `learning/2026_misses.json` rows gain `model_version`.
- `monitoring.json.learning` gains the attribution fields.
- The bot does **not** regenerate `replay_to_date.json`. The Model Lab's `football/cfb_lab/backfill.js` hard-codes that file as candidate 001, so rewriting it with v2.1.x rows would mislabel them on the next backfill. That is a follow-up, see §11.

### F-10 (LOW): `config.OUT` and `run_all.sh` default to the stale `research/out`

**Fix: every build directory is stamped.**
- `v2/common.py:122-195` defines `BUILD.json`, `stamp_build`, `require_build`, `build_provenance` and `StaleBuild`.
- Stage 2 (`v2/games.py:449`) records the finality rule and the market-orientation rule.
- Stage 5 (`v2/snapshots.py:197`) records the feature schema and the stage-2 stamp it was built from.
- Every step that **publishes or grades** refuses a directory whose stamp is missing, of another finality rule, of another feature schema, or whose stage 5 was built from an earlier stage 2. Those steps are `predict_live.build_rows`, the weekly FREEZE_EARLY and `learn_week`.
- Verified: `research/out` (v2.0.0) and the unstamped `out_h` are both refused.

**The default stays `out`.** Both the production workflow and `run_all.sh` rebuild stages 1–5 into it before publishing, so it is always stamped when read. The comment is in `run_all.sh`.

`config.py` itself is **unchanged**. `cfb_decision_baseline_001` pins its hash, and an edit switches the Lab's decision shadow off.

### F-11 (MEDIUM): market-data orientation errors in V1's `build_market.py`

The fix is in `football/cfb_p4/research/build_market.py`, rule `cfb_market_orientation_v2`. The corrected table was written to `data/v1/out_p/`, leaving `data/v1/out`, which is `out_h`'s input, untouched.

**1. Sides are oriented by team id against the schedule** (`:171` `orient_sides`, `:231` `_side_frame`).
- Each game's abbreviations are assigned to its two schedule team ids.
- An abbreviation belongs to the id(s) it is seen with most often across the whole archive.
- An abbreviation whose top id is neither of the game's teams is a stray row of another game, and is ignored. For example, the UMass–Boston College 2014 id also carries Ball State–Colgate rows.
- One tied between the two teams takes the side its partner does not hold.
- A collision or an unbreakable tie is `unresolved`, and those rows are not used.
- **This also fixes a third defect the audit did not list:** an abbreviation seen only against one opponent resolved both sides to the home team, and the median of ±33.5 became a **0.0** line. The affected games are Army–Lafayette 2016 and 2018 and Buffalo–Robert Morris 2019, all FBS vs FCS.

**2. Games whose archive home/away ids are swapped relative to the schedule do not use their side lines** (`:200`). There are 11 of them in V1's schedule; the audit's 12th, Georgia–Cincinnati 2020, is not in V1's schedule, so it never had a V2 market row.
- The audit asked for "orient by team id". The data shows that cannot recover the line in these games, because the archive's side labels contradict each other across books:
  - **Army–Navy 2021:** Bovada and its moneyline (Army −300) say Army −7, and three feeds (Caesars, consensus, teamrankings) say Army +7;
  - **New Mexico–San José State 2020:** 1 book against 5;
  - **UNC–South Carolina 2023:** Bovada's spread and its moneyline point to opposite sides;
  - **UTSA–Coastal 2024:** ESPN Bet's spread says +13.5 while its moneyline is −550.
- After orienting by team id, a majority rule gets 3 of 11 of these games wrong.
- So the declared rule is: **spreads and moneylines are not used** (`side_resolution = archive_ids_swapped`, counted), totals are kept, and the line is left missing, never guessed.

**3. Book-sign rule** (`:243` `sign_rule`, `:264` `apply_sign_rule`). Per game, separately for the opener and the close, on each book's home-margin line:
- books with a non-zero line vote by sign;
- a line whose sign is opposite to a **strict majority** and whose size is at least 3 points is **dropped**. A line within 2.5 of pick'em on the other side is an ordinary disagreement and is kept;
- with no strict majority and a line of at least 3 on each side, the field is **unresolved**: all of its lines are dropped and the consensus is left missing;
- dropped lines stay in `market_books.csv` with `close_conflict` / `open_conflict`, and games carry counts;
- totals are in `market_qa.json`: 170 closing and 23 opening book lines dropped, in 171 games; 1 closing and 2 opening fields unresolved;
- by book, the drops are mostly JUSTBET 2008 (66), intertops (26), DraftKings (22), Sports Interaction (18) and MATCHBOOK (15).

**4. V2 re-checks the orientation** (`v2/games.py:324`, `:330` `orient_by_team_id`).
- The corrected table records the team ids it was oriented by.
- Stage 2 compares them with its own schedule: it keeps the same orientation, negates the reverse (`market_reoriented`), and drops anything else (`market_qa: team_mismatch`).
- On this data there are 0 reorientations and 0 mismatches.

**Effect in V2's stage 2.** 54 spread fields in 41 games changed, 38 of them FBS vs FBS:
- 11 swapped-id games lost their opener and close;
- single-book drops moved medians by 0.25–1.0 points, mostly 2024–25 openers where only 3 books exist;
- 2 openers of 2023 are unresolved.

Every changed field is listed in the v2.1.1 MANIFEST, under `data_diff.market_fields_changed_in_stage2`.

**Tests.** `v2/tests_signs.py`, 4 new tests (16/16):
- `book_sign_rule_drops_the_contradicting_book`;
- `orientation_by_team_id_fixes_swapped_ids_and_ambiguous_abbreviations` (ARM/LAF elimination, Army–Navy swapped ids, the stray BALL rows);
- `stage2_orients_the_archive_against_its_own_schedule`;
- `data_archive_orientation_named_games`: Army–Navy 2021 has no spread and is flagged, its 35.5 total is kept, the 11 swapped games have no spread, Army–Lafayette 2016 is +33.5, and UMass–BC 2014 is −17.

### F-15 (MEDIUM): the leakage guard checked column names, not content

**Fix.** The audit's outcome scan is now a standing test in `v2/tests_leakage.py:443-540`. It runs on the build's stage-5 table, so it also runs in the weekly engine's LEAKAGE_TESTS stage.

Declared thresholds, fixed before v2.1.1 was scanned:

| check | threshold |
|---|---|
| \|corr(input, margin − close)\| | must not exceed max(0.08, 4/√n) |
| any single input's r² with the margin | must not exceed the close's r² (applied only when n ≥ 2,000) |
| minimum sample | 150 scored games with a close, else the scan reports itself skipped |

**Tests:**
- `outcome_scan_catches_a_disguised_outcome` (synthetic power check): the result disguised as `edge_sr` and the margin itself are both caught, and honest inputs pass;
- `artifact_outcome_scan_every_model_input`: all 51 inputs pass, and the same table with the margin written into `edge_epa` fails, which shows the scan has power on real data.

| build | largest \|corr(input, margin − close)\| | largest input r² vs the close's r² |
|---|---|---|
| v2.1.0 (8,876 games) | 0.051 (`edge_stuff`) | 0.405 vs 0.450 |
| v2.1.1 (8,845 games) | 0.050 | 0.405 vs 0.451 |
| weekly 2026-only build (188 games) | 0.108, under the 0.29 floor (4/√188) | not applied (n < 2,000) |

---

## 2. The patch build: the V2.1 recipe, no re-tuning

`out_p` was built from scratch:
- stage 1, `v2.plays` 2009–2026;
- stage 2, `v2.games`, with `CFB_V2_V1_MARKET = data/v1/out_p/market.csv`;
- stage 3, `v2.build_ratings`;
- stage 4, `v2.qb` and `v2.elo`;
- stage 5, `v2.snapshots`;
- the leakage tests;
- stage 7, `v2.pipeline`;
- then `CFB_V2_MODEL_VERSION=edgedesk_cfb_v2.1.1 python3 -m v2.export`.

`CFB_V2_V1_RECORDS` is unchanged, and so is `config.py` (sha `fae24ed2…`).

**Not run:** `tune_ratings`, `ablation`, `tune_models` and `report.py` (which would rewrite `docs/cfb-v2/BACKTEST.md`). The frozen tuning outputs (`selected_families.json`, `ablation.json`, `tuning_*.json`) were copied from `out_h`, and their hashes are in the MANIFEST.

**Re-derived inside the recipe, and identical to v2.1.0:**
- Elo's dev tuning: K 50, HFA 70, carry 1;
- the win calibration choice (raw);
- the stack (C and D at 0.5 each);
- the families, the columns and `t_df`;
- the dev-selected market rule's parameters.

The rule's reality-check statistics moved with the corrected dev market:

| | v2.1.0 | v2.1.1 |
|---|---|---|
| grid | 341 rules | 335 rules |
| null q95 | 0.058 | 0.043 |
| p | 0.136 | 0.108 |

**Stages 3–4, 2012–2025:** the ratings, priors, varcomp and final data-only ratings are **byte-identical**.
- Elo and the QB state differ only in 2026.
- The cancelled 2024 0–0 game never moved Elo, because the margin multiplier is ln(1) = 0.
- The only pre-2026 inputs that changed are the rest days of the three 2024 games in §3 and the training target set.

**Artifact.** `artifacts/edgedesk_cfb_v2.1.1/` holds `gbm_D.txt`, `meta.json`, `models.json`, `params.js` and `MANIFEST.json`.
- It verifies against its MANIFEST, whose sha256 is `5081956d…`.
- `export.py` now refuses to overwrite it.

What differs from v2.1.0 is fitted values only:

| component | v2.1.0 | v2.1.1 |
|---|---|---|
| ridge coefficients (max \|Δβ\|) | — | 0.0056 |
| Platt win | [0.0464, 1.0420] | [0.0465, 1.0419] |
| cover coefficient | [−0.0105, 0.1870] | [−0.0124, 0.1757] |
| CLV β | 0.1084 | 0.1083 |
| push table 2.5–3.5 | 0.0930 | 0.0936 |
| reliability range | 15.311–18.499 | 15.309–18.499 |
| \|z\| quantiles 50/80/95% | 0.662 / 1.284 / 1.946 | 0.661 / 1.285 / 1.949 |

Gates G1–G7 all pass; the decision is ELIGIBLE_FOR_PROMOTION and BET is disabled.

## 3. Data diff (the full lists are in the MANIFEST)

**Status changes: 25 games that v2.1.0 counted as FINAL.**

| group | games | feed score | true final |
|---|---|---|---|
| 2024 App State–Liberty (cancelled, hurricane) | 1 | 0–0 | none (CANCELED) |
| 2026, partial score, completed = False | 13 (12 FBS–FBS) | Alabama–South Carolina 21–3, UL Monroe–FAU 0–0, North Texas–HCU 14–14, … | 49–18, 17–45, 63–14, … |
| 2026, completed = True but the provider status (IN_PROGRESS / HALFTIME) and the PBP (stops in Q2–Q4) say in progress | 11 (8 FBS–FBS) | Penn State–Wisconsin 20–24, Miami–Central Michigan 52–3, … | the same (the score is final; the play-by-play is not) |

The 2026 file on disk was fetched at 07:21 UTC, about 7 h after these games kicked off. All 24 held-out games of 2026 will be FINAL with complete PBP in the next fetch.

The second 2026 group goes beyond the audit's 13. The weekly validator already held these games out ("sources disagree"), and rating them from half-game play-by-play was also wrong. With one shared rule, stage 2 now does the same.

**Rest days:** App State–Liberty itself, Marshall–App State and Liberty–FIU (all 2024).

**Training rows removed:** App State–Liberty 2024 (0–0), from the 2025 and 2026 fits and so from this artifact, and from holdout grading.

**Market:** see F-11. 54 fields in 41 games changed.

## 4. v2.1.0 vs v2.1.1: the difference

### 4.1 Every prediction, 2016–2026 (9,524 games)

| seasons | games | moved | mean \|Δ margin\| | max \|Δ margin\| | mean \|Δ win p\| | max \|Δ win p\| | why |
|---|---|---|---|---|---|---|---|
| 2016–2023 | 6,782 | **0** | 0 | 0 | 0 | 0 | identical: the fits use seasons < S, and those are unchanged |
| 2024 | 920 | 3 | 0.0018 | 0.84 | 0.00004 | 0.019 | rest days (App State–Liberty cancelled) |
| 2025 | 934 | 934 | 0.130 | 0.58 | 0.0023 | 0.013 | refit without the 2024 0–0 row |
| 2026, weeks 0–4 (the replay) | 331 | 331 | 0.132 | 0.56 | | | refit only |
| 2026, weeks 5+ | 557 | 557 | 0.843 | 6.09 | | 0.119 | ratings, Elo and QB state without the 24 held-out week-4 games |
| **all** | 9,524 | | **0.067** | **6.09** | **0.0015** | **0.119** | |

**The 2024 moves:**

| game | v2.1.0 | v2.1.1 |
|---|---|---|
| Marshall–App State | 4.18 | 3.35 |
| Liberty–FIU | 16.94 | 17.60 |
| the cancelled game itself | −6.68 | −6.86 |

**The largest moves are all 2026 week 5+ games of teams with a held-out week-4 game:**

| game | week | v2.1.0 | v2.1.1 | why |
|---|---|---|---|---|
| Wisconsin–Rutgers | 10 | 15.34 | 9.25 | Wisconsin's 24–20 win at Penn State is held out |
| Wisconsin–Michigan State | 5 | 9.93 | 4.83 | Wisconsin's 24–20 win at Penn State is held out |
| Maryland–Penn State | 13 | −8.68 | −13.18 | Penn State's 20–24 loss is held out |
| Michigan–Penn State | 7 | 5.23 | 0.77 | Penn State's 20–24 loss is held out |

These week-5+ numbers come from a stale 07:21 UTC file and are provisional in both versions. Production recomputes them from each fresh fetch, where those games are final.

### 4.2 Dev and holdout accuracy on TRUE finals (FBS vs FBS; paired bootstrap, v2.1.1 − v2.1.0)

| window | n | MAE v2.1.0 → v2.1.1 | Δ MAE [95% CI] | RMSE | Δ RMSE [95% CI] | Brier | Δ Brier [95% CI] |
|---|---|---|---|---|---|---|---|
| dev 2016–23 | 5,954 (5,194 with a win probability) | 12.7991 → 12.7991 | 0 [0, 0] | 16.1747 → 16.1747 | 0 | 0.17823 → 0.17823 | 0 |
| holdout 2024–25 | 1,606 | 12.3269 → 12.3297 | +0.0028 [−0.0032, +0.0089] | 15.6056 → 15.6047 | −0.0009 [−0.0068, +0.0051] | 0.18291 → 0.18286 | −0.00005 [−0.00016, +0.00006] |

**Holdout calibration:**

| | v2.1.0 | v2.1.1 |
|---|---|---|
| ECE | 0.0203 | 0.0193 |
| slope | 1.055 [0.915, 1.184] | 1.056 [0.915, 1.186] |
| buckets inside their CI | 10/10 | 10/10 |

**v2.1.0 as it was scored:** n 1,607, including the cancelled 0–0 game, with MAE 12.3234.

**The published common set** (n 1,534, `backtest.json` headline):

| | v2.1.0 | v2.1.1 |
|---|---|---|
| V2 | 12.3759 | 12.3797 |
| opener | 12.0966 | 12.0976 |
| close | 12.0127 | 12.0125 |
| 50/80/95% coverage | 0.508 / 0.814 / 0.951 | 0.509 / 0.813 / 0.949 |

**The Model Lab reference set** (the same 1,604 games): MAE 12.3213 → 12.3242, RMSE 15.6016 → 15.6008, Brier 0.1831 → 0.1831.

### 4.3 The live-2026 replay graded against TRUE finals

**Truth:** the Model Lab's settled results, `football/cfb_lab/ledger/2026/results.jsonl`, recorded up to 15:07 UTC. They agree with every schedule final (0 mismatches).

Games: 215 FBS-vs-FBS games kicked off before the fetch.
- v2.1.0 graded 208 of them. 11 were graded against a partial score; a 12th partial score happened to have the true margin.
- v2.1.1 holds 20 out as IN_PROGRESS and 7 were never scored.

| set | n | v2.0.0 replay (published) | v2.1.0 | v2.1.1 | opener | close | v2.1.0 − close | v2.1.1 − close |
|---|---|---|---|---|---|---|---|---|
| as published: the 208 games, graded on v2.1.0's stage-2 scores | 208 | **11.612** | 11.607 | 11.606 | 10.844 | 10.649 | +0.958 [0.342, 1.564] | +0.957 |
| the same 208, on true finals | 208 | 12.110 | **12.118** | **12.115** | 11.161 | 10.983 | **+1.135** [0.500, 1.753] | **+1.132** [0.502, 1.752] |
| all 215, on true finals | 215 | 12.166 | 12.160 | 12.157 | 11.201 | 11.030 | +1.130 [0.551, 1.723] | +1.127 [0.549, 1.726] |

- v2.1.1 − v2.1.0 on true finals is −0.003 [−0.027, +0.021].
- Brier on the 208 true finals: 0.1424 → 0.1422.
- The published 11.612 is v2.0.0's number (F-02).

---

## 5. Evaluations re-run: old → new

### 5.1 Market comparisons after F-11

Every game, the side of the model, priced at −110. The pipeline's own `market.run` / `pipeline.betting_report` was re-run on three combinations:
- **(a)** v2.1.0 on the old market. This reproduces the published numbers exactly.
- **(b)** v2.1.0 on the corrected market: the F-11 effect alone.
- **(c)** v2.1.1 on the corrected market.

**Holdout 2024–25:**

| | (a) v2.1.0, old market | (b) v2.1.0, corrected | (c) v2.1.1, corrected |
|---|---|---|---|
| games | 1,606 | 1,604 | 1,604 |
| V2 − opener (MAE) | +0.263 [+0.103, +0.426] | +0.270 [+0.104, +0.445] | +0.273 [+0.106, +0.450] |
| V2 − close | +0.371 [+0.199, +0.566] | +0.383 [+0.208, +0.550] | +0.386 [+0.212, +0.555] |
| CLV, mean pts | 0.363 [0.260, 0.465] | 0.357 [0.256, 0.458] | 0.357 [0.257, 0.456] |
| ATS at the opener | 50.98% [48.4, 53.4] | 50.85% | 50.98% [48.5, 53.4] |
| ROI at the opener | −2.63% [−7.1, +2.3] | −2.87% | −2.63% [−7.3, +1.9] |
| ATS / ROI at the close | 49.97% / −4.51% | 49.84% / −4.75% | 49.97% / −4.51% |
| line moved toward V2 | 54.7% | 54.7% | 54.6% |
| dev-rule qualified bets | 5 (ROI +34.6%) | 2 (−4.5%) | 3 (−3.0%) |

**Dev 2016–23** (dev predictions are identical, so (b) = (c)):

| | (a) | (b) = (c) |
|---|---|---|
| games | 3,656 | 3,648 |
| V2 − opener | +0.218 [+0.071, +0.341] | +0.225 [+0.090, +0.352] |
| V2 − close | +0.370 | +0.374 |
| CLV | 0.355 [0.286, 0.424] | 0.336 [0.265, 0.410] |
| ATS at the opener | 52.36% [50.7, 54.1] | 51.81% [50.2, 53.4] |
| ROI at the opener | −0.03% | −1.07% |
| ATS at the close | 51.31% | 50.78% |
| dev-rule qualified bets | 162 (ATS 61.6%, CLV 1.63) | 157 (61.0%, 1.40) |

**Reading:**
- The corrected market makes V2 look slightly **worse** against the market, as the audit said: the flagged games flattered V2.
- The targeted fix moves holdout V2 − opener by +0.007 and CLV by −0.006. The audit's +0.294 removed every game with any disagreement between books, which is a broader flag than the rule adopted here.
- No market conclusion changes: V2 remains worse than the opener and the close in every window, with no betting edge.

### 5.2 Live-2026 numbers

See §4.3. On true finals:
- v2.1.0: 12.118, with V2 − close +1.135;
- v2.1.1: 12.115, with V2 − close +1.132.

### 5.3 The decision calibration's frozen procedure, recomputed on v2.1.1 OOF

This is a recompute only. The frozen selection (identity map with a logit shrink toward the market) was kept, and the frozen artifact was not rewritten.

| input | w_model | 95% profile CI | LR vs w = 0 | n |
|---|---|---|---|---|
| the frozen v2.1.0 dataset | **0.227829** (= the artifact) | [0.073, 0.383] | 8.32 | 4,252 |
| a rebuilt v2.1.0 dataset (the same code) | 0.227829 | [0.073, 0.383] | 8.32 | 4,252 |
| **v2.1.1** | **0.220978** | [0.066, 0.377] | 7.80 | 4,248 |

**The answer is no:** the frozen procedure does not give the same `w_model` on v2.1.1, but it is well inside the CI.
- Dev predictions are identical.
- The whole difference comes from F-11: 4 DEV openers are corrected or removed (the swapped-id and unresolved games).

### 5.4 The decision policy v1 holdout: a documented re-evaluation due to a bug fix

**This is not a second read for tuning.** The frozen policy (`policy.json`, sha `cb9019a2…`), its frozen calibration (w 0.227829) and its frozen tournament choices were applied, unchanged, to the v2.1.1 holdout rows.
- The same code first reproduced the recorded v2.1.0 read exactly.
- Nothing was chosen, refit or re-thresholded.
- `MANIFEST.json`, `evidence.json` and `holdout_access.jsonl` were **not** modified.
- The run is logged as a new line in `cfb_decision_policy_v1/post_freeze_changes.jsonl` (`action: DOCUMENTED_REEVALUATION_BUG_FIX`).

| | v2.1.0 (recorded) | v2.1.1 |
|---|---|---|
| holdout decision rows | 1,601 | 1,600 |
| production statuses | LEAN 210 · PASS 1,255 · RESEARCH 136 · 0 bets | LEAN 206 · PASS 1,258 · RESEARCH 136 · 0 bets |
| decision log loss − coin | +0.00022 [−0.00183, +0.00222] | +0.00025 [−0.00179, +0.00221] |
| LEAN − PASS CLV | +0.417 [+0.080, +0.761] | +0.399 [+0.055, +0.734] |
| edge candidate: bets / CLV / ROI | 165 / 0.608 / −6.2% | 160 / 0.650 / −5.7% |
| multivariate: bets / CLV / ROI | 61 / 1.291 / +19.1% | 60 / 1.429 / +17.9% |
| clv_model: bets / CLV / ROI | 80 / 1.066 / +15.8% | 80 / 1.172 / +18.2% |
| tiers (HIGH ≥ LOW CLV) | yes | yes |
| promotion gate | G1, G2 pass; `bet_enabled stays false` | the same |
| **without a calibration base_model_version switch** | — | **NO_BET for all 1,600 rows** (`NO_BET_VERSION_MISMATCH`, fail closed) |

---

## 6. Tests

Final state, with this patch in the tree.

| suite | build | result |
|---|---|---|
| `python3 -m v2.weekly.tests_weekly --fast` (production CI) | — | **84/84**: 70 before, +6 F-01, +8 F-02/F-10 |
| `python3 -m v2.tests_finality` (new) | out_p, and a patched stage 1–2 | **11/11** |
| `python3 -m v2.tests_signs` | out_p, out_h | **16/16** (12 + 4 F-11) |
| `python3 -m v2.tests_leakage` | out_p, out_h, weekly dry run | **29/29** (27 + 2 F-15) |
| `python3 -m v2.weekly.tests_games --fast` | — | **74/74** |
| `python3 -m v2.weekly.tests_games` (real data) | out_p | **102/102** |
| `python3 -m v2.weekly.tests_weekly` (full, real data) | out_p; out_h | **95/95**; 95/95 |
| `python3 -m v2.weekly.tests_state` | out_p; stage 1–2 patched with out_h 3+ | **98/98**; 98/98 |
| `python3 -m v2.decision.tests_policy` / `tests_decision` | out_h | **20/20**, **23/23** |
| `node football/cfb_v2/tests.js` | — | **100/100** |
| `node football/cfb_production/gate.js start --job cfb_lab_hourly` | — | `decisions=true` |
| weekly engine, a fresh build dir (`--mode daily --no-fetch`) | scratch copy | PUBLISHED, 0 errors, `stage2_final_violations` 0 |

## 7. Files changed

| file | bug |
|---|---|
| `football/cfb_v2/research/v2/games.py` | F-01 (finality), F-11 (orient check, QA columns), F-10 (stage-2 stamp) |
| `football/cfb_v2/research/v2/weekly/validate.py` | F-01 (the shared classifier, tie diagnostics, `stage2_final_violations`) |
| `football/cfb_v2/research/v2/weekly/run.py` | F-01 (VERIFY refuses) |
| `football/cfb_v2/research/v2/common.py` | F-10 / F-02 (build stamp, provenance) |
| `football/cfb_v2/research/v2/snapshots.py` | F-10 (stage-5 stamp) |
| `football/cfb_v2/research/v2/predict_live.py` | F-02 (per-row version and build, refusals) |
| `football/cfb_v2/research/v2/learn_week.py` | F-02 (per-version grading) |
| `football/cfb_v2/research/v2/monitor.py` | F-02 (attribution in monitoring) |
| `football/cfb_v2/research/run_all.sh` | F-10 (comment) |
| `football/cfb_p4/research/build_market.py` | F-11 |
| `football/cfb_v2/research/v2/tests_finality.py` (new) | F-01 tests |
| `football/cfb_v2/research/v2/weekly/tests_weekly.py` | F-01 and F-02/F-10 tests |
| `football/cfb_v2/research/v2/tests_signs.py` | F-11 tests |
| `football/cfb_v2/research/v2/tests_leakage.py` | F-15 scan; the version-aware live-path test |
| `football/cfb_v2/research/v2/audit/patch_v211.py` (new) | the evaluation behind every number here |
| `football/cfb_v2/artifacts/edgedesk_cfb_v2.1.1/` (new) | the patch artifact and its MANIFEST |
| `football/cfb_v2/artifacts/decision/cfb_decision_policy_v1/post_freeze_changes.jsonl` | one appended line (§5.4) |
| `docs/cfb-audit/PATCH_v2.1.1.md` (new) | this document |

**Not changed:**
- `v2/config.py` and `v2/market.py`, both pinned by `cfb_decision_baseline_001`;
- `football/cfb_v2/params.js`;
- `football/cfb_production/compatibility.json`;
- governance and the v2.1.0 artifact;
- `out_h`;
- every bot-owned file: `current.json`, `learning/`, `monitoring.json`, `shadow/`, `snapshots/`, `football/cfb_weekly/`.

Generated, git-ignored:
- `research/out_p/`;
- `research/data/v1/out_p/` (the corrected V1 market).

## 8. What the next production run will change (without a switch)

**The code fixes take effect on the next `cfb-v2-shadow.yml` run from `main`**, the Monday 10:05 UTC weekly run:
- **F-01.** No in-progress, cancelled or postponed game can be rated or graded, and VERIFY refuses a disagreement. On Monday's fresh fetch the week-4 games are final, so no games are held out. Any game still in progress at the Tuesday 12:00 UTC freeze is held out until it is final.
- **F-02.** The row-level `model_version` and `build` fields and the attribution in learning and monitoring, as described in §1 F-02.
- **F-10.** Every publish and grade step checks the stamp. A fresh runner always stamps before reading.
- **F-11.** No effect on the weekly job: it builds no archive market; 2026 lines come from CFBD.
- **F-15.** The scan runs in LEAKAGE_TESTS on the live season, with the 4-SE floor.

## 9. What switching production to v2.1.1 would change (not done)

I simulated the switch in a scratch copy of the repo.
- `compat.js` then says "no COMPATIBLE entry for edgedesk_cfb_v2.1.1".
- `manifest.js --write-compat` refuses: "refusing to pin a decision baseline whose files do not verify". `cfb_decision_baseline_001` pins `params.js` and `config.py`.

A switch is therefore **four coupled changes**, made together, in this order:

1. **The pure model.**
   - `football/cfb_v2/research/v2/config.py`: `PRODUCTION_MODEL_VERSION = 'edgedesk_cfb_v2.1.1'`, one line.
   - `football/cfb_v2/params.js` is replaced by `artifacts/edgedesk_cfb_v2.1.1/params.js`, with sha `d6ea675e…` (it was `35845306…`). The changes:
     - `model_version`;
     - Platt win [0.04636, 1.04204] → [0.04654, 1.04194], with the isotonic knots re-fitted;
     - cover coefficient [−0.0105, 0.1870] → [−0.0124, 0.1757], and `rsd_fill` 1.0890 → 1.0893;
     - CLV β 0.10843 → 0.10830;
     - push table 0–2.5 0.01014 → 0.01024, 2.5–3.5 0.09302 → 0.09365, 13.5+ 0.02844 → 0.02850;
     - \|z\| quantiles 0.6619 / 1.2844 / 1.9463 → 0.6614 / 1.2846 / 1.9495;
     - reliability σ range 15.3106–18.4995 → 15.3087–18.4990;
     - the rule's reality-check statistics (§2);
     - `validation_summary`.
   - Unchanged: `engine.js`, the stack weights, `t_df`, the QB overlay, the rule parameters, and `bet_enabled: false`.
2. **The decision baseline.** `cfb_decision_baseline_001` is frozen on v2.1.0 ("the baseline never changes"). A new `cfb_decision_baseline_002`, frozen by `v2.decision.baseline` with `BASE_MODEL_VERSION = 'edgedesk_cfb_v2.1.1'`, has to pin the new `config.py`, `params.js`, `engine.js` and `market.py` and the `out_p` data. Without it, the Lab's `cfb_lab_hourly` gate turns decisions off.
3. **The decision calibration's `base_model_version`.** `decision.js:232` and `policy.py:203` fail closed on a mismatch: every row becomes `NO_BET_VERSION_MISMATCH` (§5.4). The frozen `cfb_decision_calibration_v1` (base v2.1.0) cannot be edited, so a new calibration version is needed, e.g. `cfb_decision_calibration_v1_1` with `base_model_version: edgedesk_cfb_v2.1.1`. There are two options:
   - **(a)** carry v1's numbers (w 0.227829, and every curve and model);
   - **(b)** re-run the frozen procedure (`v2.decision.study` → `freeze`) on v2.1.1 with the selection pinned, giving w 0.220978 plus the re-fitted curves.

   `cfb_decision_policy_v1`'s `policy.json` names `calibration_artifact: cfb_decision_calibration_v1`. Its MANIFEST is frozen, so the policy needs a new version (`cfb_decision_policy_v1_1`) that differs only in `calibration_artifact`, with a pre-registration note. Also `v2/decision/__init__.py` `BASE_MODEL_VERSION`.
4. **`football/cfb_production/compatibility.json`**, via `node football/cfb_production/manifest.js --write-compat` once items 1–3 verify.
   - A new `PRODUCTION_PATHWAY` / `COMPATIBLE` entry:
     - `model_version: edgedesk_cfb_v2.1.1`, `feature_version: cfb_v2_fv2`;
     - `artifact_manifest_sha256: 5081956dfb1e78c0fe90ad9770de73fed3e2e68952bf69af6b0898ea45ddbd3e`;
     - `params_sha256: d6ea675e96a88d630793309283228a5f8ca90871776249210ae8fdfae594f635`;
     - `engine_sha256: 745c1c3c…` (unchanged);
     - `calibration_version: edgedesk_cfb_v2.1.1:e10ed5d91a8f`;
     - `ensemble_version: edgedesk_cfb_v2.1.1:e105ca1727a6` (the same weights hash);
     - `market_engine_version: edgedesk_cfb_v2.1.1:market:36cbce4baddf`;
     - the new decision policy / baseline / calibration versions and hashes;
     - `bet_enabled_allowed: false`.
   - The v2.1.0 entry becomes the rollback, a `CANDIDATE`. It stays `COMPATIBLE` only while its own decision tuple still verifies.
5. **The Model Lab's tracked models.**
   - `football/cfb_lab/config.json`: add `"edgedesk_cfb_v2.1.1": {"label": "V2.1.1 · patch", "adapter": "v2.1"}` and a reference `{"mae": 12.3242, "rmse": 15.6008, "brier": 0.1831, "pred_sd": 12.424}` (the same 1,604 holdout games; v2.1.0's are 12.3213 / 15.6016 / 0.1831). This is a governed act: append `RULE_CHANGED` to `governance/audit_log.jsonl`.
   - `governance/model_roles.jsonl`, via `node football/cfb_lab/governance.js`: v2.1.1 becomes the V2 **challenger** in shadow, and v2.1.0 becomes a candidate / retired. Neither is champion; V1 stays champion.
   - The v2.1 adapter (`models.js`) keys on `current.json`'s `model_version`. The Lab's checkpoint skips frozen files of a version other than the live one (`checkpoint.js:338`), so the switch should land between freezes.
   - The experiments EXP-001 to EXP-004 name v2.1.0 as the challenger or baseline. Governance should record whether they continue on v2.1.1.

## 10. Recommendation

**Yes.** Adopt v2.1.1 as the shadowed V2 version, as the governed change in §9 (all four parts together, between two freezes), because:
- it is the same recipe on correct data;
- v2.1.0's artifact contains one false training result, the cancelled 2024 game as a 0–0 final;
- its market layer was fitted on 54 mis-oriented or contradictory lines.

**Nothing in the evidence argues against it:**
- dev is identical;
- holdout MAE +0.003 [−0.003, +0.009], RMSE −0.001 and Brier −0.00005 are all noise;
- the gates, the rule and `bet_enabled` are unchanged;
- the decision policy's frozen results move within noise.

**Nothing argues for urgency either.** The patch buys correctness, not accuracy.
- v2.1.0 with the F-01 code fix (already on PR #374) is safe for the Monday and Tuesday runs.
- If the four-part switch cannot be done cleanly before the Tuesday 2026-09-29 12:00 UTC freeze, keep v2.1.0 for that freeze. That is the first prospective record, and a version change mid-freeze would split its attribution. Switch at a later freeze boundary.

**Market-facing claims** from here on should use the corrected numbers in §5.1: V2 − opener +0.27 and V2 − close +0.39 on the holdout.

## 11. Caveats and follow-ups

- **The 2026 week-5+ predictions in both builds** are from the 07:21 UTC file. They are provisional; production recomputes them from fresh data.
- **The Model Lab's `backfill.js`** treats `snapshots/<season>/replay_to_date.json` as candidate 001 regardless of its header. It should read the file's (now per-row) `model_version` before any v2.1.x replay is written there.
- **The audit's broader book-conflict count (158 games)** includes seasons before 2014 and FBS vs FCS games, and any two books of opposite sign. The declared rule drops 170 closing and 23 opening single-book lines archive-wide, in 171 games. In V2's FBS scope it changes 38 fields.
- **The 11 swapped-id games** keep their totals but have no spread. Recovering them needs an independent line source for 2020–24, which this patch does not add.
- **The weekly VERIFY stage now fails closed** if stage 2 and the validator ever disagree. With the shared classifier they cannot, except through a code divergence, which is the intent.
- **Unrelated to this patch:** `research/out/.weekly.lock` and `research/out/personnel/*` still sit in the stale directory. They are harmless now that publishing and grading refuse it.
