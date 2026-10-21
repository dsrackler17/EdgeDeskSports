# College baseball weekly model report: 2026-10-21

Served version **1.0.0** (SERVED, selection-window tuning). The loop learns on SELECTION + VALIDATION (2014–2024); the HOLDOUT (2025–2026) is never read here (research/PROTOCOL.md). Outcome-graded only: no college baseball prices are archived.

## What changed

**Nothing staged.** 16 candidates were tested over 2 runs; none cleared the rule (over 2014–2024: log loss ≤ −0.0002 with its 95% interval below zero, Brier no worse, VALIDATION no worse).

## Accuracy (walk-forward, out of sample), from v1.0.0

| Window | n | Log loss | Brier |
|---|---|---|---|
| SELECTION + VALIDATION 2014–2024 | 78660 | 0.606867 | 0.210418 |
| VALIDATION 2023–2024 | 11950 | 0.593754 | 0.204712 |

## Where the misses concentrate (VALIDATION)

Wins minus priced; z = (wins − Σp) / √Σp(1−p). |z| ≥ 2 pulls the matching candidates forward.

| Pattern | n | Bias | z | What it covers |
|---|---|---|---|---|
| home | 11011 | +0.0035 | 0.82 | home games: home wins minus the priced home win |
| neutral | 939 | -0.0147 | -0.95 | neutral sites (listed home side) |
| conference | 798 | +0.0029 | 0.17 | conference games |
| non_conference | 11152 | +0.002 | 0.47 | non-conference games |
| first_3_weeks | 2406 | +0.0084 | 0.94 | the first three weeks (ratings carried over the winter) |
| later | 3758 | +0.0012 | 0.16 | after week 8 |
| midweek | 3001 | +0.0016 | 0.2 | midweek (weaker starters, not in the model) |
| favourites | 4596 | +0.0073 | 1.27 | priced 70%+ either way, read from the favourite |

## Every candidate tried this week

| Candidate | Change | Δlog loss | 95% interval | ΔBrier | VALIDATION Δlog loss | Decision |
|---|---|---|---|---|---|---|
| team_carry_lower | `tq.carry_team` ["add",-0.05] | -0.000051 | [-0.000116,0.000016] | -0.000024 | -0.000143 | FAIL: log loss change -0.000051 does not clear -0.0002; 95% interval [-0.000116,0.000016] is not below zero |
| dispersion_lower | `tq.phi` ["mul",0.85] | 0.000141 | [0.000056,0.000223] | 0.000057 | 0.000153 | FAIL: log loss change 0.000141 does not clear -0.0002; 95% interval [0.000056,0.000223] is not below zero; Brier worse (0.000057); worse on VALIDATION (0.000153) |
| dispersion_higher | `tq.phi` ["mul",1.2] | -0.000023 | [-0.00012,0.000073] | -0.000007 | -0.000007 | FAIL: log loss change -0.000023 does not clear -0.0002; 95% interval [-0.00012,0.000073] is not below zero |
| recency_faster | `tq.halflife_days` ["mul",0.67] | -0.000027 | [-0.000074,0.000024] | -0.000012 | -0.000027 | FAIL: log loss change -0.000027 does not clear -0.0002; 95% interval [-0.000074,0.000024] is not below zero |
| recency_slower | `tq.halflife_days` ["mul",1.5] | 0.000038 | [0.000003,0.000068] | 0.000016 | 0.000033 | FAIL: log loss change 0.000038 does not clear -0.0002; 95% interval [0.000003,0.000068] is not below zero; Brier worse (0.000016); worse on VALIDATION (0.000033) |
| runs_tails_heavier | `dist.r` ["mul",0.8] | 0.000096 | [0.000034,0.000154] | 0.000034 | 0.000019 | FAIL: log loss change 0.000096 does not clear -0.0002; 95% interval [0.000034,0.000154] is not below zero; Brier worse (0.000034); worse on VALIDATION (0.000019) |
| runs_tails_lighter | `dist.r` ["mul",1.25] | -0.000031 | [-0.000089,0.000026] | -0.000011 | -0.000013 | FAIL: log loss change -0.000031 does not clear -0.0002; 95% interval [-0.000089,0.000026] is not below zero |
| team_spread_tighter | `tq.sigma_team` ["mul",0.75] | 0.000442 | [0.000152,0.000737] | 0.0002 | 0.000577 | FAIL: log loss change 0.000442 does not clear -0.0002; 95% interval [0.000152,0.000737] is not below zero; Brier worse (0.0002); worse on VALIDATION (0.000577) |
| team_carry_lower | `tq.carry_team` ["add",-0.05] | -0.000051 | [-0.000116,0.000016] | -0.000024 | -0.000143 | FAIL: log loss change -0.000051 does not clear -0.0002; 95% interval [-0.000116,0.000016] is not below zero |
| dispersion_lower | `tq.phi` ["mul",0.85] | 0.000141 | [0.000056,0.000223] | 0.000057 | 0.000153 | FAIL: log loss change 0.000141 does not clear -0.0002; 95% interval [0.000056,0.000223] is not below zero; Brier worse (0.000057); worse on VALIDATION (0.000153) |
| dispersion_higher | `tq.phi` ["mul",1.2] | -0.000023 | [-0.00012,0.000073] | -0.000007 | -0.000007 | FAIL: log loss change -0.000023 does not clear -0.0002; 95% interval [-0.00012,0.000073] is not below zero |
| recency_faster | `tq.halflife_days` ["mul",0.67] | -0.000027 | [-0.000074,0.000024] | -0.000012 | -0.000027 | FAIL: log loss change -0.000027 does not clear -0.0002; 95% interval [-0.000074,0.000024] is not below zero |
| recency_slower | `tq.halflife_days` ["mul",1.5] | 0.000038 | [0.000003,0.000068] | 0.000016 | 0.000033 | FAIL: log loss change 0.000038 does not clear -0.0002; 95% interval [0.000003,0.000068] is not below zero; Brier worse (0.000016); worse on VALIDATION (0.000033) |
| runs_tails_heavier | `dist.r` ["mul",0.8] | 0.000096 | [0.000034,0.000154] | 0.000034 | 0.000019 | FAIL: log loss change 0.000096 does not clear -0.0002; 95% interval [0.000034,0.000154] is not below zero; Brier worse (0.000034); worse on VALIDATION (0.000019) |
| runs_tails_lighter | `dist.r` ["mul",1.25] | -0.000031 | [-0.000089,0.000026] | -0.000011 | -0.000013 | FAIL: log loss change -0.000031 does not clear -0.0002; 95% interval [-0.000089,0.000026] is not below zero |
| team_spread_tighter | `tq.sigma_team` ["mul",0.75] | 0.000442 | [0.000152,0.000737] | 0.0002 | 0.000577 | FAIL: log loss change 0.000442 does not clear -0.0002; 95% interval [0.000152,0.000737] is not below zero; Brier worse (0.0002); worse on VALIDATION (0.000577) |

## Waiting on data we do not hold yet

These changes need inputs the record does not cover yet; they are not tried, and nothing stands in for the missing data.

- **roster_continuity_carry**: roster continuity covers 76.7% of D-I team-seasons 2014-2024 (needs 80%); the collegiate roster backfill (collegiate/plan.json) fills it
- **roster_continuity_stronger**: roster continuity covers 76.7% of D-I team-seasons 2014-2024 (needs 80%); the collegiate roster backfill (collegiate/plan.json) fills it
- **roster_continuity_weaker**: roster continuity covers 76.7% of D-I team-seasons 2014-2024 (needs 80%); the collegiate roster backfill (collegiate/plan.json) fills it

Every candidate ever tried: `docs/model-loop/college_baseball/candidates.jsonl`. Versions: `docs/model-loop/college_baseball/versions.json`.
