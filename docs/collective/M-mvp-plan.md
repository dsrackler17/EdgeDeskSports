# M. MVP Build Plan

Purpose: the Section 11 build order (phases 2 through 10) mapped to what this build actually ships on this branch, with each phase's definition of done quoted from the build prompt and a concrete verification checklist using the shipped tooling: `tools/collective/test_migrations.sh`, `tools/collective/curl-examples.sh`, `tools/collective/harness.py`, and `collective/embed-demo.html`. The final section lists exactly what remains before real money moves.

Status summary: **phases 2 through 7 are shipped in this branch. Phase 8 is shipped as admin-fed results plus grading functions. Phase 9 is shipped as deterministic views. Phase 10 is scaffolded inert behind `billing.enabled=false`.** Phase 5 remains the milestone that matters: after deploy, the invite link can go to real creators.

Conventions for the checklists: `$API` is `https://iattxbkbufslbauoumga.supabase.co/functions/v1`, keys and tokens come from the flows themselves. `curl-examples.sh` contains a working example for every endpoint and is the canonical expansion of the one-liners below.

---

## Phase 2. Foundation. SHIPPED

Migrations 1, 2, and 6 (`supabase/migrations/20260819000001`, `...0002`, `...0006`): schema `collective`, enums, config, sports, teams, aliases, games, creators, models, api_keys, invite_tokens, and the attribution, entitlement, and payout tables sitting inert. RLS deny-all, append-only triggers, key issuance and verification RPCs.

> *Done when: I can mint an invite token, create a creator via SQL, mint a key, and verify it.*

Verify:

- [ ] `tools/collective/test_migrations.sh` applies all eight migrations to a clean database in order and exits 0, then re-runs to prove forward-only idempotence of the run script.
- [ ] Same script asserts: 32 rows in `teams`, alias lookup resolves `Jags`, `WSH`, and `LA` case-insensitively, config seed count matches CONTRACT.md section 4.2.
- [ ] SQL: call `collective.mint_invite(...)` with a hashed token, insert a creator, mint a key row, then `collective.verify_key(prefix, hash)` returns the creator and model; a wrong hash returns null.
- [ ] SQL as `anon`: `select * from collective.config` fails with permission denied (grants layer), proving the deny posture.

## Phase 3. Ingest. SHIPPED

Migration 3 plus `supabase/functions/collective_ingest`: validation, normalization, canonical game resolution through `team_aliases`, quarantine, idempotency, rate limiting, late flagging, first-submission locking, coverage inputs, the full error taxonomy, and the CSV harness.

> *Done when: a valid curl writes correctly attributed rows, a bad key returns 401, duplicates do not duplicate, a post-kickoff submission is stored and marked late, and yesterday's projection survives today's.*

Verify:

- [ ] `python3 tools/collective/harness.py tools/collective/sample_moose_nfl.csv --dry-run` prints the field mapping table and per-row outcomes with zero rejects (exit 0), proving the Section 9 real-world CSV maps.
- [ ] Same harness with `--live` and a real key: 200, `counts.resolved` matches, rows visible via `/v1/activity`.
- [ ] `curl-examples.sh` ingest block: bad key returns 401 `invalid_key`; the same envelope posted twice returns `"duplicate": true` with the original submission id; an envelope whose `model` string does not match the key returns 422.
- [ ] Post a row for an already-kicked-off game (past `kickoff`): 200, row status `late`, and it never appears in `first_submissions`.
- [ ] Post a revised number for a game already covered: stored, appears in `model_movement`, the original `is_graded_candidate` row is unchanged (yesterday's projection survives today's).
- [ ] A row with an unknown team alias quarantines with a reason and the submission still succeeds (rule 8.4).

## Phase 4. Public read API. SHIPPED

Migration 5 views plus `supabase/functions/collective_public`: meta, wall, creators, models, rankings, games, consensus, activity, rules, dashboard. Caching headers, CORS, free versus paid split enforced in the response body.

> *Done when: a third party could build the entire Model Wall against the public API alone.*

Verify:

- [ ] `curl-examples.sh` public block: `/v1/meta`, `/v1/wall`, `/v1/creators/{slug}`, `/v1/models/{creator}/{model}`, `/v1/rankings`, `/v1/rules` all return the exact API-SHAPES.md shapes with no auth.
- [ ] `/v1/games` for an upcoming week without a JWT: model rows are `{"locked": true}` with **no numeric keys**; `grep` the raw response for `projected_spread` and find nothing.
- [ ] Free GET responses carry `cache-control: public, max-age=60`; `/v1/dashboard` carries `no-store`.
- [ ] The wall JSON alone contains every field the wall UI renders (the third-party test: no hidden second source).

## Phase 5. The join loop. SHIPPED

`supabase/functions/collective_join`, `collective/join.html`, `404.html` shim, credential generation, the pre-filled Universal Claude Prompt (`collective/claude-prompt-template.md` via `_shared/prompt_template.ts`), the embed snippet, and the wall a new member appears on.

> *Done when: I send a link to a stranger and they reach an ACTIVE CONTRIBUTOR profile without me touching anything, inside the friction budget, and I can prove the field count and the click count.*

Verify:

- [ ] Mint an invite via `curl-examples.sh` admin block, open `/join/{token}`: the 404.html shim lands on `collective/join.html?t={token}` with prefill applied.
- [ ] Walk the flow: screen 1 is one field (email) and one button; screen 2 has exactly three required fields (display name, sport, model name) with optional fields marked; screen 3 shows key, prompt, and snippet with three copy buttons. Total required fields across the flow: 4 of the budget's 8. Screens: 3 of 3.
- [ ] The redeem response contains the full key with `shown_once: true`; refresh the dashboard and only the prefix is visible.
- [ ] The new creator appears on `/v1/wall` immediately as `MEMBER` with the empty-state profile rendering fully; after one live submission (harness `--live`) status reads `ACTIVE CONTRIBUTOR` with no admin action.
- [ ] Expired and spent tokens land on the friendly request page, HTTP 410, never a raw error.

## Phase 6. Embed and Collective tab. SHIPPED

`collective/embed.js`, `supabase/functions/collective_embed`, origin allowlist, shadow DOM, failure states, `collective/embed-demo.html`.

> *Done when: one script tag on a plain HTML page on a different domain renders the full Collective, with a rival creator's profile visible and linking out.*

Verify:

- [ ] Serve `collective/embed-demo.html` from a local server (localhost passes via `embed.allow_localhost`): the full wall renders inside the shadow root, host creator pinned and badged, a rival's profile visible with working outbound links.
- [ ] Aggressive host CSS in the demo page (`* { all: unset }` style resets) does not affect the embed render.
- [ ] `curl-examples.sh` embed block: bootstrap with a non-allowlisted `Origin` header returns 403 `forbidden_origin`; with an allowlisted one, `Access-Control-Allow-Origin` echoes exactly that origin.
- [ ] Point `data-api` at an unreachable base: the F2 static fallback panel renders with its exact copy, nothing blank or broken.

## Phase 7. Full Collective site. SHIPPED

`collective/index.html`: wall, profiles, model detail, activity, dashboard, built from the same components reading the same public API as the embed.

> *Done when: inserting a creator row makes them appear on refresh with zero code changes.*

Verify:

- [ ] Redeem a fresh invite (or insert a creator via SQL and list it): refresh `collective/index.html` and the creator is on the wall with monogram, status, and empty-state profile. No file changed, no deploy.
- [ ] Every number on the site matches the corresponding `curl-examples.sh` response byte for byte in meaning (site renders API fields verbatim, no client-side math on records).

## Phase 8. Outcomes and grading. SHIPPED as admin-fed results plus grading functions

Migration 4 plus the admin results endpoint: the Collective stores its own closing lines and scores in `collective.results` via `POST /v1/admin/results` (feedable by the existing odds pipeline), `settle_game` and `grade_game` run the three metrics, backfill and late exclusion are structural, coverage gates rankings, rules published at `/v1/rules`.

> *Done when: every published number is reproducible from raw tables by someone who does not trust me.*

Verify:

- [ ] `curl-examples.sh` admin block: post a game slate, submit projections via the harness, post results with closing lines: response reports `settled` and `graded` counts.
- [ ] Recompute one model's record by hand from `projections` (candidates only) and `results` using the `/v1/rules` text: win pct excludes pushes, margin error matches rule 2's fallback order, Brier matches `(p - outcome)^2`. Numbers equal `model_records`.
- [ ] Confirm exclusions structurally: no `backfill`, `test`, or `late` row is a graded candidate; regrading a settled game (`grade_game` again) changes nothing (deterministic, versioned `grading_version = 1`).

## Phase 9. Consensus and rankings. SHIPPED as deterministic views

Migration 5's `consensus` and `rankings` views: unweighted mean, median, count, stddev, range, agreement, off `first_submissions` only, live origin only. Rankings threshold-gated by coverage and graded count, three boards never blended, below-threshold models listed as unranked with the reason.

Verify:

- [ ] `/v1/consensus` for a settled week: recompute mean and median for one game by hand from the candidate rows; equal.
- [ ] A model below 60 percent coverage or 20 graded games appears in `unranked` with a human-readable reason and on no board.
- [ ] Upcoming consensus without entitlement: counts only, no numbers (also exercised by the Phase 4 lock check).

## Phase 10. Billing. SCAFFOLDED INERT behind `billing.enabled=false`

Migration 6 tables live and recording (touches from day one), `collective_billing` function deployed with checkout stubbed to a labeled not-live response, ledger and earnings views real, entitlement checks real (creators unlock, anonymous callers see `billing_not_live`).

Verify now (inert):

- [ ] Browse via the embed then hit `?ref={slug}` links: `attribution_touches` rows accumulate with correct creator and source.
- [ ] `GET /v1/dashboard` earnings block returns zeros plus the exact billing-not-live note; `/v1/consensus` anonymous returns `reason: "billing_not_live"`.
- [ ] `collective_billing` checkout returns its clearly labeled not-live response, never a 500.

---

## What remains before real money

In order, all configuration and Stripe-side work, no schema or endpoint changes:

1. **Stripe products and prices.** Create the $20 monthly and $200 annual prices in the existing Stripe account; set secrets `COLLECTIVE_PRICE_MONTHLY`, `COLLECTIVE_PRICE_ANNUAL`, and `COLLECTIVE_STRIPE_SECRET`.
2. **Webhook secret.** Register the `collective_billing` webhook endpoint in Stripe and set `COLLECTIVE_STRIPE_WEBHOOK_SECRET`; verify signature checking against a Stripe CLI test event.
3. **Flip `billing.enabled` to `true`** in `collective.config`. Checkout goes live, entitlement switches from `billing_not_live` to `subscription_required`, ledger entries start posting on paid invoices against already-locked attributions.
4. **Stripe Connect onboarding flow.** Enable Connect on the account and wire the post-first-submission onboarding ask into `payout_accounts`; first payout run follows the net 30 and $50 minimum rules from L-economics.md.

Until step 3, everything upstream (attribution, touches, dashboards, entitlement plumbing) runs and records, which is the point of rule 8.13.
