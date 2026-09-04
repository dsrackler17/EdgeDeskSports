# The EdgeDesk Player Quality + Scheme Matchup Engine

A national player-value and matchup layer underneath the existing Football
research page. It does not replace the Power 4 engine, it does not price a
line, and — on today's evidence — **it is not allowed to move one.** That last
sentence is a result, not a disclaimer, and the rest of this file is how it was
reached.

```
football/players/
  config.js               EVERY weight, threshold, band and position contract,
                          under one version string. Nothing that changes a
                          number lives anywhere else.
  epir.js                 the EdgeDesk Player Impact Rating — identity, rates,
                          baselines, shrinkage, confidence, provenance
  units.js                position groups, team units, returning VALUE,
                          transfer value
  scheme.js               team tendency profiles, and the named list of scheme
                          dimensions no public feed carries
  matchup.js              matchup matrix, scheme edges, run-defence gate,
                          player edges, risk gates
  sim.js                  the seeded Monte Carlo, the line ladder, the
                          sensitivity, and the structural read
  recruiting_adapter.js   the recruiting seam. Nothing is wired in and every
                          recruiting field ships null.
  build_players.js        the loaders and the arithmetic
  run_build.js            the runner that writes the committed artifacts
  validate.js             the walk-forward that decides whether any of it may
                          move a line
  params.js               GENERATED: the MEASURED constants + the calibration
  players.test.js         275 checks
  current.json            the league-wide manifest the page loads on open
  index.json              the searchable national player index
  teams/<key>.json        per-player provenance, loaded on demand
  snapshots/<season>-wNN.json   point-in-time, never rewritten
  report/BACKTEST.md      the walk-forward record
```

---

## The record, first

Held out on **2024–2025**, seasons no scalar in this layer was fitted on, over
1,606 FBS-vs-FBS games replayed cold in kickoff order:

| arm | spread MAE | Brier |
|---|---|---|
| baseline (Power 4 rating core) | 12.826 | 0.1882 |
| **+ player quality** | 12.808 | 0.1877 |
| **+ player quality + scheme** | 12.813 | 0.1877 |
| closing market | **11.770** | — |

The player layer moves pooled holdout MAE by **0.018 points**. A paired test
over the per-game absolute errors returns **p = 0.40**, and it is *worse* in
2024 and better in 2025. That is a coin flip wearing a lab coat.

So `params.js` ships `player_points_per_unit.points_applied: false` and
`scheme_points_per_unit.points_applied: false`. **This layer changes no
projection anywhere in EdgeDesk.** The Football board's numbers are exactly
what they were before it existed. The Linemaker view on every game card shows
the player-adjusted and scheme-adjusted rungs sitting flat on the raw model,
with the p-value on screen.

The bar a layer has to clear before it may move a line is deliberately three-
part, because "lower MAE on the holdout" is far too weak on its own — with
sixteen hundred games a coin flip clears it about half the time:

1. lower pooled holdout MAE, **and**
2. a paired test over per-game absolute errors at **p < 0.05**, **and**
3. lower MAE in **every** holdout season separately.

`validate.js` applies all three and writes the verdict into `params.js`. The
day the layer clears them, the same file turns `points_applied` true and the
ladder starts moving on its own — no code change, no opinion.

`baseline + recruiting`, the third arm the brief asks for, **was not run**. No
recruiting feed is wired in, and a placebo arm would have been a lie.

---

## What the data actually supports

The whole layer rests on one public feed: cfbfastR's `player_stats`, a
play-attribution table with one row per play naming the players credited with
the events on it, and with down, distance and yards-to-goal on **every** row.
It is the only public per-player production feed in college football.

It is also much thinner than a scouting database, and pretending otherwise is
the failure mode this layer is built to avoid. What it does and does not carry
was established by counting rows, and `build_players.js` re-counts on every run
and writes the counts into the dataset — so the day the feed changes, the
dataset says so instead of the code lying.

**Observed and stable:** rushes, receptions, completions, incompletions, sacks
taken, sacks made, field goals, fumbles.

**Observed and unstable — gated per season:** targets, interceptions, pass
break-ups, forced fumbles. These have season-scale coverage collapses (2023
carries 695 interceptions across 1,473 games — 0.47 a game, which is not
football). Each is checked against a floor every season; a season that fails
has that measure **declared missing league-wide**, never scored as if the
events did not happen.

**Not observed at all:** snap counts, tackles, tackles for loss, run stops,
missed tackles, pressures short of a sack, coverage targets, completions
allowed, route participation, blocking, alignment, personnel groupings, punts,
and recruiting ratings.

Three consequences, stated plainly wherever they matter:

* **No offensive lineman can be rated individually by anything public.** The OL
  measure contract is *empty on purpose*. The OL **unit** is rated from the
  team's own opponent-adjusted sack rate and stuff rate allowed, which are
  real, and the panel says which half of the rating came from where.
* **Defensive production is per team-game, not per snap.** A defender who did
  not play is indistinguishable from one who played and did nothing. Both rate
  low and both say why.
* **"EPA" is not computed.** The play table carries no next-score information,
  and the expected-points surface this repo once fit is no longer reproducible
  from public files. Success rate, explosive rate and yards per play are
  measured directly instead of an EPA being invented.

---

## EPIR, in one page

**0–100. 50 is positional replacement. 12 points is one standard deviation of
that position's own qualified population.**

```
  COUNT        events attributed to the player
  RATE         position-specific rates with their own denominators
  ADJUST       each rate moved by the quality of the defences actually faced
  STANDARDISE  against his OWN position group in the SAME season
  SHRINK       z_hat = z_career * n/(n+k) + z_prior * k/(n+k)
  SCALE        50 + 12 * z_hat, plus role (max 4) and experience (max 3)
  DECLARE      confidence, sample, completeness, every component used, every
               component missing, and where all of it came from
```

**k is measured, not chosen.** It comes from each position group's own observed
season-to-season reliability of the composite, `k = n̄(1−r)/r`, over
consecutive-season pairs for the same athlete id. The current build measures it
over 1,611 pairs:

| group | r | pairs | k |
|---|---|---|---|
| QB | 0.385 | 252 | 532 |
| WR | 0.356 | 462 | 97 |
| TE | 0.269 | 172 | 92 |
| RB | 0.258 | 373 | 379 |
| K | 0.087 | 142 | 203 |
| CB | −0.037 | 45 | *not measured — fallback used, and flagged* |

Kicking barely repeats and corner production does not repeat at all in this
feed; both facts ship on the rating rather than being smoothed away. A group
with too few pairs uses a declared fallback and every rating built on one is
marked `k_measured: false`.

This is also what makes pedigree lose to evidence. A prior (recruiting, when a
feed is ever wired in) starts with weight `k/(n+k)`; as college snaps
accumulate that weight falls toward zero on its own. A five-star with a long
bad record ends up rated below a productive three-star **by arithmetic**, and
`players.test.js` asserts it.

### Confidence is orthogonal to the rating

`confidence = 0.15·identity + 0.40·sample + 0.25·completeness + 0.20·recency`,
then multiplied down for a transfer (new system, same player), capped for a
group with no production feed, and capped again for an unconfirmed role.

A 75 at 90% and a 75 at 30% are different statements and nothing in this layer
merges them.

### What is deliberately NOT in EPIR

* **Availability.** It changes who plays, not how good a player is. It is
  applied in the unit aggregation, so PLAYER QUALITY and AVAILABILITY stay
  separable and a player is never silently downgraded for being hurt.
* **Scheme fit.** Published as its own measurement; it does not move EPIR until
  a walk-forward says it should.
* **Transfer status.** A transfer's production is his own production. Changing
  schools widens the confidence band, not the mean.

---

## Units, not averages

A quarterback room is not the mean of its quarterbacks; a defensive front
almost is. Each group is weighted by the shape of how that position is actually
rotated (`config.js` `ROLE.depth_curve` — five linemen carry 92.5% of the line,
six defensive linemen split the front nearly evenly). Playing time, never
quality.

**Returning production 2.0.** Roster continuity counts bodies. **Value
continuity** is the share of last season's production value still on the
roster, where value is `(EPIR − replacement) × √volume × position value`. Both
are published side by side *because they disagree* — Pittsburgh's current build
returns 56% of its players and 47% of its value, and that gap is the
information. Returning replacement-level players adds nothing, by construction.

**Transfer intelligence** values every incoming and outgoing transfer the same
way, so thirty backups cannot out-grade five starters. An incoming transfer
with no production history is bucketed as HIGH UNCERTAINTY — not zero, not
average — so he cannot quietly inflate the total.

---

## Scheme: what it can say, and what it refuses to

Twelve offensive and nine defensive tendencies are measured from the play table
and standardised against the league: pace, rush rate, early-down pass rate,
success rate, explosive rates, stuff rate, sack rate, and the same allowed.
Week one is mostly last season and says so — the counters blend with last
season's down-weighted by `λ = 1 − plays/600`, and every profile reports the λ
it used.

Everything else a "scheme database" is supposed to contain is **named as
underivable and never guessed**: personnel groupings, run concepts, RPO and
play-action rates, motion, defensive front, coverage shells, blitz rate, box
counts. None of it exists in any public college feed.

The one inference made — even or odd front — comes from how a program *spells*
its own front seven on the roster, is capped at 0.35 confidence, and is labelled
a GUESS everywhere it appears.

---

## The run-defence gate

A 0–100 stability score over six components (DL and LB unit ratings, returning
front value, opponent-adjusted rushing success allowed, stuff rate, explosive
runs allowed), renormalised over whatever arrived, then moved by up to 22 points
by the opponent's own measured rushing threat. States: STRONG, STABLE,
QUESTIONABLE, FRAGILE, SEVERE MISMATCH.

**It is allowed to say UNKNOWN.** Below 45% of its own component contract it
refuses to publish a state at all. A gate that always answers is a gate that is
sometimes lying.

It is a research state that downgrades confidence *before* a game, never a
spread adjustment and never an excuse afterwards.

---

## The simulator

10,000 draws by default from a seeded mulberry32 — the same seed produces a
bit-identical distribution on every machine, forever, and the seed is printed on
screen. It does **not** invent a distribution: the margin is drawn from the
Power 4 engine's own spread-conditioned margin table, which already knows
college football's key numbers are not the NFL's and that there are no ties.
Only if that table is unavailable does it fall back to a rounded normal, and it
says which of the two it used.

The market enters in exactly one place — a cover probability counted over the
simulated margins — and is an input to nothing.

---

## The pipeline, and why it is materialised

```
RAW FEEDS -> NORMALISED PLAYER-SEASONS -> PLAYER RATINGS -> POSITION GROUPS
          -> TEAM UNITS -> SCHEME PROFILES -> (matchup + simulation at read time)
```

The research page recomputes none of it. A season of `player_stats` is 55 MB;
the browser reads committed artifacts instead:

* `current.json` (~600 KB) — the league-wide manifest, loaded on open
* `index.json` (~1.1 MB) — the searchable national index, loaded for the explorer
* `teams/<key>.json` (~90 KB each) — full per-player provenance, on demand
* `snapshots/<season>-wNN.json` — point-in-time

**Point-in-time is mandatory.** The current week's snapshot is refreshed as that
week's games land; an earlier week's snapshot is finished and is never touched
again. A backtest that re-reads one gets the numbers that existed then.

### Running it

```
node football/players/build_players.js --season 2026 --seasons 4
node football/players/players.test.js
node tools/football/player_quality_ui.test.js

# the walk-forward. Slow (it rebuilds the layer once per week of every season)
# and it is the only thing allowed to set points_applied.
node football/players/validate.js --first 2022 --last 2025 \
     --tune 2022,2023 --hold 2024,2025 --write-params
```

`.github/workflows/player-ratings.yml` runs the build weekly in season and
commits the artifacts. It does **not** run the validator: recalibrating on a
schedule is how a layer quietly starts fitting the recent past.

---

## No leakage, and no language model

**Leakage.** A game in season Y week W is predicted from player ratings rebuilt
out of plays in seasons `< Y` plus season Y weeks `< W`, and the rebuild is
real, not a filter over finished ratings. The career index is filtered to
strictly earlier seasons once, at the top of `ratePlayer`, and everything
downstream reads the filtered list. The roster feed's class column is never
read for experience — it carries a player's *eventual* class and would leak the
future (established in `cfb_p4/README.md`); experience comes from seasons
observed in the production feed instead.

**No LLM.** Nothing in this directory, in the build that feeds it, or in the
panel that renders it calls a language model. Every rating is arithmetic over
counted events and carries the counts. The "why this could stay close" lines are
templates filled with a measured number, each naming the measurement it came
from. AI may read them back to a user. AI may not produce them, and
`players.test.js` asserts that no file here contains a model call.

---

## Current limitations, in the order they hurt

1. **No recruiting feed.** The `recruiting` data-quality dimension is zero and
   drags the overall down on purpose. This is the single largest gap, and it
   bites exactly where the production feed is blind: true freshmen.
2. **No snap counts anywhere.** Role is touch share, and says so.
3. **Offensive linemen and most defensive backs cannot be rated individually.**
   Their units lean on team-level records that *are* observable.
4. **Availability is thin.** College football has no universal injury report;
   the availability dimension will never reach 1. Stale reports are discarded
   rather than counted, so the number is honest and low.
5. **The layer does not beat the rating core out of sample**, and therefore
   moves nothing. See the top of this file.

### The next data source to add, and why

**A licensed recruiting feed** (CollegeFootballData with a key the operator
holds, or any source EdgeDesk is licensed to use). It is the only addition that
would improve the ratings *the layer is currently worst at* — every true
freshman and every player with no attributed snaps, who today sit at positional
replacement with a confidence that says why. The seam is already built:
`recruiting_adapter.ingest()` normalises any source to a 0–100 score and a prior
z, and every rating downstream picks it up with the source named on the player.
Nothing else in the layer changes.

After that, in order: a snap-count or participation feed (which would turn touch
share into real role and lift every unit weighting), and any per-defender
charting (which would let the defensive half of the matrix stop leaning on
team-level records).
