# CFB Live Model Lab — architecture

The Model Lab is EdgeDesk's permanent record of what its college football models said, when they said
it, what the market said at that moment, and what happened afterwards. It exists so that no one —
including us — can re-tell the record after the fact.

- Definitions of every number: [`METRICS.md`](METRICS.md)
- Every table and column: [`SCHEMA.md`](SCHEMA.md)
- How to operate it: [`RUNBOOK.md`](RUNBOOK.md)

## Principles

1. **Immutability.** A snapshot is never edited. A recalculated projection is a new snapshot. A correction
   (a final score, a miss classification, a role) is a new row that supersedes the old one, and the old row
   stays. The repository enforces it (`ledger.js verify --base`), Postgres enforces it (write-once
   triggers), and the tests enforce it.
2. **Point in time.** A snapshot records only what was knowable at its own timestamp: the model output
   of that run, and the market as the lab had observed it by then. Settlement and grading live in
   separate tables and are never written into the snapshot.
3. **No fabrication.** A checkpoint window that was missed stays missed. A closing line that was never
   observed is `MISSING`, not interpolated. A bet price that was never captured is graded at an assumed
   −110 and flagged (`price_assumed`).
4. **Measurement, not action.** Nothing the lab computes changes a model. Drift alerts, recalibration
   flags, promotion eligibility and research items are reports; changing the champion is a governed,
   audited human act (`governance.js promote`).
5. **Prediction quality first.** Accuracy and calibration decide promotion. ROI and CLV are reported
   beside them and never gate anything.

## The two stores

```
                      ┌──────────────────────────── repository (source of truth) ────────────────────────────┐
  ESPN scoreboard ──┐ │ football/cfb_lab/ledger/<season>/                                                   │
  CFBD ledger ──────┼─┼─► quotes.jsonl ─► lines.jsonl        predictions.jsonl ◄── models (V1, V2.1, 001)   │
  Odds API (via  ───┘ │   event_map.jsonl                    results.jsonl ─► evaluations.jsonl ─► miss_... │
  Supabase capture)   │ football/cfb_lab/governance/  roles · experiments · audit · partitions · research   │
                      │ football/cfb_lab/reports/<season>/  lab.json · season · week_NN · promotion          │
                      │ record/football/cfb_model_lab.json  (the sanitized public record)                    │
                      └──────────────────────────────────────────────┬──────────────────────────────────────┘
                                                                     │ insert-only mirror (sync_supabase.js)
                      ┌──────────────────────────── Postgres / Supabase ▼ ──────────────────────────────────┐
                      │ cfb_lab_* tables (write-once triggers) · views · cfb_lab_ingest_quotes() · pg_cron   │
                      └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **The repository ledger** is JSON Lines, append-only, committed hourly by the `CFB Model Lab`
  workflow. The static pages, the reports and the tests read it. It is the source of truth.
- **Postgres** mirrors it insert-only (`on_conflict=<id>`, `resolution=ignore-duplicates`), and is where
  the per-sportsbook Odds API quotes first land: the Supabase `capture` function forwards the college
  odds it already pays for to `cfb_lab_ingest_quotes()`, which applies the lab's de-duplication rule. The
  lab job pulls those quotes into the ledger each hour. Odds API quotes are not copied back (the ledger
  copy may carry a game id the event map supplied later).
- Ids are deterministic hashes of the fact (SCHEMA rule 4), identical in Node, Postgres and Deno, so the
  same fact is the same row everywhere and a replay is a no-op.

## The hourly job

`.github/workflows/cfb-lab.yml`, dispatched at :07 by pg_cron (`cfb_lab_hourly` in
`supabase/cfb_lab_cron.sql`) with GitHub's own schedule at :37 as the backup. Two runs never overlap.
Each run (`football/cfb_lab/run.js`) executes isolated steps — one failing feed never stops the others,
because a missed window cannot be re-taken:

| step | module | what it does |
|---|---|---|
| seed | `governance.js` | the initial roles, experiments and partitions (idempotent) |
| supabase_pull | `sync_supabase.js` | Odds API per-book quotes newer than the ledger's |
| market | `market.js` | ESPN + CFBD + Odds API quotes → event mapping → de-dup → `quotes.jsonl` |
| freeze_import | `checkpoint.js` | V2's Tuesday freezes → `WEEKLY_FREEZE` snapshots |
| checkpoints | `checkpoint.js` + `models.js` | each model × game whose window is open → one snapshot |
| audit | `governance.js` | a governed fact changed (params, calibration, version) → audit event |
| settle | `settle.js` | results (all sources must agree), openers/closes, grading, miss reviews |
| report | `report.js` | `lab.json`, season report, weekly report (once), promotion, public record |
| verify | `ledger.js` | ids, hashes, one row per checkpoint slot, nothing committed changed |

Then the workflow re-verifies against `HEAD`, publishes with `tools/ci/push_generated.sh`, and mirrors to
Supabase. If verification fails, nothing is pushed.

## Models tracked

| model_version | label | role at launch | adapter |
|---|---|---|---|
| `edgedesk_cfb_p4_v1.0.0` | V1 | **champion** | `football/fbs/slate.json` through the record's `projectionFromSlate` |
| `edgedesk_cfb_v2.1.0` | V2.1 (hardened) | challenger | `football/cfb_v2/current.json` → `engine.pure` / `decide` with `params.js` |
| `edgedesk_cfb_v2.0.0` | V2 candidate 001 | candidate | the `shadow.candidate_001` block, in an isolated engine with its own params |

The lab does not change the models. It reads what each one publishes, and it snapshots them on the same
schedule, so they can be compared on the same games at the same horizon.

## Checkpoints and the official prediction

Windows (hours to kickoff): OPEN (first snapshot at > 72 h), T72 (48, 72], T48 (24, 48], T24 (12, 24],
T12 (6, 12], T6 (2, 6], T2 (1, 2], FINAL (0, 1]. Each is taken at the **first** hourly run inside it and
never back-filled. **OFFICIAL = the LIVE T24 snapshot** (`cfb_lab_official_v1`), defined before the
season. The public record uses only the champion's OFFICIAL rows. Families: EARLY_MODEL (first
snapshot), MIDWEEK_MODEL (T48), OFFICIAL (T24), FINAL_MODEL (FINAL).

Origins: `LIVE` (taken by the lab at the time), `GIT_RECONSTRUCTED` (V1's own published numbers recovered
from the board's git history for games before the lab started), `REPLAY` (candidate 001 re-run over weeks
already played). Only LIVE rows can be official, public or used for promotion; the others sit in a
separate `reconstructed` report section.

## Market history

Quotes are kept per `(source, book, game, market)` when they change, plus heartbeats (6 h; 50 min inside
the last 3 h). Openers and closes are derived once, at kickoff + 3 h, with the exact rules in METRICS §4
(pinned by the shared cases in `football/cfb_lab/fixtures/market_rules.json`, which both the JavaScript
and the Postgres functions must reproduce). Odds API events are mapped to games by the board's own join
(`joinSignalsToGames`: both teams in this orientation, kickoff within 36 h); a swapped or ambiguous match
is refused and counted, never guessed.

## Surfaces

- **Internal**: `admin/cfb-lab/index.html` (noindex) renders `reports/<season>/lab.json` — model health,
  this week, performance, comparison, errors, edges, market discovery, governance, reconstructed.
- **Public**: the "Model Lab" section of `record.html` renders `record/football/cfb_model_lab.json` —
  every graded official prediction, losses included, with the rules that produced it.
- **Postgres views**: `cfb_lab_official_predictions`, `cfb_lab_current_results`,
  `cfb_lab_current_evaluations`, `cfb_lab_current_roles`, `cfb_lab_consensus_now`, and the anon-readable
  `cfb_lab_public_record` / `cfb_lab_public_summary`.

## Governance

`football/cfb_lab/governance/*.jsonl`, append-only: model roles (one champion; only the champion drives
production), experiments (one change each unless explicitly scoped BUNDLE or ARCHITECTURE), the audit log
(every role change, rule change and detected parameter/calibration/version change), partitions
(`development_pool` 2016–2023, `live_observation_pool` 2026, `future_holdout_pool` 2027; a live season is
released for tuning only after its promotion report exists) and the evidence-gated research queue.

## Files

| path | role |
|---|---|
| `football/cfb_lab/lab_core.js` | pure rules: windows, market, grading, calibration, buckets, drift, promotion |
| `football/cfb_lab/ledger.js` | ids, hashes, append-only store, write-time refusals, `verify` |
| `football/cfb_lab/market.js` | quote capture, event mapping, de-dup, openers/closes |
| `football/cfb_lab/models.js` | model adapters, data-quality checks |
| `football/cfb_lab/checkpoint.js` | snapshot rows, the checkpoint scheduler, freeze import |
| `football/cfb_lab/settle.js` | results, grading, miss reviews |
| `football/cfb_lab/report.js` | every report and the public record |
| `football/cfb_lab/governance.js` | roles, promotion, experiments, partitions, audit |
| `football/cfb_lab/backfill.js` | GIT_RECONSTRUCTED and REPLAY imports (clearly labelled) |
| `football/cfb_lab/run.js` | the hourly orchestrator |
| `football/cfb_lab/sync_supabase.js` | the insert-only mirror and the Odds API pull |
| `supabase/cfb_lab.sql`, `supabase/cfb_lab_cron.sql` | tables, guards, functions, views; the schedule |
| `supabase/functions/capture/index.ts` | forwards per-book college odds (`cfbLabQuotes`, fail-soft) |
| `admin/cfb-lab/index.html`, `record.html` | the internal terminal and the public record |
| `.github/workflows/cfb-lab.yml`, `cfb-lab-tests.yml` | the hourly job and the PR suites |
