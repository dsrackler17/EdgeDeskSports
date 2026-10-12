# Phase 2 — Multi-agent research intelligence: design

This is how the research system works, in the order a question runs through it.
Nothing here writes a number: every probability, price and EV comes from the
deterministic engines (EDFAIR, EDPRICE, the NFL slate engine). The language
model, when it is switched on at all, may only rephrase a verified result,
under a critic.

## 1. The flow

```
question ─► classify (EDQUANT)
   SCAN            "best bet …"                 ─► board (EDBOARD) ─► audit top N (EDAUDIT) ─► research chain on each ─► answer
   RESEARCH_SLATE  "research every NFL game …"  ─► L1 every game ─► L2 largest gaps ─► L3 priced candidates ─► answer
   BETS            "why did I lose money …"     ─► the caller's own portfolio_positions (RLS) ─► EDBETS ─► answer
   CONTRACT/PRICE/COVERAGE/OUTAGE                (Phase 1, unchanged)
```

The research chain for one candidate (`researchChain` → `EDAGENTS.investigate`):

```
RESEARCH ─► PRICE ─► DISAGREEMENT ─► STRATEGIST ─► AUDIT CLASSIFICATION
   ▲                                                       │
   └──── RECALCULATE (only a registered rule with the ◄────┘  at most 2 rounds
         model's OWN scenario delta; e.g. QB out)
```

`EDGEDESK_RESEARCH=0` turns the chain off; the desk then answers exactly as in Phase 1, with the same prices and no research memory written (asserted in `research_host.test.js`, "OFF").

## 2. The five roles

| Role | Code | May | May not |
|---|---|---|---|
| A. Live sports researcher | `research()`, `normalize()`, `conflicts()`, `corroborate()`, `modelGaps()` | Read the injury report, depth charts, MLB probables, desk notes, and the live nflverse feed at L3. Classify reliability. Find conflicts and what the model does not carry | Change a number. Treat speculation as confirmed (the "sources say / expected to / could" words make a claim SPECULATION, never verified). Accept a finding with no URL or retrieval time, or one written by EdgeDesk |
| B. Quantitative oddsmaker | `price()`, `sensitivity()` | Price on the board's fair (a validated model blend, or the sharp no-vig). Move a number only through `ADJUSTMENT_RULES` (QB_OUT / STARTER_CHANGE) using the model's own re-run delta and its error sigma. With `conservative`, publish the lower-EV of model and audited market fair | Accept a probability from anywhere (refused: "a probability cannot be supplied to the oddsmaker"). Swap a LEAN model in for the board's fair (`prices:false` → cross-check only) |
| C. Professional market strategist | `strategist()` | Ask seven questions: artifact? priced in (including verified news that arrived after the quote)? calibrated? after fees? edge vs uncertainty? blind test (no team names)? independent signal or narrative? It may reject | Upgrade anything. The principles of Walters, Voulgaris, Bloom and Thorp are inspirations, not endorsements |
| D. Adversarial auditor | EDAUDIT (fresh re-read, 15 checks) + `classify()` | Give each candidate one class: VERIFIED CANDIDATE / RESEARCH REQUIRED / WATCHLIST / REJECTED / UNVERIFIED. It can reject what the researcher favours (`research_host.test.js` S8b) | Pass a candidate the board withheld. Call anything verified that is not robust to a one-point error in the fair |
| E. Research communicator | `renderCandidate()` (deterministic), `narrateResearch()` + `critic()` (optional model) | Rephrase the candidate block | Add, drop or change a number; add a link, a certainty word, a person or a status claim the result never made; change the final status. Any of these and the deterministic text is served instead |

Final status mapping: VERIFIED CANDIDATE → **VERIFIED CANDIDATE**; RESEARCH REQUIRED / WATCHLIST → **WATCHLIST**; REJECTED / UNVERIFIED → **PASS**.

## 3. A research finding

Every finding carries: `source_url` (https), `publisher`, `published_at`, `retrieved_at`, `event_ref`, `team`, `player`, `topic`, `claim`, `status`, `reliability` (OFFICIAL / CREDIBLE_JOURNALISM / STATISTICAL_DATA / SPECULATION / OPINION / UNKNOWN), `verified` + `verification` (OFFICIAL_SOURCE, STATISTICAL_SOURCE, CORROBORATED (publisher), SINGLE_SOURCE, NOT_CONFIRMED), and `conflicts`.

Conflict resolution (same player, same topic, incompatible statuses):
1. Different tiers: the more reliable source wins, **unless** the less reliable one is credible journalism and at least 6 h newer. Then it stays unresolved, because the official report may simply predate the news.
2. Same tier: a report at least 6 h later wins.
3. Otherwise: UNRESOLVED → the candidate is RESEARCH REQUIRED, and no scenario is applied.

## 4. The evidence graph (EDGRAPH)

Nodes: EVENT, TEAM, PLAYER, SOURCE, CLAIM/STATISTIC, MODEL INPUT, PROJECTION, MARKET, AUDIT. Edges: supports, contradicts, affects (with `in_model` / `changed` / `delta`), corroborates (different publishers only).

The graph answers several queries:
- which source supports a claim;
- what contradicts it;
- what is missing or stale;
- which findings were not in the model;
- which findings changed the conclusion;
- which URLs and numbers an answer may cite (`trace()`, `verifyCitations()`).

## 5. Research on demand and its budget (EDBUDGET)

| Level | When | Requests | Paid calls | Time | Tokens |
|---|---|---|---|---|---|
| L1 fast screen | coverage, outage, bets, screening, nothing on the board clears | 0 | 0 | — | 0 |
| L2 targeted | the largest gaps on a slate (≤ 5 games) | 4 | 0 | 2.5 s | 0 |
| L3 deep adversarial | a best-bet scan with candidates; "research / investigate / audit" | 8 | 2 (0 unless authorised) | 6 s | 1,500 |

Every external call the research chain makes goes through one ledger (the older single-game investigation layer keeps its own budgets, `INVESTIGATE_MS` / `INVESTIGATE_REQUESTS` / `INVESTIGATE_SEARCH_CALLS`):
- per-provider daily and monthly quotas, and a per-user daily cap;
- single flight (an identical in-flight request is joined);
- a topic-TTL cache (availability 60 min near kickoff, statistics 12 h …);
- a circuit breaker (3 failures open it, with exponential back-off) that falls back to the cached value, labelled stale;
- a timeout;
- a bounded usage log with a per-call cost estimate, reported per turn.

The database ledger (`research_usage_claim`) is authoritative for paid calls. Narration claims against it before calling the model, and settles after.

The desk never asks the odds capture for fresh quotes (the LITE route). No agent can trigger odds-API spend; the suites assert zero odds requests in every scenario.

## 6. The model-disagreement engine (EDDISAGREE)

Causes, each LIKELY / POSSIBLE / RULED_OUT / NOT_ASSESSED, with evidence:
- data quality
- injury information
- lineup assumptions
- statistical methodology
- recent weighting
- venue/weather
- market movement
- model uncertainty
- potential mispricing

Verdicts: DATA_FAULT · NO_MODEL · EXPLAINED · POTENTIAL_MISPRICING · INVESTIGATE.

"Potential mispricing" is possible only when all of these hold:
- the model is validated or LEAN;
- data quality is ruled out;
- availability was assessed;
- nothing else is likely;
- the audit confirmed the price;
- the market number is an executable price, not a reference line.

A gap of 7 points or more is a suspected data fault first. Model-line uncertainty is reported as NOT ASSESSED, because the validation records error against results, not the line's error against the close; the outcome sigma is never used as a stand-in.

## 7. Confidence, kept as four separate measures

| Measure | Basis |
|---|---|
| Outcome probability | The fair and its source |
| Research confidence | Verified findings, speculation set aside, conflicts, missing topics, staleness |
| Model reliability | VALIDATED, LEAN (break-even history), RESEARCH, or market-derived |
| Execution confidence | Quote freshness, book confirmation, fee status |

They are never combined into one number. No model is called calibrated without the validation record.

## 8. Memory: `supabase/research_intel.sql`

| Object | Rule |
|---|---|
| `research_findings` | Write-once, per-user `(user_id, finding_id)`, https source, retrieval time required, provider never `edgedesk_ai`, speculative ≠ verified |
| `prediction_snapshots` | Write-once. Trigger refuses `event_start ≤ now()` and a quote captured at or after kickoff. No outcome columns; grading joins results later (view `prediction_snapshot_grades`) |
| `research_provider_quota` | Seeded; **paid providers disabled** |
| `research_usage` + `research_usage_claim()` / `research_usage_settle()` | Security definer, atomic claim, settle once |
| Retention | No reader deletes; `research_intel_prune(p_days ≥ 90)` for the service role only |
| RLS | Own rows only; grants revoked, then select/insert granted |

The edge function writes under the caller's JWT (it holds no service-role key).

## 9. Perplexity (and paid research) — evaluated, not enabled

**What it would add.** Search-grounded answers with citations on topics the free sources do not cover: beat-reporter news, coaching changes, late MLB scratches.

**What it costs.** Third-party pricing summaries agree on the following:
- Sonar: about $1 per million tokens in and out, plus $5 / $8 / $12 per 1,000 requests by search context size (low / medium / high).
- Sonar Pro: $3 / $15 per million tokens, plus $6 / $10 / $14 per 1,000 requests.

One source reports that the Sonar Chat Completions interface was deprecated, with support until 27 Sep 2026 and new builds pointed at an "Agent API". Perplexity's own documentation host did not resolve from the build environment, so none of this could be checked against the official rate card. The ledger and the quota table carry the estimate (`$0.008` per call), labelled as such.

**Incremental benefit over what exists.** Not yet demonstrated:
1. NFL availability already comes from the official report mirror, with timestamps.
2. MLB's real gap is a scratch feed, which a structured official feed would close better than a search answer.
3. A generated summary is a claim, not a source; each cited URL would still need fetching and classifying before it could count as evidence, and that is most of the cost of real research.
4. The interface status needs confirming (see the deprecation report above).

**Decision.** It is registered disabled (`perplexity_sonar`: ledger `paid: true`, quota `enabled = false`) and not wired. To enable it, an operator would:
- set `EDGEDESK_PERPLEXITY_API_KEY` and `EDGEDESK_RESEARCH_PAID_OK=1`;
- enable the quota row;
- wire it through the ledger with citation fetching, then measure it against the official sources on a held-out week first.

No paid service or new billing was activated by this work.

Sources (secondary, retrieved 2026-10-12):
- https://developer.puter.com/tutorials/perplexity-api-pricing/
- https://flexprice.io/pricing-index/perplexity-sonar-api
- https://amnic.com/blogs/perplexity-api-pricing
- https://krater.ai/blog/perplexity-pricing

## 10. Betting performance intelligence

**Import.** `leg_rows_sportsbook_v1`, a Juice Reel style export with one row per leg:
- groups the rows by ticket id;
- takes stake, price, payout and status once per ticket (never summed);
- flags tickets whose rows disagree (`TICKET_FIELDS_DIFFER`) and refuses to guess them;
- counts a duplicated leg once.

**Analysis.** EDBETS reports:
- singles vs parlays;
- breakdowns by sport, market type, bet type, price band and stake band;
- the worst days, and the days that took a disproportionate share of the losses;
- juiced alternate lines, with their break-even rates;
- statuses (open, void, cash-out, push), timestamps, and CLV for singles.

All money is exact decimal.

**Privacy.**
- The desk reads `portfolio_positions` with the caller's token (RLS). Its read category is uncached.
- Nothing is written or sent to a model.
- The response carries summaries, not ticket lists.

**Language.**
- Answers describe the past only, and end: "These figures describe your past results only; they do not predict future results."
- `checkLanguage()` refuses chasing or stake-raising wording.

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EDGEDESK_RESEARCH` | `1` | The research chain on the quant desk |
| `EDGEDESK_RESEARCH_LIVE` | `1` | The keyless live nflverse feed at L3 |
| `EDGEDESK_RESEARCH_PAID_OK` | `0` | Authorises paid providers in the in-isolate ledger |
| `EDGEDESK_RESEARCH_NARRATE` | `0` | The optional model communicator. Also needs `PAID_OK=1` and the `anthropic_narration` quota row enabled |
| `EDGEDESK_PERPLEXITY_API_KEY` | unset | Not used by any code path today |

## 12. Tests (all offline, all run)

| Suite | What it proves |
|---|---|
| `tools/intelligence/research_agents.test.js` | The kernels: graph, disagreement, budget, the five roles, the critic, and the rules in §3, §5 and §6 |
| `tools/intelligence/research_host.test.js` | Through the real handler: the 12 scenarios, both acceptance questions, numeric consistency, the critic, the narration gates |
| `tools/intelligence/research_intel_sql.test.js` | The migration applied twice on PostgreSQL 16 and attacked |
| `tools/intelligence/quant_host.test.js` / `quant_ui.e2e.js` | Phase 1 behaviour preserved; the new format rendered in Chromium at desktop and phone widths |
| `tools/portfolio/bet_history*.js` | Import, analytics, SQL round trip, dashboard |

## 13. Deploying (manual, not done by this work)

1. Apply `supabase/research_intel.sql`: `deploy-intelligence.yml`, input `apply_research_intel`. Read the closing report for `CHECK THIS`.
2. Deploy the edge function: `deploy_function`. With the migration absent, research still runs; only the memory writes fail, and the response reports them.
3. Leave `EDGEDESK_RESEARCH_PAID_OK` and `EDGEDESK_RESEARCH_NARRATE` off unless a person decides otherwise.

---

# Phase 3 — the intelligence engine on the website

Phase 2 built the engine. Phase 3 puts it on the Research screen a subscriber already uses. The dark theme, teal accent, gold highlight, typography and the Research / Card / Portfolio / Process / More navigation are unchanged, and no tab was added.

## 14. Why every game read "not ready"

Every NFL game on the card has a PREDICTED projection. The board, however, joins markets from **captured** prices, and paid odds retrieval has been paused since the 10 October credit exhaustion (it resumes 1 November). So:

- every game read NO MARKET;
- the board's single "research ready" counter showed 0;
- yet the research itself (projection, ratings, injuries, starters) was available for every game.

The fix is a clearer model, not lower thresholds. `lib/edgedesk_readiness.js` (EDREADY) gives each game five separate states, each with the exact reason when it is not met.

| State | Met when |
|---|---|
| Games available | the game is scheduled and has not started |
| Research available | a projection or efficiency data is on file |
| Market verified | a current captured price from a book; a reference line (no book, odds or capture time) never counts |
| Model ready | a PREDICTED projection with no data fault (LIMITED is not ready) |
| Actionable signal | on the board: its own research gate (the canonical count); in an answer: the adversarial audit's verdict |

`whyNot()` lists every unmet requirement, most basic first. The board's existing "Research ready" counter is exactly *model ready ∧ market verified*, and the panel says so. A browser test checks that the two counts are equal.

## 15. Where things are on the site

| Place | What it shows |
|---|---|
| Research → **Ask EdgeDesk AI** (top of every Research tab) | Input, the six example questions, recent questions (this browser only, per user), and the game "this game / this spread" refers to |
| Research → Football → **What can EdgeDesk research right now?** | The five counts from the board's own rows, then every game with its state dots, "Why not ready?", **Game research** and **Ask EdgeDesk AI** |
| **Game research** (a sheet over Research) | Teams, kickoff in the reader's zone, readiness, model and market spread and total (as betting lines), the disagreement, offensive and defensive EPA ratings, matchup advantages, player availability, recent games, weather and venue, sources with timestamps, three follow-up questions, and **Research with EdgeDesk AI** |
| The Desk (the existing panel) | The streamed research activity, then the answer, then each researched candidate as a card |
| **Card** | Below the Card's own decisions: every candidate EdgeDesk AI audited this session, with its status, the price checked, the net EV and the fair it used |
| **Process** | "How EdgeDesk researches": the method, model validation tiers, research verification, the audit and what "verified candidate" requires, the five states, limits and cost |
| Portfolio | Unchanged; the Phase 2 betting-history analysis stays there |

## 16. The request, and the activity it streams

The page sends this to the existing edge function, under the reader's own session token:

```
{ question, desk: true, stream: true, research_context: { game: { sport, game_id } }, intent_hint }
```

Research questions come back as NDJSON:

- an `accepted` line;
- one `progress` line per real step as it happens, never on a timer;
- then a `result`, an `error` or a `fallback`.

| Stage | Label |
|---|---|
| FIND_EVENTS | Finding relevant events |
| COMPARE_PRICES | Comparing market prices |
| RETRIEVE_STATS | Retrieving statistics |
| VERIFY_INJURIES | Verifying injuries and lineups |
| CALCULATE | Calculating probabilities |
| AUDIT | Running the adversarial audit |
| EXPLAIN | Preparing the explanation |

Partial results also stream before the answer: the games found, and the first audit verdicts. Every non-research question still gets plain JSON. Settled behaviour:

- **Cancel** aborts the request, and the server stops at its next step.
- A **60-second limit** aborts too.
- **Errors**: 429 is the daily allowance, 401 is signed out, 402/403 is the subscription (a link to manage it; nothing is charged), and 5xx is the service. Each keeps the finished steps on screen and offers **Try again**.
- **A provider fails mid-research** (for example the live injury feed): the step and the answer both say what failed and what was used instead.
- The game travels as `research_context.game`, never as team names in the text, so a follow-up from a game view needs no retyping and cannot be diverted to another route.

## 17. What every number on the cards is

A card's figures are the server payload's, never recomputed by the page:

- price, book and age;
- fair probability and its kind;
- break-even, net EV and maximum price;
- model reliability;
- the disagreement explanation, matchup advantage, counterargument and invalidators;
- the audit verdict.

Note: the board's model spread is computed live in the browser, while EdgeDesk AI researches the nightly build. When the two differ by half a point or more, the game view shows both, named. A candidate's "why the model disagrees" names the line it used (the pricing line, i.e. the projection blended toward the market), so it is not read as the game's raw projection gap.

The Card's own decisions price on EdgeDesk's NFL pricing blend, while an audited candidate may price on the sharp no-vig fair. The research block therefore names the fair beside every EV.

## 18. Server changes made for the website

- **New routes**:
  - `READINESS` (five states per game; nothing bought or audited);
  - `GAME_RESEARCH` (one game, from its context);
  - `MATCHUP_EDGE` (offense rating plus the opposing defense rating; scoped to the open game when asked "in this game");
  - `VENUE_COMPARE` (what is on file per venue; no price invented, no fee rule borrowed).
- **Window**: a readiness or slate question that names no day reads the next seven days (the football card's window), not "today". "This game / this spread" with no game open says so and covers the card.
- **Streaming**: the Research screen's own words (research, researched, verified, audited…) no longer count as team names, so "What's the best researched opportunity tonight?" streams.

## 19. Tests

| Suite | What it proves |
|---|---|
| `tools/intelligence/research_host.test.js` (Phase 3 part) | Every example question reaches its route through the full handler. It also covers: the stream's order, partial results, cancel, plain JSON for the rest, the game-scoped mismatch, and dumps the streams the browser suite replays |
| `tools/intelligence/intel_ui.e2e.js` | Chromium at 390×844 and 1280×900, browser clock pinned to the handler's, replaying the real handler's streams. Covers the ten flows, the figures against the engine's JSON, readiness against the canonical counter, the game view, Card and Process, and every failure path |
| `tools/intelligence/quant_ui.e2e.js` | The Phase 2 answers, now as cards, still carry every Phase 2 field |
