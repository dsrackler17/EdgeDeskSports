# Juice Reel — sportsbook history through Juice Reel's OAuth API

**Status (2026-10-22): built, tested and deployed (2026-10-14). NOT yet run against Juice Reel.**

- **Production, as the 2026-10-14 deploy's health check reported it:** `portfolio_juicereel.sql` applied and `portfolio_connect` deployed; `JUICE_REEL_CLIENT_ID` and `JUICE_REEL_CLIENT_SECRET` **set**; `SPORTSBOOK_SYNC_PROVIDER` **not set** (no Juice Reel panel at all); `PORTFOLIO_CREDENTIAL_KEYS` **not set** (`credential_keys: 0`, so no token could be sealed: connecting would fail as not configured). § 0 fills in both.
- **Juice Reel replied on 2026-10-20** with a link to its quick-start (juicereel.com/api-docs/quick-start). The reply does not say in writing whether the application is approved, or answer the question about fees for commercial use. The docs it points to are the same reference this was built from, plus one addition used now: **owner access** (§ 10).
- **Whether Juice Reel has approved EdgeDesk's application can now be checked directly:** `jr_check` asks Juice Reel's `/oauth2/me` with the application's own client id and secret (owner access). Accepted = the id, the secret and the approval are in order. Run it from **Actions → Juice Reel setup → check** (§ 0).
- Juice Reel is a **sportsbook sync provider** in the connector core's provider registry (`docs/sportsbook-sync-providers.md`). It runs only where `SPORTSBOOK_SYNC_PROVIDER=juicereel` is set; unset, the server has no sportsbook sync at all (the default since SharpSports was retired).
- Reader linking is **off**. The registry row `juicereel` stays off until Juice Reel approves the application *and* EdgeDesk's commercial use, a ten-stage PRODUCTION smoke test passes, and the terms review is cleared (§ 9). Until then readers see **Awaiting provider approval**; only an operator running that smoke test can connect.
- Every part runs here against a real PostgreSQL and in Chromium, against a fake Juice Reel that enforces the documented contract (§ 11). **The fake is not Juice Reel.** Nothing here may be called "working in production" until a real authorization and a real bet-history sync have succeeded (§ 9, stages CONNECT and IMPORT).
- **SharpSports is retired** for production on cost (§ 12).
- An adversarial review of this change found nine defects, mostly in sync and token edge cases. All nine are fixed or answered in § 14.

---

## 0. Go live — the short path (no terminal)

1. **Deploy this build.** Actions → **Deploy Portfolio schema**, `deploy_function` ticked. (It carries `jr_check` and the setup checklist.)
2. **Check and finish the setup.** Actions → **Juice Reel setup** (`.github/workflows/juicereel-setup.yml`):
   - `check` — read-only. Which Juice Reel secrets the function sees, **by name**, and whether **Juice Reel accepts EdgeDesk's client id and secret**. The run's summary shows a table.
   - `setup` — `check`, plus it fills in what is **absent** in Supabase's Edge Function secrets, and never overwrites one that exists: `SPORTSBOOK_SYNC_PROVIDER=juicereel`, and a fresh `PORTFOLIO_CREDENTIAL_KEYS` (version 1). The key is generated on the runner, sent only to Supabase, never printed and never stored in GitHub. Readers then see **Awaiting provider approval**.
   - `start_live_test` — `setup`, then starts the PRODUCTION live test (§ 9), unless one is running. It refuses if Juice Reel refused the credentials.
3. **Connect your own Juice Reel.** Signed in to EdgeDesk as an operator (admin): **Portfolio → Accounts → Juice Reel → Connect Juice Reel**. Sign in on Juice Reel and allow open and settled bets. You come back connected: each sportsbook Juice Reel tracks becomes an account, and your history imports.
4. **Open it to every reader** only after the remaining live-test stages and the terms review (§ 9). That stays one SQL statement.

`JUICE_REEL_CLIENT_ID` and `JUICE_REEL_CLIENT_SECRET` come from Juice Reel and are never set by the workflow. If `check` says **not accepted** (`JR_CLIENT_REFUSED`), either the application is not approved yet or the secret in Supabase is not the current one: compare it with the application's page at Juice Reel.


## 1. Register this redirect URI

On the Juice Reel application (Juice Reel → Settings → OAuth applications → EdgeDeskSports), the redirect URI must be **exactly**:

```
https://edgedesksports.com/oauth/juicereel-callback.html
```

- Same scheme, host, path and no trailing slash. Juice Reel compares it character for character.
- It is a static page in this repository (`oauth/juicereel-callback.html`), served with the site (GitHub Pages).
- Register no checkout success or cancel URIs: EdgeDesk does not use Juice Reel checkout.
- **Scopes to have approved:** `bets.open.read` and `bets.settled.read`. EdgeDesk requests nothing else. In particular it does **not** request `subscribers.read`.

`node tools/portfolio/juicereel_smoke.js probe` prints the redirect URI the deployed function actually sends, and checks that the callback page is served there.

## 2. Subscription events: not needed, not deployed

Juice Reel's webhook page offers one bucket, **SUBSCRIPTION_EVENTS**: `SUBSCRIPTION_PURCHASED`, `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_CANCELLED` and `SUBSCRIPTION_EXPIRED`, signed with `X-Juice-Reel-Signature: sha256=<hex>`.

**EdgeDesk does not need them, and no `juicereel-webhook` function was created.**

- **What they report.** These events describe people buying a subscription **from the OAuth application's owner** through Juice Reel: Juice Reel's marketplace, or its hosted checkout (`/checkout/sessions`). The payload says who subscribed to which product, for how long, and the revenue (`subscriberUserId`, `subscriptionProductId`, `revenueCentsUsd`, `expiresDate`).
- **Why that does not apply to EdgeDesk:**
  - EdgeDesk sells its research subscriptions through **Stripe** (`supabase/functions/stripe_webhook`, `create_checkout_session`). It sells nothing through Juice Reel.
  - It never asks Juice Reel whether a reader is subscribed. It does not call `/oauth2/subscribers/current` or `/oauth2/subscribers/status`, and does not request `subscribers.read`.
- **They carry no bet data.** Juice Reel documents no bet-update webhook. Treating a subscription event as a bet update would be wrong. So bets are kept current by **scheduled incremental reads of `/oauth2/bets/changed`** (§ 5).
- **The Stripe billing is unchanged.** Juice Reel warned that applications collecting subscription payments outside Juice Reel may be rejected. EdgeDesk's Stripe billing is untouched by this work, and production stays gated until Juice Reel approves EdgeDesk's commercial use in writing (§ 9).

If EdgeDesk ever sold through Juice Reel, the webhook would be a separate, small piece: verify the HMAC over the raw body, record each `id` once, then reconcile nightly against `/oauth2/subscribers/current`, because Juice Reel does not retry deliveries. None of that exists today, by design.

## 3. Secrets and configuration

Supabase → Edge Functions → Secrets (or `supabase secrets set …`). Never put them in a workflow log, the repository or the browser.

| Secret | Value | Needed |
|---|---|---|
| `JUICE_REEL_CLIENT_ID` | the application's client id (`jr_…`) | yes |
| `JUICE_REEL_CLIENT_SECRET` | its client secret (`jrs_…`); used only in the HTTP Basic header of the token and revoke calls and of the owner check (`jr_check`), from the function | yes |
| `PORTFOLIO_CREDENTIAL_KEYS` | `{"1":"<32 random bytes, base64>"}` (`openssl rand -base64 32`); the AES-256-GCM key the tokens are sealed with. Shared with the other connectors: set it once | yes, if not already set |
| `PORTFOLIO_CREDENTIAL_KEY_VERSION` | `1` (the version new tokens are sealed under; keep old keys while anything is sealed under them) | yes, if not already set |
| `JUICE_REEL_REDIRECT_URI` | optional; defaults to the URI in § 1. Must be `https` (plain `http` only for `127.0.0.1` / `localhost`) | no |
| `SPORTSBOOK_SYNC_PROVIDER` | `juicereel`: makes Juice Reel this server's ONE sportsbook sync provider. Unset (the default), the server has no sportsbook sync: Juice Reel is not offered, and nothing is read from it. Setting it before approval is safe: readers then see **Awaiting provider approval** (§ 4) | yes, to show Juice Reel at all |

The function's health check (`GET /functions/v1/portfolio_connect`) reports `configured.sportsbook_sync.provider` and `configured.juicereel: { active, client_id: true, client_secret: true, redirect_uri, scopes, ready, missing }`. It shows whether the id and secret are present, never their values. `missing` names each setting still needed (for example `SPORTSBOOK_SYNC_PROVIDER=juicereel`, `PORTFOLIO_CREDENTIAL_KEYS …`). An operator whose panel reads "not configured" is told the same names; a reader is not.

`SPORTSBOOK_SYNC_PROVIDER` and the two `PORTFOLIO_CREDENTIAL_*` settings can be filled in by **Actions → Juice Reel setup → setup** (§ 0) instead of by hand.

## 4. What the reader sees (Portfolio → Accounts)

A **Juice Reel** panel near the top of Accounts. It says only what the server reports.

With `SPORTSBOOK_SYNC_PROVIDER` unset there is no panel at all, unless the reader still holds a connection (then **Sync off**, below).

| State | When | Actions |
|---|---|---|
| **Awaiting provider approval** | the registry row is off: every reader, until § 9 is done | Connect is shown disabled; import a file or a bet slip screenshot meanwhile |
| **Not connected** | linking is open, and the reader has no connection | Connect Juice Reel |
| **Connecting** | the consent page is opening, or the return is being checked | — |
| **Connected** | the server's grant is CONNECTED after a real code exchange. Shows "as <Juice Reel name> · last synchronized … · next … · N sportsbooks · N open bets" | Sync now · Disconnect Juice Reel · Disconnect and delete synced history |
| **Syncing** | a sync is running, or the first import has not finished | Disconnect |
| **Connection expired** | Juice Reel refused the refresh token: revoked, expired, or the grant ended | Reconnect Juice Reel |
| **Action required** | the grant no longer covers both bet scopes | Reconnect Juice Reel |
| **Sync failing** | five failed syncs in a row (EdgeDesk keeps retrying with backoff) | Sync now · Disconnect |
| **Disconnected** | the reader disconnected. "Your synced history is kept" | Connect Juice Reel |
| **Sync off** | the server's switch is off (`SPORTSBOOK_SYNC_PROVIDER` unset) but the reader still holds a connection: nothing is read, history kept | Disconnect Juice Reel (still revokes it at Juice Reel) |

- **Connected is never shown without a real authorization.** It is shown only when the server's grant is CONNECTED. Only `portfolio_svc_jr_grant_store` sets that, after Juice Reel exchanged a code.
- **Each sportsbook Juice Reel tracks is its own account card** ("Sportsbook · Juice Reel", "Synced through your Juice Reel connection"), with **Sync now**. The connection itself is managed once, in the panel. A book card has no separate Disconnect, because one Juice Reel authorization covers every book.
- **The sportsbook tiles** in setup (one per book, from the provider seam) offer **Connect** while linking is open. Their Connect opens Juice Reel's consent page, the same as the panel's; the wording comes from the provider registry.
- No field asks for a Juice Reel or sportsbook password.
- **Every other tab reads Juice Reel bets like any other synced bet:**
  - **Overview:** P&L, ROI, units (where a unit size was recorded), open exposure, by book.
  - **Calendar** and **Journal**.
  - **Open**, with parlay legs and each leg's state.
  - **History** (filter "Synced").
  - **Analytics:** by sportsbook, sport, bet type, time, singles and parlays, the bankroll trend and drawdown, "What cost you money".

## 5. How it works

```
reader ──Connect──▶ portfolio_connect {jr_start} ── state + PKCE verifier (sealed, 15 min, one use) ──▶ connect_sessions
reader ──────────▶ www.juicereel.com/oauth2/authorize (signs in THERE, approves bets.open.read + bets.settled.read)
Juice Reel ──302──▶ edgedesksports.com/oauth/juicereel-callback.html?code&state
callback page ── code, state → this tab's sessionStorage; URL stripped ──▶ /app.html?juicereel=return#portfolio/accounts
app ──▶ portfolio_connect {jr_callback, state, code} (the reader's own token)
   state: THIS reader's, unused, < 15 min ──▶ POST /oauth2/token (Basic + X-OAuth-Client-Id, code_verifier) ──▶ GET /oauth2/me
   ──▶ pair sealed (AES-256-GCM) into portfolio_private.oauth_grants ──▶ the first sync
pg_cron every 10 min ──▶ portfolio_connect {sweep} ──▶ due grants ──▶ GET /oauth2/bets/changed?updatedAtAfter=<checkpoint − 2 min>
each bet's Site ──▶ the reader's account for that book (AGGREGATOR; a quick-import account upgraded in place)
   ──▶ portfolio_svc_ingest_wagers (the SharpSports-era ingest, unchanged) ──▶ portfolio_positions, settlement history
```

### 5.1 Files

| Piece | Where |
|---|---|
| The adapter: PKCE, the consent URL, token exchange / refresh / revoke, the lease-based rotation, paging, the Bet normalizer, the grant-level sync, reconciliation, disconnect | `lib/edgedesk_portfolio_connect_core.js` § 12 (inlined into the function by `tools/portfolio/inline_connect_core.js`) |
| Its provider registration: `link`, `discover`, `sync`, `refresh`, `accountState`, `webhookRefs`, `normalize`, plus `sweep`; `grant_level` (one authorization syncs, sweeps and disconnects as a whole) | the same file, § 11 (`defineSportsbookProvider`) |
| Reader actions and the scheduler | `supabase/functions/portfolio_connect/index.ts`: the seam's `sb_status`, `sb_books`, `sb_link`, `sb_discover`, `sb_refresh` (its `SPORTSBOOK_HANDLERS.juicereel` row), and Juice Reel's own `jr_status`, `jr_start`, `jr_callback`, `jr_sync`, `jr_disconnect`. `sync`, `disconnect` and `sweep` serve Juice Reel books too |
| The owner credential check | `jr_check` (an operator or the service role only) → `K.jrOwnerCheck`: one `GET /oauth2/me` with the client id and secret. It answers accepted or refused, Juice Reel's HTTP status, the owner's display name and the setup checklist. Nothing is stored and no bet is read |
| Setup without a terminal | `.github/workflows/juicereel-setup.yml` (§ 0) |
| The redirect page | `oauth/juicereel-callback.html` |
| Schema and service functions | `supabase/portfolio_juicereel.sql` (+ `portfolio_decision.sql`: "delete everything" removes the grant) |
| The page | `lib/edgedesk_portfolio_ui.js` (`juicereelPanel`, `jrConnect`, `jrReturnFlow`) |
| Live checks | `tools/portfolio/juicereel_smoke.js` (`probe` also runs `jr_check`) |
| Tests | `tools/portfolio/juicereel.test.js`, `juicereel_ui.e2e.js`, `_fake_juicereel.js` |

### 5.2 OAuth

- **`jr_start`** makes `state` and the PKCE `verifier` on the server (32 random bytes each, base64url), and the S256 `code_challenge`.
  - The database keeps only `SHA-256(state)`. The verifier (with the smoke test id, if any) is sealed with the vault key, bound to the reader and that state hash, in `portfolio_private.connect_sessions` for 15 minutes.
  - The browser gets Juice Reel's consent URL: `client_id`, the exact `redirect_uri`, `response_type=code`, `response_mode=query`, `scope=bets.open.read bets.settled.read`, `state`, `code_challenge`, `code_challenge_method=S256`.
  - The page navigates only to a URL beginning `https://www.juicereel.com/oauth2/authorize?`.
- **The callback page** reads `code` and `state` and removes them from the address bar and history *before* anything else. It hands them to the app through this tab's `sessionStorage`, never another URL, and replaces itself with Accounts.
  - It loads no third-party resource, sends no referrer, and runs under a `default-src 'none'` CSP.
  - A refusal is handed over as a refusal: `error=…`, or `status=cancelled` (the form Juice Reel's checkout documents).
- **`jr_callback`** runs under the reader's own Supabase token. `portfolio_svc_session_consume` releases the session only to **the same reader who started it**, only once, and only within 15 minutes.
  - **This stops login CSRF.** An attacker's state completed in a victim's browser is refused, and the victim's session is not used up.
  - Then the code is exchanged, server-side, with the verifier.
  - **Both bet scopes must be granted.** If not, the tokens Juice Reel just issued are revoked at once and nothing is stored.
  - `GET /oauth2/me` gives the stable Juice Reel user id. One Juice Reel account can belong to one EdgeDesk reader at a time (`JR_ACCOUNT_IN_USE`; the new tokens are revoked).
- **Failures, each said plainly with nothing stored:**

  | Code | Cause |
  |---|---|
  | `JR_STATE_INVALID` | expired, used, another reader's, or unknown |
  | `JR_CONSENT_DENIED` | the reader refused |
  | `JR_CODE_INVALID` | `invalid_grant`: the code expired or was used, or PKCE failed |
  | `JR_CLIENT_REFUSED` | `invalid_client`: the application is not approved yet, or the secret is wrong |
  | `JR_SCOPE_MISSING` | a bet scope was not granted |
  | `PLATFORM_DOWN` / `RATE_LIMITED` | Juice Reel unreachable or limiting |

### 5.3 Tokens

- **Sealed.** The access/refresh pair is sealed with AES-256-GCM (associated data binds it to the reader and the grant) and stored as `bytea` in `portfolio_private.oauth_grants`.
  - That schema is not served by PostgREST. RLS is on with no policy, and no client role has a grant. Only the service role reaches it, through `portfolio_svc_jr_*`.
  - The report's row 2 checks that every text column is one no token is ever written to.
- **Refreshed under a lease.** An access token is used until two minutes before its `expires_in` (3600 s).
  - Then it is refreshed under a **lease**: one statement hands it to a single worker, for the token generation it read.
  - That worker sends the single-use refresh token. Its new pair replaces the old in one statement (`portfolio_svc_jr_rotate`), and only for the lease holder, only from that generation, only while the grant is connected.
  - Every other worker waits for the new generation.
  - **Tested:** four syncs racing on an expired token produce one refresh, one new token and no reuse.
- **Token request edge cases:**
  - A refresh that finishes after the reader disconnected is not stored, and the new pair is revoked at once.
  - A token request is never retried inside the request. A refresh that reached Juice Reel may already have consumed its token.
  - **An unanswered refresh** (a timeout, a 5xx, a body that stalls — bounded at 15 s — or cannot be read) releases the lease, and a later sync sends the same refresh token again **on purpose**. If Juice Reel never used it, that refresh succeeds. If it did, Juice Reel revokes the whole token family — the pair EdgeDesk never received included — and the reader is asked to reconnect. Either way, no live pair is left that nobody holds.
  - **The new pair is stored, or revoked.** A database error while storing it is retried twice. An answer lost after the rotation committed is recognised by comparing what is stored. If it still cannot be stored, the new pair is revoked at once and the grant reads Connection expired.
  - A 401 on a resource refreshes once and retries once. A second 401 means the grant is gone.
  - A refusal of an older pair (a reconnect stored a newer one meanwhile) changes nothing (`portfolio_svc_jr_grant_failed` checks the generation).
- **When Juice Reel refuses the refresh** (`invalid_grant`):
  - the grant reads **Connection expired** (`ACTION_REQUIRED` / `GRANT_EXPIRED`);
  - the dead pair is deleted;
  - every Juice Reel book account says so;
  - nothing retries until the reader reconnects;
  - the history stays.
- **Never logged or returned.** No token, code, verifier or the client secret appears in a log line, a response, the browser or a table. Every log line passes through `redact`, which also masks `jr*_…` token shapes and `Basic`/`Bearer` credentials. The suites search every log line, response and table for each issued token.

### 5.4 Sync

**One sync per grant**, under a five-minute sync lease, covers every book.

- **Initial import.** `GET /oauth2/bets/open`, then `GET /oauth2/bets/settled` with no date filter (all available history), each followed to its end through the opaque `nextCursor`, which is never decoded or edited.
  - If time runs out, the sync stops where it is, keeps Juice Reel's cursor in the grant's checkpoint and runs again a minute later.
  - A stored cursor Juice Reel rejects (`400 cursor is invalid`) restarts that list from its start. The ingest is idempotent, so nothing is duplicated.
  - The checkpoint becomes the moment the import began, less two minutes, so a bet changed while it ran is read again.
- **Incremental.** A **pass** over `GET /oauth2/bets/changed?updatedAtAfter=<checkpoint − 2 min>`, which includes open, closed and cancelled bets, by `updatedAt` descending.
  - A pass too long for one run is **resumed** by the next from its saved cursor (and the same `updatedAtAfter`), so a large backlog always finishes.
  - The checkpoint advances to the newest `updatedAt` **of the changed feed's own bets** (never the reconciliation's), and only once the pass was read to its end.
  - Re-reading the overlap is harmless.
- **Nothing moves past a bet that was not stored:**
  - **Cut short** (a 429, a 5xx after the retries, a refused cursor): the pages already read are stored, the cursor is kept, and the grant backs off like any failure. A refused cursor restarts that list or pass from its start.
  - **A book whose run is still open** (another sync, or one that died: runs go stale after 15 minutes) is reported as `BOOK_BUSY`, and the whole sync keeps its old cursor and checkpoint, so the next run reads the same changes again.
- **Reconciliation, once a day** (or Sync now with `reconcile`):
  - Every bet EdgeDesk holds as open is compared with Juice Reel's own open list.
  - A bet open here but not there was settled, cancelled or deleted at Juice Reel. Its settled list is read back to the oldest such bet's placement (`dateClosedAfter`, ISO 8601), and what it finds is applied.
  - A bet still not found is reported (`NOT_AT_JUICE_REEL`), never changed or removed on a guess — and only after the settled list was read to its end. A reconciliation cut short applies what it found, reports nothing missing, and runs again next time.
  - Only this Juice Reel account's open bets are compared. A bet from a Juice Reel account the reader connected before (another Juice Reel user) is left alone.
- **Books.** Each bet's `Site.name` maps to EdgeDesk's book key, using the same table SharpSports used: DraftKings, FanDuel, BetMGM, Caesars, bet365, BetRivers, theScore Bet, Fanatics, Hard Rock, Circa, SuperBook, Pinnacle, Novig, ProphetX.
  - Any other book keeps its own name as `custom_<name>`. A bet with no book named goes to "Juice Reel (no sportsbook named)".
  - The account is `platform_accounts` (`AGGREGATOR`, `AUTHORIZED_API`, tier 1, `external_account_id = juicereel:site:id:<Site.id>`).
  - The reader's quick-import or manual account for that book is **upgraded in place**.
  - A bet whose book is edited in Juice Reel **moves** to the new book's account (`portfolio_svc_jr_rehome`, 500 bets per call). It stays one position, with its journal kept.
- **The ingest** is `portfolio_svc_ingest_wagers`, unchanged from SharpSports.
  - It upserts by `juicereel:<bet id>`, so the same data twice writes nothing.
  - A newer record replaces the older: corrections, cancellations and late settlements are applied in place, each appended to `portfolio_position_settlements`.
  - A first-seen bet **adopts** the reader's own matching file or manual bet: same book, stake and price, the same line where both have one, placed within 15 minutes, exactly one match each way. The result is one position, with notes and journal kept. This includes a bet imported from the book's own file **with** the book's bet id (`portfolio_aggregator.sql`; before this change only id-less bets were adopted, so connecting after a file import counted those bets twice).
  - Notes, the journal and attribution are never touched.
- **Isolation.** A bet whose `userId` is not the grant's Juice Reel user is never stored.
- **Schedule:**
  - pg_cron pokes `sweep` every 10 minutes (`portfolio_sync_cron.sql`, unchanged).
  - A grant is due 20 minutes after a successful sync while the reader has open bets, 60 minutes otherwise, and one minute while an import is part-way.
  - **Failures back off** 5 min × 2^(n−1), capped at 6 h, plus 5 minutes on a 429 (Juice Reel's buckets are five minutes). The grant reads ERROR after five failures in a row.
  - Idempotent GETs are retried twice with backoff on a network error or 5xx, as the docs advise.
  - Sync now is at most once every two minutes.
- **Rate limits:** 1,000 requests per IP and 25,000 per client id per five minutes.
  - At these cadences, one reader costs a handful of requests per sync. The initial import costs one request per page.
  - The per-IP bucket is shared by everything leaving Supabase's edge, so watch `RATE_LIMITED` in the operator panel as readers grow.

### 5.5 Money

Every stored figure is derived by the existing `portfolio_positions_derive` trigger. Nothing in Portfolio's calculations changed.

- **Stake:** `amountRisked`, in `currencyCode`.
  - Portfolio stores whole cents, so a sub-cent amount is rounded **up** to the cent. The docs' own example risks 0.5886, which is stored as 0.59.
  - Payout is `stake + netResult`, so **the stored P&L equals Juice Reel's `netResult` exactly**. The example stores −0.5886. Tested to the cent against the database.
- **Price:** `oddsAmerican`. If absent, `1 + toWin / amountRisked`, exactly.
- **Results:**

  | Juice Reel result | Stored as | Payout |
  |---|---|---|
  | Won | WON | stake + net |
  | Lost | LOST | stake + net |
  | Push | PUSH | the stake |
  | Cancelled | VOID | the stake |
  | Half Won / Half Lost | WON / LOST | the book's payout |
  | Cashed Out | CASHED_OUT | requires `netResult` |
  | open, pending | OPEN | — |
  | any other word, with `netResult` | SETTLED | exactly that P&L |

  Without `netResult`, a win, loss, push or void is derived from the price, as for any bet.
- **Listed, never guessed:** a bet without its stake, placement time, settlement time or price; an unknown result without a `netResult`; a cash-out without its amount; a loss larger than the stake; a non-USD bet (Portfolio keeps one currency and never converts).
  - `adjustedRisk` differing from `amountRisked` is stored as reported and flagged for the reader's review.
  - A live bet whose reported close precedes its placement settles at its placement.
- **Bet types:**
  - **Parlays** keep their legs (up to 30) in EdgeDesk's leg shape: selection, event, market, line, odds, and each leg's own result.
  - Same-game parlays, teasers and round robins are typed as SharpSports' were.
  - Sport and league come from each Subbet's `League` / `Sport`.

## 6. The database (`supabase/portfolio_juicereel.sql`)

Additive and idempotent. It changes no existing table and adds the registry row. It ends in an 8-row report.

| Object | What it is |
|---|---|
| `portfolio_platform_registry('juicereel')` | `SPORTSBOOK`, `AUTHORIZED_API`, `juicereel_v1`, **off**. A re-run never touches the switch |
| `portfolio_private.oauth_grants` | one per reader, provider and environment. Holds the sealed pair, token generation, refresh lease, sync lease, checkpoint, schedule, last error and last issues. Unique Juice Reel user per environment while connected. Cascades from `auth.users` |
| `portfolio_svc_jr_*` | prepare, store, tokens, refresh_lease, rotate, refresh_release, grant_failed, sync_begin, sync_finish, book_account, rehome, open_positions, due, grant_for_user, disconnect, reset_cursor, smoke_current, book_ids. The service role's only, each asserting its caller (report row 5). All are in the `svc` namespace, because `portfolio.sql` and `portfolio_journal.sql` grant every other `portfolio_*` function to readers when re-applied. Tested: re-applying them opens none |
| `portfolio_admin_juicereel_health()` | for operators: grants by state, error codes, synced in 24 h, overdue. Counts only |

Run order: `portfolio.sql` → `portfolio_journal.sql` → `portfolio_connect.sql` → `portfolio_decision.sql` → `portfolio_aggregator.sql` → `portfolio_model_context.sql` → **`portfolio_juicereel.sql`**. That is the Deploy Portfolio schema workflow's order. Paste-sized: `supabase/parts/portfolio_juicereel.part*-of-3.sql`.

## 7. Security model

| Threat | Control |
|---|---|
| Login CSRF / session fixation | The state is consumed only by the EdgeDesk reader who started it (`portfolio_svc_session_consume(p_user, …)`), once, within 15 min. Tested with another reader's session |
| Code interception | PKCE S256; the verifier never leaves the server; the code is single-use and exchanged only server-side with the client secret; the callback page strips it from the URL first, sends no referrer and loads nothing |
| Refresh-token reuse (Juice Reel revokes the whole grant) | The lease plus the atomic rotation; token requests are never retried inside a request; an unanswered refresh is resent once later on purpose (§ 5.3) |
| Token theft | Sealed at rest (AES-256-GCM, AAD-bound); private schema with no client grants; never in a response, log or the browser |
| One reader's data in another's account | State bound to the reader; one Juice Reel account per reader; every bet's `userId` checked; every function keyed to the grant's own reader. Tested with three readers |
| A reader reaching service functions | `svc` namespace, execute for `service_role` only, and each function asserts its caller. Report rows 4 and 5 |
| Secrets in errors | Reader errors are fixed sentences keyed by code; no Juice Reel body is passed through |
| The owner check burning EdgeDesk's rate limit, or leaking | `jr_check` answers only an operator (`portfolio_is_admin`) or a caller presenting the service key, compared in constant time. Anyone else is refused before Juice Reel is asked. It makes one request and never retries. It returns the owner's display name, not their id, and never the client id or secret |
| Public linking before approval | `portfolio_registry_guard` (unchanged) refuses the switch without a PASSED PRODUCTION smoke test of `juicereel_v1` and `tos_review = 'CLEARED'`; until then the function admits only an operator under a running PRODUCTION smoke test, and the scheduler syncs only such grants |
| Disconnect | The ciphertext is deleted first, then both tokens are revoked at Juice Reel (refresh first) — exactly the pair the database cleared, read under its row lock, so a rotation a moment earlier cannot leave a live pair behind. Works with the sportsbook switch off. History is kept unless the reader asks (the existing retention rule). If Juice Reel does not confirm, the reader is told to remove EdgeDesk at Juice Reel too |
| "Delete everything" / account deletion | `portfolio_delete_everything` deletes the grant (the page revokes at Juice Reel first). Deleting the auth user cascades the grant. In that case Juice Reel is not called, so the authorization lapses at Juice Reel on its own terms |

## 8. Deploy — exact steps

To be run by someone with access to the Supabase project. The build environment could not reach `*.supabase.co` or `juicereel.com`, so none of this has been run.

1. **Secrets** (§ 3), including `SPORTSBOOK_SYNC_PROVIDER=juicereel`. Without that one, readers see no Juice Reel at all (the plain "Sync off" of main); with it, they see **Awaiting provider approval** until § 9. (Or **Actions → Juice Reel setup → setup** after step 2: § 0.)
2. **Merge this change**, then **Actions → Deploy Portfolio schema**, with `deploy_function` ticked. It:
   - runs every Portfolio SQL suite, including `juicereel.test.js`, against a throwaway PostgreSQL;
   - applies each file in one transaction, `portfolio_juicereel.sql` last, failing on any `CHECK THIS` (it re-applies `portfolio_aggregator.sql` too, which carries the adoption fix in § 5.4);
   - deploys `portfolio_connect` (`--no-verify-jwt`) and `sharpsports-webhook` (retired: it answers `ignored: sync_off` unless the provider is `sharpsports`), and prints the health, including the active provider and the Juice Reel redirect URI.
3. **The site.** Merging deploys `oauth/juicereel-callback.html` and the page with GitHub Pages (`app.html` loads the Portfolio page at `?v=20261014jr1` and the connector core at `?v=20261022jr2`).
4. **The schedule** is unchanged: `supabase/portfolio_sync_cron.sql` already pokes `sweep` every 10 minutes.
5. **Probe:** **Actions → Juice Reel setup → check**, or `node tools/portfolio/juicereel_smoke.js probe` (with `SB_URL`, `SB_SERVICE_ROLE`). Expect `ready: true`, nothing missing, the redirect URI in § 1, the callback page served there, and **Juice Reel credentials: ACCEPTED**.

Readers then see **Awaiting provider approval**, which is correct until § 9.

## 9. Switching on — only after Juice Reel approves

1. **Juice Reel approves the application**, and EdgeDesk's commercial use in writing (EdgeDesk's own subscriptions are billed through Stripe, outside Juice Reel).
2. **The ten-stage PRODUCTION smoke test**, as an operator with their own real Juice Reel account. `begin` can be **Actions → Juice Reel setup → start_live_test** instead (§ 0); CONNECT is then pressing Connect Juice Reel in the app:

   ```
   node tools/portfolio/juicereel_smoke.js begin
   node tools/portfolio/juicereel_smoke.js stage <id> CONNECT        # connect in the app (Accounts shows the smoke test), then again
   node tools/portfolio/juicereel_smoke.js stage <id> IMPORT
   node tools/portfolio/juicereel_smoke.js stage <id> VERIFY         # compare with Juice Reel, then --confirmed
   node tools/portfolio/juicereel_smoke.js stage <id> INCREMENTAL
   node tools/portfolio/juicereel_smoke.js stage <id> NEW_ACTIVITY   # place a small tracked bet; once in Juice Reel, --synced
   node tools/portfolio/juicereel_smoke.js stage <id> SETTLEMENT     # once a bet has settled
   node tools/portfolio/juicereel_smoke.js stage <id> RECONCILE
   node tools/portfolio/juicereel_smoke.js stage <id> DISCONNECT     # revokes at Juice Reel
   node tools/portfolio/juicereel_smoke.js stage <id> RECONNECT
   node tools/portfolio/juicereel_smoke.js stage <id> NO_DUPLICATES
   node tools/portfolio/juicereel_smoke.js finish <id>
   ```

   **CONNECT and IMPORT are the first real proof** that the OAuth flow and the bet-history sync work. Re-check `JUICEREEL.verified.unverified` (in the core) against what they show: amount precision, result words, `Subbet.value` as the line, and the refusal form.
3. **Clear the terms review** (`JUICEREEL.tos_review`) in writing. `finish` prints the one statement:

   ```sql
   update public.portfolio_platform_registry
      set automatic_enabled = true, enabled_by_smoke_test = '<id>', tos_review = 'CLEARED', enabled_at = now()
    where platform_key = 'juicereel';
   ```

   The database refuses it without that PASSED PRODUCTION test of `juicereel_v1` from the last 30 days. A new connector version switches it off again.
4. In the same change, update this page, `platform-connections.md` and `platform-support.md`.

**Rolling back**, either way, history kept:

- `update public.portfolio_platform_registry set automatic_enabled = false where platform_key = 'juicereel';` — readers see Awaiting provider approval again; linking and scheduled syncs of new grants stop at once (an operator under a running smoke test aside).
- or unset `SPORTSBOOK_SYNC_PROVIDER` — nothing is read from Juice Reel at all; a reader who still holds a connection sees **Sync off** and can disconnect it (revoked at Juice Reel).

## 10. What was verified, and what was not

- **Read on 2026-10-14:**
  - Juice Reel's full developer reference (juicereel.com/api-docs: authorize, token, refresh, revoke, checkout, `/me`, subscribers, the three bet lists with the full Bet example, rate limits, errors, webhooks), as supplied by the account owner. The site itself was unreachable from the build environment.
  - Juice Reel's official example server, `github.com/juiceintegration/oauth-setup-example`.
- **Re-read on 2026-10-22**, after Juice Reel's reply pointed to the quick-start: the same reference, as re-supplied by the account owner. One addition is now used: **owner access.** `/oauth2/me` and the three bet lists also accept HTTP Basic client id:secret plus `X-OAuth-Client-Id`, and then answer for the OAuth application's owner. EdgeDesk uses only `/oauth2/me` that way, to check its credentials (`jr_check`). It never reads bets without a reader's grant, so the operator's own bets arrive through the same OAuth connection as every reader's.
- **Every request** the connector makes is labelled DOCUMENTED in `JUICEREEL.contract`. The facts are listed in `JUICEREEL.verified.facts`.
- **Not confirmed** (`JUICEREEL.verified.unverified`); the smoke test settles these:
  - whether real amounts carry more than two decimals (handled exactly either way: § 5.5);
  - the full set of result and status words;
  - `Subbet.value` as the line for spreads, totals and props;
  - the exact form of a refused authorization;
  - which of `amountRisked` / `adjustedRisk` is the cash at risk when a user adjusted it.

## 11. Tests (what ran, here)

| Suite | What | Result (2026-10-14) |
|---|---|---|
| `tools/portfolio/juicereel.test.js` | The shipped function in a stub Deno, the real migrations, a fake Juice Reel enforcing the contract. Covers: static contract and scope checks (the secret reaches token, revoke and the owner check only, never a bet list); **the owner credential check (2026-10-22):** health naming what is missing (production's 2026-10-14 state reproduced), `jr_check` refused without a token, to a reader and to a near-miss of the service key with Juice Reel not asked, accepted for the service role and an operator with exactly one Basic `GET /oauth2/me`, refused credentials, asked before the provider is switched on, not asked without an id and secret, a 5xx reported and not retried, an operator told which secret is missing and a reader not, and the `probe` end to end; the provider registration (contract, ACTIVE, grant-level, active only where named, the reader-safe account state); the callback page (URL stripped first, refusals, storage blocked); PKCE and the consent URL; the normalizer (the docs' own example to the cent, parlays, pushes, voids, cash-outs, sub-cent, non-USD, another user's bet, adjusted risk, edited books); every UI state, Sync off included, and the sportsbook tiles. Then live: health; the switch (readers, operators, DEMO vs PRODUCTION smoke tests); state hashing and the sealed verifier; CSRF with another reader's session; unknown, malformed, expired, replayed and refused states; PKCE failure; missing scope (tokens revoked); refused client credentials; the initial import across three books with paging, adoption of a file bet and an upgraded quick-import account; analytics over the result; idempotent re-sync; the changed feed (checkpoint, settlement, correction, new book, edited book); refresh on expiry; four racing refreshes giving one refresh; 401 → refresh → retry; 5xx retry; 429 backoff; ERROR after five failures and recovery; **the review's findings:** a file bet carrying the book's own id adopted (not doubled), and a later identical bet never taking over a bet already adopted, BOOK_BUSY keeping the checkpoint, a pass cut short by a 429 storing its first page and resuming from its cursor, the rotation's database call failing before and after its commit, a stale generation's refusal ignored, another Juice Reel account's open bet left out of reconciliation, 1,100 bets at one book imported in full; reconciliation of a missed settlement and of a deleted bet; an interrupted import resuming; a rejected cursor restarting; a cursor reset re-reading without duplicates; a refresh racing a disconnect (revoked); reconnect; an expired grant (no retry storm, reconnect); the registry guard; three readers (isolation, a stray bet, the same Juice Reel account refused); the seam's `sb_status` / `sb_link` / `sb_books`; the switch OFF (nothing offered, linked or synced, the existing connection still shown); disconnect (revoked, history kept; deleted with the switch off and Juice Reel not confirming); delete everything; no secret in any log, response or table; no SharpSports request | **154 passed, 0 failed** (2026-10-22) |
| `tools/portfolio/juicereel_ui.e2e.js` | Chromium, 1280 px and 390 px. A reader sees Awaiting provider approval. The operator goes Connect → Juice Reel's page (a stand-in) → the shipped callback page → Connected with the first sync in words; the address is clean and sessionStorage is empty. Then: books as Juice Reel accounts, Open with legs, History, Sync now, Disconnect, a refused consent | **22 passed, 0 failed** |
| Mutation checks | With the rehome chunking and the BOOK_BUSY rule undone, exactly the two tests written for them fail; with the adoption guard (below) removed, exactly its test fails | as expected |
| The existing Portfolio suites | calc 106, import 114, bet history 108, process 38, UI 101, journal UI 126, connect core 67, decision record 29; SQL: portfolio 187, journal 73, connect 85, connect sync 33, connect function 18, SharpSports 97, bet slip screenshots 22, model context 21, decision 103, bet history 19; Chromium: portfolio UI 133, bet history 31, SharpSports UI 21; navigation 248 (+ 172 in Chromium); research landing 112; landing positioning 466, interaction 203, EV 68; landing in Chromium 249 | all green |

**The fake Juice Reel is not Juice Reel.** It answers in the documented shapes, so it proves EdgeDesk's side of the wire. The live proof is § 9.

## 12. SharpSports — retired

SharpSports costs at least $500 a month, which is not appropriate for EdgeDesk now. Its retirement landed on main separately (`docs/sportsbook-sync-providers.md`); this change builds on it and changes nothing about it.

- **Off by default.** No sportsbook sync provider runs unless `SPORTSBOOK_SYNC_PROVIDER` names one. With `juicereel` named, SharpSports stays off: its keys reach nothing and no SharpSports request is made (tested).
- **The webhook** (`sharpsports-webhook`) answers every POST `200 {ignored: 'sync_off'}` unless the provider is `sharpsports`.
- **Kept:** the registry row stays off; the adapter stays registered (RETIRED); the records, the aggregator schema (which Juice Reel reuses) and the code are kept.
- **For an operator to do in the SharpSports dashboard:** delete the five webhook subscriptions (they still post to `/functions/v1/sharpsports-webhook`), and leave no linked bettor account with `access=true` (billable in live mode). Nothing was subscribed or billed by this work.

## 13. Known limitations

- **Not live** until § 9. Juice Reel's documentation was supplied by the account owner. The live smoke test is the check that it matches production.
- **A deleted Juice Reel bet** is reported, not removed: Juice Reel lists no deletions.
- **History depth** is whatever Juice Reel holds for the reader (its "all available" history).
- **One currency.** Non-USD bets are listed, not stored, because Portfolio never converts amounts.
- **Free bets and site credit:** Juice Reel documents no bonus flag. A bet with no cash stake is not stored, and a promotional bet with a stake is stored as cash risk.
- **Market type** comes from `subbetType`: Moneyline, Spread, Total, Prop, Future. Anything else is OTHER, with Juice Reel's own word as the market name.
- **Per-IP rate limits** are shared across Supabase's egress (§ 5.4).
- **Account deletion** through Supabase Auth alone (not "delete everything") cannot revoke at Juice Reel. The grant row cascades away, and Juice Reel's authorization lapses on its own terms.
- **A file imported after connecting** is deduplicated against synced bets only by the same bet id. Juice Reel's ids are not the book's, so importing the same book's history file after Juice Reel synced it can add copies. (The other direction — a file first, then Juice Reel — is handled by adoption, § 5.4.) The Accounts page offers no import for a connected book, but the Import tab still accepts one.
- **Reconnecting the same Juice Reel account** replaces the stored pair without revoking the previous one at Juice Reel. Whether revoking it would also end the new authorization (one grant per user and client) is not documented, and revoking would then disconnect the reader. The old pair is no longer held anywhere: EdgeDesk's copy is overwritten. To be settled in the smoke test (stage RECONNECT).

## 14. The adversarial review

An independent review traced the code and ran probes against the shipped function over the real migrations. It found nine defects; five were confirmed by probe.

| # | Finding | What was done |
|---|---|---|
| 1 | More than 1,000 bets at one book in one run: `portfolio_svc_jr_rehome` refused the call, so a heavy bettor could never import | **Fixed:** chunks of 500. Tested with 1,100 |
| 2 | A busy book (`BOOK_BUSY`) was skipped while the checkpoint moved past its bets: silent loss | **Fixed:** the whole sync keeps its old cursor and checkpoint; the next run reads the same again. Tested; the test fails without the fix |
| 3 | `/bets/changed` had no resume cursor, so a backlog longer than one run never finished; a 429 / 5xx part-way threw away the pages already read | **Fixed:** resumable passes; a run cut short stores what it read and keeps its place (the failure path now saves the cursor). Tested |
| 4 | A bet imported from the book's file WITH the book's bet id was not adopted, so connecting Juice Reel doubled it (P&L counted twice) | **Fixed** in the shared ingest (`portfolio_aggregator.sql`): such bets are adopted too — but never one already adopted (its id is then in a provider's namespace, `juicereel:…` / `sharpsports:…`), so a second identical bet cannot take it over. Both tested. The reverse direction is a known limitation (§ 13) |
| 5 | An unanswered refresh resends a refresh token Juice Reel may have used; a failed rotate RPC lost the new pair; a stalled body read was unbounded | **Fixed:** the rotate call is retried and a commit whose answer was lost is recognised; if the pair still cannot be stored it is revoked; the body read is bounded at 15 s. **The resend is kept on purpose** (§ 5.3): it either succeeds or makes Juice Reel revoke the family, which also kills the pair EdgeDesk never received, so no live pair is left orphaned |
| 6 | Disconnect read the pair before clearing it, so a rotation in between left a live pair unrevoked; a same-account reconnect does not revoke the old pair | **Fixed:** the disconnect function returns the pair it cleared, read under the row lock, and that pair is revoked. The reconnect case is **kept** for now and listed in § 13 (revoking could end the reader's new authorization) |
| 7 | Reconciliation called bets missing after a settled read cut short, and compared bets of a previously connected, different Juice Reel account | **Fixed:** a partial read reports nothing missing and runs again; only this Juice Reel user's open bets are compared. Tested |
| 8 | The checkpoint was taken from every bet read, reconciliation's included | **Fixed:** only the changed feed's own bets move it |
| 9 | A stale refresh's `invalid_grant` could wipe a fresh reconnect | **Fixed:** `portfolio_svc_jr_grant_failed` acts only for the generation that was refused. Tested |

