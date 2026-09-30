# The funnel upgrade

*One football research terminal for the game, the market, and the players.
Research, not picks.*

visitor → understands EdgeDesk → sees real value → starts a trial → opens the
terminal → finds useful research → comes back → pays. This upgrade rebuilt the
landing page around **live research from the database**, gave a new trial a
first screen that shows what EdgeDesk found today, put one event stream under
every step, gave the operator a dashboard to read it, and added the four trial
emails. No model, price or decision rule changed.

## 1. What a visitor sees now (`index.html`)

| Order | Section | Reads |
|---|---|---|
| 1 | **Hero** — *NFL + CFB RESEARCH TERMINAL · Find where the model and the market disagree.* "Explore today's board" (primary) · "Start free trial". Live stats: games analyzed, research-grade opportunities, player props tracked, sportsbook quotes, updated X ago — each hidden when the data does not have it. Beside it, the **live research preview**: 2-4 current RESEARCH / WATCH items (a game with its market, EdgeDesk's number, the gap, the book, the capture time, its player props, and "See why EdgeDesk disagrees →"). | `public_home_board()` + `football/home/board.json` |
| 2 | **Today on EdgeDesk** (`#today`) — tiles (games analyzed, game-market research, player-prop research, watching, passes, last model update, last odds update) and up to six game cards | same |
| 3 | **Game + props workflow** (`#workflow`) — one game card with its **Player markets** rows (RESEARCH / WATCH / PASS), live when a game has priced props | same |
| 4 | **Price the players too** (`#props`) — the prop table: Player, Prop, Market, EdgeDesk, Difference, Best odds, EdgeDesk EV, Status (RESEARCH · WATCH · PASS · DATA INCOMPLETE), and what a prop card holds | `board.json` |
| 5 | Why it's different · 6 product preview · 7 trust / public record ("Nothing quietly disappears after kickoff.") · 8 who it's for · 9 pricing · 10 FAQ · 11 final CTA | |

The long explanations (the one-game walkthrough, the EV slider and ladder,
the model, prop methodology, statuses, uncertainty, the record) moved to
**`/methodology/`**. The page stopped downloading ~7 MB of artifacts on load:
it now makes **two small parallel reads** (one RPC answered from a 60-second
server cache, one ~28 KB static file) with a 7-second deadline each, caches
them for 90 seconds in `sessionStorage`, and lazy-loads the graded record when
it nears the viewport.

### The honesty rules (all in `lib/edgedesk_home.js`, one view model for the page, the first run and the emails)

- **No data → no number.** A missing count is `null` and its stat is hidden; a
  zero headline is hidden rather than printed as a claim. Nothing is ever
  filled in.
- **Staleness is judged at view time, against the reader's clock.** A game
  market older than 3 h is DATA INCOMPLETE ("The last sportsbook price on file
  is stale."). A prop price is FRESH ≤15 min, AGING ≤30, STALE ≤90 (a
  research-grade prop becomes WATCH with "re-check it"), EXPIRED beyond
  (DATA INCOMPLETE, and **no EV is printed** for it).
- **Headlines follow the downgrade.** A game the database called RESEARCH whose
  market has gone stale since is subtracted from the research count; a
  league's prop count is used only while its capture is inside 30 minutes and
  the props printed from it still hold up.
- **A board with nothing refreshed in 3 hours stops calling itself live**
  ("Last update · 5 h ago", amber, no green dot).
- **An NFL consensus market says what it is**: "consensus reference, not a
  captured quote" — it has no capture time to print.
- **When both reads fail**, the preview is the labelled example ("Example game
  · not live"), the stats hide and the board says it could not be reached.
- **"See why" never leaks the terminal**: a subscriber goes to the game in the
  terminal, a signed-out visitor to an admin-chosen public sample
  (`public_sample_games`, growth.sql) when there is one, otherwise the trial.
- The four public words are the only words: RESEARCH, WATCH, PASS,
  DATA INCOMPLETE. Never BET, LOCK or PICK. `ed_public_status` (SQL) and
  `EDHome.publicStatus` (JS) are held equal over 1,920 combinations by
  `tools/home/home_sql.test.js`.

## 2. The trial's first screen (`lib/edgedesk_first_run.js` + `.css`)

For an account younger than 14 days that has not hidden it, the Research view
opens with an inline panel (never a modal): **"Here's what EdgeDesk found
today."** — largest model–market disagreements, research-grade game
opportunities, research-grade player props, games with incomplete information
(each with its reason) and recently changed markets, all read from the
reader's own `game_research_state` rows plus `board.json` through the same
view model. Above them, five steps with progress: view today's board, open a
game, open a player prop, compare a sportsbook price, save or watch research
(ticked by what the reader actually does, from the server's
`ed_first_run_state()` and this device).

**Optional preferences** sit in the panel: sports (NFL / college), what you
research (game lines / player props / both), sportsbooks, favorite teams (from
this week's slate). Saved to `user_preferences`; used to order what the panel
shows first and to star favorite-team games; one tap to skip. While those are
pending, the older six-step onboarding modal waits, and once they are saved
or skipped it does not ask again — one welcome, not two.

## 3. One event stream (`supabase/funnel.sql`, `lib/edgedesk_track.js`)

`public.user_events` has the columns the brief asked for (`id, user_id,
anonymous_session_id, event_name, event_properties, created_at, page_path,
referrer, utm_source, utm_medium, utm_campaign`) plus a unique `dedupe_key`.

| Event | Source | Counted |
|---|---|---|
| landing_view · landing_live_board_view · pricing_view | page | once a session |
| cta_clicked (`props.cta` names which) | page | once per CTA a session |
| signup_started | page | once a session |
| account_created | trigger on `auth.users` | once |
| checkout_started | page (before the Stripe redirect, keepalive) | once a session |
| trial_started · subscription_started · subscription_cancelled | triggers on `subscriptions` / `stripe_events` (comps excluded; "started" = a real charge) | once per subscription |
| terminal_opened | terminal | once a session |
| first_run_viewed · onboarding_skipped | terminal | once |
| preferences_saved | terminal | once a day |
| board_viewed · prop_board_opened | terminal | once a session |
| game_opened · prop_opened · ev_viewed · custom_price_checked · research_saved · brief_copied | terminal | once per game/prop a day |
| second_session · return_day_1 / 3 / 7 | derived from terminal events | once |

Duplicates are stopped twice: the client queues a name+entity once per page
load (a re-render or double click cannot reach the network), and the database
dedupes by each event's rule. Events are batched (~1.2 s, ≤25 a request,
flushed with keepalive when the page hides). **Nothing private is sent**: no
e-mail, no name, no token in the body, no query string, the referrer's host
only; the user is taken from the access token; the visitor id is stored only
as `md5('edgedesk-acq:' || id)` (the same hash growth.sql uses). GA4 keeps
receiving the page's existing events.

## 4. The operator's dashboard (`/admin/funnel/`)

Operators only (the partner program's list, `growth_is_admin()`). Visitors,
landing CTA %, signup %, trial start %, terminal activation %, game-open %,
prop-open %, day-1/3/7 retention, trial-to-paid % (only trials whose 7 days
have ended), cancellation %; the funnel in three sections (landing visitors ·
all new accounts · what trials did) with the biggest drop marked and a table
view; where each trial stopped; cohorts by signup week, traffic source
(growth.sql attribution), NFL vs CFB, stated focus and **what they actually
opened** (game lines / props / both). A rate with no denominator is "—", never
0%. Signup is landing visitors *linked* to a new account over landing
visitors, so it cannot pass 100%; accounts with no tracked landing visit are
reported separately. The page also holds the trial-email controls.

## 5. The trial emails (`supabase/lifecycle_email.sql`, `tools/lifecycle/`)

| Email | When | Says |
|---|---|---|
| **Your EdgeDesk terminal is live** | right after the trial starts | the live counts, the two games worth opening first, three first steps, the trial end date and the promise of a reminder |
| **Today on EdgeDesk** | ~24 h in | the current research-grade games and props, each with its capture time |
| **New on EdgeDesk since …** | ~72 h in | what changed since the reader's last visit |
| **Your EdgeDesk trial ends on …** | 48 h (configurable 24-120) before the first charge | the exact date and the amount Stripe holds, how to cancel — a billing notice, no teaser |

Built at send time from the same view model (stale prices are never quoted;
an empty board says PASS is a normal answer), refused if a word fails the copy
rule, sent through Resend with an Idempotency-Key per row. Tips carry a
one-click opt-out (`/email/unsubscribe/`); the billing reminder is not a tip.
**Sending is off until an operator switches it on in `/admin/funnel/`.**

## 6. One source for the price (`lib/edgedesk_pricing.js`)

The offer is **EdgeDesk Full Access: 7 days free, then $49.99/month** — the
standard price, not a founding or introductory rate (dsrackler17/EdgeDeskSports#427).
`PRICE_CENTS`, the trial, the plan name, `FEATURES` (the plan card's and the
paywall's list) and the two Stripe Payment Links live in that one file. The
funnel adds only derived helpers there: `money()`, `TRIAL_LABEL` ("7 days
free"), `FIRST_CHARGE_DAY` (8) and `renewalLine()` for the emails, and the
`trial` / `day8` placeholders to the `data-ed-price` words `EDPricing.apply`
fills. Every figure on the landing page, the methodology page, the terminal,
the sample page and the emails reads from it.

**Checkout stays closed until the $49.99 Payment Links exist.**
`CHECKOUT_LINK` and `RESUBSCRIBE_LINK` are empty and the old $79.99 links are
refused by name, so "Start free trial" opens the terms and then stops — before
a consent is recorded or a card is asked for — with "Checkout is being
updated". To open it: create the $49.99 Price and Payment Links in Stripe,
paste them there, and run `node tools/billing/verify_stripe_offer.js`.

The renewal reminder always states the amount on the reader's own Stripe
subscription item, so a reader who started on the earlier $79.99 price is
reminded of $79.99, not of the new standard price.

## 7. Deploying

1. **SQL, in this order** (each is idempotent; each ends in report rows that
   must all say `ok`): `supabase/funnel.sql` (needs billing, stripe_webhook,
   personal_research, affiliates and growth already applied — the guard says
   so) → `supabase/home_board.sql` → `supabase/lifecycle_email.sql`.
2. **Merge** — GitHub Pages serves the site. The landing page works before
   step 1 (it falls back to the labelled example and `board.json`), and the
   terminal works too (the first run stays hidden and events are dropped).
3. `football/home/board.json` is rebuilt by `player-props.yml` on every run;
   `npm run home:build` rebuilds it by hand.
4. **Trial emails**: the repository secrets `SB_SERVICE_ROLE` and
   `RESEND_API_KEY` already exist for the newsletter; `lifecycle-email.yml`
   runs hourly. Check `from_email`, `reply_to` and `mailing_address` in
   `lifecycle_settings`, run it once by hand with *dry_run* (prints, releases
   the rows), then switch sending on in `/admin/funnel/`.

## 8. Tests

| Suite | What it holds |
|---|---|
| `tools/home/home.test.js` | the view model (no fabrication, view-time staleness, recounts, the preview), the tracker (dedupe, sanitizing, batching, token use, registry parity), `board.json` |
| `tools/home/home_sql.test.js` | `public_home_board()` on a real PostgreSQL: anon can call only it, a subset, the four words, the cache, samples; JS ↔ SQL status parity |
| `tools/funnel/funnel_sql.test.js` | events, dedupe, rate limits, triggers, the first-run state, the admin report, the email queue, claim/skip/release, unsubscribe |
| `tools/lifecycle/lifecycle.test.js` | the four emails, the copy rule, the sender (no secrets / off / Resend / failure / dry run / refusal), the workflow and the opt-out page |
| `tools/home/landing.e2e.js` | the landing page at 375 · 390 · 430 · 768 · 1280: no overflow, CTAs above the fold and ≥44 px, live data, funnel events once each, UTM; stale data; both reads down; methodology |
| `tools/funnel/first_run.e2e.js` | the first run for a new trial, preferences, skip, progress, hide, an old account, no second onboarding |
| `tools/funnel/admin_funnel.e2e.js` | the dashboard from the real report, the email switch, a non-operator |

`npm run funnel:test`, `funnel:sql`, `funnel:e2e`; `.github/workflows/funnel-tests.yml`
runs all three on a pull request. `npm run funnel:fixtures` rewrites the two
fixtures from the real SQL.

## 9. What this does not do (yet)

- Checkout is closed until the $49.99 Stripe Payment Links are pasted into
  `lib/edgedesk_pricing.js` (section 6); the funnel's `checkout_started` and
  `trial_started` steps stay at zero until then.
- Funnel events start the day `funnel.sql` is applied; there is no backfill of
  landing or terminal behaviour (accounts, trials and payments are backfilled
  from existing rows).
- EdgeDesk EV for **NFL game lines** is not stored anywhere public, so the
  landing page shows game EV for college games only; NFL rows show the fair
  line, the market and the gap.
- NFL game markets are a consensus reference with no capture time, so their
  age cannot be judged at view time; every NFL market line is labelled
  "consensus reference, not a captured quote" wherever it prints.
- Routes run, target share, snap counts and offensive-line data are not in the
  prop feed, so the landing page does not claim them as reasons.
