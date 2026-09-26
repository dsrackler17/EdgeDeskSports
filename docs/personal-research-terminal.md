# The personal research terminal

*Research, not picks.* This upgrade turns EdgeDesk from a board a reader opens
into a research terminal that watches the market with them: a watchlist on the
account, research-condition alerts, a Top 5 list ordered by research-worthiness,
a decision journal that freezes EdgeDesk's numbers at decision time and grades
the reader's number against the close, a partner program, live activity counts,
and an AI desk that can answer from all of it.

**No model methodology changed.** Nothing here computes a fair line, a win
probability, a reliability score, a research label or a status. Every number a
reader sees is one the football module already produces, read through one
function (`fbResearchStateOf` in `app.html`), or a count, difference or average
of those numbers.

## 1. What was found (the audit)

| Area | As found | Reused |
|---|---|---|
| Frontend | `app.html` single file, research shell with a Desk landing (`renderResearchDesk`), settings shell (`SETTINGS_SECTIONS`) | The desk hosts the new hierarchy; settings host three new sections |
| Auth | Raw GoTrue/PostgREST `fetch`; session in `localStorage.edgedesk_session`; `edToken()` / `edUser()` | Every new call uses the reader's own token |
| Personal data | **Device-local only**: Desk watchlist (`ed_research_watch_v1`), follow timeline (`ed_research_follow_v1`), CLV ledger (`edgedesk_bets`), preferences (`edgedesk_prefs`) | Local follows are imported once into the account watchlist |
| Top 5 | `lib/research_priority.js` already ordered "5 Games Worth Researching" by research-worthiness, never by raw gap | The Top 5, the server ranking and the AI answer all use it unchanged |
| Reliability | CFB only, 0–100 (`lib/cfb_reliability.js`); the NFL model publishes none | Shown as "not scored" for the NFL, never invented |
| Market | Browser reads captured `signals`; `close` writes closes; `record/football/*.json` carries finals and consensus closes hourly | The job reads captured quotes only; grading reads the committed finals |
| Stripe | Payment Link + `stripe_webhook` writing `subscriptions` and a full-event ledger `stripe_events`; promo-code attribution on `subscriptions.referral_code` | Affiliate conversions are read from `stripe_events` by trigger — no webhook redeploy |
| Referrals | First-touch `?ref=` capture on the landing page (`attrCapture`, cookie `ed_ref`), `public.referrals` written by the page | The account claims that code server-side; `referrals` stays the marketing record |
| Notifications | None in-app; Resend only for the newsletter | In-app notification centre built; email left as a channel column |
| AI | `edgedesk_ai`: kernels inlined by `tools/presentation/inline.js`; desk turn = deterministic text → optional rephrase → critic | A new turn (`mineTurn`) and kernel (`_mine.js`) in the same shape |

## 2. Data model (`supabase/personal_research.sql`, `supabase/affiliates.sql`)

Personal tables (RLS: a reader reads and writes only their own rows, `user_id = auth.uid()`; nothing takes a user id as an argument):

| Table | Purpose | Integrity |
|---|---|---|
| `research_leagues` | Leagues a reader can pick (cfb, nfl). A new league is a row | Read-only to clients |
| `user_preferences` | Onboarding: leagues, books, interests, status | Unknown league refused by trigger |
| `alert_preferences` | Every alert threshold and toggle | Range check constraint |
| `watchlist_games` | One row per (reader, game) | `unique (user_id, game_key)`; 200-game cap; readers may update only the seen-state columns |
| `user_alerts` | The notification centre | `unique (user_id, dedupe_key)`; tout-language check constraint; readers may only set `read_at` / `dismissed_at` |
| `research_journal` | Decisions with the information set at decision time | Snapshot columns **write-once for everybody** (trigger); server stamps time and copies the shared state; close/grade writable by the grading job only |

Shared tables (service role writes, entitled readers read — the paywall's
`community_is_entitled` when installed):

| Table | Purpose |
|---|---|
| `game_research_state` | Latest `edgedesk_research_state/1` per upcoming game, plus lifted columns |
| `game_research_history` | Every distinct state, appended by trigger when the hash changes |

Views and functions: `my_watchlist` (security invoker), `edgedesk_proof_metrics()` (anon-callable counts only).

Affiliate tables (no client can read money, clicks or attributions directly;
partners read their own counts through `affiliate_my_dashboard()`, admins through
`affiliate_admin_*` functions guarded by `affiliate_is_admin()`):
`affiliate_settings` (the economics, one row), `affiliate_admins`,
`affiliate_accounts`, `affiliate_clicks` (one per visitor per day, hashed id),
`affiliate_attributions` (one per account, first valid wins),
`affiliate_conversions` (idempotent by dedupe key), `affiliate_commissions`
(amounts never edited, never deleted; status walks forward only).

## 3. The research state and the job

`window.fbResearchStates()` (football module in `app.html`) returns one state per
board game, built from `fbGameRows` + `fbWrCandidate` + the reading order +
`fbBrStarters` / `fbGameQbContext` + the availability readers. The browser uses it
live; `tools/personal/research_state.js` runs the **same function headlessly**
through `tools/articles/research_host.js`, with a read-only `sbFetch` limited to
GETs on the capture tables, and:

1. upserts every upcoming game's state (a started game is never rewritten — its
   last pregame state is the journal's close);
2. sends research-condition alerts to watchers of changed games (and to readers
   who opted into league-wide threshold alerts), deduplicated by key, with a
   3-hour per-kind cooldown and 25 alerts per reader per run;
3. writes the close, CLV and — once `record/football/<league>_<season>.json`
   carries the final — the result of wagered journal entries;
4. calls `affiliate_reconcile()` to replay the Stripe ledger idempotently.

Scheduled by `.github/workflows/research-state.yml` at :38 every hour. It spends
no odds-provider credit.

**Research-grade** = the game clears every gate of the research-priority order
(a projection, a current market, no data fault, no thin data, no stale quote,
something to explain) and, in college, the research view does not call it LOW
RELIABILITY or LIMITED DATA.

## 4. CLV and decision quality

- Spread: `EDResearch.clvPoints(side, entryHomeLine, closeHomeLine)`.
- Total: close − line for an over, line − close for an under.
- Moneyline: `EDResearch.clvPrice` (no-vig close probability − break-even of the price taken).
- Close: the last non-stale market EdgeDesk held before kickoff (`game_research_history`), else the committed record's consensus close, with its source recorded.
- An entry saved after kickoff gets a result but no CLV.
- Process (CLV, beat-the-close) and result (W/L/P) are separate columns and separate panels. No profit or ROI figure is computed anywhere.

## 5. Affiliate attribution

1. `/?ref=CODE` → `affiliate_track_click` (anon; one per visitor per day; only an md5 of a random first-party id is stored).
2. After signup (landing page) or on the first signed-in app load → `affiliate_claim(code, visitor)`: refuses self-referral, an existing customer (unless the tracked click precedes their subscription), a click outside the attribution window, and any second attribution.
3. Stripe events land in `stripe_events` as today → trigger `affiliate_on_stripe_event` → `affiliate_process_event`: trialing → trial; paid invoice → paid/renewal + commission (rate × (amount paid − tax), pending until the hold passes); cancellation → canceled; `charge.refunded` → void (unpaid) or proportional clawback (paid). A sale made with the partner's Stripe promotion code and no link is attributed by the code.
4. Admin console `/admin/affiliates/`: settings, partners, approve / record payout (reference required) / void, reconcile. **No money moves**: payouts are recorded after they are made elsewhere.

## 6. Rollout (manual steps)

1. SQL editor: run `supabase/personal_research.sql`, then `supabase/affiliates.sql` (after `billing.sql`, `stripe_webhook.sql`, `referral_codes.sql`). Every report row should say `ok`. Re-run `supabase/referral_codes.sql` to pick up the revenue-view fix.
   Both files are safe to re-run on the live site: each takes every lock it needs up front, all at once, so it cannot deadlock with a webhook or a reader saving a journal entry. If one reports it could not take its locks within 30 seconds, nothing was changed — run it again.
2. Insert the owner into `public.affiliate_admins` if report row 7 says none yet.
3. In the Stripe dashboard, add **`charge.refunded`** (and optionally `invoice.paid`) to the webhook endpoint's events. Nothing else changes on the webhook.
4. GitHub → Actions → "Personal research state" → Run workflow once (it uses the existing `SB_URL` / `SB_SERVICE_ROLE` secrets).
5. Redeploy `edgedesk_ai` through "Deploy intelligence" (build `edgedesk_ai-2026-09-25-r17-mine`). Optional: `EDGEDESK_MINE_NARRATE=1` lets the model rephrase personal answers under the critic; default is EdgeDesk's own words.
6. Set the commission rate and program terms in `/admin/affiliates/` (default 25% for 12 months, 30-day hold, program by invitation).

## 7. Tests

| Suite | What it proves |
|---|---|
| `tools/personal/personal_sql.test.js` | Migration twice, all ok; cross-reader RLS on every personal table; duplicate watchlist refused; alert dedupe; tout copy refused; journal snapshot write-once for everybody, even after the state moves |
| `tools/personal/affiliates_sql.test.js` | Clicks, claims, self-referral, existing customer, first-wins; trial/paid/renewal/refund/clawback/cancel from real event shapes; money immutable; admin-only doors; the revenue-view fix |
| `tools/personal/personal.test.js` | Alert wording (the brief's examples), thresholds, dedupe, cooldown, Top-5 explanations, CLV arithmetic, analytics; the job's DB pass against the in-memory PostgREST |
| `tools/personal/personal_wiring.test.js` | One source for the offer; sportsbooks = capture keys; the page wiring; no tout language in the new code |
| `tools/intelligence/mine.test.js` | The AI kernel and the real handler: reads under the caller's token, no cache across readers, refuses to invent, falls through for betting questions |
| `tools/personal/personal_ui.e2e.js` | Chromium, desktop and 390px: onboarding, desk order, Top 5, star, alerts, journal, analytics, settings, partner, AI panel, landing offer |

## 8. Known limits and technical debt

- **NFL reliability is not scored** by the model; NFL games show "not scored" and cannot be screened by the reliability alerts.
- **Email/push alerts** are not sent: `alert_preferences.email_digest` and `user_alerts.email_status` exist for a future sender (Resend is already configured for the newsletter).
- **The server state is hourly.** Between runs the desk shows the live browser state when the board is loaded, else the server's, and says which.
- **"Which games improved after QB confirmation"** is answered for the reader's watched games (whose history the desk reads), not the whole slate.
- **Reliability history** keeps each state's score and main deduction, not the full six-component breakdown, so a change cannot be attributed point by point; the desk says so.
- **Device-local stores remain**: the CLV ledger (`edgedesk_bets`) and saved research are still per-browser; the journal is the account-level successor, and the two are not merged.
- **Pre-existing**: the in-app paywall's Payment Link (`PG_STRIPE_LINK`) differs from the landing page's and skips the auto-renewal consent record; new accounts are now routed through the consented trial flow, lapsed ones still use it.
- **Pre-existing, fixed separately**: `referral_invoice_payments` read invoice fields at the top of the payload, but the webhook stores the whole event, so the view was empty in production.
