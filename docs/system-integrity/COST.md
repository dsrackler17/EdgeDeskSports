# Content engine AI cost control

**The content engine has its own budget: $10 a month by default.** Other AI
products' budgets are not read or changed. No subscription, search API or
enrichment product was added. The engine reuses the existing provider and
model (Claude through the official SDK in the Edge Function, and raw HTTPS in
the weekly job).

## How a Claude call is paid for

1. **Fingerprint.** The request is hashed with SHA-256 (`CE.cost.requestKey`):
   - the model;
   - the article version, or the opportunity and its research hash;
   - the section;
   - the full prompt.

   The same request always gives the same key.
2. **Reserve** (`content_engine_ai_reserve`), before any token is spent.
   - It takes the month's row lock, so concurrent calls queue and are checked
     against every other reservation, committed or in flight.
   - It refuses with a reason the owner reads:
     - **duplicate**: this exact request was already made and paid for;
     - **in flight**: one call per article and purpose at a time;
     - **retry limit**: two attempts per request by default;
     - **monthly budget exhausted**;
     - **job budget exhausted**: $2 per weekly run by default.
   - The reservation is an **upper bound** (`CE.cost.estimate`):
     - input at one token per three characters;
     - output at the full `max_tokens`;
     - the same again at the dearest fallback model's price, because a policy
       decline can be billed and then re-run on the fallback.
3. **Call.**
   - The SDK's own retries are off (`maxRetries: 0`): an SDK retry would be a
     second billed attempt the reservation never saw.
   - The daily call counter (`content_engine_spend`) still applies on top.
4. **Settle** (`content_engine_ai_settle`).
   - The cost is measured from the token counts the API reports
     (`CE.cost.measured`):
     - input, output, cache read and cache write tokens, at list prices;
     - with a fallback, each attempt is priced at the model that ran it
       (`usage.iterations`).
   - Special cases:
     - a reply with no usage is charged at the estimate;
     - an error the API answered with is released, not charged;
     - no answer at all (a timeout, a dropped connection) is charged at the
       estimate, because it may have been billed;
     - a reservation nobody settles within 30 minutes is charged at its
       estimate, never released;
     - a call that cost more than its estimate is counted in full and logged
       (`ai_estimate_exceeded`) so the estimator gets fixed.
5. **At the cap**, discretionary generation stops. The deterministic draft
   still works, with nothing bought or upgraded.

## Prices (USD per million tokens, Anthropic first-party list, 2026-10)

| Model | Input | Output | Cache read | Cache write (5 min) |
|---|---|---|---|---|
| claude-opus-5-5 (the engine's model) | 4.00 | 20.00 | 0.20 | 5.00 |
| claude-opus-5 / claude-opus-4-8 (the fallback targets) | 5.00 | 25.00 | 0.50 | 6.25 |
| claude-sonnet-5-5 | 2.00 | 10.00 | 0.20 | 2.50 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 |
| any other model | 10.00 | 50.00 | 1.00 | 12.50 (the ceiling: never counted cheaper than it might be) |

The table is `CE.cost.PRICES` in `lib/content_engine.js`. Update it when list
prices change. Provider invoices are not imported, so `billing_source` says
whether a row's cost came from token counts (`usage_tokens`) or the estimate
(`estimate`).

**What a draft costs.** The Week 6 CFB preview's full-draft request is 66,849
characters: about 17K input tokens. With about 4–8K output tokens (medium
effort) it costs roughly **$0.15–$0.23** at Opus 5.5 prices. A one-section
rewrite sends the same input but returns less.

The reservation for a full draft is **$0.93**, settled down to the measured
cost after the call. $10 covers about 40–65 full rewrites a month. Near the
cap, the last ~$0.93 cannot be reserved: that is the price of a hard cap. The
deterministic draft costs nothing.

## Settings (owner only, `/admin/content/` → Settings → AI spend)

| Setting | Default | Range |
|---|---|---|
| Monthly cap | $10.00 | 0–50. Raising it above $10 asks for confirmation; the database refuses without it. |
| Per-job cap | $2.00 | not above the monthly cap |
| Attempts per request | 2 | 1–5 |

Every change is logged with the previous value.

**The dashboard shows:**

- the month's cap, spent (actual), in flight (reserved) and remaining;
- calls and tokens;
- refusals (duplicate, budget, retry);
- the most expensive articles;
- earlier months.

`content_engine_acquisition_report` shows the same spend beside the
acquisition funnel: cost per paid subscriber, with a target of ≤ $25.

## Caching and targeted regeneration

- **Research caching.** The research packet is frozen per opportunity
  (`research_hash`), so no call re-derives research.
- **Targeted regeneration.** "Rewrite with AI" takes one section
  (`section`): only that section is asked for and saved, and it is charged as
  `section`.
- **Duplicates.** An unchanged draft with unchanged research cannot be sent
  to Claude twice.

Tests:

- `tools/content/content_engine_sql.test.js` (B): the cap, a true two-session
  race, duplicates, retries, the job budget, abandoned reservations, an
  estimate overrun, the $10 default and the confirmation;
- `tools/content/content_engine_fn.test.js` ($): reserve → call → settle,
  measured cost, duplicate refusal, the cap, released and charged failures,
  fallback pricing;
- `tools/content/run.test.js` ($): the weekly job's calls are reserved
  against its run, and the local example makes no unmetered call;
- `tools/integrity/regression.test.js` (14, 15).
