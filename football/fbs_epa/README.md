# FBS quarterback EPA

Expected points added, per dropback, for every FBS quarterback, from 2014 —
and an explicit, evidenced answer to the question that decides what may be
done with it.

## The correction this makes

Three files in this repository said the same thing:

> no feed this repository reads publishes EPA per dropback for college
> football

— `football/starters/README.md`, `football/players/config.js`, and the header
of `football/cfb_p4/research/fit_qb_quality.js`. It was true of the feed this
repository was reading. `sportsdataverse/cfbfastR-data`'s real-EPA play-by-play
does stop in a directory that no longer resolves, and the substitute
coefficient in `cfb_p4/research/qb_quality.json` was fitted against yards per
dropback and success rate precisely because of it.

The successor repository publishes the thing itself.
[`sportsdataverse/cfbfastR-cfb-data`](https://github.com/sportsdataverse/cfbfastR-cfb-data)
ships `adv_passing` — one row per passer per game, 2014 onwards — carrying
`EPA`, `EPA_per_Play`, `Att`, `Sck`, `Int`, `Yds` and an EPA-based success
rate. It is modelled expected points from a published model. It is not yards,
it is not ESPN's Total QBR, and it is not a language model's estimate.

**32,450 provider rows, 32,434 passer games once sixteen same-athlete splits
are merged, 679,182 reconciled dropbacks. Every FBS conference and every
independent, in the conference each programme actually held that season.**

## And the correction to the correction

Finding the data is not the same as being allowed to price from it. The
engine's college QB layer prices

```js
valPts = params.qb.points_per_epa_db * shrunk_epa_per_dropback   // 10.0868
```

and the obvious move — divide EPA by attempts plus sacks, watch it reproduce
the published rate, wire it in — passes one test out of four.

`epa_contract.js` records the audit. Four things had to match and two do not:

| | provider's series | the coefficient was fitted on | |
|---|---|---|---|
| denominator | attempts + sacks | attempts + sacks (`is_dropback` in `build_team_game.py`) | ✅ same |
| market information | none — the EP model reads seconds remaining, yards to goal, distance, the four down flags and the score difference, and nothing else | none | ✅ same |
| garbage time | **included** | **removed** before the QB table is aggregated | ❌ different |
| expected-points model | the published `cfb_model_artifacts` XGBoost EP model, v2026.09.09, trained on 2004–2025 | EdgeDesk's own reconstructed surface in `ep_surface.py` | ❌ different |

The scale gaps are measurable, not theoretical. The provider's league average
is **+0.061** EPA per dropback and the engine's replacement prior is **0.0**,
so shrinking this series toward that prior makes an average college
quarterback above replacement by construction. And the series drifts: **+0.030
in 2014, +0.077 in 2026**, so a career mean that starts in 2014 is not on the
same scale as one that starts in 2024.

A slope carries no meaning off the scale it was measured on. So:

```js
COMPATIBILITY.priced_input === false
```

is the single flag, everything else reads it, and the QB layer keeps
contributing exactly zero points to every college spread — as it did before
this directory existed. What changed is that the reason is now specific and
written down, and `COMPATIBILITY.what_would_settle_it` lists what would change
it.

Two of the four gaps also cut the other way, and the contract says so: the
provider's EP model is one artifact scored onto every season, so a 2014 play's
EPA was computed by a model that has seen 2015–2025 football. That is a
look-ahead in the metric's **definition**, not in any outcome, and it is why
historical results on this series are reported as exploratory.

## What is actually published

Two committed artifacts, both small enough for the browser, plus a corpus that
stays in the pipeline cache.

| file | what | size |
|---|---|---|
| `qb_epa_<season>.json` | every passer who matters this season: a frozen career aggregate through the last completed season, this season's game log with kickoffs, and a five-game tail from last season | ~800 KB |
| `teams.json` | ESPN team id ↔ EdgeDesk team key, with the division and conference each programme held **in each season** | ~160 KB |
| `career_through_<S-1>.json` | the frozen career spine — what every recent passer did before this season, so a weekly refresh needs one season of source files and not thirteen | ~1.1 MB |
| `index.json` | provenance, freshness, coverage, identity and the validation result | ~8 KB |
| `football/data/cache/fbs_epa/corpus/*.jsonl.gz` | the 2014-onwards research tables | ~6 MB, **gitignored** |

The browser never sees the corpus, and there is no SQLite database in the
repository at all.

### Why game logs instead of season totals

A pregame measurement must not contain the game it is describing. The cheapest
way to guarantee that is not to promise it — it is to ship **dated rows** and
cut them at the kickoff being asked about. `fbs_epa.js` does exactly that, and
`fbs_epa.test.js` asks the same question at a cutoff one millisecond either
side of a real game and checks the answer moves by exactly that game.

## Identity

The join is on **canonical ids all the way down**: the ESPN game id the slate
already carries, the ESPN athlete id the starter layer and the player layer
already carry, and the provider's own team-id-to-school pairs resolved through
`football/fbs/fbs.js`'s existing normaliser. Nothing here matches two display
strings from two different feeds.

The provider's own name resolution leaves rows on the floor, and those are
repaired against EdgeDesk's authoritative ESPN roster — **only** inside one
team in one season, **only** when the match is unique, and never by choosing
the better player when it is not.

```
532 passing rows this season
474 resolved
  0 ambiguous  (an ambiguous name stays unresolved — it is never guessed)
 58 unresolved (57 of them are FCS and lower-division programmes with no FBS
                roster in any file EdgeDesk holds; one is a team-charged row)
```

Sixteen rows across the corpus turned out to be **one passer written two
ways** inside a single game — "Cade Klubnik" on thirty-five attempts and
"C.Klubnik" on one. The upstream assembly groups on the normalised name, so
those never met. Once both rows carry the same athlete id they are one game,
and they are merged with every rate recomputed on its own denominator.

For the question the product actually asks — who is playing quarterback on
Saturday and what has he done — **135 of 138 FBS starters carry measured EPA
history.** The rest are true freshmen and transfers from outside FBS, and they
are reported with an empty sample and the reason, never with a league average.

## The four states that are not the same statement

| state | means |
|---|---|
| `STALE` | the artifact was not rebuilt; its age is published and the banner says so |
| `PARTIAL` | the provider has not published a passing row for a completed game yet. The card names the missing game |
| `UNRESOLVED_IDENTITY` | no athlete id resolves for this side. There is nobody to measure |
| `NO_OBSERVATIONS` | the athlete resolves and has thrown no FBS pass in this history |

A fetch failure never destroys an artifact: the previous one is kept, its age
is measured, and the run says loudly that it is what you are looking at.

## Identity evidence, and what it is allowed to claim

`fbs_epa.js` keeps five answers apart, because collapsing any two of them is
how an observation becomes a claim:

* **CONFIRMED_STARTER** — an official source named him. `ANNOUNCED` only.
* **PROJECTED_STARTER** — reporting or a depth chart points to him.
* **LAST_GAME_PROXY** — he took the first dropback of the last completed game.
* **DOMINANT_PASSER_PROXY** — he threw the most dropbacks in it. Nobody said he
  started it, and the leading passer is not always the one who opened.
* **UNRESOLVED** — the evidence does not settle on one player.

## Running it

```bash
node football/fbs_epa/build_epa.js --season 2026            # from the corpus
node football/fbs_epa/build_epa.js --season 2026 --refresh  # + the live season
node football/fbs_epa/build_epa.js --check                  # validate, write nothing
node football/fbs_epa/fbs_epa.test.js
```

`--refresh` fetches only the season in progress: `adv_passing`, `adv_team`,
`cfb_schedules` and `cfb_rosters` for one year, through the existing
`football/data/tools/parquet_to_csv.py` bridge. The career spine for earlier
seasons is frozen in the artifact, so a weekly run needs one season's files and
not thirteen. The scheduled job is `.github/workflows/starter-context.yml`,
which already owns the weekly quarterback refresh — no second scheduler was
added.

The builder refuses to write an artifact that fails its own validation, and
`index.json` carries every check it ran.

## The frozen career spine

A weekly refresh cannot clone thirteen years of passing rows, and the corpus is
gitignored on purpose. So the prior seasons are frozen once into
`career_through_<S-1>.json` — one row per athlete who has thrown in the last
three seasons, carrying his aggregate through the last completed season and a
five-game tail for the recent-form window. 1,432 athletes, ~1.1 MB.

A refresh then needs **one season of source files instead of thirteen**, and
365 of the 366 careers it rebuilds are identical to the ones the full corpus
produces. The one that differs is a quarterback whose last FBS pass was in
2022, outside the three-season window: he keeps a resolved identity and an
empty recent history rather than a wrong one.

The spine is rewritten **only** when a run genuinely read those seasons, so a
one-season refresh can never replace a complete spine with a worse one. The
team crosswalk is protected the same way: a run that read one season merges
into the committed file rather than narrowing it to that season.

## Is it worth points?

`football/cfb_p4/research/fit_qb_epa.js` asks, with the five leaks in the
previous experiment closed and each closure asserted rather than asserted-to-
have-been-done. Two arms, never pooled:

| arm | what it knows | pooled MAE | improvement | 95% CI | folds |
|---|---|---:|---:|---|---:|
| **pregame** | the leading passer of the last game that had **finished** — what a Saturday-morning price can have | 12.899 → 12.891 | **+0.008** pts/game | [−0.030, +0.048] | 5 of 7 |
| **participant** | the man who actually threw — an upper bound, never a forecast | 13.003 → 12.981 | +0.022 pts/game | [−0.020, +0.063] | 6 of 7 |

The pregame arm fails the predeclared rule on two conditions: the improvement
is a quarter of the 0.02-point bar, and its interval covers zero (p = 0.67).
`points_applied` stays **false**.

The participant arm is more interesting and still cannot price anything. It
reads the quarterback out of the game being predicted, so
`football/validation/promote.js` marks it leakage-failed and caps it at
RESEARCH_ONLY. Within it, the effect concentrates exactly where the team rating
is least informed — transfers (+0.21 pts/game, CI excludes zero) and
Power 4 games (+0.067, CI excludes zero) — and reverses outside FBS's top tier.

**The most useful finding is a structural one.** A transfer cannot *be* the
pregame candidate until he has already played a game for his new team: the rule
names the leading passer of the last completed game, and before that game he
has none. The pregame arm therefore sees no transfers at all, and that is
precisely the subgroup where the participant arm finds the largest effect.
Closing it needs a **timestamped pregame starter source**, not more history —
which is the specific additional evidence this work says is required.

## What reads this

* `football/matchup/inputs.js` — as research context on the engine's
  information layer. The engine's **priced** `qb` input stays `null`.
* `football/matchup/packet.js` — the canonical research packet.
* `app.html` — the game research card, and the same packet the AI is handed.
* `football/cfb_p4/research/fit_qb_epa.js` — the walk-forward experiment.

Nothing in that list can move a fair line. `football/validation/` holds the
predeclared rule that would have to pass first.
