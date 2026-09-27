# Patch `edgedesk_cfb_v2.1.2`: fix for audit finding F-21

- **Parent:** `edgedesk_cfb_v2.1.1` (itself a challenger). Production is still `edgedesk_cfb_v2.1.0`, and it is unchanged.
- **What the patch is:**
  - one corrected stage-3 variance rule;
  - the same code recipe, the same hyper-parameters, seeds, feature list and stacking procedure as v2.1.1;
  - trained through 2025, with feature schema `cfb_v2_fv2`.
- **Artifact:** `football/cfb_v2/artifacts/edgedesk_cfb_v2.1.2/`, written by `export.py`'s normal path. Its MANIFEST (sha256 `38a0d952…`) records:
  - parent v2.1.1;
  - the bug fixed;
  - the recipe;
  - the data diff;
  - status `CHALLENGER_NOT_PROMOTED`.
- **Build:** `football/cfb_v2/research/out_p2` (git-ignored). The parent build `out_p` and the v2.1.0 build `out_h` were only read.
- **Evidence:**
  - every number below comes from `python3 -m v2.audit.patch_v212`, written to `out_p2/audit/patch_v212.json`;
  - the tests are listed in §6.
- **Audit:** [FINDINGS.md](FINDINGS.md), F-21.
- **Status:** a CHALLENGER that has **not** been switched in.
  - `config.py`, `market.py`, `engine.js`, `params.js`, the compatibility matrix, governance, and the v2.1.0 and v2.1.1 artifacts were left alone.
  - §9 lists exactly what a switch would change.
  - The orchestrator and the owner decide.

## 0. Summary

| | v2.1.1 (parent) | v2.1.2 |
|---|---|---|
| FBS rating-sides pinned to the preseason prior | 9: `expl_pass`, `fg_value`, `st_net`, `to_rate` on both sides, and `sack_rate` defence (the audit counted 4 metrics) | **0** |
| Audit reproduction `core_prior_pinned_metrics` | 4 metrics in every season 2015–2026 | empty in every season |
| Stage-3 outputs outside those 5 metrics | — | identical, bit for bit |
| Model inputs that changed | — | `edge_expl_pass` (C, D), `edge_fg_value`, `edge_st_net` (D), `to_dependence` (sigma): exactly the audit's list |
| Dev MAE 2016–23 (n 5,954) | 12.7991 | 12.7978 (−0.0013 [−0.0054, +0.0030]) |
| Holdout MAE, true finals (n 1,606; inspected, F-29) | 12.3297 | 12.3277 (−0.0020 [−0.0070, +0.0030]) |
| Holdout Brier | 0.18286 | 0.18289 (+0.00004 [−0.00005, +0.00013]) |
| Holdout V2 − opener / V2 − close | +0.273 / +0.386 | +0.271 / +0.384 |
| Holdout CLV (every game) | 0.357 | 0.340 (−0.017 [−0.035, −0.001]) |
| Holdout ATS at the opener / at the close | 50.98% / 49.97% | 51.17% / 50.16% |
| Live 2026 MAE, all 215 true finals | 12.157 | 12.155 (−0.001 [−0.016, +0.014]) |
| Promotion gates G1–G7 | all pass | all pass |
| Dev-selected market rule (BET disabled in both) | review 14 / gap 3 / EV 0.06 / min rel 0 (p 0.108) | review 14 / gap 0 / EV 0 / min rel 65 (p 0.148) |
| Decision calibration `w_model` (frozen procedure, recompute only) | 0.220978 | 0.221573 [0.066, 0.377] |
| Policy v1 holdout (frozen policy) | LEAN 206 / PASS 1,258 / RESEARCH 136 / 0 bets | LEAN 209 / PASS 1,253 / RESEARCH 138 / 0 bets |

**The fix works.** The nine sides now move in-season, and no posterior variance sits at a floor.

**It changes almost nothing measurable.**
- Every accuracy, calibration and market difference is inside noise. The one CI that excludes zero is holdout CLV, −0.017 points; it is small, and it comes from an inspected holdout.
- Under the recipe's own prior-variance rule (`tau2 ≥ 0.15 · tv`), the fixed ratings take only a few per cent of the in-season evidence (§1.6). `edge_expl_pass` still correlates 0.96 with `edge_prior_sr` (0.964 before).

**Recommendation.** If the owner switches production off v2.1.0, switch to **v2.1.2 rather than v2.1.1**, using the same four coupled changes (§9). v2.1.2 is v2.1.1 plus a correctness fix, with statistically indistinguishable accuracy. Nothing is urgent. See §10.

---

## 1. The declared rule

This section was written and committed **before any outcome metric of the patched build was computed**. That means no margin, MAE, Brier, market or decision result. Its evidence reads only stage-3 variances and priors (`python3 -m v2.audit.patch_v212 --sections R,M`, which reads no game result).

### 1.1 The bug (F-21)

In stage 3 (`football/cfb_v2/research/v2/build_ratings.py`), each metric has a between-team variance `tv` of the true rating, estimated once from the burn-in seasons 2009–2011:

```
tv = max(1e-8, mean over 2009-2011 of [ Var_FBS(season-end data-only rating) − mean posterior variance ])
```

`build_prior` then sets the FBS prior variance to:

```
tau2 = max(weighted prior-model residual variance − weighted target posterior variance, 0.15 · tv) × prior_scale
```

It sets the home-effect prior variance to `max(tv_off, tv_def)`.

When the moment is ≤ 0, `tv` becomes 1e-8, both moments are negative, and `tau2` falls to 1.5e-9 × prior_scale. The prior then has effectively infinite precision: the posterior never leaves it, and the home effect is pinned at 0.

**Five metric-sides are pinned, not the four the audit listed:**
- `expl_pass`, `fg_value`, `st_net` and `to_rate` on both sides;
- **the defence side of `sack_rate`**, whose prior variance is 1.2e-8 (1.5e-9 × its scale of 8).

The audit's reproduction (`phase2.prior_pinned`) reads only the offence columns, so it could not see the fifth.

### 1.2 Why the moment is negative: the noise term, not the signal

**Nine sides fall back (the table in §1.6).** For each of them, the season-end ratings of FBS teams vary **less** than the model's own posterior variance says their estimation noise is. Example: `expl_pass` offence has an observed variance of 3.9e-4 against a mean posterior variance of 6.1e-4.

**That cannot happen if the noise model is right.** A noisy estimate of a quantity varies at least as much as its noise, apart from mild shrinkage. So the posterior variance, meaning the noise model, is overstated for these metrics:

| metric | modelled `s2p` (per play) | binomial p(1 − p) | ratio |
|---|---|---|---|
| `expl_pass` | 0.190 | 0.078 (p = 0.085) | 2.4 |
| `sack_rate` | 0.137 | 0.057 (p = 0.060) | 2.4 |
| `to_rate` | 0.032 | 0.024 (p = 0.024) | 1.4 |

- The ratios come from `estimate_varcomp`'s regression of residual² on 1/n, with `s2g` hitting its 1e-6 floor.
- For the zero-sum game metrics `st_net` and `fg_value`, `s2g` is doubled because "both rows of a zero-sum game are the same observation". That is right for the offence-minus-defence combination the edge uses, but it doubles the noise attributed to **each side on its own**.

**A noise-model-free estimate shows the signal is real.** The **split-half covariance** takes, per burn-in season, the covariance across FBS teams of the data-only ratings fitted separately on odd-numbered and even-numbered weeks. The two halves share no game, so their errors are independent, and the covariance estimates the between-team variance without using the noise model.
- It is positive for all nine sides, at 2.0 to 5.2 standard errors: `to_rate` offence 2.0 and `fg_value` 2.1–2.2 are the weakest, `expl_pass` offence 5.2 the strongest.
- The reliability it implies (the share of the observed spread that is persistent team signal) is 0.17–0.41.
- Where the noise model is close to binomial, it agrees with the moment: for example `sr_rush` 1.36e-3 vs 1.35e-3, `plays_pg` 13.3 vs 13.7, `line_yds` 0.063 vs 0.059, and `pass_rate` offence 7.7e-3 vs 8.0e-3.

**Pooling more seasons cannot fix it.** The same moment is negative in every completed season 2009–2025 for `expl_pass` (both sides, 16 of 16 seasons with data), `fg_value` (both, 17 of 17), `to_rate` defence (17 of 17) and `sack_rate` defence (16 of 16), and in 16 of 17 for `st_net` and `to_rate` offence. A pooled or REML estimate built on the same noise model sits on the zero boundary, which is the same pin.

### 1.3 The rule: `cfb_v2_between_var_v2`

For each metric and side, `tv` is:

1. **the burn-in moment, wherever it is positive.** This is unchanged, so every other metric-side is bit-identical to v2.1.1.
2. **Otherwise, the split-half covariance**, averaged over the **same** burn-in seasons (2009–2011). Each half is fitted with the data-only fit's own weak prior and the same variance components. The split is the stage-2 week number's parity; bowls carry week 1.
3. **If that is also ≤ 0, the build refuses** (`SystemExit`, naming the metric). "No measurable team signal" becomes an explicit decision for a person, never a silent pin. On the current data this branch is not reached.

**Nothing downstream changes:**
- `tau2 = max(moment, 0.15·tv) × prior_scale`, the home-effect prior `max(tv_off, tv_def)`, and the FCS prior `max(FCS variance, tv) × prior_scale` all use the same code;
- the prior scales are unchanged, and `config.py` is untouched;
- the data-only finals, the variance components, the prior means and the metric scales that standardise the edges (`snapshots.metric_scales` reads the data-only finals) are all unchanged.

### 1.4 Why this rule and not the alternatives

| option | verdict |
|---|---|
| Method of moments or REML pooled over more seasons | Negative in every season: it cannot un-pin. Seasons after 2011 would also be look-ahead for the 2012+ priors. |
| A declared fraction κ of the observed between-team variance | κ would be a new constant with nothing to learn it from; any value is arbitrary, and choosing one by accuracy would be tuning. The split-half covariance **estimates** that fraction from the burn-in data (0.17–0.41). |
| Treat "no persistent team signal" as the answer (keep the prior) | Contradicted by the data: the signal is 2.0–5.2 SE above zero. It is kept only as the refusal branch. |
| Re-estimate the noise model (`s2p`, `s2g`) for every metric | That would change all 28 metrics and every weight in stage 3. It is a model change, not a bug fix (§11, follow-up). |

**Properties of the chosen rule:**
- **Pre-season only.** It uses the same three burn-in seasons as the legacy rule, reads no game result beyond the play-by-play the ratings already use, and has no free parameter.
- **Minimal.** It changes `tv` only where the legacy value is the 1e-8 artefact.
- **Conservative.** The weak prior shrinks each half-season estimate slightly (about 6 games per half). That biases the covariance **down** by roughly 15–25%, toward the prior, never past the evidence.

### 1.5 What the rule deliberately does not change, and what follows from that

**Line 559's formula is unchanged.** Its moment still subtracts the same overstated noise, so for the nine sides it stays negative and `tau2 = 0.15 · tv · scale`.
- That is the existing declared floor. It already sets `tau2` in every season for `epa_pass` defence and for `ppd` on both sides in v2.1.1.
- The consequence, quantified in §1.6, is that the fixed ratings move in-season, but slowly. With a prior scale of 1.0, the season-end data weight is a few per cent for the four metrics. `sack_rate` defence, with a scale of 8, moves more.

**The prior scales are unchanged.** The scales of the four metrics (1.0) were chosen on a grid (0.25–8) that could not move a pinned metric, so they carry no information. Re-tuning them is out of scope (no retuning); it is a follow-up (§11).

### 1.6 Diagnostics, every metric and side

Burn-in seasons: 2009, 2010 and 2011 for every metric, so the number of seasons is 3. The observed variance, posterior variance and moment are the means over those seasons of the FBS teams' season-end data-only ratings; "pooled" is the same moment over every completed season 2009–2025 (a diagnostic only, not usable by the rule). "Split-half" is the covariance with its standard error in brackets. τ² is the FBS prior variance (× prior scale), the median over the FBS team-seasons 2012–2026. "At floor" is the share of those team-seasons whose τ² equals 0.15 · tv · scale. The rest are teams with no lagged rating, whose τ² comes from the missing-lag branch. **Bold** marks the nine sides the rule changes.

| metric | side | observed var | posterior var | moment | pooled moment (seasons > 0) | split-half [SE] | tv v2.1.1 → v2.1.2 | τ² v2.1.1 → v2.1.2 | at floor | scale |
|---|---|---|---|---|---|---|---|---|---|---|
| drive_epa | off | 0.389 | 0.191 | 0.198 | 0.247 (17/17) | 0.262 [0.0277] | 0.198 | 0.567 | 0.00 | 8 |
| drive_epa | def | 0.331 | 0.191 | 0.14 | 0.17 (17/17) | 0.206 [0.0219] | 0.14 | 0.259 | 0.19 | 8 |
| drives_pg | off | 0.531 | 0.268 | 0.263 | 0.327 (17/17) | 0.284 [0.0431] | 0.263 | 0.232 | 0.00 | 1 |
| drives_pg | def | 0.578 | 0.268 | 0.31 | 0.354 (17/17) | 0.292 [0.0465] | 0.31 | 0.272 | 0.00 | 1 |
| epa | off | 0.014 | 0.00637 | 0.00764 | 0.00873 (17/17) | 0.00965 [0.00099] | 0.00764 | 0.0154 | 0.00 | 4 |
| epa | def | 0.0118 | 0.00634 | 0.00544 | 0.00625 (16/17) | 0.00741 [0.000779] | 0.00544 | 0.00814 | 0.06 | 4 |
| epa_pass | off | 0.0264 | 0.0207 | 0.00573 | 0.00821 (16/16) | 0.0166 [0.00192] | 0.00573 | 0.00876 | 0.39 | 8 |
| epa_pass | def | 0.0216 | 0.0201 | 0.00152 | 0.00162 (12/16) | 0.0115 [0.00153] | 0.00152 | 0.00183 | 0.93 | 8 |
| epa_rush | off | 0.0129 | 0.0064 | 0.00651 | 0.00646 (16/16) | 0.00767 [0.000959] | 0.00651 | 0.00765 | 0.00 | 2 |
| epa_rush | def | 0.0111 | 0.00624 | 0.00484 | 0.00552 (16/16) | 0.00652 [0.000807] | 0.00484 | 0.00646 | 0.00 | 2 |
| expl | off | 0.000165 | 0.000109 | 5.58e−5 | 5.95e−5 (17/17) | 7.25e−5 [1.41e−5] | 5.58e−5 | 5.12e−5 | 0.00 | 1 |
| expl | def | 0.000172 | 0.000109 | 6.33e−5 | 6.24e−5 (17/17) | 7.5e−5 [1.39e−5] | 6.33e−5 | 4.25e−5 | 0.00 | 1 |
| **expl_pass** | off | 0.000389 | 0.000611 | −0.000222 | −0.000234 (0/16) | 0.000161 [3.07e−5] | **1e−8 → 0.000161** | **1.5e−9 → 2.42e−5** | 0.93 | 1 |
| **expl_pass** | def | 0.000327 | 0.000593 | −0.000266 | −0.0003 (0/16) | 9.03e−5 [2.66e−5] | **1e−8 → 9.03e−5** | **1.5e−9 → 1.35e−5** | 0.93 | 1 |
| expl_rush | off | 0.000282 | 0.000138 | 0.000143 | 0.000162 (16/16) | 0.000125 [2.26e−5] | 0.000143 | 0.000158 | 0.00 | 1 |
| expl_rush | def | 0.000241 | 0.000135 | 0.000106 | 0.000124 (16/16) | 9.43e−5 [2.1e−5] | 0.000106 | 0.000109 | 0.00 | 1 |
| **fg_value** | off | 0.423 | 0.673 | −0.251 | −0.286 (0/17) | 0.0811 [0.0384] | **1e−8 → 0.0811** | **1.5e−9 → 0.0122** | 1.00 | 1 |
| **fg_value** | def | 0.417 | 0.673 | −0.256 | −0.326 (0/17) | 0.081 [0.0376] | **1e−8 → 0.081** | **1.5e−9 → 0.0122** | 1.00 | 1 |
| havoc | off | 0.000382 | 0.000175 | 0.000207 | 0.00016 (16/16) | 0.000232 [2.97e−5] | 0.000207 | 0.000285 | 0.00 | 2 |
| havoc | def | 0.000291 | 0.000175 | 0.000116 | 0.00013 (16/16) | 0.000157 [2.13e−5] | 0.000116 | 0.000197 | 0.00 | 2 |
| line_yds | off | 0.106 | 0.0465 | 0.0591 | 0.0498 (16/16) | 0.0627 [0.00777] | 0.0591 | 0.0284 | 0.00 | 1 |
| line_yds | def | 0.111 | 0.0454 | 0.0656 | 0.0578 (16/16) | 0.0727 [0.00782] | 0.0656 | 0.0282 | 0.00 | 1 |
| opp_rate | off | 0.00177 | 0.000815 | 0.000953 | 0.00119 (16/16) | 0.000899 [0.000141] | 0.000953 | 0.000864 | 0.00 | 1 |
| opp_rate | def | 0.00198 | 0.000795 | 0.00119 | 0.0012 (16/16) | 0.00127 [0.000154] | 0.00119 | 0.000825 | 0.00 | 1 |
| pass_rate | off | 0.00884 | 0.000882 | 0.00796 | 0.0071 (16/16) | 0.00766 [0.000638] | 0.00796 | 0.00544 | 0.00 | 1 |
| pass_rate | def | 0.00182 | 0.000881 | 0.00094 | 0.000854 (16/16) | 0.00108 [0.000157] | 0.00094 | 0.000662 | 0.00 | 1 |
| plays_pg | off | 22.9 | 9.17 | 13.7 | 14.1 (17/17) | 13.3 [1.8] | 13.7 | 9.09 | 0.00 | 1 |
| plays_pg | def | 18.8 | 9.17 | 9.58 | 10.9 (17/17) | 9.82 [1.65] | 9.58 | 7.17 | 0.00 | 1 |
| ppd | off | 0.36 | 0.186 | 0.174 | 0.192 (17/17) | 0.261 [0.0244] | 0.174 | 0.209 | 0.66 | 8 |
| ppd | def | 0.344 | 0.186 | 0.158 | 0.158 (16/17) | 0.239 [0.0225] | 0.158 | 0.19 | 1.00 | 8 |
| pts_per_opp | off | 0.395 | 0.18 | 0.215 | 0.231 (17/17) | 0.224 [0.032] | 0.215 | 0.115 | 0.00 | 1 |
| pts_per_opp | def | 0.383 | 0.175 | 0.208 | 0.212 (17/17) | 0.191 [0.0306] | 0.208 | 0.104 | 0.00 | 1 |
| sack_rate | off | 0.000584 | 0.000451 | 0.000133 | 8.58e−5 (14/16) | 0.000347 [4.22e−5] | 0.000133 | 0.000468 | 0.00 | 8 |
| **sack_rate** | def | 0.000293 | 0.000438 | −0.000145 | −0.000134 (0/16) | 0.000102 [2.35e−5] | **1e−8 → 0.000102** | **1.2e−8 → 0.000122** | 0.93 | 8 |
| so_rate | off | 0.00704 | 0.00327 | 0.00378 | 0.00373 (17/17) | 0.0046 [0.00052] | 0.00378 | 0.00641 | 0.00 | 4 |
| so_rate | def | 0.00687 | 0.00327 | 0.00361 | 0.00303 (17/17) | 0.00461 [0.000481] | 0.00361 | 0.00327 | 0.00 | 4 |
| sr | off | 0.00203 | 0.000795 | 0.00124 | 0.00142 (17/17) | 0.00146 [0.000144] | 0.00124 | 0.00165 | 0.00 | 2 |
| sr | def | 0.00178 | 0.000792 | 0.00099 | 0.00108 (17/17) | 0.00119 [0.000123] | 0.00099 | 0.00119 | 0.00 | 2 |
| sr_3rd | off | 0.00263 | 0.00164 | 0.000989 | 0.00203 (17/17) | 0.00128 [0.000227] | 0.000989 | 0.00135 | 0.00 | 1 |
| sr_3rd | def | 0.00234 | 0.00165 | 0.000696 | 0.0017 (17/17) | 0.00101 [0.000191] | 0.000696 | 0.0011 | 0.00 | 1 |
| sr_early | off | 0.00209 | 0.000761 | 0.00133 | 0.00154 (17/17) | 0.00139 [0.000151] | 0.00133 | 0.00173 | 0.00 | 2 |
| sr_early | def | 0.00187 | 0.000756 | 0.00111 | 0.0012 (17/17) | 0.00118 [0.000133] | 0.00111 | 0.00149 | 0.00 | 2 |
| sr_pass | off | 0.00324 | 0.00117 | 0.00207 | 0.0022 (16/16) | 0.0023 [0.000248] | 0.00207 | 0.00284 | 0.00 | 2 |
| sr_pass | def | 0.00248 | 0.00114 | 0.00134 | 0.00129 (15/16) | 0.00148 [0.000186] | 0.00134 | 0.00133 | 0.00 | 2 |
| sr_pd | off | 0.00264 | 0.0016 | 0.00103 | 0.00119 (17/17) | 0.00145 [0.000214] | 0.00103 | 0.00134 | 0.00 | 2 |
| sr_pd | def | 0.00238 | 0.00161 | 0.000763 | 0.000605 (16/17) | 0.00121 [0.000191] | 0.000763 | 0.000463 | 0.13 | 2 |
| sr_rush | off | 0.00227 | 0.000919 | 0.00135 | 0.00164 (16/16) | 0.00136 [0.000176] | 0.00135 | 0.00111 | 0.00 | 1 |
| sr_rush | def | 0.00232 | 0.000897 | 0.00142 | 0.00157 (16/16) | 0.00146 [0.000177] | 0.00142 | 0.00116 | 0.00 | 1 |
| **st_net** | off | 3.89 | 4.87 | −0.981 | −1.31 (1/17) | 1.04 [0.324] | **1e−8 → 1.04** | **1.5e−9 → 0.156** | 1.00 | 1 |
| **st_net** | def | 3.89 | 4.87 | −0.981 | −1.31 (1/17) | 1.04 [0.324] | **1e−8 → 1.04** | **1.5e−9 → 0.156** | 1.00 | 1 |
| start_fp | off | 6.04 | 2.74 | 3.3 | 2.26 (17/17) | 3.14 [0.477] | 3.3 | 1.11 | 0.00 | 1 |
| start_fp | def | 7.69 | 2.74 | 4.95 | 3.28 (17/17) | 4.89 [0.595] | 4.95 | 1.53 | 0.00 | 1 |
| stuff | off | 0.00128 | 0.000712 | 0.000571 | 0.000484 (16/16) | 0.000696 [9.97e−5] | 0.000571 | 0.000796 | 0.00 | 2 |
| stuff | def | 0.0014 | 0.000695 | 0.000706 | 0.000678 (16/16) | 0.000831 [0.000103] | 0.000706 | 0.00107 | 0.00 | 2 |
| **to_rate** | off | 4.8e−5 | 5.16e−5 | −3.61e−6 | −1.29e−5 (1/17) | 8.17e−6 [4.15e−6] | **1e−8 → 8.17e−6** | **1.5e−9 → 1.23e−6** | 1.00 | 1 |
| **to_rate** | def | 4.44e−5 | 5.14e−5 | −6.97e−6 | −1.42e−5 (0/17) | 1.41e−5 [3.74e−6] | **1e−8 → 1.41e−5** | **1.5e−9 → 2.11e−6** | 1.00 | 1 |

**Home-effect prior variance** `max(tv_off, tv_def)`, which changes for the four metrics only:
- `expl_pass`: 1e−8 → 0.000161;
- `fg_value`: 1e−8 → 0.0811;
- `st_net`: 1e−8 → 1.04;
- `to_rate`: 1e−8 → 1.41e−5;
- `sack_rate`: 0.000133 → 0.000133.

**Everything else in the priors is identical, bit for bit:** every other metric's prior mean and variance, every prior mean of the fallback metrics, and the FCS prior variances (`priors_identical_outside_fallback: True`).

**The consequence: the ratings move in-season.** The table shows FBS teams at the 2024 freezes: the median |posterior − prior mean| divided by the SD of the prior means across teams, v2.1.1 → v2.1.2. `sr` is shown as a control; it is unchanged.

| metric/side | freeze 01 (week 1) | freeze 04 (week 4) | freeze 08 (week 8) | freeze 12 (week 12) | final freeze | median posterior variance at the final freeze |
|---|---|---|---|---|---|---|
| expl_pass/off | 0 → 0 | 0 → 0.0875 | 0 → 0.112 | 0 → 0.129 | 0 → 0.166 | 1.5e−9 → 2.31e−5 |
| expl_pass/def | 0 → 0 | 0 → 0.0288 | 0 → 0.047 | 0 → 0.0596 | 0 → 0.0837 | 1.5e−9 → 1.32e−5 |
| fg_value/off | 0 → 0 | 0 → 0.0423 | 0 → 0.0673 | 0 → 0.0858 | 0 → 0.106 | 1.5e−9 → 0.0119 |
| fg_value/def | 0 → 0 | 0 → 0.136 | 0 → 0.223 | 0 → 0.244 | 0 → 0.314 | 1.5e−9 → 0.0119 |
| st_net/off | 0 → 0 | 0 → 0.0248 | 0 → 0.0415 | 0 → 0.057 | 0 → 0.0653 | 1.5e−9 → 0.15 |
| st_net/def | 0 → 0 | 0 → 0.0256 | 0 → 0.0426 | 0 → 0.0569 | 0 → 0.0652 | 1.5e−9 → 0.15 |
| to_rate/off | 0 → 0 | 0 → 0.0276 | 0.0001 → 0.0498 | 0.0001 → 0.071 | 0.0001 → 0.0805 | 1.5e−9 → 1.19e−6 |
| to_rate/def | 0 → 0 | 0 → 0.0612 | 0.0001 → 0.104 | 0.0001 → 0.14 | 0.0001 → 0.178 | 1.5e−9 → 2.01e−6 |
| sack_rate/def | 0 → 0 | 0 → 0.22 | 0 → 0.366 | 0.0001 → 0.449 | 0.0001 → 0.57 | 1.2e−8 → 9.34e−5 |
| sack_rate/off | 0 → 0 | 1.46 → 1.45 | 2 → 1.98 | 2.18 → 2.11 | 2.24 → 2.23 | 0.000228 → 0.000231 |
| sr/off | 0 → 0 | 0.493 → 0.493 | 0.95 → 0.95 | 0.713 → 0.713 | 0.873 → 0.873 | 0.00049 → 0.00049 |
| sr/def | 0 → 0 | 0.45 → 0.45 | 0.674 → 0.674 | 0.815 → 0.815 | 0.781 → 0.781 | 0.000431 → 0.000431 |

At the final freeze of every season 2014–2026, v2.1.1 moves 0.000–0.0001 prior SDs on all nine sides. v2.1.2 moves:

| season | expl_pass off | fg_value off | st_net off | to_rate def | sack_rate def |
|---|---|---|---|---|---|
| 2014 | 0.4 | 0.15 | 0.121 | 0.0895 | 0.679 |
| 2015 | 0.189 | 0.151 | 0.0845 | 0.107 | 0.501 |
| 2016 | 0.156 | 0.0838 | 0.0759 | 0.112 | 0.57 |
| 2017 | 0.18 | 0.11 | 0.0402 | 0.123 | 0.467 |
| 2018 | 0.196 | 0.196 | 0.045 | 0.0923 | 0.462 |
| 2019 | 0.211 | 0.227 | 0.0565 | 0.0983 | 0.489 |
| 2020 | 0.203 | 0.109 | 0.0479 | 0.145 | 0.412 |
| 2021 | 0.225 | 0.128 | 0.0748 | 0.166 | 0.744 |
| 2022 | 0.204 | 0.132 | 0.0843 | 0.175 | 0.525 |
| 2023 | 0.203 | 0.111 | 0.0602 | 0.138 | 0.523 |
| 2024 | 0.166 | 0.106 | 0.0653 | 0.178 | 0.57 |
| 2025 | 0.178 | 0.0918 | 0.0573 | 0.131 | 0.423 |
| 2026 | 0.0757 | 0.0392 | 0.0324 | 0.0536 | 0.236 |

The in-season data weight is modest, as §1.5 says. The season-end posterior variance is 96–98% of the prior variance for the four metrics, and about 76% for `sack_rate` defence: τ² is 0.15 · tv, the recipe's own floor, times the metric's prior scale: 1.0 for the four metrics, 8 for `sack_rate`.

**The audit's reproduction** (`phase2.prior_pinned`, key `core_prior_pinned_metrics`):
- v2.1.1: `['fg_value', 'st_net', 'to_rate']` in 2014, and the four metrics in every season 2015–2026;
- v2.1.2: an empty list in every season 2014–2026.

The same check on both sides (posterior variance ≤ 1.3e-8 and a move under 1e-6 at the final freeze) also finds `sack_rate` defence in v2.1.1 2026. In earlier seasons its prior variance of 1.2e-8 lets a move of about 3e-7 through, 0.0001 prior SDs, so it is pinned in effect. In v2.1.2 the list is empty in every season.

### 1.7 Selecting the rule, and why production v2.1.0 is unchanged

**The rule is selected in `build_ratings.between_var_rule()`:**
1. `$CFB_V2_BETWEEN_VAR_RULE`, when it is set. An unknown value raises.
2. Otherwise, the rule recorded in the released artifact of `C.MODEL_VERSION` (its `models.json` `between_var_rule`).
3. Otherwise, the legacy rule `cfb_v2_between_var_v1`.

**Production resolves to the legacy rule.** Production's `C.MODEL_VERSION` is `edgedesk_cfb_v2.1.0`, from `config.py`, which is untouched. Its `models.json` records no rule, and neither does v2.1.1's. So the production weekly run resolves to the legacy rule. That holds for the `python -m v2.build_ratings <season>` subprocess of `weekly/run.py` and for the in-process `weekly/team_state.py` and `weekly/qb_state.py` rebuilds alike. The legacy branch evaluates the original expression, character for character.

**Only v2.1.2's artifact records the rule** (`models.json` `between_var_rule: cfb_v2_between_var_v2`, written by `export.py` only for a non-legacy rule). So a governed switch of `PRODUCTION_MODEL_VERSION` would carry the rule with it. No workflow variable can be forgotten.

**Pairing guard:**
- Stage 3 now stamps `BUILD.json` with `stage3.between_var_rule`, and stage 5 copies it into its own stamp. A stage 5 without the field predates it, and is legacy.
- `predict_live.build_rows` refuses to score an artifact on features of another rule (`common.require_build(..., between_var_rule=)`).
- A frozen row's `build` provenance reads only the stage-2 and stage-5 fields it read before, so write-once row hashes are unchanged.

**Tested, before any stage-7 output existed:**

| check | result |
|---|---|
| one 2026 freeze rebuilt in memory under default settings from the v2.1.1 build (the final freeze, 2026-12-08), against `out_p/stage3` | 6,664 rows; ratings and league **identical**; max \|diff\| 0 |
| the same from the **v2.1.0** build `out_h` (freeze 2026-09-15), against `out_h/stage3` | 6,664 rows; **identical**; max \|diff\| 0 |
| a full stage-3 rebuild, 2012–2026, under default settings from v2.1.1's stages 1–2, into a scratch directory | all 33 stage-3 files **identical** to `out_p/stage3` (parquet frames equal; `varcomp.json` byte-equal); stamp `cfb_v2_between_var_v1` |
| `node football/cfb_production/gate.js start --job cfb_lab_hourly` | `decisions=true` (none of the pinned files changed) |

---

*Sections 2–11 were added after §1 was committed (commit `9148b3a2a`), and nothing in §1 was changed by what they found. The git history of this file shows the order.*

## 2. The patch build: the v2.1.1 recipe, no re-tuning

`out_p2` was built from v2.1.1's own stages 1–2:
- copied from `out_p`: `stage1/`, `stage2/`, `BUILD.json`, and the frozen tuning inputs (`selected_families.json`, `ablation.json`, `tuning_ratings.json`, `tuning_models_{C,D,D2}.json`, the same hashes as v2.1.0's);
- run, with `CFB_V2_BETWEEN_VAR_RULE=cfb_v2_between_var_v2 CFB_V2_MODEL_VERSION=edgedesk_cfb_v2.1.2`:
  - stage 3, `v2.build_ratings`;
  - stage 4, `v2.qb` and `v2.elo`;
  - stage 5, `v2.snapshots`;
  - the leakage tests;
  - stage 7, `v2.pipeline` (with `CFB_V2_V1_RECORDS=data/v1/out/v1_records.json`, unchanged);
  - `v2.export`.

`config.py` is unchanged (sha `fae24ed2…`).

**Not run:** `tune_ratings`, `ablation`, `tune_models` and `report.py`. The seed, the families, the columns, `t_df` (100), the stack procedure and its result (C and D at 0.5 each), and Elo's re-derived dev tuning (K 50, HFA 70, carry 1) are all identical to v2.1.1.

**The recipe itself was checked first, with the patched code under default settings.** I rebuilt stages 3–7 from v2.1.1's stages 1–2 into a scratch directory. Every output is **bit-identical** to `out_p`:
- the 33 stage-3 files;
- `qb_team`, `elo`, both stage-5 tables, the 9,524-row `backtest_predictions` and `promotion.json`;
- `backtest.json` differs only in its `model_version` label.

So every difference below comes from the rule and nothing else.

**What changed inside the build:**

| layer | v2.1.1 → v2.1.2 |
|---|---|
| stage 3 `varcomp.json`, `final_dataonly` | identical |
| stage 3 priors | identical except the variances of the nine sides (§1.6); every prior mean is identical |
| stage 3 ratings and league files, 2012–2026 | only the rows of `expl_pass`, `fg_value`, `st_net`, `to_rate` and `sack_rate` differ; row sets are identical |
| stage 4 (`qb_team`, `elo`) | identical (stage 4 reads no rating of these metrics) |
| stage 5 | 12,950 rows, identical keys. 86 columns change: the 81 columns of the five metrics, plus `match_sack_edge`, `match_st_edge`, `x_sack_h`, `x_sack_a` and `to_dependence`. The market table is identical. |
| **model inputs (51)** | **4 change: `edge_expl_pass` (C, D), `edge_fg_value` (D), `edge_st_net` (D), `to_dependence` (sigma).** The `sack_rate` change reaches no model input. |
| fitted models | every coefficient is refitted; the stack stays C 0.5 / D 0.5, and `t_df` stays 100 |

**Fitted values that differ from v2.1.1** (artifact `params.js`):

| component | v2.1.1 | v2.1.2 |
|---|---|---|
| Platt win | [0.04654, 1.04194] | [0.04616, 1.04277] |
| cover coefficient | [−0.01238, 0.17567] | [−0.01225, 0.17652] |
| CLV β | 0.10830 | 0.10813 |
| push table, `rsd_fill` | — | identical |
| \|z\| quantiles 50/80/95% | 0.6614 / 1.2846 / 1.9495 | 0.6612 / 1.2861 / 1.9507 |
| reliability σ range | 15.3087–18.4990 | 15.2977–18.4925 |
| ridge C coefficient on `edge_expl_pass` (per SD) | +1.548 (rank 8 of 41) | +1.624 (rank 8 of 41) |

**The dev-selected market rule changed.** v2.1.1 chose review 14 / gap 3 / EV 0.06 / min reliability 0; v2.1.2 chooses review 14 / gap 0 / EV 0 / min reliability 65, both excluding early weeks.
- The pipeline re-derives this rule from dev as part of the recipe; nothing was chosen by hand.
- The grid has 332 rules (335 before). The reality-check p is 0.148 (0.108 before), so **BET stays disabled**.
- A rule that flips under a feature change this small is itself evidence of threshold mining at noise level, consistent with the audit's reading of the rule.

**Gates G1–G7 all pass**, the decision is ELIGIBLE_FOR_PROMOTION, and BET is disabled.

| gate | v2.1.1 | v2.1.2 |
|---|---|---|
| G1 MAE vs V1 (n 1,534) | 12.3797 vs 12.6516, CI [−0.461, −0.084] | 12.3781 vs 12.6516, CI [−0.463, −0.086] |
| G2 RMSE | 15.6942 vs 15.9929 | 15.6937 vs 15.9929 |
| G3 Brier | 0.18286 vs 0.18575 | 0.18289 vs 0.18575 |
| G4 ECE | 0.0193 | 0.0187 |
| G5 coverage 50/80/95 | 0.509 / 0.813 / 0.949 | 0.510 / 0.813 / 0.951 |
| G6 stability | dev 7/8 better; both holdout seasons better | the same |
| G7 worst subgroup | spread 3–7: −0.055 | spread 3–7: −0.055 |

**Artifact.** `artifacts/edgedesk_cfb_v2.1.2/` holds `gbm_D.txt`, `meta.json`, `models.json` (with `between_var_rule: cfb_v2_between_var_v2`), `params.js` and `MANIFEST.json` (sha256 `38a0d952…`).
- It verifies against its MANIFEST (`weekly.project.verify_artifact`, and `compat.js` in a scratch copy).
- `export.py` refuses to overwrite it.

## 3. Data diff (full lists in the MANIFEST)

**None.** v2.1.2 reads exactly v2.1.1's stage 1–2 data: `stage2/games.parquet` and `market.parquet` are the same files. The only changes are the computed stage-3 variances listed in §1.6 and everything downstream of them (§2).

## 4. v2.1.1 vs v2.1.2: the difference

### 4.1 Every prediction, 2016–2026 (9,524 games)

Every prediction moves, because the models are refitted on four changed inputs. The moves are small:

| seasons | games | mean \|Δ margin\| | max \|Δ margin\| | mean \|Δ win p\| | max \|Δ win p\| |
|---|---|---|---|---|---|
| 2016–2019 | 3,519 | 0.118–0.177 | 1.01 | 0.0021–0.0027 | 0.021 |
| 2020–2023 | 3,263 | 0.093–0.127 | 0.83 | 0.0017–0.0023 | 0.016 |
| 2024 | 920 | 0.098 | 0.98 | 0.0017 | 0.013 |
| 2025 | 934 | 0.088 | 0.80 | 0.0015 | 0.010 |
| 2026 | 888 | 0.083 | 0.83 | 0.0014 | 0.010 |
| **all** | 9,524 | **0.116** (SD 0.156) | **1.01** | **0.0019** | **0.021** |

- The correlation between the v2.1.1 and v2.1.2 margins is 0.99994.
- The largest moves are FBS-vs-FCS games, for example Hawai'i–Central Arkansas 2019 (−4.05 → −3.04) and South Alabama–Northwestern State 2024 (38.23 → 37.25).
- The largest FBS-vs-FBS moves are Colorado–Oklahoma State 2016 (3.08 → 3.95) and Arkansas–LSU 2020 (−8.76 → −9.60).
- The full list is in `out_p2/audit/patch_v212_movers.csv`.

### 4.2 Dev 2016–2023 (FBS vs FBS, true finals; paired bootstrap, v2.1.2 − v2.1.1, 2,000 resamples)

| | n | v2.1.1 | v2.1.2 | Δ [95% CI] |
|---|---|---|---|---|
| MAE | 5,954 | 12.7991 | 12.7978 | −0.0013 [−0.0054, +0.0030]; week-clustered [−0.0052, +0.0027]; P(v2.1.2 not better) 0.27 |
| RMSE | 5,954 | 16.1747 | 16.1718 | −0.0030 [−0.0072, +0.0014] |
| Brier (win probability from 2017) | 5,194 | 0.17823 | 0.17820 | −0.00003 [−0.00010, +0.00005] |
| log loss | 5,194 | 0.52930 | 0.52925 | |
| ECE | 5,194 | 0.0085 | 0.0087 | |
| calibration slope | 5,194 | 1.023 [0.963, 1.084] | 1.024 [0.964, 1.085] | |
| buckets inside their CI | | 10/10 | 10/10 | |
| coverage 50/80/95 (shipped intervals, 2017+) | 5,194 | 0.501 / 0.811 / 0.955 | 0.502 / 0.811 / 0.954 | |

**By season.** Δ MAE, with none of the CIs excluding 0:

| season | n | v2.1.1 | v2.1.2 | Δ [95% CI] |
|---|---|---|---|---|
| 2016 | 760 | 13.1838 | 13.1766 | −0.0072 [−0.0234, +0.0091] |
| 2017 | 776 | 12.6838 | 12.6850 | +0.0012 [−0.0120, +0.0137] |
| 2018 | 772 | 12.9983 | 13.0026 | +0.0043 [−0.0071, +0.0167] |
| 2019 | 774 | 12.6186 | 12.6130 | −0.0056 [−0.0165, +0.0047] |
| 2020 | 534 | 13.2271 | 13.2301 | +0.0030 [−0.0104, +0.0166] |
| 2021 | 770 | 12.9283 | 12.9229 | −0.0054 [−0.0148, +0.0035] |
| 2022 | 776 | 12.6046 | 12.6028 | −0.0018 [−0.0106, +0.0066] |
| 2023 | 792 | 12.3013 | 12.3037 | +0.0024 [−0.0052, +0.0104] |

**By week of the season** (weeks played before the game):

| bucket | n | MAE v2.1.1 → v2.1.2 | Δ [95% CI] | Brier v2.1.1 → v2.1.2 | coverage 50/80/95, v2.1.2 |
|---|---|---|---|---|---|
| weeks 0–3 | 1,469 | 12.8491 → 12.8432 | −0.0059 [−0.0137, +0.0021] | 0.16222 → 0.16213 | 0.497 / 0.791 / 0.950 |
| weeks 4–7 | 1,649 | 12.5710 → 12.5769 | +0.0059 [−0.0016, +0.0136] | 0.18578 → 0.18580 | 0.507 / 0.826 / 0.956 |
| weeks 8–11 | 1,786 | 12.7470 → 12.7443 | −0.0027 [−0.0099, +0.0047] | 0.17341 → 0.17340 | 0.517 / 0.819 / 0.959 |
| weeks 12+ | 1,050 | 13.1758 → 13.1722 | −0.0036 [−0.0142, +0.0070] | 0.19664 → 0.19660 | 0.474 / 0.800 / 0.950 |

The fix should matter most late in the season, when the four ratings have absorbed the most evidence. No bucket shows a significant difference.

### 4.3 Holdout 2024–2025: a documented re-evaluation due to a bug fix

**The holdout is not clean.** 2024–25 has been read at least 12 times across the project (audit F-29), and this comparison is one more read.
- It is a documented re-evaluation due to a bug fix. Nothing was chosen from it: the rule of §1 was committed before any stage-7 output existed, and the recipe has no free parameter that could be set from it.
- The read is logged the way v2.1.1 logged its own: the decision policy's `post_freeze_changes.jsonl` line (§5.4) and this document.

| | n | v2.1.1 | v2.1.2 | Δ [95% CI] |
|---|---|---|---|---|
| MAE (true finals) | 1,606 | 12.3297 | 12.3277 | −0.0020 [−0.0070, +0.0030]; week-clustered [−0.0078, +0.0048]; P(not better) 0.22 |
| RMSE | 1,606 | 15.6047 | 15.6036 | −0.0012 [−0.0059, +0.0038] |
| Brier | 1,606 | 0.18286 | 0.18289 | +0.00004 [−0.00005, +0.00013] |
| log loss | | 0.53822 | 0.53832 | |
| ECE | | 0.0193 | 0.0187 | |
| calibration slope | | 1.056 [0.915, 1.186] | 1.055 [0.915, 1.186] | |
| buckets inside their CI | | 10/10 | 10/10 | |
| coverage 50/80/95 | | 0.509 / 0.813 / 0.949 | 0.510 / 0.813 / 0.951 | |

| slice | n | MAE Δ [95% CI] | coverage 50/80/95, v2.1.2 |
|---|---|---|---|
| 2024 | 798 | −0.0008 [−0.0081, +0.0066] | 0.500 / 0.810 / 0.945 |
| 2025 | 808 | −0.0032 [−0.0107, +0.0042] | 0.520 / 0.817 / 0.957 |
| weeks 0–3 | 389 | −0.0078 [−0.0171, +0.0014] | 0.491 / 0.787 / 0.920 |
| weeks 4–7 | 428 | +0.0079 [−0.0017, +0.0174]; Brier +0.00024 [+0.00007, +0.00040] | 0.540 / 0.818 / 0.939 |
| weeks 8–11 | 421 | −0.0010 [−0.0108, +0.0086] | 0.511 / 0.820 / 0.974 |
| weeks 12+ | 368 | −0.0084 [−0.0201, +0.0045] | 0.495 / 0.829 / 0.970 |

The one sub-slice CI that excludes zero (weeks 4–7 Brier, +0.0002) is one of about 30 comparisons, and the overall holdout Brier CI straddles zero.

**The published common set** (n 1,534, the `backtest.json` headline):

| | v2.1.1 | v2.1.2 |
|---|---|---|
| V2 MAE | 12.3797 | 12.3781 |
| coverage | 0.509 / 0.813 / 0.949 | 0.510 / 0.813 / 0.951 |

**The Model Lab reference set** (the same 1,604 games, FBS finals with a V1 prediction):

| | v2.1.1 | v2.1.2 |
|---|---|---|
| MAE | 12.3242 | 12.3222 |
| RMSE | 15.6008 | 15.5997 |
| Brier | 0.1831 | 0.1831 |
| prediction SD | 12.424 | 12.423 |

### 4.4 Live 2026, graded on true finals (the F-01 rule)

**Truth** is the Model Lab's settled FINAL results, `football/cfb_lab/ledger/2026/results.jsonl`, exactly as in PATCH_v2.1.1. Both builds share v2.1.1's stage 2, from the 07:21 UTC fetch:
- 188 of the 215 FBS-vs-FBS games kicked off before the fetch are FINAL in the build;
- 20 are IN_PROGRESS and 7 were not scored in the feed. All 27 are final in the ledger.

Every graded prediction is a point-in-time pregame row, so it does not depend on its own game's status in stage 2.

| set | n | v2.1.1 | v2.1.2 | opener | close | v2.1.1 − close | v2.1.2 − close | v2.1.2 − v2.1.1 |
|---|---|---|---|---|---|---|---|---|
| stage-2 finals, on true finals | 188 | 11.945 | 11.945 | 11.077 | 10.858 | +1.087 [0.449, 1.735] | +1.087 [0.443, 1.740] | +0.000 [−0.015, +0.017] |
| all true finals, weeks 1–4 | 215 | 12.157 | 12.155 | 11.201 | 11.030 | +1.127 [0.549, 1.726] | +1.125 [0.545, 1.726] | −0.001 [−0.016, +0.014] |

- Brier on the 215 games: 0.14455 → 0.14452.
- **Provisional:**
  - the 546 FBS-vs-FBS games kicked off after the fetch (weeks 5+) are not graded; their predictions come from the stale file in both builds (v2.1.2 − v2.1.1 mean \|Δ\| 0.071, max 0.356);
  - the 27 games that are final in the ledger but not in the build are graded on ledger truth only.

## 5. Evaluations re-run: old → new

### 5.1 Market comparisons (every game, the model's side, at −110; `pipeline.betting_report`)

**Holdout 2024–25** (n 1,604 with an opener and a close):

| | v2.1.1 | v2.1.2 | paired v2.1.2 − v2.1.1 |
|---|---|---|---|
| V2 − opener (MAE) | +0.273 [+0.106, +0.450] | +0.271 [+0.105, +0.448] | |
| V2 − close | +0.386 [+0.212, +0.555] | +0.384 [+0.209, +0.554] | |
| CLV, mean points | 0.357 [0.257, 0.456] | 0.340 [0.241, 0.440] | **−0.017 [−0.035, −0.001]** |
| ATS at the opener | 50.98% [48.5, 53.4] | 51.17% [48.7, 53.5] | units per game +0.004 [−0.007, +0.014] |
| ROI at the opener | −2.63% [−7.3, +1.9] | −2.27% [−7.0, +2.2] | |
| ATS at the close | 49.97% [47.4, 52.8] | 50.16% [47.7, 53.0] | |
| ROI at the close | −4.51% | −4.15% | |
| line moved toward V2 | 54.6% | 54.4% | |
| the side of V2 | | | the same in 98.8% (19 games flip) |
| dev-rule qualified | 3 (ROI −3.0%) | 129 (ATS 53.1%, ROI +1.4%, CLV 1.22) | a different rule (§2) |

**Dev 2016–23** (n 3,648):

| | v2.1.1 | v2.1.2 | paired |
|---|---|---|---|
| V2 − opener | +0.225 [+0.091, +0.352] | +0.224 [+0.091, +0.350] | |
| V2 − close | +0.374 [+0.243, +0.495] | +0.374 [+0.242, +0.495] | |
| CLV | 0.336 [0.265, 0.410] | 0.340 [0.268, 0.412] | +0.003 [−0.003, +0.010] |
| ATS at the opener | 51.81% [50.2, 53.5] | 52.01% [50.4, 53.7] | units +0.004 [−0.002, +0.008] |
| ROI at the opener | −1.07% | −0.71% | |
| ATS at the close | 50.78% | 50.98% | |
| ROI at the close | −3.00% | −2.63% | |
| the side of V2 | | | the same in 99.4% (21 flips) |
| dev-rule qualified | 157 (61.0%, ROI +16.2%, CLV 1.40) | 520 (56.8%, ROI +8.2%, CLV 0.81) | a different rule |

**Reading:**
- No market conclusion changes. V2 remains worse than both the opener and the close in every window, and neither version has a betting edge.
- The holdout CLV loss of 0.017 points comes from the 19 flipped sides. Dev moves the other way (+0.003). I read it as noise on an inspected holdout, and report it because its CI excludes zero.
- The "rule qualified" rows compare two different dev-selected rules, so they are not a like-for-like comparison.

### 5.2 Live 2026

See §4.4.

### 5.3 The decision calibration's frozen procedure, recomputed on v2.1.2 OOF

This is a recompute only: the frozen selection (identity map with a logit shrink toward the market) was kept, and the frozen artifact was not rewritten.

| input | w_model | 95% profile CI | LR vs w = 0 | n |
|---|---|---|---|---|
| frozen artifact (v2.1.0) | 0.227829 | | | |
| v2.1.1 | 0.220978 | [0.066, 0.377] | 7.80 | 4,248 |
| **v2.1.2** | **0.221573** | [0.066, 0.377] | 7.82 | 4,248 |

### 5.4 Decision policy v1 holdout: a documented re-evaluation due to a bug fix

**This is not a second read for tuning.** The frozen policy (`policy.json`, sha `cb9019a2…`), its frozen calibration (w 0.227829) and its frozen tournament choices were applied unchanged to the v2.1.2 holdout rows.
- The same code first reproduced the recorded v2.1.0 read exactly (`recorded_v210_matches_reproduction: true`), and repeated the v2.1.1 re-evaluation beside it.
- Nothing was chosen, refit or re-thresholded.
- `MANIFEST.json`, `evidence.json` and `holdout_access.jsonl` were **not** modified.
- The run is logged as one new line in `cfb_decision_policy_v1/post_freeze_changes.jsonl` (`action: DOCUMENTED_REEVALUATION_BUG_FIX`, `bugs: ["F-21"]`, `results_sha256 da324b92…`).

| | v2.1.1 | v2.1.2 |
|---|---|---|
| holdout decision rows | 1,600 | 1,600 |
| production statuses | LEAN 206 · PASS 1,258 · RESEARCH 136 · 0 bets | LEAN 209 · PASS 1,253 · RESEARCH 138 · 0 bets |
| decision log loss − coin | +0.00025 [−0.00179, +0.00221] | +0.00025 [−0.00178, +0.00220] |
| LEAN − PASS CLV | +0.399 [+0.055, +0.734] | +0.403 [+0.067, +0.737] |
| edge candidate: bets / CLV / ROI | 160 / 0.650 / −5.7% | 160 / 0.620 / −5.7% |
| multivariate: bets / CLV / ROI | 60 / 1.429 / +17.9% | 59 / 1.301 / +16.6% |
| clv_model: bets / CLV / ROI | 80 / 1.172 / +18.2% | 79 / 1.098 / +19.7% |
| tiers: HIGH / LOW CLV (HIGH ≥ LOW?) | 0.846 / 0.105 (yes) | 0.735 / 0.107 (yes) |
| promotion gate | G1, G2 pass; `bet_enabled stays false` | the same |
| **without a calibration `base_model_version` switch** | NO_BET for all rows | **NO_BET for all 1,600 rows** (`NO_BET_VERSION_MISMATCH`, fail closed) |

`bet_enabled` stays false.

### 5.5 The audit's F-21 reproduction, and feature importance and correlation

**`python3 -m v2.audit.phase2`, key `core_prior_pinned_metrics`** (the function run on each build by `patch_v212 --sections M`):

| build | result |
|---|---|
| v2.1.1 | `fg_value`, `st_net`, `to_rate` in 2014; the four metrics in every season 2015–2026 |
| v2.1.2 | an empty list in every season 2014–2026 |

The both-sides check, and the movement at several freezes, are in §1.6.

**Feature importance and correlation** (dev 2016–23 rows):

| | v2.1.1 | v2.1.2 |
|---|---|---|
| corr(`edge_expl_pass`, `edge_prior_sr`) | 0.964 | **0.960** |
| corr(`edge_expl_pass`, its own prior edge `edge_prior_expl_pass`) | **1.000** | 0.994 |
| corr(`edge_to_rate`, `edge_prior_to_rate`) | **1.000** | 0.995 |
| corr(`edge_expl_pass`, `edge_epa_pass`) | 0.876 | 0.893 |
| corr(`edge_st_net`, `edge_fg_value`) | 0.132 | 0.146 |
| ridge C, `edge_expl_pass` coefficient per SD (rank of 41) | +1.548 (8) | +1.624 (8) |
| GBM D gain share (rank of 42): `edge_expl_pass` | 0.14% (26) | 0.14% (25) |
| GBM D gain share: `edge_fg_value` | 0.20% (23) | 0.27% (20) |
| GBM D gain share: `edge_st_net` | 0.33% (17) | 0.31% (17) |
| each changed input, old vs new (all rows): correlation | | `edge_expl_pass` 0.996, `edge_fg_value` 0.991, `edge_st_net` 0.998, `to_dependence` 0.998 |

**The 0.97 correlation phase 1 flagged was not caused by the pin alone.** The prior mean of `expl_pass` is itself 0.96-correlated with the prior of `sr`: both are predicted from the same talent, returning production and lagged inputs. The fix removes the exact identity with its own prior (1.000 → 0.994), and the in-season information added is small (§1.6).

## 6. Tests

Final state, with this patch in the tree (worktree `f21-patch`).

| suite | build | result |
|---|---|---|
| `python3 -m v2.weekly.tests_weekly --fast` (production CI) | empty temp dirs | **89/89**: 84 before, +5 F-21 |
| `python3 -m v2.tests_between_var` (new) | empty temp dirs; `out_p2`; `out_p` | **7/7** (5 synthetic + 2 skipped); **7/7**; **7/7** (the legacy build pins exactly the nine known sides) |
| `python3 -m v2.tests_finality` | empty temp dirs; `out_p2` | **11/11**; **11/11**, none skipped |
| `python3 -m v2.weekly.tests_games --fast` | empty temp dirs | **74/74** |
| `python3 -m v2.tests_signs` | `out_p2` | **16/16** |
| `python3 -m v2.tests_leakage` | `out_p2` | **29/29**, including the F-15 outcome scan: 51 inputs, 8,845 games, max \|corr(input, margin − close)\| 0.050 (`edge_stuff`), max r² 0.405 vs the close's 0.451. `artifact_live_path_reproduces_backtest` is skipped because `current.json` is v2.1.0. |
| `python3 -m v2.decision.tests_policy` / `tests_decision` | `out_h` | **20/20**, **23/23**, after the appended line |
| `node football/cfb_v2/tests.js` | — | **100/100** |
| `node football/cfb_decision/tests.js` | — | **101/101** |
| `node football/cfb_production/tests.js` | — | **120/120** |
| `node football/cfb_production/gate.js start --job cfb_lab_hourly` | — | `decisions=true` |
| the default-settings identity checks of §1.7 and §2 | `out_p`, `out_h`, scratch | identical, bit for bit |
| scoring guard (`predict_live.build_rows`) | `out_p2`, `out_p` | v2.1.2 on v2.1.2 features: scored (888 rows). v2.1.1 on v2.1.1 features: scored. v2.1.0 on v2.1.2 features and v2.1.2 on legacy features: **refused**. |

**What the new tests cover:**
- the released versions resolve to the legacy rule;
- the environment selects a rule and refuses an unknown one;
- a positive moment is kept bit for bit, and the build refuses when no signal is measurable;
- the power check, which is F-21 in miniature: a simulated league with a 2.5× overstated noise model has a negative legacy moment (off −5.5e-5, def −2.0e-4), while the split-half recovers the true between-team variance conservatively (off 3.0e-4 of a true 3.8e-4, def 1.6e-4 of 2.2e-4);
- scoring refuses features built under another rule.

## 7. Files changed

| file | what |
|---|---|
| `football/cfb_v2/research/v2/build_ratings.py` | the rule (`between_var_rule`, `split_half_between`, `_between_var_v2`), the legacy branch kept verbatim, the stage-3 stamp, and the rule in the context cache key |
| `football/cfb_v2/research/v2/snapshots.py` | the stage-5 stamp carries the stage-3 rule |
| `football/cfb_v2/research/v2/common.py` | `require_build(..., between_var_rule=)` |
| `football/cfb_v2/research/v2/predict_live.py` | scoring checks the artifact's rule against the features' |
| `football/cfb_v2/research/v2/export.py` | a non-legacy rule is recorded in `models.json` |
| `football/cfb_v2/research/v2/tests_between_var.py` (new) | F-21 tests |
| `football/cfb_v2/research/v2/weekly/tests_weekly.py` | the 5 synthetic F-21 checks in the production fast suite |
| `football/cfb_v2/research/v2/audit/patch_v212.py` (new) | the evaluation behind every number here, and the MANIFEST writer |
| `football/cfb_v2/artifacts/edgedesk_cfb_v2.1.2/` (new) | the challenger artifact and its MANIFEST |
| `football/cfb_v2/artifacts/decision/cfb_decision_policy_v1/post_freeze_changes.jsonl` | one appended line (§5.4) |
| `docs/cfb-audit/PATCH_v2.1.2.md` (new) | this document |

**Not changed:**
- `v2/config.py` and `v2/market.py`, both pinned by `cfb_decision_baseline_001`;
- `football/cfb_v2/engine.js` and `football/cfb_v2/params.js`;
- the v2.1.0 and v2.1.1 artifacts;
- `football/cfb_production/compatibility.json` and governance;
- the policy's MANIFEST, `evidence.json` and `holdout_access.jsonl`;
- the audit's `phase2.py`;
- the builds `out_h` and `out_p`;
- every bot-owned file: `current.json`, `learning/`, `monitoring.json`, `shadow/`, `snapshots/` and `record/`.

Generated and git-ignored: `research/out_p2/`.

## 8. What the next production run will change (without a switch)

**No production number changes.** The weekly run's `C.MODEL_VERSION` is `edgedesk_cfb_v2.1.0`, whose artifact records no rule, so every stage-3 call resolves to the legacy rule. The stage-3 subprocess, `team_state` and `qb_state` all do. §1.7 and §2 show that the legacy rule reproduces v2.1.0 and v2.1.1 bit for bit.

**What the run gains:**
- `BUILD.json` gains `stage3.between_var_rule: cfb_v2_between_var_v1`, and the stage-5 stamp gains the same field. Frozen-row provenance reads neither, so write-once row hashes are unchanged.
- `predict_live` checks the rule: legacy against legacy passes.
- `tests_weekly --fast` runs 89 checks.

## 9. What switching production to v2.1.2 would change (not done)

I simulated the switch in a scratch copy of the repo: `PRODUCTION_MODEL_VERSION = 'edgedesk_cfb_v2.1.2'`, with `params.js` taken from the artifact. The result is the same as for v2.1.1:
- the gate reports `incompatible`, "the compatibility matrix has a COMPATIBLE entry for edgedesk_cfb_v2.1.2: no entry";
- `manifest.js --write-compat` refuses: "refusing to pin a decision baseline whose files do not verify".

A switch is therefore the **same four coupled changes** as PATCH_v2.1.1 §9, made together, between two freezes:

1. **The pure model.**
   - `config.py`: `PRODUCTION_MODEL_VERSION = 'edgedesk_cfb_v2.1.2'`, one line.
   - `params.js` is replaced by `artifacts/edgedesk_cfb_v2.1.2/params.js`, with sha `9db0d789…` (it is `35845306…` today). The fitted differences are in §2.
   - **Stage 3 follows automatically.** Its rule comes from the artifact of `C.MODEL_VERSION` (`models.json` `between_var_rule`), so no workflow variable is needed.
   - The first weekly run after the switch must rebuild stages 3–5, which the weekly job always does. The split-half adds about 6 seconds.
   - If the stamps disagree, scoring refuses rather than mixing rules (§6).
2. **The decision baseline.** A new `cfb_decision_baseline_002`, frozen by `v2.decision.baseline` with `BASE_MODEL_VERSION = 'edgedesk_cfb_v2.1.2'`. It pins the new `config.py`, `params.js`, `engine.js` and `market.py` and the `out_p2` data. Without it, the Lab's `cfb_lab_hourly` gate turns decisions off.
3. **The decision calibration's `base_model_version`.** A new calibration version is needed, e.g. `cfb_decision_calibration_v1_1` with base v2.1.2. There are two options:
   - **(a)** carry v1's numbers (w 0.227829);
   - **(b)** re-run the frozen procedure with the selection pinned: w 0.221573 (§5.3).

   The policy then needs a new version (`cfb_decision_policy_v1_1`) that differs only in `calibration_artifact`, plus `v2/decision/__init__.py` `BASE_MODEL_VERSION`. Without this, every row is `NO_BET_VERSION_MISMATCH` (§5.4).
4. **`football/cfb_production/compatibility.json`**, via `manifest.js --write-compat` once items 1–3 verify, with a new PRODUCTION_PATHWAY / COMPATIBLE entry:
   - `model_version: edgedesk_cfb_v2.1.2`, `feature_version: cfb_v2_fv2`;
   - `artifact_manifest_sha256: 38a0d952b9908630138a74d4bb4eb6633348ba1a561f49e09c4bfac5c54943e6`;
   - `params_sha256: 9db0d789f72aa461479c57e81188c4d5190c5f9e574f4823ab4f047b2f290fc1`;
   - `engine_sha256: 745c1c3c…` (unchanged);
   - `calibration_version: edgedesk_cfb_v2.1.2:49ca154d445e`;
   - `ensemble_version: edgedesk_cfb_v2.1.2:e105ca1727a6` (the same weights hash);
   - `market_engine_version: edgedesk_cfb_v2.1.2:market:233657903e2e`;
   - the new decision versions and hashes;
   - `bet_enabled_allowed: false`.

   The v2.1.0 entry becomes the rollback.

**The Model Lab's tracked models,** as in PATCH_v2.1.1 §9 item 5:
- `football/cfb_lab/config.json` gains `"edgedesk_cfb_v2.1.2": {"label": "V2.1.2 · patch", "adapter": "v2.1"}`;
- a reference `{"mae": 12.3222, "rmse": 15.5997, "brier": 0.1831, "pred_sd": 12.423}` on the same 1,604 games. This is a governed `RULE_CHANGED` event;
- the governance roles and experiments are updated through `governance.js`.

**Skipping v2.1.1.** If the owner switches straight to v2.1.2, none of v2.1.1's §9 items are needed: v2.1.2 contains every v2.1.1 fix (F-01, F-02, F-10, F-11, F-15) and its data.

## 10. Recommendation

**Switch to v2.1.2, not v2.1.1, if and when production is switched off v2.1.0.** Do it as the governed four-part change in §9, between two freezes.

**Why:**
- v2.1.2 is v2.1.1's code, data and recipe with one bug fixed. Nine rating-sides that were preseason priors wearing in-season names now carry in-season evidence.
- The switch cost is identical for either version.
- Choosing v2.1.2 avoids a second governed switch later.

**Nothing in the evidence argues against it:**
- dev −0.001, holdout −0.002 MAE, Brier +0.00004 and live −0.001 are all noise;
- calibration, coverage, the gates and `bet_enabled` are unchanged;
- the frozen decision policy's results move within noise.

The holdout CLV difference of −0.017 [−0.035, −0.001] is the only interval that excludes zero. It is small, it has the opposite sign on dev, and it comes from an inspected holdout, but I report it rather than explain it away.

**Nothing argues for urgency either.** The fix buys correctness, not accuracy.
- With the recipe's prior-variance floor, the four ratings take only 2–5% of the in-season evidence by season's end, so the model's inputs barely change.
- **Do not** switch mid-week before the Tuesday 2026-09-29 12:00 UTC freeze, for the same attribution reason as PATCH_v2.1.1 §10.

**What the owner should not conclude:** that F-21 cost accuracy. The data says the lost information was worth about nothing under this recipe. A larger effect would need the follow-ups below, and each of those is a model change, not a patch.

## 11. Caveats and follow-ups

**The noise model is overstated for several metrics** (§1.2). The per-play variance `s2p` is about 1.4–2.4× binomial for `expl_pass`, `sack_rate` and `to_rate`. For `epa_pass` and `ppd`, the split-half covariance is 1.5–7.6× the positive moment. Consequences:
- the moment-based `tv` is biased low for those metrics as well;
- `tau2` sits at the `0.15 · tv` floor for `epa_pass` defence and `ppd` in every season, and for the nine fixed sides.

Re-estimating the noise model would change every metric and every stage-3 weight. That makes it a new model version, with its own pre-registration, not a patch. It is also the change that would let the fixed metrics carry real in-season weight.

**The prior scales of the four metrics** (1.0) were "tuned" on a grid that could not move a pinned metric, so they carry no information. Tuning them on dev now would be a retune, which was out of scope here. It is only meaningful together with the noise model.

**The same 1e-8 floor exists in the research-only matchup style layer.** In `v2/matchup/style.py:531` it binds for the defence side of `go_oe`, `qb_rush_epa` and `sy_conv` (`out_h/matchup/style/true_var.json`). That layer's artifact is NO_ADJUSTMENT and production reads none of it. It was not touched.

**The audit's reproduction reads only the offence columns** (`phase2.prior_pinned`), so it could not see `sack_rate` defence. The both-sides check is in `patch_v212 --sections M` and `tests_between_var`. The audit script was left as the auditor's.

**The dev-selected market rule is unstable** under a tiny feature change (§2). BET is disabled in both versions, and the reality-check p is 0.108 → 0.148. The rule's "qualified" subsets are not comparable across versions.

**The holdout is inspected development data** (F-29). This patch adds one more read, and every holdout number above should be read as dev-grade evidence.

**The 2026 week-5+ predictions** in both builds come from the 07:21 UTC file and are provisional. Production recomputes them from each fresh fetch.
