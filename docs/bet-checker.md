# Bet Checker

A cheaper entry product inside EdgeDesk. A reader logs a bet they **already
placed**; EdgeDesk grades their price against its own fair price at the moment
it is logged, then against its own captured close. **No picks — just
measurement.** Where the pipeline does not own the number, nothing is shown as
if it did: an ungraded bet says why, and a close that is not available says so.

| | Free | Bet Checker (tier **red**) | Research Terminal (tier **blue**) |
|---|---|---|---|
| Log bets | ✓ | ✓ | ✓ |
| Instant entry grade | 10 a calendar month (New York time) | every bet | every bet |
| CLV after the close | ✓ | ✓ | ✓ |
| Running stats, splits by market / sport / book | blurred | ✓ | ✓ |
| History | last 30 days | full | full |
| Price | — | $7.99/month or $59/year | $49.99/month (unchanged) |

The page is **`/bet-checker/`** — its own page, because free and red accounts
cannot open the terminal (`app.html` is behind the paywall). It signs in through
the Games door (`games/lib/auth.js`, configured to return here), the same
`edgedesk_session` the terminal keeps.

## What it builds on

Nothing here is a second copy of something that exists.

| Bet Checker needs | It uses |
|---|---|
| a table of the bets readers placed | **`public.user_bets`** (`supabase/bettor_decisions.sql`), extended. A Bet Checker row is one that names a board event (`event_id`). |
| an events / games table | there is none. A game is **`public.signals.event_id`** (capture's board); a bet's event is checked against `signals` by trigger. |
| odds snapshots and EdgeDesk's fair price | **`signals.sharp_fair`**: capture's de-vigged fair probability for exactly that event × market × selection × line (`sig_key`), refreshed every capture run. |
| the captured close | **`signals.closed_at`, `closing_sharp_fair`, `clv_excluded_reason`**, written by `close` on the same row. |
| the CLV calculation | the house formula, `close/index.ts` `decideClose()`: **entry decimal × no-vig closing probability − 1**, at the same line. |
| settlement | `settle`'s word on that row (`signals.result`, read by `signal_pnl.sql`'s `pnl_result()`), else the Collective's final score (`collective.fg2_event_links` → `fg2_src_games`). |
| EdgeDesk's signals | `signals` rows with `flagged_at` set (capture's frozen entry). |
| who has paid | **`has_bet_checker_paid()`** (`supabase/billing_hardening.sql`) — one helper, every gate. |
| checkout and the renewal consent | `create_checkout_session` and the landing page's consent order, with Bet Checker's own terms (`lib/edgedesk_pricing.js`). |

### `user_bets`: the spec's columns, and where they live

| spec | column | note |
|---|---|---|
| id, user_id | `id`, `user_id` | `user_id` now a foreign key to `auth.users` (validated when every old row names an account) |
| event_id | `event_id` (new) | `signals.event_id`; checked by trigger: on the board, NFL or CFB, not started |
| sport | `sport` | `NFL` / `CFB` (the existing check) |
| market | `market_type` | spread / total / moneyline (the existing check) |
| side | `side` | home / away / over / under; `team` carries the team name |
| line | `line` | NULL for a moneyline |
| odds | `odds` | American |
| book | `book` | Kalshi, DK Predictions, DraftKings, Other |
| stake_units | `units` | default now 1 |
| placed_at | `placed_at` | when logged |
| entry_fair_price | `entry_fair_price` (new) | American, frozen; `entry_fair_prob` keeps the probability every computation uses |
| entry_edge_pct | `entry_edge_pct` (new) | fair probability − the probability the reader's odds imply, in points |
| entry_grade | `entry_grade` (new) | green / yellow / red / ungraded; `entry_grade_reason` says why when ungraded |
| closing_price, closing_line | `close_odds`, `close_line` | the no-vig closing price as American odds, at the bet's line |
| clv_pct | `clv_pct` (new) | percent |
| close_status | `close_status` (new) | pending / captured / no_close_available; `close_reason` says why |
| result | `result` | NULL means pending (the existing check allows win / loss / push / void) |
| graded_at | `graded_at` | when the result was written |
| edgedesk_flagged, flagged_signal_id | `edgedesk_flagged`, `flagged_signal_id` (new) | `flagged_signal_id` is the signal's `sig_key` (a foreign key when `signals.sig_key` is unique) |
| created_at, updated_at | `created_at`, `updated_at` (new) | |

The view **`public.bet_checker_bets`** shows every Bet Checker row under the
spec's names (`market`, `stake_units`, `closing_price`, `closing_line`, `result`
= `pending` while NULL). RLS applies through it.

## The rules — one constant

`public.bet_checker_rules()`:

| | |
|---|---|
| green | edge ≥ **+1.5** points |
| yellow | between |
| red | edge ≤ **−1.5** points |
| free grades | 10 a calendar month, `America/New_York` |
| free history | 30 days |
| "current" fair | seen by capture within 390 minutes (capture refreshes every game at least every six hours) |
| no close | none captured 24 hours after kickoff |

## Logging a bet (`log_user_bet` → `bet_checker_log_bet()`)

One transaction, so the free count cannot race:

1. the caller is the token's (Supabase Auth); the game is on the board, NFL or
   college football, and **not started**;
2. the free allowance, under a per-reader advisory lock. Over it, the bet is
   **saved, ungraded** (`free_limit_reached`), with an upgrade prompt — and
   EdgeDesk's fair is not even looked up, so it cannot leak;
3. EdgeDesk's current fair at **exactly** this event, market, side and line.
   None, or older than 390 minutes: **ungraded** with the reason
   (`no_fair_price_at_line`, `fair_price_stale`). Never interpolated from a
   neighbouring line;
4. edge = fair − implied; grade from the constant; both stored and never
   recomputed;
5. the grade is answered at once; the card draws it.

A double submit is one bet (`client_key` → `bet_key`). Every grade issued is
appended to `bet_checker_grades`, so deleting a bet gives no grade back.

**The "EdgeDesk had this flagged" badge is settled after kickoff, not at
logging.** Answering it at logging time would let a free account log both sides
of every game and read EdgeDesk's live signals one bet at a time. After
kickoff, the grader looks for a signal on the same event, market and side whose
(frozen) `flagged_at` is at or before the moment the bet was logged — the same
answer, revealed when it can no longer be traded on.

## After the close (`grade_user_bets` → `bet_checker_grade_pending()`)

pg_cron, every fifteen minutes at :05 :20 :35 :50 (`supabase/bet_checker_cron.sql`).
`close` writes at most every 35 minutes while games are pending; its own
schedule exists only in the database, so the cron file's report names the
close job it follows. Each part is terminal once written — re-runs change
nothing, and overlapping runs skip each other's rows.

| the bet's line on the board | close_status | |
|---|---|---|
| closed with a usable no-vig probability | **captured** | `clv_pct` = (decimal × closing fair − 1) × 100 |
| closed with `line_pulled_no_close` (the market closed elsewhere), or another exclusion | **no_close_available** | `close_reason` = close's own reason; `close_line` = where the market did close, when that is one line |
| never priced, while the rest of the side closed | **no_close_available** | `line_not_on_board_at_close` |
| nothing closed 24 h after kickoff | **no_close_available** | `no_close_captured` |

`close`'s `no_entry_price` exclusion is about the *signal's* own entry price,
not the close, so it does not stop a reader's CLV.

Result: `settle`'s word on that row, else the final score (spread: margin + line;
total: points vs line; moneyline: winner; equal is a push; a cancelled game is
void). No final, no result.

## Who can do what

| | the reader | anon | service role |
|---|---|---|---|
| read `user_bets` / `bet_checker_bets` | own rows (RLS) | nothing | all |
| insert | own rows; **every grading column is reset** by trigger | — | via `bet_checker_log_bet()` |
| update | `notes` and `status` (void) only — column grants (`bettor_decisions.sql`) | — | the grader |
| delete | own rows | — | |
| `bet_checker_log_bet`, `bet_checker_grade_pending` | — | — | ✓ |
| `my_bet_checker_bets`, `my_bet_checker_stats`, `bet_checker_usage(self)`, `bet_checker_games`, `bet_checker_lines` | ✓ | — | ✓ |

Stats are computed in the database and only for a paid reader
(`my_bet_checker_stats()` answers `{paid:false}` otherwise, with no number);
the page blurs a placeholder.

## Billing: two tiers

**Authorization change.** Before this, `billing_row_grants_access()` granted the
terminal to *any* subscription in good standing — a $7.99 Bet Checker purchase
would have opened the $49.99 terminal. Now:

- `billing_price_tiers` records what each Stripe price sells, learned **only**
  from the product's metadata `tier` (red | blue) by
  `billing_learn_price_tier()`: `create_checkout_session` before anyone can pay,
  the reconciler on every sync. A tier that changes is applied and alerted.
- `billing_row_in_good_standing()` is the old rule (still immutable);
  `billing_row_grants_access()` = standing **and** the price does not sell red.
  A price never learned is the terminal (every price sold before Bet Checker
  was; recorded blue once, on first install), and the reconciler raises
  `unknown_price_tier` for a human.
- `subscriptions.tier` follows the price on every write (trigger), so a
  red ↔ blue switch in Stripe (`customer.subscription.updated`) flips it with
  no code path of its own; `customer.subscription.deleted` ends both.
- `has_bet_checker_paid()` = standing and red or blue.
- `billing_access_for()` adds `tier`, `bet_checker_paid`, reason
  `bet_checker_only` and offer `upgrade`.
- A Bet Checker customer is never sold the terminal's trial beside it
  (`switch_plan`); the terminal's paywall sends them to the billing portal.

Tested by `tools/billing/tier_flow.test.js` (made tier-blind again, it fails 8
checks) and a 150-case grid in `tools/billing/billing_hardening_sql.test.js`.

## Deploying

1. **Billing first** — Actions → *Deploy billing* (`deploy-billing.yml`):
   `apply_sql` (billing_hardening.sql), then `deploy_sync_subscription`,
   `deploy_stripe_webhook`, `deploy_create_checkout_session`.
2. **Bet Checker** — Actions → *Deploy Bet Checker* (`deploy-bet-checker.yml`)
   with `deploy_functions`, `apply_sql`, `set_cron_secret` and `apply_cron`.
3. The page ships with the site (GitHub Pages serves `main`).

### Stripe dashboard

- Product **Bet Checker**: metadata `tier = red`; prices with lookup keys
  `bet_checker_monthly` ($7.99/month) and `bet_checker_annual` ($59/year),
  both **active**, USD, no trial.
- Product **EdgeDesk Research Terminal**: metadata `tier = blue`.
- The restricted keys (`STRIPE_SECRET_KEY` on the three billing functions) need
  **READ on Products** in addition to what they had.
- **Customer portal**: allow switching between the Bet Checker and Research
  Terminal prices (Settings → Billing → Customer portal → Subscriptions → *Customers
  can switch plans*), so a red ↔ blue switch is one subscription changing price.

### Before going live, in production

- `docs/billing-hardening.md` §11 query 10: the production-only paywall RLS
  (`paywall.sql` is not in this repository) must call
  `billing_row_grants_access()` / `community_is_entitled()`, not inline
  statuses — an inline `status in ('active','trialing')` would still let a Bet
  Checker subscription read the terminal's data.
- `bet_checker_cron.sql`'s report row 2 must name the `close` job.

## Tests

| suite | what |
|---|---|
| `tools/bet_checker/bet_checker_sql.test.js` | the SQL on a real PostgreSQL as two readers, anon and the service role |
| `tools/bet_checker/functions.test.js` | the shipped functions against that SQL |
| `tools/bet_checker/core.test.js`, `page.test.js` | the page's arithmetic, words and wiring |
| `tools/bet_checker/page.e2e.js` | the page in Chromium against the real stack |
| `tools/billing/tier_flow.test.js` | red / blue through the shipped billing functions |

CI: `.github/workflows/bet-checker-tests.yml` (category *frontend-navigation*)
and `personal-tests.yml` (billing).
