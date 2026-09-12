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
3. `supabase/referral_codes.sql` — the discount codes, the attribution columns
   on `subscriptions` and the report. Rows 1–13 should say `ok`. It refuses to
   install before the other two, by name.

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
| `STRIPE_SECRET_KEY` | `sk_live_…` — read-only use: after a checkout the function asks Stripe for the subscription's real status, and turns a `promo_…` id into the code the customer typed |

Two more exist **only while a dry run is running** (§9). Unset is the normal
state and the live path is identical without them:

| Name | Value |
|---|---|
| `STRIPE_WEBHOOK_SECRET_TEST` | `whsec_…` from a **test-mode** endpoint pointed at the same URL |
| `STRIPE_SECRET_KEY_TEST` | `sk_test_…` — a test id looked up with a live key is a 404, which reads exactly like a code that does not exist |

`STRIPE_SECRET_KEY` is not optional in practice. A `checkout.session.completed`
carries no status, and this function refuses to invent one — so without the key
a paying customer is written in with `status = null`, which `pgEntitled()` reads
as not entitled. They pay and are locked out by the very row recording it. That
happened on the first real checkout this webhook received.

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

Then check no live customer is stranded:

```sql
select user_id, status, current_period_end, last_event_id
from public.subscriptions where status is null;
```

Any row there is somebody who reached checkout and cannot get in. It means
`STRIPE_SECRET_KEY` was missing when their checkout arrived. Set it, then make
any no-op edit to their subscription in Stripe — that fires a **fresh**
`customer.subscription.updated` and the row corrects itself.

**Do not "resend" the original event to fix this.** A resend keeps the event's
original timestamp, and the ordering guard will correctly refuse it as older
than what the row already reflects. A new edit makes a new event with a new
timestamp; that is the one that lands.

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

## 8 · The discount code, and who came in through it

### Percent off, not a free extra week

Checkout here is a **Stripe Payment Link**, and the 7-day trial lives on the
price behind it — `TRIAL_DAYS` in `index.html` only *displays* it. A Stripe
coupon takes a percentage or an amount off an invoice; **it cannot extend a
trial.** Trial length is fixed when the subscription is created, which for a
payment link means a *second* link on a *second* price: two URLs to keep in
step, two prices to keep at $79.99, and an automatic-renewal consent record
whose `trial_days` is wrong for whichever link the customer did not take.

A percent-off coupon needs none of that. One link, one price, one consent text,
and the code is typed on Stripe's own checkout page.

**The one compliance note.** `billing_consents` stores `price_display =
"$79.99"` — the figure shown before the customer left for Stripe. Somebody who
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
{"build":"stripe_webhook-2026-09-12-referral-1","error":"POST only"}
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

**A code is never invented and never moved.** A coupon with no promotion code
behind it names no partner. The first attribution wins, enforced in the filter
of the write rather than by a read before it. And recording it can never fail
the delivery that carries the money.

Held by `tools/billing/stripe_webhook.test.js` (100 assertions, run against the
deployed file itself with no second copy to drift), by
`tools/billing/comp_entitlement.test.js`, and by
`tools/app/billing_sql.test.js` against a real PostgreSQL — which applies
`billing.sql`, `stripe_webhook.sql` and `referral_codes.sql`, then attacks the
report with `tools/app/sql/referral_codes.test.sql`: a subscription dropped off
it, a sale credited to the wrong code, an invoice counted twice, revenue that
arrived and is on no line. It also lifts the shipped `community_is_entitled()`
out of `community_posts.sql` and checks the report and the paywall still agree
about who has access, rather than writing a fourth copy of that rule.
