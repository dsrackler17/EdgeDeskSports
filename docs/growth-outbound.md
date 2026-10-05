# Growth console: outbound engine

This is the owner-only outbound prospecting system that lives inside `/admin/growth/`. It is built in phases. Each phase records what changed, how it was verified, how to deploy it and how to roll it back.

**The rule the whole system is built around:** software may find, research, score, verify, draft and queue. It may never approve or send. Sending requires an explicit owner action, and the server enforces that, not the page.

---

## Phase 1: the console's sign-in (shipped)

### What was wrong

`/admin/growth/` stored the whole `/auth/v1/token` answer in `localStorage` and sent its `access_token` on every later visit. It never refreshed the token. Supabase access tokens live about an hour. On any visit after that:

1. the page sent the expired JWT, and PostgREST answered `401 {"code":"PGRST303","message":"JWT expired"}`;
2. `boot()` caught every failure the same way and printed *"This account cannot open the growth console: an operator must add it to public.affiliate_admins, and supabase/growth.sql must be installed. (401: {…raw JSON…})"*.

That message was an authorization verdict for what was only a stale login. Authorization itself was never broken: `affiliate_admins` has RLS on, no policies, and no client privileges.

`tools/growth/admin_growth_login.e2e.js` reproduces that exact message against the old page.

### What changed

| File | Change |
|---|---|
| `lib/edgedesk_admin_session.js` (new) | The operator consoles' session, ported from `app.html`'s proven `edRefreshSession`/`edToken` logic. It refreshes before expiry; on a 401 it refreshes **once** and retries **once**; it uses a single-flight refresh (refresh tokens rotate and are single-use); it adopts another tab's rotation; a refused refresh drops the session; a 5xx or network failure keeps it. It never falls back to the anon key and never logs. Errors come back as sentences with any token redacted, and it stores only `{access_token, refresh_token, expires_at, user:{id,email}}`. |
| `admin/growth/index.html` | Uses that module. The operator check (`growth_is_admin`) now runs **first and alone**, so the page gives distinct answers: *signed out*, *not an operator*, *not installed*, *unreachable* or *in*. Non-operators never trigger a data RPC. The page also gains a sign-out button, an "use another account" switch, Enter-to-submit, a cleared password field and per-section error reporting (one failing read no longer blanks the page). It no longer decodes the JWT to show the email. |
| `tools/growth/*` | Tests (below). |
| `package.json`, `.github/workflows/personal-tests.yml` | `growth:test`, `growth:sql`, `growth:e2e`. CI runs the first two. |

Nothing server-side changed. No SQL migration ships in Phase 1.

### Verification

| Suite | What it proves | Result |
|---|---|---|
| `npm run growth:test` | 83 checks: proactive refresh; one refresh and one retry on 401; a second 401 ends the session; refused refresh gives clean sign-out; transient failure keeps the session; 5 concurrent loaders share one refresh; cross-tab rotation; anon makes zero requests; 403/42501 → not operator, PGRST202 → not installed; sign-in/out; no token in any message or console output. Mutation-checked: removing single-flight, proactive refresh, drop-on-refusal or the retry bound each fails the suite. | PASS |
| `npm run growth:sql` | 34 checks on real PostgreSQL. Anon, a paying subscriber and an affiliate partner cannot call `growth_is_admin`, cannot read or write `affiliate_admins`, and cannot open any growth admin RPC. The owner can. No policy or client privilege exists on the list, and no client-executable function writes it (a planted backdoor proves the scan works). Removal takes effect on the next call. | PASS |
| `npm run growth:e2e` | 42 checks in Chromium against the shipped page with Supabase mocked: an hour-old session opens straight into the console; a refused refresh gives "sign in again" in words; a wrong password and a fresh sign-in behave correctly; a non-operator is refused; "not installed" is distinct; a mid-session 401 recovers; sign-out clears and revokes; no token reaches the DOM or console; the page fits at 390 px. | PASS |

### Owner bootstrap (run in the Supabase SQL editor, never from a page)

The operator list is `public.affiliate_admins`, shared by the partner, growth and billing consoles. `affiliates.sql` seeds the owner account `e7e46801-80c4-4f47-b718-4aff211c8d3a` (`app.html` `PG_OWNER_ID`) if that user exists. Nothing a client can call writes this table.

Before using the steps below, run the "Verification SQL" first. If `owner_listed` is `true`, nothing is needed.

```sql
-- Add the owner explicitly, by the email you sign in with:
insert into public.affiliate_admins (user_id)
select id from auth.users where lower(email) = lower('<your sign-in email>')
on conflict (user_id) do nothing;
```

### Verification SQL

```sql
select
  exists (select 1 from public.affiliate_admins a join auth.users u on u.id = a.user_id
          where lower(u.email) = lower('<your sign-in email>'))                     as owner_listed,
  (select count(*) from public.affiliate_admins)                                    as operators_total,
  to_regprocedure('public.growth_is_admin()') is not null                           as growth_sql_installed,
  (select relrowsecurity from pg_class where oid = 'public.affiliate_admins'::regclass) as rls_on,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'affiliate_admins') as policies_should_be_0,
  has_table_privilege('authenticated', 'public.affiliate_admins', 'insert')        as clients_can_insert_should_be_false,
  has_function_privilege('anon', 'public.growth_is_admin()', 'execute')            as anon_can_ask_should_be_false;
```

`operators_total` is every account that can open the partner, growth and billing consoles. If it is more than you expect, review the list before Phase 2. Phase 2 adds a narrower owner-only gate for prospect data.

### Deploy

The site is static (GitHub Pages). Merging deploys `admin/growth/index.html` and `lib/edgedesk_admin_session.js`; the script tags carry `?v=20261005a`. No Supabase change is needed.

After deploying, open `/admin/growth/`. If a stale session is stored, the console should open without asking you to sign in, or ask cleanly if the refresh token was revoked.

### Rollback

Revert the merge commit. The old page reads the same `localStorage` key and shape (the new module stores a subset of the same fields), so no cleanup is needed in either direction.

### Known, out of scope here

- `/admin/billing/`, `/admin/affiliates/` and the other operator pages have the same no-refresh pattern. Adopting `lib/edgedesk_admin_session.js` there is a mechanical follow-up.
- `supabase/newsletter.sql` `newsletter_suppress(...)` is `security definer` with no `revoke`, so it is executable by `anon`. Anyone with the public anon key can permanently suppress any address as `complaint`. That blocks the newsletter, and `lifecycle_due` also honors it for trial emails. This was verified on a throwaway cluster. The fix is a one-line `revoke all … from public, anon, authenticated`, which matches the file's own pattern for service-only functions.
