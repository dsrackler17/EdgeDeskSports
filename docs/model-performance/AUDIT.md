# Model performance: audit of what existed (2026-10-16)

Read-only audit of the repository before building the public model
performance system. It covers the prediction engines, the existing ledgers and
graders, result ingestion, the editorial workflow, the public site, Supabase,
CI, and what each one already guarantees. Paths are repository-relative.

## 1. What already exists and is reused

### Forecasts

| What | Where | Status |
|---|---|---|
| **One cross-sport projection contract** | `lib/edgedesk_projections.js` (EDPROJ), built by `engine/build_projections.js` | Reads every engine's committed artifact and **no price**, giving one record per event with: event id and start, teams, model id and version, `predicted_at`, win probabilities, fair moneyline, fair spread, fair and expected total, projected score, uncertainty, validation state, research readiness (`research.outcome` plus reasons), freshness and integrity. Covers NFL, CFB, NBA, NHL, WNBA, NCAAM and NCAAW. **This is the forecast source for the new ledger. Nothing re-reads the engines.** |
| Cross-sport projections ledger | `engine/projections_ledger/<YYYY-MM>.jsonl` | Append-only, one line per new projection hash, from 2026-10-15. **No grader read it.** It stores no projected score, can keep events up to 3 h after start (`build_projections.js:64`), dedupes within the month only, and has no prefix check. |
| Football model record | `record/football/{nfl,cfb}_2026.json`, `tools/record/football_record*.js` | Pregame-only NFL/CFB record keeping the first and last pregame numbers, the close (nflverse / ESPN) and the final, graded hourly. 419 games graded in 2026. It is a rewritten JSON file, not append-only. On a live run only the slate's own `generated_at` is checked; commit time is checked only on git replay. A changed final is kept as `final_conflict` and never surfaced. |
| NBA / NHL ledgers | `nba/ledger/2027.jsonl`, `hockey/ledger/2027.jsonl` and their `grade_ledger.js` | Append-only, `recorded_at < start_utc`. Season aggregates only, which no page shows. NHL has 19 games graded; NBA has none yet (its season opens 2026-10-20). |
| Linemaker, CFB Lab, CFB terminal, game-research history, editorial snapshots | `football/linemaker/ledger`, `football/cfb_lab/ledger`, `football/cfb_terminal/history`, `football/game_research/history`, `articles/data/editorial/snapshots` | NFL/CFB-specific pregame records, each with its own grader and audience. Left unchanged. |

### Results

| Source | Sports | Reused as |
|---|---|---|
| `today/slate.json` (ESPN scoreboard, every 30 min, `tools/slate/`) | every listed sport | Status (FINAL / POSTPONED / CANCELED / SUSPENDED), scores and named-book pregame quotes with `captured_at`. **Not durable** (a today−2 to today+3 window), so every final accepted is copied into the new results ledger. |
| `tools/slate/espn.js` `readDay()` | every listed sport | Re-reads a missed date with the same parser, on a capped budget per run. |
| `record/football/*` finals | NFL (nflverse), CFB (ESPN plus cfbfastR, which must agree) | A native second source. Nothing is fetched again. |
| `nba/data/games/<season>.csv` | NBA (hoopR / ESPN) | Native second source. |
| `hockey/data/team_games/<season>/*.csv` | NHL (official NHL data via sportsdataverse; shootout-inclusive `gf`/`ga`, `decided` REG/OT/SO) | Native second source. |
| `basketball/data/<lg>/<season>.csv` | WNBA, NCAAM, NCAAW | Native second source. |

### Scoring, UI and infrastructure

- **Scoring:** `lib/edgedesk_calibration.js` (EDCALIB) supplies Brier, log loss, Wilson-interval probability buckets and the look-ahead screen. Its sample states (`<50` TOO_EARLY, `50–199` EARLY_SIGNAL, `200–499` DEVELOPING, `500+` MEANINGFUL) are reused unchanged, and no fourth set of bands is invented.
- **Data writes:** `tools/ci/push_generated.sh` commits generated files. `tools/lib/pgrest.js` writes to the database through PostgREST with the existing secrets. `tools/personal/_pg.js` is the throwaway-PostgreSQL SQL test harness.
- **Public page look:** the `/tools/tools.css` page family supplies tokens and components. The reliability-diagram pattern comes from `app.html` `reliabilitySVG`.
- **Social:** `lib/edgedesk_record_card.js` sets the 280-character rule, counting a link as 23.
- **Articles:** the renderer is `tools/articles/article_render.js` / `build_articles.js`. The weekly article is the Weekend Model Review: `lib/content_engine.js` `fpReview`, run by `tools/editorial/features.js`, scheduled by `edgedesk-features-run.yml`, and gated by the owner's `fp_mode`.

## 2. The gaps, exactly

1. **No grading of pregame forecasts per game across all sports.** NFL and CFB have one. NBA and NHL have season aggregates. The cross-sport projections ledger is never graded.
2. **No independent capture time.** Every existing record dates a forecast by the producer's own build clock (`generated_at`, `recorded_at`, `frozen_at`). None records when the number was observed in a public, committed artifact. The football record checks commit time only on replay.
3. **Revisions are partial.** The football record keeps the first and last pregame numbers and a count of revisions, not the revisions themselves. The projections ledger keeps compact lines only.
4. **Result corrections, postponements and forfeits are handled differently in each pipeline.**
   - Only the CFB Lab voids postponed, canceled and forfeited games and keeps superseding result rows.
   - The football record never applies a corrected final.
   - The NBA and NHL graders regrade silently.
   - ESPN-based pipelines disagree on forfeits.
5. **No common metrics by sport × model version × period.**
   - Win-probability calibration buckets exist nowhere for NBA, NHL or the football record.
   - The football summary has no log loss and no per-version split.
   - Winner accuracy is missing for NBA and NHL.
6. **No public cross-sport ledger of original prediction against actual result.** Only the CFB Lab table on `record.html` does this.
7. **No monitoring of missing finals, unmatched events or ungraded forecasts.** `FINALS_MISSING` is a warning that never fails a run.
8. **Articles.** Prediction against result is computed for audited games (`grading.model_accuracy`), but appears only on the separate postgame page. A matchup page shows just a link.
9. **No X posting integration of any kind.** There are no credentials, queue or API calls. Sharing is manual (intent links and canvas cards).
10. **Sports with no stored per-game pregame forecast cannot be graded:** MLB (the browser engine only), college baseball (a retrospective replay), UFC (no model) and soccer (removed 2026-10-15). They are reported as such, never graded.

## 3. Constraints that shape the design

- **Supabase SQL is applied by hand** (SQL editor or a manual deploy workflow). It must be idempotent and additive, end in an `ok` / `CHECK THIS` report and use no psql meta-commands. A merged migration is not a running one, so the system must work from committed files alone and treat the database as an optional mirror.
- **Supabase grants ALL to anon/authenticated and EXECUTE to PUBLIC by default.** Every new object revokes explicitly. TRUNCATE bypasses row triggers, so it needs its own statement trigger.
- **Everything committed to the repository is public** through GitHub Pages, so no generated file may contain secrets, subscriber data or private logs.
- **`push_generated.sh` replaces its named paths wholesale on a rejected push.** The new job must own its own top-level path (`performance/`) and never write into `articles/` or another job's directory.
- **The public nav is fixed** (five links, enforced by `tools/site/nav.test.js`). There is no public "Research" menu, so the new page is linked from footers, the record page, the landing page and the app's More › Transparency section.
- **Market prices.**
  - NFL/CFB closing lines exist with source and book, and the quote ledgers and the slate keep named-book quotes with capture times.
  - NBA, NHL and WNBA have no captured closing price, so no CLV is computed for them.
  - No price is ever assumed (−110 or otherwise).
