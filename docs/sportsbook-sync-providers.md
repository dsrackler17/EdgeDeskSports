# Sportsbook sync: SharpSports retired, a replaceable provider seam, and screenshot import

Decided 2026-10-14. SharpSports BetSync is **off**: its plan starts at $500/month, above EdgeDesk's budget at this stage. This page covers:

1. what was audited and what was switched off;
2. the alternatives and what their prices and terms actually are;
3. the recommendation;
4. the provider-independent design that keeps the next provider a one-adapter change;
5. the free screenshot import added in its place;
6. the plan from here.

The research behind §2 is in [`sportsbook-sync-research-2026-10-14.md`](sportsbook-sync-research-2026-10-14.md). Every claim there is labelled by where it came from:

- **FETCHED**: read from the primary page;
- **SEARCH EXCERPT**: the site could not be fetched from the build environment, so the quote comes from a search result;
- **INFERENCE**;
- **NOT VERIFIED**.

Nothing was signed up for, purchased or switched on.

> **Update, later on 2026-10-14: the `juicereel` adapter is built** ([`juicereel.md`](juicereel.md)), at the account owner's request after they registered EdgeDesk's Juice Reel OAuth application. It sits in this seam (registered ACTIVE, grant-level) and is **not switched on**: Juice Reel has not yet approved the application. Naming it in `SPORTSBOOK_SYNC_PROVIDER` shows readers *Awaiting provider approval*; linking opens only after Juice Reel's approval, a PASSED PRODUCTION smoke test and a cleared terms review (the existing registry guard). Question 4 below is answered by Juice Reel's documentation: there are no bet webhooks (its only webhook bucket is subscription events, which EdgeDesk does not use), so bets are read from `/oauth2/bets/changed` on the existing schedule. Questions 1–3, 5 and 6 still need Juice Reel's written answers before switching it on.

## 1. Audit: what SharpSports touched, and what happened to each part

The Portfolio's pipeline has one shape for every source:

```
source → adapter → normalized wager → portfolio_svc_ingest_wagers / import / manual insert → portfolio_positions → derived P&L, analytics, UI
```

SharpSports was one adapter in that shape. Nothing downstream of the normalized wager is specific to it.

| Component | Where | What happened |
|---|---|---|
| SharpSports adapter (link, discover, refresh, slip normalizer, webhook hints, signature check) | `lib/edgedesk_portfolio_connect_core.js` § 10, inlined into both functions | **Kept, registered as RETIRED** in the new provider registry (§ 4). It is the reference adapter and keeps already-synced history readable. It runs only on a server that names it. |
| `portfolio_connect` BetSync actions | `supabase/functions/portfolio_connect/index.ts` | Now reached through the generic `sb_status / sb_books / sb_link / sb_discover / sb_refresh`. The old `ss_*` names still answer. **With no provider switched on, which is the default, status says `SYNC_OFF` and every other action returns 403 `SYNC_OFF`.** The sweep skips aggregator accounts. Sync now and Refresh on a linked account return `SYNC_OFF`. SharpSports is never called (tested). |
| Webhook receiver | `supabase/functions/sharpsports-webhook/index.ts` | **Inert:** every POST gets `200 {ignored:'sync_off'}` at once, and nothing is read or recorded (tested). It stays deployed so the five registered subscriptions get a clean 200 instead of retries until they are deleted on SharpSports' side. |
| Database: `portfolio_aggregator.sql` (registry row `sharpsports`, bettor references, webhook log, refresh requests, settlement history, `portfolio_svc_ingest_wagers`) | `supabase/` | **Kept, unchanged.** The registry row has always been off (`automatic_enabled = false`). The settlement history and the wager ingest are provider-independent and are what the next provider uses. No table, row or history was dropped. |
| Daily webhook-log prune | `supabase/portfolio_sync_cron.sql` | Kept. It is harmless and counts only. |
| Accounts UI | `lib/edgedesk_portfolio_ui.js` | **No provider is named anywhere in the user-facing flow.** Sportsbook tiles read **Import**. A book's card offers its CSV import, a **bet slip screenshot**, or "Add it, no file yet". A book a retired provider once linked reads **Sync off**: its history is kept, Disconnect is still offered, and Sync now, Refresh and Reconnect are not. |
| CI / deploy | `.github/workflows/portfolio-tests.yml`, `deploy-portfolio.yml` | Unchanged in behaviour: the SharpSports suites still run, with the switch both off and on. The deploy still applies the same SQL and deploys both functions, and the webhook's health check still answers 200. |

**Secrets.** Nothing reads these while no provider is on. **You can delete them in Supabase → Edge Functions → Secrets:**

- `SHARPSPORTS_API_KEY`, `SHARPSPORTS_PUBLIC_KEY`;
- `SHARPSPORTS_LIVE_API_KEY` and `SHARPSPORTS_LIVE_PUBLIC_KEY`, if they were ever set;
- `SHARPSPORTS_WEBHOOK_SECRETS`, `SHARPSPORTS_WEBHOOK_VERIFY`, `SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER`, `SHARPSPORTS_ENV`, `SHARPSPORTS_SCHEDULED_REFRESH_MINUTES`.

Do **not** set `SPORTSBOOK_SYNC_PROVIDER`. No secret value is in this repository, the logs or this page.

**On SharpSports' side, your action:**

- delete the five webhook subscriptions in the SharpSports dashboard;
- leave the account on its free sandbox, or close it. No paid plan was ever started.

**Verify after the next deploy.** The `portfolio_connect` health check (GET) reports `configured.sportsbook_sync.provider: null` and `configured.sharpsports.active: false`. The webhook's GET reports `active: false`.

## 2. The alternatives, by evidence

Full table, quotes and URLs: [research](sportsbook-sync-research-2026-10-14.md).

| Option | Price | DraftKings / FanDuel | Commercial use by EdgeDesk | How the user authorizes | Verdict |
|---|---|---|---|---|---|
| **SharpSports BetSync** | "Starts at $500/mo" (search excerpt). Sandbox only for free. | DraftKings yes, but in some states only via its SDK or Chrome extension | Yes (a B2B product) | Hosted page; the user signs in to the book through SharpSports | Over budget. Retired. |
| **Juice Reel API** | **Not verified.** No developer price found; the consumer tracker is free. | Its store listing names both | **Unclear.** Client IDs and scopes are "approved"; its terms bar commercial exploitation "without our prior written authorization" except as "expressly permitted through the Services". | OAuth 2.0 + PKCE (EdgeDesk never sees a password); the user gives *Juice Reel* their book logins | **Best candidate. It needs written answers from Juice Reel first (§ 6).** |
| Pikkit | No API or partner program found | Its app supports both | Terms need written consent for commercial and automated use | The user types book credentials into Pikkit | Ruled out as a provider |
| Action Network BetSync, Betstamp, OddsJam, Rithmm | No developer access found | — | — | — | Ruled out |
| OpticOdds, SportsDataIO | Enterprise; "contact for pricing" | Account linking not verified | — | — | Needs a sales call; unlikely under $100 |
| DraftKings / FanDuel official APIs | None public. DraftKings' only official linking is its exclusive ESPN partnership. | — | Their terms prohibit automated / third-party tools and letting others access an account (search excerpts) | — | Not available |
| ProphetX, Novig (US exchanges) | Fees not verified; ProphetX access is approved per application, and Novig uses user-made keys | **Only their own exchanges, not DraftKings or FanDuel** | Approval-based | OAuth-like link (ProphetX) / read key (Novig) | Possible later adapters for those venues |
| Pinnacle | Closed to the public since 2025-07-23 (fetched) | — | — | — | Ruled out |
| Email forwarding of bet confirmations | — | No evidence either book sends per-bet emails | — | — | Not recommendable on the evidence |
| **Screenshot OCR, in the browser** (Tesseract.js) | **$0**, Apache-2.0 (fetched) | Any book | Ours | Nothing: the user picks a screenshot | **Built (§ 5)** |
| Screenshot OCR, server-side (Google Cloud Vision) | First 1,000 images/month free, then $1.50 per 1,000 (fetched). About $6/month at 5,000 slips. | Any book | Ours | Nothing | An optional accuracy upgrade, only with your approval |

**No option is verified to meet all three conditions: under $100/month, DraftKings and FanDuel, and permitted commercial use.**

**Every aggregator, including SharpSports, works the same way: the user gives the aggregator their sportsbook login, and the aggregator signs in.** The research found DraftKings' and FanDuel's terms prohibiting third-party tools and letting another person access the account. That risk applies to any aggregator and is worth a lawyer's read before any of them goes live.

## 3. Recommendation

1. **Now, at no cost: file and screenshot import as the sportsbook path, plus manual entry.** This PR ships it:
   - CSV import, which already existed, with the importer's dedupe;
   - the new on-device screenshot import;
   - manual entry.
   All of it lands in the same Portfolio, analytics and dedupe. Sportsbook sync stays off.
2. **Next, at no cost to ask: send Juice Reel the questions in § 6.** Build a `juicereel` adapter only after written answers on price, commercial approval and data terms. **Do not activate it without your approval.**
3. **Optional:** a server-side OCR upgrade (Google Cloud Vision), if on-device OCR proves too inaccurate on real slips. Usage-based, about $6 per 5,000 slips. **Only with your approval.**

## 4. The provider-independent design

The seam is in `lib/edgedesk_portfolio_connect_core.js` § 11:

```js
K.defineSportsbookProvider({
  key, label, short, link_origin, what_the_reader_gives, status: 'ACTIVE' | 'RETIRED',
  link, discover, sync, refresh, accountState, webhookRefs, normalize   // SPORTSBOOK_PROVIDER_CONTRACT
});
```

- **One adapter per provider.** `defineSportsbookProvider` refuses an incomplete adapter, naming what is missing. It also refuses any adapter that would place bets.
  - `normalize` turns the provider's bets into EdgeDesk's normalized wager. These are the same fields CSV, screenshot and manual entry produce:
    - platform, event, selection, market type, line;
    - American or decimal odds, stake, status, payout;
    - placed and settled times, legs, raw payload;
    - external id `"<provider>:<bet id>"`.
  - `sync` hands them to `portfolio_svc_ingest_wagers`, which:
    - upserts by `(user, platform, external id)`;
    - adopts an imported or manual twin only on an exact match;
    - appends settlements to the append-only history;
    - never touches notes or attribution.
- **One switch.** The `SPORTSBOOK_SYNC_PROVIDER` secret names the single active provider; none is the default.
  - The core's `activeSportsbookProvider(ctx, key)` is the only gate: sync, the sweep and the webhook all go through it.
  - `portfolio_connect` routes `sb_*` through a handler table (`SPORTSBOOK_HANDLERS`).
- **One UI.** Accounts reads the provider's label, short name, linking-page origin and wording from the registry:
  - the page only opens the linking page if its URL starts with that origin, which comes from shipped code, not from the server's answer;
  - nothing in the page names a provider.
- **Adding provider X:**
  1. Write the adapter and register it.
  2. Add a row to `SPORTSBOOK_HANDLERS`.
  3. Add a registry row in SQL, off.
  4. Test it against a fake of the provider, the way `tools/portfolio/sharpsports.test.js` does.
  5. Set `SPORTSBOOK_SYNC_PROVIDER` only after its terms are cleared and a production smoke test passes.
  No table, view, analytics function or screen changes.

## 5. Screenshot import: free, on the reader's device, checked before saving

The code is `lib/edgedesk_slip_reader.js`. It is reached from a sportsbook's card in Accounts ("Read a bet slip screenshot") or from the Import tab ("Or one bet from a screenshot").

1. **OCR in the browser.** Tesseract.js 5.1.1 is loaded from jsDelivr only when someone picks a screenshot. The script carries an integrity hash computed from the npm package, so an altered file is refused. Tesseract then fetches its own worker and engine (same version) and its English model from public CDNs.
   - **The image is never uploaded.**
   - Dark-mode slips are inverted, and small ones enlarged, before reading.
   - PNG, JPEG or WebP, up to 10 MB.
   - Cost: $0.
2. **Reading rules.** Each field is filled only where the text says it:
   - the book, event, selection and line;
   - the market type (spread, total, moneyline, player prop, parlay, same-game parlay);
   - American odds (a labelled "Odds" wins, so a parlay's combined price beats a leg's);
   - the stake and payout, **only beside a label**, in either order and on one line or stacked;
   - the result: **"To Win" is not a win, and a Cash Out offer is not a cash-out**;
   - a bonus bet, the bet ID, and the placed time (month-first; a date that only reads day-first is not read).
   Two different results on one single are left for the reader to choose. On a parlay, a lost leg makes the ticket lost.
3. **The ordinary bet form opens, filled in.** It shows which fields were not found and what was guessed. **Nothing is saved until the reader presses Save.**
   - Saving is the normal manual path: the same validation and the database-derived P&L.
   - The **bet ID is kept as the position's external ID**, so the same bet is refused a second time. That holds for a second screenshot (tested in the browser) and for the book's CSV imported later, which is classified `DUPLICATE` of the screenshot's position (tested against PostgreSQL).

**Accuracy is not claimed.** The tests use synthetic OCR text in the layouts slips use, not real screenshots. Real-slip accuracy should be measured on a handful of your own slips before it is promoted beyond "check every field".

## 6. Plan

**Done in this change.** No subscription is needed for any of it.

- SharpSports switched off by default:
  - the off switch is tested end to end;
  - a book it linked keeps its history;
  - its webhook is inert.
- The provider seam (§ 4): the registry with contract checks, generic actions and a provider-neutral UI.
- One-click sportsbook tiles in Accounts. A book's card offers CSV import, a screenshot, or adding the book.
- Screenshot import (§ 5), with the bet ID used for dedupe across screenshots and CSV.

**Your actions:**

- delete the SharpSports secrets and the five webhook subscriptions (§ 1);
- re-run Deploy Portfolio schema with `deploy_function` checked, so the off switch is deployed.

**Next, needing your approval before any spend.** Ask Juice Reel, in writing:

1. Is the developer API open to a third-party commercial app, and what is the approval process?
2. What is the price: per user, per request, or a minimum?
3. Which books sync for US users, specifically DraftKings and FanDuel? By what mechanism? How far back is history?
4. Are there webhooks for new and settled bets, or polling only?
5. What does their data-licensing clause mean for bets synced on EdgeDesk's behalf?
6. Can EdgeDesk display or store the data after a user disconnects?

If the answers fit the budget and the terms are acceptable, the work was:

- a `juicereel` adapter: OAuth with PKCE, the token sealed in the existing credential vault, `bets/open` and `bets/settled` for the import, `bets/changed` from then on — **built** ([`juicereel.md`](juicereel.md));
- its fake for the test suite — **built** (`tools/portfolio/_fake_juicereel.js`);
- a production smoke test — **built** (`tools/portfolio/juicereel_smoke.js`), to be run once Juice Reel approves the application.

Then switch it on with `SPORTSBOOK_SYNC_PROVIDER=juicereel` and the registry row ([`juicereel.md`](juicereel.md) § 9).

**Later, if useful:**

- server-side OCR (Google Cloud Vision, usage-based);
- ProphetX or Novig adapters for bets placed on those exchanges.

**Not planned:**

- scraping a sportsbook, a browser extension that reads one, or collecting sportsbook passwords — excluded;
- an email-forwarding parser, since there is no evidence the books send per-bet emails.

## 7. Tests

These are the commands a contributor runs; all are in CI.

- **`tools/portfolio/sharpsports.test.js`** (97):
  - *Switch off, the default:* status says `SYNC_OFF`; books, link, discover and refresh are refused, and SharpSports is never called; the webhook ignores even malformed posts and records nothing; health reports no provider.
  - *Switched off after linking:* the sweep skips the account; Sync now and Refresh are refused; the history stays.
  - *Switched on:* the full retired-adapter flow.
  - *Registry:* refuses incomplete or betting adapters.
  - *UI:* names no provider when sync is off.
- **`tools/portfolio/slip_reader.test.js`** (22):
  - the reading rules on labelled synthetic slips;
  - the filled-in form and the saved row;
  - against PostgreSQL: the same slip twice is refused, and the book's CSV for the same bet is classified `DUPLICATE`.
- **`tools/portfolio/portfolio_ui.e2e.js`** (133, Chromium): a screenshot opens the filled-in form; nothing is saved before Save; it saves as a manual position with the bet ID; the same slip a second time is refused; nothing from it is kept in `localStorage`.
- **`tools/portfolio/sharpsports_ui.e2e.js`** (21, Chromium):
  - *Sync off:* DraftKings' card offers only its import, and no provider is named or asked.
  - *Sync on:* the linking flow end to end.
