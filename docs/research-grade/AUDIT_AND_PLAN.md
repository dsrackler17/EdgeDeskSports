# Research Grade: audit and implementation plan (2026-10-16)

Read-only audit of the repository before building the A–F Research Grade
Engine and the Grade Performance dashboard. Paths are repository-relative.

## 1. What already existed, and what is reused

### The per-game inputs: the projection contract

`lib/edgedesk_projections.js` (EDPROJ), built by `engine/build_projections.js`,
already reads every operational engine (NFL, CFB, NBA, NHL, WNBA, NCAAM,
NCAAW) into one per-game contract, with no market input by construction. Per
game it carries everything a research-quality grade needs:

| Grade input | Contract field |
|---|---|
| Model outputs | `outcome.p_home`, `fair.spread.home_line`, `fair.total`, `projected_score`, `uncertainty.margin_sd` |
| Research state | `research.outcome` (RESEARCH_READY / CONDITIONAL / DATA_INSUFFICIENT / MODEL_UNAVAILABLE) and reasons |
| Freshness | `freshness.state`, `age_hours`, `max_age_hours`, `data_state` |
| Integrity | `integrity.invalidated` (for example an NFL starting-QB conflict) |
| Walk-forward validation | `validation.markets.moneyline.state` and `n` (from `engine/registry.json`) |
| Key-role availability | `availability.key_role`, `availability.certainty` |
| Uncertainty | `uncertainty.model_sd` (and its basis: measured or a board default), `calibration_sd`, `early_season` |
| Sensitivity | `sensitivity[]` (goalie ranges, a player sitting, a QB out) |
| Matchup | `matchup.factors`, `matchup.metrics` (CFB: `reliability_score`, `reliability_grade`) |
| Provenance | `provenance[].authority` |
| Independence | `model.kind`, `model.market_inputs` |

**Reused unchanged.** The grade engine reads the contract; it does not re-read
an engine or modify EDPROJ (which is inlined into the edge function).

Three sport-specific measures live only in the sports' own slates and are read
by the grade's sport adapters, not copied into the contract:

- CFB `football/fbs/slate.json`: `projection_stability` (the perturbation sd from
  `lib/cfb_reliability.js`), `kickoff_tbd`, `week`;
- NFL `football/nfl/slate.json`: `data_quality` (missing inputs and warnings), `week`;
- NHL `hockey/slate.json`: `data_quality.early_season`.

### Existing quality, confidence and grade systems (not duplicated)

| System | What it is | Relationship |
|---|---|---|
| `lib/cfb_reliability.js` | CFB-only 0–100 input-quality score with bands (VERY_STRONG … VERY_LOW) and hard caps | **Reused** as CFB's "engine input quality" sub-factor. Not re-implemented. |
| `lib/edgedesk_readiness.js` (EDREADY) | five separate readiness states | Left alone: readiness answers "can this be researched", the grade rates how good that research is. |
| `research_grade` boolean (`lib/edgedesk_personal.js`, `game_research_state`), `RESEARCH_GRADE` prop stage (`lib/edgedesk_props.js`), tennis `research_grade` tiers | names already in use | The new system uses distinct identifiers (`EDGRADE`, `letter`, `research_grades` streams, `rg_v1`) and says "Research Grade (A–F)" in copy. |
| `lib/edgedesk_portfolio_process.js` `gradeLetter` | A+…F letter for a user's betting process | Different scale and subject; untouched. |
| `lib/edgedesk_decision.js` decision confidence, `lib/edgedesk_canon.js` research status, `lib/research_priority.js` | price-level decisions and reading order | Untouched: the grade is not a decision and never reads a price as an input to "value". |

### Settlement, history and metrics: the Model Performance system

`lib/edgedesk_performance.js` (EDPERF) and `tools/performance/*`, shipped the
same day, already provide the whole historical-validation backbone:

- four append-only, SHA-256 hash-chained ledgers under `performance/ledger/`
  (forecasts, quotes, results, grades), with a prefix check against the base
  branch (`run.js --check --base`);
- pregame-only capture, refused at or after the start;
- result verification from two sources that must agree (`resolveResult`):
  FINAL / VOID (canceled, forfeit, postponed 14+ days) / CONFLICT / PENDING;
  overtime counts, NHL finals include the shootout goal, a corrected final is a
  new revision, 0-0 is a placeholder;
- Brier, log loss, Wilson-interval calibration buckets, MAE / bias / RMSE,
  model-vs-market on the same games, records at the captured line, CLV only
  against a same-source close (`metrics()`), with EDCALIB's sample states;
- the hourly job (`.github/workflows/performance.yml`), `tools/ci/push_generated.sh`,
  the optional Supabase mirror (`supabase/model_performance.sql`), health
  monitoring (`performance/data/health.json`), the throwaway-PostgreSQL SQL
  harness (`tools/personal/_pg.js`) and the public `/performance/` page.

**Reused, not duplicated.** The grade's settlement reads the existing results
stream; its per-game arithmetic is `EDPERF.gradeGame`; its aggregates are
`EDPERF.metrics` run per letter. No new results pipeline, no new scraper.

### Frontend

- No build step: `app.html` is hand-maintained and loads `lib/*.js` with
  `?v=` cache tokens; the game-view files share one token (test-enforced).
- Boards: Today's Games (`lib/edgedesk_games_ui.js`, also the free `/today/`
  page), the FBS board and NFL cards (`app.html`), NHL (`lib/edgedesk_engine_ui.js`),
  NBA (`lib/edgedesk_nba_ui.js`). Game views: `lib/edgedesk_game_view.js`
  (NFL/CFB), the P4 game card (`app.html`), NBA/NHL game details.
- The public nav is fixed at five links (`tools/site/nav.test.js`); new pages
  are linked from footers, the app's More › Transparency, methodology and the
  sitemap. Glossary popovers: `lib/edgedesk_guide_content.js` + `data-ed-term`.
- The site is dark-only.

## 2. Missing inputs (honest gaps)

| Gap | Effect on the grade |
|---|---|
| No live pregame track record for NBA, WNBA, NCAAB; NHL has 29 graded games, NFL 63 (all *recorded* pregame, none ledger-verified yet) | Reliability's live sub-factors are **unvalidated**: excluded and the grade is capped at C (NFL: early signal, capped at B). CFB has 270 scored games (developing, no cap). |
| NBA and lab basketball have no injury or confirmed-lineup feed | Key-role availability unknown → 0 credit and a cap at C. |
| NFL, CFB and the lab engine publish only a board-default model sd | "Model disagreement" is missing for them (CFB uses its perturbation stability instead). |
| Named-book lines come only from the slate (today−2 … today+3) | Games further out have no line yet: the market part is excluded and the grade capped at B until one is captured. |
| No captured closing price for NBA, NHL, WNBA | CLV is never shown for them. |
| MLB, college baseball, UFC have no per-game pregame forecast | Not graded (no adapter); listed as such. |
| No grade existed before 2026-10-16 | Completed games before the grade ledger's first capture are never graded retroactively. |

## 3. The plan, as built

1. **Kernel** `lib/edgedesk_research_grade.js` (EDGRADE, UMD, pure): sport
   adapters, normalised inputs, five dimensions of named sub-factors, gates,
   caps, letters, a plain-English explanation, the evaluated side saved
   pregame, reproducibility from stored inputs, designation of the latest
   valid pregame grade, settlement over EDPERF's arithmetic, and the
   per-letter performance aggregates (EDPERF.metrics per letter, intervals,
   ordering evidence).
2. **Ledger** two new append-only, hash-chained streams in the existing store
   (`tools/performance/ledger.js`): `research_grades/` and `grade_outcomes/`.
3. **Pipeline** `tools/performance/research_grades.js`, called by the existing
   hourly `run.js`: snapshot after the forecast capture, settle after the
   results and grades. `run.js --check` now also re-scores every stored grade
   from its own inputs.
4. **Artifacts** `tools/performance/grade_build.js`: `performance/data/grades/`
   `live.json` (badges, no model numbers), `live_detail.json` (breakdowns),
   `games/<sport>-<season>.json` (started games only) and `summary.json`; health
   items folded into `performance/data/health.json`.
5. **Supabase** `supabase/research_grades.sql` (+ rollback): an optional,
   standalone, append-only mirror with server stamps, RLS, a single ingest
   function, a pregame trigger that refuses any backfilled outcome, the A–F
   thresholds as a check constraint, and a by-letter aggregate view;
   `tools/performance/sync.js` routes the two new streams to it.
6. **Frontend** `lib/edgedesk_grade_ui.js` + `lib/edgedesk_grade.css`: badges,
   the letter filter and the Grade Breakdown, wired into every board and game
   view above (terminal only; `/today/` unchanged); the glossary entry; the
   `/performance/grades/` dashboard; navigation.
7. **Tests** kernel + lifecycle (`research_grade.test.js`), wiring
   (`grade_ui.test.js`), PostgreSQL (`research_grades_sql.test.js`), browser
   (`grades_ui.e2e.js`), all in `performance-tests.yml`; the hourly job runs
   the kernel suite before it writes.
8. **Docs** this file, `METHODOLOGY.md`, `RUNBOOK.md`.
