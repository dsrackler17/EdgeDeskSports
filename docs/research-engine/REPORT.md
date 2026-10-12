# Research engine — benchmark, cost and performance report

**Branch `claude/research-intel` (draft PR #553). Nothing here is merged or deployed.**

Every figure below comes from the benchmark in `tools/research/benchmark/`. It drives the real edge function (`handle(Request)`: bearer, rate limit, subscription gate, usage allowance, routing) against fixture networks, with **recorded responses only**.

**What it measures:**
- routing;
- whether each answer did what the question needs;
- citation validity;
- quantitative correctness;
- unsupported claims;
- local latency;
- cost estimated from the requests the handler actually built.

**What it does not measure:**
- the quality of a model-written reply: the reply is a fixed recorded string;
- live provider behaviour;
- production latency.

Those need the separately controlled live checks (§8).

## 1. Summary

- **107 questions in 10 categories**, through the full handler. After this stage's fixes, **every item meets its expectations**. That covers the route it needs, the facts it must state, and what it must never say.
- **0 invented links** among the 121 links shown to a subscriber:
  - 72 were served to the handler by the fixture network;
  - 49 are documented provenance links (§3).
- **Quantitative:** 53 of 53 engine answers are `VERIFIED`.
  - 695 calculation records were recomputed independently, with 0 mismatches.
  - 481 numbers in answers were traced to a calculation, with 0 unsupported.
- **Unsupported claims:** 0 certainty words, 0 invented prices, and 0 actionable verdicts where the evidence forbids one.
- **The first run found real defects** (§4). 33 of 106 items failed: some through wrong expectations of mine, the rest through defects in the engine and the existing desk. The defects are fixed and covered by tests.
  - The biggest: an NFL player's status was answered by the model with an **MLB** context packet.
  - "Best Premier League bet this weekend?" returned **an NFL pick**.
- **Cost moved the right way.** On the benchmark's mix, model calls fell from 46 to 22 and estimated model spend from $2.04 to $0.92. Questions the model was answering without the right evidence (player status, unsupported sports, schedules, guarantees) now get model-free answers from EdgeDesk's own data.

## 2. How the benchmark works

| Part | What it does |
|---|---|
| `harness.js` | Loads `supabase/functions/edgedesk_ai/index.ts` with a Deno shim. It pins the clock to Monday 2026-10-12 16:00 UTC, asks every question as the website does (`stream: true`), and replaces the network. **Supabase and the published artifacts:** the intelligence fixture router (the committed NFL and FBS slates, metrics, validation), plus captured prices, per-book quotes, an MLB card and desk notes written per scenario. **`api.anthropic.com`:** a fixed recorded reply (`RECORDED REPLY (benchmark fixture) …`), or the constructed web-search fixture for search scenarios. **The odds API, capture and the gateway:** any call throws, and the run counts it. |
| Scenarios | `base`, `no_odds`, `nfl_only`, `mlb_only`, `stale` (prices 400 min old), `conflict_qb` (official OUT vs credible ACTIVE), `conflict_goff` (two credible reports disagree), `starter_change_mlb` (scratched starter), `all_rejected`, `injury_feed_down`, `db_down` (price read fails), `metrics_down`, `model_down` (Anthropic 503), `cfb_outlier` (a 7+ point model/market gap), plus search on (fixture) and search failing (HTTP 529) |
| `questions.js` | 107 items in 10 categories. Each states its route, what the answer must contain (`has`), what it must never contain (`not`), whether it may be actionable, the verification verdict it must reach, and, for model-desk items, the evidence the model must be handed (`grounded`). |
| `run.js` | Scores every item and writes `docs/research-engine/benchmark_results.json` (the summary plus one line per item). |
| `tools/intelligence/benchmark.test.js` | Runs in CI (`intelligence-ci.yml`). It asserts invariants, not tuned scores: ≥ 100 questions in 10 categories with ≥ 10 each; no unexpected failure (a documented *known gap* is allowed only while it still reproduces); 0 invented links; every engine answer verified with 0 unsupported numbers; 0 certainty words or invented prices; no odds request; model-free routes never call the model; local p95 under 3 s. |

**Two fixture-fidelity fixes the benchmark forced:**
1. The MLB card and schedule are read for yesterday, today and tomorrow only (`Dal.getMlbCard`). The router now honours the requested dates, so the benchmark's MLB game sits tomorrow evening. An earlier version served a Saturday game production could not hold.
2. Two copies of the edge function in one process rewire each other through the kernels' global look-ups. Production runs one module per isolate. The runner now runs every base item before it creates the search-enabled instance. A "desk names value the engine rejects" result in the first run came from this artifact, not from the product.

## 3. Results

**107 questions in 10 categories**, through the real handler with recorded responses (clock 2026-10-12T16:00:00.000Z).

| Measure | Result |
|---|---|
| Routing accuracy | 100% |
| Expectation accuracy (every check on the item held) | 100% |
| Citation validity (links the subscriber sees that the handler was actually given) | 100% of 121 (72 served to the handler, 49 provenance links to the upstream source of an EdgeDesk build); 0 invented, 0 refused citations used |
| Quantitative correctness | 53 of 53 engine answers VERIFIED; 695 calculation records recomputed, 0 mismatches; 481 numbers in answers traced, 0 unsupported |
| Unsupported claims | 0 certainty words; 0 numbers without a calculation; 0 invented prices; 0 actionable verdicts the evidence forbids |
| Latency (local, fixture network) | p50 39.4 ms · p95 77.6 ms · max 167.9 ms |
| Cost | 22 model calls on 22 questions ≈ $0.9150 (estimated from the requests built); 2 search calls, $0.0722 |

| Category | Questions | Routed correctly | Every check held |
|---|---|---|---|
| factual | 12 | 12 | 12 |
| complex | 12 | 12 | 12 |
| missing odds | 10 | 10 | 10 |
| conflicting injuries | 10 | 10 | 10 |
| stale data | 10 | 10 | 10 |
| missing players | 10 | 10 | 10 |
| misleading stats | 10 | 10 | 10 |
| disagreement | 10 | 10 | 10 |
| provider failures | 13 | 13 | 13 |
| unanswerable | 10 | 10 | 10 |

| Route | Questions | p50 ms | p95 ms | Model calls | Model $ (est.) | Search calls | Search $ |
|---|---|---|---|---|---|---|---|
| AVAILABILITY | 13 | 48.6 | 117.1 | 0 | 0.0000 | 0 | 0.0000 |
| CONTRACT | 2 | 121.8 | 121.8 | 0 | 0.0000 | 0 | 0.0000 |
| COVERAGE | 1 | 3.5 | 3.5 | 0 | 0.0000 | 0 | 0.0000 |
| DESK | 10 | 26.7 | 34.7 | 7 | 0.0461 | 0 | 0.0000 |
| GAME_RESEARCH | 21 | 43.7 | 77.6 | 0 | 0.0000 | 2 | 0.0722 |
| MATCHUP_EDGE | 2 | 7.2 | 7.2 | 0 | 0.0000 | 0 | 0.0000 |
| MODEL_DESK | 15 | 35.9 | 108.6 | 15 | 0.8689 | 0 | 0.0000 |
| READINESS | 3 | 39.6 | 76 | 0 | 0.0000 | 0 | 0.0000 |
| RESEARCH_SLATE | 14 | 45.3 | 66.2 | 0 | 0.0000 | 0 | 0.0000 |
| SCAN | 15 | 53.6 | 74.2 | 0 | 0.0000 | 0 | 0.0000 |
| UNSUPPORTED | 11 | 1.4 | 2.1 | 0 | 0.0000 | 0 | 0.0000 |

**The provenance links** are data that reached the handler through one of EdgeDesk's own builds, cited at the upstream location:
- the nflverse depth-chart CSV, which `football/starters/build_starters.js` reads to build `metrics.json`'s starters;
- MLB's probable-pitcher listing for the card's date. The card (`mlb_game_cards`) is filled outside this repository, so this is a link where the reader can check the claim. The evidence now says so: "MLB probable pitchers (via EdgeDesk's MLB card)".

## 4. What the first run found, and what changed

**First full run:** 73 of 106 items met their expectations, with 71.7% routed as expected.
- About 10 failures were my own wrong expectations, corrected after reading the answers. For example, a schedule question was expected to reach the model desk; it should be answered from the card.
- The rest were defects:

| # | Defect (category) | Fix | Where |
|---|---|---|---|
| 1 | "Is Josh Allen playing Sunday?", "What is the injury status of …", "Will … play against the Lions?" went to the model desk, which was handed an **MLB** packet. The orchestrator's plan had no players to resolve. (conflicting injuries, missing players) | **AVAILABILITY** route. It finds the player in the injury build, the depth chart or the desk's notes. It runs the same game research the game view runs, then answers model-free: the status, each source's own words with its time and freshness, any conflict named and never settled by guesswork, and the engine's own QB-out re-run labelled as a model re-run. A player EdgeDesk holds nothing on is said to be unknown and given no status. Also covers "Who starts at QB for the Bills?" and "Who is pitching for the Rays tomorrow?". | `index.ts` `availabilityTurn`; `EDORCH` route `AVAILABILITY`; `edgedesk_intel_ui.js` `availabilityHTML` |
| 2 | The plan's `UNSUPPORTED` path was never enforced: season outcomes, guarantees and uncovered sports reached the model, and **"Best Premier League bet this weekend?" was answered with an NFL pick**. (unanswerable, misleading statistics) | `outOfScopeTurn`, before every route, desk and model. It covers an uncovered sport with no covered one named, a season-long outcome with no game named, and a demand for a guarantee. "Across all sports" stays a scan. "Who will win Lions at Bills?" still reaches the desk. | `index.ts` `outOfScopeTurn`; `edgedesk_intel_ui.js` `unsupportedHTML` |
| 3 | "When do the Lions play the Bills?" was answered with a **price verdict on Lions +2.5**. (factual) | The desk answers schedule questions with the kickoff on its card, model-free. | `index.ts` `deskTurn` (`DESK_SCHEDULE`) |
| 4 | The desk's rewrite critic only checked the numbers in the first sentence. For an answer opening "No.", it passed a rewrite that dropped the verdict, the side and the price. (factual) | The headline extends past a bare verdict, and the teams it names must survive (a nickname counts). | `_desk.js` `critic` |
| 5 | The desk read "53% chance" as a total of 53 and "an edge *over* a coin flip" as the totals market. (misleading statistics) | Percentages and ¢ prices are not lines. "Over"/"under" name the total only as a bet ("Over 49.5", "the over"). | `_desk.js` `parseNumbers`, `detectMarket` |
| 6 | When the price read failed, coverage said "games but no captured prices". (provider failures) | `RETRIEVAL_FAILED`: "the captured prices could not be read". | `index.ts` `sweepBoard` → `refineCoverage` |

**Every fix is covered:**
- the benchmark items;
- `research_host.test.js` (+17 handler checks, including namesakes and the two switches);
- `desk.test.js` (+6 critic and parsing checks);
- `intel_ui.e2e.js` (+7 phone and desktop checks, with screenshots `05d-availability-*` and `05e-unsupported-*`).

The full regression is green: every suite in `intelligence-ci.yml`, plus the props, linemaker, site and app suites that load the edge function.

## 5. Findings left open (owner decisions)

1. **Single-sport best-bet questions go to the existing desks, not the research engine.**
   - "What's the best NFL bet this weekend?" is answered by the football desk: the model line against the market line, with its validated LEAN tier, price ladder and confidence.
   - "What's the best MLB bet this week?" is answered by the MLB board.
   - Neither runs the Phase 4 challenge pass or the calculation ledger.
   - "…across all sports" and "Analyze every NFL game" do run them.
   - On the benchmark's fixtures the two paths agree (the all-rejected scenario: both say nothing qualifies). Routing single-sport questions through the engine would change answers subscribers already get, so it is left for your decision.
2. **The MLB packet covers yesterday, today and tomorrow only.** It is fine for MLB's daily cadence; a question about a game three days out gets no probable starters. AVAILABILITY says so rather than guessing.
3. **Off-topic questions reach the model desk.** "What is the capital of France?" claims a PRO research unit and sends the full research packet (≈ 20K input tokens). A cheap off-topic guard would save that. Not built: the line between off-topic and conversation is a product choice.
4. **The full model desk sends large requests.** Its average estimated input was ≈ 20,600 tokens (median 18,000, max 27,600) for questions like "How accurate is the NFL model?". This is the existing pipeline's packet. Trimming it is a separate, measurable cost project.

## 6. Cost

**Prices.** These are published per-token prices:
- `claude-sonnet-5` (the existing desk model): $2 / $10 per million tokens. The Claude models overview lists Sonnet 5.5 "at the same prices" as Sonnet 5.
- Opus 5.5 / Sonnet 5.5 / Haiku 5.5: `lib/edgedesk_providers.js` `PRICES_PER_MTOK`.
- Search fee: $10 per 1,000 searches.

**Method.** The benchmark estimates input tokens as the characters in the request ÷ 4, and output at the request's `max_tokens` ceiling, so the figures are upper-leaning.

| Path | External cost per question | Basis |
|---|---|---|
| Engine routes (scan, slate, game research, readiness, mismatches, contract, coverage) | **$0** | Supabase reads and published artifacts only |
| AVAILABILITY, UNSUPPORTED, desk schedule | **$0** | model-free |
| Desk answer with optional model rephrase (`EDGEDESK_DESK_NARRATE`, on by default) | **≈ $0.0066** | ≈ 290 input tokens + 600 output cap |
| Full model desk (existing pipeline) | **≈ $0.058** | ≈ 20,600 input + 1,200 output cap (mean of 15 benchmark questions) |
| Claude web search (when the operator enables it) | **≈ $0.084** estimated, **$0.0722** from the fixture's recorded usage | 3 searches + ~10K in + ~700 out at Opus 5.5 (`PROVIDERS.md` §3); the fixture is constructed, not a live response |
| Perplexity Search API (gated until its schema is verified) | ≈ $0.010 | 2 requests (`PROVIDERS.md` §3) |

**Illustration, not a forecast.** 200 subscribers × 5 questions a day is 30,000 questions a month. Suppose the full model desk took 14% of them (its share of this benchmark, which over-represents edge cases): 4,200 × $0.058 ≈ **$245 / month** of model spend. At the first run's 33% share it was ≈ **$575**. Measure the real share from the `research_turn` logs and the usage table before relying on either.

Paid search stays off. When enabled, `research_budget_policy` caps spend at:
- $0.25 per request;
- $1 per subscriber per day;
- $20 per day globally (≈ $600 / month);

whatever the traffic (`PROVIDERS.md` §4).

**Market data** is planned separately in credits, not dollars (`ODDS_RECOVERY.md`). The recommended mix is +3,562 credits per 30 days, 64% of the 60,000 operational ceiling, and nothing is re-enabled.

## 7. Performance

On this machine, against the fixture network with recorded model replies (`latency_ms` in the results):
- **p50 39 ms, p95 78 ms, max 168 ms per question.**
- The model-free routes:
  - UNSUPPORTED: about 2 ms;
  - availability: about 40 ms;
  - a full game research: about 45 ms;
  - a cross-sport scan: about 56 ms.

These measure EdgeDesk's own compute, not production. Production adds:
- Supabase and artifact reads, typically tens to hundreds of ms each;
- the model's own latency on the model desk: seconds (the orchestrator estimates 6 s);
- search latency when enabled (`PROVIDERS.md`).

None of these was measured here.

## 8. What was not verified, and how to verify it

- **Model reply quality.** Every model reply in the benchmark is the same recorded string. Its routing and its grounding (`grounded`: the evidence in the request) are measured; its accuracy is not.
- **Live providers.** No live call was made from this environment. `tools/research/providers_live.js` runs real Claude web search and Perplexity calls only with keys and `EDGEDESK_LIVE_PROVIDERS=1`; it has not been run.
- **Production latency and route mix.** These come from the `research_turn` structured logs (`researchLog`) after deployment.

## 9. Running it

```bash
# the benchmark, with every item's outcome
node tools/research/benchmark/run.js --discover
# the committed results and this report's section 3
node tools/research/benchmark/run.js --json docs/research-engine/benchmark_results.json --md /tmp/bench.md
# the CI test (invariants)
node tools/intelligence/benchmark.test.js
```

Node 22.18+ strips types by default. On an older Node, add `--experimental-strip-types --no-warnings`.
