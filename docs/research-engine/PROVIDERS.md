# Research providers — comparison, costs and terms (researched 12 Oct 2026)

A personal Claude or Perplexity subscription does **not** grant API access. Each provider below needs its own API account, key and billing, owned by the operator.

Prices are from the providers' published pages where those could be reached from the build environment. Anything else is marked "secondary" and must be checked before budgeting.

## 1. Comparison

| Provider | What it returns | Price (USD) | Citations | Verified here? | Terms to note | Role in EdgeDesk |
|---|---|---|---|---|---|---|
| **Claude API — `web_search` server tool** | Claude's answer with **citations** (`url`, `title`, `cited_text` ≤ 150 chars quoted from the page) plus the result list (`url`, `title`, `page_age`) | **$10 / 1,000 searches** + tokens. Opus 5.5 $4 / $20 per MTok, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 (official pricing page) | yes, always on, with a verbatim quote | **yes**: request and response shapes from the official tool documentation | Anthropic Commercial Terms. When API output is shown to end users, **citations to the original source must be shown**. `allowed_domains` restricts search to listed sites. | **Deep adapter** (`claude_web_search`): current reporting a dataset cannot hold, restricted to official and credible domains |
| **Claude API — Messages (no tools)** | text | as above | n/a | yes (already used by `callModel`) | as above | Optional narration over verified numbers (existing, off by default) |
| **Perplexity Search API** | raw results: `title`, `url`, `snippet`, `date`, `last_updated` | **$5 / 1,000 requests**, no token charge (official pricing page as quoted by search results; a multi-query request bills as one) | URL per result; the snippet is the provider's extract | **no**: `docs.perplexity.ai` does not resolve from the build environment, so the adapter follows the publicly described schema | Perplexity API terms. **The Sonar chat-completions endpoint was retired on 27 Sep 2026** in favour of the Agent API (pricing page, community moderator); not used here. | **Low-cost adapter** (`perplexity_search`): results become *external reports*, parsed deterministically, never a confirmed fact |
| Perplexity Agent API | synthesised answer with citations | per-token, model-dependent (not researched further) | yes | no | replaces Sonar | not used: synthesised prose is a second model in the loop; Claude web search covers that role with verifiable quotes |
| Brave Search API | raw results | $5 / 1,000 requests (secondary; free tier removed Feb 2026) | URL per result | no | AI-inference rights depend on plan | listed in the ledger as an alternative; not wired |
| Exa | results + page contents | $7 / 1,000 (with contents for 10 results) (official changelog, Mar 2026) | URL | no | — | not wired |
| Tavily | results | ≈ $5–8 / 1,000 basic, ×2 advanced (official docs; Nebius acquisition announced Feb 2026) | URL | no | terms may change post-acquisition | not wired |
| nflverse (injuries, depth charts, schedules) | CSV / JSON | free, keyless | URL of the release file | yes (in use) | Package code MIT. The data "belong to their respective owners and are governed by their terms of use"; the injury and depth-chart data are sourced from ESPN. **Licensing risk for a paid product.** | kept (official-report tier) |
| open-meteo | forecast JSON | free API **non-commercial only**, < 10,000 calls / day (official terms, CC-BY 4.0). Commercial plans were $29 / $99 per month in 2025 (official blog). | URL | yes (in use) | **The free tier does not permit commercial use. EdgeDesk is a paid product: an existing licensing risk.** | kept, flagged: move to a commercial plan or drop |
| MLB Stats API (`statsapi.mlb.com`) | JSON | free, keyless | — | — | No published terms found; responses carry an MLBAM copyright notice; commercial use unconfirmed | **not added** |
| The Odds API (market data) | odds | $30/mo 20K credits · $59/mo 100K · higher tiers (official site, cached) | — | partly | credit = markets × regions per call | market data — see `ODDS_RECOVERY.md`; **not re-enabled** |

## 2. Recommendation

1. **Keep every question on a $0 path unless it truly needs current reporting.** The orchestrator decides. Most questions — prices, projections, readiness, mismatches, one game's research — are answered from stored data and free official feeds.
2. **Deep adapter: Claude `web_search`**, restricted by `allowed_domains` to the official and credible list in `lib/edgedesk_providers.js`. It is chosen because:
   - each citation carries a verbatim quote, so every claim can be checked against its quote;
   - the shape is verified;
   - the same vendor and transport are already in the edge function;
   - results are search-grounded by the API, not by a scraper.

   The model is configurable (`EDGEDESK_RESEARCH_MODEL`), default `claude-opus-5-5`. A cheaper model is the owner's choice: Sonnet 5.5 roughly halves the token part of the cost, while the search fee is the same.
3. **Low-cost adapter: Perplexity Search API**, for raw result lists. Snippets are external reports, parsed deterministically. Use it when cost matters more than reading the page. The schema must be confirmed with a live key before relying on it (`tools/research/providers_live.js`).
4. **Do not add** a provider whose terms cannot be confirmed for commercial use (MLB Stats API). **Fix the existing open-meteo licence** before scaling.

All adapters stay off until the operator sets every one of:

- the secret (`ANTHROPIC_API_KEY` already exists for narration; `EDGEDESK_PERPLEXITY_API_KEY` for Perplexity);
- `EDGEDESK_SEARCH_PROVIDERS` naming the provider (`claude_web_search`, `perplexity_search`, or both, comma-separated);
- `EDGEDESK_RESEARCH_PAID_OK=1`;
- the provider's `research_provider_quota.enabled = true` (the row is added disabled by `supabase/research_engine.sql`); every real call claims this persistent quota (`research_usage_claim`) first and settles it after;
- **Perplexity only:** `EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED=1`, set only after `tools/research/providers_live.js perplexity` reports `schema check PASS` with a live key.

Search runs only on deep (L3) research turns. It goes through the research ledger, which supplies:

- per-provider daily, monthly and per-subscriber quotas;
- a circuit breaker after three consecutive failures;
- one search per game, shared by every candidate on it (cache and single flight);
- a timeout.

The dollar budget (`research_budget_policy`) caps the worst case regardless.

## 2a. How a search result becomes evidence (`lib/edgedesk_providers.js`)

- **Only the source's own words become a finding**, each with the URL it came from.
  - Claude: each citation's `cited_text` (≤ 150 characters quoted from the page). The model's sentence is kept beside it as `model_summary` and is never the claim.
  - A sentence with no citation is the model's own and is discarded.
  - A citation is **refused** when:
    - its URL is not among the search results actually returned;
    - its domain is not on the allowed list;
    - it carries no quote.
  - A model sentence that claims more than its quote (a status or a name the quote lacks) is flagged `summary_beyond_quote`.
- **Perplexity snippets are capped at an external report** (`CREDIBLE_JOURNALISM`), even from an official domain, because whether a snippet is the page's own wording is not verified. Claude citations are classed by their domain like any source.
- Names are matched only against players the run's own feeds already list; nothing is guessed.
- A page with no publication date is **undated**: its freshness is `UNKNOWN`, never "fresh because it was retrieved just now".
- Every quote passes the evidence layer's prompt-injection screen. A flagged quote becomes an unverified hypothesis.
- **A single credible report of a key absence is never priced on.** It becomes a `REPORTED_ABSENCE_UNCONFIRMED` gap that holds the verdict at RESEARCH REQUIRED until an official report confirms or denies it. The challenge pass calls it critical when it concerns the priced starting quarterback.
- Search errors are reported with their documented code: `too_many_requests`, `max_uses_exceeded`, `request_too_large`, … A request that is too large may mean the domain list is too long.
- On `stop_reason: refusal` the provider is reported as declined.
- On `pause_turn` the turn is resumed **once**, sending the paused assistant turn back unchanged; both calls are costed.
- In every failure case the research continues on EdgeDesk's own sources.
- The actual cost is read from each response's `usage`:
  - tokens at list price;
  - plus $0.01 per search;
  - reported per row and in the research summary;
  - counted once per search (a cached reuse costs nothing).

## 3. Estimated cost per research request

These are estimates, not measurements: no live provider call was made from this environment. The token counts are assumptions, listed.

| Path | Assumptions | Cost per request |
|---|---|---|
| DATABASE / ENGINE / free research | Supabase reads within the plan; keyless feeds | **$0** external |
| Perplexity Search API | 2 requests, deterministic parse, no model | **$0.010** |
| Claude web search, Opus 5.5 | 3 searches ($0.03) + ~10K input ($0.040) + ~700 output ($0.014) | **≈ $0.084** (range $0.05–0.13 with result size) |
| Claude web search, Sonnet 5.5 | 3 searches ($0.03) + 10K in ($0.020) + 700 out ($0.007) | **≈ $0.057** |
| Claude web search, Haiku 5.5 | 3 searches ($0.03) + 10K in ($0.001) + 700 out ($0.0004) | **≈ $0.031** (the search fee dominates) |
| Optional narration (existing desk model `claude-sonnet-5`) | ~2.5K in + 500 out | ≈ $0.010 |

## 4. Monthly operating cost scenarios

Assumptions:

- 30% of questions are investigations;
- half of those need current reporting, so **15% of questions use a search adapter**;
- everything else is $0 external.

| Scenario | Questions / month | Search-backed | Perplexity | Claude web search (Opus 5.5) | Claude web search (Sonnet 5.5) |
|---|---|---|---|---|---|
| 200 subscribers × 5 / day | 30,000 | 4,500 | ≈ $45 | ≈ $378 | ≈ $257 |
| 1,000 subscribers × 5 / day | 150,000 | 22,500 | ≈ $225 | ≈ $1,890 | ≈ $1,283 |

**The worst case is set by the budget, not the traffic.** With the defaults in `research_budget_policy`, spend cannot exceed **$20 / day ≈ $600 / month** across all subscribers:

- $0.25 per request;
- $1.00 per subscriber per day;
- $20 per day globally.

Change those rows to change the ceiling.

## 5. What is verified, and what is not

| Item | Status |
|---|---|
| Claude web search request/response shape | **verified** against the official documentation (re-read 2026-10-12: `web_search_20260209`, `allowed_callers: ["direct"]` for direct calls, `allowed_domains`, `max_uses`, the result/citation/error shapes, `pause_turn`) |
| Claude pricing | **verified** against the official pricing page |
| Perplexity Search API schema | **unverified**. The official docs are blocked by the build environment's egress proxy (HTTP 403, 2026-10-12). Third-party descriptions disagree on the result limit and the domain-filter field. The adapter parses only `results[].title/url/snippet/date`, and the edge function refuses to call it until `EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED=1` |
| Test fixtures (`tools/research/fixtures/*.json`) | **constructed** from the documented shapes and labelled so in each file; none is a recorded live response |
| Perplexity, Brave, Exa, Tavily, The Odds API prices | from official pages where quoted by search, otherwise secondary sources (marked in §1) |
| Live provider calls | **none were made.** CI uses fixtures. `tools/research/providers_live.js` runs real calls only with keys and `EDGEDESK_LIVE_PROVIDERS=1`, and has not been run. |

## Sources

- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) and [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) (official)
- [Perplexity pricing](https://docs.perplexity.ai/guides/pricing) (as quoted by search); [Sonar → Agent API migration](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar); [community: Sonar moving to Agents API](https://community.perplexity.ai/t/sonar-moving-to-agents-api/6061); [Search API pricing clarity](https://community.perplexity.ai/t/perplexity-search-api-pricing-clarity/5682)
- [Brave Search API pricing (CostBench, secondary)](https://costbench.com/software/ai-search-apis/brave-search-api/); [Exa pricing update](https://exa.ai/docs/changelog/pricing-update); [Tavily API credits](https://docs.tavily.com/documentation/api-credits)
- [The Odds API](https://the-odds-api.com/)
- [Open-Meteo terms](https://open-meteo.com/en/terms); [Open-Meteo commercial subscriptions](https://openmeteo.substack.com/p/api-subscriptions-for-commercial)
- [nflreadr (CRAN)](https://ftp.fau.de/cran/web/packages/nflreadr/index.html); [MLB Stats API wrapper notes (PyPI)](https://pypi.org/project/python-mlb-statsapi)
