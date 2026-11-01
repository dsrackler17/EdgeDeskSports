# Changelog

## 2026-11-01 — NCAAM matchup graphic: neutral-site games drawn, last season's ratings on the card

- **Bug.** The matchup view refused a neutral-site game whose home and away ESPN's scoreboard and `basketball/slate.json` list the other way round ("…list this game's sides the other way round, so no graphic is drawn"), e.g. Northern Illinois v Grambling on 2 November. Across the 237 Division I scoreboard events for 2–4 November, 2 were affected, both at neutral sites. Under the home-games-only intercept (`bb_cal_v2_home_intercept`) the model prices a neutral game the same either way round, so `EDSportGraphic.labGame` now reads it with the schedule's sides (`flipGame`: moneyline, spread lines at −L, margin, rest and sample inputs move to their own team). A home game listed the other way round is still refused. No model output changed.
- **Stats.** For men's games the graphic reads `basketball/ncaam_research/published/index.json`, already served for the research page, by ESPN id. What to watch for shows each team's 2025-26 record and adjusted net-rating rank, and each offense's rank against the other team's defense. The no-price strip shows the records and net ratings. Each school is drawn in its own colour. A team the index does not rate (a non-Division I opponent) reads "unrated". Without the index the graphic draws as before.
- **Workflow.** `sport-graphic-tests.yml` also runs on a push of the research index to `main`.
- **Tests.** `tools/sport_graphic/sport_graphic.test.js` gets new checks for the flip, the refusals that remain, ratings in what to watch and in the strip, one side unrated, no index, the cache key, and `forEvent` end to end with a stubbed fetch. Against the old builder 18 of them fail. With the change all 25,481 checks pass. `sport_graphic_ui.e2e.js`: 57 passed, 0 failed.

## 2026-11-01 — NCAAM-EARLY registered (v0.1.0, EXPERIMENTAL, T3) before any result

- **What.** `basketball/ncaam_early/research/registration.json` and the registered starting configuration `basketball/ncaam_early/config/model_v0.json` (pinned in the registration by sha256), with `supabase/ncaam_early_registry.sql` generated from them by `research/build_registry_sql.js`. It is adapted from the NBA roster-adjusted generator: it reads the live registry columns, refuses rather than guesses, and writes no result row.
- **Windows.**
  - Training: the early-season windows (first game to 15 December) of 2020 and 2022–2025. 2021 is excluded before anything ran.
  - Retrospective holdout: 2025-26, scored once after the configuration is frozen. It is descriptive and cannot promote.
  - Prospective 2026-27 early season: the only promotion window.
- **Promotion criteria.**
  - C1: CLV of flagged bets > 0 with the 95% lower bound > 0 on ≥ 300 bets.
  - C2: calibration no worse than the de-vigged close (+0.005 log-loss tolerance).
  - C3: margin MAE not worse than NCAAM-FORECAST.
  - C4: honest 80% coverage, and predicted sd ranks residuals.
  - C5: HIGH-tier CLV ≥ LOW-tier CLV.
- **Also registered.** Conviction thresholds (3% / 1.5% / 0.5%; Conviction only, no stake shown), the selection rule (training only, frozen before the holdout), the weekly-learning rule and the forking-paths disclosure, including the engine's earlier unconfirmed continuity/transfer prior.
- **Deploy.** Deploy NCAAM early-season SQL gains `apply_registry` (default on).
- **Tests.** New `basketball/ncaam_early/tests/registration.test.js` (static, plus the registry SQL on a real PostgreSQL with a stand-in registry): 27 passed, 0 failed. It runs in NCAAM early-season suites.

## 2026-11-01 — NCAAM-EARLY data layer: the T0 store of the early-season college basketball model

- **What.** `basketball/ncaam_early/` (model `edgedesk_ncaam_early_v1`, EXPERIMENTAL), the observation layer of the early-season men's college basketball research model, which builds on the existing ratings engine (`basketball/ncaam_research/team_model.js`).
  - A CollegeBasketballData.com client whose every path and parameter is checked against the published OpenAPI document (1.30.1, sha256 recorded). It caps calls per run and stops before a call once the shared CBBD/CFBD quota falls below a 300-call reserve.
  - Normalisers that reject rather than repair, and check the END-year season convention against CBBD's own labels.
  - Derived player moves: returning, D-I transfer, portal transfer by source level, freshman, departures.
  - Hand-entered coach, availability and school-level files with validators. CBBD has no coaches endpoint.
  - A sync (`ingest.js`) with one run row per part and season, and alerts.
- **Storage.** New `supabase/ncaam_early.sql` (and its byte-identical migration mirror): 19 `ncaam_es_*` tables. Rosters are point in time (a team's roster is stored again only when it changes); portal, recruit and line rows are stored on change, append-only. Only `service_role` can read: CBBD's terms forbid publishing its data in bulk, and this repository is public, so no CBBD row is committed. `ncaam_es_readiness()` returns KPIs only, and System health shows it as *NCAAM early-season sync*.
- **Workflows.** `ncaam-early-tests.yml` (pull requests; in `sports-models`). `ncaam-early-sync.yml`: daily, plus weekly parts on Mondays; **off** until `NCAAM_EARLY_SYNC = on`; needs `CBBD_API_KEY`; commits nothing. `deploy-ncaam-early.yml` (manual).
- **Tests.** `basketball/ncaam_early/tests/data.test.js`: 77 passed, 0 failed. `basketball/ncaam_early/tests/sql.test.js` (real PostgreSQL): 39 passed, 0 failed. The SQL suite caught an upsert that left unchanged derived rows on the old run, so the stale-row cleanup would have deleted current rows. It was fixed before commit.
- **Not verified here:** any call to CBBD (no key in this environment), so endpoint field population, the portal year offset and the ESPN id crosswalk are measured on the first real run.

## 2026-11-01 — Research Queue and Smart Money Tonight compare through one path

- **One path** (`lib/edgedesk_research_compare.js`, `docs/research-compare/README.md`). The Research Queue and the Smart Money Tonight cards now compare a model with a price through the same module. For NHL it uses `EDNHLCompare`, as the matchup page does, so all three show the same gap. A comparison needs the same sport, game, side, market, period, line and settlement. NCAAM and NCAAW stay distinct. Every result carries its status and reason, and `calc: edgedesk_research_compare/1`.
- **Root causes found**
  - **Stale queue prices.** `games-slate.yml` (scheduled every 30 min) ran every 3.5–7.5 h on GitHub between Oct 28 and Nov 1. That is a refresh gap, not a display bug. New opt-in `supabase/games_slate_dispatch.sql` (pg_cron → `workflow_dispatch` every 30 min, debounced and logged). It is **not active until installed**.
  - **"EdgeDesk fair" on the cards.** It was `signals.sharp_fair`, Pinnacle's de-vigged reference, whose feed is out. It is now labelled as a reference and not compared when stale. "Model fair" is now EdgeDesk's own probability for the exact contract.
  - **Moneyline beside a puck line.** The queue picked the model's and the market's numbers through separate fallbacks, so it could set a model moneyline beside a market puck line. Both numbers now come from one shared market.
  - **ET on cards.** The cards printed times in a hard-coded ET. They now use the reader's zone.
  - **Rounding.** Each price was rounded on its own ("50¢ → 54¢, up 3¢"). Printed differences are now the differences of the printed prices.
  - **Queue order.** Completeness came before start time. The default view is now **Starting soon**, with **Research priority** ranked only within one sport and market.
  - **High Point–Liberty, 10:59 PM CST.** This is correct: ESPN gives 11:59 PM EST for an overnight marathon game.
- **Cards.** Each card shows:
  - wallet cost basis held at the last holders read, with the historical average entry;
  - model fair, with the model and its age;
  - the price, with its kind (displayed price, or an executable ask);
  - one interpretation.

  EV is shown only at an ask with a recorded fee. Wallet/model agreement adds nothing. The method and observed activity fold below the cards. The Radar record shows its denominators ("over 2 graded cards, not validated").
- **Slate.** `tools/slate/research.js` stamps each model block with its artifact's `generated_at`.
- **Unchanged.** Radar selection, publication, grading and the H-RADAR-01/02 registrations.
- **Rollback.** Set `EDResearchCompare.FLAG.on = false` (or `?rc=0` for one page view). The previous renderers are kept.
- **Tests**
  - `tools/research_compare/research_compare.test.js` (new): 111 checks, from provider fixture to queue row and card.
  - `tools/slate/dispatch_sql.test.js` (new, real PostgreSQL): 11 checks.
  - `tools/radar/radar_ui.test.js`: 2 wiring regexes updated for the new `opts` argument.
## 2026-11-01 — Odds gateway: men's college basketball (NCAAB) registered, disabled

- **Why.** No NCAAB price is captured (`basketball_ncaab` has no gateway row, so every request is `denied_sport`), so neither men's college basketball model can be graded against the market. The season opens 2026-11-02. The owner approved about 2,000 credits a month for NCAAB main markets.
- **What.** New `supabase/ncaab_odds_sport.sql` (and its byte-identical migration mirror): `basketball_ncaab`, group `ncaab`, **disabled**, priority 4. No cadence row: the `'*'` bands apply (hourly inside 24 h). One board of about 3 credits per purchase, at most about 2,160 credits a month. Nothing turns on until the owner runs `odds_api_set_sport('basketball_ncaab', true)` and adds the key to `CAPTURE_SPORTS`. Budget, breaker, categories, caps, cadence, capture and close are unchanged. Methodology note and operator steps: `docs/odds-api-incident-2026-10/METHODOLOGY-2026-11-01-ncaab-lines.md`.
- **Tests.** New `tools/odds/ncaab_odds_sport_sql.test.js` (real PostgreSQL): 22 passed, 0 failed. `tools/odds/no_bypass.test.js` gains one check (the NCAAB row is created disabled). The suite runs in Odds gateway tests and before Deploy odds gateway ships anything (new input `apply_ncaab_sport`).

## 2026-10-31 — Football enrichment refresh: the QB resolver no longer crashes when every candidate is ruled out

- **What failed.** Football enrichment refresh runs 143 and 144 (41174482032, 41202537139) on `main` stopped at `build_enrichment.js` with `TypeError: Cannot read properties of null (reading 'player_name')` at `football/enrichment/qb/resolver.js:290`. Kansas State (game 401856846): last game's opener Jacob Knuth (100% of dropbacks) and the quality ranking's Avery Johnson are both listed OUT. The resolver settled the conflict (observed start over model), ruled the starter out, found no available alternative and set no QB, then wrote the resolution text from the missing QB.
- **The fix.** When every name the evidence supports is ruled out, the answer is UNKNOWN with the ruled-out starter in `handed_from`, the conflict is reported `UNRESOLVED` (`conflict_resolved: false`), and `resolution_text` says every candidate is ruled out. No hierarchy, threshold or grading rule changed.
- **Tests.** `football/enrichment/enrichment.test.js`: 138 → 141. Against the old resolver: 3 failed, with the production error. `node football/enrichment/build_enrichment.js` now completes on the current data.

## 2026-10-31 — NBA injury readiness: a warning always says why

- **What was wrong.** After the 2026-10-30 deploy, `public.nba_injury_readiness` read `warn` with `state_reason` null. The cause was one name on the league's report (Michael Ajayi, CHA, two-way) that matched no rostered player. The view's `state` turns `warn` on seven conditions, but its `state_reason` named only two of them (the ESPN fallback and drift). The other five fell through to null, so System health printed "degraded" with no explanation.
- **Fix** (`supabase/nba_injury_layer.sql` and its byte-identical migration mirror). One reason branch for each remaining condition: failed or degraded checks in 24 h, teams missing on a game day (named), unmatched names, and a league report older than `official_report_max_age_minutes` on a game day (with its age). Only `state_reason` changes: `state` and every other column are the same, so no threshold moved.
- **Tests** (`tools/nba/nba_injury_sql.test.js`, real PostgreSQL). Four new checks, one per newly named condition. On the old view: 59 passed, 5 failed (the four new checks, plus the mirror check, which failed only because the test swapped the file in place). On the fix: 64 passed, 0 failed.
- **Deploy:** run Deploy NBA injury layer with `apply_sql`.
## 2026-10-30 — Juice Reel: the check says which application the client id is, and which scopes the last token got

- **Juice Reel approved `bets.settled.read` on EdgeDesk Sports Integration** (`jr_UcOwwS-Ep-nxQu7WeaStFHXfelzzjVrK`), and both redirect URIs are registered on it: `https://edgedesksports.com/oauth/juicereel-callback.html` (bet sync) and `https://edgedesksports.com/oauth/juicereel-subscribe.html` (billing). The other application, EdgeDeskSports (`jr_AFk36va1…`, Sign in With Juice Reel off), is to be disabled once the Integration app passes `check`. Today's `check` named its owner "EdgeDeskSports".
- **Which application.** `jr_check` (`portfolio_connect`, build `2026-10-30-jr6`) and billing's `check` (`juicereel_billing-2026-10-30-1`) now answer `app`: the client id's first 10 characters, matched against `jr_UcOwwS` (Integration, correct) and `jr_AFk36va1` (EdgeDeskSports, wrong). On the wrong one, Actions → Juice Reel setup and Actions → Deploy Juice Reel billing fail with what to put in Supabase. An id that is neither is a warning. The secret is never read for this and never printed.
- **Scopes.** `jr_check` answers `scopes`: what the bet sync requests (`bets.open.read bets.settled.read`) against what Juice Reel granted on the most recent stored token, with any missing scope flagged. The new service-only `portfolio_svc_jr_latest_scopes(env)` (`supabase/portfolio_juicereel.sql`) returns the scopes, time and status only: no reader, token or Juice Reel id. `supabase/parts/portfolio_juicereel.part*` regenerated (now 5 parts). `tools/portfolio/juicereel_smoke.js probe` prints both lines.
- **Docs.** `docs/juicereel.md` § 1 and `docs/juicereel-billing.md` § 1.
- **Tests.**
  - `tools/portfolio/juicereel.test.js`: 196 → 207. Against the old function: 3 failed, and the run stopped at the first missing `app`.
  - `tools/billing/juicereel_billing.test.js`: 113 → 118. Against the old function the suite stops at the first new check (`app` absent).
- **Deploy:** Actions → Deploy Portfolio schema (`deploy_function` ticked) for the SQL and `portfolio_connect`, and Actions → Deploy Juice Reel billing for `juicereel_billing`. Then run Actions → Juice Reel setup → `check`.

## 2026-10-30 — Deploy football situational tables (SQL): a button that applies supabase/football_situational.sql

- **Why.** The Football situational pipeline's last step copies its artifacts into the `fsie_` tables, which do not exist in production (`Could not find the table 'public.fsie_source_files'`, run 41093420059). Until they do, every run of the pipeline fails.
- **The workflow.** `deploy-football-situational.yml`, manual only (`workflow_dispatch`), `contents: read`. It runs `football/situational/tests/sql.test.js` against a throwaway PostgreSQL first, and fails if that suite fails or prints NOT VERIFIED. It applies the file with `SB_DB_URL` in one transaction (`--single-transaction`, `ON_ERROR_STOP`). It fails on any report row saying CHECK THIS, or unless all eleven `public.fsie_*` tables exist afterwards. Without `SB_DB_URL` the run fails: nothing was applied.
- **What it installs.** Eleven `fsie_` tables (RLS on), the `fsie_team_games_current` view and the `fsie_prune()` retention function. It drops, truncates and deletes nothing. The registry file is not part of it.
- **Checked here, not in production.** Each run step, taken from the workflow, was run against a throwaway PostgreSQL 16 with the Supabase shim. A first run applied it (SQL suite 35/35, 11 tables) and a second run was idempotent. A missing secret fails at the credential step, a suite printing NOT VERIFIED fails at the suite step, and a failing suite fails with its output shown. The production apply is NOT VERIFIED: no credential here.
## 2026-10-30 — NHL goalie sync: a failed check is tried again instead of waiting for the next slot (the header's "1 failing")

- **What the header showed.** The site's System pill read "1 failing" from 16:34 UTC. The one failing check was `nhl_goalie_readiness` (state `error`): "the last check failed: no starter source could be read (Daily Faceoff)". Deploy NHL goalie layer (run 41090811837) ended with a forced run at 16:34. Daily Faceoff answered HTTP 403 to both date pages, and the NHL API was not due (no game inside three hours). The cron run at 16:00 had read both pages, 18 rows. Daily Faceoff refused the function the same way on 2026-10-26 at 00:35 UTC. These are intermittent refusals from an outside source; EdgeDesk's parser and data were fine.
- **What was ours.** After an error run the sync asked nothing until the next scheduled slot (18:00 UTC), so one refused read held readiness, and the site-wide header, in error for 86 minutes. The starters on file were kept and nothing was written in their place, so readers lost freshness, not data.
- **Fix** (`supabase/functions/nhl_goalie_sync/index.ts`, build `nhl_goalie_sync@2026-10-30.4`). It complements #941, which retries a refused page inside one run and adds ESPN as a second source. A run still ends in error when every source is down, and #941 carries nothing over between runs. After an error run, the sync runs again 10 minutes later, then 20, then every 40 while it keeps failing, besides the schedule's own slots (`due_kinds` `retry_after_error`). The error run's `next_due_at` names the retry time. No change to what a run writes, how readiness judges a run, or the header's rule: a failed check still shows as failing until a check succeeds.
- **Tests** (`tools/hockey/nhl_goalie_sync.test.js`), replaying production. A forced off-slot run refused with 403 is an error, and its `next_due_at` is 10 minutes on. Then:
  - nothing runs at 6 minutes;
  - at 11 minutes it runs and recovers;
  - after the recovery, nothing extra runs;
  - a source that stays down is retried 10, 20, then 40 minutes apart.

  On the old code: 86 passed, 8 failed. On the fix: 94/0.
## 2026-10-30 — Football situational pipeline: a failure after the build no longer throws away the derived seasons

- **Why.** All four scheduled runs since the pipeline was added failed. Three were market refreshes (`build --offline`): `no derived season` for NFL and CFB at ingest. The fourth, a full build (run 41093420059), built and committed its data, then the Supabase copy failed (`fsie_source_files` does not exist in production; `supabase/football_situational.sql` has not been applied there). `actions/cache` saves only when every step passes, so its "Post Cached source downloads" was skipped and the derived seasons that build made were discarded. The market refreshes read only that cache.
- **The change.** `football-situational.yml` restores the cache with `actions/cache/restore@v4` and saves it with `actions/cache/save@v4` right after the engine stages, before the commit and the Supabase copy. A failed build still saves nothing.
- **Not fixed here.** The Supabase step fails on every run until the migration is applied to production. That is the owner's deployment.
- **Test.** `football/situational/tests/integration.test.js`: on the old workflow 25 passed and 4 failed (the 4 new checks); now 29 of 29. Each new check also fails when the save is moved after the Supabase copy, runs on `always()`, or uses a key the next run does not restore.
## 2026-10-30 — Franchise SQL: the founding-age spread is held on forty fixed rosters, not on one random roster per run

**What failed.** A full `npm run verify` on 2026-10-30 went red at `games-sql.yml` "Refuse a silent skip". The franchise SQL suite had stopped after 724 checks:

```
FAIL: and no one age dominates it, which is what made the wave — 13 of 38
```

Two re-runs of the same tree passed. Nothing in the game was wrong.

**Why.** The check read the founding roster of one fresh franchise. `franchise_create` gives every franchise a new random seed (`md5` of a random uuid and the clock), so the suite checked a different roster every run.

The generator (`franchise_generate_roster`, `career_v1`) spreads ages uniformly over 21 to 32, as its comment says. Over 3,000 generated rosters, the size of each roster's biggest single age matched a uniform draw of 38 over 12 ages in every bucket:

| biggest age group | 6 | 8 | 10 | 12 |
|---|---|---|---|---|
| expected | 1,180 | 292 | 24 | 1.1 |
| measured | 1,207 | 283 | 19 | 1 |

So a correct generator puts 13 or more of 38 at one age (over a third) about once in 12,000 rosters. It fails the neighbouring "spread across its whole age range" check about once in 52,000: no one aged 21 to 23, or fewer than eight ages. Searching seeds, the unchanged generator built such a roster, with only 7 distinct ages (seed `feaa68f2…`, the 10,758th tried). Both checks failed at random on a working game.

**The repair.** Test only (`tools/games/sql/games_franchise.test.sql`). No game code, data or threshold changed.
- The two claims are held on forty fixed seeds (`age-spread:1` … `age-spread:40`). `franchise_generate_roster`, the generator `franchise_create` calls and a pure function of its seed, turns them into the same forty rosters every run. Each must be spread across the range and have no age at a third or more, the same thresholds as before.
- A new check requires the forty together to be flat: every age of the range holds its even share of the 1,520 players, give or take 30% (measured: 104 to 145 against 127).
- The rosters are built and measured in a block that is rolled back, so no later check sees them. The fresh franchise is still created and still re-seeds the generator at random for everything after it.
- The fresh franchise keeps its deterministic checks: 38 founding players, every age inside the published range.

**Before and after** (`node tools/games/franchise_sql.test.js`, real PostgreSQL):

| | old test | new test |
|---|---|---|
| unchanged generator, the fresh franchise drawing seed `feaa68f2…` | FAIL: spread, `21,22,24,25,26,27,32` | PASS |
| mutation A: ages skewed young, `power(random(), 2)` | not run | FAIL: biggest single age 21 of 38 |
| mutation B: ages bunched on 21, 24, 27, 30 | not run | FAIL: fewest ages 4 |
| mutation C: a mild lean young, `power(random(), 1.35)` | not run | FAIL: biggest single age 16 of 38 |
| mutation D: off by one, age 32 never drawn | PASS (993): every age still sits inside the range | FAIL: not flat, 11 of the 12 ages |

The suite runs 999 checks, or 996 when the simulated first season earns no bowl. The bowl branch guards three checks; that was true before, when the counts were 996 and 993. The file has three more checks than before:
- the two spread claims moved from the fresh roster to the forty fixed ones;
- three are new: forty rosters of 38 were built, the forty are flat, and the fresh franchise has 38 founding players.
## 2026-10-30 — Methodology change (integrity guard, owner's decision): the Polymarket request budget settles a dead run's grant at what it may have used

**A change to the gateway's budget guard (AGENTS.md §3). It needs the owner's explicit review before it is deployed.**

- **Why.** A run that dies (out of compute, a 502 from the database) never calls `poly_api_settle`, so its whole grant stayed reserved for the rest of the UTC day.
  - On 2026-10-30 (stage report, run 41069288565), 56 tonight grants were never settled and held 22,215 requests. The day read granted 40,000 and used 17,785.
  - Every run after 09:55 UTC was refused (`denied_budget`), so Smart Money Tonight had no current holders.
- **What.**
  - Each run reports its requests so far every 20 requests (`poly_api_progress()`, a new table of the same name). The report never goes backwards, never exceeds the grant, and never lands after the settlement.
  - Under the day's lock, `poly_api_acquire()` first settles every grant still unsettled 15 minutes after it was given, at its last report plus 100, capped at the grant. Each is recorded as expired. A run lives at most about 7 minutes, so it is gone by then.
  - The day gets back only what the dead run cannot have used.
  - The daily ceiling (40,000) and the per-run cap (3,000) are unchanged, and `radar_rules()` is unchanged. `polymarket_sync` is build `.10`.
- **Tests, failing first.**
  - SQL 237 -> 245: two dead grants (no report: 100 of 400; reported 300: 400 of 900), a fresh one left alone, the day's totals (910 granted, 500 used), a late settlement changing nothing, and no client access. Before `poly_api_progress()` existed, the suite stopped on its first call.
  - Sync 83 -> 84: runs report in steps of 20, never more than they used. On the old function: 83 passed, 1 failed (no report).

## 2026-10-30 — NHL goalie sync: ESPN's probable goalies are a second starter source

- **What failed.** Daily Faceoff refused the function (HTTP 403) from 16:34 UTC; the 16:00 run had read it. More than three hours out it is the only source, so every run was a `sources_down` error and tonight's starters could only be confirmed by hand (`hockey/data/confirmed_starters.json`).
- **The source.** ESPN's public NHL scoreboard (`site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=<ET date>`) answers a plain request with each team's `probableStartingGoalie` and ESPN's status word. On 2026-10-30 it named all six starters (two Confirmed, four Expected); every name matched a rated goalie.
- **The change** (build `nhl_goalie_sync@2026-10-30.3`). The sync reads ESPN on its own cadence (pg_cron, every five minutes; runs at the due slots), for each Eastern date, and stores each probable goalie as an `espn` observation. Nothing is entered by hand.
  - ESPN's "Confirmed" is Confirmed, its "Expected" is Likely, as Daily Faceoff's words are read. A goalie only Expected never opens the edge gate or the lineup lock.
  - When ESPN and Daily Faceoff name different goalies, it is a conflict: Daily Faceoff leads, at Likely at most.
  - `sources_down` now needs Daily Faceoff and ESPN both unreadable. ESPN down alone is DEGRADED; a changed response shape is a DRIFT.
- **SQL.** `supabase/nhl_goalie_layer.sql` (and its migration copy) adds `espn` to the starters' source check; applying the file again replaces the check on the live table. It must be applied before the function is deployed.
- **Tests,** shown failing on the old code first:
  - core: 113/0 (the suite crashes on the old core);
  - sync: 104/0 (main's function at `761147e24`, which retries Daily Faceoff: 96/8; Daily Faceoff refusing is still `sources_down`, and there are no ESPN rows);
  - SQL on a real PostgreSQL: 85/0 (old 14/2: the old check refuses the `espn` row);
  - UI: 48/0 (old 46/2).

  ESPN's parser is tested on its real 2026-10-30 response, trimmed to the fields it reads.
- **Terms.** ESPN's response is public but unlicensed, like the ESPN NHL pack: the source registry names it beside Daily Faceoff for the owner's review before paid use.
## 2026-10-30 — Novig in production: DraftKings from the prices production keeps; ingestion only on a key Novig lists as read-only

- **What production showed.** Deploy run 41112694540 applied nothing. The layer's guard refused: `needs public.sharp_price_snapshots (the DraftKings tape): apply supabase/sharp_lag.sql first`. Production has no Sharp-lag tape. It keeps DraftKings in `book_quote_ticks` (capture's per-book history, joined to `signals` by `sig_key`), and only for actionable signals. The project's secret names (run 41113406385, names only) show `NOVIG_MANAGEMENT_KEY_ID` and `NOVIG_MANAGEMENT_PRIVATE_KEY` NOT set, and an unexplained `NOVIG_READ_KEY_ID` / `NOVIG_READ_PRIVATE_KEY` pair set.
- **DraftKings source.** `novig_market_data.sql` reads DraftKings through one service-only view, `novig_dk_tape`. It is built from the Sharp-lag tape where it exists, otherwise from `book_quote_ticks`. `novig_dk_price`, `novig_history`, the report, `novig_sync`'s line choice and the deploy check all read the view. Nothing is written to either source. Applied again after `sharp_lag.sql`, the layer switches to the full tape. The comparison's source line says which one is in use.
- **Least privilege, enforced.** `discover` and `snapshot` now run only after a probe in the last 30 hours saw Novig list the key as `management::read`. A `management` or `trading` key, or an unlisted one, is a FAILURE (`key_not_read_only`; it used to be a WARNING). Every later run is skipped (`scope_unverified`) and calls nobody. A newer refusal is never shadowed by an older pass.
- **Provisioning.** When the bootstrap cannot sign at all (the management key is not set), `whoami` exits 4: "Novig was never asked". It no longer reports that as Novig's answer. Not retried.
- **Tests.**
  - `novig_sql.test.js`: 65 → 74, adding a second real-PostgreSQL world shaped like production (`signals` and `book_quote_ticks` only). On the old layer: 2 failed, with production's exact guard error.
  - `novig_sync.test.js`: 44 → 50. On the old code the source check fails (`GET sharp_price_snapshots`), and a management key only warned.
  - `novig_bootstrap.test.js`: 22 → 23.

## 2026-10-30 — NBA injury report: two-line reasons go to the right player, and nothing is left unread

- **The 5 drift alerts in 24 h were a parser bug, not a format change.** They are `report_unread_lines`, from 2026-10-29 17:07 to 19:07Z, and each one is the line `"/ Bone Bruise"` (Jalen Suggs, ORL). The league's PDF centres each row vertically. A two-line reason prints one line above the player's row and one below it. A row cut by a page break carries its reason over to the next page. The parser knew only the "line above" case. So the line below a row was given to the next player, and a trailing line before NOT YET SUBMITTED was left unread. 56 of 92 official reports since 10-21 were affected. On 1,029 of 6,231 rows the stored reason text belongs to another player. Statuses and names were unaffected, so no projection was mispriced. The stored rows are append-only and were left as they are.
- **Fix** (`nba/injury/core.js` `nbaAssignWraps`/`nbaSolveWraps`, core `nba-injury-core-2026-10-30-1`; `nba_injury_sync@2026-10-30.1`, parser `nba-official-lines-2`). The parser assigns the wrapped lines for a whole run of rows at once. It prefers the centred layout and allows the page split. A layout that fits no split, or two splits equally well, is counted as unread, never guessed.
- **Names.** "Udeh, Jr., Ernest" now reads as "Ernest Udeh Jr.". An alias maps "Hansen Yang" to "Yang Hansen", checked against ESPN's POR roster (5217746). Michael Ajayi (CHA, two-way) is on no captured roster, so he stays unmatched. That is missing roster data, and no fuzzy match is made.
- **Freshness.** On 10-30 the league published nothing after 6:00 AM ET: every later slot answered S3 AccessDenied. Each run now records `details.official` (`newest_listed_at`, `read_url`, `tried`). System health keeps the two ages apart: a quiet league with a current sync is information, and a sync that has not checked in 75 min is attention.
- **Tests:** a new fixture `tools/nba/fixtures/nba_injury_report_wraps_2026-10-28_29.json` holds three real reports' line streams, with their expected reasons taken from page geometry. `nba_injury_core.test.js` went from 80/16 to 96/0. `nba_injury_sync.test.js` went from 41/1 to 42/0.
- **Deploy:** run Deploy NBA injury layer (`deploy-nba-injury.yml`).

## 2026-10-30 — Kalshi sync: a timed-out database read is retried; readiness always says why it is not ok

- **What failed.** The snapshot run at 09:20 UTC (`ec23a067…`) failed after exactly 20 s with "snapshot error: Signal timed out.". Its first database read (`kalshi_series?tracked=is.true`) stalled. Kalshi was never called and nothing was written. Every snapshot from 09:25 on succeeded (268 markets). `db()` retried Kalshi's 429/5xx answers but never a PostgREST read.
- **Fix** (`supabase/functions/kalshi_sync/index.ts`, build `kalshi_sync@2026-10-30.1`). A read (GET) is tried at most 3 times, after a timeout, a lost connection or a 429/5xx, with waits of 250 ms and then 500 ms. A write is never resent: `kalshi_price_snapshots` has no natural key, so a resent insert could duplicate rows.
- **Readiness** (`supabase/kalshi_market_data.sql` and its byte-identical migration mirror). One recovered failure held `kalshi_readiness` at `warn` for 24 h, with `state_reason` null. A failed run is now judged by what came after it:
  - 2 or more failed runs in 24 h: warn.
  - Not recovered: a snapshot is error, a discover is warn.
  - Recovering, with less than 30 min of good runs: warn, and the reason says so.
  - One failure followed by 30 min of good runs of the same mode: ok. It stays named in `recent_incident`, `last_failure_at` and `last_failure_message`, and it is still counted in `failures_24h`.
  - DEGRADED and DRIFT alerts still warn for 24 h.
  - `state_reason` is never null when the state is not ok.
  - New rule key `recovery_confirm_minutes` = 30.
  - `open_game_events_unmapped` reconciles events with markets. Each game event has 2 markets, so 231 unmapped events are 462 markets.
- **The 462 unmatched markets are not mapping faults.** All are CFB, all have the reason `no_book_event`, and none is a name or alias failure. The breakdown:
  - 118 events are FCS vs FCS, out of scope.
  - 113 events are FBS games with no book event in the capture:
    - 69 are on this week's slate, and an offline replay of the deployed linker links all 69, so the gap is in the CFB moneyline capture;
    - 32 carry Kalshi's placeholder date (`26OCT30` for Saturday games);
    - 3 have a TBA kickoff;
    - 8 are beyond the horizon;
    - 1 is FBS vs FCS.

  No matching rule was changed. The 6¢ spread exclusion and the trusted mid are untouched.
- **System health** shows `recent_incident` on the Kalshi row while the view reads ok.
- **Tests:** `kalshi_sync.test.js` went from 48/3 to 51/0. `kalshi_sql.test.js` went from 75/7 to 82/0; on the old view, five reads were warn with a null reason.
- **Deploy:** run Deploy Kalshi market data with `deploy_function` and `apply_sql`.

## 2026-10-30 — System health: every count names its subsystem, and the odds capture shows its real state

- **"Model health 21/22, 1 failing" was not a model failure.** `sysHealthState` added the NHL goalie sync's `error` into the football self-check's fail count, and the Model health row printed that count. In production that day the self-check had 22 checks: 21 passed, 1 warned (the NFL line guard), and none failed. Model health now counts the self-check alone (22/22, amber for its warning, which it names). The syncs still add to the header's count, and the header, its title and its aria-label name the subsystems the count is made of ("2 failing (database, NHL goalie sync)").
- **The odds capture read "unknown", and that was wrong.** The heartbeat came only from `public.signals`, which the paywall rule hides from a reader without access, so most accounts saw no row. The panel now also reads `rpc/odds_feed_status` (anon, security definer), and shows one of six states: healthy, delayed, paused, quota exhausted, degraded, or unknown (the status read failed: monitoring failed, not the feed). Production answers `paused` / `quota_unconfirmed`: the October quota was spent on 2026-10-10, and paid calls wait for the November cycle's quota to be confirmed (docs/odds-api-incident-2026-10/INCIDENT.md §9). The pause is now reported as such. "Last successful sync" shows a write on record or "none on record", never the time of the read.
- **Pipeline jobs "15/15" counted keys, not jobs, and could not see a failure.** It counted every `pipeline_meta` key (timestamps and row counts), and it compared the string statuses against `ok===false`. It now counts the six `<job>_last_status` jobs, and a status other than `ok` is attention, named.
- **Build freshness "68d ago" now says what the date means.** The football parameters (`edgedesk_football_v1.0.0`, `edgedesk_cfb_p4_v1.0.0`, trained through 2025) are fitted before each season and held fixed through it by design (model_loop/adapters/nfl/baselines/README.md: "refit before each season"). The ratings learn daily. The row reads `season-fixed`, beside the date results were absorbed through. Nothing was retrained.
- **The not-served learning loop** (MLB lab brain, research-only by governance: the card uses `mlb/engine.js`) is named with its reason under Research governance, not left as a bare count.
- **Kalshi** shows a reason when the view leaves `state_reason` empty ("1 failed run in 24 h, recovered").
- **Six sections:** model health, data sources, scheduled jobs, data quality and coverage, research governance, and historical performance (7 days). The NHL starter sources have their own row.
- **Entities.** The source data and the renderer never produced `&#x34;21 min`. In Chromium, the panel's text on production data holds no entity. What was missing were separators between the label, the note and the value. The row is a flex box, so the separators draw nothing, but without them the row's text ran together ("(game day)421 min") for anything that reads text rather than pixels, and the tool that produced the report encoded each value's first character. Each row now has the separators. Every value is still escaped exactly once (`edEsc`), and a reason that holds markup or an entity is shown as written.
- **Tests:** `tools/app/system_health.test.js` (new, run by Research OS tests). On the old `app.html`: 14 passed, 37 failed. On the new one: 51 passed, 0 failed. One static assertion in `tools/kalshi/kalshi_ui.test.js` was updated to the shared rule (an error fails, a warn asks for attention), and the new suite runs that rule.

## 2026-10-30 — NHL goalie sync: a Daily Faceoff page Cloudflare refuses is tried again in the same run

- **What failed.** The manual run at 16:34 UTC (build `nhl_goalie_sync@2026-10-30.1`) found both Daily Faceoff pages answering HTTP 403. The previous run, at 16:00, had read them. More than three hours before puck drop Daily Faceoff is the only source, so the run was `sources_down` and readiness went to error. The page is up: from a test container it answers 200 with the function's browser headers, and its parser reads it (3 games, 6 rows). With other headers it answers 403 with Cloudflare's "Attention Required!" page. The refusal is Cloudflare's bot protection, and it comes and goes. The function never tried a page a second time.
- **Fix** (`supabase/functions/nhl_goalie_sync/index.ts`, build `nhl_goalie_sync@2026-10-30.2`). Each page is tried at most twice more in the same run, after a 403, 408, 425, 429 or 5xx, a timeout or a lost connection. The waits are 2 s and then 4 s, plus up to 1 s of jitter, or the server's Retry-After, capped at 8 s. All the retries in one run share a 45-second budget. A 404 is not retried, and neither is a page that changed shape (DRIFT). A Cloudflare block page (its title or a `cf-mitigated` header) is named "Daily Faceoff blocked by Cloudflare bot protection (HTTP 403)". An empty 200 or a challenge served as 200 is never parsed into starters. Each page's attempts are kept in the run row. Unchanged: an unreadable page writes nothing, the starters on file stay, and nothing becomes Confirmed. Nothing carries over between runs.
- **Tests** (`tools/hockey/nhl_goalie_sync.test.js`). The fake network can script Daily Faceoff's answers call by call, with headers. The backoff records its waits instead of sleeping. 14 new checks cover: a 403 and then a 200 (read in the same run); a 429 with Retry-After and then a 503; a lost connection; a 404 (not retried); three refusals (an error run named as Cloudflare, nothing written, nothing Confirmed, the next run recovers); the stored starters untouched by a block, an empty 200 or a 200 challenge; the shared budget; DRIFT not fetched again. On the old function: 89 passed, 9 failed. On the fix: 98 passed, 0 failed.
- **Deploy:** after merge, run Deploy NHL goalie layer with `deploy_function`.
## 2026-10-30 — Novig provisioning: Novig's own refusal stops the run (no 451 retries); the card hook is defined in app.html

- **What was wrong.** The `whoami` step of `.github/workflows/novig-provision.yml` retried `provision.js whoami` up to 10 times on any failure. That includes the answer where Novig refuses the management key on both hosts with a 451 location check. Each try signs one echo per host, so a refused network would have sent up to 20 signed requests into 451s, and Novig warns that repeated 451 retries can lock the account. The workflow had never run.
- **The fix.** `provision.js whoami` now exits 0 when an environment accepted the key, 3 when Novig answered and neither did (each host's answer is printed), and 1 only when the transient bootstrap cannot be asked yet. The loop retries only 1; 3 ends the run at once.
- **The deploy check.** `deploy-novig.yml` gains a `verify` step. Its log is public (a public repository), so `tools/novig/deploy_check.js` prints only facts that are not prices: the tables, RLS, policies, grants, indexes, switches, jobs, rows by environment, a halt in force, and what a non-admin and the owner's admin account can read. Any `CHECK THIS` row fails the job. With `report_key`, the admin's actual view is added sealed (RSA-OAEP + AES-GCM), never printed. `provision.js whoami` shows subaccount ids by their first 8 characters only.
- **The card hook.** `window.fbNovigHTML` is now defined in `app.html` beside `fbKalshiHTML`, with the same guard. It returns `''` when the module is missing or throws. `lib/edgedesk_market_compare_ui.js` exposes `EDMarketCompareUI.html` and leaves the global to the page.
- **Tests.** `tools/novig/novig_bootstrap.test.js` gains 5 checks. On the old code, 4 of them failed (17 passed, 4 failed): the CLI had no exit codes, and the loop was `if node tools/novig/provision.js whoami; then …`. After: 22 passed. `tools/novig/novig_sql.test.js` runs the deploy check on real PostgreSQL (53 → 65): it is all `ok` on a correct layer, reports a halt, and reads `CHECK THIS` with display on or with anon granted a table. It writes nothing, prints no price, and the seal opens only with its private key. `tools/novig/novig_ui.test.js` goes from 38 to 41 and renders through the page's own hook. `tools/football/brief_wiring.test.js` passes 72/72 either way.
## 2026-10-30 — Prediction Radar: H-RADAR-02 registered, the page says whether its sync is current, and a stage-by-stage report

- **Why.** Smart Money Tonight showed nothing. On Polymarket's own data, the 18 wallets H-RADAR-01 graded "top" held one open position ending within 60 hours, on an uncovered esports market: those all-time leaders mostly no longer bet. The owner merged H-RADAR-02 (#924) and asked for the rollout to be finished and verified end to end, with the count at each stage and the point where it reaches zero, and with "sync pending", "sync failed" and "no current qualifying position" told apart on the page. No qualification rule changes.
- **Registered.** `research/radar/registration_h_radar_02.json` is frozen: EXPERIMENTAL, version 0.2.0, registered 2026-10-30 13:30:16 UTC. Its prospective window is 2026-10-31 00:00 UTC to 2027-01-23 00:00 UTC (84 days, fixed end), the day after registration and deployment as the registration requires. Its data-already-seen disclosure adds what was looked at since the draft: probe run 40982170115, production's H-RADAR-01 counts of 2026-10-30, and those 18 wallets' open positions.
- **The registry.** `tools/radar/build_registry_sql.js` writes both hypotheses into the research registry, and `registry_ref:H-RADAR-02` beside H-RADAR-01's. H-RADAR-01's block is unchanged, and so is its result row.
- **The sync state.** `radar_sync_state()` (internal) goes into the subscribers' door as `sync`:
  - *pending* means no grade under the live rules yet;
  - *failed* means the holders update ended in error or has not succeeded for 30 minutes, or a grade failed after the current one, or the current grade is over 36 hours old;
  - *ok* means both are current.

  The page says which, and with no card says "no featured bettor holds a position on tonight's covered games right now", with when the holders were checked. Observed Activity says the same under its own heading. These thresholds are presentation only.
- **The report.** `tools/radar/sql/radar_pipeline_report.sql` is read-only. Deploy Prediction Radar prints it last (`report`, on by default), together with the four schedules' last runs. It shows the rules, the hypothesis and the sync state, then the runs, discovery with exclusions by reason, the grade by style, the matched games, and every stage in order to the cards, marking where the featured path first reaches zero.
- **run_now** ends with one tonight run, so the holders and the cards are current at once. A failed tonight run fails the step.
- **The tonight runs stop dying (`polymarket_sync` build `.9`).**
  - What the report found on 2026-10-30 (run 41066621513): the holders sync had not succeeded since 2026-10-29 15:02 UTC. pg_net shows the function answering HTTP 546 (out of compute) 9 times, 500 five times and 502 five times, besides runs refused for the budget.
  - Each run rewrote every unmatched covered market (2,535 college football alternate lines) one request at a time.
  - Runs that die never settle their request grant, so they also held about 22,000 of the day's 40,000 requests (used: 17,785).
  - Now an unmatched market is written once per reason. Test: on the old code, the next run rewrote 301 of 301 unmatched markets; on the new, none (sync 81 -> 83).
- **Tests**, each failing first:
  - SQL 223 -> 237. On the old registry builder the new checks fail: 142 passed and 2 failed, with H-RADAR-02 not registered. Before `radar_sync_state()` existed, the suite stopped on its first call.
  - UI 84 -> 95. Before the change, 6 of the 7 new checks failed. The seventh, observed activity shown when nobody is featured, already passed.

## 2026-10-30 — Juice Reel: readers can connect while the PRODUCTION live test runs (methodology change)

**What was wrong.** Add a position and Accounts told every reader "EdgeDesk's Juice Reel application is awaiting Juice Reel's approval". That rested on the 2026-10-22 check, when Juice Reel answered 401. Today's check (Actions → Juice Reel setup → `check`, run 41091907710) says: *"Juice Reel accepted EdgeDesk's client id and secret (the application's owner: EdgeDeskSports)."* `start_live_test` (run 41092029965) then started PRODUCTION live test `eab424e0-44c5-4f47-b890-7be64e3d3ce7`.

**The change.**
- **Who may link (methodology change, the account owner's decision).** `portfolio_connect` admitted only operators under a running PRODUCTION live test. It now admits every signed-in reader under it. A reader cannot name a test: the server uses the running one. The database already admitted any grant under a running PRODUCTION test (`portfolio_svc_ag_allowed`), and is unchanged. When the test is finished, linking and scheduled syncs of those grants stop until the registry row is switched on, which still needs a PASSED ten-stage test and a cleared terms review (`portfolio_registry_guard`, unchanged).
- **No expiry.** A running PRODUCTION live test of Juice Reel used to lapse after 30 days (`portfolio_svc_ag_allowed`, `portfolio_svc_jr_smoke_current`). It now runs until it is finished. Other connectors' tests keep the 30 days. The 30-day freshness of the PASSED test needed to throw the switch is unchanged.
- **Wording.** "Awaiting provider approval" / "awaiting Juice Reel's approval" becomes **Not open yet**: Juice Reel opens with EdgeDesk's live test of the connection.
- `portfolio_connect` build `2026-10-30-jr5`. `app.html` loads the Portfolio page and the connector core at `?v=20261030jr5`.

**Evidence.**
- `tools/portfolio/juicereel.test.js`: three new checks. A reader under the running live test may connect and is not told the test. They start linking under the running test, whatever id they send. Once the test is over and the switch is off, they can no longer start. On the old gate: 193 passed, 2 failed. On the change: 195/0.
- The same suite: a live test started 45 days ago and still running still lets a reader connect, and the database still admits its grants. With the 30-day window: 195 passed, 1 failed. Without it: 196/0. `sharpsports.test.js` (which shares `portfolio_svc_ag_allowed`): 97/0.
- `tools/portfolio/juicereel_ui.e2e.js`: the reader sees Not open yet before the test, then a working Connect once it starts. 34/0.

**Deploy:** after merge, Actions → **Deploy Portfolio schema** with `deploy_function` ticked. It applies the SQL (the window) and deploys the function (the gate). Production still runs build `2026-10-22-jr3`, so the 2026-10-30 jr4 changes ship with it too.
## 2026-10-30 — Data pushes to `main` carry an "All checks" certificate, so `main` can require All checks of every pull request

**Why.** Nothing stops a pull request from merging while its checks are red or still running. #926, #928 and #930 merged within 11 seconds of their checks starting today, and `main` went red. The fix is one rule on `main`: require `All checks`. That rule also binds the 65 data jobs that push straight to `main` with `GITHUB_TOKEN`, and this account has no bypass that lets them through. GitHub refused the GitHub Actions app as a bypass actor ("invalid actor", 2026-10-27). A Write-role bypass still refused a `GITHUB_TOKEN` push (TEMP bypass probe, run 41092698463, `GH013: Required status check "All checks" is expected`).

**What.** `tools/ci/certified_push.sh` is `git push`, certified first when it updates `main` from GitHub Actions:
- the commit goes to a `ci-certify/…` side branch;
- the job's own token posts an `All checks` check run on it, titled "Data publish, not the pull-request gate" and naming the workflow and run;
- then the push, then the side branch is deleted.

Against a scratch ruleset with no bypass, that push was **accepted** where a plain one was refused (run 41094226276).
- `push_generated.sh` certifies every attempt, so the commit that lands is the one certified.
- The 12 workflows with their own `git push` to `main` now call the certifier. Each of these is a one-line swap with the same refspec.
- The 66 jobs that push to `main` get `checks: write`, in whichever permissions block is in effect for each job.
- Pushes to any other branch, and the suites' local repositories, are plain `git push`. A certificate that cannot be made never stops the push: it warns.
- `docs/ci/BRANCH_PROTECTION.md` and `docs/ci/main-ruleset.json` describe the rule: `All checks` required, bypass list empty, no pull-request rule (that rule binds direct pushes too, and no certificate can satisfy it).

**What it is not.** The certificate does what a bypass would. Data commits are no more checked than before. Any workflow with `checks: write` could post an `All checks` success, so the rule stops accidents, not someone faking the check.

**Not yet on.** The rule itself is a repository setting for the owner, after one data push shows the certificate. The steps are in `docs/ci/BRANCH_PROTECTION.md`, "Applying it".

**Tests.** `tools/ci/certified_push.test.js`: 32/0, against a real bare repository with a stand-in check-runs API. With `main`'s old `push_generated.sh` it fails (31/1: no certificate on the commit that landed). With the certificate on the wrong commit it fails 28/4. `tools/ci/push_generated.test.js`: 32/0, unchanged.

## 2026-10-30 — Game research test: the "lower" Kalshi check prices the home side from the model, not at a fixed 70.5

**What broke.** `tools/football/game_research.test.js` §14 put Kalshi's home mid at a fixed 70.5% and required the card to say EdgeDesk is "lower" on the home team. That held only while the first NFL game on the hourly slate had its home side under 70.5%. Once CAR at GB (69.6%) kicked off, the slate's first game became ARI at DAL (76.0%), and the card correctly said "EdgeDesk 5.5 pts higher on DAL". `main` went red with no code change (254 passed, 1 failed), and so did NFL model suites and Game research tests on every pull request that started them (#926, #928).

**The fix.** The fixture was nondeterministic: it depended on the hourly slate. The home quote is now one cent above EdgeDesk's home %, rounded down to the cent (a mid half a point to a point and a half above the model). The assertion is unchanged: the team is the home team and the sentence says "lower" by exactly that gap. On CAR at GB it is the same 0.70/0.71 quote as before. No code changed.

**Evidence.** Today's slate: before 254/1, after 255/0. Yesterday's slate (`84859411`): after 253/0. With each of the 28 NFL games on today's slate forced as the card's game, the "lower" check holds for 28 of 28. The fixed 70.5 held for 20 and failed 8. With "higher" and "lower" swapped in `lib/edgedesk_game_graphic.js`, the check fails.
## 2026-10-30 — NHL goalie sync: one slow database answer no longer fails a run

- **What failed.** The pg_cron run at 12:10 UTC hit a database request past its 20-second deadline ("Signal timed out."). The function's database helper had no handling for it, unlike the source readers, so the whole run became `sync_error`. Readiness keeps the last check's error until the next due slot (14:00 UTC). So NHL goalie sync failed every time it ran in between: run 23 at 13:18 failed with "readiness: the last check failed: sync error: Signal timed out."
- **Restored.** A forced run of NHL goalie sync at 13:23 UTC recorded a successful check. Readiness went back to warn (the standing "Confirmed by T-30" KPI), and the job passed (run 24).
- **Fix** (`supabase/functions/nhl_goalie_sync/index.ts`, build `nhl_goalie_sync@2026-10-30.1`). A read that times out or loses its connection is sent once more. A write is never sent twice: it may have landed, and every table is append-only. An HTTP error from the database is not retried either.
- **Tests** (`tools/hockey/nhl_goalie_sync.test.js`). The fake network can make a chosen database request throw Deno's `TimeoutError` ("Signal timed out."). Three new checks:
  - one timed-out read: the run completes with no sync error;
  - the same read timing out twice: still a named sync error;
  - a timed-out write: never sent again.

  On the old code: 82 passed, 2 failed, with production's exact error. On the fix: 84/0.
- **Deploy:** after merge, run Deploy NHL goalie layer with `deploy_function`.
## 2026-10-30 — Brief wiring test: a `window.fb*` hook defined by a script the page loads counts as defined

**What broke.** `tools/football/brief_wiring.test.js` §2 requires every `window.fb*` that `app.html` reaches for outside the football module to be defined by somebody. It looked for definitions only in `app.html`. Novig (#928) is the first hook defined by a script the page loads: `lib/edgedesk_market_compare_ui.js` puts `fbNovigHTML` on the page's global, and `app.html` names `window.fbNovigHTML` beside that script's tag. Collective suites never ran on #928, so `main` merged with that step red (71 of 72). Every pull request that starts Collective suites inherited the failure.

**The fix.** For a name not defined in `app.html`, the test runs each `/lib/` script the page loads that names it, in a bare global, and counts the name defined only if the script actually puts a function there. A script that only mentions the name does not count. No code changed.

**Evidence.** Before 71 of 72, after 72 of 72. Each of these still fails:
- page code outside the module reaching for a `window.fbNopeHTML` nobody defines (also with a loaded script that only mentions it);
- the Novig script tag removed from the page;
- the lib's `root.fbNovigHTML =` assignment removed.

## 2026-10-30 — Novig: DraftKings vs Novig at the price a stake actually gets (built and tested; not deployed)

- **Why.** A line's price is not what it costs. An exchange's best price holds only so much size, a larger stake walks the book, and a sportsbook's margin is inside its price. EdgeDesk now compares the SAME bet at DraftKings and at Novig, at the reader's stake, and says when it cannot.
- **What.** (`docs/novig/README.md`)
  - `lib/novig_signing.js`: NOVIG-V3 signing (Ed25519 and P-256 via WebCrypto, no package), 30/30 of Novig's published vectors.
  - `lib/edgedesk_venue_compare.js`: the executable-price engine in exact integer arithmetic (1¢ contracts, the price grid, per-fill fees half up to $0.00001, VWAP, partial fills), implied probability, hold on complete markets only, no-vig as an estimate, EV only through a model gate, freshness rules shared with SQL.
  - `lib/novig_market_map.js`: matching to `public.signals` on teams, home/away, kickoff, market type, period, exact line and orientation; anything else queued with its reason.
  - `supabase/functions/novig_sync` + `supabase/novig_market_data.sql` (+ cron, rollback, migrations): signed REST ingestion, append-only snapshots, links, the comparison against the existing DraftKings tape (`sharp_price_snapshots`), history, a research summary, readiness.
  - Credentials: a transient bootstrap and `novig-provision.yml` register a `management::read` key from the existing management key (public key only; the private key goes straight to Edge Function secrets).
  - `lib/novig_stream.js` + `tools/novig/stream_worker.js`: the websocket book channel, off until a persistent host and a `trading::read` key exist.
  - `lib/edgedesk_market_compare_ui.js` on the NFL/CFB cards (beside Kalshi), `lib/edgedesk_compare_cards.js` (seven PNG templates), `lib/edgedesk_lead_lag.js`, `admin/novig/`.
- **Gates.** Public display is OFF in the database (`novig_config.public_display`) and in code (`NOVIG_PUBLIC_DISPLAY_ENABLED = false`) until Novig's written permission is on record; until then only operators see Novig prices, and graphics are watermarked internal. Ingestion is off until `NOVIG_INGEST_ENABLED=true`. No model, ranking, threshold, grade or historical record changed; no order route exists.
- **Tests.** New suites, all green here: signing 98, venue compare 59, market map 34, novig_sync 44, bootstrap 17, stream 30, SQL 53 (real PostgreSQL), lead-lag 11, UI and graphics 38. `.github/workflows/novig.yml` runs them (category market-odds).
- **Not verified here.** No deploy, no signed call to Novig and no read of the production database were possible from the build environment (no Supabase or Novig credentials); real Novig prices were read only from Novig's unsigned public catalog for the test fixture.

## 2026-10-30 — Juice Reel: connect from Add a position, and no bet counted twice (look-alikes held for the reader's review)

- **What was already built.** Juice Reel's OAuth 2.0 + PKCE connection, sealed tokens, the refresh lease, the initial import, the `/bets/changed` sync, the 10-minute schedule and the Accounts panel (`docs/juicereel.md`). It is not live for readers: the registry row stays off until Juice Reel approves the application, the PRODUCTION smoke test passes and the terms review clears (§ 9). This change does not touch that switch.
- **The bug.** Connecting Juice Reel over bets the reader had already recorded counted many of them twice. The sync adopted a typed or imported bet only when exactly one matched within 15 minutes. It kept two identical bets apart and reported them, and it never compared a screenshot whose time was hours off, or a bet typed later. Both copies then counted in P&L, ROI, the record and every count.
- **The fix** (`supabase/portfolio_juicereel.sql` 2b, `portfolio_svc_jr_ingest`). A synced bet that resembles one of the reader's own records is no longer stored. It is HELD in `public.portfolio_sync_matches`, its newest copy kept, until the reader decides. A look-alike is the same book, the stake within a cent, the same price, and either:
  - placed within 2 hours;
  - placed within 36 hours with the same event start or a word of the pick in common;
  - the same event start, placed up to 14 days later.

  "The same bet" merges it into the record the reader picks. The record takes the Juice Reel id and figures, keeps its notes and journal, and keeps what it said before on the decision. "A different bet" stores it as its own position. Until then the reader's own record is the one counted. Nothing is merged without the reader, including the exact matches the old automatic adoption took: those are marked exact and can be confirmed together. The shared ingest gains `"adopt": false` for this, and SharpSports is unchanged.
- **Also.**
  - **Add a position** opens with **Connect Juice Reel** and its description. It offers only what the server allows: disabled with the reason before approval, the connection's state once connected. The manual and import options are underneath, unchanged.
  - **Accounts** counts the bets imported and the platforms they came from, both from the stored bets, and prompts the review when bets are held.
  - History and Open label each position's source quietly.
  - A Juice Reel bet's details show Juice Reel's own `clvPct`, labelled as Juice Reel's figure, never EdgeDesk's closing-line value or a Decision Grade input.
  - Odds or a line adjusted in Juice Reel are flagged.
  - The database enforces one position per reader and Juice Reel bet id.
  - New edge function actions: `jr_matches` and `jr_match_resolve`.
- **Tests.** On the code before the fix, the new reader-D scenario in `tools/portfolio/juicereel.test.js` failed. P&L went from +105 to +192.73 after connecting, where the fix gives +90: four bets were counted twice. That run had 140 passed and 11 failed. On the fix, `juicereel.test.js` gives 192/0 and `juicereel_ui.e2e.js` gives 33/0 in Chromium at 1280 and 390 px.

## 2026-10-30 — NHL goalie sync: the card table shows when the NHL boxscore listed each game's lineups

- **Why.** The card table's first run (01:39 UTC) showed that the lineup lock priced none of the night's games. Eight had started, and all eight were still at the slate's price. For every one of them both starters were Confirmed and the inputs carried the lineup block (35/35 games). That leaves the one input nothing showed: whether the NHL boxscore listed at least 12 skaters a side before puck drop. Each sync run records what every boxscore read saw (the timing probe, `nhl_goalie_sync_runs.sources`), but no job read it.
- **What.** `tools/hockey/sql/nhl_goalie_cards_check.sql` gives each card its game's boxscore reads, from the runs recorded from 4 hours before puck drop to an hour after:
  - the number of reads;
  - the minutes before puck drop at which both lineups were first listed (negative: after puck drop);
  - the last read before puck drop: its game state, the skaters listed a side and the starters flagged.

  NHL goalie sync's card table adds an "NHL boxscore lineups" column: "listed T−22 min", "listed T+4 min, after puck drop (…)", "not listed by T−3 (PRE, 0 / 0 skaters, 2 starters flagged; 7 reads)" or "not read". Its summary line also counts the started games whose lineups were listed before puck drop. Read-only, as before.
- **Tests.** On the code before this change: `nhl_goalie_sync.test.js` passed 80 and failed 1, and `nhl_goalie_sql.test.js` passed 80 and failed 2. On the change: 81/0 and 82/0 on a real PostgreSQL. The SQL suite records three runs whose probe has one game listed at T−30 and one never listed by T−21, and checks that each card reads only its own game's reads.
## 2026-10-30 — Research OS journey: the workspace's links are read once Market Foresight's card has its answer

- **What failed.** On #924, the Research OS browser job failed one check on the phone: "the workspace links Signals, Foresight and the Simulator for this game" found `["#signals/cfb","#simulator/cfb"]` (run 41008198329; 125 passed, 1 failed). The same check passed on the desktop in that run.
- **Why.** The game page draws its Market Foresight card as "Checking the record…", with no link, and `EDContext.railFill` adds the record's link when `mf_game` answers. The test read the links as soon as `#gvWs` appeared. Its step 4 already waits for that card to settle; this check did not.
- **The fix** (`tools/research_os/journey.e2e.js`, test only). Before reading the links, the check waits for the Foresight card the same way step 4 does. The assertion is unchanged.
- **Regression.** The test's PostgREST stand-in now answers `mf_game` 2 seconds late, every run, so the race is always exercised.
  - Before the fix, with the late answer: 124 passed, 2 failed (desktop and phone, `["#signals/cfb","#simulator/cfb"]`).
  - After: 126 passed, 0 failed.
- **How it reached `main`.** #924 carried the same change, byte for byte, and merged first; this entry records it.

## 2026-10-30 — Methodology change (owner's decision, DRAFT for review): Prediction Radar H-RADAR-02, featured bettors from complete recent histories, at what a follower pays

**Methodology change; needs the owner's explicit review. Not registered: its SQL is not to be applied until H-RADAR-02 is registered.**

- **Why.** H-RADAR-01 failed its holdout and left almost nobody to show. 172 of 200 wallets were excluded for histories longer than 30 pages. That left 13 qualifying wallets, 5 of whose top 10 scored below zero, and they bet on about 4 to 5 covered games a week. Smart Money Tonight is a paid feature that needs current research every day, without lowering any standard.
- **Evidence first** (`tools/radar/probe_h02.js`, from GitHub's runner, 4 runs).
  - There is no 90-day leaderboard. The 30-day board counts shares, not dollars, and was exact to the cent against wallets' own trades.
  - Its top is high-frequency wallets: about 3,000 pages for 90 days at rank 1.
  - Screening the top 300 separated the two groups: flagged wallets' 10th percentile is 64 position changes a day; unflagged wallets' 90th percentile is 58.
  - Polymarket's fee formula, confirmed from its documentation on 2026-10-30: the taker fee is shares × rate × (p × (1 − p))^exponent from each market's own schedule. Sports lists 0.05; the covered markets probed charge 0 today.
  - Every price Radar records is the midpoint, half a cent under the ask.
  - A newest-first read can be resumed with its cursor.
  - All of it is in `research/radar/H-RADAR-02/DESIGN.md`.
- **The rules** (`radar_rules()` version 2, `research/radar/registration_h_radar_02.json`, a draft).
  - Candidates come from the 30-day board. Each is read completely for 90 days, newest first; more than 30 pages is insufficient history, ungraded.
  - High-frequency (not followable) only when three known 24-hour samples each exceed 100 position changes a day.
  - The pool is the 200 evaluated wallets with the most covered-league dollars, each with at least 20 covered bets.
  - Grades follow at the midpoint plus 1 cent, plus the market's taker fee; a schedule that cannot be read is never guessed.
  - Featured: a Radar Score above 0, at most 10, fewer when fewer qualify.
  - The record publishes at the order book's best ask, plus the market's taker fee at it.
  - The prospective test runs 12 weeks, with a fixed end.
- **Built**:
  - the grading core (rules versioned: H-RADAR-01's frozen rules still grade exactly as before);
  - the SQL: rules, discovery state, fee schedules, version-2 bets beside version 1's, the featured guard, Observed Activity, the record at the ask, the current run of the live version, registration of the live hypothesis;
  - `polymarket_sync` build `.8`: discovery, the screen, the complete read, the pool, quotes;
  - the page: featured bettors, how many qualify, Observed Activity apart, discovery counts;
  - the docs (`docs/prediction-radar.md`, H-RADAR-02).
- **Tests**:
  - core 100 -> 130 (the fee against Polymarket's published fee tables);
  - SQL 199 -> 223 (the fee in SQL equals the core's; a card on a market charging the Sports rate is graded net of its fee);
  - sync rewritten for version 2, 81 (its cursor check fails without its fix: 79/1);
  - UI 72 -> 84;
  - browser 54 -> 56;
  - gateway 29 -> 30.
  - The version-1 sync suite passes 67/0 against the new function.
  - Applying the version-2 SQL over a version-1 database with data was checked on PostgreSQL.
- **Open before registration:**
  - the window's start date;
  - the registry builder for H-RADAR-02.

## 2026-10-30 — Football evidence test: a pull request reads "today's" research pinned on 2026-10-29; a daily sweep reads today's

**What kept breaking.** Two checks in `tools/content/evidence.test.js` read "today". S 3c checks every claim the evidence builder makes; section L checks every article the engine would offer. Both read today's committed research at the real clock, so `main` went red with no code change whenever new data exposed the writer:
- `1c3b5c07a`, 197 of 198;
- `c933dc468`;
- Week 9 on 2026-10-29, red until 20:15 UTC and again until 23:35.

Each time, every pull request that started Content engine was blocked until someone repaired the writer. The check was right each time: the writer was wrong.

**The repair.**
- **A pull request reads a pinned snapshot.** By default, S 3c and section L read `tools/content/fixtures/research_2026_w9.json.gz`: the research `main` held at `ca6f867a0`, read at 2026-10-29T20:14:42Z. That is the moment its own code blocked two Week 9 articles: the upset-watch preview (`injuries_addressed`) and Utah–Cincinnati (`numbers_in_evidence`).
- **It keeps the inputs, not the outputs.** It stores the research files and each game's evidence-builder inputs. `ART.fromFiles()` builds the packets with the code under test (`tools/content/evidence.js` `buildFrom()`), and the engine drafts from them.
- **It can't go stale silently.** `tools/content/fixtures/freeze_live.js` builds it. It trims what nothing reads and checks that the fixture, read back, gives byte for byte the evidence set, research, drafts and gate verdicts that the full files give. A new check requires the two Week 9 articles to still be drafted.
- **Today's research still runs daily.** `--live` reads today's committed research at the real clock (`--now` replays a moment). `.github/workflows/content-engine-live.yml` runs it daily at 12:41 UTC and by hand. Its red run blocks no pull request.
- **Nothing was weakened.** No check, gate, threshold or engine output changed. `ART.frozen()` and the Week 6 fixture are unchanged.

**Before and after** (`node tools/content/evidence.test.js`):

| | result |
|---|---|
| old test, `main`'s own code at `ca6f867a0`, clock at 20:14:42Z | 202 / 1: L, both Week 9 articles BLOCKED |
| new test, pinned, this code | 213 / 0 |
| … the wall clock at 2027-03-01 or at 2026-10-26 | 213 / 0 |
| … on `ca6f867a0`'s data instead of today's | 213 / 0, byte-identical output |
| … `lib/content_engine.js` as it was at `ca6f867a0` (mutation) | 208 / 5: L, the upset-watch preview BLOCKED |
| … `lib/football_evidence.js` as it was at `ca6f867a0` (mutation) | 208 / 5: S 3c and L, Utah–Cincinnati BLOCKED |
| `--live --now 2026-10-29T20:14:42Z` on `ca6f867a0`, this code | 212 / 0 |
| … with both files as they were (what the sweep would have said) | 203 / 9: S 3c and L, both articles BLOCKED |
| `--live` on today's `main` | 212 / 0 |

## 2026-10-29 — NHL goalie sync: the job lists every game's card, and whether the lineup lock priced it

- **Why.** On the first night of the lineup lock (#902), nothing on GitHub could say whether a game had locked. The job summary listed only the cards a run wrote, and pg_cron writes the lock. A dry run at 22:54 UTC, six minutes before the 7 PM ET games, changed none of the 14 cards: either they had locked already or they never would. And Supabase could not be reached from the agent's environment to read the cards directly.
- **What.** A read-only query, `tools/hockey/sql/nhl_goalie_cards_check.sql`, returns the current version of every game from 6 hours ago to 24 hours ahead (`public.nhl_game_cards_current`). NHL goalie sync runs it in a new step, and `tools/hockey/nhl_goalie_run_summary.js` lists the cards.
  - Each row has the puck drop, the version and when it was written (T−minutes), both statuses, the gate, the headline's home win %, and what priced it: "lineup lock" with the skaters listed and the slate's price before lock, or "slate" with its model.
  - Above the table: the started games, and how many were priced at lineup lock before puck drop.
  - The watchdog runs every half hour, so the night's locks can be read from it. Cards that cannot be read fail the job, as readiness does.
- **Tests.** On the code before this change, `nhl_goalie_sync.test.js` passed 78 and failed 3 (no cards table, an unreadable result passing, no empty-window line), and `nhl_goalie_sql.test.js` crashed (no query file). On the change: sync 81/0, and SQL 81/0 on a real PostgreSQL. The SQL suite checks that a locked game reads as "lineup lock" with its price before lock, that a slate card reads as the slate, that each game appears once, and that nothing over a day ahead is listed.
## 2026-10-29 — Trial emails: day 1 and day 3 wait when the board cannot be read

**What was wrong.** The trial email sender reads the live board, `public_home_board()`, once per run. When that call failed, it logged "emails go without live research" and sent day 1 and day 3 anyway, built from the committed `football/home/board.json` alone. That file carries no game lines, so:
- day 1 told the reader "No game clears EdgeDesk's research gates right now. PASS is a normal answer.";
- day 3 said "EdgeDesk re-priced 0 games … and priced 0 research-grade player props."

Both statements were made about a board nobody had read.

**What changed** (`tools/lifecycle/send.js`):
- **When the board call throws or answers without `ok`,** day 1 and day 3 are held: marked `failed` with "held: the board could not be read (…)". The next run retries them, at most three times, and `lifecycle_due()` already skips a tip that is more than a day late.
- **The welcome and the renewal reminder still go.** The welcome leaves out its board lines when there is no data, and the reminder is a billing notice that doesn't use the board.
- **A dry run** releases held rows, as it does every other row.
- **The run's summary line** now counts `held`.

**Tests.** `tools/lifecycle/lifecycle.test.js` §6 runs the sender with the board failing, with it answering without `ok`, in a dry run, and with it read normally.
- On `main`'s sender, 7 of those checks fail: all four emails go out, day 1 and day 3 included (66 passed, 7 failed).
- With this change, 73 passed, 0 failed.

## 2026-10-29 — Prediction Radar: the wallet sync grades only the bets the grade reads, and reads the wallets that can be top-graded first

- **Bug.** Smart Money Tonight showed "No top-graded bettor holds a position" because there was almost no one to show. `run_now` on build `.6` ([run 40916807612](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40916807612)) made 123 wallet calls in 2 h 45 m. At the end 6 of the pool's 200 wallets had been read in full, 6 were ranked and 1 was top-graded. The Radar record had no card to publish, so "How following has done" stayed at 0 graded.
- **Cause** (`supabase/functions/polymarket_sync/index.ts`, `wallets`).
  - Every resolved bet in a wallet's history was graded, at one or two price reads a bet. The grade reads only the newest 150 (`max_bets_per_wallet`).
  - Bets were graded while the activity read was still short of the present. Newer bets read later pushed them out of the grade.
  - Due wallets were taken by pool rank, which is by volume. So the busiest wallets were read first and kept the queue for dozens of runs each. Most of them (172 of 200 in H-RADAR-01) have truncated histories and can never be top-graded.
- **Fix** (build `polymarket_sync@2026-10-29.7`). A wallet's bets are graded only once its activity is read up to the present, and only the newest 150 resolved ones, newest first. The grade reads exactly these, so every grade is the same as before. Wallets whose history is not truncated are read before truncated ones. No rule in `radar_rules()` changes.
- **Visible change.** A trader page lists a wallet's newest 150 resolved bets from Radar's first read of it, and every one after. Before, it listed up to 500.
- **Tests** (`tools/radar/sync_fn.test.js`, with `max_bets_per_wallet` at 20 against a wallet with 63 bets):
  - a read stopped at 10 pages grades nothing yet;
  - once the read is complete, exactly the newest 20 bets are graded, in at most 4 runs;
  - a wallet that is not truncated is read before truncated wallets that rank higher and have waited longer.

  On the old code: 64 passed, 3 failed. It graded 20 bets before the read was complete, then all 63 over 5 more runs, and took the three truncated wallets first. On the fix: 67 passed, 0 failed.

## 2026-10-29 — Authorization change: Juice Reel `set_product *` opens every product of the seller, so buyers get access without its id

**Authorization change; needs the owner's explicit review.**

- **The problem.** After #906, a Juice Reel purchase opens only a product that is mapped by its id. Juice Reel shows a subscription product's id nowhere until someone has bought it. `check` on production reads "Product ids on Juice Reel's subscriber list: none yet", so EdgeDesk could not be mapped, and so could not be sold, without a purchase first.
- **The fix** (`supabase/juicereel_billing.sql`).
  - `billing_jr_tier_of_product` reads a product's own row first, then the row `*`: every product of this seller.
  - `billing_jr_set_product('*', …)` re-checks every linked buyer at once.
  - `billing_jr_products` no longer lists products that `*` covers as not mapped.
  - Report row 9 names `*`.
  - A product's own row still wins: a Bet Checker product mapped by its id never opens the terminal. A purchase naming no product is not covered.
- **The workflow** (`deploy-juicereel-billing.yml`).
  - `set_product` accepts `*` as the product id. Anything else outside letters, digits and `_ . : -` is still refused (`**`, `prod*`, quotes).
  - The summary shows "every product (*)".
  - Run against a throwaway PostgreSQL before committing: `*` → terminal mapped, and `set_mode on` then passes; `**` and `prod*` refused.
- **Tests** (`tools/billing/juicereel_billing.test.js` § 13).
  - `*` opens a buyer of an id nobody knew, at once and on a later return.
  - A product's own Bet Checker row wins over `*`.
  - `check` lists `*`.
  - Unmapping `*` ends what it alone granted.
  - On the old code: 110 passed, 3 failed. On the fix: 113 passed, 0 failed.
- **Production.** Deploy Juice Reel billing → `deploy`, then `set_product` with `product_id` `*` and `opens` `terminal`, then `set_mode` → `on`.
## 2026-10-29 — Content engine: a capsule says each quarterback listing once (two merged fixes said it up to three times)

**Why.** #904 and #907 fixed the same weekly-preview capsule in parallel, and the conflict resolution in `329df540e` kept both. Each quarterback listing was then printed up to three times, `no_repetition` blocked the Week 9 preview, and four content suites went red on `main`: evidence 209/2, core 331/5, edge function 21/8, weekly job 27/3.

- **Fix** (`lib/content_engine.js`, `capsuleEv`). It keeps #904's loop, which writes every conflict and every listed quarterback once per side, and removes the two lines and the trailing loop that #907 added. `capsuleEv` is now exactly #904's. `supabase/functions/content_engine/index.ts` was regenerated with `node tools/content/inline.js`.
- **Rounding is unchanged.** #904 prints 0.5185 as 51.9%, and #907's citation follows the printed text, so both say 51.9. Test S 3d now expects 51.9 instead of 51.8; it still requires the citation to equal the printed figure.

Tests: `tools/content/evidence.test.js` gains S 3e (each quarterback sentence in a capsule appears once).
- Against `main`: `FAIL | football evidence pipeline | 210 passed, 2 failed`, with the conflict sentence and the "listed as out" sentence repeated.
- After: evidence 212/212, core 336/336, edge function 70/70, weekly job 30/30.

## 2026-10-29 — Football situational browser suite: the FBS schedule is fetched when no local cache exists, so CI stops failing every `app.html` pull request

**Why.** `tools/football/fsie_ui.e2e.js` (Football situational tests, job `suites`) failed "the FBS board lists a game the artifact covers" on every pull request that touches `app.html`, and on `main` (`189bf8a75`): `9 passed, 1 failed`.
- The suite served the FBS schedule (`cfb_schedules_<year>.csv`) only from a local cache (`football/situational/.cache/raw/` or `football/fbs/.cache/`). Neither is committed, and the workflow never builds one. So on a runner the board's schedule request got a 404, the FBS board listed no games, and the four FBS card checks never ran.
- The NFL schedule already fell back to its published file. The FBS schedule now does the same, from the URL the page itself requests (`FBP4_URL_SCHED`), once per year per run. A local cache still wins when one exists.

Tests: the suite itself.
- On `main`: `FAIL | situational intelligence (browser) | 9 passed, 1 failed`.
- After: `PASS | situational intelligence (browser) | 14 passed, 0 failed` (the four FBS card checks now run).

## 2026-10-29 — Landing page: "Came from Juice Reel?" in the login and sign-up window

**Why.** A reader who bought EdgeDesk on Juice Reel and then tapped **Log in** on edgedesksports.com saw only an email and a password. Nothing told them their Juice Reel purchase could be linked, or that they needed an EdgeDesk account first. Linking existed, but only on the terminal's paywall and behind the landing band's **Bought on Juice Reel? Open EdgeDesk**.

- **The line** (`lib/edgedesk_juicereel_billing.js`, `landing`): above the form, **Came from Juice Reel? Link your Juice Reel account**. It is shown only while the Juice Reel switch is ON, and not to a reader already headed for Juice Reel's checkout.
- **Pressed**, the window keeps its own form and says Juice Reel opens after they log in or sign up, with **Undo**. It stands in for the lede, whose sign-up wording promises the card trial.
- **After sign-in** (a login, a sign-up, or an email confirmation), the reader goes to Juice Reel's authorize page through `juicereel_billing` (start `link`), then back through `oauth/juicereel-subscribe.html` to the terminal, as the paywall's link button does. The card trial's renewal terms never open, and no consent is recorded.
  - How: a `link` intent is stored beside the existing checkout intent, with the page's pending flag, so the existing `openArl` → `resume()` path carries it. **Undo** restores the pending flag as it was, so a reader who pressed **Start free trial** first still goes on to the trial.
  - If the switch has gone off before they sign in, they go to the terminal, where the paywall decides; never to the card trial's terms.
- **`index.html` is unchanged** apart from the library's `?v=` stamp: the page is 7 characters under its 216 KB budget. The line is drawn and styled inline by the library. `app.html` takes the same stamp; `tools/presentation/landing_asset_stamps.json` records it.
- Docs: `docs/juicereel-billing.md` § 4 and § 10.

Tests: `tools/billing/juicereel_checkout.e2e.js` gains the login window: switch OFF, then ON at 390 px and 1280 px (line → Undo → line → log in → kind `link` → terminal open), sign-up after **Start free trial**, Undo keeping the trial, the switch going off before sign-in, and a stale intent dropped.
- Against the old library: the run stops at the first new check (`#jrAuth` does not exist), exit 1.
- After: `89 passed, 0 failed` (was 50).

## 2026-10-29 — NHL goalie sync: a build stamp for the lineup lock, and the job summary shows the headline

- **Why.** #902 (the lineup lock) left two gaps. The function's build stayed at `nhl_goalie_sync@2026-10-25.1`, so after its deploy a `GET` could not tell the new code from the old. And the job summary's "Home win %" is the goalie pairing's number, so a lock never showed in NHL goalie sync or in the deploy's first run.
- **What.** `supabase/functions/nhl_goalie_sync/index.ts` answers `nhl_goalie_sync@2026-10-29.1`. Nothing else in the function changes. `tools/hockey/nhl_goalie_run_summary.js` adds a "Headline home win %" column, marked "(lineup lock)" once the card is locked, and labels the old column "(pairing)".
- **Tests.** `tools/hockey/nhl_goalie_sync.test.js`: the summary row carries the headline, and at lock it shows the lock price marked "(lineup lock)". On the old summary code: 76 passed, 2 failed. On the fix: 78/0. `docs/engine/NHL_GOALIES.md` §11 records the first deploy: Deploy NHL goalie layer run 4 deployed it, and its first run read the site's previous inputs, which the site had not yet replaced.

## 2026-10-29 — Changelog: eleven entries that merges dropped are back

Conflict resolutions in "Update branch" merges dropped whole entries again. Each one is restored verbatim from the last commit that held it. Every line on `main` is kept, except the second copy of one Prediction Radar entry, which a merge had duplicated.

- Football situational intelligence, apart from its "Tests:" list (merge `46c6060256d`, #903).
- Prediction Radar: run_now grades every 25 wallet calls (merge `46c6060256d`, #903).
- Prediction Radar: a wallet whose run dies part way is set aside (merges `1b1be847057` and `46c6060256d`).
- NHL methodology change: the headline is priced at lineup lock (merge `1b1be847057`, #902).
- Deploy Fairline: a regression test for the email switch step (merges `1b1be847057` and `91b1fe15116`).
- Juice Reel billing reads Juice Reel's confirmed answers (merge `91b1fe15116`).
- Methodology change (owner's decision): NHL favourites priced with the split factor fitted on the moneyline (merge `11000daf9da`).
- Methodology change: NBA and NHL game lines every two hours in the odds gateway (merge `73fcc93075d`).
- Fairline, part 3: The Tape (merge `a91cb0238c0`).
- Authorization change: the terminal's paywall, `has_active_sub()`, defers to the one access rule (merge `502dc44665f`, #890). The later entry on EdgeDesk's operators was a separate change and stays.
- Bet Checker says when sportsbook prices are paused: its heading survived, but merge `2ac8fc949b4` dropped its body.
- Prediction Radar: a grade reads only the price stretches it uses. #908 removed one copy of the duplicate and `23630b7fa9a` removed the other, so merge `dcf3ee7b028` left none. It is restored once, from `316a47722ff`, which added it.

## 2026-10-29 — Prediction Radar: run_now grades every 25 wallet calls and stops the wallet calls after 5 hours, so a long run never loses its grade

- **Bug.** `run_now` graded only once, after the last wallet call. On build `.6` ([run 40916807612](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40916807612)) the wallet calls were still going after 77 minutes, at about 76 s a call, with many wallets needing several calls. GitHub stops a job at 6 hours. A job stopped there would have ended before its grade, so the site would have shown nothing from all those calls.
- **Fix** (`.github/workflows/deploy-radar.yml`). A grade also runs after every 25 good wallet calls; it asks Polymarket nothing. The wallet calls stop after 5 hours, so the last grade runs well inside the 6-hour limit, and the 06:10 UTC schedule takes the wallets still due. A grade along the way that fails is a warning: the wallet calls go on, the last grade still runs, and the step ends red.
- **Test.** The workflow step was run against a stand-in function and a throwaway PostgreSQL. With the job stopped by a time limit (scaled down to seconds), main's loop made 19 wallet calls and no grade; this one stopped the wallet calls at its limit and graded. 31 wallet calls graded after the 25th and at the end. A failed grade along the way went on and ended red. The 546 and three-in-a-row cases are unchanged, and at most one call was ever in flight.
## 2026-10-29 — Props capture: the odds gateway refused the GitHub jobs' credential for 19 days, and said "deferred"

**Why.** Every player-props capture since the odds gateway went live (2026-10-10 14:29Z) was refused with `unauthorized`. The capture filed the refusal as `NOT_RUN / GATEWAY_DEFERRED`, so the workflow stayed green, the boards read "deferred", and no prop has been priced since 2026-10-10.

- **Cause.**
  - `supabase/functions/odds_gateway` compares the bearer byte for byte with its own `SUPABASE_SERVICE_ROLE_KEY`.
  - The repository secret `SB_SERVICE_ROLE` is a different string, though still a valid service-role key. In the same runs PostgREST accepts it for `rpc/odds_api_dashboard` (restricted to the service role) and for the props health record.
  - `tools/collective/odds_doctor.js` already documents this failure for a key in the newer `sb_secret_` format.
- **Fix (code).**
  - The three steps that call the gateway now also send the gateway's own shared secret, `ODDS_GATEWAY_SECRET`. The client already sends it as `x-odds-gateway-secret`, and the gateway already accepts it. The steps are `player-props.yml` capture, the `props-factory.yml` backfill and the `cfb-lab.yml` alternates.
  - `football/props/capture.js` now reports a refused credential as an **ERROR** (`GATEWAY_UNAUTHORIZED`), with a `::error::` naming the secret. It is not a deferral. It is still not a provider failure: no back-off, no failure count.
  - The credential registry in `tools/games/builder.test.js` lists the new secret, with its reason.
- **Fix (owner).** Code alone does not restore capture:
  1. Set `ODDS_GATEWAY_SECRET` on Supabase (Edge Functions → Secrets).
  2. Set the same value as a GitHub repository secret.

  `docs/odds-api-incident-2026-10/INCIDENT.md` §9 step 4 now says so.
- **Not changed.** The gateway's authorization check, budget, breaker and every other guard (AGENTS.md §3).
  - Paid retrieval stays paused until the 2026-11-01 reset and the runbook's re-enable.
  - Until then a working credential shows `PROVIDER_PAUSED` or a budget deferral, not prices.

Tests: `football/props/pipeline.test.js`.
- Against the old `capture.js`: `FAILED player props pipeline — 153 passed, 2 failed`. The run returned `["NOT_RUN","GATEWAY_DEFERRED","The odds gateway deferred the event index (unauthorized): no prop was requested."]`.
- After the fix: 155 passed, 0 failed.
- The `::error::` annotation prints the capture's error message, which first read only "odds gateway: unauthorized". It now names the secret and the runbook step. A third check failed on that (`155 passed, 1 failed`) and passes now: 156 passed, 0 failed.

## 2026-10-29 — Content engine: the evidence gate refused two correct week-9 articles and passed an incomplete one, from two writer bugs

**Why.** `tools/content/evidence.test.js` ("every article generated from today's research passes the gate") went red on `main` from data alone: 202 passed, 1 failed, at `c933dc468`, `adcb2b7f8` and `9957decf9`. Two articles were blocked, for two different reasons.

- **A number the claim itself prints was "not in the evidence"** (Utah at Cincinnati, `numbers_in_evidence`: 51.8, 44, 42.6). The gate was wrong.
  - A claim's printed figure and its citation number were rounded by two different functions: `pct1` (`toFixed`) for the text, `rnd` for `cite.nums`.
  - They disagree at x.x5. For example, 0.5185 prints as 51.8% but was cited as 51.9.
  - So an article quoting the claim word for word could not cite it, and the FBS average in the same sentence fell with it.
  - Today's research had 71 such claims out of 4,260, across third down, red zone, explosive plays, run blocking, early downs, efficiency, protection and the metric-conflict claims. One more claim cited a pick'em's 0.0 while printing "a pick'em".
  - Fix (`lib/football_evidence.js`): `metricNum` now derives from `metricText`, the same formatter the reader sees, so no printed number changes. `other_models` cites only a number it prints. All 4,260 claims are now consistent.
- **A starting quarterback listed out went unmentioned** (Kansas State at Colorado, upset watch, `injuries_addressed`: "Avery Johnson is listed as out on the Big 12 availability report"). The gate was right; the writer was wrong.
  - The weekly-preview capsule printed either a team's quarterback input conflict or its first official listing, never both. So the conflict about Jacob Knuth (doubtful) hid Avery Johnson (out).
  - Fix (`lib/content_engine.js`, `capsuleEv`): the capsule also prints every other quarterback listing and input conflict that the gate requires (`mustAddress`), and never repeats a player it has already covered. The single-game writer already did this.
- `supabase/functions/content_engine/index.ts` was regenerated with `node tools/content/inline.js` (its `--check` passes).

Tests: `tools/content/evidence.test.js` gains S 3b (a second quarterback listed out is named, and the gate passes), S 3c (every claim the current build makes cites only numbers its text prints) and S 3d (0.5185 is cited exactly as printed).
- Against `main`'s library logic: `FAIL | football evidence pipeline | 202 passed, 4 failed` (S 3b, S 3c, S 3d and the live check).
- After: `206 passed, 0 failed`.
- The frozen week-6 fixture keeps the citations its own build wrote: it is a record and is not rewritten.


## 2026-10-29 — Football situational intelligence (NFL + every FBS team): observed tendencies on the cards, four experimental volume models, SHADOW beside the existing models

**Why.** EdgeDesk's football models price games but do not describe how each team plays by situation (down and distance, field position, clock, score, script), or how much volume a team and its players are likely to get. This engine observes that from public play-by-play, and tests whether it predicts volume better than averages. The full write-up is `football/situational/README.md`.

**It changes no EdgeDesk number.**
- Every integration target is SHADOW: a labelled block with `applied_points: 0` beside the NFL slate, the FBS slate and both simulators.
- ACTIVE needs three locks, and no file in the repository opens the first.
- On today's real feeds, the NFL slate builder and the FBS coverage builder produce the same artifacts with `FSIE_MODE=OFF` and in SHADOW, apart from the block and clock stamps.
- No pricing file reads the layer (enforced by `tests/integration.test.js`).

- **A · ingestion and quality** (`football/situational/{nfl,cfb}/source.js`, `core/ingest.js`, `core/quality.js`).
  - Sources: nflverse (play-by-play, FTN charting, rosters, injury reports, team box) and the sportsdataverse ESPN college mirror. Every download is hashed and stamped, and a completed season is never fetched again.
  - Play, game and team gates: volume, situation and player validity are judged separately, and every rejection carries its reason.
  - NFL 2026: 107 / 107 games accepted, and pass and rush attempts match the team box on 214 / 214 team-games.
  - CFB 2026: 138 / 138 FBS teams, 561 of 570 games accepted (7 partial, 2 rejected, 0 missing).
  - Backfill: NFL 2015–2026, CFB 2014–2026.
- **B · observed tendencies on the cards.** `app.html` adds a *Situational intelligence* section to NFL and FBS game cards.
  - It shows season-to-date rates with their samples, the team's coverage tier and gaps, and a separate *Research Models (Experimental)* block with the holdout outcome.
  - The rest of the board is unchanged (`tools/football/fsie_ui.e2e.js`).
- **C · four EXPERIMENTAL models** (`core/volume_model.js`, `core/player_model.js`, `core/research.js`).
  - NFL and CFB team play volume; NFL and CFB player opportunity.
  - Preregistered and frozen before the 2025 holdout, which was evaluated once.
  - **All four failed their criteria and stay EXPERIMENTAL.** The team models beat season and recent averages on every target. Against market-only, CFB was better on all three targets; NFL was better on plays and pass attempts, but rush attempts crossed 0.
  - Both team models failed on bias, and the player models failed on bias and sample size.
  - A harness defect was found after the look. The holdout's interval coverage was simulated on the `formation` rung instead of the primary `pace_script`. It is recorded, not fixed: a labelled post-hoc file (`research/posthoc_interval_variant_<sport>.json`) changes no verdict, and the fix belongs to a v2 registration.
- **D · against the market and the existing forecast** (`core/market_study.js`).
  - On the 2026 props the pipeline captured (NFL weeks 4–5, CFB weeks 5–6; capture has been down since Oct 10), the line was as good as or better than the model.
  - Probability CLV was negative in every market.
  - The existing props model, the situational model and the line could not be told apart on shared rows.
  - Missing closes are excluded with their reason.
- **E · database** (`supabase/football_situational.sql`, `_rollback.sql`, `_registry.sql`).
  - 11 `fsie_` tables with write-once triggers, RLS (signed-in read, service write, no anon), pregame and CLV checks, and a shadow row that cannot apply points unless ACTIVE.
  - The registry records the four models as EXPERIMENTAL with their holdout results.
  - `football/situational/sync_supabase.js` copies insert-only.
  - **Not applied to production here (no credentials): NOT VERIFIED.**
- **F · automation.** `.github/workflows/football-situational.yml`: a daily build, an extra pass on Sun/Mon, a market refresh every 3 h, and the Tuesday prop study.
  - The suites run first.
  - `football-situational-tests.yml` runs every suite on a pull request (registered in `tools/ci/checks.json`).
- **Rollback.** Set the modes in `football/situational/config/integration.json` to OFF, or set `FSIE_MODE=OFF` for one run. Then disable the workflow, remove the `app.html` section, and run the rollback SQL. The steps are in the README.
- **The CFB freeze.** `football/fbs/build_coverage.js` is on the CFB champion freeze's pricing path. Its new guarded hook therefore gets the declared PATCH row `edgedesk_cfb_r1+p13`, appended by `football/cfb_validation/build.js`. No price moves. The validation dashboards are left as `main`'s scheduled build writes them; its next run regenerates them with `p13` in place.
- **Next scheduled builds.** The NFL slate and the FBS slate gain the SHADOW block on their next scheduled build.

Tests:
- `football/situational/tests/core.test.js` (69)
- `model.test.js` (44)
- `market.test.js` (22)
- `integration.test.js` (25)
- `sql.test.js` (35, real PostgreSQL)
- `tools/football/fsie_card_ui.test.js` (22)
- `tools/football/fsie_ui.e2e.js` (14, Chromium)

## 2026-10-29 — NHL methodology change: the headline is priced at lineup lock, from the dressed lineups and both Confirmed starters

**Methodology change; needs the owner's explicit review.** Evidence and the decision are in `docs/engine/NHL_GOALIES.md` §11.

- **What.** Until now an NHL card's headline was `xg_core` until puck drop, whoever dressed. Now the goalie sync (`supabase/functions/nhl_goalie_sync`) reads each side's dressed skaters from the NHL boxscore it already polls. Once both lineups are listed and both starters are Confirmed with no conflict, the card's headline is priced by `xg_all_confirmed`: the xG core plus the confirmed goalie and both clubs' confirmed lineup value. The card gets a new version (reason `lineup_locked`, trigger `inputs_changed`). The page, EdgeDesk vs the market, Check a price and the edge events read that price.
- **Evidence** (`hockey/validation/nhl_walkforward.json`). Log loss against `xg_core`: selection −0.00030 (9,205 games), confirmation −0.00119 (7,945), live +0.00008 (198). It fails the lab's rule 1 (0.001 on selection). Using it at lock anyway is the owner's decision.
- **Before and after on the committed slate** (33 games, each club's last lineup and the likeliest starters). The home win probability moves 1.7 pp on average, by 5.1 pp at most (OTT @ LAK, 47.6% → 42.5%). The mean distance from 50% goes from 8.34 pp to 8.46 pp, so this does not fix the favourite compression; the split factor does.
- **Unchanged:** the slate, its ledger and the public record, which grade the slate's `xg_core` price. Also unchanged: the SQL, and everything before lock.
- **Inputs** (`hockey/build_slate.js` → `hockey/goalie_inputs.json`): the variant's η without its goalie and lineup terms, each club's typical lineup value and last lineup, every skater's value, the betas and its own pair calibration. `--check` re-prices every game at lock from those inputs and fails unless it matches the build's own GLM path within 0.00015. All 33 games pass.
- **Timing.** The sync checks every 5 minutes from T−25 to T−5, after the T−30 final pass. Each boxscore read records the minutes to start, the skaters listed and the starters in the run's `sources`, a timing probe. When lineups post has not been measured live.
- **A failed read never unlocks.** The card keeps the lineups it locked with (`headline.lineup.ids`). A run whose boxscore read fails, or lists none, prices from them (`nhlgLockedLineups`). Found in review: before this, an NHL API outage after lock wrote a version `lineup_unlocked` and put the slate's price back minutes before puck drop. The regression checks failed on that code (core 103 passed, 1 failed; sync 75 passed, 2 failed).
- **Tests:** goalie core 104/0, sync 77/0, SQL 79/0 (PostgreSQL), block and gate 46/0, compare 55/0, engine UI 164/0 (Chromium, desktop and phone). With the page's lock price disabled, the engine UI fails 6 checks: the Overview headline, the Markets banner and the list card, on desktop and phone.
- **Not wired:** Today's Games and the matchup graphic still show the slate's price. Deploy: run NHL engine build, then Deploy NHL goalie layer with `deploy_function`.

## 2026-10-29 — Deploy Fairline: a regression test for the email switch step

**Why.** *Deploy Fairline*'s last step, "The Tape's email switch", read psql's answer as `t` followed by `UPDATE 1`, and compared it with the word `true`. So it reported `fairline_tape_settings was not updated` on every run, after the UPDATE had committed. The owner's run of 2026-10-29 14:19Z (run 40890282549) set the switch on and failed.

The step was fixed in the paywall change (`a5f15fb6600`, below): it now reads with `psql -X -q -At` and compares `t` / `f`. That change has no test of its own for this step.

**What changed.** New `tools/fairline/deploy_switch.test.js`:
- **What it runs:** the step's own script, read out of `deploy-fairline.yml`, with `bash`, against a real PostgreSQL carrying `fairline_tape_settings` as `fairline_tape.sql` creates it.
- **What it checks:** `on` and `off` set the switch and pass; a warning appears only when the email pipeline's own switch is off; a missing settings row or table fails.
- **Where it runs:** in Fairline CI's database job (the workflow now also starts on `deploy-fairline.yml`), and in Deploy Fairline's tests before anything ships.

**Evidence.**
- On the step as it was before the fix (`78a8315b4ac`), 5 checks fail, each with the production error.
- On `main`'s fixed step it passes 10 / 0.

## 2026-10-29 — Prediction Radar: a wallet whose run dies part way is set aside, never blocking the pool; run_now grades whatever happens

- **Bug.** `run_now` on build `.5` ([run 40905865196](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40905865196)) made 32 wallet calls in about 76 s each, all HTTP 200. The 33rd got HTTP 546, out of compute. A run that dies cannot record anything, so that wallet stayed first in line, and every later call, the 06:10 UTC schedule included, would have died on it. `run_now` also stopped before its grade, so nothing reached the site.
- **Fix** (`supabase/functions/polymarket_sync/index.ts`, build `polymarket_sync@2026-10-29.6`). Each wallet is marked (`attempt_at`, `attempts` in its cursor) before its work, and the mark is cleared when the work ends. A wallet still marked was in a run that died, or one in flight: it is set aside for 15 minutes, and after 3 such runs read only once a day. A WARNING `wallet_skipped` names it.
- **run_now** (`.github/workflows/deploy-radar.yml`) carries on after a failed wallet call, since the function now sets that wallet aside. It stops after three failures in a row, always runs the grade, reports how many wallets are set aside, and ends red if any call failed.
- **Tests.** `tools/radar/sync_fn.test.js`: a wallet whose run died 2 minutes ago is set aside and the next wallet read; after 15 minutes it is read again, marked before the work starts, and its mark cleared when done; after three dead runs it is read only once a day. On the old code: 61 passed, 3 failed. On the fix: 64 passed, 0 failed. The workflow step was run against a stand-in function and a throwaway PostgreSQL: one HTTP 546 among the calls went on, graded and ended red; three in a row stopped, graded and ended red; a normal run ended green; at most one call was ever in flight.

## 2026-10-29 — Content engine: two Week 9 articles the gate blocked on main now pass it (the writer, not the gate, was wrong)

- **What failed.** `node tools/content/evidence.test.js`, section "L live", on `main` since the Week 9 data landed. Two of today's generated articles were BLOCKED by the editorial gate: the upset watch (`injuries_addressed`) and the Utah at Cincinnati matchup piece (`numbers_in_evidence`). The gate was right both times, so it is unchanged.
- **Rounding** (`lib/football_evidence.js`). Utah's early-down success is 0.5185. The claim's text printed it with `toFixed` as 51.8% (0.5185 × 100 is stored as 51.849999…), but its citation used EdgeDesk's rounding, half away from zero: 51.9. So the sentence did not cite its own claim, and 51.8, 44 and 42.6 counted as numbers from nowhere. `pct1` now rounds as `f1` and the citation do.
- **Quarterbacks** (`lib/content_engine.js`, the weekly-preview capsule). Kansas State's Big 12 report listed Jacob Knuth doubtful (the starter EdgeDesk's model expects, an input conflict) and Avery Johnson out. When a side had a conflict, the capsule wrote it and dropped every other report line for that side; otherwise it kept only the first. It now writes every conflict and every quarterback on a report, which is what the gate requires (`mustAddress`, as the upset list and the gap paragraph already did). A conflict's own quarterback is not repeated.
- **Tests** (`tools/content/evidence.test.js`). Section R builds a packet from Utah's and Cincinnati's early-down rates and requires 51.9%/44.1% and a self-citing sentence. Section K adds a second quarterback listed out beside the Vanderbilt conflict in the frozen Week 6 slate, and requires the capsule to say so and the slate to pass. On the old code: 202 passed, 6 failed (R ×2, K ×3, L). On the fix: 208 passed, 0 failed.
- `supabase/functions/content_engine/index.ts` carries the two libraries verbatim and was regenerated with `node tools/content/inline.js`. The editorial page (`admin/content/index.html`) loads both with new stamps, so a browser does not keep the old writer. The committed `football/evidence/packets.json` is left to its own build, the scheduled editorial job.

## 2026-10-29 — Juice Reel billing reads Juice Reel's confirmed answers: isCurrentlySubscribed decides

**Why.** Juice Reel approved the webhook on 2026-10-29 and pointed to its API docs for the shapes EdgeDesk had guessed (`docs/juicereel-billing.md` § 9). Tracing the documented answers through `supabase/functions/juicereel_billing` found four ways to get access wrong:
- **`isCurrentlySubscribed` was never read.** Access followed `expiresDate` alone, so a list entry Juice Reel marks `false` with a future date (a refund) would let a buyer in. The hourly reconcile would then re-grant it every hour.
- **The subscriber list holds everyone who ever subscribed**, a buyer's older entries included. The link check stopped at the buyer's first entry, so a returning buyer whose ended entry is listed before the current one was told "not subscribed".
- **The reconcile counted every listed buyer as present**, so the "paid here, not on Juice Reel" alert could never fire.
- **Webhook events carry `isCurrentlySubscribed` too.** A purchase or renewal event saying `false` would still have granted access.

**What changed** (`supabase/functions/juicereel_billing/index.ts`, build `juicereel_billing-2026-10-29-1`):
- `isCurrentlySubscribed` decides, on the status answer, each list entry and webhook data.
- A bare yes with no subscription is not a purchase. Status answers `{isCurrentlySubscribed: true}`, with nothing else, to the application's owner, and linking the seller's own Juice Reel account opens nothing.
- The link check reads the buyer's whole entry list.
- The reconcile counts as present only buyers Juice Reel says have access now. It still never cuts anyone off; it raises the alert for a human.
- An event saying `isCurrentlySubscribed: false` ends access, whatever its type or `expiresDate`.

**The fake** (`tools/billing/_fake_juicereel_billing.js`) now answers in the documented shapes by default. That covers the owner's bare yes, a bare no for expired or never-subscribed buyers, the full one-page list with older entries first, and new `refund()` and `history()` helpers. The shapes guessed before stay available.

**Tests:**
- `tools/billing/juicereel_billing.test.js`: **90 passed, 0 failed** on a real PostgreSQL. Against the old function, the 4 new checks fail and everything else passes: 86 passed, 4 failed. The checks that fail on the old code are the refund, the returning buyer, the `false` event and the reconcile alert. A fifth new check, the owner's bare yes, passes on both.
- `juicereel_client.test.js`: 25 passed, 0 failed.
- `juicereel_checkout.e2e.js`: 50 passed, 0 failed.
- `fairline_tier.test.js`: 72 passed, 0 failed.
- `verify:core`: green.

**To apply.** After merging, run **Actions → Deploy Juice Reel billing → deploy**. The function's health answer then reads build `juicereel_billing-2026-10-29-1`.

## 2026-10-29 — Prediction Radar: a grade reads only the price stretches it uses, and a wallets run holds at most 10 activity pages

- **Bug.** The first `run_now` on build `.4` ([run 40902894704](https://github.com/dsrackler17/EdgeDeskSports/actions/runs/40902894704)) answered four wallet calls in about 75 s each (HTTP 200, 131 to 172 requests), then got HTTP 546 on the fifth: "Function failed due to not having enough compute resources". A run fetched every bet's price history a point a minute, from 15 minutes before the entry to the start. A bet placed days early is thousands of points, and up to 150 bets a run. It also held up to 30 pages (30,000 rows) of a wallet's activity at once.
- **Fix.** The grade reads only the follows' stretch ([entry − 6, entry + 16] minutes) and the close's ([start − 61, start + 1]), two short reads; a bet placed shortly before its game is one read, as before. `R.priceAt` takes the last point at or before its moment, at most a gap older, so the grade is identical. A wallets run holds at most 10 activity pages; the 30-page cap still counts across runs. Build `polymarket_sync@2026-10-29.5`.
- **Tests.** `tools/radar/core.test.js`: 3,000 random bets graded from only those stretches come out exactly as from the whole history, and each stretch is at most 62 minutes. `tools/radar/sync_fn.test.js`: every price read is at most 62 minutes, and a never-ending history is read 10, 10 and 10 pages, then truncated. On the old code: core failed (no `R.gradeWindows`); sync 58 passed, 2 failed (reads of 136 minutes; 30 pages in one run). Fixed: core 100/0, sync 60/0.

## 2026-10-29 — Prediction Radar: a wallets run answers within Supabase's 150 s limit, and finishes a big wallet over several runs

- **Bug.** The first live wallets call (run_now, 15:06 UTC) got HTTP 504, "Request idle timeout limit (150s) reached". One run took three new wallets: up to 30 activity pages each, then every resolved bet's price history (up to 150 a wallet). That is minutes of requests, and a function must answer within 150 s. The overnight schedule runs the same calls, so it would have stalled the same way.
- **Fix** (`supabase/functions/polymarket_sync/index.ts`, build `polymarket_sync@2026-10-29.4`). After 75 s a wallets run starts no new wallet, activity page or graded bet. A wallet it did not finish stays due, with its place kept: the activity cursor, plus `first_pages` while the first read is cut. The next run carries on. The 30-page cap counts pages across runs, so a history is still marked truncated only when it really passes 30. Trades and bets are still stored once each.
- **Test** (`tools/radar/sync_fn.test.js`). A fake clock, where every Polymarket request costs 4 s. A wallet joining with 63 bets to grade must be graded over several runs, each within 79 s, ending with all 63. A history that never ends, cut by time, must keep its page count and be marked truncated only at 30 pages. On the old code: 55 passed, 4 failed (one run took 256 s; 30 pages read at once). On the fix: 59 passed, 0 failed.
- **run_now** allows up to 300 wallet calls, since a call may now finish only part of a wallet. The day's request reserve still stops it first.

## 2026-10-29 — Prediction Radar: Deploy Prediction Radar can run the overnight work now (run_now)

- **What.** `.github/workflows/deploy-radar.yml` gains `run_now`. It calls the live `polymarket_sync` for the pool, then for wallets (3 a call) until none is due, then for the grade, instead of waiting for 06:07–10:17 UTC.
- **One call at a time.** Each answer is awaited before the next call, as pg_cron's 5-minute spacing does overnight. Two wallet calls at once would pick the same wallets.
- **The day's budget.** The wallet calls stop while fewer than `run_now_reserve` (default 8,000) of the day's 40,000 Polymarket requests remain, read from the gateway's own ledger. The 10-minute tonight runs keep theirs, and the 06:10 UTC schedule takes any wallets still due.
- **Checked** against a stand-in function and a throwaway PostgreSQL before committing. A normal run went pool, wallets 3/3/2/0, then grade. With 5,000 requests left, no wallet call was made. A failing call stopped the run red. Calls never overlapped (at most one in flight).

## 2026-10-29 — Prediction Radar: the tonight sync looks markets up 100 at a time (production failed "Invalid URL")

- **Bug.** The first production `tonight` runs (13:50 UTC on) ended in `error`: "tonight error: Invalid URL https://…/rest/v1/poly_markets?select=…&condition_id=in.(…)". The run looked up every market it saw in one request. On a full slate that URL is longer than fetch takes (65,534 bytes), so nothing was matched, no holders were read and no card was drawn.
- **Fix.** `supabase/functions/polymarket_sync/index.ts` makes that lookup 100 ids a request, as the run's two other lookups already did. Build `polymarket_sync@2026-10-29.3`.
- **Test.** `tools/radar/sync_fn.test.js`'s fake network now refuses a URL over 65,534 bytes, as Deno's fetch does. A new check runs `tonight` on a full slate of 1,200 more markets. On the old code: 54 passed, 1 failed, with production's error. On the fix: 55 passed, 0 failed.



## 2026-10-29 — Methodology change (owner's decision): NHL favourites priced with the split factor fitted on the moneyline (b 0.90 → 1.125)

**What changes for readers.** Every 2026-27 NHL price now uses the pair recalibration's split factor fitted on the moneyline. Favourites move up 1.58 points on average across the 33 games on the slate. Examples (fair price, before → after):

| Game | Favourite | Before | After |
|---|---|---|---|
| VAN at SJS | SJS | −133 | −142 |
| NYI at MIN | MIN | −146 | −161 |
| CBJ at CAR | CAR | −186 | −218 |
| CGY at COL | COL | −262 | −335 |

Near-even games barely move (PIT −104 → −105). Expected totals move by at most 0.01 goals.

**Why.** This is the cause measured in the entry below. The goal-split fit gave 2026-27 a split factor of 0.90, the lowest since 2013-14. It priced every favourite short of DraftKings: 35 of 47 settled games, mean gap 2.2 points, market slope 1.215 (1.036–1.394). The owner directed the switch the same day.

**What it does not meet.** It is a methodology change against the out-of-sample record:
- On 2021-26 the moneyline fit is +0.00027 log loss (−0.00013 to +0.00063) against the rule it replaces.
- It fails the lab's promotion rule (§1).
- It was promoted before its own pre-registered rule could decide (`rule_status` IN_PROGRESS).

The record says all of this. It does not close the club-strength gaps either: Vancouver and Minnesota are rated differently by the market, and that is most of the SJS and MIN distance from DraftKings.

**What changed.**
- `hockey/model/split_shadow.js`: `PROTOCOL.promoted` and `promote()`. The shadow stops pricing, since it is now the price. Its 33 frozen ledger rows stay and are graded. The live record reads PROMOTED.
- `hockey/model/walkforward.js` (amendment in its header): the season in progress takes the promoted `b` for every model, keeping `a`, `c` and the goal-split value as `goal_split_b`. Completed seasons keep the goal-split rule.
- `hockey/lab/base.js`: the live season is priced the same way, so the lab and the diagnostics match production.
- Rebuilt with their own builds: `hockey/model/params/live.json` and `hockey/validation/nhl_walkforward.json` (`walkforward.js --no-cache`, after `ingest/lineups.js`).
  - `live.json` differs only in `generated_at` and the nine `b` values (0.85–0.925 → 1.125).
  - Selection, confirmation, every completed season, the model choice, the comparisons and every market status are byte-identical. The live window (198 games) moves from LL 0.66324 to 0.66309, slope 1.452 to 1.155.
- `simulator/data/nhl_strength_uncertainty.json`, re-run (`simulator/src/research/nhl_strength_uncertainty.ts`): it is tied to `live.json`'s hash.
- `hockey/validation/nhl_split_shadow.json` (`--live`): PROMOTED.
- `docs/engine/NHL_LAB.md` §6.3: the amendment.

**Evidence.** The slate was built before and after at its own `generated_at` (2026-10-29T06:25:48Z):
- every new production moneyline and home −1.5 equals, to the digit, the shadow price main already published for that game;
- the old build equals the committed slate.

The published slate changes at the next NHL engine build after merge. The model id stays `edgedesk_nhl_v1:xg_core`, because the goalie layer enforces that prefix. The switch shows in `slate.model.pair_calibration` (`b` 1.125, `goal_split_b` 0.9, `split_basis`).

**Tests.** `tools/hockey/nhl_v2.test.js`: 147 pass (5 new checks). The rule tests now read `rule_status`.
- The season in progress takes 1.125 and keeps `a` and `c`.
- A completed season and an identity calibration are untouched.
- Promoting twice keeps the first goal-split value.
- The committed live parameters publish 1.125 for every model the slate prices with.

## 2026-10-29 — Authorization change: EdgeDesk's operators keep the terminal under the paywall rule

**Authorization change; needs the owner's explicit review.** The first `paywall_rule = dry_run` against production refused, and nothing changed. One account had the terminal through production's old `has_active_sub()` without a `subscriptions` row, and the rule alone would have locked it out. The owner chose to keep operators in.

- **`supabase/paywall_rule.sql`** (and its mirror): `has_active_sub()` is the rule **or** `billing_is_admin()`, the business consoles' existing operator list (the partner-program admins, else the problem-report admins, else the founding operator). It is still never red or black for anyone else. A new report row 04 checks it.
- **`tools/billing/sql/paywall_after.psql`**: a refusal now also names the accounts it protects, masked as the billing logs mask them (the first 8 characters). If the account is not an operator, the next dry run refuses again and says which.
- **Tests**: `paywall_rule.test.js` 29 / 0. An operator with no row keeps the terminal and reads `signals`; everything else is as before. Mutation: the fix without the operator clause, 26 passed, 3 failed.

## 2026-10-29 — Bet Checker says when sportsbook prices are paused

**Why.** The odds account's October credits ran out on 2026-10-10, and paid price refresh is paused until the reset on 2026-11-01 (`docs/odds-api-incident-2026-10/INCIDENT.md`). Meanwhile most fair prices are older than the 6½ hours a grade accepts, so most bets logged on Bet Checker are saved Not graded, and nothing on the page said why. The owner asked for a notice (2026-10-29).

**What changed.**
- **The page** reads the public `odds_feed_status()`, the same read the terminal's banner uses. While it says `paused`, a notice above the sign-in and the form tells everyone, signed in or not, what that means for a bet logged now:
  - it is still saved;
  - it is graded only on a fair price under the rules' age;
  - otherwise it is Not graded, which uses no free grade;
  - a game that starts before prices refresh may show No close available.
- **The title** names November 1 only while that date is ahead.
- **It goes away on its own** when the feed is live again, whenever buying resumes.
- **It fails soft:** a failed read shows no notice, never an error.
- **Files:** `lib/edgedesk_bet_checker_core.js` (`feedNotice()`, `hoursText()`), `lib/edgedesk_bet_checker.js`, `bet-checker/index.html` (stamps `20261029bc4`), `lib/edgedesk_bet_checker.css`, `docs/bet-checker.md`.

**Tests.**
- `core.test.js` 60 / 0.
- `page.test.js` 52 / 0: read with the page's key, never a token; live, a 404 and a network failure show none.
- `page.e2e.js` 64 / 0: a signed-out visitor and a signed-in reader see it while paused, and it is gone after a reload once the feed is live.
- On `main`'s page code the core suite crashes (no `feedNotice`), the wiring suite throws (no `loadFeed`), and the browser suite fails 2.



## 2026-10-29 — Authorization change: the terminal's paywall, `has_active_sub()`, defers to the one access rule

**Authorization change; needs the owner's explicit review.** *Deploy Fairline*'s read-only paywall check ran against production. It reported `has_active_sub(): RESTATES THE RULE`. The function gates the Research Terminal's data (the RLS on `signals`, and the readers in `kalshi_market_data.sql`, `sharp_lag.sql` and `radar.sql`), and it read `subscriptions`' status itself. A status-only check cannot tell what a price sells, so **a Bet Checker (red) or Fairline (black) subscription would have read the terminal's data**. Stripe holds no red or black subscription (all 30 read, 8 active, all terminal prices), so nothing had leaked. The Fairline prices stay inactive until this is fixed.

- **`supabase/paywall_rule.sql`** (mirror: `migrations/20261029140000_paywall_rule.sql`) replaces its body with the rule itself: a reader has the terminal when one of their `subscriptions` rows passes `billing_row_grants_access()` (blue, a comp, or a price never learned; never red or black). It is the definition `fairline_tier.test.js` has always tested against. `CREATE OR REPLACE` keeps its owner and grants, and no policy changes. It ends in a report.
- **`deploy-fairline.yml`** gains `paywall_rule` (`dry_run` or `apply`). In one transaction it records every account's answer before (`tools/billing/sql/paywall_before.psql`), applies the fix, and records every answer after (`paywall_after.psql`). It prints counts only: granted before and after, gained, lost, and why each lost it (a Fairline row, a Bet Checker row, a lapsed or unpaid row). It refuses to commit, and changes nothing, if an account would lose access through something other than a `subscriptions` row, which the rule cannot see. A dry run always rolls back. The same file fixes the Tape email switch's check (psql answers `t`, not `true`).
- **Tests**: `tools/billing/paywall_rule.test.js` (27, new, real PostgreSQL; in `fairline-tests.yml`).
  - Before the fix, production's shape lets black and red read `signals`.
  - After it, they never do. Blue, comps, an unlearned price and a `past_due` row in its 21-day grace do, as the rule says.
  - Lapsed, cancelled and no row never do. It agrees with `community_is_entitled()` for every account, and anon still cannot run it.
  - The comparison counts and names the losses. It refuses access the rule cannot see, and a dry run changes nothing.
  - The deploy's paywall check fails before the fix and passes after.
  - Mutations: the fix restating the statuses, 17 passed, 10 failed. The comparison never refusing, 25 passed, 2 failed.



## 2026-10-29 — Fairline, part 3: The Tape (Monday's recap, in the app and by email)

**What it is.** Every Monday morning (America/Chicago), one snapshot of each Fairline reader's last week, kept for good: the record and P/L, average CLV and the beat-close rate, the prices they got against EdgeDesk's fair, any leak that crossed the minimum sample or changed label, and the best number they got. On the Fairline page (The Tape tab, no longer Coming Soon) and in their inbox. No picks. Narrative: [docs/fairline.md](docs/fairline.md).

- **`supabase/fairline_tape.sql`** (new; mirrored in `migrations/20261029120000_fairline_tape.sql`):
  - `fairline_tapes`, **append-only**: one Tape per reader per week. Triggers refuse UPDATE, TRUNCATE and any DELETE while the reader exists, for every role; deleting the account still removes its Tapes.
  - `fairline_tape_build()`: due Monday from 06:00 in Chicago (CDT or CST), Fairline readers only (`fairline_paid()`), once per week however often it runs.
  - What a Tape holds is The Leaks' own arithmetic over the week, through the new `fairline_slices_at()`. Price quality uses only Bet Checker's frozen entry edge; a bet never checked is counted, never guessed. Each Tape stores the rules it was read by.
  - The email: `fairline_tape_due()` / `fairline_tape_mark()` claim once and re-check the reader at send time (opted out, bounced, no longer Fairline, more than 48 hours after the week, a quiet week: skipped with the reason). `fairline_tape_unsubscribe(token)` and `fairline_tape_email(on)` touch only `user_preferences.fairline_tape_emails`.
  - Nothing is emailed until `lifecycle_settings.sending_enabled` **and** the new `fairline_tape_settings.email_enabled` (**off by default**) are on. Until then the page shows the email as Coming Soon.
- **`supabase/fairline_tape_cron.sql`** (new; mirrored in `migrations/20261029120100_fairline_tape_cron.sql`): one pg_cron job, Mondays at :23 past 11:00 and 12:00 UTC; the build decides which is 06:00 in Chicago. No HTTP call, no secret.
- **`supabase/fairline.sql`**: `fairline_slices_at(user, from, to)`, the slices over one window of bets; `fairline_slices_for()` is now it over every bet (same answer, tested). `fairline_rules()` gains the `tape` keys (time zone, build hour, email deadline, weeks listed).
- **The existing email pipeline sends it**: `tools/fairline/tape_send.js` reuses `tools/lifecycle/send.js` (the Resend sender) and the trial emails' copy rule, settings, tokens and bounce list. It runs in the same hourly job (`lifecycle-email.yml`), after its own tests (`tape_email.test.js`); a failure there stops only The Tape. Each email has its own Idempotency-Key (`edgedesk-lifecycle-fairline-tape-<id>`). New opt-out page: `email/tape/` (a button, never a page load).
- **The page**: The Tape tab (the week, the numbers, price quality, what changed, the best number; past weeks; the email switch). The words are `lib/edgedesk_fairline_core.js` `tapeView()`, the same ones the email uses. A free or Bet Checker reader sees placeholders under a blur and the offer; no Tape is built for them.
- **The landing page sells Fairline.** A Fairline card sits between Bet Checker and Full Access. It carries the price, `FAIRLINE.FEATURES` verbatim, and *Get Fairline* to `/fairline/`, where the renewal terms are shown and ticked before Stripe. The price strip names it too, cheapest first. Its figures are new `fl_` words in `lib/edgedesk_pricing.js` (`priceWords()`), so the landing page loads the pricing file under `?v=20261029fl5`. The Tape is no longer "coming soon" in `FAIRLINE.FEATURES`. The page stays under its 216 KB budget.
- **Deploying, `deploy-fairline.yml`** (new, manual, `main` only): first a read-only check of production's paywall (docs/billing-hardening.md §11 query 10). It fails, and nothing else runs, if `has_active_sub()`, an RLS policy or a production-only function reads `subscriptions`' status without deferring to `billing_row_grants_access()`, since a Fairline subscription would then read the terminal's data. Its log prints names and verdicts only. Then, as asked: `fairline.sql`, `fairline_tape.sql`, `fairline_tape_cron.sql` and The Tape's email switch. A `CHECK THIS` report row fails the run.
- **Tests**: `tools/fairline/tape_sql.test.js` (90, new, real PostgreSQL), `tools/fairline/tape_email.test.js` (40, new, offline), both in `fairline-tests.yml`. The page suites cover The Tape (page 40, browser 58).
- **Not built, on purpose** (unchanged): a DK Predictions price feed; selling Fairline through Juice Reel's checkout.

## 2026-10-29 — The site deploys from one workflow, and the data jobs' pushes reach it again

**What was wrong, once Pages' source was switched to GitHub Actions:**

- **Three workflows deployed the site on every merge.** `jekyll-gh-pages.yml` and `static.yml`, the two starter workflows from the Pages settings screen, were added on 2026-10-28 at 21:20 UTC. They shared the `pages` queue with `pages-deploy.yml`, which keeps one waiting run, so each merge cancelled two of the three. Of 50 runs, 20 were cancelled.
  - Whichever finished last decided the site. At 12:41 UTC that was `static.yml`, which uploads the repository without the Jekyll build.
- **The data jobs' updates stopped reaching the site between merges.** The data jobs push with `GITHUB_TOKEN`, which starts no workflow, and `pages-deploy.yml` relied on an every-10-minutes timer.
  - GitHub's cron fires only every 4 to 7 hours in this repository. The data jobs themselves are started by Supabase `pg_cron`.
  - The timer ran twice in 15 hours (01:56 and 07:56 UTC). Nothing deployed between 07:59 and 12:22.

**What changed:**
- **`jekyll-gh-pages.yml` and `static.yml` are removed.** `pages-deploy.yml` is the only deployer.
- **`pages-deploy.yml` now also runs when any of the 65 workflows that push to `main` finishes** (`workflow_run`, by name), the pattern `editorial.yml` already uses.
  - The timer becomes an hourly backstop at :41.
  - The comments now say what the queue really does. The deploy in progress always finishes; waiting runs are replaced by the newest and show as cancelled.
- **`tools/ci/pages_deploy.test.js`** (Core validation) now also fails:
  - when a workflow that pushes to `main` is missing from the list, naming it;
  - when a listed name matches no workflow;
  - when any other workflow deploys Pages or queues in `pages`.
  - Results: 22 passed, 0 failed. Against `main` before this change, 17 passed, 5 failed. With one data workflow left out of the list, 21 passed, 1 failed.
- **Docs:** `docs/ci/README.md`, "Publishing the site", and the shipping table in `docs/intelligence.md`.

## 2026-10-29 — CFB: SP+ beside EdgeDesk's number on every card, as an external estimate, graded against the close

**Why.** On 2026-10-28 EdgeDesk had Middle Tennessee −4.5 against Kennesaw State. SP+ had about Middle Tennessee −1, and the game closed Kennesaw State −1.5 (KSU won 44–28). A results-based number had missed a team that was losing close games while playing efficiently. SP+ (ESPN's opponent-adjusted efficiency rating, by Bill Connelly) is now a visible second opinion, measured against the close. The full write-up is `football/sp_plus/README.md`.

**It changes no EdgeDesk number.** SP+ feeds no projection, EV, ranking, grade or record, and it can never be a Model Lab role or a promotion candidate. `football/sp_plus/registry.test.js` fails if any of that code reads it.

- **A · the weekly capture** (`football/sp_plus/sync.js`, `.github/workflows/cfb-sp-plus.yml`: Monday, retried Tuesday and Wednesday, plus a manual run).
  - It reads CollegeFootballData `/ratings/sp` with `CFBD_API_KEY` and maps teams through the identity master. An unmapped or prefix-only name is logged, never guessed.
  - Each team's overall, offense and defense are stored in `public.cfb_sp_ratings`: append-only by trigger, row level security with no policy, service role only (`supabase/cfb_sp_plus.sql`). Every attempt goes to `cfb_sp_sync_runs`.
  - UNCHANGED when CFBD still serves last week's numbers. The sync fails closed. **No rating is ever committed:** the repository is public, CFBD's terms forbid a public mirror (§5), and SP+ is ESPN's.
- **B · the projected line** (`lib/cfb_sp_plus.js`). A T2 transform of the T3 rating: home SP+ − away SP+ + the home field the CFB engine applies (2.8 today), 0 at a neutral site. It is pure and deterministic. `football/sp_plus/lines.json` publishes the derived line per game of the captured week.
- **C · on the cards.**
  - Where it appears:
    - the board card, beside EdgeDesk fair and the market;
    - the game page, after Fair spread;
    - the research terminal: section 1 after Fair spread, the summary strip, and section A.
  - Each row shows the SP+ line, "T3 external model · T2 computed line", the SP+ week, and the attribution "Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com."
  - A 3+ point gap to EdgeDesk adds a plain "Models disagree" note. The two numbers are never combined.
  - The line shows only from a capture of the game's own week, no older than 8 days. Otherwise the row reads unavailable, with the reason.
- **D · tracking** (`football/sp_plus/track.js`, in the hourly Model Lab job).
  - For every upcoming game: EdgeDesk's fair line, the SP+ line and the Lab's consensus market at the same moment, appended on change.
  - Each game is graded once against the Lab's close and the final: MAE against each, the right side of the close, and whether the close moved toward it.
  - A weekly and season report. Append-only, and checked before publish.
- **E · the registry** (`football/sp_plus/registry.json`, `public.cfb_external_estimates`).
  - *SP+ projected line* is registered as an `EXTERNAL_ESTIMATE` with its source, version and terms.
  - The server refuses to mark it an EdgeDesk model or validated.
  - The page pins its badge to "External" ahead of the model registry.
- **Terms.** CFBD's terms (2026-08-12, read as quoted; the site was unreachable from the build environment) allow commercial use and reasonable portions of factual data in a larger product, and recommend the attribution line. **No licence from ESPN for SP+ was found or obtained.** The owner chose to show the derived projected line only, publicly, with attribution.
- **To switch it on.**
  1. Apply `supabase/cfb_sp_plus.sql`.
  2. Add the repository secret `CFBD_API_KEY`.
  3. Run *CFB SP+ weekly sync*.

  Until then every card reads "SP+ has not been synced yet".

Tests:
- `football/sp_plus/ingest.test.js` (66, mocked CFBD and Supabase)
- `projection.test.js` (42)
- `display.test.js` (39)
- `card_ui.test.js` (23, the real football module)
- `ui.e2e.js` (22, Chromium)
- `track.test.js` (38)
- `registry.test.js` (22)
- `sql.test.js` (46, a real PostgreSQL)

All run in `cfb-sp-plus-tests.yml`.

## 2026-10-29 — Prediction Radar: radar_registry.sql applies on the production registry (games_tested), and Deploy Prediction Radar

- **Bug.** Applying `supabase/radar_registry.sql` in production stopped with "research_model_results requires games_tested and this file has nothing to put there". The registry's tables exist only in production. That table requires `games_tested`, and the generator had no mapping for it, so nothing was registered.
- **Fix.** `tools/radar/build_registry_sql.js` fills `games_tested`, or the first of `n_games`, `holdout_games` and `games` that exists, with the report's holdout games (37). It fills a followed-bets column (`bets_tested`, `n_bets`, `n_followed` or `sample_size`) with the report's followed bets (41). `supabase/radar_registry.sql` is regenerated from it. The report and the verdict are unchanged (FAILED).
- **Test.** `tools/radar/radar_sql.test.js`'s stand-in registry now requires `games_tested`, as production does. On the old SQL: 131 passed, 1 failed, with the production error. On the fix: 199 passed, 0 failed.
- **Deploy Prediction Radar** (`.github/workflows/deploy-radar.yml`, run by hand, the `deploy-bet-checker.yml` pattern) runs the runbook in order with the repository's Supabase secrets, after the Radar suites pass:
  - `apply_sql`: radar.sql, then radar_registry.sql, then radar_record.sql;
  - `deploy_function`: `polymarket_sync`, checked by the build it serves;
  - `set_cron_secret`: the function's and Vault's secrets made one value, never printed, and proved by a dry probe;
  - `data_enabled`: both halves of the switch; `on` records `enable_note` in `radar_config`;
  - `apply_cron`: the four schedules.

  A report row that says CHECK THIS fails the run.

## 2026-10-29 — Prediction Radar 3/3: the Radar record, "How following has done", append-only and graded against the close and the result

**What it is.** A record of every Smart Money Tonight card, kept so nobody can edit it, and graded the way a follower would have done. Full write-up: [docs/prediction-radar.md](docs/prediction-radar.md) ("The Radar record").
- **`radar_cards`.** Every card is published once per game and side, at the Polymarket price at that moment, by the same function that draws Smart Money Tonight (`radar_publish_cards()`).
- **`radar_card_results`.** Each card is graded once after its game (`radar_grade_cards()`):
  - the close, whether the card beat it, and its CLV%;
  - the result, from the market's own resolution;
  - the ROI of one unit at the published price.

  A card with no resolution a week after its start is void. Both tables are append-only. Their guards refuse a grade whose arithmetic is not the database's own.
- **`radar_record()`**, for subscribers. It reports record, ROI and beat-close rate, plus a small-sample flag under 200 graded cards. It stays labelled **Experimental** until H-RADAR-01 passes its criteria, and quotes what H-RADAR-01 found verbatim.
- **"How following has done"** sits under Smart Money Tonight on the Overview.
- **`polymarket_sync`** publishes and grades in the 10-minute run, after it stores holders, prices and resolutions. While the record is not installed it raises a warning.

**Tests.** `radar_sql.test.js` 198, `sync_fn.test.js` with the record, `radar_ui.test.js` 72, `radar_ui.e2e.js` 54.

## 2026-10-29 — Prediction Radar 2/3: Smart Money Tonight on the Overview, trader pages, and the free /radar/ page

**What a reader sees.** Nothing is drawn while Radar is off or H-RADAR-01 is not registered. Full write-up: [docs/prediction-radar.md](docs/prediction-radar.md) ("Where it shows").
- **Smart Money Tonight** is the first thing on the Overview, for subscribers. Each card leads with one plain sentence ("7 top bettors, $84K, on Chiefs -3"). Then come the average entry, the price now and whether it moved, EdgeDesk's fair with "Smart money agrees/disagrees with the sharp fair price" (or why there is no comparison), conviction flags, the other side, and each bettor. Cards are sorted by bettors, then dollars. A game with no graded bettor shows nothing.
- **Trader pages** (a sheet in the terminal, a route on `/radar/`): the public name only when the wallet made it public, else a short address. They show record, ROI, CLV, follow ROI, style, sample, open positions (subscribers) and every graded bet with Polygonscan links. No bio.
- **`/radar/`**, free: the graded leaderboard, trader pages, what H-RADAR-01 found, and a teaser of the first card that never names its side (`radar_teaser()`, new in `supabase/radar.sql`; the migration mirror stays byte-identical).
- **Labels and limits.** Experimental, Small sample and High conviction are always visible. The Radar Score is never shown without its components. Every surface carries the Known limitations block. There are no bet or copy buttons, no affiliate links, and no promises.

**Tests.** `tools/radar/radar_ui.test.js` 59, `tools/radar/radar_ui.e2e.js` 50 (Chromium at 390 and 1280 px), `radar_sql.test.js` 172 (with the teaser), `tools/site/free_access.test.js` with the new page and doors.

## 2026-10-29 — Prediction Radar 1/3: Polymarket sports bettors graded from their own trades, behind a gateway and a switch; H-RADAR-01 registered before any data and run once

**What it is.** Radar grades the Polymarket sports wallets with the most volume on their own trades: record, profit, ROI, CLV, the ROI a follower would have had 5 (and 15) minutes later, conviction and a style (Directional, Market Maker, Hedger). It is research, labelled Experimental, the same for every reader, and nothing trades for anyone. No UI ships in this change. Full write-up: [docs/prediction-radar.md](docs/prediction-radar.md).

**What changed.**
- **The grading core** (`lib/edgedesk_radar.js`). Every rule comes from one constant, `public.radar_rules()`, and nothing runs without it. P&L is computed from trades; Polymarket's P&L and rankings hosts are never read.
- **The gateway** (`lib/edgedesk_poly_gateway.js`), the only Radar client of Polymarket: the `POLYMARKET_DATA_ENABLED` switch (off by default, one SQL statement turns it on or off, no deploy), a budget granted under a row lock, pacing, bounded backoff, a breaker. `tools/radar/no_bypass.test.js` fails if any other file names a Polymarket host.
- **The data** (`supabase/radar.sql`, mirrored in `supabase/migrations/20261029120000_radar.sql`): append-only trades with transaction hashes, bets, versioned grades, holder and price snapshots. Anon reads the graded leaderboard and trader pages once Radar is on and H-RADAR-01 is registered; Smart Money Tonight and open positions are for subscribers (`has_active_sub()`). No existing policy changes.
- **The job** (`supabase/functions/polymarket_sync`, schedules in `supabase/polymarket_sync_cron.sql`): holders every 10 minutes, the pool and wallet histories nightly, then a regrade.
- **H-RADAR-01** (`research/radar/registration_h_radar_01.json`), committed before any Polymarket response was read: the top 25 directional wallets, followed 5 minutes after entry, must beat the close more than half the time and make money, each with a game-clustered 95% interval. The runner (`research/radar/run_validation.js`) runs it once, on GitHub's runner (`.github/workflows/radar-validation.yml`), and `research/radar/one_look.js` stops any later run from looking again until its report is committed.

**What H-RADAR-01 found** (run 40823328433, `research/radar/H-RADAR-01/RESULTS.md`): **FAILED** on all three criteria. 41 followed bets over 37 games; beat-close rate 24.4% (95% CI 10.3% to 39.0%); follow ROI −1.7% (95% CI −33.4% to +30.5%). 172 of the 200 pool wallets had more than 30 pages of history and were excluded by the registered rule, so only 13 qualified, and 3 of them bet in the holdout. Radar stays Experimental; `supabase/radar_registry.sql` records the result with `passed = false`.

**What the live probe found before the look** (`.github/workflows/radar-sources.yml`, each fixed with a regression test shown failing on the old code):
- Gamma answers a resolved market only when asked with `closed=true`. Without it the H-RADAR-01 run would have read no market and spent its one look on an empty report.
- `/v2/holders` refuses more than 100 holders with `include_pnl`, so Smart Money Tonight would never have shown a card.
- One unwindowed page of open NFL events was 48 MB; events are now asked in a window, 5 a page.
- Gamma's `spread` is the order book's spread, not a point; the line is read from `line` only.

**Tests.** `tools/radar/`: core 96, fixtures 43 (recorded from the live probe), gateway 29, no-bypass 11, the runner and the one-look guard 30, the SQL on a real PostgreSQL as anon, a signed-in reader, a subscriber and the service role, and the shipped function against it 51. All run by `.github/workflows/radar-tests.yml`.

## 2026-10-28 — Billing change: the Fairline tier (`black`), and Fairline gated on it

**Authorization change; needs the owner's explicit review.** A third Stripe product, Fairline (`tier = black`, $19.99/month or $159/year, lookup keys `fairline_monthly` / `fairline_annual`). It includes Bet Checker and never opens the Research Terminal. The ladder is red ⊂ black ⊂ blue. Detail: [docs/billing-hardening.md §15](docs/billing-hardening.md), [docs/fairline.md](docs/fairline.md).

- **`supabase/billing_hardening.sql`**:
  - Both tier CHECK constraints know `black`. Each is dropped and re-added in one statement, and only when it does not.
  - `billing_learn_price_tier()` accepts `black`.
  - `has_bet_checker_paid()` is red, black or blue.
  - New `has_fairline_paid(uuid, timestamptz)`: black or blue in good standing. Service role only.
  - `billing_access_for()` adds `fairline_paid` and reason `fairline_only`, and offers a black row `upgrade` (a portal switch).
  - Report row 15 checks every learned red and black price against the rule.
  - The access rule itself is unchanged.
- **`supabase/fairline.sql`**: `fairline_paid()` now calls `has_fairline_paid()`. Bet Checker alone is no longer Fairline.
- **`create_checkout_session`**: `{kind: 'fairline'}`. It sells only a price whose product says `black` at the consented figure, and records the tier before the session exists. It **refuses to sell** (503, nothing created) when the database could not record it: an error, or `refused:tier` from a database without this SQL. Bet Checker's checkout now refuses that answer too. A Bet Checker customer buying Fairline, or a Fairline customer buying the terminal's trial, gets `switch_plan`.
- **The billing core** (`tools/billing/billing_core.js`, inlined into the three functions):
  - The tier list knows `black`.
  - A price Stripe cannot name is named by the price itself: its metadata, else the EdgeDesk lookup key (`bet_checker_*` red, `fairline_*` black). It is then learned.
  - The webhook does this for the event's own price before its Stripe-down fallback write.
  - Without this, a portal switch to a never-learned Fairline price during a Stripe outage opened the terminal (`has_access: true`, mutation-tested).
- **`supabase/juicereel_billing.sql`**: when a Juice Reel buyer's row holds a live red or black Stripe plan, the terminal still replaces it. `juicereel_and_stripe_both_paid` is now raised, so a human cancels the Stripe plan. Before, it was orphaned silently.
- **`sync_subscription`**: its access answer carries `fairline_paid`.
- **Pages**:
  - `lib/edgedesk_pricing.js` gains a `FAIRLINE` block (the one place the price is written), `fairlineOffer()` and `fairlineTerms()`.
  - `lib/edgedesk_access.js` gains `fairline()`, and black in `betChecker()` and `offerFor()`.
  - The Fairline page sells Fairline with the automatic-renewal consent, in Bet Checker's order. It gains Settings › Subscription. A Bet Checker reader is offered the portal switch.
  - The terminal's paywall and the Bet Checker page name a Fairline plan as Fairline.
  - `index.html`, `app.html` and `bet-checker/index.html` load the changed `edgedesk_pricing.js`, `edgedesk_access.js` (and, on Bet Checker, `edgedesk_bet_checker.js`, at `?v=20261029fl4` since it merged with main's own Bet Checker changes) under a new stamp (`?v=20261029fl2`), so a returning browser cannot keep the old copies. On Bet Checker an old `edgedesk_access.js` would show a Fairline customer as free. The landing page's stamp check failed until this was done; a new check in `tools/fairline/page.test.js` fails on any of these pages loading a stamp from before the `black` tier.
- **Tests**: `tools/billing/fairline_tier.test.js` (72, new; in `personal-tests.yml`, `fairline-tests.yml` and `deploy-billing.yml`). The Fairline suites now run with black as paid and red as free (SQL 116, page 37, browser 42). `billing_hardening_sql.test.js` expects 15 report rows instead of 14.
- **Not verified here:** production's `has_active_sub()` and paywall RLS are not in this repository. Run `docs/billing-hardening.md` §11 query 10 before selling Fairline.

## 2026-10-29 — Bet Checker grades the NBA and the NHL (once their odds are on)

**What changed.**
- **`supabase/bet_checker.sql`** (mirrored in `migrations/20261028120000_bet_checker.sql`):
  - `bet_checker_rules().sports` adds `basketball_nba` → NBA and `icehockey_nhl` → NHL. The grade thresholds, the fair-price freshness, the free allowance and the CLV formula are unchanged.
  - `user_bets.sport`'s check (`bettor_decisions.sql`: CFB, NFL) is replaced by one that takes all four leagues, in the same transaction. Every existing row passes it.
  - Report row 12 says the check takes every league in the rules.
- **The page**: NBA and NHL pills. An NHL moneyline says it includes overtime and the shootout, because the board carries no 60-minute line.
- **`docs/bet-checker.md`**: "The leagues", including where results come from. For these two leagues that is only `settle`'s word on the signal.

**When it shows.** Only when capture prices the leagues. Both are off in the odds gateway until the owner turns them on after the November reset, every two hours ([METHODOLOGY-2026-10-29-nba-nhl-lines.md](docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-29-nba-nhl-lines.md)). Until then the page offers no NBA or NHL game.

**Tests.** `bet_checker_sql.test.js` 137 / 0: the widened check, MLB still refused, NBA and NHL games offered and filtered, an NBA spread and an NHL moneyline graded on the same rules, the puck line, the free allowance, and an NHL close and result. On the previous SQL, 5 fail and the suite stops. `page.e2e.js` 61 / 0: the NHL pill, and the overtime note.

## 2026-10-29 — Methodology change: NBA and NHL game lines every two hours in the odds gateway (both leagues still off)

**Why.** Bet Checker can grade only what EdgeDesk prices, and the NBA and NHL are registered with the odds gateway disabled. The owner approved buying their main markets (h2h, spreads, totals) every **two hours**, about **2,160 credits a month for both leagues**, instead of the gateway's hourly default (about 4,320). Narrative, evidence and budget: [METHODOLOGY-2026-10-29-nba-nhl-lines.md](docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-29-nba-nhl-lines.md).

**What changed.**
- **`supabase/odds_api_nba_nhl_lines.sql`** (new, idempotent): cadence rows for the groups `nba` and `nhl` in `featured` (capture) and `close` (close), which share one fingerprint. They are 120 minutes up to 72 h from the next start and 360 minutes beyond. It also registers both leagues **disabled**, as their own files do. Every other sport, category, the floor, the breaker and the budget are untouched.
- **`.github/workflows/deploy-odds-gateway.yml`**: input `apply_nba_nhl_lines` (default on), and the suite runs before anything ships. **`odds-gateway-tests.yml`** runs it on every pull request.
- **`.github/workflows/capture.yml`** prints capture's `sports_list`, so the switch-on can show whether the production `CAPTURE_SPORTS` asks for the two leagues.
- **`INCIDENT.md`** §9 step 12: the owner's switch-on (`odds_api_set_sport`), after the November reset and only once base spend tracks.

**Evidence.** `tools/odds/nba_nhl_lines_sql.test.js`, 24 / 0 on a real PostgreSQL. An NBA or NHL board 65 or 117 minutes old was bought before and is a free cache hit after, for capture and close alike. NFL is still bought hourly. Leaving the NBA `close` band at 60 fails 5 checks.

## 2026-10-29 — Bet Checker: tap the bet you placed (the best price fills in for a paid reader)

**What it does.** After a reader picks a game, the board's lines show as buttons: spread, total and moneyline, away and over first. Each spread and total shows the line most books hang, or the priced line where none is modal. One tap fills the market, the side and the line. For a paid reader (Bet Checker or the terminal), it also fills the best price on EdgeDesk's board at exactly that line, and its book. A note under the form says where the price came from and how old it is, and asks the reader to change it to the price they got, because the grade is on the odds they submit. A free reader taps the line and types the odds (owner's decision, 2026-10-29: the best price across the board's books is line shopping, which the paid tiers sell). The form still works as before for any line not on the buttons.

**What changed.**
- **`supabase/bet_checker.sql`** (mirrored in `migrations/20261028120000_bet_checker.sql`), additive:
  - `bet_checker_line_prices(p_event_id)`, a security-definer function beside `bet_checker_lines()`, which is unchanged. It answers capture's `best_dec` as American odds, `best_book` and `last_seen_at` at each line of a game that has not started. It answers only lines seen within `fair_max_age_min`, the window `priced` already uses. **A free reader gets no rows**, anon is refused, and the grant is `authenticated` and the service role.
  - `bet_checker_decimal_to_american()`, for display.
  - The startup guard also requires `signals.best_dec` and `signals.best_book`.
- **The page**: `lib/edgedesk_bet_checker.js`, `lib/edgedesk_bet_checker_core.js` (`tapLines()`, `bookOption()`), `lib/edgedesk_bet_checker.css`, `bet-checker/index.html` (the buttons and the note; stamps `20261029bc1`). A book EdgeDesk's list does not carry is set to Other, and the note says so.
- **Nothing about grading changes.** The entry grade, the CLV and the free allowance are computed as before, from the odds the reader submits.
- **Tests**: `bet_checker_sql.test.js` 127 (a free reader gets no prices, paid readers get each line's price and book, a stale or unpriced line is left out, the conversion), `core.test.js` 53, `page.e2e.js` 59 (a free reader's tap leaves the odds empty; a paid reader's tap fills -110 at DraftKings, a book outside the list becomes Other, and an edited price is the one logged).

## 2026-10-29 — NHL: every favourite less favoured than DraftKings. The cause measured, a pre-registered shadow, a nightly spread check; no published price moves

**The report.** EdgeDesk priced every favourite below DraftKings again: VAN at SJS −133 against −198, NYI at MIN −146 against −192. The hourly ESPN capture (`research/clv/openers/nhl`) confirms the pattern on the published prices. In 35 of 47 settled 2026-27 games the book's favourite was less favoured here, by 2.2 points on average. The market's logit on the model's has slope 1.215 (1.036–1.394). Both rank clubs alike (correlation 0.89). The scale differs. Full write-up: [docs/engine/NHL_LAB.md](docs/engine/NHL_LAB.md) §6.3.

**What causes it.**
- **This season's split factor.** The pair recalibration (`hockey/model/glm.js`) refits a home/away split factor `b` each season on the regulation goal split of the three seasons before. For 2026-27 it is 0.90, the lowest since 2013-14 (0.975–1.175 before). It pulls every goal share 10% toward even.
- **Fitted on goals, not on what is published.** On the goal split the right `b` is 1.025 in both windows. On the two-way moneyline it is 1.125 (2014-20) and 1.15 (2021-26).
- **Club information.** Most of the two named games' gap is not scale. Model and market rate SJS the same. The market rates VAN the league's weakest club and MIN much higher than the model does. No calibration closes that part.

**Why production keeps its price.** Every fix was walked forward through the production pipeline, and none passes the lab's promotion rule (§1). On 2021-26 every variant is worse:
- `b` = 1: +0.00057 log loss.
- `b` fitted on the goal split over every earlier season: +0.00036, interval above zero.
- `b` fitted on the moneyline: +0.00027 (−0.00013 to +0.00063).

The 2026-27 games so far and DraftKings both favour the moneyline fit, but the live season never chooses, and no market archive is licensed.

**What changed.**
- **The shadow** (`hockey/model/split_shadow.js`, protocol `nhl_split_ml_v1`). It is production with `b` fitted on the moneyline of every earlier out-of-sample game: 1.125 for 2026-27, frozen.
  - Every slate game carries `calibration_shadow`, labelled SHADOW, never the price. In it VAN at SJS reads −142 and NYI at MIN −161.
  - Each build freezes it beside production's price in its own append-only, hash-checked ledger, `hockey/ledger/split_shadow_2027.jsonl`. `build_slate.js --check` verifies it. The production ledger is untouched.
- **The rule, written before that ledger held a row.**
  - It is read once, on the first 1,000 graded games.
  - `ELIGIBLE` needs three things: the shadow-minus-production moneyline log loss interval wholly below zero, calibration slope 0.85–1.15 with |mean p − mean y| ≤ 0.02, and a home −1.5 log loss at most 0.001 worse.
  - DraftKings' closes are reported, never deciding.
  - Promotion is a methodology-change pull request.
  - **Power, stated now:** an effect the size seen so far needs about 810 games, one of 0.001 about 5,700, so `NOT_CONFIRMED` is the likeliest end.
- **The study and the live record** (`hockey/lab/split_shadow.js` → `hockey/validation/nhl_split_shadow.json`).
  - The study reproduces the production record on both completed windows and every variant scored.
  - `--live` grades the shadow ledger and writes `market_spread`, production against DraftKings' closes (`NARROWER_THAN_MARKET` today). The NHL build and validate jobs run it.
  - `--check` fails if the frozen 1.125 is not what the rule gives.
- `hockey/lab/base.js` `glmPredictions` also returns the raw λ.

**Evidence that no published number moves.** The slate was built with the old and the new code at its own `generated_at` (2026-10-28T22:50:39Z). With `calibration_shadow` removed, the two builds are byte-identical. Every production moneyline equals the committed slate's. `goalie_inputs.json` is identical.

**Tests.** `tools/hockey/nhl_v2.test.js` gains 31 checks (142 pass), on synthetic data where the answer is known:
- the moneyline fit recovers a known split, and the shadow moves the split, never the total;
- DraftKings closes are read and matched exactly;
- the spread monitor reads narrow, wide, consistent and too early;
- the shadow ledger refuses a started game and catches an edited row;
- the rule decides once, on 1,000 games, and refuses a shadow that is no better, overshoots, or worsens the puck line.

## 2026-10-29 — Landing checkout: "Start 7 days free" reaches Stripe again (an undeclared `promo` stopped it after the consent)

**What was wrong.** The landing page sends a new reader through sign-up and the renewal terms. It records their consent, then sends them to Stripe. Between those last two steps, `confirmArl()` in `index.html` sends the funnel and analytics events with `promo:!!promo`. Nothing in the page declares `promo`. The creator's code is `affiliateCode`, set a few lines earlier in the same function. The call threw `ReferenceError: promo is not defined`, so `window.location.href=url` never ran. The reader stayed on "Opening secure checkout…". Their consent was recorded, and no checkout opened. This is the path every Full Access trial takes, server checkout and Payment Link alike. Bet Checker checks out from `/bet-checker/` and was not affected. The line predates the oldest commit in this clone (2026-10-27), so it has been live at least since then.

**Why nothing went red.** Only `tools/billing/checkout_flow.e2e.js` drives this flow in a browser. No workflow ran it, and it had failed at step 5 on `main` without anyone seeing.

**What changed.**
- `index.html`: `promo:!!affiliateCode` in the `checkout_started` funnel and analytics events. The events still report whether a creator's code was used.
- `tools/billing/checkout_flow.e2e.js`: when step 5 fails, it reports the page's script errors, so this bug reads `ReferenceError: promo is not defined` instead of an empty URL. It no longer crashes on `new URL('')`. With `CHECKOUT_FLOW_UI_REQUIRED=1`, a missing browser fails rather than skips.
- `.github/workflows/funnel-tests.yml`: the browser job runs it, with `CHECKOUT_FLOW_UI_REQUIRED=1`. The workflow also starts on `lib/edgedesk_access.js` (the checkout client) and on the test itself.

**Evidence.** On `main`'s page: `FAIL 5 checkout opened the configured link — {"to":"","errors":["ReferenceError: promo is not defined"]}`. With the fix: `PASS | checkout flow | 40 passed, 0 failed`.

## 2026-10-28 — Fairline, part 1: The Board and The Leaks (behind the Bet Checker and terminal tiers)

**What it is.** A new page, [`/fairline/`](fairline/index.html), that answers two questions from prices and the reader's own bets, never from picks: **"Am I getting a good number right now?"** (The Board) and **"Where am I losing money, and is it bad bets or bad luck?"** (The Leaks). The weekly recap (The Tape) shows as Coming Soon. Narrative: [docs/fairline.md](docs/fairline.md).

- **`supabase/fairline.sql`** (new, additive; mirrored in `migrations/20261028180000_fairline.sql`). Functions and one view; no table, row or policy changes. `signals` keeps its terminal-only RLS.
  - `fairline_rules()`: the one constant (a label from 15 settled bets; a label about the close from 15 captured closes; the odds, lead-time and stake buckets; capture's own freshness limits).
  - `fairline_paid()`: the one gate. Today it is `has_bet_checker_paid()` (Bet Checker `red` or the terminal `blue`). No billing change in this part.
  - `fairline_bets_for()` / `fairline_my_bets()` / view `fairline_bets`: the reader's bets from Bet Checker and the Portfolio, one row per bet. A bet in both is counted once (linked, same market key, or same game), keeping the book's money and Bet Checker's close.
  - `fairline_leaks()`: every slice by sport, market, bet type, odds range, lead time, book and stake vs median, with bets, record, units and dollars P/L, ROI, average CLV and beat-close rate, and a label: real leak, bad luck, running hot, real edge; P/L only when too few closes were captured; none below the sample. Free: the biggest leak's slice name, no number.
  - `fairline_board()`: a security-definer door. Fair (probability and odds), best price (`book_quotes` where present, else `signals`), edge vs fair, quote age with stale rows greyed and sorted last, Kalshi only when its card says OK, DK Predictions marked inactive. Free: the top 3 fresh rows.
- **The page**: `fairline/index.html`, `lib/edgedesk_fairline_app.js`, `lib/edgedesk_fairline_app.css`, `lib/edgedesk_fairline_core.js`. Mobile first, on the tools frame and the game cards. Each leak card leads with one plain sentence; labels are chips with words. The Board says it is prices, not picks, and carries a Known limitations block. Added to `sitemap-pages.xml`.
- **Tests** (`.github/workflows/fairline-tests.yml`, in `tools/ci/checks.json` under Frontend and navigation): `fairline_sql.test.js` (115, real PostgreSQL), `core.test.js` (55), `page.test.js` (27), `page.e2e.js` (30, Chromium).
- **Out of scope, noted in the docs:** a DK Predictions price feed (no source exists), and selling Fairline through Juice Reel's checkout (that sells only the terminal today).

## 2026-10-28 — Deploying Bet Checker: the checkout stage probes Bet Checker's purchase too

**What was missing.** `create_checkout_session` was deployed to production at 20:33 (`create_checkout_session-2026-10-28-bet-checker-2`). Its Phase 8 probes (`tools/billing/prod_probe.js checkout`) never asked for a Bet Checker checkout. They also stop early while `STRIPE_PRICE_ID` is unset, and it is unset in production, so the terminal keeps its Payment Link. Bet Checker needs no `STRIPE_PRICE_ID`: its prices are found by Stripe lookup key. So nothing had shown that the live Stripe key can read `bet_checker_monthly` and `bet_checker_annual` and open a checkout for them.

**What changed.** `checkout` now probes Bet Checker first, whether or not the terminal's price is set. All of it runs as probe A, never a customer:
- An unauthenticated request is refused (401).
- A price the customer did not consent to is refused (409) and creates nothing.
- Monthly and annual each open a live `checkout.stripe.com` session. Each is recorded for the caller with no trial, on the price whose lookup key is `bet_checker_monthly` / `bet_checker_annual`, and `billing_price_tiers` knows that price as tier red.
- Opening checkout grants nothing.

It leaves one open, unpaid session per price, each expiring within 24 hours. `docs/billing-hardening.md` and the stage's heading say so.

**Tests.** `tools/billing/prod_probe.test.js`, which runs the probe against the shipped function and a fake Stripe:
- With the kill switch on, the Bet Checker probes still run and pass.
- A Bet Checker product without metadata `tier = red` FAILS them.
- Probe A ends with exactly one open session per price.

## 2026-10-28 — main is red: the "Integrated with Juice Reel" line pushed the free calculator off a short phone's first screen (#864)

**What failed.** Funnel tests, browser job, `tools/home/landing.e2e.js`: "first visit: the top of the free calculator shows, labelled Free". On a 375×548 screen (an iPhone SE inside X's in-app browser), the calculator's top bar ended at 581 px on the runner, past the 548 px fold. #864 added the hero line inside the text column, and on phones that column stacks above the calculator, so the line pushed the calculator down by 43 px.
- On this machine, the same layout put the bar at exactly 548 of 548 px, which is why the full local `verify` passed. The runner's fallback fonts set the hero 33 px taller.

**The fix** (`index.html`, `lib/edgedesk_landing_desk.css`):
- The line moves out of the text column to right after the hero's two columns.
- On a wide screen, the text column is the taller one, so the line sits in the same place as before: under the hero's text, on the first screen (1024 to 1440 px measured).
- Where the columns stack, it follows the calculator. The calculator's top bar is back where it was before #864: 505 of 548 px here.
- Stylesheet stamp `20261028jr3`, recorded.

**Tests:**
- `tools/home/landing.e2e.js`: 327 passed, 0 failed.
- `tools/billing/juicereel_checkout.e2e.js` now checks both placements: under the text at 1280 px, and right after the calculator at 390 px. With the fix, 50 passed, 0 failed. With #864's layout, 49 passed, 1 failed.

## 2026-10-28 — The site's deploy is no longer cancelled by the next push (inert until Pages' source is switched)

**Why.** Pages' own "Deploy from a branch" build cancels the build before it on every push. The data jobs push every few minutes, and a build takes about four. On 2026-10-28, 23 builds in a row were cancelled (19:54 to 20:38 UTC). The site served a 19:49 copy through the merges of #860, #861 and #862.

**What changed:**
- **`.github/workflows/pages-deploy.yml`** (new).
  - The build is the same one Pages ran: Jekyll over the repository root, then deployed to the `github-pages` environment.
  - A new run waits for the one in progress (`cancel-in-progress: false`), so every run that starts finishes.
  - It runs on a merge to `main`, every 10 minutes (the data jobs' pushes start no workflow), and by hand.
  - While Settings › Pages › Source is still "Deploy from a branch", it deploys nothing and says so in the run's summary.
- **To switch on:** set Settings › Pages › Source to **GitHub Actions**, then run **Pages deploy** once by hand. Steps and undo: `docs/ci/README.md`, "Publishing the site".
- **`tools/ci/pages_deploy.test.js`** (new, run by Core validation): 18 passed, 0 failed. It fails without the workflow (2 passed, 16 failed), with `cancel-in-progress: true` (17 passed, 1 failed) and without the schedule (17 passed, 1 failed).
  - It also runs the source check against a stand-in `gh`. "workflow" deploys. "legacy" deploys nothing and says why. A failed read fails the job.
- `docs/intelligence.md`: the shipping table names the new run.

## 2026-10-28 — The landing page's hero says "Integrated with Juice Reel"

**Why.** The Juice Reel integration matters most as a credential. Until now the landing page said so only in the partner band, eleven sections down, and only once a script had drawn it.

**What changed:**
- `index.html`: a line, **Integrated with Juice Reel**, sits under the hero's audience line. The words are in the page itself, so a reader without the script, or a crawler, sees them too. It is on the first screen at phone and desktop widths.
- `lib/edgedesk_landing_desk.css`: its pill style, kept out of the page's own sheet for the 216 KB budget. The stamp moves to `20261028jr2` and is recorded in `tools/presentation/landing_asset_stamps.json`.
- A shared link's preview leads with it too. `og:description` (LinkedIn, Slack) and `twitter:description` (X) now open with "Integrated with Juice Reel.", because previews cut long text.
  - To fit the budget, "the whole terminal:" and "the whole desk:" left those two lines. Every feature they list is still listed.
  - The search description (`<meta name="description">`) is unchanged.
- The page now has 20 characters of room under the budget (it had 56).
- `tools/billing/juicereel_checkout.e2e.js` gains four checks: the line is in the hero's HTML, it is on the first screen at 390 px and at 1280 px, and both share descriptions lead with it. With these changes, 50 passed, 0 failed. Without the hero line, its three checks fail (46 passed, 3 failed). Without the preview change, its check fails (49 passed, 1 failed).

## 2026-10-28 — main is red: Personal research CI after the Juice Reel merge (#860)

**What was wrong.** #860 merged with Personal research CI red, and `main` has stayed red since. Two checks fail there, both in tests, not in what a reader sees:
- `tools/personal/personal_wiring.test.js`: two checks pinned the paywall's card-trial button as `<a class="pg-btn" …>`. #860 moved its class into `stripeCls`, so the button can sit below Juice Reel's as a secondary one when the switch is on. The checks no longer matched the code, which still sends a new account through `index.html#subscribe`.
- `tools/billing/juicereel_checkout.e2e.js`, "a cancelled Juice Reel checkout": after the click, the test waited for `/app.html`. The page was already there, so the wait returned at once, and the next poll ran into the navigation to Juice Reel ("Execution context was destroyed"). It failed on every run here.

**What changed.**
- The two wiring checks match `class="'+stripeCls+'"`. A new check requires that with Juice Reel off, `stripeCls` is the plain `pg-btn`, so the card trial is still the primary button. Making it `pg-btn ghost` fails that check.
- The e2e waits for the return from `oauth/juicereel-subscribe.html` (`/app.html?jrsub=return`).

**Evidence.** On `main`: personal wiring 72 passed, 2 failed; the Juice Reel e2e failed 2 of 2 runs. With this change: 75 / 0, and 42 / 0 on each of 3 runs. No page, function or SQL changed.

## 2026-10-28 — Juice Reel buyers get a way back to Juice Reel from the terminal

**Why.** People who subscribe on Juice Reel come and go between Juice Reel's app and EdgeDesk on the web. Once signed in, the terminal offered them no way back.

**What changed** (`app.html`):
- A reader whose access came through Juice Reel (`price_id 'juicereel'`) now sees **Back to Juice Reel ↗** in the account menu at every width.
- From 600 px they also see a **↗ Juice Reel** chip in the header, beside Ask AI and Help. The phone header has no room for it.
- Both open juicereel.com in a new tab, so EdgeDesk stays open.
- Nobody else sees either: not a Stripe subscriber, not a comp, not a reader without access, and nobody while the switch is off.
- One function, `edJrBackSync()`, decides, wherever the page learns the reader's subscription (`loadSubStatus`, `pgReadAccess`).
- `tools/billing/juicereel_checkout.e2e.js` gains four checks: 46 passed, 0 failed.

## 2026-10-28 — EdgeDesk sold through Juice Reel: hosted checkout, account link, webhook and reconcile (off until switched on)

**What it adds.** A reader can pay for EdgeDesk on Juice Reel's hosted checkout, and the EdgeDesk account they are signed in to opens. A reader who bought on Juice Reel's marketplace can link their Juice Reel account and get in. The landing page shows the partnership with Juice Reel. Juice Reel's CEO approved this by phone on 2026-10-28, as the account owner reports. Runbook: [docs/juicereel-billing.md](docs/juicereel-billing.md).

- **`supabase/functions/juicereel_billing`** (new). It covers `start`, `complete`, `status`, the webhook, the hourly `reconcile` and an operator `check`.
  - The checkout is created server-side (`POST /checkout/sessions`, HTTP Basic), with PKCE S256 and a state bound to the reader.
  - The code is exchanged with the success URL as `redirect_uri`. `/oauth2/me` names the buyer, and Juice Reel is asked whether they are subscribed.
  - Webhooks are verified with HMAC-SHA256 over the raw body.
  - No verifier, token or secret is stored or logged.
- **`supabase/juicereel_billing.sql`** (new, additive). It adds the sessions (SHA-256 of the state, single use), the EdgeDesk ↔ Juice Reel link (one to one), what Juice Reel said per buyer, and the webhook ledger.
  - `billing_jr_project` is the one writer into `subscriptions`. It writes `price_id 'juicereel'`, active until Juice Reel's expiry, under the existing access rule, unchanged.
  - Juice Reel only revokes what it granted. It never writes over `owner_comp`, a Stripe-backed row in good standing (it raises an alert instead) or a hand grant.
  - When it takes over a row whose Stripe subscription ended, it clears that id, so the Stripe sweep cannot end a paid buyer.
- **`supabase/juicereel_billing_cron.sql`** (new): the hourly reconcile, debounced in the database.
- **Pages.**
  - `oauth/juicereel-subscribe.html` (new): the return page. It strips the code and state, hands them to this tab only, and loads nothing.
  - `lib/edgedesk_juicereel_billing.js` (new).
  - `app.html`: when the server offers it, the paywall puts Juice Reel first, with "link my account" and the card trial below, labelled as the card's. The return is finished on the server. Settings shows a Juice Reel row as billed through Juice Reel, with no Stripe price or portal.
  - `index.html`: an EdgeDesk × Juice Reel band in Pricing ("Get EdgeDesk on Juice Reel"). Its checkout button appears only when the server's switch is on. The band is drawn by the library and styled in `lib/edgedesk_landing_desk.css`, so the page stays within its 216 KB budget; both asset stamps are recorded.
- **Off by default** (`JUICE_REEL_CHECKOUT=off`). Then `operators` for the live test, then `on`: **Actions → Deploy Juice Reel billing**. Stripe billing and the card trial are unchanged.
- **Not yet confirmed with Juice Reel:** the shapes of the subscriber-status answer, the owner subscriber list and the webhook body, and the signature's exact input. Reading them fails closed (docs/juicereel-billing.md § 9).
- **Tests:** `juicereel_billing.test.js` (82, real PostgreSQL), `juicereel_client.test.js` (25), `juicereel_checkout.e2e.js` (42, Chromium). All are in `personal-tests.yml`, the browser suite in a new `browser` job.
- `docs/juicereel.md` § 1–2 no longer say EdgeDesk does not sell through Juice Reel. What they say about the bet-sync connector is unchanged.

## 2026-10-28 — Deploying Bet Checker: checkout works with a Stripe key that can't read Products

**What was wrong.** Bet Checker made `create_checkout_session` read every price with its product expanded, to learn the product's metadata `tier`. The restricted key that `docs/billing-hardening.md` set up has no Products read, and Stripe refuses such a key the expanded product (403). Once deployed, every terminal checkout would have answered `stripe_unavailable`. The reconciler already fell back to what the database had learned. But a Bet Checker price nobody learned at checkout would have stayed unknown, and the access rule reads an unknown price as the terminal.

**What changed.**
- When Stripe refuses the product (a 403, nothing else), the checkout reads the price again on its own. The terminal's checkout never needs the product.
- In that case only, the price's own metadata `tier` stands in, in the checkout and in the reconciler. Both live Bet Checker prices carry `tier = red`.
- A product that was read and names no tier is still never overruled by its price.
- Products read is now optional: the function headers, `docs/billing-hardening.md` and `docs/bet-checker.md` say so.

**Regression check.** New section 4b of `tools/billing/tier_flow.test.js` (a key Stripe refuses every product): main's code fails 7 of its 8 checks, including "the terminal's trial checkout still sells STRIPE_PRICE_ID" (it answered `stripe_unavailable`). With this change: 52 / 0.

**Also.** `deploy-bet-checker.yml` applies `bet_checker.sql` in one transaction (`psql --single-transaction`), and a requested part whose secret is missing now fails the run instead of finishing green.

## 2026-10-28 — Bet Checker installs on production's board (the page's "board could not be loaded")

**What was wrong.** `/bet-checker/` told every reader "EdgeDesk’s board could not be loaded", and under it "No upcoming games on EdgeDesk’s board". The database half of Bet Checker had never been installed. Both *Deploy Bet Checker* runs stopped in `bet_checker.sql`'s first check, before anything was created:

| Run | Stopped on |
|---|---|
| 1, 13:18 UTC | `has_bet_checker_paid()` missing: billing had not been applied yet |
| 2, 13:46 UTC | `public.signals has no column(s) is_player_prop` |

`is_player_prop` comes from `capture_v11_player_props.sql`, which is optional. Capture writes game rows without it, and production has not run it. Bet Checker used the column only in a redundant filter: every query also pins `market` to `h2h` / `spreads` / `totals`, and a player row's market is always `player_*`.

**The change.**
- `bet_checker.sql` and its byte-identical migration mirror no longer require `is_player_prop`, and the 12 redundant predicates are gone. Every query selects the same rows as before. The grade thresholds, the free allowance and the CLV formula are unchanged.
- The game picker says "EdgeDesk’s board could not be loaded" when the load failed. "No upcoming games" is kept for a board that loaded empty.

Nothing changes in production until an operator runs *Deploy Bet Checker* with `apply_sql` and `apply_cron`.

**Regression check.** The new tests were run against the old code first:

| Suite | old code | this change |
|---|---|---|
| `tools/bet_checker/bet_checker_sql.test.js` | **111 / 1**: production's exact error; the checks that depend on the install did not run | 116 / 0 |
| `tools/bet_checker/page.test.js` | **32 / 1** | 33 / 0 |

## 2026-10-28 — Changelog and incident note: what this morning's "Update branch" merges deleted is back

**What was lost.** Between 13:14 and 13:17 UTC, #854, #855 and #853 merged. Two of them merged seconds after an "Update branch" merge commit whose conflicts were resolved in GitHub's editor, before any check ran on it:

| "Update branch" merge | Merged | What it dropped |
|---|---|---|
| `b97f6f61c` on #855 | 13 s later | #854's entry, already on `main`, and #855's own |
| `0ffe1e1be` on #853 | 15 s later | #853's own entry, and both 2026-10-28 amendments to `docs/odds-api-incident-2026-10/INCIDENT.md`, #853's and #855's |

The code of all three pull requests reached `main` intact. Only these notes were lost.

**The repair.**
- The three entries are back, verbatim from their own commits (`c78e90fd`, `7f19bf1ed`, and `main` at `cc2f8c04f` for #854), newest merge first.
- Both `INCIDENT.md` amendments are back, verbatim from `c78e90fd` and `7f19bf1ed`.
- The blank lines the deletions left at the top of this file are removed.
- Nothing else changes. AGENTS.md §5 asks for conflicts to be resolved locally, keeping both sides' entries, and for the update commit's checks before a merge.

## 2026-10-28 — Odds emergency stop: the Collective's own jobs are covered (methodology change)

**What was wrong.** The emergency stop and the hourly limits find a paid pg_cron job by its command, with `public.odds_api_spend_patterns()`, a list of function URLs. The Collective's two odds jobs, `collective_nfl_odds` (`35 12 * * *`) and `collective_cfb_odds` (`40 12 * * *`), run `select odds.run_ingest(...)`. That function posts to `collective_odds_ingest` at a URL held in `odds.settings`, so the commands match nothing. The 2026-10-14 stop never paused them, and they ran every day through the incident. The stop's own "no active paid job" row could not count them, and the hourly limits never saw them. In production `provider.default` is `theoddsapi`, so they do reach a paid path. The jobs were read from production by the read-only Collective odds doctor.

**The change** ([methodology note](docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-28-collective-jobs.md)):
- `odds_api_spend_patterns()` gains `%odds.run_ingest%`, in `odds_api_emergency_stop.sql` and in the gateway's identical copy.
- `odds_api_resume_schedules()` resumes them too: the repository's ingest buys only through the gateway.
- `odds_api_gateway.sql` now re-creates the resume verbatim, as it already re-creates the pattern list. Otherwise a database that took the new patterns would pair the stop with an older resume that keeps the Collective's jobs paused. A test keeps the two definitions identical.
- Report row 13 confirms both production commands match and the resume names them.
- The six SQL-editor parts are regenerated with `tools/sql/split_sql.js`, which reproduces `main`'s parts byte for byte from `main`'s file. Parts 5 and 6 change.

Nothing changes in production until an operator applies a file or calls the stop. Both jobs already run once a day, so the hourly limits leave their schedules as they are. No committed data changes.

**Regression check.** The new tests were run against `main`'s SQL first:

| Suite | `main` | new tests, `main`'s SQL | new tests, this SQL |
|---|---|---|---|
| `tools/odds/no_bypass.test.js` | 102 / 0 | **102 / 1** | 103 / 0 |
| `tools/odds/gateway_sql.test.js` | 104 / 0 | **27 / 8**, the stale resume aborts the live layer | 107 / 0 |
| `tools/odds/hourly_limits_sql.test.js` | 36 / 0 | **37 / 2** | 39 / 0 |

`tools/sharp_lag/sharp_lag_sql.test.js` (77) and `tools/sql/split_sql.test.js` also pass. Three existing checks count what the new fixture adds, and their expected numbers rise with it: paused jobs 6 to 8, fixture jobs 8 to 10, report rows 12 to 13. No check is relaxed.

## 2026-10-28 — Collective: polls with its own key until the Nov 1 reset (methodology change, time-boxed)

**Why.** Since 2026-10-22 every daily Collective poll was refused by `odds_gateway` (`denied_unconfirmed_quota`), so no closing line was captured. The gateway buys from the main account, which is empty until 2026-11-01 00:00 UTC. Until 2026-10-21 the Collective had bought with its own key, on its own account (443 credits left). Without a change, week 8 loses its closes as week 7 did, starting with Thursday night's game.

**The change** ([methodology note](docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-28-collective-own-key.md)):
- `collective_odds_ingest` gains one marked block. Until 2026-11-01T00:00:00Z, The Odds API requests go to the provider with `COLLECTIVE_ODDS_API_KEY`, a new name, never the main key's.
- That happens only while the key is set and `public.odds_api_enabled()` reads on. An unreadable breaker is off.
- It makes the same request as before 2026-10-21 (3 credits, american prices) and records the provider's balance, so the existing reserve guard applies. The key is redacted from every error.
- From the reset on, every request goes to `odds_gateway` again.
- `tools/odds/no_bypass.test.js` is amended openly. Rules 1 and 2 cut this one block out of this one file. `COLLECTIVE_ODDS_API_KEY` joins the forbidden key names everywhere else. A new section, 1b, pins the block: one block, this file, this expiry, this key name, the breaker before the call, and one call site.
- `deploy-odds-gateway.yml` gains a `callers` input, so `collective_odds_ingest` can be deployed alone. `close` has a pending change on `main`.

**Tests.**
- `node tools/odds/collective_own_key.test.js` (new, 29) runs the deployed handler with the database, gateway and provider stubbed and the clock injected. It covers:
  - before the reset, at its last second, and at the reset;
  - no key, a blank key, and the old key names;
  - the breaker off and unreadable;
  - a 401 echoing the key;
  - the reserve guard.

  Against `main`'s function it is 13 passed, 16 failed.
- `no_bypass.test.js`: the unamended guard catches the block (100 / 2). The amended guard passes 110 / 0, and six mutations each turn it red.
- `tsc --strict`: no new error.

**Operator steps:** set `COLLECTIVE_ODDS_API_KEY`, merge, then run Deploy odds gateway with `callers` = `collective_odds_ingest` and the other options unchecked. After Nov 1:
- unset the key;
- confirm the gateway's new-cycle quota;
- remove the block.

## 2026-10-28 — Bet Checker v1, and two billing tiers: a Bet Checker subscription never opens the terminal

**What it is.** A cheaper entry product (`/bet-checker/`, `docs/bet-checker.md`). A reader logs a bet they already placed; EdgeDesk grades the price against its own fair price at that moment (green ≥ +1.5 points of implied probability, red ≤ −1.5, from one constant, `bet_checker_rules()`), then against its own captured close (CLV by the house formula, `close/index.ts` `decideClose()`). No fair at exactly that line, or a close at a different line, is said out loud — ungraded, or *no close available* — never estimated. Free: ten grades a month and CLV on every bet; Bet Checker ($7.99/month, $59/year, Stripe product metadata `tier = red`): every bet graded, stats, splits, full history; the Research Terminal (`tier = blue`) includes it.

**What it builds on.** `public.user_bets` (bettor_decisions.sql), extended — no second bets table; `public.signals` for games, fair prices, closes and flags (there is no events table); `settle`'s word and the Collective's final scores for results; the billing core, `create_checkout_session` and the landing page's automatic-renewal consent order for checkout; the Games sign-in door, configured to come back to the page.

**What was wrong, in billing, before it could ship.** `billing_row_grants_access()` granted the terminal to any subscription in good standing, so a $7.99 Bet Checker purchase would have opened the $49.99 terminal. This is an authorization change (AGENTS.md §3), kept in its own commit:
- what each Stripe price sells is learned only from its product's metadata (`billing_price_tiers`, `billing_learn_price_tier()`), before payment and on every sync;
- `billing_row_in_good_standing()` is the old rule; `billing_row_grants_access()` is it and a price that does not sell red;
- `subscriptions.tier` follows the price (a red ↔ blue switch in Stripe flips it), `has_bet_checker_paid()` is the one Bet Checker gate;
- a Bet Checker customer is never sold the terminal's trial beside it (`switch_plan`), and the terminal's paywall sends them to the billing portal.

**Also.** `tools/personal/research_state.js` now leaves Bet Checker rows to Bet Checker's grader (it would have graded them from the record files too). The billing portal link moved from `app.html` into `lib/edgedesk_pricing.js` (`PORTAL_LINK`), which the Bet Checker page needs as well. Seven database suites that copy the access rule out of `billing_hardening.sql` (Research OS journey, signal center, simulator, NCAAM/NCAAW forecast) were stale: they now also copy what the rule calls (`billing_row_in_good_standing()`, `billing_tier_of_price()`, `billing_price_tiers`); no assertion changed.

**Regression check.**

| check | old code | this change |
|---|---|---|
| `tools/billing/tier_flow.test.js` with the rule made tier-blind again | — | **FAIL** 8 of 44, among them "THE TERMINAL IS NOT: a $7.99 purchase never opens the $49.99 product" |
| `tools/billing/tier_flow.test.js` | — | 44 / 0 |
| `tools/bettor/decision.test.js`, the new "a Bet Checker bet is left to Bet Checker's own grader" | **FAIL** (196 / 1) | 197 / 0 |
| `tools/billing/billing_hardening_sql.test.js` | 86 / 0 | 109 / 0 (a 150-case red / blue / unknown / comp grid; the report-row count moves 11 → 14 for the three new rows) |

New suites: `tools/bet_checker/bet_checker_sql.test.js` (110), `functions.test.js` (37), `core.test.js` (46), `page.test.js` (30), `page.e2e.js` (36, Chromium); CI `bet-checker-tests.yml`. No model number, signal, ranking, research protocol or signal CLV changed.

## 2026-10-28 — Landing pricing: Bet Checker beside Full Access

**What changed.** The landing page's `#pricing` sold one plan. Now it shows three cards: Free, **Bet Checker** ($7.99/month or $59.00/year, no trial) and Full Access ($49.99/month after a 7-day free trial, unchanged). Bet Checker grades bets a reader already placed. Full Access is the research before the bet, and it includes Bet Checker. The heading and a one-sentence lede say this, and the Full Access card says it includes Bet Checker. The hero's price strip names Bet Checker's price beside Full Access's. Every Full Access element, id (`#subscribe`, `#subBtn`, `#edOffer`) and the trial timeline are as they were.

- `lib/edgedesk_pricing.js`: `priceWords()` is the one map `apply()` fills from. The new words `bc_plan`, `bc_price`, `bc_monthly`, `bc_annual` and `bc_free` are derived from `BET_CHECKER` through `betCheckerOffer()`, so the landing page types no figure. The annual figure keeps its cents ("$59.00/year"), as the consent sheet shows it.
- `lib/edgedesk_bet_checker.js`: `/bet-checker/?upgrade=monthly|annual` (the card's button) is kept in `sessionStorage` through the sign-in round trip. After sign-in it opens the renewal-terms sheet on that plan, unticked, or tells a reader whose plan already includes Bet Checker. It never skips the consent. A signed-out reader sees a line by the sign-in door saying checkout opens next.
- `/bet-checker/`, seen on production before `bet_checker.sql` was applied: a stats call that FAILS used to read as "not paid", so a paying or comped reader was shown the blurred stats and an upgrade button. It now says the stats could not be loaded. A comped account (`owner_comp`) is now named complimentary in Settings, with no billing portal and nothing to cancel.
- The page's 216 KB weight budget is unchanged. The new card's few rules stay inline, because app.html sends readers straight to `#subscribe`. To make room, `#trust`'s styles (3.9 KB, below the fold, linked from nowhere) moved out of the page into the two stylesheets that already load the same way: the press list (`.press`, 1.2 KB) went to `lib/edgedesk_landing_pictures.css`, the rest to `lib/edgedesk_landing_desk.css`. Juice Reel's hero line took the desk sheet's room, and each sheet stays under its 12 KB budget (11.1 KB and 9.9 KB). A "Which one do I need?" table was built and then left out: with it the page needed 221 KB, and the owner chose to keep the budget.
- `?v=20261028b` for `lib/edgedesk_pricing.js` (index.html, app.html, bet-checker/, methodology/, research/sample/); `?v=20261028bc3` for `lib/edgedesk_bet_checker.js` (after #857's `bc2`); `?v=20261029a` for `lib/edgedesk_landing_desk.css` and `lib/edgedesk_landing_pictures.css`.

Tests: `landing_positioning.test.js` covers the card, its FEATURES lines, both links and the strip. Its "one plan card" and Free-card checks were updated for the deliberate third card. `personal_wiring.test.js` checks the derived words, `apply()` and the static copies. `bet_checker/page.test.js` checks the deep link in Node with blocked or missing storage. `bet_checker/page.e2e.js` covers a signed-in free reader on `?upgrade=annual`, the signed-out round trip and an already-paid reader. `home/landing.e2e.js` checks the filled words at six widths. `billing/juicereel_checkout.e2e.js` and `billing/checkout_flow.e2e.js` took the first non-Free card to be Full Access's, which is now Bet Checker's (no trial). They select `.pcard:not(.freecard):not(.bccard)`.

## 2026-10-28 — Collective: why last week has no against-the-spread results, and a read-only doctor that shows it

**What was wrong.** All 14 NFL week 7 games settled with a final score and no captured closing line. So none of them has an against-the-spread (ATS) result. The last close on file is WAS @ SF (kickoff 2026-10-20 00:15Z). The settlement refresh puts every week-7 game in class L: snapshots exist, but none falls inside the final 360 minutes before kickoff. College week 8 has no closes either. College closes have been mostly missing all season (the ten-character name join in `collective/settled/README.md`), so the stop shows most clearly in the NFL.

**The cause, read from production.**
- The Collective polls The Odds API once a day (`provider.default = theoddsapi`; pg_cron `collective_nfl_odds` at 12:35Z, `collective_cfb_odds` at 12:40Z) through `odds.run_ingest`. Its own quota read 57 used and 443 remaining on 2026-10-21.
- The last successful poll was 2026-10-21 12:35Z, which wrote 872 snapshots.
- That evening, Deploy odds gateway (21:51Z) put this repository's reconstruction of `collective_odds_ingest` live for the first time. In that version, The Odds API is reached only through `odds_gateway`, in category `collective`.
- From 2026-10-22 through 2026-10-27, all 11 polls (NFL and college) ended `odds_gateway: denied_unconfirmed_quota`. No snapshot was written.
- The gateway's switch is on (since 2026-10-21 20:46Z), with a 60,000 budget, and the `collective` category is enabled. But the gateway has seen no provider quota header in the October cycle (`provider_observed_at` is empty, `quota_confirmed` false), so it refuses every paid request. Its spend this cycle is 0.

**What this changes.** Nothing in production. It adds the tool that read the cause:
- `tools/collective/odds_doctor.js` reads `collective_odds_ingest`'s `GET /v1/status` and, inside `BEGIN TRANSACTION READ ONLY`, the pg_cron jobs that poll the ingest, the emergency stop's paused-jobs log, the jobs' runs, pg_net's recent answers, `odds.ingest_runs`, snapshot and closing-line counts by day, `odds.settings` (no setting whose name contains token, secret or key), and the gateway's switch, cycle, categories and decisions on the Collective's requests. It calls no provider and writes nothing. Every printed value is redacted first.
- `.github/workflows/collective-odds-doctor.yml` runs it from Run workflow, or from a push to `claude/**` with `[odds-doctor]` in the head commit. Any other push runs only its tests.

**Not changed, and why.**
- Last week stays graded on scores alone. The Collective never stored those closes. Its rule allows only its own captured close, and filling them from another source would be a methodology change.
- Restoring the polls means either confirming the gateway's quota (the main account was spent on 2026-10-10 and resets 2026-11-01 00:00 UTC) or giving the Collective its own key back. Both are odds gateway budget and bypass decisions (AGENTS.md §3), so they are left to the owner.

Tests: `node tools/collective/odds_doctor.test.js` (40) covers redaction of tokens, JWTs, connection strings and header values; read-only wrapping; argument and identifier validation; and the report end to end on stubs. The test was mutation-checked: dropping the header-value rule, or `READ ONLY`, turns it red. Every section also ran against a local PostgreSQL 16 with pg_cron-, pg_net-, odds- and gateway-shaped tables, and a planted cron token never appeared. `collective-tests.yml` runs the suite.

## 2026-10-27 — FBS board: a card the reader opened stays open when late data repaints the board

**What was wrong.** Opening a game on the FBS board draws its card into `#p4gate-<id>` (`fbP4Gate`). The board draws every row closed. About 40 places call `renderFootball()` when their data lands, among them the season record, the quote-EV tables, the grades and the matchup data. Only the 60-second price refresh went through `fbRepaintKeepingPlace()`, which reopens the open cards. So a card opened in the first seconds after load could shut again, empty, when a late artifact arrived.

**How it showed.** `tools/football/game_research_ui.e2e.js` failed once inside a full `npm run verify`: 53 / 1, "an FBS card opens with EdgeDesk's projection above the decision", `{"lead":null,…}`. Run alone, it passed. The check opens a card 1.5 s after the board first paints. In a normal run the board repaints four more times in that window, the last at +1.4 s. Under load, one of those repaints can land on the card just opened.
- One `renderFootball()` after the open reproduces the failure exactly: 53 / 1, `{"lead":null,"before":false,"hasBtn":false}`.
- Nothing forced, with the season record (`record/football/cfb_<season>.json`) served 4 s late: its own repaint, 2.5 s after the click, closed the card. Six seconds after the click, the card was still closed and empty.

**The repair.**
- `renderFootball()` notes the open cards before it repaints (`fbP4OpenGates`) and reopens them after (`fbP4Reopen`). It does this the way `fbRepaintKeepingPlace()` did, without counting a second visit.
- `fbRepaintKeepingPlace()` keeps its scroll and `<details>` restore, and leaves reopening the cards to `renderFootball()`.
- No model number, threshold, record or existing assertion changed.

**Regression check.** `game_research_ui.e2e.js` now repaints the board once after the card opens. It requires the card to stay open with the same lead.

| `node tools/football/game_research_ui.e2e.js` | old `app.html` | this `app.html` |
|---|---|---|
| the new check | **FAIL** `{"open":false,"lead":null}` (54 / 3) | 58 / 0, twice |
| season record served 4 s late, nothing forced (local probe, not committed) | closed and empty 6 s after the click | open, same lead |

## 2026-10-27 — Research OS journey and changelog: what this morning's "Update branch" merges deleted is back

**What was lost.** Between 12:51 and 12:59 UTC, #844, #841, #840, #842 and #843 merged. Three of them merged on an "Update branch" merge commit, two of them within ten seconds of it. Those three merges dropped work that no check had seen:

| "Update branch" merge | Merged | What it dropped |
|---|---|---|
| `6f51155e8` on #841 | 1 min 51 s later | #844's entry and #841's own |
| `70440b1fe` on #842 | 9 s later | #842's entry, and the journey check itself |
| `a3e2dd729` on #843 | 10 s later | #843's own entry |

#841 and #842 had fixed the same journey check in parallel. #841 merged first. The conflict on #842 was resolved by deleting both versions: `SNAP_HOME`/`SNAP_AWAY` and the "the game is the research context" check, on desktop and phone. `tools/research_os/journey.e2e.js` stayed green, with two checks fewer, and it stopped noticing a game page that carries the wrong team.

**The repair.**
- `tools/research_os/journey.e2e.js` is again exactly #841's version (`d57ddc4c4`). It is the stronger of the two fixes: it checks the home and away names against the research snapshot, and requires both to exist.
- The four entries are back, verbatim from their own commits, in merge order (`a3e2dd729^1`, `10145b2cd`, `6f51155e8^1`, `e68bdbfda`).
- #842's entry describes #842's version of the check. That version never reached `main`, because the merge deleted it along with #841's. The code that stands is #841's.
- #840 added no entry. Its change to `discover()` reached `main` first through #844, which carried it byte for byte.

No other file changed.

**Before and after.** `ROS_SQL_REQUIRED=1 ROS_E2E_REQUIRED=1 node tools/research_os/journey.e2e.js` on `main` (`43e1d8ea4`, Delaware at Western Kentucky):

| | today's data | `gvCtx` handed the away team's name (local mutation, not committed) |
|---|---|---|
| `main` | 124 / 0 | **124 / 0**: the wrong name passes |
| this branch | 126 / 0 | **124 / 2**: "the game is the research context" fails |

The lesson is §5's, again: after "Update branch", wait for that new commit's checks, and resolve conflicts locally, keeping both sides' changelog entries.

## 2026-10-27 — NHL engine browser suite: read the goalie block after the starter sync answers

**The intermittent failure.** `NHL engine › The NHL and Engine panels in Chromium` sometimes failed "the slate fallback says the starter sync has no card for the game yet" (`tools/engine/engine_ui.e2e.js`). It failed once on a fully loaded machine. It passed six reruns at the same commits.

**The cause.** `goalieBlock` (`lib/edgedesk_engine_ui.js`) draws the slate's goalie block at once. It then asks the starter sync, and draws the block again with the answer, which is when the "no card" note appears. The suite read the block once "Starting goalies" was drawn. That is already true before the answer, so a slow reply lost the race.

**The fix (test only).** The suite also waits until `EDNHLGoalies.state(game)` has finished loading and holds an answer or an error, then reads the block. The assertion is unchanged.

**Tests.**
- **Unchanged suite, sync reply held 2 s:** 150 passed, 2 failed (desktop and phone), the same failure as the loaded machine.
- **Fixed suite:** 152/0, and still 152/0 with the reply held 2 s.
- **Mutation:** with the note removed from `lib/edgedesk_nhl_goalies.js`, it still fails 150/2, so the wait masks nothing.

## 2026-10-27 — The jobs that refit a model record publish the registry rebuilt from it

**Why.** `engine/registry.json` reads each sport's state from its committed record. On 2026-10-26 the college baseball weekly validation pushed a record whose state had changed, but not the registry. For 100 minutes `main` disagreed with itself, and Multi-sport lab failed on every pull request (#828 fixed that job). Three more jobs publish a record the registry reads without the registry:
- the UFC model loop (`model_loop/published/ufc/validation.json`);
- the basketball model loop (`basketball/validation/<league>_walkforward.json` on a promotion);
- the college baseball model loop's `release` mode (`college_baseball/validation/walkforward.json`).

The four jobs that do publish the registry (`lab-build`, `lab-validate`, `nhl-build`, `nhl-validate`) carried their own copy over a newer tip when a push was rejected. That copy drops whatever record another job had just published.

**What.**
- `model-loop-ufc.yml`, `model-loop-basketball.yml` and `model-loop-college-baseball.yml` (release only) rebuild the registry and board after the record, `--check` both, and push them with the record.
- Every job that publishes the registry sets `PUSH_REBUILD: node engine/build_registry.js && node engine/build_board.js`, so on a rejected push both are rebuilt on the new tip (`tools/ci/push_generated.sh`).
- `lab.yml` also runs on pull requests that change the record-refitting workflows.

**Evidence.** A local race through the real `tools/ci/push_generated.sh`: one job published an NBA record change and the registry, and a UFC loop that had started from the same commit lost the push.
- Before: the UFC loop's carried registry still said NBA moneyline `OUTCOME_VALIDATED` over a record that said `PROVISIONAL`, and `engine/build_registry.js --check` FAILED on the result.
- After: the registry on the new tip held both changes, and `--check` passed.

**Tests.**
- `tools/lab/lab.test.js`: each of the seven jobs that refit a record the registry reads rebuilds, checks, pushes and `PUSH_REBUILD`s the registry and board. 15 checks fail on the old workflows.
- `tools/ci/push_generated.test.js` §11 lists the registry and board as aggregates. It fails on the four jobs that carried them.

**Not here.** The football records (`football/validation/linemaker_*.json`, `pricing_*.json`) are rewritten by `linemaker-calibrate.yml`, `learning-loop.yml` and `football-weekly-build.yml`. Their registry is rebuilt only by the next lab or NHL build. `linemaker-calibrate.yml` pushes with `git pull --rebase`, which conflicts on a file another job rewrote, so it needs `tools/ci/push_generated.sh` before it can carry the registry. That is a separate change.

## 2026-10-27 — Research OS journey: the game page's context is checked against the label the game page carries

**What broke.** Since the scheduled slate push at 00:22 UTC (`f213b5eb`, "slate: today's games"), `tools/research_os/journey.e2e.js` has failed on `main` with 124 passed and 2 failed:

```
FAIL | desktop: the game is the research context  {..."researchKey":"cfb|401871071",..."home":"Western Kentucky",...}
FAIL | phone: the game is the research context  {..."researchKey":"cfb|401871071",..."home":"Western Kentucky",...}
```

It turns Research OS tests (`browser`) and All checks red on every pull request that starts them. #835 was the first, and it merged with this check red. Research OS tests runs only on pull requests, so `main` did not report the failure itself.

**Why.** The journey takes the earliest upcoming NFL or FBS game on the committed slate. Before the push that was Dallas at Philadelphia (`nfl|2026_07_DAL_PHI`); after it, Delaware at Western Kentucky (`cfb|401871071`). The game page builds the research context from the game research snapshot (`gvCtx` in `app.html`, through `EDContext.fromResearchKey`), so its `home` is the snapshot's label, "Western Kentucky". The check compared it with the slate's label, "Western Kentucky Hilltoppers". NFL snapshots and the slate use the same names, so the check passed only while the first game was an NFL game. `home` and `away` are display labels only (DESIGN.md §2), and the code is right. The check depended on which sport the day's first game was.

**The repair.** The check compares the context's `home` with the research snapshot's `home.name`, the label the game page is built from. It is still an exact match, together with the research key. Every other check is unchanged. No app code, data or fixture changed.

**Before and after.** `ROS_SQL_REQUIRED=1 ROS_E2E_REQUIRED=1 node tools/research_os/journey.e2e.js`:

| Data | old test | this test |
|---|---|---|
| `main` before the slate push (`f213b5eb~1`, DAL @ PHI) | 126 / 0 | 126 / 0 |
| `main` after it (`1b8a82be`, DEL @ WKU) | **124 / 2** | 126 / 0 |
| `main` after #835 and #839 (`b48f627d`, DEL @ WKU) | **124 / 2** | 126 / 0 |
| `1b8a82be`, with `gvCtx` handed the away team's label (local mutation, not committed) | 124 / 2 | **124 / 2** |

The last row shows the check still fails when the game page carries the wrong label.

## 2026-10-27 — Research OS journey: the research context is checked against the names the game page shows

**What broke.** Since the scheduled slate push at 00:22 UTC (`f213b5eb6`, "slate: today's games"), `tools/research_os/journey.e2e.js` has failed on `main` with 124 passed and 2 failed:

```
FAIL | desktop: the game is the research context  {..."researchKey":"cfb|401871071",..."home":"Western Kentucky","away":"Delaware",...}
FAIL | phone: the game is the research context  (the same)
```

It turns Research OS tests (`browser`), Market Foresight tests (`database`) and All checks red on every pull request that starts them.

**Why.** The journey takes the earliest upcoming NFL or CFB game on `today/slate.json` that has a research snapshot. Before the push, that was Dallas at Philadelphia, which the slate and the snapshot both call "Philadelphia Eagles". After it, the game was Delaware at Western Kentucky:
- the slate calls the home side "Western Kentucky Hilltoppers";
- the research snapshot calls it "Western Kentucky".

The game page builds the research context from its snapshot (`gvCtx` in `app.html`, through `EDContext.fromResearchKey`, "the labels the caller saw"). So the context carries the name the page shows. The test compared that name with the slate's. The app is right; the test's expectation was wrong.

**The repair.** The test only.
- The check now compares `ctx.home` and `ctx.away` with the snapshot's names, and requires both to exist.
- The research-key check is unchanged.
- The search check and the seeded watchlist rows still use the slate's names, which is what they read.
- No app code, data or threshold changed.

**Before and after.** `node tools/research_os/journey.e2e.js`, run locally with `ROS_SQL_REQUIRED=1 ROS_E2E_REQUIRED=1`:

| Data | Old test | This test |
|---|---|---|
| `main` (`c91cc05ab`): Delaware at Western Kentucky | 124 / 2 | 126 / 0 |
| slate and snapshot at `4630c7685` (before the push): Dallas at Philadelphia | 126 / 0 | 126 / 0 |
| `main`, with the game page's home and away swapped in `gvCtx` (mutation, not committed) | not run (already red on this data) | 124 / 2: the context check fails |

## 2026-10-27 — Content engine: an NFL stat lifted out of its "When X have the ball" heading names X

**What was wrong.** An NFL matchup claim reads "When Tennessee Titans have the ball: their passing game ranks No. 29, and Cincinnati Bengals' pass defense ranks No. 17." The matchup analysis lifts such claims into its thesis ("The football that does point toward Cincinnati Bengals:") and its counterargument ("The case for …"). It dropped the clause and kept "their", so the bullet read "Their passing game ranks No. 29": Cincinnati's by every reading, and it was Tennessee's. The frozen Week 6 / NFL Week 5 drafts held 20 such sentences, at least one in every NFL matchup analysis.

**The repair.** `stripWhen()` puts the team back where "their" stood ("Tennessee Titans' passing game ranks No. 29"). Under the evidence section's "**When X have the ball.**" heading, which names X, the pronoun stays. College claims carry no "their" and are unchanged. The Edge Function's copy is regenerated with `node tools/content/inline.js`; it reaches production only on a manual deploy.

**Also on this branch.** #840's `discover()` change (a matchup analysis only where the evidence argues both sides), ported byte-for-byte so this branch's Content engine check passes while `main` fails it on Tennessee at Cincinnati. It is a no-op once #840 merges, and its record is #840's.

| `node tools/content/content.test.js` | result |
|---|---|
| without this change | 334 / 1: "- Their run game ranks No. 3, and Atlanta Falcons' run defense ranks No. 25." (BAL @ ATL) |
| with it | 335 / 0 |

## 2026-10-27 — College football: the graphic's chips add up to the line, and a game-by-game trust audit

**The question.** Is EdgeDesk overrating teams like Missouri State (fair −6.65, DraftKings −4.5) and Western Kentucky (fair −3.3, DraftKings +1.5)? Does the model take account of past weeks?

**What the season says.** These are 393 graded FBS-vs-FBS games, as of 2026-10-27 13:30 UTC.
- EdgeDesk missed by 11.90 a game and the close by 10.99. The close finished nearer the final in 59.3% of games.
- A disagreement with the close carries no measurable information: slope −0.13, 95% CI −0.42 to +0.16. At a 7+ point gap the close was nearer in 69%.
- There is no systematic lean: today's 15 lined games average +0.28 points toward the home side.
- A team's earlier misses do not predict its next one (slope +0.02, 95% CI −0.13 to +0.17, n 278), so the ratings do absorb past weeks.
- Missouri State's 2.2-point gap is mostly its 1.74-point stylistic matchup term. That term's held-out gain is not significant. On this season's games alone, Sam Houston rates 1.0 better on a neutral field. The long-run track, weighted 60%, has Missouri State 4.2 better.

**Fixed: a college card's chips add up to its line** (`lib/edgedesk_game_snapshot.js`). The "What to watch for" chips were picked on story strength alone. On 2026-10-27, 59 of 63 college cards left a priced engine term off every chip:
- SHSU @ MOST printed MOST +2.1 and +2.8 on 6.65, with the matchup term nowhere.
- DEL @ WKU printed WKU +0.1 and +0.4 on 3.27, without the 2.8-point home field.

Each engine term now sits on exactly one in-number chip. A missing term takes the place of the weakest item that carries no points. The regression test in `tools/football/game_research.test.js` §15 failed on the old code (59 of 63) and passes now.

**Fixed: no term on two chips, NFL included.** BAL @ BUF printed BUF +3.2 twice (its QB watch and the quarterback term's own item). LAC @ LAR printed LAC +1.8 twice (travel and the rest-and-travel term). The item that tells the story keeps the chip. The other gives its place to the strongest item that adds no term already shown. The regression test failed on the old code (those 2 games) and passes now.

**New: `npm run cfb:trust`** (`football/cfb_validation/trust.js`, `docs/cfb-validation/TRUST.md`). For every upcoming college game it gives:
- the gap to the latest pregame line, and the terms behind the number;
- both rating tracks;
- each team's season against EdgeDesk and the close;
- the season's record at that size of gap.

It is research only: it writes nothing by default and changes no number, grade or label. Its 47 contracts run in CFB validation.

## 2026-10-27 — Football decision test: one fix for the NFL hold-rule guard, and the merge that broke it reverted

**What broke, twice.**
1. At 23:12 UTC on 2026-10-26, the scheduled push `e0205970` moved ARI @ DAL from DAL −6.5 to −6. That left no game on the live NFL slate whose pricing blend is held at the market line. `tools/bettor/football_decision.test.js` required one ("real NFL: the board holds some real games"), so it failed 180 / 1. The engines were right: the board held 0 and the kernel held 0.
2. #836 and #837 fixed that in parallel, each green on its own. Both pinned the hold-rule checks to `tools/fixtures/nfl_slate_2026-10-25.json`, where both engines hold DEN @ ARI.
   - #837 merged at 02:00:00 UTC.
   - "Update branch" on #836 merged `main` into it at 02:01:15 (`04f23a4e`). Git took hunks from both versions without a conflict, and the result kept neither function header around the per-game body.
   - #836 merged 19 seconds later, before that commit's checks reported.
   - From then on the file threw `ReferenceError: g is not defined` at line 514, in CFB research terminal, Decision quality and Personal research CI.

**The repair.** #836's merge is reverted (`git revert -m 1 2016a238`). The test is again exactly #837's (`3f9fb966`):
- the held-rule checks run on the live slate plus the pinned slate;
- the guard is met by DEN @ ARI whatever the live lines are.

No assertion, threshold or fixture changed.

**Before and after.** `node tools/bettor/football_decision.test.js`:

| `main` | result |
|---|---|
| at `e0205970` | 180 / 1 |
| `d3267217` | `ReferenceError` |
| this revert | 181 / 0 |

**The lesson is §5's:** after "Update branch", wait for that new commit's checks. They are the only checks that have seen the merged code.

## 2026-10-26 — Changelog: the last entry the #819 merge dropped is back

The web-editor merge `c1081ebf7` (#819) dropped two `CHANGELOG.md` entries. #826 restored #819's own. The other, "Model integrity audit: six input and pricing defects repaired, and every projection checked against its inputs and the market" (#818), is back, verbatim from `c7de08986`, where it stood: just before "All checks". Every heading from both sides of that merge is present again.

## 2026-10-26 — College baseball: the weekly run keeps its registered holdout look

**What broke.** The weekly validation run of 2026-10-26 (`fee3a2e0b`, 19:05 UTC) dropped college baseball's registered HOLDOUT look: `OUTCOME_VALIDATED` on 16,696 games, taken on 2026-10-14. Moneyline became `PROVISIONAL`, and two Lab checks failed on `main`:

- `engine/build_registry.js --check`: "the committed readiness state differs from the evidence";
- the Lab test "college baseball is validated only by its own holdout record".

The push came from `GITHUB_TOKEN`, so no workflow ran on it, and no check showed the failure. At 20:45 the scheduled NHL job (`9beb24587`, "the cross-sport board") rebuilt `engine/registry.json` from that evidence. College baseball became `EXPERIMENTAL` (summary 8 validated, 2 experimental, 1 retired), and the checks passed again. The downgrade was now committed, and served.

**Why.** Since 2026-10-21, `college_baseball/walkforward.js` carries a holdout look only to a report of the same configuration (`config_sha256`). A report made before configurations were hashed was carried only if `legacy_config` held, and `legacy_config` also required that **no loop version be served**. The loop's first run seeds `versions.json` with version 1.0.0, "selection-window tuning", served. That version is exactly team_tuning's configuration (`3252f395…` for team_tuning, version 1.0.0 and the weekly report alike). Being served at all made it look like another configuration, and the look was withheld.

**The repair.**
- `legacyConfig()` compares configurations only, as the 2026-10-21 protocol amendment states: "carried forward only to a report of that exact configuration".
- The 2026-10-19 records are restored by reverting the bot's commit. They are the job's own outputs, and the look was stored nowhere else (`holdout_looks.json` did not exist yet).
- `engine/registry.json` is rebuilt by its own build (`node engine/build_registry.js`). Only college baseball changes: `EXPERIMENTAL` → `OUTCOME_VALIDATED`, summary back to 9 / 1 / 1. `value_claims_enabled` stays empty.
- The next weekly run, or Actions → College baseball research validate, rebuilds this week's records. It carries the look and stores it in `holdout_looks.json`.
- `lab.yml` now also starts on `college_baseball/validation/**`, the records `engine/build_registry.js` reads. Before, no pull request that changed college baseball's evidence started the workflow that checks it.

**Before and after.** `walkforward.js`, run as the job runs it, on the restored records:

| Code | Moneyline | n | Holdout |
|---|---|---|---|
| old | `PROVISIONAL` | 11,950 | withheld; no `holdout_looks.json` |
| fixed | `OUTCOME_VALIDATED` | 16,696 | carried from 2026-10-14; stored in `holdout_looks.json` |

On this branch:
- Lab: 76 passed, 0 failed (it was 75 and 1);
- `build_registry.js --check`: ok;
- `tools/college_baseball/loop.test.js`: 32 passed, 0 failed (+3). On the old `walkforward.js` it throws.

## 2026-10-26 — CI: `npm run verify` stops reporting this machine's gaps as failures

A full `npm run verify` reported 19 failures, and 11 of them were this machine's, not the code's. `tools/ci/verify.js` now reports a failure the machine explains as **NOT VERIFIED**, with the reason and, where there is one, the command to run. A pass is always a pass, and any other failure stays FAIL.

| Failure | Why it happened | Now |
|---|---|---|
| Data packs, NBA (3), NCAAM research (2) | `node` steps shell out to Python, but only a step whose own script says `python3` was checked against the job's skipped `pip install` | NOT VERIFIED when the log names a missing package, or an earlier step of the job already failed for one |
| Simulator Typecheck (one step, counted 3 times) | the job's `npm ci --prefix simulator` is skipped, and `simulator/node_modules` is not here | NOT VERIFIED, naming `npm ci --prefix simulator`. A reused NOT VERIFIED step stays NOT VERIFIED; it was counted FAIL. |
| games-sql "Refuse a silent skip" | it checks logs that its PostgreSQL steps write, and those did not run | NOT VERIFIED: it reads a file only a step that did not run writes |
| MLB live probe | a live source inside a deterministic workflow | `tools/ci/checks.json` `live_jobs`; run only with `--include-live` |

Files a step creates (screenshots, a suite's log) are no longer deleted. They move to `.cache/verify/<run>/created/`, and a rewritten committed file is copied to `.cache/verify/<run>/rewritten/` before it is restored.

Tests: `tools/ci/verify.test.js` goes from 32 to 43; 11 of them fail on the previous `verify.js`. `tools/ci/workflows.test.js` adds 1 check: every `live_jobs` entry names a real job.




## 2026-10-26 — CFB altitude: the browser suite runs again, on a frozen snapshot, and cannot skip in CI

**The silent pass.** `football/altitude/ui.e2e.js` read the Notre Dame at BYU game (401856809) from the live `football/game_research/current.json`. The hourly build dropped the game at `1d57b3cd` (2026-10-19 12:08 UTC), two days after kickoff. From then on the step printed `SKIPPED: the committed research snapshots no longer carry Notre Dame at BYU`, exited 0, and showed green in `CFB altitude tests`, testing nothing.
- #807's own run shows it: the step took 0 s on the pull request that rewrote the game view.
- AGENTS.md §4: a suite that prints SKIPPED has not passed.

**The fix.**
- **The snapshot is frozen.** `football/altitude/fixtures/byu_notredame_research.json` holds the game's last pregame entry, copied unchanged from `current.json` at `23282594a` (generated 2026-10-17 22:38 UTC). The suite serves it inside the committed file's envelope.
- **A stale fixture fails.** A new check fails when the committed file's snapshot version is no longer the fixture's.
- **A missing browser fails in CI.** Under `CFB_ALTITUDE_E2E_REQUIRED=1`, now set in `cfb-altitude-tests.yml`, a missing Playwright or Chromium fails the step. Locally it prints `SKIPPED (not verified)`.

No assertion changed, and no committed snapshot, parameter or record was touched.

**Tests.** On `main` (`0ad40e40`) the step printed SKIPPED and exited 0, with or without the new variable. Now it runs 41 checks, all passing at 390 px and 1280 px, so #807's game view still draws the section. Each failure path was shown to fail: no Playwright under the variable (exit 1), and a fixture version the committed file does not carry (exit 1).

## 2026-10-26 — NCAAW forecast tests: no longer tied to the served model's version

**The failure on `main`.** At `cf8d09fb9` (17:22 UTC) the weekly model loop promoted the served NCAAW model, moving `docs/model-loop/ncaaw/versions.json` from 1.1.0 to 1.2.0. A push by a workflow starts no other workflow, so nothing ran, but two `NCAAW forecast suites` jobs fail from that commit on. Their tests assumed the old version.
- **`tests/sql.test.js`** (`sql` job), 68/0 → 67/1. "A ROLLBACK needs a reason" named `ncaaw_points@1.1.0`. The registry now records the incumbent as `@1.2.0`, so `ncaaw_fc_set_champion` refused an unrecorded model and the check never reached the reason rule.
- **`tests/ops.test.js`** (`ops` job), 37/0 → 34/3. The promote injection ran the frozen selection against the served incumbent and relied on its PROMOTE. Against 1.2.0 it is RETAIN, so the promote boundary was never reached.

**The fix (tests only).**
- **SQL test.** It takes the incumbent's key from the registry it initialized.
- **Promote case.** It starts from a throwaway registry whose champion is the frozen selection with a prior 64 times too strong, and runs `--only lambda_weaker_prior`. The gain on 2026-10-26 was 0.029 log loss (95% CI 0.027 to 0.031) against the 0.0002 required, and every gated cohort improved.
- **Store case.** The bootstrap run, served incumbent against the frozen selection, moves to the store case. It stops after evaluation whatever the decision, so it keeps that coverage without depending on the decision. A new check confirms it evaluated `selection_v1` against the incumbent.

**Not touched.** No assertion is loosened. No model, version file, gate, policy or record changes.

**Tests.** Both suites pass at the incumbent's old and new versions:
- at `ed0691fda`, 1.1.0: SQL 68/0, operations 38/0;
- at `main`, 1.2.0: SQL 68/0, operations 38/0.

## 2026-10-26 — Sharp lag (Experimental): slow markets against Pinnacle, graded at the close; NBA role shifts

**What it asks.** Does a slow market (a Kalshi YES price, DraftKings) that sits at least 2.5 percentage points below Pinnacle's de-vigged fair, after its own fees, show positive closing-line value? And does a teammate's volume prop lag when a rotation player is ruled out? Research only: a flag records a measured gap at one moment, and every flag is graded against the close, losses included. `docs/sharp-lag/README.md`.

**The pieces.**
- **The anchor (A).** The free `sharp_lag` function (every 10 minutes, never spends) stores Pinnacle and DraftKings from snapshots the gateway already bought, append-only, de-vigged by Shin (capture's arithmetic).
- **Triggered checks (B).** An NBA starter's status change, an NHL goalie change and a Kalshi move of 3¢ or more are recorded as triggers. The paid `sharp_check` dispatcher (hourly, through `odds_gateway` only) buys one check per event, inside the `sharp_check` category's daily cap. Dispatch starts in `shadow` and buys nothing until an operator switches it to `live`.
- **Flags (C).** Same side and same point only. DraftKings cost includes its vig. Kalshi cost uses the highest plausible fee and is marked `fee_unverified` until Kalshi's published schedule is verified and recorded. One flag per episode; append-only; the database refuses a flag below the registered threshold or on a past price.
- **Registered before graded (R).** `SHARP-LAG` and `NBA-ROLE-SHIFT` v0.1 are registered separately, EXPERIMENTAL. Promotion needs BOTH 200+ graded flags AND a 95% lower bound on mean CLV above zero, from a bootstrap clustered by game. A person promotes; code never does. The database refuses any grade before the registry link exists.
- **Grading (D).** The close is the last Pinnacle observation after the flag's own observation, at or before the start and no more than 90 minutes before it; graded against itself, a flag's CLV would be its gap. CLV = closing fair − cost; hit = CLV > 0. Lag to converge is censored at the start. Every flag carries its snapshot resolution. The record reports the no-close count and rate as data quality.
- **Surfaces (E).** "Sharp lag · Experimental" sections on the football game page and the terminal's matchup view, today's flags in Signals, and a public record on Performance. Live fairs and live flag details are for subscribers. The public gets counts and progress, plus every flag once its game has started, but only after an operator switches `public_display` on, having read The Odds API's terms (not readable from the build environment).
- **NBA role shifts (F).** The 3-hourly NBA build writes `nba/role_shift.json`: for every top-8 rotation player, his teammates' minutes and volume in an injury-conditioned regime. Game-level with/without splits are shrunk by 10 games and fed through the existing props model, with stints as a cross-check and 3PM = 3PA × a shrunk 3P%. The default props are unchanged. When a report moves the player to OUT or DOUBTFUL, `sharp_lag` switches to that scenario, and `sharp_check` buys one capped `nba_role_props` pull. Flags use the registered 2.5 pp (never the absent player's unders) and are graded at the same book and line, with the actual stat stored. The NBA game page shows "Who absorbs the minutes".

**Builds on** the methodology change "Odds gateway: per-category daily caps" (#834, merged), which created the `sharp_check` and `nba_role_props` categories, disabled, and the spend patterns that let the emergency stop pause `sharp_check`. `supabase/sharp_lag_cron.sql` refuses to run until those patterns are installed.

**Not verified here.** Kalshi's current fee schedule and The Odds API's terms (neither site is reachable from the build environment). The production database's state is also not verified.

## 2026-10-26 — Odds gateway: per-category daily caps (methodology change)

**Why.** The Sharp-lag research pipeline buys event-driven checks (an injury, a goalie change, a Kalshi move) and NBA role-shift props. A news trigger has no schedule, and the gateway had no limit per category: a category could spend until the shared daily allowance shed it. The owner's decision was a cap the gateway enforces itself, never one that lives only in the caller.

**What.** `supabase/odds_api_gateway.sql`, its six parts regenerated:
- `odds_api_categories.daily_cap_credits` (NULL = no cap, every existing category);
- `odds_api_acquire` refuses `denied_category_cap` under the same config-row lock as the shared budget;
- two categories, created **disabled** at priority 4: `sharp_check` (≤ 3 credits a request, 90/day) and `nba_role_props` (≤ 4 credits a request, 48/day), each inside 24 h of the start only, at most hourly;
- `odds_api_spend_patterns()` covers `/functions/v1/sharp_check` and its cron poke `sharp_check_poke()`. The emergency stop's list and the gateway's copy are kept identical by a test.

Full write-up and operator steps: `docs/odds-api-incident-2026-10/METHODOLOGY-2026-10-26-category-caps.md`.

**Evidence.** `tools/odds/gateway_sql.test.js` section 14 on a real PostgreSQL:
- before (`main`'s SQL): 70 passed, 5 failed;
- after: 104 passed, 0 failed, including 12 concurrent sessions against a 12-credit cap (exactly 4 granted).

`tools/odds/no_bypass.test.js` checks that the emergency stop names the new dispatcher.

## 2026-10-26 — Model integrity audit: six input and pricing defects repaired, and every projection checked against its inputs and the market

**Why.** Several of the day's NBA, NFL, CFB and NHL numbers sat far from the market. The question was whether any came from a wrong input or invalid math, as opposed to an honest disagreement. Two did: Philadelphia was priced with Jalen Hurts while he was on the reserve list, and EDINTEL's EV counted a push as a win.

**What.** One commit per defect, each with a regression test that fails on the old code:
- NFL (`app.html`, `tools/football/build_nfl_slate.js`): a QB whose roster status is `RES`/`CUT`/`RET`/`SUS` is replaced as an OUT QB is. That status is PENDING when it comes from an earlier week's roster, and the replacement search skips players off the active roster.
- EDINTEL `decide()`: a two-way no-vig probability becomes p(1−q) before the push mass is added, and the edge is measured against (1−q)/d.
- Game, NBA and NHL graphics: the gap between a mean and a line is a *reading*. "EDGE" needs the exact bet's probability, pushes counted, to clear its offered price's break-even, and the sport's value claims enabled.
- NHL `startersFor()`: a game is CONFIRMED only when both goalies are. An operator-listed unavailable goalie leaves the projection.
- NBA `splitAbsent()`: a regular now on another roster is "left the team", never an absent regular or a return.
- Board: the NHL whole-number total's market reference carries its push.
- New shared audit `lib/edgedesk_model_integrity.js` → `engine/model_integrity.json`:
  - built every 3 h by `projections-build.yml`;
  - classifies each game as INPUT_ERROR, STALE_DATA, MISSING_CRITICAL_INPUT, CALIBRATION_WARNING, LARGE_MARKET_DISAGREEMENT, INSUFFICIENT_EVIDENCE or VALIDATED_INDEPENDENT_SIGNAL;
  - compares each projection only with a quote captured before it;
  - reads its thresholds from `engine/model_integrity_config.json`;
  - publishes how games beyond each threshold have actually gone;
  - shows as chips and a matchup section in Today's Games, which holds the signal chip while an input is unresolved.
- `tools/model_integrity/calibration_report.js` and `docs/system-integrity/MODEL_INTEGRITY.md`: the calibration evidence and the methodology changes it calls for.

No model was moved toward the market. No ledger, fitted bound or methodology changed.

**Evidence.**
- Same feeds, same instant:
  - DAL @ PHI moved from PHI −2.83 to −0.58 (Tanner McKee).
  - PHI @ WAS moved from WAS −0.28 to −2.52.
  - The other 14 games did not change.
- EDINTEL: a 50% fair side at 1.909 with a 6% push read EV +1.45%; the correct figure is −4.27%.
- The LAK @ NYR card read "EDGE: OVER 5.5" with P(6+) 52.67% against a 56.52% break-even.
- College football out of sample, 2022–2025 (n = 3,120):
  - Margins are too wide: slope 0.933, SE 0.022.
  - Win probabilities are too extreme: recalibration slope 0.854, 95% CI 0.78–0.92.
  - Disagreement with the opener carried no information about the result: slope 0.055 ± 0.057.
  - Each fix is a methodology change for its own pull request (MODEL_INTEGRITY.md §7).

**Tests.**
- Model integrity: `tools/model_integrity/model_integrity.test.js`, 67 checks. Three injected bugs each turn it red.
- NFL roster regime: 71 checks; 7 of them fail on the old code.
- EDINTEL: 580 checks; 4 fail on the old code.
- NBA engine: 101 checks.
- NHL brain: 107 checks.
- Board: 39 checks.
- NBA graphic: 375 checks.
- NHL graphic: 350 checks.
- NFL prior decay: 85 checks.
- Today's Games end-to-end: 118 checks, including an integrity scenario.

## 2026-10-26 — All checks: one required check for every workflow a pull request starts

**Why.** #807 merged 17 s after it was opened. Its three required checks (`Repository integrity`, `Odds gateway suites`, `audit`) passed within three minutes, and then eight of the 40 workflows it started failed. A ruleset can require only a check that reports on every pull request, and 64 of the 68 pull-request workflows are path-filtered.

**What.** `all-checks.yml` runs `tools/ci/gate.js` on every pull request. The gate:
- reads the changed files from the API;
- predicts the workflows the change starts from their own `on:` blocks (`tools/ci/workflows.js`);
- waits for each run on the head commit;
- passes only when every one finished success, skipped or neutral.

It fails at the first failed, cancelled or timed-out run, and when a predicted workflow never starts. A run nobody predicted still counts. It only reads.
- `docs/ci/main-ruleset.json` requires `All checks` as a fourth check.
- `docs/ci/BRANCH_PROTECTION.md`: merge this before importing the ruleset.
- `tools/ci/checks.json` puts the workflow in Core validation.
- `Core validation` and `npm run verify:core` run its tests.

**Evidence.** Replayed read-only against GitHub's real runs:
- #807: ALL CHECKS FAILED, 32 of 40, naming the eight failed runs.
- #806: ALL CHECKS PASSED, 8 of 8.

In both, the predicted workflows were exactly the ones GitHub started.

**Tests.** `tools/ci/gate.test.js`, 63 checks:
- every run outcome;
- the gate's own run is excluded;
- re-runs, superseded runs, unpredicted runs, never-started runs and disabled workflows;
- paging, a 502 retried, a hung request timed out and retried, a 404 refused, and the wait running out, all against a fake API;
- every check the ruleset requires is exactly one job that reports on every pull request.

Seven injected bugs each turn it red: cancelled counted as passing, its own run not excluded, the oldest run kept, a missing run passed, waiting on a failure, unpredicted runs ignored, and no request timeout.

## 2026-10-26 — CI: no run on `main` cancels another, the 2ad15afadd damage pinned byte for byte, and a bypass probe before protecting `main`

These follow up #805 and #806.

- **Concurrency.** 30 test workflows grouped by `github.ref` with `cancel-in-progress`, so each merge into `main` cancelled the previous merge's run. 27 of the last 100 runs on `main` were cancelled. They now use #805's pattern: a pull request's newer push replaces its older run, and every run on `main` keeps its own group.
- **A guard on it.** `tools/ci/workflows.test.js` §8 evaluates every concurrency block a push to `main` reaches, with the workflow reader's own expression evaluator, and fails if two pushes would share a cancelling group. It fails on the previous `main`, naming all 30.
- **The #800 damage, byte for byte.** `tools/ci/fixtures/2ad15afadd/` holds the damaged regions of `lib/edgedesk_quote_ev.js` and `slate_audit.json` exactly as that merge left them. `tools/ci/integrity.test.js` checks the gate fails each one with main's own error (line 37, `missing ) after argument list`; line 69) and passes it once repaired.
- **`docs/ci/BRANCH_PROTECTION.md`.**
  - Step 1a: prove the GitHub Actions bypass on two scratch-branch copies of `main-ruleset.json`, one of them a control with no bypass, before activating it on `main`. GitHub's docs do not say whether the app's bypass covers `GITHUB_TOKEN` pushes on a personal account's repository, and the page accepting the actor does not show that it does.
  - A bot commit into a pull request branch reports no checks, so the pull request waits as "Expected"; how to unblock one.
- **[`docs/ci/GENERATED_FILES.md`](docs/ci/GENERATED_FILES.md).** 18,600 of 23,161 tracked files are written by scheduled jobs. It records the rule that separates #800's legitimate `slate_audit.json` from its accidental `forecasts.json`, and 21 owned paths no served page reads.

Tests: `tools/ci/integrity.test.js` 38/38 (+4), `tools/ci/workflows.test.js` 61/61 (+4), `tools/ci/verify.test.js` 32/32, and `node tools/ci/integrity.js` 0 problems.

## 2026-10-26 — Content Engine: a player's name is not a team; and the two #805 commits that did not merge

**The failure on `main`.** `tools/content/evidence.test.js` failed on clean `main` (`1c3b5c07a`): "every article generated from today's research passes the gate", 197 of 198.
- **The symptom.** The Week 9 upset watch was BLOCKED (`numbers_per_game`, EDIT.NUMBERS) for "53.6 (in a sentence about Marshall)".
- **The sentence.** "Isaiah Marshall: 53.6% completions, 7.9 yards per attempt" is the line for Kansas' quarterback, Isaiah Marshall, in the Kansas at TCU section. Marshall at Old Dominion is another game in the same article.

**The cause.** `numbers_per_game` and `conference_claims` (EDIT.CONFERENCE) matched teams with `teamsMentioned(sent, teamNames, [])`, so "Marshall" inside the player's name read as the team. The team check (`teams_in_evidence`) has masked people's names since the same lesson ("Isaiah Marshall is not Marshall").

**The fix** (`lib/content_engine.js`, `playersOf`).
- A player the research names (a quarterback, an availability report, the subject of a player claim, a matchup's quarterback line) now ties a sentence to the player's own game and team, and is masked before teams are matched.
- A sentence that names only a player used to go unchecked. It is now checked against that player's game, so the gate checks more than before, not less.
- A number the player's game does not hold, a Kansas number on the team Marshall, or "Isaiah Marshall … SEC" (Kansas is Big 12) still fail.
- No assertion and no gate rule is loosened.

**The Edge Function.** `supabase/functions/content_engine/index.ts` is regenerated with `node tools/content/inline.js`, which keeps its byte-for-byte copy of the core. It takes effect in production only when the function is deployed (`deploy-content-engine.yml`, by hand).

**Tests.** `evidence.test.js` gains five checks in section N (203 of 203). Against the old gate, four of them and the live check fail.

**From #805, which merged at `b2f67e9b3` before its last two commits.**
- **`docs/ci/main-ruleset.json`** is the branch-protection ruleset, importable as is. The runbook says to apply it after #805 merges (two of its required checks exist only from #805). It also corrects an earlier mistake: Evaluate mode is GitHub Enterprise only.
- **`tools/ci/verify.js`**:
  - gives each job the runner's `GITHUB_PATH`, `GITHUB_ENV`, `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY`, and carries PATH and env forward;
  - names and removes files a step creates;
  - never counts its own logs.
- **New:** a failure in a job that checks out full history (`fetch-depth: 0`) is NOT VERIFIED on a shallow clone, never a pass. `desk-tests`' pinned-commit check failed here for that reason alone: 159 of 159 once the commit is present.
- `verify.test.js`: 32 of 32.


## 2026-10-26 — NHL: are projected totals bunched too tightly? An audit, a club monitor, and production kept

Projected totals were audited against the totals played, out of sample. The test was whether the board is too compressed, and whether anything scores better. Nothing passed a rule written before scoring, so **no price moves**. The model, calibration, ratings, ledgers and historical records are unchanged ([docs/engine/NHL_LAB.md](docs/engine/NHL_LAB.md) §6.2).

- **Findings.**
  - Played-on-projected slope: 1.035 on 2014-20 (OK) and 0.76 on 2021-26 (too wide, not bunched). Live it is 3.6 on 184 games, driven by the top fifth (+1.02 ± 0.82 goals, n 36). The live window never chooses.
  - This season's within-season sd (0.139) is close to 2025-26 at the same point (0.149).
  - Each game's own distribution is about 5% too wide since 2021. This is monitored, not changed.
- **Candidates.** Fourteen were scored on the full-game total RPS over four windows (SELECT 2014-20, CONFIRM 2021-25, HOLDOUT 2025-26, LIVE): goalie and special-teams variants, `goals_only`, pace, matchup interaction, three total-calibration variants, and rating prior and half-life. All fail. The near miss, `xg_core` plus confirmed-starter quality, is not significant on SELECT and needs a confirmed starter at pricing time.
- **`hockey/model/diagnostics.js`** adds:
  - `totals`: projected vs played by window, within-season fifths, by season; MAE, RMSE, RPS, Poisson deviance, last season's mean as a baseline; dispersion; home and away; goalie status.
  - `clubs`: each club's goals scored and conceded against λ over this season, last season, the season before and its last 82 games. It needs 41 games, WATCH at |z| 2, FLAG past the Bonferroni bound (3.36), and PERSISTENT across two windows that share no game. Today: 0 flagged, 9 watch, 0 persistent. It never adjusts a rating.
  - `--check` requires both.
- **Record tab** (`lib/edgedesk_engine_ui.js`, `lib/edgedesk_engine.css`, tokens `20261026tt1`): the totals table, the calibration fifths, spread by season, and the club monitor. The record tables wrap to a phone's width instead of scrolling sideways.
- **Tests.** `tools/hockey/nhl_v2.test.js` gains 31 deterministic checks (111 pass). They cover:
  - expected goals, missing inputs and clamps;
  - totals invariants (regulation mean λH + λA; full-game mean adds P(tie));
  - low and high totals, and extreme matchups;
  - calibration identity and recovery;
  - shrinkage and the goalie variant;
  - the Bonferroni bound, club status and persistence;
  - the totals audit on synthetic seasons.

  `tools/engine/engine_ui.e2e.js` checks both new sections at desktop and phone width (152 pass).

## 2026-10-26 — CI: a gate on every pull request, `npm run verify`, and the rules that would have stopped today's eighteen failed runs

Eighteen failed runs between 12:03 and 12:54 UTC came from three root causes, all already fixed on `main` by #799, #800, #803 and #804 ([docs/ci/INCIDENT-2026-10-26.md](docs/ci/INCIDENT-2026-10-26.md)):
- a web-editor conflict resolution that left `lib/edgedesk_quote_ev.js` and `slate_audit.json` unparseable;
- the terminal's σ guard falling back to the flat 25% bound;
- a cache-token test stricter than its rule.

What let them reach `main` was the process: no branch protection, and four merges while a check was red or had not reported. This change adds the gate and the tooling. No model, threshold, fixture, ledger, record or committed output moves.

- **`Core validation / Repository integrity`** (`tools/ci/integrity.js`, new workflow `core-validation.yml`) runs on every pull request and push to `main`, with no path filter, in about 20 s. It checks that:
  - every tracked JS, ES module, TypeScript, JSON and JSONL file, inline `<script>`, shell script and Python file parses;
  - no tracked file holds a conflict marker;
  - every file or npm script a workflow or `package.json` runs exists.

  On `6f1c69e7d` it names exactly the two broken files and their lines; on `main` it is clean. Twelve docs JSON files written by Python's `json.dump` hold `NaN`; they are accepted as Python's dialect and named in a note.
- **`npm run verify`** (`tools/ci/verify.js`) runs what GitHub would run, read from the workflow files themselves. Variants: `verify:affected` (the workflows this change starts), `verify:plan`, `verify:core`, `verify:cfb`, `verify:odds`, `verify:research`.
  - Each step runs as its job runs it, or is reported NOT VERIFIED with its reason: a secret, a step output, a service, missing Python packages, or a live source.
  - On #799, #800, #803 and #804 its prediction of which workflows start matched GitHub's runs exactly.
  - `tools/ci/workflows.js` reads the YAML with no dependency and is held equal to PyYAML on every workflow.
  - `--clock-shift` and `--tz` run the suites with the clock or the zone moved, to find tests that will fail on a later day.
  - `--net-audit` names the steps whose node processes reached the network.
  - Every step that rewrites a committed file is named, and the file is restored afterwards.
- **`tools/football/nfl_slate.test.js` no longer reaches the network or writes `football/venues/forecasts.json`.**
  - It builds from fixture feeds, but the builder's forecast fetch still asked open-meteo for the fixture games, and rewrote the committed forecast store whenever one answered or was a dome.
  - It now builds `offline`. The feeds still come from its fixtures, and nothing it asserts reads a forecast.
  - Two new checks hold the store byte for byte; 38 of 38 pass.
- **`CFB published-board validation`** (new workflow) runs the CFB validation and research-terminal suites on `main` after every hourly Model Lab run. A workflow's push starts no other workflow, so the 11:08 board's contradiction sat unseen until an NHL pull request failed on it.
- **Workflows.**
  - 13 test workflows now cancel a pull request's superseded run; runs on `main` keep their own group.
  - The six Playwright installs no longer `continue-on-error`. A browser suite without a browser exits 0, so a failed install had left jobs green having tested nothing.
  - The odds gateway's job is named `Odds gateway suites`, so a required check can name it (32 jobs are called `suites`).
- **`tools/ci/checks.json`** puts every pull-request workflow in one of eight categories; the tests fail when a new workflow has none.
- **`AGENTS.md`** holds the permanent engineering rules, and `CLAUDE.md` imports it. [docs/ci/BRANCH_PROTECTION.md](docs/ci/BRANCH_PROTECTION.md) gives the exact ruleset, with a bypass for the data bots, the three checks to require, and why approvals stay at 0 and "up to date" stays off. It also lists the three workflows that act on production from an agent branch's commit message. None of the settings is applied: that needs the owner.
- **Tests:** `tools/ci/integrity.test.js` and `tools/ci/workflows.test.js`.



## 2026-10-26 — The Research OS: one terminal, one game carried through it

The terminal opens on an **Overview**, and a game now travels by its identifiers (the slate id and the research key, never a team name) from its research into Signals, Market Foresight, the Simulator, the AI desk, My Card and Portfolio. Nothing new is computed or collected. See `docs/research-os/DESIGN.md`, and `REPORT.md` for verified results and limitations.

- **Navigation.** On desktop, a sidebar in three groups: Research (Overview, Research, Signals, Market Foresight, Simulator), Your workspace (My Card, Portfolio, Performance, with Process under it) and More. On phones, a five-seat bar plus Menu, which opens the same list as a sheet.
  - Every old link still lands where it did.
  - A seat tap is now a step in the browser's history, so Back and Forward work.
  - Ctrl/⌘ K or `/` opens search over the slate, teams, saved items, places and the reader's own positions.
- **Overview.** Today's games with what is researched, priced, saved and changed since the last visit (same book and two capture times, or "not comparable"), plus the real states of Signal Center, the Simulator and Market Foresight.
  - Its queue is ordered by status, the reader's interest, research completeness and start time. Never by a model–market gap.
- **Game workspace.** "Keep researching this game" opens Signals, Market Foresight's record, the Simulator, Ask AI, Add to Card and Record a position for the same game.
- **Market Foresight, inside the app.** `#foresight`, `#foresight/game/…` and `#foresight/model/…` mount the public page's own controller, with the same doors under the reader's session. `/foresight/` is unchanged.
  - It stays in **shadow**. The go-live checklist is `docs/market-foresight/GO_LIVE_CHECKLIST.md`, and nothing switches the mode.
- **Performance.** EdgeDesk's model record (the public ledger's summary, nothing under `min_n`) and the reader's own record (`portfolio_summary`) on one page, never combined.
- **Database.** `supabase/research_os.sql` only registers four `primary_nav_*` event names (+ rollback). It adds no table, policy or grant.
- **Tests.**
  - New: `tools/research_os/research_os.test.js` (unit) and `tools/research_os/journey.e2e.js` (the whole journey in Chromium on the shipped migrations, at a desktop and a phone).
  - Navigation, Portfolio, Signal Center, slate and landing assertions about the old seven-seat bar were rewritten for the new IA, none removed.
  - The shared PostgREST stand-in learns multi-column `order=`, `offset=` and `col::text`. Without them the Simulator's and Portfolio's real reads answered 400 in the test.
- **Landing page.** The #desk section lists the terminal's nine places, with Market Foresight marked as in review.
  - `index.html` loads `edgedesk_track.js` under a new stamp.
  - The ten other public pages keep theirs: they never send the four new events.

## 2026-10-26 — CFB: the EV plausibility check reads each game's width again

`football/cfb_validation/tests.js` failed on main ("the audit finds no status that contradicts its checks — got 3, want 0"). Oklahoma State @ Iowa State, Illinois @ Maryland and Mississippi State @ Texas passed every integrity check, but the board held them at INVESTIGATE as "implausible EV".

- **The cause.** The plausibility check measures a gap in widths (σ) of the game's own distribution, with a fitted bound of 0.96. `distributionSpread` searched for that width from −80 to +80 points. The board's stored curve (`football/cfb_terminal/build.js` `curveCover`) spans only the market ± 30 to 60 points and answers nothing outside it. So no width was ever read, and every college game on the board fell back to the flat 25% raw-EV bound. That bound flags about 20% of real games where the σ bound flags under 1% (`football/validation/ev_plausibility.json`). It flagged 7 of today's 61, including Army @ Memphis at a 6.1-point gap.
- **The fix.** `lib/edgedesk_quote_ev.js` now searches inside the cover function's own span. A distribution defined across ±80, as NFL's is, reads exactly as before.
- **On today's board** (rebuilt at its own 12:08 UTC time): σ reads 16 to 18 points, and no game is implausible (largest z 0.53). The three games become VERIFIED MAJOR and Army @ Memphis becomes WORTH RESEARCHING. Notre Dame @ Navy, Arizona State @ BYU and Tulane @ Charlotte stay INVESTIGATE for their own failed checks. Large-EV warnings still apply, and every decision is still PASS.
- **Tests.** `quote_ev.test.js` goes from 244 to 248. A curve that answers only near the market reads the same width as the whole distribution, its 8.5-point gap is not implausible, and a 14.5-point gap still is. The three fail on the old code with the production symptom (`flat_fallback`, σ null). The CFB terminal, validation, EV, bettor, production, resilience and integrity suites all pass.

## 2026-10-26 — The matchup graphic on every sport: college basketball, the WNBA, MLB, college baseball and UFC

NFL, college football, the NHL and the NBA open a game with the matchup graphic. Every other sport EdgeDesk prices now does too, where a reader clicks the game (`lib/edgedesk_sport_graphic.js`, [`docs/game-research/SPORTS.md`](docs/game-research/SPORTS.md)).

- **Where it is.**
  - Men's and women's college basketball and the WNBA: Today's Games → the game's matchup view, from the lab slate (`basketball/slate.json`).
  - MLB: the top of the game brief, from the run model (`mlb/engine.js`).
  - College baseball: the top of the brief, drawn while the rest of the brief is still being read.
  - UFC: Research → UFC shows the next card, a chip per bout with the main event first; the card's matchup view on Today's Games carries the same chips.
- **The football picture, each sport's numbers.** The same template, square or portrait, with Download PNG, Share and Copy link. Each sport fills it with its own:
  - three model panels;
  - the captured market before the start, or EdgeDesk's own detail;
  - What to watch for, which names what moves the number and what the model cannot see: availability in basketball, probable starters, park and weather in baseball, a fighter's camp in UFC.
- **College baseball is projected, never priced.** Its brief has always said none of its numbers becomes a price. The graphic shows the board's projected runs, total and win probability, with the left panel as the projected margin ("not a run line"). The brief's Projection paragraph now says what is projected and that none of it is a price; it used to say there was no total or win probability, which the board already showed.
- **No EDGE label on any of them.** Value claims are off for the lab basketball model and the run models (never graded against the close) and for the experimental UFC Elo, so a model–market gap is a sentence and nothing more.
- **Today's Games lists women's college basketball and the WNBA** (ESPN `basketball/womens-college-basketball` with `groups=50`, and `basketball/wnba`), joined to the lab slate like men's games.
  - Men's games had shown no fair line: the join read a spread field the lab slate does not carry. It now reads `fair_home_line`.
  - The pill reads NCAAM, beside NCAAW.
- **The renderer** gains a baseball diamond and an octagon surface, baseball and glove icons, outlined polygons, and an optional "VS" for a neutral site or a bout. Football's picture is unchanged.

Tests: `npm run sport:graphic:test` (1,502: every committed lab-slate game as each league, every served UFC bout, MLB and college baseball through the real engine, layout in both formats; mutation-checked) and `npm run sport:graphic:e2e` (53, Chromium: the matchup views, a 390 px phone, the public page, the UFC panel, both briefs, keyboard focus). CI: `.github/workflows/sport-graphic-tests.yml`. Also run: `slate/games.test.js` (106), `slate/build.test.js` (67, now ten feeds), `slate/games_ui.e2e.js` (105), `cbb/cbb_ui.e2e.js` (59) and `mlb/baseball_ui.e2e.js` (245) against PostgreSQL 16, `mlb/game_brief.test.js` (152), the NBA (367), NHL (344), signal center (291) and football graphic suites, and navigation. The ESPN women's and WNBA scoreboards could not be read from the build environment (its network refuses `site.api.espn.com`).

## 2026-10-26 — NHL: a nightly check on whether the model over- or under-rates clubs

A reader asked whether the model under-rates Toronto. For TOR at CGY, the market implied 3.57 Toronto goals and the model 3.10 in regulation (about 3.2 with overtime). Toronto had scored 3.85 a game, with a strong power play and 18 goals in three games. The model's job is to be right for every club, so this checks that question for all of them, out of sample, every night.

- **What the history says.**
  - Clubs that start hot score what the model forecasts. Clubs 8 to 24 games in, scoring at least 1.20× the league, scored 0.994× (2014-20) and 0.997× (2021-26) their forecast. With hot finishing too, Toronto's profile: 0.995× and 0.994×. A run of goals over the last three games: 1.015× and 0.995×.
  - High early power-play goal rates carry no stable correction (1.038× and 0.966×). Adding power-play features changes nothing measurable. A goals-only model, which trusts scoring alone, is measurably worse on team totals.
- **Where the model does overrate.** In 2021-26 the highest-forecast tenth scored 4.5% under its forecast (club-goal slope 0.889, interval below 1). The cause is game totals forecast too far apart, the same issue that keeps the totals markets provisional. Three other calibration windows were tested again; none beats the production rule, so nothing in the price changes.
- **The season so far leans the other way.** Totals are bunched too tightly (slope 3.56 over 179 games, interval above 1). This season's total calibration is the strongest since 2014. It is a watch item; the live season never chooses the model.
- **The monitor.** `hockey/model/diagnostics.js` adds `team_strength`:
  - the club-goal slope, with a reading of OK, TOO_WIDE, TOO_NARROW or TOO_EARLY;
  - the game total and who scores more, separately;
  - scored ÷ forecast by tenth of the forecast;
  - eleven standout groups (hot or cold scoring, last three games, power-play goals, finishing, a leaky or stingy opponent).

  The Record tab shows it as a table. It never retrains or reprices. `--check` requires a reading for every window.
- **Tests.**
  - `nhl_v2.test.js` gains 8 checks on synthetic data where the answer is known. A forecast at the truth reads OK. One spread 1.5× too far reads TOO_WIDE with slope ≈ 1/1.5. One bunched to half the spread reads TOO_NARROW with slope ≈ 2. A game's own score never reaches its season-to-date context.
  - `engine_ui.e2e.js` checks the table on desktop and phone.

Write-up: `docs/engine/NHL_LAB.md` §6.1.

## 2026-10-26 — College basketball exhibitions: opponents found by name and nickname

The first collector run held 299 men's and 300 women's schedules. Before the daily refreshes published them, a preview found three opponent mistakes, fixed here.

- **A school that moved its website is found by name.** Southern Miss lists Houston Christian at `hcuhuskies.com`, a site the registry does not know (it has `hbuhuskies.com`). The game was priced as a non-D-I opponent and a second time from Houston Christian's own listing. A website the registry does not know now falls back to the registry name, so the game is priced once, D-I against D-I.
- **A school's ESPN team, when the collector does not read it,** is the D-I team ESPN names exactly as the registry names the school and its nickname. For the 442 teams (229 men's, 213 women's) whose results also identify them, the two never disagree. Arkansas, Kentucky, Northwestern State and Utah State opponents, skipped before, are now priced.
- **The same rule fixes a stale division.** Mercyhurst and New Haven are D-I on ESPN but D-II in the registry. Louisville vs Mercyhurst was priced as a non-D-I game (99.8%); it is now D-I against D-I.
- **A game both schools list is priced from the listing whose start time reads.** Houston Christian lists no time for Southern Miss; Southern Miss lists 6 PM, which is now used instead of noon, flagged approximate.
- **More of the schools' labels come off a name:** "(Ex.)", "(ex)", "(exhib.)", "(EXH)", and "Exhibition" in front ("Exhibition Cal State Monterey Bay").
- Preview from the collected schedules, through 2026-11-09: men's 42 priced (was 40), women's 57 (was 56).

## 2026-10-26 — College basketball exhibitions, from the schools' own schedules

No feed this repository reads lists a college basketball exhibition, so the forecasts priced none. Every school lists its own, and the collegiate collector now reads every Division I school's men's and women's basketball schedule each week, beside baseball.

- **Each school's exhibitions are flagged on every page generation.**
  - SIDEARM: the preseason (`S`) and special-event (`X`) game types.
  - SIDEARM's oldest markup: the school's own "(Exh.)" label.
  - WMT: its exhibition marker, now read inside the last game's own element. The last game used to reach into the page's second rendering, which flagged a regular-season game as an exhibition at Purdue, Stanford, UCLA and Penn State; that also fixes three baseball pages.
  - Checked on 22 real 2026-27 pages (probe round 11).
- **Who is who, without guessing a name.** A school is the ESPN team with its results: last season's finals on the same local date with the same score. On the 11 schools probed (round 12), men's and women's, every school matched its own team on 28 to 40 finals.
- **Priced like any game between the same two teams,** flagged `EXHIBITION`, never in Upset Watch, and never learnt from. A non-D-I or NAIA opponent is priced in the model's pooled non-D-I regime; an intrasquad game or a listing that names no school is not priced.
- **Live after merge and the next collector run.** Merging the plan change runs the weekly collector. The daily refreshes price whatever exhibitions it holds.

## 2026-10-26 — Market structure suites: one pinned clock for the browser test

- **The failure (00:06 UTC).** `market_structure_ui.e2e.js:196` threw "Cannot set properties of null (setting 'open')".
  - The suite stages a Week 7 board but ran it on the real clock and the live nflverse schedule.
  - IND @ MIN went final on 2026-10-25 (10–16), and a finished game gets the graded card, which has no Market Structure section. DAL @ PHI would follow after Monday night.
- **Four fixes for one cause.** #776, #777, #779 and #780 each pinned the clock and blanked later scores, each in its own way.
  - Each was merged through a "Merge branch 'main'" conflict resolution that kept pieces of the others. One resolution left `csv is not defined`.
  - After #782's restore was merged the same way, main's copy no longer parsed: a stray fragment of one scheme's `asOf()` sat after `pinLine()`, and `ST` and `pinned` were read before they existed.
- **Restored, once.** The file is now #777's exactly, as it was green on main (ed901e89): every page reads 2026-10-25 13:00 UTC, and the schedule it is served blanks every 2026 score from then on.
  - 25 of 25 pass on Playwright 1.63 and on 1.49.1 (CI's pin), and also against a schedule with every Week 7 and 8 game scored.

## 2026-10-26 — Game research tests: the Kalshi fixture gives each side its own ticker

Section 14 of `tools/football/game_research.test.js` names its two fake Kalshi markets by the first three letters of each team's name. For LAC @ LA both are "Los", so the two markets share a ticker, every quote lands on both teams, and the gate cases read a 57.2-point gap. The section reads the slate's first pregame NFL game, so it would have failed the day that game was LAC @ LA.

- The tickers now end in `-AWAY` and `-HOME`. Nothing else reads them; the quotes still match teams by name.
- The test changes only; the code is unchanged.

Tests: `game_research.test.js` passes 252 of 252. The section 14 gate cases (5.0, 5.1, −5.1, 6.9, 7.0, −7.0) were also run against each of the 16 pregame NFL games on the committed slate: all pass (before: 15, with LAC @ LA failing).

## 2026-10-26 — Game research tests: two checks that broke after the NFL card's gate and data windows

`tools/football/game_research.test.js` had failed on main since the NFL card commits added a large-gap gate and data windows to chips. The tests were wrong in both cases; the code is unchanged.

- **The 5-point gate boundary.**
  - The helper rounded the Kalshi mid to 0.1 pt, so its "5.0-point" case was really anywhere from 4.95 to 5.05.
  - The gate fires above 5, so the check failed whenever the slate's first pregame NFL game landed above 5 (PIT @ NO: 5.03).
  - The mid is now built at the model's own 4-decimal precision (the snapshot rounds win probability with `r4`), so the cases are exactly 5.0, 5.1 and −5.1.
- **The chip spec.** The graphic spec now carries a chip's `window_label` when the chip has one; the alt text reads it ("Data 2025: 70% / 2026: 30%."). The check allows exactly that third key, and only when the snapshot's chip has a window.

Tests: `game_research.test.js` passes 252 of 252 (it had 2 failures). `football_lines`, `game_context`, `build_game_research --check` and `nfl_prior_decay` (85) all pass.

## 2026-10-26 — NHL goalie sync: the cron secret fixed, and refused pokes seen at once

- **The mismatch.** After the first deploy, the function's `NHL_GOALIE_CRON_SECRET` stopped matching Vault's, probably set by hand. Every pg_cron poke from 00:36 to 02:06 UTC was a 401, while pg_cron's own record showed each call as succeeded. The first run by hand of NHL goalie sync failed on it. Deploy NHL goalie layer (`set_cron_secret`) gave the function Vault's value, and its forced run answered 200, status `ok`.
- **Refused pokes are seen.** `nhl_goalie_poke()` keeps each poke's pg_net request id in `public.nhl_goalie_pokes`. The watchdog reads what the function answered the last three pokes and fails on a 401 or any answer but 200 or 500, within half an hour instead of after a 90-minute silence.
- **The summary prints a refused answer.** It tells the function's own 401 (the secret) from the Supabase gateway's (JWT verification on: redeploy with `--no-verify-jwt`).
- **The docs.** They no longer say to set the secret by hand; the deploy sets both sides. Daily Faceoff's 403 comes and goes: it answered at 02:06, and its parser read the live page.
- **Tests.** Sync 61 → 68, SQL 71 → 78 (one proves a re-apply over live rows keeps every row and setting).

## 2026-10-26 — NHL starting goalies: deployed, and a GitHub job beside the other syncs

- **Deployed.** Deploy NHL goalie layer now makes the cron secret exist and agree in Vault and on the function, schedules the five-minute poke, and runs the sync once. It ran from this branch. The first run wrote version 1 of the four cards inside the horizon (MIN @ VAN, LAK @ NYR, TOR @ CGY, DET @ EDM), all Projected and GATED.
- **Daily Faceoff refuses the function (HTTP 403).** The NHL API read. Until a starter source answers, starters stay Projected until the NHL boxscore names them near puck drop, and runs more than three hours out record `sources_down` (`docs/engine/NHL_GOALIES.md` §10).
- **NHL goalie sync** (`.github/workflows/nhl-goalie-sync.yml`). **Run workflow** calls the sync now: forced, dry, or with a simulated outage. On a schedule, every half hour from 8 AM ET, it is pg_cron's watchdog: it calls the sync only when pg_cron has stopped, and then fails. The job summary has the card versions written, pg_cron's last call and the readiness KPIs.
- **The verdict** (`tools/hockey/nhl_goalie_run_summary.js`, shared with the deploy's first run). The job fails for anything EdgeDesk runs: the secret, the function, pg_cron, the inputs, a drifted parser. An outside source not answering is a warning. The two queries it reads are in `tools/hockey/sql/`, tested on real PostgreSQL.
- **Tests.** Sync 49 → 61, SQL 66 → 71.

## 2026-10-25 — NHL starting goalies: Observed, refreshed to puck drop, and a versioned card

- **The problem.** The MIN @ VAN card of 2026-10-25 named Lankinen all day, from the usage projection; Merilainen started. The projection reads completed games only, and confirming a starter needed a hand entry.
- **The starter sync.** `supabase/functions/nhl_goalie_sync` reads two sources:
  - Daily Faceoff's starting-goalies page;
  - the NHL's game boxscore, inside three hours of puck drop.

  Each changed observation goes to `public.nhl_goalie_starters`, append-only; the older row stops being current. Agreeing sources give the higher status; disagreeing ones give the lower status (never Confirmed) and a conflict flag.
- **The cadence.** pg_cron pokes every 5 minutes, and the function decides: every two hours from 8 AM ET, every 15 minutes in the final three hours, and a final pass at T-30.
- **Versioned cards** (`public.nhl_game_cards`). A starter, status or conflict change writes a new version. Each version records the pairing used, both statuses, the generation time, the range over every realistic pairing, the edge gate, the Known Limitations and the change note. Old versions stay.
- **Edges and CLV.** An edge and its CLV grade attach to the version current at detection, enforced by a trigger. Each hockey ledger record and CLV capture now also carries its goalie pairing.
- **The card.** `lib/edgedesk_nhl_goalies.js` shows:
  - a status badge, source and "as of" time per starter;
  - the full pairing range and "Starter not confirmed. Numbers may change." unless both are Confirmed;
  - "Updated: starter changed from X to Y" with both versions' win %.
- **The edge gate** (`lib/edgedesk_nhl_market.js` `goalie_gate`, used by compare and the price check). No EDGE on a moneyline, puck line or total unless both starters are Confirmed or it holds under every pairing. The slate's goalie scenarios now carry their puck lines and totals.
- **Unchanged.** The production price (`xg_core`, no goalie term), the goalie weights and the ranking. The slate built at the same instant is identical apart from the new scenario fields. The new `hockey/goalie_inputs.json` re-prices every scenario exactly (`build_slate.js --check`).
- **Goalie v2.** `NHL-GOALIE-V2` v0.1 is registered EXPERIMENTAL with promotion criteria and no result. It cannot price a live card.
- **Readiness.** System health has three rows: the sync, confirmed by T-30, and source conflicts.
- **Tests.** Core 83, sync 49, SQL 66, UI 32, and engine UI +12. Deployed by `deploy-nhl-goalie.yml`. The live source pages were not reachable from the build environment, so the parsers are tested on constructed pages in each source's documented shape (`docs/engine/NHL_GOALIES.md` §10).

## 2026-10-25 — CI back to green: five failures, each fixed at its cause

- **Football weekly build refused to publish week 8** (mean rank shift 11.46 against a bound of 6; every run since 2026-10-25 11:45 UTC).
  - The cause is upstream. cfbfastR's rebuild of `player_stats_2026.csv` (2026-10-24 19:19 UTC) files about one incomplete pass in five under the **defence**: 4,397 of 20,158 through week 8, against 7 of 18,333 in the 2026-10-19 file. Mostly these are the passes a defender broke up. Read as filed, the offence lost those attempts and the defence gained attempts it never threw. ETSR moved 1.8 pts on average, even for the 76 teams that had not played.
  - `football/data/play_offence.js` puts each incompletion with its passer's team: the team the passer completed or ran for in that game, else the drive's offence, else as filed. The answer is never a third team.
  - `build_players.js` `loadPlays` and `build_starters.js` `cfbDropbackRows` both use it. It refiles 4,519 rows in 2026, 1,911 in 2025, 209 in 2024 and 235 in 2023, and the build log says so. On the 2026-10-19 file it changes nothing. The defender's pass breakup now stays with the defence.
  - Week 8 against week 7: mean rank shift 3.51 and 0.7% of teams moving 15+ places, with no anomalies (players and rankings rebuilt locally).
  - `football/data/play_offence.test.js` (16 checks, in `cfb:test`).
- **A stale scheduled job reverted a merged pull request.** When its push was rejected, `tools/ci/push_generated.sh` overwrote every *named path* with the job's checkout. The cfb-lab job names whole directories, so at 05:23 it put back `football/game_research/factors.json` and a row of `football/cfb_validation/versions.jsonl` from before #766. That turned Game research tests and NFL model suites red.
  - A rejected push now carries only the files this run changed. Everything else under the named paths keeps the tip's version.
  - `push_generated.test.js` has 23 checks, 3 new, which reproduce the incident. `factors.json` is regenerated.
- **Editorial system failed every run after 20:47** (`edgedesk articles` → THE STORE: "and every record — got 717, wanted 723"). Publish research articles fails the same check.
  - At 20:45 Publish research articles wrote 6 new records and refreshed 75 more. The editorial run that had checked out before that was rejected on push. `push_generated.sh` then laid its own `articles/data/index.json`, built from 717 records, over a tip that held 723. The records stayed, but the manifest dropped 6 of them and rolled the 75 back. Both jobs test the manifest before they rebuild it, so neither could repair it.
  - The helper now accepts `PUSH_REBUILD`: a command that recomputes the aggregate artifacts on the new tip after this run's files are put on it. Copying our aggregate is what dropped the records. If the command fails, nothing is pushed. Both article jobs set it to `node tools/articles/store.js --reindex && node tools/articles/build_articles.js` (`--reindex` is new).
  - `push_generated.test.js` has 28 checks, 5 new, which replay the race and a failed rebuild. `articles/data/index.json` is regenerated from the records (723).
- **Model loop health: college football DEGRADED.** The sportsdataverse schedule parquet files a TBD start at a midnight-Eastern placeholder (04:00 UTC). Six week-8 games that kicked off between 19:30 and 02:15 therefore left that day's cards from the morning on, a card published at noon would have graded as after kickoff, and the games read as "played, no result" before they began.
  - `model_loop/adapters/cfb/ingest.py` replaces a TBD start with the record's kickoff, else the cfbfastR CSV spine's. One new test.
  - The stamp already published clears at the loop's next run.
- **Simulator (UFC) after UFC 333 started.** `ufc_sim.test.ts`, `ufc_ui.test.ts` and `ui.e2e.ts` named UFC 333's main event, its title fights and fixed counts. They now check what every booked card must satisfy: one five-round main event, title fights between a division's champion and a challenger, badges and counts read from the run, and the 2021-on title record from its own numbers.
- **Record P&L.** `pnl_ledger.test.js` compared two sums of 1,270 per-bet values, one rounded to 4 places and one to 6, within a fixed 0.011u. It failed at −87.13 v −87.1183. The bound is now the rounding itself: 0.0000505u a bet plus the 2-place summary. The odds and sides are still checked exactly.

## 2026-10-24 — College number: unfed matchup inputs start at league average; the schedule term computed as trained, and rejected

Two fixes that follow from the leave-one-term-out record (`docs/cfb-validation/LOTO.md`). Pricing patch `edgedesk_cfb_r1+p12` (`football/cfb_validation/versions.jsonl`).

- **The matchup inputs the season feed never supplies.**
  - The season feed (`football/rankings/engine_efficiency.json` `unavailable_features`) has no EPA, explosiveness, passing-down, front-disruption, drive or field-position rates.
  - The live board used to hold those inputs at the 2025 closing seed all season. The held-out test replays them at 0, so 0.42 pts of the live matchup term on average had never been tested.
  - `engine.js` `ingest.resetUnmeasuredEfficiency` now sets them to league average for every team, offence and defence, at the break into the artifact's season. `build_coverage.js` `buildState` calls it, and so does the board's replay in `app.html` (also on a late join).
  - The profile labels these inputs `unmeasured` ("league average: not measured by the season's play-level feed"). The efficiency gap skips them. An input the feed later supplies is absorbed and labelled as usual.
  - **Effect on the line.** On the 2026-10-24 slate, the matchup term moves the line by 0.42 pts on average (median 0.33, max 1.56; 33 of 100 games by 0.5 or more, 5 by 1.0 or more). Every slate coverage check passes. `loto.js --live` now finds 0.00 pts of the live term from last season's values, so the live term is the tested one.
- **The schedule term.**
  - Rest, byes, road stretches and look-aheads used to be priced as `points_per_stress × (away stress − home stress) / 100`, built from a 0–100 index. That form ignored the weights' signs (a bye and a look-ahead carry the other sign), floored the index at 0 and divided by 100 a second time. It moved the line by 0.001 pts on average.
  - `situation.schedulePoints` now computes the term exactly as `train_layers.py` fitted it: Σ w_k (home_k − away_k), over the components known for both sides. It averages 1.18 pts.
  - The term is published as `shadow_points` and adds 0 to the number unless `params.schedule.points_applied` is set, the way travel and altitude work.
  - **Held-out test.** `loto.js` has a new shadow-term mode that tests the term added to the shipped number on 2022–2025 (3,004 games). Result: **REJECTED**. MAE is 0.040 worse (95% CI −0.090 to +0.010, p = 0.14), worse in 3 of 4 seasons, and the weight k is 0.05 [−0.32, 0.43], which carries no signal. Even in the 2014–2019 seasons it was fitted on, k is only 0.47. It also moves the number away from the close. So it stays out of the line.
  - The 0–100 index stays as a display of the schedule geometry and prices nothing.
  - **Priced confidence.** The confidence ledger's priced confidence (how much of EdgeDesk's information the number uses) drops a little where both sides have schedule context: 41.3 → 38.6 on a test game, because the schedule no longer counts as priced. Information confidence, the data-quality score and the input contract do not change: the schedule context is still on file and still feeds the outcome range.
  - **Cards and docs.** In `FACTORS.md`, Rest and schedule now reads "no · tested on unseen games and rejected: adds 0". A college schedule spot or rest edge carries `0 PTS` and says so.
- **Tests.**
  - `football/cfb_p4/tests.js` has 110 checks, 6 new: the reset, its labels, the efficiency-gap fallback, re-absorption after a reset, the schedule term's trained form checked by hand, and the not-applied gate with its shadow points.
  - `football/fbs/efficiency_replay.test.js` has 11 checks: the build resets only for the artifact's own season.
  - `tools/football/loto.test.js` has 44 checks: the shadow arithmetic by hand; a real shadow term is VALIDATED and a noise one never is; the record's live split has no last-season part; a shadow term is in the number exactly when its record validates it.
  - `tools/football/game_research.test.js` has 248 checks.
  - The research-card libs' stamps moved (`20261024sr1`), and so did the home page's model stamp.
- **The simulator's CFB fixture.** `simulator/fixtures/cfb_2026_wk7_snapshot.json.gz` records the hash of `engine.js`, so the simulator refused to replay it.
  - The simulator prices with no schedule context and no play-level stats, and on that path both engines are identical: 12,240 priced pairings, zero differences in fair margin, sigma, win probability or total.
  - `simulator/src/cli/build_cfb_fixture.ts --restamp` builds fresh and compares every priced field with the committed fixture of the same as-of week. Only when all of them match does it move the code identity, and it refuses otherwise (a tampered game price was refused).
  - A fresh build matched the fixture in all 888 games and every postseason pairing, so the fixture keeps its data with only the code identity moved.
  - Simulator suites: CFB 308, CLI 46, publish 18, reader 101, SQL 88, typecheck clean.

## 2026-10-24 — UFC: the age curve by division (1.3.0)

The question: does age cost the same at every weight? Heavyweights, and perhaps the lighter divisions, were thought to age later. The age study (`python3 -m model_loop.adapters.ufc.study age`; protocol `docs/model-loop/ufc/study/age_protocol.json` hashed before any fit; results in `age_by_division.json` and the study README §5) gave every division with 150+ bouts in 2016-2020 its own age curve, fitted on those years alone.

- **Where the decline starts.**
  - Bantamweight, featherweight, middleweight and women's strawweight start at 28, the edge of the grid. Lightweight starts at 30, heavyweight at 31 and welterweight at 33. Light heavyweight is latest, at 40.
  - The lighter men's divisions age *earliest*: 1.2.0 still overrated the older fighter at bantam- and featherweight (said 39.3% and 40.1%, won 36.9% and 37.2%).
  - A heavyweight-only later knee made every window worse.
  - An elite UFC record (6+ wins at 70%+) does not slow the decline. Those fighters were overrated, and a steeper curve for them lost in 2024-2026, so it was not adopted.
- **Adopted by the weekly rule, as 1.3.0.**
  - Out of sample (2021-2026, 3,286 bouts), the curve by division lowers log loss by 0.0020 (card-blocked 95% interval −0.0048 to +0.0008). It is better in 2022 and 2024-2026 and worse in 2021 and 2023.
  - The study's own rule (2021-2023 alone) dropped it. The weekly rule every UFC change must clear (2016 to date, interval below zero, Brier no worse, not worse in 2025) passed it, at −0.0025, and −0.0050 in 2025.
  - **Better, not proven.** The weekly loop retests it, and its reverse `age_shared`, every week.
- **Against 1.1.0 and the close.**
  - From 2024 on: log loss 0.666 → 0.640 (1.2.0: 0.646).
  - Since 2018, on bouts with a close: 0.648 against the closing line's 0.604.
  - Out of sample, gaps over 10 points went the market's way 760 times to 426 (1.2.0: 814 to 395).
- **UFC 333 moves (1.2.0 → 1.3.0).** Volkanovski 34.8 → 36.5 (market 49.6), Dvalishvili 51.3 → 52.8 (43.6; now over the guard's threshold), Volkov 65.3 (52.2), Krylov 26.0 → 31.7 (18.8), Magomedov 42.5 → 39.8 (53.3). The mean gap to the market goes from 11.6 to 12.0 points across the 14 bouts. The full card is in `UFC_SIMULATOR_NOTES.md` §7.
- **Plumbing.**
  - `age_div` (a knee and slope per division) and `age_elite_slope` in `model.py` and `elo.ts`, off unless set. The port matches `model.py` at full precision with both on.
  - Unbooked title fights in the simulation use the title's division.
  - `comparison.json` and Model Health now follow the served version and say when a choice behind it has read the 2024-on window. Model Health adds an *Age by division* table.
  - `Versions.promote` now retires any `SERVED…` status, so promoting 1.3.0 no longer leaves 1.2.0 marked served.
- **Restored.** The 1.2.0 entry below was dropped from this file by a merge of main and is restored as written.

## 2026-10-24 — UFC: why the model disagreed with the market, a better model (1.2.0), and a guard on every disagreement

On UFC 333 the served UFC Elo (1.1.0) had Dvalishvili 54.6% against Kalshi's ~41% and Volkov 70.4% against ~53%. The study behind this change (`model_loop/adapters/ufc/study.py`, every table in `docs/model-loop/ufc/study/README.md`) found those gaps were the model's blind spots, fixed what out-of-sample evidence supported, and stopped the product from presenting a large disagreement as an edge.

- **The diagnosis (1.1.0, every decided bout since 2018).** Graded against a public archive's pre-fight closing lines (untimestamped, matched to 5,662 ESPN bouts):
  - log loss 0.671 against the closing line's 0.604 on the same 3,764 bouts (Brier 0.239 v 0.209);
  - gaps over 10 points: 2,102 bouts, **586 resolved in the model's favour, 1,516 in the market's**;
  - blind spots: age (the older fighter at 37+: said 47.8%, close 38.4%, won 33.6%), debutants (45.3 / 41.9 / 37.9), short UFC samples, long layoffs.
- **One change at a time** (fit 2016-2020; kept only if 2021-2023 log loss fell by 0.0005; protocol hashed first): kept the pre-UFC record as the prior (−0.0114) and an age curve (−0.0070); dropped step size, short-sample shrinkage and a debut prior, layoff decay, division change, recency and head to head.
- **1.2.0 promoted, 1.1.0 kept runnable.** On 1,623 bouts from 2024 on (read once): log loss 0.666 → 0.646 (−0.0199, card-blocked 95% interval −0.028 to −0.011), Brier −0.0094. On bouts where both fighters are still in the UFC (where the reconstructed record's hindsight can barely act) the gain holds: −0.0186 (−0.029 to −0.008). It still trails the close (0.650 v 0.604 since 2018). Every published bout carries 1.1.0's price beside 1.2.0's.
- **The disagreement guard** (`guard.py`, `guard.ts`, `docs/model-loop/ufc/guard.json`). Every bout is shown beside DraftKings' latest no-vig price. A gap over 8 points is labelled **"Model disagrees with market"** on the Simulator and Games pages, with both numbers, the factors that likely explain it (short sample, layoff, age, weight change, rematch) and their measured record, and no fair odds. A gap is a signal only when the study certifies it beat a timestamped close; it does not (942 of 1,420 out-of-sample gaps over 8 points went the market's way), so no disagreement is a signal.
- **Model Health** shows 1.1.0, 1.2.0 and the closing line side by side (log loss, Brier), a calibration chart, how gaps resolved, the certification and every change tried.
- **New data.** Dates of birth from ESPN's athlete documents (`fighters.csv`, 2,407 of 2,425), records as of a stated time (`records.csv`), and one per-fighter facts file both the loop and the simulator read (`fighter_facts.csv`).
- **Still open.** 1.2.0 overrates debutants (48.6% said v 37.9% won), and its age curve is one line for every division. The record prior sat at its grid's edge. No timestamped closing archive exists. The weekly loop now retests five follow-ups under its preregistered rule.

## 2026-10-25 — Market Foresight: which forecasts and venues preceded market movement

`/foresight/` is a new, separate research record. It matches each timestamped forecast (EdgeDesk's models and the Model Collective's) to the DraftKings and Kalshi prices EdgeDesk recorded before and after its publication. A reader can open a game and see what each source showed, and when.

- **What it says, only when the timestamps support it.** "Forecast preceded observed movement", "first observed among tracked venues", "market moved toward this forecast" and "timing unresolved at available sampling resolution".
  - It never claims a model moved a market.
  - It never says a venue led the whole market.
  - It never treats convergence as being right about the result, or timing as a trade.
- **Frozen first.** The methodology `mf-v1` (eligibility, freshness, close, thresholds, persistence, horizons, tie and revision policy, the statistical unit and intervals) was committed before any measurement, with its sha256. The worker and the database both refuse a changed file under the same version.
- **Measured separately, never combined.** Closing convergence |M0 − F| − |C − F| and directional movement sign(F − M0) × (C − M0) are reported apart.
  - Fixed horizons are 1, 6 and 24 h. The first sustained move toward the forecast is given as a timing interval.
  - Misses, no-move, reversal and moved-away cases are all counted, and every exclusion names its reason.
  - Intervals are Wilson for proportions and an event-resampled seeded bootstrap for means and medians. There is no composite score.
- **Timing kept honest.** A change happened in (last observation of the old value, first of the new). Coverage gaps are shown, and nothing is carried across one. Overlapping venue intervals are unresolved. DraftKings' real cadence is reported beside its intended schedule: a median of about 6.5 h between stored rows, with frequent late runs.
- **Contracts matched exactly.** Line points and probabilities never mix. A threshold change is never spliced into one series.
  - Kalshi is shown but compared with nothing until an operator verifies each series' rules text by sha256.
  - No fee is applied, because the repository's Kalshi fee schedule is unverified.
- **The Collective consensus is strictly as of each evaluation time**: one vote per model, nothing published later, withdrawn forecasts counted until withdrawn, membership hashed.
- **A T3 research check** asks whether disagreement predicts later movement beyond the market and its recent movement, on a chronological holdout. On the committed CFB data it finds no evidence; NFL is insufficient.
- **Isolation.** Nothing in rankings, grades, evaluation, eligibility or any model reads this layer, and it writes nothing else; a test scans every tracked file.
- **Not live yet.** Deploy with *Deploy Market Foresight schema*, review in shadow mode, then switch to live. The hourly job stays off until `MARKET_FORESIGHT_WORKER = on`. Rollback is `mf_owner_set_mode('off')`, which keeps every row. See `docs/market-foresight/README.md`.

Tests: engine 121, isolation 36, SQL 92, worker 34, renderers 46 and Chromium 33 (desktop and phone). The site's free-access and navigation suites are updated and green.

## 2026-10-24 — College basketball: preseason mode, then the season on its own

The Simulator's **Men's College Basketball** and **Women's College Basketball** seats no longer say *Blocked*. What was blocked is the NCAA tournament simulation (no 2027 field before Selection Sunday; no women's host-site bracket), not the game forecasts, so the seats now name the phase of the season.

- **Preseason.** Until the season's first regular-season game (2026-11-02), both daily refreshes price the whole opening week instead of the next 48 hours. Ratings are last season's, carried forward, because no game has moved them yet. Each forecast is flagged `PRESEASON_RATINGS`, and the seat shows a **Preseason** chip and a card saying so.
- **Then the season, with no switch.** The refresh finds the opener in its own schedule file. From opening day it returns to the routine 48-hour window. The reader's chip turns over at the opening day in the generated registry (`games.regular_season_start`).
- **Exhibition games are not priced.** No schedule we read lists them: the hoopR and wehoop files have no preseason row in any season, and ESPN's Division I scoreboard listed none this week.
- **Unchanged.** The tournament simulation stays BLOCKED, with the same blockers, in the Tournament tab (now titled *NCAA tournament simulation — Blocked*). The planner's publication gate is unchanged too. Publication still waits on `NCAAM_FC_PUBLISH` and `NCAAW_FC_PUBLISH`.

## 2026-10-24 — Content engine: the draft and its integrity check read one availability index

Since the morning's editorial data refresh, `System integrity tests` failed on every branch (10 checks: the deterministic draft was BLOCKED, so it was never approved, exported or sent). The content-engine live check (`evidence.test.js` L) failed on six articles.

- **The quarterback-input sentence.** A `QB_INPUT_CONFLICT` flag was written as "the model's quarterback input may be out of date (the model expects Parker Puckett, but Kamario Taylor is listed as questionable)". `AVAIL.guardProse` checks every player named in an uncertainty sentence. Puckett, the model's own starter, has only an inferred classification, so the engine blocked a sentence it wrote itself.
  - `availabilityIndex()` is now the one place the index is built, and `validate()`'s `qb_claims_sourced` and the draft both read it.
  - The draft names only the reported player, and gives his status only when that index says his report may be stated. Otherwise it says the input "should be checked against the latest availability report" and asserts nobody's availability.
  - When the report lists the model's own starter, he is named as the starter it expects.
  - `draft()` passes its clock to the classification, so the draft and the check judge the same report at the same moment.
- **Other models' margins.** "EdgeDesk's two other, independently built models have Mississippi State by 0.3 and Oklahoma by 1.9" failed `numbers_reconcile`. `altMarginsOf()` read those margins only from a games-to-watch packet, which a matchup analysis does not carry. It now also reads the evidence packet's own `other_models` claim, the sentence the copy prints. A margin no model has still fails.
- The edge function copy is re-inlined (`tools/content/inline.js`). The admin content page's engine stamp moved.

Tests: `tools/integrity/regression.test.js` 129/129 (was 10 failing). `tools/content/evidence.test.js` 198, 5 new, all failing on the old engine: the conflict sentence never names the model's starter; a sourced questionable report is named with its status; the model's own starter is named as such; an unsourced report asserts nothing; the packet's other-model margins reconcile while an invented one fails. Content core 333, edge function 70, games to watch 136 and the weekly job 30 all pass.

## 2026-10-24 — Leave one term out: each college term held to games it never saw

`football/cfb_p4/research/loto.js` removes each priced term from the shipped engine, game by game, on 2022–2025. Nothing is refitted, and the repository's own promotion rules (`football/validation/promote.js`) judge the difference. It also fits each term's best multiplier k (k ≈ 1: the weight is right; k ≈ 0: the term carries nothing). The record is `football/validation/loto_cfb.json`, rendered to `docs/cfb-validation/LOTO.md`.

- **The rows.** `disagreement_replay.js` prices 8,724 FBS games, 2014–2025. It runs the shipped engine cold and frozen weekly, with the matchup layer fed by the board's own efficiency adapter (`disagreement_eff.js`, rebuilt for 2014–2025). The replay now also records the matchup term pairing by pairing (`mpairs`). Every row was priced before kickoff.
- **Verdicts (held out 2022–2025, 3,127 games):**

  | term | effect on MAE | weight k | promotion rules | weight |
  |---|---|---|---|---|
  | Stylistic matchup | +0.037 (95% CI −0.021 to +0.094), p = 0.20, better in 4 of 4 seasons | 0.84 [0.48, 1.20] | CANDIDATE | carries real information at about the right weight; the accuracy gain is not yet significant |
  | Conference strength | +0.186 | 1.11 | VALIDATED | |
  | Home field | +0.186 | 1.00 | VALIDATED | a check only: its value was chosen on this window |
  | Team strength | | 0.91 [0.86, 0.96] | | over-weighted by about 9% |
  | Rest and schedule | moves the line 0.001 pts on average (NEGLIGIBLE) | | | |

  The schedule result comes from units: `engine.js` schedGap divides the trained points-per-stress by 100 a second time. At the trained scale its held-out weight has no signal (k −0.96, interval −3.38 to +1.37). Not changed here.
- **The matchup term, pairing by pairing.**
  - Four of its eight learned pairings never move in the replay: run game, passing efficiency, explosives and field position. They need EPA and field-position inputs that the season feed (`football/rankings/engine_efficiency.js`) does not supply.
  - On the live board those inputs hold the 2025 closing seed all season. `--live` splits the live slate's matchup points: 1.23 pts on average from this season's data and 0.42 from last season's values, which no test covers.
  - The run and pass pairings move the live line by 0.01 and 0.03 pts.
- **The cards follow the evidence.**
  - A college pass or run mismatch now carries `0 PTS` and says its pairing gets no current-season data. It names the matchup term's points ("Utah +1.4 here") as moving through other pairings, with the term's held-out record in one sentence.
  - Line-of-scrimmage items keep the matchup chip.
  - `lib/edgedesk_factor_evidence.js` reads the record. `FACTORS.md` now gives matchup, schedule, conference, home field and team strength their leave-one-term-out results, and lists the inert pairings and the unpriced lanes.
- **Not testable here:** quarterback and injury (no historical inputs), travel, rivalry and altitude (not priced).

Tests: `node tools/football/loto.test.js` (37, in the CFB validation workflow) covers:
- a real term at its right weight is validated;
- a noise term never is;
- a term shipped 10% too large is caught as over-weighted;
- inert and negligible terms are reported, not graded;
- a row priced after kickoff fails the leakage check;
- the committed record re-derives its own statuses, and `LOTO.md` is its render.

`game_research.test.js` (246): unpriced lanes say 0 PTS, line-of-scrimmage items keep the matchup term, and the registry carries the verdict. The browser test (57) and the CFB validation, engine, altitude and landing suites all pass. Cache stamps moved for the snapshot and home model.

## 2026-10-24 — Women's college basketball forecasts: the men's system, rebuilt for the women's game

`basketball/ncaaw_forecast/` gives NCAA Division I women's basketball the same pregame forecasts as the men's: win probability (overtime included), expected score, 80% margin and total intervals, and Upset Watch. It has its own data, selection, champion, tables (`ncaaw_fc_*`) and publication switch (`NCAAW_FC_PUBLISH`), and shares only the league-neutral research engine. Readers see it in the Simulator's new **Women's College Basketball** seat. The men's seat is now labelled **Men's College Basketball**.

- **The women's game, measured, not assumed.**
  - Four quarters from 2015-16, counted per game from the source's regulation format.
  - No one-and-one, so possessions use the two-shot-bonus constant 0.44.
  - Box scores cover 13-33% of finals before 2017, so the possession model starts there.
  - The NCAA tournament's first two rounds are home games for the top 16 seeds, and the source flags them reliably from 2022.
  - Every final agrees with the served women's dataset.
- **Chosen on women's games only.** Development 2018-2022, confirmation 2023-2026, tournament holdout 2024-2026, all fixed before any women's number. The women's model keeps more of last season's rating (`carry` 1.0 vs the men's 0.9) and weights recent games more (half-life 365 days).
- **Confirmation results** (21,695 D-I games, against the served scores-only model):
  - log loss −0.00455 [−0.00661, −0.00276]
  - margin CRPS −0.19 points
  - 80% coverage 0.80
  - the 2024-26 tournament holdout is better too (−0.009 [−0.019, −0.001] on 201 games), but too timid with top seeds at home.
- **Promoted by the frozen gates.** `ncaaw_adjeff@1.0.0` passed all eight of the men's gates, adopted unchanged. The research registration, NCAAW-FORECAST 1.0.0 (EXPERIMENTAL, T3), was written before validation.
- **Production artifact matches the walk-forward exactly.** With a recency half-life, the engine's fit depends on when it refits. The artifact now refits at the walk-forward's moments, and a replay stops at its as-of time, so the production artifact reproduces the walk-forward forecast to 1e-9. The men's champion has no half-life and is unaffected.
- **Not built, each with its reason:**
  - the tournament simulation (needs a host-site-aware bracket)
  - in-game forecasts (no women's live feed)
  - the market comparison (no women's price is captured).
- **Not live yet.**
  - The tables go to production with *Deploy NCAAW forecast SQL* after the merge.
  - Publication starts with `NCAAW_FC_PUBLISH = on`.
  - Signal Center's women's forecast shifts are wired and tested, and held at coming soon until then.
- **The website** names women's college basketball's research and daily forecast in the home page's sports answer (landing test), the README, the Simulator notes and the men's notes.

Tests:
- model 98
- SQL 67, on a real PostgreSQL, with the men's layer applied beside it
- failure injection 37
- reader 49
- Chromium 41
- Signal Center registry 227, worker 46
- every men's suite still green.

## 2026-10-24 — Watch items say what they add to the line; reliability prints as data quality

A reader asked three things of the Houston at Utah card: how many points altitude gets, whether it is counted twice with home field, how the whole defence (not one lane) is read, and what "RELIABILITY 98/100" means. The answers now sit on every game's card and research page, not in a reply.

- **Every "What to watch for" item carries a chip** (`EDGameSnapshot.effectOf`), taken from the snapshot's own driver rows:
  - `UTAH +2.8`: the term, its points and the team they favour.
  - `0 PTS`: measured, but not in the number. This covers college travel, officials and weather, altitude (rejected), a regime change at the standard weight, and anything under 0.05 pts.
  - `CONTEXT` (a ranking with no term) and `CROSS-CHECK` (models agreeing).
  - Drawn on the graphic (square and portrait, with a legend) and on the research page with its reason. A spec recorded before chips redraws without them. The graphic template is now `edgedesk_game_graphic/4`.
- **The whole defence.** A pass or run mismatch now prints the same defence's other lane: `UTAH pass O #19 vs HOU pass D #86; run O #24 vs run D #36.`
  - On college games the chip is the matchup term, which nets all eight pairings on both sides of the ball (Utah +1.4).
  - The text says that term has no held-out test of its own.
- **Altitude** says it adds 0 and why. Home field is one 2.8-pt value for every home team, so the climb is not counted inside it either.
- **Altitude re-checked against the 2.8-pt home field** (`football/altitude/research/recheck.js` → `football/validation/altitude_cfb_recheck.json`).
  - The old verdict was fitted against 4.082 pts. On a fresh cold replay it is still REJECTED: held-out MAE 12.933 → 12.950 (p = 0.71), placebo p = 0.14.
  - The double-counting reasoning has flipped: hosts of a 3,000+ ft climb now beat the number by +1.04 pts (95% CI −0.03 to +2.22). This is written up in `docs/cfb-altitude/README.md`. `params.js` is unchanged.
- **Reliability prints as DATA QUALITY** on the graphic, the snapshot label and the research page.
  - It is a hand-weighted check of the inputs, and the alt text says it is not a win probability.
  - `reliability_calibration_cfb.json` has never validated it: 76 graded games, and none at 90+. The internal field names are unchanged.
- **Factor evidence** (`lib/edgedesk_factor_evidence.js`, `tools/football/factor_evidence.js` → `docs/game-research/FACTORS.md`, `football/game_research/factors.json`).
  - For each college factor: is it in the number, how much, what test, what result. It is generated only from the model and validation files.
  - It names the gap: the stylistic matchup term moves every college line and was fitted in-sample on 2014–2019. The cold replay carries no play-level efficiency, so the term has no out-of-sample record. The next piece of work is a leave-one-term-out held-out test.

Tests: `node tools/football/game_research.test.js` (241, 20 new: every item carries an effect, in-number chips match the driver rows, unpriced families never claim points, two-lane text, altitude wording, chips and legend drawn, old specs redraw without them, the data-quality label, the registry against `params.js`, and `FACTORS.md` freshness), `tools/football/game_research_ui.e2e.js` (57), `cfb:altitude:test` (131), and the NBA, NHL and Signal Center graphic suites unchanged.

## 2026-10-24 — Import picks: screenshots or pasted bet history, read by Claude, checked by the reader

Readers on books with no history export (Novig, ProphetX, Kalshi, DK Predictions) entered picks one at a time. Portfolio → Import → **Screenshots or pasted text** (also on + Add position and the empty book) now reads a batch at once. The reader then checks every row before anything is saved. `docs/bet-import.md` is the design.

- **No new picks table.** Confirmed rows go through the Portfolio's own staging and commit (`portfolio_import_commit`) into `portfolio_positions`, under the reader's token and the same row level security.
- **Labels and dedupe.** Imported rows are labelled `IMPORT_SCREENSHOT` / `IMPORT_PASTE`, upper case like the column's other values. A pick already saved (same platform, event, market, selection, price, stake and placed minute) is skipped. The page also says so before Confirm.
- **The reader:** `supabase/functions/parse_bet_import` sends the screenshots or text to the Anthropic Messages API and asks for strict JSON.
  - JWT verified; the key is a Supabase secret.
  - Limits: ≤ 6 images and 4.5 MB each, ≤ 40,000 characters.
  - A per-reader allowance, claimed atomically in the database, that fails closed.
  - The shared core (`lib/edgedesk_bet_import_core.js`) checks every bet on the server, and again in the browser on every edit. A failing bet is flagged, never dropped. Images are never stored or logged.
- **The review table:**
  - every field is editable, and fields the model was unsure of are highlighted;
  - a row with an error cannot be confirmed;
  - each pick is matched to an EdgeDesk game from `public.signals`, and an unmatched one says so and offers the games;
  - a shared city ("New York") is evidence for neither team.
- **Screenshots** are scaled and re-encoded as JPEG on the device, and tall scrolling captures are cut into overlapping tiles.
- **Prices both ways.** `price_display` holds the price as shown. `price_american` is derived for both instruments: 54¢ = −117, 40¢ = +150. Kalshi and DK Predictions picks become contract fills: a sale is a BUY and a SELL, and a loss resolves to the other side.
- **CLV:** a matched single carries its game and capture key. A new 15-minute job (`portfolio_svc_attach_import_close`) puts the close on the journal: the reader's book's last tick before the start, else EdgeDesk's own close.
- **Existing files:**
  - `portfolio.sql` carries the widened insert policies (the same owner rule plus the two values).
  - The sportsbook and Kalshi sync adoption lists (`portfolio_aggregator.sql`, `portfolio_connect.sql`) adopt an imported pick instead of double-counting it once a sync is switched on.
  - The parts are regenerated.
- **Deploy:** `.github/workflows/deploy-bet-import.yml` runs the tests, then the SQL, then the function with JWT verification on.
- **Read on choosing, and kept up to date** (from a reader's DraftKings Predictions "Trades" screenshots):
  - **Detect automatically** is the default: the model names the platform from the screenshot, and each row's platform can be changed in review. A position priced as a percentage or in cents is DraftKings Predictions / FanDuel Predicts, not the sportsbook.
  - Reading starts as soon as screenshots are chosen; **Add more screenshots** appends to the same review.
  - Percent prices, "Bought" (cost), "Paid" (payout) and profit boosts are read; a pick that names its outcome is YES on it; team names are written in full; header balances are ignored.
  - Rows with nothing to check (valid, no warning, nothing unsure, game settled) arrive confirmed. What was worked out is shown as information, not as a problem.
  - **Contracts, exactly:** a 2-decimal price takes contracts to 4 decimals (the database's whole-millionth rule), the remainder of the cost is the fee, and a settled contract's payout is what it paid. Under 202.5 at 54%, $24.64, won $48.84 boosted → +$24.20. Over and Under of one game are separate contracts.
  - **Automatic update:** a pick saved Open is settled in place (one PATCH under the reader's RLS) when a later screenshot shows its result; a pick settled another way is left alone and said so; nothing is ever inserted twice.
  - `tools/portfolio/bet_import_live.js`: an opt-in check of real screenshots against the real API with the operator's own key (never in CI).

Tests:
- `node tools/portfolio/bet_import.test.js` (100): the core, the shipped function against a mocked network, the review table, and the DK Predictions fixture (`tools/portfolio/fixtures/dk_predictions_trades.json`, transcribed; no image committed).
- `node tools/portfolio/bet_import_sql.test.js` (76): `bet_import.sql` with the browser's own staged rows through the real commit; dedupe, RLS, the allowance, games and closes; the DK cards' P&L and the Open → Won update under RLS.
- `node tools/portfolio/bet_import.e2e.js` (41): Chromium, the real migrations, 1280 px and 390 px; the DK journey with no platform chosen, pre-confirmed rows, an appended screenshot and an in-place update.

All three are in `portfolio-tests.yml`. The existing Portfolio suites stay green: `portfolio:test`, all eleven `portfolio:sql` suites (814 checks), navigation, integrity and guide. One UI assertion changed on purpose: the empty book lists "Import picks" between the CSV import and recording by hand.

## 2026-10-24 — The landing fixes reach browsers that already had the page: new ?v= stamps, and a guard

#749 removed the DATA INCOMPLETE chips from the landing page's Today's games card, but phones kept showing them. `lib/edgedesk_home_free.js` changed while `index.html` still loaded it as `?v=20261008a`, so a returning browser kept running its cached copy. #747 did the same to `lib/edgedesk_pricing.js` (`?v=20261004a`), whose FEATURES list the terminal's paywall prints.

- **New stamps:** `edgedesk_home_free.js?v=20261024a` in `index.html`; `edgedesk_pricing.js?v=20261024a` in `index.html`, `app.html`, `methodology/index.html` and `research/sample/index.html`.
- **A guard** (`tools/presentation/landing_asset_stamps.json`, `landing_interaction.test.js` §7b): every `/lib` asset `index.html` loads with a stamp is recorded with that stamp and its content hash (sha256, 16 hex).
  - If an asset's content changes and its stamp does not, the suite fails and says what to do: bump the stamp, then record both.
  - Each asset must carry one stamp wherever the page loads it.
  - Every recorded asset must be one the page loads.
  - Mutation-checked: appending to `edgedesk_home_free.js` without a new stamp fails it, and so does rolling the stamp back.
- `lib/edgedesk_track.js` changed on 2026-10-23 under `?v=20260930a`, but only in an app navigation event name the landing page never sends. It is recorded as it stands.

Tests: `landing_interaction.test.js` 295 (was 219). Every unit suite that reads `index.html`, `app.html`, the methodology or sample pages, the pricing or the plans is green (135 files; 3 skip without PostgreSQL).

## 2026-10-24 — Men's college basketball forecasts: tables in production, named where the sports are

The forecast tables are in production. *Deploy NCAAM forecast SQL* (run 40052574063) passed the SQL suite on a throwaway PostgreSQL, found the simulator layer, applied `supabase/ncaam_forecast.sql` in one transaction (every report row `ok`: tables, row-level security, no client writes, job functions closed to clients, live forecasts off, an anonymous caller not entitled) and registered NCAAM-FORECAST 1.0.0 and SIM-NCAAM-TOURNAMENT 0.1.0 (EXPERIMENTAL, T3). Nothing is published until `NCAAM_FC_PUBLISH` is `on`; the season opens 2026-11-02.

Where the forecasts were missing or out of date:
- **Home page FAQ** ("What sports are currently supported?") now names men's college basketball's research and its daily pregame forecast, with the same no-value-claim framing as the other sports. The landing test checks it.
- **README** has a section for the forecast system (status, champion and evidence, safeguards, where, run it), next to the research engine's.
- **Signal Center:** forecast shifts stay **coming soon**, now for the one remaining reason, publication (`NCAAM_FC_PUBLISH`). Registry cache buster sc5.
- **Simulator:** the College Basketball activation path no longer asks for the SQL or a champion (both done). `SIMULATOR_NOTES.md`'s matrix said COMING SOON with pre-build blockers. It now says BLOCKED for the tournament, with the Games and Upset Watch tabs reading the daily forecasts.
- **`CBB_MODEL_NOTES.md` and the runbook** record what is deployed and what is left: setting the variable.

## 2026-10-24 — Signal Center's sample: tap each level of evidence to see its signal

The landing page's Signal Center picture (`index.html` #signals) showed one sample signal with the evidence ladder beneath it as a static row. The four steps are now buttons. Each shows a sample signal at that level, in the detail view's order: kind, sport, label, headline, numbers, and why.

- **Confirmed cause:** an NBA availability change, where EdgeDesk re-ran the model changing only that player's availability (−4.1 pts). It says plainly that no live signal carries this level yet: none of today's sources supplies an isolated effect (`tools/signal_center/evaluate.js` passes `nbaEffects` empty).
- **Supported association:** the forecast shift that was the only sample before. This is the step the markup opens on, so a no-script reader sees it.
- **Observed:** a market divergence. Both numbers are on record, and no reason is claimed.
- **Unexplained:** a forecast shift with no input recorded; Signal Center says it does not know yet.
- Every sample is labelled "not a current signal" and is about no real game or player. Each tap is measured as `signal_sample_click`, with the level. The styles are in `lib/edgedesk_landing_desk.css` (stamp `20261024dk2`).

Tests: `landing_positioning.test.js` 556 (was 540). Each step has its sample; the default is the no-script view. Each kind, sport and label is Signal Center's or the engine's own. Each sample's numbers add up and it names no real team. A guard fails the suite the day a source supplies isolated effects, so the "no live signal carries it yet" sentence cannot go stale. `landing_interaction.test.js` 219 (the module exists and bails without its host). `landing.e2e.js` 327: at 390 and 1280 px, tapping each step shows only its own sample, four steps give four different signals, and nothing overflows. With the module removed, 8 of these checks fail.

## 2026-10-24 — The landing page's first section never reads DATA INCOMPLETE

The free section's **Today's games** card (`index.html` #free, `lib/edgedesk_home_free.js`) listed the four soonest games with the board's status chip on each. When the board had not priced them yet, or their price was stale, the first thing a visitor saw was a column of DATA INCOMPLETE.

- **A game with EdgeDesk's public read comes first.** The card still lists up to four games, shown soonest first, but it picks games with a RESEARCH, WATCH or PASS read before games without one.
- **A game without a read is listed with no chip.** The card already says "with EdgeDesk's public read where the free board has one". This is the rule the research preview already keeps: its `listed_games` and `listed_props` leave DATA INCOMPLETE out.
- Nothing changes in the view model or in what `/today/` shows; there, DATA INCOMPLETE is printed with its reason.

Tests: `node tools/home/landing.e2e.js` (305, was 301).
- The live board's games carry a read where they have one, and none reads DATA INCOMPLETE.
- A stale board, where every game is DATA INCOMPLETE, still lists the slate with no chip. On the old code this check failed at 390 and 1280 px with the same column of DATA INCOMPLETE as the reported phone screenshot.
- Green with local fonts and with the CI runner's (Inter hidden).

## 2026-10-24 — The landing page sells the terminal: the desk, Signal Center and the Simulator

The landing page (`index.html`) described football research and bet tracking. Since 2026-10-23 the terminal also has Signal Center (live in production) and the Simulator (ten sports ACTIVE). The page now says what EdgeDesk is, a research terminal for sports markets, and what Full Access adds to the free research, seat by seat. The free football research still comes first, and nothing is claimed that the product does not do.

- **The hero:** "The research terminal for sports markets." The sentence says what the terminal does and that the football research is free. It is short enough for the first phone screen in the CI runner's wide fallback face, where the headline wraps to three lines; the offer line under the buttons says "no card". The previous headline is kept as variant `r` (`?hero=r`).
- **#desk (new):** the terminal's six seats (`app.html` `NAV_PRIMARY`), each with the question it answers, Signals and Simulator marked New. Below them, the upgrade from free to Full Access, row by row; a part that is not free says "Not included". Kalshi is claimed only where it lists the game or the future.
- **#signals (new):** what Signal Center detects, the evidence ladder and Model DNA, with a link to the free preview (`/signals/`). Its picture is labelled sample data about no real game. Its kinds, ladder and label are the engine's own words.
- **#simulator (new):** the ten sports the registry has ACTIVE and what each simulates, the provenance labels, and the honesty line: experimental, and none of its game models has shown it beats the market. Its picture is labelled sample data. The division column sums to 100, and the ± is the Monte Carlo error at 100,000 runs.
- **Pricing:** `EDPricing.FEATURES` (also the terminal's paywall) now leads with Signal Center and the Simulator. The football lines and the journal lines each merged, so there are still eight. `EDPlans.FULL` mirrors the list with each server gate. The Signal Center preview joins `EDPlans.FREE` and the free card, now that Signal Center publishes.
- **Elsewhere on the page:** the #research eyebrow is now "Game research" and its market line names Kalshi. The FAQ adds "What do Signal Center and the Simulator add?", and the coverage answer names the Simulator's sports. Trust adds the pre-registered model tests, whose rejections stay on record. The footer, social metadata and structured data describe the terminal.
- **Weight:** the new styles are `lib/edgedesk_landing_desk.css`, which loads like the pictures sheet and never blocks the first screen. The page budget rises from 200 KB to 216 KB because the markup grew about 15 KB (57.9 → 61.9 KB gzipped).
- The Bloomberg name is not on the page; the copy says "research terminal" instead.

Tests: `node tools/presentation/landing_positioning.test.js` (540, was 479). New checks:
- the seats are app.html's;
- the sports listed are the registry's ACTIVE ones, and every "N sports" on the page, metadata included, is their count;
- other sports are named only in #simulator and the coverage answer;
- the sample arithmetic adds up.

Twelve mutations were checked; each one turned the suite red. `node tools/presentation/landing_interaction.test.js` (217, was 215) covers the new sheet's dead classes, budget and non-blocking load. `node tools/home/landing.e2e.js` (301, was 300) covers the hero, variant `r`, and no overflow at 320 to 1280 px; it caught the Simulator table widening the phone column, which is fixed. Every other unit suite that reads `index.html`, the pricing or the plans is green. `tools/billing/checkout_flow.e2e.js` step 5 fails here identically on `main`; it needs a configured checkout link, and no workflow runs it.
## 2026-10-24 — Signal Center: men's college basketball forecast shifts held at coming soon

Production has no men's college basketball forecast tables: the first live run after the deploy answered "table not found" for `ncaam_fc_runs`. The cell said operational. It now says **coming soon**, and names why: `supabase/ncaam_forecast.sql` is not deployed, and the daily job publishes only with `NCAAM_FC_PUBLISH` on. The wiring stays tested (`worker.test.js` reads staged runs through `ncaamGames` and finds the shift). Once the tables are deployed and publishing, the registry entry becomes operational.

## 2026-10-24 — Signal Center: the upgrade applies to a table that already holds signals

The deploy of the backfill (2026-10-24 01:14 UTC) rolled back, so nothing changed: `cannot ALTER TABLE "sc_signals" because it has pending trigger events`. The upgrade updates the stored rows twice (dating, then placement). The second update of a row the same transaction already wrote queues the deferred `current_version_id` check, and the later `ALTER TABLE … enable row level security` will not run while a check is pending. The file now checks every constraint at its statement (`set constraints all immediate`, this transaction only). The SQL suite's upgrade test now builds the table as production holds it, with versions and the guard #737 installed, and applies the file in one transaction as the deploy does. Before the fix it failed with production's exact error.

## 2026-10-24 — Signal Center: NFL injuries, dated by EdgeDesk's first sight

nflverse's copy of the NFL's official injury report has no per-row publication time, which kept NFL injury signals blocked. The injury sync (every six hours, unchanged) now also appends each game designation new or changed since its last run to an append-only ledger, `football/injuries/history/nfl_<season>.jsonl`, stamped with its own retrieval time. Signal Center reads quarterbacks from it.

- **The time is EdgeDesk's, and says so.** Every signal and graphic reads "first seen by EdgeDesk", never "published". The detail's timeline says the source has no publication time, and the payload is flagged `PUBLICATION_TIME_UNKNOWN`. The category is **experimental**, not operational.
- **The baseline is never news.** The ledger's first rows are what was already listed when it began (committed from a real fetch on 2026-10-24); only a change after that is a signal. A designation that disappears is not recorded: an empty game status is not a clearance.
- **Source-dated payloads are untouched by this change:** a CFB injury payload hashes exactly as it does without it (the `sc_importance_v2` re-versioning in #741 is separate).
- **Freshness warnings:** today's slate feeds for men's college basketball, UFC and college baseball are credited (the slate's `ncaabase` is Signal Center's `college_baseball`). A shared source's warning (`football`: NFL and college football; `all`) now publishes when a sport it serves is live (`sc_sport_live`, SQL); before, it could never publish.

## 2026-10-24 — Signal Center: live in production; golf, tennis, UFC and men's college basketball wired

**In production** (at the owner's request; docs/signal-center/DEPLOYMENT.md): the migration is applied (all 12 report rows ok), the mode is **live for every sport**, and the first run stored 371 signals, published 166 and drew 144 graphics. The first deploy's ingest failure (`digest()` outside the doors' `search_path`) is fixed with the built-in `sha256()`.

- **Simulator shifts for golf, tennis and UFC** (`E.SIM_OUTCOMES`). Golf compares one tournament (win, top 5/10/20, the cut until it is made), tennis one draw (title, final, semifinal, quarterfinal), UFC the title path (Estimated). An outcome whose meaning changes between runs is never compared: "win the next match" and the next-bout outcomes. A signal about a golfer, a player or a fighter is about a person: its graphic shows initials in neutral colours and no playing surface. The Simulator's `ufc` is Signal Center's `mma`.
- **Men's college basketball forecast shifts** from the published daily runs (`ncaam_fc_runs` with status `completed`, and their forecasts), D-I against D-I, for games not yet started. A run that never took the published pointer is not read. A game rated between two runs is the shift's source-dated support; the forecasts' data-quality flags ride along, and availability is not modelled.
- **Coverage** shows what the database publishes today ("Publishing": live or shadow) when the mode is known.
- **The operator console** lists every registry sport, and keeps any switched-on sport it does not list, so saving the mode can no longer drop one.
- The worker reads each simulator run's compared outcomes in one request (a full page is read again outcome by outcome). The PostgREST stand-in (`tools/billing/_pgrest.js`) learns `in.()`.

## 2026-10-24 — Signal Center: the season's history, found point in time

The first production runs stored nothing: every write failed on pgcrypto's `digest()`, which Supabase keeps off the doors' search path. #737 fixed that with core `sha256()`, and the 00:25 UTC run (live, every sport) stored 371 signals and published 166. Two problems remained. That run dated every signal by itself, including changes from days earlier. And it read only part of what EdgeDesk records. This backfills the season from the records EdgeDesk already keeps, each signal dated when it happened and marked as found later, and corrects the rows already stored.

- **No pgcrypto call can come back** (`tools/signal_center/sql.test.js`): a static check refuses `digest()` and its relatives, comments aside.
- **More history from the existing records** (`tools/signal_center/sources.js`):
  - Imported performance-ledger rows were dropped because their `capture.captured_at` is null. They are now read at their `recorded_at`, taken from the record's git history. This affects 70 NBA, 162 NHL and 929 CFB rows.
  - NFL and CFB forecasts from the ledger now count back to 2026-09-11, before game research began (2026-10-16). Each is its own series, never paired with a research snapshot.
  - NFL and CFB prices come from `record/football/quotes/`: every DraftKings reading since 2026-10-03, with the teams named. One capture path per sport.
- **Point in time** (`lib/edgedesk_signal_engine.js`, `E.SPEC.backfill`): a change found more than 180 minutes after its record is scored as of that record and marked `backfilled`. Its detection time stays the true one. Neither field changes a version.
- **Past model–market boards are replayed** (`tools/signal_center/evaluate.js` `replayMarket`). At each capture pass, each game's latest snapshot and price are judged by the same engine with now = the pass. No later record is read. There is one card per disagreement episode (a new one only when the gap moved ≥ 2 pp) and one convergence when it closes.
- **The database places history** (same file, additive and idempotent):
  - `sc_signals.backfilled` and `signal_at` (the moment a signal describes) are fixed at the first version.
  - Older signals are superseded by newer records in time order, whichever was found first.
  - A live run publishes verified history (expired or superseded) and, through the new job door `sc_publish_pending`, what was stored while in shadow. Holds stick, and backfilled signals never become notices.
  - The feed sorts and filters by `signal_at`, and gains the `timeline` scope (latest per subject, current and past). The pulse counts by `signal_at` and tells an operator in shadow mode that it includes unpublished signals.
  - A disagreement whose convergence is on record is no longer offered for another (`sc_prior_divergences`). Previously every later quote made a new convergence card.
  - **Rows already stored** (the 371 from 00:25 UTC) are dated by the same 180-minute rule when this file is applied. They are placed in record time: in each subject, outcome and event, older active or expired signals are superseded by the newest, with an audit event.
  - One placement rule for what is still unpublished, `sc_place_shadow` (verified, a live sport, label ≥ Routine, not withdrawn, history included). It runs on #737's switch to live (`sc_promote_shadow`) and on every live run (`sc_publish_pending`).
- **The scoring specification is `sc_importance_v2`**: v1 plus the backfill rule. The new id re-versions each stored signal once (reason *methodology*), so the 00:25 UTC rows are re-scored by the rule their backfilled siblings follow.
- **The terminal seat** lands on the timeline. A backfilled card reads "recorded <time> · found in the ledger later". An operator in shadow mode sees the unpublished signals by default, as the status bar already said.
- **Audit:** every number in the 745 signals of a dry run (2026-10-24) was re-derived from the raw files by an independent checker (its own de-vig and exact-decimal rounding). It found 0 issues: values, orientation, source citation, time order, pregame, and that no comparison read a record stamped after its board. This audit caught one bug before release: replayed disagreements had cited the research file for ledger snapshots.

Tests: `engine.test.js` 125, `registry.test.js` 186, `ui.test.js` 96, `graphics.test.js` 268, `sql.test.js` 184 (including the upgrade of rows stored before these columns), `worker.test.js` 36, `graphics.e2e.js` 200, `ui.e2e.js` 123, `pages.e2e.js` 58; navigation 263 + 172.

## 2026-10-24 — FBS vs FCS: the level-map repair, tested as registered and rejected

The CFB engine prices FBS-vs-FCS favourites 7.8 points short of the close (H-003). The first repair, a map from the engine's margin to the real (uncapped) final, was pre-registered as H-014 (`docs/market-intelligence/hypotheses.json`, committed before any fit) and run once (`npm run cfb:fcs:uncapped`, `football/cfb_p4/research/fcs_uncapped.js`).

- **Rejected.** On 1,072 FBS-vs-FCS games, 2016–2025, each season fitted only on earlier ones, the affine map lowers MAE against real finals by 0.10 pts [−0.23, +0.02] (6 of 10 seasons); the shift by 0.08. The bias goes from 2.07 to 0.43 points but the error barely moves. The registered bar was an interval below −0.5.
- **What it showed.** The historical shortfall is about 2 points and has risen (2024 3.4, 2025 5.1, about 8 live in 2026). The gap to the market is ordering, not level: on games with a close, the engine's MAE is 15.1 against the close's 12.1. The FCS bridge's own 2026 walk-forward, re-scored on real finals, lowers MAE by 0.95 pts [−1.46, +0.29], where its capped verdict saw 0.02. `docs/market-intelligence/AUDIT.md` is corrected (it had called per-team ratings the wrong fix).
- **Recorded, never applied.** `football/cfb_p4/fcs_margin_map.js` holds the final fit with `survived: false, promoted: false`; nothing reads it into a price. Evidence: `football/validation/fcs_uncapped_cfb.json`; report: `docs/market-intelligence/FCS_UNCAPPED.md`.
- **Forward tests.** H-015 (the map, if it had survived) and H-016 (a frozen +4.27-point shift, the 2024–2025 mean shortfall, designed after seeing the season means and so tested only on games after its registration) are judged by `tools/market_intel/validation_report.js` as games are played.

Tests: `node tools/market_intel/fcs_experiment.test.js` (19): no fold reads a later season, the committed evidence for H-014 reproduces, the map is never priced, and the forward tests sign the FBS side correctly home or away.

## 2026-10-23 — Signal Center: what changed in EdgeDesk's research, why, and whether the evidence supports it

A new first seat in the terminal, **Signals** (`app.html#signals`, alias `#signal-center`). It is backed by a detection engine, an additive database layer, a graphics template family, a public preview and an operator console. **Nothing is deployed:** the migration is not applied, the hourly run is off, and Signal Center starts in shadow mode (docs/signal-center/DEPLOYMENT.md).

- **The engine** (`lib/edgedesk_signal_engine.js`) compares only comparable numbers: the same event, outcome, model identity and market definition, oriented by team and ordered in time. It detects forecast shifts, model–market disagreements and convergence, market movement, Simulator changes (|z| ≥ 4 on both runs' Monte Carlo errors), availability changes, model reliability warnings and data freshness warnings.
  - **The evidence ladder:** a cause is claimed only when an input was isolated. Otherwise a change is a supported association, observed, unexplained, or a model version change.
  - **The importance score** (`sc_importance_v1`) is documented and rules-based. It is not a probability.
  - **Model DNA** (`lib/edgedesk_model_dna.js`) gives each model's out-of-sample and live record. It never shows raw win rate as quality.
- **Capabilities per sport** (`lib/edgedesk_signal_registry.js`): a signal exists only where a dated source does. NFL injuries are blocked (no per-row publication time). MLB has no forecast history. The Simulator's own registry decides simulator signals.
- **The database** (`supabase/signal_center.sql` = `migrations/20261024120000_signal_center.sql`) adds `sc_` tables only: append-only versions, events and Model DNA; immutable graphics; preferences; a notice log; dead letters.
  - Readers, operators and the job each reach it through their own doors. Full Access is checked inside the doors (fail closed); everyone else gets number-free previews.
  - Feed paging uses keysets; a page takes about 40 ms at 5,000 signals.
  - Notices go to the existing bell, deduplicated, cooled down and capped at 5 per run and 20 per day per reader.
  - `supabase/signal_center_rollback.sql` removes it all.
- **The worker** (`tools/signal_center/run.js`, `.github/workflows/signal-center.yml`, off until `SIGNAL_CENTER_WORKER` = on) reads the committed sources and the Simulator, NBA injury and Kalshi tables. It writes only through the job doors, re-verifies active signals and withdraws any whose source vanished. It calls no odds provider and posts nowhere.
- **Graphics** (`lib/edgedesk_signal_graphic.js`): six templates (probability shift, market disagreement, availability, Simulator, reliability, weekly recap) in 1080×1080, 1200×675 and 1080×1350. They are drawn on the matchup renderer, whose existing layouts are byte-identical. A newer version makes older graphics OUTDATED (stamped) and revokes any approval. Approval for external publication is a record only.
- **The terminal seat:** Research Pulse, the feed with filters, sorts and history, "Why did this change?", Model DNA, Coverage, Alerts and Method. A new reader lands here only once it is live; otherwise they are handed to Research. A bell notice opens its signal.
- **`/signals/`** is the public preview: three anonymous doors, no current number, noindex until live. **`/admin/signals/`** is the operator console: mode, queue, hold, publish, withdraw, the preview pin, graphic review and download, the weekly recap, runs and failures.

Tests: `engine.test.js` (113), `registry.test.js` (177), `ui.test.js` (89), `graphics.test.js` (268), `sql.test.js` (139, PostgreSQL 16, including the rollback), `worker.test.js` (28), `graphics.e2e.js` (200), `ui.e2e.js` (119) and `pages.e2e.js` (58), all in `tools/signal_center/`. The navigation suites (`tools/app/navigation.test.js` 263, `navigation.e2e.js` 172) cover the seventh seat. CI: `.github/workflows/signal-center-tests.yml`.

## 2026-10-23 — Market intelligence and model validation: the audit, the lab, and four data-integrity fixes

A program to find out, with evidence, whether EdgeDesk's forecasts carry information the market does not (`docs/market-intelligence/MASTER_PLAN.md`). Nothing reader-facing changes; no model, migration, job or paid call is added.

- **The audit** (`docs/market-intelligence/AUDIT.md`): every sport's model, the market data pipeline, the alert, graphics and entitlement layers, and the simulators. The odds arithmetic is verified across seven implementations (0 mismatches on 9,802 prices).
- **The validation lab** (`lib/edgedesk_validation_lab.js`): week- and day-clustered bootstrap intervals with a leave-one-cluster-out check, paired model-vs-market differences, the information test (does the model's disagreement with the close predict the final?), the calibration fit, Benjamini–Hochberg/Holm, a point-in-time benchmark that never reads a later quote, walk-forward folds with an embargo, and pre-registered hypotheses that keep their rejections (`docs/market-intelligence/hypotheses.json`).
- **Model vs market on every committed live ledger** (`docs/market-intelligence/VALIDATION.md`, generated): the CFB model is behind the DraftKings close on spreads (MAE +1.44 [0.66, 2.22], n 417) and on win probability (Brier +0.016 [0.009, 0.028]); its disagreement carries no information (slope −0.03 [−0.25, 0.22]); its probabilities are not overconfident (slope 0.97 [0.68, 1.22]). It prices FBS-vs-FCS favourites 7.8 points short of the close [−12.0, −6.6]; the cause is the ±35 margin cap the ratings learn under with one shared FCS floor.
- **Market intelligence engine** (`lib/edgedesk_market_intel.js`): nine finding kinds with written eligibility rules, a seven-part explanation built only from computed numbers, and a wording guard. Backtested as of an hour before every 2026 football kickoff (`docs/market-intelligence/MARKET_INTEL_BACKTEST.md`). Not wired to reader alerts: no kind has shown value yet.
- **Replay** (`lib/edgedesk_replay.js`, `npm run market-intel:replay`): what EdgeDesk and the market knew at a moment, nothing after it, the result withheld unless asked.
- **Model registry** (`docs/market-intelligence/model_registry.json`): every model identity on a published forecast, label problems, and live same-game comparisons.

Fixed:
- **One sportsbook counted as two.** `lib/edgedesk_market_state.js` keyed books on the lowercased name, so ESPN's "DraftKings" and "Draft Kings" were two independent books and a lone DraftKings line was VERIFIED. Now the canonical key of `lib/edgedesk_market.js`.
- **NFL v2.1.0 forecasts labelled v1.0.0.** `lib/edgedesk_projections.js` named the slate header's model; it now names the game's own `model_version` (and the inlined copy in `edgedesk_ai/index.ts` is regenerated). The 47 ledger rows already written keep their label; `model_registry.json` records the correction.
- **A close taken in play.** `supabase/functions/close/index.ts` could price a row from a board observed after its game started. `closeRoute()` now sends such a row to the last tick before the start. Needs a deploy of `close`.
- **Kalshi NFL mappings had no season check.** `simulator/src/cli/build_kalshi_mappings.ts` now requires the 2026 season's event ticker (`-27`; `-AFC26` for the #1 seed).

Tests: `npm run market-intel:test` (validation lab 64, engine 49, replay 16); `tools/resilience/resilience.test.js` (120, was 117); `tools/resilience/quota_guard.test.js` (72, was 67); `tools/intelligence/multisport.test.js` (128, was 126); `simulator/tests/markets.test.ts` (92, was 88). Each fix's new test fails on the old code.

## 2026-10-22 — The landing page's matchup graphics carry Kalshi, as the research page's do

The landing page's **Real games, the way subscribers see them** (`index.html` #model, `lib/edgedesk_home_model.js`) drew each featured game's graphic model only. The research page's graphic for the same game sets **EdgeDesk vs Kalshi** beside the model. The landing page now draws that same graphic.

- **The same reads as the research page** (`app.html` `fbKalshiAtModel`), made as anon. First, the shown games' markets from `public.kalshi_card_current`, in one read. Then each market's two-sided `public.kalshi_price_snapshots` quote at or before and at or after the snapshot's model time. `EDGameGraphic.kalshiAtModel` keeps the nearest quote and `EDGameSnapshot.kalshi` places it on the right team, using the team resolver (`lib/football_identity.js`, now loaded with the research libraries).
- **The graphic is the research page's own drawing.** It shows both times ("Model 2:00 PM ET · Kalshi 2:02 PM ET"), each team's Kalshi mid and moneyline beside EdgeDesk's unrounded win % and fair moneyline, and the difference as a sentence naming the team, before fees. The download is the same PNG.
- **No sportsbook price** is read or shown, as before: the graphic's market argument is still `null`, and `landing.json` is unchanged. A game Kalshi does not list draws the graphic it always drew.
- **The page never waits long.** The first graphic waits up to 3 s for Kalshi and then draws without it. A later answer redraws it, with a matching download. A failed read is a state, never an error.
- The page holds the database address and key. It passes the module one anon read (`init({…, db: anonRead})`), and the module asks it only for Kalshi's two public tables.
- The caption and footer say Kalshi's price is shown at the model's time where Kalshi lists the game.

Tests: `node tools/presentation/landing_model.test.js` (122, was 105): placement on the right team with home and away swapped, the nearest quote, only the two tables asked for, the graphic's EDGEDESK vs KALSHI content, and not-deployed and failed reads. Mutation-checked. `node tools/home/landing.e2e.js` (300): the drawn graphic at 390 and 1280, a game Kalshi does not list, and a late answer redrawn. `landing_interaction` holds the module to Kalshi's two tables with no credentials; its size budget is 32 KiB (was 28), like the other landing libraries.

## 2026-10-22 — Juice Reel's credential check no longer depends on owner access

The first **Juice Reel setup** run (`start_live_test`) set the provider switch and the vault key: nothing is missing in Supabase now. Juice Reel then answered **401** to EdgeDesk's credentials, so no live test was started.

That check asked only `GET /oauth2/me` with the client id and secret (Juice Reel's owner access), and its refusal blocked the live test. A Juice Reel that does not offer owner access would therefore have refused good credentials.

- **`jr_check` now decides with `POST /oauth2/revoke` of a random token EdgeDesk made.** Juice Reel documents that revocation "does not reveal whether the token existed": valid client credentials get 200 `{}`, refused ones get 401 `invalid_client`. It is the same client authentication the code exchange uses.
  - The token is 32 random bytes, never issued, never stored and never logged.
  - `GET /oauth2/me` is still asked, for the owner's name only. Its answer is reported as `owner_access` (yes, refused or unavailable) and blocks nothing on its own.
- The workflow summary shows the owner lookup on its own row. The refusal message names both calls when both refused.

Tests: `node tools/portfolio/juicereel.test.js` (156, was 154). New: good credentials accepted where owner access is refused; an owner lookup failing alone refuses nothing. Both mutation-checked.

## 2026-10-22 — Juice Reel: check the credentials, finish the setup and connect without a terminal

**Juice Reel replied (2026-10-20) with a link to its quick-start.** The reply does not say in writing whether EdgeDesk's application is approved, or answer the question about fees. Juice Reel's sportsbook sync was built, tested and deployed on 2026-10-14, but the deploy's own health check showed two settings missing in Supabase: `SPORTSBOOK_SYNC_PROVIDER` (so no Juice Reel panel at all) and `PORTFOLIO_CREDENTIAL_KEYS` (so no token could be sealed). This change makes the remaining steps clicks. Docs: `docs/juicereel.md` § 0.

- **Is the application approved? Now it can be asked.** `jr_check` uses Juice Reel's documented owner access: one `GET /oauth2/me` with the application's own client id and secret, which answers for the app's owner. Accepted means the id, the secret and the approval are in order.
  - No reader is involved and no bet is read. Bets are still read only under a reader's own OAuth grant.
  - Only an operator, or a caller with the service key (compared in constant time), can ask; anyone else is refused before Juice Reel is called.
  - It answers a verdict (accepted, or `JR_CLIENT_REFUSED` with Juice Reel's HTTP status), the owner's display name and a setup checklist. It never returns the owner's id, the client id or the secret.
- **What is missing, by name.** The health check's `configured.juicereel.missing` lists each setting still needed. An operator whose panel reads "not configured" is told the same names; a reader is not.
- **Actions → Juice Reel setup** (`.github/workflows/juicereel-setup.yml`, manual), in three steps:
  - `check` — read-only.
  - `setup` — fills in `SPORTSBOOK_SYNC_PROVIDER=juicereel` and a fresh vault key **only where absent**. It never overwrites; it stops on a malformed key or a different provider. The key is generated on the runner, never printed, never stored in GitHub.
  - `start_live_test` — starts the PRODUCTION live test, so an operator can connect their own Juice Reel in the app (Portfolio → Accounts). It refuses if Juice Reel refused the credentials.
  - Nothing switches Juice Reel on for readers: that stays the live-test stages, the terms review and one SQL statement (§ 9).
- `tools/portfolio/juicereel_smoke.js probe` runs the same check.

Tests: `node tools/portfolio/juicereel.test.js` (154, was 140): the new checks run over the real migrations, and their auth was mutation-checked. Every Portfolio unit, SQL and Chromium suite was run again: all green except `sharpsports_ui.e2e.js` "a refresh says SharpSports is reading the book", which fails identically here without this change and passes in CI.

## 2026-10-22 — CFB referee flags: signed-in readers only; ESPN publishes no CFB officials

- **Security.** `supabase/cfb_refs.sql` granted anon select. That broke the CFB security contract (`football/cfb_production/security.test.js`: in `supabase/cfb_*.sql`, anon gets nothing but the settled-record views and the analytics writer), and the check went red on `main` with #681.
  - The referee tables and views are now gated like every other `cfb_*` table: select for authenticated only, and anon is revoked on tables and views.
  - Report row 5 checks this, and the SQL suite proves anon is refused.
  - Re-applying the file upgrades a database that took the earlier version.
- **The card** reads `cfb_game_ref_context` with the reader's own token. A signed-out visitor sees "Sign in to see the referee and that crew's flag tendencies" and no request is made. Signing in shows the block on the next render.
- **The ESPN backfill stopped again**, now sampling 2026, 2025 and 2024: 0 of 40 games verified. ESPN's CFB summaries carry only venue and attendance in `gameInfo`, with no officials anywhere in the response.
  - Nothing was filled.
  - Until ESPN lists officials, the Thursday/Friday assignment pull records nothing, and the Sunday finals carry no referee.
  - The evidence (`data/refs/cfb/backfill/`), which landed on the branch after the merge, is carried over.

Tests: `node football/cfb_production/security.test.js` (59, green again), `node tools/refs/cfb_refs_sql.test.js` (59), `node tools/refs/cfb_refs_ui.test.js` (37).

## 2026-10-22 — CFB referee flags on the Analyst pass (display only)

Display only: no model input, classification (INVESTIGATE / MONITOR / PASS), H-CFB-01, CLV grade or ranking of games changed or reads it.

- **Data.** `data/refs/cfb/`: 2,366 FBS games (2024–2026) with the crew-chief referee, accepted flags, holding (offensive / defensive), DPI / OPI.
- **Database.** `supabase/cfb_refs.sql`: the CFB twin of `nfl_ref_flags.sql`, with the same RLS and reader views. First run: `cfb-ref-sync.yml` with `apply_sql` and `seed`. Pregame assignments keep history: `first_observed_at` is never rewritten and a replaced referee keeps its row. A referee's conference is the dataset's mapping, never the home team's.
- **ESPN backfill.** It fills the 124 games with no referee, except the 13 `assignment_conflict` games. ESPN's Referee must first match the NCAA referee on 5 games, else it stops. **It stopped:** ESPN's summaries list no officials for these games, so nothing was filled. The evidence is in `data/refs/cfb/backfill/`.
- **Weekly.** `cfb-ref-sync.yml`: Sunday finals, Thursday and Friday pregame referees.
- **The card.** An Observed (T0) Officiating block on every CFB Analyst pass, with the NFL block's rows:
  - the season's flags and holding vs the conference average, then vs FBS;
  - a rank only with 3+ games;
  - 3-yr numbers with game counts;
  - "Conference unavailable" or "Assignment not announced" when that is the case.

Tests: `python3 -I tools/refs/test_cfb_refs.py` (27), `node tools/refs/cfb_refs_sql.test.js` (58), `node tools/refs/cfb_refs_ui.test.js` (34).

## 2026-10-22 — NFL referee flag tendencies on the game card

Display only. No projection, spread, total, probability, EV, grade, ranking or CLV logic changed, and nothing in those pipelines reads the new tables. README §NFL referee flag tendencies; the runbook is `data/refs/README.md`.

- **Officiating** in Market Structure → Observed on every NFL card: the referee and the assignment's source; this season's flags and holding per game against that season's league average (above in `--pos`, below in `--neg`), each with its rank of 17; the 2024–2026 baseline with its game count; the O/U record as a plain count. **Assignment not announced** when there is none. The referee's name is also a chip on the section summary.
- **Known limitations** gain three lines: one penalty per play from play-by-play; small current-season samples (the game count is shown); league-wide flags are up in 2026.
- **`supabase/nfl_ref_flags.sql`** (+ `migrations/20261022100000_nfl_ref_flags.sql`): two tables, three `security_invoker` views, and RLS gated like the card's other Observed tables.
- **`data/refs/upsert_refs.py`** is the one-time seed: 677 assignments, then 663 games, upserted on `game_id`.
- **`.github/workflows/ref-sync.yml`** runs Tuesday 10:00 UTC in season and on demand. It also takes first-run `apply_sql` and `seed` inputs.
- **Next week's referees** go in `data/refs/manual_assignments.json`. nflverse wins once it fills a game in.

Tests: `python3 -m unittest discover -s data/refs/tests` (17), `node tools/refs/nfl_ref_flags_sql.test.js` (39), `node tools/refs/ref_flags_ui.e2e.js` (21), all in `.github/workflows/ref-flags-tests.yml`.

## 2026-10-22 — The matchup card compares Kalshi at the model's time

These are display and labelling changes only. No model output, projection, fair line, ranking or research logic changed; the snapshot module and the committed research data are untouched. The rules and every judgment call are in `docs/KALSHI_NOTES.md`.

- **Matching timestamps.** The card compares Kalshi only with a quote taken within **15 minutes** of the model snapshot (`model.built_at`). `EDGameGraphic.kalshiAtModel` takes each market's `kalshi_price_snapshots` quote nearest that time, before or after it. Past 15 minutes the card reads **Kalshi price unavailable at model time** and compares nothing. Both times are always printed: `Model 2:04 PM ET · Kalshi 2:05 PM ET`.
- **Kalshi mid.** The price is `(yes_bid + yes_ask) / 2`, labelled **KALSHI MID**. A spread over 0.06 is unavailable, like rule 1.
- **The difference in words.** `9.5 PP HIGHER / LOWER` becomes one sentence naming the team: `EdgeDesk 9.5 pts higher on NE than Kalshi` (percentage points, before fees).
- **Large gap note.** At 7 points or more (`G.LARGE_GAP_PP`): `Large gap vs market. Checking injuries, QB status, and weather before trusting it.`
- **Home field, from the numbers.** The watch item no longer says home field is "more than the projected margin" beside a PK. The neutral-site margin is the projected margin minus home field, so NE at CHI reads `Home field is the whole game. Neutral site, NE is about a 3-pt favorite.`. A home edge that holds either way reads `Home field adds 3.1 pts to CHI’s edge.`
- **The rules live in the generator.** `G.content` checks every placed Kalshi price again against the model's time and the spread. A caller that hands it the latest price gets "unavailable at model time", never a comparison across times.
- **The research page** asks for Kalshi at the snapshot's model time (`window.fbKalshiAtModel`). A race where an older render overwrote a newer graphic is fixed.
- **The batch export** (`npm run game:graphics`) reads the quotes nearest each game's model time. It prints each game's comparison or why Kalshi is unavailable, and adds the template version (`__g2`) to file names so cards drawn by the old template are drawn again.

Tests: `node tools/football/game_research.test.js` (219), with section 14 new: timestamp matching, the unavailable state, the large-gap threshold, the difference sentence and home field. Also `node tools/football/game_research_ui.e2e.js` (57).

## 2026-10-22 — The matchup graphic compares EdgeDesk with the market, Kalshi included

- **EDGEDESK vs MARKET.** Where Kalshi has a trusted price, the market strip becomes a table. It has one column per market and three rows, so EdgeDesk and the market sit side by side.
  - **The rows:** EdgeDesk, unrounded; the market, with its source and time; the difference.
  - **The columns:** the live book's **spread** and **total**, then each team's **win % · ML**. The win columns show EdgeDesk's win probability and fair moneyline over Kalshi's YES mid and that price as a moneyline (e.g. `59.7%  −148` over `57.5%  −135`, then `2.2 PP HIGHER`).
  - **No live book:** the table is **EDGEDESK vs KALSHI**, the win columns alone.
- **Every difference is the two numbers above it.** EdgeDesk's row is its raw projection at one decimal, and the book's line is printed as received. A test checks every printed difference for every committed game, in three strip states.
- **The research page's Market comparison** adds the same EdgeDesk vs Kalshi table per team, with or without a live book. It states the snapshot time and that the differences are before Kalshi's trading fees.
- **Replaced from yesterday's change:** the KALSHI column and the Kalshi model-detail cell. Without a trusted Kalshi price, the market strip and the model detail are exactly as they were before Kalshi.
- **Merged separately (#675): the CFB production job registry** (`football/cfb_production/jobs.json`, and its seed in `supabase/cfb_production.sql`) carries capture's hourly schedules. `capture_cron.sql` moved them on 2026-10-21, and the registry drift check had failed on `main` since.

Tests: `node tools/football/game_research.test.js` (172), `node tools/football/game_research_ui.e2e.js` (55), `node football/cfb_production/tests.js` (122).

## 2026-10-21 — Kalshi on the NFL and CFB matchup graphics

- **Every NFL and college football matchup graphic now carries Kalshi's price** wherever Kalshi has a trusted one: each team's YES mid, as a whole percent.
  - With a live sportsbook quote, it is a **KALSHI** column after Spread, Total and Moneyline, behind a rule, with the snapshot time under it.
  - Without one, it is the third cell of **EdgeDesk model detail** (the model moneyline steps aside; the model's win probability is already in the panels). The note says Kalshi is a prediction market and every other number is EdgeDesk's own.
  - After kickoff it reads **KALSHI CLOSE**, the last price before kickoff.
  - The research page's Download PNG and Share carry it; so does `npm run game:graphics`.
- **Which team gets which price.** The sync links a game even when the book lists home and away the other way round (a neutral site), so a row's `home_team` never decides the side. `EDGameSnapshot.kalshi` resolves each market's YES team onto the snapshot's own teams with `lib/football_identity.js`, the resolver the sync links games with (now loaded by app.html). A team that does not resolve, an opponent on the same side, or two markets on one team place nothing.
- **Only what `kalshi_card_current` trusted.** A mid is drawn only from a row in state OK (fresh, YES spread at most 6¢). A side without one prints nothing; the other side is never derived from it. A game with no trusted price draws no Kalshi at all.
- **The research page** adds a fifth chip, **KALSHI** (priced · close · wide spread · stale · no market · unavailable · not deployed · teams unconfirmed), and a Kalshi row under Lab → Market diagnostics saying why a price is, or is not, on the graphic. The prices come from the game cards' Kalshi section (`window.fbKalshiRows`): one read, shared.
- **The batch export** reads `kalshi_card_current` once with the site's public key (anon sees Kalshi's prices, never the book fair), names each file with the Kalshi snapshot it shows, and draws model-only graphics if the read fails. `--no-kalshi` skips it.
- **The landing page stays model-only**, as its contract says (`lib/edgedesk_home_model.js`: no market price is read or shown there).

Tests: `node tools/football/game_research.test.js` (167: placing, refusals, the display rule, both strips, every projected game in both formats with Kalshi inside its boxes, the cache, the wiring), `node tools/football/game_research_ui.e2e.js` (53: the chip and the drawn graphic for a priced, a wide and an unlinked game), `node tools/kalshi/kalshi_ui.test.js` (40).

## 2026-10-21 — Odds API: nothing runs or buys more often than hourly

- **The rule.** No paid Odds API path runs, and no stored snapshot is refreshed, more often than once an hour. October's 100,000 credits went in 9.5 days on jobs that fired every 5, 10 and 20 minutes.
- **`supabase/odds_api_hourly_limits.sql` (new; paste it, or Deploy odds gateway applies it).**
  - Purchases: every gateway cadence band under 60 minutes becomes 60. The main markets inside 3 h of kickoff were 20. The constraint `odds_api_cadence_hourly_floor` refuses any band under an hour.
  - Schedules: capture near hourly at :12 (was every 20 min), day every 2 h at :04 (was hourly), board every 6 h; `player_props_dispatch` hourly at :38 (was every 15 min). Any other pg_cron job that can reach a paid path (`close` included) is slowed to at most hourly. Commands, and whether a job is paused, are never changed.
  - `select public.odds_api_schedule_audit();` lists every paid job and any that still fires more than hourly.
  - It does not turn the breaker on or off or change the budget, and it cannot slow a function that calls the provider itself. Only the gateway versions of `capture`, `close`, `collective_odds_ingest` and `props_cron` ask the gateway.
- **The gateway (`supabase/odds_api_gateway.sql`).** It seeds the same floor and carries the constraint. A snapshot within 2 minutes of its interval counts as due, so an hourly scheduler's drift does not halve the cadence. Report row 7 now reads hourly, and a new row 10 checks the floor.
- **The job files agree,** so re-applying them cannot bring a faster schedule back: `supabase/capture_cron.sql`, `supabase/player_props_cron.sql`, capture's `CADENCE_TIERS` (near 60 min, day 120), the props workflow's GitHub backup (every 2 h, was 30 min), and the recovery planner's schedule A.
- **The cost of the rule.** Within 6 h of kickoff a price can be up to an hour old, past the 45, 15 and 5-minute readiness limits, so capture reports those windows as aging, and the readiness state does not call such a price verified. Closing lines are the latest board, up to an hour before kickoff.

Tests: `ODDS_SQL_REQUIRED=1 node tools/odds/hourly_limits_sql.test.js` (36), `node tools/odds/gateway_sql.test.js` (74), `node tools/capture/capture.test.js`, `node tools/props/props_pipeline_sql.test.js`, `node tools/intelligence/odds_recovery.test.js`, `node tools/sql/split_sql.test.js`.

## 2026-10-21 — Kalshi: the layer applies over the starter schema

- **`supabase/kalshi_market_data.sql` now upgrades the starter `kalshi_schema.sql` in place.** On a database where the starter ran, it used to stop with an error. The starter's three views have other columns, and `create or replace view` cannot rename one. The starter's tables also lacked `kalshi_markets.title` and `kalshi_price_snapshots.run_id`, which `kalshi_sync` writes.
- **What the file does now.** It keeps the starter's tables and rows, adds those columns, and replaces the starter-shaped views, which hold no data. A new report row (10) checks it.
- **The cron file.** `supabase/kalshi_market_data_cron.sql` removes the starter's `kalshi_discover_daily` / `kalshi_snapshot_5m` jobs if they were scheduled; they carried the service-role key. Report row 4 checks it.

- **An unmatched game no book prices is no longer a warning.** Kalshi lists FCS matchups and weeks the odds capture has not reached. On the first live run, 440 of 508 game markets were unmatched, so readiness would have turned amber every college Saturday for games EdgeDesk never prices.
  - The sync now tells two cases apart:
    - `one_team_matched`: a book game on that date carries one of the two teams, so a name needs an alias.
    - `no_book_event`: no book prices the game at all.
  - It counts every reason (`details.unmapped_counts`).
  - It warns, and `kalshi_readiness.unmapped_settling_soon` counts, only for games a book prices.
  - Games no book prices are reported apart, as `unmapped_unpriced_soon`.
  - The function is `kalshi_sync@2026-10-21.2`. Redeploy it, and re-run `kalshi_market_data.sql`; it appends two readiness columns.

Tests: `KALSHI_SQL_REQUIRED=1 node tools/kalshi/kalshi_sql.test.js` (76, with the starter schema applied first as a fixture), `node tools/kalshi/kalshi_sync.test.js` (47).

## 2026-10-21 — Kalshi prices beside the book on NFL and CFB game cards

- **A new data source, not a model change.** No projection, ranking, threshold, EV flag, score, grade or CLV record reads it.
- **What is captured.** `supabase/functions/kalshi_sync` reads Kalshi's public market data (no key) every 5 minutes into `kalshi_price_snapshots`. Rows are append-only: never updated, never deleted.
- **What is compared.** Each NFL and CFB game-winner market is set against EdgeDesk's de-vigged book fair for the same team.
  - **Kalshi prices are Observed (T0, provider Kalshi).** The comparison is **Computed (T2)**.
- **Linking a market to a game.** A market is linked only when both teams and the date match exactly one book event in `public.signals` (`kalshi_game_links`, with a stored confidence).
  - Team names resolve through `lib/football_identity.js`.
  - The card's own id comes from `public.game_research_state`.
  - An event that does not match is left unmapped, with its reason.
- **The comparison views** (`kalshi_book_comparison`, `kalshi_book_closing_comparison`):
  - pair each snapshot with the nearest capture pass;
  - flag pairs more than 10 minutes apart;
  - exclude any market whose YES spread is wider than 0.06;
  - take the Kalshi close as the last snapshot before kickoff. Kalshi game markets trade in-game and their `close_time` sits about 48 h after kickoff.
- **On the card.** A **Kalshi** section sits beside Market Structure. It shows each team's YES mid, spread, volume and last snapshot time, plus the gap against the book fair labelled as derived. A game with no match, or a wide, one-sided or stale market, reads as visibly inactive. The Known limitations are on every surface.
- **In System health.** `kalshi_readiness` adds the sync state, the last successful snapshot, close capture over 7 days and unmatched game markets. Failures and degradation are alerted as they are for the NBA injury sync.
- **Access.** Every view runs as the reader, so the book fair stays behind `signals`' own subscription rule.
- **Deploying it.**
  - Run **Deploy Kalshi market data** (`.github/workflows/deploy-kalshi.yml`), or paste `supabase/kalshi_market_data.sql` then `supabase/kalshi_market_data_cron.sql`.
  - Set `KALSHI_CRON_SECRET` and the Vault secret `kalshi_cron_secret`.
  - Discover once, then set `tracked = true` on `KXNFLGAME` and `KXNCAAFGAME`.

Tests: `node tools/kalshi/kalshi_sync.test.js` (45), `KALSHI_SQL_REQUIRED=1 node tools/kalshi/kalshi_sql.test.js` (66), `node tools/kalshi/kalshi_ui.test.js` (34).

## 2026-10-20 — Model Collective: a removed member leaves the public Collective

- **A member removed from the admin page no longer shows in the model directory.** Removal stamps `removed_at` on the creator row and keeps the row and their model, and the directory (`model_wall`) never checked either, so JadedBettor(Murse2.0) stayed listed as "MEMBER, first submission pending" after being removed. `collective_public` now leaves removed members out of the wall and directory, their profile and model pages (now a 404), the rankings, the activity feed and the creator and model counts. When a removed member ranked ahead of others, each model below moves up one place per removed model ahead of it in the same league, and ties stay ties. Their stored submissions and grades are kept, as the removal promises. Clearing `removed_at` (`supabase/collective_restore_access.sql`) brings them back.
- **This takes effect once `collective_public` is redeployed.** Paste `supabase/functions/collective_public/index.ts` into the dashboard (or `supabase functions deploy collective_public --no-verify-jwt`). No SQL to run.
- **`collective_public` now deploys from GitHub Actions** (`.github/workflows/deploy-collective-public.yml`), so it no longer has to be pasted into the dashboard. Before deploying, the workflow downloads the live copy and compares it with every committed version of the file. If someone edited it in the dashboard, the workflow stops, unless `force` is set. It lists every line of code in the live copy that the repo copy lacks (`tools/collective/deployed_drift.js`, which ignores comments and whitespace) and prints the start of the full diff. After deploying it checks that `/v1/meta`, `/v1/wall` and `/v1/rankings` answer, and puts the previous copy back if they don't. Run it from the Actions tab with stage `check` or `deploy`, or push to a `claude/**` branch with `[collective-public:deploy]` in the commit message.

Tests: `node tools/collective/removed_members_api.test.js` (18), `node tools/collective/football_api.test.js` (14).

## 2026-10-20 — The Desk: a short answer you can act on, follow-ups from the research, the site's colours

- **The answer to "What's the best researched opportunity tonight?" leads with a short list, not the research packet.** The multi-sport desk's answer was the full packet: every gate, sigma, source and coverage line, followed by stale market-benchmark cards (Knicks and Spurs quotes 14,337 minutes old). It now opens with (`msBriefHTML` in app.html):
  - the bottom line ("No bet clears every check tonight."), what #1 needs to become a bet, and why no bet cleared;
  - the top three games worth researching, each with the model's side and probability, **the price to bet at** ("Bet only at −149 or better"), what to confirm first ("Confirm both starting goalies"), the strongest edge and the strongest point against it, and buttons for what to check, why it is listed, and the sport engine's full breakdown. The rest of the list is one tap away;
  - the closest priced market (the market watch, with the price it needs) and any prices that look wrong (data checks);
  - follow-up questions to tap.

  The full packet, the coverage and the market benchmark fold underneath, unchanged. A market benchmark that passed the captured-price audit is still called out at the top and its card stays open: it is market-derived, said as such. Every number is the server's (`d.multisport`); nothing is recomputed or re-ranked in the browser.
- **Follow-up questions are answered from that research** (`msFollow`): "Why is #1 ranked first?", "What should I check before betting the Vegas game?", "Is the goalie confirmed?", "Should I bet Vegas at −150?", "Compare #1 and #2", "Which game is closest to a bet?". A game can be named by rank ("#2", "the second game"), team, nickname or city; a question that names no game stays on the game under discussion ("what should I check first?" is not read as #1), and a sportsbook named in it ("at DraftKings") is not a new subject. Questions that name teams or players not on the list, contract prices, coverage questions and a fresh "best opportunity" question still go to the server as before.
- **The Desk uses the site's colours.** The panel had its own indigo-and-citron palette. Its tokens (`--desk-*`) are now aliases of the app's `--bg`, `--surface`, `--border`, `--text` and teal `--accent`, so the panel matches the rest of EdgeDesk and follows any change to `:root`.

Tests: `tools/intelligence/quant_ui.e2e.js` (89, with the short list, the folds and nine follow-ups at both widths), `tools/intelligence/intel_ui.e2e.js` (158), `tools/intelligence/desk_ui.e2e.js` (71, the palette now asserted to be the site's).

## 2026-10-20 — NBA: the football graphic on every game, every game linked from Today's Games, research kept after tip

- **Every NBA game page opens with the matchup graphic football and the NHL have** (`lib/edgedesk_nba_graphic.js`, drawn by `lib/edgedesk_game_graphic.js` on a court): square or portrait PNG, with Download, Share and Copy link. The three numbers to set against a sportsbook lead it:
  - the fair spread with the model win probability, the projected score (each team's expected points, overtime included) and the fair total;
  - DraftKings via ESPN when captured in the last three hours and before tip, labelled a reference: the book's spread, total and moneyline, the no-vig split, and the gap from the fair line ("Spread: EdgeDesk 4.0 pts toward DET"); otherwise EdgeDesk's 80% margin range, model moneyline and overtime chance;
  - what to watch for (each offence against this defence, the model's largest matchup factor, rest or pace, who is playing), the research grade, and "early season" while it applies.

  Nothing on it is re-estimated. The data, model and market status now folds under the game instead of leading the page.
- **Every NBA game on Today's Games links to its research.** NBA games said "Research not available yet" although the NBA panel priced them; all 15 games the slate priced now link to `#research/nba/<id>`. Their matchup view shows the NBA panel's fair moneyline, spread and total; it used to show the lab model's (DET −107, total 216 against the panel's DET −118, 218.5 for BOS @ DET).
- **Started games keep their research.** The slate drops a game three hours after tip and prices it again before that. Each build now moves started games, exactly as priced before tip, to `nba/recent.json` for 96 hours; the panel lists them under their own heading and Today's Games links live and final games to them. `build_slate.js --check` refuses a game frozen at or after its start. No game has tipped yet this season, so the first file is empty.

Tests: `node tools/nba/nba_graphic.test.js` (236), `tools/nba/nba_ui.e2e.js` (74), `node tools/slate/build.test.js` (63), `tools/slate/games_ui.e2e.js` (105), `tools/engine/engine_ui.e2e.js` (134), `node tools/hockey/nhl_graphic.test.js` (394), `node tools/football/game_research.test.js` (125).
## 2026-10-20 — An open tab picks up a new deploy by itself

- **Why.** app.html is a single page: moving between games, sports and tabs never reloads it. A tab opened before a deploy kept running the old code until it was reloaded by hand. After the NHL release went live, a phone kept showing the garbled Grade Breakdown and no graphic.
- **What.**
  - `/app-version.json` holds a hash of app.html and lib/ (`tools/app/app_version.js`). `.github/workflows/app-version.yml` restamps it whenever either changes on main; the data jobs never change it.
  - `lib/edgedesk_update.js` reads it when the page loads, when the tab comes back into view, and every ten minutes. When the deployed version differs:
    - if the reader has just come back to the tab, it reloads at once;
    - otherwise a bar says "EdgeDesk was updated" with a Reload button, and the next screen change or return to the tab reloads.
  - The route survives the reload. There is one reload per version, so a stale cached copy cannot loop.
- **Tests.** `node tools/app/app_update.test.js` (18, with a simulated tab), run in `slate-tests.yml`.

## 2026-10-20 — NHL: the football graphic on every game, research for every game, a readable Grade Breakdown

- **The Grade Breakdown was unreadable on every board.** Its summary paragraph used the class `edg-x`, which the help guide also uses for its 34×34 px close button. The guide's styles squeezed the paragraph into that box at 18 px, so the text overlapped the rest of the breakdown. It is now `edg-expl`, styled inside `.edg-bd` only. A sub-factor's "unvalidated" no longer runs off the right edge at phone width.
- **Every NHL game page opens with the matchup graphic football has** (`lib/edgedesk_nhl_graphic.js`, drawn by `lib/edgedesk_game_graphic.js`): square or portrait PNG, with Download, Share and Copy link. It shows:
  - the fair moneyline, the projected score (expected goals including overtime) and the fair total;
  - DraftKings via ESPN when captured in the last three hours, labelled a reference; otherwise EdgeDesk's puck line, overtime chance and 60-minute result;
  - what to watch for, from the model's own factor decomposition and the goalies;
  - the research grade.

  Nothing on it is re-estimated. The data, model and market status now folds under the game instead of leading the page.
- **Started games keep their research.** The NHL slate lists upcoming games only, so a game lost its research page at puck drop. Before this change 19 of the 45 NHL games on Today's Games had no research; with this change all 45 link to research. Each build moves started games, exactly as priced, to `hockey/recent.json` for 96 hours. The first file was backfilled from the committed slate history (21 games). `build_slate.js --check` refuses a game frozen at or after its start.
- **Grades right after each NHL build.** GitHub ran the hourly grade job two to eight hours apart, so newly added games waited for a grade (7 of 37 ungraded). `performance.yml` now also runs when the NHL build finishes.
- **The football graphic, portrait only:** "what to watch for" text that ran past its row (33 of 174 committed graphics, 20 of them past the panel's edge) now steps down a size to fit. Square graphics are unchanged, compared instruction by instruction.

Tests: `node tools/hockey/nhl_graphic.test.js` (394), `npm run nhl:test`, `npm run grades:test`, `npm run game:research:test`, `tools/engine/engine_ui.e2e.js` (134).

## 2026-10-19 — The desk: data-first articles in my voice, my take required, every number traced

AI summaries answer a generic game preview without a click; they cannot answer my own logged numbers or a person accountable for them. The audit is `docs/desk/AUDIT.md`; the guide is `docs/desk/README.md`.

- **Five article types built only on owned data** (`tools/desk/generators.js`): Weekly CLV Report, Where My Number Disagrees, Line Movement Recap, What I Got Wrong, Research Notes. First person, no em dashes, losses printed like wins. Each refuses, with its reason, when the data is not there (CFB disagreements and CFB line moves for now).
- **Every number traced.** Printed only through a stored query against a committed file (`lib/edgedesk_desk.js`); the verifier re-runs every query and refuses any number typed by hand. `data_snapshot` keeps each file's digest and commit, and `tools/desk/verify.js` re-derives a draft at that commit. This season's six sample drafts re-derive 2,676 values.
- **Drafts never publish themselves.** `public.article_drafts` is append-only; the publish gate is a database trigger that refuses an article without "My take" of the minimum length (240 characters by default) and a draft that failed its own checks (`supabase/desk_articles.sql`, 57 checks on a real PostgreSQL).
- **The editorial pipeline is held to the same rule.** Its publisher now holds every NEW pregame and postgame article until a take is on file, and each run releases what a new take unblocks. Pages already published are untouched. It fails closed: no takes readable, nothing new published. Off switch: the desk's Settings tab, or the repository variable `EDGD_REQUIRE_MY_TAKE=false`.
- **Notifications.** `desk_cron` (pg_cron, `x-cron-secret`) wakes the drafting job daily and tells me about new drafts every 30 minutes by Discord DM, an owner-only webhook, or the terminal badge alone; claim before send, never twice.
- **Author and trust layer on every article.** My name, bio, "Data as of", a link to my live CLV record and an author box; JSON-LD `Person` author on every article, `Dataset` on desk pages with tables; `/articles/author/davis-rackler/`; `/articles/desk/`. The photo is mine to add at `assets/author/davis-rackler.jpg`.
- **Owner desk** (`/admin/desk/`): drafts with every number's query, My take, Publish, game-article takes, a distribution kit (X, LinkedIn, Discord, Reddit; UTM-tagged by channel and article; each post quotes the lead number and links the published page; Reddit body link-free), Article Performance ranked by paid conversions with Discord and Reddit as channels, and settings.
- **Found, reported, not changed** (the grading layer is frozen): on 17% of graded model rows the P&L ledger's `clv_points` has the opposite sign from the football model record, which is why `/record.html` shows NFL "Avg CLV" -1.11 against the model record's +0.51. Details in `docs/desk/README.md`.

## 2026-10-19 — NFL Market Structure: key numbers, the Thursday freeze, situations, Circa ownership; four studies registered EXPERIMENTAL

A Market Structure section on every NFL card and a Drift strip above the board. It is made of T0 observations and T2 transforms of data EdgeDesk owns, plus four preregistered EXPERIMENTAL studies. **No projection, spread, probability, EV, ranking or grade changes.** The full slate rebuilt from the old and new `app.html` agrees on all 111,060 values across 180 games and 32 teams, and the browser suite reads all 16 cards line for line on both. The design and deploy steps are in `docs/market-structure/README.md`.

- **Key numbers (T2).** The margin distribution of 7,368 settled games (full history and 2023+, absolute and favourite-signed) drives `half_point_value(line, window)` in SQL, held equal to the JS at every half point.
  - Each card says which key number its line sits on or straddles, and carries a Six watch.
  - A six-point favourite win is 3.6% of games overall and 4.6% since 2023.
- **Drift.** The two-point try share from play-by-play is 9.2% in 2026 against 9.5% in 2023–25 (z −0.18, stable). Rising two-point attempts are not in the data this season.
- **The Thursday freeze (T0 + T2).** `nfl_line_snapshots` holds the consensus main line at Thursday 1 PM ET, read from capture history. The card shows the move to now and to the close, flags a move of a full point or one that touches 3/6/7/10/14, and shows the CLV of the frozen price on the side the market moved toward.
  - Injury timing is **Coming Soon**: nflverse publishes no change times for 2026.
- **Situations.** The card marks favourite/underdog, home/road/neutral, divisional (a seeded `nfl_team_divisions`) and divisional home dog. It shows the season-to-date ATS record of each bucket with its n and interval.
- **Circa Million ownership (T0).** The `circa_ownership_sync` edge function ships with pg_cron on Saturday and Sunday mornings. A failed read publishes nothing; unresolved picks are quarantined and the week shows as PARTIAL.
  - **Not yet verified against a real Circa PDF:** the build environment could not reach circasports.com.
- **Studies.** H-NFL-KEY-01, H-NFL-STALE-01, H-NFL-OWN-01 and H-NFL-DIV-01 are in `football/market_structure/preregistration.json` (sha256 pinned). Each has its windows, minimum sample, metric, decision rule and forking-paths disclosure.
  - The registry SQL reads the live registry's columns rather than assuming them, and writes no result row.

## 2026-10-19 — CFB: one home field for learning and projection (`edgedesk_cfb_p4_v1.0.1`)

The root cause the CFB audit found, fixed at its source and tested walk-forward. The report is `docs/cfb-calibration/README.md` ("The root cause, fixed").

- **The fault.** The engine's rating update learned every home result against 3.2 points (`rating.hyperparams.hfa`), but every projection added 4.082 (`venue.league_hfa`). The python trainer uses one value for both, and the shipped seeds were built that way: a cold replay under 4.082 reproduces all 136 seeds to 0.0001. The JS update had drifted from it.
- **The fix.** One value for both, chosen walk-forward: each season takes the value whose cold replay had the lowest spread error over the four seasons before it. For 2026 that is **2.8** (from 2022–25), with the seed ratings rebuilt under it. It ships as a generated file, `football/cfb_p4/home_field.js`, which applies only to the `params.js` it was built for.
- **The evidence.** Out of sample, 2014–25 (n 8,724):
  - spread MAE −0.052 (95% CI −0.082 to −0.021), better in 11 of 12 seasons;
  - Brier −0.0010 and log loss −0.0024, both intervals below zero;
  - the home lean against the close falls from +1.27 to −0.31 points.
  - The result holds for every trailing window from 3 to 8 seasons, and no week, conference or margin segment is significantly worse. It passes the repo's pre-declared bar (≥ 0.05 MAE, better in most seasons), narrowly.
  - Simply matching the trainer (4.082 for both) is worse than today.
- **The unseen season.** 2026 (386 games, production's exact frame) cannot confirm or refute the gain yet: MAE +0.027 (CI −0.059 to +0.091), log loss −0.0020 (CI −0.0053 to +0.0011). The home lean against the close falls from +1.49 to +0.20.
- **What changes.** New home-game margins move about 1.3 points toward the visitor.
  - New projections carry `edgedesk_cfb_p4_v1.0.1` on the slate row, the record and the performance ledger. No published pick or grade changes.
  - The Model Lab keeps V1's identity and logs the change as a calibration change.
  - The freeze row is `edgedesk_cfb_r1+p9`, and the board and its test harness load the file.

## 2026-10-19 — Calibration across the other sports: college basketball's neutral-site pricing fixed; NHL, NFL, NBA, WNBA and baseball left as they are

The CFB audit's method, applied to every other model that publishes a probability. The report is `docs/sports-calibration/README.md`.

- **College basketball (NCAAM, NCAAW): fixed, as calibration v2 (`bb_cal_v2_home_intercept`).**
  - **The fault.** The calibration fitted its moneyline and margin intercepts on home and neutral games pooled, then applied them at neutral sites where the ratings' home edge is already 0. Every neutral-site game was priced 3–4 points of probability short for the side listed at home.
  - **The fix.** The intercepts are now a home-game correction only.
  - **The evidence.** Walked forward on the three prior seasons, log loss improves in both windows of both leagues, every 95% interval below zero. That holds in 14 of 15 seasons in each league and in every favourite bucket, and margin error improves too. WNBA and the NBA fallback are unchanged.
  - **Versioning.** The slate's model id carries the version, so the record splits on it. A v1 params file still prices exactly as before.
- **NHL: no change.**
  - Win probabilities are calibrated (2021–26 slope 1.064). Extra recalibration walked forward does not help.
  - Total-goal probabilities have slopes of 0.72–0.78, but no correction improves them out of sample: the log-loss-optimal compression is about the current one, and fixing the slope worsens log loss. The totals simply carry little signal.
- **NFL: no change, monitor.** The model leans about 0.9 pt more to the home side than the close. But in 2022–25 home teams won by 2.20 (se 0.43) against the model's 2.48 and the market's 1.61, so correcting it would only move the number toward the sportsbook.
- **NBA:** sealed 2018–26 test slope 0.999, no change.
- **WNBA:** win probabilities fine. 2026 totals ran 4.1 pts low, and the season is over.
- **MLB, college baseball:** no live probability is published. College baseball's moneyline is calibrated.
- **Two test fixtures that `main`'s committed data had broken:**
  - the NHL engine UI's second-game total now gets the same 4.5% margin as the moneyline;
  - the Mahomes benchmark accepts a week when Kansas City is on the card.

## 2026-10-18 — CFB calibration: the season audited, every fix tested walk-forward, a home-field correction kept in shadow

**No published CFB number changes.** The research and diagnostic report is `docs/cfb-calibration/README.md`; every table is in `football/cfb_p4/research/report/LIVE_CALIBRATION.md`.

- **The season (410 graded games, weeks 2–7) does not show broad overconfidence.**
  - The 90%+ picks won 92.1% against 95.7% predicted (n 76, inside the interval).
  - FBS-vs-FBS margins are not too spread out: the slope of actual on predicted is 0.96 (se 0.06).
  - Refitting sigma barely moves Brier (0.1655 → 0.1653).
- **Two systematic errors were measured.**
  - Home field is applied inconsistently. Ratings learn against 3.2 points, projections add 4.082, and outcomes since 2015 fit about 2.6. The model leans 1.9 points to the home side against the close, and does so every week.
  - FBS-vs-FCS games price every FCS opponent at one floor, so predicted 21+ favourites beat the model by 8.6 points.
- **Disagreement with the line observed at publication has no measurable value for results** (slope 0.09, se 0.28).
- **Every fix was tested walk-forward on 250 unseen games.** Options were global shrinkage, a publish-time market blend (with w by disagreement and by margin size), a sigma refit, probit-Platt, isotonic and a 95% cap, each fitted only on games final before each pick was published.
  - No option's Brier interval excludes zero, except isotonic's, which is significantly worse.
  - The blend's fitted model weight is about 0.1, so it publishes the sportsbook line.
- **The pre-registered home-field correction is the best candidate, and it ships in shadow.**
  - `cfb_margin_cal_v1`, fitted on 2015–2025 only: Brier −0.0015, log loss −0.006, better in 3 of 4 weeks.
  - Every slate row now carries `calibration_shadow` (margin, sigma, win probability from one equation) and `model_version`.
  - It needs about 3,150 unseen games to confirm an effect this size, so it stays unpromoted.
- **Promotion is versioned and switched by a person.**
  - It requires `promote: true` in `football/cfb_p4/live_calibration_config.json` AND a VALIDATED record from `npm run cfb:livecal:write`.
  - New projections would then carry `edgedesk_cfb_p4_v1.1.0`. Published picks and grades are never rewritten.
  - The pricing-path change is declared as `edgedesk_cfb_r1+p8`. A side-by-side slate build gave identical numbers on all 59 games.
- **Tests:** `npm run cfb:livecal:test` (also in the new CFB live calibration tests workflow).

## 2026-10-18 — Discord: the model's daily results also post in #clv-results

**Each morning's results post (how EdgeDesk's pregame numbers did yesterday, every game) now also goes to #clv-results**, one post per sport, next to the weekly CLV scorecard. It uses the existing `DISCORD_WEBHOOK_CLV_RESULTS` webhook, so no new secret is needed.

- **The same post.** The embeds are the ones the sport's channel gets, from the `/performance/` record, misses printed like hits.
- **The same timing.** It goes out at the 10:00 CT slate tick, or at 10:30 when a final from yesterday is still unverified.
- **Claimed on its own.** Its key is `results:DISCORD_WEBHOOK_CLV_RESULTS:<sport>:<date>`, so a failure in one channel never holds or repeats the other.
- **Deploying.** The posts change only once the function is redeployed (the Deploy Discord posts workflow). No SQL change.

## 2026-10-17 — Discord: the football slate prints half-point lines

**The daily NFL and college football Discord slates now print EdgeDesk's numbers the way the site does**, from the same code (`lib/edgedesk_football_lines.js`, now copied into `supabase/functions/discord_cron/index.ts` by `tools/presentation/inline.js`).

| | Before | Now |
|---|---|---|
| Memphis @ Tulane (CFB) | `line Memphis -4.8 · proj Memphis 28.1, Tulane 23.4 · total 51.5` | `line Memphis -5.0 · projected score Memphis 28, Tulane 23 · total 51.5`, then `Key number: Market sits on 7; model is below 7.` |
| Steelers @ Bengals (NFL) | `line Bengals -4.6 · proj Steelers 19.3, Bengals 23.9 · total 43.1` | `line Bengals -4.5 · projected score Bengals 24, Steelers 19 · total 43.0` |

- **Gaps.** Every gap still reads the unrounded projection, in the site's tenths. The Bengals total prints "1.4 lower than the book" (43.1 against 44.5), not 1.5.
- **Notes.** The rounding note, the score note and the key-number explanation each appear once in a post's description, and only when a game in it needs them.
- **Copy check.** It refuses "pick" in any form, so a key note about a zero line says "at PK".
- **Other sports.** NBA, CBB and NHL are unchanged.
- **Results and samples.** The results recap grades against the final and stays unrounded; the samples post no fair line.
- **CI.** Discord posts tests now also run on a change to the utility, and check that the function's copy has not drifted from it.
- **Deploying.** The posts change only once the function is redeployed (the Deploy Discord posts workflow).

## 2026-10-17 — CFB Altitude & Travel: every game's climb, measured and explained; the adjustment tested and kept in shadow (0.0 pts)

**From the next slate build, every FBS game carries an Altitude & Travel research section, and nothing it says moves a number.** Notre Dame at BYU reads: LaVell Edwards Stadium 4,633 ft, Notre Dame normally 731 ft, +3,902 ft, about 1,325 miles and two zones west. Statistical support: Not established. Validated model adjustment: Research only. Impact on EdgeDesk's number: 0.0 pts pending validation (`docs/cfb-altitude/README.md`).

- **The answer to "does accounting for altitude improve EdgeDesk's number?" is no, on this evidence.**
  - Conditional on V1's own pregame margin, visitors climbing 3,000+ ft did +1.03 pts worse than other visitors (SE 0.62, 13,511 games, 2006–2025). The interval includes zero.
  - Chosen on 2014–2021 and scored on 2022–2025, the adjustment made the 139 games it touched slightly worse (MAE 12.905 → 12.924, p = 0.55). The permutation placebo p is 0.66.
  - V1 already over-credits home field by 1.26 pts on average and is about right at mountain venues, so an additive altitude term would double count.
  - The record: `docs/cfb-altitude/BACKTEST.md` and `football/validation/altitude_cfb.json`, against gates declared before the first fit (`football/altitude/research/gates.js`).
- **The research package was re-verified, not copied.**
  - −1.19 (SE 0.77) for 3,000+ ft and +0.64 (SE 0.65) for 6× confirmed.
  - Its `<1,000 ft` bucket mixed descents with level trips, and 59% of its 6× games gained under 1,000 ft. Its time zones ignored daylight saving, and its openers were dropped.
- **A venue elevation registry** (`football/altitude/venues.json`): 326 venues by stable venue id, each with sources and HIGH/MEDIUM/LOW confidence.
  - The provider attaches a team's *current* stadium geography to legacy venue ids (Hughes Stadium carried Canvas Stadium's elevation, Sam Boyd carried Allegiant's). The schedule now decides which id is current, and legacy ids never inherit a successor's elevation.
  - A missing elevation is shown as unavailable, never imputed.
- **One definition** (`football/altitude/engine.js`) serves the research harness, the slate build, the page and the desk. It covers:
  - the venue the schedule names, and each team's normal venue that season;
  - signed and positive gain, buckets that keep a descent apart from no gain, and the ratio (descriptive only);
  - miles, DST-correct time zones (Indiana before 2006 included), rest, and two acclimatization proxies.
- **Shadow behind three locks.** V1's new `altitude exposure` term is 0 unless:
  - `football/altitude/params.js` is VALIDATED, with points_applied, AND
  - the guarded flag `cfb_altitude_adjustment_enabled` is on. It is read fail-closed, and the engine re-checks the locks.
  - The same offline slate build with and without this change gave identical numbers on all 108 games.
- **Surfaces:**
  - the research page section (tested in Chromium at 390 and 1280 px);
  - Ask EdgeDesk's travel and altitude facts. These are sourced, and the shadow number never reaches the desk;
  - the explanation boundary, which names altitude only when the facts carry it;
  - `lib/edgedesk_canon.js`, where the module is SHADOW with pricing impact NO.
- **Database** (`supabase/cfb_altitude.sql`, applied after `cfb_production.sql`): an append-only pregame shadow ledger whose check constraints are the locks, the registry, validation runs, a monitor view, and the switch, declared OFF. Removal: `supabase/altitude_shadow_rollback.sql` (`docs/cfb-altitude/ROLLBACK.md`).
- **Monitoring** (`football/altitude/monitor.js` → `monitoring.json`, in `football-enrichment.yml`): CRITICAL if any point moves without validation, coverage, and the 2026 prospective shadow record.
- **Tests:**
  - `football/altitude/altitude.test.js` (131 checks), `desk.test.js` (19), `sql.test.js` (52, real Postgres), `ui.e2e.js` (40, Chromium);
  - all registered in `cfb:test` and `.github/workflows/cfb-altitude-tests.yml`.

## 2026-10-17 — Football lines: half-point fair spreads and totals, whole-number projected scores, gaps from the unrounded projection

**EdgeDesk's NFL and college football numbers now print the way a sportsbook prints them.** For example, Texas Tech −20.7 prints as −20.5, a 52.4 total as 52.5, a 49.9 total as 50.0, and a zero spread as PK. Indiana −2.5 and Bowling Green −12.0 stay as they are. The model's own numbers are untouched: every gap, EV, cover probability, grade, calibration figure and record still reads the raw values (`docs/system-integrity/FOOTBALL_LINES.md`).

- **The utility** (`lib/edgedesk_football_lines.js`, `EDFootballLines`, policy `football_half_point_v1`) is the one source for:
  - half points, halves away from zero, symmetric in sign, with the raw number read at the published hundredths;
  - PK, and whole-number projected scores labelled "Projected score";
  - sportsbook lines printed as received (`−6.75` stays `−6.75`);
  - the gap, computed in EDCalc's tenths from the unrounded projection, so a printed gap is always the one the research and decision layers classify;
  - the rounding note: "Fair lines rounded to nearest half-point; differences use unrounded projections."
- **Key numbers.** A short note says when the model's line and the market's sit on opposite sides of 3 or 7, or one lands on it: "Market is below 7; model is above 7.", "Model favors Indiana outright; market gives Indiana more than a field goal."
  - Further margins are configurable per league; none ship by default.
  - The note adjusts no probability and claims no key-number frequency.
- **Applied to:**
  - the game research page, its snapshot (`model.display`, checked by `display_from_raw`), the share graphic and the landing page;
  - the football board, cards, overview and cockpit (`app.html`), the CFB research view, the CFB research terminal and its page, the decision cards and the home board;
  - the briefs that feed articles, editorial, the newsletter and the presentation layer;
  - the content engine and its Edge Function, the newsletter, the press brief, and the AI desk (its Edge Function now inlines the utility).
- **Raw and display stay apart.**
  - New raw fields sit beside the display: `fair_spread_raw_text` (now on NFL briefs too), `margin_raw`, `total_raw`, `model_raw`, `total_model_raw`, `fair_text_precise`, `precise_line_text`.
  - Editorial grading, the implied over/under side and the performance build read the raw total.
  - A record built before this policy grades exactly as it did.
- **Integrity rules, versioned.**
  - `CALC.GAP_RECONCILES` accepts the half-point fair line and the market line as received. It still requires the raw gap, and requires the rounding note when the printed lines do not reproduce that gap. The −1.0 near-pick'em floor is still blocked.
  - `PROJ.SCORES` accepts whole-number scores tagged with the policy.
  - The content engine's gate and the newsletter validator admit the packet's own half-point line and whole numbers, and nothing else.
- **Nothing is rewritten.**
  - No ledger, record, published article or committed artifact was regenerated.
  - Frozen snapshots and history specs carry no display block and redraw with the numbers they were published with.
  - The scheduled builds pick the display up on their next run.
- **Verified**, building HEAD and this change at the same clock:
  - all 135 game-research snapshots keep every raw model field;
  - the probability sheets are byte-identical;
  - the CFB terminal's decisions, record, EV and Read outputs are identical;
  - all 56 editorial audits re-grade identically;
  - the content engine's 66 packets keep every number.
- **Tests:**
  - `tools/football/football_lines.test.js` (77) covers rounding in both signs, quarter-point ties, PK, totals, missing data, favourite flips, key-number boundaries, configuration, and parity with EDCalc's gaps;
  - existing suites were updated where they pinned the old one-decimal text.
- **Not yet on the policy:**
  - the machine CSV/XLSX exports, which stay raw (Collective uploader contract);
  - Discord;
  - the other AI modules' raw `fmtLine`;
  - the card feed, performance pages, linemaker desk and the CFB v2 shadow display.

## 2026-10-16 — The A–F Research Grade, locked before kickoff, and Grade Performance: how the grades held up

**Every game EdgeDesk researches now carries an A–F Research Grade:** how complete, current, cross-checked and reliable the pregame research is. It is not a win probability, not a prediction and not a betting recommendation. Research, not picks. See `docs/research-grade/` (AUDIT_AND_PLAN, METHODOLOGY, RUNBOOK).

- **The audit** (`docs/research-grade/AUDIT_AND_PLAN.md`) found the inputs already in the projection contract (EDPROJ), a CFB-only reliability score, three different "research grade" names already in use, and a same-day cross-sport performance ledger that already settles finals and computes Brier, calibration and MAE. Nothing is duplicated:
  - the grade reads EDPROJ and, for CFB, `lib/cfb_reliability.js`'s own score;
  - its snapshots and outcomes are two new streams in the existing hash-chained ledger;
  - its settlement reads the existing results stream and grades with `EDPERF.gradeGame`; its dashboard runs `EDPERF.metrics` per letter.
- **The kernel** (`lib/edgedesk_research_grade.js`, EDGRADE): a deterministic 0–100 score from five dimensions with provisional, versioned weights (reliability 30, completeness 25, model–market 20, clarity 15, uncertainty 10), sport adapters for NFL, CFB, NBA, NHL, WNBA and college basketball, and a plain-English explanation.
  - Nothing missing earns credit; a missing input scores 0 and is named.
  - An unvalidated live track record and a missing pregame sportsbook line are excluded and capped (C and B); unknown key-player availability caps at C.
  - Gates give "Not graded" (no model number, an expired or invalidated build, a market-fed model, too little data, anything after kickoff).
  - The live track record is read as of the grade's own moment; a line captured after the start or after the grade is dropped.
  - Every stored grade re-scores from its own inputs: the job refuses a row that does not, and `run.js --check` re-scores every committed one.
- **The hourly job** (`tools/performance/research_grades.js`, `grade_build.js`) locks a new grade revision whenever the letter, the score, a part, a cap or gate, the forecast or the evaluated side changes (a pure line move is kept by the quote ledger, not a new grade); judges each verified final against the game's latest valid pregame grade; never grades a game that had none; writes `performance/data/grades/` and folds its health items into `health.json`. ATS and O/U records use only the side and line saved before kickoff; CLV only a same-source close.
- **The boards** (`lib/edgedesk_grade_ui.js`, `lib/edgedesk_grade.css`), terminal only: a compact badge on Today's Games, the FBS board, NFL cards and the NBA and NHL boards; a letter filter on Today's Games and the FBS board (kept in the URL as `fbs_grade`); an expandable Grade Breakdown in the matchup view, the NFL/CFB game view, the P4 game card and the NBA/NHL game views; the guide's "Research Grade (A–F)" entry on tap. `/today/` is unchanged.
- **Grade Performance** (`/performance/grades/`, public): totals, coverage, distribution, a grade-by-grade table (settled games, average score, Brier with 95% interval, calibration, margin and total MAE/RMSE, model agreement, completeness, records at the saved line, CLV, sample state), Brier and error by grade, calibration and trend small multiples, sport breakdowns, exclusions, filters (sport, league, season, dates, model version, grade version, market type) and the full methodology. It opens in an honest "Insufficient Historical Data" state: no rate below 20 settled games, no interval below 50, and no claim that higher grades do better until an interval says so. Linked from the app's More › Transparency, the footers, the methodology page and the sitemap.
- **Supabase (optional)**: `supabase/research_grades.sql` (+ rollback), standalone of `model_performance.sql`: append-only tables for every role, server receipt stamps, RLS (grades readable once their game starts), one service-role ingest, a trigger that refuses any outcome for a grade captured after the start or with a different letter, the A–F thresholds as a check constraint, indexes and the `perf_grade_performance` view. `tools/performance/sync.js` mirrors the two streams once it is applied.
- **Tests**: `research_grade.test.js` (176), `grade_ui.test.js` (28), `research_grades_sql.test.js` (55, real PostgreSQL), `grades_ui.e2e.js` (89, 390 and 1280 px), wired into `performance-tests.yml`; the hourly job runs the kernel suite before it writes. The existing performance, site, navigation, guide, game research, FBS board, slate, NBA and engine suites stay green.
- **Shipped with no grades in it.** The ledger's first research grades are written by the hourly job after merge; nothing was backfilled.

## 2026-10-16 — College baseball out of season: the card says what the archive holds again

**Out of season the college baseball board now falls back to the last day played**, under a "the season is complete" note. That note never said what the archive holds. Only the empty-archive card did. `tools/cbb/cbb_ui.e2e.js` checks for it, and it had failed on `main` (57/58) unnoticed, because no workflow ran it.

- **`app.html`.** `cbbArchiveLine()` is one sentence, shared by both out-of-season states: "The archive holds N games across seasons X–Y. Season records and prior meetings are still there to read." It is omitted when the status read failed, as before.
- **`tools/cbb/cbb_ui.e2e.js`:**
  - It describes the fallback the page now shows, and checks that the last day played is labelled as finished games: 59 checks.
  - It creates Supabase's three roles one by one, the way `tools/games/sql/supabase_shim.sql` does (`service_role` bypasses RLS). Before, on a bare PostgreSQL, the schema failed on `service_role` before a single check ran.
- **`.github/workflows/games-sql.yml`:**
  - It runs the test next to the MLB browser suite, against the same database.
  - Its log is on the skip guard's list, so a skip fails the job.
  - It now triggers on `lib/college_baseball.js` and `tools/cbb/**`.

## 2026-10-16 — College baseball: a postponed game is no longer stored as a finished 0-0

**The ingest called any game in ESPN's `post` state completed** (`tools/cbb/ingest.js`). ESPN files postponed, canceled and suspended games under `post` too. It flags a postponed one `completed: true`, with a score of "0" for each side. So:
- a rained-off game was stored as a finished 0-0, which the record fold (`cbb.rebuild_team_seasons`) counts as a tie, in the club's record, last 10 and streak;
- a game suspended in the 7th was stored as a final, with a winner.

**What changed:**
- **`tools/cbb/ingest.js` `isFinal`.** A game is a result only when the source says it finished (the completed flag or a final status) and its status does not say postponed, canceled, suspended or forfeited. That is the rule `tools/collective/settle_finals.js` and the CFB Lab already use.
  - A postponed or canceled game stores no score, and its row says why (`Postponed`), even when the source only names the status.
  - A suspended game keeps its partial score, but it is not a result.
- **The union** (`mergeGame`). When one source saw the game finish and the other did not, the finished reading's status, score and innings lead. A stale "Postponed" can no longer sit beside a final, and a postponed reading can never set completed.
- **`tools/cbb/stats.js`** reads box scores by the same rule.
- **`lib/college_baseball.js`.** Rows the old ingest already stored are read as what they were: abandoned, no winner, no 0-0. The next import replaces them, because promote rewrites every game row. `app.html` loads the library with a new cache key.

**Tests.** `tools/cbb/ingest.test.js` covers:
- a final, including one with no completed flag;
- postponed, canceled, suspended and forfeited games in state `post`;
- the state alone;
- the union in both source orders;
- the board's reading of a legacy row.

13 of its 47 assertions fail on the old code.

## 2026-10-16 — EdgeDesk Model Performance: every pregame forecast, locked and graded in public, misses included

**`/performance/` is the public, cross-sport record of EdgeDesk's forecasts.** It is free and needs no account. See `docs/model-performance/` (AUDIT, DESIGN, RUNBOOK).

- **The audit** (`docs/model-performance/AUDIT.md`) found:
  - per-game pregame grading only for NFL/CFB (`record/football`);
  - season aggregates nobody displayed for NBA/NHL;
  - a cross-sport projections ledger nothing graded;
  - no independent capture time anywhere;
  - five different ways of handling postponements and corrections;
  - no public ledger of forecast against result.

  It reuses the projection contract, the slate's scoreboard and quotes, each sport's own result file, EDCALIB, the record's closes, `push_generated.sh` and the SQL harness. Nothing is replaced.
- **The ledger** (`performance/ledger/`, `tools/performance/`, `lib/edgedesk_performance.js`):
  - four append-only, SHA-256 hash-chained streams: forecasts, quotes, results and grades;
  - an hourly capture of the projection contract as committed;
  - pregame only: a capture or a model build at or after the start is refused, including the build's 3-hour post-start window;
  - every revision kept;
  - the graded forecast is the last captured before the actual start, and a start moved more than 36 h voids the earlier snapshots.

  `run.js --check --base` refuses any rewritten line.
- **Verification tiers.**
  - *Verified pregame* is the ledger's own capture.
  - *Recorded pregame* covers 1,346 revisions imported from the football record, the NBA/NHL ledgers and the projections ledger, all labelled and never counted in the verified headline.
  - *Retrospective* walk-forward results are shown apart.
- **Results.**
  - Sources: the slate's ESPN scoreboard; nflverse, ESPN plus cfbfastR, hoopR and the official NHL data from `record/` and each engine; and ESPN by date for missed finals (at most 4 reads a run).
  - Sources must agree; a disagreement is CONFLICT.
  - 0-0 is a placeholder.
  - Canceled, forfeited and postponed-14-days games are VOID.
  - Corrections are new revisions that regrade the game.
  - Overtime counts; NHL finals include the shootout goal.
  - On first build, 448 games verified and graded (recorded tier).
  - Cross-checked: NFL/CFB margin MAE, total MAE, Brier (CFB) and CLV match `record/football/summary.json` to the digit. The NFL Brier differs only because the one tie is excluded rather than scored as 0.5.
- **Metrics:**
  - right winner, Brier, log loss, calibration (Wilson), confidence bands;
  - margin and total MAE and bias;
  - model against the captured named-book line on the same games;
  - records at the line at three disagreement thresholds;
  - units only at a captured price (never −110);
  - CLV only against a same-source close;
  - cumulative trends.

  Every figure carries its `n` and sample state, and nothing prints under 20 games.
- **The page:**
  - a verified headline with an honest insufficient-data state;
  - tier, sport, model version, type and date filters;
  - by sport, calibration chart, trend and model against market;
  - a searchable ledger with each game's sources, market line and fingerprint, linked as `?g=`;
  - coverage, including why MLB, college baseball and UFC are not graded;
  - methodology and limitations.

  It is linked from the footers, `record.html`, the landing footer, `methodology/` and the app's More › Transparency.
- **Articles.**
  - A played matchup page gains **EdgeDesk Prediction vs. Actual Result**, built from its own published numbers, the verified final, the errors and a link to the record. It notes when the graded forecast moved after the article.
  - The Monday Weekend Model Review gains a cross-sport accountability section and the week's largest model-against-market disagreements. All 12 gates pass, and a thin week is declined with its reason.
- **Social.** `performance/social/<week>.json` holds a summary under 280 characters, card data, comparisons and a market recap. It is written once per complete week of 20 or more verified games. Drafts only: no X integration exists.
- **Supabase (optional).** `supabase/model_performance.sql` adds append-only `perf_*` tables for every role, a chain check, server-stamped receipt times, RLS that publishes forecasts only after their game starts, a single service-role write path and an ingest log. It ships with a rollback and a manual deploy workflow.
- **Monitoring.** `performance/data/health.json` reports missing finals, conflicts, unmatched games, stale capture, metric shifts and duplicate publication. The hourly run lists them as annotations and in its summary. They never turn it red; only a broken job (a failed rule test or a chain that does not verify) does.
- **Tests:**
  - `performance:test`: 93 checks covering the kernel, the ledger and a full offline lifecycle.
  - `performance:sql`: 55 checks on a real PostgreSQL, as anon, a reader, the service role and the owner.
  - `performance:e2e`: 42 checks at 390 and 1280 px.

  The site, nav, free-access, SEO, growth, app navigation, article, content engine and features suites stay green.
- **Three checks that were red on `main` too, fixed at the cause:**
  - **The availability gate split sentences at "Oct."** "Wisconsin's Big Ten availability report (published Oct. 15) lists quarterback Danny O'Neil as questionable" was read as two sentences, so the claim lost its team. `lib/edgedesk_availability.js` `sentencesOf` now keeps abbreviations (Oct., Sept., St., No., vs.) inside the sentence.
  - **A conference report's quarterback listing did not count as a sourced report.** The gate credited the NFL report's player list only. `lib/content_engine.js` now credits the one-player claims that conference reports produce, as it does the NFL list. Without that report on file, the same sentence still fails.
  - **"V2.1 flags: uncertain team ratings." reached publisher copy.** A reader now gets the driver ("Uncertain team ratings.") without the model version.
  - **`football/game_research/landing.json` went stale against `current.json`** whenever only a snapshot's `generated_at` moved, because `writeIfChanged` ignores clock fields. `tools/football/build_game_research.js` now builds the landing file from `current.json` as written, and rewrites it whenever an embedded snapshot differs.

  Each fix has a test that fails without it.

## 2026-10-16 — The landing page: a model you can follow and argue with, shown on real games, and what shipped finally says Live

**The landing page now shows EdgeDesk the way a subscriber sees it.** It explains why a model you can check is worth having, and it stops calling shipped features "in development".

- **New section: "A model you can follow. And argue with."** (`#model`, right after the free research).
  - **Know it:** every number shows its work (the score, fair spread and total, win chances, and the terms that moved them).
  - **Follow it:** the record is public, losses included. The season's graded count is read live from `record/football/summary.json` (419 so far in 2026).
  - **Help it:** each game lists what the model doesn't know yet.
  - **Disagree with it:** your own fair line goes beside EdgeDesk's and the market's, and stays in your journal unchanged to grade against the close.
  - One paragraph on why a baseline matters, then the trial button.
- **Real games, drawn by the research page's own code** (`lib/edgedesk_home_model.js` + `.css`). Up to three of the week's editorially featured games, from the new `football/game_research/landing.json` (written hourly by `build_game_research.js`, checked by `--check`).
  - A tab per game.
  - The matchup graphic, drawn on the reader's device and downloadable as a PNG.
  - Beginner / Research / Lab.
  - Compare your number: `GS.comparePrice` on the game's own sheet, EV only where the market is calibrated, labelled a user-entered quote, never stored.
  - Layer A only: no sportsbook price is read. The libraries load only as the section nears the screen. If the file is missing, the free sample link stays and the page says why.
- **What shipped now says Live.** The Process Coach, the Weekly Film Room, the calendar, CSV import and bet slip screenshots shipped on 2026-10-04/05/14 (Portfolio schema deployed 2026-10-14), but the page still called them "in development". The loop's Learn and Improve steps, the Coach's eight reports, the Film Room and the calendar are now marked Live. Their pictures stay labelled sample data.
- **Still labelled in development:** sportsbook and prediction-market account connections, and the free-account dashboard and saves (`lib/edgedesk_plans.js` PLANNED, now only these).
- **The plan card and the terminal's paywall** (`lib/edgedesk_pricing.js` FEATURES) now list:
  - Model-first NFL and college football research
  - Fair lines, win probabilities and matchup graphics
  - Compare your number with the model
  - Live market comparison and EdgeDesk EV
  - Player props
  - Bet journal with CSV and bet slip import
  - Profit, ROI and closing-line value
  - Process Coach and the weekly Film Room
- **The free list** adds "This week's featured games, researched in full".
- **FAQ:**
  - "What if I disagree with EdgeDesk's number?" replaces "Who is EdgeDesk for?" (the hero already says who).
  - The coverage answer now names the terminal's other sports (NHL, NBA, MLB, college baseball, UFC) once, saying none makes a value claim.
  - The connections answer names the three live ways in.
- **"Start simple, go as deep as you want"** (`#depth`) gave way to the demo's Beginner / Research / Lab on a real game.
- **Weight.** The coach, Film Room and calendar picture styles moved to `lib/edgedesk_landing_pictures.css`, which doesn't block first paint. The page is about 199.5k of its 204.8k-character budget.
- **Tests.**
  - `tools/presentation/landing_model.test.js` (new, 105): the file is `current.json`'s own, the selection rule, the pick, the words, parity with the research page's price check, the graded count, and the copy.
  - `landing_positioning.test.js` and `landing_interaction.test.js` hold the new truth.
  - `tools/site/free_access.test.js`: `landing.json` is a public sample (at most three games, no price, featured or the stated fallback).
  - `tools/home/landing.e2e.js` (289, +29): the demo at 390 and 1280 px, the file missing, one `tool_used`.
  - CI: `funnel-tests.yml` and `collective-tests.yml` run the new suite.

## 2026-10-16 — CFB fair alternate spreads: one distribution per game, so a better line never prices lower

**The CFB fair-line ladder no longer dips as the line improves.** Before, Tulane −0.5 read 38.9% and Tulane +0.5 read 38.7%. Every FBS sheet had dips like this: up to 1 point inside a published ladder and 3 points across the table's ±45 edge.

- **The cause.** The engine's per-line cover call (`football/cfb_p4/engine.js` `dist.coverProbSpread`) borrows its shape from the margin table row keyed by the line it prices. Past ±45 it uses the pooled residual instead. So every rung of a ladder read a different distribution.
- **The fix.** The linemaker now reads one row per game: EdgeDesk's own fair margin, clamped to the table (`EDQuoteEV.cfbGameCover`, the row the terminal and the in-card ladder already read). Every line is then a tail of that single distribution.
  - It lives in `tools/football/build_fair_lines.js` `cfbSpreadCover`.
  - At the fair margin it equals the engine to the bit.
  - A ±0.5 pair now reads the same, because CFB has no ties.
- **The app's per-book "price at this line"** (`fbGxResearchObj`) had the same per-line read. It now uses the curve conditioned on the joined market, which equals the engine's own cover at that line.
- **The calibration record** (`football/validation/linemaker_cfb.json`) is re-graded on the new function, using identical data.
  - Spread log loss improved: 0.72413 → 0.72394 on the selection seasons, 0.72673 → 0.72643 on the confirmation seasons.
  - The calibration slope went from 1.024 to 1.007.
  - The mean-probability miss went from 0.0295 to 0.0303, so the status stays PROVISIONAL and the tier stays RESEARCH.
  - Every other market is unchanged.
- **What moved.** Within ±10 points of fair, a typical rung moved 0.4 points, and 1.5 at most.
- **Regeneration.** `football/game_research/probabilities.json` is rebuilt. `football/linemaker/fair_lines.json` and its append-only ledger reprice on the next `linemaker-build` run.
- **Tests.**
  - `linemaker.test.js`: every committed FBS projection, plus a sweep of margins and σ, is monotone and integer-consistent from −70 to +70; parity with the engine at the fair margin; the table-less fallback.
  - `game_research.test.js`: the built and the committed ladders, ±0.5, and the page's read.
  - `cockpit_ui.test.js`: the book-line pricer.

## 2026-10-16 — Model-first game research: an automatic matchup graphic, a research page per game, and a market outage that no longer hides the model

**EdgeDesk's own projections now lead every NFL and FBS game, with or without a sportsbook quote.** See `docs/game-research/README.md`.

- **A research snapshot per game** (`lib/edgedesk_game_snapshot.js`, built hourly by `tools/football/build_game_research.js` into `football/game_research/`): projected score, fair spread and total, both win probabilities, the model moneyline (labelled a model estimate), the 80% range, the model's own terms, unit rankings, reliability or the NFL data check. It reads no sportsbook number. Every snapshot is held to its own arithmetic (scores reconcile, probabilities sum to 100%, the moneyline restates the probability); a failure is a visible DATA FAULT.
- **Insights from measured data only**: an offense against the unit that has to stop it, strength on strength, the projection's own strength and home-field terms, continuity and special teams. Never generic copy; some games show two.
- **The matchup graphic** (`lib/edgedesk_game_graphic.js`): deterministic Canvas rendering of one snapshot, square 1080×1080 and portrait 1080×1350, EdgeDesk branding, team monograms in team colours (no unlicensed logos), a live-market panel only from a fresh quote, otherwise EdgeDesk's model detail. Download, native share, copy link; cached by snapshot, quote and format; any past graphic redraws from the append-only history. `npm run game:graphics` batch-exports PNGs.
- **The research page** `#game/<nfl|cfb>/<id>` (`lib/edgedesk_game_view.js`): status (research · model · market · betting decision, four separate answers), the graphic first, the overview, what to watch for, Beginner / Research / Lab, the optional market comparison, and Compare my number. Every board card opens with the projection and **Game research & graphic**; Today's Games, desk and email links open the page.
- **NO DECISION no longer leads a game** when the only reason is the quote (stale, missing, suspended, failed its check): the card reads *Market comparison · betting decision not evaluated* with the full decision under Lab details. Model and game blockers keep the full card. The decision engine, stale-market safeguards and ingestion are unchanged.
- **Compare my number with a price**: spread, total or moneyline with American odds, priced by the linemaker's `EDFairLine.priceCheck` on the snapshot's own probability sheet: implied probability, model probability, difference, fair odds, and EV only where the market's probabilities are calibrated. Labelled *User-entered, unverified sportsbook quote*; never stored.
- **Tests.** `npm run game:research:test` (every committed game, synthetic edge cases, market states, price checks, graphic bounds, history, integrity and a tamper case, app wiring) and `npm run game:research:e2e` (Chromium at 390 px and 1280 px with fresh, stale and missing odds). CI: `game-research-tests.yml`.

## 2026-10-16 — Learn EdgeDesk: a first-visit introduction, task walkthroughs, Help, and terms explained where they appear

**A first-time visitor can now learn EdgeDesk inside the product.** See `docs/guide/README.md`.

- **The introduction.**
  - On a first visit it explains the purpose in plain words: research, EdgeDesk's own numbers beside the market's prices, and how far to trust the data.
  - It offers *Show me around* and *Explore on my own*.
  - *Show me around* asks **What would you like to do?** and lists only the tasks this build supports.
  - It replaces the old conceptual welcome, which now runs only if the guide fails to load.
  - It waits for the paywall, Setup and other dialogs, and is asked once. The answer is kept on the device (`edgedesk_guide_v1`) and on the account (`user_metadata.edgedesk_guide`).
  - Readers who dismissed the old welcome are not interrupted; the Help button carries a dot until they open it.
- **Five walkthroughs on the real screens.** Research a game; Understand the research numbers; Explore player props; Read today's Card; Track your bets.
  - Each has 4–5 steps, with Step n of m, Back, Next, Skip and arrow keys.
  - The highlighted control stays usable throughout.
  - Steps wait for loading screens, say what is missing and offer the next useful action (a football engine down, props without prices, a failed schedule, a signed-out Portfolio). They say so when a game has already started, and when the reader navigates away.
  - None starts behind the paywall.
- **Help.** The **?** button in the header (desktop and phone), the account menu and More → Account all open the same panel:
  - this page's walkthrough and terms;
  - the other tasks;
  - a searchable glossary;
  - the introduction again.
- **Terms where they appear.** Fair spread and fair line, implied probability, break-even and no-vig, edge, EV, market state, playable-to, decision confidence, data confidence and reliability, calibration, CLV, research readiness, the five decisions, units, and estimates vs results. Each says what it is, how to use it, and what it cannot tell you.
  - Every decision-layer tooltip now opens the full explainer on click or Enter.
  - Labels in the football research, props, game details, Portfolio and Model performance carry `data-ed-term`.
- **No stacking.** The six-step onboarding and the Card's own explainer wait while the guide is busy. Finishing the Card walkthrough stands in for the Card's explainer, which stays under *How to read this card*.
- **Tests.**
  - `npm run guide:test`: copy rules, every selector exists, asked-once rules, wiring. CI: `guide-tests.yml`.
  - `npm run guide:e2e`: desktop and a 390 px phone, covering skip, reopen, navigation, missing data, a locked account, keyboard and reduced motion.

## 2026-10-15 — edgedesk_ai build label: r26-multisport-model-first

The multi-sport Quant Desk (#589) shipped without a new `BUILD` label, so the deployment doctor compared the old label (`edgedesk_ai-2026-10-12-r25-stale-price-labels`) on both sides and could not show that the new code was live. `BUILD` is now `edgedesk_ai-2026-10-15-r26-multisport-model-first`. After the next deploy, `?probe=1` and the doctor name this build, so "deployed and current" means this code.

## 2026-10-15 — CI: no Skipped checks on a pull request; the Content engine tests green again

**A pull request now lists only checks that run.** Seven workflows ran their tests on pull requests but also carried scheduled jobs, which every PR listed as Skipped. Following the Linemaker split (2026-10-14), each scheduled job is now its own workflow, unchanged apart from its trigger:
- `nba-build.yml` and `nba-validate.yml`, `nhl-build.yml` and `nhl-validate.yml`, `lab-build.yml` and `lab-validate.yml`.
- `college-baseball-research-build.yml` and `college-baseball-research-validate.yml` (tune and backfill by hand).
- `content-engine-weekly.yml`, `edgedesk-features-run.yml` and `projections-build.yml`.

Each keeps its cron, permissions, concurrency group and manual run. The original files keep the tests and their check names. No workflow that runs on a pull request or a push has a job-level condition left.

**Content engine / tests was red on `main` too; it passes now.**
- `lib/content_engine.js` crashed drafting a single-game analysis of an NFL division game, whose evidence claim carries no conference. It now says "a division game".
- A multi-game article stated at most one quarterback status per game, and only an OUT. The editorial gate requires every quarterback on an availability report and every input conflict, so this week's Texas Tech article (Thomas Castellanos, questionable) was blocked. The writers now state exactly what the gate requires.
- The Edge Function copy is re-inlined. The tests that read the workflows now read the files that hold the scheduled jobs.

## 2026-10-15 — The Quant Desk researches every sport, model first

**"What's the best researched opportunity tonight?" is now answered across every sport EdgeDesk models, from EdgeDesk's own projections, frozen before any sportsbook price is read. It used to be answered from football alone.** The desk was a price scanner: a sport with no captured price had no "games" (NBA, NHL, WNBA and college basketball are not captured). On 2026-10-15 it scanned one NFL game and three college games and reported the NHL, with 11 games and an outcome-validated model, as "prices not captured". Full write-up: `docs/quant-desk/MULTISPORT.md`.

- **Model first.**
  - `lib/edgedesk_projections.js` reads every published engine (NHL, NBA, WNBA, NCAAM, NCAAW, NFL, FBS; soccer, removed from the platform the same day, is reported as not covered) into one independent-projection contract, then freezes and hashes it.
  - `lib/edgedesk_market_compare.js` compares the frozen snapshot with the prices that exist, without moving it, and labels every price by kind.
  - `lib/edgedesk_multisport.js` discovers the events from the schedule, writes the matchup research and ranks across sports by validated, uncertainty-adjusted rules.
  - The answer has four sections (best verified opportunity, best researched matchup, strongest market watch, other candidates), plus what could change it, a coverage report and the sources.
- **No market contamination.** No adapter reads an artifact's market blocks (the NFL slate's model–consensus `pricing` rows, the NBA `market`, the NHL `market_check`); a test proves it by scrubbing and corrupting them. The captured-price audit is kept as a labelled **market benchmark**. The card feed's blend is now labelled a blend.
- **Persisted before compared.**
  - `supabase/independent_projections.sql`: the database refuses a comparison that doesn't match a projection hash stored earlier, refuses a market-informed projection, and refuses a "verified" edge on a non-live quote.
  - `engine/build_projections.js` (`projections.yml`, every 3 h) freezes every engine's projections with no price read.
- **Odds off.** With `EDGEDESK_ODDS_DISABLED=1` the desk reads no price and still produces every projection, with the same snapshot hash.
- **The Seahawks starter.**
  - nflverse `games.csv` named Drew Lock for SEA; the depth chart and play-by-play name Sam Darnold.
  - The NFL slate builder now re-runs the engine on a corroborated depth-chart starter (DEN +0.07 → +1.01) and flags an unresolved disagreement.
  - The research layer invalidates a projection whose starter disagrees, and the research packet no longer lets the schedule feed win silently.
  - nflverse data is no longer labelled "official".
- **Audit semantics.** "UNVERIFIED … PASS" is now three separate lines: audit execution, evidence verification, and trade execution eligibility.
- **Fixed after review** (each reproduced, then pinned by a test):
  - A second question on unchanged projections is its own freeze. Before, a hash-only snapshot id was deduplicated and the database refused every comparison of the second turn.
  - A DATA CHECK (EV past the 15% ceiling) is listed, never ranked as the strongest market watch.
  - The maximum acceptable price and the price to watch are on the classifier's own 2% bar.
  - Postponed or delayed games stay excluded.
  - Soccer's 1X2 is compared as a three-way market; a club spelled differently on the scoreboard ("FC Cologne") joins its engine projection ("1. FC Köln").
  - Team matching no longer confuses Texas with Texas A&M or Iowa with Iowa State, and an id link wins over a name match.
  - A missing published figure no longer takes down the desk.
  - Two feeds of one book count as one book.
  - A past replay date is no longer an inverted window.
  - With odds off, the named-game check reads no price.
  - A spread with no line is never priced as pick'em.
  - The NHL engine's per-line validation is kept.
  - No constant is shown as a fair line.
  - The database stamps `created_at` itself and refuses back-dated freezes and comparisons, and comparisons naming another event or probability.
- Tests: `tools/intelligence/multisport.test.js` (127), `multisport_host.test.js` (37, including the 2026-10-15 regression from a fixture of that day's committed artifacts), `projections_sql.test.js` (50, PostgreSQL 16). `quant_ui.e2e.js` (59) renders the Oct 15 answer in Chromium at both widths. Every suite in the existing `ai:test` chain stays green.

## 2026-10-15 — Soccer removed; the last ESPN wording on prices; the new strip actually loads

**EdgeDesk covers American sports and UFC. Soccer is gone from the platform; no other sport's numbers changed.**

- **Today's Games** (`lib/edgedesk_games.js`): soccer is no longer a listed sport, so it has no pill, no feed read, no card and no fallback schedule (`tools/slate/artifacts.js`, `build.js`, `research.js`). The committed `today/slate.json` drops its 110 soccer games; the next build reads no soccer scoreboard. A soccer event from a slate saved on a device, or a live row written before the removal, is dropped wherever it turns up (`EDGames.select`). `/today/`'s title and copy no longer list soccer.
- **The cross-sport engine**: the soccer brain is out of `lib/edgedesk_sport_brains.js`, `engine/build_registry.js`, `engine/build_board.js` and `engine/lab/missingness.js`. `engine/registry.json` and `board.json` were rebuilt: every other sport's rows, coverage and registry entries are identical to before; only the soccer candidates leave the board. The data-pack cross-check keeps the pack's EPL sample as counted only.
- **The soccer model** (`soccer/`: code, data, records, slate) is deleted, with its steps in `.github/workflows/lab.yml` and the `lab:*` npm scripts.
- **The Card** (`lib/edgedesk_card_feed.js`, `lib/edgedesk_decision_ui.js`): no soccer rows, pill or three-way pricing. A Soccer filter saved on a device reads as All sports, never an empty Card.
- **Kept on purpose:** your own bet history still imports and labels soccer bets (portfolio sync, slip reader); the AI already answers "Soccer is not covered" with no pick; the archived data pack (`datapack/quant_v1`, hash-verified) is untouched.
- **ESPN on prices:** the Card's price line reads "DraftKings (free, no credits)"; the NHL panel and the NHL price-verified reason say "a public scoreboard" instead of naming ESPN.
- **Cache:** every changed browser file has a new `?v=` tag in `app.html` and `/today/`, so the new Today's Games strip (the entry below) reaches browsers that held the old copy.
- Tests: the slate kernel, pipeline and browser suites now cover college basketball where they used soccer, and check that no soccer pill, feed, row or old live row ever shows; the lab, engine, Card and NHL suites updated for 11 sports.

## 2026-10-15 — Today's Games: scoreboard tiles, and no "ESPN" on screen

**The Today's Games strip on the Research screen now reads like a sportsbook app's scoreboard.** Each game is a small tile: two teams with their logo and abbreviation and one number each, the start time and the total underneath, then one pill to the research.

- **The numbers.** A spread sport (NFL, college football, NBA, college basketball) shows the favourite's spread and the underdog's moneyline (`ECU −5.5`, `UAB +170`, `o47.5`). A puck-line, run-line or 1X2 sport shows both moneylines; a soccer draw is in the tile's words and tooltip. Live and final games show the score instead. A price past the 90-minute limit is dimmed and marked **past**; no price says **No odds**.
- **The pill.** *Research* (or *Matchup* where there is no research page), with EdgeDesk's read on the game underneath (`Read: Investigate`), a certified signal when there is one, or what the game has. The ⓘ button beside it opens the matchup view.
- **Layout.** Two tiles and a bit across a phone, as a swipeable rail; two rows of four on a desktop, the last one the way to every game.
- **No "ESPN" on screen.** Prices name their book only (`DraftKings · 10 min ago`): on the tiles, the games page cards, the matchup view's footer and the NHL comparison sentence (`lib/edgedesk_nhl_compare.js`'s label, also used by the NHL panel). The data still records where each quote was read.
- The games page (`#games`) and `/today/` keep their full cards, with every market.
- Tests: `tools/slate/games_ui.e2e.js` (101, from 89: the tile's numbers, words and tap targets at 390 px, no ESPN anywhere in the strip or matchup view), `tools/hockey/nhl_compare.test.js`, `tools/engine/engine_ui.e2e.js`.

## 2026-10-14 — Portfolio: sportsbook history through Juice Reel (OAuth 2.0 + PKCE; awaiting Juice Reel's approval)

**Juice Reel is built as the sportsbook sync provider to replace SharpSports. A reader signs in on Juice Reel's own page and allows EdgeDesk to read their open and settled bets. One authorization covers every book Juice Reel tracks for them, and each book becomes their own Portfolio account. It is built and tested here, NOT deployed and NOT yet run against Juice Reel: EdgeDesk's Juice Reel application is awaiting approval, so readers see "Awaiting provider approval" and linking stays off behind the existing registry guard until Juice Reel approves, a PRODUCTION smoke test passes and the terms review clears.** Docs: `docs/juicereel.md`. Redirect URI to register: `https://edgedesksports.com/oauth/juicereel-callback.html`.

- **No subscription webhook.** Juice Reel's only webhook bucket (SUBSCRIPTION_EVENTS) reports subscriptions to the app owner, sold through Juice Reel. EdgeDesk bills through Stripe and never asks Juice Reel who is subscribed, so no `juicereel-webhook` exists and `subscribers.read` is not requested. Bets are read on a schedule from `/oauth2/bets/changed`.
- **OAuth** (`portfolio_connect`: `jr_status`, `jr_start`, `jr_callback`, `jr_sync`, `jr_disconnect`; `oauth/juicereel-callback.html`).
  - State and PKCE (S256) are made server-side; the verifier is sealed and the state stored only as its hash, for 15 minutes, one use, bound to the reader who started it (login CSRF is refused).
  - The callback page strips the code from the address before anything else, and hands it to the app in this tab only.
  - The code is exchanged server-side; both bet scopes are required.
- **Tokens** (`supabase/portfolio_juicereel.sql`, `portfolio_private.oauth_grants`).
  - Stored as AES-256-GCM ciphertext only.
  - Juice Reel's single-use refresh token is sent once however many syncs race (a lease), and the new pair is stored in one statement.
  - A refused refresh reads Connection expired, with no retry storm and history kept. Disconnect deletes EdgeDesk's copy, then revokes both tokens at Juice Reel.
- **Sync.**
  - The initial import (open, then settled, resumable across runs from Juice Reel's cursors), then incremental passes over `/bets/changed` from an `updatedAt` checkpoint, resumable across runs too.
  - Nothing moves past a bet that was not stored: a run cut short (429, 5xx) stores what it read and keeps its place; a book whose run is still open keeps the whole sync where it was.
  - A daily reconciliation that finds a missed settlement and reports a bet no longer at Juice Reel.
  - Backoff for 429 and 5xx.
  - Corrections, cancellations and a bet moved between books are applied in place.
- **Money.** Through the existing ingest and derive trigger, so there is no second ledger.
  - A sub-cent stake is rounded up to the cent and the payout is stake + `netResult`, so P&L equals Juice Reel's figure exactly (the docs' own −0.5886 example, to the cent).
  - Parlays keep their legs; a reader's matching file or manual bet is adopted — now also one imported WITH the book's own bet id (`portfolio_aggregator.sql`'s shared ingest; it used to be counted twice).
  - Anything that cannot be read without guessing (no stake, time or price, an unknown result, non-USD) is listed, never invented.
- **Accounts tab:** Not connected · Awaiting provider approval · Connecting · Connected (only after a real authorization) · Syncing · Last synchronized · Connection expired · Action required · Sync failing · Disconnected; Sync now; Disconnect, or disconnect and delete synced history.
- **In the provider seam** (the entry below). Juice Reel is registered in the connector core's sportsbook provider registry (ACTIVE, grant-level: one authorization syncs, sweeps and disconnects as a whole) and answers the generic `sb_*` actions plus its own `jr_*` ones.
  - It runs only where `SPORTSBOOK_SYNC_PROVIDER=juicereel`; unset, nothing changes from the entry below.
  - With sync off, a reader who still has a Juice Reel connection sees it as "Sync off" and can still disconnect it (and revoke it at Juice Reel).
- **An adversarial review** found nine defects in sync and token edge cases; all are fixed or answered (`docs/juicereel.md` § 14).
- **Tests:**
  - `tools/portfolio/juicereel.test.js` (140: the shipped function over the real migrations, against a fake Juice Reel enforcing the documented contract; the provider seam and its switch, on and off; a test for each review finding);
  - `tools/portfolio/juicereel_ui.e2e.js` (22, Chromium, the full browser round trip through the callback page);
  - The existing Portfolio suites are green.
- **Live checks:** `tools/portfolio/juicereel_smoke.js` (probe; the ten-stage PRODUCTION smoke test, after approval).

## 2026-10-14 — Portfolio: SharpSports retired, a replaceable sportsbook-sync seam, one-tap sportsbook tiles, bet slip screenshots

**SharpSports BetSync is switched off** (its plan starts at $500/month). Sportsbook bets now come in through CSV import, a **bet slip screenshot read on the reader's own device**, or manual entry. All three land in the same Portfolio, analytics and dedupe. Why, what was kept, and the alternatives researched: `docs/sportsbook-sync-providers.md` (research: `docs/sportsbook-sync-research-2026-10-14.md`).

- **Off by default.**
  - `SPORTSBOOK_SYNC_PROVIDER` names the one sportsbook sync provider a server uses; unset means none.
  - With none, `portfolio_connect`'s `sb_*` / `ss_*` actions say `SYNC_OFF`, and the sweep skips linked sportsbooks.
  - `sharpsports-webhook` answers every POST 200 `{ignored:'sync_off'}` without reading it.
  - No table, row or synced history was removed.
- **A provider seam.** The connector core's sportsbook provider registry (`defineSportsbookProvider`, `SPORTSBOOK_PROVIDER_CONTRACT`) holds the SharpSports adapter as RETIRED.
  - The function routes generic `sb_*` actions through a handler table.
  - The Accounts page names no provider: labels, wording and the linking page's origin come from the registry.
  - A new provider is one adapter plus one handler row; no table, analytics or screen changes.
- **Accounts → a tile per sportsbook.** Tap one and its card offers:
  - the CSV import;
  - "Read a bet slip screenshot";
  - "Add it, no file yet";
  - Connect, only where a provider is switched on.
  A book a retired provider once linked reads "Sync off", with its history kept.
- **Bet slip screenshots** (`lib/edgedesk_slip_reader.js`):
  - Tesseract.js reads the image in the browser, and the image is never uploaded. Cost: $0.
  - Each field is filled only where the slip states it: amounts only beside a label; "To Win" is not a win; a Cash Out offer is not a cash-out.
  - The ordinary bet form opens filled in, saying what was not found. Nothing is saved until Save.
  - The slip's bet ID becomes the position's external ID, so the same bet from a second screenshot or from the book's CSV is refused as a duplicate.
- **Page scripts and styles** carry new version tags, so browsers load the current code.
- **Tests:**
  - `tools/portfolio/sharpsports.test.js` (97): the off switch, end to end.
  - `tools/portfolio/slip_reader.test.js` (22, new): the reading rules and the dedupe against PostgreSQL.
  - `tools/portfolio/portfolio_ui.e2e.js` (133) and `sharpsports_ui.e2e.js` (21): the screenshot flow, and sync off and on, in Chromium.

## 2026-10-14 — Portfolio: sportsbook history through SharpSports BetSync (sandbox), the 404 webhook, bankroll trend and drawdown, EdgeDesk's model beside a bet

**Sportsbooks can now be connected to the Portfolio through SharpSports BetSync, an approved aggregator. The reader signs in to their book on SharpSports' own page; EdgeDesk never sees a sportsbook password and reads SharpSports server-side, read-only. It is built, tested here and in sandbox only, for operators. It has NOT yet been deployed or run against SharpSports' sandbox: the build environment could not reach `*.sharpsports.io` or `*.supabase.co`. The five SharpSports webhook subscriptions answered 404 because no function named `sharpsports-webhook` existed; it does now. Production stays off behind the existing registry guard until a PRODUCTION smoke test passes and the terms review is cleared.** Docs: `docs/sharpsports-betsync.md`.

- **The webhook** (`supabase/functions/sharpsports-webhook`, deploy `--no-verify-jwt`).
  - A delivery is a hint, never data: it is recorded once, the accounts and bettors it names are made due, and everything is re-read from SharpSports' API.
  - HMAC-SHA256 under each subscription's secret. In `observe` mode until a genuine delivery verifies; in `required` mode, unsigned or wrongly signed deliveries get 401.
- **Linking and sync** (`portfolio_connect`: `ss_status`, `ss_books`, `ss_link`, `ss_discover`, `ss_refresh`).
  - A linked book is an AGGREGATOR account under the book's own key, and a quick-import account is upgraded in place.
  - Slips are normalized exactly from cents: singles, parlays with legs, teasers, round robins, pushes, voids, half results and cash-outs.
  - A slip that cannot be read without guessing — no stake, no placed time, no cash-out amount, an unknown outcome — is listed, never invented.
- **The database** (`supabase/portfolio_aggregator.sql`): bettor references with an opaque id, the webhook log, refresh requests, an append-only settlement history, and `portfolio_svc_ingest_wagers`.
  - The ingest is idempotent, and adopts a reader's matching file or manual bet so the journal is kept.
  - Sandbox and production use separate keys. A sandbox rehearsal is recorded DEMO and can never switch production on.
- **Every tab:**
  - **Analytics:** a bankroll trend and drawdown from the server (`portfolio_pnl_path`), and a by-bet-type breakdown.
  - **Overview:** units won or lost, only where a unit size was recorded.
  - **Open:** parlay legs with each one's state.
- **EdgeDesk's model at the time** (`supabase/portfolio_model_context.sql`).
  - For a football single matched to one game: EdgeDesk's probability recorded before the bet, only at the line the model priced, beside the price's implied probability.
  - A record made after the bet is refused by name.
  - It is kept apart from the bettor's results.
- **Tests:**
  - `tools/portfolio/sharpsports.test.js`: both shipped functions over the real migrations, against a fake SharpSports.
  - `tools/portfolio/sharpsports_ui.e2e.js`: Chromium.
  - `tools/portfolio/model_context_sql.test.js`.
  - The existing Portfolio suites are unchanged and green.
- **Live checks:** `tools/portfolio/sharpsports_smoke.js` (probe, webhooks, the ten stages).

## 2026-10-14 — Linemaker: the scheduled jobs no longer show as Skipped on every push

**`build` and `calibrate` ran on their schedules all along (the sheets every three hours, the record on Tuesdays), but they shared one workflow with the tests, so every push to `main` listed them as Skipped.** Each now has its own workflow: `.github/workflows/linemaker.yml` (tests on PRs and pushes), `linemaker-build.yml` (every three hours, or by hand) and `linemaker-calibrate.yml` (weekly, or by hand). Nothing they run or commit changed, and they still share one concurrency group so they never write at the same time. A manual run is now "Run workflow" on the one you want, instead of `linemaker.yml` with `mode`.

## 2026-10-14 — NHL: EdgeDesk's own lines against the market, and who is better where

**Research → Other → NHL now says which side EdgeDesk rates higher than the book, game by game, and whether the book's price pays enough to matter.**

- **EdgeDesk vs the market** (`lib/edgedesk_nhl_compare.js`):
  - The book's price is the one Today's Games already captures: DraftKings via ESPN's public scoreboard, or the games strip's live prices when newer. NHL capture through the gateway stays off.
  - Per market (moneyline, total, puck line when priced): EdgeDesk's probability and fair price, the book's price and no-vig probability, the gap, EV at the book's price, and the label.
  - The gap and the price are separate answers. A gap inside the model's own spread is called agreement. When nothing pays, the sentence gives the price it would take.
  - A republished price is a reference and fails the price-verified gate (`lib/edgedesk_nhl_market.js` now names it). No NHL price can be VERIFIED VALUE until the model is tested against closing prices.
- **The NHL list** opens with a board: EdgeDesk's likelier winner, the book's number, the side EdgeDesk rates higher, and whether any price pays. Each row opens its game.
- **Each game's Overview** adds the full comparison and **Who is better where**: both clubs' ratings against league average on one scale, the projected goalie, rest, and EdgeDesk's projected goals.
- **The Today's Games matchup view** for an NHL game adds one paragraph: EdgeDesk against the captured price. The slate now carries EdgeDesk's probabilities for each NHL game (`tools/slate/research.js`).
- Tests: `tools/hockey/nhl_compare.test.js` (new), and the NHL and Today's Games browser suites extended.

## 2026-10-14 — Men's college basketball research engine: team strength, player impact, lineups, matchups and scenarios, validated without odds

**EdgeDesk now has an independent research model for men's college basketball that runs without any sportsbook price. It explains who is good, why they are good, who makes them good, and how those strengths meet a particular opponent. On the held-out 2025-26 season its team ratings beat the incumbent points model. The player, lineup, scenario and style layers are each labelled by what their validation showed. A market comparison is a separate, optional layer; today it says "market comparison unavailable".** Docs: `docs/ncaam/README.md`, `VALIDATION.md`, `METHODOLOGY.md`, `METHODOLOGY_SOURCES.md`.

- **The pack** (`datapack/ncaam_v1`): three uploaded archives, 34 tables.
  - Each table's SHA-256 and row count is checked on every read.
  - The pack's own scripts are never run.
- **Audit** (`published/audit.json`):
  - **The publisher's lineup table is quarantined.** Its opening fives match ESPN starters in 1.25% of team-games; the possession table's match in 99.3%.
  - **Possession points match official finals exactly in 4,944 of 5,750 games.** 445 mismatches are a basket credited to the wrong team.
  - **The shot archive's labels need care.** `score_value` is positive on 478,588 misses, and "MadeFreeThrow" labels missed free throws, so only `scoring_play` decides made or missed.
  - **The FTA possession coefficient is fitted at 0.49,** not 0.44.
- **Identity:**
  - NCAA player ids are linked to ESPN athletes by box-score fingerprints: 4,889 of 5,011 players, with conflicts quarantined. These links catch nicknames that names would miss.
  - D1 membership is set per season, with 7 reviewed overrides. Unknown membership is a separate regime.
- **Team model:** additive opponent adjustment and tempo, with a prior from last season and transfer adjustments.
  - Tuned on 2025 and frozen before 2026.
  - On 2026 it beats the incumbent: margin CRPS −0.147 [−0.213, −0.088], log loss −0.0086 [−0.0130, −0.0036].
  - The transfer prior is not confirmed on 2026, so it is experimental. Rest showed no effect.
- **Style:** every factor is opponent-adjusted, and split-half reliability separates observed from sustainable. For example, 3P% allowed has reliability 0.24.
- **Players:** possession-level RAPM with box-score and prior-season priors, plus team-block posterior SDs and separability flags.
  - Held-out possessions are predicted better than by team ratings alone: −3.68 [−7.30, −0.09].
  - Pure RAPM is not better than team ratings.
- **Scenarios:** minutes are redistributed, never points subtracted.
  - With availability known after the fact, scenarios did not improve game predictions (+0.016 CRPS [−0.026, +0.057]).
  - Naive PPG subtraction was far worse (+3.53).
  - Scenarios are conditional and experimental.
  - The tool covers a player out, a minutes cap (foul trouble or a restriction), starter minutes to the bench, the five who close, and a player added from another team (a transfer). The matchup tool applies them to either team and shows the game with and without the scenario.
- **Lineups and interactions:**
  - Lineup results beyond player impacts did not persist (r = −0.09), so lineups pool to their players.
  - No style interaction passed 2025 → 2026, so they are shown as hypotheses and add no points.
- **Market layer:**
  - It is an adapter for the pack's `market_quotes` contract: exact moneyline, spread and total, pushes, overtime rules and de-vig.
  - It returns PASS on any failed gate: stale, suspended, unsupported, unknown rules, unconfirmed availability, or not market-validated.
  - No odds source exists for basketball, so no quote is committed or fabricated.
- **Pages** (`/research/ncaam/`): teams, team, player, scenario tool, matchup, as-of 2026 Final Four reports, 2026-27 openers (preseason carry-forward, clearly labelled), validation, data and method.
- **Registry:** the ncaab_m entry links the research engine. The board's betting brain is unchanged.
- **Tests and CI:** `.github/workflows/ncaam-research.yml` runs:
  - 82 offline checks, 20 real-pack checks and 26 browser checks;
  - a check that the frozen holdout and the published research rebuild exactly;
  - the no-bypass guard, which covers the new files.

## 2026-10-14 — Server-only functions: lock the Collective, `edge_call` and three financial views away from the browser

**The August ship-gate audit (PR #14) found that anyone holding the public anon key could call `public.edge_call`, which runs any Edge Function with the service-role key. They could also call every function in the `collective` schema, including the admin-id leak and the unchecked `billing_*` writers. Its fix never reached the repository. It would also have left all of them open, because it did not revoke the default `PUBLIC` grant.** `supabase/server_only_lockdown.sql` is the corrected fix. Paste it into the SQL editor; every report row should read `ok`.

- **What it locks:** every routine in `collective`, `public.edge_call`, `guarantee_sweep` and the four `research_*` helpers lose EXECUTE for `PUBLIC`, `anon` and `authenticated`. The three financial views lose SELECT for `anon` and `authenticated`.
- **What keeps working:** `service_role` is granted explicitly before `PUBLIC` is revoked, so the Collective edge functions and `settle-finals.yml` keep every call. `has_active_sub` and the browser's `collective_model_ensure` / `collective_my_models` wrappers are untouched. No page or admin console calls any locked function (checked against every rpc in the repository).
- **Tests** (`tools/app/server_only_lockdown_sql.test.js`, in `games-sql.yml`): 79 checks on a real PostgreSQL against a rebuild of the audited catalog, in which `service_role` holds nothing explicit. It runs each attack as `anon` and as a signed-in user, and each server call as `service_role`. It runs the file a second time as the SQL editor would (same grants after), shows the report catching a function added later, and applies the file to an empty database.

## 2026-10-14 — The college baseball research engine: every Division I game on the board, validated on a holdout it never saw, research not picks

**I built an NCAA Division I baseball engine on the warehouse: an opponent-adjusted, conference-pooled run model with run-space calibration. On 2025–26, seasons it never saw, it beats calibrated Elo (−0.0055 log loss, 95% −0.0074 to −0.0035) and is calibrated (in-the-large 0.002, slope 1.015). The moneyline is OUTCOME_VALIDATED on outcomes. Nothing has been tested against a market, because no authorised college-baseball feed exists, so the board shows prices and never a bet.** Docs: `docs/college-baseball/REPORT.md` (generated from the evidence), `college_baseball/research/`.

- **Models:**
  - Hierarchical quasi-Poisson team strength (team within conference within division), with parks, carryover and rating uncertainty, tuned on 2014–22 only.
  - Five baselines: home rate, Elo, Pythagenpat, Massey and Bradley-Terry.
  - Calibration moves the run expectations, not a probability, so every market of a game stays coherent.
  - The ensemble, GLM, boosting, rest layer, defence features and pitcher hybrid were all tested. None beat `hier_cal` under the written protocol, and all are recorded in a hash-chained registry.
- **Pricing:**
  - Every full-game market comes from one negative-binomial distribution, mixed over rating uncertainty and the seven-inning chance. It uses the run model's own expectations, re-weighted to the validated P(home).
  - The inning simulator was measured worse than the closed form on the moneyline and totals, so it prices only the first five innings, and those are research only (too extreme, slope 0.72).
- **Found and fixed during validation:**
  - The simulator, fed the calibrated expectations, double-counted the home side's last inning (+3.7 points to the home side).
  - A 20-inning cap left a few games tied, which made their moneylines incoherent.
  - A board test passed on an empty set.
  - The weekly refit would have erased the holdout record.
- **Open:**
  - The auditor refused to promote this version, because the critical TAILS check fails by 0.1 point: one side scoring 15+ is predicted at 7.7% vs 6.6% observed (U-15). Prices are shown, labelled provisional research.
  - Home −1.5 is over-predicted by about 2.5 points (U-14).
  - Tuned values sit on grid edges (U-12).
  - Commercial data rights (gate G1) and a market feed (G12) are owner decisions.
- **Terminal:** Research → Baseball → NCAA engine, with an all-games board, a game research page with seven readiness states, and advanced views (ratings, calibration, audit and the 16 release gates, the experiment registry).

## 2026-10-14 — The NHL research engine: a model lab with a written promotion rule, a full market sheet with exact explanations, player-prop research, box-score reconciliation, a source registry and an optional warehouse

**I scored seven model families against my NHL production model with its own walk-forward, under a promotion rule written before any of them ran. None earned promotion: the incumbent stays, slimmed to `xg_core`. The game page now prices the full sheet, explains every win probability exactly, re-prices goalie and what-if scenarios in place, and says why a price is or isn't actionable. Player props are researched and validated against outcomes, but no prop is called value: no prop price has been captured. Value claims stay off everywhere until a licensed closing archive passes the market test.** Docs: `docs/engine/NHL_AUDIT.md`, `NHL_LAB.md`, `NHL_PROPS.md`, `NHL_SOURCES.md`, `NHL_OPERATIONS.md`, `NHL.md`, `DATA.md`.

- **Audit** (`NHL_AUDIT.md`): the committed data and record reproduce exactly. The audit lists what existed, what was validated and what was missing.
- **Data**:
  - **Period goals** for every game since 2010-11 (`hockey/data/game_periods/`), with 0 mismatches against the finals.
  - **Box scores** (`hockey/ingest/boxscores.js`), reconciled against the play-by-play every season (`hockey/validation/nhl_crosscheck_box.json`). Agreement: team goals 99.995%, shots on goal 99.32%, power-play goals 98.20%, goalie shots against 99.49%, starters 100%, skater goals and assists 99.999%. Penalty minutes reach 97.48% once bench minors that name no player are excluded.
  - **Arenas and the schedule:** travel, time zones and congestion.
- **The lab** (`hockey/lab/`, `hockey/validation/nhl_lab.json`): goals-only ratings, a tuned Elo, the xG GLM, goalie and lineup terms, an L2 logistic regression, gradient-boosted trees (dependency-free, seeded), pair recalibration, a stacked ensemble and an equal-weight average. The lab's incumbent reproduces production to the last digit.
  - Decision: **RETAIN_INCUMBENT**. The trees are the worst model in the lab (+0.0047 log loss on confirmation), and the stack is worse than its best component.
  - **Ablation:** home ice, 5v5 xG, goals and finishing, and rest earn their places. Special teams, travel, time zones, congestion and form do not.
  - **Two amendments, each chosen by the existing selection rule:** a finer late-game period profile, and `xg_core`, which drops the special-teams block. On confirmation `xg_core` is level with the previous model (−0.00015, 95% −0.00087 to +0.00048). It still beats the tuned Elo by 0.0037 (95% −0.0054 to −0.0021). Rollback is one line (`NHL_OPERATIONS.md`).
  - **Model F:** shape terms (pace frailty, draw inflation) were rejected.
- **Extended markets** (confirmation, n 7,945):
  - OUTCOME_VALIDATED: puck lines −2.5 to +3.5, every team total, the regulation 3-way away side, the first-period 3-way sides and first period over 1.5.
  - PROVISIONAL: puck line −3.5, full-game totals (slopes 0.72–0.78), regulation totals (0.69–0.82), the regulation home side and draw (draw slope 0.68), the first-period draw, and first period over 0.5 and 2.5.
  - Pushes and no-push lines are settled explicitly.
- **Explanations** (`hockey/model/explain.js`): an exact Shapley split of each win probability over the model's factor groups, measured against a league-average club. The parts sum to the price, and the suite checks that. The desk's "Why:" sentence comes from the split.
- **Market check** (`lib/edgedesk_nhl_market.js`): VERIFIED VALUE / PROVISIONAL / RESEARCH ONLY / PASS, decided by seven gates: model validated, market tested, price captured, price under 30 minutes old, settlement, edge survives −1 sd and the worst goalie scenario, and fresh data. Each gate prints its reason. It matches `lib/edgedesk_quote_ev.js` on EV.
- **Player props** (`hockey/props/`): shots on goal, goals as a thinning of shots, assists, points and goalie saves. All 13 markets beat a fair shrunk baseline on 2020-21 to 2025-26. Defects found on the first run are disclosed in `NHL_PROPS.md`. `value_claims` is DISABLED, and `--check` fails if that changes.
- **Diagnostics and drift** (`hockey/model/diagnostics.js`): results by season, phase, month, club and starter, plus total coverage. A CUSUM and z drift monitor on the live season reads OK.
- **The game page** (`lib/edgedesk_engine_ui.js`): Overview, Markets, Scenarios, Players, Evidence, Models and Record tabs, with the source registry, at desktop and 390 px. The e2e suite walks every tab.
- **Sources** (`hockey/sources/registry.json`, `NHL_SOURCES.md`): 12 providers, each with its authorisation status, coverage, freshness, cost and measured contribution. No provider is wired on an unverified reading of its terms. Access requests to MoneyPuck, Natural Stat Trick, Evolving-Hockey, HockeyViz, Sports Reference and the NHL are drafted, not sent (`docs/engine/access-requests/`).
- **Warehouse** (`supabase/nhl_warehouse.sql`, `hockey/warehouse/sync.js`): the `nhl` schema has RLS, append-only predictions and public reads on outputs only. It is tested on a real PostgreSQL, and nothing writes until `NHL_WAREHOUSE=on`.
- **Fixes:** the slate's data freshness always read STALE (it looked up a field the games do not carry). The market test now defaults to the production model.
- **CI** (`.github/workflows/nhl.yml`): the build refreshes periods, box scores, props, diagnostics and the registry. The weekly job runs the reconciliation, the lab and the prop record. Spend is zero: no paid feed is switched on.


## 2026-10-13 — The Quant Data Pack, integrated: verified history, NHL lineups and a second source, ten new walk-forward fits (four basketball leagues, five soccer leagues, MLB), and a six-rung readiness ladder

**I imported and verified the EdgeDesk Quant Data Pack, held my NHL history to its time rule, reconciled it against a second source, and measured lineups. I then built separate, walk-forward brains for the NBA, WNBA, men's and women's college basketball, five soccer leagues and MLB, each reconciled with the pack. Basketball validates against outcomes. Soccer is level with Elo and says so. UFC, college baseball and tennis are too thin and say so. Nothing has beaten a closing market, so the board still says PASS.** Docs: `docs/engine/DATAPACK.md`, `README.md`, `METHODS.md`, `DATA.md`, `NHL.md`.

- **The pack** (`datapack/quant_v1`): 44 of 45 tables verified by SHA-256, counts and blank `known_at` in Node (`tools/datapack/verify.js`; the pack's Python is never run).
  - NFL 2022 play-by-play arrived empty and is recorded MISSING.
  - 2023 and 2024 are kept out of git and accepted only on a matching hash.
  - `engine/quant.js` ports its price and settlement math; `engine/csv.js` reads RFC 4180.
- **NHL**:
  - **Time rule:** `known_at` is blank and never backdated; an explicit `assumed_available_at` stands in, every row is `pit = RETRO`, and the team-game schema is now v2.
  - **Lineups:** box-score lineups enter the walk-forward as point-in-time lineup value. Confirmed lineups improve held-out log loss by 0.0009 (95% −0.0017 to −0.0001); projected ones do not clear the bar. No pregame feed exists, so they are a sensitivity, not the price.
  - **ESPN cross-check, 2024-25:** 1,398/1,398 games mapped, every final agrees, goals against 167/167, unblocked attempts 160/160.
  - **Contracts:** shots, goalie-game and event-context tables are mapped onto the pack's canonical contracts with zero errors.
- **Basketball** (`basketball/`): offence/defence points ratings, causal by result availability; calibration, spreads and back-to-backs are fitted on earlier seasons.
  - NBA, men's and women's college: moneyline, spread and total OUTCOME_VALIDATED. The men's and women's college models beat Elo by 0.033 and 0.049 log loss.
  - WNBA: spread and total only.
  - 209 women's college games the source lacked come from the pack.
- **Soccer** (`soccer/`): Poisson / Dixon-Coles per league on public-domain results, with quarter Asian lines settled as two half stakes.
  - 1X2 is level with a tuned Elo and stays PROVISIONAL.
  - The source's missing results are listed and make a league STALE.
- **MLB** (`mlb/history/`): Retrosheet game logs with starters, parks and negative-binomial runs. 2024 comes from the pack, with no starters. On held-out games the run model is **worse than Elo** (0.0016 log loss), so its moneyline stays PROVISIONAL; only the run line passes.
- **UFC** (`engine/lab/ufc_elo.json`): 138 scorable bouts in one year. Elo is indistinguishable from a coin flip: INSUFFICIENT.
- **The board** (`lib/edgedesk_xboard.js` v2): voids, split settlement, and a sensitivity gate. A qualifier must survive its worst scenario, a worse tick and another reference, or it is FRAGILE.
- **The app**: the Engine panel shows a six-rung readiness ladder for all 12 sports, known data gaps, settlement and sensitivity. NHL games show lineups.
- **Quality**: `EDGEDESK_CROSSCHECK.json` reconciles the pack against every brain's source; `engine/missingness.json` reports gaps by sport and season.
- **CI** (`.github/workflows/lab.yml`): suites on every PR, a daily build and a weekly refit. The NHL jobs ingest lineups and run the cross-check and contracts. Spend stays zero, and `no_bypass` §10 covers every new file.

## 2026-10-13 — The multi-sport engine: a complete NHL brain, a readiness registry for twelve sports, and one board across them

**I now price every NHL game myself — moneyline, 60-minute 3-way, puck line, totals and team totals — from shot-quality ratings and an exact score distribution, validated walk-forward on 17,236 games the model never saw. A readiness registry says, from evidence files, how far every sport has been validated, and one cross-sport board names the best-supported opportunity or says PASS and why. Today it says PASS: no sport's model has beaten the closing market, so no price is called an edge.** Docs: `docs/engine/README.md`, `NHL.md`, `METHODS.md`, `DATA.md`.

- **NHL data** (`hockey/ingest/`): 2010-11 → today from the sportsdataverse mirror of the NHL's own feeds, through a guarded client (`engine/http.js`: cache, revalidation, quotas, breaker, retries). A versioned team-game table with `known_at` and source hashes (`hockey/data/team_games/`). Every play-by-play final matches the official final.
- **NHL model**: a walk-forward xG model (`hockey/xg/`), point-in-time team and goalie ratings, a Poisson goal model with a league-scoring offset and a prior-season recalibration, and an exact score distribution with score effects, goalie pulls, 3-on-3 overtime and the shootout (`hockey/model/`).
- **The record** (`hockey/validation/nhl_walkforward.json`): 0 leakage violations. Moneyline and puck line OUTCOME_VALIDATED on 2020-21 to 2025-26 (n 7,945); beats a tuned Elo by 0.0039 log loss (95% −0.0057 to −0.0022). Totals and the 3-way PROVISIONAL. **Not tested against the close**: `hockey/model/market_test.js` is ready for a licensed archive.
- **The slate** (`hockey/slate.json`): fair prices for the next 72 h, goalie scenarios, evidence, uncertainty, invalidators, and an append-only pregame ledger with a grader.
- **Readiness registry** (`lib/edgedesk_sport_brains.js` → `engine/registry.json`) for NFL, CFB, NBA, WNBA, men's and women's college basketball, MLB, college baseball, NHL, soccer, tennis and UFC/MMA, computed from validation files, with each sport's method, sources, data, blockers and enable steps.
- **Cross-sport board** (`lib/edgedesk_xboard.js` → `engine/board.json`): EV at the actual price with pushes, shrinkage toward the no-vig market, a selection-adjusted bar for the number of markets scanned, a sanity ceiling, one opportunity per event, minimum acceptable price, and PASS with reasons.
- **The app**: Research → Other → **NHL** and → **Engine** (`lib/edgedesk_engine_ui.js`); NHL joins the research coverage (`lib/edgedesk_sports.js`).
- **The desk**: the AI desk answers NHL questions from the slate, deterministically (`hockey/desk.js` → `nhlTurn` in `edgedesk_ai`; `EDGEDESK_NHL=0` turns it off). Needs a redeploy of `edgedesk_ai`.
- **Spend**: zero by default. NHL prices need `supabase/nhl_odds_sport.sql` + `odds_api_set_sport('icehockey_nhl', true)` + `NHL_PRICES=on`; `tools/odds/no_bypass.test.js` §10 guards it.
- **CI** (`.github/workflows/nhl.yml`): suites on every PR, a 3-hourly build, a weekly validation.

## 2026-10-11 — The linemaker: one projection priced in every market, with an honest record behind each probability

**EdgeDesk's own NFL and CFB engines are now priced in every football market: spread, moneyline, total, both team totals and the alternate lines around each. Every probability carries the calibration record that stands behind it, measured on seasons the method never saw. A new Lines panel, desk answers for team totals and alternate lines, a clock on the model call, a shared AI allowance with Lite/Pro routing, the on-screen game passed to the desk, saved research on the reader's account, and a fix for a cross-user read.** Docs: `docs/linemaker/DESIGN.md`, `AUDIT.md`, `REPORT.md`.

- **Security: a cross-user read, fixed (not applied to production).**
  - The views `research_packet_grades` and `research_packet_pricing` ran with their owner's rights, so RLS on `research_packets` did not apply through them. Any signed-in reader could read every reader's packets, and on Supabase's default grants so could the anon key.
  - Reproduced on PostgreSQL. `supabase/research_packets_views_rls.sql` makes both views `security_invoker` and revokes anon. The same change is in `research_packets.sql`, with a `_rollback.sql`.
- **The calibration record** (`tools/football/linemaker_calibrate.js` → `football/validation/linemaker_{nfl,cfb}.json`).
  - Cold replays batched by week, so no game sees its own slate.
  - Four candidate methods per market: the engine, a normal, a walk-forward recentred normal, and a discrete joint team-score kernel. Each market's method is chosen on 2016–20 (NFL) / 2014–19 (CFB) by a pre-declared rule and confirmed on 2021–25 / 2020–25.
  - A market is CALIBRATED only if its confirmation window passes every rule: n, calibration-in-the-large, slope, every 5-point bin, and skill over climatology. Otherwise it is PROVISIONAL with its reasons.
  - Results: CALIBRATED for the NFL spread and the CFB total; PROVISIONAL for everything else. Team totals have no market line to grade at.
  - Probabilities at the market's own number are reported separately. Their held-out slopes are 0.17 (NFL spread), 0.30 (NFL total), −0.08 (CFB spread) and 0.21 (CFB total): the engines barely separate outcomes at the posted number.
- **The sheets** (`lib/edgedesk_fairline.js`, `tools/football/build_fair_lines.js` → `football/linemaker/fair_lines.json`).
  - Per game: fair spread, moneyline and total, home and away team totals, ladders with push probabilities, and the calibration band for every rung.
  - The price check uses `lib/research_core.js` for every piece of odds arithmetic. It reports NO VALUE, THIN or VALUE, and says VALUE only for a CALIBRATED market with an at-market band whose conservative edge is still positive and whose ROI is at least 2%.
  - The sportsbook reference is shown next to the fair line, never mixed into it.
- **The ledger and the grades.**
  - An append-only, pregame-only ledger (`football/linemaker/ledger/<season>/sheets.jsonl`). A record is written when a sheet's material numbers change.
  - `tools/football/linemaker_grade.js` grades the last pregame sheet for each game: moneyline Brier and log loss, spread and total at the close, team totals, error, and movement toward the fair number.
- **The Lines panel** (Research → Other → Lines, `#research/lines[/<game>]`).
  - Shows the slate, a game's full sheet, every market's status and reasons, the ladders, the reference market, the record, and the grades.
  - Loading, empty, error and stale states; desktop and a 390 px phone.
  - Ask about this and Save this sheet.
- **The desk.**
  - **Model clock:** 45 s per call and 100 s per turn (`EDGEDESK_AI_TIMEOUT_MS`, `EDGEDESK_AI_DEADLINE_MS`). A timeout is a 504 with its reason, never a hang.
  - **Shared daily allowance** (`supabase/ai_usage.sql`): atomic per reader with an advisory lock; the ledger is append-only.
    - Every question claims one LITE unit before any work, and a question deeper than QUICK also claims PRO. Over the PRO limit it is answered the LITE way, and over the LITE limit it is refused with the reset time.
    - A LITE answer makes no tool calls and never refreshes odds.
    - The default limits are 100 PRO and 600 LITE a day. No subscription or price changed.
  - **Screen context:** the open panel, game and market are sent as allow-listed context.
  - **Team totals and alternate lines** are answered from the sheet deterministically. They are never VALUE for a team total.
  - **Saved research** (`supabase/saved_research.sql`, `lib/edgedesk_saved_research.js`): the reader's own rows only, frozen at save, capped at 500. The device copy remains when the account save is not possible, with the reason.
- **Odds API.** The linemaker reads committed artifacts only and spends no credit. `no_bypass.test.js` now also proves that `app.html`'s `oddsFetch` has no caller and that no linemaker file reaches the gateway, capture or a provider.
- **CI:** `.github/workflows/linemaker.yml` runs the tests on PRs. It rebuilds the sheets every three hours and recalibrates weekly, and commits only when something changed and the suites pass.
- **Database (not applied to production):** `supabase/research_packets_views_rls.sql` (apply first), `supabase/ai_usage.sql`, `supabase/saved_research.sql`, each with a `_rollback.sql`. Redeploy `edgedesk_ai`.

**Tests:**
- New suites:
  - `linemaker.test.js`, 119;
  - `linemaker_desk.test.js`, 28;
  - `linemaker_ui.e2e.js`, 84;
  - `research_packets_rls_sql.test.js`, 28;
  - `ai_usage_sql.test.js`, 35;
  - `saved_research_sql.test.js`, 25;
  - `saved_research_client.test.js`, 16;
  - `ai_route.test.js`, 22;
  - `model_timeout.test.js`, 9;
  - `no_bypass.test.js`, 37.
- Every existing suite that covers this code passes.
- `intelligence.test.js` (2 of 574), `resilience.test.js`, `research_snapshots_sql.test.js` (1) and `first_run.test.js` (1) fail identically on the unmodified base commit.

## 2026-10-10 — Market resilience: research never depends on a sportsbook

**When the odds provider was down, the quota ran out, or a quote went stale, 92 of 108 games read NO MARKET. Each one was unrankable, its research interest was capped at 10, and seven of the eight 7+ point disagreements read "STALE MARKET". Now every projected game is research-visible in every market state. Market data is labelled LIVE / CACHED / HISTORICAL / MANUAL / UNAVAILABLE / FAULT, and a large disagreement is kept, explained and labelled INVESTIGATE, never promoted to an edge.** Docs: `docs/market-resilience/README.md`.

- **The biggest cause was false staleness.** The terminal build dropped the Model Lab's heartbeats, so a line re-confirmed seconds before the build read days old.
  - Heartbeats now count as observations (`TERMINAL_HEARTBEATS_CONFIRM=0` restores the old rule).
  - Today's slate: 62 LIVE, 2 CACHED and 44 UNAVAILABLE (look-ahead), against 16 fresh, 48 stale and 44 none before.
- **Two engines.**
  - `lib/edgedesk_research_engine.js` builds the independent research and never reads a market.
  - `lib/edgedesk_market_state.js` holds the six market states, the per-quote integrity checks and what each state may feed:
    - per-quote checks: market key by name, game, season, kickoff, orientation, ranges, total/spread confusion, odds format, price arithmetic;
    - cross-book checks: outliers, opposite favourites, contradictions, dispersion;
    - a lone total far from EdgeDesk's total is held.
- **Three answers, kept apart:**
  - research visibility (never decided by the market);
  - market integrity;
  - betting validation (every blocker named; ELIGIBLE only hands the price to the decision engine).
- **A research verdict per game**, for example "INVESTIGATE — 5.9-POINT DISAGREEMENT" for UCF @ Oklahoma State, or "RESEARCH AVAILABLE — MARKET OFFLINE".
- **A sensitivity panel for every 4+ point gap.**
  - Rows: current-season emphasis inside the learned prior-weight curve (it reconstructs the engine's rating term exactly), the roster adjustment, measured QB availability effects, EdgeDesk's other models, and the uncertainty range.
  - Every row is SUPPORTED, HYPOTHETICAL or MODEL, and none changes the official fair line.
  - The panel says whether the gap persists.
- **A model-only research priority:** uncertainty, mismatches, rating divergence, roster turnover, injuries, model stability, game script and relevance. It is never a ranking of bets.
- **The research page** (`research/cfb/`, `research/cfb/resilience_ui.js`):
  - the verdict and six sections on every game: Projection, Football Matchup Research, Model Explanation, Uncertainty and Limitations, Market Comparison, Research Verdict;
  - **RESEARCH ONLY** mode (header toggle or `?mode=research`): no market read, market values "Unavailable", no price cards;
  - a Research priority view and a Markdown research-brief export;
  - the assistant answers market-state, disagreement, sensitivity, total and verdict questions from stored data.
- **The 34.5 "market total" (UCF @ Oklahoma State), traced.**
  - No committed artifact ever carried it; every committed total is 52.5–54.5.
  - The verified mechanism: alternate-total ladders stored as `totals`, with every rung stamped at one time. `pickMarket` broke the tie by best price, which picks the longest shot (an Under 34.5). The app's fetch also truncated ladders from the bottom under its 5,000-row cap.
  - Fixed: the main line is the modal row, else the price nearest even money; modal rows are fetched first; totals carry their price; the brief holds an implausible total as "Unavailable — held for verification".
  - The production row itself is unconfirmed (no database access here; the query is in the docs).
- **Quota protection.**
  - `supabase/odds_quota.sql`: one atomic budget for every caller. It covers mode, breaker, exhaustion hold, in-flight coalescing, cache-first intervals, daily and monthly limits with a critical reserve, and a balance floor. The ledger is append-only and reports the credits not spent.
  - `capture`: one ledger ask per run, plus a per-run credit cap, a floor, and a stop on the first 429/401/exhausted quota or 3 timeouts. Diagnostics buy no ladders.
  - `close`: timeout, the same stop and the ledger.
  - AI-triggered refreshes: scoped to the near tier and cache-first.
  - `capture.yml`: no curl retry on the billed call.
  - Timeouts in `alternates.js` and the props factory (the props capture's single retry on timeout is unchanged: it is a pinned design, left as an open decision).
- **Audit:**
  - an append-only research snapshot ledger (`football/cfb_terminal/history/<season>/research_snapshots.jsonl`), mirrored by `supabase/research_snapshots.sql` and synced hourly;
  - append-only manual market entries (`tools/football/manual_market.js`).
- **Small fixes:**
  - the no-market summary keeps the model's own largest term instead of "No market to compare with.";
  - board rows carry the fair total, projected score and win probability.
- **Database (not applied to production):**
  - `supabase/odds_quota.sql` and `supabase/research_snapshots.sql`, each with a `_rollback.sql`;
  - redeploy `capture`, `close` and `edgedesk_ai`.

**Tests:**
- `resilience:test`:
  - the 13 scenarios, 112;
  - the quota guard on the deployed capture handler, 47;
  - the quota ledger on PostgreSQL, 48;
  - the snapshot ledger on PostgreSQL, 22.
- Every existing suite that covers this code passes.
- `content.test.js`, `evidence.test.js` and `features.test.js` fail identically on the unmodified base commit.

## 2026-10-09 — Content Engine: football evidence, not just the number

**A publisher showed us a Week 6 piece that put EdgeDesk's Ole Miss–Vanderbilt number (Ole Miss by about 1) beside a market that had Ole Miss -9.5, with no football reason for the gap. The old writer printed only the model's mechanics and "Model confidence: High"; the validator checked only that each number existed. The repair is in the shared pipeline: every featured game now carries a football evidence packet, every model–market gap is explained or called UNEXPLAINED, and an editorial gate blocks or holds what the evidence does not support.** Docs: `docs/content-engine/README.md` (*Football evidence*).

- **Evidence packets** (`lib/football_evidence.js`, `tools/content/evidence.js`): one per matchup, deterministic, from committed files only. Each claim carries its source, its time, a verification status and a scope. A model's output and the line are never counted as football evidence.
  - Coverage: quarterback efficiency, trend and availability; each offense against the other defense; personnel; form; schedule (a labelled proxy); history (dated); rest; weather; home field; conference.
  - Penalties (CFB) and turnover rates are MISSING with the reason; nothing is estimated.
  - The hourly Model Lab job rebuilds `football/evidence/packets.json`.
- **The explanation**: the gap, the model's terms, how much EdgeDesk's explainer accounts for, the supporting and contradicting football, an input audit, the critical matchup, both game scripts, the uncertainty, and a status (EXPLAINED / PARTIALLY_EXPLAINED / UNEXPLAINED). It is never actionable.
  - The audit's flags: stale line, quarterback input conflict, generic absence pricing, data conflict, cross-model outlier, DATA FAULT, home-field constant, regime change, thin sample.
  - Ole Miss–Vanderbilt is UNEXPLAINED with suspect inputs. The model expects Berlowitz while the SEC report lists Curtis probable; about 2.0 of the 9.3 points are accounted for; the measured football leans to Ole Miss.
- **The editorial gate**, in `validate()` everywhere, failing closed without the module. It requires:
  - football evidence and both quarterbacks;
  - material injuries and model–report conflicts addressed;
  - the case against EdgeDesk argued where it differs from the line;
  - an unexplained gap called unexplained and not an edge.

  It rejects:
  - causes the model's terms do not support;
  - injury statuses the report contradicts;
  - undated history;
  - wrong gap arithmetic;
  - edge language and repeated boilerplate;
  - software terms and code identifiers for publishers;
  - unknown sources and unattributed reporting.

  The number check is claim-scoped. Every report ends **BLOCKED**, **HOLD_FOR_REVIEW** (unconfirmed reporting, suspect inputs) or **READY**, with an evidence record per claim in the review panel.
- **Two new formats**, journalist-first (football question → thesis → evidence → counterargument → game script → what to watch):
  - `matchup_analysis` for publishers: prose, no software terms, manual approval;
  - `edgedesk_analysis` for EdgeDesk's own pages: a structured research page with every model input, the diagnostics and what is missing. It shares under 45% of its wording with the publisher piece. It is a library format; EdgeDesk's own articles stay out of the publisher queue.

  Discovery offers a matchup analysis for the week's top meetings and the largest gaps. Weekly slate capsules now argue both sides with football, name both quarterbacks, and disclose the gap's status.
- **The facts ledger** (`football/evidence/facts.json`, `tools/content/add_fact.js`): outside reporting with outlet, URL, date, recorder and expiry.
  - It enters as REPORTED, is linked in the copy, and holds the article until an editor runs `--verify`.
  - Seven Week 6 facts are on file: Curtis's knee and status, Lacy's shoulder, the Georgia halftime score, Florida's rushing, Ole Miss's preseason line concern, and Raiola's relief game.
- **EdgeDesk's own game pages** gain *The football behind the number*. Automatic publishing is held (manual review, with the reason) for a game with no packet, suspect inputs or unconfirmed reporting.
- **With the hardening below.**
  - The 14-check editorial gate blocks on any failed evidence check (*Unsupported factual claims*) and warns on each hold.
  - The quarterback and injury claim checks accept what the packet's official reports and attributed reporting state.
  - The writer follows qbState's rule: no "not confirmed as the starter" lines.
  - The matchup deep dive, the model-vs-market report, the conference race and the first-party features carry each game's football and disclose unexplained gaps as not an edge.
- **With the integrity layer** (Five Games to Watch and system integrity):
  - A contested quarterback job is printed as the measured dropback split, never as "unsettled" (`lib/edgedesk_availability.js` rule 3); only a sourced report may put a starter in doubt.
  - The spread check accepts a "Team by N" that the game's evidence packet quotes from the research (EdgeDesk's other models), with a word boundary, so "Georgia -1" never passes for "Georgia -17".
  - Evidence rounds half away from zero, as `lib/edgedesk_calc.js` does, so a packet and the research agree to the tenth.
  - Weekend Storylines carries each game's football, the case against and any quarterback ruled out. The Upset Watch list is gated line by line: a measured case for every underdog, a ruled-out quarterback named, and an unexplained model number disclosed as not an edge.
  - A packet's numbers stay out of the general number pool for listed games too: each is valid only in a sentence that cites its claim.
- **Cost**:
  - packets are built once and reused;
  - outside research covers featured games only, and only what is missing;
  - at most two AI attempts, the retry rewriting only the failed section, all through the shared monthly AI ledger;
  - no new paid API.
- **Database:**
  - `matchup_analysis` joins the topics and formats in `content_engine.sql`.
  - `supabase/content_engine_evidence.sql` (**apply by hand** after it) adds:
    - the floor that refuses approval without the evidence gate;
    - `content_engine_editorial_metrics()`, with editorial acceptance (including unsupported claims caught), traffic and the AI ledger's cost kept apart, and nulls where nothing is measured.
- **Edge Function** `content_engine`: carries the evidence module verbatim; redeploy it.

**Tests:**
- `content:test`:
  - the core, 317;
  - the new `tools/content/evidence.test.js`, 188: the publisher's eight failures, the old slate failing and the new one passing, adversarial edits, four more CFB games and an NFL game in both formats, cost and determinism, and today's research.
- `content:sql`: 183, and 23 for the evidence migration.
- `content:fn` 69, `content:job:test` 28, `content:e2e` 70.
- `features:test`, `articles:test` and `editorial:test`: all passing.

## 2026-10-09 — Five Games to Watch and system integrity, merged with the content-engine hardening

The hardening on `main` and this work both added an AI ledger, an approval gate and new templates. They now share one of each:

- **One AI ledger:** `content_engine.ai_calls` (6d). This work's `ai_months`/`ai_spend`, its reserve/settle doors, cost report and budget door are gone (they were never applied to production). The weekly job and the Edge Function reserve and settle through it. The $10 default stands.
  - Added: an identical request that is still in flight is refused, so it is never paid for twice.
  - A draft's calls are named on its `article_created` event, so the per-template report counts their cost.
- **Approval:** the editorial gate (6c) and the integrity verdict and research binding (6g) must both pass. The gate reports an integrity block as BLOCKED, so the two never disagree.
- **Templates:**
  - The conference race and the generator's Single Game Deep Dive and Weekend Review are main's.
  - The storyline deep dive appears only when the week's matchup deep dives do not already cover that game.
  - The scorecard replaces the acquisition report.
- **Checks that now understand each other:**
  - The spread check reads main's driver notation, "home field (Missouri +4.1)".
  - Main's number, injury and quarterback checks read the Five Games to Watch packets: alternate margins and official availability reports.
  - The gate's verification check uses the statuses the terminal writes; it never writes FAILED.
- **Quarterbacks:** main's material rule (`qbState`), plus a sourced availability report from `lib/edgedesk_availability.js`. A non-material usage split stays out of the copy.

## 2026-10-08 — Content Engine: Five Games to Watch, from verified matchup packets

**A new weekly template, in the existing content engine. It features about five games, each with where to watch it (verified network, streaming, ET and CT), why it matters, the matchup that decides it, the evidence, EdgeDesk's projection, an honest read on the upset chance and what to watch.** One verified packet per game feeds two articles: the publisher's edition, approved and sent by hand, and EdgeDesk's own page. Docs: `docs/content-engine/GAMES_TO_WATCH.md`.

- **Matchup packets** (`lib/edgedesk_matchup.js`, `tools/content/build_packets.js` → `football/content/packets.json`, hourly):
  - built from committed artifacts only; every fact has its numbers, its source and whether a reader could check it;
  - a projection, a rating or EPA never counts as evidence;
  - **reasoning gate:** six questions, and at least two independent facts per game.
- **Data truth:**
  - the sack columns are quarantined. Offense and defense views of the same plays disagree, a 13.9% against 5.4% team mean on the same 2,088 sacks, so no sack rate is printed;
  - interceptions come from the passer logs, and no turnover margin is stated;
  - results come only from verified finals.
- **Broadcasts** (`lib/edgedesk_broadcast.js`, `football/broadcasts/collect.js`, hourly):
  - ESPN's public, keyless scoreboard: ESPN-operated networks are confirmed, any other network is held until the owner verifies it from an official source;
  - stale, changed and conflicting listings are held, and postponements are withdrawn;
  - revalidated at every read and before sending;
  - verified weather or schedule moves are printed with their source.
- **Selection:** never by the largest gap. A comparable market gap is capped context, and a stale or faulted market adds nothing. One storyline per game. Count and required games are configurable; a required game that fails the gate is held for review.
- **Editions:** both written from the same facts in different words and order (24% similar for October 10). EdgeDesk's links each game's research, the free weekly email and the trial, with no campaign tags on its own site.
- **Checks:** every block listed in the docs. The review report gives READY, HOLD (verify a broadcast) or REJECT; the job rejects its own REJECT drafts automatically, with the reasons.
- **Cost:** the AI request carries the packets, not the raw research. A failure in one or two games rewrites only those sections. Every call stays under the $10 monthly cap. No new paid service.
- **First-party publication** goes through the one article store, publisher and renderer (`tools/content/first_party.js`, `article_type: games_to_watch`). It happens only when every gate passes **and** `football/content/config.json` → `first_party_auto_publish` is true. **It is false.**
- **Database** (`supabase/content_engine.sql`, re-paste; idempotent; additive):
  - owner broadcast checks (append-only);
  - the auto-reject door;
  - the publisher's response, kept apart from publication;
  - the per-template report.

  **Not applied to production.** Then redeploy the Edge Function (it carries the two libraries verbatim).
- **Owner page:**
  - Article generator → Template: Five Games to Watch, Weekly Upset Watch, Model vs. Market, Single Game Deep Dive, Weekend Review; with publisher, sport, week, count, required games, audience, headline style, date and workflow;
  - the packet and evidence preview, with missing evidence and blockers;
  - broadcast verification;
  - Performance → By template.

**Tests:**

- `content:gtw` (new, 135): the October 10 games as a frozen historical fixture, every named case, every block, and the database doors and job on PostgreSQL. It finds 72 independent facts against 12 in the old projection-only preview.
- `content:e2e` (72; +8 for the template UI).
- `content:test` (221), `content:sql` (173), `content:fn` (74), `content:job:test` (27).
- Articles (5,996), editorial (366, plus publisher, runtime and windows), integrity regression (117), matchup research (249): all green.

## 2026-10-08 — System integrity: one calculation layer, one integrity engine, and content checked against its approved numbers

**Every number EdgeDesk prints now comes from one calculation layer, and every game passes one integrity engine before it reaches a board, a brief, an AI prompt, an approval or a publisher.** Docs: `docs/system-integrity/` (start with `REPORT.md` and `OPERATING_GUIDE.md`).

- **Gaps reconcile.** `lib/edgedesk_calc.js` applies one rounding policy, and a displayed gap is always the difference of the two displayed lines. The engine's ±1 near-pick'em floor is never shown or compared: Ole Miss reads −0.2 / −9.5 / 9.3, never "−1.0 … 9.3". Projected scores add to the total and differ by the margin.
- **Time.** `lib/edgedesk_schedule.js`:
  - the slate keeps the feed's `start_time_tbd`, so a placeholder reads "time TBA", never "FRI 11:00p";
  - kickoffs are shown in the reader's chosen zone, with its abbreviation;
  - the board names the current week and badges look-ahead games "WK n";
  - future-week games never reach this week's briefs or articles.
- **The integrity engine** (`lib/edgedesk_integrity.js`). Thirty deterministic rules, each returning PASS / WARNING / BLOCKED with rule id, severity, evidence and remediation, run at seven boundaries. Research status and the decision are two answers, each with its passing and failing rules and one sentence on why they differ.
  - **Research-grade** no longer counts INVESTIGATE.
  - **Raw EV** is never an edge: the calibrator is labelled for what it is (no skill shown), and the two EV layers are never printed as one bet.
- **Markets.** Duplicate, suspended, non-equivalent, alternate-misfiled, polarity-inverted and unmapped quotes are quarantined, never deleted (`football/cfb_lab/integrity.js screenSet`).
- **Quarterbacks.** `lib/edgedesk_availability.js` assigns seven classes, each with its source and time. A missing announcement is never uncertainty, and a dropback split is a measured fact.
- **Content engine.**
  - **Selection and templates:** publishable, current-week games only; one central storyline; five new templates (Biggest Weekend Storylines, Game Deep Dive, Conference Race, Upset Watch, Weekly Model Performance Review).
  - **Checks:** every number must belong to its game; QB, conference, kickoff and spread claims are checked.
  - **Exports:** Markdown, HTML and Word are read back and carry the approved snapshot.
  - **Approval:** changed research revokes it; there is a ready-to-send checklist and a Reject state.
  - **Cost:** every Claude call is reserved against a **$10 monthly cap** and settled at its measured token cost (duplicates refused, concurrency-safe).
  - **Acquisition:** an acquisition dashboard against the 90-day targets.
- **Database** (`supabase/content_engine.sql`, re-paste; idempotent; additive). Approve, ready and send need an integrity verdict and unchanged research. Adds the AI budget tables and doors and the acquisition report. Rollout order and rollback: `docs/system-integrity/MIGRATION.md`. **Not applied to production.**
- **Edge Function** `content_engine`: reserve → call → settle; redeploy after the SQL and the merge.

**Tests:** `integrity:test` (117 checks: the 17 regression cases + a research-to-publication integration test, on PostgreSQL, required in CI), `content:test` (221), `content:sql` (173), `content:fn` (74), `content:job:test` (27), `content:e2e` (64), and every affected existing suite. `tools/app/first_run.test.js`, `tools/football/quote_ev_ui.e2e.js` and `tools/bettor/decision_ui.e2e.js` each fail one check identically on the base commit (pre-existing, untouched).

## 2026-10-08 — Content Engine hardening, and EdgeDesk's own Monday/Wednesday/Friday articles

**The content engine now refuses to approve, mark ready or send an article that does not clear a 14-check editorial gate. AI spend runs through a $10 monthly ledger. A business scorecard measures the program against its targets. EdgeDesk can publish up to three of its own articles a week on edgedesksports.com, starting in dry run.** Docs: `docs/content-engine/README.md`.

- **Editorial reliability** (`lib/content_engine.js`):
  - Projected scores reconcile with the margin and total, to the tenth.
  - Quarterback states and materiality: no doubt is written about a settled starter.
  - "Data quality", never "confidence".
  - Model–market gaps are explained from EdgeDesk's inputs, and the unexplained share is stated.
  - Weather comes from the committed forecast.
  - New checks: numbers reconcile, no confidence misuse, quarterback, injury and news claims supported, postgame results reconcile.
  - Writer fixes: NFL drafts printed `Data quality: undefined/100`; NFL injury counts appeared twice; repeated phrasing.
- **The editorial gate.**
  - 14 checks, each finding with evidence and a fix.
  - Enforced by the database: the approve, transition and send doors, and the table's own trigger.
  - Unexplained gaps need the owner's written review.
  - "Fix flagged sections" rebuilds only those sections (no AI).
- **AI cost protection.**
  - Worst-case reservation under one lock, settlement from the API's token counts, and a 30-day cache.
  - A deterministic precheck before any call, and section-only rewrites.
  - Alerts at 50/75/90%; nothing past 100%.
  - Estimated spend is kept apart from billed.
- **Measurement.**
  - Scorecard with 13 targets, the funnel, direct and assisted attribution, Stripe-reconciled revenue, costs, CAC and the bottleneck.
  - Weekly summary with sample-size guards.
- **Templates:** matchup deep dive, conference race, model-vs-market report, postgame model review.
- **EdgeDesk's own articles.**
  - Monday Weekend Model Review, Wednesday Storylines, Friday "The Weekend in Five Numbers", in Central Time.
  - Twelve publication gates; anything less is held for the owner.
  - A third article type in the existing store and build: server-rendered pages, a features hub with categories and an archive, NewsArticle structured data, one call to action, sitemap.
  - `features/records/` holds the records; `.github/workflows/edgedesk-features.yml` runs the job.
  - The owner-only `first_party` table records every run. **Default: dry run.**
- **Reader funnel** in the Growth Console (`supabase/first_party_funnel.sql`):
  - Search impressions, organic visits, visits, engaged readers (never under GPC/DNT), research clicks, registrations, trials, paid and revenue, against the 90-day targets.
- **Two bugs found by the new tests and fixed:**
  - A NULL row could slip past the first-party publish guard.
  - A NULL gate time (after an owner review) read as fresh.
- **Rollback:**
  - `supabase/content_engine_hardening_rollback.sql`, run after the previous release's `content_engine.sql`; it refuses to run otherwise.
  - `supabase/first_party_funnel_rollback.sql`.
  - Both verified on a fresh database, including rolling forward again.

**Redeploy:**
- the `content_engine` Edge Function;
- paste `supabase/content_engine.sql`, then `supabase/first_party_funnel.sql`.

**Tests:**

| Suite | Checks |
|---|---|
| `content:test` | 301 |
| `content:sql` | 183 |
| `content:fn` | 69 |
| `content:job:test` | 28 |
| `content:e2e` | 70 |
| `features:test` | 90 |
| `features:funnel` | 25 |
| `features:rehearsal` | 41 steps, against a copy of the site |

The existing article, editorial, site and growth suites are unchanged and green.

## 2026-10-08 — Content Engine: Save as PDF, and the page always loads its latest code

- **Save as PDF** in the publishing queue (the export row and the *Send it yourself* card). It opens the article's clean, script-free print view, with the tagged EdgeDesk link and the disclaimer, and the browser's print dialog, where *Save as PDF* is the destination. Word stays the format to send for editing.
- **Cache.** `admin/content/` loads `content_engine.js` and `content.js` with a new version tag (`?v=20261008b`). The Word update kept the old tag, so a browser that had the earlier page could keep running its cached code without the Word button.

**Tests:** `content:e2e` (54: Save as PDF opens the print view of the right article, script-free, with the tagged link, and calls print).

## 2026-10-08 — Content Engine: a Word file the editor can touch up, and "Mark as sent"

**An approved article now downloads as a Word (.docx) file that the publisher's editor can edit in Word or Google Docs. The quickest way to send it is now to email it yourself and press Mark as sent.** Nothing is ever sent on its own. Docs: `docs/content-engine/README.md` (*Using it*, step 6).

- **Word export** (`lib/content_engine.js` `toDocx`, no dependency). It contains:
  - real headings and bullets, a live tagged EdgeDesk link, the research credit and the disclaimer;
  - a last page *For the editor (not for publication)*: the SEO sheet, and a request to keep the link, the credit and the 21+ line and to check any change to a number with us.

  The same article always gives the same bytes. `content:example` writes one too.
- **Page.** The publishing queue leads its exports with **Download Word (.docx)**. The Send panel now has two cards:
  - **Send it yourself**: **Download Word file**, then **Mark as sent** with how you sent it. One confirmation, no typing, no "ready" step. It replaces **Record a send made elsewhere…**.
  - **Or email it from EdgeDesk**: the Send added earlier today, which now attaches the Word file first.
- **Edge Function** `content_engine`: the email's attachments lead with the Word file; redeploy it.

**Tests:** `content:test` (192, including the Word package read back with zlib's own CRC check and an XML well-formedness check), `content:fn` (61), `content:e2e` (52). The e2e takes a second article through approval, then downloads the Word file, opens and checks it, and presses Mark as sent; nothing is emailed. The Word file was also opened with python-docx, pandoc and LibreOffice.

## 2026-10-08 — Content Engine: Send to publisher

**An approved article can now be emailed to the publisher's editor from the publishing queue, only when the owner presses Send and confirms the address.** Nothing is ever sent on its own. Docs: `docs/content-engine/README.md` (*Using it*, step 6).

- **Page.** The publishing queue gains a Send panel: To (the publisher's contacts), subject, a note above the article, **Send a test to me** and **Send to …**.
  - The real send unlocks only once the article is marked ready.
  - The page names the address and asks first.
  - The old manual path stays as **Record a send made elsewhere…**.
- **Database** (`supabase/content_engine.sql`, re-paste; idempotent). `content_engine_send_claim` is owner only; the service role and the weekly job cannot call it. It checks:
  - the approved hash on screen, and `ready_to_send` for a real send;
  - a recipient who is a contact on that publisher's profile, or, for a test, the owner's own address;
  - an active publisher.

  It writes the send **before** anything goes out, with one idempotency key. `content_engine_send_result` then records a delivery (method `email`) and `sent`.
  - An unanswered send is retried with the same key and the same message, so it cannot arrive twice.
  - An address that already has the article never gets it again.
  - Sends cannot be edited or deleted.
  - The sender defaults to the outbound engine's `edgedesksports.com` sender; Settings can change it (only `@edgedesksports.com`).
- **Edge Function** `content_engine` gains `{action:'send'}`: Resend with the database's idempotency key, the article as HTML and text, the Markdown, HTML and SEO sheet attached, tagged `edgedesk=content`. It reuses `RESEND_API_KEY`; redeploy it.
- **Newsletter webhook** acknowledges and ignores `edgedesk=content` events, as it does outbound ones; redeploy `newsletter`.

**Tests:** `content:test` (179), `content:sql` (125), `content:fn` (60), `content:job:test` (23), `content:e2e` (44: add a contact → test send → mark ready → Send → recorded as sent, in Chromium).

## 2026-10-08 — Content Engine: research-driven sports articles for publishers

**A new owner-only page, `/admin/content/`, turns EdgeDesk's committed research into broad, searchable sports articles, from discovery to a publisher-ready export. Research, not picks: nothing is invented, nothing is a pick, and nothing is sent or published except by the owner.** Docs: `docs/content-engine/README.md`.

- **Core** (`lib/content_engine.js`, no dependencies; the page, the weekly job and the Edge Function run the same code). It covers:
  - research packets read from the CFB terminal, the rankings, the NFL slate, the injury report and the captured quotes. Old prices are labelled stale with their capture time, and reference lines are labelled as references;
  - six kinds of opportunity, each scored on seven parts with its basis. Search demand is an **estimate** unless EdgeDesk's own Search Console shows impressions;
  - SEO briefs; five formats; the deterministic writer; Markdown and HTML export with UTM tags;
  - the validator, which fails invented numbers or teams, pick or guarantee language, projections presented as bets, stale prices called current, unattributed reporting and near-duplicates.
- **Database** (`supabase/content_engine.sql`, a private schema with owner doors on the outbound owner list):
  - **Approval** is bound to the exact content hash and the five-point review; an edit after approval returns the article to review.
  - **Sending**: `sent` needs a delivery record, and sent content is frozen.
  - **Budgets**: AI calls and feed fetches count against a daily budget before they are made.
  - **Measurement**: first-party conversion counts by campaign code; owners are excluded and no identity is returned.
  - **Seed**: Stadium Rant, editorial preferences only. Contacts and benchmarks are entered in the page, never in this public repository.
- **Edge Function** `content_engine` (Claude rewrites checked before they are saved, and the trending RSS fetch). Needs the **Deploy content engine function** workflow; `ANTHROPIC_API_KEY` is optional.
- **Weekly job** `.github/workflows/content-engine.yml` (Tue/Wed): discovers topics, then drafts at most `drafts_per_run` (default 2) into the review queue. One run per week; the owner's switch turns it off. Existing secrets only.
- **Links** to the new page from the growth, acquisition and SEO consoles.

**Tests:** `content:test` (177), `content:sql` (98), `content:fn` (40), `content:job:test` (23), `content:e2e` (30: discover → outline → draft → AI rewrite → review → approve → export → record send → publish, in Chromium against a real PostgreSQL).

## 2026-10-08 — Product-led growth, phases 1–2: free research first

**Free research is the front door; Full Access ($49.99/month, 7-day free trial) is one step behind it. Nothing in billing changes.** Audit and the five-phase plan: `docs/product-led-growth/PLAN.md`.

**Security fix:**
- **the AI desk let the public anon key through.** `edgedesk_ai` treated a 401 from the subscriptions read as "could not be checked"; anon cannot read that table, so the key in every page's source got paid inference. It now refuses an `anon` token and any 401/403 (404/5xx stay fail-open for paying readers) and uses the database's 21-day past-due grace instead of 3. Needs the Deploy intelligence workflow (build `edgedesk_ai-2026-10-08-r21-anon-gate`).

**Found and not fixed here (PLAN.md §2):** premium research is committed as public static JSON in a public repository (`football/cfb_terminal/`, `football/props/`, the slates) and `/research/cfb/` renders the CFB board with no sign-in — Phase 2b; `collective_public` uses a looser entitlement copy; `paywall.sql` is not in the repo.

**Navigation:** one primary nav on every public page — Free Research, Today's Games, Tools, Research Terminal, Pricing (`lib/edgedesk_nav.js`; `tools/site/nav.test.js` fails on drift). Articles rebuilt (header and footer only).

**Today's Games (`/today/`):** the week's NFL and FBS slate in the reader's time zone, each game with its free research and EdgeDesk's public read where the free board has one; `football/home/schedule.json` (no model numbers) built beside the home board.

**Landing page:** free research first — the first action, a working no-vig calculator in the hero instead of a sample of an unbuilt feature, a `#free` section before any pitch, a Free card beside Full Access, nothing in development on either price card.

**Freemium access map:** `lib/edgedesk_plans.js` (free / Full Access / planned, with the door or gate for each) and `lib/edgedesk_flags.js` (UI-only flags; never read by access code). `tools/site/free_access.test.js` (122): free pages use anonymous doors only, anon grants match the SQL, no premium artifact is fetched by a free page, no secret in a served file, the desk's gate is pinned.

**Tests:** new `site:test` (nav 493, free access 122); landing positioning 466, interaction 203, landing e2e 249, public pages e2e 130, home 142, intelligence §32 +13; `checkout_flow.e2e.js` repaired (failed on main) — 40.

## 2026-10-08 — Outbound: replies read from Resend

**A reply ends that person's sequence by itself, the way "They replied" does.** Resend's signed `email.received` event arrives through the existing outbound webhook. The database checks the signature, then matches the sender's address, whole and alone, to the last live email that went there in 180 days. Details and setup: `docs/growth-outbound.md`, "Replies".

- **A reply:** the prospect becomes replied, unsent follow-ups are cancelled, and the results count it.
- **An out-of-office or automatic answer:** noted; nothing changes.
- **"Unsubscribe", "remove me", "stop emailing" in the subject:** the address is suppressed, always, even with detection off.
- **A reply to a test email:** noted as a test (how the setup is proved).
- **From nobody we wrote to** (or a colleague at the same domain): kept masked, without a subject.
- **Only the event's metadata** (sender, subject), never the body. Forged events are refused, and repeats count once. It can only ever stop emailing someone, never send.
- **Setting** `reply_detection` (on). **Table** `replies` (the twenty-first, append-only, deny-all). **Owner door** `growth_outbound_replies`; the prospect page lists replies; the daily email counts them; report row 39.
- **Console:** Outbound → Replies; the setting under Follow-ups.
- **The newsletter's webhook** now ignores received mail, keeping a reply's sender and subject out of its tables.
- **Setup** needs no DNS: a mailbox rule forwards copies to Resend's receiving address, and `email.received` is added to the outbound webhook in Resend.
- **Tests:** `outbound_replies_sql` (43), lifecycle step 10 (53), events (66), concurrency race Y (24), console e2e sections 61–62 (305). Mutation-checked: 28 of 29 breaks caught; the survivor is benign.

## 2026-10-08 — Outbound: the owner's daily email ("N drafts are waiting for your review")

**One short note a morning, to the owner only, when the morning run leaves drafts for review.** Off until turned on (Outbound settings → Morning run). It never goes to a prospect, never sends a draft and never counts against the daily cap. Details, deploy order and rollback: `docs/growth-outbound.md`, "The daily email".

- **Whom:** the confirmed address of the outbound owner who turned it on, looked up every time it is written. There is no address field. A removed owner, an unconfirmed address, or an address that is also a prospect's: nothing is sent.
- **What:** counts only: drafts waiting (first emails and follow-ups), how many the morning run wrote, approved and unsent, what may still go out today, System-check items in fixed words, and the console link. No name, address, organization or draft.
- **When:** once the morning run has nothing left to do, or its window closes (up to 12 hours after). Once a morning at most. A morning with nothing to review is recorded as skipped, with no email.
- **How:** the tick mints a single-use ticket (its hash kept) for a new Edge Function, `growth_outbound_digest` (project URL, anon key, `RESEND_API_KEY`; no service-role key; refuses browsers). The ticket opens two doors (write it; record what became of it) and nothing else. Tried again only when it surely did not go, at most three times.
- **Database:** `digests` (the twentieth table, deny-all, never deleted), `digest_enabled` / `digest_owner` settings, the morning-run panel's `digest`, report row 38, attention items `digest_failed` and `digest_no_recipient`. Still three public doors.
- **Console:** the setting shows the address it goes to; the morning-run panel shows today's email (sent, skipped, on its way, or why not).
- **Tests:** `outbound_digest_sql` (102), `outbound_digest` (45), lifecycle step 9 (48), static (40), console e2e sections 58–60 (295). 63 of 66 deliberate breaks were caught; the other 3 are layered safeguards.

## 2026-10-08 — Growth engine: organic discovery, free tools, attribution end to end

**Visitor → research page or tool → trial → paid, measured by channel. Built on the existing articles, attribution, funnel, newsletter, outbound and partner systems; nothing touches billing.** Audit: `docs/growth-engine/AUDIT.md`; deploy order and Search Console setup: `docs/growth-engine/README.md`.

**Security fixes:**
- **`.github/workflows/newsletter.yml`:** dispatch inputs were interpolated into shell steps holding the service role and Resend keys. They now pass as environment variables, each checked against a closed list or an address pattern;
- **test sends no longer print live unsubscribe tokens** or full addresses to the Actions log;
- **`newsletter_cron` requires the service role** or a signed-in newsletter operator (it was callable by anyone);
- **newsletter confirm and preferences are button presses** on static pages (`/newsletter/confirm/`, `/newsletter/manage/`), not GET side effects a link scanner can trigger; the lifecycle unsubscribe page waits for a press too;
- **a confirmed subscriber cannot be changed from the public form** (it is mailed its own preferences link, once per cooldown); a global hourly cap, a per-address daily cap, a honeypot and a keyed client-address hash limit abuse.

**Attribution:**
- **`lib/edgedesk_public.js`** on every public page: the landing page's first-touch rule, an acquisition visit when it can matter, partner clicks, page views, CTA presses, GA4 unless Global Privacy Control or Do Not Track. Search traffic that read an article before the trial was being recorded as direct;
- **`newsletter` and `outbound_email` are channels** (`acq_classify`, constraints widened in place); newsletter links carry `utm_campaign=nl_<sport>_<date>`;
- four public events in `user_event_kinds`: `public_page_view`, `tool_used`, `public_cta_clicked`, `newsletter_signup`.

**Free tools (`/tools/`):** no-vig calculator (four methods, the terminal's own arithmetic), fair odds calculator, and the model vs market explorer (the landing board's public subset; no EV, no props). Crawlable pages with the working shown; `robots.txt` allows exactly these under `/tools/`.

**Research pages:** a trial CTA near the top and at the end with the terms as priced, "More EdgeDesk research", links to the tools/methodology/newsletter, no links to unpublished pages (14 were dead), a played-game notice, trailing-slash canonicals and sitemap entries, a real 1200×630 share image, hub breadcrumbs, hubs at about half their weight, a corrected meta description, the sitemap index dated by its children.

**Newsletter:** "major findings" and "product updates" topics (product with its own consent; captured only — no sender yet).

**Outbound:** each draft links to the page that fits the prospect (`growth_outbound.landing_for()`, switchable); `/partners/` for newsletter operators and creators. Approval is untouched: nothing sends without the owner.

**Owner dashboards:** `/admin/acquisition/` (`supabase/growth_engine.sql`): channels, landing pages, campaigns, tools, CTAs, newsletter, trials, paid, cash by channel, measured MRR and two labelled estimates, outbound by landing page, Search Console, partner review flags (changes nothing), weekly frozen reports (`growth_engine_cron.sql`). `/admin/seo/`: `tools/seo/audit.js` checks every public page for crawlability, canonical, title, description, share image, structured data and broken links; rewritten on every article build.

**Search Console:** `tools/growth/gsc_import.js` and a daily workflow, idle until `GSC_SERVICE_ACCOUNT_JSON` and `GSC_SITE` are set.

**Tests:** new `growth_engine` (236), `growth_engine_sql` (53), `newsletter_growth_sql` (31), `outbound_landing_sql` (26), `public_pages.e2e` (90), `seo:audit --check`; `.github/workflows/growth-engine-tests.yml`. Existing suites updated for the intended changes and passing.

## 2026-10-08 — Growth console: providers, qualification and volume (outbound engine, phase 12)

**The aim: wake up to 10–15 qualified potential subscribers with drafts, and send only the ones you approve.** Nothing added here can approve or send.

**Found and fixed:**
- **partners got the subscriber pitch:** `campaign_type` existed but nothing set it, and the engine drafted the $49.99 subscriber email for media and affiliate leads too. Claude now reads who someone is (subscriber, media partner, affiliate, business partner), the engine drafts for potential subscribers only, and the owner's choice is never overridden;
- **the daily target counted reads, not results:** the morning run now researches until `daily_qualified_target` new subscribers qualify (12 by default), reading at most `daily_prospect_target` candidates;
- **engine follow-ups left out the price:** every engine email now states the 7-day free trial and $49.99/month, links to EdgeDesk and stays under 150 words;
- **nothing refused free or special access or picks talk:** the content rules now refuse complimentary, comped, discounted, early or VIP access, promo codes, and "best bets" or "picks of the day";
- **a lookup's note was lost:** `runResearch` overwrote it (for example "Hunter answered 429"); notes now reach the answer and the run's record;
- **the console could send settings the database does not have yet:** a setting the database did not report is never sent.

**Added:**
- **the 0–100 qualification score**, computed from evidence. Product relevance 35, analytics 25 and purchase signals 15 come from capped parts of the fit catalogue. Contact quality 15 comes from the address, the identity and a site of their own. Personalization 10 counts the facts an email may cite. Penalties are subtracted. It is a gate (75 by default), the queue's order, and re-checked at approval. Eight new catalogue reasons, including sportsbook staff and a sports-industry job without analytics work;
- **providers behind interfaces,** switched on and off in the console: Brave and Apollo for search, Hunter and Apollo for email lookup, Hunter for verification, Clay for enrichment. Apollo yields only addresses it marks verified, and its "verified" counts as one source, not two. Clay goes out by its table's webhook or a CSV and comes back by CSV import as Clay's word: never verified, never a new prospect;
- **the verify step:** waiting addresses are put to the verifier, and every verdict is kept;
- **send warm-up:** 10 a day at first, plus 5 a week, never past the cap;
- **the sending domain's check:** SPF, DKIM and DMARC over DNS-over-HTTPS. A missing record blocks live sending;
- **`growth_outbound_draft_check`:** the engine's rules on a draft, writing nothing;
- **the dry-run harness** (`tools/growth/outbound_dryrun.js`);
- report row 37.

**`/admin/growth/` → Outbound:**
- **This morning:** qualified today against the target, review, today's cap, verification and enrichment waiting, the domain, partner leads;
- **each card:** the score in its parts, why they fit, the address and its verification, where to read up, what the email should still say;
- **elsewhere:** a segment switch on each prospect; provider switches, verify, Send to Clay, Export and Import; Check the sending domain; warm-up and qualification settings.

**Tests:**
- new suites: `outbound_qualify_sql` (163) and `outbound_providers` (43);
- console e2e: 283;
- 33 deliberate breaks, all caught;
- every earlier suite passing.

**Docs:** `docs/growth-outbound.md`, Phase 12: the audit, the scoring rules, providers and Clay, deploy (nothing deployed), capacity, rollback.

## 2026-10-08 — Growth console: testing and hardening (outbound engine, phase 11)

**Each phase was tested on its own. Phase 11 tests them together, at the same instant, and against junk, then fixes what that found.**

**Found and fixed in `supabase/growth_outbound.sql`:**
- **two overlapping batch approvals deadlocked:** a batch now locks its drafts up front, in one order;
- **two ticks at once could each start a morning-run step:** the tick now takes a lock;
- **two discovery runs finding the same new address deadlocked:** recording candidates now takes a lock;
- **a test send used up the real prospect:** their first email counted as sent, so after going live it was never drafted, and their status stuck at "ready for review". A test send is now a dry run, the status refreshes when a send is claimed, and a follow-up's context lists only what reached them;
- **a trial in the same second as the email could go uncounted:** Stripe stamps whole seconds. A trial or payment now counts for any account made after the email, never dated before the account;
- **a numeric date in evidence raised a raw database error:** every malformed-data error (SQLSTATE 22) is now refused in words.

**Added:**
- **`self_check()`:** the file's report as a function, so the console runs the same checks;
- **`growth_outbound_health()`:** owner only, changes nothing. It returns those checks plus what needs attention, most serious first, each with what to do: complaints, bounces, a silent webhook, unconfirmed sends, a stopped clock, failing runs, matching errors, unsent approvals, blockers and a raised cap;
- **the sweep:** the tick marks a send unconfirmed for 23 hours as failed;
- report row 36.

**`/admin/growth/` → Outbound:** a System check line at the top and a System check panel.

**`tools/cfb/secret_audit.js`** (every PR) also finds Resend API keys, webhook signing secrets and the outbound providers' keys assigned in code. Svix's published example is a fixture only inside tests.

**Tests:**
- new suites:
  - `outbound_lifecycle` (39): five functions and one database, the whole life of three prospects;
  - `outbound_concurrency_sql` (22): nine real races;
  - `outbound_fuzz_sql` (17, seeded): helpers and public, owner and engine doors;
  - `outbound_health_sql` (31);
  - `outbound_static` (36);
- console e2e: 246; send SQL: 50;
- 28 deliberate breaks, all caught;
- every earlier suite passing.

**Docs:** `docs/growth-outbound.md` gains a pre-launch checklist, the morning routine and what to do when something goes wrong ("Operating it").

## 2026-10-08 — Growth console: results and attribution (outbound engine, phase 10)

**A result is matched, never guessed.**

**`supabase/growth_outbound.sql`** adds:
- **tagged links:** a live email's links to edgedesksports.com carry `utm_campaign=ob_<the prospect's random token>`. A test send's links carry `ob_test`. Punctuation, fragments, existing utm tags, subdomains and look-alike domains are left alone. The review preview is the message as sent, and each send records whether its links were tagged. A setting turns tagging off;
- **the matcher, `sync_conversions()`:** a visit, an account, a trial or a payment counts for a prospect only by their email's campaign code or the address written to. It must also come after the first email, and that email must have reached them. Never an owner's, a test's or an earlier account's. Trials and payments come from Stripe's own record;
- **the record:** `growth_outbound.conversions`, append-only, written by the matcher only, storing a one-way key instead of the account (19 tables);
- **the end of a sequence:** an account makes a contacted prospect converted, cancels their unsent follow-ups, and the send door checks again before any follow-up;
- **customers are never cold-emailed:** an address with an EdgeDesk account is left out of drafting, refused at approval and refused by the send trigger;
- **when it matches:** hourly from the scheduler's tick (whether or not the morning run is on), whenever Results is opened, and for one prospect before each follow-up. A failure is recorded and never stops the tick;
- **the results door, `growth_outbound_analytics(days)`:** owner only:
  - the pipeline, what Resend reported, and what the people written to did, as rates;
  - by step, writer, prospect type, search and fit, with 95% (Wilson) ranges;
  - what stands out: only groups of 10 or more whose whole range is clear of the average;
  - by day, in the owner's zone; provider calls; the latest results;
  - no account, address or key ever leaves;
- report rows 34–35. The drafting stats count replies, not signups.

**`/admin/growth/` → Outbound:**
- the **Results** panel;
- review cards show the tagged links, and block an address that already has an account;
- each prospect lists its results;
- a **Results** settings group (link tagging).

**Tests:**
- `outbound_analytics_sql.test.js`: 100 checks; 69 mutations, 66 caught and 3 equivalent;
- console e2e: 236; security suite: 422;
- earlier suites: all passing.

## 2026-10-08 — Growth console: the morning run (outbound engine, phase 9)

**Software may find, research, score, verify, draft and queue on a schedule. It may not approve or send.**

**`supabase/growth_outbound.sql`** adds:
- **the plan and the tick:** every five minutes (pg_cron) one step of today's morning run, in the owner's own time zone and window. It searches the saved searches once, researches up to the daily target, then drafts up to the daily send cap. It never runs two steps at once and stops for the day after three failures in a row;
- **single-use tickets instead of credentials:** each step's run gets 256 random bits, stored only as a hash, posted once through pg_net, alive 15 minutes, while the run runs and automation is on;
- **the third public door, `growth_outbound_scheduled`:** a ticket opens only the engine doors its run's kind needs, for its own run. Those doors now begin with `require_engine()`: the owner, or a ticket checked again against its hash. Every door that approves, edits, sends, suppresses or changes settings still requires the owner;
- **records and settings:** the automation window settings, the scheduler record (18 tables), the owner's automation overview, and report rows 32–33.

**`supabase/growth_outbound_cron.sql`** (new): the clock, one pg_cron job, no key.

**`growth_outbound_research` and `growth_outbound_draft`:** `{action: 'scheduled', ticket}`. There is no owner token. Every call goes through the ticket door, and what to do comes from the database. Owner requests are unchanged. A follow-up or first email with nothing citeable is now recorded as given up, so the due list leaves it alone until new evidence arrives.

**`/admin/growth/` → Outbound:**
- the **Morning run** panel: on or off, the window, the clock, the next step, today's progress and the steps;
- the window settings;
- turning Automation on asks first.

**Tests:**
- `outbound_schedule_sql.test.js`: 112 checks; 42 mutations, all caught;
- research function: 99; drafting function: 76; the scheduled mode's 17 mutations, all caught;
- console e2e: 208; security suite: 416;
- earlier suites: all passing.

## 2026-10-08 — Growth console: the drafting engine (outbound engine, phase 8)

**The engine may draft. It may not approve or send, and it may not say anything about a person that the database cannot cite.**

**`supabase/functions/growth_outbound_draft`** (new; owner only, no service-role key):
- **what it writes from:** for each prospect due a first email or a follow-up, the database gives the facts that may be cited (each sure enough on its own to clear the research gate) and the first name only if the evidence establishes it;
- **how it writes:** Claude (official SDK, `claude-opus-5-5`, low effort, structured output, server-side refusal fallback) writes, citing each fact it uses in that fact's own words;
- **who decides:** the database. If it refuses, Claude gets the objections and one more try; then a plain template from the best fact, checked the same way;
- **when nothing passes:** nothing is drafted, the reasons are recorded, and that step leaves the due list for a week;
- it never calls a door that approves, edits or sends.

**`supabase/growth_outbound.sql`** adds:
- **`growth_outbound_draft_propose`**, the engine's only way into the review queue. Every claim must be this person's current, citeable, confident evidence, in its own words, said in the email. No figure, brand, name or capitalised detail may come from nowhere, and a sentence about them ("your …") must carry a claim. The greeting is "Hi <established first name>," or "Hi there,", never a guess. The step must be due, and the content rules hold;
- **who is due** (`drafting_due`): first emails for qualified prospects, and follow-ups on the configured cadence;
- **the context**, **gave-up** and **overview** doors (who is due; how the engine's drafts fare: approved as written, after your edit, rejected);
- **at approval:** an unedited engine draft is approved only while its greeting matches the first name as the evidence stands now;
- **at sending:** a live follow-up goes only while it is turned on, after the step before it went out (and did not bounce or fail), and once its delay has passed;
- `research_runs.kind = 'draft'` (a drafting run spends only on Claude; the research doors refuse it), `drafts.run_id`, and report rows 30–31.

**`/admin/growth/` → Outbound → Review queue:**
- whether Claude writes, and today's use;
- who is due, and how the engine's drafts fare;
- **Write the next drafts**;
- each card says who wrote it, and a greeting the evidence no longer supports blocks approval;
- rejecting an engine draft says the engine reads your reason.

A prospect gains **Let the engine write it**. Fixed: a follow-up for a contacted prospect can now be selected and approved on the page (the database always allowed it). "Claude reads / day" is now "Claude calls / day": research and drafting share it.

**Tests:**
- `outbound_drafting_sql.test.js`: 139 checks; 72 mutations, all caught except two that cannot change behaviour (explained in the docs);
- `outbound_draft.test.js`: the deployed function against the real SQL, 66 checks; 30 mutations, all caught;
- console e2e: 191;
- the send suite: adds the follow-up cadence;
- `tools/growth/_rpc_shim.js`: the PostgREST stand-in, now shared by both function tests;
- earlier suites: all passing.

## 2026-10-07 — Growth console: discovery and research (outbound engine, phase 7)

**The engine may find, read and verify. It may not approve, draft or send, and it may not make anything up.**

**`supabase/functions/growth_outbound_research`** (new; owner only, no service-role key):
- **search:** Brave Search results become candidates, not prospects;
- **research:** reads up to four of a candidate's own pages, obeying robots.txt and guarded against SSRF (https only, no private or reserved hosts, every redirect re-checked, size and type caps);
- **facts as quotes:** Claude (official SDK, `claude-opus-5-5`, low effort, structured output, server-side refusal fallback) proposes facts as quotes, and every one is checked against the page before it is kept; JSON-LD is read the same way;
- **business address:** from their own site, or Hunter's find for that named person at that domain, then Hunter's verifier.

Made-up or unsupported facts are dropped and reported, never fixed. Every provider key is optional; without one, the console says that provider is not set up.

**`supabase/growth_outbound.sql`** adds:
- **stored pages:** append-only, hashed by the database;
- **candidates** and **research runs**;
- **a daily provider budget:** set by the owner, with ceilings in the file, enforced before every call;
- **engine evidence checked in the database:** it cites a stored page, the quote is on it (whole words), and the claim is in the quote. Whether a page is the prospect's **own** site or profile is the database's decision, never the engine's, and a publisher is nobody's own site;
- **the research doors:** a URL or address naming somebody else is left out rather than merged, and a verifier's "invalid" makes the address unusable;
- report rows 27–29.

**`/admin/growth/` → Outbound → Discover and research:**
- provider status and today's budget;
- search and saved searches;
- the candidate queue (Research, Dismiss, Put back, Research the next one);
- the budget form and recent runs;
- **Research again** on a prospect.

`lib/edgedesk_admin_session.js`: `invoke(fn, body, { timeoutMs })` for one slow call.

**Tests:**
- `outbound_engine_sql.test.js`: 124 checks; 31 mutations, all caught;
- `outbound_research.test.js`: the deployed function against the real SQL, 83 checks; 26 mutations, all caught;
- console e2e: 171;
- admin session: 85;
- earlier suites: all passing.

## 2026-10-07 — Growth console: what comes back (outbound engine, phase 6)

**A hard bounce, a spam complaint, an opt-out or "please stop" ends email to that address for good. Nothing from outside changes a send unless it proves where it came from.**

**`supabase/growth_outbound.sql`** adds:
- **Resend's events, verified in the database** (`growth_outbound_webhook`): the Svix signature (HMAC-SHA256 written in SQL, checked against RFC 4231 on every run) within five minutes, before anything is read. Repeats are applied once. Delivered, delayed, opened and clicked are recorded and never move a send backwards; a hard bounce, a complaint or Resend's own suppression suppresses the address and cancels follow-ups; a soft bounce does not; a test send never suppresses; an event about any other email leaves only its id;
- **the signing secret**, set in the SQL editor only (`select growth_outbound.set_webhook_secret('whsec_...');`), refused through the API by the function and by a table trigger, never returned. **Live sending is blocked until it is set**;
- **the opt-out door** (`growth_outbound_optout`): a send's 64-hex token, a masked address, nothing changed without confirmation, nothing changed for a test send, twice is once;
- **replies** (`growth_outbound_prospect_replied`): follow-ups stop; "asked to stop" also suppresses;
- **exactly two doors anon may call** (the webhook and the opt-out), each opening with its own proof; signed-in callers cannot call them. Every other door is unchanged;
- append-only `provider_events`, `sends.opened_at` / `clicked_at`, the webhook's status in settings, and report rows 23–26.

**New Edge Functions** (neither holds a secret; both deployed by the manual outbound workflow, now "Deploy outbound Edge Functions"):
- **`growth_outbound_webhook`** relays Resend's raw body and signature headers to the database; unsigned → 401, database down → 503;
- **`growth_outbound_optout`**: the RFC 8058 one-click POST stops email; a GET changes nothing and redirects to **`/email/stop/`** (new static page), the token in the fragment, which asks before stopping.

**`supabase/functions/newsletter`**: its webhook now acknowledges and keeps nothing about an outbound email (tagged `edgedesk=outbound`), so a prospect's address never lands in the newsletter's tables. Redeploy it.

**`/admin/growth/` → Outbound:** whether Resend's events can arrive and when the last did; the webhook secret among what live sending needs; opened and clicked on each send; **They replied** and **They replied: stop emailing them** on a contacted prospect (asked first).

**Tests:**
- `outbound_events_sql.test.js`: 124 checks; 34 mutations, all caught;
- `outbound_events.test.js`: 65 checks on the deployed functions and the newsletter's skip; 13 mutations, all caught;
- `outbound_stop_page.e2e.js`: 25 checks in Chromium; 6 mutations, all caught;
- console e2e: 146;
- earlier suites updated for the two public doors and the live-send secret: all passing.

## 2026-10-07 — Growth console: sending (outbound engine, phase 5)

**Only an approved draft, only when the owner presses Send.**

**`supabase/functions/growth_outbound_send`** (new) is the only code that sends outbound email. For each draft it:
1. verifies the owner (GoTrue, then `growth_outbound_is_owner()` asked as the caller);
2. claims the send in the database first;
3. sends through Resend, from `Davis <davis@edgedesksports.com>`, with one Idempotency-Key per draft;
4. records the answer.

A message that is not one EdgeDesk email to one person is never sent. The function holds no service-role key. It is deployed manually by `.github/workflows/deploy-growth-outbound.yml`.

**`supabase/growth_outbound.sql`** adds:
- **the claim door** (`growth_outbound_send_claim`): it re-evaluates the prospect, writes the send row through the send trigger (every rule re-checked), marks the draft sent, and returns the message exactly as it must go out. That message carries the footer with the postal address, this send's own opt-out link, and RFC 8058 `List-Unsubscribe` headers;
- **the result door** (`growth_outbound_send_result`):
  - a Resend id → `sent`, and a real step-1 prospect becomes `contacted`;
  - a permanent refusal → `failed`, never retried;
  - anything else stays claimed, for a retry with the same key;
- **no second send, ever:**
  - claiming again returns the same key;
  - a sent or failed send is never re-sent;
  - an outcome unknown after 23 hours is abandoned, not retried;
- **a personal opt-out token on every send** (immutable);
- **test sends without the opt-out endpoint:** a test send, only ever to the owner's test inbox, needs the postal address and the test inbox; a live send also needs the opt-out endpoint (Phase 6). Settings now return both lists;
- **`growth_outbound_sends`** lists every send; report rows 21–22.

**`/admin/growth/` → Outbound:**
- **Send test** / **Send now** on approved cards (asked first);
- **Send all shown** (the count typed);
- a **Sends** table with **Try again** for an unanswered send;
- what live sending still needs;
- a missing function or Resend key said in words.

**Tests:**
- `outbound_send.test.js`: 48 checks on the deployed function; 9 mutations, all caught;
- `outbound_send_sql.test.js`: 46 checks; 10 mutations, all caught;
- console e2e: 128;
- earlier suites: all passing.

## 2026-10-07 — Growth console: the review queue (outbound engine, phase 4)

**Software may draft and queue; only the owner approves, and approving sends nothing.**

**`supabase/growth_outbound.sql`** adds:
- **content rules** (`draft_lint`), enforced at approval for every draft: no promised winnings, locks or guarantees; $49.99/month only; a 7-day free trial only; edgedesksports.com links only; nothing unfilled; no fake "RE:";
- **a cited claim must be in the email's words**, so an edit that drops it cannot be approved;
- **one approve implementation** (`approve_one`) behind both approve doors. It re-evaluates the prospect, and refuses any session that is not the signed-in owner;
- **batch approve with a typed count:** the count must equal the selection, 1–25 drafts, all or nothing, every reason returned;
- **withdraw** an approval before sending;
- **owner-written drafts:** every claim cites current evidence of that prospect and appears in the words;
- **the queue door,** with fresh assessments and the message exactly as `compose()` builds it (footer included, the test inbox in test mode);
- **a test prospect and draft** at the owner's own test inbox, idempotently.

**`/admin/growth/` → Outbound** opens on the review queue. Each card shows:
- the message as sent;
- each claim with the evidence, source and words behind it;
- the gates and broken rules in words.

**Actions:**
- approve (asked first);
- approve selected (the count is typed);
- edit inline, reject, withdraw;
- the test-draft button;
- "Write a draft" in the prospect panel.

Disabled buttons now look disabled.

**Tests:**
- `outbound_review_sql.test.js` (85, 16 mutations all caught);
- `outbound_sql.test.js` (269);
- `outbound_research_sql.test.js` (162);
- `outbound_console.e2e.js` (110).

## 2026-10-07 — Growth console: who a prospect is, what is known, and how sure (outbound engine, phase 3)

**A fact about a person is evidence; every number the gates read is computed from it.**

**`supabase/growth_outbound.sql`** adds:
- **identity:** `identifiers`. An email address or a profile handle (x, YouTube, Substack, LinkedIn, GitHub, podcasts, …) names one prospect. `canonical_url()` strips tracking parameters, `www.`/`m.`/`mobile.`, casing and the rest, so rediscovery finds the same row. Keys belonging to two prospects return `identity_conflict` and write nothing. A suppressed address, domain or prospect is never re-added or re-researched. Websites and name+organization are weak keys: they flag a possible duplicate, never merge, and block a second live send of the same step. A key on the wrong person can be released, and stays on the record;
- **evidence that can be checked:** a known field, a web page, the kind of source and the words on it. Email-only kinds stay email-only; provider and owner attestations come only from a provider or the owner. An employer is never read off an email domain. The collector's own confidence is discarded. Evidence is superseded once, with a reason, and never rewritten;
- **the arithmetic:**
  - independent publishers combine (1 − ∏(1 − weight)); the same site repeating itself is one source;
  - a rival claim halves the confidence;
  - old roles and old content weigh less;
  - a first name is used only when identity clears its bar and the name plainly has one;
  - "verified" email means the owner or a provider checked it;
  - research confidence is the weakest claim a draft cites;
  - fit comes from a fixed catalogue, and a positive reason counts only with current evidence;
- **computed means computed:** a trigger refuses any write to a name, confidence, score, email status or research status, the superuser's included. Under the evaluate door it recomputes, so a faked door yields only the true values. An approval the prospect no longer earns is withdrawn, and the approve door re-evaluates first;
- **seven owner doors:** upsert, add evidence, supersede, release an identifier, re-evaluate, "have we seen them?" lookup, and the fit catalogue.

**`/admin/growth/` → Outbound** opens a prospect into:
- each number beside its bar, and the unmet gates;
- the facts with their sources and rivals, and warnings in words;
- the full "previously / currently" evidence history;
- the fit reasons, the identifiers and the drafts.

The owner can add evidence, supersede, add or remove fit reasons, release an identifier, re-evaluate, ask for more research or reject. The panel also has "Have we seen them?" and "Add a prospect". Text from the web is escaped and only `https:` sources are links. Table cells that wrap no longer inherit the page container's padding.

**Tests:**
- `outbound_research_sql.test.js` (162, 18 mutations all caught);
- `outbound_sql.test.js` (239, seeds now built from evidence);
- `outbound_console.e2e.js` (73).

## 2026-10-05 — Growth console: the owner-only outbound layer (outbound engine, phase 2)

**normal user < affiliate_admin < outbound owner.**

**`supabase/growth_outbound.sql`** adds:
- a private schema `growth_outbound`, which PostgREST does not serve and no client role can use;
- an explicit owner list, `growth_outbound.owners`. It is a subset of `affiliate_admins`: removal there cascades, and re-adding restores nothing. It is never granted by affiliate-admin status, and the existing consoles are untouched;
- default-deny RLS with a restrictive policy on every table;
- `public.growth_outbound_*` doors whose first statement is the owner check;
- table triggers that hold whatever writes the row:
  - **no self-enrollment:** an owner row cannot arrive through the API, even via a definer function;
  - **approval** is only by the signed-in owner, for the exact content and recipient they reviewed;
  - **sends:** a row exists only for an approved draft by a current owner, to the approved recipient. In test mode it goes only to the test inbox. It happens once per draft and once per address per step, under the cap, and only with complete compliance configuration;
  - **history:** append-only, never deleted.

**Tables and settings:**
- prospects, evidence, drafts, sends, suppressions, activity and settings;
- defaults: test mode on, automation off, cap 20;
- the sender and the call to action are pinned to edgedesksports.com;
- raising the cap or leaving test mode requires a confirmation flag.

**Bootstrap** is `select growth_outbound.grant_owner('you@example.com');` in the SQL editor. It says why it refused, including an address pasted with its `< >`.

**`/admin/growth/` gains an Outbound tab** for owners only. It shows:
- TEST MODE in the header and on the tab;
- send blockers in words;
- today's counts, with "sent automatically" always 0;
- prospects with emails, suppressions, settings (with confirmations) and the activity log.

An affiliate admin who is not an owner sees no tab, and the page asks only `growth_outbound_is_owner()`. The header also regains its side gutter on phones.

**`tools/growth/outbound_auth.js`** is the owner check every privileged outbound Edge Function will run: GoTrue, then the database asked as the caller, failing closed.

**Tests:**
- `outbound_sql.test.js` (194, catalogue-driven, mutation-checked);
- `outbound_auth.test.js` (37);
- `outbound_console.e2e.js` (33).

All Phase 1 suites still pass. Runbook: `docs/growth-outbound.md`.

## 2026-10-05 — Newsletter: the anon key can no longer suppress an arbitrary address

**Security fix.** `newsletter_suppress(email, reason)` was a `SECURITY DEFINER` function with no `revoke`, so PUBLIC could execute it. That meant anyone holding the anon key embedded in every page could mark any address a `complaint`. A complaint is never downgraded, so the address would never receive the newsletter again, and `lifecycle_due()` would stop its trial emails too. This was verified on a throwaway cluster before the fix.

- **Three locks, each enough alone** (`supabase/newsletter.sql`):
  - `EXECUTE` is revoked from public, anon and authenticated and granted to `service_role`, which is what the webhook and the pipeline already use;
  - the function runs with the **caller's** rights, and the client roles hold no privilege on the suppression or subscriber tables;
  - it refuses any caller other than the service role, the table owner or a superuser with `42501`.

  It also validates the address and the reason.
- **The token doors are stated, not inherited.** `newsletter_confirm`, `newsletter_preferences_get/set` and `newsletter_unsubscribe` get explicit grants, and the token is the authorization:
  - each refuses anything that is not a 64-hex token before looking it up;
  - each changes only the row its token names;
  - a caller-supplied source label is kept only if it is a plain word.
- **Report rows:**
  - 17.5: the anon key cannot suppress;
  - 17.6: every stored manage token has the shape the doors accept, so no existing unsubscribe link is refused.
- **`tools/newsletter/newsletter_suppress_sql.test.js`** (52 checks, real PostgreSQL with Supabase's default grants) covers:
  - anon, signed-in and PUBLIC refused;
  - each lock removed in turn and the call still refused;
  - forged and guessed tokens refused;
  - the webhook's ranking and validation, one-click / single-sport / preferences-page unsubscribe (as anon and as the Edge Function's service role), confirmation, re-subscribe (never clearing a bounce or complaint), and the signed-in self-service door, which suppresses only the caller's own confirmed address;
  - a catalogue check that fails on any new anon-reachable writer.

  Against the old file the anon attack succeeds and the suite fails. CI runs it in `games-sql.yml`.
- **Deploy:** re-run `supabase/newsletter.sql` in the SQL editor; every report row should say `ok`. No Edge Function change.

## 2026-10-05 — System health stops latching on one failed read

The header said **System · 1 failing** with "the database could not be reached at all — network, DNS, or a paused project · the record". Capture was writing to that same database every few minutes the whole time.

- **One failed read held the header red for the whole session.** The Database row read a CSS class that only three loaders (the live board, the record and its analytics) ever write. Nothing re-checked it, so a sleeping laptop, a gateway timeout or a slow count kept it red after every later read had succeeded.
  - It is now judged by the latest answer.
  - Red means the latest read failed too. While it stays red, a single heartbeat read re-checks on open, about once a minute, and as soon as the device is back online.
  - If the database has answered since a view failed, that is one amber warning naming the view, the cause and its age.
  - If the database stopped the boot load of the live board, the board reloads once the database answers again.
- **The cause was mislabelled.** `sbCount` threw a bare error with no status, so the record's 500 statement timeouts and refused keys all read as "could not be reached".
  - Counts now carry their status and body, get the shared token refresh (never the anon fallback), and count as healthy reads when they succeed.
  - A statement timeout is named as one.
- **A bug in the page is not a database outage.** A TypeError thrown while drawing the record, its analytics or the live board no longer turns the header red. Those views now say "a page error, not the database", and the error goes to the console.
- **The feed rows no longer depend on the live board having loaded.** Data / feed health reads its own heartbeat and shows fresh / stale. Last successful sync shows the age.
- **Tests:**
  - `tools/app/db_session.test.js`: 51 checks.
  - `tools/app/navigation.test.js`: 246 checks. Its async checks are now awaited; before, a returned Promise counted as a pass.

## 2026-10-05 — CFB calibration anchor: the calibrated curve keeps the key numbers and the "no ties" hole

- **The defect.** On 2026-10-04 the champion stopped shifting its margin table and began reweighting it in place, so its spikes stay on 3 / 7 / 10 / 14 and a tie keeps no mass. The calibration anchor (`lib/edgedesk_ev.js`, frozen) still carried that curve to the calibrated probability by a **location** move (`shiftedHome`, a mixture of two whole-point moves). That moved the spikes off their margins again and gave a tie mass. On the 2023–2025 walk-forward folds:
  - the anchored push rate at integer market lines was 2.9% (raw 3.3%, observed 5.3%);
  - |margin| = 3 carried 4.1% of the anchored mass (raw 9.6%, games 10.5%);
  - a tie carried 2.0%.
- **The fix.** The anchor now reweights the stored curve in place (`recentredHome` / `recentredSide` / `solveRecentre`).
  - It reads P(M = k) from `curve.push` at every whole k and tilts it by exp(θ·k). θ is solved so P(home covers the market line | no push) equals the calibrated probability. This is the champion's own move (`cfbRecentre`).
  - A margin with no mass keeps none, so a college curve never gives a tie mass.
  - The robust EV's model-location noise moves the curve the same way.
  - Where the engine reweights rather than shifts, the anchored curve matches the engine re-run at the moved fair margin: 0.03 pp at the median, 0.1 pp at the 95th percentile, at close ± 3 and ± 7.
  - NFL is untouched: its calibrated path is the pricing blend, which re-runs `football/engine.js` at the blended centre and never goes through this anchor.
- **What moved** (tournament re-run, DEV only; the holdout was not re-read; every map, status and verdict is unchanged):

  | Anchored audit | Location move | Reweighting | Raw | Observed |
  |---|---|---|---|---|
  | push, all integer lines | 2.9% | 3.4% | 3.3% | 5.3% (95% 4.0–6.9%) |
  | push at 3 / at 7 | 3.2% / 3.0% | 6.4% / 5.6% | 6.1% / 5.3% | 9.6% / 11.1% |
  | mass on \|3\| / \|7\| | 4.1% / 3.8% | 9.7% / 8.1% | 9.6% / 8.0% | 10.5% / 8.7% |
  | tie | 2.0% | 0 | 0 | 0 |
  | three-state log loss, integer lines | 0.8715 | 0.8569 | 0.8976 | — |

  - Key-number mass stays **NOT VALIDATED**: the push rate is still below its interval. What remains is the PMF's own shortfall at the market's number.
  - **Alternate-line audit.** The calibrated slopes at −7 / −3 / +3 / +7 go from 0.42 / 0.70 / 0.10 / 0.38 to 1.37 / 1.51 / 1.03 / 0.81. Log loss and Brier improve at every offset.
  - All four slopes are inside 0.6–1.6, so the validated tail (`tailDomain`, unchanged) goes from **0 to ±7**. Each interval is about ±1 wide, and the +3 and +7 intervals reach 0. Alternates that cross 3 or 7 stay never actionable.
  - Today's board prices no alternates. No EV, quote or bettor decision changed. Calibrated push at whole-number lines rose (UNLV +3: 2.0% → 6.3%). The bet trigger line moved on 9 of 11 games, mostly further from the market.
- **Governance.** The new hashes of `lib/edgedesk_ev.js` and `calibration.json` are a PATCH in `football/cfb_ev/versions.jsonl`, and the engine keeps `edgedesk_ev_engine_v1`. The next-100 population was already full (100 of 100, 94 graded), so no frozen read moves. Disclosed in PREREG.md, post-registration change 4.

## 2026-10-05 — Growth console: sign-in that survives the hour (outbound engine, phase 1)

`/admin/growth/` used to send a stored access token forever without refreshing it. After an hour every visit got `401 PGRST303 "JWT expired"`, and the page reported that as *"this account cannot open the growth console: an operator must add it to public.affiliate_admins…"* with the raw JSON attached. Authorization was never the problem, and it has not been loosened.

- **`lib/edgedesk_admin_session.js`** is the operator consoles' session, ported from `app.html`'s refresh logic:
  - refreshes before expiry;
  - refreshes once and retries once on a 401, then stops;
  - shares one in-flight refresh across loaders and tabs, so rotating single-use refresh tokens are never raced;
  - a refused refresh ends the session in words, while a 5xx or network failure keeps it;
  - never downgrades to the anon key, never logs, and redacts tokens from messages.
- **The growth console** checks `growth_is_admin` first and alone, so *signed out*, *not an operator*, *not installed* and *unreachable* are distinct answers, and a non-operator triggers no data read. It also gains sign-out (local state cleared first, server session revoked), "use another account", Enter-to-submit and per-section errors.
- **Tests:**
  - `npm run growth:test` — 83 checks, mutation-verified;
  - `npm run growth:sql` — 34 checks on a real PostgreSQL. Anon, a subscriber and a partner are refused, and no client-callable path writes `affiliate_admins`;
  - `npm run growth:e2e` — 42 checks in Chromium, including the original failure reproduced against the old page.
- Plan and runbook: `docs/growth-outbound.md`. No SQL ships in this phase.

## 2026-10-05 — The Decision Record, and one tap from the Card to it

Every position now keeps what was known when it was entered, exactly as it was, and everything learned afterwards. It sits under the existing five destinations; no navigation was added. EdgeDesk still never places, accepts or executes a wager.

- **The Decision Record** (`supabase/portfolio_decision.sql`, `docs/decision-record.md`). One record per position: BEFORE · ENTRY · MARKET PATH · RESULT · GRADE · REFLECTION · FOLLOW-UP. It opens from a position, from search and from a notification.
  - **Immutable decision snapshots** keep EdgeDesk's state (model and its versions, probability, fair price, decision) and the market's state (price, consensus, per-book prices, capture time, freshness). They also keep the reader's own state, computed by the server: unit, caps, the day's exposure, rules and experiments in force. A snapshot is never rewritten, and one taken after the fact is refused.
  - **The market path** is append-only. Each price has its source, and its time is either observed or only recorded. The feed reads `book_quote_ticks` by exact key only and captures a close only within 6 hours of the start.
  - **Edge capture** (`edge_capture_v1`) covers spreads, totals, moneylines, props and contracts, with its limitations in words.
  - **Context quality:** FULL / STRONG / PARTIAL / RESULT_ONLY. Imported history is valued but nothing is invented.
  - **Persisted outcome classes:** good win / bad win / good loss / bad loss, from the process grade and the result together, never the result alone.
  - **Reflections** keep every version, stamped before or after the result.
  - **Methodology versions** come with recalculation rules (LIVE vs APPEND), and old conclusions are never overwritten.
- **Process memory.** Each surfaced pattern shows FIRST DETECTED · THEN · NOW · STATUS. The status (Improving / Unchanged / Declined / Insufficient new evidence) is a Welch test on the positions since detection, never two letters compared. Every look stores the exact positions it used and those it excluded, with the reason.
- **Your baseline.** The first 30 graded decisions are frozen, and later ones are tested against them. **Analysis depth** at 10 / 30 / 100 says what becomes possible, never a target. Up to three **questions from your own record** appear, each with its WHY.
- **Experiments are a permanent record.** Success criteria and the baseline freeze at the start. *Record the result* runs the pre-registered test on evidence the server froze, and the server refuses a conclusion that evidence does not allow. The reflection is written once.
- **Card → Record Position.** A saved Card entry offers View research · Before you enter · Record position · Remove. Record position opens Portfolio's sheet:
  - prefilled from the Card;
  - says how old the saved price is;
  - shows Before You Enter first.
  - One save stores the position, journal, snapshot, path and the Card's RECORDED event.
  - The Card's lifecycle (added, viewed, considered, recorded, removed) is kept privately. A removed entry is never a position.
- **Reconciliation without duplicates.**
  - An import row matching a bet already recorded waits for review.
  - A synced contract adopts a single hand-recorded copy; two or more are reported, never guessed between.
- **Search** reaches the reader's Card entries and recorded positions beside research.
- **Notices.**
  - A settled position's record is ready to review.
  - An experiment's window has ended.
  - Each has its own switch, and neither ever prompts a wager.
- **Ask EdgeDesk about this decision** answers on the page from the record alone.
- **Your data.** *Download everything (JSON)* and *Delete my Portfolio…* (typed confirmation). Account deletion cascades through every new table.
- **Operator moat metrics** are counts only, withheld below 5 readers. Cross-reader intelligence is designed, not enabled.
- **Tests:**
  - `tools/portfolio/decision_sql.test.js`: 103 checks.
  - `tools/portfolio/decision_record.test.js`: 29 checks.
  - The Card → Record → Decision Record → Ask → search → export journey in `tools/portfolio/portfolio_ui.e2e.js`: 128 checks in all, at 1280 and 390 px.
  - Reconciliation in `connect_sql.test.js` and `portfolio_sql.test.js`.

## 2026-10-05 — Process tells you what matters before asking which report to open

Process opened on eight peer reports and two rows of filter chips; it read like an analytics dashboard, not a coach. The same engine (`lib/edgedesk_portfolio_process.js`, `supabase/portfolio_journal.sql`) now sits under a simpler surface. The five destinations — Research, Card, Portfolio, Process, More — are unchanged.

- **Three places instead of eight: Overview · Film Room · Explore.** Leaks, Strengths, Timing, Edge capture, Rules, Experiments and Process vs outcome (the former Process Report) live under **Explore**, each with a figure on its row and a way back.
- **One Filter.** It covers source type, platform (of that type) and time: 7D, 30D, YTD, All or Custom. Until something is applied the page reads "All activity"; applied filters show as compact, removable chips.
- **Overview: how is my process?**
  - **The answer comes first:** the Process score and its letter, with the graded count and confidence.
  - **Below 10 graded positions** the hero shows **Process profile · Building**, the eligible count, and the rule. No score or letter is assigned below 10, the engine's own evidence rule (`X.MIN.observation`, where confidence leaves "Building"). No arbitrary threshold is added, and no "— n=0".
  - **Dimension grades:** price quality, timing, sizing and rule discipline, each graded only from 10 positions with that data. A dimension under 10 shows its progress (e.g. "Timing 3/10"), never a letter.
  - **What's working and Needs attention:** the strongest and weakest pattern that clears the existing evidence bar, each with its process grade, positions, average CLV and evidence level. The wording is analysis, never "stop" or "don't bet". With nothing strong enough, one quiet line says so and how much more data it needs, instead of empty cards.
  - **Current experiment:** week x of y, the metric during against before, and its status. It says that an experiment never promises a result.
  - **Current focus** (when no experiment is running): the weakest pattern or dimension, offered as something to measure. "Set up an experiment" prefills the form; the reader decides.
- **Film Room: the week, like game film.**
  - **The week:** result, process grade, rules followed and average CLV, with one sentence its figures support. Examples: "Strong results. Strong process." / "The results were bad. The process wasn't." / "You won this week, but your process grade fell (B → C+)." With fewer than 10 graded positions it says the process can't be judged yet.
  - **What worked / What hurt:** the strongest and weakest decisions, each shown once.
  - **Won on a poor decision / Lost on a good decision:** the explanation is built from what was recorded, e.g. "the line closed at -4 against your -7 (−3 pts against you), and its price quality scored 28". Market structure is never cited, because it is a constant of the market type.
  - **Review:** "Would you make this bet again? YES / NO / UNSURE — Why?", asked first for the bad win and the good loss. It is saved as the after-the-result reflection (`would_repeat`, `review_note`, `reviewed_at`), beside what was recorded before the bet. That pre-bet record is write-once in the database and never part of the save.
  - **Next week:** a focus and an experiment to measure, never an instruction.
  - **Sparse and empty weeks collapse.** "Only 1 eligible position…" comes with the positions themselves; there are no "None this week" cards.
- **WHY on everything.** Every grade, pattern, experiment, decision, week and table opens one evidence panel (`whyItem`). It gives the sample size, positions, date range (actual dates, in the reader's zone), comparison group, CLV, P&L, ROI, confidence, methodology and limitations, so the reader can check and challenge each number. A decision's WHY lists its components and links to its journal.
- **Portfolio's Decision Grade follows the same rule.** It shows no letter below 10 graded positions, reading "Building", with the count.
- **Mobile.** A phone opens on Process → the three places → the score or Building → What's working → Needs attention → Current focus. There's one Filter button and no chip rows. The e2e checks the segments fit, that nothing scrolls sideways, and that the hero sits in the first screen.
- **Tests.**
  - `tools/portfolio/journal_ui.test.js`: 126 checks. Navigation, the filter, the Building rule, dimension gates, the cards, Explore, the Film Room sentences, explanations, review, focus wording, collapse, and the required fields in every WHY.
  - `tools/portfolio/portfolio_ui.e2e.js`: 108 checks against PostgreSQL. The Overview, WHY, Filter and chips, every Explore report, the experiment on the Overview, the Film Room week of Sep 7, and a review saved while the pre-bet fields stay unchanged in the database. At 390 px it checks Process, the Film Room and Explore.
  - `tools/app/navigation.e2e.js`, `tools/app/navigation.test.js`, `npm run portfolio:test`.


## 2026-10-05 — The Process Coach is the Process seat

#504 built the Process Coach as a tab inside Portfolio, while the bottom nav's **Process** seat still showed the earlier tracked-price page. The five-destination navigation (`docs/ia/NAVIGATION_AUDIT.md`) gives each question its own seat. Portfolio answers "what do I hold and how did it go"; Process answers "how do I decide". The Coach now lives in Process.

- **Process opens on the Coach.** It is the same controller (`lib/edgedesk_portfolio_ui.js`), mounted coach-only in the Process view. It shows:
  - the Decision Grade and process against outcome;
  - leaks and strengths (pre-specified comparisons, corrected for multiple comparisons);
  - timing and edge capture;
  - rules, experiments and the weekly Film Room.

  It has the same platform and period filters, and the same journal and "WHY?" sheets.
- **What EdgeDesk tracked folds under it.** Prices tracked from an edge and Card bets graded against the close (`lib/edgedesk_process.js`) sit in a "Tracked from EdgeDesk" section, as Portfolio folds them under the book.
- **Portfolio loses its Coach tab:** Overview · Calendar · Journal · Open · History · Analytics · Accounts · Import. The Overview's Decision Grade gains "How you decide: open Process ›".
- **Links still work.**
  - `#portfolio/coach` and `pfSetTab('coach')` land on Process.
  - Each page of the Coach has its own link, `#process/<page>` (report, leaks, strengths, timing, edge, rules, experiments, film), and Process reopens on the page last read.
  - Links from one page to the other (Process's "Connect accounts" / "Import a CSV" → Portfolio) are routed by the app through a `pfo-route` event.
- **An empty book.** It says "Nothing to grade yet", with Connect accounts and Import a CSV, and no longer asks the server for a summary of nothing.
- **Tests.**
  - `tools/portfolio/portfolio_ui.e2e.js`: 84 checks. The Coach is exercised in the Process seat: report, leaks with `#process/leaks`, rules, experiments and the Film Room. It also checks the Overview's link, the old `#portfolio/coach` link and reader isolation in Process.
  - `tools/app/navigation.e2e.js`: 172 checks. Covers the empty Process at 390 and 1440 px, its Connect accounts → Portfolio › Accounts, and the tracked section under the Coach.
  - `tools/app/navigation.test.js`: 234 checks.

## 2026-10-05 — Portfolio ingestion: Kalshi and Polymarket connectors (built, switched off), sportsbook import, setup and operator health

How a reader's history gets into the Portfolio. Every source ends in the same rows, the same P&L rules and the same tests. Nothing connects automatically in production yet.

### Automatic connectors: built, off until a live test passes

**The pipeline.** `lib/edgedesk_portfolio_connect_core.js` holds:

- the platform registry, with how each platform was verified;
- a 13-method adapter contract, which refuses any adapter that could place orders;
- the Kalshi adapter: a read-only API key, signed requests, a key that can trade refused, a boundary-safe cursor, historical fills, settlements including scalar and void, and net-position reconciliation that rebuilds a market that disagrees;
- the Polymarket adapter: a public wallet only, with a seed phrase or private key refused.

The function `supabase/functions/portfolio_connect` carries the core verbatim and handles connect, sync, disconnect and a 10-minute scheduler sweep (`supabase/portfolio_sync_cron.sql`).

**Credentials** are sealed with AES-256-GCM on the server, bound to the reader, account and kind, and re-sealed on key rotation. They live in a schema readers cannot reach. The browser sees a hint, never the key.

**The switch.** `supabase/portfolio_connect.sql` adds the registry and service-only ingest. The database refuses to switch a connector on without:

- a PASSED ten-stage live smoke test of the same connector version, in production, within 30 days;
- a cleared terms review.

`tools/portfolio/connector_smoke.js` runs the ten stages (CONNECT → IMPORT → VERIFY → INCREMENTAL → NEW_ACTIVITY → SETTLEMENT → RECONCILE → DISCONNECT → RECONNECT → NO_DUPLICATES) and never throws the switch itself.

**How it was verified.** The official documentation hosts were blocked from the build environment. The facts come from each platform's own published client source, and must be re-read before anything is switched on (`docs/platform-connections.md`).

### Sportsbook import: select platform → drop file → review → done

- **Import, never Connect**, for every sportsbook. EdgeDesk never asks for a sportsbook password.
- **Platform detection** in order: the reader's choice, the file's platform column, then the file's name. Otherwise the page asks. The review headline reads "Detected: DraftKings · 284 wagers found · Aug 2024 – Oct 2026".
- **Profiles** for DraftKings, FanDuel, BetMGM, Caesars, bet365, BetRivers, Fanatics, theScore Bet (ESPN BET), and Kalshi and Polymarket CSVs. All are marked unverified until a real export has been imported.
- **Remembered layouts.**
- **Bonus bets and parlay legs.**
- **A totals check:** the file's stated results against what its odds pay.
- **Review:** Found / Ready / Duplicates / Need review / Cannot import, an estimated P&L, [Import n] and [Review n].
- **Re-importing a newer file** updates results in place, with [Update portfolio] and "nothing is counted twice".

### Setup and Accounts

- **Setup** groups platforms by how their history arrives: prediction markets (Connect only once switched on), sportsbook import, and other (import another platform, add manually).
- **Progress** reads "Connected ✓ · 143 positions", "Imported ✓", or "Waiting for import", with a total.
- **"Your portfolio is ready"** shows tracked and open positions and the server's all-time P&L and ROI. The process profile reads *Building* until 10 positions are graded. No insight is invented before then.
- **Accounts** are grouped Automatic / Quick import / Manual. They show honest statuses: Syncing is never "Connected", plus Action required, Sync failing and Disconnected. Each shows "Last synced 2 min ago", a sync log, and "Import update". Disconnect explains how to revoke the key at the platform.
- **The WHY panel** adds positions analyzed and the group's own P&L, ROI and CLV. CLV is shown only over positions with a closing price.
- **Before you enter** adds what is already open on the same event, across platforms.

### Observability

**The operator panel** (operators only, counts only) shows, per platform:

- sync runs, timings and errors;
- records discovered, inserted and updated;
- duplicates rejected and settlements recorded;
- rejected positions and reconciliations;
- connection attempts and failures by code;
- import files, rows that could not be read, and new file layouts (a likely export-format change);
- time to value: median minutes to a first position and to ready, setup abandonment, and import and connection failure rates.

Eleven funnel events are registered in `supabase/funnel.sql` and allow-listed in `lib/edgedesk_track.js`.

### Fix

A seed phrase pasted into the wallet field was cut to the field's 42-character limit and read as a bad address, not refused as a secret. The field now takes the whole paste, so the refusal fires.

### Tests

| Suite | Checks |
|---|---|
| connect core | 67 |
| connect SQL | 82 |
| connect sync, end to end | 33 |
| connect function | 18 |
| import | 83 |
| UI | 100 |
| journal UI | 70 |
| process | 38 |
| calc | 106 |
| browser e2e | 87 |

### Not changed

The landing page still says importing and connecting are in development (`tools/presentation/landing_positioning.test.js` pins it). It changes once the import is deployed and a connector is switched on.

## 2026-10-04 — Portfolio Calendar: month arrows no longer blank it; whole amounts on a phone; the month's settled line

Three fixes to the Calendar that #504 added.

- **Month arrows keep the calendar on screen.**
  - **Before:** each arrow tap replaced the whole calendar with "Loading the calendar…" until the server answered. The heading and the arrows disappeared under the reader's finger, and tapping through months jumped the page.
  - **Now:** the new month's heading, arrows and grid stay up, marked busy and labelled "Loading October 2026…", until its days arrive.
  - **The e2e.** The same gap made `tools/portfolio/portfolio_ui.e2e.js` fail intermittently: its loop read the heading while it was briefly missing. The e2e now answers the calendar request after 400 ms, as a phone's network would. With that delay the old code fails every time and the new code passes.
- **A phone shows every day's P&L whole.**
  - **Before:** at 390 px a cell cut "−$100.00" down to "−$10…", which reads as a different number.
  - **Now:** on screens up to 420 px a cell shows a short figure (−$100, +$1.2k, rounded with exact decimals). The cell's screen-reader label, the wider-screen cell and the day panel keep the exact amount.
- **The month's settled line.** Under the heading, the Calendar now shows the month's settled P&L, the number of positions, the win-loss-push record and the up and down days.
  - It is built from the same `portfolio_calendar()` rows the grid draws, summed with exact decimals, and counts only the month on screen.
  - A month with nothing settled says so.
- **Tests.**
  - `tools/portfolio/journal_ui.test.js`: 67 checks. Covers the busy grid, the month line, short and exact amounts, and the phone rule.
  - `tools/portfolio/portfolio_ui.e2e.js`: 78 checks against PostgreSQL. Covers the mid-load state, the month line against the database's own `portfolio_calendar()` sums, and the 390 px September with no clipped figure and no sideways scroll.

## 2026-10-04 — Portfolio: the journal, the Decision Grade, the calendar and the Process Coach

Portfolio now judges each decision by its price, timing, sizing and your own rules — never by whether it won — and files your history by day.

- **The Overview** reads Total P&L (by settlement date), ROI, the **Decision Grade**, then **What's working / What's not**.
  - Every figure comes from the server (`supabase/portfolio_journal.sql`). The page no longer downloads a lifetime of positions: it reads your open positions and the latest 1,000 settled ones for History.
  - With no price to judge a decision by, the grade reads "Not graded yet". No letter is invented.
  - Every finding carries a **WHY** (data used, sample, period, comparison, calculation, confidence, limits) and lists its positions.
  - With too little data it says **NO RELIABLE LEAK DETECTED**, and how many more positions would let groups be tested.
- **One combined book**, with a filter for all platforms, sportsbooks, prediction markets or one platform.
- **Calendar** by month, week or day, read by the day you **entered**, the **event** day or the day it **settled**, in your time zone. A day lists what was entered, the events and what settled.
- **Journal** in year → month → week → day folders.
  - Each position's decision (planned, model probability, thesis, research and opening prices, tags) and close are recorded once and then shown locked. The database refuses a rewrite.
  - Your review (would you make it again, Mistake / Strength Library, a sentence) stays editable.
  - An imported bet says "Historical import · No pre-entry journal available." and nothing is invented for it.
- **Process Coach**: Process Report (grade, process vs outcome, variance, last 30 days vs the 30 before), Leaks, Strengths, Timing, Edge Capture, Rules, Experiments and the Weekly Film Room.
- **Before you enter**: recording a bet shows context from your own last 12 months, the model's expected value at your price, your size against your caps, and any of your rules it would break. It never says BET, DON'T BET, LOCK or GUARANTEED.
- **New bets** record the stake type (cash or bonus bet), when the event starts (kept apart from when you placed it) and, optionally, the decision.
- **Deploy**: the manual Portfolio deploy now tests and applies `supabase/portfolio_journal.sql` after `supabase/portfolio.sql`, each in its own transaction.
- **Tests**: `tools/portfolio/journal_ui.test.js` (60), the journal SQL suite (73), and the browser journey (69, now through the grade, calendar, journal, coach and pre-bet panel at 1280 px and 390 px).

## 2026-10-04 — CFB champion: re-centring no longer moves the "no ties" hole or the key numbers

- **The defect.** A college game cannot end level, so every row of the champion's `margin_pmf_by_spread` holds no mass at margin 0. `football/cfb_p4/engine.js` `coverProbSpread` and `lib/edgedesk_quote_ev.js` `cfbConditionedCover` re-centred a row by shifting it a whole number of points. The hole and the 3 / 7 / 10 / 14 spikes moved with it.
  - UConn @ Temple (fair +6.2, row 3.0, shift +3) had no push at Temple −3, so quote EV flagged `INTEGER_PUSH_MISSING` and the engine refused the price as CORRUPTED ODDS. Meanwhile a tie carried 6% of the mass.
  - Across the 2015–2026 calibration rows (closes, openers and ±3 / ±7 alternates), 423 of 12,043 whole-number lines had no push (96 of them at ±3), and 374 of 411 pick'ems carried tie mass.
- **The fix** (`cfbRecentre`, byte-identical in both files). The row is reweighted in place by exp(θ·margin), with θ solved so the mean lands exactly on the fair margin. Every margin keeps its own entry.
  - The reweighting reaches one standard deviation of the row, and no further than the table's row means span. Past that, the rest of the move is a mixture of two whole-point moves (as `football/engine.js` does past its table). Margin 0 is held at zero throughout.
  - A college pick'em (line 0) with no push is no longer a "missing push".
- **What moved.** The fair spread, win probability, sigma and ratings are unchanged. Cover and push probabilities move:
  - Raw cover at the 2022–2025 closes moves 1.8 pp on average (p99 6.5 pp). The model's side gives back 0.3–0.9 pp, most at 5–12-point gaps.
  - Mean push at integer lines goes from 2.4% to 3.2% (observed 4.9%). At 3 it goes from 2.6% to 6.2%, at 7 from 2.4% to 5.3%.
  - Raw cover log loss improves on every window (OOS close 0.7340 → 0.7313).
  - The PMF now predicts pushes better than a normal shortcut (push log loss 0.192 vs 0.203). Before, it was worse (0.237).
- **Re-validation.** The calibration rows were re-derived from their own inputs (`football/cfb_ev/dataset.js --rederive`) and the tournament re-run. It promoted the same methods: close temperature, T = 10⁶ (unchanged); open temperature, T 40.89 → 36.81; moneyline identity.
  - The new hash is recorded as a PATCH in `football/cfb_ev/versions.jsonl`, so the next-100 count continues. The pricing path's PATCH is `edgedesk_cfb_r1+p5`.
  - Disclosed in PREREG.md, post-registration change 3.
- **Two consequences to know.**
  - The calibration anchor (`lib/edgedesk_ev.js` `shiftedHome`, frozen) still carries the curve to the calibrated probability by a location move, which displaces the spikes the raw curve now keeps. The alternate-line audit's +3 slope fell below the 0.6–1.6 band, so the validated alternate domain goes from ±3 to 0.
  - Three games on today's board drop below the flat 25% raw-EV bound and leave INVESTIGATE (two to WORTH RESEARCHING, one to MARKET FAULT).
- **The temporary hold is gone.** `tools/bettor/football_decision.test.js` no longer lets the shifted-hole signature (`tieHoleHold`) through. Its self-check idea is kept in the new regression.
- **Tests.** Every suite runs green with these checks added:
  - no stored curve gives a tie any mass, and every whole-number line on the board carries a push (`tools/bettor/football_decision.test.js`, with a self-check that catches the old shifted hole);
  - the key numbers stay on 3 and 7 (`football/cfb_p4/tests.js`);
  - the mean is exact, and the two functions agree to the bit (`tools/football/quote_ev.test.js`).

## 2026-10-04 — five destinations: Research, Card, Portfolio, Process, More

The authenticated app is organised around the loop a reader actually runs — research → decide → track → review → improve — instead of giving every feature a seat. Audit and route map: `docs/ia/NAVIGATION_AUDIT.md`.

- **The bar is five seats:** Research · Card · Portfolio · Process · More (was Research · Card · Props · Edges · AI · Record · More). On a desktop the same five stand as a left rail.
- **Research** holds Football · Props · Edges · Other. *Other* opens the other sports (UFC, Baseball) and the research tools (Stats, Lab, Desk), and the seat names whichever is open. Football reads NFL · CFB · Players · Rankings · Rosters.
- **AI is contextual:** "Ask EdgeDesk" in the Research header, on college game research ("Research Kansas at Texas Tech", "Why could this number be wrong?") and on the Card. The drawer and every receipt's Analyze button are unchanged; the drawer no longer appends a seat of its own.
- **Portfolio is a seat.** It is Portfolio Phase A's page (Overview · Open · History · Analytics · Accounts · Import, every platform, P&L first), no longer a More row. The old Ledger is no longer a page: its tracked prices, bets logged by hand, quick add and exposure, and the Card's BET PLACED bets, are one section under the book — *Tracked from EdgeDesk* — the positions graded against a closing line, which Process reads (`lib/edgedesk_positions.js`). `#portfolio/<tab>` links to a tab.
- **Process** (new) reads the reader's graded history by one measure — did the price beat the close — with a process score, what's working, what's costing you, this week and a next focus, and the tables (timing, sport, market, price at entry, Card range, edge capture, decision journal) behind disclosure. Below 20 graded positions it shows what it is building and what unlocks next; a comparison needs 8 graded on both sides, a 10-point gap and z ≥ 1 (labelled *clear* only at 95%).
- **Record is "Model performance"** — EdgeDesk's record, never the reader's — in More › Transparency. Its title says "not your bets"; Settings › About no longer calls it "your graded track record".
- **More is sections:** Community & tools · Transparency · System · Account · Legal. News moved to System as the moat-alert feed, and the items naming a game's teams now show on that game's research. The Model & data health row no longer closes its own panel on the same tap.
- **Tracking a price keeps the reader where they were** and says "Tracked in Portfolio · View" instead of jumping to another page.
- **A new account starts at setup, once:** welcome (the five destinations) → your portfolio (import a CSV or connect accounts, in Portfolio) → your first read → Research. It counts as done when shown; a deep link always wins; More › Account › Set up EdgeDesk runs it again.
- **Every old link lands:** `#playerprops/…`, `#research/props|edges|…`, `#card`, `#portfolio`, `#receipt=…` (which now opens on a cold load), and new `#portfolio/<tab>`, `#process`, `#more`, plus `#ledger`, `#record`, `#pnl`, `#edges`, `#props`, `#settings`, `#news`, `#faults`, `#collective`. `show('ledger'|'pprops'|'edges'|'record'|'ai')` still work. A remembered `ledger` tab lands on Portfolio.
- **Navigation evidence:** `primary_nav_research|card|portfolio|process|more` per seat tap and `secondary_nav_opened` (props.entity: `more:…`, `research:…`, `portfolio:…`, `process:…`, `card:…`, `ai:…`, `setup:…`), first-party through `ed_track` (one row per session per seat / entity) and to gtag per tap. **Re-apply `supabase/funnel.sql`** for the server to accept them.
- **The disclaimer** keeps every element; the helpline is a tap-to-call link; it breaks only between elements and, on a phone, reads as one unit with the nav (≈30px, was 34px; one line from ~412px).
- **Tests:** `tools/app/navigation.test.js` rewritten for five destinations; `tools/app/navigation.e2e.js` (new, in CI) drives 390px and 1440px; `tools/app/portfolio_process.test.js` (new, in CI); `tools/funnel/funnel_sql.test.js` +6 for the nav events; `sports_config`, `research_landing`, `props_ui.e2e`, `first_run.e2e` and the Portfolio UI's `app.html` wiring checks follow the new structure.

## 2026-10-04 — the landing page sells research plus your own betting analytics

The public page now answers, in five seconds: EdgeDesk is football research plus personal betting analytics, it helps you see whether your process is working, it costs $49.99 a month, and it sells no picks.

- **The hero** reads "Research, not picks. / Bet with a process. Know what's working." It has one sentence, the trial as the primary button, "See how it works" beside it, the offer under both, and who it is for.
  - Beside it, a sample week (P&L, ROI, process grade, open positions, what's working, what to watch, next focus). It is labelled **In development** and **Sample data** in its own bar, before any number.
- **The narrative** follows the decision:
  - results vs process: two illustrative tickets whose arithmetic the tests check;
  - the loop: Research → Track → Measure → Learn → Improve, each step marked Live or In development;
  - Process Coach and the Weekly Film Room, on sample data;
  - history: a sample calendar, and the journal that is live today;
  - beginner to advanced;
  - the research terminal, still the one block with live data;
  - value and pricing, trust, FAQ, and the close.
- **Nothing unfinished is sold as live.**
  - Process Coach, the Weekly Film Room, the calendar view, per-bet grades, prediction-market tracking and account connections are labelled wherever they appear.
  - No sportsbook or exchange is shown as connected.
  - The FAQ answers "Can I connect my account?" with "Not yet."
  - There is no social proof beyond Stadium Rant's real, exactly worded credit.
- **The plan card lists only live features:** eight lines (`lib/edgedesk_pricing.js` `FEATURES`, which the terminal's paywall also prints), down from twelve. The trial terms are the billing system's: a card, 7 days, charged on day 8.
- **One call to action**, "Start free trial", in the nav, hero, pricing, close and a phone-only sticky bar.
  - The bar appears once the hero's button scrolls away.
  - It steps aside at pricing, at the close and under a dialog.
  - It never shows for an account that already has access.
- **Hero copy is ready for a test, without a test framework.**
  - `HERO_COPY` holds variants a, b and c; the markup is variant a.
  - `?hero=b` previews a variant. No visitor is assigned at random.
  - Every GA event carries `hero_variant`.
- **Analytics:**
  - New GA events: `hero_cta_click`, `how_it_works_click`, `process_coach_view`, `pricing_cta_click`, `signup_started`, `signup_completed`, `checkout_started` and `trial_started`.
  - The legacy names `hero_trial_click`, `pricing_trial_click` and `hero_how_click` are still sent beside them.
  - The first-party funnel is unchanged and still runs visitor → `cta_clicked` → `signup_started` → `checkout_started` → `trial_started` → `subscription_started`. Its click and landing events now carry the hero variant.
- **Removed:** the live board grid, the prop table, the workflow card, the price example, the six-card feature grid and the who-it's-for strip. The live research preview and its statistics moved to the research section. `#how`, `#today`, `#record`, `#pricing` and `#subscribe` all still land.
- **Preserved unchanged:** auth, the renewal-terms consent, Stripe checkout and its return, attribution and partner credit, the comp check and the public-record panel. The one exception is the hero-button wiring for signed-in accounts.
- **Tests:**
  - `landing_positioning.test.js` (456) now checks the new positioning and the unfinished-feature labelling.
  - `landing_interaction.test.js` (201) now covers the sticky bar, the hero config and the GA events.
  - `tools/home/landing.e2e.js` (210, browser) covers 6 widths, the 375×548 first screen, the funnel and GA, the sticky bar, variants, and the live, stale, midweek and down data states.

## 2026-10-03 — share the Record: an image and a post for X or anywhere

- **A Share button on the Record**, on the public page and the app. It shares the view on screen: the tab (All, CFB, NFL, Player Props), the period, the market and the stake basis.
- **The card** (`lib/edgedesk_record_card.js`) comes in three sizes: X post 1600×900, square 1080×1080 and story 1080×1920. It shows:
  - the units at the graded price, the ROI and the record;
  - each market's units;
  - the sample size.
  - It also says how the units were priced ("at the closing price · not Verified P&L"), prints Verified P&L beside them, and carries "21+".
  - It computes nothing: every number is one the page already printed, from the same kernel.
- **The actions:**
  - **Share…** opens the phone's share sheet with the image attached (X, Messages, Instagram).
  - **Download image** saves the PNG.
  - **Post on X** opens a post with the text and link.
  - **Copy text** and **Copy link** copy each one.
  - The post stays under 280 characters, counting the link as 23 the way X does.
- **The link opens the same view:** `record.html?view=nfl#pnl`.
- **Tests:**
  - `tools/record/record_card.test.js` (72, now in *Record P&L tests* and `npm run record:pnl:test`): what the card says, the post's length, and that every size keeps every word in the frame, with the boxes above the notes and the notes above the footer.
  - `pnl_ui.test.js`: the dialog and its focus, every size drawn, Download, Escape and an outside tap, and the `?view=` link.

## 2026-10-03 — NFL and CFB tabs show P&L, not just the record

After the props were split out, the NFL tab showed only its record (58-38-2): none of its 98 game picks had a verified price. EdgeDesk stored no NFL game quote before 2026-10-03.

- **P&L at the graded price.** Every graded pick is priced at the line it was graded at, so the units and the record describe the same picks (`lib/edgedesk_pnl.js` `gradedPnl`).
  - The model's game picks are graded against the closing line, so they are priced at that line's closing price: nflverse consensus for the NFL, the ESPN book (DraftKings) for college.
  - Player props keep the price captured with the pick.
  - A pick with no closing price (40 CFB moneylines) is left out and counted, never assumed.
- **The ledger now carries that closing price** (`tools/record/pnl_core.js`). Each model pick's `closing_odds` is the side's price that the model record already keeps with the closing line (`grade.pnl`, `pricePick`).
  - Filling a price that was empty is not logged as a correction, in the build or the database.
  - It never makes a pick verified.
- **The page:**
  - Each tab shows its units with its record under them.
  - A new *P&L at the graded price* card sits above Verified P&L, labeled as not Verified P&L.
  - NFL and CFB history rows read e.g. "+124 close · +1.24u not verified".
  - *How P&L works* explains the difference.
- **On the 2026 ledger** (flat 1u):

  | Tab | P&L | Picks | Record |
  |---|---|---|---|
  | NFL | +7.87u (+8.2% ROI) | 98 | 58-38-2 |
  | CFB | −38.49u (−6.4%) | 600 of 640 | |
  | Player Props | −7.17u | 24 | |
  | All | −37.79u | | |

  - NFL by market: spread +7.04u, totals −1.49u, moneyline +2.32u.
- **Verified P&L is unchanged.** It is still only a price EdgeDesk captured at or before the decision: 31 priced, −4.96u flat.
- `record/pnl/` picks up the closing prices on the next *Record P&L* run.
- **Tests:**
  - `pnl.test.js` 183;
  - `pnl_ledger.test.js` 104: every model pick's closing price equals the record's `grade.pnl`; NFL and CFB units equal the record's own closing-price units; no correction logged;
  - `pnl_ui.test.js` 497 on the rebuilt ledger, 493 on the committed one. They cover the tab units and record, the new card, the history rows and the real NFL tab.

## 2026-10-03 — the Record's NFL tab no longer counts the player props

On the Record page the NFL tab, the Player Props tab and All all read −7.17u. The 24 settled priced bets were all NFL player props, and each prop was counted twice: once under NFL, because that tab took every row with `league = 'NFL'`, and again under Player Props. The CFB tab had the same flaw for college props (all leans so far, so it hid behind the leans toggle).

- **The tabs now partition the ledger** (`lib/edgedesk_pnl.js` `SCOPES`). NFL and CFB are that league's game markets only: spread, total and moneyline. Player Props holds every prop, NFL or college. All = CFB + NFL + Player Props, and each row is in exactly one.
  - On the committed 2026 ledger at flat 1u: All −4.96u = CFB +2.21u (7 priced) + NFL 58-38-2 (98 graded, none priced yet) + Player Props −7.17u (24 priced, 160 pending).
  - The NFL ledger lists 0 verified, 98 history and 0 pending. Before, it showed 24 / 122 / 160, with the props mixed in.
- **By sport** (the record card on All, *Where the record comes from*, and Advanced, which was *By league*) now reads NFL, College Football and Player Props. A prop is no longer inside its league's row.
- **The market filter** offers only the markets a tab holds. Moving to NFL or CFB while *Player props* is selected resets the filter to *All markets*, so the view is never empty. The Verified P&L card on NFL / CFB no longer shows an empty Player Props cell.
- **The database copy agrees:** `model_pnl_bets` (`supabase/model_pnl_analytics.sql`) uses the same scopes. `record/pnl/summary.json` picks up the new precomputed views on the next *Record P&L* run.
- **Tests:**
  - `pnl.test.js` 177 (the partition and by sport);
  - `pnl_ledger.test.js` 99 (NFL + CFB + props = All, in both strategies);
  - `pnl_sql.test.js` 206 (SQL scopes equal the kernel). It also loads the stored quotes that the committed ledger's locked prices cite, as the sync does. Since the 2026-10-03 rebuild priced 7 CFB picks from stored quotes, the suite had failed 3 checks on `main` (`snapshot_quote_missing: 7`). The quotes were all there; the test never loaded them;
  - `pnl_ui.test.js` 466: no tab's ledger lists the other's rows, and the college prop leans are checked on Player Props now instead of CFB.

## 2026-10-03 — two checks that went red on the live slates

Decision quality, Personal research CI and CFB research terminal failed on `main` itself, on every open PR. Two tests read the committed live slates, and those slates moved:

- **`tools/bettor/football_decision.test.js`** required PIT @ CLE to be held at the market line. That game kicked off on 2026-10-02 and left the NFL slate, so the check could not find it.
  - It now checks the audit games still on the slate: LA @ PHI is still held.
  - The rule itself is still checked on every slate game.
- **`football/cfb_terminal/read.test.js`** proves an LLM's invented probability is refused, using a fixed "71.3% to cover". This week's selected read carries a 71.4% win probability, so 71.3% is a fact within the audit's tolerance, and was rightly accepted.
  - The test now picks a percentage the facts do not hold: 72.4% on today's slate.

## 2026-10-03 — Verified P&L audited against production; the disconnects fixed

The audit traced a spread, a total, a moneyline and a player prop from the decision to the page (`docs/pnl/AUDIT.md`), and checked production's run logs.

- **Production had no `model_pnl` at all.** Every *Record P&L* run since the table was written called `model_pnl_upsert`, got `PGRST202` (no such function), and went green: the sync caught the error and exited 0, so not even the step's warning fired.
  - `tools/record/pnl_sync.js` now never fails quietly. A missing schema exits 3 and a database that disagrees with the page exits 4, each with an error annotation and a run-summary line. The step is `continue-on-error`: the page is already published and never waits on the database, but the run shows the failure.
  - After every sync it proves the database says what the page says: `verified_pnl_summary()` against the kernel's card over the same ledger (both strategies), and `verified_pnl_integrity()` at 0.
  - **Deploy Record P&L schema** (`.github/workflows/deploy-record-pnl.yml`, manual) tests the SQL on a throwaway PostgreSQL, applies the six files in order with `ON_ERROR_STOP`, syncs and prints the A–I report.
- **A locked price now resolves to a database row.** `supabase/model_pnl_quotes.sql` adds `model_pnl_quotes`, the stored quote every locked price cites, copied once by the sync and append-only. The integrity checks compare every snapshot price with its quote: same game, market, number, time and price. Where production's `cfb_lab_market_quotes` mirror exists, they compare with that independent copy too.
- **Old model decisions cannot be priced, and now say why.** The model record never stored a price before its numbers. The lab's quotes start 2026-09-27T15:07Z and cover its 71 games only. Nothing stored a timestamped NFL game price. 723 of the 731 record-only decisions now read `before_capture`; the other 8 read `line_moved`.
- **From now on every model game gets a stored price.** `tools/record/quote_ledger.js`: every hourly *Football model record* run keeps every priced pregame ESPN reading of every NFL and college game the model prices, in `record/football/quotes/<sport>_<season>.jsonl`.
  - The rows are append-only and use the lab's write-on-change and heartbeat rule; nothing is kept at or after kickoff.
  - NFL games are matched through nflverse's own ESPN id.
  - The price lock reads this ledger beside the lab's. `summary.json` `verified.price_sources` and *How P&L works* say where each league's stored prices begin.
- **The BET decisions' own mirror** was refusing every WATCH / LEAN decision. Production runs the 2026-09-28 18:28 `bettor_decisions.sql`, whose check predates them (23514 on `bds_0b368e37`), and the log called it "skipped". The schema deploy can re-apply the current file (`apply_bettor_decisions`), which accepts all 706 ledger rows. `cfb-lab.yml` now says what the error means.
- **Tests:**
  - `tools/record/quote_ledger.test.js` (19, end to end on the committed slates);
  - `verified_pnl.test.js` 76;
  - `pnl_sql.test.js` 200 (the evidence table, the cross-checks, the sync's parity);
  - `pnl_ui.test.js` 457.

## 2026-10-03 — Verified P&L: no price, no verified P&L

The Records page's Verified P&L said there were no priced bets. In fact two things were true. The P&L counted only `BET` rows. And the 738 graded model decisions (CFB 385-253-2, NFL) had no price at all: the model record never captured one, and its only stored prices were closing prices.

- **The rule.** A decision is in Verified P&L only when it settled (W / L / P) at a valid American price EdgeDesk captured **at or before** the decision, with a stake. Everything else stays in the record as **record only**, with one `pnl_exclusion_reason`.
  - Verified P&L now covers the graded record's own decisions: the model's published numbers and the BETs. So graded = verified + record only, always.
  - A price captured after its decision is `PRICE_AFTER_DECISION`: never units.
- **The price lock** (`tools/record/price_lock.js`). Every *Football model record* run freezes on each pick the market as EdgeDesk's **stored** quotes saw it when the number was published. Today that is the CFB Model Lab's hourly ESPN / DraftKings quotes.
  - It never uses a later quote, the close, today's odds, a provider average or −110.
  - A graded side is priced only when the stored quote was for the exact number it was graded at.
  - A lock is never rewritten. The ledger merge and the `model_pnl` trigger allow exactly one transition, from no price to a price.
- **The backfill** is the same lookup over picks already recorded. It is idempotent; run twice, it locks nothing new.
  - It locked **7 of the 640 graded CFB model decisions**.
  - 625 had no stored quote, because the lab's quotes start 2026-09-27.
  - 8 had a stored quote for another number than the one graded.
  - The 98 NFL decisions stay record only: the nflverse line is a reference, not a price.
- **Stakes.** The decision's own stake is used when it recorded one (`stake_source: explicit`). A model number priced by its lock risks the configurable default 1.00u (`stake_source: default`, `tools/record/pnl_config.json`).
- **Precision.** Profit is now stored to 6 places (a −110 win is +0.909091u), in the kernel and in `edp_pnl_profit`.
- **Database.** `supabase/model_pnl_verified.sql` adds the verification columns, constraints and the one-time lock. `supabase/model_pnl_verified_views.sql` adds:
  - `verified_pnl_decisions`;
  - `verified_pnl_summary`, `verified_pnl_breakdown` (sport / league / market / date / week / month) and `verified_pnl_series`;
  - `verified_pnl_integrity`.

  `supabase/verified_pnl_report.sql` is the read-only verification.
- **The page** (`lib/edgedesk_pnl_ui.js`):
  - **Model performance** leads.
  - A **Verified P&L** card sits under it: net units, ROI, priced decisions, *N of M graded decisions included · K record-only excluded*, units risked, Spreads / Totals / Moneylines / Player Props, and a chart of verified decisions only.
  - Each history row shows `price · stake risked · units`, or *Record only · Price unavailable*.
  - A market filter is added.
  - The card draws from the precomputed summary before the rows file loads.
- **Today:** 762 graded = 31 verified + 731 record only. Verified P&L is +0.42u on 13.00u risked (ROI +3.21%), with 0 integrity errors.
- **Tests:**
  - `tools/record/verified_pnl.test.js` (67 checks: the spec's 10 cases, its 3-bet example, the lock, the backfill, the audit);
  - `pnl_sql.test.js` (172, against a real PostgreSQL);
  - `pnl_ui.test.js` (456, Chromium at 375–1440 px).

## 2026-10-02 — a partial NFL replay no longer regrades the staking modes

The follow-up from the entry below. `tools/intelligence/validate_staking.js` grades the NFL markets on the same engine replay (`validate_pricing.js` `replayNfl`). On the nightly run that could not fetch 2016, it wrote `staking_nfl.json` from 2,642 engine rows instead of 2,658, with 2016 missing from `seasons_loaded`. The staking kernel reads the MODE that file writes, and refuses to stake a SHADOW market.

- **Guard**: with `--write`, a sport whose engine replay loaded some team-week seasons but not all of `replay_from`–`last` is refused.
  - Its file is not written, and the committed one stands.
  - The other sport is still written, and the run exits 3. The learning loop runs it under `continue-on-error`.
- **Unchanged**: with no season cached at all, the replay is not partial. The Elo stand-in is still written, as documented, and labels itself (`engine.available: false`).
- **Checked**:
  - Full cache: written, content identical to the committed file.
  - 2016 removed: NFL refused with exit 3, `staking_nfl.json` byte-identical, `staking_cfb.json` written.
  - No cache: the Elo stand-in is written with exit 0, as before.

## 2026-10-02 — a partial NFL replay no longer reprices the board

`main` went red at `a41195e` (learning loop, 15:56Z). Three checks failed on the same two assertions in `tools/bettor/football_decision.test.js`: Decision quality, Personal research CI and CFB research terminal. The board no longer matched the slate pricing kernel's fair line, off by 0.02 to 0.08 pts on 13 games, and PIT @ CLE was held without crossing.

- **Cause**: `stats_team_week_2016.csv` failed to download on the nightly runner. `validate_pricing.js` logged "the season is skipped in the replay" and wrote the refit anyway.
  - 2016 dropped out of `seasons_loaded`, and 236 fewer games were absorbed (4,889 to 4,653).
  - The NFL blend refit without it: the 2019 holdout tuned on 706 games instead of 722. `latest_coef` moved from −0.3811 + 1.1565×market + 0.2320×(projection − market) to −0.3664 + 1.1551×market + 0.2411×(projection − market).
  - The board reads these coefficients live. `football/nfl/slate.json` was still priced on the complete 2026-09-16 validation.
- **Data**: `football/validation/pricing_nfl.json` and `feature-status-nfl.json` are restored to their pre-loop bytes.
  - Re-running `validate_pricing.js` with all 20 seasons cached reproduces them exactly, apart from `generated_at`: model MAE 10.382, c = 0.232, `unchanged` on a second run. The slate needs no reprice.
  - `staking_nfl.json` was regenerated with `validate_staking.js --write` from the same full cache. It keeps the loop's one new archive game (7,325) and restores the 16 2016 engine rows (2,658 joined).
  - `--reprice` on the partial refit was tried and rejected. It fixes the two assertions, but on coefficients fitted without a season PIT @ CLE's blend lands 0.03 pts short of the market line, so the audit check fails instead.
- **Guard** (`tools/football/validate_pricing.js`): if a replay season's team-week file is still missing after the fetch, the NFL validation refuses, exits 3 and writes nothing, so the last complete validation stands. This covers `pricing_nfl.json` and `feature-status-nfl.json`.
  - Both callers (learning loop and weekly build) run it under `continue-on-error`.
  - Checked with 2016 removed from the cache: exit 3, both files byte-identical. With the full cache: `unchanged`.

## 2026-10-02 — the app's CFB ladder is the terminal's curve, whatever the market

The entry below fixed the terminal. Two readers still fell back to the engine's per-line lookup (`EDCfbP4.dist.coverProbSpread`) whenever `cfbConditionedCover` refused a market outside the ±45 table, or there was no market: `app.html` `fbQevModelCfb` (the alternate ladder and the EV-by-spread chart) and `tools/football/ev_plausibility.js` `coverFor`. So the app priced McNeese @ LSU (LSU −52.5) on a curve that rose with the line (P(M > 18) 0.9270, P(M > 18.5) 0.9309 at fair +41.42, σ 14.9), while its comment said it read the terminal's distribution.

- **One shared row** (`lib/edgedesk_quote_ev.js`):
  - `cfbPmfRow(distributions, fair, marketMargin)` is the market margin clamped to `pmf_spread_range`, or the fair margin clamped the same way when there is no market. `cfbGameCover` reads `cfbConditionedCover` at that row.
  - `cfbConditionedCover` itself is unchanged and still byte-identical to the pre-move function.
  - `football/cfb_terminal/build.js` `v1PmfRow` now calls `cfbPmfRow`. The terminal build is unchanged: `cfb:terminal:check` passes with no new snapshot.
- **The app** (`app.html` `fbQevModelCfb`):
  - `mk.spread_line` is already a home margin (home −52.5 → +52.5, `fbMarketFromEvent`), the same variable as the terminal's `_consMargin`, so it is clamped as is.
  - A market dropped for its orientation (`spread_fault`) counts as no market, as before, and so reads the fair margin.
  - The basis says when the shape was read at the table's edge or at the fair margin. The engine's per-line call remains only for a params file with no table.
  - `app.html` loads `lib/edgedesk_quote_ev.js?v=20261002a`. Both of its loads of the module carried no version before.
- **The EV plausibility bound** (`tools/football/ev_plausibility.js`) measures z in the width of the same curve. `football/validation/ev_plausibility.json` was regenerated with the tool from fresh cfbfastR-data and nflverse caches. The old code reproduces the committed file exactly from those caches, so every change below comes from this fix:
  - Affected CFB rows: 6 of 2,249 fit closes and 5 of 1,602 holdout closes lie past ±45, plus 22 synthetic off-by-7 lines.
  - z* is unchanged (CFB 0.9601), so `PLAUSIBLE_Z` is unchanged. NFL is unchanged.
  - Fit q99 moved from 0.8737 to 0.8785.
  - Holdout off-by-7 lines caught by the new bound rose from 7.18% to 7.37% (13.17% to 13.36% with the rest of the integrity stack).
  - The old flat 25% rule now flags 19.66% of real games (was 19.73%), and catches 98.56% of off-by-7 lines (was 98.63%).
- **Tests**:
  - `tools/football/quote_ev.test.js` §15 lifts `fbQevModelCfb` from `app.html` verbatim. At an out-of-table market, its mirror, the edge, an in-range market, no market and a faulted market, it must equal `v1Dist(...).cover` at every half point from −70 to +100, never rise, and price both sides of the ladder the same. `ev_plausibility.js` must measure the same width. Against the old `app.html` it fails 9 checks.
  - `tools/football/quote_ev_ui.e2e.js` reads McNeese @ LSU off the rendered board, priced against its captured LSU −52.5. Its curve must equal the terminal's at the fair margin, σ and market the page used, and never rise. Against the old `app.html` it fails 3 checks.

## 2026-10-02 — every CFB curve is one distribution, whatever the market

The two follow-ups from the entry below are closed. 47 of 115 stored CFB curves were incoherent: P(margin > t) rose with t. These were McNeese @ LSU (LSU −52.5, past the ±45 margin PMF table) and the 46 games with no market yet. All of them were built from the engine's per-line lookup (`football/cfb_p4/engine.js` `coverProbSpread`), which keys the table by whichever line it is asked about. Sampled at every half point, it stitched a different shape onto each threshold. Past ±45 it also switched to the pooled residual, which is neither shifted onto whole points nor stretched. McNeese @ LSU read 0.9457 at 17.5, 0.9270 at 18 and 0.9309 at 18.5.

- **One table row for the whole curve** (`football/cfb_terminal/build.js` `v1Dist`):
  - A market outside the table now reads the table's nearest edge: the market margin clamped to `pmf_spread_range`. That row is the kernel-weighted shape of the most lopsided spreads on file. Markets at 45 and 45.5 read the same row, so the curve does not jump at the edge.
  - With no market, the shape is conditioned on EdgeDesk's own fair margin, clamped the same way. `decisions.js` conditions its closing distribution on its centre in the same way.
  - Either way `EDQuoteEV.cfbConditionedCover` builds the curve exactly as it builds an in-range market's. It is re-centred by a whole-point shift and stretched to the game's σ, so every curve is monotone and lives on whole-point margins. `cfbConditionedCover` itself is unchanged and still byte-identical to the pre-move function.
  - The pooled residual re-centred on the fair margin was the other candidate, and was rejected. It is the shape of all games, mostly close ones, and it jumps at the table's edge.
  - A curve now names the row it read. The basis text says when that row is the table's edge or the fair margin, and `v1Dist` returns `pmf_row`. `conditioned_on_market_margin` stays the market itself, or null with none.
- **What changed and what did not**:
  - The 68 curves conditioned on an in-range market are byte-identical.
  - At an out-of-range market line the curve no longer equals the engine's own `coverProbSpread`, which there is the pooled residual. P(LSU covers −52.5) was 0.2193 and is now 0.2437 (σ 14.84).
  - McNeese @ LSU is no longer held at MALFORMED PROJECTION:
    - Replayed with its captured prices, and in a build at 13:00Z while its market was fresh, the bettor decision is PASS (EVALUABLE).
    - At 16:34Z its last quote (12:07Z) is stale, so it reads NO DECISION for STALE_QUOTE alone.
    - The EV read stays INVESTIGATE: an 11-point gap to the market is past the implausible-EV bound, as it was before.
  - The committed calibration dataset (`football/cfb_ev/data/cfb_ev_calibration_rows_v1`) is left as frozen. 74 of its 27,870 rows (|market| > 45, all with `pmf_conditioned` 0) would now read a different raw cover: median |Δ| 0.039, max 0.096, including 9 of the 3,120 OOS close rows. `tournament.js --check` still reproduces `calibration.json` exactly. A dataset rebuild would pick up the new rows.
- **Tests**:
  - `football/cfb_terminal/read.test.js` §2b pins the McNeese @ LSU curve, its mirror, the table edge and three no-market curves. Each must be one coherent distribution: never rising, no mass at a half point, P(M > 18) = P(M > 18.5), and the fall across a whole number equal to its mass.
  - `football/cfb_terminal/tests.js` holds every curve of a fresh build to the same rules. Its engine-parity check is now limited to markets inside the table, and past the table the curve must equal the edge-conditioned one.
  - `tools/bettor/football_decision.test.js` is back to zero incoherent replayed games.
- **Rebuilt** `football/cfb_terminal` (16:34Z): every game's curve is coherent and no DISTRIBUTION_SANITY check fails. The decision record (`decisions/2026/snapshots.jsonl`) gains 47 snapshots, one for each changed curve. The old code appends none at the same clock.

## 2026-10-02 — four checks that went red on today's live data

Four PR checks failed on `main` itself: CFB research terminal, Record P&L, Personal research and Decision quality. Decision quality and Record P&L hid three more failures behind their first ones. Overnight the pipelines produced data the tests had never seen. Each cause was traced before anything changed:

- **The decision grader attached a "close" the database refuses** (`football/cfb_terminal/decisions.js`):
  - Western Kentucky @ New Mexico State was evaluated at 23:07:32 on the 23:07:23 capture, the last before kickoff. That same capture was handed back as the row's close, with CLV 0.
  - The leakage audit (`CLOSE_BEFORE_EVALUATION`) and `supabase/decision_validation.sql` both require the close to be captured after the decision.
  - A close is now attached only when captured after the evaluation (`closeAfter`). Otherwise the row grades without CLV, as a game with no captured close always has.
  - The one row already written was repaired with the same rule (`withoutEarlyClose`): its close and CLV are now null and its result is unchanged.
- **The Lab's first live checkpoints were graded** (`tools/validation/validation_engine.test.js`):
  - 64 rows with origin `LIVE` now read as LIVE. They pass the same pregame audit, and their sample still cannot license a recalibration.
  - The check that no Lab row was LIVE described a Lab with nothing graded yet. It now checks that only the Lab's own live checkpoints read as LIVE.
- **An incoherent curve is held, not priced** (`tools/bettor/football_decision.test.js`):
  - McNeese @ LSU (LSU −52.5) lies outside the ±45 range the margin PMF table is conditioned on. Its curve came from the engine's per-line lookup, which borrows a different shape at each half point, so the stored P(margin > t) rises with the line.
  - The engine rightly holds it at MALFORMED_PROJECTION. The replay now reads the incoherence off the curve itself and requires exactly that hold, for at most one game.
  - The curve builder for such games is a follow-up.
- **An NFL card showed college rows as its history** (`lib/edgedesk_decision_ui.js` `healthBinsFor`, found behind the first Decision quality failure):
  - The Lab view's HISTORICAL BUCKETS preferred the LIVE decision buckets as soon as any live decision was graded. That ledger is the CFB terminal's, so the first three graded CFB rows replaced the NFL walk-forward buckets (n=1,893) on every NFL card.
  - LIVE buckets now show only on a card of the sport every live row belongs to. `app.html` loads the file as `?v=20261002a`.
- **The P&L parity check compared different rows** (`tools/record/pnl_sql.test.js`):
  - The real ledger is loaded into the same `model_pnl` table before the dollars check. The first 24 settled BETs (NFL props, PIT @ CLE) made the SQL net −7.24 u against the fixture-only −0.07 u.
  - The kernel and the SQL agree on every row. The check now gives the kernel the same rows the SQL reads, so it also proves parity on real data.
- **The P&L page's live re-read check raced** (`tools/record/pnl_ui.test.js`, found behind the `pnl_sql` failure):
  - After a settlement run the test switches the served ledger to the fixture and waited for any profit / loss / even hero.
  - The real ledger now reads Loss (−7.16u) itself, so the wait returned before the re-read and compared the real figures.
  - It now waits for the fixture's own net. The page's re-read was never wrong.
- **The card priced a curve the terminal refuses** (`lib/edgedesk_decision_inputs.js` `integrityFacts`):
  - The card held an incoherent curve only through the circuit breaker's DISTRIBUTION_SANITY check. That check runs only when the EV or the gap is extreme.
  - In the 15:07 build McNeese @ LSU fell below that, so the terminal read NO DECISION (`DISTRIBUTION_FAULT`, checked every time in `lib/edgedesk_ev.js` `decide`) while the card priced a PASS.
  - The card now honours the EV layer's own verdict. `app.html` loads it as `?v=20261002a`.
  - It is not one game: 47 of 115 stored curves are incoherent. They are every curve built without a usable market (46 with none yet, plus McNeese), because the engine's per-line fallback borrows a different shape at each half point. All 68 market-conditioned curves are coherent.
  - Those 46 were already NO DECISION; the card now gives the terminal's reason. Making the no-market curve one coherent distribution is the follow-up.
- **The home board's size-budget check found no card to copy** (`tools/home/home.test.js`):
  - It builds a 120-game week from a real research-grade opportunity on the committed NFL props board. The 14:56Z board held 16 events and no opportunities between slates, so it crashed on `JSON.parse(undefined)`.
  - When the board has none, it now copies the probe's committed props block (`tools/home/fixtures/props_block.json`). It also checks that a card was found.

## 2026-10-02 — the EV-by-spread chart lays out cleanly on wide alternate ladders

On a wide ladder (Northwestern: +28.5 down to −2.5, a ten-point hole, prices to −10000) the *EdgeDesk EV by spread* chart printed every number's line, price and cover on top of its neighbours. MAIN overprinted MAX EV, and the curve ran through SAFEST +EV. The audit found more than one defect:

- **Chart** (`app.html` `fbQevChartPlot`):
  - it is laid out at the width it is drawn (`fbQevChartFit`, a ResizeObserver), so its text is no longer scaled 1.5× on a desktop card and 0.56× (about 5px) on a phone;
  - axis labels are thinned until none collide. The tagged numbers, the numbers either side of a hole and the two ends are labelled first; hovering any point still gives its line, price, cover, break-even and book;
  - a stretch of more than 2 pts with no number dealt is drawn short and dashed, never as a known stretch of curve;
  - MAIN / SAFEST +EV / MAX EV sit above the curve with a halo. A tag that would overprint another moves to the other side of its point, or climbs above with a leader. One number carrying several tags reads `MAX EV · MAIN`;
  - y ticks are round numbers, and zero reads `0%`, not `+0%`. All chart text is at least 10px, the app's type floor on phones.
- **Buying points**:
  - juice is not quoted in cents past ±1000, where −5000 → −10000 read `5000¢` for 1.0 pp of break-even (`EDQuoteEV.centsComparable`; also the card's price advantage and the step text);
  - the key-margins cell wraps, so the Read column no longer scrolls off the card;
  - a falling cover reads `−0.4 pp`, not `+-0.4 pp`.
- **Ladder table**:
  - a stale quote's reason uses the age column's units (`captured 17h ago`, not `captured 998 min ago`; `EDQuoteEV.ageText`);
  - the LC note appears only when an LC row is shown, and no longer nests parentheses.
- **The same defect in the research terminal** (`research/cfb/terminal.js` `frontierChart`):
  - the axis labelled every other half point, however wide alternates made it. It now uses round ticks at a step whose labels clear each other;
  - the FAIR / CURRENT / BETTABLE TO / TARGET labels stacked by `i % 3`, so a fourth overprinted the first, and a mark near the right edge was clipped. They now take the first free row, stay inside the plot and draw over the mark lines.
- **Tests**:
  - `tools/football/quote_ev_ui.e2e.js` adds a wide-ladder fixture game. At 1280px and 390px it checks: no chart label overprints or leaves the chart, the text is unscaled, the hole is dashed, `0%`, MAX EV tagged, no cents past ±1000, the table fits, and no `+-`. 54 checks. Nine of the new checks fail on the previous code;
  - `tools/football/quote_ev.test.js` adds the age text and the cents rule (218 checks).

## 2026-10-01 — college player props on the Records page

The college props were tracked but left off the page. There are 464 of them; every one is a LEAN while the college props model is EXPERIMENTAL. Without *Include leans*, the CFB view showed no player props at all.

- The **Player props** tile (`lib/edgedesk_pnl_ui.js` `marketTile`) shows the leans tracked beside the bets, in the CFB view and in every other view:
  - CFB: *464 leans tracked*;
  - All: *138 bets pending · 1,239 leans tracked*.

  Once games finish it shows their W-L, marked leans.
- The props view's headline counts every tracked prop: *1,377 recommendations tracked (138 bets, 1,239 leans)*.
- The *Pending* ledger says the leans are tracked, with an *include leans* button that lists them.
- Leans still never enter the record or the P&L unless the reader includes them. The college model's gating is unchanged.
- `tools/record/pnl_ui.test.js`: 257 checks, against the committed data:
  - the CFB tile's lean count;
  - the CFB record unchanged;
  - the pending note;
  - one tap listing the college props.

## 2026-10-01 — the Records page leads with how the model has performed

The page answered "can we calculate exact P&L?" before "how has the model performed?". With nothing priced settled yet, its first and largest message was "0 settled verified bets", above a graded record of 432-284-4. That made a tested model look untested.

- **The headline is the best real figure in the view** (`lib/edgedesk_pnl_ui.js`):
  - **MODEL P&L** (net units, ROI, W-L-P, bets, chart) once priced bets have settled;
  - otherwise **MODEL PERFORMANCE**: 432-284-4, 60.3% won over 720 graded decisions, and each market's record:
    - spread 123-136-4 (47.5%);
    - totals 99-95 (51.0%);
    - moneyline 210-53 (79.8%);
    - player props waiting for settlement.
  - It is marked record only and carries no units.
- **The verified P&L's own status** is a small box under the headline: *Waiting for first priced settlements*, the pending priced bets and the first game.
- **New order:**
  - the headline;
  - the verified P&L status;
  - historical model results (by sport, *Historical P&L unavailable*, why pending — never repeating the headline);
  - the filters (tabs, period, stake, leans);
  - the ledger;
  - *How P&L works* and *Advanced Analytics*, collapsed.
- **Tabs** show each scope's net, else its record (ALL 432-284-4, CFB 376-247-2, NFL 56-37-2), else *Pending* — never — when graded data exists.
- **The ledger has three views:**
  - *Verified P&L*: odds and units, totalling the headline's net;
  - *Historical graded*: date, sport, bet, result and record status *Verified* / *Record only*, counting the record's 720;
  - *Pending*.

  It opens on verified P&L once there is some, else on the graded history.
- `tools/record/pnl_ui.test.js` (249 checks) pins:
  - MODEL PERFORMANCE vs MODEL P&L, against the kernel;
  - the status box and its pending count;
  - the page order;
  - the three ledger views and the history columns;
  - the ledger opening on the history when nothing is verified.

## 2026-10-01 — the Records page populates from every graded recommendation

The Records page showed 0, — and empty tables even though the ledger held 2,052 recommendations, 720 of them graded. Every figure was computed from verified priced bets only, and none had settled. The fix covers the pipeline first, then the page.

**What the data showed (traced, not assumed).**
- All 1,332 pending rows are upcoming games: props on Oct 2–5, CFB decisions on Oct 2–10. The props ledger began today, so no prop has finished.
- The 720 graded rows are the model record: 432-284-4 (60.3%).
  - Spread: 123-136-4 over 263.
  - Totals: 99-95 over 194.
  - Moneyline: 210-53 over 263.
- None of them carries an entry price.
- Two silent gaps in the settling jobs:
  - The props grader worked out why a prop was pending and then dropped the reason.
  - The CFB decision grader would never settle a finished game whose closing line was not captured.

**The pipeline.**
- **One state per row.** Each row is `PENDING`, `VERIFIED`, `RECORD_ONLY`, `VOID` or `INVALID`, set by `lib/edgedesk_pnl.js` (`stateOf`, `record_state`).
  - An unreadable settlement is now `INVALID` with its value, instead of quietly pending.
  - So is a recommendation stamped after kickoff.
- **Why pending.** `tools/record/pnl_core.js` (`pendingReason`) gives each pending row one of these reasons:
  - upcoming;
  - in progress;
  - awaiting the settlement run;
  - awaiting the stat feed;
  - missing final;
  - missing player stat;
  - settlement job failed;
  - missing mapping.
- **Where the reasons come from.**
  - `football/props/grade.js` now writes its reasons to `football/props/<lg>/settlement.json` (`pendingStatus`), including a run whose dataset failed to load.
  - The ledger also reads the finals EdgeDesk holds: the model record and the CFB Lab results.
- **No more waiting forever for a close.** `football/cfb_terminal/decisions.js` (`gradeable`) settles a final with no close after 36 h, with no CLV.
- **The ledger job** (`tools/record/pnl_ledger.js`):
  - writes the states, the reasons, the graded record (overall and by sport, market, model version, week and grade) and the integrity checks of every scope into `record/pnl/summary.json`;
  - writes a small `record/pnl/stamp.json` that the page polls;
  - fails (exit 2) if any integrity check fails.
- **The backfill** is the same idempotent build. Run once on today's ledger, it gives the counts above; a second run changes nothing.
  - The scheduled Record P&L job runs it on `main`: hourly at :41, and after every settlement job. Within the hour of this change, `record/pnl/` carries the states, the reasons and `stamp.json`.
  - Until then the page derives each row's state and the graded record from the same rows itself, and it reloads once the first stamp appears.
- **Database** (`supabase/model_pnl_states.sql`, additive):
  - `record_state` is set by a trigger and constrained (verified means priced; record only means no units);
  - `pending_reason` is written only by `model_pnl_reasons()`, which `tools/record/pnl_sync.js` now calls;
  - `model_record_canonical` is one normalized view (`id`, `game_id`, `event_time`, `model_value`, `entry_odds`, `recommendation_grade`, `settlement_result`, `pnl_units`, `clv`, `record_state`, …);
  - `model_record_states` holds the counts.

**The page** (`lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`).
- **Order.** The view comes first (tabs, period, stake, leans), then the verified P&L, then its chart, then the graded record directly under them.
- **With nothing priced settled**, the verified P&L reads *Waiting for first priced bets to settle* with the pending priced bets and the first game. The record below shows:
  - 720 graded and 432-284-4 by market;
  - the split by sport;
  - *Historical P&L unavailable* for the 720 unpriced results;
  - the pending count with its reason.
- **Tabs** show their record (CFB 376-247-2, NFL 56-37-2) while nothing priced has settled, instead of —.
- **Advanced Analytics:**
  - opens on *Where the record comes from*: W-L-P by sport, market, model version, week and grade;
  - says *Waiting for settlement* once instead of drawing tables of 0.00u;
  - holds every row's state, *Why pending* with each reason's count, and the agreement checks.
- **Players** with nothing settled show —, not 0-0-0. That was checked against the rows.
- **The ledger** gains a *Record only* view (720 graded results, units —). Its audit shows each row's state and why it is pending.
- **Empty is not zero.** The kernel's `summarize` returns `null`, not 0, when there is no settled bet.
- **Integrity on every render.** `EDPnl.integrity()` proves the figures agree:
  - the hero's bet count equals the ledger rows, and its net equals their sum;
  - the chart, the sport and market breakdowns, and the record's markets and sports all add up;
  - every row has one state.
  - A failure shows as an *internal check failed* banner.
- **Live.** The page polls the stamp every 5 minutes and when it is shown again, and re-reads the ledger after a settlement run.

**Tests:**
- `tools/record/pnl.test.js`: 172 checks (states, the record, reasons, integrity, null-not-zero).
- `tools/record/pnl_ledger.test.js`: 97 checks. They pin every pending reason, check the stamp, and rebuild the real sources: one state per row, integrity in every scope.
- `tools/record/pnl_sql.test.js`: 113 checks against a real PostgreSQL. The trigger matches the kernel on every row, and so does the real ledger.
- `tools/record/pnl_ui.test.js`: 222 checks in Chromium. On real data there is no 0.00u or 0-0-0 anywhere, the tabs show records, the reasons add up, and a moved stamp reloads the page.
- `football/props/pipeline.test.js` adds the pending statuses.
- `tools/bettor/football_decision.test.js` adds grading without a close.

## 2026-10-01 — the Washington starter check follows the injury report

The committed-slate check in `tools/football/nfl_regime.test.js` required that Colts @ Commanders (week 4, Tottenham) never price Jayden Daniels. That was true on the week-3 report, which listed him OUT with an elbow injury. The week-4 report lists him as limited in practice with no game designation. The slate rebuilt at 18:54 UTC rightly priced him from the schedule feed, and Intelligence CI and Collective suites went red on every open PR.

- The check now applies the builder's own rule (`starterOf` / `fbNflReconcileStarters`) to the committed report:
  - a schedule-feed starter must not be OUT or DOUBTFUL on it;
  - a replacement must name the scheduled starter as OUT or DOUBTFUL, and the report must still say so.
- The report is held against the slate only when the slate was built after the report was retrieved, because the injury sync and the slate build run separately.
- The no-home-field-at-Tottenham check is unchanged.
- The fixture build in section 4 still pins the OUT-on-week-3 → Mariota substitution.

## 2026-10-01 — the Records page answers "is the model up or down?" first

The Records page was an analytics dashboard: a reader had to read CLV, data-quality counts and pending totals to learn whether EdgeDesk makes money. It now opens on one answer, and everything else is one tap away.

- **The summary, first** (`lib/edgedesk_pnl_ui.js`, `lib/edgedesk_pnl.css`). It shows the verified model P&L: settled BET recommendations with a captured entry price.
  - Net units is the largest number on the page, followed by PROFIT, LOSS or EVEN, then ROI, W-L-P, win rate, the number of verified bets and the period.
  - With nothing settled it reads **Not enough settled priced bets yet**, with the settled and pending counts. It never shows a giant 0.00u.
- **Tabs** ALL / CFB / NFL / PLAYER PROPS, each with its own net.
- **Controls:**
  - a period: Season (the default), 30 days, 7 days or All time;
  - a stake choice: flat 1u or EdgeDesk stakes;
  - *Include leans*, off by default. PASS and WATCH are never bets.
- **One chart**: cumulative units and the running peak, with current, peak and max drawdown under it. There is no drawdown wash.
- **Historical model results**: spread, totals and moneyline as wins and losses only, labelled *Record only — exact historical P&L unavailable because entry odds were not captured.*
- ***How P&L works*** and ***Advanced Analytics*** replace the long paragraphs and are collapsed.
  - Advanced holds more numbers, drawdown, game markets vs props, every breakdown, calibration, CLV vs P&L, player performance and data quality.
  - In the app it also holds the detailed records: Edges record and Football model record.
- **The ledger** has six columns: date, sport, bet, odds, result, units. A row opens to its audit. Settled and pending are separate views, and the verified total is the summary's net.
- **One dataset.** The summary, tabs, chart, advanced figures and ledger total are all computed from one filtered set of rows by `lib/edgedesk_pnl.js`, so they cannot disagree.
- **The app** (`app.html`): the summary is the first thing under the Records header. The Profit & Loss tab is gone; an old link to it lands on the summary. The Football board's track-record link opens the football model record inside Advanced Analytics.
- **The historical record is a record again.** The units added to the football model record on 2026-10-01 (#456) are gone from the page and from `record/football/summary.json`. The record job no longer assumes −110 for anything: a pick is priced only at a captured closing price (`grade.pnl`, auditable data the page does not show). The captured closing prices are kept.
- **The public record** (`record.html#pnl`) uses the same component. Its long introduction is now one line.
- **Tests:**
  - `tools/record/pnl_ui.test.js` (192 checks) checks the summary, tabs, chart readout and ledger total against the kernel under every scope, period, stake and the leans switch. It also covers the empty state, the record-only historical card, the collapsed sections, the six-column ledger and audit, the app layout, phone widths and no horizontal scroll.
  - `tools/record/signal_pnl_ui.test.js` opens Advanced Analytics to reach the edges record.
  - `tools/record/football_record.test.js` covers no assumed −110 and a summary with no units.

## 2026-10-01 — the landing board holds its own size

The 17:03 Player props rebuild wrote `football/home/board.json` at 75,707 bytes, over the 64 KB the landing page allows. That turned Funnel tests and Collective suites red on `main`. Nothing was wrong with the data: a full NFL week plus a college week put props on 79 games, and `LIMITS` capped the cards per game but not the number of games.

- **A size budget in the build** (`tools/home/build_home.js`, `fit`). Past 60 KB, the games furthest from kickoff give up their prop cards first. Each keeps its counts, and the page uses the research state's own props for that card. The cross-league top 12 is never trimmed. Items nothing points at any more are dropped. What was taken is counted in `props.counts.trimmed`.
- **The board rebuilt** with the budget: 61,009 bytes. All 79 games keep their counts; the 8 latest lose their cards.
- **Unchanged:** the page, the limits per game, the top list and every number on the board.
- **Tests** (`tools/home/home.test.js`): a 120-game week built from a real research-grade opportunity, with these checks:
  - it is over 64 KB without the budget and under it with;
  - the top list is untouched and every id resolves;
  - no item is left that nothing points at;
  - the latest games lose their cards first and keep their counts;
  - the trim is counted, and the build is deterministic.

## 2026-10-01 — the football record is graded in units; Profit & Loss is part of the record

Every graded pick in the football model record now carries a profit or loss, and the Record tab shows it beside every win–loss figure. The separate Profit & Loss tab is gone: its content is the last part of the football record.

- **Real closing prices** (`tools/record/football_record_sources.js`). The record grades every side against the closing line, so it now prices every side at the closing price of that line, read from the same source in the same read:
  - NFL: nflverse `home_spread_odds`, `away_spread_odds`, `over_odds`, `under_odds` and the moneylines;
  - CFB: the ESPN book's `spreadOdds`, `overOdds`/`underOdds` and `moneyLine` (or the nested close), taken only from the reading that gave the line.
- **P&L per pick** (`football_record_core.js`, `grade.pnl`). 1 unit on the spread side, the total side and the straight-up pick, at that side's closing price. A spread or total whose closing price was never captured is priced at the standard −110 and marked `basis: "standard"`. A moneyline is priced only at its real price; without one it counts in the straight-up record only. The arithmetic is `lib/edgedesk_pnl.js`, the same kernel the P&L ledger uses.
- **Price backfill.** A held close takes a price only for the exact line and book it already holds, and a held price is never replaced. NFL closes fill from nflverse on the next run. Graded college games without a price are asked for one through ESPN's summary: newest first, 60 per run, at most 3 times per game.
- **The summary** (`record/football/summary.json`) adds units, risked units, ROI and price basis to every record. It also adds: the moneyline, the net across all three markets, units by points off the close, favourite/underdog, home/away, over/under, a running total by week, and units per CFB matchup group.
- **The Record tab** (`app.html`): the books are now **Edges record** and **Football record & P&L**.
  - The football record opens with its net units, the three markets and a game-by-game running-total chart (hover, tap or arrow keys).
  - Every record tile, the matchup and week tables, and every game row show units. Each game row also shows the price it was graded at, with `std` where the price is the standard −110.
  - A new **What has worked** table and a **By how far the model was from the close** table.
  - **The bets EdgeDesk recommended** (props and game decisions at their recorded prices, `lib/edgedesk_pnl_ui.js` with a row filter) comes last. Model-record rows are left out there because they are priced above.
  - Old links and saved choices for the P&L tab open the football record at that section.
- **First numbers** (re-run on real nflverse data):
  - NFL: all 95 graded picks are at the real closing price. ATS 19-11-2 is +6.04u, totals −0.49u, moneyline +1.08u: net **+6.63u**, ROI +7.1% on 93u risked.
  - CFB: −35.00u at the standard −110, until the record job reads ESPN's closing prices.
- **Unchanged:** grading itself (sides, results, CLV, Brier), the P&L ledger `record/pnl/`, its database copy, and the public `record.html`.
- **Tests:**
  - `tools/record/football_record.test.js`: 19 new cases. Price parsing (nflverse, ESPN flat and nested, a mismatched line refused); the close-price fill rules; P&L at −105, +120, a loss, a push, the standard −110 and an unpriced moneyline; summary units, ROI, splits, gaps and running total; the price-ask bound; the committed record's units equal the sum of its picks.
  - `tools/record/pnl_ui.test.js`: P&L lives in the football record, and model-record rows are not counted twice.

## 2026-10-01 — an open Football tab keeps its prices current; aged quotes are STALE, not a MARKET FAULT

Thursday night's PIT @ CLE read NO DECISION · STALE_QUOTE on every market, and "NFL MARKET SELF-CHECK FAILED" named it as a MARKET FAULT. That was 30 minutes after capture had re-priced the game. Capture and pg_cron were healthy; the fault was in the page (`app.html`).

- **Prices re-read every five minutes** (`fbPriceRefresh`). Before this, an open tab re-read the captured quotes only on its six-hour re-learn. Quotes go stale after 90 minutes a day out, 45 inside six hours and 15 inside two. Now the NFL and FBS boards re-read `signals` every five minutes while the Football module is on screen, and again when the tab comes back to the foreground, then repaint. Open sections, expanded FBS cards and the scroll position are kept. A failed read keeps the quotes already held, which then age into STALE on their own timestamps.
- **No current quote: the last capture, not every row on file** (`fbLatestCapture`). `signals` keeps the opener and every point a line has passed through. After a line move, the median of that whole history sat off the last line the books dealt, so aged quotes read MARKET FAULT and failed the NFL self-check. The stale fallback now uses only the newest capture run's rows, for spreads, totals and the moneyline. It is still marked STALE and still leaves the research ranking.
- **Unchanged:** capture, the freshness ladder, the self-check bound, the decision engine and every model. Current-quote behaviour is identical.
- **Tests:**
  - `tools/football/market_join.test.js` sections 7–8: the aged PIT @ CLE board (fails on the old code with the same self-check message), and the refresh, including a failed read, a reload in flight, another module on screen and a read overtaken by a reload.
  - `tools/football/price_refresh.e2e.js` (`npm run football:prices:e2e`): the same case in Chromium. A three-hour-old capture reads stale with no market fault. After capture re-prices the game and the reader returns to the tab, the card decides on current quotes and the open section is still open.

## 2026-10-01 — profit and loss of every flagged edge, written by the database at settlement

Every flag in `signals` now carries a recorded P&L: 1 unit flat, at the price frozen when the edge was flagged. It is written in the same transaction as its settlement, and shown on the public record beside closing-line value. `docs/pnl/EDGE_PNL.md` has the full account.

- **Database** (`supabase/signal_pnl.sql`, `signal_pnl_summary.sql`, `signal_pnl_sync.sql`):
  - `pnl_grades`: one row per `sig_key`, foreign-keyed to the signal.
  - `pnl_grade_history`: append-only.
  - `pnl_summary`: by sport, tier, market, day / week / month and all-time.
  - `pnl_reconciliation()`, `pnl_verify()`, `pnl_handcheck()`.
- **The math.** +150 win = 1.50, −110 win = 0.909, loss = −1, push = 0. Void is not a bet. A missing flag price is counted and never estimated. P&L at the closing book price is stored for comparison only. Every row is stamped `calc_version = pnl-v1`.
- **The hook.** A trigger on `signals` fires on the columns `settle` and `close` write. It never fails a settlement; errors are logged and reconciled.
- **Backfill.** `pnl_backfill()` is a dry run: counts, a 20-row sample, totals per sport. `pnl_backfill(true)` commits it, idempotently.
- **`record.html#edge-pnl`**, read live from `pnl_summary`:
  - units, ROI and W–L–P;
  - Tier A vs Tier B in plain words (the tier is the one capture froze; nothing is re-classified);
  - a sport filter and a running-total chart;
  - the closing-price comparison;
  - every flag not counted, with its reason;
  - the method note.
- **Records tab:**
  - a **P&L** column on every graded row, on the receipt and in the exports;
  - the old simulated column is labelled **Sim P/L**;
  - a **P&L sync** row in Pipeline health (settled flags with no P&L row: 0).
- **Unchanged:** capture, close, settle, flags, tiers, thresholds and every model. Nothing writes to `signals`.
- **Tests:**
  - `tools/record/signal_pnl.test.js`: the math.
  - `signal_pnl_sql.test.js`: real PostgreSQL. Covers the dry run, idempotent backfill, the hook in the settlement's transaction, a sabotaged hook that still lets the settlement commit, summary = raw sum, a three-way hand-check, and RLS.
  - `signal_pnl_ui.test.js`: Chromium at 375–1440 px, fed the database's own anonymous output.

## 2026-10-01 — every game keeps its brief: "All game briefs" on the publisher desk

**What went away.** The football boards list upcoming games only. A game leaves the board once it is final or six hours
past kickoff (`EDFbs.buildSlate`, the NFL `S.up` window), and its "Game brief" button leaves with it. The live builders
(`fbBriefGame`, `fbNflBriefGame`) read that same upcoming slate, so a brief opened for a game that is no longer on it has
no projection ("this game is not on EdgeDesk's upcoming FBS slate"). Finished NFL games in the week view had no brief
button at all.

**What brings it back.** The article pipeline already keeps a research record for every CFB and NFL game it has seen
(`articles/data/records/`, ~430 games). The builders above produce it before kickoff, and the pipeline freezes it at kickoff.
- **All game briefs** on the publisher desk (Edges and Football) lists every one of them, split into *Already played* and
  *Upcoming*, filterable by CFB / NFL and by team.
- A game that has kicked off opens the brief from its stored pregame record. The page says when the research was built and
  that nothing was recomputed after the result. The footer's data check reads "Pregame research", not "Current".
- A game still upcoming and on a loaded board opens the live brief, exactly as the board's own button does.
- Copy for CMS, Copy plain text, Print and Share brief work on a stored brief. Refresh reloads it. Reader check and Polish
  copy only read a market card, so they are hidden on a stored brief, which has no market card.
- Finished NFL games in the week view carry a "Game brief" again (the stored pregame record).

Nothing computes a number. Tests: `tools/presentation/app_presentation.test.js` (+22 checks, run against the committed
records).

## 2026-09-30 — second follow-up: corrected intervals, the NFL regime signal (#4), the NFL neutral site, the audit's CLV cuts (#5), the two root causes (#3)

While this pass was in progress, #444 and #445 (another session) shipped items 1, 2, 3, 5 and 6 of the follow-up (the
section below). This pass re-ran their reports rather than re-implementing them. It keeps their work and adds what was
wrong or missing:
- three of their reports' bootstrap intervals were too narrow, and two "significant" claims are not;
- item 4 (an NFL regime signal) had not been done, and the NFL board priced Washington with a quarterback who is out;
- the NFL engine applied its home field at neutral and international sites;
- the CLV report did not have the cuts the audit asked for (2+ / 3+ / 5+, regime / not);
- the root causes for North Texas @ Tulsa and Syracuse @ UConn.

Every parameter below was fitted walk-forward. None was fitted on 2024-2025 before its holdout report. "Significant"
means the 95% interval excludes zero. The market is never an input to a rating.

### Corrected — the bootstrap intervals (items 1 and 5, and the first pass's #1)

**Root cause.** `regime_backtest.js`, `regime_magnitude_backtest.js` and `clv_report.js` drew their resamples from
`(seed * 1103515245 + 12345) % 2147483648` computed in doubles. The product passes 2^53, so the low bits are lost and the
sequence falls into a cycle of about 10,466 draws. A 2,000-rep bootstrap of 500+ games therefore re-used the same few
thousand indices, and every interval came out too narrow. It was found because one interval printed as [0.22, 0.32]
around a point estimate of +0.32.

**Change.** All three use an exact 32-bit generator, `seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0` (period
2^32). Each report was re-run with `--write`. `regime_backtest.js` now records `significant` in the pooled record and in
the shipped artifact.

| claim | first published | corrected |
|---|---|---|
| first pass #1: v1 regime curve vs the standard curve, walk-forward 2014-2025 (`regime_curve.js` record) | −0.030 [−0.063, −0.006], significant | **−0.032 [−0.095, +0.033], not significant** |
| #444 #1: v1 vs standard on the regime subset, 2024-2025 holdout | −0.106 [−0.229, −0.011], significant | **−0.106 [−0.226, +0.017], not significant** |
| #444 #5: CFB CLV 2022-2025, all gaps | +0.21 [+0.14, +0.27] | +0.21 [+0.13, +0.29], still excludes zero |
| #444 #5: CFB CLV 2022-2025, gap 2-4 | +0.10 [+0.02, +0.19] | +0.10 [−0.03, +0.23], now includes zero |
| #444 #5: CFB CLV 2021 | +0.12 [+0.01, +0.22] | +0.12 [−0.01, +0.26], now includes zero |

- The section below is corrected in place (the #1 table, the v1 sentence, the #5 table) and says so where it changed.
- The first pass's MAE also reads 13.479 → 13.447 instead of 13.475 → 13.445. That is the fresh public download #444
  verified against, not the generator.
- **Nothing prices differently.** The v1 curve, N = 6 and the signal are unchanged. The magnitude refit was already a
  CANDIDATE.
- **The v1 regime curve still prices, and its gain is no longer significant.** Its point estimates still favour it, and it
  cuts the standard curve's +1.68 bias on the regime subset to +0.94. Keeping or reverting it is raised in the PR as a
  decision; this pass changes neither.
- The same generator is in `tools/intelligence/validate_staking.js`, outside this audit. It is left for a separate change.

### #4 — An NFL regime signal, and the starter the model prices (Washington without Jayden Daniels)

**Root cause (Daniels).** nflverse `games.csv` pre-fills each upcoming game's quarterback with the club's usual starter,
and it had not updated Washington's played week 3: it names Daniels, who left week 2 hurt and is OUT (elbow) on the
week-3 report. The player game logs (`football/props/nfl/players.json`) show Mariota on 100% of the week-3 snaps and
Daniels on 55% of week 2's. The board read the feed's starter, so it priced Washington with Daniels for weeks 4 and 5.

**Change (the starter).**
- `app.html` `fbNflReconcileStarters` reads the NFL injury report the research card already shows
  (`football/injuries/nfl_<season>.json`). A named starter listed OUT or DOUBTFUL is not priced. The club's most recent
  other starter is: the quarterback with the most starts this season, then last season, who is not himself OUT or
  DOUBTFUL. QUESTIONABLE is not a substitution.
- It runs over every unplayed game of the season, not only the board's window.
- When the report is an earlier week's than the game, the substitution is stated as PENDING.
- A club with nobody to name prices its carried quarterback level and says the starter is unknown.
- The substitution is a data-quality note beside the number (`home_qb_note` / `away_qb_note`, `football/engine.js`),
  never a number of its own.
- `tools/football/build_nfl_slate.js` publishes the starter it priced, with its status (`SCHEDULE_FEED`,
  `INJURY_REPORT_REPLACEMENT[_PENDING]`, `STARTER_UNKNOWN`) and the scheduled starter it replaced.

**Change (the regime signal).** `football/research/nfl_regime.py` measures three events per team-game from `games.csv`,
all known before kickoff:
- `hc_new`: the head coach's tenure began this season, including a mid-season change;
- `qb_new`: the starter is not last season's primary starter;
- `qb_out`: the club has started 2+ games and this starter is not its regular starter so far.

The NFL engine's quarterback layer already moves a club by its announced starter, so the signal is fitted on what is
left: the out-of-sample residual (`nfl_oos.csv`, itself walk-forward). The fit is OLS on the home-minus-away signals,
with `hc_new` and `qb_new` split at week 6. It is walk-forward from 2006, with validation 2016-2023. 2024 and 2025 were
scored once, with the fit through 2023, which is the shipped fit. `football/nfl/regime_nfl.js` carries the fit and its
record.

| regime subset (either side: `hc_new` or `qb_new` in weeks 1-6, or `qb_out`) | games | MAE model → adjusted | Δ [95% CI] | bias (regime side) |
|---|---|---|---|---|
| validation 2016-2023 | 1,062 | 10.224 → 10.085 | −0.139 [−0.275, −0.012] | +1.30 → +0.09 |
| **holdout 2024-2025** | 303 | 10.509 → 10.340 | **−0.169 [−0.394, +0.056]: not significant** | +1.29 → +0.17 |
| …2024 | 146 | 10.681 → 10.299 | −0.382 [−0.708, −0.048] | |
| …2025 | 157 | 10.350 → 10.378 | +0.028 [−0.280, +0.332] | |

- Coefficients (points to the club's side): new head coach −1.49 (weeks 1-6), −0.90 (later); new starter +0.13, −0.73;
  regular starter out −2.33.
- **Not promoted.** The adjustment prices only if the holdout interval excludes zero, and it does not. The board shows the
  signal per side and the adjustment the fit would make ("REGIME (not priced …)"), and adds nothing to the number.
- When the most starts this season are tied, the fit's own rule picks the earliest starter as "regular". The card says the
  starts are tied rather than naming a regular starter who is out.

**Live effect (model side, `football/nfl/slate.json` rebuilt at 20:41Z against main's 18:27Z build).**
- Colts @ Commanders (Tottenham): Colts by 0.80 → **Colts by 2.82**. Mariota for Daniels moves it +0.46 toward Washington
  (the engine's quarterback table rates Mariota slightly above Daniels). The neutral site (below) moves it −2.48.
- Giants @ Commanders: Washington by 2.49 → 2.95 (Mariota).
- 21 of 30 games show an active regime side, all unpriced.

### The NFL home field at neutral sites (found by item 3's home-field check)

**Root cause.** The NFL spread intercept (2.48 pts) is the fitted home-field advantage. It was applied to the nominal home
side of every game, including the international and neutral-site games nflverse marks `location = Neutral`.

**Change.**
- `football/engine.js` `nfl.predict` drops the intercept when `game.neutral === true`. The baseline term shows 0 and keeps
  its fitted weight.
- The board sets `neutral` from the feed's `location`, or from a verified international venue in
  `football/venues/nfl_stadiums.json`. The feed marks 57 of its 58 international games Neutral, including the 12 earlier
  games the Jaguars hosted. Only Eagles @ Jaguars (Tottenham, week 5) is marked Home. That game is priced neutral with a
  SITE note saying why.
- Without the venue table, only the feed's own designation counts.

**Result** (`football/research/nfl_neutral_site.js`, the walk-forward predictions on the feed's 90 neutral-site games,
2003-2025):
- The nominal home side finished 3.00 pts under the number: CI [−6.02, −0.01].
- Removing the intercept moved the MAE −0.28, CI [−0.75, +0.23]: **not significant**. This ships as a correction of what
  the term means (a neutral site has no home team), not as a fitted gain.
- Eagles @ Jaguars: Jaguars by 6.51 → 4.03. Colts @ Commanders: −2.48 of the move above.

### #5 — The audit's cuts on the CLV report (2+ / 3+ / 5+, regime / not)

**What was missing.** #444's report buckets by 0.5-2 / 2-4 / 4-7 / 7+ and has no regime split. The audit asked for 2+,
3+ and 5+ against the opener, split regime / not and CFB / NFL.

**Change.** Nothing is fitted and no cut is chosen here.
- `tools/football/clv_report.js` adds `by_threshold` to every sample: cumulative 2+ / 3+ / 5+. Each is split by the v1
  regime flag (either side's team-season fires the signal the shipped curve uses) and by games played against the curve's
  own fitted research minimum (`min_games_for_research` = 6).
- `football/cfb_p4/research/replay_rows.js` carries the flag and the projection's games-played count, on request only
  (`regime: true`). Every other number in the report is byte-identical.

| CFB replay 2022-2025 (the engine's held-out window) | 2+ | 3+ | 5+ |
|---|---|---|---|
| all: toward rate, CLV pts [95% CI] | 52.7%, +0.22 [+0.13, +0.32] | 52.8%, +0.23 [+0.12, +0.35] | 54.6%, +0.35 [+0.19, +0.51] |
| regime-flagged | 50.2%, +0.04 [−0.13, +0.21] | 49.1%, +0.01 [−0.18, +0.20] | 50.9%, +0.11 [−0.14, +0.38] |
| not flagged | 53.9%, +0.33 [+0.21, +0.45] | 55.1%, +0.37 [+0.23, +0.51] | 56.5%, +0.50 [+0.30, +0.72] |
| before 6 games played (either side) | 50.1%, +0.08 [−0.04, +0.20] | 48.4%, +0.04 [−0.11, +0.18] | 50.3%, +0.12 [−0.07, +0.30] |
| from 6 games | 55.1%, +0.35 [+0.22, +0.49] | 57.1%, +0.42 [+0.25, +0.59] | 59.4%, +0.61 [+0.35, +0.89] |

- **Reading.** The close follows EdgeDesk only on settled games. A regime-flagged gap, or one before either side has
  played six games, is followed at a coin flip at every size.
- 2021 (the engine's tune season, never pooled) shows the same direction: before 6 games 45.5%, from 6 57.0% at 2+.
- **NFL and CFB 2026:** 24 and 54 games at 2+, too small to read, with no flags on their rows. NFL history cannot be
  measured: no opener archive exists.
- **Leakage.** No readable cut is over 60% (the test holds it).
  - The replay projects each game before absorbing it, and no market field enters a projection.
  - Its state at kickoff also holds the week's earlier games, which the market also sees by the close.
  - N = 6 was fitted in the first pass on 2014-2025 by another criterion, so this split is not an independent test of it.
- **Proposed, not applied:** a WORTH RESEARCHING label at 5+ should require both sides to have played six games (the
  curve's own N, which today gates regime-flagged teams only). A regime-flagged gap should not be researched on its size
  alone. The 2-point threshold stays.

### #3 — Root causes: North Texas @ Tulsa and Syracuse @ UConn

The explainer's terms (#444) are exact additive pieces of the projection, so each term *is* the move a counterfactual
re-projection makes with that factor turned off. Below, each is credited undiscounted, and only toward closing the gap.
#444's explainer instead discounts each by how much the close has historically taken out. From the committed
`football/fbs/slate.json` (`disagreement_inputs.explainer_terms`).

**North Texas @ Tulsa.** EdgeDesk has North Texas by 9.24. The market has Tulsa −1.5 (one book, last capture). Gap:
10.74 toward North Texas, of which 10.00 (93%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| North Texas's long-run 2025 rating, still weighted 69% at four games (regime curve; 80% standard) | 7.56 | 70% |
| the matchup term: 2025 efficiency carried at half weight (`carry_eff` 0.5) | 2.44 | 23% |
| home field above the fitted 2.58 (4.08 applied) | favours Tulsa; widens the gap | 0 |
| conference | same conference | 0 |
| unexplained | 0.74 | 7% |

- **Root cause:** 2025 North Texas production is still counted as 2026, through the long-run prior and the matchup
  term's efficiency carry.
- On this season's centred track alone, North Texas is still 3.3 pts better than Tulsa.
- **Baylor Hayes** is Tulsa's quarterback (slot 1 on its depth chart; Dexter Williams II started the last game). His
  questionable status is **not read**: no availability record reached Tulsa's quarterbacks (UNKNOWN), and the college QB
  term prices 0 pts. His status could not have caused this gap.
- **North Texas's roster inputs are read correctly** after the coaching exodus. The regime record shows:
  - a new head coach;
  - returning roster share at the 8th percentile;
  - returning production at the 1st;
  - transfers out at the 87th.
- EdgeDesk's own V2 has North Texas by 5.9, between V1 and the market.

**Syracuse @ UConn.** EdgeDesk has UConn by 7.75. The market has Syracuse −6.5 (stale). Gap: 14.25 toward UConn, of which
4.10 (29%) is explained.

| factor | effect | share of the gap |
|---|---|---|
| UConn's long-run rating (new coach, 2nd-percentile returning production; weighted 69%) | 2.60 | 18% |
| home field above the fitted 2.58 (Rentschler gets the league constant 4.08) | 1.50 | 11% |
| conference (UConn is independent) | 0 | 0 |
| unexplained | 10.15 | 71% |

- Ruled out:
  - **Misjoined results:** all 328 FBS results were checked against ESPN box scores before the network closed, and none
    differ.
  - **Schedule strength:** consistent. UConn's this-season number rests on 48-20 at Southern Miss and 14-38 vs Maryland.
  - **Orientation:** the first pass's #5 holds it as DATA FAULT.
- **Root cause:** the model, not the data. V1's margins-only rating still has UConn 1.3 pts better on this season's track
  alone, and the market has Syracuse about 9 better on a neutral field. EdgeDesk's own V2, on efficiency, has Syracuse by
  3.2: it sides with the market. The game stays DATA FAULT.

**Not done in this pass: the "unexplained disagreement" DATA FAULT rule and the research page's "why EdgeDesk disagrees"
section.** #444 put its explainer in the terminal's artifacts (`games.json`, `board.json`); no page renders it yet. With
its discounted terms (holdout R² 0.03), the unexplained part averages 89% of a 7+ gap on its own holdout (8.74 of 9.85
pts), so the rule would flag most large gaps. With the undiscounted terms above, North Texas @ Tulsa is 7% unexplained and
Syracuse @ UConn 71%. Which explainer drives the rule is a decision, raised in the PR. Nothing is excluded from ranking
until it is made.

### #6 — Live re-run: still not possible

At 2026-09-30T20:54Z this environment's network policy refused the capture host (`iattxbkbufslbauoumga.supabase.co`), The
Odds API, ESPN and CollegeFootballData. nflverse (GitHub) was reachable, which is how the NFL slate was rebuilt. No
market number here is reported as current. The Colts props group was not re-run.

### Pre-existing failures on `main`, unchanged here

- `football/cfb_terminal/tests.js`: the terminal build throws at `lib/cfb_terminal.js:1322` (`K.sd.toFixed` on a null
  SD). Texas Southern @ Florida Atlantic has only one independent model number, so its agreement tier is null at an 18.8-pt
  gap. The line is from 0314762b. A fail-closed guard is proposed separately.
- `tools/bettor/decision_ui.e2e.js`: the NFL card reads "…ResearchLabPASS…", and the test's `\bPASS\b` finds no word
  boundary after "Lab".
- `football/cfb_validation/divergence_backtest.js` needs a local replay cache that is not in the repository.

### Tests

- `tools/football/nfl_regime.test.js` (60 checks, new):
  - the fit's provenance: holdout never fitted, walk-forward, significance from the interval, promotion rule, no market
    input, signals known before kickoff;
  - the engine: the neutral site removes exactly the intercept and nothing else; the regime never reaches a number; the
    notes are stated and never priced;
  - the board helpers;
  - the real slate builder on fixture feeds: OUT → PENDING replacement, DOUBTFUL → STARTER_UNKNOWN, QUESTIONABLE kept,
    every unplayed game reconciled, both sides' regime, the Home-marked international venue priced neutral, an unreadable
    injury report said;
  - the committed slate and the neutral-site report.
- `tools/football/clv_report.test.js` §4 (9 checks): the cuts are cumulative; the regime and games-played parts add up; the
  minimum is the curve's; the 2026 samples say "not available"; no readable cut over 60%.
- `tools/football/regime.test.js`: the curve's record states its significance from its interval, and says it is not
  significant.
- A 326-file sweep of every test the workflows and `package.json` run: 323 pass. The three above fail identically on
  `main`.

## 2026-09-30 — CFB board market integrity: Step 1, the read-only audit

Nothing on the board changed. The week-5 board said NO MARKET for games the providers were quoting. This adds
the tools that measure where the quotes go missing, and a report
(`docs/cfb-board-integrity/AUDIT.md`) with every root cause reproduced before any fix:

- `tools/football/cfb_board_audit.js`: provider events → matched → shown with a market, Market vs the latest
  consensus, false staleness, week scoping and duplicate teams, over the committed ledger and board.
- `supabase/audits/cfb_board_market_audit.sql`: the same questions against production (`signals`, `cfb.games`,
  `cfb.lines`, `cfb_lab_market_quotes`). It is one read-only `select`.
- `tools/football/cfb_board_repro_app.js`: the board's own functions, lifted from `app.html`, on the rows each bug
  needs.
- `docs/cfb-board-integrity/FINDING_cover_probability_sd.md`: the "SD near 8" rows, investigated. The model is not
  changed.

## 2026-09-30 — audit follow-up: verification of the first pass, and the second pass

The first pass (the section below) was re-verified from its code and data before anything here was changed. Its
regime backtest reproduces from a fresh download of the public data (held-out MAE 13.479 → 13.447 against its
reported 13.475 → 13.445; the same curve, the same N = 6, an engine self-check of 7e-15); its eleven test suites
pass. Nothing of the second pass had been started. Each item below says what the data supports, including where it
does not support what the audit expected.

### #1 — The regime prior as a continuous magnitude (a CANDIDATE: it did not beat v1, so it does not price)

**Root cause of "Iowa State still ≈ −9 against West Virginia".** There were no magnitude inputs to wire in. The v1
signal is a yes/no, so Iowa State (4th-percentile returning production), North Texas, UConn, Penn State and Virginia
Tech (36th percentile) all got the same 69% long-run weight at four games. West Virginia (3rd-percentile returning
roster, no coach change) got no adjustment at all. The v1 fit also started in 2007, and the curve it ships was fitted
on seasons through 2025. The QB change and portal inflow were not inputs anywhere.

**Change.**
- `football/cfb_p4/research/build_regime_history.py` now also measures:
  - portal inflow, production-weighted: last season's units produced at another programme by players on this roster
    (the rating-weighted alternative needs a keyed feed; this was agreed as the substitute);
  - last season's primary QB and whether he is on the roster;
  - every team-game's starter (`qb_starts.csv`).

  `--current 2026` writes the same fields into `returning_production_2026.json` (schema v2).
- `football/coaching/regime_signal.js` holds the one magnitude definition. It has four hinge features, each zero at or
  better than the season median: new coach, returning production, QB change (the starter of the team's last completed
  game vs last season's primary QB), and portal inflow. An unmeasured input is 0.
- `football/cfb_p4/research/regime_magnitude_backtest.js` replays the shipped engine cold and fits on 2021+ only:
  - **A. Selection.** Three pricing forms (a weight cut onto the raw this-season track, the same onto the centred track,
    a signed level shift on the long-run rating) are fitted on 2021-2022 and scored on 2023.
  - **B. Holdout.** Each form is refitted on 2021-2023 and scored once on 2024-2025, which no fit it is judged on ever
    saw.
  - **C. Ship.** The chosen form is refitted on 2021-2025 and promoted only if the holdout shows it no worse than the
    standard curve and than v1.
- Disclosure: two of the three forms were each scored on the holdout once while the list of forms was being built, so
  read the holdout intervals as optimistic.
- `football/cfb_p4/engine.js` supports both v2 forms (`magnitude`, `prior_shift`). `football/matchup/contract.js`
  forwards them only when `priced`. `football/coaching/build_regime.js` publishes every programme's v2 inputs,
  features and magnitude under `by_team.<key>.magnitude`, with `priced: false` while the artifact is a candidate.

**Result (2024-2025 holdout, never fitted).** Stage A chose `w_raw` (2023 MAE 13.108; standard 13.126).

| subset (games) | standard | v1 (ships) | v2 w_raw | v2 − standard | v2 − v1 |
|---|---|---|---|---|---|
| all FBS games (1,604) | 12.594 | 12.559 | 12.579 | −0.015 [−0.055, +0.023] | +0.020 [−0.013, +0.053] |
| v1 regime subset (537) | 13.027 | 12.921 | 12.946 | −0.080 [−0.181, +0.022] | +0.025 [−0.048, +0.099] |
| heavy turnover (284) | 12.719 | 12.662 | 12.619 | −0.101 [−0.256, +0.050] | −0.043 [−0.146, +0.061] |
| stable (80) | 13.536 | 13.536 | 13.542 | +0.006 | +0.006 |

- Bias on the regime subset (+ = the model overrates the flagged team): standard **+1.68**, v1 +0.94, v2 +0.79.
  The standard curve's figure is about 2.3 standard errors from zero.
- **v1 against the standard curve on the regime subset: −0.106, 95% CI [−0.226, +0.017]. Not significant.** *(Corrected in
  the second follow-up. This was first published as significant, CI [−0.229, −0.011], from a bootstrap whose generator
  cycled; see that section. The table's intervals above are the corrected ones.)* Its 2021-2023 refit gives the identical
  curve (w0 0.75, λ 0.02), so its sight of 2024-2025 did not change it.
- **No v2 form is significantly different from v1, and v2's point estimates are slightly worse.** It is not promoted.
  `football/cfb_p4/regime_magnitude.js` ships as `CANDIDATE`, fitted on 2021-2025 as coach 0.25, returning production
  0.05, QB 0, portal inflow 0. That would put Iowa State's long-run weight at about 60% at four games (×0.74), not under 50%:
  2021-2025 does not support the deep cut the audit expected.
- A fit-years-only diagnostic found the same thing. The best multiplier on the long-run weight is 0.8-0.85 for
  turnover profiles, and 1.0 for the most Iowa-State-like one (new coach, returning production at or under the 10th
  percentile, heavy inflow; 46 games).

**Found on the way: the this-season track is offset.** It starts every programme at `init_rating` (−12), and its FBS
mean stays about 8.6 pts under the long-run track's at every games-played count, 2021-2025 (sd 7.9-9.6 against
8.8-9.5, correlation 0.90+ from four games).
- The standard blend cancels this in the gap, because both teams share one weight. A per-team cut does not: moving
  weight onto the raw track also docks the team about Δw × 8.6 pts for no football reason.
- Iowa State's this-season −7.42 after four games is roughly where Iowa State 2025 (8-4) stood at the same point
  (−8.4). It is not by itself evidence that the team is bad.
- The v2 engine path moves the cut onto the centred track (`trackCentres`). v1 keeps the raw track, as it was fitted and
  validated, and its accidental level shift is part of why it works: regime teams really are overrated by their
  long-run rating.

**Unchanged by design.** All 109 games of a rebuilt `football/fbs/slate.json` have identical model margins and regime
weights (0 differences). Georgia and Ohio State have zero magnitude (the same coach and QB, continuity above the median).

**Tests.** `tools/football/regime.test.js` §9 (24 new checks) covers:
- the hinges and the unmeasured-input rule;
- both engine forms, exact to 1e-9, with the centring on and off;
- that magnitude 0 is the standard curve exactly;
- that a v1 record is byte-identical;
- the contract gating (an unpriced magnitude never reaches the engine);
- the artifact's provenance and verdict;
- the published 2026 record (Georgia and Ohio State at zero; Iowa State and North Texas new coach, new QB, bottom
  decile);
- `qbChangeOf`.

### #2 — A σ-scaled EV plausibility check replaces the flat 25% guard (VERIFIED MAJOR is reachable)

**Root cause.** The first fix bounded raw EV at a flat 25% on a main-line spread. EV is a price-dependent function of
the gap measured in the game's own distribution width, so "25%" meant a different gap in every game. At −110 a
college gap of about 6 points already prices past it.
- A synthetic game that passed every gate read INVESTIGATE ("implausible EV") at every gap of 7+ pts, for any σ from
  13 to 16.
- On the 2024-2025 holdout the flat bound flagged **19.7%** of real college games and **26.0%** of NFL games.
- It left VERIFIED MAJOR reachable on **2.6%** of real CFB 7+ gaps, and on **0%** of NFL ones.

**Change.**
- `lib/edgedesk_quote_ev.js` `implausibleEv(g, model)`: a main-line quote is implausible when
  `z = |fair home margin − the quote's home margin| / σ` exceeds `PLAUSIBLE_Z[sport]`.
  - σ is `distributionSpread(model.home_cover)`: half the central-68% width of the same distribution the EV is priced
    from.
  - Where no width can be read (no fitted sport), the flat 25% bound applies and says so.
- `tools/football/ev_plausibility.js` fits z* as the declared 99.5th percentile of z over correctly-joined games in
  2021-2023, from cold replays of both shipped engines. The market is never an input to a projection. It then scores
  2024-2025 once. The result is `football/validation/ev_plausibility.json`: CFB z* = **0.960** (≈15.7 pts at the
  typical σ 16.3), NFL z* = **0.997** (≈13.0 pts at σ 13.0).
- **The stake is not loosened.** The flat 25% line is kept as `large_ev`, read only by the decision layer's new
  `LARGE_EV` cap (WATCH, no stake). Every decision the old guard held at WATCH is still WATCH with 0 units. A plausible
  large gap now reads VERIFIED MAJOR as a research status, and still carries no stake.
- `lib/edgedesk_canon.js` prints the quote-EV layer's own reason. `lib/edgedesk_decision.js` words IMPLAUSIBLE_EV in σ
  terms.

**Holdout (2024-2025, never fitted).**

| | CFB σ-scaled | CFB flat 25% | NFL σ-scaled | NFL flat 25% |
|---|---|---|---|---|
| real games flagged | 0.69% | 19.7% | 0.18% | 26.0% |
| real 7+ gaps left reachable for VERIFIED MAJOR | 95.2% (of 229) | 2.6% | 98.4% (of 62) | 0% |
| synthetic flipped side caught, with the orientation invariant and the 21-pt guard | 74.6% | 92.5% | 39.8% | 77.0% |
| synthetic mis-joined market caught, same stack | 47.5% | 81.7% | 17.8% | 60.9% |
| synthetic line off by 7 pts caught, same stack | 13.2% | 98.6% | 19.3% | 99.8% |

**What this costs.** Most of the old guard's catch rate came from flagging one real game in five. A line that is wrong
by 7 points cannot be told apart from a real 7-point disagreement by its size alone. That job belongs to the checks
that look at the quote rather than the gap:
- the market-consensus MARKET FAULT (first pass #2/#3);
- the stale-capture rules;
- the integrity gate that VERIFIED requires.

This is stated, not tuned away.

**Tests.**
- `tools/football/quote_ev.test.js` §14 (rewritten for the new rule):
  - the σ reading;
  - a 1.04 σ gap is implausible;
  - a +30% EV at 0.61 σ is not implausible, but is LARGE;
  - an alternate is exempt;
  - the flat fallback;
  - the constants equal the fitted artifact, and the artifact's holdout numbers;
  - **verified 7, 7.5, 9 and 11-pt college gaps at −110 read VERIFIED MAJOR**;
  - a 16-pt gap is still "implausible EV, check data";
  - an NFL 7-pt gap reads VERIFIED MAJOR.
- `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`: six scenarios move from WATCH ·
  IMPLAUSIBLE EV to WATCH · LARGE EV, all still with no stake. The gaps past z* stay IMPLAUSIBLE EV.

### #3 — A disagreement explainer (North Texas @ Tulsa, Syracuse @ UConn)

**What was missing.** A research label says how large a disagreement is and whether it passed the integrity gate. It
never says why. The 2026-09-27 forensic report decomposes EdgeDesk's number, not the gap between it and the market.

**Change.**
- `lib/edgedesk_explainer.js` splits a gap into eight terms read off the engine's own projection:
  - the rating scale;
  - last season's share of the rating, `w·(long-run − this season − track offset)`, and that share on a turned-over
    roster;
  - the home-field constant;
  - QB change;
  - conference;
  - matchup;
  - the rest.

  None of the terms comes from the market.
- `tools/football/explainer_fit.js` fits how much of each term the closing market has historically taken out. It runs
  OLS of `fair − close` on the terms over 2021-2023 FBS games (cold replay, `replay_rows.js --explainer`), scores
  2024-2025 once, and ships a 2021-2025 refit (`football/validation/disagreement_explainer.json`).
- Explained is the intercept plus Σ β·term. Unexplained is the rest.
- `football/cfb_p4/engine.js` publishes the tracks' centres in `layers.strength.track_centres`, for display only; no
  number reads them back.
- `football/fbs/build_coverage.js` publishes the market-free terms in `disagreement_inputs.explainer_terms`.
- `football/cfb_terminal/build.js` explains each game against the consensus it already shows (`games.json`
  `disagreement_explainer`, and a compact form in `board.json`).

**The fit (2021-2023, every term |t| ≥ 1.96).**

| term | β | what it says |
|---|---|---|
| home field | +0.43 | the market gives about 1.8 pts less home edge than the engine's 4.08 constant |
| QB change | +0.50 pts | the market prices a new starter the engine's (usually unavailable) QB term does not |
| last season's share | −0.42 | the market leans on last season *more* than the engine's this-season track does |
| …on a turned-over roster | +0.50 | …except on a turned-over roster, where it takes that back (net ≈ +0.08) |
| conference | +0.19 | |
| rating scale | −0.03 | |

- Matchup and "other" are 0 in every replayed game, because the cold replay has no efficiency or injury feed. They
  ship unfitted: shown, never discounted.
- **Holdout 2024-2025: R² = 0.03.** Mean |gap| 3.92 against mean |unexplained| 3.67; for 7+ gaps, 9.85 against 8.74.
  The measured terms explain a sliver of model-market disagreement, and the explainer says so rather than overstating
  it.

**Applied (terminal build of the committed 2026-09-30 captures, SNAPSHOT).**

| North Texas @ Tulsa: gap 10.74 toward North Texas (market Tulsa −1.5, one book) | term | β | explains |
|---|---|---|---|
| last season's share | −7.56 | −0.36 | +2.74 (toward Tulsa) |
| …on a turned-over roster (North Texas, index 0.86) | −4.84 | +0.48 | −2.33 (toward North Texas) |
| home field | 4.08 | +0.39 | +1.60 |
| rating scale | −10.89 | −0.02 | +0.21 |
| matchup (unfitted) | −2.44 | — | 0 |
| **unexplained** | | | **12.87 toward North Texas** |

The measured terms, taken together, lean 2.1 pts toward Tulsa, so nothing measured explains this gap. Even on this
season's centred track alone, North Texas rates about 4 pts better than Tulsa, and the market disagrees with that as
well. What remains is the market's view of this season's North Texas.

| Syracuse @ UConn: gap 14.25 toward UConn (market Syracuse −6.5, stale) | term | β | explains |
|---|---|---|---|
| home field | 4.08 | +0.39 | +1.60 |
| last season's share | +2.60 | −0.36 | −0.94 |
| …on a turned-over roster (UConn, index 0.87) | +0.58 | +0.48 | +0.28 |
| **unexplained** | | | **13.47 toward UConn** |

It remains DATA FAULT ("possible orientation flip", first pass #5) at a stale capture.

**Tests.** `tools/football/explainer.test.js` (21 checks, added to `football:audit:test` and `cfb:test`):
- the terms are exact pieces of an engine projection (prior share with the published offset, turnover index,
  contributions, QB change), with no market argument;
- explained + unexplained = the gap;
- unfitted terms are shown, never discounted;
- the fit's windows, significance flags and unfitted list;
- the slate and terminal wiring.

### #5 — A closing-line-value validation report

**What was missing.** The existing movement validation (`football/validation/movement_cfb.json`) tests CFBD's pregame
Elo, not EdgeDesk's own number. The scorecard has 6 packets and no reading. Nothing answered whether the market moves
toward EdgeDesk between the opener and the close.

**Change.** `tools/football/clv_report.js` writes `football/validation/clv_report.json`. Nothing is fitted, and the
market is never an input. Per game, on home margins:
- side = sign(fair − open), with no side under 0.5 pt;
- CLV points = side × (close − open);
- CLV probability = the cover probability of that side at the opener, on a distribution centred at the close, minus
  the same at the close.

Each sample reports games, the rate at which moved lines moved toward EdgeDesk (two-sided binomial p), mean CLV with a
bootstrap 95% CI, per season and per gap bucket. Samples under 100 moved games read "too small to read".

**Result.**

| sample | games | moved toward EdgeDesk | p | mean CLV (pts) | CLV (prob) |
|---|---|---|---|---|---|
| **CFB replay 2022-2025**, the engine's held-out window (hyperparameters tuned 2018-2021) | 2,843 | **52.9%** of 2,492 | **0.005** | **+0.21** [+0.13, +0.29] | +0.53 pp |
| …gap 0.5-2 | 737 | 53.2% | 0.11 | +0.16 [+0.02, +0.30] | +0.41 pp |
| …gap 2-4 | 846 | 51.2% | 0.56 | +0.10 [−0.03, +0.23] | +0.28 pp |
| …gap 4-7 | 795 | 52.1% | 0.27 | +0.21 [+0.06, +0.36] | +0.54 pp |
| …gap 7+ | 465 | **56.6%** | **0.009** | **+0.47** [+0.23, +0.74] | +1.19 pp |
| CFB replay 2021 (in-sample for the engine's tune; never pooled) | 686 | 50.8% | 0.74 | +0.12 [−0.01, +0.26] | +0.25 pp |
| CFB 2026 live (frozen record numbers vs the Model Lab's earliest capture) | 68 | 45.1% of 51 | 0.58 | +0.04 [−0.24, +0.35] | too small to read |
| NFL 2026 live (EdgeDesk's own opener ledger; no historical NFL openers exist) | 29 | 71.4% of 21 | 0.08 | +0.45 [−0.28, +1.14] | too small to read |

- By season 2022-2025 the toward-rate is 50.3%, 54.0%, 52.6% and 54.2%.
- *(Intervals corrected in the second follow-up: the report's bootstrap generator cycled, so the first-published
  intervals were too narrow. The 2-4 bucket and the 2021 sample no longer exclude zero; the headline still does.)*
- The college engine's pregame number has shown small, positive, statistically significant CLV on its held-out window,
  concentrated in the 7+ gaps.
- **This is a replay, not a record.** The replay's state is the one at kickoff, which also holds other games played
  between the opener and kickoff.
- The two live 2026 samples are too small to say anything yet.

**Tests.** `tools/football/clv_report.test.js` (16 checks, in `football:audit:test`) covers:
- the sign conventions;
- no side under 0.5 pt;
- a missing line is no CLV;
- the NFL price value;
- the summary arithmetic and the floor;
- the artifact's windows (headline 2022-2025, 2021 apart);
- that the market is not an input and nothing is fitted;
- that each reading follows its own numbers.

### #6 — Re-run both boards live: not possible from this environment

The live capture host (`iattxbkbufslbauoumga.supabase.co`) is denied by this environment's network policy. So are The
Odds API, CollegeFootballData and the SBR odds archive. No board was re-run live. The before/after tables in the PR
use the latest bot-committed captures, and every row is labelled SNAPSHOT with its capture time.

## 2026-09-30 — audit fixes: Week 5 CFB / Week 4 NFL board

These fixes come from a manual audit of the Week 5 CFB / Week 4 NFL board. They are listed in the audit's priority order.
No research gate or label definition was loosened. Where two copies of a rule disagreed, the stricter one was kept.
The "research, not picks" framing is unchanged.

### #1 — Regime change (Iowa State, North Texas, Penn State)

**Root cause.** Every programme's pricing state used one learned prior curve (`football/cfb_p4/params.js`,
`blend.prior_weight_by_week`): 100% long-run rating through 3 games, 80% at 4–5, 60% from 6.

For a programme whose coach and roster left, most of the Week 5 number still described the team that left:
- Iowa State: Campbell to Penn State.
- North Texas: Morris and the roster to Oklahoma State.
- Penn State: Franklin out.

Nothing in the repository supplied a coaching-change or roster-turnover signal. The coach table also had no 2025 row for
Penn State or Virginia Tech, so their changes could not be dated.

**Change.**
- `football/coaching/regime_signal.js` (new) holds the one definition of the signal, used by the fit, the builder and the
  tests. The signal fires on a new head coach AND roster continuity at or below the season's FBS median, or transfers out
  at or above its 75th percentile.
- `football/coaching/build_regime.js` (new) writes `football/coaching/regime.json` from:
  - `continuity.json`
  - the ESPN rosters, diffed on athlete id
  - `returning_production_2026.json`
  - `regime_overrides.json`, a hand-maintained, dated and sourced table (`team, season, new_coach,
    returning_production_pct`), documented in `football/coaching/README.md`
- `football/coaching/build_coaching.js` now walks back past a missing season when dating a tenure.
- `football/cfb_p4/research/regime_backtest.js` fits a separate, steeper curve walk-forward, on seasons before each one
  it is scored on: `w = min(w_standard(g), w0·e^(−λg))`, with w0 = 0.75 and λ = 0.02.
  - The fitted curve is written to `football/cfb_p4/regime_curve.js`.
  - The engine (`blendedRating`) applies it to a regime programme's long-run state.
  - The flag is also carried on a promoted canonical rating.
- **REGIME CHANGE flag.** `lib/edgedesk_canon.js` blocks WORTH RESEARCHING and VERIFIED MAJOR until the team has played
  N = 6 games. The status reads INVESTIGATE, with the flag and the team named.
  - N comes from the held-out cover-rate table: the first 2-game bucket from which regime games cover within 2.5 pp of
    every other game.
- The board, the published build (`football/fbs/build_coverage.js` via `football/matchup/contract.js`), the research
  terminal and the props model all read the same record.

**Backtest.** Held-out 2014–2025, 2,203 games involving a regime team (`report/regime_backtest.json`):

| metric | standard curve | regime curve |
|---|---|---|
| MAE vs the final margin | 13.475 | 13.445 |
| mean \|fair − close\| | 4.249 | 4.206 |

- The MAE change is −0.030, 95% CI [−0.063, −0.006], and 7 of 12 seasons improved.
- **Corrected (second follow-up):** that interval came from a bootstrap whose generator cycled after ~10,466 draws.
  Re-run with an exact generator it is −0.032, CI [−0.095, +0.033]: **not significant**. The artifact now records
  `significant: false`.
- The engine self-check re-projects 128 games; they match the counterfactual to 7e-15.

**Tests.**
- `tools/football/regime.test.js` covers the signal, the walk-back, the fitted curve, the engine shift (exactly
  (w_regime − w_standard)·(long-run − this season)), the contract, the research gate, the season record, the overrides and
  the published slate.
- `tools/football/label_parity.test.js` checks Pitt @ Virginia Tech in every view.

### #2 — Stale CFB market capture

**Root cause.** `fbP4Market` (app.html) used cfb.lines whenever the captured quote was older than its freshness window.
cfb.lines carries no book and no timestamp, and the board treated it as a current market (`stale: false`).

The gap, the label and the research priority were therefore measured against a different snapshot from the one the price
line prices, which reads captured quotes. The captured number itself was the first home `spreads` row returned (see #3).

**Change.**
- The market is the consensus of the CURRENT captured quotes (`fbMarketFromEvent`), which is the snapshot the price line
  prices.
- With no current quote, the consensus of every row is marked stale.
- cfb.lines is kept only as a labelled reference. Used alone it is STALE and reads STALE MARKET, and it is excluded from
  ranking (`rankable: false`).
- **Invariant.** |market spread − consensus of its own quotes| ≤ 1.5, else MARKET FAULT with the reason
  (`EDCanon.marketConsensusFault`). A MARKET FAULT is excluded from ranking.

**Tests.** `tools/football/market_join.test.js` (new), `tools/football/fbs_board_ui.test.js`,
`tools/app/worth_researching_ui.test.js` (reference-only fixtures read stale) and `tools/validation/canon.test.js`.

### #3 — NFL market mapping (SEA −3.0, BUF −3.0)

**Root cause.** `fbMarketFromEvent` took whichever home `spreads` row PostgREST returned first. It set the market's time
to the newest capture of any row.

`signals` keeps a row per point for good, and the capture files alternates under `market='spreads'`. So an August
look-ahead or an alternate at −3 stood as "the market" and looked minutes old, while every book dealt −6.5/−7.

**Change.**
- The main line is the books-weighted mode among the capture's modal rows, falling back to all current rows. It is
  timestamped by its own capture.
- **Self-check.** `fbNflMarketSelfCheck` fails the board (a banner above the rows) if any game's main line sits more than
  1.5 pts from the books-weighted median of its own captured books. That game reads MARKET FAULT.

**Tests.** `tools/football/market_join.test.js` (new) replays the audit's row order and covers:
- the self-check failing the board
- stale-only and reference-only markets
- the college path

`tools/articles/pipeline.test.js` also pins the sign convention of a replayed quote.

### #4 — NFL EV on the opposite side from the displayed model

**Root cause.**
- The NFL cover probabilities came from the margin tables centred on their mean, not their median. A table's median sits
  1–2.5 pts inside its mean, so at the market line the distribution could favour the side the displayed fair margin was
  against.
  - LAC @ SEA, model SEA −9.24, line −7: SEA −7 priced 49.6% and LAC +7 50.4%.
  - NE @ BUF, model BUF −7.18, line −7: NE +7 priced 56.2%, +6.9% EV.
- Separately, the NFL pricing blend could cross the market to the other side. CIN @ MIA: the model has CIN by 1.8, the
  market CIN −8.5, and the blended fair line was CIN −8.66, so the priced side was CIN.

**Change.**
- `football/engine.js` `centredOn` mixes adjacent tables so the distribution's continuous median is the fair margin
  exactly. Past one side's range it mirrors the other side's table; past both, it shifts the nearest extreme table.
- The kernel (`_pricing.js`) and the board hold the blend at the model side's 50% cover point when it would cross the line
  (BLENDED_HELD).
- **Invariant** (`lib/edgedesk_quote_ev.js` `sideInvariant`), checked on the one projection object that feeds both the
  display and EV:
  - If the model is past the line on side X, no side-Y quote at the same or a worse number may carry positive EV.
  - A violation is EV_SIDE_CONTRADICTION: NO DECISION, logged to `console.error`.
  - A display/EV centre mismatch of more than 0.5 pts is PROJECTION_MISMATCH.
- `tools/football/build_nfl_slate.js --reprice` recomputes the slate's pricing block.

**Tests.**
- `tools/football/quote_ev.test.js` §14: medians, sides, spikes, LAC @ SEA, PROJECTION_MISMATCH, and a reproduction of
  the old table off-centre.
- `tools/bettor/football_decision.test.js`, `decision.test.js`, `consistency.test.js`
- `tools/intelligence/pricing.test.js` (the kernel hold)

### #5 — Orientation flip (Syracuse @ UConn)

**Root cause.** The join was oriented correctly: UConn hosts, and the captured event resolves home and away strictly. The
number was not.

`situation.conference` in `football/cfb_p4/engine.js` treated "FBS Independents" as a conference. The group's 2025
cross-conference strength (+15.21, the highest of any group) is an average over unrelated programmes. It handed UConn
+3.8 pts over every ACC team early in the season. On top of that, UConn is in a regime change (#1).

**Change.**
- An independent carries no conference strength. The term is unavailable and says why. Two conferences still get the term.
- **Invariant** (`EDCanon.orientationSuspect`): a gap over 10 pts that flipping the model's sign would bring under 5 is
  DATA FAULT "possible orientation flip".
  - The game is excluded from ranking until resolved. Only a VERIFIED gap is exempt.
  - The check applies to both the CFB and NFL boards and the terminal.

**Backtest.** Held-out 2014–2025, the 522 games of an independent against a conference team
(`football/cfb_p4/research/independents_backtest.js`, `report/independents_backtest.json`):

| metric | before | after |
|---|---|---|
| MAE vs the final margin | 13.376 | 13.185 |
| mean \|fair − close\| | 4.914 | 4.800 |

- The MAE change is −0.192, 95% CI [−0.409, +0.033], so it is **not significant**. 8 of 12 seasons improved.
- The fix ships as a correction of what the term measures, not as a fitted gain.

**Tests.** `tools/football/orientation.test.js` covers the term, the invariant, the NFL board and the published slate.
`tools/bettor/football_decision.test.js` checks that Syracuse @ UConn gets no decision.

### #6 — Pitt @ Virginia Tech: conflicting labels

**Root cause.** Each view carried its own copy of the research rule:
- the board word
- the research view
- the Research Desk's row flags (`thin` from the engine's PASS_LOW_CONFIDENCE, `fault` from the guard gap alone)
- the offline exporter (`football/cfb_p4/export_csv.js`, "RESEARCH" for every gap under 7)
- the press brief (`tools/football/press_brief.js`, a copy of the page's old rule)
- the research terminal's seven-word status, which its brief prints

None of the copies had the stale-market, orientation, regime or implausible-EV rules. They could also disagree with each
other on the confidence and reliability floors.

**Change.**
- `lib/edgedesk_canon.js` `researchStatus` is the one classifier. Where two copies disagreed, the stricter rule was kept:
  unmeasured reliability is not a pass.
- `EDCanon.boardWord` names its result on the board. All of these now read it:
  - `fbP4StatusFor`
  - the research view
  - `fbGameRows` (the Desk and Top Research Priorities: thin, fault and stale are read off the canonical status)
  - the RESEARCH FLAGS queue (shows the word and excludes non-rankable statuses)
  - the CSV export
  - the counters
  - the offline exporter
  - the Read (`lib/edgedesk_read.js`)
  - the press brief, which reads the CSV's `board_status` and classifies nothing
- The terminal's seven-word status is reconciled to the canonical status. It can only be made stricter.

**Tests.** `tools/football/label_parity.test.js` (new) stages Pitt @ Virginia Tech with Virginia Tech in a regime change,
alongside aligned, research, orientation-flip and thin-data games. It checks that the label is identical across:
- the board, the card and the CFB desk
- the Desk rows and picks
- Top Research Priorities
- RESEARCH FLAGS
- the CSV export and the counters
- the offline exporter
- the press brief
- the research terminal

`tools/football/press_brief.test.js` pins the brief to the canon.

### #7 — Player props

**(a) Edge and EV at one quote.**
- Root cause: the table's Edge column showed the model at the consensus line minus the consensus no-vig (`edgeNv`), which
  is a different line and a different price from the EV beside it. A LEAN could show a negative edge.
- Change: the column shows the candidate's own edge (probability minus the break-even of the same book, line and price as
  the EV). The consensus comparison is labelled "nv".
- Self-check: `EDProps.edgeEvAgree` means a BET or LEAN without a positive edge AND EV at its quote is demoted to WATCH
  (EDGE_EV_MISMATCH, logged).

**(b) Correlated props.**
- Root cause: the correlation model lists no pair for most cross-player props, so √(uᵀRu) summed eight 0.25U Colts props
  as independent and the 2U game cap never bound. All 8 NFL BETs were IND @ WAS, 7 of them on the Colts' offence having a
  quiet day.
- Change: every selection that wins when one offence in one game has a big (or a quiet) day is one exposure group. The
  group carries at most the stake of its largest member (GROUP_EXPOSURE), and a defender's prop is grouped on the offence
  it plays against.

**(c) Opponent defensive availability.** It is not a model input: the defensive factors are season-to-date rates. It is
now a warning flag, OPP_DEFENSE_UNMODELED, which names the defenders the opponent's latest report lists OUT or DOUBTFUL
and which week's report that is.

**(d) Regime and usage/volume priors.** On a regime-change programme, last season's share prior and team volume are scaled
by the fitted regime curve relative to the standard curve. REGIME_CHANGE caps the prop below BET until N games.

**Week bug.** "Injury report on file" meant *any* team's report for this week, so a teammate the week-3 report listed OUT
read as back. IND's Alec Pierce did, and every Colts WR share was cut ×0.85. Now:
- the on-file flag is team-specific
- a teammate listed OUT on an earlier report, with his team's current report not on file, is PENDING: no dilution and no
  redistribution
- the prop carries a teammate-uncertain flag
- the player's own earlier listing caps at WATCH (AVAILABILITY_PENDING)

**(e) Tail pricing.** Every alternate line is flagged "tail pricing, uncalibrated" (TAIL_PRICING_UNCALIBRATED) and never
reaches BET.

**Tests.**
- `tools/props/props_core.test.js`:
  - the tail A/B: the same quote is a BET as a main line and a LEAN as an alternate
  - the regime cap, `edgeEvAgree` and the opponent warning
  - exposure groups, including the audit's Colts group on the real correlation model
- `football/props/pipeline.test.js`: the week bug on the fixture (Jayden Reed), the Edge column, and the opponent's
  availability.

### #8 — EV sanity guard (all sports)

**Root cause.** Nothing bounded a spread EV. A main-line spread at +30–45% raw EV, which is almost always a data error
(a stale or mis-joined line, a flipped side), could drive a BET. Player props already had their own bound: PRICE_ANOMALY
caps an uncorroborated EV above 15% at WATCH.

**Change.** Raw EV above 25% on a main-line spread sets the research status to INVESTIGATE, "implausible EV, check data"
(`EDCanon`, rule `implausible_ev`, still rankable but penalised). It also caps the decision at WATCH
(`lib/edgedesk_decision.js`) on the CFB board, the terminal and the NFL board.

**Scope.** The guard applies wherever `lib/edgedesk_quote_ev.js` evaluates a main-line spread. That is every sport this
board prices spreads for (CFB, NFL). The other sports' pipelines price no main-line spread through this path.

**Consequence.** Against live quotes a CFB main-line gap of roughly 5.5–6 pts or more already prices above 25% raw EV, so
a verified 7+ gap reads INVESTIGATE (implausible EV) and VERIFIED MAJOR is effectively unreachable at a live price. That
is a consequence of the bound the audit set, stated here rather than tuned away.

**Tests.** `tools/football/quote_ev.test.js`, `tools/bettor/football_decision.test.js` and `tools/bettor/decision.test.js`.

### Artifacts rebuilt

Everything below was rebuilt with the fixed code on top of the current `main` data. The build times match the base's
latest (2026-09-30 16:00–16:07Z), so the data is the same and only the code differs.

- `football/coaching/regime.json`, `continuity.json` and `returning_production_2026.json`
- `football/fbs/slate.json`, `coverage.json`, `reliability.json` and `football/enrichment/audit.json`
- the research terminal's published files (`football/cfb_terminal/*.json|csv`, `--now` the base's build time); the
  append-only history was not written
- `football/nfl/slate.json` (repriced)
- the NFL and college props boards (at the base's board times); the decision ledgers were not appended
- `football/matchup/metrics.json` and `football/validation/model_health.json`
- `football/cfb_validation/*`, with PATCH rows for the pricing and research code changes

New scripts: `npm run football:audit:test` (regime, orientation, label parity, market join). The same tests were added to
`cfb:test`.
