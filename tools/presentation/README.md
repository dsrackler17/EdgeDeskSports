# EdgeDesk presentation layer — deep engine, simple answer

Three layers over one deterministic engine:

| Layer | What | Where |
|---|---|---|
| 1 · 5-second view | call · the bet in football words · the price · the price limit · what EdgeDesk found · why · what would end it | Top edges strip, every receipt, AI panel answers, daily research headline |
| 2 · Full research | everything that already existed | behind **Full research** on the receipt; DEEP mode in the AI panel |
| 3 · Publisher brief | one-page, shareable snapshot | **Create brief** on any card, **Game brief** on football cards, presets on the Edges view and the Football overview |
| · Full picture | key players per team with the stat line as the reason · every priced market on the game · every book on the line | **Full picture** on the Top-edges strip and every receipt card (`EDPIC`, `app.html`) |

## Ownership

`supabase/functions/edgedesk_ai/_presentation.js` is the canonical library. It is
inlined byte-for-byte into `index.ts`, `app.html`, `brief.html` and `record.html` between
`/*__EDPRES_START__*/ … /*__EDPRES_END__*/`. Edit the canonical file, then:

    node tools/presentation/inline.js        # sync the four hosts
    node tools/presentation/inline.js --check

The library never computes a probability, edge, price limit or verdict. It
translates the engine's fields (`EDAI.evidence` → `EDAI.packetOf`) and it
validates AI copy before a word of it reaches a card.

## The public language layer

Layer 1 and Layer 2 are written for a football fan who has never placed a bet.
That is a different job from translating jargon into slightly milder jargon, so
the layer is built from FACTS rather than from string replacement:

| Piece | What it does |
|---|---|
| `CONCEPTS` / `concept(k)` | every analytical idea once: `internal_name`, `short`, `simple`, `detail`, `guard`. Used by the card's explainers and by the brief's "How to read this brief". |
| `betLine()` / `pushNote()` / `ticketLine()` | the bet as football — "Pittsburgh to win by 5 points or more" — plus the tie-refund rule, plus the exact line to look for at the sportsbook. |
| `priceCompare()` | two prices side by side and one sentence about the direction. Correct on both sides of the +100/−100 boundary; says "no comparison price on file" rather than guessing. |
| `longShotGuard()` | deterministic, from the price alone. A moneyline at +250 or longer says the team is an underdog and that EdgeDesk is judging the price, not predicting an upset. A favourite at −250 or shorter says what the bet costs. |
| `verdictPlain()` | BET / LEAN / WAIT / PASS / DATA CHECK FAILED, each with a one-line gloss and a one-line answer. |
| `priceLimitPlain()` | "Price limit · −118 or better", the sentence for what happens past it, and which direction "better" runs. |
| `marketCheckPlain()` | `has_sharp` and `n_books` said as what they actually are. Never as agreement, never as endorsement. |
| `reasonKind()` / `publicReason()` | classifies an engine reason string, then writes the sentence from the packet's own numbers. An unrecognised reason still falls through `plainReason()`, so a new engine reason degrades instead of disappearing. |
| `PUBLIC_TERMS` / `publicText()` | the last-resort dictionary. `TERMS` translates internal → bettor for Full Research; `PUBLIC_TERMS` takes it one more step for public copy. |
| `JARGON` | the AI gate. Copy carrying `de-vig`, `CLV`, `EV`, `Pinnacle`, `sharper market`, `fair line`, `max playable`, `liquidity`… is rejected exactly like hype, and the deterministic sentence stands. |

The result rides on `simple.plain` and on `publisher.plain`, additively — every
field that existed before is untouched, `simple.engine` still carries the
engine's numbers verbatim, and **Full Research keeps its precise terminology on
purpose**. A brief published before this layer existed has no `plain` block, and
every renderer falls back to the field it used to render.

Two things this layer refuses to do, because the engine does not own them:

- It never states a fair SPREAD or a fair TOTAL. EdgeDesk owns a fair PRICE on
  the line the book is offering, not a line of its own, so a spread card
  compares PRICES on that spread and says so.
- It never turns a price into a chance of winning.

## Tests

    node tools/presentation/presentation_sync.test.js
    node tools/presentation/presentation.test.js
    node tools/presentation/public_language.test.js   # the five-second test
    node tools/presentation/edgedesk_ai.test.js      # the deployed .ts, under Node 22 type stripping
    node tools/presentation/app_presentation.test.js
    node tools/presentation/app_picture.test.js       # full picture: players, markets, books

## Deploy / migrate

1. Paste `supabase/functions/edgedesk_ai/index.ts` into the `edgedesk_ai`
   function in the Supabase dashboard and deploy. `GET ?probe=1` should show
   `build: edgedesk_ai-2026-09-03-r5-presentation` and `presentation.library_loaded: true`.
2. Run `supabase/publisher_briefs.sql` in the SQL editor (share links need it;
   copy/print work without it).
3. Publish `app.html`, `brief.html` and `record.html` together.
4. Run `supabase/brief_record.sql` so published briefs can grade against the
   close (see `tools/record/README.md`).

## Manual checks

- **TNF / SNF / MNF**: Edges → Publisher desk → the button. The game is
  resolved from priced NFL rows by ET weekday and a 7 pm+ ET kickoff, falling
  back to the Football schedule. No priced market → an honest WAIT brief.
- **College Football**: Publisher desk → College Football brief. Top decisions
  (max 3 BETs, never padded) or All actionable games. Zero BETs → NO QUALIFYING BETS
  with the strongest LEAN/WAIT/PASS research underneath.
- **Any game / edge**: Create brief on a card, or Game brief on a football card.
- **Writer actions**: Copy for CMS (rich HTML + plain text), Copy plain text,
  Print / Save PDF, Share brief (snapshot + `brief.html?s=<slug>`), Refresh
  from current data (a new version; the old link is unchanged), Polish copy
  (PUBLISHER mode through edgedesk_ai, validated).

## Full picture (players to market price)

`EDPIC` (between `/*__EDPIC_START__*/ … /*__EDPIC_END__*/` in `app.html`) fills
the `<domid>_pic` host under a receipt on demand:

- **Spotlight** per team, one or two players, chosen by team impact:
  1. share of the team's total offense, from the stored leader values over
     the school's season totals (`cfb.team_season_stats`, College Football),
     with the arithmetic shown ("Accounts for 56% of Ohio's total offense
     (2,213 of 3,980 yards) · 1,801 passing (78% of the team) …");
  2. else the category leaders in priority order (the stat sheet), saying
     that no share is computed;
  3. else, with no stat line on file, the roster-construction read the
     Football tab already uses (position value × class × portal status),
     labelled as not a performance read.
  The rundown carries the stat line, the stored category breakdown, class,
  jersey and transfer origin from the roster file, and any `model_props`
  projection (labelled MODEL).
- **Also on the sheet**: the remaining stat leaders, the NFL starter or QB
  room from the schedule and roster feeds, the CFB QB room from
  `football/rosters/fbs_<season>_espn.json` (joined on the mascot-suffixed
  board name), the MLB probable pitcher. A team the tables cannot match, an
  empty table or an unreachable one is said in words. Nothing is filled in.
- **Every priced market on the game**: both sides of every market from the
  captured signal rows — best book and price, fair line and anchor, edge,
  the engine's verdict and good-to, open → now, books quoting.
- **Every book on the line**: `book_quotes` for the selection, best in green,
  sharp starred, each with its own de-vigged fair.

## Availability

One availability path serves every football surface: `EDCARD.availabilityFor(x)`
builds the facts, `simpleFromPacket` carries them on the card, and the brief,
the Full picture, the watchlist chip and the AI packet all read the same object.

- **NFL** — the league's official report, from `football/injuries/nfl_<season>.json`
  (see `.github/workflows/injury-sync.yml`).
- **College football** — EdgeDesk's own availability layer, from
  `football/availability/current.json`. See `football/availability/README.md`
  for the sources, the rules and how to add a school.

The library never decides a status, a confidence or an impact: those arrive with
the record. It decides only how to say them, and it keeps "no reported
injuries", "partial coverage" and "no verified data" as three different
sentences.
