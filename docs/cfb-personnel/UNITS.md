# CFB personnel — player values and the non-QB units (`cfb_personnel_values_v1`, `cfb_personnel_units_v1`)

Code: `football/cfb_v2/research/v2/personnel/{values,units,backtest_units,backtest,tests_units}.py`.
Outputs: `$CFB_V2_OUT/personnel/` (`values_constants.json`, `units/*.json|parquet`, caches under `cache/`), with
`CFB_V2_OUT = research/out_h` (the V2.1 build). Contract: [DESIGN.md](DESIGN.md). Data limits: [AUDIT.md](AUDIT.md),
[METHODS_FOUNDATION.md](METHODS_FOUNDATION.md). The QB layer is [QB.md](QB.md) (another component).

```
cd football/cfb_v2/research
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out_h OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
python3 -m v2.personnel.backtest_units --all       # constants, panels, dev backtest, ablation, PVAR, live (~20 min cold)
python3 -m v2.personnel.backtest_units --holdout   # the holdout 2024-2025, ONCE (refuses to re-score)
python3 -m v2.personnel.backtest                   # BASE vs +QB vs +QB+OL vs +ALL (dev); --holdout once
python3 -m v2.personnel.backtest_units --report    # every table below, as markdown
python3 -m v2.personnel.tests_units [--fast]       # --fast: synthetic, no data dirs
```

@@VERDICT@@

## 1. Player value at T (`values.py`)

**PVAR** = points per game above replacement, with an SD. One normal–normal model per component:

- observations per exposure unit `x ~ N(θ, σ²/n)`; a player first seen has `θ ~ N(repl, τ²)`;
- posterior mean `(n·x̄ + k·repl)/(n + k)` with **k = σ²/τ²** — the spec's shrinkage toward the replacement level, with
  k from split-half reliability;
- between seasons (Kalman step) `θ' = μ + ρ(θ − μ)`, `v' = ρ²v + τ²(1 − ρ²)`: **ρ_stay** on the same team,
  **ρ_transfer** after a team change (the transfer translation), ρ^gap across missing seasons;
- value rate = posterior − repl; SD = sqrt(posterior var + var(repl));
- PVAR = value rate × exposure per game × points per unit.

| component | exposure | total | centred | points per unit | families | columns required |
|---|---|---|---|---|---|---|
| RB_rush | non-garbage carries (games with no dropback) | non-garbage rush EPA | yes | 1 (EPA) | RB | — |
| WR_rec / TE_rec | non-garbage targets | non-garbage receiving EPA | yes | 1 | WR / TE | — |
| FRONT_sack | team games from his first sack for the team | sacks (split = ½) | no | V_sack = 1.871 | EDGE DT DL_OTHER LB | `def_sacks` RELIABLE |
| SEC_int | team games from his first event | interceptions | no | V_int = 4.370 | CB S DB_OTHER | `def_ints` RELIABLE |
| SEC_pbu | team games from his first event | break-ups | no | V_pbu = 1.162 | CB S DB_OTHER | `def_pbu` RELIABLE |
| K_fg | FG attempts | 3 × (made − p(distance)) | no | 1 | whoever kicks | — |
| K_xp | XP attempts | made − 0.9724 | no | 1 | whoever kicks | — |
| P_net | punts | net punt yards | yes | EP/yard = 0.0724 | whoever punts | — |
| OL | — | — | — | — | — | **no player data: NOT_ESTIMATED** |

Definitions:
- **Centred**: an efficiency is centred by its family's league mean per event of its own season. At T that is the
  season to date, blended with last season by 2,000 pseudo-events. Receiver-id coverage (69–95% by season) therefore
  does not move levels across seasons.
- **Replacement** = the pooled centred efficiency (or rate) of low-usage player-seasons, dev seasons 2016–2023:
  players outside the team-season's usage slots (rank > 1 RB, > 3 WR, > 1 TE, > 4 front / secondary producers, > 1
  kicker / punter) with exposure ≥ 5 (≥ 3 for rate components and FG). These are the backups who take the snaps.
- **Split-half**: a player's games (player × team × season) alternate between two halves.
  - σ² = Σ(x̄₀ − x̄₁)² / Σ(1/n₀ + 1/n₁);
  - τ² = the weighted covariance of the halves;
  - r = Pearson of the halves at the listed minimum exposure per half.
- **Persistence**: ρ = cov_w(x_{S−1}, x_S)/τ² over consecutive player-seasons (S in dev), disattenuated by the
  split-half τ². Used values are clipped to [0, 1], and ρ_transfer is capped at ρ_stay.
- **Play values** (dev plays):
  - V_sack = mean EPA of a non-sack dropback − that of a sack;
  - V_int / V_pbu likewise for pass attempts;
  - EP/yard = −slope of EP_start on yards to the end zone, 1st-and-10 between the 20s (n = 394,289).
  - EP_start and EPA do not read the market; the provider's WP columns do and are never requested.
- **FG model** (dev, 19,884 attempts): logit p = 0.792 − 0.860 z + 0.090 z², z = (distance − 40)/10.
  - SEs: 0.023, 0.021, 0.021.
  - Made / model by distance: ≤29 yd 0.911 / 0.908 (n 5,958); 30–39 0.775 / 0.782 (6,483); 40–49 0.620 / 0.610 (5,830);
    50+ 0.451 / 0.470 (1,613).
  - XP make rate 0.9724 (n 42,778).
- **Defensive participation is not observed.**
  - A defender's production rate uses the team games from his first recorded event for the team. This is a
    lower bound when he misses games.
  - Replacement is measured on *visible* low producers (players with at least one event). Players who recorded
    nothing are invisible, so repl is biased up and defensive values down.
  - A defensive value exists only when `usage.reliability(season, T)` says RELIABLE for its column at T.
  - INSUFFICIENT (< 20 team-games before T) → prior seasons only. UNRELIABLE → **null with a reason**
    (`def_ints:column_UNRELIABLE_at_T`); the unit is uncertainty-only.
  - Secondary values therefore exist in 2009–2020 (INT + PBU), 2024 (INT) and 2025–26 (PBU), never 2021–2023.

### 1.1 Estimated constants (dev 2016–2023; 1,000 bootstrap resamples over player-seasons, seed 20260927)

@@CONSTANTS@@

Reading the table:
- **Skill efficiency is mostly noise at the player level.** Split-half r is 0.19 for RB at 69 carries per half,
  0.19 for WR at 33 targets per half, and 0.13 for TE. A season of 200 carries is shrunk 45% of the way to
  replacement (k = 163). The true-talent SD is 0.089 EPA/carry for RB and 0.162 EPA/target for WR.
- **The replacement gap is small for RBs** (−0.016 vs +0.017 for starter slots) and **larger for WRs**
  (−0.072 vs +0.027).
- **Transfers.** Efficiency follows a skill player across a team change as much as it persists on the same team:
  - ρ_transfer RB 1.26 [0.68, 1.90] (n 221), WR 0.81 [0.29, 1.30] (315), TE 2.65 (57, uninformative);
  - these are capped at ρ_stay (0.91 / 0.66 / 0.81);
  - the skill player's efficiency is not mostly team context.
  - Front-seven sack rates do **not** travel: ρ_transfer 0.34 [0.10, 0.57] (n 202) vs ρ_stay 0.74 [0.65, 0.83].
    That is a role / scheme effect.
  - Secondary transfers are too few (7 INT, 31 PBU pairs).
- **Specialists.**
  - Kickers: backups are much worse (−0.34 points per FGA below expectation vs +0.04 for primary kickers).
  - Punters: backups lose 2.1 net yards per punt.
  - ρ for K_xp is 1.31 (clipped to 1): XP accuracy is a stable trait, but its variance is tiny (τ = 0.014 points per
    attempt).

`values.fill_state(state, season, T)` fills the foundation's placeholders:
- `player_value_mean` / `player_value_sd` = PVAR summed over the player's components;
- `replacement_value` = 0 (the value is above replacement);
- `value_model` = `cfb_personnel_values_v1:<components>`;
- `value_status` = ESTIMATED, `NULL: <reason>`, NOT_ESTIMATED (OL) or NOT_MODELLED.

## 2. Units (`units.py`)

Groups:

| group → unit | kind | members | usage | rating metric of the baseline |
|---|---|---|---|---|
| RB → RB | share | RB family | non-garbage carries / team attributed carries | epa_rush, offence |
| WR_TE → WR_TE | share | WR, TE | non-garbage targets / team attributed targets | epa_pass, offence |
| K → ST | share | whoever kicks | FG + XP attempts / team attempts | fg_value, offence |
| P → ST | share | whoever punts | punts / team punts | st_net, offence |
| FRONT7 → FRONT7 | presence | EDGE DT DL_OTHER LB | production (sacks), only if RELIABLE at T | epa_pass, defence |
| SECONDARY → SECONDARY | presence | CB S DB_OTHER | INT and / or PBU, only if RELIABLE at T | epa_pass, defence |
| OL | uncertainty only | — | — | — |

**The delta** (DESIGN rule 2): `Δ = Σ_p (upcoming_p − baseline_p) × V_p`.
- V_p is the player's value per game at the group's full usage (share groups: value per event × the team's events
  per game) or at full presence (defence).
- Presence groups exist because a production share is not participation. Losing a defender costs his production
  above a replacement's; redistributing a sack share among teammates would conserve sacks and show no loss.
- Variance: Σ(up − base)² × sd_p², plus p(1 − p)(h·V)² for each probabilistic status.

**Baseline lineup = `rating_lineup_context`** — the lineup V2.1's ratings represent, built with the rating's own
weights. Verified against `ratings.py` / `build_ratings.py`:

- **Season horizon.** Every game is weighted by w_g = 1/(s²_play/n_g + s²_game) (stage-3 `varcomp.json`).
  - For the rate metrics s²_game ≈ 1e-6, so w_g ∝ n_g: each non-garbage play counts once.
  - Garbage plays have weight 0 in stage 1, and the shares here are non-garbage.
  - The preseason **prior** enters with precision 1/τ² (`priors.parquet`).
- **Recent horizon.** Games and the prior are decayed by 0.5^(age/8 weeks) (`C.RECENT_HALFLIFE_WEEKS`). The
  prior's age counts from season start = first kickoff − 3 days, as in `build_ratings`.
- **The prior's share of the posterior** is π = (1/τ²)/(1/τ² + Σw) per horizon (the one-team form of `ratings.solve`).
  - Check against the joint solve's off_var(T)/off_var(T0), epa_pass, 2019, 60 FBS teams × 5 freezes:
    correlation @@PICHECK@@ (`tests_units: pi_one_team_matches_joint_solve`).
  - The prior is large: mean π_season 0.85 and π_recent 0.81 over the backtest's team-freezes.
- **The prior's lineup** = last season's shares at the team of the players who **return**. A returning player is
  listed on this season's roster for the team or has been seen for it before T.
  - Departed players count as replacement (V = 0), because V2's prior already discounts departures through
    returning production.
  - This proxy is the weakest link (§4).
- baseline_p = ½[π_s·prior_p + (1 − π_s)·data_s,p] + ½[π_r·prior_p + (1 − π_r)·data_r,p]. The artifact reads both
  horizons (edge_* and edge_rec_*).
  - data_s,p = Σ w_g s_pg / Σ w_g.
  - data_r,p = the same with w_g × decay.

**Upcoming lineups** (share groups):
- **History expectation** e_p: the EW share over the team's games (state.py's per-family half-lives: RB 0.75, WR 1.5,
  TE 2, K / P 1.5 games; a missed game counts 0). It equals `player_week_state.expected_usage_share`
  (`tests_units: panel_history_share_equals_state_expected_share`).
- **Healthy share** h_p: the same EW over the games he was used in.
- p_hist = e_p/h_p, exactly.
- **Conditioning, not multiplying.** With a report status of play probability p: a_p = p × h_p (the report
  replaces history's absence rate). With UNKNOWN: a_p = e_p (history, which is below healthy).
  - Multiplying p × e_p would count the absence probability twice.
  - The starter probability is conditioned the same way: min(1, p × sp/p_hist).
- **Redistribution.** The group keeps its total share. Missing mass goes (1 − λ) pro rata to the available players
  and λ to an unseen replacement (V = 0).
  - **λ = @@LAMBDA@@** (dev; matched on the team's games before T). Nearly all of an absent player's usage goes to
    players already in the lineup list.
  - The unmatched comparison came out negative, because new players appear mostly in September.
- **Week 1.** Lineups are last season's players at the team who return. The unit total is the returning players'
  healthy shares; departed usage goes to unseen replacements.

**Variants of the delta.**

| variant | upcoming | reference | computable pregame? |
|---|---|---|---|
| `pregame` | e (history) | baseline | yes, every game |
| `report` | report-conditioned lineup | baseline | from a published report (2026 conference games) |
| `oracle` | hindsight absences (below) | baseline | no — an upper bound on a perfect report |
| `oracle_naive` | hindsight absences | the full-health lineup | no (the double-count ablation) |
| `*_use` | as above | as above | the **usage-revealed value** V_use = h × events per game |
| `report_absence_use` | known absences only (reported players), others healthy | the full-health lineup | from a report; its oracle analogue is `oracle_naive_use` |

**Oracle absences** (hindsight; labelled as an upper bound on what a pregame report is worth):
- **Skill.** A player whose healthy share implies ≥ 4 usage events in the game records none, in a game the team
  played. P(no usage | plays) ≤ e⁻⁴ ≈ 2% under a Poisson count.
  - In-season absences only for the headline sets: the player appeared for the team this season before T.
  - A **unit change** = a *new* absence, 1–2 games old: the change the rating has not absorbed.
- **K / P.** Someone else kicked or punted and he did not.
- **Defence** ("gone"). No production in this game or in any later game of the season, with ≥ 3 team games left.
  A **key** defender has ≥ 15% of the unit's production to date, ≥ 2 events of his own and ≥ 6 for the team.
  - Production is not participation: a defensive "absence" cannot be told from a quiet game.
  - This oracle is weak by construction.

**Multiple absences in one unit** (§6): tested for super-linearity; not supported → linear with the variance widened.

**OL (uncertainty only).**
- No player data exists: no participation, no snaps, and OL players appear in the play-by-play only on fumble
  recoveries.
- From the official reports known at T for each team's next game, `units.ol_from_reports` counts the OL players
  OUT / DOUBTFUL / QUESTIONABLE / GTD. Expected missing = Σ(1 − p × game fraction).
- **Declared, unvalidated prior:** each expected-missing OL player adds **1.0 pt²** to that game's margin variance
  (`OL_VAR_PER_MISSING`). The mean effect is not modelled.
  - Reasoning, not evidence: a starting lineman's absence is plausibly worth 0–2 points, of unknown sign relative
    to V2.1's error, and whether a listed lineman is a starter is unknown.
  - Flagged **NOT_ESTIMATED**, to be validated on live 2026 games through the Model Lab.

**Live rows** (`units.unit_state(season, T, availability=None)`): one per team × unit (OL included). Fields:
- `baseline` / `expected` / `healthy` lineup (JSON, with p_hist, play probability, value per game and SD);
- `delta_pts`, `delta_sd`;
- `absence_delta_use`, `absence_delta_pts` (the report-path candidate with its frozen β), `absence_beta`;
- `strength_expected`, `strength_healthy`, `strength_baseline` (points above an all-replacement unit);
- `health_pts` (expected − healthy), `continuity` (Σ min(expected, baseline)/Σ baseline), `depth_n`;
- `pi_season`, `pi_recent`, `knowledge` (REPORTED / UNKNOWN), `value_status`;
- for OL: `ol_listed`, `ol_out`, `ol_uncertain`, `ol_expected_missing`, `var_inflation_pts2`.

@@RESULTS@@
