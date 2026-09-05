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

### Versioned assets

Every `/games` page loads its scripts and stylesheets from URLs that carry
one version token (`/games/games.js?v=20260905a`). A browser keeps a cached
`games.js` for as long as it likes, and a page built for a newer library
dies on the first function the old copy lacks. A new token is a new URL and
a fresh fetch. **After any change under `games/` that a page depends on:**

```
node tools/games/bump_assets.js        # stamps today's token on every page
```

`tools/games/games.test.js` fails if any page carries a different token, or
loads a games asset bare. Each page also carries a stale-script guard: if a
required function is missing at load, it shows a reload card instead of a
dead skeleton.

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
| `/games/franchise` | `games/franchise/index.html` | yes |
| `/games/roster` | `games/roster/index.html` | yes |
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
cash prizes, paid entry, tokens, purchasable currency, loot boxes, bet slips,
parlays, odds boosting, pay-to-win scoring, open chat, direct messages, public
posting, comments and follower counts. A subscriber gets **better research**,
never better scoring. (The franchise layer's resources — XP, Scouting Points,
Team Credits, Coach Points — are earned only; see *The franchise* below.)

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

# Game feel — every important action has a payoff

The rules that make a result a moment rather than a row. Each one is a
pure function or a fixed sequence, so it can be tested and never drifts.

## Price It, as a sequence

1. **The question.** A first-timer's eyebrow reads *Think you know the line?*
   The week label is for regulars. Under the readout a **lean bar** fills
   from the centre toward the favoured side and lights that team's name, so
   the read is visible before it is read; the number bumps on every change;
   *Reset to pick 'em* is one tap.
2. **The lock beat.** On lock the price the player set sits alone on the
   screen — *Your line is in* — for 900 ms (0 ms under reduced motion).
3. **The reveal, staggered.** Your price, then the market, then EdgeDesk,
   then the score. Under reduced motion everything is simply there.
4. **The read.** `EDGamesScoring.classify(user, market, edgedesk)` returns one
   of four descriptive labels against the market (EdgeDesk when there is no
   market), versioned `classify_v1`:

   | label | when |
   |---|---|
   | Near the market / Near EdgeDesk | within 1.5 points |
   | Aggressive favourite | more points to the favourite than the reference |
   | More underdog-friendly | fewer points to the favourite |
   | Way off consensus | 7 or more points away |

   None of them is a grade. An aggressive read is a read.
5. **The EdgeDesk snapshot** — the free research, worth reading on its own:
   the model's number, the market's, the research state, the one key driver
   (the first factor the exporter wrote), and how the rosters compare on OL
   continuity, QB continuity and returning production where they differ by
   five points or more. Then *Research this matchup*. The remaining factors
   fold under *Why EdgeDesk prices it here*.
6. **A first result says so.** *Nice. You just created your first EdgeDesk
   game result* and one line on how the score works. The mission list and
   the War Room are not shown until the second game (`DYNASTY.CREATE_AT`).

## Head-to-Head, as a person

* The invite landing leads with the name — *Davis challenged you* — then
  the matchup, the mode, one sealed line, the picker and the lock. Nothing
  else above the action.
* Both locked is *Picks are in*, with the kickoff and the series so far.
* A result is *You win* / *Davis wins* / *Draw*, the series against that
  opponent, and **Run it back** as the primary action. A loss is never
  framed as being shown up.
* **Rivalries** come from the player's own ledger:
  `EDGamesDynasty.rivalries(state)` reads `h2h_locked`, `h2h_settled`,
  `h2h_win` and `h2h_draw` rows keyed by invite token; a loss is a settled
  challenge that was neither a win nor a draw; `streak` is signed. Nothing is
  counted that the page did not see happen.

## Pick 5, as a ritual

Progress while picking (*3 / 5 picked*), *Lock my card*, then *Your week is
locked · 5 picks in*; a running line as games settle (*3–1 · one remaining*);
a final grade that describes the week (*Perfect card*, *Strong week*, *Rough
week. Every game has a why.*); the final score on each settled row, from the
artifact.

## The premium moment

EdgeDesk Pro is mentioned **once per football week, only after the player has
opened the research on three or more matchups that week**
(`EDGames.PRO_AFTER_OPENS`). The card names what full research adds, links to
the pricing page with the campaign carried, and has a real *Keep playing
free* button; either choice is remembered for the week. It appears after a
Price It reveal and on the War Room. It never appears on a first visit,
never before value, and the games never need it.

## Measured

`first_game_start`, `time_to_first_action` (seconds from this browser's
first visit to its first completed game), `rematch`, `premium_view_after_research`,
`keep_playing_free`, alongside the existing funnel.

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

Sound is **opt-in**: off until the player turns it on, remembered in
`localStorage` (`edgedesk_drill_mute`), a few WebAudio blips and no audio
assets. Nothing plays by default.

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


---

---

# The franchise

## The idea

Build a football dynasty by proving you understand football.

Every account can own **one fictional football franchise**: a city, a name,
a mark, a colour, an offensive and a defensive identity, and a roster of 38
fictional players nobody else has. The real EdgeDesk games are how it
improves. Price It is the scouting department; Pick 5 is the weekly slate;
the Two-Minute Drill is practice; Head-to-Head is competition. Each one pays
the franchise in its own resource, by a published table, on the server.

The persistent thing is the point. The record, the players, the ledger and
the achievements are kept for good, so that a player can eventually say
"I still have my original EdgeDesk team."

## Phase 2 — the weekly game (Game Day)

**Make Saturday matter.** Every franchise plays an eight-week season, one
game a football week, against fictional clubs drawn from a pool of
twenty-four (`franchise_opponents`), with a rival, chosen once for life, to
close every season. `/games/gameday` is the room: before Saturday it shows
who is next, what is in play and how prepared the week is; on Saturday it
shows one button; afterwards, the result.

* **The calendar rule.** Week *w* of a season belongs to the football week
  *w − 1* weeks after the one the season opened in, and its game opens on
  that week's Saturday at 07:00 UTC (Saturday everywhere in the United
  States). A game stays playable until it is played, so a missed week is
  not a lost game — but the preparation it runs on is the preparation
  recorded in ITS football week, so a missed week is a game played
  unprepared. Season I is scheduled the moment a franchise is founded, so
  the HQ answers "who am I playing?" from the first second; the next season
  starts when the player says so (`franchise_start_season`), numbered on,
  with the season lines reset and the careers kept.
* **The simulator, `sim_v1`, runs on the server and nowhere else.** A
  possession model: eleven to fourteen drives a side, each one resolved
  from the offense's effective rating against the defense's — team rating,
  home field (+1.5), that week's preparation (−3 at 0% to +3 at 100%), the
  published scheme matchup (`franchise_scheme_edges()`, −2 to +2, mirrored
  as `EDFranchise.SCHEME_EDGES` and pinned by a test), and the starters'
  traits. Overtime is two rounds, then a tie. It is seeded from the game's
  server-derived seed, so the same game simulated twice is the same game;
  a client sends "play" and nothing else. The box is stored on the game:
  quarters, scoring plays that name the scorer, team totals, a line for
  every starter that adds up to the team totals, and a player of the game.
  Every starter's `season_stats` and `career_stats` grow by their box, so a
  card's career line is the sum of its box scores.
* **Preparation, `prep_v1`, is the server's number now.** `franchise_prep()`
  restates `EDFranchise.prep` — three scouting reports are full Scouting;
  the card, practice and film complete Preparation — and both sides are
  pinned to the same worked examples by their test suites. The HQ and the
  Game Day page show the server's number when the snapshot carries it.
* **What it pays** (economy_v1, lines added): playing a game 100 XP and
  40 TC; winning 60 XP, 60 TC and 2 CP; beating the rival 50 XP and 1 CP on
  top; completing a season 250 XP and 150 TC. Achievements: First Win,
  Bragging Rights, Shutout, A Full Season, Winning Season, Perfect Season.
* **Server-authoritative, restated:** the schedule is drawn from a seed the
  server derives and the opponent's strength is frozen on the game row;
  `franchise_play_week()` locks the franchise row, plays the next scheduled
  game exactly once, refuses a game that has not opened, writes the box and
  the lines, moves the record and credits the ledger once per season-week.
  The simulator, the scheduler and the writer are reachable by no client
  role (report row 10).
* **Save it, in one step.** Wherever a device-owned franchise is on screen
  — the HQ, the Front Office, after a Game Day result, after a Price It —
  one form: email, password, the 21+/Terms line, one button
  (`EDGames.saveCard`). It creates the EdgeDesk account or, if the email
  already has one, signs into it with the same password; the device's
  franchise is claimed into it the moment it signs in. It is the same
  Supabase account and the same `edgedesk_session` the research terminal
  and the subscription use, so a player who later wants EdgeDesk Pro is
  already signed in and only has to pick the plan.

## Phase 1 — what is built

* `/games` is a football facility. The header names the rooms — HQ, War
  Room, Scouting (Price It), Training (the Drill), Game Day (Head-to-Head),
  Roster, League (Groups), Front Office — and a phone gets a five-room tab
  bar under the thumb. Nothing is renamed away: Price It is still Price It on
  its own page.
* **HQ** (`/games`): a franchise owner sees the franchise first — name,
  record, team overall, offense/defense/special, what is next, this week's
  Scouting, Preparation and Market IQ meters, the objectives, the next
  reward and the resources. It paints from a cached snapshot before the
  network answers and says so.
* **Front Office** (`/games/franchise`): found the franchise — no account
  needed — carry the anonymous record over, save it to an account (created
  from inside Games) whenever the player likes, and read the resources, the
  achievements, the ledger and the account. Share it as text.
* **Roster** (`/games/roster`): the 38 players as collectible cards, grouped
  by position with the starters marked, the strongest and weakest groups
  named, and a lineup change that goes to the server.
* Price It, Pick 5 and the Drill file their results with the franchise and
  show what the ledger was credited. Head-to-Head credits through the
  existing settlement.
* **Game Day** (`/games/gameday`, Phase 2): the weekly franchise game — the
  matchup, the window, this week's preparation and what is in play; the
  result with its box score and player of the game; the schedule, the
  all-time record and the rivalry. Head-to-Head is linked from it.

## The one rule, again

**The franchise layer computes no price.** `game_board` is a published copy
of `games/data/challenges.json`, written only by the service role from the
same workflows that build and settle the board (`games/publish_board.js`).
The canonical Power 4 exporter remains the only thing that prices a game; the
server keeps its own copy so that a browser's numbers are never what a reward
is scored against.

## What is server-authoritative

| thing | where it is decided |
|---|---|
| the roster | `franchise_generate_roster()`, from a seed the server derives; the same seed always builds the same 38 players |
| who is calling | `franchise_of(p_secret)`: the account, or the device secret's hash — never an id a client names |
| a Price It score | `franchise_record_price_it()`, against the board's EdgeDesk number, by the published `price_it_v1` rule restated in SQL |
| a Pick 5 card | `franchise_submit_pick5()` snapshots the BOARD's line onto every selection; `franchise_settle_pick5()` (service role) grades from the board's finals |
| every credit | `franchise_credit()`: one ledger row per (franchise, currency, kind, key); the totals are recomputed from the ledger, never incremented |
| an achievement | `franchise_award()`: once, and an exclusive one refuses any other season |
| Head-to-Head | a trigger on `game_challenges.settled_at`, fired by the settlement `games_social.sql` already performs |
| the schedule | `franchise_schedule_season()`: eight clubs from the pool, seeded from the franchise seed and the season number; the opponent's ratings frozen on the game row |
| a game's result | `franchise_sim()`, seeded from the game's server-derived seed, over the roster, the scheme, the opponent and the week's recorded preparation; written once by `franchise_play_game()` |

**The trust boundary, stated.** A Two-Minute Drill result is client-reported:
the drill is built and scored in the browser from the same artifact, and the
server cannot check the answers. It enforces one daily run per day and sizes
the reward (40 XP, 3 Team Credits per correct answer, at most 30); the
activity row is marked `verified = false`. A research open is a row the
client asserts; it is worth 15 XP and capped at ten games a week, the same
cap the War Room applies.

## The economy — `economy_v1`

Published once, in `franchise_economy()` (SQL) and `EDFranchise.ECONOMY`
(client). `tools/games/franchise.test.js` fails if the two disagree, number
for number. Nothing here can be bought: no packs, no premium players, no
paid resources, and a subscriber earns exactly what anyone else earns.

| real thing | XP | Scouting Points | Team Credits | Coach Points |
|---|---|---|---|---|
| Price It, once per game | 50 | 5 + round(score × 0.35) → 100 pays 40, 60 pays 26, 0 pays 5 | 10 + ⌊score ÷ 10⌋ → 100 pays 20 | |
| Pick 5 card, once per week | 75 | | 25 | |
| each correct side, as the games finish | 10 | | 15 | |
| a 5–0 card | 150 | | 200 | |
| the daily Drill, once per day | 40 | | 3 per correct, max 30 | |
| a research open, per game, ten a week | 15 | | | |
| a Head-to-Head settled (an account's or a device's entry) | 40 | | | 1 |
| a Head-to-Head won | 20 | | | 2 |
| founding the franchise | | | 100 | |
| a weekly game played (Phase 2) | 100 | | 40 | |
| a weekly game won | 60 | | 60 | 2 |
| the rival beaten, on top | 50 | | | 1 |
| a season completed | 250 | | 150 | |

XP levels the franchise on the War Room's curve (`25 × (L − 1) × (L + 2)`,
level 30 at 23,200). If any number changes, the version changes and this
table says what the old rule was.

## A team before an account

Nobody is asked to sign up to get a team. A franchise is founded at once, on
the server, and owned by an **account** or by the **device secret** the
social layer already uses for anonymous Head-to-Head play — a 256-bit
bearer secret the browser generated, of which the server keeps only the
SHA-256 (`games_hash`). Every franchise function takes an optional
`p_secret`; a signed-in caller is their account's franchise and nothing
else, a signed-out caller is the franchise whose hash matches, and a guessed
secret resolves to nothing. `franchise_claim()` binds a device-owned
franchise to the account that signs in, so signing up keeps everything that
earned the signup; an account that already owns one keeps it and the answer
says so. The home read model carries `owner: 'account' | 'device'`.

The `edgedesk_games_v1` envelope stays the anonymous record of the games
themselves. The franchise ask appears only after real engagement
(`store.engaged()`): for a player with no franchise, one sentence with the
real numbers the envelope is worth (`EDFranchise.preview`) and one button to
found one; for a device-owned franchise, the ask is to save it to an
account, because a new phone or a cleared browser cannot find a device-only
franchise.

Founding imports the envelope through `franchise_import_history()`. The
rule: credit fully only what the server can check. A Price It on a game that
has not kicked off is scored exactly as a live one; a Price It on a game
already played earns XP only, because the browser's timestamp is not
evidence of when the line was set. A card for a past week is kept as history
with the card's XP. Drill days are accepted under the drill's own stated
boundary. Everything is keyed once, so importing twice is importing once.

Signing in is the terminal's Supabase session (`edgedesk_session`), created
from inside Games by `games/lib/auth.js` against the same Auth endpoints the
landing page uses, with the same 21+ and Terms consent recorded on the
account and the same first-touch attribution carried into `user_metadata`.
Games still adds no identity of its own: an account is the terminal's, and
a device is the social layer's secret.

## Two calendars

**Real football makes EdgeDesk better; EdgeDesk does not stop existing
without real football.** So the franchise keeps its own calendar. A
franchise season is numbered (`franchise_seasons.number`, labelled Season
I, Season II, …), is a fixed number of weeks (`weeks`, default 8, so a
player completes several a year), advances on its own clock (`week`), and
records which real football season it began in (`season`). The HQ shows
both: *Season I · preseason · 8 weeks* beside *2026 CFB · Week 2 · live
slate*.

The two engines this leaves room for:

* **the live layer** — while real football is on, the board feeds Price It,
  Pick 5, the Drill and the week's preparation, and the live week is named
  on the HQ;
* **the franchise season** — the weekly simulated game (Phase 2), standings
  and playoffs, then the offseason: the draft, development, facilities and
  the summer's shorter events (Phases 4–5). It runs whether or not there is
  a slate this Saturday, on content the franchise universe generates.

Phase 1 laid the model down; Phase 2 runs it. Season I is scheduled at
founding and advances one game a football week (see *Phase 2 — the weekly
game*); the next season starts when the player says so.

## The roster

38 players: QB 2, RB 3, WR 5, TE 2, OL 7, DL 6, LB 4, CB 4, S 3, K 1, P 1.
Each carries four visible ratings for its position, an archetype whose skew
moves them apart, an overall that is their rounded mean, an age that leans
young, a development tier (steady, quick, star, superstar), a potential, a
rarity read off overall and potential, and for some a trait with a stated
effect for the simulator to come. Careers start empty — the story is written
from here.

Team overall is a weighted average of the starters:
offense `.30 QB + .12 RB + .22 WR(3) + .08 TE + .28 OL(5)`,
defense `.30 DL(4) + .22 LB(3) + .28 CB(2) + .20 S(2)`,
special `.50 K + .50 P`, overall `.45 offense + .45 defense + .10 special`.
A founding team lands between 66 and 74, tuned to 68–72; the SQL suite builds
twenty seeds and refuses any outside the band.

## Deploying it

1. Apply `supabase/games_social.sql` (already required by Head-to-Head).
2. Apply `supabase/games_franchise.sql`. Its report should print twelve
   `ok` rows. It is safe to re-run over a Phase 1 installation: the new
   tables, the opponent pool, the new activity kinds and achievement rows
   are added and nothing existing is rewritten. Until it is applied, the
   Front Office, the Roster and Game Day say so, and Price It, Pick 5 and
   the Drill are unaffected.
3. Nothing else. `games/publish_board.js` runs from the existing
   `games-challenges.yml` (publishes the board) and `games-settle.yml`
   (publishes finals and settles Pick 5) with the repository's existing
   `SB_SERVICE_ROLE` and `SB_URL` secrets. Without them the worker exits 0
   having done nothing. **No new secret is required.**

`/games/status` probes the layer and names the file to apply.

## Analytics

The existing GA4 property, no second vendor. Added: `franchise_created` ·
`franchise_home_view` · `franchise_signin` · `franchise_signup` ·
`franchise_import` · `franchise_claimed` · `franchise_reward` ·
`front_office_view` · `roster_view` · `player_view` · `roster_change`.
Phase 2 fires `gameday_view` · `season_started` · `weekly_game_started` ·
`weekly_game_completed` · `achievement_unlocked` · `season_complete` ·
`game_share`. Declared for the phases to come: `daily_objective_complete` ·
`scouting_spent` · `player_scouted` · `h2h_franchise_complete` ·
`draft_pick` · `trophy_room_view`. Every event now carries `identity`
(`authenticated`/`anonymous`) and `has_franchise`.

## Tests

* `tools/games/franchise.test.js` — the client: the economy pinned to the
  SQL, the identity lists, the roster plan, the level curve, the store's
  snapshot scoping and reward queue, the preview and the import payload,
  player presentation, the client's queue-and-replay behaviour, sign-in, the
  pages, the shell, the copy rules, the funnel, the worker, and the SQL
  file's conventions.
* `tools/games/franchise_sql.test.js` — the SQL, against a real PostgreSQL:
  the shared rules restated on the server, the board, creation, generator
  determinism and the founding band, who can read what, Price It scored from
  the board and replayed for nothing, Pick 5 submitted, settled, and a perfect
  card paid once, the drill's boundary, the research cap, the depth chart,
  the import, the Head-to-Head trigger through a correction, the read
  models — and the weekly game: the schedule set at founding, the Saturday
  window, a guessed secret refused, another account reading nothing, the
  simulator deterministic and its lines adding up, the preparation read
  pinned to the client's examples, forty games against a weak club and
  forty against a strong one, a week paid once, the season completed and
  the next one started with the careers kept. It skips loudly without
  Postgres; `games-sql.yml` refuses the skip.

## Not built yet, on purpose

Franchise Head-to-Head context, rivalries between players and conferences
(Phase 3); the Trophy Room page, facilities, player development, ageing and
the offseason between seasons (Phase 4); the draft and the transfer market
(Phase 5); playoffs and standings against other players' franchises. The
schema leaves room: `franchise_seasons.status` admits `playoffs`, the
ledger accepts a negative delta for spending, traits with no simulator
effect yet (Iron Man) are stated as such, and `franchise_activity` is the
record every future reward derives from. The simulator is versioned
(`sim_v1`) so a retuned one is a new version and old boxes stay true to the
rules they were played under.
