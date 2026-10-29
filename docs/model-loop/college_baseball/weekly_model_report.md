# College baseball weekly model report: 2026-10-29

Served version **1.0.0** (SERVED, selection-window tuning). The loop learns on SELECTION + VALIDATION (2014–2024); the HOLDOUT (2025–2026) is never read here (research/PROTOCOL.md). Outcome-graded only: no college baseball prices are archived.

## What changed

**Nothing staged.** 8 candidates were tested; none cleared the rule (over 2014–2024: log loss ≤ −0.0002 with its 95% interval below zero, Brier no worse, VALIDATION no worse).

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
| team_spread_looser | `tq.sigma_team` ["mul",1.33] | 0.000849 | [0.00059,0.001124] | 0.000352 | 0.001023 | FAIL: log loss change 0.000849 does not clear -0.0002; 95% interval [0.00059,0.001124] is not below zero; Brier worse (0.000352); worse on VALIDATION (0.001023) |
| conf_spread_tighter | `tq.sigma_conf` ["mul",0.6] | 0.000066 | [-0.000027,0.000162] | 0.00002 | 0.000046 | FAIL: log loss change 0.000066 does not clear -0.0002; 95% interval [-0.000027,0.000162] is not below zero; Brier worse (0.00002); worse on VALIDATION (0.000046) |
| roster_continuity_carry | `tq.cont_k` ["set",0.5] | 0.000088 | [-0.000018,0.000189] | 0.00002 | 0.000178 | FAIL: log loss change 0.000088 does not clear -0.0002; 95% interval [-0.000018,0.000189] is not below zero; Brier worse (0.00002); worse on VALIDATION (0.000178) |
| team_carry_lower | `tq.carry_team` ["add",-0.05] | -0.000051 | [-0.000116,0.000016] | -0.000024 | -0.000143 | FAIL: log loss change -0.000051 does not clear -0.0002; 95% interval [-0.000116,0.000016] is not below zero |
| dispersion_lower | `tq.phi` ["mul",0.85] | 0.000141 | [0.000056,0.000223] | 0.000057 | 0.000153 | FAIL: log loss change 0.000141 does not clear -0.0002; 95% interval [0.000056,0.000223] is not below zero; Brier worse (0.000057); worse on VALIDATION (0.000153) |
| dispersion_higher | `tq.phi` ["mul",1.2] | -0.000023 | [-0.00012,0.000073] | -0.000007 | -0.000007 | FAIL: log loss change -0.000023 does not clear -0.0002; 95% interval [-0.00012,0.000073] is not below zero |
| recency_faster | `tq.halflife_days` ["mul",0.67] | -0.000027 | [-0.000074,0.000024] | -0.000012 | -0.000027 | FAIL: log loss change -0.000027 does not clear -0.0002; 95% interval [-0.000074,0.000024] is not below zero |
| recency_slower | `tq.halflife_days` ["mul",1.5] | 0.000038 | [0.000003,0.000068] | 0.000016 | 0.000033 | FAIL: log loss change 0.000038 does not clear -0.0002; 95% interval [0.000003,0.000068] is not below zero; Brier worse (0.000016); worse on VALIDATION (0.000033) |

## Waiting on data we do not hold yet

These changes need inputs the record does not cover yet; they are not tried, and nothing stands in for the missing data.

- **starter_quality**: the schools' box scores cover 58.7% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_half**: the schools' box scores cover 58.7% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_stronger**: the schools' box scores cover 58.7% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_weaker**: the schools' box scores cover 58.7% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **platoon**: the starter's hand and the opposing nine's bats are both known for 27.2% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_half**: the starter's hand and the opposing nine's bats are both known for 27.2% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_stronger**: the starter's hand and the opposing nine's bats are both known for 27.2% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_weaker**: the starter's hand and the opposing nine's bats are both known for 27.2% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it

Every candidate ever tried: `docs/model-loop/college_baseball/candidates.jsonl`. Versions: `docs/model-loop/college_baseball/versions.json`.
