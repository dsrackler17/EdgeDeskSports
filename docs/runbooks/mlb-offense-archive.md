# Runbook — the MLB historical offensive archive

Ten completed MLB regular seasons of hitting, 2016–2025, in the `mlbhist`
schema beside the pitching archive. Read by the Baseball research surface in
`app.html`, by every MLB game brief, and by EdgeDesk Intelligence through
eleven tools. **It is never current-season data, and it is never a lineup.**

---

## What it is, in one paragraph

`mlbhist` holds one row per hitter per season (teams combined), one row per
hitter per season per club (teams split), career and club summaries, club
offense by season with each club's actual games, the annual league baselines
the ratings are computed against, and the package's own per-season validation.
Every number is recomputed and checked before it is published; the two player
grains are the same plate appearances at two levels of detail and are never
added together.

`offensive_index` is a **custom descriptive index**, version `ED_BAT_PERF_V1`:

```
sample_weight   = PA / (PA + 200)
offensive_index = 100 + 100 * sample_weight * (OBP/league_OBP + SLG/league_SLG - 2)
```

100 is that season's MLB average, higher is better. It is **not** OPS+, wRC+,
WAR, a percentile or a 0–100 grade; it is not park- or opponent-adjusted; it
measures neither defence nor baserunning value; and it is never converted into
a probability, a price, a total or a player prop anywhere.

---

## First install

1. Run `supabase/mlb_pitcher_history.sql` first — it owns `mlbhist.import_runs`
   and `mlbhist.teams`, which this archive shares.
2. Run `supabase/mlb_offense_history.sql`. Every row of its report must read `ok`.
3. Optionally run `supabase/mlb_offense_features.sql` for the as-of research view.
4. Supabase → API → **Exposed schemas** must list `mlbhist` (already true if the
   pitching archive is installed).
5. Import the committed dataset:

   ```bash
   EDGD_SB_SERVICE=<service role> EDGD_SB_URL=<project url> \
     npm run mlb:off:import:commit
   ```

6. Open the app → Research → **Baseball** → **Hitters**. The coverage line
   should read `2016–2025 MLB regular seasons · 3097 hitters (2513 with a plate
   appearance)`.

---

## The three game counts, and why they are not interchangeable

This is the single easiest thing to get wrong in this dataset.

| Field | What it is |
|---|---|
| `batter_seasons.games` | MLB's **official** player-season games. This is a player's games. It can include games with no batting. |
| `batter_seasons.team_split_games_sum` | the sum of that player's team splits, kept **only** for reconciliation |
| `team_offense_*.player_games_sum` | the sum of player games. **NOT** a club's games. |
| `team_offense_*.team_games` | the club's actual games, from MLB's own team endpoint. `runs_per_game` uses this. |

One 2024 player-season disagrees between the first two (player 643376: 91
official, 92 summed). It is preserved in `mlbhist.offense_games_reconciliation`
rather than smoothed away.

---

## The two grains

`batter_seasons` is teams combined; `batter_team_seasons` is the same
performance split by club. **They are never added together** — doing so
double-counts a career. The promote gate refuses an import where a
player-season's plate appearances disagree with the sum of its own club rows
(`GRAIN_VIOLATION`), because that is the shape of a lost traded club.

---

## Undefined is not zero

* **1,889 player-seasons have zero plate appearances** — pitchers, mostly. They
  keep their counting statistics and have no average, no OBP, no SLG and no
  rating.
* **17 rows have walks and no at-bats.** OBP is defined; SLG, OPS and the
  rating are not.

Nothing in the pipeline or the UI substitutes a zero for an undefined rate.
The hitter board renders those cells as a dash whose tooltip says so.

---

## Qualification, and 2020

MLB's rule is 3.1 plate appearances per club game, so the threshold is a
**function of the season**: 503 PA in a 162-game year and **186 PA in 2020's
60-game season**. Applying a full season's screen to 2020 erases it entirely.
`EDMlbBatters.qualifiedPA(teamGames)` computes it, every leaderboard states
which screen it applied and what MLB's own is, and a 2020 board says why.

---

## The refresh

`.github/workflows/mlb-pitchers.yml` refreshes **both** archives in one job —
weekly on Tuesdays and daily during the season. The pitching refresh runs first
because it owns the shared `mlbhist.teams` table; the offensive one never
writes it. Each has its own gate, so a bad night for one does not leave the
other stale.

```bash
npm run mlb:off:dataset                            # validate the committed copy
node tools/mlb/refresh_offense.js --check          # rebuild and validate, import nothing
node tools/mlb/refresh_offense.js --commit         # rebuild, validate, import
node tools/mlb/refresh_offense.js --commit --through 2026
node tools/mlb/refresh_offense.js --commit --final          # the season is over
node tools/mlb/refresh_offense.js --commit --publish-dataset
```

**The current season is provisional**, and here that matters more than it does
for pitching: the **league baseline moves too**, and every rating in the archive
is computed against it. Pass `--final` only after the regular season has
actually finished.

---

## When it fails

**Nothing that fails can damage the archive already on file.** The build writes
to staging, the validation runs before any write, and the promote is one
transaction.

| Question | Where |
|---|---|
| Did the job run? | GitHub → Actions → *MLB historical archives* |
| What did the pipeline last do? | `select * from mlbhist.meta where key like '%offense%'` |
| Which import was refused, and why? | `select import_id, dataset, status, message from mlbhist.import_runs where dataset='offense' order by started_at desc limit 5` |
| What is live right now? | `select * from mlbhist.offense_status` |

The promote gate's five refusals, each returned by name:

| Code | Means | Do |
|---|---|---|
| `EMPTY_STAGING` | nothing reached staging | the build or stage step died; read the job log |
| `COUNT_MISMATCH` | staged rows disagree with the package's own counts | the download was short; re-run |
| `DUPLICATE_KEY` | the same player-season arrived twice | a builder bug; do not force it, report it |
| `VALIDATION_FAILED` | a season did not reconcile to MLB's own totals, at either grain | MLB's feed disagreed with itself; re-run later |
| `GRAIN_VIOLATION` | a player-season disagrees with the sum of its own club rows | a lost club — the exact failure that makes a career look smaller than it was |

To abandon a staged import without touching anything live:

```sql
select mlbhist.abandon_offense_import('<import_id>', 'why');
```

There is **no way to force a promote past the gate**, and that is deliberate.

---

## What this data does not contain

Named here because the desk is asked for them and must refuse rather than
estimate: daily lineups, lineup slots, batting order, handedness splits,
batter-versus-pitcher history, pitch-type data, Statcast expected statistics,
exit velocity, injuries, defensive value, baserunning value beyond stolen-base
outcomes, and any contract, trade or roster date.

It can establish historical lineup context when joined to a **separately
sourced current lineup**; it cannot establish who is playing today. The
`get_game_lineup_context` tool takes the names a live source produced and
refuses when given none.

---

## Two-way players

`mlbhist.two_way_players` joins `batter_overview` to `pitcher_overview` on the
MLB person id the two archives share, filtered to players with both plate
appearances and outs. **Every pitcher who batted is in the hitting archive**, so
a hitting record alone does not make someone two-way; both workloads are
returned so a caller can decide what counts. The two ratings are different
indexes on different scales and are never combined.

---

## Model research

`supabase/mlb_offense_features.sql` adds one view,
`mlbhist.batter_prior_features` — for each `(player_id, season)`, everything
EdgeDesk knew about that hitter **before** that season. Every feature comes
from a window frame ending **one row short** of the season it describes, so
look-ahead leakage is structural rather than a filter someone must remember.
`outcome_*` columns carry the season being predicted and are never features.
The share of the three-season baseline that came from 2020 travels as its own
column.

```bash
npm run mlb:off:features          # walk-forward on six next-season targets
npm run mlb:off:features:write    # write the reports to mlb/batters/validation
```

What it found, as committed in `mlb/batters/validation/`, over 2,165
out-of-sample hitter-seasons (200+ PA in the **prior** season, 2020 excluded as
a target):

| Target | Carry-forward MAE | Best candidate | Improvement | Verdict |
|---|---|---|---|---|
| Walk rate | 0.0210 | three-season baseline shrunk to the league | 12.0% | convincing |
| On-base percentage | 0.0350 | ridge on seven as-of features | 11.5% | convincing |
| Slugging | 0.0696 | ridge | 11.3% | convincing |
| Isolated power | 0.0465 | ridge | 9.9% | convincing |
| Offensive index | 13.84 | ridge | 15.4% | convincing |
| **Strikeout rate** | 0.0346 | shrunk baseline | 3.1% | **inside its own spread — not a finding** |

**Metrics this dataset cannot produce**, named rather than omitted: calibration,
log loss, Brier score, CLV and ROI against closing. All are defined over
game-level probabilities scored against settled outcomes; this archive holds
completed-season totals with no game logs and no dates, so it produces no
game-level probability to score. A next-season rate forecast is not a game
model and is not scored like one.

**Nothing is promoted.** `research_model_current` is untouched, no live price,
fair line, total or player prop reads any of this, and `offensive_index` is
never converted into a probability.

---

## Tests

```bash
npm run mlb:off:dataset        # the committed dataset, re-derived from its own numbers
npm run mlb:off:sql            # the schema, the gates and the grants, on a real PostgreSQL
npm run mlb:off:e2e            # both shipped importers over both datasets, end to end
npm run mlb:off:ai             # routing, retrieval, the eleven tools, the critic
npm run mlb:off:features:test  # the as-of property, proved by corrupting the future
npm run mlb:off:refresh:test   # provisional flags, staging isolation, failure preservation
npm run mlb:ui                 # both archives on the research surface, in Chromium
```

CI runs all of these in `games-sql.yml` against a real PostgreSQL service, and
that job **refuses a silent skip**: a suite that skipped is a failure there.
