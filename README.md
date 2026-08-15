# EdgeDesk

A sports-betting **market research terminal** operated by Rackler Tech Ventures LLC
at **https://edgedesksports.com**. EdgeDesk aggregates market prices, removes the
vig to estimate a fair line, flags prices that beat that fair line, researches the
matchup around them, and grades every flagged edge against the closing line (CLV).

EdgeDesk is a research and information tool. It is **not** a sportsbook, does not
accept or place wagers, and does not tell anyone what to bet. Signals can be wrong.
21+ · 1-800-GAMBLER.

## Repository layout

| File | What it is |
| --- | --- |
| `index.html` | Public marketing / landing page (auth, ARL consent, Stripe entry) |
| `app.html` | The research terminal (requires an account) |
| `record.html` | Public CLV record — methodology and live grading, no login |
| `curriculum.html` | Educational material on price-first research |
| `terms.html` / `privacy.html` / `disclaimer.html` | Legal pages |
| `admin.html` | Internal operations page (server-side RLS is the security boundary) |
| `supabase/functions/edgedesk_ai/` | Supabase Edge Function backing the AI research assistant, plus its regression tests |

## Architecture notes

- Static pages are served via GitHub Pages; data, auth, and row-level security live
  in Supabase. Payments are processed by Stripe — card details never touch this code.
- All betting math (probabilities, fair prices, edges, EV, CLV, verdicts,
  confidence) is **deterministic pipeline code**. The AI assistant interprets and
  explains that owned evidence; it is prompt-constrained to never invent numbers,
  never override the engine, and never instruct anyone to place, increase,
  decrease, or avoid a wager.
- The public anon key that appears in the client is intentional: Supabase anon keys
  are designed to be public, and authorization is enforced by RLS policies, not by
  key secrecy.

## Edge function tests

```
node --test supabase/functions/edgedesk_ai/index.test.ts
```

The suite covers evidence-integrity localization (excluding only affected records
instead of blocking whole-slate answers), sport routing, gate calibration, and
leakage checks. Node 22+ runs the TypeScript file directly via type stripping.

## Honest notes

- CLV over a large graded sample is the only proof-of-edge metric this product
  claims; win rate is displayed for context only. The public record grades itself.
- Research/information only. Not betting, financial, or legal advice. No
  guaranteed results.
