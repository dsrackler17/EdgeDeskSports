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

---

# The social layer — Head-to-Head and Groups

Price It and Pick 5 give a stranger a reason to play once. Head-to-Head and
Groups give them a reason to come back, and a reason to bring someone.

Still free to play. No deposits, no balance, no entry fee, no prizes.

## The guarantee this rests on

**In Head-to-Head, your opponent's pick is secret until you both lock.** If the
second player can read the first player's answer, the game is worthless. So the
secret does not live in the same table as everything else:

| table | holds | who can read it |
|---|---|---|
| `game_challenge_entries` | who is playing, when they submitted, how they did | the players |
| `game_challenge_selections` | **the prediction** | **nobody — no policy grants read on it at all** |

RLS denies by default, and that table has no policy, permanently. The only
reader is `h2h_view()`, a security-definer function whose whole reveal rule is
one predicate:

```sql
and (v_locked or s.player_slot = v_slot)
```

A stranger with the link sees the matchup and that someone is waiting. They see
no prediction, because none is sent — there is no hidden field for a page to
leak, and nothing to find in the DOM.

`tools/games/sql_security.test.js` applies the real schema to a real PostgreSQL
and attacks it: as `anon`, as `authenticated`, as the wrong player, with a
guessed secret, and by reading the tables directly. 102 assertions.

## Identity, and playing before you sign up

The whole growth loop depends on a friend playing before they have an account,
so an entry may have no `user_id`. Such a player proves who they are with a
256-bit bearer secret their browser generated; the server stores only its
SHA-256. Possession is the identity. **A client-supplied user id proves nothing
anywhere in this schema.**

`h2h_claim()` binds an anonymous entry to an account later, so signing up keeps
the record that earned the signup.

A signed-in EdgeDesk reader is identified by the same Supabase session the
terminal already uses — Games adds no auth of its own.

## Modes

| mode | settles on |
|---|---|
| **Winner** | who actually won. A tied game is a draw. |
| **Spread** | the line **snapshotted when the challenge was created**, never a number the market moved to afterwards. A push is a draw. |
| **Price It** | whoever landed closer to the benchmark, by the published Price It rule. Equal distance is a draw. |

Nobody is called wrong for disagreeing with EdgeDesk. In Price It the benchmark
is the closing number where one exists, the market otherwise, and EdgeDesk's
projection only when there is nothing else — and the result names which was used.

## Settlement

`games/settle_h2h.js`, run by `.github/workflows/games-settle.yml` with the
service role. It reads final scores from the same committed artifact the pages
read, grades with `games/lib/h2h_grade.js`, and calls `h2h_settle()`.

* **A browser cannot settle anything.** `h2h_settle` is granted to no client role.
* **Idempotent.** A challenge that already carries a settlement is returned
  unchanged; replaying the worker cannot alter a result that landed.
* **Never silently re-graded.** A correction goes through `h2h_correct()`, which
  writes the old settlement into `game_challenge_corrections` before replacing
  it. Nothing is quietly fixed.

## Ratings

Ordinary Elo, K=24, everyone starts at 1200 (`games_elo_delta`). An even win is
+12 and an even loss −12; a draw between equals moves nothing.

**Ratings move only between two accounts.** Beating an anonymous opponent moves
nothing, because otherwise anyone could farm a number by opening their own link
in a private window.

It is a **game rating** — how well you play this game against other people
playing it. It is not a measure of betting skill and is never described as one.

## Groups

Private. A stranger holding an invite link gets `group_preview()`: the name, an
icon and a headcount. **Not who is in it.** The dashboard, the members and the
standings need membership, enforced in the policy and re-checked in the function.

Standings are kept **separate per game** — Head-to-Head here, Price It and Pick 5
in their own tables. Three tables anybody can explain beat one nobody can.

The activity feed is a **sports activity feed**: rows are written by the server
when something real happens, and there is no free-text field anywhere for a
person to post into. No chat, no DMs, no comments, no followers.

## Routes

| route | file | indexable |
|---|---|---|
| `/games/h2h` | `games/h2h/index.html` | **no** |
| `/games/h2h/{token}` | → `?c={token}` via `404.html` | **no** |
| `/games/groups` | `games/groups/index.html` | **no** |
| `/games/groups/{token}` | → `?g={token}` via `404.html` | **no** |

Both routes are `noindex,nofollow`: a challenge is a private page between two
people and a group is private to its members. The **public** explainer for the
social layer lives on `/games`, which is crawlable.

## Deploying it

The social layer needs `supabase/games_social.sql` applied to the Supabase
project. **This repository does not apply it.** Until it is, the H2H and Groups
pages say so plainly — and Price It and Pick 5 are entirely unaffected.

`games/data/config.json` (written by the build, from `app.html`) carries the
project URL and public anon key, so the pages and the terminal can never point
at different projects.

## Not built, on purpose

Line Move, Survivor, Rank 'Em, Who's Mispriced and bracket challenges are all
reachable from this architecture — a new game is a new page reading the same
artifact — but V1 does a few things well instead of many things thinly.

Deliberately absent from the social layer, and not by omission: real money,
cash prizes, paid entry, tokens, virtual currency, loot boxes, bet slips,
parlays, odds boosting, pay-to-win scoring, open chat, direct messages, public
posting, comments and follower counts. A subscriber gets **better research**,
never better scoring.
