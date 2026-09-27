# Patch `edgedesk_cfb_v2.1.2`: fix for audit finding F-21

- **Parent:** `edgedesk_cfb_v2.1.1` (itself a challenger). Production is still `edgedesk_cfb_v2.1.0`, and it is unchanged.
- **What the patch is:**
  - one corrected stage-3 variance rule;
  - the same code recipe, the same hyper-parameters, seeds, feature list and stacking procedure as v2.1.1;
  - trained through 2025, with feature schema `cfb_v2_fv2`.
- **Status:** a CHALLENGER that has **not** been switched in (§9).

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

*Sections 2–11 (the rebuild and every re-run evaluation) were added after this section was committed, and nothing above was changed by what they found. The git history of this file shows the order.*
