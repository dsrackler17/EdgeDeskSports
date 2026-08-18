# Launch stress test — before you send a partner audience at this

Written for the scenario that actually matters: **2,000 see it, 300 click, 100 create
accounts, 30+ pay.** Everything below is either done in this repo, or is a thing only
you can do (Stripe dashboard, database, bank account). The second list is the one that
will hurt you if you skip it.

---

## 1. The offer: a 7-day free trial, and nothing else

The 30-day CLV guarantee is **gone.** It was a conditional refund promise sitting on top
of a statistic noisy enough that a genuinely good product could still fail it, and every
subscriber in a cohort shared one window — so the whole cohort passed or failed together.
That is a correlated liability on your entire first month of revenue, in exchange for a
conversion argument the trial already makes better.

**The trial is the stronger risk reversal anyway,** for a reason that has nothing to do
with the math: a guarantee asks someone to trust a promise about the future, and a trial
just hands them the product. The objection it answers — "what if this isn't worth $80" —
is answered by a week of using it, not by a refund clause they have to read twice.

What it does for your economics:

- **Nothing is charged on day 0.** The cohort self-selects before money moves. People who
  were never going to stick cancel in the trial rather than becoming a refund, a
  chargeback, or a support thread.
- **Refund exposure is close to zero.** Fees already charged are non-refundable, stated
  plainly. There is no formula anyone can dispute, no window to argue about, and no
  scenario where one number triggers a hundred simultaneous refunds.
- **Everyone who converts used it for a week first.** That is a far better-qualified
  paying pool than a cohort that bought on a promise.

**Anyone who consented under the old terms is still owed the guarantee.** Consent
versions `arl-2026-08-v3/v4/v5` promised it. `billing_consents` stores the exact text
each customer agreed to, so honour it for those rows and only those rows. The current
version is `arl-2026-08-v6-trial7`.

### Things you must do, that code cannot do for you

- [ ] **Configure the 7-day trial on the Stripe price behind `STRIPE_LINK`.** The page
      says "7 days free" in a dozen places and in the consent record. If Stripe is not
      configured for a trial, **every one of those is false and the first charge lands
      immediately.** This is the single highest-severity item here.
- [ ] **Enable Stripe's trial-ending email** (Settings → Subscriptions → "Send trial
      ending notifications"). The consent text promises "We will also email you before
      the trial converts," and several states require that notice for trial-to-paid.
      This is a written promise; make it true.
- [ ] **Set the payment link's success URL to `https://edgedesksports.com/?checkout=success`.**
      Otherwise customers land on a marketing page that still says "Start free trial" —
      see §4.
- [ ] **Confirm one-click cancellation actually works in `app.html`,** end to end, on a
      real subscription. The page now promises it in writing, twice.
- [ ] **Expect the day-8 conversion cliff.** Your entire partner cohort converts within
      roughly the same 24 hours. Be at a keyboard that day — it is the one moment where
      a billing bug hits everyone simultaneously.
- [ ] **Watch for trial abuse.** One trial per customer; a burst of signups on
      throwaway addresses from one referral code is worth a look before you pay
      commission on it.

---

## 2. Referral attribution

**Was:** nothing. There was no way to tell a partner-sourced customer from any other.
Six months in, this would have been two people and two spreadsheets.

**Now:** three durable copies, all keyed on the Supabase user UUID — which is the same
id Stripe returns on `checkout.session.completed`, so partner link → visit → account →
payment joins in one query with no human judgement anywhere in it.

| Copy | Written | Survives |
|---|---|---|
| `auth.users.user_metadata` | at account creation | every schema change |
| `referrals` row | at signup, re-tried at consent | convenient bulk queries |
| `billing_consents` row | at billing consent | tied to the exact offer accepted |

**Entry points:** `edgedesksports.com/?ref=golfplatform` or the short
`edgedesksports.com/golf`. Unknown codes still attribute and still pay — an unrecognised
code only means the visitor sees the normal page instead of the golf treatment, so a
typo costs you a bridge section, not a commission.

### The credit rule, and the bug that was in the first draft

**Credit belongs to the first touch that carried a referral code.** Organic visits are
recorded but never claim the customer.

The first version got it backwards — any first visit, including an organic one, locked
the record. The consequence: someone who browsed the homepage in March, clicked the
partner's link in June, and subscribed would be credited to *nobody*. The partner sends
a paying customer and the ledger says "direct." Caught in browser testing; the organic
record is now an upgradeable placeholder.

Once a code is credited it is **frozen** — in the browser and again by a database
trigger. A later, different code cannot take the customer. That half of the rule
protects the partner from you, which is the half that makes the deal signable.

Attribution survives: localStorage cleared (cookie mirror), navigating to `/record.html`
and back (click-time link decoration), and campaign params on `/golf` (carried through
the hop). All verified in a real browser.

**Run `sql/referrals.sql` before you send traffic.** There is no backfill for "which
link did this person click in March."

### Paying the partner

`partner_rollup` reports `signups`, `in_trial`, `active_paid`, `churned` and
`never_started` separately, because **a trial is not revenue.** Agree in writing, before
launch, that commission is 25% of *net* revenue — after refunds, chargebacks and failed
renewals — and that it accrues on conversion, not on signup. With a 7-day trial, a
partner counting signups and you counting payments will disagree by the entire trial
population in week one. That argument is avoidable today and expensive later.

---

## 3. The golf bridge

Hidden by default. Cold traffic sees the page exactly as it was — it still reads as a
sports-betting research terminal for people who arrived wanting one. The bridge appears
only for `?ref=` codes registered as golf, or `?aud=golf`.

It does three things in order: an above-the-fold hook so the first line a golfer reads
is about them, a crosswalk from strokes gained to de-vigged fair value (same move —
measure against what the field produces, not against the outcome), and then **the golf
leaderboard that already exists in the product.** That last one matters most: it is the
difference between "this could apply to you" and "this already covers your sport."

---

## 4. Payment → app access

**This was the biggest hole, and it had nothing to do with the offer.**

Stripe redirects a converting customer back to the site. Nothing handled that. They
landed on a marketing page whose buttons still said "Start free trial" while the webhook
was in flight. At 100 customers, that single gap is most of your support inbox — and it
reads as "I paid and got nothing," which is the worst possible first impression.

Now: a returning customer gets an interstitial, the page polls their subscription for up
to 40 seconds, and forwards them into the terminal the moment it activates. If polling
runs out it says activation is *catching up* — never that the payment failed, because
the webhook can land after we stop looking, and telling a paying customer their payment
didn't work is worse than telling them to wait. Both paths tested in a browser.

`trialing` already counted as active in `edSubState()`, so trial users get straight in
with no charge. Verified.

---

## 5. Support volume

The four things that will actually generate email at 100 customers, each now answerable
without you:

| Driver | Self-serve path |
|---|---|
| Confirmation email never arrived | resend link, in the signup modal |
| Started the trial but locked out | "Re-check my subscription now" — reads live billing state |
| Wants to cancel before being charged | Settings › Subscription, stated on the page twice |
| Wants proof before trusting it | the public record, no account, no paywall |

The largest single reduction is the trial itself. A refund promise generates one email
per customer who thinks they might be owed something; a trial generates none, because
the person who didn't like it already cancelled and never wrote to you.

---

## 6. Still on you

- [ ] Stripe: 7-day trial on the price; trial-ending emails on; success URL set.
- [ ] Run `sql/referrals.sql`.
- [ ] Honour the old CLV guarantee for anyone on consent version v3–v5.
- [ ] Test one real end-to-end trial → conversion with a real card before the partner
      sends anyone. Do not let the first real charge in production be a customer's.
- [ ] Be online for the day-8 conversion cliff.
- [ ] Confirm cancellation genuinely works inside `app.html`, end to end.
