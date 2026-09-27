# CFB V2 runbook — weekly refresh, retraining, promotion, rollback

## Weekly refresh (in season) — automated

`.github/workflows/cfb-v2-shadow.yml` runs Tuesday 13:17 UTC (the first run after the
weekly freeze) and daily 10:47 UTC, August–January. By hand:

```bash
cd football/cfb_v2/research
pip install pandas numpy pyarrow scipy scikit-learn lightgbm
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out
bash run_all.sh live                       # fetch -> stages 1-5 for the live season -> tests -> predict_live
python3 -m v2.learn_week --season 2026     # errors, major-miss classes, football/cfb_v2/learning/2026_summary.json
python3 -m v2.predict_live --verify        # every frozen row still matches its stored hash
python3 -m v2.shadow --season 2026         # append the line ledger; rebuild shadow/2026/outcomes.json
node ../shadow_decisions.js                # engine.decide() on the frozen rows -> shadow/2026/decisions.json
python3 -m v2.monitor --season 2026        # football/cfb_v2/monitoring.json: by-week metrics + health warnings
node ../tests.js                           # engine: 100 checks
node ../candidates.test.js                 # the frozen candidate still matches its manifest hashes
SB_URL=... SB_SERVICE_ROLE=... node ../sync_supabase.js --season 2026   # optional: insert-only DB copy
```

What `live` does, in order: ingest the season's finalized play-by-play → validate
(leakage + artifact tests) → team-game efficiency → opponent-adjusted ratings at every
freeze → recent-form horizons → QB ratings and expected starters → snapshots →
predictions from the **frozen** artifacts → write-once files in
`football/cfb_v2/snapshots/<season>/` for every game whose Tuesday freeze has passed
and whose kickoff has not → `football/cfb_v2/current.json` (next 10 days; FROZEN or
PROVISIONAL rows; FBS-vs-FCS rows flagged `priced:false`).

Nothing is refit in season. A surprising weekend changes ratings (that is data), never
coefficients.

## Shadow records (what is kept, and the rule for each)

| file | rule | contents |
|---|---|---|
| `snapshots/<season>/<freeze>.json` | **write-once, hashed** (`hash` = whole row, `pure_hash` = the pure projection) | V2.1.0 projection, distribution, components; frozen with it: candidate 001's projection, V1's published projection (`football/fbs/slate.json`), the market at the freeze, and the board's pregame availability / QB-availability / named-starter evidence with the availability sync digest (recorded only, never read by V2) |
| `shadow/<season>/lines.jsonl` | **append-only** | one line per game whenever the observed opener / current number / total changes, stamped with the observation time |
| `shadow/<season>/outcomes.json` | derived, rebuilt every run | closing number (last pre-kickoff ledger line), final result, each model's error, CLV, ATS at the freeze line and at the close |
| `shadow/<season>/decisions.json` | derived, rebuilt every run | the research status (BET / LEAN / REVIEW / PASS) the production engine gives each frozen row against the market at the freeze |

A frozen row is never edited. `predict_live --verify` fails if any stored row no longer
matches its hash, and a re-run that would produce a different pure projection for an
already-frozen game is refused and logged, not written.

## Monitoring and health warnings

`football/cfb_v2/monitor.html` renders `monitoring.json`. Per frozen week: MAE, RMSE,
bias, Brier, V1 and candidate 001 on the same games, the line at the freeze and the
close, CLV, ATS, C/D disagreement, largest misses; statuses and pass rate. Warnings:

| warning | fires when |
|---|---|
| `mae_spike` | a week's MAE is above the backtest expectation + 2 standard errors |
| `calibration` | season-to-date win-probability miscalibration is beyond sampling noise |
| `missing_pbp` | a final FBS game older than 48 h has no play-by-play rows |
| `stale_odds` | the line source was last retrieved more than 36 h ago, or games within 72 h have no line observation |
| `stale_injury_source` | an upcoming game's availability source is more than 72 h old |
| `bet_count` | any BET while BET is disabled, or BET on more than 10% of games |
| `ensemble_weights` | the live weights differ from the exported artifact |
| `disagreement` | C and D disagree beyond the backtest's 99th percentile |
| `pipeline_stale` | `current.json` is more than 36 h old in season |
| `feature_drift` | week-matched PSI of an output (ens_pred, sigma, ens_sd, pred_total) exceeds both 0.25 and the 99th percentile of its sampling-noise null |

**A warning informs a person. Nothing retrains, re-weights or disables itself.**

## Frozen candidates

`football/cfb_v2/candidates/<id>/` holds a frozen model: manifest (code commit, feature
version, parameters, windows, data versions, seeds, file hashes), the predictions it
made, its artifacts and `params.js`. `cfb_v2_candidate_001` is the baseline every
change is compared against.

```bash
python3 -m v2.freeze_candidate cfb_v2_candidate_002 --commit <sha> --artifacts <version>   # refuses to overwrite
node football/cfb_v2/candidates.test.js                                                     # re-hash every candidate
```

## Offseason retrain — manual

```bash
bash run_all.sh retrain        # or: Actions -> CFB V2 shadow -> Run workflow -> mode=retrain
```

Downloads everything (~1.5 GB), rebuilds V1's market table and V1's cold replay for the
comparison, re-tunes on the development window only, runs the grouped ablation, the
walk-forward, the market layer, the reality-checked rule search, the report and the
export. **Bump `MODEL_VERSION` in `research/v2/config.py` first**, and roll the windows
forward (the newest completed season becomes part of the holdout; never tune on it).
The workflow uploads the result as an artifact for review; it does not commit it.

## Promotion (a person decides)

1. Read `docs/cfb-v2/BACKTEST.md` → "Promotion decision". Every gate must PASS.
2. Read `docs/cfb-v2/CHAMPION_CHALLENGER.md` (V1 vs candidate 001 vs the current
   version on the same games) and `docs/cfb-v2/REDTEAM.md` §24.
3. Watch frozen in-season weeks in `monitor.html`: V2 must stay ahead of V1 on the
   frozen 2026 games, with no open health warning, before anyone switches.
4. To make V2 the displayed number: set `is_champion = true` for the version in
   `cfb_model_versions` (only flags may change there) and switch the board to read
   `v2_shadow` instead of the V1 fields. BET additionally requires
   `params.market.bet_enabled === true`, which only the reality-checked dev rule plus a
   passing holdout can produce. It is `false` for `edgedesk_cfb_v2.1.0`.

A new version must also beat or equal the frozen candidate it replaces on development
data under rules written down first (`docs/cfb-v2/HARDENING_PREREG.md`); a change that
only raises historical ATS is not a reason to adopt it.

## Rollback

V2 is additive; nothing V1 reads was changed.

* **Stop V2 entirely**: disable the `CFB V2 shadow` workflow (Actions → ⋯ → Disable).
  `football/fbs/build_coverage.js` then keeps publishing whatever `current.json` last
  held, marked with its `generated_at`; delete `football/cfb_v2/current.json` to make
  `v2_shadow` null on every slate row (the builder treats a missing file as "no block").
* **Revert a bad model version**: `git revert` the commit that changed
  `football/cfb_v2/artifacts/<version>` and `football/cfb_v2/params.js`. Frozen
  snapshots already written stay as they are: they are the record of what that
  version said, and the database refuses to edit or delete them.
* **If V2 had been promoted**: set `is_champion = false` on its `cfb_model_versions`
  row and `true` on V1's; the board reads V1's fields, which were never removed.
* **Database**: every `cfb_*` table is new and independent of V1 tables. There is
  nothing to roll back in V1's schema. Do not drop the tables — the pregame record is
  the audit trail.

## Commands reference

| purpose | command |
|---|---|
| leakage / determinism / immutability tests | `python3 -m v2.tests_leakage` |
| sign-convention scenarios | `python3 -m v2.tests_signs` |
| future-poisoning end-to-end leakage test | `python3 -m v2.tests_poison --season 2019 --cut-week 7` |
| leakage audit table | `python3 -m v2.leakage_audit` |
| red-team phases (candidate 001 / hardened) | `python3 -m v2.redteam --phases 4,5,6,9,10 [--config hardened]` |
| hardening decisions (pre-registered rules) | `python3 -m v2.harden` |
| champion / challenger report | `python3 -m v2.champion_report --c001 out_c001 --hard out_h` |
| red-team report | `python3 -m v2.rt_report` |
| database triggers against a real Postgres | `CFB_V2_PG="-h … -p … -U …" python3 -m v2.tests_sql` |
| engine tests | `node football/cfb_v2/tests.js` |
| rebuild report only | `python3 -m v2.report` |
| export artifacts + params.js | `python3 -m v2.export` |
| migration | paste `supabase/cfb_v2_model.sql` into the SQL editor (idempotent, ends in a report) |
