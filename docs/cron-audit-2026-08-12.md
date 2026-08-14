# Cron audit — 2026-08-12

Source: `select * from cron.job;` dump, 35 rows, all `active = true`.

## Headline

**The "crons are empty" hypothesis is dead.** There are 35 scheduled jobs and every
one is active. The last two weeks of failures are not a missing scheduler.

They are, in order of confidence:

1. **Five jobs send malformed `Authorization` headers and are almost certainly 401ing
   on every fire.** (verified by reading the header expressions — see below)
2. **Failures are structurally invisible.** `net.http_post` is fire-and-forget: it
   enqueues the request and returns a `bigint` request id immediately. The cron job
   then reports `succeeded` in `cron.job_run_details` *regardless of what the HTTP call
   did*. A job can 401 every 20 minutes for a month and the scheduler will show a clean
   run history the whole time. This is why nobody noticed.
3. `capture` runs **hourly**, not `*/10` as intended — 6× coarser tick capture than spec.

## 1. Broken auth — these five are dead

| jobid | jobname | schedule | what it actually sends |
|---|---|---|---|
| 81 | `mlb_sync_20min` | `*/20 * * * *` | `Authorization: <cron_secret>` — raw secret, no `Bearer`, not a JWT |
| 82 | `weather_sync_hourly` | `10 * * * *` | same |
| 83 | `bullpen_sync_daily` | `0 10,16 * * *` | same |
| 86 | `learn-nightly` | `0 8 * * *` | `Bearer <cron_secret> <service_role_jwt>` — two tokens, space-joined |
| 87 | `ingest-mlb` | `*/30 * * * *` | `Bearer <cron_secret><service_role_jwt>` — concatenated, no separator |

Jobs 81–83 pass the cron secret as the `Authorization` value. The Supabase gateway
tries to parse it as a JWT and rejects it. And because the secret is in `Authorization`
rather than `x-cron-secret`, the function's own gate would not find it either, even if
the gateway let it through. Double-broken.

Jobs 86–87 build the header by string-concatenating the cron secret onto the vault
service-role key:

```sql
'Authorization', 'Bearer ed9f…456a ' || (select decrypted_secret
                                         from vault.decrypted_secrets
                                         where name = 'service_role_key')
```

The gateway takes everything after `Bearer ` as the token. That is
`ed9f…456a eyJhbGci…` — not a JWT. 401.

There is a second failure mode stacked on the same line: if the vault secret
`service_role_key` does not exist, the subselect returns NULL, `text || NULL` evaluates
to NULL, and `jsonb_build_object('Authorization', NULL)` yields a JSON null. Either way
the header is unusable. **Check whether that vault secret exists at all** — see
diagnostics below.

Neither 86 nor 87 sends `x-cron-secret`, so there is no fallback path.

## 2. Cadence drift vs. the intended spec

| function | intended | actual | verdict |
|---|---|---|---|
| `capture` | `*/10` | `0 * * * *` (job 5) | **6× too coarse** |
| `ingest_mlb` | `*/30` | `*/30` (job 87) | cadence right, auth broken |
| `close` | `*/30` | `*/5` (job 63) | 6× more aggressive than spec |
| `settle` | `*/30` | `*/5` (job 7) **and** `*/15` (job 85) | duplicated, both over spec |
| `market_residual` | hourly | — | **no job exists** |
| `ingest_pitcher_season` | `0 9,21` | — | no job (packet step 15 not deployed — expected) |

`capture` at hourly is the one that bears on the thesis. Coarser tick capture means
coarser closing-line resolution, which directly degrades the CLV measurement the whole
build is conditional on.

## 3. Duplicate and conflicting jobs

- **`settle` fires twice.** Job 7 (`*/5`) and job 85 (`settle-every-15min`, `*/15`).
  Every 15 minutes two settle passes overlap.
- **`learn` fires twice, with two different intentions.** Job 8 (`edgedesk_learn`,
  hourly at `:30`, working auth) and job 86 (`learn-nightly`, `0 8`, broken auth).
  Someone intended nightly; the hourly one is what actually runs. Hourly `learn` is
  expensive — decide which is correct.
- **MLB ingest has two paths and a slug mismatch.** Job 87 posts to
  `/functions/v1/ingest_mlb` (underscore). Job 77 calls
  `public.invoke_edge('ingest-mlb')` (hyphen). At most one of those slugs is a real
  deployed function.

## 4. Unverified — check these, don't assume

I could not reach the database, so these are open questions, not findings:

- **Does `public.invoke_edge()` exist?** Jobs 77 and 78 depend on it. If it does not,
  they have been erroring every run — and unlike the HTTP failures, *that* one would
  show up in `cron.job_run_details`.
- **Does `public.settle_and_recalibrate()` exist?** Job 79.
- **Do the vault secrets `service_role_key` and `cron_secret` exist?**
- **Is `verify_jwt` off for the ~22 jobs that send only `x-cron-secret` and no
  `Authorization` header at all?** If `verify_jwt` is on for any of them, the gateway
  401s before the function body runs. The older pipeline functions (`capture`, `close`,
  `settle`) were verified working by hand, so theirs is presumably off. The newer ones
  — `model_grade` (60), `ufc_fighters_sync` (75), `mark_provider_exhausted` (84) — have
  never been confirmed and are the likely candidates for silent failure.

## 5. Security — rotate both credentials

The `cron.job.command` column stores, in plaintext, readable by anyone who can select
from the `cron` schema:

- the **service-role JWT** (jobs 9, 10, 11, 12) — `iat` 2026-06-16, `exp` 2036-06-14.
  A ten-year god-mode key that bypasses RLS entirely.
- the **cron secret** (~25 jobs).

Both have now also been pasted into a chat transcript. Treat both as compromised and
rotate them. The fix script below moves every credential into `vault` and routes all
calls through one helper, so the next rotation is a single vault update rather than 35
job edits.

## 6. Minor

- Job 9 (`capture_boards`) has a trailing space inside the JWT string literal:
  `…mybjIpIk ')`. Most parsers trim it; free to fix while you're in there.
- Three heavy jobs collide at exactly `0 8` UTC: `cfb_full` (52),
  `settle_and_recalibrate` (79), `learn-nightly` (86). Four more collide at `0 */6`:
  jobs 9, 45, 53.
- `grade_props` exists only for MLB (49) and WNBA (50). No NFL/CFB/CBB equivalent —
  seasonal today, will bite in September.
- `capture_stats` for CFB (23) and CBB (27) fires daily year-round including the
  offseason. Harmless, just waste.

## What to run next

See `sql/cron_fix_2026-08-12.sql`. Run the diagnostic block first — it answers the
open questions in §4 — then the fix block.
