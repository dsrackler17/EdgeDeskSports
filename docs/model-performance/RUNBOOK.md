# Model performance: runbook

How to run, configure, monitor and roll back the public model performance record. See `AUDIT.md` for what existed and `DESIGN.md` for how it works.

## What runs, and where

| Piece | Where | When |
|---|---|---|
| Capture, results, grading, public data | `.github/workflows/performance.yml`, which calls `tools/performance/run.js --write --network` | Hourly at :19, and by hand |
| PR tests | `.github/workflows/performance-tests.yml` | On PRs touching the system, and on pushes to main |
| Optional database mirror | `.github/workflows/deploy-model-performance.yml` to apply it (manual); the hourly job's sync step to keep it current | Manual |
| Public page | `/performance/` (`performance/index.html`, `.js`, `.css`) | Static, reads `performance/data/*.json` |
| Postgame block on matchup articles | `tools/articles/build_articles.js` reads `performance/articles/postgame.json` | Every article build (the editorial job, about every 15 minutes) |
| Weekly accountability article | The existing Monday Weekend Model Review (`lib/content_engine.js`, `tools/editorial/features.js`), which reads `performance/data/weekly.json` | The features job, gated by the owner's `fp_mode` |
| Social drafts | `performance/social/<week>.json`, written once per complete week with 20 or more verified games | Hourly job |

**What the hourly job commits.** It commits only `performance/ledger`, `performance/data`, `performance/articles` and `performance/social`. The page files in `performance/` are source files. The job never writes them, and a push race cannot revert them.

## Configuration

**No new secret and no new service.**

| Name | Kind | Needed for |
|---|---|---|
| `SB_URL`, `SB_SERVICE_ROLE` | existing Actions secrets | Only the optional mirror (the sync) |
| `SB_DB_URL` | existing Actions secret | Only applying the mirror's SQL (the deploy workflow) |
| `PERFORMANCE_SUPABASE` | repository **variable** | Set it to `on` after the mirror's SQL is applied, so the hourly job keeps the mirror current |

### Tuning (constants, changed in code with tests)

**`lib/edgedesk_performance.js`:**
- `MIN_N = 20`: the fewest games behind any printed rate or average.
- `RESCHEDULE_HOURS = 36`: a start that moved further than this voids the earlier snapshots.
- `POSTPONED_VOID_DAYS = 14`: how long a postponed game waits before it is void.
- `PICK_GAPS`: the disagreement thresholds for the line records.

**`tools/performance/pipeline.js`:**
- `MISSING_FINAL_HOURS = 8`: after this many hours a missing final is reported.
- `ALERT_HOURS = 30`: after this many hours it turns the run red.
- `CHASE_DAYS = 21`: after this many days the job stops looking for a final.

**Changing how games are graded:** bump `GRADER_VERSION`. The next run regrades every game as a new grade revision with `reason: method_change`. The old grades are kept.

## Deployment

1. **Merge.** Nothing needs applying first. The committed ledger already holds the earlier pregame records, labelled *recorded pregame*.
2. **The first hourly run is the ledger's epoch.** It captures every upcoming forecast as *verified pregame*. From then on, imports of earlier records stop at the epoch. The verified headline says "insufficient data" until 20 verified games are graded. That is expected: the claim builds as games are played.
3. **Optional: the database mirror.**
   1. Run **Deploy model performance mirror** (Actions, then Run workflow). It tests the SQL on a throwaway PostgreSQL, applies `supabase/model_performance.sql` in one transaction, and copies the ledger. Without `SB_DB_URL`, paste the file into the Supabase SQL editor instead; it fits in one paste.
   2. Set the repository variable `PERFORMANCE_SUPABASE=on`.
4. **The weekly article** publishes only if the owner has set the Weekend Model Review's `fp_mode` to `auto` (admin content page). Otherwise it is held for review, as before.
5. **Social drafts** are files, never posts. To post one, copy the text from `performance/social/<week>.json`. EdgeDesk has no X integration.

### Risks reviewed before deploying

- **Additive only.** New files, plus small additions to:
  - the article renderer, which adds a block only when a summary exists;
  - `lib/content_engine.js`, which adds sections only when a complete verified week exists, and inlines into the `content_engine` Edge Function;
  - links in footers, `record.html`, `index.html`, `methodology/` and the app's More menu.
- **No existing table, workflow or record changes behaviour.**
- **The Edge Function copy of `lib/content_engine.js` needs redeploying** (**Deploy content engine** workflow) for the owner's admin page to show the new sections. The hourly features job runs from the repository and does not wait on it.
- **The SQL is additive.** It creates `perf_*` objects only. Its rollback drops only those.

## Monitoring

Every run writes `performance/data/health.json` and adds a summary to the run page.

### When the run turns red

The run turns red, after the data is published, on any item with level ERROR or ALERT:

| Check | Meaning | What to do |
|---|---|---|
| `chain_integrity` (ERROR) | A committed ledger file no longer verifies. Someone edited a line. | Restore the file from git (`git checkout <last good> -- performance/ledger/...`). The job refuses to write until the chain is whole. |
| `missing_finals` (ALERT after 30 h) | A started game has no verified final from any source. | Check `today/slate.json` and the sport's own result file. ESPN is re-read by date automatically (4 reads a run). |
| `result_conflicts` (ALERT after 30 h) | Two sources disagree on the final. | Nothing is settled until they agree. Check which source is wrong; the correction lands on its own once it agrees. |
| `unmatched_events` (ALERT after 30 h) | An NFL or NHL forecast could not be matched to the scoreboard by team names and start. | A team-name difference between the engine and ESPN. Check `tools/performance/sources.js` `matchSlate`. |
| `capture_stale` (ALERT) | No forecast captured for 6 hours while games start within a day. | Check the **Model performance** workflow runs and the engine builds. |
| `metric_shift` (ALERT) | A published Brier score or MAE moved more than the new games explain, or a graded count fell. | Look for a regrade (`reason: method_change`) or a correction run. Confirm the change is real before it stands. |

### Warnings and notices

- `postponed`, `unresolved_finals`, `ungraded`, `late_forecasts_refused`, `duplicate_publication` and `source_read_failed` are warnings or notices.
- They are listed on the run and in `health.json`. They do not turn the run red.

**Duplicate runs** append nothing. Every step is idempotent: content hashes, and `writeIfChanged` for the public files. A week's social draft is written once, and a different rebuild of it is refused and reported.

## Corrections

**A source correction** happens when a sport's result file or the scoreboard changes a final. The next run writes a new result revision with `reason: source_correction` and `supersedes` set to the old revision's hash. It then regrades the game as a new grade revision with `reason: result_revision`. The page shows the latest revision, and the article block says "after a source correction". Nothing is deleted.

**A wrong final with no source correction** cannot be fixed by hand in this version, and that is deliberate: no person edits the record. If a source is wrong for good, raise it as an issue. A manual-override source would need its own reviewed result file.

## Rollback

| To undo | Do this | Effect |
|---|---|---|
| The hourly job | Disable **Model performance** (Actions, then the workflow, then Disable) | The page keeps the last published record. |
| The public page | Revert `performance/index.html`, `.js`, `.css` and the links (footers, `record.html`, `index.html`, `methodology/`, `app.html` More), the sitemap entry and the test registrations | `/performance/` is gone. The ledger stays in git. |
| The article block | Revert the `build_articles.js` and `article_render.js` changes. The next editorial build re-renders every page without it. | Articles are exactly as before. |
| The weekly article sections | Revert the `lib/content_engine.js` and `tools/content/artifacts.js` changes, run `node tools/content/inline.js`, then redeploy the content engine | The Weekend Model Review is exactly as before. |
| The database mirror | `supabase/model_performance_rollback.sql`, and unset `PERFORMANCE_SUPABASE` | The mirror is gone. The committed ledger is the source of truth, and a re-apply plus sync restores it. |
| Everything | `git revert` this change's commits | The ledger files are removed from the tree but stay in history. |

**Not reversible:** a committed ledger line. It is append-only by design, and the job refuses to extend a chain it cannot verify.

## Costs and dependencies

**Dependencies:** none new. Node 22's standard library only. Playwright is used only in CI's browser test, as the other suites use it.

**Network:**
- ESPN's public scoreboard, which is free and keyless: at most 4 reads a run, and only for a final the slate no longer carries.
- No Odds API credits. The job reads only quotes the slate already captured.
- No paid service.

**Actions:** about 1 to 2 minutes an hour, roughly 1,000 to 1,500 minutes a month. That is free on a public repository and counts against included minutes on a private one. The browser and SQL suites run only on PRs that touch the system.

**Storage:** about 1.5 KB per forecast revision and about 1 KB per result or grade row. A full year across every modelled sport is about 40,000 revisions plus about 20,000 result and grade rows, roughly 80 MB uncompressed. The ledger is append-only JSONL, which git stores as small deltas. The public game files are split by sport and season and served gzipped.

**Supabase (optional):** the same rows, insert-only, sent only beyond each file's head (`perf_heads()`).

## Security

**Public files** (everything committed is public through GitHub Pages) hold only:
- model output;
- public final scores;
- named-book quotes the slate already publishes;
- timestamps and hashes.

They hold no subscriber, account, billing, log or credential data. `tools/performance/performance.test.js` checks the public files for anything secret-shaped.

**Upcoming forecasts** are never in the page's data: `performance/data/games/*` holds started games only. The ledger files carry upcoming forecasts, just as `engine/projections.json` already does.

**Mirror access** (`tools/performance/performance_sql.test.js` attacks it as anon, as an authenticated reader and as the service role):
- anon and authenticated can read results and grades, and can read forecasts and quotes only once their game has started;
- they cannot write, call `perf_ingest` or `perf_heads`, or read `perf_ingest_runs`;
- the service role can only read tables and call `perf_ingest`. It cannot insert directly, or update, delete or truncate anything; nor can the owner.

**Secrets** stay in Actions only. The browser reads no key.
