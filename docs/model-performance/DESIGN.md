# EdgeDesk Model Performance: design

The lifecycle is: prediction generated, then locked, then the game completes,
the final is verified, the prediction is graded, performance is rebuilt, the
public page updates and the affected articles update. One hourly job runs the
whole loop. It is additive, reuses what `docs/model-performance/AUDIT.md`
found, and works from committed files alone. The Supabase mirror is optional
hardening.

## 1. Minimal additions

| Added | Why |
|---|---|
| `lib/edgedesk_performance.js` (EDPERF) | One pure kernel, shared by Node and the browser. It turns a projection into a ledger snapshot, picks the designated snapshot, verifies a result, grades a game, and computes metrics and the market comparisons. The page filters with the same code that built the summary, so the two cannot disagree. |
| `tools/performance/*.js` | The job, which captures, imports, verifies results, grades and builds. Plus a CLI, the Supabase sync, the chain verifier and the tests. |
| `performance/ledger/*.jsonl` | Append-only, hash-chained ledgers of forecasts, market quotes, results and grades. They are the source of truth. |
| `performance/data/*.json` | What the public page reads: the summary, the per-game ledger and the coverage. Also health and weekly data. |
| `performance/index.html` | The public page **EdgeDesk Model Performance**. |
| `supabase/model_performance.sql` (+ `_rollback.sql`) | An optional append-only mirror with server timestamps and RLS. |
| `.github/workflows/performance.yml`, `performance-tests.yml` | The hourly job and the PR tests. |

Nothing existing is replaced. The football record, the NBA and NHL graders,
the linemaker, the CFB Lab and the editorial audits keep running. The new
ledger is the cross-sport public record that sits beside them.

## 2. The forecast ledger (Phase 2)

**Source.** The job calls `engine/build_projections.js` `build({ now })` in
process. That is the same EDPROJ contract the quant desk freezes, built from
the engine artifacts that are committed (and therefore public) at that
moment. No engine is re-read separately and no price is read.

**A snapshot row** (`performance/ledger/forecasts/<sport>-<YYYY>.jsonl`) carries:

| Group | Fields |
|---|---|
| Identity | `event_key`, `sport`, `league`, `event_id`, `home`/`away` (name, abbreviation), `start_utc` as known at capture |
| Model | `model.id`, `model.version`, `model.artifact`, `model.predicted_at`, `model.artifact_generated_at`, `model.params_generated_at`, `model.inputs_known_at` |
| Forecast | `p_home`, `p_away`, `p_draw`, `p_overtime`, fair moneyline, `fair_home_line`, `fair_total`, expected total, projected score (home, away, margin, total), margin SD where published |
| Readiness | `research.outcome` and reasons, `freshness.state` and age, per-market validation state, `integrity.invalidated`, availability certainty, limitations |
| Market | the named-book quote from `today/slate.json` (book, source, `captured_at`, moneyline, spread, total). Attached only when it was captured before the start. |
| Capture | `capture.method` (`ledger_capture` or `import:<source>`), `capture.captured_at`, `capture.run`, `capture.git_sha`, and the `projection_id` / `projection_hash` from the contract |
| Chain | `seq`, `prev`, `hash` |

### Revisions

- A new row is appended only when the forecast's **signature** changes. The signature covers the model id and version, the probabilities, the lines, the totals and the projected score.
- Earlier rows are never rewritten. Every revision stays.
- Market quote changes go to their own append-only stream (`quotes/<sport>-<YYYY>.jsonl`). The comparison can then use the market as it stood when the model's number was captured.

### Pregame rule

A row is written only if all of these hold:

- the capture time is before `start_utc`;
- `model.predicted_at` is before `start_utc`;
- the event has not started according to the slate status.

Late builds are refused and counted. The build's own 3-hour post-start window is never let through.

### The designated snapshot

The designated snapshot is the one used for public grading. It is the **last ledger-captured revision before the actual start** (taken from the verified result, falling back to the scheduled start). If the start moved by more than 36 hours, which is the CFB Lab's rescheduling rule, the snapshots taken against the old date are ineligible.

### Verification tiers

- **VERIFIED.** The ledger captured the forecast from a public, committed artifact before the start. The capture row is hash-chained and committed. With the mirror on, Supabase also stamps it with server time.
- **RECORDED.** The forecast was imported from an earlier EdgeDesk pregame-only record:
  - the football record's first and last picks;
  - the NBA and NHL ledgers;
  - the cross-sport projections ledger.

  Only rows dated before the ledger's first capture are imported. The source's own timestamp was before the start, but this ledger did not lock it, so a RECORDED row is shown with its source and **never counted in the verified headline**.
- **Retrospective** (backtests and walk-forward validation) is never put in the ledger. The page links the existing validation files in a separate, labelled section.

### Eligibility

- Whether a forecast is graded is decided by **pregame** facts only. A forecast the engine itself marked `DATA_INSUFFICIENT`, or `integrity.invalidated`, before the game is recorded and counted as "flagged pregame, not graded".
- A sport is listed only while EDPROJ publishes projections for it. Retired sports (tennis, soccer) never appear.

### Protection

- Each file is a SHA-256 hash chain: `prev` → `hash` over the canonical row.
- `tools/performance/verify.js` checks the chains, and checks that the committed file at the base revision is an exact prefix of the new one (append-only).
- The job refuses to commit when either check fails.
- The optional Supabase mirror enforces the same rules on the server. See section 7.

## 3. Results (Phase 3)

### Sources, all already in the repository

1. **ESPN scoreboard:** `today/slate.json` events, which give status and score, plus `readDay()` for dates outside the window (at most 4 dates per run).
2. **The sport's own result file:**
   - NFL and CFB: `record/football/*` (nflverse; ESPN plus cfbfastR);
   - NBA: `nba/data/games`;
   - NHL: `hockey/data/team_games` (shootout-inclusive);
   - WNBA, NCAAM and NCAAW: `basketball/data/<lg>`.

### Matching

- CFB, NBA, WNBA, NCAAM and NCAAW carry ESPN ids, so they match by id.
- NFL (nflverse ids) and NHL (NHL API ids) match by sport, both full team names and a start within 36 hours. A second candidate, or a swapped home and away, is reported as UNMATCHED or AMBIGUOUS and never guessed. The sport's own file always matches by its own id.

### A verified final

- The status is FINAL and both scores are integers. A 0-0 score is treated as a placeholder and refused.
- Every source that carries the game agrees. If they disagree, the game is held as CONFLICT and monitored.

### Postponed, canceled and other non-finals

| Status | Handling |
|---|---|
| POSTPONED or SUSPENDED | Wait. If the game is played later, the snapshots for the old date fall under the 36-hour rule. |
| CANCELED | VOID |
| Forfeit (the ESPN detail) | VOID (no contest) |
| Postponed for more than 14 days with no new date | VOID, revisable if the game is later played |

### Settlement

- NFL, CFB, NBA, WNBA and college basketball finals include overtime.
- NHL finals include the shootout goal, the sportsbook rule.
- A tie (NFL) is a push for the winner and is not scored for probability. It is still scored for margin and total error.

### Corrections

- Results are append-only, with `revision` and `supersedes`.
- A source that changes a verified final writes a new result revision with `reason: source_correction`. The game is then regraded as a new grade revision, and both are kept.
- Re-running is idempotent: content-hash ids mean that processing a game twice adds nothing.

## 4. Grading and metrics (Phase 4)

### Per game

The designated snapshot plus the latest result revision gives one grade row,
with these fields:

| Area | Fields |
|---|---|
| Winner | the favourite (`p_home` ≠ 0.5), correct or not, Brier, log loss |
| Spread | projected margin (−`fair_home_line`, otherwise projected score), actual margin, error |
| Total | projected total, actual total, error |
| Market | **only** with a quote captured at or before the designated snapshot: the market's margin and total and their errors on the same game; the model's side against the market line; win, loss or push at that line; units at the captured price for that side (none if no price was captured) |
| CLV | **only** NFL and CFB, against the football record's close, and only when the quote and the close come from the same source family |

### Aggregates

- **By:** sport × model version × prediction type × tier × period (ISO week, month, all).
- **Probability metrics:** win accuracy, Brier, log loss, calibration buckets with Wilson intervals (EDCALIB), and confidence bands (favourite 50–55, 55–60, 60–65, 65–70, 70–80, 80+).
- **Error metrics:** MAE, mean error (bias) and RMSE for margin and total; the model's MAE beside the market's MAE on the same games; the share of games the model was nearer.
- **Pick records:** at three disagreement thresholds (any, at least 1.5 points, at least 3 points).
- **Sample size:** every figure carries its `n`, its eligibility counts and EDCALIB's sample state.

### What is never shown

- Percentages or calibration under the EARLY_SIGNAL band. These show "insufficient data" with the count.
- ROI unless the price was captured.
- A profit claim. That still follows EDCALIB's rule of 500+ bets and a 95% interval above zero.

## 5. Public page (Phase 5)

`/performance/` is a hand-written page in the tools family (`/tools/tools.css`), public, with no account needed. It reads only `performance/data/*.json`, the committed public artifacts, and no Supabase. It shows:

- the verified headline;
- per-sport cards;
- the calibration (reliability) chart;
- the weekly trend;
- the model-versus-market block;
- filters for sport, date, model version, prediction type and tier;
- the searchable game ledger, with the original forecast against the actual result and both timestamps;
- coverage, listing each sport and why it is or is not graded;
- the methodology and the limitations.

Only games that have started appear, so no upcoming subscriber forecast is exposed. The page is linked from the record page, the landing-page footer and trust panel, the methodology page, today's footer and the app's More › Transparency. The public nav is unchanged; that list is fixed by test.

## 6. Articles and social (Phases 6–7)

### Postgame block on matchup pages

- The job writes `performance/articles/postgame.json`. It is keyed by article id, built for every published pregame article whose result is verified, and covers:
  - the **article's own published numbers** (`research.projection`: fair spread, total, win probability, projected score);
  - the verified final;
  - the forecast errors;
  - the ledger's designated forecast, when it differs;
  - a link to the game's row on `/performance/`.
- `build_articles.js` passes each entry to `article_render.js`, which renders **EdgeDesk Prediction vs. Actual Result** under the "this game has been played" note.
- The record and its frozen numbers are never touched.

### Weekly accountability article

- The existing Monday **Weekend Model Review** (`lib/content_engine.js` `fpReview`) gains a cross-sport accountability packet from `performance/data/weekly.json`. That packet covers:
  - the verified games graded that week, by sport;
  - accuracy, Brier and margin MAE with `n`;
  - calibration;
  - the strongest and weakest model-versus-market differences with their results;
  - what held up, what struggled and the limitations.
- The review keeps its slot, its 12 gates, its database idempotency and the owner's `fp_mode` switch. A week with too few verified games is declined with the reason.

### Social drafts

- `performance/social/<week>.json` holds the weekly summary text (at most 280 characters, a link counted as 23), share-card data, three forecast-versus-result items and the links.
- Nothing posts: no X integration exists.

## 7. Supabase mirror (optional hardening)

`supabase/model_performance.sql` creates these tables:

- `perf_forecasts`, `perf_quotes`, `perf_results` and `perf_grades`, all append-only. Update, delete and truncate are refused by triggers, for the service role too.
- `perf_ingest_runs`, an audit log of every ingest.

Write path and attestation:

- Writes go only through `perf_ingest(kind, rows)`. It is `security definer`, granted to `service_role` only, insert-on-conflict-do-nothing on the row hash, and logs each call.
- `server_recorded_at` is set by a trigger, never by the client, which gives a server-attested time.

Reads:

- anon and authenticated can read forecasts only for games that have started, and can read results and grades;
- `perf_ingest_runs` is server-only;
- no subscriber, billing or user table is joined.

The sync runs only with secrets present and `vars.PERFORMANCE_SUPABASE == 'on'`, set after the SQL is applied.

## 8. Automation, monitoring and cost (Phase 8)

### Schedule

- `performance.yml` runs hourly at `:19`, after the `:07` slate commit, plus by hand.
- The steps are: tests, verify, capture, import (until it is complete), results, grade, build, verify again, then commit via `push_generated.sh` (`performance/` only), then the optional mirror.

### Health

`performance/data/health.json` reports:

- finals missing more than 8 hours after start;
- unmatched and ambiguous events;
- ungraded designated forecasts with a verified final;
- CONFLICT results;
- refused late captures;
- broken chains;
- a metric moving beyond its expected range (Brier or MAE shifting more than three standard errors with no matching rise in `n`);
- duplicate grade or publication attempts;
- the age of the last capture.

### Failure handling

A health check that fails turns the run red through a separate step (the `model-health.yml` pattern), so GitHub notifies the owner. The data is still committed first.

### Cost

- No new paid service and no new secret.
- ESPN reads are free and capped at 4 per run.
- The job reads committed artifacts.
- It uses one hourly Actions run of about a minute.

## 9. Security (Phase 9)

- No secret is read in the browser.
- Public files contain only model output, public scores and named-book public quotes. They never contain subscriber, billing, account or log data.
- The mirror's RLS:
  - hides forecasts for games that have not started;
  - keeps `perf_ingest_runs` private;
  - gives anon no write path.

  The tests attack it as anon, as an authenticated user and as the service role.
