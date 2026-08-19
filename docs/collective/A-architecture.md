# A. Architecture specification

Purpose: this document describes the components of the Model Collective, how data flows through them, where the trust boundaries sit, and the extraction seam that lets the whole system lift out of the EdgeDesk Sports Supabase project into a standalone project with a schema dump and a DNS change. Names, shapes, and numbers defer to CONTRACT.md; this document explains why the pieces are arranged the way they are.

## 1. Components

The Collective is five kinds of thing, all additive to the existing repo, none of them modifying an existing file:

1. **One Postgres schema, `collective`**, inside the existing Supabase project. Eight forward-only migrations create every enum, table, view, and RPC (CONTRACT section 4). No cross-schema foreign keys in either direction. All business logic that must be transactional (ingest, invite redemption, grading, quarantine resolution) lives in SECURITY DEFINER RPCs inside this schema, executable by `service_role` only.

2. **Six Supabase Edge Functions**, each a dependency-free Deno module with its own auth model, rate limits, and CORS policy (rule 8.12):
   - `collective_ingest`: the submission API. Auth: `x-collective-key` header.
   - `collective_public`: the public read API and the creator dashboard. Auth: none for free endpoints, Supabase JWT for paid and dashboard.
   - `collective_embed`: the embed bootstrap and event sink. Auth: Origin allowlist per creator.
   - `collective_join`: invite validation and redemption. Auth: invite token plus magic-link JWT.
   - `collective_admin`: founder console API. Auth: JWT whose user id is in `admin.user_ids` config.
   - `collective_billing`: Stripe checkout and webhooks, shipped inert behind `billing.enabled=false` (rule 8.13).

   All six set `verify_jwt=false` in `supabase/config.toml` and do their own auth, because the callers are keys, tokens, and anonymous browsers, not uniformly Supabase sessions. Shared code (`_shared/`) covers env, http, db, keys, auth, and the prompt template; the interface is pinned in `supabase/functions/_shared/INTERFACE.md`.

3. **Four static pages plus one script**, published by GitHub Pages from the `collective/` directory: `index.html` (wall, profiles, rankings, consensus, dashboard), `join.html` (three-screen onboarding), `admin.html` (founder console), `embed.js` (the embeddable Collective tab), and `embed-demo.html` (a plain host page proving the embed on a foreign origin). A root `404.html` shim turns `/join/{token}` into `collective/join.html?t={token}` on GitHub Pages. No framework, no build step, matching the rest of the site.

4. **The Universal Creator Prompt**: a template (`collective/claude-prompt-template.md`, mirrored as a constant in `_shared/prompt_template.ts`) rendered per creator at join time so the instructions a creator pastes into Claude cannot drift from the API that was actually deployed.

5. **Tools**: `tools/collective/harness.py` (CSV ingest proof against the dry-run and live endpoints), `sample_moose_nfl.csv` (real-world-shaped messy input), `curl-examples.sh`, and `test_migrations.sh` (migrations applied to a local Postgres in order, twice, to prove forward-only cleanliness).

## 2. Data flow

```
 CREATOR SIDE                      EDGE FUNCTIONS                    POSTGRES (schema: collective)
 ------------                      --------------                    -----------------------------

 model output (CSV/script/app)
        |
        | POST /v1/projections
        | x-collective-key: mck_live_...
        v
 +-----------------+   verify_key, rate_check   +--------------------------------------+
 | collective_     |--------------------------->| RPC ingest_submission (one tx):      |
 | ingest          |                            |  validate rows -> resolve game refs  |
 +-----------------+                            |  via teams/team_aliases/games        |
        ^                                       |  -> submissions (append-only)        |
        | per-row outcomes JSON                 |  -> projections (append-only,        |
        +---------------------------------------|     first-lock partial unique idx)   |
                                                +--------------------------------------+
 FOUNDER SIDE                                                   |
 admin.html --> collective_admin --> RPCs: mint_invite,         | views (derived, never stored):
   upsert_games, settle_game --> grade_game --> grades          | latest_projections, first_submissions,
                                                                | model_records, model_coverage,
 JOIN FLOW                                                      | membership_status, model_wall,
 /join/{token} -> 404.html shim -> join.html                    | rankings, consensus, model_movement,
   -> collective_join: invite_status                            | quarantine_queue, earnings rollups
   -> magic link (Supabase Auth, existing project)              |
   -> redeem_invite (creator + model + key, one tx)             v
                                                +--------------------------------------+
 READERS                                        | collective_public reads views via    |
 collective/index.html --------\                | service role; free vs paid gate      |
 embed.js on member sites ------+-------------->| applied in the response body         |
   (Origin allowlist,           |               +--------------------------------------+
    host slug only, no secret)  |
                                \-------------> collective_embed: bootstrap payload,
                                                embed_events sink, attribution touches

 BILLING (inert until billing.enabled)
 Stripe checkout -> collective_billing webhook -> lock_attribution -> subscribers
   -> earnings_ledger (referral share at creator's referral_share_bps)
```

Key properties of the flow:

- **Identity always comes from the credential, never the payload** (rule 8.2). The ingest path derives creator and model from the verified key; name strings in the envelope are checked for agreement and rejected on mismatch.
- **All writes go through RPCs in one transaction.** A submission is atomic: envelope row, projection rows, resolution, quarantine, late flagging, and first-lock candidacy all commit together or not at all.
- **All reads come off views.** Records, coverage, membership status, rankings, and consensus are derived at read time from the append-only base tables, so every published number is reproducible by anyone from raw data (rule 8.8, 8.9, 8.11).
- **The paid gate lives in the API response.** Locked rows carry no numbers at all; there is nothing in the DOM or the embed to unhide (Section 5 of the build prompt).

## 3. Trust boundaries

| Boundary | Crosses it | Enforcement |
|---|---|---|
| Public internet to edge functions | Everything | Each function does its own auth; `verify_jwt=false` so the boundary is explicit in code, not implicit in platform config. |
| Creator key to database | Submissions only | Key verified by prefix lookup plus sha256 compare (D-auth-credentials.md); scope `submit` only; per-key hourly rate limit; per-model attribution fixed by the key row, not the payload. |
| Browser to paid data | `/v1/games` upcoming, `/v1/consensus` | Entitlement checked server side against `collective.subscribers` for the JWT user; anonymous callers get `locked` rows with zero numeric keys. |
| Foreign origin to embed API | `embed/bootstrap`, `embed/events` | Origin allowlist in `embed_installs`; response CORS echoes only the matched origin; a lifted host slug is useless elsewhere because the page carries no secret. |
| Founder to admin API | All `/v1/admin/*` | JWT user id must appear in `admin.user_ids` config; there is no admin key, only an allowlisted identity. |
| Edge functions to Postgres | Everything | Service role only. `anon` and `authenticated` hold zero grants on the `collective` schema, not even USAGE; RLS is enabled on every table with no policies as a second lock. PostgREST exposure of the schema is therefore safe: an anon request with `Accept-Profile: collective` hits a permission wall before it hits a row. |
| Anything to historical data | Nothing | `submissions`, `projections`, `embed_events`, `earnings_ledger`, `attributions`, `api_request_log` are append-only: UPDATE and DELETE revoked plus a trigger that raises unless the maintenance GUC is set inside a SECURITY DEFINER maintenance function (CONTRACT 4.3). |

## 4. The seam: standalone extraction

Rule 8.1 says the Collective must lift into its own project with a schema dump and a DNS change. The seam is real, not aspirational, because of four deliberate constraints:

1. **No cross-schema foreign keys in either direction.** The only references to the outside world are plain uuids: `creators.user_id` and `admin.user_ids` point at `auth.users` ids but carry no FK, and `subscribers.stripe_customer_id` is a Stripe string. A `pg_dump --schema=collective` therefore restores cleanly into an empty project with no dependency ordering against edgedesk tables.

2. **All configuration is data or secrets, not code.** Every price, share, threshold, window, and limit lives in `collective.config`. Every deployment-specific string (`COLLECTIVE_BASE_URL`, Stripe secrets, price ids) is a function secret. The frontend reads `window.COLLECTIVE_CONFIG` from one constants block per page.

3. **The functions only touch `collective`.** Every RPC call goes through `db.ts` with `Content-Profile: collective`. The functions never query an edgedesk table. Redeploying the same six functions against a new project's URL and service key is the entire backend move.

4. **The URL surface is indirected.** Pages and the embed resolve the API base from config (with a `?api=` override for testing, per API-SHAPES.md). Moving to `collective.example.com` means: point DNS, publish the same `collective/` directory there, set `BASE_URL` and `API` in the constants block, done.

### The extraction runbook, in full

1. Create a new Supabase project. Run the same 8 migrations (`supabase db push`), or restore `pg_dump --schema=collective` from the old project for schema plus data.
2. Deploy the same 6 edge functions with the same secrets, pointing at the new project.
3. Add `collective` to the new project's PostgREST exposed schemas (same zero-grant posture).
4. Publish the `collective/` static directory at the new domain; update `BASE_URL` and `API` in `COLLECTIVE_CONFIG` and in the `embed.js` default.
5. Auth: creators sign in by magic link. Either enable the new project's Auth and let creators re-link on next login (their creator rows match by email at redemption, `user_id` is re-pointable by an admin maintenance update since it is a plain uuid), or keep the old project's Auth as the OIDC source. The plain-uuid design means neither choice touches the schema.
6. Stripe: webhooks re-point to the new `collective_billing` URL; customer and subscription ids are strings in `subscribers` and travel with the dump.

### What stays behind

- The EdgeDesk app, its schemas (public, ufc, tennis, wta, cfb), its auth users as such, its Stripe products, and every root-level page. Nothing in `app.html`, root `index.html`, or root `admin.html` is touched by this build or by extraction.
- The existing odds pipeline. The Collective stores its own closing lines in `collective.results` via the admin results endpoint; the pipeline is an optional feeder, never a dependency. Extraction does not break grading, it only changes who pastes the results in.
- The `404.html` join shim, replaced by a real route on the standalone host.

### What deliberately does not exist

- No shared tables, no shared views, no Collective view reading edgedesk data. Rule 8.1 permits explicit views into other schemas; v1 needs none, and adding one later must come with a note in this file on how extraction replaces it.
- No SDK. Ingest is plain HTTPS with one header; the harness proves curl, Python stdlib, and a GitHub Action all suffice (rule 9.6).
