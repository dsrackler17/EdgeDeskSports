# DEPLOY.md, the Model Collective runbook

Purpose: the exact, ordered steps to deploy the Model Collective into the existing Supabase project (`iattxbkbufslbauoumga`) and the existing GitHub Pages site, plus the smoke checklist that proves the deployment end to end and the local test loop for migrations. Run the steps in order; each is idempotent unless noted.

Prerequisites: Supabase CLI logged in with access to the project, Docker (for the local test loop only), and the project's dashboard open for step 3.

## 1. Link the repo to the project

```bash
cd /path/to/EdgeDeskSports
supabase link --project-ref iattxbkbufslbauoumga
```

## 2. Apply the migrations

Eight forward-only migrations, one logical change each, dated `20260819000001` through `20260819000008` (foundation, creators, submissions, grading, views, commerce, rpcs, seeds):

```bash
supabase db push
```

Verify: `supabase migration list` shows all eight applied. Never edit an applied migration; a fix is a new migration.

## 3. Expose the `collective` schema to PostgREST (dashboard)

Dashboard: Project Settings, Data API (API settings), add `collective` to **Exposed schemas**. Save.

**Why this is safe**: `anon` and `authenticated` hold no grants on the `collective` schema at all, not even USAGE, and RLS is enabled on every table with zero policies as a second lock. Exposure only means PostgREST will route `Accept-Profile: collective` / `Content-Profile: collective` requests to the schema; every such request from a client role hits a permission error before touching a row. The edge functions need the exposure because they call the RPCs through PostgREST with the service role and `Content-Profile: collective`. This mirrors how the existing app already exposes extra schemas (ufc, tennis, wta, cfb).

## 4. Deploy the six edge functions

`supabase/config.toml` carries `verify_jwt = false` for each function (they do their own auth).

```bash
supabase functions deploy collective_ingest
supabase functions deploy collective_public
supabase functions deploy collective_embed
supabase functions deploy collective_join
supabase functions deploy collective_admin
supabase functions deploy collective_billing
```

## 5. Set function secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform automatically. Set the Collective's own secrets (Dashboard: Edge Functions, Secrets, or the CLI):

```bash
supabase secrets set COLLECTIVE_BASE_URL="https://edgedesksports.com"
# Billing stays inert until these are real; set placeholders now or skip until Phase 10:
supabase secrets set COLLECTIVE_STRIPE_SECRET="sk_live_..."
supabase secrets set COLLECTIVE_STRIPE_WEBHOOK_SECRET="whsec_..."
supabase secrets set COLLECTIVE_PRICE_MONTHLY="price_..."
supabase secrets set COLLECTIVE_PRICE_ANNUAL="price_..."
```

`collective_billing` returns a clearly labeled not-live response until the Stripe secrets are set and `billing.enabled` is flipped in config. Do not flip `billing.enabled` in this deploy.

## 6. Seed the admin allowlist

Find your auth user id (Dashboard: Authentication, Users), then in the SQL editor:

```sql
update collective.config
   set value = '["YOUR-AUTH-USER-UUID"]'::jsonb, updated_at = now()
 where key = 'admin.user_ids';
```

Multiple admins: `'["uuid-1","uuid-2"]'`. This is the only manual data step; everything else was seeded by migration 8.

## 7. Publish the frontend

Nothing to do: GitHub Pages publishes the repo, so the `collective/` directory (index.html, join.html, admin.html, embed.js, embed-demo.html) and the root `404.html` join shim go live automatically on merge to the published branch. Confirm `https://edgedesksports.com/collective/` renders after the Pages build completes.

## 8. Smoke checklist, in order

```bash
API="https://iattxbkbufslbauoumga.supabase.co/functions/v1"
```

1. **Meta** (proves public function, schema exposure, config seeds):

```bash
curl -s "$API/collective_public/v1/meta"
# expect: name, pricing {2000, 20000}, billing_live false, NFL in sports
```

2. **Mint an invite** (proves admin auth and the allowlist from step 6). Get an admin JWT by signing in on the site and copying the session access token, then:

```bash
curl -s -X POST "$API/collective_admin/v1/admin/invites" \
  -H "Authorization: Bearer $ADMIN_JWT" -H "content-type: application/json" \
  -d '{ "prefill": { "display_name":"Smoke Test", "sport":"NFL", "model_name":"Smoke Model" },
        "founding": false, "share_bps": null, "max_uses": 1, "note": "deploy smoke" }'
# expect: invite_url https://edgedesksports.com/join/mci_..., shown_once true
```

3. **Join dry-walkthrough** (proves the 404 shim, token status, magic link, redemption):
   - Open the `invite_url` in a browser. The 404 shim must land on `collective/join.html?t=mci_...` showing the prefill, not an error page.
   - Or check status headlessly first: `curl -s "$API/collective_join/v1/join/mci_..."` expecting `"status":"valid"` with the prefill.
   - Walk the three screens with a real email: magic link arrives, returns to the flow, screen 2 posts the profile, screen 3 shows the key once, the prompt, and the embed snippet. Copy the key as `$KEY`.

4. **Whoami** (proves key minting, prefix lookup, hash verification):

```bash
curl -s "$API/collective_ingest/v1/whoami" -H "x-collective-key: $KEY"
# expect: creator slug, model, sport NFL, key prefix, limits {500, 60}
```

5. **Dry-run** (proves validation, team alias resolution, game resolution, writes nothing). Seed a game first if the slate is empty (`POST /v1/admin/games`), then:

```bash
curl -s -X POST "$API/collective_ingest/v1/projections/dry-run" \
  -H "x-collective-key: $KEY" -H "content-type: application/json" \
  -d '{ "sport":"NFL", "season":2026, "week":1, "data_origin":"live",
        "rows":[{ "game_ref":"SMOKE_1", "home_team":"KC", "away_team":"BUF",
                  "kickoff":"2026-09-11T00:20:00Z", "projected_spread":-3.5 }] }'
# expect: dry_run true, submission_id null, counts.rows 1, row status resolved (or quarantined with a reason if the game is not seeded)
```

6. **Wall** (proves the derived views end to end):

```bash
curl -s "$API/collective_public/v1/wall"
# expect: the smoke creator's row, membership MEMBER (no live submission yet), record null
```

Cleanup: the smoke creator can be unlisted from the admin console; the append-only tables keep the dry run nowhere (it wrote nothing).

## 9. Local test loop

Migrations are proven locally before every push:

```bash
tools/collective/test_migrations.sh
```

The script starts a disposable local Postgres (via `supabase db start` or a plain Docker Postgres), applies all eight migrations in order against a clean database, and fails on any error, so a broken migration never reaches the hosted project. Run it after touching anything under `supabase/migrations/`. The full ingest behavior loop is `tools/collective/harness.py sample_moose_nfl.csv --dry-run` against a local `supabase functions serve` or against production with a test key (`mck_test_`, forced `data_origin='test'`).

## 10. Rollback posture

- Migrations are forward-only: to undo, write a new down-style migration, never edit or delete an applied file.
- Functions: redeploy the previous version from git history.
- Config numbers: UPDATE `collective.config`, effective immediately, no deploy.
- The schema exposure (step 3) can be removed in the dashboard at any time; only the edge functions would notice.
