# CBB_MODEL_NOTES — EdgeDesk college basketball (NCAA Division I men's) forecasting and tournament simulation

Written 2026-10-23, for the build on branch `claude/ncaam-forecast-system`. Every number here
was produced by the committed code over the committed data in this environment, and the file
that holds it is named. Where something is not built, not validated, or waits on a person,
this document says so.

**Naming.** In this repository `cbb` already means **college baseball** (schema `cbb`,
`tools/cbb`, `sbGetCbb` in `app.html`). The file name follows the request; everything in the
code is named `ncaam` / `ncaam_fc_*` so that nothing collides with college baseball.
**Men's only.** No women's source is read: the `wbb_`/`wehoop`/`ncaaw` paths are refused by a
test (`basketball/ncaam_forecast/tests/model.test.js`, "scope").

**Women's counterpart:** [`NCAAW_MODEL_NOTES.md`](NCAAW_MODEL_NOTES.md) (`basketball/ncaaw_forecast/`, its own data,
selection, champion and tables; it shares only the league-neutral research engine).

**Runbook** (Windows PowerShell setup, run, deploy, disable, rollback):
[`docs/ncaam-forecast/README.md`](docs/ncaam-forecast/README.md).

---

## 1. Status, component by component

*Implemented* = code complete. *Tested* = its suites ran green here (§12). *Activated* = it
runs and serves without a person doing anything more. *Deployed* = it is in production.
**2026-10-24:** the build is on `main`, the daily refresh runs there (first run 2026-10-23,
40042084100), and the database layer and research registration are applied in production
(*Deploy NCAAM forecast SQL*, run 40052574063: every report row `ok`). **Nothing is published
yet:** `NCAAM_FC_PUBLISH` is not set, so the daily run builds forecasts as an artifact only.

| Component | Implemented | Tested | Activated | Deployed | Blocked by |
|---|---|---|---|---|---|
| Data: ingest, quality, quarantine, D-I membership, snapshots, hashes (§3) | yes | yes | yes (`ncaam-forecast.yml`, daily on `main`) | yes | — |
| Pregame model: ratings, coherent win probability, margin and total distributions (§4–5) | yes | yes | yes (champion `ncaam_adjeff@1.0.0`) | yes | — |
| Validation and baselines, ablations, cohorts (§6) | yes | yes | n/a | n/a | — |
| Weekly challengers with guarded promotion, rollback, failure injection (§9) | yes | yes | yes (`ncaam-weekly.yml`, Mondays on `main`; first run 2026-10-26) | yes | — |
| Daily refresh and atomic publication (§10, §11) | yes | yes | builds daily; **publishes only with `NCAAM_FC_PUBLISH = on`** | builds: yes; publishes: **no** | the variable (a person) |
| Upset Watch: three separate signals, frozen thresholds (§7) | yes | yes | with publication | no | as above |
| Market-assisted forecast and market-disagreement signal | interfaces only | the "unavailable" state is tested | **no** | no | no NCAAM quotes are captured (§2) |
| Tournament simulator: official bracket, First Four, correlated strength, 100k runs (§8) | yes | yes, plus a 15-season backtest | **no** | no | the 2027 format and bracket must be VERIFIED after Selection Sunday (§13) |
| Pre-selection national-title forecasts | disabled state + reason | yes | **no** | no | no defensible selection/seeding proxy exists |
| Conference-tournament simulation | the slot engine plays any supplied bracket; pre-bracket mode disabled | yes | **no** | no | no verified 2026-27 conference formats |
| In-game (live) forecasts (§8b) | model, backtest, writer, SQL gate | yes | **no (ships disabled)** | no | no always-on runtime; feed lacks possession and event times |
| Reader: Games, Upset Watch, Tournament, Model Health tabs (§11) | yes | yes (unit + Chromium at 3 widths) | with publication | yes (shows "no forecast published yet") | publication |
| Database: `supabase/ncaam_forecast.sql` + migration, RLS, premium gate (§11) | yes | yes (real PostgreSQL) | — | **yes** (2026-10-24, run 40052574063) | — |
| Research registration (NCAAM-FORECAST 1.0.0, SIM-NCAAM-TOURNAMENT 0.1.0, EXPERIMENTAL, T3) | yes | yes | — | **yes** (same run) | — |

## 2. Discovery (what this stands on)

Read before building, in this repository:

| Found | What it gave | Used as |
|---|---|---|
| `basketball/ncaam_research/team_model.js`, `lib/additive.js` | the research adjusted-efficiency engine (offence/defence/tempo with priors, carry-over, recency) | the rating engine, **unchanged**, run over 2010+ box scores |
| `basketball/walkforward.js`, `docs/model-loop/ncaam/versions.json` | the served points model v1.1.0 and its walk-forward record; `CAL_VERSION v2` found a pooled intercept misprices neutral games | **the incumbent baseline** and the starting champion; the home-only intercept |
| `basketball/loop.js` (`MIN_GAIN.logloss = 0.0002`) | the repository's log-loss noise floor | gate G2 |
| `engine/lab/fetch.js`, `hockey/lib/io.js` | cached HTTP fetch with sha256, a Parquet reader (python3 + pyarrow) | ingest |
| `datapack/ncaam_v1` (`ncaa_mbb_matchup_stints_2026`, hash-verified) | 2025-26 substitution stints with scores at both ends | the live checkpoint backtest |
| `simulator/` (xoshiro128** / SplitMix64 streams, worker plan, results, publication, `sim_*` tables) | the NFL season simulator's engine | the tournament simulator's engine (a new sport module) |
| `supabase/simulator.sql` (`public.sim_viewer_entitled()`, fail-closed) | the premium entitlement gate | every NCAAM read policy |
| `lib/edgedesk_simulator.js` | the Simulator seat (vanilla JS) | a registered NCAAM adapter with four tabs |
| `tools/slate/live_poll.js`, `supabase/games_slate.sql` | a 45-second ESPN scoreboard poller writing `public.slate_live` | the only live feed (fetch time, score, period, clock; no possession) |
| `tools/ci/push_generated.sh`, `tools/personal/_pg.js` | race-safe generated-file commits; throwaway PostgreSQL for tests | workflows; SQL tests |
| the odds gateway | **no NCAAM market** is captured | market-assisted mode and the disagreement signal stay UNAVAILABLE |

Network from the build environment: ESPN, ncaa.com, ncaa.org and Wikipedia are blocked;
`raw.githubusercontent.com` (sportsdataverse) is reachable. That is why the 2027 tournament
format could not be verified here (§13).

### Capability matrix

| Capability | Data owned | Validated | Delivered state |
|---|---|---|---|
| Pregame win probability (D-I v D-I) | 2010–2026 results and box scores (99,846 finals) | yes, two windows + tournament holdout | **served** (champion) |
| Pregame vs a non-D-I opponent | results only, pooled non-D-I rating | descriptive cohort | served with a `NON_D1_OPPONENT_POOLED` flag |
| Two non-D-I teams | none | — | "no forecast", with the reason |
| Score distributions (margin, total, overtime) | as above | CRPS, PIT coverage, overtime rate | served |
| Upset Watch | as above | thresholds chosen on development, frozen, scored later | served (market signal UNAVAILABLE) |
| Factor tags (pace, threes, turnovers, …) | box scores | Bonferroni tests on development: all NOT_SUPPORTED | descriptive only, never moves a probability |
| Market-assisted forecast / market comparison | **none** (no NCAAM quotes) | — | interfaces + UNAVAILABLE state |
| Player availability | **none** | — | stated as "not modelled" on every card |
| In-game probability | stints for 2025-26 only; live feed lacks possession and event times | checkpoint backtest on one season | **disabled**, writer refuses to start |
| NCAA tournament, post-selection | the field once the official bracket is typed in | 15 historical tournaments | engine ready; **blocked until the 2027 format and bracket are verified** |
| NCAA tournament, pre-selection | no selection/seeding proxy | — | **disabled** with the reason |
| Conference tournaments | no verified formats | — | **disabled** (an observed bracket file can be simulated) |

## 3. Data (`basketball/ncaam_forecast/ingest.js`, `quality.js`, `dataset.js`)

- **Source**: sportsdataverse `hoopR-mbb-data` schedules and team box scores (MIT repositories
  of data compiled from ESPN's public feeds; ESPN's terms govern the underlying data, and the
  owner must review that before basketball output is sold in a paid tier). Each file's URL,
  sha256, size and fetch time are in `data/manifest.json`.
- **Season label** = the year the season ends (2026 = 2025-26). The season in progress is
  2027 (1,629 scheduled games; the first is on 2026-11-02).
- **Committed**: `data/games_<season>.csv.gz` (schema `edgedesk_ncaam_fc_games_v1`, about
  4.6 MB in all), `manifest.json`, `teams.json`, `quarantine.json`. `dataset.load()` refuses a
  file whose sha256 does not match the manifest (`HASH MISMATCH`).
- **Nothing is dropped**: every schedule row is kept with its status (postponed, cancelled);
  a problem quarantines a row from what it would corrupt and records the reason.
- **IDs**: ESPN team and game ids throughout; names only for display. Duplicate game ids
  are refused; a same-day repeat of a pairing is a `DUPLICATE_SUSPECT`.
- **D-I membership** per season: a team is D-I in season S when its games list a conference
  for it that season. Checked against the NCAA D-I list for 2024–2026: none missed; the
  extras are reclassifying programmes.
- **Neutral site and overtime**: from the source's neutral flag and period count
  (`n_ot = periods − 2`).
- **Timestamps**: a result is assumed known 4 hours after tip (`AVAILABLE_AFTER_MS`); a
  forecast is made 30 minutes before tip (`PREDICT_BEFORE_MS`). Validation is
  **retrospective**: there are no historical first-publication times.
- **Snapshots**: `dataset.snapshot(games, through)` hashes every row a fit may read; the hash
  is stored with every model record and weekly report.

2010–2026: 99,846 final games; 99,549 (99.70%) have usable box scores. Quarantine reasons:
BOX_MISSING 169, BOX_POINTS_NE_SHOTS 121, DUPLICATE_SUSPECT 3, IMPLAUSIBLE_SCORE 3,
PERIODS_INVALID 1, BOX_POSSESSIONS_IMPLAUSIBLE 1. Every final score matched the incumbent's
own data (0 mismatches in every season).

**NCAA tournament structure** is read from the games, not from labels: the last game is the
final, and its feeders are found by following each team's previous win (`quality.js ncaaRounds`;
FF/R64/…/NC by depth). **Seeds** are accepted only when every first-round pair sums to 17 and
each team keeps one seed: **2023–2026 pass; earlier seasons have no seed field and record
none**, rather than mistaking an AP rank for a seed.

## 4. Model (`model.js`, champion `ncaam_adjeff@1.0.0`)

- **Ratings**: the research engine (`team_model.js runSeason`) walked forward game by game.
  Parameters were chosen on **development 2012–2019 only** by `select.js` (35 configurations,
  coordinate descent) and frozen in `config/selection_v1.json` (hash `7807a94ff33649c6`;
  `select.js --check` verifies it). Chosen: λ 300, λ_tempo 2, carry 0.9, no recency decay,
  additive scale, non-D-I λ 400.
- **Preseason prior**: last season's rating, carried at 0.9. This is the single largest
  component (ablation: +0.022 log loss without it).
- **Parameter variance**: the engine's own per-game variance exploded in the first weeks
  (residual variance over max(1, n − teams); 99th percentile 9,430). It is replaced by a
  stabilised one, s²_prev / (games·70 + λ), from last season's residual variance.
- **Calibration**: fitted **causally and weekly**: each week only on games available before it,
  3-season window, each regime (D-I v D-I, D-I v non-D-I) separately (`calibrateCausal`). The
  intercept is a home-game correction only.
- **Market-independent**: no market input exists. A market-assisted variant would be a separate
  model id, never mixed in.

## 5. The coherent distribution (`dist.js`)

One distribution gives every number shown:

- **Regulation margin**: a normal (μ = a·home + b·rating margin; variance law
  s0 + k·parameter variance) discretised at half-integers, with an **endgame tie factor κ**
  (≈2.2, fitted as observed overtime games ÷ the smooth tie mass) that moves mass into a tie
  and shrinks every other cell by the same factor.
- **Overtime**: a tie plays 5-minute periods (μ·5/40, sd ≈ 4.8 fitted by maximum likelihood on
  overtime games) until one is decided.
- **Win probability** `winProbAt` is the **only** win-probability formula. It equals the final
  margin's mass above zero (tested to 1e-12), and the simulator draws from the same function
  (tested within 4 Monte Carlo SE).
- **Totals**: a normal mixture over the number of overtime periods, with the margin–total
  correlation ρ. Expected scores add to the total and differ by the margin (tested).
- **Variance layers kept apart**: game noise; rating (parameter) uncertainty; and, in the
  simulator only, a persistent latent team strength V (§8). Per game the simulator keeps
  sd² − V_a − V_b, so nothing is counted twice.
- **Known calibration residue**: the logistic recalibration slope is 1.046 (probabilities
  slightly timid). Part of the cause was found by a synthetic-recovery test: the plain fit reads
  the tie-compressed regulation margin as the location, about 4% attenuation near even games.
  The corrected fit (`location_fit: 'tie_consistent'`) went through the weekly gate on
  2026-10-23. It improved log loss by **−0.00008 [−0.00012, −0.00004]** and the slope to
  1.038, below the frozen −0.0002 threshold, so it was **RETAINED**, not promoted
  (`reports/weekly/2026-10-23-tie_consistent_fit.json`). The champion keeps the plain fit
  bit-for-bit, and the rest of the slope (margin kurtosis ≈ 3.3) is documented, not hidden.

## 6. Validation (`validate.js` → `validation/ncaam_fc_validation.json`, `VALIDATION.md`)

The protocol was fixed before scoring:

- burn-in 2010–2011;
- **development 2012–2019** (every choice made here);
- **confirmation 2020–2026** (scored once, after the choices);
- **tournament holdout**: the NCAA tournament games of 2024–2026, never used to choose anything.

Intervals are bootstrap clustered on game day. Log loss is clipped at 1e-6. In the tables, D1 v D1 is D-I v D-I.

| Confirmation 2020–26, D1 v D1 (n 37,450) | Log loss | Brier | Margin CRPS | 80% margin cov. | 80% total cov. |
|---|---|---|---|---|---|
| **champion** | **0.53565** | 0.18133 | **6.428** | 0.801 | 0.798 |
| incumbent as served | 0.54408 | 0.18429 | 6.641 | 0.830 | 0.812 |
| incumbent ratings in the same calibrator | 0.54371 | 0.18415 | 6.556 | 0.805 | 0.800 |
| Elo | 0.55841 | 0.18934 | — | — | — |
| home rate only | 0.65643 | 0.23189 | — | — | — |

Champion minus incumbent as served:

- **development**: log loss −0.00670 [−0.00817, −0.00530]; margin CRPS −0.136.
- **confirmation**: log loss **−0.00844 [−0.00999, −0.00695]**; margin CRPS −0.213 [−0.233, −0.194].

Against the incumbent's ratings run through the same calibrator the gain is −0.00807 [−0.00948, −0.00669], so it comes from the ratings, not the calibration.

Ablations (confirmation, champion minus ablation):

| Ablation | Log loss | Margin CRPS |
|---|---|---|
| no preseason prior | −0.02207 | −0.355 |
| constant width | −0.00007 (CI spans 0) | −0.003 |
| engine parameter variance | −0.00006 (CI spans 0) | −0.003 |
| **no endgame tie factor** | **+0.00015 [0.00003, 0.00026]** | −0.002 |

κ is kept because it calibrates overtime: forecast 0.0599 vs observed 0.0582. Without κ the overtime rate is under-forecast about 2.2×, and κ improves margin CRPS. The log-loss cost is reported, not hidden.

Calibration (confirmation): calibration-in-the-large 0.005, slope 1.046, margin 80% coverage 0.801, total 0.798. Leakage audit: 0 violations; each row's inputs predate its tip.

**Cohorts** (confirmation): by probability bucket, month, venue, games played (0–4 … 20+), event (regular / conference tournament / NCAA / NIT), conference vs non-conference, data quality, and D-I v non-D-I. They are in `ncaam_fc_validation.json`. No gated cohort regressed against the incumbent (gate G6).

**Tournament holdout** (2024–2026 NCAA games, n 199):

- champion log loss 0.48938 vs incumbent 0.49255: −0.003 [−0.013, +0.008], **inconclusive**.
- margin 80% coverage **0.754**, under target.

So tournament games are not assumed to behave like the regular season. The development tournaments (n 800) score log loss 0.565, against 0.591 for neutral regular-season games (n 3,954).

## 7. Upset Watch (`upset.js`, `config/upset_policy.json`, hash `9bfb69623f4e…`)

- **Underdog**, one rule everywhere: by the synchronized market price, else by verified seed
  (NCAA games 2023+), else by the model. The basis is shown on every card.
- **Three separate signals, never one score**:
  1. *upset probability*: underdog ≥ θ = **0.37** (the development 80th percentile among
     clear-favourite games; 0.45–0.50 is a "toss-up", not an upset);
  2. *market disagreement* (≥ 6 points): **UNAVAILABLE** (no NCAAM quotes);
  3. *high uncertainty*: regulation sd ≥ 11.53 or fewer than 5 games played.
- Chosen on development and frozen before confirmation:

  | Window | Flagged | Mean forecast | Realized (95% CI) |
  |---|---|---|---|
  | development | 18.5% of games | 0.4100 | 0.4055 |
  | confirmation | 19.9% | 0.4099 | 0.4092 (0.398–0.420) |
  | tournament holdout, seed basis | 46 of 182 (lower seed won) | 0.268 | 0.253 |
- **No narrative boosts** (March, momentum, "dangerous mid-major"). Six factor hypotheses (pace,
  three-point volume, volatile shooting, turnover pressure, offensive rebounding, free-throw rate)
  were tested on development with a Bonferroni bound. **All NOT_SUPPORTED**: they are shown as
  descriptive tags and change no probability.

## 8. Tournament simulation (`simulator/src/sports/ncaam/`, `tournament.js`)

- **Slots**: a generic bracket of slots (`bracket.ts`). The First Four feeds fixed first-round
  slots; every path is fixed; **no reseeding**; walkovers are represented. `validateBracket`
  refuses anything that is not one tree with one champion slot.
- **Correlation**: one latent strength draw d ~ N(0, V) per team per run, kept through every
  round. **V = 4.853 pts² (sd 2.20), 95% CI [3.91, 5.98]**, measured from the within-team
  covariance of frozen-forecast residuals after a 1 March freeze. That is 33,862 pairs over
  9,088 games, 2012–2026, holdout tournament games excluded (`validation/strength_uncertainty.json`).
- **Seeded and reproducible**: xoshiro128** seeded by SplitMix64, with separate streams for
  strength and postseason draws. The seed is derived from the input hash unless given. The same
  seed gives identical counts at any worker count (tested).
- **Frozen completed games**: from the official bracket file, a result is fixed only when it
  was known at the as-of time (tip + 4 h). A replay as of an earlier moment never sees a later
  result (tested on 2026: 0 fixed as of Selection Sunday, 52 after the first weekend, 67 after
  the final).
- **Outcomes**: reach R64/R32/S16/E8/F4/title game, win the title. Each has its Monte Carlo
  SE and Wilson interval, and sum rules are checked. Traces are bounded (`--trace-runs`).
- **Default 100,000 runs.**
- **Modes**:
  - *historical* (reconstructed past field): backtest only, never publishable;
  - *official* (a person-typed bracket file): publishable only when the 2027 format and bracket
    facts are VERIFIED with verifier and date;
  - *pre-selection*: **disabled** (no selection proxy);
  - *conference tournaments*: **disabled**.
- **Not a bracket-pool tool**: no pick optimisation, no "most likely bracket".

**Backtest** (`simulator/src/research/ncaam_backtest.ts` → `validation/tournament_backtest.json`):

- **Setup**: 15 tournaments (2011–2026 without 2020); 20,000 runs per arm; V against V = 0;
  seasons are the unit and intervals are season bootstraps.
- **Development** (2011–2019, 2021–2023): no difference distinguishable from zero in any round
  family. For example, title Brier differs by +0.000007 [−0.00007, +0.00009].
- **Holdout** (2024–2026, 3 seasons): Sweet 16 Brier +0.00057 [0.00027, 0.00098] for V.
  - The interval is fragile at 3 seasons.
  - **V is kept and was not tuned to the holdout.** The horizon mismatch is documented: V is
    measured from a 1 March freeze, while the tournament starts mid-March.
- **The eventual champion** was among the model's top five title probabilities in **12 of 15**
  tournaments.
- Reliability tables by probability band are in the JSON.

## 8b. In-game (live) forecasts: built, validated on one season, **disabled**

- **Model** (`live.js`): the pregame regulation distribution accrued over the remaining time
  (R ~ N(μ·f, sd²·f + v_pos)). v_pos is explicit possession uncertainty, because the feed has
  no possession field. A tie at the end of a period is priced at the pregame overtime
  distribution (fixed and tested in this build: at 0:00 no possession variance or κ applies).
- **Backtest** (`live_backtest.js` → `validation/live_backtest.json`):
  - **Data**: 2025-26 substitution stints at fixed checkpoints (10, 20, 30, 35, 38, 39 minutes);
    5,690 games. Excluded and counted: 541 not D-I v D-I, 60 whose last stint ≠ final score.
  - **Split**: whole games; development before 1 February 2026 chose the variant
    (`score_time`, v_pos 2); the test set from 1 February was scored once.
  - **Test log loss**:

    | Model | Log loss | Live model minus this (95% CI) |
    |---|---|---|
    | live model | **0.3505** | — |
    | pregame only | 0.5774 | −0.227 [−0.247, −0.207] |
    | score only | 0.3749 | −0.024 [−0.032, −0.017] |

  - **By checkpoint**: 0.537, 0.457, 0.374, 0.296, 0.228, 0.211.
  - **Strength-update challengers**, which re-estimate strength from the in-game score: worse
    for every k from 20 to 640 minutes. The score already carries that information.
- **Feed safety**: stale (> 120 s), contradictory (score down, period back, clock up, final
  with time left) or incomplete observations are written **suppressed**, with no probability
  and with their reasons. A hysteresis label turns on at 0.40 and off below 0.33. "Slow start"
  is a measured state, never a probability change.
- **Why disabled** (`config/live.json`):
  - no always-on runtime: GitHub Actions is not a real-time service, and `live_writer.js`
    refuses to start inside it;
  - `slate_live` is overwritten and pruned, so live forecasts could not be audited;
  - the feed has no possession indicator or event times;
  - one season of backtest; production latency is unmeasured.
- **Delivered pieces**: `live_writer.js`, the `ncaam_fc_live_observations()` read,
  `ncaam_fc_put_live` (refused unless `live_enabled = 'true'`) and append-only live rows.

## 9. Weekly training and guarded promotion (`weekly.js`, `evaluate.js`, `registry.js`)

- **Daily vs weekly**: the daily refresh re-fits the champion's ratings and calibration on the
  newest games (no parameter change). The weekly job evaluates challengers from a **fixed
  catalogue** of 11 changes: priors, carry-over, recency, calibration window, variance law, κ,
  tempo prior, tie-consistent fit. It rotates four per week.
- **Gates** (`config/promotion_v1.json`, version 1.0.0, written before any candidate was
  scored). The window is 2020 to the season in progress, D-I v D-I, with holdout tournament
  games excluded.

  | Gate | Requirement |
  |---|---|
  | G1 sample | ≥ 15,000 shared games and ≥ 3 seasons |
  | G2 log loss | difference ≤ −0.0002 **and** 95% upper bound < 0 |
  | G3 Brier | no worse |
  | G4 margin CRPS | ≤ +0.002 |
  | G5 calibration | \|CITL\| ≤ 0.015; slope 0.9–1.1; 80% coverage 0.77–0.83; overtime within 0.01 |
  | G6 cohorts | no gated cohort regresses |
  | G7 integrity | hashes, leakage audit, snapshot, reproducible artifact |
  | G8 operations | runtime ≤ 45 min; outputs finite |

  The outcome is PROMOTE, RETAIN or INSUFFICIENT_EVIDENCE. A model's own predictions are never
  used as labels.
- **Calibration partition**: inside each walk, calibration is fitted only on games before the
  week being predicted, so it is chronologically separate from what it scores.
- **Registry** (`registry/`):
  - an atomic pointer (temporary file + fsync + rename);
  - immutable model records;
  - an append-only `history.jsonl` with every decision, including FAILED;
  - `registry.js verify`: the pointer, the model record and the history must agree. `weekly.js`
    and `refresh.js` refuse to run otherwise.

  Rollback is a person's command with a mandatory reason. A RETAIN or a missing report cannot
  promote, in the files or in the database (`ncaam_fc_set_champion`).
- **History so far**:
  - INIT `ncaam_points@1.1.0` (the incumbent);
  - **PROMOTE `ncaam_adjeff@1.0.0`**: all eight gates passed. Log loss −0.00844
    [−0.00999, −0.00695] on 37,449 games over 7 seasons; runtime 2.19 min.
  - **RETAIN** `tie_consistent_fit` (G2, §5).
- **Research tier untouched**: NCAAM-FORECAST stays EXPERIMENTAL / T3. Operational promotion
  never changes it (`research/registration_*.json`).

## 10. Operations (`.github/workflows/`)

| Workflow | When | What |
|---|---|---|
| `ncaam-forecast.yml` | daily 13:37 UTC | ingest the season in progress → suites → `refresh.js` → publish **only if `NCAAM_FC_PUBLISH = on`** → commit data |
| `ncaam-weekly.yml` | Monday 11:07 UTC | ingest → suites + `registry.js verify` → `weekly.js` → commit registry/reports/data → DB sync if on |
| `ncaam-forecast-tests.yml` | push/PR on these paths | unit, real-PostgreSQL SQL, failure injection, Chromium e2e |
| `deploy-ncaam-forecast.yml` | manual only | SQL suite → requires `simulator.sql` in prod → apply `ncaam_forecast.sql` → optional registration |
| `simulator.yml` / `simulator-tests.yml` | existing | `ncaam` added to the dispatch choices and suites; the nightly plan includes it only once the official bracket file exists |

- **Failure handling**:
  - a failed gate or upload leaves the previous forecasts published, records the failed run
    and fails the job;
  - every weekly stage failure is recorded FAILED in the history and never moves the
    champion;
  - the reader marks forecasts stale after 36 hours or after a later failed attempt.
- **Retries**: PostgREST at most 3 on 5xx, 429 or network errors; never on a 4xx. Fetches are
  cached with sha256. Nothing re-runs a failed job by itself.

## 11. Database, security and reader

- `supabase/ncaam_forecast.sql` (byte-copied to `supabase/migrations/20261023180000_ncaam_forecast.sql`)
  is **additive and idempotent**: no drop, no delete. It requires `simulator.sql`.
- **Tables**: snapshots, models, jobs, reports, champion and its history, runs, forecasts,
  upset_watch, published, live_forecasts, alerts, config.
- **Writes** go only through service-role functions. Clients have no write grant (tested).
  Published rows are immutable (update, delete and truncate are refused).
- **Publication is one transaction** under an advisory lock, with an idempotency key. Older
  inputs never replace newer ones; a non-champion model cannot publish.
- **Reads**: every forecast, report and live row is behind `public.sim_viewer_entitled()`. It
  **fails closed**: without the entitlement authority nobody reads (tested by renaming the
  billing functions away). Anonymous users get versions and timestamps only
  (`ncaam_fc_public_status`), never a number.
- **No service-role credential is in any frontend file.** The reader uses the signed-in user's
  session; jobs use `SB_SERVICE_ROLE` from Actions secrets, redacted from every message.
- **Reader** (`lib/edgedesk_simulator_ncaam.js`, vanilla JS, existing Simulator styling; no
  framework). College Basketball has four tabs:
  - **Games**: cards with both sides' win probabilities, expected score, 80% margin and total
    intervals, overtime chance, data-quality flags, and "availability: not modelled";
  - **Upset Watch**: the three signals, the underdog basis, the frozen θ, "no narrative boost";
  - **Tournament**: its blocked state with the blockers and the disabled modes;
  - **Model Health**: the champion, the latest decisions and failed gates, with "retraining is
    not an improvement" stated, and live disabled.

  Hostile team names are escaped. Unentitled users see no number. Layout was checked at phone,
  tablet and desktop widths in Chromium.

## 12. Tests and actual results (this environment, 2026-10-23)

Node v22.22.0; PostgreSQL 16; Chromium (Playwright 1.56.1); Linux 6.18; 4 vCPU Intel Xeon
@ 2.80 GHz; 15 GB RAM.

| Suite | Result |
|---|---|
| `basketball/ncaam_forecast/tests/model.test.js` | 109 passed |
| `basketball/ncaam_forecast/tests/live_writer.test.js` | 18 passed |
| `basketball/ncaam_forecast/tests/sql.test.js` (real PostgreSQL) | 65 passed |
| `basketball/ncaam_forecast/tests/ops.test.js` (failure injection on the real weekly run, 2 min 48 s) | 37 passed |
| `simulator/tests/ncaam_sim.test.ts` | 39 passed |
| `simulator/tests/ncaam_ui.test.ts` | 38 passed |
| `simulator/tests/ncaam_ui.e2e.ts` (Chromium, 3 widths) | 37 passed |
| `npm run --prefix simulator typecheck` | clean |
| `actionlint` 1.7.7 on the five changed workflows | clean (shellcheck not installed here) |
| existing suites (simulator, navigation, odds, lab, collective, portfolio) | see the final report of this build |

**Benchmark** (the committed code; 2026 field, 68 entrants, champion model, 4 workers):
`node simulator/src/cli/run.ts --sport ncaam --season 2026 --mode historical --model champion --runs 100000 --workers 4 --dry-run`

- **100,000 runs: 2.9 s of simulation**, 39.4 s wall clock in all. The wall clock is mostly
  the full rating walk that rebuilds the as-of artifact.
- Peak RSS 1.03 GB for the process tree.
- Monte Carlo 95% half-width ≤ 0.3 points on every reported probability.

**Repairs made while testing** (root causes; no test was weakened):

- the calibrator's tie attenuation (§5; shipped as a gated challenger);
- live pricing at 0:00;
- the shrinkage scale of the in-game update (the grid was extended to the normal-normal scale);
- store and promote failures were not recorded in the history;
- a registry self-consistency check was missing;
- look-ahead of tournament results in official-mode replays;
- blank seeds in the simulator's summary;
- a trivially-true "expected = observed" field in the backtest (now an explicit sum-rule check);
- two wrong test fixtures (a negative free-throw count; a tiny bracket's depth labels).

## 13. March-readiness checklist (2026-27)

Before the season (now):

- [x] Merge the branch; apply `simulator.sql`, then `ncaam_forecast.sql` and the registration
  (`deploy-ncaam-forecast.yml`, 2026-10-24, run 40052574063).
- [ ] Set `NCAAM_FC_PUBLISH = on` before the season opens (2026-11-02). The next daily run
  publishes pregame forecasts.
- [ ] Owner review of the hoopR/ESPN data terms before NCAAM output is sold.

Weekly through the season:

- [ ] `ncaam-weekly.yml` green; Model Health shows the decision.

Daily:

- [ ] Freshness gate: schedule fetched ≤ 36 h ago; box coverage ≥ 97%.

Selection Sunday (expected 15 March 2027) and the days after:

- [ ] Verify the 2027 format (field size, play-in games, regions) against the NCAA's official
  release, and record it in `simulator/src/sports/ncaam/config.ts`: `verification: 'VERIFIED'`,
  `verified_by`, `verified_at`. **If the field has expanded beyond 68, stop**: the slot engine
  handles any tree, but the format, the First Four description and the reader text need review.
- [ ] Generate the template: `node basketball/ncaam_forecast/tournament.js --example 2026 --out …`.
  Type the official bracket into `basketball/ncaam_forecast/config/brackets/2027.json` (every
  entrant's ESPN team id, region, seed; every slot and path; `announced_at`; the source),
  then record the bracket fact as VERIFIED.
- [ ] Dry run: `node simulator/src/cli/run.ts --sport ncaam --season 2027 --runs 100000 --workers 4 --dry-run`.
  Every gate must PASS and every entrant must be rated (`unrated_entrants` empty).
- [ ] Publish through `simulator.yml` (dispatch `ncaam`, publish true). Then the nightly plan
  includes NCAAM, and completed games are frozen as results come in.
- [ ] Before the First Four: freeze the holdout record for SIM-NCAAM-TOURNAMENT (its
  registration names 2027–2029 as the prospective holdout).

Not before March (nothing to do unless a person decides to build it):

- [ ] Live forecasts: an always-on host, a feed with possession and event times, a
  multi-season backtest, then `config/live.json enabled = true` and `live_enabled = 'true'`.
- [ ] Market comparisons: synchronized NCAAM quotes captured with their timestamps.

## 14. Known limitations

- No player availability or lineup input. A star ruled out before tip is not in the number;
  every card says so.
- Validation is retrospective (no historical first-publication times).
- Calibration slope 1.046: slightly timid probabilities (§5).
- Tournament-game margin intervals under-cover (0.754 on the holdout).
- Neutral sites are treated as neutral: no proximity or travel effect (no owned venue-distance
  data).
- Seeds are verified only for 2023+; earlier tournaments have no seed field.
- The tournament strength variance V comes from a 1 March freeze, not a Selection-Sunday one.
- Women's basketball is out of scope by design.

## 15. Files

`basketball/ncaam_forecast/`:

| Path | Contents |
|---|---|
| `config.js`, `quality.js`, `ingest.js`, `dataset.js` | data |
| `dist.js`, `metrics.js`, `model.js` | distribution, scores, model |
| `select.js`, `validate.js`, `strength.js`, `factors.js`, `upset.js` | selection and validation |
| `evaluate.js`, `weekly.js`, `registry.js` | gates, challengers, champion |
| `refresh.js`, `publish.js`, `db.js` | daily build and publication |
| `tournament.js` | brackets |
| `live.js`, `live_backtest.js`, `live_writer.js` | live |
| `config/` | selection, promotion gates, upset policy, live config |
| `data/` | committed dataset |
| `registry/`, `reports/weekly/` | champion and decisions |
| `research/` | registrations |
| `validation/` | records |
| `tests/` | suites |

Elsewhere:

| Path | Contents |
|---|---|
| `simulator/src/sports/ncaam/` | `bracket.ts`, `config.ts`, `module.ts`, `inputs.ts`, `run.ts` |
| `simulator/src/research/` | `ncaam_backtest.ts`, `build_ncaam_registry_sql.ts` |
| `simulator/tests/` | `ncaam_sim.test.ts`, `ncaam_ui.test.ts`, `ncaam_ui.e2e.ts` |
| `supabase/` | `ncaam_forecast.sql`, `ncaam_forecast_registry.sql`, `migrations/20261023180000_ncaam_forecast.sql` |
| `lib/` | `edgedesk_simulator_ncaam.js`; edits to `edgedesk_simulator.js`, `.css`, `_sports.js`; `app.html` |
| `.github/workflows/` | `ncaam-forecast.yml`, `ncaam-weekly.yml`, `ncaam-forecast-tests.yml`, `deploy-ncaam-forecast.yml`; edits to `simulator.yml`, `simulator-tests.yml` |
| `docs/ncaam-forecast/README.md` | the runbook |
