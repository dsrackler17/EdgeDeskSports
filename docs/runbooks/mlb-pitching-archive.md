# Runbook — the MLB historical pitching archive

Ten completed MLB regular seasons of pitching, 2016–2025, in the `mlbhist`
schema. Read by the Baseball research surface in `app.html` and by EdgeDesk
Intelligence through eight tools. **It is never current-season data.**

---

## What it is, in one paragraph

`mlbhist` holds one row per pitcher per season (teams combined), one row per
pitcher per season per club (teams split), career and club summaries, the
annual league baselines the ratings are computed against, season-specific club
identities, and the package's own per-season validation. Every number is
recomputed and checked before it is published; the two grains are the same
innings at two levels of detail and are never added together.

`performance_index` is a **custom descriptive index**, version
`ED_PITCH_PERF_V1`: 100 is league average for that season, higher is better,
shrunk toward 100 by IP/(IP+40). It is not a percentile, not WAR, not ERA+,
not a probability, and it is never converted into a price or an edge anywhere.

---

## First install

1. Run `supabase/mlb_pitcher_history.sql` once in the Supabase SQL editor.
   Every row of its report must read `ok`.
2. Supabase → API → **Exposed schemas** must list `mlbhist`. Without it the
   browser gets `PGRST106` and the panel says the contract is not installed.
3. Import the committed dataset:

   ```bash
   EDGD_SB_SERVICE=<service role> EDGD_SB_URL=<project url> \
     npm run mlb:import:commit
   ```

4. Open the app → Research → **Baseball**. The coverage line should read
   `2016–2025 MLB regular seasons` with the row counts beside it.

---

## The refresh

`.github/workflows/mlb-pitchers.yml` — weekly on Tuesdays, and daily during the
season (March–October). It runs `tools/mlb/refresh_dataset.js`, which:

1. rebuilds the dataset with the packaged updater into
   `mlb/pitchers/.staging/<date>` (never over the committed copy);
2. re-derives what can be re-derived and refuses to continue if anything
   disagrees;
3. stages into `mlbhist.stg_*` and calls `mlbhist.promote_import()`;
4. writes provenance to `mlbhist.import_runs`, freshness to `mlbhist.meta`, and
   a dated manifest to `mlb/pitchers/snapshots/`.

By hand:

```bash
npm run mlb:dataset                              # validate the committed copy
node tools/mlb/refresh_dataset.js --check        # rebuild and validate, import nothing
node tools/mlb/refresh_dataset.js --commit       # rebuild, validate, import
node tools/mlb/refresh_dataset.js --commit --through 2026
node tools/mlb/refresh_dataset.js --commit --final          # the season is over
node tools/mlb/refresh_dataset.js --commit --publish-dataset  # also refresh the committed copy
```

**The current season is provisional.** While the end season is the current
calendar year, every row it writes carries `provisional = true`, the coverage
line says so, and the desk prints it in its prompt block. Pass `--final` only
after the regular season has actually finished.

---

## When it fails

**Nothing that fails can damage the archive already on file.** The build writes
to staging, the validation runs before any write, and the promote is one
transaction. A failed run leaves the previously promoted dataset live and
being served.

Where to look, in order:

| Question | Where |
|---|---|
| Did the job run at all? | GitHub → Actions → *MLB pitching archive* |
| What did the pipeline last do? | `select * from mlbhist.meta where key like 'refresh%' or key like 'import%'` |
| Which import was refused, and why? | `select import_id, status, message, staged_counts, expected_counts from mlbhist.import_runs order by started_at desc limit 5` |
| What is live right now? | `select * from mlbhist.dataset_status` |
| Per-run heartbeat | `select * from mlbhist.pipeline_runs order by started_at desc limit 10` |

The promote gate's four refusals, each returned by name:

| Code | Means | Do |
|---|---|---|
| `EMPTY_STAGING` | nothing reached staging | the build or the stage step died; read the job log |
| `COUNT_MISMATCH` | staged rows disagree with the package's own counts | the download was short or truncated; re-run |
| `DUPLICATE_KEY` | the same player-season arrived twice | a builder bug; do not force it, report it |
| `VALIDATION_FAILED` | a season did not reconcile to MLB's own totals | MLB's feed disagreed with itself; re-run later |

To abandon a staged import by hand without touching anything live:

```sql
select mlbhist.abandon_import('<import_id>', 'why');
```

There is **no way to force a promote past the gate**, and that is deliberate.
If a refusal is wrong, fix the dataset and import again.

---

## Reading the panel's own diagnostics

The Baseball panel publishes a build time — the moment an import was
**promoted**, never a value computed from the clock. A stalled pipeline shows
as an ageing freshness line rather than as fresh-looking stale rows. The
pipeline block under the panel reads `mlbhist.meta` and prints
`import_pitcher_history` and `refresh_pitcher_history` with their last run and
status; a run that failed reads **FAILED** there.

---

## What this data does not contain

Named here because the desk is asked for them and must refuse rather than
estimate: velocity, pitch mix, spin, release point, handedness splits,
injuries, game logs, opponent-specific results, batter-versus-pitcher history,
park factors, Statcast expected results, and any contract, signing, trade or
roster date. Team duration means **seasons with a recorded MLB pitching
appearance**, nothing more.

Postseason, minor leagues, spring training and rostered players with no MLB
pitching appearance are out of scope by design.

---

## Model research

`supabase/mlb_pitcher_features.sql` adds one view, `mlbhist.pitcher_prior_features`
— for each `(player_id, season)`, everything EdgeDesk knew about that pitcher
**before** that season: the prior season's rates and workload, its ERA-minus-FIP
gap, strikeout and walk trends against the season before it, the innings-weighted
three-season baseline, role and club movement, and the share of that baseline
that came from the 60-game 2020.

The as-of property is structural, not a filter someone has to remember: every
field comes from a window frame that ends **one row short** of the season it
describes. `outcome_*` columns carry the season being predicted and are never
features.

```bash
npm run mlb:features          # next-season K-BB%, walk-forward
npm run mlb:features:era      # next-season ERA
npm run mlb:features:write    # write both reports to mlb/pitchers/validation
```

The evaluation walks forward: for target season S every predictor is built from
seasons strictly earlier than S, the fitted candidate is **refit at each S** on
pairs earlier than it, the league reference is the league's *prior* season, and
2020 is excluded as a target. The incumbent to beat is carry-forward — last
season's own number.

What it found, as committed in `mlb/pitchers/validation/`:

* **Next-season K-BB%** — carry-forward 0.0467 MAE over 2,272 out-of-sample
  pitcher-seasons; a three-year baseline shrunk toward the prior league value
  gets 0.0390, about 17% better, comfortably outside its own spread. A ridge
  fit on twelve as-of features adds essentially nothing on top of the
  shrinkage.
* **Next-season ERA** — carrying a pitcher's own prior ERA forward is *worse
  than predicting the league average*. That is a fact about ERA's year-to-year
  instability and it is reported rather than buried.

**Nothing is promoted.** `research_model_current` is untouched, no live price,
fair line or EV reads any of this, and `performance_index` is never converted
into a probability or an odds number. A next-season rate forecast is not a game
model, and this data — season totals with no game logs — cannot become one
without leaking a season's own result into a prediction made before it.

---

## Tests

```bash
npm run mlb:dataset   # the committed dataset, re-derived from its own numbers
npm run mlb:sql       # the schema and the promote gate, on a real PostgreSQL
npm run mlb:e2e       # the shipped importer over the real dataset, end to end
npm run mlb:ai        # routing, retrieval, the eight tools, the critic
npm run mlb:ui        # the research surface in Chromium against a real database
npm run mlb:refresh:test   # the refresh path: provisional flags, staging, publish
npm run mlb:features:test  # the as-of property, proved by corrupting the future
```

CI runs all of these in `games-sql.yml` against a real PostgreSQL service,
and that job **refuses a silent skip**: a suite that skipped is a failure
there, not a pass.
