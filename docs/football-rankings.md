# EdgeDesk National Rankings — architecture and operations

How the ETSR system works, how to run it, and how to fix it when it breaks.
Written for the version of you that comes back in eight months.

---

## What it is

**ETSR — the EdgeDesk Team Strength Rating.** One number per FBS team, in
**points against an average FBS team, on a neutral field**.

```
    ETSR(A) − ETSR(B)   =   the neutral-field spread
```

Home field is **not** in it. Neither is travel, rest, weather, a specific
quarterback's absence, or a scheme matchup. Those are *game* facts, not *team*
facts, and the matchup layer applies them on top. Baking home field into a team
rating makes every rating wrong by the same few points and then double-counts it
at kickoff.

---

## The stack, bottom to top

```
  public feeds  ──►  football/data/box/          box enrichment, gated per season
                     football/players/           EPIR, units, scheme  (v1 + v2 candidate)
                            │
                            ├──► football/rankings/talent.js        roster ability
                            └──► football/rankings/performance.js   opponent-adjusted play
                                          │
                                          ▼
                                 football/rankings/etsr.js
                                 ETSR = (1−wP)·PRIOR + wP·PERFORMANCE
                                          │
                     ┌────────────────────┼────────────────────┐
                     ▼                    ▼                    ▼
                  ranks             weekly snapshot      matchup / simulator
```

Every layer is a separate module with its own version string, and each is
readable on its own.

---

## The arithmetic

```
  ETSR   = (1 − wP) × PRIOR        +  wP × PERFORMANCE
  PRIOR  = c × last season's ETSR  +  (1 − c) × talent
  wP     = g / (g + k)      g = FBS-equivalent games played
```

then **re-centred so the mean FBS team is exactly 0.0**.

* **`c`, the portal-era carryover coefficient.** The league slope is measured on
  every build by regressing each season's ratings on the previous season's — the
  same arithmetic the repo already uses to answer the NIL argument with data.
  Each team then moves around that league number on its own continuity:
  returning production **value**, quarterback continuity, line continuity,
  returning starters, transfer churn. Clamped to [0.15, 0.95] — nobody carries
  nothing, nobody carries everything. Current measured slope: **0.734** across
  2023→2024 (0.668), 2024→2025 (0.760), 2025→2026 (0.774).
* **`k`, the ramp.** Fitted, not chosen. Until the fit has run, a declared
  fallback is used and the rating says `scalars_measured: false`.
* **The talent floor.** Even in December, 15% of the PRIOR stays with roster
  talent. A team that lost its quarterback in October is not the team that
  played in September, and a results-only rating cannot see that.

**Talent and performance never collapse into each other.** They are rated,
ranked and published separately, because "elite roster that has not yet played
like one" is a real and useful state.

### Performance
Opponent-adjusted play-level efficiency: success rate, early-down success,
explosive rates, yards per play, sack rate, stuff rate, third-down conversion,
red-zone (regressed), turnovers (regressed 85%, because this repo measured
turnover margin to repeat at r = 0.077). **No EPA** — see the data-source doc.

The adjustment is a fixed point iterated to convergence with a 2% pull toward
the league mean each pass, which bounds the feedback loop that lets two isolated
teams inflate each other. It ships its iteration count and final movement.

Garbage time is filtered (score-differential-by-period: Q1 >38, Q2 >28, Q3 >22,
Q4 >16) and **both the full and competitive aggregates are carried**, so the
filter is auditable. Non-FBS opponents share one pooled identity that is solved
for, and their games are weighted at 45%.

### Confidence
Weighted by **what the rating actually leans on**: season-data components at
`wP`, roster components at `1 − wP`. A preseason board is not scored as ignorant
because no games have been played — it leans on the roster, and we have the
roster. A gate that duplicates a confidence component costs nothing extra; it
fires as the *explanation*, not as a second charge.

---

## Running it

```bash
npm run cfb:box        # box enrichment      → football/data/box/
npm run cfb:players    # EPIR + units (+ v2) → football/players/
npm run cfb:rankings   # ETSR + ranks + snap → football/rankings/
npm run cfb:test       # every football suite
npm run cfb:rebuild    # all of the above, in order
npm run cfb:validate   # the walk-forward — a PROMOTION DECISION, not a build step
```

Useful flags: `--season 2026 --seasons 4 --cache .cache/football --dry --quiet`.
`--allow-anomalies` publishes despite severe anomalies and should be used
deliberately, never as a way past a red build.

---

## The GitHub Actions

| workflow | when | what it does |
|---|---|---|
| `football-weekly-build.yml` | Tue + Sun 09:40 UTC, on relevant pushes, manual | box → players → rankings → snapshot → tests → **one** commit |
| `football-validation.yml` | manual; monthly **report-only** | the feature walk-forward, and only writes the registry when a human passes `write: true` |

**Why they are separate.** The weekly build must never recalibrate a weight.
Refitting on a schedule is how a research layer starts fitting the recent past
without anybody deciding to. Promotion is a human action with a reviewable diff.

The weekly build runs the suites **before and after** the write, then a shape
check that refuses to commit a wrong-sized dataset, and commits only if
something changed. Concurrency is grouped; `GITHUB_TOKEN` commits do not
retrigger workflows, so no loop is possible.

---

## Snapshots and point-in-time

`football/rankings/snapshots/<season>-w<ordinal>.json`, one per week ordinal.

* The **current** week's snapshot is refreshed as that week's games land.
* An **earlier** week's snapshot is finished and is **never rewritten**.
* Week ordinals, not calendar weeks: regular week *w* → *w*, postseason week
  *w* → *20 + w*, so the postseason sorts after the regular season and week 0
  falls out correctly.

"What was Texas ranked before week 5?" is answered by reading `2026-w04.json`,
and a backtest that re-reads it gets the numbers that existed then.

---

## Debugging

| symptom | look at |
|---|---|
| nothing is ranked | `confidence.value` per team against `RANK_MIN_CONFIDENCE`; check whether gates are double-charging |
| the board moved wildly | `stability` in `current.json` — mean rank shift, share moving 15+, max rating move |
| a team is missing | `anomalies` → `MISSING_TEAM`; usually a team-key mismatch against the schedule |
| a unit reads blank | `talent.covered_units` — a roster that spells its ends `DL` has not lost them |
| run defence says UNKNOWN | `run_defence_power.completeness` against `min_completeness` (0.40) |
| the adjustment did not converge | `performance_diagnostics.metrics[].iterations` vs `OPPONENT.max_iterations` |
| a metric is missing league-wide | `coverage` — a feed column failed its floor, which is the system working |
| the build refuses to commit | severe anomalies; read them, fix the input, do not reach for `--allow-anomalies` |

---

## Changing things

**Add a metric.** Add it to `OFFENSE_METRICS` / `DEFENSE_METRICS` in
`football/rankings/config.js` with `num`, `den`, `w`, `dir`, `min_n` and a
`basis`. It must be countable from the team-game aggregate; if the counter does
not exist, add it to `blankTG()` in `football/players/build_players.js` (add
fields, never repurpose them) and fan it into both the full and competitive
twins. Then run `npm run cfb:test`.

**Recalibrate weights.** Weights live in `config.js` and nowhere else. Change
them there, rebuild, and run `npm run cfb:validate` to see what it did out of
sample. Never tune a weight to make a ranking look right.

**Roll a rating version.** Bump the string in `config.js` `VERSIONS`. Artifacts
stamp the version they were built under, so old snapshots stay interpretable.
Never change a formula without changing its version.

**Promote a feature.** `npm run cfb:validate` runs the walk-forward and writes
`football/validation/feature-status.json`. A feature may move a projected number
only with status `VALIDATED`, which requires **all six** conditions:

1. at least two holdout seasons;
2. pooled out-of-sample MAE improves by ≥ 0.02 points;
3. a paired test over per-game absolute errors at p < 0.05;
4. no holdout season degraded by more than 0.15 points;
5. Brier does not worsen by more than 0.002;
6. the leakage tests pass.

**Today, nothing is validated.** Every enrichment is `RESEARCH_ONLY` or
`CANDIDATE`: it changes confidence, warnings, explanations and what is shown,
and it changes no projected number anywhere.

---

## Known limitations

1. **No recruiting feed.** The largest genuine gap; the dimension reads zero on
   purpose. Biggest effect: true freshmen and anyone with no attributed snaps.
2. **No snap counts.** Participation is box-score *appearances* plus touch
   share, and is never called a snap share.
3. **No individual offensive-line evidence.** The unit is rated from the team's
   own sack rate and stuff rate allowed, which are real. No lineman gets a grade.
4. **No EPA.** Success rate, explosive rate and yards per play are measured
   directly instead.
5. **Box defence starts in 2024.** Earlier seasons fail the gate and are
   declared missing, which limits the walk-forward to one holdout season and is
   exactly why nothing is promoted yet. A second season arrives with 2026.
6. **Availability is near-empty.** College football has no universal injury
   report; stale reports are discarded rather than counted.
7. **The market beats the model.** Closing-line MAE 11.52 against a baseline of
   12.49 on the 2025 holdout. Nothing here is an edge, and the pages say so.
