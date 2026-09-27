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

## Verdict

**No non-QB unit is promoted. Each stays research, and FRONT7 / SECONDARY / OL are uncertainty-only.**

**1. The efficiency value and the baseline-anchored delta the design calls for carry no signal beyond V2.1.**
- Scope: dev 2016–2023, 5,954 FBS games, β walk-forward with a N(0, 1) prior.
- Oracle deltas, ΔMAE on unit-change games:

  | unit set | ΔMAE [95% CI] |
  |---|---|
  | +SKILL | +0.0005 [−0.009, +0.010] |
  | +DEF | −0.016 [−0.042, +0.010] |
  | +ST | +0.007 [−0.001, +0.015] |
  | +ALL | +0.004 [−0.013, +0.022] |

- The pregame deltas are no better. ST pregame *harms* unit-change games: +0.008 [+0.001, +0.014].
- Why: skill efficiency is mostly noise at the player level. Split-half r is 0.19 for RB and WR; k = 163 carries and
  103 targets.

**2. What does carry signal is knowing the actual absence.**
- The usage share the coach gave the absent player (the **usage-revealed** value) is informative. His EPA
  efficiency is not.
- Oracle known-absence delta, skill units:

  | set | ΔMAE [95% CI] | ΔRMSE [95% CI] |
  |---|---|---|
  | all games | −0.016 [−0.029, −0.002] | −0.020 [−0.035, −0.006] |
  | change games | −0.021 [−0.043, −0.0002] | −0.031 [−0.054, −0.010] |

- β_WR_TE = 1.76 [0.96, 2.56]; β_RB = 0.07 [−0.11, 0.26].
- This was **pre-registered on dev** as the one report-path candidate. It was added after the first dev pass,
  which is disclosed.

**3. The holdout did not confirm it.** Holdout 2024–2025, scored once, betas frozen on 2014–2023:

| set | ΔMAE [95% CI] |
|---|---|
| change games | −0.006 [−0.074, +0.064] |
| ordinary games | **+0.088 [+0.023, +0.151]** (harm) |

- The ordinary-game harm is the **double count the design warns about**: the absolute (naive) delta keeps
  subtracting long absences that the rating has already absorbed.
- On holdout, V2.1's residual on 3+-game absences is −0.02 points.
- A post-hoc, dev-only variant restricted to *new* absences leaves ordinary games identical by construction and still
  improves change games: ΔRMSE −0.017 [−0.031, −0.003]. It is untested out of sample.

**4. The double-count protection works as designed but cannot be demonstrated as a gain.**
- The real example (Patrick Taylor Jr., §3):
  - his baseline share re-anchors 0.379 → 0.220 over a 7-game absence;
  - his subtracted value shrinks from −1.37 to −0.63 points;
  - the naive delta stays near −1.0.
- In the data, V2.1's residual is −1.09 in the first game of a skill absence and −0.47 at 3+ games (dev), so the
  rating does absorb.
- But the anchoring term "current healthy lineup vs the rating's lineup" is itself anti-signal. The prior's lineup
  is proxied by returning players (§4.3), and V2's prior is not that lineup.

**5. OL is a declared, unvalidated variance prior** (+1 pt² per expected-missing lineman on the next game's report).
On the 40 completed report-covered 2026 games it changes nothing measurable: 80% coverage 0.925 → 0.925,
log loss 0.4576 → 0.4579.

**6. Returning production 2.0 (evidence only; §10).**
- A PVAR-based defensive returning share predicts the weeks 1–4 V2.1 residual: +1.11 points per SD
  [+0.26, +1.99], LOSO ΔMAE −0.021.
- V2's own defensive input is missing for most teams before 2024 (0% in 2014–16).
- V2 still under-uses its offensive returning-production input: +1.09 per SD [+0.33, +1.87].
- These go to the next V2 retrain, not the challenger.

**Per-unit verdict**

| unit | verdict | reason |
|---|---|---|
| RB | **research** | no signal: efficiency β CI covers 0; usage-revealed β_RB 0.07 [−0.11, 0.26] |
| WR_TE | **research (report-path candidate, next cycle)** | dev oracle signal (β 1.76), not confirmed on the holdout; retest as *new-absence* known-absence on live 2026 reports |
| FRONT7 | **uncertainty-only** | production ≠ participation; defensive "absences" cannot be told from quiet games; no gain |
| SECONDARY | **uncertainty-only** | as FRONT7; no value at all in 2021–2023 (INT / PBU ids collapse) |
| ST (K, P) | **research** | pregame harms change games on dev (+0.008 [+0.001, +0.014]); holdout neutral |
| OL | **uncertainty-only, NOT_ESTIMATED** | no player data; declared variance prior to validate live |

Challenger content from this layer: **none now**. The weekly engine may publish `unit_state` rows (values, lineups,
deltas, OL counts) as *information*, flagged research. They must not move a margin.

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

Units:
- k: carries (RB), targets (WR / TE), team games (FRONT / SEC), FG or XP attempts (K), punts (P);
- repl, μ, starter-slot mean: centred EPA per event (skill), events per team game (defence), points per attempt (K),
  net yards per punt (P).
Split-half r uses the listed minimum exposure per half; n = player-seasons.

| component | k [95% CI] | σ² | τ² [95% CI] | split-half r (n) | repl [95% CI] (n player-seasons) | starter-slot mean | μ | ρ stay [CI] (n) | ρ transfer [CI] (n) | seasons |
|---|---|---|---|---|---|---|---|---|---|---|
| RB_rush | 162.6 [135.0, 202.2] | 1.287 | 0.00791 [0.00658, 0.00926] | 0.195 (1,243; ≥40/half) | −0.0156 [−0.0227, −0.0086] (3,299) | +0.0173 | +0.0027 | 0.909 [0.753, 1.073] (2,413) | 1.257 [0.683, 1.901] (221) → capped 0.909 | 2016–23 |
| WR_rec | 102.9 [84.9, 128.5] | 2.704 | 0.02628 [0.02143, 0.03088] | 0.186 (1,761; ≥20) | −0.0723 [−0.0876, −0.0569] (2,951) | +0.0272 | +0.0058 | 0.659 [0.523, 0.791] (3,339) | 0.809 [0.293, 1.297] (315) → capped 0.659 | 2016–23 |
| TE_rec | 112.0 [67.1, 247.6] | 2.255 | 0.02013 [0.00943, 0.03157] | 0.129 (332; ≥15) | −0.0386 [−0.0686, −0.0079] (913) | +0.0271 | +0.0085 | 0.808 [0.325, 1.213] (917) | 2.654 [0.618, 4.817] (57) → capped 0.808 | 2016–23 |
| FRONT_sack | 12.1 [11.0, 13.6] | 0.239 | 0.01971 [0.01791, 0.02156] | 0.389 (4,582; ≥5) | 0.1509 [0.1485, 0.1532] (4,975) | 0.3908 | 0.2666 | 0.741 [0.651, 0.832] (3,783) | **0.340 [0.102, 0.572] (202)** | 2016–23 |
| SEC_int | 53.1 [38.2, 81.9] | 0.195 | 0.00368 [0.00242, 0.00497] | 0.183 (1,060; ≥5) | 0.1285 [0.1238, 0.1339] (409) | 0.2330 | 0.2169 | 0.446 [0.141, 0.764] (867) | — (7 pairs) → 0.446 | 2016–20 |
| SEC_pbu | 19.4 [16.4, 23.3] | 0.347 | 0.01792 [0.01525, 0.02070] | 0.307 (1,767; ≥5) | 0.1639 [0.1590, 0.1690] (1,279) | 0.3854 | 0.3154 | 0.573 [0.428, 0.718] (1,573) | 0.046 [−0.792, 0.893] (31) | 2016–20 |
| K_fg | 69.1 [41.5, 159.1] | 1.520 | 0.02199 [0.01011, 0.03383] | 0.114 (759; ≥6) | −0.342 [−0.430, −0.246] (190) | +0.037 | +0.017 | 0.745 [0.374, 1.140] (640) | 1.588 [−0.127, 3.709] (35) → capped 0.745 | 2016–23 |
| K_xp | 166.6 [94.9, 460.2] | 0.0324 | 0.00019 [0.00008, 0.00033] | 0.107 (579; ≥15) | −0.0266 [−0.0366, −0.0168] (231) | +0.0031 | +0.0014 | 1.312 [0.839, 1.823] (634) → 1 | 0.970 [−1.235, 4.566] (34) | 2016–23 |
| P_net | 44.0 [35.0, 56.6] | 135.2 | 3.074 [2.505, 3.699] | 0.294 (902; ≥15) | −2.140 [−2.601, −1.669] (247) | +0.222 | +0.096 | 0.720 [0.557, 0.878] (833) | 0.555 [0.085, 1.163] (53) | 2016–23 |

Other estimated / declared constants:

| constant | value [95% CI] (n) | basis |
|---|---|---|
| FG make model | logit p = 0.792 − 0.860 z + 0.090 z², z = (d − 40)/10; SE 0.023 / 0.021 / 0.021 (19,884 attempts) | dev |
| XP make rate | 0.9724 (42,778) | dev |
| V_sack / V_int / V_pbu | 1.871 / 4.370 / 1.162 EPA (27,658 sacks / 11,024 INT / 17,580 PBU) | dev plays |
| EP per yard | 0.0724 (394,289 1st-and-10 snaps) | dev plays |
| λ (redistribution to an unseen replacement) | 0.023 [0.015, 0.031] (5,826 one-absence vs 16,094 no-absence team-group-freezes; RB 0.030, WR_TE 0.026) | dev, matched on games played |
| absence β (report-path candidate, usage-revealed) | RB 0.075 [−0.112, 0.261], WR_TE 1.761 [0.962, 2.560] (7,479 games 2014–2023) | frozen, `units/absence_beta.json` |
| β prior | N(0, 1²) per unit | declared |
| LM_PSEUDO (league-mean blend) | 2,000 events | declared |
| MIN_EXPECTED_EVENTS (skill absence) | 4 | declared (Poisson e⁻⁴) |
| NEW_ABSENCE_MAX_GAMES | 2 | declared |
| GONE_MIN_REMAINING / DEF_CHANGE_SHARE / DEF_MIN_OWN / DEF_MIN_TEAM | 3 / 0.15 / 2 / 6 | declared |
| PREGAME_RECENT (defender presence) | production in the last 3 team games | declared |
| OL_VAR_PER_MISSING | 1.0 pt² per expected-missing lineman | **declared, unvalidated** |
| N_BOOT | 1,000 (constants), 2,000 (backtests); seed 20260927 | — |

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
    correlation **0.999** for epa_pass (300 team-freezes; epa_rush 0.990) (`tests_units: pi_one_team_matches_joint_solve`).
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
  - **λ = 0.023 [0.015, 0.031]** (dev; matched on the team's games before T). Nearly all of an absent player's usage goes to
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

## 3. Re-anchoring on a real example (`backtest_units.reanchor_example`)

**Patrick Taylor Jr., Memphis 2019, RB.** He was hurt after game 1 and missed games 2–8. Kenny Gainwell took the carries.
- The absent player's own contribution to the delta is (upcoming − baseline) × V. The naive version uses
  (upcoming − healthy) × V.
- V = value per game at the full RB usage; the healthy share 0.587 comes from game 1.

| freeze | games before | π season / recent | Taylor absent | Taylor baseline share | Taylor V | Taylor Δ, baseline | Taylor Δ, naive | Gainwell baseline | Gainwell expected |
|---|---|---|---|---|---|---|---|---|---|
| 2019-09-10 | 2 | 0.75 / 0.72 | yes | 0.379 | 3.61 | **−1.37** | −1.41 | 0.113 | 0.496 |
| 2019-09-24 | 3 | 0.70 / 0.66 | yes | 0.348 | 3.15 | −1.10 | −1.16 | 0.146 | 0.511 |
| 2019-10-01 | 4 | 0.65 / 0.60 | yes | 0.321 | 2.84 | −0.91 | −1.03 | 0.192 | 0.633 |
| 2019-10-08 | 5 | 0.60 / 0.52 | yes | 0.285 | 2.94 | −0.84 | −1.00 | 0.218 | 0.486 |
| 2019-10-15 | 6 | 0.55 / 0.46 | yes | 0.258 | 2.95 | −0.76 | −1.01 | 0.256 | 0.577 |
| 2019-10-22 | 7 | 0.53 / 0.42 | yes | 0.243 | 2.81 | −0.68 | −0.95 | 0.277 | 0.589 |
| 2019-10-29 | 8 | 0.49 / 0.37 | yes | 0.220 | 2.86 | **−0.63** | −0.93 | 0.320 | 0.683 |
| 2019-11-12 | 9 | 0.45 / 0.32 | no (back) | 0.199 | 2.89 | +0.37 | 0 | 0.352 | 0.666 |

How to read it:
- The baseline moves to Gainwell through the rating's own weights: the data share grows and π falls. The subtracted
  absence shrinks by more than half in seven games.
- It does not reach zero, because the preseason prior (which contains Taylor from 2018) still carries 37–49% of the
  rating.
- When Taylor returns, the baseline delta turns **positive**: the rating under-represents him. The naive delta has
  nothing to say.
- The synthetic version is in `tests_units: reanchor_*`.

## 4. Backtests (`backtest_units`)

### 4.1 Design

- **BASE.** V2.1's walk-forward out-of-fold `ens_pred` (out_h/stage7). For 2014–2015 (training rows only) BASE is
  the equal C/D mean, which is the V2.1 stack.
  - The win probability is recomputed with V2.1's t (the season's df) and σ, and reproduces `p_home_raw` exactly
    (max |diff| = 0, 7,009 games).
  - Scope: FBS vs FBS, FINAL. The stage-7 file is read through an allowlist of columns (no market column).
- **Adjusted prediction** = BASE + Σ β_u Δ_u.
  - Δ_u = home unit delta − away unit delta.
  - β_S is fitted on seasons < S (≥ 2014) with a N(0, 1) prior per unit: shrunk toward 0.
  - Holdout betas are frozen on 2014–2023.
- **Bootstrap:** paired over games, 2,000 resamples. Bias = prediction − outcome. Log loss: 2017+ (2016 has no σ).
- **Unit change** = a new in-season oracle absence (1–2 games old) on either side. **Ordinary** = no change.
- A fraction of games have one:

  | unit set | dev | holdout |
  |---|---|---|
  | SKILL | 3,553 of 5,954 (60%) | 837 of 1,607 |
  | DEF | 2,175 | 578 |
  | ST | 1,229 | 316 |
  | ALL | 4,544 | 1,187 |

  Missing a contributor is common. The skill threshold (≥ 4 expected events) covers every WR3-level player.

@@DEVTABLES@@

### 4.3 What the dev backtest says

- **Efficiency values do not carry the signal.** Every oracle / pregame efficiency variant has a CI covering 0.
  - The fitted β_WR_TE is negative (−0.34 [−0.98, +0.29] in 2023). Once shrunk, the EPA-per-target differences
    between a receiver and his replacement are too noisy to price.
- **Usage-revealed value.**
  - The pure absence term (`oracle_naive_use`) is the only skill signal: β_WR_TE +1.67 [+0.84, +2.49] in 2023.
    V2.1's residual is −1.08 points for a team in the first two games of a skill absence (§5).
  - Anchored to the rating's lineup (`oracle_use`), the signal vanishes. The anchoring term Σ(healthy −
    rating lineup) × V_use has a **negative** β on dev, from sensitivity runs with each term alone:
    RB −0.17 [−0.30, −0.03], WR_TE −0.74 [−1.07, −0.42].
  - With a data-only baseline (no prior lineup) it is 0. The proxy "the prior's lineup = returning players at last
    season's shares" is not what V2's prior represents; V2's prior regresses on the lagged rating, returning
    production and talent. The QB layer found the same defect from the other side (QB.md §4).
- **History-only expected absences** (e − h with a usage or efficiency value) have no signal. Sensitivity: ΔMAE
  +0.004 [−0.004, +0.012] and +0.002 [−0.003, +0.008].
  - Only a known absence helps. Before 2026 that is hindsight; in 2026 it is an official report.

## 5. Double-count ablation (dev, skill units, team-games with an in-season oracle absence, n 7,346)

Columns:
- r = the team's V2.1 residual (margin − BASE, signed to the team; negative = the team did worse than V2.1 said);
- nominal Δ = the delta at β = 1;
- fitted = β·Δ with the walk-forward β.

**Efficiency value**

| absence length | n | mean r [95% CI] | nominal Δ baseline | nominal Δ naive | fitted baseline | fitted naive | MAE BASE | MAE +baseline | MAE +naive | naive − baseline [95% CI] |
|---|---|---|---|---|---|---|---|---|---|---|
| 1st game | 2,472 | −1.09 [−1.74, −0.37] | +0.006 | −0.068 | −0.003 | +0.006 | 13.213 | 13.227 | 13.223 | −0.004 [−0.016, +0.008] |
| 2nd game | 1,247 | −1.08 [−2.00, −0.17] | +0.030 | −0.022 | −0.007 | +0.000 | 13.076 | 13.074 | 13.074 | +0.001 [−0.016, +0.018] |
| 3+ games | 3,627 | −0.47 [−1.00, +0.12] | +0.061 | +0.016 | +0.006 | −0.005 | 12.820 | 12.820 | 12.827 | +0.007 [−0.002, +0.017] |

**Usage-revealed value**

| absence length | n | mean r | nominal Δ baseline | nominal Δ naive | fitted baseline | fitted naive | MAE BASE | MAE +baseline | MAE +naive | naive − baseline [95% CI] |
|---|---|---|---|---|---|---|---|---|---|---|
| 1st game | 2,472 | −1.09 | +0.93 | −0.47 | +0.05 | −0.14 | 13.213 | 13.218 | 13.189 | −0.029 [−0.085, +0.023] |
| 2nd game | 1,247 | −1.08 | +1.37 | −0.04 | −0.02 | −0.11 | 13.076 | 13.091 | 13.047 | −0.045 [−0.113, +0.029] |
| 3+ games | 3,627 | −0.47 | +1.27 | +0.14 | −0.02 | −0.08 | 12.820 | 12.826 | 12.806 | −0.020 [−0.061, +0.022] |

**Holdout (the same buckets, betas frozen)**

| absence length | n | mean r | MAE BASE | MAE +baseline (usage) | MAE +naive (usage) |
|---|---|---|---|---|---|
| 1st game | 350 | **+0.56** | 14.192 | 14.231 | 14.177 |
| 2nd game | 189 | −0.73 | 12.560 | 12.539 | 12.632 |
| 3+ games | 1,294 | **−0.02** | 12.526 | 12.547 | 12.507 |

Conclusions:
- **The rating absorbs a long absence.**
  - Dev: r goes −1.09 → −1.08 → −0.47 with absence length.
  - Holdout 3+: −0.02.
  - This is the premise of the design (DESIGN rules 2–3), and it holds.
- **Does the naive version overshoot?** Not visibly on dev: the fitted adjustments are an order of magnitude smaller
  than r in every bucket, so neither version is large enough to overshoot there. On the holdout the naive
  (absolute) delta **does** double count:
  - on ordinary games, the games carrying only old absences, it adds error (+0.088 [+0.023, +0.151], §7);
  - the first-game effect that justified it flipped sign (+0.56, n 350).
- **Double-count protection is needed; the anchored delta is not the working form of it.** The working protection is
  to **apply a known absence only while it is new** (1–2 games). Post-hoc, dev only: ordinary games unchanged by
  construction; change games ΔRMSE −0.017 [−0.031, −0.003], ΔMAE −0.010 [−0.024, +0.004]; β_WR_TE 1.52 [0.52, 2.52].
  It is untested out of sample and is the next cycle's live-2026 candidate.

## 6. Multiple absences in one unit (dev, skill)

Model: r = a + b·Δ + g·(Δ × 1[≥ 2 absences]), oracle deltas, 7,346 team-unit-games, 1,520 with ≥ 2 absences.

| value | b (single) [95% CI] | g (extra, multi) [95% CI] | mean r single / multi | residual SD single / multi | super-linear? |
|---|---|---|---|---|---|
| efficiency | −0.10 [−0.94, +0.70] | +0.12 [−1.32, +1.71] | −0.65 / −1.28 | 16.39 / 16.53 | **no** |
| usage-revealed | −0.03 [−0.21, +0.14] | +0.06 [−0.25, +0.37] | −0.65 / −1.28 | 16.39 / 16.53 | **no** |

- Multiple absences hurt more on average (−1.28 vs −0.65), roughly additively. Nothing supports a convex or capped
  unit function.
- The unit function stays **linear**, with the variance widened by the measured factor 1.017 (residual variance,
  multi / single). This is documented, not applied: no unit delta enters a margin.

## 7. Holdout 2024–2025 (scored once; betas frozen on 2014–2023; `units/backtest_holdout.json`)

@@HOLDOUTTABLES@@

- Efficiency deltas: nothing. Pregame +SKILL *harms* all games: ΔMAE +0.020 [+0.003, +0.036].
- The pre-registered report-path candidate (`oracle_naive_use`, SKILL) **fails**. Change games −0.006 [−0.074, +0.064];
  ordinary games +0.088 [+0.023, +0.151] (harm).
- 2024 receiver ids cover 69% of targets (AUDIT.md). A "no identified target" absence is noisier there; that adds to,
  but does not explain, the failure.

## 8. Combined harness (`backtest.py`): BASE vs +QB vs +QB+OL vs +ALL

Inputs:
- **+QB** = the QB layer's out-of-fold file `$CFB_V2_OUT/personnel/backtest_qb_oof.parquet` (present; the points
  path). It is the QB **oracle** (actual starter), an upper bound.
- **+QB+OL** equals +QB before 2026: no OL report exists. The OL layer is evaluated on the 2026 report-covered games
  (§11).
- **+ALL** = +QB + unit deltas, with unit betas re-fitted walk-forward on the +QB residual.
- **Lineup change** = a QB change or a new unit absence. Ordinary = neither.

@@COMBINED@@

- +QB reproduces the QB layer's own numbers on QB-change games: dev −0.0203, holdout −0.0876 (QB.md §5).
- Its ordinary games are untouched: +0.0000.
- No row passes the promotion rule. The only CI clear of zero is on RMSE, not MAE:
  - dev +ALL [skill known-absence]: ΔRMSE −0.027 [−0.052, −0.003];
  - holdout +ALL [oracle, efficiency]: ΔRMSE −0.036 [−0.072, −0.000].
- On the holdout, the skill known-absence row harms ordinary games (§7).

| component | recommend? | status |
|---|---|---|
| +QB | see QB.md (its own verdict) | available, oracle |
| +OL | **no** | NOT_ESTIMATED: declared variance-only prior |
| +SKILL / +DEF / +ST / +ALL (pregame, efficiency) | **no** | CIs cover 0 (ST harms change games on dev) |
| +SKILL known-absence (usage-revealed) | **no** | passed dev (oracle), failed holdout (ordinary-game harm) |

## 9. PVAR, 2025 (`units/pvar_2025.json|parquet`)

Definitions:
- **As of** the last 2025 V2.1 freeze, 2026-01-13.
- **PVAR** = posterior value per event × the player's own usage per game played in 2025 × points per event.
  For the defence: per team game from his first appearance.
- **SD** = the posterior SD plus the replacement uncertainty, times the same factors.
- **Scope:** FBS teams, minimum 2025 exposure: RB 60 carries, WR 30 targets, TE 20 targets, front / secondary
  6 team games, K 8 FGA, P 20 punts.
- 2025 secondary values are **break-up only**: interceptions are UNRELIABLE in 2025.

Distribution:

| group | n | mean | SD across players | p05 | p25 | p50 | p75 | p95 | mean player SD | share > 1.96 SD |
|---|---|---|---|---|---|---|---|---|---|---|
| RB | 249 | +0.24 | 0.61 | −0.56 | −0.14 | +0.16 | +0.52 | +1.34 | 0.64 | 2% |
| WR | 425 | +0.32 | 0.55 | −0.38 | −0.04 | +0.25 | +0.62 | +1.32 | 0.64 | 3% |
| TE | 154 | +0.06 | 0.28 | −0.36 | −0.10 | +0.05 | +0.17 | +0.56 | 0.40 | 1% |
| FRONT7 | 949 | +0.12 | 0.16 | −0.06 | +0.01 | +0.09 | +0.19 | +0.46 | 0.19 | 9% |
| SECONDARY (PBU) | 516 | +0.08 | 0.08 | −0.02 | +0.02 | +0.06 | +0.11 | +0.21 | 0.13 | 3% |
| K | 154 | +0.44 | 0.30 | −0.01 | +0.22 | +0.41 | +0.60 | +1.00 | 0.25 | 42% |
| P | 140 | +0.56 | 0.39 | −0.13 | +0.32 | +0.58 | +0.76 | +1.30 | 0.34 | 40% |

Top of each group (points per game ± SD; exposure; games). The full top 25 per group is in `units/pvar_2025.json`.
- **RB:**
  - Caleb Hawkins 2.69 ± 1.03 (209 carries, 12 g);
  - Ahmad Hardy 2.40 ± 0.93 (250, 13);
  - DeSean Bishop 2.40 ± 0.78 (174, 13);
  - Jeremiyah Love 2.12 ± 0.80 (185, 12);
  - Evan Dickens 1.87 ± 1.19;
  - Justice Haynes 1.75 ± 0.98.
- **WR:**
  - Eric McAlister 2.48 ± 0.93 (112 targets);
  - Jeremiah Smith 2.38 ± 0.87 (104);
  - Jackson Harris 2.26 ± 0.95;
  - KJ Duff 2.08 ± 0.80;
  - Duce Robinson 2.04 ± 0.87;
  - Ja'Kobi Lane 1.88 ± 0.78.
- **TE:**
  - Eli Stowers 1.46 ± 0.65 (78 targets);
  - Brody Foley 0.83 ± 0.55;
  - Justin Joly 0.80 ± 0.53;
  - Rocky Beers 0.69;
  - Carsen Ryan 0.64;
  - Michael Trigg 0.62 ± 0.81.
- **FRONT7:**
  - Melkart Abou Jaoude 0.89 ± 0.19;
  - David Bailey 0.87 ± 0.18;
  - Colin Simmons 0.83 ± 0.17;
  - Cashius Howell 0.78 ± 0.17;
  - Justin Wodtly 0.76;
  - Nadame Tucker 0.74.
- **SECONDARY:**
  - JoJo Johnson 0.52 ± 0.14;
  - Devon Marshall 0.46;
  - Brent Gordon Jr. 0.41;
  - Andre Jordan Jr. 0.39.
- **K:**
  - Lucas Carneiro 1.44 ± 0.34 (56 FGA + XPA);
  - Peyton Woodring 1.24;
  - Tate Sandell 1.17;
  - Drew Stevens 1.13.
- **P:**
  - Wes Pahl 1.78 ± 0.42;
  - Keegan Andrews 1.52;
  - Bryan Hansen 1.47;
  - John Hoyet Chance 1.36.

Reading:
- **Skill PVARs are mostly within noise.** Only 2–3% of qualifying RB / WR / TE are more than 1.96 SD above
  replacement. The spread across players (0.55–0.61 points) is about the size of a single player's SD (0.64).
- **The best skill players are worth about 2–2.7 points per game nominally.** The QB layer's best starters are worth
  about 12 (QB.md §6).
- **Specialists are the most precisely measured.** 40–42% are clear of replacement: the replacement kicker or punter
  (a backup) is clearly worse.
- **The front seven has more distinguishable players** (9%) than the skill positions, from a production rate with
  k = 12 games.

## 10. Returning production 2.0 (dev 2016–2023; evidence only; `units/returning_production_dev.json`)

Definitions:
- **rp2** = Σ positive PVAR of last season's players (their end-of-season posterior × their per-team-game exposure)
  that returns, / Σ positive PVAR of last season's team, by phase (offence skill, defence, ST).
  - **Returns** = usage for the same team this season (`use`: the spec's definition, partly hindsight inside the
    season), or listed on this season's roster for it (`roster`: as point-in-time as a roster snapshot).
  - Transfers in add their old PVAR × ρ_transfer/ρ_stay.
- **lost_pts** = the points version (Σ departed − transfers in).
- **Target:** the V2.1 residual (margin − BASE) of weeks 1–4 regular-season FBS games, n = 1,469, regressed on the
  home − away difference.
- **LOSO** = leave-one-season-out MAE against an intercept-only fit.

| measure | n games | corr with residual | slope per SD [95% CI] | LOSO MAE, intercept → measure (Δ) |
|---|---|---|---|---|
| V2 `off_returning` (already in V2's prior) | 1,456 | +0.067 | **+1.09 [+0.33, +1.87]** | 12.840 → 12.824 (−0.016) |
| V2 `def_returning` (missing for most teams) | 402 | +0.076 | +1.14 [−0.41, +2.78] | 12.128 → 12.137 (+0.009) |
| rp2 offence, use | 1,456 | +0.020 | +0.33 [−0.94, +1.13] | +0.021 |
| rp2 offence, roster | 1,456 | +0.012 | +0.20 [−1.76, +0.78] | +0.018 |
| **rp2 defence, use** | 1,453 | +0.068 | **+1.11 [+0.26, +1.99]** | 12.845 → 12.824 (**−0.021**) |
| rp2 defence, roster | 1,453 | +0.035 | +0.57 [−0.29, +1.40] | −0.001 |
| rp2 ST, use / roster | 1,454 | +0.031 / +0.032 | +0.50 / +0.52 (CIs cover 0) | −0.011 / −0.010 |
| lost points (roster): off / def / ST | 1,456 | −0.000 / +0.009 / −0.013 | CIs cover 0 | +0.007 / +0.002 / −0.005 |

- Coverage: V2's `def_returning` is present for 0 of ~210 teams in 2014–2016 and 20–55% in 2017–2023, while rp2
  covers 89–99% of team-seasons.
- **For the next V2 retrain:**
  1. V2.1 still under-uses its own offensive returning production: teams with more returning offence beat V2.1 early.
  2. A PVAR-based defensive returning share predicts early error where V2's input is missing.
  3. The point-in-time (roster) version is weaker (+0.57 per SD, CI covering 0). Use the roster version or a
     week-1-known version, never usage from the season being predicted.
- No production change here.

## 11. 2026 live (`units/live_2026.json|parquet`)

Coverage: 43 report-covered games; 516 team-units at each of two instants.

| instant | team-units with a report | games with a known skill absence | known-absence Δ at frozen β (points) | OL: teams with listed OL / expected missing |
|---|---|---|---|---|
| V2.1 Tuesday 12:00 UTC freeze | **0** | 0 | — | 0 / 0 |
| kickoff − 1 min (game-day refresh) | 384 | 14 (17 team-units) | mean −0.24, min −0.71 | 49 / 103.5 |

- As for the QB layer, every 2026 report is published on game day. At the Tuesday freeze the personnel layer is inert.
- **Completed report-covered games (n = 40):**
  - report-path adjustment (28 games moved): MAE 9.152 → 9.206, log loss 0.45763 → 0.45764;
  - OL variance: 80% coverage 0.925 → 0.925, log loss 0.4576 → 0.4579.
  - n is far too small to judge either; both stay research.

## 12. Tests (`tests_units`)

**`--fast`: 73 synthetic checks, no data directories.**
- delta = 0 when upcoming = baseline;
- conditioning, not multiplying (available → healthy share; questionable → half; UNKNOWN keeps history and is not
  healthy; starter probability conditioned and capped);
- redistribution keeps the total (λ to replacement, pro rata, scale-down, nobody available);
- EW identities (e = p_hist × h exactly);
- π falls with games;
- **re-anchoring**: the absent player's baseline falls, the replacement's rises, the baseline delta shrinks, the
  naive delta is constant;
- value model (the spec's shrinkage identity, propagation, ρ stay / transfer / gap, FG curve);
- reliability gate: UNRELIABLE → null, INSUFFICIENT → prior only;
- **point in time**: strictly before T; rows at or after T change nothing;
- lineups (UNKNOWN = history; OUT → 0 and redistributed; the known-absence delta is exactly 0 without a report; new
  vs old absences);
- OL rule: counts, expected missing, declared prior, report after T / other game / failed read ignored;
- β fit (recovered, shrunk, walk-forward uses earlier seasons only);
- **no market columns** (allowlist, guard, AST scan of the four modules);
- dev-only guards.

**Real data: 128 in total, about 2.2 minutes.**
- constants (dev only, estimates inside their CIs, secondary only in reliable seasons, ρ in [0, 1]);
- secondary 2022 null with reason, front seven valued;
- BASE reproduces `p_home_raw`;
- one-team π vs the joint solve;
- panel history share = `player_week_state.expected_usage_share`;
- **point in time on the real panel** (every player-game, team-game and FG attempt at or after T rewritten → panel
  and values unchanged);
- live 2026: OUT → expected 0, NOT_LISTED → available, unreported teams UNKNOWN with known-absence Δ = 0, OL
  NOT_ESTIMATED;
- backtest outputs present and consistent;
- the holdout is scored ONCE.

## 13. Wiring notes for the weekly engine and the personnel challenger

1. **API.**
   - `units.unit_state(S, T, availability=None)` gives the per team × unit rows (OL included; defence
     uncertainty-only rows where no column is reliable).
   - `values.player_values(S, T)` / `values.fill_state(state, S, T)` fill `cfb_player_week_state`'s value fields.
   - `units.ol_uncertainty(S, T)` gives the OL counts and the declared variance.
   - A live T costs about 5–15 s per team set: the panel reads cached player-games, values reuse the Kalman season
     states in `$OUT/personnel/cache/value_states_<S-1>.parquet`.
2. **Nothing here moves a margin.** No unit component passed the promotion rule.
   - Publish unit rows as information (`value_status`, `knowledge`), and keep V2.1's projection.
   - `absence_delta_pts` is the research candidate; the Model Lab can log it beside V2.1 on report-covered games.
3. **Double-count protection for the next candidate.** Apply a known (reported) skill absence only while it is new
   (≤ 2 team games), at the frozen usage-revealed β. Validate it on live 2026 reports before any promotion.
   An OUT FOR SEASON listing must not subtract every week.
4. **Reports arrive on game day.** At the Tuesday freeze the layer is inert. Anything report-driven needs a
   write-once game-day refresh, as the QB layer says.
5. **The rating's lineup.** `rating_lineup_context` needs the prior's lineup. The returning-players proxy used here
   is anti-signal. The next V2 retrain should record the lineup its prior encodes (QB.md §4 makes the same point),
   and consider the defensive PVAR returning share (§10).
6. **Receivers 2022–2024.** Target ids cover 69–79%, so skill absences in those seasons are noisier.
7. **Pure model only.** No module reads a line, price or book. The stage-7 file is read through `STAGE7_COLS`, and
   `tests_units: no_market_*` scans the source.
8. **Reproducibility.**
   - Seeded (`C.SEED`), single-threaded BLAS.
   - Caches are keyed by code version and source files: `values_constants.json` (signature), `cache/units_panel_<S>`
     (PANEL_VERSION + constants + source keys), `cache/value_states_<S>`, `cache/fg_attempts_<S>`.
   - A full cold run: constants ≈ 25 s, panels ≈ 35–45 s per season, dev backtest ≈ 11 min, holdout ≈ 2 min.

