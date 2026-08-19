# L. Economics and Payout Specification

Purpose: the complete money design at the decided Section 5 numbers, exactly as implemented in `collective.config`, the commerce tables (migration 6), and the earnings surfaces. Pricing is decided and this document does not reopen it. Everything here ships in this build with billing inert behind `billing.enabled=false` (rule 8.13): attribution and ledger structures are live from day one, money flow turns on later with a config flip and Stripe wiring.

---

## 1. Retail price, fixed everywhere

**$20 per month, or $200 per year.** One price across the whole ecosystem. No creator sets a different standalone price for Collective access, in either mode. A single anchor price is what stops the members from undercutting each other into nothing. Stored as `pricing.monthly_cents = 2000` and `pricing.annual_cents = 20000`, surfaced through `/v1/meta` so every page and embed quotes the same number from the same row.

## 2. Mode A, referral (the default)

The Collective bills the end user $20 directly. The referring creator earns **40 percent recurring, $8 per subscriber per month**, for as long as that subscriber stays. The Collective keeps $12. Zero billing setup, zero support burden, zero payout plumbing on the creator's side; the Collective owns the customer relationship, the churn data, and the retention.

Every creator lands in Mode A by default (`creators.billing_mode` default `'referral'`). The rate is **stored per creator** as `creators.referral_share_bps` (default 4000 from `share.referral_bps_default`), never derived from a tier check at earn time.

**Founding member terms.** The first 10 creators (`share.founding_seats = 10`) get **50 percent, $10 per subscriber per month, locked for the life of their membership.** Implemented as `referral_share_bps = 5000` written onto the creator row at invite redemption when the invite carries the founding flag. Because the money number travels on the creator record, the rate survives any later change to the defaults: no code knows about "founding" at earning time, it only reads the row's bps. `founding_member` is a separate display flag for the badge. At current scale founding terms cost a few hundred dollars a month and are the reason the first ten actually post the link.

## 3. Mode B, wholesale

The creator bills their own audience and pays the Collective **$14 per seat per month** (`wholesale.seat_cents = 1400`), **minimum 10 seats** (`wholesale.min_seats = 10`, also a CHECK on `wholesale_seats.seat_count`), billed monthly on actual reported seat count (`collective.wholesale_seats`, unique per creator per month).

Hard condition, the price floor: a Mode B creator may not sell Collective access standalone below **$20** (`wholesale.floor_cents = 2000`). Below the floor, bundle only: they may fold Collective access into a higher-priced plan with no separate line item, but a standalone Collective SKU under $20 is a terms violation. The floor is not negotiable.

## 4. Why the two numbers work together

Reproducing the decided argument faithfully, because it is load-bearing for every future pricing conversation:

At a $20 retail price, Mode A pays the creator $8 per subscriber and Mode B nets them $6 ($20 collected minus $14 wholesale). Mode A is strictly better for the creator unless they retail above $22, which means Mode B is only attractive to someone bundling Collective access into an already-premium product. That is exactly the creator who should be in Mode B, because they already have billing, support, and a customer relationship worth protecting. Everyone else lands in Mode A by default, which is where the Collective wants them. The Collective keeps $12 under Mode A and $14 under Mode B, close enough that there is no incentive to push a creator into the mode that is worse for them.

## 5. Attribution rules

- **First touch.** The first recorded touch for a visitor wins: embed impressions and any Collective link carrying `?ref={slug}` write append-only rows to `attribution_touches` via `record_touch`. Capture runs from day one, billing on or off, because retrofitting attribution is impossible (rule 8.13).
- **Locks at conversion.** When a subscription clears, `lock_attribution` finds the earliest touch for that visitor and writes one row to `attributions`, unique per subscriber user id and per email hash.
- **Never moves.** `attributions` is append-only with no update path. Two creators cannot claim the same subscriber.
- **Survives browsing other tabs.** Later visits through a different member's embed add touches but the lock predates them and the earliest-touch rule ignores them. The subscriber can live inside a rival's tab forever; the referrer keeps the share.

## 6. Payout mechanics

- **Monthly, net 30.** Earnings post to `earnings_ledger` per paid invoice at the creator's `referral_share_bps`, keyed to `period_month`; `available_at = period close + payout.net_days` (30).
- **$50 minimum, rolls forward.** Balances under `payout.min_cents` (5000) are not paid; they carry to the next cycle with no expiry.
- **Stripe Connect, requested only after first successful submission.** `payout_accounts` starts `'unstarted'` and the Connect onboarding ask is triggered by the first successful live submission, never at signup. Asking a stranger for banking information before they have seen the product working is how you lose them.
- **60 day clawback.** Refunds and chargebacks within `payout.clawback_days` (60) post negative `clawback` ledger entries against the creator who earned the share.
- **Annual subscriptions** pay the creator share on the **full amount at the time it clears** ($80 at 40 percent, $100 founding, on the $200 payment), subject to the same clawback window.

Ledger discipline: `earnings_ledger` is append-only; balance is the sum of `earning`, `clawback`, `payout`, and `adjustment` entries. Payouts post as negative entries referencing the Stripe transfer. Every number a creator sees is reproducible by summing their rows.

## 7. Never pay on accuracy

**Do not pay creators based on model accuracy. Ever.** The moment income depends on record, the rational move is to submit only the slates you feel good about, and the historical record, which is the entire product, becomes garbage. Coverage gating (rule 8.7) defends the rankings against cherry-picking; keeping money fully decoupled from record removes the motive at the source. Pay on referral and on engagement with a creator's profile. Reward bringing an audience, never being right. Structurally: nothing in `earnings_ledger` references `grades`, `model_records`, or any performance view, and no future entry type may.

## 8. Config keys

All money numbers live in `collective.config` and only there. Changing one is an UPDATE on one row, not a deploy.

| Key | Value | Meaning |
|---|---|---|
| `pricing.monthly_cents` | 2000 | Retail monthly price |
| `pricing.annual_cents` | 20000 | Retail annual price |
| `share.referral_bps_default` | 4000 | Mode A default share (40 percent, $8) |
| `share.founding_bps` | 5000 | Founding share written to the creator row (50 percent, $10) |
| `share.founding_seats` | 10 | Founding seat count |
| `wholesale.seat_cents` | 1400 | Mode B per seat per month |
| `wholesale.min_seats` | 10 | Mode B minimum seats |
| `wholesale.floor_cents` | 2000 | Standalone price floor for Mode B |
| `payout.min_cents` | 5000 | Payout minimum, rolls forward below |
| `payout.net_days` | 30 | Net 30 after month close |
| `payout.clawback_days` | 60 | Refund and chargeback clawback window |
| `billing.enabled` | false | Master switch; everything upstream records regardless |

Per-creator overrides live on the creator row (`referral_share_bps`, `billing_mode`), so special terms travel with the creator and need no code.

## 9. Creator earnings dashboard

`GET /v1/dashboard` (creator JWT) returns the earnings block, rendered on the Collective site dashboard. If a creator cannot see what the Collective earned them this month, they will assume it is nothing. Fields:

- `this_month_cents`: earnings posted for the current period month.
- `balance_cents`: lifetime ledger sum.
- `available_cents`: sum of entries past `available_at`, the payable amount.
- `referred_active`: attributed subscribers currently active.
- `referred_total`: attributed subscribers ever, so retention is visible.
- `note`: while billing is off, exactly: `Billing is not live yet. Attribution is being recorded now and pays out when billing turns on.`

Backing view: `creator_earnings_monthly` (earned, clawed back, paid, balance, available per month), also surfaced to the founder via `GET /v1/admin/earnings`.

## 10. Scale arithmetic, honestly

So nobody builds a fantasy: six creators with roughly 5,000 combined reachable audience at 3 percent conversion is about 150 subscribers. At $20 that is about **$3,000 gross monthly**, and after founding-member share the Collective keeps around $1,500. Real, not transformative. The lever is member count and audience quality, not price. Every mechanism in this document (config-driven rates, per-creator bps, ledger-summed balances, derived dashboards) is O(members) with no per-member code or manual step, because the system is designed for **60 creators, not 6**.
