# Games layer: validation, play context, game performance (methods)

Exact definitions and constants for `v2/weekly/validate.py` (rule `cfb_game_validation_v1`),
`v2/weekly/gamestate.py` (rule `cfb_gamestate_v1`) and `v2/weekly/perf.py` (`cfb_perf_v1`,
artifact `cfb_expected_margin_v1`). Every constant named here is defined once, in the module that
uses it. Everything estimated from data is estimated on the development seasons 2016–2023
(`config.DEV_SEASONS`) only, and frozen in `football/cfb_v2/artifacts/weekly/expected_margin_v1.json`.
All numbers below come from the committed code on the local sportsdataverse files (downloaded
2026-09-27 07:21 UTC). Suite: `python3 -m v2.weekly.tests_games [--fast]`.

## 1. Game validation (`validate.validate_games`)

`validate_games(season, now, source_week=None, pbp=None, sched=None, ref_plays=None)` returns one
row per scheduled game of the season, or of `source_week` (an int is that regular-season week; a
tuple `(season_type, week)` selects a postseason week). `now` is the point in time: it decides
finality and is stamped as `validated_at`. `pbp` and `sched` replace the files (tests).

Columns: the DESIGN contract (`game_id, season, week, status, home_points, away_points, overtime,
periods, pbp_plays, pbp_completeness_score, checks, issues, pbp_score_home, pbp_score_away,
score_reconciles, validated_at, rule_version`) plus `season_type, kickoff_ts, home_id, away_id,
in_scope` (at least one FBS team, the V2 universe), `score_gap, score_method, play_ratio, ref_plays,
check_detail` (the counts behind every check), `sched_status, sched_completed, pbp_completed,
sources_agree, overdue`, and `row_hash` (sha256 of the canonical row without `validated_at`; a
provider correction changes it, a re-run does not). Points are filled only for final games.

### 1.1 Sources inspected

- Schedule `data/sched/cfb_schedules_<S>.parquet` (41 columns). `completed` is a boolean.
  `status` is `STATUS_FINAL` on about 25% of rows and NaN on the rest. It is `STATUS_CANCELED` or
  `STATUS_POSTPONED` for called-off games; 2020 has 65 and 56. The live 2026 file also carries
  `STATUS_IN_PROGRESS` and `STATUS_HALFTIME`. `notes` is free text: bowl names, "SEPT. 3rd GAME
  POSTPONED" (2011; the game was played the next day), "Suspended Sept 3" (2022), "Roanoke College
  wins by forfeit" (2025), "Rescheduled from Jan 1" (the 2024 Sugar Bowl). Called-off games carry
  0–0 scores with `completed=False`. **There is no overtime field.**
- The 2026 schedule snapshot is internally inconsistent. Eleven games are `completed=True` while
  `status` is `STATUS_IN_PROGRESS` or `STATUS_HALFTIME`, and the PBP agrees they are unfinished;
  one example is Miami 52–3 at halftime. The completed flag therefore cannot be trusted alone.
- PBP `data/pbp/play_by_play_<S>.parquet`. Each play has `status_type_completed`; `homeScore` /
  `awayScore` hold the running score after the play. The feed also has `period`,
  `game_play_number` (the provider's play index, which V2 orders by), `sequenceNumber`, `id`,
  `drive.id` and `text_dupe`. There are no separate PAT or end-of-period rows. Removed
  end-of-period rows leave one missing play number per period break.

### 1.2 Finality (first match wins)

1. Provider status `STATUS_CANCELED` gives **CANCELED**. A note containing "forfeit" also gives
   CANCELED, with an issue, because no football was played; a 1–0 forfeit never becomes a margin.
   A note containing "cancel" on an uncompleted game gives CANCELED.
2. Provider status `STATUS_POSTPONED`, or a note containing "postpon" on an uncompleted game,
   gives **POSTPONED**.
3. A kickoff after `now` gives **SCHEDULED**. A result that the file already carries is ignored,
   with an issue; this keeps replays point-in-time.
4. A final claim means (`completed` or status `STATUS_FINAL`) and both scores present. If an
   in-progress provider status (`STATUS_IN_PROGRESS`, `STATUS_HALFTIME`, `STATUS_END_PERIOD`,
   `STATUS_DELAYED`, `STATUS_RAIN_DELAY`, `STATUS_SUSPENDED`, `STATUS_SCHEDULED`) or the PBP's
   `status_type_completed == False` contradicts the claim, the game is **IN_PROGRESS** with
   `sources_agree=False`. Otherwise it is final and goes to the PBP checks (1.3).
5. `completed` without both scores gives **DATA_ERROR**.
6. Otherwise the game is **IN_PROGRESS**, because the kickoff has passed. `overdue=True` once
   `now >= kickoff + GRACE_HOURS` (8 h, since a weather-delayed game runs 6–7 h). The issue reads
   "no final status after the grace period", and this is the flag stage 1 fails on.

Overtime is PBP `period >= 5`. It is null for a final game without PBP.

### 1.3 PBP checks (final games)

Rows flagged `text_dupe`, rows with a repeated play `id`, and malformed rows (null period, play
number or possession) are excluded before the checks. They are counted and reported as issues.
Nothing is imputed. The *scrimmage* plays are `rush | pass`, excluding `penalty_no_play`.

| check | passes when | tolerance | critical |
|---|---|---|---|
| `pbp_present` | at least one usable row | — | yes |
| `team_ids` | every `pos_team_id`/`def_pos_team_id` ∈ {home, away}, and the PBP pair equals the schedule's | exact | yes (fail → DATA_ERROR) |
| `no_duplicate_plays` | no `text_dupe`, no repeated `id`, no repeated `game_play_number` | exact | yes |
| `play_order` | on the rows sorted by `game_play_number`: fewest decreases of either provider sequence key (`sequenceNumber`, `id`; timeouts excluded) ≤ 3; plays whose period is below an earlier play's ≤ 1; missing play numbers beyond one per period break ≤ 3; largest jump ≤ 4 | as stated | yes |
| `quarters_present` | periods 1–4 all present | exact | yes |
| `play_count` | usable rows ≥ 0.75 × national median | 0.75 | yes |
| `score_reconciles` | the rebuilt PBP score equals the schedule score | exact | yes |
| `drive_contiguity` | among scrimmage plays in order, drive ids that re-appear after another drive ≤ 4; scrimmage plays without a drive id ≤ 2 | 4 / 2 | yes |
| `home_away_orientation` | PBP home = schedule home (a swap is re-oriented by team id) | exact | no |
| `down_valid` | scrimmage plays with down outside 1..4 ≤ 2 (down is ignored on kickoffs and PATs, which carry 0, −1 or a stale value) | 2 | no |
| `distance_valid` | scrimmage plays with distance outside 0..99 ≤ 2 | 2 | no |
| `yardline_valid` | rows with `start.yardsToEndzone` or `start.yardLine` outside 0..100, plus scrimmage plays with no yard line, ≤ 2 | 2 | no |
| `overtime_consistent` | OT periods present ⇔ running score tied after the last period-4 play; a final tie without OT fails | exact | no |
| `possession_transitions` | possession changes between consecutive scrimmage plays that share a drive id ≤ 2 | 2 | no |

Why these tolerances. On 2016, 2022, 2024 and 2025, the 99th percentile per final game is at most
3 for sequence inversions, at most 1 for unexplained gaps, 2 for the largest step, 0–1 for period
regressions and at most 2 for possession changes within a drive. Drive re-appearance has a 99th
percentile of about 4.5 on scrimmage plays; 2022 has a scrambled-drive feed in about 70 games,
which fail. The provider carries two sequence keys. Before 2014 `sequenceNumber` is not
chronological: a median of 5 inversions per game, because edited plays get later numbers. There
the play `id` is chronological. Since 2014 it is roughly the reverse. Requiring either key to
agree gives more than 3 inversions in 0 games in every season 2009–2025, and in 2 of 323 games in
2026. Ids are compared as exact integers, since 18-digit ids do not survive a float64 cast.

**Score rebuild.** The home and away running scores are mapped to the schedule's orientation by
team id. There are two candidates: the running score after the chronologically last play (order
`period`, then `game_play_number`), and the maximum running score over the game. The candidate
closer to the final is kept, ties to the last play, and `score_method` records which. The
maximum is needed because the feed sometimes appends a late-corrected early play, or a timeout
row with a stale score, at the end (12 games in 2025).
`score_gap = max(|pbp_home − home_points|, |pbp_away − away_points|)`.

**National median (`ref_plays`).** This is the median usable PBP rows per final game of the
**previous** season, read from disk. It is fixed before the season starts, so a game's
completeness never drifts as weeks are added: 170 for 2024, 172 for 2025, 173 for 2026. With
frames passed in, it is the median of their final games. The fallback is 172 when fewer than 20
final games are available.

### 1.4 Status and completeness

- **DATA_ERROR** covers three cases:
  - `team_ids` fails.
  - The PBP is corrupted: more than 20% malformed rows, or more than 5% duplicate rows.
  - The PBP contradicts the final: `score_gap > 8` (more than one score), unless the PBP is
    truncated (a missing quarter or `play_count` failing) *and* the PBP score is at or below the
    final for both teams. That pattern is incomplete, not contradictory.
- **FINAL_VALIDATED**: every critical check passes.
- **FINAL_PARTIAL_DATA**: any other final game. This includes a final game with no PBP
  (completeness 0), a small reconciliation miss, missing quarters, few plays, broken order or
  drive structure, and duplicates below the corruption bound.

`pbp_completeness_score` (0–1, rounded to 6 decimals) is
0.30·min(1, plays/ref) + 0.15·(share of Q1–Q4 present) + 0.20·(1 if reconciled, else
max(0, 1 − gap/21)) + 0.10·play_order + 0.05·no_duplicate_plays + 0.05·team_ids +
0.05·mean(down_valid, distance_valid, yardline_valid) + 0.05·drive_contiguity +
0.05·possession_transitions.
The weights sum to 1. A final game without PBP scores 0. Truncating a game never raises it
(tested); failing a check always lowers it.

### 1.5 Results (FBS-involved games, `in_scope`)

| season (now) | FINAL_VALIDATED | FINAL_PARTIAL_DATA | DATA_ERROR | CANCELED | POSTPONED | IN_PROGRESS | SCHEDULED |
|---|---|---|---|---|---|---|---|
| 2024 (2025-03-01) | 873 | 45 | 1 | 1 | 0 | 0 | 0 |
| 2025 (2026-03-01) | 903 | 30 | 1 | 0 | 0 | 0 | 0 |
| 2026 (2026-09-27 07:22Z) | 288 | 12 | 0 | 0 | 0 | 31 | 557 |

- 2024 partial games:
  - 18 are final with no PBP.
  - 13 miss reconciliation by a small amount (for example 52–52 vs 52–51 in OT).
  - 10 have broken drive structure.
  - 3 have play-order faults.
  - 2 are truncated (Q4 missing, about 95 plays).
- 2025 partial games:
  - 16 miss reconciliation by a small amount.
  - 10 have broken drive structure.
  - 6 have play-order faults.
  - 2 have no PBP.
- The DATA_ERROR games are genuine feed contradictions:
  - 2024 401635554: the running score jumps from 24–19 to 45–19 on a kickoff; the final is 31–19.
  - 2025 401757301: the running score is scrambled across periods (54–44 vs 34–27).
- The 2024 CANCELED game is the App State–Liberty hurricane cancellation.
- 2026: of the 31 in-progress games, 11 are `completed=True` in the schedule but in progress per
  status and PBP (sources disagree). 15 are overdue at the file time, meaning the snapshot
  predates their finish.
- Mean completeness of final in-scope games: 0.970 (2024), 0.986 (2025), 0.985 (2026).
- Every schedule row, including lower-division games, most of which have no PBP (they are
  FINAL_PARTIAL_DATA):

  | season | FINAL_VALIDATED | FINAL_PARTIAL_DATA | DATA_ERROR | CANCELED | IN_PROGRESS | SCHEDULED |
  |---|---|---|---|---|---|---|
  | 2024 | 916 | 2,882 | 1 | 1 | 1 | — |
  | 2025 | 926 | 2,900 | 3 | 2 | — | — |
  | 2026 | 288 | 988 | 3 | — | 75 | 2,325 |

  The extra DATA_ERROR rows are Division II and III games marked completed without a score; the
  2025 CANCELED rows are two Division III forfeits.
- Across 2009–2023, 93.7–99.2% of final in-scope games validate. 2021 (784 of 887) and 2022 (760 of
  896) are the exceptions: 48 and 39 games with no PBP, plus the scrambled-drive feed.
- Runtime is about 6 s per full season. That includes reading the previous season for
  `ref_plays`.

## 2. Play context (`gamestate.classify`, rule `cfb_gamestate_v1`)

The inputs are the quarter (`period`), the clock (`start.TimeSecsRem`, seconds left in the half,
which equals the game clock in Q4), the margin at the start of the play from the possession side
(`start.pos_score_diff`), possession (`pos_team_id` present), and the play type (`rush`, `pass`,
`kneel_down`). The classifier never reads win probability. Precedence runs
GARBAGE > CLOCK_KILL > DESPERATION > LOW_LEVERAGE > COMPETITIVE.

- **GARBAGE**: exactly V2's production rule, `common.garbage_mask(period.fillna(1),
  start.pos_score_diff.fillna(0))`, which fires when |margin| > 38 in Q2, > 28 in Q3 or > 22 in Q4.
  It never fires in Q1 or overtime. This is the only class with a production weight (0); every
  other class weighs 1, as in V2. On every 2025 play it is identical to the mask, and per team-game
  it reproduces stage1's `garbage_plays`.
- **CLOCK_KILL**: any kneel-down, or a Q4 rush (not a pass) with ≤ 240 s left by an offense that
  leads by 1 or more.
- **DESPERATION**: in Q4 the offense trails, and either ≤ 120 s remain or ≤ 300 s remain with a
  deficit of at least 9 (more than one score).
- **LOW_LEVERAGE**: periods 1–4 with |margin| ≥ 17, a three-score game. The threshold is 17
  because two touchdowns with two 2-point conversions make 16.
- **COMPETITIVE**: everything else, including all overtime plays.

Class shares of scrimmage plays:

| season | COMPETITIVE | LOW_LEVERAGE | GARBAGE | CLOCK_KILL | DESPERATION | n |
|---|---|---|---|---|---|---|
| 2016 | .714 | .142 | .102 | .018 | .025 | 121,819 |
| 2017 | .723 | .137 | .097 | .018 | .025 | 121,494 |
| 2018 | .708 | .145 | .107 | .017 | .024 | 123,706 |
| 2019 | .706 | .144 | .108 | .018 | .024 | 122,449 |
| 2020 | .730 | .135 | .089 | .018 | .028 | 78,749 |
| 2021 | .728 | .131 | .096 | .018 | .027 | 113,962 |
| 2022 | .726 | .134 | .092 | .019 | .029 | 115,800 |
| 2023 | .725 | .135 | .092 | .021 | .028 | 118,461 |
| 2024 | .719 | .130 | .095 | .023 | .034 | 123,988 |
| 2025 | .710 | .132 | .104 | .022 | .032 | 126,095 |
| 2026 (wk 1–4) | .630 | .167 | .161 | .017 | .025 | 39,753 |

Evidence on dev seasons (2016–2023, scrimmage plays):

| class | n | EPA/play | success | pass rate |
|---|---|---|---|---|
| COMPETITIVE | 659,094 | .050 | .443 | .489 |
| LOW_LEVERAGE | 126,500 | .055 | .438 | .509 |
| GARBAGE | 90,077 | .045 | .434 | .414 |
| CLOCK_KILL | 16,767 | −.079 | .326 | .000 |
| DESPERATION | 24,002 | .033 | .446 | .799 |

Pooled means hide the point, which is who has the ball. Leading minus trailing offense:

| class | EPA/play, leading minus trailing | pass rate: leading, trailing |
|---|---|---|
| COMPETITIVE | +.034 | .457, .519 |
| LOW_LEVERAGE | +.117 | .439, .564 |
| GARBAGE | +.113 | .288, .519 |

The 17-point line comes from Q2–Q4 non-garbage plays grouped by |margin|. The leading-minus-trailing
EPA gap is +.033 at 1–8 and +.036 at 9–16, then jumps to +.093 at 17–22 and +.128 at 23–28. The
trailing team's pass-rate excess grows from .054 to .114 to .158. Beyond two possessions the plays
reflect a mismatch and a changed plan, not the average contest. CLOCK_KILL plays are
low-efficiency by construction: EPA −.08 and success .32. DESPERATION plays are 80% passes.
The classes are descriptive; production weights stay V2's.

## 3. Game performance (`perf`)

### 3.1 Rows and definitions

`game_performance(season, T=None, validation=None)` returns one row per team-game. It covers
every final game (1.2) with at least one FBS team, the V2 universe. Two rows with the same pair
of teams on the same calendar day are treated as one game, keeping the lower id (games.py's
rule). With `T`, the frame keeps only games that kicked off strictly before `T` and that were
final at `T`.

A game without PBP keeps its row with null play metrics: `has_pbp=False`, `null_reason='no_pbp'`.
A rate whose denominator is 0 is null. Seasons are recomputed from the PBP each time (cached per
process; `perf.clear_cache()`). The filtered sums equal `out/stage1/team_game_<S>.parquet`
exactly, which is tested on 2024 and 2025. That is, stage1's aggregation is reused as the
definition without depending on a possibly stale file.

- **Filtered** (`off_<m>`, `def_<m>`): V2's definitions. These are scrimmage plays (`rush | pass`,
  not `penalty_no_play`, EPA present) after V2's cleaning, with garbage weight 0. The drive table
  is V2's:
  - The team is the mode of the offense.
  - A drive's start and garbage flag come from its first scrimmage play.
  - It keeps starts of 1–99 yards to go.
  - Points are 7 for TD / PASSING TD / RUSHING TD and 3 for FG / FG GOOD / FIELD GOAL.
  - A scoring opportunity is a drive that reaches the 40 or closer.
- **Raw** (`off_<m>_raw`, `def_<m>_raw`): the same formulas with every play and drive weighted 1.
- **Defense** (`def_*`): the opponent offense's value in the same game, meaning what this
  defense allowed. For havoc and sacks this is what the defense made.
- **Rate metrics** (numerator / denominator):

  | metric | numerator / denominator |
  |---|---|
  | `epa_pp` | EPA / plays |
  | `epa_pass` | EPA / dropbacks |
  | `epa_rush` | EPA / rushes |
  | `sr` | successes / plays |
  | `sr_pass` | successes / dropbacks |
  | `sr_rush` | successes / rushes |
  | `sr_early` | early-down successes / early-down plays |
  | `sr_pd` | passing-down successes / passing-down plays |
  | `expl_rate` | explosive plays / plays (provider flag: pass EPA ≥ 2.4, rush EPA ≥ 1.8) |
  | `expl_epa_share` | EPA on explosive plays / Σ max(EPA, 0) |
  | `havoc_rate` | (sacks ∪ rush TFL) / plays; "allowed" on the offense row |
  | `sack_rate` | sacks / dropbacks |
  | `line_yds_pr` | line yards / rushes (−1.2× losses, 0–4 yds ×1, 5–10 yds ×0.5) |
  | `stuff_rate` | rushes ≤ 0 yds / rushes |
  | `so_rate` | scoring opportunities / drives |
  | `pts_per_opp` | points on opportunity drives / opportunities |
  | `drive_epa` | drive EPA / drives |
  | `ppd` | points / drives |
  | `start_fp` | mean start, yards to the end zone (lower is better) |

- **Counts**: `off_scoring_opps`, `off_n_plays`, `off_n_drives` (plus raw forms); pace is
  `pace_plays` (all scrimmage plays) and `pace_drives` (all drives).
- **Special teams**: V2's definitions, never garbage-filtered. `st_net_epa` is own
  special-teams EPA minus the opponent's. `fg_epa` is own field-goal-attempt EPA, with `n_fg`.
  `punt_net_epa` covers punting (own minus opponent), and `kick_net_epa` covers kickoffs and
  returns.
- **Expected performance margin**: `expected_performance_margin` and `scoreboard_overperformance`
  (= team margin − expected), from the team's side (3.3), with `expected_margin_null_reason`.
- **Turnovers** (3.4): `ints_thrown`, `ints_made`, `fumbles`, `fumbles_lost`, `fumbles_recovered`
  (own), `opp_fumbles`, `opp_fumbles_recovered`, `forced_fumbles`, `giveaways`, `takeaways`,
  `turnover_margin`, `turnover_epa` and `takeaway_epa`. `return_tds` counts defensive and return
  touchdowns: `defense_score_play` touchdowns by this team, plus kickoff-return TDs. The row also
  has `dropbacks` and the per-game luck `turnover_luck_game`.
- **Explosive** (3.5): `explosive_opportunity`, `explosive_execution`, `explosive_dependency_raw`
  and `explosive_dependency_score`.
- **Drives, non-garbage** (3.6): `drive_n` and `drive_<m>`.
- **Identity**: `validation_status` and `pbp_completeness_score` when a validation frame is passed,
  plus `perf_version`, `artifact_sha256`, `perf_id = 'cfbp_' + h(game_id, team_id, perf_version)`
  and `as_of`.

Runtime is about 1–2 s per season, and `team_summary` takes 0.1 s.

### 3.2 `team_summary(season, T, perf=None)`

This returns one row per team over the games that kicked off before `T`.

- Results:
  - `games`, `wins`, `losses`, `record`.
  - `scoreboard_margin`, the mean margin per game.
  - `performance_margin`, the mean expected performance margin.
  - `overperformance`.
  - `close_games`, `close_wins`, `close_losses` and `close_game_record`, for games decided by
    ≤ 8 points.
- Turnovers: the season-to-date components and `turnover_luck_index` (3.4), with
  `turnover_luck_pg`.
- Explosive: `explosive_opportunity`, `explosive_execution`, `explosive_dependency_raw` and
  `explosive_dependency_score`.
- Drives: `drive_<m>` for the season, `drive_<m>_rec` recency-weighted, and the `def_drive_*`
  mirrors.
- Special teams: `*_total` and `*_pg` for `st_net_epa`, `fg_epa`, `punt_net_epa` and
  `kick_net_epa`.

Season sums use the team's games with PBP (`games_with_pbp`); record and margins use every final
game.

### 3.3 Expected performance margin (artifact `cfb_expected_margin_v1`)

The model is an OLS with an intercept. The target is the final home margin (home − away points).
It is fitted on dev-season games (2016–2023) that are final, in scope and **FINAL_VALIDATED**, and
that have every feature finite. The features are non-garbage, home minus away, from the same
game. Since the away offense's value is what home's defense allowed, each feature is home offense
minus home defense allowed.

| feature | definition | coefficient |
|---|---|---|
| intercept | | +1.003 |
| `em_epa` | EPA/play | +21.69 |
| `em_sr` | success rate | +4.344 |
| `em_drive_epa` | drive efficiency, EPA per drive | +4.690 |
| `em_so_rate` | scoring opportunities per drive | +2.510 |
| `em_start_fp` | mean start, yards to the end zone | −0.353 |
| `em_havoc` | havoc suffered by the offense | +0.925 |
| `em_expl` | explosive plays per play | −13.27 |

- Fit: n = 6,431 games, R² = 0.8556, residual SD = 8.51, MAE = 6.46.
- `em_expl` is negative conditional on EPA: explosive EPA is already counted, and it is the
  less repeatable part.
- Points per drive is deliberately **not** a feature. It is the scoreboard itself, and the gap
  between the scoreboard and the underlying play is what `scoreboard_overperformance` is meant to
  measure.
- 2013 is null because its sacks are untagged, so havoc is missing
  (`feature_missing:em_havoc`). 2013 is a burn-in season only.

Out of sample, on FINAL_VALIDATED games, with the slope of actual on expected (OLS with an
intercept):

| season | n | slope | intercept | MAE | resid SD | R² |
|---|---|---|---|---|---|---|
| 2024 | 873 | 0.980 | +0.27 | 5.94 | 7.74 | 0.876 |
| 2025 | 903 | 0.931 | +0.69 | 6.52 | 8.58 | 0.853 |
| pooled | 1,776 | 0.954 | +0.48 | 6.24 | 8.17 | 0.864 |

The artifact also records:
- the feature list and definitions;
- the training seasons, and the sha256 of each training PBP and schedule file;
- the dev-estimated constants (3.4, 3.5);
- `sha256`, the canonical-JSON hash of the rest (`ids.content_hash`). Coefficients are rounded to
  12 significant digits, so the hash is stable across BLAS builds.

`load_expected_margin()` verifies the hash and refuses a tampered file. `fit_expected_margin()`
refuses any holdout or live season (`config.assert_dev_only`). Refitting reproduces the committed
hash exactly (tested). Current sha256:
`8bf9a71f3fd536b9f869046b2ebb8119d72a2ffbf5b0a3826e4f267b10523b36`.

### 3.4 Turnover luck

- **Fumbles** are counted on all plays not nullified by a penalty, attributed to the fumbling
  team (`fumbling_team`, falling back to the possession team).
- **Lost** means the provider's `fumble_lost` flag, or a play type of "Fumble Return Touchdown" or
  "Fumble Recovery (Opponent) Touchdown". The provider flags those two types as recovered: 65
  plays in 2024.
- **Interceptions**: the `int` flag, charged to the offense.
- **Forced fumbles**: the provider's `forced_fumble` flag, which is sparse in some seasons.
- **Turnover EPA**: EPA on scrimmage giveaway plays (an INT, or a lost fumble by the offense).

Dev constants (2016–2023, FBS-involved games):

- **League fumble-lost share**: `fumble_lost_share = 0.5175`, from 7,781 lost of 15,036 fumbles.
- **League INT rate**: `int_rate_per_dropback = 0.02489`.
- **INT shrinkage**: `int_shrinkage_k = 1,209` dropbacks, estimated by method of moments over FBS
  team-seasons. The true team INT-rate SD is 0.45 percentage points and binomial noise is
  subtracted; k = r(1−r)/τ². A 400-dropback season therefore puts only 25% weight on its own INT
  rate.
- **Points per turnover**: `points_per_turnover = 4.157`, the mean |EPA| over 17,418 scrimmage
  giveaway plays.

Season to date, as of T:

- E[fumbles lost] = own fumbles × 0.5175.
- E[opponent fumbles recovered] = opponent fumbles × 0.5175.
- E[INT thrown] = dropbacks × (INT + k·r) / (dropbacks + k).
- E[INT made] = opponent dropbacks × (INT made + k·r) / (opponent dropbacks + k).
- `turnover_luck_index` = ((takeaways − giveaways) − (E[takeaways] − E[giveaways])) × 4.157
  points. It splits into `fumble_luck` and `int_luck`, and is positive when a team was lucky.
- The per-game `turnover_luck_game` uses the league INT rate (k → ∞).

Why fumble recoveries regress. Split-half (odd vs even games) correlation across about 1,020 FBS
team-seasons, 2016–2023:

| metric | split-half r |
|---|---|
| own fumble recovery rate | **0.017** |
| defensive fumble recovery rate | **−0.018** |
| all fumbles recovered | 0.020 |
| fumbles per scrimmage play | 0.306 |
| INT rate per dropback, offense | 0.177 |
| INT rate per dropback, defense | 0.121 |
| EPA per play (reference) | 0.546 |

Recovering a fumble has no persistence, so only the number of fumbles is kept as skill. INT rate
persists weakly, hence the strong shrinkage.

### 3.5 Explosive dependency

- **Explosive opportunity**: explosive plays per play (non-garbage).
- **Explosive execution**: EPA per explosive play.
- **`explosive_dependency_raw`**: Σ EPA on explosive plays / Σ max(EPA, 0), the share of a team's
  positive EPA that came from explosive plays.
- **`explosive_dependency_score`**: (n·raw + k·L) / (n + k), where n is the non-garbage plays in
  the sample. The league share is L = 0.4511 (dev).
- **k = 644 plays**. It comes from the dev split-half reliability: r = 0.250 at a median of 215
  plays per half, and k = n_half·(1 − r)/r. A 5-play sample therefore stays within 0.01 of L
  (tested).

Honest test. Does a higher pre-game dependency predict a larger next-game residual? The sample is
dev seasons 2016–2023: 9,521 team-games with at least 3 prior games. The dependency is taken
point-in-time, from games before the freeze. The residual is the final margin minus V2's
walk-forward pregame prediction (`ens_pred` in `out/stage7/backtest_predictions.parquet`), from
the team's side.

- Spearman correlation of dependency with |residual|: −0.010.
- Regressing the squared residual on standardized dependency, controlling for |predicted
  margin|: slope +3.1 points² per SD, t = 0.78.
- Residual RMSE by dependency tercile: 16.29 (low), 15.71 (mid), 16.28 (high).
- Brown–Forsythe p = 0.12.

**There is no evidence that explosive dependency predicts next-game volatility.** The score is
kept as a descriptive team trait and must not be fed into uncertainty without new evidence.

### 3.6 Drive metrics

All drive metrics are non-garbage, from V2's drive table:

- `drive_n`: drives.
- `ppd`: points per drive.
- `xp_start`, the **expected points per drive**: the provider EP model's expected points at the
  drive's first scrimmage play (`EP_start`), averaged over drives. This is what the starting field
  position was worth.
- `so_rate`: drives reaching the 40.
- `td_rate` and `fg_rate`, using V2's result mapping.
- `three_out_rate`: drives with ≤ 3 scrimmage plays that end in a punt.
- `start_fp`: mean start, yards to the end zone.
- `value`, the **average drive value**: EPA per drive, which is V2's `drive_epa`.

Each metric comes in a season-to-date form (Σ numerator / Σ denominator over games before T) and a
recency form (`_rec`). The recency form weights each game 0.5^(age/8), where age is weeks from
kickoff to T and 8 is `config.RECENT_HALFLIFE_WEEKS`; this is the ratings code's weighting.
Defensive mirrors are `def_drive_*`.
