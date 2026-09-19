# EdgeDesk Tennis Lab

*Player strength, surface fit, form and matchup research across ATP and WTA.*

**Research, not picks.** Nothing in the Lab publishes a selection, a stake, or a
claim that a match is settled before it is played.

---

## What it is, and the one constraint that shapes it

The Tennis Lab is a player-intelligence and matchup-research product built over
the ATP/WTA historical record. It answers the questions a person actually opens
a research tool to ask — how good is this player, how good on *this* surface, is
the recent run real, how does the matchup look, what does the model not know.

**It requires no sportsbook.** Not as a fallback, not as an optional
enrichment. Every panel answers from the record and the ratings derived from it.
There is no odds read in `lib/tennis_lab.js`, none in the Lab's block of
`app.html`, and none in any of its database functions. A Market Comparison tab
exists, is prepared, and is **off** — see [The market gate](#the-market-gate).

That constraint is not a limitation being worked around; it is the design. A
research product whose core value evaporates when no book has priced a match is
not a research product.

---

## The layers

| | what | where |
|---|---|---|
| engine | the research questions, as pure functions | `lib/tennis_lab.js` |
| model | keys, features, the fitted model, the rating scale | `lib/tennis_model.js` |
| schema | tables, RPCs, RLS | `supabase/tennis_lab.sql` over `supabase/tennis_record.sql` |
| builders | history, derived signals, the brief | `tools/tennis/build_{history,lab,brief}.js` |
| surface | ten views | the Tennis Lab block in `app.html` |
| assistant | eight Lab intents | `supabase/functions/edgedesk_ai/_tennis.js` |

`tennis_lab.sql` is **additive** over `tennis_record.sql`: three new tables, a
set of new nullable columns on `player_ratings_current`, and the read functions.
It alters no existing semantics, and it refuses to apply at all if the record
contract is not underneath it.

---

## The rules the product rests on

These are enforced as code and checked as arithmetic, not asserted in comments.
`tools/tennis/lab.test.js` mutation-tests each one: breaking it fails the suite.

### A missing value is never a zero

An absent input stays absent through translation, trajectory, workload,
projection and the comparison card. `serve_strength = null` means *the archive
carried no serve statistics*; `serve_strength = 0` would mean *this player never
lands a first serve*. They are different facts and they stay different, all the
way to the card, where the gap is named.

In the projection, a missing **difference** enters the model as zero — which for
a difference model is the correct encoding of "no evidence either way". That is
not the silent-zero mistake, which would be imputing zero into a *level*. Every
such feature is listed in `missing` and printed on the card.

### A streak is not evidence on its own

Form is never read without the strength of the schedule that produced it. A
30-day surge against a field 60 Elo weaker than usual is classified
`above_sustainable` — *the wins are real, the improvement may not be* — and not
`improving`. The converse, `below_ability`, exists for a slump against a harder
draw.

This is the single rule that separates this from a momentum chart.

### Uncertainty is published, and it never closes

Every rating carries its sample. Every projection carries a band. The band is
floored at the model's own measured error (`MODEL_FLOOR_BAND`), because perfect
data about two players does not make tennis deterministic — the model scores a
log loss near 0.60 and picks the winner about two-thirds of the time. **No card
in the Lab can render a 0% uncertainty or a zero band.**

Where the stored rating uncertainty does reach zero — it is `1 − min(n/40, 1)`,
so it does at forty matches — that is reported as *"sample is no longer the
limiting factor"*, not as certainty. The sample has stopped being the binding
constraint; the Elo model, the K factor and the draw have not stopped being
estimates.

### Workload is a calendar, never a body

EdgeDesk holds no medical information about any player. The workload classes are
`Fresh / Normal / Elevated / Heavy / Unknown`, from documented thresholds, and
the classifier states in its own output that it is not an injury or fitness
report. The labels are deliberately about the schedule ("Heavy") and not about
the person ("Tired", "At risk").

`Unknown` is a real answer and is given as one. A player with no schedule data
is not quietly called Normal, and an inactive player is not called Fresh.

### Shrinkage, everywhere a sample is thin

A surface adjustment is `(surface_elo − baseline_elo)` shrunk toward zero in
proportion to the surface sample, so six clay matches cannot make a specialist.
The **raw** figure is published beside the shrunk one, so nothing is hidden: the
reader sees what the record says and what EdgeDesk is willing to claim from it,
and the gap between them is the sample.

### One engine

The matchup projection calls `lib/tennis_model.js` `featureVector` / `predict`
rather than re-deriving the differences. That scaling is not cosmetic — `d_elo`
is divided by 100, rest is capped at fourteen days before differencing, surface
experience carries a 30-match prior, and `elo_x_bo5` is an interaction — so a
second implementation would drift from the coefficients it was fitted on, and
the studio would quietly disagree with the model's own evaluation.
`lab.test.js` fails if the two files ever disagree on the feature set.

---

## The power rating

A documented 0–100 scale. One definition, quoted by the page, the AI and the
database (`tennis.power_rating_scale()`); `lab.test.js` fails if they drift.

> 50 is the median rated player on this tour on the day the rating was built.
> Ten points is about one standard deviation of tour Elo. A player with a thin
> record is shrunk toward 50 in proportion to what is missing, so the number
> always carries its sample and its uncertainty beside it. It is a description
> of the record on file, not a forecast of a match.

| band | label |
|---|---|
| 75+ | Elite |
| 65–75 | Strong |
| 55–65 | Above tour |
| 45–55 | Tour level |
| 35–45 | Below tour |
| < 35 | Developing |

**It clamps at both ends, and a clamp is not an achievement.** On a sixty-year
record several all-time players reach 100 and a long tail sits at 0. Where that
happens the rating has stopped discriminating, so:

- leaderboards break the tie on **Elo**, which does not clamp, and show it;
- the ranking-disagreement board **excludes** clamped players entirely, because
  a saturated rating is no longer measuring a disagreement;
- the AI is instructed to say so and quote the Elo instead.

Both of those were defects found by running the Lab against a real 361k-match
record, not by reading it.

---

## The ten views

| view | answers |
|---|---|
| Overview | leaders, risers, fallers, surface specialists, form, most active, fatigue watch, ranking-vs-model disagreement |
| Power ratings | the full table in any of nine modes, every row with its sample and uncertainty |
| Matchup studio | A vs B on a surface, at a format, optionally at a historical cutoff |
| Surface translator | how much a surface suits a player relative to their own baseline |
| Form & trajectory | improving / declining / stable / returning / above-sustainable / below-ability |
| Schedule & fatigue | workload classes from documented calendar rules |
| Historical explorer | the whole record, server-filtered and keyset-paginated |
| Compare | two players side by side on the dimensions that decide matches |
| Player | one player in full: career, recent, surface, serve, workload, rating line, splits |
| Market comparison | **off**, and says why |

### The nine ranking modes

`Overall · Hard · Clay · Grass · Indoor · Recent form · Serve · Return ·
Workload`. Declared once in `LAB_MODES` so the page, the AI and the SQL cannot
drift into three definitions of "best recent form".

---

## The matchup studio

The centrepiece, and the place where publishing false precision would be
easiest. Three rules it obeys without exception:

1. The probability never appears without its uncertainty, its band, and the
   list of model inputs that were **missing** from it.
2. When the band crosses even money the card says, in words, that the matchup
   does not lean reliably either way.
3. The vocabulary is *EdgeDesk projects*, *the model estimates*, *the matchup
   leans*. Never a pick, a lock, or a winner.

It also always argues the other side: `path` states what would have to be true
for the underdog, from the drivers that run against the favourite.

Below 25% of the model's weight having data behind it, it **declines** rather
than guessing — a probability built on that little is a guess wearing a decimal
point.

### The historical cutoff

Set a date and both players' inputs come from the last point-in-time feature row
**strictly before** it. Nothing at or after the cutoff can reach the answer,
including the result of the match being checked.

The honest limitation, stated rather than hidden: that snapshot is the state
entering the player's last match before the cutoff, so it excludes that one
match's own result. It is therefore very slightly **stale** rather than leaky —
the only direction it is safe for a research tool to err. The SQL suite proves
it by planting a match after the cutoff and showing it cannot be seen.

---

## The market gate

`tennis.lab_market_available()` answers **no** unless all three of these hold:

1. the `market_comparison` flag is on, **and**
2. a commercially cleared provider is registered, **and**
3. that provider has delivered a snapshot in the last six hours.

The three are asked as **one question** — *has a cleared source recently
delivered* — as a join, not as separate conditions. An earlier version asked
them separately and the SQL suite caught what that misses: the record contract
*seeds* `odds_api` as cleared, so the provider half was already satisfied on a
fresh install by a row that has never delivered anything, and the gate would
have opened on the first snapshot from any source.

The tab shows the database's own answer. There is no mock, no sample price, and
no "coming soon" illustration of numbers that do not exist.

**The historical archive is CC BY-NC-SA — non-commercial research.** It cannot
be used as a price feed, and the licence gate refuses any row that claims
commercial clearance without a named clearer.

---

## Performance

Measured with `EXPLAIN (ANALYZE, BUFFERS)` against **361,575 matches / 723,150
feature rows / 4,044 players** on PostgreSQL 16.

| read | measured | target |
|---|---:|---:|
| dashboard leaders | 13.7 ms | 500 |
| surface board | 14.5 ms | 500 |
| movers | 9.9 ms | 500 |
| rank-gap board | 11.7 ms | 500 |
| player card | 5.5 ms | 300 |
| player history | 1.5 ms | 300 |
| player splits | 17.1 ms | 300 |
| matchup inputs | 9.2 ms | 500 |
| head to head | 4.9 ms | 500 |
| historical explorer (page of 50) | 72.5 ms | paginated |
| explorer summary | 52.8 ms | — |
| lab health | 55 ms | — |

`lab_health` was **171 ms** and is loaded on every render. Two causes, both
found by profiling its components: `min(season)` and `max(season)` each cost a
sequential scan of 361,575 rows because the existing season index leads with
`tour`, and `lab_market_available()` was being called twice for two fields of
one answer. A plain btree on `season` and a lateral join fixed both. Output
verified identical.

**The explorer is keyset-paginated, never offset.** An offset re-scans and
re-sorts everything it skips, so page 400 of a 361k-row result costs 400 times
page 1; a keyset cursor costs the same for every page and cannot skip or
duplicate a row when the table grows under a paging reader. Proven: three pages
of 20 return 60 rows and 60 distinct ids.

**Nothing is loaded into browser memory in bulk.** Every read is an RPC that
caps its own limit, because a PostgREST table read can be handed `?limit=100000`
by anyone and a function cannot. The heaviest thing the page ever holds is one
page of fifty matches.

---

## Security

Same posture as the record contract, and attacked rather than reasoned about —
`tools/tennis/sql/tennis_lab.test.sql`, 90 assertions against a real
PostgreSQL.

- RLS on every new table (`rating_history`, `research_briefs`, `lab_flags`).
- No client role may write any of them. **A browser that could write
  `lab_flags` could switch on a market module with no provider behind it.**
- `anon` cannot reach `player_match_features`, `stg_archive_matches`,
  `ingestion_runs` or `data_quality_issues` — by table, view or RPC.
- Every privileged function fixes its `search_path` and revokes public execute.
- A published brief is immutable, including to the pipeline that wrote it.
- A brief carrying odds or a selection is refused by a CHECK constraint, not by
  a code review.

### The defect the attack suite found

`lab_matchup_inputs` and `lab_comparables` were `security invoker` and read the
**private** feature table. PostgreSQL checks table permissions when it *plans* a
statement, not when a branch returns rows — so the Matchup Studio, the
centrepiece of the Lab, returned `permission denied` to every signed-out visitor
in **both** modes, including the one where the private branch produces nothing
at all.

They are now `security definer` with a fixed `search_path`: what leaves them is
two rows of pre-match state for two named players, and the table stays shut.
This is not a workaround — it is the same narrow-door pattern `ops_health()`
uses in the record contract. The migration report asserts it.

No amount of reading would have found this. It needed a real database and a real
`anon` role.

---

## Running it

```bash
# once, in order
psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql
psql "$SUPABASE_DB_URL" -f supabase/tennis_lab.sql

# the pipeline, in order — each reads what the one before wrote
npm run tennis:features:build     # point-in-time features
npm run tennis:ratings:build      # Elo, power rating, form windows
npm run tennis:history:build      # rating snapshots  <- deltas measure against these
npm run tennis:lab:build          # derived signals + classifications
npm run tennis:brief:build        # the daily brief (needs no odds, no schedule)

# tests
npm run tennis:lab:test           # engine + UI, no database
npm run tennis:lab:sql            # against a real PostgreSQL
```

`build_history.js` runs **before** `build_lab.js`: the snapshots are what the
30- and 90-day rating deltas are measured against. The other order leaves every
delta null on the first night and silently stale afterwards.

Both are separate from `build_ratings.js` on purpose. That query is the one that
once took nine minutes and now takes seventeen seconds; bolting eight more
aggregates onto it would put that back at risk. A failure in the Lab builders
leaves the ratings intact and the Lab degraded, rather than the whole record
broken.

### Working without the real archive

`tools/tennis/fixtures/make_archive.js` generates a synthetic ATP/WTA archive in
the real 108-column shape, at any cardinality, as a **two-phase forward walk** so
the `*_pre` columns are genuinely point-in-time. Players carry latent
per-surface affinities that nothing downstream is told, so a test that finds a
clay specialist has actually found one.

```bash
node tools/tennis/fixtures/make_archive.js --out /tmp/arch --matches 361571
```

Every row carries `data_source=synthetic`. It must never be imported into a
production database.

---

## What the Lab does not have

Stated here, and stated by the AI in its answers, rather than guessed at:

- **injuries and withdrawals** — no source. EdgeDesk holds no medical
  information about any player.
- **point-by-point** — no source.
- **doubles ratings** — a pair is a team, not a player.
- **exact first-serve times for historical matches** — the archive dates a match
  to its tournament week. Where that makes a rest figure negative, it is
  reported as unknown rather than as a negative number, and named as a
  data-quality issue.
- **historical odds** — none exist for this record, which is why the model has
  no market baseline and says so on every build.
- **a current schedule** — until a schedule provider is registered, the brief
  falls back to a trends or record brief and says which it is.

---

## Data-quality signals

Tracked and surfaced throughout: `sample_size`, `missing_ranking`,
`missing_surface`, `missing_serve_stats`, `uncertain_venue`,
`weather_unavailable`, `inactive`, `low_surface_experience`, `stale_source`,
`conflicting_identity`, `partial_2026_coverage`.

Weather is optional and is never presented as conditions at first serve — the
source carries a tournament-week profile. An indoor event has no weather because
weather does not apply, not because a reading is missing.

---

## Replacing the historical source

The Lab reads `tennis.lab_*`. Those functions read `tennis.players`,
`tennis.matches`, `tennis.player_ratings_current` and
`tennis.player_match_features`, all of which carry a `source_key` checked against
`tennis.source_licenses`.

Swapping the historical archive for a licensed feed is: register the new source,
import under it, rebuild features and ratings. **No player page, matchup tool,
explorer query or AI contract changes** — they are keyed on the schema, not on
the provider.
