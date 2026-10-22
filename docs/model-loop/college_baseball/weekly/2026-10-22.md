# College baseball weekly model report: 2026-10-22

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
| conf_spread_looser | `tq.sigma_conf` ["mul",1.6] | 0.000151 | [0.000044,0.000258] | 0.00007 | 0.000138 | FAIL: log loss change 0.000151 does not clear -0.0002; 95% interval [0.000044,0.000258] is not below zero; Brier worse (0.00007); worse on VALIDATION (0.000138) |
| div_spread_tighter | `tq.sigma_div` ["mul",0.5] | -0.000118 | [-0.000211,-0.000031] | -0.000047 | -0.000062 | FAIL: log loss change -0.000118 does not clear -0.0002 |
| div_spread_looser | `tq.sigma_div` ["mul",2] | 0.000145 | [0.000072,0.00022] | 0.000054 | 0.000081 | FAIL: log loss change 0.000145 does not clear -0.0002; 95% interval [0.000072,0.00022] is not below zero; Brier worse (0.000054); worse on VALIDATION (0.000081) |
| park_spread_tighter | `tq.sigma_park` ["mul",0.5] | 0.000026 | [-0.000011,0.00006] | 0.000009 | 0.000079 | FAIL: log loss change 0.000026 does not clear -0.0002; 95% interval [-0.000011,0.00006] is not below zero; Brier worse (0.000009); worse on VALIDATION (0.000079) |
| park_spread_looser | `tq.sigma_park` ["mul",2] | -0.000049 | [-0.00009,-0.000013] | -0.00002 | -0.000103 | FAIL: log loss change -0.000049 does not clear -0.0002 |
| conf_carry_lower | `tq.carry_conf` ["add",-0.15] | 0.000008 | [0,0.000014] | 0.000003 | 0.000009 | FAIL: log loss change 0.000008 does not clear -0.0002; 95% interval [0,0.000014] is not below zero; Brier worse (0.000003); worse on VALIDATION (0.000009) |
| div_carry_lower | `tq.carry_div` ["add",-0.15] | 0.000108 | [0.000008,0.000215] | 0.000044 | -0.000008 | FAIL: log loss change 0.000108 does not clear -0.0002; 95% interval [0.000008,0.000215] is not below zero; Brier worse (0.000044) |
| park_carry_lower | `tq.carry_park` ["add",-0.15] | -0.000005 | [-0.000021,0.000011] | -0.000003 | -0.000004 | FAIL: log loss change -0.000005 does not clear -0.0002; 95% interval [-0.000021,0.000011] is not below zero |

## Waiting on data we do not hold yet

These changes need inputs the record does not cover yet; they are not tried, and nothing stands in for the missing data.

- **starter_quality**: the schools' box scores cover 0.1% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_half**: the schools' box scores cover 0.1% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_stronger**: the schools' box scores cover 0.1% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **starter_quality_weaker**: the schools' box scores cover 0.1% of D-I team-seasons 2014-2024 (a team-season counts when 80% of its contests are boxed; needs 80%); the collegiate box-score backfill (collegiate/plan.json) fills it
- **platoon**: the starter's hand and the opposing nine's bats are both known for 0.1% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_half**: the starter's hand and the opposing nine's bats are both known for 0.1% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_stronger**: the starter's hand and the opposing nine's bats are both known for 0.1% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it
- **platoon_weaker**: the starter's hand and the opposing nine's bats are both known for 0.1% of D-I team-seasons 2014-2024 (a team-season counts when they are for 80% of its contests; needs 80%); box scores and the schools' rosters (collegiate/) fill it

Every candidate ever tried: `docs/model-loop/college_baseball/candidates.jsonl`. Versions: `docs/model-loop/college_baseball/versions.json`.
