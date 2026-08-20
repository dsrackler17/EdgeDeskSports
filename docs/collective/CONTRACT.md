# MODEL COLLECTIVE, BUILD CONTRACT

This file is the single source of truth for names, shapes, numbers, and conventions across the whole build. Every migration, edge function, page, script, and doc conforms to this contract. If a deliverable disagrees with this file, the deliverable is wrong.

Style rule for every file in this build: no em dashes anywhere, in code comments, docs, or user-facing copy. Use commas, colons, or periods.

---

## 1. Decided answers to the open questions (Section 12 of the build prompt)

These were decided during the autonomous build. Each is reversible and each is recorded here so it can be argued later.

1. **Same Supabase project.** Everything lives in a dedicated Postgres schema named `collective` inside the existing project `iattxbkbufslbauoumga`. No cross-schema foreign keys in either direction, so the schema can be lifted to its own project with a schema dump and a DNS change. Reuses existing Auth and the Stripe account. Rationale: the repo already runs multiple isolated schemas (ufc, tennis, wta, cfb) this way.
2. **Route inside the existing site.** The Collective ships as `collective/index.html`, `collective/join.html`, `collective/admin.html`, and `collective/embed.js` on the existing GitHub Pages site (edgedesksports.com). A `404.html` shim gives the pretty invite route `/join/{token}` by redirecting to `collective/join.html?t={token}`. A standalone domain later is a config change (`BASE_URL`), not a rebuild.
3. **Existing accounts can become creators.** A creator record references an auth user id (stored as a plain uuid, no FK). If an invited email already has an EdgeDesk account, the same account gains a creator record. New creators sign in by email magic link.
4. **Sports in scope for v1: NFL.** The schema is multi-sport from day one; `teams` and `team_aliases` are seeded for all 32 NFL teams with common alias variants. Closing lines: the Collective stores its own closing lines in `collective.results`, entered through the admin results endpoint (which can be fed by the existing odds pipeline). Grading never uses a creator's line.
5. **Coverage threshold to be ranked: 60 percent** of the games in that sport's season to date, and at least 20 graded games for record-based rankings. Both live in `collective.config` (`ranking.min_coverage_pct`, `ranking.min_graded_games`) and can be overridden per sport via `ranking.per_sport` config JSON.
6. **Retention on departure:** submissions are append-only and stay in the historical record (the public record is the product and it does not get holes when someone leaves). The profile is unlisted (`is_listed=false`), keys are revoked, and personal fields (website, socials, logo) can be cleared on request. Stated in the join flow terms line.
7. **Repo findings that shaped the design:** the repo has no `supabase/` directory, so database objects currently live only in the hosted project. This build establishes `supabase/migrations/` and `supabase/functions/` in the repo as the source of truth going forward. The existing app exposes extra PostgREST schemas via `accept-profile`, which is why exposing the `collective` schema (locked to `service_role` only) is consistent with existing practice.

---

## 2. Repository layout added by this build

```
docs/collective/           architecture docs A through N, plus this contract and DEPLOY.md
supabase/config.toml       minimal CLI config (per-function verify_jwt flags)
supabase/migrations/       forward-only SQL migrations, numbered
supabase/functions/
  _shared/                 shared Deno modules (config, cors, keys, errors, db)
  collective_ingest/       submission API
  collective_public/       public read API
  collective_embed/        embed bootstrap API
  collective_join/         invite validation and redemption
  collective_admin/        founder console API (invites, quarantine, results, games)
collective/
  index.html               the Collective site (wall, profiles, rankings, consensus, dashboard)
  join.html                three-screen onboarding
  admin.html               founder console UI
  embed.js                 the embed script (self-contained, no dependencies)
  embed-demo.html          plain host page proving the embed on a foreign origin
  claude-prompt-template.md  Universal Creator Prompt template with placeholders
404.html                   pretty-route shim for /join/{token}
tools/collective/
  harness.py               CSV ingest test harness (dry run and live)
  sample_moose_nfl.csv     real-world-shaped sample CSV (Section 9 shape)
  curl-examples.sh         working curl examples for every endpoint
```

Existing files are not modified except: none. Nothing in `app.html`, `index.html`, or `admin.html` changes. The Collective is additive.

---

## 3. Frontend constants (every page and the embed)

```js
window.COLLECTIVE_CONFIG = {
  SB_URL:  "https://iattxbkbufslbauoumga.supabase.co",
  SB_ANON: "<same anon key app.html uses>",
  BASE_URL: "https://edgedesksports.com",         // site root
  API: "https://iattxbkbufslbauoumga.supabase.co/functions/v1"
};
```

Design tokens, identical to app.html so the Collective reads as part of the terminal:

```css
:root{--bg:#0d0f13;--surface:#13161c;--surface2:#191d25;--border:#262c36;
--text:#e7eaf0;--dim:#8a93a2;--faint:#5b6472;--accent:#4d8dff;--pos:#2fb47c;
--neg:#e26044;--warn:#d99a2b;--gold:#e3b84d;--mdl:#9b8cff}
```

Fonts: Inter for text, JetBrains Mono for numbers and tabular data. Dark, dense, no cards inside cards, no gradients, no decorative animation. Light theme for the embed only, driven by `data-theme="light"`, same tokens inverted.

---

## 4. Database: schema `collective`

Migration files (forward-only, one logical change each):

```
supabase/migrations/20260819000001_collective_foundation.sql   schema, enums, config, sports, teams, aliases, games
supabase/migrations/20260819000002_collective_creators.sql     creators, models, api_keys, invite_tokens
supabase/migrations/20260819000003_collective_submissions.sql  submissions, projections, append-only enforcement, resolution
supabase/migrations/20260819000004_collective_grading.sql      results, grades, grading functions
supabase/migrations/20260819000005_collective_views.sql        wall, coverage, rankings, consensus, movement, activity, status derivation
supabase/migrations/20260819000006_collective_commerce.sql     embed installs/events, attribution, subscribers, earnings, payouts, wholesale (inert)
supabase/migrations/20260819000007_collective_rpcs.sql         SECURITY DEFINER API functions called by edge functions
supabase/migrations/20260819000008_collective_seeds.sql        config values, NFL teams and aliases, sport seasons
```

### 4.1 Enums (all in schema `collective`)

```sql
create type collective.data_origin        as enum ('live','backfill','test');
create type collective.resolution_status  as enum ('resolved','quarantined');
create type collective.pick_side          as enum ('home','away');
create type collective.total_side         as enum ('over','under');
create type collective.grade_result       as enum ('win','loss','push');
create type collective.game_status        as enum ('scheduled','final','canceled','postponed');
create type collective.key_scope          as enum ('submit');
create type collective.key_status         as enum ('active','revoked');
create type collective.creator_status     as enum ('active','departed');
create type collective.billing_mode      as enum ('referral','wholesale');
create type collective.sub_status         as enum ('active','past_due','canceled','refunded');
create type collective.ledger_type        as enum ('earning','clawback','payout','adjustment');
create type collective.embed_event_type   as enum ('impression','profile_view','outbound_click','collective_click','subscribe_click');
```

Membership status (ACTIVE CONTRIBUTOR, MEMBER, INACTIVE) is **not** an enum column anywhere. It is derived in the `model_wall` view (rule 8.8). Same for founding member benefits: `founding_member` is a display flag, the money number is `referral_share_bps`.

### 4.2 Tables

Conventions: every table gets `id uuid primary key default gen_random_uuid()` unless noted, `created_at timestamptz not null default now()`. All timestamps timestamptz. Money in integer cents. Shares in basis points (bps). No cross-schema FKs.

**config** `(key text pk, value jsonb not null, description text, updated_at)`
Seeded keys and values (the Section 5 numbers live here and only here):

| key | value |
|---|---|
| `pricing.monthly_cents` | `2499` |
| `pricing.annual_cents` | `0` |
| `share.referral_bps_default` | `4000` |
| `share.founding_bps` | `5000` |
| `share.founding_seats` | `10` |
| `wholesale.seat_cents` | `1400` |
| `wholesale.min_seats` | `10` |
| `wholesale.floor_cents` | `2000` |
| `payout.min_cents` | `5000` |
| `payout.net_days` | `30` |
| `payout.clawback_days` | `60` |
| `ranking.min_coverage_pct` | `60` |
| `ranking.min_graded_games` | `20` |
| `ranking.per_sport` | `{}` |
| `status.active_days` | `10` |
| `status.inactive_days` | `45` |
| `billing.enabled` | `false` |
| `invite.expiry_days` | `30` |
| `ingest.max_rows` | `500` |
| `ingest.max_bytes` | `524288` |
| `ingest.rate_per_hour` | `60` |
| `admin.user_ids` | `[]` (uuid strings) |
| `embed.cache_seconds` | `60` |
| `embed.allow_localhost` | `true` |

**sports** `(code text pk, name text, spread_convention text default 'home', active bool)`  seed: NFL.
**sport_seasons** `(id, sport_code fk sports, season int, starts_on date, ends_on date, unique(sport_code, season))`  seed: NFL 2026, 2026-09-04 to 2027-02-08.
**teams** `(id, sport_code fk, code text, name text, unique(sport_code, code))`  32 NFL teams.
**team_aliases** `(id, sport_code, alias text, team_id fk teams, unique(sport_code, lower(alias)) via unique index)`  seeded with codes, city names, full names, common variants (WAS/WSH, JAX/JAC, LA/LAR, ARI/ARZ, OAK to LV note, SD to LAC note, etc.). Alias matching is case-insensitive on `lower(trim(alias))`.
**games** `(id, sport_code fk, season int, week int null, kickoff_at timestamptz, home_team_id fk, away_team_id fk, status collective.game_status default 'scheduled', external_ref text null)`  unique index on `(sport_code, season, home_team_id, away_team_id, (kickoff_at at time zone 'UTC')::date)`.

**creators** `(id, user_id uuid null unique, slug text unique check slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$', display_name text not null, description text, website_url text, x_handle text, logo_url text, status collective.creator_status default 'active', is_listed bool default true, founding_member bool default false, referral_share_bps int not null default 4000, billing_mode collective.billing_mode default 'referral', pinned_model_id uuid null, invite_token_id uuid null, created_at)`

**models** `(id, creator_id fk creators on delete restrict, slug text, name text not null, sport_code fk sports, description text, is_listed bool default true, created_at, unique(creator_id, slug))`

**api_keys** `(id, creator_id fk, model_id fk null, scope collective.key_scope default 'submit', key_prefix text not null unique, key_hash text not null, status collective.key_status default 'active', last_used_at timestamptz, revoked_at timestamptz, created_at)`
Key format: `mck_live_{prefix}{secret}` where prefix is 8 base62 chars and secret is 32 base62 chars. Stored: `key_prefix` (the 8 chars) and `key_hash = sha256 hex of the full key string`. Shown once. Verification: look up by prefix, compare hash. Test keys: `mck_test_` prefix, same table, and submissions made with them are forced to `data_origin='test'`.

**invite_tokens** `(id, token_hash text unique, token_prefix text, prefill jsonb default '{}', founding_member bool default false, referral_share_bps int null, max_uses int default 1, use_count int default 0, expires_at timestamptz not null, note text, created_by uuid null, created_at)`
Raw token: `mci_{24 base62 chars}`, sha256 stored. Prefill keys: `display_name`, `sport`, `model_name`.

**submissions** `(id, model_id fk models, api_key_id fk api_keys, received_at timestamptz not null default now(), data_origin collective.data_origin not null, client_generated_at timestamptz null, source_note text null, payload_hash text not null, n_rows int, n_resolved int, n_quarantined int, n_late int, created_at, unique(model_id, payload_hash))`
Append-only. `received_at` is server time and is the only time trusted anywhere (rule 8.6).

**projections** `(id, submission_id fk submissions, model_id fk models, game_id fk games null, raw_game_ref text not null, raw_row jsonb not null, resolution_status collective.resolution_status not null, quarantine_reason text null, sport_code text not null, season int, week int null, pick_side collective.pick_side null, total_side collective.total_side null, line_at_submission numeric null, projected_spread numeric null, projected_total numeric null, proj_home_score numeric null, proj_away_score numeric null, home_win_prob numeric null check (home_win_prob between 0 and 1), cover_prob numeric null check (cover_prob between 0 and 1), confidence numeric null, data_origin collective.data_origin not null, received_at timestamptz not null, is_late bool not null default false, is_graded_candidate bool not null default false, created_at)`

Append-only (rule 8.3). Spread convention: home side, negative means home favored (tracker convention). `home_win_prob` is moneyline, `cover_prob` is against `line_at_submission`; validation rejects a row where `cover_prob` is present without `line_at_submission` and flags obvious mismatch (rule 9.2): if `pick_side` and `home_win_prob` and `projected_spread` all present and `sign(projected_spread)` contradicts `home_win_prob` by more than the config guard, the row is stored but quarantined with reason `suspect_probability_mismatch`? No: rule 9.2 says reject obvious mismatch. Decision: hard-reject the row (row-level error in response) when `home_win_prob > 0.5` while `projected_spread > 3`, or `home_win_prob < 0.5` while `projected_spread < -3`. Everything else passes.

First-submission lock (rule 8.5), enforced structurally:
```sql
create unique index projections_first_lock on collective.projections(model_id, game_id)
  where is_graded_candidate;
```
`is_graded_candidate` is computed inside the ingest RPC transaction: true only when `resolution_status='resolved'`, `data_origin='live'`, `is_late=false`, and no prior candidate row exists for `(model_id, game_id)`. Later rows are movement.
`is_late` is `received_at > games.kickoff_at`, computed in the same transaction against the canonical kickoff, never against payload time.

**results** `(game_id pk fk games, home_score int not null, away_score int not null, closing_spread numeric null, closing_total numeric null, closing_home_ml_prob numeric null, source text, settled_at timestamptz default now())`  Collective-owned closes, home convention (same sign convention as projections).

**grades** `(projection_id pk fk projections, game_id fk, model_id fk, pick_result collective.grade_result null, margin_error numeric null, total_error numeric null, brier numeric null, grading_version int not null, graded_at timestamptz default now())`
Three metrics, never blended (rule 8.11). Pick graded against `results.closing_spread`, push on the exact number is `push` and excluded from win pct. Margin error `abs((proj_home_score - proj_away_score) - (home_score - away_score))`, falling back to `abs(-projected_spread - actual_margin)` when scores absent but spread present. Brier `(home_win_prob - home_won)^2`. Only `is_graded_candidate` rows are graded. Reproducible from raw tables by anyone.

**embed_installs** `(id, creator_id fk, origin text not null, status text default 'active', last_seen_at timestamptz, created_at, unique(creator_id, lower(origin)) via index)`  Origin format `https://example.com` (scheme + host, no path).

**embed_events** `(id, creator_id fk null, event_type collective.embed_event_type, visitor_id text null, target_creator_id uuid null, path text, referrer text, origin text, occurred_at timestamptz default now())`  Append-only, sampled client-side, powers engagement and attribution evidence.

**attribution_touches** `(id, visitor_id text not null, creator_id fk, source text check (source in ('embed','link')), origin text, touched_at timestamptz default now())`  First touch per visitor wins; index on `(visitor_id, touched_at)`.

**attributions** `(id, subscriber_user_id uuid null, subscriber_email_hash text null, creator_id fk creators, visitor_id text, source text, locked_at timestamptz not null default now(), unique(subscriber_user_id), unique(subscriber_email_hash))`  Locked at conversion, no update path (rule: attribution never moves).

**subscribers** `(id, user_id uuid unique, email text, status collective.sub_status, plan text check (plan in ('monthly','annual')), stripe_customer_id text, stripe_subscription_id text unique, attribution_id fk attributions null, current_period_end timestamptz, started_at, canceled_at, created_at)`  The Collective's own paid tier (Mode A). Inert until `billing.enabled`.

**earnings_ledger** `(id, creator_id fk, subscriber_id fk subscribers null, entry_type collective.ledger_type, amount_cents int not null, period_month date not null, available_at timestamptz, stripe_ref text, note text, created_at)`  Earnings post per paid invoice at the creator's `referral_share_bps`; annual pays on full amount when it clears; clawback entries negative within `payout.clawback_days`; payout entries negative when paid out; `available_at = period close + payout.net_days`. Balance = sum. `$50` minimum from `payout.min_cents`.

**payout_accounts** `(creator_id pk fk, stripe_connect_id text, status text default 'unstarted', requested_at, connected_at)`  Stripe Connect requested only after first successful live submission, never at signup.

**wholesale_seats** `(id, creator_id fk, period_month date, seat_count int check (seat_count >= 10), reported_at, invoiced bool default false, unique(creator_id, period_month))`  Mode B seat reporting, min 10 seats, `wholesale.seat_cents` each.

**api_request_log** `(id bigint generated always as identity pk, api_key_id uuid, endpoint text, at timestamptz default now())`  Rate limiting window queries; pruned by maintenance.

### 4.3 Append-only enforcement (rule 8.3)

For `submissions`, `projections`, `embed_events`, `earnings_ledger`, `attributions`, `api_request_log`:

```sql
revoke update, delete on collective.<t> from public, anon, authenticated;
```
plus a BEFORE UPDATE OR DELETE trigger raising exception unless `current_setting('collective.maintenance', true) = 'on'`; the service-role maintenance path (quarantine resolution, GDPR erasure) sets that GUC inside a SECURITY DEFINER function. Quarantine resolution updates only `game_id`, `resolution_status`, `quarantine_reason`, `is_late`, `is_graded_candidate` on quarantined rows.

### 4.4 Views (all in `collective`, all `security_invoker = off`, owned by postgres)

- **latest_projections**: newest row per `(model_id, game_id)` regardless of candidacy.
- **first_submissions**: rows where `is_graded_candidate`.
- **model_movement**: all resolved rows per `(model_id, game_id)` ordered by `received_at`, exposing the drift from the first submission.
- **model_records**: per model: graded W/L/P, win pct (pushes excluded), margin MAE, total MAE, mean Brier, n graded, last live submission at. Backfill and test are excluded by construction (they are never graded candidates).
- **model_coverage**: per model, sport, season, week: `games_available` (games in that sport-week with kickoff within the season window) vs `games_submitted` (first submissions). Plus a season-to-date rollup `model_coverage_totals` with `coverage_pct`.
- **membership_status** (per creator): `ACTIVE CONTRIBUTOR` if any live resolved submission within `status.active_days` and the sport is in season, or first live submission ever made and within window; `MEMBER` if no live submission yet, or out of season; `INACTIVE` if in season and silent for `status.inactive_days`. Derived, never stored (rule 8.8).
- **model_wall**: one row per listed model of a listed active creator: creator slug and name and logo/monogram, model name, sport, membership status, record summary, coverage pct, last submission, founding flag.
- **rankings**: model_records joined with coverage, filtered to `coverage_pct >= ranking.min_coverage_pct` and `n_graded >= ranking.min_graded_games`, ranked separately per metric (win pct, margin MAE, Brier). Never a blended score. Below-threshold models appear in an `unranked` list with the reason.
- **consensus**: per upcoming or settled game: n models, mean and median and stddev and range of `projected_spread` and `projected_total`, mean `home_win_prob`, pct of picks on home, agreement rate. Off `first_submissions` only, live origin only (rule 8.9). Deterministic SQL.
- **quarantine_queue**: quarantined projections with raw ref and reason, admin view.
- **creator_earnings_monthly**: ledger rollup per creator per month: earned, clawed back, paid, balance, available balance.

### 4.5 RLS and grants

- The `collective` schema is added to PostgREST exposed schemas (documented in DEPLOY.md), but `anon` and `authenticated` get **no grants at all**, not even USAGE on the schema. Every read and write goes through edge functions using the service role. RLS is additionally enabled on every table with no policies (deny) as defense in depth; `service_role` bypasses RLS.
- All RPCs are `SECURITY DEFINER`, `set search_path = collective, public`, executable by `service_role` only (`revoke execute from public, anon, authenticated`).

### 4.6 RPCs (migration 7), called only by edge functions

```
collective.verify_key(p_prefix text, p_hash text) -> jsonb            key row + creator + model or null; touches last_used_at
collective.rate_check(p_key_id uuid, p_endpoint text) -> boolean       sliding hour window vs config
collective.ingest_submission(p_key jsonb, p_envelope jsonb) -> jsonb   full transactional ingest, returns per-row outcomes
collective.resolve_game_ref(p_sport text, p_season int, p_home text, p_away text, p_kickoff timestamptz) -> uuid
collective.mint_invite(p_admin uuid, p_prefill jsonb, p_founding bool, p_share_bps int, p_max_uses int, p_note text, p_token_hash text, p_token_prefix text) -> jsonb
collective.invite_status(p_token_hash text) -> jsonb                   valid | expired | spent, plus prefill
collective.redeem_invite(p_token_hash text, p_user_id uuid, p_email text, p_profile jsonb, p_key_prefix text, p_key_hash text) -> jsonb   creates creator, model, key row, marks token use, all in one tx; returns ids and slugs
collective.admin_resolve_quarantine(p_projection_id uuid, p_game_id uuid) -> jsonb   maintenance path, recomputes is_late and candidacy
collective.upsert_games(p_admin uuid, p_games jsonb) -> jsonb
collective.settle_game(p_admin uuid, p_game_id uuid, p_result jsonb) -> jsonb   writes results, runs grading for that game
collective.grade_game(p_game_id uuid) -> int                           grades all candidate projections for the game, grading_version 1
collective.record_touch(p_visitor text, p_creator_slug text, p_source text, p_origin text) -> void   first-touch attribution capture
collective.lock_attribution(p_user_id uuid, p_email_hash text) -> jsonb  finds earliest touch for visitor, locks; called by billing webhook
collective.get_config(p_key text) -> jsonb
```

`redeem_invite` slug generation: slugify display name, disambiguate with short suffix on collision. Reuses the caller's existing creator row if `p_user_id` already has one (idempotent redemption).

---

## 5. API surface, `/collective/v1/`, all via Supabase Edge Functions

Base: `https://iattxbkbufslbauoumga.supabase.co/functions/v1`. Each function routes internal paths under `/v1/`. All functions set `verify_jwt=false` in config.toml and do their own auth. All responses JSON, UTF-8. Error shape everywhere:

```json
{ "error": { "code": "invalid_payload", "message": "human sentence", "details": [ ... ] } }
```

Error codes: `invalid_key` 401, `revoked_key` 401, `forbidden` 403, `forbidden_origin` 403, `not_found` 404, `entitlement_required` 402, `token_invalid` 404, `token_expired` 410, `token_spent` 410, `rate_limited` 429, `payload_too_large` 413, `invalid_payload` 422, `conflict` 409, `server_error` 500.

CORS: `collective_public` and `collective_join`: `Access-Control-Allow-Origin: *` (GET) or site origins (POST join). `collective_embed`: dynamic per-origin allow from `embed_installs`. `collective_ingest`: `*` (keys are the auth; browser use is discouraged but a static-site creator testing from a page must not be blocked by CORS, the docs push them to the GitHub Action path).

### 5.1 collective_ingest (auth: `x-collective-key` header, submission key)

| Method, path | Purpose |
|---|---|
| `GET  /v1/whoami` | key check: creator, model, sport, key prefix, mode |
| `POST /v1/projections` | submit a slate (envelope below) |
| `POST /v1/projections/dry-run` | identical validation and resolution, writes nothing, returns what would happen. This is the test endpoint the Universal Prompt uses first |

Envelope (rule 8.2: identity comes from the key; name strings are checked, not trusted):

```json
{
  "model": "nfl-model",              // optional, must match key's model if present
  "sport": "NFL",                    // required
  "season": 2026,                    // required
  "week": 3,                          // optional
  "data_origin": "live",             // required: live | backfill | test
  "generated_at": "2026-09-18T14:00:00Z",   // optional, stored, never trusted for timing
  "idempotency_key": "anything",     // optional; else hash of rows
  "rows": [ {
      "game_ref": "NFL_2026_W3_BUF_KC",   // required, stored verbatim forever
      "home_team": "KC",              // required
      "away_team": "BUF",             // required
      "kickoff": "2026-09-21T00:20:00Z",  // required, used for resolution only
      "pick_side": "home",            // optional: home | away
      "total_side": "over",           // optional
      "line_at_submission": -2.5,      // optional, required if cover_probability present
      "projected_spread": -3.5,        // optional, home convention, negative = home favored
      "projected_total": 47.5,         // optional
      "proj_home_score": 27,           // optional
      "proj_away_score": 24,           // optional
      "home_win_probability": 0.61,    // optional, moneyline probability, 0..1
      "cover_probability": 0.55,       // optional, vs line_at_submission, 0..1
      "confidence": 7.5                // optional, creator-defined scale, never aggregated
  } ]
}
```

Response 200:

```json
{
  "submission_id": "…", "received_at": "…", "data_origin": "live",
  "counts": { "rows": 14, "resolved": 13, "quarantined": 1, "late": 0, "first": 12, "movement": 1, "rejected": 0 },
  "rows": [ { "game_ref": "…", "status": "resolved|quarantined|rejected|late", "game_id": "…", "reason": null } ],
  "duplicate": false
}
```

Rules enforced inside one transaction: max rows and bytes from config, per-key hourly rate limit, idempotent replay by `(model_id, payload_hash)` returns the original result with `duplicate: true`, quarantined rows never fail the submission (rule 8.4), late rows stored and flagged (8.6), first-submission lock (8.5), test-key or `data_origin` mismatch handling: a `mck_test_` key forces `test`.

### 5.2 collective_public (auth: none for free; `Authorization: Bearer <supabase JWT>` for paid and dashboard)

| Method, path | Access | Purpose |
|---|---|---|
| `GET /v1/meta` | free | price, sports, season, counts, config surface |
| `GET /v1/wall` | free | the model wall rows |
| `GET /v1/creators/{slug}` | free | profile: bio, links, models, records, coverage, backfill shown separately |
| `GET /v1/models/{creator}/{model}` | free | record detail, per-week coverage, movement summary |
| `GET /v1/rankings` | free | ranked and unranked lists with reasons, rules link |
| `GET /v1/games?sport=NFL&week=3&season=2026` | free for settled, paid for upcoming | settled games with results and per-model graded rows; upcoming games return `locked: true` per model row without numbers unless entitled |
| `GET /v1/consensus?sport=&week=` | paid | consensus rows (upcoming); settled consensus is free |
| `GET /v1/activity` | free | recent submissions feed (model, n rows, when; numbers only if settled or entitled) |
| `GET /v1/dashboard` | creator JWT | own profile, key prefixes, embed origins, earnings summary, referred and retained counts |
| `POST /v1/dashboard/profile` | creator JWT | edit bio, links, logo, pinned model |
| `POST /v1/dashboard/keys/rotate` | creator JWT | new key issued, old revoked, shown once |
| `POST /v1/dashboard/origins` | creator JWT | add or remove embed origins |
| `GET /v1/rules` | free | published grading rules text |

The paid gate lives in the response (rule: entitlement checked by the Collective, gate in the API, not in DOM). `locked` rows contain no projection numbers at all. Entitlement = active row in `collective.subscribers` for the JWT user, or `billing.enabled=false` mode note: while billing is off, paid endpoints return `locked` with `reason: "billing_not_live"` for anonymous callers and unlock for signed-in members and creators (creators always see the full board: they contributed to it).

Caching: `cache-control: public, max-age=60` on free GETs, `no-store` on paid and dashboard.

### 5.3 collective_embed (auth: Origin allowlist; the page carries only the public host slug)

| Method, path | Purpose |
|---|---|
| `GET /v1/embed/bootstrap?host={slug}&theme={dark\|light}` | one payload: wall, host pin info, creators directory, settled highlights, subscribe CTA URL with `?ref={slug}`, cache TTL |
| `POST /v1/embed/events` | batched embed_events (impression, clicks), fire-and-forget |

Origin enforcement: the `Origin` (fallback `Referer`) host must match an active `embed_installs` row for that creator, else 403 `forbidden_origin` and the embed renders its static fallback. `edgedesksports.com` and localhost (when `embed.allow_localhost`) always pass. Response CORS echoes only the matched origin. A lifted slug is useless elsewhere (the allowlist is the lock; there is no secret in the page).

Host pinning: the payload marks the host creator so the embed can pin them to the top. Nothing else about ordering or content varies by host (Section 4 hard rule); the payload is built identically then annotated.

### 5.4 collective_join (auth: invite token; magic link via Supabase Auth on the client)

| Method, path | Purpose |
|---|---|
| `GET  /v1/join/{token}` | status: valid, expired, spent; prefill; founding flag |
| `POST /v1/join/{token}/redeem` | body: profile fields; auth: Bearer JWT from the magic-link session; creates creator, model, slug, key; returns key (once), prompt text, embed snippet, profile URL |
| `POST /v1/join/request` | expired or spent token page: email + note, writes an admin notification row (config email later), always 200 |

The client flow: screen 1 collects email and calls `supabase.auth.signInWithOtp` with `emailRedirectTo` back to the join URL. The magic link returns with a session; screen 2 posts profile; screen 3 renders from the redeem response. Redeem is idempotent per user + token.

### 5.5 collective_admin (auth: Bearer JWT whose user id is in `admin.user_ids` config)

| Method, path | Purpose |
|---|---|
| `POST /v1/admin/invites` | mint invite: prefill, founding, share bps, max uses, note; returns the raw link once |
| `GET  /v1/admin/invites` | list with status |
| `GET  /v1/admin/members` | creators with keys, status, coverage, origin lists |
| `GET  /v1/admin/quarantine` | quarantine queue |
| `POST /v1/admin/quarantine/{id}/resolve` | body: game_id or new alias (sport, alias, team code) then re-resolve |
| `POST /v1/admin/games` | upsert slate rows (sport, season, week, kickoff, home, away) |
| `POST /v1/admin/results` | settle games: scores + closing lines; triggers grading |
| `GET  /v1/admin/earnings` | ledger overview per creator |

---

## 6. The embed contract

```html
<script src="https://edgedesksports.com/collective/embed.js"
        data-collective-host="moose" data-theme="dark" async></script>
```

- Mounts into `<div id="model-collective">` if present, else where the script tag sits.
- Shadow DOM (`mode: 'open'`), all styles inside, zero global CSS, zero dependencies, one file.
- Renders: header with Model Collective wordmark linking to `BASE_URL/collective/` (persistent link back, always), the model wall, creator profile panels with outbound links (site, X) that always link out, consensus and upcoming sections honoring the API's `locked` flags with a subscribe CTA to `BASE_URL/collective/?ref={host}#join`, host creator pinned first and badged, nothing else host-variable.
- Failure states: API timeout 6s or non-200 renders a readable static panel (wordmark, one line, link to the Collective site). Never blank, never broken-looking.
- Theme: `data-theme="dark"` default, `light` supported. Anything else ignored.
- Events: batched impressions and clicks to the embed events endpoint; visitor id is a random localStorage uuid namespaced to the embed; first-touch recorded via `record_touch` semantics server-side.

---

## 7. The Universal Creator Prompt

Template at `collective/claude-prompt-template.md` with placeholders `{{CREATOR_NAME}} {{MODEL_NAME}} {{SPORT}} {{API_BASE}} {{API_KEY}} {{EMBED_SNIPPET}} {{DASHBOARD_URL}} {{DOCS_URL}}`. The join edge function loads the same template text (embedded constant generated from the file, single source in `_shared/prompt_template.ts`, with a build note that the .md file is the human-readable copy). Content follows Section 13 of the build prompt: inspect first, locate outputs, map fields for approval, never send proprietary logic, additive module + send trigger, key server-side (GitHub Action path for static sites), add the Collective tab via embed, dry run against the dry-run endpoint and show JSON, then report back. Plain language, under two pages, no em dashes.

---

## 8. CSV harness (Section 9 proof)

`tools/collective/sample_moose_nfl.csv` columns (deliberately messy, matching the described real file):
`season,week,date,home,road,line,total,result,home_pts,road_pts,ml_prob_home,cover_prob_m3,cover_prob_0,cover_prob_p3,version,confidence`
where `result` means "the pick covered" (rule 9.1, never trusted), `ml_prob_home` is moneyline (9.2), `cover_prob_0` is at the listed line, offsets exist and are ignored with a note, `version` carries `v1-backfill` on old rows (9.4).

`tools/collective/harness.py`: `python3 harness.py sample_moose_nfl.csv --dry-run` prints the field mapping table, the JSON envelope, posts to dry-run, prints per-row outcomes; `--live` submits for real. Env: `COLLECTIVE_API`, `COLLECTIVE_KEY`. Stdlib only (urllib, csv, json). Exit non-zero if any row rejected.

---

## 9. Grading rules, published verbatim at /v1/rules and on the site

1. Pick result: the pick side against the Collective's own captured closing spread, home convention. Push on the exact number, excluded from win percentage. Never graded against the creator's line and never against a creator-supplied result column.
2. Margin error: absolute difference between projected home margin and actual home margin. Projected home margin is `proj_home_score - proj_away_score` when scores are given, else `-projected_spread`.
3. Brier: `(home_win_probability - home_won)^2`. 0.25 is a coin flip. Lower is better.
4. Only each model's first pre-kickoff live submission per game is graded (submissions are timestamped on receipt by the server). Later revisions are shown as movement. Post-kickoff receipts are stored, marked late, excluded. Backfill and test are stored, shown separately, excluded.
5. Rankings require minimum slate coverage (60 percent season to date) and minimum 20 graded games. The three metrics are ranked separately and never blended.

---

## 10. Build sequencing note

Everything above ships in this build. Billing tables and the billing edge function scaffold ship inert behind `billing.enabled=false` (rule 8.13: capture attribution from day one, switch money on later). A `collective_billing` function handling Stripe webhooks ships with the checkout wiring stubbed to a clearly labeled not-live response until the Stripe price ids are configured via secrets `COLLECTIVE_STRIPE_SECRET`, `COLLECTIVE_STRIPE_WEBHOOK_SECRET`, `COLLECTIVE_PRICE_MONTHLY`, `COLLECTIVE_PRICE_ANNUAL`.
