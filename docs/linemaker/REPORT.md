# Linemaker build — final report (2026-10-11)

Branch `claude/linemaker-research-terminal`, base `0a93d07`, draft PR #547.
Nothing in this build has been applied to production, deployed or merged.

**Status: PARTIALLY VERIFIED.** Everything that can be run without
production credentials was run and passes, and every failure found
reproduces on the unmodified base or on `main`. Production (the live
Supabase project, the deployed function, the real model) is UNVERIFIED.
The published sheets have no graded games yet.

## 1. Phase by phase

| phase | what was done | state |
|---|---|---|
| 1 Audit | `AUDIT.md`: phase map, baseline, gaps G1–G9, view sweep, risks left as they are | DONE |
| 2 AI research engine | The existing desk (citations, fact vs estimate, deterministic paths) is reused. New: it receives the on-screen panel, game and market as allow-listed identifiers (G4), and answers team totals and alternate lines from the published sheet with no model call | PASSED locally; UNVERIFIED in production |
| 3 Linemaker | Spread, moneyline, total, both team totals and alternate ladders with push probabilities, from the existing NFL and CFB engines (never from a book). Each market's method is chosen on one window of seasons and confirmed on a later one, then labelled CALIBRATED or PROVISIONAL with reasons. **Player props are not re-priced by the linemaker**; the existing prop terminal prices them | DONE for game markets; props: reused, not extended |
| 4 Matchup analysis | Existing matchup explorer, unchanged | Regression green (`matchup.test.js` 201) |
| 5 Edge finder | `priceCheck` / `rankQuotes`: break-even, no-vig, EV, ROI, the at-market band and a conservative edge. It may return no qualifying price. It ranks **quotes the reader enters**. The linemaker fetches no live book price, by design (no Odds API spend). The existing edges board is unchanged | PARTIAL: the maths is tested; there is no new live feed |
| 6 Prop lab | Existing Player Props terminal, unchanged | Regression green (`props:test`, `props:sql`) |
| 7 Pro/Lite routing | Shared daily allowance on PostgreSQL. QUICK routes LITE; deeper questions route PRO. Over the PRO limit a question is answered the LITE way; over the LITE limit it is refused with the reset time. LITE sends no tools and never refreshes odds | PASSED locally; the real LITE model is UNVERIFIED |
| 8 Odds API cost | The linemaker reads committed artifacts only. `no_bypass.test.js` §8–9 proves `oddsFetch` has no caller and no linemaker file reaches the gateway, capture or a provider | PASSED |
| 9 UI | Research → Other → **Lines**: slate, the full sheet, ladders, reference line, Check a price, comparison, record, grades, Ask, Save. Loading, empty, error and stale states; desktop and a 390 px phone. Matchup explorer, props lab and saved research reuse existing surfaces. There is no new market-movement chart; movement toward the fair number is graded | PASSED (84 e2e checks); market movement PARTIAL |
| 10 Accountability | Append-only pregame ledger keyed by a content hash. Walk-forward calibration, log loss, Brier, calibration slope, CITL, skill, at-market bands. Grading at the close: moneyline Brier and log loss, spread and total at the closing number, error, movement toward fair | DONE; **0 games graded yet** (live performance UNVERIFIED) |
| 11 Security | G1 cross-user view read fixed. Saved research: own rows only. The allowance runs as security definer on `auth.uid()`, never a client id. Model clock. Screen input is allow-listed identifiers only, never free text | PASSED on PostgreSQL; UNVERIFIED in production |
| 12 Tests | §3 | see §3 |
| 13 Safe release | Feature branch, 7 reviewable commits, additive SQL with a `_rollback.sql` each, a draft PR, no deploy | DONE |
| 14 Acceptance gate | This report | — |

## 2. Files and database objects

**New:**
- `lib/edgedesk_fairline.js`, `lib/edgedesk_linemaker_ui.js`, `lib/edgedesk_linemaker.css`, `lib/edgedesk_saved_research.js`;
- `football/linemaker/desk.js`, `fair_lines.json`, `grades.json`, `ledger/2026/sheets.jsonl`;
- `football/validation/linemaker_nfl.json`, `linemaker_cfb.json`;
- `tools/football/linemaker_calibrate.js`, `build_fair_lines.js`, `linemaker_grade.js`, and their tests;
- `tools/intelligence/{research_packets_rls_sql,ai_usage_sql,saved_research_sql,saved_research_client,ai_route,model_timeout}.test.js`;
- `.github/workflows/linemaker.yml`;
- `docs/linemaker/{AUDIT,DESIGN,PROGRESS,REPORT}.md`.

**Changed:**
- `app.html`: the Lines tab and panel, screen context, saves to the account;
- `supabase/functions/edgedesk_ai/index.ts`: the model clock, the allowance, routing, screen, the lines turn, and two inlined kernels;
- `supabase/research_packets.sql`: security_invoker views;
- `tools/presentation/inline.js`, `tools/odds/no_bypass.test.js`, `tools/app/navigation.test.js`, `tools/app/sports_config.test.js`;
- `.github/workflows/intelligence-ci.yml`, `package.json`, `CHANGELOG.md`, `README.md`.

**Database (scripts only, none applied):**

| script | objects |
|---|---|
| `research_packets_views_rls.sql` | `alter view research_packet_grades / research_packet_pricing set (security_invoker = true)`, anon revoked |
| `ai_usage.sql` | tables `ai_usage_policy`, `ai_usage_events` (append-only trigger, RLS select-own); functions `ai_usage_claim`, `ai_usage_settle`, `my_ai_usage`; view `ai_usage_daily` (service only) |
| `saved_research.sql` | table `saved_research` (four own-row policies, freeze trigger, 500-item cap, column-level update grant) |

No existing table, column, price, entitlement, trial, Stripe object or auth setting is changed. No row is deleted by any script or rollback.

## 3. Tests run, with results

Run on the branch head in this container (Node 22, PostgreSQL 16 throwaway
clusters, Chromium 1194). The full log is reproducible with the commands
named.

| suite (npm script or files) | files run | files green | failing files |
|---|---|---|---|
| `ai:test` | 38 | 37 | intelligence.test.js |
| `intel:lint` | 1 | 1 | none |
| `intel:sql` | 7 | 7 | none |
| `intel:route` | 3 | 3 | none |
| `linemaker:test` | 2 | 2 | none |
| `linemaker:check` | 2 | 2 | none |
| `odds:test` | 4 | 4 | none |
| `resilience:test` | 4 | 2 | resilience.test.js, research_snapshots_sql.test.js |
| `props:test` | 6 | 6 | none |
| `validation:test` | 5 | 5 | none |
| `bettor:test` | 2 | 2 | none |
| `site:test` | 2 | 2 | none |
| `integrity:test` | 1 | 1 | none |
| `research:test` | 6 | 6 | none |
| `validation:sql` | 1 | 1 | none |
| `bettor:sql` | 1 | 1 | none |
| `props:sql` | 1 | 1 | none |
| `personal:sql` | 3 | 3 | none |
| `tools/app/*` | 11 | 10 | first_run.test.js |
| `browser e2e` | 5 | 5 | none |
| `tools/app/billing_sql.test.js`, `issue_reports_sql.test.js` (they skip in the chain; run separately against a throwaway PostgreSQL 16 server on the socket they expect) | 2 | 2 | none (72 and 21 assertions) |

The browser e2e row covers `linemaker_ui` (84), `desk_ui` (71), `chat` (50), `props_ui` (138) and `navigation` (172).

New suites, assertions passed:

| suite | passed |
|---|---|
| `tools/football/linemaker.test.js` | 119 |
| `tools/football/linemaker_desk.test.js` | 28 |
| `tools/football/linemaker_ui.e2e.js` (desktop and 390 px phone) | 84 |
| `tools/intelligence/research_packets_rls_sql.test.js` | 28 |
| `tools/intelligence/ai_usage_sql.test.js` (12 concurrent claims at a limit of 5 → exactly 5) | 35 |
| `tools/intelligence/saved_research_sql.test.js` | 25 |
| `tools/intelligence/saved_research_client.test.js` | 16 |
| `tools/intelligence/ai_route.test.js` | 22 |
| `tools/intelligence/model_timeout.test.js` | 9 |
| `tools/odds/no_bypass.test.js` (extended) | 37 |
| `linemaker_calibrate.js --check`, `build_fair_lines.js --check` | ok |

**Failures, all pre-existing:**

| suite | result here | on the base `0a93d07` |
|---|---|---|
| `tools/intelligence/intelligence.test.js` | 572 pass, 2 fail (the "North Texas / Texas State" name fixture) | the same 2 fail |
| `tools/resilience/resilience.test.js` | crashes: the UCF @ Oklahoma State fixture is gone from the regenerated slate | the same crash |
| `tools/resilience/research_snapshots_sql.test.js` | 21 pass, 1 fail (the same game) | the same failure |
| `tools/app/first_run.test.js` | 128 pass, 1 fail ("the landing nav no longer hides the free half of the product on a phone") | the same failure (checked on a clean worktree at `0a93d07`) |

The first three depend on artifacts that the hourly bot commits regenerate.
`first_run` looks for a Games link in the landing page's nav, and this build
does not touch the landing page (`index.html`). On PR #547,
CI also shows `quote_ledger.test.js`, `matchup_props.e2e.js` and the
integrity regression red; all of them are red on `main` itself (`0663fa38`).
The explanation is on the PR. None of these suites was suppressed, skipped or
edited.

**Environment note:** the nflverse download cache at `football/nfl/.cache`
(created by the calibration replay) makes `team_identity` and
`staking_validation` read a fuller history than CI has. It was moved aside
for the run and restored. It is not committed.

## 4. Existing functionality preserved

- Every existing suite named in §3 passes, apart from the three pre-existing failures.
- The research shell, the navigation (one new Other tab), and the desk's existing intents run unchanged; the lines turn runs only on a team-total or alternate-line question.
- `subscriptionGate`, Stripe, trials and auth are untouched.
- The device copy of saved research is kept, and is still the fallback.
- Public API: the `edgedesk_ai` request and response contract only gains fields (`route`, `screen`, `lines`).
- A LITE refusal is a 429 with a reason. Before, an over-limit reader got the per-isolate limiter's 429, which still applies.
- The existing engines are not refitted. The linemaker reads their output and never blends in a sportsbook number.

## 5. Odds API cost protection

- The linemaker, its panel, its desk turn and its CI jobs make **zero** Odds API calls; they read committed files. `no_bypass.test.js` §9 enforces this.
- A LITE turn never refreshes odds and sends no tool definitions, so the model cannot ask for one.
- `oddsFetch` in `app.html` has no caller (§8). The only `callFnGet('odds')` is inside it.
- Everything else goes through the existing gateway and quota ledger, unchanged.

## 6. Risks and blockers

1. **G1 is live until the script is applied.** On Supabase's default grants, any signed-in reader (and possibly the anon key) can read every reader's research packets through the two views. Apply `research_packets_views_rls.sql` first.
2. **The engines barely separate outcomes at market numbers.** Held-out at-market slopes: 0.17 (NFL spread), 0.30 (NFL total), −0.08 (CFB spread), 0.21 (CFB total). The price check therefore rarely says VALUE. This is the honest result, not a defect to tune away.
3. The engines' weights were fitted through 2025, so 2016–2025 is partly in-sample for them (stated in each record). 2026 is the clean season.
4. No grades yet: the first sheets were published on 2026-10-11.
5. Left as they are (AUDIT.md §4):
   - deployed-only functions holding `ODDS_API_KEY`;
   - OddsBlaze has no shared budget;
   - `subscriptionGate` fails open;
   - `recommendation_ledger` grading columns are writable by their owner.
6. Pre-existing data-drift CI failures on `main` (§3) will keep this PR's suites job red until the fixtures are pinned (proposed on the PR as a separate change).

## 7. Deploy, then roll back if needed

Deploy (with approval, in this order):
1. Apply `supabase/research_packets_views_rls.sql`. Then check `select relname, reloptions from pg_class where relname in ('research_packet_grades','research_packet_pricing');` and confirm both show `security_invoker=true`.
2. Apply `supabase/ai_usage.sql`, then `supabase/saved_research.sql`. Each ends in an ok / CHECK THIS report.
3. Redeploy `edgedesk_ai` (Deploy intelligence workflow). Check `?probe=1` shows `model_clock` and `ai_usage`.
4. Merge PR #547. The Linemaker workflow then rebuilds sheets every three hours and recalibrates weekly; neither needs a secret.

Rollback (each step is independent and keeps data):

| piece | how |
|---|---|
| Lines desk turn | `EDGEDESK_LINES=0` |
| Allowance | `EDGEDESK_AI_USAGE=0`, or `ai_usage_rollback.sql` (keeps the ledger) |
| Model clock | raise `EDGEDESK_AI_TIMEOUT_MS` (up to 120000) |
| Saved research | `saved_research_rollback.sql` (revokes reader access, keeps rows) |
| Panel | revert the `app.html` commit `a3ed0c5b` |
| Sheets and ledger | disable the workflow. The ledger is never rewritten |
| View RLS | `research_packets_views_rls_rollback.sql`. This reopens the cross-user read; use it only as a last resort |

## 8. Not verified, and why

- The live Supabase project, the deployed function and the production page: there are no credentials in this environment.
- The real LITE model and the timeout against the real API: both were tested against a stubbed endpoint.
- NFL questions through the in-app desk in the browser e2e: the harness does not serve the nflverse CSVs the page uses for its NFL card. CFB is proven end to end, and the server path is proven for both leagues.
- Live performance of the sheets: 0 graded games.
