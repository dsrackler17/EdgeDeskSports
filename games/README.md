# EdgeDesk Games

A standalone, free, public acquisition product. It lives at `/games`, needs no
account, and its job is to give a football fan a reason to meet EdgeDesk
research — repeatedly — before anyone asks them for anything. Beneath the games
sits one persistent layer, EdgeDesk Dynasty: every real game a player completes
builds a War Room that is theirs, on their own device, with no account required.

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
/games, /games/price-it, /games/pick-5,  the browser renders it and computes
/games/two-minute-drill, /games/dynasty  nothing
```

This is the same doctrine the rest of the repository runs on: *the browser reads
committed artifacts rather than computing anything.*

The Dynasty and the Drill read the same artifact and compute no price: a level
is derived from what a player did, and a Drill question only ever asks which of
two things a number the exporter already wrote says.

`tools/games/builder.test.js` fails if the builder ever grows model logic of its
own, and `tools/games/state_parity.test.js` fails if the research state drifts
from the terminal's.

### Rebuilding the board

```
npm run games:build          # current season, upcoming games
npm run games:test           # every games suite
```

`games:test` runs `games.test.js`, `state_parity.test.js`,
`attribution_parity.test.js`, `builder.test.js`, `social.test.js` and
`sql_security.test.js`, and now also `dynasty.test.js` and `drill.test.js` —
the Dynasty and Drill rules, documented below.

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
Price It history, Pick 5 cards, first-touch attribution, and since the Dynasty
layer arrived the event ledger, research opens, Drill runs, visits and the
Dynasty marker (see *Anonymous first, then the account*, below). An envelope
written before a key existed reads as empty for that key rather than throwing.

* A browser that blocks storage still plays; the page says the session is
  unsaved rather than breaking.
* A challenge already played **replays its stored result** instead of being
  scored again, so a score cannot be farmed by reloading.
* The account ask appears only after two completed challenges (a Price It, a
  Pick 5 card and a daily Drill each count as one), once, and never during a
  first game.
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
| `/games/dynasty` | `games/dynasty/index.html` | yes |
| `/games/two-minute-drill` | `games/two-minute-drill/index.html` | yes |
| `/games/price-it/{slug}` | → `?g={slug}` via `404.html` | no (same page) |

GitHub Pages serves the directories natively. Share links use the pretty
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

The social layer's own steps (`h2h_*`, `group_*`, `research_open_from_h2h`,
`research_open_from_group`, `signup_from_h2h`, `signup_from_group`,
`subscription_from_games`) are in the same list.

**EdgeDesk Dynasty** adds `dynasty_start` · `war_room_created` ·
`first_game_complete` · `account_save_from_dynasty` · `level_up` ·
`weekly_mission_complete` · `weekly_mission_set_complete` ·
`achievement_unlock` · `research_open_from_dynasty` ·
`premium_view_from_dynasty` · `subscription_from_dynasty` · `return_1d` ·
`return_7d` · `return_next_football_week`. The Two-Minute Drill adds
`drill_start` · `drill_round` · `drill_complete` · `drill_share` ·
`research_open_from_drill`.

Every event now also carries `dynasty_level`, so retention, invites and
research use can be read by level — the question the persistent layer exists to
answer. A page loaded without the Dynasty module sends no level rather than a
fake one.

`return_1d`, `return_7d` and `return_next_football_week` fire from the visit
ledger, not from page views. `EDGamesStore.touchVisit()` records each visit per
day and per football week and reports the gap since the last one in days:
`return_1d` is a gap of a day or more, `return_7d` seven or more (so a
`return_7d` visit is also a `return_1d`), and `return_next_football_week` is
the first visit of a new football week when an earlier week saw real play. A
return is a measured gap, not a guess from a cookie.

`war_room_created`, `first_game_complete`, `level_up`, `achievement_unlock` and
the two mission events fire from the shared runtime's pulse (see *The War
Room*, below), so every page announces the same thing the same way.
`premium_view_from_dynasty` and `subscription_from_dynasty` are declared for
the same reason as the checkout events above: they fire from surfaces outside
Games.

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

Inside Games, the header leads with the **War Room** and the **Drill**, then
Price It; the level badge follows the player onto every page once a War Room
exists. Head-to-Head, Pick 5 and Groups keep their header links on a wide
screen and shed to the footer under 480px. Every page's footer repeats every
game link, so nothing becomes unreachable on a phone.

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

---

---

# EdgeDesk Dynasty

## The idea

A free persistent layer under every game. Every real game a player completes —
a Price It, a Pick 5 card, a Two-Minute Drill, a Head-to-Head that locked —
builds a level, a title, a War Room stage, weekly missions and achievements. The
fantasy is simple: you are building the best football intelligence operation,
from a garage with one monitor to a wall of screens.

It is an acquisition and retention layer, and its funnel is the whole point:

```
social post / friend invite / search
  → a free game
  → a War Room created
  → returns to improve it
  → competes with friends
  → uses matchup research
  → values deeper research
  → creates an account
  → eventually subscribes
```

Research is never hidden behind a level, and nobody is manipulated into paying.
The premium step should feel like "I already use this research every week" —
and nothing else. A subscriber gets better research, never better scoring and
never more XP.

## The one rule: derived, never accumulated

`games/lib/dynasty.js` awards nothing. XP, level, missions and achievements are
pure functions over the record — the `edgedesk_games_v1` envelope
`games/lib/store.js` keeps. There is no XP counter anywhere to increment. The
ledger is recomputed, every time, from real rows that are each keyed once:

| row | keyed by | so |
|---|---|---|
| a Price It result | matchup (`game_id`) | a matchup counts once |
| a Pick 5 card | football week | one card per week |
| a daily Drill run | day | one daily run per day |
| a research open | matchup (`game_id`) | opening a page fifty times is one row |
| an event (`h2h_locked`, `h2h_win`, `group_create` …) | `kind:key` | the same thing cannot be recorded twice |
| a group created, a group joined | — | the first ever, only |

`EDGamesStore.recordEvent(kind, key)` writes a row once and returns
`{ recorded:false }` on every later call with the same key. So there is nothing
to farm: reloads, double-clicks and replayed requests write nothing new, and a
ledger read a thousand times is the same ledger.

Every XP entry names the record it came from — kind, key, timestamp, football
week and a label — so a profile, a dispute or a future server import can read
it back line by line rather than trusting a total.

`tools/games/dynasty.test.js` is the suite that holds this rule. It is being
written alongside this change.

## XP

| kind | XP | earned by |
|---|---|---|
| `price_it` | 50 | one completed Price It, once per matchup |
| `pick5_card` | 75 | one submitted Pick 5 card, once per week |
| `pick5_correct` | 10 | each correct side on a card, as the games settle |
| `drill_daily` | 40 | the day's Two-Minute Drill, once per day |
| `h2h_locked` | 40 | a Head-to-Head where both players locked, per challenge |
| `h2h_win` | 20 | a settled Head-to-Head win, per challenge |
| `research_open` | 15 | the research for a matchup opened — per unique game, at most 10 games per football week |
| `group_create` | 100 | the first group ever created |
| `group_join` | 50 | the first group ever joined |
| `week_return` | 25 | coming back for a football week after real play in an earlier one |
| `mission_set` | 150 | all five weekly missions in one week |

The research cap (`RESEARCH_CAP_PER_WEEK = 10`) is what makes a research tab
worth reading rather than clicking: the eleventh unique game opened in a week
earns no XP. It still counts as a reviewed game for missions and achievements.

**The level curve.** XP needed to reach level `L`, cumulative:

```
xpForLevel(L) = 25 × (L − 1) × (L + 2)
```

which is the same as saying each level costs 50 more XP than the last: 100 to
reach level 2, then 150, then 200, then 250 …

| level | XP |
|---|---|
| 2 | 100 |
| 5 | 700 |
| 10 | 2,700 |
| 15 | 5,950 |
| 20 | 10,450 |
| 30 | 23,200 |

`MAX_LEVEL` is 30. XP keeps counting past it; the level does not.

The rule set is versioned `dynasty_v1`, and every summary carries that version.
If any number above ever changes, the version changes with it and this document
says what the old rule was — a player's history is **never silently rescored**,
the same promise Price It makes.

## Titles and stages

A title is what the player is called; a stage is what the War Room looks like.
They step together at 5, 10, 15 and 20, so a level-up that changes the room
always changes the name and the moment reads as one event. The last title, at
25, changes the name only.

| level | title |
|---|---|
| 1 | Rookie Analyst |
| 5 | Scout |
| 10 | Coordinator |
| 15 | Director |
| 20 | General Manager |
| 25 | President of Football Operations |

| level | stage | |
|---|---|---|
| 1 | The Garage | One desk, one monitor, a whiteboard and a season to prove something. |
| 5 | The Film Room | A second screen, a projector and a wall of matchups you have actually studied. |
| 10 | The Analytics Lab | Three monitors, a ratings board and the market ticker running all week. |
| 15 | Football Operations | A full room: film, roster, market and research stations under one roof. |
| 20 | Market Command | The wall of screens. Every game, every number, every disagreement, live. |

A level changes the room, the title, the badge in the header and what the
profile can show. It never changes EdgeDesk's numbers, any score, any rank or
any price; XP is not an input to anything. It is not a betting skill rating and
is never described as one. A subscriber earns exactly the same XP as anyone
else.

## Weekly missions

Five per football week, each a real thing to do with real games, and none of
them asks for anything a player cannot do for free.

| mission | target | counts |
|---|---|---|
| Price 3 games | 3 | unique matchups priced this week |
| Complete Pick 5 | 1 | this week's card submitted |
| Run a Two-Minute Drill | 1 | a daily Drill finished this week |
| Review one matchup | 1 | the EdgeDesk research opened for any game this week |
| Challenge a friend | 1 | a Head-to-Head created or answered this week |

Missions key on the football week — Tuesday 07:00 UTC, the same boundary as
everything else in Games — and progress is read from the same rows XP is.
Completing all five in one week is the weekly badge: `mission_set`, +150 XP.

There are no shorter timers. Nothing says "come back in 4 hours", nothing
counts down, and a mission never expires faster than the football week it
belongs to.

## Achievements

Each is a predicate over the record, carrying the record's own timestamp.
Nothing here can be granted; it can only be true.

| achievement | true when |
|---|---|
| First Price | one matchup has been priced |
| Ten Prices | ten different matchups have been priced |
| Fifty Prices | fifty |
| On the Number | a Price It landed within half a point of the benchmark |
| Contrarian | a Price It landed 7 or more points from the market |
| First Card | a Pick 5 card has been submitted |
| Perfect Five | a five-selection card settled five decided, five correct |
| Researcher | the research has been opened for 10 different games |
| Film Study | 50 different games |
| Seven Days | the best daily streak reached 7 |
| Full Week | every weekly mission was completed in one football week |
| Sharp Drill | a ten-round Drill, daily or free, scored 8 of 10 |
| No Huddle | a ten-round Drill, daily or free, scored 10 of 10 |
| Head-to-Head | a Head-to-Head locked with both players in |
| Rivalry | ten Head-to-Heads locked against the same player |
| Founder | a group has been created |

"Contrarian" is descriptive, not praise. It says a game was priced seven points
from the market, not that it was right to; nothing in the copy calls a
disagreement a verdict.

"Rivalry" counts `h2h_locked` events whose opponent is the same display name, as
recorded on the player's device. It is not a server-side identity.

Where an achievement is countable, the record carries progress and target
(7 of 10); where it is a single moment, it carries only whether and when.

Deliberately not built: a **Weekly Champ** achievement. It waits for the
leaderboard table to be live, because an achievement nobody can earn is a fake
one.

## The War Room

`/games/dynasty` is the player's home. A War Room exists from the first Price
It, Pick 5 card or daily Drill. The page shows the level and title, the XP bar
to the next level, the stage scene for the current level, and the stations:
Matchup Board, Market Desk, Drill Station, Film Room, H2H Board, Club Table and
Trophy Wall. Every station is a real link with a text label.

On a phone the room is a stack of stations, never a shrunken picture of a
desktop room. The room is CSS and SVG — dark ground, the EdgeDesk green,
restrained motion. There is no engine.

**The pulse.** Every page calls `EDGames.pulse()` after something real
happened, and once on boot for things that happened elsewhere — a research
open, a card that settled. It compares the live summary against the marker of
the one the player was last shown (`dynasty.seen` in the envelope), celebrates
exactly what is new — XP gained, a level, a stage, an achievement, a mission —
and stores the new marker. A level-up is announced once, on whichever page
first sees it, and a reload announces nothing. The only moment that interrupts
is a new level or the War Room being created by the first game; it is
dismissable, keyboard-closable, and never blocks the page underneath.

## Anonymous first, then the account

The War Room lives in the same `edgedesk_games_v1` envelope as everything else,
under four new keys — `events`, `research`, `drill`, `visits` — plus the
`dynasty.seen` marker. `EDGamesStore.exportForAccount()` now carries `events`,
`research`, `drill` and `visits` alongside the streak, the weeks, Price It and
Pick 5, so a sign-up inherits the whole War Room in one call. Nothing needs
migrating.

The ask — "Save your War Room" — appears only after real engagement
(`engaged()`: two completed challenges, where a Price It, a Pick 5 card and a
daily Drill each count as one), and once. It never appears during a first game.

## What is deliberately absent

Not by omission: fake scarcity, fake countdowns, fake notifications, fake users
or fake activity, artificial waiting timers, streak-loss purchases, loot boxes,
random paid rewards, pay-to-win, hidden subscriptions, premium rank advantages
and XP multipliers for subscribers. A subscriber gets **better research**, never
a faster War Room.

## Server-validated XP (Phase 2, not in this change)

Once an account exists, XP must not be trusted from the client. The contract:

* A `dynasty_xp_events` table with a unique key on `(user_id, kind, key)`, so a
  grant is idempotent by construction — the same `kind` and `key` the browser's
  ledger already names on every entry.
* Grants are written only by security-definer functions that verify the
  referenced row exists: a `game_challenge_entries` row for `h2h_locked`, a
  settled result for `h2h_win`. The client never inserts a grant.
* `games/lib/dynasty.js` is pure and runs in Node, so the server recomputes
  level and achievements with the same function the browser used. One rule,
  two runtimes, no drift.

This repository does not deploy it. Until it does, Dynasty state is on-device,
exactly like scores and streaks today.

## Phase 2 notes

Short, because nothing here is built:

* **Clubs** extend Groups. The group tables already hold members and standings
  per game, so a club label, club XP as the sum of members' weekly XP, and a
  season table are additive. No migration of existing groups is needed.
* **Seasons** key on the artifact's `season`.
* **Divisions** would be computed from weekly leaderboard finishes once the
  leaderboard is live.

---

---

# The Two-Minute Drill

## What it is

Ten rapid-fire questions about real matchups, two minutes on one shared clock,
three lives. The old-school arcade game in the War Room, and presented that
way.

The clock is one clock: it runs through the reveals, so reading the why costs
time. A wrong answer costs a life; nothing else does. The run ends when the ten
are answered, the lives are gone, or the clock is.

The first round is always the easy one: who EdgeDesk favours, on a matchup
priced at two touchdowns or more, when the board has one. The first five seconds
decide whether a cold visitor plays, so round one is a read anybody can make.
The order stays deterministic — it is the first such game in the seeded shuffle.

## Every answer is canonical

A question is asked only when the challenge artifact already carries its answer
as a field the Power 4 exporter wrote. The browser reads a number it did not
compute and asks which of two things it says. Nothing invents a decoy, a
distractor or a "close enough".

A question that would be a coin flip is not asked. Each kind declares a margin
below which the matchup is skipped for that kind:

| kind | reads | asked only when |
|---|---|---|
| favourite (THE MODEL) | `edgedesk_spread` | the favourite is at least 3 points |
| threshold (PRICE IT) | `edgedesk_spread` | the spread is at least 1.5, and is asked against the nearest of 3 / 7 / 14 / 21 / 28 / 35 that it sits at least 1.5 points clear of — "more or less than a touchdown?" |
| gap (MODEL vs MARKET) | `edgedesk_spread`, `market_spread`, `research_state` | the state is REVIEW or INVESTIGATE, both sides favour the same team, and the two favourites are at least 2 points apart |
| ol (ROSTER) | `context.*.ol_continuity` | the two sides are at least 10 apart |
| production (ROSTER) | `context.*.returning_production` | at least 10 apart |
| qb (ROSTER) | `context.*.qb_continuity` | at least 15 apart |
| churn (ROSTER) | `context.*.transfer_churn` | at least 5 apart (a count, not a percentage) |

Fewer questions beat a guessable one. A run takes no matchup twice and
interleaves the kinds so the roster questions do not all land together; when
the board cannot supply ten it returns fewer and says so (`short`). Only
matchups the rest of Games calls playable are eligible.

Every question carries its reveal — the numbers, in one sentence — and one line
on what it teaches.

## Deterministic

The day's drill is a pure function of the day key and the board. Its seed is
`daily:<dayKey>`, so everyone who plays today answers the same ten in the same
order and a score is comparable. Free play seeds on the run number instead:
`free:<dayKey>:<runIndex>`. The seed goes through the shared
`EDGamesChallenge.hash` into a small deterministic generator; there is no
`Math.random` anywhere. The day key is the streak's day key, with the same
07:00 UTC offset.

## Scoring (`drill_v1`)

```
100 per correct answer
+ 5 per whole second left on the clock — only when all ten were answered
```

A run that ends on lives or on the clock keeps its answer points and nothing
else. The result carries `scoring_version` and is never rescored.

The daily run is recorded once per day and replayed after that — the rule Price
It applies per challenge. Only the daily run counts toward the weekly score, at
10 points per correct answer, so a perfect drill is worth exactly one dead-on
Price It: comparable, not dominant. Only the daily run counts toward XP
(`drill_daily`, +40), and only it touches the daily streak. Free play is always
recorded and counts toward the run total and the best, and nothing else: the
leaderboard number cannot be farmed by playing all night.

The result's label is honest and never a verdict: "No huddle. Ten for ten.",
"Sharp drill.", "Solid read.", "Mixed read. The research explains the misses.",
"Rough one. Every miss has a why."

## The funnel

Every miss ends with the why and a **Research this matchup** link, which opens
the terminal on that game: `#research/football/<game_id>`. The terminal's
router opens that matchup's card rather than the whole board, so a player who
tapped a miss lands on the miss. The open is recorded on the player's record
once per game before the page leaves, so it counts toward the research mission
and the Researcher achievement, and the XP for it is celebrated when they come
back.

A perfect run has no misses to research, so it offers the model-versus-market
game instead.

## What it is not

No betting vocabulary, no odds, no money. A miss is a different read, not a
wrong one, and every miss has a why. A gap between EdgeDesk and the market is a
reason to read the research, not evidence of an edge — that sentence is in the
question itself.
