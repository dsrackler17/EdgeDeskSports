# stripe_webhook — connecting Stripe to the product

Until this existed, **nothing was listening to Stripe.** `public.subscriptions`
was filled in by hand — nine rows typed into the SQL editor, six of them inside
ninety seconds, with `current_period_end` values in 2036 and 2108. The
consequences are all one consequence: somebody paid Stripe, no row was written,
the paywall refused them, and they left. Five of the hand-made rows have since
gone stale and are refusing real people entry today.

Everything below is done once, in order. Steps 1–4 take about ten minutes.

---

## 1 · The database, before the function

Paste into the SQL editor and run, **in this order**:

1. `supabase/billing.sql` — creates `billing_consents`, `referrals` and
   `subscriptions` if they are not already there, and makes `subscriptions`
   read-only to every client role. Rows 1–14 of its report should say `ok`.
2. `supabase/stripe_webhook.sql` — the delivery ledger, the ordering guard and
   the email lookup. Rows 1–9 should say `ok`.

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

`SB_SERVICE_ROLE` is what lets the function write `subscriptions` at all; RLS
blocks every client role from writing it, on purpose. **This key must never
appear in any file the browser loads.**

## 4 · The endpoint in Stripe

Stripe Dashboard → Developers → Webhooks → **Add endpoint**

* **URL** `https://iattxbkbufslbauoumga.supabase.co/functions/v1/stripe_webhook`
* **Events to send** — exactly these six:
  * `checkout.session.completed`
  * `customer.subscription.created`
  * `customer.subscription.updated`
  * `customer.subscription.deleted`
  * `invoice.payment_succeeded`
  * `invoice.payment_failed`

Stripe then shows a **signing secret** (`whsec_…`). Put it in
`STRIPE_WEBHOOK_SECRET` and redeploy the function so it picks the secret up.

## 5 · The payment links have to come back to the site

This is the step most easily missed, and without it a paying customer lands on
a Stripe receipt page and never returns to the product.

For **both** payment links — the landing page's and the terminal paywall's —
Stripe Dashboard → Payment links → the link → **After payment** →
*Redirect customers to a URL*:

```
https://edgedesksports.com/?checkout=success
```

`handleCheckoutReturn()` in `index.html` watches for `checkout=success` and
polls until the webhook lands, then opens the terminal. It waits about forty
seconds and never claims failure if the webhook is slow.

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

Then do a real one: sign up with an address you have never used, take the trial,
and watch a row appear in `public.subscriptions` with `last_event_id` set. Any
row where `last_event_id` is null was written by hand, not by Stripe.

## 7 · Repairing the five locked-out rows

Once deliveries are landing, let Stripe answer rather than guessing. For each
affected customer, Stripe → Customers → their subscription → **resend** the
current `customer.subscription.updated` (or make any no-op edit, which sends
one). The real status and period end land here and the row corrects itself.

If Stripe has no subscription for one of them, they were never a customer and
the row should be deleted. That is a decision about money, so a human makes it —
`stripe_webhook.sql` deliberately does not touch those rows.

---

## What it guarantees

**It does not trust the caller.** The endpoint is public and grants a paid
product. Every request is checked against `STRIPE_WEBHOOK_SECRET` with
HMAC-SHA256 over Stripe's exact signed payload, compared in constant time,
inside a five-minute window. A forged body, a wrong secret, a real signature
over an edited body, and an hour-old replay are each refused — and the response
never says which, because telling a forger why they failed is free help.

**A retry is not a second write.** Events are keyed on Stripe's own id.

**An old delivery cannot resurrect a cancelled subscription.** Every row records
the Stripe timestamp last applied, and an older event is stored and ignored.

**An unknown customer is not an error.** It is answered `200`, kept unresolved,
and reconciled by the next event that names them. Look at
`public.stripe_events_unresolved`; empty is healthy, anything in it is money the
product cannot see.

**It never invents a user.** Identification is `client_reference_id`, then a
known customer mapping, then an exact email match **on a confirmed account
only**. An unconfirmed address proves nothing — anyone can sign up as somebody
else's email — and matching one would hand over their subscription.

**A lost payment is louder than a failed one.** A missing service role or a
failed `subscriptions` write answers `500` so Stripe retries; only genuinely
handled outcomes answer `200`.

Held by `tools/billing/stripe_webhook.test.js` (46 assertions, run against the
deployed file itself with no second copy to drift) and by the SQL half of
`tools/app/billing_sql.test.js` against a real PostgreSQL.
