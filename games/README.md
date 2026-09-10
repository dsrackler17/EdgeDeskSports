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
* **The simulator, `sim_v4`, runs on the server and nowhere else.** A
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
* **Conference** (`/games/conference`, Phase 6): a league of friends with
  standings of its own — the table, the round waiting to be played, the
  schedule, the bracket, the invite link and the titles the conference has
  awarded.
* **Trades** (`/games/trades`, Phase 7): the rosters of the conference you
  are in, an offer built from both sides, the offers waiting on you, and
  every deal that was taken.
* **Coaching Staff** (`/games/staff`, Phase 8): four seats, what each coach
  is worth, what the next level costs, and the two curves that decide both.

## Gridiron — the football, and what it promises

`/games/play` is the playable game. Two modes, one engine, and one set of
books: **Coach Mode** calls plays and `EDGridiron.resolve` settles the snap;
**Play Mode** puts twenty-two men on the field in `games/lib/gridiron/live.js`
and the play happens frame by frame, then `EDGridiron.adopt` books it through
exactly the same rules, clock, drive and season. There is no second scoreboard
anywhere: every screen — the halftime panel, the touchdown graphic, the final
recap, the drive chart — reads `EDGridiron.boxScore`, which is a view of the
engine's state rather than a tally of its own.

**The stat model is NFL convention, stated once** in `engine.js` and asserted
on every finished game:

```
a sack is not a pass attempt        it is a team passing loss
team passing yards are NET          receiving yards minus sack yardage
a passer's yards are GROSS          as a passer's always are
a scramble is a rush                and so is a kneel
team yards        = passYards + rushYards
passYards         = passYardsGross - sackYards
passYardsGross    = the sum of that team's receivers
rushYards         = the sum of that team's carriers
att               = comp + incompletions + interceptions
```

The box score column called **Sacks** is what the defence did; the figure
beside it is what the offence allowed.

**The intended shape of a game.** Four quarters of fifteen minutes — 3,600
seconds — which the phone can shorten to Quick (8:00) or Blitz (5:00). Each
snap costs the play itself plus, only when the clock kept running between
snaps, about twenty-nine seconds of dead ball; that is what makes an
incompletion, a trip out of bounds late, and a timeout worth something. A full
game therefore runs to roughly **60 snaps and 10–12 possessions a side**, and
lands near 21 points, 5.8 yards a play, 67% completions, a 5% sack rate and
45% on third down. Every band in the harness is a rate, so the shorter
quarters produce the same football in less of it.

**Difficulty is decision quality, never ratings.** The four tiers in `ai.js`
change how well the opposing coach reads the situation, how quickly he adapts,
how wide his shortlist is, how well he disguises and whether he gets fourth
down right. They do not touch a single player's card.

**What keeps it honest.**

* `tools/games/gridiron_invariants.js` — the things that cannot be true. Run
  against a spread of games in `gridiron.test.js` on every commit, and against
  every game in the harness.
* `tools/games/gridiron_sim.test.js` — ten thousand games in two populations,
  six schemes, five deliberately lopsided matchups, a Play Mode sample and a
  determinism check, banded against real football and reporting the rate of
  every statistical anomaly. `npm run games:sim` for the full run,
  `npm run games:sim:quick` for the eight hundred CI runs on every push.

**Determinism.** A game is its seed and its call list. The same seed, rosters,
coaching, weather and preparation reproduce a game play for play, which is what
makes ten thousand simulated seasons a test rather than an anecdote — and what
lets a game in progress live in `localStorage` as twenty bytes of calls.

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
| a conference round played (Phase 6) | 80 | | 35 | |
| a conference round won | 50 | | 50 | 2 |
| a conference playoff game won, on top | 100 | | | 1 |
| a conference title | 400 | | 300 | 10 |
| the bowl played (Phase 7) | 150 | | 60 | |
| the bowl won | 300 | | 200 | 5 |

Coach Points are the only currency you cannot earn by playing a real game:
every one of them comes from **winning** something. Phase 8 is where they go.

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
2. Apply `supabase/games_franchise.sql`. Its report should print **27 `ok`
   rows**, numbered 0 to 26. It is safe to re-run over any earlier phase: new
   tables, columns, pool rows and achievement rows are added and nothing
   existing is rewritten. Until it is applied, the Front Office, the Roster
   and Game Day say so, and Price It, Pick 5 and the Drill are unaffected.
3. Nothing else. `games/publish_board.js` runs from the existing
   `games-challenges.yml` (publishes the board) and `games-settle.yml`
   (publishes finals and settles Pick 5) with the repository's existing
   `SB_SERVICE_ROLE` and `SB_URL` secrets. Without them the worker exits 0
   having done nothing. **No new secret is required.**

`/games/status` probes the layer and names the file to apply.

### What this database has — `games_schema_log`

Paste-and-re-run is the deployment story here, and it is staying: no runner
to install, no ordered directory to keep in step, every file safe to run
again. It had exactly one hole, and it was not idempotency — the suites
apply every file twice, every run. It was that **nothing could tell you what
a database had.** A project three phases behind looked identical to a
current one right up until a page called a function that was not there, and
`/games/status` had two words for the whole question: deployed, or not.

So every phase of every file now records itself as it applies:

```sql
select public.games_schema_note('franchise', 8, 'the coaching staff');
```

One row in `games_schema_log`, keyed `layer.phase`. The **first-applied date
never moves** — that is when this database got the phase, and it is the
useful one — while a re-run bumps `reapplied_at` and a run counter, so "when
did we last paste it" is answerable too. The log is a **record, not a
runner**: it gates nothing, blocks nothing, and applying a file is still the
entire deployment.

`games_schema()` is the read model, granted to `anon`, returning phase names
and dates and nothing about anybody. Its layer keys are not a hard-coded
list — a layer appears because it recorded itself, so `games_social.sql`
still knows nothing about the files applied on top of it.

Three places read that record, and all three must agree:

| where | what it does |
| --- | --- |
| `/games/status` | a **Database schema** row: what is installed, what this build wants, and — when they differ — the missing phases **by name** and the file to paste |
| `npm run games:schema` | the same answer in a terminal; `--live` calls `games_schema()` and **exits 1 if the database is behind**, so a deploy check can use it |
| `games/lib/franchise.js` | `SCHEMA_PHASES`, the client's mirror of the phase names, and `schemaGap()`, which turns a version into an instruction |

The mirror is pinned to the SQL by `tools/games/franchise.test.js` — a new
phase that forgets to record itself, or a name that drifts between the file
and the client, goes red. Adding a phase is two lines: the
`games_schema_note()` call at the end of the SQL, and its name at the end of
`SCHEMA_PHASES`.

A database applied **before** the log existed has no `games_schema()` at
all. Both the status page and the tool say exactly that, and say to re-apply
both files rather than guessing.

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

## Phase 3 — franchise vs franchise

**A challenge is a link.** From Game Day a franchise makes a challenge link
(`franchise_challenge_create`: up to ten open at once, good for fourteen
days, an optional line to send with it). Anyone holding the link sees who
is calling them out — the franchise's card: name, mark, overall, record —
with or without a franchise of their own (`franchise_challenge_peek`; the
token is the key, and it is returned to nobody but the challenger). A
visitor without a franchise founds one, no account needed, and the link
brings them straight back. Whoever accepts plays the game **at once, on
the server** (`franchise_challenge_accept`): `franchise_sim_versus()` runs
the same drive model as the season on **both real rosters**, each side's
own scheme matchup, traits and this week's preparation, on a neutral
field, seeded from a seed the server derives. The client sends the token
and nothing else. A challenge is played once.

**What a challenge moves, on both sides.** The ledger, by the table:
`fc_played` 60 XP and 30 TC; `fc_win` 40 XP, 40 TC and 2 CP; `fc_upset`
40 XP and 1 CP for beating a franchise rated five or more points higher.
Achievements: Exhibition Debut, Beat a Friend, Giant Killer, Three
Straight. Careers grow by the box; the season lines and the season record
do not — an exhibition is not a season game. The **rivalry record**
between the two franchises (`franchise_rivalries`, both directions,
append-only) counts challenges "on the field" beside real-game
Head-to-Heads "on the board", which the existing settlement trigger now
writes too. And both move on **the ladder**: ordinary Elo, K = 24, from
1500, zero-sum.

**The ladder lists franchises, never accounts.** `franchise_ladder()` is
public and returns a name, a city, a mark, an overall, a record and a
rating — no id a client could use, no email, no user. A franchise appears
on it only once it has played a challenge; founding alone puts nobody on
a public list. Game Day shows the top of it and where you stand.

**Head-to-Head, with the franchises behind the names.** When both players
in a real-game Head-to-Head have franchises, the page says which, with
the marks, and the record between the two franchises
(`franchise_h2h_context`, read by token; `games_social.sql` is untouched).
A franchise claimed into an account after an anonymous entry still maps
(`franchises.claimed_hash`).

Report rows 13–15 cover it: the versus simulator and the rivalry writer
are reachable by no client role; a challenge is open to every franchise;
the ladder is public and carries no account. The SQL suite plays it
through: the link read by a stranger and by the challenger, refused for
oneself, refused without a franchise, accepted once, both sides paid once,
the rivalry mirrored, the ladder zero-sum, the box adding up on both
sides, expiry, cancellation, the cap of ten, the upset paid only to the
weaker winner, and three straight.

## Phase 4 — the offseason, the facilities, the Trophy Room

The franchise now has a past and a future. Between seasons the roster
ages; the Front Office has the first place Team Credits and Coach Points
go; and everything permanent about a franchise is one page.

**The offseason runs before the next season, once.** When a franchise
whose season is complete asks for the next one (`franchise_start_season`),
`franchise_offseason()` runs first, on the server, seeded from the
franchise and the season number (`offseason_v2`):

- **Ageing.** Every active player is a year older.
- **Development.** A player 26 and under grows by his development tier
  (Steady 1, Quick 2, Star 3, Superstar 4), one more if he played four or
  more games, one more per Training Center level, with a little noise;
  27 to 29 hold about level (a point up with games and a Training Center
  at two); 30 to 32 slip a point or two (held up by a Training Center at
  three); 33 and over decline. Nobody grows past his potential, and a
  player past 30 has none left.
- **Retirement.** At 35, or at 33 and under 55 overall, a player
  retires. He keeps his career, leaves the roster read and joins the
  alumni (`game_players.status = 'retired'`, `retired_season`).
- **Rookies.** For every retirement one rookie is signed at that position
  from the same name and archetype pools as the founding roster,
  seeded so the same offseason signs the same player: 21 to 23, rated
  below the founding backups, with room to grow. The depth chart closes
  up first, so the chart is always 1..n. Thirty-eight players, always.
- **The report** — every player's before and after, the retired, the
  rookies, a summary — is written on the season that just ended
  (`franchise_seasons.offseason`), read back by home and by the Trophy
  Room, and never written twice. A founder retiring is a **Farewell**; a
  leap of four or more is a **Breakout**.

**The facilities are the first resource sink.** Four of them, three
levels each, published in `franchise_facilities()` (`facilities_v1`) and
mirrored in `EDFranchise.FACILITIES`:

| Facility | Bought with | Levels | Effect |
|---|---|---|---|
| Training Center | Team Credits 300 / 600 / 1000 | 3 | +1 development a level for players 26 and under, each offseason; veterans fade slower at levels 2 and 3 |
| Film Room | Coach Points 6 / 12 / 20 | 3 | +0.5 offense and defense in every game |
| Conditioning | Team Credits 300 / 600 / 1000 | 3 | +0.5 in the fourth quarter and overtime |
| Stadium | Coach Points 6 / 12 / 20 | 3 | +0.25 home field in season games |

`franchise_upgrade(p_facility)` takes a name and nothing else. The server
reads the level, the price and what is on hand, refuses the top level or
a short purse (`55000`, with the price and the amount on hand in the
message), and writes **one negative ledger row** keyed by facility and
level (`kind = 'facility'`, `key = 'training:2'`), so the totals still
derive from the ledger and nothing else. The first upgrade is
**Groundbreaking**. The Film Room, Conditioning and the Stadium show in
the box of every game they touch (`box.edges.facilities`, and each side's
own `film` and `conditioning` in a challenge) — a franchise challenge on
a neutral field has no Stadium. Nothing is bought with money; the page
says so beside the button.

**The Trophy Room** (`/games/trophies/`, `franchise_trophies()`) is one
read: every achievement definition with earned-or-not and the day, every
season newest first with its games and its offseason report, the career
leaders (passing, rushing, receiving, tackles, sacks — the retired
counted), the alumni with their careers, the all-time record, the rival
series, the facilities, the ladder and the challenge record. It is the
franchise's own room and nobody else's; a visitor without a franchise is
shown the door to the Front Office.

Report rows 16–17 cover it: the offseason and the rookie generator are
reachable by no client role; facilities are `facilities_v1`, bought with
earned resources through the ledger only. The SQL suite plays it through:
a refusal one credit short that debits nothing, the three prices, the top
level refused, the Film Room in a season box and on the owner's side of a
challenge, an offseason dry run rolled back and compared player for
player with the real one, ageing, the retirement rule both ways, the
chart closing up, rookies with names and numbers nobody in the colours
has worn, growth capped at potential, the veterans' decline, the report
written once, and the room read by its owner only.

## Phase 5 — the draft and the market

Where Scouting Points go. Every franchise gets a draft class of its own
and a short market of veterans, once per window — at founding, and every
offseason — generated on the server from the same pools as the founding
roster and seeded from the franchise (`market_v1`, published by
`franchise_market()` and mirrored in `EDFranchise.MARKET`):

- **The class.** Ten prospects, 21 to 22, anywhere from raw to ready,
  with the better development odds. Their true ratings are **hidden**: an
  unscouted prospect shows a name, a position, an age, an archetype and
  an overall range ten points wide whose placement is fixed per player,
  so asking twice narrows nothing. The direct read policy on
  `game_players` admits no prospect and no free agent at all; the board
  (`franchise_market_board()`) is the only way to look, and it shows
  what has been paid for.
- **A scouting report** (`franchise_scout(p_player)`) costs 20 Scouting
  Points, once per prospect, as one negative ledger row keyed by the
  player, and reveals everything: overall, potential, tier, ratings,
  traits. Scouting the whole class is **Scouted the Class**.
- **The draft** (`franchise_draft(p_player)`): two picks a window,
  renewed and never banked. A pick puts the prospect on the roster at the
  bottom of his position's chart with a number nobody on the roster
  wears. Scouted or not — the first pick is **Draft Day**, and an
  unscouted pick who turns out to have a potential of 80 or more is a
  **Gut Call**.
- **The market** (`franchise_sign(p_player)`): six free agents, 26 to
  31, who hide nothing and ask 100 Team Credits, or 20 for every point
  over 55 — one negative ledger row keyed by the player. The first is
  **Open for Business**.
- **The roster runs 38 to 42.** At 42 nobody joins until somebody
  leaves; `franchise_release(p_player)` takes a man off (never below 38,
  never a position's last starter), closes the chart up and writes the
  record. Free, irreversible, and on the record.
- **The window turns** with the offseason: the class and the market not
  taken are `passed` and kept as a record, a new class and market open,
  the picks are renewed. Founding opens window one, so Scouting Points
  have somewhere to go from the first day.

The client never prices, hides, reveals or places anyone: the Market
page sends a player id and the identity and nothing else, and reads the
board back. The roster page offers a release only where the server would
allow it, and asks once. The HQ counts the picks left as an objective
and the roster's room on the calendar line.

Report rows 18–19 cover it: the market is `market_v1`, scouting, the
draft, signings and releases open to every franchise and the generator
to none; the direct policy admits no prospect or free agent. The SQL
suite plays it through: founding's window and the rollover's, the
leftovers passed over, a client reading no prospect row, the range fixed
per read, a report one point short that debits nothing, a report bought
once with everything revealed, no report to buy on a free agent, two
picks then none, a pick at the bottom of the chart with a fresh number,
a gut call, a signing at the asking price and one credit short, the
forty-second man and the refusal after him, a release closing the chart,
a position keeping its starters, the floor at thirty-eight, another
account and a guessed secret reaching nothing, and the same seed making
the same class.

## Phase 6 — conferences and playoffs

A **league of friends with standings of its own**. Phase 3 gave a
franchise a one-off game against another franchise; a conference gives it
a season against several — a round robin drawn on the server, one round a
football week, a table that is the sum of what happened, a bracket at the
end and a title that stays on the record (`conference_v1`, published by
`franchise_conference_config()` and mirrored in `EDFranchise.CONFERENCE`).

- **The conference.** Four to twelve franchises. The one that creates it
  is its **commissioner**; everyone joins by a link, the same shape
  Head-to-Head and the challenge already use, and a franchise that lives
  on a device secret joins on the same terms as one on an account. A
  franchise belongs to **one conference at a time** — the unique key on
  `franchise_conference_members.franchise_id` says so rather than a
  comment.
- **The draw.** `franchise_conference_start()` is the commissioner's one
  privilege, and even it decides nothing: the schedule is drawn by
  `franchise_conference_draw()` by the **circle method** — one franchise
  held still, the rest rotated a place a round — from the conference's
  own seed, so everybody plays everybody once, nobody plays twice in a
  round, an odd conference carries a ghost and whoever draws it has the
  week off, and no client picks its own opponents. Rounds are capped at
  seven, so a large conference plays a partial round robin rather than a
  season without end. Round one opens on the Saturday of this football
  week, at the same 07:00 UTC boundary the weekly game uses; each round
  is the next week.
- **Playing it.** `franchise_conference_advance()` is open to **any
  member**, and calling it twice changes nothing. There is no cron and no
  privileged client: whoever opens the page after a round's Saturday
  plays that round for everybody, on the server, on the same versus
  simulator a challenge runs on — both rosters, both schemes, each side's
  own week of preparation, a neutral field, seeded from the conference's
  seed so the same game simulated twice is the same game. Both sides are
  paid by the table, keyed once by the game; both careers grow by the box
  (the solo season's lines do not — a conference is its own competition);
  the rivalry between them moves; and both move on the ladder by the same
  ordinary Elo the challenge uses.
- **The bracket.** When the last regular round is played, every member
  takes the place the standings gave it — wins (a tie is half a win),
  then point difference, then points scored, then ladder rating, then who
  joined first — and the rest are eliminated. Four make the bracket from
  six franchises up, two below that: 1v4 and 2v3 in the semifinals, then
  the final, one round a week. **A playoff game cannot end level**: the
  better seed is listed first and advances when the overtime cannot
  separate them, and the row says so.
- **The title.** The final crowns a champion, and the season is frozen in
  `franchise_conference_titles`: the champion, the runner-up and the
  standings exactly as they read, so a franchise that later leaves keeps
  every line it earned. The commissioner may start another season — the
  records begin again at nothing and the rings stay. The Trophy Room
  names the conference, the season and who was beaten in the final.
- **Achievements.** League of Friends, Top Seed, Postseason, Champion,
  Two Rings.

The client never draws, seeds, plays or crowns: the Conference page sends
a name or a token and the identity and nothing else, and reads the board
back. The HQ counts a waiting round as the day's objective and carries
where the franchise stands. Report rows 20–22 cover it: the conference is
`conference_v1`, created, joined, started and advanced by every franchise
and drawn and simulated by none; read by its members only and naming
franchises rather than accounts; one conference to a franchise, by the
key. The SQL suite plays two whole conferences through — a five-team
round robin into a two-team final, and a six-team one into a bracket of
four.

## Phase 7 — injuries, the bowl, and trades

The three things the last phase left on the list.

### Injuries — `injury_v1`

A game costs somebody. Drawn **after** the game from a seed derived from
its own, and never inside the simulator: the simulator plays exactly the game
it always played, and an injury is a thing recorded to have happened in
it. What it costs is the **weeks ahead** — the player cannot play, the
team rating drops, and the next game is played without him.

- **The chance** a franchise loses somebody is 0.22, less 0.03 for every
  level of the **Conditioning** facility (0.13 at level three).
- **Who** is a weighted draw over the men who were available: by position
  exposure (a back carries the ball, a kicker does not), doubled for a
  starter, and **halved for an Iron Man** — the trait that until now was
  documented as having no effect.
- **How long** is a draw against four severities: a Knock (one game), a
  Strain (two), a Sprain (three), a Fracture (five).
- **The one refusal**: a position is never taken below the starters it
  needs. A roster with one kicker keeps its kicker, and the draw comes
  back empty rather than leaving a lineup the simulator cannot fill.

**Availability is a function of the clock.** A player carries the instant
he is fit again (`game_players.injured_until`), and every read compares it
against the time it is asked about — so there is no heal job to run, no
cron to miss, and no window in which a healed player is still listed as
hurt. Five reads decide a game and all five ask it: the team rating, the
position averages, the trait effects and both simulators' lineups.
Everything about **roster membership** is unchanged: a hurt player holds
his number, his place on the depth chart and his place against the
ceiling. He is still yours. (`game_players.status` still admits
`'injured'`; it stays unused room, because a status needs somebody to
change it back and the clock does not.) The offseason sends everybody back
out fit — an injury is a cost inside a season, never across one.

### The bowl — `bowl_v1`

A postseason for the franchise's **own** season, for the player who never
joins a conference. Finish the eight weeks with **more wins than losses**
and a ninth game is scheduled a football week later: one club drawn from
the pool the season did not play, rated above you by two, plus one for
every win over .500, capped at eight — so a 7–1 season draws a harder game
than a 5–3 one. It gets a name (*the Copper Bowl*), it is played on the
same simulator on its own Saturday, and it counts in the record like any
other game. `franchise_seasons.status` finally uses `'playoffs'`: the
season is not complete, and does not roll over, until the bowl is played.
The bowl is paid its own line rather than the weekly one, and winning it
is **Bowl Winner**.

The conference keeps the bracket. This is one game, and it is the reason a
5–3 season is worth chasing.

### Trades — `trade_v1`

Players change hands between two franchises **in the same conference**.
That is the whole rule about who may deal with whom, and it is why the
conference came first: a league of people who play each other every week
is the only place a trade means anything, and the only place it is fair to
let one franchise read another's roster.

**The server checks legality, not fairness.** Whether a deal is lopsided
is for the two of them to argue about; whether it leaves a roster that
cannot field a team is not. One to three players a side, seven days to
answer, and every offer is **re-checked at the moment it is accepted**,
because a roster moves under an offer that has been sitting for a day: the
men named must still be there, both rosters must stay between 38 and 42,
and neither side may drop below the starters a position needs. A deal that
has gone bad is closed **with its reason on it** rather than raised — an
exception would roll back the very row that records why it died.

A hurt player can be traded; he is still on the roster, he simply cannot
play yet. The deadline is the bracket: nothing moves while the conference
is in its playoffs. **Nothing is paid for a trade** — no XP, no credits,
no fee. Just players, a new number where the old one is taken, the bottom
of the new depth chart, and a line on both records saying where he came
from.

Report rows 23–25 cover the three: injuries drawn by the server with
availability read off the clock, the bowl earned by a record and scheduled
by no client role, and trades open to both parties only, checked by the
server, and free. The SQL suite plays all three through — a hurt starter
dropping out of every read that decides a game, a sweep of sixty games
that hurts somebody and never the lone kicker, a record built to earn a
bowl and the bowl played, and a trade offered, declined, withdrawn,
refused for leaving a hole, and taken.

## Phase 8 — the coaching staff

**Where Coach Points go, forever.** Every other currency had somewhere to
spend itself indefinitely — Scouting Points buy reports, ten a window; Team
Credits buy free agents, priced per point. Coach Points had two facilities
worth **76 CP in total** and then nothing, while a single decent season
earns around thirty. That was backwards in a specific way: CP is the
currency you earn by *winning* — a weekly game, your rival, a challenge, a
conference round, a bowl, a title — so the hardest content in the game paid
in the one thing with nothing behind it.

Four seats, `staff_v1` (extended to `staff_v2` in Phase 12), published by `franchise_staff()` and mirrored in
`EDFranchise.STAFF`: a **head coach**, an **offensive** and a **defensive
coordinator**, and a **head trainer**. Each is one named person, generated
on the server from the same name pools the roster draws from, hired for 12
CP and levelled with CP — to a thousand.

### The two curves, which are the whole design

    cost(L → L+1) = 1 + floor((L − 1) / 10)
    effect(L)     = cap × ln(L) / ln(1000)

**What a level costs.** One Coach Point, going up a Point every ten levels.
Ten levels cost 9; a hundred cost 540; the whole thousand costs **50,400**.
So level 10 arrives in a first season, level 50 inside a year, level 100 at
about three — and level 1000 is *a horizon rather than a plan*. That is
deliberate. There is always another level.

**What a level is worth.** Every tenfold in level is another third of the
cap: level 10 is a third of the way, level 100 two thirds, level 1000 all
of it. A coach is useful the week you hire him and never finished, and the
long tail is honest about being a long tail.

Because the tail is long, the levels carry rewards of their own: a
**specialty** every 25 levels (ten of them, to level 250, drawn from the
pool that seat can hold and seeded so a coach always unlocks the same ones
in the same order) and a **grade** that reads off the number — Rookie,
Assistant, Coordinator, Veteran, Legend, and Hall of Fame at a thousand.

### Where a coach reaches

Nowhere new. `franchise_staff_effects()` returns the same shape
`franchise_trait_effects()` already does, so the simulator reads one more
object rather than learning anything: the coordinators add to offense and
defense, the head coach to the fourth quarter and overtime, and their
specialties to takeaways and clutch kicks. The trainer takes a slice off
the injury chance `injury_v1` already computes — never more than four
fifths of it — and adds to the offseason development the Training Center
already grants. A game's box states the staff among the edges it already
states.

The **team overall stays the roster's** number. Coaching is not player
quality and is not counted as it.

### A coach does not leave

Nothing poaches him, nothing retires him, nothing expires. Three years of
levelling cannot be taken away by a die roll — the sink is the levelling
itself, four seats deep and effectively bottomless, and it does not need
turnover to work. Firing is allowed and resets that seat to nothing, which
is exactly why almost nobody will: the level belongs to the coach, not to
the seat, and whoever replaces him starts at one.

Report row 26 covers it. The SQL suite proves both curves **level by
level** rather than at their ends — the cost never falls, the sum of the
steps equals the price of the climb at every level to 200, the effect never
falls and never passes the cap — and plays the building through: hiring
into an empty seat and refusing a filled one, a promotion that buys what
the purse can afford and says it fell short, a coordinator taken to level
301 for the 4,650 Coach Points the table says it costs, and a firing that
takes the level with him.

## Phase 9 — the scouting department

`scouting_v1`. **What reading real football well is worth.**

Eight phases in, the two halves of this game touched in exactly one place:
currency. Price a game and you earn XP, Scouting Points and Team Credits.
Price it *well* and you earn a few more of each. Nothing in the franchise had
ever known whether you were any good at it.

The evidence was already in the file. `franchise_prep()` computes three
numbers every football week. Two of them count **volume** — how many games you
priced, whether you sent a card, whether you ran a drill — and the simulator
reads one of those. The third is **Market IQ**, the average Price It score, the
only measure of *accuracy* anywhere in the schema, and it was computed,
returned, and read by nothing. Not by the simulator, not by a page. A dead
stat, and behind it a dead dimension: skill at the real game made you richer
and never better.

So: a scouting department, graded on how well you actually price games, and
what it is good at is finding football players.

### The grade

The average Price It score over your **last twenty verified pricings** — not a
week, because three games is noise, and not all time, because a department is
what it is doing now. An imported history earns XP and is not evidence, so it
is not counted.

Short of twenty on the record, the grade is pulled toward a neutral **50** in
proportion to what is missing:

```
grade = (average × priced + 50 × (20 − priced)) / 20
```

A new franchise therefore starts in the middle — not punished for having no
record, and not an A on one lucky pricing. Five perfect pricings grade 63, not
100. The twentieth pricing is worth more than the first, which is the point.

| Grade | From | Band | Report | Ceiling | Picks |
| --- | --- | --- | --- | --- | --- |
| Unrated | 0 | 18 pts | 28 SP | — | 2 |
| Regional scout | 40 | 12 pts | 22 SP | — | 2 |
| Area scout | 55 | 10 pts | 19 SP | +1 | 2 |
| National scout | 68 | 8 pts | 17 SP | +2 | 2 |
| Scouting director | 80 | 7 pts | 15 SP | +4 | 2 |
| War room | 90 | 5 pts | 14 SP | +5 | **3** |

**The ends are chosen so that neutral is the status quo.** At grade 50 the band
is 11 points and a report is 20 Scouting Points — exactly what every class was
shown at and every report cost before this phase, and no extra ceiling.
`scouting_v1` only ever *differentiates*: read games well and you see more for
less; read them badly and you see less for more; do neither and nothing
changed.

### What it buys, and when it is decided

Everything is in the draft window, and all of it is decided **once**, when the
window opens, from the grade standing at that moment:

* **the band** an unscouted prospect is shown in. The true overall is
  **uniform inside the band** — the rule is in the file and anyone may read
  it, so the honest thing is for the band to mean exactly what it looks like.
  The band always contains the truth, so a report never contradicts it;
* **the price of a report**;
* **the ceiling of the class** — up to six points of upside. It raises
  **potential, never overall**: a good department does not make a
  nineteen-year-old better today, it finds the one who will be. Rarity is
  restated by the generator's own rule so it does not go stale;
* **an extra pick**, at the top grade and only there.

Decided once, on purpose. The grade the window opened under is stamped on the
franchise (`franchises.scout_grade`) and the band on every prospect
(`game_players.scout_band`), and neither moves again until the next window. A
class cannot be improved by pricing games after you have seen it, and cannot
be taken away by a bad week either. The consequence is that **the weeks before
an offseason are the ones that matter**, which is exactly the habit this is
meant to reward. The Draft & Market page says both numbers — the department
that found this class, and the one you have now — because they are different
questions.

### What it does not touch

Not the simulator, not team overall, not a rating on any player already on the
roster, not Saturday. Reading real football well decides **who you find**. It
has never decided, and does not now decide, how the game itself goes — that is
the roster's and the staff's job.

Only Price It feeds the grade. Pick 5 and the Drill measure real skill too and
are deliberately left out: Price It is the game where you set a number against
EdgeDesk's own, and a scouting grade should mean one thing.

A class opened before this phase has no grade, and is shown and priced the way
it always was.

Report row 27 covers it. The SQL suite walks all four curves step by step (the
band never widens, the report never cheapens as the grade falls, the lift is
zero everywhere below neutral), rolls a twenty-game window from perfect to
terrible, opens the same seeded class under two opposite departments to prove
the overalls are identical and only the potential differs, and checks at
**every width from 4 to 20** that the band contains the true overall and is
exactly as wide as it says.

## Phase 10 — the development program, and a league that stands still

`development_v1` and `league_v1`. **Two halves of one problem, measured before
either was written.**

Ten seasons of a franchise doing everything right — every facility maxed,
every pick used, every free agent signed, every prospect scouted, four coaches
hired and promoted:

| | season 1 | season 4 | season 10 |
| --- | --- | --- | --- |
| team overall | 69 | 71 | **71** |
| record | 6-3 | 4-4 | 6-3 |
| facilities | 6 | **12 (maxed)** | 12 |
| achievements | 10 | 14 | **15 of 37** |
| Scouting Points banked | 600 | 2,550 | **6,050** |
| SP actually spent | 200 | 650 | **1,550** |

Ten years of perfect play was worth two points of team overall. There were two
reasons, and fixing either alone would have done nothing.

### One: a player could not be made better than he was born

`franchise_offseason()` claws back any growth past a man's `potential`, and
potential itself only ever holds the line. By season ten **76% of the roster
sat exactly at its ceiling**, with 1.43 points of headroom left across the
whole squad. The Training Center and the head trainer do not raise the wall;
they get a man to it sooner.

And the wall was low and the same for everybody. Of 425 players generated
across twenty franchise-seasons: none with 90 potential, two with 85, the
generator's best 83. **The finest 42 players it could ever roll would have
rated 78.** There was no great team to reach.

### Two: the league was a rubber band

```sql
oovr := greatest(45, least(95, round(ovr + d + (random() * 2 - 1))));
```

Every opponent was rated **from your own team overall**, plus a fixed offset
from `[-6,-3,-1,0,1,2,4]`. Get better and the league got better with you,
exactly in step. A twelve-season A/B — four franchises an arm on identical
seeds — found a development program worth +2.8 team overall and **not one
extra win**. It could not have been otherwise.

### The program — `development_v1`

An offseason ritual over your own roster, paid for with the currency nobody
could spend.

* **The window** opens when a season completes and shuts when the next one
  starts — the one moment the season just played is still on the books.
  Finish, look at who played, invest, advance. Starting the next season closes
  it and the places do not carry over.
* **The places** are two, plus one for every level of the Training Center — so
  two to five a year. Scarcity is the whole decision: not *can I afford it*
  but **who**.
* **The grade** is what he did on the field, 0–100, read straight out of the
  boxes the simulator already wrote — nothing was added to the hot path:
  **40** for the games he was available for, **30** for the team's record in
  them, **30** for his impact against **par** for his position and depth. Par
  is published and was measured off four thousand real box lines. Where the
  box score does not measure a man — the offensive line, the punter — impact
  sits at par by construction and his grade is availability and the team's
  record, which is the honest way to grade a lineman. **Play your young men
  and they develop; bench them and they do not.**
* **What it buys** is **potential, never overall**. A program does not make a
  nineteen-year-old better today; it earns him the right to grow, and he still
  grows into it through the same offseason curve — so the Training Center and
  the trainer become *more* valuable, not less.
* **The limits**: +1 to +6 by grade, full value to 26, half from 27 to 29,
  nothing at 30. A lifetime cap of **+15** a man, about three good programs,
  so an 83-potential prospect can become a 98 and nobody is remade in one
  offseason.
* **The price** is 100 Scouting Points for a man never developed and 15 more
  for every point already given him.

### The league — `league_v1`

The twenty-four clubs get ratings of their own, from **54 to 88**. They are
published, absolute, and have nothing to do with you.

* **Your standing** is where you sit, 0 to 100, moved by **results and nothing
  else**. Beating a club above you is worth several points; beating one well
  below is worth one. Losing to a club above you costs one; losing to one
  below costs several. The rival counts **exactly** double either way — the
  figure is rounded before it is doubled, so the promise holds. It starts at
  **40** — the bottom third, among clubs a new franchise can beat.
* **Each season's slate** is drawn around your standing: most of it near you,
  one club well above, one well below, the rival last. Climb and it hardens;
  fall and it softens. That is the protection the rubber band used to give,
  kept — without the part that made improvement pointless. **Within a season
  the clubs do not move, and a better roster beats them.**

Measured on the built thing, rosters pinned at fixed ratings:

Wins out of eight, four franchises a cell:

| standing | faces | team 60 | team 70 | team 80 | team 90 |
| --- | --- | --- | --- | --- | --- |
| 20 | 61.8 | 4.5 | 5.5 | 7.8 | 8.0 |
| 40 | 64.6 | 3.8 | **5.8** | 7.8 | 7.8 |
| 60 | 69.5 | 2.5 | 3.3 | 6.3 | 7.8 |
| 80 | 75.9 | 0.5 | 2.3 | **5.8** | 6.8 |
| 100 | 79.9 | 0.5 | 1.5 | 4.3 | **6.8** |

Across a row a better team wins more — that row was **flat by construction**
before. Down a column, climbing makes it harder. A new franchise (a 70 team at
standing 40) has a winning season at 5.8; the same roster at standing 60 wins
3.3 and has to improve. Each rung asks for about **ten points of roster**,
which is roughly what a career of development delivers, and even a 90 team
does not go undefeated at the top.

The slate deliberately sits a little *below* where you stand: measured with
pinned rosters, a team playing clubs of its own rating wins about four of
nine, not half, and without that offset a franchise ratchets into a difficulty
it cannot answer and loses from then on. An earlier tuning did exactly that —
fifteen seasons climbed to standing 70 with a 77 roster and then won one game
a year.

That is the loop: **develop your players → win more → climb the league → face
better clubs → and the ceiling you raised is what lets you beat them.**

Report rows 28 and 29 cover it. The SQL suite walks both sets of curves step
by step, plays a season out and proves a starter who played every game grades
above a man who never dressed, that a program moves potential and leaves
overall exactly where it was, that the window is shut while a season is under
way, that the places run out, and that no client role can grade a season,
count its own places, draw its own schedule, or write itself a standing or a
ceiling.

## Phase 11 — the rank, and the packs

`rank_v1` and `packs_v1`. **What turning up is worth.**

Every other progression in this game is paid for by being *good* at something:
Scouting Points by pricing games well, Coach Points by winning, the standing
by beating better clubs. Nothing was paid for by simply playing — and the one
number that measured playing, the franchise **level** off XP, was shown on the
Front Office and decided nothing at all. It also stopped: the curve caps at
level 30, which a franchise pricing three games a week reaches in about nine
seasons and then never moves again.

### The rank

Counted from the activity already on the record — every game played, every
game priced, every drill, every card, every research read, and five for
finishing a season. **Nothing new is written for it and nothing was added to a
hot path**: it is derived, the way `scouting_points` is derived from the
ledger, so it can never drift from what the franchise actually did.

| what you did | worth |
| --- | --- |
| a weekly game, a bowl, a conference round | 3 |
| a franchise challenge | 2 |
| a Pick 5 card | 2 |
| a Price It, a drill, a research read | 1 |
| seeing a season out | 5 |

Rank 2 costs **15** points and every rank after costs **three more** than the
one before. A first season is worth about seventy and lands around rank 4;
rank 20 stands on 798; rank 60 on 6,018. **It never caps** — the staff climbs
to a thousand and this climbs with the seasons.

### The packs

One pack for every rank, held until opened. A pack is **three players and you
keep one** — that is the decision, and it is also what stops forty packs
burying a forty-two man roster. The other two are passed over and stay on the
record as men you turned down.

**Who is in it** is drawn around **your own team overall**, so a pack is never
junk and never a shortcut:

* the **floor** sits 10 under your team overall;
* the **ceiling** rises with the rank — **+2** at rank 1, **+14** at rank 40
  and after.

Playing more does not hand you better players outright. It widens the top of
what a pack can contain, and the roll still has to land.

The advertised band is **true**. It did not used to be: the generator centres
a man's attributes on a target and then skews them by his archetype, which
pulled the average several points off — a pack that said 59 to 71 handed over
a 73. The whole man is now shifted so his overall is the number that was asked
for, keeping the spread between his attributes.

### Nothing here is purchasable

A pack is earned by playing and by nothing else. There is no pack to buy, no
currency that buys one, and no way to open one faster with money — the same
rule every other phase of this file keeps, and the reason a rank counts
activity rather than spending.

### Two things sixty seasons found

The measurement run this phase asks for turned up two faults, both now fixed
and both asserted:

* **A pack you could not keep from blocked every pack behind it.** Two packs
  are never on the table at once, so a pack opened with a full roster sat
  there forever — one franchise reached rank 45 having claimed 37, with three
  men stuck on the table for twenty seasons. You can now **turn the whole pack
  down**. The rank is spent either way, which is what keeps it a decision
  rather than a free re-roll.

* **The preseason never re-earned the depth chart**, and this was the larger
  one. The offseason compacted the chart but preserved whoever was already in
  front, so every man acquired — drafted, signed, kept from a pack, developed
  — joined at the bottom and stayed there for his whole career. A franchise
  sixty seasons deep was starting a **59 receiver ahead of a 75** and a 53
  corner ahead of a 66, and its **team overall decayed from 74 to 67 while its
  roster got better**. The preseason now sorts every position by who is best
  now; a player who wants it otherwise still says so on the roster.

Report row 30 covers it. The SQL suite walks the rank curve step by step
(the closed form and the sum of the steps agree at every rank to 60), proves a
pack man is not on the roster until he is kept, that keeping one passes the
other two over, that a full roster refuses him rather than growing past the
ceiling, that a rank pays one pack and cannot pay it twice, and that no client
role can count its own rank or reach the generator.

## Phase 12 — the long haul

`career_v1` and `staff_v2`. **Measured over sixty seasons**, on the game as
Phase 11 left it. It climbs beautifully and then cannot carry on:

| season | 1 | 5 | 10 | 15 | 20 | 30 | 45 | 60 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| team overall | 69 | 80 | **81** | 75 | 73 | 74 | 76 | 71 |

Three faults, all of them about the long game rather than the first ten
seasons.

### One — the roster turned over in a wave

The founding roster is generated across ages 21 to 32, but the old curve
skewed it hard toward 21. So almost nobody retired for seven seasons and then
everybody did:

| season | 1–7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15+ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| founders out | **1** | 4 | 1 | 5 | 4 | 2 | 4 | **7** | 0 |

**Twenty-seven of thirty-eight founding players left inside seven seasons** —
that is the cliff the curve falls off. Worse, their replacements were all
signed at once too, so the wave re-formed every fourteen years for ever.

Ages are now spread **evenly** across the same range, so about three men go
every season from the first, and the roster is always part-way through
renewing itself instead of doing it all at once.

### Two — the building could never be staffed

Coach Points came only from winning: two a win, five a bowl, one for the
rival. Measured across sixty seasons that is **10.4 a season**, against a
building where one seat at level 100 costs **540** and four seats cost 2,160
— two hundred seasons. After sixty years of winning football the measured
franchise had **one coach at level 99 and three empty chairs.**

So **a rank now pays Coach Points as well as a pack**: 20 for the first, two
more for every rank held after. The forty-five ranks a sixty-season franchise
earns pay about three thousand, against the six hundred that sixty seasons of
winning paid. Turning up is what staffs a building, and the rank is the number
that measures turning up.

### Three — firing a coach was a trap, not a choice

A replacement started at **level one**, so moving on from anybody threw away
every Coach Point you had ever spent on him. The README said so itself —
*"which is why almost nobody will"* — and a choice nobody takes is not a
choice.

A coach now arrives at a level set by the franchise's **reputation**: half a
level for every rank, one for every ten points of standing, capped at 60. A
club that has been at it for years and wins its games attracts somebody who
has done the job before. So both ways of playing work:

* **a new head coach every year**, if you are bad and want to keep trying —
  your reputation is low, the men you hire are cheap, and you lose almost
  nothing by moving on;
* **three or four coaches across sixty seasons**, if you are good — each
  replacement arrives near what your reputation commands, and the years you
  then put into him are what take him past it.

Keeping one man for sixty seasons is still the best a single seat can do: the
hire cap is 60 and a kept coach passes that inside a few years. It is simply
no longer the only thing that is not a disaster.

Report row 31 covers it. The suite walks both curves — a rank never pays less
than the one before, a reputation never commands less than a smaller one, and
neither runs off its cap — and asserts that the founding ages come from the
published range rather than the old skew.

## Phase 13 — the drives you call

*Retro Bowl, but leagues.*

Everything under this game was already deeper than the game it is named
after: a roster, a draft, a market, trades, a staff, a development
programme, a league of twenty-four clubs and a league of your friends.
What it did not have is the part your hands do. Game Day was **one
button**, and the page said so in as many words:

> Simulated on the server from your roster, your scheme, the opponent and
> this week's preparation.

You never played a down.

So the weekly game becomes a game you play — not sixty snaps, a dozen
decisions, one a possession, two or three minutes with a thumb:

```
WEEK 6 · 2nd quarter · you 10, Bayou 7 · your ball
  [ Ground ]  [ Balanced ]  [ Air it out ]  [ Take a shot ]
```

### A call is a decision, never a result

This is the rule the whole phase rests on, and it is the same rule
everything else in this layer rests on. **The client sends `air`. It never
sends `touchdown`.** The drive is resolved on the server from the game's own
seed, your roster, the opponent and the call — the call is one more input
beside home field, preparation and the scheme matchup, exactly like the ones
that were already there. Nothing here lets a page hand itself a score.

`franchise_game_call(p_call text, p_secret text)` takes a call and an
identity and nothing else. `franchise_sim_drive` and `franchise_game_drives`
are reachable by no client role. Report row 32 asserts both, and the SQL
suite plays a whole game a possession at a time and then tries to play it
again.

### The four calls — `snap_v1`

Published by `franchise_snaps()` and mirrored in `games/lib/franchise.js`,
so the page renders them without a round trip and the test file pins every
number to the SQL.

| call | pass share | touchdown | turnover |
| --- | --- | --- | --- |
| **Ground** | −0.22 | −0.025 | −0.075 |
| **Balanced** | 0 | 0 | 0 |
| **Air it out** | +0.20 | +0.030 | +0.095 |
| **Take a shot** | +0.28 | +0.060 | +0.190 |

### The first cut of that table was a lie, and eight thousand drives said so

The numbers above are the second draft. The first one gave *Take a shot* a
bigger touchdown chance and a matching turnover chance and called it a
trade. It was not, because **a turnover ended a drive exactly the way a punt
did** — at nothing. Eight thousand measured drives at an even matchup:

| call | points a drive | touchdown | turnover |
| --- | --- | --- | --- |
| Ground | 1.70 | 19.0% | 8.6% |
| Balanced | 1.78 | 20.4% | 12.3% |
| Air it out | 2.10 | 25.0% | 14.9% |
| **Take a shot** | **2.32** | 28.4% | 19.6% |

Shoot every possession and you score half a point a drive more for nothing.
That is not a decision, it is a button with a right answer, which is the
thing this phase existed to get rid of. Two changes fixed it.

**One — a giveaway hands the other side the ball in scoring range**
(`sim_v2`). This is what makes a turnover cost anything at all, and it is a
rule of football rather than a rule of calling, so it applies to quick play
and to franchise-vs-franchise challenges too. Old boxes still say `sim_v1`
and stay true to the rules they were played under.

**Two — which call is yours is a fact about your roster.** The simulator
computes a *lean*: how much better this team throws it than runs it, in
rating points, off the same position groups `franchise_team_rating()`
already publishes. A call cashes that lean in proportion to how far it leans
on the pass. So the same table produces a different best call for a
different team.

Measured again — two thousand whole games a cell, evenly matched sides,
twelve possessions each, every possession called the same way:

| roster | Ground | Balanced | Air it out | Take a shot |
| --- | --- | --- | --- | --- |
| **runs it better** (−8) | **+0.28** | +0.07 | −1.30 | −1.26 |
| **balanced** (0) | −0.58 | +0.19 | −0.41 | −0.15 |
| **throws it better** (+8) | −0.93 | −0.29 | +0.64 | **+0.74** |

*(average margin, in points; a cell is worth about ±0.34)*

Read down a column and it flips. On a team built around a line and a back,
shooting every possession costs you a point and a quarter a game; on a team
with a quarterback it gains you three quarters of one. On a balanced roster
all four sit inside a point of each other, which is to say **no button has a
right answer.**

They also differ in how much they swing a game — Ground ±14.6 points, Take a
shot ±16.6 — which is the other half of the decision: grind with a lead,
shoot from behind.

The report asserts the shape rather than the numbers: no call may raise the
touchdown odds without raising the turnover odds with them. The SQL suite
measures both fixes directly — that a giveaway is worth substantially more
to the other side than an ordinary possession, and that a passing roster
gains on the pass calls while a running roster loses by them.

### How it stays one simulator

There is no second simulator and no half-played game sitting in a table for
somebody to edit. The calls are stored on the game row, and `franchise_sim()`
reads them. Because the simulator is **seeded** and resolves drives in order,
a drive's outcome depends only on the seed and the calls *before* it — so
re-running after each call reproduces every drive already played and adds the
new one. A replayed request cannot change a drive that has already happened,
and the last call finalises through `franchise_play_game()` itself, so the
box, the rewards, the standing and the achievements are the ones every other
game has always produced.

Leave the page mid-game and come back and you are where you left it: the
calls are on the game, so opening it again replays them and shows you every
possession so far.

### Quick play stays

`franchise_play_week()` still plays the whole game at once, and a game played
that way is a game called **Balanced** the whole way through — the zero row of
the table above. Nobody is made to tap twelve times to see a result, and every
game already in the record was played under exactly the rules it says it was.

## Phase 14 — key moments

Measured before anything was written. Four hundred real games, and then
fifteen hundred more between two **identical** sides so nothing here could
be blamed on one team simply being better:

| possession | 1 | 4 | 8 | 10 | 12 |
| --- | --- | --- | --- | --- | --- |
| still live (within one score) | 100% | 67% | 51% | 46% | **44%** |
| average gap | 2.9 | 7.0 | 9.9 | 11.1 | **12.3** |

By the last possession only **forty-four per cent** of games are within a
score, and the leader has stopped changing about two fifths of the way in.
You call twelve possessions and more than half the late ones are taps on a
game already over.

### The first fix I tried was the wrong one

I gave the trailing side urgency late — push when behind, grind when ahead,
mapped onto the `snap_v1` calls the game already has — and measured it:

| | average margin | live finishes |
| --- | --- | --- |
| before | 12.3 | 43.9% |
| with late urgency | 11.9 | 44.1% |

Nothing. Pushing raises scoring *and* giveaways, so it buys variance rather
than points: it widens the distribution without closing the gap.

### The football is not broken

And it should not close the gap. Real games average about eleven or twelve
points of margin too. Blowouts are what football does. Building a rubber
band to hide that would have made the simulator worse in order to chase
drama — the same mistake Phase 10 found in the league and tore out.

So the fault was never the football. It is that **the game did not know
which possessions mattered.** All twelve were presented identically, none
was ever marked, none was ever remembered, and you were made to tap through
the dead ones.

### The stake — `moment_v1`

Every possession gets a number in `[0, 1]`: how much this one could swing
the game. Two halves, each obviously right on its own, multiplied together.

* **Lateness** — nothing is at stake in the first quarter of a tied game,
  because there is a whole game left to put it right.
* **Closeness** — nothing is at stake three scores down, because there is
  not.

| situation | stake |
| --- | --- |
| tied, last possession | **1.000** |
| a score down, last possession | 0.778 |
| tied, two to play | 0.750 |
| two scores down, two to play | 0.292 |
| tied, nine to play | 0.000 |
| three scores down, last possession | 0.000 |

At or above **0.50** the possession is a **key moment**: Game Day marks it,
says what is riding on it, and the call you make there is the one the game
is remembered for. That was always true and had never once been said out
loud.

Measured between even sides, a game has **1.36** key possessions, a third
have none at all, and half have two or more. A third of games with no
moment is the right answer — if every game had one, none would.

### Nothing here touches how a drive resolves

This is the load-bearing claim, and it is proved rather than asserted. The
stake is computed from the running score the simulator already keeps, so it
consumes no randomness. A hundred and twenty seeded games were played under
the old file and the new one:

| | games | same final score | same every drive |
| --- | --- | --- | --- |
| before vs after | 120 | **120** | **120** |

Identical outcomes, yards and plays. The simulator was still `sim_v2` when
this was written; Phase 15 put the game on a clock and made it `sim_v3`.

### The story

Every box now carries what happened to the lead — how often it changed
hands, the drive that took it for the last time and kept it, the biggest
moment played, and the possession after which it was over. Derived on the
server from the drive log the box already holds, so it cannot disagree with
the game.

### Play it out

When the stake is gone, one tap finishes the game rather than eleven. It is
not a shortcut past the football: every possession left is called
**Balanced** and resolved by the same simulator, which is exactly what quick
play has always been, and it ends through `franchise_play_game()` like every
other game.

### The reel

Sixty seasons of football and nothing stood out from anything else.
`franchise_reel()` returns the possessions that decided games, across every
season, ordered by what was at stake. It is **derived from the boxes already
stored** — no new table, no new policy, nothing to keep in step. The moments
a franchise remembers are exactly the ones it actually played.

Report row 33 covers it, and asserts the shape rather than the numbers: the
stake never leaves `[0, 1]`, closer is never worth less, later is never
worth less, a possession is worth the same to the side defending a lead as
to the side chasing it, and there is no table of moments anywhere in the
schema.

## Phase 15 — both sides of the ball

Measured first, and the measurement was damning. Six hundred games, the same
seeds, every possession called the same way:

| called every possession | Ground | Balanced | Air it out | Take a shot |
| --- | --- | --- | --- | --- |
| possessions a side | **10.95** | **10.95** | **10.95** | **10.95** |
| spread | 0.83 | 0.83 | 0.83 | 0.83 |

**Identical to two decimal places.** Possessions were drawn once, before a
snap, from two scheme labels and a dice roll, and nothing that happened in
the game ever touched them. Grind it out for sixty minutes and you got the
same number of possessions as a team that threw on every down. That is not
football; it is a turn counter wearing football's clothes.

And you only ever played half the game. Eleven possessions a side means
eleven possessions where the other team had the ball and you watched.

### The clock — `clock_v1`

There is no set number of plays any more. There are sixty minutes, and
possessions are what fits inside them. A drive costs time in proportion to
the plays in it and **how** those plays are run: the ball on the ground keeps
the clock moving (38 seconds a play), the ball in the air stops it (19).

| called every possession | Ground | Balanced | Air it out | Take a shot |
| --- | --- | --- | --- | --- |
| possessions a side | **10.57** | 11.14 | 11.67 | **12.08** |
| fewest → most | 8 → 13 | 9 → 13 | 9 → 14 | 10 → 15 |
| your plays | 64.1 | 68.9 | 74.2 | 78.2 |

Grind and there are fewer possessions in the game — for both of you, which
is exactly why a team with a lead runs the ball. Throw and there are more.

### What the clock does not do, which I claimed before measuring it

I wrote in the header comment that the clock would manufacture comebacks
where Phase 14's variance experiment could not. **It does not**, and I should
have measured before writing it.

Trailing with five minutes left, a side gets 2.93 possessions after that
mark; leading, 2.95. Sweeping the leading side's tempo from 1.30 down to 0.70
moved the comeback rate 13.4 → 17.9 → 15.7 → 13.8 per cent — non-monotonic,
and all of it inside the noise on a hundred-odd games a cell.

The reason is structural rather than a tuning problem: **possessions strictly
alternate**, so every second you save by hurrying hands the ball back sooner
and buys the other side a possession too. Real football gets around that with
timeouts, incompletions and onside kicks — a trailing team stopping the clock
while it is *not* holding the ball — and none of that exists here.

That is the second measurement in two phases to say the same thing: the
football is fine, and drama is not a thing to manufacture. Tempo stays
because it is true — a game late and close does run at a different speed —
and it is described as what it is rather than as a comeback engine.

### Defense — `defense_v1`

You call the other side's possessions too. Four fronts, and each number is
split by whether the ball is on the ground or in the air, weighted by the
offense's own pass share with **their call already in it**.

| front | td vs run | td vs pass | takeaway vs run | takeaway vs pass |
| --- | --- | --- | --- | --- |
| **Stack the box** | −0.060 | +0.050 | +0.035 | −0.020 |
| **Base** | 0 | 0 | 0 | 0 |
| **Cover deep** | +0.050 | −0.060 | −0.020 | +0.035 |
| **Blitz** | +0.030 | +0.040 | +0.080 | +0.095 |

The first cut of this table moved *rating points*, and measuring it showed
why that was hopeless: a call worth three rating points moves the touchdown
odds by 0.015, which is five hundredths of a point a drive. Stack the box
against a running team came out at **1.625** points allowed against Base's
**1.584** — the wrong way round, and both inside the noise. A defensive call
has to pull the same lever an offensive one does.

### The read is about them

Nine hundred whole games a cell, evenly matched sides, average margin:

| they run | Stack | Base | Cover | Blitz |
| --- | --- | --- | --- | --- |
| **power run** | **+2.47** | +0.59 | −1.65 | −0.86 |
| **pro style** | −0.41 | −0.09 | **+0.22** | −1.07 |
| **air raid** | −2.16 | −0.62 | **+2.46** | −1.09 |

Read down a column and it flips. Guessing right against a running team is
worth two and a half points; guessing wrong costs you a point and a half.
Against a passing team it is +2.46 and −2.16. Against a genuinely balanced
team every front sits inside half a point of the others — reading a team with
no tendency gains you nothing, which is correct.

Blitz sits around −1 everywhere, and that is its job. It takes the ball away
on **21.8%** of drives against Base's **12.8%**, and pays for it with 24.1%
touchdowns allowed against 20.9%. It has the widest swing of the four. It is
the front you call when you need the ball more than you need the point — the
same trade *Take a shot* is on offense.

That takeaway is not free money for the defense either: a giveaway hands the
*other* side the ball in scoring range (Phase 13), so a blitz that works is
worth a short field. Over whole games you score **25.6** with it against
**22.9** on Base — an upside that never showed up in points-allowed-per-drive
and only appeared when whole games were measured.

### What they are about to run

`franchise_ai_call()` picks the opponent's play from **their scheme** and
**the situation**, on the server, and no client role may ask it. So a
power-run team nursing a lead will run at you, and the same team down ten
with two minutes left has to throw. That is the read, and it is readable.

The first cut of that was too timid — it left a power-run team throwing on
47% of its plays against a pro-style team's 57%, ten points apart, and the
measurement said so: Stack the box came out *worse* than Base against a
running team, because the running team was barely running. The scheme
weights now put them 41% and 69% apart.

### One simulator still

The calls array is now one entry per **possession** in the order they
happened — your offensive call when you have the ball, your defensive call
when they do — and `franchise_sim()` reads it exactly as it did before.
Re-running still reproduces every possession already played. A call names its
own side (the two tables never share a key), so one meant for the other is
refused rather than quietly defaulted.

The simulator is `sim_v3`, and **franchise-vs-franchise challenges run on the
same clock**, so a challenge is the same football as a Saturday. Neither side
is at a keyboard there, so both call from their own scheme and situation —
which is what quick play is on a Saturday too.

Report row 34 covers it.

## Phase 16 — the playbook

Measured first:

| | |
| --- | --- |
| offensive options, any scheme | **4** |
| do they differ by scheme? | **no** — `franchise_snaps()` takes no argument |
| formations | **0** |
| trick plays | **0** |

Four calls was the entire offensive vocabulary, and every franchise in the
game had the same four. Your scheme picked your pass share and nothing else,
so an Air Raid and a Power-Run team called from an identical menu.

And there was no such thing as a big play. Eight thousand drives: a touchdown
drive was **55 to 85 yards, every time**, spread 9.0. Every score looked
exactly like every other score.

### A play specialises a call — it does not replace one

Every play names one of the four calls as its **category** and inherits that
call's numbers exactly as Phase 13 measured and tuned them, then adds its own
on top. Nothing measured there is thrown away, and quick play is still a game
called Balanced.

### Formations, and what lining up in one tells them

Five sets. `tell` is what the formation says before the snap: −1 screams run,
+1 screams pass. That tell is not flavour — the other side reads it and calls
their front off it. Three thousand snaps a row:

| formation | tell | stack the box | base | cover deep | blitz |
| --- | --- | --- | --- | --- | --- |
| **Wildcat** | −0.90 | **59.9%** | 29.7% | 1.9% | 8.5% |
| **I-Formation** | −0.75 | **55.6%** | 32.2% | 1.9% | 10.3% |
| **Singleback** | −0.25 | 37.0% | 36.5% | 16.3% | 10.2% |
| **Shotgun** | +0.45 | 9.6% | 34.8% | **45.4%** | 10.2% |
| **Empty** | +0.90 | 2.4% | 29.7% | **59.3%** | 8.6% |

Lining up heavy really does get you a stacked box. That is the cost of a run
formation — and the entire reason the trick play out of it works.

### Playbooks

Which formations you carry depends on your scheme, so the menu genuinely
differs from team to team:

| scheme | book |
| --- | --- |
| power run / option | I-Formation, Singleback, Shotgun, Wildcat |
| pro style | I-Formation, Singleback, Shotgun, Empty |
| spread | Singleback, Shotgun, Empty, Wildcat |
| air raid | Singleback, Shotgun, Empty |

Twenty plays, and **no franchise holds all of them**. An Air Raid has no
I-Formation, so it has no flea flicker, and asking for one is refused rather
than run.

### Trick plays need a formation that lies

A trick play **contradicts its own formation's tell** — a flea flicker out of
the I-Formation, a quarterback draw out of Empty — so it pays off exactly
when the defense has bought the tell. The same trick, fresh, against the
front its own formation actually draws:

| trick | formation | points a drive | fooled them | broke a big one |
| --- | --- | --- | --- | --- |
| **Wildcat pass** | Wildcat | 3.013 | 0.74 | 43.9% |
| **Flea flicker** | I-Formation | 2.913 | 0.72 | 38.5% |
| **Halfback pass** | Singleback | 2.472 | **0.30** | 15.0% |
| Quarterback draw | Empty | 2.176 | 0.74 | 25.6% |
| Double reverse | Shotgun | 2.069 | 0.63 | 29.0% |

The Halfback pass is the one that proves the rule. It lives in Singleback — a
formation that tells them nothing — so it fools people **0.30** of the time
against the Flea flicker's **0.72**, and it is worth half a point a drive
less. A trick play is not a good play; it is a good **lie**, and it needs a
formation willing to tell it.

Against the front that bought the tell, a flea flicker is worth **3.196**
points a drive. Against a defense sitting deep, **2.149**.

### And they go stale, because there is no trick-play strategy

| times called already this game | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| points a drive | **3.259** | 2.877 | 2.437 | 2.524 |
| touchdown | 41.6% | 36.2% | 30.1% | 30.8% |
| giveaway | 33.5% | 36.4% | 39.1% | 38.3% |

**My first cut of that was not enough**, and measuring whole games said so.
It only withheld the bonus, which left a stale trick looking like a
Take-a-shot with a few more giveaways — and calling the flea flicker on every
possession came out as the **best** strategy in the game:

| calling every possession | margin | before the fix |
| --- | --- | --- |
| all four verticals | −2.57 | −2.65 |
| a real mix | −2.64 | −2.66 |
| run then trick | −3.83 | −3.38 |
| all inside zone | −5.05 | −5.05 |
| two tricks | −6.57 | **−1.61** |
| **all tricks** | **−6.98** | **−1.54** ← *was the best* |

So being read now costs you: a trick they have seen is **worse** than an
honest play, not merely less good. Trick spam went from the best strategy in
the game to the worst, by four and a half points against a real mix.

### A big play exists now

An explosive play is more yards in fewer snaps — which the clock then feels,
because a drive that goes 60 yards in four plays takes less time than one
that goes 60 in nine. The flea flicker breaks one 38.5% of the time. Before
this phase, nothing ever broke.

Report row 35 covers it, and asserts the shape rather than the numbers: every
play names a real call and lives in a real formation, every trick contradicts
its own formation's tell, no scheme carries every set, and what the defense
is about to line up in is reachable by no client role — seeing their answer
before you commit would be the whole game.

## Ten thousand seasons

Everything above was measured. This is what happened when the game was left
to run — franchises playing through the **public moves**, the same doors a
player uses, for eighty seasons each — and it found two things that no
smaller measurement had.

### One — 38.5% of careers ended, permanently

Not "the team got bad". **The franchise could never play again.** Every
attempt to play the next game threw, for ever.

| | |
| --- | --- |
| franchises measured | 26 |
| bricked before season 80 | **10 (38.5%)** |
| earliest death | **season 5** |

The cause was one line in `franchise_offseason`. It signed one rookie per man
who retired at a position that **still had somebody active**, because its
outer loop read:

```sql
for v_pos in select distinct position from public.game_players
              where franchise_id = p_franchise and status = 'active'
```

The moment the last quarterback retired, `QB` stopped appearing in that list
and could never be signed again. Across fifteen franchises:

| position | franchises with none | average available |
| --- | --- | --- |
| **K** | 14 of 15 | 0.1 |
| **P** | 14 of 15 | 0.1 |
| **QB** | 9 of 15 | 0.8 |

The thin positions — the ones a roster carries one or two of — empty out
almost universally, and nothing ever refilled them.

Then the kill: `franchise_sim` credits a touchdown by building a JSON key out
of the scorer's id. With nobody at the position that id is null, jsonb throws
`argument 1: key must not be null`, and the game dies. Not that game — every
game after it.

**Two fixes, and the game needs both.**

*The floor* (`offseason_v2`): the offseason now walks `franchise_pool_plan()`
— the same table a founding roster is built from, eleven positions summing to
38 — and signs **up to it** rather than one-for-one. An empty position is now
the loudest thing in the loop rather than an invisible one.

*The belt* (`franchise_anybody`): a score has to land on a name. Asked for a
man who is not there, the lineup offers the next at that position, then the
best player left, and skips the tally rather than keying it on nobody. **A
thin roster is a bad team; it is never a dead one.**

| | before | after |
| --- | --- | --- |
| careers reaching season 80 | 61.5% | **100%** |
| rosters missing a position | 14 of 15 | **0** |

One honest consequence: a position left short by a **trade** is topped up too,
so you cannot run a deliberately thin roster. The replacement is a rookie, so
trading a good lineman away still costs you the lineman — it just no longer
costs you the body.

### Two — just playing made you worse

With careers no longer dying, the arc underneath was visible, and it ran the
wrong way:

| season | 1 | 3 | 5 | 10 | 20 | 40 | 60 | 80 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| team overall | 69.7 | 70.4 | 68.9 | 66.1 | 62.1 | 61.9 | 62.1 | **62.2** |
| wins | 5.73 | 5.53 | 4.20 | 4.67 | 3.87 | 4.13 | 3.60 | 4.60 |
| standing | 46 | 54 | 55 | 46 | 29 | 28 | 27 | **27** |

A player who simply turned up and played got **worse for eighty seasons** and
settled eight points below the team he was handed.

It was not that replacements were worse than the men they replaced — rookies
signed at **55.1** against retirements leaving at **53.2**. The pool itself
was the ceiling: a rookie's level was pegged to `lowest`, the **worst backup
in a founding roster**, for ever, whatever the franchise had become. By season
eighty every man on the roster was an offseason rookie (608 of 608), so every
team converged downward to that pool.

So a rookie now arrives at what the franchise's **reputation** commands
(`rookie_v2`), exactly as a coach has since Phase 12: a quarter of a point per
rank, one per twelve points of standing, capped at fourteen. Turning up raises
the rank and winning raises the standing — the two things a passive player
actually does are the two things that lift the men he signs. The cap is what
stops the loop (better rookies → better standing → better rookies) running
away.

| season | 1 | 3 | 5 | 10 | 20 | 30 | 40 | 60 | 80 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| team overall | 69.8 | 70.4 | 69.4 | 68.5 | 68.6 | 69.8 | 70.5 | 73.0 | **74.1** |
| best player | 74.9 | 78.4 | 81.6 | 80.8 | 82.9 | 83.9 | 83.5 | 86.5 | **89.0** |
| standing | 45 | 56 | 58 | 54 | 47 | 45 | 57 | 60 | **63** |

Instead of decaying to 62, a franchise dips slightly around season ten and
then **climbs to 74**, with its best player going 75 → 89. Wins hold near
4.8 of 8 throughout, which is the league doing its job: `league_v1` draws
opponents around your rating, so getting better means playing better teams.
The standing and the rank are what measure the climb.

### Two things the run did NOT find, and I am not fixing

**Coach Points pile up to 851 unspent.** That is my *harness*, not a player:
the bot only calls "play" and never reads the HQ, which already carries a
"Staff: seats to fill" line the moment you have the points for one. There is
no fault here to fix.

**A pure-play franchise earns 11 of the 45 achievements and then plateaus.**
Also correct. The other 34 are behind the front office, the draft, friends
and conferences — including `dynasty_80`, "fielded a roster rated 80
overall", which a franchise that only plays now peaks below at 74. That
achievement is the one that says you actually built something.

### What made it fun for anyone

Not a tutorial. The two bugs *were* the accessibility problem: a game that
ends 38.5% of careers without explanation, and makes you worse for the one
thing a newcomer knows how to do, is not fun for anybody — and it is worst
for the player who does not yet know there is a front office. Both are gone.

## A lapsed sign-in

Reported from a real device: tapping **Found my franchise** answered

> `JWT expired`

in the gateway's own words. It was worse than it looked. Every Games call was
failing, not only founding.

The client had already worked out that the player was anonymous — `signedIn()`
was false, and the call correctly carried a device secret, which is exactly the
path a player with no account uses. But the transport read the stored session
**without checking its expiry** and put the dead token in the `Authorization`
header. PostgREST rejects that at the gateway, before the function runs. A
well-formed anonymous call was killed by a credential the client itself had
already decided not to trust.

One rule now, everywhere a token is read:

```js
function live() {
  var s = session();
  return past(claims(s)) ? null : s;
}
```

**A token past its expiry is not an account.** `user()`, `signedIn()`, the
transport, and the home page's pre-paint hero all ask the same question. The
home page mattered too: reading `sub` without reading `exp` painted an HQ hero
for a lapsed session that every call behind it then denied.

Two things it deliberately does **not** do:

* **it does not clear the session.** The refresh token inside it is the
  research terminal's to spend — Games has never minted or refreshed one — and
  throwing it away would turn a lapsed sign-in into a lost one;
* **it does not stop the game.** An expired session falls back to the device
  secret, which is a real identity with a real franchise behind it. `expired()`
  names the state so a surface can say so, because "your session lapsed" and
  "you have never signed in" are different things to be told.

And the gateway's words are no longer read out to a player: a `JWT` error
becomes *"Your sign-in expired. Sign in again to save what you play — the game
keeps going either way."*

### Checking the token was still a guess

That rule fixed the reported case and left three it could not see, because
reading `exp` before sending is only ever a **guess** about what the gateway
will accept:

| the stored token | with the expiry check alone | now |
| --- | --- | --- |
| expired | founds | founds |
| expiring inside 30 seconds | founds | founds |
| **unparseable** | **`JWT expired`** | founds |
| **no `sub` claim** | **`JWT expired`** | founds |
| **looks live, server says no** | **`JWT expired`** | founds |

The first two the check catches. The next two it does not: `claims()` returns
null for a token it cannot read, and `past(null)` is false — so the dead token
went out anyway, which was the original bug wearing a different coat. The last
one **no** pre-check can catch: a device clock that disagrees with the server's,
or a key rotated underneath us, produces a token this client believes and the
gateway refuses.

So the client stopped guessing. **A 401 is the answer**, and the same bearer
cannot get a different one:

```js
if (r.status === 401 && !anon && s) return send(fn, args, true);
```

The call goes out once more with the public key — which is exactly what the
device secret already on it is for. The retry is the last word: an anonymous
401 is a real refusal and is not asked twice.

## Progression a player can actually see

The rank and the packs it pays have existed since Phase 11 (`rank_v1`,
`packs_v1`): you earn points by playing, the points buy ranks, and each rank
owes a pack of three players to keep one from. None of it is purchasable.

It was also, on a phone, **invisible**. The Packs room is `gh-only-wider`, so
the tab bar carries HQ, Scout, Train, Game Day and Roster and nothing else —
Packs, Staff, Development and Market live only in the footer. And
`franchise_home` did not return the rank at all, so the HQ *could not* have
shown it. The one moment the whole progression pays out was a footer link.

So the home read model now carries it:

```sql
'reputation', public.franchise_rank_report(f.id),
```

It is **derived** — a `stable` function summing the activity log — so this adds
no write and cannot drift from the record.

On HQ:

* **a pack you have earned is the first objective**, above Game Day, because it
  is the one row that is a reward rather than a chore — *"Packs: 2 waiting ·
  three players, keep one · Earned by playing, never bought"*;
* **the rank rides on the calendar strip** beside the season and the ladder —
  *"rank 3 · 42/60"* — so the distance to the next one is always on screen.

Both link to the room that opens them, which is how a phone reaches it at all.

## The age gate

The game is **open to everyone**, and nothing about it is gated: no game, no
page, no score, no franchise, and nothing is asked on arrival.

What is gated is the one door **out** of the game. EdgeDesk's research
terminal is a betting-research product and carries a 21+ line in every footer
on this site. So it is asked for exactly once, at the moment somebody reaches
for it:

* one delegated listener catches **every** link to the terminal, including
  ones a page adds later, so a new link cannot quietly skip the gate;
* the programmatic opener goes through the same check, not a second one;
* a **no** is remembered, never asked twice, and changes nothing about the
  game — the dialog says so in those words;
* **nothing is collected**: no name, no date of birth, nothing sent anywhere.
  The stored shape is `{answer, at}` and the tests assert it holds nothing
  else.

## Ranking up offline

The half of the Phase 12 ask that was described and never proved: **rank up
with no server in reach, and connect it later.** My standing position was that
it already worked, because the rank is derived from activity and activity
already queues. It did work — and measuring it found something that did not.

### Why there is nothing to synchronise

`franchise_rank_report` is a `stable` function. It sums the activity log with
the published weights and writes nothing:

```sql
select coalesce(sum(coalesce((w->>a.kind)::int, 0)), 0) into v_points
  from public.franchise_activity a where a.franchise_id = p_franchise;
```

No column on `franchises` holds a rank or a point total — only `rank_claimed`,
which counts packs opened. So a rank cannot drift out of step with the record,
because it **is** the record, read back. And `franchise_activity` carries

```sql
unique (franchise_id, kind, key)
```

on the exact `key` the browser's queue stores a call under. A reward replayed
after a lost answer lands once, whatever the browser believes.

Measured rather than argued: a week of playing with no signal — one Price It,
one Pick 5 card, one drill, fourteen research opens — is **18 points, rank 2,
two packs owed**. Sending the identical queue a second time writes **no second
row**, pays **nothing**, and returns a **byte-identical** rank report. Replaying
the same week **backwards** gives the same rank to the point. And the War Room's
weekly XP cap (ten reads) does not cap the rank: the four reads past it earn no
XP and still count, or a player who did more than the cap would have done it for
nothing.

### What the measurement actually found

The four things you can do without a server — Price It, a Pick 5 card, the
drill, a research open — are exactly the four the client queues, and each is
worth rank points. The football is never queued, because a game has no result
until the server rolls it.

But a queued reward is only ever **dequeued on success**. So:

> A drill is honest only on the day it was run — the server refuses one recorded
> more than a day late. Run a drill offline on a Monday, reconnect on Thursday,
> and the browser asked for it on **every boot, for ever**, and the front office
> read **"1 reward waiting to sync"** for the life of the account.

Reproduced before it was fixed, five boots in a row, queue length 1 every time.

### The rule the queue now follows

The queue is for a call the server never **ANSWERED**. It is not a place to
keep one the server has refused.

```js
function retryable(r) {
  if (!r.status) return true;
  return r.status >= 500 || r.status === 404;
}
```

No status at all means the request never arrived — offline, timed out, or no
endpoint in this build. A 5xx means it arrived and the server broke. A 404 means
the layer is not deployed yet, and one day it will be. All three are worth
replaying. Everything else is the server having read *that* call and said no,
and the same payload cannot get a different answer on the next boot.

| the server said | kept | why |
| --- | --- | --- |
| nothing at all (offline) | **yes** | it never arrived |
| nothing (timed out) | **yes** | it never arrived |
| no endpoint configured | **yes** | it never arrived |
| 500 / 503 | **yes** | it arrived and the server broke |
| 404, not deployed | **yes** | it will be |
| 400 — "recorded on the day it was run" | no | it read the call and refused |
| 401 / 403 | no | the same payload gets the same answer |
| 409 | no | the same payload gets the same answer |

A refusal is **dropped and counted**, and `boot()` returns the count, so the
player is told once — *"1 reward could not be recorded — too long offline"* —
rather than being strung along by a badge that never clears. A reward silently
not arriving is worse than a line of small print.

One thing that had to keep working, and does: the server answering **`already:
true`** is a success, not a failure. That is the lost-answer case — the server
wrote the row and the reply went missing — and the replay has to drain the
queue rather than jam on it.

Held down by `tools/games/franchise.test.js` §28 (the whole offline week, every
failure shape, and the jam itself) and `tools/games/sql/games_franchise.test.sql`
§31 (the arithmetic, the uniqueness constraint, and the replay).

And by **report row 37**, so a bad deploy says so out loud: the rank report is
still `stable`, no column holds a rank, and `franchise_activity` still carries
its uniqueness constraint. Drop that constraint and a lost answer pays twice —
a rank bought by a bad connection.

## Not built yet, on purpose

Nothing on the roadmap. What is deliberately absent: a fairness check on
trades (that is the point of them), an in-game injury that changes the
game it happened in (the simulator plays the game; the injury is recorded
after), and a bracket for the solo season (the conference is where a
bracket belongs). The ledger accepts a negative delta for spending (the
facilities, the reports and the signings use it), and
`franchise_activity` is the record every future reward derives from. The
simulator, the offseason, the market, the conference, injuries, the bowl,
trades and the staff are each versioned (`sim_v4`, `offseason_v2`,
`market_v1`, `conference_v1`, `injury_v1`, `bowl_v1`, `trade_v1`,
`staff_v2`, `scouting_v1`, `development_v1`, `league_v1`, `rank_v1`, `packs_v1`,
`career_v1`, `snap_v1`, `moment_v1`, `clock_v1`, `defense_v1`, `playbook_v1`, `rookie_v2`) so a retuned one is a new version and old boxes, old reports,
old classes, old tables, old deals and old coaches stay true to the rules
they were played under.

---

# EdgeDesk Football — the rebuild

The brief: turn the experimental arcade game, the Tecmo-style prototype and
the franchise systems into one cohesive football product — original players,
an exceptional collectible ecosystem, a living marketplace, broadcast-level
presentation, season history and research education — **without** starting
over and destroying what works. So the first thing done was an audit, and the
audit's verdict is the shape of everything after it.

## Phase 1 — what the audit found, and what was fixed

Three audits, one per layer. The verdicts:

| layer | verdict |
| --- | --- |
| the engine (`engine.js`, `live.js`, `paint.js`, `stage.js`) | **keep**. Deterministic, invariant-tested, a real 2.5D renderer and a live twenty-two-man simulation. Refactor around it; do not replace it. |
| the server (`games_franchise.sql`) | **keep**. The ledger, the identity model, RLS and the seeded generator are exactly what a card economy needs. The one structural gap: a `game_players` row is at once the player, the card and the roster slot, and there is no marketplace, no awards and no card editions. |
| the shell (`games.js`, the pages) | **keep** the shared renderer; the packs page was a list, not an opening, and the play page was an orphan (no analytics, absent from the 404 map). |

Concrete bugs found and fixed in this phase — each one asserted by a test now:

* **Overtime ran longer than the quarter.** `startOT` set a ten-minute clock on a
  five-minute game, which the invariants rightly refused; nine games in two
  hundred at Blitz length broke. An overtime period is now never longer than
  the quarter it follows.
* **Play Mode's progression was coverage-blind.** `live.js` handed `F.reads`
  the coverage's *name*, so every separation came back zero and the badges
  read the routes in the order they were typed. It passes the coverage now,
  and `flow.test.js` refuses the string.
* **Resuming a live game lost every player's name.** `session.resume` stepped
  the engine with raw ids; the men are looked up again on the way back in.
* **`prepare()` dropped `shortAcc`**, so weather never touched a short throw.
* **Every new game leaked a Stage** — a `ResizeObserver` and a resize
  listener per game, and two tap handlers on one canvas. `Stage.destroy()`.
* **Coach Mode's picture and its books were different games**: the resolver
  drew a second result under the play you watched. One game, one truth: the
  play you watch is the play that is booked, in every mode.
* **The camera framed half a field that was never hidden** on wide screens,
  where the call sheet is a column rather than a sheet.
* **The field-goal button ignored the weather** the kick would be taken in.
* **A phone that locked mid-play dropped the down**; the loop restarts on
  `visibilitychange` and the watchdog waits for it.
* **An interception was re-spotted by dice** when the live play had measured
  the spot exactly.
* The tab bar and the header disagreed by one pixel at 480px; the Drill,
  Pick 5, Head-to-Head and Groups had no tab bar to come back on; the shared
  libraries carried a version token the bumper could not see; the play page
  had no analytics; `/games/play/anything` bounced to the games home; dead
  markup on the home and the War Room promised things nothing rendered.

## Phase 2 — the game you hold

**One named state for the page.** `games/lib/gridiron/flow.js` — LOADING,
PRE_GAME, KICKOFF, PLAY_SELECT, PRE_SNAP, LIVE_PLAY, PLAY_ENDING, RESULT,
TRANSITION, PAT, QUARTER_END, HALFTIME, GAME_OVER — with the legal moves
written down. The call sheet asks `FLOW.can('call')`, the snap button asks
`FLOW.can('snap')`; an unlisted move is reported and then taken, because a
game that refuses to continue is a worse bug than one that continued from the
wrong place. The engine's game object stays the only authority on the
football. `window.__edFlow` is the debug read.

**Arcade length, by default.** Four two-minute quarters that still hold a
game's worth of snaps: the engine's `cfg.deadScale` charges a fraction of the
dead ball (0.30 at Arcade; 1 everywhere else), so the clock reads 2:00 and the
game has about fifty snaps in it. Every band in the harness is a rate, so the
sport is unchanged — the quick harness runs green at every length. Blitz
(5:00), Quick (8:00) and Full (15:00) stay in the settings.

**The thumbs.** A ball carrier holds **Sprint** and taps **Juke**, **Spin** or
**Stiff arm**; a defender holds Sprint and taps **Tackle**, **Dive** or
**Switch**. None of them teleports: a juke is a bounded lateral cut, a spin
keeps him going forward and slower for a beat, a stiff arm is his strength
against the nearest man's tackling, a dive reaches further and costs a beat on
the ground if it misses, and switch *cycles* through the defenders nearest the
ball rather than bouncing between two. Every move raises `a.spam`, which drains
over three seconds and is read by the tackle roll, so the fourth juke in two
seconds is worth a quarter of the first. Sprint drains wind (`a.gas`) at a rate
set by stamina and refills it when released.

**The keyboard, second.** Arrows or WASD steer, Space snaps then sprints, J K L
are the three taps, 1–5 throw to a badge in progression order, Tab switches,
Escape closes the sheet. Bound once, for the life of the page.

**Takeaways.** A pick is returned: the interceptor runs, the offence chases,
and on defence the thumb goes straight to him. A return into the end zone is
the defence's touchdown — six points, a try, and a touchdown that is nobody's
rushing or receiving score (`stats.defTD`, player `dtd`). Fumbles exist in
Play Mode now: once per tackle, about one carry in ninety, and a fumble the
defence falls on is booked as the play it was — a run, a catch, a scramble or
a sack — and then turned over where it lay, so the yard columns still add up.

**Route running acts on the field.** A receiver's own `rte` buys him cushion
against man coverage; it used to enter only as a unit average.

**Rotate to play.** A phone held upright is asked once, over the field, and
may say no for the session.

**Tests.** `tools/games/flow.test.js`: the flow machine's edges; a hundred
consecutive live snaps and a hundred lined-up-and-abandoned previews; every
event a game has at arcade length with the invariants holding; returned picks,
defensive touchdowns with a try pending, fumbles with the columns agreeing;
overtime inside the quarter; a resumed game keeping its names; the progression
reading the coverage; every button every tick, deterministically.

## Phase 7 — the player universe (`profile_v1`)

Every athlete stores four ratings for his position, the simulator plays with
them and the overall is their mean; nothing about that changes. What a card
can *say* does. **The profile** — `games/lib/gridiron/profile.js` on the
client, `franchise_profile()` on the server — derives the universal six
(**SPD ACC AGI STR AWR STA**) and the position's own words (a quarterback's
THP SAC MAC DAC TUP SCR, a back's BTK CAR VIS CTH, a receiver's CTH RTE REL
CIT, a lineman's PBK RBK, a rusher's PRSH BSH PUR, a linebacker's TCK PUR MCV
ZCV BSH, a corner's MCV ZCV TCK PRS) as a **pure function of what is stored**:
position, the four ratings, the archetype, and four small integers the card
already carries (jersey, age, stamina, the letters of the last name). No
column, no migration, no ageing code: when the four grow in the offseason the
profile grows with them, and it can never disagree with the card it is printed
on. Both languages use integer arithmetic so they agree to the digit, and
`tools/games/profile.test.js` proves it on four hundred random cards against a
real PostgreSQL, plus pins the constant tables (skews, towns, tier thresholds)
byte for byte.

Also derived, and carried by every read model (`franchise_roster`, the
market's `franchise_prospect_json`, the trade floor's player):

* **the collector's tier** — Prospect · Starter · Impact · Prime · Elite ·
  Apex · Legend · Mythic, off the overall (62 · 69 · 75 · 81 · 87 · 93 · 98);
  the rarity a card already carries (common..elite) is the generator's, this
  is the collector's;
* **how far he can go, in words** — Limited · Normal · Rising · Breakout ·
  Elite · Generational, from the gap to his ceiling and his development tier;
* **a body and a home town**, from the same four integers; the towns are real
  American places and none of them is a team, a brand or a person.

An unscouted prospect has a body and a home town and **no** profile — the
profile is the ratings by another name, and those are what a report buys.

The generator deals the brief's archetypes now — Improviser, Game Manager,
Workhorse, Route Technician, Possession Receiver, Slot Weapon, Physical
Target, Speed Rusher, Power Rusher, Balanced, Shutdown, Press Specialist, Zone
Specialist — appended to the pools (every skew sums near zero, so a founding
roster lands where it always has), and each archetype adds a small, named
push to the profile on top. The name pools grew from 110/150 to about
280/360; the client's fictional opponents draw from a wider well too.

The card shows the tier beside the position, the universal six in one quiet
row under the four, and the build and home town in the meta line. The live
engine reads strength and stamina from the profile (the stiff arm and the
sprint); speed, acceleration and agility keep the sources the harness is
banded on.

## Phase 8–9 — the card, and the Vault (`packs_v2`)

**Every man is a card, and every card is one of one.** There is no second
print of anybody: `franchise_card(p_player)` returns the man whole — profile,
history, career, the pack he came from — and an `edition` that says
`serial 1 of 1`. A trigger on `game_players` (`franchise_card_history`)
writes his line for him, whoever changes the row: *generated* (how he came
to exist, at what overall, ceiling and age), *acquired* (kept from a pack,
drafted, signed), *traded*, *ratings* (before → after, the season and his
age), *potential*, *retired*, *released*. Capped at eighty lines, keeping
the first and the last seventy-nine, so the day he arrived is never lost.
The packs page shows the card as a sheet; tap a man kept from a pack.

**A pack is a thing your record owes you**, not a thing you are sold. The
rank's cache (`packs_v1`) already worked that way — one pack for every rank
reached, drawn around your own team — and every promise it made still holds
(`franchise_pack_open` is redefined, not replaced, and the SQL suite still
attacks it as before). The Vault generalises it. `franchise_pack_defs()` is
the table of kinds and `franchise_packs_sync(franchise)` derives, from the
record alone, which sealed packs a franchise holds:

| kind | for | men · keep | band |
| --- | --- | --- | --- |
| Gridiron Cache | every rank reached | 3 · 1 | floor 10 under your overall, ceiling rises with the rank |
| Rookie Cache | founding the franchise | 3 · 1 | floor 8 under, flat edge +4, at the positions you are thin |
| Postseason Pack | a season seen out (the two most recent) | 3 · 1 | floor 6 under, rank edge +4, where you are thin |
| Championship Vault | a bowl won | 4 · 2 | floor 2 under, rank edge +8, **one Prime man guaranteed** |
| Scout's Find | three Price Its scoring 80+ in one week | 2 · 1 | floor 4 under, rank edge +2, the ceiling lifted 6 |

Derived, never accumulated: nothing wraps `franchise_create` or
`franchise_play_game`; the sync reads seasons, bowls and verified Price It
scores and inserts what is missing, idempotent on (franchise, kind, source
key). A pack you have not earned cannot exist, and no code path hands one
out.

**The odds are printed before you open.** The roll is uniform over the whole
numbers of the band and the server rolls it, so `franchise_pack_odds` is
arithmetic anyone can check: the share of the band inside each collector's
tier. The board (`franchise_packs_board`) prints them on every sealed pack,
and the packs page prints them as chips. A guaranteed man is stated
separately; the odds are the odds for the others. **Bad-luck protection is
printed too**, not hidden: after five Gridiron Caches without a Prime man
the next one lifts its ceiling by six and guarantees one; the counter
(`franchises.packs_since_prime`) is on the board as dots, and the rule is
stated in words beside them.

**The server writes before the room shows.** `franchise_pack_open_id(pack)`
rolls the men, writes them to `game_players` with status `pack` and the
pack's id, records the band they were rolled from on the pack row, and only
then answers. The page calls that first — the button says *Sealing the
result…* — and only a persisted result gets a reveal. A refresh mid-reveal
finds the same men face down on the table (*Back to the table*); the reveal
is theatre over a result that is already true. Nothing in
`games/lib/vault.js` calls the server or rolls anything; the test pins that
it never writes an overall or a tier.

**The Vault itself** (`games/lib/vault.js`, `games/vault.css`) is a room,
not a button: the screen goes to a dark scouting tunnel, EdgeDesk data lines
drift behind a sealed case dressed in the pack's own colour, a scan line
crosses it, the lid swings, and the men come out as silhouettes you turn
over one at a time. A Prime or Elite man gets a short build (position,
signature rating, overall, card). An Apex, Legend or Mythic man does not
simply appear: the room goes to black, a low synthesised rumble starts, and
he is revealed a fact at a time — the mark, position, archetype, the one
rating that defines him, his home town, the overall, the outline, the name,
then the card, with confetti for a Legend or better. Every clue is his own
fact in a slow order; there is no fake-out and no bait. The plan of a reveal
is a pure function (`EDVault.plan(man)`), bounded under nine seconds, and
`tools/games/vault.test.js` holds it down without a DOM. Sound is
synthesised, haptics are a vibrate pattern, both switch off, and the whole
room goes still under `prefers-reduced-motion`.

**Proof.** Section 33 of `tools/games/sql/games_franchise.test.sql` opens
the founding cache by id as the device, checks the men are on the table with
the pack's id before the answer is read, refuses a second opening, keeps one
and watches the card remember it, drives the history trigger through ratings,
potential and ninety edits to see the cap hold, and then generates **a
thousand packs** straight from the server's generator across every kind:
every one the right size, every man whole and inside his printed band, no
two men the same man, every guaranteed Prime delivered, protection firing
exactly when it says and delivering every time, and the observed tiers from
the rank's cache within eight points of the odds it printed. The client's
pack table (`EDFranchise.PACKS`) is pinned name-for-name to
`franchise_pack_defs()`.

Nothing here can be bought. There is no pack for sale and no way to open one
faster with money; the page says so in three places, and the SQL has no
currency path that grants a pack.

## Phase 10–12 — the lineup, chemistry and the Exchange (`lineup_v1` · `chemistry_v1` · `exchange_v1`)

**Chemistry is a property of the eleven who play**, not a number a man
carries. The column on `game_players` had sat at fifty since the day it was
made and nothing read it; it still does, and it still does nothing. Instead
`franchise_chemistry(franchise)` derives, from the starting lineup and
nothing else: how each starter's archetype fits the scheme the franchise runs
(`franchise_scheme_fit()`, −2..+2 per man, a table anyone can read — and a
test that every archetype it names is one the generator deals, because a
typo there would be a silent zero), how many starters have played eight games
for this franchise (*settled*), whether whole units have grown up together
(the line, the passing game, the secondary), how many arrivals by market,
trade, free agency, pack or draft are still learning the calls, and who among
them leads. The score is `50 + 2 × raw`, held to 0..100, every term printed;
the effect is `(score − 50) / 50 × 8` in the units a trait uses, and it
reaches the simulation through `franchise_trait_effects` — a quarter of a
point of rating per point, as every trait — so `franchise_sim` and
`franchise_sim_versus` feel it without a line of either changing. A founding
roster lands around 65; eight games with the same eleven and it climbs toward
the nineties; sell a starter and it drops. The roster page prints both units
as bars with the word, the effect and the reasons, and **Best lineup**
(`franchise_lineup_best`) orders every position by overall among the fit in
one call; a backup can be started at any slot, not only the last.

**The Exchange is the first market between franchises.** The market page was
and remains a private one — a draft class and free agents generated for you.
The Exchange is public: any franchise lists an active man of its own at a
price of its choosing inside published bounds (50–50,000 Credits, five open
at once, seven days), and he **keeps playing for the seller until he sells**.
A buyer sends a **listing id and nothing else** — never a price, never a
balance. `franchise_exchange_buy` locks the listing, then both franchises in
id order, and only then decides: the listing still open and unexpired, the
man still on the roster that listed him, the seller keeping the floor and the
starters his position needs (`franchise_exchange_illegal`, the same rules a
release and a trade obey), the buyer with room and with the Credits the
ledger says he has. Five per cent of the price, rounded up, is the fee and
leaves the economy; the rest reaches the seller as one ledger row keyed by
the listing, and the buyer's price is one ledger row keyed the same way, so
nothing can pay twice. The man moves as a trade moves him — bottom of the
new chart, a new number only on a clash, his career untouched — and his card
remembers the sale with its price. A listing that lapses, or whose man has
since left, is closed by the next reader with the reason kept on it.

**Prices are decisions made with the record in view.** `franchise_listing_json`
prints the free-agent reference beside every asking price, and
`franchise_exchange_comps(position, overall)` is public arithmetic on the
sold listings of the last sixty days within two points: count, median, low,
high, the last twelve, and how many like him are listed now. The sell form
reads them before a price is typed. The record (`franchise_exchange_history`)
shows a franchise's own listings from both sides and the whole Exchange's
recent sales and volume.

**Proof.** Section 34 of the SQL suite drives it end to end: the chemistry
arithmetic and every fit, the trait-effects hookup, eight games together,
a new arrival named, the best lineup and a contiguous chart; listing
refusals by price, by ownership, twice; browsing as buyer, seller and nobody;
a sale with the price, fee, net, both ledger rows, the fee gone from the
economy, the card's line, both charts, both records and both achievements;
a second buy refused; comps and history; the clock and a man who left; the
floor by name. `tools/games/exchange_concurrency.test.js` then does what one
session cannot: six buyers on one listing from six connections at once
(exactly one wins, five are refused by a closed listing, never by a deadlock,
every balance the sum of its ledger, the economy down by exactly the fee),
and one buyer with the Credits for one man reaching for two (exactly one
goes through, the balance never below zero).

Credits are what the ledger calls `tc` and the game calls Credits; XP is
Research XP. Nothing on the Exchange can be bought with money: there is no
Credit for sale, and the SQL has no path that grants one.

## The run defence reads before the handoff

Merging the two experience layers turned the simulation suite's one live
band red: yards per carry in the AI-against-AI league went from 5.1 to 6.4
against a ceiling of 5.6. Measured properly — 120-game samples, one change
at a time, on copies of the engine — the cause was not the size of any knob.
The old run defence had rested on a behaviour that was never football:
every coverage defender broke for the "carrier" the moment the snap put the
ball in the quarterback's hands, so a run play had eleven men crashing the
mesh point from the first frame. Part A's rule that the secondary does not
tackle the handoff was right, and it removed the crutch; the run concepts
then found the room they were drawn to find — the pulling guard alone was
worth six tenths of a yard a carry to the league.

The counterweights are the ones real defences use. On a called run the
safeties and coverage linebackers read the action before the ball is handed
off (three tenths of a second, scaled by the tier) and fill; the corners
stay on their men until the run declares — the ball across the line, or a
beat after the handoff; a quarterback who keeps it is a runner once he
reaches the line. And the linebackers in the box read the guard: when one
pulls, the backers flow with the pull before the handoff and hold their
depth until the ball is out. Only a pull is a key. Leaning the backers
toward the back on every run fixed the league and strangled the person
holding the stick on an inside zone into a stacked box — the harness caught
it, and that version is not in the game. The concepts themselves were
trimmed, not removed: outside zone still reaches, power and counter still
pull, the draw still sets and lets the rush go by, the counter still takes
its false step, and the counter and draw still mesh later than a dive.
Nothing about a man's speed changed.

The league sits at about 5.3 yards a carry over 120 games (the suite's own
20-game sample reads 5.14), points and yards per play inside their bands,
and every pin in the live harness is untouched: the stick still changes the
run, power still pays, the tiers still differ in the head. The 800-game check
is green again.

## The living season (`season_v1`)

A season used to be a record and a schedule. It is three more things now, and
every one of them is derived from what has actually happened.

**EdgeDesk Power Rankings.** Not a sort by record. Every club in the league is
rated from roster strength and then moved by evidence: win percentage, average
margin capped at 21 so a blowout cannot run away with it, strength of schedule,
the last three results, wins over clubs rated above you, losses to clubs well
below, and a little for winning on the road. The weights are published in
`franchise_season_rules()` so any number on the page can be checked against the
arithmetic that produced it, and every row carries the reasons it is where it
is. Your franchise is rated on its results; the other clubs are rated on their
rosters and on whatever they have shown against you, because that is all the
record actually knows about them — nothing simulates a game nobody played.

A snapshot is written every week into `franchise_rank_weeks`, so movement is
this week's rank against the last week that was written down. Risers, fallers,
the biggest jump, the biggest drop and anyone new in the top ten are all read
off those two snapshots.

**Award races.** Ten of them, updated weekly into `franchise_award_weeks`, each
with the five men actually having the seasons. `franchise_award_score()` is
position-specific and per game: a back is measured against what a back does, a
corner against what a corner does, and every term is a rate so volume cannot
win a race on its own. Two multipliers move a score — what the team did and who
it played — and neither moves it by more than a fifth. **No overall is
consulted anywhere in it.** Clutch is not a feeling: it is the same score
computed over the one-score games only, added up out of those games' own box
scores.

The candidates are the men whose games the record keeps, which is your roster —
opponents are clubs rather than persistent rosters, so there are no opposing
candidates to invent, and none are invented.

**The title game.** A winning season still earns its bowl. Losing at most once
in a full season earns something else: `franchise_games.championship`, an
opponent that is the strongest club you never played rather than a draw, and a
game the pages treat like nothing else — a pregame with both records, the path,
the men who got you there, the award finalists and the lineup introduced; a
postgame with the whistle, the trophy, confetti, the season summary, the
Championship Vault and a line in the record book. The Most Valuable Player is
read out of that game's own box score on the same impact scale the simulator
uses to name a player of the game. The best card in the game does not win it;
the man who played best does.

**Nobody writes a snapshot but the server.** A deferred constraint trigger on
`franchise_games` fires at the end of the transaction that finished a game —
after the season lines that same transaction is still writing — so whichever
path played it, the week gets its rankings and its award race exactly once. The
client has three functions and all three are reads.

## The card is not the man (`cards_v1`)

One table used to carry five ideas at once. `game_players` held **who a man
is** (his name, his body, where he is from), **what his card says** (the
edition, the rarity, the printed ratings), **who owns him** (a `franchise_id`
column), **where he plays** (a `depth` number) and, by way of a listing
pointing straight at him, **whether he is for sale**. The Exchange traded
that row: a sale was an `UPDATE` of one column on the same record that also
held his career. There was no way to hold two editions of one man, no way to
say whose hands a card had been through, and no way to price a card apart
from the man.

These are separate things now:

| table | what it is |
| --- | --- |
| `game_player_identities` | the persistent fictional athlete |
| `game_card_defs` | a printed edition of that athlete |
| `game_cards` | one instance of that edition, with its serial |
| `game_card_ownership` | who holds that instance, right now |
| `game_card_provenance` | every hand it has passed through |
| `game_lineup_slots` | where an owned card is playing |
| `franchise_listings` | a temporary offer of an owned card |
| `game_market_txns` | a completed transfer, with money |
| `game_market_prices` | what editions like it have sold for |

`game_players` keeps what is genuinely its own: **the career sheet** — the
stats, the development, the injuries and the ratings as they have moved
since the card was printed. Its `franchise_id` and `depth` columns survive
only as a **read projection** for code that has not been rewritten, and the
database refuses to let anything write them behind the new tables' back:
ownership moves through `franchise_card_transfer()` or it does not move, and
a trigger raises if a statement tries. The schema report and the acceptance
suite both hold the projection to the ownership record.

**The migration** (`franchise_cards_migrate()`) is idempotent and additive.
Every existing row is minted an identity, an edition, an instance and an
ownership record; the lineup is rebuilt from the chart as it stands; every
listing is pointed at the instance; every sale already on the books becomes a
transaction and a price. Nothing is deleted, no roster moves, no ledger
changes, no result changes. Running it twice mints nothing.

**Buying is atomic and idempotent.** A purchase carries an operation key the
device keeps until the server answers. The listing row is locked, the seller's
ownership is verified against `game_card_ownership` rather than a column, the
money moves once, ownership moves through the one door, and the sale is
written as a transaction and a price. A unique index on the listing is what
makes a second buyer impossible rather than unlikely: two buyers racing
produce one winner and one clean refusal. A client whose connection dropped
asks `franchise_market_op()` with its key and is told **completed** or **not
completed**, never maybe.

**The adapter** `franchise_card_entity()` hands gameplay one flat object —
identity, edition, ownership, lineup slot and career — assembled from the
separate tables rather than read off one conflated row.

## The programs, and what a passed man is worth (`packs_v4`)

Three more pack programs, each derived from the live games filed at Pro or
harder and each dressing its own room: the **Speed Lab** (backs, receivers
and the men who cover them; one for every 1,500 live yards in your hands),
the **Trench Unit** (both lines; one for every three games holding a side to
ten points or fewer) and the **Primetime Vault** (four men, one of them
Prime or better, keep one; one for every five live wins). `franchise_pack_defs()`
carries them; `franchise_packs_sync()` materialises them from the record,
idempotently, like every other kind; `franchise_pack_positions()` draws the
Speed Lab and the Trench Unit from their own pools.

A man passed over in a pack is never silently gone: he is scouted, and the
department books scouting points by his tier (`franchise_pack_defs()->'pass_sp'`,
mirrored as `EDFranchise.PASS_SP`), one ledger row per pack so a replay pays
nothing twice. The room prints the value on the Pass button before you press
it. Under every turned card: the lineup line, a **Duplicate** flag when the
roster already holds the same archetype at his number or better, the scheme's
word on him (`EDFranchise.fitFor`, a mirror of `franchise_scheme_fit()`), and
three doors — Compare (against the starter he would play over, on the ratings
where they differ most), View card, Market.

## The game you hold counts — cards move the grass, the grass feeds the Vault (`economy_v2` · `packs_v3`)

The third part of the brief: connect the two. A card has to change what
happens on the field, and what happens on the field has to feed the Vault —
or the two best things in the building are two separate buildings.

**The card is the man.** Every man on the grass is read from his card by one
function a side (`offMan`, `defMan` in `engine.js` `prepare()`): speed,
acceleration, agility, hands, route, power, blocking, arm, accuracy, coverage,
tackling, rush, ball skills, strength, stamina — and the game's own tests now
hold it at the outcome level, forty seeds a side with only one position
group's card changed: a 96-accuracy quarterback completes the same slant more
often than a 42; receivers who run routes and run away make more of the same
dagger; a back with power and feet gains more on the same inside zone; a line
that can block keeps the pocket up longer; better cover men take completions
away on the same slant, in zone and in man (`tools/games/live.test.js`
section 15). Measuring it found a gap and closed it: zone coverage read
nothing from the card — a 42 corner and a 96 corner squeezed the same route
the same way — so now a great zone corner sees the route a step sooner,
matches it tighter and gives up less cushion, and the distance a defender
will break on a ball from carries a little of how well he was covering.

**A finished game is filed with the franchise** (`franchise_record_live_game`,
Phase 21) under the game's own key — its seed and the moment it started, kept
in the save so a resumed game files as itself — with the score, the yards,
the touchdowns, the tier the defence was set to, and every man of yours with
his line in the keys his career already uses (`EDFranchise.liveLine`). The
server checks the shape (a score of 150 is not a score; nine touchdowns do
not fit in seven points; a key of one letter is not a key), credits once by
the economy's own table — a game 60 XP and 25 Credits, a win 40 XP, 25
Credits and a Coach Point, the performance itself up to 30 Credits and 40 XP
for touchdowns and every hundred yards — scaled by the tier (Rookie six
tenths, Pro one, All-Pro 1.15, Legend 1.3), **capped at five credited games a
day** so a grind pays nothing while the record and the careers still take the
sixth, and weighs it **two toward the rank**, so the Gridiron Cache is closer
for having played. The final screen shows the server's answer, never the
page's hope: the chips, the rank line, the pack line, how many men added to
their careers, and this week's preparation.

**Careers in your hands.** The men's lines land in `live_stats`, a column of
their own, kept apart from the simulation's `career_stats` so neither can
inflate the other; only the keys a career knows, bounded, for men who are
yours — a stranger's id takes nothing. The roster and the card carry it.

**The Game Day pack.** Every fifth live game finished at Pro or harder seals
one (`gameday_pack`, three men keep one, drawn where the team is thinnest, a
little above the rank). Derived by `franchise_packs_sync` from the credited
games, like every other pack: earned by playing and by nothing else.

**The broadcast knows your men.** A man who came out of the Vault is
announced as one when he is having the day; and when tonight's line takes a
man across a round number of his career — the simulation's and the one in
your hands together — the broadcast calls the milestone, once.

**New weapon.** Game Day names the man most recently kept from a pack until
he has played a game in your hands: who he is, where he starts, the matchup
he lines up against ("their defense rates 64 — he lines up against it"), and
the one thing to do about it: *Play the next game*. After that, quietly, what
he has done for you.

**The whole loop, with nobody's hands on it** (`tools/games/loop.test.js`,
against a real PostgreSQL through the phone's own doors): a franchise is
founded → its first pack is sealed → the server rolls it → the best man is
kept → the server sets the lineup → a whole game is played live with the
franchise's own men, scripted thumbs on runs and throws, the AI on defence,
to the final whistle → filed and paid exactly what the client estimated →
two toward the rank → the quarterback's line on his card → filed again,
nothing twice → four more games → the fifth seals a Game Day pack → the home
counts the games and names the weapon → the pack opens, a man is kept, the
lineup is set → the team is no worse for it → a sixth game is capped → My
pulls remembers both → every balance is the sum of its ledger.

## The Vault as a product — the case in the hand, the night at the top of the ladder, the pull record (`pulls_v1`)

The second sentence of the brief: *that was sick*. Phase 8–9 built the room
and the rule (the server rolls and writes before anything is shown; the odds
are printed on the pack; nothing is for sale). This pass makes the room a
product. Nothing about the rule changed, and the tests that pin it still pass
untouched.

**The case has weight.** A finger on the sealed case tilts it toward the
touch and the light moves across the lid (`--tx`, `--ty`, `--lx`, set by
`vault.js`, read by `vault.css`); a tap on it taps back. While the seal is
being scanned a tap on the case skips to the men, so a veteran is never made
to sit through the theatre twice.

**The back of a card hints and never tells.** A plain man's back is plain; a
Prime or Elite man's has a firmer edge; an Apex man's breathes; a Legend or
Mythic man's carries a beam across it and the room's data lines brighten
while it is face down (`.vt-sig`). The back carries the position and nothing
else — the test holds that the markup never puts a tier or a name on it.

**The Apex reveal counts up.** The mark, the clues, and now the overall is
counted up from below and lands (`from` on the `ovr` step, always under the
number, never above it), with a tick in the hand when it lands.

**The top of the ladder is a different night, not a bigger Apex.** A Legend
or Mythic man goes: the room to black and the sound *cut* (not louder —
silent) · one light finds the floor · the EdgeDesk mark glitches and
**SIGNAL DETECTED** is called · the tier's own symbol (a gold diamond in a
ring; a three-colour ring around a void) before a single fact about him ·
the lens goes down the tunnel to a silhouette far away · position, build,
archetype, the one number that defines him, how far he can go · the overall
counted up · the name · the stadium lights come on. `EDVault.plan()` returns
`top: true` for these and the steps carry `blackout`, `signal`, `symbol`,
`tunnel` and `lights` kinds the Apex plan never uses; the test holds that the
two sequences do not even open the same way. Each tier has its own haptic
rhythm (`HAPTIC_BY_TIER`) and its own sounds (a data sweep, a bass hit, a
stadium rise, the signal's three notes, the lights), all synthesised.

**After the reveal, what he is to you.** Under every turned card: what he
does to the lineup, computed from the roster the page hands in and never
fetched (`EDVault.lineupImpact` — "+4 OVR at WR2, over Vance (79)" or "WR4
on the chart"), and after a beat the estimated market range off the
Exchange's comparable sales (`EDVault.marketEstimate` — the sales when there
are three or more, a band around the free-agent reference when there are
not, nothing at all when there is nothing to go on: never an invented
number). Both arrive after the card, never in front of it.

**The summary.** When every card is over: the pull as a list — each man with
NEW · LINEUP UPGRADE · HIGH VALUE · COLLECTION · KEPT / PASSED — and the
actions: *Put him in the lineup* (the server's `franchise_lineup_best`, the
room only asks), *Open the next pack* (reloads the board and opens the first
one that can be), *Roster*, *Exchange*, and *Share* on a premium man: the
card drawn on a canvas (`EDVault.cardImage` — the man, his tier, his number,
his signature, the EdgeDesk Football mark, **nothing of the user**), through
the Web Share sheet where there is one and a sheet of our own with the image
to save and the line to copy where there is not.

**Reveal all.** A veteran's way out. Every card turns at once; a premium man
still gets a beat — the mark and his name on the stage for a second — so
skipping the theatre never means not knowing what you pulled.

**A pack earned gets its moment.** The shelf compares the sealed packs to
what this device was last shown and gives a new one a card of its own: PACK
EARNED · what it is · what earned it · *it waits in the Vault until you open
it — nothing opens on its own*. Nothing opens automatically, ever.

**The first pack is guided.** One line under the case, then one line over the
cards; no tour. The device remembers it has opened one.

**A lower-end phone gets the whole sequence and none of the sparkle.** With
four cores or four gigabytes or fewer the room drops the shimmer, halves the
data lines and the confetti (`.vault-lite`); the reveal is never shortened
and the card is never smaller — the sequence is the product, the sparks are
the dressing.

**My pulls (`pulls_v1`, Phase 20 of the SQL).** `franchise_pulls(secret)`
reads every pack this franchise ever opened from the pack rows and the men
who came out of them — **as they were the night they were pulled** (the
first line of every card's history is the overall he was generated at, so a
man developed since still shows the pull as it was), which were kept, the
best pull of all, the counts by tier, how many were Apex or better, and the
last thirty packs newest first with their bands. Nothing is stored for it;
it is a read, like the rank, and the report row checks it stays one. The
page prints it under *Kept from packs*: opened · kept · Apex+ · best, the
best pull as a card you can tap, and the list.

**Tests.** `tools/games/vault.test.js` (1,246): the top-tier plan opens with
the blackout, calls the signal second, shows its own symbol third, goes down
the tunnel, reads the overall before the name and the lights before the card,
counts up from below, never borrows the Apex mark, carries the ceiling and
the build; a Mythic and a Legend share the shape but not the symbol; the
longest night is under twelve seconds and longer than an Apex; the lineup
line and the estimate are pinned case by case; every tier has a haptic
pattern and the top two have their own; the stylesheet dresses every state
the markup emits; the card back never carries a tier or a name.
`tools/games/pack_odds.test.js` (41): the server's roll, guarantee, bounds,
odds arithmetic and protection rule are pinned to the SQL's own text, then
mirrored and run **100,000 times** — every man a whole number inside his
band, every whole number drawn about as often as every other, the tiers
within half a point of the printed odds; 25,000 Championship Vaults every one
holding a Prime man with the odds "for the others" holding for the others;
100,000 caches on the protection counter with no run past the printed count
and every protected pack rolling on its lifted ceiling; every band the game
can print adding up to a hundred. The SQL suite's section 35 holds the pull
record against a franchise that opened a thousand packs.

## The game you hold, felt — throw kinds, the run concepts, the replay

The brief for this pass was two sentences: *this actually feels good* when
you play, and *that was sick* when you open a pack. This section is the first
one. Everything here was measured before it was changed, on the deterministic
harness (`tools/games/live.test.js`), and the measurements are in the tests.

**Three footballs.** A tap on a receiver's badge is a throw. A tap *held*
past a fifth of a second is a bullet: it leaves harder and lower, arrives
sooner, gives the man in coverage less of a look, and past twenty yards is the
harder ball to place. A touch pass (the engine's third kind, reachable from a
script today) floats and hangs. The badge grows a gold ring while it is held,
so the wind-up is something you can see, and the throw goes on the release.
`EDGridironLive.THROWS` is the table; the tests hold that a bullet is faster
on every seed, a touch slower on every seed, the bullet worse past twenty and
tighter underneath, and that the kind is booked on the play.

**His feet, and which way he is going.** The quarterback is yours from the
snap: the stick rolls him, and a roll across the line with the ball becomes a
scramble, booked as one. A quarterback who has set his feet throws the best
ball of the three; one rolling *away* from the side he throws to is throwing
across his body, and the engine marks it (`lastThrow().across`) and charges
for it. Before this the stick did nothing for the first three seconds of
every pass play, because the user's man was nobody until a handoff or a
catch.

**The run concepts are different blocks.** Every lineman used to take the
nearest rusher whatever was called, so inside zone, outside zone and power
were one play with three names — the probe printed identical yards for all
three. Now outside zone reaches for the play-side shoulder and runs the front
sideways, power pulls the backside guard round and through the hole, counter
shows one way for a beat and pulls the other, and a draw pass-sets for half a
second while the backers drop. The thumb still picks the crease; the concept
decides where the creases are.

**The secondary does not tackle the handoff.** The single biggest number in
the audit: against a base front the first tackler on seven carries in ten
was a *cornerback*, at two yards. Every coverage defender broke for the ball
the frame it reached the back's belly, from wherever he stood. A defender in
coverage now plays his man or his zone until the run declares — the ball
across the line, or a beat of reading it: a safety's beat is short, a
corner's long, a sharper defence's shorter. Inside zone against a base front
went from 2.2 yards a carry with linebackers never in the picture to 4.0 with
the linebackers making the tackle at four, four carries in ten reaching four
yards and one in twenty reaching ten. A draw can lose yards now, which a draw
should.

**The tier touches the head, never the legs.** Difficulty used to change the
opposing coach only. It now also sharpens his defence's *reading*: how late
it comes off the ball, how far ahead it aims in pursuit, the beat before a
zone defender turns and runs with the deepest man or breaks on a throw, the
cushion a man defender concedes. Nobody gets faster. Your own defence is
untouched by it. The same runs go three yards a carry against a rookie
defence and one against a legend one.

**One hit, felt once.** The tackle already resolves once per approach; it now
reports how hard it landed (closing speed and how square) and where. The
stage bumps the lens and throws turf in proportion, the page pulses the
phone harder for a square hit at speed and says who laid him out. A
drag-down barely registers, as it should.

**Instant replay.** The stage keeps a tape of the last play — thirty frames
a second of where every man was, how he stood and which way he leaned, and
the football; a picture, never a decision. A score from twenty out, any
takeaway, a fourth-down stand, a gain of thirty-five or the play that took
the lead late is shown again at half speed from a lower, tighter lens with
the broadcast's bars on it. A tap anywhere skips it. `Replays` is a setting.
`ST.recordFrame` / `ST.restoreFrame` are pure and tested: rewound, every man
is back in his stance; run to the end, every man is where the whistle found
him.

**The dead ball has a broadcast.** Every fourth ordinary play, one short fact
arrives on the dead ball and goes: the man having the day and his line, this
drive, third downs, total yards. A fourth-down stand and a thirty-yard play
get a graphic of their own. None of it waits on the football.

**Proof.** `live.test.js` grew from 58 to 79 assertions (the three footballs,
across the body, the tier, the tape, the hit, a hundred snaps with every
kind of throw); `flow.test.js` proves a pick crossing the goal line is booked
as a defensive touchdown with the try pending and a hundred previews line up
and never snap.
