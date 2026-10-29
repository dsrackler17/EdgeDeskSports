# Football Situational Intelligence Engine (FSIE)

FSIE is one engine for the NFL and every FBS college team (FCS teams appear
where the college feed carries them). It does three things:

1. **Observes** how each team plays by situation: down and distance, field
   position, clock, score and script. It reads public play-by-play, and every
   game passes quality gates first.
2. **Projects**, as research, team play volume (plays, official pass attempts,
   official rush attempts) and player opportunity (pass attempts, rush
   attempts, targets, receptions), with P10–P90 ranges.
3. **Places those projections beside existing EdgeDesk models, prop markets
   and the closing line.** None of them is changed.

**Status: EXPERIMENTAL. Integration mode: SHADOW. It moves no EdgeDesk
number.** All four registered models failed their preregistered 2025 holdout
criteria (see *Results*). The game cards label their output "Research Models
(Experimental)" and show the holdout outcome. Prop comparisons are projection
disagreements, never betting edges, and no EV is computed.

The architecture map, including what is reused from the rest of the repository
and what is new, is in
[docs/football-situational/ARCHITECTURE.md](../../docs/football-situational/ARCHITECTURE.md).

---

## Results (the 2025 holdout, evaluated once)

The preregistration (`research/preregistration.json`) was frozen and committed
before the holdout was looked at:

- content sha `c5744045a643…`
- code fingerprint `5c3164f06ac5…`
- the commit "engine, tests and the frozen preregistration (before any holdout
  look)"

`run.js holdout` evaluated each sport once and refuses a second look.
Training: NFL 2016–2024 and CFB 2015–2024. Holdout: 2025. Primary variant:
`pace_script`.

### Team volume: MAE on the holdout (bias in brackets)

| | season avg | recent weighted | market-only | **situational model** |
|---|---|---|---|---|
| NFL plays (544 team-games) | 7.11 | 7.04 | 6.88 | **6.69** (+1.24) |
| NFL pass attempts | 6.53 | 6.36 | 6.38 | **6.01** (+0.76) |
| NFL rush attempts | 6.19 | 6.09 | 5.78 | **5.67** (+0.43) |
| CFB plays (1,789 team-games) | 8.27 | 8.01 | 7.53 | **7.20** (−0.96) |
| CFB pass attempts | 6.87 | 6.69 | 7.20 | **6.39** (−0.69) |
| CFB rush attempts | 6.99 | 6.81 | 7.19 | **6.17** (−0.28) |

- **NFL team: FAILED.**
  - It beat the season average and the recent weighted average on all three
    targets. The paired, game-clustered bootstrap 95% CI upper bound was below
    0 every time.
  - It beat market-only on plays (−2.7%) and pass attempts (−5.9%). On rush
    attempts the CI crossed 0 (−1.8%, CI [−0.24, +0.02]).
  - Bias exceeded the 0.75 limit on plays (+1.24) and pass attempts (+0.76).
  - The market-only baseline has a similar plays bias (+1.96), so the 2025
    NFL simply ran fewer plays than the seasons before it.
- **CFB team: FAILED.**
  - It beat all three baselines on all three targets with CIs below 0,
    market-only included: plays −4.4%, pass attempts −11.2%, rush attempts
    −14.1%.
  - Bias on plays was −0.96 against a 0.75 limit.
  - The recorded interval coverage (0.61 / 0.73 / 0.70) also missed its range.
    The defect below explains why.

### Player opportunity: MAE on the holdout (bias in brackets)

| | n | model | season avg | recent weighted | P10–P90 coverage |
|---|---|---|---|---|---|
| NFL pass attempts (QB starts) | 444 | 6.68 (+1.07) | 7.75 | 7.63 | 0.76 |
| NFL rush attempts | 1,240 | 3.48 (−0.01) | 3.62 | 3.57 | 0.82 |
| NFL targets | 2,737 | 1.98 (+0.18) | 2.05 | 2.03 | 0.85 |
| NFL receptions | 2,737 | 1.54 (+0.13) | 1.60 | 1.60 | 0.88 |
| CFB pass attempts (QB starts) | 1,287 | 7.20 (−0.37) | 8.01 | 7.87 | 0.79 |
| CFB rush attempts | 4,329 | 3.83 (−1.13) | 3.92 | 3.86 | 0.81 |
| CFB targets | 6,014 | 2.09 (−0.86) | 2.10 | 2.11 | 0.81 |
| CFB receptions | 6,014 | 1.56 (−0.50) | 1.63 | 1.65 | 0.84 |

- **NFL player: FAILED.**
  - Rush attempts against the recent weighted average had a CI that crossed 0.
  - Pass-attempt bias was +1.07 against a limit of 1.0.
  - There were only 1,240 rush rows; 2,000 were required.
- **CFB player: FAILED.**
  - Targets did not beat either baseline significantly.
  - Bias exceeded the limit on rush attempts, targets and receptions.
  - These biases were already visible in walk-forward validation (rush
    −0.95, targets −0.52, receptions −0.47). They were registered, not fixed,
    and the holdout confirmed them.

### Ablation (holdout; each step against the step below it)

- **NFL:**
  - Situational rates against recent weighted: significant on all three
    targets.
  - + opponent: significant on pass and rush attempts.
  - + pace/script: not significant.
  - + formation/charting: not significant (+0.004 plays, p 0.18).
- **CFB:**
  - Every step through pace/script is significant on plays and rush
    attempts.
  - + formation is far **worse**: +4.95 plays MAE.
  - College formation tokens exist only from 2025. The formation features were
    zero in every training season, so the 2025 values extrapolate. Formation
    was never the primary variant, and the frozen design said college
    formation was untestable.

### A harness defect found after the look, recorded rather than fixed

`core/research.js` `simulateRows()` calls `simulateGame()` without a variant.
`predictMean()` therefore fell back to its default rung, `formation`, in two
places: when the walk-forward chose the interval scale phi, and when the
holdout measured P10–P90 coverage. The preregistered primary is
`pace_script`. The live pipeline passes the primary variant explicitly and is
not affected.

`run.js posthoc` recomputes the same numbers on both rungs. It writes
`research/posthoc_interval_variant_<sport>.json`, labelled POST-HOC, not a
criterion. It reproduces the recorded numbers exactly and shows:

- the same phi would have been chosen (NFL 1.0, CFB 0.9);
- the primary variant's 2025 coverage was **CFB 0.79 / 0.78 / 0.83** and
  NFL 0.81 / 0.78 / 0.81 (plays / pass / rush). CFB is inside the [0.74, 0.86]
  range.

**No verdict changes.** Each sport also fails a criterion computed from
`pace_script` point predictions. Fixing the defect means editing a frozen
file, so the fix belongs to a `situational_v2` preregistration with a new
untouched holdout (the 2026 season, after it ends), not to v1. The registry
result rows carry both numbers and the note.

### Against the market and the existing EdgeDesk forecast (2026 live season)

`run.js study` covers every pass-attempts, rush-attempts and receptions prop
the props pipeline captured in 2026. Props capture has been failing since
2026-10-10 (`GATEWAY_DEFERRED`, unauthorized credential), so this means NFL
weeks 4–5 and CFB weeks 5–6.

- **Entry** is the first consensus line at or after the model's inputs
  existed.
- **Close** is the last consensus line before kickoff.
- **CLV** is the project's own (`lib/edgedesk_props.js`). A missing close is
  excluded with its reason, never guessed.

| | n | model MAE | entry-line MAE | mean probability CLV | beat the close |
|---|---|---|---|---|---|
| NFL pass attempts | 58 | 7.40 | 7.38 | −3.1 pp | 4 of 9 |
| NFL rush attempts | 114 | 3.69 | 3.35 | −3.2 pp | 20 of 63 |
| NFL receptions | 334 | 1.64 | 1.68 | −3.7 pp | 13 of 43 |
| CFB pass attempts | 103 | 6.86 | 6.51 | −3.4 pp | 18 of 50 |
| CFB receptions | 361 | 1.82 | 1.75 | −2.4 pp | 54 of 139 |

The market line is as good as or better than the model everywhere except NFL
receptions (a 0.04 edge, not significant). Where the model disagreed with
the line, the close moved toward the model less than half the time, and
probability CLV was negative in every market. **There is no evidence of an
edge.**

**The existing EdgeDesk forecast** is the props model's own last pregame
evaluation of the same player, game and market (`kind: final` in
`football/props/<lg>/2026/evaluations.jsonl`). On the rows that all three
forecasts share, the situational model, the existing props model and the entry
line cannot be told apart: every paired 95% CI crosses 0 (NFL n = 56–334,
CFB n = 99–360). The props evaluation is made about 5 days closer to kickoff,
with the injury report in hand.

The props pipeline's *team* volume has no point-in-time history: its
`players.json` is rewritten every run, and this shallow checkout holds only
today's copies. Team-level comparison against it is therefore **not done**.

### What SHADOW would change if it were ever allowed

The candidate replaces the existing total's pace input with the situational
expected game plays, priced at the existing model's own pace coefficient.
Today, on real feeds, it would move:

- NFL fair totals by −0.67 to +0.52 points (mean |Δ| 0.27, 15 games);
- FBS fair totals by −0.49 to +0.74 points (mean |Δ| 0.20, 59 games).

It moves none of them: every block carries `applied_points: 0`.

Run on today's real feeds with `FSIE_MODE=OFF` and then with SHADOW, the NFL
slate builder and the FBS coverage builder produce byte-identical artifacts
apart from the block and wall-clock stamps. The FBS run was made in a
throwaway worktree.

---

## Data coverage (2026, at the last build)

| | NFL | CFB |
|---|---|---|
| Source | nflverse play-by-play, schedules, FTN charting, weekly rosters, injury reports, team box | sportsdataverse ESPN play-by-play mirror, cfbfastR schedules and head coaches |
| Teams | 32 / 32, all tier A | 138 / 138 eligible (FBS): 137 tier A, 1 tier B (Air Force: formation tokens on 46% of plays) |
| Games expected → accepted | 107 → 107 | 570 → 561 (7 partial, 2 rejected, 0 missing) |
| Team-games passing the volume gate | 214 / 214 | 1,129 / 1,140 |
| Latest complete week | 7 | 8 |
| Gaps | personnel and coverage publish after the season | no personnel, coverage, box-count or injury feed; scrambles not separable; formation tokens only from 2025 |

- **Box-score reconciliation.** NFL team pass and rush attempts match the
  nflverse team box on 214 of 214 team-games.
- **Example of a gate at work.** Alabama's offense at Tennessee (Oct 17) is
  rejected: 3.4% of its plays could not be classified. Tennessee's side of
  that game was accepted.
- **Historical backfill.** NFL 2015–2026 and CFB 2014–2026. NFL 2016–2019
  needed team-code aliases (OAK, SD, STL, JAC, WSH).

**Hosts the build environment could not reach:** api.collegefootballdata.com,
site.api.espn.com and api.the-odds-api.com (403). Nothing depends on them. The
college feed is the ESPN mirror the repository already uses.

---

## How it runs

```
node football/situational/run.js ingest      [--sport nfl|cfb|all] [--season Y] [--backfill A-B] [--force] [--offline]
node football/situational/run.js build       [--sport all] [--season Y] [--offline]
node football/situational/run.js study       --sport all [--season Y]
node football/situational/run.js walkforward --sport nfl|cfb     # validation folds only
node football/situational/run.js holdout     --sport nfl|cfb     # once; refuses a second look
node football/situational/run.js fit         --sport nfl|cfb     # production parameters, after the holdout
node football/situational/run.js posthoc     --sport nfl|cfb     # labelled post-hoc diagnostics
node football/situational/sync_supabase.js   [--dry-run]         # insert-only copy
```

`.github/workflows/football-situational.yml`:

- **daily 10:47 UTC:** ingest and the full build;
- **Sun/Mon 16:47:** an extra pass after the weekend's games;
- **every 3 h:** a market refresh with no downloads;
- **Tue 13:17:** the prop study and CLV.

The suites run first, so a broken engine publishes nothing. Artifacts are
committed through `tools/ci/push_generated.sh`. Nothing in the schedule
retrains: parameters are fitted once, after the holdout.

Each stage logs one JSON line to stderr. `data/state.json` keeps the last 30
runs with stage timings (`ms`), counts and errors.

Downloads go to `football/situational/.cache/` (ignored by git):

- every file is hashed and stamped with `last_modified` and `retrieved_at`;
- a completed season is never fetched again;
- a failed download falls back to the cached copy and says so;
- 408/425/429/5xx responses are retried with backoff.

### Artifacts (`football/situational/data/`)

| File | What |
|---|---|
| `cards.json` | what the NFL and FBS game cards render |
| `coverage.json` | per-team coverage, tiers, gaps, freshness |
| `<sport>/<season>/tendencies.json`, `observations.json` | observed situational tendencies with samples |
| `<sport>/<season>/projections.jsonl`, `player_projections.jsonl` | append-only pregame projection snapshots |
| `<sport>/<season>/comparisons.jsonl` | append-only live prop comparisons (empty while capture is down) |
| `market/<sport>_<season>_study.json` | the market study, CLV and the existing-forecast comparison |
| `shadow/<sport>.json`, `simulator_shadow_<sport>.json` | what the slate builders and simulators read in SHADOW |
| `state.json` | run log |

---

## Integration: OFF / SHADOW / ACTIVE

`config/integration.json` sets a mode per target: `nfl_slate`, `fbs_slate`,
`nfl_simulator` and `cfb_simulator`. All four are SHADOW.

- **OFF:** the adapter returns nothing. The consumers' output is
  byte-identical to before this change, and the integration suite proves it
  on the real NFL slate builder.
- **SHADOW:** the consumer appends a labelled block (`games[].situational` on
  the NFL slate, `games[].situational_shadow` on the FBS slate) with
  `applied_points: 0`. Spread and win probability are never touched.
- **ACTIVE:** refused unless all three locks are open:
  1. `research/promotion.json` records an APPROVED integration study for the
     target. No file in this repository creates it.
  2. `points_applied` is true.
  3. The mode is ACTIVE.

  The adapter checks the locks itself. The Postgres table refuses a shadow
  row that applies points unless it is ACTIVE.

The environment variable `FSIE_MODE` can only *lower* the mode (`OFF`, or
`SHADOW` over `ACTIVE`).

## Rollback

1. **Stop the integration (one commit, nothing else moves).** Set every
   target's `mode` in `config/integration.json` to `OFF`. Or, for a single
   run without a commit, set `FSIE_MODE=OFF`. The slate builders then emit
   exactly what they emitted before FSIE.
2. **Stop the pipeline.** Disable *Football situational pipeline* in GitHub
   Actions. The committed artifacts stay, and the cards keep showing the last
   build with its timestamp.
3. **Remove the card section.** Delete the `fsie-styles` block and the FSIE
   script in `app.html`. Each hook is guarded
   (`window.fbSituationalHTML ? … : ''`), so with the function gone the cards
   render exactly as before.
4. **Remove the database objects.** Run
   `supabase/football_situational_rollback.sql`. It drops only `fsie_*`
   objects. The registry rows can stay: they are EXPERIMENTAL records.
5. **Remove the artifacts.** Delete `football/situational/data/`.

## Database (Supabase)

- **`supabase/football_situational.sql`:** 11 `fsie_` tables, idempotent.
  - Write-once triggers on the snapshot, projection, comparison, CLV and
    shadow tables.
  - RLS: signed-in users read, the service role writes, anon reads nothing.
  - Pregame and timestamp checks; CLV needs a close or an exclusion reason;
    a shadow row applies 0 points unless ACTIVE.
  - Retention through `fsie_prune(keep_days >= 120)`.
  - It ends with an ok / CHECK THIS report.
- **`supabase/football_situational_registry.sql`:** generated by
  `tools/football/build_fsie_registry_sql.js`.
  - It registers the four models as EXPERIMENTAL (T3) with their windows and
    criteria, and writes one result row per model from the holdout files.
  - It never writes a status past experimental.
- **`sync_supabase.js`:** copies the committed artifacts insert-only.
  - Each POST names its table's natural key (`on_conflict`), so re-runs add
    nothing.
  - Without `SB_URL` / `SB_SERVICE_ROLE` it prints **NOT VERIFIED** and syncs
    nothing.

**Deployment status: NOT VERIFIED.** The migration, the registry and the
real sync payload are tested on a throwaway PostgreSQL 16 with the Supabase
shim (`tests/sql.test.js`). They have not been applied to the production
project, and no credential was available here.

## Tests

| Suite | What |
|---|---|
| `tests/core.test.js` | situations, both sources, quality gates, aggregation, downloads, checkpointed ingestion, coverage, point-in-time features |
| `tests/model.test.js` | reconciliation on every draw, coherent possessions, players within team volume, the research guards, the criteria judge, the committed research record |
| `tests/market.test.js` | consensus, disagreement not edge, CLV with missing closes excluded, timestamps, event and player mapping, the existing-forecast join |
| `tests/integration.test.js` | the real NFL slate builder OFF vs SHADOW, the adapter's locks, the simulator shadow, pricing isolation, the run log |
| `tests/sql.test.js` | the migration, RLS, write-once, rollback, the registry, the real sync payload |
| `tools/football/fsie_card_ui.test.js` | the card glue cut out of `app.html` |
| `tools/football/fsie_ui.e2e.js` | NFL and FBS cards in Chromium, 390 px phone, frozen lines outside the section |

`.github/workflows/football-situational-tests.yml` runs every suite on a pull
request.

## Known limitations

- College: no personnel, coverage, box-count or injury feed exists, and
  college availability is unverified (intervals are widened). Scrambles are
  not separable from designed runs.
- The college feed writes "Shotgun" / "No Huddle" but never under-center or
  huddle. Those rates are therefore over the plays the feed marked, and can
  read high. On 2026 FBS offenses, the median overstatement against a
  charted-text denominator is 0 pp, the 90th percentile +2.4 pp, the maximum
  +18 pp.
- NFL personnel and coverage (nflverse participation) publish only after the
  season.
- A player returning from a multi-week absence is not projected until he plays
  again.
- The 2026 market study is small (props capture has been down since Oct 10)
  and covers no college rush-attempt props.
