# Football data coverage and research intelligence — what was broken and what changed

Written as a record, not as a release note: every claim below is a thing that
can be re-measured with `npm run cfb:coverage`, and every fix names the line it
replaced.

---

## The reported symptoms, and what each one actually was

| reported | verdict | actual cause |
|---|---|---|
| 77 games with unknown quarterback starters | **not unavailable upstream** | Every caller of the college engine passed `qb: null`. `app.html` said so in a comment: *"qb stays null on purpose: college football publishes no depth chart EdgeDesk trusts."* The premise is right and the conclusion does not follow — the play feed the repo already downloads names the player on every dropback. |
| featured newsletter games missing 60% of the input contract | **a hard-coded null, not a missing feed** | `football/fbs/build_coverage.js` assembled the engine request with roster, qb, injuries, news, coaching, schedule *and* weather set to `null`. The artifact reported `data_completeness: 0.0` on all 75 games while the board on screen was pricing the same games with four of those present. |
| market quotes one or two days old beside a refreshed model | **real, and undetectable from the file** | The committed snapshot carried `{point, book}` and one `captured_at`, with **no price, no market type, no model version and no freshness state**. Week 3's quotes were captured 2026-09-13; the editorial run that used them was 2026-09-15. Nothing on the page said so. |
| player and roster research absent from projection inputs | **a disconnected enrichment, not a missing dataset** | `football/players/teams/lsu.json` already carried a projected QB1 with an athlete id, a rating and a confidence. No caller read it. |
| missing venue coordinates blocking weather | **true for 2 of 76 games, not for the class** | 135 of 138 FBS venues carry coordinates. Missouri State and Sacramento State moved up to FBS after the parameter table was trained. The other 74 games had coordinates and no forecast because **the offline builder never made the request**. |
| conflicting prices across newsletter and terminal | **real, and structural** | Four surfaces each described a quote their own way and nothing distinguished a live capture from an edition's archive. |
| large model disagreements with too little football | **real** | The packet had a rating difference and a market number and nothing between them. |

Two further faults were found while tracing and are fixed here:

* **The editorial scorer let the size of a gap order research.**
  `clamp(points * 3.2, 0, 24)` made the raw disagreement the single largest
  component of `editorial_priority` — a twelve-point gap earned a permanent
  research trail whether the price was two days old or the model had half its
  inputs.
* **A rank was stated out of the wrong pool.** `rank_pool: 136` is a constant;
  the rankings build ranks only the teams its confidence gate clears — 68 of
  138 — so "Ole Miss #15 of 136" was a rank of 68 presented as a rank of 136.

---

## What changed

### 1. Retrieval

`football/data/recovery.js` is now the one door every football fetch goes
through: per-request timeouts, per-host rate limits, in-flight deduplication,
retries on transient failures only (a 403 or a 404 is an *answer*), a host
circuit breaker, a cache with the pipeline's own freshness rule, a stale-cache
fallback that comes back **labelled stale**, ordered provider fallback that
records which provider answered, and a run budget in milliseconds and requests.

The availability sync used to report "276 failed source reads" — 138 teams ×
2 collectors against the same two dead ESPN endpoints, each paid for with a
round trip. The report now groups a repeated refusal as **systematic** and the
breaker stops it after three.

### 2. Starter context — `football/starters/`

Six states, kept apart and never collapsed: `ANNOUNCED`, `EXPECTED`,
`DEPTH_CHART`, `PREVIOUS_GAME`, `COMPETITION`, `UNKNOWN`. Availability is a
second axis. Every record carries player id, team, season, source, source URL,
publication time, retrieval time and status. `confirmed` is true for
`ANNOUNCED` and nothing else.

Identity is resolved with three guards that each caught something real:
a transfer's old team (Alabama's week-2 opener resolved to a player the 2026
roster has at Kentucky — refused), a duplicate name (resolves to nobody), and
an id no roster file carries (resolves, marked uncorroborated, because dropping
it lost real starters).

See `football/starters/README.md`.

### 3. Model input assembly — `football/matchup/inputs.js`

One definition of what the engine is given, shared by every caller, returning
**two** requests: the `baseline` the published number is priced from, and an
`enriched` one carrying the starter whose output is published under `shadow_`
names and priced nowhere. `PRICED_STARTER_STATUSES` is empty and is the single
switch; `engineQbInput()` refuses anything not on it and returns the reason.

And a contract report in seven states — `USABLE`, `RESEARCH_ONLY`, `STALE`,
`CONFLICTING`, `NOT_APPLICABLE`, `FETCH_FAILED`, `UNAVAILABLE` — with
`NOT_APPLICABLE` **excluded from the denominator**.

### 4. The football — `football/matchup/profiles.js`

Scoring, pace, explosives, pressure, turnovers, third down, red zone and field
position, per team, computed twice (all plays, and with garbage time removed
under a published rule), each rate carrying its own `n`, each pairing matched
offence-against-*allowed* rather than offence-against-offence.

Every gated column is declared rather than scored: in 2026 passes defended
(MISSING, 0.00 per team-game against ~3.0), forced fumbles (MISSING),
touchdowns and sacks-made (DEGRADED). A per-team version of the same gate
caught 47 teams with no `sack_taken` row at all in a column that fills at 83%
league-wide — publishing "0 sacks allowed" for those would have been a
manufactured strength.

### 5. The packet — `football/matchup/packet.js`

One structured, sourced object read by the AI (`_intelligence.js`
`matchupResearch`), the game page and the newsletter (through the terminal's
own payload). It carries the model's full arithmetic (base rating → every
adjustment → the published spread, with a running total and a reconciliation
against the printed number), the ratings-vs-projection reconciliation, the
market through the shared snapshot contract, the starter context, availability,
the football, and the disagreement diagnostics.

Two refusals are enforced:

* **No place difference across two boards.** "QB room #21 against a secondary
  #53" is two positions on two ladders; `place_difference` is `null` with the
  reason, and each side's percentile *inside its own board* is published.
* **No priority from the size of a gap.** `disagreement()` answers the six
  questions and scores priority from the *evidence around* the gap — a current
  price, a filled contract, two resolved starters. A gap with none of those
  earns zero. A gap past anything the model has been right by out of sample is
  capped and labelled a fault to investigate.

### 6. Freshness and cross-page consistency — `tools/lib/snapshot_contract.js`

One definition of a quote: `game_id, sport, model_version, model_generated_at,
input_cutoff, book, market_type, selection, side, line, odds_american,
odds_decimal, captured_at, observed_age_s, freshness, snapshot_kind,
retrieved_at`. Freshness is derived from the capture time and the kickoff,
never from the model's timestamp. `snapshot_kind` distinguishes `LIVE`,
`EDITION` and `ARCHIVE`, and an archived price can never be presented as the
market. `movement()` returns a number only for the same book, market and
selection at two different capture times, and names which condition failed
otherwise.

The newsletter's capture read gained two columns that were always in the
database and never asked for — `best_dec` and `best_quote_age_s` — so a
committed snapshot now carries a real price instead of a handicap with none.

---

## Before and after, on the same slate

`npm run cfb:coverage`, 2026 week 3, 76 games:

```
                                      BEFORE     AFTER
  games projected                         76        76
  engine data completeness (mean)          0%     53.7%
  games at zero completeness              76         0
  games with an unknown starting QB       76         2   (home side)
  input coverage, applicable fields       n/a     62.2%
  of which priced                         n/a     48.9%

  starter status across both sides of every game
    PREVIOUS_GAME  138      COMPETITION  13      UNKNOWN  1

  by matchup tier          before   after   home starters
    p4 involved   39 games      0%     60%      37
    other FBS     19 games      0%   58.4%      19
    FBS vs FCS    18 games      0%     35%      18
```

The AFTER definitions are **stricter**, not looser: a field counts as known
only when it was actually retrieved, research-only fields are counted
separately from priced ones, and `NOT_APPLICABLE` fields are removed from the
denominator rather than counted as covered.

---

## What is still empty, and why

| gap | games | cause | class |
|---|---|---|---|
| quarterback availability | 151 sides | the college availability layer holds 5 records across 138 programmes; its two ESPN collectors are refused (403/404) | **fetch failed, systematic** — and a registry entry, not a code change, is the path in |
| recruiting talent | 76 | subscription data; no keyless feed carries it | **genuinely unavailable** — `football/players/recruiting_adapter.js` is the wired injection point |
| coaching continuity | 76 | no public keyless feed carries it | **genuinely unavailable** |
| weather | 74 | the forecast request is made and this environment's egress policy refuses `api.open-meteo.com` (403). The same call succeeds from the browser today. | **fetch failed, environment-specific** |
| venue coordinates | 2 home, 7 FCS away | Missouri State and Sacramento State moved up to FBS after the parameter table was trained; the table covers the FBS field only | **genuinely unavailable until retrained** — `football/venues/supplement.json` is the injection point and refuses an entry without real coordinates and a named source |
| announced starters | all | college football has no league-wide filing and `football/availability/sources.json` carries zero official URLs | **reachable and presently empty**, stated rather than implied |
| market freshness | 46 of 46 week-3 quotes STALE | the committed snapshot is a replay; refreshing it needs the service credential the newsletter job holds | **stale, and now labelled** |

---

## What deliberately did **not** change

No published model number moved because a new input was wired in. The starter
context reaches the engine only through the shadow request, and the shadow's
own effect is published on every game:

> The resolved starter moved the engine's QB stability term off its "unknown
> starter" floor and moved nothing the engine prices. Two reasons, both
> structural and both documented: no feed this repository reads carries EPA per
> dropback for college football, so the QB layer's VALUE term has no input and
> contributes no points; and the trained volatility model kept exactly one
> driver (`early_season`), so `qb_uncertainty` carries no coefficient at all
> and cannot widen or narrow the distribution either.

The published card's numbers **did** change, because the offline builder now
sends the same request the terminal sends. That is the artifact catching up
with the board, not the model changing.

---

## Running it

```
npm run cfb:starters      # starter context, college + NFL
npm run cfb:profiles      # team-game profiles
npm run cfb:research      # both, then rebuild the published card
npm run cfb:coverage      # before/after on the same slate
npm run cfb:research:test # the regression suites
node tools/football/verify_games.js     # four real games, end to end
```

Scheduled: `.github/workflows/starter-context.yml`.
