# J. Security Model

Purpose: the threat list for the Model Collective with the concrete mitigation for each threat, as built. Every mitigation named here corresponds to a real mechanism in the migrations (`supabase/migrations/2026081900000*_collective_*.sql`), the edge functions (`supabase/functions/collective_*`), or the frontend. Where a config value governs behavior, the key in `collective.config` is named. Nothing in this document is aspirational: if a mitigation is listed, it ships in this build.

Threat model in one sentence: the Collective accepts numeric payloads from semi-trusted creators, republishes them on arbitrary third-party websites, and will eventually move money based on who referred whom, so the attack surface is credentials, payload identity, cross-tenant reads, public data value, and attribution money.

---

## 1. Key leakage

Threat: a submission key (`mck_live_...`) is pasted into a public repo, a screenshot, a Claude transcript, or a browser page, and someone else submits as that creator.

Mitigations:

- **sha256 storage.** The raw key never touches the database. `collective.api_keys` stores `key_hash = sha256 hex of the full key string` and nothing else that reconstructs the secret. A database dump does not yield usable keys.
- **Prefix lookup.** The key format is `mck_live_{prefix}{secret}` with an 8 char base62 prefix stored plaintext in `key_prefix` (unique). Verification (`collective.verify_key`) looks up by prefix, then compares the sha256 of the presented full key against `key_hash`. This gives O(1) lookup without a plaintext secret and lets dashboards and logs reference keys safely by prefix alone. The prefix carries zero authentication value by itself.
- **Display once.** The full key is returned exactly once: in the join redeem response (screen 3) or the rotate response, both flagged `"shown_once": true`. No endpoint can ever re-fetch a full key. The dashboard shows prefixes only.
- **Rotation.** `POST /v1/dashboard/keys/rotate` (creator JWT) mints a new key and revokes the old one in the same transaction. The Universal Creator Prompt tells the creator where to rotate. Rotation does not orphan history: submissions keep their `api_key_id` FK to the revoked row.
- **Revocation.** `api_keys.status` flips to `revoked` with `revoked_at` set. `verify_key` returns null for revoked keys and the ingest function answers 401 `revoked_key`. Historical data submitted under a revoked key is untouched (append-only record, contract section on retention). Departure revokes all of a creator's keys.
- Test keys (`mck_test_`) are structurally the same but every submission through one is forced to `data_origin='test'`, so a leaked test key cannot pollute the live record.

Residual risk: a leaked live key is usable until rotated. `last_used_at` on the key row and the per-key `api_request_log` give the creator and admin the evidence to notice. Rate limiting (threat 6) caps the damage per hour.

---

## 2. Payload spoofing

Threat: a valid key holder submits an envelope claiming to be a different creator or model, or a script mislabels its own identity and the wrong record gets credited.

Mitigation, rule 8.2 verbatim in behavior: **identity comes from the key, never from the payload.** `collective.ingest_submission` derives `creator_id` and `model_id` from the verified key row. The optional `"model"` string in the envelope is a readability check only: if present and it does not match the key's model slug, the whole submission is rejected 422 `invalid_payload` with a message naming the mismatch. Same for the sport: the envelope's `"sport"` must match the model's `sport_code`. Name strings are validated, not trusted, and can never redirect attribution of rows. There is no code path where a payload string selects a model.

---

## 3. Cross-creator access

Threat: creator A reads or writes creator B's private data (keys, earnings, origins) or submits to B's model.

Mitigations:

- **Keys scoped to creator plus model.** `api_keys.creator_id` and `api_keys.model_id` are set at mint time and the ingest RPC writes only to that model. A key cannot address any other model, including another model owned by the same creator (one key per model, minted per model).
- **RLS deny-all.** Every table in schema `collective` has RLS enabled with zero policies. Even if a grant leaked, no row is visible to `anon` or `authenticated`.
- **Service-role-only RPCs.** All RPCs are `SECURITY DEFINER` with `search_path = collective, public` and EXECUTE revoked from `public`, `anon`, and `authenticated`. Only edge functions holding the service role can call them, and each edge function scopes its queries by the identity it verified (key for ingest, JWT user id for dashboard, `admin.user_ids` membership for admin). The dashboard endpoints resolve the creator row from the JWT user id, never from a client-supplied slug.

---

## 4. Replay

Threat: the same submission is posted twice (retry loops, GitHub Action re-runs, a captured request replayed) and inflates the record or spends the first-submission lock incorrectly.

Mitigation: **idempotency by model plus payload hash.** `collective.submissions` has `unique(model_id, payload_hash)` where `payload_hash` is the sha256 of the canonical rows (or the caller's `idempotency_key` when provided). A replayed envelope hits the unique constraint inside the ingest transaction and the function returns the **original** submission's stored result with `"duplicate": true`, HTTP 200. No new rows, no error, no state change. A replay therefore cannot create movement rows, cannot re-trigger the first-submission lock, and cannot consume rate budget beyond the request itself. The first-submission lock (`projections_first_lock` unique partial index on `(model_id, game_id) where is_graded_candidate`) is the structural backstop: even a novel payload for an already-covered game becomes movement, never a second graded row.

---

## 5. Scraping

Threat: a bot harvests the public API, or a paid subscriber's page is scraped to leak pre-kickoff numbers.

Mitigations:

- **Public data is deliberately public.** The wall, profiles, records, rankings, and settled results are the marketing surface (Section 5 of the build prompt). Scraping them is distribution, not loss. No obfuscation is attempted and none should be added.
- **Paid data never leaves the API for unentitled callers.** The gate is in the response body, not the DOM: locked rows in `/v1/games` and `/v1/consensus` contain no numeric keys at all (`{"locked": true}` and counts only). There is nothing hidden client-side to un-hide. Entitlement is an active `collective.subscribers` row (or creator JWT) checked server side per request.
- **Cache headers.** Free GETs carry `cache-control: public, max-age=60` (from `embed.cache_seconds`), so CDN and browser caches absorb scraper load without a database hit. Paid and dashboard responses are `no-store`, so no cache ever holds entitled numbers.
- **No DOM gating.** The frontend never receives paid numbers it then hides. A creator editing their own embed page cannot unlock anything, because the host page holds no entitlement (contract 5.3: the embed payload for an unentitled viewer is already locked when it arrives).

Residual risk: an entitled subscriber can republish numbers they paid for. That is a terms-of-service problem, not a technical one, and no DRM is attempted.

---

## 6. Quota exhaustion

Threat: a buggy creator script or a hostile key holder floods ingest, filling the database or starving other creators.

Mitigations, all config-driven:

- **Per-key hourly rate limit.** `collective.rate_check` counts `api_request_log` rows for the key in a sliding one-hour window against `ingest.rate_per_hour` (seeded 60). Over the limit answers 429 `rate_limited`. The log table is identity-keyed bigint, append-only, pruned by maintenance.
- **Max rows.** `ingest.max_rows` (seeded 500) caps rows per envelope, rejected 422 before any row processing.
- **Max bytes.** `ingest.max_bytes` (seeded 524288) caps the request body, rejected 413 (see threat 7).

Combined worst case per key: 60 requests times 500 rows per hour, bounded and adjustable in one config row without a deploy.

---

## 7. Oversized payloads

Threat: a multi-megabyte body is posted to ingest to burn CPU or memory in JSON parsing.

Mitigation: **413 before parse.** The ingest function checks `Content-Length` against `ingest.max_bytes` and rejects 413 `payload_too_large` before reading or parsing the body. Bodies arriving without a length header are read through a byte-counting stream that aborts at the same limit. The JSON parser never sees an oversized payload.

---

## 8. Embed origin abuse

Threat: someone copies a creator's embed snippet (the host slug is visible in page source by design) onto an unauthorized site to piggyback on the pin privilege or to farm attribution.

Mitigations:

- **Per-creator origin allowlist.** `collective.embed_installs` stores allowed origins (`scheme + host`, unique per creator case-insensitively). Creators manage the list from the dashboard (`POST /v1/dashboard/origins`).
- **Enforcement at bootstrap.** `collective_embed` matches the request `Origin` (fallback `Referer` host) against the host creator's active installs. No match answers 403 `forbidden_origin` and the embed renders its static fallback panel: it degrades, it never serves data. `edgedesksports.com` and localhost (when `embed.allow_localhost` is true) always pass, so demos and local testing work.
- **CORS echo of the matched origin only.** The response's `Access-Control-Allow-Origin` is the single matched origin, never `*`. A response captured for one origin is not replayable cross-origin by the browser.
- **No secret in page source.** The snippet carries only the public host slug. There is nothing to steal: a lifted slug on a non-allowlisted origin gets 403. The allowlist is the lock and the page holds no key. This is why the embed needs no signing scheme and why viewing source on a member site reveals nothing sensitive.

---

## 9. Attribution fraud

Threat: a creator tries to claim subscribers they did not refer, steal another creator's referral, or refer themselves for a discount loop.

Mitigations:

- **First touch locked at conversion.** `collective.attribution_touches` records every touch append-only; `collective.lock_attribution` (called only from the billing webhook path) selects the **earliest** touch for the converting visitor and writes one immutable `collective.attributions` row. There is no update path on `attributions` (append-only trigger plus revoked UPDATE/DELETE). Later browsing through another member's tab writes more touches but can never move the lock. Two creators cannot both hold a subscriber.
- **Unique subscriber constraint.** `attributions` has `unique(subscriber_user_id)` and `unique(subscriber_email_hash)`, so a subscriber who cancels and resubscribes under the same identity cannot be re-attributed, and a race between two webhook deliveries collapses to one row.
- **Touch capture is server side.** Touches are written via `collective.record_touch` from embed and site traffic; the visitor id is a random client uuid but the creator slug is validated against real creators, so touches cannot be minted for nonexistent referrers.
- **Self-referral note.** A creator subscribing through their own embed attributes to themselves. This is permitted and cheap: the creator pays $20 and earns back their own share, netting the Collective the remainder, so there is no arbitrage worth policing at v1 scale. The admin earnings view exposes self-referrals (subscriber user id equals creator user id) so the founder can see them, and the 60 day clawback window covers refund-cycling abuse. If it ever matters, blocking is a one-line check in `lock_attribution`, recorded here so the decision is deliberate rather than an oversight.

---

## 10. Invite token abuse

Threat: invite links are brute-forced, shared beyond the intended recipient, harvested from logs, or probed to enumerate who was invited.

Mitigations:

- **Hashed at rest.** Raw token `mci_{24 base62 chars}` (roughly 142 bits of entropy, unguessable). Only the sha256 lands in `invite_tokens.token_hash`; a short `token_prefix` is kept for admin display. A database dump yields no redeemable links.
- **30 day expiry.** `expires_at` set from `invite.expiry_days` at mint. Expired tokens answer 410 `token_expired`.
- **Usage caps.** `max_uses` (default 1) against `use_count`, incremented inside the redeem transaction. A spent token answers 410 `token_spent`. Redemption is idempotent per user plus token, so the intended recipient double-clicking does not burn a use on themselves.
- **Friendly dead-token page with no oracle behavior.** Expired and spent tokens land on a designed page in `join.html` with a request-a-new-link form (`POST /v1/join/request`, always 200). Critically, invalid, expired, and spent all resolve through the same hashed lookup with the same timing profile, the status endpoint reveals nothing beyond `valid | expired | spent`, and an unknown token is plain 404 `token_invalid`. Probing random tokens learns nothing about who has been invited, and prefill data is only returned for a valid token.

---

## 11. RLS bypass

Threat: the `collective` schema is exposed through PostgREST (it must be, per existing project practice), and someone queries it directly with the anon key, bypassing the edge functions.

Mitigations, defense in depth in three independent layers:

- **Layer 1, grants: schema exposed with zero grants to `anon` and `authenticated`.** Not even `USAGE` on the schema. A direct PostgREST request with the anon key fails at name resolution before any table is touched. This is the primary control.
- **Layer 2, RLS enabled with no policies.** Every table has `enable row level security` and zero policies, which is deny-all. If a grant is ever added by mistake, rows still do not flow.
- **Layer 3, everything through service-role edge functions.** All reads and writes go through `SECURITY DEFINER` RPCs executable by `service_role` only, called from edge functions that do their own auth (key, JWT, admin list). `service_role` bypasses RLS by design, which is exactly why layers 1 and 2 exist for every other role and why the service key lives only in edge function secrets, never in any page or repo file.

Verification: `tools/collective/curl-examples.sh` includes a direct PostgREST probe against `collective` with the anon key and asserts the failure. Any future migration adding a grant to `anon` or `authenticated` on this schema should be treated as a bug in review.
