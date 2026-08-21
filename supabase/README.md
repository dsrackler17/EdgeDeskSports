# Supabase sources

Backend sources for the Model Collective, kept in the repository so a schema
change and the code that depends on it land in one commit.

```
migrations/   SQL, applied in filename order
functions/    edge function sources, split into modules
functions/_shared/    modules shared across functions
functions/_bundles/   generated single-file output for the dashboard editor
```

## What is here, and what is not

Every deployed Collective edge function has its source here except
`collective_join`, which is still dashboard-only. Recovering a source means
dropping in its `index.ts` and running the bundler; the shared modules are
already in place.

| Function | What it serves |
| --- | --- |
| `collective_public` | the public site's read API |
| `collective_odds` | the internal odds read API |
| `collective_odds_ingest` | the OddsBlaze poll and snapshot writer |
| `collective_ingest` | creator projection submissions (`x-collective-key`) |
| `collective_admin` | the founder console |
| `collective_billing` | Stripe Checkout and the Stripe webhook |
| `collective_embed` | the bootstrap payload for member-site embeds |
| `collective_join` | **dashboard only, no source here** |

`collective_click`, `collective_session` and `collective_url` are *not*
functions and never were: they are an embed event type, a `localStorage` key,
and a payload field, all defined in `collective/embed.js`.

Shared modules split by who uses them:

- `env.ts`, `http.ts`, `db.ts`, `auth.ts`, `keys.ts`, `reads.ts` — the
  Collective functions. These were reconstructed from the deployed bundles and
  match them byte for byte apart from `timingSafeEqual` in `keys.ts`, which is
  new.
- `odds_provider.ts`, `oddsblaze.ts`, `odds_normalize.ts`, `odds_api.ts` — new,
  used only by the odds functions.

### `_shared/reads.ts` had drifted across three deployments

The dashboard copies of `reads.ts` in `collective_public`, `collective_admin`
and `collective_embed` were not the same file. Splitting them into one source
resolved the differences in favor of `collective_public`, which is the copy the
site renders from:

| Difference | `_public` | `_admin` | `_embed` | Resolved to |
| --- | --- | --- | --- | --- |
| `viewCount` count column | parameter | parameter | hardcoded `id` | parameter |
| `pricing` fallbacks (cents) | 2499 / 0 | 2499 / 0 | 2000 / 20000 | 2499 / 0 |
| `line_at_submission`, `cover_prob` on board rows | present | absent | absent | present |

The pricing fallbacks only apply when the `pricing.*` config rows are missing.
The board-row fields mean the embed now emits `line_at_submission` and
`cover_probability` on unlocked games, which is what "the embed and the site
render from identical data" requires.

## Deploying

Two paths. Prefer the first.

**From the repo (recommended).** `supabase db push` and
`supabase functions deploy` read what is committed here, so a stale copy cannot
ship. `verify_jwt` comes from `supabase/config.toml`, which makes the "Enforce
JWT verification" toggle a reviewable line in a diff rather than a checkbox
someone has to remember. See [`SETUP_LOCAL.md`](SETUP_LOCAL.md).

**Pasting a bundle into the dashboard (fallback).** Works, but has no version
check: paste an older download and every screen reports success while the
deployed code is out of date. This has already cost a day on this project — a
migration was run from a stale download, so the scheduler it carried never
existed while the dashboard showed "Success".

`tests/collective/config_matches_bundles.py` asserts the two paths agree about
JWT enforcement for every function, so whichever you use, the gateway posture
is the same.

## Bundling for the dashboard

The dashboard editor takes one `index.ts` per function, so the split sources
are flattened before deployment:

```
python3 tools/collective/bundle_functions.py                  # all
python3 tools/collective/bundle_functions.py collective_odds  # one
python3 tools/collective/bundle_functions.py --check          # is the
                                                              # committed
                                                              # bundle current?
```

Paste `functions/_bundles/<name>.bundle.ts` into the dashboard as `index.ts`.
Never edit a bundle by hand: edit the source and regenerate.

Each bundle's header states whether that function needs **Enforce JWT
verification** on or off. Getting that wrong is the difference between a
public read surface and an open writer:

| Function | Enforce JWT | Why |
| --- | --- | --- |
| `collective_public` | OFF | anonymous site reads |
| `collective_odds` | OFF | anonymous site reads |
| `collective_odds_ingest` | OFF | authenticates the service role key, an admin session, or the pg_cron token, in-function |
| `collective_ingest` | OFF | authenticates its own `x-collective-key` header |
| `collective_admin` | OFF | verifies the bearer token itself via `requireAdmin` |
| `collective_billing` | OFF | the Stripe webhook is signed by Stripe, not a JWT |
| `collective_embed` | OFF | third-party sites call it; the origin allowlist is the lock |

OFF does not mean unauthenticated. Every function above either is a public
read surface or does its own authentication in code, which is why the gateway
has to let the request through to reach that check.

`collective_odds_ingest` was ON and is now OFF, deliberately. The gateway check
accepts any valid JWT, and the anon key that produces one is printed in the
site's own page source — so every visitor already has one and it gated nothing.
What it did block was pg_net, which drives the schedule from inside Postgres
and has no JWT to send. The real gate is `authorize()` in the function: the
service role key, an admin session, or the `ingest.cron_token` from
`odds.settings`, compared in constant time.

## Type checking

Bundling drops module scope, so a top-level name that is fine in a module can
collide with a global once inlined. Both forms are checked:

```
sh tools/collective/typecheck.sh
```

## Secrets

Set in Supabase → Edge Functions → Secrets. Never in this repository.

| Name | Used by | Required |
| --- | --- | --- |
| `NFL_ODDS_API_KEY` | `collective_odds_ingest` (OddsBlaze, and the fallback for The Odds API) | yes, for odds ingestion |
| `THE_ODDS_API_KEY` | same (The Odds API; takes precedence) | only to run both providers on separate keys |
| `NFL_ODDS_BASE_URL` | same | no, defaults to the documented endpoint |
| `THE_ODDS_API_BASE_URL` | same | no, defaults to the documented endpoint |
| `THE_ODDS_API_REGIONS` | same | no, defaults to `us`; each region multiplies the credit cost per poll |
| `COLLECTIVE_BASE_URL` | all | no, defaults to production |
| `COLLECTIVE_STRIPE_SECRET` | `collective_billing` | only to take payments |
| `COLLECTIVE_STRIPE_WEBHOOK_SECRET` | `collective_billing` | only to take payments |
| `COLLECTIVE_PRICE_MONTHLY` | `collective_billing` | only to take payments |
| `COLLECTIVE_PRICE_ANNUAL` | `collective_billing` | no, monthly-only without it |

Billing ships inert: with `billing.enabled` false or the Stripe secrets unset,
`/v1/billing/checkout` reports `live: false` and nothing charges.

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are
injected by the runtime.

See [`docs/collective/odds.md`](../docs/collective/odds.md) for the odds
architecture, refresh schedule, normalization rules and troubleshooting.
