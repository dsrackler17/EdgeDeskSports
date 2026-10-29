# Fairline

Fairline answers the two questions every bettor has:

1. **"Am I getting a good number right now?"** — The Board.
2. **"Where am I losing money, and is it bad bets or bad luck?"** — The Leaks.

**The Tape** ties them together: every Monday morning (Central time), a
snapshot of the reader's last week, kept for good, on the page and in their
inbox.

Fairline is **not a pick service**. It never says what to bet. It measures
prices, and the reader's own decisions, against EdgeDesk's de-vigged fair
price and the closing line. Every rule of the product applies: a number the
pipeline does not own is not shown; an unfinished piece is visibly inactive,
never hidden or faked; a small sample is labelled a small sample.

| Piece | Where |
|---|---|
| The page | [`fairline/index.html`](../fairline/index.html), `lib/edgedesk_fairline_app.js`, `lib/edgedesk_fairline_app.css` |
| The words and the mirrors of the rules | `lib/edgedesk_fairline_core.js` |
| The SQL | [`supabase/fairline.sql`](../supabase/fairline.sql), mirrored byte for byte in `supabase/migrations/20261028180000_fairline.sql` |
| The Tape's SQL and schedule | [`supabase/fairline_tape.sql`](../supabase/fairline_tape.sql) and [`supabase/fairline_tape_cron.sql`](../supabase/fairline_tape_cron.sql), mirrored in `supabase/migrations/20261029120000_fairline_tape.sql` and `20261029120100_fairline_tape_cron.sql` |
| The Tape's email | `tools/fairline/tape_email.js` (the words), `tools/fairline/tape_send.js` (the sender, run by `.github/workflows/lifecycle-email.yml`), [`email/tape/`](../email/tape/index.html) (the opt-out) |
| The tests | `tools/fairline/` (`.github/workflows/fairline-tests.yml`) |

`lib/edgedesk_fairline.js` is the Linemaker's fair-line sheet. It shares the
word and nothing else.

## Who can use it

| Tier | Product | Price | Includes |
|---|---|---|---|
| `red` | Bet Checker | $7.99/mo, $59/yr | Bet grading |
| `black` | **Fairline** | $19.99/mo, $159/yr | Bet Checker + The Board + The Leaks + The Tape |
| `blue` | EdgeDesk Full Access | $49.99/mo | Everything, including Fairline |

| Account | The Board | The Leaks | The Tape |
|---|---|---|---|
| Signed out | sign-in card | sign-in card | sign-in card |
| Free, or Bet Checker (`red`) | the top 3 **fresh** rows of the whole board; the rest blurred with the offer; filters locked | the **name** of the biggest real leak's slice ("Your biggest leak is in Props"), and no number | placeholders under a blur, with the offer; no Tape is built and none is sent |
| Fairline (`black`) or Full Access (`blue`) | every row, filters by sport, market and book | every slice, the 3 biggest real leaks, the labels | every Tape (the last 12 weeks on the page), and the email |

**The gate is one helper, `fairline_paid(uuid, timestamptz)`.** Every
Fairline door calls it and nothing else, and it calls
`has_fairline_paid()` (`supabase/billing_hardening.sql`): Fairline (`black`)
or the Research Terminal (`blue`) in good standing. Bet Checker (`red`) alone
is not Fairline; its offer on the page is a plan switch in the billing
portal, never a second checkout.

A free account's numbers are never sent to its browser: the blurred rows and
figures on the page are placeholders, and the free answers carry no row
beyond the top three and no figure at all for The Leaks
(`fairline_sql.test.js` walks the JSON and fails on any number but the rule).

## The rules: one constant, `fairline_rules()`

| Key | Value | Meaning |
|---|---|---|
| `min_sample_bets` | 15 | a slice needs this many **settled** bets before it gets any label; below it, "Small sample" and no label |
| `min_clv_bets` | 15 | and this many bets with a **captured close** before its label can speak about the close; below it the slice is labelled on P/L only, and says so |
| `odds_buckets` | ≤ −200 · −199 to −121 · −120 to +120 · +121 to +200 · > +200 | American odds, both ends inclusive, rounded first (−100 and +100 are one price) |
| `lead_buckets` | 48h+ · 24–48h · 6–24h · under 6h | hours from the bet to the start, from inclusive, to exclusive; at or after the start is **live**; no known start is **unknown** |
| `stake_buckets` | small < 0.75× · typical 0.75–1.25× · large 1.25–2× · oversized ≥ 2× | the stake over the reader's median stake |
| `board_days_ahead` | 7 | The Board's horizon |
| `freshness_hours` / `freshness_min` | capture's `FRESHNESS_POLICY`, in minutes | how old a price may be and still be a price, by sport group (NFL, college football, everything else) and hours to the start; held equal to `supabase/functions/capture/index.ts` by the SQL suite |
| `free_board_rows` | 3 | what a free account sees of The Board |
| `top_leaks` | 3 | how many real leaks lead the page |
| `tape.time_zone` | America/Chicago | The Tape's week: Monday 00:00 to Monday 00:00 there |
| `tape.build_hour` | 6 | The Tape is built on Monday from this local hour |
| `tape.email_within_hours` | 48 | a Tape not emailed this long after its week ended is not emailed at all (it stays on the page) |
| `tape.history_weeks` | 12 | how many past Tapes the page lists |

The page reads these from the database. `lib/edgedesk_fairline_core.js`
mirrors the buckets and the labels only to explain a label on the page; the
SQL suite runs both on a grid of cases (815 prices, 349 lead times, 107
stake ratios, 500 slices) and fails if they ever disagree.

## The Leaks

### One view of the reader's bets, from both sources

`fairline_bets_for(uuid)` (the caller or the service role only),
`fairline_my_bets()` and the view `fairline_bets` (the caller only, paid
only) return one row per bet from:

- **`public.user_bets`** — Bet Checker's logs (and any bet recorded from the
  decision card). Voided bets are left out.
- **`public.portfolio_positions`** — Juice Reel syncs, CSV, screenshot and
  paste imports, manual entries. Voided positions are left out.

**A bet that is in both is one row** (`source = 'both'`). Two rows are the
same bet when, in this order of certainty:

| `matched_by` | Rule |
|---|---|
| `linked` | the position names the Bet Checker row (`edge_ref_type = 'user_bet'`, `edge_ref_id` its id) |
| `same_market` | the position's matched capture key (`market_sig_key`) is the bet's exact market — event, market, selection, line — at the same American odds, placed within 36 hours of each other |
| `same_game` | a straight sportsbook position on the same start (within 10 minutes), market type, line and American odds, whose selection names the same side, placed within 36 hours |

Each row pairs at most once, the most certain and closest pair first, so two
identical bets in each source are two bets — never one, never four. Nothing
else is merged: a wrong merge would hide a real bet.

A merged bet keeps the **book's record of the money** (the position's stake,
result and dollar P/L) and **Bet Checker's units and captured close**.

### Money

- A Bet Checker bet is in units. Its dollars are its units times the bet's own
  recorded unit value (`stake_dollars` / `unit_value`), else the unit in the
  reader's bankroll settings (`dollars_basis = 'unit_size'`, and the page says
  so), else none.
- A Portfolio position is in dollars (`cost_basis + fees`, `profit_loss`, both
  derived by the Portfolio's own trigger). Its units are dollars over the
  reader's unit, else none.

Nothing is guessed: a figure that cannot be computed is left empty, and a
slice says when its dollars or units cover only some of its bets.

### Closing-line value

The house CLV (`close/index.ts` `decideClose`): entry decimal × EdgeDesk's
no-vig closing probability − 1, at the **same line**, the formula Bet Checker
uses.

- A Bet Checker bet: its own `clv_pct`.
- A Portfolio position: only a straight sportsbook spread, total or moneyline,
  matched to a capture key at its own line, placed before the start — read
  from that signal's close. Anything else has no CLV (`not_applicable`); a
  live bet is never graded against a pregame close.

### Slices

Every slice of the reader's bets by **sport, market** (spread, total,
moneyline, props, parlay, other), **bet type** (straight, parlay), **odds
range, lead time, book / platform** and **stake size vs their median**, plus
"all". Each shows: bets (settled), open bets, the record, units and dollars
P/L, ROI, average CLV and the beat-close rate (CLV > 0).

### The label

The core insight: **losing money while beating the close is variance;
losing money while not beating the close is a real leak.**

| Label | Return | Average CLV |
|---|---|---|
| **Real leak** | negative | ≤ 0 |
| **Bad luck** | negative | > 0 |
| **Running hot** | ≥ 0 | ≤ 0 (the page warns) |
| **Real edge** | ≥ 0 | > 0 |
| Losing / Winning (P/L only) | negative / ≥ 0 | fewer than `min_clv_bets` captured closes |
| *(none: Small sample)* | — | fewer than `min_sample_bets` settled bets |

The return is read in the slice's own measure: dollars when every settled bet
in it has dollars; else units when every one has units; else flat (each bet's
return on its own stake, one unit each). A return of exactly zero counts as
not losing; a CLV of exactly zero is not beating the close.

The top of the page shows the reader's **3 biggest real leaks**, largest loss
first, each in one plain sentence — for example *"Props: down $395 over 40
bets, and you're not beating the close. This one's real."* — with the numbers
underneath. A slice that holds exactly the same bets as one already listed
(say, every NFL bet was at one book) is listed once.

## The Board

`fairline_board(p_sport, p_market, p_book)` is a **security-definer door**:
`public.signals` keeps its terminal-only RLS (`has_active_sub()`), untouched.
The door checks the gate and returns only the columns the page needs.

Every game capture has, starting within the week, one row per market and side
at the side's **main line** (the line most books hang), game markets only:

| Column | Source |
|---|---|
| Fair | `signals.sharp_fair`, as a probability and as fair American odds |
| Best price, book | the best **fresh** `book_quotes` quote where capture wrote any (actionable lines only, today), else `signals.best_dec` / `best_book`. With a book filter: that book's own price, and only rows that have one |
| Kalshi | where the game winner is linked, `kalshi_card_current`'s YES mid and ask, **only when its state is OK**; otherwise its state. Never counted as the best price |
| Edge vs fair | fair probability − the best price's implied probability, in points |
| Quote age | the price's age at capture plus the time since. Past the freshness limit the row is greyed out, says "Stale", and is sorted after every fresh row |
| DK Predictions | **Coming Soon**: no price feed exists. The answer marks the column inactive and never carries a number for it |

Sorted fresh first, then by edge vs fair, largest first. A side with a fair
and no captured price is shown unpriced, last.

## The Tape

Every Monday from 06:00 in Chicago, `fairline_tape_build()` stores one Tape
per Fairline reader for the week that just ended, in **`fairline_tapes`**.

- **The week** is Monday 00:00 to Monday 00:00, America/Chicago (a DST week is
  167 or 169 hours, and still one week). A bet belongs to the week its game
  started; a bet with no known start, to the week it was placed.
- **Append-only.** A Tape is never updated, never truncated, and never
  deleted while its reader exists (a trigger refuses, even for the service
  role); deleting the account still removes its Tapes. A bet graded or
  imported after Monday does not rewrite last week's Tape: the Tape is what
  the week looked like when it was built, and says so.
- **Once.** One Tape per reader per week (the unique key): a second run, or
  two overlapping runs, build nothing more.

What a Tape holds (`fairline_tape_compute()`, every figure through The Leaks'
own arithmetic, `fairline_slices_at()`):

| Part | What it says |
|---|---|
| The week | settled and open bets, the record, dollars and units P/L (with how many bets each covers), the return in the week's own measure, average CLV and the beat-close rate |
| Price quality | over the bets **checked against EdgeDesk's fair when placed** (Bet Checker's frozen entry edge): how many, the average points better or worse than fair, how many beat it. A bet never checked is counted and said, never guessed |
| What changed | every slice whose label changed this week, or that crossed the minimum sample into a label: the slices over the bets before the week against the slices through it. Real leaks first; the page and the email say the first six and count the rest |
| The best number | the largest entry edge over fair; with none, the best captured close; with neither, nothing |
| Quiet | no bet in the week and nothing changed: kept and shown, not emailed |

Each Tape stores the rules it was read by, so it keeps meaning what it said.

**The email** goes through the existing email pipeline (`lifecycle_email.sql`,
`tools/lifecycle/send.js`): the same provider, sender, from and reply-to,
postal address, per-reader token, bounce and complaint list, and copy rule.
`tools/fairline/tape_send.js` runs in the trial emails' hourly job, after its
own tests; it claims each Tape's email once (`fairline_tape_due()`),
re-checks the reader at that moment, and marks it (`fairline_tape_mark()`).
An email is **skipped, with the reason**, when the reader turned The Tape
emails off (on the page, or from the link in every Tape email:
`/email/tape/`, a button, never a page load), the address bounced or
complained, the reader is no longer on Fairline, the week ended more than 48
hours ago, or the week was quiet. Each email carries its own Idempotency-Key
(`edgedesk-lifecycle-fairline-tape-<id>`), so a retry cannot deliver twice.

**Nothing is emailed until both switches are on:** the pipeline's
(`lifecycle_settings.sending_enabled`, `/admin/funnel/`) and The Tape's own
(`fairline_tape_settings.email_enabled`, **off by default**). Until then the
page shows the email as **Coming Soon** and every Tape says it was not
emailed.

## Known limitations

- **Coverage is whatever capture recorded.** Per-book quotes (`book_quotes`)
  are captured for actionable lines only today; every other row shows the one
  best price capture saw, not every book's.
- Prices are as of the last capture run, not live.
- Game lines only; props are not on The Board, and a prop bet has no captured
  close yet, so props are labelled on P/L only in The Leaks.
- Kalshi: game winners only, NFL and college football, where linked; 5-minute
  snapshots; no price when the market is one-sided or wider than 6¢; before
  Kalshi's fees.
- A Portfolio bet that was never matched to an EdgeDesk market (most Juice
  Reel syncs today) has no CLV; its slice says so rather than guessing.
- Dollars for Bet Checker bets come from the reader's current unit size; a
  reader who changed their unit sees past bets at the new size.
- The Tape's price quality covers only bets checked in Bet Checker before
  they were placed; a Portfolio bet has no frozen fair at entry.
- A Tape is built from what was graded by Monday morning; a bet settled later
  shows in the next Leaks, never in that week's Tape.

## Out of scope (not built, on purpose)

- **A DK Predictions price feed.** No source exists. The column stays Coming
  Soon until one does; nothing is inferred in its place.
- **Selling Fairline through Juice Reel's checkout.** Juice Reel's hosted
  checkout sells only the terminal today
  ([juicereel-billing.md](juicereel-billing.md)); selling Fairline there needs
  a product on Juice Reel's side first.

## Billing: the `black` tier

Fairline is its own Stripe product, sold like Bet Checker (full detail:
`docs/billing-hardening.md` §15):

- `create_checkout_session {kind: 'fairline', plan: 'monthly' | 'annual'}`
  finds the price by lookup key (`fairline_monthly`, `fairline_annual`),
  refuses one whose product does not say `tier = black` or that does not
  charge the figure the consent showed, records the tier **before** the
  session exists, and refuses to sell (503, nothing created) if the database
  could not record it. Success and cancel return to `/fairline/`.
- The page shows the automatic-renewal terms (`lib/edgedesk_pricing.js`
  `fairlineTerms()`), requires the tick, has the server create the checkout,
  records the terms **as shown** in `billing_consents`, and only then sends the
  browser to Stripe. Back from Stripe it asks the server until
  `fairline_paid` (never the redirect itself).
- A `black` subscription never passes `billing_row_grants_access()`, so it
  never opens the terminal; `tools/billing/fairline_tier.test.js` proves it
  through the shipped functions, including for a price nobody learned.

## Deploying

In this order:

1. **Billing first.** Actions → *Deploy billing* (`deploy-billing.yml`):
   `apply_sql` (`billing_hardening.sql`, which adds the `black` tier and
   `has_fairline_paid()`; report row 15 must say `ok`), then the three
   functions (`sync_subscription`, `stripe_webhook`,
   `create_checkout_session`). A checkout deployed before the SQL refuses to
   sell Fairline rather than sell an unrecorded price.
2. **`supabase/fairline.sql`** into the SQL editor (or `psql
   --single-transaction -f`), **after** `bettor_decisions.sql`,
   `billing_hardening.sql`, `bet_checker.sql`, `portfolio.sql` and
   `bet_import.sql`; it stops with a message naming any that is missing. Every
   report row should say `ok`. It adds functions and one view, and changes no
   table, row or policy.
3. **`supabase/fairline_tape.sql`**, after `fairline.sql`,
   `lifecycle_email.sql` (and the `funnel.sql` / `personal_research.sql` it
   stands on). Every report row should say `ok`; row 07 says whether each email
   switch is on. Then **`supabase/fairline_tape_cron.sql`** (pg_cron enabled):
   one job, `fairline_tape_build`, Mondays at :23 past 11:00 and 12:00 UTC (the
   build decides which of the two is 06:00 in Chicago). It calls nothing
   outside the database and needs no secret.
4. When the Tape email should start: `update public.fairline_tape_settings
   set email_enabled = true;` (the pipeline's own switch must be on too). The
   next hourly run of *Trial emails* (`lifecycle-email.yml`) sends what is due.
5. The page is static and ships with the site.

### Stripe dashboard

- Product **Fairline**: metadata `tier = black`; prices with lookup keys
  `fairline_monthly` ($19.99/month) and `fairline_annual` ($159/year), both
  active, USD, no trial. Put `tier = black` in each **price's** metadata too.
- **Customer portal**: allow switching between the Bet Checker, Fairline and
  Research Terminal prices, so every switch is one subscription changing price.

### Before going live, in production

- `docs/billing-hardening.md` §11 query 10: production's `has_active_sub()`
  and the paywall RLS that calls it are **not in this repository**. They must
  defer to `billing_row_grants_access()` (or `community_is_entitled()`), not
  inline statuses, or a Fairline subscription would read the terminal's data.
  The tests prove it against a stand-in that defers to the rule; production's
  own definition is **not verified** until that query is run there.

## Tests

| Suite | What it proves |
|---|---|
| `tools/fairline/fairline_sql.test.js` | a real PostgreSQL, as readers A and B, anon and the service role: install (twice) and missing dependencies, owner-only reads, the paid gate (free, red, blue, lapsed), one row per bet across both sources (linked, same market, same game, a different price kept apart, twins, parlays), every slice and bucket, the four labels, the minimum sample, P/L only, the top leaks, The Board (main line, fair, best price, `book_quotes` first, edge, age, stale sorted last, Kalshi only when OK, DK Predictions inactive, filters, the free three), and the page's mirrors equal to the SQL |
| `tools/fairline/tape_sql.test.js` | `fairline_tape.sql` and its cron file on a real PostgreSQL, as Fairline, Bet Checker, lapsed and free readers, anon and the service role: install (twice) and dependencies; the week in Chicago across both DST changes and the Monday 06:00 rule in CDT and CST; Fairline readers only, once a week, under overlapping runs; append-only even for the service role and the superuser, removed with the account; every figure in a Tape against hand-worked numbers; owner-only, no figure without Fairline; the email's two switches, its re-checks (opted out, bounced, lapsed, too late, quiet), claim-once, dry-run release, the pipeline's own token and an opt-out that touches only The Tape; and the sender end to end over the real SQL |
| `tools/fairline/tape_email.test.js` | offline (the hourly email job runs it before sending): The Tape's words for every case, the email (the copy rule, the footer, the opt-out link, escaping), a refused Tape never sent, the sender's no-secret, not-installed, switched-off, provider-failure and dry-run paths, its own Idempotency-Key |
| `tools/fairline/core.test.js` | the buckets at every boundary, the labels, the slice names, the verdict sentences, The Board's words |
| `tools/fairline/page.test.js` | the page's wiring: the nav, the scripts, the doors, prices not picks, the known limitations, Coming Soon, no typed price, escaping, The Tape as a tab of its own |
| `tools/fairline/page.e2e.js` | Chromium against the shipped SQL: a free reader's teaser and the upgrade (terms, consent before Stripe), a Bet Checker reader's portal switch, a Fairline reader's Board, Leaks and Tape (the week, what changed, the best number, the email Coming Soon, switching weeks, the email off and on), the offer's button never cut off, a 390 px phone, no script error |
| `tools/billing/fairline_tier.test.js` | the `black` tier through the shipped billing functions and the real SQL: bought, paid for Fairline and Bet Checker, never the terminal (the rule, `community_is_entitled`, a `has_active_sub` that defers to it, signals RLS); an unlearned price refused at checkout; a portal switch to a never-learned Fairline price named black (product readable, Products refused, Stripe unreachable); switch_plan and already_entitled; blue still everything; the rule mirrored in the core and the browser on a 175-case grid; Juice Reel over a live Fairline plan raised |
