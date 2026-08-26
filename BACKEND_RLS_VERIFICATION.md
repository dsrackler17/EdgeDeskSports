# EdgeDesk — Live Backend RLS Verification (evidence-based)

Source: catalog dumps from the live Supabase project (`pg_class.relrowsecurity`,
`pg_policies`, `information_schema.role_table_grants`, `pg_get_functiondef` of the
SECURITY DEFINER functions, ownership triggers, `auth.uid()` column defaults),
run in the project's own SQL editor. This is observed state, not inference.

## Headline

The controls you were most worried about are **enforced at the database**:

- **Cross-user isolation (#2): PASS.** Every per-user table gates on
  `user_id = auth.uid()`.
- **Subscription forgery (#4): PASS — provably impossible from the client.**
  `subscriptions` has RLS on and **exactly one policy** — `subs_read_own`
  (SELECT, `user_id = auth.uid()`). There is **no INSERT/UPDATE/DELETE policy**,
  so despite the table-level grant, RLS denies every client write. Only the
  service role (the signature-verified Stripe webhook) can set `status='active'`.
- **Historical prices/grades (#9): PASS.** `signals` and `signal_ticks` have
  **no client write policy** (service-role only) and are further protected by
  `preserve_first_snapshot` / `zz_preserve_anchor_entry` BEFORE-UPDATE triggers.
- **The entire `collective` schema is table-locked** (RLS on, **zero policies →
  deny-all**) for both `anon` and `authenticated`. All access is through
  SECURITY DEFINER RPCs.

RLS is on for **every** table in `public` and `collective` (129/129), and an
event trigger `rls_auto_enable` auto-enables RLS on any new `public` table.

But two access-control questions are **not yet closed**, and one of them can be a
P0. Both need exactly one more check each (given at the end). **Until the
function-grant check clears, the status is DO NOT SHIP**, because one SECURITY
DEFINER function (`edge_call`) is a service-role escalation primitive if it is
callable by clients.

---

## P0 (potential — must confirm before ship)

### P0-candidate: `public.edge_call` is a service-role escalation primitive
`edge_call(slug, body, timeout_ms, query)` is `SECURITY DEFINER`, reads
`cron_secret` **and** `service_role_key` from `vault.decrypted_secrets`, and
`net.http_post`s to **any** `…/functions/v1/<slug>` with
`x-cron-secret` + `Authorization: Bearer <service_role_key>`. It performs **no
caller check** (no `auth.uid()`, no admin test). It lives in `public` (a
PostgREST-exposed schema).

- **If `edge_call` has EXECUTE for `anon`/`authenticated`/`PUBLIC`** (the Postgres
  default for a newly created function is EXECUTE to PUBLIC unless revoked), then
  any user can `POST /rest/v1/rpc/edge_call` and drive every cron/admin Edge
  Function with the service role — settle, close, ingest, run_slate, etc.
  **That is P0.**
- If EXECUTE is restricted to `service_role`/`postgres`, it is fine.

**This is the single most important remaining check.** Query [A] below settles it.

### P0-candidate: collective admin RPCs authorize on a **client-supplied** `p_admin`
`settle_game`, `mint_invite`, `revoke_invite`, `upsert_games`,
`record_market_snapshots`, `mark_closing_line` all gate with
`if not collective.is_admin(p_admin) …`, where **`p_admin` is a function
parameter**, not `auth.uid()`. The Edge Function passes the JWT-verified admin id
correctly — but the RPC itself never checks that the *caller* is that admin.

- If these RPCs are EXECUTE-able by `anon`/`authenticated` via the exposed
  `collective` schema, an attacker who supplies a real admin uid as `p_admin`
  passes `is_admin` and performs admin writes (settle games, mint invites, inject
  market snapshots that feed grading). The admin uid
  (`e7e46801-80c4-4f47-b718-4aff211c8d3a`) is hardcoded in several `public` RLS
  policies; treat it as discoverable, not secret.
- If EXECUTE is `service_role`-only, the design is safe (the parameter pattern is
  then just an internal convenience).

Also `SECURITY DEFINER` with **no caller check** and needing confirmation:
`public.guarantee_sweep()`, `public.research_set_status()`,
`public.research_complete_validation()`, `public.research_register_validation()`,
`public.research_rebuild_patterns()`. Impact is lower than `edge_call` but they
mutate shared state. Query [A] covers these too.

> Fix if any are client-executable: `REVOKE EXECUTE … FROM anon, authenticated,
> public;` (keep `service_role`). For genuinely user-callable RPCs, rewrite the
> check to use `auth.uid()` instead of a passed-in id.

---

## P1

### P1: three financial VIEWS are granted to `anon`, and are not `security_invoker`
`ai_cost_per_user`, `guarantee_refunds_due`, `partner_rollup` (schema `public`)
aggregate **cross-user** data — every user's AI spend, who is owed refunds,
referral revenue by partner.

- **reloptions = null** → they run with the **view owner's** rights (default
  `security_invoker=off`). The developer *did* set `security_invoker=on`
  explicitly on `signals_clv`, `signals_mlb`, `rankings_current`,
  `social_event_counts` — so the mechanism is understood — but **not** on these
  three.
- **Grants:** `anon` has `SELECT` on all three; `authenticated` too.
- If the view owner bypasses RLS on the underlying `ai_usage` (deny-all),
  `subscriptions`, `guarantee_windows` (self-only), `referrals` (self-only) —
  which a `postgres`-owned view does — then **any anonymous caller reads every
  user's financials.** The underlying tables are correctly locked; the views are
  the side door.

**Confirm with the address-bar probe [B].** If rows come back as anon → this is
**P0**; if `[]`/permission-denied → the owner doesn't bypass and it's already safe.
**Fix regardless:** `ALTER VIEW public.ai_cost_per_user SET (security_invoker=on);`
(same for the other two) and `REVOKE SELECT … FROM anon;` — these are admin
analytics, not public.

### P1: paywall is inconsistent — proprietary model outputs leak past `has_active_sub()`
`signals`, `signal_ticks`, `model_predictions`, `book_quotes`, `event_weather`
are correctly gated by `has_active_sub()`. But sibling model tables are **open**:

| Table | Policy | Reader |
|---|---|---|
| `model_props` | `SELECT true` | **anon** |
| `model_odds` | `SELECT true` | public |
| `model_conf_signals` | `SELECT true` | anon + authenticated |
| `model_ratings`, `model_perf`, `model_golf` | `SELECT true` | anon/auth |
| `game_projections` | `auth.uid() IS NOT NULL` | any logged-in (non-subscriber) |
| `team_briefs` | `SELECT true` | any authenticated (reads the paid AI-brief cache) |
| `boards` | `SELECT true` | any authenticated |

So the flagship `model_predictions` is paid, but `model_props`/`model_odds`/
`model_conf_signals` — and the AI-brief cache — are reachable without a
subscription (some without login at all). If those carry the same edge, the
paywall is porous. **Fix:** decide per table what is free vs paid and gate the
paid ones with `has_active_sub()` (and drop the `anon` policy where login should
be required).

---

## P2 / P3

- **P3 — anon can insert owner-less rows.** Policies on user tables
  (`bet_history`, `decision_logs`, `discipline_*`, `commitments`, `clv_history`,
  `nudges`, `habit_tracking`, …) bind role `{public}` with
  `WITH CHECK (user_id = auth.uid())`. For `anon`, `auth.uid()` is null, so an
  anonymous `INSERT … user_id=null` satisfies the check and writes a row no one
  can ever read (SELECT requires `user_id=auth.uid()`). Write-only pollution, not
  a breach. Tighten by scoping these policies to `{authenticated}`.
- **P3 — hardcoded admin uid** `e7e46801-…` appears in `has_active_sub()`,
  `boards_admin_write`, `eligibility_admin_write`. Works, but a config/claim
  check would be cleaner and keeps the uid out of policy bodies.
- **Note (good):** `feedback` and `model_conflicts` allow `anon INSERT true`
  deliberately (feedback form, client-reported model conflicts) — acceptable.

---

## Answers to the ship-gate questions (from observed catalog state)

| # | Question | Verdict |
|---|---|---|
| 1 | Anon reads private tables? | **NO for the sensitive ones** (`signals`, `model_predictions`, `subscriptions`, `bet_history`, `decision_logs`, `discipline_events`, `book_quotes`, `signal_ticks`, all `collective.*`) — RLS denies anon. **EXCEPT** the 3 financial views [B] and the open model tables (P1). |
| 2 | Cross-user isolation | **PASS** — `user_id = auth.uid()` on every per-user table (bet_history, decision_logs, discipline_*, commitments, clv_history, research_*, watchlist, social own-writes, subscriptions read, guarantee_windows self). |
| 3 | Write attribution / spoof `user_id` | **PASS** — INSERT/UPDATE policies carry `WITH CHECK (user_id = auth.uid())`; owner columns default `auth.uid()`; `social_ensure_handle` **forces** `new.user_id := auth.uid()`. A client cannot write another user's id. |
| 4 | Self-activate subscription | **PASS — impossible.** `subscriptions` has no client write policy; only the service-role Stripe webhook writes `status`. |
| 5 | Stripe | **PASS** (from Edge source, unchanged): signature verified before write, `stripe_events` dedup, email-proof mapping. |
| 6 | Edge-fn authz / abuse | Source-verified earlier; gateway-JWT dependency + `team_brief` rate-limit remain (see `BACKEND_SHIP_AUDIT.md`). |
| 7 | Authz before privileged DB access | **PARTIAL — the crux.** Edge layer: yes. RPC layer: admin RPCs check `is_admin(p_admin)` **before** writing (good), but on a *passed* id — safe **iff** the RPCs aren't client-executable ([A]). `edge_call` has **no** check (P0-candidate). |
| 8 | modelKey collision | **RESOLVED + FIXED** (frontend), unaffected by backend. |
| 9 | Invalid CLV / rewrite history | **PASS** — `signals`/`signal_ticks` service-role-only + preserve-first triggers; `decideClose` never fabricates. (Consensus-fallback CLV default remains a P1 config item.) |
| 10 | `has_sharp` provenance | Honest (`s.sharp != null`); CLV-from-consensus-by-default still a P1 config item. |
| 11 | Idempotency | **PASS** — verified writers upsert on stable keys; collective RPCs use advisory locks + append-only triggers (`*_append_only` → `block_mutation`). |
| 12 | Secrets | No value leaks in responses; **but** `edge_call` exposes the service role *functionally* if client-executable ([A]). |

---

## The two checks that close this out

### [A] — Function EXECUTE grants (decides the two P0-candidates). Run in SQL editor:
```sql
SELECT n.nspname AS schema, p.proname AS function,
       pg_get_function_identity_arguments(p.oid) AS args,
       COALESCE(array_to_string(p.proacl, E'\n'),
                '(default: EXECUTE to PUBLIC)') AS execute_acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname IN ('public','collective')
ORDER BY 1,2;
```
Read `edge_call`, `guarantee_sweep`, and every `collective` admin RPC:
- `execute_acl` mentioning `anon=` or `authenticated=`, or saying **`(default:
  EXECUTE to PUBLIC)`** → **client-executable → P0**, revoke immediately.
- `execute_acl` listing only `service_role=` / `postgres=` → safe.

### [B] — Are the 3 financial views anon-readable? Paste in the browser address bar:
```
https://iattxbkbufslbauoumga.supabase.co/rest/v1/guarantee_refunds_due?select=*&limit=2&apikey=<ANON_KEY>
https://iattxbkbufslbauoumga.supabase.co/rest/v1/ai_cost_per_user?select=*&limit=2&apikey=<ANON_KEY>
https://iattxbkbufslbauoumga.supabase.co/rest/v1/partner_rollup?select=*&limit=2&apikey=<ANON_KEY>
```
Rows returned → **P0 cross-user financial exposure**. `[]` or
`permission denied` → already safe (fix still recommended).

---

## FINAL STATUS

**DO NOT SHIP — pending check [A].**

The data-isolation core is genuinely solid and, on the questions that usually
sink an app like this (cross-user reads/writes, forging a subscription, rewriting
CLV history), it **passes with evidence**. What blocks ship is a single
unconfirmed escalation path: `public.edge_call` hands out the service role and has
no caller check, so if it (or the `collective` admin RPCs) is executable by
`anon`/`authenticated`, that is a P0. Run [A].

- **If [A] shows those functions are `service_role`-only:** status becomes
  **SHIP AFTER FIXES** — fix the three financial views (security_invoker + revoke
  anon), reconcile the paywall on the open model tables, and set
  `CLOSE_REQUIRE_SHARP=true`. None of these touch `app.html`.
- **If [A] shows PUBLIC/anon/authenticated EXECUTE on `edge_call` or the admin
  RPCs:** that is a **P0**, remains **DO NOT SHIP** until revoked.

This does not claim "100% secure." It is the evidence-backed state as of the
catalog dump, with the two remaining unknowns named precisely.
