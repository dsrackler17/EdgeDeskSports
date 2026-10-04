# EdgeDesk Portfolio — architecture

*One portfolio for every sports wager and prediction-market trade.* A reader records — and, from Phase B, connects — the platforms they use, and EdgeDesk keeps one normalized ledger of their positions with honest P&L, ROI, exposure and history.

**Phase A (this document's scope) is shipped:**

- the database;
- row level security;
- the shared calculation engine;
- manual entry for sportsbook bets and prediction-market positions;
- CSV import with server-side duplicate detection;
- the Portfolio page (Overview · Open · History · Analytics · Accounts · Import);
- the connector contract that future integrations implement.

**Nothing connects automatically yet**, and nothing on the page says otherwise. See [`platform-support.md`](platform-support.md).

---

## 1. What already existed, and what was reused

The repository was audited before any code was written.

**Reused unchanged:**

| Need | Existing piece |
|---|---|
| Sign-in, session, token refresh | `app.html` `edUser()` / `edToken()` / `sbFetch` over Supabase Auth. No second auth system was added. |
| Database access | PostgREST over `fetch` with `SB_URL` / `SB_KEY`. The app does not use supabase-js, and neither does Portfolio. |
| Navigation | The `show(v)` router, `NAV_OWNER`, the More list (`loadMore()`), and deep links read at boot. |
| Visual language | `app.html` `:root` tokens (`--surface`, `--pos`, `--neg`, …), Inter and JetBrains Mono, the dark-only theme. |
| Platform keys | EdgeDesk's book keys (`lib/edgedesk_personal.js` `BOOKS`, the capture's `BOOK_TIER`): `draftkings`, `fanduel`, `williamhill_us` (Caesars), … so a position can later be joined to prices EdgeDesk captured. |
| SQL conventions | `supabase/README.md`: idempotent, additive, pasted, no psql meta-commands, ends in an `ok` / `CHECK THIS` report. Paste-sized parts come from `tools/sql/split_sql.js`. |
| Test harness | `tools/personal/_pg.js` and `tools/games/sql/supabase_shim.sql` (a real PostgreSQL acting as `authenticated` / `anon` / `service_role`), plus the Playwright pattern used by the other e2e suites. |
| Operator check | `public.billing_is_admin()` gates the operator diagnostics. |

**Existing user-bet stores that were deliberately *not* extended:**

| Store | Why Portfolio does not extend it |
|---|---|
| `public.user_bets` | Write-once by design. CFB/NFL spread/total/moneyline only, sized in units. It is the decision layer's "bet placed" record. |
| `public.external_positions` | Units only. It exists so the staking engine's exposure caps see the whole book, and is "never graded". |
| `public.research_journal` | A decision journal that deliberately carries no profit figure. |
| localStorage `edgedesk_bets` (the Ledger's CLV ledger) | Device-only and float-based. |
| `lib/edgedesk_pnl.js`, `signal_pnl`, `model_pnl` | EdgeDesk's *own* record, in units and floats. |

None of these could hold dollar P&L across platforms and prediction markets without breaking what they do today, so Portfolio is additive and touches none of them. They remain valid **attribution targets** (§8).

**Name collisions avoided.** The Ledger view already has `<div id="portfolio">` ("Your book right now") and `.pfl-` CSS. Portfolio uses:

- the view `#v-portfolio`, with host `#pfoHost`;
- the CSS prefix `.pfo-`;
- the globals `EDPortfolio*`.

## 2. The pieces

```
app.html  #v-portfolio  (More → Portfolio, #portfolio, or the landing-page setting)
   │
   ├── lib/edgedesk_portfolio_ui.js          the page: renderers + controller, PostgREST under the reader's token
   ├── lib/edgedesk_portfolio_connectors.js  the connector contract; manual + csv registered
   ├── lib/edgedesk_portfolio_import.js      CSV → staged rows (parse, map, normalize, issues)
   └── lib/edgedesk_portfolio.js             THE ENGINE: exact decimals, both instruments, aggregation, fingerprints
                       ║ parity-tested against ║
supabase/portfolio.sql — tables, RLS, the derive trigger, import classify / commit, sync logs, credentials
```

The page never computes stored money. Every stored figure is derived by the database trigger. The engine mirrors that trigger exactly, for:

- the live form preview;
- the import preview;
- aggregation over the reader's own rows.

`tools/portfolio/portfolio_sql.test.js` holds the two in parity figure for figure, over hand-checked cases and 280 seeded random positions.

## 3. Schema

All tables live in `public` (served by PostgREST) except the credentials table. Every `user_id` references `auth.users(id) on delete cascade`, so deleting an account deletes its whole book.

### `platform_accounts` — the platforms a reader tracks

| Column group | Columns |
|---|---|
| Identity | `id`, `user_id` |
| Platform | `platform` (key: `^[a-z0-9][a-z0-9_]{1,47}$`; "Other" becomes `custom_<slug>`), `platform_label`, `platform_type` (`SPORTSBOOK` \| `PREDICTION_MARKET`) |
| Connection | `connection_type` (`MANUAL` \| `CSV` \| `API` \| `OAUTH` \| `AGGREGATOR`), `external_account_id`, `display_name`, `status` |
| Sync state | `last_sync_at`, `last_success_at`, `last_error`, `sync_cursor`, `metadata` |
| Housekeeping | `created_at`, `updated_at` |

- `status` is one of `CONNECTED`, `IMPORT_ONLY`, `MANUAL`, `SYNCING`, `ACTION_REQUIRED`, `DISCONNECTED`, `ERROR`.
- **`platform_accounts_status_honest`**: a `MANUAL` account can only be `MANUAL` / `DISCONNECTED`, and a `CSV` account only `IMPORT_ONLY` / `DISCONNECTED`. Nothing can make a manual account read "Connected" — not even the service role.
- One account per `(user, platform, connection_type, external_account_id)`. A position with no account is linked to the reader's account for that platform, which is opened if none exists. An account the reader removes is **not** silently re-opened; its positions stay in the history, unlinked.

### `portfolio_positions` — one row per wager or contract position

**Identity and description:**

- `id`, `user_id`, `platform_account_id`
- `platform`, `platform_label`, `platform_type`
- `external_position_id`
- `position_type`: `MONEYLINE`, `SPREAD`, `TOTAL`, `PLAYER_PROP`, `PARLAY`, `SAME_GAME_PARLAY`, `FUTURE`, `EVENT_CONTRACT`, `PREDICTION_MARKET`, `OTHER`
- `sport`, `league`, `event_name`, `event_id`, `event_start_at`
- `market_name`, `selection`, `side`, `line`
- `legs` (jsonb array, ≤ 30)

**Inputs:**

| Instrument | Input columns |
|---|---|
| Sportsbook | `odds_american` (integer, ≤ −100 or ≥ +100) or `odds_decimal` (> 1), `stake` (cents), `reported_payout`, `fees` |
| Prediction market | `current_price` (the reader's own mark, with `current_price_at`), `resolution`, `settlement_price` (0–1), `reported_payout` |

**Derived — never accepted from a client.** Whatever a client sends for these is overwritten:

- **Contract aggregates, rebuilt from fills:** `contracts` (held), `contracts_bought`, `contracts_sold`, `average_entry_price`, `average_exit_price`, `sell_proceeds`, `fees`.
- **Money:** `cost_basis`, `open_cost_basis`, `potential_profit`, `potential_payout`, `current_value`, `gross_payout`, `realized_profit_loss`, `unrealized_profit_loss`, `profit_loss`.
- **Outcome:** `result` (`WIN` / `LOSS` / `PUSH` / `VOID` / `CASHOUT`).
- **Identity:** `fingerprint`, `calc_version`.

**Lifecycle and provenance:**

- `status`: `OPEN`, `WON`, `LOST`, `PUSH`, `VOID`, `CASHED_OUT`, `SETTLED`. A prediction-market position only uses `OPEN` / `SETTLED` / `VOID`, and its status is derived.
- `placed_at`, `settled_at`. The rule `status = 'OPEN' ⇔ settled_at is null` holds, and `settled_at ≥ placed_at`.
- `source`: `MANUAL` \| `CSV` \| `SYNC` \| `EDGEDESK`, plus `import_id`, `notes`, `raw_payload` (≤ 64 KB).

**Attribution** (§8): `edge_source`, `edge_ref_type`, `edge_ref_id`, `model_version`, `model_probability`, `model_fair_line`, `market_line_at_research`, `market_line_at_entry`, `edge_at_entry`, `clv`, `confidence_tier`.

**Uniqueness:**

- `(user_id, platform, external_position_id)` when a platform id exists;
- otherwise `(user_id, fingerprint, dedupe_occurrence)`.

### `portfolio_transactions` — fills, settlements and cash moves

- **Columns:** `id`, `user_id`, `platform_account_id`, `position_id`, `platform`, `external_transaction_id`, `transaction_type`, `side`, `quantity`, `price`, `amount`, `fee`, `executed_at`, `source`, `import_id`, `notes`, `raw_payload`, `fingerprint`, `dedupe_occurrence`.
- **`transaction_type`:** `BET`, `BUY`, `SELL`, `FILL`, `CASHOUT`, `SETTLEMENT`, `VOID`, `REFUND`, `DEPOSIT`, `WITHDRAWAL`, `FEE`.
- **Trade rows** (`BUY` / `SELL` / `FILL`) need a position, a quantity > 0 (≤ 6 dp) and a price in [0, 1] (≤ 6 dp). `amount` is always `quantity × price`.
- **Cash rows** (`DEPOSIT` / `WITHDRAWAL`) have no position and a positive amount.
- **A prediction-market position *is* its fills.** Every insert, update or delete of a fill rebuilds the position. A deferred constraint trigger checks, at COMMIT, that each contract position has ≥ 1 buy and never more sold than bought. So a position and its first fill can arrive in one transaction, and an import can never leave an empty or oversold market behind.
- **Uniqueness:** as for positions — the platform id first, else the fingerprint.

### `portfolio_imports` and `portfolio_import_rows` — the staging area

- **`portfolio_imports`** holds one row per upload:
  - `importer`, `file_name`, `file_sha256`, `timezone`, `column_map`;
  - `status`: `STAGED` → `CLASSIFIED` → `COMMITTED` (or `CANCELLED`);
  - counts: `rows_total` / `new` / `duplicate` / `review` / `invalid` / `imported` / `skipped` / `failed`.
- **`portfolio_import_rows`** holds every row of the file:
  - `raw` (the original cells), `normalized`, `issues`;
  - the server's `classification`, `fingerprint`, `group_key`, `duplicate_of`;
  - the reader's `decision`;
  - the `outcome` and its message.
  - Rows are frozen once their import is committed.

### `portfolio_sync_logs` — what every import (and, later, every sync) did

- **Columns:**
  - `platform`, `platform_account_id`, `sync_kind`, `import_id`, `status`;
  - `started_at`, `completed_at`, `duration_ms` (generated);
  - `records_fetched` / `inserted` / `updated`, `duplicates_ignored`, `errors_count`;
  - `error_code` (`^[A-Z0-9_]{1,40}$`), `error_summary` (≤ 500 characters, sanitized), `attempt`.
- **`sync_kind`:** `CSV_IMPORT`, `MANUAL`, `API_SYNC`, `WEBHOOK`, `HEALTH_CHECK`, `CONNECT`, `DISCONNECT`.
- Readers may append their own `CSV_IMPORT` / `MANUAL` rows (the import commit writes one). They cannot update or delete any row.

### `portfolio_private.platform_credentials` — ciphertext only

- **Columns:** `platform_account_id` (one per account), `user_id`, `credential_kind` (`API_KEY` \| `OAUTH_TOKENS` \| `AGGREGATOR_TOKEN` \| `WALLET_ADDRESS`), `ciphertext`, `nonce`, `key_version`, `key_hint` (≤ 8 characters), `scopes`, `expires_at`, `rotated_at`, `revoked_at`, `last_used_at`.
- **The schema is not exposed to PostgREST.** No client role has usage on it. RLS is on with no policies. Only `service_role` holds grants.
- Empty in Phase A.

### `portfolio_account_summary` — a view

Per account: positions, open, settled, the latest position and the latest import. It is `security_invoker`, so it shows the caller's rows only.

## 4. Row level security and grants

Every policy is `to authenticated` and keyed to `user_id = auth.uid()`. The migration's report counts all 22 of them.

| Table | select | insert | update | delete |
|---|---|---|---|---|
| `platform_accounts` | own | own, `MANUAL`/`CSV` only | own; column grant: `display_name`, `platform_label` only | own |
| `portfolio_positions` | own | own, source ≠ `SYNC` | own (trigger: synced rows → notes and attribution only) | own, source ≠ `SYNC` |
| `portfolio_transactions` | own | own, source ≠ `SYNC` | own (trigger: synced rows frozen) | own, source ≠ `SYNC` |
| `portfolio_imports` | own | own | own | own |
| `portfolio_import_rows` | own | own | own (frozen after commit) | own |
| `portfolio_sync_logs` | own | own, `CSV_IMPORT`/`MANUAL` only | — | — |
| `platform_credentials` | — | — | — | — (service role only) |

**Defense in depth beyond the policies:**

1. **The owner is the caller.** Every insert trigger sets `user_id := auth.uid()` whatever the payload says. Every update trigger freezes `id`, `user_id`, `created_at`, `source`, `import_id` and `platform_type`, plus the external ids and raw payloads for readers.
2. **Composite foreign keys.** Positions reference `(platform_account_id, user_id)`; fills reference `(position_id, user_id)`; import rows reference `(import_id, user_id)`. A row naming another reader's id fails the key whatever RLS would have allowed.
3. **anon has no privileges** on any Portfolio table or function.
4. **`security_invoker`** on the view and on the three entry-point functions, so RLS applies inside them.
5. The **operator view** `portfolio_admin_sync_health(days)` is `security definer` and refuses anyone `billing_is_admin()` does not accept. It returns counts by platform / kind / status: runs, accounts, records inserted, duplicates, errors, p50/p95 duration, and the most common error code. No user id, account id, error text or credential.

**Proved, not asserted.** `tools/portfolio/portfolio_sql.test.js` acts as reader B and checks that B:

- cannot SELECT A's positions, fills, accounts, imports, rows, logs or summary;
- cannot UPDATE or DELETE A's positions;
- cannot attach a fill to A's position;
- cannot file a position under A's account;
- cannot stage rows into A's import, nor classify or commit it.

It also checks that anon reads nothing, and that a reader cannot reach the credentials schema.

## 5. The calculation rules

**Exact money everywhere.** The database uses `NUMERIC`. The browser uses BigInt-backed decimals (`EDPortfolio.dec`); no amount passes through a float. PostgREST is asked for `numeric::text`.

There is one division rule: **`divRound(n, d, scale)`, half away from zero, computed by integer division** (`public.portfolio_div_round`, `EDPortfolio.dec.divRound`). All rounding goes through it:

- sportsbook profits round to the cent;
- contract averages and open cost round to 6 places;
- products and sums are never rounded.

### Sportsbook (`platform_type = SPORTSBOOK`)

| Figure | Rule |
|---|---|
| Decimal price | From American: `1 + a/100` (a ≥ 100) or `1 + 100/|a|` (a ≤ −100), to 6 dp. When only decimal odds were given, the decimal price is used as given — it is never re-rounded through American. |
| Profit if it wins | `stake × a / 100`, or `stake × 100 / |a|`, or `stake × (dec − 1)`, to the cent |
| Potential payout | `stake + potential profit` |
| WON | gross = reported payout, else stake + profit |
| LOST | gross = reported payout, else 0 |
| PUSH, VOID | gross = reported payout, else the stake |
| CASHED_OUT, SETTLED | gross = the reported payout (required) |
| P&L | `gross − stake − fees` |
| Open | `open_cost_basis = stake`; no P&L |

**Worked examples:**

| Bet | Result |
|---|---|
| $100 at +150 that wins | pays $250, profits $150 |
| $100 at −110 that wins | pays $190.91, profits $90.91 |
| A loss | −$100 |
| A push or a void | $0 |

**Payout is never profit.**

**Parlays:**

- They are stored with their combined price.
- `EDPortfolio.parlay(legs)` prices a ticket from its legs: a pushed or voided leg drops out, and one lost leg loses the ticket.
- A ticket the book re-priced is recorded as `SETTLED` with what the book paid.

### Prediction market (`platform_type = PREDICTION_MARKET`)

Contracts pay $1 each if the side held resolves true. The position is rebuilt from its fills by the **average-cost method**:

```
bought B, buy cost BC = Σ qty×price (buys);  sold S, proceeds SP = Σ qty×price (sells);  fees F = Σ fee (all rows)
held H = B − S        average entry = BC / B        open cost = H × BC / B
OPEN       realized so far = SP − (BC − open cost) − F
           current value  = H × current_price            unrealized = current value − open cost
           if it resolves your way: pays H, profit H − open cost
SETTLED    settle price = settlement_price, else 1 if resolution = side (case-insensitive), else 0
           gross = SP + (reported_payout, else H × settle price)        P&L = gross − BC − F
VOID       held contracts refunded at cost unless a settlement price or reported payout says otherwise
```

- **Status is derived.** A resolution means `SETTLED` (or `VOID`). Selling everything also means `SETTLED`, at the last sell's time. Otherwise the position is `OPEN`.
- **Fees are an expense when charged.**
- **Worked example:** 100 YES at $0.61 that resolves YES costs $61, settles $100 and profits $39; less fees, it reports $39 − fees. If it resolves NO, it loses $61.
- **Contracts never pass through an odds formula.**

### The whole book (one convention, used everywhere)

| Figure | Definition |
|---|---|
| **Total P&L** | Σ `profit_loss` over **settled** positions. A still-open contract position's partial exits show on that position (realized so far) and on the Overview, and join the total when it closes. |
| **ROI** | settled P&L ÷ settled capital (stake or contract cost) |
| **Capital deployed** | stake or contract cost of every position placed (in the period) |
| **Open exposure** | what is at risk at cost now: open stakes plus open contract cost |
| **Record** | W-L-P from `result`; cash-outs are counted beside it |
| **Win rate** | wins ÷ (wins + losses) |
| **Average odds** | the stake-weighted mean decimal price, printed as American (the convention `lib/edgedesk_pnl.js` uses) |
| **Average contract entry** | total contract cost ÷ contracts bought |
| **Periods** | 7D and 30D are rolling. YTD starts at midnight on 1 January in the reader's zone. A period bounds settled figures by `settled_at` and capital by `placed_at`; open exposure is always now. |
| **Best / worst** | shown only when two groups have settled positions, each with its count |

## 6. Imports

```
file ──(browser: parse, detect, map, normalize, issues)──▶ portfolio_imports + portfolio_import_rows  (STAGED)
     ──portfolio_import_classify()──▶ NEW · DUPLICATE · DUPLICATE_IN_FILE · NEEDS_REVIEW · INVALID   (CLASSIFIED)
     ──reader confirms, may tick review / duplicate rows──▶ portfolio_import_commit()               (COMMITTED)
```

**In the browser** (`lib/edgedesk_portfolio_import.js`):

- **The file is parsed locally:** RFC 4180, comma / semicolon / tab / pipe delimiters, a BOM, quoted newlines. Up to 5 MB and 5,000 rows.
- **The format is detected** and columns are proposed by header aliases; the reader can re-map any column.
- **Adapters, not assumptions.** `generic_sportsbook_v1` reads one row per bet. `generic_prediction_market_v1` reads one row per buy or sell; rows for the same market and side become one position with several fills. A book-specific importer is another adapter, and the core does not change.
- **Refused, never guessed:**
  - a decimal comma (`12,50`);
  - a date that only reads day-first under month-first;
  - a contract price above $1.
- **Read in the reader's zone:** a naive time is read in the zone the reader chose, and an explicit offset is read exactly. A settled row with no settled time is recorded at its placed time — never "today".
- **Flagged for review:**
  - a payout that disagrees with the price;
  - an unknown status;
  - an unsigned integer price ≥ 21 (decimal or a typo?).
- **Cents:** prices are read as cents only when every price in the column is a whole number from 1 to 99, and the file says so.

**On the server.** The client's checks are advisory; the server re-validates everything.

1. `portfolio_import_classify` validates each row itself (required fields, numbers, dates, actions, prices).
2. It fingerprints each row and finds duplicates:
   - against the reader's existing positions or fills — by platform id first, then fingerprint;
   - against earlier rows of the same file.
3. It then counts: **detected · new · duplicates · needs review · invalid**.
4. `portfolio_import_commit` re-classifies first, so a stale or edited classification is never trusted. It then inserts:
   - **NEW** rows unless skipped;
   - other non-invalid rows only on an explicit `IMPORT` decision. A forced duplicate becomes the next `dedupe_occurrence` — a second bet, never a silent merge.
5. Commit details:
   - **Batched, so no request can outrun the API's statement timeout.** Each call imports at most `p_max` rows (1,000 by default) and returns `{status: 'IMPORTING', remaining}`; the page calls again until it is `COMMITTED`, showing progress. Each call re-classifies only rows not yet imported, so an imported row is never re-flagged as a duplicate of itself.
   - **Fast path, then fallback.** A batch of wagers goes in with one `INSERT … SELECT`. If any row in it is refused, the batch is redone row by row in savepoints, and only the refused rows are recorded as `FAILED`, with the database's reason.
   - **Fills go in a market at a time**, as one statement. The per-fill rebuild is switched off for that statement (`portfolio.bulk_fills`, transaction-local and set only by the commit function), and the position is rebuilt once at the end. A market that fails — for example an oversold one — fails alone.
   - **Measured** (PostgreSQL 16, 5,000-row files):
     - classifying takes about 1–1.5 s;
     - each 1,000-row commit call takes about 0.3 s for wagers and 1–1.5 s for fills (400 markets);
     - COMMIT adds under 0.1 s.

     The tolerant casts decide by pattern before casting, so they open no subtransaction per cell.
   - A fill group joins the position its duplicate fills already belong to, else the reader's open position for that market and side, else a new one.
   - Committing twice imports nothing twice.
   - A `CSV_IMPORT` sync log records the counts.

## 7. Deduplication — the exact algorithm

**Identity order:**

1. A platform id (`external_position_id` / `external_transaction_id`) is the identity: unique per `(user, platform, id)`.
2. Without one, the identity is the **fingerprint**: `SHA-256(material)`, unique per `(user, fingerprint, dedupe_occurrence)`. Occurrence 1 is the default. A reader who confirms "this is a separate, identical bet" stores occurrence 2, 3, ….

**`normText(x)`**, in this order (`public.portfolio_norm_text` ≡ `EDPortfolio.normText`):

1. Unicode NFKD.
2. ASCII A–Z to lower case (locale-independent).
3. Tabs and newlines to spaces.
4. Delete `'` and `` ` ``, then delete every non-ASCII character (accents fall away: *Mbappé* → *mbappe*).
5. Any character outside `[a-z0-9+.@ -]` becomes a space.
6. ` at ` / ` vs ` / ` vs. ` / ` v ` / ` v. ` become ` @ `, then any `@` is spaced as ` @ `.
7. Collapse whitespace and trim.

**`selectionToken(selection, line)`:** `normText(selection)` with `+` removed. If a line is given and the text does not already end with it, append it. So "Chiefs" + −2.5, "Chiefs −2.5", "Over" + 47.5 and "Over +47.5" match the way a reader would expect.

**Numbers:** canonical text with trailing zeros removed (`trim_scale`): 100.00 → `100`, 0.610 → `0.61`.

**Time:** the UTC minute, `YYYY-MM-DDTHH:MM`. The same instant in any zone gives the same minute.

**Material:**

| Record | Material |
|---|---|
| Wager | `pf1|wager|platform|normText(event)|normText(market)|selectionToken|a<american>` or `d<decimal>`|stake|minute(placed_at)` |
| Contract position | `pf1|contract|platform|normText(event)|normText(market)|normText(side)|minute(first buy)` |
| Fill | `pf1|fill|platform|normText(event)|normText(market)|normText(side)|BUY or SELL|qty|price|minute(executed_at)` |

- **What the fingerprint does not depend on:** event text alone, notes, the status (a bet that has since settled is the same bet), or the time zone the file was written in.
- **What never collides:** the same event text with a different pick, price, stake or minute.
- **Parity:** the SQL and JS material match byte for byte over a test corpus that includes accents, curly quotes, emoji and tabs.

## 8. EdgeDesk attribution

- **`edge_source`** is what the reader said: `EDGEDESK` (EdgeDesk research), `SELF` (my own read) or `OTHER`. Nothing is inferred from a matching event or name.
- **An explicit link** (`edge_ref_type`, `edge_ref_id`) may name one of the reader's own EdgeDesk records:
  - `stake_recommendation` → `stake_recommendations.recommendation_id`
  - `research_journal` → `research_journal.entry_id`
  - `card_opportunity` → `card_opportunities.id`
  - `user_bet` → `user_bets.id`
- **The database refuses a link** to a record that does not exist or belongs to someone else (`portfolio_edge_ref_owned`, run as the caller), and any link not marked `EDGEDESK`.
- **The form** offers the reader's 25 most recent sizing recommendations and journal entries. Choosing one copies its `model_version` and `model_probability`.
- **Analytics** already splits P&L and ROI by where the idea came from.

**Later (Phase D)** fills `market_line_at_entry`, `edge_at_entry`, `clv` and `confidence_tier` from the linked record and the captured close. That enables "followed the model vs deviated" and "performance by estimated edge".

## 9. Connectors (the contract for Phase B onward)

`lib/edgedesk_portfolio_connectors.js` defines the contract. **Every connector implements:** `connect`, `disconnect`, `healthCheck`, `sync`, `fetchPositions`, `fetchTransactions`, `normalize`.

`defineConnector()` refuses a connector that:

- misses a method;
- names an unknown integration class (A–G below);
- carries credentials (`API` / `OAUTH` / `AGGREGATOR`) but would run anywhere but the **server**.

**Registered today:** `manual` and `csv`, both with `autoSync: false`.

**The rule that keeps the UI connector-agnostic:** every source produces the same normalized shape — `kind: 'wager'` or `kind: 'fill'`, the same fields the import rows carry. Every source is validated by `validateWager` / `validateFill` and stored through the same tables and the same derive trigger. The page never branches on where a row came from, except to keep synced rows read-only.

**Integration classes:**

- **A** — official API
- **B** — authorized OAuth / account connection
- **C** — approved third-party aggregator
- **D** — user-supplied API credential
- **E** — file / CSV / statement import
- **F** — email / receipt import
- **G** — manual entry only

### The sync engine (designed now, built in Phase B)

The runner is a Supabase Edge Function plus pg_cron, the repository's existing pattern. Edge functions here are single-file and zero-import, so the engine is inlined between markers the same way `tools/presentation/inline.js` does it.

- **Incremental:** from `platform_accounts.sync_cursor`, page by page; the cursor advances only after a page commits.
- **Idempotent:**
  - Rows upsert on `(user, platform, external id)`.
  - Before inserting a synced record with no prior platform id, the connector first claims a matching manual or CSV row by fingerprint, by setting its external id. A reader's hand-entered bet is never duplicated by its synced twin.
  - Settlements update the existing row in place.
- **Failures** go through `classifyFailure`:
  - 401/403 → `ACTION_REQUIRED` (revoked or expired credential; no retry);
  - 429 → back off, honouring `Retry-After`;
  - 5xx / network → retry with `backoffMs` (exponential, capped, with jitter).
  - A partial run is logged `PARTIAL` with counts, and the cursor stays at the last committed page.
- **Every run** writes a `portfolio_sync_logs` row, with error text through `safeLogMessage` (which strips tokens, keys, cookies and signatures).

## 10. Security model and threat model

| Threat | Control |
|---|---|
| Reader B reads or edits reader A's book | RLS on every table (`auth.uid() = user_id`), composite FKs, owner forced by trigger, `security_invoker` view and functions. Tested as B and as anon. |
| A client stores a P&L its inputs do not produce | Every derived column is recomputed by trigger on every write; contract aggregates come only from fills. |
| A forged "Connected" account | Constraint `platform_accounts_status_honest`; readers can only create `MANUAL` / `CSV` accounts and cannot update status, cursor, error or metadata (column grants). |
| Credential theft from the browser or the API | No credential ever reaches the browser. Credentials live as AES-GCM ciphertext (key in Edge Function secrets, `key_version` for rotation) in a schema PostgREST does not serve, with no client grants. Phase A stores none. |
| Asking for sportsbook passwords / scraping | Not done, not offered: no password field exists (tested). A sportsbook is connected only through an integration that platform supports. |
| CSRF | The API is token-authenticated (a bearer header, not a cookie), so a cross-site request cannot carry the reader's identity. OAuth connects (Phase B) use `state` + PKCE. |
| XSS through imported or typed text | Every rendered value is escaped (tested with hostile markup in every field). The CSV is parsed as data, never evaluated. |
| CSV formula injection on export | Cells starting `= + - @` or a tab are prefixed with `'` (tested). |
| Webhook forgery and replay (Phase B) | HMAC signature over the raw body plus timestamp, rejected outside a 5-minute window, delivery id recorded once (the `stripe_webhook` pattern). |
| Secrets in logs | `error_code` is a pattern-checked code; `error_summary` ≤ 500 characters through `safeLogMessage`; nothing financial reaches `console` or `localStorage` (tested). |
| A lapsed subscriber loses their own data | Portfolio RLS is ownership-only, not entitlement-gated: a reader can always read, export and delete their own records. The app-level paywall still governs access to the app. |
| Deleting an account | `on delete cascade` from `auth.users` removes every position, fill, account, import, log and credential (tested). |
| Migration re-run while readers write | The file takes all its tables with `NOWAIT`, retrying without holding any, so it cannot deadlock a reader's save (tested with a concurrent session). |

## 11. Live position tracking (designed, not faked)

- `EDPortfolioUI.registerLiveProvider(fn)` attaches a live read to an open position: `fn(position) → { label, current, line, asOf }`.
- The Open card renders it under the position ("Receiving yards · current 25 · line 58.5").
- **No provider is registered**, because EdgeDesk has no live stat feed wired to positions yet. So nothing is shown — never a placeholder number.
- `event_id` and `event_start_at` are on every position for when one exists.

## 12. Deployment

1. **Apply the schema** (either way):
   - *Actions → Deploy Portfolio schema* (`.github/workflows/deploy-portfolio.yml`). It runs the SQL suite against a throwaway PostgreSQL, then applies `supabase/portfolio.sql` in one transaction with the `SB_DB_URL` secret, and fails on any `CHECK THIS`.
   - Or paste `supabase/parts/portfolio.part1-of-8.sql` … `part8-of-8.sql` into the Supabase SQL editor, in order. The last part prints the report; all 15 rows should read `ok`.
2. **Do not expose `portfolio_private`** in *Settings → API → Exposed schemas*.
3. **Ship the front end:** merging deploys `app.html` and `lib/edgedesk_portfolio*.{js,css}` with the site (GitHub Pages). The script tags carry `?v=20261004pf1`; bump it when a file changes.
4. **Check:** sign in, then *More → Portfolio* (or `/app.html#portfolio`) should show "No positions yet."

## 13. Testing

| Suite | What it proves |
|---|---|
| `npm run portfolio:test` | **Calc (106):** decimals, every sportsbook result and price shape, parlays, YES/NO wins and losses, fees, multiple buys, partial and full sells, voids, scalar settlements, aggregation, periods, time zones and DST, validation, fingerprints. **Import (65):** CSV parsing, every cell reader, both adapters, cents detection, refusals, the connector contract, backoff, error classes, log redaction. **UI (66):** every tab rendered, filters, forms → rows, escaping, honest labels, copy guard, CSV export safety, `app.html` wiring. |
| `npm run portfolio:sql` (167) | The migration applied twice; deadlock-free re-run under a concurrent save; hand-checked SQL money for both instruments; **parity with the JS engine on 30 hand cases + 280 seeded random positions**; SQL ≡ JS fingerprint material and rounding; duplicates (same bet across zones and spellings, occurrences, platform ids); RLS as B and anon; synced rows read-only; attribution ownership; the whole import pipeline (classify counts, review, forced duplicates, partial failure, batched and idempotent commit, fill grouping, re-import); account deletion cascades. |
| `npm run portfolio:e2e` (39) | The page in Chromium against the real migration: empty book, form previews, record bet and contract, totals and split, open card, duplicate caught, edit, delete, CSV import with counts and confirmation, accounts never "Connected", analytics, isolation, no localStorage money, 390 px with no sideways scroll. |
| `node tools/app/navigation.test.js` | The seven-seat bottom bar, More and deep links still hold. |

CI: `.github/workflows/portfolio-tests.yml` runs all of it on every relevant pull request. PostgreSQL and Chromium are both required there.

## 14. Known limitations (Phase A)

- **No automatic sync for any platform.** Manual entry and CSV only (`platform-support.md`).
- **Only generic CSV adapters.** No book-specific importer exists yet, because none should be written without a real export file in hand.
- **The current price of an open contract** is the reader's own mark. There is no market data feed, so unrealized P&L is labelled as such.
- **Partial exits** of a still-open contract position join Total P&L when the position closes (they are shown on the position and on the Overview meanwhile).
- **Deposits and withdrawals** are in the schema but not yet in the UI or in any figure.
- **Parlay legs** are optional and informational. The ticket's combined price and the book's payout are what count.
- **Fingerprint matching across sources** needs the same normalized event, market, pick, price, stake and minute. A manual entry typed a minute off its export is two records until the reader deletes one. Platform ids (Phase B) remove this for synced data.
- **Paste-sized parts.** The `NOWAIT` lock guard covers the single-transaction apply (the workflow, or the whole file at once). Pasting the parts separately on a busy site can still meet a concurrent save; re-run it if so — it is idempotent.
- **Analytics are client-side**, over the reader's rows (paged 1,000 at a time, up to 50,000). A server-side rollup can be added when books get that large.

## 15. Next step: the first automatic connector (Phase B)

**Kalshi**, class A/D: an official, documented trading API. The reader creates their own API key in Kalshi's account settings, and requests are signed with RSA-PSS.

1. **Verify the docs first.** Confirm against Kalshi's current API documentation:
   - the base URL;
   - the signing string and the `KALSHI-ACCESS-KEY` / `-SIGNATURE` / `-TIMESTAMP` headers;
   - the portfolio endpoints (positions, fills, settlements) and their pagination cursors;
   - the rate limits;
   - Kalshi's terms for third-party use of a user's own key.

   Record the findings in `platform-support.md` before writing code.
2. **`supabase/functions/portfolio_connect`:** accepts the key id and private key once over TLS from the signed-in reader. It verifies them with one signed read-only request, encrypts them (AES-GCM, key from a function secret), stores ciphertext in `portfolio_private.platform_credentials`, and creates the `API` / `CONNECTED` account through the service role.
3. **`supabase/functions/portfolio_sync`** (plus a pg_cron schedule and a reader's *Sync now*):
   - pages fills and settlements from the stored cursor;
   - normalizes each fill to the `kind: 'fill'` shape (Kalshi prices are in cents; NO-side contracts map to `side: 'NO'`);
   - claims matching CSV or manual rows by fingerprint before inserting;
   - upserts by `external_transaction_id`;
   - sets `resolution` / `reported_payout` from settlements;
   - logs every run;
   - sets `ACTION_REQUIRED` on 401/403.
4. **Disconnect and reconnect:** disconnect deletes the credential, sets `DISCONNECTED` and keeps the history; reconnect replaces the credential.
5. **Tests:** recorded Kalshi responses as fixtures for initial sync, incremental sync, the duplicate re-run, a settlement update, an expired key, a rate limit, and disconnect / reconnect.
