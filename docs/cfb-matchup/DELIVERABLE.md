# CFB scheme and matchup intelligence engine: the 40-item deliverable

Companion documents: [AUDIT.md](AUDIT.md) (data), [METHODS.md](METHODS.md) (how), [BACKTEST.md](BACKTEST.md)
(evidence). Everything is new code; **no existing file was edited** and no production number changes.

## Production promotion recommendation (item 40), first

**Do not promote any matchup correction. Keep V2.1 as the fair line. Ship the matchup engine as a
described, versioned, monitored layer with a zero correction, and track one shadow challenger.**

- **Nothing passes.** Not one of the 18 families, the kitchen-sink ridge, the shallow GBM, the
  clusters or the variance model passes the pre-registered dev rule (BACKTEST §1-3, §9).
- **The best dev correction is −0.0045 MAE [−0.022, +0.013].** It improves 5 of 8 seasons, and its
  sign agrees with the residual on only 50.7% of games.
- **The frozen artifact is `cfb_matchup_resid_v1` = NO_ADJUSTMENT** (sha256 `4a5fcca7…c62363`). On
  the 2024-2025 holdout (n = 1,607) and on live 2026 (n = 208), matchup-aware = general exactly.
- **The shadow challenger is the all-families ridge, frozen on dev, λ = 0.377.** On the holdout it
  scored −0.0123 MAE [−0.032, +0.007], with log loss +0.0003 [−0.0006, +0.0012]; it helped 2025 and
  not 2024. It is favorable but not significant, and probability metrics are slightly worse.
- **How it could be promoted.** It is recorded as `shadow_adjustment_points` on every live game. It
  becomes a candidate only under the champion/challenger governance, if the live Model Lab
  accumulates a CI-clean gain across seasons and conferences (brief 71). Promotion needs a person and
  evidence: the `cfb_matchup_model_versions` CHAMPION check enforces it.
- **What should reach the product** is description, not correction:
  - the PASS / RUSH / TRENCH / HAVOC / EXPLOSIVE edges;
  - expected pass behavior and tempo (the one validated model: opponent response);
  - expected possessions;
  - style with uncertainty;
  - scheme-continuity and style-change flags;
  - "matchup adjustment: 0.0: no measured matchup interaction has improved the line out of sample".

## For the orchestrator: what to wire

**Weekly engine** (`v2/weekly/run.py`, after the projection stage that sets `ctx['X']` and the
projections):

```python
from v2.matchup import hook as MH
out = MH.matchup_week(season, T, ctx['X'], projections=<frame with game_id, ens_pred, sigma>, week=tw)
rows = MH.table_rows(out)   # {'cfb_team_week_style': [...], 'cfb_game_matchup_features': [...],
                            #  'cfb_similar_matchups': [...], 'cfb_style_change_events': [...]}
```

1. **Prerequisite stages.** `python3 -m v2.matchup.style <season>` must run after
   OPPONENT_ADJUSTMENT: it rebuilds the style ratings of the season: 16 s warm, 62 s when the PBP caches must be rebuilt.
   The caches are keyed on the PBP file's size and mtime, so a live season's new games invalidate
   them. The
   events come from `style_change_events.parquet`, produced by the backtest. For the live season,
   add a stage that calls `changes.events(season, thresholds)` with the thresholds recorded in
   `backtest_dev.json['change_thresholds']`.
2. **Storage.** Append the rows to the weekly store (new kinds, ids already deterministic: `cfbms_`,
   `cfbmg_`, `cfbmx_`, `cfbme_`). Mirror them insert-only to the tables of `supabase/cfb_matchup.sql`,
   the same pattern as `football/cfb_weekly/sync_supabase.js`. The payload shape is exactly
   `table_rows()`, which the SQL test inserts.
3. **Model versions.** Seed `cfb_matchup_model_versions` once with `hook.version_rows(art, now)`: 7
   rows, no CHAMPION.
4. **Gate.** The hook asserts every row is frozen at T. A failed hook should mark the matchup stage
   WARN and leave the V2.1 projection untouched: the correction is zero anyway.

**Model Lab** (`football/cfb_lab`):

1. After settlement, call `hook.lab_monitor(records, {game_id: final_home_margin})`. Write one
   `cfb_matchup_monitor` row per week. It reports:
   - MAE general vs production (0 by construction) vs **shadow**;
   - direction agreement of corrections of 0.5+ points;
   - breakdowns by primary-edge category and by matchup-confidence bucket.
2. `hook.weekly_report(records, results)` gives the week's largest shadow corrections and whether each
   was directionally right. The rule is recorded in the output: no production change after one week.
3. Add the matchup layer to the lab's governance list as component `matchup_residual`: status
   NO_ADJUSTMENT, challenger `shadow`.

**Tests to keep green.** Commands:

```
python3 -m v2.matchup.tests_matchup --fast
python3 -m v2.matchup.tests_matchup
node football/cfb_matchup/sql.test.js
```

In CI, set `CFB_MATCHUP_SQL_REQUIRED=1` so a missing Postgres fails the SQL test instead of skipping.

## The 40 items

| # | item | where | result |
|---|---|---|---|
| 1 | scheme-data audit | AUDIT.md §1; `audit.py` → `matchup/audit.json` | 18 seasons measured; formation / depth / direction / hurry exist only 2025-2026; PBU and provider stuff drift; the per-play clock is drive-stamped before 2024 |
| 2 | available / derivable coverage | AUDIT.md §2-3 | 44 fields: 20 DERIVABLE, 9 PARTIAL, 12 UNAVAILABLE, 1 UNRELIABLE, 2 REJECT; split-half reliability per metric |
| 3 | offensive style model | METHODS §2.1-2.2; `style.py` | 7 behavior + 5 efficiency style metrics plus V2's 24, point in time, style_mean + style_sd |
| 4 | defensive style model | METHODS §2.2 | the defensive rating of each metric: quality for efficiency, **opponent response** for behavior |
| 5 | game-state adjustment | METHODS §1 | own xpass / xgo models on 3 prior seasons; PROE, neutral definitions |
| 6 | opponent-adjusted style performance | METHODS §2.2; §4 (residuals) | V2's joint solver per metric; the similar-opponent engine uses V2.1-residual (vs expectation) performance |
| 7 | pass matchup | `interactions`: `xm_epa_pass`, `mix_exploit`, `rel_align` | REJECTED (pass_rush family) |
| 8 | rush matchup | `xm_epa_rush` | REJECTED (pass_rush) |
| 9 | protection / pressure matchup | `xm_sack`, `hinge_sack`, `xm_havoc` | REJECTED; the "bad OL vs elite havoc" narrative has no value |
| 10 | QB mobility matchup | `qbr_contain`, `qbr_vs_rush`, `edge_qb_rush_epa` | REJECTED; designed vs scramble not separable (AUDIT) |
| 11 | explosive-pass matchup | `xm_expl_pass`, `hinge_expl_pass`; variance `var_expl` | INCONCLUSIVE (explosive family); variance effect REJECTED |
| 12 | explosive-rush matchup | `xm_expl_rush` | INCONCLUSIVE (explosive family) |
| 13 | trench matchup | `xm_line_yds`, `xm_stuff`, `hinge_stuff` (run_block_edge); protection separate | REJECTED |
| 14 | early-down matchup | `edge_epa_early`, `xm_epa_early` | INCONCLUSIVE; the strongest drop-one contributor (+0.007), not significant |
| 15 | passing-down matchup | `edge_epa_pd`, `xm_sr_pd`, `pd_burden` | REJECTED |
| 16 | finishing-drives matchup | `edge_pts_per_opp_v`, `edge_so_rate_v`, `xm_pts_per_opp` | REJECTED |
| 17 | pace interaction | `poss_x_strength`, `tempo_edge`; expected possessions | REJECTED; slow-game compression is in-sample only (+0.56 pts/SD) |
| 18 | similar-opponent engine | `similar.py`; METHODS §4 | INCONCLUSIVE (−0.0029 [−0.015, +0.008]) |
| 19 | similarity methodology | METHODS §4 | Mahalanobis, h = 0.5, chosen on dev from a 6-config grid; general form removed; shrunk by 3 pseudo-games; the display threshold is not validated |
| 20 | matchup residual model | `residual.py`, `backtest.py`; BACKTEST §1-3 | nothing validates → **NO_ADJUSTMENT** artifact |
| 21 | expected play-selection model | METHODS §6; BACKTEST §9 | **VALIDATED** (opponent response beats own tendency for PROE and tempo on dev and holdout); descriptive output |
| 22 | drive-model integration | `drive_div`; expected possessions | V2's drive model disagreeing with the ensemble **hurts** (+0.006); a tempo-informed possession count improves drive MAE 2.78 → 2.75 but not the margin |
| 23 | personnel interaction integration | `inexp_x_rush`, `qbchg_x_havoc`, `inexp_x_pd_burden` (the V2.1 / personnel QB columns) | INCONCLUSIVE; OL / secondary / front-seven have no point-in-time history (AUDIT §5) |
| 24 | matchup uncertainty | `VarianceModel`; BACKTEST §9 | REJECTED (log-lik +0.0001 [−0.0011, +0.0013]); matchup variance effect = 1.0 |
| 25 | scheme change detection | `changes.py`; BACKTEST §11; METHODS §2.3-2.5 | calibrated events (~40 / season, ~1/3 real); faster re-weighting REJECTED; continuity and new-HC effects measured and used in the priors |
| 26 | feature ablation | BACKTEST §2 | add-one and drop-one tables, 18 families |
| 27 | historical backtest | BACKTEST §1 | dev walk-forward 2016-2023; holdout once; live 2026 |
| 28 | matchup-adjustment bucket analysis | BACKTEST §5 | <0.5 / 0.5-1 / 1-2 / 2-3 / 3+, shrunk and unshrunk, dev and holdout |
| 29 | interpretable vs nonlinear | BACKTEST §3 | ridge −0.0045 (INCONCLUSIVE) vs GBM +0.0012 (REJECTED); robust to α 256-16384 |
| 30 | features rejected | BACKTEST §2, §7, §9-11 | all 18 families; 13 narratives; clusters; variance; the similar display threshold; post-change re-weighting |
| 31 | database migrations | `supabase/cfb_matchup.sql` | 6 append-only tables, 3 views, point-in-time / correction / threshold / champion CHECKs |
| 32 | weekly update integration | `hook.matchup_week`, `table_rows`; "what to wire" above | at the freeze T; no weekly retraining |
| 33 | Model Lab integration | `hook.lab_monitor`, `weekly_report`; `cfb_matchup_monitor` | production vs shadow, by category and confidence |
| 34 | frontend / internal explanation output | `hook.explain`; METHODS §8 | number-only primary / secondary edge, primary risk, 5 public edges, contradiction flag; NO_ADJUSTMENT note |
| 35 | tests added | below | `tests_matchup` 60 (40 fast + 20 real); `sql.test.js` 77 |
| 36 | files / functions changed | below | new files only |
| 37 | performance with and without the engine | BACKTEST §1 | dev 12.799 → 12.799 (production) / 12.795 (challenger); holdout 12.323 → 12.323 / 12.311 |
| 38 | remaining limitations | below | |
| 39 | highest-value missing scheme data | AUDIT §5 | charted pressure / blitz; personnel and formation; designed vs scramble; point-in-time injuries and snaps; coordinator names; archived forecasts |
| 40 | production promotion recommendation | top of this file | no correction; description + monitoring + shadow challenger |

## Files (item 36), all new

| file | purpose |
|---|---|
| `football/cfb_v2/research/v2/matchup/__init__.py` | versions |
| `…/matchup/audit.py` | `season_coverage(S)`, `classify(per_season)`, `run(seasons, write)`; `FIELDS`, `FORBIDDEN` |
| `…/matchup/style.py` | `extract_plays`, `plays`, `xpass_design`, `xgo_design`, `expectation_models(S)`, `team_game_sums(S, P, models)`, `team_games`, `load_tg`, `varcomp`, `data_only_finals`, `prior_design`, `style_prior`, `build(seasons_out)`, `ratings`, `league`, `finals`, `metric_scales`, `wide`, `split_half_reliability` |
| `…/matchup/interactions.py` | `FAMILIES`, `NARRATIVES`, `VARIANCE_FEATURES`, `PUBLIC_EDGES`, `attach_style(X)`, `season_features(g, S)`, `build(X)`, `all_feature_cols()` |
| `…/matchup/similar.py` | `team_vectors(S)`, `history_frame(M)`, `whitening`, `kernel`, `build(M, metric, h, vectors, want_pairs, seasons)`, `FAMILY` |
| `…/matchup/changes.py` | `continuity_table`, `persistence_study`, `head_coach_moves`, `game_series(S)`, `scan`, `calibrate`, `events(S, thresholds)`, `validate_events` |
| `…/matchup/residual.py` | `base_frame`, `t_dfs`, `win_prob`, `RidgeResid`, `GBMResid`, `walk_forward`, `metrics`, `paired`, `VarianceModel`, `t_loglik`, `freeze`, `load_artifact`, `apply` |
| `…/matchup/backtest.py` | `PREREG`, `load`, `identity_check`, `build_features`, `frame`, `score`, `decide`, `run_family`, `similarity_choice`, `buckets`, `direction_test`, `subgroups`, `redundancy`, `narrative_tests`, `variance_eval`, `play_selection_eval`, `possessions_eval`, `alpha_sensitivity`, `clustering_eval`, `missed_matchups`, `display_threshold`, `dev`, `freeze`, `holdout`, `live` |
| `…/matchup/hook.py` | `team_week_style`, `explain`, `matchup_confidence`, `matchup_week`, `lab_monitor`, `weekly_report`, `table_rows`, `version_rows`, `write_fixture` |
| `…/matchup/tests_matchup.py` | `--fast` synthetic + real-data checks |
| `football/cfb_v2/artifacts/matchup/cfb_matchup_resid_v1.json` | the frozen NO_ADJUSTMENT artifact (with the shadow challenger's coefficients) |
| `supabase/cfb_matchup.sql` | the Postgres contract |
| `football/cfb_matchup/sql.test.js`, `football/cfb_matchup/fixtures/hook_rows.json` | real-Postgres test; real hook rows (next 2026 freeze, 4 games) |
| `docs/cfb-matchup/{AUDIT,METHODS,BACKTEST,DELIVERABLE}.md` | this documentation |

Outputs (not committed): everything under `football/cfb_v2/research/out_h/matchup/`, rebuildable
with the commands in METHODS.md.

## Tests (item 35)

`python3 -m v2.matchup.tests_matchup --fast` needs no data directories. It covers:

- no forbidden column; every audited field has a status;
- xpass learns 3rd-and-long vs 3rd-and-short, and is calibrated;
- team-game sums on a synthetic play table: PROE numerator, QB-rush identification, 4th-down go over
  expected, neutral tempo, short yardage;
- every interaction is antisymmetric under a home/away swap, and every variance feature is symmetric;
- confidence stays in [0, 1];
- the explanation uses the row's measured numbers, NO_ADJUSTMENT says the line is general, and
  contradictions are flagged;
- kernel self-similarity and monotonicity, cosine scale invariance;
- the similar-opponent residual removes general form and shrinks by K0;
- a planted signal is learned out of sample, noise is shrunk, λ stays in [0, 1], and the cap binds;
- the correction has mean zero on its training rows, and a future training season is refused;
- paired zero deltas give zero CIs;
- the artifact round-trips, a tampered artifact is refused, and NO_ADJUSTMENT applies exactly 0;
- the holdout refuses a second scoring;
- a planted style shift is detected at the right game, and pure noise stays below 3.5;
- the lab monitor tracks production and shadow;
- the pre-registration lists its 3 conditions.

The real-data checks add:

- V2.1's p_home_raw is reproduced exactly;
- style ratings at T count exactly the games before T, and equal the prior before any game;
- there is one feature row per V2.1 game;
- the real 2019 rows are antisymmetric;
- every similar comparison predates its freeze and never cites itself;
- every event clears its threshold and is detected after its trigger;
- the family decisions reproduce the pre-registered rule;
- the artifact matches the dev decision, NO_ADJUSTMENT is zero on every game, and the holdout was
  scored with the frozen hash and has exactly 0 production delta;
- **the live hook reproduces the backtest features of a past (2023) freeze**;
- the hook's general margin equals V2.1's, aware = general + adjustment, and every hook column exists
  in the SQL;
- style rows carry style_sd;
- the audit covers 2009-2026.

Result: **ALL GREEN 60 passed, 0 failed**.

`node football/cfb_matchup/sql.test.js` gives **ALL GREEN 77 passed, 0 failed** against PostgreSQL
16. It covers:

- applies cleanly three ways (clean, again, as one transaction);
- exactly-once keys and supersede versions;
- a snapshot at kickoff is refused;
- a comparison after the prediction, or of the game itself, is refused;
- NO_ADJUSTMENT ≠ 0 is refused, the 3-point cap binds, and aware ≠ general + adjustment is refused;
- confidence and similarity ranges; a missing explanation or style object is refused;
- a sub-threshold event is refused;
- CHAMPION needs a person and evidence;
- append-only for the service role and the owner, on all 6 tables;
- authenticated reads, anon reads nothing, authenticated cannot insert;
- the hook's 31 real rows (4 matchup snapshots, 8 team styles, 12 similar comparisons, 7 version rows)
  insert as PostgREST would.

The production suites are unchanged and green: `node football/cfb_lab/tests.js` 275/0,
`node football/cfb_decision/tests.js` 98/0, `node football/cfb_v2/tests.js` 100/100.

## Remaining limitations (item 38)

1. **Scheme is behavior only.** No personnel, formation, pressure, blitz or coverage history exists
   (AUDIT). Designed QB runs and scrambles are pooled.
2. **Power.** Eight dev seasons resolve a matchup effect of about 0.6 points per SD. Smaller effects,
   which is what the evidence suggests any real ones are, cannot be validated from this history. The
   shadow challenger and the live Model Lab are how that evidence accumulates.
3. **Personnel × matchup is QB-only.** No point-in-time OL / front / secondary availability history
   exists.
4. **The style prior does not yet follow a moving head coach.** The effect is strong (METHODS §2.5,
   n = 50) and it is the first research item. Coordinators cannot be followed: no names.
5. **The similar-opponent outcome splits the margin residual into offense and defense** using V2.1's
   `pred_total`, a weak total model. The margin-only version (`sim_margin_edge`) is also inconclusive.
6. **The matchup confidence formula is declared, not validated.** There is no non-zero correction to
   validate it against.
7. **The 2025+ gamebook fields** (depth, direction, formation, hurries) are stored for display but
   cannot be tested until 2-3 seasons exist.
8. **The live style-change stage needs wiring.** `style_change_events.parquet` currently covers
   2014-2025 from the backtest run; 2026 has no events yet (≥ 6 games are needed per team).
9. **The similarity metric and bandwidth were selected on dev.** The similar family's dev number is
   therefore slightly optimistic; it is still inconclusive.

## What contradicts or refines existing documentation

- **`docs/cfb-v2/FEATURE_COVERAGE.md`, `pace_seconds_per_play: REJECTED`** ("the provider clock stamp
  changes meaning by season"). This is right for per-play seconds: the clock is drive-stamped before
  2024. But the **drive** elapsed time is valid in every season, so neutral tempo (seconds per snap
  over neutral drives) is DERIVABLE and highly reliable: split-half 0.87. `style.tempo` uses it.
- **FEATURE_COVERAGE does not mention `qb_hurry`.** It exists in 2009-2013 (~1.5%), is absent in
  2014-2024, and returns in 2025-2026. It is not a pressure history.
- **Window counts differ.** This engine scores all in-scope games (dev n = 5,954, holdout 1,607,
  general MAE 12.799 / 12.323). V2's BACKTEST.md scores a common set that requires V1 / market rows
  (4,984 / 1,534; 12.685 / 12.376). These are different game sets, not a discrepancy.
- **Consistent with V2's red team** ("matchup interactions: RETEST") and with the V2.1 hardening
  (havoc and sack products dropped): re-learning V2.1's own matchup inputs from its residual earns
  λ = 0, and +0.010 MAE unshrunk.
