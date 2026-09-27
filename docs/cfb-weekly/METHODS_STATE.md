# CFB weekly engine: team and QB state methods

Code: `football/cfb_v2/research/v2/weekly/team_state.py` and `qb_state.py`. Suite: `python3 -m
v2.weekly.tests_state`, or `--full` to add a full-season byte comparison. Contract:
[DESIGN.md](DESIGN.md).

This is **state updating, not retraining**. Every number below is either V2.1's own posterior or
arithmetic on it. Nothing here feeds the frozen model, and nothing changes a default of V2. The only
edits to V2 are small hooks that are off by default (section 1).

## 1. Hooks added to V2 (default off, output-identical)

| file | hook | purpose |
|---|---|---|
| `ratings.py` `solve` / `fit_metric` | `diag` (list), `x0` (CG start), `system_out` (dict) | convergence record per solve; the normal equations and the full inverse for the checks below |
| `ratings.py` | `conjugate_gradient`, `solve_diagnostics`, `start_vector` | the iterative cross-check |
| `build_ratings.py` `run` | `only_ts`, `diag`, `warm`, `explain`, `ctx`, `return_frames` | rebuild one freeze T in seconds, with the convergence record; `write=True` with `only_ts` merges those T into the season file |
| `build_ratings.py` `build_prior` | `explain` (dict) | the ridge coefficients and design rows behind each prior mean |
| `qb.py` `team_features` | `only_ts`, `detail`, `ratings`, `league` | one freeze; the per-QB posterior; freshly solved ratings instead of the stage-3 file |

When the hooks are off, the original code path runs unchanged. The season-independent setup moved
into `_setup()` at the same indentation, and the prior loop into `_season_priors()`.

**Proof (2026-09-27).** `ratings_2025`, `league_2025`, `varcomp.json`, `final_dataonly` and `priors`
were rebuilt three ways: with the original HEAD code, with the working tree on defaults, and with the
working tree and `diag` on. All three produce **byte-identical** files (sha256 `fdb250bd…`,
`99d01e03…`, `80ac04ce…`, `0808798d…`, `c7963251…`). They are also identical to the v2.1 build in
`out_h`. `qb.team_features` for 2025 gives byte-identical parquet from the original and the new
`qb.py`. A one-T `only_ts` merge-write reproduces the full season file byte for byte (`--full`).

## 2. Convergence record (stage 8)

Each solve of A x = b is recorded:

- **Residual:** the relative residual ‖Ax − b‖/‖b‖ of the direct solution.
- **Conditioning:** `np.linalg.cond(A)`, plus the condition number after Jacobi scaling.
- **Iterative cross-check:** a conjugate-gradient solve of the same system. It starts from the previous
  week's solution when one is given, and from the prior means otherwise. The record keeps the
  iterations, the maximum |x_cg − x_direct| (the delta), and the thresholds.

`converged` = residual < 1e-9, CG reached its tolerance, and delta < 1e-6 in rating units.

**Why CG is Jacobi-preconditioned, with an "evidence" tolerance.** Five metrics have their FBS prior
variance at the build_prior floor, 0.15 × 1e-8 × scale = 1.5e-9: st_net, fg_value, to_rate,
expl_pass, and sack_rate on the defence side. The burn-in between-team variance of these metrics
estimated to ≤ 0, so `true_var` hit its 1e-8 floor. Two consequences follow:

- cond(A) reaches 4e9 to 1.7e10.
- b carries 6.7e8 × prior mean on the pinned rows.

Measured relative to ‖b‖, a 1e-10 tolerance leaves every other row unresolved: CG stops early with a
delta of about 1e-5. The fix has two parts:

- CG runs on the symmetrically scaled system S A S (S = diag(A)^-½). This is plain CG, equivalent to
  Jacobi PCG; scaled conditioning is at most 112.
- It stops at ‖S(b − Ax)‖ ≤ 1e-10 ‖S(b − A m)‖, with m = the prior means. In other words, the
  residual is measured relative to the evidence the data add to the prior; this is CG on the
  deviation from the prior. The reference is floored at 1e-4 ‖S b‖. That floor matters only at a
  season's first few games, where the evidence is below round-off.

**Results:** 2016, 2020, 2023, 2025 and 2026, every freeze, both horizons (5,488 records, of which
5,208 are solves):

- All converged. The three season-opening st_net records that first failed on round-off were
  re-verified after the floor was added.
- Maximum relative residual 1.4e-14.
- Median 16 CG iterations, maximum 34.
- Maximum delta 5.5e-8.

A freeze with no game yet records `solved: False, converged: True`, because the posterior is the
prior.

## 3. The points scale

Everything is expressed in points per game against an **average FBS team on a neutral field**. The
average FBS team is the FBS mean of every rating at T. The conversion is V2's own
(`snapshots.eff_pts_raw` = net EPA edge × `exp_plays_total` / 2):

- p_t = mu_plays + ½(o_plays,t + d_plays,t + ō_plays + d̄_plays). These are expected plays per team, V2's
  symmetric P/2.
- offense_mean = (o_epa,t − ō_epa) × p_t.
- defense_mean = −(d_epa,t − d̄_epa) × p_t. Positive means a better defence.
- pass_off = (o_epa_pass − ō) × dropbacks and rush_off = (o_epa_rush − ō) × rushes. Dropbacks =
  clip(mu_pr + o_pr,t + d̄_pr, 0.2, 0.8) × p_t. pass_def and rush_def use the average FBS offence's
  pass rate against t. Splits do not add up to offense_mean: per-play EPA and the split rates are
  separate ratings.
- st_mean = ½[(o_st − ō) − (d_st − d̄)]. st_net is one zero-sum net per team-game. V2's `edge_st_net`
  differences both teams' nets, which counts it twice, so the team's expected net is half of that.
- overall = offense + defense + st.

`offense + defense` equals `eff_pts_raw` for a game against the FBS-average team exactly (a test).

**Scale check.** On dev FBS-vs-FBS games (n = 5,922), the realized margin is 1.14 × eff_pts_raw − 0.94.
V2's EPA-points are therefore slightly compressed relative to scoreboard margins, not inflated.

**Before any game.** mu for pace and pass rate is not identified yet. The fallback is the previous
season's FBS means, which are point-in-time.

**Uncertainty (delta method).**
- Var(e·p) ≈ p² var(e) + e² var(p), from off_var / def_var.
- Each rating is treated as independent: no covariance between a team's offence and defence, none with
  the FBS reference mean, none with the league means, and no second-order var(e)·var(p) term. Metrics
  are separate posteriors in V2, so cross-metric covariance is zero by construction.
- Quantified with the full inverse of each metric at 2025-10-14:

  | unit | FBS max error | FBS median error | FCS max error |
  |---|---|---|---|
  | offense | 1.0% | | |
  | defense | 0.7% | | |
  | st | 0.6% | | |
  | overall | 1.1% | +0.85% (slightly conservative) | 0.4% |

  The offence/defence covariance contributes a median −0.18 points² to the overall variance.

**FCS teams** share the pooled FCS prior, whose tau2 = the variance of three seasons of FCS data-only
ratings × scale. They are rated only through their one or two games against FBS teams. Their SD is
reported as the posterior gives it: at 2025-10-14 the FCS median overall SD is 18.4 points, against
7.4 for FBS. They are flagged `thin_data` with the reason. The same flag applies to any team with fewer
than 3 games, or whose prior is still above 50% of its offence or defence precision.

## 4. Recent form and trend flags (descriptive, never inputs)

`recent_strength` is the same points state on V2's recent horizon (`off_rec` / `def_rec`). Every
observation and the prior are weighted 0.5^(age / 8 weeks). The 8-week half-life is V2's tuned value.
In `report/tuning_ratings.json` (dev 2016–19, 2021–22), the recent-vs-season next-game MSE ratio is
0.998 at 8 weeks against 1.058 at 2 weeks. Pace uses the season horizon in both, so
`recent_minus_season` isolates efficiency.

**Null distribution.** Both horizons are linear in y: x = A⁻¹(X'Wy + Πm). Under "no change"
(y ~ N(Xθ, W_season⁻¹)), the difference has covariance M W_s⁻¹ M', with M = A_r⁻¹X'W_r − A_s⁻¹X'W_s.
Its mean is A_r⁻¹(X'W_rXθ + Π_r m) − A_s⁻¹(X'W_sXθ + Π_s m), evaluated at θ = x_season. The mean is
not zero because the recent horizon lets the prior decay. The flags use the resulting
z = (diff − bias)/SD:

- **OFFENSE_IMPROVING / DECLINING, DEFENSE_IMPROVING / DECLINING:** |z| > 2 with at least 4 games. At
  2025-10-14 exactly one team is flagged; the flags are deliberately rare.
- **VOLATILITY_RISING:** the residual SD over the last 4 games, shrunk as `residual_volatility` (k = 3),
  against V2's season `vol`. z > 2 with an approximate SE of vol/√(2(m − 1 + k)), and at least 6 games.
- **QB_STABILIZING:** from qb_state. The expected starter has 3–5 straight starts after another QB
  started this season, and was not benched in the latest game.

`volatility` is V2's `vol` for epa × p_t, in points.

## 5. Prior-decay accounting (accounting only; EXP-003 stays a planned experiment)

For each team × metric × side, **prior_weight = prior precision / posterior precision =
posterior var / tau2**. This is the share of the posterior precision the preseason prior still
contributes.

- Adding data only adds a PSD term to the precision matrix, so prior_weight never rises in the season
  horizon. The suite checks this for every FBS team on epa, epa_pass and plays_pg.
- A typical team's epa offence falls 1.00 → 0.68 → 0.50 → 0.44 → 0.36 → 0.29 → 0.27 across 2025.

**Decomposing the prior mean.** The prior **mean** is build_prior's ridge, intercept + Σ β_j x_j. The
terms are grouped into:

- program history: lag1, lag2;
- returning production: ret, lag1×ret;
- roster talent: talent_z;
- coaching change: hc_new, lag1×hc_new;
- unit change: coordinator change;
- missing data: the missingness flags.

The group terms are centred on their FBS means; the intercept cancels on the points scale.
`effective_weight_g` = prior_weight × |centred g| / Σ|centred|. Two identities are tested: the group
terms plus the intercept reproduce the prior mean (error < 1e-9), and the effective weights sum to
prior_weight. FCS teams report `fcs_pool`. `prior_accounting()` returns the full long table for all 28
metrics.

## 6. Special teams

V2's st_net prior scale is 1.0. For FBS teams, however, **tau2 sits at the 1.5e-9 floor** (section 2),
so V2's FBS special-teams rating is fixed at its preseason ridge prior all season. Its posterior SD,
about 3e-5 points, reflects the floor, not real uncertainty. The same holds for fg_value, to_rate,
expl_pass and defensive sack_rate.

**Synthetic blocked-punt test:** +14 EPA for the team and −14 for the opponent, one neutral game just
before 2025-10-14, 6 games already played.

| prior | Alabama (FBS) move | FCS team (1 game) move |
|---|---|---|
| production (scale 1.0) | 3.6e-10 points | +1.76 (12.5% of the shock) |
| data-driven tau2 = 2.74 (last season's between-team variance, no floor) | +0.46 (3.3%) | +0.75 |
| flat, tau2 = 1e6 | +1.73 (12%) | +10.6 (76%) |

So the prior does prevent an absurd move, but for FBS teams it prevents every move. This is a
research item (the tau2 floor), not a change made here.

## 7. Home field

`hfa` is V2's league h in points: 2·h_epa·p_t (both units gain h per play; eff_pts_raw's 2h) plus
h_st_net. `hfa_by_metric` gives epa, epa_pass, epa_rush and st_net in points; the raw h of all 28
metrics is in `convergence['league']`. At 2025-10-14, h × plays ≈ 4.9 points. For reference, over dev
seasons the mean V2 h×P was 3.2 and the mean FBS home margin 4.05.

**V2 has no team-specific HFA**; a team or venue effect would be a model change. The evidence is
reported, never used, in `hfa_team_evidence_pts`:

- η_t = (mean home net residual − mean away net residual)/4 per play, from the season epa residuals,
  where net = offence residual − defence residual.
- η_t is shrunk across FBS teams by empirical Bayes (τ² = var(η̂) − mean(se²), floored at 0).
- It is converted to points as η_t × 2 × p_t.

## 8. Explanations: why a team moved

The change x(T) − x(T_prev) of epa and st_net is split by **genuine conditional re-solves**. Each step
re-solves a team's block given everything else, as (π μ_p + Σ w (y − mu − hH − other)) / (π + Σ w).

1. Old games (kicked off before T_prev) at the T_prev solution. This reproduces x(T_prev) exactly;
   the fixed-point check is < 1e-15.
2. Old games, opponents re-solved at T → **opponent re-adjustment**.
3. Old games, mu and h re-solved → **league/HFA shift**. The FBS reference mean moving is added here.
4. All games at T. This reproduces x(T). The step from 3 to 4 is the team's own new games, split
   exactly into:
   - **prior decay** = (λ_all − λ_old)(μ_p − r̄_old), the prior's weight λ = π/(π + W) falling;
   - **new evidence** = (1 − λ_all)(r̄_all − r̄_old), the data mean moving.

On the points scale, Δ(e·p) = Δe·p₁ + e₀·Δp. The e₀·Δp part is reported as **pace**.

The identity is exact: components sum to the change with a closure below 1e-9, tested for every team.
It is **path-dependent** (opponents, then league, then own games), and it is labelled as such. The
season-horizon prior is fixed within a season, so "prior decay" means the data outweighing it, never
the prior changing. Each explanation also reports the movement of the mean **and** the SD. When `prev`
rows are given, they are checked against the T_prev re-solve (< 1e-9).

## 9. Last week's posterior is this week's prior

`sequential_equivalence(season, T_prev, T)` takes the full posterior (x₀, Σ₀ = A₀⁻¹) at T_prev as the
prior. It updates with only the rows of games between T_prev and T, using the same weights; the h and
team priors are already inside Σ₀. The update uses the Kalman / covariance form, which never forms the
batch system:

K = Σ₀X₁'(X₁Σ₀X₁' + W₁⁻¹)⁻¹,  x = x₀ + K(y₁ − X₁x₀),  Σ = Σ₀ − KX₁Σ₀

The result is compared to the batch posterior at T, season horizon, all 28 metrics.

- **2025-10-07 → 2025-10-14:** max |mean difference| 2.5e-13, or 9.2e-11 posterior SDs; max relative
  variance difference 8.2e-15.
- **Synthetic:** < 1e-10.

The recent horizon is not sequential, because its weights re-decay with T.

## 10. Movement guardrails

`movement_flags(rows, prev, explanations, k=transition_index(season, T))` raises two flags:

- **MOVE_ABOVE_P995**, when |overall change| exceeds the historical p99.5 weekly move;
- **SD_COLLAPSE**, when 1 − sd/sd_prev exceeds its p99.5.

Each flag names up to three drivers (components ≥ 0.05 points) from the explanation. The bounds are
constants in `MOVE_BOUNDS`, from `estimate_movement_bounds()` on dev 2016–2023: every consecutive pair
of freezes, from the prior-only freeze on, 20,018 FBS and 12,491 FCS team-transitions.

Provenance: the stage-3 ratings were rebuilt with this code on 2026-09-27. They are byte-identical to
the v2.1 build, and the file hashes are stored with the constants.

| | pooled | k=1 | k=2 | k=3–4 | k=5–7 | k=8–11 | k≥12 |
|---|---|---|---|---|---|---|---|
| FBS abs move p99.5 (points) | **5.10** | 5.39 | 6.61 | 5.80 | 4.83 | 4.13 | 2.83 |
| FBS SD drop p99.5 | **13.4%** | 15.1% | 16.1% | 10.0% | 8.1% | 8.7% | 5.8% |
| FCS abs move p99.5 | 18.4 | 8.7 | 29.0 | 22.6 | 16.1 | 6.3 | 6.9 |

k = the season's transition index; k = 1 is prior → first games. The bucketed bound is used when k is
given, because a pooled bound would never flag a late-season move.

## 11. QB state

**Model.** V2's QB model is reused as is, through `qb.team_features(..., detail=)`:

- per-QB rating = (Σ decayed w·adj + k·repl)/(Σ w + k);
- k = 150.57 dropbacks, repl = −0.0566 EPA/dropback;
- estimated by `qb.estimate_shrinkage` on 2009–2013, exactly as `qb.main`, and never re-tuned.

`posterior_value` is that rating. `posterior_sd` = √(s²/(n_eff + k)) with s² = 2.7646, the per-dropback
noise variance. This is the conjugate posterior variance, treating the season-decayed dropback weight
n_eff as the count. It is an approximation, because decay discounts old dropbacks like a power prior.
`adj_epa_db` is this season's raw opponent-adjusted EPA/dropback. The expected starter is V2's rule
(the starter of the team's latest game), and the code asserts it equals `team_features`.

**From play-by-play**, with stage 1's filter and garbage weight 0:
- `rush_contribution`: QB rush EPA per game, rushes by the passer's id;
- `explosive_pass_rate`;
- `turnover_proxy` = (INT + lost fumbles) / action plays. A lost fumble with no fumbler id counts only
  on the QB's own sack or rush. About 28% of lost fumbles lack an id, so the proxy undercounts.

A missing value is null with a reason in `null_reasons`. A passer is a QB row if he started, or has at
least 10 dropbacks, or at least 5% of the team's dropbacks; trick-play passers are excluded.

**Starter probability.** P(the latest starter starts the next game) by:

- n_last = games in the window (up to 3);
- k = his starts among them;
- benched = a reliever took ≥ 40% of the latest game's non-garbage dropbacks.

Fitted on dev 2016–2023 (11,631 transitions), each cell shrunk toward its benched / not-benched group
rate with 20 pseudo-counts:

| window | not benched | benched |
|---|---|---|
| started all 3 | 0.927 | 0.341 |
| started 2 of 3 | 0.840 | 0.284 |
| started 1 of 3 | 0.715 | 0.143 |
| (1 game) | 0.906 | 0.272 |
| started both of 2 | 0.920 | 0.313 |

Starter continuity drifts down by season: 0.879 of transitions kept the starter in 2016, 0.828 in 2023.
The cells are therefore shifted by one **in-season level** δ on the logit scale. δ is the MAP over this
season's transitions already resolved before T, with a N(0, 0.1²) prior. The 0.1 was chosen by
walk-forward log loss on dev 2019–2023, over {none, 0.1, 0.2, 0.3, 0.5}.

When the starter changes, the complement goes to the top backup (68.3%), other QBs seen this season
(20.2%) and an unlisted QB (11.5%, `p_unlisted_starter`).

**Calibration on held-out 2023** (the table fitted on 2016–2022, applied point-in-time):

| measure | value |
|---|---|
| transitions | 1,577 |
| ECE | 0.029 |
| calibration slope | 0.94 ± 0.064 |
| mean predicted / observed | 0.844 / 0.828 |
| Brier | 0.1098, against 0.1437 for the constant rate |

One cell misses: "started both of the first two games" was 0.841 in 2023 against a predicted 0.93
(3.5 SE). Every earlier dev season was 0.89–0.96, so this was a 2023-specific shock that the level
shift only partly absorbs.

**Events** relate to the team's latest game, with `fresh` = it kicked off after the previous freeze:

- **NEW_STARTER:** his first start for this team in the 2009+ record.
- **TRANSFER_STARTER:** a new starter with earlier starts for another team, matched by the ESPN athlete
  id across teams and seasons.
- **RETURNING_STARTER:** started earlier this season, missed at least one start, back.
- **INJURED_STARTER** (`inferred`): the previous starter has no dropback in the latest game and was not
  benched in his last start. No injury report is read.
- **BENCHING:** a reliever took ≥ 40% of the dropbacks while the starter had dropbacks. An in-game
  injury looks identical in play-by-play.
- **MULTI_QB_ROTATION:** at least two QBs each with ≥ 30% of the dropbacks over the last 3 games.
  `same_game_sharing` separates a platoon from a starter switch inside the window.
- **AMBIGUOUS_STARTER** (`review`): starter probability < 0.60, or a rotation with at least two
  different starters in the window.

FCS teams appear only in games against FBS teams, so their QB history, and therefore their
NEW/TRANSFER events, is unreliable.

**Uncertainty inflation, not a new mean.** When the expected starter is not the season's dropback
leader (V2's `qb_changed`), the team's offence gains Var(θ_exp − Σ s_j θ_j) = (1 − s_e)² v_e +
Σ_{j≠e} s_j² v_j. Here the s_j are season dropback shares and the posteriors are independent; the
result is multiplied by expected dropbacks² for points². team_state reports `offense_sd_with_qb`.
**The offence mean is never rewritten.**

## 12. Point-in-time, determinism, runtime

- **Point-in-time:** only games with kickoff < T are read. The suite changes every stat of every game
  at or after T, moving one game to exactly T, and flips future QB starters. It then rebuilds
  everything from scratch, including V2's burn-in, finals and priors. Every team row and QB row/event
  at T is identical, while a later freeze changes.
- **Determinism:** each row carries `row_hash`, the canonical content hash. Two builds give identical
  hashes, and CG has no randomness.
- **Runtime** (one T, 4 vCPU):

  | case | time | notes |
  |---|---|---|
  | cold | about 40 s | about 25 s is V2's one-time setup: burn-in variance components, 16 seasons of data-only finals, priors |
  | warm (same process) | about 13 s | the T_prev and T solves with the record (8 s) and QB state (4 s) |
