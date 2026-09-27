# CFB scheme and matchup engine: backtest

Code: `football/cfb_v2/research/v2/matchup/backtest.py`. Outputs in `$CFB_V2_OUT/matchup/` (`out_h`):

| file | contents |
|---|---|
| `backtest_dev.json` | every dev experiment |
| `oof_dev.parquet` | per-game corrections |
| `holdout.json` | scored once, 2026-09-27 15:50 UTC |
| `live_2026.json` | 2026 games played so far |
| `features.parquet` | the features |
| `similar_pairs.parquet` | the similar-matchup comparisons |
| `style_change_events.parquet` | the style events |

Methods: [METHODS.md](METHODS.md). Data limits: [AUDIT.md](AUDIT.md).

**GENERAL MODEL** is V2.1 (`edgedesk_cfb_v2.1.0`), read unchanged from its stage-7 walk-forward.
V2.1's stored `p_home_raw` is reproduced exactly (max |diff| = 0.0) from `ens_pred`, `sigma` and each
season's t df. **GENERAL + MATCHUP** is V2.1 plus the walk-forward matchup correction, with V2.1's
sigma. The scope is FBS vs FBS, FINAL, with a V2.1 prediction:

| window | games |
|---|---|
| dev 2016-2023 | 5,954 |
| holdout 2024-2025 | 1,607 |
| live 2026 so far | 208 |

These counts differ from V2's own BACKTEST.md, which scores a common set that requires a V1 replay or
market row (4,984 / 1,534). Probability metrics start in 2017, the first season V2.1 has a sigma.

## Verdict

**No matchup family proves out-of-sample incremental value over V2.1. The frozen artifact is
`NO_ADJUSTMENT`: the matchup-aware fair spread equals the general fair spread on every game.**

- 18 families were tested against the pre-registered rule; none validated. 5 are INCONCLUSIVE (point
  estimate below 0, CI covering 0), 13 are REJECTED.
- The kitchen-sink ridge and the shallow GBM do not validate either.
- 13 football narratives were tested. None survives out of sample.
- Clusters, the variance model, a similar-matchup display threshold and faster post-change weighting
  are all rejected.

What does validate:

- **The style layer**, as description: behavior metrics with split-half reliability 0.80-0.89.
- **The opponent-response play-selection model**, on dev and on the holdout for PROE and tempo. It
  predicts HOW a game will be played better than a team's own tendency. It does not predict the margin
  beyond V2.1.
- **Scheme persistence tracks the coordinator and the head coach** (METHODS §2.4-2.5).

## 1. Headline: incremental value, with and without the matchup engine

Deltas are *general+matchup − general*, so a negative number is better. Brackets are paired
game-bootstrap 95% CIs (2,000 resamples, seed 20260927).

| model | n | MAE general | MAE +matchup | ΔMAE [95% CI] | ΔRMSE | Δlog loss [95% CI] | ΔBrier | seasons better | status |
|---|---|---|---|---|---|---|---|---|---|
| **DEV production (NO_ADJUSTMENT)** | 5954 | 12.799 | 12.799 | 0 (by construction) | 0 | 0 | 0 | — | frozen |
| DEV all-families ridge (walk-forward, λ-shrunk) | 5954 | 12.799 | 12.795 | −0.0045 [−0.0221, +0.0134] | −0.0051 | −0.00023 [−0.0010, +0.0005] | −0.00010 | 5/8 | INCONCLUSIVE |
| DEV all-families shallow GBM (walk-forward, λ-shrunk) | 5954 | 12.799 | 12.800 | +0.0012 [−0.0035, +0.0059] | +0.0002 | −0.00007 [−0.0003, +0.0002] | −0.00006 | 2/8 | REJECTED |
| **HOLDOUT production artifact (NO_ADJUSTMENT)** | 1607 | 12.323 | 12.323 | +0.0000 [+0.0000, +0.0000] | 0 | 0 | 0 | 0/2 | frozen |
| HOLDOUT challenger ridge, frozen on dev, λ = 0.377 | 1607 | 12.323 | 12.311 | −0.0123 [−0.0320, +0.0068] | −0.0062 | +0.00029 [−0.0006, +0.0012] | +0.00016 | 1/2 | not promoted |
| HOLDOUT challenger ridge, unshrunk | 1607 | 12.323 | 12.311 | −0.0122 [−0.0642, +0.0374] | +0.0093 | +0.00150 [−0.0008, +0.0038] | +0.00070 | 1/2 | not promoted |
| LIVE 2026 played so far (production) | 208 | 11.607 | 11.607 | 0 | 0 | 0 | 0 | — | frozen |

Reading:

- **On dev, the best any correction does is −0.005 MAE, with a CI from −0.022 to +0.013.** That is
  0.04% of V2.1's error, and it is not distinguishable from zero.
- **On the holdout, the frozen shrunk challenger gains 0.012 MAE, but its CI covers zero.** It helped
  2025 (−0.029) but not 2024 (+0.004), and log loss and Brier are slightly *worse*. It is not promoted.
  The pre-registered rule is judged on dev, and even the holdout alone would fail condition 1. It is
  recorded as the **shadow correction** on every live game, so the Model Lab accumulates prospective
  evidence for it.
- **The unshrunk correction is worse than the shrunk one on every probability metric.** Without
  shrinkage the engine produces "3+ point" corrections on 7.7% of games (max 8.4 points). The
  residual moves by only a third of them (§4).

**Power.** The residual SD is 16.2 points and n = 5,954, so the standard error of one feature's
coefficient is about 0.21 points per SD. The minimum effect detectable with 80% power is about **0.6
points per SD** of a matchup feature. An effect that size would change RMSE by about 0.01, and nothing
in the table reaches it. **Matchup effects in this data, if they exist, are smaller than the
resolution of eight seasons of FBS football.**

## 2. Family ablation: add-one to the empty correction (brief 55)

Each family is fitted **alone** as a walk-forward ridge correction to V2.1, λ-shrunk and capped. The
decision is the pre-registered rule on dev.

| family | features | ΔMAE [95% CI] | ΔRMSE | Δlog loss | seasons better (of 8) | unshrunk ΔMAE | decision |
|---|---|---|---|---|---|---|---|
| pass_rush (7, 8) | `xm_epa_pass`, `xm_epa_rush`, `mix_exploit`, `rel_align` | +0.0014 [−0.0032, +0.0060] | +0.0015 | −0.00010 | 2 | +0.0049 | REJECTED |
| protection (9) | `xm_sack`, `hinge_sack`, `xm_havoc` | +0.0002 [−0.0007, +0.0010] | −0.0000 | +0.00002 | 0 | +0.0016 | REJECTED |
| qb_mobility (10) | `qbr_contain`, `qbr_vs_rush`, `edge_qb_rush_epa` | +0.0051 [−0.0001, +0.0101] | +0.0054 | +0.00000 | 0 | +0.0057 | REJECTED |
| explosive (11, 12) | `xm_expl_pass`, `xm_expl_rush`, `hinge_expl_pass` | −0.0045 [−0.0166, +0.0078] | −0.0013 | +0.00001 | 4 | −0.0039 | INCONCLUSIVE |
| trench (13) | `xm_line_yds`, `xm_stuff`, `hinge_stuff` | +0.0013 [−0.0043, +0.0070] | +0.0019 | −0.00001 | 3 | +0.0014 | REJECTED |
| early_down (14) | `edge_epa_early`, `xm_epa_early` | −0.0018 [−0.0173, +0.0135] | −0.0054 | −0.00017 | 4 | −0.0013 | INCONCLUSIVE |
| passing_down (15) | `edge_epa_pd`, `xm_sr_pd`, `pd_burden` | +0.0008 [−0.0063, +0.0078] | +0.0039 | −0.00003 | 4 | +0.0013 | REJECTED |
| finishing (16, 31) | `edge_pts_per_opp_v`, `edge_so_rate_v`, `xm_pts_per_opp` | +0.0044 [−0.0055, +0.0141] | +0.0017 | −0.00002 | 2 | +0.0062 | REJECTED |
| pace (17, 28, 29) | `poss_x_strength`, `tempo_edge` | +0.0015 [−0.0034, +0.0063] | −0.0002 | −0.00005 | 2 | +0.0009 | REJECTED |
| field_pos (32) | `edge_start_fp_v`, `xm_start_fp` | +0.0025 [−0.0012, +0.0064] | +0.0013 | −0.00002 | 1 | +0.0060 | REJECTED |
| fourth_down (30) | `edge_go_oe`, `go_x_sy` | +0.0021 [−0.0023, +0.0066] | +0.0043 | +0.00000 | 0 | +0.0019 | REJECTED |
| short_yardage (33) | `edge_sy_conv`, `xm_sy_conv` | 0 (λ = 0 every season) | 0 | 0 | 0 | +0.0043 | REJECTED |
| play_select (40-42) | `resp_corr`, `proe_resp_corr` | +0.0018 [−0.0001, +0.0037] | +0.0021 | +0.00004 | 0 | +0.0011 | REJECTED |
| drive_model (22, 43) | `drive_div` | +0.0059 [+0.0000, +0.0116] | +0.0034 | +0.00008 | 3 | +0.0060 | REJECTED |
| personnel (26, 27) | `inexp_x_rush`, `qbchg_x_havoc`, `inexp_x_pd_burden` | −0.0004 [−0.0034, +0.0025] | −0.0004 | +0.00005 | 2 | −0.0003 | INCONCLUSIVE |
| environment (34-36) | `alt_x_tempo`, `tz_x_tempo`, `home_x_sack`, `home_x_tempo` | +0.0056 [+0.0020, +0.0091] | +0.0051 | −0.00000 | 1 | +0.0031 | REJECTED |
| similar_opp (16-18) | `sim_resid_edge`, `sim_margin_edge`, `fam_edge` | −0.0029 [−0.0146, +0.0084] | +0.0004 | +0.00020 | 4 | −0.0026 | INCONCLUSIVE |
| v2_existing (56) | V2.1's own 15 `match_*` / `x_*` inputs | 0 (λ = 0) | 0 | 0 | 0 | **+0.0103** | REJECTED |

What the table shows:

- **Five families have a negative point estimate**: explosive, early-down, personnel, similar-opponent,
  and (in the kitchen sink) everything together. All five have CIs spanning zero, and none improves
  more than half of the dev seasons.
- **Environment (altitude / travel / crowd × style) and V2's own drive model make V2.1 significantly
  *worse*.** Their CI lies entirely above 0.
- **The shrinkage works as designed.** Where a family's out-of-fold corrections did not move the
  residual, λ goes to 0 and the correction disappears: short yardage, and V2.1's own matchup
  features. Unshrunk, re-learning V2.1's own inputs costs +0.010.
- **Control.** A "recalibration" correction on `ens_pred` alone gets λ = 0 in every season. V2.1's
  slope is not miscalibrated, so no gain above could be a disguised recalibration.

**Drop-one from the all-families ridge** (dev, ΔMAE when the family is removed; + means the family
helped the kitchen sink):

| family | drop-one ΔMAE |
|---|---|
| early_down | +0.0068 |
| explosive | +0.0035 |
| pace | +0.0026 |
| similar_opp | +0.0026 |
| field_pos | +0.0024 |
| finishing | +0.0020 |
| short_yardage | +0.0013 |
| protection | +0.0007 |
| personnel | +0.0006 |
| passing_down | +0.0004 |
| trench | +0.0003 |
| pass_rush | −0.0005 |
| play_select | −0.0006 |
| fourth_down | −0.0007 |
| qb_mobility | −0.0027 |
| drive_model | −0.0027 |
| environment | −0.0028 |

All contributions are under 0.01 point. The ordering is consistent with the add-one table: early-down
and explosive carry what little there is. Nothing is large enough to test separately with this sample.

## 3. Interpretable vs nonlinear (brief 57-58), and penalty sensitivity

| model | dev ΔMAE [95% CI] | unshrunk dev ΔMAE | mean \|adj\| (raw) | p99 \|adj\| (raw) | share ≥ 3 points (raw) |
|---|---|---|---|---|---|
| ridge, all families | −0.0045 [−0.0221, +0.0134] | +0.0131 | 1.25 | 5.32 | 7.7% |
| shallow GBM, all families | +0.0012 [−0.0035, +0.0059] | +0.0082 | 0.78 | 2.54 | 0.2% |

**The nonlinear challenger is worse than the linear one.** Its λ is 0 until 2019 and at most 0.38
after. There is no nonlinear structure to find. **The conclusion does not depend on the ridge
penalty**:

| α | dev ΔMAE (shrunk) | dev ΔMAE (unshrunk) | seasons better |
|---|---|---|---|
| 256 | −0.0046 | +0.0328 | 5 |
| 1024 (declared) | −0.0045 | +0.0131 | 5 |
| 4096 | −0.0042 | −0.0026 | 5 |
| 16384 | −0.0034 | −0.0034 | 5 |

## 4. Does the residual move the way the correction says? (brief 54)

These are dev games with |correction| ≥ 0.5, for the raw (unshrunk) all-families ridge.

| model | direction agreement [95% CI] | magnitude slope [95% CI] |
|---|---|---|
| dev ridge, unshrunk (n = 4,111) | 50.7% [49.2%, 52.3%] | 0.35 [0.06, 0.64] |
| dev GBM, unshrunk (n = 3,435) | 50.7% [49.1%, 52.4%] | 0.32 [−0.12, 0.76] |
| holdout ridge frozen, unshrunk (n = 994) | 52.3% [49.3%, 55.3%] | 0.40 [−0.32, 1.11] |

- **The sign of a correction is a coin flip.**
- **The magnitude slope says the residual moves by about a third of the predicted amount.** On dev the
  CI just excludes zero. So the kitchen sink holds a trace of real signal, overstated about three times,
  which is exactly what λ ≈ 0.35-0.45 removes.
- After shrinkage there is nothing left that clears the rule.

## 5. Matchup-adjustment buckets (brief 53)

**All-families ridge, λ-shrunk (dev):**

| \|adj\| | n | MAE general | MAE +matchup | improvement | bias general | bias +matchup |
|---|---|---|---|---|---|---|
| <0.5 | 3415 | 12.837 | 12.839 | −0.002 | +0.43 | +0.43 |
| 0.5-1 | 1692 | 12.756 | 12.753 | +0.003 | +0.17 | +0.16 |
| 1-2 | 774 | 12.798 | 12.759 | +0.039 | −0.08 | −0.05 |
| 2-3 | 68 | 12.005 | 12.170 | −0.165 | −0.09 | −0.24 |
| 3+ (capped) | 5 | 12.341 | 10.541 | +1.800 | −6.11 | −7.91 |

**Unshrunk (dev), showing what the engine would do without statistical shrinkage:**

| \|adj\| | n | MAE general | MAE +matchup | improvement | bias general | bias +matchup |
|---|---|---|---|---|---|---|
| <0.5 | 1843 | 12.731 | 12.728 | +0.002 | +0.48 | +0.48 |
| 0.5-1 | 1527 | 13.020 | 13.024 | −0.003 | +0.53 | +0.53 |
| 1-2 | 1731 | 12.737 | 12.776 | −0.039 | −0.08 | −0.04 |
| 2-3 | 622 | 12.717 | 12.680 | +0.037 | +0.41 | +0.39 |
| 3+ | 231 | 12.567 | 12.707 | **−0.139** | −0.71 | −1.01 |

**Holdout, frozen challenger, unshrunk:**

| \|adj\| | n | MAE general | MAE +matchup | improvement |
|---|---|---|---|---|
| <0.5 | 613 | 12.219 | 12.223 | −0.004 |
| 0.5-1 | 445 | 12.248 | 12.237 | +0.011 |
| 1-2 | 438 | 12.174 | 12.223 | −0.049 |
| 2-3 | 96 | 14.062 | 13.916 | +0.146 |
| 3+ | 15 | 12.046 | 10.397 | +1.648 |

The 3+ bucket is where the brief warns things go wrong, and on dev it does perform worst: −0.14 over
231 games. The 3+ buckets that look good (5 dev games shrunk, 15 holdout games) are far too small to
mean anything. They are exactly the "few spectacular upsets" the promotion standard (71) says to
ignore. **The shrink-harder response is already in place: λ and the cap.**

## 6. Subgroups (brief 52)

| subgroup (dev) | n | ΔMAE, ridge λ-shrunk | ΔMAE, ridge unshrunk |
|---|---|---|---|
| early season (weeks_in < 5) | 1916 | +0.008 | +0.037 |
| late season | 4038 | −0.011 | +0.002 |
| P4 vs P4 | 2659 | −0.009 | +0.014 |
| G5 vs G5 | 2507 | +0.001 | +0.013 |
| P4 vs G5 | 788 | −0.006 | +0.010 |
| both OCs retained | 2023 | +0.001 | +0.023 |
| an OC changed | 3924 | −0.008 | +0.008 |
| close V2.1 line (\|pred\| < 7) | 2313 | −0.006 | +0.012 |
| big favourite (\|pred\| ≥ 14) | 1860 | −0.024 | −0.019 |
| postseason | 308 | −0.018 | −0.026 |
| high \|adjustment\| (≥ 1) | 847 / 2584 | −0.033 | +0.030 |

No subgroup shows a consistent gain across both versions. The early season, when style estimates are
mostly prior, is where the unshrunk engine hurts most (+0.037). That is the brief's "do not pretend
Week 1 reveals full scheme identity", measured.

## 7. Football narratives (brief 68)

Each narrative's single feature is oriented so that the narrative predicts a **positive** coefficient.
Two numbers are reported:

- the **pooled dev coefficient**, in points per SD over 2014-2023. It is in-sample and descriptive.
- the **walk-forward validation**, under the pre-registered rule.

| narrative | feature | pooled coef [95% CI] | walk-forward ΔMAE [95% CI] | verdict |
|---|---|---|---|---|
| mobile QBs hurt aggressive (pass-rushing) defenses | `qbr_vs_rush` | +0.16 [−0.22, +0.55] | +0.0046 [−0.0008, +0.0099] | NO OUT-OF-SAMPLE VALUE |
| pressure destroys inexperienced QBs | `inexp_x_rush` | +0.26 [−0.18, +0.70] | +0.0009 [−0.0003, +0.0022] | NO OUT-OF-SAMPLE VALUE |
| bad OL cannot survive elite havoc | `hinge_sack` | +0.12 [−0.30, +0.55] | +0.0021 [+0.0001, +0.0040] | NO OUT-OF-SAMPLE VALUE (hurts) |
| explosive offenses punish weak secondaries | `hinge_expl_pass` | −0.02 [−0.48, +0.49] | −0.0001 [−0.0051, +0.0051] | NO OUT-OF-SAMPLE VALUE |
| run teams shorten games / slow games help the underdog | `poss_x_strength` | **+0.56 [+0.19, +0.96]** | −0.0015 [−0.0116, +0.0086] | IN-SAMPLE ONLY |
| teams struggle against unfamiliar schemes | `fam_edge` | **−0.44 [−0.84, −0.05]** | −0.0011 [−0.0110, +0.0094] | IN-SAMPLE OPPOSITE SIGN; no out-of-sample value |
| a backup QB against a high-havoc defense | `qbchg_x_havoc` | +0.26 [−0.12, +0.65] | +0.0016 [−0.0032, +0.0061] | NO OUT-OF-SAMPLE VALUE |
| a low-experience QB with a heavy passing-down burden underperforms | `inexp_x_pd_burden` | **+0.53 [+0.05, +1.02]** | −0.0018 [−0.0055, +0.0018] | IN-SAMPLE ONLY |
| offenses that attack the defense's weaker phase gain beyond strength | `mix_exploit` | +0.03 [−0.33, +0.42] | −0.0002 [−0.0038, +0.0033] | NO OUT-OF-SAMPLE VALUE |
| strong finishing offense vs poor finishing defense | `xm_pts_per_opp` | +0.28 [−0.09, +0.66] | +0.0025 [−0.0065, +0.0124] | NO OUT-OF-SAMPLE VALUE |
| fast-tempo teams wilt at altitude | `alt_x_tempo` | +0.39 [−0.02, +0.81] | −0.0004 [−0.0057, +0.0048] | NO OUT-OF-SAMPLE VALUE |
| crowd noise hurts sack-prone visiting offenses | `home_x_sack` | −0.03 [−0.40, +0.32] | 0 (λ = 0) | NO OUT-OF-SAMPLE VALUE |
| the faster team wins the pace mismatch | `tempo_edge` | −0.09 [−0.45, +0.28] | +0.0047 [+0.0015, +0.0081] | NO OUT-OF-SAMPLE VALUE (hurts) |

**Two narratives leave an in-sample trace in the predicted direction.** Neither survives
walk-forward:

- **Slow games compress margins**: +0.56 points per SD of possessions × strength.
- **An inexperienced QB with a heavy passing-down burden underperforms**: +0.53.

They go to the research queue with the 2026+ data. The "unfamiliar scheme" narrative has the opposite
in-sample sign, and it has no out-of-sample value either way.

## 8. Redundancy: how much V2.1 already knows (brief 56)

This is the max |corr| of each new feature with any V2.1 model input on dev. The full table, including
corr with the residual, is in `backtest_dev.json`.

| feature | max \|corr\| with a V2.1 input | corr with V2.1 margin | corr with V2.1 residual |
|---|---|---|---|
| `edge_pts_per_opp_v` | 0.91 (`edge_rec_ppd`) | +0.89 | −0.005 |
| `edge_epa_early` | 0.90 (`edge_rec_ppd`) | +0.90 | +0.014 |
| `edge_so_rate_v` | 0.89 (`edge_epa`) | +0.87 | −0.001 |
| `edge_epa_pd` | 0.80 (`edge_rec_epa`) | +0.79 | +0.009 |
| `edge_start_fp_v` | 0.79 (`edge_prior_ppd`) | +0.76 | +0.004 |
| `xm_epa_rush` | 0.53 (`x_rush_h`) | +0.07 | +0.016 |
| `mix_exploit` | 0.21 (`match_mix_edge`) | +0.16 | +0.007 |
| `sim_resid_edge` | 0.06 | +0.04 | +0.005 |
| `poss_x_strength` | 0.05 | −0.02 | +0.033 |

- **Every additive "edge" the matchup engine could offer is already 0.8-0.9 correlated with V2.1's
  adjusted-efficiency and recent-form inputs.**
- The genuinely new, non-additive interactions (products, hinges, similarity) are nearly uncorrelated
  with V2.1 (|corr| 0.05-0.5). But they are also uncorrelated with its residual (|corr| ≤ 0.04).
- So adjusted EPA already contains the matchup information that exists, and the rest is noise at this
  sample size. This confirms the earlier V2 red-team result: "matchup interactions: RETEST", dev
  ΔMAE 0.007 [−0.007, 0.020].

## 9. Matchup uncertainty, play selection, possessions, clusters

**Variance model (37): REJECTED.** Log-likelihood gain per game is +0.0001 [−0.0011, +0.0013]
(n = 3,646, dev 2017-2023). Coverage of the 80% intervals goes 0.808 → 0.807. The multiplier ranges
0.96-1.04 (p5-p95). Stylistic volatility (two explosive teams, pace, turnover-prone, QB-run threats,
mixed signals) does not measurably change the spread of outcomes beyond V2.1's sigma. So the matchup
variance effect is 1.0.

**Expected play selection (21, 40-41): VALIDATED as a description of how a game will be played.** This
is the weighted MAE of each team's actual game value:

| target | window | own tendency | + opponent response | + game script | Δ(response) 95% CI |
|---|---|---|---|---|---|
| neutral pass rate | dev (12,182 team-games) | 0.0854 | **0.0846** | 0.0846 | [−0.0013, −0.0004] |
| neutral pass rate | holdout (3,336) | 0.0819 | 0.0822 | 0.0822 | [−0.0004, +0.0010] |
| PROE | dev (13,221) | 0.0715 | **0.0709** | 0.0709 | [−0.0009, −0.0004] |
| PROE | holdout (3,648) | 0.0684 | **0.0677** | 0.0677 | [−0.0013, −0.0002] |
| tempo (sec/snap) | dev (12,148) | 2.589 | **2.523** | 2.521 | [−0.080, −0.053] |
| tempo (sec/snap) | holdout (3,336) | 2.584 | **2.533** | 2.536 | [−0.072, −0.028] |

- **A defense changes what offenses do**, and the joint model's opponent-response rating predicts it.
  PROE and tempo improve on dev and on the holdout; the raw neutral pass rate improves on dev only.
- Game script from V2.1's margin adds nothing, because PROE is already conditioned on the score.
- These are what the hook reports as EXPECTED PASS/RUSH BEHAVIOR and expected tempo. Knowing *how*
  the game will be played does not, however, change the margin beyond V2.1 (the play_select family,
  §2).

**Expected possessions (28).** V2's additive drives model has an MAE of 2.78 total drives (bias +0.14,
n = 6,612 dev games). Adding both teams' neutral tempo: 2.75. That is a small gain, and it does not
move the margin (the pace family, §2).

**Clustering (21-23): DISCARD.** k was chosen by the BIC of a Gaussian mixture on dev team-season
finals: 3 offensive and 2 defensive archetypes. The clusters were named only after their measured
profiles:

| offense cluster | team-seasons | profile (z) | closest examples |
|---|---|---|---|
| 0 | 48 | PROE −3.2, QB rush share +3.5, tempo +1.7 (slow), go +0.9 | New Mexico 2014, Georgia Southern 2015, Georgia Tech 2017, Navy 2020 (option offenses) |
| 1 | 611 | PROE +0.7, tempo −0.5 (fast), QB rush −0.5 | Notre Dame 2021, North Texas 2017, SMU 2020 (pass-leaning, up-tempo) |
| 2 | 636 | PROE −0.45, tempo +0.4, QB rush +0.2 | South Florida 2019, James Madison 2022, Louisiana 2023 (run-leaning, balanced) |

The two defensive clusters are simply better and worse defenses (early-down and passing-down EPA ±0.7
SD): "defensive style" in this data is mostly quality. The cluster-pair indicators are fitted
walk-forward with centroids refit on seasons before S. They give ΔMAE +0.0013 [−0.0071, +0.0099], 2/8
seasons: REJECTED. The continuous features already carry everything the clusters describe.

## 10. Similar matchups (16-18, 51)

- **Similar-opponent residual**: −0.0029 [−0.0146, +0.0084], INCONCLUSIVE (§2).
- **Display threshold.** Does the most similar past comparison's residual correlate with the team's
  residual in the upcoming game, by similarity bin (dev)?

| similarity | n | corr [95% CI] |
|---|---|---|
| 0.0-0.4 | 11,515 | +0.010 [−0.009, +0.028] |
| 0.4-0.5 | 238 | −0.05 [−0.18, +0.07] |
| 0.5-0.6 | 53 | −0.15 [−0.40, +0.08] |
| 0.8-1.0 | 82 | −0.07 [−0.31, +0.17] |

**No validated threshold.** Similar matchups are stored as algorithmic descriptions
(`display_allowed = false`) with similarity, differences and the historical residual. The product must
never present them as evidence about the upcoming result.

## 11. Scheme change detection (25, 39, 63)

Events on dev 2016-2023, at thresholds calibrated to 5% false alarms per team-season-metric:

| event | count |
|---|---|
| QB_USAGE_SHIFT | 107 |
| RUN_PASS_SHIFT | 88 |
| PACE_REGIME_CHANGE | 75 |
| PRESSURE_SHIFT | 52 |
| total | 322, about 40 per season |

The null expectation is about 26 per season (≈130 teams × 4 metrics × 5%), so **roughly one event in
three is a real change and two in three are the permitted false alarms**.

**Does weighting the post-change games more predict the next 3 games better?** No:

| metric | events | Δ MAE (recent-weighted − season mean) [95% CI] |
|---|---|---|
| PROE | 73 | +0.0027 [−0.0054, +0.0101] |
| QB rush share | 93 | −0.0067 [−0.0153, +0.0017] |
| tempo | 66 | +0.09 [−0.22, +0.38] s |
| sack generation | 47 | **+0.0109 [+0.0039, +0.0176]** (worse) |
| pooled, in SD units | 693 obs | +0.025 [−0.011, +0.063] |

**Events are flags that raise uncertainty. They must not trigger faster re-weighting.** The season
mean (with V2's joint shrinkage) already absorbs real changes as fast as the evidence allows. QB
usage is the only borderline case, and it is the one the personnel layer's QB-change events already
cover.

## 12. Missed matchups (67)

There are 1,143 dev games with |residual| ≥ 21. For each of the 45 matchup features, is its value,
aligned to the miss's direction, different in the misses than in the other games? The smallest raw p
is 0.009, which is not significant after Bonferroni (×45). **Verdict: ordinary variance; no
overlooked measurable matchup feature.** No research item is created automatically.

## 13. Holdout (scored once)

- The artifact `cfb_matchup_resid_v1` (NO_ADJUSTMENT, sha256 `4a5fcca7…c62363`) was frozen at 15:50:08
  UTC. The holdout was scored at 15:50:23 with that artifact (the hash is recorded in `holdout.json`).
- `backtest.holdout()` refuses a second scoring.
- The production result is exactly 0 on every metric (§1). The frozen challengers are reported in §1,
  §4 and §5. The play-selection holdout is in §9.
- No choice was made after the holdout was seen. The similar-feature code fix made after scoring
  (defaults for non-contiguous season lists, and the hook's history window) is proven not to change
  any stored feature: max |diff| = 0.0 on 2019 and 2025 recomputed with the fixed code.
