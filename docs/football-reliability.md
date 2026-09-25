# CFB reliability — what the number means, and how it is earned

**Reliability is how much EdgeDesk can trust the completeness, freshness,
internal consistency and stability of the information underneath one college
projection.** It is a 0-100 score built by `lib/cfb_reliability.js`.

It is **not**:

- **a probability.** A reliability of 90 does not mean a 90% chance the
  projection is right. The board prints it without a percent sign for that
  reason.
- **confidence.** The engine's information confidence (`scores.confidence`)
  weighs the evidence behind the number. Reliability scores the inputs, their
  ages, whether their sources agree, and whether the number survives
  reasonable changes to what is uncertain. The two are computed apart and may
  disagree: High confidence with Low reliability is a real, different object.
- **a betting signal.** It moves no fair spread, total or win probability, and
  it never reads a result or a closing line.

In the research workflow, a large model–market gap on LOW reliability is more
suspicious, not less. A moderate gap on VERY STRONG reliability is the one that
deserves attention.

## What it replaced, and why so many games sat on one number

Reliability used to be `input_coverage`, from the input contract
(`football/matchup/contract.js` `summarise`):

    input_coverage = (USABLE + RESEARCH_ONLY) / (fields − NOT_APPLICABLE)

This is an unweighted count of 26 contract rows. Every field counts once,
whether it is the quarterback or the off-field wire. The research view turned
it into LOW (under 0.60), ADEQUATE (under 0.85) or STRONG. No hard-coded 65%
existed anywhere. The clustering was structural. On the 129-game slate of
2026-09-25:

- **Six fields failed on nearly every FBS game, each for one systemic reason:**
  - availability ×2: the provider's depth-chart and participation endpoints
    refuse for all 138 programmes;
  - qb_availability ×2: no source states whether the starter can play;
  - off_field ×2: no source is registered.

  So 65 of 129 games read exactly 20/26 = **77%**. The mean was 74.5 and the
  median 77.
- **The live board holds fewer fields at load.** Weather, starters and EPA
  arrive late, so it often read 17/26 = **65%** for the same games.
- **The count moved in steps of one field, whatever the field was worth.** It
  could not see a stale input, two sources disagreeing, an unknown quarterback
  or a projection that swings on its own uncertainty.
- **A second number clustered as well.** The staking desk's `data_completeness`
  was the engine's own probe count, 0.60 on 85 of 129 games, because the college
  QB and injury probes are never priced. It fed the staking reliability,
  pinning every CFB spread there between 0.54 and 0.62.

## The score

    raw   = team_data + roster_availability + projection_stability
          + freshness + source_integrity + environment
    score = min(clamp(raw, 0, 100), every binding cap)

**There is no base score.** An empty input earns almost nothing, so every point
is earned from what is on file.

**An item that does not arise for the game leaves the component's denominator.**
Examples are weather under a roof, travel at a neutral site, and a market in an
artifact that joins none. The component is then rescaled over what applies.

**Absence of a question is never a penalty. Absence of an answer always is.**

| Component | Max | Items (points) |
|---|---|---|
| **Team data** | 20 | each team's rating (6 each: valid rating 3, prior-season rating 1, in-season sample 2 × games/6, less 1 for a sample dominated by FCS opponents); offense/defense matchup profile (4 × share of interaction pairs observed); power-rating state valid (2); schedule context (1 each) |
| **Roster / availability** | 20 | each starting QB's identity (4 each, × the calibrated rate at which that evidence class holds, × 0.75 if not corroborated or contested); each QB's status, i.e. whether he can play (2 each); each side's non-QB availability (3 each: 1.5 for coverage, 1.5 for impact certainty, weighted by the personnel impact rating); roster and production attribution (1 each) |
| **Projection stability** | 20 | spread dispersion under perturbation (14); favorite flips (6) |
| **Freshness** | 15 | rating state (3); player layer (2); rosters (2); each side's availability read (1.5 each); each side's QB evidence (1 each); forecast (1, outdoors and inside a week); market quote (2, only where a market is joined). Each input is aged on its own clock |
| **Source integrity** | 15 | each side's QB source agreement (2 each); absent players resolved to athletes (2); team identity (3); venue mapping (2); schedule mapping (1); market-event mapping (1.5) and independent market sources (0.5), where joined; no contradictory contract states (1) |
| **Environment** | 10 | venue identified (2); venue coordinates (2); home/away/neutral (1); travel inputs (1.5); weather where relevant (1.5); rest (1); matchup and conference classification (1) |

**The QB is the largest single block: 12 of the 20 roster points.**

**A non-QB absence is weighted by what the player is worth.** The personnel
impact rating (`football/personnel/`) supplies that weight. That rating has not
cleared validation, so it moves no spread. It moves reliability only, which is
exactly what an unpriced but measured absence should do.

**Three contract fields are published but not scored, each with its reason:**

- off-field reporting: no source is registered anywhere, it moves no point, and
  it carries 0.05 of the engine's 4.083 information weight;
- recruiting talent: research-only, and redundant with the measured production
  layer;
- coaching continuity: research-only.

## Projection stability

**The engine's mean is exactly additive:**
`fair_spread = Σ contributions` (`projectGame`). So perturbing an input that
enters one term linearly is perturbing that term.
`tools/football/reliability.test.js` proves this against a real engine re-run.

**The scenario design is fixed:** 32 Halton points, each mirrored, giving 64
deterministic scenarios over every uncertain term. Every machine produces the
same result, and cheaply enough that the board scores each game on every load.

**Each dimension's 1σ comes from uncertainty the system already publishes:**

- **A team's rating:** √(sample² + blend²).
  - *sample* = (1 − games/6) × the size of one more game's update. That update
    is the engine's own learning rates times its game-level noise.
  - *blend* = half the local range of the learned prior-weight curve, times how
    far the carried prior and this season's track disagree.
- **A side priced from the shared FCS floor:** half the gap between the engine's
  two defaults for an unobserved team, which is 8 pts.
- **Every other priced term** (home field, matchup, injury, conference, schedule,
  rivalry, QB): (1 − its engine confidence) × |its points|.

**Three inputs are not perturbed, and the output says why:**

- travel and weather move no point;
- the college QB term prices nothing until the starter layer has an
  out-of-sample record. QB uncertainty therefore cannot move the number and is
  carried by roster/availability instead.

**Stored per game:** `projection_stability_score`, `projection_stability_sd`,
`projection_p10`, `projection_p50`, `projection_p90`, `favorite_flip_rate`.

**A flip** is a scenario whose margin names the other team by at least the
engine's one-point near-pick'em floor.

| Tier | Rule |
|---|---|
| VERY STABLE | sd ≤ 1.5 and flips ≤ 2%, well inside the 2-pt research threshold |
| STABLE | sd ≤ 2.5 and flips ≤ 10% |
| MODERATE | sd ≤ 4.0 and flips ≤ 25% |
| UNSTABLE | anything more; cannot be STRONG or VERY STRONG |

## Hard gates

**A gate caps the score after the components are summed.** One fault can never
be averaged away by a pile of full columns. A missing optional field costs only
its own points.

| Gate | Cap | When |
|---|---|---|
| DATA_FAULT | 20 | any model self-check fails: no projection, a non-finite or out-of-range spread, a win probability outside (0,1) or favouring the other side, an inverted range, or additive terms that do not sum to the fair spread |
| IDENTITY_CONFLICT | 40 | the teams do not resolve, resolve to one identity, or the projection is for different teams |
| THIN_DATA | 59 | a side is priced from the shared FCS floor rating. This is a statement about the data, not the division: an FCS programme the state actually rates is scored on its rating |
| MISSING_CRITICAL | 59 | the offense/defense matchup profile is missing between two FBS teams |
| QB_UNKNOWN / QB_UNKNOWN_BOTH | 69 / 59 | no starting quarterback resolved for one or both sides |
| FUTURE_DATA | 59 | an input stamped later than the judging time |
| ROSTER_CONFLICT | 69 | an unresolved roster conflict: a CONFLICTING roster or availability row, or starter sources that disagree while the efficiency history cannot resolve the athlete |
| STALE_CORE | 69 | the rating state is more than a week old, or predates a team's latest game |
| VERY_UNSTABLE | 69 | flips ≥ 35% or sd ≥ 6 |
| QB_CONTESTED | 79 | the starting job is contested |
| UNSTABLE / STABILITY_UNMEASURED | 79 | the projection is unstable, or its stability could not be measured |
| STALE_ROSTER | 79 | rosters more than two weeks old |
| QB_STATUS_UNCONFIRMED | 89 | a known starter nobody has said can play. VERY STRONG requires both QBs' status established |

## Grades

| Score | Grade |
|---|---|
| 90-100 | VERY STRONG |
| 80-89 | STRONG |
| 70-79 | ADEQUATE |
| 60-69 | CAUTION |
| 50-59 | LOW |
| under 50 | VERY LOW |

**These are descriptive bands, not probabilities.** Older readers that key on
the research view's three tiers keep their meaning:

- STRONG is 80+;
- ADEQUATE is 60-79;
- LOW is under 60, the same bar input coverage used. LOW RELIABILITY therefore
  still fires under 60 and nowhere else, and `lib/research_priority.js` keeps its
  STRONG 1 / ADEQUATE 0.9 / LOW 0.7 trust factors.

## Explanations and next actions

Every score carries its components, each item earned with its specific reason,
the gates, every deduction largest-first, and a main deduction. Examples:

- "no source states whether Caden Veltkamp can play — silence is not health"
- "Army's availability sources refused — a provider-wide refusal, not this
  team's: espn_depth and espn_participation refuse for all 138 programmes"

**Nothing reads "input data incomplete".**

**Every game under 90 lists `next_actions`,** built as follows:

- **Gain:** each recoverable deduction carries an action. The game is re-scored
  with that input resolved in full and the gates it lifts removed.
- **Upper bound:** the gain is published as "up to +N". Stability is not
  re-simulated.
- **Inputs behind a binding cap:** an input stuck behind a binding cap is listed
  as "up to +N once the capping input is resolved".

**Where it shows:**

- **Hover:** the board's REL cell.
- **Click:** the "Reliability N — GRADE: what it is built from" section on the
  game card.

## FBS and FCS

**Nothing is charged for being FCS.** An FCS game scores lower on this slate for
real reasons:

- the opponent is priced from one floor number shared by every FCS programme,
  hence THIN DATA;
- there is no roster, availability read, matchup profile or starter;
- the floor widens the projection's dispersion.

**Given the data, the score rises.** `reliability.test.js` checks that an FCS
opponent with an actual rating and full inputs scores exactly what the same data
scores for an FBS one.

## Where it lives

**Scorer.** `lib/cfb_reliability.js` is pure and deterministic, judged at
`input.now`, and never reads the wall clock. Its API:

- `R.score` (the score);
- `R.stability` (the perturbation test);
- `R.inputFor` (the one input adapter);
- `R.explain`, `R.published`, `R.compact`;
- `R.summarize` (the dashboard);
- `R.calibrate` (calibration).

**The build.** `football/fbs/build_coverage.js` scores every slate game from
exactly what it priced from. It adds these fields to `football/fbs/slate.json`:

- `reliability_score`, `reliability_grade`, `reliability_components`,
  `reliability_next_actions`, `projection_stability`, `reliability`;
- `input_coverage` is kept unchanged beside them.

It also writes `football/fbs/reliability.json`, which holds the dashboard, every
game's compact score, and the ranking layer's team gates for the board.

**The build joins no market,** so market items do not apply to published
scores. The board re-scores live with the same library and its own market join,
so a difference between the two is a difference in data, never in code.

**The board (`app.html`):**

- the REL cell prints the score (no %), with the explanation on hover;
- the card has the full breakdown;
- the research label reads the scored reliability;
- the CSV and the workbook's Raw Export sheet append `reliability_score`,
  `reliability_grade`, `projection_stability_sd` and `favorite_flip_rate` after
  every existing column. `football/cfb_p4/export_csv.js` declares the same
  columns, copied from the published slate.

**The published brief** (`V.brief`) carries the score, grade, components, main
deduction, next actions and stability.

**The model record** (`tools/record/football_record_core.js`):

- it freezes the pregame reliability in `pick` and `first` under the same
  publication-time rule as the number;
- a later pregame read with an unchanged number refreshes it without counting a
  revision;
- the grade carries its bucket, and the summary publishes `by_reliability`.

**The Collective API rows are unchanged.** The ingest validator refuses fields
it has not seen and falls back to the lean schema. Adding reliability there
needs a schema migration first.

**The dashboard.** `admin/reliability/` covers the slate distribution, grades,
components, bottlenecks, caps, conferences, the 20 lowest and highest games,
and calibration. `npm run cfb:reliability` prints the same.

## Scored from the game evidence package

Since the enrichment layer (`football/enrichment/`, `lib/game_evidence.js`),
each game is scored from ONE normalized evidence package when one exists. The
package **replaces the contract's interpretation of availability and QB
status**. Weights, caps and grade bands are unchanged: identical evidence
scores identically, and new points come only from evidence the contract
could not see.

**What the package changes:**

- **Availability is fixture-scoped.** A team's report for a *different* game
  no longer marks this one USABLE.
- **Comprehensive silence establishes QB status.** When the team's
  comprehensive official report for this game does not list the starter, he
  is available by the conference's own policy. The contract dropped this
  whenever the report listed anyone at all. That kept every SEC, Big Ten, ACC
  and Big 12 game under the QB_STATUS_UNCONFIRMED cap (89), so no game could
  be VERY STRONG.
- **A historical feed row is not today's fitness.** ESPN's college endpoint
  returns 2020–2022 rows. They are refused as HISTORICAL, where the contract
  had read one as a 2026 QB being cleared.
- **The QB resolver:**
  - its confirmation level and conflict verdict drive the identity item, the
    source-agreement item and the gates;
  - a new gate, QB_CONFLICTED, applies when the hierarchy cannot settle a
    conflict, at the existing contested cap (79);
  - a job split by usage is scored once, as contested. The contract had also
    counted it as contradictory sources and, through the efficiency identity,
    a third time;
  - source agreement is the tier-weighted share of current evidence naming the
    starter. EdgeDesk's own quality ranking is weighed at half an observed
    start, because it is not an independent source.
- **Unrated absences are charged by role.** A CRITICAL or MAJOR absence costs
  the rate an unrated "starter" always cost (0.5). The old test for a starter
  was depth rank ≤ 2, which called three of five starting linemen reserves.
  Unrated absences on a team the personnel layer rated are now charged too,
  where they were dropped.
- **The FCS bridge.**
  - The floor-priced side's perturbation uses the floor's measured error,
    √(gap² + sd²), in place of ±8.
  - THIN DATA lifts only for a STRONG rating that corroborates the floor.
- **Potential reliability.** Every result publishes `potential` and
  `recoverable_by_family`: the score with every recoverable input resolved,
  from the same simulator next actions use. It is not a probability.

**Measuring the effect.** The build scores every game both ways and publishes
`summary_without_evidence`, so the effect is measured on identical
projections. The no-evidence path reproduces the pre-enrichment scorer
exactly on all 129 games of the 2026-09-25 slate.

**The contract now reads availability the same way.** The input contract
(`football/matchup/contract.js`), which feeds the engine's injury list and
its QB information term, now follows the same rules as the package:

- one official report per fixture, and a grade for each fixture;
- team-scoped rows dated against the kickoff, with HISTORICAL ones refused;
- the collector's own status field read;
- an explicit OUT scored as OUT;
- silence on a fresh comprehensive filing for this game read as available,
  whoever else it lists.

It closed the historical ESPN rows that had reached the priced injury lists
of Florida and Illinois. On the 2026-09-25 slate that change:

- moved no fair spread, total or win probability;
- raised engine information confidence on 24 games;
- lowered priced confidence on 2.

`football/validation/availability_contract_before_after.md` has the game by
game record. Because the package already applied these rules, the
evidence-scored reliability did not move. `reliability_without_evidence`,
which reads the contract rows, now sits closer to it.

## Calibration: not validated

**The question:** does a higher pregame reliability go with a smaller
projection error? The score is published as validated only when the ordering
holds in every bucket with 30+ graded games. It was never tuned against
outcomes.

**Method.** `tools/football/reliability_report.js backfill` scores each graded
2026 pick walk-forward:

- **What it reads:** the slate the pick was published from, judged at that
  slate's own `generated_at`.
- **Rating terms:** replayed from only the games completed before that slate.
- **Team gates:** from the latest earlier weekly snapshot.

The two week-2 slates predate the input contract, so 85 of the 161 graded games
cannot be scored. They are counted, not guessed.

| Bucket | n | MAE vs close | MAE vs result |
|---|---|---|---|
| 80-89 | 41 | 5.01 | 9.43 |
| 70-79 | 12 | 5.57 | 10.85 |
| 60-69 | 5 | 6.07 | 4.13 |
| 50-59 | 18 | 10.40 | 16.46 |

**What the table shows:**

- **Against the close:** error rises as reliability falls, in the pooled table
  and in FBS-vs-FBS games alone (5.01 / 5.57 / 6.07).
- **Median split at 80:** MAE vs close 4.95 above against 7.79 at or below.
- **Against the result:** not monotone.
- **Too few games:** only one bucket holds 30 games, and nearly all come from a
  single week.

**Verdict: NOT VALIDATED.** The direction is encouraging and the sample is far
too small to say more.

**What changes the verdict:** every graded game from now on carries the
reliability it was published under (`summary.by_reliability`), and
`npm run cfb:reliability:calibrate` re-reads it.
