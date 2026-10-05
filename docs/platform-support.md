# Portfolio — platform support

**As of 2026-10-05, no platform syncs automatically in production.** Every platform below works through **manual entry** and **file import**, and its positions count exactly like any other.

- The Kalshi (read-only API key) and Polymarket (public wallet) connectors are **built and switched off**. A database guard keeps them off until a live ten-stage smoke test passes and the platform's terms review is cleared.
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
| DraftKings | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | C (aggregator), else E/G | No public customer bet-history API known to us. The `draftkings` profile knows likely column names and status words; it stays marked unverified until a real export has been imported end to end. |
| FanDuel | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | C, else E/G | Same as DraftKings. |
| BetMGM | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | C, else E/G | Same. |
| Caesars (`williamhill_us`) | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | C, else E/G | Same. |
| bet365 | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | E/G | Same. |
| BetRivers | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | C, else E/G | Same. |
| theScore Bet (formerly ESPN BET; key `espnbet`) | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | E/G | Same. The key is kept for continuity with EdgeDesk's captured odds. |
| Fanatics | Sportsbook | ✅ | ✅ profile (unverified) | ❌ | Manual / import | E/G | Same. |
| Hard Rock Bet | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| Circa Sports, SuperBook, Pinnacle | Sportsbook | ✅ | ✅ generic | ❌ | Manual / CSV | E/G | Same. |
| Novig, ProphetX | Sportsbook (exchange) | ✅ | ✅ generic | ❌ | Manual / CSV | To research | Exchange commission is entered as fees. |
| Any other book ("Other…") | Either | ✅ | ✅ generic | ❌ | Manual / CSV | — | Stored under the reader's own name as `custom_<name>`. |
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

### Sportsbooks — no direct path known

We know of no traditional sportsbook that publishes a customer-authorized bet-history API.

The documented commercial route is a **sportsbook-linking aggregator** (for example SharpSports, which offers "BetSync" / "BetLink" account linking to bet-tracking apps). That would be class **C**, and it requires a commercial agreement and a review of how the aggregator obtains its data before EdgeDesk would use it. Until then sportsbooks are manual and file import, and the page says **Import**, never **Connect**, for every one.

## Changing this table

A row moves to **Auto sync ✅** only when its connector:

1. is in `REGISTRY` in `lib/edgedesk_portfolio_connect_core.js`, implements the 13-method adapter contract, and is read-only;
2. passes recorded-fixture tests for connect, initial sync, incremental sync, deduplication, a settlement update, an expired or revoked credential, disconnect and reconnect;
3. has passed the live ten-stage smoke test (`tools/portfolio/connector_smoke.js`) for its exact connector version, and its terms review is cleared;
4. is switched on in `public.portfolio_platform_registry`. The database refuses the switch without points 3 and 4.

Update this page in the same pull request.
