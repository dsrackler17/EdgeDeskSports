# Starter context

Who is playing quarterback, what kind of answer that is, and what is still
unknown about it.

## The problem this replaced

`football/fbs/slate.json` — the artifact the AI, the newsletter, the exports
and the Collective sync all read — carried no quarterback at all, and the
engine's own data-quality warning fired on every game:

```
home starting QB unknown
away starting QB unknown
```

That was true of the request and false of the world. Every caller of the
college engine passed `qb: null`, and the comment above the null in
`app.html` explained why:

> qb stays null on purpose: college football publishes no depth chart
> EdgeDesk trusts, so naming a starter would be a guess dressed as an input.

The premise is right. The conclusion does not follow. There is no *announcement*
feed for college football, but who took the dropbacks in a team's last game is
published, play by play, with an athlete id on every one, in the same
`cfbfastR-data player_stats` file this repository already downloads for the
player layer. "LSU's last start went to Sam Leavitt, 35 of 38 dropbacks in week
2 against Louisiana Tech" is an observation with a source and a timestamp. It is
not an announcement, and this layer never calls it one.

## The six states, kept apart

| status | what it means | what can produce it |
|---|---|---|
| `ANNOUNCED` | an official team or conference source named the starter | tier 1 only |
| `EXPECTED` | current reporting supports one starter | reputable media (tier 2) |
| `DEPTH_CHART` | he leads the published depth chart | a published depth chart |
| `PREVIOUS_GAME` | he started the team's most recent completed game | play attribution |
| `COMPETITION` | the evidence does not settle on one player | two names at one tier, or a split usage picture |
| `UNKNOWN` | nothing observed at all | no usable evidence |

`confirmed` is true for `ANNOUNCED` and for nothing else, and no consumer may
promote it. `football/matchup/research.test.js` and
`football/starters/starters.test.js` both fail if that ever stops being true.

**Availability is a second axis.** A resolved starter who is DOUBTFUL is still
a resolved starter with a doubt attached. The two travel together and never
collapse into each other. An absent report is `UNKNOWN` with the reason on it —
*"the availability sources EdgeDesk reads were checked and carried no report on
this player — no report found is not the same as healthy"* — and the record
distinguishes "we looked and nothing was filed" from "we could not look".

**Participation is not a diagnosis.** A quarterback who opened a game and threw
a fifth of its dropbacks did not finish it. That is a fact about the box score
and it is reported as one, beside the availability state and never as it:

```
Kyler Murray — leads the published depth chart (did not finish week 1; no
injury report on file); no start has been announced.
```

## What each state is built from

| state | college | NFL |
|---|---|---|
| `PREVIOUS_GAME` | cfbfastR-data `player_stats` — completions, incompletions, sacks taken and interceptions thrown, each with an athlete id and a play id | nflverse `play_by_play` — `passer_player_id` on every dropback |
| `DEPTH_CHART` | ESPN's depth-chart endpoints, which currently refuse this repository; the refusal is recorded and the field falls through | nflverse `depth_charts`, timestamped and refreshed daily |
| `EXPECTED` | the availability collectors' media tier | the same |
| `ANNOUNCED` | an official source in `football/availability/sources.json`. **The registry currently carries no official availability URL for any programme**, so this state is reachable and presently empty for college. It is a registry entry away, not a code change — see `football/availability/README.md`. | NFL game-day inactives are the same shape and are not scraped here |

## Identity, and the three ways it goes wrong

1. **A transfer's old team.** An athlete id that this season's roster file puts
   on *another* team never resolves here. Alabama's week-2 opener came back
   attributed to a player the 2026 roster has at Kentucky; the guard refused
   him and the record says so rather than naming a Kentucky quarterback as
   Alabama's starter.
2. **Two players with one name.** A name-only source resolves only when the
   name is unique on the current season's roster. A duplicate resolves to
   nobody.
3. **A player no roster file carries.** This is *not* the same failure, and
   treating it as one lost real starters. The play feed attributed this
   season's snaps to him and no roster carries him anywhere; he resolves, and
   the record says `identity_corroborated: false` with the reason.

Season is part of the identity. Evidence stamped with another season is refused
outright — last season's starter is not this season's news.

## Experience

`experience.starts` is the number of games a player **opened**, counted from
the play feed across the seasons the build read (the current one plus
`--history N`, default 1). It is named for what it is: a measured start count
over a stated window, not a career total. It is the one thing the engine's QB
layer can actually act on, because:

* no feed this repository reads carries **EPA per dropback** for college
  football, so the QB layer's *value* term has no input and contributes no
  points; and
* the trained volatility model kept exactly one driver (`early_season`), so
  `qb_uncertainty` carries no coefficient and cannot widen or narrow the
  distribution either.

Both facts are published on every game as `shadow_effect.why`, so two identical
numbers never imply that the starter was weighed and dismissed.

## Nothing here prices anything

`football/matchup/inputs.js` holds one constant:

```js
const PRICED_STARTER_STATUSES = [];
```

`engineQbInput()` refuses to emit a priced input for a status that is not on
that list, and returns the reason instead. The published projection is built
from a request whose `qb` is `null`; a **shadow** projection carries the
starter and is published under `shadow_` names, graded on its own record and
read by nothing that prices. Flipping the constant is the single switch, and
`football/validation/` has to have something to show for it first.

## Running it

```
npm run cfb:starters            # both sports, current season
npm run cfb:starters:cfb        # college only
node football/starters/build_starters.js --season 2026 --history 2 --no-depth
node football/starters/starters.test.js
```

Artifacts: `cfb_<season>.json`, `nfl_<season>.json`, `current.json` (the index
and the retrieval report). The scheduled job is
`.github/workflows/starter-context.yml`.
