# System-wide data integrity, model reliability and content engine hardening: final report

Branch `claude/serene-fermat-qibuu8`, base `8c46beaf`. Phases 1–6 were carried
out in order. The audit that started it is `AUDIT.md`. **Nothing was deployed
and no production data was touched.** Production Supabase is unreachable from
the build environment.

## 1. Executive summary

The October 8 board's contradictions had five root causes. All five are now
fixed at the source, not in prompts:

| Problem | Root cause | Fix |
|---|---|---|
| A — gaps | a display floor, plus independent rounding | one calculation layer |
| B — time windows | a dropped TBD flag, plus no week scope | schedule truth |
| C — research vs decision | labels that merged two questions | two explained classifications |
| D — EV | two EV layers on different bets, plus a coin-flip calibrator presented as promoted | evPair, plus the calibration quality stated |
| E — markets | missing quote screens | quarantine screens |

**What changed:**

- **One integrity engine** (30 deterministic rules, PASS / WARNING / BLOCKED,
  each with evidence and remediation) runs at seven boundaries, from the
  research dashboard to the publisher export. BLOCKED content cannot reach
  Ready to Send: the database enforces it.
- **The content engine** writes only from verified, current-week, publishable
  games, chooses one central storyline, and never turns a missing quarterback
  announcement into uncertainty.
- **Exports are read back** and must carry the approved numbers. Changed
  research revokes an approval.
- **Every Claude call is reserved** against a **$10 monthly cap** before it is
  made, and settled at its measured token cost.
- **An acquisition dashboard** tracks article → paid subscriber against the
  90-day targets.

**Tests.** 117 regression checks cover the 17 named cases plus an integration
test, all passing. Every affected existing suite passes. One unrelated test
fails on the base commit too (§6).

**No model projection, threshold, calibrator or decision rule was tuned.** The
corrected counts are smaller and more honest:

- 20 research-grade, not 49;
- 72 usable markets, not 73.

The live record shows the large discrepancies are the model's worst cases
(42.7% ATS at 7+ points), so they are routed to investigation, not promotion.

## 2. Root causes discovered

Full evidence, with file and line, is in `AUDIT.md`. Every figure reproduces
with `npm run integrity:audit`.

1. **Gaps that do not reconcile.**
   - The engine's near-pick'em display floor (±1) was printed beside a gap
     measured from the raw margin:
     - Ole Miss −0.2 shown as −1.0, so a 9.3 gap read as 8.5;
     - Boise State @ Fresno State: the 6.6 shown hid a 7.5 that would have
       crossed the 7-point threshold.
   - Separately, the terminal rounded the fair line, the market and the gap
     each alone: **11 of 69** printed gaps differ from the two lines beside
     them.
   - Score lines were rounded apart from the margin: **65 of 114** do not
     reconcile.
2. **Wrong time windows.**
   - The schedule's `start_time_tbd` was dropped on every path, so **43** week-7
     placeholder midnight-Eastern times became "confirmed" kickoffs ("FRI
     11:00p").
   - The board used a rolling 10-day window, not a week: **62 of 117** rows
     were week 7.
   - Week pickers disagreed, and one sorted week numbers as strings.
3. **Research vs decision.** The counts mislabelled INVESTIGATE as
   research-grade, and "with a quote" included stale and faulted quotes. The
   two classifications were already separate in code, but nothing explained
   why they differ.
4. **Raw vs calibrated EV.**
   - The `ev` layer (best calibrated selection) and `quote_ev` (best raw quote)
     sit on **opposite sides in 4 of 7** priced games. Printed together, they
     pair two different bets.
   - The calibrator is **degenerate**: it maps every cover probability to
     about 50% (log loss 0.693, Brier 0.250) while labelled PROMOTED.
5. **Market anomalies.** Four screens were missing: duplicates, alternates
   misfiled as main, suspended markets, non-equivalent markets.
6. **Quarterbacks.** All 234 QB rows are inferred from play-by-play (215
   PREVIOUS_GAME, 19 COMPETITION); none is a sourced report. The content
   engine printed "no starter has been announced" for every game, and the
   terminal listed "quarterback not confirmed" as a reason not to bet on every
   game.
7. **The content engine.**
   - A number passed its check if it appeared anywhere in the evidence.
   - The database trusted the client's `checks_ok`.
   - Approval was not bound to the research.
   - The budget was calls per day, with no dollars, tokens or month.
   - Two concurrent drafts could both spend.

## 3. All files changed

**New**

| File | Purpose |
|---|---|
| `lib/edgedesk_calc.js` | the canonical calculation layer (rounding policy, spreads, gaps, totals, scores, probabilities, EV pairing, formatters, fingerprints) |
| `lib/edgedesk_schedule.js` | kickoff truth, game status, zone-aware display, current week and week scope, odds-event matching |
| `lib/edgedesk_availability.js` | the seven availability classes, sourcing, revalidation, the prose guard |
| `lib/edgedesk_integrity.js` | the research record (data contract), 30 rules, 7 boundaries, the two classifications explained, EV explanation, board counts |
| `tools/integrity/regression.test.js` | the 17 required cases plus the integration test (117 checks) |
| `tools/integrity/audit.js` | reproduces every audit figure from committed data (read-only) |
| `tools/integrity/performance.js` | live-forward vs backtest monitoring, with a look-ahead guard |
| `tools/integrity/rules_doc.js` | generates `RULES.md` from the engine, with `--check` |
| `docs/system-integrity/` | `AUDIT.md`, `DATA_CONTRACT.md`, `RULES.md` (generated), `RELIABILITY.md`, `TEMPLATES.md`, `COST.md`, `MIGRATION.md`, `OPERATING_GUIDE.md`, `PERFORMANCE.md` (generated), `REPORT.md` |
| `football/validation/integrity_performance.json` | the monitoring artifact (generated) |
| `.github/workflows/system-integrity-tests.yml` | runs the regression suite on a real PostgreSQL (required, never skipped) |

**Modified**

| File | Change |
|---|---|
| `app.html` | loads the four libraries. Every gap uses `fbCalcGap`, and every displayed line uses canonical rounding; the ±1 floor is never shown. Adds a time-zone selector, zone-labelled kickoffs, "time TBA", the "WK n" look-ahead badge, the header's current week and look-ahead and TBA counts, corrected count definitions on hover, integrity marks, a "why they differ" hover, and calibration tagged "no skill shown". The schedule fetch keeps `start_time_tbd` and `season_type`. |
| `research/cfb/index.html`, `research/cfb/terminal.js` | the libraries; zone-aware times; TBA; LOOK-AHEAD tag; the header's week, look-ahead and TBA counts; the game page's *two answers* and *data integrity* card |
| `lib/cfb_terminal.js` | canonical fair line, gap and derived scores; QB wording follows the availability classes (no "not confirmed" reason, no unsourced "contested job") |
| `lib/cfb_research_view.js` | the near-pick'em floor is never a compared or printed number; canonical gap with its reconcile formula |
| `lib/edgedesk_canon.js` | research status measured from the canonical (displayed) gap |
| `football/cfb_terminal/build.js` | kickoff truth and week scope per game; the brief is current-week only; numeric week sort; integrity verdicts at three boundaries per row; board counts reconciled; the build refuses a gap that does not reconcile, or a TBA reaching the board as confirmed |
| `football/fbs/build_coverage.js` | keeps `start_time_tbd` and `season_type`; kickoff state per game; `current_week` |
| `football/cfb_lab/integrity.js` | `screenSet`: duplicate, suspended, non-equivalent, alternate-misfiled, polarity and unmapped-team screens (quarantine, never delete) |
| `football/health/daily_check.js`, `tools/editorial/featured.js` | keep the TBD flag; a TBA game is filed as "time TBA", not "Saturday morning" |
| `lib/content_engine.js` | the integrity layer (fails closed); kickoff truth and week scope; availability; integrity per packet, with publishable-only discovery; story ranking with four separate concepts and one central storyline; five new templates; editorial integrity checks (numbers per game, QB claims, conference, kickoff, spread, snapshot); export snapshot and read-back (`exportCheck`, `compareCopy`); the ready-to-send checklist (`readiness`); the cost module (`CE.cost`) |
| `supabase/content_engine.sql` | `rejected` state; approval bound to the content and research hashes; the integrity verdict enforced at approve, ready, send; changed research revokes approval; the AI budget (`ai_months`, `ai_spend`, reserve, settle, sweep, cost report, budget door); the acquisition report |
| `supabase/functions/content_engine/index.ts` | reserve → call → settle for every Claude call (measured cost, duplicates refused, no SDK retries); carries the integrity layer verbatim |
| `admin/content/index.html`, `admin/content/content.js` | load the libraries; integrity verdicts and withheld games; Reject; the ready-to-send checklist; exports gated by `exportCheck` and stamped with the snapshot; the AI spend dashboard and budget; the acquisition dashboard |
| `tools/content/run.js` | the weekly job's AI pass is reserved against its run and settled; the local example refuses an unmetered call |
| `tools/content/inline.js`, `tools/content/artifacts.js`, `tools/articles/research_host.js` | inline the integrity layer; load the performance artifact; the article host loads the layer |
| `football/cfb_validation/versions.jsonl` | two declared PATCH rows (pricing: the slate's kickoff fields, no price change; research: display consistency) |
| `package.json` | `integrity:test`, `integrity:audit`, `integrity:performance` |
| `.github/workflows/content-engine.yml` | path filters include the integrity libraries |
| Tests | updated to the new rules, never loosened: `tools/content/{content,content_engine_fn,content_engine_sql,run}.test.js`, `tools/content/content_engine.e2e.js`; `tools/football/{_module,cfb_research_view,cfb_research_view_ui,disagreement,fair_line_ui,fbs_board_ui,label_parity,research_view_publish}.test.js`; `tools/app/{game_research,worth_researching_ui}.test.js`. Where a test pinned the old floor or the old rounding, it now pins the stricter rule, with a comment saying why. |

## 4. Database migrations

There is one idempotent file, re-pasted as for every earlier content-engine
change: `supabase/content_engine.sql`, section 6c plus edits to existing doors.

- **Additive only.** No table or column is dropped.
- **Constraints widen.**
- **Guards become stricter:**
  - approve, ready and send need an integrity verdict of PASS or WARNING;
  - they need the research unchanged since approval;
  - the budget defaults to $10, owner-configurable, with explicit
    confirmation above $10 and a database ceiling of $50.

The preflight queries, the apply order (SQL → merge → Edge Function), the
verification steps, and the non-destructive and destructive rollback are in
`MIGRATION.md`. Artifact fields are additive (`DATA_CONTRACT.md` §6).

## 5. New validation rules

- **The integrity engine:** 30 rules across schedule, projection, market,
  calculation and decision, plus `DEC.INTEGRITY_FAULT` and
  `SCHED.DUPLICATE_GAME`. The per-boundary BLOCK / WARN table is in `RULES.md`,
  generated from the code.
- **Editorial:**
  - `EDIT.ENGINE`;
  - `EDIT.GAMES`;
  - `EDIT.NUMBERS` (a number must belong to the game it is written about);
  - `EDIT.QB_UNCERTAINTY`;
  - `EDIT.CONFERENCE`;
  - `EDIT.KICKOFF`;
  - `EDIT.CONTRADICTION`;
  - `EDIT.SNAPSHOT`.
- **Export:**
  - `EXPORT.APPROVED`;
  - `EXPORT.RESEARCH`;
  - `EXPORT.NUMBERS` (Markdown, HTML and Word are read back);
  - `EXPORT.DISCLOSURE`;
  - `EXPORT.REFERRAL`.
- **Market screen:**
  - `DUPLICATE_QUOTE`;
  - `SUSPENDED_MARKET`;
  - `NON_EQUIVALENT_MARKET`;
  - `ALT_LINE_MISFILED`;
  - `PRICE_POLARITY`;
  - `UNMAPPED_TEAM`.
- **Database:**
  - `integrity_ok`;
  - `research_current`;
  - `revoke_for_research`;
  - the reservation's lock, duplicate, in-flight, retry and job-budget refusals.

## 6. Test results (this branch, local)

| Suite | Result |
|---|---|
| `tools/integrity/regression.test.js`: the 17 cases + integration (real PostgreSQL) | **117 passed, 0 failed** |
| content engine core / SQL / Edge Function / weekly job / e2e (Chromium) | 221 / 173 / 74 / 27 / 64, all passing |
| `cfb:terminal:test` (terminal 128, bettor decision 196, football decision 179, consistency 103, read 189, EV 241, quote EV 241, alternates, user test, analytics SQL 47) | all passing |
| `tools/football/cfb_research_view.test.js` (including the 2,379-case reconcile sweep) | 314 passed |
| `cfb:validation:test` (canon 88, validation 81, UI 83) | all passing |
| `football:priority:test` (166, 278), `cfb:fbs:test`, `cfb:board:audit:test`, `football:audit:test`, `cfb:test`, `cfb:lab:test`, `articles:test`, `editorial:test` (366), `nfl:slate:test`, `validation:test`, `research:test`, `site:test`, `funnel:test`, `growth:engine:test`, `record:football:test`, `bettor:consistency:test`, `football:pricing:test`, `football:data:test`, `cfb:fbs:check`, `cfb:terminal:check` | all passing |
| Every test that reads `app.html` (89 files) | 88 passing. `tools/app/first_run.test.js` fails one check ("the landing nav no longer hides the free half of the product on a phone"). **It fails identically on the base commit `8c46beaf`**, so it is not caused by this change and is left as found. |
| `node tools/integrity/rules_doc.js --check`, `node tools/content/inline.js --check` | passing |
| Browser (Chromium) suites | FBS board (59 assertions), app navigation (172), price refresh (7), CFB current week (34), CBB UI, admin funnel (31), content engine (64): all passing |
| Pre-existing browser failures | `tools/football/quote_ev_ui.e2e.js` (1 of 56: "McNeese @ LSU is on the board …") and `tools/bettor/decision_ui.e2e.js` (1 of 52: "the NFL action card decides …") fail **identically on the base commit** `8c46beaf`. They are not caused by this change and are left as found. |

## 7. Known remaining risks

1. **The in-app board's quote join still runs in the browser** (from
   `public.signals`). The production RPC proposed on 2026-09-30
   (`docs/cfb-board-integrity/AUDIT.md`) is still unapproved. The board now
   renders through the canonical layer and shows integrity marks, but its
   market consensus is not yet built in the database. This is the largest open
   item.
2. **The calibrator is degenerate.** It is labelled honestly everywhere, but no
   BET can be certified until a real calibrator passes out-of-sample
   validation. It was deliberately not tuned.
3. **Totals are not measured live.** The live record freezes spreads only.
4. **The committed artifacts predate the fix** until the next hourly build
   (`games.json` still prints "Alabama −5.3" for a 5.35 margin). The build
   with the new code was verified in a scratch directory.
5. **AI cost before the Edge Function is redeployed.** Until then the deployed
   function makes no reservation, and only the daily call count limits it.
6. **The price table is maintained by hand** (`CE.cost.PRICES`). Provider
   invoices are not imported; `billing_source` says which rows are estimates.
7. **No NFL deep dive.** The NFL model publishes no reliability score, so the
   NFL deep dive is no longer offered: it qualified before only on an assumed
   score of 70. Re-enabling it needs a real NFL reliability measure.
8. **Approvals waiting at rollout.** Articles approved before the rollout must
   be re-checked before they can be sent (`MIGRATION.md` §1).

## 8. API cost impact

| | Before | After |
|---|---|---|
| Content-engine budget | daily call counts only | **$10 / month default**, plus $2 per job, 2 attempts per request, and the daily call count kept |
| Pricing | not computed | measured from reported tokens at list prices |
| Concurrency | two drafts could both spend | one in flight per article and purpose; month lock on every reservation |
| Duplicates | possible | a repeated identical request is refused |
| Retries | the SDK retried silently | SDK retries off; each attempt reserved |

A full CFB weekly-preview rewrite costs roughly **$0.15–$0.23** (about 17K
input and 4–8K output tokens at Opus 5.5's $4 / $20 per million). Its
reservation is $0.93, settled down to the measured cost.

The deterministic writer still produces every draft at **$0**. No new
subscription, API or enrichment product was added. Other AI products' budgets
are untouched.

## 9. Production deployment status

**Not deployed.** Nothing was applied to production:

- the Supabase SQL;
- the Edge Function;
- GitHub Pages;
- the hourly artifacts.

The pull request is a draft. Production data was not read or changed.
Unverifiable in this environment, and so reported **incomplete**:

- the live in-app board after deploy;
- the Edge Function against production;
- real Stripe and acquisition figures;
- calibration on live data.

## 10. Manual actions required (owner)

1. Run the read-only preflight in `MIGRATION.md` §1, and send any approved
   article you need today first.
2. Paste `supabase/content_engine.sql` into the SQL editor and confirm every
   report row reads `ok`.
3. Merge the pull request.
4. Run *Deploy content engine*.
5. Re-check and re-approve any article that was approved before the rollout.
6. Optionally, decide on the in-app board's database market RPC (risk 1).

## 11. Before and after: the problematic games

Before is the committed build of 2026-10-08T19:07Z. After is the same inputs
through the canonical layer. **Projections are unchanged.**

| Game | Before | After |
|---|---|---|
| Ole Miss @ Vanderbilt (the board's "Ole Miss −1.0 · −9.5 · 9.3") | app: "Ole Miss −1.0" beside a 9.3 gap (the reader computes 8.5). Terminal: −0.2 / −9.6 / **9.5**. Score "Ole Miss 29.1 — Vanderbilt 29". | Ole Miss −0.2 / −9.6 / **9.4**, `|-0.2 − -9.6| = 9.4`. Score "Ole Miss 29.15 — Vanderbilt 28.95". Comparing the −1.0 display line itself gives 8.5 (regression case 1). |
| Boise State @ Fresno State | "Fresno State −1.0" (floor) beside 6.6: a 7.5 gap hidden behind the threshold | Fresno State −0.1 / Boise State −6.5 / 6.6, consistent everywhere. Score "Fresno State 24.45 — Boise State 24.35". |
| Florida @ Texas (week 7) | "FRI 11:00p" (a placeholder shown as confirmed), on the current-week board as INVESTIGATE + PASS | "Sat, Oct 17 · time TBA", "WK 7" look-ahead, SUSPECT_PLACEHOLDER. Blocked from this week's briefs and articles. |
| Wisconsin @ UCLA (week 7) | the same placeholder, on the current-week board | the same: time TBA, look-ahead, blocked from publication |
| Tulane @ Army | `ev` Tulane +3 (raw −27.2%, calibrated −2.2%) and `quote_ev` Army −3 (raw +17.8%); printable as one pair | the two shown as different bets (`DEC.EV_LAYERS`); the calibration labelled "no skill shown". `explainEv` says why the raw +17.8% is rejected. |
| Hawai'i @ Arizona State | gap 8.9 beside −11.9 / −20.9 | 9.0 |
| Illinois @ Michigan State | "Michigan State −1.0" (floor) beside 3.5 | Michigan State −0.8 / Illinois −2.8 / 3.6 |
| The October 8 header counts | "49 research-grade", "73 with a quote" | 20 research-grade + 29 investigate; 72 usable + 1 faulted + 44 none. Every count has a definition and reconciles three ways. |
| Every week-6 article | "neither starting quarterback is confirmed … no starter has been announced", for every game | Nothing is written about an expected starter: started the last game, nothing reported. A split is printed as the measured fact it is: "Quarterback watch: [A] has taken 42% of [team]’s recent dropbacks and [B] 39%", attributed to play-by-play data. Uncertainty appears only from a sourced, timestamped report. The terminal reads "(expected starter; nothing announced either way)". |

## 12. EdgeDesk features not modified

**Not modified:**

- **Model projections.** The engine (`football/cfb_p4/engine.js`), its
  parameters, ratings, fair lines, win probabilities and σ are unchanged. The
  pricing PATCH row declares that only the slate's kickoff fields changed.
- **Research thresholds** (2 / 7 points, confidence 35, reliability 60) and
  the 180-minute freshness rule.
- **The calibrator**, and the decision engine's rules (`lib/edgedesk_decision.js`,
  `football/cfb_decision`), including BET / LEAN / WATCH / PASS / NO DECISION,
  sizing and the frozen betting policy.
- **The NFL model and slate builder**, the props pipeline, the Model Lab ledger,
  P&L, portfolio, the record, games, collective, billing and Stripe, the
  growth/outbound engine, the newsletter, tennis, MLB, UFC, and intelligence.
- **Other AI products' budgets and providers.**
- **Existing UTM attribution and Stripe integration.** They are read by the new
  acquisition report, and not modified.

**Behaviour that changed by design (described in §2–§5):**

- what is displayed (canonical rounding, no ±1 floor, zone-labelled times, TBA);
- what is publishable (current week, verified, unfaulted);
- the content engine's selection, templates, checks, exports and budget;
- the publishing guards;
- the terminal's QB wording.
