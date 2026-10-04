# stripe_webhook — connecting Stripe to the product

Until this existed, **nothing was listening to Stripe.** `public.subscriptions`
was filled in by hand — nine rows typed into the SQL editor, six of them inside
ninety seconds, with `current_period_end` values in 2036 and 2108. The
consequences are all one consequence: somebody paid Stripe, no row was written,
the paywall refused them, and they left. Five of the hand-made rows have since
gone stale and are refusing real people entry today.

> **2026-10 — billing hardening.** A customer entered a card and the site never
> opened: no row, because the one delivery that could name the account never
> resolved and nothing ever asked Stripe again. This function now reconciles
> every delivery **live** against Stripe (every subscription on every customer
> the account has), resolves accounts by `metadata.supabase_user_id` first,
> raises anything it cannot name as an alert, and writes only through
> `billing_apply_subscription_state` (`supabase/billing_hardening.sql`). It is
> one of three billing functions now — `create_checkout_session` makes the
> checkout server-side with the account on the session, the subscription and
> the customer, and `sync_subscription` is the reconciliation the success page,
> the paywall, *Refresh access*, the operator console and a 10-minute schedule
> call. The whole design, the failure matrix, deployment order, rollback and
> verification queries are in **`docs/billing-hardening.md`**.

Everything below is done once, in order. Steps 1–4 take about ten minutes.

---

## 1 · The database, before the function

Paste into the SQL editor and run, **in this order**:

1. `supabase/billing.sql` — creates `billing_consents`, `referrals` and
   `subscriptions` if they are not already there, and makes `subscriptions`
   read-only to every client role. Rows 1–14 of its report should say `ok`.
2. `supabase/stripe_webhook.sql` — the delivery ledger, the ordering guard and
   the email lookup. Rows 1–9 should say `ok`.
3. `supabase/referral_codes.sql` — the discount codes, the attribution columns
   on `subscriptions` and the report. Rows 1–13 should say `ok`. It refuses to
   install before the other two, by name.
4. `supabase/billing_hardening.sql` — **required by this build**: the one access
   rule, the one writer, the resolver, the ledger RPC, the customer map, the
   sync log, alerts and diagnostics. Rows 6 and 8 may say `CHECK THIS` on real
   data (a Stripe id on two accounts); that is a decision for a human, and the
   rest still installs. After `sync_subscription` is deployed, also run
   `supabase/billing_reconcile_cron.sql` (the 10-minute sweep).

Row 9 of the second report is the one to read carefully. It counts rows that
are marked `active` with a `current_period_end` in the past — accounts the
paywall is refusing right now. Today that is five.

## 2 · Deploy the function

```bash
supabase functions deploy stripe_webhook --no-verify-jwt
```

**"Enforce JWT verification" must be OFF.** Stripe does not send a Supabase JWT;
it signs with its own secret, which is what this function verifies. Leave JWT on
and every delivery 401s while appearing deployed.

## 3 · Secrets

Project Settings → Edge Functions → Secrets:

| Name | Value |
|---|---|
| `SB_URL` | `https://iattxbkbufslbauoumga.supabase.co` |
| `SB_SERVICE_ROLE` | the `service_role` key (Project Settings → API) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…`, from step 4 — add it after creating the endpoint |
| `STRIPE_SECRET_KEY` | `sk_live_…`, or a restricted `rk_live_…` with **read** on Customers, Subscriptions, Checkout Sessions and Promotion Codes. Every delivery is answered by asking Stripe for the account's subscriptions; it also names a customer an event could not, and turns a `promo_…` id into the code the customer typed |
| `STRIPE_MODE` | optional: `live` (default) or `test` — the mode of the endpoint the **primary** secret belongs to. A delivery whose `livemode` disagrees with the secret that signed it is refused (400, so Stripe keeps it) |

`SB_URL` / `SB_SERVICE_ROLE` fall back to the `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` every function is given, so a function recreated in
the dashboard keeps working even if the custom names were not re-added.

Two more exist **only while a dry run is running** (§9). Unset is the normal
state and the live path is identical without them:

| Name | Value |
|---|---|
| `STRIPE_WEBHOOK_SECRET_TEST` | `whsec_…` from a **test-mode** endpoint pointed at the same URL |
| `STRIPE_SECRET_KEY_TEST` | `sk_test_…` — a test id looked up with a live key is a 404, which reads exactly like a code that does not exist |

`STRIPE_SECRET_KEY` is not optional in practice. A `checkout.session.completed`
carries no status, and this function refuses to invent one. With the key
configured but Stripe unreachable, a checkout is answered **500** so Stripe
redelivers it once Stripe can be asked; a subscription event falls back to its
own body under the strict ordering rule. Without the key, a paying customer is
written in with `status = null` — locked out by the very row recording it, which
is what happened on the first real checkout this webhook received.

`SB_SERVICE_ROLE` is what lets the function write `subscriptions` at all; RLS
blocks every client role from writing it, on purpose. **This key must never
appear in any file the browser loads.**

## 4 · The endpoint in Stripe

Stripe Dashboard → Developers → Webhooks → **Add endpoint**

* **URL** `https://iattxbkbufslbauoumga.supabase.co/functions/v1/stripe_webhook`
* **Events to send** — these six are required:
  * `checkout.session.completed`
  * `customer.subscription.created`
  * `customer.subscription.updated`
  * `customer.subscription.deleted`
  * `invoice.payment_succeeded`
  * `invoice.payment_failed`

  and these are understood when sent (each makes convergence faster or tells a
  human something; none is required):
  `invoice.paid`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
  `customer.subscription.paused`, `customer.subscription.resumed`,
  `charge.dispute.created` (raised as an alert only — a dispute never changes
  access by itself).

Stripe then shows a **signing secret** (`whsec_…`). Put it in
`STRIPE_WEBHOOK_SECRET` and redeploy the function so it picks the secret up.

## 5 · The payment links have to come back to the site

This is the step most easily missed, and without it a paying customer lands on
a Stripe receipt page and never returns to the product.

For **both** payment links — the landing page's and the terminal paywall's,
`CHECKOUT_LINK` and `RESUBSCRIBE_LINK` in `lib/edgedesk_pricing.js`, the only
place either is written — Stripe Dashboard → Payment links → the link →
**After payment** → *Redirect customers to a URL*:

```
https://edgedesksports.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}
```

(Stripe fills in `{CHECKOUT_SESSION_ID}`. Checkouts made by
`create_checkout_session` already come back this way; the Payment Link is now
only the fallback for when that function is not deployed or not configured.)

`handleCheckoutReturn()` in `index.html` says *"Payment received. Finalizing your
EdgeDesk access…"*, reads the access decision and asks `sync_subscription` to
reconcile with Stripe — using the session id, but only if that session is the
signed-in account's — with growing gaps for about half a minute. It never grants
access from the redirect itself. If access still cannot be confirmed it says the
payment is safe, shows an `EDS-XXXXXX` reference, and tells the customer **not**
to create another account or pay again; the webhook and the sweep keep working
after the page gives up.

Also confirm **Settings → Business → Public business name**. The checkout page
currently reads **"Submarine Catalyst"**, which is not a name any EdgeDesk
customer has seen, and the landing page promises "Billed monthly by Rackler
Tech Ventures LLC". A payment page that names an unknown company reads as
fraud and is the most likely reason people reach checkout and stop.

## 6 · Prove it works

Stripe → Webhooks → your endpoint → **Send test webhook** →
`customer.subscription.updated`. You want `200` back.

Then, from the SQL editor:

```sql
select id, type, resolved, applied, note, created_at
from public.stripe_events order by created_at desc limit 10;
```

A test event lands `resolved = false` with *"no account matched this customer
yet"* — that is correct, the fake customer has no account.

Then check no live customer is stranded:

```sql
select user_id, status, current_period_end, last_event_id
from public.subscriptions where status is null;
```

Any row there is somebody who reached checkout and cannot get in. Set
`STRIPE_SECRET_KEY` if it is missing, then open `/admin/billing/`, search the
customer, and press **Repair from Stripe** — or simply wait for the 10-minute
sweep, which picks up rows with no status on its own.

**Resending an old event now works too.** The ordering guard still refuses an
event *body* older than what the row reflects — but with a key configured every
delivery is answered by asking Stripe for the account's current state, so a
resend is just a prompt to look again.

Then do a real one: sign up with an address you have never used, take the trial,
and watch a row appear in `public.subscriptions` with `last_event_id` set. Any
row where `last_event_id` is null was written by hand, not by Stripe.

## 7 · Repairing the five locked-out rows

Once deliveries are landing, let Stripe answer rather than guessing:
`/admin/billing/` → search each customer → **Repair from Stripe** (or wait for
the sweep: a Stripe-backed row whose period ended with no renewal recorded is
re-checked automatically). A row that grants access with **no** Stripe
subscription behind it is never revoked by Stripe — it raises a
`db_active_stripe_inactive` alert instead, because only a human knows whether it
was a comp.

If Stripe has no subscription for one of them, they were never a customer and
the row should be deleted. That is a decision about money, so a human makes it —
`stripe_webhook.sql` deliberately does not touch those rows.

## 8 · The discount code, and who came in through it

### Percent off, not a free extra week

Checkout here is a **Stripe Payment Link**, and the 7-day trial lives on the
price behind it — `TRIAL_DAYS` in `index.html` only *displays* it. A Stripe
coupon takes a percentage or an amount off an invoice; **it cannot extend a
trial.** Trial length is fixed when the subscription is created, which for a
payment link means a *second* link on a *second* price: two URLs to keep in
step, two prices to keep at the same figure, and an automatic-renewal consent record
whose `trial_days` is wrong for whichever link the customer did not take.

A percent-off coupon needs none of that. One link, one price, one consent text,
and the code is typed on Stripe's own checkout page.

**The one compliance note.** `billing_consents` stores `price_display =
"$49.99"` — the figure shown before the customer left for Stripe. Somebody who
then redeems a code is charged *less* than that, which is not the ARL problem
(the problem is being charged more, or on terms never shown), so a
`duration: once` coupon is fine exactly as it is. **If the coupon is ever made
`duration: forever`, the renewal price stops being the figure in the consent
record** — and the consent text has to say so *before* that code is handed out.

### Creating it

1. **Products → Coupons → New.** Percent off; pick the duration (`once` is the
   safe default, see above). Give it a name you will recognise in a Stripe
   export.
2. On that coupon, **Promotion codes → Create**, code `BETDESK`. Stripe shows a
   `promo_…` id next to it — **copy that id.**
3. **Payment links →** each link **→ Allow promotion codes: ON.** There are
   **two** links (the landing page's and the terminal paywall's) and the box is
   per-link. A link without it never shows the code field, and the customer has
   no way to redeem anything.
4. Put the code, the partner name and that `promo_…` id into the config block
   at the top of `supabase/referral_codes.sql` and run it. With the id on file,
   the webhook names the code from the database and never has to call Stripe at
   all — which is what keeps attribution working on a day the Stripe API is
   slow or the key is unset.

### What the webhook then records

On `checkout.session.completed` it reads the promotion code off the session
(and, failing that, off the subscription Stripe returns), names it, and writes
to `public.subscriptions`:

| column | |
|---|---|
| `referral_code` | the code, upper-cased — Stripe redeems case-insensitively, so `BETDESK` and `betdesk` must not become two lines |
| `referred_partner` | `partner_name` **as it stood at the sale** — a snapshot, like the offer text on a consent |
| `stripe_promotion_code_id` | what Stripe actually said. **This is the discriminator**: two promotion codes can share one coupon, so "a discount was applied" is not attribution |
| `stripe_coupon_id` | the coupon behind it |
| `referral_source` | where it was seen and how it was named — `checkout_session:inline`, `…:referral_codes`, `…:stripe_lookup`, `…:unnamed_discount`, `subscription_object:…`, or `manual` |

Three things it will not do:

* **It never invents a code.** A coupon applied with no promotion code behind
  it is recorded as an *unnamed discount* and reported on its own line. It is
  never credited to the only code on file.
* **The first attribution wins.** The write is `PATCH
  subscriptions?user_id=eq.…&referral_code=is.null` — the condition is in the
  *filter*, so two deliveries racing produce one credited code rather than
  whichever landed last. A row carrying an unnamed discount still matches, so
  it can be upgraded the moment the code can be named.
* **It cannot cost anybody their access.** The attribution is a separate write
  from the subscription row. On a project where `referral_codes.sql` has not
  been run those columns do not exist, and folding them into the status write
  would make every delivery a `500` — Stripe retrying a paying customer forever
  while their status never lands. It fails on its own and says so in the log.

A comped row is never credited to a code: the comp guard returns before the
attribution write, because a comp was never sold.

## 9 · The dry run, before any of this touches live money

Three layers, cheapest first. The first two risk nothing at all.

### a. Prove the reader against a real payload — no deploy, no network

There is exactly one thing that cannot be known from this repository: **where
this Stripe account puts the promotion code.** `session.discounts` arrived in
API version `2025-01-27.acacia`; older versions carry it elsewhere. Read the
wrong field and the webhook records "no code used" for a sale that used one,
silently, forever. This is the same trap that once lost `current_period_end`.

So take a real delivery from your own account and run it through the real
reader:

```
Stripe (TEST MODE) → do a checkout with the test promo code
  → Developers → Events → the checkout.session.completed → copy the JSON

node tools/billing/replay_event.js /tmp/evt.json
```

It prints the row that would be written. If it finds nothing but the payload
mentions a discount, it prints the fields the payload actually holds — which is
the answer, not a bug report. It makes no network call and writes nothing.

### b. Confirm which build is deployed

Every response carries `build` and an `x-edgedesk-build` header, **including the
405 a plain GET gets**, so this needs no signed event and no secret:

```bash
curl -s https://iattxbkbufslbauoumga.supabase.co/functions/v1/stripe_webhook
{"build":"stripe_webhook-2026-10-04-hardening-1","error":"POST only"}
```

The dashboard deploy path is delete the function → create it again under the
same name → clear the template → paste → **Verify JWT off** → deploy. A bundle
that fails leaves the *previous* version serving, which is indistinguishable
from a deploy that worked and changed nothing. That string is how the two are
told apart, so **bump `BUILD` with every paste.**

### c. End to end in test mode, without disturbing the live secret

A test-mode endpoint signs with **its own** secret. Swapping the live secret out
and back to test it is an outage during which real payments are refused — so
the function accepts a second, optional one instead:

1. Stripe **test mode** → Developers → Webhooks → Add endpoint → the **same**
   function URL, the same six events. Copy its `whsec_…`.
2. Set `STRIPE_WEBHOOK_SECRET_TEST` to that, and `STRIPE_SECRET_KEY_TEST` to a
   `sk_test_…`. Leave the live secrets exactly as they are. Redeploy.
3. In test mode: make the same coupon and a promotion code with the same
   spelling, switch the payment link to its test version, and buy it with
   `4242 4242 4242 4242` from a throwaway EdgeDesk account.
4. Check it landed:

```sql
select user_id, status, referral_code, referred_partner,
       stripe_promotion_code_id, referral_source
  from public.subscriptions where referral_code is not null
 order by updated_at desc limit 5;

-- every test delivery, findable again by Stripe's own flag
select id, type, created_at, payload->>'livemode' as livemode
  from public.stripe_events where payload->>'livemode' = 'false'
 order by created_at desc limit 10;
```

A test delivery answers `"livemode": false` and warns in the function log, so it
can never quietly pass for a sale. **When the dry run is done, delete both
`_TEST` secrets, delete the test-mode endpoint, and delete the test account's
row** — a test subscription left in `public.subscriptions` is a fake customer on
every report from then on.

## 10 · Reading the report

Periodically, in the SQL editor. Nothing about this is public and no client role
can reach any of it.

```sql
select * from public.referral_code_report;
```

| column | |
|---|---|
| `code` | the code — or `(unattributed)`, `(discount, code not resolved)`, `(revenue not matched to any subscription)` |
| `signups` / `still_active` | every subscription under that code, and how many still have access by the paywall's own rule |
| `revenue_cents` / `revenue_usd` | **gross**, summed from the `invoice.payment_succeeded` payloads this project actually received |
| `currencies` | `revenue_usd` is null unless this is exactly `USD`, because a figure that might be 100× wrong is worse than no figure |

Who, by name:

```sql
select code, user_email, status, still_active, revenue_cents, referral_source
  from public.referral_signups where code = 'BETDESK' order by subscription_created_at;
```

**What the numbers are not.** Revenue is gross: `charge.refunded` is
deliberately not a handled event, so no refund is in the ledger and none is
subtracted. The window is the ledger's window — nothing reconstructs revenue
from before this webhook was listening, and nothing estimates. Row 12 of
`referral_codes.sql`'s report says what that window actually is.

**Nothing is dropped and nothing is guessed.** Every subscription is on the
report exactly once. A sale with no code is `(unattributed)`; a discount that
could not be named gets its own line rather than the unattributed pile; invoices
that match no subscription row get a line of their own, so the report's total is
the ledger's total. That last one is asserted on a real PostgreSQL by
`tools/app/sql/referral_codes.test.sql`.

---

## 11 · Changing the price

The price is not in this function, and it never grants access: every
entitlement check reads `status` and `current_period_end`, and `price_id` is
only ever compared with the comp sentinels (`owner_comp`, `comp_trial`). So a
new price needs **no change here** — a subscriber on the old price and one on
the new are both just `active` or `trialing`, and nobody loses access because
their price differs.

What does change, in order:

1. **Stripe: a new recurring price** on the EdgeDesk product — USD, monthly,
   the amount in `PRICE_CENTS` in `lib/edgedesk_pricing.js`. Name the product
   *EdgeDesk Full Access*; that is what Stripe Checkout shows.
2. **Stripe: new payment links on it.** A payment link's price cannot be
   edited, so the old links cannot be pointed at the new price. Make two:
   * the **trial** link — *Include a free trial*, 7 days (`TRIAL_DAYS`);
   * the **resubscribe** link — no trial.

   On both: *Allow promotion codes* ON (§8), *After payment* → redirect to
   `https://edgedesksports.com/?checkout=success` (§5), and — if Stripe Tax is
   on — the same tax behaviour as before.
3. **Prove it before the site says it:**
   `STRIPE_SECRET_KEY=rk_live_… node tools/billing/verify_stripe_offer.js
   https://buy.stripe.com/<trial> https://buy.stripe.com/<resubscribe>`
   (a restricted key with read access to Payment Links, Prices and Products is
   enough). It checks each link is live and active, sells exactly one active
   recurring monthly USD price of `PRICE_CENTS`, and carries the trial the
   page promises — and that the retired links are switched off.
4. **Paste both URLs** into `CHECKOUT_LINK` / `RESUBSCRIBE_LINK` in
   `lib/edgedesk_pricing.js`, run the verifier once more with no arguments,
   and deploy. Until a link is pasted there, the page refuses to send anybody
   to checkout rather than sending them to a link at a different price.
5. **Deactivate the old links** in Stripe. They are refused by the site by
   name already (`RETIRED_LINKS`), but a bookmarked link would still sell the
   old price.
6. Existing subscriptions keep the price they were sold at until **you** move
   them in Stripe (Subscriptions → the subscription → *Update subscription* →
   the new price). Nothing in this repository moves anybody. Run
   `supabase/subscription_price.sql` so Settings shows each subscriber the
   price Stripe actually has them on; its report row 4 shows who is still on
   the old figure.

**Emails.** Nothing in this repository sends a trial reminder, a receipt or a
failed-payment email, and no template here states a price. If those go out,
Stripe sends them from its own settings (Settings → Billing → *Subscriptions
and emails* / *Customer emails*), and Stripe's templates read the amount off
the subscription — so check there that the trial reminder is switched on, since
the landing page promises one before day 8.

## What it guarantees

**It does not trust the caller.** The endpoint is public and grants a paid
product. Every request is checked against `STRIPE_WEBHOOK_SECRET` with
HMAC-SHA256 over Stripe's exact signed payload, compared in constant time,
inside a five-minute window. A forged body, a wrong secret, a real signature
over an edited body, and an hour-old replay are each refused — and the response
never says which, because telling a forger why they failed is free help.

**A retry is not a second write.** Events are keyed on Stripe's own id.

**An old delivery cannot resurrect a cancelled subscription.** A delivery is
answered with Stripe's state *now*; when Stripe cannot be asked, the event body
is applied only if it is newer than everything the row reflects — decided in
`billing_apply_subscription_state` under a row lock, not in a read-then-write.

**A cancelled duplicate cannot lock out the subscription in use.** The row
describes the best of every subscription the account has; two live ones raise a
`duplicate_active_subscriptions` alert.

**An unknown customer is not an error — and not forgotten.** It is answered
`200`, kept, raised in `billing_alerts`, and resolved **retroactively** the moment
its customer is linked to an account (a later checkout, *Refresh access*, the
sweep, or support). Look at `public.billing_open_alerts`; empty is healthy.

**It never invents a user.** Identification is `metadata.supabase_user_id`, then
`client_reference_id`, then our own checkout-session record, then a linked
customer or subscription, then an exact email match **on a confirmed account
only** — and, still unresolved, the Stripe customer's own metadata and email. An
id that names no account is rejected rather than written (a foreign-key failure
used to be a three-day retry loop). An unconfirmed address proves nothing.

**A lost payment is louder than a failed one.** A missing service role or a
failed `subscriptions` write answers `500` so Stripe retries; only genuinely
handled outcomes answer `200`.

**A code is never invented and never moved.** A coupon with no promotion code
behind it names no partner. The first attribution wins, enforced in the filter
of the write rather than by a read before it. And recording it can never fail
the delivery that carries the money.

Held by `tools/billing/billing_flow.test.js` (every scenario in
`docs/billing-hardening.md` §3, this function and its two siblings run whole
against the real SQL and a fake Stripe), `tools/billing/billing_hardening_sql.test.js`,
`tools/billing/billing_core.test.js` (the inlined core is byte-identical in all
three functions), `tools/billing/stripe_webhook.test.js` (run against the
deployed file itself with no second copy to drift), by
`tools/billing/comp_entitlement.test.js`, and by
`tools/app/billing_sql.test.js` against a real PostgreSQL — which applies
`billing.sql`, `stripe_webhook.sql` and `referral_codes.sql`, then attacks the
report with `tools/app/sql/referral_codes.test.sql`: a subscription dropped off
it, a sale credited to the wrong code, an invoice counted twice, revenue that
arrived and is on no line. It also lifts the shipped `community_is_entitled()`
out of `community_posts.sql` and checks the report and the paywall still agree
about who has access, rather than writing a fourth copy of that rule.
