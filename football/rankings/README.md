# The EdgeDesk national rankings pipeline

One deterministic backend rating system, rebuilt in GitHub Actions, committed
as artifacts, rendered by a browser that computes nothing.

```
cfbfastR schedules          who is FBS, who played whom, which games are FINAL
cfbfastR player_stats       every play, and every field goal WITH ITS DISTANCE
ESPN player box             punting, extra points, returns, touchbacks —
  (sportsdataverse)         per player per game, so per team per game, so the
                            opponent's row is this team's COVERAGE
        |
        v
  team-game aggregates  ->  opponent adjustment (a fixed point, per metric)
        |                          |
        |                          v
        |                   OFFENCE   DEFENCE   SPECIAL TEAMS   sub-units
        |                          |
        v                          v
  TALENT (player artifact)  +  PERFORMANCE  ->  ETSR  ->  confidence
                                                   |
                                                   v
                                RANKS (22 categories)  ->  weekly snapshot
                                                   |            |
                                                   v            v
                              current.json   history.json   health.json
                                                   |
                                                   v
                                         app.html reads them
```

Nothing in this path runs in a browser, calls an Edge Function, or asks a
language model anything. Every constant lives in `config.js` with a `basis`;
everything that had to be measured lives in the generated `params.js`.

## Running it

```
node football/data/build_box.js       --seasons 4 --cache .cache/football
node football/players/build_players.js            --cache .cache/football
node football/rankings/build_rankings.js          --cache .cache/football
node football/rankings/pipeline.test.js           # 139 checks
```

| command | what it does |
|---|---|
| `npm run cfb:refresh` | asks the cheap question: has a game gone FINAL since the board was built? Exit 0 = rebuild, exit 10 = nothing new. |
| `npm run cfb:rankings` | one build of the current week |
| `npm run cfb:backfill` | every completed week of the season, in order, so the weekly history exists |
| `npm run cfb:health` | prints the pipeline health report |
| `npm run cfb:test` | the whole football suite |

`--through-week N` rebuilds the board as it would have stood with only games up
to week ordinal N. `--rewrite-history` is required before it will touch a
snapshot for a week that is already finished.

## The automatic refresh

`.github/workflows/football-weekly-build.yml` runs three ways:

1. **Chasing the games.** Every two hours in season it runs `refresh.js`, which
   compares the DIGEST of the schedule feed's FINAL games against the digest
   the published board recorded. Same set of games and a recent build: it stops
   there, having spent one CSV. A game has gone final — or a result was
   corrected, which moves ratings exactly as a new game does — and the whole
   pipeline runs.
2. **The daily safety rebuild** at 09:40 UTC skips the check entirely, so a
   stuck feed shows up as a build that ran and found nothing rather than as a
   board nobody looked at.
3. **Manually**, with `workflow_dispatch`, including a full-season backfill.

The build is idempotent. Team-games are keyed on `(game_id, team)` at
ingestion and deduplicated again before aggregation; every artifact is written
through `writeIfChanged`; the weekly snapshot is addressed by
`(season, week ordinal)`; and `current.json` is content-addressed — a rebuild
that changed no number leaves it byte-identical. The one file that moves every
run is `health.json`, on purpose: it is the run record, and it is what the
page's "built" stamp reads.

## What was wrong, and what changed (performance_v1 → v2)

Thirty-one FBS teams that had played a real game came back with **no offence
and no defence rating at all**. The cause was a unit mismatch, compounded by a
deletion.

**The unit mismatch.** Every metric states `min_n`, the sample at which it is
worth full credit, in OBSERVATIONS — "150 plays". The scoring floor
(20% of `min_n`) was tested against `n`, the WEIGHT-DISCOUNTED denominator the
opponent-adjustment fixed point balances on: recency decay times the 0.45
non-FBS game weight. Those are different quantities. This file's own
`floor_basis` reasons about "seventy plays at the 0.45 game weight" clearing a
30-play floor; the code compared 150 plays against eleven plays' worth of
evidence and dropped every metric.

**The deletion.** v1 scored the competitive-only aggregate and binned garbage
time. A team that beat an FCS side 73-6 has 57 observed offensive plays and 25
competitive ones — so the discount landed twice on the same team, for the same
reason, and the second one deleted the rating.

v2 asks the two questions separately:

| | asked of | used for |
|---|---|---|
| `n_obs` | observations actually seen | the scoring floor |
| `n` | weighted evidence | the reliability shrink |

and scores garbage-time plays at `GARBAGE.scored_weight` (0.35) in both the
numerator and the denominator instead of dropping them. Nothing about `min_n`,
the weights, the shrink direction or the confidence model changed. Coverage in
2026 week 1 went from 110 to 135 teams with an offence rating and 118 to 135
with a defence rating, out of 137 that had played.

A rating exists when the evidence exists. Sample size is carried by
CONFIDENCE and by the shrink toward the league mean — never by a null.

## Special teams

Before this it was `units.K.rating`: the kicker room out of the player-talent
layer, which is a statement about a depth chart and cannot move when a team
misses three field goals. It is now a measured team unit, ranked nationally,
on the same 0-100 scale as every other unit, through the same opponent
adjustment and the same shrink.

| component | weight | source |
|---|---|---|
| field goals over expected, by distance | 0.26 | play table (`field_goal_attempt_stat` is the distance) |
| net punting (gross − returns − touchbacks) | 0.22 | box, both sides of the game |
| kickoff coverage (yards per return allowed) | 0.14 | the opponent's own box row |
| punt return average | 0.12 | box |
| kickoff return average | 0.11 | box |
| punts inside the 20 | 0.08 | box |
| extra points | 0.04 | box |
| field goals blocked against | 0.03 | play table |

**Place kicking is rated over expectation, not on percentage.** The expected
make rate per distance is fitted every build from this pipeline's own play
table — five-yard buckets, each shrunk toward its neighbours and toward the
league rate by a fixed pseudo-count so a thin bucket cannot return 0% or 100%.
No table is imported and none is hand-written. A made 52-yarder is worth more
than a made 22-yarder because the data says so.

**Coverage is a measured event, not a residual.** Both sides of a game are in
the box feed, so the yards the opponent gained returning my kickoffs are in the
opponent's own row. Net punting refuses to score at all when the opponent's row
is absent, because reading the missing return half as zero would hand the punt
unit a free average.

A team must score at least 34% of the weighted contract before it gets a
special-teams rating. Below that the unit is DECLARED MISSING with the reason
that team was given: unlike offence, whose eleven metrics all describe the same
thing, one punt-return average is not a special-teams rating and must not be
published under that name.

**Special teams is not an ETSR input.** It is the least repeatable phase of
football week to week, and folding it into a neutral-field team rating would
move the spread on variance that does not carry forward. It is measured,
ranked and shown; it does not move ETSR. If a walk-forward ever shows it does
carry, it enters through a weight in `config.js` and the flag flips.

**What no public keyless feed carries**, and therefore stays absent: kickoff
placement and hang time (so kickoff touchbacks cannot be separated from punting
ones), blocked punts as an attributed event, the snapper and the holder, and
which personnel were on the field for a kick.

## Which games are final

Two feeds, two publication schedules, and **the schedule is not always the
faster one**. SMU beat Florida State 27-24 on 7 September 2026. The next day
the cfbfastR schedule still carried the game as `completed=FALSE` with null
points and its play table had not one row for it, while the ESPN player box
already carried eighty rows across both teams. Reading the schedule as the
sole authority on "has this been played" put a team that had played a game on
the board as a team that had not.

A game the box carries for **both** sides was played. `reconcileFinality()`
takes that as finality, records `final_source: 'espn_player_box'`, and lists
every such game in `data_freshness.finality`. One side in the box is not a
game and is not read as one.

**No score is reconstructed from a box score.** The points stay null. They are
not a rating input, and inventing them would be exactly the fabrication this
pipeline refuses everywhere else.

Such a game produces a team-game with `play_evidence: false`: a real kicking
line and no scrimmage plays. So the team's counts are kept apart —

| | what it means |
|---|---|
| `sample.games_played` | games this team has played, on any feed's evidence |
| `sample.games` | games the play table has published |
| `sample.box_only_games` | the difference, and why |

— and only `games` prices the performance evidence, drives the ETSR ramp and
feeds the confidence. A box-only game therefore gives a team a special-teams
rating and an honest game count, and gives it **no** offence, defence or
sub-unit rating, because there are no plays to rate. `refresh.js` applies the
same rule, so a box-only final triggers a rebuild on the two-hourly pass
instead of waiting for the daily one.

Field goals are the one kicking component a box-only game cannot supply:
place kicking is rated over expectation **by distance** and the box carries no
distances. The attempts it did see ship as
`sample.special_teams.fg_attempts_in_box` beside the play table's count, so
"three attempts, two made, and we cannot tell you from where" is on the record
rather than a silent zero.

## Weekly history

`snapshots/{season}-w{ordinal}.json` is the record: every ranking category's
rating AND rank, per team, per week, with the rating version that produced
them. The week the board currently stands at is refreshed as its games land;
every earlier week is finished and the build refuses to rewrite it without
`--rewrite-history`. A history you are allowed to edit is not a history.

`history.json` is the read model: one series per team, oldest first, with the
per-category delta against the previous entry.

Δ week is differenced against the latest snapshot **strictly before** the
current ordinal — not against "the file with the previous number", because a
bye, a cancelled Saturday or a build that did not run leaves a gap, and the
comparison across it is still the honest one. The ordinal actually compared
against ships beside every delta, so a two-week move is never read as a
one-week move.

A snapshot written after the fact by `backfill.js` is marked
`reconstructed: true`: the talent half is read from the player artifact as it
stands today, which did not exist in the week being reconstructed. It is what
this board would say about that week, not a record of what it did say.

## The health report

`health.json`, written on every successful run, and rendered on the page:

```
2026 Week 1
 138 FBS teams          138 processed
 138 overall            138 talent            133 performance
 135 offense            135 defense           103 special teams
 131 run offense        128 pass offense      138 run defense    130 pass defense
  33 low confidence (below the 22% rank floor)
  39 teams with a genuinely unavailable category, listed by name with the reason each
 kicking feed density 73% of 2025 per team-game
 last game ingested 2026-09-06T23:30Z   last build 2026-09-08T13:57Z
```

`genuinely_unavailable` is a list, not a count: every team that holds no
rating in a category appears by name with the reason THAT TEAM was given, so
"why is Marshall blank" is a lookup rather than an investigation.

`special_teams_feed_density` compares this season's per-team-game kicking
volumes against the most recent completed season's. A season in progress
publishes in pieces — a game lands, then the punter's line lands — so a ratio
below one is the feed still filling in, not football that did not happen. It
moves no rating; it is why some teams have no special-teams number yet.
