# What "data confidence 73%" means, and where the other 27 points went

A card was publishing five numbers that looked like one number.

    Data confidence          73%      a WEIGHTED score over twelve model inputs
    of it priced             48%      the same table over the PRICED measurements
    contract fields       11 / 17     an unweighted COUNT of applicable fields
    completeness             60%      the engine's own internal probe count
    win probability     100% / 0%     a probability of an outcome

Nothing said they measured different things, so a reader comparing them
concluded the page was inconsistent. They were not inconsistent. They were five
different questions, three of them had no published definition, and one of them
was a lie: a projection built on a continuous margin distribution cannot mean
100%, and that card's own number was 0.9977.

`football/matchup/confidence.js` is now the one place any of them is computed
or named, and it publishes them together with the arithmetic that connects
them.

## The five questions, kept apart

| Name | Question | Denominator | What it is NOT |
|---|---|---|---|
| `information_confidence` | **evidence quality** — how well is each model input known? | the sum of the trained confidence weights (4.083) | a count of fields; a probability |
| `priced_confidence` | **validated pricing coverage** — how much of what we know does the published line use? | the same weight sum | evidence quality. It is always lower, and the gap IS the unpriced share |
| `input_coverage` | **input coverage** — how many applicable contract fields did we retrieve? | applicable contract fields | the weighted score. The quarterback and the weather count the same here and do not there |
| `historical_sample` | **sample sufficiency** — of the inputs that were measured, how many publish the size of the sample behind them? | the inputs that returned a measurement | a claim that the samples are large enough |
| `engine_probe_completeness` | the engine's own internal probe count | the engine's probe list | a measure of the data supplied to it |
| `outcome_probability` | the probability of an outcome | — | every other number on this list |

A fully populated dataset does not make an outcome certain, and a high
confidence is not a prediction that the model is right. Those are the two
mistakes the separation exists to prevent.

## The ledger

For every game the slate now carries `confidence_ledger`, and for every
applicable field it says:

* the field and the team, what it **means** and in what **units**
* the **source**, the **observation** time and the **retrieval** time — two
  clocks, because re-reading an unchanged artifact does not renew an
  observation
* its **freshness floor** and whether it is past it
* how its **identity** was resolved
* its **state**: observed, research-only, stale, conflicting, not required, not
  due yet, fetch-failed, unavailable, or genuinely not applicable
* the **engine input** it feeds, that input's **weight**, and the **exact
  number of points** this field is costing the displayed score
* whether it **affects pricing**
* the **fix** — the specific thing that would fill it

And it checks its own arithmetic. `reconciles.agrees` is true only when the
displayed score plus every attributed point is 100. Where the contract and the
weighted score describe the same game differently, `disagreements` names the
pair rather than absorbing the difference into a rounding.

    node tools/football/confidence_ledger.js --game "miami @ wake forest"

## What may not be done to raise it

These are the rules the tests hold, in `football/matchup/confidence.test.js`:

* **STALE, CONFLICTING, FETCH_FAILED, UNAVAILABLE, NOT_REQUIRED and
  NOT_DUE_YET never count as retrieved and never count as verified.**
* **INFERRED is known and NOT verified.** They are different sets and the
  smaller one is the one a reader should trust.
* **`NOT_APPLICABLE` is the only state that leaves the denominator**, and only
  for a question that genuinely does not arise: weather under a roof, travel
  asymmetry at a neutral site. "Nobody was required to file" is a reason for
  not knowing, not a reason to stop counting.
* **A retrieved field can still cost points.** A roster EdgeDesk holds in full
  can leave its layer partly measured; the ledger says the gap is inside the
  field rather than letting it look like a bug.
* **No interior probability renders as 100% or 0%.**

## Before and after, on the same 77-game slate

Measured by running both trees against the same schedule feed at the same
instant (`8ffb1bb~1` versus the branch head):

| | before | after |
|---|---|---|
| mean information confidence | 70.29% | **70.89%** |
| median | 80.4% | 79.8% |
| lower decile | 45.2% | 42.2% |
| minimum | 23.6% | **30.4%** |
| mean input coverage | 59.0% | **61.1%** |
| mean priced confidence | 39.33% | 39.33% *(unchanged — nothing new is priced)* |
| `starting QB unknown` warnings | **154** | **4** |
| Miami at Wake Forest | 72.14% · 12 of 19 fields | **77.80%** · 17 of 25 |
| Houston at Texas Tech | 72.36% · 12 of 19 fields | **77.07%** · 17 of 25 |
| Power Four games (39) | 78.64% | **80.00%** |
| other FBS (20) | 77.73% | **79.04%** |
| FBS vs FCS (18) | 43.94% | **42.08%** |

**The slate mean barely moved, and that is the honest result.** The calculation
corrections raised it and the honesty corrections lowered it, by design:

* `off_field` became a contract field because the engine scores it and it is
  missing on every game. Publishing the gap costs coverage.
* The FCS side's roster, availability and talent are counted as the gaps they
  are instead of being excused as inapplicable — which is why the FBS-vs-FCS
  tier FELL and the two Power Four tiers rose.
* `NOT_REQUIRED` and `NOT_DUE_YET` stay in the denominator.

The contract also grew: 19 applicable fields to 25, because `team_rating`,
`matchup_profile`, `recruiting_talent` per side and `off_field` per side were
being scored and not published. A larger denominator with the same numerator
is a lower percentage and a truer one.

What did NOT move is `priced_confidence`, at 39.33% on both arms. Nothing in
this change prices anything new, and the number that says so is unchanged to
two decimal places.

## Where the points actually went, week 3 2026

Seventy-seven games. Mean information confidence **70.9%**, median **79.8%**,
lower decile **42.2%**.

| Engine input | Weight | Max points | Mean lost | Unmeasured |
|---|---|---|---|---|
| `qb` | 1.0 | 24.49 | 8.10 | 0/77 |
| `rating` | 1.0 | 24.49 | 4.93 | 0/77 |
| `roster_away` | 0.25 | 6.12 | 2.97 | 18/77 |
| `injuries` | 0.35 | 8.57 | 2.83 | 0/77 |
| `weather` | 0.1 | 2.45 | 2.45 | 77/77 |
| `matchup` | 0.4 | 9.80 | 2.42 | 19/77 |
| `roster_home` | 0.25 | 6.12 | 1.95 | 0/77 |
| `offfield_home` | 0.05 | 1.22 | 1.22 | 77/77 |
| `offfield_away` | 0.05 | 1.22 | 1.22 | 77/77 |
| `travel` | 0.1 | 2.45 | 0.69 | 19/77 |
| `venue` | 0.25 | 6.12 | 0.32 | 0/77 |
| `schedule` | 0.283 | 6.93 | 0.01 | 0/77 |

The three largest are not the same kind of problem, and the ledger is what
makes that legible:

* **`qb` 8.1** is mostly the availability of the resolved starter. It is a
  document that exists and EdgeDesk has not read, and it closes when the
  conference report lands.
* **`rating` 4.9** and **`matchup` 2.4** are concentrated entirely on the
  eighteen FBS-vs-FCS fixtures, where one side is priced from a single floor
  number shared by every FCS programme. That is a real gap and is now a real
  contract row rather than an unattributed residue.
* **`weather` 2.45 on all 77** was an artifact of the build environment, not
  of the provider. See below.

## What each remaining gap is worth

`tools/football/confidence_scenarios.js` runs the engine with each missing
field supplied and prints the difference. Every number it prints is a
hypothetical and the tool says so on every run; nothing it computes reaches a
card or an artifact.

| Acquisition | Mean points returned |
|---|---|
| the conference report designates the quarterback | **+4.8** |
| the team announces its starter | **+3.9** |
| the forecast provider answers | **+2.1** |
| an off-field reporting feed is wired in | **+1.2** |
| the conference availability report names an absence | +0.3 |

With all of them: mean **82.9%**, median **93.0%**, and 53 of 77 games at 90%
or better. The two reproduction cases go **77.8% → 93.4%** (Miami at Wake
Forest) and **77.1% → 93.3%** (Houston at Texas Tech).

## Why 95% is not reachable this week, precisely

With every recoverable acquisition supplied, a fully-evidenced Power Four game
lands at 93.4%, and the remaining 6.6 points are these:

| Residual | Points | Why it is a ceiling |
|---|---|---|
| `roster_home` + `roster_away` | 3.80 | the player layer's talent composite carries its own measured confidence, and in week 3 it is 0.49 — two games of attributed production. It rises with the season and cannot be raised by acquiring anything |
| `offfield_home` + `offfield_away` | 1.22 | the off-field layer's measurement confidence is a declared 0.5 even with a feed supplied: a feed can miss something |
| `qb` | 0.61 | `DECLARED_STATUS.ANNOUNCED` is 0.95, not 1.0 — an announcement is not a guarantee |
| `weather` | 0.37 | a forecast is 0.85, not 1.0 |
| `venue` + `travel` | 0.43 | a resolved venue is 0.95 |
| `injuries` | 0.21 | inherits the quarterback observation's own ceiling |

Every one of those is a DECLARED constant with a stated reason. Raising any of
them would raise the score and would mean nothing, which is why none of them
was touched. **95–100% is not earnable for any game on this slate**, and the
reason is not a missing feed: it is that the model's own layers decline to
claim certainty they do not have. The honest ceiling for a fully-supplied
Power Four game in week 3 is about 93.5%, and it rises through the season as
the player layer's production accumulates.

## Coverage of the things the number is made of

| | before | after |
|---|---|---|
| starter resolved by athlete id | 150 of 154 sides (97.4%) | unchanged — it was already good, and the WARNING was the bug |
| starter evidence class | 239 last-game proxy · 29 competition · 7 unknown | published per row as CONFIRMED / PROJECTED / COMPETITION / LAST_GAME_PROXY / UNKNOWN |
| availability, automated read | 138 of 138 programmes graded LIMITED, 0 records | unchanged automated; the policy state is now published per fixture: 71 NOT_REQUIRED, 28 NOT_DUE_YET, 37 FETCH_FAILED, 18 outside the registry |
| official conference reports registered | 0 | 7 conferences with a verified url, cadence, scope and vocabulary; 3 recorded UNVERIFIED |
| fresh-market coverage | 0 live, 0 recent, 46 stale of 46 | unchanged — the capture pipeline is a separate job; what changed is that the model clock can no longer stand in for the price clock |
| player-id match | "1746 of 15542 with attributed production" | 5,509 with an attributed event · 1,746 with a career quality score · 193 this season · 2,905 provider ids on no FBS roster · **45 real broken joins, 42 fixable from EdgeDesk's own sync** |
| team recruiting talent | none | 137 of 138 programmes; Hawai'i is not in the provider's table |
| venue coordinates | 2 FBS home venues missing | 0 |

## Every remaining missing field, and what it costs

| Field | Games | Mean points | Why |
|---|---|---|---|
| `off_field` (×2) | 77 | 2.44 | no feed is wired in. The engine scores it |
| `weather` | 77 | 2.45 | blocked in this build environment; a networked build supplies it |
| `qb_availability` | 153 | ~4.8 | 71 not required (non-conference), 27 not due yet, 55 unread |
| `availability` | 154 | ~2.8 | same three reasons |
| `team_rating` / `matchup_profile` / `roster*` on the FCS side | 18 games | up to 20 | EdgeDesk does not rate the FCS field |
| `coaching_continuity` | 77 | 0 | it feeds no scored input. Checked 2026-09-15: sportsdataverse publishes no coaching table, CFBD needs a per-user key whose terms forbid committing the result |
| `recruiting_talent` | 1 | 0 | Hawai'i is not in the provider's table. Research only; feeds no scored input |

## Calculation corrections, separated from data gains

Requirement: a scoring change needs a semantic reason and a before/after, and
gains from correcting the calculation must not be reported as gains from new
data. On Miami at Wake Forest, in order:

| Change | Before → after | Kind | Reason |
|---|---|---|---|
| empty position groups leave the roster denominator | 72.1 → 74.6 | correction | the roster feed files edge rushers under DL/LB and every defensive back under DB, so EDGE, CB, S, RET and ATH arrived with zero players and six empty fields each. Every one of those players IS counted, under another group. 24 of 97 denominator slots were a vocabulary mismatch |
| the quarterback term measures four questions, not one | 74.6 → 77.8 | correction | the term's contract is "how good is my information about the quarterback"; it returned only the persistence rate, so a 15-start id-resolved passer with a joined EPA history scored identically to an anonymous one with the same last-game share |
| team recruiting talent ingested | coverage 63.2% → 70.0% | **new data** | `cfb_team_talent` is public and keyless in a mirror this repo already reads. Research only |
| off-field published as a contract field | coverage 70.0% → 63.6% | correction | the engine scores it and it is missing on every game; publishing the gap LOWERS coverage and is the honest direction |
| FCS roster/availability counted as gaps | coverage falls on 18 games | correction | the contract called them NOT_APPLICABLE while the score charged 6.1 points for them. The ledger found the disagreement |
| `rating` and `matchup` given contract rows | — | correction | the two biggest-weight inputs had no field to attribute their loss to |
| neutral-site travel is an answer, not a gap | +0.12 on 2 games | correction | the schedule feed declares the neutral site, so "is there a travel asymmetry" is answered exactly |

The starter persistence calibration was re-measured on a second dimension
(`football/starters/calibrate_persistence.js`) and the new table was chosen
**out of sample**: leave-one-season-out over 10,843 pairs, lowest held-out
Brier. Two of the four candidates were rejected on that evidence, including the
one that would have raised the score most.

| Conditioning | Held-out Brier | Log loss | Coverage |
|---|---|---|---|
| last-game share (v1) | 0.13202 | 0.43025 | 1.0 |
| **last-game share × consecutive starts** | **0.12820** | **0.41570** | 1.0 |
| season-to-date share × consecutive starts | 0.14171 | 0.45130 | 1.0 |
| competitive-snap share × consecutive starts | 0.12852 | 0.41718 | 1.0 |

The garbage-time correction is the interesting rejection. A quarterback pulled
with a thirty-point lead lands in the same band as one who was benched, and
removing garbage time to separate them sounds obviously right. It is not: it
scores *worse* out of sample than the raw share. The theory was plausible and
the data refused it, so the engine reads `band_x_run`.

## Verifying the deployment, and not lying about the verification

Requirement: verify that deployed code and artifacts contain the fixes, not
merely that a pull request merged. `tools/football/verify_deployment.js` reads
the **served** artifact and asserts the six things that are only true when the
fix is live — the ledger reconciles, no observation time was reset by a
re-read, the weather rows are not a build's own blocked host, the market never
borrows the model's clock, no probability is published or rendered as 100%/0%,
and every availability row carries a policy state rather than a shrug.

It has three outcomes, not two:

| Exit | Meaning |
|---|---|
| 0 | read, and it carries the fixes |
| 1 | read, and it does **not** — a real deployment failure |
| 2 | **not read** — nothing has been established in either direction |

The third one exists because the tool made its own mistake. Run from a host
whose egress refuses `edgedesksports.com`, it printed *"1 check(s) failed: the
deployed artifact does not carry what the repository says it does."* That was
false, and false in the same direction as the bug it was written to catch: a
refusal at the **reader's** end reported as a fact about the deployment. The
artifact was fine.

So before it concludes anything it now asks the host for something else. If the
host answers and withholds only the artifact, the artifact really is absent and
that is exit 1. If the host answers nothing at all, it is this reader that is
blocked, and the tool says so and asserts nothing. `diagnose()` is that decision
as a pure function; `tools/football/verify_deployment.test.js` holds it against
real loopback sockets, alongside one fixture per check that breaks exactly one
rule and must be named by the check that owns it.

Against the artifact served at `d932eb7`, all 17 checks pass — including
`the weather rows are not one build's blocked host published as a fact about
the sport — 0 failed of 77`, which is the reproduction case closed: the
scheduled build now supplies forecasts instead of publishing its own blindness.

To verify from a host that cannot reach the site:

```
curl -o /tmp/v/football/fbs/slate.json \
  https://raw.githubusercontent.com/<owner>/<repo>/<deployed-sha>/football/fbs/slate.json
node tools/football/verify_deployment.js --local --root /tmp/v
```
