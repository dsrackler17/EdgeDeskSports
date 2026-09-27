# The growth upgrade

*Research, not picks.* Seven additions on top of the personal research terminal
([`personal-research-terminal.md`](personal-research-terminal.md)): Compare My
Number, shareable research cards, trial activation analytics, acquisition
attribution, persona-based onboarding, public sample research and flexible
creator offers.

**No model methodology changed, and no second system was built beside an
existing one.** Every number a reader sees is still a research state's own
number (`fbResearchStateOf` in `app.html`), or a difference, count or average
of such numbers.

## 1. What each feature extends

| Feature | Extends | New pieces |
|---|---|---|
| Compare My Number | the decision journal (`research_journal`), its write-once information set, the hourly grading job | `my_home_line` / `my_total` columns; `EDPersonal.compareNumber`; the compare modal and desk section |
| Research cards | the research state; the copy rule (`edp_copy_ok`) | `lib/edgedesk_share_card.js`; `share_cards` (the record of what was printed) |
| Trial activation | the watchlist, journal, alert-settings and card rows themselves | `activation_settings`, `activation_events`, `user_activation` (`supabase/growth.sql`); `edp_track()` |
| Acquisition attribution | the landing page's first-touch capture (`attrCapture`, `edgedesk_visitor`) | `acquisition_visitors`, `user_acquisition`, `acq_track_visit()`, `acq_claim()` |
| Persona onboarding | onboarding and `user_preferences` | `user_preferences.persona`; `EDPersonal.PERSONAS` / `personaPlan` |
| Public sample research | the shared `game_research_state` | `public_sample_games`, `public_sample_research()`; `/research/sample/` |
| Creator offers | the partner program (`affiliates.sql`) and the Stripe ledger | `affiliate_campaigns`; term snapshots on `affiliate_attributions`; `affiliate_offer()` |
| AI desk | `_mine.js` personal answers | the `MY_NUMBERS` intent |
| Admin | `/admin/affiliates/` (campaigns live beside the program) | `/admin/growth/` (activation, funnel, thresholds, samples) |

## 2. Compare My Number

A reader enters a fair spread for either team (or PK) and, optionally, a fair
total. As they type, the modal shows **their number, EdgeDesk's fair number and
the current market number**, and the three differences (you vs EdgeDesk, you vs
market, EdgeDesk vs market), each with its direction in words ("Your number is
5.2 pts more favourable to Florida than EdgeDesk's").

It then says, from the research state's own fields:

- **where the reader agrees** — the same favourite; within half a point; both
  numbers on the same side of the market; both totals above or below it;
- **where they differ** — a flipped favourite; how far apart (close under 1.5,
  moderate under 3, material from 3); opposite sides of the market; a key
  number (3, 7) lying between the two numbers;
- **which of EdgeDesk's measured inputs the difference runs through** — the
  engine's own additive terms on the side its fair line favours
  (`lib/cfb_research_view.js` `leanReasons`), largest first, until they cover
  the difference; when the reader is *further* toward EdgeDesk's favourite than
  EdgeDesk, it says EdgeDesk's inputs do not go that far; when the state carries
  no itemised drivers (the NFL today) or the difference is in the total, it says
  the difference **cannot** be traced to an input rather than inventing one;
- **what EdgeDesk's number knew** — an unconfirmed quarterback, a missing
  availability report, reliability and its main deduction, market movement,
  the model version and time.

It never declares either number correct (`NEUTRAL_NOTE`; the suite checks the
words). **Save my number to my journal** writes a journal entry (researching,
passed or leaned) with the reader's number and EdgeDesk's frozen snapshot. The
entry is **write-once** — a changed mind is a new entry, so every number a
reader enters is preserved. After kickoff the grading job records the close
beside it; the journal and Decision quality then show each number's distance
from the close (a distance, not a verdict; small samples say so).

## 3. Research cards

`Share card` on any game card, watchlist row or Top 5 row, and the desk's
*Share research cards* section. Signed-in readers only.

- **Content** (`EDShareCard.content`): matchup, league, kickoff, EdgeDesk fair
  line, market line (book and capture time), model–market gap and which side
  EdgeDesk's number favours, reliability (or "Not scored" for the NFL), 2–3
  research drivers (the engine's own measured terms, else the state's research
  reasons), the research state's timestamp, **"Research, not picks."** and
  **edgedesksports.com**.
- **Real current data only**: no card without a projection, after kickoff, or
  from a state older than 6 hours; a missing or stale market is printed as
  missing and no gap is claimed.
- **Sizes**: X / landscape **1600×900** (16:9, X's in-feed image) and square
  **1080×1080**. Download, native share (with the image where the device
  allows), copy text, or open an X post with the same numbers.
- Every string passes the copy rule in the browser, and again in the database
  when the card is recorded in `share_cards`, which also refuses a game the
  shared state says has kicked off.

## 4. Trial activation analytics

Trial actions become deduplicated rows in `activation_events`:

| Action | Recorded by | Deduplicated per |
|---|---|---|
| matchup viewed | `edp_track` (game open, card expand, "Research matchup") | game per day |
| repeat visit | `edp_track('visit')` on a later day than the first | day |
| watchlist save | trigger on `watchlist_games` (device imports excluded) | game |
| AI research used | `edp_track` (a question or quick action in the AI panel) | day |
| Compare My Number used | `edp_track` and the journal trigger | game per day |
| journal entry created | trigger on `research_journal` | entry |
| Top 5 Research opened | `edp_track` when the desk shows the Top 5 | day |
| alert configured | trigger on `alert_preferences` | once |
| share card generated | trigger on `share_cards` | card |

The client door (`edp_track`) accepts only the client-only kinds, so a page can
neither forget nor forge a watchlist save, a journal entry, an alert setting or
a card. A failure to record an action never fails the reader's own write.
Existing rows are backfilled when `growth.sql` runs (idempotently).

**States** (`user_activation`), replayed from the events in order under the
one-row `activation_settings`:

- `EXPLORING` at `exploring_min_points` (default 1);
- `ACTIVATED` at `activated_min_points` (8), `activated_min_kinds` (3) distinct
  kinds, `activated_min_active_days` (2) active days and — by default — at
  least one core action (watchlist, alert, Compare My Number, journal, card);
- `POWER_USER` at 25 points, 5 kinds, 5 active days.

Each kind has a configurable weight, counted at most `per_kind_cap` (5) times.
Each state is stamped with the event that first met it, so **time to
activation** is measured, and changing a threshold recomputes history. **No
client role can read the state or the events**; nothing in the product shows a
reader their score.

**Admin** (`/admin/growth/`): trials, activated trials (ACTIVATED inside the
trial), activation rate, paid conversions, trial-to-paid, activated-to-paid
beside not-activated-to-paid, time to activation (median, p75), the state mix,
how many trials took each action, weekly cohorts — and the threshold editor. A
trial is what Stripe's subscription events say (resolved through the customer
when the event names no user); a paid conversion is a real charge (a $0 trial
invoice is not).

## 5. Acquisition attribution

Sources: `organic_x`, `x_dm`, `creator_affiliate`, `linkedin`, `search`,
`direct`, `referral`, `other` — assigned by one rule in `acq_classify`
(`supabase/growth.sql` states it in full): an explicit `utm_source` that is a
source key wins; a `?ref=` that belongs to a creator (account or campaign) is
`creator_affiliate`, any other ref `referral`; paid mediums are `other`; X is
`organic_x` or, with `utm_medium=dm`, `x_dm`; LinkedIn, search engines by
`utm_source` or referrer; EdgeDesk itself and Stripe checkout are `direct`;
anything else with a referrer is `referral`.

- **Visits**: the landing page and the public sample page call
  `acq_track_visit` (anon) with the raw signals; only a hash of the page's
  random visitor id is stored.
- **First touch** is the first *attributable* touch; a direct visit is a
  placeholder that the first attributable one replaces once, then it is
  **frozen** (write-once by trigger, even for the service role).
- **Last touch** is kept separately: the latest attributable touch.
- **Accounts** claim their touches after signup (landing page) and on the first
  signed-in app load (`acq_claim`); only touches made up to an hour after the
  account was created count.
- **The affiliate ledger is never touched.** Who a creator is paid for is
  decided by `affiliate_attributions` alone (first valid wins). The funnel
  shows both side by side: an account can arrive from search and still be
  credited to the creator whose link it clicked first.

**Admin funnel**: source → visitors → accounts → trials → activated trials →
paid → retained (at least `retained_min_paid_invoices`, default 2 — it renewed),
by first or last touch, with creator-credited accounts counted beside it.

## 6. Persona-based onboarding

Onboarding's first step asks **"What best describes how you research?"** — one
tap, five answers, skippable. A reader who finished onboarding before the
question existed is asked once on the desk ("Not now" dismisses it).

| Answer | Desk opens with |
|---|---|
| I build my own numbers | Compare My Number |
| I research games before betting | Top 5 Games to Research |
| I compare markets and prices | My Watchlist (market-move and key-number alerts) |
| I create betting content | Share research cards |
| I want to improve my process | My decision quality |

`EDPersonal.personaPlan` moves one section to the front; **every plan keeps
every section** (the suite checks all six plans). It can be changed any time in
Settings › Research preferences.

## 7. Public sample research

`/research/sample/?game=<game_key>` (and a list at `/research/sample/`), readable
without an account, for games an admin makes public in `/admin/growth/` (with an
optional end time). The page shows the fair line and fair total, the market
(book, capture time, stale flag), the gap and its direction, reliability and its
main deduction, the key reason, up to three measured drivers, quarterback
confirmation and availability counts, and the methodology in plain language —
then **"Research the full board"** with the whole offer, **"7-day free trial.
$79.99/month after trial. Cancel anytime."** (from `lib/edgedesk_pricing.js`).

`public_sample_research()` returns only that subset: win probability, the
research-priority ranking, the full driver list, line movement, the rest of the
board and everything personal never leave the database; the page names them
under *In the full terminal*. The page is `noindex` — the indexable half of
EdgeDesk is `/articles/`. A partner code arriving on the page travels on to the
landing page's CTA.

## 8. Flexible creator offers

`affiliate_campaigns`, per creator, per code:

| Field | Meaning |
|---|---|
| `code` | the code in the link (`?ref=`) and at checkout |
| `discount_type`, `discount_amount`, `discount_duration`, `discount_duration_months` | the customer's discount, in Stripe's own words (percent or dollars; once / repeating / forever) |
| `stripe_promo_code`, `stripe_promotion_code_id`, `stripe_coupon_id` | Stripe's objects behind it |
| `commission_rate`, `commission_type`, `commission_duration_months` | the creator's terms: a fraction of what Stripe collected less tax; recurring (for N months, or the program setting) or one-time (first payment only) |
| `starts_at`, `expires_at`, `active` | the window and the switch |

- **Stripe is the source of truth for the discount.** `promotion_code.*` and
  `coupon.*` events reaching the webhook's ledger are copied onto the campaign
  (`stripe_snapshot`). A visitor is shown a discount only when Stripe's record
  exists, is active and matches what the admin entered
  (`EDPricing.discountLine`); a mismatch is flagged in the console. Checkout
  (`prefilled_promo_code`) carries the code once Stripe has it, and Stripe
  applies whatever it holds.
- **Terms are snapshotted** onto the attribution when an account is attributed
  (`term_rate`, `term_type`, `term_months`) and never rewritten — not by an edit
  to the campaign, not by the service role. The first valid attribution still
  wins; another creator's campaign code cannot take a customer.
- **Switching a campaign off** stops new attributions through its code; an
  ended campaign still credits a visitor who clicked it while it ran; a code
  that is also the creator's base code falls back to default terms. Campaigns
  are never deleted.
- Created, edited and switched in `/admin/affiliates/` — no deploy. Creators see
  their campaigns (terms, window, Stripe-confirmed discount, counts) in
  Settings › Partner program.

## 9. Rollout (manual steps)

1. SQL editor, in order: re-run `supabase/personal_research.sql` (report rows
   1–18 ok), re-run `supabase/affiliates.sql` (rows 1–13 ok), run
   `supabase/growth.sql` (rows 1–10 ok). All three take their locks up front and
   are safe on the live site.
2. Stripe dashboard → the webhook endpoint → add `promotion_code.created`,
   `promotion_code.updated` and `coupon.updated`. Make sure the Payment Link
   allows promotion codes.
3. Redeploy `edgedesk_ai` through "Deploy intelligence" (build
   `edgedesk_ai-2026-09-26-r18-numbers`) for the `MY_NUMBERS` answer and the
   wider journal read.
4. `/admin/growth/`: choose one or two public samples; review the activation
   thresholds. `/admin/affiliates/`: create campaigns.

## 10. Tests

| Suite | What it proves |
|---|---|
| `tools/personal/personal_sql.test.js` | the reader's number is write-once (even for the service role) and private; persona values; share cards own-rows-only, write-once, tout copy and kicked-off games refused |
| `tools/personal/affiliates_sql.test.js` | campaigns: admin-only, validated economics, Stripe mirror (verified / mismatch), offer without economics, click and claim through a campaign, snapshot immutability, one-time vs recurring, disable, expiry honouring an in-window click, the promo-code path, no poaching, creator and admin views |
| `tools/personal/growth_sql.test.js` | every action recorded once by the right door, forged kinds refused, the state walk and its timing, threshold recompute, a failing recording never failing a save, the admin report from real Stripe event shapes, the source rule, first-touch upgrade-once-then-frozen, last touch, post-signup touches ignored, the affiliate ledger untouched, the funnel, public samples exposing only the subset, the backfill |
| `tools/personal/growth.test.js` | compare arithmetic and wording (no verdict), card content, refusals and layout in both formats, personas against the database, the discount line, the AI answer, the page wiring and the tracked kinds against the server's list |
| `tools/personal/personal.test.js` | the job closes number entries (no CLV, no result) and leaves plain passes alone |
| `tools/personal/personal_ui.e2e.js` | Chromium at 1280 and 390px: persona step, desk prompt and reorder, Compare My Number end to end, card drawn and recorded in both sizes, trial actions and claims sent, landing visit and Stripe-worded discount, the public sample page and its not-public state |

`npm run personal:test`, `npm run personal:sql`, `npm run personal:e2e`; the
first two run in `.github/workflows/personal-tests.yml` on pull requests.

## 11. Known limits

- **Client-only actions start at deploy.** Visits, matchup views, AI questions
  and Top 5 opens were never stored before; the backfill covers only actions
  that already had rows.
- **Visitors are counted where the tracker runs**: the landing page and the
  public sample page. `/articles/` and a direct visit to `app.html` are not
  visitors (an account arriving that way still claims its stored touches).
- **`x_dm` needs a tagged link** (`utm_medium=dm`): an X direct message arrives
  with the same `t.co` referrer as a post.
- **Trials before the webhook listened** are known only from a subscription row
  that still says trialing.
- **The discount check needs Stripe's events**; until one arrives a campaign
  reads *unverified*, no discount is shown and checkout does not prefill the
  code (the visitor can still type it). No Stripe API is called from the
  database.
- **The in-app paywall link for lapsed readers** (`PG_STRIPE_LINK`) does not
  carry a campaign code; new accounts go through the landing page, which does.
- **Totals are not itemised** by the model, so a total difference is never
  attributed to an input; the NFL spread is not itemised either.
- **Card fonts**: the canvas uses Inter when the page has it and a system font
  otherwise.
