# Portfolio — platform connections

**As of 2026-10-05, no platform connects automatically in production.**

- The Kalshi and Polymarket connectors are built and tested against recorded responses.
- Both are **switched off**. A database guard keeps them off until a live smoke test has passed (below).
- Sportsbooks have no automatic method at all. They are imported from a file the reader downloads, or recorded by hand.

This page is the source of truth for **how** each platform's history reaches EdgeDesk, what was verified and how, and what must happen before anything is switched on. `docs/platform-support.md` is the short matrix.

## The pipeline

```
SOURCE → ADAPTER → NORMALIZER → accounts / positions / transactions → reconciliation → Portfolio → P&L → Calendar → Journal → Process Coach → Film Room
```

| Piece | Where |
|---|---|
| The registry (what each platform supports, and how it was verified) | `REGISTRY` in `lib/edgedesk_portfolio_connect_core.js` |
| The runtime switch | `public.portfolio_platform_registry` |
| The adapter contract (13 methods) | `CONTRACT` / `defineAdapter` in the core |
| The Kalshi and Polymarket adapters and normalizers | the core |
| The server function (connect, sync, disconnect, scheduler sweep) | `supabase/functions/portfolio_connect/index.ts`, with the core inlined between markers |
| Service-only SQL (ingest, runs, credentials, smoke tests) | `supabase/portfolio_connect.sql` |
| The schedule (every 10 minutes) | `supabase/portfolio_sync_cron.sql` |
| The file importers (sportsbooks; Kalshi and Polymarket CSV) | `lib/edgedesk_portfolio_import.js` |

Every source ends in the same normalized rows, stored through the same tables, the same derive trigger and the same P&L rules. The page never branches on where a position came from.

## Source type is not ingestion method

- **`platform_type`** says what the platform *is*: `SPORTSBOOK` or `PREDICTION_MARKET`.
- **`ingestion_method`** says how its history *arrives*: `API_KEY`, `PUBLIC_WALLET`, `OAUTH`, `AUTHORIZED_API`, `FILE_IMPORT` or `MANUAL`.
- **`connection_tier`** is the same fact as a tier:

| Tier | Meaning |
|---|---|
| 1 | Authorized connection (OAuth / partner API) |
| 2 | Assisted automatic (a read-only key, or a public wallet) |
| 3 | Easy import (a file) |
| 4 | Manual |

A quick-import account is **upgraded in place** when the reader later connects the same platform automatically: same account, same history (`portfolio_svc_account_connect`).

## Per platform

| Platform | Type | Automatic method | Built | Switched on | Import profile | Verified how |
|---|---|---|---|---|---|---|
| **Kalshi** | Prediction market | `API_KEY` (read-only), tier 2 | ✅ `kalshi_v1` | ❌ awaiting smoke test + terms review | `kalshi_csv` (unverified) | Published API client source, trade-api v2, 2026-10-04 |
| **Polymarket** | Prediction market | `PUBLIC_WALLET`, tier 2 | ✅ `polymarket_v1` | ❌ awaiting smoke test + terms review | `polymarket_csv` (unverified) | Published client source (data API v2, gamma public profile), 2026-10-04 |
| DraftKings | Sportsbook | none | — | — | `draftkings` (unverified) | — |
| FanDuel | Sportsbook | none | — | — | `fanduel` (unverified) | — |
| BetMGM | Sportsbook | none | — | — | `betmgm` (unverified) | — |
| Caesars (`williamhill_us`) | Sportsbook | none | — | — | `caesars` (unverified) | — |
| bet365 | Sportsbook | none | — | — | `bet365` (unverified) | — |
| BetRivers, Fanatics, theScore Bet (ESPN BET) | Sportsbook | none | — | — | `betrivers`, `fanatics`, `espnbet` (unverified) | — |
| Any other | Either | none | — | — | the generic importers | — |

**What was verified, and what was not.**

- The official documentation sites (docs.kalshi.com, docs.polymarket.com) and Polymarket's data API host were **blocked by the build environment's network policy** (HTTP 403 at the egress proxy).
- The endpoint, signing and field facts were therefore taken from each platform's **own published client source**, not from blog posts or unofficial libraries. They are listed in `REGISTRY[...].automatic.verified.facts`.
- **They must be re-read against the live documentation and terms before production.** That re-read is the first stage of switching a connector on (below).

### Kalshi (tier 2, read-only API key)

**What the reader gives**

- An API key id and its private key, created in their Kalshi account **with read access only**.
- EdgeDesk asks Kalshi for the key's scopes (`GET /api_keys`) and **refuses a key that can trade** (`WRITE_SCOPE`), or whose scopes it cannot read (`SCOPE_UNKNOWN`).

**How the connector works**

- Each request is signed with RSA-PSS SHA-256 (salt 32) or Ed25519, over `timestamp + METHOD + /trade-api/v2/path` with no query string. The signature goes in the `KALSHI-ACCESS-KEY` / `-SIGNATURE` / `-TIMESTAMP` headers. A PKCS#1 key is wrapped to PKCS#8 for WebCrypto.
- Fills page from a cursor of `{ts, ids}` at the boundary, so nothing at the boundary is dropped or repeated. Fills before `/historical/cutoff` are read from `/historical/fills`.
- Settlements: yes, no, scalar (`value` in cents) and void.
- **Reconciliation:** after each sync, the account's net holdings are compared with `/portfolio/positions` (`position_fp`). A market that disagrees is re-read in full on the next run and rebuilt (`replace_prefixes`). That is the self-healing sync.

**Disconnect** deletes EdgeDesk's encrypted copy of the key. The reader is told to delete the key in Kalshi as well; EdgeDesk cannot revoke it for them.

**Terms review before production:**

- Kalshi's developer / API terms for storing a customer's read-only key on their behalf for portfolio analytics.
- Rate limits for a background sync across many customers.
- Whether partner OAuth (registered partners only) should replace customer keys before scale.

### Polymarket (tier 2, public wallet)

**What the reader gives**

- The **public address** of the wallet they trade from. The gamma public profile resolves it to the proxy wallet.
- **Never** a seed phrase, private key or wallet password. The browser and the server both refuse text that looks like one (`SECRET_PASTED`), and the page never sends it anywhere.

**How the connector works**

- Data API `/v2/activity` (TRADE and REDEEM, from the start of the history) and `/v2/positions` by status (OPEN, REDEEMABLE, REDEEMABLE_LOST, CLOSED).
- Entry fees are stored as one FEE transaction per token (`polymarket:entry-fees:<token>`).
- Resolution: REDEEMABLE means the held side won (settles at 1); REDEEMABLE_LOST means the other outcome won (settles at 0); CLOSED with a REDEEM means it won.

**Disconnect:** a public address has nothing to revoke. EdgeDesk stops reading it.

**Optional ownership check.** A non-custodial signature challenge is supported by the schema (`portfolio_private.connect_sessions`, a one-time challenge consumed once by its reader inside 30 minutes). It is **not** required to read public activity, and is not wired into the page.

**Terms review before production:**

- Polymarket's terms for third-party display of a user's public activity.
- Regional availability: a US reader's exchange account may differ from the international wallet product.

### Sportsbooks (tier 3, file import)

**No US sportsbook offers customers an API or authorized connection for their bet history.**

- EdgeDesk never asks for a sportsbook username or password.
- It never reads a sportsbook site on the reader's behalf.
- It never works around MFA, CAPTCHAs, geolocation or terms.

The page says **Import**, never **Connect**, for every sportsbook.

**The flow:** select platform → drop file → review → done.

- **Detection** is never a silent guess. In order: the platform the reader chose, then a platform column (MIXED if the file names several), then the file's name. Otherwise the page **asks**. It shows how it knew ("Detected: DraftKings · 284 wagers found · Aug 2024 – Oct 2026 — platform from the file's name").
- **Profiles** carry each book's likely column names and status words. All are marked `verified: false`, and the review says so (`PROFILE_UNVERIFIED`), until a real export from that book has been imported end to end.
- **Remembered layouts:** a file whose sorted, normalized headers match one the reader imported before is read the same way (`header_signature`).
- **The totals check:** where the file states each bet's profit or payout, its total over won, lost, pushed and voided bets is compared with what the odds and stakes pay. A difference is shown as a warning, never silently reconciled.
- **Review** shows Found / Ready / Duplicates / Need review / Cannot import, an estimated P&L and the date range, with [Import n] and [Review n].
- **Idempotent and incremental.** Re-importing a newer file shows "18 new positions · 7 updated · 241 already in your portfolio — nothing is counted twice" with [Update portfolio]. A bet whose result, payout or fees changed is an UPDATE, applied in place. A bet already stored is never inserted twice.
- Bonus bets (`stake_type`) and parlays (legs grouped by ticket) are read.

## Normalization decisions

**Money is exact.**

- `NUMERIC` in SQL.
- BigInt decimals in the engine.
- Micro-unit fixed point, rounded half away from zero, in the connector core.

**Fills reconstruct positions; nothing invents a bet.** A Kalshi fill that crosses zero is split into a SELL of the held side and a BUY of the new side, with its fee pro-rated.

**How the spec's transaction types map to stored rows:**

| Spec type | Stored as |
|---|---|
| buy, fill, partial_fill | `BUY` (a partial fill is its own row with its own quantity) |
| sell | `SELL` |
| fee | `FEE` |
| settlement | the position's `resolution` / `settlement_price`; a settlement fee is a `FEE` row |
| cashout | `CASHOUT` (sportsbook `CASHED_OUT`) |
| adjustment | `ADJUSTMENT` |
| sportsbook_wager | the position itself (a `BET`) |
| sportsbook_settlement | the position's status and `reported_payout` |

**The same event on two platforms is two positions.** The pre-bet panel shows them together as existing exposure, matched on the event's normalized name.

**Time** is stored in UTC. A file's zone-less times are read in the zone the reader chooses, and the calendar and journal group by the reader's own zone.

**Historical imports carry no invented journal.** Their journal reads "Historical import · No pre-entry journal available.". Their evidence level is RESULT ONLY unless the reader adds context. Process grades use only prices recorded before the event.

## Security controls

**Credentials**

- AES-256-GCM, sealed on the server.
- The AAD binds each ciphertext to `edgedesk-portfolio-credential-v1|user|account|kind`, so a ciphertext moved to another account fails to open.
- The keyring comes from function secrets: `PORTFOLIO_CREDENTIAL_KEYS` (JSON `{ "1": "<base64 32 bytes>" }`) and `PORTFOLIO_CREDENTIAL_KEY_VERSION`. A credential sealed under an older version is re-sealed under the current one the next time it is opened.
- Ciphertext lives in `portfolio_private`, a schema PostgREST does not serve and readers have no grant on.
- The reader sees a hint only (`…608c`, the scopes, when stored).

**What never leaves the server:** a private key, a token or a session. None is ever returned to the browser, put in `localStorage`, written to a log line or included in analytics. Log lines and stored errors go through `redact`.

**Service-only functions.** Every `portfolio_svc_*` function is granted to `service_role` only, and also asserts the caller's role inside. Readers call only `portfolio_disconnect` (their own account) and read their own `portfolio_sync_runs` under RLS (`auth.uid() = user_id`).

**Read-only by construction.**

- `defineAdapter` refuses an adapter that declares `places_orders`.
- No order, transfer or withdrawal endpoint is ever called.
- A Kalshi key that can trade is refused.

**The switch.** `automatic_enabled` can be set only when all of these hold (enforced by `portfolio_registry_guard`):

- a smoke test of the **same connector version** has PASSED all ten stages, in PRODUCTION, within 30 days;
- `tos_review = 'CLEARED'`;
- `enabled_at` is set.

A new connector version switches it off again. While it is off, only an operator running that smoke test can connect.

**Rate limits.** A reader's manual sync is limited to one every two minutes. Scheduled syncs back off 5 minutes × 2^(n−1), capped at 6 hours, plus 10 minutes for RATE_LIMITED. An account reads ERROR after 5 failures in a row, and ACTION_REQUIRED (no retry) when the platform refuses the credential.

## Switching a connector on — the only way

1. **Re-verify the platform.**
   - Read its current API documentation and terms (the hosts above must be reachable).
   - Compare them with `REGISTRY[...].automatic.verified.facts`.
   - Update the facts and `docs_verified_on` if anything differs, and bump `connector_version` if code changes.
2. **Set the keyring** (Kalshi only needs it, but set it once):
   - generate a key with `openssl rand -base64 32`;
   - set `PORTFOLIO_CREDENTIAL_KEYS={"1":"<key>"}` and `PORTFOLIO_CREDENTIAL_KEY_VERSION=1` as function secrets.
3. **Deploy:**
   - apply `supabase/portfolio.sql`, `portfolio_journal.sql` and `portfolio_connect.sql` (*Actions → Deploy Portfolio schema*, or the `supabase/parts/*` files in order);
   - deploy the function with `supabase functions deploy portfolio_connect --no-verify-jwt` (or the workflow's `deploy_function` input);
   - apply `supabase/portfolio_sync_cron.sql` for the schedule.
4. **Run the live smoke test**, with an operator's own real account, against production:

   ```bash
   node tools/portfolio/connector_smoke.js begin kalshi
   node tools/portfolio/connector_smoke.js stage <id> CONNECT
   node tools/portfolio/connector_smoke.js stage <id> IMPORT
   node tools/portfolio/connector_smoke.js stage <id> VERIFY --confirmed   # after comparing P&L with Kalshi's statement
   node tools/portfolio/connector_smoke.js stage <id> INCREMENTAL
   # make a small trade on the platform
   node tools/portfolio/connector_smoke.js stage <id> NEW_ACTIVITY
   # after one of the account's markets settles
   node tools/portfolio/connector_smoke.js stage <id> SETTLEMENT
   node tools/portfolio/connector_smoke.js stage <id> RECONCILE
   node tools/portfolio/connector_smoke.js stage <id> DISCONNECT
   node tools/portfolio/connector_smoke.js stage <id> RECONNECT
   node tools/portfolio/connector_smoke.js stage <id> NO_DUPLICATES
   node tools/portfolio/connector_smoke.js finish <id>
   ```

   A stage passes only after every stage before it. The script never switches anything on.
5. **Clear the terms review** listed above for that platform, in writing.
6. **Switch it on**, with the statement `finish` prints:

   ```sql
   update public.portfolio_platform_registry
      set automatic_enabled = true, enabled_by_smoke_test = '<id>', tos_review = 'CLEARED', enabled_at = now()
    where platform_key = 'kalshi';
   ```

7. **Update this page and `platform-support.md`** in the same change. Only then may the landing page say "Connect supported prediction markets and import sportsbook history".

## Observability

**The operator panel** (Accounts tab, operators only) reads `portfolio_admin_connector_health()` and `portfolio_admin_ttv()`. Counts and rates only, never a reader, credential or position.

Per platform, over the last 24 hours:

- **Syncs:** runs, OK, partial, failed, p95 duration, error codes, last success.
- **What the syncs moved:** records discovered, inserted, updated, duplicates rejected (`transactions_unchanged`), settlements recorded (`positions_settled`; a re-read counts none), rejected, reconciliations and mismatches.
- **Connection attempts:** attempts, connected, failed by code, disconnected (`portfolio_private.connector_events`, written by the function, with no reader column).
- **Imports:** files, imported, failed, not finished, rows that could not be read, and **new layouts**. A new layout is a header signature first seen in the window for a platform imported before with another layout: a likely export-format change.

**Time to value** (last 30 days):

- setups started;
- median minutes to a first position, and to a ready portfolio;
- setup abandonment (7+ days);
- import and connection failure rates.

These come from the funnel events `portfolio_onboarding_started`, `platform_selected`, `connection_started` / `_completed`, `import_started` / `_detected` / `_reviewed` / `_completed`, `first_position_created`, `portfolio_ready` and `first_process_insight_ready`. They are registered in `supabase/funnel.sql` and allow-listed in `lib/edgedesk_track.js`. No event carries a credential, a wallet or an amount.

## What stays off, and why

| Item | Why it is off |
|---|---|
| Kalshi automatic connection | Live smoke test and terms review pending; docs re-read pending |
| Polymarket automatic connection | Same |
| Polymarket signature challenge in the page | Not needed to read public activity; schema ready |
| Every sportsbook "connect" | No authorized method exists |
| Import profiles "verified" | No real export from any book has been imported end to end yet |
| Landing-page connection claims | The landing page keeps "importing and connecting are in development" until the import is deployed and a connector is switched on (pinned by `tools/presentation/landing_positioning.test.js`) |
