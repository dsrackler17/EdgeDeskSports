# EdgeDesk CFB: product refinement and live-validation readiness

> The build phase is over. This change adds **no predictive model and no
> feature family.** It does not retune the model toward sportsbook lines and
> leaves production pricing untouched.

What it does:

- Names what was built.
- Gives every status one meaning.
- Separates research from betting.
- Measures the current champion on live games, apart from its reconstruction.
- Makes each claim show the evidence behind it.

**Production pricing is unchanged.** `football/cfb_p4/` and `football/cfb_lab/ledger/`, the Model Lab's frozen history, are untouched. The only engine-adjacent change is informational. The terminal build now records a pricing-code fingerprint and the fair-line component split on each snapshot, so a later move can be attributed. It also captures rating-state divergence, which is shown as an uncertainty flag and never priced.

**One source of truth.** Terminology, thresholds and status words come from `lib/edgedesk_canon.js` (`window.EDCanon` in the browser). The app (`app.html`), the research terminal (`research/cfb/`), the terminal build, the validation build, the internal dashboard, the landing page, the CSV exports and the games layer all read it.

Contents:

- [1–12 terminology, ratings, counters, status, maturity, pricing](#1-terminology-audit)
- [13–24 live validation](#13-live-validation-dashboard)
- [25–35 research product](#25-what-changed-views)
- [36–42 record, exports, Lab, mobile, next-100, weekly report](#36-public-record-improvements)
- [43–45 before/after, files, unresolved](#43-before-and-after)

---

## 1. Terminology audit

Every page was read for any word that meant one thing in one place and another elsewhere. The table shows each conflict and its resolution. Old words are still recognised when they are read back, through `EDCanon.LEGACY` and the terminal's `T.LEGACY_MAP`, so stored history keeps its meaning.

| Where | Old word(s) | Problem | Canonical |
|---|---|---|---|
| app card, research view, terminal, landing | REVIEW, RESEARCH LEAN, "Worth a look" | three words for a 2–7 pt gap | **WORTH RESEARCHING** |
| app card, games | PASS (as a research state) | collided with the decision engine's PASS | research **MARKET ALIGNED**; **PASS** is now decision-only |
| research view, terminal, landing | THIN DATA, LOW RELIABILITY, AWAITING DATA | three words for "cannot trust the number yet" | **LIMITED DATA** |
| research view | LOW RELIABILITY also covered "no current quote" | two causes under one word | **NO MARKET** (split out: no quote, or only a stale one) |
| app card | INVESTIGATE for a gap past the 21-pt guard | the same word for "unverified 7+" and "unsafe number" | past the guard: **DATA FAULT**; 7+ unverified: **INVESTIGATE** |
| app board gate | "fresh multi-book consensus" | book count came from undated provider rows (§32) | the count now uses dated fresh quotes only |
| app brief, card | "Research label", "Research state" | two names for one field | **Research status** |
| app, terminal | "near pick'em" whenever the raw margin was under 1, even beside a 5-pt market gap | said "no disagreement" beside a real one | **NEAR PICK'EM** only when the gap is also under 2 pts |
| app | "EdgeDesk Team Strength Rating", "canonical rating", "power rating", "blended rating" | two ratings, four names, one implied to price | **CURRENT FBS POWER RATING** and **PRODUCTION PRICING STATE** (§2) |
| every page | VERIFIED read as an instruction | research verification was read as a bet | research status and decision status are separate fields; **VERIFIED never implies BET** (§8) |
| research terminal footer, app | disclaimer text written separately per page | drifting wording | one: `EDCanon.DISCLAIMER` |
| "Why EdgeDesk" page | "prices every game from … travel, rest" | travel and rest are shown, not priced | the priced terms named exactly; travel, rivalry, weather, player quality and the current power rating listed as *shown, not priced* |

`tools/validation/ui.test.js` fails if a retired synonym reappears on the landing page or research terminal, and if a page claims an unpriced layer prices the game.

## 2. Final rating names

| | **CURRENT FBS POWER RATING** | **PRODUCTION PRICING STATE** |
|---|---|---|
| Model | ETSR (`football/rating/current.json`) | V1 engine team-strength state (`football/cfb_p4/engine.js`) |
| Measures | Current team strength: this season's opponent-adjusted play-level results, blended with measured carryover, roster/talent and verified availability | The latent trained state feeding the price: a long-run state trained through 2025, carried into 2026 (carry 0.75), updated game by game (k 0.14), and blended with a this-season-only track |
| Prices games | **No.** It is SHADOW, because its point scale is not calibrated (`calibration.measured` is false). | **Yes.** It is the champion's Layer-1 mean. |
| Maturity | SHADOW | PRODUCTION |

Where they appear:

- **In the app:**
  - "Current FBS Power Rating — top 25" and "Production Pricing State".
  - Each game card shows both numbers, labelled with which one prices.
  - The pricing-state list shows the priced blended value, the long-run and this-season components beside it, and the current rating for comparison.
- **The explainer** (`fbTwoRatingsExplainer`, built from `EDCanon.ratingPair`) sits between them and states:
  - the blend weight at the team's games played: 1.0 at 0–3 games, 0.8 at 4–5, 0.6 at 6+;
  - the ETSR results weight;
  - roster and availability inputs;
  - the scale offset between the two, about −3.5 pts, because the pricing state is not zero-centred;
  - a note when fewer than 3 games are behind the rating.

  It says in words why the two numbers differ, and that they are **never forced together**.

## 3. Rating-state divergence monitor

The divergence is defined as:

`rating_state_divergence = (current FBS power rating − its FBS mean) − (production pricing state − its FBS mean)`

Centring on each rating's own mean removes the scale offset. The monitor is computed for all **138 FBS teams**; it is written to `football/cfb_validation/divergence.json` and shown on the internal dashboard.

Current build (week 4):

| Metric | Value |
|---|---|
| Median \|div\| | 3.18 pts |
| p90 | 8.15 pts |
| Max | 14.45 pts (UL Monroe) |
| LARGE (≥ p90) | 14 teams |

- **LARGE teams:** UL Monroe, UTEP, Alabama, Purdue, Fresno State, Indiana, James Madison, Northern Illinois, Iowa, Sacramento State, Duke, Boise State, Miami, Syracuse.
- **Explanations:** every team carries a `why[]` list. For example, "the pricing state is 80% the long-run trained state (−22.2) and 20% this season's own track (−27.4) at 4 games played". A large divergence is mostly the learned prior curve, which is working as designed: early in a season the pricing state trusts the long-run state.
- **Unseeded:** North Dakota State and Sacramento State have no trained seed. Their pricing state comes only from this season's absorbed games, and the monitor names this.
- **Per game:** the terminal board carries `rating_divergence {value, band}`. The band is NORMAL, MODERATE or LARGE, with cut-offs from the backtest (§4). Current slate: 20 NORMAL, 23 MODERATE, 16 LARGE, 3 unavailable.
- **Diagnostic only:** nothing reads this value back into a price.

## 4. Divergence backtest

`football/cfb_validation/divergence_backtest.js` uses the walk-forward replay (`football/cfb_p4/research/disagreement_replay.js`). Its output is committed as `divergence_backtest.json`.

| Fold | Seasons | Role |
|---|---|---|
| DEV | 2015–2021 | fit the bands: p50 → MODERATE **2.82**, p90 → LARGE **7.22** |
| HOLDOUT | 2022–2025 | test |
| LIVE | 2026 | tracking only |

| Result | LARGE (≥ 7.22) | LOW (< 2.82) |
|---|---|---|
| Holdout MAE | 13.257 (n 287) | 12.715 (n 1637) |
| Holdout difference 95% CI | [−0.643, +1.778] | |
| Pooled difference 95% CI | [−0.185, +1.333] | |
| Seasons LARGE worse | 7 of 11 (longest run 5) | |
| EdgeDesk − opener error | 1.604 | 0.427 |
| Favourite over-projection | 2.96 | 0.537 (difference CI [0.418, 4.339]) |
| Close moved toward EdgeDesk | 55.9% | 54.5% |

**Verdict: DIRECTIONAL.** The error link points the right way in most seasons, but it is not established at 95% on error.

**Action taken:** divergence is used only as an **uncertainty / research flag**. It adds +15 to the high-uncertainty score, carries a badge on the board row and game page, and prints a line in the game's uncertainty reasons.

**The fair spread is not changed.** A football-only correction (final − fair = 0.2113 × divergence, fitted on 2015–2021) improves the 2022–2025 walk-forward MAE by 0.0764 pts (CI [−0.106, −0.044]). That clears the 0.05 research bar, so it was **queued**, not applied:

- It is backlog candidate `rc_divergence_blend_v1`, stage RESEARCH, next stage CHALLENGER, `auto_implemented: false`.
- It must pass RESEARCH → CHALLENGER → WALK-FORWARD → SHADOW → PROMOTION like any other change.
- The market's partial absorption of the same signal (55.9% vs 54.5%) is recorded as *not an edge after the vig*.

## 5. Top-level counter cleanup

Before this change the two surfaces counted different things:

- **The app** showed four undefined tiles: Games / Research-ready / Market disagreements / Data faults. "Market disagreements" mixed verified and unverified gaps.
- **The terminal** showed one count button per board status plus a separate verified count, which did not sum to the slate.

Both now show one hierarchy that sums up, built by `EDCanon.counterHierarchy`:

Week-5 slate, board of 2026-09-28 01:07 UTC:

```
ALL GAMES 62 ─┬─ RESEARCH READY 46 ─── ACTIONABLE RESEARCH SIGNALS 30
              └─ per sport: CFB 62 / 46 / 30
CFB buckets:  VERIFIED MAJOR 0 · INVESTIGATE 5 · WORTH RESEARCHING 30 · MARKET ALIGNED 11 · NO MARKET / LIMITED 16 · DATA FAULT 0
Decisions:    BET 0 · WAIT 0 · PASS 46 · NO DECISION 16   (betting disabled by policy)
```

The hierarchy carries a `reconciles` flag: buckets sum to ALL GAMES, and actionable ≤ ready ≤ all. It is tested in `tools/validation/canon.test.js` and `football/cfb_terminal/tests.js`. The app (`fbCanonCountersHTML`) and the terminal (`countersHTML`) render the same hierarchy.

## 6. Canonical counter definitions

Every counter has a hover definition built from `EDCanon.COUNTERS`. It states the population, the threshold, the sport and the statuses included, plus a one-line "means". For example:

- **RESEARCH READY:** population ALL GAMES; threshold "a PREDICTED projection and a usable current market".
- **ACTIONABLE RESEARCH SIGNALS:** population RESEARCH READY; threshold "2+ pt model–market gap that cleared every research gate". It covers VERIFIED MAJOR and WORTH RESEARCHING only.
- **INVESTIGATE:** includes MARKET FAULT, a 7+ gap the market cannot verify.
- **MARKET ALIGNED:** includes NEAR PICK'EM.

## 7. Canonical status system

There is one research status per game. It is computed by `EDCanon.researchStatus`, and the rule order is part of the contract:

1. fault
2. not projected
3. gate DATA FAULT
4. past the 21-pt guard and unverified → **DATA FAULT**
5. no market or stale → **NO MARKET**
6. 7+ → **VERIFIED MAJOR** / **MARKET FAULT** / **INVESTIGATE** (by gate result)
7. confidence < 35 or reliability < 60 → **LIMITED DATA**
8. gap ≥ 2 → **WORTH RESEARCHING**
9. \|raw margin\| < 1 → **NEAR PICK'EM**
10. otherwise → **MARKET ALIGNED**

| Status | Means |
|---|---|
| VERIFIED MAJOR DISAGREEMENT | 7+ pt disagreement that passed every integrity check. Still not a bet. |
| INVESTIGATE | 7+ pt disagreement that has not cleared the gate. |
| MARKET FAULT | 7+ pt disagreement the market cannot verify (too few fresh books, stale, books disagree). Counted under INVESTIGATE. |
| WORTH RESEARCHING | 2–7 pts at a fresh market, with usable confidence and reliability. |
| NEAR PICK'EM | Raw margin under 1 and the market within 2 pts. |
| MARKET ALIGNED | Within 2 pts. |
| LIMITED DATA | A number EdgeDesk cannot trust enough to research the gap. |
| NO MARKET | No usable current quote (none, or only one older than 180 min). |
| DATA FAULT | An integrity problem, or an unverified gap past the guard. The number is unsafe. |

Where it is applied:

- **Terminal:** the board carries `research_status` on every row, and history snapshots store it.
- **App:** the board row and card show the terminal's canonical row (`fbCanonApply`) whenever `football/cfb_terminal/board.json` is younger than 3 hours. Otherwise the app falls back to its own gate, which now counts only dated books.
- **Games layer:** `games/lib/research_state.js` mirrors the app's rungs, including the new DATA FAULT and INVESTIGATE levels, and its labels are canonical. `tools/games/state_parity.test.js` checks the parity against the canon's thresholds.

## 8. Research vs betting status

`decision_status` is a **separate field** with separate chips and a separate cell on the card. It can hold:

- **BET**, **WAIT** or **PASS** — only the decision engine produces these;
- **NO DECISION** — the engine did not evaluate the game.

Rules that hold everywhere:

- Research never implies a decision. VERIFIED MAJOR → PASS is the normal case today, because betting is disabled by policy (calibrated EV is below zero at every price).
- WAIT is shown only if the policy's timing rule is enabled. It is not.
- Every PASS prints its blocker.

Current slate: 0 BET · 0 WAIT · 46 PASS · 16 NO DECISION. The research terminal's EdgeDesk Read card prints the same canonical decision on its "Decision:" line, and the Read's own verdict is its READ chip. The CSV exports carry `decision_status` and never export BET; `tools/football/fbs_board_ui.test.js` checks this.

## 9. Maturity taxonomy

`EDCanon.MATURITY` has seven levels: **PRODUCTION VALIDATED · PRODUCTION · SHADOW · EXPERIMENTAL · RESEARCH ONLY · UNVALIDATED · DEPRECATED**. Every module is classified in `EDCanon.MODULES`:

| Module | Maturity | Moves the line |
|---|---|---|
| CFB production pricing model (V1) | PRODUCTION | YES |
| QB absence term | PRODUCTION | YES (3.90 pts only on a reported primary-QB absence) |
| V1 stylistic matchup term | PRODUCTION | YES |
| Major-disagreement integrity gate | PRODUCTION | NO (labels research) |
| CFB V2.1 challenger | SHADOW | NO |
| Current FBS Power Rating (ETSR) | SHADOW | NO |
| Football-only margin calibrator | SHADOW | NO (−0.041 MAE, under the 0.05 bar) |
| Decision engine | SHADOW | NO (betting disabled) |
| CLV / market-intelligence challenger | SHADOW | NO (market-informed by design) |
| Player quality | RESEARCH ONLY | NO |
| Personnel availability (non-QB) | RESEARCH ONLY | NO (coefficient untrained, 0.0 pts) |
| Matchup intelligence cards | RESEARCH ONLY | NO |
| Market timing (bet now vs wait) | UNVALIDATED | NO (WAIT rule disabled) |
| Reliability score | UNVALIDATED | NO (gates display, not price) |
| NFL spread model | EXPERIMENTAL | YES (tier LEAN) |
| UFC research layer | RESEARCH ONLY | NO (no UFC model exists) |

No module is PRODUCTION VALIDATED. That badge needs live evidence (§35), and none exists yet.

## 10. Pricing-impact indicators

Every module row, the app's model-status card and the maturity page print **PRICING IMPACT: YES / NO**, using `EDCanon.pricingImpactText`. Priced terms on a game page are marked **MOVES THE LINE**. The EXPERIMENTAL tooltip now says what the label means: "Tracked prospectively. The current version has not yet accumulated enough closing-line evidence for validated betting claims." The player-quality panel reads "Research only · PRICING IMPACT: NO."

## 11. "What prices this game?" panel

`EDCanon.pricingInputs(terms)` backs the app's `fbGxPricingInputs` and the terminal's `pricingPanel`. The panel lists:

- the **production pricing inputs**, each with its value for this game and marked MOVES THE LINE:
  - team-strength rating
  - home field
  - cross-conference strength
  - schedule stress
  - stylistic matchup
  - quarterback absence
  - current-season absorption
- the **unpriced layers** shown on the page (the current FBS power rating, player quality, personnel, matchup cards, V2 and so on), each with its reason and marked PRICING IMPACT: NO.

A QB-absence term with nothing reported prints 0.00 and "no quarterback absence reported for this game". A neutral site says so for home field. A term absent from the game's stored terms says so ("0 pts"), never an empty cell, and a note never repeats the number beside it.

## 12. Model-independence display

At the top of the "What prices this game?" panel, on the terminal game page and the app card, the headline reads:

> **SPORTSBOOK MARKET DOES NOT ENTER THE PURE EDGEDESK FAIR LINE.**

Below it is what the market *is* used for: comparison, research, price evaluation, integrity checks and CLV. The evidence line comes from `EDCanon.INDEPENDENCE`: 46,920 fuzzed market inputs changed no pure projection (`docs/cfb-audit/EXECUTIVE.md`), and the terminal build refuses to publish if a fair line differs from the champion slate.

---

## 13. Live validation dashboard

`admin/cfb-validation/` is internal and is linked from the Model Lab. It reads `football/cfb_validation/*.json`. Its render code is a pure block (`window.EDVAL`), run in tests on the committed artifacts. It has twelve sections:

1. North star
2. Views
3. Saturday scorecard
4. Verified vs investigate signals
5. Rating-state divergence
6. Research triggers
7. Postmortems
8. Next-100
9. What changed
10. Slate audit
11. Maturity
12. Versions

The north star currently reads **BUILDING — no settled official snapshot since the freeze yet**. It shows 60 live snapshots tracked, with MAE, CLV and calibration all "—" rather than a number from the wrong population.

## 14. Model / market / betting separation

Every view is computed three times, apart (`core.sections`):

- **FOOTBALL MODEL:** margin MAE, RMSE, median, p90, p95, worst, bias, favourite bias, winner accuracy, Brier, log loss, ECE, 80% interval coverage.
- **MARKET INTELLIGENCE:** gap sizes, market moved toward EdgeDesk, CLV, EdgeDesk-closer-than-opener and EdgeDesk-closer-than-close.
- **BETTING DECISIONS:** the decision engine's qualified wagers only. Research leans are hypothetical and labelled.

## 15. Version-specific record

`core.views` provides:

- **SINCE CURRENT MODEL VERSION**
- **CURRENT CHAMPION ONLY**
- **CURRENT SEASON (2026)**
- **LAST 25 / 50 / 100**
- **LEGACY (RECONSTRUCTED)**
- **ALL HISTORICAL**

Every snapshot is assigned a version and epoch from `versions.jsonl` (`versionAt`, `epochOf`). The record page and the dashboard show them as columns, never merged.

## 16. Since-upgrade tracking

`football/cfb_validation/freeze.js` implements the tracking:

- It fingerprints three paths:
  - **PRICING:** `football/cfb_p4/engine.js`, `params.js`, `football/fbs/build_coverage.js`, `fbs.js`, `football/matchup/inputs.js`, `football/rankings/engine_efficiency.js`.
  - **RESEARCH:** `lib/cfb_disagreement.js`, `football/cfb_p4/disagreement_params.js`, `lib/edgedesk_canon.js`, `lib/cfb_terminal.js`, `lib/cfb_research_view.js`.
  - **DECISION:** `football/cfb_decision/decision.js`, the frozen decision policy and the decision calibration.
- `--init` writes `champion.json` **once**. It holds release `edgedesk_cfb_r1`, champion `edgedesk_cfb_p4_v1.0.0`, the governance event, the fingerprints and `effective_at 2026-09-28T00:00:00Z`. It also writes one RELEASE row per path (PRICING, RESEARCH, DECISION) to `versions.jsonl`, and the frozen `next100_plan.json`.
- It refuses to run again.
- A later change to any fingerprinted file appends a **PATCH** row, effective from the build that saw it. No historical prediction is altered.

`npm run cfb:freeze:status` shows the drift. Snapshots before `effective_at` are **PRE_FREEZE**; the pricing path changed several times that day.

## 17. Legacy vs current separation

| Epoch | Contents |
|---|---|
| **CURRENT** | LIVE Model Lab snapshots at or after the freeze |
| **PRE_FREEZE** | LIVE, before the freeze |
| **LEGACY** | GIT_RECONSTRUCTED and REPLAY rows, and the public record's board numbers |

LEGACY is kept, never erased and never blended into CURRENT. Today LEGACY holds 231 graded games at MAE 12.952; CURRENT holds 0. The weekly report prints this plainly (§42).

## 18. Saturday scorecard

`core.weekScorecard` reports four columns: **this week · rolling 4 weeks · season to date · current model version**. Each column holds three blocks:

- **Model quality:** games graded, MAE, median error, worst error, 80% coverage, calibration error.
- **Market quality:** early disagreements, market moved toward EdgeDesk, average CLV.
- **Decisions:** BET / WAIT / PASS, qualified wagers, ATS and units — only the decision engine's.

Alongside the columns it reports the research gates (verified / investigate / data faults, where the Lab recorded gate verdicts), the epoch, and a plain-text report (§42).

**When a week is complete:**

- A week with LIVE snapshots is complete by the Model Lab's own rule.
- A legacy-only week is complete once every champion game has a final, or a week has passed since its last kickoff.

Legacy weeks carry `written_retroactively` and the epoch note "evidence of method, not the current record".

## 19. Win and loss postmortems

`core.postmortems` covers two groups:

- every **qualified** win and loss (none yet — betting is disabled);
- every **research lean** and every **large miss** (≥ 21 pts).

Each case runs a checklist. Every answer is YES, NO or UNKNOWN and names its source; an unknown is never assumed:

- was the original price good;
- did EdgeDesk beat the closing line;
- did the market move toward EdgeDesk;
- was the quarterback the expected one (Model Lab miss review);
- was the roster/availability read correct (snapshot data-quality checks);
- was the team state correct;
- was the matchup adjustment excessive (vs its validated p95);
- was the turnover margin an outlier (≥ 3);
- was there a data failure.

It then assigns one class:

- GOOD PROCESS / BAD OUTCOME
- GOOD PROCESS / GOOD OUTCOME
- BAD PROCESS / GOOD OUTCOME
- BAD MODEL
- BAD DATA
- BAD PRICE
- NORMAL VARIANCE
- UNRESOLVED

Current legacy counts:

| Group | Counts |
|---|---|
| Large misses | 22 BAD MODEL · 15 NORMAL VARIANCE · 2 BAD PRICE · 1 UNRESOLVED |
| Research-lean losses | 3 BAD MODEL · 3 GOOD PROCESS / BAD OUTCOME · 4 BAD PRICE |
| Research-lean wins | 2 BAD PROCESS / GOOD OUTCOME · 1 GOOD PROCESS / GOOD OUTCOME |

## 20. Verified-major scorecard

`core.signals` → `signals.json.verified` reports, for settled VERIFIED MAJOR snapshots:

- n and settled
- average gap
- market moved toward EdgeDesk %
- positive-CLV %
- average CLV
- EdgeDesk closer than the opener
- EdgeDesk closer than the close
- EdgeDesk MAE
- hypothetical ATS

It is labelled **small sample** until 30 are settled. The historical reference beside it is the gate backtest's holdout (2022–2025, football-only; n 98 verified).

## 21. Investigate scorecard and comparison

The investigate scorecard has the same fields for INVESTIGATE and MARKET FAULT snapshots. The comparison (`signals.json.comparison`) is **not read until both groups have 30 settled**. Until then it says "Building: 0 settled verified and 0 settled investigate snapshots".

Favourite flips are tracked beside it (§33).

## 22. Weekly research triggers

`core.triggers` defines eight triggers, each with a threshold, a minimum n, and the evidence behind it:

| Trigger | Fires when | Status |
|---|---|---|
| QB_CHANGE_MAE | MAE gap > 2 SE, n ≥ 30 per group | INSUFFICIENT SAMPLE |
| FAVORITE_BIAS | \|mean favourite over-projection\| > 2 SE, n ≥ 100 | INSUFFICIENT SAMPLE |
| CONFERENCE_RESIDUAL | a home conference with n ≥ 30 and \|mean residual\| > 2 SE | INSUFFICIENT SAMPLE |
| VERIFIED_FAILING | n ≥ 20 settled verified and market moved toward < 50% | INSUFFICIENT SAMPLE |
| CALIBRATION_DRIFT | last-100 ECE > 0.06, or 80% coverage outside 75–85% | INSUFFICIENT SAMPLE |
| CLV_DETERIORATION | last-50 mean CLV < 0 by > 2 SE, n ≥ 50 | INSUFFICIENT SAMPLE |
| MAE_RISING | last-50 MAE > 12.6017 + 2 SE | INSUFFICIENT SAMPLE |
| DIVERGENCE_ERROR_HISTORICAL | the §4 backtest | **FIRED** (historical) |

The headline state counts **live** triggers only. When none fires, the report says so in words: "NONE — NO STRUCTURAL MODEL ISSUE DETECTED". The historical divergence finding is listed beside it and opened a backlog candidate (§23), but it is a research lead, not a live structural issue. That is the **"model learned nothing"** state: a week of losses with no trigger is variance, and nothing changes.

## 23. Research backlog

`backlog.jsonl` is append-only, with events OPENED, UPDATED and CLOSED. A fired trigger opens a candidate with its evidence, stage `RESEARCH`, `next_stage: CHALLENGER` and `auto_implemented: false`. The same trigger never opens a second candidate. Nothing in this directory can change a price.

One candidate is open: `rc_divergence_blend_v1` (§4).

## 24. Champion governance

The rules are written into `champion.json`:

- The file is written once.
- Pricing changes append PATCH rows.
- A model reaches production only through `football/cfb_lab/governance.js promote` (RESEARCH → CHALLENGER → WALK-FORWARD → SHADOW → PROMOTION).
- **A weekly loss is never a reason.**

The dashboard's versions section lists the RELEASE rows, any PATCH rows, and pending drift.

---

## 25. What-changed views

- **Since last week:**
  - The slate: `changes.json`.
  - The system: `system_history.jsonl`, which diffs the fingerprints, versions, maturity and counters between builds.
- **Since your last visit:** the research terminal already had a per-reader watchlist diff (fair line, market, QBs, board status, target price). Each saved entry now also stores the research status, decision status, price state and favourite flip at save time, and `T.watchDiff` names any that changed. Entries saved before this change claim nothing about those fields.

## 26. Projection-change attribution

`core.attributeChange` splits a fair-line move into named causes:

- MODEL_VERSION
- SOFTWARE_PATCH (a pricing fingerprint change)
- NEW_GAME_ABSORBED
- QB_STATUS
- per-term deltas: TEAM_STATE_REFRESH, HOME_VENUE_CORRECTION, MATCHUP_UPDATE, QB absence …
- UNATTRIBUTED

**The market can never be a cause.** A market-only move attributes nothing, and a test covers it.

Two further rules:

- **Reconciliation:** the term deltas must reconcile with the move. Any residual is reported as `unexplained`.
- **Missing components:** when the earlier snapshot predates component capture, the result is `TERMS_NOT_RECORDED` rather than each term's full value.

That second rule fixes a bug found during this audit. A −1.6 move on North Texas @ Tulsa had read as a "−12.4 team-state refresh".

Snapshots now carry `components`, `games_played`, `pricing_fingerprint`, `qb` and `research_status`, so future moves split cleanly.

## 27. Price-gone logic

`EDCanon.priceState(edge_decay)` reads the edge-decay record the decision layer already keeps:

| State | Means |
|---|---|
| PRICE STILL AVAILABLE | most of the initial disagreement is still there |
| PART OF THE EDGE PRICED IN | the market has moved part of the way |
| EDGE MOSTLY PRICED IN | "the football opinion may stand; the price that made it interesting is mostly gone" |
| PRICE NO LONGER ATTRACTIVE | reached or reversed |
| NO INITIAL EDGE | there was no research-sized disagreement to begin with |
| PRICE HISTORY UNKNOWN | only one moment on file |

Current slate: 27 available, 11 partial, 3 mostly priced in, 1 no longer attractive, 14 no initial edge, 6 unknown. The state is a badge on the row and game page and a CSV column.

## 28. Cleanest-research view

`research/cfb/#/cleanest` uses `T.isCleanest`. It lists games with:

- high football confidence and strong reliability;
- the cross-model consensus in agreement (SD under the moderate bound);
- a fresh, non-stale market;
- a research-sized gap, where a 7+ gap counts only if verified;
- both quarterbacks resolved and uncontested;
- no DATA FAULT or NO MARKET status.

These are the games where the gap is most likely to be about football rather than missing data.

## 29. High-uncertainty view

`research/cfb/#/uncertain` uses `T.uncertainty`. It ranks games by an uncertainty score with printed reasons (`uncertainty_why`):

- a QB contested or unknown (+20 each side)
- the cross-model consensus disagreeing (SD ≥ 3, +20)
- a wide outcome range (+15)
- thin current-season data (under 3 games, +15)
- an FCS opponent (+20)
- low reliability (+10)
- a thin market, under 2 fresh books (+10) — new
- a roster or availability feed problem (+10) — new
- **LARGE rating-state divergence (+15)** — new

It is a research lens, not a price adjustment.

## 30. Why-not-bet explanation

`EDCanon.whyNotBet` builds one canonical list per game (`o.why_not_bet` on the terminal), in this order:

1. betting disabled by the frozen decision policy;
2. cover probability vs break-even. Below: "the price does not clear break-even". Above: the margin, set against EdgeDesk's typical miss, with the note that cover probabilities have not been shown to carry skill;
3. an unverified large gap (INVESTIGATE or MARKET FAULT);
4. the price is gone (priced in or reversed);
5. the decision engine's own blockers.

The terminal game page prints this list under "Why this is not a bet", beside the research and decision chips. The app's Decision cell and copied brief print the same game's decision label and reason from the canonical board row.

## 31. Verified-major detail packet

`packetHTML` on the terminal game page opens an audit report for every 7+ gap. It shows what passed on a verified gap and what did not on an unverified one.

It lists:

- model and market;
- the gap and its direction (with FAVORITE FLIP);
- the books behind the consensus and the market's age;
- the component models: how many independent submodels support EdgeDesk's side;
- the team-state difference (neutral strength, long-run state, current form);
- the current-rating difference;
- both quarterbacks;
- the matchup term;
- the football-only calibrated gap;
- every integrity check with PASS or FAIL and its detail, and a "k of n checks passed" summary.

It closes with the reminder that VERIFIED is a research status, not a decision.

The terminal's `disagreementView` now stores the full checks, tier, calibrated gap, cross-model check and decomposition, so the packet is built from stored data.

## 32. Current-slate status audit

`football/cfb_validation/slate_audit.json` covers every named game plus every 7+ gap on the week-5 slate. Each requirement is shown as PASS, FAIL or NOT IMPLEMENTED; a requirement that isn't implemented downgrades the status.

The table uses the board of 2026-09-28 01:07 UTC. Statuses move as quotes age, and the audit is rebuilt with every validation build.

| Game | EdgeDesk | Market (books) | Gap | Status | Failed checks |
|---|---|---|---|---|---|
| Syracuse @ UConn | UConn −12.5 | Syracuse −5.5 (0 fresh) | 18.0 | NO MARKET | — (quote aged out; no gate without a current market) |
| North Texas @ Tulsa | North Texas −10.6 | Tulsa −2.5 (1) | 13.1 | MARKET FAULT | multi-book consensus, team states |
| Temple @ South Florida | USF −16.0 | USF −5.5 (1) | 10.5 | MARKET FAULT | multi-book consensus |
| Marshall @ James Madison | JMU −25.7 | JMU −17.5 (1) | 8.2 | MARKET FAULT | multi-book consensus, availability, submodel support, football-only calibration |
| Vanderbilt @ Georgia | Georgia −16.7 | Georgia −24.5 (1) | 7.8 | MARKET FAULT | multi-book consensus, submodel support |
| West Virginia @ Iowa State | ISU −10.2 | ISU −3.0 (1) | 7.2 | MARKET FAULT | multi-book consensus, submodel support, football-only calibration |
| California @ UNLV | UNLV −10.2 | UNLV −2.5 (0 fresh) | 7.7 | NO MARKET | — (quote aged out) |
| Ohio State @ Iowa | Ohio State −6.8 | Ohio State −13.5 (1) | 6.7 | WORTH RESEARCHING | under 7 pts: no gate required |
| Miami @ Clemson | Miami −14.8 | Miami −17.5 (1) | 2.7 | WORTH RESEARCHING | under 7 pts: no gate required |

**Result: no status contradicts its checks (`inconsistent: []`).** None of the 7+ gaps is verified:

- Every one with a current market fails "fresh multi-book consensus": each has **1 book**, and the tier needs 2 or 3.
- WV @ ISU and Marshall @ JMU also fail football-only calibration, meaning the calibrated gap drops under 7.
- Syracuse @ UConn and California @ UNLV have no fresh quote at all, so they are NO MARKET rather than a gap to verify.
- On the earlier 21:07 UTC board, with those quotes still fresh, all eight 7+ gaps were MARKET FAULT. That included Syracuse @ UConn, which failed five checks, and California @ UNLV and Ohio State @ Iowa (7.2 pts then), both of which also failed football-only calibration.

**Finding on the app path, now fixed.** The app board's gate counted books from `cfb.lines` provider rows, which carry no capture time, while judging freshness on a different, dated quote. So "fresh multi-book consensus" was not actually verified on that path, and the app could show VERIFIED where the terminal showed MARKET FAULT. Two changes fix it:

- The app now counts only dated, fresh quotes (`fbP4QuotesFor` actionable + `captured_at`).
- It shows the terminal's canonical status whenever `board.json` is fresh.

`tools/football/disagreement.test.js` covers both the dated and the undated case.

## 33. Favourite-flip tracking

`EDCanon.favoriteFlip` marks a game where EdgeDesk and the market favour different teams. The board shows a **FAVORITE FLIP** badge, `snapshotRow` records `favorite_flip` in history, `signals.json.favorite_flips` scores the flips as their own group, and the CSV exports carry a `favorite_flip` column.

This week has 4 flips:

| Game | Research status |
|---|---|
| Old Dominion @ Georgia State | WORTH RESEARCHING |
| Penn State @ Northwestern | WORTH RESEARCHING |
| North Texas @ Tulsa | MARKET FAULT |
| Syracuse @ UConn | NO MARKET |

## 34. Model maturity page

`research/cfb/#/maturity` (`renderMaturity`, reading `football/cfb_validation/maturity.json`) shows one row per module:

- model, with the reason for its level
- version
- status
- training cut-off
- live N
- walk-forward badge
- CLV badge
- pricing impact

Below the table it prints what each status means and what each badge requires.

The app's model-status card links to it and shows the canonical maturity badges.

## 35. Validation badge definitions

`EDCanon.BADGE_RULES` and `validationBadges(ev)` define four badges:

| Badge | Rule |
|---|---|
| WALK-FORWARD TRACKED | Predictions of this exact version are frozen before kickoff (LIVE) and graded. It is about method, so there is no minimum. |
| WALK-FORWARD VALIDATED | All of the following: at least 700 settled LIVE games of this exact version; an MAE difference whose 95% bootstrap CI lies entirely below 0, against the replaced model (for a challenger) or against its own pre-registered holdout reference + 0.25 (for the incumbent); ECE ≤ 0.03; 80% coverage between 75% and 85%. |
| CLV PENDING | Fewer than 200 settled, priced, multi-book decisions, or a CI that includes 0. |
| CLV VALIDATED | At least 200, with mean CLV > 0 and the CI lower bound > 0. |

The champion is WALK-FORWARD TRACKED (0 / 700) and CLV PENDING.

---

## 36. Public record improvements

The record page (`research/cfb/#/record`) now shows **two records side by side**:

- **CURRENT MODEL RECORD** — LIVE snapshots of this version.
- **LEGACY — MODEL LAB RECONSTRUCTION**, plus the heading **LEGACY PUBLIC RECORD**.

Each row adds **Frozen pre-KO** (was the number frozen before kickoff) and **Status then** (the research status when it was frozen, not today's). Rows are never re-graded: a game keeps the number and status it had when it was frozen.

## 37. Collective / export consistency

Both CSV exports end with the same canonical tail of eight columns:

- `prediction_timestamp`
- `research_status`
- `decision_status`
- `market_snapshot_home_line`
- `market_snapshot_at`
- `price_state`
- `favorite_flip`
- `row_kind`

The in-app export is `FBP4_CANON_HEAD`, `fbP4CanonTail`. The offline export is `football/cfb_p4/export_csv.js` `CANON_HEAD`, `canonTail`. The offline export's predicted rows had been 19 columns short, and that is also fixed.

- **Collective safety:** the Collective maps a column only by exact synonym (`SLATE_FIELDS`, `slateFieldFor`). None of the eight new names matches any synonym, so no projection, line or pick can be remapped. `tools/validation/ui.test.js` §5 checks this.
- **Tests:** `tools/football/fbs_board_ui.test.js` checks header parity between the two exports, the tail length, and that BET is never exported.

## 38. Model Lab truth-source updates

The Model Lab ledger stays the truth source; nothing in it was rewritten. The validation build reads it (`REPORT.load(new G.Store(season))`) and adds the version/epoch split, the since-upgrade view and the legacy view on top. The Model Lab links to the validation dashboard.

**The product does not require the Lab:**

- the app works from the terminal board;
- the terminal works from its own artifacts;
- a missing validation artifact renders "did not load", never as empty success.

## 39. Mobile cleanup

- **Terminal:** at ≤ 720px:
  - the six-questions grid folds the answer under its question;
  - counter cells shrink to share a row;
  - the row chips left-align and wrap;
  - the two-record panel becomes one column.

  Wide tables (the record, the audit packet, the maturity table) sit in the existing `.tscroll` box, so they scroll inside the page rather than widening it. The maturity table was renamed `mattbl` to stop a class collision with the `.mat` badge that broke its layout.
- **App:** the two-rating block (`.gd-two`), the canonical counters (`.fb-canon-k`) and the pricing-inputs block (`.gx-xb`) collapse to one column.
- **Dashboard:** it reuses the Model Lab's responsive CSS.

## 40. Duplicated UI and text removed

- **Terminal queue:** one count button per board status, plus a separate verified count, became one reconciling hierarchy.
- **Terminal game page:** the board status chip, the "UNVERIFIED 7+ GAP" badge and a status-reason line became one research chip and one decision chip, with badges.
- **Why-not-bet:** "Why EdgeDesk passes" / "Why not bet this?", built per status, became one canonical "Why this is not a bet" list.
- **App card:** a "Research state" cell beside a separate research label became one "Research status" cell and a separate Decision cell. The copied brief follows the same split.
- **Terms page:** the terminal's own status table became the canonical research-status and decision-status definitions, read from the canon.
- **Disclaimer:** the research terminal's footer is the canonical `EDCanon.DISCLAIMER`.
- **Model independence:** the statement is read from `EDCanon.INDEPENDENCE`.

## 41. Next-100 prospective evaluation

`next100_plan.json` is written once at the freeze. It pre-registers the baselines:

| Baseline | Value | Source |
|---|---|---|
| Margin MAE (legacy) | 12.952 (n 231) | reconstructed 2026 |
| Margin MAE (holdout) | 12.6017 (n 1604) | 2024–2025 |
| Margin MAE (backtest) | 12.769 (n 3127) | 2022–2025 |
| ECE | 0.0456 | |
| Market moved toward | 33.8% | |
| CLV | 0.192 | |
| False-major rate | 24.5% | |
| Selectivity | 0 | |

It also pre-registers:

- **The population:** the first 100 settled LIVE OFFICIAL (T24) snapshots of `edgedesk_cfb_p4_v1.0.0` taken at or after the freeze.
- **Seven metrics:** margin MAE, ECE and 80% coverage (FOOTBALL MODEL); market moved toward and CLV (MARKET INTELLIGENCE); false-major rate (RESEARCH GATE); and decision selectivity (BETTING DECISIONS), which is reported, not optimised.
- **The rule:** "Do not change the model to hit any number below."

- **No retrofit:** baselines can't change after the fact, because the file is never rewritten.
- **Patch versions:** games under a patched version count, and the patch is named beside them.

Progress today: 0 / 100.

## 42. Weekly executive report

`weekly/<season>-wNN.{json,md}` is written **once**, when a week is complete. It covers:

- games
- MAE
- market movement toward EdgeDesk
- CLV
- verified / investigate
- BET decisions
- record
- the primary concern
- the research trigger
- rolling 4 weeks
- season
- current version

Every report ends: *"One week is never the verdict. No model change follows from this report."*

Weeks 2–4 of 2026 exist and are labelled **LEGACY NUMBERS**, with the note that nothing about the current version can be read from them.

---

## 43. Before and after

Screenshots are in [`screens/`](screens/).

| Area | Before | After |
|---|---|---|
| Board counters | app: four undefined tiles; terminal: one count per board status that did not reconcile | one hierarchy (ALL → READY → ACTIONABLE) that reconciles, CFB buckets, a separate decision line, a definition on every counter (`screens/terminal_queue.png`) |
| Row status | a research word and a board word, sometimes contradicting (VERIFIED on the app, MARKET FAULT on the terminal) | one research chip and one decision chip, plus FAVORITE FLIP, price-state and divergence badges |
| Ratings | "EdgeDesk Team Strength Rating" beside a "power rating" that priced; no explanation of why they differ | CURRENT FBS POWER RATING vs PRODUCTION PRICING STATE, "which one prices", and a per-team why list |
| Game page | fair line, market and gap; the terms that price the game were implicit | the six questions answered, "What prices this game?" with MOVES THE LINE / PRICING IMPACT: NO, the independence headline, the gate audit packet (`screens/terminal_game.png`, `screens/terminal_game_pricing.png`) |
| Model status | a single "production" badge | a maturity page with 16 modules, pricing impact, badges and the promotion bar (`screens/terminal_maturity.png`) |
| Validation | Model Lab pages mixing reconstruction and live | a dashboard with north star, eight views, three separated sections, triggers, backlog, next-100 and versions (`screens/validation_dashboard.png`) |
| Record | one record | CURRENT vs LEGACY, Frozen pre-KO, Status then |
| Mobile | wide tables pushed the page sideways | contained, stacked (`screens/terminal_queue_mobile.png`) |

## 44. Files, functions and tables changed

**New**

- `lib/edgedesk_canon.js` — the canon, covering §1–12, 27, 30, 33 and 35.
- `football/cfb_validation/` — see its README.
  - `core.js`
  - `freeze.js`
  - `divergence_backtest.js`
  - `build.js`
  - `tests.js`
  - the artifacts
- `admin/cfb-validation/index.html` — the internal dashboard.
- `tools/validation/canon.test.js` and `tools/validation/ui.test.js`.
- `.github/workflows/cfb-validation-tests.yml`.
- `docs/cfb-validation/DELIVERABLE.md` (this file) and `screens/`.

**Changed**

- `lib/cfb_terminal.js`
  - `T.build`: research and decision status, price state, favourite flip, rating divergence, why-not-bet, pricing inputs.
  - `T.counts` now includes the hierarchy.
  - `T.isCleanest`, `T.uncertainty` and `T.LEGACY_MAP`.
  - `disagreementView` stores the full gate audit.
- `lib/cfb_research_view.js`
  - LIMITED DATA and NO MARKET labels.
  - Near pick'em requires the gap to be under the research threshold.
- `football/cfb_terminal/build.js`
  - The decision is evaluated only when priced.
  - Rating-divergence input.
  - Pricing fingerprint.
  - `snapshotRow` gains components, games_played, research and decision status, verification, favourite flip and fingerprint.
  - Board rows gain the canonical fields.
- `football/cfb_terminal/{board,games,record,brief}.json` — regenerated. History is untouched.
- `research/cfb/{index.html,terminal.js,terminal.css}`
  - Chips and badges; `countersHTML`, `sixAnswers`, `pricingPanel`, `packetHTML`, `renderLens`, `renderMaturity`.
  - Routes `#/cleanest`, `#/uncertain` and `#/maturity`.
  - The two-record panel and the canonical footer.
- `app.html`
  - Rating names, the explainer and pair.
  - The dated-quote gate and the canonical board override (`fbCanonApply`).
  - Canonical counters, the research-status and decision cells, and `fbGxPricingInputs`.
  - Maturity badges and the CSV canonical tail.
  - `fbGxState` rungs.
- `football/cfb_p4/export_csv.js` — the canonical tail, plus the predicted-row column fix.
- `games/lib/research_state.js` — the canonical rungs and labels.
- `games/data/challenges.json` — research states re-derived by the shipped classifier: 8 games with a 7+ gap move from REVIEW to INVESTIGATE; labels and thresholds updated; inputs unchanged.
- `index.html` (landing) — the canonical demo statuses and walkthrough copy.
- `admin/cfb-lab/index.html` — link to the dashboard.
- `package.json` — `cfb:validation`, `:check`, `:test`, `:backtest`, `cfb:freeze:status`.
- `.github/workflows/cfb-lab.yml` — a Live validation step, and `football/cfb_validation` added to the publish list.
- Tests updated to the canonical words, each with its rationale:
  - `tools/football/{fbs_board_ui,fbs_board.e2e,cfb_research_view,cfb_research_view_ui,research_view_publish,disagreement}`
  - `tools/app/{research_landing,worth_researching_ui,game_research}`
  - `tools/presentation/{landing_positioning,landing_interaction}`
  - `tools/games/{state_parity,games}`

**Not changed:** `football/cfb_p4/engine.js`, `params.js`, the champion slate, `football/cfb_lab/ledger/`, the decision policy and calibration, and any Supabase table.

## 45. Unresolved issues

1. **No live evidence yet.** The freeze is effective 2026-09-28 and 0 CURRENT snapshots are settled. Every live metric reads "—" until week 5 is graded. The first honest current-version read comes after about 100 games (§41). WALK-FORWARD VALIDATED needs 700.
2. **The market feed is single-book on this slate.** Every 7+ gap with a current quote is MARKET FAULT, because only one book is captured. Until a second dated book is ingested, VERIFIED MAJOR cannot occur on this path. This is a data-coverage gap, not a gate bug, and the gate is right to refuse.
3. **The divergence correction is queued, not tested prospectively** (§4). It must go through the challenger pipeline; it will not be applied to production from a backtest.
4. **Two unseeded FCS-transition teams** (North Dakota State, Sacramento State) are priced from this season's games only, and their divergence is large by construction.
5. **ETSR stays SHADOW** until its point-scale calibration is measured.
6. **Attribution of older snapshots.** History rows written before this change carry no component split. Moves between them read TERMS_NOT_RECORDED rather than being guessed.
7. **The games layer's committed challenges** were re-labelled in place, with the same inputs and the shipped classifier. The next scheduled games build regenerates them from source.
8. **The EdgeDesk Read's stored decision field (merged from #392).** The Read has its own price-timing vocabulary (READ BET EARLY / BET / WAIT / PRICE TARGET / RESEARCH / PRICE GONE / PASS / INVESTIGATE / NO DECISION). Its research statuses agree with the canon, but it maps timing to its own `decision_status`: an unverified 7+ gap becomes NO DECISION, where the governed engine says PASS.
   - **Fixed in this change:** on the game page and in the copied card, one decision word per game. The Read card's "Decision:" line and the Read export's parenthetical print the canonical decision, the same word as the DECISION chip. The Read's verdict stays in its own READ chip. The copied card's "Status:" line, which could say WAIT, is replaced by "Research status:" and "Decision:".
   - **Still open:** the Read's stored `decision_status` in `read/<season>/reads.jsonl`, `read.csv` and the Read record keeps its own mapping. That field is hashed into each read's id, so it was deliberately not rewritten here.
9. **Supabase-hosted surfaces** (the Collective server-side views, the Model Lab sync) were not changed. The canonical CSV tail is additive, and the Collective ignores it by design (§37).
