# Five Games to Watch

Stadium Rant's editor asked for weekly articles built around about five key matchups. For each game they want the evidence: the games worth watching, the football that decides them, realistic upsets, the quarterback and position-group matchups, recent form, injuries, kickoff times, the broadcast network and legitimate streaming. "Where to watch" performs well.

This template does that inside the existing content engine. There is no second generator and no second database. One verified **matchup packet** per game feeds two articles:

- the publisher's edition, approved by the owner and sent only when the owner presses Send;
- EdgeDesk's own edition on edgedesksports.com.

It writes football journalism, not a list of predictions: every game is in the article because the research can say why.

Examples, built from the October 10, 2026 games as a historical fixture (never published):

- [`examples/games_to_watch_2026_w6_publisher_edition.md`](examples/games_to_watch_2026_w6_publisher_edition.md)
- [`examples/games_to_watch_2026_w6_edgedesk_edition.md`](examples/games_to_watch_2026_w6_edgedesk_edition.md)
- [`examples/games_to_watch_2026_w6_review.json`](examples/games_to_watch_2026_w6_review.json) — the review report and the informativeness comparison.

## How it fits together

| Layer | File | What it does |
|---|---|---|
| Broadcast listings | `football/broadcasts/collect.js` → `football/broadcasts/current.json` | Reads the week's listings from ESPN's public, keyless scoreboard once an hour (in the CFB lab workflow). It records national and regional TV and streaming outlets, the time (and whether it is TBA), the status and the venue. A failed fetch keeps the last listing with its real retrieval time. A change in network, time or status is appended to `changes`. |
| Broadcast verification | `lib/edgedesk_broadcast.js` (`EDBroadcast`) | Decides what a listing is worth (tiers and statuses below), applies the owner's verification, formats ET and CT from the UTC instant with each zone's own daylight-saving rules, and says whether a record may be printed *now*. |
| Matchup packets | `lib/edgedesk_matchup.js` (`EDMatchup`), built by `tools/content/build_packets.js` → `football/content/packets.json` | One packet per game of the current week, from committed artifacts only (sources below). |
| Template | `lib/content_engine.js` | Adds the `games_to_watch` opportunity kind and two formats: `weekly_games_to_watch` (publisher edition) and `weekly_games_to_watch_first_party` (EdgeDesk edition). Also the selection, both writers, the checks, the review report, the AI request and targeted regeneration. |
| Database | `supabase/content_engine.sql` | Owner broadcast checks, the auto-reject door, the publisher's response, the template report. All additive. |
| Owner page | `/admin/content/` → Article generator → Template | Template picker, configuration, the packet and evidence preview, broadcast verification, draft creation. Performance → By template shows the metrics. |
| First-party page | `tools/content/first_party.js` | The EdgeDesk edition as an `article_type: games_to_watch` record in the one article store, published by the one publisher (`tools/editorial/publisher.js`) and rendered by the one renderer. |

### What a packet is built from (nothing is fetched)

| Artifact | What the packet takes from it |
|---|---|
| `football/matchup/packet.js` (reads `football/fbs/slate.json` and `football/matchup/profiles_2026.json`) | Measured pairings: each offense against the defense it meets, garbage time excluded, with sample sizes. Also position-group standings. |
| `football/cfb_terminal/games.json` | The champion projection, the market check, the integrity verdict, the model's inputs, its sensitivity, the other models, research reliability, quarterback usage. |
| `football/personnel/current.json` and `football/availability/reports.bundle.json` | The conference's official availability report, player by player, with its URL and publication time. |
| `football/cfb_terminal/record.json` and `collective/settled/CFB_2026.json` | Verified final scores. The profile's "running score at the last attributed play" is never used as a final. |
| `football/fbs_epa/qb_epa_2026.json` | Each quarterback's game log, before kickoff only, and every team's schedule. |
| `football/rankings/current.json` | EdgeDesk ranks, as context only. |

## The packet

Every **fact** carries its numbers and its source. Each fact is one of two kinds.

**INDEPENDENT** — a count a reader could check:

- a final score or a record from verified finals;
- a unit rate with its sample, such as "Oklahoma has allowed a 48.7% completion rate (89 dropbacks)";
- a passer's season line or interception rate;
- a measured dropback split;
- the official availability report.

**ANALYSIS** — EdgeDesk's or a provider's model:

- projections, ratings and opponent ranks;
- expected points added (EPA);
- opponent-adjusted matchup cards.

Analysis never counts toward the two facts a game needs.

Each fact has two phrasings: `text` for the publisher edition and `alt` for EdgeDesk's. The two articles share numbers, not sentences.

### The six arguments

1. **Why watch.** Ranks, conference play, unbeaten teams, a strength-on-strength clash, a quarterback split or a neutral site. A close projection is noted but never enough on its own.
2. **The deciding matchup.** A **mismatch** must be one unit's real strength (at least 0.5 SD better than the FBS average), not just the other side's weakness. A **clash** needs both units at least 0.75 SD above average. It rests on two measured counts.
3. **Recent evidence.** The independent facts that support 1 and 2.
4. **The projection.** The fair line and win chance, and the inputs that move the number most. A market gap is shown only against a current, unfaulted quote. A gap of 7 or more points that has not cleared the integrity gate is UNRESOLVED and is called a data question.
5. **Why the model could be wrong.** The sensitivity range, the other models' range, opponent-adjusted data that disagrees, absences the projection does not price, a quarterback split, and the typical miss.
6. **What to watch.** One or two concrete, checkable things, each with the season numbers.

**Upset potential** is written only on the evidence:

- The underdog needs at least a 25% chance and a measured unit strength with an edge in this matchup.
- An absence or a turnover rate can add to a case but never makes one.
- A game the model calls close to even (55% or less) is said to have no upset either way.
- Otherwise the article says why there is no case.

### The reasoning gate (`EDMatchup.gate`)

A game is featured only when its packet answers all six questions **and** at least two independent, matchup-relevant facts support it. Otherwise it is replaced; a game the owner *required* is held for manual review with its missing evidence.

| Gate code | What is missing |
|---|---|
| `NO_REASON_TO_WATCH` | why watch |
| `NO_DECIDING_MATCHUP` | the deciding matchup |
| `TOO_FEW_FACTS`, `DECIDING_UNSUPPORTED` | the evidence |
| `NO_PROJECTION` | the projection |
| `NO_COUNTERARGUMENT` | why the model could be wrong |
| `NOTHING_TO_WATCH` | what to watch |

### Data truth found while building it

**The sack columns are quarantined.** Across the league the offensive and defensive views of the same plays add to the same 2,088 sacks on 36,772 dropbacks. Per team, though, they disagree:

- the team mean of sacks taken is 13.9%, against 5.4% for sacks made;
- Vanderbilt's "offense" carries 12 sacks *made* and 8 interceptions *taken*.

The feed credits sack and interception plays to the wrong side. A rate whose two views differ by more than 25% (`EDMatchup.CONSISTENCY_MAX`) is printed nowhere and argued from never, and every packet says so in its limits.

**Interceptions are taken per passer** from the player logs, which agree with the box scores. Team turnover columns are not used, and fumbles are gated MISSING league-wide, so no turnover margin is ever stated.

The research terminal's own pass-protection pairing still reads the quarantined column. That is listed under Unresolved below.

## Broadcasts

| Tier | Meaning | Status |
|---|---|---|
| OWNER_VERIFIED | The owner recorded it from an official source (conference, school, network or league page) with the URL, in `/admin/content/`. | CONFIRMED |
| OFFICIAL_NETWORK | ESPN's scoreboard listing a network ESPN operates: ABC, ESPN, ESPN2, ESPNU, ESPNEWS, SEC Network, ACC Network or ESPN+. | CONFIRMED |
| LISTED | ESPN's scoreboard naming any other network (CBS, FOX, NBC, Big Ten Network, The CW…). | TENTATIVE — held |
| NONE | No listing. | UNVERIFIED — held |

- **CONFLICT** (held): the owner's network differs from the listing, or the listing's time differs from the schedule's by more than 5 minutes.
- **CHANGED** (held): the listing changed after the owner verified it (flex scheduling).
- **STALE** (held): the verification is older than 24 hours, or 12 hours inside 72 hours of kickoff.
- **POSTPONED / CANCELED**: the game is withdrawn.

**Streaming** is printed only when the source listed it for the game, or as the verified network's *own* service, described as exactly that:

- the ESPN app, "with a participating TV provider or an ESPN subscription";
- Paramount+ for CBS;
- Peacock for NBC.

FOX is deliberately absent; the owner reviews `EDBroadcast.STREAMING` each season.

**Revalidation.** Every read re-verifies: the admin preview, the job, `readiness()` before sending, and first-party publication. A Tuesday confirmation is held on Friday until it is checked again.

**A verified weather or schedule move** is the owner's verification with the new kickoff, the reason and the official URL. The article prints the change and the new ET/CT times. A listing that moves the time *without* a verification is a CONFLICT and holds the game.

### Verifying a broadcast (owner)

1. In `/admin/content/` → Article generator → Template, choose **Five Games to Watch** and press **Preview matchups and evidence**.
2. Open the game's **Verify the broadcast from an official source**.
3. Enter the network, the official page's URL (`https://`), the source and its name. Add a new kickoff and its reason only if the game moved, or set Postponed or Canceled.
4. Press **Record verification**, then **Preview** again. The game reads `broadcast CONFIRMED` with `OWNER_VERIFIED`.

## Selection (`EDMatchup.select`)

Selection is never by the largest gap. Each game is scored on:

| Factor | Weight |
|---|---|
| Audience interest | 0.22 |
| Football significance | 0.16 |
| Evidence quality | 0.16 |
| Matchup advantage | 0.14 |
| Reliability | 0.10 |
| Upset potential | 0.08 |
| Publisher fit | 0.06 |
| Timeliness | 0.05 |
| Market | 0.03 |

The market part counts only when the gap is COMPARABLE, and it is capped at 30. A stale or faulted market therefore adds nothing, and a 25-point gap moves a game's score by under one point.

The set keeps one storyline per game where it can, and up to two under-the-radar games when there is room. Count and required games are configurable; the default count is the publisher's `featured_games`, else 5.

## The two editions

**Publisher edition (`weekly_games_to_watch`)**

- **Opening:** the intro, then *The schedule at a glance* (ET/CT and verified TV for every game).
- **Each game, in six parts:**
  - **Where to watch:** when (ET and CT), where, TV, streaming, and the verification source and time.
  - **Why it matters.**
  - **The key matchup:** the deciding matchup's counts, the quarterbacks and the availability report.
  - **EdgeDesk's projection:** the line, the biggest input, the market (or why none is stated), reliability, and why it could be wrong.
  - **Upset potential.**
  - **What to watch.**
- **Closing:** how to read the numbers, what they can't see, and the bottom line.
- **Voice:** general audience.
- **Workflow:** always manual approval; sent only when the owner presses Send. Nothing is sent to Stadium Rant automatically.

**EdgeDesk edition (`weekly_games_to_watch_first_party`)**

- **Different labels:** Kickoff and broadcast, The stakes, Where it's decided, EdgeDesk's number, the upset case or why there is none, Watch for.
- **Different order and phrasing.**
- **More detail:** EPA, labelled as analysis, and the second matchup.
- **Navigation:** a research link for every game, the research navigation list, and the free signup (the weekly email — EdgeDesk has no free account tier) plus the trial.
- **No UTM tags** on its own links.
- **Duplicate check:** it must be under 45% similar to the publisher edition (the October 10 example is 24%).

### Automatic publication (EdgeDesk edition only)

`node tools/content/run.js first-party` runs hourly in the CFB lab workflow. It publishes through the one article store only when **all** of these hold:

- the content engine's checks pass;
- the editorial review is READY;
- every broadcast is fresh at that moment;
- the research is live, never the fixture;
- the publisher's preflight and quality gate pass;
- **`football/content/config.json` → `first_party_auto_publish` is `true`.**

**It is `false`.** Switch it on, by a reviewed commit, only after the edition has been checked in production.

## Checks (`validate`, `EDIT.*`), and the review report

Every existing check still applies: numbers in evidence, numbers per game, spreads, kickoffs, conference, quarterback uncertainty and betting language. The template adds these:

| Check | Rule | Verdict if it fails |
|---|---|---|
| `reasoning_gate` | Every featured game answers the six questions. | REJECT |
| `six_parts` | Every game section has the six labelled parts. | REJECT |
| `facts_per_game` | At least two independent, matchup-relevant facts written into each section. | REJECT |
| `where_to_watch` | Every network and streaming service named is the verified one, in the sections and in the schedule table. | REJECT |
| `broadcast_verified` | Every broadcast is CONFIRMED and fresh now. | HOLD |
| `kickoff_times` | The verified kickoff in ET and CT, and no other clock time. | HOLD |
| `duplicate_matchup` | Each game appears once. | REJECT |
| `generic_filler`, `repeated_sentences` | No filler phrases, and no number-free boilerplate repeated from game to game. | REJECT |
| `upset_supported` | An upset case only where the packet makes one, citing its evidence. | REJECT |
| `injury_claims` | Every injury status is on the official report. | REJECT |
| `publisher_attribution` / `first_party_links` | EdgeDesk credited; the EdgeDesk edition links each game's research and the free signup. | REJECT |
| `not_fixture` | An article built from a test fixture can never be published. | REJECT |

`CE.gamesToWatch.review()` gives **READY**, **HOLD** (verify a broadcast or kickoff and check again) or **REJECT**. The weekly job:

- rejects its own REJECT draft automatically, with the reasons (`content_engine_article_auto_reject` accepts only a draft whose stored review says REJECT);
- keeps a HOLD as a draft with the hold logged;
- queues a READY draft for the owner's review.

## Cost

- **The deterministic writer** drafts every article at **$0**.
- **The AI request** carries the packets' verified facts and the where-to-watch block, not the raw pairings, cards or listings.
  - A full request is about 70,000 characters (≈17,500 input tokens). The reservation is an upper bound of $0.95 at the configured model's list prices, with a measured cost near $0.20.
  - When the failures name one or two games, only those sections are rewritten: about 17,000 characters, `max_tokens` 4,000, a $0.24 reservation upper bound.
  - At most three calls per draft, each reserved against the **$10 monthly cap** and settled at its measured cost.
- **Broadcast listings:** ESPN's public scoreboard; no key, no subscription, about three requests an hour.
- **No new paid service.**

## Metrics (`content_engine_template_report`)

Per template:

- articles generated, approved, and first-pass approval (approved on the first revision with no owner edit);
- auto-rejected;
- publisher responses and acceptance, recorded by the owner with `content_engine_publisher_response` and kept apart from publication;
- external placements;
- traffic sessions, research-page visits, registrations, trials and paid subscribers. These are first-party counts, owners excluded: by campaign code for publisher editions, and by landing path for EdgeDesk pages;
- generation cost: the AI ledger's estimate (`content_engine.ai_calls`) for the calls reserved for the article, or named on its `article_created` event when they were made while drafting it;
- attributed revenue (Stripe-paid invoices of attributed accounts, gross).

A null is "not measured", never zero. No ranking, forecast or projected revenue is reported.

## Database changes (`supabase/content_engine.sql`; re-paste, idempotent, additive)

- **Constraints:** two formats and one kind added to the one format and kind list (section 1).
- **Transitions:** `draft → rejected` added to `can_transition` (and the library's `TRANSITIONS`), used only by the auto-reject door.
- **`content_engine.broadcast_checks`:** append-only, RLS on, no client grants. Doors: `content_engine_broadcast_verify` (owner) and `content_engine_broadcast_checks_current` (owner and job).
- **Publisher response:** `articles.publisher_response`, `publisher_responded_at` and `publisher_response_note`, with the owner door `content_engine_publisher_response`.
- **New doors:** `content_engine_article_auto_reject` (job and owner) and `content_engine_template_report` (owner). Helpers: `content_engine.page_metrics` and `content_engine.attributed_revenue`.
- **Report:** the file's report gains a row; the append-only tables are revisions, deliveries, performance, events, benchmarks, costs and broadcast_checks (7).

**Rollout:**

1. Re-paste `supabase/content_engine.sql` after the merge. Nothing is dropped.
2. Redeploy the `content_engine` Edge Function; it carries the two new libraries verbatim.
3. The CFB lab workflow starts writing `football/broadcasts/current.json` and `football/content/packets.json` on its next hourly run.

**Not applied to production from here.**

## Tests

`node tools/content/games_to_watch.test.js` (`npm run content:gtw`; in CI, 135 checks) runs on the frozen October 10 fixture (`tools/content/fixtures/`):

- **The evidence for all five games:**
  - Vanderbilt's measured quarterback split (Jared Curtis 57%, Blaze Berlowitz 38%), neither on the SEC report;
  - Missouri's run defense, 3.4 yards a carry allowed, against Texas A&M's 4.6;
  - Oklahoma's pass defense (48.7%) and John Mateer's four interceptions in 110 attempts;
  - UCLA's 7.5 yards a carry, and Oregon's Raiola/Moore split with neither on the Big Ten report;
  - Keelon Russell's season line, plus a verified weather move and an unverified one.
- **The data truth:** the sack quarantine and verified finals.
- **Every broadcast state.**
- **Selection,** including the market cap and a held required game.
- **Both editions passing.**
- **Every block,** each verified to fire.
- **The informativeness comparison:** 72 independent facts across five games (at least 13 per game, 7 kinds) against 12 in the old projection-only preview.
- **AI request size** and targeted regeneration.
- **First-party publication,** and the database doors and weekly job on PostgreSQL.

`content:e2e` covers the owner flow in Chromium: the template picker, the evidence preview, a CBS hold, an owner verification applied, and a READY draft.

## Unresolved

- **The production listings have not been read from here.** The session's network policy refuses `site.api.espn.com`, so the collector's first real run is the CFB lab workflow's. The parser is tested on ESPN's documented field shapes, not a captured payload.
- **The research terminal's pass-protection pairing** (`football/matchup/packet.js`) still reads the sack columns the packets quarantine.
- **No streaming entry for FOX** until the owner confirms its current live-streaming service.
- **The EdgeDesk edition is not yet live:** `first_party_auto_publish` is off by design.
