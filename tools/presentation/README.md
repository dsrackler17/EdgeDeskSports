# EdgeDesk presentation layer — deep engine, simple answer

Three layers over one deterministic engine:

| Layer | What | Where |
|---|---|---|
| 1 · 5-second view | verdict · selection · price · good-to · why · watch | Top edges strip, every receipt, AI panel answers, daily research headline |
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

## Tests

    node tools/presentation/presentation_sync.test.js
    node tools/presentation/presentation.test.js
    node tools/presentation/edgedesk_ai.test.js      # the deployed function, under Node
    node tools/presentation/app_presentation.test.js
    node tools/presentation/app_picture.test.js       # full picture: players, markets, books

## Deploy / migrate

1. Paste `supabase/functions/edgedesk_ai/index.ts` into the `edgedesk_ai`
   function in the Supabase dashboard and deploy. `GET ?probe=1` should show
   `build: edgedesk_ai-2026-09-02-r4-presentation` and `presentation.library_loaded: true`.
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
