# Launch stress test — before you send a partner audience at this

Written for the scenario that actually matters: **2,000 see it, 300 click, 100 create
accounts, 30+ pay.** Everything below is either done in this repo, or is a thing only
you can do (Stripe dashboard, database, bank account). The second list is the one that
will hurt you if you skip it.

---

## 1. The economics of the guarantee, stated plainly

The old guarantee was **a single coin flip on the entire cohort's revenue.**

One number — average CLV over 30 days — decided whether *every* subscriber got
refunded. Every customer's refund was perfectly correlated with every other's. That is
the worst possible structure for a correlated-arrival cohort: 100 subscribers from one
partner all land inside ~72 hours, so they all share a window, so they all pass or all
fail together. $7,999 on one draw of a noisy statistic.

Worse, it had **no minimum sample.** If eight edges graded in someone's 30 days, eight
rows decided the fate of the month. `record.html` already argues, at length and
correctly, that a mean without a sample is not information — and then the guarantee
was written to be decided by exactly that.

### What changed

| | Before | Now |
|---|---|---|
| Sample floor | none | **30 graded edges**, or the window extends |
| Max extension | n/a | 90 days, then automatic refund |
| Window start | "your first 30 days" (ambiguous) | **30 days after your first payment** |
| Window basis | the all-time public record | **your own window**, by `graded_at` |
| "Flagged edge" | undefined on the page | `flagged_at not null AND flagged_edge ∈ [0.005, 0.1]` — the exact rule in `record.html` |
| Claim | email support and ask | **automatic**; support is the backstop |
| Repeatable | unbounded | one guaranteed month per customer |
| Verifiable pre-purchase | no | live panel runs the real query in the visitor's browser |

### Why the sample floor is the whole fix

With CLV standard deviation around 4 points, the probability the *measured* mean lands
below zero when the true edge is genuinely positive:

| true mean CLV | n = 8 | n = 30 | n = 100 |
|---|---|---|---|
| +1.5% | ~14% | **~2%** | ~0.01% |
| +0.5% | ~36% | ~25% | ~10% |
| 0.0% | 50% | 50% | 50% |

At n=30 with a real edge, expected refund cost is ~2% × cohort revenue — a couple of
hundred dollars against $8k. At n=8 it is over a thousand. **The floor converts the
guarantee from a coin flip into an insurance premium you can actually price.**

And if the true edge is ~0, the guarantee fires about half the time — correctly. That
is not a bug to engineer around. A product with no edge should refund.

### The 7-day trial changes this in your favour

The trial is the best risk control in the stack, and it is not primarily a conversion
device:

- Nobody is charged on day 0, so the cohort **self-selects before money moves.** People
  who were never going to stick cancel in the trial instead of becoming a refund.
- Refund exposure now applies only to people who used the product for a week and chose
  to pay. That is a much better-qualified pool.
- Worst case for a customer is 7 free days + a refunded month = **37 days free.** Say it
  out loud in the copy rather than hoping nobody works it out.

### Things you must do, that code cannot do for you

- [ ] **Configure the 7-day trial on the Stripe price behind `STRIPE_LINK`.** The page
      says "7 days free" in eleven places and in the consent record. If Stripe is not
      configured for a trial, **every one of those is false and the first charge lands
      immediately.** This is the single highest-severity item on this page.
- [ ] **Enable Stripe's trial-ending email** (Settings → Subscriptions → "Send trial
      ending notifications"). The consent text now promises "We will also email you
      before the trial converts." Several states require that notice for trial-to-paid.
- [ ] **Set the payment link's success URL to `https://edgedesksports.com/?checkout=success`.**
      Otherwise paying customers land on a marketing page that still says "Start free
      trial" — see §4.
- [ ] **Hold the first-month revenue from a referred cohort for 45 days.** Do not spend
      it. The whole cohort's guarantee resolves at roughly the same moment.
- [ ] **Budget for non-recoverable Stripe fees.** Stripe does not return processing fees
      on refunds. A full 100-customer refund costs ~$262 *on top of* returning $7,999.
- [ ] **Agree partner commission on NET revenue, in writing, before launch.** If you pay
      25% on a month you later refund, you lose the refund *and* the commission.
      `partner_rollup` reports refunded months separately for exactly this reason.

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

The first version of this got it backwards — any first visit, including an organic one,
locked the record. The consequence: someone who browsed the homepage once in March,
clicked the partner's link in June, and subscribed would be credited to *nobody*. The
partner sends a paying customer and the ledger says "direct." Caught in browser testing;
the organic record is now an upgradeable placeholder.

Once a code is credited it is **frozen** — in the browser and again by a database
trigger. A later, different code cannot take the customer. That half of the rule
protects the partner from you, which is the half that makes the deal signable.

Attribution survives: localStorage cleared (cookie mirror), navigating to `/record.html`
and back (click-time link decoration), and campaign params on `/golf` (carried through
the hop). All verified in a real browser.

**Run `sql/referrals.sql` before you send traffic.** There is no backfill for "which
link did this person click in March."

---

## 3. The golf bridge

Hidden by default. Cold traffic sees the page exactly as it was — it still reads as a
sports-betting research terminal for people who arrived wanting one. The bridge appears
only for `?ref=` codes registered as golf, or `?aud=golf`.

It does three things in order: connects strokes gained to de-vigged fair value (same
move — measure against what the field produces, not against the outcome), connects a
season of differentials to a graded CLV sample, and then **shows the golf leaderboard
that already exists in the product.** That last one matters most: it is the difference
between "this could apply to you" and "this already covers your sport."

---

## 4. Payment → app access

**This was the biggest hole, and it had nothing to do with the guarantee.**

Stripe redirects a paying customer back to the site. Nothing handled that. They landed
on a marketing page whose buttons still said "Sign up" while the webhook was in flight.
At 100 customers, that single gap is most of your support inbox — and it reads as "I
paid and got nothing," which is the worst possible first impression.

Now: a returning customer gets an interstitial, the page polls their subscription for up
to 40 seconds, and forwards them into the terminal the moment it activates. If polling
runs out it says activation is *catching up* — never that the payment failed, because
the webhook can land after we stop looking, and telling a paying customer their payment
didn't work is worse than telling them to wait. Both paths tested in a browser.

`trialing` already counted as active in `edSubState()`, so trial users get in with no
charge. Verified.

---

## 5. Support volume

The four things that will actually generate email at 100 customers, each now answerable
without you:

| Driver | Self-serve path |
|---|---|
| Confirmation email never arrived | resend link, in the signup modal |
| Paid but locked out | "Re-check my subscription now" — reads live billing state |
| Wants to cancel before being charged | Settings › Subscription, stated on the page |
| Thinks the guarantee failed | live panel + public record, both no-login |

The guarantee being **automatic** is the largest single reduction here. A guarantee you
have to claim generates one email per customer who thinks they might be owed. A
guarantee that pays itself generates none — and it is a stronger promise, which is a
rare case of the cheaper option also being the better one.

---

## 6. Still on you

- [ ] Stripe: 7-day trial on the price; trial-ending emails on; success URL set.
- [ ] Run `sql/referrals.sql`.
- [ ] Schedule `guarantee_sweep()` daily; watch `guarantee_refunds_due` every morning.
- [ ] Write `guarantee_windows` rows on first charge (trial conversion) in the webhook.
      **Not on trial start** — the guarantee refunds a charge, so it cannot begin before
      one exists.
- [ ] Test one real end-to-end purchase with a real card before the partner sends anyone.
- [ ] Decide the refund actor: `guarantee_sweep()` marks `failed`, a separate worker
      issues the Stripe refund and sets `refunded`. Two steps on purpose — a bug in one
      cannot silently double-refund through the other.
- [ ] Confirm cancellation genuinely works inside the app (`app.html`), end to end, with
      a real subscription. The page now promises one-click cancellation in writing.
