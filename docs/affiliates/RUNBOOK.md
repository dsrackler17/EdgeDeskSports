# Creator referral codes — runbook

The partner program (`supabase/affiliates.sql`) credits a creator with the
customers who subscribe through their code and books a commission on every
payment those customers make. Connor is the first creator
(`supabase/affiliate_connor.sql`).

## The deal

| | |
|---|---|
| **Customer** | 10% off the first 3 paid months of the $49.99/month plan (Stripe coupon "Connor 10% x 3", promotion code `CONNOR10`, first-time customers only). The 7-day free trial is unchanged. |
| **Connor** | 20% of every payment those customers make — amount paid **less tax**, rounded to the cent — for **12 months** from their first paid invoice. Refunds and disputes are netted. |
| **Payout** | A month's collections are paid by the **15th of the second following month** (October's by December 15). |

So a Connor customer pays $0 (trial), then $44.99 three times, then $49.99, and
Connor earns $0, $9.00, $9.00, $9.00, $10.00, … for 12 paid invoices.

## Where each piece lives

| Piece | File |
|---|---|
| Keeping the visitor's code: last valid `?ref=` clicked, 30 days | `lib/edgedesk_ref.js` (loaded by `index.html`; by `lib/edgedesk_public.js` on other pages when the URL has `?ref=`) |
| Applying it at checkout (monthly price only) | `supabase/functions/create_checkout_session/index.ts` |
| Attribution, commissions, refunds, disputes, statement | `supabase/affiliates.sql` (a trigger on the webhook's `stripe_events` ledger — the webhook itself is unchanged) |
| Connor | `supabase/affiliate_connor.sql` |
| The code label on sales | `supabase/referral_codes.sql` (CONNOR10 in, BETDESK retired) |
| Deploying the SQL | `.github/workflows/deploy-affiliates.yml` |
| Tests | `tools/personal/affiliate_connor_sql.test.js`, `tools/billing/affiliate_flow.test.js`, `tools/billing/checkout_ref.test.js`, `tools/personal/affiliates_sql.test.js` |
| Real Stripe test clock | `tools/billing/affiliate_test_clock.js` |

There is no `affiliates` *table*: `public.affiliates` is a service-role-only
**view** over `affiliate_accounts` + `affiliate_campaigns` with the columns
id, slug, display_name, stripe_promotion_code_id, promo_code, commission_rate,
earning_months, active, created_at (plus the test-mode promotion code id).

## Turning it on

1. **The SQL.** Run *Deploy partner program (affiliates)* with `dry_run`,
   read the report, then `apply`. It applies `referral_codes.sql`,
   `affiliates.sql` and `affiliate_connor.sql` in that order, one transaction
   each, and fails on any `CHECK THIS` row. (Or paste the three files into the
   SQL editor in that order.)
2. **Edge Function secrets** (Supabase → Edge Functions → Secrets):
   - `MONTHLY_PRICE_ID` = the live `price_…` of the $49.99/month price.
     Creators' codes are applied **only** when `STRIPE_PRICE_ID` is this price;
     unset, no code is ever applied.
   - `CONNOR_PROMO_CODE_ID` = the live `promo_…` id of `CONNOR10`. Each creator
     has one: `<SLUG>_PROMO_CODE_ID`.

   No Stripe id is in any file. The first time the checkout applies Connor's
   code it writes the id onto his campaign (`stripe_promotion_code_id`, or
   `stripe_test_promotion_code_id` for a test key), write-once — a later,
   different id is refused and logged as `promotion_code_conflict`.
3. **Deploy `create_checkout_session`** (*Deploy billing*, stage
   `deploy_create_checkout_session`). Its build marker is
   `create_checkout_session-2026-10-16-affiliate-1`.
4. **Stripe webhook endpoint events** — commissions are booked from invoice
   events, so the endpoint must send **`invoice.paid`** (and/or
   `invoice.payment_succeeded`), plus `charge.refunded` and
   `charge.dispute.created` (live, and the test-mode endpoint if you use one).
   **As of 2026-10-16 production's ledger had received no invoice event at
   all** (7 `checkout.session.completed`, 10 `customer.subscription.created`,
   0 `invoice.*`): until they are added, no commission can be booked.
   Optional: `promotion_code.updated` and `coupon.updated`, so the landing page
   can show Stripe's own discount line for the code.

Until step 3, a `CONNOR10` typed on Stripe's checkout page is still credited
to Connor (by the code the webhook names), but nothing applies the discount
for a visitor who arrived on his link.

## How a customer is credited

At checkout (`create_checkout_session`), a code is applied only if **all** hold:
the price is `MONTHLY_PRICE_ID`; the code is a campaign in force; the account
is not the creator's own and has **never paid an invoice**; and the env's
promotion code is, in Stripe, active and that same code. Then the session gets
`discounts: [{promotion_code}]` and `metadata.affiliate = connor` (on the
session and the subscription) — never together with `allow_promotion_codes`.
Otherwise the session is the plain one, with `allow_promotion_codes: true`.
If Stripe still refuses the discount (its first-time-customer rule), the
checkout is made again without it rather than failed.

From the webhook's ledger, an account with no attribution yet is credited by,
in order: the promotion-code id on the session/subscription/invoice (matched
against the campaign's live or test id), then `metadata.affiliate`, then the
code the webhook named on `subscriptions.referral_code`. The first attribution
wins and is never overwritten; an account with an earlier paid invoice (on
another subscription) is never credited. Connor is `checkout_only`: a link
click is counted (`affiliate_clicks`) but never credits on its own.

## Commissions

- One row per paid invoice (`affiliate_commissions`, `kind = 'accrual'`),
  unique per Stripe invoice, so a webhook retry or the twin event type
  (`invoice.paid` / `invoice.payment_succeeded`) can never book twice.
- `basis_cents` = amount paid − tax; `amount_cents` = round(basis × 0.20).
  $0 invoices (the trial) earn nothing.
- The 12 months are counted in billing periods from the first paid invoice's:
  invoices 1–12 earn, invoice 13 does not.
- Dates are Stripe's: `invoice_paid_at` is the invoice's `status_transitions.paid_at`.
- A refund or a dispute books a negative row (`kind = 'clawback'`) on the same
  invoice: the commission × refunded ÷ charged (or disputed ÷ paid), and never,
  across all of them, more than that invoice's commission. Nothing is voided.
- Statuses (pending → approved → paid with a payout reference) are the
  program's existing workflow in `/admin/affiliates/`.
- Test-mode rows are flagged `livemode = false` and left out of statements.

## The monthly statement

```sql
select * from public.affiliate_statement('connor', date '2026-11-01');
```

One row per commission booked that month (UTC): `payment` rows (date, eligible
amount, rate, commission) and `adjustment` rows (refunds/disputes, negative,
with the date of the payment they came back from), then a `total` row. The
customer is only the last 4 characters of their Stripe customer id.
`payout_due` is the 15th of the second following month. Service role only (the
SQL editor, or a service-role call); `affiliate_statement('connor', …, false)`
shows only test-mode rows.

## Testing

Locally (each starts its own throwaway PostgreSQL):

```
node tools/personal/affiliate_connor_sql.test.js   # the deal on a simulated test clock
node tools/billing/affiliate_flow.test.js          # through the real checkout + webhook
node tools/billing/checkout_ref.test.js            # the 30-day, last-click code keeper
```

Against **real Stripe, test mode**, on a test clock (it refuses a live key and
deletes the clock afterwards):

```
STRIPE_SECRET_KEY_TEST=sk_test_… MONTHLY_PRICE_ID=price_… CONNOR_PROMO_CODE_ID=promo_… \
  node tools/billing/affiliate_test_clock.js [--user <uuid of a throwaway account>] [--keep]
```

It prints every invoice and says how many paid invoices Stripe discounted. If
it reports only 2 (the trial used up coupon time), change the coupon to
repeating for 4 months.

## The next creator

Add a seed like `affiliate_connor.sql` (an account with a `slug`, a campaign
with the code and terms), create the coupon and promotion code in Stripe
(metadata `affiliate=<slug>`), set `<SLUG>_PROMO_CODE_ID`. No code change.

## Deploy log

- 2026-10-16 — program built (PR dsrackler17/EdgeDeskSports#601).
- 2026-10-16 — production dry run through `deploy-affiliates.yml`
  (`[affiliates:dry-run]` from `claude/sweet-meitner-8d7ewv`): applied in one
  transaction and rolled back; every report row ok. The program was already
  installed (an earlier `affiliates.sql`) with no campaigns, attributions,
  commissions or clicks; `referral_codes` held BETDESK only.
- Apply: pending (owner's go-ahead).
