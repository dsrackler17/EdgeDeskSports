# C. API specification

Purpose: this document specifies every Model Collective endpoint: method, path, auth class, request and response schema (response shapes are defined field-by-field in API-SHAPES.md and referenced inline here), status and error codes, rate limits, idempotency behavior, caching, and a working curl example per endpoint group. Every endpoint is marked **free**, **paid**, **key**, or **admin**.

## 1. Base, versioning, conventions

Base URL: `https://iattxbkbufslbauoumga.supabase.co/functions/v1`. Five caller-facing edge functions each route internal paths under `/v1/` (rule 8.12: ingest, public read, and embed read are separate functions with separate auth, rate limits, and CORS), plus `collective_billing` for Stripe. All functions set `verify_jwt=false` and perform their own auth. All responses are JSON, UTF-8. Every timestamp is ISO 8601 UTC. Nullable fields are present with `null`, never absent.

For testing, every page and the embed accept an API base override: `?api=<base>` query param, `localStorage.COLLECTIVE_API_OVERRIDE`, or `data-api` on the embed script tag (API-SHAPES.md header).

Auth classes:

| Class | Mechanism |
|---|---|
| **free** | None. Public, cacheable. |
| **paid** | `Authorization: Bearer <supabase JWT>`; entitlement is an active row in `collective.subscribers` for that user. While `billing.enabled=false`, anonymous callers get `locked` responses with `reason: "billing_not_live"`; signed-in members and creators are unlocked (creators always see the full board: they contributed to it). The gate lives in the response body, never in the DOM. |
| **key** | `x-collective-key: mck_live_...` (or `mck_test_...`) header. Prefix lookup plus sha256 compare. |
| **admin** | `Authorization: Bearer <supabase JWT>` whose user id appears in `admin.user_ids` config. |

## 2. Error taxonomy (identical everywhere)

```json
{ "error": { "code": "invalid_payload", "message": "human sentence", "details": [ ] } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_key` | 401 | Missing, malformed, or unknown key or JWT |
| `revoked_key` | 401 | Key exists, status revoked |
| `forbidden` | 403 | Authenticated but not allowed (wrong creator, not admin) |
| `forbidden_origin` | 403 | Embed Origin not on the creator's allowlist |
| `entitlement_required` | 402 | Paid data requested without an active subscription |
| `not_found` | 404 | No such route or resource |
| `token_invalid` | 404 | Invite token unknown |
| `token_expired` | 410 | Invite token past `expires_at` |
| `token_spent` | 410 | Invite token at `max_uses` |
| `conflict` | 409 | State conflict (for example duplicate origin add) |
| `payload_too_large` | 413 | Envelope over `ingest.max_bytes` (512 KiB) or over `ingest.max_rows` (500) |
| `invalid_payload` | 422 | Validation failure; `details` lists per-field or per-row problems |
| `rate_limited` | 429 | Key over `ingest.rate_per_hour` (60/hour sliding window) |
| `server_error` | 500 | Unexpected failure; body never leaks internals |

## 3. collective_ingest (auth: key)

CORS `*`: the key is the auth, and a static-site creator testing from a page must not be blocked, though the docs push key use to server-side paths (GitHub Action, script).

Rate limit: `ingest.rate_per_hour` (60) per key, sliding one-hour window over `api_request_log`, checked before any work. Size limits: `ingest.max_rows` 500, `ingest.max_bytes` 524288.

| Endpoint | Class | Purpose |
|---|---|---|
| `GET /v1/whoami` | key | Key check: creator, model, sport, key prefix and kind, limits. Shape: API-SHAPES.md "whoami". |
| `POST /v1/projections` | key | Submit a slate. Envelope and response: CONTRACT 5.1. |
| `POST /v1/projections/dry-run` | key | Identical validation and resolution, writes nothing; response adds `"dry_run": true`, `submission_id: null`. The Universal Prompt tests here first. |

Envelope (CONTRACT 5.1): identity comes from the key (rule 8.2); optional `model` string must match the key's model or the whole envelope is rejected 422. Required: `sport`, `season`, `data_origin` (`live | backfill | test`), `rows[]` with `game_ref`, `home_team`, `away_team`, `kickoff` per row. Optional per row: `pick_side`, `total_side`, `line_at_submission` (required if `cover_probability` present), `projected_spread` (home convention, negative = home favored), `projected_total`, `proj_home_score`, `proj_away_score`, `home_win_probability` (0..1, moneyline), `cover_probability` (0..1, vs the stated line), `confidence` (creator-defined, never aggregated).

Response 200 (CONTRACT 5.1): `submission_id`, `received_at`, `data_origin`, `counts` (`rows`, `resolved`, `quarantined`, `late`, `first`, `movement`, `rejected`), per-row outcomes (`status`: `resolved | quarantined | rejected | late`, with `game_id` and `reason`), and `duplicate`.

Semantics enforced inside one transaction:

- **Idempotency**: replay is keyed on `(model_id, payload_hash)`; the hash covers the rows (or the caller's `idempotency_key` when provided). A replay returns the original stored response with `duplicate: true` and HTTP 200. Nothing is written twice.
- **Partial success** (rule 8.4): quarantined rows never fail the submission; they are stored with the raw ref verbatim and a reason, and reported per row.
- **Row rejection**: an individually invalid row (missing required field, probability out of range, `cover_probability` without a line, the obvious spread-vs-probability mismatch guard) is rejected at row level with a reason; the rest of the envelope proceeds.
- **Lateness** (rule 8.6): server receipt after canonical kickoff stores the row flagged `late`, excluded from grading.
- **First lock** (rule 8.5): the first resolved, live, pre-kickoff row per `(model, game)` is the graded candidate; later rows are movement.
- **Test keys**: an `mck_test_` key forces `data_origin='test'` regardless of the envelope.

```bash
# whoami, then dry-run a one-game slate
curl -s "$API/collective_ingest/v1/whoami" -H "x-collective-key: $KEY"

curl -s -X POST "$API/collective_ingest/v1/projections/dry-run" \
  -H "x-collective-key: $KEY" -H "content-type: application/json" \
  -d '{ "sport":"NFL", "season":2026, "week":3, "data_origin":"live",
        "rows":[{ "game_ref":"NFL_2026_W3_BUF_KC", "home_team":"KC", "away_team":"BUF",
                  "kickoff":"2026-09-21T00:20:00Z", "pick_side":"home",
                  "projected_spread":-3.5, "projected_total":47.5,
                  "home_win_probability":0.61 }] }'
```

## 4. collective_public (auth: none, JWT for paid and dashboard)

CORS `*` on GETs. Caching: `cache-control: public, max-age=60` on free GETs, `no-store` on paid and dashboard responses.

| Endpoint | Class | Purpose and shape (API-SHAPES.md section) |
|---|---|---|
| `GET /v1/meta` | free | Pricing, sports, season, counts, urls. Shape: "meta". |
| `GET /v1/wall` | free | Model wall rows with record, coverage, membership. Shape: "wall". |
| `GET /v1/creators/{slug}` | free | Profile with models, records, backfill shown separately, `empty_state`. Shape: "creators". |
| `GET /v1/models/{creator}/{model}` | free | Record detail, per-week coverage, recent graded rows with movement counts. Shape: "models". |
| `GET /v1/rankings` | free | Three boards ranked separately plus an unranked list with reasons. Shape: "rankings". |
| `GET /v1/games?sport=&season=&week=` | free / paid | Settled games free with results, grades, and consensus; upcoming rows return `locked: true` per model with no numeric keys unless entitled. Shape: "games". |
| `GET /v1/consensus?sport=&season=&week=` | paid (settled free) | Consensus rows; unentitled callers get counts only with `reason`. Shape: "consensus". |
| `GET /v1/activity` | free | Recent submission feed; numbers only if settled or entitled. Shape: "activity". |
| `GET /v1/rules` | free | Published grading rules, versioned. Shape: "rules". |
| `GET /v1/dashboard` | creator JWT | Own profile, key prefixes, origins, earnings summary, embed snippet. Shape: "dashboard". |
| `POST /v1/dashboard/profile` | creator JWT | Edit display_name, description, website_url, x_handle, logo_url, pinned_model_slug. Returns `{ ok, creator }`. |
| `POST /v1/dashboard/keys/rotate` | creator JWT | New key issued, old revoked atomically, shown once: `{ key, prefix, shown_once: true }`. |
| `POST /v1/dashboard/origins` | creator JWT | `{ "add": "https://example.com" }` or `{ "remove": "<id>" }`. Returns `{ ok, origins }`. |

Errors: unknown slug 404 `not_found`; dashboard without a creator-linked JWT 403 `forbidden`; paid data anonymous 402 `entitlement_required` only when billing is live, otherwise the `locked` shape with `billing_not_live`.

```bash
curl -s "$API/collective_public/v1/meta"
curl -s "$API/collective_public/v1/wall"
curl -s "$API/collective_public/v1/games?sport=NFL&season=2026&week=3"
curl -s "$API/collective_public/v1/dashboard" -H "Authorization: Bearer $JWT"
```

## 5. collective_embed (auth: Origin allowlist)

CORS: dynamic; the response echoes only the matched origin. The `Origin` header (fallback `Referer` host) must match an active `embed_installs` row for the host creator, else 403 `forbidden_origin` and the embed renders its static fallback. `edgedesksports.com` always passes; localhost passes while `embed.allow_localhost` is true. The page carries only the public host slug, no secret: the allowlist is the lock (see D-auth-credentials.md section 6).

| Endpoint | Class | Purpose |
|---|---|---|
| `GET /v1/embed/bootstrap?host={slug}&theme={dark\|light}` | free (origin-gated) | One payload: meta, wall (host pinned first, otherwise canonical order), creators directory, upcoming (locked shapes), settled highlights, subscribe and collective URLs carrying `?ref={slug}`, `cache_seconds`. Shape: "embed/bootstrap". Host pinning annotates an identically built payload; nothing else varies per host (Section 4 hard rule). |
| `POST /v1/embed/events` | free (origin-gated) | Batched events (`impression`, `profile_view`, `outbound_click`, `collective_click`, `subscribe_click`), fire and forget, returns 202 `{ ok: true }`. First-touch attribution is recorded server-side from these. |

```bash
curl -s "$API/collective_embed/v1/embed/bootstrap?host=moose&theme=dark" \
  -H "Origin: https://example.com"
```

## 6. collective_join (auth: invite token, then magic-link JWT)

CORS: `*` for GET status; site origins for POSTs.

| Endpoint | Class | Purpose |
|---|---|---|
| `GET /v1/join/{token}` | free (token) | Status `valid | expired | spent`, prefill, founding flag, `expires_at`. Expired and spent return HTTP 410 with the same shape plus `request_url`. Shape: "join". |
| `POST /v1/join/{token}/redeem` | free (token + Bearer JWT from magic link) | Body: `display_name`, `sport`, `model_name`, optional `description`, `website_url`, `x_handle`, `logo_url`, and `accept_terms: true`. Creates creator, model, slug, and key in one transaction. Returns the key (once), the rendered Universal Prompt, the embed snippet, profile and dashboard URLs. Shape: "redeem". Idempotent per user plus token: a re-post returns the same creator without minting a second key. |
| `POST /v1/join/request` | free | From the friendly expired or spent page: email plus note, writes an admin notification row, always 200. |

Errors: `token_invalid` 404, `token_expired` 410, `token_spent` 410, missing or bad JWT on redeem 401 `invalid_key`, `accept_terms` false 422 `invalid_payload`.

```bash
curl -s "$API/collective_join/v1/join/mci_XXXXXXXXXXXXXXXXXXXXXXXX"

curl -s -X POST "$API/collective_join/v1/join/mci_XXXXXXXXXXXXXXXXXXXXXXXX/redeem" \
  -H "Authorization: Bearer $JWT" -H "content-type: application/json" \
  -d '{ "display_name":"Must Be Moose", "sport":"NFL", "model_name":"NFL Model", "accept_terms":true }'
```

## 7. collective_admin (auth: admin)

CORS: site origins. Every route 403 `forbidden` unless the JWT user id is in `admin.user_ids`.

| Endpoint | Class | Purpose |
|---|---|---|
| `POST /v1/admin/invites` | admin | Mint invite: `{ prefill, founding, share_bps, max_uses, note }`. Returns raw `invite_url` and token once. |
| `GET /v1/admin/invites` | admin | List with derived status. |
| `GET /v1/admin/members` | admin | Creators with models, key prefixes, origins, membership, share bps, last submission. |
| `GET /v1/admin/quarantine` | admin | Quarantine queue with raw ref, raw row, reason. |
| `POST /v1/admin/quarantine/{id}/resolve` | admin | Body `{ "game_id": "..." }` to pin one row, or `{ "alias": { "sport", "alias", "team_code" } }` to add an alias and re-resolve every quarantined row that now matches. Returns `{ ok, resolved }`. |
| `POST /v1/admin/games` | admin | Upsert slate rows: `{ sport, season, games: [ { week, kickoff, home, away } ] }`. |
| `POST /v1/admin/results` | admin | Settle: scores plus the Collective's closing lines; triggers grading for each game. Returns `{ ok, settled, graded }`. |
| `GET /v1/admin/earnings` | admin | Ledger rollup per creator per month. |

Request and response bodies: API-SHAPES.md "Admin" section, field by field.

```bash
curl -s -X POST "$API/collective_admin/v1/admin/invites" \
  -H "Authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "prefill": { "display_name":"Must Be Moose", "sport":"NFL", "model_name":"NFL Model" },
        "founding": true, "share_bps": 5000, "max_uses": 1, "note": "first wave" }'

curl -s -X POST "$API/collective_admin/v1/admin/results" \
  -H "Authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "results": [ { "game_id":"<uuid>", "home_score":27, "away_score":24,
        "closing_spread":-2.5, "closing_total":47.5, "closing_home_ml_prob":0.62 } ] }'
```

## 8. collective_billing (inert scaffold)

Ships with checkout wiring stubbed to a clearly labeled not-live response until the Stripe secrets and price ids are configured (`COLLECTIVE_STRIPE_SECRET`, `COLLECTIVE_STRIPE_WEBHOOK_SECRET`, `COLLECTIVE_PRICE_MONTHLY`, `COLLECTIVE_PRICE_ANNUAL`) and `billing.enabled` flips to true. The webhook path validates Stripe signatures, calls `lock_attribution` on conversion, upserts `subscribers`, and posts `earnings_ledger` entries at the creator's `referral_share_bps`. Attribution capture runs from day one regardless (rule 8.13); only the money paths wait.

## 9. Cross-cutting summary

- **Rate limits**: only keyed ingest is rate limited (60/hour/key). Free reads rely on 60-second CDN-side cache headers; the embed additionally honors `cache_seconds` client-side. Abusive scraping of free endpoints is a caching problem, not an auth problem, by design: the free surface is marketing.
- **Idempotency**: ingest by `(model_id, payload_hash)` with stored-response replay; join redemption per user plus token; admin games and results are upserts keyed on natural keys.
- **Pagination**: v1 responses are bounded by season and week parameters and by the roster size; no cursor pagination until a board exceeds a single response comfortably. The shapes reserve room (top-level objects, arrays under named keys) so adding `next` later is additive.
