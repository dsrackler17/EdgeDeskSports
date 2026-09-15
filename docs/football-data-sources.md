# EdgeDesk football data sources

Every feed the football system reads, what it actually carries, what it does
not, and what happens when it fails. Written so that months from now the
question "where does this number come from?" has one place to be answered.

**Standing rules.** No source is scraped in violation of its terms. No source
that requires a per-user key is committed as a dataset. No number is used that
is another organisation's model output. Where a feed is absent, the field stays
null and the confidence falls — nothing is substituted.

---

## 1. cfbfastR-data play attribution — `player_stats`

| | |
|---|---|
| **Source** | `sportsdataverse/cfbfastR-data`, ultimately ESPN |
| **URL** | `raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/player_stats/csv/player_stats_<season>.csv` |
| **Access** | public, keyless, no rate limit observed |
| **Data** | one row per play, naming the players credited with the events on it, with **down, distance and yards-to-goal on every row** |
| **Seasons** | 2014 → current, updated through the season |
| **Size** | ~55 MB a season, uncompressed CSV |
| **Cadence** | daily during the season |
| **Read by** | `football/players/build_players.js`, `football/rankings/performance.js` |

**Carries:** rushes, receptions, completions, incompletions, sacks taken, sacks
made, field goals, fumbles, targets, interceptions, pass break-ups, forced
fumbles — each tied to a game state.

**Does not carry:** next-score information (so **no EPA is computable** and none
is invented), snap counts, tackles, blocking, alignment, personnel, coverage.

**Known coverage collapses, measured every build.** Several attribution columns
are filled in for some seasons and not others. Counted per team-game:

| column | 2023 | 2024 | 2025 | 2026 | usable? |
|---|---|---|---|---|---|
| sacks | 0.92 | 0.90 | 0.83 | 1.13 | **fails 2023-2025** (reality ≈ 2.0) |
| interceptions | 0.24 | ok | ok | 0.51 | mixed |
| pass break-ups | 0.17 | 0.14 | 0.84 | 0.00 | **fails throughout** |
| forced fumbles | 0.07 | 0.06 | 0.05 | 0.08 | **fails throughout** |
| targets | 3.66 | 1.98 | ok | 7.62 | mixed |

A column that fails its floor is **declared missing league-wide** for that
season, never scored as if the events did not happen. This is why v1 of the
player layer had *zero* rateable defensive linemen in 2025: it depended on a
sack column that was dropping more than half its events, and the gate correctly
refused to score it.

**Failure behaviour:** a season that will not download is skipped; the build
continues on the seasons that answered and names the ones that did not.

---

## 2. sportsdataverse ESPN player box — `espn_cfb_player_box`

| | |
|---|---|
| **Source** | `sportsdataverse/sportsdataverse-data` release assets, ultimately ESPN |
| **URL** | `github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_cfb_player_box/player_box_<season>.csv.gz` (`.parquet` for the season in progress) |
| **Access** | public, keyless |
| **Data** | one row per player per game per stat category |
| **Seasons** | 2019 → current |
| **Size** | ~1.5 MB gzipped a season |
| **Read by** | `football/data/build_box.js` |

**This feed forced a correction.** `football/players/config.js` previously
asserted that tackles, tackles for loss, pressures short of a sack and punting
were "not observed at all in any public feed". They are all in here, keyed on
the same ESPN `athlete_id` the repository already joins on. That contract has
been corrected rather than left standing.

**Carries:** `totalTackles`, `soloTackles`, `tacklesForLoss`, `sacks`,
`passesDefended`, `hurries`, `interceptions`, punting (`punts`, `puntYards`,
`puntsInside20`, `touchbacks`, `longPunt`), field goals, returns, `adjQBR`, and
— importantly — an **appearance** per player per game.

**Coverage, measured per team-game against real FBS rates:**

| season | tackles | TFL | sacks | PBU | hurries | punts | verdict |
|---|---|---|---|---|---|---|---|
| 2019 | 1.71 | 0.16 | 0.05 | 0.08 | 0.05 | 4.76 | defence unusable |
| 2022 | 5.17 | 0.50 | 0.20 | 0.29 | 0.18 | 4.51 | defence unusable |
| 2023 | 33.76 | 2.89 | 1.10 | 1.69 | 1.35 | 4.35 | **partial — fails** |
| 2024 | 62.39 | 5.30 | 1.94 | 2.98 | 2.43 | 4.16 | **usable** |
| 2025 | 64.69 | 5.32 | 1.95 | 3.13 | 2.71 | 4.14 | **usable** |
| 2026 | 63.13 | 4.92 | 1.71 | 2.79 | 2.47 | 4.79 | **usable** |

So the defensive columns are usable **from 2024**, and punting has been usable
throughout. Gated on every run; the counts ship inside the artifact.

**Deliberately not used:** `adjQBR`. It is ESPN's model output, and this
repository does not build its ratings on another organisation's rating. It is
ingested and shown as context only.

**Still not carried by it:** missed tackles, snap counts, any offensive-line
attribution, and a *run stop* (which needs a tackle joined to down and distance;
tackles for loss are ingested as the nearest observable relative and are not
renamed).

**Failure behaviour:** the CSV is tried first; the parquet is tried second via
`football/data/tools/parquet_to_csv.py` (pyarrow); if both fail the season is
absent, every box measure is declared missing, and **EPIR v1 is bit-identical to
what it was before this feed existed**.

---

## 3. cfbfastR-data schedules

| | |
|---|---|
| **URL** | `.../schedules/csv/cfb_schedules_<season>.csv` |
| **Access** | public, keyless |
| **Data** | results, `season_type` (regular/postseason), week, division, conference, neutral site |
| **Seasons** | 2001 → current |
| **Read by** | every football builder |

The spine: FBS membership, which games count, and **week resolution**. The
postseason restarts its own week numbering, so everything downstream orders on
an ordinal (`regular w → w`, `postseason w → 20 + w`) rather than a calendar
week.

---

## 4. cfbfastR-data rosters

| | |
|---|---|
| **URL** | `.../rosters/csv/cfb_rosters_<season>.csv` |
| **Access** | public, keyless |
| **Data** | `athlete_id`, name, team, position, height, weight, jersey |
| **Read by** | `football/players/build_players.js` |

The identity backbone. **Positions are inconsistently granular**: 123 of 138
programmes spell their edge rushers `DL` rather than `EDGE`, and 51 spell their
secondary `DB` rather than `CB`/`S`. Where EdgeDesk's own ESPN roster sync
carries a more specific spelling for the same athlete id, it wins. A unit a
roster does not spell is reported as *covered by* the coarser one, never as
missing.

**Fallback:** `football/rosters/fbs_<season>_espn.json`, EdgeDesk's own weekly
sync, when cfbfastR has not published a season.

---

## 5. cfbfastR-data closing-line archive

| | |
|---|---|
| **URL** | `.../betting/csv/cfb_line_odds.csv.gz` |
| **Access** | public, keyless |
| **Data** | 1.18M rows, 2006-2025, spread/total/moneyline, opening and closing, multiple books |
| **Read by** | `football/players/validate.js`, `football/validation/validate_features.js`, `football/rankings/build_rankings.js` |

**A benchmark and a display column. Never an input to any model number.**

Two documented traps, both handled: about 15.6% of rows are exact duplicates and
are dropped before any consensus median; and a spread is stated from one team's
side and identified only by an abbreviation, so the home side is resolved
through the teams file and an unresolvable row is **dropped, never guessed**.

Coverage of recent seasons is partial (227 of 808 FBS-vs-FBS games in the 2025
holdout), so the market column is present for some teams and absent for others,
and says which.

---

## 6. EdgeDesk's own datasets

| dataset | built by | read by |
|---|---|---|
| `football/rosters/` | `.github/workflows/roster-sync.yml` (ESPN) | player layer, Power 4 talent layer |
| `football/availability/current.json` | `.github/workflows/availability-sync.yml` | player units, talent, confidence |
| `football/rating/current.json` | `.github/workflows/rating-sync.yml` | research context |
| `football/data/box/` | `npm run cfb:box` | player layer v2 |
| `football/players/` | `npm run cfb:players` | rankings, research page |
| `football/rankings/` | `npm run cfb:rankings` | research page |
| `football/starters/` | `.github/workflows/starter-context.yml` | the published card, the research packet, the AI |
| `football/matchup/profiles_<season>.json` | the same workflow | the research packet |
| `football/fbs/slate.json` | the same workflow | the AI, the newsletter, every export |

**Availability** deserves a note: college football has no universal injury
report. EdgeDesk builds its own from ranked public evidence, and the honest
state today is that **no live record reaches the player layer** — every stale
report is discarded rather than counted, so the availability dimension reads
near zero and says why. UNKNOWN is never read as healthy.

### The two feeds that answer "who is playing quarterback"

Added because the previous answer was "nobody knows", on 77 games at once, for
a question the feeds already answer.

| | |
|---|---|
| **Source** | `cfbfastR-data player_stats` (already downloaded above) |
| **Carries** | `completion_player_id`, `incompletion_player_id`, `sack_taken_player_id`, `interception_thrown_player_id` and a `play_id` on every row — so the player who took a team's FIRST dropback of a game is read, not inferred |
| **Produces** | the `PREVIOUS_GAME` starter state, the dropback split that makes a `COMPETITION`, and the **start count** (`experience.starts`) over the seasons the build reads |
| **Does not carry** | an announcement, a depth chart, or EPA. None of those are inferred from it. |

| | |
|---|---|
| **Source** | nflverse-data release assets — `play_by_play_<season>.csv`, `depth_charts_<season>.csv`, `roster_<season>.csv`, `injuries_<season>.csv` |
| **Access** | public, keyless |
| **Produces** | the NFL's `DEPTH_CHART` state (timestamped, refreshed daily — the file carries every snapshot of the season, so "latest" is read rather than assumed to be the last line), `PREVIOUS_GAME` from `passer_player_id`, and the league injury report as the availability axis |
| **Size note** | the depth-chart file is ~50 MB because it is every snapshot of the season. It is a daily background job, never an interactive request; `--no-depth` builds everything else and says the field was skipped. |

**What still has no feed.** There is no keyless source for an *announced*
college starter. `football/availability/sources.json` is the registry where an
official school or conference availability page is added per programme, and it
currently carries **zero** official URLs — so the `ANNOUNCED` state is reachable
and presently empty, which the artifacts say rather than implying an
announcement does not exist.

---

## 7. Weather — open-meteo

| | |
|---|---|
| **Source** | `api.open-meteo.com/v1/forecast`, keyless |
| **Joined on** | the venue coordinates in the trained parameter table (135 of 138 FBS venues) |
| **Read by** | `app.html` `fbP4Weather` (the board, already) and `football/matchup/weather.js` (the headless build, new) |

The offline builder used to pass `weather: null` and then report the weather
layer blind on every game, including the 73 whose coordinates it was holding at
the time. It now makes the same request the board makes, bounded by
`football/data/recovery.js`, and the contract distinguishes three sentences that
had been collapsed into one: *nobody asked*, *somebody asked and was refused*,
and *there is nothing to ask about* (a dome, or a venue with no coordinates).

**The venue gap is two games, not a class of games.** `missouristate` and
`sacramentostate` moved up to FBS after the parameter table was trained, so they
carry no coordinates and no forecast can be located for them.
`football/venues/supplement.json` is the injection point; it refuses an entry
without a real latitude, a real longitude and a named source, so nothing can
quietly substitute a plausible-looking point.

---

## Sources checked and NOT used

| source | why not |
|---|---|
| **CollegeFootballData API** | requires a per-user API key, and its terms do not permit redistributing the data as a committed dataset. A licence holder can supply recruiting through `football/players/recruiting_adapter.js`; nothing is wired in. |
| **Recruiting services (industry composites)** | subscription, and scraping them would violate their terms. |
| **cfbfastR-data recruiting paths** | every candidate path returns 404. There is no public recruiting file in this mirror. |
| **cfbfastR play-by-play with real EPA** | only published through 2022, in a directory that no longer resolves for recent seasons. The EP surface this repository once fitted is therefore not reproducible, and **no EPA is invented in its place**. |
| **Coordinator / coaching history** | no public, keyless feed carries it. The input is contracted for in `config.js` and stays absent. |
| **Snap counts** | do not exist publicly for college football at any price this project can reach. |
| **ESPN depth charts and participation (college)** | every documented candidate path is tried in order and all of them refuse this repository (HTTP 404 / 403 on all 138 programmes — one cause, not 276 misfortunes). `football/data/recovery.js` cuts the host after three consecutive refusals and records the refusal as systematic, so the `DEPTH_CHART` state falls through for college rather than being faked. |

---

## Recruiting: the standing gap

This is the largest genuine hole in the system and it is reported as one. The
`recruiting` data-quality dimension sits at **zero** and drags the overall score
down on purpose.

`football/players/recruiting_adapter.js` is built and tested. It normalises any
source to a 0-100 score and a prior z, and every rating downstream picks it up
with the source named on the player. Wiring in a licensed feed changes exactly
one thing: the shrinkage prior for players the production feed cannot see —
true freshmen, and anyone with no attributed snaps. Nothing else in the layer
changes, because the shrinkage guarantees the prior's weight falls toward zero
as college evidence accumulates.

---

## Failure behaviour, in one place

| failure | what happens |
|---|---|
| a season's play table will not download | that season is skipped and named; other seasons build |
| a box-score season will not download | box measures declared missing; **v1 unaffected** |
| a feed column collapses | the gate fails, the measure is declared missing league-wide, nothing is scored as zero |
| the line archive will not load | the market column is absent and says why; no model number changes |
| the roster feed is unpublished | EdgeDesk's own ESPN sync is used; if that is also missing, continuity is unknown, never zero |
| a team has no prior season | the prior term rests on talent alone and a gate fires |
| severe anomalies are found | **the rankings build refuses to publish** and exits non-zero |

---

## Data confidence: what it measures, and what it used to

The research card publishes two numbers and they answer different questions.
Getting them right took two passes, and the second one found that the first had
been measuring the wrong thing entirely.

**Data confidence** is `scores.confidence` — the engine's weighted answer to
"how good is my information?", over twelve measurements whose trained weights
sum to 4.083. **Priced confidence** is `scores.confidence_priced`: the same
table over the measurements the published spread actually uses. Both ship on
every game, because either one alone misleads. The gap between them is the
share of what EdgeDesk knows that the number deliberately does not price, and
it is meant to be visible rather than hidden behind whichever figure is
flattering.

### The category error

`uncertainty.confidence` states its own contract in a comment above itself: it
answers "how good is my information?", explicitly not "how wide is the
outcome?" and explicitly not "what does the model price?". Its call site was
handing it **priced** measurements for five of its twelve inputs — the QB
points gap, the injury points gap, the schedule points gap, the travel points
and the weather total.

A priced measurement is missing whenever the *layer* is unpriced. That is a
statement about the model's coefficients, not about what EdgeDesk retrieved. So:

| input | weight | what it scored | what EdgeDesk actually had |
|---|---|---|---|
| **qb** | 1.0 — the heaviest, equal to the rating itself | **0 on every game in the universe** | the starter resolved for 96% of the field by athlete id, corroborated against the current roster, with his measured dropbacks and start count |
| injuries | 0.35 | 0 | a measured observation of the quarterback — the only position the trained injury layer prices |
| schedule | 0.283 | 0.4, a coefficient's strength | rest, road sequence and opponent identity, known exactly off the schedule feed |
| weather | 0.1 | 0 | the forecast, present or a dome |
| travel | 0.1 | 0 | two stadium coordinates and one haversine |

A term that takes the same value on all 76 games of a slate carries no
information about any of them. The `qb` term subtracted a flat 24.5 points from
every game and could not tell a resolved veteran starter from an unknown one.

### The calibration

The replacement is not a set of numbers somebody picked. College football
publishes no depth chart this repository can read, so for essentially the whole
field the best evidence is `PREVIOUS_GAME` — he opened the last one. How well
that predicts the next one is an empirical question, and
`football/starters/calibrate_persistence.js` measures it over four seasons of
play attribution, writing `football/starters/persistence.json`:

| opener's share of last game's dropbacks | opens the next game | pairs |
|---|---|---|
| 85%+ | **87.0%** | 7,511 |
| 65–85% | **76.7%** | 1,600 |
| 40–65% | **50.9%** | 743 |
| under 40% | **12.1%** | 989 |
| all | 76.1% | 10,843 |

That is the confidence the engine uses, and it discriminates in a way a chosen
constant could not have: an opener who immediately handed the ball over tells
you almost nothing about next week, and the old term scored him identically to
a dominant returning starter. A band with fewer than 200 observed pairs
publishes `rate: null`, and the engine then declares the starter's reliability
**unmeasured** rather than substituting a constant.

### Availability, scoped to what is actually priced

`params.injury.position_weight` carries **one** position — QB at 3.902,
measured over 2,846 games — and `params.unavailable_by_design` says why: "only
the quarterback's absence is observable in public data; every other position
ships untrained." An absence anywhere else moves no point of the projection
however well it were reported.

The quarterback *is* observed, from EdgeDesk's own play attribution, and the
persistence rates above already count the relevant events — a quarterback who
is hurt does not open the next game. So the availability term is the measured
quarterback observation, and it says so in its own basis string.

It does **not** claim EdgeDesk knows who else is hurt. It does not, because
nobody publishes it and the two endpoints carrying proxies refuse this
repository. That gap is real and is carried where it belongs: the volatility
layer prices an unreported injury situation as maximum injury uncertainty and
widens sigma on every one of these games. Confidence and volatility answer
different questions, and this is the case the distinction exists for.

### Where it lands

On the week 3 2026 slate, with the projection **byte-identical** on all 76
games — spread, total, win probability, sigma, every contribution:

| | n | mean | median |
|---|---|---|---|
| conference games | 14 | **81.8** | 83.6 |
| non-conference FBS | 44 | **79.9** | 83.2 |
| FBS vs FCS | 18 | 46.0 | 50.1 |

Board median 82.5. Miami (OH) @ Cincinnati, the game this work started from,
went from 41% to **83%**.

**The FCS games are supposed to be low.** Those opponents are outside the rated
universe: no roster bundle, no starter record, no player ratings, and a single
shared floor rating rather than a trained seed. A first attempt at the rating
term credited that shared floor as if it were knowledge of the specific
opponent, which scored an FBS-vs-FCS game *above* a conference game; the fix is
tested (`football/cfb_p4/information.test.js`).

### What is still dark, and what it would take

| input | cost | what would change it |
|---|---|---|
| off-field / NIL, both sides | 2.4 | no public feed exists for anyone; `params.unavailable_by_design` |
| roster talent | ~6 | rises through the season as the play feed attributes production to more of each roster — 1,746 of 15,542 rated players had attributed production at week 3. This is the genuine "more games" item |
| rating, matchup | ~7 early | scale with games played; the trained prior now carries its share, so this falls faster than it used to |

**Priced confidence is the real remaining headroom**: 39% board-wide against 72%
information. The largest single unpriced layer is the QB value term, and
closing it means either a licensed EPA-per-dropback feed or fitting a
points-per-quality coefficient on the same tune window the rest of the model
used, with its own walk-forward record and `points_applied` decided by that
record rather than by whoever writes the patch. Until then the starter informs
the confidence score and prices nothing — `PRICED_STARTER_STATUSES` is still
empty.


---

## What is a quarterback worth? — measured, and the answer is "not enough to price"

The engine's QB layer prices **EPA per dropback**, and no feed this repository
reads publishes it for college football. So the term has contributed **zero to
every college spread EdgeDesk has ever produced**. The obvious move is to
measure a substitute from what the play feed does carry and fit a coefficient
the same way `params.qb.points_per_epa_db` was fitted. That is
`football/cfb_p4/research/fit_qb_quality.js`, and this is what it found.

### Method

Replay the rating state season by season in kickoff order. **Before** absorbing
each game, take the model's own baseline — rating gap plus league home-field
advantage — and record the residual. Identify each side's opening quarterback
the way the starter layer does (first dropback), score him from his dropbacks
in games **already processed and nothing else**, shrink toward the league mean
by the engine's own `n/(n+100)`, and difference the two sides. Then fit the
slope, and walk it forward: train on every season before Y, score Y.

FBS-vs-FBS only — an FCS opponent sits at a shared floor rating, so its residual
is dominated by the floor rather than by its quarterback.

Three features were tried, plus their combination:

- **ypd** — career-to-date net yards per dropback (sacks negative)
- **sr** — dropback success rate on the conventional down thresholds
- **delta** — the change from the *incumbent*, on the theory that the rating
  already contains whoever has been taking the snaps, so only a **change** of
  quarterback is news to it

### Result: 5121 tune-window games, 7 walk-forward folds

| fold season | trained on | scored | baseline MAE | with the adjustment |
|---|---|---|---|---|
| 2020 | 733 | 485 | 13.6891 | 13.5728 |
| 2021 | 1218 | 703 | 13.1051 | 13.1617 |
| 2022 | 1921 | 718 | 12.911 | 12.9217 |
| 2023 | 2639 | 785 | 13.0519 | 13.0157 |
| 2024 | 3424 | 794 | 12.9836 | 13.0094 |
| 2025 | 4218 | 804 | 12.6895 | 12.5559 |
| 2026 | 5022 | 99 | 15.6354 | 15.6609 |

| feature | coefficient | held-out MAE change | folds improved |
|---|---|---|---|
| **ypd** | 1.584 pts per unit | **-0.0277** | **3 of 7** |
| sr | 32.5358 | -0.0039 | 2 of 7 |
| delta | -0.2404 | 0.0009 | 3 of 7 |
| combined | — | -0.0126 | 3 of 7 |

`ypd` is the best of them. Its implied adjustment is football-sized — about
**±1.9 points** at the 10th and 90th percentiles — so this is not a case of an
effect too small to matter in principle. It is a case of an effect that **does
not hold up**: three folds better, four worse, alternating, netting 0.028
points a game against a baseline error of 13.

**`points_applied` is false.** The QB layer contributes zero to the spread,
exactly as it did before this job existed — the same outcome
`params.travel.points_applied` records for travel ("every specification raised
held-out MAE"). The decision rule — lower held-out MAE **and** a majority of
folds improved — was written into the job before any result came back, and the
test re-derives it from the folds so the rule and the artifact cannot drift
apart to suit an answer.

### The interesting negative

`delta` is the one worth dwelling on. **1,901 of the games had a genuine change
of starting quarterback**, and the fitted coefficient was **-0.2404** — indistinguishable
from zero, and the wrong sign. Changing quarterbacks does not move the rating
residual in a predictable direction.

Taken with `ypd`'s coin-flip record, the finding is that at the level of an
FBS team rating, **who plays quarterback carries almost no incremental
predictive signal over the team rating itself**. The rating has already
absorbed it. That is a real answer to a real question, and it is worth more
than a coefficient that looked plausible in-sample.

### What would change it

The switch is wired and tested in both directions, so none of this needs new
code to turn on:

- a **licensed EPA-per-dropback feed** — the trained coefficient
  (`points_per_epa_db: 10.0868`) is already in the parameters and would take
  over the moment the input exists;
- **opponent adjustment** on the quality metric, which this fit does not do —
  a passer's raw yards per dropback carries his offensive line and his
  receivers as much as himself;
- **more seasons**, though seven folds saying the same thing is not a sample
  problem.

Re-run `fit_qb_quality.js`; if the walk-forward turns positive the artifact
flips `points_applied` and the engine prices it. Nothing else has to change.
