# SharpSports BetSync — sportsbook history through an approved aggregator

> **RETIRED 2026-10-14.** SharpSports' plan starts at $500/month, above EdgeDesk's budget. It is switched off: no provider is active unless `SPORTSBOOK_SYNC_PROVIDER` names one, and none does. The adapter stays registered (RETIRED) as the reference for the next provider, and anything it synced stays readable. The webhook answers 200 and reads nothing. Why, what was kept, what replaced it (CSV and on-device screenshot import) and the alternatives researched: [`sportsbook-sync-providers.md`](sportsbook-sync-providers.md). The rest of this page describes the adapter as built.

**Status (2026-10-14): built and tested in this repository, in SANDBOX mode only. Not yet deployed, and not yet run against SharpSports' sandbox.**

- Every part runs here against a real PostgreSQL and in Chromium:
  - the schema;
  - the connector;
  - the webhook receiver;
  - the Accounts flow;
  - the analytics.
- Two things could not be done from the build environment:
  - **deploying it**;
  - **running a genuine SharpSports sandbox delivery or link against it.**

  That environment's network policy blocked `*.sharpsports.io` and `*.supabase.co`, and it held no Supabase deploy token and no SharpSports key.
- Those steps are below, in order (§ 5). Nothing here may be called "verified live" until they have been run.

---

## 1. The five HTTP 404s — diagnosis

The five subscriptions (bettor created, bettor account verified, bettor account unverified, refresh response created, bettor account inaccessible) post to:

```
https://iattxbkbufslbauoumga.supabase.co/functions/v1/sharpsports-webhook
```

- **No function by that name existed.** No `sharpsports-webhook` (hyphen or underscore) was in `supabase/functions/`.
  - Supabase answers a function name that is not deployed with **404**.
  - A function deployed *with* JWT verification answers **401**.
  - `supabase/portfolio_sync_cron.sql` already documents both cases.
  - The 404 therefore points to an undeployed function, not to a payload or authentication problem.
- **The fix is `supabase/functions/sharpsports-webhook/index.ts`.**
  - It is named exactly as the registered URL (hyphen), so the URL does not change.
  - Deploy it with `--no-verify-jwt`: SharpSports sends no Supabase JWT. The function authenticates deliveries itself (§ 3.4).
- **Not verified live.** I could not confirm from here that nothing else was deployed under that name. `tools/portfolio/sharpsports_smoke.js probe` checks this after deploy: it prints the GET status and names 404 and 401 for what they mean.

## 2. What the reader sees

All of it is in **Portfolio → Accounts**, in the existing components.

- **Set up → a tile per sportsbook** (DraftKings, FanDuel, BetMGM, Caesars, bet365, BetRivers, Fanatics, theScore Bet, plus any other book SharpSports lists in its `/books`). Each tile says where that book stands: Connect, Import, Connected ✓, or its bet count.
  - Tapping a tile opens **that book's card** under the row: **Connect \<book>** where BetSync is available to the reader, with **Import a file instead**; otherwise **Import \<book> history**. A book not yet added also offers **Add it, no file yet**.
  - A book SharpSports links only through its mobile SDK reads "app only": its card offers the import, and a book EdgeDesk cannot import is a disabled tile.
  - A sportsbook already imported from files offers **Connect automatically** on its account card; the link upgrades that account in place.
- **Connect \<book>** asks EdgeDesk's server for a fresh SharpSports context. The browser then goes to SharpSports' own linking page (`ui.sharpsports.io/link/<cid>`), where the reader confirms the book and their state and signs in.
  - EdgeDesk never shows a username or password field. Chromium checks this.
- **Back on EdgeDesk** (`?betsync=return#portfolio/accounts`), the page asks the server what was linked. The server reads it from SharpSports' API, not from anything in the URL. A **Sportsbook connection** section at the top of Accounts then shows, for example, "DraftKings — verified · first sync succeeded: 3 new bets".
- **A linked book's card** shows:
  - **BetSync (SharpSports)**, with `· sandbox` in sandbox;
  - Connected / Syncing / Action required / Sync failing / Disconnected;
  - what SharpSports reports: verified, access, paused, book, region;
  - last synced;
  - the last book refresh;
  - the sync log;
  - **Refresh from book**, **Sync now**, **Reconnect** (when the link expired), **Disconnect**, and **Disconnect and delete synced history**.
- **Every other tab reads synced bets like any other.** They land in `portfolio_positions` with `source = 'SYNC'`.
  - **Overview**: P&L, ROI, units (only where a unit size was recorded), open exposure, P&L by platform.
  - **Calendar**: by entered, event and settled day.
  - **Journal**: an entry per bet. The sync never touches it.
  - **Open**: pending bets, with each parlay leg and its state.
  - **History**: filters for platform, dates, sport, league, type, result and source, plus search.
  - **Analytics**:
    - every existing breakdown;
    - **by bet type** (single, parlay, same-game, teaser, round robin);
    - **bankroll trend and drawdown** (`portfolio_pnl_path`, server-side);
    - CLV, where a close was recorded.
  - **Import**: unchanged; the fallback for every book.
- **Decision Record → "EdgeDesk's model at the time"** (§ 3.6).
- **Where BetSync is not available to the reader, no Connect appears for a sportsbook:** every sportsbook tile reads Import and its card offers the import ("Sportsbooks · import", "no sportsbook offers customers an API"). In sandbox, BetSync is available to operators only.

## 3. How it works

```
reader ──Connect──▶ portfolio_connect {ss_link} ──POST /v1/context (public key)──▶ SharpSports ─▶ cid
reader ──────────────▶ ui.sharpsports.io/link/<cid> (signs in to the book THERE) ──redirect──▶ app ?betsync=return
app ──▶ portfolio_connect {ss_discover} ──GET bettor's accounts (private key)──▶ platform_accounts (AGGREGATOR, the BOOK's key)
SharpSports ──webhook──▶ sharpsports-webhook ──record once, mark due──▶ pokes portfolio_connect {sweep}
sweep / Sync now ──GET account, GET its bet slips (private key)──▶ normalize ──▶ portfolio_svc_ingest_wagers ──▶ portfolio_positions
Refresh from book ──POST /v1/bettorAccounts/<id>/refresh (public key)──▶ SharpSports reads the book ──refreshResponse.created──▶ (as above)
```

### 3.1 Files

| Piece | Where |
|---|---|
| The SharpSports adapter: contract, normalizer, link / discover / refresh / sync, webhook hints and signature | `lib/edgedesk_portfolio_connect_core.js` § 10, inlined in both functions (`tools/portfolio/inline_connect_core.js`) |
| Reader actions and the scheduler | `supabase/functions/portfolio_connect/index.ts` (`ss_status`, `ss_books`, `ss_link`, `ss_discover`, `ss_refresh`; `sync`, `disconnect`, `sweep` serve linked books too) |
| The webhook receiver | `supabase/functions/sharpsports-webhook/index.ts` |
| Schema and service functions | `supabase/portfolio_aggregator.sql` (+ the run lifecycle in `supabase/portfolio_connect.sql`) |
| Bankroll path, units P&L | `supabase/portfolio_journal.sql` (`portfolio_pnl_path`, `portfolio_summary.settled.units_pnl`) |
| Model context | `supabase/portfolio_model_context.sql` |
| The page | `lib/edgedesk_portfolio_ui.js`, `lib/edgedesk_portfolio_journal_ui.js`, `lib/edgedesk_portfolio.css` |
| Live checks | `tools/portfolio/sharpsports_smoke.js` |
| Tests | `tools/portfolio/sharpsports.test.js`, `sharpsports_ui.e2e.js`, `model_context_sql.test.js` |

### 3.2 The database (reused where it exists)

- **A linked book is a `platform_accounts` row**, under the book's own key (`draftkings`, `fanduel`, …):
  - `connection_type = 'AGGREGATOR'`, `ingestion_method = 'AUTHORIZED_API'`, tier 1;
  - `external_account_id` = SharpSports' `BACT_` id;
  - `metadata` = `{provider, environment, provider_state}`, never a credential.
  - A reader's QUICK IMPORT or manual account for the same book is **upgraded in place**: its history stays.
  - Relinking reuses the same row.
- **Bets are `portfolio_positions`:**
  - `external_position_id = 'sharpsports:<SLIP_id>'`;
  - `raw_payload` = SharpSports' slip, redacted and capped;
  - `legs` = the parlay legs in EdgeDesk's leg shape;
  - money derived by the existing trigger.
- **`portfolio_svc_ingest_wagers` upserts by the platform's id.** The same history twice writes nothing.
  - The platform owns the wager: stake, price, legs, status, payout, times.
  - The reader owns their notes, journal and attribution. These are never touched.
- **Reconciliation with file and manual records.** A first-seen synced bet **adopts** a bet the reader typed or imported when:
  - it is the same book, stake and price;
  - it has the same line where both have one;
  - it was placed within 15 minutes;
  - exactly one record matches in each direction.

  The result is one position, and the journal is kept. Two or more candidates stay apart and are reported as POSSIBLE_DUPLICATE.
- **New tables:**

  | Table | Holds |
  |---|---|
  | `portfolio_private.aggregator_bettors` | reader ↔ SharpSports bettor: an opaque `ed_<32 hex>` internal id, never the auth id |
  | `portfolio_private.aggregator_webhook_events` | each delivery once: dedupe key, ids, how it was authenticated, the signature header, the outcome |
  | `portfolio_private.aggregator_webhook_rejections` | a reason and a time, nothing else |
  | `public.portfolio_refresh_requests` | the reader reads their own |
  | `public.portfolio_position_settlements` | append-only; the reader reads their own |

- **Sync runs** are the existing `portfolio_sync_runs`, with the existing backoff.
  - `RELINK_REQUIRED` and `BOOK_INACCESSIBLE` read **Action required**, with no retry storm.
- **Every `portfolio_svc_*` function** is the service role's alone, and asserts it again inside.

### 3.3 Sandbox and production

| | Sandbox (now) | Production (later) |
|---|---|---|
| `SHARPSPORTS_ENV` | unset, or `sandbox` | `production` |
| keys read | `SHARPSPORTS_API_KEY` (private), `SHARPSPORTS_PUBLIC_KEY` | `SHARPSPORTS_LIVE_API_KEY`, `SHARPSPORTS_LIVE_PUBLIC_KEY` |
| who may link | operators (`portfolio_is_admin`) | everyone once `portfolio_platform_registry('sharpsports').automatic_enabled`; before that, an operator under a PRODUCTION smoke test |
| smoke test recorded as | DEMO — can never switch production on | PRODUCTION — the evidence the switch requires |

- The two environments use different secret names, so a sandbox key is never read as a live one.
- Each account, bettor and delivery carries its environment.
- A function configured for one environment never syncs the other's accounts.
- Production linking is refused twice: by the function, and again in the database (`portfolio_svc_ag_allowed`).
- The registry switch can be thrown only with a PASSED ten-stage PRODUCTION smoke test of `sharpsports_v1` and `tos_review = 'CLEARED'` (`portfolio_registry_guard`, unchanged).

### 3.4 Webhook security

SharpSports' docs say every post is signed with **HMAC-SHA256** under the subscription's `hmac_secret`, and that the subscription id travels in the **`Hook-Subscription`** header. The page naming the signature header and the exact signed string could not be read (§ 4).

- **A delivery is a hint, never data.**
  - The function records it once, keyed by SHA-256 of the subscription and the raw body.
  - It extracts only the documented id prefixes (`BACT_`, `BTTR_`, `RRES_`, `SLIP_`) and EdgeDesk's own internal-id shape, wherever they sit.
  - It marks those accounts and bettors due, at most once a minute per account.
  - Everything is then re-read from SharpSports' API with EdgeDesk's key. Nothing in a payload is written onto an account or a bet.
  - So a forged post can at most make EdgeDesk re-read an account it already holds. It cannot add a bet, change a status or link an account (tested).
- **Signature check.** A post counts as signed when any header carries the HMAC of the raw body, hex or base64 (`sha256=` allowed). The check uses the named subscription's own secret; a post naming an unknown subscription is never checked against the others.
  - **`SHARPSPORTS_WEBHOOK_VERIFY=observe`** (the default until a genuine delivery has verified): unsigned posts are still applied as hints and recorded as `FETCH_BACK`.
  - **`required`**: an unsigned, wrongly signed or unknown-subscription post gets **401** and only a count.
  - The header that verified is recorded with each delivery, so it can be pinned (`SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER`).
- **Responses:**

  | Status | When |
  |---|---|
  | 200 | applied, duplicate, or naming nothing EdgeDesk holds |
  | 400 | not JSON |
  | 401 | signature required and missing or wrong |
  | 405 | not POST |
  | 413 | over 256 KB |
  | 500 | recorded but not applied — the retry re-applies it |
  | 503 | database unreachable |

  `GET` is a health check that never shows a value.

### 3.5 Refresh and scheduling

The docs say a refresh is asynchronous: SharpSports reports the result as `refreshResponse.created`. Refreshes must be at least 60 s apart, never overlapping (429).

- **Refresh from book**: at most once per 15 minutes per account. Recorded in `portfolio_refresh_requests`, and closed from what SharpSports' API reports on the account (`latestRefreshResponse`), never from the webhook.
- **Scheduled refreshes are OFF** unless `SHARPSPORTS_SCHEDULED_REFRESH_MINUTES` (≥ 60) is set.
  - Refreshes can be billable.
  - The docs conflict on whether SharpSports refreshes on its own cadence (`cadence` type, `refreshCadenceActive` vs. "no automatic refresh cadence").
- **Reading what SharpSports already holds** is the existing sweep (pg_cron every 10 minutes, `portfolio_sync_cron.sql`, plus the webhook's immediate poke).
  - Bet slips are re-read when the account's latest refresh response changes, on a manual sync, and at least daily.
  - Open bets are re-read until they settle.

### 3.6 EdgeDesk's model at the time (Phase 6)

`portfolio_model_context(position)` runs as the caller and reads only `model_pnl_public` (EdgeDesk's public record).

- **Scope:** football singles (moneyline, spread, total) are matched to the **one** game where:
  - both teams match in the same league;
  - kickoff is within 6 h.
- **Team names:** "Texas" = "Texas Longhorns"; "Texas" ≠ "Texas Tech Red Raiders"; NFL nicknames are allowed.
- **What it shows:**
  - the accepted price and its implied probability;
  - EdgeDesk's probability **as recorded before the bet** — for the bettor's side, the complement when the bet is on the other side of a two-way market, and **only at the line the model priced**;
  - the difference;
  - CLV from the reader's recorded close;
  - the outcome and the return.
- **It refuses by name:** a record made after the bet (`MODEL_AFTER_PLACEMENT`), parlays, other sports, ambiguous games.
- A record recovered from git history is labelled **reconstructed**.
- It changes no figure and no attribution. The model's results and the bettor's are never mixed.

## 4. What was verified, and what was not

- `docs.sharpsports.io` could not be fetched from the build environment.
- The facts in `SHARPSPORTS.verified.facts` (the core) were read from SharpSports' documentation as quoted in web-search excerpts on 2026-10-14.
- Each request in `SHARPSPORTS.contract` is labelled:

| Request | Path | Key | Seen |
|---|---|---|---|
| context | `POST /v1/context` `{internalId, redirectUrl}` → `{cid}` | public | DOCUMENTED |
| books | `GET /v1/books` | public | DOCUMENTED |
| account refresh | `POST /v1/bettorAccounts/{id}/refresh[?reverify=true]` | public | DOCUMENTED |
| a bettor's accounts | `GET /v1/bettors/{id}/bettorAccounts` | private | **INFERRED** |
| one account | `GET /v1/bettorAccounts/{id}` | private | **INFERRED** |
| an account's slips | `GET /v1/bettorAccounts/{id}/betSlips` | private | **INFERRED** |

- **INFERRED** means SharpSports documents the resource and the endpoint's name, but its path was not seen; the REST-consistent form is used.
  - All three are read-only GETs.
  - A wrong path fails the sync with `PROVIDER_CONTRACT` and stores nothing.
- **Also not confirmed** (`SHARPSPORTS.verified.unverified`):
  - the signature header and signed string;
  - the webhook body's official shape;
  - the event string for "bettor account inaccessible" — not needed: every delivery is a hint;
  - list pagination — a same-origin `next` link is followed;
  - cash-out and free-bet fields — payout = `atRisk + netProfit`; a slip with no stake is not stored;
  - a provider-side "remove access" call on disconnect.
- **The page to re-read is `https://docs.sharpsports.io/llms.txt`** (every page, with the endpoints in OpenAPI form; any page as Markdown with `.md`). The sandbox rehearsal (§ 5) confirms the INFERRED paths by working or failing.

## 5. Deploy and verify (sandbox) — exact steps

To be run by someone with access to the Supabase project and the SharpSports dashboard. If this is to run from a Claude Code cloud environment, its network policy must allow `iattxbkbufslbauoumga.supabase.co`, `api.supabase.com`, `api.sharpsports.io`, `ui.sharpsports.io` and `docs.sharpsports.io`.

1. **Secrets** (Supabase → Edge Functions → Secrets, or `supabase secrets set`). Never in a workflow log:

   | Secret | Value |
   |---|---|
   | `SHARPSPORTS_API_KEY` | the **sandbox private** key. Said to exist already: the health check below confirms presence without showing it |
   | `SHARPSPORTS_PUBLIC_KEY` | the **sandbox public** key (Dashboard, sandbox mode) |
   | `SHARPSPORTS_WEBHOOK_SECRETS` | `{"<subscription id>": "<hmac_secret>", …}`, one entry per subscription (Settings → Webhooks, or each subscription's `hmac_secret`) |
   | `SHARPSPORTS_ENV` | leave **unset** (sandbox) |
   | `SHARPSPORTS_WEBHOOK_VERIFY` | leave **unset** (observe) until step 6 |
   | `EDGEDESK_APP_URL` | optional; defaults to `https://edgedesksports.com/app.html` |

2. **Schema.** After this branch is merged, run **Actions → Deploy Portfolio schema** with "deploy_function" ticked. It:
   - applies `portfolio.sql`, `portfolio_journal.sql`, `portfolio_connect.sql`, `portfolio_decision.sql`, `portfolio_aggregator.sql` and `portfolio_model_context.sql`, each after its suite passes, each failing on any `CHECK THIS`;
   - deploys `portfolio_connect` and **`sharpsports-webhook`** with `--no-verify-jwt`, failing if the webhook's health check is not 200.

   Without the workflow: paste the `supabase/parts/portfolio_*.part*` files in order, then

   ```
   supabase functions deploy portfolio_connect --no-verify-jwt
   supabase functions deploy sharpsports-webhook --no-verify-jwt
   ```
3. **The schedule.** Re-run `supabase/portfolio_sync_cron.sql`. Every report row must read ok; it adds the daily webhook-log prune.
4. **Probe the webhook** (operator machine, with `SB_URL`, `SB_SERVICE_ROLE` and `EDGEDESK_OPERATOR_TOKEN`):

   ```
   node tools/portfolio/sharpsports_smoke.js probe
   ```

   Expect:
   - `sharpsports-webhook GET 200` with `subscription_secrets: 5`;
   - `portfolio_connect` health showing `sharpsports: {environment: "sandbox", private_key: true, public_key: true}`;
   - the unsigned POST answered **200 IGNORED** (observe).
5. **A genuine delivery.** In the SharpSports dashboard (sandbox), test each subscription (Settings → Webhooks shows each subscription's last status). Then:

   ```
   node tools/portfolio/sharpsports_smoke.js webhooks
   ```

   - Each delivery should show `authenticated_by: SIGNATURE` and its `signature_header`.
   - If they show `FETCH_BACK`, the signature format differs from the raw-body HMAC assumed here. Read the HMAC Verification page and adjust `webhookSignature` in the core. Do **not** switch to `required` until they verify.
6. **Require signatures:**
   - set `SHARPSPORTS_WEBHOOK_VERIFY=required` and `SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER=<that header>`;
   - re-run `probe`: the unsigned POST must now answer **401**;
   - re-test a subscription in the dashboard: it must still record as `SIGNATURE`.
7. **The sandbox rehearsal**, as an operator. Recorded as DEMO; it can never switch production on.

   ```
   node tools/portfolio/sharpsports_smoke.js begin
   node tools/portfolio/sharpsports_smoke.js stage <id> CONNECT        # open the printed link; link test user gooduser / Test1; run CONNECT again
   node tools/portfolio/sharpsports_smoke.js stage <id> IMPORT
   node tools/portfolio/sharpsports_smoke.js stage <id> VERIFY         # compare with the SharpSports dashboard, then add --confirmed
   node tools/portfolio/sharpsports_smoke.js stage <id> INCREMENTAL
   node tools/portfolio/sharpsports_smoke.js stage <id> NEW_ACTIVITY   # requests a refresh (sandbox refreshes add real-market bets); then --synced
   node tools/portfolio/sharpsports_smoke.js stage <id> SETTLEMENT     # after one of those bets grades
   node tools/portfolio/sharpsports_smoke.js stage <id> RECONCILE
   node tools/portfolio/sharpsports_smoke.js stage <id> DISCONNECT
   node tools/portfolio/sharpsports_smoke.js stage <id> RECONNECT
   node tools/portfolio/sharpsports_smoke.js stage <id> NO_DUPLICATES
   node tools/portfolio/sharpsports_smoke.js finish <id>
   ```

   Also exercise the failure paths in Portfolio → Accounts:
   - `errorloginuser / Test3`: verification fails → `bettorAccount.unverified` → **Action required**;
   - `changepassworduser / Test5`: a later refresh 401 → **Action required**;
   - `2FAuser / Test6`: one-time code `123456`.
8. **If an INFERRED path fails** (`PROVIDER_CONTRACT` in the sync log): read the endpoint in `llms.txt`, correct `SHARPSPORTS.contract` in the core, run `node tools/portfolio/inline_connect_core.js`, run the suites, and redeploy.

## 6. Known limitations and unsupported features

- **Free bets and site credit.** A slip SharpSports reports with no cash stake is not stored (`NO_STAKE`), because its face value is not known. A promotion-adjusted stake is stored as cash risk at the stake SharpSports reports.
- **Missing placement time.** Slips whose book gives no `timePlaced` are not stored (`NO_PLACED_TIME`); EdgeDesk does not guess times. The count shows in the sync log.
- **Cash-outs** need `netProfit`. Without it the slip is skipped (`NO_PAYOUT`).
- **Half wins and half losses** (Asian lines) are stored as WON or LOST with the book's actual payout.
- **Round robins** are one position (`OTHER`, "Round robin (n legs)"), not split into their parlays. **Teasers** are parlays named "Teaser".
- **Parlay legs** keep the first 30.
- **Incomplete slips** (SharpSports' `incomplete`) keep exact money but may lack event detail. They are flagged.
- **Books needing SharpSports' SDK** (for example some DraftKings states, per the docs' example) cannot be linked on the web. They show as "app only". **History depth** is per book (`pullBackToDate`, `maxHistoryMonths`); older bets are not available.
- **Disconnect** stops EdgeDesk reading and drops the link from the portfolio. **SharpSports keeps its own link** until it is removed in the SharpSports dashboard. Its "remove access" call's path was not readable, so it is not called. A linked account with `access=true` is billable in live mode.
- **"Delete everything"** (Portfolio privacy) deletes the reader's accounts, bets and refreshes. The SharpSports bettor reference (an opaque id) remains until the auth user is deleted, and the bettor at SharpSports remains.
- **Units** for historical bets use the unit size in force when the bet was first recorded in EdgeDesk (the journal's existing rule).
- **Model context** covers NFL and college-football single game lines in EdgeDesk's model record. Props, parlays and other sports are not matched. The CLV it shows comes from the reader's recorded close only.
- **Reconciliation** adopts a reader's own record only on an exact stake, price and line match within 15 minutes. A file read in the wrong time zone will not match: both are kept and flagged.
- **Sportsbook "Connect" copy on the landing page** is unchanged, and stays so until production is switched on (`tools/presentation/landing_positioning.test.js`).
- **The webhook is not rate-limited by the function itself.**
  - In `observe` mode an unsigned delivery is recorded as an IGNORED row, with no payload kept.
  - In `required` mode it is only a count row.
  - Either way it can change nothing, and the daily prune removes these rows after 90 days. A flood is limited only by Supabase's own gateway, so move to `required` as soon as a genuine delivery has verified (§ 5 step 6).

## 7. Production-readiness checklist

Every box must be ticked, in writing, before § 8.

**Provider access and subscription**
- [ ] A SharpSports commercial agreement and a live-mode plan are in place. EdgeDesk has not subscribed to any plan or started billing; nothing in this code does.
- [ ] Live keys were generated in Dashboard live mode and stored as `SHARPSPORTS_LIVE_API_KEY` / `SHARPSPORTS_LIVE_PUBLIC_KEY`. These are not the sandbox names.
- [ ] Production webhook subscriptions are registered at `…/functions/v1/sharpsports-webhook`, with their `hmac_secret`s in `SHARPSPORTS_WEBHOOK_SECRETS`, and `SHARPSPORTS_WEBHOOK_VERIFY=required`.

**Supported sportsbooks and jurisdictions**
- [ ] The supported book and region list was reviewed (`/v1/books?support=true`), including SDK-only books and per-book history limits.
- [ ] How SharpSports obtains each book's data, and each book's terms, were reviewed per jurisdiction.

**Credential and webhook authentication**
- [ ] The HMAC Verification page has been read. The header is pinned (`SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER`), and genuine deliveries show `SIGNATURE`.
- [ ] Every INFERRED path in `SHARPSPORTS.contract` was confirmed against `llms.txt`, and relabelled DOCUMENTED.
- [ ] Private keys exist only in Supabase secrets. `git grep` and the functions' logs are clean (the suites assert no key reaches a log line).

**Data privacy and user consent**
- [ ] The consent wording beside **Connect** has been reviewed by counsel: what SharpSports reads, what EdgeDesk stores, retention and deletion.
- [ ] The privacy policy (`privacy.html`) and terms (`terms.html`) name SharpSports as a processor.

**Rate limits and refresh schedule**
- [ ] The plan's refresh allowance is known. `SHARPSPORTS_SCHEDULED_REFRESH_MINUTES` is set or left unset accordingly. The docs advise 1–2 refreshes a day; 60 s is the hard minimum.
- [ ] The general API rate limit page has been read, and the sweep's cadence (10 min; ≤ 10 accounts per pass) fits it.

**Operational monitoring**
- [ ] The operator panel is watched: Accounts → Operator, `portfolio_admin_connector_health` and `portfolio_admin_aggregator_health`. Look at deliveries by authentication, rejections, refresh outcomes and accounts by state.
- [ ] Alerts are agreed for: FAILED deliveries (`failed_unresolved`), `PROVIDER_AUTH` / `PROVIDER_CONTRACT` errors, and a rising ERROR / ACTION_REQUIRED count.

**Data deletion and disconnection**
- [ ] SharpSports' "remove access" call is confirmed and wired into disconnect, so a disconnected account stops being billable. Until then, operators remove access in the dashboard on every disconnect.
- [ ] A procedure exists to delete a bettor at SharpSports when a reader deletes their EdgeDesk account.

**Error recovery**
- [ ] Rehearsed on sandbox: an expired link → Reconnect; a lost webhook (the 10-minute sweep catches it); SharpSports down (backoff, ERROR after five).

**Production deployment verification**
- [ ] `sharpsports_smoke.js probe` against production returns 200 / `production` / keys present / 401 for unsigned.
- [ ] The ten-stage **PRODUCTION** smoke test PASSED with an operator's own real account (§ 8).

## 8. Enabling production — exact instructions

Only after every box in § 7 is ticked:

1. Set `SHARPSPORTS_LIVE_API_KEY`, `SHARPSPORTS_LIVE_PUBLIC_KEY` and the production `SHARPSPORTS_WEBHOOK_SECRETS`. Set `SHARPSPORTS_WEBHOOK_VERIFY=required` and `SHARPSPORTS_WEBHOOK_SIGNATURE_HEADER`. Then set **`SHARPSPORTS_ENV=production`** on both functions.
   - Readers still cannot link: the registry is off. Sandbox accounts stop syncing; they are kept, labelled sandbox.
2. As an operator, with your own real sportsbook account:

   ```
   node tools/portfolio/sharpsports_smoke.js begin     # records a PRODUCTION test
   … the ten stages as in § 5 step 7, on your real account …
   node tools/portfolio/sharpsports_smoke.js finish <id>
   ```
3. Clear the terms review in writing. `finish` prints the one statement that switches SharpSports on:

   ```sql
   update public.portfolio_platform_registry
      set automatic_enabled = true, enabled_by_smoke_test = '<id>', tos_review = 'CLEARED', enabled_at = now()
    where platform_key = 'sharpsports';
   ```

   The database refuses this without that PASSED PRODUCTION test of `sharpsports_v1` from the last 30 days. A new connector version switches it off again.
4. In the same change, update `docs/platform-support.md`, `docs/platform-connections.md` and this page. Only then may the landing page's copy change, and its test with it.

**Rolling back:** `update public.portfolio_platform_registry set automatic_enabled = false where platform_key = 'sharpsports';`. Linking and syncing stop at once; history is kept.

## 9. Tests (what ran, here)

| Suite | What | Result (2026-10-14) |
|---|---|---|
| `tools/portfolio/sharpsports.test.js` | both shipped functions in a stub Deno, real migrations, a fake SharpSports: bettor creation; linking; verified / failed verification / lost access / reauth; historical import; a new wager; settlement; refresh and its rate limit; paging; duplicate deliveries; unsigned, wrong, unknown-subscription and wrong-header deliveries (401); forged hints; cross-reader isolation; file-bet adoption; idempotent re-sync; disconnect; sandbox vs production keys; DEMO vs PRODUCTION smoke tests; bankroll path; render checks | **81 passed, 0 failed** |
| `tools/portfolio/sharpsports_ui.e2e.js` | Chromium, 1280 px and 390 px: Connect → SharpSports' page (stand-in) → back → verified account, its bets in Open (with legs) and History, the bankroll trend, refresh | **18 passed, 0 failed** |
| `tools/portfolio/model_context_sql.test.js` | the model matcher against the real model-record schema | **21 passed, 0 failed** |
| The existing Portfolio suites | calc 106, import 114, bet history 108, process 38, UI 100, journal UI 126, connect core 67, decision record 29, portfolio SQL 187, journal SQL 73, connect SQL 85, connect sync 33, connect function 18, decision SQL 103, bet history SQL 19; Chromium: portfolio UI 128, bet history 31; navigation 248; landing positioning 466 | all green, unchanged |

- **The fake SharpSports is not SharpSports.** It answers in the shapes this connector expects, so it proves EdgeDesk's side of the wire only.
- The live checks are § 5.
