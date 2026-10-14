# Portfolio — platform support

**As of 2026-10-14, no platform syncs automatically in production.** Every platform below works through **manual entry** and **file import**, and its positions count exactly like any other.

- The Kalshi (read-only API key) and Polymarket (public wallet) connectors are **built and switched off**. A database guard keeps them off until a live ten-stage smoke test passes and the platform's terms review is cleared.
- **Sportsbook sync:** the SharpSports BetSync adapter (class C, an aggregator) was built and is **retired** (2026-10-14, cost). **Juice Reel** (class B, the reader's own Juice Reel account by OAuth 2.0) is built into the same seam and **awaiting Juice Reel's approval** of EdgeDesk's application: switched on with `SPORTSBOOK_SYNC_PROVIDER=juicereel`, readers see "Awaiting provider approval" until Juice Reel approves, a PRODUCTION smoke test passes and the terms review is cleared. Until then sportsbooks come in by CSV import, an on-device **bet slip screenshot**, or manual entry. See [`juicereel.md`](juicereel.md) and [`sportsbook-sync-providers.md`](sportsbook-sync-providers.md).
- How each one works, what was verified and how, and the switch-on procedure: [`platform-connections.md`](platform-connections.md).

Nothing here is marked supported until it works end to end. The *Candidate method* column is research, not a capability.

**How a platform can be reached** (classified before any code is written):

- **A** — official API
- **B** — authorized OAuth / account connection
- **C** — approved third-party aggregator
- **D** — user-supplied API credential
- **E** — file / CSV / statement import
- **F** — email / receipt import
- **G** — manual entry only

**Two rules hold everywhere:**

- EdgeDesk never asks for a sportsbook username or password.
- EdgeDesk never reads a platform's website on a reader's behalf, and never works around MFA, CAPTCHAs, geolocation or terms of service.

## The matrix

| Platform | Type | Manual | CSV | Auto sync | Status | Candidate method (unverified until built) | Limitations |
|---|---|---|---|---|---|---|---|
| DraftKings | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | No public customer bet-history API known to us. The `draftkings` profile knows likely column names and status words; it stays marked unverified until a real export has been imported end to end. |
| FanDuel | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same as DraftKings. |
| BetMGM | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| Caesars (`williamhill_us`) | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| bet365 | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| BetRivers | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import / screenshot · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| theScore Bet (formerly ESPN BET; key `espnbet`) | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. The key is kept for continuity with EdgeDesk's captured odds. |
| Fanatics | Sportsbook | ✅ | ✅ profile (unverified) | Built (Juice Reel), **awaiting approval** | Manual / import · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| Hard Rock Bet | Sportsbook | ✅ | ✅ generic | Built (Juice Reel), **awaiting approval** | Manual / CSV · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| Circa Sports, SuperBook, Pinnacle | Sportsbook | ✅ | ✅ generic | Built (Juice Reel), **awaiting approval** | Manual / CSV · Juice Reel once approved | **B** — Juice Reel OAuth, else E/G | Same. |
| Novig, ProphetX | Sportsbook (exchange) | ✅ | ✅ generic | Built (Juice Reel), **awaiting approval** | Manual / CSV · Juice Reel once approved | **B** — Juice Reel OAuth (books Juice Reel tracks) | Exchange commission is entered as fees. |
| Any other book ("Other…") | Either | ✅ | ✅ generic | Juice Reel, if Juice Reel tracks it (awaiting approval) | Manual / CSV | — | Stored under the reader's own name as `custom_<name>`. |
| **Kalshi** | Prediction market | ✅ | ✅ `kalshi_csv` profile (cents detected) | Built, **off** | Manual / import · connector awaiting smoke test + terms review | **D** — the reader's own read-only API key | See below. |
| **Polymarket** | Prediction market | ✅ | ✅ `polymarket_csv` profile | Built, **off** | Manual / import · connector awaiting smoke test + terms review | **A** — public data API by wallet address | See below. |
| DraftKings Predictions | Prediction market | ✅ | ✅ generic | ❌ | Manual / CSV | To research | No public account API known to us. |
| FanDuel Predicts | Prediction market | ✅ | ✅ generic | ❌ | Manual / CSV | To research | No public account API known to us. |

**What "CSV ✅ generic" means.** The generic importers read any CSV with recognisable columns: date, platform, event, selection, odds, stake and result for bets; date, market, side, buy/sell, contracts and price for trades. The reader can re-map any column. A platform-specific importer — fixed aliases, the operator's own ids, its status words — is added only once a real export from that platform has been seen.

## Notes on the candidates

### Kalshi — built, switched off

The connector (`kalshi_v1`) is built and tested against recorded responses; see [`platform-connections.md`](platform-connections.md). What it rests on:

- **An official REST trading API.** A user creates their own API key (a key id plus an RSA private key) in their Kalshi account.
- **Signed requests.** Each request is signed with RSA-PSS and carries `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE` and `KALSHI-ACCESS-TIMESTAMP` headers.
- **Portfolio endpoints** for positions, fills and settlements.

These details were taken from Kalshi's own published API client source on 2026-10-04, because docs.kalshi.com was unreachable from the build environment (blocked at its egress proxy). They are to be re-verified against docs.kalshi.com before the connector is switched on:

- the base URL;
- the signing string;
- pagination;
- rate limits;
- the terms for third-party use of a user's key.

**Fit:** a fill-based API maps one-to-one onto `portfolio_transactions`. Kalshi quotes prices in cents, and a NO position maps to `side = 'NO'`.

### Polymarket — built, switched off

- **A public Data API** (data-api.polymarket.com) returns a wallet's positions, trades and activity by wallet address, with no credential.
- **The reader supplies a public wallet address only.** Nothing secret is involved, and a pasted seed phrase or private key is refused. The address is still treated as the reader's data, because it links an on-chain identity.
- The connector (`polymarket_v1`) reads `/v2/activity` and `/v2/positions`, and resolves the proxy wallet through the gamma public profile.
- **Polymarket's US app** (the regulated exchange) may expose accounts differently. To verify before building.
- Endpoint paths and response fields were taken from Polymarket's published client source. They are to be re-verified against docs.polymarket.com, which was also unreachable from the build environment, before the connector is switched on.

### Sportsbooks — no sync provider active (SharpSports BetSync retired)

We know of no traditional sportsbook that publishes a customer-authorized bet-history API.

The route is a **sportsbook-linking aggregator**, class **C**. **SharpSports BetSync** is built ([`sharpsports-betsync.md`](sharpsports-betsync.md)):

- The reader links their book on SharpSports' own page. EdgeDesk never sees, asks for or stores a sportsbook password.
- EdgeDesk reads SharpSports server-side, read-only.

**Retired 2026-10-14** ([`sportsbook-sync-providers.md`](sportsbook-sync-providers.md)): its plan starts at $500/month. It is switched off on every server, and the page names no provider. Had it continued, it would have run in sandbox for operators only until three things were true:

- a commercial agreement and live plan exist;
- the review of how SharpSports obtains each book's data is cleared;
- a PRODUCTION ten-stage smoke test has passed.

The page says **Import**, never **Connect**, for every sportsbook, to every reader, and offers a bet slip screenshot beside the CSV import. A future provider would offer Connect only where it is switched on. Books needing SharpSports' mobile SDK cannot be linked on the web. Books SharpSports does not list stay file import and manual.

## Changing this table

A row moves to **Auto sync ✅** only when its connector:

1. is in `REGISTRY` in `lib/edgedesk_portfolio_connect_core.js`, implements the 13-method adapter contract, and is read-only;
2. passes recorded-fixture tests for connect, initial sync, incremental sync, deduplication, a settlement update, an expired or revoked credential, disconnect and reconnect;
3. has passed the live ten-stage smoke test (`tools/portfolio/connector_smoke.js`) for its exact connector version, and its terms review is cleared;
4. is switched on in `public.portfolio_platform_registry`. The database refuses the switch without points 3 and 4.

Update this page in the same pull request.
