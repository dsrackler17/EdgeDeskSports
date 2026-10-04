# CFB personnel — the quarterback layer (`cfb_personnel_qb_v1`)

Code: `football/cfb_v2/research/v2/personnel/{qb,lineup,backtest_qb,tests_qb}.py`.
Outputs: `$CFB_V2_OUT/personnel/qb/` (cache under `qb/cache/`) and the combined-comparison contract file
`$CFB_V2_OUT/personnel/backtest_qb_oof.parquet` (section 10). The canonical build is
`CFB_V2_OUT=research/out_h`, the V2.1 / fv2 build. `research/out` is stale: its stage 5 and stage 7 are
the v2.0.0 / fv1 build. The first run, which scored the holdout, wrote to `research/out/personnel/qb/`.
The holdout result was then relocated to `out_h` without being re-scored. Every input it reads is
identical in the two directories, which was verified file by file.
Contract: [DESIGN.md](DESIGN.md) — point in time, baseline lineup, re-anchoring, probabilistic availability,
scenarios, pure model only, versioned challenger, no LLM ratings.

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
python3 -m v2.personnel.backtest_qb --all          # estimates, dev backtest, audit, 2026, PVAR (~6 min cold)
python3 -m v2.personnel.backtest_qb --holdout      # the holdout, ONCE (refuses to re-score)
python3 -m v2.personnel.backtest_qb --oof          # personnel/backtest_qb_oof.parquet (needs dev + holdout rows)
python3 -m v2.personnel.tests_qb [--fast]          # 64 synthetic checks (--fast, no data) / 86 with real data
```

## Verdict

**With a perfect starter announcement, the QB layer improves QB-change games slightly and leaves every
other game exactly unchanged. The gain is too small to separate from zero in eight development seasons or
in the two holdout seasons. In the Tuesday-freeze pipeline it changes nothing in 2026, because every 2026
conference report is published on game day.**

- The oracle is an upper bound on what a pregame announcement is worth. It uses the passer on each
  team's first dropback, which is known only after kickoff. Here is what the oracle gains on
  QB-change games:

  | | dev 2016–2023 (n = 1,401) | holdout 2024–25 (n = 358) |
  |---|---|---|
  | artifact path, ΔMAE | −0.008 [−0.029, +0.013] | −0.032 [−0.072, +0.008] |
  | points path, ΔMAE | −0.020 [−0.092, +0.057] | −0.088 [−0.225, +0.044] |
  | artifact path, Δlog loss | −0.0007 [−0.0017, +0.0004] | −0.0014 [−0.0032, +0.0004] |
  | points path, Δlog loss | −0.0013 [−0.0048, +0.0023] | −0.0020 [−0.0082, +0.0043] |

  The direction is the same in both windows and the holdout effect is larger, but every 95% CI covers 0.
- **Ordinary games are unchanged by construction.** A game with no report, or with a report that does
  not move the expected starter, reuses the unmodified V2.1 row. Its output matches
  `weekly.project.infer` exactly (`tests_qb: no_report_identity_exact`). "Does not hurt ordinary games"
  therefore holds exactly, not just statistically.
- **The frozen artifact barely listens to its QB inputs.** When the starter changes, rebuilding the
  artifact's own QB columns moves the margin by 0.30 points on average (p90 0.65). That is about
  0.06 points per point of rating gap × dropbacks. The realised effect in the V2.1 walk-forward
  residuals is about 0.33 points per point: β = 0.333 [0.147, 0.509], n = 1,728. The artifact's QB
  response has the same sign as the rating gap 84% of the time (correlation 0.67), so it is noisy. The
  points path applies the measured slope directly.
- **2026 in production terms:**
  - 0 of 63 report-covered games had a report published before the Tuesday 12:00 UTC freeze. Usable
    reports arrive 71–102 h after the freeze and a median 1.5 h before kickoff.
  - A game-day refresh would have changed the expected starter in 4 of the 36 games with a usable
    report.
  - In 3 of those 4 games the actual starter was the scenario the report pointed to. In the fourth
    (Ball State) a third QB started.
- **Transfer translation is weakly identified.** About 72% of a QB's above-replacement rating follows
  him to a new team: share 0.716 [0.243, 1.200]. The transfer-specific slope shift has a CI that covers
  0. The translation is therefore used only to widen a transfer's rating uncertainty, never in a margin.
- **The double-count baseline has a real flaw, found and not fixed (V2 is frozen).** `qb_team_rating`
  re-anchors to a new starter 4–6× faster than the pass-offence ratings absorb him, because it ignores
  the preseason prior, which carries 96% → 66% of the rating through a season. The mismatch predicts
  the V2.1 residual: −6.8 points per EPA/dropback [−10.9, −2.2], n = 5,510. A pregame correction for it
  failed the pre-registered rule on dev ordinary games (ΔMAE +0.007) and is left to the next V2 retrain.

**Challenger `edgedesk_cfb_v2.1.0+personnel_qb_v1`, recommended content.** This was fixed on dev before
the holdout was scored; see `out_h/personnel/qb/prereg_challenger.json`, a copy of the original in `out/personnel/qb/`.

1. **Availability override → starter distribution.** Apply the rule in "Expected starter" below to
   official reports published before `now`. With no report, keep V2's rule and flag the team UNKNOWN.
2. **Margin path = points layer.**
   - Each scenario's margin = V2.1 + 0.333 × (d_pts home − d_pts away).
   - d_pts = (rating of the scenario starter − rating of V2's expected starter) × the team's
     non-garbage dropbacks per game before T.
   - σ is V2.1's.
   - Mix the scenarios by play probability.
   - The artifact-rebuild path is published beside it as the "pure artifact" view.
3. **Must run in a game-day refresh** (a new, write-once projection when a report lands before
   kickoff). At the Tuesday freeze it is inert.
4. **Excluded:**
   - the baseline-mismatch correction (fails the ordinary-games rule on dev);
   - transfer translation in margins (weak evidence);
   - rating quadrature over the posterior SD (not tested; it would double-count uncertainty that the
     artifact's σ was fitted with).

Expect an accuracy gain too small to show up in the Model Lab within a season. The layer's value is
honesty: an OUT starter is no longer silently projected to play, and the scenario spread is published.

## 1. Per-player QB value at instant T (`qb.qb_values`, `qb.ratings_at`)

The model is V2.1's stage-4 model (`v2/qb.py`), reused and never re-tuned. It uses games that kicked
off before T.

- **Adjusted EPA:** `adj(g) = EPA/dropback − opponent pass-defence rating − h·H`.
  - Past seasons use the opponent's final data-only rating.
  - The current season uses the ratings frozen at T.
- **Rating:** `rating(T) = (Σ_g w_g db_g adj_g + k·repl) / (Σ_g w_g db_g + k)`.
  - w_g = 0.6^(seasons ago).
  - db = non-garbage dropbacks.
- **Shrinkage constants (burn-in 2009–2013, V2):**
  - k = 150.57 dropbacks.
  - repl = −0.05658.
  - s² (per-dropback noise) = 2.7646.
  - true between-QB variance = 0.018361.
- **Posterior SD** (stated formula): V2's conjugate model is `adj_g | θ ~ N(θ, s²/db_g)`,
  `θ ~ N(repl, s²/k)`, so `sd(θ | games before T) = sqrt(s² / (n_eff + k))`, with n_eff = V2's
  decayed dropbacks (`den`). With season decay this is the power-prior form: older seasons count as
  fewer dropbacks. A QB with no data has sd = sqrt(s²/k) = 0.1355, the between-QB SD.
- **Per-passer columns:** rating, rating_sd, n_eff, career_db, career_starts, games_season,
  starts_season, db_season, team_id (latest this season, else last), other_team_share,
  rating_translated(_sd), above_repl, and above_repl_sd = sqrt(rating_sd² + repl_sd²).
- **Replacement level with its spread** (`qb.replacement`):
  - Band: QB-seasons with 20–120 non-garbage dropbacks, 2009–2013 (V2's band).
  - n = 618 QB-seasons, 31,281 dropbacks. Bootstrap: 2,000 resamples, seed 20260927.

  | | estimate | 95% CI |
  |---|---|---|
  | mean (= V2's repl) | −0.0566 | [−0.0801, −0.0347] |
  | SD of true quality, noise removed: sqrt(var_w(m) − s²·N/Σn) | 0.1323 | [0.0947, 0.1611] |
  | raw SD | 0.2685 | — |
  | dev 2014–2023 check (n = 1,476): mean | −0.0365 | [−0.0509, −0.0221] |
  | dev 2014–2023 check: SD | 0.168 | [0.147, 0.187] |

  The replacement level has drifted up since the burn-in. V2 keeps its burn-in value and so does this
  layer. A replacement is N(−0.0566, 0.1323²).
- **Exactness:** the per-season cache (`qb/cache/ratings_S.parquet`) and the context rebuild reproduce
  V2's stage-4 `qb_team.parquet` bit for bit for every team × freeze. The suite checks 2023 and 2026;
  2019 was checked by hand. This is `tests_qb: cache_equals_stage4_*`, `context_rebuild_equals_stage4_*`.

## 2. Player vs system: transfers (`qb.transfer_events`, `qb.estimate_persistence`)

**Events** use dev seasons only (`C.assert_dev_only`) and the same ESPN id throughout:
- the QB started ≥ 1 game for his main team A in S−1 (main team = most non-garbage dropbacks);
- he starts a game for team B in S, S = 2010–2023;
- B ≠ A is a transfer (n = 162); B = A is a stay (n = 1,516).

**Outcome y:** adjusted EPA/dropback over his first 4 games for B, with ≥ 30 non-garbage dropbacks.
Selection is "he starts for B", which is what an announcement says. It is not "he survived a season".

**Predictor x:** V2's rating at the first freeze of S.

**Fit:** FGLS of `y − repl = α + ρ(x − repl) + e`, with Var(e) = σ_u² + s²/n_y. Bootstrap: 2,000
resamples over events.

| fit | α | ρ | σ_u | n |
|---|---|---|---|---|
| transfer | 0.090 [0.037, 0.142] | **0.674 [0.236, 1.101]** | 0.139 [0.095, 0.175] | 162 |
| stay | 0.113 [0.098, 0.126] | 0.942 [0.836, 1.051] | 0.114 | 1,516 |
| pooled shift, transfer − stay | −0.021 [−0.076, +0.032] | −0.271 [−0.735, +0.182] | 0.117 | 1,678 |
| transfer + new team's previous passing by other QBs (γ = 0.147 [−0.031, +0.339]) | 0.098 | 0.615 | 0.135 | 150 |
| sensitivity: whole season, ≥ 50 dropbacks | 0.112 | 0.605 | 0.142 | 147 |
| sensitivity: stay, same definition | 0.120 | 0.885 | 0.120 | 1,365 |

- **Share of the persistent rating that follows the player:** ρ_transfer / ρ_stay = **0.716
  [0.243, 1.200]**. The whole-season sensitivity gives 0.683 [0.257, 1.192]. The point estimate says
  about 28% stays with the team, but the evidence cannot exclude 0% or 75%.
- **By era:** 2010–2017 ρ = 0.52 (n = 32); 2018–2023 portal era ρ = 0.56 (n = 130).
- **Out of sample** (leave-one-season-out on the 162 transfers, weighted RMSE):
  - V2 rating as is: 0.2303, mean error +0.052. V2 under-rates a starter's first games.
  - stay line: 0.2262.
  - transfer line: 0.2238.
  - The gain is small.
- **The specified no-intercept form** `repl + ρ(x − repl)` gives ρ = 1.216 (transfer) and 1.510
  (stay). Those values are not persistence: starters sit above V2's backup-level replacement mean by
  α ≈ 0.1, and without an intercept ρ absorbs that level. The translation keeps the intercept.
- **Translation used** (`qb.translate`):
  - mean = repl + 0.0900 + 0.6738 (old − repl).
  - var = 0.1392² + [1, d] Σ [1, d]ᵀ, with d = old − repl and Σ the bootstrap covariance of (α, ρ):
    [[0.000723, −0.004588], [−0.004588, 0.049142]].
  - The line is weakly identified, so the prior is wider rather than precise. For a QB 0.3 above
    replacement the SD grows from 0.139 to 0.172.
- **V2-scale version** (`qb.translated`): shifts only the other-team part of a QB's evidence by the
  pooled shift and adds the extra transfer variance (σ_tr² − σ_stay² + shift uncertainty).
- **Where it is used:** only `qb_values.rating_translated(_sd)`. It is not a margin input.

## 3. Expected starter at T (`qb.expected_starters`, `qb.starter_distribution`)

**Default: V2's rule.** The expected starter is the starter of the team's most recent game. In dev,
the rule is right in 85.9% of team-games with an expected starter; in the holdout, 87.1%. With no
report the team is flagged **UNKNOWN**: unknown is not healthy.

**Reports.** An official report counts only if all of these hold:
- it was published (else retrieved) at or before `now` and before kickoff;
- it has `ok ≠ false`;
- it names players, or its conference makes silence mean available.

Details:
- The files' `rows` (schema `edgedesk_availability_report_v1`) are read, with an older `players` key
  as fallback.
- ISO and RFC-2822 times are both parsed.
- Only QB rows count.
- Statuses are normalized (`GAME_TIME_DECISION` → `GAME-TIME DECISION`).
- A QB not listed on a usable report is **NOT LISTED**, with p = 1 and knowledge KNOWN.

**Chain.** Candidates, in order:
1. V2's expected starter;
2. the team's other QBs by season non-garbage dropbacks;
3. the team's QBs from the last 2 seasons by career dropbacks for this team, minus anyone seen
   throwing elsewhere since;
4. any other QB the report lists;
5. an unseen REPLACEMENT, rated N(repl, 0.1323²).

Candidate i starts with probability `p_i · Π_{j<i}(1 − p_j)`.

**Play probabilities** come from `availability.PLAY_PROBABILITY`:

| status | p |
|---|---|
| NOT LISTED / ACTIVE | 1 |
| PROBABLE | 0.85 |
| QUESTIONABLE, GAME-TIME DECISION | 0.5 |
| DOUBTFUL | 0.2 |
| OUT, SUSPENDED, OUT FOR SEASON, TRANSFERRED | 0 |
| OUT FIRST HALF | 0.5 (game fraction, as `personnel/state.py`) |

This gives the rules the design asks for:
- OUT → the next QB with p = 1;
- QUESTIONABLE → 0.5 / 0.5;
- PROBABLE → 0.85 / 0.15;
- OUT + OUT → the third QB;
- all out → REPLACEMENT.

Further rules:
- An unrecognised status is not guessed: p = 1, flagged.
- At most 4 named scenarios per team; the remaining mass goes to REPLACEMENT.
- Provider placeholder ids (≤ 100, the 'TEAM' athletes) are never candidates. `MIN_VALID_ID` is the
  same rule as `usage.py`.

## 4. Lineup scenarios on the frozen artifact (`lineup.project`)

The artifact `edgedesk_cfb_v2.1.0` reads these QB inputs; `lineup.artifact_qb_inputs(A)` lists them,
and a test asserts the set:
- the D_gbm submodel reads qb_delta_edge, qb_exp_edge, h/a_qb_exp_db_log, h/a_qb_changed,
  qb_missing_any and qb_unsettled_any;
- the σ model reads qb_missing_any and qb_unsettled_any;
- the ridge reads none.

For each scenario the rebuild writes the per-team columns (qb_missing, qb_id, qb_exp_rating,
qb_team_rating, qb_delta, qb_backup_rating, qb_drop, qb_exp_db_log, qb_exp_starts, qb_changed,
qb_unsettled) with `qb.team_features`' own expressions, and the four game columns with
`snapshots.build_season`'s lines. `models.add_derived` then runs inside `predict`. Two identities are
enforced:
- the rebuild for V2's own starter reproduces the artifact output exactly (`rebuild_v2_starter_identity`);
- a scenario whose starters are V2's reuses the untouched row (`no_report_identity_exact`).

- **Scenarios:** home option × away option, p = p_home·p_away. Each runs through
  `weekly.project.infer`: the approved submodels, stack, σ model and t(df = 100). There is no refit.
- **Mixture:** `mean = Σ p_s μ_s`; `var = Σ p_s(σ_s² + μ_s²) − mean²`; `P(home) = Σ p_s P_s`.
  The 80% and 95% intervals come from bisection on the mixture CDF. A single scenario is returned as is.
- **Output per game:**
  - scenarios (starter ids, names, statuses, p, margin, σ, p_home, d_pts, margin_points);
  - `mixture` (artifact path);
  - `points_layer.mixture` (β = 0.333);
  - `base` (plain V2.1);
  - `delta_vs_base` (both paths);
  - knowledge per team and the report metadata.

**Double-count protection.** `qb_delta = expected − qb_team_rating`. `qb_team_rating` is the
dropback-weighted rating of this season's passers.
- **Where it matches the ratings:** in the season-horizon ratings, varcomp for epa_pass is
  s²_play = 6.12 and s²_game ≈ 0, so the ratings also weight each dropback equally.
- **Where it does not** (`lineup.baseline_lineup`; FBS; dev 2016–2023; 18,552 team-freezes):
  - The ratings include the **preseason prior**. Its share of the posterior mean is
    π = off_var(T)/off_var(T0). A one-parameter check correlates 0.997 with it.
    - π after 1, 2, 4, 8 and 12+ games: 0.96, 0.92, 0.85, 0.73, 0.66.
    - For the recent horizon (games and prior decayed with the 8-week half-life,
      `C.RECENT_HALFLIFE_WEEKS`), π_rec is 0.94, 0.89, 0.78, 0.61, 0.47.
  - `qb_team_rating` ignores the prior's lineup. The prior regresses on the lagged rating, so its
    lineup is proxied by last season's QBs on this team, valued at their ratings at T.
- **Re-anchoring pace.** For 183 mid-season changes to a starter who keeps the job, this is the weight
  on the new starter at the 1st to 5th freeze after the change:

  | freeze after the change | 1 | 2 | 3 | 4 | 5 |
  |---|---|---|---|---|---|
  | `qb_team_rating` | 0.36 | 0.44 | 0.51 | 0.56 | 0.59 |
  | season rating | 0.06 | 0.09 | 0.11 | 0.13 | 0.15 |
  | recent rating | 0.10 | 0.14 | 0.18 | 0.22 | 0.26 |

  The baseline treats the new starter as absorbed 4–6× faster than the ratings absorb him.
- **Size of the mismatch** (L = π·L_prior + (1 − π)·data lineup, minus `qb_team_rating`):
  - mean |mismatch| 0.042 EPA/dropback, which is 1.26 points per game; p90 0.108;
  - teams whose expected starter was not on last season's team: 0.063 (1.90 points per game);
  - returning starters: 0.029.
- **It is real signal.** On the V2.1 walk-forward residual (n = 5,510 dev games), the slope is
  −6.8 points per EPA/dropback [−10.9, −2.2] for the season horizon and −7.2 [−11.9, −2.0] for the
  recent horizon. One SD of the edge is worth about 0.6 points.
- **Recommendation for the next V2 retrain.** Build `qb_team_rating` as the rating's own lineup: the
  prior's share with the prior's lineup, which is DESIGN rule 2's `rating_lineup_context`. This layer
  documents the flaw and does not patch V2.

## 5. Backtests (`backtest_qb`)

**Reproduction first.** The V2.1 walk-forward is found by `backtest_qb.v21_dir()`: the output
directory whose `report/backtest.json` says `edgedesk_cfb_v2.1.0` / `cfb_v2_fv2`.
- **Locally that directory is `research/out_h`.** `research/out/stage7` and `out/stage5` are the
  v2.0.0 / fv1 (candidate-001) build: they differ from V2.1 by up to 5.08 points and are not the
  target.
- **The refit reproduces V2.1 exactly.** `walkforward.run` on the V2.1 snapshot rows, with the
  selected families, gives **max |diff| = 0.0** on 11,262 rows for ens_pred, σ, p_home_raw,
  pred_C_ridge and pred_D_gbm. It also matches inside every season of the oracle run.
- **Only then do the test rows change.** Each season S is re-predicted with the fits `run` made for
  S: models on seasons < S, an equal stack, and σ and t on out-of-fold rows of seasons < S. Training
  rows are untouched.

**The oracle.** The actual starter is the passer on the team's first dropback. He is rebuilt with his
point-in-time rating at the game's freeze.
- Scope: FBS vs FBS, FINAL.
- Week-1 teams have no V2 expected starter and are not rebuilt: 787 team-games in dev, 167 in the
  holdout.
- Changes that involve a provider placeholder passer are not rebuilt (66 dev, 12 holdout).
- **Points path.** β_S is fitted on QB-change games of 2014..S−1 (walk-forward). 2014–2015 serve only
  as training rows, from the equal C/D mean that is the V2.1 stack.
  - Dev β by season: 0.43, 0.39, 0.36, 0.21, 0.26, 0.25, 0.36, 0.36.
  - Holdout: β frozen at 0.333, fitted on 2014–2023.
- **Baseline path.** Same scheme; dev β from −14.3 to −7.2, holdout frozen at −8.44.
- Bootstrap: paired over games, 2,000 resamples. Log loss uses p_home_raw, the artifact's calibration
  (`raw`). 2016 has no σ, which is why n with probabilities is smaller.
- MAE / RMSE / bias are in points (bias = prediction − outcome). Δ = variant − base.
- The baseline and combined rows are reported for completeness. They were **excluded before the
  holdout was scored.**

### DEV 2016–2023

| variant | set | n | MAE base | MAE var | RMSE base | RMSE var | bias base | bias var | LL base | LL var | ΔMAE [95% CI] | ΔLL [95% CI] |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| artifact oracle | QB-change | 1401 | 12.7990 | 12.7905 | 16.2162 | 16.2038 | +1.317 | +1.356 | 0.5494 | 0.5487 | −0.0085 [−0.0288, +0.0127] | −0.0007 [−0.0017, +0.0004] |
| artifact oracle | first-time starter | 550 | 12.8069 | 12.8097 | 16.1183 | 16.1071 | +0.998 | +1.075 | 0.5456 | 0.5455 | +0.0028 [−0.0302, +0.0341] | −0.0001 [−0.0018, +0.0017] |
| artifact oracle | all games | 5954 | 12.7991 | 12.7971 | 16.1747 | 16.1718 | +0.278 | +0.288 | 0.5293 | 0.5291 | −0.0020 [−0.0066, +0.0029] | −0.0002 [−0.0004, +0.0001] |
| artifact oracle | unchanged | 4553 | 12.7991 | 12.7991 | 16.1620 | 16.1620 | −0.041 | −0.041 | 0.5229 | 0.5229 | 0 (identical) | 0 |
| **points oracle** | QB-change | 1401 | 12.7990 | 12.7786 | 16.2162 | 16.1815 | +1.317 | +1.307 | 0.5494 | 0.5481 | −0.0203 [−0.0920, +0.0565] | −0.0013 [−0.0048, +0.0023] |
| points oracle | first-time starter | 550 | 12.8069 | 12.8007 | 16.1183 | 16.0720 | +0.998 | +0.893 | 0.5456 | 0.5470 | −0.0063 [−0.1445, +0.1236] | +0.0014 [−0.0049, +0.0077] |
| points oracle | all games | 5954 | 12.7991 | 12.7943 | 16.1747 | 16.1666 | +0.278 | +0.276 | 0.5293 | 0.5290 | −0.0048 [−0.0224, +0.0128] | −0.0003 [−0.0012, +0.0006] |
| points oracle | unchanged | 4553 | 12.7991 | 12.7991 | 16.1620 | 16.1620 | −0.041 | −0.041 | 0.5229 | 0.5229 | 0 (identical) | 0 |
| baseline (pregame) | QB-change | 1401 | 12.7990 | 12.7771 | 16.2162 | 16.1731 | +1.317 | +1.281 | 0.5494 | 0.5481 | −0.0219 [−0.0622, +0.0215] | −0.0013 [−0.0032, +0.0007] |
| baseline (pregame) | all games | 5954 | 12.7991 | 12.7994 | 16.1747 | 16.1697 | +0.278 | +0.268 | 0.5293 | 0.5285 | +0.0003 [−0.0207, +0.0207] | −0.0008 [−0.0017, +0.0001] |
| baseline (pregame) | unchanged | 4553 | 12.7991 | 12.8062 | 16.1620 | 16.1687 | −0.041 | −0.044 | 0.5229 | 0.5222 | **+0.0071** [−0.0175, +0.0311] | −0.0007 [−0.0018, +0.0003] |
| points + baseline | QB-change | 1401 | 12.7990 | 12.7458 | 16.2162 | 16.1288 | +1.317 | +1.271 | 0.5494 | 0.5465 | −0.0532 [−0.1324, +0.0272] | −0.0029 [−0.0067, +0.0009] |
| points + baseline | all games | 5954 | 12.7991 | 12.7920 | 16.1747 | 16.1593 | +0.278 | +0.266 | 0.5293 | 0.5281 | −0.0071 [−0.0341, +0.0195] | −0.0012 [−0.0024, +0.0000] |

Games with probabilities: 1,249 QB-change and 5,194 all.
- V2's own error on QB-change games has a bias of +1.3: it over-rates the team whose starter changed.
- The points path removes little of that bias because d_pts averages close to 0: changes go both ways,
  since the injured starter comes back as often as he leaves.

### HOLDOUT 2024–2025 (scored once, every slope frozen on 2014–2023)

| variant | set | n | MAE base | MAE var | RMSE base | RMSE var | bias base | bias var | LL base | LL var | ΔMAE [95% CI] | ΔLL [95% CI] |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| artifact oracle | QB-change | 358 | 12.5097 | 12.4775 | 15.5243 | 15.5001 | −0.613 | −0.544 | 0.5482 | 0.5468 | −0.0322 [−0.0720, +0.0081] | −0.0014 [−0.0032, +0.0004] |
| artifact oracle | first-time starter | 137 | 11.9939 | 11.9404 | 15.2420 | 15.1974 | −0.792 | −0.601 | 0.5477 | 0.5448 | −0.0535 [−0.1268, +0.0228] | −0.0029 [−0.0060, +0.0004] |
| artifact oracle | all games | 1607 | 12.3234 | 12.3162 | 15.6016 | 15.5963 | −0.586 | −0.570 | 0.5382 | 0.5379 | −0.0072 [−0.0161, +0.0019] | −0.0003 [−0.0007, +0.0001] |
| artifact oracle | unchanged | 1249 | 12.2700 | 12.2700 | 15.6237 | 15.6237 | −0.578 | −0.578 | 0.5354 | 0.5354 | 0 (identical) | 0 |
| **points oracle** | QB-change | 358 | 12.5097 | 12.4221 | 15.5243 | 15.4274 | −0.613 | −0.600 | 0.5482 | 0.5462 | −0.0876 [−0.2251, +0.0442] | −0.0020 [−0.0082, +0.0043] |
| points oracle | first-time starter | 137 | 11.9939 | 11.8650 | 15.2420 | 15.0686 | −0.792 | −0.782 | 0.5477 | 0.5397 | −0.1289 [−0.3675, +0.1018] | −0.0080 [−0.0182, +0.0023] |
| points oracle | all games | 1607 | 12.3234 | 12.3039 | 15.6016 | 15.5802 | −0.586 | −0.583 | 0.5382 | 0.5378 | −0.0195 [−0.0475, +0.0093] | −0.0004 [−0.0018, +0.0010] |
| points oracle | unchanged | 1249 | 12.2700 | 12.2700 | 15.6237 | 15.6237 | −0.578 | −0.578 | 0.5354 | 0.5354 | 0 (identical) | 0 |
| baseline (pregame) | QB-change | 358 | 12.5097 | 12.4721 | 15.5243 | 15.4764 | −0.613 | −0.666 | 0.5482 | 0.5463 | −0.0376 [−0.1330, +0.0562] | −0.0019 [−0.0064, +0.0026] |
| baseline (pregame) | all games | 1607 | 12.3234 | 12.3097 | 15.6016 | 15.6015 | −0.586 | −0.592 | 0.5382 | 0.5381 | −0.0137 [−0.0531, +0.0257] | −0.0001 [−0.0021, +0.0017] |
| baseline (pregame) | unchanged | 1249 | 12.2700 | 12.2631 | 15.6237 | 15.6372 | −0.578 | −0.571 | 0.5354 | 0.5358 | −0.0068 [−0.0547, +0.0395] | +0.0004 [−0.0017, +0.0025] |
| points + baseline | QB-change | 358 | 12.5097 | 12.3940 | 15.5243 | 15.3719 | −0.613 | −0.653 | 0.5482 | 0.5441 | −0.1157 [−0.2750, +0.0308] | −0.0041 [−0.0115, +0.0034] |
| points + baseline | all games | 1607 | 12.3234 | 12.2923 | 15.6016 | 15.5785 | −0.586 | −0.590 | 0.5382 | 0.5376 | −0.0311 [−0.0784, +0.0191] | −0.0006 [−0.0029, +0.0017] |

Per holdout season, on QB-change games:
- 2024 (n = 186): ΔMAE −0.016 (artifact) and −0.040 (points).
- 2025 (n = 172): ΔMAE −0.050 (artifact) and −0.139 (points).

### 2026 live (`live_2026`, frozen artifact through `project.infer`)

- There are 117 report files; 78 are usable. They cover 63 games that have V2.1 rows.
- **At the Tuesday 12:00 UTC freeze:** 0 games have a usable report, so 0 expected starters change.
  Every usable report is a game-day listing, published 71–102 h after the freeze and a median 1.5 h
  before kickoff.
- **At kickoff − 1 min (a game-day refresh):** 36 games have a usable report and 4 change:

| game (wk 4) | report | scenarios | V2.1 | artifact mix | points mix | actual starter (hindsight, not an input) |
|---|---|---|---|---|---|---|
| Temple v Army | Smolik (TEM) QUESTIONABLE | Smolik 0.5 / Sheppard 0.5 | −3.14, p .422 | −3.01, sd 16.07, p .425 | −2.73, p .432 | Sheppard |
| UAB v Navy | Woodson (NAVY) QUESTIONABLE | Woodson 0.5 / Gutierrez 0.5 | −7.11, p .330 | −6.99, p .333 | −7.03, p .332 | Gutierrez |
| Akron v UNLV | Broughton (AKR) OUT | Roggow 1.0 | −4.69, p .383 | −4.83, p .380 | −5.11, p .373 | Roggow |
| Kent State v Ball State | Luster (BSU) QUESTIONABLE | Luster 0.5 / Kelly 0.5 | +1.13, p .527 | +1.06, p .526 | +1.69, p .541 | Mizzell (a third QB) |

In Kent State v Ball State the artifact path moves against the rating gap. This is the 16% sign
disagreement noted in the verdict.

## 6. PVAR, 2025 FBS starters (`pvar`)

Definitions:
- **PVAR** = (rating − repl) × expected non-garbage dropbacks per game, taken as his 2025 mean per
  start.
- **SD** = dropbacks × sqrt(rating_sd² + 0.1323²): rating posterior plus replacement spread.
- As of the last 2025 freeze, 2026-01-13.

| population | n | mean | SD | p05 | p25 | p50 | p75 | p95 | mean PVAR SD |
|---|---|---|---|---|---|---|---|---|---|
| primary starter per FBS team | 136 | 4.67 | 3.44 | −0.85 | 2.16 | 4.45 | 6.89 | 10.74 | 4.26 |
| every FBS QB with ≥ 1 start | 251 | 2.74 | 3.55 | −1.84 | −0.04 | 1.76 | 4.99 | 9.65 | 3.95 |

- Mean dropbacks per start: 28.6.
- Only 11% of primary starters are more than 1.96 SD above replacement. The replacement spread alone
  is about 3.8 points per game.
- **Top:** Maiava 12.3 ± 4.6, Mensah 12.1, Hoover 11.9, Chambliss 11.8, Sayin 11.7, Pavia 11.6.
- **Bottom:** Kiael Kelly −3.7.

The realised value of a starter change is about a third of the nominal PVAR gap (β = 0.333).
Nominal PVAR is not a margin.

## 7. Constants (all in code, with provenance)

| constant | value | where |
|---|---|---|
| RULE_VERSION | `cfb_personnel_qb_v1` (lineup: `cfb_personnel_lineup_qb_v1`) | qb.py, lineup.py |
| k, repl, s², shrinkage seasons | 150.57, −0.05658, 2.7646, 2009–2013 | V2, recomputed by `qb.base()` |
| REPLACEMENT sd | 0.1323 [0.0947, 0.1611], n = 618 | qb.py |
| PERSISTENCE: α, ρ, σ_u (transfer) | 0.0900, 0.6738, 0.1392; n = 162 | qb.py |
| TRANSFER_WINDOW_GAMES, TRANSFER_MIN_DB | 4 games, 30 dropbacks | qb.py |
| status → play probability | availability.PLAY_PROBABILITY + NOT LISTED 1.0, OUT FIRST HALF 0.5 | qb.py |
| MAX_NAMED_SCENARIOS | 4 per team | qb.py |
| MIN_VALID_ID | 100 | qb.py |
| DEFAULT_DB_PER_GAME | 30.6 (dev mean 30.63) | qb.py |
| QB_POINTS_BETA | 0.3331 [0.147, 0.509], n = 1,728 | lineup.py |
| N_BOOT, seed | 2000, `C.SEED` = 20260927 | backtest_qb.py |

## 8. Tests (`tests_qb`)

**`--fast`: 64 synthetic checks.** They need no data directories:
- mixture moments, CDF intervals and single-scenario exactness;
- the no-report / NOT LISTED / OUT / OUT+OUT / all-out / chain / probable / questionable /
  doubtful / GTD / out-first-half / unrecognised / placeholder-id rules, and p summing to 1;
- V2 QB columns for V2's starter, a backup, an outside QB and a replacement;
- the game-level columns;
- the translation formulas, including the widening;
- point in time for reports: after `now`, after kickoff, RFC-2822, failed read, empty report,
  silence rule, retrieval fallback;
- point in time for ratings: a post-T game with ±40 EPA never changes a rating or the expected
  starter, and the synthetic rating equals the formula;
- dev-only guards.

**Real data: 22 more checks, 86 in total, about 1.5 minutes with `CFB_V2_OUT=out_h`:**
- stage-7 reproduction, max |diff| = 0;
- the cache and the context rebuild equal stage-4 for 2023 and 2026, every team × freeze;
- artifact manifest, QB inputs covered, no market inputs;
- no-report identity through the artifact (40 games of the last 2026 freeze), the V2-starter
  rebuild identity, and OUT → backup;
- 2026: nothing known at the freeze, scenarios consistent at kickoff, the OUT starter replaced;
- replacement, persistence, dropbacks-per-game and β constants re-derived.

## 9. Integration notes for the weekly engine

- **API.**
  - `starters = qb.expected_starters(S, T, now, games)`, where games has game_id, home/away_id,
    home/away_team and kickoff_ts.
  - `lineup.project(X_rows, A, gbm, starters, {T: qb.ratings_at(S, T)}, now=now)`.
  - `qb.qb_values(S, T)` gives the per-player rows for `cfb_qb_week_state`.
  - A live T not in the cache is computed on the fly (`qb.live_ratings`, about 2 s).
- **Pure model only.** Nothing reads a line, price or book. `project.assert_no_market_inputs` runs on
  the artifact inputs.
- **`v2/weekly/availability.py`** was fixed upstream on 2026-09-27. It now reads the report files'
  `rows` and maps `OUT_FIRST_HALF` to 0.5. This layer reads `rows` (with `players` as fallback) and
  normalizes every underscore status itself (`GAME_TIME_DECISION` → `GAME-TIME DECISION`), so it does
  not depend on that fix.
- **Stale local outputs.** The local `research/out/stage5` and `out/stage7` are the v2.0.0/fv1
  build: 5.08 points max |diff| from V2.1. `backtest_qb.load_wf()` refuses any stage-5 or stage-7 rows
  whose `feature_version` is not `cfb_v2_fv2`. `backtest_qb.v21_dir()` finds the V2.1 walk-forward:
  first `$CFB_V2_OUT`, then `$CFB_V2_WF_DIR`, then the sibling `out_h`.

## 10. Combined-comparison contract (`backtest_qb.write_oof`)

`$CFB_V2_OUT/personnel/backtest_qb_oof.parquet` (here `research/out_h/personnel/backtest_qb_oof.parquet`)
has one row per game of the V2.1 stage-7 backtest: 11,262 rows. Metadata is in `backtest_qb_oof.json`.

| column | meaning |
|---|---|
| game_id, season, week, margin | as stage 7 (margin = home − away, actual) |
| window | `dev_2016_2023` (β walk-forward), `holdout_2024_2025` (scored once, β frozen on 2014–2023), `live_2026` (played games, β frozen), `pre_stack` (2014–2015: V2.1 has no stacked prediction), `unplayed` |
| qb_change | the actual starter (first dropback, **oracle**) is not V2's expected starter; both are identified passers |
| first_time_starter | that actual starter had no career start before the freeze |
| pred_base, sigma_base, p_home_base | the stage-7 ens_pred, sigma, p_home_raw (asserted identical) |
| pred_qb, sigma_qb, p_home_qb | **+QB, the challenger path** (points layer): pred_base + β·d_pts, σ_qb = σ_base, p from the season's t. Equal to base wherever qb_change is false (asserted) |
| pred_qb_artifact, sigma_qb_artifact, p_home_qb_artifact | the artifact-rebuild path, reported beside it |
| d_pts | the lineup delta in points, home − away: (rating actual − rating expected) × team non-garbage dropbacks per game |

Rows by window:

| window | rows | of which qb_change |
|---|---|---|
| dev | 6,782 | 1,509 |
| holdout | 1,854 | 384 |
| live 2026 | 324 | 39 |
| pre_stack | 1,738 | — |
| unplayed | 564 | — |

These counts include FCS games. The tables above are FBS vs FBS. The 2026 oracle on played FBS
QB-change games (n = 30) has MAE 7.963 for V2.1, 8.033 for the points path and 7.960 for the artifact
path. The sample is too small to read.
