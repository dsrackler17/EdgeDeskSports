# Juice Reel billing — EdgeDesk bought through Juice Reel

**Status (2026-10-28): built, and tested here against a fake Juice Reel. Not deployed. Not yet run against Juice Reel.**

- A reader pays for EdgeDesk on Juice Reel's hosted checkout, and the EdgeDesk account they are signed in to opens. Juice Reel takes the payment and bills, renews and cancels it.
- A reader who bought EdgeDesk on Juice Reel's marketplace links their Juice Reel account from EdgeDesk, and their account opens.
- The landing page shows the partnership with Juice Reel. Its "Subscribe with Juice Reel" button appears only once the switch below is **on**.
- **Off by default.** Nothing changes for any reader until `JUICE_REEL_CHECKOUT` is set (§ 2). Stripe billing is unchanged, and the card trial stays offered.
- **The fake is not Juice Reel.** The checkout, token, `/oauth2/me` and webhook signature follow Juice Reel's docs and its official example server. The shapes of the subscriber-status answer, the subscriber list and the webhook body are not confirmed (§ 9). Nothing here may be called working in production until the live test (§ 3) has passed.

This is separate from the Juice Reel **bet sync** in Portfolio ([docs/juicereel.md](juicereel.md)). That integration reads a reader's bets. This one sells EdgeDesk. They share the OAuth application and its client id and secret, and nothing else.

---

## 1. Set up at Juice Reel (Settings → OAuth applications)

**Which application (what the account's settings showed on 2026-10-28).** Juice Reel's settings page says these integrations are for giving a seller's Juice Passholders "additional value outside of what Juice Reel provides", so that "their subscription also gives them access". That is exactly this build. The account has two applications:

| Application | Client id | Sign in With Juice Reel | Use for this |
|---|---|---|---|
| EdgeDeskSports | `jr_AFk36va1…` | **off**: owner-only. It cannot run the checkout, whose last step is the buyer's consent, and this cannot be changed after creation | no; disable it once the other passes `check` |
| **EdgeDesk Sports Integration** | `jr_UcOwwS-Ep-nxQu7WeaStFHXfelzzjVrK` | **on** | **yes** |

On **EdgeDesk Sports Integration**, as found:
- **Its only registered redirect URI** is `https://iattxbkbufslbauoumga.supabase.co/functions/v1/juicereel-callback`. Nothing in this repository serves that address. Add the two URIs in step 1 below.
- **Its approved scopes** are `subscribers.read` and `bets.open.read`. Billing needs only the first. `bets.settled.read` is **not** approved, and the Portfolio bet sync asks for it ([juicereel.md](juicereel.md)).
- **Supabase's `JUICE_REEL_CLIENT_ID` must be this application's id**, and `JUICE_REEL_CLIENT_SECRET` its secret. Juice Reel shows a secret only once: if it was not kept, use **Rotate secret** and put the new one straight into Supabase.

The steps:


1. **Redirect URI.** Register exactly:

   ```
   https://edgedesksports.com/oauth/juicereel-subscribe.html
   ```

   It is the checkout's **success URL**, its **cancel URL**, and the **redirect URI** of an account link. One URI serves all three. Juice Reel compares it character for character: same scheme, host and path, no trailing slash. Add the bet sync's own URI too, `https://edgedesksports.com/oauth/juicereel-callback.html`.
2. **Scope.** Have `subscribers.read` approved. The checkout asks for it, and it is what lets EdgeDesk ask Juice Reel whether the buyer is subscribed.
3. **What is sold.** Create the EdgeDesk subscription product(s) on EdgeDesk's Juice Reel seller account (the plan, price and duration). EdgeDesk sends no product id: the buyer chooses on Juice Reel's checkout. To let only some of the seller's products open EdgeDesk, set `JUICE_REEL_PRODUCT_IDS` (§ 8). By default, every product this seller sells opens it.
4. **Webhook.** Subscribe the **SUBSCRIPTION_EVENTS** bucket (purchased, renewed, cancelled, expired) to:

   ```
   https://iattxbkbufslbauoumga.supabase.co/functions/v1/juicereel_billing/webhook
   ```

   Copy its signing secret into Supabase as `JUICE_REEL_WEBHOOK_SECRET` (§ 8).
5. **Ask Juice Reel to confirm** the four unconfirmed points in § 9.

## 2. Deploy and switch on — no terminal

1. **Merge this change.** GitHub Pages then serves the landing page, the terminal and `oauth/juicereel-subscribe.html`.
2. **Supabase → Edge Functions → Secrets:** add `JUICE_REEL_WEBHOOK_SECRET`. `JUICE_REEL_CLIENT_ID` and `JUICE_REEL_CLIENT_SECRET` are already set for the bet sync.
3. **Actions → Deploy Juice Reel billing → `deploy`** (type `deploy` into confirm). It runs both suites against a throwaway PostgreSQL, applies `supabase/juicereel_billing.sql` in one transaction, deploys `juicereel_billing`, and schedules the hourly reconcile. **The switch stays off.**
4. **`check`** (read-only). The run's summary shows:
   - which settings are missing;
   - whether Juice Reel accepts EdgeDesk's credentials;
   - whether owner access reaches the subscriber list;
   - the redirect URI and webhook URL to register.
5. **`set_mode` → `operators`.** Only billing operators see Juice Reel on the paywall. Run the live test (§ 3).
6. **`set_mode` → `on`.** Every reader's paywall offers Juice Reel first, and the landing page's partner band shows "Subscribe with Juice Reel". This is refused while a setting is missing.

**Rolling back:** `set_mode` → `off`. Nobody can start a Juice Reel checkout. Every reader who already paid keeps access to the expiry Juice Reel stated, and webhooks are still recorded.

## 3. The live test (an operator, with a real Juice Reel account)

With the switch on `operators`, signed in to EdgeDesk as a billing operator, on an account with no access:

| # | Do | Expect |
|---|---|---|
| 1 | Paywall → **Subscribe with Juice Reel** | Juice Reel's checkout opens |
| 2 | Pay, then allow access on Juice Reel's consent screen | Back on EdgeDesk: "Confirming your Juice Reel checkout…", then the terminal opens |
| 3 | Settings → Subscription | "Billed through Juice Reel", with the expiry Juice Reel shows |
| 4 | `billing_admin_juicereel_overview()` (as the operator) | `links` 1, `paid_now_linked` 1; `webhooks_24h` ≥ 1 once the purchase webhook landed |
| 5 | **Actions → Deploy Juice Reel billing → check** | credentials accepted; owner list `yes` (if `refused`, see § 9) |
| 6 | Cancel the subscription on Juice Reel | Settings: "Access ends <date>" (from the CANCELLED webhook); access continues until then |
| 7 | A second EdgeDesk account → **I bought EdgeDesk on Juice Reel** with the same Juice Reel account | Refused: "already opens a different EdgeDesk account" |

Then compare the Supabase function logs with § 9, and record what Juice Reel actually answered.

## 4. What readers see

| Where | Switch off | Switch on |
|---|---|---|
| **Landing page** (`#juicereel`, in Pricing) | "EdgeDesk × Juice Reel — EdgeDesk is working with Juice Reel" | The same, plus how it works and **Get EdgeDesk on Juice Reel** / **Bought on Juice Reel? Open EdgeDesk**. The card trial stays offered as before |
| **Paywall** | unchanged | First: what Juice Reel's checkout does, **Subscribe with Juice Reel** and **I bought EdgeDesk on Juice Reel — link my account**. Then "Or with a card:" and the card trial, unchanged |
| **Back from Juice Reel** | — | "Confirming your Juice Reel checkout…", then open. A cancelled checkout: "If you did pay on Juice Reel, do not pay again — link your account". Not yet confirmed: "Your payment is safe… Do not pay again", with a reference |
| **Settings → Subscription** (a Juice Reel row) | — | "Billed through Juice Reel", the paid-through date, **Manage on Juice Reel**, **Renewed? Re-check with Juice Reel**. No Stripe price, charge or portal |
| **Header and account menu** (a Juice Reel row) | — | **Back to Juice Reel ↗** in the account menu at every width, and a **↗ Juice Reel** chip in the header from 600 px. Both open juicereel.com in a new tab. Nobody else sees them |

Under `operators`, only operators see the paywall's Juice Reel buttons, and the landing page shows the partnership only.

The landing band is drawn by `lib/edgedesk_juicereel_billing.js` (`landing`), and styled in `lib/edgedesk_landing_desk.css`. `index.html` has a hard size budget (`tools/presentation/landing_interaction.test.js`), so it carries only a placeholder and three hooks. Its button does not say "Subscribe": the landing page keeps one call-to-action verb, "Start free trial" (`landing_positioning.test.js`).

## 5. How it works

```
reader ── start {checkout} ──▶ juicereel_billing: state (32 random bytes) + PKCE S256;
                               SHA-256(state) stored against THIS reader (48 h, single use)
juicereel_billing ── POST /checkout/sessions (Basic id:secret + X-OAuth-Client-Id;
                     {successUrl, cancelUrl, scopes:[subscribers.read], state, codeChallenge}) ──▶ checkoutUrl
reader ──▶ Juice Reel: picks the plan, pays, Juice Reel's consent screen
Juice Reel ──▶ /oauth/juicereel-subscribe.html?status=success&code&state   (or ?status=cancelled&state)
that page ── code + state → this tab's sessionStorage; address stripped ──▶ /app.html?jrsub=return
app ── complete {state, code} (the reader's token) ──▶ juicereel_billing:
       the state must be THIS reader's, unused, unexpired
       POST /oauth2/token (code, redirect_uri = the success URL, code_verifier)
       GET /oauth2/me → the buyer's Juice Reel id → link it to this reader (one to one)
       GET /oauth2/subscribers/status (the buyer's token) → subscribed? until when?
         (no answer: GET /oauth2/subscribers/current with owner access; still none: what a webhook said)
       → billing_jr_record_state → billing_jr_project → public.subscriptions
app ── my_billing_access ──▶ open

POST …/juicereel_billing/webhook  (X-Juice-Reel-Signature: sha256=HMAC(raw body))
       SUBSCRIPTION_PURCHASED / _RENEWED → paid until expiresDate
       SUBSCRIPTION_CANCELLED            → still paid until expiry, marked ending
       SUBSCRIPTION_EXPIRED              → ended
pg_cron hourly ──▶ reconcile: every page of /oauth2/subscribers/current (owner access)
```

- **start {link}** is the same without the purchase: Juice Reel's authorize page (`www.juicereel.com/oauth2/authorize`), then the same completion. It serves a reader who bought on Juice Reel's marketplace, or who paid and then declined the consent screen.
- **A purchase is recorded by Juice Reel user**, whether or not that buyer has linked yet (`billing_juicereel_subscribers`). When they link, it applies.
- **The function** is `supabase/functions/juicereel_billing/index.ts`. It has no imports, and it is deployed `--no-verify-jwt` because it verifies the reader itself.

## 6. The access rules (`supabase/juicereel_billing.sql`, `billing_jr_project`)

- **The row.** A Juice Reel purchase is the reader's `subscriptions` row with `price_id = 'juicereel'`, `status = 'active'` and `current_period_end` set to Juice Reel's expiry. It carries no Stripe ids.
  - The existing access rule grants it the Research Terminal until that date, and nothing after: `billing_row_grants_access`, unchanged; an unknown price is the terminal.
  - Every gate already reads that row: the paywall, `my_billing_access`, and every RLS gate. Nothing in `billing_hardening.sql` changes.
- **Never open-ended.** A Juice Reel row always has an expiry. If Juice Reel says "subscribed" without a date, access runs 3 days, and each later confirmation renews it. That horizon never shortens a date Juice Reel did state.
- **Juice Reel only revokes what Juice Reel granted.**
  - It never writes over `owner_comp`.
  - It never writes over a Stripe-backed row in good standing. If Juice Reel also says paid, that raises the alert `juicereel_and_stripe_both_paid` (the reader is paying twice).
  - It never writes over a row granted by hand.
  - A `comp_trial` gives way to a purchase, as it does for Stripe.
- **Stripe only revokes what Stripe granted** (`billing_apply_subscription_state`, unchanged). A Juice Reel row has no `stripe_subscription_id`, so no Stripe state can end it.
  - When Juice Reel takes over a row whose Stripe subscription already ended, that subscription's id is cleared from the row. Otherwise the Stripe sweep would re-check it and apply "canceled" over a paid buyer.
  - The suite's CONTROL case shows this happening with the id left on.
- **One Juice Reel account opens one EdgeDesk account.** A second account linking it is refused (`JR_ACCOUNT_IN_USE`), and the alert `juicereel_account_in_use` is raised.
- **Only positive answers are written on a return.** A "not yet" a second after paying must not outrank the purchase webhook on its way. Negative states come only from webhooks, and from the expiry passing.
- **An older state never overwrites a newer one** (`as_of`). A second delivery of the same webhook changes nothing.
- **One product ending does not end another** the same buyer still pays for.
- **The hourly reconcile:**
  - Records every paid subscriber on Juice Reel's current list.
  - A linked buyer who is held as paid but is **absent** from that list is raised (`juicereel_absent_from_current`), never cut off on a guess.
  - It is debounced in the database (50 minutes), so the cron job carries no key.

## 7. Security

| Threat | Control |
|---|---|
| The client secret in the browser | Never. It is sent only in the Basic header from the function to Juice Reel |
| Login CSRF (an attacker's purchase linked into a victim's account) | The state is released only to the reader who started it, once, before it expires. Another reader's attempt is refused **without** using it up. Tested |
| Code interception | PKCE S256, and a single-use code. The callback page strips the code and state from the address first, sends no referrer, loads nothing, and runs under `default-src 'none'` |
| The verifier at rest | None is stored. It is `HMAC-SHA256(client secret, state)`, derived again on the return |
| Buyer tokens | Used for `/oauth2/me` and the status read, then dropped. Never stored, logged or returned. The suite searches every log line and Juice Reel table for every issued token and code |
| A forged webhook | HMAC-SHA256 over the raw body with `JUICE_REEL_WEBHOOK_SECRET`, compared in constant time. With no secret set, every webhook is refused (503). Tested with bad, missing and replayed-onto-another-body signatures |
| Navigating a buyer somewhere else | The function refuses a checkout URL not on `juicereel.com`. The page navigates only to `https://(www.)juicereel.com/…` |
| One payment opening many accounts | One Juice Reel account per EdgeDesk account |
| A reader reaching the writers | Every `billing_jr_*` function is the service role's alone (report row 3). The two operator functions check `billing_is_admin()` |
| Spam starts | At most 10 per reader per 10 minutes |

## 8. Secrets and settings (Supabase → Edge Functions → Secrets)

| Name | Value | Needed |
|---|---|---|
| `JUICE_REEL_CLIENT_ID` | the OAuth application's client id | yes (already set for the bet sync) |
| `JUICE_REEL_CLIENT_SECRET` | its client secret | yes (already set) |
| `JUICE_REEL_WEBHOOK_SECRET` | the SUBSCRIPTION_EVENTS webhook's signing secret | yes |
| `JUICE_REEL_CHECKOUT` | `off` (default) · `operators` · `on`. Set it with the `set_mode` step | to switch on |
| `JUICE_REEL_PRODUCT_IDS` | comma-separated Juice Reel product ids that open EdgeDesk. Empty means every product of the seller | no |
| `JUICE_REEL_BILLING_SCOPES` | default `subscribers.read` | no |
| `JUICE_REEL_BILLING_REDIRECT_URI` | default `https://edgedesksports.com/oauth/juicereel-subscribe.html` | no |

`GET /functions/v1/juicereel_billing` reports what is set, by name and as booleans only, plus `missing`.

## 9. What is verified, and what is not

**From Juice Reel's documentation and its official example server** (`github.com/juiceintegration/oauth-setup-example`, read 2026-10-28), built to exactly and enforced by the fake:
- `POST /checkout/sessions`: HTTP Basic, `X-OAuth-Client-Id`, and `{successUrl, cancelUrl, scopes, state, codeChallenge}`, with no product id. The answer is `201 {checkoutSessionId, checkoutUrl, expiresAt}`.
- The return: `?status=success&code&state`, or `?status=cancelled&state`. The cancelled form is used for a cancelled checkout **and** for declined consent.
- The token exchange uses the **success URL** as `redirect_uri`.
- `/oauth2/me` answers `{id, displayName}`, as the bet sync already uses it.
- Revoke answers 200 for any token with good client credentials.
- Webhooks: four event types, `X-Juice-Reel-Signature: sha256=<hex>`, the fields `subscriberUserId`, `subscriptionProductId`, `expiresDate` and `revenueCentsUsd`, and no retries.

**Not confirmed. Ask Juice Reel, and settle them in the live test:**
1. **The subscriber-status answer** (`GET /oauth2/subscribers/status` with the buyer's token): its exact shape.
   - The function reads `isSubscribed` / `subscribed` / `status`, then `subscription` / `subscriptions` / `data` / an array, then `expiresDate` / `expiresAt` and `subscriptionProductId`.
   - It **fails closed**: access only on a positive "subscribed".
2. **Owner access to the subscriber list** (`GET /oauth2/subscribers/current` with Basic), and its shape. The function assumes `{subscribers | data | items, nextCursor, hasMore}`, like the bet lists.
   - If Juice Reel refuses owner access there, `check` says `refused`, and the hourly reconcile reports `OWNER_ACCESS_REFUSED` and changes nothing.
   - The return still works through the status read and webhooks. A renewal whose webhook was lost would then need the reader's **Re-check with Juice Reel**.
3. **The webhook envelope**: where the event's `id`, `type` and time sit.
   - The function reads `id` / `eventId`, `type` / `eventType` / `event`, and `createdAt` / `created` / `timestamp`. It reads the data from `data` / `payload` or the top level.
   - An event with no id is deduplicated by its body's hash.
4. **The signature**: HMAC-SHA256 over the raw body, the GitHub-style reading of `sha256=<hex>`. If Juice Reel signs something else (a timestamp prefix, say), every delivery is refused with 401, and the logs say "webhook signature refused".

## 10. Tests (run here, 2026-10-28)

| Suite | What | Result |
|---|---|---|
| `tools/billing/juicereel_billing.test.js` | The shipped function in a stub Deno, over a real PostgreSQL with the shipped billing migrations and this one (applied twice), a fake Juice Reel, and the shipped Stripe functions with a fake Stripe. Covers: the switch (off, operators, on); the full checkout, with exact requests asserted; replay; CSRF with another reader; unknown and expired states; one Juice Reel account per EdgeDesk account; cancelled checkout and consent declined after paying (then webhook, then link); four status shapes, and a top-level "not subscribed" overriding an active-looking entry; no status endpoint (the owner list); neither answering (pending, then the webhook); the webhook (bad, missing, forged signatures, no secret, duplicates, renew, cancel, expire, stale, other product, unknown type); `owner_comp`; Stripe plus Juice Reel (alert); `comp_trial`; **the ended-Stripe regression and its CONTROL**; the reconcile (debounce, paging, a lost renewal, absent buyer alerted not cut, owner access refused); credentials refused; a non-Juice-Reel checkout URL; token endpoint down then retried; the rate limit; link with no subscription; the authorize URL; operators' overview and unlink; `check`; no token, code or secret in any log or table | **82 passed, 0 failed** |
| mutation checks | Clearing of the ended Stripe id removed → exactly the 4 tests written for it fail. The "only the reader who started it" check removed → exactly the 3 CSRF tests fail | as expected |
| `tools/billing/juicereel_client.test.js` | The browser library: navigates only to Juice Reel, reads a return once, drops a stale one, one retry only when the server says so | **25 passed, 0 failed** |
| `tools/billing/juicereel_checkout.e2e.js` | Chromium, 390 px and 1280 px, the shipped pages. Covers: the partner band (switch off and on); an abandoned Juice Reel click never hijacking the card-trial button; sign-up → Juice Reel → the callback page → the terminal open, with the address clean and the hand-off gone; no renewal consent recorded; Settings billed through Juice Reel; the paywall order; the link button; a cancelled checkout; switch off unchanged; the callback page alone | **42 passed, 0 failed** |

## 11. Known limitations, and decisions for the owner

- **The card trial is still sold.** Juice Reel is added alongside it, and first on the paywall. Retiring the Stripe trial for new buyers would be a separate change: every trial promise on the landing page (nav, hero, sticky bar, pricing, structured data, the renewal terms) would have to match the Juice Reel plan's price and trial first.
- **No price is shown for Juice Reel.** Juice Reel's checkout shows the plan and price, and EdgeDesk does not state a figure it does not set.
- **No renewal consent is recorded for a Juice Reel purchase.** Juice Reel is the merchant and presents its own terms. Confirm that this matches the agreement with Juice Reel.
- **Renewals** arrive by webhook and the hourly reconcile. If both fail, access ends at the old expiry until the reader presses **Re-check with Juice Reel** (Settings) or **I bought EdgeDesk on Juice Reel** (paywall).
- **Consent declined after paying** returns `status=cancelled`. The reader is told not to pay again and to link their account. The purchase webhook is kept for them meanwhile, and operators see them under `paid_not_linked`.
- **Moving a Juice Reel account** to another EdgeDesk account is an operator's `billing_admin_juicereel_unlink(user)`. It ends the access it granted there.
- **A stale description.** `lib/edgedesk_portfolio_connect_core.js` (`JUICEREEL.not_used`, inlined into `portfolio_connect` and `sharpsports-webhook`) still says EdgeDesk does not sell through Juice Reel. That is true of the bet-sync connector, which still calls neither endpoint, and stale as a description of EdgeDesk. It is left for its own change, because it is inlined into two deployed functions.
