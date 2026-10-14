<!-- Research behind docs/sportsbook-sync-providers.md. Gathered 2026-10-14 by web search and fetch; every claim is labelled FETCHED, SEARCH EXCERPT, INFERENCE or NOT VERIFIED. Nothing was signed up for, submitted or purchased. -->

# EdgeDesk Sports: sportsbook bet-sync provider research

Research date: 2026-10-14. Goal: find a legitimate way to sync users' sportsbook bets into EdgeDesk for under $100/month to start, preferably free or usage-based. This would replace SharpSports betSync, which starts at $500/month.

## How to read this report

- **FETCHED**: I fetched the primary page with WebFetch, and the quote is from that page.
- **SEARCH EXCERPT**: The fetch tool could not reach the site. In this environment, every betting-related domain failed with `getaddrinfo ENOTFOUND`, including juicereel.com, sharpsports.io, pikkit.com, draftkings.com, fanduel.com, novig.com, prophetx.co, betfair.com, apps.apple.com, play.google.com and aws.amazon.com. A direct curl to juicereel.com was also refused by the egress proxy (HTTP 403). For these sites the quote comes from the WebSearch result for that URL. WebSearch returns a summary with quoted fragments, so treat these quotes as excerpts that I could not check against the full page.
- **INFERENCE**: My own reasoning. It is not a statement found on any page.
- **NOT VERIFIED**: I found no evidence either way.

I signed up for nothing, submitted no forms and contacted no one.

---

## 1. Juice Reel developer API (Juice Integration, Inc.)

**Overall confidence: PARTIALLY VERIFIED (search excerpts only; site blocked for fetch)**

| Item | Finding | Source / quote |
|---|---|---|
| What it is | An OAuth 2.0 API. A user who has a Juice Reel account grants your app access, and your backend can then read that user's open and settled bets. | SEARCH EXCERPT, https://www.juicereel.com/api-docs: "Connect a Juice Reel account with OAuth 2.0, then securely read subscriber relationships and the connected user's open or settled bets from your backend." Endpoints: "Authorization URL https://www.juicereel.com/oauth2/authorize API base URL https://external-api.juicereel.com" |
| Pricing | **NOT VERIFIED.** No developer fee, plan or price page was found in 4+ queries. The only prices found are consumer prices (picks subscriptions and an AI bot). | SEARCH EXCERPT, juicereel.com user profile pages: "plans from $24.99/week · cancel anytime" (consumer picks, not API) |
| Free tier / minimums | NOT VERIFIED. The consumer tracker is described as free. | SEARCH EXCERPT, https://www.juicereel.com/sports-betting-tracker-app: "100% free sports betting tracker app" |
| Access / approval | Apps are registered and scopes are approved per app. The wording suggests an approval step, but no self-serve sign-up page was found. | SEARCH EXCERPT, https://www.juicereel.com/api-docs/open-bets: "Your approved OAuth client ID"; scopes "must be unique and a subset of the scopes approved for the OAuth application"; step 1: "Register callbacks and request only the scopes you need." |
| Scopes / endpoints | `bets.open.read` → `GET /oauth2/bets/open`; `bets.settled.read` → `GET /oauth2/bets/settled`; `subscribers.read`. Pagination is cursor-based. | SEARCH EXCERPT, https://www.juicereel.com/api-docs/open-bets and /api-docs. Settled: "Return the connected user's closed and cancelled bets using cursor-based pagination." |
| Authorization model for the end user | OAuth 2.0 authorization code with PKCE (S256), via a browser redirect. The token exchange runs on the backend with HTTP Basic auth (client ID + secret). Refresh tokens rotate. **EdgeDesk would never see sportsbook passwords.** | SEARCH EXCERPT, /api-docs/open-bets: "Base64url SHA-256 digest of your PKCE verifier. Must be S256."; "POST/oauth2/token. Authentication HTTP Basic: client ID and client secret" |
| How Juice Reel itself connects sportsbooks | Credential-based. The user enters sportsbook login information into Juice Reel. One user review reports having to turn off 2FA to sync. | SEARCH EXCERPT, Google Play listing https://play.google.com/store/apps/details?id=com.juiceintegration.juicereel: users "securely input your sportsbook information into our smart sports betting tool". SEARCH EXCERPT (user review, App Store): had to turn off two-factor authentication to sync. |
| DraftKings / FanDuel support | Yes, according to Juice Reel's store listing. | SEARCH EXCERPT, Google Play / App Store listing: "connects to all major sportsbooks and DFS platforms" including "DraftKings, FanDuel, BetMGM, Caesars, Bet365…" |
| Historical import | All settled history Juice Reel holds is returned when no date filter is given. How far back Juice Reel itself pulls from each book is NOT VERIFIED. | SEARCH EXCERPT, /api-docs: "If neither dateClosedAfter nor dateClosedBefore is supplied, all available settled-bet history is considered." |
| New wagers / settlements | Polling (filters on `datePlacedAfter` / `dateClosedAfter`). The webhooks found cover **subscription** events only and are not retried. **No bet-placed or bet-settled webhook was found** (NOT VERIFIED either way). | SEARCH EXCERPT, /api-docs: "We do not currently support retrying webhooks."; subscription event table (purchase, renewal, cancellation, expiration). |
| Rate limits | 1,000 requests per IP and 25,000 requests per client ID, per 5-minute bucket. No user-count limit found. | SEARCH EXCERPT, /api-docs: "1,000 requests Per IP address per five-minute bucket 25,000 requests Per client ID per five-minute bucket." |
| Commercial / third-party use | **Unclear, and probably needs written authorization.** The Terms of Use (updated Aug 10, 2026) forbid commercial exploitation "except as expressly permitted through the Services". Whether the API counts as express permission for an outside commercial app is NOT VERIFIED. No separate developer or API agreement was found. | SEARCH EXCERPT, https://www.juicereel.com/terms-of-use: "Except as expressly permitted through the Services, you may not reproduce, scrape, crawl, copy, distribute, republish, license, sell, reverse engineer, … commercially exploit or otherwise use the Services or Content without our prior written authorization." |
| Data-use consideration | Juice Reel's terms let Juice use data from connected sportsbook accounts commercially, including licensing. EdgeDesk would need to tell users this. | SEARCH EXCERPT, /terms-of-use: users authorize Juice to use connected-account information "including for commercial purposes such as licensing and monetization." |
| Production readiness | The docs are public and describe sandbox-free production URLs. GA status, waitlist and approval criteria are NOT VERIFIED. The docs describe subscription event forwarding as "early-stage". | SEARCH EXCERPT, /api-docs |
| Security / maintenance | Good for EdgeDesk: OAuth, PKCE and no password handling. Weaknesses: (a) the user must create a Juice Reel account and give *Juice Reel* their sportsbook credentials; (b) sync reliability depends on Juice Reel (store reviews report books failing to sync, e.g. bet365 on Android); (c) there is a dependency on a consumer company that is also a competing tracker. | SEARCH EXCERPT, Google Play review: "you can't even sync one of the few major book like bet365 on Android" |

---

## 2. Pikkit

**Overall confidence: PARTIALLY VERIFIED (search excerpts; site blocked for fetch). Verdict: no developer access.**

- **Public API or partner program:** None found. There is no developer portal, API documentation or partner sign-up page in 5+ queries. One trade article reports a ProphetX distribution deal, which is not a data API (SEARCH EXCERPT, https://www.casino.org/news/prophetx-expands-b2b-prediction-market-push-with-pikkit-partnership/). OpticOdds lists Pikkit as a *customer* of its odds and bet-tracking API (SEARCH EXCERPT, https://opticodds.com/customers/pikkit: "Pikkit integrated OpticOdds' industry-leading odds and bet-tracking API").
- **Terms:**
  - Commercial use: "No other use is permitted without prior written consent from us. You may not sell, transfer, assign, license, sublicense, or modify the Content" (SEARCH EXCERPT, https://pikkit.com/terms; the excerpt may be several years old).
  - Automated access: express written permission is required before using "any robot, spider, scraper, or other automated" means (SEARCH EXCERPT, same URL).
- **How Pikkit links books:** The user types in their sportsbook username and password, and 2FA codes are relayed through the app. Pikkit says the link is read-only.
  - SEARCH EXCERPT, https://pikkit.com/blog/how-to-connect-sportsbooks-to-pikkit: "Enter the username and password you use to log into that sportsbook directly."
  - SEARCH EXCERPT, https://pikkit.com/booksync: Pikkit can see bets and balance but cannot place bets, move funds or change the account.
  - SEARCH EXCERPT, App Store: "Your credentials are encrypted and not stored with Pikkit or other third parties."
- **DraftKings / FanDuel:** Supported. Pikkit claims 30+ books, and its pages name DraftKings and FanDuel. Sync is free with no per-book cap (SEARCH EXCERPT, pikkit.com/booksync and pikkit.com/blog).
- **CSV export (user-driven):** "Bet Transaction Exporting" is a Pikkit **Pro** feature (SEARCH EXCERPT, https://pikkit.com/pro). A third party says "Pikkit (free) — Recommended: Export bets from your linked books" (SEARCH EXCERPT, https://www.betbinder.net/import; free vs Pro conflicts between sources). The CSV format is NOT VERIFIED.
- **INFERENCE:** EdgeDesk could accept a CSV that a user exports from Pikkit as a manual upload. Whether that conflicts with Pikkit's "Content" restrictions is NOT VERIFIED and needs a legal read, since the bets are the user's own data.

---

## 3. SharpSports (betSync)

**Overall confidence: PARTIALLY VERIFIED (search excerpts; app.sharpsports.io and docs blocked for fetch; GitHub SDK repo FETCHED)**

| Item | Finding | Source / quote |
|---|---|---|
| Pricing | betSync "Starts at $500/mo". Other products: betPrices $750/mo, betPlace $1,750/mo, betContent $3,000/mo, Historic Data $3,000/mo. | SEARCH EXCERPT, https://app.sharpsports.io/: "Starts at$500/mo" (betSync), with features including account linking, pre-built UI and real-time sync |
| Startup or usage-based tier | **None found.** Billing appears to count active accounts, but no per-account rate or allowance is published. | SEARCH EXCERPT, https://docs.sharpsports.io/reference/bettoraccount: accounts with "access=false will not count towards billable usage" |
| Free tier | Sandbox only (test users, no real books). Live mode requires a paid plan. | SEARCH EXCERPT, https://docs.sharpsports.io/docs/sandbox-environment: live mode requires signing up for a paid plan; sandbox "can link test users but not real sportsbook accounts" |
| DraftKings / FanDuel | DraftKings is supported, but in some regions only through SharpSports' SDK or Chrome extension (example: DraftKings NY `"mobileOnly":true, "sdkRequired": true`). For FanDuel, a third party (BtrBet) says DraftKings and FanDuel may need the SharpSports Chrome Extension. | SEARCH EXCERPT, https://docs.sharpsports.io/reference/sdk-support; SEARCH EXCERPT, https://docs.btrbet.app/reference/linked_accounts/ |
| Authorization | Hosted BookLink UI in a web view, where the bettor logs into the book through SharpSports. Credentials are kept on file (re-link is needed when the password changes); the storage method is NOT VERIFIED. 2FA/OTP pages exist for some books. | FETCHED, https://github.com/sharpsports/sharpsports-mobile-link: the button "opens up the SharpSports BookLink UI in a web-view" (MIT license). SEARCH EXCERPT, docs: 401 refresh errors can come from "a password change for this book" |
| Sync of new / settled bets | Refreshes are started by the developer through the API and results arrive by webhook (`refreshResponse.created`, `bettorAccount.unverified`). Refreshes must be at least 60 s apart. The docs conflict on automatic "cadence" refreshes. | SEARCH EXCERPT, https://docs.sharpsports.io/docs/quickstart-1 and /reference/refresh-response |
| Historical import | Depends on the book (`pullBackToDate`, `maxHistoryMonths`; the example BetMGM record shows 24 months). | SEARCH EXCERPT, https://docs.sharpsports.io/reference/book |
| Commercial use | Permitted. This is a B2B product sold to apps (e.g. SportsDataIO, BettingPros and Dimers partnerships). | SEARCH EXCERPT, https://sbcamericas.com/2021/11/24/sportsdataio-enters-into-bet-tracking-solution-partnership-with-sharpsports/ |
| Production readiness | GA, paid. | — |
| Ruling | Already integrated, but **$500/mo exceeds the budget**. A discount would only come from a sales conversation (NOT VERIFIED). | |

---

## 4. Other aggregators and bet-sync APIs

| Name | Developer / partner access? | Evidence | Confidence |
|---|---|---|---|
| Action Network BetSync | **Consumer feature only.** No developer or partner API found. | SEARCH EXCERPT, https://www.actionnetwork.com/education/action-network-betsync-bet-tracking: works "sportsbook-to-Action Network"; users "log in when prompted". The Action Network patent describes the mechanism (https://patents.google.com/patent/US11823528). | PARTIALLY VERIFIED (no dev program found) |
| Betstamp | No public API or partner program found. The app describes tracking as user input. | SEARCH EXCERPT, App Store https://apps.apple.com/app/id1525948689: "Seamlessly input & track your bets in real-time for FREE" | NOT VERIFIED (no dev access found) |
| OddsJam bet tracker | No API or sync-mechanism documentation found. A third-party review mentions "automated syncing". | SEARCH EXCERPT, https://parse.gl/brands/oddsjam-com (weak) | NOT VERIFIED |
| Rithmm | No account sync. Its "Track and Go" feature sends users out to a sportsbook; tracking appears to be manual. | SEARCH EXCERPT, https://statsniper.com/statsniper-vs-rithmm/ (competitor source) | NOT VERIFIED |
| OpticOdds | Enterprise odds, grading and "bet-tracking" API. Pricing is not public. Whether it offers *user account linking* is NOT VERIFIED; its case study vaguely mentions "seamless aggregation of user bets". | SEARCH EXCERPT, https://opticodds.com/customers/pikkit; pricing "contact for pricing" per https://odds-api.io/blog/odds-api-vs-opticodds | Needs sales conversation |
| SportsDataIO (reseller of SharpSports BetLink) | A 2021 deal put SharpSports BetLink in SportsDataIO widgets. Current status and pricing NOT VERIFIED. | SEARCH EXCERPT, https://sbcamericas.com/2021/11/24/... | Needs sales conversation |
| Odds APIs (SharpAPI, The Odds API, SportsGameOdds, TheRundown) | **Odds data only. They do not read user bets**, so they are not a sync solution. They could help grade bets imported by OCR or CSV. | SEARCH EXCERPT, https://sharpapi.io/learn/what-is-a-sportsbook-api: "The major US sportsbooks have no public developer APIs." | N/A |

No B2B bet-sync API other than SharpSports and Juice Reel was found in 6+ broad queries ("sportsbook account aggregation API", "bet tracking API", "BetSync alternative", "Plaid for sports betting", "SharpSports competitors").

---

## 5. Official sportsbook and exchange APIs for customer bet history

| Venue | Customer API? | Evidence | Pricing / eligibility | Confidence |
|---|---|---|---|---|
| **DraftKings** | **No public API found.** It offers official account linking only through an exclusive partnership: DraftKings–ESPN (Mar 2026), which links accounts for "Bet Your Bracket". Showing "upcoming, live and settled bets" in ESPN was announced as a future step. | SEARCH EXCERPT, https://www.legalsportsreport.com/256616/espn-draftkings-to-debut-account-linking-before-march-madness/ and https://sbcamericas.com/2026/03/06/draftkings-espn-account-linking/ | Partnership only (INFERENCE: not available to a small startup) | PARTIALLY VERIFIED |
| DraftKings terms | **Automated or third-party access is prohibited.** DraftKings also tells customers not to share passwords with third-party sites. | SEARCH EXCERPT, https://sportsbook.draftkings.com/legal/us-terms-of-use: prohibited conduct includes "Using automated means (including but not limited to scripts and third-party tools) to interact with the Website in any way", plus a separate ban on automated data collection. SEARCH EXCERPT, https://support.draftkings.com/dk/en-us/account-security-frequently-asked-questions-us?...KB0010405: "You are prohibited from allowing any other person to access or use your gaming account." SEARCH EXCERPT, https://www.espn.com/chalk/story/_/id/35077846/...: DraftKings "strongly recommend that customers do not share their passwords with anyone, including third party sites" (article date not confirmed; the URL ID suggests about 2022). | — | PARTIALLY VERIFIED |
| **FanDuel** | **No public API found.** | — | — | NOT VERIFIED (none found) |
| FanDuel terms | Third-party scripts are prohibited, and older terms bar scrapers and robots. | SEARCH EXCERPT, https://www.fanduel.com/trust: "Use of third-party or unauthorized scripts is prohibited". SEARCH EXCERPT, https://support.fanduel.com/s/article/Can-I-place-a-bet-for-someone-else-or-let-someone-use-my-account: you cannot "allow another person to log in". | — | PARTIALLY VERIFIED |
| **ProphetX** (US exchange) | Yes. A developer hub lists Trading, Market Data, Parlay, ISV and **Direct Link** APIs. Direct Link: "Link a user's ProphetX account to your platform … your backend never touches user funds or keys." Access requires a request form and an approval review. A user-authorization flow for reading bet history was NOT VERIFIED. | SEARCH EXCERPT, https://docs.prophetx.co/ and https://docs.prophetx.co/docs/requesting-api-access: "the ProphetX team will review your request and grant API access if your application is approved." | Fees NOT VERIFIED; approval required | PARTIALLY VERIFIED |
| **Novig** (US exchange) | Yes, using user-generated keys. A "Management key" is created under Profile → Settings → Novig API. Community repos describe a read-only `trading::read` key. Production key creation is reportedly gated per account. Whether third-party use of keys is permitted is NOT VERIFIED. | SEARCH EXCERPT, https://docs.novig.com/api/api-keys; community repo https://github.com/ckloote/clv-harness/pull/2 | No API fee found (NOT VERIFIED). Trading fees exist (https://docs.novig.com/fees). | PARTIALLY VERIFIED |
| **Sporttrade** | No public docs. A third party says Sporttrade left US online betting in 2026 and offers a waitlist with API access for "FCMs, market makers and trading firms". | SEARCH EXCERPT, https://nextpredict.io/platforms/sporttrade/ (third party) | — | NOT VERIFIED |
| **Pinnacle** | **Closed to the public.** | FETCHED, https://github.com/pinnacleapi/pinnacleapi-documentation: "Access to Pinnacle API suite has been closed for the general public since July 23rd, 2025." "We offer bespoke data services for select high value bettors & commercial partnerships." Requires "a funded account"; "maximum of 2 distinct IP addresses per client." | Partnership only | VERIFIED |
| **Betfair Exchange** (non-US, reference only) | Yes. Personal live app key: £299 one-off. Third-party apps use the Vendor Web API (OAuth2) under a Software Vendor licence. The fee for that licence conflicts across Betfair pages: £499, £999 or £1,499. | SEARCH EXCERPT, betfair-developer-docs.atlassian.net and https://developer.betfair.com/en/vendor-program/the-process/: "The Vendor Web API is available to licensed Software Vendors … using the OAuth2 protocol." | £299 / £499–£1,499 one-off; not US | PARTIALLY VERIFIED |

---

## 6. Semi-automatic legitimate paths

### 6a. Bet-history export
- **FanDuel:** There is an official Player Activity Statement with a download option and custom date ranges. Whether it lists each bet individually and whether it is a CSV is **NOT VERIFIED**. The excerpt describes a summary of "deposits, withdrawals, wagers, winnings".
  - SEARCH EXCERPT, https://support.fanduel.com/s/article/Where-can-I-see-my-Win-Loss-Statement: "Sign in to your FanDuel account. Open Your Play. Select Activity Statement."
  - The same source mentions "Download your Player Activity Statement" and "Download Statement".
  - The DFS (not sportsbook) product has "Download as CSV" (SEARCH EXCERPT, https://www.fantasypros.com/daily-fantasy/nba/performance-history.php).
- **DraftKings:** **No official per-bet export found.** Third parties state it does not exist.
  - SEARCH EXCERPT, https://www.sportsbookscout.com/sports-betting-guides/download-export-bet-history-draftkings-sportsbook: "it seems like this functionality would be provided by DraftKings as a standard option for users. But it's not."
  - Win/loss and transaction statements are available under Account → Financial Center (SEARCH EXCERPT, https://bettinghero.com/help/draftkings/general/win-loss-statements-on-draftkings/; PDF/CSV format conflicts between sources).
  - Official route for full data: a Privacy Center access request. SEARCH EXCERPT, https://support.draftkings.com/dk/en-us/draftkings-privacy-center-overview?...KB0010264: "submit a request to access a copy of the personal information we hold about you". ProPublica says this form route is available only in states with certain privacy laws (SEARCH EXCERPT, https://projects.propublica.org/sports-betting-uploader/).
- **Browser-extension exporters** (Sportsbook Scout Bet Downloader, "DraftKings Transactions Exporter") exist. INFERENCE: these are third-party tools interacting with the logged-in site, which conflicts with DraftKings' "automated means … third-party tools" clause. They are excluded as recommendations.

### 6b. Per-bet confirmation emails (for an inbound-email parser)
- **DraftKings: NOT VERIFIED.** No evidence was found that DraftKings sends a per-bet confirmation email. The only emails documented are promotional or award notifications (SEARCH EXCERPT, https://sportsbook.draftkings.com/vippromoterms).
- **FanDuel: NOT VERIFIED.** No per-bet sportsbook email was found. The only "Request bet confirmation" setting found is for TVG (horse racing), not the sportsbook (SEARCH EXCERPT, https://support.fanduel.com/s/article/Default-Bets-and-Wager-Confirmation-on-Desktop).
- An email-forwarding parser **cannot be recommended on current evidence**.
- Related: FanDuel's "Share Bet" posts to its Community Feed. It is not an export (SEARCH EXCERPT, https://www.fanduel.com/community-feed).

---

## 7. Screenshot / OCR bet-slip import costs

| Option | Pricing / license | Source | Confidence |
|---|---|---|---|
| **Tesseract.js** | Free, **Apache-2.0**. Runs in the browser (bundler, ESM or CDN) and in Node. "Pure Javascript OCR for more than 100 Languages". Note: it "does not modify the Tesseract recognition model to improve accuracy". | FETCHED, https://github.com/naptha/tesseract.js | VERIFIED |
| **Google Cloud Vision** (Text Detection / Document Text Detection) | First 1,000 units/month free. Then **$1.50 per 1,000** for units 1,001–5,000,000, and $0.60 per 1,000 above that. "Charges are incurred per image"; "Each feature applied to an image is a billable unit." | FETCHED, https://cloud.google.com/vision/pricing: "Pricing is tiered - the first 1000 units used each month are free" | VERIFIED |
| **AWS Textract** (DetectDocumentText) | $0.0015/page (= **$1.50 per 1,000**) for the first 1M pages, $0.0006 after that. Free Tier: 1,000 pages/month, which the excerpt says lasts 3 months for new customers. | SEARCH EXCERPT, https://aws.amazon.com/textract/pricing/ (fetch blocked) | PARTIALLY VERIFIED |

INFERENCE (arithmetic on the verified Vision prices): 5,000 slip screenshots a month on Google Vision would cost (5,000 − 1,000) / 1,000 × $1.50 = **$6.00/month**. 20,000 a month would cost $28.50. Tesseract.js running in the browser costs $0 in API fees, but accuracy on bet slips is NOT VERIFIED.

---

## Bottom line (ranked strictly by evidence)

**A. Verified under $100/mo with DraftKings + FanDuel support and permitted commercial use: none.** No option meets all three conditions on the evidence I could verify.

**B. Best candidate, which needs a conversation with the provider (the user's decision, not done here):**
1. **Juice Reel OAuth API.** This is the only automatic option found that uses a proper OAuth/PKCE hosted consent flow, so EdgeDesk never handles sportsbook passwords.
   - For: it reads open and settled bets including full history; rate limits are generous; Juice Reel's listing names DraftKings and FanDuel; the consumer tracker is free.
   - Not verified: API pricing; whether outside commercial apps are allowed (client IDs and scopes are "approved", and the ToS bars commercial exploitation without "prior written authorization" except as "expressly permitted through the Services"); bet webhooks (expect to poll).
   - Caveats: users must open a Juice Reel account and give Juice Reel their sportsbook credentials. Juice Reel's terms allow it to monetize connected-account data.
   - **Status: PARTIALLY VERIFIED. It needs written confirmation of approval, fees and commercial permission from Juice Reel before you build on it.**
2. **SharpSports.** Verified at "Starts at $500/mo", with no startup or usage tier found. It stays an option only if negotiated down. Commercial use is clearly allowed.
3. **ProphetX Direct Link / ISV and Novig read keys.** These are official, and access is by approval (ProphetX) or keys the user generates (Novig). They cover **only those exchanges, not DraftKings or FanDuel**. Fees and third-party permissions are NOT VERIFIED.
4. **OpticOdds and SportsDataIO.** Enterprise products with no public pricing. Neither is verified to offer user account linking.

**C. Cheap, legitimate fallbacks for DraftKings and FanDuel that need user effort:**
- **Screenshot/OCR import (verified costs):**
  - Tesseract.js: free, Apache-2.0.
  - Google Vision: 1,000 free per month, then $1.50 per 1,000.
  - Textract: $1.50 per 1,000 (free tier is a search excerpt).
  - This stays far under $100/month at startup volumes. Grading can use an odds or results API.
- **User-uploaded exports:**
  - FanDuel Activity Statement: official, but per-bet detail and format are NOT VERIFIED.
  - DraftKings Privacy Center data request: official, but slow and not available in every state.
  - Pikkit CSV export: Pro feature; legal read needed.

**D. Ruled out, with reasons:**
- **Pikkit API or partnership:** none exists publicly. Its terms require written consent for commercial use and for automated access.
- **Action Network BetSync, Betstamp, OddsJam, Rithmm:** no developer or partner access found.
- **DraftKings or FanDuel official APIs:** none public. DraftKings' only official linking is the exclusive ESPN partnership.
- **Credential collection or scraping of DraftKings or FanDuel by EdgeDesk:** DraftKings' terms ban "automated means (including … scripts and third-party tools)" and DraftKings tells customers not to share passwords with third-party sites. FanDuel bans third-party scripts and letting others log in. **Excluded per the rules of this brief.** Browser-extension exporters fall under the same clause and are also excluded.
- **Email-forwarding parser:** no evidence that DraftKings or FanDuel send per-bet confirmation emails.
- **Pinnacle:** API closed to the public since July 23, 2025 (verified).
- **Betfair:** non-US, with vendor licence fees of £499–£1,499 (conflicting). Reference only.
- **Sporttrade:** reportedly not available to US customers; institutional API waitlist (third-party source).

---

## URLs actually fetched (WebFetch)

Successful:
- https://cloud.google.com/vision/pricing (fetched twice)
- https://github.com/naptha/tesseract.js
- https://github.com/pinnacleapi/pinnacleapi-documentation
- https://github.com/sharpsports/sharpsports-mobile-link

Attempted but blocked (`getaddrinfo ENOTFOUND` in this environment; for these sites I used search excerpts):
- https://www.juicereel.com/api-docs and https://juicereel.com/api-docs (a curl to these hosts also got proxy CONNECT 403)
- https://pikkit.com/terms, https://pikkit.app/terms
- https://sharpsports.io/pricing, https://app.sharpsports.io/, https://docs.sharpsports.io/
- https://apps.apple.com/us/app/pikkit-sports-betting-tracker/id1586567110
- https://play.google.com/store/apps/details?id=com.juiceintegration.juicereel&hl=en_US, https://play.google.com/store/apps/details?id=com.pikkit.android&hl=en_US
- https://sportsbook.draftkings.com/legal/terms-of-use
- https://support.fanduel.com/s/article/Where-can-I-see-my-Win-Loss-Statement
- https://aws.amazon.com/textract/pricing/, https://docs.aws.amazon.com/textract/latest/dg/limits.html
- https://developer.betfair.com/, https://developer.betfair.com/en/vendor-program/the-process/, https://support.developer.betfair.com/hc/en-us/articles/360002190732-...
- https://docs.novig.com/api/api-keys, https://docs.prophetx.co/
- https://opticodds.com/customers/pikkit
- https://www.actionnetwork.com/education/action-network-betsync-bet-tracking
- https://docs.btrbet.app/reference/linked_accounts/
- https://www.betbinder.net/import, https://www.sportsbookscout.com/sports-betting-guides/download-export-bet-history-draftkings-sportsbook
- https://projects.propublica.org/sports-betting-uploader/
- https://espnpressroom.com/us/press-releases/2026/03/draftkings-and-espn-detail-plans-to-provide-account-linking-for-customers/

## Main URLs cited from search excerpts (not fetched)
https://www.juicereel.com/api-docs · https://www.juicereel.com/api-docs/open-bets · https://www.juicereel.com/terms-of-use · https://www.juicereel.com/sports-betting-tracker-app · https://play.google.com/store/apps/details?id=com.juiceintegration.juicereel · https://pikkit.com/terms · https://pikkit.com/booksync · https://pikkit.com/blog/how-to-connect-sportsbooks-to-pikkit · https://pikkit.com/pro · https://app.sharpsports.io/ · https://docs.sharpsports.io/reference/bettoraccount · https://docs.sharpsports.io/docs/sandbox-environment · https://docs.sharpsports.io/reference/sdk-support · https://docs.sharpsports.io/docs/quickstart-1 · https://docs.sharpsports.io/reference/refresh-response · https://docs.sharpsports.io/reference/book · https://docs.btrbet.app/reference/linked_accounts/ · https://sportsbook.draftkings.com/legal/us-terms-of-use · https://support.draftkings.com/dk/en-us/account-security-frequently-asked-questions-us?id=kb_article_view&sysparm_article=KB0010405 · https://support.draftkings.com/dk/en-us/draftkings-privacy-center-overview?id=kb_article_view&sysparm_article=KB0010264 · https://www.fanduel.com/trust · https://support.fanduel.com/s/article/Can-I-place-a-bet-for-someone-else-or-let-someone-use-my-account · https://support.fanduel.com/s/article/Where-can-I-see-my-Win-Loss-Statement · https://www.fanduel.com/community-feed · https://docs.prophetx.co/ · https://docs.prophetx.co/docs/requesting-api-access · https://docs.novig.com/api/api-keys · https://nextpredict.io/platforms/sporttrade/ · https://developer.betfair.com/en/vendor-program/the-process/ · https://aws.amazon.com/textract/pricing/ · https://opticodds.com/customers/pikkit · https://www.actionnetwork.com/education/action-network-betsync-bet-tracking · https://sbcamericas.com/2021/11/24/sportsdataio-enters-into-bet-tracking-solution-partnership-with-sharpsports/ · https://www.legalsportsreport.com/256616/espn-draftkings-to-debut-account-linking-before-march-madness/ · https://www.sportsbookscout.com/sports-betting-guides/download-export-bet-history-draftkings-sportsbook · https://projects.propublica.org/sports-betting-uploader/ · https://www.casino.org/news/prophetx-expands-b2b-prediction-market-push-with-pikkit-partnership/
