# Content engine AI cost control

**The content engine has its own budget: $10 a month by default.** Other AI
products' budgets are not read or changed. No subscription, search API or
enrichment product was added. The engine reuses the existing provider and
model (Claude through the official SDK in the Edge Function, and raw HTTPS in
the weekly job).

**There is one AI ledger:** `content_engine.ai_calls`, section 6d of
`supabase/content_engine.sql`. Every host that calls Claude goes through it:
the Edge Function's "Rewrite with AI" and the weekly job (`tools/content/run.js
aiPass`). An earlier draft of this work carried a second ledger
(`ai_months`/`ai_spend`). It was replaced by this one before it ever reached
production.

## How a Claude call is paid for

1. **Fingerprint.** The request is hashed with SHA-256
   (`CE.ai.requestKey`: the model, the system prompt, the messages, the output
   budget and the schema). The same request always gives the same hash.
2. **Reserve** (`content_engine_ai_reserve`), before any token is spent.
   - **Served from the ledger:** an identical request answered in the last 30
     days, accepted or discarded, is returned without a call and costs nothing.
   - **In flight:** an identical request still reserved is refused, so it is
     never paid for twice.
   - **One lock for every reservation in the project**, so concurrent calls
     cannot pass the cap together.
   - **The worst case is held:** `CE.ai.inputEstimate`, which is about three
     characters per token, plus the full `max_tokens`, at the model's list
     price. An unlisted model is priced at the dearest listed one.
   - **The daily call cap** (`llm_calls_per_day`) still applies.
   - **Alerts** are logged at 50, 75 and 90%. At 100%, generation is refused
     with the reason.
3. **Call.** The weekly job makes one retry, after a pause, and only for an
   overloaded or rate-limited API, inside the same reservation.
4. **Settle** (`content_engine_ai_settle`) with the usage the API returned.
   - Input, output and cache tokens are priced at list price.
   - A fallback is priced per attempt, at the model that ran it.
   - The settlement replaces the reservation with an **estimate**. An error
     with no usage costs nothing. A timeout keeps the reservation as the
     estimate, because it may have been billed.
5. **At the cap**, AI generation stops. The deterministic draft, review,
   exports and sending never depend on it.

**Estimated is not billed.** The owner enters the invoice under Performance →
*Record a cost* (`content_engine.costs`, append-only). The scorecard then uses
the billed amount.

## What a call can cost (reservation, at the default model's $4 / $20 list prices)

| Request | Input estimate | Output budget | Worst case held |
|---|---|---|---|
| Week 6 CFB preview, full draft | 25,026 tokens | 16,000 | $0.42 |
| Week 6 CFB preview, one section | 22,872 tokens | 6,000 | $0.21 |
| Five Games to Watch, full draft | 24,063 tokens | 16,000 | $0.42 |
| Five Games to Watch, one game's section | 6,135 tokens | 6,000 | $0.15 |

Settled costs are lower: medium effort writes far less than the full output
budget. A rejected Five Games to Watch draft whose failures name one or two
games is rewritten **only in those games' sections**, at most three calls in
all. Every call is reserved and settled like any other. The calls made for a
draft are named on its `article_created` event, so
`content_engine_template_report` shows each template's generation cost.

## Settings (owner only, `/admin/content/` → Settings → AI budget)

- **Monthly AI budget:** $10.00 by default. The page asks before raising it.
  The database accepts 0–1000.
- **List prices** (`ai_prices`): labelled estimates; edit them when list prices
  change.

Every change is logged.

## Tests

- `tools/content/content_engine_sql.test.js`:
  - AB: the worst-case reservation, the cap, the eight-way race, the cache, settlement, fallback pricing, the daily cap;
  - B: an identical request in flight is refused.
- `tools/content/content_engine_fn.test.js`: the Edge Function reserves, calls and settles through the ledger.
- `tools/content/run.test.js`:
  - the weekly job's calls are reserved and settled;
  - a draft names the ledger rows it cost;
  - the local example makes no unmetered call.
- `tools/integrity/regression.test.js` cases 14 and 15:
  - no duplicate charge, in flight or answered;
  - two concurrent jobs cannot pass the cap;
  - only the owner changes it.
- `tools/content/games_to_watch.test.js`:
  - the reservation bounds above;
  - a template's cost counted from the ledger.
