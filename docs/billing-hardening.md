# Billing hardening — Stripe, Supabase and the site always agree

**Goal:** a customer signs up once, pays once, and gets access. If Stripe says
they have a valid trial or subscription, EdgeDesk grants access **eventually and
automatically** — whatever the browser, the redirect, the wallet or the webhook
did. If Stripe says they do not, EdgeDesk stops granting it.

**Status of this change:** code, migrations and tests are in this branch. **Nothing
has been deployed.** I had no access to the production database or the Stripe
account, so every statement about production below is either derived from the
repository or comes with a query that checks it.

---

## 0. Summary

| | Before | After |
|---|---|---|
| Who creates checkout | The **browser** builds a Payment Link URL with `client_reference_id` taken from `localStorage` | `create_checkout_session` (server) takes the account from the verified token; the Payment Link remains only as a deploy-window fallback |
| Where the account id lives in Stripe | Only on the Checkout Session (Payment Links cannot put it on the subscription) | Session (`client_reference_id` + `metadata`), **subscription** (`subscription_data.metadata`) and **customer** (`metadata`) — every event names the account by itself |
| When the account meets its Stripe customer | Only if `checkout.session.completed` arrived and resolved | **Before payment** (`billing_customers`), and again on every event |
| What the webhook writes | The event body, for one subscription, read-then-write in JS | Stripe's **live** state for every subscription the account has, the best one, through one SQL writer under a row lock |
| An event nobody can name | Unresolved **forever** | Alert; resolved retroactively when the customer is linked (next checkout, the reader's *Refresh access*, the 10-minute sweep, or support) |
| Re-asking Stripe | **Never** | Success page, paywall (once per page when the row may be behind), *Refresh access*, checkout pre-flight, scheduled sweep, operator console |
| The access rule | ~6 copies; `index.html` read any `trialing` row as paid | **One** SQL function, `billing_row_grants_access()`; both pages ask `my_billing_access()` |
| Support visibility | SQL editor + Stripe dashboard + function logs | `/admin/billing/`: one search shows DB, Stripe live, the mismatch, events, syncs, alerts; one-click repair |

Tests: **653 assertions across 8 billing suites**, including 126 end-to-end
scenario assertions that run the three shipped functions against the real SQL
(see §8).

---

## 1. Current architecture map (as found)

```
index.html                                   Stripe                      stripe_webhook (Edge)          Postgres
──────────                                   ──────                      ────────────────────           ────────
A  signup  POST /auth/v1/signup  (email confirmation ON → no token; the
   PREVIOUS account's session stays in localStorage ← bug, §2-B)
B  login   POST /auth/v1/token → localStorage.edgedesk_session
C  "Start free trial" → openArl() → ARL consent modal
   confirmArl(): edSubState() guard ─(read subscriptions; ANY trialing = paid ← bug §2-G)
               → INSERT billing_consents (ARL evidence)
D              → location = buy.stripe.com/<link>?client_reference_id=<uuid from localStorage>
                                             &prefilled_email=…&prefilled_promo_code=…
E                                         Payment Link → Checkout Session
                                          (client_reference_id on the SESSION only;
                                           new Customer per checkout; nothing on the
H                                          subscription). Card / Apple Pay / Google Pay / Link
F  success_url  /?checkout=success  ◄──── redirect (may never happen)
   handleCheckoutReturn(): poll edSubState 20×2s, then "email support"
G  cancel_url   (none configured → Stripe's own page)
I                                         events ─────────────────►  verify HMAC (5 min window)
                                                                     upsert stripe_events (ledger)
                                                                     resolveUser: client_reference_id
                                                                       → subscriptions.stripe_customer_id
                                                                       → confirmed email
                                                                     unresolved → 200, kept FOREVER
                                                                     comp guard (owner_comp)
                                                                     shouldApply(last_event_at) in JS
J                                                                    checkout: GET /v1/subscriptions/:id
                                                                     upsert subscriptions (no price_id)  ─►  subscriptions
K  app.html pgCheck(): GET subscriptions?select=… (RLS: own row)                                             (1 row/user)
L           pgEntitled(): active|trialing until period end; owner_comp; past_due +21d
M  trials: Stripe trial on the Payment Link price; comp_trial rows typed by comp_trial.sql
N  cancel: Stripe customer portal → customer.subscription.updated / deleted
O  failed payment: past_due (21-day grace) → Stripe ends it → deleted
P  renewal: customer.subscription.updated with the new period
```

Copies of the access rule found: `app.html pgEntitled()`, `index.html edSubState()`
(**different** — no period end), `community_is_entitled()` (community_posts.sql),
`tennis_record.sql` (inline fallback), `referral_codes.sql` report, `comp_trial.sql`,
`stripe_webhook.sql` report row 10, `newsletter.sql` (members only).
The RLS that actually gates `signals` / `model_predictions` (“paywall.sql”) is
**not in this repository** — see §11 query 10.

## 1b. New architecture

```
index.html / app.html ── lib/edgedesk_access.js ──┬─► rpc my_billing_access()  ── billing_access_for() ── billing_row_grants_access()  ◄── THE RULE
                                                  ├─► create_checkout_session ─┐  (verify JWT → reconcile live → refuse if entitled →
                                                  │                            │   verify price = consent → reuse open session / customer →
                                                  │                            │   link customer BEFORE payment → Checkout Session with
                                                  │                            │   uuid on session + subscription + customer)
                                                  └─► sync_subscription ───────┤  (self | checkout_return(session_id) | admin_* | sweep)
                                                                               ▼
Stripe ── events ──► stripe_webhook ── billing_record_event (ledger, attempts)    reconcileUser()  (tools/billing/billing_core.js,
                     ├ mode check                                                   inlined into all three functions)
                     ├ billing_resolve_user: metadata → client_reference_id →      discover customers → list ALL their subscriptions →
                     │   our session → billing_customers → row ids → confirmed     pickBest → billing_apply_subscription_state(live,
                     │   email → (ask Stripe for the customer) → alert              authoritative) → alerts → billing_sync_log
                     ├ comp guard
                     └ reconcileUser (live)  | Stripe down → event body via the same writer (strict ordering)

pg_cron every 10 min ──► sync_subscription {action:'sweep'} (debounced in DB): unresolved deliveries, consent-without-access,
                          open sessions, stale periods, payment trouble, periodic verification of entitled rows

/admin/billing/ ──► billing_admin_overview / billing_admin_lookup (operator-only, caller's token) + sync_subscription admin_*
```

---

## 2. Root-cause possibilities for the reported failure (Connor)

Facts: account existed in Auth; card entered; **no row** in `subscriptions`. A row
with `status = null` would have meant "webhook ran without `STRIPE_SECRET_KEY`", so
that cause is **excluded** — there was no row at all. In descending likelihood:

| | Cause | How the old code produced "no row" | Distinguishing evidence (§2 queries) |
|---|---|---|---|
| **A** | Checkout delivery arrived but could not be named | Payment Link reached **without** `client_reference_id` (bookmarked/shared/history link, or any path other than `confirmArl`) **and** the Stripe email did not equal a *confirmed* account email (Apple Pay relay address, Link, a typo, an unconfirmed account). `resolveUser` → unresolved → 200 → kept forever. Every later event for that `cus_` also unresolved: Payment Links put nothing on the subscription and the customer was never mapped. | Unresolved `checkout.session.completed` near the signup time; its `customer_details.email` ≠ his account email or `client_reference_id` null |
| **B** | The payment landed on a **different** account | Signup with email confirmation returns no token, so a *previous* account's session stayed in `localStorage`; "Start free trial" sent **that** uuid to Stripe. (Also: two accounts for one person.) | A subscription row created at his checkout time on another `user_id`; Stripe customer email = his |
| **C** | Webhook not delivered | Dashboard redeploy with "Verify JWT" left ON (every delivery 401), endpoint disabled after repeated failures, rotated signing secret, a failed bundle leaving an old build serving | No `stripe_events` rows at all in that window; Stripe Dashboard → Webhooks → endpoint → failed attempts |
| **D** | `client_reference_id` named an account that does not exist | FK violation on upsert → 500 → Stripe retries 3 days → gives up | `stripe_events` row for his checkout, `applied = false`, reference not in `auth.users` |
| **E** | Checkout never completed | Card declined at trial setup, 3-D Secure abandoned, page closed before confirmation — he *entered* a card but Stripe has no live subscription | Nothing in the ledger; Stripe shows an `incomplete`/`incomplete_expired` subscription or only an expired session |

Run these before deploying anything (read-only):

```sql
-- who
select id, email, email_confirmed_at, created_at, last_sign_in_at
  from auth.users where email ilike '%connor%' order by created_at;

-- did he reach checkout? (confirmArl writes this immediately before Stripe)
select created_at, user_email, consent_version from public.billing_consents
 where user_id = '<UID>' order by created_at;

-- everything Stripe told us that mentions him (A, B, D)
select id, type, created_at, resolved, applied, note, customer_id, subscription_id, user_id,
       payload->'data'->'object'->>'client_reference_id'                         as client_reference_id,
       coalesce(payload->'data'->'object'->'customer_details'->>'email',
                payload->'data'->'object'->>'customer_email')                   as stripe_email
  from public.stripe_events
 where payload::text ilike '%<UID>%' or payload::text ilike '%connor%'
 order by created_at;

-- every unresolved delivery around his signup (A, C if empty)
select id, type, created_at, customer_id, note,
       coalesce(payload->'data'->'object'->'customer_details'->>'email',
                payload->'data'->'object'->>'customer_email') as stripe_email,
       payload->'data'->'object'->>'client_reference_id' as client_reference_id
  from public.stripe_events
 where not resolved and created_at between '<SIGNUP>'::timestamptz - interval '1 hour'
                                       and '<SIGNUP>'::timestamptz + interval '3 days'
 order by created_at;

-- did somebody else's row get his subscription? (B)
select s.user_id, u.email, s.status, s.stripe_customer_id, s.stripe_subscription_id, s.created_at
  from public.subscriptions s join auth.users u on u.id = s.user_id
 where s.created_at between '<SIGNUP>'::timestamptz - interval '1 hour' and '<SIGNUP>'::timestamptz + interval '3 days';
```

**After deploying**, the same diagnosis is one search in `/admin/billing/` for his
email, which also asks Stripe live. Then:
* Stripe has his subscription under a customer with his email → **Repair from Stripe**
  (the comp_trial row is replaced by the real subscription and the `comp_trial`
  sentinel is removed).
* Under a different email (Apple relay) → find the `cus_` in Stripe → **Link customer**.
* On another account (B) → decide which account is his; that is a human call.
* Stripe has nothing (E) → leave the comp_trial; when it expires he is now offered
  checkout instead of being bounced (§2-G below).

### Other defects found during the audit (all fixed)

* **G. An expired trial could not buy.** `index.html edSubState()` treated any
  `trialing` row as paid; `app.html` locked it. Expired comp_trial → "already has
  access" → app → paywall "email us" → … a loop. Connor's comp_trial expires in 7 days.
* **H. Cancelling a duplicate locked out the real subscription.** The webhook wrote
  whichever subscription an event was about over the account's single row.
* **I. `price_id` never synced.** A comp_trial customer who later paid kept
  `price_id='comp_trial'`, so the funnel trigger, lifecycle emails and the
  lockout report all skipped a paying customer.
* **J. A dead session locked out a paying customer.** `sbFetch` falls back to the
  anon key on 401; `subscriptions` under anon is empty → `pgCheck` said *locked*.
  It now says *unknown* (the paywall fails open; RLS still governs data).
* **K. A non-existent `client_reference_id` caused a 3-day 500 retry loop**
  (FK violation) and then a lost delivery.
* **L. Newer Stripe API versions** moved `invoice.subscription` under
  `parent.subscription_details`; the webhook read only the old field.
* **M. Payment Links create a new Stripe customer per checkout**, so a second
  purchase was never recognised as the same person.
* **N. A referral-column select** (`select=…,referral_code`) silently failed on a
  project without `referral_codes.sql`, which also skipped the comp guard read.

---

## 3. Failure-mode matrix

"Test" names the assertion group in `tools/billing/billing_flow.test.js` (§n) unless noted.

| # | Failure mode | What happened before | What happens now | Mechanism | Test |
|---|---|---|---|---|---|
| 1 | `checkout.session.completed` arrives, `subscription.created` not yet | Lookup of the one subscription by id; OK if `STRIPE_SECRET_KEY` set | Live listing of every subscription on every customer of the account | `reconcileUser` | §1, §8 |
| 2 | `subscription.created` before the checkout | **Unresolved** (no metadata on Payment-Link subscriptions); only fixed if the checkout landed | Resolves **itself** by `subscription_data.metadata`; for Payment-Link subs, resolved retroactively when the checkout links the customer | metadata, `billing_link_customer` | §1, §8 |
| 3 | `subscription.updated` first | Same as 2 | Same as 2 | | §8 |
| 4 | Duplicate delivery | Re-applied; ledger `resolved/applied` reset | Same final state; `attempts` counted; one row | `billing_record_event`, idempotent writer | §6 |
| 5 | Delayed webhook | Success page polled 40 s then "email support" | Success page asks the server, which asks Stripe; webhook later changes nothing | `sync_subscription checkout_return` | §5 |
| 6 | Webhook answered 500 | Retried by Stripe; nothing else | Retried by Stripe; error kept on the ledger; alert after 3 attempts; sweep/self-sync converge meanwhile | `last_error`, `webhook_failing` | §13 |
| 7 | Browser closed before redirect | Webhook only | Webhook (resolves without the browser); else sweep within 10 min | webhook, sweep | §4, §9 |
| 8 | Success page loads before webhook | Polled DB | Reconciles live with the session id | finalize | §5 |
| 9 | Apple Pay / wallet redirect differs (in-app browser hands off to Safari, other browser) | Return page on a signed-out browser → marketing page | "Payment received. **Log in** to finish" — never "sign up"; after login the app finalizes | `retnSignedOut`, `edgedesk_finalize` | access_client §6 |
| 10 | Stripe email ≠ Supabase email | Only a problem without `client_reference_id`, then unresolved forever | Irrelevant: metadata / customer link / session id name the account | resolver order | §2, §14 |
| 11 | Account email changes later | Email fallback stopped matching | Irrelevant (ids, not emails) | | §14 |
| 12 | Checkout without `client_reference_id` | Unresolved forever unless confirmed email matched | Server checkout always sets it; for legacy links: confirmed-email match, then *Refresh access* / sweep discover by email or by the session's own reference; else support links once | `discoverCustomers` | §9 |
| 13 | Subscription metadata missing user id | Normal for Payment Links → unresolved | Known customer / known subscription / session / retroactive link | resolver | §8 |
| 14 | Two Checkout Sessions for one user | Two sessions, two possible charges | Open session for the same offer reused (30 min) + 10 s idempotency key | `billing_checkout_sessions`, idempotency | §12 |
| 15 | Duplicate Stripe subscriptions | Last event wins the row; cancelling either could lock out | Best live one shown; `duplicate_active_subscriptions` alert; cancelling the duplicate never locks out | `pickBest`, writer duplicate guard | §12 |
| 16 | Card declines / 3-DS abandoned | `incomplete` written (no access) — correct | Same; opens the moment Stripe says paid | rule | §10 |
| 17 | Trial starts | `trialing` via lookup | Same, from the live listing | | §1 |
| 18 | Trial converts | `subscription.updated` → active | Same | | §10, lifecycle |
| 19 | Trial payment fails | past_due → 21-day grace | Same (explicit in the one rule) | rule | §10 |
| 20 | past_due | 21-day grace in 3 of 6 copies; `index.html` said **unpaid** | 21-day grace everywhere; offer `fix_payment` after | rule | §10 |
| 21 | Canceled immediately | `deleted` → canceled | Same; late older events cannot resurrect | ordering | §7 |
| 22 | `cancel_at_period_end` | Access to period end | Same | | §10 |
| 23 | Subscription deleted | canceled | Same — unless another live subscription exists (then that one is shown) | `pickBest` | §12 |
| 24 | Refund / dispute | Not handled | Unchanged access (Stripe's status is the authority); `charge.dispute.created` raises an alert for a human | `ALERT_ONLY` | stripe_webhook.test |
| 25 | Logs in on another device right after paying | Same DB row, if written | Paywall reconciles once if the row may be behind | `pgCheck` + `should_sync` | §4, access_client §5 |
| 26 | Stale frontend cached state | Row re-read on every boot (no cache) — fine; but a dead session showed **locked** | Decision re-read on every boot; dead session → *unknown* (fails open) | `EDAccess.read` | access_client §2, §5 |
| 27 | Supabase request fails temporarily | Paywall failed open (good); webhook 500 (good) | Same; plus success page bounded retry; consent never written for a checkout that cannot open | | §13 |
| 28 | Events out of chronological order | JS read-then-write guard on `last_event_at` (racy) | Live reads make order irrelevant; event bodies ordered strictly in SQL under a row lock; live vs event clocks never compared exactly | writer | §7, hardening SQL §4 |
| 29 | Stripe API timeout | Checkout row written with **null status** (locked out) | 4 s deadline; subscription events fall back to their own body; a checkout answers 500 so Stripe redelivers | core, webhook | §13 |
| 30 | DB write fails after payment | 500, Stripe retries | Same, error on the ledger, alert after 3 | | §13 |
| 31 | Stale session from a previous account | Payment attached to the **wrong account** | Session cleared on a confirmation-pending signup; server derives the account from the token | index.html | access_client §6 |
| 32 | `client_reference_id` names no account | FK 500 for 3 days, then lost | Rejected as "names no account", 200, alert | resolver | §14 |
| 33 | Test-mode event on the live secret | Processed | 400 *mode mismatch* (lossless; Stripe keeps it) | mode check | §14 |
| 34 | Stripe price ≠ consented price | Only `verify_stripe_offer.js` (manual) | `create_checkout_session` refuses before creating anything | `offerProblem` | §15 |
| 35 | Expired comp_trial tries to buy | Loop: "already has access" ↔ paywall | Offered the trial; checkout opens | `offer` | §11 |
| 36 | A hand-made row carries a customer id Stripe never heard of | n/a (nothing re-read Stripe) | That customer counts as empty; the account's real customers are still read | core: only 5xx/429/network abort | §9 |
| 37 | Staging project with a test-mode primary endpoint | Test deliveries had no key | `STRIPE_MODE=test` reads Stripe with `STRIPE_SECRET_KEY`; a live delivery there is refused | `stripeKeyFor`, mode check | §9 |

---

## 3b. The access model (Phase 3)

One function decides: `public.billing_row_grants_access(status, price_id, current_period_end, at)`.
The business rules are the ones the existing code already enforced in most places, now made explicit:

| Status | Access | Condition |
|---|---|---|
| `active` | **yes** | until `current_period_end` (null = no known end) |
| `trialing` | **yes** | until `current_period_end` — this is how a `comp_trial` closes itself |
| `active` + `price_id = 'owner_comp'` | **yes** | always (a comp does not lapse) |
| `past_due` | **yes** | for **21 days** past `current_period_end` (Stripe is still retrying; decided explicitly — this was the existing rule in app.html, community_is_entitled and comp_trial.sql) |
| `paused` | **no** | decided explicitly (Stripe pauses a trial that ended without a payment method) |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `null`, anything unknown | **no** | |

Who uses it: `my_billing_access()` (both pages, via `lib/edgedesk_access.js`),
`billing_access_for()` (functions), `community_is_entitled()` (redefined to defer
to it — and through it `tennis_record.sql` and `personal_research.sql`), the
reports. The JavaScript copies (`billing_core.js`, `edgedesk_access.js`) exist
only to rank candidates without a round trip and for the deploy window; they are
held equal to the SQL over a 300-case grid.

**Stripe grants; Stripe only revokes what Stripe granted.** A row entitled
*without* a Stripe subscription behind it (owner_comp, comp_trial, a hand-made
row) is never downgraded by a Stripe state — the disagreement becomes a
`db_active_stripe_inactive` alert (none for comp_trial, where it is expected).

---

## 4. Files

| File | Change |
|---|---|
| `supabase/billing_hardening.sql` | **new** — the rule, the decision, the writer, the resolver, the ledger RPC, `billing_customers`, `billing_checkout_sessions`, `billing_sync_log`, `billing_alerts`, rate limits, sweep, admin diagnostics, backfill, report |
| `supabase/billing_reconcile_cron.sql` | **new** — pg_cron job (every 10 min) |
| `supabase/functions/stripe_webhook/index.ts` | **rewritten handler** (signature check, dry-run secret, referral attribution and build marker kept) |
| `supabase/functions/create_checkout_session/index.ts` | **new** |
| `supabase/functions/sync_subscription/index.ts` | **new** |
| `tools/billing/billing_core.js` | **new** — canonical shared core; `tools/billing/inline_core.js` copies it into the three functions |
| `lib/edgedesk_access.js` | **new** — the browser's one door to the decision |
| `index.html` | `edSubState` → the decision; `confirmArl` → server checkout (Payment Link fallback); success page rewritten; stale-session fix; login-after-paying |
| `app.html` | `pgCheck` → the decision + one reconciliation before a paywall; finalize on return; *I already paid* → reconcile; Settings *Refresh access*; paywall offer from the decision |
| `admin/billing/index.html` | **new** operator console |
| `tools/billing/*.test.js`, `_harness.js`, `_pgrest.js`, `_fake_stripe.js` | tests (§8) |
| `tools/personal/personal_wiring.test.js` | consent-ordering assertion updated to the stricter rule |
| `package.json`, `.github/workflows/personal-tests.yml` | new suites; path filters now include the billing functions (they did not include `stripe_webhook/` before) |
| `supabase/functions/stripe_webhook/README.md`, `supabase/functions/README.md`, `supabase/README.md` | docs |

## 5. SQL migrations

1. **`supabase/billing_hardening.sql`** — additive and idempotent; nothing is
   dropped and no existing `subscriptions` value is rewritten (asserted). It:
   * adds tables `billing_customers`, `billing_checkout_sessions`,
     `billing_sync_log`, `billing_alerts`, `billing_sweep_state` (RLS on, no
     client grants);
   * adds columns `stripe_events.{attempts,last_delivery_at,processed_at,last_error,resolved_how,livemode}`
     and `subscriptions.{stripe_synced_at,sync_source,livemode}`;
   * creates `subscriptions_stripe_subscription_uk` (unique, partial) **only if
     the data already satisfies it** — otherwise report row 6 says CHECK THIS and
     names the ids;
   * backfills `billing_customers` only from unambiguous evidence (a customer on
     exactly one row; a resolved delivery), and links never-resolved checkout
     deliveries whose `client_reference_id` names a real account (retroactively
     resolving their events);
   * redefines `community_is_entitled()` to defer to the rule **only where it is
     already installed**;
   * ends in an 11-row report. Rows 6 and 8 can legitimately say CHECK THIS on
     production data (a Stripe subscription or customer on two accounts) — those
     are decisions for a human, which is why the file does not make them.

   Function grants: only `my_billing_access()` and the operator functions
   (which check `billing_is_admin()` inside) are callable by `authenticated`;
   everything else is `service_role` only. Supabase's default EXECUTE grants to
   anon/authenticated are explicitly revoked.

2. **`supabase/billing_reconcile_cron.sql`** — needs pg_cron + pg_net; schedules
   `billing_reconcile_sweep`; ends in a report.

## 6. Edge Functions

**`stripe_webhook`** (`BUILD stripe_webhook-2026-10-04-hardening-1`)
* unchanged: HMAC verification, replay window, dry-run test secret, build marker,
  comp guard, referral attribution (separate write, first wins);
* new: mode validation (`STRIPE_MODE`), ledger via `billing_record_event` (falls back
  to the plain upsert before the migration), resolution via `billing_resolve_user`
  then the Stripe customer's own metadata/email, unresolved → alert, live
  reconciliation of the whole account, payload fallback through the same writer,
  checkout-without-state → 500 (retry) when a key is configured, invoice
  `parent.subscription_details`, extra optional events (`invoice.paid`,
  `checkout.session.expired`, `checkout.session.async_payment_*`,
  `customer.subscription.paused/resumed`), `charge.dispute.created` → alert only,
  structured JSON logs, 4 s Stripe deadline with no inner retry (Stripe retries).

**`create_checkout_session`** — see §1b. Secrets: `STRIPE_SECRET_KEY` (write
Customers + Checkout Sessions; read Prices, Promotion Codes, Subscriptions),
`STRIPE_PRICE_ID`, optional `STRIPE_TRIAL_DAYS` (7), `SITE_URL`,
`STRIPE_AUTOMATIC_TAX`, `BILLING_ONE_TRIAL_PER_ACCOUNT` (off = current behaviour).
**Kill switch:** unset `STRIPE_PRICE_ID` → 503 `not_configured` → the page falls back
to the Payment Link with no frontend deploy.

**`sync_subscription`** — self (12 / 10 min), checkout_return (20 / 10 min, uses
the session id only if that session is the caller's), sweep (anyone, debounced
in the database, counts only), admin_inspect / admin_sync / admin_link
(operator list checked as the caller).

All three: `--no-verify-jwt` (each verifies tokens itself via `/auth/v1/user`),
one file each, core inlined, no secrets in code, `SB_*` or `SUPABASE_*` env names.

## 7. Frontend

* `lib/edgedesk_access.js` — `read()` (RPC; falls back to the row + the same rule
  on 404), `startCheckout()` (fallback only on not-deployed/not-configured),
  `sync()`, `finalize()` (7 attempts, gaps 0–12 s, ≤ 4 reconciliations, ~35 s,
  then *pending* — never a loop).
* `index.html` — the success page: *"Payment received. Finalizing your EdgeDesk
  access…"* → finalize → open the app, or *"Your payment is safe… Do not create a
  new account or start another checkout"* with `EDS-XXXXXX` and a prefilled
  support email; signed-out return → *Log in*; `?checkout=cancel` → "nothing was
  charged". Consent is now written only after a checkout exists.
* `app.html` — paywall asks the decision and reconciles once before locking;
  *I already paid* reconciles; Settings → Subscription → **Refresh access**.

## 8. Tests

| Suite | Needs | Assertions | What |
|---|---|---|---|
| `tools/billing/billing_flow.test.js` | PostgreSQL | 126 | every scenario in §3, the three shipped functions against the real SQL and a fake Stripe |
| `tools/billing/billing_hardening_sql.test.js` | PostgreSQL | 86 | install over production-shaped data; the 300-case rule grid vs `community_is_entitled` and both JS copies; the writer's refusals; grants; admin |
| `tools/billing/subscriber_lifecycle.test.js` | PostgreSQL | 35 | trial → paid → past_due → cancel, two prices, Settings card |
| `tools/billing/stripe_webhook.test.js` | — | 121 | signature, event reading, contracts |
| `tools/billing/comp_entitlement.test.js` | — | 101 | comps, both pages, the purchase-loop regression |
| `tools/billing/access_client.test.js` | — | 60 | the browser library; app.html paywall; index.html success page |
| `tools/billing/billing_core.test.js` | — | 50 | no drift between the three copies; best-pick; Stripe client; logs |
| `tools/personal/personal_wiring.test.js` | — | 74 | offer/consent wiring |

```bash
npm run billing:test     # offline suites (+ lifecycle, which starts its own Postgres)
npm run billing:sql      # hardening SQL + scenario flow (starts its own Postgres)
npm run billing:inline   # after editing tools/billing/billing_core.js
```

Pre-existing failures **not** caused by this change (they fail identically on the
base commit): `tools/articles/community.test.js` (a hardcoded "future" date of
2026-10-01) and `tools/record/pnl_ui.test.js` ("NFL Lean" label).

## 9. Deployment order

Each step is safe on its own; the frontend tolerates any backend step being
missing.

0. **Before anything:** run the §2 queries (keep the output); take a backup
   (Supabase → Database → Backups, or `pg_dump -t public.subscriptions -t public.stripe_events`).
1. **SQL:** paste `supabase/billing_hardening.sql` into the SQL editor. Read the
   report. The **old** webhook keeps working on the new schema (additive).
2. **Deploy `sync_subscription`** (`--no-verify-jwt`). `curl -s …/functions/v1/sync_subscription`
   → `configured.stripe_key/database/auth` all true.
3. **Deploy `stripe_webhook`** (paste path: delete → create → paste → *Verify JWT
   OFF* → deploy). `curl -s …/functions/v1/stripe_webhook` →
   `"build":"stripe_webhook-2026-10-04-hardening-1"`. Stripe → Webhooks → send a
   test event → 200.
4. **Deploy `create_checkout_session`** (`--no-verify-jwt`) and set
   `STRIPE_PRICE_ID` (the price behind `CHECKOUT_LINK`) — `GET` → configured all true.
5. **Merge this branch** (index.html, app.html, lib/edgedesk_access.js,
   admin/billing). Hard-refresh; the script tags carry `?v=20261004a`.
6. **SQL:** `supabase/billing_reconcile_cron.sql`.
7. **Stripe dashboard:**
   * Payment Link → After payment → `https://edgedesksports.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
     (the fallback path then also carries the session id);
   * Webhooks → add the optional events (`invoice.paid`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
     `customer.subscription.paused`, `customer.subscription.resumed`,
     `charge.dispute.created`);
   * Settings → Payment methods: Apple Pay / Google Pay / Link on (Checkout uses them automatically).
8. **Repair what already exists:** `/admin/billing/` → Connor; then the overview's
   alerts and unresolved deliveries.
9. Smoke tests (§12).

## 10. Rollback

| What | How | Effect |
|---|---|---|
| Server checkout | unset `STRIPE_PRICE_ID` (or delete the function) | page falls back to the Payment Link immediately; no deploy |
| Frontend | `git revert` the merge | old pages; they read `subscriptions` directly and work on the new schema |
| Webhook | redeploy the previous build: `git show <base>:supabase/functions/stripe_webhook/index.ts` | old build works on the new schema (it upserts columns that still exist) |
| Reconciliation | delete `sync_subscription`; `select cron.unschedule('billing_reconcile_sweep');` | pages treat a 404 as "not deployed" and keep reading |
| SQL | **leave it** (additive). If ever required: `drop index if exists subscriptions_stripe_subscription_uk;` and re-run `community_posts.sql` to restore its inline (semantically identical) rule | |

Nothing in this change deletes or rewrites existing billing data, so there is no
data rollback.

## 11. Post-deploy verification queries

```sql
-- 1. deliveries landing and resolving (last 24 h)
select type, count(*) n, count(*) filter (where resolved) resolved, count(*) filter (where applied) applied,
       count(*) filter (where last_error is not null) errored, max(created_at) latest
  from public.stripe_events where created_at > now() - interval '24 hours' group by type order by n desc;

-- 2. anything nobody could name, anything failing
select * from public.stripe_events_unresolved limit 20;
select id, type, attempts, last_error, created_at from public.stripe_events
 where last_error is not null order by created_at desc limit 20;

-- 3. open alerts (empty is healthy)
select * from public.billing_open_alerts;

-- 4. accounts whose state looks wrong from here
select * from public.billing_diagnostics where mismatch is not null;

-- 5. went to checkout, nothing recorded (the reported shape) — should trend to 0
select c.user_id, u.email, max(c.created_at) consented
  from public.billing_consents c join auth.users u on u.id = c.user_id
 where not exists (select 1 from public.subscriptions s where s.user_id = c.user_id)
 group by 1, 2 order by 3 desc;

-- 6. the sweep is running
select * from public.billing_sweep_state;
select status, start_time, return_message from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'billing_reconcile_sweep')
 order by start_time desc limit 5;

-- 7. who fixed what (repaired = the webhook missed it)
select source, outcome, count(*) from public.billing_sync_log
 where at > now() - interval '7 days' group by 1, 2 order by 1, 2;

-- 8. the rule agrees with itself everywhere (expect 0)
select count(*) from public.subscriptions s
 where public.community_is_entitled(s.user_id)
       <> public.billing_row_grants_access(s.status, s.price_id, s.current_period_end, now());

-- 9. one account, everything (or /admin/billing/)
select public.billing_user_report('<UID>');

-- 10. production-only RLS/functions that restate the rule (paywall.sql is not in the repo):
--     each should call billing_row_grants_access / community_is_entitled, not inline statuses
select schemaname, tablename, policyname, qual from pg_policies
 where qual ilike '%subscriptions%' or with_check ilike '%subscriptions%';
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.prosrc ilike '%subscriptions%' and p.prosrc ilike '%trialing%'
   and p.proname not in ('billing_row_grants_access', 'billing_access_for');
```

## 12. Production smoke-test checklist

Test mode first (`STRIPE_WEBHOOK_SECRET_TEST`, `STRIPE_SECRET_KEY_TEST`, a test
price — or a staging project with `STRIPE_MODE=test`), then live with a real card
you refund.

- [ ] `GET` each function → build + `configured` all true.
- [ ] New account → confirm email → *Start free trial* → consent → the browser goes to **checkout.stripe.com** (not buy.stripe.com).
- [ ] Pay with card → *"Payment received. Finalizing your EdgeDesk access…"* → app opens within seconds → Settings: Trial, ends in 7 days.
- [ ] Repeat with **Apple Pay** (iPhone Safari), **Google Pay** (Android Chrome), **Link**.
- [ ] Pay, then close the tab before the redirect → open the app on another device → access.
- [ ] Double-click *Start free trial* / two tabs → the same session.
- [ ] After paying, go back to the landing page and start again → *"already has full access"*.
- [ ] Settings → **Refresh access** → *Access confirmed*.
- [ ] Customer portal → cancel → Settings: *Access ends <date>*; webhook delivery 200.
- [ ] Test mode: disable the webhook endpoint → complete a checkout → the success page still opens the app (reconciliation) → re-enable → Stripe redelivers → nothing changes.
- [ ] `/admin/billing/` → search the test email → ACCESS GRANTED, Stripe live matches, no mismatch; overview shows the last webhook seconds ago.
- [ ] `comp_trial.sql` on a test account → access; set its date into the past → paywall offers the trial → checkout opens.
- [ ] Function logs: one JSON line per operation with user/session/customer/subscription/event ids; emails masked; no keys or tokens.
- [ ] §11 queries 1–8 look healthy.

## 13. Decisions left to you

* **Trials per account.** The Payment Link gives a trial to anyone who checks out,
  including a returning customer; that behaviour is preserved.
  `BILLING_ONE_TRIAL_PER_ACCOUNT=true` refuses a second trial instead.
* **Resubscribe.** `RESUBSCRIBE_LINK` is empty, so a lapsed subscriber is asked to
  email support (unchanged). A server-side no-trial checkout needs its own
  automatic-renewal consent text first, so it is not wired.
* **Refunds and disputes** do not change access automatically; cancel the
  subscription in Stripe to end access. Disputes raise an alert.
* **Report rows 6 and 8** (a Stripe id on two accounts) — decide the owner, fix the
  row, re-run the migration to create the unique index.
* **Hand-made entitled rows without a Stripe subscription** (e.g. the 2108 row) are
  protected from Stripe revoking them and raise `db_active_stripe_inactive`; convert
  each to `owner_comp`, a `comp_trial`, or delete it.
