# EdgeDesk Games

A standalone, free, public acquisition product. It lives at `/games`, needs no
account, and its job is to give a football fan a reason to meet EdgeDesk
research — repeatedly — before anyone asks them for anything.

**It is not a sportsbook.** No real-money wagering, no deposits, no wallet, no
balance, no entry fee, no prizes. Free to play, no purchase necessary, 21+.

---

## The one architectural rule

**The games layer consumes EdgeDesk output. It never becomes a second source of
truth.**

There is no model, no rating, no projection and no pricing logic anywhere under
`games/`. Every number a player sees was produced by the canonical Power 4
exporter and committed to an artifact.

```
football/cfb_p4/export_csv.js         the canonical exporter — the ONLY thing
  (schedule → ratings → projectGame)  that prices a game
            │
            ▼
games/build_challenges.js             runs it as a child process, joins book
  + football/rankings/current.json    numbers from cfb.lines, reshapes the CSV
  + games/lib/research_state.js       and reads roster context from the
            │                          committed rankings artifact
            ▼
games/data/challenges.json            one small committed artifact (~8 KB gzipped)
            │
            ▼
/games, /games/price-it, /games/pick-5   the browser renders it and computes
                                         nothing
```

This is the same doctrine the rest of the repository runs on: *the browser reads
committed artifacts rather than computing anything.*

`tools/games/builder.test.js` fails if the builder ever grows model logic of its
own, and `tools/games/state_parity.test.js` fails if the research state drifts
from the terminal's.

### Rebuilding the board

```
npm run games:build          # current season, upcoming games
npm run games:test           # the three suites
```

`.github/workflows/games-challenges.yml` rebuilds it daily and before the
weekend slate. It refuses to commit a board that is empty, unpriced, or
missing a slug.

---

## Price It scoring

```
score = max(0, 100 − 10 × ceil(max(0, d − 1)))
```

`d` is the absolute distance, in points, between the price the player locked and
the benchmark price.

In words: **you keep all 100 points inside a point; after that you lose 10 points
for every further point of difference, rounded up.** It hits 0 at 11 points away.

| distance from the benchmark | score |
|---|---|
| 0.0 – 1.0 | 100 |
| 1.5 – 2.0 | 90 |
| 2.5 – 3.0 | 80 |
| 3.5 – 4.0 | 70 |
| … | −10 per point |

**Properties, and why each is deliberate**

* **Deterministic.** No clock, no random, no model call. A stored score can be
  recomputed and audited years later.
* **Understandable.** A player can do it in their head. That is what makes a
  score feel fair.
* **Versioned.** Every stored result carries `scoring_version` (`price_it_v1`).
  If the rule ever changes, old results keep their old version and are **never
  silently rescored**.

### The benchmark

Scored against **EdgeDesk's projected spread** by default — this is an EdgeDesk
game, and the interesting question is how a player's read compares with the
research model's. The distance to the market is always computed and shown too,
so the reveal has three prices and the player can see both gaps.

`games/lib/scoring.js` also declares a `close` benchmark. **Nothing in V1
computes it.** Closing lines are not carried in the challenge artifact; the field
exists so a "Closing Line Score" can be added later without rescoring anything
already stored.

### What the score is not

The benchmark is not the right answer. EdgeDesk's projection **does not beat the
closing line** (see `football/cfb_p4/research/report/BACKTEST.md`), and the
market is not truth either. The score measures *agreement with a stated
benchmark*. No copy anywhere calls a player wrong for disagreeing, and a gap is
never presented as a betting edge.

---

## The football week

**Tuesday 07:00 UTC (03:00 US Eastern)** — `games/lib/week.js`.

College football's week finishes with Monday night, and this repository's own
football build already runs Tuesday morning UTC. Resetting a few hours before
that build means a week's leaderboard closes on settled results and never
straddles a ratings rebuild.

A week is keyed by the ISO date of its Tuesday (`2026-09-01`). Keys sort
lexicographically, are stable forever, and are what historical weekly results are
filed under. The daily streak uses the same offset, so "yesterday" means the same
thing in every time zone.

---

## Anonymous first

Nobody is asked to sign up before playing. Everything a player earns lives in one
versioned `localStorage` envelope (`edgedesk_games_v1`) — streak, weekly scores,
Price It history, Pick 5 cards, first-touch attribution.

* A browser that blocks storage still plays; the page says the session is
  unsaved rather than breaking.
* A challenge already played **replays its stored result** instead of being
  scored again, so a score cannot be farmed by reloading.
* The account ask appears only after two completed challenges, once, and never
  during a first game.
* `EDGamesStore.exportForAccount()` returns the whole anonymous history as one
  object, so a future sign-up can inherit it in a single call rather than needing
  a migration system.

---

## Routes

| route | file | indexable |
|---|---|---|
| `/games` | `games/index.html` | yes |
| `/games/price-it` | `games/price-it/index.html` | yes |
| `/games/pick-5` | `games/pick-5/index.html` | yes |
| `/games/price-it/{slug}` | → `?g={slug}` via `404.html` | no (same page) |

GitHub Pages serves the three directories natively. Share links use the pretty
`/games/price-it/{slug}` form and `404.html` rewrites them to the canonical query
form — the same mechanism the repo already uses for `/join/{token}` and
`/c/{slug}`.

Individual matchups are **not** in the sitemap. They are one page with a
challenge named, they turn over weekly, and listing them would be thousands of
thin near-duplicates.

---

## Analytics

The existing property (**GA4 `G-1PXVBV53FZ`**, via `gtag`). **No second vendor.**

`games_page_view` · `price_it_start` · `price_it_complete` · `pick5_start` ·
`pick5_complete` · `result_reveal` · `share_result` · `next_game_click` ·
`research_cta_click` · `save_score_cta` · `signup_start_from_games` ·
`signup_complete_from_games` · `pricing_view_from_games` ·
`checkout_start_from_games` · `subscription_complete_from_games`

Every event carries `sport`, `game_id`, `game_slug`, `game_type`,
`research_state` and `identity`, plus the credited campaign.

The last four events are declared and carried but fire from the terminal and
checkout, which are outside this change — they exist so the funnel is complete
the moment those surfaces emit them. Paid conversion is answerable without them
because of the ledger below.

## Attribution — one ledger, shared with the landing page

**Games does not keep its own attribution.** The landing page already runs a
first-touch system (`attrCapture` in `index.html`): it writes
`edgedesk_attribution` and `edgedesk_attribution_last` to `localStorage`,
mirrors a referral code into an `ed_ref` cookie at `path=/`, and hands
`attrPayload()` to the database when a subscription is created. That record is
what a partner invoice is reconciled against.

`games/lib/attribution.js` writes **the same keys, in the same shape, under the
same credit rule**. `localStorage` is per-origin and the cookie is `path=/`, so
`/games` and `/` genuinely share one record — a visitor who lands on
`/games?utm_source=x`, plays for three weeks and then subscribes is credited to
that campaign by machinery that already exists, with no second ledger to
reconcile.

The credit rule, restated from `index.html` rather than reinvented:

* credit belongs to the **first touch that actually carried a code**;
* an organic visit is recorded as an **upgradeable placeholder** and never
  claims the customer;
* once a code is credited it is **frozen** — a later, different code does not
  take the customer from whoever created them.

Internal links out of Games carry the campaign forward, and append `ref=games`
**only** when the visitor arrived with no referral code of their own: overwriting
a partner's code with our own surface name would take a paying customer away
from whoever sent them.

`tools/games/attribution_parity.test.js` lifts `attrCapture` straight out of
`index.html`, replays ten visit sequences through both implementations, and
fails if the ledger they leave behind ever differs.

---

## Getting there from the rest of EdgeDesk

* **Landing page** — one nav link (`Games`).
* **The terminal** — one row in `More`, opening `/games/?ref=app` in a new tab
  so nobody loses a loaded board. The `ref=app` marks the visit so the funnel
  can tell an existing subscriber wandering in from a cold visitor arriving on a
  shared result. They are not the same person and must not be counted as one.

Both are links only. Games is its own acquisition product and the traffic that
matters runs Games → EdgeDesk, not the other way round.

## The leaderboard

`supabase/games_leaderboard.sql` defines `games_weekly_scores` (public read,
owner-only write, one row per player per week). **This repository does not deploy
it.** Until it is applied, `games/lib/leaderboard.js` returns
`{ available:false }` and the page shows:

> No leaderboard results yet. Be the first.

**Nothing ever fabricates a player.** There is no seed data, and there must never
be any.

---

## Not built, on purpose

Line Move, Survivor, Rank 'Em, Who's Mispriced and bracket challenges are all
reachable from this architecture — a new game is a new page reading the same
artifact — but V1 does two things well instead of six things thinly.
