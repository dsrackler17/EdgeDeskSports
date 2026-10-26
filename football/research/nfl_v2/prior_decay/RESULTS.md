# NFL v2 prior decay (H-NFL-PD-01): results

**Verdict: REJECTED at stage A (validation).** Status stays `experimental`. Nothing here reaches a live card.

## Before any variant ran

`preregistration.json` was committed first (git `689200dd`, registered 2026-10-25T23:44:40Z, content sha256
`94f47390…`). `run.js` refuses to run if that document has been edited since.

The preregistration fixed four things in advance:

- the mechanism;
- the decay schedule;
- the three variants and the selection rule;
- the promotion criteria and the forking-paths disclosure (`comparisons_made: 3`).

## The mechanism

The served model's QB term measures the starter against his own club's running QB level. The club's quarterback
*quality* sits in the team ratings, and at Week 6–7 those are still 53–73% the carried 2025 prior
(`docs/nfl-prior-decay/DIAGNOSIS.md`). The candidate adds one fitted term that measures the stale part of the prior:

```
q_season(starter)  = (Σ dev·dropbacks + k_db · q_before) / (Σ dropbacks + k_db)
qb_prior_gap(side) = w_pass(n) · (q_season − teamQbStart)
```

- `q_before` is the starter's value before his first start this season.
- `teamQbStart` is the club QB level the carried prior assumes.
- `w_pass(n) = 0.9^n` is the passing rating's prior weight after n games.

So the starter's current-season EPA per dropback earns weight as his sample grows. The term's weight is fitted by the
same walk-forward standardised ridge as every other term. v1 is the served `edgedesk_nfl_v2.1.0` configuration,
refitted under the same protocol; its served weights are untouched.

**Decay schedule:** weight left on pre-season QB information. This assumes 35 dropbacks a start and that the fitted
weight carries the prior's QB loading one for one.

| games played | v1 `w(n)` | k_db 100 | **k_db 200** | k_db 400 |
|---|---|---|---|---|
| 0 | 1.000 | 1.000 | 1.000 | 1.000 |
| 2 | 0.810 | 0.476 | 0.600 | 0.689 |
| 4 | 0.656 | 0.273 | 0.386 | 0.486 |
| 6 | 0.531 | 0.171 | 0.259 | 0.348 |
| 8 | 0.430 | 0.113 | 0.179 | 0.253 |
| 12 | 0.282 | 0.054 | 0.091 | 0.138 |
| 17 | 0.167 | 0.024 | 0.042 | 0.067 |

## The run

`node football/research/nfl_v2/prior_decay/run.js` ran once, on 2010–2024 walk-forward.

- **The 2025 holdout was not predicted.** The replay rows are cut at 2024 before the walk-forward runs.
- **CLV** is spread points the line moved from the early-week checkpoint to the close, toward the model's side. It
  covers bets at |model − early line| ≥ 2 pts, 2020–2024, using the model loop's line definitions
  (`export_early_lines.py`, built from nflverse/nfldata's git history).
- **Variants tried:** 3, plus the incumbent refit. All are logged to `../results/variants.jsonl` with `holdout_looked: false`.

| model | Brier | log loss | margin MAE | early-line CLV (pts, n) |
|---|---|---|---|---|
| v1 (served config, refitted) | 0.21761 | 0.62423 | 10.3032 | +0.649 (569) |
| PD-K200 | 0.21758 | 0.62419 | 10.3013 | +0.671 (566) |
| PD-K100 | 0.21763 | 0.62428 | 10.3021 | +0.663 (569) |
| **PD-K400 (selected: lowest Brier)** | **0.21757** | **0.62416** | **10.3016** | **+0.656 (563)** |

**Stage A checks for PD-K400:**

| check | result |
|---|---|
| Brier lower | passes |
| log loss not worse | passes |
| MAE within +0.01 | passes |
| CLV ≥ v1 | passes |
| Brier lower in ≥ 9 of 15 seasons | **fails: 8 of 15** (2019 is a tie to five decimals) |

**→ not a finalist.** The improvement is real in sign but tiny: 0.00004 Brier, a quarter of the round-2 changes that
were promoted. The holdout look (stage B) is not made, and `passed` stays false.

## What it would say on KC @ SEA

`shadow.js`, illustration only: fitted on 2002–2024 and priced from the current state on games not yet played.

| | home margin | SEA win | QB term | prior-gap term |
|---|---|---|---|---|
| v1 refit | SEA +4.28 | 65.6% | −1.44 | — |
| PD-K400 | SEA +4.37 | 65.8% | −1.44 | −0.15 |
| close | SEA +3.0 | 58.3% | | |

The QB-anchored correction barely moves this game. KC @ SEA's gap is in the **team** priors: the points rating
(α 0.06) and the EPA ratings, which carry SEA's 2025 at 69% and 53%. The quarterback channel is not the main cause.
Faster team-level decay was already tested in round 1 (P0: 45 geometric settings; P1: 288 hyperbolic settings) and
rejected on 2010–2024 (`../RESULTS.md`). Any new team-decay family needs its own registration that counts those
looks.

## Registry

`supabase/nfl_prior_decay_registry.sql` (`tools/football/build_nfl_prior_decay_sql.js`) writes:

- one `research_models` row;
- one `research_model_versions` row: `2.0.0-exp.1`, EXPERIMENTAL, T3, carrying the schedule, the promotion criteria
  and `comparisons_made: 3`;
- one `research_model_results` row: `passed = false`, metrics with verdict REJECTED.

It reads the live schema the same way the market-structure studies do. Applying it a second time writes nothing.
