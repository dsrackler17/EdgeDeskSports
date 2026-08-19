# Model Collective, documentation index

This directory holds the architecture documentation for the Model Collective: shared infrastructure for independent sports-model creators, built inside the EdgeDesk Sports repo. `CONTRACT.md` is the binding source of truth for every name, shape, and number; if any doc here disagrees with it, the contract wins. This README is the map: the decided answers to the build prompt's open questions up top, then a one-line index of every document.

## Decided answers to the Section 12 open questions

Each of these was decided during the autonomous build and is recorded in CONTRACT.md section 1. They are recommendations with rationale, and every one is reversible; veto any of them and the change is contained.

| # | Question | Decision | Rationale, and cost to reverse |
|---|---|---|---|
| 1 | Same Supabase project or new one? | Same project (`iattxbkbufslbauoumga`), dedicated Postgres schema `collective`, no cross-schema foreign keys in either direction. | The repo already runs isolated schemas (ufc, tennis, wta, cfb) this way, and reusing Auth and Stripe avoids forking either. Reversal is a schema dump plus a DNS change, by design (see A-architecture.md, the seam). |
| 2 | Own domain or route inside the existing app? | Route inside the existing GitHub Pages site: `collective/index.html`, `collective/join.html`, `collective/admin.html`, `collective/embed.js`, with a `404.html` shim providing the pretty `/join/{token}` route. | Zero new hosting, zero new DNS to start. A standalone domain later is a `BASE_URL` config change, not a rebuild. |
| 3 | Can an existing account become a creator? | Yes. A creator record references an auth user id as a plain uuid (no FK). An invited email that already has an EdgeDesk account gains a creator record on the same account. New creators sign in by magic link. | One auth system, one identity per person. Reversal would mean a parallel auth store, which the build prompt explicitly forbids. |
| 4 | Sports in scope for v1, and closing lines? | NFL only for v1, but the schema is multi-sport from day one (sports, sport_seasons, teams, team_aliases all keyed by sport). Closing lines: the Collective stores its own in `collective.results`, entered via the admin results endpoint, which the existing odds pipeline can feed. Grading never uses a creator's line. | Adding a sport is seed data plus a season row, no schema change. |
| 5 | Minimum coverage to be ranked? | 60 percent of the sport's season-to-date games, and at least 20 graded games. Both live in `collective.config` (`ranking.min_coverage_pct`, `ranking.min_graded_games`) with a `ranking.per_sport` override map. | Changing a threshold is a config UPDATE, effective on the next view read. |
| 6 | Retention promise when a creator leaves? | Submissions are append-only and stay in the historical record: the public record is the product and it does not get holes when someone leaves. On departure the profile is unlisted (`is_listed=false`), keys are revoked, and personal fields (website, socials, logo) can be cleared on request. Stated in the join flow terms line. | Reversing this (deleting history) would corrupt every consensus and record number ever published; do not. |
| 7 | Repo findings that shaped the design? | The repo had no `supabase/` directory; database objects lived only in the hosted project. This build establishes `supabase/migrations/` and `supabase/functions/` as the source of truth. The existing app already exposes extra PostgREST schemas via `accept-profile`, so exposing `collective` (with zero grants to anon and authenticated) is consistent with existing practice. | n/a, observation. |

Pricing was decided in the build prompt and is not reopened: $20/month, $200/year, Mode A referral at 40 percent (founding members 50 percent, first 10 seats), Mode B wholesale at $14/seat with a 10 seat minimum and a $20 retail floor. All numbers live in `collective.config`, nowhere else.

## Document index

Binding references:

- **[CONTRACT.md](CONTRACT.md)**: the single source of truth for names, shapes, numbers, and conventions across the whole build.
- **[API-SHAPES.md](API-SHAPES.md)**: concrete JSON response contracts for every endpoint; field names are final.
- **[DEPLOY.md](DEPLOY.md)**: the deploy runbook: link, migrate, expose schema, deploy functions, set secrets, seed admin, smoke test.

Architecture documents A through N:

- **[A-architecture.md](A-architecture.md)**: components, data flow, trust boundaries, and the extraction seam that lifts the Collective into its own project with a schema dump and a DNS change.
- **[B-database-schema.md](B-database-schema.md)**: every table, column, type, constraint, index, enum, and view; RLS posture; append-only enforcement; justification for every denormalization.
- **[C-api.md](C-api.md)**: every endpoint with method, auth, request and response schema, status and error codes, rate limits, idempotency, and a working curl example per group; each marked free, paid, key, or admin.
- **[D-auth-credentials.md](D-auth-credentials.md)**: API key format and hashing, display-once flow, rotation and revocation, invite token lifecycle, why the embed carries no secret, and magic-link auth reuse.
- **E-onboarding.md**: the three-screen join flow against the friction budget, with the explicit field count and what was cut to stay inside it.
- **F-ui.md**: Collective site UI specification: layout, typography, tokens, density, empty states, phone behavior.
- **G-model-wall.md**: wall columns, sort, status indicators, update mechanism, click-through, behavior at 3 models and at 300.
- **H-creator-profile.md**: data source per profile element, edit permissions, public versus private fields, the zero-submission empty state.
- **I-claude-integration.md**: how the Universal Creator Prompt is generated per creator, what is templated, and how it stays in sync with the API.
- **J-security.md**: threat list with mitigations: key leakage, spoofing, cross-creator access, replay, scraping, quota exhaustion, oversized payloads, embed origin abuse, attribution fraud, invite abuse, RLS bypass.
- **K-embed.md**: the embed script contract: host slug, theming limits, shadow DOM boundary, origin allowlist, caching, failure states, free versus gated parts.
- **L-economics.md**: both billing modes at the decided numbers, attribution rules, payout calculation, clawbacks, per-creator rate overrides, earnings reporting.
- **M-build-plan.md**: MVP build plan mapped to the phased build order, with a definition of done per phase.
- **N-future.md**: standalone extraction, weighted consensus after validation, multi-sport scaling, additional creator tiers.
