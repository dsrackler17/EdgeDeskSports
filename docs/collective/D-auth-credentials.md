# D. Authentication and credential design

Purpose: this document specifies every credential in the Model Collective: the submission API key (format, hashing, prefix lookup, display-once, rotation, revocation, scoping), the invite token lifecycle, why the embed deliberately carries no secret at all, and how creator and admin sessions reuse the existing Supabase magic-link auth. The implementing code lives in `supabase/functions/_shared/keys.ts` and `auth.ts` (interface pinned in `_shared/INTERFACE.md`) and in the RPCs `verify_key`, `mint_invite`, `invite_status`, and `redeem_invite`.

## 1. Submission API keys

### Format

```
mck_live_{prefix}{secret}     production keys
mck_test_{prefix}{secret}     test keys, same table, submissions forced to data_origin='test'
```

`prefix` is 8 base62 characters, `secret` is 32 base62 characters, both from `crypto.getRandomValues`. The full raw key is therefore `mck_live_` plus 40 base62 chars. 32 base62 chars is about 190 bits of entropy: unguessable, and long enough that the sha256 at rest needs no salt or stretching (this is a random token, not a human password; there is nothing to dictionary-attack).

The `mck_` prefix makes keys greppable in leaked code and pastes, and lets secret scanners be taught one pattern. `live` versus `test` is visible in the string on purpose: a creator wiring a GitHub Action can see at a glance which kind they pasted, and the server enforces the difference anyway (a test key can never write live rows).

### Storage and verification

The database stores exactly two things per key, in `collective.api_keys`: `key_prefix` (the 8 chars, unique) and `key_hash` (sha256 hex of the full raw key string). The raw key exists in only two places, ever: the response body of the request that minted it, and wherever the creator saved it.

Verification, in `collective_ingest` on every request:

1. Read the `x-collective-key` header; parse shape with `parseCollectiveKey` (reject anything not `mck_live_`/`mck_test_` plus 40 base62 chars before touching the database).
2. `sha256hex(raw)` in the function.
3. `rpc("verify_key", { p_prefix, p_hash })`: one indexed lookup on `key_prefix`, then a hash equality check in SQL, returning the key row joined with creator and model, and touching `last_used_at`. Unknown prefix or hash mismatch returns null, mapped to 401 `invalid_key`; a matching key with `status='revoked'` maps to 401 `revoked_key`.

The prefix lookup is the reason the format splits: a unique index probe on 8 chars, then one constant-time-comparable hash check, with no need to scan or to index the hash of every candidate. The prefix also gives every key a safe public name: `mck_live_a1b2c3d4` appears in the dashboard, in `GET /v1/whoami`, and in admin views, identifying the key without exposing anything.

### Display-once flow

A key is shown exactly once, at mint time: on join screen 3 (from `redeem_invite`) or in the rotate response (`POST /v1/dashboard/keys/rotate`). Both responses carry `"shown_once": true` and the UI says, in plain language, to treat it like a password and where to regenerate it. There is no recover-key endpoint and there cannot be one: the server holds only the hash. Lost key means rotate.

### Rotation and revocation

- **Rotate** (`POST /v1/dashboard/keys/rotate`, creator JWT): mints a new key and revokes the old one in a single transaction (`status='revoked'`, `revoked_at=now()`). The new raw key is returned once. There is no overlap window in v1; a creator who needs zero-downtime rotation submits with the new key immediately, and the friction of one failed request is acceptable at this scale.
- **Revoke without replacement**: an admin path for departure or compromise sets `status='revoked'`. Any subsequent use returns 401 `revoked_key`, which is deliberately distinct from `invalid_key` so a creator debugging an old Action sees "this key was revoked" rather than "no such key".

### What happens to historical data on revocation: nothing

Submissions are append-only and keep their attribution. Every `submissions` row carries `api_key_id` permanently; revoking or rotating the key changes nothing about rows already written, their grading, their place in consensus, or the public record. This is the retention promise (CONTRACT section 1.6) expressed at the credential layer: the historical record is the product, keys are just the door, and closing the door does not un-happen the history. A departed creator's profile is unlisted and personal fields can be cleared, but the projections, grades, and the audit chain from row to submission to key remain.

### Scoping

`scope` is the enum `('submit')`: a key can submit projections and call whoami, nothing else. It cannot read the dashboard, edit the profile, or see earnings; those require the creator's magic-link session. So a leaked key's blast radius is: someone could submit garbage rows under that model (visible, attributable, quarantine-prone, rate limited to 60/hour) until the creator rotates. It cannot leak private data because it can read none.

`model_id` on the key row scopes it to one model; the join flow issues one key per model, and the envelope's optional `model` string must agree with the key's model or the submission is rejected (rule 8.2: identity from the credential, names checked but never trusted). A null `model_id` (all the creator's models) is representable but not issued in v1.

## 2. Why the embed carries no secret at all

The embed script tag contains one identifying attribute: `data-collective-host="moose"`, the creator's public slug, the same string in their profile URL. There is no embed key, by design:

- Anything in page source is public the moment one visitor views source. An "embed key" would be a secret that cannot be kept, which is worse than no secret because it implies protection that does not exist.
- The actual lock is the **origin allowlist**: `collective_embed` requires the request `Origin` (fallback: `Referer` host) to match an active row in `embed_installs` for that creator, and the CORS response echoes only the matched origin. A slug lifted from moose's page and dropped on another site gets 403 `forbidden_origin`, and the embed renders its static fallback panel.
- Nothing the embed serves is sensitive: the bootstrap payload is the free public surface plus locked shapes for paid content. The allowlist protects attribution integrity (impressions and first touches credited to the right creator from the right site), not confidentiality.
- `edgedesksports.com` always passes; localhost passes while `embed.allow_localhost` is true, so a creator can preview before adding their origin in the dashboard (`POST /v1/dashboard/origins`).

## 3. Invite tokens

### Format and storage

Raw token: `mci_{24 base62 chars}` (about 143 bits). Stored in `collective.invite_tokens` as `token_hash` (sha256 hex of the full raw token, unique) plus `token_prefix` (first 8 of the 24) so the admin list can name tokens without holding them. Same discipline as API keys: the raw token appears once, in the mint response, as `invite_url` (`{BASE_URL}/join/mci_...`) and is never recoverable.

### Lifecycle

1. **Mint** (`POST /v1/admin/invites`, admin JWT): the function generates the token, hashes it, and calls `mint_invite` with prefill (`display_name`, `sport`, `model_name`), `founding_member`, optional `referral_share_bps` override (5000 for founding seats), `max_uses` (default 1), a note, and `expires_at = now() + invite.expiry_days` (30 days, config). The raw URL is returned once, `shown_once: true`.
2. **Status** (`GET /v1/join/{token}`): the join page hashes and calls `invite_status`, getting `valid | expired | spent` plus prefill and the founding flag. Valid returns 200; expired and spent return HTTP 410 with the same shape plus a `request_url`.
3. **Redeem** (`POST /v1/join/{token}/redeem`, with the magic-link JWT): `redeem_invite` runs one transaction: create or reuse the creator row for `p_user_id` (idempotent redemption: re-posting the same user and token returns the existing creator and does not mint a second key), generate the slug (slugified display name, short suffix on collision), create the model, insert the key row from the function-generated prefix and hash, apply the token's founding flag and share bps, and increment `use_count`. `use_count >= max_uses` afterward makes the token spent for the next caller.
4. **Expiry or spent is never an error page.** The join page renders a friendly state explaining what happened, with a one-field form (`POST /v1/join/request`: email plus note, always 200) that writes an admin notification row so the founder can mint a fresh link. A dead link from a month-old DM should convert, not bounce.

Usage caps: `max_uses > 1` supports a small-group invite (one link to a cohort); each redemption still creates a distinct creator bound to a distinct authenticated user, so a multi-use token widens who may join, never who owns what.

## 4. Creator and admin sessions: reused Supabase magic-link auth

No new auth system is built (build prompt section 7). The existing Supabase project's Auth issues every session:

- **Join screen 1** collects only an email and calls `supabase.auth.signInWithOtp` with `emailRedirectTo` back to the join URL, so the magic link lands the person back on the flow with a session. No password, no captcha, no confirmation field. If the email already has an EdgeDesk account, the same account is used and simply gains a creator record (decided answer 3); `creators.user_id` stores the auth uuid as a plain uuid, no FK, preserving the extraction seam.
- **Dashboard and paid reads** send the session JWT as `Authorization: Bearer`. Edge functions never decode the JWT locally: `getUser` in `_shared/auth.ts` validates it against `{SB_URL}/auth/v1/user`, so token verification stays the auth server's job.
- **Admin** is the same mechanism plus an allowlist: `requireAdmin` checks the validated user id against `admin.user_ids` in `collective.config` (seeded at deploy, see DEPLOY.md). There is no admin key, no admin password, and adding an admin is a config update, not a deploy.

## 5. Credential summary

| Credential | Carried in | Stored as | Lifetime | Blast radius if leaked |
|---|---|---|---|---|
| API key `mck_live_...` | `x-collective-key` header | prefix + sha256 | Until rotated or revoked | Garbage submissions under one model, rate limited, fully attributable; no reads |
| API key `mck_test_...` | same | same | same | Test rows only; can never touch live data |
| Invite token `mci_...` | join URL | prefix + sha256 | 30 days or `max_uses` | Someone joins the Collective under their own authenticated identity; founder sees it in members list |
| Host slug | embed script tag | plain (it is public) | Forever | None: origin allowlist makes it useless off the allowlisted sites |
| Supabase JWT | `Authorization: Bearer` | not stored (verified upstream) | Supabase session lifetime | Standard session risk, scoped by the existing Auth setup |
