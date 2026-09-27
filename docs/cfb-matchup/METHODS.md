# CFB scheme and matchup engine: methods

Code: `football/cfb_v2/research/v2/matchup/` (`style`, `interactions`, `similar`, `changes`, `residual`,
`backtest`, `hook`, `audit`, `tests_matchup`). SQL: `supabase/cfb_matchup.sql`. Artifact:
`football/cfb_v2/artifacts/matchup/cfb_matchup_resid_v1.json`.

| version constant | value | what it versions |
|---|---|---|
| `STYLE_VERSION` | `cfb_style_v1` | style sums, league expectation models, style ratings |
| `MATCHUP_FEATURE_VERSION` | `cfb_matchup_fv1` | interaction feature definitions |
| `SIMILARITY_VERSION` | `cfb_similarity_v1` | style vectors, distance, kernel |
| `RESIDUAL_MODEL_VERSION` | `cfb_matchup_resid_v1` | the matchup correction (frozen NO_ADJUSTMENT) |
| `PLAYSEL_VERSION` | `cfb_playsel_v1` | expected play selection (additive joint model) |
| `CLUSTER_VERSION` | `cfb_style_cluster_v1` | descriptive archetypes, never a production input |
| `CHANGE_RULE_VERSION` | `cfb_style_change_v1` | change-point rule and thresholds |
| `BASE_MODEL_VERSION` | `edgedesk_cfb_v2.1.0` | the general model the correction sits on |

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
python3 -m v2.matchup.audit                # scheme-data audit (15 s)
python3 -m v2.matchup.style [season]       # plays -> expectation models -> sums -> style ratings (~4 min cold; one season 16 s warm)
python3 -m v2.matchup.backtest --dev       # every dev experiment (~3 min; similarity grid +2 min the first time)
python3 -m v2.matchup.backtest --freeze    # the artifact from the dev decision
python3 -m v2.matchup.backtest --holdout   # 2024-2025, ONCE (refuses a second scoring)
python3 -m v2.matchup.backtest --live      # 2026 games played so far
python3 -m v2.matchup.hook <out.json>      # a real hook run at the next freeze -> SQL fixture rows
python3 -m v2.matchup.tests_matchup [--fast]
node football/cfb_matchup/sql.test.js
```

Everything is point in time at V2's Tuesday 12:00 UTC freeze T: only games that kicked off before T are
read (asserted in `style.build`, `similar.build` and `residual.walk_forward`). No market column and no
provider win-probability column is read anywhere. No LLM is involved.

## 1. Plays and league expectation models (game-state adjustment)

`style.extract_plays(S)` applies V2's cleaning: possession known, provider duplicates out, V2's
DECLARED garbage rule by quarter and margin (never WP). Garbage plays are flagged and excluded from
every style sum.

Two league expectation models are fit on the **three seasons before S**. The 2009-2011 burn-in is
pooled for seasons ≤ 2011; those seasons only feed priors and variance components.

- **`xpass`**: P(dropback) on downs 1-3. The logistic design has 23 declared terms:
  - down;
  - log distance by down, plus flags for 10+ yards and goal-to-go;
  - field position (yards to the end zone, red zone, inside the 5, backed up);
  - margin, margin², trailing margin, and 4th-quarter margin × time;
  - quarter, clock, two-minute and trailing-in-the-two-minute flags, overtime.

  Sacks count as dropbacks; 2013 (sacks untagged) is excluded from training.
- **`xgo`**: P(go for it | 4th down), over go vs punt / field-goal decisions. Excluded: garbage time,
  and trailing in the last 5:00 of the 4th quarter (no real choice).

**Pass rate over expectation (PROE)** = (dropbacks − Σ xpass) / plays. It is what a team *chose* beyond
what down, distance, field, score and clock forced. PROE averages ≈ 0 league-wide by construction
(−0.004 in 2016).

**Neutral situation** (declared): \|margin\| ≤ 10, quarters 1-3, more than 2:00 left in the half.

## 2. Style vectors (sections 3-6, 38)

### 2.1 Team-game sums

`style.team_game_sums` produces one row per game and offense, as sums (never pre-divided), so
every rate below is an exact weighted ratio.

| metric | numerator / denominator | kind |
|---|---|---|
| `proe` | Σ(pass − xpass) / plays, downs 1-3 | behavior |
| `neu_pass` | passes / plays, neutral | behavior |
| `ed_proe` | PROE on neutral 1st-2nd downs | behavior |
| `pd_proe` | PROE on passing downs | behavior |
| `qb_rush_rate` | QB rushes / (dropbacks + QB rushes); a QB rush is a rush by a player with ≥ 2 dropbacks for the team in that game (kneel-downs excluded) | behavior |
| `tempo` | drive clock seconds / snaps, drives that start in a neutral state (≥ 3 snaps, capped at 60 s per snap) | behavior |
| `go_oe` | Σ(go − xgo) / 4th-down decisions | behavior |
| `qb_rush_epa` | EPA / QB rush | efficiency |
| `epa_early` | EPA / play on 1st-2nd down | efficiency |
| `epa_pd` | EPA / play on passing downs | efficiency |
| `third_dist` | mean distance on 3rd down (capped at 20); higher is worse for the offense | efficiency |
| `sy_conv` | conversions / attempts on 3rd-4th and ≤ 2 | efficiency |

V2's 24 stage-3 metrics complete the vector without duplication: pass / rush / overall EPA and success,
explosive rates, line yards, stuff, 5+ yard runs, front havoc, sack rate, turnovers, points per drive,
scoring opportunities, points per opportunity, starting field position, `pass_rate`, `plays_pg`,
`drives_pg` and special teams.

**Behavior (what a team chooses) and efficiency (how well it plays) are separate metrics and
separate vectors.** A 65% pass rate is not quality.

### 2.2 Opponent adjustment: the joint model, and the opponent response

Each style metric is fit with V2's own joint Gaussian solver (`ratings.fit_metric`) at every freeze T,
on the games before T:

    y(offense t, defense d, game) = mu + o_t + d_d + h * H + e,    Var(e) = s2_play / n + s2_game

The variance components come from the burn-in seasons only, exactly as in V2 stage 3.

For an efficiency metric, `d_d` is the defense's quality. For a **behavior** metric, `d_d` is the
**opponent response**: how much more or less offenses do this against this defense. For example,
offenses pass more against a strong run defense. The expected behavior of offense A against defense B is
therefore `mu + o_A + d_B (+ h)`. That is the expected play-selection model (section 6).

**style_mean = the posterior mean; style_sd = the posterior SD.** A team with one game sits near its
prior, with a large SD. A late-season team is data-driven, with a small SD (brief 38).

### 2.3 Priors and scheme continuity (sections 24, 25)

`style.style_prior` follows V2 `build_prior`: a ridge on the target seasons before S, where the
residual variance is the prior variance, with a pooled non-FBS prior. The design adds the
scheme-continuity interactions:

    lag1, lag2, lag1 x coordinator_change, coordinator_change, head_coach_new, lag1 x head_coach_new,
    returning production, lag1 x returning production, and missingness flags

`coordinator_change` = 1 − `oc_cont` for the offense and 1 − `dc_cont` for the defense (2015+). Columns
are standardized before the penalty. The first build penalized raw columns, which crushed the
coefficients of small-scale metrics: PROE's lag-1 came out at 0.10 instead of 0.62. That was found and
fixed before any backtest.

Prior coefficients for season 2024 (fit on 2010-2023; offense side; the effect of a coordinator or
head-coach change is on last season's carry-over):

| metric | lag 1 | lag 2 | lag1 × OC change | lag1 × new HC | lag1 × returning production |
|---|---|---|---|---|---|
| proe | +0.62 | +0.21 | −0.10 | −0.31 | +0.31 |
| ed_proe | +0.59 | +0.20 | −0.07 | −0.32 | +0.22 |
| pd_proe | +0.60 | +0.21 | −0.16 | −0.29 | +0.26 |
| neu_pass | +0.59 | +0.22 | −0.09 | −0.33 | +0.19 |
| tempo | +0.62 | +0.10 | −0.12 | −0.31 | +0.29 |
| qb_rush_rate | +0.59 | +0.21 | −0.13 | −0.21 | +0.51 |
| go_oe | +0.39 | +0.17 | +0.04 | −0.35 | −0.07 |

**A new head coach roughly halves how much of last season's style carries over. A new offensive
coordinator cuts it by about a sixth.** The current season's data takes over as games accumulate,
because the posterior weights data by its sample size. A coordinator change widens nothing by fiat; it
changes the prior mean, and the prior variance is estimated from the misses of the prior model.

### 2.4 Persistence study (dev seasons 2016-2023, FBS)

This is the year-to-year correlation of data-only final ratings, with each season demeaned.
`changes.persistence_study` gives the full table in `backtest_dev.json`.

| metric (offense) | all | coordinator kept | coordinator changed | new head coach | kept − changed [95% CI] |
|---|---|---|---|---|---|
| PROE | 0.74 (n 1033) | **0.83** (583) | 0.66 (253) | 0.43 (197) | +0.17 [+0.07, +0.30] |
| passing-down PROE | 0.70 | 0.81 | 0.56 | 0.38 | +0.25 [+0.13, +0.40] |
| neutral pass rate | 0.73 | 0.82 | 0.66 | 0.40 | +0.16 [+0.07, +0.27] |
| QB rush share | 0.73 | 0.81 | 0.63 | 0.49 | +0.18 [+0.06, +0.32] |
| tempo | 0.65 | 0.79 | 0.60 | **0.29** | +0.19 [+0.09, +0.30] |
| 4th-down go over expected | 0.44 | 0.52 | 0.47 | 0.15 | +0.05 [−0.08, +0.18] |
| early-down EPA (efficiency) | 0.54 | 0.56 | 0.63 | 0.33 | −0.07 [−0.17, +0.04] |

**Behavior follows the play-caller; efficiency does not.** Coordinator continuity significantly
raises the persistence of every run/pass and tempo metric, but not of efficiency. Defensive
"style" (the opponent response) is weakly persistent (0.13-0.30), so it is mostly noise.

### 2.5 Head coaches who changed schools (dev, n = 50)

Head coaches are named in `cfb_matchup_line`, so they can be followed. For each coach moving to a new
FBS school, is the new team's first-season style closer to the coach's old team or to the new team's
own last season?

| metric | corr with the new team's last season | corr with the coach's old team | joint coefficient: team / coach |
|---|---|---|---|
| PROE | 0.29 | **0.66** | 0.28 / 0.62 |
| early-down PROE | 0.33 | **0.70** | 0.36 / 0.73 |
| tempo | −0.04 | **0.63** | −0.03 / 0.63 |
| 4th-down go over expected | 0.05 | **0.44** | −0.04 / 0.44 |
| QB rush share | 0.32 | 0.36 | 0.32 / 0.41 |

**Scheme travels with the head coach.** The prior does not use this yet: it would change about 6-8
teams a season, early season only. It is the top item on the research queue (DELIVERABLE §38). QB rush
share is split evenly between coach and roster, as it should be: it depends on the QB.

## 3. Interaction features (sections 7-15, 26-36)

`interactions.season_features`. Every feature is **home offense vs away defense minus away offense vs
home defense**, so + favours home. Swapping the teams negates it (tested on synthetic and real rows).

Standardization: z = sign × rating / scale. The scale is the robust between-team SD (IQR / 1.349) over
the three previous seasons, V2's `metric_scales` rule. So `z_off > 0` is a good offense and `z_def > 0`
is a defense that allows more. An "xm_" feature is a **compounding** term z_off × z_def: whether an
offense's strength is amplified by the defense's weakness beyond the additive V2 ratings. A "hinge_"
feature is the narrative quadrant only.

| family | features (definition) |
|---|---|
| pass_rush (7, 8) | `xm_epa_pass`, `xm_epa_rush`; `mix_exploit` = (expected pass share − league) × (defense pass EPA allowed − rush EPA allowed) × plays / 2: the offense attacks the defense's weaker phase; `rel_align` = offense's pass-vs-rush strength × defense's pass-vs-rush weakness |
| protection (9, 13) | `xm_sack`; `hinge_sack` = −relu(sack-prone offense) × relu(strong pass rush); `xm_havoc` |
| qb_mobility (9, 10) | `qbr_contain` = (expected QB rush share − league) × defense QB-rush EPA allowed; `qbr_vs_rush` = QB rush share z × pass-rush strength (mobility vs an aggressive rush); `edge_qb_rush_epa` |
| explosive (11, 12) | `xm_expl_pass`, `xm_expl_rush`, `hinge_expl_pass` = relu(explosive offense) × relu(leaky defense) |
| trench (13) | `xm_line_yds`, `xm_stuff`, `hinge_stuff` (run_block_edge; pass protection is the separate protection family) |
| early_down (14) | `edge_epa_early` (a metric V2 does not have), `xm_epa_early` |
| passing_down (15) | `edge_epa_pd`, `xm_sr_pd`, `pd_burden` = expected 3rd-down distance (behind schedule) × passing-down matchup |
| finishing (16, 31) | `edge_pts_per_opp_v`, `edge_so_rate_v` (V2 ratings; the 'drive' family was not selected into V2.1's C/D), `xm_pts_per_opp` |
| pace (17, 28, 29) | `poss_x_strength` = V2.1 margin × (expected possessions − league) / league (slow-game compression); `tempo_edge` |
| field_pos (32) | `edge_start_fp_v`, `xm_start_fp` |
| fourth_down (30) | `edge_go_oe`, `go_x_sy` = aggressiveness × short-yardage matchup |
| short_yardage (33) | `edge_sy_conv`, `xm_sy_conv` |
| play_select (40-42) | `resp_corr` = defense's pass-rate response × offense's pass-vs-rush EPA advantage × plays / 2; `proe_resp_corr` (the same with the PROE response) |
| drive_model (22, 43) | `drive_div` = V2's own possession model (E_drive, walk-forward) − the V2.1 ensemble |
| personnel (26, 27) | `inexp_x_rush` (inexperienced QB × strong rush), `qbchg_x_havoc` (QB change × havoc defense), `inexp_x_pd_burden` (inexperienced QB × heavy passing-down burden) |
| environment (34-36) | `alt_x_tempo`, `tz_x_tempo`, `home_x_sack` (crowd × sack-prone visitor), `home_x_tempo`. No weather: no archived forecasts |
| v2_existing (56) | V2.1's own 15 `match_*` / `x_*` inputs: the redundancy control |
| similar_opp (16-18) | `sim_resid_edge`, `sim_margin_edge`, `fam_edge` (section 4) |

Every narrative feature is oriented so that the narrative predicts a **positive** coefficient.
Symmetric variance features: `var_expl` (both explosive matchups), `var_to` (turnover rates),
`var_pace`, `var_qbr` (QB-run threats), `var_tempo_gap`, and `var_mixed` (public edges that disagree
with the general lean).

## 4. Similar-opponent engine (sections 16-19, 51, 62)

`similar.py`. Style vectors are standardized by metric scales and centred on the FBS mean at each T:

- **offense (12 dimensions):**
  - style: PROE, early-down PROE, passing-down PROE, tempo, QB rush share, go-over-expected;
  - V2 efficiency: pass EPA, rush EPA, explosive pass, explosive rush, sacks allowed, stuffs allowed.
- **defense (10 dimensions):**
  - V2: pass EPA allowed, rush EPA allowed, explosive pass, explosive rush, sack generation, havoc,
    stuffs;
  - style: QB-rush EPA allowed, PROE response, tempo response.

For team A facing B at T, every FBS-vs-FBS game A played before T is a comparison. This season's games
use the opponents' ratings at T; last season's games (at half weight) use last season's final freeze.

- A's **offense** is compared on the **defenses** it faced (vs B's defense).
- A's **defense** is compared on the **offenses** it faced.
- The whole team is compared on the full vector.

Similarity is a kernel on distance: s = exp(−d² / (2 h² k)).

**The outcome is opponent-adjusted:** V2.1's out-of-fold residual in each comparison game. The offense
side is points scored minus V2.1's expected points; the defense side is points allowed vs expectation,
from `pred_total` and `ens_pred`. It is never a win or a loss.

The matchup-specific part is `Σ w s (r − r̄) / (Σ w s + 3)`:

- `r̄` is A's own mean residual over the same games, so general form is removed;
- the 3 pseudo-games shrink thin evidence to zero.

**Metric and bandwidth.** These were chosen on dev only, from a declared grid. The criterion is the
walk-forward dev ΔMAE of the similar-opponent family:

| metric | h | dev ΔMAE |
|---|---|---|
| euclid | 0.50 | +0.0006 |
| **mahalanobis** (whitened by the covariance of dev final vectors) | 0.50 | **−0.0029** |
| cosine | 0.50 | +0.0013 |
| euclid | 0.35 | −0.0026 |
| euclid | 0.75 | +0.0004 |
| euclid | 1.00 | +0.0005 |

The whitening matrix is always built from the dev seasons, so a live one-season call uses the identical
matrix the backtest and holdout used. `tests_matchup` checks that the live hook reproduces the
backtest's features for a past freeze.

**Familiarity** (`matchup_experience_similarity`) is Σ s over A's past opponents per game: how much of
B's style A has actually seen.

**Similar-matchups table.** `similar.build(want_pairs=True)` → `cfb_similar_matchups` stores, per
target game and side, the top 3 comparisons with:

- the similarity score and feature distance;
- the 3 most similar and 3 most different features, with signed standardized differences;
- the comparison's residual;
- `eligible_pre_prediction`: the comparison kicked off before the target freeze (a server CHECK too).

`display_allowed` is false: no similarity level has validated predictive value (BACKTEST §10).

## 5. The matchup residual model (sections 19-20, 44-47, 57-58)

`residual.py`, `backtest.py`. The target is V2.1's out-of-fold residual r = margin − ens_pred. For
2014-2015 (no stack yet) the target uses V2.1's identical equal-weight C/D mean. V2.1 is never refit:
it stays the foundation.

- **Walk-forward.** The correction for season S is fit on seasons 2014..S−1 only (asserted). Seasons
  2016-2023 are scored as dev. 2015 is predicted from 2014 only, to seed λ.
- **Interpretable first.** `RidgeResid` is a ridge on standardized, ±4 SD winsorized features with
  **no intercept**. The features are centred on the training rows, so the correction has mean zero
  there: it cannot learn a home-field or bias shift, only matchup structure. The penalty is declared,
  not tuned: α = residual variance / τ² = 256 / 0.5² = 1024, a Gaussian prior that a matchup effect is
  about 0.5 points per SD. The conclusion does not depend on α (BACKTEST §3).
- **Nonlinear challenger second.** `GBMResid` is LightGBM:
  - depth-2 trees (4 leaves), learning rate 0.02, 150 rounds;
  - ≥ 300 games per leaf, L2 50, feature and bagging fraction 0.8;
  - seeded, deterministic, single-threaded;
  - centred on its training rows like the ridge.
- **Shrinkage by evidence (45).** The raw correction for season S is multiplied by λ_S. λ_S is the
  out-of-fold calibration slope of r on the raw correction over seasons before S, clipped to [0, 1]. If
  past corrections did not move the residual, λ = 0.
- **Hard cap (46)** at ±3 points, a documented safety only. The report counts how often it binds:
  0.7% of dev games for the shrunk all-families ridge; 7.7% of its raw corrections would exceed 3.
- **matchup_adjustment_points** = matchup-aware projection − general projection = λ × raw, capped.
- **Win probability** = V2.1's formula, `1 − F_t(−(ens + adj) / sigma; df_S)`, with V2.1's sigma and
  df. The identity against the stored `p_home_raw` is exact: max \|diff\| = 0.0.

**The pre-registered rule** (`backtest.PREREG`, written before any family was scored) says a family
VALIDATES only if, on dev 2016-2023:

1. the paired ΔMAE < 0 with its 95% bootstrap CI upper bound < 0;
2. ΔMAE < 0 in ≥ 5 of 8 seasons;
3. ΔRMSE ≤ 0.

Only validated families enter the combined correction, and the combination must pass the same rule. If
none validates, the artifact is **NO_ADJUSTMENT**. The holdout is scored once, after freezing.

**Variance (37).** `VarianceModel` is a Gamma GLM, log link, with offset log σ²_V2.1, on the symmetric
variance features. Its intercept is removed, so it reshapes σ across games rather than rescaling it.
It is evaluated by the t log-likelihood and 80% coverage, walk-forward.

## 6. Expected play selection and possessions (sections 21, 28, 40-43)

- **Expected pass behavior of offense A vs defense B** = `mu + o_A + d_B ± h`, from the joint model at
  T. It is evaluated against each team's actual neutral pass rate, PROE and tempo in the game, weighted
  by plays:
  - (a) own tendency only;
  - (b) + opponent response;
  - (c) + game script from V2.1's expected margin (γ walk-forward).
- **Expected possessions** = V2's `exp_drives_home + exp_drives_away` (the additive drives-per-game
  ratings), against a tempo-informed version.
- **Drive-model integration (43)**: `drive_div` tests whether V2's possession model disagrees with the
  ensemble in a way that predicts the residual.

## 7. Change points (sections 25, 39, 63)

`changes.py`. The game-level, opponent-adjusted style value is:

    x_g = observed rate − (league mean + the opponent's defensive response at that freeze)

with sampling variance from the variance components. This is computed for PROE, tempo, QB rush share,
and the defensive sack-generation rate.

After each game, the mean of the last 3 games is compared with the mean of the earlier games of the
season, as a z statistic; at least 3 games must come before the window. The |z| threshold is
**calibrated on dev by permuting game order within team-seasons** (the no-change null), so at most 5%
of team-seasons alarm per metric:

| metric | threshold |
|---|---|
| PROE | 3.08 |
| tempo | 2.80 |
| QB rush share | 3.37 |
| sack generation | 3.08 |

An event is dated at the first freeze after the triggering game; one event per team-season-metric.
Coordinator changes are preseason flags only. There is no mid-season play-caller feed.

## 8. Explanation, confidence, public edges (sections 47-51, 70)

`hook.explain` is number-only. For each side and each unit matchup (PASS, RUSH, EXPLOSIVE PASS /
RUSH, PROTECTION vs PASS RUSH, TRENCH, EARLY DOWN, PASSING DOWN, FINISHING DRIVES, QB RUN) it reports:

- the offense rating;
- what the defense allows;
- the league mean and the expected value vs league, in the metric's own units;
- the standardized z, and which team it favours.

From these it takes:

- **primary / secondary matchup edge**: the largest \|z\| matchups;
- **primary risk**: the largest matchup favouring the side V2.1 does not lean to;
- **public edges**: PASS / RUSH / TRENCH / HAVOC / EXPLOSIVE, V2's standardized `match_*` values,
  labelled "even" under 0.25 SD;
- **contradictory signals**: MIXED when public edges of both signs reach 0.5 SD. A mixed game says so
  instead of forcing a narrative.

With a NO_ADJUSTMENT artifact the note states that the fair line is the general line and that the edges
are descriptions, not a correction. No free text is generated.

`matchup_confidence` in [0, 1] is 0.30 style sample (games / 6) + 0.15 completeness + 0.20
similar-opponent coverage + 0.15 scheme continuity (fading with games) + 0.20 QB certainty. It is a
statement about the matchup layer's data, not football confidence and not an edge. It is declared, and
unvalidated because there is no correction to validate it against.

## 9. Weekly integration, Model Lab, database

**Hook.**

    hook.matchup_week(season, T, X_T, projections=None, art=None, history=None, want_similar=True, week=None)
        -> {'team_week_style': [...], 'game_matchup': [...], 'similar_matchups': [...], 'style_change_events': [...]}
    hook.table_rows(out) -> {table: [rows]}          # typed columns + payload, as a PostgREST mirror would insert
    hook.version_rows(art, decided_at)               # cfb_matchup_model_versions rows (no CHAMPION: a person decides)
    hook.lab_monitor(records, results)               # prospective: production vs shadow correction, by category / confidence
    hook.weekly_report(records, results)             # largest corrections, directionally right or wrong

The weekly engine calls `matchup_week` after its projection stage with `ctx['X']` (the stage-5 rows at
T) and its projections. Nothing is retrained weekly (59): the style ratings are recomputed point in time
and the frozen artifact is applied as is.

Each `game_matchup` record carries:

- general fair margin / spread, matchup adjustment, matchup-aware margin / spread;
- matchup confidence, primary / secondary edge, primary risk;
- expected possessions;
- expected neutral pass rate and tempo for each offense;
- matchup variance effect (1.0: the variance model was rejected);
- every feature value;
- the **shadow adjustment**: the frozen all-families ridge challenger, recorded but never applied, so
  the Model Lab can answer prospectively whether it would have helped.

**Database.** `supabase/cfb_matchup.sql` holds six append-only tables, with RLS, authenticated read,
service insert and no anon access:

- `cfb_team_week_style`, `cfb_game_matchup_features`, `cfb_similar_matchups`;
- `cfb_style_change_events`, `cfb_matchup_model_versions`, `cfb_matchup_monitor`;
- and three views.

Server rules:

- a snapshot must precede kickoff;
- a comparison must precede the target freeze;
- NO_ADJUSTMENT ⇒ adjustment = 0;
- \|adjustment\| ≤ 3;
- aware = general + adjustment;
- a statistical event must clear its threshold;
- CHAMPION needs a person and evidence.

It is tested against a real PostgreSQL, including the hook's own rows from a real 2026 freeze
(`football/cfb_matchup/fixtures/hook_rows.json`).
