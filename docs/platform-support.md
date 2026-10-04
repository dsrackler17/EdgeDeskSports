# Portfolio — platform support

**As of 2026-10-04 (Phase A), no platform syncs automatically.** Every platform below works through **manual entry** and **CSV import**, and its positions count exactly like any other.

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
| DraftKings | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | C (aggregator), else E/G | No public customer bet-history API known to us. CSV means a file the reader assembles; no DraftKings export format has been verified. |
| FanDuel | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | C, else E/G | Same as DraftKings. |
| BetMGM | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | C, else E/G | Same. |
| Caesars (`williamhill_us`) | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | C, else E/G | Same. |
| bet365 | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| BetRivers | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | C, else E/G | Same. |
| theScore Bet (formerly ESPN BET; key `espnbet`) | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. The key is kept for continuity with EdgeDesk's captured odds. |
| Fanatics | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| Hard Rock Bet | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| Circa Sports, SuperBook, Pinnacle | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| Novig, ProphetX | Sportsbook (exchange) | ✅ | ✅ generic | ❌ | Manual / CSV | To research | Exchange commission is entered as fees. |
| Any other book ("Other…") | Either | ✅ | ✅ generic | ❌ | Manual / CSV | — | Stored under the reader's own name as `custom_<name>`. |
| **Kalshi** | Prediction market | ✅ | ✅ generic (cents detected) | ❌ | Manual / CSV · **Phase B candidate** | **A/D** — official trading API | See below. |
| **Polymarket** | Prediction market | ✅ | ✅ generic | ❌ | Manual / CSV · Phase C candidate | **A** — public data API by wallet address | See below. |
| DraftKings Predictions | Prediction market | ✅ | ✅ generic | ❌ | Manual / CSV | To research | No public account API known to us. |
| FanDuel Predicts | Prediction market | ✅ | ✅ generic | ❌ | Manual / CSV | To research | No public account API known to us. |

**What "CSV ✅ generic" means.** The generic importers read any CSV with recognisable columns: date, platform, event, selection, odds, stake and result for bets; date, market, side, buy/sell, contracts and price for trades. The reader can re-map any column. A platform-specific importer — fixed aliases, the operator's own ids, its status words — is added only once a real export from that platform has been seen.

## Notes on the candidates

### Kalshi — the Phase B connector

This is the best documented integration available:

- **An official REST trading API.** A user creates their own API key (a key id plus an RSA private key) in their Kalshi account.
- **Signed requests.** Each request is signed with RSA-PSS and carries `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE` and `KALSHI-ACCESS-TIMESTAMP` headers.
- **Portfolio endpoints** for positions, fills and settlements.

These details come from public descriptions of the API (Kalshi's API documentation and its published SDKs). They were **not** fetched from Kalshi's own site during Phase A, because that host was unreachable from the build environment. They are to be re-verified against docs.kalshi.com before any code is written:

- the base URL;
- the signing string;
- pagination;
- rate limits;
- the terms for third-party use of a user's key.

**Fit:** a fill-based API maps one-to-one onto `portfolio_transactions`. Kalshi quotes prices in cents, and a NO position maps to `side = 'NO'`.

### Polymarket — Phase C

- **A public Data API** (data-api.polymarket.com) returns a wallet's positions, trades and activity by wallet address, with no credential.
- **The reader would supply their proxy wallet address only.** Nothing secret is involved; it would be stored in the credentials table anyway as `WALLET_ADDRESS`, because an address links an on-chain identity.
- **Polymarket's US app** (the regulated exchange) may expose accounts differently. To verify before building.
- Endpoint paths and response fields are to be verified against docs.polymarket.com, which was also unreachable from the build environment.

### Sportsbooks — no direct path known

We know of no traditional sportsbook that publishes a customer-authorized bet-history API.

The documented commercial route is a **sportsbook-linking aggregator** (for example SharpSports, which offers "BetSync" / "BetLink" account linking to bet-tracking apps). That would be class **C**, and it requires a commercial agreement and a review of how the aggregator obtains its data before EdgeDesk would use it. Until then sportsbooks are manual and CSV.

## Changing this table

A row moves to **Auto sync ✅** only when its connector:

1. is registered in `lib/edgedesk_portfolio_connectors.js` (the contract refuses a credential-bearing connector that would run in the browser);
2. passes recorded-fixture tests for connect, initial sync, incremental sync, deduplication, a settlement update, an expired or revoked credential, disconnect and reconnect;
3. is deployed, and has completed a real sync.

Update this page in the same pull request.
