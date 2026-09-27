# CFB Live Model Lab — data contract

Every record the Model Lab keeps, in both of its stores:

- **the repository ledger** (`football/cfb_lab/ledger/<season>/…`, JSON Lines, append-only, committed by the
  `CFB Model Lab` workflow; this is what the static pages and the tests read), and
- **Postgres / Supabase** (`supabase/cfb_lab.sql`, tables prefixed `cfb_lab_`, filled insert-only by
  `football/cfb_lab/sync_supabase.js`).

The same column names are used in both. Metric definitions are in [`METRICS.md`](METRICS.md); the
operational workflow is in [`RUNBOOK.md`](RUNBOOK.md).

## Rules that apply to every table

1. **Append-only.** A row is never updated and never deleted. Postgres enforces it with `BEFORE UPDATE`,
   `BEFORE DELETE` and `BEFORE TRUNCATE` triggers that raise (the service role included). The repository
   enforces it with `ledger.js verify`, which fails when any committed line changed or disappeared.
2. **Corrections are new rows.** Where a fact can be corrected (a final score, a miss classification, an
   experiment's status, a model's role), the table carries `supersedes` (the id of the row it replaces) and
   the current value is the newest row of its chain. The old row stays.
3. **Evaluation is separate from prediction.** Nothing learned after a snapshot is ever written into the
   snapshot. Settlement and grading live in `cfb_lab_results` and `cfb_lab_evaluations`.
4. **Ids are deterministic.** Each id is a prefix plus the first 24 hex characters of the SHA-256 of the
   fields listed with it, rendered and joined with `|`, so the same fact always gets the same id (in
   Node, in Postgres and in the Deno capture function alike) and a duplicate insert is a no-op
   (`on conflict do nothing`). Rendering: null → empty string; timestamp → UTC
   `YYYY-MM-DDTHH:MM:SS.sssZ` (milliseconds, `Z`); number → shortest decimal without trailing zeros
   (`-3.5`, `110`, `0`); boolean → `true`/`false`; text as is. `h(a, b, c)` below means that hash.
   `fingerprint` (quotes) = `h(home_line, total_points, price_home, price_away, price_over, price_under)`.
5. **Signs.** `*_home_line` columns are book convention (negative = home favoured). `*_margin` columns
   are home margin (positive = home). The only conversion is `margin = -home_line`, done once.
6. **Times** are `timestamptz` in Postgres and ISO-8601 UTC strings (`…Z`) in the ledger.

## Enumerations

| name | values |
|---|---|
| origin | `LIVE` (taken by the lab before kickoff) · `GIT_RECONSTRUCTED` (a model's published number recovered from git history; never official) · `REPLAY` (a model run over past weeks; never official) |
| checkpoint_type | `OPEN` · `T72` · `T48` · `T24` · `T12` · `T6` · `T2` · `FINAL` · `WEEKLY_FREEZE` · `ADHOC` |
| model role | `champion` · `challenger` · `candidate` · `retired` |
| status (engine) | `BET` · `LEAN` · `REVIEW` · `PASS` · `NOT_PRICED` |
| decision_class | `BET` · `LEAN` · `RESEARCH` · `PASS` |
| side | `HOME` · `AWAY` · null |
| data_quality_status | `GREEN` · `YELLOW` · `RED` |
| result status | `FINAL` · `POSTPONED` · `CANCELED` · `NO_CONTEST` |
| ats result | `WIN` · `LOSS` · `PUSH` · `VOID` · null |
| miss classification | `MODEL_FAILURE` · `DATA_FAILURE` · `INFORMATION_CHANGE` · `HIGH_VARIANCE_OUTCOME` · `UNKNOWN` |
| quote source | `espn` · `cfbd` · `odds_api` · `record` |
| market_type | `spread` · `total` · `moneyline` |

## 1. `cfb_lab_predictions` — the live prediction ledger

One row per model per game per checkpoint. Ledger file: `ledger/<season>/predictions/week_<NN>.jsonl`.
Id: `prediction_id = 'cfbp_' + h(model_version, game_id, checkpoint_type, prediction_ts)`.
Unique `(game_id, model_version, checkpoint_type, origin)` except `checkpoint_type = 'ADHOC'`: reconstructed or replayed history never occupies a LIVE checkpoint.

| column | type | notes |
|---|---|---|
| prediction_id | text PK | |
| ledger_version | text not null | `cfb_lab_ledger_v1` |
| origin | text not null | enum origin |
| game_id | text not null | ESPN event id (the id the FBS slate uses) |
| season | int not null | |
| week | int not null | |
| season_type | text | `regular` / `postseason` |
| home_team, away_team | text not null | |
| home_id, away_id | text | |
| neutral_site | boolean | |
| kickoff_ts | timestamptz not null | |
| prediction_ts | timestamptz not null | when the lab took the snapshot; must be `< kickoff_ts` |
| hours_to_kickoff | numeric(8,3) not null | `(kickoff_ts - prediction_ts)` in hours, > 0 |
| checkpoint_type | text not null | enum |
| is_first_snapshot | boolean not null | the first snapshot of this model for this game (EARLY_MODEL) |
| official_families | text[] not null | subset of `EARLY_MODEL`, `MIDWEEK_MODEL`, `OFFICIAL`, `FINAL_MODEL` |
| projection_computed_at | timestamptz | when the model produced the numbers (board build time, pipeline run time) |
| feature_ts | timestamptz | the data cutoff of the model's inputs |
| model_version | text not null | |
| model_label | text | e.g. `V1`, `V2 · candidate 001`, `V2.1 · hardened` |
| model_role | text not null | role at snapshot time (from `cfb_lab_model_roles`) |
| feature_version, calibration_version, ensemble_version | text | |
| engine_id | text | |
| params_hash | text | SHA-256 of the model's parameter file at snapshot time |
| pure_home_margin | numeric(7,3) not null | |
| fair_spread_home_line | numeric(7,3) not null | must equal `-pure_home_margin` |
| fair_spread_display | text | `ALA -7.5` |
| projected_home_points, projected_away_points, projected_total | numeric(6,2) | |
| home_win_probability, away_win_probability | numeric(6,5) | in (0,1), sum to 1 |
| prediction_sigma | numeric(7,3) | > 0 when present |
| t_df | numeric(6,2) | |
| interval_50_low … interval_95_high | numeric(7,2) | six columns; low ≤ high, nested 50 ⊂ 80 ⊂ 95 |
| football_confidence | int | 0–100, after the data-quality cap |
| football_confidence_raw | int | 0–100, as the model produced it |
| internal_consensus_score | int | 0–100 (METRICS §State) |
| ensemble_disagreement | numeric(6,3) | SD across active components |
| expected_model_error | numeric(6,3) | expected absolute margin error (METRICS §State) |
| qb_certainty, injury_certainty | int | 0–100 |
| data_completeness, pbp_completeness | numeric(5,4) | 0–1 |
| data_quality_status | text not null | GREEN / YELLOW / RED |
| data_quality_issues | jsonb not null | array of `{check, status, detail}` |
| efficiency_margin, bayesian_margin, drive_margin, dynamic_rating_margin, matchup_ml_margin, residual_adjusted_margin | numeric(7,3) | submodel outputs (METRICS §Submodels maps each to its component) |
| components | jsonb | every raw component the model exposes |
| market_as_of | timestamptz | newest quote used |
| market_sources | text[] | |
| opening_spread | numeric(6,2) | consensus opener as known at snapshot time (home line) |
| opening_market_ts | timestamptz | |
| opening_quality | text | `OBSERVED` / `PROVIDER_DECLARED` |
| current_spread | numeric(6,2) | consensus current home line |
| best_available_spread_home, best_available_spread_away | numeric(6,2) | best number for each side, in that side's own convention |
| best_price_home, best_price_away | int | American odds at the best number |
| consensus_spread | numeric(6,2) | = current_spread (named for the brief) |
| consensus_price_home, consensus_price_away | int | median prices |
| market_dispersion | numeric(6,3) | IQR of books' home lines |
| sportsbook_count | int | |
| line_move_from_open | numeric(6,2) | in home-margin points (positive = toward home) |
| market_total | numeric(6,2) | |
| market_stale | boolean | |
| model_market_gap | numeric(7,3) | `pure_home_margin - (-current_spread)`; positive = the model likes home |
| cover_probability | numeric(6,5) | for `side` |
| break_even_probability | numeric(6,5) | |
| estimated_ev | numeric(7,4) | per unit |
| edge_quality | int | 0–100 |
| betting_reliability | int | 0–100 |
| status | text not null | engine status |
| decision_class | text not null | BET / LEAN / RESEARCH / PASS |
| decision_source | text not null | `engine:<id>` or `lab_rule:<id>` |
| side | text | HOME / AWAY |
| recommended_line | numeric(6,2) | the number for `side`, in that side's own convention (`-3.5`, `+3.5`) |
| recommended_price | int | American odds; null when none was captured |
| stake_units | numeric(5,2) not null | 0 unless BET is enabled |
| bet_enabled | boolean not null | |
| decision_reason, pass_reason | text | |
| threshold_distance | jsonb | distance to each BET/LEAN threshold (METRICS §Near miss) |
| near_miss | boolean not null | |
| primary_edge, secondary_edge, primary_uncertainty, disagreement_summary | text | |
| inputs_ref | jsonb not null | what the snapshot read: file hashes, build times, quote ids |
| row_hash | text not null | SHA-256 of the canonical row without `row_hash` |
| recorded_at | timestamptz not null default now() | Postgres only: when the row reached the database |

## 2. `cfb_lab_market_quotes` — market history

One row per observed change (plus heartbeats) per source, book, game and market.
Ledger file: `ledger/<season>/quotes/week_<NN>.jsonl`.
Id: `quote_id = 'cfbq_' + h(source, book, game_id or provider_event_id, market_type, observed_at)` for an
ordinary quote; a provider-declared row appends a sixth part, `h(…, observed_at, 'provider_open')` when
`is_provider_open` and `h(…, observed_at, 'provider_close')` when `is_provider_close`, so a declared number
and an ordinary quote read in the same fetch are two rows. `cfb_lab_ingest_quotes` always computes the id
and the fingerprint itself.

| column | type | notes |
|---|---|---|
| quote_id | text PK | |
| game_id | text | resolved EdgeDesk game id; null until resolved (odds_api rows before mapping) |
| season, week | int | |
| source | text not null | enum quote source |
| provider_event_id | text | the provider's id for the event |
| book | text not null | the sportsbook key (`draftkings`, `consensus` for a provider's average) |
| market_type | text not null | spread / total / moneyline |
| home_line | numeric(6,2) | spread: home line (book convention); null otherwise |
| total_points | numeric(6,2) | total only |
| price_home, price_away | int | spread and moneyline: American odds per side |
| price_over, price_under | int | total only |
| observed_at | timestamptz not null | when EdgeDesk saw it (must be `< kickoff_ts` for a pregame quote) |
| provider_updated_at | timestamptz | the provider's own timestamp when it sends one |
| kickoff_ts | timestamptz | |
| is_heartbeat | boolean not null | an unchanged value re-recorded by the heartbeat rule |
| is_provider_open | boolean not null | the provider's declared opening number (no observation time of its own) |
| is_provider_close | boolean not null | the provider's declared closing number (e.g. ESPN's line frozen at kickoff), recorded after kickoff |
| is_pregame | boolean not null | the quote was observed before kickoff from a pregame market (never live / in-play odds); false only for `is_provider_close` rows |
| home_team, away_team | text | the provider's own names (odds_api rows are resolved to `game_id` through `cfb_lab_event_map`) |
| fingerprint | text not null | hash of the values; the dedupe key with (source, book, game, market) |
| retrieved_at | timestamptz not null | |

## 3. `cfb_lab_market_lines` — openers and closes

Write-once derived lines. Ledger file: `ledger/<season>/lines.jsonl`.
Id: `line_id = 'cfbl_' + h(game_id, kind, book, market_type, rule_version)`.

| column | type | notes |
|---|---|---|
| line_id | text PK | |
| game_id | text not null | |
| kind | text not null | `OPEN` / `CLOSE` |
| book | text not null | a book key, or `CONSENSUS` |
| market_type | text not null | |
| home_line, total_points | numeric(6,2) | |
| price_home, price_away | int | |
| observed_at | timestamptz | the quote time the value comes from (consensus: see METRICS) |
| n_books | int | books behind a CONSENSUS line |
| quality | text not null | `OBSERVED` / `PROVIDER_DECLARED` / `MISSING` |
| best_line_home, best_line_away | numeric(6,2) | CONSENSUS only: the best number each side could get, each in its own convention (home: `max(home_line)`; away: `-min(home_line)`) |
| rule_version | text not null | `cfb_lab_open_v1` / `cfb_lab_close_v1` |
| quote_ids | text[] | the quotes it was derived from |
| derived_at | timestamptz not null | after kickoff for CLOSE |

## 3b. `cfb_lab_event_map` — provider event → EdgeDesk game

Append-only. Id: `map_id = 'cfbx_' + h(source, provider_event_id, game_id)`. Columns: `map_id`, `source`,
`provider_event_id`, `game_id`, `method` (`exact_id` / `teams_and_kickoff`), `confidence` (0–1),
`created_at`, `supersedes`. The newest row per `(source, provider_event_id)` wins.

## 4. `cfb_lab_results` — settlement facts

Ledger file: `ledger/<season>/results.jsonl`. Id: `result_id = 'cfbr_' + h(game_id, status, home_points, away_points, supersedes)`.

| column | type | notes |
|---|---|---|
| result_id | text PK | |
| game_id | text not null | |
| season, week | int | |
| status | text not null | FINAL / POSTPONED / CANCELED / NO_CONTEST |
| home_points, away_points | int | FINAL only |
| final_margin, final_total | int | derived |
| overtime | boolean | null when the source does not say |
| sources | jsonb not null | each source's reading |
| sources_agree | boolean not null | a FINAL is written only when every source that has the game agrees |
| recorded_at | timestamptz not null | |
| supersedes | text | a corrected result replaces an earlier `result_id` |
| reason | text | |

## 5. `cfb_lab_evaluations` — grading of each snapshot

Append-only; a new `eval_version` or a corrected result adds rows. Ledger file: `ledger/<season>/evaluations.jsonl`.
Id: `evaluation_id = 'cfbe_' + h(prediction_id, eval_version, result_id, close_line_id)`.

Groups of columns (every one defined in METRICS.md):

- identity: `evaluation_id`, `prediction_id`, `eval_version`, `result_id`, `evaluated_at`, `game_id`,
  `model_version`, `checkpoint_type`, `origin`, `official` (boolean: the snapshot is the OFFICIAL one).
- outcome: `result_status`, `final_home_points`, `final_away_points`, `final_margin`, `final_total`, `overtime`, `void` (boolean).
- error: `margin_error`, `abs_margin_error`, `squared_margin_error`, `home_points_error`,
  `away_points_error`, `total_error`, `winner_correct`.
- probability: `brier_win`, `log_loss_win`, `p_home`, `home_won`.
- intervals: `in_interval_50`, `in_interval_80`, `in_interval_95`.
- market accuracy: `open_home_line`, `open_quality`, `close_home_line`, `close_quality`, `close_line_id`,
  `close_books`, `open_abs_error`, `close_abs_error`, `edgedesk_beat_open`, `edgedesk_beat_close`,
  `error_diff_vs_open`, `error_diff_vs_close`.
- discovery: `edge_vs_open`, `market_move_points`, `market_move_toward_model`, `move_since_snapshot`.
- decision grading: `decision_class`, `side`, `graded_line`, `graded_price`, `price_assumed`,
  `ats_result`, `ats_result_at_close`, `units`, `stake_units`, `hypothetical_units`,
  `cover_probability`, `covered` (boolean), `brier_cover`, `clv_points`, `clv_price`, `positive_clv`,
  `process_quality` (`GOOD` / `POOR` / `UNKNOWN`), `outcome_quadrant`.

## 6. `cfb_lab_miss_reviews`

Ledger file: `ledger/<season>/miss_reviews.jsonl`. Id: `review_id = 'cfbm_' + h(prediction_id, classification, classified_by, supersedes)`.
Columns: `review_id`, `prediction_id`, `game_id`, `model_version`, `severity` (10 / 14 / 21 point threshold crossed),
`predicted_margin`, `actual_margin`, `market_close_home_line`, `abs_error`, `close_abs_error`, `evidence` jsonb
(components, drivers, QB and availability at snapshot, post-game luck factors when available, market moves),
`classification`, `classified_by` (`auto:<rule_version>` or a person), `rationale`, `created_at`, `supersedes`.

## 7. Governance tables

| table | ledger file | columns |
|---|---|---|
| `cfb_lab_model_roles` | `governance/model_roles.jsonl` | `event_id`, `model_version`, `model_label`, `role`, `effective_at`, `reason`, `evidence_ref`, `actor`, `supersedes` |
| `cfb_lab_experiments` | `governance/experiments.jsonl` | `event_id`, `experiment_id`, `event` (`CREATED` / `STATUS` / `RESULT`), `experiment_name`, `baseline_model`, `challenger_model`, `hypothesis`, `change`, `scope` (`SINGLE_CHANGE` / `BUNDLE` / `ARCHITECTURE`), `start_date`, `evaluation_window`, `metrics` jsonb, `status`, `result` jsonb, `actor`, `created_at` |
| `cfb_lab_audit_log` | `governance/audit_log.jsonl` | `event_id`, `event_type` (`MODEL_REGISTERED`, `MODEL_PROMOTED`, `MODEL_RETIRED`, `ROLE_CHANGED`, `CALIBRATION_CHANGED`, `THRESHOLD_CHANGED`, `FEATURE_VERSION_CHANGED`, `DATA_SOURCE_CHANGED`, `PARTITION_RELEASED`, `EXPERIMENT_CREATED`, `EXPERIMENT_STATUS`, `RULE_CHANGED`), `subject`, `before` jsonb, `after` jsonb, `reason`, `actor`, `created_at` |
| `cfb_lab_partitions` | `governance/partitions.jsonl` | `event_id`, `pool` (`live_observation_pool` / `development_pool` / `future_holdout_pool`), `season`, `week_from`, `week_to`, `origin_scope`, `effective_at`, `reason`, `actor` |
| `cfb_lab_research_queue` | `governance/research_queue.jsonl` | `event_id`, `item_key`, `event` (`OPENED` / `EVIDENCE` / `CLOSED`), `title`, `evidence` jsonb, `n`, `effect`, `effect_se`, `created_at` |
| `cfb_lab_reports` | `reports/<season>/*.json` | `report_id`, `kind` (`weekly` / `season` / `promotion`), `season`, `week`, `generated_at`, `body` jsonb |

Views (Postgres): `cfb_lab_current_roles`, `cfb_lab_official_predictions`, `cfb_lab_current_results`,
`cfb_lab_current_evaluations`, `cfb_lab_public_record` (the only object `anon` can read), `cfb_lab_consensus_now`.
