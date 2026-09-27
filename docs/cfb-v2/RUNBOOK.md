# CFB V2 runbook — weekly refresh, retraining, promotion, rollback

## Weekly refresh (in season) — automated

`.github/workflows/cfb-v2-shadow.yml` runs Tuesday 13:17 UTC (the first run after the
weekly freeze) and daily 10:47 UTC, August–January. By hand:

```bash
cd football/cfb_v2/research
pip install pandas numpy pyarrow scipy scikit-learn lightgbm
export CFB_V2_DATA=$PWD/data CFB_V2_OUT=$PWD/out
bash run_all.sh live                       # fetch -> stages 1-5 for the live season -> tests -> predict_live
python3 -m v2.learn_week --season 2026     # errors, major-miss classes, football/cfb_v2/monitoring.json
python3 -m v2.predict_live --verify        # every frozen row still matches its stored hash
node ../tests.js                           # engine: 55 checks
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
2. Watch at least three frozen in-season weeks in `football/cfb_v2/monitoring.json`.
3. To make V2 the displayed number: set `is_champion = true` for the version in
   `cfb_model_versions` (only flags may change there) and switch the board to read
   `v2_shadow` instead of the V1 fields. BET additionally requires
   `params.market.bet_enabled === true`, which only the reality-checked dev rule plus a
   passing holdout can produce — it is `false` for `edgedesk_cfb_v2.0.0`.

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
| leakage / sign / determinism / immutability tests | `python3 -m v2.tests_leakage` |
| database triggers against a real Postgres | `CFB_V2_PG="-h … -p … -U …" python3 -m v2.tests_sql` |
| engine tests | `node football/cfb_v2/tests.js` |
| rebuild report only | `python3 -m v2.report` |
| export artifacts + params.js | `python3 -m v2.export` |
| migration | paste `supabase/cfb_v2_model.sql` into the SQL editor (idempotent, ends in a report) |
