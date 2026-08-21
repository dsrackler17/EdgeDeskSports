# B. Database schema

Purpose: this document specifies every database object in the `collective` schema: enums, tables with columns, types, constraints, and indexes; views; RPCs; the RLS and grant posture; the append-only enforcement mechanism; and the justification for every denormalization. It matches CONTRACT.md section 4 exactly; the migrations in `supabase/migrations/` are the executable form of this document.

## 1. Conventions

- Everything lives in schema `collective`. No cross-schema foreign keys in either direction (rule 8.1).
- Every table has `id uuid primary key default gen_random_uuid()` unless noted, and `created_at timestamptz not null default now()`.
- All timestamps are `timestamptz`. Money is integer cents. Revenue shares are basis points (bps).
- Migrations are forward-only, one logical change each, eight files dated `20260819000001` through `...08` (foundation, creators, submissions, grading, views, commerce, rpcs, seeds).

## 2. Enums

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
create type collective.billing_mode       as enum ('referral','wholesale');
create type collective.sub_status         as enum ('active','past_due','canceled','refunded');
create type collective.ledger_type        as enum ('earning','clawback','payout','adjustment');
create type collective.embed_event_type   as enum ('impression','profile_view','outbound_click','collective_click','subscribe_click');
```

Deliberately absent: a membership-status enum. ACTIVE CONTRIBUTOR, MEMBER, INACTIVE is derived in the `model_wall` and `membership_status` views from submission recency against the season window (rule 8.8); storing it would invite manual flips and drift. Likewise `founding_member` is a display flag only; the money number is `referral_share_bps` on the creator row, so the founding rate travels with the creator instead of living in a tier check.

## 3. Tables

### 3.1 Reference and configuration

**config** `(key text primary key, value jsonb not null, description text, updated_at timestamptz)`
Every Section 5 number and every operational threshold lives here and only here: pricing (`pricing.monthly_cents` 2499, `pricing.annual_cents` 0, annual disabled by owner decision 2026-08-20), shares (`share.referral_bps_default` 4000, `share.founding_bps` 5000, `share.founding_seats` 10), wholesale (`wholesale.seat_cents` 1400, `wholesale.min_seats` 10, `wholesale.floor_cents` 2000), payout (`payout.min_cents` 5000, `payout.net_days` 30, `payout.clawback_days` 60), ranking (`ranking.min_coverage_pct` 60, `ranking.min_graded_games` 20, `ranking.per_sport` `{}`), status windows (`status.active_days` 10, `status.inactive_days` 45), `billing.enabled` false, `invite.expiry_days` 30, ingest limits (`ingest.max_rows` 500, `ingest.max_bytes` 524288, `ingest.rate_per_hour` 60), `admin.user_ids` `[]`, embed (`embed.cache_seconds` 60, `embed.allow_localhost` true). Changing a business number is an UPDATE, never a deploy.

**sports** `(code text primary key, name text, spread_convention text default 'home', active bool)`. Seed: NFL.

**sport_seasons** `(id, sport_code text references sports, season int, starts_on date, ends_on date, unique(sport_code, season))`. Seed: NFL 2026, 2026-09-04 to 2027-02-08. The season window drives in-season logic for membership status and coverage denominators.

**teams** `(id, sport_code references sports, code text, name text, unique(sport_code, code))`. 32 NFL teams seeded.

**team_aliases** `(id, sport_code text, alias text, team_id references teams)` with a unique index on `(sport_code, lower(alias))`. Seeded with codes, city names, full names, and common variants (WAS/WSH, JAX/JAC, LA/LAR, ARI/ARZ, plus relocation notes such as OAK to LV and SD to LAC). Matching is case-insensitive on `lower(trim(alias))`. This table is the canonical-game-resolution subsystem (rule 8.4): resolution is a lookup through seeded aliases, never a fuzzy string match, and an admin can add an alias to unstick a whole quarantine batch at once.

**games** `(id, sport_code references sports, season int, week int null, kickoff_at timestamptz, home_team_id references teams, away_team_id references teams, status collective.game_status default 'scheduled', external_ref text null)` with a unique index on `(sport_code, season, home_team_id, away_team_id, (kickoff_at at time zone 'UTC')::date)`. The UTC-date component makes the natural key stable under minor kickoff-time corrections (a flexed game moves hours, not days) while still permitting a true doubleheader on different dates.

### 3.2 Identity and credentials

**creators** `(id, user_id uuid null unique, slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'), display_name text not null, description text, website_url text, x_handle text, logo_url text, status collective.creator_status default 'active', is_listed bool default true, founding_member bool default false, referral_share_bps int not null default 4000, billing_mode collective.billing_mode default 'referral', pinned_model_id uuid null, invite_token_id uuid null, created_at)`

`user_id` is a plain uuid, no FK to `auth.users`: this is the extraction seam. The slug check enforces 3 to 40 chars, lowercase alphanumeric with interior hyphens, so slugs are safe in URLs, in the embed attribute, and in `?ref=` without escaping.

**models** `(id, creator_id references creators on delete restrict, slug text, name text not null, sport_code references sports, description text, is_listed bool default true, created_at, unique(creator_id, slug))`

`on delete restrict` because a creator with submission history cannot be deleted at all: departure is `status='departed'` plus `is_listed=false`, never a row delete.

**api_keys** `(id, creator_id references creators, model_id references models null, scope collective.key_scope default 'submit', key_prefix text not null unique, key_hash text not null, status collective.key_status default 'active', last_used_at timestamptz, revoked_at timestamptz, created_at)`

Key material: `mck_live_{prefix8}{secret32}` (or `mck_test_`), base62. Stored: the 8-char prefix and the sha256 hex of the full raw key. Verification is a unique-index lookup on `key_prefix` plus a hash comparison; the raw key is never stored (full design in D-auth-credentials.md). `model_id` scopes a key to one model; null means all of the creator's models, and v1 issues per-model keys at join. Submissions made with an `mck_test_` key are forced to `data_origin='test'`.

**invite_tokens** `(id, token_hash text unique, token_prefix text, prefill jsonb default '{}', founding_member bool default false, referral_share_bps int null, max_uses int default 1, use_count int default 0, expires_at timestamptz not null, note text, created_by uuid null, created_at)`

Raw token `mci_{24 base62}`, sha256 stored, same discipline as API keys. Prefill keys: `display_name`, `sport`, `model_name`. `referral_share_bps` on the token lets a founding invite carry the 5000 bps rate onto the creator row at redemption.

### 3.3 Submissions and projections (the append-only core)

**submissions** `(id, model_id references models, api_key_id references api_keys, received_at timestamptz not null default now(), data_origin collective.data_origin not null, client_generated_at timestamptz null, source_note text null, payload_hash text not null, n_rows int, n_resolved int, n_quarantined int, n_late int, response jsonb, created_at, unique(model_id, payload_hash))`

One row per submitted envelope. `received_at` is server time and is the only time trusted anywhere (rule 8.6); `client_generated_at` is stored for the record and never used for timing. `unique(model_id, payload_hash)` is the idempotency lock: replaying the same payload cannot create a second submission.

**projections** `(id, submission_id references submissions, model_id references models, game_id references games null, raw_game_ref text not null, raw_row jsonb not null, resolution_status collective.resolution_status not null, quarantine_reason text null, sport_code text not null, season int, week int null, pick_side collective.pick_side null, total_side collective.total_side null, line_at_submission numeric null, projected_spread numeric null, projected_total numeric null, proj_home_score numeric null, proj_away_score numeric null, home_win_prob numeric null check (home_win_prob between 0 and 1), cover_prob numeric null check (cover_prob between 0 and 1), confidence numeric null, data_origin collective.data_origin not null, received_at timestamptz not null, is_late bool not null default false, is_graded_candidate bool not null default false, created_at)`

One row per submitted game line. `raw_game_ref` and `raw_row` preserve the creator's input verbatim forever (rule 8.4): quarantine resolution and any future re-grade can always return to the source. Spread convention is home-side, negative means home favored. `home_win_prob` is moneyline probability; `cover_prob` is against `line_at_submission` and is rejected at ingest if the line is absent (rule 9.2). The obvious-mismatch guard hard-rejects a row (row-level error, submission still succeeds) when `home_win_prob > 0.5` with `projected_spread > 3`, or `home_win_prob < 0.5` with `projected_spread < -3`; everything less blatant passes, because the guard exists to catch swapped columns, not to police models.

Indexes: `(model_id, game_id, received_at)` for movement and latest lookups, `(game_id) where is_graded_candidate` for grading and consensus, `(resolution_status) where resolution_status='quarantined'` for the queue, plus the first-lock index below.

**results** `(game_id primary key references games, home_score int not null, away_score int not null, closing_spread numeric null, closing_total numeric null, closing_home_ml_prob numeric null, source text, settled_at timestamptz default now())`

The Collective's own closing lines, home convention, entered through the admin results endpoint. Grading never uses a creator's `line_at_submission` (rules 9.1, 9.3): creators' lines are context, the Collective's close is the yardstick.

**grades** `(projection_id primary key references projections, game_id, model_id, pick_result collective.grade_result null, margin_error numeric null, total_error numeric null, brier numeric null, grading_version int not null, graded_at timestamptz default now())`

Three metrics, never blended (rule 8.11). Pick graded against `results.closing_spread`; landing exactly on the number is `push`, excluded from win pct. Margin error is `abs((proj_home_score - proj_away_score) - (home_score - away_score))`, falling back to `abs(-projected_spread - actual_margin)` when scores are absent but a spread is present. Brier is `(home_win_prob - home_won)^2`. Only `is_graded_candidate` rows are graded, so backfill, test, late, and movement rows can never leak into a record. `grading_version` future-proofs a rules change: a version 2 re-grade writes new rows under a new version rather than editing history.

### 3.4 Commerce and attribution (inert until `billing.enabled`)

**embed_installs** `(id, creator_id references creators, origin text not null, status text default 'active', last_seen_at timestamptz, created_at)` with a unique index on `(creator_id, lower(origin))`. Origin format is scheme plus host, `https://example.com`, no path. This is the embed's entire auth model.

**embed_events** `(id, creator_id null, event_type collective.embed_event_type, visitor_id text null, target_creator_id uuid null, path text, referrer text, origin text, occurred_at timestamptz default now())`. Append-only, sampled client-side; the raw evidence behind engagement numbers and attribution disputes.

**attribution_touches** `(id, visitor_id text not null, creator_id references creators, source text check (source in ('embed','link')), origin text, touched_at timestamptz default now())`, index on `(visitor_id, touched_at)`. First touch per visitor wins.

**attributions** `(id, subscriber_user_id uuid null, subscriber_email_hash text null, creator_id references creators, visitor_id text, source text, locked_at timestamptz not null default now(), unique(subscriber_user_id), unique(subscriber_email_hash))`. Locked at conversion; the unique constraints are the structural form of "two creators cannot claim the same subscriber," and there is no update path because attribution never moves.

**subscribers** `(id, user_id uuid unique, email text, status collective.sub_status, plan text check (plan in ('monthly','annual')), stripe_customer_id text, stripe_subscription_id text unique, attribution_id references attributions null, current_period_end timestamptz, started_at, canceled_at, created_at)`. The Collective's own paid tier (Mode A). Entitlement checks read this table.

**earnings_ledger** `(id, creator_id references creators, subscriber_id references subscribers null, entry_type collective.ledger_type, amount_cents int not null, period_month date not null, available_at timestamptz, stripe_ref text, note text, created_at)`. Pure ledger: earnings post per paid invoice at the creator's `referral_share_bps`; annual pays on the full amount when it clears; clawbacks are negative entries inside `payout.clawback_days`; payouts are negative entries when paid. Balance is a SUM, never a stored column, so the money math is auditable by anyone who can read the table.

**payout_accounts** `(creator_id primary key references creators, stripe_connect_id text, status text default 'unstarted', requested_at, connected_at)`. Connect is requested only after a first successful live submission, never at signup.

**wholesale_seats** `(id, creator_id references creators, period_month date, seat_count int check (seat_count >= 10), reported_at, invoiced bool default false, unique(creator_id, period_month))`. Mode B seat reporting at `wholesale.seat_cents` each.

**api_request_log** `(id bigint generated always as identity primary key, api_key_id uuid, endpoint text, at timestamptz default now())`, index on `(api_key_id, at)`. The sliding-window rate limit reads this; maintenance prunes it.

## 4. Denormalizations, each justified

The schema is otherwise third normal form. Four deliberate exceptions:

1. **`projections.model_id`** duplicates `submissions.model_id`. Every hot query path (grading, consensus, movement, coverage, the first-lock index itself) is keyed by `(model_id, game_id)` on projections; without the copy each would join through submissions, and the first-lock unique index could not exist at all, because a partial unique index cannot span a join. The pair is written inside one RPC transaction from the verified key, so it cannot disagree.

2. **`projections.received_at`** duplicates `submissions.received_at`. Lateness (`received_at > games.kickoff_at`), first-versus-movement ordering, and the movement timeline all sort projections by receipt time. Copying the timestamp keeps the append-only grading path self-contained: a grade is computable from `projections`, `games`, and `results` alone, which is exactly the reproducibility promise in the published rules.

3. **`projections.data_origin`** duplicates `submissions.data_origin`. Live-only filters run on projections everywhere (wall, records, consensus, rankings). More important, candidacy is a row property: `is_graded_candidate` requires `data_origin='live'`, and the check must be evaluable per row at insert without a join, inside the same transaction that sets the flag.

4. **`submissions.response`** stores the full response JSON returned for the envelope. Idempotent replay (`unique(model_id, payload_hash)` hit) returns the original per-row outcomes verbatim with `duplicate: true` instead of recomputing them, which matters because a recompute against a later database state (an alias added, a game inserted) could return a different answer for the "same" submission. The stored response is the truthful record of what the creator was told.

All four are write-once copies made inside a single SECURITY DEFINER transaction; none has an update path, so none can drift.

## 5. Append-only enforcement (rule 8.3)

For `submissions`, `projections`, `embed_events`, `earnings_ledger`, `attributions`, and `api_request_log`, two independent locks:

```sql
revoke update, delete on collective.<t> from public, anon, authenticated;
```

plus a `BEFORE UPDATE OR DELETE` trigger on each that raises an exception unless `current_setting('collective.maintenance', true) = 'on'`. The GUC is set only inside SECURITY DEFINER maintenance functions (quarantine resolution, GDPR erasure), so even the service role cannot casually mutate history: it must go through a named function whose scope is bounded. Quarantine resolution updates only `game_id`, `resolution_status`, `quarantine_reason`, `is_late`, and `is_graded_candidate` on quarantined rows; the raw payload columns are never touched. A revision from a creator is always a new row, surfaced as movement.

## 6. The first-submission lock (rule 8.5)

Rule 8.5 says each model's first pre-kickoff live submission per game is the graded one, because later submitters can see the board and are anchored. This is enforced structurally, not procedurally:

```sql
create unique index projections_first_lock on collective.projections(model_id, game_id)
  where is_graded_candidate;
```

`is_graded_candidate` is computed inside the ingest RPC transaction: true only when `resolution_status='resolved'`, `data_origin='live'`, `is_late=false`, and no prior candidate row exists for `(model_id, game_id)`. The partial unique index means that even a bug in the RPC, a race between concurrent submissions, or a rogue service-role write physically cannot create a second graded candidate for the same model and game: the database rejects it. Later rows insert fine with the flag false and become movement. `is_late` is computed in the same transaction as `received_at > games.kickoff_at` against the canonical kickoff, never against any payload timestamp.

Quarantine interacts cleanly: a quarantined row is not a candidate, and `admin_resolve_quarantine` recomputes lateness and candidacy at resolution time under the same index, so a rescued row becomes the candidate only if no live pre-kickoff row beat it.

## 7. Views

All in `collective`, owned by postgres, `security_invoker = off` (they read as owner; access control is at the function layer, since no client role can reach them anyway).

- **latest_projections**: newest row per `(model_id, game_id)` regardless of candidacy.
- **first_submissions**: rows where `is_graded_candidate`. The only input to grading, consensus, and rankings.
- **model_movement**: all resolved rows per `(model_id, game_id)` ordered by `received_at`, exposing drift from the first submission.
- **model_records**: per model: graded W/L/P, win pct (pushes excluded), margin MAE, total MAE, mean Brier, n graded, last live submission at. Backfill and test are excluded by construction: they are never candidates, so no filter can be forgotten.
- **model_coverage** and **model_coverage_totals**: per model, sport, season, week: games available (kickoff inside the season window) versus first submissions; the totals view rolls up season to date with `coverage_pct`. Coverage is the anti-cherry-picking defense (rule 8.7) and shows next to every record.
- **membership_status**: per creator: ACTIVE CONTRIBUTOR if a live resolved submission within `status.active_days` and the sport is in season (or first-ever live submission within the window); MEMBER if no live submission yet or out of season; INACTIVE if in season and silent for `status.inactive_days`. Derived, never stored.
- **model_wall**: one row per listed model of a listed active creator: creator identity, model identity, membership status, record summary, coverage pct, last submission, founding flag.
- **rankings**: model_records joined with coverage, filtered to `coverage_pct >= ranking.min_coverage_pct` and `n_graded >= ranking.min_graded_games` (config-driven, per-sport overridable), ranked separately per metric: win pct, margin MAE, Brier. Never blended. Below-threshold models land in an unranked list with the human-readable reason.
- **consensus**: per game: n models, mean, median, stddev, and range of projected spread and total, mean home win prob, pct of picks on home, agreement rate. Computed off `first_submissions` only, live origin only, deterministic SQL (rule 8.9).
- **quarantine_queue**: quarantined projections with raw ref and reason, for the admin console.
- **creator_earnings_monthly**: ledger rollup per creator per month: earned, clawed back, paid, balance, available balance.

## 8. RLS and grants

- The `collective` schema is added to PostgREST's exposed schemas (see DEPLOY.md), but `anon` and `authenticated` receive no grants at all, not even USAGE on the schema. Every read and write goes through edge functions using the service role.
- RLS is additionally enabled on every table with zero policies, which is deny-all: defense in depth in case a grant ever appears by accident. `service_role` bypasses RLS by design.
- Every RPC is `SECURITY DEFINER` with `set search_path = collective, public`, and `execute` is revoked from `public`, `anon`, and `authenticated`, leaving `service_role` as the only caller.

The RPC list (verify_key, rate_check, ingest_submission, resolve_game_ref, mint_invite, invite_status, redeem_invite, admin_resolve_quarantine, upsert_games, settle_game, grade_game, record_touch, lock_attribution, get_config) is specified in CONTRACT 4.6; each is the transactional unit behind exactly one API behavior, so the edge functions stay thin and the invariants live in one place.
